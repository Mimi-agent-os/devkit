import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { setAgentEnv } from "@mimi-os/sdk";

import { connect } from "../src/api.ts";
import { lintSchema } from "../src/check.ts";
import { devPaths, readState } from "../src/state.ts";
import { devkit, makeAgentDir, startAgent, startStubModel, up, waitConnected } from "./harness.ts";

/** The agent folder with a running devkit gateway on the stub and the invite written. */
async function invited(t: TestContext): Promise<string> {
    const dir = makeAgentDir(t);
    const stub = await startStubModel(t);
    const upped = await up(dir, stub);
    assert.equal(upped.code, 0, upped.stderr);
    const invite = await devkit(["invite", "--write"], { dir });
    assert.equal(invite.code, 0, invite.stderr);
    return dir;
}

function startAppAgent(t: TestContext, dir: string, env: Record<string, string> = {}): ChildProcess {
    const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures", "check-app.ts")], { cwd: dir, env: { ...process.env, ...env }, stdio: "ignore" });
    t.after(() => child.kill());
    return child;
}

async function waitGone(dir: string, agent: string): Promise<void> {
    const api = await connect(devPaths(dir));
    try {
        for (const deadline = Date.now() + 10_000; Date.now() < deadline; await sleep(100)) {
            const list = await api.get<{ name: string; connected: boolean }[]>("/api/agents");
            if (!list.some((a) => a.name === agent && a.connected)) return;
        }
        throw new Error(`${agent} is still connected`);
    } finally {
        api.close();
    }
}

test("a clean agent passes: the model it runs on, its packs, tools and prompt", async (t) => {
    const dir = await invited(t);
    startAgent(dir);
    await waitConnected(dir, "notes");

    const checked = await devkit(["check", "--prompt"], { dir });
    assert.equal(checked.code, 0, checked.stdout + checked.stderr);
    const lines = checked.stdout.split("\n");
    assert.deepEqual(lines.slice(0, 8), [
        "agent    notes, connected, approved",
        "model    the agent asks for qwen3.8-lan; the gateway runs it on stub-a, ctx 8000",
        "manifest notes: Keeps short notes and finds them again.",
        "packs    calendar disabled",
        "  warn   calendar is off: GOOGLE_CALENDAR_KEY not set",
        "         fix set GOOGLE_CALENDAR_KEY in the agent's .env, then restart it",
        "tools    4, asks approval: notes_add",
        "dropped  nothing",
    ]);
    assert.match(lines[8] ?? "", /^prompt   1 section and 4 tool schemas, \d+\.\d KiB, about \d+ tokens \(\d+\.\d% of ctx\)$/);
    assert.equal(lines[9], "app      none declared");
    assert.deepEqual(lines.slice(10), ["", "--- pack:memory ---", "Keep every note short.", "", "0 failures, 1 warning", ""]);

    const json = await devkit(["check", "--json"], { dir });
    assert.equal(json.code, 0, json.stderr);
    const report = JSON.parse(json.stdout) as { agent: string; connected: boolean; failures: number; warnings: number; blocks: { label: string }[] };
    assert.deepEqual([report.agent, report.connected, report.failures, report.warnings], ["notes", true, 0, 1]);
    assert.deepEqual(report.blocks.map((b) => b.label), ["agent", "model", "manifest", "packs", "tools", "dropped", "prompt", "app"]);
});

test("a broken agent fails: a bad schema and a tool the gateway's done shadows, each with its fix", async (t) => {
    const dir = await invited(t);
    startAgent(dir, { NOTES_BROKEN_SCHEMA: "1", NOTES_DONE_TOOL: "1" });
    await waitConnected(dir, "notes");

    const checked = await devkit(["check"], { dir });
    assert.equal(checked.code, 1, checked.stdout + checked.stderr);
    const lines = checked.stdout.split("\n");
    const tools = lines.indexOf("tools    5, asks approval: notes_add");
    assert.ok(tools > 0, checked.stdout);
    assert.deepEqual(lines.slice(tools + 1, tools + 9), [
        '  FAIL   notes_search: parameters.properties.q.type "str" is not a JSON Schema type',
        '  FAIL   notes_search: parameters.required names "query", which is not a property (has: q)',
        "         fix correct notes_search's parameters in its defineTool, then restart the agent",
        '  warn   done: "Finish." is too short to tell the model when to call it',
        "         fix say in done's description when the model should call it",
        "dropped  1",
        "  FAIL   tool done: a gateway tool of the same name takes its place",
        "         fix rename done; the gateway's own tool of that name takes every call",
    ]);
    assert.equal(lines.at(-2), "3 failures, 2 warnings");
});

