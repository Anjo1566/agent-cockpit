# Status

Round 2 committed the proModell aliasing fix (e153e29) and passed review. Then
the run died: the grader started the server to check it, tidied up with
`taskkill //F //IM node.exe //T`, and that matched the cockpit server — the
ancestor of this very run (server.js spawns bash, bash runs loop.sh, loop.sh
runs claude). `//T` took the whole subtree down with it. No stop-reason.txt,
event stream cut mid tool call, loop.sh hung four hours on a dead child, and
the dashboard showed LIVE the whole time.

Fixed outside the loop, because the loop could not have fixed it from inside:
guard-bash.sh now blocks killing processes as a class (section 2); loop.sh has
a watchdog that ends a round whose event stream stands still (MAX_STILLE) or
that overruns MAX_RUNDE, killing by PID, never by image name; lauf.js knows the
grader, so its time no longer lands on the reviewer's clock; the page tells a
dead line from a live one (VERBINDUNG WEG / GETRENNT) and stops calling four
hours of silence "denkt". 96 tests green, 13 of them new in
test/selbstschutz.test.js, each verified to fail against the old code.

Current task (none) has failed review 0 times.

Next: work the grader's list from .agents/grade.json, starting with the WURZEL
prefix guard in server.js. The new mkfs.ext4 task is small and can go first.

Model for next round: sonnet + high — nothing here is architectural.
