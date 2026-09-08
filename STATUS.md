# Status

Round 7: picked the top TASKS.md item — server.js had zero tests. Extracted
projektPfad() and koerperLesen() into lib/anfrage.js (WURZEL and the byte
limit became explicit parameters instead of module constants), rewired
server.js's 5 call sites, and added test/anfrage.test.js: 11 new tests
covering the outside-root case, the string-prefix sibling collision (the
exact bug class the real fix guards against), `..` both escaping and not,
a real symlink/junction escape, a non-repo path, and an oversized body.
110/110 tests pass (up from ~99). Reviewer: PASS, no blockers, verified the
prefix-collision test would fail against a naive startsWith() check and
confirmed no existing test file was touched. Updated two TASKS.md entries'
stale server.js line references to their new lib/anfrage.js location.

Grade: 7.3/10 (funktion 8, tests 6, robustheit 7, sicherheit 8, bedienung 8,
klarheit 7), up from 7.1. Tests climbed 4 -> 6, the metric that fell for
three straight rounds — this round's task directly targeted that gap.
Robustheit ticked down to 7 only because the grader now also lists the
CRLF/gitattributes merge issue (already tracked) alongside the WURZEL
realpath gap. One new grader finding (public/app.js has zero functional
tests) added to TASKS.md; a QUESTIONS.md note flags that jsdom would be a
new dependency conflicting with the project's declared no-dependency
constraint, and recommends testing extractable pure logic instead.

Current task (server.js test extraction) failed review 0 times.

Next: lib/anfrage.js:54's unwrapped WURZEL realpath (funktion + robustheit,
named twice by the grader now) is the clear top item. After that, the
public/app.js coverage gap per the QUESTIONS.md note.

Model for next round: sonnet + high — no repeated review failure, no
architectural decision; the default holds.
