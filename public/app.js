'use strict'

/* REISSBRETT — Cockpit für den Agenten-Loop.
 *
 * Die tragende Entscheidung: die Oberfläche wird IMMER vollständig aus dem
 * Zustandsobjekt gezeichnet, nie aus einer Abfolge von Animationen. Animationen
 * werden von Zustandsänderungen ausgelöst, aber sie besitzen keinen Wert.
 * Verpasst man ein Ereignis oder trifft eines mitten in eine laufende Übergabe,
 * setzt der nächste render() alles wieder gerade. Ohne diese Regel hängt nach
 * einer halben Stunde die falsche Rolle gross auf dem Schirm, und nichts
 * repariert das je.
 */

const NS = 'http://www.w3.org/2000/svg'

const ROLLEN = {
  chef:     { cx: 600, cy: 132, name: 'CHEF',     kuerzel: 'CHF', farbe: 'var(--role-chef)',     massOben: true,  ruhe: 'wählt, delegiert, entscheidet' },
  coder:    { cx: 250, cy: 512, name: 'CODER',    kuerzel: 'COD', farbe: 'var(--role-coder)',    massOben: false, ruhe: 'setzt genau eine Aufgabe um' },
  reviewer: { cx: 950, cy: 512, name: 'REVIEWER', kuerzel: 'REV', farbe: 'var(--role-reviewer)', massOben: false, ruhe: 'prüft, ändert nichts' }
}
const KANTE_ZU = { coder: 'e1', reviewer: 'e2', chef: 'e3' }

// Der grader teilt sich den Platz des Reviewers, traegt dort aber seinen
// eigenen Namen. Ohne das stand seine Standzeit unter fremdem Namen auf dem
// Brett -- vier Stunden lang, ohne dass jemand die Rolle haette nachschlagen
// koennen, die wirklich haengt.
const ANZEIGENAME = { chef: 'CHEF', coder: 'CODER', reviewer: 'REVIEWER', grader: 'GRADER' }
const KUERZEL = { chef: 'CHF', coder: 'COD', reviewer: 'REV', grader: 'GRD' }

// Stille ist normal, Stillstand nicht -- und der Unterschied ist nur die Zeit.
// "denkt" ohne Obergrenze war die bequemste Erklaerung fuer alles: der Lauf
// stand vier Stunden tot da, und auf dem Schirm dachte er nach.
const STILLE_DENKT  = 20    // s -- ab hier ueberhaupt erwaehnenswert
const STILLE_STOCKT = 120   // s -- laenger als jeder normale Werkzeugaufruf
const STILLE_STEHT  = 600   // s -- so lange denkt niemand mehr; das ist der
                            //      Wert, ab dem auch loop.sh die Runde beendet
const AUS = { width: 268, height: 104 }
const AN  = { width: 300, height: 120 }

const zustand = {
  laeuft: false, projekt: null, projektName: null,
  // Die Leitung zum Server. Sie ist NICHT dasselbe wie `laeuft`: der Server
  // kann sterben, waehrend die Seite weiter ihre letzte Wahrheit zeichnet.
  verbunden: false, ohneStrom: false,
  runde: 0, runden: 0, modell: null, aufwand: null,
  rolle: null, taetig: null, auftrag: null, werkzeug: null,
  seit: null, letztesEreignis: null, start: null,
  tests: { anzahl: null, gruen: null }, kosten: 0, blocker: 0, guards: 0,
  note: null, zielnote: null, notenband: [], turns: 0, fragen: 0,
  rundenband: [], gesperrt: null, ende: null, pr: null,
  takte: { chef: [], coder: [], reviewer: [] },
  phasendauer: { chef: null, coder: null, reviewer: null },
  kantenzustand: { e1: 'ghost', e2: 'ghost', e3: 'ghost' }
}

// Zeilenumbrueche, wie sie aus einer Datei kommen -- auch aus einer, die unter
// Windows geschrieben wurde.
const SPLIT_ZEILEN = /\r?\n/

const $ = (s) => document.querySelector(s)
const el = (name, attrs = {}, kinder = []) => {
  const k = document.createElementNS(NS, name)
  for (const [a, v] of Object.entries(attrs)) k.setAttribute(a, v)
  for (const kind of kinder) k.appendChild(kind)
  return k
}

// SVG-Elemente spiegeln das hidden-Attribut nicht: `el.hidden = false` setzt dort
// nur eine JS-Eigenschaft und laesst das Attribut stehen. Deshalb immer ueber das
// Attribut schalten -- das wirkt bei HTML und SVG gleichermassen.
const zeige = (el) => el.removeAttribute('hidden')
const verbirg = (el) => el.setAttribute('hidden', '')

// ------------------------------------------------------------------ Aufbau

const knotenGruppen = {}

function baueKnoten () {
  const wurzel = $('#knoten')
  for (const [schluessel, r] of Object.entries(ROLLEN)) {
    const g = el('g', { class: 'knoten', 'data-rolle': schluessel, style: `--rolle:${r.farbe}` })

    const passkreuze = el('g', { class: 'passkreuzgruppe' })
    for (let i = 0; i < 4; i++) passkreuze.appendChild(el('path', { class: 'passkreuz', d: '' }))

    const rahmen = el('rect', { class: 'knoten-rahmen' })
    const kopfband = el('path', { class: 'knoten-kopfband', d: '' })
    const name = el('text', { class: 'knoten-name' }, [document.createTextNode(r.name)])
    const signet = el('path', { class: 'signet', d: '' })
    const auftrag = el('text', { class: 'knoten-auftrag' })
    const werkzeug = el('text', { class: 'knoten-werkzeug' })
    const still = el('text', { class: 'knoten-still' })
    const takt = el('g', { class: 'takt' })
    const scan = el('path', { class: 'scanlinie', d: '' })
    const masshilfeA = el('path', { class: 'masshilfe', d: '' })
    const masshilfeB = el('path', { class: 'masshilfe', d: '' })
    const mass = el('g', { class: 'masslinie' }, [el('path', { d: '' })])
    const masszahl = el('text', { class: 'masszahl', 'text-anchor': 'middle' })

    g.append(passkreuze, rahmen, kopfband, name, signet, auftrag, werkzeug, takt, scan,
      masshilfeA, masshilfeB, mass, masszahl, still)
    wurzel.appendChild(g)
    knotenGruppen[schluessel] = {
      g, rahmen, kopfband, name, signet, auftrag, werkzeug, still, takt, scan,
      passkreuze, masshilfeA, masshilfeB, mass, masszahl
    }
  }
}

