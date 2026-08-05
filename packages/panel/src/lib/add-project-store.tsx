import { createContext, useCallback, useContext, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ProjectDialog } from "~/components/views/ProjectDialog";
import { api } from "~/lib/api";
import { isGroupIdActive, useActiveGroup } from "~/lib/active-group";
import { useCores } from "~/lib/use-fleet";
import { mutateProjectForCore } from "~/lib/mutate-project-for-core";
import {
  setSelectedCoreId,
  useSelectedCoreId,
} from "~/lib/selected-core-store";
import { useHotkey, isEditableTarget } from "~/lib/use-hotkey";
import {
  groupsQueryOptions,
  queryKeys,
  useGroups,
} from "~/queries";
import type { Group } from "~/db/schema";

type Ctx = {
  open: () => void;
  close: () => void;
  isOpen: boolean;
};

const AddProjectContext = createContext<Ctx | null>(null);

export function AddProjectProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [initialPath, setInitialPath] = useState("");
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: groups = [] } = useGroups();
  const { activeGroup } = useActiveGroup();
  const { cores } = useCores();
  const selectedCoreId = useSelectedCoreId();

  // Straight into the dialog — the working-directory field hosts an inline
  // folder browser, so the flow no longer detours through the OS dialog.
  const open = useCallback(() => {
    setInitialPath("");
    void queryClient.ensureQueryData(groupsQueryOptions());
    setIsOpen(true);
  }, [queryClient]);
  const close = useCallback(() => {
    setIsOpen(false);
    setInitialPath("");
  }, []);
  const createGroupForSelection = useCallback(
    async (name: string) => {
      const { group } = await api.createGroup({ name });
      queryClient.setQueryData<Group[]>(queryKeys.groups, (current) =>
        current ? [...current, group] : [group],
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      return group;
    },
    [queryClient],
  );

  useHotkey(
    "project.add",
    (e) => {
      if (isEditableTarget(e.target)) return;
      open();
    },
    { preventDefault: true },
  );

  return (
    <AddProjectContext.Provider value={{ open, close, isOpen }}>
      {children}
      <ProjectDialog
        open={isOpen}
        project={null}
        initialPath={initialPath}
        // New projects land in the active group by default — the dialog's
        // Group field stays editable to override.
        initialGroupId={isGroupIdActive(activeGroup) ? activeGroup : null}
        groups={groups}
        // A single-Core setup hides the selector — the dialog only renders it
        // when cores.length > 1.
        cores={cores}
        // Default to the Core the operator last worked with, but never to one
        // that is no longer registered — a stale id would address a Core that
        // cannot answer.
        initialCoreId={
          (cores.some((c) => c.id === selectedCoreId) ? selectedCoreId : cores[0]?.id) ?? ""
        }
        onClose={close}
        onCreateGroup={createGroupForSelection}
        onSave={async (data) => {
          const { coreId: targetCoreId, ...createBody } = data;
          // Every project belongs to a Core, and only that Core can create it:
          // the path is a path on its machine, and its Core owns the row
          // (ADR 0004). There is no Panel-side project table to fall back on.
          const coreId = targetCoreId || selectedCoreId;
          if (!coreId) {
            throw new Error("Add a Core before adding a project.");
          }
          // Remember the last Core the user chose so the next Add Project (from
          // the sidebar hotkey or any other entry point) defaults to it. Fleet
          // views also stay in sync via the shared selected-core store.
          setSelectedCoreId(coreId);

          // Default the name to the path's basename so a user who left it blank
          // still passes the Core's non-empty-name check.
          const inferredName =
            createBody.name?.trim() ||
            createBody.path.split(/[\\/]/).filter(Boolean).pop() ||
            "";
          // Throws on an unreachable Core, a failed auth, or a path that
          // machine rejects — the dialog's error box paints the message the
          // Core wrote. Nothing is persisted Panel-side either way.
          const created = await mutateProjectForCore(coreId, {
            op: "create",
            name: inferredName,
            path: createBody.path,
            icon: createBody.icon,
            iconColor: createBody.iconColor,
            pinned: createBody.pinned,
            // "Start with →" is a remembered setting, not a one-shot: without
            // these the created project auto-starts and then re-opens the New
            // session dialog asking for the Harness that was just picked, and
            // the grid-view default is lost after the first navigation
            // (issue 22).
            savedHarness: createBody.savedHarness ?? null,
            rememberHarnessSettings: createBody.rememberHarnessSettings,
            defaultGridView: createBody.defaultGridView,
          });
          // A Core that answers without a row wrote nothing — closing the
          // dialog on that would show a project that does not exist.
          if (!created) throw new Error("The Core did not create the project.");
          // The Core's `project:created` event reaches every tab watching
          // this Core over the panel link, which is what refreshes the lists.
          close();
          void router.navigate({ to: "/fleet" });
        }}
      />
    </AddProjectContext.Provider>
  );
}

export function useAddProject(): Ctx {
  const ctx = useContext(AddProjectContext);
  if (!ctx) throw new Error("useAddProject must be used within AddProjectProvider");
  return ctx;
}
