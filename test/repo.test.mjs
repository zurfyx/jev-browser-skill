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

test("every shipped trace is well formed, and its notes line up", () => {
  const traces = tracked.filter(f => f.startsWith("site/traces/") && f.endsWith(".json") && !f.endsWith(".notes.json"));
  assert.ok(traces.length, "the site ships at least one trace");
  for (const file of traces) {
    const raw = read(file), trace = JSON.parse(raw);
    assert.ok(trace.steps.length > 0, `${file} has steps`);
    assert.ok(trace.goal && trace.result?.status, `${file} records its goal and outcome`);
    for (const step of trace.steps) {
      assert.ok(step.calls?.[0]?.body?.questions?.operation, `${file} keeps the request it sent`);
      assert.ok(step.decision.operation, `${file} keeps what Jev decided`);
    }
    // a secret is masked at the source, so no trace may carry one
    assert.ok(!/lZVjb|hunter2/.test(raw), `${file} must contain no password`);
    for (const step of trace.steps) {
      if (step.decision.text && trace.secret) {
        assert.ok(!/^.{0,40}$/.test(step.decision.text) || !/secret/i.test(step.decision.text), `${file} masks typed secrets`);
      }
    }
    const notes = file.replace(/\.json$/, ".notes.json");
    if (tracked.includes(notes)) {
      assert.equal(JSON.parse(read(notes)).length, trace.steps.length, `${notes} needs one note per step`);
    }
  }
});

test("the site only references files that exist", () => {
  const html = read("site/index.html");
  for (const [, href] of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    if (href.startsWith("/_vercel")) continue; // injected by Vercel at runtime
    assert.ok(tracked.includes(href.slice(1)), `site/index.html references missing ${href}`);
  }
});
