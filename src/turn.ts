/** One turn over the desktop's own routes: the ndjson turn stream, its gates and this agent's chatless gates from /api/events. */
import type { Line } from "mimi-gateway/device-client";

import type { Api } from "./api.ts";
import { DevError, out, paint } from "./term.ts";

export interface ToolCall {
    name: string;
    args: unknown;
    /** The tool's text as the model read it; absent when the turn ended first. */
    result?: string | undefined;
}

export interface TurnFooter {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    /** The gateway's cost at the model's current price; devkit never multiplies prices. */
    cost: number;
    durationMs: number;
    firstOutputMs: number | null;
    tokensPerSec: number | null;
    estimated: boolean;
}

export interface TurnOptions {
    /** Print the turn as it streams, then its footer. */
    render: boolean;
    /** One gate action; `signal` aborts when the gate closes elsewhere or the turn ends first. */
    approve(tool: string, args: unknown, signal: AbortSignal): Promise<boolean>;
    /** Aborting stops the turn on the gateway (POST …/stop); the result is then "stopped". */
    signal?: AbortSignal | undefined;
    /** Every line of the turn stream as it arrives. */
    onLine?: ((line: Line) => void) | undefined;
}

export interface TurnResult {
    status: "done" | "error" | "stopped";
    answer: string;
    error?: string | undefined;
    turnSeq: number | null;
    tools: ToolCall[];
    footer: TurnFooter;
}

interface GateCard {
    actions: { id: string; label: string; detail: unknown }[];
}

interface GateRow {
    gate: string;
    agent: string;
    conversation?: number;
    room?: string;
}

interface CallRow {
    turnSeq: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    cost: number;
    durationMs: number | null;
    firstOutputMs: number | null;
    tokensPerSec: number | null;
    usageEstimated: boolean;
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)} s`;

/** Whole numbers with thousands separators; dollars down to a millionth. */
export const num = (n: number): string => n.toLocaleString("en-US");
export const usd = (n: number): string => `$${n >= 1 ? n.toFixed(2) : n.toFixed(6).replace(/\.?0+$/, "")}`;

/** One line, at most `max` characters. */
export const clip = (s: string, max = 120): string => {
    const line = s.replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max - 3)}...` : line;
};

export function formatFooter(f: TurnFooter): string {
    return [
        `${f.calls} ${f.calls === 1 ? "call" : "calls"}`,
        `${num(f.promptTokens)} in / ${num(f.completionTokens)} out${f.estimated ? " est" : ""}`,
        f.cost > 0 ? usd(f.cost) : null,
        secs(f.durationMs),
        f.firstOutputMs === null ? null : `first output ${secs(f.firstOutputMs)}`,
        f.tokensPerSec === null ? null : `${Math.round(f.tokensPerSec)} tok/s`,
    ]
        .filter((part) => part !== null)
        .join(", ");
}

/** A new chat with a title of its own, so no auto-title call spends tokens. */
export async function newConversation(api: Api, agent: string, title: string): Promise<number> {
    const { id } = await api.post<{ id: number }>(`/api/agents/${agent}/conversations`);
    await api.patch(`/api/agents/${agent}/conversations/${id}`, { title });
    return id;
}

export async function runTurn(api: Api, agent: string, session: number, text: string, opts: TurnOptions): Promise<TurnResult> {
    return drive(api, agent, session, opts, () => api.stream("POST", `/api/agents/${agent}/conversations/${session}/messages`, { text }));
}

/** Attaches to the chat's running turn (its events so far are replayed); null when the chat is not generating. */
export async function reattach(api: Api, agent: string, session: number, opts: TurnOptions): Promise<TurnResult | null> {
    try {
        return await drive(api, agent, session, opts, () => api.stream("GET", `/api/agents/${agent}/conversations/${session}/stream`));
    } catch (e) {
        // the gateway's 409: the turn ended between the chat list and this attach
        if (e instanceof DevError && e.message === "this chat is not generating") return null;
        throw e;
    }
}

