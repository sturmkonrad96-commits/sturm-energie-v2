/* ══════════════════════════════════════════════════════════════
   Sturm Energie · Server-Funktionen (alles in einer Datei)
   Ohne externe Pakete – läuft auf Vercel ohne Installation.

   Aufruf aus der Website:  /api/index?fn=submit
   Selbsttest im Browser:   /api/index?fn=status

   Benötigte Vercel-Umgebungsvariablen:
     SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_PASSWORD, AUTH_SECRET
   Optional (E-Mail-Benachrichtigung):
     RESEND_API_KEY, NOTIFY_EMAIL, NOTIFY_FROM
   ══════════════════════════════════════════════════════════════ */

/* Sturm Energie · gemeinsame Helfer für alle Server-Funktionen
   Bewusst ohne externe Pakete: läuft auf Vercel ohne package.json und ohne Build. */
const crypto = require('crypto');

// Toleriert versehentlich mitkopierte Endungen wie /rest/v1/ oder /storage/v1/
const SB_URL = String(process.env.SUPABASE_URL || '')
  .trim()
  .replace(/\/+$/, '')
  .replace(/\/(rest|storage|auth|realtime)\/v\d+$/i, '')
  .replace(/\/+$/, '');
const SB_KEY = String(process.env.SUPABASE_SERVICE_KEY || '');
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const AUTH_SECRET = String(process.env.AUTH_SECRET || '');
const BUCKET = String(process.env.SUPABASE_BUCKET || 'jahresabrechnungen');
const TABLE = 'eingaenge';

/* ---------- Antworten ---------- */
function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function methodGuard(req, res, allowed) {
  if (allowed.indexOf(req.method) === -1) {
    res.setHeader('Allow', allowed.join(', '));
    json(res, 405, { ok: false, error: 'Methode nicht erlaubt' });
    return false;
  }
  return true;
}

function missingConfig() {
  const missing = [];
  if (!SB_URL) missing.push('SUPABASE_URL');
  if (!SB_KEY) missing.push('SUPABASE_SERVICE_KEY');
  return missing;
}

/* ---------- Body lesen ---------- */
async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) throw new Error('Anfrage zu groß');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return {}; }
}

/* ---------- Supabase: Datenbank (REST) ---------- */
async function sbRest(path, opts) {
  opts = opts || {};
  const r = await fetch(SB_URL + '/rest/v1' + path, {
    method: opts.method || 'GET',
    headers: Object.assign({
      apikey: SB_KEY,
      Authorization: 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json'
    }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await r.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
  if (!r.ok) {
    const msg = (data && (data.message || data.error || data.hint)) || ('HTTP ' + r.status);
    const err = new Error(msg);
    err.status = r.status;
    err.detail = data;
    throw err;
  }
  return data;
}

/* ---------- Supabase: Dateispeicher ---------- */
// Signierte Upload-Adresse: Datei geht direkt vom Browser in den Speicher (keine Größenlimits der Funktion)
async function createSignedUpload(objectPath) {
  const r = await fetch(SB_URL + '/storage/v1/object/upload/sign/' + BUCKET + '/' + encodeURI(objectPath), {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
    body: '{}'
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  if (!r.ok) {
    const err = new Error((data && (data.message || data.error)) || ('HTTP ' + r.status));
    err.status = r.status;
    throw err;
  }
  // data.url sieht so aus: /object/upload/sign/<bucket>/<pfad>?token=...
  const rel = (data && data.url) || '';
  const tokenMatch = /token=([^&]+)/.exec(rel);
  return {
    uploadUrl: SB_URL + '/storage/v1' + rel,
    token: (data && data.token) || (tokenMatch ? decodeURIComponent(tokenMatch[1]) : ''),
    path: objectPath
  };
}

// Serverseitiger Upload (Rückfalloption für kleine Dateien)
async function putObject(objectPath, buffer, contentType) {
  const r = await fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + encodeURI(objectPath), {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + SB_KEY,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'true'
    },
    body: buffer
  });
  if (!r.ok) {
    const t = await r.text();
    const err = new Error('Upload fehlgeschlagen: ' + t.slice(0, 200));
    err.status = r.status;
    throw err;
  }
  return true;
}

// Signierte Download-Adresse (zeitlich begrenzt)
async function signDownload(objectPath, seconds) {
  const r = await fetch(SB_URL + '/storage/v1/object/sign/' + BUCKET + '/' + encodeURI(objectPath), {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: seconds || 3600 })
  });
  if (!r.ok) return null;
  const data = await r.json().catch(function () { return null; });
  const rel = data && (data.signedURL || data.signedUrl);
  return rel ? SB_URL + '/storage/v1' + rel : null;
}

async function getObject(objectPath) {
  return fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + encodeURI(objectPath), {
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY }
  });
}

