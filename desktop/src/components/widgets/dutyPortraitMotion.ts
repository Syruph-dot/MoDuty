/**
 * 把「世界（骨架）空间的位移」换算成「某骨骼父坐标系下的局部位移」。
 *
 * 为什么必须用完整矩阵逆而不是“只给局部 x”：本 rig 的 Touch_Point_Key / Touch_Eye_Key
 * 父骨近乎旋转 90°（实测 Touch_Point.matrix a=0.1095 b=-0.9185 c=-0.9185 d=-0.1095），
 * 世界水平位移 (100,0) 换算出来是局部 (12.80, -107.35) —— **几乎全在局部 y 上**。
 * 若把局部 y 归零，实际世界位移会变成 (1.40, -11.76)：既小 10 倍、又变成竖直方向
 * （就是“左右移动、摸头效果却上下动”的成因）。
 */
export function worldDeltaToLocal(
  matrix: { a: number; b: number; c: number; d: number } | null | undefined,
  worldX: number,
  worldY: number,
): { x: number; y: number } {
  if (!matrix) return { x: worldX, y: worldY };
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-6) return { x: 0, y: 0 };
  return {
    x: (matrix.d * worldX - matrix.c * worldY) / determinant,
    y: (-matrix.b * worldX + matrix.a * worldY) / determinant,
  };
}

export interface PointerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NormalizedPointer {
  x: number;
  y: number;
}

export interface MotionOffset {
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizedPointer(clientX: number, clientY: number, rect: PointerRect): NormalizedPointer {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return {
    x: clamp(((clientX - rect.left) / rect.width) * 2 - 1, -1, 1),
    y: clamp(((clientY - rect.top) / rect.height) * 2 - 1, -1, 1),
  };
}

export function approach(current: number, target: number, rate: number, deltaSeconds: number): number {
  if (deltaSeconds <= 0 || rate <= 0) return current;
  const amount = 1 - Math.exp(-rate * deltaSeconds);
  return current + (target - current) * amount;
}
