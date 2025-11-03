// server.js
// ---- rrweb → Google Drive uploader (Express) ----

import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import { Readable } from "stream";

// ---------- ENV ----------
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;

// Origines autorisées, séparées par virgule
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const REPLAY_SECRET = process.env.REPLAY_SECRET || "";
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "";
const GOOGLE_SERVICE_JSON = process.env.GOOGLE_SERVICE_JSON || "";

// ---------- Google Drive auth ----------
let GOOGLE_CREDS = null;
if (!GOOGLE_SERVICE_JSON) {
  console.warn("⚠️ GOOGLE_SERVICE_JSON absent : l’upload Drive échouera.");
} else {
  try {
    GOOGLE_CREDS = JSON.parse(GOOGLE_SERVICE_JSON);
    // IMPORTANT : corriger les \n si collé en 1 ligne dans les variables d'env
    if (typeof GOOGLE_CREDS.private_key === "string") {
      GOOGLE_CREDS.private_key = GOOGLE_CREDS.private_key.replace(/\\n/g, "\n");
    }
  } catch (e) {
    console.error("❌ GOOGLE_SERVICE_JSON invalide :", e);
  }
}

const auth =
  GOOGLE_CREDS &&
  new google.auth.GoogleAuth({
    credentials: GOOGLE_CREDS,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });

const drive = auth ? google.drive({ version: "v3", auth }) : null;

// ---------- App ----------
const app = express();

// CORS souple avec reflet d'origine + préflight
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGIN.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");

    // Refléter les headers demandés par le préflight si présents
    const reqHeaders = req.headers["access-control-request-headers"];
    res.setHeader(
      "Access-Control-Allow-Headers",
      reqHeaders || "Content-Type, X-REPLAY-SECRET, Authorization, X-Requested-With"
    );
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
    res.setHeader("Access-Control-Expose-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(bodyParser.json({ limit: "50mb" }));

// Vérification du secret envoyé par le client
function checkSecret(req, res, next) {
  const incoming = req.headers["x-replay-secret"];
  if (!REPLAY_SECRET || incoming !== REPLAY_SECRET) {
    return res.status(401).send("unauthorized");
  }
  next();
}

// Mémoire des sessions (simple Map ; pour la prod, préférer Redis/S3, etc.)
const sessions = new Map();

// ---------- Routes ----------
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Le client “annonce” la session (facultatif mais propre)
app.post("/replay/start", checkSecret, (req, res) => {
  try {
    const { sessionId, meta } = req.body || {};
    if (!sessionId) return res.status(400).send("missing sessionId");
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { events: [], meta: meta || {}, startedAt: Date.now() });
    }
    return res.status(200).send("ok");
  } catch (e) {
    console.error("start error", e);
    return res.status(500).send("start error");
  }
});

app.post("/replay/chunk", checkSecret, (req, res) => {
  try {
    const { sessionId, events } = req.body || {};
    if (!sessionId || !Array.isArray(events)) {
      return res.status(400).send("missing sessionId or events");
    }
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { events: [], startedAt: Date.now() });
    }
    const s = sessions.get(sessionId);
    s.events.push(...events);
    s.lastChunkAt = Date.now();
    return res.status(200).send("ok");
  } catch (e) {
    console.error("chunk error", e);
    return res.status(500).send("chunk error");
  }
});

app.post("/replay/finish", checkSecret, async (req, res) => {
  try {
    const { sessionId, meta } = req.body || {};
    if (!sessionId) return res.status(400).send("missing sessionId");

    const s = sessions.get(sessionId) || { events: [], meta: {} };
    // Fusion des meta envoyées au start/finish
    const combinedMeta = { ...(s.meta || {}), ...(meta || {}) };

    // Nom de fichier lisible
    const ts = new Date();
    const iso = ts.toISOString().replace(/[:]/g, "-");
    const name = `session-${sessionId}-${iso}.json`;

    if (!drive || !DRIVE_FOLDER_ID) {
      console.error("Drive non configuré : pas d'upload");
      sessions.delete(sessionId);
      return res.status(500).send("drive not configured");
    }

    const data = {
      sessionId,
      createdAt: ts.toISOString(),
      meta: combinedMeta,
      events: s.events || [],
      counts: { events: (s.events && s.events.length) || 0 },
    };

    // ✅ envoyer un flux lisible (stream) au SDK Google pour éviter "part.body.pipe is not a function"
    const json = JSON.stringify(data, null, 2);
    const media = {
      mimeType: "application/json",
      body: Readable.from([json]),
    };

    const fileMetadata = {
      name,
      parents: [DRIVE_FOLDER_ID],
    };

    const result = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: "id, name",
      uploadType: "multipart",
    });

    // nettoyage mémoire
    sessions.delete(sessionId);

    return res.status(200).json({
      status: "uploaded",
      fileId: result.data.id,
      fileName: result.data.name,
      events: data.counts.events,
    });
  } catch (e) {
    console.error("finish error", e?.response?.data || e);
    return res.status(500).send("upload error");
  }
});

// ---------- Lancement ----------
app.listen(PORT, () => {
  console.log(`▶ rrweb-uploader listening on :${PORT}`);
  if (ALLOWED_ORIGIN.length) {
    console.log("   Allowed origins:", ALLOWED_ORIGIN.join(", "));
  } else {
    console.log("   ⚠️ No ALLOWED_ORIGIN configured");
  }
});
