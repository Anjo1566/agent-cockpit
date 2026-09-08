'use strict'

// Der Lauf, der sich selbst abgeschossen hat.
//
// Am 07.09.2026 gegen 20:52 startete der grader-Subagent den Cockpit-Server,
// um ihn zu pruefen -- seine Anweisung verlangt das ausdruecklich ("Run
// things. Start the program if it can be started."). Danach raeumte er auf:
//
//     taskkill //F //IM node.exe //T
//
// Das trifft nicht den einen Server, sondern JEDEN node-Prozess auf der
// Maschine: das Cockpit, die Claude-Code-Sitzung, die den Befehl gerade
// ausfuehrte, und damit den ganzen Lauf. Der Ereignisstrom bricht in
// .agents/round-2.ndjson mitten in einem Werkzeugaufruf ab, es gibt kein
// .agents/stop-reason.txt, und loop.sh hing danach vier Stunden an einem
// toten Kind.
//
// Drei Schichten sollen das kuenftig auffangen, und jede wird hier einzeln
// geprueft:
//   1. guard-bash.sh laesst den Befehl gar nicht erst durch.
//   2. der Wachhund in loop.sh beendet eine Runde, deren Strom stillsteht --
//      unabhaengig davon, WARUM sie stillsteht.
//   3. lauf.js kennt den grader, damit seine Standzeit unter seinem eigenen
//      Namen auf dem Brett steht statt unter dem des Reviewers.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')

const WURZEL = path.resolve(__dirname, '..')
const { Lauf } = require('../lib/lauf.js')

