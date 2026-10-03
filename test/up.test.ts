import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { connect } from "../src/api.ts";
import { pickPort } from "../src/gateway.ts";
import { devPaths, readState } from "../src/state.ts";
import { devkit, makeAgentDir, startAgent, startStubModel, up, waitConnected } from "./harness.ts";

interface Model {
    name: string;
    provider: string;
    endpoint: string;
    modelId?: string;
    contextTokens: number;
    isDefault: boolean;
    params: Record<string, unknown>;
}

async function gatewayView<T>(dir: string, path: string): Promise<T> {
    const api = await connect(devPaths(dir));
    try {
        return await api.get<T>(path);
    } finally {
        api.close();
    }
}

test("first up starts the gateway, pairs devkit and registers one default model", async (t) => {
    const dir = makeAgentDir(t);
    const stub = await startStubModel(t);
    const first = await up(dir, stub, ["--url", `${stub.url}/v1`, "--param", "temperature=0.6"]);
    assert.equal(first.code, 0, first.stderr);
    const state = readState(devPaths(dir));
    assert.equal(state?.model, "stub-a");
    const lines = first.stdout.split("\n");
    assert.equal(lines[0], `gateway  started at 127.0.0.1:${state?.port}, log .mimi-dev/gateway/gateway.log`);
    assert.equal(lines[1], "device   paired");
    // the /v1 a developer pastes is not stored
    assert.equal(lines[2], `model    stub-a: vllm at ${stub.url}, org/stub-a, ctx 8000, params {"temperature":0.6}`);
    assert.equal(lines[3], "key      VLLM_API_KEY not set, none sent");
    assert.equal(lines[4], "next     mimi-dev invite --write, then start your agent");
    assert.equal(statSync(join(dir, ".mimi-dev", "device.key")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(dir, ".mimi-dev", ".gitignore"), "utf8"), "*\n");

    const models = await gatewayView<Model[]>(dir, "/api/models");
    assert.deepEqual(
        models.map((m) => [m.name, m.provider, m.endpoint, m.modelId, m.contextTokens, m.isDefault]),
        [["stub-a", "vllm", stub.url, "org/stub-a", 8000, true]],
    );

    // a second up merges params (null removes one) and keeps the gateway and the device
    const again = await devkit(["up", "--param", "temperature=0.2", "--param", "top_k=20", "--param", "seed=null"], { dir });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /^gateway {2}running at 127\.0\.0\.1:\d+\n(?!device)/);
    assert.deepEqual((await gatewayView<Model[]>(dir, "/api/models"))[0]?.params, { temperature: 0.2, top_k: 20 });
    assert.equal((await devkit(["up", "--param", "top_k=null"], { dir })).code, 0);
    assert.deepEqual((await gatewayView<Model[]>(dir, "/api/models"))[0]?.params, { temperature: 0.2 });

    // prices and a limit through /api/limits, then the limit off
    const priced = await devkit(["up", "--price-in", "0.1", "--price-out", "0.3", "--limit", "1usd"], { dir });
    assert.equal(priced.code, 0, priced.stderr);
    assert.match(priced.stdout, /\nprice {4}\$0\.1 \/ \$0\.3 per 1M, limit 1 usd a day\n/);
    const limits = await gatewayView<{ name: string; priceInPerM: number; priceOutPerM: number; limit: unknown }[]>(dir, "/api/limits");
    assert.deepEqual(limits.map((l) => [l.name, l.priceInPerM, l.priceOutPerM, l.limit]), [["stub-a", 0.1, 0.3, { unit: "usd", value: 1 }]]);
    assert.equal((await devkit(["up", "--limit", "off"], { dir })).code, 0);
    assert.equal((await gatewayView<{ limit: unknown }[]>(dir, "/api/limits"))[0]?.limit, null);

    // another --model: the new entry is the default and the old one is gone
    const moved = await devkit(["up", "--provider", "vllm", "--url", stub.url, "--model", "org/stub-b", "--ctx", "4000"], { dir, env: { VLLM_API_KEY: "sk-test" } });
    assert.equal(moved.code, 0, moved.stderr);
    assert.match(moved.stdout, /\nkey {6}VLLM_API_KEY stored in the devkit gateway\n/);
    assert.deepEqual(
        (await gatewayView<Model[]>(dir, "/api/models")).map((m) => [m.name, m.contextTokens, m.isDefault]),
        [["stub-b", 4000, true]],
    );
    assert.equal(readState(devPaths(dir))?.model, "stub-b");

    // another provider under the same name: one entry, the new provider, the old context size
    const swapped = await devkit(["up", "--provider", "llamacpp", "--url", stub.url], { dir });
    assert.equal(swapped.code, 0, swapped.stderr);
    assert.deepEqual(
        (await gatewayView<Model[]>(dir, "/api/models")).map((m) => [m.name, m.provider, m.contextTokens, m.isDefault]),
        [["stub-b", "llamacpp", 4000, true]],
    );
});

