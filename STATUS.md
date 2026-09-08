# Status

Round 5: picked the top unblocked task — /api/start's silent runden clamp/default
(server.js). Added an `angepasst: {angefordert, verwendet}` field to the response
and a toast in public/app.js when the caller's value was overridden. First pass
(be44ba0) had a bug the reviewer caught: omitting `runden` entirely (the
documented default-of-3 path) also set `angepasst`, showing a broken "undefined"
message. Sent back, fixed in 393fd68 (`angepasst` now requires `k.runden !==
undefined`), re-verified directly. 99/99 tests pass throughout. Task removed
from TASKS.md.

Grade: 7.0/10 (funktion 8, tests 5, robustheit 7, sicherheit 7, bedienung 8,
klarheit 7), down from 7.3 — tests dropped from 6 to 5: the grader flagged
that 393fd68 itself shipped with no test catching the bug it fixed, on top of
the standing server.js-has-zero-tests gap. New headline finding: projektPfad()
(server.js:83-90) checks WURZEL boundary on a literal path string, never
fs.realpathSync — a junction/symlink inside WURZEL pointing outside it bypasses
the guard. Unlike the mkfs gap, this one is NOT blocked by settings.json. Added
to TASKS.md near the top, above the chart backlog. Also added the grader's
oversize-body error-message finding at the bottom.

Current task (runden clamp feedback) failed review 1 time, then passed.

Next: the projektPfad realpath/symlink security gap is the top unblocked item
and matches the grader's sicherheit/robustheit findings — pick that next.

Model for next round: sonnet + high — one failed review, not two; no
architectural decision pending.
