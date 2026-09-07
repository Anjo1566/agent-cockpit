'use strict'

// projekte.js entscheidet, ob ein Verzeichnis ein Projekt ist, was der
// Testbefehl darin waere und was das Cockpit selbst committen darf. Die drei
// Fragen bestimmen, ob ein Lauf ueberhaupt eine Bremse hat.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const projekte = require('../lib/projekte.js')

function tempdir (praefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), praefix))
}

function git (cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Ein Repository mit einem Commit, so wie das Cockpit es erwartet. */
function repo (dateien = { 'README.md': '# test\n' }) {
  const dir = tempdir('cockpit-projekt-')
  git(dir, 'init', '-q', '-b', 'main', '.')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'commit.gpgsign', 'false')
  schreibe(dir, dateien)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '--no-verify', '-m', 'erster')
  return dir
}

function schreibe (dir, dateien) {
  for (const [rel, inhalt] of Object.entries(dateien)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, inhalt, 'utf8')
  }
}

function status (dir) {
  return git(dir, 'status', '--porcelain').trim()
}

// --- istRepo / installationsStand ----------------------------------------

test('istRepo erkennt ein Repository und ein blosses Verzeichnis', () => {
  assert.equal(projekte.istRepo(repo()), true)
  assert.equal(projekte.istRepo(tempdir('cockpit-nix-')), false)
})

test('installationsStand benennt jede fehlende Datei', () => {
  const stand = projekte.installationsStand(tempdir('cockpit-leer-'))
  assert.equal(stand.eingerichtet, false)
  for (const d of ['CLAUDE.md', 'round.md', 'loop.sh', 'abnahme.sh', '.agents/', '.claude/', 'TASKS.md']) {
    assert.ok(stand.fehlt.includes(d), `${d} fehlt in der Liste`)
  }
})

// --- details --------------------------------------------------------------

test('details meldet Branch, Sauberkeit und Anzahl offener Dateien', () => {
  const dir = repo()
  const sauber = projekte.details(dir)
  assert.equal(sauber.branch, 'main')
  assert.equal(sauber.sauber, true)
  assert.equal(sauber.offeneDateien, 0)
  assert.equal(sauber.letzterCommit, 'erster')

  schreibe(dir, { 'README.md': 'geaendert\n', 'neu.txt': 'x\n' })
  const schmutzig = projekte.details(dir)
  assert.equal(schmutzig.sauber, false)
  assert.equal(schmutzig.offeneDateien, 2)
})

// --- testbefehlErkennen ---------------------------------------------------

test('testbefehlErkennen nimmt ein vorhandenes test-Skript', () => {
  const dir = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
  const t = projekte.testbefehlErkennen(dir)
  assert.equal(t.befehl, 'npm test')
  assert.equal(t.sicher, true)
})

test('testbefehlErkennen faellt nicht auf den npm-Platzhalter herein', () => {
  const dir = repo({
    'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } })
  })
  const t = projekte.testbefehlErkennen(dir)
  assert.notEqual(t.befehl, 'npm test')
  assert.equal(t.sicher, false)
})

test('testbefehlErkennen erkennt das Testwerkzeug an den Abhaengigkeiten', () => {
  const dir = repo({ 'package.json': JSON.stringify({ devDependencies: { vitest: '^1' } }) })
  assert.equal(projekte.testbefehlErkennen(dir).befehl, 'npx vitest run')
})

test('testbefehlErkennen findet Testdateien ohne jede Konfiguration', () => {
  const dir = repo({ 'package.json': '{}', 'test/a.test.js': '// leer\n' })
  const t = projekte.testbefehlErkennen(dir)
  assert.equal(t.befehl, 'node --test')
  assert.equal(t.tests, 1)
})

// Der wichtigste Fall: lieber gar kein Testbefehl als ein geratener. Ein
// falscher Befehl macht aus der einzigen mechanischen Bremse eine Attrappe.
test('testbefehlErkennen raet nicht, wenn es nichts zu erkennen gibt', () => {
  const t = projekte.testbefehlErkennen(repo({ 'package.json': '{}' }))
  assert.equal(t.befehl, null)
  assert.equal(t.sicher, false)
  assert.equal(t.tests, 0)
})

test('testbefehlErkennen ueberlebt eine kaputte package.json', () => {
  const t = projekte.testbefehlErkennen(repo({ 'package.json': '{ das ist kein json' }))
  assert.equal(t.sicher, false)
})

test('testbefehlErkennen erkennt Python, Rust und Go', () => {
  assert.equal(projekte.testbefehlErkennen(repo({ 'pyproject.toml': '', 'tests/test_a.py': '' })).befehl, 'pytest -q')
  assert.equal(projekte.testbefehlErkennen(repo({ 'Cargo.toml': '' })).befehl, 'cargo test')
  assert.equal(projekte.testbefehlErkennen(repo({ 'go.mod': '' })).befehl, 'go test ./...')
})

// --- sichere --------------------------------------------------------------

test('sichere committet die genannte Datei', () => {
  const dir = repo({ 'TASKS.md': '# Backlog\n' })
  schreibe(dir, { 'TASKS.md': '# Backlog\n\n- [ ] etwas\n' })
  assert.deepEqual(projekte.sichere(dir, ['TASKS.md'], 'Update the backlog'), { stand: 'committet' })
  assert.equal(status(dir), '')
  assert.equal(git(dir, 'log', '-1', '--format=%s').trim(), 'Update the backlog')
})

