export interface TurnPolicy {
  allowWorkspaceReads: boolean;
  allowSessionHistory: boolean;
  allowLongTermRecall: boolean;
  allowExperienceRecall: boolean;
  allowExperienceCapture: boolean;
}

const FILE_READ_PROHIBITION = /(?:不要|别|禁止|严禁|不得|不许|do not|don't)\s*.{0,24}?(?:读取|读|查看|打开|访问|搜索|检索|read|open|inspect|search|scan)\s*.{0,24}?(?:项目|工作区|本地|目录)?\s*(?:文件|文档|资料|files?|documents?)/iu;
const HISTORY_PROHIBITION = /(?:不要|别|禁止|严禁|不得|不许|do not|don't)\s*.{0,28}?(?:搜索|查找|查询|检索|读取|引用|参考|使用|search|find|query|retrieve|read|cite|reference|use)\s*.{0,28}?(?:以前|以往|历史|过往|previous|past|historical)\s*.{0,12}?(?:会话|对话|记录|sessions?|conversations?|history)/iu;
const HISTORY_ONLY_PROHIBITION = /(?:不要|别|禁止|严禁|不得|不许|do not|don't)\s*.{0,18}?(?:查|搜索|查询|检索|引用|参考|读取|使用|search|query|retrieve|cite|reference|read|use)\s*.{0,12}?(?:历史|以前|以往|过往|previous|past|history)/iu;
const MEMORY_USE_PROHIBITION = /(?:不要|别|禁止|严禁|不得|不许|do not|don't)\s*.{0,24}?(?:使用|调用|读取|检索|注入|参考|use|call|read|retrieve|inject|reference)\s*.{0,32}?(?:工作)?(?:经验|长期)?\s*(?:记忆|经验|memory|experience)/iu;
const MEMORY_SAVE_PROHIBITION = /(?:不要|别|禁止|严禁|不得|不许|do not|don't)\s*.{0,24}?(?:保存|记录|写入|沉淀|采集|save|store|record|capture)\s*.{0,32}?(?:长期|用户|工作)?\s*(?:记忆|经验|memory|experience)/iu;

export function resolveTurnPolicy(message: string): TurnPolicy {
  const normalized = message.normalize("NFKC").replace(/[\/、|]+/gu, " ");
  const disallowWorkspaceReads = FILE_READ_PROHIBITION.test(normalized);
  const disallowHistory = HISTORY_PROHIBITION.test(normalized) || HISTORY_ONLY_PROHIBITION.test(normalized);
  const disallowMemoryUse = MEMORY_USE_PROHIBITION.test(normalized);
  const disallowMemorySave = MEMORY_SAVE_PROHIBITION.test(normalized);

  return {
    allowWorkspaceReads: !disallowWorkspaceReads,
    allowSessionHistory: !disallowHistory,
    allowLongTermRecall: !disallowHistory && !disallowMemoryUse,
    allowExperienceRecall: !disallowHistory && !disallowMemoryUse,
    allowExperienceCapture: !disallowMemorySave,
  };
}

export function blockedToolsForTurnPolicy(policy: TurnPolicy): string[] {
  const blocked = new Set<string>();
  if (!policy.allowWorkspaceReads) {
    for (const name of ["read_file", "list_files", "search_files", "run_shell"]) blocked.add(name);
  }
  if (!policy.allowSessionHistory) {
    for (const name of ["search_sessions", "inspect_session", "read_session", "search_content"]) blocked.add(name);
  }
  return [...blocked];
}

export function hasTurnPolicyRestrictions(policy: TurnPolicy): boolean {
  return !policy.allowWorkspaceReads
    || !policy.allowSessionHistory
    || !policy.allowLongTermRecall
    || !policy.allowExperienceRecall
    || !policy.allowExperienceCapture;
}
