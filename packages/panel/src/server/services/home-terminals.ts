import type { HomeTerminal } from "~/db/schema";
import {
  deleteHomeTerminalRow,
  findHomeTerminalById,
  findHomeTerminals,
  insertHomeTerminal,
  updateHomeTerminalRow,
  type HomeTerminalRow,
} from "../repositories/home-terminals.repo";
import { isClientDomainId } from "@actana/shared/client-id";
import { newId } from "./_ids";
import { nextTerminalName } from "./_terminal-names";
import { OPERATOR_ID } from "./operator";

export async function listHomeTerminals(ownerId = OPERATOR_ID): Promise<HomeTerminal[]> {
  return findHomeTerminals(ownerId);
}

export async function createHomeTerminal(
  input: { id?: string; name?: string },
  ownerId = OPERATOR_ID,
): Promise<HomeTerminal> {
  const existing = await findHomeTerminals(ownerId);
  const now = Date.now();
  const requestedId = input.id?.trim();
  if (requestedId && !isClientDomainId(requestedId)) throw new Error("invalid terminal id");
  if (requestedId && (await findHomeTerminalById(ownerId, requestedId))) {
    throw new Error("terminal id already exists");
  }
  const row: HomeTerminalRow = {
    id: requestedId || newId("ht"),
    ownerId,
    name: input.name?.trim() || nextTerminalName(existing.map((t) => t.name)),
    cwd: null,
    position: existing.length,
    createdAt: now,
    updatedAt: now,
  };
  await insertHomeTerminal(row);
  return row;
}

export async function renameHomeTerminal(
  id: string,
  name: string,
  ownerId = OPERATOR_ID,
): Promise<HomeTerminal | null> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name is required");
  const existing = await findHomeTerminalById(ownerId, id);
  if (!existing) return null;
  const next: HomeTerminalRow = { ...existing, name: trimmed, updatedAt: Date.now() };
  await updateHomeTerminalRow(ownerId, id, next);
  return next;
}

export async function deleteHomeTerminal(id: string, ownerId = OPERATOR_ID): Promise<boolean> {
  return (await deleteHomeTerminalRow(ownerId, id)) > 0;
}
