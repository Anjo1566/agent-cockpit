'use strict'

// Der Kern des schwersten Cockpit-Befunds aus dem Review.
//
// Der Server hoert nur auf 127.0.0.1, und das galt als Schutz. Es ist keiner:
// "nur localhost" heisst "nur von diesem Rechner", nicht "nur von dieser
// Seite". Jede Webseite, die der Betreiber nebenbei offen hat, darf ihrem
// Browser ein POST an 127.0.0.1 auftragen.
//
// Der uebliche Riegel waere die Preflight-Anfrage. Die entfaellt bei einem
// "einfachen" Request, und `Content-Type: text/plain` genuegt dafuer, weil
// koerperLesen() den Koerper unabhaengig vom Content-Type als JSON liest. Im
// Review wurde damit live TASKS.md ueberschrieben und committet und der
// Testbefehl auf eine Shell-Zeile gesetzt, die loop.sh anschliessend ausfuehrt.

const test = require('node:test')
const assert = require('node:assert/strict')

const { erlaubt } = require('../lib/herkunft.js')

const anfrage = (headers, method = 'POST') => ({ method, headers })

test('eine Anfrage von der eigenen Seite geht durch', () => {
  for (const origin of [
    'http://localhost:4173',
    'https://localhost:4173',
    'http://127.0.0.1:4173',
    'https://127.0.0.1:8080'
  ]) {
    const urteil = erlaubt(anfrage({ host: 'localhost:4173', origin }))
    assert.equal(urteil.ok, true, `${origin} muss erlaubt sein`)
  }
})

test('eine Anfrage von einer fremden Seite wird abgewiesen', () => {
  // Genau der Aufruf aus dem Review, nur mit dem Kopf, den der Browser
  // zwangsweise mitschickt.
  const urteil = erlaubt(anfrage({ host: '127.0.0.1:4173', origin: 'https://evil.example' }))
  assert.equal(urteil.ok, false)
  assert.match(urteil.grund, /evil\.example/)
})

test('ein Origin, der nur so aussieht wie localhost, reicht nicht', () => {
  // Klassischer Praefix-Fehler: "localhost.evil.example" faengt mit
  // "localhost" an und ist trotzdem eine fremde Domain.
  for (const origin of [
    'https://localhost.evil.example',
    'https://notlocalhost',
    'https://127.0.0.1.evil.example',
    'http://localhosts'
  ]) {
    const urteil = erlaubt(anfrage({ host: 'localhost:4173', origin }))
    assert.equal(urteil.ok, false, `${origin} darf nicht durchgehen`)
  }
})

test('DNS-Rebinding faellt am Host-Kopf auf', () => {
  // Eine Domain, die auf 127.0.0.1 zeigt, macht die fremde Seite
  // gleichursprünglich -- dann passt sogar der Origin. Der Host-Kopf traegt
  // aber weiterhin den Domainnamen.
  const urteil = erlaubt(anfrage({ host: 'rebind.evil.example', origin: 'http://rebind.evil.example' }))
  assert.equal(urteil.ok, false)
  assert.match(urteil.grund, /Rebinding|Hostnamen/)
})

test('ohne Origin ist es keine Seite, sondern eine Shell', () => {
  // curl und Skripte schicken keinen Origin. Sie zu sperren brächte nichts:
  // wer eine Shell auf diesem Rechner hat, braucht den Umweg ueber den
  // Browser nicht. Der Schutz richtet sich gegen SEITEN.
  assert.equal(erlaubt(anfrage({ host: 'localhost:4173' })).ok, true)
  assert.equal(erlaubt(anfrage({ host: '127.0.0.1:4173', origin: '' })).ok, true)
  assert.equal(erlaubt(anfrage({ host: 'localhost:4173', origin: 'null' })).ok, true)
})

test('lesende Anfragen sind davon nicht betroffen', () => {
  // Die Pruefung haengt in server.js an der Methode. Ein GET aendert nichts
  // und darf nicht an einem fehlenden Kopf scheitern.
  assert.equal(erlaubt(anfrage({ host: 'localhost:4173' }, 'GET')).ok, true)
})

test('IPv6-Localhost und Ports werden richtig gelesen', () => {
  assert.equal(erlaubt(anfrage({ host: '[::1]:4173', origin: 'http://[::1]:4173' })).ok, true)
  assert.equal(erlaubt(anfrage({ host: 'localhost' })).ok, true)
})

test('ein unlesbarer Origin wird abgewiesen, nicht ignoriert', () => {
  // Fail-closed: was der Server nicht beurteilen kann, laesst er nicht durch.
  const urteil = erlaubt(anfrage({ host: 'localhost:4173', origin: 'nicht-mal-eine-url' }))
  assert.equal(urteil.ok, false)
})
