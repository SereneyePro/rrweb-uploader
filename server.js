import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { google } from "googleapis";

// ====== ENV ======
const {
  PORT = 10000,
  DRIVE_FOLDER_ID,                 // ID du dossier Drive (parents)
  GOOGLE_SERVICE_JSON,             // contenu de la clé JSON du service account
  ALLOWED_ORIGIN = "",             // ex: "https://my-sereneye.com,https://www.my-sereneye.com"
  REPLAY_SECRET = "",              // ex: "SER89!"
  LOG_ORIGIN = "false"             // "true" pour logguer l'origine des requêtes
} = process.env;

// ====== App ======
const app = express();

// CORS whitelist multi-domaines
const allowList = ALLOWED_ORIGIN
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (LOG_ORIGIN === "true") console.log("Origin:", origin);
    // Si pas de liste → autoriser tout (utile pour debug). En prod, laisse ALLOWED_ORIGIN rempli.
    if (allowList.length === 0) return cb(null, true);
    // Requêtes sans origin (ex. curl) → OK
    if (!origin) return cb(null, true);
    if (allowList.includes(origin)) return cb(null, true);
    return cb(new Error("Origin not allowed"), false);
  })
}));

// Corps JSON (max 25 Mo pour de gros replays)
app.use(bodyParser.json({ limit: "25mb" }));

// Anti-cache
app.use((_, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// ====== Auth Google Drive ======
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];
let auth, drive;
try {
  const keyJson = JSON.parse(GOOGLE_SERVICE_JSON || "{}");
  auth = new google.auth.GoogleAuth({ credentials: keyJson, scopes: SCOPES });
  drive = google.drive({ version: "v3", auth });
} catch (e) {
  console.error("❌ GOOGLE_SERVICE_JSON invalide ou manquant:", e.message);
}

// ====== Mémoire temporaire des sessions ======
const sessions = new Map(); // sessionId -> { events: [], lastTs }
const SESSION_TTL_MS = 1000 * 60 * 30; // 30 min

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.lastTs > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 60_000);

// ====== Middleware secret ======
function checkSecret(req, res, next) {
  if (!REPLAY_SECRET) return next(); // si vide → pas de vérif (éviter en prod)
  const header = req.headers["x-replay-secret"];
  const q = req.query?.secret;
  if (header === REPLAY_SECRET || q === REPLAY_SECRET) return next();
  return res.status(401).send("unauthorized");
}

// ====== Routes ======
app.get("/", (_req, res) => res.send("ok"));

// reçoit des chunks d'évènements rrweb
app.post("/replay/chunk", checkSecret, (req, res) => {
  try {
    const { sessionId, events } = req.body || {};
    if (!sessionId || !Array.isArray(events)) {
      return res.status(400).send("bad request");
    }
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { events: [], lastTs: Date.now() });
    }
    const s = sessions.get(sessionId);
    s.events.push(...events);
    s.lastTs = Date.now();
    return res.status(204).end();
  } catch (e) {
    console.error("chunk error:", e);
    return res.status(500).send("error");
  }
});

// fin de session → dump JSON vers Google Drive
app.post("/replay/finish", checkSecret, async (req, res) => {
  try {
    const { sessionId, meta } = req.body || {};
    const s = sessions.get(sessionId);
    if (!sessionId || !s) return res.status(400).send("unknown session");
    if (!drive || !DRIVE_FOLDER_ID) return res.status(500).send("drive not configured");

    const content = JSON.stringify({
      sessionId,
      createdAt: new Date().toISOString(),
      meta: meta || {},
      events: s.events
    });

    const response = await drive.files.create({
      resource: {
        name: `rrweb-${sessionId}.json`,
        parents: [DRIVE_FOLDER_ID]
      },
      media: { mimeType: "application/json", body: Buffer.from(content, "utf8") },
      fields: "id,name,parents"
    });

    sessions.delete(sessionId);
    return res.status(200).send("uploaded");
  } catch (e) {
    console.error("finish error:", e?.response?.data || e.message || e);
    return res.status(500).send("upload error");
  }
});

// ====== Start ======
app.listen(PORT, () => {
  console.log(`✅ Uploader running on :${PORT}`);
});
