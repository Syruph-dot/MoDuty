/**
 * 渐进披露（第四周）：技能按需注入。
 *
 * skills/index.json 声明技能元数据（trigger_keywords / utility_score / path），
 * SKILL.md 保存完整技能内容。系统提示词只保留精简的 AGENTS.md，
 * 当任务 topic 命中技能关键词时，才把相关技能内容展开注入——避免
 * 把所有技能全量塞进上下文。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface SkillMeta {
  name: string;
  description?: string;
  triggerKeywords?: string[];
  utilityScore?: number;
  version?: string;
  path: string;
  /** 这条技能从哪个技能目录读出来的（合并多来源后用于定位正文） */
  baseDir?: string;
}

/**
 * 合并多个技能目录的索引。
 *
 * 用户 2026-09-28 决定：技能来源 = 用户级 `~/.momoka/skills` 与 `<projectRoot>/skills` 取并集，
 * 前面的目录优先（同名技能以用户级的为准）。
 * 目录没有 index.json 就跳过——打包版可能只带其中一个来源，缺一个不应该让整轮对话失败。
 */
export async function loadSkillIndex(skillDirs: string[]): Promise<SkillMeta[]> {
  const merged: SkillMeta[] = [];
  const seen = new Set<string>();
  for (const dir of skillDirs) {
    const indexPath = path.join(dir, "index.json");
    let raw: string;
    try {
      raw = await readFile(indexPath, "utf8");
    } catch {
      continue;
    }
    const parsed = JSON.parse(raw) as { skills?: unknown };
    if (!Array.isArray(parsed.skills)) throw new Error(`Skill index must contain a skills array: ${indexPath}`);
    parsed.skills.forEach((item, index) => {
      if (typeof item !== "object" || item === null) throw new Error(`Invalid skill entry at index ${index}: ${indexPath}`);
      const entry = item as Partial<SkillMeta>;
      if (typeof entry.name !== "string" || !entry.name.trim() || typeof entry.path !== "string" || !entry.path.trim()) {
        throw new Error(`Skill entry ${index} requires a name and path: ${indexPath}`);
      }
      if (seen.has(entry.name)) return;
      seen.add(entry.name);
      merged.push({
        name: entry.name,
        description: entry.description ?? "",
        triggerKeywords: Array.isArray(entry.triggerKeywords) ? entry.triggerKeywords.map(String) : [],
        utilityScore: typeof entry.utilityScore === "number" ? entry.utilityScore : 0,
        version: entry.version,
        path: entry.path,
        baseDir: dir,
      });
    });
  }
  return merged;
}

/** 按 topic/用户消息命中技能触发关键词，按 utility_score 降序返回 */
export function matchSkills(topic: string, message: string, index: SkillMeta[]): SkillMeta[] {
  const haystack = `${topic ?? ""} ${message ?? ""}`.toLowerCase();
  return index
    .filter((skill) => (skill.triggerKeywords ?? []).some((keyword) => haystack.includes(keyword.toLowerCase())))
    .sort((a, b) => (b.utilityScore ?? 0) - (a.utilityScore ?? 0));
}

/** 读取技能内容并截断（渐进披露只注入必要片段） */
export async function loadSkillContent(skill: SkillMeta, maxChars = 1500): Promise<string> {
  if (!skill.baseDir) throw new Error(`技能 ${skill.name} 缺少来源目录，无法定位正文`);
  const skillPath = path.join(skill.baseDir, skill.path);
  const content = await readFile(skillPath, "utf8");
  if (!content.trim()) throw new Error(`Matched skill is empty: ${skillPath}`);
  return content.length > maxChars ? `${content.slice(0, maxChars)}\n…[技能内容过长已截断]` : content;
}
