import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SessionManager } from "../src/session-manager.ts";
import { QuickRefConflictError, SessionQuickRefStore } from "../src/session-quickrefs.ts";

test("quickrefs: CRUD is session-scoped and delete leaves metadata-only audit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moduty-quickrefs-"));
  try {
    const sessions = new SessionManager(root);
    const first = await sessions.createSession("first", root);
    const source = await sessions.addMessage(first.id, "user", "远端地址是 192.0.2.7");
    const second = await sessions.createSession("second", root);
    await sessions.addMessage(second.id, "user", "other");
    const store = new SessionQuickRefStore(sessions);
    const created = await store.create(first.id, {
      topic: "远端地址",
      content: "服务远端地址：192.0.2.7",
      sourceRefs: [source.id],
      origin: "agent",
    }, { channel: "agent", agentId: "agt_1" });

    assert.equal(created.revision, 1);
    assert.equal((await store.list(first.id)).length, 1);
    assert.equal((await store.list(second.id)).length, 0);
    assert.equal((await store.get(first.id, created.id))?.content, "服务远端地址：192.0.2.7");
    assert.equal(await store.get(second.id, created.id), null);

    const updated = await store.update(first.id, created.id, {
      expectedRevision: 1,
      content: "服务远端地址：192.0.2.8",
      sourceRefs: [source.id],
    }, { channel: "agent", agentId: "agt_1" });
    assert.equal(updated?.revision, 2);
    assert.equal(updated?.content, "服务远端地址：192.0.2.8");
    await assert.rejects(
      store.update(first.id, created.id, { expectedRevision: 1, content: "过期改动" }, { channel: "desktop" }),
      QuickRefConflictError,
    );

    assert.equal(await store.delete(first.id, created.id, 2, { channel: "desktop" }), true);
    assert.deepEqual(await store.list(first.id), []);
    assert.equal(await store.get(first.id, created.id), null);
    const audit = await store.audit(first.id);
    assert.deepEqual(audit.map((event) => event.action), ["create", "update", "delete"]);
    assert.equal(JSON.stringify(audit).includes("192.0.2.7"), false);
    assert.equal(JSON.stringify(audit).includes("192.0.2.8"), false);
    const file = await readFile(path.join(root, ".sessions", first.id, "quickrefs.json"), "utf8");
    assert.equal(file.includes("192.0.2.7"), false);
    assert.equal(file.includes("192.0.2.8"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quickrefs: invalid source and secret-like content never persist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moduty-quickrefs-invalid-"));
  try {
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("task", root);
    await sessions.addMessage(session.id, "user", "context");
    const store = new SessionQuickRefStore(sessions);
    await assert.rejects(
      store.create(session.id, { topic: "地址", content: "地址 192.0.2.7", sourceRefs: [], origin: "agent" }, { channel: "agent", agentId: "agt_1" }),
    );
    await assert.rejects(
      store.create(session.id, { topic: "密钥", content: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456", sourceRefs: [], origin: "manual" }, { channel: "desktop" }),
    );
    assert.deepEqual(await store.list(session.id), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
