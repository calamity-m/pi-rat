import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const compiledPath = join(import.meta.dirname, ".mtls.test.mjs");
const compiledWizardDataPath = join(import.meta.dirname, ".mtls-wizard-data.test.mjs");
let helpers;
let wizardData;

async function compileModule(sourcePath, outputPath) {
  const source = await readFile(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;
  await writeFile(outputPath, compiled, "utf8");
  return import(`${pathToFileURL(outputPath).href}?t=${Date.now()}`);
}

before(async () => {
  const [configModule, wizardDataModule] = await Promise.all([
    compileModule(join(import.meta.dirname, "mtls", "config.ts"), compiledPath),
    compileModule(join(import.meta.dirname, "mtls", "wizard-data.ts"), compiledWizardDataPath),
  ]);
  helpers = configModule.__mtlsForTest;
  wizardData = wizardDataModule;
});

after(async () => {
  await Promise.all([
    rm(compiledPath, { force: true }),
    rm(compiledWizardDataPath, { force: true }),
  ]);
});

describe("mTLS configuration", () => {
  test("parses every supported credential source", () => {
    assert.deepEqual(
      helpers.parseMtlsConfig({
        caPath: "~/ca.pem",
        source: { type: "pem", certPath: "~/client.pem", keyPath: "~/client-key.pem" },
      }),
      {
        enabled: true,
        caPath: "~/ca.pem",
        source: { type: "pem", certPath: "~/client.pem", keyPath: "~/client-key.pem" },
      },
    );
    assert.deepEqual(helpers.parseMtlsConfig({ source: { type: "p12", path: "~/client.pfx" } }), {
      enabled: true,
      source: { type: "p12", path: "~/client.pfx" },
    });
    assert.deepEqual(
      helpers.parseMtlsConfig({
        source: { type: "pass", entry: "certs/pi", format: "p12-base64" },
      }),
      {
        enabled: true,
        source: { type: "pass", entry: "certs/pi", format: "p12-base64" },
      },
    );
    assert.deepEqual(
      helpers.parseMtlsConfig({
        source: {
          type: "gnome-keyring",
          attributes: { service: "pi-mtls", account: "alice" },
          format: "pem",
        },
      }),
      {
        enabled: true,
        source: {
          type: "gnome-keyring",
          attributes: { service: "pi-mtls", account: "alice" },
          format: "pem",
        },
      },
    );
  });

  test("allows an explicitly disabled configuration without a source", () => {
    assert.deepEqual(helpers.parseMtlsConfig({ enabled: false }), { enabled: false });
  });

  test("rejects enabled or malformed sources", () => {
    assert.throws(() => helpers.parseMtlsConfig({}), /source is required/);
    assert.throws(
      () => helpers.parseMtlsConfig({ source: { type: "pass", entry: "certs/pi", format: "raw" } }),
      /must be "pem" or "p12-base64"/,
    );
    assert.throws(
      () =>
        helpers.parseMtlsConfig({
          source: { type: "gnome-keyring", attributes: {}, format: "pem" },
        }),
      /must not be empty/,
    );
  });
});

describe("mTLS wizard discovery", () => {
  test("discovers pass entries without reading secret contents", async () => {
    const store = await mkdtemp(join(tmpdir(), "pi-rat-mtls-pass-"));
    try {
      await mkdir(join(store, "certificates"), { recursive: true });
      await mkdir(join(store, ".git"), { recursive: true });
      await Promise.all([
        writeFile(join(store, "root.gpg"), "encrypted"),
        writeFile(join(store, "certificates", "client.gpg"), "encrypted"),
        writeFile(join(store, "notes.txt"), "ignore"),
        writeFile(join(store, ".git", "ignored.gpg"), "ignore"),
      ]);
      assert.deepEqual(await wizardData.discoverPassEntries(store), [
        "certificates/client",
        "root",
      ]);
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  test("parses arbitrary GNOME Keyring lookup attributes", () => {
    assert.deepEqual(
      wizardData.parseKeyringAttributes("service=pi-mtls, account=alice, environment=prod"),
      { service: "pi-mtls", account: "alice", environment: "prod" },
    );
    assert.throws(
      () => wizardData.parseKeyringAttributes("service=pi-mtls, account="),
      /key=value/,
    );
  });
});

describe("mTLS secret payloads", () => {
  const certificate = "-----BEGIN CERTIFICATE-----\nY2VydA==\n-----END CERTIFICATE-----";
  const plainKey = "-----BEGIN PRIVATE KEY-----\na2V5\n-----END PRIVATE KEY-----";
  const encryptedKey =
    "-----BEGIN ENCRYPTED PRIVATE KEY-----\nZW5jcnlwdGVk\n-----END ENCRYPTED PRIVATE KEY-----";

  test("splits a combined PEM secret", () => {
    const result = helpers.splitPemBundle(`${plainKey}\n${certificate}`);
    assert.equal(result.cert.toString(), certificate);
    assert.equal(result.key.toString(), plainKey);
  });

  test("detects modern and legacy encrypted PEM keys", () => {
    assert.equal(helpers.isEncryptedPrivateKey(Buffer.from(plainKey)), false);
    assert.equal(helpers.isEncryptedPrivateKey(Buffer.from(encryptedKey)), true);
    assert.equal(
      helpers.isEncryptedPrivateKey(
        Buffer.from(
          "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n-----END RSA PRIVATE KEY-----",
        ),
      ),
      true,
    );
  });

  test("decodes a whitespace-wrapped base64 PKCS#12 secret", () => {
    assert.deepEqual(helpers.decodeP12("AAEC\nAw==\n"), Buffer.from([0, 1, 2, 3]));
    assert.throws(() => helpers.decodeP12("not base64!"), /not valid base64/);
  });
});
