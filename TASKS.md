# Backlog

agent-cockpit is a Node server (server.js) plus a static page (public/) that
watches an agent-loop run live. No build step, no framework, no dependencies:
the page draws its own SVG through the `el()` helper in public/app.js. Adding a
charting library is outside your decision boundary — draw the charts yourself.

Every chart needs an empty state. A run that has not started yet must show
"—", never a zero that looks like a measurement.

Run `npm test` and paste the output. There are 81 tests; existing test files
are frozen (test/lauf.test.js, test/konfig.test.js, test/projekte.test.js —
test/verbrauch.test.js is new this round and may still be extended).

- [ ] BLOCKER (review failed once): in lib/lauf.js `verbrauchZaehlen` (around line 337-360), `this.sende('verbrauch', v)` passes `v = this.zustand.verbrauch` directly. `sende()` only shallow-copies, so the nested `v.proModell` object is stored by reference in `this.verlauf`. Because per-model entries are mutated in place on every later result event, every past `verbrauch` event in `this.verlauf` retroactively shows the *current* (final) per-model totals instead of the totals true at the time it was sent. server.js replays `lauf.verlauf.slice(-120)` to clients that connect after a run has started, so a late-joining client sees corrupted history. Fix: deep-copy `proModell` before sending, e.g. `this.sende('verbrauch', { ...v, proModell: structuredClone(v.proModell) })`. Add a regression test in test/verbrauch.test.js: send two result events with modelUsage for the same model, capture the first emitted `verbrauch` event object, then assert its `proModell` snapshot still shows the totals as of the first event after the second event has been processed (i.e. it must NOT have changed). Also add a test where `usage` is present but missing an individual sub-field (e.g. `usage: { input_tokens: 5 }` with no `cache_read_input_tokens`) to confirm it defaults to 0, not NaN.
- [ ] Fix the root guard at server.js:86: `p.startsWith(path.resolve(WURZEL))` is a raw string-prefix check with no trailing separator, so a sibling directory whose name merely starts with WURZEL's name (e.g. WURZEL `.../01_Projekte` and a sibling `.../01_Projekte-evil-sibling`) passes the check. Compare against `path.resolve(WURZEL) + path.sep` (or use `path.relative` and check it doesn't start with `..`) instead. Cover it with a test once the guard lives in lib/ (see the server.js path-guard task below).
- [ ] /api/start silently substitutes or clamps an invalid `runden` value (server.js:184, `Math.max(1, Math.min(200, Number(k.runden) || 3))`) with no feedback to the caller that their input was ignored or adjusted. Tell the user when this happens.
- [ ] Show the usage in the dashboard: tokens by model with the run total, next to the cost that is already there. It replaces nothing that is currently displayed.
- [ ] Draw the grade per round as a step chart from zustand.notenband, with the target grade as a horizontal reference line. This is the chart that says whether the run is getting anywhere.
- [ ] Draw the cost per round as bars, with the run total on the axis.
- [ ] Draw the time each role held the round (chef, coder, reviewer) as a stacked bar per round, from zustand.takte and zustand.phasendauer.
- [ ] Draw the tool calls per round grouped by class — klasseVon() in lib/lauf.js already assigns bash, schreibt, liest and delegiert.
- [ ] Write a run summary to .agents/lauf-<zeitstempel>.json when a run ends: rounds, grade per round, cost, tokens, stop reason. Then load past runs in the projekt sheet, so the charts survive a page reload and a finished run can still be looked at.
- [ ] server.js is the only module without a single test. Move the path guard (projektPfad) and the request body reader into lib/ so they can be required, and cover: a path outside the root, a sibling directory whose name shares WURZEL's name as a string prefix (see the root-guard bug above), a path with .. in it, a symlinked path, and a body larger than the limit.
- [ ] installiere() in lib/projekte.js force-copies the scaffold's .gitattributes over one the project already has, silently dropping its rules. This repository lost "*.cmd text eol=crlf" that way, without which cmd.exe refuses to run cockpit.cmd at all. Merge instead of overwrite, keeping lines the project already had, and cover it with a new test.
