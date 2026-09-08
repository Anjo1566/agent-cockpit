'use strict'

// gitattributesZusammenfuehren() (lib/projekte.js) keeps a project's existing
// .gitattributes bytes as-is and only appends missing scaffold lines. If the
// existing file uses CRLF throughout, the append must use CRLF too -- a bare
// '\n' join would mix line endings in one file, the exact class of bug this
// function was written to fix (see test/projekte-gitattributes.test.js), just
// on the append side instead of the whole-file-overwrite side. These tests
// cover that the dominant line ending of the existing file is detected and
// reused, and that plain-LF files still merge with pure LF (no regression).

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
  const dir = tempdir('cockpit-projekt-crlf-')
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
  const dir = tempdir('cockpit-scaffold-crlf-')
  schreibe(dir, {
    'loop.sh': '#!/bin/sh\necho loop\n',
    '.agents/hooks/.halten': '',
    ...dateien
  })
  return dir
}

test('installiere haengt an ein durchgehend CRLF-.gitattributes wieder CRLF an', () => {
  const projekt = repo({
    'README.md': '# test\n',
    '.gitattributes': '*.cmd text eol=crlf\r\n'
  })
  const quelle = scaffold({
    '.gitattributes': '* text=auto eol=lf\n*.sh text eol=lf\n'
  })

  projekte.installiere(projekt, quelle)

  const ergebnis = fs.readFileSync(path.join(projekt, '.gitattributes'), 'utf8')

  // Keine Zeile darf mit einem bloss von '\n' abgeschlossen sein, dem kein
  // '\r' vorausgeht -- sonst waeren Zeilenenden gemischt.
  assert.doesNotMatch(ergebnis, /[^\r]\n/, 'die Datei enthaelt bloss LF-Zeilenenden statt durchgehend CRLF')
  assert.match(ergebnis, /\*\.cmd text eol=crlf\r\n/, 'die eigene Zeile des Projekts ist verschwunden')
  assert.match(ergebnis, /\* text=auto eol=lf\r\n/, 'eine ergaenzte Zeile hat kein CRLF')
  assert.match(ergebnis, /\*\.sh text eol=lf\r\n/, 'eine ergaenzte Zeile hat kein CRLF')
})

test('installiere haengt an ein durchgehend LF-.gitattributes weiterhin LF an (keine Regression)', () => {
  const projekt = repo({
    'README.md': '# test\n',
    '.gitattributes': '*.cmd text eol=crlf\n'
  })
  const quelle = scaffold({
    '.gitattributes': '* text=auto eol=lf\n*.sh text eol=lf\n'
  })

  projekte.installiere(projekt, quelle)

  const ergebnis = fs.readFileSync(path.join(projekt, '.gitattributes'), 'utf8')

  assert.doesNotMatch(ergebnis, /\r/, 'die Datei enthaelt ein CR, obwohl sie durchgehend LF sein sollte')
  assert.equal(ergebnis, '*.cmd text eol=crlf\n* text=auto eol=lf\n*.sh text eol=lf\n')
})
