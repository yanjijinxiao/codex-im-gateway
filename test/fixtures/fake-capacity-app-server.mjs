import readline from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const failed = { id: "failed", status: "failed", items: [], error: { message: "capacity", codexErrorInfo: "serverOverloaded" } };
const thread = { id: "thread", cwd: "/tmp/project", status: { type: process.argv.includes("--system-error") ? "systemError" : "idle" }, turns: [failed] };
function finish() {
  send({ method: "item/completed", params: { threadId: "thread", turnId: "continued",
    item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "continued without replay" } } });
  send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "continued", status: "completed", error: null, items: [] } } });
}
readline.createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.id === "question" && m.result) {
    if (m.result.answers?.choice?.answers?.[0] !== "continue") throw Error("question lost during recovery");
    send({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: "question" } });
    finish(); return;
  }
  const result = result => send({ id: m.id, result });
  if (m.id == null) return;
  if (m.method === "initialize") return result({ userAgent: "isolated-capacity-fixture" });
  if (m.method === "thread/read" || m.method === "thread/resume") {
    if (m.method === "thread/resume" && ["approvalPolicy", "cwd"].some(key => key in m.params)) throw Error("must inherit approvals and workspace on resume");
    return result({ thread, model: "same-model", approvalPolicy: "on-request", sandbox: "workspace-write", cwd: "/tmp/project" });
  }
  if (m.method === "thread/turns/list") return result({ data: [failed] });
  if (m.method === "thread/queue/list") return result({ data: process.argv.includes("--queued") ? [{ id: "existing-input" }] : [] });
  if (m.method === "thread/unsubscribe") return result({});
  if (m.method === "turn/start") {
    const p = m.params;
    if (JSON.stringify(p.input) !== "[]" || p.turnTrigger !== "capacity_retry_automatic" || p.clientUserMessageId !== "stable-attempt"
      || ["approvalPolicy", "sandboxPolicy", "model", "effort", "cwd"].some(key => key in p)) throw Error("invalid recovery start");
    result({ turn: { id: "continued", status: "inProgress" } });
    send({ method: "turn/started", params: { threadId: "thread", turn: { id: "continued", status: "inProgress" } } });
    if (process.argv.includes("--ask")) {
      send({ id: "question", method: "item/tool/requestUserInput", params: { threadId: "thread", turnId: "continued", itemId: "question",
        questions: [{ id: "choice", header: "确认", question: "是否继续？" }] } });
    } else finish();
    return;
  }
  send({ id: m.id, error: { code: -32601, message: `Unexpected request: ${m.method}` } });
});