test('sichere meldet "nichts", wenn sich nichts geaendert hat', () => {
  const dir = repo({ 'TASKS.md': '# Backlog\n' })
  assert.deepEqual(projekte.sichere(dir, ['TASKS.md'], 'Update the backlog'), { stand: 'nichts' })
  assert.equal(git(dir, 'log', '--format=%s').trim().split('\n').length, 1, 'ein Leer-Commit ist entstanden')
})

test('sichere meldet "nichts" ausserhalb eines Repositories', () => {
  const dir = tempdir('cockpit-kein-repo-')
  schreibe(dir, { 'TASKS.md': 'x\n' })
  assert.deepEqual(projekte.sichere(dir, ['TASKS.md'], 'x'), { stand: 'nichts' })
})

test('sichere nimmt eine noch unversionierte Datei mit', () => {
  const dir = repo()
  schreibe(dir, { 'QUESTIONS.md': '- offen\n' })
  assert.deepEqual(projekte.sichere(dir, ['QUESTIONS.md'], 'Add questions'), { stand: 'committet' })
  assert.equal(status(dir), '')
})

// Der Grund fuer die Pfadbegrenzung: das Cockpit darf nur mitnehmen, was es
// selbst geschrieben hat. Alles andere gehoert dem Nutzer.
test('sichere laesst fremde Aenderungen liegen, auch bereitgestellte', () => {
  const dir = repo({ 'TASKS.md': '# Backlog\n', 'fremd.txt': 'alt\n' })
  schreibe(dir, {
    'TASKS.md': '# Backlog\n\n- [ ] etwas\n',
    'fremd.txt': 'neu\n',
    'unversioniert.txt': 'auch neu\n'
  })
  git(dir, 'add', 'fremd.txt')

  assert.deepEqual(projekte.sichere(dir, ['TASKS.md'], 'Update the backlog'), { stand: 'committet' })

  const offen = status(dir).split('\n').sort()
  assert.deepEqual(offen, ['?? unversioniert.txt', 'M  fremd.txt'].sort())
  const imCommit = git(dir, 'show', '--name-only', '--format=', 'HEAD').trim()
  assert.equal(imCommit, 'TASKS.md')
})

test('sichere meldet einen Fehler, wenn git nicht committen kann', () => {
  const dir = repo({ 'TASKS.md': '# Backlog\n' })
  // Leere Identitaet: derselbe Fall wie ein frisch eingerichteter Rechner.
  // --unset genuegt nicht, git faellt dann auf die globale Konfiguration zurueck.
  git(dir, 'config', 'user.name', '')
  git(dir, 'config', 'user.email', '')
  schreibe(dir, { 'TASKS.md': 'geaendert\n' })

  const ergebnis = projekte.sichere(dir, ['TASKS.md'], 'Update the backlog')
  assert.equal(ergebnis.stand, 'fehler')
  assert.match(ergebnis.grund, /user\.name/)
  assert.notEqual(status(dir), '', 'die Aenderung ist trotz Fehler verschwunden')
})

// --- anlegen: Namenspruefung ---------------------------------------------

for (const name of ['', '   ', '../flucht', 'mit/schraegstrich', 'mit\\backslash',
  '.versteckt', 'zu' + 'x'.repeat(70), 'mit leerzeichen', 'a;rm -rf /']) {
  test(`anlegen weist den Namen ${JSON.stringify(name)} zurueck`, () => {
    const wurzel = tempdir('cockpit-wurzel-')
    assert.throws(() => projekte.anlegen(wurzel, name, tempdir('cockpit-scaffold-')))
    assert.deepEqual(fs.readdirSync(wurzel), [], 'es ist trotzdem etwas angelegt worden')
  })
}

test('anlegen weist einen Namen zurueck, den es schon gibt', () => {
  const wurzel = tempdir('cockpit-wurzel-')
  fs.mkdirSync(path.join(wurzel, 'da'))
  assert.throws(() => projekte.anlegen(wurzel, 'da', tempdir('cockpit-scaffold-')), /gibt es hier schon/)
})

test('anlegen laesst nichts Halbfertiges zurueck, wenn die Installation scheitert', () => {
  const wurzel = tempdir('cockpit-wurzel-')
  // Ein Scaffold ohne loop.sh: installiere() wirft, und anlegen muss aufraeumen.
  assert.throws(() => projekte.anlegen(wurzel, 'neu', tempdir('cockpit-scaffold-')), /loop\.sh/)
  assert.deepEqual(fs.readdirSync(wurzel), [], 'der halbe Ordner ist liegengeblieben')
})

test('sichere meldet einen Fehler, wenn git die Datei nicht bereitstellen kann', () => {
  const dir = repo({ 'TASKS.md': '# Backlog\n' })
  schreibe(dir, { 'TASKS.md': 'geaendert\n' })
  // Eine liegengebliebene Sperre ist der haeufigste Grund, warum git mitten im
  // Betrieb nichts mehr annimmt.
  fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '', 'utf8')

  const ergebnis = projekte.sichere(dir, ['TASKS.md'], 'Update the backlog')
  assert.equal(ergebnis.stand, 'fehler')
  assert.ok(ergebnis.grund, 'ein Fehler ohne Grund hilft niemandem')
})
