import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const projectRoot = resolve(import.meta.dirname, "..");
const compiledPath = join(projectRoot, ".usage-helpers.test.mjs");
let helpers;

before(async () => {
  const source = await readFile(join(projectRoot, "extensions/usage/helpers.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;
  await writeFile(compiledPath, compiled, "utf8");
  helpers = await import(`${pathToFileURL(compiledPath).href}?t=${Date.now()}`);
});

after(async () => {
  await rm(compiledPath, { force: true });
});

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

describe("usage helpers", () => {
  test("matches only openai-codex provider names", () => {
    assert.equal(helpers.isOpenAICodexProvider("openai-codex"), true);
    assert.equal(helpers.isOpenAICodexProvider("openai-codex-1"), true);
    assert.equal(helpers.isOpenAICodexProvider("openai-codex-beta"), false);
    assert.equal(helpers.isOpenAICodexProvider("openai"), false);
    assert.equal(helpers.isOpenAICodexProvider(undefined), false);
  });

  test("extracts ChatGPT metadata from an OAuth JWT payload", () => {
    const token = jwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
        chatgpt_plan_type: "plus",
      },
      "https://api.openai.com/profile": { email: "user@example.com" },
    });

    assert.deepEqual(helpers.getTokenMetadata(token), {
      accountId: "acct_123",
      planType: "plus",
      email: "user@example.com",
    });
  });

  test("malformed JWT metadata returns no fields", () => {
    assert.deepEqual(helpers.getTokenMetadata("not-a-jwt"), {
      accountId: undefined,
      planType: undefined,
      email: undefined,
    });
  });

  test("detects 5-hour and weekly windows regardless of primary order", () => {
    const snapshot = helpers.parseUsageSnapshot(
      {
        plan_type: "pro",
        email: "body@example.com",
        rate_limit: {
          primary_window: {
            used_percent: 12.3,
            limit_window_seconds: helpers.WEEK_SECONDS - 60,
            reset_at: 2_000_000_000,
          },
          secondary_window: {
            used_percent: 45.6,
            limit_window_seconds: helpers.FIVE_HOUR_SECONDS + 30,
            reset_at: 2_000_010_000,
          },
        },
      },
      1_700_000_000_000,
    );

    assert.equal(snapshot.planType, "pro");
    assert.equal(snapshot.email, "body@example.com");
    assert.equal(snapshot.weekly.usedPercent, 12.3);
    assert.equal(snapshot.fiveHour.usedPercent, 45.6);
    assert.equal(snapshot.fetchedAt, 1_700_000_000_000);
  });

  test("formats missing fields clearly", () => {
    const lines = helpers.buildUsageDetails(
      { fetchedAt: 1_700_000_000_000 },
      "openai-codex",
    );

    assert.match(lines.join("\n"), /plan: unknown/);
    assert.match(lines.join("\n"), /email: unknown/);
    assert.match(lines.join("\n"), /5-hour: unknown/);
    assert.match(lines.join("\n"), /weekly: unknown/);
    assert.match(lines.join("\n"), /endpoint: https:\/\/chatgpt\.com\/backend-api\/wham\/usage/);
  });
});
