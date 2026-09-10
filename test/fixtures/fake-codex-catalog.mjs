import readline from "node:readline";
const thread = (id, source = "appServer") => ({ id, name: id, cwd: "/tmp/shared", source, status: { type: "idle" }, updatedAt: 1 });
const pages = [[thread("review", { subAgentReview: {} }), thread("first")], [thread("second"), thread("third")]];
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (!m.id) continue;
  let result;
  if (m.method === "initialize") result = {};
  else if (m.method === "thread/read") result = { thread: thread(m.params.threadId) };
  else if (m.method === "thread/list") {
    if (m.params.projectId) throw new Error("Desktop UI project IDs must not become native project filters");
    const page = Number(m.params.cursor ?? 0);
    result = { data: pages[page], nextCursor: page === 0 ? "1" : null };
  } else throw new Error("Unexpected catalog operation: " + m.method);
  process.stdout.write(JSON.stringify({ id: m.id, result }) + "\n");
}
