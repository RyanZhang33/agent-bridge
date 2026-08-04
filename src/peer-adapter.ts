/**
 * PeerAdapter — relay mode (AGENTBRIDGE_RELAY=1): a second MCP frontend
 * (Kimi Code / Claude Code) standing in the "Codex slot".
 *
 * The daemon talks to its codex side through a fixed surface (inject/canInject/
 * lifecycle/properties/events). In a relay pair there IS no Codex — this
 * adapter presents the same surface but routes to a second control socket:
 *
 *   A→B: daemon calls injectMessage() → we send `codex_to_claude` to the peer
 *        socket (the B-side bridge-server's ACK mailbox).
 *   B→A: the daemon detects the sender is our attached socket and calls
 *        handleIncoming() → we re-emit it as an `agentMessage` event with
 *        source:"codex", so the daemon's existing codex-message path (marker
 *        filtering, reply tracking, attention window) runs untouched.
 *
 * Turn coordination (steer/interrupt/busy) does not exist between MCP
 * frontends: turnInProgress is always false and steer/interrupt are inert.
 *
 * Events emitted (subset of CodexAdapter's, mapped to peer attach lifecycle):
 *   - "tuiConnected" / "tuiDisconnected"  — peer attached / detached
 *   - "ready"                             — peer attached (drives bridge-ready)
 *   - "agentMessage"                      — B→A message (see handleIncoming)
 *   - "bridgeTurnStarted"                 — immediate, so the daemon's
 *     pendingTurnStarts bookkeeping and turn_started ACK behave like a
 *     successful synchronous delivery.
 */

import { EventEmitter } from "node:events";
import type { ServerWebSocket } from "bun";
import type { BridgeMessage } from "./types";
import type { ControlClientIdentity, TurnPhase } from "./control-protocol";
import { CLOSE_CODE_REPLACED } from "./control-protocol";
import type { AppServerInfo } from "./app-server-protocol";
import { probeLiveness as probeLivenessImpl } from "./liveness-probe";
import type { BoundedMessageBuffer } from "./delivery-buffer";
import { createProcessLogger, type ProcessLogger } from "./process-log";

/** Minimal shape PeerAdapter needs from a control socket (daemon's ControlSocketData). */
interface PeerSocketData {
  clientId: number;
  attached: boolean;
  lastPongAt: number;
  pongCount: number;
  identity?: ControlClientIdentity;
  pendingBackpressure: BoundedMessageBuffer;
}

type PeerSocket = ServerWebSocket<PeerSocketData>;

const MAX_BUFFERED_RELAY_MESSAGES = 100;

export class PeerAdapter extends EventEmitter {
  private peer: PeerSocket | null = null;
  private peerName = "Peer";
  private challengeInProgress = false;
  private injectionSeq = 0;
  private buffered: BridgeMessage[] = [];
  private readonly logger: ProcessLogger;

  constructor(logFile?: string) {
    super();
    this.logger = createProcessLogger({ component: "PeerAdapter", logFile });
  }

  // ── CodexAdapter-compatible surface ─────────────────────────

  readonly proxyUrl = "relay://peer-b";
  readonly appServerUrl = "relay://peer-b";

  get appServerInfo(): AppServerInfo | null {
    return null;
  }
  /** CodexAdapter-compat: relay never performs an initialize handshake. */
  get capturedAppServerInfo(): AppServerInfo | null {
    return null;
  }
  get turnInProgress(): boolean {
    return false;
  }
  get turnPhase(): TurnPhase {
    return "idle";
  }
  get steerableTurnId(): string | null {
    return null;
  }
  get activeThreadId(): string | null {
    return this.peer ? "relay-peer" : null;
  }

  /** Display name of the attached peer (from its identity.frontend). */
  get peerDisplayName(): string {
    return this.peerName;
  }
  get attachedSocket(): PeerSocket | null {
    return this.peer;
  }
  isAttachedSocket(ws: PeerSocket): boolean {
    return this.peer !== null && this.peer === ws;
  }

  async start(): Promise<void> {
    this.log("started (relay mode — waiting for peer frontend to attach)");
  }

  async stop(): Promise<void> {
    if (this.peer) {
      try {
        this.peer.close(1001, "daemon shutting down");
      } catch {
        /* already closed */
      }
    }
  }

  forceKillAppServerSync(): void {
    // No child process in relay mode.
  }

  canInject(): boolean {
    return this.peer !== null && this.peer.readyState === WebSocket.OPEN;
  }

  /**
   * A→B: deliver a message to the peer frontend. Mirrors CodexAdapter's
   * numeric injection id so the daemon's pendingTurnStarts bookkeeping works
   * unchanged; bridgeTurnStarted is emitted synchronously after a successful
   * send (delivery = accepted into the peer socket, there is no turn to start).
   */
  injectMessage(content: string, _overrides?: { model?: string; effort?: string }): number | null {
    if (!this.canInject()) return null;
    const injectionId = ++this.injectionSeq;
    const msg: BridgeMessage = {
      id: `relay_inject_${injectionId}`,
      source: "claude",
      content,
      timestamp: Date.now(),
    };
    if (!this.sendToPeer(msg)) return null;
    // Fire-and-forget microtask so the daemon's pendingTurnStarts entry exists
    // before this event lands (the daemon sets it right after injectMessage
    // returns — emitting synchronously here would race ahead of it).
    queueMicrotask(() => this.emit("bridgeTurnStarted", { requestId: injectionId, turnId: "relay-turn" }));
    return injectionId;
  }

