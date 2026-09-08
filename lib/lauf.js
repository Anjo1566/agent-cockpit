'use strict'

// Startet und ueberwacht einen Lauf und uebersetzt den Ereignisstrom in den
// Zustand, den das Cockpit zeichnet.
//
// Zwei Quellen, bewusst getrennt:
//   1. stdout von loop.sh -- die Entscheidungen des Skripts: Rundenkopf, rote
//      Suite, Abbruchgrund, Pull Request. Das ist die Wahrheit ueber den Lauf.
//   2. .agents/round-N.ndjson -- der Ereignisstrom der Sitzung: Rollenwechsel,
//      Werkzeugaufrufe, Guards. Das ist die Wahrheit ueber die Runde.
//
// Der Zustand ist ein einziges Objekt. Die Oberflaeche zeichnet ausschliesslich
// daraus -- niemals aus einer Abfolge von Animationen. Sonst haengt nach einem
// verpassten Ereignis fuer immer die falsche Rolle gross auf dem Schirm.

const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { EventEmitter } = require('node:events')

const ROLLEN = ['chef', 'coder', 'reviewer']

// Welcher Subagent auf welchem Knoten des Bretts sitzt. Der grader ist ein
// eigener Subagent, teilt sich aber den Platz des Reviewers: beide pruefen,
// keiner aendert etwas.
//
// Bis hierher fehlte er in dieser Tabelle, und das war teuer: ein Subagent,
// den die Tabelle nicht kennt, loest keinen Rollenwechsel aus. Der grader
// arbeitete also unter dem Namen des Reviewers weiter, auf dessen Uhr -- und
// als er vier Stunden lang haengen blieb, stand am Reviewer eine Standzeit,
// die niemandem gehoerte. Wer nicht auf dem Brett steht, kann auch nicht
// haengen sehen.
const KNOTEN = { chef: 'chef', coder: 'coder', reviewer: 'reviewer', grader: 'reviewer' }

/**
 * Findet die Bash. Auf Windows liegt sie bei Git for Windows und ist oft NICHT
 * im PATH -- `spawn('bash')` schlaegt dann fehl, und zwar still, weil der
 * Fehler nur als Ereignis kommt. Dieselbe Suchreihenfolge wie Claude Code.
 */
function bashFinden () {
  if (process.env.COCKPIT_BASH) return process.env.COCKPIT_BASH
  if (process.platform !== 'win32') return 'bash'

  const kandidaten = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
  ].filter(Boolean)
  for (const k of kandidaten) if (fs.existsSync(k)) return k

  // Letzter Versuch: neben der git.exe aus dem PATH.
  try {
    const wo = execFileSync('where', ['git'], { encoding: 'utf8' }).split('\n')[0].trim()
    const geraten = path.resolve(path.dirname(wo), '..', 'bin', 'bash.exe')
    if (fs.existsSync(geraten)) return geraten
  } catch { /* dann eben nicht */ }

  return 'bash'
}

class Lauf extends EventEmitter {
  constructor () {
    super()
    this.zurueckgesetzt()
    this.verlauf = []       // die letzten Ereignisse, fuer Nachzuegler beim Verbinden
    this.prozess = null
    this.tailer = null
  }

  zurueckgesetzt () {
    this.zustand = {
      laeuft: false,
      projekt: null,
      runde: 0,
      runden: 0,
      modell: null,
      aufwand: null,
      rolle: 'chef',          // der Knoten auf dem Brett
      taetig: 'chef',         // der Subagent, der ihn besetzt (grader sitzt beim reviewer)
      auftrag: null,          // was die aktive Rolle tut, eine Zeile
      werkzeug: null,         // der letzte Werkzeugaufruf
      seit: null,             // Zeitpunkt des letzten Rollenwechsels
      letztesEreignis: null,  // fuer "denkt seit X s"
      start: null,
      tests: { anzahl: null, gruen: null },
      note: null,             // Gesamtnote des graders, 0 bis 10
      zielnote: null,         // ab hier gilt der Auftrag als erledigt
      notenband: [],          // je Runde: {i, note}
      kosten: 0,
      turns: 0,
      verbrauch: {          // Tokens, ueber den ganzen Lauf aufsummiert, nicht pro Runde
        eingabe: 0,
        ausgabe: 0,
        cacheGelesen: 0,
        cacheGeschrieben: 0,
        proModell: {}        // Modellname -> dieselben vier Zaehler
      },
      blocker: 0,
      guards: 0,
      fragen: 0,
      rundenband: [],         // je Runde: {i, gruen, geblockt, dauer}
      gesperrt: null,         // aktive Sperrtafel {meldung, werkzeug, detail}
      ende: null,             // {grund, pr}
      // Wahr, wenn dieses Cockpit den Lauf nicht selbst gestartet, sondern
      // sich an einen laufenden angehaengt hat. Dann fehlt alles, was vor dem
      // Anhaengen passiert ist, und das Brett sagt es.
      wiederaufgenommen: false,
      fremdePid: null
    }
  }

