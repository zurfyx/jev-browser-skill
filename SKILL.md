---
name: jev-browser
description: Drive a real browser with Jev, TypeSafe's ~100ms decision model. Give it a URL and a goal; Jev clicks, types and selects its way there while you watch, then returns the final page. Use when the user asks to use Jev, to browse or navigate a site "with Jev", or wants a fast visible browser demo (search a site, fill a form, open a result).
---

# Jev Browser

`scripts/jev.mjs` opens Chrome, observes the page, and asks Jev (TypeSafe's single-forward-pass
model) to choose the next operation and target. It loops until Jev answers `DONE` or `BLOCKED`.
You write the goal; Jev makes every navigation decision. If the user asks how it works, point
them at README.md and `scripts/core.mjs`, which is the whole decision logic in 250 lines.

## Run it

```bash
node <this-skill-dir>/scripts/jev.mjs \
  --url "https://en.wikipedia.org" \
  --goal "Search for Alan Turing and open his article. Done when the article is visible." \
  --text "Alan Turing"
```

Requirements: Node 22+, any Chromium-based browser, and `TYPESAFE_API_KEY` (environment, or a
`.env` file in this skill's directory). If the key is missing, ask the user for one — keys come
from https://typesafe.ai — and do not try to work around it.

## Writing a good call

- **`--goal`**: one or two plain sentences covering the whole task, ending with what "done"
  looks like on screen ("Done when search results are visible").
- **`--text`**: Jev chooses, it never generates. Pass every string the task needs typed, one
  `--text` each: search queries, names, form values. Extract them from the user's request.
  Jev decides which value goes in which field. With no `--text`, typing is not offered.
- **`--url`**: start as close to the task as you can (the site itself, not a search engine).
- `--screenshot out.png` saves the final page; `--headless` hides the window; `--close` closes
  the tab or window at the end (by default it stays open so the user can see the result);
  `--max-steps N` caps actions (default 25).
- `--browser`: `auto` (default) uses the user's own browser when it allows remote debugging,
  else a dedicated Jev window that is reused across runs. `yours` and `own` force either.

If the script prints `Chrome is asking "Allow remote debugging?"`, Chrome is showing the user a
popup; tell them to click Allow. It waits up to two minutes. If they want Jev in their own
browser and it is not being used, they tick "Allow remote debugging for this browser instance"
at chrome://inspect/#remote-debugging once.

- `--secret`: a password. It is typed only into password fields, never sent to Jev, never
  printed. Never pass a password through `--text`.

## Reading the result

Each step prints one line: operation, target, Jev's probability, Jev latency, elapsed time.

```text
 1  TYPE        textbox "Search Wikipedia" ← "Alan Turing"                  p=0.92   495ms  +8.6s
 2  CLICK       option "Alan Turing English computer scientist (1912–1954)  p=0.53   242ms  +9.2s
 3  DONE                                                                    p=1.00   197ms  +10.3s
```

Then a JSON summary: `status` (`done`, `blocked`, `max_steps`), `steps`, `seconds`,
`jev_seconds`, final `url`, `title` and visible `page_text`. Answer the user's question from
`page_text` (or the screenshot). Exit code is 0 only for `done`.

If the status is `blocked`, read the step log, then retry once with a more explicit goal or a
missing `--text` value. Report the step log and timings to the user; the speed is the point.

## Operations

`CLICK`, `TYPE`, `SELECT`, `ENTER`, `DONE`, `BLOCKED`. Only operations that are possible on the
current page are offered, and Jev can only answer with an index into the observed element table.
The whole page is observed and targets are scrolled into view, so there is no scroll operation.
Model output never becomes a selector or code.

Only the first 250 controls on a page are offered, because Jev takes at most 255 choices per
question. The step log warns when controls were skipped; if the target was among them, start
from a URL closer to it.
