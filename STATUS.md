# Status

Round 4: picked the top unblocked task — installiere() in lib/projekte.js
force-copied the scaffold's .gitattributes over a project's own, the same bug
that once dropped "*.cmd text eol=crlf" and broke cockpit.cmd. Added
gitattributesZusammenfuehren(): keeps every line the project already has,
appends only missing scaffold lines, plain-copies when none exists yet. Every
other SCAFFOLD/SCAFFOLD_ORDNER entry still uses the old force-copy unchanged.
Covered by a new test/projekte-gitattributes.test.js (3 tests); the frozen
test/projekte.test.js was not touched. Reviewer approved after checking the
diff, scope, and a fresh 99/99 test run. Committed as 73c0c41.

Grade: 7.3/10 (funktion 8, tests 6, robustheit 7, sicherheit 7, bedienung 8,
klarheit 8), up from 6.5. Grader's headline finding: server.js still has zero
test coverage despite holding the path-traversal guard fixed two rounds ago.
Added the grader's and reviewer's minor findings to TASKS.md (CRLF mixing in
the new merge helper, assert.match vs assert.equal in the new test); the
mkfs.ext4 guard gap and the /api/start silent-clamp task were already listed,
so nothing new was appended for those. Logged a new guard-bash.sh usability
gap in QUESTIONS.md: it can block a safe `git commit -m` if the message
contains the bare word "install" or ".gitattributes" — also unfixable from
inside (same Edit-deny as the mkfs gap).

Current task (.gitattributes merge) failed review 0 times.

Next: /api/start's silent runden-clamp is the top unblocked TASKS.md item;
server.js test coverage sits right below it and is the grader's headline
finding two rounds running — whichever the next round picks, both are
current priorities.

Model for next round: sonnet + high — no architectural decision pending nor
two failed reviews.
