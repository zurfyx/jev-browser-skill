// The explainer. Replay mode steps through a --trace file. Live mode runs the same loop as the
// skill inside a sandboxed iframe, using scripts/core.mjs unchanged and /api/jev for the request.
import { SNAPSHOT, LOCATE, OPERATIONS, decide, fingerprint } from "/scripts/core.mjs";
import { samples } from "/site/samples.js";

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pulseTimer;
function pulse() { const b = $("board"); b.classList.remove("pulse"); void b.offsetWidth; b.classList.add("pulse"); clearTimeout(pulseTimer); pulseTimer = setTimeout(() => b.classList.remove("pulse"), 1400); }
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const PRICE_PER_TOKEN = 0.042 / 1e6; // Jev list price for input; output is free
const money = n => n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(3)}`;

let mode = "replay";
let steps = [], current = -1, trace = null;      // replay
let live = null;                                 // live state: { page, decision, history, iframe }

// ---------- rendering one step (shared by both modes) ----------

function renderStep(step, { liveFrame = false } = {}) {
  const { page, calls, decision } = step;
  const body = calls[0].body, answers = calls[0].answers;
  const chosenIndex = decision.target?.match(/^\[(\d+)\]/)?.[1];

  // page column
  $("page-url").textContent = page.url.startsWith("blob:") ? `sample page ${new URL(page.url).hash}` : page.url;
  if (!liveFrame) {
    $("frame").innerHTML = page.screenshot ? `<img src="${page.screenshot}" alt="the page at this step">` : `<div class="empty">no screenshot in this trace</div>`;
    if (page.viewport) $("frame").style.aspectRatio = `${page.viewport.w} / ${page.viewport.h}`;
  }
  pulse();
  document.querySelectorAll("#frame .mark").forEach(m => m.remove());
  const chosen = page.elements.find(e => e.index === chosenIndex);
  if (chosen?.rect && page.viewport) {
    const box = $("frame").getBoundingClientRect();
    const sx = box.width / page.viewport.w, sy = box.height / page.viewport.h;
    const mark = document.createElement("div");
    mark.className = "mark";
    mark.style.cssText = `left:${chosen.rect.x * sx - 3}px;top:${chosen.rect.y * sy - 3}px;width:${chosen.rect.w * sx + 2}px;height:${chosen.rect.h * sy + 2}px`;
    mark.innerHTML = `<span>Jev · ${esc(decision.operation)} · ${Math.round(decision.p * 100)}%</span>`;
    $("frame").append(mark);
  }
  const belowFold = chosen?.rect && page.viewport && (chosen.rect.y > page.viewport.h || chosen.rect.y + chosen.rect.h < 0);
  $("page-note").textContent = (belowFold ? "The target is outside the screenshot; the skill scrolled it into view before acting. " : "") + (page.omitted ? `${page.omitted} controls beyond the first 250 were not offered (Jev takes at most 255 options per question).` : `${page.elements.length} controls observed, ${page.text.length} characters of visible text.`);

  // code column
  $("table-count").textContent = `${page.elements.length} rows`;
  const headUsed = `${decision.operation.toLowerCase()}_target`;
  const candidates = body.questions[headUsed]?.criteria || {};
  $("table").innerHTML = page.elements.map(e => {
    const cls = e.index === chosenIndex ? "chosen" : (e.index in candidates ? "hot" : "");
    const value = e.value !== undefined && e.value !== "" ? `<span class="val">= ${esc(JSON.stringify(e.value))}</span>` : "";
    const ops = e.op === "SECRET" ? "TYPE (secret)" : e.op === "SELECT" ? `SELECT ×${e.options?.length ?? 0}` : e.op === "TYPE" ? "TYPE · CLICK" : e.op;
    return `<div class="row ${cls}"><span class="idx">[${e.index}]</span><span>${esc(e.role)}</span><span>${esc(e.label)} ${value}</span><span class="ops">${ops}</span></div>`;
  }).join("");
  { const t = $("table"), r = t.querySelector(".row.chosen"); if (r) t.scrollTop = r.offsetTop - t.clientHeight / 2 + r.offsetHeight / 2; } // scroll the table, never the page
  const st = body.state;
  $("extras").innerHTML = [ // the goal and the page text are in the verbatim request below; here only what changes per step
    `text_values: <code>${esc(JSON.stringify(st.text_values))}</code>${step.secretOffered ? " <span class=\"muted\">+ a secret, password fields only, never sent</span>" : ""}`,
    `recent_actions (${st.recent_actions.length}): <code>${esc(st.recent_actions.slice(-3).map(a => `${a.operation} ${a.target ?? ""}`).join(" → ") || "none yet")}</code>`,
    `questions in this request: <code>${Object.keys(body.questions).join(", ")}</code>`,
  ].join("<br>");
  $("request").textContent = JSON.stringify(body, null, 2);

  // jev column
  const heads = Object.entries(answers).map(([name, a]) => {
    const used = name === "operation" || name === headUsed;
    const criteria = body.questions[name]?.criteria || {};
    const sorted = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
    const shown = sorted.slice(0, 8), rest = sorted.length - shown.length;
    const bars = shown.map(([k, p], i) => {
      const label = name === "operation" ? k : `[${k}] ${criteria[k]?.element?.replace(/^\[\d+\]\s*/, "") ?? ""}${criteria[k]?.option ? ` → ${criteria[k].option}` : ""}`;
      return `<div class="bar ${i === 0 ? "top" : ""}"><span class="lab" title="${esc(label)}">${esc(label)}</span><span class="track"><span class="fill" style="width:${Math.max(1, p * 100)}%"></span></span><span class="p">${p.toFixed(2)}</span></div>`;
    }).join("") + (rest > 0 ? `<div class="bar"><span class="lab muted">… and ${rest} more, all below ${Math.max(...sorted.slice(8).map(x => x[1])).toFixed(2)}</span><span></span><span></span></div>` : "");
    const tag = name === "operation" ? "decides which head to read" : used ? "read, because the operation matched" : "discarded";
    return `<div class="q ${used ? "used" : "discarded"}"><div class="qname"><span>${esc(name)}</span><span class="tag2">${tag}</span></div>${bars}</div>`;
  });
  if (calls[1]) {
    const a = calls[1].answers.value, values = calls[1].body.questions.value.criteria;
    heads.push(`<div class="q used"><div class="qname"><span>value</span><span class="tag2">second request: which text value belongs in the chosen field</span></div>${
      Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).map(([k, p], i) => `<div class="bar ${i === 0 ? "top" : ""}"><span class="lab">${esc(values[k])}</span><span class="track"><span class="fill" style="width:${Math.max(1, p * 100)}%"></span></span><span class="p">${p.toFixed(2)}</span></div>`).join("")}</div>`);
  }
  $("answers").innerHTML = heads.join("");
  const what = decision.target ? `${decision.operation} → ${decision.target}${decision.option ? ` → "${decision.option}"` : ""}${decision.text ? ` ← "${decision.text}"` : ""}` : decision.operation;
  const why = decision.operation in { DONE: 1, BLOCKED: 1 } ? OPERATIONS[decision.operation]
    : decision.operation === "ENTER" ? "no target needed: Enter goes to the field just typed into"
    : (headUsed in answers ? `read ${headUsed} only` : `only one ${decision.operation} candidate, so no ${headUsed} question was needed`) +
      `; ${Object.keys(answers).filter(n => n !== "operation" && n !== headUsed).join(", ") || "nothing"} discarded`;
  $("decision").innerHTML = `${esc(what)}<small>${esc(why)}</small>`;
  const tokens = calls.reduce((n, c) => n + (c.usage?.input_tokens ?? 0), 0);
  $("meta").textContent = `${decision.ms} ms in Jev` + (tokens ? ` · ${tokens.toLocaleString()} input tokens · ${money(tokens * PRICE_PER_TOKEN)}` : "") + (step.elapsed_ms != null ? ` · ${(step.elapsed_ms / 1000).toFixed(1)}s into the run` : "");
  $("answers-raw").textContent = JSON.stringify(calls.map(c => c.answers), null, 2);
}

function renderSteps(list, active, onPick) {
  $("steps").innerHTML = list.map((s, i) => `<button class="step ${i === active ? "active" : ""}" data-i="${i}">${i + 1} ${esc(s.decision.operation)}</button>`).join("");
  $("steps").querySelectorAll(".step").forEach(b => (b.onclick = () => onPick(Number(b.dataset.i))));
}

// ---------- replay ----------

// The URL carries the run and the step, so any step of a shipped trace can be linked to:
//   #amazon-cart        the run from its first step
//   #amazon-cart/5      that run at step 5
// A dropped file has no address and leaves the URL alone.
const traceKey = path => path.split("/").pop().replace(/\.json$/, "");
const keyPath = key => [...$("trace-select").options].find(o => traceKey(o.value) === key)?.value;
function readHash() {
  const raw = decodeURIComponent(location.hash.slice(1));
  if (!raw || raw === "live") return null;
  const [key, step] = raw.split("/");
  return keyPath(key) ? { key, step: Math.max(1, Number(step) || 1) } : null;
}
function writeHash() {
  if (mode !== "replay" || !shareable) return;
  const key = traceKey($("trace-select").value);
  const next = "#" + key + (current > 0 ? `/${current + 1}` : "");
  if (location.hash !== next) history.replaceState(null, "", next);
}

let shareable = true;
let player = null;   // rAF handle while a run is playing
let pausedAt = null; // where a run was paused, so play resumes rather than restarts
let playhead = 0;    // the moment the transport is showing, in ms into the run

/** Everything the transport needs: when each decision landed, how long Jev took, what it cost. */
function timings(t) {
  let jev = 0, tokens = 0;
  const marks = t.steps.map(s => {
    jev += s.decision.ms || 0;
    tokens += s.calls.reduce((n, c) => n + (c.usage?.input_tokens ?? 0), 0);
    return { at: s.elapsed_ms ?? 0, ms: s.decision.ms || 0, jev, tokens };
  });
  return { marks, total: Math.max(1, (t.result?.seconds ?? 0) * 1000, marks.at(-1)?.at ?? 0) };
}
function drawTimeline() {
  const { marks, total } = timings(trace);
  $("timeline").querySelectorAll(".jev,.mark").forEach(e => e.remove());
  const head = $("head");
  for (const m of marks) {
    const tick = document.createElement("div");
    tick.className = "mark"; tick.style.left = `${(m.at / total) * 100}%`;
    const jev = document.createElement("div");
    // Jev's share of the run, drawn to scale: the decision ends where the step lands
    jev.className = "jev";
    jev.style.left = `${(Math.max(0, m.at - m.ms) / total) * 100}%`;
    jev.style.width = `${Math.max(0.35, (m.ms / total) * 100)}%`;
    $("timeline").append(tick, jev);
  }
  $("timeline").append(head);
}
/** The readout at a given moment of the run. */
function readout(ms) {
  const { marks, total } = timings(trace);
  const done = marks.filter(m => m.at <= ms).at(-1);
  const jev = done?.jev ?? 0, tokens = done?.tokens ?? 0;
  $("readout").innerHTML = `${(Math.min(ms, total) / 1000).toFixed(1)}s / ${(total / 1000).toFixed(1)}s · <b>${(jev / 1000).toFixed(2)}s in Jev</b> · ${tokens.toLocaleString()} tokens · ${money(tokens * PRICE_PER_TOKEN)}`;
  $("head").style.transform = `translateX(${(Math.min(ms, total) / total) * $("timeline").clientWidth}px)`;
}
function stopPlay({ keepPosition = false } = {}) {
  if (player) cancelAnimationFrame(player);
  player = null;
  if (!keepPosition) pausedAt = null;
  $("play").removeAttribute("data-playing");
}
function play() {
  if (player) { pausedAt = playhead; return stopPlay({ keepPosition: true }); } // a second press pauses
  const { marks, total } = timings(trace);
  const from = pausedAt ?? 0; // a run always plays from its start unless it was paused mid-way
  pausedAt = null;
  const t0 = performance.now() - from;
  $("play").setAttribute("data-playing", "");
  show(Math.max(0, marks.findLastIndex(m => m.at <= from)), true);
  const frame = () => {
    const ms = playhead = performance.now() - t0;
    readout(ms);
    const i = marks.findLastIndex(m => m.at <= ms);
    if (i >= 0 && i !== current) show(i, true);
    if (ms >= total) { readout(total); playhead = 0; return stopPlay(); }
    player = requestAnimationFrame(frame);
  };
  player = requestAnimationFrame(frame);
}
async function loadTrace(source, step = 1) {
  shareable = typeof source === "string";
  trace = typeof source === "string" ? await (await fetch(source)).json() : source;
  // a hand-written note per step may sit beside a shipped trace; dropped traces simply have none
  trace.notes = typeof source === "string" ? await fetch(source.replace(/\.json$/, ".notes.json")).then(r => r.ok ? r.json() : null).catch(() => null) : null;
  steps = trace.steps.map(s => ({ ...s, secretOffered: trace.secret }));
  stopPlay(); drawTimeline();
  show(step - 1);
}
function show(i, fromPlayer = false) {
  if (!fromPlayer) stopPlay(); // also clears a paused position
  current = Math.max(0, Math.min(steps.length - 1, i));
  renderStep(steps[current]);
  renderSteps(steps, current, show);
  $("prev").disabled = current === 0; $("next").disabled = current === steps.length - 1;
  const s = steps[current];
  $("replay-goal").innerHTML = `<b>Goal</b> ${esc(trace.goal)}`;
  const note = trace.notes?.[current];
  const tail = current === steps.length - 1 && trace.result ? ` Finished: ${trace.result.status} in ${trace.result.seconds}s, ${trace.result.jev_seconds}s of it inside Jev.`
    : s.executed === false ? " Not executed: the page changed first, so it was observed again." : "";
  $("counter").textContent = `${current + 1} / ${steps.length}`;
  $("status").textContent = (note ?? "") + tail;
  if (!player) readout(timings(trace).marks[current].at); // parked: show this step's moment
  writeHash();
}

// ---------- live ----------

let liveBlobUrl;
function liveFrame(html, allowScripts) {
  const iframe = document.createElement("iframe");
  iframe.sandbox = "allow-same-origin allow-forms" + (allowScripts ? " allow-scripts" : "");
  // A blob URL (not srcdoc) so the sample's own #hash links resolve to the frame, never the parent site.
  if (liveBlobUrl) URL.revokeObjectURL(liveBlobUrl);
  liveBlobUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  iframe.src = liveBlobUrl;
  $("frame").innerHTML = ""; $("frame").append(iframe);
  return new Promise(resolve => (iframe.onload = () => resolve(iframe)));
}
function liveReadout() {
  if (!live?.steps.length) return void ($("readout").textContent = "");
  const jev = live.steps.reduce((t, s) => t + (s.decision.ms || 0), 0);
  const tokens = live.steps.reduce((t, s) => t + s.calls.reduce((n, c) => n + (c.usage?.input_tokens ?? 0), 0), 0);
  const wall = (live.steps.at(-1).elapsed_ms || 0) / 1000;
  $("readout").innerHTML = `${wall.toFixed(1)}s so far · <b>${(jev / 1000).toFixed(2)}s in Jev</b> · ${tokens.toLocaleString()} tokens · ${money(tokens * PRICE_PER_TOKEN)}`;
}

async function liveReset() {
  const key = $("sample-select").value, sample = samples[key];
  const html = key === "custom" ? ($("custom-html")?.value || "<p>Paste some HTML above.</p>") : sample.html;
  const iframe = await liveFrame(html, key !== "custom");
  live = { iframe, history: [], steps: [], page: null, decision: null, started: performance.now() };
  ["table", "extras", "request", "answers", "decision", "meta", "answers-raw", "steps", "readout"].forEach(id => ($(id).innerHTML = ""));
  document.querySelectorAll("#frame .mark").forEach(m => m.remove());
  $("page-url").textContent = sample.title; $("page-note").textContent = ""; $("counter").textContent = "";
  live.auto = false; $("autoplay").textContent = "▶ autoplay"; $("autoplay").disabled = false; $("ask").disabled = false; $("execute").disabled = true;
  $("status").textContent = "Press “ask Jev”: the page is observed, one request is sent with your key, and the answer is shown before anything runs.";
}
const inPage = (expr) => live.iframe.contentWindow.eval(expr);
async function askLive() {
  const key = $("key").value.trim();
  if (!key) { $("status").textContent = "A TypeSafe key is needed for live mode. It stays in this browser and is sent only with your requests."; return "need-key"; }
  localStorage.setItem("typesafe_key", key);
  const texts = $("texts").value.split(",").map(s => s.trim()).filter(Boolean), secret = $("secret").value, goal = $("goal").value.trim();
  if (!goal) { $("status").textContent = "Write a goal first."; return "need-goal"; }
  $("ask").disabled = true; $("status").textContent = "Observing the page and asking Jev…";
  try {
    const page = inPage(SNAPSHOT);
    if (live.history.length) live.history.at(-1).page_changed = live.history.at(-1).fingerprint !== fingerprint(page);
    const ask = async body => {
      const started = performance.now();
      const res = await fetch("/api/jev", { method: "POST", headers: { "content-type": "application/json", "x-typesafe-key": key }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`Jev returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const { answers, usage } = await res.json();
      // the proxy reports the TypeSafe round trip; that is Jev's time, without the hop to Vercel
      const upstream = Number(res.headers.get("x-upstream-ms"));
      return { answers, usage, ms: upstream || Math.round(performance.now() - started) };
    };
    const decision = await decide(ask, { goal, page, texts, secret, history: live.history });
    const { operation, e, option, text } = decision;
    const step = { elapsed_ms: Math.round(performance.now() - live.started), page, calls: decision.calls, secretOffered: Boolean(secret),
      decision: { operation, target: e && `[${e.index}] ${e.role} "${e.label}"`, option: option?.label, text: decision.secret ? "••••••" : text, p: decision.p, ms: decision.ms }, raw: decision };
    live.steps.push(step); live.page = page; live.decision = decision; liveReadout();
    renderStep(step, { liveFrame: true });
    renderSteps(live.steps, live.steps.length - 1, i => renderStep(live.steps[i], { liveFrame: true }));
    if (operation === "DONE" || operation === "BLOCKED") { $("status").textContent = `Jev answered ${operation}. ${OPERATIONS[operation]}`; return operation; }
    $("execute").disabled = false; $("status").textContent = `Jev chose ${step.decision.target ?? operation}. Nothing has run yet — press execute to let the skill do it.`;
    return "pending";
  } catch (err) { window.__lastError = err.stack; $("status").textContent = err.message; $("ask").disabled = false; return "error"; }
}
async function executeLive() {
  const d = live.decision, w = live.iframe.contentWindow;
  $("execute").disabled = true;
  try {
    if (d.e) {
      const point = inPage(`${LOCATE}(${d.e.node}, ${JSON.stringify(`Jev · ${d.operation} · ${Math.round(d.p * 100)}%`)})`);
      if (!point) throw new Error("The element moved or disappeared since the observation. Ask again.");
      await new Promise(r => setTimeout(r, 400));
      const node = w.__jev.nodes.get(d.e.node);
      if (d.operation === "SELECT") { node.value = d.option.value; node.dispatchEvent(new w.Event("input", { bubbles: true })); node.dispatchEvent(new w.Event("change", { bubbles: true })); }
      else if (d.operation === "TYPE") { node.focus(); if ("value" in node) node.value = d.text; else node.textContent = d.text; node.dispatchEvent(new w.Event("input", { bubbles: true })); node.dispatchEvent(new w.Event("change", { bubbles: true })); live.lastTyped = node; }
      else node.click();
    } else if (d.operation === "ENTER") {
      const node = live.lastTyped; node?.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); node?.form?.requestSubmit();
    }
    live.history.push({ operation: d.operation, target: d.e && `${d.e.role} "${d.e.label}"`, text: d.secret ? "••••••" : d.text, url: live.page.url, fingerprint: fingerprint(live.page) });
    await new Promise(r => setTimeout(r, 500));
    $("ask").disabled = false; $("status").textContent = "Executed by the skill. Ask Jev for the next step.";
    return "ok";
  } catch (err) { window.__lastError = err.stack; $("status").textContent = err.message; $("ask").disabled = false; return "error"; }
}

