/** server.js - Facebook Messenger × VertexAI (Gemini) × UsedConex
 *  Run: node server.js
 *  Env: VERIFY_TOKEN, PAGE_ACCESS_TOKEN, APP_SECRET, GCP_PROJECT_ID, GCP_LOCATION, USEDCONEX_API, (optional) VERTEX_ENDPOINT, PORT
 */

"use strict";

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const axios = require("axios");
const { VertexAI } = require("@google-cloud/vertexai");
require("dotenv").config();

/* ----------------- Env Validation ----------------- */
const requiredEnv = [
  "VERIFY_TOKEN",
  "PAGE_ACCESS_TOKEN",
  "APP_SECRET",
  "GCP_PROJECT_ID",
  "GCP_LOCATION",
  "USEDCONEX_API",
];
for (const k of requiredEnv) {
  if (!process.env[k]) {
    console.error(`Missing required env: ${k}`);
    process.exit(1);
  }
}

/* ----------------- App & Raw Body for Signature ----------------- */
const app = express();
// Keep raw body for signature verification
app.use(
  bodyParser.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

/* ----------------- Verify Facebook Signature ----------------- */
function verifyFbSignature(req) {
  const sig = req.headers["x-hub-signature-256"];
  if (!sig) throw new Error("Missing X-Hub-Signature-256");
  const [algo, theirHash] = sig.split("=");
  if (algo !== "sha256" || !theirHash) throw new Error("Bad signature format");
  const expected = crypto
    .createHmac("sha256", process.env.APP_SECRET)
    .update(req.rawBody)
    .digest("hex");
  if (theirHash !== expected) throw new Error("Invalid signature");
}

/* ----------------- Vertex AI (Gemini) ----------------- */
// Define tool (function calling) schema
const tools = [
  {
    functionDeclarations: [
      {
        name: "get_container_quote",
        description:
          "Get a delivered container quote to a US ZIP using UsedConex API.",
        parameters: {
          type: "OBJECT",
          properties: {
            zipcode: {
              type: "string",
              description: "US ZIP code (5 digits)",
              pattern: "^[0-9]{5}$",
            },
            size: {
              type: "string",
              description: "Container size",
              enum: ["20ft", "40ft"],
              default: "20ft",
            },
            condition: {
              type: "string",
              description: "Condition of container",
              default: "cargo-worthy",
            },
            quantity: {
              type: "integer",
              description: "Number of units",
              minimum: 1,
              default: 1,
            },
          },
          required: ["zipcode"],
        },
      },
    ],
  },
];

const systemPrompt = `
You are a helpful sales assistant for UsedConex shipping containers.

Goals:
- Help customers get price quotes quickly and clearly.

Rules:
1) If no ZIP is present, ask for a 5-digit US ZIP code.
2) For price inquiries: call get_container_quote(zipcode, size, condition, quantity).
3) Tone: friendly, concise, professional.
4) Prices include delivery to the ZIP.
5) Defaults: 20ft cargo-worthy, qty=1.

Examples:
- "Please provide a 5-digit ZIP code for delivery."
- "Here's your quote for a 20ft container to ZIP 12345: $X (including delivery)."
`.trim();

const vertex = new VertexAI({
  project: process.env.GCP_PROJECT_ID,
  location: process.env.GCP_LOCATION,
  apiEndpoint: process.env.VERTEX_ENDPOINT, // optional
});

// Configure model with systemInstruction, tools, safety
const model = vertex.getGenerativeModel({
  model: "gemini-1.5-pro",
  systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
  tools,
  safetySettings: [
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_SEXUAL_CONTENT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
  ],
});

/* ----------------- UsedConex API helpers ----------------- */
async function getAuthToken() {
  // NOTE: اگر API شما credential لازم دارد، اینجا اضافه کنید.
  const url = `${process.env.USEDCONEX_API}/client/v1/User/login/website`;
  try {
    const res = await axios.post(
      url,
      {},
      { headers: { "Content-Type": "application/json" }, timeout: 12000 }
    );
    const token = res?.data?.data?.Token;
    if (!token) throw new Error("No token in UsedConex login response");
    return token;
  } catch (err) {
    console.error("UsedConex login error:", err?.response?.data || err.message);
    throw new Error("Failed to authenticate with UsedConex API");
  }
}

async function getQuoteFromUsedConex({
  zipcode,
  size = "20ft",
  condition = "cargo-worthy",
  quantity = 1,
}) {
  const token = await getAuthToken();
  const url = `${process.env.USEDCONEX_API}/client/v1/Quote/create`;
  const payload = {
    zipcode,
    isDelivery: true,
    items: [{ size, condition, quantity }],
  };
  try {
    const res = await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      timeout: 20000,
    });
    // ساختار پاسخ را منعطف بخوانیم
    const data = res?.data?.data ?? res?.data;
    if (!data) throw new Error("Empty quote data");
    // ممکن است آرایه یا آبجکت باشد
    const item = Array.isArray(data) ? data[0] : data;
    const total =
      Number(item?.totalPrice || 0) + Number(item?.totalTransport || 0);
    return {
      zipcode,
      size,
      condition,
      quantity,
      total: Number.isFinite(total) ? total : null,
      raw: data,
    };
  } catch (err) {
    console.error("UsedConex quote error:", err?.response?.data || err.message);
    throw new Error("Failed to get quote");
  }
}

