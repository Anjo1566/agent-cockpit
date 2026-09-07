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

/** Zaehlt die Testdateien, die das Projekt selbst mitbringt. */
function eigeneTests (dir) {
  const dateien = git(dir, 'ls-files')
  if (!dateien) return 0
  return dateien.split('\n')
    .filter(d => /(\.(test|spec)\.[a-z0-9]+$|(^|\/)tests?\/|_test\.[a-z0-9]+$|(^|\/)test_[^/]*\.py$)/i.test(d))
    .length
}

/**
 * Erkennt den Testbefehl. Wichtig ist nicht das Raten, sondern die Ehrlichkeit
 * darueber, ob geraten wurde: der ganze Loop haengt daran, dass "Tests gruen"
 * etwas bedeutet. Ein stillschweigend falscher Testbefehl macht aus der einzigen
 * mechanischen Bremse eine Attrappe -- der Lauf meldet Erfolg und hat nie etwas
 * geprueft. Lieber gar keiner als ein falscher: dann verweigert loop.sh den
 * Start, und der Nutzer traegt ihn bewusst ein.
 */
function testbefehlErkennen (dir) {
  const tests = eigeneTests(dir)
  const paket = path.join(dir, 'package.json')

  if (fs.existsSync(paket)) {
    let j = {}
    try { j = JSON.parse(fs.readFileSync(paket, 'utf8')) } catch { /* kaputt */ }
    const skripte = j.scripts || {}
    if (skripte.test && !/no test specified/i.test(skripte.test)) {
      return { befehl: 'npm test', sicher: true, tests, warum: 'package.json hat ein test-Skript.' }
    }
    const abhaengig = Object.assign({}, j.dependencies, j.devDependencies)
    if (abhaengig.vitest) return { befehl: 'npx vitest run', sicher: true, tests, warum: 'vitest ist als Abhaengigkeit eingetragen.' }
    if (abhaengig.jest) return { befehl: 'npx jest', sicher: true, tests, warum: 'jest ist als Abhaengigkeit eingetragen.' }
    if (abhaengig.mocha) return { befehl: 'npx mocha', sicher: true, tests, warum: 'mocha ist als Abhaengigkeit eingetragen.' }
    if (tests > 0) return { befehl: 'node --test', sicher: true, tests, warum: `${tests} Testdateien gefunden, Node bringt den Laeufer mit.` }
    return {
      befehl: null,
      sicher: false,
      tests: 0,
      warum: 'Kein Testskript, kein Testwerkzeug und keine einzige Testdatei.'
    }
  }

  if (fs.existsSync(path.join(dir, 'pyproject.toml')) || fs.existsSync(path.join(dir, 'pytest.ini')) || tests > 0) {
    return { befehl: 'pytest -q', sicher: tests > 0, tests, warum: tests > 0 ? `${tests} Testdateien gefunden.` : 'pytest-Konfiguration gefunden, aber keine Tests.' }
  }
  if (fs.existsSync(path.join(dir, 'Cargo.toml'))) return { befehl: 'cargo test', sicher: true, tests, warum: 'Cargo-Projekt.' }
  if (fs.existsSync(path.join(dir, 'go.mod'))) return { befehl: 'go test ./...', sicher: true, tests, warum: 'Go-Modul.' }

  return { befehl: null, sicher: false, tests, warum: 'Keine bekannte Projektart erkannt.' }
}

