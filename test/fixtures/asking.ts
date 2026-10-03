/** The notes agent with two tools that ask while they run: one through its own approve(), one as a gate outside any chat. */
import { defineTool, runAgent, type AgentRuntime } from "@mimi-os/sdk";

let agent: AgentRuntime | undefined;
const purge = defineTool("notes_purge", "Delete every note.", { type: "object", properties: {} }, async (_args, ctx) =>
    (await ctx?.approve?.("purge every note", { notes: 3 })) === true ? "purged 3 notes" : "kept every note",
);
const sync = defineTool("notes_sync", "Copy the notes to the cloud.", { type: "object", properties: {} }, async () => {
    // no session: the gate parks outside any chat and reaches devices only through /api/events
    const answer = await agent!.client.askApprove({ label: "sync notes to the cloud", detail: { to: "cloud" } });
    return answer.approved ? "synced" : "not synced";
});

agent = await runAgent({ model: "qwen3.8-lan", tools: [purge, sync] });