async function drive(
    api: Api,
    agent: string,
    session: number,
    opts: TurnOptions,
    open: () => ReturnType<Api["stream"]>,
): Promise<TurnResult> {
    const started = performance.now();
    const say = (line: string): void => {
        if (opts.render) out(line);
    };

    // ---- rendering: streamed text stays on one line until anything else needs a line of its own
    let inText = false;
    let thinkingSince: number | null = null;
    const breakLine = (): void => {
        if (!opts.render) return;
        if (inText) process.stdout.write("\n");
        inText = false;
        if (thinkingSince !== null) out(paint.dim(`  thought for ${secs(performance.now() - thinkingSince)}`));
        thinkingSince = null;
    };

    // ---- gates: each asked once, one question at a time, whichever stream named it first
    const gates = new Map<string, AbortController>();
    let asking = Promise.resolve();
    const handleGate = (gate: string): void => {
        if (gates.has(gate)) return;
        const closed = new AbortController();
        gates.set(gate, closed);
        asking = asking.then(async () => {
            if (closed.signal.aborted) return;
            // the per-gate route is the only one with the arguments; 404 = already answered or gone
            const card = await api.request<GateCard>("GET", `/api/approvals/${gate}`);
            if (card.status !== 200 || closed.signal.aborted) return;
            const decisions: Record<string, boolean> = {};
            for (const action of card.json.actions) {
                breakLine();
                decisions[action.id] = await opts.approve(action.label, action.detail, closed.signal);
                if (closed.signal.aborted) return;
            }
            await api.request("POST", `/api/approvals/${gate}/answer`, { decisions });
        }).catch(() => undefined);
    };

    const events = await api.stream("GET", "/api/events");
    const sweep = async (): Promise<void> => {
        const { approvals } = await api.get<{ approvals: GateRow[] }>("/api/approvals");
        for (const g of approvals) {
            if (g.agent === agent && g.room === undefined && (g.conversation === undefined || g.conversation === session)) handleGate(g.gate);
        }
    };
    const watching = (async () => {
        for await (const ev of events) {
            // the hub names no gate id, so a park of this agent's re-reads the open gates
            if (ev["type"] === "ready" || (ev["type"] === "approval" && ev["agent"] === agent)) await sweep();
            if (ev["type"] === "approval_resolved") gates.get(String(ev["gate"]))?.abort();
        }
    })().catch(() => undefined);

    let stopRequested = false;
    const stop = (): void => {
        stopRequested = true;
        void api.request("POST", `/api/agents/${agent}/conversations/${session}/stop`).catch(() => undefined);
    };
    if (opts.signal?.aborted) stop();
    opts.signal?.addEventListener("abort", stop, { once: true });

    let status: TurnResult["status"] = "error";
    let answer = "";
    let streamed = "";
    let error: string | undefined = "the turn stream ended without an answer";
    let turnSeq: number | null = null;
    const tools: ToolCall[] = [];
    const byId = new Map<string, ToolCall>();
    try {
        const stream = await open();
        for await (const line of stream) {
            opts.onLine?.(line);
            switch (line["type"]) {
                case "turn_started":
                    turnSeq = typeof line["turnSeq"] === "number" ? line["turnSeq"] : null;
                    break;
                case "thinking":
                    thinkingSince ??= performance.now();
                    break;
                case "text": {
                    const chunk = String(line["text"] ?? "");
                    if (!inText) {
                        breakLine();
                        if (opts.render) process.stdout.write(`${paint.bold(`${agent} >`)} `);
                        inText = opts.render;
                    }
                    if (opts.render) process.stdout.write(chunk);
                    streamed += chunk;
                    break;
                }
                case "tool_call": {
                    const call: ToolCall = { name: String(line["name"]), args: line["args"] };
                    tools.push(call);
                    byId.set(String(line["id"]), call);
                    breakLine();
                    say(`  ${paint.dim("tool")}     ${call.name} ${clip(JSON.stringify(call.args ?? {}))}`);
                    break;
                }
                case "tool_result": {
                    const called = byId.get(String(line["id"]));
                    if (called) called.result = String(line["text"] ?? "");
                    breakLine();
                    say(`  ${paint.dim("result")}   ${String(line["name"])}: ${clip(String(line["text"] ?? ""))}`);
                    break;
                }
                case "approval_required":
                    handleGate(String(line["gate"]));
                    break;
                case "approval_resolved":
                    gates.get(String(line["gate"]))?.abort();
                    break;
                case "restart":
                    breakLine();
                    say(paint.yellow(`  fell back to ${String(line["model"])}; the text above is discarded`));
                    streamed = "";
                    break;
                case "compacted":
                    breakLine();
                    say(paint.dim("  compacted the older history"));
                    break;
                case "log":
                    breakLine();
                    say(paint.dim(`  ${String(line["text"] ?? "")}`));
                    break;
                case "done":
                    answer = String(line["answer"] ?? "");
                    status = stopRequested ? "stopped" : "done";
                    error = undefined;
                    breakLine();
                    if (!streamed.trim() && answer && !stopRequested) say(`${paint.bold(`${agent} >`)} ${answer}`);
                    break;
                case "error":
                    error = String(line["message"] ?? "the turn failed");
                    breakLine();
                    break;
            }
        }
    } catch (e) {
        if (e instanceof DevError) throw e;
        throw new DevError(`the devkit gateway dropped the turn (${(e as Error).message}); run mimi-dev check`, 3);
    } finally {
        opts.signal?.removeEventListener("abort", stop);
        events.close();
        for (const closed of gates.values()) closed.abort();
        await Promise.all([asking, watching]);
        breakLine();
    }
    if (status === "stopped") say(paint.yellow("  stopped"));
    if (status === "error") say(paint.red(`  error    ${error}`));

    const rows = turnSeq === null ? [] : (await api.get<CallRow[]>(`/api/agents/${agent}/calls?conversation=${session}&limit=500`)).filter((r) => r.turnSeq === turnSeq);
    // the gateway's own rate: completion tokens over the whole call, summed over the calls it measured
    const measured = rows.filter((r) => r.tokensPerSec !== null && r.completionTokens !== null && r.durationMs !== null);
    const measuredMs = measured.reduce((n, r) => n + (r.durationMs ?? 0), 0);
    const footer: TurnFooter = {
        calls: rows.length,
        promptTokens: rows.reduce((n, r) => n + (r.promptTokens ?? 0), 0),
        completionTokens: rows.reduce((n, r) => n + (r.completionTokens ?? 0), 0),
        cost: rows.reduce((n, r) => n + r.cost, 0),
        durationMs: Math.round(performance.now() - started),
        // the rows come newest first: the turn's first call is the last one
        firstOutputMs: rows.at(-1)?.firstOutputMs ?? null,
        tokensPerSec: measuredMs > 0 ? measured.reduce((n, r) => n + (r.completionTokens ?? 0), 0) / (measuredMs / 1000) : null,
        estimated: rows.some((r) => r.usageEstimated),
    };
    say(paint.dim(`  ${formatFooter(footer)}`));
    return { status, answer, error, turnSeq, tools, footer };
}
