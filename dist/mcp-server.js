#!/usr/bin/env node

// src/mcp-server.ts
import path7 from "node:path";
import { fileURLToPath as fileURLToPath3, pathToFileURL } from "node:url";

// src/session-context.ts
import path from "node:path";
var MAX_CWD_BYTES = 4096;
function validSessionCwd(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && path.isAbsolute(value) && Buffer.byteLength(value) <= MAX_CWD_BYTES;
}

// src/own-cwd.ts
function ownCwd() {
  try {
    const cwd = process.cwd();
    return validSessionCwd(cwd) ? cwd : null;
  } catch {
    return null;
  }
}

// src/relay.ts
import net2 from "node:net";
import fs3 from "node:fs";
import path4 from "node:path";
import { spawn, spawnSync } from "node:child_process";

// src/shared-identity.ts
import crypto from "node:crypto";
import fs2 from "node:fs";
import path3 from "node:path";

// src/version-guard.ts
import fs from "node:fs";
import path2 from "node:path";
import { fileURLToPath } from "node:url";
var ownVersionCache;
function ownPackageVersion() {
  if (ownVersionCache !== void 0) return ownVersionCache;
  try {
    const pkgPath = path2.join(path2.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const v = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
    ownVersionCache = typeof v === "string" && v ? v : null;
  } catch {
    ownVersionCache = null;
  }
  return ownVersionCache;
}
function maxUnixSocketPathBytes(platform = process.platform) {
  return platform === "linux" ? 107 : 103;
}
var MAX_UNIX_SOCKET_PATH_BYTES = maxUnixSocketPathBytes();

// src/shared-identity.ts
var IDENTITY_PREFIXES = [
  "MEMORY_BANK_",
  "TEST_",
  "ANTHROPIC_",
  "CLAUDE_",
  "_CLAUDE_",
  "AWS_",
  "GOOGLE_",
  "CLOUD_ML_",
  "VERTEX_",
  "DISABLE_",
  "ENABLE_"
];
var IDENTITY_NAMES = /* @__PURE__ */ new Set([
  "HOME",
  "XDG_CONFIG_HOME",
  "PERSONAL_SUPERPOWERS_DIR",
  "CONVERSATION_SEARCH_EXCLUDE_PROJECTS",
  "CLAUDECODE",
  "API_TIMEOUT_MS",
  "MAX_THINKING_TOKENS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // `read` prints dates and numbers in the process locale and time zone
  "LANG",
  "LC_ALL",
  "LC_MESSAGES",
  "LC_TIME",
  "LC_NUMERIC",
  "LC_CTYPE",
  "LC_COLLATE",
  "TZ"
]);
var SESSION_ONLY_NAMES = /* @__PURE__ */ new Set([
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_ENV_FILE",
  "MEMORY_BANK_SHARED_SERVER",
  "MEMORY_BANK_INJECT_REQ_ID"
]);
var SESSION_ONLY_PREFIXES = ["MEMORY_BANK_RELAY_", "MEMORY_BANK_WRAPPER_"];
var PASSTHROUGH_NAMES = /* @__PURE__ */ new Set(["PATH", "USER", "LOGNAME", "SHELL", "TMPDIR"]);
var PATH_NAMES = /* @__PURE__ */ new Set([
  "MEMORY_BANK_CONFIG_DIR",
  "PERSONAL_SUPERPOWERS_DIR",
  "XDG_CONFIG_HOME",
  "MEMORY_BANK_DB_PATH",
  "TEST_DB_PATH",
  "TEST_ARCHIVE_DIR",
  "TEST_PROJECTS_DIR",
  "CLAUDE_CONFIG_DIR"
]);
function serverEnvKind(name) {
  if (SESSION_ONLY_NAMES.has(name) || SESSION_ONLY_PREFIXES.some((p) => name.startsWith(p))) return null;
  if (PASSTHROUGH_NAMES.has(name)) return "passthrough";
  if (IDENTITY_NAMES.has(name) || IDENTITY_PREFIXES.some((p) => name.startsWith(p))) return "identity";
  return null;
}
function serverEnvFor(env, cwd) {
  const out = {};
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (value === void 0 || serverEnvKind(name) !== "identity") continue;
    if (PATH_NAMES.has(name) && value !== "" && !path3.isAbsolute(value)) {
      if (cwd === null) return null;
      out[name] = path3.resolve(cwd, value);
    } else {
      out[name] = value;
    }
  }
  return out;
}
function spawnEnvFor(env, serverEnv) {
  const out = { ...serverEnv };
  for (const name of PASSTHROUGH_NAMES) {
    const value = env[name];
    if (value !== void 0) out[name] = value;
  }
  return out;
}
function distFingerprint(distDir) {
  const hash = crypto.createHash("sha256");
  for (const name of fs2.readdirSync(distDir).filter((n) => n.endsWith(".js")).sort()) {
    hash.update(name).update("\0").update(fs2.readFileSync(path3.join(distDir, name))).update("\0");
  }
  return hash.digest("hex");
}
function sharedServerIdentity(o) {
  const env = Object.keys(o.serverEnv).sort().map((name) => [name, o.serverEnv[name]]);
  return crypto.createHash("sha256").update(JSON.stringify({ v: o.version, f: o.fingerprint, env })).digest("hex");
}
var SOCKET_VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
var sharedFileStem = (version, identity) => `mb-shared-${version}-${identity.slice(0, 8)}`;
function sharedSocketPathIn(indexDir, version, identity, maxBytes = MAX_UNIX_SOCKET_PATH_BYTES) {
  if (!SOCKET_VERSION_RE.test(version) || !/^[0-9a-f]{8,}$/.test(identity)) return null;
  const file = path3.join(indexDir, `${sharedFileStem(version, identity)}.sock`);
  return Buffer.byteLength(file) <= maxBytes ? file : null;
}
var sharedPidPath = (socketPath) => socketPath.replace(/\.sock$/, ".pid");
var sharedLockPath = (socketPath) => socketPath.replace(/\.sock$/, ".lock");
var sharedServerArg = (identity) => `--mb-shared=${identity.slice(0, 8)}`;

