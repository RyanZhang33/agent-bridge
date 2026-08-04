/**
 * Kimi Code MCP Server frontend — mailbox-only delivery.
 *
 * Kimi Code speaks stdio MCP (user-level `~/.kimi-code/mcp.json`) but has no
 * equivalent of Claude Code's `notifications/claude/channel` push, so this
 * adapter reuses ClaudeAdapter's ACK mailbox + reply/get_messages tools and
 * disables the channel push. The daemon is frontend-agnostic: Kimi's replies
 * keep the protocol-level `source: "claude"` label (see handleReply), so no
 * daemon-side change is needed.
 *
 * Env contract:
 *   AGENTBRIDGE_FRONTEND=kimi     — set by the kimi mcp.json entry; bridge.ts
 *                                   selects this adapter based on it.
 */

import { StateDirResolver } from "./state-dir";
import { ClaudeAdapter, type ClaudeAdapterOptions } from "./claude-adapter";

export const KIMI_INSTRUCTIONS = [
  "Codex is an AI coding agent (OpenAI) running in a separate session on the same machine.",
  "",
  "## Message delivery",
  "Messages from Codex are NOT pushed to you in real time — Kimi Code has no MCP push channel. They are stored in the AgentBridge mailbox.",
  "Call get_messages proactively: after every reply you send, before you end your turn, and whenever the user asks about Codex status or progress.",
  "Messages stay in the mailbox until acknowledged — pass ack_ids (from the [id: ...] labels) to confirm receipt and remove them.",
  "",
  "## Collaboration roles",
  "Default roles in this setup:",
  "- Kimi: Reviewer, Planner, Hypothesis Challenger",
  "- Codex: Implementer, Executor, Reproducer/Verifier",
  "- Expect Codex to provide independent technical judgment and evidence, not passive agreement.",
  "",
  "## Thinking patterns (task-driven)",
  "- Analytical/review tasks: Independent Analysis & Convergence",
  "- Implementation tasks: Architect -> Builder -> Critic",
  "- Debugging tasks: Hypothesis -> Experiment -> Interpretation",
  "",
  "## Collaboration language",
  "- Use explicit phrases such as \"My independent view is:\", \"I agree on:\", \"I disagree on:\", and \"Current consensus:\".",
  "",
  "## How to interact",
  "- Use the reply tool to send messages to Codex — pass chat_id back (from the chat_id line in get_messages output).",
  "- After sending a reply, call get_messages to check for responses.",
  "",
  "## Turn coordination",
  "- When you see '⏳ Codex is working', do NOT call the reply tool — wait for '✅ Codex finished' (check with get_messages).",
  "- If the reply tool returns a busy error, Codex is still executing. You decide: wait and retry later, resend with on_busy=\"steer\" to feed the message INTO the running turn (good for mid-course corrections; it does not interrupt or restart the work), or resend with on_busy=\"interrupt\" to STOP the running turn and start a new one with your message (use only when the current work is obsolete — prefer steer otherwise).",
  "",
  "## Budget awareness",
  "- Use the get_budget tool to check both agents' subscription quota (5h/weekly windows, drift, pause state).",
  "- If the reply tool returns a budget-pause error (code budget_paused), do NOT retry; checkpoint your work and wait for the resume notice (poll get_messages for it).",
  "- If the reply tool returns a budget_admission error, the 5h window is in finishing-protection: new tasks are declined, but you may bring the CURRENT collaboration to a checkpoint by resending with wrap_up=true (a small per-window quota). Do NOT start new work; once the quota is used or you are done, write a checkpoint and wait for the 5h window to refresh.",
].join("\n");

export class KimiAdapter extends ClaudeAdapter {
  constructor(logFile = new StateDirResolver().logFile, options: ClaudeAdapterOptions = {}) {
    super(logFile, {
      ...options,
      channelPush: false,
      instructions: options.instructions ?? KIMI_INSTRUCTIONS,
    });
  }
}
