import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMomokaAgent, createMomokaHttpHandler } from "../src/index.ts";
import { prepareAgentTestProject } from "./agent-test-project.ts";

test("quickref HTTP API: list, create, get, update, delete and audit share one contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moduty-quickrefs-http-"));
  await prepareAgentTestProject(root);
  const agent = createMomokaAgent({
    projectRoot: root,
    modelClient: { async run() { return { output: "ok", toolCalls: [] }; } },
  });
  const session = await agent.sessionManager.createSession("task", root);
  await agent.sessionManager.addMessage(session.id, "user", "远端地址是 192.0.2.7");
  const server = createServer(createMomokaHttpHandler(agent));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = "http://127.0.0.1:" + address.port + "/api/sessions/" + session.id + "/quickrefs";
  try {
    const preflight = await fetch(base, { method: "OPTIONS" });
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /x-momoka-client/u);
    const empty = await fetch(base);
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json() as { entries: unknown[] }).entries, []);

    const createdRes = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", "x-momoka-client": "desktop" },
      body: JSON.stringify({ topic: "远端地址", content: "服务远端地址：192.0.2.7", source_refs: [] }),
    });
    assert.equal(createdRes.status, 201);
    const created = (await createdRes.json() as { entry: { id: string; revision: number } }).entry;
    assert.equal(created.revision, 1);
    assert.equal((await fetch(base + "/" + created.id)).status, 200);

    const updateRes = await fetch(base + "/" + created.id, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-momoka-client": "cli" },
      body: JSON.stringify({ expected_revision: 1, content: "服务远端地址：192.0.2.8" }),
    });
    assert.equal(updateRes.status, 200);
    const updated = (await updateRes.json() as { entry: { revision: number } }).entry;
    assert.equal(updated.revision, 2);

    const stale = await fetch(base + "/" + created.id, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: 1, content: "旧值" }),
    });
    assert.equal(stale.status, 409);

    const deleted = await fetch(base + "/" + created.id, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: 2 }),
    });
    assert.equal(deleted.status, 200);
    assert.equal((await fetch(base + "/" + created.id)).status, 404);
    const audit = await fetch(base + "/audit");
    assert.equal(audit.status, 200);
    const events = (await audit.json() as { events: unknown[] }).events;
    assert.equal(events.length, 3);
    assert.equal(JSON.stringify(events).includes("192.0.2."), false);

    assert.equal((await fetch("http://127.0.0.1:" + address.port + "/api/sessions/ses_missing/quickrefs")).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