async function deleteObjects(paths) {
  if (!paths || !paths.length) return;
  await fetch(SB_URL + '/storage/v1/object/' + BUCKET, {
    method: 'DELETE',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: paths })
  }).catch(function () {});
}

/* ---------- Anmeldung / Token ---------- */
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

function passwordOk(candidate) {
  if (!ADMIN_PASSWORD) return false;
  const a = sha256(candidate || '');
  const b = sha256(ADMIN_PASSWORD);
  return crypto.timingSafeEqual(a, b);
}

function signToken(hours) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + (hours || 12) * 3600 * 1000 }))
    .toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (!token || !AUTH_SECRET) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const expect = crypto.createHmac('sha256', AUTH_SECRET).update(parts[0]).digest('base64url');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expect);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch (e) { return false; }
}

function requireAdmin(req, res) {
  const h = String(req.headers.authorization || '');
  let token = h.indexOf('Bearer ') === 0 ? h.slice(7) : '';
  if (!token && req.query && req.query.token) token = String(req.query.token);
  if (!verifyToken(token)) {
    json(res, 401, { ok: false, error: 'Nicht angemeldet' });
    return false;
  }
  return true;
}

/* ---------- Hilfsfunktionen ---------- */
function clean(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\u0000/g, '').trim();
  if (!s) return null;
  return s.slice(0, max || 500);
}

function validEmail(s) { return !!s && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s); }

function ipHash(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unbekannt';
  return crypto.createHash('sha256').update(ip + '|' + (AUTH_SECRET || 'salt')).digest('hex').slice(0, 32);
}

function safeName(name) {
  return String(name || 'datei')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(-80) || 'datei';
}

/* ---------- Optionale E-Mail-Benachrichtigung (nur wenn RESEND_API_KEY gesetzt) ---------- */
async function notify(subject, lines) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  const from = process.env.NOTIFY_FROM;
  if (!key || !to || !from) return false;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: from,
        to: [to],
        subject: subject,
        text: lines.join('\n')
      })
    });
    return true;
  } catch (e) { return false; }
}

/* POST /api/submit
   Speichert Anfragen, Fragen und Feedback in der Datenbank.
   Öffentlich erreichbar (das ist gewollt) – geschützt durch Feldprüfungen,
   Honeypot und eine einfache Sperre gegen Massen-Einsendungen. */

