/** `mimi-dev up`: the devkit gateway running, devkit paired with it, and exactly one model registered through its API. */
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

import { assignModel, connect, pair } from "./api.ts";
import { pickPort, runMimi } from "./gateway.ts";
import { agentName, devPaths, DIR_OPTION, readDeviceKey, readState, writeState } from "./state.ts";
import { DevError, row } from "./term.ts";

interface ModelInfo {
    name: string;
    provider: string;
    endpoint: string;
    modelId?: string | undefined;
    contextTokens: number;
    params: Record<string, unknown>;
    keySet: boolean;
}

interface LimitRow {
    priceInPerM: number;
    priceOutPerM: number;
    limit: { unit: "tokens" | "usd"; value: number } | null;
}

const num = (flag: string, text: string | undefined): number | undefined => {
    if (text === undefined) return undefined;
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n)) throw new DevError(`${flag} takes a number, not "${text}"`, 2);
    return n;
};

export async function run(argv: string[]): Promise<number> {
    const { values } = parseArgs({
        args: argv,
        options: {
            ...DIR_OPTION,
            provider: { type: "string" },
            url: { type: "string" },
            model: { type: "string" },
            ctx: { type: "string" },
            param: { type: "string", multiple: true },
            "price-in": { type: "string" },
            "price-out": { type: "string" },
            limit: { type: "string" },
            port: { type: "string" },
        },
        strict: true,
    });

    // every flag is read before anything starts
    const p = devPaths(values.dir);
    const state = readState(p);
    const agent = existsSync(join(p.dir, "agent.json")) ? agentName(p) : null;
    const ctx = num("--ctx", values.ctx);
    const port = num("--port", values.port);
    const params: Record<string, unknown> = {};
    for (const pair of values.param ?? []) {
        const eq = pair.indexOf("=");
        if (eq < 1) throw new DevError(`--param takes key=<json>, not "${pair}"`, 2);
        const raw = pair.slice(eq + 1);
        let value: unknown = raw;
        try {
            value = JSON.parse(raw);
        } catch {
            // not JSON: the value is the string as typed
        }
        params[pair.slice(0, eq)] = value;
    }
    let limit: LimitRow["limit"] | undefined;
    if (values.limit === "off") limit = null;
    else if (values.limit !== undefined) {
        const m = /^(\d+(?:\.\d+)?)(usd|tokens)$/.exec(values.limit);
        if (!m) throw new DevError(`--limit takes <n>usd, <n>tokens or off, not "${values.limit}"`, 2);
        limit = { unit: m[2] as "usd" | "tokens", value: Number(m[1]) };
    }
    const pricing = { priceInPerM: num("--price-in", values["price-in"]), priceOutPerM: num("--price-out", values["price-out"]), limit };
    const priced = Object.values(pricing).some((v) => v !== undefined);
    const changes = [values.provider, values.url, values.model, ctx, values.param].some((v) => v !== undefined);
    const name = values.model === undefined ? (state?.model ?? null) : (values.model.split("/").at(-1) ?? "");
    if (name === null || (name !== state?.model && (values.provider === undefined || values.model === undefined || ctx === undefined))) {
        throw new DevError(`up needs --provider, --model and --ctx ${state?.model ? "for a new model" : "the first time"}`, 2);
    }

    // ── the gateway, on the port it had; a new --port moves it ──
    const gatewayPort = port ?? state?.port ?? (await pickPort());
    if (state !== null && gatewayPort !== state.port) {
        const stopped = await runMimi(p, ["stop"]);
        if (stopped.code !== 0) throw new DevError(`mimi stop failed: ${stopped.stderr.trim()}`, 3);
    }
    const started = await runMimi(p, ["start", "--port", `${gatewayPort}`]);
    if (started.code !== 0) {
        // the port devkit kept is taken: moving the gateway also moves the address in the agent's .env
        const busy = started.stderr.includes("is busy") ? "\n  with devkit: mimi-dev up --port <n>, then mimi-dev invite --write" : "";
        throw new DevError(`mimi start failed: ${started.stderr.trim()}${busy}`, 3);
    }
    writeState(p, { port: gatewayPort, model: state?.model ?? null });
    row(
        "gateway",
        started.stdout.startsWith("already running")
            ? `running at 127.0.0.1:${gatewayPort}`
            : `started at 127.0.0.1:${gatewayPort}, log ${relative(p.dir, join(p.gatewayHome, "gateway.log"))}`,
    );
    if (readDeviceKey(p) === null) {
        await pair(p, gatewayPort);
        row("device", "paired");
    }

    const api = await connect(p);
    try {
        const models = await api.get<ModelInfo[]>("/api/models");
        const current = models.find((m) => m.name === name);
        const provider = values.provider ?? current?.provider;
        const providers = await api.get<{ kind: string; keyEnv?: string; defaultEndpoint?: string }[]>("/api/providers");
        const { keyEnv, defaultEndpoint } = providers.find((k) => k.kind === provider) ?? {};
        const apiKey = keyEnv === undefined ? undefined : process.env[keyEnv] || undefined;
        // the devkit model this run replaces; it goes once the new one is the default and the agent's
        const stale = models.filter((m) => m.name === state?.model && m.name !== name).map((m) => m.name);

        if (changes && current !== undefined && provider === current.provider) {
            const merged = Object.entries({ ...current.params, ...params }).filter(([, v]) => v !== null);
            const body = {
                endpoint: values.url,
                modelId: values.model,
                contextTokens: ctx,
                params: values.param === undefined ? undefined : Object.fromEntries(merged),
                apiKey,
            };
            if (Object.values(body).some((v) => v !== undefined)) await api.patch(`/api/models/${name}`, body);
        } else if (changes) {
            const modelId = values.model ?? current?.modelId;
            const contextTokens = ctx ?? current?.contextTokens;
            if (provider === undefined || modelId === undefined || contextTokens === undefined) {
                throw new DevError("up needs --provider, --model and --ctx for a model it has not registered", 2);
            }
            // another provider under the same name: the old row steps aside and goes with the other stale ones
            const aside = `${name}.replaced`;
            if (current !== undefined) {
                await api.patch(`/api/models/${name}`, { name: aside });
                stale.push(aside);
            }
            const entry = {
                name,
                provider,
                // a switch between local servers keeps the address; a provider with its own default takes that
                endpoint: values.url ?? (defaultEndpoint === undefined ? current?.endpoint : undefined),
                modelId,
                contextTokens,
                params: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null)),
                apiKey,
            };
            await api.post("/api/models", entry).catch(async (e: unknown) => {
                if (current !== undefined) await api.patch(`/api/models/${aside}`, { name });
                throw e;
            });
        } else if (current === undefined) {
            throw new DevError(`the devkit gateway has no model ${name}; run up with --provider, --model and --ctx`, 2);
        }
        if (changes) await api.post(`/api/models/${name}/default`);
        writeState(p, { port: gatewayPort, model: name });

        const assigned = agent !== null && (await assignModel(api, agent, name));
        for (const old of stale) {
            const gone = await api.request<{ error?: string }>("DELETE", `/api/models/${old}`);
            if (gone.status >= 300) row("warn", `kept the old model ${old}: ${gone.json?.error ?? gone.status}`);
        }

        const m = (await api.get<ModelInfo[]>("/api/models")).find((x) => x.name === name);
        if (m === undefined) throw new DevError(`the devkit gateway lost the model ${name}`, 3);
        const shownParams = Object.keys(m.params).length > 0 ? `, params ${JSON.stringify(m.params)}` : "";
        row("model", `${name}: ${m.provider} at ${m.endpoint}, ${m.modelId ?? name}, ctx ${m.contextTokens}${shownParams}`);
        if (changes && keyEnv !== undefined) {
            row("key", apiKey !== undefined ? `${keyEnv} stored in the devkit gateway` : m.keySet ? `${keyEnv} kept as stored` : `${keyEnv} not set, none sent`);
        }
        if (priced) {
            const l = await api.patch<LimitRow>(`/api/limits/${name}`, pricing);
            const cap = l.limit === null ? "no limit" : `limit ${l.limit.value} ${l.limit.unit} a day`;
            row("price", `$${l.priceInPerM} / $${l.priceOutPerM} per 1M, ${cap}`);
        }
        if (assigned) row("agent", `${agent} runs on ${name}`);
        else row("next", "mimi-dev invite --write, then start your agent");
    } finally {
        api.close();
    }
    return 0;
}
