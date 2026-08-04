import { spawn } from "node:child_process";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { BUILD_INFO } from "../build-info";
import { guardAgentBridgeEnv, normalizeEnvGuardMode } from "../env-guard";
import { applyPairEnv, parsePairFlag, type PairResolution } from "../pair-resolver";
import { appendTraceEvent, pickRelevantEnv } from "../trace-log";
import { planMaxPermissions } from "./max-permissions";
import { assertPairNotLive, mapChildExitCode } from "./claude";
import { parseRelayFlag, applyRelayEnv } from "./relay-flag";

/**
 * `abg kimi` — start Kimi Code as an AgentBridge frontend (mirrors `abg claude`).
 *
 * Differences from the claude launcher:
 * - No channel flags: Kimi Code has no `notifications/claude/channel`
 *   equivalent, so the bridge delivers via the ACK mailbox + get_messages.
 * - No plugin cache preflight: the MCP server is registered via the user-level
 *   `~/.kimi-code/mcp.json` (see HANDOFF.md), not a Claude plugin cache.
 * - Max-permission default is `--yolo` (auto-approve tool calls), matching the
 *   codex wrapper's default posture.
 *
 * The kimi binary is resolved via PATH — make sure the official Kimi Code
 * (~/.kimi-code/bin/kimi) comes first; ~/.local/bin/kimi is the open-source
 * kimi-cli, which is a different program and must not be launched here.
 */

/** Flags that AgentBridge owns and will inject automatically. */
const OWNED_FLAGS = ["-y", "--yolo"];

const KIMI_MAX_PERMISSION_FLAG = "--yolo";
/** Explicit permission preferences that suppress the kimi injection. */
const KIMI_MAX_PERMISSION_SUPPRESSORS = [
  KIMI_MAX_PERMISSION_FLAG,
  "-y",
  "--auto",
  "--plan",
];

export async function runKimi(args: string[]) {
  const originalEnv = { ...process.env };
  const envGuardResult = guardAgentBridgeEnv({
    cwd: process.cwd(),
    env: process.env,
    mode: normalizeEnvGuardMode(process.env.AGENTBRIDGE_ENV_GUARD),
    allowStrict: true,
    log: (msg) => console.error(msg),
  });

  // Strip `--pair <name>` before anything else; the rest flows through to kimi.
  const { pairFlag, rest: pairRest } = parsePairFlag(args);

  // Strip wrapper-owned `--relay a|b` and export the relay env BEFORE pair
  // resolution, so the daemon (spawned below) and the MCP bridge-server
  // (spawned by kimi) both inherit it.
  const { relaySide, rest: relayRest } = parseRelayFlag(pairRest);
  if (relaySide) applyRelayEnv(relaySide);

  // Max-permission default (mirrors the claude/codex wrappers): `abg kimi` runs
  // Kimi Code with --yolo unless --safe / AGENTBRIDGE_SAFE=1 / the user already
  // passed an explicit permission flag. `--safe` is wrapper-owned and stripped.
  const permissionPlan = planMaxPermissions(relayRest, KIMI_MAX_PERMISSION_SUPPRESSORS);
  const rest = permissionPlan.args;

  // Check for owned flag conflicts (on the real kimi args, not the pair flag).
  checkOwnedFlagConflicts(rest, OWNED_FLAGS);

  // Resolve the pair and inject its env (state dir + ports) BEFORE spawning
  // kimi, so the pair env propagates to the MCP bridge-server child process.
  let pair: PairResolution;
  try {
    pair = await applyPairEnv({ pairFlag });
  } catch (err: any) {
    console.error(`[agentbridge] ${err.message}`);
    process.exit(1);
  }

  if (pair.warning) console.error(`[agentbridge] ⚠️  ${pair.warning}`);
  if (process.env.AGENTBRIDGE_TRACE === "1") {
    traceCliStart("cli.kimi.start", args, originalEnv, envGuardResult.action, pair);
  }

  const stateDir = pair.stateDir;
  const controlPort = pair.ports.controlPort;
  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort,
    log: (msg) => console.error(`[agentbridge] ${msg}`),
  });

  if (!pair.manual) {
    console.error(
      `[agentbridge] pair "${pair.pairId}" (slot ${pair.slot}) — control :${controlPort}, ` +
        `codex :${pair.ports.appPort}/:${pair.ports.proxyPort}`,
    );
  }

  // Conflict guard: a pair allows ONE frontend per slot. If a Claude (or Kimi)
  // session is already live on this pair's A slot, refuse to contest it.
  // Relay side b is exempt: it attaches to the peer slot, not the A slot.
  if (relaySide !== "b") {
    await assertPairNotLive(lifecycle, pair);
  }

  lifecycle.clearKilled();

  if (permissionPlan.inject) {
    console.error(`[agentbridge] running with ${KIMI_MAX_PERMISSION_FLAG} (default; opt out with --safe or AGENTBRIDGE_SAFE=1)`);
  }
  const fullArgs = [
    ...(permissionPlan.inject ? [KIMI_MAX_PERMISSION_FLAG] : []),
    ...rest,
  ];

  const child = spawn("kimi", fullArgs, {
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    process.exit(mapChildExitCode(code, signal));
  });

  child.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Error: kimi not found in PATH.");
      console.error("Install Kimi Code: curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash");
      process.exit(1);
    }
    console.error(`Error starting Kimi Code: ${err.message}`);
    process.exit(1);
  });
}

/**
 * Hard error on AgentBridge-owned flags passed by the user — mixed flag state
 * is unpredictable. (Local copy of the claude launcher's check, with kimi-
 * specific wording.)
 */
function checkOwnedFlagConflicts(args: string[], ownedFlags: string[]) {
  for (const flag of ownedFlags) {
    if (args.some((a) => a === flag || a.startsWith(`${flag}=`))) {
      console.error(`Error: "${flag}" is automatically set by agentbridge kimi.`);
      console.error("");
      console.error("AgentBridge automatically injects these flags:");
      for (const f of ownedFlags) {
        console.error(`  ${f}`);
      }
      console.error("");
      console.error("If you need full control over these flags, use the native command directly:");
      console.error("  kimi [your flags here]");
      process.exit(1);
    }
  }
}

function traceCliStart(
  event: string,
  args: string[],
  originalEnv: NodeJS.ProcessEnv,
  envGuardAction: string,
  pair: PairResolution,
) {
  try {
    appendTraceEvent({
      cwd: process.cwd(),
      event,
      pid: process.pid,
      argv: ["agentbridge", "kimi", ...args],
      env: process.env,
      data: {
        originalEnv: pickRelevantEnv(originalEnv),
        effectiveEnv: pickRelevantEnv(process.env),
        envGuardAction,
        pairId: pair.pairId,
        pairName: pair.name,
        manual: pair.manual,
        slot: pair.slot,
        stateDir: pair.stateDir.dir,
        ports: pair.ports,
        build: BUILD_INFO,
      },
    });
  } catch {
    // Trace logging is diagnostic only.
  }
}