/* ----------------- Messenger helpers ----------------- */
const graphBase = "https://graph.facebook.com/v20.0";
const pageToken = process.env.PAGE_ACCESS_TOKEN;

async function sendSenderAction(recipientId, action = "typing_on") {
  try {
    await axios.post(
      `${graphBase}/me/messages`,
      {
        recipient: { id: recipientId },
        sender_action: action, // typing_on | typing_off | mark_seen
      },
      { params: { access_token: pageToken }, timeout: 8000 }
    );
  } catch (e) {
    // no-op
  }
}

async function sendText(recipientId, text, attempt = 1) {
  try {
    await axios.post(
      `${graphBase}/me/messages`,
      {
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text: text?.slice(0, 2000) || "" },
      },
      { params: { access_token: pageToken }, timeout: 12000 }
    );
  } catch (err) {
    const status = err?.response?.status;
    if (attempt < 3 && (status === 429 || (status >= 500 && status < 600))) {
      const backoff = 300 * attempt;
      await new Promise((r) => setTimeout(r, backoff));
      return sendText(recipientId, text, attempt + 1);
    }
    console.error("Messenger send error:", err?.response?.data || err.message);
  }
}

/* ----------------- Utils ----------------- */
const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/;
function extractZip(text = "") {
  const m = text.match(ZIP_RE);
  return m ? m[1] : null; // فقط ۵ رقمی اول را برگردان
}

