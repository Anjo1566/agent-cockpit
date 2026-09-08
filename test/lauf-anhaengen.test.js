'use strict'

// Ein Cockpit, das neu gestartet wird, waehrend im Projekt eine Runde laeuft,
// zeigte "BEREIT". Der Merker verhinderte nur einen zweiten Start; den ersten
// holte er nicht auf den Schirm. Wer das Fenster schloss, sah bis zum Ende des
// Laufs nichts mehr -- also genau waehrend der Stunden, fuer die das Programm
// gebaut ist.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const { Lauf } = require('../lib/lauf.js')

function tempdir () {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-anhaengen-')))
}

/** Ein Prozess, der lange genug lebt, um als "laeuft noch" zu gelten. */
function schlafender () {
  const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  return p
}

test('wiederaufnehmen haengt sich an einen fremden Lauf', async () => {
  const projekt = tempdir()
  fs.mkdirSync(path.join(projekt, '.agents'), { recursive: true })
  const kind = schlafender()
  try {
    fs.writeFileSync(path.join(projekt, '.agents', 'loop-laeuft.pid'), String(kind.pid))
    fs.writeFileSync(path.join(projekt, '.agents', 'round-3.ndjson'), '')

    const lauf = new Lauf()
    const zustand = lauf.wiederaufnehmen([projekt])
    try {
      assert.ok(zustand, 'ein lebender Merker muss erkannt werden')
      assert.equal(zustand.laeuft, true)
      assert.equal(zustand.projekt, projekt)
      assert.equal(zustand.runde, 3, 'die Rundennummer kommt aus dem juengsten Ereignisstrom')
      assert.equal(zustand.wiederaufgenommen, true,
        'das Brett muss sagen koennen, dass ihm der Anfang fehlt')
      assert.equal(zustand.fremdePid, kind.pid)
    } finally {
      clearInterval(lauf.fremdWache)
      lauf.stopTailer()
    }
  } finally {
    kind.kill()
  }
})

test('wiederaufnehmen laesst eine Leiche liegen', () => {
  const projekt = tempdir()
  fs.mkdirSync(path.join(projekt, '.agents'), { recursive: true })
  // Eine PID, die es mit an Sicherheit grenzender Wahrscheinlichkeit nicht gibt.
  fs.writeFileSync(path.join(projekt, '.agents', 'loop-laeuft.pid'), '999999')
  const lauf = new Lauf()
  assert.equal(lauf.wiederaufnehmen([projekt]), null,
    'ein Merker ohne lebenden Prozess ist kein laufender Lauf')
  assert.equal(lauf.zustand.laeuft, false)
})

test('wiederaufnehmen tut nichts, wenn hier schon ein Lauf laeuft', () => {
  const lauf = new Lauf()
  lauf.zustand.laeuft = true
  assert.equal(lauf.wiederaufnehmen(['/gibt/es/nicht']), null)
})

test('wiederaufnehmen vertraegt Projekte ohne .agents', () => {
  const lauf = new Lauf()
  assert.equal(lauf.wiederaufnehmen([tempdir()]), null)
})
