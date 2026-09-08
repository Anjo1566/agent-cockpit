'use strict'

// Liest und schreibt den Konfigurationsblock oben in loop.sh.
//
// Warum nicht eine eigene Konfigurationsdatei? Weil loop.sh die Wahrheit ist.
// Wer das Skript direkt im Terminal startet, muss dieselben Werte bekommen wie
// im Cockpit. Zwei Quellen waeren zwei Wahrheiten, und eine davon waere falsch.
//
// Der Block ist an seinen Kommentarzeilen erkennbar:
//   # --- Vom Umsetzer auszufuellen ---...
//   ...
//   # ------...

const fs = require('node:fs')
const path = require('node:path')

const START = /^# --- Vom Umsetzer auszuf/m
const ENDE = /^# ---{5,}\s*$/m

// Was das Cockpit anbietet. Alles andere im Block bleibt unangetastet.
const FELDER = [
  {
    name: 'TESTBEFEHL',
    titel: 'Testbefehl',
    typ: 'text',
    hilfe: 'Muss bei einem fehlgeschlagenen Test einen Wert ungleich 0 zurueckgeben.',
    beispiele: ['node --test', 'npm test', 'pytest -q', 'cargo test']
  },
  {
    name: 'TESTZAEHLER',
    titel: 'Testzaehler',
    typ: 'text',
    hilfe: 'Gibt die Anzahl Tests als blosse Zahl aus, immer, auch bei roter Suite.'
  },
  {
    name: 'MAX_TURNS',
    titel: 'Turns pro Runde',
    typ: 'zahl',
    min: 10,
    max: 1000,
    hilfe: 'Harter Deckel. Erreicht der Agent ihn, bricht der Lauf ab.'
  },
  {
    name: 'MAX_OPUS_RUNDEN',
    titel: 'Opus-Eskalationen',
    typ: 'zahl',
    min: 0,
    max: 50,
    hilfe: 'So oft darf der Chef auf Opus hochschalten. Danach laeuft es wieder auf Sonnet.'
  },
  {
    name: 'MAX_BUDGET_USD',
    titel: 'Budget pro Runde',
    typ: 'zahl',
    min: 1,
    max: 200,
    einheit: 'USD',
    hilfe: 'Notbremse. Schaetzwert zu Listenpreisen, kein echtes Geld auf dem Abo.'
  },
  {
    name: 'MAX_LEERRUNDEN',
    titel: 'Leerrunden',
    typ: 'zahl',
    min: 1,
    max: 10,
    hilfe: 'So viele Runden ohne Codeaenderung, dann bricht der Lauf ab.'
  },
  {
    name: 'ZIELNOTE',
    titel: 'Zielnote',
    typ: 'dezimal',
    min: 0,
    max: 10,
    schritt: 0.5,
    hilfe: 'Ab dieser Gesamtnote des graders endet der Lauf. 8.5 ist streng, 10 erreicht praktisch niemand.'
  },
  {
    name: 'BASIS_BRANCH',
    titel: 'Zielbranch',
    typ: 'text',
    hilfe: 'Von hier verzweigt der Lauf, und hierhin geht der Pull Request.'
  },
  // Die beiden Wachhund-Grenzen standen zwar in loop.sh, aber nicht hier --
  // ausgerechnet die zwei Werte, die entscheiden, ob eine gesunde Runde
  // abgeschossen wird. Wer eine lange Explore-Delegation fuer normal haelt,
  // musste dafuer in den Editor. (Befund B2-1 und B2-2 aus dem Review.)
  {
    name: 'MAX_STILLE',
    titel: 'Stille bis Abbruch',
    typ: 'zahl',
    min: 60,
    max: 7200,
    einheit: 's',
    hilfe: 'So lange darf der Ereignisstrom stillstehen, bevor der Wachhund die Runde beendet. Zu knapp, und eine lange Recherche wird abgeschossen; zu grosszuegig, und ein haengender Lauf faellt spaet auf.'
  },
  {
    name: 'MAX_RUNDE',
    titel: 'Zeitgrenze je Runde',
    typ: 'zahl',
    min: 300,
    max: 86400,
    einheit: 's',
    hilfe: 'Harte Obergrenze fuer eine Runde, unabhaengig davon, wie fleissig sie aussieht.'
  },
  // Der Wachhund bewacht nur die Sitzung. Der Testbefehl laeuft danach, und er
  // fuehrt Code aus, den der Agent selbst geschrieben hat: eine Endlosschleife
  // in einer Quelldatei liess loop.sh frueher unbegrenzt warten.
  {
    name: 'MAX_TEST',
    titel: 'Zeitgrenze Testlauf',
    typ: 'zahl',
    min: 30,
    max: 86400,
    einheit: 's',
    hilfe: 'So lange darf ein Testlauf hoechstens dauern. Danach wird er beendet und der Lauf endet mit Grund. Grosszuegig setzen: eine langsame Suite ist kein Defekt.'
  }
]

