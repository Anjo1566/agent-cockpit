'use strict'

// Deckt einen Aliasing-Fehler in verbrauchZaehlen ab: sende() kopiert sein
// Payload nur flach, bevor es in this.verlauf abgelegt wird. Ohne eine tiefe
// Kopie von proModell teilen sich alle historischen 'verbrauch'-Ereignisse
// im Verlauf dieselbe proModell-Referenz -- und jede weitere Runde
// veraendert damit rueckwirkend auch schon gesendete Ereignisse. Das
// verfaelscht den Verlauf, den server.js an spaet beitretende SSE-Clients
// per lauf.verlauf.slice(-120) weiterreicht.
//
// Diese Datei ist neu (test/verbrauch.test.js bleibt unveraendert, weil der
// Datei-Guard bestehende, von git bereits verfolgte Testdateien sperrt --
// unabhaengig davon, was eine Aufgabenbeschreibung ueber "frozen" behauptet;
// massgeblich ist die tatsaechliche Guard-Entscheidung, siehe CLAUDE.md).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { Lauf } = require('../lib/lauf.js')

/** Ein Lauf, der nichts startet, mit Ereignissammler -- wie in test/lauf.test.js. */
function lauf (t) {
  const l = new Lauf()
  const ereignisse = []
  l.on('ereignis', (e) => ereignisse.push(e))
  l.zustand.projekt = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-verbrauch-verlauf-'))
  t.after(() => l.stopTailer())
  return { l, ereignisse, vom: (typ) => ereignisse.filter(e => e.typ === typ) }
}

test('ein bereits gesendetes verbrauch-Ereignis aendert sich nicht rueckwirkend, wenn ein spaeteres Ereignis dasselbe Modell weiterzaehlt', (t) => {
  const { l, vom } = lauf(t)

  l.stromZeile({
    type: 'result',
    modelUsage: { opus: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 1, cacheCreationInputTokens: 2 } }
  })

  const erstesEreignis = vom('verbrauch')[0]
  const schnappschussVorher = JSON.parse(JSON.stringify(erstesEreignis.proModell))

  l.stromZeile({
    type: 'result',
    modelUsage: { opus: { inputTokens: 90, outputTokens: 45, cacheReadInputTokens: 9, cacheCreationInputTokens: 8 } }
  })

  // Das Objekt, das beim ersten Aufruf tatsaechlich verschickt (und im
  // Verlauf abgelegt) wurde, darf nicht die Summe des zweiten Ereignisses
  // uebernehmen -- proModell muss dort eine unabhaengige Kopie sein.
  assert.deepEqual(erstesEreignis.proModell, schnappschussVorher)
  assert.deepEqual(erstesEreignis.proModell.opus, {
    eingabe: 10,
    ausgabe: 5,
    cacheGelesen: 1,
    cacheGeschrieben: 2
  })

  // Zur Kontrolle: Gesamtverbrauch UND das zweite Ereignis zeigen die neue Summe.
  assert.deepEqual(l.zustand.verbrauch.proModell.opus, {
    eingabe: 100,
    ausgabe: 50,
    cacheGelesen: 10,
    cacheGeschrieben: 10
  })
  const zweitesEreignis = vom('verbrauch')[1]
  assert.deepEqual(zweitesEreignis.proModell.opus, {
    eingabe: 100,
    ausgabe: 50,
    cacheGelesen: 10,
    cacheGeschrieben: 10
  })

  // Und dasselbe gilt fuer das Objekt, das tatsaechlich in l.verlauf liegt --
  // genau das, was server.js an spaet beitretende SSE-Clients weiterreicht.
  const verlaufEreignis = l.verlauf.filter(e => e.typ === 'verbrauch')[0]
  assert.deepEqual(verlaufEreignis.proModell.opus, {
    eingabe: 10,
    ausgabe: 5,
    cacheGelesen: 1,
    cacheGeschrieben: 2
  })
})

test('modelUsage mit fehlendem Einzelfeld faellt in proModell auf 0 zurueck, nicht auf NaN', (t) => {
  const { l } = lauf(t)

  l.stromZeile({
    type: 'result',
    usage: { input_tokens: 5 },
    modelUsage: { 'claude-sonnet-5': { inputTokens: 5 } }
  })

  assert.equal(l.zustand.verbrauch.eingabe, 5)
  assert.equal(l.zustand.verbrauch.ausgabe, 0)
  assert.equal(l.zustand.verbrauch.cacheGeschrieben, 0)
  assert.equal(l.zustand.verbrauch.cacheGelesen, 0)
  assert.deepEqual(l.zustand.verbrauch.proModell['claude-sonnet-5'], {
    eingabe: 5,
    ausgabe: 0,
    cacheGelesen: 0,
    cacheGeschrieben: 0
  })
})
