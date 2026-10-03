/** devkit is a device of its gateway: `/api` is reached only as tunnel requests over the secure channel. */
import { setTimeout as sleep } from "node:timers/promises";

import { dialChannel, pairDevice, type ApiReply, type NdjsonStream } from "mimi-gateway/device-client";

import { runMimi } from "./gateway.ts";
import { readDeviceKey, readState, writeDeviceKey, type DevPaths } from "./state.ts";
import { DevError } from "./term.ts";

const READY_MS = 5000;

export interface Api {
    /** The reply as it came, whatever its status. */
    request<T>(method: string, path: string, body?: unknown): Promise<ApiReply<T>>;
    /** The rest throw DevError on a non-2xx reply: 2 for a 400 (the gateway's reason), else 3. */
    get<T>(path: string): Promise<T>;
    post<T>(path: string, body?: unknown): Promise<T>;
    patch<T>(path: string, body: unknown): Promise<T>;
    del<T>(path: string): Promise<T>;
    stream(method: string, path: string, body?: unknown): Promise<NdjsonStream>;
    close(): void;
}

const refused = (method: string, path: string, status: number, error: unknown): DevError =>
    new DevError(typeof error === "string" ? error : `the gateway answered ${status} to ${method} ${path}`, status === 400 ? 2 : 3);

const closed = (e: unknown): DevError =>
    new DevError(`the devkit gateway dropped the channel (${(e as Error).message}); run mimi-dev up`, 3);

export async function connect(p: DevPaths): Promise<Api> {
    const state = readState(p);
    const key = readDeviceKey(p);
    if (state === null || key === null) throw new DevError("no devkit gateway in this folder; run mimi-dev up", 3);
    const conn = dialChannel(`ws://127.0.0.1:${state.port}/channel`, key.s, key.gatewayPub);
    let why = "";
    const ready = await Promise.race([conn.ready, sleep(READY_MS, null, { ref: false })]).catch((e: unknown) => {
        why = (e as Error).message;
        return null;
    });
    if (ready === null || ready.activation === "pending") {
        conn.close();
        // "channel: <code>" is the gateway refusing this key; anything else is nobody answering
        throw why.startsWith("channel:") || ready !== null
            ? new DevError(`the devkit gateway refused devkit's device (${why || "not active"}); mimi-dev down --reset starts over`, 3)
            : new DevError(`the devkit gateway is not running at 127.0.0.1:${state.port}; run mimi-dev up`, 3);
    }

    const request = <T>(method: string, path: string, body?: unknown): Promise<ApiReply<T>> =>
        conn.api<T>(method, path, body).catch((e: unknown) => {
            throw closed(e);
        });
    const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        const reply = await request<T>(method, path, body);
        if (reply.status >= 300) throw refused(method, path, reply.status, (reply.json as { error?: unknown } | null)?.error);
        return reply.json;
    };
    return {
        request,
        get: (path) => call("GET", path),
        post: (path, body) => call("POST", path, body),
        patch: (path, body) => call("PATCH", path, body),
        del: (path) => call("DELETE", path),
        stream: async (method, path, body) => {
            const s = await conn.stream(method, path, body).catch((e: unknown) => {
                throw closed(e);
            });
            if (s.status < 300) return s;
            await s.done.catch(() => undefined);
            throw refused(method, path, s.status, s.lines[0]?.["error"]);
        },
        close: () => conn.close(),
    };
}

/** Pairs devkit once, through the local invite `mimi pair` mints; a local invite enrolls the device active at once. */
export async function pair(p: DevPaths, port: number): Promise<void> {
    const minted = await runMimi(p, ["pair", "--address", `http://127.0.0.1:${port}`]);
    const link = minted.stdout.split("\n")[0] ?? "";
    if (minted.code !== 0 || !link.startsWith("mimi://")) {
        throw new DevError(`mimi pair failed: ${minted.stderr.trim() || minted.stdout.trim()}`, 3);
    }
    const s = crypto.getRandomValues(new Uint8Array(32));
    const { gatewayPub } = await pairDevice(`ws://127.0.0.1:${port}`, link, s, "mimi-dev").catch((e: unknown) => {
        throw new DevError(`pairing devkit with its gateway failed: ${(e as Error).message}`, 3);
    });
    writeDeviceKey(p, { s, gatewayPub });
}

/** The agent runs on `model` alone. Works before its first connection, through its open invite; false when the gateway knows no such agent. */
export async function assignModel(api: Api, agent: string, model: string): Promise<boolean> {
    const path = `/api/agents/${agent}/models`;
    const reply = await api.request<{ error?: unknown }>("PATCH", path, { primary: model, fallback: null, allowed: [model] });
    if (reply.status === 404) return false;
    if (reply.status >= 300) throw refused("PATCH", path, reply.status, reply.json?.error);
    return true;
}

export async function requireAgent(api: Api, agent: string): Promise<void> {
    const agents = await api.get<{ name: string; connected: boolean }[]>("/api/agents");
    if (!agents.some((a) => a.name === agent && a.connected)) {
        throw new DevError(`${agent} is not connected; run mimi-dev check`, 3);
    }
}
