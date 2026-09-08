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
const https = require('node:https')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const projekte = require('./lib/projekte.js')
const konfig = require('./lib/konfig.js')
const zertifikat = require('./lib/zertifikat.js')
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
  const relativ = path.relative(path.resolve(WURZEL), p)
  if (relativ.startsWith('..') || path.isAbsolute(relativ)) throw new Error('Dieses Projekt liegt ausserhalb der Wurzel.')
  if (!projekte.istRepo(p)) throw new Error('Das ist kein Git-Repository.')
  return p
}

function lies (projekt, rel, ersatz = '') {
  try { return fs.readFileSync(path.join(projekt, rel), 'utf8') } catch { return ersatz }
}

// --- Routen --------------------------------------------------------------

const behandeln = async (anfrage, antwort) => {
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
      // Der Testbefehl und der Zielbranch werden in installiere() gesetzt --
      // dort ist auch bekannt, ob geraten wurde oder nicht.
      const bericht = projekte.installiere(p, SCAFFOLD)
      return json(antwort, 200, { bericht, projekt: projekte.details(p) })
    }

    if (weg === '/api/anlegen' && anfrage.method === 'POST') {
      const k = await koerperLesen(anfrage)
      return json(antwort, 200, projekte.anlegen(WURZEL, k.name, SCAFFOLD, !!k.leer))
    }

    if (weg === '/api/tasks' && anfrage.method === 'POST') {
      const k = await koerperLesen(anfrage)
      const p = projektPfad(k.pfad)
      if (typeof k.text !== 'string') throw new Error('Kein Text.')
      fs.writeFileSync(path.join(p, 'TASKS.md'), k.text.replace(/\r\n/g, '\n'), 'utf8')
      // Sofort committen: sonst blockiert der eigene Backlog-Eintrag den Start.
      const gesichert = projekte.sichere(p, ['TASKS.md'], 'Update the backlog')
      return json(antwort, 200, { tasks: lies(p, 'TASKS.md'), gesichert })
    }

    if (weg === '/api/konfig' && anfrage.method === 'POST') {
      const k = await koerperLesen(anfrage)
      const p = projektPfad(k.pfad)
      const stand = konfig.schreib(p, k.werte || {})
      // loop.sh ist versioniert -- ohne Commit bleibt das Verzeichnis schmutzig.
      const gesichert = projekte.sichere(p, ['loop.sh'], 'Update the loop configuration')
      return json(antwort, 200, { ...stand, gesichert })
    }

    if (weg === '/api/start' && anfrage.method === 'POST') {
      const k = await koerperLesen(anfrage)
      const p = projektPfad(k.pfad)
      const runden = Math.max(1, Math.min(200, Number(k.runden) || 3))
      // Ungueltige oder ausserhalb [1, 200] liegende Werte wurden bisher
      // stillschweigend ersetzt/geklemmt -- ohne Rueckmeldung merkte der
      // Aufrufer nie, dass sein Wunschwert ignoriert wurde.
      const angepasst = Number(k.runden) !== runden ? { angefordert: k.runden, verwendet: runden } : null
      return json(antwort, 200, { ...lauf.starten(p, runden), angepasst })
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
}

const httpServer = http.createServer(behandeln)

// Chrome kann so eingestellt sein, dass es jede http-Adresse auf https
// hochstuft -- auch localhost. Dann schickt es einen TLS-Handshake an den
// HTTP-Port, und der Nutzer sieht nur ERR_SSL_PROTOCOL_ERROR. Statt zu
// verlangen, dass er dafuer eine Sicherheitseinstellung aufweicht, spricht das
// Cockpit beides: auf demselben Port, unterschieden am ersten Byte.
const zert = zertifikat.besorgen()
const httpsServer = zert ? https.createServer(zert, behandeln) : null

let tlsGemeldet = false

function weiche (socket) {
  socket.once('error', () => { try { socket.destroy() } catch { /* schon zu */ } })
  socket.once('data', (stueck) => {
    // Ein TLS-Handshake faengt mit 0x16 an. Jede HTTP-Anfrage mit einem
    // Buchstaben.
    const tls = stueck[0] === 0x16

    if (tls && !httpsServer) {
      if (!tlsGemeldet) {
        tlsGemeldet = true
        console.log('')
        console.log('  !! Dein Browser hat HTTPS versucht, nicht HTTP, und')
        console.log('     hier gibt es kein Zertifikat (openssl fehlt).')
        console.log('     Deshalb siehst du ERR_SSL_PROTOCOL_ERROR.')
        console.log('')
        console.log('     Abhilfe: chrome://net-internals/#hsts oeffnen, unten')
        console.log('     bei "Delete domain security policies" nacheinander')
        console.log('     localhost und 127.0.0.1 eintragen und loeschen.')
        console.log('')
      }
      socket.destroy()
      return
    }

    socket.pause()
    socket.unshift(stueck)
    ;(tls ? httpsServer : httpServer).emit('connection', socket)
    process.nextTick(() => socket.resume())
  })
}

const server = net.createServer(weiche)
// Zweiter Zuhoerer auf ::1: Chrome loest "localhost" bevorzugt nach IPv6 auf.
// Beides bleibt auf dem Loopback -- nichts davon ist im Netz erreichbar.
const serverV6 = net.createServer(weiche)

