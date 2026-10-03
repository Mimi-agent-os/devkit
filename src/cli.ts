#!/usr/bin/env node
/** `mimi-dev`: one command per step; each parses its own flags and returns its exit code. */
import { run as calls } from "./calls.ts";
import { run as chat } from "./chat.ts";
import { run as check } from "./check.ts";
import { run as down } from "./down.ts";
import { run as invite } from "./invite.ts";
import { DevError } from "./term.ts";
import { run as test } from "./test.ts";
import { run as up } from "./up.ts";

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = { up, invite, check, chat, calls, test, down };

const USAGE = `usage: mimi-dev <command> [flags] [--dir <agent folder>]

  up       start the devkit gateway and register its model
           --provider vllm|llamacpp|openrouter --url <endpoint> --model <id> --ctx <tokens>
           [--param key=<json>]... [--price-in <usd/1M>] [--price-out <usd/1M>]
           [--limit <n>usd|<n>tokens|off] [--port <n>]
  invite   the agent's .env lines for this gateway [--write]
  check    what the gateway made of the connected agent [agent] [--prompt] [--json]
  chat     talk to the agent [agent] [--resume [<id>]] [-m <text>] [--yes] [--json]
  calls    the model calls [agent] [<id>] [--limit <n>] [--conversation <id>] [--json]
  test     run scenarios/*.json [<file|folder>...] [--runs <n>] [--min-pass <0..1>] [--json]
  down     stop the devkit gateway [--reset]

exit codes: 0 passed, 1 failed, 2 usage, 3 environment`;

const [name, ...argv] = process.argv.slice(2);
const command = name === undefined ? undefined : COMMANDS[name];
if (name === "help" || name === "--help" || name === "-h") {
    process.stdout.write(`${USAGE}\n`);
} else if (command === undefined) {
    process.stderr.write(`${name === undefined ? "" : `unknown command "${name}"\n`}${USAGE}\n`);
    process.exitCode = 2;
} else {
    try {
        process.exitCode = await command(argv);
    } catch (e) {
        const usage = (e as { code?: unknown }).code?.toString().startsWith("ERR_PARSE_ARGS") === true;
        process.stderr.write(`mimi-dev ${name}: ${(e as Error).message}\n`);
        process.exitCode = e instanceof DevError ? e.code : usage ? 2 : 3;
    }
}
