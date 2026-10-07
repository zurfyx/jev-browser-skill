// Pure-logic tests for the decision layer. No network, no browser, no dependencies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, readDecision, OPERATIONS } from "../scripts/core.mjs";

// A page shaped like a login form: a text field, a password field, a button, a link.
const loginPage = () => ({
  url: "https://example.com/login", title: "Login", text: "Login",
  elements: [
    { node: 1, role: "textbox", label: "username:", value: "", op: "TYPE" },
    { node: 2, role: "password", label: "password:", value: "", op: "SECRET" },
    { node: 3, role: "button", label: "log in", op: "CLICK" },
    { node: 4, role: "link", label: "Forgot?", op: "CLICK" },
  ],
});
const withDropdown = () => ({
  ...loginPage(),
  elements: [
    { node: 5, role: "dropdown", label: "Language", value: "English", op: "SELECT",
      options: [{ value: "ca", label: "Català" }, { value: "de", label: "Deutsch" }] },
  ],
});
const base = { goal: "log in", texts: ["ada"], secret: "hunter2", history: [] };

test("elements are indexed from 1 and the indices are the answer keys", () => {
  const { body, targets } = buildRequest({ ...base, page: loginPage() });
  assert.deepEqual(body.state.elements.map(e => e.index), ["1", "2", "3", "4"]);
  assert.deepEqual(Object.keys(targets.CLICK), ["1", "3", "4"]);
});

test("only operations the page supports are offered", () => {
  const { offered } = buildRequest({ ...base, page: loginPage() });
  assert.ok(!("SELECT" in offered), "no dropdown on the page, so no SELECT");
  assert.ok(!("ENTER" in offered), "nothing was typed yet, so no ENTER");
  assert.ok(["CLICK", "TYPE", "DONE", "BLOCKED"].every(op => op in offered));
});

test("ENTER is offered only straight after a TYPE", () => {
  const after = op => buildRequest({ ...base, page: loginPage(), history: [{ operation: op }] }).offered;
  assert.ok("ENTER" in after("TYPE"));
  assert.ok(!("ENTER" in after("CLICK")));
});

test("a click tried twice on the same URL is not offered again", () => {
  const click = (url = "https://example.com/login") => ({ operation: "CLICK", target: 'link "Forgot?"', url });
  const offeredClicks = history => Object.keys(buildRequest({ ...base, page: loginPage(), history }).targets.CLICK);
  assert.ok(offeredClicks([click()]).includes("4"), "one try is not a loop");
  assert.ok(!offeredClicks([click(), click()]).includes("4"));
  assert.ok(offeredClicks([click(), click("https://example.com/other")]).includes("4"), "tries elsewhere do not count");
});

test("each target head holds only elements that operation can act on", () => {
  const { targets } = buildRequest({ ...base, page: loginPage() });
  // a text field is clickable too: clicking focuses it or opens its autocomplete
  assert.deepEqual(Object.keys(targets.CLICK).sort(), ["1", "3", "4"]);
  assert.deepEqual(Object.keys(targets.TYPE).sort(), ["1", "2"], "editable fields only");
  assert.ok(!("2" in targets.CLICK), "a password field is never a click target");
});

test("a dropdown expands to one choice per option, keyed element:option", () => {
  const { targets, offered } = buildRequest({ ...base, page: withDropdown() });
  assert.ok("SELECT" in offered);
  assert.deepEqual(Object.keys(targets.SELECT), ["1:1", "1:2"]);
  assert.equal(targets.SELECT["1:1"].option.label, "Català");
});

test("the secret never appears anywhere in the request", () => {
  const { body } = buildRequest({ ...base, page: loginPage(), secret: "hunter2" });
  assert.ok(!JSON.stringify(body).includes("hunter2"), "a password must never be sent to Jev");
});

test("a password field is only a TYPE target when a secret was supplied", () => {
  const withSecret = buildRequest({ ...base, page: loginPage(), secret: "hunter2" });
  const without = buildRequest({ ...base, page: loginPage(), secret: "" });
  assert.ok("2" in withSecret.targets.TYPE);
  assert.ok(!("2" in without.targets.TYPE));
});

test("no text values means TYPE is not offered at all", () => {
  const { offered } = buildRequest({ ...base, page: loginPage(), texts: [], secret: "" });
  assert.ok(!("TYPE" in offered));
});

test("with nothing to type, a text field is not a click target either", () => {
  const { targets } = buildRequest({ ...base, page: loginPage(), texts: [] });
  assert.deepEqual(Object.keys(targets.CLICK), ["3", "4"]);
});