  /** Ereignis an alle Verbundenen, und in den Verlauf. */
  sende (typ, daten = {}) {
    const e = { typ, t: Date.now(), ...daten }
    this.verlauf.push(e)
    if (this.verlauf.length > 400) this.verlauf.shift()
    this.emit('ereignis', e)
  }

  starten (projekt, runden) {
    if (this.zustand.laeuft) throw new Error('Es laeuft bereits ein Lauf.')
    clearInterval(this.fremdWache)
    this.fremdWache = null

    // Der Merker oben lebt nur im Arbeitsspeicher. Stirbt das Cockpit -- und
    // das README wirbt ausdruecklich damit, dass der Loop dann weiterlaeuft --,
    // steht das neu gestartete auf "BEREIT" und wuerde bereitwillig einen
    // ZWEITEN Lauf im selben Projekt starten. Zwei loop.sh im selben
    // Arbeitsbaum bedeuten zwei Branches, zwei Testlaeufe und einen Wettlauf um
    // dieselben Dateien. (Befund B3 aus dem Review.)
    //
    // Deshalb liegt der Merker zusaetzlich auf der Platte, neben dem Lauf, zu
    // dem er gehoert.
    const fremd = laufendeFremdePid(projekt)
    if (fremd !== null) {
      throw new Error(
        `In diesem Projekt laeuft bereits ein Lauf (Prozess ${fremd}), vermutlich ` +
        'aus einem frueheren Cockpit-Fenster. Beende ihn dort, oder warte, bis er ' +
        'fertig ist -- zwei Laeufe im selben Arbeitsverzeichnis kommen sich in die Quere.')
    }

    const sauber = execFileSync('git', ['status', '--porcelain'],
      { cwd: projekt, encoding: 'utf8' }).trim()
    if (sauber) {
      // Ohne die Liste sucht man selbst -- und uebersieht dabei leicht, dass
      // es dieselbe Datei ist, die man gerade im Cockpit bearbeitet hat.
      const offen = sauber.split(/\r?\n/).map((z) => z.slice(3).trim())
      throw new Error('Das Arbeitsverzeichnis ist nicht sauber. ' +
        'Der Agent wuerde deine offenen Aenderungen mitcommitten. Offen: ' +
        offen.slice(0, 6).join(', ') +
        (offen.length > 6 ? ` und ${offen.length - 6} weitere` : '') + '.')
    }

    this.zurueckgesetzt()
    this.verlauf = []
    Object.assign(this.zustand, {
      laeuft: true,
      projekt,
      runden: Number(runden),
      start: Date.now(),
      seit: Date.now(),
      letztesEreignis: Date.now()
    })

    const bash = bashFinden()
    this.prozess = spawn(bash, ['loop.sh', String(runden)], {
      cwd: projekt,
      env: { ...process.env, AGENT_LOOP_EVENTS: '1' },
      windowsHide: true
    })

    // Ohne diesen Zweig scheitert ein fehlender Interpreter lautlos: das
    // Cockpit zeigte "laeuft", und im Projekt passierte nie etwas.
    this.prozess.on('error', (f) => {
      this.zustand.laeuft = false
      this.stopTailer()
      merkerLoeschen(projekt)
      this.zustand.ende = {
        grund: `Der Loop liess sich nicht starten: ${f.message} (Interpreter: ${bash}). ` +
          'Setze COCKPIT_BASH auf den Pfad deiner bash.exe.'
      }
      this.sende('log', { zeile: this.zustand.ende.grund })
      this.sende('ende', this.zustand.ende)
      this.sende('zustand', this.zustand)
    })

    this.prozess.stdout.setEncoding('utf8')
    this.prozess.stderr.setEncoding('utf8')
    let rest = ''
    const zeilen = (stueck) => {
      rest += stueck
      const teile = rest.split('\n')
      rest = teile.pop()
      for (const z of teile) this.skriptZeile(z.trimEnd())
    }
    this.prozess.stdout.on('data', zeilen)
    this.prozess.stderr.on('data', zeilen)

    merkerSchreiben(projekt, this.prozess.pid, Number(runden))

    this.prozess.on('close', (code) => {
      this.zustand.laeuft = false
      this.stopTailer()
      merkerLoeschen(projekt)
      const grund = this.lies('.agents/stop-reason.txt') ||
        (code === 0 ? 'Lauf beendet.' : `Lauf abgebrochen (Rueckgabewert ${code}).`)
      this.zustand.ende = { grund: grund.trim(), pr: this.prLink }
      this.sende('ende', this.zustand.ende)
      this.sende('zustand', this.zustand)
    })

    this.fragenPruefen()
    this.sende('start', { projekt, runden })
    this.sende('zustand', this.zustand)
    return this.zustand
  }

