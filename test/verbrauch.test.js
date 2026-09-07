'use strict'

// Deckt den Tokenverbrauch ab, den stromZeile aus dem result-Ereignis liest:
// Summe ueber den ganzen Lauf, Aufschluesselung pro Modell, und der Fall, dass
// usage im Ereignis ganz fehlt.

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
  l.zustand.projekt = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-verbrauch-'))
  t.after(() => l.stopTailer())
  return { l, ereignisse, vom: (typ) => ereignisse.filter(e => e.typ === typ) }
}

test('ein result mit usage summiert die vier Zaehler und meldet verbrauch', (t) => {
  const { l, vom } = lauf(t)
  l.stromZeile({
    type: 'result',
    total_cost_usd: 0.1,
    num_turns: 1,
    usage: {
      input_tokens: 1200,
      output_tokens: 340,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 8000
    }
  })

  assert.equal(l.zustand.verbrauch.eingabe, 1200)
  assert.equal(l.zustand.verbrauch.ausgabe, 340)
  assert.equal(l.zustand.verbrauch.cacheGeschrieben, 500)
  assert.equal(l.zustand.verbrauch.cacheGelesen, 8000)

  const e = vom('verbrauch')[0]
  assert.equal(e.eingabe, 1200)
  assert.equal(e.ausgabe, 340)
  assert.equal(e.cacheGeschrieben, 500)
  assert.equal(e.cacheGelesen, 8000)
})

test('zwei result-Ereignisse addieren sich zum Gesamtverbrauch des Laufs', (t) => {
  const { l, vom } = lauf(t)
  l.stromZeile({
    type: 'result',
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 }
  })
  l.stromZeile({
    type: 'result',
    usage: { input_tokens: 200, output_tokens: 70, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 }
  })

  assert.equal(l.zustand.verbrauch.eingabe, 300)
  assert.equal(l.zustand.verbrauch.ausgabe, 120)
  assert.equal(l.zustand.verbrauch.cacheGeschrieben, 40)
  assert.equal(l.zustand.verbrauch.cacheGelesen, 60)
  assert.equal(vom('verbrauch').length, 2)
})

test('modelUsage fuellt die Aufschluesselung pro Modell, mit camelCase-Feldern', (t) => {
  const { l } = lauf(t)
  l.stromZeile({
    type: 'result',
    usage: { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 500, cache_read_input_tokens: 8000 },
    modelUsage: {
      'claude-sonnet-5': {
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadInputTokens: 8000,
        cacheCreationInputTokens: 500,
        costUSD: 0.4321
      }
    }
  })

  assert.deepEqual(l.zustand.verbrauch.proModell['claude-sonnet-5'], {
    eingabe: 1200,
    ausgabe: 340,
    cacheGelesen: 8000,
    cacheGeschrieben: 500
  })
})

test('modelUsage summiert ueber mehrere result-Ereignisse pro Modell weiter', (t) => {
  const { l } = lauf(t)
  l.stromZeile({
    type: 'result',
    modelUsage: { opus: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 1, cacheCreationInputTokens: 2 } }
  })
  l.stromZeile({
    type: 'result',
    modelUsage: { opus: { inputTokens: 20, outputTokens: 15, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 } }
  })

  assert.deepEqual(l.zustand.verbrauch.proModell.opus, {
    eingabe: 30,
    ausgabe: 20,
    cacheGelesen: 4,
    cacheGeschrieben: 6
  })
})

test('ein result ohne usage wirft nicht und laesst den Verbrauch unveraendert', (t) => {
  const { l, vom } = lauf(t)
  l.stromZeile({
    type: 'result',
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 }
  })
  const vorher = JSON.parse(JSON.stringify(l.zustand.verbrauch))

  assert.doesNotThrow(() => {
    l.stromZeile({ type: 'result', total_cost_usd: 1, num_turns: 3 })
  })

  assert.deepEqual(l.zustand.verbrauch, vorher)
  // Die bestehende Kosten- und Turn-Verarbeitung im selben Zweig laeuft trotzdem weiter.
  assert.equal(l.zustand.kosten, 1)
  assert.equal(l.zustand.turns, 3)
  assert.deepEqual(
    { usd: vom('kosten')[1].usd, turns: vom('kosten')[1].turns },
    { usd: 1, turns: 3 }
  )
  // verbrauch wird trotzdem gesendet -- die Oberflaeche soll den Fall auch sehen.
  assert.equal(vom('verbrauch').length, 2)
})
