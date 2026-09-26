/**
 * 客观验收层（P5）：在「agent 说完成了」与「系统标记完成」之间加一道可检查的关卡。
 *
 * 背景：值日生的 deliver / continue 判读本质是 LLM 判断，系统层面没有任何客观证据。
 * 这里提供一组**可插拔检查器**，结果作为证据喂给判读，并在交付前强制把「明显没做到」拦下来。
 *
 * 设计要点：
 * - 纯逻辑 + 依赖注入的 IO（`VerifyIo`），因此可以在不碰文件系统的前提下测；
 * - 验收标准与检查器的对应关系是**显式映射**（关键词表），映射不上的标准不会被静默忽略，
 *   而是记入 `unmappedCriteria` 并把结论降级为 `warn`，交给人看；
 * - `applyVerdictPolicy` 是唯一的策略出口：客观检查失败时不允许直接交付，除非返工已到上限。
 */

export interface VerifyIo {
  /** 文件是否存在且可读（返回大小或 null） */
  fileSize: (absoluteOrRelativePath: string) => Promise<number | null>;
  /** 读取文本产物（不存在返回 null） */
  readText?: (absoluteOrRelativePath: string) => Promise<string | null>;
}

export interface VerificationCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  /** 该检查依据的产物/来源 */
  sourceRefs?: string[];
}

export type VerificationVerdict = "pass" | "warn" | "fail";

export interface VerificationReport {
  stepId?: string;
  verdict: VerificationVerdict;
  checks: VerificationCheck[];
  /** 未通过检查的可读描述（直接进驳回理由） */
  failures: string[];
  /** 验收标准里没有对应检查器的条目（需要人工判断） */
  unmappedCriteria: string[];
  /** 供判读上下文使用的证据块 */
  evidence: string;
}

export interface VerifyStepInput {
  stepId?: string;
  /** 计划步声明的产物路径（相对 workspace 或绝对） */
  artifacts: string[];
  /** 计划步声明的验收标准 */
  acceptanceCriteria: string[];
  /** 执行者最近一次测试输出（若有） */
  testOutput?: string;
  /** 需要校验结构的 JSON 产物（路径 → 必填字段） */
  schemaExpectations?: Array<{ path: string; requiredKeys: string[] }>;
  /** 是否要求产物里出现引用/来源标注 */
  requireCitations?: boolean;
  /** 当前是否还有未决审批 / 未决提问 / 未落地写入 */
  hasPendingApproval?: boolean;
  hasPendingQuestion?: boolean;
  unresolvedWrites?: string[];
  io: VerifyIo;
}

/** 验收标准 → 检查器的关键词映射（映射不上就会进 unmappedCriteria） */
const CRITERIA_ROUTES: Array<{ checkId: string; pattern: RegExp }> = [
  { checkId: "artifactsExist", pattern: /(产物|文件|保存到|输出成|路径|目录)/u },
  { checkId: "testsPassed", pattern: /(测试|test|通过率|用例)/iu },
  { checkId: "schemaValid", pattern: /(schema|格式|字段|结构|表头|列)/iu },
  { checkId: "citationsPresent", pattern: /(引用|来源|出处|标注|链接)/u },
];