// Run ask → execute to the end so the speed is visible. Each Jev call is a few hundred ms.
async function autoplay() {
  if (!$("key").value.trim()) { $("status").textContent = "Enter a TypeSafe key first, then autoplay."; return; }
  live.auto = true;
  for (const b of ["ask", "execute", "autoplay", "reset"]) $(b).disabled = true;
  $("autoplay").textContent = "■ stop"; $("autoplay").disabled = false;
  const started = performance.now();
  let n = 0;
  try {
    while (live.auto) {
      const dot = '<span class="live-dot"></span>';
      $("status").innerHTML = dot + `autoplaying… step ${n + 1}`;
      const r = await askLive();
      if (r !== "pending") break;              // DONE, BLOCKED, or error
      n++;
      await sleep(450);                         // let the highlight land
      if (!live.auto) break;
      const e = await executeLive();
      if (e !== "ok") break;
      await sleep(320);
    }
  } finally {
    const done = live.auto;
    live.auto = false;
    $("autoplay").textContent = "▶ autoplay";
    for (const b of ["ask", "autoplay", "reset"]) $(b).disabled = false;
    if (done && n) {
      const run = live.steps.slice(-(n + 1)); // the n executed decisions plus the final DONE/BLOCKED
      const jevMs = run.reduce((t, s) => t + (s.decision.ms || 0), 0);
      const tokens = run.reduce((t, s) => t + s.calls.reduce((c, x) => c + (x.usage?.input_tokens ?? 0), 0), 0);
      const total = ((performance.now() - started) / 1000).toFixed(1);
      $("status").innerHTML = $("status").textContent +
        ` — ${run.length} decisions in ${total}s, <b>${(jevMs / 1000).toFixed(1)}s of it inside Jev</b>` +
        (tokens ? ` · ${tokens.toLocaleString()} tokens · <b>${money(tokens * PRICE_PER_TOKEN)}</b>` : "") + ".";
    }
  }
}

