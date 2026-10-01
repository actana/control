import { useCallback, useEffect, useMemo } from "react";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { CardFrame } from "~/components/ui/CardFrame";
import { Btn } from "~/components/ui/Btn";
import { EmptyState } from "~/components/ui/EmptyState";
import { CoreHeader, type CoreTab } from "~/components/views/CoreHeader";
import { CoreNeedsUpdateNotice } from "~/components/views/CoreNeedsUpdate";
import { FleetSessionRow } from "~/components/views/FleetSessionRow";
import { useFleet } from "~/lib/fleet-context";
import { getPanelBridge } from "~/lib/panel-bridge";
import { useUserTerminals } from "~/lib/user-terminal-store";

/**
 * A Core's page (screen 02): header, then one of three tabs. Sessions lists
 * this Core's harness Sessions; Files and Tasks are placeholders until #565
 * and #571 land. The Terminal is the bottom drawer the shell already owns.
 */
export function CorePage({ coreId, tab }: { coreId: string; tab: CoreTab }) {
  const router = useRouter();
  const { cores, fleet, loading } = useFleet();
  const { togglePanel, panelOpen, setHomeActive } = useUserTerminals();
  // The drawer is scoped to a project or to "home". A Core page has no project,
  // so it claims the home scope while it is mounted; without it the drawer has
  // no scope and neither the header icon nor ctrl+` would open anything.
  useEffect(() => {
    setHomeActive(true);
    return () => setHomeActive(false);
  }, [setHomeActive]);
  const core = cores.find((c) => c.id === coreId);
  const rows = useMemo(() => fleet.rows.filter((r) => r.coreId === coreId), [fleet.rows, coreId]);

  const setTab = useCallback(
    (next: CoreTab) => {
      void router.navigate({ to: "/cores/$coreId", params: { coreId }, search: { tab: next } });
    },
    [router, coreId],
  );
  const switchCore = useCallback(
    (next: string) => {
      void router.navigate({ to: "/cores/$coreId", params: { coreId: next }, search: { tab } });
    },
    [router, tab],
  );
  // A Session opens in the session workspace, which is still addressed by the
  // project the Session was started in until #555 removes Projects from the Core.
  const openSession = useCallback(
    (projectId: string) => {
      void router.navigate({ to: "/projects/$id", params: { id: projectId }, search: { coreId } });
    },
    [router, coreId],
  );
  // No Session yet means no project to open: until New Session is prompt-first
  // (PR 2), start from the Core's first project.
  const newSession = useCallback(async () => {
    const bridge = getPanelBridge();
    if (!bridge) return;
    try {
      const first = (await bridge.listProjects(coreId))[0];
      if (first) openSession(first.projectId);
      else toast.error("This Core has nowhere to start a Session yet.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [coreId, openSession]);

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
              {rows.map((row) => (
                <FleetSessionRow
                  key={row.sessionId}
                  row={row}
                  onOpen={() => openSession(row.projectId)}
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
                  <Btn variant="primary" icon="plus" onClick={() => void newSession()}>
                    New session
                  </Btn>
                ) : undefined
              }
            />
          )
        ) : tab === "files" ? (
          <EmptyState
            title="Files"
            subtitle="The Shared folder Drive lands with #565."
            icon="folder"
          />
        ) : (
          <EmptyState
            title="Tasks"
            subtitle="The Tasks board for this Core lands with #571."
            icon="check"
          />
        )}
      </CardFrame>
    </div>
  );
}
