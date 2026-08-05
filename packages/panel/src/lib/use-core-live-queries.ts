import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getPanelBridge } from "./panel-bridge";
import { queryKeys, tasksCacheKey } from "~/queries";

/**
 * Keep the per-Core shell's queries honest while it is open.
 *
 * The Panel's own SSE stream carries what the Panel's database knows, and for a
 * Core that is nothing: projects, tasks and sessions live on the Core. Their
 * changes arrive as core-link events over the panel link instead, and this is
 * what turns them into cache invalidations — so a task moving to `running` on a
 * VM moves the row on this screen, with nobody pressing refresh.
 *
 * The Core is watched for as long as the shell is mounted; a Core nobody is
 * watching sends this tab nothing.
 */
export function useCoreLiveQueries(coreId: string | null, projectId: string | null): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const bridge = getPanelBridge();
    if (!bridge || !coreId) return;
    const release = bridge.watchCore(coreId);
    const off = bridge.onEvent(({ coreId: owner, event }) => {
      if (owner !== coreId) return;
      if (event.kind.startsWith("project:")) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
        if (projectId) {
          void queryClient.invalidateQueries({
            queryKey: [...queryKeys.project(projectId), "core", coreId],
          });
        }
        return;
      }
      // Task, session and PTY lifecycle all change what `tasksList` returns —
      // status, title, which sessions are live. One invalidation covers them.
      if (
        projectId &&
        (event.kind.startsWith("task:") ||
          event.kind.startsWith("session:") ||
          event.kind.startsWith("pty:"))
      ) {
        void queryClient.invalidateQueries({ queryKey: tasksCacheKey(projectId, coreId) });
        // A task crossing the archived line moves a row between two lists, and
        // the archived one sits in its own bucket (ADR 0019) that no other
        // invalidation reaches. Refetching it also re-reads the count, which
        // rides the tasks answer above.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.coreArchivedTasks(projectId, coreId),
        });
      }
    });
    // A dropped link means a gap the replay may not fully cover; refetch both
    // lists on the way back rather than trusting what is on screen.
    const offConnection = bridge.onConnectionChange((connected) => {
      if (!connected) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      if (projectId) {
        void queryClient.invalidateQueries({ queryKey: tasksCacheKey(projectId, coreId) });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.coreArchivedTasks(projectId, coreId),
        });
      }
    });
    return () => {
      off();
      offConnection();
      release();
    };
  }, [queryClient, coreId, projectId]);
}