  /**
   * Haengt sich an einen Lauf, der schon laeuft.
   *
   * Ohne das zeigte ein neu gestartetes Cockpit "BEREIT", waehrend im Projekt
   * eine Runde lief: der Merker verhinderte nur einen zweiten Start, holte den
   * ersten aber nicht auf den Schirm. Wer das Fenster schloss oder den Server
   * neu startete, sah bis zum Ende des Laufs nichts mehr -- also genau
   * waehrend der Stunden, fuer die dieses Programm gebaut ist.
   *
   * Wiederaufgenommen wird nur, was auf der Platte steht: der Ereignisstrom
   * der laufenden Runde und die Zeilen, die loop.sh in .agents/run.log
   * schreibt. Die Standardausgabe des fremden Prozesses gehoert einem anderen
   * Terminal und ist nicht zurueckzuholen; das Cockpit sagt das auch.
   *
   * @param {string[]} pfade  Projektverzeichnisse, die geprueft werden.
   */
  wiederaufnehmen (pfade) {
    if (this.zustand.laeuft) return null
    for (const projekt of pfade || []) {
      const pid = laufendeFremdePid(projekt) ?? loopLaeuftPid(projekt)
      if (pid === null) continue

      const runde = neuesteRunde(projekt)
      let runden = 0
      try {
        runden = Number(JSON.parse(fs.readFileSync(merkerPfad(projekt), 'utf8')).runden) || 0
      } catch { /* loop.sh selbst schreibt keine Rundenzahl */ }

      this.zurueckgesetzt()
      this.verlauf = []
      Object.assign(this.zustand, {
        laeuft: true,
        wiederaufgenommen: true,
        fremdePid: pid,
        projekt,
        projektName: path.basename(projekt),
        runde,
        runden: Math.max(runden, runde),
        start: Date.now(),
        seit: Date.now(),
        letztesEreignis: Date.now()
      })
      this.sende('log', {
        zeile: `Cockpit an einen laufenden Lauf angehaengt (Prozess ${pid}, Runde ${runde || '?'}). ` +
               'Was vor dem Anhaengen passiert ist, steht nur im Rundenprotokoll.'
      })
      if (runde) this.tailStart(runde)
      this.fremdBeobachten(projekt, pid)
      this.sende('zustand', this.zustand)
      return this.zustand
    }
    return null
  }