async function submitHandler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const missing = missingConfig();
  if (missing.length) {
    return json(res, 500, {
      ok: false,
      error: 'Server ist noch nicht fertig eingerichtet.',
      hinweis: 'Fehlende Vercel-Umgebungsvariablen: ' + missing.join(', ')
    });
  }

  let body;
  try { body = await readBody(req); } catch (e) {
    return json(res, 413, { ok: false, error: 'Anfrage zu groß' });
  }

  // Honeypot: unsichtbares Feld muss leer sein (Bots füllen es aus)
  if (clean(body.hp, 50)) return json(res, 200, { ok: true });

  const typ = String(body.typ || '').toLowerCase();
  if (['anfrage', 'frage', 'feedback'].indexOf(typ) === -1) {
    return json(res, 400, { ok: false, error: 'Unbekannter Nachrichtentyp' });
  }

  const row = {
    typ: typ,
    name: clean(body.name, 120),
    email: clean(body.email, 160),
    telefon: clean(body.telefon, 60),
    energieart: clean(body.energieart, 40),
    tarifart: clean(body.tarifart, 40),
    kategorie: clean(body.kategorie, 60),
    nachricht: clean(body.nachricht, 5000),
    bewertung: null,
    veroeffentlichung_ok: body.veroeffentlichung_ok === true,
    dateien: [],
    quelle: clean(body.quelle, 60) || 'website',
    ip_hash: ipHash(req)
  };

  // Typ-spezifische Pflichtfelder
  if (typ === 'anfrage') {
    if (!row.name) return json(res, 400, { ok: false, error: 'Bitte geben Sie Ihren Namen an.' });
    if (!validEmail(row.email)) return json(res, 400, { ok: false, error: 'Bitte geben Sie eine gültige E-Mail-Adresse an.' });
  }
  if (typ === 'frage') {
    if (!row.name) return json(res, 400, { ok: false, error: 'Bitte geben Sie Ihren Namen an.' });
    if (!validEmail(row.email)) return json(res, 400, { ok: false, error: 'Bitte geben Sie eine gültige E-Mail-Adresse an.' });
    if (!row.nachricht) return json(res, 400, { ok: false, error: 'Bitte schreiben Sie eine Nachricht.' });
  }
  if (typ === 'feedback') {
    const b = parseInt(body.bewertung, 10);
    if (!(b >= 1 && b <= 5)) return json(res, 400, { ok: false, error: 'Bitte wählen Sie 1 bis 5 Sterne.' });
    row.bewertung = b;
    if (!row.nachricht) return json(res, 400, { ok: false, error: 'Bitte schreiben Sie ein kurzes Feedback.' });
  }

  // Dateiliste übernehmen (die Dateien selbst liegen bereits im Speicher)
  if (Array.isArray(body.dateien)) {
    row.dateien = body.dateien.slice(0, 10).map(function (f) {
      return {
        pfad: clean(f && f.pfad, 300),
        name: clean(f && f.name, 200),
        groesse: Number(f && f.groesse) || 0,
        typ: clean(f && f.typ, 100)
      };
    }).filter(function (f) { return f.pfad; });
  }

  // Einfache Sperre gegen Massen-Einsendungen: max. 6 Einträge pro Absender in 10 Minuten
  try {
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const recent = await sbRest(
      '/' + TABLE + '?select=id&ip_hash=eq.' + encodeURIComponent(row.ip_hash) +
      '&created_at=gte.' + encodeURIComponent(since) + '&limit=7'
    );
    if (Array.isArray(recent) && recent.length >= 6) {
      return json(res, 429, { ok: false, error: 'Zu viele Einsendungen in kurzer Zeit. Bitte versuchen Sie es später erneut.' });
    }
  } catch (e) { /* Prüfung ist optional – im Fehlerfall trotzdem weiter */ }

  try {
    const saved = await sbRest('/' + TABLE, {
      method: 'POST',
      body: [row],
      headers: { Prefer: 'return=representation' }
    });
    const id = Array.isArray(saved) && saved[0] ? saved[0].id : null;

    // Optionale E-Mail-Benachrichtigung
    const titel = typ === 'anfrage' ? 'Neue Angebots-Anfrage'
      : (typ === 'feedback' ? 'Neues Feedback' : 'Neue Frage');
    await notify('Sturm Energie · ' + titel, [
      titel + ' über die Website:',
      '',
      'Name: ' + (row.name || '–'),
      'E-Mail: ' + (row.email || '–'),
      'Telefon: ' + (row.telefon || '–'),
      row.energieart ? 'Energieart: ' + row.energieart : '',
      row.tarifart ? 'Tarifart: ' + row.tarifart : '',
      row.kategorie ? 'Kategorie: ' + row.kategorie : '',
      row.bewertung ? 'Bewertung: ' + row.bewertung + '/5' : '',
      row.dateien.length ? 'Dateien: ' + row.dateien.length : '',
      '',
      row.nachricht || '',
      '',
      'Im Admin-Bereich ansehen: https://www.sturm-energie.de/admin.html'
    ].filter(Boolean));

    return json(res, 200, { ok: true, id: id });
  } catch (e) {
    return json(res, 500, {
      ok: false,
      error: 'Speichern fehlgeschlagen.',
      hinweis: e.message || 'Unbekannter Fehler'
    });
  }
};

