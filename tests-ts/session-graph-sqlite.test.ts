import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";

import { SessionManager } from "../src/session-manager.ts";
import {
  readSessionGraph,
  readSessionGraphEdges,
  rebuildSessionGraph,
  sessionGraphPath,
} from "../src/relation-graph.ts";
import { handleGraphRoutes } from "../src/http/graph-routes.ts";

test("session graph: committed SQLite updates retain every session and reference", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moduty-graph-sqlite-"));
  try {
    const sessions = new SessionManager(root);
    const ids: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const session = await sessions.createSession("session " + index, root);
      ids.push(session.id);
      await sessions.addMessage(session.id, "user", index === 0 ? "start" : "see &" + ids[index - 1]);
    }

    // Check the materialized database before a first-read reconciliation can repair it.
    const db = new DatabaseSync(sessionGraphPath(sessions.sessionsDir));
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM graph_nodes").get() as { n: number }).n, 30);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM graph_links").get() as { n: number }).n, 29);
    } finally {
      db.close();
    }

    const graph = await readSessionGraph(sessions.sessionsDir, sessions);
    assert.equal(graph.nodes.length, 30);
    assert.equal(graph.links.length, 29);
    assert.ok(graph.links.some((edge) => edge.source === ids[1] && edge.target === ids[0]));
    const edges = await readSessionGraphEdges(sessions.sessionsDir, sessions);
    assert.deepEqual(edges.out.get(ids[1]!), [ids[0]]);
    assert.deepEqual(edges.in.get(ids[0]!), [ids[1]]);

    await rm(sessionGraphPath(sessions.sessionsDir));
    assert.equal((await readSessionGraph(sessions.sessionsDir, sessions)).links.length, 29, "missing derived DB should rebuild from JSON");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session graph: archive remains visible; truncation, deletion and rebuild follow JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moduty-graph-lifecycle-"));
  try {
    const sessions = new SessionManager(root);
    const target = await sessions.createSession("target", root);
    await sessions.addMessage(target.id, "user", "target message");
    const source = await sessions.createSession("source", root);
    const message = await sessions.addMessage(source.id, "user", "see &" + target.id);

    await sessions.archiveSession(target.id);
    let graph = await readSessionGraph(sessions.sessionsDir, sessions);
    assert.equal(graph.nodes.length, 2);
    assert.deepEqual(graph.links.map((edge) => [edge.source, edge.target]), [[source.id, target.id]]);

    let status = 0;
    let body = "";
    const response = {
      writeHead(code: number) { status = code; },
      end(text: string) { body = text; },
    } as unknown as ServerResponse;
    const context = { agent: { sessionManager: sessions } } as Parameters<typeof handleGraphRoutes>[0];
    assert.equal(await handleGraphRoutes(context, { method: "GET" } as IncomingMessage, response, new URL("http://localhost/api/graph/sessions")), true);
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(body).links, graph.links, "HTTP graph must read the same SQLite projection");

    await sessions.truncateMessages(source.id, message.id);
    graph = await readSessionGraph(sessions.sessionsDir, sessions);
    assert.equal(graph.links.length, 0);

    await sessions.addMessage(source.id, "user", "see &" + target.id);
    await rebuildSessionGraph(sessions.sessionsDir, sessions);
    assert.equal((await readSessionGraph(sessions.sessionsDir, sessions)).links.length, 1);

    await sessions.deleteSession(target.id);
    graph = await readSessionGraph(sessions.sessionsDir, sessions);
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.links.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session graph: explicit links in reasoning and tool calls survive migration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moduty-graph-fields-"));
  try {
    const sessions = new SessionManager(root);
    const target = await sessions.createSession("target", root);
    await sessions.addMessage(target.id, "user", "target");
    const source = await sessions.createSession("source", root);
    await sessions.addMessage(source.id, "agent", "no link in content", {
      reasoning: "refer to &" + target.id,
      toolCalls: [{ tool: "read_session", args: JSON.stringify({ id: target.id, ref: "&" + target.id }), result: "" }],
    });

    const graph = await readSessionGraph(sessions.sessionsDir, sessions);
    assert.deepEqual(graph.links.map((edge) => [edge.source, edge.target]), [[source.id, target.id]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session graph: explicit links beyond a long tool result remain discoverable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moduty-graph-long-result-"));
  try {
    const sessions = new SessionManager(root);
    const target = await sessions.createSession("target", root);
    await sessions.addMessage(target.id, "user", "target");
    const source = await sessions.createSession("source", root);
    await sessions.addMessage(source.id, "agent", "no link in content", {
      toolCalls: [{ tool: "read_file", args: "{}", result: "x".repeat(200_100) + " &" + target.id }],
    });
    const graph = await readSessionGraph(sessions.sessionsDir, sessions);
    assert.deepEqual(graph.links.map((edge) => [edge.source, edge.target]), [[source.id, target.id]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
