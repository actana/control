import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { CardFrame } from "~/components/ui/CardFrame";
import { Btn } from "~/components/ui/Btn";
import { EmptyState } from "~/components/ui/EmptyState";
import { GridViewToggleIcon } from "~/components/ui/GridViewToggleIcon";
import { CoreHeader, type CoreTab } from "~/components/views/CoreHeader";
import { CoreNeedsUpdateNotice } from "~/components/views/CoreNeedsUpdate";
import { FleetSessionRow } from "~/components/views/FleetSessionRow";
import { FilesDrive } from "~/components/views/FilesDrive";
import { TasksBoard } from "~/components/views/TasksBoard";
import { NewHarnessDialog } from "~/components/views/NewHarnessDialog";
import { useFleet } from "~/lib/fleet-context";
import { getPanelBridge } from "~/lib/panel-bridge";
import { useUserTerminals } from "~/lib/user-terminal-store";
import { readCoreRemember, writeCoreRemember } from "~/lib/core-remember";
import {
  readCoreSessionsView,
  writeCoreSessionsView,
  type CoreSessionsView,
} from "~/lib/core-sessions-view";
import { setSelectedCoreId } from "~/lib/selected-core-store";
import { mutateSessionForCore } from "~/lib/mutate-session-for-core";
import { TITLE_WAITING } from "~/lib/session-sentinels";
import { newClientId } from "@actana/shared/client-id";
import { setPendingInitialInput } from "~/lib/pending-initial-input";
import { availabilityFor, useCliAvailability } from "~/lib/cli-availability";
import { appendOptimisticSession } from "~/lib/optimistic-session";
import { remoteSessionFromSnapshot, sessionsCacheKey } from "~/queries";
import { requestSessionOpen } from "~/lib/session-notification-store";
import { formatRelativeTime } from "~/lib/format-relative-time";
import type { Harness } from "@actana/shared/domain";

/**
 * A Core's page (screen 02): header, then one of three tabs. Sessions lists
 * this Core's harness Sessions with a grid/list toggle under the Core header
 * (issue 560); Files is the Shared folder Drive (#565), its open folder in
 * `?path=`; Tasks is the Tasks board filtered to this Core (#571). The Terminal
 * is the bottom drawer the shell already owns. New Session is prompt-first
 * (issue 560, screen 03).
 */
