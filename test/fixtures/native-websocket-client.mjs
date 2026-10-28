// Test-only JSONL relay to an isolated local native app-server listener.
import readline from 'node:readline';
const url = new URL(process.argv[2]);
if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1') throw Error('Isolated loopback listener required');
let socket, opened = false, attempts = 0, ending = false;
const pending = [];
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => { if (socket?.readyState === WebSocket.OPEN) socket.send(line); else pending.push(line); });
lines.on('close', () => { ending = true; socket?.close(); });
function connect() {
  if (ending) return;
  const next = socket = new WebSocket(url);
  next.addEventListener('open', () => { opened = true; for (const line of pending.splice(0)) next.send(line); });
  next.addEventListener('message', event => process.stdout.write(String(event.data) + '\n'));
  next.addEventListener('error', () => {});
  next.addEventListener('close', () => {
    if (ending) { process.exitCode = 0; lines.close(); process.stdin.destroy(); }
    else if (!opened && ++attempts < 100) setTimeout(connect, 50);
    else { process.exitCode = 1; lines.close(); process.stdin.destroy(); }
  });
}
connect();
