import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readJsonList(filePath: string): Promise<Record<string, unknown>[]> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

export async function readJsonObject(filePath: string, fallback: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

export async function writeJsonList(filePath: string, records: Record<string, unknown>[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

export async function writeJsonObject(filePath: string, payload: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
