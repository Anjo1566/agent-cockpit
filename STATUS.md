# Status

Round 8: picked the top actionable item (guard-bash.sh mkfs fix stays blocked,
needs a human per QUESTIONS.md). Wrapped lib/anfrage.js's WURZEL
fs.realpathSync() in its own try/catch (projektPfad()), throwing a distinct
'Wurzelverzeichnis des Servers nicht erreichbar.' instead of leaking a raw
ENOENT. Coder discovered guard-files.sh blocks edits to any git-tracked test
file, not just a hardcoded frozen list, so test/anfrage.test.js (added last
round) was also protected -- added test/anfrage-wurzel.test.js instead.
Reviewer: PASS, no blockers, verified the new tests are not vacuous and no
existing/frozen file was touched; flagged one minor finding (helper-code
duplication between the two anfrage test files, unavoidable under the guard)
added to TASKS.md. 112/112 tests pass.

Grade: 6.8/10 (funktion 8, tests 6, robustheit 6, sicherheit 7, bedienung 6,
klarheit 7), down from 7.3. The drop is one real finding, not noise: the
grader live-tested a >1e6-byte POST against a running server and got a raw
ECONNRESET instead of the 400 JSON the "Zu gross." error appears to promise
-- koerperLesen() calls anfrage.destroy() before the rejection can be turned
into a response. This was invisible to all 112 green tests because
test/anfrage.test.js fakes destroy() as a no-op. Added as the new top
non-blocked task, plus a task for a real-socket test to catch this class of
bug. Three more grader next-steps (app.js DOM tests, gitattributes assert
tightening, installiere() breakup) were already tracked, so skipped as
duplicates.

Current task (WURZEL realpath fix) failed review 0 times.

Next: the ECONNRESET bug in koerperLesen() is the clear top item -- it is a
real behavioral defect a live server test caught that the test suite missed,
touching three graded categories at once. After that, the real-socket test
to close the coverage gap that let it hide.

Model for next round: sonnet + high -- no repeated review failure, and this
is a well-scoped one-file bug fix, not an architectural decision.
