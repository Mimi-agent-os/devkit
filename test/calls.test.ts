import assert from "node:assert/strict";
import test from "node:test";

import { devkit, makeAgentDir, startAgent, startStubModel, textTurn, up, waitConnected } from "./harness.ts";

interface Row {
    id: number;
    conversationId: number;
    registryModel: string;
    promptTokens: number;
    completionTokens: number;
    cost: number;
    createdAt: string;
}

test("calls prints a table of a chat's calls, --json its rows, <id> the raw record", async (t) => {
    const dir = makeAgentDir(t);
    const stub = await startStubModel(t, [textTurn("hello there"), textTurn("second answer")]);
    assert.equal((await up(dir, stub)).code, 0);
    assert.equal((await devkit(["invite", "--write"], { dir })).code, 0);
    startAgent(dir);
    await waitConnected(dir, "notes");

    const empty = await devkit(["calls"], { dir });
    assert.deepEqual([empty.code, empty.stdout], [0, "no model calls by notes yet\n"]);
    assert.equal((await devkit(["chat", "-m", "hi"], { dir })).code, 0);
    assert.equal((await devkit(["chat", "-m", "again"], { dir })).code, 0);

    const json = await devkit(["calls", "--json"], { dir });
    assert.equal(json.code, 0, json.stderr);
    const rows = JSON.parse(json.stdout) as Row[];
    assert.deepEqual(
        rows.map((r) => [r.registryModel, r.promptTokens, r.completionTokens, r.cost]),
        [["stub-a", 120, 8, 0], ["stub-a", 120, 8, 0]],
    );
    const [newest, oldest] = rows;
    assert.ok(newest && oldest && newest.conversationId !== oldest.conversationId);

    // unpriced: no $ column; the oldest call first; the gateway's UTC shown on the developer's clock, here UTC+3
    const table = await devkit(["calls"], { dir, env: { TZ: "Etc/GMT-3" } });
    assert.equal(table.code, 0, table.stderr);
    const lines = table.stdout.trimEnd().split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? "", /^id\s+time\s+chat\s+kind\s+model\s+in\s+out\s+reasoning\s+secs\s+first\s+tok\/s\s+finish$/);
    const local = `${String((Number(oldest.createdAt.slice(11, 13)) + 3) % 24).padStart(2, "0")}${oldest.createdAt.slice(13, 19)}`;
    assert.match(lines[1] ?? "", new RegExp(`^${oldest.id}\\s+${local}\\s+${oldest.conversationId}\\s+\\S+\\s+stub-a\\s+120\\s+8\\s+-\\s+\\d+\\.\\d\\d\\s+\\S+\\s+\\S+\\s+stop$`));
    assert.match(lines[2] ?? "", new RegExp(`^${newest.id}\\s`));

    const one = await devkit(["calls", "--conversation", `${oldest.conversationId}`], { dir });
    assert.equal(one.stdout.trimEnd().split("\n").length, 2);
    const none = await devkit(["calls", "--conversation", "999", "--limit", "5"], { dir });
    assert.equal(none.stdout, "no model calls in chat 999 yet\n");

    const record = await devkit(["calls", `${oldest.id}`], { dir });
    assert.equal(record.code, 0, record.stderr);
    assert.match(JSON.stringify(JSON.parse(record.stdout)), /hello there/);
    const named = await devkit(["calls", "notes", `${oldest.id}`], { dir });
    assert.equal(named.stdout, record.stdout);

    const missing = await devkit(["calls", "424242"], { dir });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /^mimi-dev calls: notes has no call 424242 with a record \(no such call\)\n$/);
    assert.equal((await devkit(["calls", "--limit", "0"], { dir })).code, 2);
});
