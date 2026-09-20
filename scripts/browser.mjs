// Plumbing: a minimal Chrome DevTools Protocol client, and how to find or start a browser.
// Nothing here knows about Jev. It observes a page with core.mjs's SNAPSHOT and executes
// code-owned node ids with real mouse and keyboard events.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { SNAPSHOT, LOCATE, fingerprint } from "./core.mjs";

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const HOME = homedir();
const LOCAL = process.env.LOCALAPPDATA || join(HOME, "AppData", "Local");
const OWN_PROFILE = process.env.JEV_PROFILE || join(HOME, ".jev-browser", "chrome");

// User-data directories of the browsers a person is likely to be using. Chrome writes a
// DevToolsActivePort file there once "Allow remote debugging for this browser instance" is
// ticked at chrome://inspect/#remote-debugging. That file is how we find the live browser.
const PROFILES = {
  darwin: ["Google/Chrome", "Google/Chrome Canary", "Chromium", "Microsoft Edge", "BraveSoftware/Brave-Browser", "Arc/User Data"]
    .map(p => join(HOME, "Library/Application Support", p)),
  win32: ["Google/Chrome/User Data", "Google/Chrome SxS/User Data", "Chromium/User Data", "Microsoft/Edge/User Data", "BraveSoftware/Brave-Browser/User Data"]
    .map(p => join(LOCAL, p)),
  linux: ["google-chrome", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser"].map(p => join(HOME, ".config", p)),
}[process.platform] || [];

const BINARIES = {
  darwin: ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser", "Arc"].map(n => `/Applications/${n}.app/Contents/MacOS/${n}`),
  win32: ["Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe", "BraveSoftware/Brave-Browser/Application/brave.exe", "Chromium/Application/chrome.exe"]
    .flatMap(p => [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], LOCAL].filter(Boolean).map(base => join(base, p))),
  linux: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"].flatMap(n => [`/usr/bin/${n}`, `/snap/bin/${n}`]),
}[process.platform] || [];

function findBinary() {
  const found = [process.env.CHROME_PATH, ...BINARIES].find(path => path && existsSync(path));
  if (!found) throw new Error("No Chromium-based browser found. Install Chrome or set CHROME_PATH.");
  return found;
}