/* POST /api/upload-url
   Liefert eine signierte Upload-Adresse. Die Datei wandert damit direkt
   vom Browser des Kunden in den Speicher – ohne Größenbegrenzung der Funktion.
   Body: { name, groesse, typ } */

const ERLAUBT = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
const MAX = 10 * 1024 * 1024; // 10 MB, wie auf der Website angegeben

async function uploadUrlHandler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const missing = missingConfig();
  if (missing.length) {
    return json(res, 500, { ok: false, error: 'Server noch nicht eingerichtet', hinweis: 'Fehlt: ' + missing.join(', ') });
  }

  let body;
  try { body = await readBody(req); } catch (e) {
    return json(res, 413, { ok: false, error: 'Anfrage zu groß' });
  }

  const name = safeName(body.name);
  const groesse = Number(body.groesse) || 0;
  const typ = String(body.typ || '').toLowerCase();
  const endung = (name.split('.').pop() || '').toLowerCase();

  if (groesse > MAX) {
    return json(res, 400, { ok: false, error: 'Datei zu groß (maximal 10 MB).' });
  }
  if (['pdf', 'jpg', 'jpeg', 'png'].indexOf(endung) === -1 && ERLAUBT.indexOf(typ) === -1) {
    return json(res, 400, { ok: false, error: 'Nur PDF, JPG oder PNG sind erlaubt.' });
  }

  const d = new Date();
  const ordner = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  const zufall = Math.random().toString(36).slice(2, 10);
  const pfad = ordner + '/' + Date.now() + '-' + zufall + '-' + name;

  try {
    const signed = await createSignedUpload(pfad);
    return json(res, 200, { ok: true, uploadUrl: signed.uploadUrl, token: signed.token, pfad: pfad });
  } catch (e) {
    return json(res, 500, {
      ok: false,
      error: 'Upload-Adresse konnte nicht erstellt werden.',
      hinweis: e.message || 'Unbekannter Fehler'
    });
  }
};

/* POST /api/upload  (Rückfalloption)
   Nimmt kleine Dateien (bis ca. 3 MB) als Base64 an und legt sie serverseitig ab.
   Wird nur benutzt, wenn der direkte Upload über die signierte Adresse scheitert.
   Body: { name, typ, daten } – daten = Base64 ohne Präfix */

const MAX_ROH = 3 * 1024 * 1024;

async function uploadHandler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const missing = missingConfig();
  if (missing.length) {
    return json(res, 500, { ok: false, error: 'Server noch nicht eingerichtet', hinweis: 'Fehlt: ' + missing.join(', ') });
  }

  let body;
  try { body = await readBody(req); } catch (e) {
    return json(res, 413, { ok: false, error: 'Datei zu groß für diesen Weg. Bitte per WhatsApp senden.' });
  }

  const name = safeName(body.name);
  const endung = (name.split('.').pop() || '').toLowerCase();
  if (['pdf', 'jpg', 'jpeg', 'png'].indexOf(endung) === -1) {
    return json(res, 400, { ok: false, error: 'Nur PDF, JPG oder PNG sind erlaubt.' });
  }

  const base64 = String(body.daten || '').replace(/^data:[^;]+;base64,/, '');
  if (!base64) return json(res, 400, { ok: false, error: 'Keine Dateidaten empfangen.' });

  let buf;
  try { buf = Buffer.from(base64, 'base64'); } catch (e) {
    return json(res, 400, { ok: false, error: 'Dateidaten unlesbar.' });
  }
  if (!buf.length) return json(res, 400, { ok: false, error: 'Datei ist leer.' });
  if (buf.length > MAX_ROH) {
    return json(res, 413, { ok: false, error: 'Datei zu groß für diesen Weg (max. 3 MB). Bitte per WhatsApp senden.' });
  }

  const d = new Date();
  const ordner = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  const zufall = Math.random().toString(36).slice(2, 10);
  const pfad = ordner + '/' + Date.now() + '-' + zufall + '-' + name;
  const contentType = endung === 'pdf' ? 'application/pdf'
    : (endung === 'png' ? 'image/png' : 'image/jpeg');

  try {
    await putObject(pfad, buf, contentType);
    return json(res, 200, { ok: true, pfad: pfad });
  } catch (e) {
    return json(res, 500, { ok: false, error: 'Upload fehlgeschlagen.', hinweis: e.message || '' });
  }
};

