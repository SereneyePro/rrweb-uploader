// server.js — rrweb uploader vers Google Drive (Desktop + Mobile compatible)
// avec OAuth2 + sendBeacon mobile + lecteur intégré + fusion multi-fichiers

import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import { Readable } from "stream";

// ────────── CONFIGURATION ENV ──────────
const PORT = Number(process.env.PORT || 10000);
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const REPLAY_SECRET = process.env.REPLAY_SECRET || "";
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "";

// OAuth vars
const OAUTH_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || process.env.OAUTH_CLIENT_ID || "";
const OAUTH_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET || process.env.OAUTH_CLIENT_SECRET || "";
const OAUTH_REFRESH_TOKEN = process.env.OAUTH_REFRESH_TOKEN || "";

// Service account fallback
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
  console.log("🔐 Using OAuth client (user Drive)");
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
    console.log("🔐 Using Service Account credentials");
  } catch (e) {
    console.error("❌ Invalid GOOGLE_SERVICE_JSON", e);
  }
} else {
  console.warn("⚠️ No Google credentials found");
}

const drive = auth ? google.drive({ version: "v3", auth }) : null;

// ────────── EXPRESS APP ──────────
const app = express();

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGIN.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] ||
        "Content-Type, X-REPLAY-SECRET"
    );
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(bodyParser.json({ limit: "50mb" }));

// ────────── UTILITAIRES ──────────
function makeToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function checkSecret(req, res, next) {
  const incoming = req.headers["x-replay-secret"];
  if (!REPLAY_SECRET || incoming !== REPLAY_SECRET)
    return res.status(401).send("unauthorized");
  next();
}

const sessions = new Map();

// ────────── RRWEB ROUTES ──────────
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ---- START ----
app.post("/replay/start", checkSecret, (req, res) => {
  const { sessionId, meta } = req.body || {};
  if (!sessionId) return res.status(400).send("missing sessionId");
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      events: [],
      meta: meta || {},
      startedAt: Date.now(),
      token: makeToken(),
    });
  }
  const s = sessions.get(sessionId);
  return res.status(200).json({ ok: true, sessionToken: s.token });
});

// ---- CHUNK ----
app.post("/replay/chunk", checkSecret, (req, res) => {
  const { sessionId, events } = req.body || {};
  if (!sessionId || !Array.isArray(events))
    return res.status(400).send("missing sessionId or events");
  if (!sessions.has(sessionId))
    sessions.set(sessionId, { events: [], startedAt: Date.now() });
  const s = sessions.get(sessionId);
  s.events.push(...events);
  s.lastChunkAt = Date.now();
  res.status(200).send("ok");
});

// ---- FINISH ----
app.post("/replay/finish", checkSecret, async (req, res) => {
  try {
    const { sessionId, meta } = req.body || {};
    if (!sessionId) return res.status(400).send("missing sessionId");
    if (!drive || !DRIVE_FOLDER_ID) return res.status(500).send("drive not configured");
    const s = sessions.get(sessionId) || { events: [], meta: {} };
    const combinedMeta = { ...(s.meta || {}), ...(meta || {}) };
    const ts = new Date();
    const name = `session-${sessionId}-${ts.toISOString().replace(/[:]/g, "-")}.json`;

    const data = {
      sessionId,
      createdAt: ts.toISOString(),
      meta: combinedMeta,
      events: s.events || [],
      counts: { events: s.events.length || 0 },
    };

    const json = JSON.stringify(data, null, 2);
    const media = { mimeType: "application/json", body: Readable.from([json]) };
    const requestBody = { name, parents: [DRIVE_FOLDER_ID] };
    const result = await drive.files.create({
      requestBody,
      media,
      fields: "id, name",
      uploadType: "multipart",
    });

    sessions.delete(sessionId);
    res.json({
      status: "uploaded",
      fileId: result.data.id,
      fileName: result.data.name,
      events: data.counts.events,
    });
  } catch (e) {
    console.error("finish error", e?.response?.data || e);
    res.status(500).send("upload error");
  }
});

// ────────── BEACON ROUTES (mobile) ──────────
app.use("/replay/chunk-beacon", express.text({ type: "*/*", limit: "1mb" }));
app.use("/replay/finish-beacon", express.text({ type: "*/*", limit: "2mb" }));

function getSessionByToken(sessionId, token) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (!token || s.token !== token) return null;
  return s;
}

