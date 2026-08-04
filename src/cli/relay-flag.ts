/**
 * `--relay a|b` — wrapper-owned flag for relay pairs (frontend ↔ frontend,
 * no Codex). The launcher strips it (never forwarded to the child CLI) and
 * exports AGENTBRIDGE_RELAY / AGENTBRIDGE_RELAY_SIDE into the environment
 * BEFORE pair resolution, so the daemon (spawned by the lifecycle) and the
 * MCP bridge-server (spawned by the child CLI) both inherit them:
 *
 *   - daemon: AGENTBRIDGE_RELAY=1 selects PeerAdapter instead of CodexAdapter
 *   - bridge-server: AGENTBRIDGE_RELAY_SIDE lands in the claude_connect
 *     identity so the daemon knows which slot this frontend claims
 */

export type RelaySide = "a" | "b";

export function parseRelayFlag(args: string[]): { relaySide: RelaySide | null; rest: string[] } {
  const rest: string[] = [];
  let relaySide: RelaySide | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let value: string | null = null;
    if (arg === "--relay") {
      value = args[i + 1] ?? null;
      i++;
    } else if (arg.startsWith("--relay=")) {
      value = arg.slice("--relay=".length);
    }
    if (value !== null) {
      if (value !== "a" && value !== "b") {
        console.error(`Error: --relay requires "a" or "b" (got "${value}").`);
        console.error("Example: abg kimi --relay a   /   abg claude --relay b");
        process.exit(1);
      }
      relaySide = value;
      continue;
    }
    rest.push(arg);
  }
  return { relaySide, rest };
}

/** Export the relay env for the daemon + bridge-server to inherit. */
export function applyRelayEnv(side: RelaySide): void {
  process.env.AGENTBRIDGE_RELAY = "1";
  process.env.AGENTBRIDGE_RELAY_SIDE = side;
}
