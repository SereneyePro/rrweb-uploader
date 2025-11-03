// server.js (ESM)

// Dépendances
import express from 'express';
import bodyParser from 'body-parser';
import { google } from 'googleapis';

// ---------- Config & env ----------
const PORT = process.env.PORT || 10000;
const REPLAY_SECRET = process.env.REPLAY_SECRET || '';
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://my-sereneye.com';

// Auth Google (clé collée dans GOOGLE_SERVICE_JSON)
let GOOGLE_CREDS = null;
try {
  GOOGLE_CREDS = JSON.parse(process.env.GOOGLE_SERVICE_JSON || '{}');
} catch (e) {
  console.error('Invalid GOOGLE_SERVICE_JSON:', e);
}

const app = express();

// ---------- CORS strict (sans la lib "cors") ----------
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-REPLAY-SECRET');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ---------- Body parsers ----------
app.use(bodyParser.json({ limit: '10mb' }));    // rrweb chunks JSON
app.use(bodyParser.urlencoded({ extended: false }));

// ---------- Sessions en mémoire ----------
/**
 * Map<string, { events: any[], lastTs: number }>
 */
const sessions = new Map();

// ---------- Helpers Google Drive ----------
function getDriveClient() {
  if (!GOOGLE_CREDS || !GOOGLE_CREDS.client_email) {
    throw new Error('Missing/invalid GOOGLE_SERVICE_JSON');
  }
  const auth = new google.auth.GoogleAuth({
    credentials: GOOGLE_CREDS,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function uploadJsonToDrive(name, jsonStr) {
  const drive = getDriveClient();
  const res = await drive.files.create({
    requestBody: {
      name,
      parents: DRIVE_FOLDER_ID ? [DRIVE_FOLDER_ID] : undefined,
    },
    media: {
      mimeType: 'application/json',
      body: Buffer.from(jsonStr, 'utf8'),
    },
    fields: 'id,name',
  });
  return res.data;
}

// ---------- Middlewares ----------
function checkSecret(req, res, next) {
  const got = req.header('X-REPLAY-SECRET') || '';
  if (!REPLAY_SECRET || got !== REPLAY_SECRET) {
    return res.status(401).send('unauthorized');
  }
  next();
}

// ---------- Routes ----------
app.get('/', (req, res) => {
  res.type('text/plain').send('rrweb-uploader live');
});

// Reçoit des morceaux d’événements rrweb
app.post('/replay/chunk', checkSecret, (req, res) => {
  try {
    const { sessionId, events = [] } = req.body || {};
    if (!sessionId) return res.status(400).send('missing sessionId');
    if (!Array.isArray(events)) return res.status(400).send('events must be array');

    let s = sessions.get(sessionId);
    if (!s) {
      s = { events: [], lastTs: Date.now() };
      sessions.set(sessionId, s);
    }
    s.events.push(...events);
    s.lastTs = Date.now();

    res.status(200).send('ok');
  } catch (e) {
    console.error('chunk error', e);
    res.status(500).send('error');
  }
});

// Fin de session : assemble + envoie vers Drive
app.post('/replay/finish', checkSecret, async (req, res) => {
  try {
    const { sessionId, meta = {} } = req.body || {};
    if (!sessionId) return res.status(400).send('missing sessionId');

    const s = sessions.get(sessionId);
    if (!s || !s.events) return res.status(400).send('unknown session');

    const content = {
      sessionId,
      createdAt: new Date().toISOString(),
      meta,
      events: s.events,
    };

    const jsonStr = JSON.stringify(content);
    const fileName = `rrweb-${sessionId}.json`;

    const file = await uploadJsonToDrive(fileName, jsonStr);

    sessions.delete(sessionId);
    res.status(200).json({ success: true, fileId: file.id, name: file.name });
  } catch (e) {
    console.error('finish error', e);
    res.status(500).send('upload error');
  }
});

// ---------- Startup ----------
app.listen(PORT, () => {
  console.log(`✅ Uploader running on :${PORT}`);
});
