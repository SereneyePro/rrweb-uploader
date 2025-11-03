// server.js — rrweb → Google Drive via OAuth (fallback Service Account) + Lecteur intégré
// Nécessite: express, body-parser, googleapis
// Assure-toi d'avoir ces variables sur Render:
// PORT, ALLOWED_ORIGIN, REPLAY_SECRET, DRIVE_FOLDER_ID,
// GOOGLE_CLIENT_ID (ou OAUTH_CLIENT_ID), GOOGLE_CLIENT_SECRET (ou OAUTH_CLIENT_SECRET),
// OAUTH_REFRESH_TOKEN
// (facultatif fallback) GOOGLE_SERVICE_JSON

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
  const oAuth2 = new google.auth.OAuth2(
    OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );
  oAuth2.setCredentials({ refresh_token: OAUTH_REFRESH_TOKEN });
  auth = oAuth2;
  console.log("🔐 Using OAuth client (files owned by YOUR Google account)");
} else if (GOOGLE_SERVICE_JSON) {
  try {
    const creds = JSON.parse(GOOGLE_SERVICE_JSON);
    if (typeof creds.private_key === "string") {
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

// CORS + preflight
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

// Secret requis pour les endpoints d'upload
function checkSecret(req, res, next) {
  const incoming = req.headers["x-replay-secret"];
  if (!REPLAY_SECRET || incoming !== REPLAY_SECRET) {
    return res.status(401).send("unauthorized");
  }
  next();
}

const sessions = new Map();

// ────────── ROUTES CAPTURE RRWEB ──────────
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

    const json = JSON.stringify(data, null, 2);
    const media = { mimeType: "application/json", body: Readable.from([json]) };
    const requestBody = { name, parents: [DRIVE_FOLDER_ID] };

    const result = await drive.files.create({
      requestBody,
      media,
      fields: "id, name",
      uploadType: "multipart",
      // Si ton dossier est dans un Drive partagé (Workspace), décommente:
      // supportsAllDrives: true,
    });

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

// ────────── ROUTES LECTEUR (LIST + GET + PAGE VIEWER) ──────────

// Lister les 50 derniers fichiers du dossier Drive
app.get("/replay/files", async (req, res) => {
  try {
    if (!drive || !DRIVE_FOLDER_ID) return res.status(500).send("drive not configured");

    const resp = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
      orderBy: "modifiedTime desc",
      pageSize: 50,
      fields: "files(id,name,modifiedTime,size,mimeType)",
      // supportsAllDrives: true,
      // includeItemsFromAllDrives: true,
    });

    res.json({ files: resp.data.files || [] });
  } catch (e) {
    console.error("list error", e?.response?.data || e);
    res.status(500).send("list error");
  }
});

// Récupérer le contenu JSON d’un fichier Drive par id (stream)
app.get("/replay/file/:id", async (req, res) => {
  try {
    if (!drive) return res.status(500).send("drive not configured");
    const { id } = req.params;

    const fileMeta = await drive.files.get({ fileId: id, fields: "name,mimeType" });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="${fileMeta.data.name}"`);

    const dl = await drive.files.get(
      { fileId: id, alt: "media" },
      { responseType: "stream" }
    );

    dl.data.on("error", (err) => {
      console.error("stream error", err);
      res.status(500).end("stream error");
    });
    dl.data.pipe(res);
  } catch (e) {
    console.error("get file error", e?.response?.data || e);
    res.status(500).send("get file error");
  }
});

// Page viewer rrweb
app.get("/replay/viewer", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Sereneye • Lecteur rrweb</title>
<link rel="stylesheet" href="https://unpkg.com/rrweb-player@latest/dist/style.css" />
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0b0c; color:#eaeaea; margin:0; }
  header { padding:14px 18px; border-bottom:1px solid #242424; display:flex; gap:14px; align-items:center; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  .btn { background:#1e1e1f; border:1px solid #2c2c2d; color:#eaeaea; padding:8px 12px; border-radius:10px; cursor:pointer; }
  .btn:hover { background:#232324; }
  main { display:grid; grid-template-columns: 360px 1fr; gap:0; min-height:calc(100vh - 52px); }
  aside { border-right:1px solid #242424; overflow:auto; }
  .list { padding:10px; }
  .item { padding:10px; border:1px solid #242424; border-radius:10px; margin:10px; background:#121213; cursor:pointer; }
  .item:hover { border-color:#444; background:#161617; }
  .meta { font-size:12px; color:#9a9a9a; margin-top:6px; }
  #player { display:flex; align-items:center; justify-content:center; padding:18px; }
  .empty { opacity:.7; font-size:14px; padding:24px; }
  .footer { padding:8px 12px; font-size:12px; color:#8a8a8a; border-top:1px solid #242424; }
  .row { display:flex; align-items:center; gap:10px; }
  input[type="text"] { background:#101011; color:#eaeaea; border:1px solid #242424; border-radius:10px; padding:8px 10px; width:280px; }
</style>
</head>
<body>
  <header>
    <h1>Lecteur rrweb</h1>
    <button class="btn" id="refresh">Rafraîchir la liste</button>
    <div class="row">
      <input id="pasteId" type="text" placeholder="Coller un fileId Drive..." />
      <button class="btn" id="openId">Ouvrir</button>
    </div>
  </header>

  <main>
    <aside>
      <div class="list" id="list"></div>
      <div class="footer">Dossier Drive configuré via <code>DRIVE_FOLDER_ID</code>.</div>
    </aside>
    <section id="player">
      <div class="empty">Sélectionnez un enregistrement dans la liste de gauche.</div>
    </section>
  </main>

  <script src="https://unpkg.com/rrweb-player@latest/dist/index.js"></script>
  <script>
    const api = {
      list: () => fetch("/replay/files").then(r => r.json()),
      open: (id) => fetch("/replay/file/" + encodeURIComponent(id)).then(r => r.json())
    };

    const listEl = document.getElementById("list");
    const playerEl = document.getElementById("player");
    const pasteId = document.getElementById("pasteId");
    document.getElementById("refresh").onclick = loadList;
    document.getElementById("openId").onclick = () => {
      const id = pasteId.value.trim();
      if (id) openFile(id);
    };

    async function loadList(){
      listEl.innerHTML = "<div class='empty'>Chargement…</div>";
      try {
        const data = await api.list();
        const files = (data && data.files) || [];
        if (!files.length) {
          listEl.innerHTML = "<div class='empty'>Aucun fichier trouvé dans le dossier.</div>";
          return;
        }
        listEl.innerHTML = "";
        for (const f of files) {
          const d = new Date(f.modifiedTime).toLocaleString();
          const el = document.createElement("div");
          el.className = "item";
          el.innerHTML = "<div><strong>" + (f.name || f.id) + "</strong></div>" +
                         "<div class='meta'>Modifié: " + d + " • Taille: " + (Number(f.size || 0)/1024).toFixed(1) + " Ko</div>";
          el.onclick = () => openFile(f.id);
          listEl.appendChild(el);
        }
      } catch (e) {
        listEl.innerHTML = "<div class='empty'>Erreur de liste.</div>";
      }
    }

    async function openFile(id){
      playerEl.innerHTML = "<div class='empty'>Chargement…</div>";
      try {
        const events = await api.open(id);
        playerEl.innerHTML = "";
        new rrwebPlayer({
          target: playerEl,
          props: { events }
        });
      } catch (e) {
        console.error(e);
        playerEl.innerHTML = "<div class='empty'>Erreur de lecture de l'enregistrement.</div>";
      }
    }

    loadList();
  </script>
</body>
</html>`);
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
