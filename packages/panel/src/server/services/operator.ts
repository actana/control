import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getPanelDb } from "../panel-db";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "~/shared/operator-password";

/** The Operator: the single identity that owns this Panel and its Cores. */
export type Operator = {
  id: number;
  name: string;
  createdAt: number;
  passwordChangedAt: number;
};

const MAX_NAME_LENGTH = 120;

const OPERATOR_ID = 1;

// scrypt with the parameters RFC 9106-era guidance calls interactive-login
// grade: ~32 MB of memory per attempt, which is what makes an offline attack on
// a stolen panel.db expensive. Node ships it, so the Panel gains no native dep.
const SCRYPT_COST = 2 ** 15;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 64;
const SALT_BYTES = 16;
// scryptSync enforces a memory ceiling well below what N=2^15 needs.
const SCRYPT_MAX_MEMORY = 256 * SCRYPT_COST * SCRYPT_BLOCK_SIZE;

export class PasswordPolicyError extends Error {
  readonly expose = true;
  constructor(message: string) {
    super(message);
    this.name = "PasswordPolicyError";
  }
}

export class OperatorExistsError extends Error {
  constructor() {
    super("an Operator already exists");
    this.name = "OperatorExistsError";
  }
}

type OperatorRow = {
  id: number;
  name: string;
  password_hash: string;
  created_at: number;
  password_changed_at: number;
};

function rowToOperator(row: OperatorRow): Operator {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    passwordChangedAt: row.password_changed_at,
  };
}

function readRow(): OperatorRow | null {
  return (
    (getPanelDb()
      .prepare("SELECT * FROM operator WHERE id = ?")
      .get(OPERATOR_ID) as OperatorRow | undefined) ?? null
  );
}

export function getOperator(): Operator | null {
  const row = readRow();
  return row ? rowToOperator(row) : null;
}

export function operatorExists(): boolean {
  return readRow() !== null;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password.normalize("NFKC"), salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  return [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/**
 * Verify a password against a stored hash. Reads the KDF parameters back out of
 * the hash so raising them later leaves existing Operators able to log in.
 */
export function verifyPasswordHash(password: string, stored: string): boolean {
  const [scheme, cost, blockSize, parallelization, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const N = Number(cost);
  const r = Number(blockSize);
  const p = Number(parallelization);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const expectedBytes = Buffer.from(expected, "base64");
  let derived: Buffer;
  try {
    derived = scryptSync(password.normalize("NFKC"), Buffer.from(salt, "base64"), expectedBytes.length, {
      N,
      r,
      p,
      maxmem: 256 * N * r,
    });
  } catch {
    return false;
  }
  return timingSafeEqual(derived, expectedBytes);
}

function assertPasswordPolicy(password: unknown): string {
  if (typeof password !== "string") throw new PasswordPolicyError("password is required");
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(`password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  return password;
}

function normalizeName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) return "Operator";
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

/** Create the one Operator. Throws OperatorExistsError if first boot is over. */
export function createOperator(input: { name?: unknown; password: unknown }): Operator {
  const password = assertPasswordPolicy(input.password);
  const name = normalizeName(input.name);
  const now = Date.now();
  const result = getPanelDb()
    .prepare(
      `INSERT INTO operator (id, name, password_hash, created_at, password_changed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(OPERATOR_ID, name, hashPassword(password), now, now);
  if (result.changes === 0) throw new OperatorExistsError();
  return { id: OPERATOR_ID, name, createdAt: now, passwordChangedAt: now };
}

export function verifyOperatorPassword(password: unknown): boolean {
  const row = readRow();
  if (!row || typeof password !== "string") return false;
  return verifyPasswordHash(password, row.password_hash);
}

/**
 * Replace the Operator's password. Callers are responsible for revoking
 * sessions — see auth.controller, which revokes every one of them.
 */
export function setOperatorPassword(password: unknown): void {
  const next = assertPasswordPolicy(password);
  const now = Date.now();
  getPanelDb()
    .prepare("UPDATE operator SET password_hash = ?, password_changed_at = ? WHERE id = ?")
    .run(hashPassword(next), now, OPERATOR_ID);
}

export { OPERATOR_ID };
