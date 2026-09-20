// Guards for the mistakes this repo has actually made. All run against tracked files only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
const textFiles = tracked.filter(f => /\.(mjs|js|json|html|css|md|yml|yaml)$/.test(f));
const read = f => readFileSync(f, "utf8");

test("every JavaScript file parses", () => {
  for (const f of tracked.filter(f => /\.m?js$/.test(f))) {
    execFileSync(process.execPath, ["--check", f]); // throws on a syntax error
  }
});

test("the browser-safe core imports with no Node built-ins", async () => {
  const core = read("scripts/core.mjs");
  assert.ok(!/from "node:/.test(core), "core.mjs runs in the browser too, so it cannot import node: modules");
  const m = await import("../scripts/core.mjs");
  for (const name of ["SNAPSHOT", "LOCATE", "OPERATIONS", "buildRequest", "readDecision", "decide", "fingerprint"]) {
    assert.ok(name in m, `core.mjs must export ${name}`);
  }
});

test("no API key is committed", () => {
  for (const f of textFiles) {
    assert.ok(!/apikey_[a-f0-9]{8}/i.test(read(f)), `${f} looks like it contains an API key`);
  }
});

test("no machine-local absolute path is committed", () => {
  for (const f of textFiles) {
    assert.ok(!/\/Users\/[a-z]/i.test(read(f)), `${f} contains an absolute /Users path`);
  }
});

test("agent tooling directories are not tracked", () => {
  const leaked = tracked.filter(f => /^\.(claude|codex|cursor|agents)\//.test(f));
  assert.deepEqual(leaked, [], "machine-local agent config must stay out of the repo");
});

test("the shipped trace is well formed and carries no secret", () => {
  const trace = JSON.parse(read("site/traces/hackernews-login.json"));
  assert.ok(trace.steps.length > 0);
  assert.equal(trace.secret, true, "this run used a secret");
  for (const step of trace.steps) {
    assert.ok(step.calls?.[0]?.body?.questions?.operation, "each step keeps the request it sent");
    assert.ok(step.decision.operation, "each step keeps what Jev decided");
    if (step.decision.text) assert.ok(!/[a-z]/.test(step.decision.text) || step.decision.text === "Jev" || step.decision.text === "zurfyx",
      "a typed secret must be masked in the trace");
  }
  assert.ok(!/lZVjb|hunter2/.test(read("site/traces/hackernews-login.json")), "no password in the trace");
});

test("the site only references files that exist", () => {
  const html = read("site/index.html");
  for (const [, href] of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    if (href.startsWith("/_vercel")) continue; // injected by Vercel at runtime
    assert.ok(tracked.includes(href.slice(1)), `site/index.html references missing ${href}`);
  }
});