  /** Beobachtet einen fremden Lauf: neue Runde, und das Ende. */
  fremdBeobachten (projekt, pid) {
    clearInterval(this.fremdWache)
    this.fremdWache = setInterval(() => {
      let lebt = true
      try { process.kill(pid, 0) } catch { lebt = false }

      const runde = neuesteRunde(projekt)
      if (runde && runde !== this.zustand.runde) {
        this.zustand.runde = runde
        this.zustand.runden = Math.max(this.zustand.runden, runde)
        this.zustand.seit = Date.now()
        this.tailStart(runde)
        this.sende('runde', { i: runde, max: this.zustand.runden, modell: this.zustand.modell, aufwand: this.zustand.aufwand })
      }

      if (!lebt) {
        clearInterval(this.fremdWache)
        this.fremdWache = null
        this.stopTailer()
        this.zustand.laeuft = false
        const grund = this.lies('.agents/stop-reason.txt')
        this.zustand.ende = { grund: (grund || 'Der fremde Lauf ist beendet.').trim() }
        this.sende('ende', this.zustand.ende)
        this.sende('zustand', this.zustand)
      }
    }, 2000)
  }

  lies (rel) {
    try {
      return fs.readFileSync(path.join(this.zustand.projekt, rel), 'utf8')
    } catch { return null }
  }

  /** Eine Zeile von loop.sh selbst. Hier stehen die Entscheidungen des Skripts. */
  skriptZeile (zeile) {
    if (!zeile) return
    this.sende('log', { zeile })

    let m
    if ((m = zeile.match(/^=== Runde (\d+)\/(\d+) — (\S+) \/ (\S+) ===$/))) {
      const [, i, max, modell, aufwand] = m
      Object.assign(this.zustand, {
        runde: Number(i),
        runden: Number(max),
        modell,
        aufwand,
        rolle: 'chef',
        taetig: 'chef',
        auftrag: 'liest TASKS.md und STATUS.md',
        werkzeug: null,
        gesperrt: null,
        seit: Date.now()
      })
      this.tailStart(Number(i))
      this.sende('runde', { i: Number(i), max: Number(max), modell, aufwand })
      this.sende('rolle', { rolle: 'chef', taetig: 'chef', auftrag: this.zustand.auftrag })
      return
    }

    // Die Note ist das eigentliche Fortschrittsmass dieses Laufs. Die
    // Rundenzahl sagt nur, wie oft es versucht wurde.
    if ((m = zeile.match(/^Note nach Runde (\d+): ([0-9.]+) von 10 \(Ziel ([0-9.]+)\)(?: . (.*))?$/))) {
      const [, i, note, ziel, begruendung] = m
      this.zustand.note = Number(note)
      this.zustand.zielnote = Number(ziel)
      this.zustand.notenband.push({ i: Number(i), note: Number(note) })
      this.sende('note', {
        i: Number(i),
        note: Number(note),
        ziel: Number(ziel),
        begruendung: begruendung || null
      })
      return
    }

    if (/keine brauchbare Note hinterlassen/.test(zeile)) {
      this.sende('note', { i: this.zustand.runde, note: null, ziel: this.zustand.zielnote })
      return
    }

    if (/^Testsuite rot/.test(zeile)) {
      this.zustand.tests.gruen = false
      this.rundenbandEintrag({ gruen: false })
      this.sende('tests', { gruen: false, anzahl: this.zustand.tests.anzahl })
      return
    }

    if ((m = zeile.match(/Testanzahl gesunken \((\d+) auf (\d+)\)/))) {
      this.zustand.tests = { anzahl: Number(m[2]), gruen: false }
      this.sende('tests', { gruen: false, anzahl: Number(m[2]), gefallenVon: Number(m[1]) })
      return
    }

    if ((m = zeile.match(/^https:\/\/github\.com\/\S+\/pull\/\d+/))) {
      this.prLink = m[0]
      this.sende('pr', { url: m[0] })
      return
    }

    if (/^(Auftrag erledigt|Zielnote erreicht|Rundenlimit|Runde \d+ ohne Commit|\d+ Runden ohne|Testsuite auch|Session in Runde|Testanzahl gesunken|Runde \d+ hat bestehende)/.test(zeile)) {
      this.zustand.ende = { grund: zeile }
      this.sende('grund', { grund: zeile })
    }
  }

  // --- Ereignisstrom der Runde -------------------------------------------

