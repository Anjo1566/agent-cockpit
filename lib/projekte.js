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

// --- Neues Projekt anlegen ------------------------------------------------

// Die Spielwiese ist absichtlich winzig, aber vollstaendig: eine Funktion, ein
// echter Test, ein Testskript. Damit erkennt die Installation den Testbefehl
// sicher, und der Loop hat vom ersten Moment an eine Bremse. Ein leeres
// Projekt waere schneller angelegt und waere sofort das, was jufa ist: ein
// Repository, in dem "Tests gruen" nichts bedeutet.
const SPIELWIESE = {
  'package.json': JSON.stringify({
    name: 'PLATZHALTER',
    version: '0.1.0',
    private: true,
    description: 'Spielwiese fuer den Agenten-Loop',
    main: 'src/rechnen.js',
    scripts: { test: 'node --test' },
    engines: { node: '>=20' },
    license: 'UNLICENSED'
  }, null, 2) + '\n',

  'src/rechnen.js': `'use strict'

// Ein Anfang, mehr nicht. Der Loop soll hier weiterbauen.

/**
 * Summe einer Liste von Zahlen.
 *
 * @param {number[]} zahlen
 * @returns {number}
 */
function summe (zahlen) {
  if (!Array.isArray(zahlen)) throw new TypeError('summe erwartet eine Liste')
  return zahlen.reduce((a, b) => a + b, 0)
}

module.exports = { summe }
`,

  'test/rechnen.test.js': `'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { summe } = require('../src/rechnen.js')

test('summe addiert die Zahlen', () => {
  assert.equal(summe([1, 2, 3]), 6)
})

test('summe einer leeren Liste ist null', () => {
  assert.equal(summe([]), 0)
})

test('summe weist alles zurueck, was keine Liste ist', () => {
  assert.throws(() => summe('123'), TypeError)
})
`,

  'TASKS.md': `# Backlog

- [ ] Add a \`mittelwert(zahlen)\` function to src/rechnen.js that returns the arithmetic mean, and 0 for an empty list. Cover both cases with tests.
- [ ] Add a \`groesster(zahlen)\` function returning the largest number, or null for an empty list. Cover it with tests.
`,

  'README.md': `# PLATZHALTER

Eine Spielwiese fuer den autonomen Agenten-Loop. Angelegt vom Cockpit.

Der Auftrag steht in \`TASKS.md\`. Starten kannst du im Cockpit oder hier:

\`\`\`bash
./loop.sh 3
\`\`\`
`
}

/** Prueft einen Projektnamen, bevor daraus ein Pfad wird. */
function namePruefen (name) {
  if (typeof name !== 'string') throw new Error('Kein Name angegeben.')
  const sauber = name.trim()
  if (!sauber) throw new Error('Der Name darf nicht leer sein.')
  if (sauber.length > 60) throw new Error('Der Name ist zu lang.')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sauber)) {
    throw new Error('Erlaubt sind Buchstaben, Ziffern, Punkt, Bindestrich und ' +
      'Unterstrich; das erste Zeichen muss ein Buchstabe oder eine Ziffer sein.')
  }
  return sauber
}

/**
 * Legt ein neues Projekt an und richtet den Loop darin ein.
 *
 * @param {string} wurzel   Verzeichnis, in dem Projekte liegen
 * @param {string} name     Ordnername
 * @param {string} quelle   Scaffold-Ordner
 * @param {boolean} leer    true = nur git init, keine Spielwiese
 */
function anlegen (wurzel, name, quelle, leer = false) {
  const sauber = namePruefen(name)
  const ziel = path.join(wurzel, sauber)
  if (fs.existsSync(ziel)) throw new Error(`"${sauber}" gibt es hier schon.`)

  fs.mkdirSync(ziel, { recursive: true })

  try {
    if (git(ziel, 'init', '-b', 'main') === null) {
      // Aeltere Git-Versionen kennen -b beim init nicht.
      git(ziel, 'init')
      git(ziel, 'checkout', '-b', 'main')
    }

    if (!leer) {
      for (const [datei, inhalt] of Object.entries(SPIELWIESE)) {
        const p = path.join(ziel, datei)
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, inhalt.split('PLATZHALTER').join(sauber), 'utf8')
      }
    } else {
      fs.writeFileSync(path.join(ziel, 'README.md'), `# ${sauber}\n`, 'utf8')
    }

    git(ziel, 'add', '-A')
    if (git(ziel, 'commit', '--no-verify', '-m', 'Erster Commit') === null) {
      throw new Error('Der erste Commit ist fehlgeschlagen. Ist git eingerichtet ' +
        '(user.name und user.email)?')
    }

    const bericht = installiere(ziel, quelle)
    return { pfad: ziel, name: sauber, bericht, projekt: details(ziel) }
  } catch (f) {
    // Ein halb angelegtes Projekt ist schlimmer als keines.
    try { fs.rmSync(ziel, { recursive: true, force: true }) } catch { /* dann eben nicht */ }
    throw f
  }
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

/**
 * Commitet, was das Cockpit selbst in ein Projekt geschrieben hat.
 *
 * Ohne das ist das Cockpit sein eigener Blockierer: wer die Aufgaben oder die
 * Einstellungen hier bearbeitet, macht damit das Arbeitsverzeichnis schmutzig,
 * und der Start verweigert danach genau deswegen den Dienst -- mit einer
 * Meldung ueber "offene Aenderungen", die niemand bewusst gemacht hat.
 *
 * Der Commit ist auf die Pfade begrenzt: `git commit -- <pfade>` nimmt den
 * Stand des Arbeitsverzeichnisses und uebergeht den Index. Was der Nutzer
 * sonst noch offen oder bereitgestellt hat, bleibt unangetastet liegen.
 *
 * @param {string} projekt
 * @param {string[]} dateien  Pfade relativ zum Projekt
 * @param {string} meldung    Commit-Meldung
 * @returns {{stand: "committet"|"nichts"|"fehler", grund?: string}}
 */
function sichere (projekt, dateien, meldung) {
  if (!istRepo(projekt)) return { stand: 'nichts' }

  const offen = git(projekt, 'status', '--porcelain', '--', ...dateien)
  if (offen === null) return { stand: 'fehler', grund: 'git status schlug fehl.' }
  if (!offen.trim()) return { stand: 'nichts' }

  // Erst bereitstellen: eine noch unbekannte Datei findet der Pfad-Commit
  // sonst nicht ('pathspec did not match any file known to git').
  if (git(projekt, 'add', '--', ...dateien) === null) {
    return { stand: 'fehler', grund: 'git add hat die Datei nicht angenommen.' }
  }
  if (git(projekt, 'commit', '--no-verify', '-m', meldung, '--', ...dateien) === null) {
    return {
      stand: 'fehler',
      grund: 'Der Commit ist fehlgeschlagen. Sind user.name und user.email in git gesetzt?'
    }
  }
  return { stand: 'committet' }
}

module.exports = { liste, details, installiere, anlegen, sichere, installationsStand, testbefehlRaten, testbefehlErkennen, istRepo }
