import { createHash, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createSecureContext, type SecureContext } from "node:tls";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { decodeP12, isEncryptedPrivateKey, resolveUserPath, splitPemBundle } from "./config.ts";
import type { CertificateSummary, MtlsConfig, PreparedCredential, SecretFormat } from "./types.ts";

const COMMAND_TIMEOUT_MS = 15_000;

interface PemMaterial {
  kind: "pem";
  cert: Buffer;
  key: Buffer;
  ca?: Buffer;
}

interface P12Material {
  kind: "p12";
  pfx: Buffer;
  ca?: Buffer;
}

type CredentialMaterial = PemMaterial | P12Material;

async function runSecretCommand(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  description: string,
): Promise<string> {
  const result = await pi.exec(command, args, { timeout: COMMAND_TIMEOUT_MS });
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new Error(`${description} failed${detail ? `: ${detail}` : ` (exit ${result.code})`}`);
  }
  if (result.stdout.trim() === "") throw new Error(`${description} returned an empty secret`);
  return result.stdout;
}

function materialFromSecret(payload: string, format: SecretFormat): CredentialMaterial {
  if (format === "p12-base64") return { kind: "p12", pfx: decodeP12(payload) };
  return { kind: "pem", ...splitPemBundle(payload) };
}

async function readCredentialMaterial(
  config: MtlsConfig,
  pi: ExtensionAPI,
): Promise<CredentialMaterial> {
  const source = config.source;
  if (!source) throw new Error("No mTLS credential source is configured");

  let material: CredentialMaterial;
  switch (source.type) {
    case "pem":
      material = {
        kind: "pem",
        cert: await readFile(resolveUserPath(source.certPath)),
        key: await readFile(resolveUserPath(source.keyPath)),
      };
      break;
    case "p12":
      material = { kind: "p12", pfx: await readFile(resolveUserPath(source.path)) };
      break;
    case "pass": {
      const payload = await runSecretCommand(
        pi,
        "pass",
        ["show", source.entry],
        `pass show ${source.entry}`,
      );
      material = materialFromSecret(payload, source.format);
      break;
    }
    case "gnome-keyring": {
      const args = [
        "lookup",
        ...Object.entries(source.attributes).flatMap(([key, value]) => [key, value]),
      ];
      const payload = await runSecretCommand(pi, "secret-tool", args, "GNOME Keyring lookup");
      material = materialFromSecret(payload, source.format);
      break;
    }
  }

  if (config.caPath) material.ca = await readFile(resolveUserPath(config.caPath));
  return material;
}

function fingerprintMaterial(material: CredentialMaterial): string {
  const hash = createHash("sha256");
  hash.update(material.kind);
  if (material.kind === "pem") {
    hash.update(material.cert);
    hash.update(material.key);
  } else {
    hash.update(material.pfx);
  }
  if (material.ca) hash.update(material.ca);
  return hash.digest("hex");
}

function summarizeCertificate(material: CredentialMaterial): CertificateSummary | undefined {
  if (material.kind !== "pem") return undefined;
  try {
    const certificate = new X509Certificate(material.cert);
    return {
      subject: certificate.subject,
      issuer: certificate.issuer,
      validTo: certificate.validTo,
      fingerprint256: certificate.fingerprint256,
    };
  } catch {
    return undefined;
  }
}

function createContext(material: CredentialMaterial, passphrase?: string): SecureContext {
  if (material.kind === "pem") {
    return createSecureContext({
      cert: material.cert,
      key: material.key,
      ca: material.ca,
      passphrase,
    });
  }
  return createSecureContext({ pfx: material.pfx, ca: material.ca, passphrase });
}

export async function prepareCredential(
  config: MtlsConfig,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  promptForPassphrase: (ctx: ExtensionContext, title: string) => Promise<string | undefined>,
): Promise<PreparedCredential> {
  const material = await readCredentialMaterial(config, pi);
  const needsPassphrase = material.kind === "p12" || isEncryptedPrivateKey(material.key);
  const fingerprint = fingerprintMaterial(material);
  const certificate = summarizeCertificate(material);

  if (!needsPassphrase) {
    return { secureContext: createContext(material), fingerprint, certificate };
  }
  if (ctx.mode !== "tui") {
    throw new Error("This protected credential requires an interactive TUI passphrase prompt");
  }

  while (true) {
    const passphrase = await promptForPassphrase(
      ctx,
      material.kind === "p12"
        ? "PKCS#12/PFX passphrase (leave blank only if the file is unprotected)"
        : "Private-key passphrase",
    );
    if (passphrase === undefined) throw new Error("Passphrase entry was cancelled");
    try {
      return { secureContext: createContext(material, passphrase), fingerprint, certificate };
    } catch {
      const retry = await ctx.ui.confirm(
        "Could not unlock mTLS credential",
        "The passphrase was rejected or the credential is invalid. Retry?",
      );
      if (!retry) throw new Error("Could not unlock the protected mTLS credential");
    }
  }
}
