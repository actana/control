import type { HomeTerminal, UserTerminal } from "~/db/schema";
import {
  deleteHomeTerminalRow,
  findHomeTerminalById,
  findHomeTerminals,
  insertHomeTerminal,
  toUserTerminal,
  updateHomeTerminalRow,
} from "../repositories/home-terminals.repo";
import { isClientDomainId } from "@actana/shared/client-id";
import { newId } from "./_ids";
import { nextTerminalName } from "./_terminal-names";

export function listHomeTerminals(): UserTerminal[] {
  return findHomeTerminals().map(toUserTerminal);
}

export function createHomeTerminal(input: {
  id?: string;
  name?: string;
  cwd?: string | null;
}): UserTerminal {
  const existing = findHomeTerminals();
  const now = Date.now();
  const requestedId = input.id?.trim();
  if (requestedId && !isClientDomainId(requestedId)) throw new Error("invalid terminal id");
  if (requestedId && findHomeTerminalById(requestedId)) throw new Error("terminal id already exists");
  const row: HomeTerminal = {
    id: requestedId || newId("ht"),
    name: input.name?.trim() || nextTerminalName(existing.map((t) => t.name)),
    cwd: input.cwd ?? null,
    position: existing.length,
    createdAt: now,
    updatedAt: now,
  };
  insertHomeTerminal(row);
  return toUserTerminal(row);
}

export function renameHomeTerminal(id: string, name: string): UserTerminal | null {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name is required");
  const existing = findHomeTerminalById(id);
  if (!existing) return null;
  const next: HomeTerminal = { ...existing, name: trimmed, updatedAt: Date.now() };
  updateHomeTerminalRow(id, next);
  return toUserTerminal(next);
}

export function deleteHomeTerminal(id: string): boolean {
  return deleteHomeTerminalRow(id) > 0;
}
