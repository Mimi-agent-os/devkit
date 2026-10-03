/** `mimi-dev test`: scenario files against the connected agent, each run a fresh chat, a pass rate per scenario. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { connect, requireAgent } from "./api.ts";
import { agentName, devPaths, DIR_OPTION } from "./state.ts";
import { DevError, out, paint } from "./term.ts";
import { clip, newConversation, num, runTurn, usd } from "./turn.ts";

export interface ExpectedTool {
    name: string;
    /** A subset of the call's arguments; absent matches any call of the tool. */
    args?: Record<string, unknown> | undefined;
}

export interface Scenario {
    name: string;
    turns: { user: string; tools: ExpectedTool[]; contains: string[] }[];
    runs?: number | undefined;
    approve: "all" | "none" | string[];
}

/** Every key of an expected object is in the actual one with a matching value; objects recurse, arrays and scalars compare exactly. */
export function matchArgs(expected: unknown, actual: unknown): boolean {
    const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    if (!isObject(expected)) return isDeepStrictEqual(expected, actual);
    return isObject(actual) && Object.entries(expected).every(([k, v]) => Object.hasOwn(actual, k) && matchArgs(v, actual[k]));
}

/** A scenario file; anything off is a DevError 2 naming the file and the key. */
export function parseScenario(file: string, text: string): Scenario {
    const bad = (key: string, why: string): DevError => new DevError(`${file}: ${key} ${why}`, 2);
    const record = (value: unknown, key: string, keys?: string[]): Record<string, unknown> => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw bad(key, "must be an object");
        const extra = Object.keys(value).find((k) => keys !== undefined && !keys.includes(k));
        if (extra !== undefined) throw bad(key === "the file" ? extra : `${key}.${extra}`, `is not a scenario key (${keys?.join(", ")})`);
        return value as Record<string, unknown>;
    };
    const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((s) => typeof s === "string" && s !== "");

    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch (e) {
        throw new DevError(`${file}: not JSON (${(e as Error).message})`, 2);
    }
    const { name = basename(file, ".json"), turns, runs, approve = "none" } = record(json, "the file", ["name", "turns", "runs", "approve"]);
    if (typeof name !== "string" || name === "") throw bad("name", "must be a non-empty string");
    if (runs !== undefined && !(Number.isInteger(runs) && (runs as number) > 0)) throw bad("runs", "must be a whole number above 0");
    if (approve !== "all" && approve !== "none" && !strings(approve)) throw bad("approve", 'must be "all", "none" or a list of tool names');
    if (!Array.isArray(turns) || turns.length === 0) throw bad("turns", "must be a non-empty list");

    return {
        name,
        runs: runs as number | undefined,
        approve,
        turns: turns.map((raw: unknown, i) => {
            const at = `turns[${i}]`;
            const turn = record(raw, at, ["user", "expect"]);
            if (typeof turn["user"] !== "string" || !turn["user"].trim()) throw bad(`${at}.user`, "must be a non-empty string");
            const expect = turn["expect"] === undefined ? {} : record(turn["expect"], `${at}.expect`, ["tools", "reply"]);
            const reply = expect["reply"] === undefined ? {} : record(expect["reply"], `${at}.expect.reply`, ["contains"]);
            const contains = reply["contains"] ?? [];
            if (!strings(contains)) throw bad(`${at}.expect.reply.contains`, "must be a list of non-empty strings");
            const tools = expect["tools"] ?? [];
            if (!Array.isArray(tools)) throw bad(`${at}.expect.tools`, 'must be a list of tool names or { "name", "args" }');
            return {
                user: turn["user"],
                contains,
                tools: tools.map((entry: unknown, j): ExpectedTool => {
                    if (typeof entry === "string" && entry !== "") return { name: entry };
                    const tool = record(entry, `${at}.expect.tools[${j}]`, ["name", "args"]);
                    if (typeof tool["name"] !== "string" || tool["name"] === "") throw bad(`${at}.expect.tools[${j}].name`, "must be a tool name");
                    const args = tool["args"] === undefined ? undefined : record(tool["args"], `${at}.expect.tools[${j}].args`);
                    return { name: tool["name"], args };
                }),
            };
        }),
    };
}

interface Failure {
    run: number;
    chat: number;
    turn: number;
    reason: string;
}

