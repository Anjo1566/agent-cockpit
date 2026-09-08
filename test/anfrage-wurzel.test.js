'use strict'

// Eigene Datei statt eine Ergaenzung in test/anfrage.test.js: der
// Datei-Guard sperrt jede Aenderung an einer bereits von git verfolgten
// Testdatei, unabhaengig davon, ob sie in TASKS.md als "frozen" gelistet ist
// -- test/anfrage.test.js ist seit Runde 7 committet und faellt damit
// darunter. Eine neue Datei fuer neue Testfaelle ist laut Charta erlaubt.
//
// Deckt genau die Luecke, die projektPfad() jetzt schliesst: eine
// unerreichbare WURZEL (Server-Fehlkonfiguration) muss eine deutliche
// Meldung werfen statt eines rohen ENOENT.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { projektPfad } = require('../lib/anfrage.js')

function tempdir (praefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), praefix))
}

function git (cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Ein Verzeichnis unter dir, initialisiert als Git-Repository. Legt dir bei Bedarf an. */
function repo (dir) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main', '.')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n', 'utf8')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '--no-verify', '-m', 'erster')
  return dir
}

test('eine nicht erreichbare Wurzel wirft eine deutliche Meldung statt eines rohen ENOENT', () => {
  const basis = tempdir('cockpit-basis-')
  const wurzel = path.join(basis, 'existiert-nicht')
  const projekt = repo(tempdir('cockpit-projekt-'))
  assert.throws(() => projektPfad(projekt, wurzel), /Wurzelverzeichnis des Servers nicht erreichbar/)
})

test('eine geloeschte Wurzel wirft dieselbe Meldung, nicht "kein Git-Repository" oder "ausserhalb der Wurzel"', () => {
  const wurzel = tempdir('cockpit-wurzel-')
  const projekt = repo(tempdir('cockpit-projekt-'))
  fs.rmSync(wurzel, { recursive: true, force: true })
  assert.throws(() => projektPfad(projekt, wurzel), (fehler) => {
    assert.match(fehler.message, /Wurzelverzeichnis des Servers nicht erreichbar/)
    assert.doesNotMatch(fehler.message, /kein Git-Repository/)
    assert.doesNotMatch(fehler.message, /ausserhalb der Wurzel/)
    return true
  })
})
