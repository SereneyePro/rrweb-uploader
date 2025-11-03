import express from "express";
import fs from "fs";
import cors from "cors";
import bodyParser from "body-parser";
import { google } from "googleapis";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "100mb" }));

// --- Google Drive Auth depuis la variable d’environnement ---
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const keyJson = JSON.parse(process.env.GOOGLE_SERVICE_JSON);

const auth = new google.auth.GoogleAuth({
  credentials: keyJson,
  scopes: SCOPES,
});

const drive = google.drive({ version: "v3", auth });

// --- Récupère l’ID du dossier Google Drive depuis l’environnement ---
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

// --- Endpoint pour uploader un fichier ---
app.post("/upload", async (req, res) => {
  try {
    const { filename, data } = req.body;
    const tempPath = `/tmp/${filename}`;
    fs.writeFileSync(tempPath, Buffer.from(data, "base64"));

    const fileMetadata = {
      name: filename,
      parents: [DRIVE_FOLDER_ID],
    };
    const media = {
      mimeType: "video/webm",
      body: fs.createReadStream(tempPath),
    };

    const uploadedFile = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: "id",
    });

    fs.unlinkSync(tempPath);
    res.send({ success: true, fileId: uploadedFile.data.id });
  } catch (error) {
    console.error("Erreur upload:", error);
    res.status(500).send("Erreur serveur");
  }
});

// --- Lancer le serveur ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
