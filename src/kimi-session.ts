import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Kimi Code keeps a global append-only session index at
 * `~/.kimi-code/session_index.jsonl` (verified on 0.31.1). Each line is a
 * JSON record:
 *
 *   {"sessionId":"ses_<uuid>","sessionDir":".../sessions/<wdKey>/ses_<uuid>",
 *    "workDir":"/Users/x/project"}
 *
 * Session ids come in two shapes — `ses_<uuid>` (newer) and `session_<uuid>`
 * (older) — both are accepted as opaque strings; the index is the source of
 * truth, not the directory names.
 */
export interface KimiSessionInfo {
  sessionId: string;
  sessionDir: string;
}

/**
 * The most recently recorded Kimi Code session for a working directory.
 * The index is append-ordered, so the LAST matching line wins. Returns null
 * when the index is missing/unreadable or has no entry for this cwd. Corrupt
 * lines are skipped (fail-open).
 */
export function findLatestKimiSession(
  cwd: string,
  // Kimi Code honors KIMI_CODE_HOME to relocate its data dir — without this,
  // a relocated install would get a false "no session found".
  // `||` (not `??`): empty-string env is treated as unset (codebase convention).
  kimiHome: string = process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code"),
): KimiSessionInfo | null {
  let content: string;
  try {
    content = readFileSync(join(kimiHome, "session_index.jsonl"), "utf8");
  } catch {
    return null;
  }

  let best: KimiSessionInfo | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: any;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      record &&
      record.workDir === cwd &&
      typeof record.sessionId === "string" &&
      record.sessionId.length > 0
    ) {
      best = {
        sessionId: record.sessionId,
        sessionDir: typeof record.sessionDir === "string" ? record.sessionDir : "",
      };
    }
  }
  return best;
}
