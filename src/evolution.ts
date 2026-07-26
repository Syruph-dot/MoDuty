import type { MemoryStore } from "./memory.js";
import type { SkillRouter } from "./skill-router.js";
import type { EvolutionProposal, JudgmentRecord } from "./types.js";

function idStamp(): string {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}

async function findSkillPath(skillRouter: SkillRouter, skillName: string): Promise<string> {
  for (const skill of await skillRouter.listSkills()) {
    if (skill.name === skillName) {
      return `${skillRouter.skillsDir}/${skill.path}`;
    }
  }
  return "";
}

function buildProposal(input: {
  type: "skill_rewrite" | "skill_promote";
  skillName: string;
  evidence: JudgmentRecord[];
  targetFiles: string[];
  summary: string;
  expectedDiff: string;
}): EvolutionProposal {
  const createdAt = new Date().toISOString();
  return {
    id: `evo_${idStamp()}`,
    key: `${input.type}:${input.skillName}`,
    type: input.type,
    skill: input.skillName,
    status: "pending",
    createdAt,
    summary: input.summary,
    targetFiles: input.targetFiles,
    expectedDiff: input.expectedDiff,
    applyGuardrails: "require_clean_git=true; backup_branch=true",
    evidence: input.evidence,
  };
}

export async function generateEvolutionProposals(
  skillRouter: SkillRouter,
  memoryStore: MemoryStore,
  judgment: JudgmentRecord,
): Promise<EvolutionProposal[]> {
  const proposals: EvolutionProposal[] = [];
  for (const skillName of judgment.matchedSkills) {
    const evidence = await memoryStore.getRecentSkillJudgments(skillName, 8);
    const negatives = evidence.filter((item) => item.score <= 2);
    const positives = evidence.filter((item) => item.score >= 6);

    if (negatives.length >= 3) {
      const skillPath = await findSkillPath(skillRouter, skillName);
      proposals.push(buildProposal({
        type: "skill_rewrite",
        skillName,
        evidence: negatives.slice(0, 3),
        targetFiles: skillPath ? [skillPath] : [],
        summary: `${skillName} 多次低分反馈，建议重写技能说明或例子。`,
        expectedDiff: "更新技能触发条件、补充反例或新增约束，避免触发偏差。",
      }));
    }

    if (positives.length >= 3) {
      const skillPath = await findSkillPath(skillRouter, skillName);
      proposals.push(buildProposal({
        type: "skill_promote",
        skillName,
        evidence: positives.slice(0, 3),
        targetFiles: [skillPath, "prompts/AGENTS.md"].filter(Boolean),
        summary: `${skillName} 多次高分反馈，建议固化到技能或主提示词。`,
        expectedDiff: "沉淀高分模式为技能段落或主提示词规范，减少重复探索。",
      }));
    }
  }

  const recorded: EvolutionProposal[] = [];
  for (const proposal of proposals) {
    recorded.push(await memoryStore.recordEvolutionProposal(proposal as unknown as Record<string, unknown>) as unknown as EvolutionProposal);
  }
  return recorded;
}
