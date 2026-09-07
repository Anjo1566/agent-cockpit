# Status

Round 1: implemented token-usage tracking in lib/lauf.js (zustand.verbrauch,
`verbrauch` event, test/verbrauch.test.js, 81 tests green). Review FAILED: a
shared-reference bug lets `proModell` mutate in place inside already-sent
`verbrauch` events stored in `this.verlauf`, corrupting SSE replay history for
late-joining clients. Not fixed this round — recorded as the top blocker in
TASKS.md instead of being force-fixed outside the one-task-per-round rule.

Grade: 6.6/10 (target 8.5). funktion 7, tests 5, robustheit 5, sicherheit 9,
bedienung 8, klarheit 8. Grader independently found and verified the same
proModell bug, plus a WURZEL prefix-check bypass in server.js and the known
.gitattributes-overwrite bug — both now queued in TASKS.md.

Current task (fix proModell reference bug) has failed review 1 time.

Next: fix the blocker first, then work down the grader's new-steps list
(WURZEL guard, .gitattributes merge, server.js path-guard tests, runden
feedback) before touching the dashboard/chart backlog.

Model for next round: sonnet + high — only one review failure so far, opus is
reserved for a second failure on the same task or an architectural call.
