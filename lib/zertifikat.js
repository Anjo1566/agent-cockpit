'use strict'

// Erzeugt ein selbstsigniertes Zertifikat fuer den lokalen Betrieb.
//
// Warum ueberhaupt? Chrome kann so eingestellt sein, dass es jede http-Adresse
// auf https hochstuft -- auch localhost. Der Browser schickt dann einen
// TLS-Handshake an einen HTTP-Port, und der Nutzer sieht nur
// ERR_SSL_PROTOCOL_ERROR, ohne Hinweis, woran es liegt. Statt zu verlangen,
// dass er dafuer eine Sicherheitseinstellung im Browser aufweicht, spricht das
// Cockpit eben beides.
//
// Das Zertifikat ist selbstsigniert. Beim ersten Aufruf zeigt Chrome deshalb
// eine Warnung, die einmal weggeklickt werden muss. Es taugt fuer nichts
// ausser 127.0.0.1, ::1 und localhost -- und das ist genau die Absicht.
//
// Ohne openssl gibt es kein Zertifikat und das Cockpit laeuft nur ueber HTTP.
// Das ist kein Fehler, nur weniger bequem.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ORDNER = path.join(__dirname, '..', '.zertifikat')
const SCHLUESSEL = path.join(ORDNER, 'schluessel.pem')
const ZERT = path.join(ORDNER, 'zertifikat.pem')

// Ein Jahr. Laeuft es ab, wird beim naechsten Start ein neues erzeugt.
const TAGE = 365

function opensslFinden () {
  if (process.env.COCKPIT_OPENSSL) return process.env.COCKPIT_OPENSSL
  const kandidaten = [
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
    '/usr/bin/openssl'
  ]
  for (const k of kandidaten) if (fs.existsSync(k)) return k
  try {
    const befehl = process.platform === 'win32' ? 'where' : 'which'
    const gefunden = execFileSync(befehl, ['openssl'], { encoding: 'utf8' }).split('\n')[0].trim()
    if (gefunden && fs.existsSync(gefunden)) return gefunden
  } catch { /* kein openssl */ }
  return null
}

function nochGueltig () {
  if (!fs.existsSync(ZERT) || !fs.existsSync(SCHLUESSEL)) return false
  try {
    const { X509Certificate } = require('node:crypto')
    const x = new X509Certificate(fs.readFileSync(ZERT))
    // Mit einem Monat Luft, damit es nicht mitten im Betrieb ablaeuft.
    return new Date(x.validTo).getTime() - Date.now() > 30 * 24 * 3600 * 1000
  } catch {
    return false
  }
}

/**
 * Liefert { key, cert } oder null, wenn kein Zertifikat erzeugt werden konnte.
 * Erzeugt nur, wenn noetig -- der Aufruf ist billig, wenn schon eines da ist.
 */
function besorgen () {
  if (nochGueltig()) {
    return {
      key: fs.readFileSync(SCHLUESSEL),
      cert: fs.readFileSync(ZERT)
    }
  }

  const openssl = opensslFinden()
  if (!openssl) return null

  fs.mkdirSync(ORDNER, { recursive: true })

  // subjectAltName ist Pflicht: Chrome ignoriert den Common Name seit Jahren.
  const konfig = path.join(ORDNER, 'openssl.cnf')
  fs.writeFileSync(konfig, [
    '[req]',
    'distinguished_name = dn',
    'x509_extensions = v3',
    'prompt = no',
    '',
    '[dn]',
    'CN = localhost',
    'O = Reissbrett Cockpit',
    '',
    '[v3]',
    'basicConstraints = critical, CA:TRUE',
    'keyUsage = critical, digitalSignature, keyCertSign',
    'extendedKeyUsage = serverAuth',
    'subjectAltName = @namen',
    '',
    '[namen]',
    'DNS.1 = localhost',
    'IP.1 = 127.0.0.1',
    'IP.2 = ::1',
    ''
  ].join('\n'), 'utf8')

  try {
    execFileSync(openssl, [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', SCHLUESSEL,
      '-out', ZERT,
      '-days', String(TAGE),
      '-config', konfig
    ], { stdio: 'ignore' })
  } catch {
    return null
  } finally {
    try { fs.unlinkSync(konfig) } catch { /* egal */ }
  }

  if (!fs.existsSync(ZERT) || !fs.existsSync(SCHLUESSEL)) return null
  return { key: fs.readFileSync(SCHLUESSEL), cert: fs.readFileSync(ZERT) }
}

module.exports = { besorgen, ORDNER }
