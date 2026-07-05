import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const projectRoot = resolve(import.meta.dirname, "..");
const compiledPath = join(projectRoot, ".permissions.test.mjs");
let helpers;

before(async () => {
  const source = await readFile(join(projectRoot, "extensions/permissions.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;
  await writeFile(compiledPath, compiled, "utf8");
  const imported = await import(`${pathToFileURL(compiledPath).href}?t=${Date.now()}`);
  helpers = imported.__permissionsForTest;
});

after(async () => {
  await rm(compiledPath, { force: true });
});

function parsedPolicy(settings) {
  return helpers.parsePermissionsSettings(JSON.stringify(settings), "/tmp/settings.json");
}

describe("permissions config parsing", () => {
  test("returns default allow policy when permissions are absent", () => {
    const policy = parsedPolicy({ theme: "kanagawa" });

    assert.equal(policy.loaded, true);
    assert.equal(policy.policyPresent, false);
    assert.deepEqual(policy.validRules, []);
    assert.deepEqual(policy.invalidRules, []);
  });

  test("parses valid prompt and deny rules", () => {
    const policy = parsedPolicy({
      permissions: {
        rules: [
          { tool: "bash", match: "rm\\s+-rf", action: "prompt" },
          { tool: "write", match: "secrets", action: "deny" },
        ],
      },
    });

    assert.equal(policy.validRules.length, 2);
    assert.equal(policy.validRules[0].tool, "bash");
    assert.equal(policy.validRules[0].action, "prompt");
    assert.equal(policy.validRules[1].action, "deny");
    assert.deepEqual(policy.invalidRules, []);
  });

  test("keeps invalid rules from crashing policy load", () => {
    const policy = parsedPolicy({
      permissions: {
        rules: [
          { tool: "bash", match: "[", action: "prompt" },
          { tool: "write", match: "ok", action: "allow" },
          "bad",
        ],
      },
    });

    assert.equal(policy.validRules.length, 0);
    assert.equal(policy.invalidRules.length, 3);
    assert.match(policy.invalidRules[0].reason, /invalid rule\.match regex/);
    assert.match(policy.invalidRules[1].reason, /rule\.action/);
    assert.match(policy.invalidRules[2].reason, /rule must be an object/);
  });
});

describe("permissions rule evaluation", () => {
  test("defaults to allow when no rule matches", () => {
    const policy = parsedPolicy({ permissions: { rules: [{ tool: "bash", match: "rm", action: "deny" }] } });

    assert.equal(helpers.evaluateToolCall(policy.validRules, "read", '{"path":"README.md"}'), undefined);
  });

  test("uses first matching rule", () => {
    const policy = parsedPolicy({
      permissions: {
        rules: [
          { tool: "bash", match: "npm", action: "prompt" },
          { tool: "bash", match: "npm", action: "deny" },
        ],
      },
    });

    const decision = helpers.evaluateToolCall(
      policy.validRules,
      "bash",
      helpers.canonicalJson({ command: "npm test" }),
    );

    assert.equal(decision.rule.action, "prompt");
    assert.equal(decision.rule.index, 0);
  });

  test("supports wildcard tool rules", () => {
    const policy = parsedPolicy({ permissions: { rules: [{ tool: "*", match: "danger", action: "deny" }] } });

    const decision = helpers.evaluateToolCall(
      policy.validRules,
      "extension_tool",
      helpers.canonicalJson({ text: "danger" }),
    );

    assert.equal(decision.rule.action, "deny");
  });
});

describe("permissions canonical input and approvals", () => {
  test("canonical JSON is stable across object key order", () => {
    assert.equal(
      helpers.canonicalJson({ b: 2, a: { d: 4, c: 3 } }),
      helpers.canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  test("approval keys are exact tool plus canonical input", () => {
    const input = helpers.canonicalJson({ command: "npm test" });

    assert.equal(helpers.buildApprovalKey("bash", input), helpers.buildApprovalKey("bash", input));
    assert.notEqual(helpers.buildApprovalKey("bash", input), helpers.buildApprovalKey("read", input));
  });

  test("summarizes built-in and extension tools", () => {
    assert.equal(
      helpers.summarizeToolCall("bash", { command: "npm test" }),
      "command: npm test",
    );
    assert.match(helpers.summarizeToolCall("write", { path: "a.txt", content: "hello" }), /5 chars/);
    assert.match(helpers.summarizeToolCall("custom", { z: 1, a: 2 }), /\{"a":2,"z":1\}/);
  });
});

describe("permissions init defaults", () => {
  test("creates default rules for missing settings", () => {
    const result = helpers.buildDefaultPermissionsSettings(undefined);
    const settings = JSON.parse(result.content);

    assert.equal(result.ok, true);
    assert.equal(result.added, helpers.DEFAULT_PERMISSION_RULES.length);
    assert.equal(result.skipped, 0);
    assert.deepEqual(settings.permissions.rules, helpers.DEFAULT_PERMISSION_RULES);
  });

  test("merges default rules without duplicating existing entries", () => {
    const existing = {
      theme: "kanagawa",
      permissions: {
        rules: [
          helpers.DEFAULT_PERMISSION_RULES[0],
          { tool: "write", match: "secret", action: "deny" },
        ],
      },
    };

    const result = helpers.buildDefaultPermissionsSettings(JSON.stringify(existing));
    const settings = JSON.parse(result.content);

    assert.equal(result.ok, true);
    assert.equal(result.added, helpers.DEFAULT_PERMISSION_RULES.length - 1);
    assert.equal(result.skipped, 1);
    assert.equal(settings.theme, "kanagawa");
    assert.equal(settings.permissions.rules.length, helpers.DEFAULT_PERMISSION_RULES.length + 1);
    assert.equal(
      settings.permissions.rules.filter((rule) => rule.match === helpers.DEFAULT_PERMISSION_RULES[0].match)
        .length,
      1,
    );
  });

  test("refuses to overwrite malformed permissions settings", () => {
    const result = helpers.buildDefaultPermissionsSettings(
      JSON.stringify({ permissions: { rules: "not an array" } }),
    );

    assert.equal(result.ok, false);
    assert.match(result.error, /permissions\.rules must be an array/);
  });
});

describe("permissions nested picker builders", () => {
  test("builds top-level status, rules, approvals, and init rows", () => {
    const policy = parsedPolicy({
      permissions: {
        rules: [
          { tool: "bash", match: "npm", action: "prompt" },
          { tool: "read", match: "secret", action: "deny" },
        ],
      },
    });
    const approvals = [
      {
        key: "bash\u0000{}",
        toolName: "bash",
        canonicalInput: helpers.canonicalJson({ command: "npm test" }),
        summary: "command: npm test",
        approvedAt: "2026-07-05T00:00:00.000Z",
      },
    ];

    const rows = helpers.buildPermissionsRows(policy, approvals);

    assert.deepEqual(rows.map((row) => row.label), ["Status", "Rules", "Approvals (Session)", "init"]);
    assert.deepEqual(rows[1].children.map((row) => row.label), ["bash", "read"]);
    assert.deepEqual(rows[2].children.map((row) => row.label), ["bash"]);
  });

  test("renders status, rule leaves, and approval leaves", () => {
    const policy = parsedPolicy({ permissions: { rules: [{ tool: "bash", match: "npm", action: "prompt" }] } });
    const approvals = [
      {
        key: "bash\u0000{}",
        toolName: "bash",
        canonicalInput: helpers.canonicalJson({ command: "npm test" }),
        summary: "command: npm test",
        approvedAt: "2026-07-05T00:00:00.000Z",
      },
    ];
    const rows = helpers.buildPermissionsRows(policy, approvals);

    assert.match(helpers.renderPermissionsContent(rows[0], policy, approvals).join("\n"), /extension: alive/);
    assert.match(
      helpers.renderPermissionsContent(rows[1].children[0], policy, approvals).join("\n"),
      /#1 PROMPT\ntool: bash\nmatch: \/npm\//,
    );
    assert.match(
      helpers.renderPermissionsContent(rows[2].children[0], policy, approvals).join("\n"),
      /summary: command: npm test/,
    );
    assert.deepEqual(helpers.renderPermissionsContent(rows[3], policy, approvals).render(), [
      "Initializing default permissions…",
    ]);
  });
});
