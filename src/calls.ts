/** `mimi-dev calls`: the gateway's model calls for the agent as a compact table, or one call's raw record. */
import { parseArgs } from "node:util";

import { connect, type Api } from "./api.ts";
import { agentName, devPaths, DIR_OPTION } from "./state.ts";
import { clip, num, usd } from "./turn.ts";
import { DevError, out, paint } from "./term.ts";

interface CallRow {
    id: number;
    conversationId: number | null;
    room: string | null;
    callKind: string | null;
    model: string | null;
    registryModel: string | null;
    finishReason: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    reasoningTokens: number | null;
    usageEstimated: boolean;
    cost: number;
    durationMs: number | null;
    firstOutputMs: number | null;
    tokensPerSec: number | null;
    /** UTC "YYYY-MM-DD HH:MM:SS"; the table shows it in local time. */
    createdAt: string;
}

/** Oldest first, so the newest call sits next to the prompt; `json` prints the route's rows as they came. */
export async function printCalls(api: Api, agent: string, query: { limit: number; conversation?: number | undefined; json?: boolean | undefined }): Promise<void> {
    const params = new URLSearchParams({ limit: `${query.limit}` });
    if (query.conversation !== undefined) params.set("conversation", `${query.conversation}`);
    const newestFirst = await api.get<CallRow[]>(`/api/agents/${agent}/calls?${params}`);
    if (query.json) {
        out(JSON.stringify(newestFirst, null, 2));
        return;
    }
    const rows = newestFirst.reverse();
    if (rows.length === 0) {
        out(query.conversation === undefined ? `no model calls by ${agent} yet` : `no model calls in chat ${query.conversation} yet`);
        return;
    }
    const priced = rows.some((r) => r.cost > 0);
    const dash = (n: number | null, show: (n: number) => string): string => (n === null ? "-" : show(n));
    const s = (ms: number): string => (ms / 1000).toFixed(2);
    const table = [
        ["id", "time", "chat", "kind", "model", "in", "out", "reasoning", ...(priced ? ["cost"] : []), "secs", "first", "tok/s", "finish"],
        ...rows.map((r) => [
            `${r.id}`,
            new Date(`${r.createdAt.replace(" ", "T")}Z`).toTimeString().slice(0, 8),
            r.conversationId === null ? (r.room ?? "-") : `${r.conversationId}`,
            r.callKind ?? "-",
            clip(r.registryModel ?? r.model ?? "-", 24),
            `${r.usageEstimated ? "~" : ""}${dash(r.promptTokens, num)}`,
            `${r.usageEstimated ? "~" : ""}${dash(r.completionTokens, num)}`,
            dash(r.reasoningTokens, num),
            ...(priced ? [r.cost > 0 ? usd(r.cost) : "-"] : []),
            dash(r.durationMs, s),
            dash(r.firstOutputMs, s),
            // a call over in a few milliseconds gives a meaningless rate
            (r.durationMs ?? 0) < 100 ? "-" : dash(r.tokensPerSec, (n) => `${Math.round(n)}`),
            r.finishReason ?? "-",
        ]),
    ];
    const widths = table[0]!.map((_, col) => Math.max(...table.map((row) => row[col]!.length)));
    // ids and text align left, the counts right
    const left = new Set(["id", "time", "chat", "kind", "model", "finish"]);
    for (const [i, row] of table.entries()) {
        const line = row.map((cell, col) => (left.has(table[0]![col]!) ? cell.padEnd(widths[col]!) : cell.padStart(widths[col]!))).join("  ");
        out(i === 0 ? paint.dim(line.trimEnd()) : line.trimEnd());
    }
    if (rows.some((r) => r.usageEstimated)) out(paint.dim("~ the gateway estimated this usage; the provider reported none"));
}

export async function run(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: { ...DIR_OPTION, limit: { type: "string" }, conversation: { type: "string" }, json: { type: "boolean" } },
    });
    // an agent name starts with a letter, so a number is a call id
    const id = positionals.find((a) => /^\d+$/.test(a));
    const names = positionals.filter((a) => a !== id);
    if (names.length > 1) throw new DevError("usage: mimi-dev calls [agent] [<id>] [--limit <n>] [--conversation <id>] [--json]", 2);
    const limit = Number(values.limit ?? 30);
    const conversation = values.conversation === undefined ? undefined : Number(values.conversation);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new DevError("--limit takes a positive whole number", 2);
    if (conversation !== undefined && (!Number.isSafeInteger(conversation) || conversation < 1)) throw new DevError("--conversation takes a chat id", 2);

    const p = devPaths(values.dir);
    const agent = names[0] ?? agentName(p);
    const api = await connect(p);
    try {
        if (id !== undefined) {
            const record = await api.request<unknown>("GET", `/api/agents/${agent}/calls/${id}`);
            if (record.status === 404) throw new DevError(`${agent} has no call ${id} with a record (${(record.json as { error?: string }).error ?? "not found"})`, 2);
            if (record.status !== 200) throw new DevError(`the gateway answered ${record.status} to the call record`, 3);
            out(JSON.stringify(record.json, null, 2));
        } else {
            await printCalls(api, agent, { limit, conversation, json: values.json });
        }
    } finally {
        api.close();
    }
    return 0;
}
