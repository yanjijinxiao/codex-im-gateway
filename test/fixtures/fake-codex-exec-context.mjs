// Fake CLI process: report the actual spawn cwd and arguments, without model/API calls.
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "independent-exec" }) + "\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: {
  type: "agent_message", text: JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) })
} }) + "\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\n");