/** Setzt die Geometrie eines Bauteils. Reine Funktion des Zustands. */
function knotenGeometrie (schluessel, aktiv) {
  const r = ROLLEN[schluessel]
  const t = knotenGruppen[schluessel]
  const { width: w, height: h } = aktiv ? AN : AUS
  const x = r.cx - w / 2
  const y = r.cy - h / 2

  t.rahmen.setAttribute('x', x); t.rahmen.setAttribute('y', y)
  t.rahmen.setAttribute('width', w); t.rahmen.setAttribute('height', h)
  t.kopfband.setAttribute('d', `M${x} ${y + 26} H${x + w}`)
  t.name.setAttribute('x', x + 14); t.name.setAttribute('y', y + 18)
  t.signet.setAttribute('d', signetPfad(schluessel, x + w - 26, y + 6))
  t.auftrag.setAttribute('x', x + 14); t.auftrag.setAttribute('y', y + 50)
  t.werkzeug.setAttribute('x', x + 14); t.werkzeug.setAttribute('y', y + 69)
  t.takt.setAttribute('transform', `translate(${x + 14} ${y + h - 10})`)
  t.scan.setAttribute('d', `M${x + 1} ${y + 28} H${x + w - 1}`)
  t.g.style.setProperty('--scanweg', (h - 34) + 'px')

  // Passkreuze: offener rechter Winkel, 6px ausserhalb jeder Ecke.
  const ecken = [[x, y, 1, 1], [x + w, y, -1, 1], [x + w, y + h, -1, -1], [x, y + h, 1, -1]]
  const kreuze = t.passkreuze.children
  ecken.forEach(([ex, ey, sx, sy], i) => {
    kreuze[i].setAttribute('d',
      `M${ex - sx * 6} ${ey + sy * 4} H${ex - sx * 6 + sx * 10} M${ex + sx * 4} ${ey - sy * 6} V${ey - sy * 6 + sy * 10}`)
  })

  // Masslinie: unter den unteren Bauteilen, über dem oberen.
  const my = r.massOben ? 38 : 606
  const bx = r.cx - AN.width / 2
  const bw = AN.width
  t.masshilfeA.setAttribute('d', `M${bx} ${r.massOben ? y : y + h} V${my}`)
  t.masshilfeB.setAttribute('d', `M${bx + bw} ${r.massOben ? y : y + h} V${my}`)
  t.mass.firstChild.setAttribute('d',
    `M${bx} ${my} H${bx + bw} M${bx} ${my} l6 -3 M${bx} ${my} l6 3 M${bx + bw} ${my} l-6 -3 M${bx + bw} ${my} l-6 3`)
  t.masszahl.setAttribute('x', r.cx)
  t.masszahl.setAttribute('y', my - 8)
}

function signetPfad (rolle, x, y) {
  if (rolle === 'chef') return `M${x + 7} ${y} L${x} ${y + 14} M${x + 7} ${y} L${x + 14} ${y + 14} M${x + 3} ${y + 8} A6 6 0 0 0 ${x + 11} ${y + 8}`
  if (rolle === 'coder') return `M${x + 4} ${y + 2} L${x} ${y + 7} L${x + 4} ${y + 12} M${x + 10} ${y + 2} L${x + 14} ${y + 7} L${x + 10} ${y + 12}`
  return `M${x + 7} ${y + 2} A5 5 0 1 0 ${x + 7.01} ${y + 2} M${x + 7} ${y} V${y + 14} M${x} ${y + 7} H${x + 14}`
}

// ------------------------------------------------------------------ Render

/** Bricht an Wortgrenzen um, hoechstens auf so viele Zeilen. */
function umbrechen (text, proZeile, maxZeilen) {
  const worte = String(text).split(/\s+/)
  const zeilen = ['']
  for (const wort of worte) {
    const versuch = zeilen[zeilen.length - 1] ? zeilen[zeilen.length - 1] + ' ' + wort : wort
    if (versuch.length <= proZeile) { zeilen[zeilen.length - 1] = versuch; continue }
    if (zeilen.length === maxZeilen) { zeilen[zeilen.length - 1] += ' …'; break }
    zeilen.push(wort)
  }
  return zeilen
}

function kuerzeMitte (text, max) {
  if (!text) return ''
  if (text.length <= max) return text
  const kopf = Math.ceil((max - 1) / 2)
  return text.slice(0, kopf) + '…' + text.slice(text.length - (max - 1 - kopf))
}

function render () {
  // Bauteile
  for (const schluessel of Object.keys(ROLLEN)) {
    const t = knotenGruppen[schluessel]
    const aktiv = zustand.laeuft && zustand.rolle === schluessel
    t.name.textContent = (aktiv && ANZEIGENAME[zustand.taetig]) || ROLLEN[schluessel].name
    knotenGeometrie(schluessel, aktiv)
    t.g.classList.toggle('aktiv', aktiv)
    t.g.classList.toggle('rot', !!(zustand.gesperrt && aktiv))

    t.auftrag.textContent = aktiv
      ? kuerzeMitte(zustand.auftrag || '', 34)
      : ROLLEN[schluessel].ruhe
    t.auftrag.classList.toggle('ruhend', !aktiv)
    const w = aktiv ? zustand.werkzeug : null
    t.werkzeug.textContent = w ? `${w.name.toUpperCase()} · ${kuerzeMitte(w.detail || '', 36)}` : ''

    const dauer = aktiv && zustand.seit
      ? Math.floor((Date.now() - zustand.seit) / 1000)
      : zustand.phasendauer[schluessel]
    t.masszahl.textContent = dauer == null ? '—' : `${dauer} s`

    zeichneTakt(schluessel)

    // Ehrlichkeit bei Stille: keine erfundene Aktivität, sondern die Wahrheit.
    // Und ab einer gewissen Laenge ist "denkt" selbst die Erfindung.
    let stillText = ''
    let stillGrad = 0
    if (aktiv && zustand.letztesEreignis) {
      const s = Math.floor((Date.now() - zustand.letztesEreignis) / 1000)
      if (s >= STILLE_STEHT) { stillGrad = 2; stillText = `seit ${stilleText(s)} ohne Ereignis · steht` }
      else if (s >= STILLE_STOCKT) { stillGrad = 1; stillText = `seit ${stilleText(s)} ohne Ereignis · stockt` }
      else if (s >= STILLE_DENKT) { stillText = `seit ${s} s ohne Ereignis · denkt` }
    }
    t.still.textContent = stillText
    t.still.classList.toggle('stockt', stillGrad === 1)
    t.still.classList.toggle('steht', stillGrad === 2)
    const r = ROLLEN[schluessel]
    t.still.setAttribute('x', r.cx)
    t.still.setAttribute('text-anchor', 'middle')
    t.still.setAttribute('y', (r.massOben ? 22 : 622))
    t.g.classList.toggle('ruhig', !!stillText)
  }

  // Der Token gehoert dem Zustand: laeuft gerade keine Fahrt, ist er weg.
  // Sonst bleibt er nach einer abgebrochenen Uebergabe fuer immer auf der Kante
  // kleben -- genau die Sorte Fehler, gegen die das Rendern aus dem Zustand hilft.
  if (!tokenLauf) verbirg($('#token'))

  // Kanten
  for (const [k, art] of Object.entries(zustand.kantenzustand)) {
    const g = document.querySelector(`.kante[data-kante="${k}"]`)
    if (!g) continue
    g.classList.toggle('bereit', art === 'bereit')
    g.classList.toggle('aktiv', art === 'aktiv')
    g.classList.toggle('erledigt', art === 'erledigt')
  }

  // Kopfleiste
  $('#repo').textContent = zustand.projekt || 'kein Projekt gewählt'
  const statuswort = $('#statuswort')
  statuswort.textContent = statusText()
  statuswort.classList.toggle('aktiv', zustand.laeuft && !zustand.gesperrt && !warnLage())
  statuswort.classList.toggle('gesperrt', !!zustand.gesperrt)
  statuswort.classList.toggle('warnt', warnLage() && !zustand.gesperrt)
  // LIVE heisst: diese Seite hoert gerade wirklich zu. Vorher hing das am
  // zuletzt empfangenen `laeuft` -- also ausgerechnet an der Angabe, die eine
  // tote Leitung nicht mehr widerrufen kann.
  const liveAn = zustand.laeuft && (zustand.verbunden || zustand.ohneStrom)
  const live = $('#live')
  live.classList.toggle('an', liveAn)
  live.classList.toggle('getrennt', zustand.laeuft && !liveAn)
  live.lastChild.textContent = (zustand.laeuft && !liveAn) ? 'GETRENNT' : 'LIVE'
  const sk = $('#startknopf')
  sk.textContent = zustand.laeuft ? 'Anhalten' : 'Starten'
  sk.classList.toggle('laeuft', zustand.laeuft)
  sk.disabled = !zustand.projekt

  // Wasserzeichen und Mitte
  $('#wasserzeichen').textContent = String(zustand.runde || 0).padStart(2, '0')
  $('#mittenmarke').textContent = zustand.laeuft
    ? `R${String(zustand.runde).padStart(2, '0')} · ${uhrText(zustand.start, false)}`
    : (zustand.ende ? 'beendet' : 'bereit')

  // Schriftfeld
  $('#wRunde').textContent = zustand.runden ? `${zustand.runde} / ${zustand.runden}` : '—'
  $('#wModell').textContent = zustand.modell ? `${zustand.modell} · ${zustand.aufwand}` : '—'
  $('#wZeit').textContent = zustand.start ? uhrText(zustand.start, false) : '—'
  $('#wTests').textContent = zustand.tests.anzahl == null ? '—'
    : `${zustand.tests.anzahl} ${zustand.tests.gruen === false ? '✗' : '✓'}`
  $('#zTests').classList.toggle('gruen', zustand.tests.gruen === true)
  $('#zTests').classList.toggle('rot', zustand.tests.gruen === false)
  // Die Note ist die einzige Zahl hier, die etwas ueber das Ergebnis sagt --
  // Runden und Kosten sagen nur etwas ueber den Aufwand.
  const erreicht = zustand.note != null && zustand.zielnote != null &&
    zustand.note >= zustand.zielnote
  $('#wNote').textContent = zustand.note == null
    ? '—'
    : zustand.note.toFixed(1) + (zustand.zielnote ? ' / ' + zustand.zielnote : '')
  $('#zNote').classList.toggle('gruen', erreicht)
  $('#zNote').classList.toggle('rot', zustand.note != null && !erreicht)
  $('#wKosten').textContent = zustand.kosten ? `${zustand.kosten.toFixed(2)}` : '—'
  $('#wTurns').textContent = zustand.turns ? String(zustand.turns) : '—'
  $('#wGesperrt').textContent = zustand.laeuft || zustand.guards ? String(zustand.guards) : '—'
  $('#wFragen').textContent = zustand.laeuft || zustand.fragen ? String(zustand.fragen || 0) : '—'
  $('#fragenzahl').textContent = zustand.fragen ? String(zustand.fragen) : ''
  $('#zGesperrt').classList.toggle('hat', zustand.guards > 0)
  $('#zFragen').classList.toggle('hat', (zustand.fragen || 0) > 0)
  $('#fusszeile').textContent =
    `AUTONOMER LOOP · ${zustand.projektName || '—'} · M 1:1`

  // Rundenband
  $('#rundeGross').textContent = String(zustand.runde || 0).padStart(2, '0')
  $('#rundeVon').textContent = ` / ${String(zustand.runden || 0).padStart(2, '0')}`
  zeichneBand()
}

