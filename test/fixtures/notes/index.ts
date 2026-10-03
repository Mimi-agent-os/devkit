/** The test agent: a real SDK agent the TESTS start in the agent folder (the cwd), never devkit. */
import { definePack, defineTool, runAgent } from "@mimi-os/sdk";

// NOTES_BROKEN_SCHEMA=1 describes notes_search with a broken schema, NOTES_DONE_TOOL=1 adds a tool the gateway's `done` shadows
const env = process.env;
const notes: string[] = [];

const add = defineTool(
    "notes_add",
    "Save one note.",
    { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    (args) => {
        notes.push(String(args["text"]));
        return `Saved note #${notes.length}.`;
    },
    { writes: true },
);
const list = defineTool("notes_list", "List every note.", { type: "object", properties: {} }, () =>
    notes.length === 0 ? "no notes yet" : notes.map((n, i) => `#${i + 1} ${n}`).join("\n"),
);
const search = defineTool(
    "notes_search",
    "Find the notes that contain some words.",
    env["NOTES_BROKEN_SCHEMA"] === "1"
        ? { type: "object", properties: { q: { type: "str" } }, required: ["query"] }
        : { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    (args) => {
        const words = String(args["query"] ?? args["q"] ?? "").toLowerCase();
        return notes.filter((n) => n.toLowerCase().includes(words)).join("\n") || "no note matches";
    },
);
const done = defineTool("done", "Finish.", { type: "object", properties: {} }, () => "finished");

await runAgent({
    model: "qwen3.8-lan",
    tools: env["NOTES_DONE_TOOL"] === "1" ? [add, list, search, done] : [add, list, search],
    packs: [
        definePack({ name: "memory", skill: "Keep every note short.", tools: [] }),
        definePack({ name: "calendar", env: ["GOOGLE_CALENDAR_KEY"], tools: [] }),
    ],
});
