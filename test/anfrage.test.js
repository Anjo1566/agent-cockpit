'use strict'

// server.js hatte keinen einzigen eigenen Test, weil koerperLesen und
// projektPfad nur ueber einen echten HTTP-Server erreichbar waren. Beide sind
// jetzt in lib/anfrage.js und lassen sich hier direkt aufrufen -- projektPfad
// mit einem temporaeren Wurzel-Verzeichnis statt WURZEL, koerperLesen mit
// einem gefaelschten Anfrage-Objekt statt einer echten Verbindung.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { execFileSync } = require('node:child_process')

const { koerperLesen, projektPfad } = require('../lib/anfrage.js')

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

// --- projektPfad -----------------------------------------------------------

test('ein Pfad ausserhalb der Wurzel wird abgewiesen', () => {
  const wurzel = tempdir('cockpit-wurzel-')
  const anderswo = repo(tempdir('cockpit-anderswo-'))
  assert.throws(() => projektPfad(anderswo, wurzel), /liegt ausserhalb der Wurzel/)
})

test('ein Geschwisterverzeichnis, dessen Name die Wurzel nur als Zeichenkettenpraefix teilt, wird abgewiesen', () => {
  // Das ist genau die Buggklasse, die der echte (aufgeloeste) Pfadvergleich in
  // projektPfad verhindern soll: WURZEL = ".../xyz-abc" und ein Kandidat
  // ".../xyz-abc-evil" faengt als Zeichenkette mit WURZEL an, liegt aber nicht
  // darunter. Ein blosses `startsWith(wurzel)` haette das durchgelassen.
  const basis = tempdir('cockpit-praefix-')
  const wurzel = path.join(basis, 'xyz-abc')
  fs.mkdirSync(wurzel)
  const boese = repo(path.join(basis, 'xyz-abc-evil'))
  assert.throws(() => projektPfad(boese, wurzel), /liegt ausserhalb der Wurzel/)
})

test('".." im Pfad wird akzeptiert, wenn der aufgeloeste Pfad innerhalb der Wurzel landet', () => {
  // path.resolve loest ".." auf, bevor projektPfad die Pruefung ueberhaupt
  // sieht -- hier landet der Kandidat trotz ".." wieder innerhalb der Wurzel.
  const wurzel = tempdir('cockpit-wurzel-')
  fs.mkdirSync(path.join(wurzel, 'sub'))
  const projekt = repo(path.join(wurzel, 'projekt'))
  const mitPunktpunkt = path.join(wurzel, 'sub', '..', 'projekt')
  assert.equal(projektPfad(mitPunktpunkt, wurzel), projekt)
})

test('".." im Pfad wird abgewiesen, wenn der aufgeloeste Pfad die Wurzel verlaesst', () => {
  const basis = tempdir('cockpit-basis-')
  const wurzel = path.join(basis, 'wurzel')
  fs.mkdirSync(wurzel)
  const draussen = repo(path.join(basis, 'draussen'))
  const mitPunktpunkt = path.join(wurzel, '..', 'draussen')
  assert.throws(() => projektPfad(mitPunktpunkt, wurzel), /liegt ausserhalb der Wurzel/)
  assert.equal(fs.realpathSync(path.resolve(mitPunktpunkt)), draussen)
})

test('ein Symlink innerhalb der Wurzel, der nach draussen zeigt, wird abgewiesen', (t) => {
  const wurzel = tempdir('cockpit-wurzel-')
  const draussen = repo(tempdir('cockpit-draussen-'))
  const link = path.join(wurzel, 'link')

  try {
    fs.symlinkSync(draussen, link, 'dir')
  } catch (f) {
    // Auf Windows braucht ein echter Symlink meist ein Privileg, das eine
    // Sandbox nicht hat (EPERM). Eine Junction leistet fuer ein Verzeichnis
    // dasselbe und braucht keins.
    if (f.code !== 'EPERM' || process.platform !== 'win32') throw f
    fs.symlinkSync(draussen, link, 'junction')
  }

  // Der String faengt mit wurzel an -- genau der Fall, den der Kommentar in
  // projektPfad beschreibt: nur die aufgeloeste Realitaet zaehlt.
  assert.throws(() => projektPfad(link, wurzel), /liegt ausserhalb der Wurzel/)
})

