'use strict'

// Der Loop war bis Zyklus 2 eine Einbahnstrasse: einrichten ja, nachziehen
// nein. Was das kostet, stand in diesem Repository selbst -- agent-cockpit lief
// acht echte Runden mit einer Guard-Fassung, die `rm -rf .agents/hooks`
// durchliess, waehrend im Scaffold nebenan laengst die gehaertete lag. Von
// aussen sah beides gleich aus.
//
// Diese Tests halten drei Zusagen fest:
//   1. Der Schutzstand eines Projekts ist ablesbar.
//   2. aktualisiere() zieht ihn nach.
//   3. Dabei bleibt die Konfiguration des Projekts stehen, und TASKS.md,
//      STATUS.md und QUESTIONS.md werden nicht angefasst.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const projekte = require('../lib/projekte.js')
const konfig = require('../lib/konfig.js')

function git (cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function tempdir (name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-' + name + '-'))
  return fs.realpathSync(d)
}

/** Ein Scaffold, das gerade genug hat, damit installiere() durchlaeuft. */
function scaffold (schutz) {
  const d = tempdir('scaffold')
  fs.mkdirSync(path.join(d, '.agents', 'hooks'), { recursive: true })
  fs.mkdirSync(path.join(d, '.claude'), { recursive: true })
  fs.mkdirSync(path.join(d, 'test'), { recursive: true })
  fs.writeFileSync(path.join(d, '.agents', 'hooks', 'protected-paths.sh'),
    `#!/usr/bin/env bash\nSCHUTZ_VERSION=${schutz}\nMUSTER_TESTS='x'\n`)
  fs.writeFileSync(path.join(d, '.agents', 'hooks', 'guard-bash.sh'),
    `#!/usr/bin/env bash\n# Fassung ${schutz}\nexit 2\n`)
  fs.writeFileSync(path.join(d, '.claude', 'settings.json'), '{"hooks":{}}\n')
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), `# Charta Fassung ${schutz}\n`)
  fs.writeFileSync(path.join(d, 'round.md'), `Runde, Fassung ${schutz}\n`)
  fs.writeFileSync(path.join(d, 'abnahme.sh'), '#!/usr/bin/env bash\nexit 0\n')
  fs.writeFileSync(path.join(d, '.gitattributes'), '* text=auto eol=lf\n')
  fs.writeFileSync(path.join(d, 'test', 'guards.test.js'), '// leer\n')
  fs.writeFileSync(path.join(d, 'test', 'guards-neu.test.js'), '// erst in Fassung 2 dabei\n')
  fs.writeFileSync(path.join(d, 'loop.sh'), [
    '#!/usr/bin/env bash',
    '# --- Vom Umsetzer auszufüllen ---------------------------------------',
    'TESTBEFEHL="node --test"',
    'TESTZAEHLER="./.agents/hooks/count-tests.sh"',
    'MAX_TURNS=60',
    'MAX_OPUS_RUNDEN=5',
    'MAX_BUDGET_USD=4',
    'MAX_LEERRUNDEN=2',
    'BASIS_BRANCH="main"',
    'ZIELNOTE=8.5',
    'MAX_STILLE=600',
    'MAX_RUNDE=3600',
    'MAX_TEST=1800',
    '# --------------------------------------------------------------------',
    `echo "Fassung ${schutz}"`,
    ''
  ].join('\n'))
  return d
}

function projekt () {
  const d = tempdir('projekt')
  git(d, 'init', '-q', '-b', 'main')
  git(d, 'config', 'user.name', 'Test')
  git(d, 'config', 'user.email', 'test@example.invalid')
  fs.mkdirSync(path.join(d, 'test'), { recursive: true })
  fs.writeFileSync(path.join(d, 'test', 'eigen.test.js'),
    "const t = require('node:test')\nt('trivial', () => {})\n")
  // Ohne package.json haelt testbefehlErkennen() ein Verzeichnis mit
  // Testdateien fuer ein Python-Projekt, und dann kommen die Guard-Tests
  // zu Recht nicht mit. Hier soll es ein Node-Projekt sein.
  fs.writeFileSync(path.join(d, 'package.json'), '{ "name": "probe", "private": true }\n')
  git(d, 'add', '-A')
  git(d, 'commit', '-qm', 'initial')
  return d
}