// src/shared-protocol.ts
var CONTROL_PREFIX = '{"mb_relay":';
var EXIT_RETRY = 75;
var EXIT_NAME_TAKEN = 76;

// src/unix-socket.ts
import net from "node:net";
var PROBE_TIMEOUT_MS = 500;
function probeSocket(p) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      probe.destroy();
      resolve(v);
    };
    const probe = net.connect(p);
    probe.setTimeout(PROBE_TIMEOUT_MS, () => done("unknown"));
    probe.on("connect", () => done("alive"));
    probe.on("error", (err) => done(err.code === "ECONNREFUSED" ? "dead" : err.code === "ENOENT" ? "absent" : "unknown"));
  });
}

// src/wrapper-core.ts
var LineSplitter = class {
  buf = "";
  /** Feed a chunk; returns complete lines (without trailing newline). */
  push(chunk) {
    this.buf += chunk;
    const lines = [];
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      lines.push(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
    if (this.buf.length > 16 * 1024 * 1024) this.buf = "";
    return lines;
  }
};
function parse(line) {
  try {
    const m = JSON.parse(line);
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}
var SupervisorState = class {
  initializeLine = null;
  initializedLine = null;
  initializeId = null;
  outstanding = /* @__PURE__ */ new Set();
  onClientLine(line) {
    const m = parse(line);
    if (!m) return;
    if (m.method === "initialize" && m.id !== void 0) {
      this.initializeLine = line;
      this.initializeId = m.id;
    } else if (m.method === "notifications/initialized") this.initializedLine = line;
    if (m.id !== void 0 && m.method !== void 0) this.outstanding.add(m.id);
  }
  onServerLine(line) {
    const m = parse(line);
    if (!m) return;
    if (m.id !== void 0 && m.method === void 0) this.outstanding.delete(m.id);
  }
  idle() {
    return this.outstanding.size === 0;
  }
  /** Replay is only possible once the original handshake was observed. */
  canReplay() {
    return this.initializeLine !== null;
  }
  /**
   * True when the client's initialize request already received its response.
   * Distinguishes a mid-session crash (replay: swallow the duplicate
   * response) from a startup crash (resend: the client is still waiting).
   */
  initializeAnswered() {
    return this.initializeId !== null && !this.outstanding.has(this.initializeId);
  }
  /**
   * Outstanding client→server REQUEST ids, excluding the initialize request
   * (which the supervisor replays/resends, not errors). On an unexpected child
   * death the wrapper must fail these back to the client with a JSON-RPC error
   * — otherwise a caller that sent e.g. tools/call id=7 waits forever
   * (review finding 2026-07-14 HIGH 4).
   */
  outstandingRequestIds() {
    const ids = [];
    for (const id of this.outstanding) {
      if (this.initializeId !== null && id === this.initializeId) continue;
      ids.push(id);
    }
    return ids;
  }
  /**
   * A respawn drops whatever the dead child still owed; forget those ids so
   * the new child starts idle (the swap itself only happens at idle, but a
   * crash-respawn may not).
   */
  resetOutstanding() {
    this.outstanding.clear();
  }
};
function abortedRequestError(id) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32001, message: "memory-bank server restarted; in-flight request aborted \u2014 please retry" }
  });
}
function isInitializeResponse(line, initializeLine) {
  const req = parse(initializeLine);
  const m = parse(line);
  if (!req || !m) return false;
  return m.id !== void 0 && m.id === req.id && m.method === void 0;
}

