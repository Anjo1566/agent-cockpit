'use strict'

// installiere() kopierte .gitattributes bisher mit `force: true`, was ein
// vorhandenes .gitattributes im Projekt komplett ueberschrieb. Genau das hat
// diesem Repository die Zeile "*.cmd text eol=crlf" gekostet, ohne die
// cmd.exe cockpit.cmd nicht ausfuehrt. Dieser Test deckt ab, dass installiere()
// stattdessen zusammenfuehrt: die Zeilen des Projekts bleiben, die Zeilen des
// Scaffolds werden ergaenzt.

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

function schreibe (dir, dateien) {
  for (const [rel, inhalt] of Object.entries(dateien)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, inhalt, 'utf8')
  }
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

/**
 * Ein minimales Scaffold, das installiere() akzeptiert: es braucht loop.sh,
 * damit die Vorpruefung nicht scheitert, und .agents/hooks/, weil
 * installiere() dieses Verzeichnis im Zielprojekt fuer die Exec-Bits ausliest.
 */
function scaffold (dateien = {}) {
  const dir = tempdir('cockpit-scaffold-')
  schreibe(dir, {
    'loop.sh': '#!/bin/sh\necho loop\n',
    '.agents/hooks/.halten': '',
    ...dateien
  })
  return dir
}

test('installiere fuehrt .gitattributes zusammen statt es zu ueberschreiben', () => {
  const projekt = repo({
    'README.md': '# test\n',
    '.gitattributes': '*.cmd text eol=crlf\n'
  })
  const quelle = scaffold({
    '.gitattributes': '* text=auto eol=lf\n*.sh text eol=lf\n'
  })

  projekte.installiere(projekt, quelle)

  const ergebnis = fs.readFileSync(path.join(projekt, '.gitattributes'), 'utf8')
  assert.match(ergebnis, /\*\.cmd text eol=crlf/, 'die eigene Zeile des Projekts ist verschwunden')
  assert.match(ergebnis, /\* text=auto eol=lf/, 'eine Zeile aus dem Scaffold fehlt')
  assert.match(ergebnis, /\*\.sh text eol=lf/, 'eine Zeile aus dem Scaffold fehlt')
})

test('installiere legt .gitattributes einfach an, wenn das Projekt noch keins hat', () => {
  const projekt = repo({ 'README.md': '# test\n' })
  const quelle = scaffold({
    '.gitattributes': '* text=auto eol=lf\n*.sh text eol=lf\n'
  })

  projekte.installiere(projekt, quelle)

  const ergebnis = fs.readFileSync(path.join(projekt, '.gitattributes'), 'utf8')
  assert.equal(ergebnis, '* text=auto eol=lf\n*.sh text eol=lf\n')
})

test('installiere laesst .gitattributes unveraendert, wenn das Scaffold nichts Neues bringt', () => {
  const projekt = repo({
    'README.md': '# test\n',
    '.gitattributes': '*.cmd text eol=crlf\n* text=auto eol=lf\n'
  })
  const quelle = scaffold({
    '.gitattributes': '* text=auto eol=lf\n'
  })

  projekte.installiere(projekt, quelle)

  const ergebnis = fs.readFileSync(path.join(projekt, '.gitattributes'), 'utf8')
  assert.equal(ergebnis, '*.cmd text eol=crlf\n* text=auto eol=lf\n')
})
