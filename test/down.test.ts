import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { connect } from "../src/api.ts";
import { devPaths, readState } from "../src/state.ts";
import { devkit, makeAgentDir, startStubModel, up } from "./harness.ts";

test("down stops the gateway and keeps the state; up brings back the same port, model and device", async (t) => {
    const dir = makeAgentDir(t);
    const stub = await startStubModel(t);
    assert.equal((await up(dir, stub)).code, 0);
    const p = devPaths(dir);
    const state = readState(p);
    const key = readFileSync(p.deviceKey, "utf8");

    const down = await devkit(["down"], { dir });
    assert.equal(down.code, 0, down.stderr);
    assert.equal(down.stdout, "stopped the devkit gateway\nstate kept in .mimi-dev; your agent keeps retrying until the next mimi-dev up\n");
    await assert.rejects(connect(p), /the devkit gateway is not running at 127\.0\.0\.1:\d+; run mimi-dev up/);
    assert.equal((await devkit(["down"], { dir })).stdout.split("\n")[0], "the devkit gateway was not running");

    const again = await devkit(["up"], { dir });
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(again.stdout.split("\n").slice(0, 2), [
        `gateway  started at 127.0.0.1:${state?.port}, log .mimi-dev/gateway/gateway.log`,
        `model    stub-a: vllm at ${stub.url}, org/stub-a, ctx 8000`,
    ]);
    assert.deepEqual(readState(p), state);
    assert.equal(readFileSync(p.deviceKey, "utf8"), key, "no second pairing");
    (await connect(p)).close();
});

test("a killed gateway: commands say to run up; up refuses a port another program took, and --port moves it", async (t) => {
    const dir = makeAgentDir(t);
    const stub = await startStubModel(t);
    assert.equal((await up(dir, stub)).code, 0);
    const p = devPaths(dir);
    const port = readState(p)?.port;
    process.kill(Number(readFileSync(join(p.gatewayHome, "gateway.pid"), "utf8").split(" ")[0]), "SIGKILL");
    await sleep(300);
    const chat = await devkit(["chat", "-m", "hi"], { dir });
    assert.deepEqual([chat.code, chat.stderr], [3, `mimi-dev chat: the devkit gateway is not running at 127.0.0.1:${port}; run mimi-dev up\n`]);

    // a dev server answering 200 on every path is not the devkit gateway
    const squatter = createServer((_req, res) => res.end("<!doctype html>")).listen(port, "127.0.0.1");
    t.after(() => squatter.close());
    const taken = await devkit(["up"], { dir });
    assert.equal(taken.code, 3);
    assert.match(taken.stderr, new RegExp(`^mimi-dev up: mimi start failed: port ${port} on 127\\.0\\.0\\.1 is busy — `));
    assert.match(taken.stderr, /\n  with devkit: mimi-dev up --port <n>, then mimi-dev invite --write\n$/);

    // a random free port: the 46465 range belongs to the test of the default pick
    const free = createServer().listen(0, "127.0.0.1");
    await new Promise((done) => free.once("listening", done));
    const moved = (free.address() as { port: number }).port;
    await new Promise((done) => free.close(done));
    const again = await devkit(["up", "--port", `${moved}`], { dir });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.stdout.split("\n")[0], `gateway  started at 127.0.0.1:${moved}, log .mimi-dev/gateway/gateway.log`);
    assert.equal(readState(p)?.port, moved);
});

test("down --reset deletes .mimi-dev", async (t) => {
    const dir = makeAgentDir(t);
    const stub = await startStubModel(t);
    assert.equal((await up(dir, stub)).code, 0);
    const reset = await devkit(["down", "--reset"], { dir });
    assert.equal(reset.code, 0, reset.stderr);
    assert.match(reset.stdout, /^stopped the devkit gateway\nremoved .*\.mimi-dev\nstop your agent, then mimi-dev up, mimi-dev invite --write, and start it again\n$/);
    assert.equal(existsSync(join(dir, ".mimi-dev")), false);
    assert.equal((await devkit(["down"], { dir })).stdout, "no devkit gateway in this folder\n");
});

test("the cli: usage, help and unknown commands", async (t) => {
    const dir = makeAgentDir(t);
    const none = await devkit([], { dir });
    assert.equal(none.code, 2);
    assert.match(none.stderr, /^usage: mimi-dev <command>/);
    const help = await devkit(["help"], { dir });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^usage: mimi-dev <command>[^]*exit codes: 0 passed, 1 failed, 2 usage, 3 environment\n$/);
    const unknown = await devkit(["launch"], { dir });
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /^unknown command "launch"\n/);
    const offline = await devkit(["invite", "--dir", dir], { dir: "/" });
    assert.deepEqual([offline.code, offline.stderr], [2, "mimi-dev invite: the devkit gateway has no model yet; run mimi-dev up first\n"]);
});
