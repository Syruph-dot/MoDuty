import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Reflection } from "./types.js";

export interface ReplayStep {
  outputId: string;
  outputText: string;
  score: number;
  annotatedText: string;
  reflection: Reflection;
  nextOutput: string;
}

export async function writeReplayRecord(input: {
  topic: string;
  steps: ReplayStep[];
  path?: string;
  logsDir?: string;
}): Promise<string> {
  const recordPath = input.path ?? path.join(
    input.logsDir ?? path.resolve("logs"),
    `replay-${timestampForFile()}.md`,
  );
  await mkdir(path.dirname(recordPath), { recursive: true });

  const lines = [
    "# MOMOKA 回放记录",
    `主题: ${input.topic}`,
    "",
  ];

  input.steps.forEach((step, index) => {
    lines.push(
      `## Step ${index + 1}`,
      `- output_id: ${step.outputId}`,
      `- score: ${step.score}`,
      `- annotated_text: ${step.annotatedText}`,
      "",
      "### output",
      step.outputText,
      "",
      "### reflection",
      `- stance: ${step.reflection.stance}`,
      `- strategy: ${step.reflection.nextGuessStrategy}`,
      `- intent: ${step.reflection.intentHypothesis}`,
      `- instruction: ${step.reflection.nextGuessInstruction}`,
      "",
      "### next_output",
      step.nextOutput,
      "",
    );
  });

  await writeFile(recordPath, lines.join("\n"), "utf8");
  return recordPath;
}

function timestampForFile(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