export async function run(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: { ...DIR_OPTION, runs: { type: "string" }, "min-pass": { type: "string" }, json: { type: "boolean" } },
    });
    const runs = values.runs === undefined ? undefined : Number(values.runs);
    if (runs !== undefined && !(Number.isInteger(runs) && runs > 0)) throw new DevError("--runs takes a whole number above 0", 2);
    const minPass = values["min-pass"] === undefined ? 1 : Number(values["min-pass"]);
    if (!(minPass >= 0 && minPass <= 1) || values["min-pass"]?.trim() === "") throw new DevError("--min-pass takes a rate from 0 to 1", 2);

    // every file is parsed before anything runs, so a typo costs no model calls
    const p = devPaths(values.dir);
    const shown = (f: string): string => relative(process.cwd(), f) || ".";
    const files = (positionals.length > 0 ? positionals.map((f) => resolve(f)) : [join(p.dir, "scenarios")]).flatMap((f) => {
        const stat = statSync(f, { throwIfNoEntry: false });
        if (stat === undefined) throw new DevError(`${shown(f)} does not exist; scenarios live in scenarios/<name>.json, or pass their paths`, 2);
        return stat.isDirectory() ? readdirSync(f).filter((n) => n.endsWith(".json")).sort().map((n) => join(f, n)) : [f];
    });
    if (files.length === 0) throw new DevError("no scenario files; put <name>.json files in scenarios/, or pass their paths", 2);
    const scenarios = files.map((f) => parseScenario(shown(f), readFileSync(f, "utf8")));

    const agent = agentName(p);
    const api = await connect(p);
    const interrupt = new AbortController();
    const onSigint = (): void => interrupt.abort();
    process.on("SIGINT", onSigint);
    // a raw terminal hands Ctrl-C to this process alone: `pnpm exec` would otherwise exit before the turn is stopped
    const keys = process.stdin.isTTY ? process.stdin.setRawMode(true) : null;
    const onKey = (b: Buffer): void => {
        if (b.includes(3)) interrupt.abort();
    };
    keys?.on("data", onKey);
    const started = performance.now();
    const total = { runs: 0, passed: 0, calls: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    const report: { name: string; runs: number; passed: number; failures: Failure[] }[] = [];
    try {
        await requireAgent(api, agent);
        if (!values.json) {
            out(`${agent}: ${scenarios.length} ${scenarios.length === 1 ? "scenario" : "scenarios"}, a fresh chat per run`);
            out(paint.dim("every run shares the agent's store; devkit never restarts the agent"));
        }
        const width = Math.max(...scenarios.map((s) => s.name.length));
        for (const scenario of scenarios) {
            const count = runs ?? scenario.runs ?? 1;
            const approves = (tool: string): boolean => scenario.approve === "all" || (Array.isArray(scenario.approve) && scenario.approve.includes(tool));
            const failures: Failure[] = [];
            for (let k = 1; k <= count; k++) {
                const chat = await newConversation(api, agent, `test: ${scenario.name} #${k}`);
                for (const [i, turn] of scenario.turns.entries()) {
                    // a call the gateway refused to run (a denied write, bad args) streams a result with no tool_call
                    const ran = new Set<string>();
                    const refused = new Map<string, string>();
                    const result = await runTurn(api, agent, chat, turn.user, {
                        render: false,
                        approve: async (tool) => approves(tool),
                        signal: interrupt.signal,
                        onLine: (line) => {
                            if (line["type"] === "tool_call") ran.add(String(line["id"]));
                            if (line["type"] === "tool_result" && !ran.has(String(line["id"]))) refused.set(String(line["name"]), String(line["text"] ?? ""));
                        },
                    });
                    total.calls += result.footer.calls;
                    total.promptTokens += result.footer.promptTokens;
                    total.completionTokens += result.footer.completionTokens;
                    total.cost += result.footer.cost;
                    if (interrupt.signal.aborted) throw new DevError("interrupted; the running turn was stopped", 1);

                    let reason: string | null = result.status === "done" ? null : `the turn ended in ${result.status}${result.error ? `: ${result.error}` : ""}`;
                    const called = result.tools.map((c) => `${c.name} ${clip(JSON.stringify(c.args ?? {}), 60)}`).join(", ") || "no tool";
                    for (const want of turn.tools) {
                        if (reason !== null) break;
                        if (result.tools.some((c) => c.name === want.name && (want.args === undefined || matchArgs(want.args, c.args)))) continue;
                        const why = refused.get(want.name);
                        const wanted = `no ${want.name} call${want.args === undefined ? "" : ` with ${JSON.stringify(want.args)}`}`;
                        reason =
                            why === undefined
                                ? `${wanted}; it called ${called}`
                                : `${wanted}; ${want.name} did not run: ${clip(why, 80)}${approves(want.name) ? "" : ` (approve does not list ${want.name})`}`;
                    }
                    const missing = turn.contains.find((s) => !result.answer.toLowerCase().includes(s.toLowerCase()));
                    if (reason === null && missing !== undefined) {
                        reason = `the reply lacks "${missing}": ${result.answer.trim() ? JSON.stringify(clip(result.answer, 80)) : "it is empty"}`;
                    }
                    if (reason !== null) {
                        failures.push({ run: k, chat, turn: i + 1, reason });
                        break;
                    }
                }
            }

            const passed = count - failures.length;
            total.runs += count;
            total.passed += passed;
            report.push({ name: scenario.name, runs: count, passed, failures });
            if (values.json) continue;
            const verdict = passed === count ? paint.green("pass    ") : passed === 0 ? paint.red("fail    ") : paint.yellow("flaky   ");
            out(`${verdict} ${scenario.name.padEnd(width)}  ${passed}/${count}`);
            for (const f of failures) out(`         run ${f.run}, chat ${f.chat}, turn ${f.turn}: ${f.reason}`);
        }
    } finally {
        process.off("SIGINT", onSigint);
        keys?.off("data", onKey).setRawMode(false).pause();
        api.close();
    }

    const durationMs = Math.round(performance.now() - started);
    const below = report.filter((s) => s.passed / s.runs < minPass).map((s) => s.name);
    if (values.json) {
        out(JSON.stringify({ agent, sharedStore: true, minPass, scenarios: report, total: { ...total, durationMs }, below }));
    } else {
        const rate = `${Math.round((total.passed / total.runs) * 100)}%`;
        const cost = total.cost > 0 ? `, ${usd(total.cost)}` : "";
        const tokens = `${num(total.promptTokens)} in / ${num(total.completionTokens)} out`;
        out(`total    ${total.passed}/${total.runs} runs passed (${rate}), ${total.calls} calls, ${tokens}${cost}, ${(durationMs / 1000).toFixed(1)} s`);
        if (below.length > 0) out(paint.red(`below --min-pass ${minPass}: ${below.join(", ")}`));
    }
    return below.length > 0 ? 1 : 0;
}
