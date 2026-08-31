import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 进程内文件写入串行化 + 原子写。
 *
 * 背景：agents.json / sessions.json 等 JSON 持久化是"读→改→写"三段式，
 * 多个异步链（状态机事件、context stats、审批、会话消息流）并发执行时会：
 * 1) 丢失更新（后写者覆盖先写者的整文件修改）；
 * 2) 撕裂读/写（裸 writeFile 是 truncate+write 非原子，读方会读到半写内容 → JSON.parse 失败）。
 * 已多次在 /api/agents 响应中观察到瞬时损坏（Invalid \escape / 双反斜杠乱码）。
 *
 * 解法（本模块）：
 * - `withFileLock(key, fn)`：按 key 串行执行"读-改-写"整段（promise 链式队列，无互斥等待，
 *   不同 key 互不阻塞；进程内单实例场景足够，server.ts 已拒绝多实例）；
 * - `atomicWriteJson(filePath, payload)`：临时文件 + rename 原子替换（EPERM 重试，
 *   不再 fallback 非原子 writeFile，宁可失败也不产出损坏文件）。
 */

const tails = new Map<string, Promise<unknown>>();

/** 把 fn 追加到 key 的串行队列尾部；前一个任务失败不阻塞后续任务 */
export function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  tails.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/** 原子写文本文件：tmp + rename，Windows 上 EPERM 重试+退避，不退化非原子写 */
export async function atomicWrite(filePath: string, payload: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.${attempt}.tmp`;
    await writeFile(tmp, payload, "utf8");
    try {
      await rename(tmp, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" && attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

/** 原子写 JSON（自动 mkdir + 序列化） */
export async function atomicWriteJson(filePath: string, payload: unknown): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}