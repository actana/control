import type { HomeTerminal } from "~/db/schema";
import {
  deleteHomeTerminalRow,
  findHomeTerminalById,
  findHomeTerminals,
  insertHomeTerminal,
  updateHomeTerminalRow,
} from "../repositories/home-terminals.repo";
import { isClientDomainId } from "@actana/shared/client-id";
import { newId } from "./_ids";
import { nextTerminalName } from "./_terminal-names";

export function listHomeTerminals(): HomeTerminal[] {
  return findHomeTerminals();
}

export function createHomeTerminal(input: {
  id?: string;
  name?: string;
}): HomeTerminal {
  const existing = findHomeTerminals();
  const now = Date.now();
  const requestedId = input.id?.trim();
  if (requestedId && !isClientDomainId(requestedId)) throw new Error("invalid terminal id");
  if (requestedId && findHomeTerminalById(requestedId)) throw new Error("terminal id already exists");
  const row: HomeTerminal = {
    id: requestedId || newId("ht"),
    name: input.name?.trim() || nextTerminalName(existing.map((t) => t.name)),
    cwd: null,
    position: existing.length,
    createdAt: now,
    updatedAt: now,
  };
  insertHomeTerminal(row);
  return row;
}

export function renameHomeTerminal(id: string, name: string): HomeTerminal | null {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name is required");
  const existing = findHomeTerminalById(id);
  if (!existing) return null;
  const next: HomeTerminal = { ...existing, name: trimmed, updatedAt: Date.now() };
  updateHomeTerminalRow(id, next);
  return next;
}

export function deleteHomeTerminal(id: string): boolean {
  return deleteHomeTerminalRow(id) > 0;
}
