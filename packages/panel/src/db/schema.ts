/**
 * Panel Session / terminal row shapes for the renderer and services.
 *
 * The tables themselves live in Postgres (`pg-schema.ts`, #567 PR 5). This
 * file holds only TypeScript types so the UI can import them without touching
 * the repository-only pg schema. `ownerId` is on every row (ADR 0041 D15).
 */
import {
  DEFAULT_BRANCH,
  DEFAULT_SESSION_STATUS,
  HARNESSES,
  SESSION_STATUSES,
  isActiveStatus,
  isTerminalStatus,
  type Harness,
  type SessionStatus,
} from "@actana/shared/domain";

export type Session = {
  id: string;
  /** Present on rows from Postgres; optional on optimistic client fixtures. */
  ownerId?: number;
  title: string;
  titleManuallySet: boolean;
  icon: string | null;
  agent: Harness;
  status: SessionStatus;
  branch: string;
  preview: string;
  lines: number;
  archived: boolean;
  pinned: boolean;
  claudeSessionId: string | null;
  claudeSkipPermissions: boolean;
  claudeBareSession: boolean;
  createdAt: number;
  updatedAt: number;
};

export type NewSession = Omit<Session, "ownerId"> & { ownerId?: number };

export type HomeTerminal = {
  id: string;
  /** Present on rows from Postgres; optional on optimistic client fixtures. */
  ownerId?: number;
  name: string;
  cwd: string | null;
  position: number;
  createdAt: number;
  updatedAt: number;
};

export type NewHomeTerminal = Omit<HomeTerminal, "ownerId"> & { ownerId?: number };

/** A terminal as the renderer sees one: a `home_terminals` row. */
export type UserTerminal = HomeTerminal;

export type EventLogRow = {
  eventId: number;
  ownerId: number;
  ts: number;
  kind: string;
  ptyId: string | null;
  sessionId: string | null;
  payload: string;
};

export {
  DEFAULT_BRANCH,
  DEFAULT_SESSION_STATUS,
  HARNESSES,
  SESSION_STATUSES,
  isActiveStatus,
  isTerminalStatus,
};
export type { Harness, SessionStatus };
