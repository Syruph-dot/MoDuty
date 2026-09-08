import re

with open("desktop/src/components/AgentWindow.tsx", "r", encoding="utf-8") as f:
    content = f.read()

# 1. Add reasoning to DisplayMessage interface
old_interface = """interface DisplayMessage {
  key: string;
  role: "user" | "agent" | "tool";
  content: string;
  status?: string;
  toolCard?: {
    name: string;
    args: string;
    status: "running" | "done";
    result?: string;
    collapsed: boolean;
  };
}"""

new_interface = """interface DisplayMessage {
  key: string;
  role: "user" | "agent" | "tool";
  content: string;
  status?: string;
  /** 推理/思考内容（流式累积，独立于 content） */
  reasoning?: string;
  toolCard?: {
    name: string;
    args: string;
    status: "running" | "done";
    result?: string;
    collapsed: boolean;
  };
}"""

if old_interface in content:
    content = content.replace(old_interface, new_interface)
    print("1. DisplayMessage interface updated")
else:
    print("1. Interface not found!")

# 2. Add onReasoning handler in runChatStream call
old_onToken = """          onToken: (chunk) => {
            tokenBuffer += chunk;
            if (tokenRaf === null) {
              tokenRaf = requestAnimationFrame(flushTokens);
            }
          },
          onToolStart:"""

new_onToken = """          onToken: (chunk) => {
            tokenBuffer += chunk;
            if (tokenRaf === null) {
              tokenRaf = requestAnimationFrame(flushTokens);
            }
          },
          onReasoning: (chunk) => {
            // 推理内容直接追加到当前 agent 消息的 reasoning 字段
            setMessages((prev) =>
              prev.map((m) =>
                m.key === currentAgentKey
                  ? { ...m, reasoning: (m.reasoning ?? "") + chunk }
                  : m,
              ),
            );
          },
          onToolStart:"""

if old_onToken in content:
    content = content.replace(old_onToken, new_onToken)
    print("2. onReasoning handler added")
else:
    print("2. onToken handler not found!")

# 3. Update MessageItem to display reasoning content
old_return = """  return (
    <div className={`msg msg--${message.role}`}>
      <div className="msg__bubble" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );"""

new_return = """  return (
    <div className={`msg msg--${message.role}`}>
      <div className="msg__bubble" dangerouslySetInnerHTML={{ __html: html }} />
      {message.reasoning ? (
        <details className="msg__reasoning" open>
          <summary className="msg__reasoning-summary">💭 思考过程</summary>
          <div className="msg__reasoning-content">{message.reasoning}</div>
        </details>
      ) : null}
    </div>
  );"""

if old_return in content:
    content = content.replace(old_return, new_return)
    print("3. MessageItem updated")
else:
    print("3. Return statement not found!")

with open("desktop/src/components/AgentWindow.tsx", "w", encoding="utf-8") as f:
    f.write(content)

print("Done!")