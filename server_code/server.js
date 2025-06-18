import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const {
  WEBHOOK_VERIFY_TOKEN,
  GRAPH_API_TOKEN,
  PORT,
  NEXTCLOUD_URL,
  NEXTCLOUD_USERNAME,
  NEXTCLOUD_PASSWORD,
} = process.env;

const downloadsDir = path.join(process.cwd(), "whatsapp-messages");
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

// Créer le fichier log.csv s’il n’existe pas
const logPath = path.join(process.cwd(), "log.csv");
if (!fs.existsSync(logPath)) {
  fs.writeFileSync(
    logPath,
    "timestamp,phone_number,contact_name,message_type,download_status,nextcloud_status,error\n"
  );
}

// Fonction pour journaliser une ligne
function logMessage({ phone, name, type, download, nextcloud, error = "" }) {
  const timestamp = new Date().toISOString();
  const line = `${timestamp},${phone},"${name}",${type},${download},${nextcloud},"${error.replace(/"/g, "'")}"\n`;
  fs.appendFile(logPath, line, (err) => {
    if (err) console.error("❌ Erreur d'écriture du log :", err);
  });
}

app.post("/webhook", async (req, res) => {
  console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));
  const message = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0];
  const business_phone_number_id =
    req.body.entry?.[0].changes?.[0].value?.metadata?.phone_number_id;

  if (!message) return res.sendStatus(200);

  const profileNameRaw =
    req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name || "unknown";
  const profileName = profileNameRaw.replace(/\s+/g, "-");
  const phoneNumber = message.from;

  // Texte
  if (message?.type === "text") {
    const timestamp = message.timestamp;
    const date = new Date(timestamp * 1000);
    const h = date.getHours().toString().padStart(2, "0");
    const m = date.getMinutes().toString().padStart(2, "0");
    const s = date.getSeconds().toString().padStart(2, "0");

    try {
      await axios.post(
        `https://graph.facebook.com/v18.0/${business_phone_number_id}/messages`,
        {
          messaging_product: "whatsapp",
          to: message.from,
          text: {
            body: `(Test-Phase): ${message.text.body} received successfully at ${h}:${m}:${s}.`,
          },
          context: { message_id: message.id },
        },
        { headers: { Authorization: `Bearer ${GRAPH_API_TOKEN}` } }
      );

      await axios.post(
        `https://graph.facebook.com/v18.0/${business_phone_number_id}/messages`,
        {
          messaging_product: "whatsapp",
          status: "read",
          message_id: message.id,
        },
        { headers: { Authorization: `Bearer ${GRAPH_API_TOKEN}` } }
      );

      logMessage({
        phone: phoneNumber,
        name: profileName,
        type: "text",
        download: "n/a",
        nextcloud: "n/a",
      });
    } catch (err) {
      logMessage({
        phone: phoneNumber,
        name: profileName,
        type: "text",
        download: "n/a",
        nextcloud: "n/a",
        error: err.message,
      });
    }
  }

  // Audio
  if (message?.type === "audio") {
    const mediaId = message.audio.id;
    const timestamp = message.timestamp;
    const fileName = `${profileName}_${phoneNumber}_${timestamp}.ogg`;
    const filePath = path.join(downloadsDir, fileName);

    try {
      const mediaUrlRes = await axios.get(
        `https://graph.facebook.com/v18.0/${mediaId}`,
        { headers: { Authorization: `Bearer ${GRAPH_API_TOKEN}` } }
      );
      const mediaUrl = mediaUrlRes.data.url;

      const audioRes = await axios.get(mediaUrl, {
        headers: { Authorization: `Bearer ${GRAPH_API_TOKEN}` },
        responseType: "stream",
      });

      const writer = fs.createWriteStream(filePath);
      audioRes.data.pipe(writer);

      writer.on("finish", async () => {
        console.log("✅ Message vocal téléchargé localement :", fileName);

        // Répondre automatiquement
        const date = new Date(timestamp * 1000);
        const h = date.getHours().toString().padStart(2, "0");
        const m = date.getMinutes().toString().padStart(2, "0");
        const s = date.getSeconds().toString().padStart(2, "0");

        try {
          await axios.post(
            `https://graph.facebook.com/v18.0/${business_phone_number_id}/messages`,
            {
              messaging_product: "whatsapp",
              to: phoneNumber,
              text: {
                body: `(Test-Phase): Vocal received and saved successfully at ${h}:${m}:${s}.`,
              },
              context: { message_id: message.id },
            },
            { headers: { Authorization: `Bearer ${GRAPH_API_TOKEN}` } }
          );
          console.log("✅ Réponse automatique envoyée");
        } catch (autoReplyErr) {
          console.error("❌ Erreur lors de l'envoi de la réponse automatique :", autoReplyErr.message);
        }

        try {
          const fileStream = fs.createReadStream(filePath);
          const nextcloudPath = `${NEXTCLOUD_URL}${fileName}`;
          await axios.put(nextcloudPath, fileStream, {
            auth: {
              username: NEXTCLOUD_USERNAME,
              password: NEXTCLOUD_PASSWORD,
            },
            headers: { "Content-Type": "audio/ogg" },
          });
          console.log("✅ Fichier transféré vers Nextcloud :", nextcloudPath);

          logMessage({
            phone: phoneNumber,
            name: profileName,
            type: "audio",
            download: "success",
            nextcloud: "success",
          });
        } catch (uploadErr) {
          logMessage({
            phone: phoneNumber,
            name: profileName,
            type: "audio",
            download: "success",
            nextcloud: "failed",
            error: uploadErr.message,
          });
          console.error("❌ Erreur lors de l'envoi vers Nextcloud :", uploadErr.message);
        }
      });

      writer.on("error", (err) => {
        console.error("❌ Erreur d'écriture du fichier :", err);
        logMessage({
          phone: phoneNumber,
          name: profileName,
          type: "audio",
          download: "failed",
          nextcloud: "n/a",
          error: err.message,
        });
      });
    } catch (err) {
      console.error("❌ Erreur lors du téléchargement du message vocal :", err.message);
      logMessage({
        phone: phoneNumber,
        name: profileName,
        type: "audio",
        download: "failed",
        nextcloud: "n/a",
        error: err.message,
      });
    }
  }

  res.sendStatus(200);
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
    console.log("Webhook verified successfully!");
  } else {
    res.sendStatus(403);
  }
});

app.get("/", (req, res) => {
  res.send(`<pre>Nothing to see here. Checkout README.md to start.</pre>`);
});

app.listen(PORT, () => {
  console.log(`Server is listening on port: ${PORT}`);
});