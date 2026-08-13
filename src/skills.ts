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
  try {
    const parsed = JSON.parse(
      await readFile(path.join(projectRoot, "skills", "index.json"), "utf8"),
    ) as { skills?: unknown };
    if (!Array.isArray(parsed.skills)) return [];
    return parsed.skills
      .filter((item): item is SkillMeta => typeof item === "object" && item !== null && typeof (item as SkillMeta).name === "string")
      .map((item) => ({
        name: item.name,
        description: item.description ?? "",
        triggerKeywords: Array.isArray(item.triggerKeywords) ? item.triggerKeywords.map(String) : [],
        utilityScore: typeof item.utilityScore === "number" ? item.utilityScore : 0,
        version: item.version,
        path: item.path,
      }));
  } catch {
    return [];
  }
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
  try {
    const content = await readFile(path.join(projectRoot, "skills", skill.path), "utf8");
    return content.length > maxChars ? `${content.slice(0, maxChars)}\n…[技能内容过长已截断]` : content;
  } catch {
    return "";
  }
}
