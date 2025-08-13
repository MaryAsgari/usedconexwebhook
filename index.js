/** @format */
/**
 * Secrets/Envs (با fly secrets ست کن):
 *  SA_JSON            ← کل محتوای JSON سرویس‌اکانت
 *  GCP_PROJECT_ID     ← مثلا facebook-ai-agent
 *  GCP_LOCATION       ← مثلا us-central1
 *  PAGE_ACCESS_TOKEN  ← توکن معتبر Page/System User
 *  VERIFY_TOKEN       ← توکن تأیید وبهوک
 *  USEDCONEX_API      ← https://api.usedconex.com
 * اختیاری:
 *  VERTEX_MODEL       ← پیش‌فرض gemini-1.5-pro
 */

"use strict";

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { GoogleAuth } = require("google-auth-library");

const app = express();
app.use(express.json({ limit: "2mb" }));

/* ---------- ADC setup: ساخت فایل creds از Secret ---------- */
(function setupADC() {
  const saJson = process.env.SA_JSON;
  if (saJson) {
    const dir = "/secrets";
    const p = path.join(dir, "sa.json");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, saJson);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = p;
    console.log("✅ GOOGLE_APPLICATION_CREDENTIALS ->", p);
  } else if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.warn("⚠️ SA_JSON not set and GOOGLE_APPLICATION_CREDENTIALS missing.");
  }
})();

/* ---------- Health/Root ---------- */
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

/* ---------- Webhook verification (GET) ---------- */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  console.error("❌ Failed verification", { mode, token_present: !!token });
  return res.sendStatus(403);
});

/* ---------- Message handler (POST) ---------- */
app.post("/webhook", async (req, res) => {
  try {
    for (const entry of req.body.entry || []) {
      for (const event of entry.messaging || []) {
        // جلوگیری از لوپ
        if (event.message?.is_echo) continue;

        const senderId = event.sender?.id;
        if (!senderId) continue;

        const messageText =
          event.message?.text ||
          event.postback?.payload ||
          event.postback?.title;
        if (!messageText) continue;

        try {
          // 1) اگر ZIP یافت شد → کوئوت UsedConex
          const zip = (messageText.match(/\b\d{5}\b/) || [])[0];
          if (zip) {
            const quote = await getUsedConexQuote(zip);
            const total =
              Number(quote?.totalPrice || 0) + Number(quote?.totalTransport || 0);
            await sendMessage(
              senderId,
              `Price for ZIP ${zip}: $${total.toFixed(2)}`
            );
            continue;
          }

          // 2) در غیر این صورت → پاسخ Gemini
          const reply = await generateAIResponse(messageText);
          await sendMessage(senderId, reply);
        } catch (innerErr) {
          console.error("Error handling single event:", {
            msg: innerErr?.message,
            data: innerErr?.response?.data,
            status: innerErr?.response?.status,
          });
          try {
            await sendMessage(
              senderId,
              "Sorry, I'm having trouble processing your request."
            );
          } catch (_) {}
        }
      }
    }
    // مهم: همیشه 200 بده تا فیس‌بوک retry سنگین نکند
    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", {
      msg: error?.message,
      data: error?.response?.data,
      status: error?.response?.status,
    });
    // باز هم 200 تا فیسبوک retry بی‌نهایت نکند
    return res.sendStatus(200);
  }
});

/* ---------- UsedConex Quote ---------- */
async function getUsedConexQuote(zip) {
  if (!process.env.USEDCONEX_API) throw new Error("USEDCONEX_API not set");
  let token;
  try {
    const loginRes = await axios.post(
      `${process.env.USEDCONEX_API}/client/v1/User/login/website`,
      {},
      { headers: { "Content-Type": "application/json" }, timeout: 15000 }
    );
    token = loginRes?.data?.data?.Token;
    if (!token) throw new Error("No token returned from login");
  } catch (e) {
    const d = e.response?.data;
    throw new Error(`UsedConex login failed: ${d?.message || e.message}`);
  }

  try {
    const quoteRes = await axios.post(
      `${process.env.USEDCONEX_API}/client/v1/Quote/create`,
      {
        zipcode: zip,
        isDelivery: true,
        items: [{ size: "20ft", condition: "cargo-worthy", quantity: 1 }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        timeout: 20000,
      }
    );
    const quote = quoteRes?.data?.data?.[0];
    if (!quote) throw new Error("No quote returned");
    return quote;
  } catch (e) {
    const d = e.response?.data;
    throw new Error(`Quote API failed: ${d?.message || e.message}`);
  }
}

/* ---------- Send message to Facebook ---------- */
async function sendMessage(recipientId, text) {
  try {
    await axios.post(
      "https://graph.facebook.com/v20.0/me/messages",
      {
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text: String(text).slice(0, 1900) },
      },
      {
        params: { access_token: process.env.PAGE_ACCESS_TOKEN },
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
      }
    );
  } catch (error) {
    console.error("Facebook API Error:", {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });
    throw error;
  }
}

/* ---------- Vertex AI (Gemini) via OAuth2 (بدون API Key) ---------- */
const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

async function generateAIResponse(prompt) {
  const project =
    process.env.VERTEX_PROJECT || process.env.GCP_PROJECT_ID || "facebook-ai-agent";
  const location =
    process.env.VERTEX_LOCATION || process.env.GCP_LOCATION || "us-central1";
  const model = process.env.VERTEX_MODEL || "gemini-1.5-pro";

  // Endpoint صحیح: generateContent (نه predict) و بدون ?key
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

  const client = await auth.getClient();
  const headers = await client.getRequestHeaders(); // شامل Authorization: Bearer <token>
  headers["Content-Type"] = "application/json";
  headers["x-goog-user-project"] = project; // مهم برای سهمیه/صورت‌حساب

  try {
    const { data } = await axios.post(
      url,
      { contents: [{ role: "user", parts: [{ text: prompt }] }] },
      { headers, timeout: 20000 }
    );

    const text =
      (data?.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || "")
        .join("")
        .trim() || "I couldn't generate a response.";
    return text;
  } catch (e) {
    console.error("Vertex AI Error:", {
      status: e.response?.status,
      data: e.response?.data,
      message: e.message,
    });
    return "I couldn't generate a response right now.";
  }
}

/* ---------- Start server ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