// Dieselbe Bash, die auch das Cockpit fuer loop.sh sucht.
function bash () {
  if (process.env.COCKPIT_BASH) return process.env.COCKPIT_BASH
  if (process.platform !== 'win32') return 'bash'
  for (const k of ['C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
    if (fs.existsSync(k)) return k
  }
  return 'bash'
}

/** Ruft guard-bash.sh so auf, wie Claude Code es tut. 2 heisst blockiert. */
function guard (befehl) {
  const nutzlast = JSON.stringify({ tool_name: 'Bash', tool_input: { command: befehl } })
  try {
    execFileSync(bash(), [path.join(WURZEL, '.agents/hooks/guard-bash.sh')], {
      input: nutzlast,
      env: { ...process.env, CLAUDE_PROJECT_DIR: WURZEL },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return 0
  } catch (f) {
    return f.status
  }
}

// ------------------------------------------------- 1. Der Guard

test('genau der Befehl, der diesen Lauf getoetet hat, ist blockiert', () => {
  assert.equal(guard('taskkill //F //IM node.exe //T 2>/dev/null; echo done'), 2)
})

test('das Toeten von Prozessen ist als Klasse blockiert, nicht als Einzelfall', () => {
  // Ein Verbot, das nur die eine Schreibweise kennt, ist nach der ersten
  // Umformulierung wieder offen.
  for (const befehl of [
    'taskkill /F /IM node.exe /T',
    'TASKKILL /F /IM node.exe',            // cmd.exe ist nicht case-sensitiv
    'bash -c "taskkill //F //IM node.exe"', // ueber einen zweiten Interpreter
    'pkill -9 node',
    'killall node',
    'kill -9 $PPID',
    'kill 12345',
    'kill -STOP $$',                        // anhalten toetet den Lauf genauso
    'echo 1234 | xargs kill',
    'powershell -c "Stop-Process -Name node -Force"',
    'powershell -Command "Get-Process node | Stop-Process -Force"',
    'wmic process where "name=\'node.exe\'" delete',
    'net stop W32Time',
    'sc stop W32Time',
    'shutdown /s /t 0',
    'logoff',
    'node -e "process.kill(process.ppid)"',
    'python -c "import os,signal; os.kill(os.getppid(), 9)"'
  ]) {
    assert.equal(guard(befehl), 2, `nicht blockiert: ${befehl}`)
  }
})

test('gewoehnliche Arbeit bleibt erlaubt', () => {
  // Ein Guard, der zu viel blockiert, wird umgangen statt befolgt. `kill` ist
  // ausserdem ein gewoehnliches englisches Wort und steht in Suchmustern und
  // Commit-Botschaften.
  for (const befehl of [
    'npm test',
    'node --test test/lauf.test.js',
    'git status --porcelain',
    'grep -rn "kill" public/app.js',
    'git commit -m "kill 3 flaky tests"',
    'grep -c "skill" README.md',
    'curl -s http://127.0.0.1:7777/api/zustand',
    'timeout 20 npm start'   // der empfohlene Weg statt hinterher abschiessen
  ]) {
    assert.equal(guard(befehl), 0, `faelschlich blockiert: ${befehl}`)
  }
})

test('die aelteren Verbote gelten unveraendert weiter', () => {
  for (const befehl of [
    'git push --force origin main',
    'npm install lodash',
    'git stash',
    'sed -i "s/a/b/" test/lauf.test.js'
  ]) {
    assert.equal(guard(befehl), 2, `nicht mehr blockiert: ${befehl}`)
  }
})

// ------------------------------------------------- 2. Der Wachhund

// Der Wachhund wird aus loop.sh herausgeloest und genau so aufgerufen, wie
// loop.sh ihn aufruft. Damit prueft der Test den ausgelieferten Code, nicht
// eine Kopie davon, die auseinanderlaufen kann.
function wachhundProbe (art, maxStille, maxRunde) {
  const verzeichnis = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-wach-'))
  fs.mkdirSync(path.join(verzeichnis, '.agents'))
  const loop = fs.readFileSync(path.join(WURZEL, 'loop.sh'), 'utf8')
  const funktionen = (loop.match(/^toete_baum \(\) \{[\s\S]*?^\}$/m) || [''])[0] +
    '\n' + (loop.match(/^wachhund \(\) \{[\s\S]*?^\}$/m) || [''])[0]
  assert.match(funktionen, /toete_baum/, 'toete_baum nicht in loop.sh gefunden')
  assert.match(funktionen, /wachhund/, 'wachhund nicht in loop.sh gefunden')

  // Der Wachhund tastet in loop.sh alle 15 s ab. Ein Kind, das vorher fertig
  // ist, kann er gar nicht erwischen -- deshalb leben die Kinder hier laenger
  // als ein Intervall, sonst pruefte der Test bloss seine eigene Ungeduld.
  const kind = {
    still: '( echo a >> .agents/strom.ndjson; sleep 120 ) &',
    arbeitet: '( for n in $(seq 1 20); do echo "$n" >> .agents/strom.ndjson; sleep 1; done ) &',
    lang: '( for n in $(seq 1 90); do echo "$n" >> .agents/strom.ndjson; sleep 1; done ) &'
  }[art]

  const skript = [
    'set -uo pipefail',
    `MAX_STILLE=${maxStille}`,
    `MAX_RUNDE=${maxRunde}`,
    funktionen,
    ': > .agents/strom.ndjson',
    kind,
    'KIND=$!',
    'wachhund "$KIND" ".agents/strom.ndjson" &',
    'WACHE=$!',
    'wait "$KIND" || true',
    'kill "$WACHE" 2>/dev/null || true',
    'wait "$WACHE" 2>/dev/null || true'
  ].join('\n')

  execFileSync(bash(), ['-c', skript], { cwd: verzeichnis, stdio: 'ignore' })
  const marke = path.join(verzeichnis, '.agents/wachhund.txt')
  return fs.existsSync(marke) ? fs.readFileSync(marke, 'utf8').trim() : null
}

test('ein stillstehender Ereignisstrom beendet die Runde', { timeout: 120000 }, () => {
  // Das Kind wuerde 120 s schlafen. Kommt der Test in einem Bruchteil davon
  // zurueck, hat der Wachhund es beendet -- und nur er kann das gewesen sein.
  const marke = wachhundProbe('still', 4, 999)
  assert.match(marke || '', /Ereignisstrom stand \d+ s still/)
})

test('ein arbeitender Lauf wird nicht angetastet', { timeout: 120000 }, () => {
  assert.equal(wachhundProbe('arbeitet', 4, 999), null)
})

test('die Zeitgrenze pro Runde greift auch bei fleissigem Strom', { timeout: 120000 }, () => {
  // Fleiss allein ist kein Fortschritt: eine Runde, die im Kreis laeuft,
  // schreibt munter weiter Ereignisse.
  const marke = wachhundProbe('lang', 999, 3)
  assert.match(marke || '', /Zeitgrenze von 3 s/)
})

test('der Wachhund haengt am Rundenaufruf und nicht bloss im Skript herum', () => {
  // Zeilenenden vereinheitlichen: die Datei liegt unter Windows mit CRLF im
  // Arbeitsverzeichnis und mit LF im Repository.
  const loop = fs.readFileSync(path.join(WURZEL, 'loop.sh'), 'utf8').replace(/\r\n/g, '\n')
  // Die Kommentare erzaehlen von dem Befehl, der den Lauf getoetet hat.
  // Geprueft wird, was ausgefuehrt wird.
  const code = loop.split('\n').filter(z => !/^\s*#/.test(z)).join('\n')

  // Die Runde laeuft im Hintergrund, sonst gaebe es niemanden, der zusieht.
  assert.match(code, /round-\$i\.ndjson" &\n\s*RUNDE_PID=\$!/)
  assert.match(code, /wachhund "\$RUNDE_PID"/)
  // Und der Befund des Wachhunds beendet den Lauf, statt nur dokumentiert zu
  // werden: ein Wachhund, dessen Bellen niemand liest, ist keiner.
  assert.match(code, /if \[\[ -s \.agents\/wachhund\.txt \]\]; then\n\s*GRUND=/)
  // Nach PID, nie nach Abbildname -- der Unterschied, an dem der Lauf starb.
  assert.match(code, /taskkill \/\/PID "\$winpid" \/\/T \/\/F/)
  assert.doesNotMatch(code, /taskkill[^\n]*\/\/IM/)
})

// ------------------------------------------------- 3. Der grader auf dem Brett

/** Ein Lauf, der nichts startet. */
function lauf (t) {
  const l = new Lauf()
  const ereignisse = []
  l.on('ereignis', (e) => ereignisse.push(e))
  l.zustand.projekt = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-rolle-'))
  t.after(() => l.stopTailer())
  return { l, vom: (typ) => ereignisse.filter(e => e.typ === typ) }
}

test('der grader loest einen Rollenwechsel aus und traegt seinen eigenen Namen', (t) => {
  const { l, vom } = lauf(t)
  l.werkzeugaufruf({ name: 'Agent', input: { subagent_type: 'reviewer', description: 'Review the change' } })
  l.werkzeugaufruf({ name: 'Agent', input: { subagent_type: 'grader', description: 'Grade repository' } })

  // Er sitzt auf dem Platz des Reviewers -- das Brett hat nur drei Knoten ...
  assert.equal(l.zustand.rolle, 'reviewer')
  // ... aber er heisst nicht so.
  assert.equal(l.zustand.taetig, 'grader')
  assert.equal(l.zustand.auftrag, 'Grade repository')

  const rollen = vom('rolle')
  assert.deepEqual(rollen.map(e => e.taetig), ['reviewer', 'grader'])
})

test('der Wechsel zum grader stellt die Uhr neu', (t) => {
  // Genau das fehlte: weil der grader keinen Rollenwechsel ausloeste, lief er
  // auf der Uhr des Reviewers weiter. Am Ende standen am Reviewer 15470 s, von
  // denen ihm keine einzige gehoerte.
  const { l } = lauf(t)
  // Zwei Aufrufe hintereinander koennen in dieselbe Millisekunde fallen; dann
  // pruefte ein Vergleich der Zeitstempel nur die Aufloesung der Uhr.
  const echteUhr = Date.now
  let jetzt = 1000
  Date.now = () => jetzt
  t.after(() => { Date.now = echteUhr })

  l.werkzeugaufruf({ name: 'Agent', input: { subagent_type: 'reviewer', description: 'Review' } })
  const seitReviewer = l.zustand.seit
  jetzt += 15470000   // die 15470 s, die im Screenshot am Reviewer standen
  l.werkzeugaufruf({ name: 'Agent', input: { subagent_type: 'grader', description: 'Grade' } })

  assert.notEqual(l.zustand.seit, seitReviewer)
  assert.equal(l.zustand.seit, 15471000)
})

test('chef, coder und reviewer heissen weiter wie sie heissen', (t) => {
  const { l } = lauf(t)
  for (const rolle of ['coder', 'reviewer', 'chef']) {
    l.werkzeugaufruf({ name: 'Agent', input: { subagent_type: rolle, description: 'x' } })
    assert.equal(l.zustand.rolle, rolle)
    assert.equal(l.zustand.taetig, rolle)
  }
})

test('ein unbekannter Subagent aendert die Rolle nicht', (t) => {
  const { l } = lauf(t)
  l.werkzeugaufruf({ name: 'Agent', input: { subagent_type: 'coder', description: 'x' } })
  l.werkzeugaufruf({ name: 'Agent', input: { subagent_type: 'was-auch-immer', description: 'y' } })
  assert.equal(l.zustand.rolle, 'coder')
  assert.equal(l.zustand.taetig, 'coder')
})

// ------------------------------------------------- 4. Die Anzeige

test('das Dashboard kennt eine Obergrenze fuer "denkt"', () => {
  // "denkt" ohne Obergrenze war die bequemste Erklaerung fuer alles: der Lauf
  // stand vier Stunden tot da, und auf dem Schirm dachte er nach.
  const app = fs.readFileSync(path.join(WURZEL, 'public/app.js'), 'utf8')
  assert.match(app, /const STILLE_STEHT\s*=\s*\d+/)
  assert.match(app, /ohne Ereignis · steht/)
  // Und die Leitung ist ein eigener Zustand: eine tote Verbindung kann ein
  // zuletzt empfangenes laeuft=true nicht mehr widerrufen.
  assert.match(app, /quelle\.onerror = \(\) => \{ zustand\.verbunden = false/)
  assert.match(app, /return 'VERBINDUNG WEG'/)
})
