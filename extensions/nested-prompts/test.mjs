import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const compiledPath = join(import.meta.dirname, ".nested-prompts.test.mjs");
let findNestedPromptFiles;
let nestedPrompts;
let tempDir;

before(async () => {
  const source = await readFile(join(import.meta.dirname, "index.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;
  await writeFile(compiledPath, compiled, "utf8");
  const imported = await import(`${pathToFileURL(compiledPath).href}?t=${Date.now()}`);
  findNestedPromptFiles = imported.__nestedPromptsForTest.findNestedPromptFiles;
  nestedPrompts = imported.default;

  tempDir = await mkdtemp(join(tmpdir(), "nested-prompts-"));
  await mkdir(join(tempDir, "review", "deep"), { recursive: true });
  await writeFile(join(tempDir, "top-level.md"), "native", "utf8");
  await writeFile(join(tempDir, "review", "code.md"), "nested", "utf8");
  await writeFile(join(tempDir, "review", "notes.txt"), "ignored", "utf8");
  await writeFile(join(tempDir, "review", "deep", "security.md"), "deep", "utf8");
});

after(async () => {
  await rm(compiledPath, { force: true });
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("nested-prompts", () => {
  test("finds Markdown files recursively below, but not directly in, the prompts directory", () => {
    assert.deepEqual(findNestedPromptFiles(tempDir), [
      join(tempDir, "review", "code.md"),
      join(tempDir, "review", "deep", "security.md"),
    ]);
  });

  test("returns no files when the prompts directory does not exist", () => {
    assert.deepEqual(findNestedPromptFiles(join(tempDir, "missing")), []);
  });

  test("registers discovered files through resources_discover", () => {
    let handler;
    nestedPrompts({
      on(event, registeredHandler) {
        if (event === "resources_discover") handler = registeredHandler;
      },
    });

    assert.equal(typeof handler, "function");
    const result = handler();
    assert.ok(Array.isArray(result.promptPaths));
  });
});