// src/relay.ts
function positiveMs(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function timings(env) {
  return {
    // The wrapper counts a child that dies within 10s as a start-up failure; 8s leaves it room to see that.
    youngMs: positiveMs(env.MEMORY_BANK_RELAY_YOUNG_MS, 8e3),
    helloMs: positiveMs(env.MEMORY_BANK_RELAY_HELLO_MS, 1e4),
    startWaitMs: positiveMs(env.MEMORY_BANK_RELAY_START_WAIT_MS, 3e4),
    pingAfterMs: positiveMs(env.MEMORY_BANK_RELAY_PING_AFTER_MS, 3e4)
  };
}
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function unavailableError(id, why) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32003, message: `memory-bank: the shared server is not available (${why}) \u2014 the call was not run; retry shortly` }
  });
}
function attemptConnection(mode, cwd, helloMs) {
  return new Promise((resolve) => {
    const socket = net2.connect(mode.socketPath);
    const splitter = new LineSplitter();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners("data");
      socket.removeAllListeners("close");
      if (result.kind !== "connected") socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: "silent" }), helloMs);
    socket.setEncoding("utf8");
    socket.on("error", (err) => {
      if (err.code === "ENOENT") finish({ kind: "absent" });
      else if (err.code === "ECONNREFUSED") finish({ kind: "refused" });
      else finish({ kind: "error", why: err.code ?? err.message });
    });
    socket.on("connect", () => {
      const hello = { mb_relay: 1, identity: mode.identity, version: mode.version, cwd, pid: process.pid };
      socket.write(JSON.stringify(hello) + "\n");
    });
    socket.on("close", () => finish({ kind: "error", why: "closed before answering the hello" }));
    socket.on("data", (chunk) => {
      const lines = splitter.push(chunk);
      if (lines.length === 0) return;
      const [first, ...rest] = lines;
      let reply = null;
      try {
        const parsed = JSON.parse(first);
        if (parsed && parsed.mb_relay === 1 && typeof parsed.ok === "boolean") reply = parsed;
      } catch {
      }
      if (reply === null) finish({ kind: "error", why: "the listener on the socket is not a memory-bank shared server" });
      else if (!reply.ok) finish({ kind: "rejected", error: reply.error });
      else finish({ kind: "connected", socket, splitter, rest, serverPid: reply.pid });
    });
  });
}
function acquireStartLock(lockPath, maxAgeMs) {
  for (let round = 0; round < 2; round++) {
    try {
      const fd = fs3.openSync(lockPath, "wx", 384);
      fs3.writeSync(fd, String(process.pid));
      fs3.closeSync(fd);
      return () => {
        try {
          if (fs3.readFileSync(lockPath, "utf8").trim() === String(process.pid)) fs3.unlinkSync(lockPath);
        } catch {
        }
      };
    } catch (err) {
      if (err.code !== "EEXIST") return null;
    }
    try {
      const age = Date.now() - fs3.statSync(lockPath).mtimeMs;
      const holder = Number(fs3.readFileSync(lockPath, "utf8").trim());
      const holderAlive = Number.isInteger(holder) && holder > 1 && isAlive(holder);
      const stale = holderAlive ? age > maxAgeMs : age > 1e3;
      if (!stale) return null;
      fs3.unlinkSync(lockPath);
    } catch {
    }
  }
  return null;
}
var LOG_MAX_BYTES = 1024 * 1024;
function spawnServer(mode) {
  const logDir = path4.join(mode.indexDir, "logs");
  fs3.mkdirSync(logDir, { recursive: true, mode: 448 });
  const logFile = path4.join(logDir, "shared-server.log");
  try {
    if (fs3.statSync(logFile).size > LOG_MAX_BYTES) fs3.renameSync(logFile, `${logFile}.old`);
  } catch {
  }
  const fd = fs3.openSync(logFile, "a", 384);
  try {
    const child = spawn(process.execPath, [mode.serverEntry, sharedServerArg(mode.identity)], {
      // Never the session's directory: the server must not have a working directory that means anything.
      cwd: mode.indexDir,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: spawnEnvFor(process.env, mode.serverEnv)
    });
    child.unref();
    return child;
  } finally {
    fs3.closeSync(fd);
  }
}
async function endUnresponsiveServer(mode, pid) {
  if (pid === null || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2e3 });
  const command = ps.status === 0 ? String(ps.stdout) : "";
  if (!command.includes("shared-server.js") || !command.includes(sharedServerArg(mode.identity))) return false;
  console.error(`[memory-bank relay] shared server ${pid} does not answer \u2014 ending it`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return true;
  }
  for (let waited = 0; waited < 2e3 && isAlive(pid); waited += 50) await sleep(50);
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
    for (let waited = 0; waited < 1e3 && isAlive(pid); waited += 50) await sleep(50);
  }
  return true;
}
function pidFromFile(socketPath) {
  try {
    const n = Number(fs3.readFileSync(sharedPidPath(socketPath), "utf8").trim());
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}
async function startServer(mode, t) {
  try {
    fs3.mkdirSync(mode.indexDir, { recursive: true, mode: 448 });
  } catch (err) {
    return { kind: "failed", why: `the index dir cannot be created: ${err.message}` };
  }
  const release = acquireStartLock(sharedLockPath(mode.socketPath), t.startWaitMs + 15e3);
  if (release === null) {
    await sleep(150);
    return { kind: "again" };
  }
  try {
    if (await probeSocket(mode.socketPath) === "alive") return { kind: "answering" };
    let child;
    try {
      child = spawnServer(mode);
    } catch (err) {
      return { kind: "failed", why: `the server process cannot be started: ${err.message}` };
    }
    let exit = null;
    let spawnError = null;
    child.once("exit", (code, signal) => {
      exit = { code, signal };
    });
    child.once("error", (err) => {
      spawnError = err;
    });
    const until = Date.now() + t.startWaitMs;
    for (; ; ) {
      if (await probeSocket(mode.socketPath) === "alive") return { kind: "answering" };
      if (spawnError !== null) return { kind: "failed", why: `the server process cannot be started: ${spawnError.message}` };
      const ended = exit;
      if (ended !== null) {
        if (ended.code === EXIT_NAME_TAKEN) return { kind: "again" };
        if (ended.code === EXIT_RETRY) return { kind: "later", why: "the socket name is held by something that is not a live server" };
        return { kind: "failed", why: `the server exited during start-up (${ended.signal ?? `code ${ended.code}`})` };
      }
      if (Date.now() > until) {
        try {
          child.kill("SIGKILL");
        } catch {
        }
        return { kind: "failed", why: `the server did not answer within ${t.startWaitMs}ms of being started` };
      }
      await sleep(50);
    }
  } finally {
    release();
  }
}
function runRelay(mode, cwd) {
  const t = timings(process.env);
  const logPath = path4.join(mode.indexDir, "logs", "shared-server.log");
  const state = new SupervisorState();
  const clientSplit = new LineSplitter();
  const pending = [];
  let link = null;
  let phase = "down";
  let needReplay = false;
  let failures = 0;
  let lastAttemptAt = 0;
  let retryTimer = null;
  let quietSince = 0;
  let pingSentAt = null;
  let pingSeq = 0;
  let ending = false;
  const debug = process.env.MEMORY_BANK_RELAY_DEBUG === "1" ? (message) => {
    console.error(`[memory-bank relay] ${message}`);
  } : () => {
  };
  const toClient = (line) => {
    process.stdout.write(line + "\n");
  };
  const toServer = (line) => {
    if (link === null) return;
    if (state.idle()) quietSince = Date.now();
    link.socket.write(line + "\n");
  };
  const flushPending = () => {
    for (const line of pending.splice(0)) toServer(line);
  };
  const failPending = (why) => {
    const keep = [];
    for (const line of pending.splice(0)) {
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
      }
      if (msg && (msg.method === "initialize" || msg.method === "notifications/initialized")) keep.push(line);
      else if (msg && msg.id !== void 0 && msg.method !== void 0) {
        const error = unavailableError(msg.id, `${why}; log: ${logPath}`);
        state.onServerLine(error);
        toClient(error);
      }
    }
    pending.push(...keep);
  };
  const onServerLine = (line) => {
    if (line === "") return;
    quietSince = Date.now();
    if (line.startsWith(CONTROL_PREFIX)) {
      pingSentAt = null;
      return;
    }
    if (phase === "replaying") {
      if (state.initializeLine !== null && isInitializeResponse(line, state.initializeLine)) {
        if (state.initializedLine !== null) {
          const initialized = state.initializedLine;
          toServer(initialized);
          for (let i = pending.length - 1; i >= 0; i--) if (pending[i] === initialized) pending.splice(i, 1);
        }
        phase = "up";
        flushPending();
      }
      return;
    }
    state.onServerLine(line);
    toClient(line);
  };
  const onDisconnect = () => {
    if (ending) return;
    link = null;
    pingSentAt = null;
    const wasUp = phase === "up" || phase === "replaying";
    phase = "down";
    if (wasUp) {
      const initAnswered = state.initializeAnswered();
      for (const id of state.outstandingRequestIds()) toClient(abortedRequestError(id));
      const initializeLine = state.initializeLine;
      state.resetOutstanding();
      if (initializeLine !== null) {
        if (initAnswered) needReplay = true;
        else {
          state.onClientLine(initializeLine);
          if (!pending.includes(initializeLine)) pending.unshift(initializeLine);
        }
      }
      console.error("[memory-bank relay] the shared server went away \u2014 reconnecting");
    }
    void connect();
  };
  const adopt = (a) => {
    link = { socket: a.socket, serverPid: a.serverPid };
    failures = 0;
    quietSince = Date.now();
    a.socket.on("data", (chunk) => {
      for (const line of a.splitter.push(chunk)) onServerLine(line);
    });
    a.socket.on("error", () => {
    });
    a.socket.on("close", onDisconnect);
    debug(`connected to shared server ${a.serverPid}${needReplay ? " \u2014 replaying the handshake" : ""}`);
    if (needReplay && state.initializeLine !== null) {
      needReplay = false;
      phase = "replaying";
      toServer(state.initializeLine);
    } else {
      needReplay = false;
      phase = "up";
      flushPending();
    }
    for (const line of a.rest) onServerLine(line);
  };
  const giveUp = (why) => {
    phase = "down";
    failures++;
    if (process.uptime() * 1e3 < t.youngMs) {
      console.error(`[memory-bank relay] cannot start the shared server: ${why}. Log: ${logPath}. This session has no memory-bank tools until it starts; set MEMORY_BANK_SHARED_SERVER=0 to run a server per session instead.`);
      process.exit(1);
    }
    console.error(`[memory-bank relay] no shared server (${why}) \u2014 calls are answered with an error until one starts. Log: ${logPath}`);
    failPending(why);
    if (failures <= 10 && retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
      }, Math.min(3e4, 1e3 * 2 ** (failures - 1)));
      retryTimer.unref();
    }
  };
  async function connect() {
    if (ending || phase !== "down") return;
    phase = "connecting";
    lastAttemptAt = Date.now();
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    let refused = 0;
    let silent = 0;
    let waitedMs = 0;
    for (; ; ) {
      if (ending) return;
      const a = await attemptConnection(mode, cwd, t.helloMs);
      if (ending) {
        if (a.kind === "connected") a.socket.destroy();
        return;
      }
      if (a.kind === "connected") {
        adopt(a);
        return;
      }
      if (a.kind === "rejected") {
        console.error(`[memory-bank relay] the shared server refused this session (${a.error}). Set MEMORY_BANK_SHARED_SERVER=0 to run a server per session instead.`);
        process.exit(1);
      }
      if (a.kind === "silent") {
        if (++silent > 2) {
          giveUp("a process holds the socket but does not answer");
          return;
        }
        const ended = await endUnresponsiveServer(mode, pidFromFile(mode.socketPath));
        if (!ended) {
          giveUp("a process that is not a memory-bank shared server holds the socket");
          return;
        }
        continue;
      }
      if (a.kind === "refused" && ++refused < 3) {
        await sleep(100);
        continue;
      }
      if (a.kind === "error" && ++refused < 3) {
        await sleep(100);
        continue;
      }
      const started = await startServer(mode, t);
      if (ending) return;
      if (started.kind === "failed") {
        giveUp(started.why);
        return;
      }
      if (started.kind === "later") {
        const pause = Math.min(2e3, 250 * 2 ** Math.min(3, Math.floor(waitedMs / 500)));
        waitedMs += pause;
        if (waitedMs > t.startWaitMs) {
          giveUp(started.why);
          return;
        }
        await sleep(pause);
      } else if (started.kind === "again") {
        waitedMs += 150;
        if (waitedMs > t.startWaitMs * 2) {
          giveUp("no server came up on the socket");
          return;
        }
      }
      refused = 0;
    }
  }
  const watchdog = setInterval(() => {
    if (phase !== "up" || link === null || state.idle()) {
      pingSentAt = null;
      return;
    }
    const now = Date.now();
    if (pingSentAt === null) {
      if (now - quietSince < t.pingAfterMs) return;
      pingSentAt = now;
      link.socket.write(JSON.stringify({ mb_relay: 1, ping: ++pingSeq }) + "\n");
      return;
    }
    if (now - pingSentAt < t.pingAfterMs) return;
    const stuck = link;
    pingSentAt = null;
    void endUnresponsiveServer(mode, stuck.serverPid).then(() => stuck.socket.destroy());
  }, Math.max(250, Math.min(5e3, t.pingAfterMs / 4)));
  watchdog.unref();
  const end = (code) => {
    if (ending) return;
    ending = true;
    link?.socket.destroy();
    process.exit(code);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    for (const line of clientSplit.push(chunk)) {
      if (line === "") continue;
      state.onClientLine(line);
      if (phase === "up") {
        toServer(line);
        continue;
      }
      pending.push(line);
      if (phase === "down") {
        if (retryTimer === null && Date.now() - lastAttemptAt >= 3e4) void connect();
        else if (retryTimer === null) failPending("the last attempt to start it failed moments ago");
      }
    }
  });
  process.stdin.on("end", () => end(0));
  process.stdout.on("error", () => end(0));
  process.on("SIGTERM", () => end(0));
  process.on("SIGINT", () => end(0));
  void connect();
}

