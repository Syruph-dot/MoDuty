import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentRegistry } from "../src/agent-registry.ts";
import { SessionManager } from "../src/session-manager.ts";
import { loadSkillContent, loadSkillIndex } from "../src/skills.ts";

/**
 * 打包版数据布局回归（2026-09-28 发布版事故）：
 * Agent 注册表原来放在 `<projectRoot>/memory/.agents/`，而打包后项目根变成安装目录，
 * 于是值日生与所有磁贴读到空注册表，会话/台账却还在（它们本来就是用户级）。
 * 现在注册表固定在用户级数据目录，并且能从旧位置迁移。
 */

test("Agent 注册表落在用户级数据目录，并能从旧的项目级位置迁移", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moduty-registry-"));
  try {
    const projectRoot = path.join(root, "project");
    const dataDir = path.join(root, ".momoka", "data");
    const legacyFile = path.join(projectRoot, "memory", ".agents", "agents.json");
    const sessions = new SessionManager(dataDir);

    // 旧位置先有一份注册表（用 registryFile 显式指向旧路径），造出两个 Agent
    const legacyRegistry = new AgentRegistry(path.join(projectRoot, "memory"), sessions, legacyFile);
    await legacyRegistry.createAgent({ name: "旧 Agent", role: "r", workspaceDir: projectRoot });
    assert.equal((await legacyRegistry.listAgents()).length, 1);

    // 新位置的注册表构造时应该把旧文件迁进来
    const registry = new AgentRegistry(path.join(projectRoot, "memory"), sessions, undefined, dataDir);
    assert.equal((await registry.listAgents()).length, 1);
    assert.equal((await registry.listAgents())[0]?.name, "旧 Agent");
    assert.ok((await stat(path.join(dataDir, ".agents", "agents.json"))).isFile());

    // 迁移后旧位置更新（例如旧版仍在写）→ 再构造时应备份新文件并重新导入
    await legacyRegistry.createAgent({ name: "旧位置新增", role: "r", workspaceDir: projectRoot });
    const future = new Date(Date.now() + 60_000);
    await utimes(legacyFile, future, future);
    const reloaded = new AgentRegistry(path.join(projectRoot, "memory"), sessions, undefined, dataDir);
    assert.equal((await reloaded.listAgents()).length, 2);
    const bak = `${path.join(dataDir, ".agents", "agents.json")}.bak-${new Date().toISOString().replace(/\D/gu, "").slice(0, 14)}`;
    assert.ok((await stat(bak)).isFile(), "覆盖前应留下 .bak 备份");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("技能索引取用户级与项目级并集：同名以用户级为准，缺 index.json 的目录被跳过", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moduty-skills-"));
  try {
    const userDir = path.join(root, "user-skills");
    const projectDir = path.join(root, "project-skills");
    const emptyDir = path.join(root, "empty-skills");
    await mkdir(path.join(userDir, "shared"), { recursive: true });
    await mkdir(path.join(projectDir, "shared"), { recursive: true });
    await mkdir(path.join(projectDir, "extra"), { recursive: true });
    await mkdir(emptyDir, { recursive: true });
    await writeFile(path.join(userDir, "index.json"), JSON.stringify({ skills: [
      { name: "shared", path: "shared/SKILL.md", triggerKeywords: ["摘要"], utilityScore: 0.9 },
    ] }), "utf8");
    await writeFile(path.join(projectDir, "index.json"), JSON.stringify({ skills: [
      { name: "shared", path: "shared/SKILL.md", triggerKeywords: ["摘要"], utilityScore: 0.1 },
      { name: "extra", path: "extra/SKILL.md", triggerKeywords: ["整理"], utilityScore: 0.5 },
    ] }), "utf8");
    await writeFile(path.join(userDir, "shared", "SKILL.md"), "# 用户级技能\n用户级正文。", "utf8");
    await writeFile(path.join(projectDir, "shared", "SKILL.md"), "# 项目级技能\n项目级正文。", "utf8");
    await writeFile(path.join(projectDir, "extra", "SKILL.md"), "# 附带技能\n正文。", "utf8");

    const index = await loadSkillIndex([userDir, projectDir, emptyDir]);
    assert.deepEqual(index.map((skill) => skill.name), ["shared", "extra"]);
    assert.equal(index[0]?.utilityScore, 0.9, "同名技能应取靠前目录（用户级）的条目");
    assert.match(await loadSkillContent(index[0]!), /用户级正文/u);
    assert.match(await loadSkillContent(index[1]!), /附带技能/u);

    // 两个来源都不存在时不抛错，只是没有技能（打包版缺目录不该让整轮失败）
    assert.deepEqual(await loadSkillIndex([path.join(root, "absent")]), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
