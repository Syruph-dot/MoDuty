import type { RouteContext } from "./route-context.js";

/**
 * Relation routes stub — 关系图/关联查询路由（待完善）。
 * 当前返回 404，由上层 dispatch 落到 404 处理。
 */
export async function handleRelationRoutes(
  _ctx: RouteContext,
  _request: any,
  _response: any,
  _url: URL,
): Promise<boolean> {
  return false; // 未实现，交给后续路由或 404
}