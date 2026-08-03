import type { UserTerminal } from "~/db/schema";
import {
  deleteUserTerminalRow,
  findUserTerminalById,
  findVisibleUserTerminalsByProject,
  insertUserTerminal,
  updateUserTerminalRow,
} from "../repositories/user-terminals.repo";
import { isClientDomainId } from "@actana/shared/client-id";
import { projectExists } from "../repositories/projects.repo";
import { newId } from "./_ids";
import { nextTerminalName } from "./_terminal-names";

/** Pick the lowest unused "Terminal N" name across the whole project. */
export function nextDefaultTerminalName(projectId: string): string {
  const names = findVisibleUserTerminalsByProject(projectId).map((t) => t.name);
  return nextTerminalName(names);
}

export function listUserTerminals(projectId: string): UserTerminal[] {
  return findVisibleUserTerminalsByProject(projectId);
}

export function createUserTerminal(input: {
  id?: string;
  projectId: string;
  name?: string;
  cwd?: string | null;
  startCommand?: string | null;
}): UserTerminal {
  if (!projectExists(input.projectId)) throw new Error("Project does not exist");

  const existing = listUserTerminals(input.projectId);
  const now = Date.now();
  const requestedId = input.id?.trim();
  if (requestedId && !isClientDomainId(requestedId)) throw new Error("invalid terminal id");
  if (requestedId && findUserTerminalById(requestedId)) throw new Error("terminal id already exists");
  const row: UserTerminal = {
    id: requestedId || newId("ut"),
    projectId: input.projectId,
    name: input.name?.trim() || nextDefaultTerminalName(input.projectId),
    cwd: input.cwd ?? null,
    startCommand: input.startCommand?.trim() || null,
    position: existing.length,
    createdAt: now,
    updatedAt: now,
  };
  if (row.startCommand) {
    return row;
  }
  insertUserTerminal(row);
  return row;
}

export function renameUserTerminal(id: string, name: string): UserTerminal | null {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name is required");
  const existing = findUserTerminalById(id);
  if (!existing) return null;
  const next = { ...existing, name: trimmed, updatedAt: Date.now() };
  updateUserTerminalRow(id, next);
  return next;
}

export function deleteUserTerminal(id: string): boolean {
  return deleteUserTerminalRow(id) > 0;
}