// ---------- wiring ----------

function setMode(m) {
  mode = m;
  document.querySelectorAll(".mode").forEach(b => b.classList.toggle("active", b.dataset.mode === m));
  document.querySelectorAll(".only-replay").forEach(el => (el.hidden = m !== "replay"));
  document.querySelectorAll(".only-live").forEach(el => (el.hidden = m !== "live"));
  $("prev").hidden = $("next").hidden = m !== "replay";
  if (m === "live") { stopPlay(); history.replaceState(null, "", "#live"); liveReset(); }
  else show(Math.max(0, current)); // show() restores this run's address
}
document.querySelectorAll(".mode").forEach(b => (b.onclick = () => setMode(b.dataset.mode)));
$("prev").onclick = () => show(current - 1); $("next").onclick = () => show(current + 1);
$("play").onclick = play;
addEventListener("resize", () => { if (!player) readout(timings(trace).marks[current].at); });
document.addEventListener("keydown", e => { if (mode === "replay" && e.key === "ArrowRight") show(current + 1); if (mode === "replay" && e.key === "ArrowLeft") show(current - 1); });
$("copy-request").onclick = e => { e.preventDefault(); navigator.clipboard.writeText($("request").textContent); e.target.textContent = "copied"; setTimeout(() => (e.target.textContent = "copy"), 1200); };
$("trace-select").onchange = e => loadTrace(e.target.value);
const drop = $("drop");
drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = async e => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) loadTrace(JSON.parse(await f.text())); };
document.body.ondragover = e => e.preventDefault(); document.body.ondrop = drop.ondrop;

