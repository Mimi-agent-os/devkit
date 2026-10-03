/** `mimi-dev chat`: a terminal chat with the connected agent over the desktop's own routes. */
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { connect, requireAgent } from "./api.ts";
import { printCalls } from "./calls.ts";
import { agentName, devPaths, DIR_OPTION } from "./state.ts";
import { DevError, out, paint } from "./term.ts";
import { clip, newConversation, reattach, runTurn, type TurnOptions } from "./turn.ts";

const USAGE = "usage: mimi-dev chat [agent] [--resume [<id>]] [-m <text>] [--yes] [--json]";
const HELP = "/new /resume <id> /calls /tools /quit, Ctrl-C stops a turn";

interface Described {
    model: { runsOn: string | null; reason?: string };
    tools: { name: string; description?: string; parameters?: { properties?: Record<string, unknown> }; writes: boolean }[];
}

interface ChatRow {
    id: number;
    title: string | null;
    updatedAt: string;
    busy: boolean;
    activeTurnSeq?: number;
}

interface HistoryItem {
    id: number;
    role: string;
    content: string;
    summary?: true;
    toolCalls?: { id: string; name: string; arguments: string }[];
    toolCallId?: string;
}

export async function run(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
            ...DIR_OPTION,
            resume: { type: "boolean" },
            message: { type: "string", short: "m" },
            yes: { type: "boolean" },
            json: { type: "boolean" },
        },
    });
    // an agent name starts with a letter, so a number is a chat id
    const id = positionals.find((a) => /^\d+$/.test(a));
    const names = positionals.filter((a) => a !== id);
    if (names.length > 1 || (id !== undefined && !values.resume)) throw new DevError(USAGE, 2);
    if (values.json && values.message === undefined) throw new DevError("--json needs -m <text>", 2);

    const p = devPaths(values.dir);
    const agent = names[0] ?? agentName(p);
    // stdout carries only the turn's ndjson under --json
    const note = (line: string): void => void (values.json ? process.stderr.write(`${line}\n`) : out(line));
    const you = paint.bold("you >");
    const them = paint.bold(`${agent} >`);
    const api = await connect(p);

    // the interactive chat reads approvals from stdin like its messages; a one-shot -m asks only on a terminal
    const tty = process.stdin.isTTY === true;
    const rl = values.message === undefined || tty ? createInterface({ input: process.stdin, output: process.stdout, terminal: tty }) : null;
    const lines = rl?.[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<string>> | null = null;
    // a prompt left open on its line; whatever prints next starts on a line of its own
    let open = false;
    /** The next line, or null at the end of input or once `signal` aborts. */
    const readLine = async (prompt: string, signal?: AbortSignal): Promise<string | null> => {
        if (!rl || !lines) return null;
        // a script's stdin may already be at its end while its lines still wait in the iterator
        if (tty) {
            rl.setPrompt(prompt);
            rl.prompt();
        } else {
            process.stdout.write(prompt);
        }
        open = true;
        pending ??= lines.next();
        const closed = new Promise<null>((done) => signal?.addEventListener("abort", () => done(null), { once: true }));
        const got = await Promise.race([pending, closed]);
        const stillOpen = open;
        open = false;
        if (got === null || got.done) {
            if (stillOpen) process.stdout.write("\n");
            return null;
        }
        pending = null;
        // a terminal echoes what was typed; a script's lines are echoed so the transcript reads the same
        if (!tty) process.stdout.write(`${got.value}\n`);
        return got.value;
    };

    let turn: AbortController | null = null;
    const interrupt = (): void => {
        if (turn && open) process.stdout.write("\n");
        open = false;
        if (turn) turn.abort();
        else if (rl) rl.close();
        else process.exit(130);
    };
    rl?.on("SIGINT", interrupt);
    process.on("SIGINT", interrupt);

    const always = new Set<string>();
    const approve: TurnOptions["approve"] = async (tool, args, signal) => {
        const ask = `  ${paint.yellow("approve")}  ${tool} ${clip(JSON.stringify(args ?? {}))}?`;
        if (values.yes || always.has(tool)) {
            note(`${ask} yes${values.yes ? " (--yes)" : ", always in this chat"}`);
            return true;
        }
        if (!rl) {
            note(`${ask} no: no terminal to ask on; --yes approves`);
            return false;
        }
        const answer = (await readLine(`${ask} [y]es [n]o [a]lways in this chat > `, signal))?.trim().toLowerCase();
        if (signal.aborted) {
            note(paint.dim("  the gate closed before an answer"));
            return false;
        }
        if (answer === "a" || answer === "always") always.add(tool);
        return answer === "y" || answer === "yes" || answer === "a" || answer === "always";
    };
    const turnOptions = (signal: AbortSignal): TurnOptions => ({
        render: !values.json,
        approve,
        signal,
        onLine: values.json ? (line) => out(JSON.stringify(line)) : undefined,
    });

    /** Prints the chat's last messages and attaches to its turn when one still runs. */
    const openChat = async (want: number | null): Promise<number> => {
        const chats = await api.get<ChatRow[]>(`/api/agents/${agent}/conversations`);
        const chat = want === null ? chats.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id)[0] : chats.find((c) => c.id === want);
        if (!chat) throw new DevError(want === null ? `${agent} has no chats yet` : `${agent} has no chat ${want}`, 2);
        const { items } = await api.get<{ items: HistoryItem[] }>(`/api/agents/${agent}/conversations/${chat.id}/messages?limit=20`);
        // a running turn replays everything after its own user message, so the history stops there
        const shown = items.filter((m) => chat.activeTurnSeq === undefined || m.id <= chat.activeTurnSeq);
        note(`chat ${chat.id}${chat.title ? ` "${chat.title}"` : ""}, its last ${shown.length} ${shown.length === 1 ? "message" : "messages"}`);
        const toolNames = new Map<string, string>();
        for (const m of shown) {
            if (m.role === "user") note(`${you} ${m.content}`);
            if (m.role === "assistant" && m.summary) note(paint.dim(`  summary  ${clip(m.content)}`));
            else if (m.role === "assistant" && m.content.trim()) note(`${them} ${m.content}`);
            for (const call of m.toolCalls ?? []) {
                toolNames.set(call.id, call.name);
                note(`  ${paint.dim("tool")}     ${call.name} ${clip(call.arguments)}`);
            }
            if (m.role === "tool") note(`  ${paint.dim("result")}   ${toolNames.get(m.toolCallId ?? "") ?? "tool"}: ${clip(m.content)}`);
        }
        if (chat.busy) {
            note(paint.dim("  its turn is still running"));
            turn = new AbortController();
            await reattach(api, agent, chat.id, turnOptions(turn.signal)).finally(() => (turn = null));
        }
        always.clear();
        return chat.id;
    };
    const title = (): string => `mimi-dev ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

    try {
        await requireAgent(api, agent);
        const { model } = await api.get<Described>(`/api/agents/${agent}/describe`);
        if (values.message === undefined) out(`${agent} on ${model.runsOn ?? `no model (${model.reason ?? "none granted"})`}. ${HELP}`);
        let session = values.resume ? await openChat(id === undefined ? null : Number(id)) : await newConversation(api, agent, title());

        if (values.message !== undefined) {
            turn = new AbortController();
            const result = await runTurn(api, agent, session, values.message, turnOptions(turn.signal));
            if (values.json) out(JSON.stringify({ type: "footer", ...result.footer }));
            return result.status === "done" ? 0 : 1;
        }

        if (!values.resume) out(`chat ${session}`);
        for (;;) {
            const line = await readLine(`${you} `);
            if (line === null) break;
            const text = line.trim();
            if (!text) continue;
            if (!text.startsWith("/")) {
                turn = new AbortController();
                await runTurn(api, agent, session, text, turnOptions(turn.signal)).finally(() => (turn = null));
                continue;
            }
            const [command, arg] = text.split(/\s+/);
            if (command === "/quit") break;
            try {
                if (command === "/new") {
                    session = await newConversation(api, agent, title());
                    always.clear();
                    out(`chat ${session}`);
                } else if (command === "/resume") {
                    session = await openChat(arg === undefined ? null : Number(arg));
                } else if (command === "/calls") {
                    await printCalls(api, agent, { limit: 20, conversation: session });
                } else if (command === "/tools") {
                    const { tools } = await api.get<Described>(`/api/agents/${agent}/describe`);
                    const width = Math.max(...tools.map((t) => t.name.length));
                    for (const t of tools) {
                        const params = Object.keys(t.parameters?.properties ?? {}).join(", ");
                        out(`  ${t.name.padEnd(width)}  (${params})${t.writes ? paint.yellow(" asks approval") : ""}  ${paint.dim(clip(t.description ?? "", 80))}`);
                    }
                } else {
                    out(`unknown command ${command}; ${HELP}`);
                }
            } catch (e) {
                // a bad /resume id is not worth leaving the chat for
                if (!(e instanceof DevError) || e.code !== 2) throw e;
                out(paint.red(e.message));
            }
        }
        return 0;
    } finally {
        process.off("SIGINT", interrupt);
        rl?.close();
        api.close();
    }
}
