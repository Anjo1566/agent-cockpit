'use strict'

// Der lokale Server hinter dem Cockpit.
//
// Bewusst ohne jede Abhaengigkeit: Node bringt alles mit, was hier gebraucht
// wird. Kein npm install, kein Build, kein CDN -- das Ding startet auch in
// einem Jahr noch, wenn niemand mehr weiss, welche Version von irgendwas es
// wollte. Live-Ereignisse gehen ueber Server-Sent Events; ein WebSocket waere
// mehr Maschinerie fuer weniger.
//
// Der Server hoert nur auf 127.0.0.1. Er darf Prozesse starten und Dateien im
// Projekt schreiben; er gehoert deshalb nicht ins Netz.

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const projekte = require('./lib/projekte.js')
const konfig = require('./lib/konfig.js')
const { Lauf } = require('./lib/lauf.js')

const PORT = Number(process.env.COCKPIT_PORT || 4173)
const WURZEL = process.env.COCKPIT_WURZEL || path.resolve(__dirname, '..')
const SCAFFOLD = process.env.COCKPIT_SCAFFOLD || path.resolve(__dirname, '..', 'agent-loop')
const OEFFENTLICH = path.join(__dirname, 'public')

const lauf = new Lauf()
const verbunden = new Set()

lauf.on('ereignis', (e) => {
  const nachricht = `data: ${JSON.stringify(e)}\n\n`
  for (const antwort of verbunden) {
    try { antwort.write(nachricht) } catch { verbunden.delete(antwort) }
  }
})

// --- kleine Helfer -------------------------------------------------------

function json (antwort, code, koerper) {
  const text = JSON.stringify(koerper)
  antwort.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  antwort.end(text)
}

function koerperLesen (anfrage) {
  return new Promise((fertig, fehler) => {
    let roh = ''
    anfrage.on('data', s => {
      roh += s
      if (roh.length > 1e6) { anfrage.destroy(); fehler(new Error('Zu gross.')) }
    })
    anfrage.on('end', () => {
      try { fertig(roh ? JSON.parse(roh) : {}) } catch (e) { fehler(new Error('Kein gueltiges JSON.')) }
    })
    anfrage.on('error', fehler)
  })
}

const TYPEN = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

function datei (antwort, name) {
  // Nur aus public/, und nichts mit .. darin.
  const ziel = path.join(OEFFENTLICH, path.normalize(name).replace(/^([/\\])+/, ''))
  if (!ziel.startsWith(OEFFENTLICH)) { antwort.writeHead(403).end(); return }
  fs.readFile(ziel, (f, inhalt) => {
    if (f) { antwort.writeHead(404, { 'content-type': 'text/plain' }).end('Nicht gefunden.'); return }
    antwort.writeHead(200, {
      'content-type': (TYPEN[path.extname(ziel)] || 'application/octet-stream') + '; charset=utf-8',
      'cache-control': 'no-store'
    })
    antwort.end(inhalt)
  })
}

/** Ein Projektpfad aus der Anfrage, gegen die Wurzel geprueft. */
function projektPfad (wert) {
  if (!wert || typeof wert !== 'string') throw new Error('Kein Projekt angegeben.')
  const p = path.resolve(wert)
  if (!p.startsWith(path.resolve(WURZEL))) throw new Error('Dieses Projekt liegt ausserhalb der Wurzel.')
  if (!projekte.istRepo(p)) throw new Error('Das ist kein Git-Repository.')
  return p
}

function lies (projekt, rel, ersatz = '') {
  try { return fs.readFileSync(path.join(projekt, rel), 'utf8') } catch { return ersatz }
}

// --- Routen --------------------------------------------------------------

