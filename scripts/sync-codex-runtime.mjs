#!/usr/bin/env node
/**
 * Pull the pinned Codex CLI from npm into src-tauri/codex-runtime/.
 * Dev and `tauri build` both consume this directory; the app never downloads at startup.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionPath = path.join(appRoot, "src-tauri", "CODEX_VERSION");
const destRoot = path.join(appRoot, "src-tauri", "codex-runtime");
const stampPath = path.join(destRoot, ".codex-version");

export const NPM_PLATFORM_BY_NODE = {
  "darwin-arm64": { npm: "darwin-arm64", triple: "aarch64-apple-darwin" },
  "darwin-x64": { npm: "darwin-x64", triple: "x86_64-apple-darwin" },
  "linux-x64": { npm: "linux-x64", triple: "x86_64-unknown-linux-musl" },
  "linux-arm64": { npm: "linux-arm64", triple: "aarch64-unknown-linux-musl" },
  "win32-x64": { npm: "win32-x64", triple: "x86_64-pc-windows-msvc" },
  "win32-arm64": { npm: "win32-arm64", triple: "aarch64-pc-windows-msvc" },
};

export function pinnedVersion(root = appRoot) {
  return readFileSync(path.join(root, "src-tauri", "CODEX_VERSION"), "utf8").trim();
}

export function npmPlatformSpec(nodePlatform = process.platform, nodeArch = process.arch) {
  const key = `${nodePlatform}-${nodeArch}`;
  const spec = NPM_PLATFORM_BY_NODE[key];
  if (!spec) {
    throw new Error(`当前平台暂无 Codex npm 包（${key}）`);
  }
  return { key, ...spec };
}

function selectedPlatformSpec() {
  if (process.env.CODEX_NPM_PLATFORM) {
    const key = process.env.CODEX_NPM_PLATFORM;
    const spec = NPM_PLATFORM_BY_NODE[key];
    if (!spec) {
      throw new Error(`CODEX_NPM_PLATFORM=${key} 无效`);
    }
    return { key, ...spec };
  }
  return npmPlatformSpec();
}

function binaryName(win = process.platform === "win32") {
  return win ? "codex.exe" : "codex";
}

function vendorCandidates(spec) {
  return [
    path.join(appRoot, "node_modules", `@openai/codex-${spec.npm}`, "vendor", spec.triple),
    path.join(
      appRoot,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      `@openai/codex-${spec.npm}`,
      "vendor",
      spec.triple,
    ),
    path.join(appRoot, "node_modules", "@openai", "codex", "vendor", spec.triple),
  ];
}

function findVendorDir(spec) {
  for (const dir of vendorCandidates(spec)) {
    const bin = path.join(dir, "bin", binaryName(spec.npm.startsWith("win32")));
    if (existsSync(bin)) return dir;
  }
  return null;
}

function packPlatformVendor(version, spec) {
  const tmp = mkdtempSync(path.join(tmpdir(), "codex-work-npm-"));
  try {
    const pkg = `@openai/codex@${version}-${spec.npm}`;
    console.log(`[codex-runtime] npm pack ${pkg}`);
    execFileSync("npm", ["pack", pkg, "--pack-destination", tmp], {
      stdio: "inherit",
      cwd: appRoot,
    });
    const tgz = readdirSync(tmp).find((name) => name.endsWith(".tgz"));
    if (!tgz) {
      throw new Error(`npm pack 没有产出 tgz（${pkg}）`);
    }
    const tgzPath = path.join(tmp, tgz);
    execFileSync("tar", ["-xzf", tgzPath, "-C", tmp], { stdio: "inherit" });
    const vendor = path.join(tmp, "package", "vendor", spec.triple);
    const bin = path.join(vendor, "bin", binaryName(spec.npm.startsWith("win32")));
    if (!existsSync(bin)) {
      throw new Error(`npm 包里没有 ${path.relative(tmp, bin)}`);
    }
    return { vendor, tmp };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

function assertPackageJsonPin(version) {
  const pkg = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8"));
  const dep = pkg.dependencies?.["@openai/codex"];
  if (dep !== version) {
    throw new Error(
      `package.json 的 @openai/codex=${dep ?? "(missing)"} 必须与 src-tauri/CODEX_VERSION=${version} 一致`,
    );
  }
}

function chmodTree(root) {
  if (process.platform === "win32") return;
  const binDir = path.join(root, "bin");
  if (!existsSync(binDir)) return;
  for (const name of readdirSync(binDir)) {
    try {
      chmodSync(path.join(binDir, name), 0o755);
    } catch {
      // ignore
    }
  }
}

export function syncCodexRuntime() {
  if (!existsSync(versionPath)) {
    throw new Error(`找不到 ${versionPath}`);
  }
  const version = pinnedVersion();
  assertPackageJsonPin(version);
  const spec = selectedPlatformSpec();
  const stamp = `${version}:${spec.key}`;
  const destBin = path.join(destRoot, "bin", binaryName(spec.npm.startsWith("win32")));
  if (existsSync(stampPath) && readFileSync(stampPath, "utf8").trim() === stamp && existsSync(destBin)) {
    console.log(`[codex-runtime] already synced ${stamp} -> ${destRoot}`);
    return destRoot;
  }

  let vendor = findVendorDir(spec);
  let tmpToClean = null;
  if (!vendor) {
    const packed = packPlatformVendor(version, spec);
    vendor = packed.vendor;
    tmpToClean = packed.tmp;
  } else {
    console.log(`[codex-runtime] using ${vendor}`);
  }

  try {
    rmSync(destRoot, { recursive: true, force: true });
    mkdirSync(destRoot, { recursive: true });
    cpSync(vendor, destRoot, { recursive: true });
    chmodTree(destRoot);
    writeFileSync(path.join(destRoot, ".gitkeep"), "");
    writeFileSync(stampPath, `${stamp}\n`);
    if (!existsSync(destBin)) {
      throw new Error(`同步后仍找不到 ${destBin}`);
    }
    console.log(`[codex-runtime] synced ${stamp} -> ${destBin}`);
    return destRoot;
  } finally {
    if (tmpToClean) rmSync(tmpToClean, { recursive: true, force: true });
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  try {
    syncCodexRuntime();
  } catch (err) {
    console.error(`[codex-runtime] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