/** The WebSocket endpoint a running browser advertises in its profile, or null if none is live. */
async function liveEndpoint(profile) {
  let port, path;
  try { [port, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n").map(s => s.trim()); } catch { return null; }
  if (!port || !path) return null;
  const open = await new Promise(resolve => { // a plain TCP probe: it never counts as a debugging connection
    const socket = createConnection({ host: "127.0.0.1", port: Number(port), timeout: 400 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
  return open ? `ws://127.0.0.1:${port}${path}` : null;
}

export /** Minimal Chrome DevTools Protocol client over Node's built-in WebSocket. */
class Chrome {
  /**
   * mode: "auto"   your own browser if it allows remote debugging, else a dedicated window
   *       "yours"  your own browser, or fail with instructions
   *       "own"    a dedicated window with a persistent profile, reused across runs
   *       host:port or ws:// URL of any browser started with --remote-debugging-port
   */
  static async open(mode, { headless }) {
    if (headless) return Chrome.launch({ headless: true, profile: join(OWN_PROFILE, "..", "headless") });
    if (/^(wss?:|https?:|[\w.-]+:\d+$)/.test(mode)) return Chrome.attach(await Chrome.resolve(mode), "the browser at " + mode);
    if (mode === "auto" || mode === "yours") {
      for (const profile of PROFILES) {
        const endpoint = await liveEndpoint(profile);
        if (endpoint) return Chrome.attach(endpoint, "your browser");
      }
      if (mode === "yours") throw new Error(
        'No running browser allows remote debugging. In Chrome open chrome://inspect/#remote-debugging, ' +
        'tick "Allow remote debugging for this browser instance", then run this again.');
    }
    const endpoint = await liveEndpoint(OWN_PROFILE);
    return endpoint ? Chrome.attach(endpoint, "the Jev window", { newTab: false }) : Chrome.launch({ headless: false, profile: OWN_PROFILE });
  }

  /** host:port → ws URL, via /json/version (works for browsers started with --remote-debugging-port). */
  static async resolve(address) {
    if (/^wss?:/.test(address)) return address;
    const origin = /^https?:/.test(address) ? address : `http://${address}`;
    const version = await (await fetch(new URL("/json/version", origin))).json();
    const endpoint = new URL(version.webSocketDebuggerUrl);
    endpoint.host = new URL(origin).host; // the browser reports localhost; keep the address we reached it on
    return endpoint.href;
  }

  /** Start a browser on a profile of our own and wait for it to advertise its endpoint. */
  static async launch({ headless, profile }) {
    mkdirSync(profile, { recursive: true });
    rmSync(join(profile, "DevToolsActivePort"), { force: true }); // never trust a file left by a crashed run
    const flags = [
      "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1200,860",
      "--no-first-run", "--no-default-browser-check", "--disable-features=Translate", "--disable-sync",
      ...(headless ? ["--headless=new"] : []),
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), // Chrome refuses to sandbox as root
      "about:blank",
    ];
    const child = spawn(findBinary(), flags, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    const deadline = Date.now() + 20000;
    let endpoint = null;
    while (!endpoint && Date.now() < deadline) {
      endpoint = await liveEndpoint(profile);
      if (!endpoint) await sleep(50);
    }
    if (!endpoint) throw new Error("The browser did not start in 20 seconds.");
    const chrome = new Chrome({ owned: true, profile, headless });
    await chrome.connect(endpoint, { newTab: false });
    return chrome;
  }

  /** Attach to a running browser and open a tab of our own in it. */
  static async attach(endpoint, description, { newTab = true } = {}) {
    const chrome = new Chrome({ owned: !newTab });
    if (process.env.JEV_DEBUG) console.error(`   browser: ${description} (${endpoint})`);
    await chrome.connect(endpoint, { newTab });
    return chrome;
  }

  constructor({ owned, profile, headless }) {
    this.owned = owned;
    this.profile = profile;
    this.headless = headless;
    this.pending = new Map();
    this.nextId = 1;
  }

  async connect(endpoint, { newTab = false } = {}) {
    this.socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      // Chrome asks the person once per connection whether to allow remote debugging.
      const hint = setTimeout(() => console.error('   Chrome is asking "Allow remote debugging?" — click Allow to continue.'), 1500);
      const giveUp = setTimeout(() => reject(new Error("The browser did not accept the connection in 2 minutes.")), 120000);
      this.socket.onopen = () => { clearTimeout(hint); clearTimeout(giveUp); resolve(); };
      this.socket.onerror = () => { clearTimeout(hint); clearTimeout(giveUp); reject(new Error("Could not connect to the browser.")); };
    });
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    };
    const { targetInfos } = await this.send("Target.getTargets", {}, null);
    const page = newTab
      ? await this.send("Target.createTarget", { url: "about:blank" }, null)
      : targetInfos.find(target => target.type === "page") ?? await this.send("Target.createTarget", { url: "about:blank" }, null);
    if (!newTab) await this.send("Target.activateTarget", { targetId: page.targetId }, null);
    this.targetId = page.targetId;
    this.session = (await this.send("Target.attachToTarget", { targetId: page.targetId, flatten: true }, null)).sessionId;
    await this.send("Page.enable");
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true }); // keep rendering if the tab is not in front
  }

  send(method, params = {}, sessionId = this.session) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** Evaluate in the page. Returns undefined while the document is navigating. */
  async evaluate(expression) {
    try {
      const response = await this.send("Runtime.evaluate", { expression, returnByValue: true });
      return response.exceptionDetails ? undefined : response.result.value;
    } catch {
      return undefined;
    }
  }

  /** Wait for the DOM to be usable; give slow subresources a short grace period, not a veto. */
  async settle() {
    await sleep(80);
    let grace = 12;
    for (let i = 0; i < 150; i++) {
      const state = await this.evaluate("document.readyState");
      if (state === "complete" || (state === "interactive" && --grace < 0)) break;
      await sleep(100);
    }
    await sleep(100);
  }

  async goto(url) {
    await this.send("Page.navigate", { url });
    await this.settle();
  }

  /** Read the page, then read it again a beat later: act on a page that has stopped changing. */
  async observe() {
    let previous = null;
    for (let i = 0; i < 40; i++) {
      const page = await this.evaluate(SNAPSHOT);
      if (page && previous && fingerprint(page) === fingerprint(previous)) return page;
      previous = page;
      await sleep(page ? 120 : 100);
    }
    if (previous) return previous;
    throw new Error("Page did not become readable");
  }

  async locate(node, note) {
    return this.evaluate(`${LOCATE}(${Number(node)}, ${JSON.stringify(note)})`);
  }

  async click({ x, y }) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
  }

  async type(node, text) {
    await this.evaluate(`(e => e.select ? e.select() : document.execCommand('selectAll'))(window.__jev.nodes.get(${Number(node)}))`);
    await this.send("Input.insertText", { text });
  }

  async select(node, value) {
    return this.evaluate(`((e, value) => {
      if (e?.tagName !== 'SELECT' || ![...e.options].some(o => o.value === value && !o.disabled)) return false;
      e.value = value;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })(window.__jev.nodes.get(${Number(node)}), ${JSON.stringify(value)})`);
  }

  async enter() {
    const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  }

  /** A screenshot of the viewport: a JPEG data URL by default, or PNG bytes. */
  async screenshot(format = "jpeg") {
    const { data } = await this.send("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 55 } : {}) });
    return format === "png" ? Buffer.from(data, "base64") : `data:image/jpeg;base64,${data}`;
  }

  /** Close what we opened: our window, or our tab in someone else's browser. */
  async close() {
    try {
      if (this.owned) await this.send("Browser.close", {}, null);
      else await this.send("Target.closeTarget", { targetId: this.targetId }, null);
    } catch {}
    this.socket.close();
  }
}

/** One request to Jev. Every question is a typed choice; the reply carries a probability per option. */