/** 解析测试输出：出现 not ok / fail N(>0) / N failed 即判失败 */
export function parseTestOutcome(output: string): { ran: boolean; ok: boolean; detail: string } {
  const text = output.trim();
  if (!text) return { ran: false, ok: false, detail: "没有测试输出可判定" };
  const notOk = /^not ok\b/mu.test(text) || /\bnot ok\b/u.test(text);
  const failLine = text.match(/^#\s*fail\s+(\d+)\s*$/mu);
  const failCount = failLine ? Number(failLine[1]) : undefined;
  const failedWords = text.match(/(\d+)\s+failed/iu);
  const failed = failCount ?? (failedWords ? Number(failedWords[1]) : notOk ? 1 : 0);
  const passLine = text.match(/^#\s*pass\s+(\d+)\s*$/mu) ?? text.match(/(\d+)\s+passed/iu);
  const passed = passLine ? Number(passLine[1]) : undefined;

  if (failed > 0) {
    return { ran: true, ok: false, detail: `测试存在失败：fail ${failed}${passed !== undefined ? `，pass ${passed}` : ""}` };
  }
  if (passed === undefined && !/#\s*pass\s+0/mu.test(text)) {
    return { ran: true, ok: true, detail: "测试输出未报告失败" };
  }
  return { ran: true, ok: true, detail: `测试通过：pass ${passed ?? "?"}，fail 0` };
}

/** 结构校验：JSON 可解析且包含必填字段 */
export async function checkSchema(
  expectation: { path: string; requiredKeys: string[] },
  io: VerifyIo,
): Promise<VerificationCheck> {
  const id = "schemaValid";
  const label = "输出结构合法";
  const read = io.readText;
  if (!read) {
    return { id, label, ok: false, detail: "缺少读取能力，无法校验结构", sourceRefs: [expectation.path] };
  }
  const text = await read(expectation.path).catch(() => null);
  if (text === null) {
    return { id, label, ok: false, detail: `产物 ${expectation.path} 不存在，无法校验结构`, sourceRefs: [expectation.path] };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const probe = Array.isArray(parsed) ? (parsed[0] ?? {}) : parsed;
    const record = typeof probe === "object" && probe !== null ? (probe as Record<string, unknown>) : {};
    const missing = expectation.requiredKeys.filter((key) => !(key in record));
    if (Array.isArray(parsed) && parsed.length === 0) {
      return { id, label, ok: false, detail: `${expectation.path} 是空数组，没有任何记录`, sourceRefs: [expectation.path] };
    }
    return missing.length === 0
      ? { id, label, ok: true, detail: `${expectation.path} 结构合法（含 ${expectation.requiredKeys.join("/")}）`, sourceRefs: [expectation.path] }
      : { id, label, ok: false, detail: `${expectation.path} 缺少字段：${missing.join("/")}`, sourceRefs: [expectation.path] };
  } catch (error) {
    return { id, label, ok: false, detail: `${expectation.path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, sourceRefs: [expectation.path] };
  }
}

/** 引用存在性：产物文本里出现 http(s) 链接或「来源/引用」标注 */
export async function checkCitations(paths: string[], io: VerifyIo): Promise<VerificationCheck> {
  const id = "citationsPresent";
  const label = "引用与来源齐备";
  const read = io.readText;
  if (!read) return { id, label, ok: false, detail: "缺少读取能力，无法检查引用", sourceRefs: paths };
  const readable = paths.filter(Boolean);
  if (readable.length === 0) return { id, label, ok: false, detail: "没有可检查的产物路径", sourceRefs: [] };

  const missing: string[] = [];
  for (const file of readable) {
    const text = await read(file).catch(() => null);
    if (text === null) {
      missing.push(`${file}（不可读）`);
      continue;
    }
    const hasCitation = /https?:\/\/\S+/u.test(text) || /(来源|引用|出处|参考)\s*[:：]/u.test(text) || /\[来源\s/u.test(text);
    if (!hasCitation) missing.push(`${file}（未见引用标注）`);
  }
  return missing.length === 0
    ? { id, label, ok: true, detail: `${readable.length} 个产物均含引用或来源标注`, sourceRefs: readable }
    : { id, label, ok: false, detail: `缺少引用：${missing.join("；")}`, sourceRefs: readable };
}

/**
 * 主入口：跑一遍检查并汇总。
 * 无验收标准时保守处理——只做「危险状态」检查，结论为 warn（而不是 pass），提示需要人工判断。
 */
export async function verifyStep(input: VerifyStepInput): Promise<VerificationReport> {
  const checks: VerificationCheck[] = [];
  const criteria = input.acceptanceCriteria.map((line) => String(line).trim()).filter(Boolean);

  // 1) 产物存在
  const artifacts = input.artifacts;
  const requiresArtifactEvidence = criteria.some((line) => CRITERIA_ROUTES
    .some((route) => route.checkId === "artifactsExist" && route.pattern.test(line)));
  if (artifacts.length > 0) {
    const missing: string[] = [];
    const empty: string[] = [];
    for (const path of artifacts) {
      const size = await input.io.fileSize(path).catch(() => null);
      if (size === null) missing.push(path);
      else if (size === 0) empty.push(path);
    }
    checks.push({
      id: "artifactsExist",
      label: "产物存在且非空",
      ok: missing.length === 0 && empty.length === 0,
      detail: missing.length === 0 && empty.length === 0
        ? `${artifacts.length} 个产物齐备`
        : [missing.length > 0 ? `缺失：${missing.join("、")}` : "", empty.length > 0 ? `空文件：${empty.join("、")}` : ""].filter(Boolean).join("；"),
      sourceRefs: artifacts,
    });
  } else if (requiresArtifactEvidence) {
    checks.push({
      id: "artifactsExist",
      label: "产物存在且非空",
      ok: false,
      detail: "验收标准要求检查产物，但计划没有声明产物路径；必须补充明确路径后才能核验。",
    });
  }

  // 2) 测试结果
  if (input.testOutput !== undefined) {
    const outcome = parseTestOutcome(input.testOutput);
    checks.push({ id: "testsPassed", label: "测试通过", ok: outcome.ok, detail: outcome.detail });
  }

  // 3) 结构合法
  for (const expectation of input.schemaExpectations ?? []) {
    const check = await checkSchema(expectation, input.io);
    checks.push({ ...check, id: `schemaValid:${expectation.path}` });
  }

  // 4) 引用齐备
  if (input.requireCitations) {
    checks.push(artifacts.length > 0
      ? await checkCitations(artifacts, input.io)
      : { id: "citationsPresent", label: "引用齐备", ok: false, detail: "要求引用核验，但未声明任何产物路径。" });
  }

  // 5) 危险遗留状态
  const unresolved = input.unresolvedWrites ?? [];
  const dangerous = Boolean(input.hasPendingApproval) || Boolean(input.hasPendingQuestion) || unresolved.length > 0;
  checks.push({
    id: "noDangerousState",
    label: "无危险遗留状态",
    ok: !dangerous,
    detail: dangerous
      ? [
          input.hasPendingApproval ? "仍有未决审批" : "",
          input.hasPendingQuestion ? "仍有未决提问" : "",
          unresolved.length > 0 ? `未落地写入：${unresolved.join("、")}` : "",
        ].filter(Boolean).join("；")
      : "没有未决审批/提问与悬空写入",
  });

  // 验收标准 → 检查器的覆盖情况
  const routedIds = new Set(checks.map((check) => check.id.split(":")[0]));
  const unmappedCriteria = criteria.filter((line) => {
    const route = CRITERIA_ROUTES.find((candidate) => candidate.pattern.test(line));
    return !route || !routedIds.has(route.checkId);
  });

  const failures = checks.filter((check) => !check.ok).map((check) => `${check.label}：${check.detail}`);
  const verdict: VerificationVerdict = failures.length > 0 ? "fail" : unmappedCriteria.length > 0 || criteria.length === 0 ? "warn" : "pass";

  return {
    ...(input.stepId ? { stepId: input.stepId } : {}),
    verdict,
    checks,
    failures,
    unmappedCriteria,
    evidence: buildEvidence({ verdict, checks, failures, unmappedCriteria }),
  };
}

function buildEvidence(report: { verdict: VerificationVerdict; checks: VerificationCheck[]; failures: string[]; unmappedCriteria: string[] }): string {
  const lines = [`客观验收：${report.verdict === "pass" ? "全部通过" : report.verdict === "warn" ? "有需要人工判断的部分" : "未通过"}`];
  for (const check of report.checks) lines.push(`- ${check.ok ? "✅" : "❌"} ${check.label}：${check.detail}`);
  for (const criterion of report.unmappedCriteria) lines.push(`- ❓ 无对应检查器，需人工判断：${criterion}`);
  if (report.failures.length > 0) lines.push(`结论：不得直接标记交付，先处理上述失败项。`);
  return lines.join("\n");
}

export interface VerdictPolicyInput {
  report: VerificationReport | null;
  requested: "deliver" | "continue";
  continueCount?: number;
  maxContinue?: number;
}

export interface VerdictPolicyResult {
  /** 允许执行的原判定 */
  allow: boolean;
  /** 被改写后的判定（拦下交付时可能降级为带警告交付） */
  verdict: "deliver" | "continue" | "delivered_with_warnings";
  reason: string;
}

/**
 * 唯一的策略出口：
 * - 请求 continue：永远放行（返工不需要客观证据）；
 * - 请求 deliver 且无验收报告：放行（没有计划步可验收时不能凭空拦）；
 * - 请求 deliver 且报告 fail：拦下；若返工已达上限，降级为「带警告交付」并说明；
 * - warn/pass：放行。
 */
export function applyVerdictPolicy(input: VerdictPolicyInput): VerdictPolicyResult {
  if (input.requested === "continue") {
    return { allow: true, verdict: "continue", reason: "返工不需要客观证据" };
  }
  const report = input.report;
  if (!report) return { allow: true, verdict: "deliver", reason: "该派发没有绑定的计划步，跳过客观验收" };
  if (report.verdict !== "fail") {
    return { allow: true, verdict: "deliver", reason: report.verdict === "pass" ? "客观验收通过" : "客观验收无失败项（有需人工判断项）" };
  }
  const reachedLimit = (input.continueCount ?? 0) >= (input.maxContinue ?? 3);
  if (reachedLimit) {
    return { allow: true, verdict: "delivered_with_warnings", reason: "返工已达上限，带客观验收失败项交付（已在留痕中标注）" };
  }
  return { allow: false, verdict: "continue", reason: "客观验收未通过，需先补齐或修正验收标准" };
}