// Sekunden, die man nach vier Stunden noch lesen kann. "seit 15087 s" ist
// eine Zahl; "seit 4 h 11 min" ist eine Aussage.
function stilleText (s) {
  if (s < 90) return `${s} s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`
}

function stilleSekunden () {
  if (!zustand.laeuft || !zustand.letztesEreignis) return 0
  return Math.floor((Date.now() - zustand.letztesEreignis) / 1000)
}

// Eine tote Leitung und ein stehender Lauf schlagen die Rolle. Wer nichts mehr
// hoert, soll nicht lesen, wer angeblich gerade prueft -- das war die Zeile,
// die vier Stunden lang "REVIEWER PRÜFT" behauptet hat.
function statusText () {
  if (zustand.gesperrt) return 'GESPERRT'
  if (zustand.ende) return 'BEENDET'
  if (!zustand.projekt) return 'KEIN PROJEKT'
  if (!zustand.laeuft) return 'BEREIT'
  if (!zustand.verbunden && !zustand.ohneStrom) return 'VERBINDUNG WEG'
  if (stilleSekunden() >= STILLE_STEHT) return 'STEHT'
  if (zustand.taetig === 'grader') return 'GRADER BEWERTET'
  if (zustand.rolle === 'coder') return 'CODER ARBEITET'
  if (zustand.rolle === 'reviewer') return 'REVIEWER PRÜFT'
  return 'CHEF ORDNET AN'
}

function warnLage () {
  if (!zustand.laeuft) return false
  return (!zustand.verbunden && !zustand.ohneStrom) || stilleSekunden() >= STILLE_STEHT
}

function uhrText (seit, zehntel) {
  if (!seit) return zehntel ? '00:00.0' : '00:00'
  const ms = Date.now() - seit
  const m = Math.floor(ms / 60000)
  const s = Math.floor(ms / 1000) % 60
  const z = Math.floor(ms / 100) % 10
  const basis = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return zehntel ? `${basis}.${z}` : basis
}

function zeichneTakt (schluessel) {
  const t = knotenGruppen[schluessel]
  const takte = zustand.takte[schluessel] || []
  const sichtbar = takte.slice(-48)
  while (t.takt.childElementCount > sichtbar.length) t.takt.lastChild.remove()
  sichtbar.forEach((klasse, i) => {
    let rect = t.takt.children[i]
    if (!rect) { rect = el('rect', { width: 1 }); t.takt.appendChild(rect) }
    const hoch = klasse === 'bash' || klasse === 'geblockt' ? 12 : 8
    rect.setAttribute('x', i * 5)
    rect.setAttribute('y', -hoch)
    rect.setAttribute('height', hoch)
    rect.setAttribute('fill',
      klasse === 'geblockt' ? 'var(--rot)'
        : klasse === 'schreibt' ? ROLLEN[schluessel].farbe
          : klasse === 'bash' ? 'var(--text-mid)' : 'var(--text-ghost)')
  })
}

function zeichneBand () {
  const svg = $('#band')
  svg.textContent = ''
  const max = Math.max(zustand.runden || 1, 1)
  const links = 10; const rechts = 890; const y = 62
  const schritt = (rechts - links) / Math.max(max, 1)

  svg.appendChild(el('path', { class: 'basis', d: `M${links} ${y} H${rechts}` }))

  const bis = links + schritt * Math.max(0, zustand.runde - (zustand.laeuft ? 1 : 0))
  if (bis > links) {
    const g = el('path', { class: 'gelaufen', d: `M${links} ${y} H${bis}` })
    g.style.setProperty('--rolle', ROLLEN[zustand.rolle || 'chef'].farbe)
    svg.appendChild(g)
  }

  for (let i = 1; i <= max; i++) {
    const x = links + schritt * (i - 0.5)
    svg.appendChild(el('path', { class: 'tick', d: `M${x} ${y} V${y + 12}` }))
    svg.appendChild(el('text', { class: 'ticknr', x, y: y + 28, 'text-anchor': 'middle' },
      [document.createTextNode(String(i).padStart(2, '0'))]))
    const eintrag = zustand.rundenband.find(r => r.i === i)
    if (eintrag && eintrag.gruen != null) {
      svg.appendChild(el('rect', {
        class: 'stempelchen ' + (eintrag.gruen ? 'gruen' : 'rot'),
        x: x - 3, y: y - 9, width: 6, height: 6
      }))
      if (eintrag.geblockt) {
        svg.appendChild(el('path', { class: 'diagonale', d: `M${x - 5} ${y - 1} L${x + 5} ${y - 11}` }))
      }
    }
  }

  if (zustand.laeuft && zustand.runde > 0) {
    const x = links + schritt * (zustand.runde - 0.5)
    const g = el('g')
    g.appendChild(el('path', { class: 'lehre', d: `M${x - 11} ${y - 24} V${y - 6} M${x + 11} ${y - 24} V${y - 6} M${x - 11} ${y - 24} H${x + 11}` }))
    g.appendChild(el('text', { class: 'lehrezahl', x, y: y - 30, 'text-anchor': 'middle' },
      [document.createTextNode(uhrText(zustand.seit, false))]))
    g.style.transition = 'transform 460ms var(--ease-lehre)'
    svg.appendChild(g)
  }
}

