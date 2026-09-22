#!/usr/bin/env node
// Jev drives a browser. Zero dependencies: Node 22+ and any Chromium-based browser.
//
//   observe page → Jev picks an operation and a target → code executes it → repeat
//
// core.mjs    the interesting part: what Jev is asked and how its answer is validated
// browser.mjs the plumbing: Chrome DevTools Protocol client, launch or attach
// this file   the loop, the command line, the log, and --trace

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decide, fingerprint } from "./core.mjs";
import { Chrome, sleep } from "./browser.mjs";

const API = "https://api.typesafe.ai/v1/systemone";
const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function apiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  for (const file of [join(SKILL_DIR, ".env"), join(homedir(), ".typesafe")]) {
    if (!existsSync(file)) continue;
    const match = readFileSync(file, "utf8").match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*["']?([^"'\s]+)/m);
    if (match) return match[1];
  }
  throw new Error(`TYPESAFE_API_KEY is not set. Export it, or put TYPESAFE_API_KEY=... in ${join(SKILL_DIR, ".env")}`);
}

/** One request to Jev: POST the body, get back a choice and a probability per option for every question. */
async function askJev(key, body) {
  const started = performance.now();
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(API, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (![429, 503, 529].includes(response.status)) break;
    await sleep(500 * 2 ** attempt);
  }
  if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const { answers, usage } = await response.json();
  const ms = Math.round(performance.now() - started);
  if (process.env.JEV_DEBUG) console.error(`   jev: ${usage?.input_tokens} tokens, ${Object.keys(body.questions).join(" + ")}, ${ms}ms`);
  return { answers, usage, ms };
}

const top = (probabilities, name = k => k) => Object.entries(probabilities).sort((a, b) => b[1] - a[1]).slice(0, 4)
  .map(([k, v]) => `${name(k)} ${v.toFixed(2)}`).join(", ");

