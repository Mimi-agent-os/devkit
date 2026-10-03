/** `mimi-dev check`: what the gateway made of the agent, as a checklist with one cause and one fix per problem. */
import { parseArgs } from "node:util";

import { type AgentApp, type AgentManifest, type PackDisabled, type PromptPart, type ToolSchema } from "@mimi-os/protocol";
import { loadAgentEnv } from "@mimi-os/sdk";

import { connect } from "./api.ts";
import { agentName, devPaths, DIR_OPTION, readState } from "./state.ts";
import { DevError, out, paint, row } from "./term.ts";

interface Described {
    manifest: AgentManifest;
    tools: ToolSchema[];
    prompt: PromptPart[] | null;
    app: AgentApp | null;
    bytes: number | null;
    dropped: { kind: string; name?: string; reason: string }[];
    gatewayTools: string[];
    lastError: string | null;
    packsDisabled: PackDisabled[];
    model: { asked: string | null; runsOn: string | null; ok: boolean; reason?: string };
}

interface Problem {
    level: "fail" | "warn";
    cause: string;
    fix: string;
}

interface Block {
    label: string;
    summary: string;
    problems: Problem[];
}

const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const TOOL_NAME = /^[A-Za-z0-9_-]+$/;
const DESCRIBE_MAX = 512 * 1024;
const APP_MS = 10_000;
const DROP_FIX: Record<string, string> = {
    tool: "fix that tool in its defineTool, then restart the agent",
    prompt: "give that prompt section some text, or leave it out",
    a2a: "list only mounted tools in a2a, without the a2a_ prefix",
    app: "declare the app with a title and an http upstream on the agent's own machine",
    manifest: "keep agent.json's description to one short line",
};

