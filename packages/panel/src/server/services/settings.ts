import { randomBytes } from "node:crypto";
import {
  deleteAppSetting,
  getAppSetting,
  setAppSetting,
} from "../repositories/app-settings.repo";
import { safeJsonParse } from "@actana/shared/safe-json";
import { OPERATOR_ID } from "./operator";

export async function getSetting(key: string, ownerId = OPERATOR_ID): Promise<string | null> {
  return getAppSetting(ownerId, key);
}

export async function setSetting(key: string, value: string, ownerId = OPERATOR_ID): Promise<void> {
  await setAppSetting(ownerId, key, value);
}

export async function deleteSetting(key: string, ownerId = OPERATOR_ID): Promise<void> {
  await deleteAppSetting(ownerId, key);
}

export async function getBooleanSetting(
  key: string,
  defaultValue = false,
  ownerId = OPERATOR_ID,
): Promise<boolean> {
  const value = await getAppSetting(ownerId, key);
  if (value === null) return defaultValue;
  return value === "true";
}

export async function setBooleanSetting(
  key: string,
  value: boolean,
  ownerId = OPERATOR_ID,
): Promise<void> {
  await setAppSetting(ownerId, key, value ? "true" : "false");
}

export async function readJsonSetting<T>(key: string, ownerId = OPERATOR_ID): Promise<T | null> {
  return safeJsonParse<T | null>(await getAppSetting(ownerId, key), null);
}

const API_TOKEN_KEY = "api_token";
const AUTH_SECRET_KEY = "auth_secret";

export async function getOrCreateApiToken(ownerId = OPERATOR_ID): Promise<string> {
  let token = await getAppSetting(ownerId, API_TOKEN_KEY);
  if (!token) {
    token = randomBytes(32).toString("hex");
    await setAppSetting(ownerId, API_TOKEN_KEY, token);
  }
  return token;
}

export async function getOrCreateAuthSecret(ownerId = OPERATOR_ID): Promise<string> {
  let secret = await getAppSetting(ownerId, AUTH_SECRET_KEY);
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    await setAppSetting(ownerId, AUTH_SECRET_KEY, secret);
  }
  return secret;
}

const SKILLS_INITIALIZED_AT_KEY = "skills_initialized_at";

export async function getSkillsInitializedAt(ownerId = OPERATOR_ID): Promise<string | null> {
  return getAppSetting(ownerId, SKILLS_INITIALIZED_AT_KEY);
}

export async function setSkillsInitializedAt(iso: string, ownerId = OPERATOR_ID): Promise<void> {
  await setAppSetting(ownerId, SKILLS_INITIALIZED_AT_KEY, iso);
}
