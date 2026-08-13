import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { judgmentFromDisk, judgmentToDisk, outputFromDisk, outputToDisk } from "./casing.js";
import { readJsonList, writeJsonList } from "./json-file.js";
import type { JudgmentRecord, OutputRecord } from "./types.js";

const CONTEXT_WINDOW_CHARS = 20;

export interface LongTermMemoryEntry {
  id: string;
  content: string;
  topic: string;
  source: "judgment" | "explicit";
  outputId?: string;
  createdAt: string;
  lastAccessedAt?: string;
  accessCount: number;
  [key: string]: unknown;
}

const LONG_TERM_MAX_ENTRIES = 500;
const PROMOTE_SCORE = 6;
const PROMOTE_MAX_CHARS = 300;

export class MemoryStore {
  constructor(readonly memoryDir: string) { this.memoryDir = path.resolve(memoryDir); }
  outputsPath() { return path.join(this.memoryDir, ".outputs", "outputs.json"); }
  annotationLedgerPath() { return path.join(this.memoryDir, ".annotations", "ledger.json"); }
  longTermPath() { return path.join(this.memoryDir, ".long-term.json"); }

  async recordOutput(input: Omit<OutputRecord, "timestamp"> & { timestamp?: string }): Promise<OutputRecord> {
    await mkdir(path.dirname(this.outputsPath()), { recursive: true });
    const record: OutputRecord = { ...input, timestamp: input.timestamp ?? new Date().toISOString() };
    const records = (await readJsonList(this.outputsPath())).map(outputFromDisk).filter((item) => item.outputId !== record.outputId);
    records.push(record);
    await writeJsonList(this.outputsPath(), records.slice(-200).map(outputToDisk));
    return record;
  }

  async getOutput(outputId: string): Promise<OutputRecord | null> {
    return (await readJsonList(this.outputsPath())).map(outputFromDisk).reverse().find((item) => item.outputId === outputId) ?? null;
  }

  async recordJudgment(input: { outputId: string; score: number; context?: string; comment?: string }): Promise<JudgmentRecord> {
    await mkdir(path.dirname(this.annotationLedgerPath()), { recursive: true });
    const output = await this.getOutput(input.outputId);
    const selected = (input.context ?? "").trim();
    const full = output?.response.trim() ?? "";
    const index = selected ? full.indexOf(selected) : 0;
    const quote = selected || full.slice(0, 2000);
    const record: JudgmentRecord = {
      outputId: input.outputId, score: input.score, context: quote, contextSource: selected ? "selected_text" : "full_output", quote,
      leftContext: selected && index >= 0 ? full.slice(Math.max(0, index - CONTEXT_WINDOW_CHARS), index) : "",
      rightContext: selected && index >= 0 ? full.slice(index + selected.length, index + selected.length + CONTEXT_WINDOW_CHARS) : "",
      contextWindowChars: CONTEXT_WINDOW_CHARS, comment: (input.comment ?? "").trim().slice(0, 1000), commentSource: input.comment?.trim() ? "user_comment" : "none",
      topic: output?.topic ?? "", matchedSkills: [], timestamp: new Date().toISOString(),
    };
    const records = (await readJsonList(this.annotationLedgerPath())).map(judgmentFromDisk);
    records.push(record);
    await writeJsonList(this.annotationLedgerPath(), records.map(judgmentToDisk));
    return record;
  }

  /**
   * 长期记忆：批注晋升。高分（≥6）或带用户批注的判断自动沉淀为跨会话记忆。
   * 返回 null 表示没有值得记忆的内容或已存在相同记忆（去重）。
   */
  async promoteToLongTerm(judgment: JudgmentRecord): Promise<LongTermMemoryEntry | null> {
    const content = (judgment.comment || judgment.quote || "").trim().slice(0, PROMOTE_MAX_CHARS);
    if (!content) return null;
    const worthy = judgment.score >= PROMOTE_SCORE || judgment.commentSource === "user_comment";
    if (!worthy) return null;
    const records = await this.readLongTerm();
    if (records.some((record) => record.content === content)) return null;
    const entry: LongTermMemoryEntry = {
      id: `mem_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      content,
      topic: judgment.topic ?? "",
      source: "judgment",
      outputId: judgment.outputId,
      createdAt: new Date().toISOString(),
      accessCount: 0,
    };
    records.push(entry);
    await writeJsonList(this.longTermPath(), records.slice(-LONG_TERM_MAX_ENTRIES));
    return entry;
  }

  /** 按 topic 关键词检索长期记忆（命中更新访问统计），返回最多 limit 条 */
  async searchLongTerm(topic: string, limit = 3): Promise<LongTermMemoryEntry[]> {
    const records = await this.readLongTerm();
    if (records.length === 0 || !topic) return [];
    const topicLower = topic.toLowerCase();
    const keywords = topicLower
      .split(/[\s,，。;；:：/\\]+/u)
      .map((word) => word.trim())
      .filter((word) => word.length >= 2);
    const scored = records.map((record) => {
      const contentLower = record.content.toLowerCase();
      const topicOfRecord = (record.topic ?? "").toLowerCase();
      let score = 0;
      if (contentLower.includes(topicLower) || topicOfRecord.includes(topicLower)) score += 3;
      for (const keyword of keywords) {
        if (contentLower.includes(keyword) || topicOfRecord.includes(keyword)) score += 1;
      }
      return { record, score };
    });
    const hits = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
    if (hits.length > 0) {
      const now = new Date().toISOString();
      for (const hit of hits) {
        hit.record.lastAccessedAt = now;
        hit.record.accessCount = (hit.record.accessCount ?? 0) + 1;
      }
      await writeJsonList(this.longTermPath(), records);
    }
    return hits.map((hit) => hit.record);
  }

  private async readLongTerm(): Promise<LongTermMemoryEntry[]> {
    const parsed = await readJsonList(this.longTermPath());
    return Array.isArray(parsed) ? parsed.filter(isLongTermEntry) : [];
  }
}

function isLongTermEntry(value: unknown): value is LongTermMemoryEntry {
  return typeof value === "object" && value !== null
    && typeof (value as LongTermMemoryEntry).id === "string"
    && typeof (value as LongTermMemoryEntry).content === "string";
}
