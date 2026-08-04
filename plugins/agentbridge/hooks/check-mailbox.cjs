#!/usr/bin/env node
/**
 * check-mailbox.cjs — AgentBridge Stop hook (Claude Code & Kimi Code).
 *
 * Purpose: wake the frontend at turn end when its AgentBridge mailbox has
 * un-acked messages. MCP frontends cannot be pushed to (Claude's channel is
 * unavailable since v2.1.220; Kimi never had one), so without this hook an
 * idle agent never learns a message arrived until the user prompts it.
 *
 * Mechanism: the bridge-server (claude-adapter) persists the mailbox state to
 * `<AGENTBRIDGE_STATE_DIR>/mailbox-pending-<frontend>.json` on every queue and
 * drain. This hook (Stop event) reads that file; when count > 0 it exits 2
 * with the reason on stderr — both hosts treat that as "block the stop, feed
 * the reason back to the model", so the agent continues its turn and calls
 * get_messages (+ ack_ids).
 *
 * Loop safety: at most 2 blocks per `latestAt` (the last queue timestamp).
 * A model that reads without acking is allowed to stop after 2 nudges; a new
 * incoming message (new latestAt) re-arms the nudge.
 *
 * No-op (exit 0) outside bridged sessions: no pair env, no signal file, or
 * unreadable state.
 */

const fs = require("node:fs");
const path = require("node:path");

const MAX_BLOCKS_PER_LATEST = 2;

function main() {
  const stateDir = process.env.AGENTBRIDGE_STATE_DIR;
  if (!stateDir) process.exit(0);

  const frontend = (process.env.AGENTBRIDGE_FRONTEND || "claude").toLowerCase();
  const signalFile = path.join(stateDir, `mailbox-pending-${frontend}.json`);

  let signal;
  try {
    signal = JSON.parse(fs.readFileSync(signalFile, "utf8"));
  } catch {
    process.exit(0); // no signal file / unreadable → nothing to do
  }

  const count = Number(signal?.count) || 0;
  const latestAt = Number(signal?.latestAt) || 0;
  if (count <= 0) process.exit(0);

  // Dedupe per latestAt.
  const stateFile = path.join(stateDir, `mailbox-hook-state-${frontend}.json`);
  let state = { latestAt: 0, blocks: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (parsed && typeof parsed.latestAt === "number" && typeof parsed.blocks === "number") {
      state = parsed;
    }
  } catch {
    /* first run */
  }
  if (state.latestAt !== latestAt) {
    state = { latestAt, blocks: 0 };
  }
  if (state.blocks >= MAX_BLOCKS_PER_LATEST) {
    process.exit(0); // already nudged twice for this batch — let the turn end
  }
  state.blocks += 1;
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch {
    /* state write failure must not block the hook */
  }

  process.stderr.write(
    `AgentBridge mailbox has ${count} un-acked message(s) from your peer. ` +
      `Call get_messages now, then acknowledge them with ack_ids before ending your turn.`,
  );
  process.exit(2);
}

main();
