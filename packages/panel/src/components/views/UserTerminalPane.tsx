import { useEffect, useRef, useState } from "react";
import { CardFrame } from "~/components/ui/CardFrame";
import { Btn } from "~/components/ui/Btn";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Icon } from "~/components/ui/Icon";
import { getCorePtyBridge } from "~/lib/panel-bridge";
import {
  attachTerminalKeyHandler,
  wireTerminalFileDrop,
} from "~/lib/terminal-pane-helpers";
import {
  applyTerminalFontSize,
  createTerminalOptions,
  createTerminalTheme,
  fitTerminalSurface,
  getTerminalColorScheme,
  watchTerminalColorScheme,
} from "~/lib/terminal-options";
import { useTerminalZoom, useTerminalPaneZoomShortcuts } from "~/lib/use-terminal-zoom";
import { TerminalZoomControls } from "~/components/views/TerminalZoomControls";
import { prefetchTerminalModules } from "~/lib/prefetch-terminal-modules";
import { createTerminalGpuLease } from "~/lib/terminal-webgl";
import {
  terminalSurfaceCache,
  type PaneTerminalSurface,
} from "~/lib/terminal-surface-cache";
import { attachTerminalLinks } from "~/lib/terminal-links";
import {
  createSettledFit,
  createSettledPtyResize,
  resizePtyToTerminal,
} from "~/lib/terminal-resize";
import {
  dataAfterReplay,
  sequencedPtyData,
  type PtyReplaySnapshot,
  type SequencedPtyData,
} from "~/lib/terminal-replay";
import { getPtyStreamRouter } from "~/lib/pty-stream-router";
import { errMsg } from "~/shared/err-msg";
import { useFocusWithin } from "~/lib/use-focus-within";
import { CLEAR_USER_TERMINAL_EVENT } from "~/lib/design-meta";
import type { UserTerminal } from "~/db/schema";
import { normalizePtySize } from "~/shared/pty-size";

