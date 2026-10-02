import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { CardFrame } from "~/components/ui/CardFrame";
import { Btn } from "~/components/ui/Btn";
import { EmptyState } from "~/components/ui/EmptyState";
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
import { mutateSessionForCore } from "~/lib/mutate-session-for-core";
import { TITLE_WAITING } from "~/lib/session-sentinels";
import { newClientId } from "@actana/shared/client-id";
import { setPendingInitialInput } from "~/lib/pending-initial-input";
import { availabilityFor, useCliAvailability } from "~/lib/cli-availability";
import { appendOptimisticSession } from "~/lib/optimistic-session";
import { remoteSessionFromSnapshot, sessionsCacheKey } from "~/queries";
import { requestSessionOpen } from "~/lib/session-notification-store";
import type { Harness } from "@actana/shared/domain";

/**
 * A Core's page (screen 02): header, then one of three tabs. Sessions lists
 * this Core's harness Sessions; Files is the Shared folder Drive (#565), its open folder in `?path=`; Tasks is the
 * Tasks board filtered to this Core (#571). The Terminal is the bottom drawer the shell already owns.
 * New Session is prompt-first (issue 560, screen 03).
 */
export function CorePage({ coreId, tab, path = "" }: { coreId: string; tab: CoreTab; path?: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const cliAvailability = useCliAvailability(coreId);
  const { cores, fleet, loading } = useFleet();
  const { togglePanel, panelOpen } = useUserTerminals();
  const [showNew, setShowNew] = useState(false);
  const [rememberTick, setRememberTick] = useState(0);
  const core = cores.find((c) => c.id === coreId);
  const rows = useMemo(() => fleet.rows.filter((r) => r.coreId === coreId), [fleet.rows, coreId]);
  const remembered = useMemo(() => {
    void rememberTick;
    return readCoreRemember(coreId);
  }, [coreId, rememberTick]);

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
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                <Btn variant="primary" icon="plus" onClick={() => void openNewSessionDialog()}>
                  New session
                </Btn>
              </div>
              {rows.map((row) => (
                <FleetSessionRow
                  key={row.sessionId}
                  row={row}
                  onOpen={() => openWorkspace(row.sessionId)}
                />
              ))}
            </div>
          ) : (
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
