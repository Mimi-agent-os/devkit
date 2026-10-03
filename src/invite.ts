/** `mimi-dev invite`: the agent's .env lines from `mimi invite`, its data folder under .mimi-dev, and the devkit model as its only one. */
import { parseArgs } from "node:util";

import { loadAgentEnv, setAgentEnv } from "@mimi-os/sdk";

import { assignModel, connect } from "./api.ts";
import { runMimi } from "./gateway.ts";
import { AGENT_DATA, agentName, devPaths, DIR_OPTION, readState } from "./state.ts";
import { DevError, out, row } from "./term.ts";

export async function run(argv: string[]): Promise<number> {
    const { values } = parseArgs({ args: argv, options: { ...DIR_OPTION, write: { type: "boolean" } }, strict: true });
    const p = devPaths(values.dir);
    const agent = agentName(p);
    const model = readState(p)?.model ?? null;
    if (model === null) throw new DevError("the devkit gateway has no model yet; run mimi-dev up first", 2);

    // an agent reads MIMI_DATA_DIR at boot, so one already running without it needs a restart
    const newDataDir = loadAgentEnv(p.dir)["MIMI_DATA_DIR"] !== AGENT_DATA;
    const api = await connect(p);
    try {
        const minted = await runMimi(p, ["invite", agent, ...(values.write ? ["--write", p.agentEnv] : [])]);
        if (minted.code !== 0) throw new DevError(`mimi invite failed: ${minted.stderr.trim()}`, 3);
        if (values.write) {
            setAgentEnv(p.dir, "MIMI_DATA_DIR", AGENT_DATA, { encrypt: false });
            out(`wrote MIMI_INVITE and MIMI_GATEWAY_URL to ${p.agentEnv}`);
            out(`wrote MIMI_DATA_DIR=${AGENT_DATA} to ${p.agentEnv}`);
        } else {
            for (const line of minted.stdout.trim().split("\n").filter((l) => !l.startsWith("#"))) out(line);
            out(`MIMI_DATA_DIR=${AGENT_DATA}`);
            out(`# put these in ${p.agentEnv}, or rerun with mimi-dev invite --write; the invite works once, within 24 hours`);
        }
        // the open invite carries the policy to the pin its redemption creates
        if (!(await assignModel(api, agent, model))) throw new DevError(`the devkit gateway lost the invite of ${agent}; run mimi-dev invite again`, 3);
        row("model", `${agent} runs on ${model}`);
        row("next", newDataDir ? "start the agent, or restart it if it is running" : "start the agent; a running one picks the invite up within 30 s");
    } finally {
        api.close();
    }
    return 0;
}