// src/shared-mode.ts
import fs4 from "node:fs";
import path6 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/paths.ts
import os from "os";
import path5 from "path";
function superpowersDirOf(env) {
  if (env.MEMORY_BANK_CONFIG_DIR) return env.MEMORY_BANK_CONFIG_DIR;
  if (env.PERSONAL_SUPERPOWERS_DIR) return env.PERSONAL_SUPERPOWERS_DIR;
  if (env.XDG_CONFIG_HOME) return path5.join(env.XDG_CONFIG_HOME, "superpowers");
  return path5.join(env.HOME || os.homedir(), ".config", "superpowers");
}
function indexDirOf(env) {
  return path5.join(superpowersDirOf(env), "conversation-index");
}

// src/shared-mode.ts
var SHARED_SWITCH_FILE = "shared-server.off";
var SWITCH_OFF_RE = /^(0|false|off|no)$/i;
function sharedMode(o) {
  const local = (reason) => ({ kind: "session-local", reason });
  if (SWITCH_OFF_RE.test(o.env.MEMORY_BANK_SHARED_SERVER ?? "")) return local("switch-off");
  if ((o.platform ?? process.platform) === "win32") return local("windows");
  const entry = fileURLToPath2(o.entryUrl);
  const distDir = path6.dirname(entry);
  const serverEntry = path6.join(distDir, "shared-server.js");
  if (path6.extname(entry) !== ".js" || !fs4.existsSync(serverEntry)) return local("not-built");
  const version = o.version === void 0 ? ownPackageVersion() : o.version;
  if (!version) return local("no-version");
  const serverEnv = serverEnvFor(o.env, o.cwd);
  if (serverEnv === null) return local("relative-path");
  const indexDir = indexDirOf(serverEnv);
  if (fs4.existsSync(path6.join(indexDir, SHARED_SWITCH_FILE))) return local("switch-off-file");
  const identity = sharedServerIdentity({ version, fingerprint: distFingerprint(distDir), serverEnv });
  const socketPath = sharedSocketPathIn(indexDir, version, identity);
  if (socketPath === null) return local("socket-path-too-long");
  return { kind: "shared", socketPath, indexDir, identity, version, serverEnv, serverEntry };
}

