#!/usr/bin/env node
/** tools/rfa-sync.mjs -- one-way Bitburner -> disk file sync over the Remote File API.
 *
 *  WHY THIS EXISTS. ns.write only touches the game's own filesystem, and the hud1 snapshot button
 *  goes through a browser Blob download, so it lands in the OS download directory rather than the
 *  repo. This closes the loop: the game already writes status/snapshot.txt every time snap.js runs,
 *  and this pulls it (and anything else matching --include) onto disk continuously.
 *
 *  DIRECTION MATTERS. The GAME is the WebSocket client -- Remote.ts constructs `new WebSocket(...)`
 *  and dials out to ip:port (Settings -> Remote API). So this is a SERVER, not a client. Point the
 *  game at 127.0.0.1:<port>, then run this.
 *
 *  Protocol is JSON-RPC 2.0 (src/RemoteFileAPI/MessageDefinitions.ts):
 *      -> { jsonrpc:"2.0", id, method:"getAllFiles", params:{ server:"home" } }
 *      <- { jsonrpc:"2.0", id, result:[ { filename, content } ] }
 *  Other methods: getFileNames, getFile, pushFile, deleteFile, calculateRam, getAllFileMetadata.
 *
 *  Zero dependencies -- the repo has none and this is not worth adding `ws` for. The RFC6455 bits
 *  below are the minimum needed: handshake, unmasking, 16/64-bit lengths, continuation frames
 *  (getAllFiles responses run well past 64KB), and ping/pong.
 *
 *  usage:  node tools/rfa-sync.mjs [--port 12525] [--out .] [--include "status/*"] [--interval 5000]
 *          --include may be repeated. Globs match on the in-game filename; * does not cross "/".
 *          Default include is status/* ONLY -- syncing everything would overwrite your repo
 *          sources with whatever build happens to be loaded in the game, which is backwards.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, normalize, resolve, sep } from "node:path";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function parseArgs(argv) {
  const out = { port: 12525, out: ".", include: [], interval: 5000, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--include") out.include.push(argv[++i]);
    else if (a === "--interval") out.interval = Number(argv[++i]);
    else if (a === "--verbose" || a === "-v") out.verbose = true;
  }
  if (!out.include.length) out.include = ["status/*"];
  return out;
}

/** Glob -> RegExp. `*` matches within a path segment, `**` crosses separators. */
export function globToRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

/** Refuse anything that would escape the output directory. Filenames come from the game, which is
 *  not a trust boundary, and "../../.bashrc" must not be writable.
 *
 *  REFUSE, do not sanitise. An earlier version stripped leading "../" and wrote the remainder inside
 *  outDir -- which kept the containment invariant but silently relocated the file, so a caller
 *  asking for "status/../../x" quietly got "<out>/x". Silently doing something other than what was
 *  asked is the failure mode this whole codebase keeps stamping out; a refusal that logs is better
 *  than a rewrite that does not. Containment is checked on the RESOLVED path, not by pattern. */
export function safeJoin(outDir, filename) {
  if (typeof filename !== "string" || !filename || filename.includes("\0")) return null;
  if (filename.startsWith("/") || filename.startsWith("\\") || /^[a-zA-Z]:/.test(filename)) return null;
  if (filename.split(/[/\\]/).includes("..")) return null;
  const root = resolve(outDir);
  const dest = resolve(root, normalize(filename));
  if (dest !== root && !dest.startsWith(root + sep)) return null;
  return dest;
}

// ---------------------------------------------------------------- RFC6455 (minimum viable)

function acceptKey(key) {
  return createHash("sha1").update(key + GUID).digest("base64");
}

function encodeFrame(payloadStr) {
  const payload = Buffer.from(payloadStr, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + text
  return Buffer.concat([header, payload]);
}

/** Pull complete frames out of a rolling buffer. Returns { frames, rest }. */
export function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off], b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask = null;
    if (masked) { if (buf.length - p < 4) break; mask = buf.subarray(p, p + 4); p += 4; }
    if (buf.length - p < len) break;
    const data = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    frames.push({ fin, opcode, data });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------- server

export function startServer(opts, onFiles) {
  const includes = opts.include.map(globToRe);
  const server = createServer((_req, res) => { res.writeHead(426); res.end("upgrade required"); });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + acceptKey(key) + "\r\n\r\n",
    );

    let buf = Buffer.alloc(0);
    let assembling = null;      // continuation-frame accumulator
    let nextId = 1;
    const pending = new Map();
    const send = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
      setTimeout(() => { if (pending.delete(id)) reject(new Error(method + " timed out")); }, 30000);
    });

    const onMessage = (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(String(msg.error)));
      else p.resolve(msg.result);
    };

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        if (f.opcode === 0x8) { socket.end(); return; }                 // close
        if (f.opcode === 0x9) { const pong = encodeFrame(""); pong[0] = 0x8a; socket.write(pong); continue; }
        if (f.opcode === 0xa) continue;                                  // pong
        if (f.opcode === 0x0) {                                          // continuation
          if (assembling) assembling = Buffer.concat([assembling, f.data]);
        } else {
          assembling = f.data;
        }
        if (f.fin && assembling) { const t = assembling.toString("utf8"); assembling = null; onMessage(t); }
      }
    });
    socket.on("error", () => {});

    let stopped = false;
    socket.on("close", () => { stopped = true; console.log("[rfa] game disconnected"); });
    console.log("[rfa] game connected");

    (async () => {
      const seen = new Map();
      while (!stopped) {
        try {
          const files = await send("getAllFiles", { server: "home" });
          const matched = (files || []).filter((f) => includes.some((re) => re.test(f.filename)));
          const changed = matched.filter((f) => seen.get(f.filename) !== f.content);
          for (const f of changed) seen.set(f.filename, f.content);
          if (changed.length) await onFiles(changed);
        } catch (e) {
          if (!stopped) console.error("[rfa] poll failed:", e.message);
        }
        await new Promise((r) => setTimeout(r, opts.interval));
      }
    })();
  });

  return server;
}

async function writeFiles(outDir, files, verbose) {
  for (const f of files) {
    const dest = safeJoin(outDir, f.filename);
    if (!dest) { console.error("[rfa] REFUSED unsafe filename:", f.filename); continue; }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, f.content, "utf8");
    console.log("[rfa] wrote " + dest + " (" + f.content.length + " bytes)");
    if (verbose) console.log(f.content.slice(0, 200));
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const server = startServer(opts, (files) => writeFiles(opts.out, files, opts.verbose));
  server.listen(opts.port, "127.0.0.1", () => {
    console.log("[rfa] listening on 127.0.0.1:" + opts.port);
    console.log("[rfa] include: " + opts.include.join(", ") + "   out: " + opts.out);
    console.log("[rfa] now enable Bitburner: Options -> Remote API -> port " + opts.port + " -> Connect");
  });
}
export { parseArgs, writeFiles };