/* POST /api/login
   Prüft das Admin-Passwort und gibt ein zeitlich begrenztes Zugangs-Token zurück.
   Body: { passwort } */

async function loginHandler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  if (!ADMIN_PASSWORD || !AUTH_SECRET) {
    return json(res, 500, {
      ok: false,
      error: 'Admin-Bereich ist noch nicht eingerichtet.',
      hinweis: 'Bitte ADMIN_PASSWORD und AUTH_SECRET in Vercel hinterlegen.'
    });
  }

  let body;
  try { body = await readBody(req); } catch (e) { body = {}; }
  const passwort = String(body.passwort || body.password || '');

  // Kleine Verzögerung erschwert automatisiertes Durchprobieren
  await new Promise(function (r) { setTimeout(r, 500); });

  const kennung = ipHash(req);

  // Sperre nach 8 Fehlversuchen in 15 Minuten (bei Störung absichtlich durchlassen,
  // damit Sie sich nie selbst aussperren)
  try {
    const seit = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const fehl = await sbRest('/login_versuche?select=id&ip_hash=eq.' +
      encodeURIComponent(kennung) + '&created_at=gte.' + encodeURIComponent(seit) + '&limit=9');
    if (Array.isArray(fehl) && fehl.length >= 8) {
      return json(res, 429, {
        ok: false,
        error: 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.'
      });
    }
  } catch (e) { /* Prüfung optional */ }

  if (!passwort || !passwordOk(passwort)) {
    try {
      await sbRest('/login_versuche', { method: 'POST', body: [{ ip_hash: kennung }] });
    } catch (e) { /* Protokollierung optional */ }
    return json(res, 401, { ok: false, error: 'Passwort falsch.' });
  }

  return json(res, 200, { ok: true, token: signToken(12), gueltig_stunden: 12 });
};

/* GET /api/messages
   Nur mit Admin-Token. Gibt alle Eingänge zurück – inklusive zeitlich
   begrenzter Download-Adressen für hochgeladene Dateien.
   Parameter: ?typ=anfrage|frage|feedback  &ungelesen=1  &archiv=1  &limit=200 */