function pfad (projekt) {
  return path.join(projekt, 'loop.sh')
}

function block (text) {
  const a = text.match(START)
  if (!a) throw new Error('In loop.sh fehlt der Konfigurationsblock.')
  const rest = text.slice(a.index)
  const b = rest.slice(1).match(ENDE)
  if (!b) throw new Error('Der Konfigurationsblock in loop.sh ist nicht abgeschlossen.')
  const von = a.index
  const bis = a.index + 1 + b.index + b[0].length
  return { von, bis, inhalt: text.slice(von, bis) }
}

function lies (projekt) {
  const text = fs.readFileSync(pfad(projekt), 'utf8')
  const { inhalt } = block(text)
  const werte = {}
  for (const feld of FELDER) {
    const m = inhalt.match(new RegExp('^' + feld.name + '="?([^"\\n#]*?)"?\\s*(#.*)?$', 'm'))
    if (m) werte[feld.name] = m[1].trim()
  }
  return { werte, felder: FELDER }
}

function schreib (projekt, neu) {
  const datei = pfad(projekt)
  const text = fs.readFileSync(datei, 'utf8')
  const { von, bis, inhalt } = block(text)

  let neuerBlock = inhalt
  for (const feld of FELDER) {
    if (!(feld.name in neu)) continue
    const wert = String(neu[feld.name]).trim()

    if (feld.typ === 'zahl' || feld.typ === 'dezimal') {
      // Eine Note ist 8.5, keine ganze Zahl. In eine Datei, die als Shell-Skript
      // laeuft, darf sie trotzdem nur als blosse Zahl.
      const dezimal = feld.typ === 'dezimal'
      if (dezimal && !/^[0-9]+([.][0-9]+)?$/.test(wert)) {
        throw new Error(feld.titel + ': nur Zahlen, Dezimaltrennzeichen ist der Punkt.')
      }
      if (!dezimal && !/^\d+$/.test(wert)) throw new Error(`${feld.titel}: nur ganze Zahlen.`)
      const z = Number(wert)
      if (z < feld.min || z > feld.max) {
        throw new Error(`${feld.titel}: erlaubt ist ${feld.min} bis ${feld.max}.`)
      }
    } else {
      // Nichts Ungeprueftes in eine Datei, die als Shell-Skript laeuft.
      //
      // Das war eine Verbotsliste: verboten waren ", `, $, \ und Zeilenumbruch
      // -- aber nicht ;, | und &. loop.sh fuehrt TESTBEFEHL mit `bash -c` aus,
      // also lief `node --test; irgendwas-anderes` anstandslos durch. Zusammen
      // mit der fehlenden Origin-Pruefung war das eine vollstaendige Kette von
      // einer beliebigen Webseite bis zur Shell-Ausfuehrung; im Review wurde
      // sie nachgestellt.
      //
      // Jetzt umgekehrt, als Erlaubnisliste: ein Testbefehl ist ein Programm
      // mit Argumenten, keine Shell-Zeile. Wer eine Pipeline braucht, legt sie
      // in ein Skript im Projekt und traegt dessen Pfad ein -- dann steht sie
      // versioniert im Repository statt in einem Formularfeld.
      if (wert === '') throw new Error(`${feld.titel}: darf nicht leer sein.`)
      const verboten = wert.match(/[;|&<>(){}$`"'\\\n\r]/)
      if (verboten) {
        throw new Error(
          `${feld.titel}: das Zeichen ${JSON.stringify(verboten[0])} ist hier nicht erlaubt. ` +
          'Erlaubt ist ein Programm mit Argumenten, zum Beispiel "npm test" oder ' +
          '"pytest -q". Fuer eine Pipeline leg ein Skript ins Projekt und trag ' +
          'dessen Pfad ein.'
        )
      }
    }

    const ersatz = (feld.typ === 'zahl' || feld.typ === 'dezimal') ? `${feld.name}=${wert}` : `${feld.name}="${wert}"`
    const zeile = new RegExp('^' + feld.name + '=[^\\n]*$', 'm')
    if (!zeile.test(neuerBlock)) throw new Error(`${feld.name} steht nicht in loop.sh.`)
    neuerBlock = neuerBlock.replace(zeile, (alt) => {
      // Den erklaerenden Kommentar am Zeilenende behalten.
      const kommentar = alt.match(/\s+(#.*)$/)
      return ersatz + (kommentar ? '  ' + kommentar[1] : '')
    })
  }

  fs.writeFileSync(datei, text.slice(0, von) + neuerBlock + text.slice(bis), 'utf8')
  return lies(projekt)
}

module.exports = { lies, schreib, FELDER }
