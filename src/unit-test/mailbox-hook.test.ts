import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(process.cwd(), "plugins", "agentbridge", "hooks", "check-mailbox.cjs");

function runHook(env: Record<string, string>): { code: number; stderr: string } {
  const result = spawnSync("node", [HOOK], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

function makeStateDir(signal?: { count: number; latestAt: number }, frontend = "claude"): string {
  const dir = mkdtempSync(join(tmpdir(), "abg-mailbox-hook-test-"));
  if (signal) {
    writeFileSync(join(dir, `mailbox-pending-${frontend}.json`), JSON.stringify(signal));
  }
  return dir;
}

describe("check-mailbox Stop hook", () => {
  test("exits 0 without AGENTBRIDGE_STATE_DIR", () => {
    const env = { ...process.env };
    delete env.AGENTBRIDGE_STATE_DIR;
    const result = spawnSync("node", [HOOK], { env, encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  test("exits 0 when the signal file is missing", () => {
    const dir = makeStateDir();
    expect(runHook({ AGENTBRIDGE_STATE_DIR: dir }).code).toBe(0);
  });

  test("exits 0 when the mailbox is empty (count=0)", () => {
    const dir = makeStateDir({ count: 0, latestAt: 1000 });
    expect(runHook({ AGENTBRIDGE_STATE_DIR: dir }).code).toBe(0);
  });

  test("blocks (exit 2) with count in stderr when messages are pending", () => {
    const dir = makeStateDir({ count: 3, latestAt: 1000 });
    const result = runHook({ AGENTBRIDGE_STATE_DIR: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("3 un-acked message");
    expect(result.stderr).toContain("get_messages");
  });

  test("blocks at most twice per latestAt, then lets the turn end", () => {
    const dir = makeStateDir({ count: 1, latestAt: 2000 });
    expect(runHook({ AGENTBRIDGE_STATE_DIR: dir }).code).toBe(2);
    expect(runHook({ AGENTBRIDGE_STATE_DIR: dir }).code).toBe(2);
    expect(runHook({ AGENTBRIDGE_STATE_DIR: dir }).code).toBe(0);
  });

  test("a new latestAt re-arms the nudge", () => {
    const dir = makeStateDir({ count: 1, latestAt: 3000 });
    expect(runHook({ AGENTBRIDGE_STATE_DIR: dir }).code).toBe(2);
    expect(runHook({ AGENTBRIDGE_STATE_DIR: dir }).code).toBe(2);
    expect(runHook({ AGENTBRIDGE_STATE_DIR: dir }).code).toBe(0);
    // New message arrives → latestAt changes → block again.
    writeFileSync(join(dir, "mailbox-pending-claude.json"), JSON.stringify({ count: 2, latestAt: 4000 }));
    expect(runHook({ AGENTBRIDGE_STATE_DIR: dir }).code).toBe(2);
  });

  test("reads the per-frontend signal file (relay pairs share one state dir)", () => {
    const dir = makeStateDir({ count: 1, latestAt: 5000 }, "kimi");
    expect(runHook({ AGENTBRIDGE_STATE_DIR: dir, AGENTBRIDGE_FRONTEND: "kimi" }).code).toBe(2);
    // Default frontend "claude" has no file in this dir → no-op.
    expect(runHook({ AGENTBRIDGE_STATE_DIR: dir }).code).toBe(0);
  });
});