test("with nothing to type, a search form's button is not offered", () => {
  const page = loginPage();
  page.elements[2].search = true;
  assert.ok(!("3" in buildRequest({ ...base, page, texts: [] }).targets.CLICK));
  assert.ok("3" in buildRequest({ ...base, page }).targets.CLICK, "with text it submits a real query");
});

test("a link back to a page already visited is not offered", () => {
  const page = loginPage();
  page.elements[3].href = "https://example.com/home";
  const history = [{ operation: "CLICK", target: 'link "Login"', url: "https://example.com/home#top" }];
  assert.ok(!("4" in buildRequest({ ...base, page, history }).targets.CLICK));
  assert.ok("4" in buildRequest({ ...base, page }).targets.CLICK);
  const redirected = [{ operation: "CLICK", target: 'link "Home"', url: "https://example.com/x", href: "https://example.com/home" }];
  assert.ok(!("4" in buildRequest({ ...base, page, history: redirected }).targets.CLICK), "a clicked href counts even if it redirected");
});

test("repeat clicks count across #hash changes, where apps keep view state", () => {
  const page = { ...loginPage(), url: "https://example.com/login#b" };
  const click = hash => ({ operation: "CLICK", target: 'link "Forgot?"', url: `https://example.com/login#${hash}` });
  assert.ok(!("4" in buildRequest({ ...base, page, history: [click("a"), click("b")] }).targets.CLICK));
});

test("internal hints never reach Jev", () => {
  const page = loginPage();
  Object.assign(page.elements[3], { search: true, href: "https://example.com/" });
  const sent = buildRequest({ ...base, page }).body.state.elements[3];
  assert.ok(!("search" in sent) && !("href" in sent));
});

test("readDecision reads the head matching the operation and ignores the rest", () => {
  const req = buildRequest({ ...base, page: loginPage() });
  const d = readDecision({
    operation: { choice: "CLICK", probabilities: { CLICK: 0.9, TYPE: 0.1 } },
    click_target: { choice: "3", probabilities: { 3: 0.8, 4: 0.2 } },
    type_target: { choice: "1", probabilities: { 1: 0.7, 2: 0.3 } },
  }, req);
  assert.equal(d.operation, "CLICK");
  assert.equal(d.e.label, "log in", "the click head decided the target");
});

test("an answer outside the offered set throws and yields no action", () => {
  const req = buildRequest({ ...base, page: loginPage() });
  assert.throws(() => readDecision({ operation: { choice: "LAUNCH_MISSILES", probabilities: {} } }, req), /outside the offered choices/);
  assert.throws(() => readDecision({
    operation: { choice: "CLICK", probabilities: { CLICK: 1 } },
    click_target: { choice: "99", probabilities: { 99: 1 } },
  }, req), /outside the offered choices/);
});

test("confidence is the weaker of the operation and its target", () => {
  const req = buildRequest({ ...base, page: loginPage() });
  const d = readDecision({
    operation: { choice: "CLICK", probabilities: { CLICK: 0.9 } },
    click_target: { choice: "3", probabilities: { 3: 0.4, 4: 0.6 } },
  }, req);
  assert.equal(d.p, 0.4);
});

test("a terminal answer carries no target", () => {
  const req = buildRequest({ ...base, page: loginPage() });
  for (const op of ["DONE", "BLOCKED"]) {
    const d = readDecision({ operation: { choice: op, probabilities: { [op]: 1 } } }, req);
    assert.equal(d.operation, op);
    assert.equal(d.e, undefined);
    assert.ok(OPERATIONS[op], "every terminal operation is described to Jev");
  }
});

test("WAIT is always offered and carries no target, even on a blank page", () => {
  const blank = { url: "https://example.com/", title: "", text: "", elements: [] };
  const req = buildRequest({ ...base, page: blank });
  assert.deepEqual(Object.keys(req.offered).sort(), ["BLOCKED", "DONE", "WAIT"]);
  const d = readDecision({ operation: { choice: "WAIT", probabilities: { WAIT: 0.9 } } }, req);
  assert.equal(d.operation, "WAIT");
  assert.equal(d.e, undefined);
});

test("every offered operation ships a description for Jev to choose on", () => {
  const { body, offered } = buildRequest({ ...base, page: withDropdown() });
  for (const [op, text] of Object.entries(body.questions.operation.criteria)) {
    assert.equal(typeof text, "string");
    assert.ok(text.length > 10, `${op} needs a real description`);
  }
  assert.deepEqual(Object.keys(body.questions.operation.criteria), Object.keys(offered));
});
