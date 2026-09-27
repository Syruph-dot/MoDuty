import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMomokaAgent, createMomokaHttpHandler } from "../src/index.ts";
import { prepareAgentTestProject } from "./agent-test-project.ts";

const execFileAsync = promisify(execFile);

test("momoka session quickref CLI performs CRUD through the shared API", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moduty-quickrefs-cli-"));
  await prepareAgentTestProject(root);
  const agent = createMomokaAgent({
    projectRoot: root,
    modelClient: { async run() { return { output: "ok", toolCalls: [] }; } },
  });
  const session = await agent.sessionManager.createSession("task", root);
  await agent.sessionManager.addMessage(session.id, "user", "远端地址 192.0.2.7");
  const server = createServer(createMomokaHttpHandler(agent));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const env = { ...process.env, MOMOKA_URL: "http://127.0.0.1:" + address.port };
  const cli = async (...args: string[]) => {
    const result = await execFileAsync(process.execPath, [path.resolve("bin/momoka.mjs"), "session", "quickref", ...args], {
      env,
      cwd: process.cwd(),
      windowsHide: true,
    });
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  try {
    const created = await cli("add", session.id, "--topic", "远端地址", "--content", "地址 192.0.2.7");
    const entry = created.entry as { id: string; revision: number };
    assert.match(entry.id, /^qrf_/u);
    assert.equal((await cli("list", session.id)).entries instanceof Array, true);
    assert.equal((await cli("get", session.id, entry.id)).entry instanceof Object, true);
    const changed = await cli("update", session.id, entry.id, "--revision", "1", "--content", "地址 192.0.2.8");
    assert.equal((changed.entry as { revision: number }).revision, 2);
    assert.equal((await cli("delete", session.id, entry.id, "--revision", "2")).deleted, true);
    assert.deepEqual((await cli("list", session.id)).entries, []);
    assert.equal(((await cli("audit", session.id)).events as unknown[]).length, 3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
