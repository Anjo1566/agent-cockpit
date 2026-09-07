'use strict'

// Findet die Projekte, in denen der Loop arbeiten kann, und richtet ihn dort ein.
//
// Ein Projekt ist hier schlicht ein Git-Repository. Ob der Loop darin schon
// eingerichtet ist, wird an denselben Dateien erkannt, die loop.sh in seiner
// Vorpruefung verlangt -- nicht an einer Markierung, die luegen koennte.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// Die Dateien, die ein Repository zum Loop-Repository machen. Genau diese Liste
// steht auch im README von agent-loop unter "Auf ein anderes Projekt umhaengen",
// und abnahme.sh prueft dort, dass sie vollstaendig ist.
const SCAFFOLD = [
  'CLAUDE.md',
  'round.md',
  'loop.sh',
  'abnahme.sh',
  '.gitattributes'
]
const SCAFFOLD_ORDNER = ['.agents', '.claude']
const SCAFFOLD_TESTS = ['test/guards.test.js', 'test/guards-regression.test.js']

// Zustandsdateien: die werden nur angelegt, wenn sie fehlen, und niemals
// ueberschrieben -- da steht der Auftrag des Nutzers drin.
const ZUSTAND = {
  'TASKS.md': '# Backlog\n\n',
  'STATUS.md': '# Status\n\nNoch keine Runde gelaufen.\n',
  'QUESTIONS.md': ''
}

function git (cwd, ...args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function istRepo (dir) {
  return fs.existsSync(path.join(dir, '.git'))
}

/** Ist der Loop hier eingerichtet, und wenn nein, was fehlt? */
function installationsStand (dir) {
  const fehlt = []
  for (const d of SCAFFOLD) if (!fs.existsSync(path.join(dir, d))) fehlt.push(d)
  for (const d of SCAFFOLD_ORDNER) if (!fs.existsSync(path.join(dir, d))) fehlt.push(d + '/')
  for (const d of Object.keys(ZUSTAND)) if (!fs.existsSync(path.join(dir, d))) fehlt.push(d)
  return { eingerichtet: fehlt.length === 0, fehlt }
}

/** Alle Projekte unterhalb von wurzel, eine Ebene tief. */
function liste (wurzel) {
  let eintraege = []
  try {
    eintraege = fs.readdirSync(wurzel, { withFileTypes: true })
  } catch {
    return []
  }

  return eintraege
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map(e => path.join(wurzel, e.name))
    .filter(istRepo)
    .map(details)
    .sort((a, b) => {
      // Eingerichtete zuerst, dann alphabetisch.
      if (a.eingerichtet !== b.eingerichtet) return a.eingerichtet ? -1 : 1
      return a.name.localeCompare(b.name, 'de')
    })
}

function details (dir) {
  const stand = installationsStand(dir)
  const schmutzig = git(dir, 'status', '--porcelain')
  return {
    name: path.basename(dir),
    pfad: dir,
    branch: git(dir, 'branch', '--show-current') || '(kein Branch)',
    remote: git(dir, 'remote', 'get-url', 'origin'),
    sauber: schmutzig === '',
    offeneDateien: schmutzig ? schmutzig.split('\n').length : 0,
    letzterCommit: git(dir, 'log', '-1', '--format=%s'),
    ...stand
  }
}

/** Raet den Testbefehl aus dem, was im Projekt liegt. Der Nutzer kann ihn ueberschreiben. */
function testbefehlRaten (dir) {
  const pkg = path.join(dir, 'package.json')
  if (fs.existsSync(pkg)) {
    try {
      const j = JSON.parse(fs.readFileSync(pkg, 'utf8'))
      const s = j.scripts || {}
      if (s.test && !/no test specified/i.test(s.test)) return 'npm test'
    } catch { /* kaputtes package.json ist nicht unser Problem */ }
    return 'node --test'
  }
  if (fs.existsSync(path.join(dir, 'pyproject.toml')) ||
      fs.existsSync(path.join(dir, 'pytest.ini')) ||
      fs.existsSync(path.join(dir, 'tests'))) return 'pytest -q'
  if (fs.existsSync(path.join(dir, 'Cargo.toml'))) return 'cargo test'
  if (fs.existsSync(path.join(dir, 'go.mod'))) return 'go test ./...'
  return 'node --test'
}

function kopiere (von, nach) {
  fs.cpSync(von, nach, { recursive: true, force: true })
}

/**
 * Richtet den Loop in einem Projekt ein.
 *
 * Bewusst zurueckhaltend: Zustandsdateien werden nur angelegt, wenn sie fehlen.
 * Ein vorhandenes TASKS.md ist der Auftrag des Nutzers und wird nie ueberschrieben.
 */
function installiere (ziel, quelle) {
  if (!istRepo(ziel)) throw new Error('Das ist kein Git-Repository.')
  if (!fs.existsSync(path.join(quelle, 'loop.sh'))) {
    throw new Error(`Im Scaffold-Ordner ${quelle} liegt kein loop.sh.`)
  }

  const bericht = { kopiert: [], angelegt: [], uebersprungen: [] }

  for (const d of [...SCAFFOLD, ...SCAFFOLD_ORDNER]) {
    const von = path.join(quelle, d)
    if (!fs.existsSync(von)) continue
    kopiere(von, path.join(ziel, d))
    bericht.kopiert.push(d)
  }

  fs.mkdirSync(path.join(ziel, 'test'), { recursive: true })
  for (const d of SCAFFOLD_TESTS) {
    const von = path.join(quelle, d)
    if (fs.existsSync(von)) {
      kopiere(von, path.join(ziel, d))
      bericht.kopiert.push(d)
    }
  }

  for (const [datei, inhalt] of Object.entries(ZUSTAND)) {
    const ziel_ = path.join(ziel, datei)
    if (fs.existsSync(ziel_)) { bericht.uebersprungen.push(datei); continue }
    fs.writeFileSync(ziel_, inhalt, 'utf8')
    bericht.angelegt.push(datei)
  }

  // .agents/ gehoert nicht ins Repo, .agents/hooks/ schon. Git steigt in ein
  // ausgeschlossenes Verzeichnis nicht hinab, deshalb die Form mit /*.
  const ignore = path.join(ziel, '.gitignore')
  const vorhanden = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : ''
  if (!vorhanden.includes('/.agents/*')) {
    fs.writeFileSync(ignore,
      vorhanden.replace(/\n*$/, '\n') +
      '\n# Laufzeitzustand des Agenten-Loops. Die Hooks sind die Ausnahme:\n' +
      '# sie sind die Schutzmechanismen und muessen versioniert sein.\n' +
      '/.agents/*\n!/.agents/hooks/\n', 'utf8')
    bericht.angelegt.push('.gitignore (ergaenzt)')
  }

  // Auf Windows ist chmod wirkungslos; erst das hier traegt 100755 in den Index
  // ein, und nur damit ist das Skript in einem Linux-Klon ausfuehrbar.
  const skripte = ['loop.sh', 'abnahme.sh',
    ...fs.readdirSync(path.join(ziel, '.agents', 'hooks')).map(f => `.agents/hooks/${f}`)]
    .filter(f => f.endsWith('.sh'))
  git(ziel, 'add', '--intent-to-add', '--', ...skripte)
  git(ziel, 'update-index', '--chmod=+x', '--', ...skripte)

  return bericht
}

module.exports = { liste, details, installiere, installationsStand, testbefehlRaten, istRepo }
