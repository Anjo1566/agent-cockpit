'use strict'

// Liest den Anfragekoerper und prueft Projektpfade aus der Anfrage.
//
// Beides stand bisher direkt in server.js und war deshalb ohne einen echten
// HTTP-Server nicht testbar. Hier herausgeloest, damit beides mit einem
// gefaelschten `anfrage`-Objekt bzw. einem Temp-Verzeichnis als Wurzel
// getestet werden kann.

const fs = require('node:fs')
const path = require('node:path')

const projekte = require('./projekte.js')

/**
 * Liest den Koerper einer Anfrage und parst ihn als JSON.
 *
 * @param {import('node:events').EventEmitter} anfrage  Muss 'data', 'end' und
 *   'error' feuern und eine destroy()-Methode haben -- wie ein echtes
 *   http.IncomingMessage, oder ein Double in einem Test.
 * @param {number} grenze  Maximale Groesse in Bytes, bevor abgebrochen wird.
 */
function koerperLesen (anfrage, grenze = 1e6) {
  return new Promise((fertig, fehler) => {
    let roh = ''
    anfrage.on('data', s => {
      roh += s
      if (roh.length > grenze) { anfrage.destroy(); fehler(new Error('Zu gross.')) }
    })
    anfrage.on('end', () => {
      try { fertig(roh ? JSON.parse(roh) : {}) } catch (e) { fehler(new Error('Kein gueltiges JSON.')) }
    })
    anfrage.on('error', fehler)
  })
}

/** Ein Projektpfad aus der Anfrage, gegen die Wurzel geprueft. */
function projektPfad (wert, wurzel) {
  if (!wert || typeof wert !== 'string') throw new Error('Kein Projekt angegeben.')
  const p = path.resolve(wert)
  // Literaler Vergleich reicht nicht: liegt innerhalb von wurzel ein Symlink
  // oder eine Junction, die nach aussen zeigt, faengt path.relative das nicht
  // ab -- der String faengt ja mit wurzel an, obwohl der tatsaechliche
  // Zielort ausserhalb liegt. Deshalb hier auf den echten (aufgeloesten) Pfad
  // pruefen. realpathSync wirft bei nicht existierenden Pfaden; das faengt
  // istRepo unten ohnehin mit derselben Fehlermeldung ab, also wird das hier
  // als "kein Repo" statt als Absturz behandelt.
  let echterPfad
  try {
    echterPfad = fs.realpathSync(p)
  } catch {
    throw new Error('Das ist kein Git-Repository.')
  }
  // Eigener try/catch: hier scheitert nicht der Kandidat, sondern die vom
  // Server konfigurierte Wurzel selbst -- ein anderer Fehlerfall als "kein
  // Repo" oder "ausserhalb der Wurzel", also eine eigene Meldung.
  let echteWurzel
  try {
    echteWurzel = fs.realpathSync(path.resolve(wurzel))
  } catch {
    throw new Error('Wurzelverzeichnis des Servers nicht erreichbar.')
  }
  const relativ = path.relative(echteWurzel, echterPfad)
  if (relativ.startsWith('..') || path.isAbsolute(relativ)) throw new Error('Dieses Projekt liegt ausserhalb der Wurzel.')
  if (!projekte.istRepo(p)) throw new Error('Das ist kein Git-Repository.')
  return p
}

module.exports = { koerperLesen, projektPfad }