test('ein Verzeichnis ohne .git ist kein Projekt', () => {
  const wurzel = tempdir('cockpit-wurzel-')
  const keinRepo = path.join(wurzel, 'nicht-versioniert')
  fs.mkdirSync(keinRepo)
  assert.throws(() => projektPfad(keinRepo, wurzel), /kein Git-Repository/)
})

test('ein leerer oder fehlender Wert wirft ohne den Dateisystempruefpfad zu betreten', () => {
  const wurzel = tempdir('cockpit-wurzel-')
  assert.throws(() => projektPfad('', wurzel), /Kein Projekt angegeben/)
  assert.throws(() => projektPfad(undefined, wurzel), /Kein Projekt angegeben/)
})

// --- koerperLesen ------------------------------------------------------

/** Eine gefaelschte Anfrage: koerperLesen braucht nur on() und destroy(). */
function fakeAnfrage () {
  const emitter = new EventEmitter()
  emitter.destroy = () => {}
  return emitter
}

test('koerperLesen loest mit dem geparsten Objekt auf', async () => {
  const anfrage = fakeAnfrage()
  const versprechen = koerperLesen(anfrage)
  anfrage.emit('data', '{"pfad":"x","runden":3}')
  anfrage.emit('end')
  assert.deepEqual(await versprechen, { pfad: 'x', runden: 3 })
})

test('koerperLesen loest einen leeren Koerper als leeres Objekt auf', async () => {
  const anfrage = fakeAnfrage()
  const versprechen = koerperLesen(anfrage)
  anfrage.emit('end')
  assert.deepEqual(await versprechen, {})
})

test('koerperLesen weist ungueltiges JSON zurueck', async () => {
  const anfrage = fakeAnfrage()
  const versprechen = koerperLesen(anfrage)
  anfrage.emit('data', '{kein json')
  anfrage.emit('end')
  await assert.rejects(versprechen, /Kein gueltiges JSON/)
})

test('koerperLesen bricht ab, sobald die Grenze ueberschritten ist', async () => {
  // Die 1e6-Byte-Standardgrenze in echt zu streamen waere ein langsamer Test
  // fuer nichts -- die Grenze ist deshalb ein Parameter, hier auf 10 gesetzt.
  //
  // Diese Zusicherung stand einmal umgekehrt: sie verlangte, dass destroy()
  // aufgerufen WIRD. Das war der Fehler selbst, nicht seine Absicherung.
  // IncomingMessage.destroy() reisst in Node immer den darunterliegenden
  // Socket ab, und Anfrage und Antwort teilen sich diesen einen Socket -- der
  // Aufrufer bekam deshalb einen nackten ECONNRESET statt der 400 mit
  // "Zu gross.", die der Code verspricht (im Review mit curl nachgestellt,
  // Exit 55, leerer Rumpf). Die Zusicherung ist jetzt strenger und richtig
  // herum: der Socket darf NICHT abgerissen werden.
  const anfrage = fakeAnfrage()
  let zerstoert = false
  anfrage.destroy = () => { zerstoert = true }
  const versprechen = koerperLesen(anfrage, 10)
  anfrage.emit('data', '01234567890123456789')
  await assert.rejects(versprechen, /Zu gross/)
  assert.equal(zerstoert, false,
    'koerperLesen darf den Socket nicht zerstoeren -- sonst kann der Server die 400 nicht mehr schreiben')
})

test('koerperLesen ignoriert weitere Daten nach dem Abbruch', async () => {
  // Ohne destroy() muss ein Riegel her, sonst waechst der Puffer weiter und
  // die Ablehnung feuert bei jedem Datenpaket erneut.
  const anfrage = fakeAnfrage()
  let ablehnungen = 0
  const versprechen = koerperLesen(anfrage, 10)
  versprechen.catch(() => { ablehnungen++ })
  anfrage.emit('data', '01234567890123456789')
  anfrage.emit('data', 'und noch mehr')
  anfrage.emit('end')
  await assert.rejects(versprechen, /Zu gross/)
  assert.equal(ablehnungen, 1, 'die Ablehnung darf genau einmal geschehen')
})
