const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const crypto = require("crypto");
require("dotenv").config();

// ===== Vertex AI (Gemini) =====
const { VertexAI } = require("@google-cloud/vertexai");
const {
  VERIFY_TOKEN,
  PAGE_ACCESS_TOKEN,
  GCLOUD_PROJECT,
  VERTEX_LOCATION = "us-central1",
  USEDCONEX_API = "https://api.usedconex.com",
  ZIP_URL = "/client/v1/Order/zip",
  QUOTE_URL = "/client/v1/Quote/create", // اگر مسیر واقعی شما فرق دارد این را تغییر بده
} = process.env;

const vertexAI = new VertexAI({
  project: GCLOUD_PROJECT,
  location: VERTEX_LOCATION,
});
const model = vertexAI.getGenerativeModel({ model: "gemini-1.5-pro" });

// ===== Tools (function calling) =====
const tools = [
  {
    functionDeclarations: [
      {
        name: "get_zip_info",
        description: "Validate/resolve a US 5-digit ZIP code to address/depot info.",
        parameters: {
          type: "OBJECT",
          properties: {
            zipcode: { type: "STRING", description: "5-digit US ZIP code" },
          },
          required: ["zipcode"],
        },
      },
      {
        name: "get_quote",
        description: "Get a container quote for a given 5-digit US ZIP code.",
        parameters: {
          type: "OBJECT",
          properties: {
            zipcode: { type: "STRING" },
            isDelivery: { type: "BOOLEAN" },
            size: { type: "STRING" },
            condition: { type: "STRING" },
            quantity: { type: "NUMBER" },
          },
          required: ["zipcode"],
        },
      },
    ],
  },
];

const app = express();
app.use(
  bodyParser.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // اگر امضای فیس‌بوک رو می‌خوای چک کنی
    },
  })
);

/* ----------------- Messenger Verify (GET) ----------------- */
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

/* ----------------- UsedConex helpers ----------------- */
async function ucLogin() {
  const url = `${USEDCONEX_API}/client/v1/User/login/website`;
  const res = await axios.post(
    url,
    {},
    { headers: { "Content-Type": "application/json" }, timeout: 10000 }
  );
  const token = res?.data?.data?.Token;
  if (!token) throw new Error("UC token not found");
  return token;
}

async function ucZipLookup(zipcode) {
  // اگر این GET نیاز به توکن ندارد، دو خط بعدی را حذف کن و headers را هم حذف کن
  const token = await ucLogin();
  const url = `${USEDCONEX_API}${ZIP_URL}/${zipcode}`;
  const res = await axios.get(url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    timeout: 10000,
  });
  return res.data;
}

async function ucQuote({
  zipcode,
  isDelivery = true,
  size = "20ft",
  condition = "cargo-worthy",
  quantity = 1,
}) {
  const token = await ucLogin();
  const url = `${USEDCONEX_API}${QUOTE_URL}`;
  const payload = {
    zipcode,
    isDelivery,
    items: [{ size, condition, quantity }],
  };
  const res = await axios.post(url, payload, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    timeout: 15000,
  });
  return res.data?.data || res.data;
}

/* ----------------- Messenger send API ----------------- */
async function sendText(recipientId, text) {
  const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(
    PAGE_ACCESS_TOKEN
  )}`;
  const body = {
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: { text },
  };
  await axios.post(url, body, { timeout: 10000 });
}

/* ----------------- Webhook (POST) ----------------- */
app.post("/webhook", async (req, res) => {
  try {
    if (req.body.object !== "page") return res.sendStatus(404);

    for (const entry of req.body.entry || []) {
      const event = entry.messaging?.[0];
      if (!event?.sender?.id) continue;

      const senderId = event.sender.id;
      const userText = event.message?.text || "";

      const systemPrompt = [
        "You are a helpful sales assistant for shipping containers.",
        "If the user provides a ZIP, first call get_zip_info to validate/resolve it.",
        "If the ZIP is valid and they ask for price/availability, call get_quote.",
        "If no ZIP is found, ask politely for a 5-digit ZIP code.",
        "Reply in clear, friendly English.",
      ].join("\n");

      let convo = [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "user", parts: [{ text: userText }] },
      ];

      let finalReply = null;

      // تا 3 مرحله اجازه‌ی tool-calling
      for (let step = 0; step < 3; step++) {
        const result = await model.generateContent({ tools, contents: convo });
        const resp = result.response;
        const parts = resp?.candidates?.[0]?.content?.parts || [];
        const toolCalls = parts.filter((p) => p.functionCall);

        if (!toolCalls.length) {
          finalReply = parts.map((p) => p.text).filter(Boolean).join(" ").trim();
          break;
        }

        const call = toolCalls[0].functionCall;
        const args = call.args || {};

        if (call.name === "get_zip_info") {
          const zip = (args.zipcode || "").toString().trim();
          if (!/^\d{5}$/.test(zip)) {
            await sendText(senderId, "Please provide a valid 5-digit ZIP code.");
            finalReply = null;
            break;
          }
          let toolResp;
          try {
            toolResp = await ucZipLookup(zip);
          } catch (e) {
            console.error("ZIP lookup error:", e?.response?.data || e.message);
            await sendText(
              senderId,
              "I couldn’t validate that ZIP right now. Please try again shortly."
            );
            finalReply = null;
            break;
          }

          // feed back to model
          convo.push({
            role: "tool",
            parts: [
              {
                functionResponse: {
                  name: "get_zip_info",
                  response: { name: "get_zip_info", content: toolResp },
                },
              },
            ],
          });
          continue;
        }

        if (call.name === "get_quote") {
          const zip = (args.zipcode || "").toString().trim();
          if (!/^\d{5}$/.test(zip)) {
            await sendText(senderId, "Please provide a valid 5-digit ZIP code.");
            finalReply = null;
            break;
          }

          let quoteResult;
          try {
            quoteResult = await ucQuote({
              zipcode: zip,
              isDelivery:
                args.isDelivery !== undefined ? !!args.isDelivery : true,
              size: args.size || "20ft",
              condition: args.condition || "cargo-worthy",
              quantity: Number(args.quantity || 1),
            });
          } catch (e) {
            console.error("UC quote error:", e?.response?.data || e.message);
            await sendText(
              senderId,
              "Sorry, I couldn't retrieve a quote right now. Please try again in a moment."
            );
            finalReply = null;
            break;
          }

          const composed = await model.generateContent({
            tools,
            contents: [
              { role: "user", parts: [{ text: userText }] },
              {
                role: "tool",
                parts: [
                  {
                    functionResponse: {
                      name: "get_quote",
                      response: { name: "get_quote", content: quoteResult },
                    },
                  },
                ],
              },
            ],
          });

          finalReply =
            composed?.response?.candidates?.[0]?.content?.parts
              ?.map((p) => p.text)
              .filter(Boolean)
              .join(" ")
              .trim() || `Here is your quote for ZIP ${zip}.`;
          break;
        }

        await sendText(senderId, "Sorry, I can’t do that yet.");
        finalReply = null;
        break;
      }

      if (finalReply) {
        await sendText(senderId, finalReply);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

app.listen(3000, () => {
  console.log("Webhook server running on port 3000");
});
