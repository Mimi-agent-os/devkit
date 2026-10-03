/** `mimi-dev down`: stops the devkit gateway; `--reset` deletes .mimi-dev. The agent is never touched. */
import { existsSync, rmSync } from "node:fs";
import { parseArgs } from "node:util";

import { runMimi } from "./gateway.ts";
import { devPaths, DIR_OPTION } from "./state.ts";
import { DevError, out } from "./term.ts";

export async function run(argv: string[]): Promise<number> {
    const { values } = parseArgs({ args: argv, options: { ...DIR_OPTION, reset: { type: "boolean" } }, strict: true });
    const p = devPaths(values.dir);
    // with no home, `mimi stop` would look at the default port, which is the owner's real gateway
    if (existsSync(p.gatewayHome)) {
        const stopped = await runMimi(p, ["stop"]);
        if (stopped.code !== 0) throw new DevError(`mimi stop failed: ${stopped.stderr.trim()}`, 3);
        out(stopped.stdout.startsWith("stopped") ? "stopped the devkit gateway" : "the devkit gateway was not running");
    } else {
        out("no devkit gateway in this folder");
    }
    if (!values.reset) {
        if (existsSync(p.root)) out("state kept in .mimi-dev; your agent keeps retrying until the next mimi-dev up");
        return 0;
    }
    rmSync(p.root, { recursive: true, force: true });
    out(`removed ${p.root}`);
    out("stop your agent, then mimi-dev up, mimi-dev invite --write, and start it again");
    return 0;
}