// Pattern for the launch-URL detector (port capture group for dev-server URLs).
const LOOPBACK_URL_BASE = String.raw`\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])`;
const LOOPBACK_URL_TAIL = String.raw`(?:\/[^\s'"<>)\]]*)?`;
const LOOPBACK_URL_WITH_PORT_GROUP_REGEX = new RegExp(
  `${LOOPBACK_URL_BASE}(?::(\\d+))?${LOOPBACK_URL_TAIL}`,
  "g",
);
const ANSI_ESCAPE_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function UserTerminalPane({
  terminal,
  ptyId,
  cwd,
  coreId,
  isHome = false,
  shellSession = false,
  focused,
  onFocus,
  onPtyReady,
  onPtyExit,
  onLaunchUrlDetected,
  onHide,
  onDelete,
  onRename,
  isLast: _isLast,
}: {
  terminal: UserTerminal;
  ptyId: string | null;
  cwd: string;
  /**
   * The Core this shell runs on. Its PTY rides that Core's leg of the panel
   * link; without one there is nowhere to spawn.
   */
  coreId?: string;
  /**
   * Project-less "home" (dashboard) terminal. Opens at the host/remote home dir
   * (resolved by the spawn handler via the `home` flag), so it skips the
   * project-clone path and the project-cwd transforms.
   */
  isHome?: boolean;
  /**
   * A VM Shell Session (issue 06) — a free-form interactive shell on the
   * Core's machine with no project folder. Spawned with `shellSession:
   * true` (the Core skips project-root validation and starts a login shell
   * at its own home), rendered with a distinct "VM shell" surface. Gated by
   * core-link auth, never auto-spawned. Mutually exclusive with `isHome`.
   */
  shellSession?: boolean;
  focused: boolean;
  onFocus: () => void;
  onPtyReady: (ptyId: string) => void;
  onPtyExit: () => void;
  onLaunchUrlDetected?: (url: string) => void;
  onHide: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
  isLast: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const termRef = useRef<{
    focus: () => void;
    clear: () => void;
    setFontSize: (fontSize: number) => void;
  } | null>(null);
  const {
    level: zoomLevel,
    fontSize: terminalFontSize,
    zoomIn,
    zoomOut,
    resetZoom,
    canZoomIn,
    canZoomOut,
  } = useTerminalZoom(terminal.id);
  useTerminalPaneZoomShortcuts(cardRef, zoomIn, zoomOut, resetZoom);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draftName, setDraftName] = useState(terminal.name);
  const [liveStatus, setLiveStatus] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const domFocused = useFocusWithin(cardRef);
  // Latest `focused` value, read inside the async surface-build effect (which
  // can't depend on `focused` without tearing down the terminal on every focus
  // change). Terminals opened without focus — e.g. the run/launch flow — must
  // not grab DOM focus when their surface is first built.
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  useEffect(() => setDraftName(terminal.name), [terminal.name]);

  useEffect(() => {
    termRef.current?.setFontSize(terminalFontSize);
  }, [terminalFontSize]);

  useEffect(() => {
    const onClear = () => {
      const root = cardRef.current;
      if (!root?.contains(document.activeElement)) return;
      termRef.current?.clear();
    };
    window.addEventListener(CLEAR_USER_TERMINAL_EVENT, onClear);
    return () => window.removeEventListener(CLEAR_USER_TERMINAL_EVENT, onClear);
  }, []);

  useEffect(() => {
    const cache = terminalSurfaceCache;
    const surfaceId = terminal.id;
    // A change to the spawn inputs — the Core the shell runs on, which kind of
    // shell it is, its cwd — or to the retry nonce means "build a fresh
    // terminal"; a plain remount (scope switch, navigation, un-hide) keeps the
    // same buildKey and reattaches the existing surface instantly.
    //
    // Core and kind belong in that key (issue 394). They pick which spawn this
    // pane makes and which machine it makes it on, so leaving them out let a
    // pane that first rendered with no Core — or before a restored session's
    // kind was known — keep the shell that first render started: the wrong one.
    //
    // The separator is U+0001, written as an escape so the source stays plain
    // text: a cwd may contain spaces, so a space would leave the key injective
    // only by luck of the other fields' shapes, while a control character
    // cannot occur in any of them.
    const kind = shellSession ? "vm-shell" : isHome ? "home" : "project";
    const buildKey = [coreId ?? "", kind, cwd, retryNonce].join("\u0001");
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let detachMount: (() => void) | undefined;

    // Bind THIS mount to a (new or reattached) surface: watch the live container
    // for resizes, point the component's term ref at the surface controls, sync
    // the current font, and report pty readiness to the panel. The returned
    // cleanup PARKS the surface (offscreen, still subscribed) instead of
    // disposing it — so switching scope and coming back is a DOM move, not a
    // teardown + replay.
    const bindMount = (surface: PaneTerminalSurface) => {
      termRef.current = surface.controls;
      surface.controls.setFontSize(terminalFontSize);
      // Refit only after the resize settles — a live refit clears the WebGL
      // canvas on every cell-boundary crossing, strobing the whole grid.
      const settledFit = createSettledFit(() => surface.fit());
      const ro = new ResizeObserver(() => settledFit.schedule());
      ro.observe(container);
      surface.fit();
      // GPU rendering only while visible — parked surfaces release the context.
      surface.gpu?.attach();
      if (surface.ptyId) onPtyReady(surface.ptyId);
      return () => {
        ro.disconnect();
        settledFit.cancel();
        surface.gpu?.detach();
        if (termRef.current === surface.controls) termRef.current = null;
        cache.park(surfaceId);
      };
    };

    const existing = cache.get(surfaceId) as PaneTerminalSurface | null;
    if (existing && existing.buildKey === buildKey) {
      // Reattach: move the live element back into this container. No xterm
      // rebuild, no replay — the persistent PTY subscription kept the buffer
      // current while this pane was unmounted on another scope.
      container.appendChild(existing.el);
      const detach = bindMount(existing);
      return () => detach();
    }
    // A stale build (Retry / cwd change) must not reattach the old terminal.
    if (existing) cache.destroy(surfaceId);

    void (async () => {
      const { Terminal, FitAddon } = await prefetchTerminalModules();
      if (cancelled || !containerRef.current) return;

      // The shell runs on a Core, and its PTY frames travel this tab's panel
      // link — the same transport the Harness panes use, addressed by coreId.
      const ptyApi = getCorePtyBridge(coreId);
      const ptyRouter = ptyApi ? getPtyStreamRouter(ptyApi) : null;

      // xterm renders into an element the surface owns (not React's container) so
      // it can be re-parented across mounts and the offscreen holder. Attach it to
      // the live container BEFORE open() so xterm measures real dimensions.
      const el = document.createElement("div");
      el.style.width = "100%";
      el.style.height = "100%";
      container.appendChild(el);

      const term = new Terminal(
        createTerminalOptions({
          colorScheme: getTerminalColorScheme(),
          fontSize: terminalFontSize,
        })
      );
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      const gpu = createTerminalGpuLease(term);

      const surface: PaneTerminalSurface = {
        id: surfaceId,
        el,
        buildKey,
        ptyId: null,
        destroyed: false,
        gpu,
        controls: {
          focus: () => term.focus(),
          clear: () => term.clear(),
          setFontSize: () => undefined,
        },
        fit: () => fitTerminalSurface(term, fit),
        teardown: () => undefined,
      };

      const stopWatchingColorScheme = watchTerminalColorScheme((colorScheme) => {
        term.options.theme = createTerminalTheme({ colorScheme });
      });
      const detachLinks = attachTerminalLinks(term);
      const onFocusIn = () => onFocus();
      el.addEventListener("focusin", onFocusIn);

      const subscriptions: Array<() => void> = [];
      let rafHandle = 0;
      let activePtyId: string | null = null;
      // The PTY subscription stays wired while the pane is parked, so mirror the
      // active pty onto the surface for reattach + the panel's running dot.
      const setActivePty = (id: string | null) => {
        activePtyId = id;
        surface.ptyId = id;
      };
      let replayingPtyId: string | null = null;
      let duringReplayData: SequencedPtyData[] = [];
      let duringReplayExit: { ptyId: string; exitCode: number; signal?: number } | null =
        null;

      const writeToPty = async (data: string) => {
        const id = activePtyId;
        if (!id || !ptyApi) return false;
        return ptyApi.write(id, data);
      };

      const detachFileDrop = wireTerminalFileDrop({
        host: el,
        write: writeToPty,
        onFocus: () => term.focus(),
      });

      attachTerminalKeyHandler({ term, write: writeToPty });

      const seenLaunchUrls = new Set<string>();
      const detectLaunchUrl = (data: string) => {
        if (!onLaunchUrlDetected) return;
        const cleaned = data.replace(ANSI_ESCAPE_REGEX, "");
        const matches = cleaned.matchAll(
          new RegExp(LOOPBACK_URL_WITH_PORT_GROUP_REGEX.source, "g"),
        );
        for (const match of matches) {
          const url = match[0]!;
          if (seenLaunchUrls.has(url)) continue;
          seenLaunchUrls.add(url);
          onLaunchUrlDetected(url);
          return;
        }
      };
      const handleExit = (exitCode?: number) => {
        setActivePty(null);
        term.writeln("");
        term.writeln(`\x1b[2m[process exited (code=${exitCode ?? "unknown"})]\x1b[0m`);
        onPtyExit();
      };
      const resizePtyToSurface = (id: string) => {
        if (!ptyApi) return Promise.resolve(false);
        return resizePtyToTerminal(term, (cols, rows) => ptyApi.resize(id, cols, rows));
      };
      // Coalesce interactive-resize storms (grid drag, wheel zoom) into one
      // Harness SIGWINCH after the drag settles; targets the then-active pty.
      const settledPtyResize = createSettledPtyResize((cols, rows) => {
        const id = activePtyId;
        if (id && ptyApi) ptyApi.resize(id, cols, rows);
      });
      surface.controls = {
        focus: () => term.focus(),
        clear: () => term.clear(),
        setFontSize: (nextFontSize) => {
          // Wheel-zoom fires this per tick; the refit's onResize event lands in
          // the settled debouncer, so the Harness repaints once per zoom gesture.
          applyTerminalFontSize(term, fit, nextFontSize);
        },
      };
      const wireTerminalInput = (id: string) => {
        term.onData((data) => {
          if (ptyApi) ptyApi.write(id, data);
        });
        term.onResize((size) => settledPtyResize.schedule(size));
      };
      const wirePty = (id: string) => {
        if (!ptyApi || !ptyRouter) return;
        setActivePty(id);
        // Routed by the shared transport router (one listener per transport,
        // not per pane) — fires only for this claimed pty.
        subscriptions.push(
          ptyRouter.claim(id, {
            data: (msg) => {
              if (replayingPtyId === id) {
                duringReplayData.push(sequencedPtyData(msg.seq, msg.data));
                return;
              }
              term.write(msg.data);
              detectLaunchUrl(msg.data);
            },
            exit: (msg) => {
              if (replayingPtyId === id) {
                duringReplayExit = msg;
                return;
              }
              handleExit(msg.exitCode);
            },
            // A reattach whose gap the Core's ring no longer covers: what
            // follows is a fresh screen, not a continuation of this one.
            reset: () => term.reset(),
          }),
        );
        wireTerminalInput(id);
      };
      const replayExistingPty = async (id: string) => {
        if (!ptyApi || !ptyRouter) return;
        replayingPtyId = id;
        duringReplayData = [];
        // Output buffered while this pty was unclaimed is already in the
        // replay ring — discard it rather than double-writing it. A buffered
        // exit is surfaced after the replay, like a live one.
        ptyRouter.takePendingData(id);
        duringReplayExit = ptyRouter.takePendingExit(id);
        wirePty(id);
        void resizePtyToSurface(id);

        let replay: PtyReplaySnapshot = { data: "", nextSeq: 0 };
        try {
          replay = await ptyApi.replay(id);
        } finally {
          if (replayingPtyId === id) {
            replayingPtyId = null;
          }
        }
        if (surface.destroyed || activePtyId !== id) return;
        // What this pane paints below is on screen; a later reattach after a
        // dropped link must resume past it, not repeat it.
        ptyRouter.noteReplayed(id, replay.nextSeq);

        if (replay.data) {
          term.write(replay.data);
          detectLaunchUrl(replay.data);
        }
        for (const chunk of dataAfterReplay(duringReplayData, replay)) {
          term.write(chunk);
          detectLaunchUrl(chunk);
        }
        duringReplayData = [];

        const replayExit = duringReplayExit as
          | { ptyId: string; exitCode: number; signal?: number }
          | null;
        duringReplayExit = null;
        if (replayExit) handleExit(replayExit.exitCode);
      };
      const ensurePty = async () => {
        if (surface.destroyed) return;
        setStartError(null);
        try {
          fitTerminalSurface(term, fit);

          if (ptyId) {
            if (ptyApi) {
              await replayExistingPty(ptyId);
            }
            return;
          }

          if (shellSession) {
            // A VM Shell Session lives on the Core's machine itself and has no
            // project folder. The Core skips project-root validation
            // (`shellSession: true`) and starts a login shell at its own home;
            // the browser sends no cwd/command path.
            if (!ptyApi) return;
            const ptySize = normalizePtySize({ cols: term.cols, rows: term.rows });
            const { ptyId: newId } = await ptyApi.spawn({
              taskId: terminal.id,
              // No command: the Core starts an interactive login shell, rc
              // files and all. The launch/ephemeral `startCommand` hint that
              // used to be threaded through here went with the project-root
              // terminal (issue 266).
              command: "",
              cols: ptySize.cols,
              rows: ptySize.rows,
              shellSession: true,
            });
            if (surface.destroyed) {
              await ptyApi.kill(newId).catch(() => undefined);
              return;
            }
            onPtyReady(newId);
            wirePty(newId);
            for (const chunk of ptyRouter?.takePendingData(newId) ?? []) {
              term.write(chunk.data);
              detectLaunchUrl(chunk.data);
            }
            const earlyExit = ptyRouter?.takePendingExit(newId);
            if (earlyExit) handleExit(earlyExit.exitCode);
            return;
          }

          if (!ptyApi) return;
          const ptySize = normalizePtySize({ cols: term.cols, rows: term.rows });
          const { ptyId: newId } = await ptyApi.spawn({
            taskId: terminal.id,
            // Home terminals open at the Core's home dir (resolved by the
            // Core from the `home` flag); the browser supplies no path.
            cwd: isHome ? "" : cwd,
            command: "",
            cols: ptySize.cols,
            rows: ptySize.rows,
            // User-shell terminal: opts into the shell branch, so the Core
            // starts a login shell rather than an allow-listed direct-argv
            // spawn. Harness terminals (TerminalPane.tsx) leave this unset.
            shell: true,
            home: isHome || undefined,
          });
          if (surface.destroyed) {
            if (ptyApi) await ptyApi.kill(newId).catch(() => undefined);
            return;
          }
          onPtyReady(newId);
          wirePty(newId);
          // Output that beat the claim is buffered in the router — drain it so
          // the first paint isn't missing the shell's opening bytes.
          for (const chunk of ptyRouter?.takePendingData(newId) ?? []) {
            term.write(chunk.data);
            detectLaunchUrl(chunk.data);
          }
          const earlyExit = ptyRouter?.takePendingExit(newId);
          if (earlyExit) handleExit(earlyExit.exitCode);
        } catch (err: any) {
          const message = errMsg(err ?? "unknown error");
          setStartError(message);
          setLiveStatus(message);
          term.writeln(`\x1b[31m[failed to start pty: ${message}]\x1b[0m`);
        }
      };

      surface.teardown = () => {
        cancelAnimationFrame(rafHandle);
        settledPtyResize.cancel();
        el.removeEventListener("focusin", onFocusIn);
        detachFileDrop();
        detachLinks();
        stopWatchingColorScheme();
        for (const off of subscriptions) off();
        gpu.dispose();
        term.dispose();
      };

      cache.set(surface);
      // Only grab DOM focus on fresh build if this pane is the focused one.
      // Terminals opened unfocused (run/launch flow) must leave keyboard focus
      // where it is so follow-up hotkeys keep working.
      if (focusedRef.current) term.focus();
      rafHandle = window.requestAnimationFrame(() => ensurePty());
      detachMount = bindMount(surface);
    })();

    return () => {
      cancelled = true;
      detachMount?.();
    };
  }, [terminal.id, coreId, isHome, shellSession, cwd, retryNonce]);

  // Bring focus to the xterm when this pane becomes focused via cycling or
  // after a sibling pane is closed. Defer to the next frame so the focus call
  // lands after Chromium has finished settling focus from the unmounted pane.
  useEffect(() => {
    if (!focused) return;
    const raf = requestAnimationFrame(() => termRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [focused]);

  const commitRename = () => {
    setEditing(false);
    if (draftName.trim() && draftName.trim() !== terminal.name) {
      onRename(draftName);
    } else {
      setDraftName(terminal.name);
    }
  };

  return (
    <CardFrame
      ref={cardRef}
      focused={focused && domFocused}
      onMouseDown={onFocus}
      style={{
        flex: 1,
        minWidth: 200,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {liveStatus}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          background: "var(--terminal-bg)",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <Icon name="terminal" size={11} style={{ color: "var(--text-faint)" }} />
        {editing ? (
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") {
                setEditing(false);
                setDraftName(terminal.name);
              }
            }}
            style={{
              flex: 1,
              background: "var(--surface-0)",
              border: "1px solid var(--border-strong)",
              color: "var(--text)",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              padding: "1px 5px",
              borderRadius: 3,
              outline: "none",
            }}
          />
        ) : (
          <span
            onDoubleClick={() => setEditing(true)}
            title="Double-click to rename"
            style={{
              flex: 1,
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              fontWeight: 500,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              cursor: "text",
            }}
          >
            {terminal.name}
          </span>
        )}
        {shellSession && (
          <span
            title="VM Shell Session — a free-form shell on this Core's machine (the SSH-equivalent escape hatch). Gated by core-link auth; not a project workspace."
            style={{
              padding: "1px 7px",
              borderRadius: 999,
              fontFamily: "var(--mono)",
              fontSize: 10,
              color: "var(--accent)",
              background: "var(--accent-faint, var(--accent-dim))",
              border: "1px solid var(--accent-border)",
              whiteSpace: "nowrap",
              opacity: 0.85,
              marginLeft: 6,
            }}
          >
            VM shell
          </span>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <TerminalZoomControls
            level={zoomLevel}
            canZoomIn={canZoomIn}
            canZoomOut={canZoomOut}
            onZoomIn={zoomIn}
            onZoomOut={zoomOut}
          />
          <Btn
            variant="ghost"
            size="sm"
            icon="eraser"
            onClick={() => termRef.current?.clear()}
            title="Clear terminal output"
            aria-label="Clear terminal output"
            style={{ width: 34, padding: 0 }}
          />
          <Btn
            variant="ghost"
            size="sm"
            icon="trash"
            onClick={() => setConfirmDelete(true)}
            title="Delete terminal (kills the process)"
            aria-label="Delete terminal (kills the process)"
            style={{ width: 34, padding: 0 }}
          />
          <Btn
            variant="ghost"
            size="sm"
            icon="x"
            onClick={onHide}
            title="Hide terminal (keeps it running)"
            aria-label="Hide terminal (keeps it running)"
            style={{ width: 34, padding: 0 }}
          />
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
        title={`Delete terminal "${terminal.name}"?`}
        confirmLabel="Delete"
        variant="danger"
        icon="trash"
      >
        This will kill the running process and remove the terminal. This can&apos;t be undone.
      </ConfirmDialog>
      {startError && (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "8px 10px",
            borderBottom: "1px solid var(--border)",
            color: "var(--status-failed)",
            background: "color-mix(in oklch, var(--status-failed) 10%, transparent)",
            fontFamily: "var(--mono)",
            fontSize: 11.5,
          }}
        >
          <span>{startError}</span>
          <Btn
            variant="ghost"
            size="sm"
            icon="refresh"
            onClick={() => setRetryNonce((value) => value + 1)}
          >
            Retry
          </Btn>
        </div>
      )}
      <div style={{ flex: 1, position: "relative", background: "var(--terminal-bg)" }}>
        <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      </div>
    </CardFrame>
  );
}