// Der alte Name, damit nichts anderes bricht.
function testbefehlRaten (dir) {
  return testbefehlErkennen(dir).befehl || 'node --test'
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

  // Was VOR der Installation schon offen war, gehoert dem Nutzer und wird
  // nicht mitcommittet.
  const vorher = new Set(
    (git(ziel, 'status', '--porcelain') || '')
      .split('\n').filter(Boolean).map(z => z.slice(3).trim())
  )

  const zweig = git(ziel, 'branch', '--show-current')
  const test = testbefehlErkennen(ziel)

  const bericht = {
    kopiert: [],
    angelegt: [],
    uebersprungen: [],
    zweig,
    test,
    warnungen: [],
    committet: false
  }

  for (const d of [...SCAFFOLD, ...SCAFFOLD_ORDNER]) {
    const von = path.join(quelle, d)
    if (!fs.existsSync(von)) continue
    kopiere(von, path.join(ziel, d))
    bericht.kopiert.push(d)
  }

  // Die Guard-Tests laufen unter `node --test`. In ein Projekt mit vitest oder
  // pytest gehoeren sie nicht -- dort wuerden sie entweder gar nicht laufen
  // oder die fremde Suite stoeren.
  if (test.befehl === 'node --test') {
    fs.mkdirSync(path.join(ziel, 'test'), { recursive: true })
    for (const d of SCAFFOLD_TESTS) {
      const von = path.join(quelle, d)
      if (fs.existsSync(von)) {
        kopiere(von, path.join(ziel, d))
        bericht.kopiert.push(d)
      }
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

  // Der Zielbranch war fest auf "main" verdrahtet. Von sieben Projekten hier
  // stehen vier auf master oder einem Feature-Branch -- dort haette loop.sh
  // gleich in der Vorpruefung abgebrochen.
  const konfig = require('./konfig.js')
  const werte = {}
  if (zweig) werte.BASIS_BRANCH = zweig
  // Lieber kein Testbefehl als ein falscher: mit dem Platzhalter verweigert
  // loop.sh den Start und sagt, was fehlt. Ein stillschweigend geratener
  // Befehl wuerde "Tests gruen" melden, ohne je etwas geprueft zu haben.
  werte.TESTBEFEHL = test.sicher ? test.befehl : 'PLATZHALTER'
  try {
    konfig.schreib(ziel, werte)
  } catch (f) {
    bericht.warnungen.push('Die Konfiguration in loop.sh liess sich nicht setzen: ' + f.message)
  }

  if (!test.sicher) {
    bericht.warnungen.push(
      `Kein Testbefehl erkannt. ${test.warum} Der Loop startet erst, wenn du ` +
      'unter Einstellungen einen Testbefehl eintraegst, der bei Fehlschlag ' +
      'einen Wert ungleich 0 liefert.')
  }
  if (test.tests === 0) {
    bericht.warnungen.push(
      'Dieses Projekt hat keine eigenen Tests. Der Loop braucht sie: ob eine ' +
      'Runde gelungen ist, entscheidet der Rueckgabewert der Testsuite, nicht ' +
      'der Agent. Ohne Tests laeuft er ohne Bremse.')
  }

  // Auf Windows ist chmod wirkungslos; erst das hier traegt 100755 in den Index
  // ein, und nur damit ist das Skript in einem Linux-Klon ausfuehrbar.
  const skripte = ['loop.sh', 'abnahme.sh',
    ...fs.readdirSync(path.join(ziel, '.agents', 'hooks')).map(f => `.agents/hooks/${f}`)]
    .filter(f => f.endsWith('.sh'))

  // Die Installation selbst committen. Ohne das ist das Arbeitsverzeichnis
  // schmutzig, und loop.sh verweigert zu Recht den Start: sonst wuerde der
  // Agent die offenen Aenderungen des Nutzers mitcommitten.
  const pfade = [
    ...SCAFFOLD, ...SCAFFOLD_ORDNER, ...Object.keys(ZUSTAND), '.gitignore',
    ...(test.befehl === 'node --test' ? SCAFFOLD_TESTS : [])
  ].filter(d => fs.existsSync(path.join(ziel, d)) && !vorher.has(d))

  git(ziel, 'add', '--', ...pfade)
  git(ziel, 'update-index', '--chmod=+x', '--', ...skripte)

  // Ohne Pfadangabe committen: `git commit -- <pfade>` nimmt den Stand des
  // Arbeitsverzeichnisses und uebergeht den Index -- die eben gesetzten
  // Exec-Bits blieben dann bereitgestellt liegen, und das Verzeichnis waere
  // weiter unsauber. Genau das soll die Installation ja beseitigen.
  //
  // Sicher ist das, weil nur das committet wird, was bereitgestellt ist: die
  // offenen Aenderungen des Nutzers sind es nicht. Falls doch etwas Fremdes
  // bereitliegt, wird es benannt statt stillschweigend mitgenommen.
  const bereit = (git(ziel, 'diff', '--cached', '--name-only') || '')
    .split('\n').filter(Boolean)
  const meine = new Set(pfade.flatMap(d => [d, d.replace(/\/$/, '')]))
  const fremd = bereit.filter(d => ![...meine].some(m => d === m || d.startsWith(m + '/')))
  if (fremd.length) {
    bericht.warnungen.push(
      'Diese Dateien lagen schon bereitgestellt im Index und wandern in den ' +
      'Installationscommit: ' + fremd.slice(0, 8).join(', ') +
      (fremd.length > 8 ? ` und ${fremd.length - 8} weitere` : '') + '.')
  }

  const gemacht = git(ziel, 'commit', '--no-verify', '-m',
    'Install the autonomous agent loop\n\n' +
    'Charter, round prompt, guards and loop.sh, plus the state files the lead\n' +
    'reconstructs its position from. Installed by the cockpit.')
  bericht.committet = gemacht !== null
  if (!bericht.committet) {
    bericht.warnungen.push(
      'Die Installation liess sich nicht committen. Solange sie nicht ' +
      'committet ist, verweigert loop.sh den Start.')
  }

  return bericht
}

module.exports = { liste, details, installiere, installationsStand, testbefehlRaten, testbefehlErkennen, istRepo }
