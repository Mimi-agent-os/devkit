# @mimi-os/devkit

[![CI](https://github.com/Mimi-agent-os/devkit/actions/workflows/ci.yml/badge.svg)](https://github.com/Mimi-agent-os/devkit/actions/workflows/ci.yml)

mimi-os runs your own AI agents on your own machines, and you talk to them from a desktop or Android app.
This repo is `mimi-dev`, the command-line tool for testing an agent while you write it, apart from your real setup.
From your agent's folder it runs a private copy of the real gateway with one model; you chat with the agent, approve its tool calls, run test scenarios and see what each model call cost.

Requires Node.js 24 or newer and pnpm.

## In the workspace

The `devkit` profile of [launch](https://github.com/Mimi-agent-os/launch) clones and builds protocol, sdk, plugins,
gateway and devkit side by side. In your agent's folder: `pnpm add link:<workspace>/sdk` and
`pnpm add -D link:<workspace>/devkit`. You start and restart the agent yourself, in its own terminal.

## Flow

```sh
pnpm exec mimi-dev up --provider vllm --url http://10.0.0.5:8000 --model Qwen/Qwen3-32B \
    --ctx 32768 --param temperature=0.6 --param top_p=0.95
pnpm exec mimi-dev invite --write    # MIMI_INVITE, MIMI_GATEWAY_URL, MIMI_DATA_DIR into .env
pnpm start                           # your agent, in another terminal; restart it if it was running
pnpm exec mimi-dev check             # what the gateway sees of the agent: model, tools, prompt size
pnpm exec mimi-dev chat              # /new /resume <id> /calls /tools /quit; Ctrl-C stops a turn
pnpm exec mimi-dev test --runs 5     # scenarios/*.json
pnpm exec mimi-dev calls             # the model calls: tokens, cost, time, tokens per second
pnpm exec mimi-dev down --reset      # stop the devkit gateway and delete .mimi-dev
```

## Commands

Every command also takes `--dir <agent folder>` (default: the current folder).

```text
up       --provider vllm|llamacpp|openrouter --url <endpoint> --model <id> --ctx <tokens>
         [--param key=<json>]... [--price-in <usd/1M>] [--price-out <usd/1M>]
         [--limit <n>usd|<n>tokens|off] [--port <n>]
invite   [--write]
check    [agent] [--prompt] [--json]
chat     [agent] [--resume [<id>]] [-m <text>] [--yes] [--json]
calls    [agent] [<id>] [--limit <n>] [--conversation <id>] [--json]
test     [<file|folder>...] [--runs <n>] [--min-pass <0..1>] [--json]
down     [--reset]
```

- `up` keeps one model, named after the last `/` of `--model`; `up` and `invite` set it as the agent's primary and
  its one granted model. `--provider`, `--model` and `--ctx` together set up a model, the first time and whenever
  `--model` names a new one, which replaces the old; each other flag changes its own setting, and `--param key=null`
  removes a parameter.
- The devkit gateway takes a free port in 46465-46564, leaving 46464 to your real gateway. `VLLM_API_KEY` or
  `OPENROUTER_API_KEY`, when set in your shell, is stored in the devkit gateway.
- Exit codes: 0 passed, 1 a check, test or `chat -m` turn failed, 2 usage, 3 environment.

## Scenarios

```json
{ "name": "save a note", "runs": 3, "approve": ["notes_add"], "turns": [
  { "user": "save buy milk", "expect": { "reply": { "contains": ["saved"] },
      "tools": [{ "name": "notes_add", "args": { "text": "buy milk" } }] } },
  { "user": "what did I save?", "expect": { "tools": ["notes_list"] } } ] }
```

Each run is a fresh chat; every run sees the same agent data. `args` matches as a subset, `contains` ignores
case, and `approve` is `"all"`, `"none"` (the default) or a list of tool names.

`.mimi-dev/` (git-ignored) holds the devkit gateway's state folder, its log, a provider key, the key devkit pairs
with and the agent's `MIMI_DATA_DIR`: keep it out of Docker build contexts and archives.

## Development

`pnpm check` (tsc), `pnpm test` (the real gateway CLI and a small test agent built on the sdk), `pnpm build`
(`dist/`, the `mimi-dev` command). Build protocol, sdk and gateway next to it first.

See also [sdk](https://github.com/Mimi-agent-os/sdk) (writing an agent; also in the
[wiki](https://mimi-agent-os.github.io/wiki/#/sdk)), [gateway](https://github.com/Mimi-agent-os/gateway) and
[launch](https://github.com/Mimi-agent-os/launch).

Licensed under Apache-2.0, see LICENSE.
