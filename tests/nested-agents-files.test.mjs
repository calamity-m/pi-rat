import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const projectRoot = resolve(import.meta.dirname, "..");
const compiledPath = join(projectRoot, ".nested-agents-files.test.mjs");
let helpers;
let nestedAgentsFiles;
let tempDir;

before(async () => {
  const source = await readFile(join(projectRoot, "extensions/nested-agents-files.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;
  await writeFile(compiledPath, compiled, "utf8");
  const imported = await import(`${pathToFileURL(compiledPath).href}?t=${Date.now()}`);
  helpers = imported.__nestedAgentsFilesForTest;
  nestedAgentsFiles = imported.default;

  tempDir = await mkdtemp(join(tmpdir(), "nested-agents-files-"));
  await mkdir(join(tempDir, "src", "my", "stuff"), { recursive: true });
  await writeFile(join(tempDir, "AGENTS.md"), "root rules", "utf8");
  await writeFile(join(tempDir, "src", "AGENTS.md"), "src rules", "utf8");
  await writeFile(join(tempDir, "src", "my", "stuff", "AGENTS.md"), "stuff rules", "utf8");
  await writeFile(join(tempDir, "src", "my", "stuff", "a.py"), "print('a')", "utf8");
  await writeFile(join(tempDir, "src", "my", "stuff", "b.py"), "print('b')", "utf8");
  await mkdir(join(tempDir, "fallback", "AGENTS.md"), { recursive: true });
  await writeFile(join(tempDir, "fallback", "CLAUDE.md"), "fallback rules", "utf8");
  await writeFile(join(tempDir, "fallback", "c.py"), "print('c')", "utf8");
});

after(async () => {
  await rm(compiledPath, { force: true });
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

function registeredHandlers() {
  const handlers = new Map();
  nestedAgentsFiles({
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  return handlers;
}

function readResultEvent(readPath, content = "file content") {
  return {
    type: "tool_result",
    toolName: "read",
    toolCallId: "read-1",
    input: { path: readPath },
    content: [{ type: "text", text: content }],
    details: undefined,
    isError: false,
  };
}

const promptOptions = {
  cwd: "",
  contextFiles: [],
};

describe("nested-agents-files helpers", () => {
  test("finds nested context files from cwd to read target directory", () => {
    const files = helpers.findApplicableNestedContextFiles(
      tempDir,
      join(tempDir, "src", "my", "stuff", "a.py"),
    );

    assert.deepEqual(files, [
      join(tempDir, "src", "AGENTS.md"),
      join(tempDir, "src", "my", "stuff", "AGENTS.md"),
    ]);
  });

  test("does not include the context file when it is the file being read", () => {
    const files = helpers.findApplicableNestedContextFiles(
      tempDir,
      join(tempDir, "src", "my", "stuff", "AGENTS.md"),
    );

    assert.deepEqual(files, [join(tempDir, "src", "AGENTS.md")]);
  });

  test("ignores reads outside cwd", () => {
    const files = helpers.findApplicableNestedContextFiles(tempDir, "/tmp/outside.py");
    assert.deepEqual(files, []);
  });

  test("uses the first readable context-file candidate in a directory", () => {
    const files = helpers.findApplicableNestedContextFiles(
      tempDir,
      join(tempDir, "fallback", "c.py"),
    );
    assert.deepEqual(files, [join(tempDir, "fallback", "CLAUDE.md")]);
  });

  test("resolves common read-tool path forms", () => {
    const target = join(tempDir, "src", "my", "stuff", "a.py");
    assert.equal(helpers.resolveReadInputPath(tempDir, "@src/my/stuff/a.py"), target);
    assert.equal(helpers.resolveReadInputPath(tempDir, pathToFileURL(target).href), target);
  });
});

describe("nested-agents-files extension", () => {
  test("injects each applicable context file only once per session", async () => {
    const handlers = registeredHandlers();
    const beforeAgentStart = handlers.get("before_agent_start");
    const toolResult = handlers.get("tool_result");

    beforeAgentStart(
      { systemPromptOptions: { ...promptOptions, cwd: tempDir, contextFiles: [] } },
      { cwd: tempDir },
    );

    const first = await toolResult(readResultEvent("@src/my/stuff/a.py"), { cwd: tempDir });
    assert.ok(first);
    assert.equal(first.content.length, 2);
    assert.match(first.content[1].text, /src\/AGENTS\.md/);
    assert.match(first.content[1].text, /src\/my\/stuff\/AGENTS\.md/);
    assert.match(first.content[1].text, /src rules/);
    assert.match(first.content[1].text, /stuff rules/);

    const second = await toolResult(readResultEvent("src/my/stuff/b.py"), { cwd: tempDir });
    assert.equal(second, undefined);
  });

  test("seeds Pi-loaded context files so they are not re-injected", async () => {
    const handlers = registeredHandlers();
    const beforeAgentStart = handlers.get("before_agent_start");
    const toolResult = handlers.get("tool_result");

    beforeAgentStart(
      {
        systemPromptOptions: {
          ...promptOptions,
          cwd: tempDir,
          contextFiles: [{ path: join(tempDir, "src", "AGENTS.md"), content: "src rules" }],
        },
      },
      { cwd: tempDir },
    );

    const result = await toolResult(readResultEvent("src/my/stuff/a.py"), { cwd: tempDir });
    assert.ok(result);
    assert.doesNotMatch(result.content[1].text, /<context_file path="src\/AGENTS\.md">/);
    assert.match(result.content[1].text, /src\/my\/stuff\/AGENTS\.md/);
  });
});
