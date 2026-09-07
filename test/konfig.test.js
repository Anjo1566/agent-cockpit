'use strict'

// Der Konfigurationsblock oben in loop.sh ist die einzige Stelle, an der das
// Cockpit in eine Datei schreibt, die anschliessend als Shell-Skript laeuft.
// Was hier durchrutscht, laeuft im naechsten Lauf als Befehl mit.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const konfig = require('../lib/konfig.js')

const KOPF = `#!/usr/bin/env bash
set -euo pipefail

# --- Vom Umsetzer auszufüllen -------------------------------------------
TESTBEFEHL="node --test"                      # muss bei Fehlschlag != 0 liefern
TESTZAEHLER="./.agents/hooks/count-tests.sh"  # gibt die Anzahl Tests als Zahl aus
MAX_TURNS=200               # harter Deckel pro Runde
MAX_OPUS_RUNDEN=5           # so viele Eskalationsrunden auf Opus pro Lauf
MAX_BUDGET_USD=15           # dritte Notbremse pro Runde
MAX_LEERRUNDEN=2            # so viele Runden ohne Codeänderung, dann Abbruch
BASIS_BRANCH="main"         # Zielbranch des Pull Requests
ZIELNOTE=8.5                # ab dieser Gesamtnote ist der Auftrag erledigt
# ------------------------------------------------------------------------

MAX="\${1:-60}"
echo "der Rest des Skripts"
`

/** Ein Wegwerfprojekt mit einer loop.sh darin. */
function projekt (inhalt = KOPF) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-konfig-'))
  fs.writeFileSync(path.join(dir, 'loop.sh'), inhalt, 'utf8')
  return dir
}

test('lies holt alle Felder aus dem Block', () => {
  const { werte, felder } = konfig.lies(projekt())
  assert.equal(werte.TESTBEFEHL, 'node --test')
  assert.equal(werte.MAX_TURNS, '200')
  assert.equal(werte.BASIS_BRANCH, 'main')
  assert.equal(werte.ZIELNOTE, '8.5')
  assert.ok(felder.some(f => f.name === 'ZIELNOTE'), 'ZIELNOTE fehlt in FELDER')
})

test('lies wirft, wenn der Block fehlt', () => {
  const p = projekt('#!/usr/bin/env bash\necho nichts\n')
  assert.throws(() => konfig.lies(p), /Konfigurationsblock/)
})

test('lies wirft, wenn der Block nicht abgeschlossen ist', () => {
  const p = projekt('# --- Vom Umsetzer auszufüllen ---\nTESTBEFEHL="x"\n')
  assert.throws(() => konfig.lies(p), /nicht abgeschlossen/)
})

test('schreib aendert nur den Block und laesst den Rest stehen', () => {
  const p = projekt()
  konfig.schreib(p, { MAX_TURNS: '150' })
  const text = fs.readFileSync(path.join(p, 'loop.sh'), 'utf8')
  assert.match(text, /^MAX_TURNS=150/m)
  assert.match(text, /echo "der Rest des Skripts"/)
  assert.match(text, /^set -euo pipefail$/m)
})

test('schreib behaelt den erklaerenden Kommentar am Zeilenende', () => {
  const p = projekt()
  konfig.schreib(p, { MAX_TURNS: '150' })
  const text = fs.readFileSync(path.join(p, 'loop.sh'), 'utf8')
  assert.match(text, /^MAX_TURNS=150\s+# harter Deckel pro Runde$/m)
})

test('schreib setzt Text in Anfuehrungszeichen, Zahlen ohne', () => {
  const p = projekt()
  konfig.schreib(p, { TESTBEFEHL: 'npm test', MAX_TURNS: '150', ZIELNOTE: '9' })
  const text = fs.readFileSync(path.join(p, 'loop.sh'), 'utf8')
  assert.match(text, /^TESTBEFEHL="npm test"/m)
  assert.match(text, /^MAX_TURNS=150/m)
  assert.match(text, /^ZIELNOTE=9/m)
})

test('ZIELNOTE nimmt eine Dezimalzahl an', () => {
  const p = projekt()
  konfig.schreib(p, { ZIELNOTE: '8.5' })
  assert.equal(konfig.lies(p).werte.ZIELNOTE, '8.5')
})

test('ZIELNOTE weist Komma und Text zurueck', () => {
  const p = projekt()
  assert.throws(() => konfig.schreib(p, { ZIELNOTE: '8,5' }), /Zielnote/)
  assert.throws(() => konfig.schreib(p, { ZIELNOTE: 'sehr gut' }), /Zielnote/)
})

test('ZIELNOTE weist Werte ausserhalb von 0 bis 10 zurueck', () => {
  const p = projekt()
  assert.throws(() => konfig.schreib(p, { ZIELNOTE: '11' }), /0 bis 10/)
})

test('ganzzahlige Felder nehmen keine Dezimalzahl an', () => {
  const p = projekt()
  assert.throws(() => konfig.schreib(p, { MAX_TURNS: '150.5' }), /ganze Zahlen/)
})

test('Zahlenfelder pruefen ihre Grenzen', () => {
  const p = projekt()
  assert.throws(() => konfig.schreib(p, { MAX_TURNS: '5' }), /erlaubt ist/)
  assert.throws(() => konfig.schreib(p, { MAX_TURNS: '10000' }), /erlaubt ist/)
})

// Der eigentliche Grund, warum es diese Datei gibt: alles hier landet in einem
// Skript, das mit `bash` ausgefuehrt wird.
for (const [name, gift] of [
  ['Anfuehrungszeichen', 'npm test"; rm -rf /; echo "'],
  ['Befehlssubstitution', 'npm test $(rm -rf /)'],
  ['Backtick', 'npm test `rm -rf /`'],
  ['Backslash', 'npm test \\'],
  ['Zeilenumbruch', 'npm test\nrm -rf /']
]) {
  test(`schreib weist ${name} in einem Textfeld zurueck`, () => {
    const p = projekt()
    assert.throws(() => konfig.schreib(p, { TESTBEFEHL: gift }))
    assert.equal(konfig.lies(p).werte.TESTBEFEHL, 'node --test', 'die Datei wurde trotzdem veraendert')
  })
}

test('schreib weist ein leeres Textfeld zurueck', () => {
  const p = projekt()
  assert.throws(() => konfig.schreib(p, { TESTBEFEHL: '   ' }), /leer/)
})

test('schreib ignoriert unbekannte Feldnamen', () => {
  const p = projekt()
  konfig.schreib(p, { GIBTSNICHT: 'egal' })
  const text = fs.readFileSync(path.join(p, 'loop.sh'), 'utf8')
  assert.ok(!text.includes('GIBTSNICHT'), 'ein unbekanntes Feld wurde geschrieben')
})

test('schreib wirft, wenn das Feld nicht im Block steht', () => {
  const ohneZielnote = KOPF.split('\n').filter(z => !z.startsWith('ZIELNOTE')).join('\n')
  const p = projekt(ohneZielnote)
  assert.throws(() => konfig.schreib(p, { ZIELNOTE: '9' }), /steht nicht in loop\.sh/)
})

test('schreib und lies sind zueinander invers', () => {
  const p = projekt()
  const neu = {
    TESTBEFEHL: 'npx vitest run',
    MAX_TURNS: '90',
    MAX_OPUS_RUNDEN: '3',
    ZIELNOTE: '7.25',
    BASIS_BRANCH: 'develop'
  }
  konfig.schreib(p, neu)
  const { werte } = konfig.lies(p)
  for (const [k, v] of Object.entries(neu)) assert.equal(werte[k], v, `${k} kam anders zurueck`)
})
