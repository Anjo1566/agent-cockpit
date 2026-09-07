'use strict'

// lauf.js ist die Uebersetzung zwischen dem Loop und dem Dashboard. Erkennt
// eine Zeile nicht, zeigt das Cockpit einen falschen Zustand an -- und das
// faellt niemandem auf, weil daneben trotzdem Zahlen stehen.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { Lauf, ROLLEN } = require('../lib/lauf.js')

/** Ein Lauf, der nichts startet, mit Ereignissammler. */
function lauf (t) {
  const l = new Lauf()
  const ereignisse = []
  l.on('ereignis', (e) => ereignisse.push(e))
  l.zustand.projekt = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-lauf-'))
  // tailStart legt ein Intervall an; ohne das Aufraeumen endet der Testlauf nie.
  t.after(() => l.stopTailer())
  return { l, ereignisse, vom: (typ) => ereignisse.filter(e => e.typ === typ) }
}

test('ROLLEN sind die drei, die das Diagramm kennt', () => {
  assert.deepEqual([...ROLLEN].sort(), ['chef', 'coder', 'reviewer'])
})

test('jede Zeile geht als Log durch, leere nicht', (t) => {
  const { l, vom } = lauf(t)
  l.skriptZeile('irgendwas')
  l.skriptZeile('')
  assert.deepEqual(vom('log').map(e => e.zeile), ['irgendwas'])
})

test('die Rundenzeile setzt Runde, Modell und Aufwand', (t) => {
  const { l, vom } = lauf(t)
  l.skriptZeile('=== Runde 3/30 — opus / xhigh ===')
  assert.equal(l.zustand.runde, 3)
  assert.equal(l.zustand.runden, 30)
  assert.equal(l.zustand.modell, 'opus')
  assert.equal(l.zustand.aufwand, 'xhigh')
  assert.equal(l.zustand.rolle, 'chef')
  assert.deepEqual(vom('runde')[0], { typ: 'runde', t: vom('runde')[0].t, i: 3, max: 30, modell: 'opus', aufwand: 'xhigh' })
})

// --- Die Note -------------------------------------------------------------

test('die Notenzeile setzt Note, Zielnote und Notenband', (t) => {
  const { l, vom } = lauf(t)
  l.skriptZeile('=== Runde 1/30 — sonnet / high ===')
  l.skriptZeile('Note nach Runde 1: 6.4 von 10 (Ziel 8.5) — die Tests decken die Fehlerpfade nicht ab')

  assert.equal(l.zustand.note, 6.4)
  assert.equal(l.zustand.zielnote, 8.5)
  assert.deepEqual(l.zustand.notenband, [{ i: 1, note: 6.4 }])

  const e = vom('note')[0]
  assert.equal(e.note, 6.4)
  assert.equal(e.ziel, 8.5)
  assert.equal(e.begruendung, 'die Tests decken die Fehlerpfade nicht ab')
})

test('die Notenzeile kommt auch ohne Begruendung durch', (t) => {
  const { l, vom } = lauf(t)
  l.skriptZeile('Note nach Runde 2: 10 von 10 (Ziel 8.5)')
  assert.equal(l.zustand.note, 10)
  assert.equal(vom('note')[0].begruendung, null)
})

test('das Notenband sammelt jede Runde', (t) => {
  const { l } = lauf(t)
  l.skriptZeile('Note nach Runde 1: 5 von 10 (Ziel 8.5) — a')
  l.skriptZeile('Note nach Runde 2: 6.5 von 10 (Ziel 8.5) — b')
  l.skriptZeile('Note nach Runde 3: 8.5 von 10 (Ziel 8.5) — c')
  assert.deepEqual(l.zustand.notenband, [{ i: 1, note: 5 }, { i: 2, note: 6.5 }, { i: 3, note: 8.5 }])
  assert.equal(l.zustand.note, 8.5)
})

test('eine Runde ohne Note meldet das, statt die alte stehenzulassen', (t) => {
  const { l, vom } = lauf(t)
  l.skriptZeile('Note nach Runde 1: 7 von 10 (Ziel 8.5) — a')
  l.skriptZeile('Runde 2 hat keine brauchbare Note hinterlassen (.agents/grade.json).')
  const letzte = vom('note').at(-1)
  assert.equal(letzte.note, null)
  assert.equal(l.zustand.notenband.length, 1, 'eine fehlende Note ist ins Band gerutscht')
})

test('die erreichte Zielnote gilt als Ende des Laufs', (t) => {
  const { l, vom } = lauf(t)
  l.skriptZeile('Zielnote erreicht in Runde 7: 8.7 von 10 (Ziel 8.5)')
  assert.ok(l.zustand.ende, 'das Ende wurde nicht erkannt')
  assert.match(l.zustand.ende.grund, /Zielnote erreicht/)
  assert.equal(vom('grund').length, 1)
})

// --- Tests und Abbruchgruende --------------------------------------------

test('eine rote Testsuite faerbt den Zustand und das Rundenband', (t) => {
  const { l, vom } = lauf(t)
  l.skriptZeile('=== Runde 2/30 — sonnet / high ===')
  l.skriptZeile('Testsuite rot — eine Reparaturrunde.')
  assert.equal(l.zustand.tests.gruen, false)
  assert.deepEqual(l.zustand.rundenband.find(r => r.i === 2).gruen, false)
  assert.equal(vom('tests')[0].gruen, false)
})

test('eine gesunkene Testanzahl kommt mit beiden Zahlen an', (t) => {
  const { l, vom } = lauf(t)
  l.skriptZeile('Testanzahl gesunken (34 auf 30) in Runde 5')
  assert.equal(l.zustand.tests.anzahl, 30)
  assert.equal(l.zustand.tests.gruen, false)
  assert.equal(vom('tests')[0].gefallenVon, 34)
})

