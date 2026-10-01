import { randomBytes } from "node:crypto";
import {
  deleteAppSetting,
  getAppSetting,
  setAppSetting,
} from "../repositories/app-settings.repo";

export function getSetting(key: string): string | null {
  return getAppSetting(key);
}

export function setSetting(key: string, value: string): void {
  setAppSetting(key, value);
}

export function deleteSetting(key: string): void {
  deleteAppSetting(key);
}

export function getBooleanSetting(key: string, defaultValue = false): boolean {
  const value = getAppSetting(key);
  if (value === null) return defaultValue;
  return value === "true";
}

export function setBooleanSetting(key: string, value: boolean): void {
  setAppSetting(key, value ? "true" : "false");
}

const API_TOKEN_KEY = "api_token";

export function getOrCreateApiToken(): string {
  let token = getAppSetting(API_TOKEN_KEY);
  if (!token) {
    token = randomBytes(32).toString("hex");
    setAppSetting(API_TOKEN_KEY, token);
  }
  return token;
}