function sanitizeQuantity(q) {
  const n = Number(q);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/* ----------------- Webhook: Verify ----------------- */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const verifyToken = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && verifyToken === process.env.VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* ----------------- Webhook: Receive ----------------- */
app.post("/webhook", async (req, res) => {
  try {
    // Verify signature (throws if invalid)
    verifyFbSignature(req);

    const body = req.body;
    if (body.object !== "page") {
      return res.sendStatus(200);
    }

    // Each entry can contain multiple messaging events
    for (const entry of body.entry || []) {
      const events = entry.messaging || [];
      for (const event of events) {
        const senderId = event?.sender?.id;
        if (!senderId) continue;

        // mark seen + typing
        await sendSenderAction(senderId, "mark_seen");
        await sendSenderAction(senderId, "typing_on");

        try {
          if (event.message?.text) {
            const text = (event.message.text || "").trim();
            await handleUserText(senderId, text);
          } else if (event.message?.attachments) {
            // If location/image/file: ask for ZIP
            await sendText(
              senderId,
              "برای محاسبه قیمت، لطفاً یک ZIP کد ۵ رقمی آمریکا ارسال کنید."
            );
          } else {
            // Other event types (postbacks, etc.)
            await sendText(
              senderId,
              "سلام! برای دریافت قیمت لطفاً یک ZIP کد ۵ رقمی آمریکا بفرستید."
            );
          }
        } catch (err) {
          console.error("Event handling error:", err.message);
          await sendText(
            senderId,
            "متأسفانه الان نتونستم قیمت بگیرم. لطفاً کمی بعد دوباره تلاش کنید."
          );
        } finally {
          await sendSenderAction(senderId, "typing_off");
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.message);
    // Signature failures should be 403; others 500
    if (/signature/i.test(err.message)) return res.sendStatus(403);
    return res.sendStatus(500);
  }
});

/* ----------------- Handler: User Text via Gemini ----------------- */
async function handleUserText(senderId, messageText) {
  // Try to guide Gemini with tools; also have local fallback extraction

  // 1) Ask Gemini with tools
  const contents = [{ role: "user", parts: [{ text: messageText }] }];
  let gen;
  try {
    gen = await model.generateContent({ contents, tools });
  } catch (e) {
    console.error("Gemini error:", e.message);
  }

  const parts = gen?.response?.candidates?.[0]?.content?.parts || [];
  const toolPart = parts.find((p) => p.functionCall);
  if (toolPart?.functionCall?.name === "get_container_quote") {
    const args = toolPart.functionCall.args || {};
    const zipcode = String(args.zipcode || "").trim();
    const size = (args.size || "20ft").toString();
    const condition = (args.condition || "cargo-worthy").toString();
    const quantity = sanitizeQuantity(args.quantity || 1);

    if (!/^\d{5}$/.test(zipcode)) {
      await sendText(
        senderId,
        "لطفاً یک ZIP کد معتبر ۵ رقمی ارسال کنید (مثلاً 90210)."
      );
      return;
    }

    const quote = await getQuoteFromUsedConex({
      zipcode,
      size,
      condition,
      quantity,
    });

    if (!quote?.total) {
      await sendText(
        senderId,
        `متأسفانه برای ${zipcode} موجودی/قیمت پیدا نشد. لطفاً ZIP دیگری امتحان کنید.`
      );
      return;
    }

    const price = quote.total.toFixed(2);
    const msg = `قیمت ${size} (${condition}) برای ${zipcode} به تعداد ${quantity}:
$${price} (با احتساب هزینه ارسال). اگر مایل هستید، مشخصات تماس‌تون رو بفرستید تا سفارش ثبت شود.`;
    await sendText(senderId, msg);
    return;
  }

  // 2) If no functionCall, see if Gemini produced text to send
  const textAnswer = parts.map((p) => p.text).filter(Boolean).join(" ").trim();

  // 3) Fallback: try local ZIP extraction to auto-quote
  const zip = extractZip(messageText);
  if (zip) {
    const quote = await getQuoteFromUsedConex({
      zipcode: zip,
      size: "20ft",
      condition: "cargo-worthy",
      quantity: 1,
    });
    if (quote?.total) {
      const price = quote.total.toFixed(2);
      await sendText(
        senderId,
        `قیمت 20ft (cargo-worthy) برای ${zip}: $${price} (با ارسال). برای سایز یا تعداد دیگر بفرمایید.`
      );
      return;
    }
  }

  // 4) Otherwise, send Gemini's text or ask for ZIP
  if (textAnswer) {
    await sendText(senderId, textAnswer);
  } else {
    await sendText(
      senderId,
      "برای محاسبه قیمت، لطفاً یک ZIP کد ۵ رقمی آمریکا ارسال کنید (مثلاً 10001)."
    );
  }
}

/* ----------------- Health ----------------- */
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

/* ----------------- Start ----------------- */
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
