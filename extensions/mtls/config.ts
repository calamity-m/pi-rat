import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { CredentialSource, MtlsConfig, SecretFormat } from "./types.ts";

const SETTINGS_KEY = "mtls";

export interface ConfigReadResult {
  config?: MtlsConfig;
  error?: string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function parseSecretFormat(value: unknown, field: string): SecretFormat {
  if (value === "pem" || value === "p12-base64") return value;
  throw new Error(`${field} must be "pem" or "p12-base64"`);
}

function parseCredentialSource(value: unknown): CredentialSource {
  if (!isRecord(value)) throw new Error("mtls.source must be an object");

  switch (value.type) {
    case "pem":
      return {
        type: "pem",
        certPath: requiredString(value.certPath, "mtls.source.certPath"),
        keyPath: requiredString(value.keyPath, "mtls.source.keyPath"),
      };
    case "p12":
      return { type: "p12", path: requiredString(value.path, "mtls.source.path") };
    case "pass":
      return {
        type: "pass",
        entry: requiredString(value.entry, "mtls.source.entry"),
        format: parseSecretFormat(value.format, "mtls.source.format"),
      };
    case "gnome-keyring": {
      if (!isRecord(value.attributes)) {
        throw new Error("mtls.source.attributes must be an object");
      }
      const attributes: Record<string, string> = {};
      for (const [key, attributeValue] of Object.entries(value.attributes)) {
        if (
          key.trim() === "" ||
          typeof attributeValue !== "string" ||
          attributeValue.trim() === ""
        ) {
          throw new Error("mtls.source.attributes must contain non-empty string keys and values");
        }
        attributes[key] = attributeValue;
      }
      if (Object.keys(attributes).length === 0) {
        throw new Error("mtls.source.attributes must not be empty");
      }
      return {
        type: "gnome-keyring",
        attributes,
        format: parseSecretFormat(value.format, "mtls.source.format"),
      };
    }
    default:
      throw new Error('mtls.source.type must be "pem", "p12", "pass", or "gnome-keyring"');
  }
}

export function parseMtlsConfig(value: unknown): MtlsConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("mtls must be an object");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error("mtls.enabled must be a boolean");
  }

  const enabled = value.enabled !== false;
  const caPath =
    value.caPath === undefined ? undefined : requiredString(value.caPath, "mtls.caPath");
  const source = value.source === undefined ? undefined : parseCredentialSource(value.source);
  if (enabled && source === undefined) {
    throw new Error("mtls.source is required when mTLS is enabled");
  }
  return { enabled, ...(caPath ? { caPath } : {}), ...(source ? { source } : {}) };
}

export async function readConfig(): Promise<ConfigReadResult> {
  const settingsPath = join(getAgentDir(), "settings.json");
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    return { error: `Could not read ${settingsPath}: ${errorMessage(error)}` };
  }

  try {
    const settings = JSON.parse(raw) as unknown;
    if (!isRecord(settings)) return { error: `${settingsPath} must contain a JSON object` };
    return { config: parseMtlsConfig(settings[SETTINGS_KEY]) };
  } catch (error) {
    return { error: `Invalid mTLS configuration in ${settingsPath}: ${errorMessage(error)}` };
  }
}

export async function writeConfig(config: MtlsConfig): Promise<void> {
  const settingsPath = join(getAgentDir(), "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error("settings root must be an object");
    settings = parsed;
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      throw new Error(`Could not update ${settingsPath}: ${errorMessage(error)}`);
    }
  }

  settings[SETTINGS_KEY] = config;
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function resolveUserPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(homedir(), path);
}

export function splitPemBundle(payload: string): { cert: Buffer; key: Buffer } {
  const certificates =
    payload.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const keys = payload.match(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g) ?? [];
  if (certificates.length === 0) throw new Error("The secret does not contain a PEM certificate");
  if (keys.length === 0) throw new Error("The secret does not contain a PEM private key");
  return {
    cert: Buffer.from(certificates.join("\n")),
    key: Buffer.from(keys[0]!),
  };
}

export function decodeP12(payload: string): Buffer {
  const compact = payload.replace(/\s/g, "");
  if (compact === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new Error("The secret is not valid base64 PKCS#12 data");
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.length === 0) throw new Error("The secret contains an empty PKCS#12 payload");
  return decoded;
}

export function isEncryptedPrivateKey(key: Buffer): boolean {
  const text = key.toString("utf8");
  return text.includes("BEGIN ENCRYPTED PRIVATE KEY") || /Proc-Type:\s*4,ENCRYPTED/i.test(text);
}

export const __mtlsForTest = {
  decodeP12,
  isEncryptedPrivateKey,
  parseMtlsConfig,
  resolveUserPath,
  splitPemBundle,
};
