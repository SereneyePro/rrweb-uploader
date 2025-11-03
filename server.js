// server.js — rrweb → Google Drive (OAuth prioritaire, fallback Service Account)

import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import { Readable } from "stream";

// ────────── ENV ──────────
const PORT = Number(process.env.PORT || 10000);
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const REPLAY_SECRET = process.env.REPLAY_SECRET || "";
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "";

// OAuth vars (accepte GOOGLE_* ou OAUTH_*)
const OAUTH_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || process.env.OAUTH_CLIENT_ID || "";
const OAUTH_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET || process.env.OAUTH_CLIENT_SECRET || "";
const OAUTH_REFRESH_TOKEN = process.env.OAUTH_REFRESH_TOKEN || "";

// Service Account (fallback)
const GOOGLE_SERVICE_JSON = process.env.GOOGLE_SERVICE_JSON || "";

// ────────── AUTH GOOGLE (OAuth > Service Account) ──────────
let auth = null;

if (OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET && OAUTH_REFRESH_TOKEN) {
  // OAuth (propriété des fichiers: ton compte)
  const oAuth2 = new google.auth.OAuth2(
    OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET,
    // redirect non utilisé pendant le refresh, mais gardé pour clarté
    "https://developers.google.com/oauthplayground"
  );
  oAuth2.setCredentials({ refresh_token: OAUTH_REFRESH_TOKEN });
  auth = oAuth2;
  console.log("🔐 Using OAuth client (files owned by YOUR Google account)");
} else if (GOOGLE_SERVICE_JSON) {
  // Fallback Service Account (si configuré)
  try {
    const creds = JSON.parse(GOOGLE_SERVICE_JSON);
    if (typeof creds.private_key === "string") {
      // corrige les \n si collé en 1 ligne
      creds.private_key = creds.private_key.replace(/\\n/g, "\n");
    }
    auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    });
    console.log("🔐 Using Service Account credentials (check shared drive/quota)");
  } catch (e) {
    console.error("❌ Invalid GOOGLE_SERVICE_JSON:", e);
  }
} else {
  console.warn("⚠️ No Google credentials configured (OAuth or Service Account)");
}

const drive = auth ? google.drive({ version: "v3", auth }) : null;

// ────────── APP ──────────
const app = express();

// CORS souple + préflight
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGIN.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
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

// Secret requis sur toutes les routes rrweb
function checkSecret(req, res, next) {
  const incoming = req.headers["x-replay-secret"];
  if (!REPLAY_SECRET || incoming !== REPLAY_SECRET) {
    return res.status(401).send("unauthorized");
  }
  next();
}

// Mémoire des sessions (pour la prod: préférer Redis/S3/etc.)
const sessions = new Map();

// ────────── ROUTES ──────────
app.get("/health", (_req, res) => res.status(200).send("ok"));

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
    if (!drive || !DRIVE_FOLDER_ID) return res.status(500).send("drive not configured");

    const s = sessions.get(sessionId) || { events: [], meta: {} };
    const combinedMeta = { ...(s.meta || {}), ...(meta || {}) };

    const ts = new Date();
    const iso = ts.toISOString().replace(/[:]/g, "-");
    const name = `session-${sessionId}-${iso}.json`;

    const data = {
      sessionId,
      createdAt: ts.toISOString(),
      meta: combinedMeta,
      events: s.events || [],
      counts: { events: (s.events && s.events.length) || 0 },
    };

    // Upload JSON en stream (fiable)
    const json = JSON.stringify(data, null, 2);
    const media = { mimeType: "application/json", body: Readable.from([json]) };
    const requestBody = { name, parents: [DRIVE_FOLDER_ID] };

    const result = await drive.files.create({
      requestBody,
      media,
      fields: "id, name",
      uploadType: "multipart",
      // Décommente si tu utilises un Drive PARTAGÉ (Google Workspace) :
      // supportsAllDrives: true,
    });

    // Nettoyage
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

// ────────── START ──────────
app.listen(PORT, () => {
  console.log(`▶ rrweb-uploader listening on :${PORT}`);
  if (ALLOWED_ORIGIN.length) {
    console.log("   Allowed origins:", ALLOWED_ORIGIN.join(", "));
  } else {
    console.log("   ⚠️ No ALLOWED_ORIGIN configured");
  }
});