// ------------------------------------------------------- Bewegung: Übergabe

let tokenLauf = null

function uebergabe (nachRolle) {
  const kante = KANTE_ZU[nachRolle]
  if (!kante) return
  for (const k of Object.keys(zustand.kantenzustand)) {
    if (zustand.kantenzustand[k] === 'aktiv') zustand.kantenzustand[k] = 'erledigt'
  }
  zustand.kantenzustand[kante] = 'aktiv'

  const pfad = document.querySelector(`.kante[data-kante="${kante}"] .kantenlinie`)
  const schweif = document.querySelector(`.kante[data-kante="${kante}"] .kantenschweif`)
  const token = $('#token')
  if (!pfad || !token) return

  const laenge = pfad.getTotalLength()
  schweif.setAttribute('stroke-dasharray', `40 ${laenge + 40}`)

  zeige(token)
  const start = performance.now()
  const dauer = 620
  if (tokenLauf) cancelAnimationFrame(tokenLauf)

  const schritt = (jetzt) => {
    const p = Math.min(1, (jetzt - start) / dauer)
    // ease-inout, damit die Fahrt anzieht und ankommt statt zu rutschen
    const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
    const punkt = pfad.getPointAtLength(e * laenge)
    token.setAttribute('transform', `translate(${punkt.x} ${punkt.y}) scale(${1 - 0.8 * Math.max(0, p - 0.88) / 0.12})`)
    token.style.opacity = p > 0.88 ? String(1 - (p - 0.88) / 0.12) : '1'
    schweif.setAttribute('stroke-dashoffset', String(laenge - e * laenge))
    if (p < 1) { tokenLauf = requestAnimationFrame(schritt) } else { verbirg(token); tokenLauf = null }
  }
  tokenLauf = requestAnimationFrame(schritt)
}

// ---------------------------------------------------- Bewegung: Guard-Block

let tafelBleibt = false

function sperren (daten) {
  const riss = $('#riss')
  // Vollbremsung: nach minutenlanger sanfter Bewegung ist Stillstand laut.
  riss.classList.add('angehalten')
  setTimeout(() => riss.classList.remove('angehalten'), 1180)

  const rolle = zustand.rolle || 'chef'
  const r = ROLLEN[rolle]
  const tafel = $('#sperrtafel')
  tafel.textContent = ''
  zeige(tafel)

  // Fehlregister: eine zweite, um 3px versetzte Kontur — der Plotter ist
  // verrutscht. Kein Wackeln, ein Passfehler.
  const box = knotenGruppen[rolle].rahmen
  const fr = el('path', {
    class: 'fehlregister',
    d: `M${+box.getAttribute('x') + 3} ${+box.getAttribute('y') + 3} h${+box.getAttribute('width')} v${+box.getAttribute('height')} h${-box.getAttribute('width')} Z`
  })
  tafel.appendChild(fr)
  setTimeout(() => fr.remove(), 320)

  // Doppelbalken über der ausgehenden Kante.
  const kante = KANTE_ZU[rolle === 'chef' ? 'coder' : rolle === 'coder' ? 'reviewer' : 'chef']
  const kpfad = document.querySelector(`.kante[data-kante="${kante}"] .kantenlinie`)
  if (kpfad) {
    const m = kpfad.getPointAtLength(kpfad.getTotalLength() / 2)
    tafel.appendChild(el('path', { class: 'sperrbalken', d: `M${m.x - 17} ${m.y - 17} L${m.x + 17} ${m.y + 17}` }))
    tafel.appendChild(el('path', { class: 'sperrbalken', d: `M${m.x - 11} ${m.y - 23} L${m.x + 23} ${m.y + 11}` }))
  }

  // Die Tafel selbst, angesetzt am Bauteil.
  const tx = r.cx - 210
  const ty = r.massOben ? r.cy + 120 : r.cy - 200
  // Die Tafel waechst mit der Meldung, statt dass sich die Zeilen ueberlagern.
  const zeilen = umbrechen(daten.meldung || '', 52, 2)
  const hoehe = 62 + zeilen.length * 18

  const g = el('g', { transform: `translate(${tx} ${ty})` })
  g.appendChild(el('rect', { class: 'tafel', x: 0, y: 0, width: 420, height: hoehe }))
  g.appendChild(el('path', { class: 'verbot', d: 'M26 44 m-9 0 a9 9 0 1 0 18 0 a9 9 0 1 0 -18 0 M20 38 L32 50' }))
  g.appendChild(el('text', { class: 'titel', x: 48, y: 28 }, [document.createTextNode('GESPERRT')]))
  zeilen.forEach((zeile, i) => {
    g.appendChild(el('text', { class: 'meldung', x: 48, y: 48 + i * 18 },
      [document.createTextNode(zeile)]))
  })
  g.appendChild(el('text', { class: 'quelle', x: 48, y: hoehe - 12 },
    [document.createTextNode(`${daten.hook || 'PreToolUse'} · exit 2${daten.werkzeug ? ' · ' + daten.werkzeug.name : ''}`)]))
  tafel.appendChild(g)

  // Bleibende Spur: ein roter Tick in der Taktleiste.
  zustand.takte[rolle] = (zustand.takte[rolle] || []).concat('geblockt')

  clearTimeout(sperren._weg)
  if (tafelBleibt) return
  sperren._weg = setTimeout(() => {
    verbirg(tafel); tafel.textContent = ''
    zustand.gesperrt = null
    render()
  }, 7000)
}

// ------------------------------------------------------------------- Strom

const stromliste = $('#stromliste')
let letzteRundeImStrom = 0

function stromZeile (opt) {
  if (opt.runde && opt.runde !== letzteRundeImStrom) {
    letzteRundeImStrom = opt.runde
    const marke = document.createElement('div')
    marke.className = 'rundenmarke'
    marke.innerHTML = `<span>RUNDE ${String(opt.runde).padStart(2, '0')}</span>`
    stromliste.appendChild(marke)
  }
  const z = document.createElement('div')
  z.className = 'zeile' + (opt.geblockt ? ' geblockt' : '') + (opt.system ? ' system' : '')
  if (opt.rolle) z.style.setProperty('--rolle', ROLLEN[opt.rolle].farbe)
  const zeit = new Date().toLocaleTimeString('de-CH', { hour12: false })
  z.innerHTML =
    `<div class="balken"></div>` +
    `<div class="zeit">${zeit}</div>` +
    `<div class="kuerzel">${KUERZEL[opt.taetig] || (opt.rolle ? ROLLEN[opt.rolle].kuerzel : '')}</div>` +
    `<div class="inhalt">${opt.werkzeug ? `<span class="werkzeugname">${escape_(opt.werkzeug)}</span> ` : ''}${escape_(opt.text)}</div>`
  const untenDran = stromliste.scrollHeight - stromliste.scrollTop - stromliste.clientHeight < 60
  stromliste.appendChild(z)
  while (stromliste.childElementCount > 220) stromliste.firstChild.remove()
  if (untenDran) stromliste.scrollTop = stromliste.scrollHeight
  $('#stromzahl').textContent = String(stromliste.childElementCount)
}

const escape_ = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ------------------------------------------------------------------ Server

