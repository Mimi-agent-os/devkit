/** `.mimi-dev/` in the agent folder: the devkit gateway's home, devkit's device key, the agent's data folder. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { readManifest } from "@mimi-os/sdk";

import { DevError } from "./term.ts";

/** The agent's MIMI_DATA_DIR, relative to its folder, as `invite` writes it into the agent's .env. */
export const AGENT_DATA = ".mimi-dev/agent-data";

export const DIR_OPTION = { dir: { type: "string" } } as const;

export interface DevPaths {
    /** The agent folder: agent.json, .env, .mimi-dev/. */
    dir: string;
    root: string;
    state: string;
    deviceKey: string;
    /** MIMI_HOME of the devkit gateway. */
    gatewayHome: string;
    agentData: string;
    agentEnv: string;
}

export function devPaths(dir: string = process.cwd()): DevPaths {
    const abs = resolve(dir);
    const root = join(abs, ".mimi-dev");
    return {
        dir: abs,
        root,
        state: join(root, "state.json"),
        deviceKey: join(root, "device.key"),
        gatewayHome: join(root, "gateway"),
        agentData: join(abs, AGENT_DATA),
        agentEnv: join(abs, ".env"),
    };
}

export interface DevState {
    port: number;
    model: string | null;
}

export interface DeviceKey {
    s: Uint8Array;
    gatewayPub: Uint8Array;
}

// 0700 with a .gitignore of "*": the folder holds a provider key and an active device key
function ensureRoot(p: DevPaths): void {
    mkdirSync(p.root, { recursive: true, mode: 0o700 });
    const ignore = join(p.root, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
}

function readJson(file: string): Record<string, unknown> | null {
    if (!existsSync(file)) return null;
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
        // reported below as a broken file
    }
    throw new DevError(`${file} is broken; mimi-dev down --reset starts over`, 3);
}

export function readState(p: DevPaths): DevState | null {
    const json = readJson(p.state);
    if (json === null) return null;
    const { port, model } = json;
    if (typeof port !== "number" || !Number.isInteger(port) || (model !== null && typeof model !== "string")) {
        throw new DevError(`${p.state} is broken; mimi-dev down --reset starts over`, 3);
    }
    return { port, model };
}

export function writeState(p: DevPaths, s: DevState): void {
    ensureRoot(p);
    writeFileSync(p.state, `${JSON.stringify(s, null, 2)}\n`);
}

export function readDeviceKey(p: DevPaths): DeviceKey | null {
    const json = readJson(p.deviceKey);
    if (json === null) return null;
    const { s, gatewayPub } = json;
    if (typeof s !== "string" || typeof gatewayPub !== "string") {
        throw new DevError(`${p.deviceKey} is broken; mimi-dev down --reset starts over`, 3);
    }
    return { s: Buffer.from(s, "base64"), gatewayPub: Buffer.from(gatewayPub, "base64") };
}

export function writeDeviceKey(p: DevPaths, k: DeviceKey): void {
    ensureRoot(p);
    const json = { s: Buffer.from(k.s).toString("base64"), gatewayPub: Buffer.from(k.gatewayPub).toString("base64") };
    writeFileSync(p.deviceKey, `${JSON.stringify(json)}\n`, { mode: 0o600 });
}

/** The agent's name from its agent.json, through the SDK's own reader. */
export function agentName(p: DevPaths): string {
    try {
        return readManifest(p.dir).name;
    } catch (e) {
        throw new DevError(`${(e as Error).message} Run mimi-dev in the agent's folder, or pass --dir.`, 2);
    }
}
