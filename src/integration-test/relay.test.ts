/**
 * Relay mode integration test (AGENTBRIDGE_RELAY=1): two MCP frontends
 * bridge through the daemon WITHOUT any Codex. Covers:
 *   - both attach slots (side a / side b) and their admission
 *   - A→B delivery via PeerAdapter.injectMessage
 *   - B→A delivery via the codex-message path (marker filter + reply tracker)
 *   - relay require_reply wrapper names the requester and uses reply-tool wording
 *   - per-recipient peerName in status broadcasts
 *   - contest rejection on the b slot
 *   - peer disconnect propagates to A (no_thread on subsequent reply)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { BridgeMessage } from "../types";
import type { ControlServerMessage } from "../control-protocol";
import { portsForSlot, type PairPorts } from "../pair-registry";
import { readControlToken, resolveControlTokenPath } from "../control-token";
import { CONTRACT_VERSION } from "../contract-version";

const DAEMON_PATH = join(process.cwd(), "src", "daemon.ts");
const PAIR_ID = "main-relayabcd";
const SLOT_BASE = 3500 + (process.pid % 400);

interface FrontEnd {
  ws: WebSocket;
  messages: BridgeMessage[];
  statuses: ControlServerMessage[];
  closed: Promise<{ code: number; reason: string }>;
}

const daemons: ChildProcess[] = [];
const sockets: WebSocket[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try { ws.close(); } catch {}
  }
  for (const d of daemons.splice(0)) {
    if (d.exitCode === null && d.signalCode === null) {
      d.kill("SIGTERM");
      await waitFor(() => d.exitCode !== null || d.signalCode !== null, "daemon exit", 100, 50).catch(() => {
        try { d.kill("SIGKILL"); } catch {}
      });
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function startRelayDaemon(): Promise<{ controlPort: number; stateDir: string; cwd: string }> {
  const root = mkdtempSync(join(tmpdir(), "agentbridge-relay-test-"));
  roots.push(root);
  const cwdPath = join(root, "project");
  const stateDir = join(root, "state");
  mkdirSync(cwdPath, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const cwd = realpathSync(cwdPath);

  const { ports } = await reserveFreePairSlot();
  const env = {
    ...scrubAgentBridgeEnv(process.env),
    AGENTBRIDGE_RELAY: "1",
    AGENTBRIDGE_PAIR_ID: PAIR_ID,
    AGENTBRIDGE_PAIR_NAME: "main",
    AGENTBRIDGE_STATE_DIR: stateDir,
    AGENTBRIDGE_CONTROL_PORT: String(ports.controlPort),
    AGENTBRIDGE_IDLE_SHUTDOWN_MS: "60000",
    AGENTBRIDGE_BOOTSTRAP_TIMEOUT_MS: "10000",
    TUI_DISCONNECT_GRACE_MS: "200",
  };
  const daemon = spawn("bun", ["run", DAEMON_PATH], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  daemons.push(daemon);

  // Wait for the control server to accept connections.
  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${ports.controlPort}/healthz`);
      return res.ok;
    } catch {
      return false;
    }
  }, "relay daemon healthy", 120, 50);

  return { controlPort: ports.controlPort, stateDir, cwd };
}

async function attachFrontend(opts: {
  controlPort: number;
  stateDir: string;
  cwd: string;
  side: "a" | "b";
  frontend: string;
}): Promise<FrontEnd> {
  const ws = await connectControlSocket(opts.controlPort);
  sockets.push(ws);
  const fe: FrontEnd = { ws, messages: [], statuses: [], closed: Promise.resolve({ code: 0, reason: "" }) };
  fe.closed = new Promise((resolve) => {
    ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
  });
  ws.onmessage = (event) => {
    const raw = typeof event.data === "string" ? event.data : event.data.toString();
    const message = JSON.parse(raw) as ControlServerMessage;
    fe.statuses.push(message);
    if (message.type === "codex_to_claude") {
      fe.messages.push(message.message);
    }
  };
  const controlToken = readControlToken(resolveControlTokenPath(opts.stateDir));
  ws.send(JSON.stringify({
    type: "claude_connect",
    identity: {
      pairId: PAIR_ID,
      pairName: "main",
      cwd: opts.cwd,
      stateDir: opts.stateDir,
      clientPid: process.pid,
      contractVersion: CONTRACT_VERSION,
      frontend: opts.frontend,
      side: opts.side,
      ...(controlToken ? { controlToken } : {}),
    },
  }));
  return fe;
}

function sendReply(fe: FrontEnd, requestId: string, text: string, requireReply = false): void {
  fe.ws.send(JSON.stringify({
    type: "claude_to_codex",
    requestId,
    message: { id: requestId, source: "claude", content: text, timestamp: Date.now() },
    ...(requireReply ? { requireReply: true } : {}),
  }));
}

function lastStatus(fe: FrontEnd): Extract<ControlServerMessage, { type: "status" }> | undefined {
  return [...fe.statuses].reverse().find((m): m is Extract<ControlServerMessage, { type: "status" }> => m.type === "status");
}

describe("relay mode (frontend ↔ frontend)", () => {
  test("two frontends exchange messages both directions with correct peer naming", async () => {
    const { controlPort, stateDir, cwd } = await startRelayDaemon();
    const a = await attachFrontend({ controlPort, stateDir, cwd, side: "a", frontend: "kimi" });
    await waitFor(() => lastStatus(a) !== undefined, "A received attach status", 100, 50);
    const b = await attachFrontend({ controlPort, stateDir, cwd, side: "b", frontend: "claude" });
    await waitFor(() => lastStatus(b) !== undefined, "B received attach status", 100, 50);

    // Per-recipient peerName: A sees "Claude" (B's frontend), B sees "Kimi".
    await waitFor(() => lastStatus(a)?.status.peerName === "Claude", "A sees peerName Claude", 100, 50);
    expect(lastStatus(b)?.status.peerName).toBe("Kimi");

    // A→B delivery.
    sendReply(a, "req-a2b", "hello from A");
    await waitFor(() => b.messages.some((m) => m.content.includes("hello from A")), "B received A's message", 100, 50);

    // B→A delivery (rewritten to codex source for A's mailbox path).
    sendReply(b, "req-b2a", "[IMPORTANT] hello from B");
    await waitFor(() => a.messages.some((m) => m.content.includes("hello from B")), "A received B's message", 100, 50);
    const b2a = a.messages.find((m) => m.content.includes("hello from B"))!;
    expect(b2a.source).toBe("codex");

    // Relay require_reply: wrapper names the requester and uses reply-tool wording.
    sendReply(a, "req-rr", "please answer", true);
    await waitFor(() => b.messages.some((m) => m.content.includes("please answer")), "B received require_reply message", 100, 50);
    const rr = b.messages.find((m) => m.content.includes("please answer"))!;
    expect(rr.content).toContain("[⚠️ REPLY REQUIRED] Kimi has explicitly requested a reply");
    expect(rr.content).toContain("reply via the reply tool");
    expect(rr.content).not.toContain("agentMessage");
  }, 30000);

  test("contest on the b slot: incumbent alive → challenger rejected", async () => {
    const { controlPort, stateDir, cwd } = await startRelayDaemon();
    await attachFrontend({ controlPort, stateDir, cwd, side: "a", frontend: "kimi" });
    const b1 = await attachFrontend({ controlPort, stateDir, cwd, side: "b", frontend: "claude" });
    await waitFor(() => lastStatus(b1) !== undefined, "B1 attached", 100, 50);

    const b2 = await attachFrontend({ controlPort, stateDir, cwd, side: "b", frontend: "claude" });
    const close = await b2.closed;
    expect(close.code).not.toBe(1000);
    // B1 still works after the contest.
    sendReply(b1, "req-still", "still alive");
    await waitFor(() => lastStatus(b1) !== undefined, "B1 still attached", 100, 50);
  }, 30000);

  test("peer disconnect propagates: A's subsequent reply is rejected as not-ready", async () => {
    const { controlPort, stateDir, cwd } = await startRelayDaemon();
    const a = await attachFrontend({ controlPort, stateDir, cwd, side: "a", frontend: "kimi" });
    const b = await attachFrontend({ controlPort, stateDir, cwd, side: "b", frontend: "claude" });
    await waitFor(() => lastStatus(b) !== undefined, "B attached", 100, 50);

    b.ws.close();
    // Past the (200ms test) grace window, A learns the peer is gone.
    await waitFor(
      () => a.messages.some((m) => m.id.startsWith("system_tui_disconnected")),
      "A received peer-disconnect notice",
      120,
      50,
    );

    sendReply(a, "req-after-close", "anyone there?");
    await waitFor(
      () => a.statuses.some(
        (m) => m.type === "claude_to_codex_result" && m.requestId === "req-after-close" && m.success === false,
      ),
      "A's reply rejected after peer detach",
      120,
      50,
    );
  }, 30000);
});

// ── helpers ──────────────────────────────────────────────────

function scrubAgentBridgeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(scrubbed)) {
    if (key.startsWith("AGENTBRIDGE_") || key.startsWith("CODEX_")) {
      delete scrubbed[key];
    }
  }
  return scrubbed;
}

async function reserveFreePairSlot(): Promise<{ slot: number; ports: PairPorts }> {
  for (let slot = SLOT_BASE; slot < SLOT_BASE + 100; slot++) {
    const ports = portsForSlot(slot);
    const reservations: Array<ReturnType<typeof createServer>> = [];
    try {
      for (const port of [ports.appPort, ports.proxyPort, ports.controlPort]) {
        reservations.push(await listenOnPort(port));
      }
      await Promise.all(reservations.map((s) => closeServer(s)));
      return { slot, ports };
    } catch {
      await Promise.all(reservations.map((s) => closeServer(s).catch(() => {})));
    }
  }
  throw new Error("Could not find a free pair slot for relay test");
}

function listenOnPort(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function connectControlSocket(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("timed out connecting to daemon control socket"));
    }, 2000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("failed to connect to daemon control socket"));
    };
  });
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  attempts = 100,
  delayMs = 50,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Timed out waiting for condition: ${label}`);
}