export async function run(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        options: { ...DIR_OPTION, prompt: { type: "boolean" }, json: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
    });
    if (positionals.length > 1) throw new DevError("check takes one agent name at most", 2);
    const p = devPaths(values.dir);
    const agent = positionals[0] ?? agentName(p);
    const port = readState(p)?.port;
    const api = await connect(p);

    const blocks: Block[] = [];
    const block = (label: string, summary: string): Problem[] => {
        const problems: Problem[] = [];
        blocks.push({ label, summary, problems });
        return problems;
    };
    let connected = false;
    let prompt: PromptPart[] = [];
    try {
        // ---- agent: connected and approved, or the one likely cause from local reads
        const agents = await api.get<{ name: string; connected: boolean; status: string | null }[]>("/api/agents");
        const card = agents.find((a) => a.name === agent);
        connected = card?.connected === true;
        if (!connected) {
            const [pins, { invites }] = await Promise.all([
                api.get<{ name: string; status: string }[]>("/api/pins"),
                api.get<{ invites: { name: string }[] }>("/api/agent-invites"),
            ]);
            const pin = pins.find((x) => x.name === agent);
            let env: Record<string, string | undefined> = {};
            let unreadable = "";
            try {
                env = loadAgentEnv(p.dir);
            } catch (e) {
                unreadable = (e as Error).message;
            }
            const url = env["MIMI_GATEWAY_URL"];
            const reinvite = "run mimi-dev invite --write, then restart the agent";
            // the first that holds is the cause, in the order a developer would hit them
            const causes: [boolean, string, string][] = [
                [pin?.status === "blocked", `the gateway blocked ${agent}'s key`, "mimi-dev down --reset, then mimi-dev up, mimi-dev invite --write and start the agent again"],
                [unreadable !== "", `the agent's .env cannot be read: ${unreadable}`, "repair or delete .env, then mimi-dev invite --write"],
                [pin === undefined && !env["MIMI_INVITE"], ".env has no MIMI_INVITE, so the agent has nothing to pair with", reinvite],
                [!url, ".env has no MIMI_GATEWAY_URL, so the agent dials another gateway", reinvite],
                [URL.parse(url ?? "")?.port !== `${port}`, `MIMI_GATEWAY_URL is ${url}, but the devkit gateway listens on port ${port}`, reinvite],
                [!env["MIMI_DATA_DIR"], ".env has no MIMI_DATA_DIR, so the agent keeps its key in data/, not .mimi-dev/agent-data", reinvite],
                [pin !== undefined, `${agent} is paired but not running`, "start the agent; if it is running, its output says why it cannot connect"],
                [invites.some((i) => i.name === agent), `${agent} has not redeemed its invite yet`, "start the agent; a running one reads .env every 30 s, unless it booted before MIMI_DATA_DIR was set: then restart it"],
            ];
            const [, cause, fix] = causes.find(([holds]) => holds) ?? [true, `the MIMI_INVITE in .env is spent or expired, and ${agent} was never paired`, reinvite];
            block("agent", `${agent}, not connected`).push({ level: "fail", cause, fix });
        } else {
            const d = await api.get<Described>(`/api/agents/${agent}/describe`);
            const models = await api.get<{ name: string; contextTokens: number }[]>("/api/models");
            const ctx = models.find((m) => m.name === d.model.runsOn)?.contextTokens ?? null;
            prompt = d.prompt ?? [];
            const overBudget = d.lastError?.includes("-byte limit") === true;

            const agentProblems = block("agent", `${agent}, connected, ${card?.status ?? "no pin"}`);
            if (d.lastError !== null && !overBudget) {
                agentProblems.push({ level: "warn", cause: `the agent reports: ${d.lastError}`, fix: "see the agent's output" });
            }

            // ---- model: the one a turn of this agent gets
            const { asked, runsOn, ok, reason } = d.model;
            const devModel = readState(p)?.model ?? null;
            const assign = "mimi-dev invite gives the agent the devkit model";
            if (!ok) {
                const limited = reason?.includes("limit") === true;
                block("model", `the agent asks for ${asked ?? "the default"}; no model runs it`).push({
                    level: "fail",
                    cause: reason ?? "no model",
                    fix: limited ? "raise the day's limit with mimi-dev up --limit <n>usd, or --limit off" : assign,
                });
            } else {
                const on = asked === null || asked === runsOn ? `runs on ${runsOn}` : `the agent asks for ${asked}; the gateway runs it on ${runsOn}`;
                const modelProblems = block("model", ctx === null ? on : `${on}, ctx ${ctx}`);
                if (devModel !== null && runsOn !== devModel) {
                    modelProblems.push({ level: "warn", cause: `${runsOn} is not the devkit model ${devModel}`, fix: assign });
                }
            }

            // ---- manifest
            const { name, description, policy } = d.manifest;
            const manifest = block("manifest", description ? `${name}: ${description}` : name);
            if (!description) {
                manifest.push({
                    level: "warn",
                    cause: "agent.json has no description; an orchestrator routes by it",
                    fix: `add one line of what ${agent} does as "description" in agent.json`,
                });
            }
            const toolNames = new Set(d.tools.map((t) => t.name));
            for (const allowed of policy?.allowedTools ?? []) {
                if (toolNames.has(allowed) || d.gatewayTools.includes(allowed)) continue;
                manifest.push({
                    level: "fail",
                    cause: `policy.allowedTools names ${allowed}, which the agent does not declare`,
                    fix: `drop ${allowed} from policy.allowedTools, or mount that tool`,
                });
            }

            // ---- packs
            const disabled = d.packsDisabled;
            const packs = block("packs", disabled.length === 0 ? "none disabled" : `${disabled.map((x) => x.name).join(", ")} disabled`);
            for (const pack of disabled) {
                const keys = pack.missing.join(", ");
                packs.push({ level: "warn", cause: `${pack.name} is off: ${keys} not set`, fix: `set ${keys} in the agent's .env, then restart it` });
            }

            // ---- tools: devkit's own schema lint; the gateway stores parameters as given
            const writes = d.tools.filter((t) => t.writes).map((t) => t.name);
            const tools = block("tools", writes.length === 0 ? `${d.tools.length}` : `${d.tools.length}, asks approval: ${writes.join(", ")}`);
            for (const t of d.tools) {
                const rename = `rename ${t.name} in its defineTool, then restart the agent`;
                if (!TOOL_NAME.test(t.name)) {
                    tools.push({ level: "fail", cause: `${t.name}: providers accept only letters, digits, _ and - in a tool name`, fix: rename });
                }
                if (t.name.length > 64) {
                    tools.push({ level: "warn", cause: `${t.name}: a name over 64 chars is refused by some providers`, fix: rename });
                }
                if (t.parameters !== undefined) {
                    const fix = `correct ${t.name}'s parameters in its defineTool, then restart the agent`;
                    for (const problem of lintSchema(t.parameters)) tools.push({ level: "fail", cause: `${t.name}: ${problem}`, fix });
                }
                const words = (t.description ?? "").split(/\s+/).filter(Boolean).length;
                const explain = `say in ${t.name}'s description when the model should call it`;
                if (words === 0) {
                    tools.push({ level: "warn", cause: `${t.name} has no description, so the model sees only its name`, fix: explain });
                } else if (words < 3) {
                    tools.push({ level: "warn", cause: `${t.name}: "${t.description}" is too short to tell the model when to call it`, fix: explain });
                }
            }

            // ---- dropped: what the gateway left out, with its reasons
            const dropped = block("dropped", d.dropped.length === 0 ? "nothing" : `${d.dropped.length}`);
            for (const x of d.dropped) {
                const shadowed = x.kind === "tool" && x.name !== undefined && d.gatewayTools.includes(x.name);
                dropped.push({
                    level: "fail",
                    cause: `${x.kind}${x.name === undefined ? "" : ` ${x.name}`}: ${x.reason}`,
                    fix: shadowed ? `rename ${x.name}; the gateway's own tool of that name takes every call` : (DROP_FIX[x.kind] ?? "fix it in the agent, then restart it"),
                });
            }

            // ---- prompt: what every turn carries, measured at 4 bytes a token
            const size = Buffer.byteLength(JSON.stringify(prompt)) + Buffer.byteLength(JSON.stringify(d.tools));
            const tokens = Math.round(size / 4);
            const share = ctx === null ? null : tokens / ctx;
            const percent = share === null ? "" : ` (${(share * 100).toFixed(1)}% of ctx)`;
            const about = tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}k`;
            const prompts = block("prompt", `${prompt.length} section${prompt.length === 1 ? "" : "s"} and ${d.tools.length} tool schemas, ${(size / 1024).toFixed(1)} KiB, about ${about} tokens${percent}`);
            if (d.lastError !== null && overBudget) {
                prompts.push({ level: "fail", cause: `the agent reports: ${d.lastError}`, fix: "shorten that prompt section; past 512 KiB the gateway never sees it" });
            }
            if (share !== null && share > 0.25) {
                prompts.push({
                    level: share > 0.6 ? "fail" : "warn",
                    cause: `prompt and tool schemas take about ${(share * 100).toFixed(0)}% of the ${ctx}-token context, before any chat`,
                    fix: "shorten the persona, pack skills and tool descriptions, or raise --ctx on mimi-dev up if the model has room",
                });
            }
            if (d.bytes !== null && d.bytes > DESCRIBE_MAX / 2) {
                prompts.push({
                    level: "warn",
                    cause: `the agent's prompt, tools and avatar take ${(d.bytes / 1024).toFixed(0)} KiB, over half of the 512 KiB the gateway accepts`,
                    fix: "shorten the persona or pack text; past 512 KiB the agent leaves sections out",
                });
            }

            // ---- app: launched through the gateway's own door, as the app would open it
            if (d.app === null) {
                block("app", "none declared");
            } else {
                const { title, upstream } = d.app;
                const entry = d.app.entry ?? "/";
                const gateway = `http://127.0.0.1:${port}`;
                const ticket = `/api/apps/${agent}/ticket`;
                let status = 0;
                let failure = "";
                try {
                    const launch = await api.request<{ url?: string; error?: string }>("POST", ticket, {});
                    if (launch.status !== 200) throw new Error(`the gateway refused to launch it: ${launch.json.error ?? launch.status}`);
                    const door = await fetch(`${gateway}${launch.json.url}`, { redirect: "manual", signal: AbortSignal.timeout(APP_MS) });
                    const cookie = door.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
                    const page = await fetch(new URL(door.headers.get("location") ?? entry, gateway), { headers: { cookie }, signal: AbortSignal.timeout(APP_MS) });
                    await page.body?.cancel();
                    status = page.status;
                } catch (e) {
                    failure = (e as Error).message;
                }
                if (failure === "" && status < 400) {
                    block("app", `${title} answers ${status} at ${upstream}${entry}`);
                    const open = await api.post<{ url: string }>(ticket, {});
                    block("open", `${gateway}${open.url} (one visit, within 2 minutes)`);
                } else {
                    block("app", `${title} at ${upstream}${entry}`).push({
                        level: "fail",
                        cause: failure || (status === 502 || status === 504 ? `its server at ${upstream} did not answer (the gateway gave ${status})` : `it answered ${status}`),
                        fix: `start the app's server at ${upstream}, or correct app.upstream in runAgent`,
                    });
                }
            }
        }
    } finally {
        api.close();
    }

    const all = blocks.flatMap((b) => b.problems);
    const failures = all.filter((x) => x.level === "fail").length;
    const warnings = all.length - failures;
    if (values.json === true) {
        out(JSON.stringify({ agent, connected, failures, warnings, blocks, prompt: values.prompt === true ? prompt : undefined }, null, 2));
    } else {
        for (const b of blocks) {
            row(b.label, b.summary);
            // problems that share a fix print it once, after the last of them
            b.problems.forEach((x, i) => {
                out(`  ${x.level === "fail" ? paint.red("FAIL") : paint.yellow("warn")}   ${x.cause}`);
                if (b.problems[i + 1]?.fix !== x.fix) out(`         ${paint.dim("fix")} ${x.fix}`);
            });
        }
        if (values.prompt === true) {
            for (const part of prompt) out(`\n${paint.bold(`--- ${part.name} ---`)}\n${part.text}`);
            if (prompt.length > 0) out("");
        }
        out(`${failures} failure${failures === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`);
    }
    return !connected ? 3 : failures > 0 ? 1 : 0;
}