  tailStart (runde) {
    this.stopTailer()
    const datei = path.join(this.zustand.projekt, '.agents', `round-${runde}.ndjson`)
    let gelesen = 0
    let rest = ''

    this.tailer = setInterval(() => {
      let groesse
      try { groesse = fs.statSync(datei).size } catch { return }
      if (groesse <= gelesen) return
      let stueck
      let fd = null
      let gelesenJetzt = 0
      try {
        fd = fs.openSync(datei, 'r')
        const puffer = Buffer.alloc(groesse - gelesen)
        gelesenJetzt = fs.readSync(fd, puffer, 0, puffer.length, gelesen)
        stueck = puffer.toString('utf8', 0, gelesenJetzt)
      } catch { return } finally {
        // Ohne finally blieb der Deskriptor bei jedem Lesefehler offen -- und
        // diese Schleife laeuft alle 180 ms, eine ganze Runde lang.
        if (fd !== null) { try { fs.closeSync(fd) } catch { /* schon zu */ } }
      }
      // Weiterzaehlen um das, was wirklich gelesen wurde: readSync darf
      // weniger liefern als angefordert, und dann waere der Rest verloren.
      gelesen += gelesenJetzt
      rest += stueck
      const teile = rest.split('\n')
      rest = teile.pop()
      for (const z of teile) {
        if (!z.trim()) continue
        try { this.stromZeile(JSON.parse(z)) } catch { /* halbe Zeile, kommt gleich ganz */ }
      }
    }, 180)
  }

  stopTailer () {
    if (this.tailer) { clearInterval(this.tailer); this.tailer = null }
  }

  /** Ein Ereignis aus dem Strom der Sitzung. */
  stromZeile (e) {
    this.zustand.letztesEreignis = Date.now()

    if (e.type === 'system' && e.subtype === 'hook_response') {
      // Exit 2 heisst: der Guard hat den Werkzeugaufruf abgelehnt. Das ist der
      // einzige Rueckgabewert, der wirklich blockiert.
      if (e.exit_code === 2) {
        const meldung = String(e.stderr || '').split('\n').find(z => z.startsWith('Blocked:')) ||
          String(e.stderr || '').trim().split('\n')[0] || 'Blockiert.'
        this.zustand.guards += 1
        this.zustand.gesperrt = {
          meldung,
          hook: e.hook_name || 'PreToolUse',
          werkzeug: this.zustand.werkzeug
        }
        this.sende('guard', this.zustand.gesperrt)
      }
      return
    }

    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      for (const block of e.message.content) {
        if (block.type === 'tool_use') this.werkzeugaufruf(block, e)
      }
      return
    }