export function CorePage({ coreId, tab, path = "" }: { coreId: string; tab: CoreTab; path?: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const cliAvailability = useCliAvailability(coreId);
  const { cores, fleet, loading, coresLoading } = useFleet();
  const { togglePanel, panelOpen } = useUserTerminals();
  const [showNew, setShowNew] = useState(false);
  const [rememberTick, setRememberTick] = useState(0);
  const [sessionsView, setSessionsViewState] = useState<CoreSessionsView>(() =>
    readCoreSessionsView(coreId),
  );
  // Rail / hotkeys / links change `coreId` without the header switcher. Keep
  // the view in sync with this Core's stored choice even if the route forgot
  // to remount (keyed in cores.$coreId.tsx; this effect is the belt).
  useEffect(() => {
    setSessionsViewState(readCoreSessionsView(coreId));
    setSelectedCoreId(coreId);
  }, [coreId]);
  const core = cores.find((c) => c.id === coreId);
  const rows = useMemo(() => fleet.rows.filter((r) => r.coreId === coreId), [fleet.rows, coreId]);
  const remembered = useMemo(() => {
    void rememberTick;
    return readCoreRemember(coreId);
  }, [coreId, rememberTick]);

  const setSessionsView = useCallback(
    (next: CoreSessionsView) => {
      setSessionsViewState(next);
      writeCoreSessionsView(coreId, next);
    },
    [coreId],
  );

  const setTab = useCallback(
    (next: CoreTab) => {
      void router.navigate({ to: "/cores/$coreId", params: { coreId }, search: { tab: next } });
    },
    [router, coreId],
  );
  const setPath = useCallback(
    (next: string) => {
      void router.navigate({ to: "/cores/$coreId", params: { coreId }, search: { tab: "files", ...(next ? { path: next } : {}) } });
    },
    [router, coreId],
  );
  const switchCore = useCallback(
    (next: string) => {
      void router.navigate({ to: "/cores/$coreId", params: { coreId: next }, search: { tab } });
    },
    [router, tab],
  );
  // The workspace opens the named Session (spawning it if it has no terminal
  // yet); without an id it just opens the workspace.
  const openWorkspace = useCallback(
    (sessionId?: string) => {
      if (sessionId) requestSessionOpen(coreId, sessionId);
      void router.navigate({ to: "/cores/$coreId/workspace", params: { coreId } });
    },
    [router, coreId],
  );

  const startSession = useCallback(
    async (agent: Harness, prompt: string) => {
      if (!getPanelBridge()) {
        toast.error("Not connected to the Panel.");
        return;
      }
      const sessionId = newClientId("t");
      try {
        const snapshot = await mutateSessionForCore(coreId, {
          op: "create",
          sessionId,
          title: TITLE_WAITING,
          agent,
        });
        if (!snapshot) throw new Error("Core did not return a session snapshot");
        // The workspace finds the Session in its list, so put it there first.
        appendOptimisticSession(queryClient, coreId, remoteSessionFromSnapshot(snapshot));
        void queryClient.invalidateQueries({ queryKey: sessionsCacheKey(coreId) });
        // The pane consumes the prompt once, at the Session's first spawn.
        if (prompt.trim()) setPendingInitialInput(snapshot.sessionId, prompt.trim());
        setShowNew(false);
        openWorkspace(snapshot.sessionId);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [coreId, openWorkspace, queryClient],
  );

  const openNewSessionDialog = useCallback(() => {
    if (remembered.rememberHarnessSettings && remembered.savedHarness) {
      // Only a harness this Core can run starts without asking; otherwise the
      // dialog shows what is missing.
      if (availabilityFor(cliAvailability, remembered.savedHarness).status === "available") {
        void startSession(remembered.savedHarness, "");
        return;
      }
    }
    setShowNew(true);
  }, [remembered, startSession, cliAvailability]);

  // Opened directly, the Core list is still on its way: it is not "not found"
  // until the list has settled and really lacks this Core.
  if (!core && coresLoading) {
    return <EmptyState title="Loading Core" subtitle="Fetching this Panel's Cores." icon="shield" />;
  }

  if (!core) {
    return (
      <EmptyState
        title="Core not found"
        subtitle="This Core is not registered with this Panel."
        icon="shield"
        action={
          <Btn variant="primary" onClick={() => void router.navigate({ to: "/" })}>
            Back to Fleet
          </Btn>
        }
      />
    );
  }

  const sessionsToolbar =
    tab === "sessions" && core.dial.state !== "needs-update" ? (
      <div
        data-sessions-toolbar
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 6,
          marginBottom: 12,
        }}
      >
        <Btn
          variant="ghost"
          aria-label="Grid view"
          aria-pressed={sessionsView === "grid"}
          onClick={() => setSessionsView("grid")}
          style={{
            width: 36,
            minWidth: 36,
            paddingInline: 0,
            background: sessionsView === "grid" ? "var(--surface-2)" : undefined,
            color: sessionsView === "grid" ? "var(--text)" : undefined,
          }}
        >
          <GridViewToggleIcon gridView={false} />
        </Btn>
        <Btn
          variant="ghost"
          aria-label="List view"
          aria-pressed={sessionsView === "list"}
          onClick={() => setSessionsView("list")}
          style={{
            width: 36,
            minWidth: 36,
            paddingInline: 0,
            background: sessionsView === "list" ? "var(--surface-2)" : undefined,
            color: sessionsView === "list" ? "var(--text)" : undefined,
          }}
        >
          <GridViewToggleIcon gridView />
        </Btn>
        {rows.length > 0 && (
          <Btn variant="primary" icon="plus" onClick={() => void openNewSessionDialog()}>
            New session
          </Btn>
        )}
      </div>
    ) : null;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <CoreHeader
        core={core}
        cores={cores}
        tab={tab}
        onTab={setTab}
        onSwitchCore={switchCore}
        onToggleTerminal={togglePanel}
        terminalOpen={panelOpen}
      />
      <CardFrame style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16, border: 0 }}>
        {tab === "sessions" ? (
          core.dial.state === "needs-update" ? (
            <CoreNeedsUpdateNotice dial={core.dial} />
          ) : rows.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {sessionsToolbar}
              {sessionsView === "grid" ? (
                <div
                  data-sessions-grid
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                    gap: 10,
                  }}
                >
                  {rows.map((row) => (
                    <button
                      key={row.sessionId}
                      type="button"
                      onClick={() => openWorkspace(row.sessionId)}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                        padding: "14px 16px",
                        background: "var(--surface-0)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        cursor: "pointer",
                        textAlign: "left",
                        minHeight: 110,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          fontFamily: "var(--mono)",
                          fontSize: 11,
                          color: "var(--text-dim)",
                        }}
                      >
                        <SessionStatusDot status={row.status} />
                        <span style={{ textTransform: "capitalize" }}>{row.status}</span>
                        <span style={{ marginLeft: "auto" }}>{row.agent}</span>
                      </div>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: "var(--text)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                        }}
                      >
                        {row.title}
                      </div>
                      <div
                        style={{
                          marginTop: "auto",
                          fontFamily: "var(--mono)",
                          fontSize: 11,
                          color: "var(--text-faint)",
                        }}
                      >
                        {formatRelativeTime(row.updatedAt)}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div data-sessions-list style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {rows.map((row) => (
                    <FleetSessionRow
                      key={row.sessionId}
                      row={row}
                      onOpen={() => openWorkspace(row.sessionId)}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              {sessionsToolbar}
              <EmptyState
                title={loading ? "Loading Sessions" : "No Sessions yet"}
                subtitle={
                  core.dial.state === "connected"
                    ? "Start a Session on this Core."
                    : "This Core is not reachable, so there is nothing to show."
                }
                icon="terminal"
                action={
                  core.dial.state === "connected" ? (
                    <Btn variant="primary" icon="plus" onClick={() => void openNewSessionDialog()}>
                      New session
                    </Btn>
                  ) : undefined
                }
              />
            </>
          )
        ) : tab === "files" ? (
          <FilesDrive core={core} path={path} onPath={setPath} />
        ) : (
          <TasksBoard coreId={coreId} />
        )}
      </CardFrame>

      <NewHarnessDialog
        open={showNew}
        coreId={coreId}
        coreLabel={core.label}
        initialRemember={remembered}
        onClose={() => setShowNew(false)}
        onStart={(data) => void startSession(data.agent, data.prompt)}
        onPersistRemember={(patch) => {
          writeCoreRemember(coreId, patch);
          setRememberTick((n) => n + 1);
        }}
      />
    </div>
  );
}

function SessionStatusDot({ status }: { status: string }) {
  const color =
    status === "running"
      ? "var(--accent)"
      : status === "needs-input"
        ? "var(--warning, #f5a524)"
        : status === "done"
          ? "var(--text-faint)"
          : "var(--text-dim)";
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }}
    />
  );
}
