const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const {
  VERIFY_TOKEN,
  PAGE_ACCESS_TOKEN,
  VERTEX_API_KEY,
  VERTEX_ENDPOINT
} = process.env;

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("WEBHOOK_VERIFIED");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object === "page") {
    for (const entry of body.entry) {
      for (const event of entry.messaging) {
        const senderId = event.sender.id;
        const userMessage = event.message?.text;

        if (userMessage) {
          try {
            // Send to Gemini Model
            const vertexRes = await axios.post(
              `${VERTEX_ENDPOINT}?key=${VERTEX_API_KEY}`,
              {
                instances: [
                  {
                    prompt: {
                      context: "",
                      examples: [],
                      messages: [
                        { author: "user", content: userMessage }
                      ]
                    }
                  }
                ]
              },
              {
                headers: {
                  Authorization: `Bearer ${VERTEX_API_KEY}`,
                  "Content-Type": "application/json"
                }
              }
            );

            const reply =
              vertexRes.data?.predictions?.[0]?.candidates?.[0]?.content || "Sorry, I couldn't understand that.";

            // Send reply to Facebook
            await axios.post(
              `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
              {
                recipient: { id: senderId },
                message: { text: reply }
              }
            );
          } catch (err) {
            console.error("Error:", err.message);
          }
        }
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

app.listen(3000, () => {
  console.log("Webhook server running on port 3000");
});