async function hole (weg, opt) {
  const antwort = await fetch(weg, opt)
  const daten = await antwort.json().catch(() => ({}))
  if (!antwort.ok) throw new Error(daten.fehler || `Fehler ${antwort.status}`)
  return daten
}

// Ein Fehler im Skript darf nicht in eine tote Seite muenden. Ohne diesen
// Melder sieht man nur ein Bild, das sich nicht mehr bewegt, und weiss nicht,
// ob der Loop steht oder die Oberflaeche.
window.addEventListener('error', (e) => {
  melde('Fehler in der Oberflaeche: ' + (e.message || 'unbekannt') +
        ' — die Anzeige kann jetzt falsch sein. Seite neu laden.', true)
})
window.addEventListener('unhandledrejection', (e) => {
  melde('Fehler: ' + ((e.reason && e.reason.message) || e.reason || 'unbekannt'), true)
})

function melde (text, fehler) {
  const m = $('#melder')
  m.textContent = text
  m.className = 'melder' + (fehler ? ' fehler' : '')
  m.hidden = false
  clearTimeout(melde._weg)
  if (!fehler) melde._weg = setTimeout(() => { m.hidden = true }, 5200)
  m.onclick = () => { m.hidden = true }
}

function verbinde () {
  // Mit ?ohne-strom=1 bleibt die Seite still: kein EventSource, keine offene
  // Verbindung. Gedacht fuer Screenshots und fuer den Blick auf einen
  // abgeschlossenen Lauf, ohne dass der Browser eine Leitung offen haelt.
  if (new URLSearchParams(location.search).has('ohne-strom')) {
    zustand.ohneStrom = true
    return
  }
  const quelle = new EventSource('/api/strom')
  quelle.onopen = () => { zustand.verbunden = true; render() }
  quelle.onmessage = (n) => {
    let e; try { e = JSON.parse(n.data) } catch { return }
    zustand.verbunden = true
    verarbeite(e)
  }
  // EventSource verbindet von selbst neu -- aber nur, solange es jemanden gibt,
  // der antwortet. Stirbt der Server, versucht es das stumm bis in alle
  // Ewigkeit, und die Seite zeichnet derweil ihren letzten Stand weiter: LIVE,
  // Uhr laeuft, Rolle prueft. Genau so hat dieses Cockpit vier Stunden lang
  // einen Lauf angezeigt, den es nicht mehr gab. Der Zustand muss die
  // Leitung kennen, sonst luegt die Anzeige mit voller Ueberzeugung.
  quelle.onerror = () => { zustand.verbunden = false; render() }
}

function verarbeite (e) {
  switch (e.typ) {
    case 'zustand':
      Object.assign(zustand, {
        laeuft: e.laeuft, projekt: e.projekt, runde: e.runde, runden: e.runden,
        modell: e.modell, aufwand: e.aufwand, rolle: e.rolle,
        taetig: e.taetig || e.rolle, auftrag: e.auftrag,
        seit: e.seit, start: e.start, tests: e.tests || zustand.tests,
        kosten: e.kosten || 0, guards: e.guards || 0, letztesEreignis: e.letztesEreignis,
        note: e.note ?? null, zielnote: e.zielnote ?? null,
        notenband: e.notenband || zustand.notenband,
        turns: e.turns || 0, fragen: e.fragen || 0
      })
      if (e.projekt) zustand.projektName = e.projekt.split(/[\\/]/).pop()
      break
    case 'start':
      Object.assign(zustand, {
        laeuft: true, projekt: e.projekt, runden: e.runden, start: Date.now(),
        rolle: 'chef', taetig: 'chef',
        seit: Date.now(), letztesEreignis: Date.now(), ende: null, pr: null,
        rundenband: [], takte: { chef: [], coder: [], reviewer: [] },
        kantenzustand: { e1: 'bereit', e2: 'ghost', e3: 'ghost' }, guards: 0, kosten: 0,
        note: null, notenband: [], turns: 0, fragen: 0
      })
      zustand.projektName = e.projekt.split(/[\\/]/).pop()
      stromliste.textContent = ''; letzteRundeImStrom = 0
      break
    case 'runde':
      Object.assign(zustand, {
        runde: e.i, runden: e.max, modell: e.modell, aufwand: e.aufwand,
        rolle: 'chef', taetig: 'chef', seit: Date.now(), letztesEreignis: Date.now(),
        takte: { chef: [], coder: [], reviewer: [] },
        kantenzustand: { e1: 'bereit', e2: 'ghost', e3: 'ghost' }
      })
      stromZeile({ runde: e.i, text: `Runde ${e.i} von ${e.max} · ${e.modell} / ${e.aufwand}`, system: true })
      break
    case 'rolle': {
      const vorher = zustand.rolle
      if (zustand.seit && vorher) {
        zustand.phasendauer[vorher] = Math.floor((Date.now() - zustand.seit) / 1000)
      }
      zustand.rolle = e.rolle
      zustand.taetig = e.taetig || e.rolle
      zustand.auftrag = e.auftrag
      zustand.werkzeug = null
      zustand.seit = Date.now()
      zustand.letztesEreignis = Date.now()
      if (vorher && vorher !== e.rolle) uebergabe(e.rolle)
      stromZeile({ rolle: e.rolle, taetig: zustand.taetig, werkzeug: 'ÜBERNIMMT', text: e.auftrag })
      break
    }
    case 'aktion':
      zustand.werkzeug = { name: e.name, detail: e.detail, klasse: e.klasse }
      zustand.letztesEreignis = Date.now()
      zustand.takte[e.rolle] = (zustand.takte[e.rolle] || []).concat(e.klasse)
      stromZeile({ rolle: e.rolle, taetig: zustand.taetig, werkzeug: e.name.toUpperCase(), text: e.detail })
      break
    case 'guard':
      zustand.gesperrt = e
      zustand.guards += 1
      sperren(e)
      stromZeile({ rolle: zustand.rolle, werkzeug: 'GESPERRT', text: e.meldung, geblockt: true })
      break
    case 'tests':
      zustand.tests = { anzahl: e.anzahl, gruen: e.gruen }
      { let eintrag = zustand.rundenband.find(r => r.i === zustand.runde)
        if (!eintrag) { eintrag = { i: zustand.runde }; zustand.rundenband.push(eintrag) }
        eintrag.gruen = e.gruen
        eintrag.geblockt = zustand.guards > 0 }
      stromZeile({ text: e.gruen ? `Testsuite grün · ${e.anzahl ?? '?'} Tests` : 'Testsuite ROT', system: true })
      break
    case 'kosten':
      zustand.kosten = e.usd
      zustand.turns = e.turns || zustand.turns
      break
    case 'note':
      zustand.zielnote = e.ziel ?? zustand.zielnote
      if (e.note == null) {
        stromZeile({ werkzeug: 'NOTE', text: 'Diese Runde hat keine Note hinterlassen.' })
        break
      }
      zustand.note = e.note
      zustand.notenband.push({ i: e.i, note: e.note })
      stromZeile({
        werkzeug: 'NOTE',
        text: e.note.toFixed(1) + ' von 10' +
          (e.ziel ? ' (Ziel ' + e.ziel + ')' : '') +
          (e.begruendung ? ' — ' + e.begruendung : '')
      })
      break
    case 'fragenstand':
      zustand.fragen = e.anzahl
      break
    case 'frage':
      zustand.fragen = (zustand.fragen || 0) + 0
      stromZeile({ werkzeug: 'FRAGE', text: e.text })
      break
    case 'pr':
      zustand.pr = e.url
      stromZeile({ text: 'Pull Request offen: ' + e.url, system: true })
      break
    case 'grund':
      zustand.ende = { grund: e.grund }
      break
    case 'ende':
      zustand.laeuft = false
      zustand.ende = e
      abschluss(e)
      break
    case 'log':
      if (!/^===|^Runde \d+ \|/.test(e.zeile)) stromZeile({ text: e.zeile, system: true })
      break
  }
  render()
}

