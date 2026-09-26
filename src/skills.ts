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
}

export async function loadSkillIndex(projectRoot: string): Promise<SkillMeta[]> {
  const indexPath = path.join(projectRoot, "skills", "index.json");
  const parsed = JSON.parse(await readFile(indexPath, "utf8")) as { skills?: unknown };
  if (!Array.isArray(parsed.skills)) throw new Error(`Skill index must contain a skills array: ${indexPath}`);
  return parsed.skills.map((item, index) => {
    if (typeof item !== "object" || item === null) throw new Error(`Invalid skill entry at index ${index}: ${indexPath}`);
    const entry = item as Partial<SkillMeta>;
    if (typeof entry.name !== "string" || !entry.name.trim() || typeof entry.path !== "string" || !entry.path.trim()) {
      throw new Error(`Skill entry ${index} requires a name and path: ${indexPath}`);
    }
    return {
      name: entry.name,
      description: entry.description ?? "",
      triggerKeywords: Array.isArray(entry.triggerKeywords) ? entry.triggerKeywords.map(String) : [],
      utilityScore: typeof entry.utilityScore === "number" ? entry.utilityScore : 0,
      version: entry.version,
      path: entry.path,
    };
  });
}

/** 按 topic/用户消息命中技能触发关键词，按 utility_score 降序返回 */
export function matchSkills(topic: string, message: string, index: SkillMeta[]): SkillMeta[] {
  const haystack = `${topic ?? ""} ${message ?? ""}`.toLowerCase();
  return index
    .filter((skill) => (skill.triggerKeywords ?? []).some((keyword) => haystack.includes(keyword.toLowerCase())))
    .sort((a, b) => (b.utilityScore ?? 0) - (a.utilityScore ?? 0));
}

/** 读取技能内容并截断（渐进披露只注入必要片段） */
export async function loadSkillContent(projectRoot: string, skill: SkillMeta, maxChars = 1500): Promise<string> {
  const skillPath = path.join(projectRoot, "skills", skill.path);
  const content = await readFile(skillPath, "utf8");
  if (!content.trim()) throw new Error(`Matched skill is empty: ${skillPath}`);
  return content.length > maxChars ? `${content.slice(0, maxChars)}\n…[技能内容过长已截断]` : content;
}