$("sample-select").innerHTML = Object.entries(samples).map(([k, s]) => `<option value="${k}">${esc(s.title)}</option>`).join("");
function fillSample() {
  const s = samples[$("sample-select").value];
  $("goal").value = s.goal; $("texts").value = s.texts; $("secret").value = s.secret;
  let ta = $("custom-html");
  if ($("sample-select").value === "custom") {
    if (!ta) { ta = document.createElement("textarea"); ta.id = "custom-html"; ta.rows = 6; ta.placeholder = "<form>…</form>"; ta.style.cssText = "width:100%;font:12px ui-monospace,monospace"; $("controls").append(ta); ta.onchange = liveReset; }
  } else ta?.remove();
}
$("sample-select").onchange = () => { fillSample(); if (mode === "live") liveReset(); };
fillSample();
$("key").value = localStorage.getItem("typesafe_key") || "";
$("ask").onclick = askLive; $("execute").onclick = executeLive; $("reset").onclick = liveReset;
$("autoplay").onclick = () => { if (live?.auto) { live.auto = false; } else autoplay(); };

// Theme: an explicit choice wins and persists; otherwise follow the system.
const themeBtn = $("theme");
const syncTheme = () => {
  const explicit = document.documentElement.dataset.theme;
  const dark = explicit ? explicit === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  themeBtn.setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} theme`);
};
themeBtn.onclick = () => {
  const explicit = document.documentElement.dataset.theme;
  const dark = explicit ? explicit === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch {}
  syncTheme();
};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncTheme);
syncTheme();

// Startup: always fetch the default trace so replay is ready, then show the mode from the URL.
const startLive = location.hash === "#live"; // read before loading a trace rewrites the address
const linked = readHash();
if (linked) $("trace-select").value = keyPath(linked.key);
await loadTrace($("trace-select").value, linked?.step ?? 1);
if (startLive) setMode("live");

// following a link to another step of the same page, or the browser's back button
addEventListener("hashchange", () => {
  if (location.hash === "#live") return void (mode !== "live" && setMode("live"));
  const target = readHash();
  if (!target) return;
  if (mode !== "replay") setMode("replay");
  if (traceKey($("trace-select").value) !== target.key) { $("trace-select").value = keyPath(target.key); loadTrace($("trace-select").value, target.step); }
  else if (target.step - 1 !== current) show(target.step - 1);
});