// src/mcp-server.ts
var WHY_SESSION_LOCAL = {
  "switch-off": "MEMORY_BANK_SHARED_SERVER is off",
  "switch-off-file": "shared-server.off is present in the index dir",
  windows: "not available on Windows",
  "not-built": "running from source, or dist/shared-server.js is missing",
  "no-version": "the plugin version (package.json) cannot be read",
  "relative-path": "a path setting is relative and this process has no working directory to resolve it against",
  "socket-path-too-long": "the index dir path is too long for a unix socket \u2014 a shorter MEMORY_BANK_CONFIG_DIR / XDG_CONFIG_HOME turns it on"
};
async function main() {
  const cwd = ownCwd();
  const mode = sharedMode({ entryUrl: import.meta.url, env: process.env, cwd });
  if (mode.kind === "shared") {
    runRelay(mode, cwd);
    return;
  }
  console.error(`[memory-bank] shared server off: ${WHY_SESSION_LOCAL[mode.reason]} \u2014 this session runs its own server`);
  const entry = fileURLToPath3(import.meta.url);
  const sessionLocal = path7.join(path7.dirname(entry), `stdio-server${path7.extname(entry)}`);
  const { runStdioServer } = await import(pathToFileURL(sessionLocal).href);
  await runStdioServer();
}
main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
// memory-bank-bundle-stamp v1 inputs=b951102eaf52bf0f7f3743c74bb23aba991ba3fdf33b384b59d7d3f7c7845d5c body=0a2312cedca1fb9cfa4c425f2e9bc10b9531fcc3e2ba1f98c93756ca1fc9f8d3
