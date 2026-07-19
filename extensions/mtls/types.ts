import type { SecureContext } from "node:tls";

export type SecretFormat = "pem" | "p12-base64";

export type CredentialSource =
  | { type: "pem"; certPath: string; keyPath: string }
  | { type: "p12"; path: string }
  | { type: "pass"; entry: string; format: SecretFormat }
  | { type: "gnome-keyring"; attributes: Record<string, string>; format: SecretFormat };

export interface MtlsConfig {
  enabled: boolean;
  caPath?: string;
  source?: CredentialSource;
}

export interface CertificateSummary {
  subject: string;
  issuer: string;
  validTo: string;
  fingerprint256: string;
}

export interface PreparedCredential {
  secureContext: SecureContext;
  fingerprint: string;
  certificate?: CertificateSummary;
}

export type RuntimeStatus =
  | { state: "not-configured" }
  | { state: "disabled" }
  | { state: "error"; message: string; source?: string }
  | {
      state: "active";
      source: string;
      customCa: boolean;
      loadedAt: Date;
      certificate?: CertificateSummary;
    };