function abschluss (e) {
  const riss = $('#riss')
  const gut = /erledigt|Rundenlimit/.test(e.grund || '')
  riss.classList.toggle('abgebrochen', !gut)
  const tafel = $('#sperrtafel')
  zeige(tafel)
  tafel.textContent = ''
  const g = el('g', { class: 'stempel' + (gut ? '' : ' rot'), transform: 'translate(490 330) rotate(-4)' })
  g.appendChild(el('rect', { x: 0, y: 0, width: 240, height: 54 }))
  g.appendChild(el('text', { x: 120, y: 33, 'text-anchor': 'middle' },
    [document.createTextNode(gut ? 'ABGESCHLOSSEN' : 'ABGEBROCHEN')]))
  tafel.appendChild(g)
  stromZeile({ text: e.grund, system: true })
  if (e.pr) stromZeile({ text: 'Pull Request: ' + e.pr, system: true })
}

// ------------------------------------------------------------------ Blätter

let projekte = []
let gewaehlt = null

const blattdeck = $('#blattdeck')
const sheetKoerper = $('#sheetKoerper')

function zeigeBlatt (titel, aufbau) {
  $('#sheetTitel').textContent = titel
  sheetKoerper.textContent = ''
  blattdeck.hidden = false
  aufbau(sheetKoerper)
}
function schliesseBlatt () { blattdeck.hidden = true }

$('#sheetZu').onclick = schliesseBlatt
blattdeck.onclick = (e) => { if (e.target === blattdeck) schliesseBlatt() }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') schliesseBlatt() })

async function blattProjekt () {
  zeigeBlatt('PROJEKT', async (k) => {
    k.innerHTML = '<div class="hinweis">Lade …</div>'
    let daten
    try { daten = await hole('/api/projekte') } catch (f) { k.innerHTML = `<div class="hinweis warn">${escape_(f.message)}</div>`; return }
    projekte = daten.projekte
    k.textContent = ''

    if (!daten.scaffoldDa) {
      const h = document.createElement('div')
      h.className = 'hinweis warn'
      h.textContent = `Das Scaffold liegt nicht unter ${daten.scaffold}. Ohne agent-loop kann in kein Projekt eingerichtet werden.`
      k.appendChild(h)
    }

    const kopfzeile = document.createElement('div')
    kopfzeile.className = 'sheet-fuss'
    kopfzeile.style.margin = '0 0 14px'
    kopfzeile.style.justifyContent = 'flex-start'
    const neuKnopf = document.createElement('button')
    neuKnopf.className = 'knopf'
    neuKnopf.textContent = 'Neues Projekt'
    neuKnopf.onclick = blattNeu
    kopfzeile.appendChild(neuKnopf)
    k.appendChild(kopfzeile)

    const liste = document.createElement('div')
    liste.className = 'projektliste'
    for (const p of projekte) {
      const zeile = document.createElement('div')
      zeile.className = 'projektzeile' + (gewaehlt === p.pfad ? ' gewaehlt' : '')
      const marke = p.eingerichtet
        ? '<span class="marke bereit">EINGERICHTET</span>'
        : '<span class="marke fehlt">NICHT EINGERICHTET</span>'
      const sauber = p.sauber ? '' : `<span class="marke schmutzig">${p.offeneDateien} OFFEN</span>`
      zeile.innerHTML =
        `<div><div class="pname">${escape_(p.name)}</div>` +
        `<div class="pmeta">${escape_(p.branch)}${p.remote ? ' · ' + escape_(p.remote.replace(/^https:\/\/github.com\//, '')) : ' · kein Remote'}</div></div>` +
        sauber + marke
      zeile.onclick = async () => {
        gewaehlt = p.pfad
        if (!p.eingerichtet) {
          if (!confirm(`Den Loop in "${p.name}" einrichten?\n\nKopiert Guards, Charta und loop.sh hinein. Vorhandene TASKS.md, STATUS.md und QUESTIONS.md bleiben unangetastet.`)) return
          let antwort
          try {
            antwort = await hole('/api/installieren', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ pfad: p.pfad })
            })
          } catch (f) { melde(f.message, true); return }

          // Die Warnungen sind der wichtigste Teil der Einrichtung: ohne Tests
          // oder mit falschem Testbefehl liefe der Loop ohne Bremse. Sie
          // gehoeren vor Augen, nicht in eine Meldung, die nach fuenf Sekunden
          // verschwindet.
          const bericht = antwort.bericht || {}
          const warnungen = bericht.warnungen || []
          if (warnungen.length) {
            zeigeBlatt('EINRICHTUNG · ' + p.name.toUpperCase(), (k) => {
              k.innerHTML =
                warnungen.map(t => `<div class="hinweis warn">${escape_(t)}</div>`).join('') +
                `<div class="hinweis">Zielbranch <code>${escape_(bericht.zweig || '?')}</code>` +
                ` · Testbefehl <code>${escape_((bericht.test && bericht.test.befehl) || 'nicht gesetzt')}</code>` +
                ` · ${bericht.committet ? 'committet' : 'NICHT committet'}</div>`
              const fuss = document.createElement('div')
              fuss.className = 'sheet-fuss'
              const zu = document.createElement('button')
              zu.className = 'knopf'
              zu.textContent = 'Verstanden'
              zu.onclick = schliesseBlatt
              fuss.appendChild(zu)
              k.appendChild(fuss)
            })
          } else {
            melde(`Loop in ${p.name} eingerichtet und committet.`)
          }
        }
        zustand.projekt = p.pfad
        zustand.projektName = p.name
        try { localStorage.setItem('cockpit.projekt', p.pfad) } catch { /* privater Modus */ }
        render()
        schliesseBlatt()
        melde(`Projekt: ${p.name}`)
      }
      liste.appendChild(zeile)
    }
    k.appendChild(liste)
  })
}

// Das Cockpit commitet, was es selbst schreibt -- sonst wuerde die eigene
// Aenderung spaeter den Start blockieren. Klappt der Commit nicht, muss man
// es hier erfahren und nicht erst beim Startversuch.
function sicherungsHinweis (g) {
  if (!g || g.stand === 'nichts') return ''
  if (g.stand === 'committet') return ' Und committet.'
  return ` Aber nicht committet: ${g.grund} Solange das offen liegt, verweigert der Start.`
}

async function blattAufgaben () {
  if (!zustand.projekt) return melde('Erst ein Projekt wählen.', true)
  zeigeBlatt('AUFGABEN', async (k) => {
    let daten
    try { daten = await hole('/api/projekt?pfad=' + encodeURIComponent(zustand.projekt)) } catch (f) { k.innerHTML = `<div class="hinweis warn">${escape_(f.message)}</div>`; return }
    k.innerHTML =
      '<div class="hinweis">Eine Zeile pro Aufgabe, wichtigste oben. Der Chef nimmt sich pro Runde genau eine.<br>' +
      'Format: <code>- [ ] Beschreibung</code></div>'
    const feld = document.createElement('textarea')
    feld.value = daten.tasks || '# Backlog\n\n'
    k.appendChild(feld)
    const fuss = document.createElement('div')
    fuss.className = 'sheet-fuss'
    const sichern = document.createElement('button')
    sichern.className = 'knopf'; sichern.textContent = 'Sichern'
    sichern.onclick = async () => {
      try {
        const a = await hole('/api/tasks', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pfad: zustand.projekt, text: feld.value })
        })
        melde('Aufgaben gesichert.' + sicherungsHinweis(a.gesichert),
          a.gesichert && a.gesichert.stand === 'fehler')
        schliesseBlatt()
      } catch (f) { melde(f.message, true) }
    }
    fuss.appendChild(sichern)
    k.appendChild(fuss)
  })
}

