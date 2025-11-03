import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { google } from "googleapis";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

// Authentification Google via ton fichier clé JSON (service account)
const KEYFILE_PATH = "./service-account.json"; // on l’ajoutera ensuite
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

const auth = new google.auth.GoogleAuth({
  keyFile: KEYFILE_PATH,
  scopes: SCOPES,
});

const drive = google.drive({ version: "v3", auth });

// --- Route pour recevoir les fichiers RRWeb ---
app.post("/upload", async (req, res) => {
  try {
    const { filename, data } = req.body;
    if (!filename || !data) {
      return res.status(400).send("Missing filename or data");
    }

    const tempPath = path.join("/tmp", filename);
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

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