test("a model change moves a connected agent's policy and leaves one model", async (t) => {
    const dir = makeAgentDir(t);
    const stub = await startStubModel(t);
    assert.equal((await up(dir, stub)).code, 0);
    assert.equal((await devkit(["invite", "--write"], { dir })).code, 0);
    startAgent(dir);
    await waitConnected(dir, "notes");

    const moved = await devkit(["up", "--model", "org/stub-b", "--provider", "vllm", "--url", stub.url, "--ctx", "4000"], { dir });
    assert.equal(moved.code, 0, moved.stderr);
    assert.match(moved.stdout, /\nagent {4}notes runs on stub-b\n$/);
    assert.deepEqual((await gatewayView<Model[]>(dir, "/api/models")).map((m) => m.name), ["stub-b"]);

    const swapped = await devkit(["up", "--provider", "llamacpp"], { dir });
    assert.equal(swapped.code, 0, swapped.stderr);
    assert.doesNotMatch(swapped.stdout, /warn/);
    assert.deepEqual((await gatewayView<Model[]>(dir, "/api/models")).map((m) => [m.name, m.provider]), [["stub-b", "llamacpp"]]);
    const policy = await gatewayView<{ primary: string; allowed: string[] }>(dir, "/api/agents/notes/models");
    assert.deepEqual([policy.primary, policy.allowed], ["stub-b", ["stub-b"]]);
    const described = await gatewayView<{ model: { asked: string; runsOn: string; ok: boolean } }>(dir, "/api/agents/notes/describe");
    assert.deepEqual(described.model, { asked: "qwen3.8-lan", runsOn: "stub-b", ok: true });
});

test("up refuses bad input with exit 2", async (t) => {
    const dir = makeAgentDir(t);
    const stub = await startStubModel(t);
    const bare = await devkit(["up"], { dir });
    assert.deepEqual([bare.code, bare.stderr], [2, "mimi-dev up: up needs --provider, --model and --ctx the first time\n"]);
    const noCtx = await devkit(["up", "--provider", "vllm", "--url", stub.url, "--model", "org/stub-a"], { dir });
    assert.equal(noCtx.code, 2);
    assert.equal(existsSync(join(dir, ".mimi-dev")), false, "nothing started");

    for (const [flags, message] of [
        [["--ctx", "lots"], '--ctx takes a number, not "lots"'],
        [["--param", "=1"], '--param takes key=<json>, not "=1"'],
        [["--limit", "5 dollars"], '--limit takes <n>usd, <n>tokens or off, not "5 dollars"'],
        [["--colour"], "Unknown option '--colour'"],
    ] as const) {
        const r = await up(dir, stub, [...flags]);
        assert.equal(r.code, 2, r.stderr);
        assert.ok(r.stderr.includes(message), r.stderr);
    }

    // the registry parser is the one validator: its 400 is printed as it is
    const unknown = await up(dir, stub, ["--provider", "nope"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /^mimi-dev up: models: model "stub-a" has unknown provider "nope"\. Known: /);
    assert.equal(readState(devPaths(dir))?.model, null);
});

test("with no --port, up takes the first free port above the owner's gateway", async (t) => {
    const port = await pickPort();
    assert.ok(port >= 46465 && port <= 46564, `${port}`);
    const dir = makeAgentDir(t);
    const stub = await startStubModel(t);
    const r = await devkit(["up", "--provider", "vllm", "--url", stub.url, "--model", "org/stub-a", "--ctx", "8000"], { dir });
    assert.equal(r.code, 0, r.stderr);
    const chosen = readState(devPaths(dir))?.port ?? 0;
    assert.ok(chosen >= 46465 && chosen <= 46564, `${chosen}`);
});
