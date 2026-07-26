import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  judgmentFromDisk,
  judgmentToDisk,
  outputFromDisk,
  outputToDisk,
} from "./casing.js";
import { readJsonList, readJsonObject, writeJsonList, writeJsonObject } from "./json-file.js";
import type { JudgmentRecord, OutputRecord, PreferenceUpdate } from "./types.js";

const DEFAULT_CONTEXT_WINDOW_CHARS = 20;

function nowIso(): string {
  return new Date().toISOString();
}

function compactSignal(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, "").slice(0, 120);
}

function dateStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function timeStamp(date = new Date()): string {
  return date.toTimeString().slice(0, 8);
}

export class MemoryStore {
  readonly memoryDir: string;

  constructor(memoryDir: string) {
    this.memoryDir = path.resolve(memoryDir);
  }

  async ensureLayout(): Promise<void> {
    await mkdir(path.join(this.memoryDir, ".annotations"), { recursive: true });
    await mkdir(path.join(this.memoryDir, ".dreams", "long-term"), { recursive: true });
    await mkdir(path.join(this.memoryDir, ".outputs"), { recursive: true });
    await mkdir(path.join(this.memoryDir, ".evolog"), { recursive: true });
    await mkdir(path.join(this.memoryDir, ".sessions"), { recursive: true });
  }

  dailyPath(date = new Date()): string {
    return path.join(this.memoryDir, `${dateStamp(date)}.md`);
  }

  async writeDaily(content: string, date = new Date()): Promise<string> {
    await this.ensureLayout();
    const filePath = this.dailyPath(date);
    const entry = `\n## ${timeStamp(new Date())}\n${content}\n`;
    let current = "";
    try {
      current = await readFile(filePath, "utf8");
    } catch {
      current = "";
    }
    await writeFile(filePath, current + entry, "utf8");
    return filePath;
  }