test("an agent that is not connected gets one cause and one fix, and exit 3", async (t) => {
    const dir = makeAgentDir(t);
    const stub = await startStubModel(t);
    assert.equal((await up(dir, stub)).code, 0);
    const port = readState(devPaths(dir))?.port;
    const cause = async (): Promise<string[]> => {
        const checked = await devkit(["check"], { dir });
        assert.equal(checked.code, 3, checked.stdout + checked.stderr);
        return checked.stdout.split("\n").slice(0, 3);
    };

    assert.deepEqual(await cause(), [
        "agent    notes, not connected",
        "  FAIL   .env has no MIMI_INVITE, so the agent has nothing to pair with",
        "         fix run mimi-dev invite --write, then restart the agent",
    ]);

    assert.equal((await devkit(["invite", "--write"], { dir })).code, 0);
    assert.deepEqual((await cause()).slice(1), [
        "  FAIL   notes has not redeemed its invite yet",
        "         fix start the agent; a running one reads .env every 30 s, unless it booted before MIMI_DATA_DIR was set: then restart it",
    ]);

    setAgentEnv(dir, "MIMI_GATEWAY_URL", "ws://127.0.0.1:1/channel", { encrypt: false });
    assert.deepEqual((await cause()).slice(1), [
        `  FAIL   MIMI_GATEWAY_URL is ws://127.0.0.1:1/channel, but the devkit gateway listens on port ${port}`,
        "         fix run mimi-dev invite --write, then restart the agent",
    ]);

    assert.equal((await devkit(["invite", "--write"], { dir })).code, 0);
    const agent = startAgent(dir);
    await waitConnected(dir, "notes");
    agent.kill();
    await waitGone(dir, "notes");
    assert.deepEqual((await cause()).slice(1), [
        "  FAIL   notes is paired but not running",
        "         fix start the agent; if it is running, its output says why it cannot connect",
    ]);
});

test("a declared app is launched through the gateway: a dead server fails, a live one prints a URL to open", async (t) => {
    const dir = await invited(t);
    const down = startAppAgent(t, dir, { CHECK_APP_DOWN: "1" });
    await waitConnected(dir, "notes");

    const dead = await devkit(["check"], { dir });
    assert.equal(dead.code, 1, dead.stdout + dead.stderr);
    assert.match(dead.stdout, /\nmanifest notes: Keeps short notes and finds them again\.\n  FAIL   policy\.allowedTools names notes_export, which the agent does not declare\n         fix drop notes_export from policy\.allowedTools, or mount that tool\n/);
    assert.match(dead.stdout, /\napp      Notes board at http:\/\/127\.0\.0\.1:\d+\/\n  FAIL   its server at http:\/\/127\.0\.0\.1:\d+ did not answer \(the gateway gave 502\)\n         fix start the app's server at http:\/\/127\.0\.0\.1:\d+, or correct app\.upstream in runAgent\n/);

    down.kill();
    await waitGone(dir, "notes");
    startAppAgent(t, dir);
    await waitConnected(dir, "notes");
    const live = await devkit(["check"], { dir });
    assert.equal(live.code, 1, live.stdout + live.stderr);
    assert.match(live.stdout, /\napp      Notes board answers 200 at http:\/\/127\.0\.0\.1:\d+\/\nopen     (http:\/\/127\.0\.0\.1:\d+\/mini-app\/notes\/\?mimi_ticket=[0-9a-f]+) \(one visit, within 2 minutes\)\n/);
    const url = /\nopen {5}(\S+) /.exec(live.stdout)?.[1] ?? "";
    const opened = await fetch(url, { redirect: "manual" });
    assert.equal(opened.status, 302, "the printed link still holds its unspent ticket");
});

test("lintSchema: one message per problem", () => {
    assert.deepEqual(lintSchema({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }), []);
    assert.deepEqual(lintSchema({ type: "object", properties: {} }), []);
    assert.deepEqual(lintSchema({ type: "object", properties: { mode: { enum: ["a", "b"] }, at: { anyOf: [{ type: "string" }, { type: "null" }] } } }), []);
    assert.deepEqual(lintSchema({ type: "object", properties: { tags: { type: ["array", "null"], items: { type: "string" } } } }), []);
    assert.deepEqual(lintSchema({ type: "object", properties: { self: { $ref: "#/properties/other" }, other: { type: "string" } } }), []);

    assert.deepEqual(lintSchema(undefined), ["parameters is not an object"]);
    assert.deepEqual(lintSchema({ properties: {} }), ['parameters.type is missing; a tool\'s parameters must be "object"']);
    assert.deepEqual(lintSchema({ type: "array" }), ['parameters.type is "array"; a tool\'s parameters must be "object"']);
    assert.deepEqual(lintSchema({ type: "object" }), ["parameters.properties is missing; {} declares a tool that takes no arguments"]);
    assert.deepEqual(lintSchema({ type: "object", properties: [] }), ["parameters.properties is not an object"]);
    assert.deepEqual(
        lintSchema({
            type: "object",
            properties: {
                q: { type: "str" },
                n: { description: "no type" },
                list: { type: "array" },
                deep: { type: "object", properties: { x: { type: "int" } }, required: ["y"] },
                ext: { $ref: "https://example.com/schema.json" },
                pick: { enum: [] },
            },
            required: ["query", 7],
        }),
        [
            'parameters.properties.q.type "str" is not a JSON Schema type',
            "parameters.properties.n has no type, enum, anyOf or oneOf",
            "parameters.properties.list is an array with no items",
            'parameters.properties.deep.properties.x.type "int" is not a JSON Schema type',
            'parameters.properties.deep.required names "y", which is not a property (has: x)',
            'parameters.properties.ext.$ref "https://example.com/schema.json" points outside the schema',
            "parameters.properties.pick.enum is not a non-empty array",
            'parameters.required names "query", which is not a property (has: q, n, list, deep, ext, pick)',
            "parameters.required names 7, which is not a property (has: q, n, list, deep, ext, pick)",
        ],
    );
});