    if (e.type === 'result') {
      this.zustand.kosten = Number(e.total_cost_usd || 0)
      this.zustand.turns = Number(e.num_turns || 0)
      this.sende('kosten', { usd: this.zustand.kosten, turns: this.zustand.turns })
      this.verbrauchZaehlen(e)
      this.fragenPruefen()
      // Nach der Runde ist wieder der Chef dran, bis die naechste beginnt.
      this.rolleSetzen('chef', 'Runde abgeschlossen')
    }
  }

  /**
   * Zaehlt die Tokens eines result-Ereignisses zum Lauf-Gesamtverbrauch dazu.
   *
   * usage kann komplett fehlen (manche Fehlerergebnisse liefern keins) -- dann
   * bleibt der Verbrauch einfach unveraendert, statt zu werfen. modelUsage
   * benutzt andere Feldnamen (camelCase) als usage (snake_case), weil es aus
   * einer anderen Ecke der CLI kommt.
   */
  verbrauchZaehlen (e) {
    const v = this.zustand.verbrauch
    const u = e.usage
    if (u) {
      v.eingabe += Number(u.input_tokens || 0)
      v.ausgabe += Number(u.output_tokens || 0)
      v.cacheGeschrieben += Number(u.cache_creation_input_tokens || 0)
      v.cacheGelesen += Number(u.cache_read_input_tokens || 0)
    }

    const proModell = e.modelUsage
    if (proModell) {
      for (const [modell, m] of Object.entries(proModell)) {
        if (!v.proModell[modell]) {
          v.proModell[modell] = { eingabe: 0, ausgabe: 0, cacheGelesen: 0, cacheGeschrieben: 0 }
        }
        const eintrag = v.proModell[modell]
        eintrag.eingabe += Number(m.inputTokens || 0)
        eintrag.ausgabe += Number(m.outputTokens || 0)
        eintrag.cacheGelesen += Number(m.cacheReadInputTokens || 0)
        eintrag.cacheGeschrieben += Number(m.cacheCreationInputTokens || 0)
      }
    }

    // v.proModell wird bei jedem weiteren result-Ereignis in-place veraendert.
    // sende() kopiert nur flach, also wuerde ohne diese tiefe Kopie dieselbe
    // proModell-Referenz in jedem historischen 'verbrauch'-Ereignis in
    // this.verlauf landen -- und sich damit rueckwirkend "aendern", wenn ein
    // spaeter beitretender SSE-Client den Verlauf abspielt.
    this.sende('verbrauch', { ...v, proModell: structuredClone(v.proModell) })
  }

  werkzeugaufruf (block, roh) {
    const name = block.name
    const ein = block.input || {}

    // Der Rollenwechsel: der Chef ruft das Agent-Werkzeug mit einem subagent_type.
    if (name === 'Agent' && KNOTEN[ein.subagent_type]) {
      this.rolleSetzen(KNOTEN[ein.subagent_type], ein.description || 'arbeitet',
        ein.subagent_type)
      return
    }

    // Alles andere ist eine Taetigkeit der gerade aktiven Rolle.
    let detail = ''
    if (ein.file_path) detail = String(ein.file_path).replace(/\\/g, '/')
    else if (ein.notebook_path) detail = String(ein.notebook_path).replace(/\\/g, '/')
    else if (ein.command) detail = String(ein.command)
    else if (ein.pattern) detail = String(ein.pattern)

    // Projektpfad wegkuerzen, der Rest ist die Information.
    if (this.zustand.projekt) {
      const p = this.zustand.projekt.replace(/\\/g, '/')
      detail = detail.split(p + '/').join('').split(p).join('.')
    }

    this.zustand.werkzeug = { name, detail, klasse: klasseVon(name, ein) }
    this.sende('aktion', { rolle: this.zustand.rolle, ...this.zustand.werkzeug })
  }

  /**
   * Liest QUESTIONS.md und meldet, was neu dazugekommen ist.
   *
   * Das ist die Datei, in der der Chef festhaelt, was er bewusst NICHT
   * entschieden hat -- neue Abhaengigkeiten, Migrationen, Aenderungen an
   * bestehenden Tests. Sie steht am Ende im Pull Request, aber dann ist der
   * Lauf vorbei. Wer zusieht, soll es sehen, wenn es passiert.
   */
  fragenPruefen () {
    const roh = this.lies('QUESTIONS.md')
    if (roh === null) return
    const eintraege = roh.split(/\r?\n/).filter(z => /^\s*[-*]\s+\S/.test(z))
    const vorher = this.zustand.fragen || 0
    this.zustand.fragen = eintraege.length
    if (eintraege.length > vorher) {
      for (const neu of eintraege.slice(vorher)) {
        this.sende('frage', { text: neu.replace(/^\s*[-*]\s+/, '') })
      }
    }
    this.sende('fragenstand', { anzahl: eintraege.length })
  }

  // `rolle` ist der Knoten auf dem Brett, `taetig` der Subagent, der ihn
  // gerade besetzt. Fuer chef, coder und reviewer ist beides dasselbe; nur
  // der grader sitzt auf einem fremden Platz und muss trotzdem seinen eigenen
  // Namen tragen.
  rolleSetzen (rolle, auftrag, taetig = rolle) {
    if (this.zustand.rolle === rolle && this.zustand.auftrag === auftrag &&
        this.zustand.taetig === taetig) return
    this.zustand.rolle = rolle
    this.zustand.taetig = taetig
    this.zustand.auftrag = auftrag
    this.zustand.werkzeug = null
    this.zustand.seit = Date.now()
    this.sende('rolle', { rolle, auftrag, taetig })
  }

  rundenbandEintrag (feld) {
    const i = this.zustand.runde
    let e = this.zustand.rundenband.find(r => r.i === i)
    if (!e) { e = { i, gruen: null, geblockt: false }; this.zustand.rundenband.push(e) }
    Object.assign(e, feld)
  }

  /**
   * Sanft: .agents/STOP anlegen. Der Loop beendet die laufende Runde, pusht und
   * oeffnet den Pull Request -- der Lauf endet so, wie er soll.
   * Hart: den Prozessbaum abschiessen. Dann gibt es keinen Pull Request.
   */
  stoppen (modus = 'sanft') {
    if (!this.zustand.laeuft) throw new Error('Es laeuft gerade nichts.')

    if (modus === 'sanft') {
      fs.writeFileSync(path.join(this.zustand.projekt, '.agents', 'STOP'),
        'Vom Cockpit angehalten.\n', 'utf8')
      this.sende('log', { zeile: 'Sanft angehalten: der Lauf beendet diese Runde und oeffnet dann den Pull Request.' })
      return { modus }
    }

    const pid = this.prozess && this.prozess.pid
    if (pid) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
        } else {
          process.kill(-pid, 'SIGTERM')
        }
      } catch { /* schon tot ist auch gestoppt */ }
    }
    this.sende('log', { zeile: 'Hart gestoppt. Kein Push, kein Pull Request - der Branch bleibt lokal liegen.' })
    return { modus }
  }
}