const server = http.createServer(async (anfrage, antwort) => {
  const url = new URL(anfrage.url, 'http://localhost')
  const weg = url.pathname

  try {
    if (weg === '/' || weg === '/index.html') return datei(antwort, 'index.html')
    if (weg.startsWith('/public/')) return datei(antwort, weg.slice(8))
    if (/^\/[\w.-]+\.(js|css|svg)$/.test(weg)) return datei(antwort, weg.slice(1))

    // Live-Strom.
    if (weg === '/api/strom') {
      antwort.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      })
      antwort.write(': verbunden\n\n')
      // Wer spaeter dazukommt, bekommt erst den Zustand, dann die Historie.
      antwort.write(`data: ${JSON.stringify({ typ: 'zustand', ...lauf.zustand })}\n\n`)
      for (const e of lauf.verlauf.slice(-120)) {
        antwort.write(`data: ${JSON.stringify(e)}\n\n`)
      }
      verbunden.add(antwort)
      const puls = setInterval(() => { try { antwort.write(': puls\n\n') } catch {} }, 20000)
      anfrage.on('close', () => { clearInterval(puls); verbunden.delete(antwort) })
      return
    }

    if (weg === '/api/projekte' && anfrage.method === 'GET') {
      return json(antwort, 200, {
        wurzel: WURZEL,
        scaffold: SCAFFOLD,
        scaffoldDa: fs.existsSync(path.join(SCAFFOLD, 'loop.sh')),
        projekte: projekte.liste(WURZEL)
      })
    }

    if (weg === '/api/projekt' && anfrage.method === 'GET') {
      const p = projektPfad(url.searchParams.get('pfad'))
      const stand = projekte.installationsStand(p)
      return json(antwort, 200, {
        ...projekte.details(p),
        tasks: lies(p, 'TASKS.md'),
        status: lies(p, 'STATUS.md'),
        fragen: lies(p, 'QUESTIONS.md'),
        konfig: stand.eingerichtet ? konfig.lies(p) : null,
        vorschlagTestbefehl: projekte.testbefehlRaten(p)
      })
    }

    if (weg === '/api/installieren' && anfrage.method === 'POST') {
      const k = await koerperLesen(anfrage)
      const p = projektPfad(k.pfad)
      const bericht = projekte.installiere(p, SCAFFOLD)
      // Den geratenen Testbefehl gleich eintragen, damit der erste Lauf laeuft.
      try {
        konfig.schreib(p, { TESTBEFEHL: k.testbefehl || projekte.testbefehlRaten(p) })
      } catch { /* der Nutzer kann ihn in den Einstellungen setzen */ }
      return json(antwort, 200, { bericht, projekt: projekte.details(p) })
    }

    if (weg === '/api/tasks' && anfrage.method === 'POST') {
      const k = await koerperLesen(anfrage)
      const p = projektPfad(k.pfad)
      if (typeof k.text !== 'string') throw new Error('Kein Text.')
      fs.writeFileSync(path.join(p, 'TASKS.md'), k.text.replace(/\r\n/g, '\n'), 'utf8')
      return json(antwort, 200, { tasks: lies(p, 'TASKS.md') })
    }

    if (weg === '/api/konfig' && anfrage.method === 'POST') {
      const k = await koerperLesen(anfrage)
      const p = projektPfad(k.pfad)
      return json(antwort, 200, konfig.schreib(p, k.werte || {}))
    }

    if (weg === '/api/start' && anfrage.method === 'POST') {
      const k = await koerperLesen(anfrage)
      const p = projektPfad(k.pfad)
      const runden = Math.max(1, Math.min(200, Number(k.runden) || 3))
      return json(antwort, 200, lauf.starten(p, runden))
    }

    if (weg === '/api/stop' && anfrage.method === 'POST') {
      const k = await koerperLesen(anfrage)
      return json(antwort, 200, lauf.stoppen(k.modus === 'hart' ? 'hart' : 'sanft'))
    }

    if (weg === '/api/zustand' && anfrage.method === 'GET') {
      return json(antwort, 200, lauf.zustand)
    }

    antwort.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    antwort.end('Nicht gefunden.')
  } catch (f) {
    json(antwort, 400, { fehler: f.message })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  const adresse = `http://127.0.0.1:${PORT}`
  console.log('')
  console.log('  REISSBRETT — Cockpit fuer den Agenten-Loop')
  console.log('  ' + '─'.repeat(44))
  console.log(`  Offen unter   ${adresse}`)
  console.log(`  Projekte aus  ${WURZEL}`)
  console.log(`  Scaffold aus  ${SCAFFOLD}${fs.existsSync(path.join(SCAFFOLD, 'loop.sh')) ? '' : '   << fehlt!'}`)
  console.log('')
  console.log('  Beenden mit Strg+C.')
  console.log('')

  if (!process.env.COCKPIT_KEIN_BROWSER) {
    const [befehl, args] = process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', adresse]]
      : process.platform === 'darwin'
        ? ['open', [adresse]]
        : ['xdg-open', [adresse]]
    execFile(befehl, args, () => { /* kein Browser ist kein Fehler */ })
  }
})

process.on('SIGINT', () => {
  console.log('\n  Cockpit beendet. Ein laufender Loop laeuft im Hintergrund weiter.')
  process.exit(0)
})
