/** The real path: the devkit CLI spawning the real gateway CLI, a real SDK agent the test starts, an OpenAI-compatible stub as the provider. */
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { createFakeModel, type FakeModel, type ScriptedTurn } from "@mimi-os/sdk/testing";

import { connect } from "../src/api.ts";
import type { MimiResult } from "../src/gateway.ts";
import { devPaths } from "../src/state.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const FIXTURE = join(import.meta.dirname, "fixtures", "notes");
const agents = new Map<string, ChildProcess[]>();

/** A temp copy of the notes agent folder; after the test its agents are killed, its devkit gateway is stopped and the folder goes. */
export function makeAgentDir(t: TestContext): string {
    const dir = mkdtempSync(join(tmpdir(), "mimi-dev-"));
    copyFileSync(join(FIXTURE, "agent.json"), join(dir, "agent.json"));
    t.after(async () => {
        for (const child of agents.get(dir) ?? []) child.kill();
        await devkit(["down"], { dir });
        rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}

export async function startStubModel(t: TestContext, turns: ScriptedTurn[] = []): Promise<FakeModel> {
    const model = createFakeModel(turns);
    await model.listen();
    t.after(() => model.close());
    return model;
}

export const textTurn = (text: string): ScriptedTurn => ({
    events: [
        { kind: "text", text },
        { kind: "finish", reason: "stop" },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 8 },
});

/** The notes agent, run in `dir` as the developer runs it; its output lands in <dir>/agent.log. */
export function startAgent(dir: string, env: Record<string, string> = {}): ChildProcess {
    const log = openSync(join(dir, "agent.log"), "a");
    const child = spawn(process.execPath, [join(FIXTURE, "index.ts")], { cwd: dir, env: { ...process.env, ...env }, stdio: ["ignore", log, log] });
    agents.set(dir, [...(agents.get(dir) ?? []), child]);
    return child;
}

export function devkit(args: string[], opts: { dir: string; input?: string; env?: Record<string, string> }): Promise<MimiResult> {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: opts.dir, env: { ...process.env, NO_COLOR: "1", ...opts.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (s: string) => (stdout += s));
    child.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
    child.stdin.end(opts.input ?? "");
    return new Promise((done) => child.once("close", (code) => done({ code: code ?? 1, stdout, stderr })));
}

/** `up` against the stub on a port no parallel test takes. */
export async function up(dir: string, model: FakeModel, extra: string[] = []): Promise<MimiResult> {
    const port = await new Promise<number>((done) => {
        const server = createServer().listen(0, "127.0.0.1", () => {
            const { port } = server.address() as { port: number };
            server.close(() => done(port));
        });
    });
    return devkit(["up", "--provider", "vllm", "--url", model.url, "--model", "org/stub-a", "--ctx", "8000", "--port", `${port}`, ...extra], { dir });
}

export async function waitConnected(dir: string, agent: string, ms = 20_000): Promise<void> {
    const api = await connect(devPaths(dir));
    try {
        for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(200)) {
            const list = await api.get<{ name: string; connected: boolean }[]>("/api/agents");
            if (list.some((a) => a.name === agent && a.connected)) return;
        }
        throw new Error(`${agent} did not connect within ${ms} ms`);
    } finally {
        api.close();
    }
}
