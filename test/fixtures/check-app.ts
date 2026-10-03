/** A notes agent with an app and a policy, for check.test; CHECK_APP_DOWN=1 declares the app but never serves it. */
import { createServer } from "node:http";

import { defineTool, runAgent } from "@mimi-os/sdk";

const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<h1>notes board</h1>");
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const { port } = server.address() as { port: number };
if (process.env["CHECK_APP_DOWN"] === "1") server.close();

const list = defineTool("notes_list", "List every note.", { type: "object", properties: {} }, () => "no notes yet");

await runAgent({
    tools: [list],
    policy: { allowedTools: ["notes_list", "get_time", "notes_export"] },
    app: { title: "Notes board", upstream: `http://127.0.0.1:${port}`, entry: "/" },
});