test('schutzVersion liest die Fassung aus protected-paths.sh', () => {
  const s = scaffold(2)
  assert.equal(projekte.schutzVersion(s), 2)
  assert.equal(projekte.schutzVersion(tempdir('leer')), null,
    'ein Verzeichnis ohne Hooks hat keine Fassung, und das ist etwas anderes als 0')
})

test('installationsStand nennt die Fassung mit', () => {
  const alt = scaffold(1)
  const p = projekt()
  projekte.installiere(p, alt)
  assert.equal(projekte.installationsStand(p).schutz, 1)
})

test('aktualisiere zieht den Schutzsatz nach', () => {
  const p = projekt()
  projekte.installiere(p, scaffold(1))
  assert.equal(projekte.schutzVersion(p), 1)

  const bericht = projekte.aktualisiere(p, scaffold(2))
  assert.equal(bericht.vonSchutz, 1)
  assert.equal(bericht.aufSchutz, 2)
  assert.equal(projekte.schutzVersion(p), 2)
  assert.match(fs.readFileSync(path.join(p, '.agents', 'hooks', 'guard-bash.sh'), 'utf8'),
    /Fassung 2/, 'der Guard selbst muss die neue Fassung sein, nicht nur die Nummer')
  assert.equal(bericht.committet, true, 'sonst bliebe das Verzeichnis unsauber und loop.sh verweigerte den Start')
})

test('aktualisiere behaelt die Konfiguration des Projekts', () => {
  const p = projekt()
  projekte.installiere(p, scaffold(1))
  konfig.schreib(p, { MAX_TURNS: 123, ZIELNOTE: 9.5, MAX_BUDGET_USD: 7 })

  projekte.aktualisiere(p, scaffold(2))

  const werte = konfig.lies(p).werte
  assert.equal(werte.MAX_TURNS, '123', 'die Turngrenze des Projekts darf das Update nicht ueberschreiben')
  assert.equal(werte.ZIELNOTE, '9.5')
  assert.equal(werte.MAX_BUDGET_USD, '7')
})

test('aktualisiere laesst Auftrag und Gedaechtnis in Ruhe', () => {
  const p = projekt()
  projekte.installiere(p, scaffold(1))
  fs.writeFileSync(path.join(p, 'TASKS.md'), '- [ ] die eine Aufgabe\n')
  fs.writeFileSync(path.join(p, 'QUESTIONS.md'), '- Etwas, das ein Mensch entscheiden muss\n')
  fs.writeFileSync(path.join(p, 'STATUS.md'), '# Status\n\nRunde 7.\n')
  git(p, 'add', '-A'); git(p, 'commit', '-qm', 'Stand')

  projekte.aktualisiere(p, scaffold(2))

  assert.equal(fs.readFileSync(path.join(p, 'TASKS.md'), 'utf8'), '- [ ] die eine Aufgabe\n')
  assert.equal(fs.readFileSync(path.join(p, 'QUESTIONS.md'), 'utf8'),
    '- Etwas, das ein Mensch entscheiden muss\n')
  assert.match(fs.readFileSync(path.join(p, 'STATUS.md'), 'utf8'), /Runde 7/)
})

test('aktualisiere nimmt jede Guard-Testdatei mit, auch neue', () => {
  // Die Liste war fest verdrahtet und nannte zwei von vier Dateien. Genau so
  // ist E11 entstanden, und genau so ist es ein zweites Mal passiert.
  const p = projekt()
  projekte.installiere(p, scaffold(1))
  projekte.aktualisiere(p, scaffold(2))
  assert.ok(fs.existsSync(path.join(p, 'test', 'guards-neu.test.js')),
    'eine Guard-Testdatei, die es beim Einrichten noch nicht gab, muss beim Update ankommen')
})

test('aktualisiere weigert sich, wo nichts eingerichtet ist', () => {
  assert.throws(() => projekte.aktualisiere(projekt(), scaffold(2)), /nicht eingerichtet/)
})