app.post("/replay/chunk-beacon", async (req, res) => {
  try {
    const payload =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const { sessionId, token, events } = payload;
    const s = getSessionByToken(sessionId, token);
    if (!s) return res.status(401).send("unauthorized");
    if (Array.isArray(events) && events.length) s.events.push(...events);
    s.lastChunkAt = Date.now();
    res.send("ok");
  } catch (e) {
    console.error("chunk-beacon error", e);
    res.status(500).send("chunk-beacon error");
  }
});

app.post("/replay/finish-beacon", async (req, res) => {
  try {
    const payload =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const { sessionId, token, meta } = payload;
    const s = getSessionByToken(sessionId, token);
    if (!s) return res.status(401).send("unauthorized");
    if (!drive || !DRIVE_FOLDER_ID) return res.status(500).send("drive not configured");

    const combinedMeta = { ...(s.meta || {}), ...(meta || {}) };
    const ts = new Date();
    const name = `session-${sessionId}-${ts.toISOString().replace(/[:]/g, "-")}.json`;

    const data = {
      sessionId,
      createdAt: ts.toISOString(),
      meta: combinedMeta,
      events: s.events || [],
      counts: { events: s.events.length || 0 },
    };

    const json = JSON.stringify(data, null, 2);
    const media = { mimeType: "application/json", body: Readable.from([json]) };
    const requestBody = { name, parents: [DRIVE_FOLDER_ID] };
    const result = await drive.files.create({
      requestBody,
      media,
      fields: "id, name",
      uploadType: "multipart",
    });

    sessions.delete(sessionId);
    res.json({
      status: "uploaded",
      fileId: result.data.id,
      fileName: result.data.name,
      events: data.counts.events,
    });
  } catch (e) {
    console.error("finish-beacon error", e?.response?.data || e);
    res.status(500).send("finish-beacon error");
  }
});

// ────────── LECTURE + MERGE ──────────
async function getDriveJson(fileId) {
  const resp = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return JSON.parse(Buffer.from(resp.data).toString("utf8"));
}

function mergeRrwebEvents(chunks) {
  const merged = [];
  let offset = 0;
  for (const chunk of chunks) {
    const evs = Array.isArray(chunk?.events) ? chunk.events : [];
    if (!evs.length) continue;
    const base = evs[0].timestamp ?? evs[0].data?.timestamp ?? Date.now();
    for (const e of evs) {
      const t = e.timestamp ?? e.data?.timestamp ?? base;
      const delta = t - base;
      const copy = { ...e, timestamp: offset + delta };
      if (copy.data && typeof copy.data === "object") {
        copy.data = { ...copy.data, timestamp: copy.timestamp };
      }
      merged.push(copy);
    }
    const last = evs.at(-1);
    const lastT = last.timestamp ?? last.data?.timestamp ?? base;
    offset += (lastT - base) + 1000;
  }
  merged.sort((a, b) => a.timestamp - b.timestamp);
  return merged;
}

app.get("/replay/merge", async (req, res) => {
  try {
    const ids = (req.query.ids || "").toString().split(",").map((x) => x.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).send("no ids provided");
    const parts = [];
    for (const id of ids) {
      const json = await getDriveJson(id);
      parts.push(Array.isArray(json) ? { events: json } : json);
    }
    const merged = mergeRrwebEvents(parts);
    res.json(merged);
  } catch (e) {
    console.error("merge error", e);
    res.status(500).send("merge error");
  }
});

app.get("/replay/files", async (_req, res) => {
  try {
    const resp = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
      orderBy: "modifiedTime desc",
      pageSize: 50,
      fields: "files(id,name,modifiedTime,size)",
    });
    res.json({ files: resp.data.files });
  } catch (e) {
    res.status(500).send("list error");
  }
});

app.get("/replay/file/:id", async (req, res) => {
  const { id } = req.params;
  const dl = await drive.files.get({ fileId: id, alt: "media" }, { responseType: "stream" });
  res.setHeader("Content-Type", "application/json");
  dl.data.pipe(res);
});

// ────────── VIEWER ──────────
app.get("/replay/viewer", (_req, res) => {
  res.sendFile(new URL("./viewer.html", import.meta.url).pathname);
});

// ────────── START SERVER ──────────
app.listen(PORT, () => {
  console.log(`▶ rrweb-uploader listening on :${PORT}`);
  console.log("   Allowed origins:", ALLOWED_ORIGIN.join(", "));
});