async function main() {
  const { values: args } = parseArgs({
    options: {
      url: { type: "string" },
      goal: { type: "string" },
      text: { type: "string", multiple: true, default: [] },
      secret: { type: "string" },
      "max-steps": { type: "string", default: "25" },
      screenshot: { type: "string" },
      trace: { type: "string" },
      browser: { type: "string", default: "auto" },
      headless: { type: "boolean", default: false },
      close: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (args.help || !args.url || !args.goal) {
    console.log(`Usage: jev.mjs --url <url> --goal "<goal>" [--text "<value to type>"]...

  --text <value>       A string Jev may type into a field. Repeat for several values.
  --secret <value>     A string typed only into password fields. Never sent to Jev, never printed.
  --max-steps <n>      Stop after n actions (default 25).
  --screenshot <png>   Save a screenshot of the final page.
  --trace <json>       Save every step: page table, request, answers, decision, screenshot.
  --browser <mode>     auto (default): your own browser when it allows remote debugging, else a Jev window.
                       yours: your own browser, or fail with setup instructions.
                       own: the Jev window, a dedicated Chrome with its own persistent profile.
                       host:port: any browser started with --remote-debugging-port.
  --headless           Run without a window (implies --close).
  --close              Close the tab or window when finished. By default it stays open.`);
    process.exit(args.help ? 0 : 2);
  }
  const key = apiKey();
  const ask = body => askJev(key, body);
  const model = process.env.TYPESAFE_MODEL || "jev-latest";
  const url = /^[a-z]+:/i.test(args.url) ? args.url : `https://${args.url}`;
  const maxSteps = Number(args["max-steps"]) || 25;
  fetch(API, { method: "HEAD" }).catch(() => {}); // open the TLS connection to Jev while the browser starts
  const chrome = await Chrome.open(args.browser, { headless: args.headless });
  const history = [], trace = { goal: args.goal, texts: args.text, secret: Boolean(args.secret), url, model, steps: [] };
  let status = "max_steps", modelMs = 0, stale = 0, page;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  try {
    await chrome.goto(url);
    while (history.length < maxSteps) {
      page = await chrome.observe();
      if (history.length) history.at(-1).page_changed ??= history.at(-1).fingerprint !== fingerprint(page);
      const stuck = history.slice(-3);
      if (stuck.length === 3 && stuck.every(h => h.page_changed === false)) { status = "blocked"; break; }
      if (page.omitted) console.error(`   warning: ${page.omitted} controls beyond the first 250 were not offered to Jev (255-choice limit per question)`);

      const screenshot = args.trace ? await chrome.screenshot() : null;
      const decision = await decide(ask, { goal: args.goal, page, texts: args.text, secret: args.secret, history, model });
      modelMs += decision.ms;
      const { operation, e, option, text } = decision;
      const shown = decision.secret ? "••••••" : text;
      const label = e ? `${e.role} "${e.label}"` + (option ? ` → "${option.label}"` : "") + (text ? ` ← "${shown}"` : "") : "";
      console.log(`${String(trace.steps.length + 1).padStart(2)}  ${operation.padEnd(11)} ${label.padEnd(58).slice(0, 58)}  p=${decision.p.toFixed(2)}  ${String(decision.ms).padStart(4)}ms  +${(elapsed() / 1000).toFixed(1)}s`);
      if (process.env.JEV_DEBUG) {
        console.error("   ops: " + top(decision.probabilities.operation));
        if (decision.probabilities.target) console.error("   targets: " + top(decision.probabilities.target, k => `[${k}] ${page.elements[Number(k.split(":")[0]) - 1].label}`));
      }
      trace.steps.push({
        elapsed_ms: elapsed(), page: { ...page, screenshot }, calls: decision.calls,
        decision: { operation, target: e && `[${e.index}] ${e.role} "${e.label}"`, option: option?.label, text: shown, p: decision.p, probabilities: decision.probabilities, ms: decision.ms },
      });
      if (operation === "DONE" || operation === "BLOCKED") { status = operation.toLowerCase(); break; }

      if (e) {
        const aims = operation !== "SELECT"; // a SELECT needs no coordinates
        let point = await chrome.locate(e.node, args.headless ? "" : `Jev · ${operation} · ${Math.round(decision.p * 100)}%`, aims);
        if (!point) { // the page moved under us: observe again rather than act on a stale decision
          trace.steps.at(-1).executed = false;
          if (++stale > 5) { status = "blocked"; break; }
          await chrome.settle();
          continue;
        }
        if (!args.headless) { // the highlight pause is long enough for a busy page to reflow
          await sleep(300);
          point = (await chrome.locate(e.node, "", aims)) ?? point;
        }
        if (operation === "SELECT") await chrome.select(e.node, option.value);
        else await chrome.click(point);
        if (operation === "TYPE") await chrome.type(e.node, text);
      } else await chrome.enter();
      trace.steps.at(-1).executed = true;

      history.push({ operation, target: e && `${e.role} "${e.label}"`, text: shown, url: page.url, fingerprint: fingerprint(page) });
      await chrome.settle();
    }
    page = await chrome.observe();
    if (args.screenshot) writeFileSync(args.screenshot, await chrome.screenshot("png"));
  } finally {
    if (args.headless || args.close) await chrome.close();
    else chrome.socket.close();
  }

  const result = {
    status,
    steps: history.length,
    seconds: +(elapsed() / 1000).toFixed(1),
    jev_seconds: +(modelMs / 1000).toFixed(2),
    url: page.url,
    title: page.title,
    ...(args.screenshot ? { screenshot: args.screenshot } : {}),
    page_text: page.text.slice(0, 2500),
  };
  if (args.trace) writeFileSync(args.trace, JSON.stringify({ ...trace, result }));
  console.log("\n" + JSON.stringify(result, null, 2));
  process.exit(status === "done" ? 0 : 1);
}

main().catch(error => {
  console.error(`jev-browser: ${error.message}`);
  process.exit(1);
});
