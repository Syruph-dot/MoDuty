import { mkdir } from "node:fs/promises";
import path from "node:path";

import { judgmentFromDisk, judgmentToDisk, outputFromDisk, outputToDisk } from "./casing.js";
import { readJsonList, writeJsonList } from "./json-file.js";
import type { JudgmentRecord, OutputRecord } from "./types.js";

const CONTEXT_WINDOW_CHARS = 20;

export class MemoryStore {
  constructor(readonly memoryDir: string) { this.memoryDir = path.resolve(memoryDir); }
  outputsPath() { return path.join(this.memoryDir, ".outputs", "outputs.json"); }
  annotationLedgerPath() { return path.join(this.memoryDir, ".annotations", "ledger.json"); }

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
}
