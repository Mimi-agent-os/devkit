import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { FakeModel, ScriptedTurn } from "@mimi-os/sdk/testing";

import { matchArgs, parseScenario } from "../src/test.ts";
import { devkit, makeAgentDir, startAgent, startStubModel, textTurn, up, waitConnected } from "./harness.ts";

const toolTurn = (name: string, args: Record<string, unknown>): ScriptedTurn => ({
    events: [
        { kind: "tool_call", index: 0, id: "call-1", name, arguments: JSON.stringify(args) },
        { kind: "finish", reason: "tool_calls" },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 8 },
});

const saveNote = {
    turns: [
        {
            user: "Note: gym on Tuesday 7:00",
            expect: { tools: [{ name: "notes_add", args: { text: "gym on Tuesday 7:00" } }], reply: { contains: ["saved"] } },
        },
        { user: "What do I have?", expect: { tools: ["notes_list"], reply: { contains: ["gym"] } } },
    ],
    approve: ["notes_add"],
};

/** One run of save-note as the model should play it. */
const goodRun = (): ScriptedTurn[] => [
    toolTurn("notes_add", { text: "gym on Tuesday 7:00" }),
    textTurn("Saved: gym on Tuesday."),
    toolTurn("notes_list", {}),
    textTurn("You have: gym on Tuesday 7:00."),
];

async function connected(t: TestContext, scenarios: Record<string, unknown>): Promise<{ dir: string; stub: FakeModel }> {
    const dir = makeAgentDir(t);
    mkdirSync(join(dir, "scenarios"));
    for (const [name, scenario] of Object.entries(scenarios)) writeFileSync(join(dir, "scenarios", `${name}.json`), JSON.stringify(scenario));
    const stub = await startStubModel(t);
    const upped = await up(dir, stub, ["--price-in", "1", "--price-out", "2"]);
    assert.equal(upped.code, 0, upped.stderr);
    assert.equal((await devkit(["invite", "--write"], { dir })).code, 0);
    startAgent(dir);
    await waitConnected(dir, "notes");
    return { dir, stub };
}

test("a scenario whose every run meets its expectations passes, each run in a fresh chat", async (t) => {
    const { dir, stub } = await connected(t, { "save-note": saveNote });
    for (const turn of [...goodRun(), ...goodRun()]) stub.nextTurn(turn);

    const run = await devkit(["test", "--runs", "2"], { dir });
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const lines = run.stdout.split("\n");
    assert.equal(lines[0], "notes: 1 scenario, a fresh chat per run");
    assert.equal(lines[1], "every run shares the agent's store; devkit never restarts the agent");
    assert.equal(lines[2], "pass     save-note  2/2");
    assert.match(lines[3] ?? "", /^total {4}2\/2 runs passed \(100%\), 8 calls, 960 in \/ 64 out, \$0\.001088, \d+\.\d s$/);

    // the approval was the scenario's: two runs saved two notes, each in a chat of its own
    const users = stub.requests.map((r) => (r["messages"] as { role: string; content: string }[]).filter((m) => m.role === "user").length);
    assert.deepEqual(users, [1, 1, 2, 2, 1, 1, 2, 2]);
});

test("a miss fails with its reason: wrong args, a reply without the word, a write the scenario does not approve", async (t) => {
    const { dir, stub } = await connected(t, {
        "no-approval": { turns: [{ user: "Note: dentist", expect: { tools: ["notes_add"] } }] },
        "save-note": { ...saveNote, runs: 3 },
    });
    for (const turn of [
        // no-approval: approve defaults to none, so the write is denied and never runs
        toolTurn("notes_add", { text: "dentist" }),
        textTurn("Could not save."),
        // save-note run 1: as expected
        ...goodRun(),
        // run 2: the wrong arguments
        toolTurn("notes_add", { text: "gym" }),
        textTurn("Saved: gym."),
        // run 3: the right call, a reply without "saved"
        toolTurn("notes_add", { text: "gym on Tuesday 7:00" }),
        textTurn("Done."),
    ]) {
        stub.nextTurn(turn);
    }

    const run = await devkit(["test"], { dir });
    assert.equal(run.code, 1, run.stdout + run.stderr);
    const lines = run.stdout.split("\n");
    assert.equal(lines[2], "fail     no-approval  0/1");
    assert.match(
        lines[3] ?? "",
        /^ {9}run 1, chat \d+, turn 1: no notes_add call; notes_add did not run: The user DENIED this tool call .*\(approve does not list notes_add\)$/,
    );
    assert.equal(lines[4], "flaky    save-note    1/3");
    assert.match(lines[5] ?? "", /^ {9}run 2, chat \d+, turn 1: no notes_add call with \{"text":"gym on Tuesday 7:00"\}; it called notes_add \{"text":"gym"\}$/);
    assert.match(lines[6] ?? "", /^ {9}run 3, chat \d+, turn 1: the reply lacks "saved": "Done\."$/);
    assert.match(lines[7] ?? "", /^total {4}1\/4 runs passed \(25%\), 10 calls, /);
    assert.equal(lines[8], "below --min-pass 1: no-approval, save-note");

    // --min-pass lets a flaky scenario through; --json reports the same runs
    for (const turn of [...goodRun(), toolTurn("notes_list", {}), textTurn("Nothing here.")]) stub.nextTurn(turn);
    const lenient = await devkit(["test", "scenarios/save-note.json", "--runs", "2", "--min-pass", "0.5", "--json"], { dir });
    assert.equal(lenient.code, 0, lenient.stdout + lenient.stderr);
    const report = JSON.parse(lenient.stdout) as { scenarios: { name: string; runs: number; passed: number; failures: { turn: number; reason: string }[] }[]; below: string[] };
    assert.deepEqual(report.below, []);
    assert.equal(report.scenarios[0]?.passed, 1);
    assert.equal(report.scenarios[0]?.failures[0]?.turn, 1);
    assert.match(report.scenarios[0]?.failures[0]?.reason ?? "", /^no notes_add call with .*; it called notes_list \{\}$/);
});