  async readDaily(daysBack = 2): Promise<string> {
    const sections: string[] = [];
    for (let i = 0; i < daysBack; i += 1) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const filePath = this.dailyPath(date);
      try {
        sections.push(`\n### 记忆: ${dateStamp(date)}`);
        sections.push((await readFile(filePath, "utf8")).slice(0, 2000));
      } catch {
        // Missing daily memory is normal.
      }
    }
    return sections.join("\n");
  }

  async getInjectableContext(): Promise<string> {
    const parts: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      try {
        const content = (await readFile(this.dailyPath(date), "utf8")).slice(0, 2000);
        const filtered = this.filterDailyEntriesForSystem(content);
        if (filtered) {
          parts.push(`\n### 记忆: ${dateStamp(date)}`);
          parts.push(filtered);
        }
      } catch {
        // Missing daily memory is normal.
      }
    }
    return parts.join("\n");
  }

  private filterDailyEntriesForSystem(content: string): string {
    const blocked = ["**评分**", "**分析**", "**策略**", "**上下文**", "**文字批注**"];
    return content
      .split(/(?=^## )/m)
      .map((section) => section.trimEnd())
      .filter((section) => section.trim() && !blocked.some((marker) => section.includes(marker)))
      .join("\n")
      .trim();
  }

  longTermPath(): string {
    return path.join(this.memoryDir, "MEMORY.md");
  }

  async writeLongTerm(content: string): Promise<void> {
    let current = "";
    try {
      current = await readFile(this.longTermPath(), "utf8");
    } catch {
      current = "";
    }
    const date = new Date();
    const entry = `\n## ${dateStamp(date)} ${timeStamp(date).slice(0, 5)}\n${content}\n`;
    await writeFile(this.longTermPath(), current + entry, "utf8");
  }

  async readLongTerm(): Promise<string> {
    try {
      return await readFile(this.longTermPath(), "utf8");
    } catch {
      return "";
    }
  }

  outputsPath(): string {
    return path.join(this.memoryDir, ".outputs", "outputs.json");
  }

  async recordOutput(input: Omit<OutputRecord, "timestamp"> & { timestamp?: string }): Promise<OutputRecord> {
    await this.ensureLayout();
    const record: OutputRecord = {
      outputId: input.outputId,
      topic: input.topic ?? "",
      prompt: input.prompt,
      response: input.response,
      matchedSkills: input.matchedSkills ?? [],
      toolCalls: input.toolCalls ?? [],
      sessionId: input.sessionId ?? null,
      timestamp: input.timestamp ?? nowIso(),
    };
    const existing = (await readJsonList(this.outputsPath()))
      .map(outputFromDisk)
      .filter((item) => item.outputId !== record.outputId);
    existing.push(record);
    await writeJsonList(this.outputsPath(), existing.slice(-200).map(outputToDisk));
    return record;
  }

  async getOutput(outputId: string): Promise<OutputRecord | null> {
    const records = (await readJsonList(this.outputsPath())).map(outputFromDisk);
    for (const record of records.reverse()) {
      if (record.outputId === outputId) {
        return record;
      }
    }
    return null;
  }

  annotationLedgerPath(): string {
    return path.join(this.memoryDir, ".annotations", "ledger.json");
  }

  legacyJudgmentsPath(): string {
    return path.join(this.memoryDir, ".dreams", "short-term-recall.json");
  }

  async listAnnotationRecords(): Promise<JudgmentRecord[]> {
    const records = (await readJsonList(this.annotationLedgerPath())).map(judgmentFromDisk);
    if (records.length > 0) {
      return records;
    }
    return (await readJsonList(this.legacyJudgmentsPath())).map(judgmentFromDisk);
  }

  async getRecentJudgments(count = 3): Promise<JudgmentRecord[]> {
    return (await this.listAnnotationRecords()).slice(-count);
  }

  private async writeAnnotationRecords(records: JudgmentRecord[]): Promise<void> {
    const diskRecords = records.map(judgmentToDisk);
    await writeJsonList(this.annotationLedgerPath(), diskRecords);
    await writeJsonList(this.legacyJudgmentsPath(), diskRecords);
  }

  async recordJudgment(input: {
    outputId: string;
    score: number;
    context?: string;
    comment?: string;
  }): Promise<JudgmentRecord> {
    await this.ensureLayout();
    const output = await this.getOutput(input.outputId);
    const selected = (input.context ?? "").trim();
    const comment = (input.comment ?? "").trim();
    const fullOutput = output?.response.trim() ?? "";
    const excerpt = this.buildContextExcerpt(fullOutput, selected, DEFAULT_CONTEXT_WINDOW_CHARS);
    const record: JudgmentRecord = {
      outputId: input.outputId,
      score: input.score,
      context: excerpt.context,
      contextSource: selected ? "selected_text" : "full_output",
      quote: excerpt.quote,
      leftContext: excerpt.leftContext,
      rightContext: excerpt.rightContext,
      contextWindowChars: DEFAULT_CONTEXT_WINDOW_CHARS,
      comment: comment.slice(0, 1000),
      commentSource: comment ? "user_comment" : "none",
      topic: output?.topic ?? "",
      matchedSkills: output?.matchedSkills ?? [],
      timestamp: nowIso(),
    };
    const records = await this.listAnnotationRecords();
    records.push(record);
    await this.writeAnnotationRecords(records);
    return record;
  }

  preferencesPath(): string {
    return path.join(this.memoryDir, ".preferences.json");
  }

  async getPromotedPreferences(): Promise<Record<string, unknown>[]> {
    const payload = await readJsonObject(this.preferencesPath(), { candidates: [], promoted: [] });
    return Array.isArray(payload.promoted) ? payload.promoted.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
  }

  async readPreferences(): Promise<{ candidates: Record<string, unknown>[]; promoted: Record<string, unknown>[] }> {
    const payload = await readJsonObject(this.preferencesPath(), { candidates: [], promoted: [] });
    return {
      candidates: Array.isArray(payload.candidates) ? payload.candidates.filter(isMutableRecord) : [],
      promoted: Array.isArray(payload.promoted) ? payload.promoted.filter(isMutableRecord) : [],
    };
  }

  async updatePreferences(judgment: JudgmentRecord, reflection: { intentHypothesis?: string }): Promise<PreferenceUpdate> {
    if (![1, 2, 6, 7].includes(judgment.score)) {
      return { updated: false, promoted: [] };
    }
    const polarity = judgment.score >= 6 ? "prefer" : "avoid";
    const signal = this.derivePreferenceSignal(judgment, reflection);
    if (!signal) {
      return { updated: false, promoted: [] };
    }

    const key = `${polarity}:${judgment.topic}:${compactSignal(signal)}`;
    const payload = await readJsonObject(this.preferencesPath(), { candidates: [], promoted: [] });
    const candidates = Array.isArray(payload.candidates) ? payload.candidates.filter(isMutableRecord) : [];
    const promoted = Array.isArray(payload.promoted) ? payload.promoted.filter(isMutableRecord) : [];

    if (promoted.some((entry) => entry.key === key)) {
      return { updated: false, promoted: [] };
    }

    let candidate = candidates.find((entry) => entry.key === key);
    if (!candidate) {
      candidate = {
        id: `pref_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`,
        key,
        polarity,
        signal: signal.slice(0, 200),
        topic: judgment.topic,
        count: 0,
        confidence: 0,
        evidence: [],
        first_seen: nowIso(),
        last_seen: nowIso(),
      };
      candidates.push(candidate);
    }

    const evidence = {
      output_id: judgment.outputId,
      score: judgment.score,
      context: judgment.context.slice(0, 200),
      comment: judgment.comment.slice(0, 200),
      timestamp: nowIso(),
    };
    const evidenceList = Array.isArray(candidate.evidence) ? candidate.evidence.filter(isMutableRecord) : [];
    if (evidenceList.some((entry) => entry.output_id === evidence.output_id)) {
      await writeJsonObject(this.preferencesPath(), { candidates, promoted });
      return { updated: false, promoted: [] };
    }

    evidenceList.push(evidence);
    candidate.evidence = evidenceList.slice(-8);
    candidate.count = Number(candidate.count ?? 0) + 1;
    candidate.last_seen = nowIso();
    candidate.confidence = Math.min(0.95, 0.25 + 0.2 * Number(candidate.count));

    const promotedNow: Record<string, unknown>[] = [];
    if (Number(candidate.count) >= 3) {
      const promotedEntry = {
        ...candidate,
        promoted_at: nowIso(),
        status: "promoted",
      };
      promoted.push(promotedEntry);
      promotedNow.push(promotedEntry);
      await this.writePreferenceToLongTerm(promotedEntry);
      await writeJsonObject(this.preferencesPath(), {
        candidates: candidates.filter((entry) => entry.key !== key),
        promoted,
      });
      return { updated: true, promoted: promotedNow };
    }

    await writeJsonObject(this.preferencesPath(), { candidates, promoted });
    return { updated: true, promoted: promotedNow };
  }

  private buildContextExcerpt(fullOutput: string, selected: string, windowChars: number): {
    context: string;
    quote: string;
    leftContext: string;
    rightContext: string;
  } {
    if (!selected) {
      const context = fullOutput.slice(0, 2000);
      return {
        context,
        quote: context,
        leftContext: "",
        rightContext: "",
      };
    }

    const matchIndex = fullOutput.indexOf(selected);
    if (matchIndex === -1) {
      return {
        context: selected.slice(0, 2000),
        quote: selected,
        leftContext: "",
        rightContext: "",
      };
    }

    const leftStart = Math.max(0, matchIndex - windowChars);
    const rightEnd = Math.min(fullOutput.length, matchIndex + selected.length + windowChars);

    return {
      context: selected.slice(0, 2000),
      quote: selected,
      leftContext: fullOutput.slice(leftStart, matchIndex),
      rightContext: fullOutput.slice(matchIndex + selected.length, rightEnd),
    };
  }

  private derivePreferenceSignal(judgment: JudgmentRecord, reflection: { intentHypothesis?: string }): string {
    const polarity = judgment.score >= 6 ? "prefer" : "avoid";
    if (judgment.comment) {
      return judgment.context
        ? `${polarity}:${judgment.context} => ${judgment.comment}`.slice(0, 240)
        : `${polarity}:${judgment.comment}`.slice(0, 240);
    }
    if (judgment.context) {
      return `${polarity}:${judgment.context}`.slice(0, 240);
    }
    return (reflection.intentHypothesis ?? "").trim().slice(0, 240);
  }

  private async writePreferenceToLongTerm(pref: Record<string, unknown>): Promise<void> {
    const evidence = Array.isArray(pref.evidence) ? pref.evidence.filter(isMutableRecord) : [];
    const evidenceLines = evidence.map((item) => {
      const comment = item.comment ? ` | comment:${String(item.comment)}` : "";
      return `- ${String(item.timestamp ?? "")} | ${String(item.output_id ?? "")} | score:${String(item.score ?? "")} | ${String(item.context ?? "")}${comment}`;
    });
    await this.writeLongTerm([
      `**偏好**: [${String(pref.polarity ?? "")}] ${String(pref.signal ?? "")}`,
      `**主题**: ${String(pref.topic ?? "")}`,
      `**置信度**: ${Number(pref.confidence ?? 0).toFixed(2)}`,
      "**证据**:",
      ...evidenceLines,
    ].join("\n"));
  }

  async getSkillFeedbackBoosts(maxItems = 12): Promise<Record<string, number>> {
    const records = await this.listAnnotationRecords();
    const boosts: Record<string, number> = {};
    records.slice(-maxItems).reverse().forEach((record, index) => {
      const weight = Math.max(0.2, 1.0 - index * 0.08);
      const delta = record.score >= 6 ? 0.12 * weight : record.score <= 2 ? -0.18 * weight : 0;
      if (delta === 0) {
        return;
      }
      record.matchedSkills.forEach((name) => {
        boosts[name] = (boosts[name] ?? 0) + delta;
      });
    });
    for (const [name, value] of Object.entries(boosts)) {
      boosts[name] = Math.max(-0.3, Math.min(0.3, value));
    }
    return boosts;
  }

  async getRecentSkillJudgments(skillName: string, limit = 8): Promise<JudgmentRecord[]> {
    return (await this.listAnnotationRecords())
      .reverse()
      .filter((record) => record.matchedSkills.includes(skillName))
      .slice(0, limit);
  }

  proposalsPath(): string {
    return path.join(this.memoryDir, ".evolog", "proposals.json");
  }

  evologDailyPath(date = new Date()): string {
    return path.join(this.memoryDir, ".evolog", `${dateStamp(date)}.md`);
  }

  async recordEvolutionProposal<T extends Record<string, unknown>>(proposal: T): Promise<T> {
    const proposals = await readJsonList(this.proposalsPath());
    const key = String(proposal.key ?? "");
    if (key) {
      const existing = proposals.find((entry) => entry.key === key);
      if (existing) {
        return existing as T;
      }
    }
    proposals.push(proposal);
    await writeJsonList(this.proposalsPath(), proposals);
    return proposal;
  }

  async readEvolutionProposals(): Promise<Record<string, unknown>[]> {
    return await readJsonList(this.proposalsPath());
  }
}

function isMutableRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