async function messagesHandler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  if (!requireAdmin(req, res)) return;

  const missing = missingConfig();
  if (missing.length) {
    return json(res, 500, { ok: false, error: 'Server noch nicht eingerichtet', hinweis: 'Fehlt: ' + missing.join(', ') });
  }

  const q = req.query || {};
  const limit = Math.min(parseInt(q.limit, 10) || 200, 500);

  let filter = '/' + TABLE + '?select=*&order=created_at.desc&limit=' + limit;
  if (['anfrage', 'frage', 'feedback'].indexOf(String(q.typ)) !== -1) {
    filter += '&typ=eq.' + q.typ;
  }
  if (String(q.ungelesen) === '1') filter += '&gelesen=is.false';
  filter += String(q.archiv) === '1' ? '&archiviert=is.true' : '&archiviert=is.false';

  try {
    const rows = await sbRest(filter);

    // Download-Adressen erzeugen (1 Stunde gültig)
    for (let i = 0; i < rows.length; i++) {
      const dateien = Array.isArray(rows[i].dateien) ? rows[i].dateien : [];
      for (let j = 0; j < dateien.length; j++) {
        if (!dateien[j] || !dateien[j].pfad) continue;
        dateien[j].url = await signDownload(dateien[j].pfad, 3600);
      }
      rows[i].dateien = dateien;
    }

    // Zähler für die Reiter im Admin-Bereich
    async function zaehle(extra) {
      try {
        const r = await sbRest('/' + TABLE + '?select=id&archiviert=is.false' + extra + '&limit=1000');
        return Array.isArray(r) ? r.length : 0;
      } catch (e) { return 0; }
    }

    const zaehler = {
      alle: await zaehle(''),
      anfragen: await zaehle('&typ=eq.anfrage'),
      fragen: await zaehle('&typ=eq.frage'),
      feedback: await zaehle('&typ=eq.feedback'),
      ungelesen: await zaehle('&gelesen=is.false')
    };

    return json(res, 200, { ok: true, eintraege: rows, zaehler: zaehler });
  } catch (e) {
    return json(res, 500, {
      ok: false,
      error: 'Abruf fehlgeschlagen.',
      hinweis: e.message || 'Prüfen Sie, ob die Tabelle "eingaenge" angelegt wurde.'
    });
  }
};

/* POST /api/update
   Nur mit Admin-Token. Ändert oder löscht einen Eintrag.
   Body: { id, gelesen?, archiviert?, freigegeben?, notiz?, loeschen? } */

async function updateHandler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!requireAdmin(req, res)) return;

  let body;
  try { body = await readBody(req); } catch (e) { body = {}; }
  const id = clean(body.id, 60);
  if (!id) return json(res, 400, { ok: false, error: 'Kein Eintrag angegeben.' });

  const where = '/' + TABLE + '?id=eq.' + encodeURIComponent(id);

  try {
    if (body.loeschen === true) {
      // Zugehörige Dateien mitlöschen
      const rows = await sbRest(where + '&select=dateien');
      const pfade = [];
      if (Array.isArray(rows) && rows[0] && Array.isArray(rows[0].dateien)) {
        rows[0].dateien.forEach(function (f) { if (f && f.pfad) pfade.push(f.pfad); });
      }
      await deleteObjects(pfade);
      await sbRest(where, { method: 'DELETE' });
      return json(res, 200, { ok: true, geloescht: true });
    }

    const patch = {};
    if (typeof body.gelesen === 'boolean') patch.gelesen = body.gelesen;
    if (typeof body.archiviert === 'boolean') patch.archiviert = body.archiviert;
    if (typeof body.freigegeben === 'boolean') patch.freigegeben = body.freigegeben;
    if (body.notiz !== undefined) patch.notiz = clean(body.notiz, 2000);

    if (!Object.keys(patch).length) {
      return json(res, 400, { ok: false, error: 'Keine Änderung angegeben.' });
    }

    await sbRest(where, { method: 'PATCH', body: patch });
    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, 500, { ok: false, error: 'Änderung fehlgeschlagen.', hinweis: e.message || '' });
  }
};

/* GET /api/file?pfad=...&token=ADMIN_TOKEN
   Rückfalloption: liefert eine hochgeladene Datei direkt aus,
   falls die signierte Download-Adresse einmal nicht funktioniert. */

async function fileHandler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  if (!requireAdmin(req, res)) return;

  const pfad = String((req.query && req.query.pfad) || '');
  if (!pfad || pfad.indexOf('..') !== -1) {
    return json(res, 400, { ok: false, error: 'Ungültiger Pfad.' });
  }

  try {
    const r = await getObject(pfad);
    if (!r.ok) return json(res, 404, { ok: false, error: 'Datei nicht gefunden.' });

    const buf = Buffer.from(await r.arrayBuffer());
    const name = pfad.split('/').pop() || 'datei';
    res.statusCode = 200;
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name.replace(/"/g, '') + '"');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(buf);
  } catch (e) {
    return json(res, 500, { ok: false, error: 'Download fehlgeschlagen.', hinweis: e.message || '' });
  }
};

