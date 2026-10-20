import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runCommand, spawnDetached } from "../plugins/opencode/scripts/lib/process.mjs";

describe("process", () => {
  it("runCommand captures stdout", async () => {
    const { stdout, exitCode } = await runCommand("echo", ["hello"]);
    assert.equal(stdout.trim(), "hello");
    assert.equal(exitCode, 0);
  });

  it("runCommand captures exit code on failure", async () => {
    const { exitCode } = await runCommand("false", []);
    assert.notEqual(exitCode, 0);
  });

  it("runCommand captures stderr", async () => {
    const { stderr, exitCode } = await runCommand("sh", ["-c", "echo err >&2"]);
    assert.ok(stderr.includes("err"));
  });

  it("spawnDetached keeps an argument with spaces whole", async () => {
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spawn-")), "out.log");
    const text = "Update the file, then report back";
    spawnDetached("node", ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", text], { logFile });
    // The child is unref'd, so wait on its output rather than its exit event.
    for (let i = 0; i < 50 && !fs.readFileSync(logFile, "utf8").includes("\n"); i++) await sleep(100);
    assert.deepEqual(JSON.parse(fs.readFileSync(logFile, "utf8")), [text]);
  });
});
