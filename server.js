import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { google } from "googleapis";

// ---- Config via variables d'environnement Render ----
const {
  PORT = 3000,
  DRIVE_FOLDER_ID,                 // ID du dossier Drive
  GOOGLE_SERVICE_JSON,             // contenu JSON de la clé (variable Render)
  ALLOWED_ORIGIN,                  // ex: https://tonsite.myshopify.com (optionnel)
  REPLAY_SECRET                    // petit secret anti-abus (optionnel)
} = process.env;

// ---- CORS (autorise ta boutique si ALLOWED_ORIGIN est défini) ----
const app = express();
app.use(cors({
  origin: (origin, cb) => {
    if (!ALLOWED_ORIGIN) return cb(null, true);
    if (!origin || origin === ALLOWED_ORIGIN) return cb(null, true);
    return cb(new Error("Origin not allowed"), false);
  }
}));
app.use(bodyParser.json({ limit: "25mb" }));

// ---- Auth Google Drive depuis la variable d'env ----
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const keyJson = JSON.parse(GOOGLE_SERVICE_JSON);
const auth = new google.auth.GoogleAuth({ credentials: keyJson, scopes: SCOPES });
const drive = google.drive({ version: "v3", auth });

// ---- Mémoire temporaire pour assembler les events rrweb ----
const sessions = new Map(); // sessionId -> { events: [], lastTs }

// Petit middleware pour vérifier le secret (si défini)
function checkSecret(req, res, next) {
  if (!REPLAY_SECRET) return next();
  const s = req.headers["x-replay-secret"];
  if (s === REPLAY_SECRET) return next();
  return res.status(401).send("unauthorized");
}

// Healthcheck
app.get("/", (_req, res) => res.send("ok"));

// Réception de chunks d'événements
app.post("/replay/chunk", checkSecret, (req, res) => {
  const { sessionId, events } = req.body || {};
  if (!sessionId || !Array.isArray(events)) return res.status(400).send("bad request");
  if (!sessions.has(sessionId)) sessions.set(sessionId, { events: [], lastTs: Date.now() });
  const s = sessions.get(sessionId);
  s.events.push(...events);
  s.lastTs = Date.now();
  return res.status(204).end();
});

// Fin de session → upload JSON vers Drive
app.post("/replay/finish", checkSecret, async (req, res) => {
  try {
    const { sessionId, meta } = req.body || {};
    const s = sessions.get(sessionId);
    if (!sessionId || !s) return res.status(400).send("unknown session");

    const content = JSON.stringify({
      sessionId,
      createdAt: new Date().toISOString(),
      meta: meta || {},
      events: s.events
    });

    await drive.files.create({
      resource: { name: `rrweb-${sessionId}.json`, parents: [DRIVE_FOLDER_ID] },
      media: { mimeType: "application/json", body: Buffer.from(content, "utf8") },
      fields: "id"
    });

    sessions.delete(sessionId);
    res.status(200).send("uploaded");
  } catch (e) {
    console.error(e);
    res.status(500).send("upload error");
  }
});

app.listen(PORT, () => console.log(`✅ Uploader running on :${PORT}`));
