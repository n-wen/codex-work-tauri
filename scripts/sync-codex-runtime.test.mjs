import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { npmPlatformSpec, pinnedVersion } from "./sync-codex-runtime.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("codex npm runtime pin", () => {
  test("CODEX_VERSION matches package.json @openai/codex", () => {
    const version = pinnedVersion(appRoot);
    const pkg = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8"));
    assert.equal(pkg.dependencies["@openai/codex"], version);
  });

  test("maps node platform to npm dist-tag and rust triple", () => {
    assert.deepEqual(npmPlatformSpec("win32", "x64"), {
      key: "win32-x64",
      npm: "win32-x64",
      triple: "x86_64-pc-windows-msvc",
    });
    assert.deepEqual(npmPlatformSpec("darwin", "arm64"), {
      key: "darwin-arm64",
      npm: "darwin-arm64",
      triple: "aarch64-apple-darwin",
    });
    assert.throws(() => npmPlatformSpec("aix", "ppc64"), /暂无 Codex npm 包/);
  });

  test("npm registry has the pinned Windows package", () => {
    const version = pinnedVersion(appRoot);
    const name = `@openai/codex@${version}-win32-x64`;
    const out = execFileSync("npm", ["view", name, "version"], {
      encoding: "utf8",
      cwd: appRoot,
    }).trim();
    assert.equal(out, `${version}-win32-x64`);
  });
});
