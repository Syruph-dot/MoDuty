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

export function patOffset(pointerX: number, maxRange: number): MotionOffset {
  return { x: clamp(pointerX, -1, 1) * maxRange, y: 0 };
}

export function approach(current: number, target: number, rate: number, deltaSeconds: number): number {
  if (deltaSeconds <= 0 || rate <= 0) return current;
  const amount = 1 - Math.exp(-rate * deltaSeconds);
  return current + (target - current) * amount;
}