// --- Wer laeuft hier schon? -----------------------------------------------
//
// Die Datei liegt in .agents/, wird also von .gitignore erfasst und landet
// nicht im Repository.
const MERKERDATEI = 'cockpit-lauf.json'

function merkerPfad (projekt) {
  return path.join(projekt, '.agents', MERKERDATEI)
}

function merkerSchreiben (projekt, pid, runden) {
  try {
    fs.mkdirSync(path.join(projekt, '.agents'), { recursive: true })
    fs.writeFileSync(merkerPfad(projekt),
      JSON.stringify({ pid, runden, seit: new Date().toISOString() }, null, 2), 'utf8')
  } catch { /* ein fehlender Merker darf keinen Lauf verhindern */ }
}

function merkerLoeschen (projekt) {
  try { fs.unlinkSync(merkerPfad(projekt)) } catch { /* schon weg */ }
}

/**
 * Die PID eines fremden, noch laufenden Prozesses in diesem Projekt, oder null.
 *
 * Ein Merker ohne lebenden Prozess ist eine Leiche -- etwa nach einem
 * Stromausfall. Der darf den naechsten Start nicht blockieren, also wird er
 * weggeraeumt statt gemeldet.
 */
function laufendeFremdePid (projekt) {
  let merker
  try { merker = JSON.parse(fs.readFileSync(merkerPfad(projekt), 'utf8')) } catch { return null }
  const pid = Number(merker && merker.pid)
  if (!Number.isInteger(pid) || pid <= 0) { merkerLoeschen(projekt); return null }
  if (pid === process.pid) return null
  try {
    // Signal 0 toetet nicht, es fragt nur, ob der Prozess existiert.
    process.kill(pid, 0)
    return pid
  } catch {
    merkerLoeschen(projekt)
    return null
  }
}

/**
 * Die PID aus loop.sh' eigener Sperre, oder null.
 *
 * Der Merker oben schreibt das Cockpit; diese Datei schreibt loop.sh selbst,
 * auch wenn es aus einem Terminal gestartet wurde. Fuer das Wiederanhaengen
 * zaehlt beides -- der haeufigste Fall ist ja gerade der Lauf, den das Cockpit
 * nicht gestartet hat.
 */
function loopLaeuftPid (projekt) {
  let roh
  try { roh = fs.readFileSync(path.join(projekt, '.agents', 'loop-laeuft.pid'), 'utf8') } catch { return null }
  const pid = Number(String(roh).trim())
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null
  try { process.kill(pid, 0); return pid } catch { return null }
}

/** Die hoechste Rundennummer, zu der ein Ereignisstrom auf der Platte liegt. */
function neuesteRunde (projekt) {
  let dateien
  try { dateien = fs.readdirSync(path.join(projekt, '.agents')) } catch { return 0 }
  let hoechste = 0
  for (const d of dateien) {
    const m = /^round-(\d+)\.ndjson$/.exec(d)
    if (m) hoechste = Math.max(hoechste, Number(m[1]))
  }
  return hoechste
}

function klasseVon (name, ein) {
  if (name === 'Bash' || name === 'PowerShell') return 'bash'
  if (['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(name)) return 'schreibt'
  if (name === 'Agent') return 'delegiert'
  return 'liest'
}

module.exports = { Lauf, ROLLEN }
