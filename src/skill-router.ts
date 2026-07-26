import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { skillMetaFromDisk } from "./casing.js";
import { readJsonObject } from "./json-file.js";
import type { MatchedSkill, SkillMeta } from "./types.js";

export class SkillRouter {
  readonly skillsDir: string;

  constructor(skillsDir: string) {
    this.skillsDir = path.resolve(skillsDir);
  }

  get indexPath(): string {
    return path.join(this.skillsDir, "index.json");
  }

  async listSkills(): Promise<SkillMeta[]> {
    const index = await readJsonObject(this.indexPath, { skills: [] });
    if (!Array.isArray(index.skills)) {
      return [];
    }
    return index.skills
      .filter((skill): skill is Record<string, unknown> => typeof skill === "object" && skill !== null && !Array.isArray(skill))
      .map(skillMetaFromDisk);
  }

  async matchSkills(
    userMessage: string,
    options: {
      topic?: string;
      feedbackBoosts?: Record<string, number>;
      minScore?: number;
      topK?: number;
    } = {},
  ): Promise<MatchedSkill[]> {
    const minScore = options.minScore ?? 0.55;
    const topK = options.topK ?? 4;
    const message = userMessage.toLowerCase();
    const topic = (options.topic ?? "").toLowerCase();
    const matched: MatchedSkill[] = [];

    for (const skill of await this.listSkills()) {
      const [score, reasons] = this.scoreSkill(skill, message, topic, options.feedbackBoosts ?? {});
      if (score < minScore) {
        continue;
      }
      const content = await this.loadSkill(skill.name);
      if (!content) {
        continue;
      }
      matched.push({ meta: skill, content, score, reasons });
    }

    return matched.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  private scoreSkill(
    skill: SkillMeta,
    message: string,
    topic: string,
    feedbackBoosts: Record<string, number>,
  ): [number, string[]] {
    const utility = Number.isFinite(skill.utilityScore) ? skill.utilityScore : 0.5;
    let score = 0;
    const reasons = [`utility:${utility.toFixed(2)}`];

    const keywordHits = skill.triggerKeywords.filter((keyword) => {
      const normalized = keyword.toLowerCase();
      return normalized && (message.includes(normalized) || topic.includes(normalized));
    });
    if (keywordHits.length > 0) {
      score += 0.45 + 0.2 * utility + 0.03 * keywordHits.length;
      reasons.push(`keywords:${keywordHits.slice(0, 3).join(",")}`);
    }

    const desc = skill.description?.trim() ?? "";
    if (desc) {
      const tokens = desc.split(/[\s/·、，,。]+/u).filter((token) => token.length >= 2);
      if (tokens.some((token) => message.includes(token.toLowerCase()) || topic.includes(token.toLowerCase()))) {
        score += 0.28 + 0.12 * utility;
        reasons.push("desc-match");
      }
    }

    const feedback = feedbackBoosts[skill.name] ?? 0;
    if (feedback !== 0) {
      if (feedback > 0) {
        score += 0.25 + feedback + 0.1 * utility;
      } else {
        score += feedback;
      }
      reasons.push(`feedback:${feedback >= 0 ? "+" : ""}${feedback.toFixed(2)}`);
    }

    return [score, reasons];
  }

  async loadSkill(name: string): Promise<string | null> {
    for (const skill of await this.listSkills()) {
      if (skill.name !== name) {
        continue;
      }
      try {
        return await readFile(path.join(this.skillsDir, skill.path), "utf8");
      } catch {
        return null;
      }
    }
    return null;
  }

  async registerSkill(input: {
    name: string;
    path: string;
    keywords: string[];
    description?: string;
  }): Promise<SkillMeta> {
    const skills = await this.listSkills();
    const existing = skills.find((skill) => skill.name === input.name);
    if (existing) {
      existing.triggerKeywords = Array.from(new Set([...existing.triggerKeywords, ...input.keywords]));
      existing.utilityScore = Math.min(1, existing.utilityScore + 0.05);
      await this.saveSkills(skills);
      return existing;
    }

    const skill: SkillMeta = {
      name: input.name,
      description: input.description ?? "",
      triggerKeywords: input.keywords,
      utilityScore: 0.5,
      version: "1.0.0",
      path: input.path,
    };
    skills.push(skill);
    await this.saveSkills(skills);
    return skill;
  }

  private async saveSkills(skills: SkillMeta[]): Promise<void> {
    await writeFile(
      this.indexPath,
      `${JSON.stringify({
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description ?? "",
          trigger_keywords: skill.triggerKeywords,
          utility_score: skill.utilityScore,
          version: skill.version ?? "1.0.0",
          path: skill.path,
        })),
      }, null, 2)}\n`,
      "utf8",
    );
  }
}

export function formatSkillPrompt(matchedSkills: MatchedSkill[]): string {
  if (matchedSkills.length === 0) {
    return "";
  }
  const lines = ["\n## 已加载技能 (Skills)\n"];
  matchedSkills.forEach((skill, index) => {
    lines.push(`### 技能 ${index + 1}: ${skill.meta.name} (效用: ${Math.round(skill.meta.utilityScore * 100)}%)`);
    if (skill.reasons.length > 0) {
      lines.push(`理由: ${skill.reasons.join(", ")}`);
    }
    lines.push(`${skill.meta.description ?? ""}\n`);
    lines.push(skill.content);
    lines.push("---");
  });
  return lines.join("\n");
}
