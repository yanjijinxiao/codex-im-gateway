/** JSONL stdin/stdout to the native Unix-socket WebSocket transport.
 * Shared by local daemon and SSH clients; no execution ownership or restart policy. */
export const APP_SERVER_SOCKET_RELAY = String.raw`
const crypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const readline = require("node:readline");
const socketPath = process.argv[1] || path.join(process.env.HOME || "", ".codex", "app-server-control", "app-server-control.sock");
let socket;
let buffer = Buffer.alloc(0);
let upgraded = false;
let fragmentOpcode = null;
let fragments = [];
const queued = [];
let inputEnded = false;

function fail(error) {
  const detail = error && error.message ? error.message : String(error);
  process.stderr.write("remote Codex Desktop relay failed: " + detail + "\n");
  process.exitCode = 1;
  if (socket && !socket.destroyed) socket.destroy();
}

function frame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || "");
  const mask = crypto.randomBytes(4);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const masked = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 1) masked[index] = body[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function send(line) {
  if (!upgraded) {
    queued.push(line);
    return;
  }
  socket.write(frame(0x1, line));
}

function handleFrame(opcode, final, payload) {
  if (opcode === 0x8) {
    socket.end(frame(0x8, Buffer.alloc(0)));
    return;
  }
  if (opcode === 0x9) {
    socket.write(frame(0xA, payload));
    return;
  }
  if (opcode === 0xA) return;
  if (opcode === 0x1 || opcode === 0x2) {
    fragmentOpcode = opcode;
    fragments = [payload];
  } else if (opcode === 0x0 && fragmentOpcode !== null) {
    fragments.push(payload);
  } else {
    return;
  }
  if (!final) return;
  const complete = Buffer.concat(fragments);
  const completeOpcode = fragmentOpcode;
  fragmentOpcode = null;
  fragments = [];
  if (completeOpcode === 0x1) process.stdout.write(complete.toString("utf8") + "\n");
}

function parseFrames() {
  while (buffer.length >= 2) {
    const first = buffer[0];
    const second = buffer[1];
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return;
      const largeLength = buffer.readBigUInt64BE(2);
      if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) return fail(new Error("WebSocket frame is too large"));
      length = Number(largeLength);
      offset = 10;
    }
    const masked = (second & 0x80) !== 0;
    const maskBytes = masked ? 4 : 0;
    if (buffer.length < offset + maskBytes + length) return;
    const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
    offset += maskBytes;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    buffer = buffer.subarray(offset + length);
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    handleFrame(first & 0x0f, (first & 0x80) !== 0, payload);
  }
}

socket = net.createConnection({ path: socketPath });
socket.once("connect", () => {
  const key = crypto.randomBytes(16).toString("base64");
  socket.write([
    "GET / HTTP/1.1",
    "Host: localhost",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: " + key,
    "Sec-WebSocket-Version: 13",
    "",
    ""
  ].join("\r\n"));
});
socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (!upgraded) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end === -1) return;
    const headers = buffer.subarray(0, end).toString("utf8");
    buffer = buffer.subarray(end + 4);
    if (!headers.startsWith("HTTP/1.1 101")) return fail(new Error("WebSocket upgrade was rejected: " + headers.split("\r\n")[0]));
    upgraded = true;
    for (const line of queued.splice(0)) send(line);
  }
  parseFrames();
});
socket.on("error", fail);
socket.on("close", () => {
  // A remote Desktop restart closes its control socket while Gateway still
  // holds SSH stdin open. Do not leave readline alive masquerading as a usable
  // transport; the caller must observe disconnect and open a fresh reader.
  if (!inputEnded && !process.exitCode) process.exitCode = 1;
  lines.close();
  process.stdin.destroy();
});

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", send);
lines.on("close", () => {
  inputEnded = true;
  if (socket && !socket.destroyed) socket.end(frame(0x8, Buffer.alloc(0)));
});
`;