async function blattEinstellungen () {
  if (!zustand.projekt) return melde('Erst ein Projekt wählen.', true)
  zeigeBlatt('EINSTELLUNGEN', async (k) => {
    let daten
    try { daten = await hole('/api/projekt?pfad=' + encodeURIComponent(zustand.projekt)) } catch (f) { k.innerHTML = `<div class="hinweis warn">${escape_(f.message)}</div>`; return }
    if (!daten.konfig) { k.innerHTML = '<div class="hinweis warn">Der Loop ist hier nicht eingerichtet.</div>'; return }

    k.innerHTML = '<div class="hinweis">Diese Werte stehen oben in <code>loop.sh</code>. Wer das Skript im Terminal startet, bekommt genau dieselben.</div>'
    const eingaben = {}
    for (const feld of daten.konfig.felder) {
      const zeile = document.createElement('div')
      zeile.className = 'feld'
      const label = document.createElement('label')
      label.textContent = feld.titel
      const rechts = document.createElement('div')
      const eingabe = document.createElement('input')
      const zahlenfeld = feld.typ === 'zahl' || feld.typ === 'dezimal'
      eingabe.type = zahlenfeld ? 'number' : 'text'
      // Ohne step verweigert ein number-Feld die 8.5, die es anzeigen soll.
      if (feld.schritt != null) eingabe.step = feld.schritt
      else if (zahlenfeld) eingabe.step = 1
      if (feld.min != null) eingabe.min = feld.min
      if (feld.max != null) eingabe.max = feld.max
      eingabe.value = daten.konfig.werte[feld.name] ?? ''
      eingaben[feld.name] = eingabe
      const hilfe = document.createElement('div')
      hilfe.className = 'hilfe'
      hilfe.textContent = feld.hilfe + (feld.beispiele ? '  Beispiele: ' + feld.beispiele.join(', ') : '')
      rechts.append(eingabe, hilfe)
      zeile.append(label, rechts)
      k.appendChild(zeile)
    }
    const fuss = document.createElement('div')
    fuss.className = 'sheet-fuss'
    const sichern = document.createElement('button')
    sichern.className = 'knopf'; sichern.textContent = 'Sichern'
    sichern.onclick = async () => {
      const werte = {}
      for (const [name, e] of Object.entries(eingaben)) werte[name] = e.value
      try {
        const a = await hole('/api/konfig', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pfad: zustand.projekt, werte })
        })
        melde('Einstellungen gesichert.' + sicherungsHinweis(a.gesichert),
          a.gesichert && a.gesichert.stand === 'fehler')
        schliesseBlatt()
      } catch (f) { melde(f.message, true) }
    }
    fuss.appendChild(sichern)
    k.appendChild(fuss)
  })
}

async function blattFragen () {
  if (!zustand.projekt) return melde('Erst ein Projekt waehlen.', true)
  zeigeBlatt('FRAGEN', async (k) => {
    let daten
    try { daten = await hole('/api/projekt?pfad=' + encodeURIComponent(zustand.projekt)) } catch (f) { k.innerHTML = `<div class="hinweis warn">${escape_(f.message)}</div>`; return }
    const eintraege = String(daten.fragen || '').split(SPLIT_ZEILEN).filter(z => /^\s*[-*]\s+\S/.test(z))
    k.innerHTML = '<div class="hinweis">Hier steht, was der Chef bewusst NICHT entschieden hat: ' +
      'neue Abhaengigkeiten, Migrationen, Aenderungen an bestehenden Tests. ' +
      'Er ueberspringt solche Aufgaben und arbeitet weiter — entscheiden musst du.</div>'
    if (!eintraege.length) {
      k.innerHTML += '<div class="hinweis ok">Keine offenen Fragen.</div>'
      return
    }
    for (const e of eintraege) {
      const d = document.createElement('div')
      d.className = 'frageneintrag'
      d.textContent = e.replace(/^\s*[-*]\s+/, '')
      k.appendChild(d)
    }
  })
}

async function blattNeu () {
  zeigeBlatt('NEUES PROJEKT', (k) => {
    k.innerHTML =
      '<div class="hinweis">Legt einen Ordner an, macht ihn zum Git-Repository und ' +
      'richtet den Loop darin ein. Die Spielwiese bringt eine kleine Funktion, ' +
      'echte Tests und zwei Aufgaben mit — damit ist sie sofort startklar. ' +
      'Ein leeres Projekt hat keine Tests, und ohne Tests laeuft der Loop ohne Bremse.</div>'

    const zeile = document.createElement('div')
    zeile.className = 'feld'
    const label = document.createElement('label')
    label.textContent = 'Name'
    const rechts = document.createElement('div')
    const eingabe = document.createElement('input')
    eingabe.type = 'text'
    eingabe.placeholder = 'spielwiese'
    const hilfe = document.createElement('div')
    hilfe.className = 'hilfe'
    hilfe.textContent = 'Buchstaben, Ziffern, Punkt, Bindestrich, Unterstrich.'
    rechts.append(eingabe, hilfe)
    zeile.append(label, rechts)
    k.appendChild(zeile)

    const wahl = document.createElement('div')
    wahl.className = 'feld'
    const wlabel = document.createElement('label')
    wlabel.textContent = 'Vorlage'
    const wrechts = document.createElement('div')
    wrechts.innerHTML =
      '<label style="display:block;margin-bottom:8px;font-family:var(--font-mono);font-size:12.5px">' +
      '<input type="radio" name="vorlage" value="spielwiese" checked> Spielwiese mit Tests (empfohlen)</label>' +
      '<label style="display:block;font-family:var(--font-mono);font-size:12.5px">' +
      '<input type="radio" name="vorlage" value="leer"> Leer</label>'
    wahl.append(wlabel, wrechts)
    k.appendChild(wahl)

    const fuss = document.createElement('div')
    fuss.className = 'sheet-fuss'
    const anlegen = document.createElement('button')
    anlegen.className = 'knopf'
    anlegen.textContent = 'Anlegen'
    anlegen.onclick = async () => {
      anlegen.disabled = true
      const leer = k.querySelector('input[name="vorlage"]:checked').value === 'leer'
      try {
        const a = await hole('/api/anlegen', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: eingabe.value, leer })
        })
        zustand.projekt = a.pfad
        zustand.projektName = a.name
        try { localStorage.setItem('cockpit.projekt', a.pfad) } catch { /* privater Modus */ }
        render()
        const w = (a.bericht && a.bericht.warnungen) || []
        schliesseBlatt()
        melde(w.length
          ? `${a.name} angelegt — mit ${w.length} Hinweis${w.length > 1 ? 'en' : ''}, siehe Projektliste.`
          : `${a.name} angelegt und startklar.`, w.length > 0)
      } catch (f) {
        melde(f.message, true)
        anlegen.disabled = false
      }
    }
    fuss.appendChild(anlegen)
    k.appendChild(fuss)
    eingabe.focus()
    eingabe.onkeydown = (e) => { if (e.key === 'Enter') anlegen.click() }
  })
}

// ------------------------------------------------------------ Start / Stop