for (const grund of [
  'Auftrag erledigt in Runde 4',
  'Rundenlimit 30 erreicht',
  'Runde 3 ohne Commit, Stillstand',
  '2 Runden ohne Codeänderung (Runde 6), der Agent dreht im Kreis',
  'Testsuite auch nach der Reparaturrunde rot (Runde 8)',
  'Session in Runde 2 abgebrochen (Rückgabewert 1): limit',
  'Runde 9 hat bestehende Tests geändert: test/a.test.js'
]) {
  test(`Abbruchgrund erkannt: ${grund.slice(0, 32)}`, (t) => {
    const { l, vom } = lauf(t)
    l.skriptZeile(grund)
    assert.equal(l.zustand.ende.grund, grund)
    assert.equal(vom('grund').length, 1)
  })
}

test('eine harmlose Zeile ist kein Abbruchgrund', (t) => {
  const { l, vom } = lauf(t)
  l.skriptZeile('Opus-Eskalationen aufgebraucht, Runde läuft auf Sonnet.')
  assert.equal(l.zustand.ende, null)
  assert.equal(vom('grund').length, 0)
})

test('der Link zum Pull Request wird herausgefischt', (t) => {
  const { l, vom } = lauf(t)
  l.skriptZeile('https://github.com/Anjo1566/agent-loop/pull/7')
  assert.equal(vom('pr')[0].url, 'https://github.com/Anjo1566/agent-loop/pull/7')
})

// --- Der Ereignisstrom der Sitzung ---------------------------------------

test('eine Guard-Blockade wird gezaehlt und benannt', (t) => {
  const { l, vom } = lauf(t)
  l.stromZeile({
    type: 'system',
    subtype: 'hook_response',
    exit_code: 2,
    hook_name: 'PreToolUse',
    stderr: 'irgendwas davor\nBlocked: existing tests must not be changed.'
  })
  assert.equal(l.zustand.guards, 1)
  assert.equal(l.zustand.gesperrt.meldung, 'Blocked: existing tests must not be changed.')
  assert.equal(vom('guard').length, 1)
})

test('ein Hook mit Rueckgabewert 0 blockiert nichts', (t) => {
  const { l, vom } = lauf(t)
  l.stromZeile({ type: 'system', subtype: 'hook_response', exit_code: 0, stderr: '' })
  assert.equal(l.zustand.guards, 0)
  assert.equal(vom('guard').length, 0)
})

test('das Rundenergebnis bringt Kosten und Turns mit', (t) => {
  const { l, vom } = lauf(t)
  l.stromZeile({ type: 'result', total_cost_usd: 1.2345, num_turns: 42 })
  assert.equal(l.zustand.kosten, 1.2345)
  assert.equal(l.zustand.turns, 42)
  assert.deepEqual(
    { usd: vom('kosten')[0].usd, turns: vom('kosten')[0].turns },
    { usd: 1.2345, turns: 42 }
  )
})

// --- QUESTIONS.md ---------------------------------------------------------

test('fragenPruefen zaehlt die Eintraege und meldet nur die neuen', (t) => {
  const { l, vom } = lauf(t)
  const datei = path.join(l.zustand.projekt, 'QUESTIONS.md')

  fs.writeFileSync(datei, '# Fragen\n\n- Erste offene Frage\n', 'utf8')
  l.fragenPruefen()
  assert.equal(l.zustand.fragen, 1)
  assert.deepEqual(vom('frage').map(e => e.text), ['Erste offene Frage'])

  fs.writeFileSync(datei, '# Fragen\n\n- Erste offene Frage\n- Zweite offene Frage\n', 'utf8')
  l.fragenPruefen()
  assert.equal(l.zustand.fragen, 2)
  assert.deepEqual(vom('frage').map(e => e.text), ['Erste offene Frage', 'Zweite offene Frage'])
})

test('fragenPruefen kommt ohne QUESTIONS.md klar', (t) => {
  const { l, vom } = lauf(t)
  l.fragenPruefen()
  assert.equal(vom('fragenstand').length, 0)
})

test('fragenPruefen zaehlt nur Aufzaehlungszeilen', (t) => {
  const { l } = lauf(t)
  fs.writeFileSync(path.join(l.zustand.projekt, 'QUESTIONS.md'),
    '# Fragen\n\nEin Absatz, keine Frage.\n\n- Eine Frage\n*  Noch eine\n-\n', 'utf8')
  l.fragenPruefen()
  assert.equal(l.zustand.fragen, 2)
})

// --- Starten --------------------------------------------------------------

test('starten verweigert ein unsauberes Arbeitsverzeichnis und nennt die Dateien', (t) => {
  const { l } = lauf(t)
  const { execFileSync } = require('node:child_process')
  const dir = l.zustand.projekt
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'offen.txt'), 'x\n', 'utf8')

  assert.throws(() => l.starten(dir, 1), (f) => {
    assert.match(f.message, /nicht sauber/)
    assert.match(f.message, /offen\.txt/)
    return true
  })
  assert.equal(l.zustand.laeuft, false)
})

test('starten verweigert einen zweiten Lauf', (t) => {
  const { l } = lauf(t)
  l.zustand.laeuft = true
  assert.throws(() => l.starten(l.zustand.projekt, 1), /laeuft bereits/)
})

test('stoppen wirft, wenn nichts laeuft', (t) => {
  const { l } = lauf(t)
  assert.throws(() => l.stoppen('sanft'), /laeuft gerade nichts/)
})
