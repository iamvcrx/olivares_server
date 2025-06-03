import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";

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

const downloadsDir = "/downloads";
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir);
}

app.post("/webhook", async (req, res) => {
  console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));
  const message = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0];
  const business_phone_number_id =
    req.body.entry?.[0].changes?.[0].value?.metadata?.phone_number_id;

  // Texte
  if (message?.type === "text") {
    await axios.post(
      `https://graph.facebook.com/v18.0/${business_phone_number_id}/messages`,
      {
        messaging_product: "whatsapp",
        to: message.from,
        text: { body: "Echo: " + message.text.body + " et ouais je suis un génie" },
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
  }

  // Audio
  if (message?.type === "audio") {
    const mediaId = message.audio.id;

    const profileNameRaw =
      req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name || "unknown";
    const profileName = profileNameRaw.replace(/\s+/g, "-");
    const phoneNumber = message.from;
    const timestamp = message.timestamp;

    // Répondre automatiquement au message vocal
    //try {
      //await axios.post(
        //`https://graph.facebook.com/v18.0/${business_phone_number_id}/messages`,
        //{
          //messaging_product: "whatsapp",
          //to: phoneNumber,
          //text: {
            //body: "insérer réponse automatique",
          //},
          //context: { message_id: message.id },
        //},
        //{ headers: { Authorization: `Bearer ${GRAPH_API_TOKEN}` } }
      //);
      //console.log("✅ Réponse automatique envoyée");
    //} catch (autoReplyErr) {
      //console.error("❌ Erreur lors de l'envoi de la réponse automatique :", autoReplyErr.message);
    //}

    // Télécharger et enregistrer le message vocal
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

      const fileName = `${profileName}_${phoneNumber}_${timestamp}.ogg`;
      const filePath = path.join(downloadsDir, fileName);

      const writer = fs.createWriteStream(filePath);
      audioRes.data.pipe(writer);

      writer.on("finish", async () => {
        console.log("✅ Message vocal téléchargé localement :", fileName);

        const nextcloudPath = `${NEXTCLOUD_URL}${fileName}`;

        try {
          const fileStream = fs.createReadStream(filePath);
          await axios.put(nextcloudPath, fileStream, {
            auth: {
              username: NEXTCLOUD_USERNAME,
              password: NEXTCLOUD_PASSWORD,
            },
            headers: {
              "Content-Type": "audio/ogg",
            },
          });
          console.log("✅ Fichier transféré vers Nextcloud :", nextcloudPath);
        } catch (uploadErr) {
          console.error("❌ Erreur lors de l'envoi vers Nextcloud :", uploadErr.message);
        }
      });

      writer.on("error", (err) => {
        console.error("❌ Erreur d'écriture du fichier :", err);
      });
    } catch (err) {
      console.error("❌ Erreur lors du téléchargement du message vocal :", err.message);
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