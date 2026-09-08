# Backlog

agent-cockpit is a Node server (server.js) plus a static page (public/) that
watches an agent-loop run live. No build step, no framework, no dependencies:
the page draws its own SVG through the `el()` helper in public/app.js. Adding a
charting library is outside your decision boundary — draw the charts yourself.

Every chart needs an empty state. A run that has not started yet must show
"—", never a zero that looks like a measurement.

Run `npm test` and paste the output. There are 96 tests; existing test files
are frozen (test/lauf.test.js, test/konfig.test.js, test/projekte.test.js,
test/verbrauch.test.js, test/verbrauch-verlauf.test.js, test/selbstschutz.test.js).

Do not stop a process you started by killing it — you are yourself a `node`
process, and so is the cockpit watching this run. Start anything long-running
with its own time limit (`timeout 20 npm start`). guard-bash.sh blocks the
kill commands; a blocked command is the safeguard working, not a defect.

- [ ] guard-bash.sh: the irreversibility rule matches `mkfs` only as a whole word, so `mkfs.ext4 /dev/sda` (and every other `mkfs.<fs>` spelling, which is how the command is actually used) walks past it. Pre-existing, found while closing the self-kill hole. Widen the pattern to `mkfs(\.[a-z0-9]+)?` and cover both spellings in test/selbstschutz.test.js. BLOCKED: `.claude/settings.json` denies `Edit(./.agents/hooks/**)` to every agent, including this loop, and denies editing settings.json itself too — no agent can lift the block. See QUESTIONS.md. Needs a human to apply this one directly.
- [ ] /api/start silently substitutes or clamps an invalid `runden` value (server.js:184, `Math.max(1, Math.min(200, Number(k.runden) || 3))`) with no feedback to the caller that their input was ignored or adjusted. Tell the user when this happens.
- [ ] Show the usage in the dashboard: tokens by model with the run total, next to the cost that is already there. It replaces nothing that is currently displayed.
- [ ] Draw the grade per round as a step chart from zustand.notenband, with the target grade as a horizontal reference line. This is the chart that says whether the run is getting anywhere.
- [ ] Draw the cost per round as bars, with the run total on the axis.
- [ ] Draw the time each role held the round (chef, coder, reviewer) as a stacked bar per round, from zustand.takte and zustand.phasendauer.
- [ ] Draw the tool calls per round grouped by class — klasseVon() in lib/lauf.js already assigns bash, schreibt, liest and delegiert.
- [ ] Write a run summary to .agents/lauf-<zeitstempel>.json when a run ends: rounds, grade per round, cost, tokens, stop reason. Then load past runs in the projekt sheet, so the charts survive a page reload and a finished run can still be looked at.
- [ ] server.js is the only module without a single test. Move the path guard (projektPfad) and the request body reader into lib/ so they can be required, and cover: a path outside the root, a sibling directory whose name shares WURZEL's name as a string prefix (see the root-guard bug above), a path with .. in it, a symlinked path, and a body larger than the limit.
- [ ] Break lib/projekte.js's installiere() (~145 lines) into smaller named steps (copy scaffold, seed state files, patch .gitignore, write config, set exec bits, commit) so each concern can be read and tested on its own. Grader finding, klarheit category.
- [ ] gitattributesZusammenfuehren() in lib/projekte.js (added in 73c0c41) keeps the project's existing .gitattributes bytes as-is and appends scaffold lines with a bare `\n`. If the project's file uses CRLF, the result mixes line endings. Reviewer finding, minor: not the scenario that caused the original bug, but worth a test and a fix (e.g. detect and preserve the dominant line ending) given this whole function exists because of an eol bug.
- [ ] test/projekte-gitattributes.test.js's merge test (the one exercising the real regression) asserts with `assert.match` (substring) instead of exact string equality, so it wouldn't catch stray blank lines or wrong ordering in the merged output. Reviewer finding, minor: tighten to exact equality.
