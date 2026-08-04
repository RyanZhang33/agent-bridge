import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLatestKimiSession } from "../kimi-session";

const CWD = "/Users/test/project";
const SES_A = "ses_11111111-2222-3333-4444-555555555555";
const SES_B = "ses_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SES_OLD_STYLE = "session_99999999-8888-7777-6666-555555555555";

function makeKimiHome(lines: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "abg-kimi-session-test-"));
  writeFileSync(join(home, "session_index.jsonl"), lines.join("\n") + "\n");
  return home;
}

function indexLine(sessionId: string, workDir: string): string {
  return JSON.stringify({
    sessionId,
    sessionDir: `/home/x/.kimi-code/sessions/wd_x/${sessionId}`,
    workDir,
  });
}

describe("findLatestKimiSession", () => {
  test("returns null when the index file does not exist", () => {
    const home = mkdtempSync(join(tmpdir(), "abg-kimi-session-test-"));
    expect(findLatestKimiSession(CWD, home)).toBeNull();
  });

  test("returns the session for the matching workDir", () => {
    const home = makeKimiHome([indexLine(SES_A, CWD)]);
    expect(findLatestKimiSession(CWD, home)?.sessionId).toBe(SES_A);
  });

  test("last matching line wins (index is append-ordered)", () => {
    const home = makeKimiHome([
      indexLine(SES_A, CWD),
      indexLine(SES_B, "/other/dir"),
      indexLine(SES_OLD_STYLE, CWD),
    ]);
    expect(findLatestKimiSession(CWD, home)?.sessionId).toBe(SES_OLD_STYLE);
  });

  test("ignores sessions from other directories", () => {
    const home = makeKimiHome([indexLine(SES_A, "/other/dir")]);
    expect(findLatestKimiSession(CWD, home)).toBeNull();
  });

  test("skips corrupt lines and keeps going", () => {
    const home = makeKimiHome([
      "{not json",
      indexLine(SES_A, CWD),
      "",
      indexLine(SES_B, CWD),
    ]);
    expect(findLatestKimiSession(CWD, home)?.sessionId).toBe(SES_B);
  });

  test("skips records with missing sessionId", () => {
    const home = makeKimiHome([
      JSON.stringify({ workDir: CWD }),
      indexLine(SES_A, CWD),
    ]);
    expect(findLatestKimiSession(CWD, home)?.sessionId).toBe(SES_A);
  });
});
