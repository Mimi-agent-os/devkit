import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { ScriptedTurn } from "@mimi-os/sdk/testing";

import { connect } from "../src/api.ts";
import { devPaths } from "../src/state.ts";
import { newConversation, usd } from "../src/turn.ts";
import { devkit, makeAgentDir, startAgent, startStubModel, textTurn, up, waitConnected } from "./harness.ts";

const toolTurn = (name: string, args: Record<string, unknown>): ScriptedTurn => ({
    events: [
        { kind: "tool_call", index: 0, id: "call-1", name, arguments: JSON.stringify(args) },
        { kind: "finish", reason: "tool_calls" },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 8 },
});

/** The devkit gateway on the stub at $1 / $2 per 1M, the agent invited and connected; `asking` runs the fixture whose tools ask mid-run. */
async function connected(t: TestContext, script: ScriptedTurn[], asking = false): Promise<string> {
    const dir = makeAgentDir(t);
    const stub = await startStubModel(t, script);
    const upped = await up(dir, stub, ["--price-in", "1", "--price-out", "2"]);
    assert.equal(upped.code, 0, upped.stderr);
    assert.equal((await devkit(["invite", "--write"], { dir })).code, 0);
    if (asking) {
        const log = openSync(join(dir, "agent.log"), "a");
        const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures", "asking.ts")], { cwd: dir, stdio: ["ignore", log, log] });
        t.after(() => child.kill());
    } else {
        startAgent(dir);
    }
    await waitConnected(dir, "notes");
    return dir;
}

test("piped chat: tool call, approval, streamed answer, a footer whose $ is the calls route's cost, /tools and /calls", async (t) => {
    const dir = await connected(t, [toolTurn("notes_add", { text: "gym on Tuesday 7:00" }), textTurn("Saved: gym on Tuesday.")]);
    const chat = await devkit(["chat"], { dir, input: "Note: gym on Tuesday 7:00\ny\n/tools\n/calls\n/quit\n" });
    assert.equal(chat.code, 0, chat.stderr);
    const lines = chat.stdout.split("\n");
    assert.equal(lines[0], "notes on stub-a. /new /resume <id> /calls /tools /quit, Ctrl-C stops a turn");
    assert.match(lines[1] ?? "", /^chat \d+$/);
    assert.equal(lines[2], "you > Note: gym on Tuesday 7:00");
    assert.equal(lines[3], '  approve  notes_add {"text":"gym on Tuesday 7:00"}? [y]es [n]o [a]lways in this chat > y');
    assert.equal(lines[4], '  tool     notes_add {"text":"gym on Tuesday 7:00"}');
    assert.equal(lines[5], "  result   notes_add: Saved note #1.");
    assert.equal(lines[6], "notes > Saved: gym on Tuesday.");
    assert.match(lines[7] ?? "", /^ {2}2 calls, 240 in \/ 16 out, \$0\.000272, \d+\.\d+ s, first output \d+\.\d+ s, \d+ tok\/s$/);

    const session = Number(lines[1]?.slice(5));
    const api = await connect(devPaths(dir));
    t.after(() => api.close());
    const calls = await api.get<{ cost: number }[]>(`/api/agents/notes/calls?conversation=${session}`);
    assert.equal(usd(calls.reduce((n, c) => n + c.cost, 0)), "$0.000272");

    assert.equal(lines[8], "you > /tools");
    assert.ok(lines.includes("  notes_add     (text) asks approval  Save one note."), chat.stdout);
    const table = lines.slice(lines.indexOf("you > /calls") + 1, lines.indexOf("you > /quit"));
    assert.equal(table.length, 3, table.join("\n"));
    assert.match(table[0] ?? "", /^id\s+time\s+chat\s+kind\s+model\s+in\s+out\s+reasoning\s+cost\s+secs\s+first\s+tok\/s\s+finish$/);
    assert.match(table[1] ?? "", /stub-a\s+120\s+8\s+-\s+\$0\.000136 .*tool_calls$/);
    assert.match(table[2] ?? "", /stub-a\s+120\s+8\s+-\s+\$0\.000136 .*stop$/);
});

test("a no denies the write and the tool never runs; -m with no terminal and no --yes denies", async (t) => {
    const dir = await connected(t, [
        toolTurn("notes_add", { text: "one" }),
        textTurn("Not saved."),
        toolTurn("notes_add", { text: "two" }),
        textTurn("Not saved either."),
    ]);
    const chat = await devkit(["chat"], { dir, input: "Note: one\nn\n/quit\n" });
    assert.equal(chat.code, 0, chat.stderr);
    assert.match(chat.stdout, /\? \[y\]es \[n\]o \[a\]lways in this chat > n\n {2}result {3}notes_add: The user DENIED/);
    assert.doesNotMatch(chat.stdout, /tool {5}notes_add/);
    assert.match(chat.stdout, /\nnotes > Not saved\.\n/);

    const once = await devkit(["chat", "-m", "Note: two"], { dir });
    assert.equal(once.code, 0, once.stderr);
    assert.match(once.stdout, /^ {2}approve {2}notes_add \{"text":"two"\}\? no: no terminal to ask on; --yes approves\n {2}result {3}notes_add: The user DENIED/);
    assert.match(once.stdout, /\nnotes > Not saved either\.\n {2}2 calls, 240 in \/ 16 out, \$0\.000272, /);
});

