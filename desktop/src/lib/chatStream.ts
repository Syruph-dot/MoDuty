/** /api/agents/:id/chat 的 SSE 流式客户端（fetch reader 解析 data: 帧，支持 abort） */

export interface ChatStreamHandlers {
  onToken(text: string): void;
  onReasoning(text: string): void;
  onToolStart(name: string, args: string): void;
  onToolResult(name: string, result: string): void;
  onPolicyNotice?(text: string): void;
  onExperienceRecall?(text: string): void;
  onApprovalRequested(name: string, args: string): void;
  onQuestionRequested?(name: string, args: string): void;
  onDone(): void;
  onError(message: string): void;
}

export async function runChatStream(
  base: string,
  agentId: string,
  message: string,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
  attachments: ReadonlyArray<{ id: string }> = [],
): Promise<void> {
  const res = await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(attachments.length > 0 ? { message, attachments } : { message }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`chat request failed: ${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ")) {
          continue;
        }
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line.slice(6)) as Record<string, unknown>;
        } catch {
          continue;
        }
        switch (frame.type) {
          case "token":
            handlers.onToken(String(frame.text ?? ""));
            break;
          case "reasoning":
            handlers.onReasoning(String(frame.text ?? ""));
            break;
          case "tool_start":
            handlers.onToolStart(String(frame.name ?? ""), String(frame.args ?? "{}"));
            break;
          case "tool_result":
            handlers.onToolResult(String(frame.name ?? ""), String(frame.result ?? ""));
            break;
          case "policy_notice":
            handlers.onPolicyNotice?.(String(frame.text ?? ""));
            break;
          case "experience_recall":
            handlers.onExperienceRecall?.(String(frame.text ?? ""));
            break;
          case "approval_requested":
            handlers.onApprovalRequested(String(frame.name ?? ""), String(frame.args ?? "{}"));
            break;
          case "question_requested":
            handlers.onQuestionRequested?.(String(frame.name ?? ""), String(frame.args ?? "{}"));
            break;
          case "done":
            handlers.onDone();
            break;
          case "error":
            handlers.onError(String(frame.error ?? "unknown error"));
            break;
        }
      }
    }
  }
}