/* GET /api/status
   Selbsttest zur Fehlersuche. Gibt ausschließlich Ja/Nein-Werte zurück,
   niemals Passwörter oder Schlüssel. Aufrufbar unter:
   https://www.sturm-energie.de/api/status */

async function statusHandler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  const ergebnis = {
    ok: true,
    schritte: {
      'SUPABASE_URL gesetzt': !!SB_URL,
      'SUPABASE_SERVICE_KEY gesetzt': !!SB_KEY,
      'ADMIN_PASSWORD gesetzt': !!ADMIN_PASSWORD,
      'AUTH_SECRET gesetzt': !!AUTH_SECRET,
      'Datenbank erreichbar': false,
      'Tabelle "eingaenge" vorhanden': false,
      'Datei-Speicher vorhanden': false,
      'E-Mail-Benachrichtigung aktiv (optional)': !!(process.env.RESEND_API_KEY && process.env.NOTIFY_EMAIL && process.env.NOTIFY_FROM)
    },
    hinweise: []
  };

  if (SB_URL && SB_KEY) {
    try {
      await sbRest('/' + TABLE + '?select=id&limit=1');
      ergebnis.schritte['Datenbank erreichbar'] = true;
      ergebnis.schritte['Tabelle "eingaenge" vorhanden'] = true;
    } catch (e) {
      if (e.status && e.status !== 404) {
        ergebnis.schritte['Datenbank erreichbar'] = true;
        ergebnis.hinweise.push('Datenbank antwortet, aber die Tabelle fehlt oder ist gesperrt: ' + (e.message || ''));
      } else {
        ergebnis.hinweise.push('Datenbank nicht erreichbar: ' + (e.message || ''));
      }
    }

    try {
      const r = await fetch(SB_URL + '/storage/v1/bucket/' + BUCKET, {
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY }
      });
      ergebnis.schritte['Datei-Speicher vorhanden'] = r.ok;
      if (!r.ok) ergebnis.hinweise.push('Speicher-Ordner "' + BUCKET + '" nicht gefunden. Bitte in Supabase unter Storage anlegen (privat).');
    } catch (e) {
      ergebnis.hinweise.push('Speicher nicht erreichbar: ' + (e.message || ''));
    }
  } else {
    ergebnis.hinweise.push('Bitte zuerst die Umgebungsvariablen in Vercel hinterlegen und neu bereitstellen.');
  }

  const alleWichtigen = ['SUPABASE_URL gesetzt', 'SUPABASE_SERVICE_KEY gesetzt', 'ADMIN_PASSWORD gesetzt',
    'AUTH_SECRET gesetzt', 'Datenbank erreichbar', 'Tabelle "eingaenge" vorhanden', 'Datei-Speicher vorhanden'];
  ergebnis.bereit = alleWichtigen.every(function (k) { return ergebnis.schritte[k] === true; });

  return json(res, 200, ergebnis);
};

/* ══════════════ VERTEILER ══════════════
   Eine Datei bedient alle Endpunkte. Aufruf jeweils über
   /api/index?fn=NAME  (z. B. /api/index?fn=status) */
module.exports = async function handler(req, res) {
  const fn = String((req.query && req.query.fn) || '').toLowerCase();
  try {
    switch (fn) {
      case 'submit':     return await submitHandler(req, res);
      case 'upload-url': return await uploadUrlHandler(req, res);
      case 'upload':     return await uploadHandler(req, res);
      case 'login':      return await loginHandler(req, res);
      case 'messages':   return await messagesHandler(req, res);
      case 'update':     return await updateHandler(req, res);
      case 'file':       return await fileHandler(req, res);
      case 'status':     return await statusHandler(req, res);
      default:
        return json(res, 404, {
          ok: false,
          error: 'Unbekannter Endpunkt.',
          moeglich: ['submit', 'upload-url', 'upload', 'login', 'messages', 'update', 'file', 'status']
        });
    }
  } catch (e) {
    return json(res, 500, { ok: false, error: 'Unerwarteter Serverfehler.', hinweis: (e && e.message) || '' });
  }
};