$('#startknopf').onclick = async () => {
  if (zustand.laeuft) {
    const hart = !confirm(
      'Sanft anhalten?\n\n' +
      'OK: der Loop beendet die laufende Runde, pusht und öffnet den Pull Request.\n' +
      'Abbrechen: sofort abschiessen — kein Push, kein Pull Request.')
    try {
      await hole('/api/stop', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modus: hart ? 'hart' : 'sanft' })
      })
      melde(hart ? 'Hart gestoppt.' : 'Sanft angehalten — der Lauf endet nach dieser Runde.')
    } catch (f) { melde(f.message, true) }
    return
  }

  if (!zustand.projekt) return melde('Erst ein Projekt wählen.', true)
  const runden = Number(prompt('Wie viele Runden?\n\nEine Runde dauert etwa vier Minuten. Fang mit drei an.', '3'))
  if (!runden || runden < 1) return
  try {
    const antwort = await hole('/api/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pfad: zustand.projekt, runden })
    })
    if (antwort.angepasst) {
      melde(`Rundenzahl angepasst: ${antwort.angepasst.angefordert} war ungueltig oder ausserhalb 1-200, ` +
        `verwendet wurden ${antwort.angepasst.verwendet}.`)
    }
  } catch (f) { melde(f.message, true) }
}

for (const knopf of document.querySelectorAll('[data-blatt]')) {
  knopf.onclick = () => ({
    projekt: blattProjekt,
    aufgaben: blattAufgaben,
    fragen: blattFragen,
    einstellungen: blattEinstellungen
  })[knopf.dataset.blatt]()
}

// ------------------------------------------------------------------- Takt

// Ein einziger rAF-Lauf für alles, was tickt. Schreibt nur, wenn sich die
// angezeigte Zehntelsekunde wirklich ändert.
let letzteUhr = ''
function takt () {
  if (!document.hidden) {
    const t = uhrText(zustand.start, true)
    if (t !== letzteUhr) {
      letzteUhr = t
      $('#uhr').textContent = zustand.start ? t : '00:00.0'
      if (zustand.laeuft) render()
    }
  }
  requestAnimationFrame(takt)
}

// Rahmenlängen für die Zeichenanimation setzen.
for (const linie of document.querySelectorAll('.rahmenlinie')) {
  linie.style.setProperty('--laenge', Math.ceil(linie.getTotalLength()))
}

// --------------------------------------------------------------- Probelauf

/* Mit ?probe=1 spielt die Seite einen Lauf nach, ohne Server und ohne
 * Kontingent. Zwei Gründe: man sieht vor dem ersten echten Lauf, was einen
 * erwartet — und wer am Design arbeitet, muss nicht vier Minuten warten, bis
 * endlich ein Rollenwechsel kommt. */
function probelauf (szene) {
  const projekt = 'C:/Users/beispiel/Documents/01_Projekte/agent-loop'
  const drehbuch = [
    [0, { typ: 'start', projekt, runden: 4 }],
    [200, { typ: 'runde', i: 1, max: 4, modell: 'sonnet', aufwand: 'high' }],
    [400, { typ: 'rolle', rolle: 'chef', auftrag: 'wählt die oberste Aufgabe' }],
    [900, { typ: 'aktion', rolle: 'chef', name: 'Read', detail: 'TASKS.md', klasse: 'liest' }],
    [1500, { typ: 'aktion', rolle: 'chef', name: 'Read', detail: 'STATUS.md', klasse: 'liest' }],
    [2100, { typ: 'aktion', rolle: 'chef', name: 'Glob', detail: 'src/**/*.js', klasse: 'liest' }],
    [2800, { typ: 'rolle', rolle: 'coder', auftrag: 'Add close(text, task) to tasklist' }],
    [3600, { typ: 'aktion', rolle: 'coder', name: 'Read', detail: 'src/tasklist.js', klasse: 'liest' }],
    [4300, { typ: 'aktion', rolle: 'coder', name: 'Edit', detail: 'src/tasklist.js', klasse: 'schreibt' }],
    [5100, { typ: 'aktion', rolle: 'coder', name: 'Edit', detail: 'src/tasklist.js', klasse: 'schreibt' }],
    [5900, { typ: 'aktion', rolle: 'coder', name: 'Bash', detail: 'node --test', klasse: 'bash' }],
    [6700, { typ: 'aktion', rolle: 'coder', name: 'Edit', detail: 'test/tasklist.test.js', klasse: 'schreibt' }],
    [7000, {
      typ: 'guard',
      meldung: 'Blocked: existing tests must not be changed. Fix the code.',
      hook: 'PreToolUse:Edit',
      werkzeug: { name: 'Edit' }
    }],
    [8600, { typ: 'aktion', rolle: 'coder', name: 'Write', detail: 'test/tasklist-close.test.js', klasse: 'schreibt' }],
    [9400, { typ: 'aktion', rolle: 'coder', name: 'Bash', detail: 'node --test', klasse: 'bash' }],
    [10200, { typ: 'rolle', rolle: 'reviewer', auftrag: 'prüft den Commit gegen die Aufgabe' }],
    [11000, { typ: 'aktion', rolle: 'reviewer', name: 'Bash', detail: 'git diff HEAD~1', klasse: 'bash' }],
    [11800, { typ: 'aktion', rolle: 'reviewer', name: 'Read', detail: 'src/tasklist.js', klasse: 'liest' }],
    [12600, { typ: 'rolle', rolle: 'chef', auftrag: 'trägt den Befund ein und committet' }],
    [13400, { typ: 'aktion', rolle: 'chef', name: 'Write', detail: 'STATUS.md', klasse: 'schreibt' }],
    [14000, { typ: 'kosten', usd: 0.58, turns: 16 }],
    [14200, { typ: 'tests', gruen: true, anzahl: 27 }],
    [15000, { typ: 'runde', i: 2, max: 4, modell: 'sonnet', aufwand: 'high' }],
    [15400, { typ: 'rolle', rolle: 'chef', auftrag: 'wählt die nächste Aufgabe' }],
    [16200, { typ: 'rolle', rolle: 'coder', auftrag: 'Add stats(text) returning open/done/total' }],
    [17000, { typ: 'aktion', rolle: 'coder', name: 'Edit', detail: 'src/tasklist.js', klasse: 'schreibt' }]
  ]
  if (szene === 'guard') {
    // Direkt in den Sperrmoment und dort stehen bleiben.
    tafelBleibt = true
    const bis = drehbuch.findIndex(([, e]) => e.typ === 'guard')
    drehbuch.slice(0, bis + 1).forEach(([, e], i) => setTimeout(() => verarbeite(e), i * 40))
    return
  }
  for (const [ms, e] of drehbuch) setTimeout(() => verarbeite(e), ms)
}

// ------------------------------------------------------------------- Start

const parameter = new URLSearchParams(location.search)

baueKnoten()

// Das zuletzt gewählte Projekt merken. Wer das Cockpit neu lädt, will nicht
// jedes Mal wieder durch den Projektdialog.
const gemerkt = parameter.get('projekt') || localStorage.getItem('cockpit.projekt')
if (gemerkt) {
  zustand.projekt = gemerkt
  zustand.projektName = gemerkt.split(/[\\/]/).pop()
}

render()
requestAnimationFrame(takt)

if (parameter.has('probe')) {
  // Der Probelauf spielt sich selbst ab. Es gibt keine Leitung, die abreissen
  // koennte -- ohne diese Zeile meldete die Kopfleiste hier "VERBINDUNG WEG",
  // und eine Warnung, die im Normalfall angeht, liest bald niemand mehr.
  zustand.ohneStrom = true
  probelauf(parameter.get('probe'))
} else {
  verbinde()
  if (!zustand.projekt) blattProjekt()
}
