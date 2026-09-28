import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 编译 sidecar 二进制（Tauri v1 的 externalBin）。
 *
 * 为什么必须有这个脚本：`tauri.conf.json` 里的 `externalBin` 与 `bundle.resources`
 * 都相对 **src-tauri/** 解析，Tauri 实际找的是
 * `src-tauri/binaries/momoka-server-<target-triple>.exe`。
 * 手工把 bun 编译结果放到仓库根的 `binaries/` 不会被任何安装包引用——曾因此把上一版
 * 二进制打进包（2026-09-28 实测），所以这里把目标路径固定下来。
 *
 * 前提：本机有 bun（bun build --compile）。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const triple = /host: (\S+)/u.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
if (!triple) throw new Error("无法从 `rustc -vV` 解析 host target triple（请确认已安装 Rust 工具链）");

const suffix = process.platform === "win32" ? ".exe" : "";
const output = path.join(root, "src-tauri", "binaries", `momoka-server-${triple}${suffix}`);

execFileSync("bun", ["build", "--compile", "--outfile", output, path.join(root, "scripts", "release-sidecar.ts")], {
  stdio: "inherit",
  cwd: root,
});

console.log(`sidecar 已产出：${output}`);
