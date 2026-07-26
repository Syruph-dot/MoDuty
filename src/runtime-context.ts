import type {
  AnnotationRuntimeBundle,
  JudgmentRecord,
  OutputAssessment,
  RuntimeEnvelope,
} from "./types.js";
import type { MemoryStore } from "./memory.js";

export class AnnotationRuntimeController {
  constructor(private readonly memoryStore: MemoryStore) {}

  async buildRuntimeBundle(input: {
    userMessage: string;
    topic?: string;
    limit?: number;
  }): Promise<AnnotationRuntimeBundle> {
    const records = await this.memoryStore.listAnnotationRecords();
    const relevant = this.selectRelevantRecords(
      records,
      input.userMessage,
      input.topic ?? "",
      input.limit ?? 12,
    );
    const promoted = await this.memoryStore.getPromotedPreferences();
    return {
      topic: input.topic ?? "",
      ledgerSize: records.length,
      relevantAnnotations: relevant,
      promotedPreferences: promoted
        .filter((pref) => !input.topic || pref.topic === input.topic)
        .slice(0, 8),
      rules: this.synthesizeRules(relevant),
      conversationHistory: "",
    };
  }

  renderRuntimeContext(bundle: AnnotationRuntimeBundle): string {
    const lines = ["## 批注账本规则", `- ledger_size: ${bundle.ledgerSize}`];

    if (bundle.promotedPreferences.length > 0) {
      lines.push("- promoted_preferences:");
      bundle.promotedPreferences.slice(0, 6).forEach((pref) => {
        lines.push(`  - [${String(pref.polarity ?? "")}] ${String(pref.signal ?? "")} (topic: ${String(pref.topic ?? "")})`);
      });
    }

    if (bundle.rules.length > 0) {
      lines.push("- synthesized_rules:");
      bundle.rules.forEach((rule) => lines.push(`  - ${rule}`));
    }

    if (bundle.relevantAnnotations.length > 0) {
      lines.push("- relevant_annotations:");
      bundle.relevantAnnotations.slice(0, 8).forEach((annotation) => {
        const parts = [
          `score:${annotation.score}`,
          annotation.context,
          `quote:${annotation.quote}`,
          `left:${annotation.leftContext}`,
          `right:${annotation.rightContext}`,
        ];
        if (annotation.comment) {
          parts.push(`comment:${annotation.comment}`);
        }
        lines.push(`  - ${parts.join(" | ")}`);
      });
    }

    return lines.join("\n");
  }

  buildRuntimeInput(input: {
    conversationHistory?: string;
    runtimeContext: string;
    userMessage: string;
    requestHeading?: string;
  }): string {
    const parts: string[] = [];
    if (input.conversationHistory) {
      parts.push(input.conversationHistory);
    }
    if (input.runtimeContext) {
      parts.push(input.runtimeContext);
    }
    parts.push(`## ${input.requestHeading ?? "当前用户请求"}\n${input.userMessage}`);
    return parts.join("\n\n");
  }

  async buildRuntimeEnvelope(input: {
    userMessage: string;
    topic?: string;
    requestHeading?: string;
    limit?: number;
    conversationHistory?: string;
  }): Promise<RuntimeEnvelope> {
    const bundle = await this.buildRuntimeBundle({
      userMessage: input.userMessage,
      topic: input.topic,
      limit: input.limit,
    });
    bundle.conversationHistory = input.conversationHistory ?? "";
    const runtimeContext = this.renderRuntimeContext(bundle);
    return {
      bundle,
      conversationHistory: bundle.conversationHistory,
      runtimeContext,
      runtimeInput: this.buildRuntimeInput({
        conversationHistory: bundle.conversationHistory,
        runtimeContext,
        userMessage: input.userMessage,
        requestHeading: input.requestHeading,
      }),
    };
  }

  assessOutput(bundle: AnnotationRuntimeBundle, outputText: string): OutputAssessment {
    const text = outputText.trim();
    const reasons: string[] = [];
    const revisionRules: string[] = [];

    bundle.relevantAnnotations.forEach((annotation) => {
      if (annotation.score <= 2 && annotation.context && text.includes(annotation.context)) {
        reasons.push(`hit low-score annotation guardrail: ${annotation.context}`);
        if (annotation.comment) {
          revisionRules.push(`avoid \`${annotation.context}\`, prefer: ${annotation.comment}`);
        } else {
          revisionRules.push(`avoid reusing \`${annotation.context}\``);
        }
      }
    });

    if (reasons.length === 0) {
      return {
        action: "accept",
        reasons: [],
        revisionPrompt: "",
      };
    }

    const revisionPrompt = [
      "## 输出修订指令",
      "当前输出命中了低分批注禁区，请直接重写这一轮输出。",
      "要求：",
      ...revisionRules.map((rule) => `- ${rule}`),
      "",
      "## 待修订输出",
      text || "(空输出)",
    ].join("\n");

    return {
      action: "revise",
      reasons,
      revisionPrompt,
    };
  }

  buildRevisionInput(input: {
    runtimeContext: string;
    requestHeading: string;
    requestText: string;
    assessment: OutputAssessment;
  }): string {
    const parts: string[] = [];
    if (input.runtimeContext) {
      parts.push(input.runtimeContext);
    }
    parts.push(`## ${input.requestHeading}\n${input.requestText}`);
    if (input.assessment.revisionPrompt) {
      parts.push(input.assessment.revisionPrompt);
    }
    return parts.join("\n\n");
  }

  private selectRelevantRecords(
    records: JudgmentRecord[],
    userMessage: string,
    topic: string,
    limit: number,
  ): JudgmentRecord[] {
    const message = userMessage.toLowerCase();
    const filtered: Array<[number, number, JudgmentRecord]> = [];

    records.forEach((record, index) => {
      let score = 0;
      const recordTopic = record.topic.toLowerCase();
      if (topic && record.topic === topic) {
        score += 4;
      }
      if (recordTopic && message.includes(recordTopic)) {
        score += 2;
      }
      const comment = record.comment.toLowerCase();
      const context = record.context.toLowerCase();
      const tokens = message.split(/\s+/u).filter(Boolean);
      if (tokens.some((token) => comment.includes(token))) {
        score += 1;
      }
      if (tokens.some((token) => context.includes(token))) {
        score += 1;
      }
      if (score > 0 || (topic && record.topic === topic)) {
        filtered.push([score, index, record]);
      }
    });

    if (filtered.length > 0) {
      return filtered
        .sort((a, b) => b[0] - a[0] || b[1] - a[1])
        .slice(0, limit)
        .map(([, , record]) => record);
    }
    return records.slice(-limit);
  }

  private synthesizeRules(records: JudgmentRecord[]): string[] {
    const grouped = new Map<string, string[]>();
    records.forEach((record) => {
      const label = record.score >= 6 ? "prefer" : record.score <= 2 ? "avoid" : "adjust";
      const value = record.comment
        ? record.context
          ? `${record.context} => ${record.comment}`
          : record.comment
        : record.context;
      if (!value) {
        return;
      }
      grouped.set(label, [...(grouped.get(label) ?? []), value]);
    });

    const lines: string[] = [];
    for (const label of ["prefer", "avoid", "adjust"]) {
      const seen: string[] = [];
      for (const value of grouped.get(label) ?? []) {
        if (!seen.includes(value)) {
          seen.push(value);
        }
      }
      seen.slice(0, 6).forEach((value) => lines.push(`[${label}] ${value}`));
    }
    return lines;
  }
}