test("a bad scenario file is exit 2 naming the file and the key, before anything runs", async (t) => {
    const dir = makeAgentDir(t);
    assert.match((await devkit(["test"], { dir })).stderr, /scenarios does not exist/);
    mkdirSync(join(dir, "scenarios"));
    writeFileSync(join(dir, "scenarios", "typo.json"), JSON.stringify({ turns: [{ user: "hi", expect: { contains: ["hi"] } }] }));
    const typo = await devkit(["test"], { dir });
    assert.equal(typo.code, 2);
    assert.equal(typo.stderr, "mimi-dev test: scenarios/typo.json: turns[0].expect.contains is not a scenario key (tools, reply)\n");
    assert.equal((await devkit(["test", "--runs", "0"], { dir })).code, 2);
    assert.equal((await devkit(["test", "--min-pass", "2"], { dir })).code, 2);
});

test("parseScenario: defaults, both tool forms, and one message per broken key", () => {
    assert.deepEqual(parseScenario("scenarios/hello.json", '{ "turns": [{ "user": "hi" }] }'), {
        name: "hello",
        runs: undefined,
        approve: "none",
        turns: [{ user: "hi", tools: [], contains: [] }],
    });
    const full = parseScenario("x.json", JSON.stringify({ ...saveNote, name: "n", runs: 5 }));
    assert.equal(full.runs, 5);
    assert.deepEqual(full.turns[0]?.tools, [{ name: "notes_add", args: { text: "gym on Tuesday 7:00" } }]);
    assert.deepEqual(full.turns[1]?.tools, [{ name: "notes_list" }]);

    const refused = (text: string): string => {
        try {
            parseScenario("x.json", text);
        } catch (e) {
            return (e as Error).message;
        }
        return "accepted";
    };
    assert.match(refused("{"), /^x\.json: not JSON/);
    assert.equal(refused("[]"), "x.json: the file must be an object");
    assert.equal(refused('{ "turns": [], "extra": 1 }'), "x.json: extra is not a scenario key (name, turns, runs, approve)");
    assert.equal(refused('{ "turns": [] }'), "x.json: turns must be a non-empty list");
    assert.equal(refused('{ "turns": [{ "user": "" }] }'), "x.json: turns[0].user must be a non-empty string");
    assert.equal(refused('{ "turns": [{ "user": "a" }], "runs": 1.5 }'), "x.json: runs must be a whole number above 0");
    assert.equal(refused('{ "turns": [{ "user": "a" }], "approve": "some" }'), 'x.json: approve must be "all", "none" or a list of tool names');
    assert.equal(refused('{ "turns": [{ "user": "a", "expect": { "tools": [{ "args": {} }] } }] }'), "x.json: turns[0].expect.tools[0].name must be a tool name");
    assert.equal(refused('{ "turns": [{ "user": "a", "expect": { "tools": [{ "name": "t", "args": [1] }] } }] }'), "x.json: turns[0].expect.tools[0].args must be an object");
    assert.equal(refused('{ "turns": [{ "user": "a", "expect": { "reply": { "contains": "x" } } }] }'), "x.json: turns[0].expect.reply.contains must be a list of non-empty strings");
});

test("matchArgs: objects match as a subset, recursively; arrays and scalars exactly", () => {
    assert.ok(matchArgs({}, { a: 1 }));
    assert.ok(matchArgs({ a: 1 }, { a: 1, b: 2 }));
    assert.ok(matchArgs({ when: { day: "Tue" } }, { when: { day: "Tue", hour: 7 }, text: "gym" }));
    assert.ok(matchArgs({ tags: ["a", "b"] }, { tags: ["a", "b"] }));
    assert.ok(matchArgs({ v: null }, { v: null }));
    assert.ok(!matchArgs({ a: 1 }, { a: "1" }));
    assert.ok(!matchArgs({ a: 1 }, {}));
    assert.ok(!matchArgs({ v: undefined }, {}));
    assert.ok(!matchArgs({ text: "Gym" }, { text: "gym" }));
    assert.ok(!matchArgs({ tags: ["a"] }, { tags: ["a", "b"] }));
    assert.ok(!matchArgs({ when: { day: "Tue" } }, { when: "Tue" }));
    assert.ok(!matchArgs({ a: 1 }, null));
    assert.ok(!matchArgs({ a: 1 }, [1]));
});
