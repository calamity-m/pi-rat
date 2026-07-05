import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const projectRoot = resolve(import.meta.dirname, "..");
const compiledPath = join(projectRoot, ".theme.test.mjs");
let helpers;

before(async () => {
  const source = await readFile(join(projectRoot, "extensions/theme.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;
  await writeFile(compiledPath, compiled, "utf8");
  const imported = await import(`${pathToFileURL(compiledPath).href}?t=${Date.now()}`);
  helpers = imported.__themeForTest;
});

after(async () => {
  await rm(compiledPath, { force: true });
});

async function makeProject(settings) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-rat-theme-"));
  const piDir = join(cwd, ".pi");
  await mkdir(piDir, { recursive: true });
  await writeFile(join(piDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  return cwd;
}

function trustedContext(cwd, trusted = true) {
  return {
    cwd,
    isProjectTrusted() {
      return trusted;
    },
  };
}

describe("theme project override persistence", () => {
  test("updates an existing project theme override so reload keeps /theme selection", async () => {
    const cwd = await makeProject({ theme: "dark", other: true });
    try {
      const result = await helpers.updateProjectThemeOverride(trustedContext(cwd), "rose-pine");
      assert.deepEqual(result, { updated: true });
      const settings = JSON.parse(await readFile(join(cwd, ".pi/settings.json"), "utf8"));
      assert.equal(settings.theme, "rose-pine");
      assert.equal(settings.other, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("does not create a project theme override when none exists", async () => {
    const cwd = await makeProject({ other: true });
    try {
      const result = await helpers.updateProjectThemeOverride(trustedContext(cwd), "rose-pine");
      assert.deepEqual(result, { updated: false });
      const settings = JSON.parse(await readFile(join(cwd, ".pi/settings.json"), "utf8"));
      assert.deepEqual(settings, { other: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("does not update untrusted project settings", async () => {
    const cwd = await makeProject({ theme: "dark" });
    try {
      const result = await helpers.updateProjectThemeOverride(trustedContext(cwd, false), "rose-pine");
      assert.deepEqual(result, { updated: false });
      const settings = JSON.parse(await readFile(join(cwd, ".pi/settings.json"), "utf8"));
      assert.equal(settings.theme, "dark");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
