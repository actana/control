import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import { useQueryClient } from "@tanstack/react-query";
import { Btn } from "~/components/ui/Btn";
import { CardFrame } from "~/components/ui/CardFrame";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { DropdownMenuItem, DropdownMenuSeparator } from "~/components/ui/DropdownMenuItem";
import { Modal } from "~/components/ui/Modal";
import { SessionIconPicker } from "~/components/ui/SessionIconPicker";
import { TextField } from "~/components/ui/TextField";
import { EscTooltip, HotkeyTooltip, Tooltip } from "~/components/ui/Tooltip";
import { Z_INDEX } from "~/lib/z-index";
import {
  HARNESS_META,
  DUPLICATE_ACTIVE_SESSION_EVENT,
  STATUS_META,
} from "~/lib/design-meta";
import { mutateTaskForCore } from "~/lib/mutate-task-for-core";
import { useHideableMenu } from "~/lib/hideable-elements";
import { takePendingInitialInput } from "~/lib/pending-initial-input";
import { consumeIntentionalSessionClose } from "~/lib/intentional-session-close";
import { getCorePtyBridge, getPanelBridge } from "~/lib/panel-bridge";
import {
  attachTerminalKeyHandler,
  setTerminalReadOnly,
  terminalExitTaskStatus,
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
import {
  useTerminalZoom,
  useTerminalPaneZoomShortcuts,
  useTerminalPaneWheelZoom,
} from "~/lib/use-terminal-zoom";
import { useHotkey } from "~/lib/use-hotkey";
import { TerminalZoomControls } from "~/components/views/TerminalZoomControls";
import { api } from "~/lib/api";
import { errMsg } from "~/shared/err-msg";
import {
  harnessUsesPersistedSession,
  buildFreshHarnessLaunchCommand,
  isHarnessResumeCommand,
  newSessionId,
} from "~/lib/harness-command";
import { getDefaultModelForHarness } from "~/lib/default-model-store";
import {
  advanceTerminalRunningFallback,
  harnessUsesTerminalPromptFallback,
  IDLE_TERMINAL_RUNNING_FALLBACK,
  noteTerminalWrite,
  type TerminalRunningFallback,
} from "~/lib/task-status-sync";
import { accumulateTerminalPrompt } from "~/lib/terminal-prompt-capture";
import { prefetchTerminalModules } from "~/lib/prefetch-terminal-modules";
import { createTerminalGpuLease } from "~/lib/terminal-webgl";
import { acquireSurfaceBuildTurn } from "~/lib/terminal-build-queue";
import {
  terminalSurfaceCache,
  type CachedTerminalControls,
  type PaneTerminalSurface,
} from "~/lib/terminal-surface-cache";
import { AskUserQuestionOverlay } from "~/components/views/AskUserQuestionOverlay";
import {
  dismissQuestionLocally,
  getCurrentQuestionId,
  getHoldQuestion,
  hydrateTaskQuestion,
  isQuestionDesynced,
  markQuestionDesynced,
  subscribeQuestionStore,
  useQuestionDesynced,
  useQuestionDismissed,
  useTaskQuestion,
} from "~/lib/harness-question-store";
import {
  buildPayloadAnswerKeySequence,
  writeAnswerSequence,
  INTER_QUESTION_DELAY_MS,
  MENU_READY_MS,
  SUBMIT_CONFIRM_DELAY_MS,
  SUBMIT_CONFIRM_KEY,
  type QuestionAnswer,
} from "~/lib/harness-question-answer";
import {
  createQuestionMenuHold,
  questionMenuSignatures,
} from "~/lib/terminal-question-hold";
import { isTerminalAutoReply } from "~/lib/terminal-user-input";
import { attachTerminalLinks } from "~/lib/terminal-links";
import {
  createSettledFit,
  createSettledPtyResize,
  resizePtyToTerminal,
} from "~/lib/terminal-resize";
import {
  appendBoundedSequencedData,
  dataAfterReplay,
  replayDataOrFallback,
  sequencedPtyData,
  type PtyReplaySnapshot,
  type SequencedPtyData,
} from "~/lib/terminal-replay";
import { getPtyStreamRouter, type PtyStreamHandlers } from "~/lib/pty-stream-router";
import { queryKeys, tasksCacheKey, useSettings, useTask } from "~/queries";
import {
  DEFAULT_SESSION_HEADER_BUTTON_VISIBILITY,
  type SessionHeaderButtonVisibility,
} from "~/shared/session-header-buttons";
import { useTerminalActions } from "~/lib/terminal-store";
import {
  onSessionDriveHandover,
  releaseSessionDrive,
  takeSessionDrive,
  useSessionWriteState,
  watchSessionDrive,
} from "~/lib/session-write-store";
import {
  crossClientLockNotice,
  driveMovedToast,
  forceTakeoverConfirmation,
  readOnlyDetail,
  readOnlyLabel,
} from "~/shared/session-write-access";
import type { CoreLinkSessionLockState } from "@actana/sdk/core-link-frames";
import type { Project, Task } from "~/db/schema";
import { normalizePtySize } from "~/shared/pty-size";
import { HARNESS_REGISTRY } from "@actana/shared/harnesses";
import { toast } from "sonner";

export type TerminalDescriptor = {
  taskId: string;
  ptyId: string | null;
  startCommand: string;
  dangerouslySkipPermissions: boolean;
  cwd: string;
  awaitingCreate?: boolean;
  /** Restored from localStorage; spawn waits until the task is revalidated. */
  pendingValidation?: boolean;
  /**
   * The Core this pane's PTY runs on. Spawn/write/resize/kill/replay/onData/
   * onExit are all frames on that Core's link; the Panel persists no
   * task-shaped state (CONTEXT.md — reads come from the Core's
   * `projectsList` / `tasksList` / `sessionsList`). Null means the pane has no
   * machine to run on and never spawns.
   */
  coreId?: string | null;
};

type SessionTerminalSurface = PaneTerminalSurface;

// Header width (px) below which the secondary controls (rename, zoom, clone)
// collapse into the "…" menu; below the tiny threshold the title/status block
// is hidden too and surfaces at the top of that menu instead; below micro even
// the close button folds into the menu (grid cells can shrink to MIN_CELL_PX).
const HEADER_COMPACT_MAX = 380;
const HEADER_TINY_MAX = 210;
const HEADER_MICRO_MAX = 120;

/** Discrete header-width buckets (widest → narrowest). Storing the bucket rather
 *  than the raw width keeps a resize drag from re-rendering the pane every
 *  frame — only a breakpoint crossing changes it. */
type HeaderTier = "full" | "compact" | "tiny" | "micro";
function headerTierFor(width: number): HeaderTier {
  if (width < HEADER_MICRO_MAX) return "micro";
  if (width < HEADER_TINY_MAX) return "tiny";
  if (width < HEADER_COMPACT_MAX) return "compact";
  return "full";
}

/** "…" dropdown holding the header controls that don't fit a narrow pane.
 *  In tiny mode it also carries the (hidden) session title and status. */
function HeaderMoreMenu({
  title,
  statusLabel,
  statusColor,
  showTitle,
  expanded,
  onToggleExpanded,
  onHide,
  onTogglePin,
  pinned,
  pinBusy,
  buttons,
  onRename,
  onClone,
  canZoomIn,
  canZoomOut,
  onZoomIn,
  onZoomOut,
}: {
  title: string;
  statusLabel: string;
  statusColor: string;
  /** Tiny header: the pane title is hidden, so show it at the top of the menu. */
  showTitle: boolean;
  expanded: boolean;
  /** Present only when the expand control was also collapsed into the menu. */
  onToggleExpanded?: () => void;
  /** Present only when the close control was also collapsed into the menu. */
  onHide?: () => void;
  /** Present only when the pin control was collapsed into the menu (micro). */
  onTogglePin?: () => void;
  pinned: boolean;
  pinBusy: boolean;
  /** Which discretionary actions the user has chosen to show (mirrors the header). */
  buttons: SessionHeaderButtonVisibility;
  onRename: () => void;
  onClone: () => void;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<{ top: number; right: number } | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLElement>(null);

  const updateMenuRect = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setMenuRect({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setMenuRect(null);
      return;
    }
    updateMenuRect();
    window.addEventListener("resize", updateMenuRect);
    window.addEventListener("scroll", updateMenuRect, true);
    return () => {
      window.removeEventListener("resize", updateMenuRect);
      window.removeEventListener("scroll", updateMenuRect, true);
    };
  }, [open, updateMenuRect]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <>
      <Tooltip content="Session actions">
        <Btn
          ref={anchorRef}
          variant="ghost"
          size="sm"
          icon="more"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Session actions for ${title}`}
          style={{ width: 34, padding: 0 }}
        />
      </Tooltip>
      {open &&
        menuRect &&
        createPortal(
          <CardFrame
            ref={menuRef}
            role="menu"
            aria-label={`Session actions for ${title}`}
            solid
            className="mc-project-actions-menu"
            style={{
              position: "fixed",
              top: menuRect.top,
              right: menuRect.right,
              minWidth: 190,
              maxWidth: 260,
              boxShadow: "0 14px 32px rgba(0,0,0,0.42)",
              zIndex: Z_INDEX.popover,
            }}
          >
            {showTitle && (
              <>
                <div style={{ padding: "7px 8px 5px", fontFamily: "var(--mono)", minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 11.5,
                      fontWeight: 500,
                      color: "var(--text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {title}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 10,
                      marginTop: 2,
                    }}
                  >
                    <span style={{ color: statusColor }}>{statusLabel}</span>
                  </div>
                </div>
                <DropdownMenuSeparator />
              </>
            )}
            {buttons.rename && (
              <DropdownMenuItem icon="pencil" onClick={() => pick(onRename)}>
                Rename session
              </DropdownMenuItem>
            )}
            {buttons.zoom && (
              <>
                <DropdownMenuItem icon="zoom-out" disabled={!canZoomOut} onClick={onZoomOut}>
                  Zoom out
                </DropdownMenuItem>
                <DropdownMenuItem icon="zoom-in" disabled={!canZoomIn} onClick={onZoomIn}>
                  Zoom in
                </DropdownMenuItem>
              </>
            )}
            {buttons.clone && (
              <DropdownMenuItem icon="copy" onClick={() => pick(onClone)}>
                Clone session
              </DropdownMenuItem>
            )}
            {onTogglePin && (
              <DropdownMenuItem
                icon={pinned ? "pin-fill" : "pin"}
                disabled={pinBusy}
                onClick={() => pick(onTogglePin)}
              >
                {pinned ? "Unpin session" : "Pin session"}
              </DropdownMenuItem>
            )}
            {onToggleExpanded && (
              <DropdownMenuItem
                icon={expanded ? "minimize" : "maximize"}
                onClick={() => pick(onToggleExpanded)}
              >
                {expanded ? "Shrink panel" : "Expand panel"}
              </DropdownMenuItem>
            )}
            {onHide && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem icon="x" danger onClick={() => pick(onHide)}>
                  Hide session panel
                </DropdownMenuItem>
              </>
            )}
          </CardFrame>,
          document.body,
        )}
    </>
  );
}

export function TerminalPane({
  project,
  task,
  onHide,
  expanded = false,
  onToggleExpanded,
  isLast,
  descriptor,
  onPtyReady,
  onHeaderPointerDown,
  headerGrabbing = false,
  hideHeader = false,
  onTogglePin,
  pinBusy = false,
}: {
  project: Project;
  task: Task;
  onHide?: () => void;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  isLast: boolean;
  descriptor: TerminalDescriptor;
  onPtyReady: (ptyId: string | null) => void;
  /** When set, the header bar becomes a drag handle (used by the session grid). */
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  headerGrabbing?: boolean;
  /** Focused Session Mode renders its own window chrome instead. */
  hideHeader?: boolean;
  /** Pin/unpin this session (session grid only). Pinned state is read live from
   *  the task, so no separate flag is needed. Omit to hide the control. */
  onTogglePin?: () => void;
  /** True while a pin toggle is in flight — disables the control. */
  pinBusy?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<XFitAddon | null>(null);
  const termSurfaceRef = useRef<CachedTerminalControls | null>(null);
  const renameFormId = useId();
  const queryClient = useQueryClient();
  const terminals = useTerminalActions();
  const [liveStatus, setLiveStatus] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [renameOpen, setRenameOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [savingTitle, setSavingTitle] = useState(false);
  const savingTitleRef = useRef(false);
  // The PTY onData handler is wired once per surface build and must read the
  // latest task status without rebuilding the terminal. Used to re-arm the
  // Cursor/Codex Enter→running fallback after a turn finishes.
  const liveTaskStatusRef = useRef(task.status);
  // May this pane write to its Session, and if not, which of the two reasons
  // (issue 147). Same ref shape and same reason as the status above: every
  // write path in the surface closure reads it, and the surface is built once.
  const writeState = useSessionWriteState(descriptor.coreId, descriptor.taskId);
  const mayWriteRef = useRef(true);
  mayWriteRef.current = writeState.access.writable;
  const readOnlyReason = writeState.access.writable ? null : writeState.access.reason;
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const [lockBusy, setLockBusy] = useState(false);
  // Latest onHide (the header's close button) read from a ref so the once-per-
  // surface PTY-exit handler can invoke it without rebuilding on every render.
  // Lets a clean shell exit (typing `exit`) close the pane just like the X.
  const onHideRef = useRef(onHide);
  onHideRef.current = onHide;
  const {
    level: zoomLevel,
    fontSize: terminalFontSize,
    zoomBy,
    zoomIn,
    zoomOut,
    resetZoom,
    canZoomIn,
    canZoomOut,
  } = useTerminalZoom(descriptor.taskId);
  useTerminalPaneZoomShortcuts(paneRef, zoomIn, zoomOut, resetZoom);
  useTerminalPaneWheelZoom(paneRef, zoomBy);

  // Which discretionary header buttons the user has chosen to show. Zoom is
  // hidden by default; the keyboard shortcuts (Cmd/Ctrl +/-/0) still work. The
  // zoom shortcuts and wheel-zoom above stay wired regardless of visibility.
  const { data: appSettings } = useSettings();
  const sessionButtons: SessionHeaderButtonVisibility =
    appSettings?.sessionHeaderButtons ?? DEFAULT_SESSION_HEADER_BUTTON_VISIBILITY;
  const { hideElementContextMenu, hideableMenu } = useHideableMenu();

  // Track the header's width *bucket* so narrow grid cells can collapse controls
  // into the "…" menu (compact) and drop the title entirely (tiny). Storing the
  // discrete tier — not the raw pixel width — means a resize drag only triggers
  // a re-render on the few frames that actually cross a breakpoint, not every
  // frame. Reading contentRect (not clientWidth) also avoids a forced reflow.
  const [headerTier, setHeaderTier] = useState<HeaderTier | null>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const apply = (width: number) =>
      setHeaderTier((prev) => {
        const next = headerTierFor(width);
        return prev === next ? prev : next;
      });
    apply(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) apply(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const compactHeader = headerTier !== null && headerTier !== "full";
  const tinyHeader = headerTier === "tiny" || headerTier === "micro";
  const microHeader = headerTier === "micro";
  // Whether the "…" overflow menu carries anything. At tiny/micro it always
  // holds the title (and folded expand/close), so it's kept even with every
  // discretionary button hidden. At the plain compact tier it only holds those
  // buttons — so if the user hid them all, skip the menu rather than open an
  // empty popover (expand/close still render inline below).
  const anyDiscretionaryButton =
    sessionButtons.rename || sessionButtons.zoom || sessionButtons.clone;
  const showMoreMenu = compactHeader && (tinyHeader || anyDiscretionaryButton);

  // Per-row subscription: with N panes mounted, a whole-array subscription
  // re-rendered every pane's header on any task change.
  const { data: selectedLiveTask } = useTask(project.id, task.id);
  const liveTask = selectedLiveTask ?? task;
  liveTaskStatusRef.current = liveTask.status;
  // The Session's name as the operator last saw it, for copy written from
  // effects that must not re-subscribe every time somebody renames a Session.
  const liveTitleRef = useRef(liveTask.title);
  liveTitleRef.current = liveTask.title;
  const meta = HARNESS_META[liveTask.agent];
  const statusMeta = STATUS_META[liveTask.status];
  const sessionRunning = liveTask.status === "running";
  // The card reads from the Core-tagged bucket (issue 84) — invalidating the
  // untagged key left a Core-owned row on screen exactly as stale as before.
  const tasksKey = tasksCacheKey(project.id, descriptor.coreId);

  // Native AskUserQuestion overlay: pending question data arrives over SSE
  // (see harness-question-store); hydrate covers panes that mount after the
  // event fired (e.g. reopening a project mid-question).
  const pendingQuestion = useTaskQuestion(task.id);
  const questionDismissed = useQuestionDismissed(pendingQuestion?.id);
  const questionDesynced = useQuestionDesynced(pendingQuestion?.id);
  const answeredQuestionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (
      liveTask.agent === "claude-code" &&
      liveTask.status === "needs-input" &&
      pendingQuestion === undefined
    ) {
      void hydrateTaskQuestion(task.id);
    }
  }, [liveTask.agent, liveTask.status, pendingQuestion, task.id]);
  const showQuestionOverlay =
    !!pendingQuestion &&
    !questionDismissed &&
    liveTask.status === "needs-input" &&
    !startError &&
    // Answering a question is a write — it walks the TUI menu with injected
    // keys. A Reader is offered no input affordance at all, and an overlay full
    // of buttons that cannot land is the worst kind (issue 147).
    writeState.access.writable;

  // ─── Session write access (issue 147, ADR 0024 D3/D8) ──────────────────────

  // This pane is on screen, so this tab is a candidate to drive its Session
  // among the Panel's own tabs — and gives that up when the pane goes. Not a
  // claim on the **Session lock**: this never leaves the Panel, and the lock is
  // an explicit gesture on the core-link (D6). First-come, so the second tab to
  // open the same Session follows the first rather than fighting it.
  //
  // Per pane on purpose, and counted per tab underneath (issue 186): a second
  // pane of this tab on the same Session announces nothing — the tab's interest
  // is already held, and re-asserting it would move the keyboard off whichever
  // pane the operator was typing in — and this cleanup gives the Session back
  // only when it is the last pane to go. What the mount/unmount pair says here
  // is what this pane holds; what the tab holds is the sum of them.
  useEffect(() => {
    const coreId = descriptor.coreId;
    if (!coreId) return;
    watchSessionDrive(coreId, descriptor.taskId);
    return () => releaseSessionDrive(coreId, descriptor.taskId);
  }, [descriptor.coreId, descriptor.taskId]);

  // Read-only is a *state of this terminal*, applied to the surface this pane
  // already has (CONTEXT.md — Singular UI). `bindMount` applies it on attach;
  // this is for the answer moving under an open pane, which is the case D8
  // exists for.
  useEffect(() => {
    termSurfaceRef.current?.setReadOnly?.(!writeState.access.writable);
  }, [writeState.access.writable]);

  // The loser of an intra-Panel handover. Its own event, its own copy, and
  // nothing in common with the takeover below beyond both ending in a pane the
  // operator can no longer type into: nothing was taken here and nothing was
  // lost — the operator moved their own keyboard between their own tabs.
  useEffect(() => {
    const coreId = descriptor.coreId;
    if (!coreId) return;
    return onSessionDriveHandover((msg) => {
      if (msg.coreId !== coreId || msg.taskId !== descriptor.taskId) return;
      const copy = driveMovedToast(liveTitleRef.current);
      toast.message(copy.title, { description: copy.detail });
    });
  }, [descriptor.coreId, descriptor.taskId]);

  // The loser of a cross-client change. The other event, and deliberately not
  // the same sentence: a Core client that is not this Panel now holds the
  // Session, this Panel did not agree to it, and a force takeover is
  // unrecoverable by design — whatever was typed and not sent is gone (D7).
  // Which line it earns, and whether it earns one at all, is
  // {@link crossClientLockNotice}'s; what this holds is the *settled* state to
  // compare against — one from a Core that publishes locks at all, never the
  // seeded default, which reads `unlocked` on a Session nothing has been heard
  // about and would turn "this pane just learned the Session is held" into
  // "somebody took it".
  const settledLockState = useRef<CoreLinkSessionLockState | null>(
    writeState.lock.supported ? writeState.lock.state : null,
  );
  useEffect(() => {
    if (!writeState.lock.supported) return;
    const before = settledLockState.current;
    settledLockState.current = writeState.lock.state;
    const copy = crossClientLockNotice({
      before,
      now: writeState.lock.state,
      sessionTitle: liveTitleRef.current,
    });
    if (copy) toast.message(copy.title, { description: copy.detail });
  }, [writeState.lock.supported, writeState.lock.state]);

  /** Take the Session lock for this Panel, if nobody else has it (D6). */
  const claimSessionLock = async () => {
    const coreId = descriptor.coreId;
    if (!coreId) return;
    setLockBusy(true);
    try {
      const bridge = getPanelBridge();
      const result = await bridge?.claimSession(coreId, descriptor.taskId);
      // A denied claim is an answer, not a failure — somebody else has it, and
      // the way past is the takeover, which the header is already offering by
      // the time this resolves (the register learned it from the same answer).
      if (result && result.supported && !result.granted) {
        toast.message(`“${liveTitleRef.current}” is held by another client`, {
          description: "Take it over if you need to drive it from here.",
        });
      }
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setLockBusy(false);
    }
  };

  /** Give it back. Explicit, like taking it — nothing here releases on idle (D7). */
  const releaseSessionLockNow = async () => {
    const coreId = descriptor.coreId;
    if (!coreId) return;
    setLockBusy(true);
    try {
      await getPanelBridge()?.releaseSessionLock(coreId, descriptor.taskId);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setLockBusy(false);
    }
  };

  /** Take it whoever holds it — only ever from the confirmation that names it. */
  const forceTakeoverSessionLock = async () => {
    const coreId = descriptor.coreId;
    if (!coreId) return;
    setLockBusy(true);
    try {
      const result = await getPanelBridge()?.forceTakeoverSession(coreId, descriptor.taskId);
      setTakeoverOpen(false);
      // Only report an eviction that happened. A takeover of a Session that had
      // been let go in the meantime is an ordinary claim, and saying otherwise
      // would tell the operator they cost somebody their work when they did not.
      if (result?.takenFrom === "another-connection") {
        toast.message(`Took over “${liveTitleRef.current}”`, {
          description: "The client that was holding this Session can no longer write to it.",
        });
      }
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setLockBusy(false);
    }
  };

  const submitQuestionAnswers = async (answers: QuestionAnswer[]): Promise<boolean> => {
    const q = pendingQuestion;
    if (!q) return false;
    if (answeredQuestionsRef.current.has(q.id)) return false;
    // The store is the live source of truth; a cleared/replaced question means
    // the TUI menu underneath is gone and injected keys would hit the REPL.
    if (getCurrentQuestionId(task.id) !== q.id) return false;
    const write = termSurfaceRef.current?.writeToPty;
    if (!write) return false;
    const plan = buildPayloadAnswerKeySequence(
      answers,
      q.questions.map((question) => ({ optionCount: question.options.length })),
    );
    if (!plan) return false;
    answeredQuestionsRef.current.add(q.id);
    // The hook fires before the TUI menu paints; keys written into the paint
    // window get misrouted. Wait out the remainder of the ready window (only
    // ever bites when the user answers within ~a second of the overlay).
    // Abort if the question resolved some other way, or the user started
    // typing in the terminal (injected keys would interleave with theirs).
    const walkInvalid = () =>
      getCurrentQuestionId(task.id) !== q.id || isQuestionDesynced(q.id);
    const settle = q.createdAt + MENU_READY_MS - Date.now();
    if (settle > 0) {
      await new Promise((resolve) => setTimeout(resolve, settle));
      if (walkInvalid()) return false;
    }
    for (let i = 0; i < plan.steps.length; i++) {
      if (i > 0) {
        // Let the TUI advance to the next question's tab before its walk.
        await new Promise((resolve) => setTimeout(resolve, INTER_QUESTION_DELAY_MS));
        if (walkInvalid()) return false;
      }
      await writeAnswerSequence(write, plan.steps[i]!);
    }
    if (plan.needsSubmitConfirm) {
      await new Promise((resolve) => setTimeout(resolve, SUBMIT_CONFIRM_DELAY_MS));
      write(SUBMIT_CONFIRM_KEY);
    }
    return true;
  };

  const dismissQuestionOverlay = () => {
    if (pendingQuestion) dismissQuestionLocally(pendingQuestion.id);
    termSurfaceRef.current?.focus();
  };


  const requestSessionClone = () => {
    if (typeof window === "undefined") return;
    // Carry this pane's own session id so the handler clones (and, in grid view,
    // positions the clone next to) the session whose button was clicked — not
    // whatever session happens to be active in the current scope.
    window.dispatchEvent(
      new CustomEvent(DUPLICATE_ACTIVE_SESSION_EVENT, { detail: { taskId: task.id } }),
    );
  };

  useEffect(() => {
    if (!renameOpen) setTitleDraft(liveTask.title);
  }, [renameOpen, liveTask.title]);

  const openRenameDialog = () => {
    setTitleDraft(liveTask.title);
    setRenameOpen(true);
  };

  const closeRenameDialog = () => {
    if (savingTitleRef.current) return;
    setTitleDraft(liveTask.title);
    setRenameOpen(false);
  };

  const commitTitleEdit = async () => {
    if (savingTitleRef.current) return;
    const nextTitle = titleDraft.trim();
    if (!nextTitle) return;
    if (nextTitle === liveTask.title) {
      setRenameOpen(false);
      return;
    }

    savingTitleRef.current = true;
    setSavingTitle(true);
    await queryClient.cancelQueries({ queryKey: tasksKey });
    const previousTasks = queryClient.getQueryData<Task[]>(tasksKey);
    const previousTask = previousTasks?.find((t) => t.id === liveTask.id) ?? liveTask;
    const optimisticTask = {
      ...liveTask,
      title: nextTitle,
      titleManuallySet: true,
      updatedAt: Date.now(),
    };
    queryClient.setQueryData<Task[]>(tasksKey, (current) =>
      (current ?? []).map((t) => (t.id === liveTask.id ? optimisticTask : t)),
    );
    terminals.syncTask(optimisticTask);

    try {
      // A rename is Core-owned state, so it travels the same mutation frame
      // pin and icon do (ADR-0005): the Core that owns the row is the one that
      // renames it, and every other tab watching that Core sees the new title.
      const snapshot = await mutateTaskForCore(descriptor.coreId, {
        op: "update",
        taskId: liveTask.id,
        title: nextTitle,
      });
      const nextTask: Task = snapshot
        ? {
            ...liveTask,
            title: snapshot.title,
            titleManuallySet: true,
            updatedAt: snapshot.updatedAt,
          }
        : optimisticTask;
      queryClient.setQueryData<Task[]>(tasksKey, (current) =>
        (current ?? []).map((t) => (t.id === liveTask.id ? nextTask : t)),
      );
      terminals.syncTask(nextTask);
      setRenameOpen(false);
      void queryClient.invalidateQueries({ queryKey: tasksKey });
    } catch (e: unknown) {
      if (previousTasks) queryClient.setQueryData<Task[]>(tasksKey, previousTasks);
      terminals.syncTask(previousTask);
      toast.error(e instanceof Error ? e.message : "Could not rename session");
    } finally {
      savingTitleRef.current = false;
      setSavingTitle(false);
    }
  };
  const canSaveTitle = titleDraft.trim().length > 0 && !savingTitle;
  useHotkey("dialog.submit", () => void commitTitleEdit(), {
    enabled: renameOpen && canSaveTitle,
  });

  useEffect(() => {
    termSurfaceRef.current?.setFontSize(terminalFontSize);
  }, [terminalFontSize]);

  useEffect(() => {
    const cache = terminalSurfaceCache;
    // Surfaces are cached by task id (one live xterm per session).
    const surfaceId = descriptor.taskId;
    // awaitingCreate (task row not yet persisted), pendingValidation (restored
    // session not yet revalidated) and the retry nonce all mean "build fresh";
    // a plain remount (navigating back to this session) keeps the same buildKey
    // and reattaches the existing surface instantly — no replay.
    const buildKey = `${descriptor.awaitingCreate ? 1 : 0} ${descriptor.pendingValidation ? 1 : 0} ${retryNonce}`;
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let detachMount: (() => void) | undefined;

    // Bind THIS mount to a (new or reattached) surface. The returned cleanup
    // PARKS the surface (offscreen, still subscribed) instead of disposing it, so
    // leaving and returning to this session is a DOM move rather than a teardown +
    // scrollback replay.
    const bindMount = (surface: SessionTerminalSurface) => {
      // On screen again — exempt from parked-surface eviction while visible.
      cache.markMounted(surface.id);
      termSurfaceRef.current = surface.controls;
      surface.controls.setFontSize(terminalFontSize);
      // A surface is cached per Session and reattached rather than rebuilt, so
      // a pane coming back on screen has to be told where it stands now — the
      // lock may well have moved while it was parked (issue 147).
      surface.controls.setReadOnly?.(!mayWriteRef.current);
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
        if (termSurfaceRef.current === surface.controls) termSurfaceRef.current = null;
        cache.park(surface.id);
      };
    };

    const existing = cache.get(surfaceId) as SessionTerminalSurface | null;
    if (existing && existing.buildKey === buildKey) {
      container.appendChild(existing.el);
      const detach = bindMount(existing);
      return () => detach();
    }
    // A stale build (Retry / task just persisted) must not reattach the old one.
    if (existing) cache.destroy(surfaceId);

    // Held while this pane does its heavy renderer work (Terminal + open() +
    // GPU attach); released in the .finally below so error/cancel paths can't
    // strand the turn. See terminal-build-queue.
    let releaseBuildTurn: (() => void) | null = null;

    void (async () => {
      const { Terminal, FitAddon } = await prefetchTerminalModules();
      if (cancelled || !containerRef.current) return;

      // The pane's PTY runs on its Core, reached over this tab's panel link:
      // the service holds that Core's core-link and forwards the spawn/write/
      // resize/kill frames to its Core, and the output streams back the same
      // way. With no Core there is no transport — the pane renders but never
      // spawns.
      const corePtyBridge = getCorePtyBridge(descriptor.coreId);
      const ptyApi = corePtyBridge;

      // A grid mounts every pane in one commit; building all their xterm
      // surfaces in one task blocks the route transition's first paint. Take
      // per-frame turns instead so the page shows instantly and cells fill in.
      releaseBuildTurn = await acquireSurfaceBuildTurn();
      if (cancelled || !containerRef.current) return;

      const cursorColor = meta?.color;
      // xterm renders into a surface-owned element so it survives unmounts and is
      // re-parented between this container and the offscreen holder. Attach it to
      // the live container BEFORE open() so xterm measures real dimensions.
      const el = document.createElement("div");
      el.style.width = "100%";
      el.style.height = "100%";
      container.appendChild(el);
      const term = new Terminal(
        createTerminalOptions({
          cursorColor,
          colorScheme: getTerminalColorScheme(),
          fontSize: terminalFontSize,
        })
      );
      const fit = new FitAddon();
      fitRef.current = fit;
      term.loadAddon(fit);
      term.open(el);
      const gpu = createTerminalGpuLease(term);

      const surface: SessionTerminalSurface = {
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
          writeToPty: (data) => {
            // surface.ptyId mirrors the active pty across respawns.
            if (surface.ptyId && ptyApi && mayWriteRef.current) void ptyApi.write(surface.ptyId, data);
          },
          setReadOnly: (readOnly) => setTerminalReadOnly(term, readOnly),
        },
        fit: () => fitTerminalSurface(term, fit),
        teardown: () => undefined,
      };

      const host = el;
      const subscriptions: Array<() => void> = [];
      let rafHandle = 0;
      let activePtyId: string | null = null;
      // One shared listener per transport, routed by ptyId (see
      // pty-stream-router.ts) — the pane claims its active pty instead of
      // subscribing to every pty's output.
      const ptyRouter = ptyApi ? getPtyStreamRouter(ptyApi) : null;
      // Assigned once questionHold/handlePtyExit exist; claims are only made
      // from the wire* paths, which run after setup completes.
      let ptyStreamHandlers: PtyStreamHandlers | null = null;
      let unclaimActivePty: (() => void) | null = null;
      // The PTY claim stays wired while parked; mirror the active pty onto
      // the surface so reattach + the session list's running state stay correct.
      const setActivePty = (id: string | null) => {
        activePtyId = id;
        surface.ptyId = id;
        unclaimActivePty?.();
        unclaimActivePty = null;
        if (id && ptyRouter && ptyStreamHandlers) {
          unclaimActivePty = ptyRouter.claim(id, ptyStreamHandlers);
        }
      };
      // Coalesce interactive-resize storms (grid drag, wheel zoom) into one
      // agent SIGWINCH after the drag settles; targets the then-active pty.
      const settledPtyResize = createSettledPtyResize((cols, rows) => {
        const id = activePtyId;
        if (id && ptyApi) ptyApi.resize(id, cols, rows);
      });
      const PENDING_OUTPUT_MAX_CHARS = 64_000;
      let replayingPtyId: string | null = null;
      let duringReplayData: SequencedPtyData[] = [];
      let duringReplayExit: { ptyId: string; exitCode: number; signal?: number } | null =
        null;
      // The Enter→running fallback for a Session whose hooks never announce a
      // turn's start: the one-shot latch AND the turn the operator is composing
      // in this pane (issue 386). Declared with the surface but reset per pty
      // in `wireTerminalInput` — a half-typed line, or a `pasting` latch, must
      // not survive into the next harness process.
      let runningFallback: TerminalRunningFallback = IDLE_TERMINAL_RUNNING_FALLBACK;
      let promptCaptureBuffer = "";
      let promptTitlePosted = false;
      const stopWatchingColorScheme = watchTerminalColorScheme((colorScheme) => {
        term.options.theme = createTerminalTheme({ cursorColor, colorScheme });
      });
      const detachLinks = attachTerminalLinks(term);

      // Every byte this pane sends passes through here or through the `onData`
      // handler below, and both consult the same ref (issue 147). The ref, not
      // a captured value: the surface is built once and outlives every render
      // that could change the answer, and a gate that read a stale closure
      // would be a Reader that could still type for as long as its pane
      // happened to have been built before the lock moved.
      //
      // Belt and braces with `disableStdin` — that stops xterm accepting keys
      // at all, which is what makes read-only *visible*; this stops the paths
      // that do not go through xterm's keyboard: the file drop, the key map's
      // escape sequences, and the question overlay's injected answers.
      const writeToPty = async (data: string) => {
        const ptyId = activePtyId;
        if (!ptyId || !ptyApi || !mayWriteRef.current) return false;
        // Every byte on this path skips xterm's keyboard, so `onData` never
        // sees it: the dropped project path, the key map's Cmd+Backspace. Fold
        // it into the same turn the fallback watches, or a dropped path
        // followed by Enter starts a real turn against a card still reading
        // `finished` (issue 386). It composes only — the Enter that submits it
        // comes back through `onData`, which is where the PATCH is decided.
        runningFallback = noteTerminalWrite(runningFallback, data);
        return ptyApi.write(ptyId, data);
      };

      const detachFileDrop = wireTerminalFileDrop({
        host,
        write: writeToPty,
        onFocus: () => term.focus(),
      });

      attachTerminalKeyHandler({ term, write: writeToPty });

      // If an agent process exits before it has had a chance to render its
      // first useful prompt, preserve the panel so the user can read the error.
      const START_FAILURE_EXIT_MS = 3000;
      // If a resume spawn dies almost immediately, the session file is gone or
      // unreadable. Per the persistence design we start fresh instead of
      // deleting the task card.
      let spawnAt = 0;
      let spawnedAsResume = false;
      // Whether a hook will announce the START of a turn for THIS Session,
      // as its Core answered at spawn. Until a spawn answers, assume not: an
      // unanswered spawn has nothing reporting either, and an armed fallback
      // is the safe direction.
      let hooksReportTurnStart = false;

      const clearActivePty = () => {
        setActivePty(null);
        onPtyReady(null);
      };

      const handlePtyExit = (exitCode?: number) => {
        const elapsed = Date.now() - spawnAt;
        if (
          spawnedAsResume &&
          harnessUsesPersistedSession(task.agent) &&
          elapsed < START_FAILURE_EXIT_MS
        ) {
          void (async () => {
            const fresh =
              task.agent === "codex" || task.agent === "opencode" ? null : newSessionId();
            try {
              // The row is the Core's (ADR 0004/0005) — the Panel's own HTTP
              // task API has no such row, so writing the fresh session id
              // there left the Core's column holding a dead id (issue 84).
              await mutateTaskForCore(descriptor.coreId, {
                op: "update",
                taskId: descriptor.taskId,
                claudeSessionId: fresh,
              });
            } catch {
              /* best effort — even if patch fails, spawn with fresh id */
            }
            term.writeln(
              `\x1b[33m[resume failed; starting a fresh ${HARNESS_REGISTRY[task.agent].label} session]\x1b[0m`
            );
            const cmd = buildFreshHarnessLaunchCommand(
              { ...task, claudeSessionId: fresh },
              fresh ?? "",
              { model: getDefaultModelForHarness(task.agent) },
            );
            try {
              await spawnAndWire(cmd, false);
            } catch (err) {
              const message = errMsg(err ?? "unknown error");
              clearActivePty();
              setStartError(message);
              setLiveStatus(message);
              term.writeln(`\x1b[31m[failed to start pty: ${message}]\x1b[0m`);
            }
          })();
          return;
        }
        if (elapsed < START_FAILURE_EXIT_MS) {
          clearActivePty();
          const code = exitCode ?? "unknown";
          const message = `Session exited immediately (code=${code}). Review the terminal output above, then retry.`;
          setStartError(message);
          setLiveStatus(message);
          term.writeln("");
          term.writeln(`\x1b[31m[${message}]\x1b[0m`);
          return;
        }
        if (surface.destroyed || consumeIntentionalSessionClose(descriptor.taskId)) {
          return;
        }
        clearActivePty();
        const status = terminalExitTaskStatus(exitCode);
        const code = exitCode ?? "unknown";
        const message =
          status === "finished"
            ? `Session finished (code=${code}).`
            : `Session terminated (code=${code}).`;
        setLiveStatus(message);
        term.writeln("");
        term.writeln(`\x1b[2m[${message}]\x1b[0m`);
        void (async () => {
          // A Core settles its own Session's exit (issue 84): the Core watches
          // the PTY it spawned, so it sees the exit whether or not this tab is
          // open, and it settles *conditionally* — a Session already
          // `interrupted` keeps that status. This unconditional patch would
          // overwrite it with `finished` and raise a spurious
          // `session:finished` besides, so it stays on the arm that still
          // needs it: the Panel's own rows, whose PTYs no Core watches.
          if (!descriptor.coreId) {
            try {
              const patched = await mutateTaskForCore(null, {
                op: "update",
                taskId: descriptor.taskId,
                status,
              });
              // A null snapshot is the mutation finding no such row — the card
              // would go on claiming the Session is running, so say so.
              if (!patched) {
                toast.error("This session is gone — its exit status was not recorded");
              }
            } catch (e: unknown) {
              toast.error(
                e instanceof Error ? e.message : "Could not record the session's exit status",
              );
            }
          }
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: tasksCacheKey(project.id, descriptor.coreId),
            }),
            queryClient.invalidateQueries({ queryKey: queryKeys.project(project.id) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
          ]);
          // A clean shell exit (the user typed `exit`) should dismiss the pane
          // just like clicking the header's close button — otherwise a dead
          // "Session finished" cell lingers in the grid. Fire after the status
          // patch + invalidation so the close path sees a non-running task and
          // archives without a confirm prompt. Terminated (crashed) sessions
          // stay put so their output can be inspected.
          if (status === "finished") onHideRef.current?.();
        })();
      };

      // Keeps the TUI's own copy of a pending question's menu from painting
      // while the popup overlay answers it — the transcript stays visible and
      // scrollable, only the menu frames are withheld (and fast-forwarded in
      // one write once the question resolves). See terminal-question-hold.
      let holdSignatures: { id: string; sigs: string[] } | null = null;
      const questionHold = createQuestionMenuHold({
        getSignatures: () => {
          const q = getHoldQuestion(descriptor.taskId);
          if (!q) return null;
          if (holdSignatures?.id !== q.id) {
            holdSignatures = { id: q.id, sigs: questionMenuSignatures(q) };
          }
          return holdSignatures.sigs;
        },
        write: (data) => term.write(data),
      });
      subscriptions.push(subscribeQuestionStore(() => questionHold.sync()));
      subscriptions.push(() => questionHold.dispose());

      if (ptyRouter) {
        // Routed by the shared transport router: these only ever fire for the
        // pty this surface has claimed. Output for not-yet-claimed ptys is
        // buffered inside the router and drained by the wire* paths below.
        ptyStreamHandlers = {
          data: (msg) => {
            if (replayingPtyId === msg.ptyId) {
              appendBoundedSequencedData(
                duringReplayData,
                sequencedPtyData(msg.seq, msg.data),
                PENDING_OUTPUT_MAX_CHARS,
              );
              return;
            }
            questionHold.write(msg.data);
          },
          exit: (msg) => {
            if (replayingPtyId === msg.ptyId) {
              duringReplayExit = msg;
              return;
            }
            handlePtyExit(msg.exitCode);
          },
          // A reattach after a long link outage whose gap the Core's ring no
          // longer covers: what follows is a fresh screen, so drop the stale
          // one rather than splicing onto it.
          reset: () => term.reset(),
        };
        subscriptions.push(() => {
          unclaimActivePty?.();
          unclaimActivePty = null;
        });
      }

      const resizePtyToSurface = (ptyId: string) => {
        if (!ptyApi) return Promise.resolve(false);
        return resizePtyToTerminal(term, (cols, rows) => ptyApi.resize(ptyId, cols, rows));
      };

      surface.controls = {
        focus: () => term.focus(),
        clear: () => term.clear(),
        setFontSize: (nextFontSize) => {
          // Wheel-zoom fires this per tick; the refit's onResize event lands in
          // the settled debouncer, so the agent repaints once per zoom gesture.
          applyTerminalFontSize(term, fit, nextFontSize);
        },
        writeToPty: (data) => {
          // surface.ptyId mirrors the active pty across respawns.
          if (surface.ptyId && ptyApi && mayWriteRef.current) void ptyApi.write(surface.ptyId, data);
        },
        setReadOnly: (readOnly) => setTerminalReadOnly(term, readOnly),
      };

      const wireTerminalInput = (ptyId: string) => {
        // A new pty is a new harness process at a fresh prompt. Anything half
        // entered against the last one is gone from the screen and must go from
        // the pane's mirror of it too: a surviving composition makes the first
        // stray Enter post `running`, and a surviving `pasting` latch swallows
        // every `\r` for the life of the pane.
        runningFallback = IDLE_TERMINAL_RUNNING_FALLBACK;
        promptCaptureBuffer = "";
        term.onData((data) => {
          // A Reader sends nothing and reports nothing (issue 147). The return
          // is before the status and prompt-capture side effects deliberately:
          // they are writes of their own — a `running` patch and a title the
          // Core's generator would act on — and a pane that may not type into a
          // Session may not rename it either. In practice `disableStdin` means
          // typed keys never reach here at all; this covers the paths that do
          // not come from the keyboard, and the instant between the lock moving
          // and React re-rendering the option onto the terminal.
          if (!mayWriteRef.current) return;
          // Typing while a question is pending moves the TUI highlight under
          // the overlay's feet — flag it so the overlay stops injecting.
          // onData also carries terminal-generated replies (focus reports,
          // query responses) which must NOT count as typing; injected answers
          // bypass onData entirely. No-op when no question is pending.
          if (!isTerminalAutoReply(data)) markQuestionDesynced(descriptor.taskId);
          const usesPromptFallback = harnessUsesTerminalPromptFallback(task.agent);
          let submittedPrompt: string | null = null;
          if (usesPromptFallback && !promptTitlePosted) {
            const captured = accumulateTerminalPrompt(promptCaptureBuffer, data);
            promptCaptureBuffer = captured.buffer;
            submittedPrompt = captured.submitted;
          }

          // Cursor CLI still does not fire beforeSubmitPrompt, so a submitted
          // prompt is the per-turn running signal. "Submitted" is the whole
          // point of issue 386: the latch re-arms once the task leaves
          // "running" (stop → finished, needs-input, …) so a second prompt in
          // the same session updates the card again — but on its own that made
          // every newline after settlement a new turn, so a stray Enter or a
          // pasted path resurrected `running`. The fallback now waits for the
          // operator to actually enter something and submit it.
          const fallbackStep = advanceTerminalRunningFallback(runningFallback, {
            data,
            currentStatus: liveTaskStatusRef.current,
            hooksReportTurnStart,
          });
          runningFallback = fallbackStep.state;
          if (fallbackStep.postRunning) {
            void (async () => {
              try {
                // Same routing as the exit patch above: a turn-start status is
                // Core-owned state like any other column on the row.
                await mutateTaskForCore(descriptor.coreId, {
                  op: "update",
                  taskId: descriptor.taskId,
                  status: "running",
                });
              } catch {
                // Only the status mutation un-latches, and only its own catch
                // may do it. Sharing one `try` with the title and the cache
                // invalidations below meant a title-generator hiccup AFTER a
                // successful PATCH cleared the latch anyway — and, because this
                // handler re-reads the live value, a late failure from turn N
                // could clear a latch turn N+1 had just set.
                runningFallback = { ...runningFallback, posted: false };
                return;
              }
              try {
                // The prompt patches no column of its own: it only asks a
                // title generator to name the session. Which generator depends
                // on who owns the row — the Core's, for a Core-owned Session
                // (issue 84), reached by the frame that exists because Cursor
                // never fires `beforeSubmitPrompt` for the Core's own hook
                // receiver to catch.
                if (submittedPrompt) {
                  if (descriptor.coreId && corePtyBridge) {
                    await corePtyBridge.submitPrompt(descriptor.taskId, submittedPrompt);
                  } else if (!descriptor.coreId) {
                    await api.updateTaskStatus(descriptor.taskId, {
                      prompt: submittedPrompt,
                    });
                  }
                  promptTitlePosted = true;
                }
                await Promise.all([
                  queryClient.invalidateQueries({
                    queryKey: tasksCacheKey(project.id, descriptor.coreId),
                  }),
                  queryClient.invalidateQueries({ queryKey: queryKeys.project(project.id) }),
                  queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
                ]);
              } catch {
                // The row is already `running`; a missed title or a stale cache
                // is not worth un-latching a turn that did start.
              }
            })();
          }
          if (ptyApi) {
            ptyApi.write(ptyId, data);
          }
        });
        term.onResize((size) => settledPtyResize.schedule(size));
      };

      const wireNewPty = (ptyId: string): boolean => {
        if (!ptyApi || !ptyRouter) return false;
        setActivePty(ptyId);
        for (const chunk of ptyRouter.takePendingData(ptyId)) {
          term.write(chunk.data);
        }
        const pendingExit = ptyRouter.takePendingExit(ptyId);
        if (pendingExit) {
          handlePtyExit(pendingExit.exitCode);
          return false;
        }
        wireTerminalInput(ptyId);
        return true;
      };

      const wireExistingPty = async (ptyId: string): Promise<boolean> => {
        if (!ptyApi || !ptyRouter) return false;

        replayingPtyId = ptyId;
        duringReplayData = [];
        duringReplayExit = ptyRouter.takePendingExit(ptyId);

        setActivePty(ptyId);
        const pendingBeforeReplay = ptyRouter.takePendingData(ptyId);
        wireTerminalInput(ptyId);

        void resizePtyToSurface(ptyId);
        let replay: PtyReplaySnapshot = { data: "", nextSeq: 0 };
        try {
          replay = await ptyApi.replay(ptyId);
        } finally {
          if (replayingPtyId === ptyId) {
            replayingPtyId = null;
          }
        }
        if (surface.destroyed || activePtyId !== ptyId) return false;
        if (replay.nextSeq === 0) {
          clearActivePty();
          return false;
        }
        // What this pane paints below is on screen; a later reattach after a
        // dropped link must resume past it, not repeat it.
        ptyRouter.noteReplayed(ptyId, replay.nextSeq);

        const replayData = replayDataOrFallback(replay, pendingBeforeReplay);
        if (replayData) term.write(replayData);

        for (const chunk of dataAfterReplay(duringReplayData, replay)) term.write(chunk);
        duringReplayData = [];

        const replayExit = duringReplayExit;
        duringReplayExit = null;
        if (replayExit) {
          handlePtyExit(replayExit.exitCode);
          return true;
        }
        return true;
      };

      const spawnAndWire = async (command: string, isResume: boolean) => {
        if (!ptyApi) return;
        const ptySize = normalizePtySize({ cols: term.cols, rows: term.rows });
        // Ship / Sync / Create-PR stash a starting prompt via
        // setPendingInitialInput; consume it here so the first spawn writes it
        // to the PTY. Only seed fresh launches — resumes carry the prompt
        // history already.
        const initialInput = !isResume
          ? takePendingInitialInput(descriptor.taskId)
          : undefined;
        // Spawn on the Core over the panel link: the Panel service forwards
        // the frame down that Core's core-link, and the PTY's output streams
        // back the same way, demuxed into this pane by the shared per-Core
        // router. An unreachable Core throws with an actionable message so the
        // pane's "failed to start pty" catch surfaces it — no silent no-op.
        const spawnResult = await ptyApi.spawn({
          taskId: descriptor.taskId,
          cwd: descriptor.cwd,
          command,
          cols: ptySize.cols,
          rows: ptySize.rows,
          agent: task.agent,
          dangerouslySkipPermissions: descriptor.dangerouslySkipPermissions,
          missionControlTheme: getTerminalColorScheme(),
          initialInput,
        });
        const { ptyId } = spawnResult;
        hooksReportTurnStart = spawnResult.hooksReportTurnStart;
        spawnAt = Date.now();
        spawnedAsResume = isResume;
        if (surface.destroyed) {
          if (ptyApi) await ptyApi.kill(ptyId).catch(() => undefined);
          return;
        }
        if (wireNewPty(ptyId)) onPtyReady(ptyId);
      };

      const ensurePty = async () => {
        if (surface.destroyed) return;
        if (descriptor.awaitingCreate) return;
        // Restored session not yet revalidated — the store either clears the
        // gate (task alive; effect re-runs via deps) or closes the session.
        if (descriptor.pendingValidation) return;
        setStartError(null);
        try {
          fitTerminalSurface(term, fit);

          if (descriptor.ptyId) {
            // Re-attach to a live PTY: subscribe BEFORE replay so any chunk
            // emitted between the calls is queued, not lost.
            let attached = false;
            if (ptyApi) {
              attached = await wireExistingPty(descriptor.ptyId);
            }
            if (attached) return;
          }

          // Pty ids are lost when the tab reloads, but the agent processes
          // survive on the Core. Reattach to a live PTY for this task
          // instead of spawning a duplicate — agents that pin a session id die
          // with "Session ID ... is already in use" when a second copy
          // launches. `findByTask` is answered by the Core the pane is bound
          // to, so this holds across the panel link as well as in-process.
          if (ptyApi) {
            let livePtyId: string | null = null;
            const findByTask = ptyApi.findByTask;
            try {
              livePtyId = (await findByTask(descriptor.taskId)).ptyId;
            } catch {
              /* older main process without findByTask — fall through to spawn */
            }
            if (surface.destroyed) return;
            if (livePtyId && livePtyId !== descriptor.ptyId) {
              const attached = await wireExistingPty(livePtyId);
              if (attached) {
                onPtyReady(livePtyId);
                return;
              }
            }
          }

          const isResume = isHarnessResumeCommand(task.agent, descriptor.startCommand);
          await spawnAndWire(descriptor.startCommand, isResume);
        } catch (err: any) {
          const message = errMsg(err ?? "unknown error");
          clearActivePty();
          setStartError(message);
          setLiveStatus(message);
          term.writeln(`\x1b[31m[failed to start pty: ${message}]\x1b[0m`);
        }
      };

      surface.teardown = () => {
        cancelAnimationFrame(rafHandle);
        settledPtyResize.cancel();
        for (const off of subscriptions) off();
        stopWatchingColorScheme();
        detachLinks();
        detachFileDrop();
        fitRef.current = null;
        gpu.dispose();
        term.dispose();
      };

      cache.set(surface);
      term.focus();
      rafHandle = window.requestAnimationFrame(() => ensurePty());
      detachMount = bindMount(surface);
    })().finally(() => releaseBuildTurn?.());

    return () => {
      cancelled = true;
      detachMount?.();
    };
  }, [descriptor.taskId, descriptor.awaitingCreate, descriptor.pendingValidation, retryNonce]);

  return (
    <>
      <div
        ref={paneRef}
        style={{
          flex: 1,
          minHeight: 120,
          position: "relative",
          display: "flex",
          flexDirection: "column",
          borderBottom: isLast ? "none" : "1px solid var(--border)",
          overflow: "hidden",
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
      {startError && (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "8px 12px",
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
      {/* Session write access (issue 147). Above the header, outside every
          header tier, and never behind the "…" menu: read-only has to be
          visible *before* a keystroke, and a grid cell narrow enough to fold
          its title away is exactly the cell where a hidden one would be
          discovered by typing. Rendered only for a Core that announces
          `multiConnection` — against one that does not there is no lock and no
          arbitration, so there is nothing here to say. */}
      {writeState.lock.supported &&
        (readOnlyReason || writeState.lock.state === "held-by-you") && (
          <div
            data-session-write-access={readOnlyReason ?? "held-by-you"}
            role={readOnlyReason ? "status" : undefined}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "6px 12px",
              borderBottom: "1px solid var(--border)",
              background: readOnlyReason
                ? "color-mix(in oklch, var(--text-dim) 10%, transparent)"
                : "transparent",
              color: "var(--text-dim)",
              fontFamily: "var(--mono)",
              fontSize: 11,
              flexShrink: 0,
            }}
          >
            <span
              style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={readOnlyReason ? readOnlyDetail(readOnlyReason) : undefined}
            >
              {readOnlyReason ? readOnlyLabel(readOnlyReason) : "You hold this Session"}
            </span>
            {/* One affordance per state, and they are not the same gesture. The
                cross-client one is a force takeover behind a confirmation that
                names the Session; the Panel-local one moves this Panel's own
                keyboard and is instant, because it costs nobody anything. */}
            {readOnlyReason === "held-by-another-client" && (
              <Btn
                variant="ghost"
                size="sm"
                disabled={lockBusy}
                onClick={() => setTakeoverOpen(true)}
              >
                Take over…
              </Btn>
            )}
            {readOnlyReason === "driven-in-another-tab" && (
              <Btn
                variant="ghost"
                size="sm"
                onClick={() => {
                  takeSessionDrive(descriptor.coreId, descriptor.taskId);
                  termSurfaceRef.current?.focus();
                }}
              >
                Drive here
              </Btn>
            )}
            {!readOnlyReason && (
              <Btn
                variant="ghost"
                size="sm"
                disabled={lockBusy}
                onClick={() => void releaseSessionLockNow()}
              >
                Release
              </Btn>
            )}
          </div>
        )}
      {!hideHeader && (
      <div
        ref={headerRef}
        data-session-header
        onPointerDown={onHeaderPointerDown}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          background: "transparent",
          borderBottom: "1px solid var(--border)",
          transition: "background 140ms ease, border-color 140ms ease",
          flexShrink: 0,
          userSelect: "none",
          cursor: onHeaderPointerDown ? (headerGrabbing ? "grabbing" : "grab") : undefined,
          touchAction: onHeaderPointerDown ? "none" : undefined,
        }}
      >
        {/* Session icon chip — a miniature of the TaskCard tile. In the tiny
            tier the title text is gone, so the chip is the cell's only identity
            marker (the title moves to its tooltip); below micro it yields the
            last few pixels to the "…" menu.
            Issue 09: the chip doubles as an icon picker. The mutation routes
            through `mutateTaskForCore(coreId, …)` so every Core
            share the same write path (ADR-0005). `descriptor.coreId` is
            null means a row the Panel still owns, so this stays a picker for
            call sites that don't thread a Core through. */}
        {!microHeader && (
          <div
            title={tinyHeader ? liveTask.title : undefined}
            className={sessionRunning ? "mc-session-icon-running" : undefined}
            style={{
              width: 30,
              height: "auto",
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-dim)",
            }}
          >
            <SessionIconPicker
              coreId={descriptor.coreId ?? null}
              taskId={liveTask.id}
              currentIcon={liveTask.icon}
              size={24}
              strokeWidth={1.6}
              animate={sessionRunning}
              ariaLabel={`Change icon for session ${liveTask.title}`}
              onPicked={() => {
                void queryClient.invalidateQueries({ queryKey: tasksKey });
              }}
            />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
          {!tinyHeader && (
            <>
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 11.5,
                  fontWeight: 500,
                  color: "var(--text)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {liveTask.title}
              </div>
              <div
                style={{
                  display: "flex",
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  marginTop: 1,
                }}
              >
                <span style={{ color: statusMeta.color }}>{statusMeta.label}</span>
              </div>
            </>
          )}
        </div>
        <div
          className="mc-pane-header-actions"
          style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}
        >
          {compactHeader ? (
            showMoreMenu ? (
            <HeaderMoreMenu
              title={liveTask.title}
              statusLabel={statusMeta.label}
              statusColor={statusMeta.color}
              showTitle={tinyHeader}
              expanded={expanded}
              onToggleExpanded={tinyHeader ? onToggleExpanded : undefined}
              onHide={microHeader ? onHide : undefined}
              onTogglePin={microHeader ? onTogglePin : undefined}
              pinned={liveTask.pinned}
              pinBusy={pinBusy}
              buttons={sessionButtons}
              onRename={openRenameDialog}
              onClone={requestSessionClone}
              canZoomIn={canZoomIn}
              canZoomOut={canZoomOut}
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
            />
            ) : null
          ) : (
            <>
              {/* Claiming is an explicit gesture and an optional one (ADR 0024
                  D6): an unlocked Session is writable by anybody, so this pane
                  works untouched without it and the button only ever *adds* a
                  guarantee. That is why it lives with the discretionary header
                  controls rather than in the strip above — the strip is for
                  states the operator has to be told about, and "nobody has
                  claimed this" is the ordinary one. */}
              {writeState.lock.supported && writeState.lock.state === "unlocked" && (
                <Tooltip content="Claim this Session — other Core clients become read-only">
                  <Btn
                    variant="ghost"
                    size="sm"
                    icon="shield"
                    disabled={lockBusy}
                    onClick={() => void claimSessionLock()}
                    aria-label={`Claim session ${liveTask.title}`}
                    style={{ width: 34, padding: 0 }}
                  />
                </Tooltip>
              )}
              {sessionButtons.rename && (
                <Tooltip content="Rename session">
                  <Btn
                    variant="ghost"
                    size="sm"
                    icon="pencil"
                    onClick={openRenameDialog}
                    onContextMenu={hideElementContextMenu("session-button:rename")}
                    aria-label={`Rename session ${liveTask.title}`}
                    style={{ width: 34, padding: 0 }}
                  />
                </Tooltip>
              )}
              {sessionButtons.zoom && (
                <span
                  style={{ display: "contents" }}
                  onContextMenu={hideElementContextMenu("session-button:zoom")}
                >
                  <TerminalZoomControls
                    level={zoomLevel}
                    canZoomIn={canZoomIn}
                    canZoomOut={canZoomOut}
                    onZoomIn={zoomIn}
                    onZoomOut={zoomOut}
                  />
                </span>
              )}
              {sessionButtons.clone && (
                <HotkeyTooltip action="session.clone" label="Clone session">
                  <Btn
                    variant="ghost"
                    size="sm"
                    icon="copy"
                    onClick={requestSessionClone}
                    onContextMenu={hideElementContextMenu("session-button:clone")}
                    aria-label="Clone session"
                    style={{ width: 34, padding: 0 }}
                  />
                </HotkeyTooltip>
              )}
            </>
          )}
          {/* Portals to document.body; kept outside the compact-header ternary
              so collapsing the pane mid-open can't strand the menu's state. */}
          {hideableMenu}
          {onTogglePin && !microHeader && (
            <Tooltip content={liveTask.pinned ? "Unpin session" : "Pin session"}>
              <Btn
                variant="ghost"
                size="sm"
                icon={liveTask.pinned ? "pin-fill" : "pin"}
                onClick={onTogglePin}
                disabled={pinBusy}
                aria-busy={pinBusy}
                aria-pressed={liveTask.pinned}
                aria-label={liveTask.pinned ? "Unpin session" : "Pin session"}
                style={{
                  width: 34,
                  padding: 0,
                  color: liveTask.pinned ? "var(--accent)" : undefined,
                }}
              />
            </Tooltip>
          )}
          {onToggleExpanded && !tinyHeader && (
            <HotkeyTooltip
              action="terminal.expandToggle"
              label={expanded ? "Shrink session panel" : "Expand session panel"}
            >
              <Btn
                variant="ghost"
                size="sm"
                icon={expanded ? "minimize" : "maximize"}
                onClick={onToggleExpanded}
                aria-label={expanded ? "Shrink session panel" : "Expand session panel"}
                aria-pressed={expanded}
                style={{ width: 34, padding: 0 }}
              />
            </HotkeyTooltip>
          )}
          {onHide && !microHeader && (
            <HotkeyTooltip action="terminal.close" label="Hide session panel">
              <Btn
                variant="ghost"
                size="sm"
                icon="x"
                onClick={onHide}
                aria-label="Hide session panel"
                style={{ width: 34, padding: 0 }}
              />
            </HotkeyTooltip>
          )}
        </div>
      </div>
      )}
      <div
        data-terminal-body
        style={{
          flex: 1,
          position: "relative",
          // The flat theme repaints this translucent (glass panes over the
          // pattern ground) — see the [data-terminal-body] rule in styles.css.
          background: "var(--terminal-bg)",
        }}
      >
        <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
        {showQuestionOverlay && pendingQuestion && (
          <AskUserQuestionOverlay
            key={pendingQuestion.id}
            pending={pendingQuestion}
            desynced={questionDesynced}
            narrow={tinyHeader}
            terminalOwnedFocus={() =>
              !!paneRef.current && paneRef.current.contains(document.activeElement)
            }
            onSubmitAnswers={submitQuestionAnswers}
            onDismiss={dismissQuestionOverlay}
            onFocusTerminal={dismissQuestionOverlay}
            restoreTerminalFocus={() => termSurfaceRef.current?.focus()}
          />
        )}
      </div>
      </div>
      {/* The force takeover's confirmation (issue 147). It names the Session,
          because a grid of panes makes "are you sure?" genuinely ambiguous
          otherwise — and it says what the operator is doing to somebody else,
          since a takeover is unrecoverable by design (ADR 0024 D7). It does not
          name the holder: the wire never says who that is (D8/D10), and a name
          invented here would be the identity the published lock exists to avoid
          broadcasting. */}
      <ConfirmDialog
        open={takeoverOpen}
        onClose={() => setTakeoverOpen(false)}
        onConfirm={() => void forceTakeoverSessionLock()}
        title={forceTakeoverConfirmation(liveTask.title).title}
        confirmLabel={forceTakeoverConfirmation(liveTask.title).confirmLabel}
        variant="danger"
        icon="shield"
        loading={lockBusy}
      >
        {forceTakeoverConfirmation(liveTask.title).body}
      </ConfirmDialog>
      <Modal
        open={renameOpen}
        onClose={closeRenameDialog}
        title="Rename session"
        width={420}
        footer={
          <>
            <EscTooltip label="Cancel">
              <Btn variant="ghost" onClick={closeRenameDialog} disabled={savingTitle}>
                Cancel
              </Btn>
            </EscTooltip>
            <HotkeyTooltip action="dialog.submit" disabled={!canSaveTitle}>
              <Btn
                variant="primary"
                icon="check"
                type="submit"
                form={renameFormId}
                disabled={!canSaveTitle}
              >
                Rename
              </Btn>
            </HotkeyTooltip>
          </>
        }
      >
        <form
          id={renameFormId}
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSaveTitle) return;
            void commitTitleEdit();
          }}
        >
          <TextField
            label="Session name"
            value={titleDraft}
            onChange={setTitleDraft}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            required
          />
        </form>
      </Modal>
    </>
  );
}

