'use strict'

// Prueft, ob eine Anfrage wirklich vom Cockpit selbst kommt.
//
// Warum es das braucht, obwohl der Server nur auf 127.0.0.1 hoert: "nur
// localhost" schuetzt gegen andere Rechner, nicht gegen andere SEITEN. Jede
// Webseite, die der Betreiber nebenbei offen hat, darf ihrem Browser sagen
// "schick ein POST an http://127.0.0.1:4173/api/konfig" -- der Browser tut das,
// vom selben Rechner aus, und der Server sieht eine ganz normale lokale
// Anfrage.
//
// Der uebliche Schutz waere die Preflight-Anfrage des Browsers. Die entfaellt
// aber bei einem "einfachen" Request, und `Content-Type: text/plain` genuegt
// dafuer: koerperLesen() parst den Koerper unabhaengig vom Content-Type, also
// kommt der JSON-Aufruf ohne Preflight durch. Genau so wurde im Review
// nachgestellt, wie eine fremde Seite TASKS.md ueberschreibt und committet und
// den Testbefehl auf eine beliebige Shell-Zeile setzt.
//
// Zwei Kopfzeilen entscheiden:
//
//   Origin  — setzt der Browser bei jedem POST, auch bei einfachen Requests,
//             und eine Seite kann ihn nicht faelschen. Fehlt er, ist die
//             Anfrage nicht von einer Seite gekommen (curl, ein Skript) --
//             das ist erlaubt, denn wer eine Shell hat, braucht den Umweg
//             ueber den Browser nicht.
//   Host    — schuetzt gegen DNS-Rebinding: eine Domain, die auf 127.0.0.1
//             zeigt, macht die fremde Seite gleichursprünglich, und dann
//             passt sogar der Origin. Der Host-Kopf traegt dann aber den
//             Domainnamen und nicht localhost.

// Hostnamen, die wirklich diesen Rechner meinen. Alles andere ist entweder
// eine fremde Domain oder ein Rebinding-Versuch.
const EIGENE_NAMEN = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function hostname (wert) {
  if (!wert) return null
  const roh = String(wert).trim()
  // IPv6 steht in eckigen Klammern; der Port haengt hinten dran.
  const m = roh.match(/^(\[[^\]]*\]|[^:]*)(:\d+)?$/)
  return m ? m[1].toLowerCase() : null
}

/**
 * Darf diese Anfrage den Zustand aendern?
 *
 * @param {import('node:http').IncomingMessage} anfrage
 * @returns {{ok: true} | {ok: false, grund: string}}
 */
function erlaubt (anfrage) {
  const kopf = anfrage.headers || {}

  // Der Host muss dieser Rechner sein, sonst zeigt eine fremde Domain hierher.
  const host = hostname(kopf.host)
  if (host !== null && !EIGENE_NAMEN.has(host)) {
    return {
      ok: false,
      grund: `Diese Anfrage kam ueber den Hostnamen "${host}". Das Cockpit ` +
        'antwortet nur auf localhost und 127.0.0.1 -- eine Domain, die hierher ' +
        'zeigt, ist ein Rebinding-Versuch.'
    }
  }

  // Ohne Origin kommt die Anfrage nicht aus einer Webseite. Ein Browser setzt
  // ihn bei zustandsaendernden Anfragen immer.
  const origin = kopf.origin
  if (origin === undefined || origin === null || origin === '' || origin === 'null') {
    return { ok: true }
  }

  let herkunft
  try {
    herkunft = new URL(String(origin))
  } catch {
    return { ok: false, grund: `Unlesbarer Origin-Kopf: "${origin}".` }
  }
  if (!EIGENE_NAMEN.has(herkunft.hostname.toLowerCase())) {
    return {
      ok: false,
      grund: `Diese Anfrage kam von "${herkunft.origin}". Das Cockpit nimmt ` +
        'Befehle nur von seiner eigenen Seite an. Wenn du das gerade nicht ' +
        'selbst ausgeloest hast, hat eine fremde Seite es versucht.'
    }
  }
  return { ok: true }
}

module.exports = { erlaubt, EIGENE_NAMEN }
