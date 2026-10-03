/** The real gateway CLI (`mimi`) from the linked workspace gateway, run against devkit's own MIMI_HOME. */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import type { DevPaths } from "./state.ts";
import { DevError } from "./term.ts";

/** 46464 is the owner's real gateway: devkit never takes it. */
const PORTS = { first: 46465, last: 46564 };

export interface MimiResult {
    code: number;
    stdout: string;
    stderr: string;
}

export function runMimi(p: DevPaths, args: string[]): Promise<MimiResult> {
    const cli = fileURLToPath(import.meta.resolve("mimi-gateway/cli"));
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], {
        env: { ...process.env, MIMI_HOME: p.gatewayHome },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (s: string) => (stdout += s));
    child.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
    return new Promise((done, fail) => {
        child.once("error", fail);
        child.once("close", (code) => done({ code: code ?? 1, stdout, stderr }));
    });
}

export async function pickPort(): Promise<number> {
    for (let port = PORTS.first; port <= PORTS.last; port++) {
        const free = await new Promise<boolean>((done) => {
            const server = createServer();
            server.once("error", () => done(false));
            server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
        });
        if (free) return port;
    }
    throw new DevError(`no free port in ${PORTS.first}-${PORTS.last}; pass --port <n>`, 3);
}