function browserOeffnen (adresse) {
  if (process.env.COCKPIT_KEIN_BROWSER) return
  const [befehl, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', adresse]]
    : process.platform === 'darwin'
      ? ['open', [adresse]]
      : ['xdg-open', [adresse]]
  execFile(befehl, args, () => { /* kein Browser ist kein Fehler */ })
}

/** Läuft auf diesem Port schon ein Cockpit, oder etwas Fremdes? */
function schonEinCockpit (port) {
  return new Promise((fertig) => {
    const anfrage = http.get(
      { host: '127.0.0.1', port, path: '/api/zustand', timeout: 800 },
      (antwort) => {
        let roh = ''
        antwort.on('data', s => { roh += s })
        antwort.on('end', () => {
          try { fertig(typeof JSON.parse(roh).laeuft === 'boolean') } catch { fertig(false) }
        })
      })
    anfrage.on('error', () => fertig(false))
    anfrage.on('timeout', () => { anfrage.destroy(); fertig(false) })
  })
}

function starten (port, versuche = 10) {
  server.removeAllListeners('error')

  server.once('error', async (f) => {
    if (f.code !== 'EADDRINUSE') {
      console.error(`\n  Der Server konnte nicht starten: ${f.message}\n`)
      process.exit(1)
    }

    // Der haeufigste Fall von allen: das Cockpit laeuft schon, in einem anderen
    // Fenster oder von vorhin. Ohne diesen Zweig sieht man einen rohen
    // Node-Stacktrace und keinen Hinweis, was zu tun waere.
    if (await schonEinCockpit(port)) {
      const adresse = `http://127.0.0.1:${port}`
      console.log('')
      console.log('  Das Cockpit laeuft bereits.')
      console.log(`  Ich oeffne es: ${adresse}`)
      console.log('')
      console.log('  Willst du wirklich neu starten, schliess zuerst das andere')
      console.log('  Fenster (Strg+C) und starte diese Datei erneut.')
      console.log('')
      browserOeffnen(adresse)
      process.exit(0)
    }

    if (versuche > 0) {
      console.log(`  Port ${port} ist belegt, ich nehme ${port + 1}.`)
      starten(port + 1, versuche - 1)
      return
    }

    console.error(`\n  Die Ports ${PORT} bis ${port} sind alle belegt.`)
    console.error('  Setze COCKPIT_PORT auf einen freien Port.\n')
    process.exit(1)
  })

  server.listen(port, '127.0.0.1', () => {
    // Auch auf IPv6 horchen. Schlaegt das fehl (kein IPv6 auf dem Rechner),
    // ist das kein Grund, den Start abzubrechen.
    serverV6.on('error', () => {})
    serverV6.listen(port, '::1')

    // Wenn ein Zertifikat da ist, ist https die Adresse, die in jeder
    // Browsereinstellung funktioniert -- auch in einer, die http hochstuft.
    const adresse = (httpsServer ? 'https' : 'http') + `://localhost:${port}`
    // Bewusst nur ASCII: das Windows-Konsolenfenster laeuft nicht auf UTF-8,
    // und ein Gedankenstrich wird dort zu Zeichensalat -- ausgerechnet in der
    // ersten Zeile, die der Nutzer ueberhaupt zu sehen bekommt.
    console.log('')
    console.log('  REISSBRETT - Cockpit fuer den Agenten-Loop')
    console.log('  ' + '-'.repeat(43))
    console.log(`  Offen unter   ${adresse}`)
    console.log(`  oder          ${httpsServer ? 'https' : 'http'}://127.0.0.1:${port}`)
    console.log(`  Projekte aus  ${WURZEL}`)
    console.log(`  Scaffold aus  ${SCAFFOLD}${fs.existsSync(path.join(SCAFFOLD, 'loop.sh')) ? '' : '   << FEHLT!'}`)
    console.log('')
    console.log('  Beenden mit Strg+C.')
    console.log('')
    if (httpsServer) {
      console.log('  Der Port versteht HTTP und HTTPS gleichzeitig -- egal, was')
      console.log('  dein Browser daraus macht, er kommt an.')
      console.log('')
      console.log('  Beim ersten Mal warnt Chrome vor dem eigenen Zertifikat:')
      console.log('    "Erweitert" > "Weiter zu localhost (unsicher)".')
      console.log('  Das Zertifikat gilt nur fuer localhost auf diesem Rechner.')
    } else {
      console.log('  Hinweis: openssl wurde nicht gefunden, deshalb nur HTTP.')
      console.log('  Zeigt der Browser ERR_SSL_PROTOCOL_ERROR, erzwingt er HTTPS:')
      console.log('    chrome://net-internals/#hsts oeffnen, unten bei "Delete')
      console.log('    domain security policies" localhost und 127.0.0.1 loeschen.')
    }
    console.log('')
    browserOeffnen(adresse)
  })
}

starten(PORT)

process.on('SIGINT', () => {
  console.log('\n  Cockpit beendet. Ein laufender Loop laeuft im Hintergrund weiter.')
  process.exit(0)
})