  steerMessage(_text: string): number | null {
    // No turn to steer between MCP frontends.
    return null;
  }

  interruptActiveTurns(): { ok: true; turnIds: string[] } {
    return { ok: true, turnIds: [] };
  }

  waitForTurnsTerminal(
    _turnIds?: string[],
    _timeoutMs?: number,
    _signal?: AbortSignal,
  ): Promise<{ ok: true }> {
    return Promise.resolve({ ok: true });
  }

  // ── Peer slot management ─────────────────────────────────────

  /**
   * Attach a control socket as the relay peer (side "b"). Single slot with the
   * same contest semantics as the A side: probe an incumbent, evict if dead,
   * reject if alive.
   */
  async attach(ws: PeerSocket, identity: ControlClientIdentity | undefined, probeTimeoutMs: number): Promise<void> {
    const incumbent = this.peer;
    if (incumbent && incumbent !== ws && incumbent.readyState !== WebSocket.CLOSED) {
      if (this.challengeInProgress) {
        ws.close(CLOSE_CODE_REPLACED, "peer liveness probe in progress, retry shortly");
        return;
      }
      this.challengeInProgress = true;
      let alive = false;
      try {
        alive = await probeLivenessImpl(
          {
            get readyState() {
              return incumbent.readyState;
            },
            get pongCount() {
              return incumbent.data.pongCount;
            },
            ping: () => {
              incumbent.ping();
            },
          },
          { timeoutMs: probeTimeoutMs },
        );
      } finally {
        this.challengeInProgress = false;
      }
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
      if (alive) {
        this.log(`Rejecting peer attach #${ws.data.clientId} — incumbent #${incumbent.data.clientId} is alive`);
        ws.close(CLOSE_CODE_REPLACED, "another peer session is already connected");
        return;
      }
      this.detach(incumbent, "evicted: liveness probe failed");
      try {
        incumbent.close(CLOSE_CODE_REPLACED, "stale peer evicted by newer session");
      } catch {
        /* already closed */
      }
    }

    this.peer = ws;
    ws.data.attached = true;
    const frontend = identity?.frontend?.toLowerCase();
    this.peerName = frontend === "kimi" ? "Kimi" : frontend === "claude" ? "Claude" : "Peer";
    this.log(`Peer attached (#${ws.data.clientId}, frontend=${this.peerName})`);

    // Drive the daemon's connection state machine exactly like a Codex TUI:
    // connected first, then ready — so canReply() flips and the A side gets
    // its kickoff.
    this.emit("tuiConnected", ws.data.clientId);
    this.emit("ready", "relay-peer");

    // Deliver anything buffered while no peer was attached.
    if (this.buffered.length > 0) {
      const pending = this.buffered;
      this.buffered = [];
      for (const m of pending) this.sendToPeer(m);
    }
  }

  /** Detach on socket close or eviction. Re-buffers in-flight messages. */
  detach(ws: PeerSocket, reason: string): void {
    if (this.peer !== ws) return;
    this.peer = null;
    ws.data.attached = false;
    this.log(`Peer detached (#${ws.data.clientId}, ${reason})`);

    // Same at-least-once discipline as the A side: messages that only reached
    // Bun's socket buffer are re-queued for the next attach.
    const inFlight = ws.data.pendingBackpressure.drainAll();
    if (inFlight.length > 0) {
      this.buffered = [...inFlight, ...this.buffered].slice(-MAX_BUFFERED_RELAY_MESSAGES);
      this.log(`Re-buffered ${inFlight.length} in-flight message(s) for redelivery`);
    }
    this.emit("tuiDisconnected", ws.data.clientId);
  }

  /**
   * B→A: a `claude_to_codex` arrived from the attached peer socket. Re-emit it
   * as a codex-sourced agentMessage so the daemon's existing codex-message
   * path (marker filtering / reply tracker / attention window) handles it.
   */
  handleIncoming(message: BridgeMessage): void {
    this.emit("agentMessage", { ...message, source: "codex" as const });
  }

  // ── Internals ────────────────────────────────────────────────

  private sendToPeer(message: BridgeMessage): boolean {
    const ws = this.peer;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.bufferMessage(message);
      return false;
    }
    try {
      const result = ws.send(JSON.stringify({ type: "codex_to_claude", message }));
      // Bun semantics: -1 = enqueued under backpressure (tracked for re-buffer
      // on close); 0 = dropped.
      if (typeof result === "number" && result === 0) {
        this.log("Send to peer returned 0 (dropped) — buffering");
        this.bufferMessage(message);
        return false;
      }
      if (typeof result === "number" && result === -1) {
        ws.data.pendingBackpressure.push(message);
      }
      return true;
    } catch (err: any) {
      this.log(`Send to peer failed: ${err?.message ?? err} — buffering`);
      this.bufferMessage(message);
      return false;
    }
  }

  private bufferMessage(message: BridgeMessage): void {
    this.buffered.push(message);
    if (this.buffered.length > MAX_BUFFERED_RELAY_MESSAGES) {
      this.buffered.splice(0, this.buffered.length - MAX_BUFFERED_RELAY_MESSAGES);
    }
  }

  private log(msg: string): void {
    this.logger.log(msg);
  }
}