/** Tool parameters as providers read them: one message per problem, empty when the schema is sound. */
export function lintSchema(parameters: unknown): string[] {
    const problems: string[] = [];
    const walk = (node: unknown, at: string): void => {
        if (node === null || typeof node !== "object" || Array.isArray(node)) {
            problems.push(`${at} is not an object`);
            return;
        }
        const schema = node as Record<string, unknown>;
        const ref = schema["$ref"];
        if (ref !== undefined && !(typeof ref === "string" && ref.startsWith("#"))) {
            problems.push(`${at}.$ref ${JSON.stringify(ref)} points outside the schema`);
        }
        const type = schema["type"];
        if (at === "parameters" && type !== "object") {
            problems.push(`parameters.type is ${type === undefined ? "missing" : JSON.stringify(type)}; a tool's parameters must be "object"`);
            return;
        }
        const types = type === undefined ? [] : Array.isArray(type) ? type : [type];
        for (const t of types) {
            if (typeof t !== "string" || !JSON_TYPES.has(t)) problems.push(`${at}.type ${JSON.stringify(t)} is not a JSON Schema type`);
        }
        if (type === undefined && !["enum", "anyOf", "oneOf", "const", "$ref"].some((k) => k in schema)) {
            problems.push(`${at} has no type, enum, anyOf or oneOf`);
        }
        const enumValues = schema["enum"];
        if (enumValues !== undefined && (!Array.isArray(enumValues) || enumValues.length === 0)) problems.push(`${at}.enum is not a non-empty array`);
        for (const key of ["anyOf", "oneOf"]) {
            const options = schema[key];
            if (options === undefined) continue;
            if (!Array.isArray(options) || options.length === 0) problems.push(`${at}.${key} is not a non-empty array`);
            else options.forEach((o, i) => walk(o, `${at}.${key}[${i}]`));
        }
        if (types.includes("array")) {
            if (schema["items"] === undefined) problems.push(`${at} is an array with no items`);
            else walk(schema["items"], `${at}.items`);
        }
        if (!types.includes("object")) return;
        const properties = schema["properties"] ?? {};
        if (schema["properties"] === undefined && at === "parameters") {
            problems.push("parameters.properties is missing; {} declares a tool that takes no arguments");
        }
        if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
            problems.push(`${at}.properties is not an object`);
            return;
        }
        const names = Object.keys(properties);
        for (const [key, value] of Object.entries(properties)) walk(value, `${at}.properties.${key}`);
        const required = schema["required"];
        if (required === undefined) return;
        if (!Array.isArray(required)) {
            problems.push(`${at}.required is not an array`);
            return;
        }
        for (const r of required) {
            if (typeof r !== "string" || !names.includes(r)) {
                problems.push(`${at}.required names ${JSON.stringify(r)}, which is not a property (has: ${names.join(", ") || "none"})`);
            }
        }
    };
    walk(parameters, "parameters");
    return problems;
}
