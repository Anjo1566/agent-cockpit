# Backlog

agent-cockpit is a Node server (server.js) plus a static page (public/) that
watches an agent-loop run live. No build step, no framework, no dependencies:
the page draws its own SVG through the `el()` helper in public/app.js. Adding a
charting library is outside your decision boundary — draw the charts yourself.

Every chart needs an empty state. A run that has not started yet must show
"—", never a zero that looks like a measurement.

Run `npm test` and paste the output. There are 76 tests; existing test files
are frozen.

- [ ] Read the token usage out of the round result event in lib/lauf.js: input, output, cache-read and cache-creation tokens, and per model wherever the event carries that breakdown. Keep the running total for the whole run in zustand.verbrauch and send it as a `verbrauch` event. Cover it with a new test file, including a result event that carries no usage field at all.
- [ ] Show the usage in the dashboard: tokens by model with the run total, next to the cost that is already there. It replaces nothing that is currently displayed.
- [ ] Draw the grade per round as a step chart from zustand.notenband, with the target grade as a horizontal reference line. This is the chart that says whether the run is getting anywhere.
- [ ] Draw the cost per round as bars, with the run total on the axis.
- [ ] Draw the time each role held the round (chef, coder, reviewer) as a stacked bar per round, from zustand.takte and zustand.phasendauer.
- [ ] Draw the tool calls per round grouped by class — klasseVon() in lib/lauf.js already assigns bash, schreibt, liest and delegiert.
- [ ] Write a run summary to .agents/lauf-<zeitstempel>.json when a run ends: rounds, grade per round, cost, tokens, stop reason. Then load past runs in the projekt sheet, so the charts survive a page reload and a finished run can still be looked at.
- [ ] server.js is the only module without a single test. Move the path guard (projektPfad) and the request body reader into lib/ so they can be required, and cover: a path outside the root, a path with .. in it, a symlinked path, and a body larger than the limit.
- [ ] installiere() in lib/projekte.js force-copies the scaffold's .gitattributes over one the project already has, silently dropping its rules. This repository lost "*.cmd text eol=crlf" that way, without which cmd.exe refuses to run cockpit.cmd at all. Merge instead of overwrite, keeping lines the project already had, and cover it with a new test.
