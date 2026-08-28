/**
 * 独立的 HTTP 业务错误类型。
 * 从 agent.ts 拆出：http 层、workspace 管理等多个模块都需要抛它，
 * 放在叶子模块可避免与 agent.ts 相互导入形成环。
 */
export class MomokaHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