test("-m exits 0 on done and 1 on error; --json writes the turn's ndjson and a footer", async (t) => {
    const dir = await connected(t, [textTurn("hello there"), textTurn("hello as json")]);
    const done = await devkit(["chat", "-m", "hi"], { dir });
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /^notes > hello there\n {2}1 call, 120 in \/ 8 out, \$0\.000136, /);

    const json = await devkit(["chat", "-m", "hi", "--json"], { dir });
    assert.equal(json.code, 0, json.stderr);
    const lines = json.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines[0]?.["type"], "turn_started");
    assert.equal(lines.find((l) => l["type"] === "done")?.["answer"], "hello as json");
    assert.deepEqual(lines.at(-1), { ...lines.at(-1), type: "footer", calls: 1, promptTokens: 120, completionTokens: 8 });

    // nothing scripted: the stub refuses, and the turn ends in error
    const failed = await devkit(["chat", "-m", "hi again"], { dir });
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /^ {2}error {4}vllm 409: .+\n {2}1 call, 0 in \/ 0 out, /);

    assert.equal((await devkit(["chat", "--json"], { dir })).code, 2);
    assert.equal((await devkit(["chat", "7"], { dir })).code, 2);
});

test("a tool's own mid-run approve() and a gate it raises outside any chat are both asked once, inline", async (t) => {
    const dir = await connected(t, [toolTurn("notes_purge", {}), textTurn("Purged."), toolTurn("notes_sync", {}), textTurn("Synced.")], true);
    const chat = await devkit(["chat"], { dir, input: "purge\ny\nsync\ny\n/quit\n" });
    assert.equal(chat.code, 0, chat.stderr);
    assert.equal(chat.stdout.split('approve  purge every note {"notes":3}?').length, 2, chat.stdout);
    assert.match(chat.stdout, /result {3}notes_purge: purged 3 notes\nnotes > Purged\./);
    assert.equal(chat.stdout.split('approve  sync notes to the cloud {"to":"cloud"}?').length, 2, chat.stdout);
    assert.match(chat.stdout, /result {3}notes_sync: synced\nnotes > Synced\./);
});

test("--resume on a chat whose turn is still running prints its history and reattaches to the turn", async (t) => {
    const dir = await connected(t, [toolTurn("notes_add", { text: "dentist Friday 10:00" }), textTurn("Saved the dentist.")]);
    const api = await connect(devPaths(dir));
    t.after(() => api.close());
    const session = await newConversation(api, "notes", "busy chat");
    await api.stream("POST", `/api/agents/notes/conversations/${session}/messages`, { text: "Note: dentist Friday 10:00" });
    // the turn now waits on its write gate
    for (let i = 0; i < 100; i++) {
        const { approvals } = await api.get<{ approvals: unknown[] }>("/api/approvals");
        if (approvals.length > 0) break;
        await sleep(100);
    }

    // a failed attach must not leave the turn parked for the cleanup's `down` to wait on
    const chat = await devkit(["chat", "--resume", `${session}`], { dir, input: "y\n/quit\n" }).finally(() =>
        api.request("POST", `/api/agents/notes/conversations/${session}/stop`),
    );
    assert.equal(chat.code, 0, chat.stderr);
    const lines = chat.stdout.split("\n");
    assert.equal(lines[0], "notes on stub-a. /new /resume <id> /calls /tools /quit, Ctrl-C stops a turn");
    assert.equal(lines[1], `chat ${session} "busy chat", its last 1 message`);
    assert.equal(lines[2], "you > Note: dentist Friday 10:00");
    assert.equal(lines[3], "  its turn is still running");
    assert.equal(lines[4], '  approve  notes_add {"text":"dentist Friday 10:00"}? [y]es [n]o [a]lways in this chat > y');
    assert.equal(lines[5], '  tool     notes_add {"text":"dentist Friday 10:00"}');
    assert.equal(lines[6], "  result   notes_add: Saved note #1.");
    assert.equal(lines[7], "notes > Saved the dentist.");
    assert.match(lines[8] ?? "", /^ {2}2 calls, 240 in \/ 16 out, \$0\.000272, /);

    const chats = await api.get<{ id: number; busy: boolean }[]>("/api/agents/notes/conversations");
    assert.equal(chats.find((c) => c.id === session)?.busy, false);
});
