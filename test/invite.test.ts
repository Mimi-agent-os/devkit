import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { loadAgentEnv } from "@mimi-os/sdk";

import { connect } from "../src/api.ts";
import { devPaths, readState } from "../src/state.ts";
import { devkit, makeAgentDir, startAgent, startStubModel, textTurn, up, waitConnected } from "./harness.ts";

test("invite prints the .env lines, --write puts all three in the agent's .env, and the agent runs on the devkit model", async (t) => {
    const dir = makeAgentDir(t);
    const stub = await startStubModel(t);
    assert.equal((await up(dir, stub)).code, 0);
    const port = readState(devPaths(dir))?.port;

    const printed = await devkit(["invite"], { dir });
    assert.equal(printed.code, 0, printed.stderr);
    const lines = printed.stdout.split("\n");
    assert.match(lines[0] ?? "", /^MIMI_INVITE=mimi:\/\/pair\/v2\?/);
    assert.equal(lines[1], `MIMI_GATEWAY_URL=ws://127.0.0.1:${port}/channel`);
    assert.equal(lines[2], "MIMI_DATA_DIR=.mimi-dev/agent-data");
    assert.match(lines[3] ?? "", /^# put these in .*\.env, or rerun with mimi-dev invite --write/);
    assert.equal(lines[4], "model    notes runs on stub-a");
    assert.equal(existsSync(join(dir, ".env")), false, "printing writes nothing");

    const written = await devkit(["invite", "--write"], { dir });
    assert.equal(written.code, 0, written.stderr);
    assert.match(written.stdout, /^wrote MIMI_INVITE and MIMI_GATEWAY_URL to .*\.env\nwrote MIMI_DATA_DIR=\.mimi-dev\/agent-data to /);
    // a running agent booted without MIMI_DATA_DIR and has to be restarted to use it
    assert.match(written.stdout, /\nnext     start the agent, or restart it if it is running\n$/);
    const env = loadAgentEnv(dir);
    assert.match(env["MIMI_INVITE"] ?? "", /^mimi:\/\/pair\/v2\?/);
    assert.equal(env["MIMI_GATEWAY_URL"], `ws://127.0.0.1:${port}/channel`);
    assert.equal(env["MIMI_DATA_DIR"], ".mimi-dev/agent-data");

    // the policy rides the open invite before the agent ever connected
    const api = await connect(devPaths(dir));
    t.after(() => api.close());
    const before = await api.get<{ primary: string | null; allowed: string[] | null }>("/api/agents/notes/models");
    assert.deepEqual([before.primary, before.allowed], ["stub-a", ["stub-a"]]);

    startAgent(dir);
    await waitConnected(dir, "notes");
    for (const file of ["identity.key", "gateway.pub", "agent.db"]) assert.ok(existsSync(join(dir, ".mimi-dev", "agent-data", file)), file);
    assert.equal(existsSync(join(dir, "data")), false, "the agent's own data/ stays untouched");
    const described = await api.get<{ model: unknown; packsDisabled: unknown }>("/api/agents/notes/describe");
    assert.deepEqual(described.model, { asked: "qwen3.8-lan", runsOn: "stub-a", ok: true });

    // the manifest asks for a model this gateway does not have; the turn runs on the stub
    const { id } = await api.post<{ id: number }>("/api/agents/notes/conversations");
    await api.patch(`/api/agents/notes/conversations/${id}`, { title: "invite test" });
    stub.nextTurn(textTurn("hello from the stub"));
    const turn = await api.stream("POST", `/api/agents/notes/conversations/${id}/messages`, { text: "hi" });
    await turn.done;
    const done = turn.lines.find((l) => l["type"] === "done");
    assert.equal(done?.["answer"], "hello from the stub", JSON.stringify(turn.lines));
    assert.equal(stub.requests[0]?.["model"], "org/stub-a");
    const calls = await api.get<{ registryModel: string }[]>("/api/agents/notes/calls");
    assert.deepEqual(calls.map((c) => c.registryModel), ["stub-a"]);
});

test("invite needs an agent folder and a model", async (t) => {
    const dir = makeAgentDir(t);
    const early = await devkit(["invite"], { dir });
    assert.deepEqual([early.code, early.stderr], [2, "mimi-dev invite: the devkit gateway has no model yet; run mimi-dev up first\n"]);

    rmSync(join(dir, "agent.json"));
    const lost = await devkit(["invite"], { dir });
    assert.equal(lost.code, 2);
    assert.match(lost.stderr, /^mimi-dev invite: No agent\.json in .*\. Run mimi-dev in the agent's folder, or pass --dir\.\n$/);
});
