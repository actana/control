import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerEventsReconnect } from "~/lib/use-events";
import { queryKeys } from "~/queries";

/**
 * Re-read what the Panel's SSE stream feeds, every time that stream comes back
 * after dropping.
 *
 * The stream is fire-and-forget: no cursor, no `Last-Event-ID`, no replay
 * buffer behind `/api/events`. A Session that finishes while the socket is
 * down — a backgrounded tab whose connection the browser or a proxy reaped, a
 * Panel restart, a sleeping laptop — emits its `task:updated` into a stream
 * nobody is reading, and nothing ever mentions it again. The row keeps the last
 * status this tab happened to hear (issue 484, symptom W2).
 *
 * Nothing here tries to recover the missed events. It marks what they would
 * have touched as stale, which is the same bargain `useCoreLiveQueries` makes
 * for a dropped core-link: after a gap, ask again rather than trust the screen.
 *
 * `["projects"]` is a prefix, not an exact key, so one invalidation reaches the
 * projects list, every project row (Panel-owned and Core-tagged alike) and
 * every task-list bucket under them — see `queryKeys` and `tasksCacheKey`. The
 * archived buckets sit deliberately outside that tree, so they are named.
 */
export function useEventStreamReconcile(): void {
  const queryClient = useQueryClient();
  useServerEventsReconnect(
    useCallback(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      void queryClient.invalidateQueries({ queryKey: queryKeys.coreArchivedTasksAll });
    }, [queryClient]),
  );
}
