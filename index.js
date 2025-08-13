/** @format */
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// --- Healthcheck ---
app.get("/health", (_req, res) => res.status(200).send("ok"));

// --- Facebook Webhook Verification ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }
  console.error("Failed verification", { mode, token_present: !!token });
  return res.sendStatus(403);
});

// --- Message Handler ---
app.post("/webhook", async (req, res) => {
  try {
    // Meta ممکنه چند entry بده
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const messagingEvents = entry.messaging || [];
      for (const event of messagingEvents) {
        // نادیده بگیر echo/seen/delivery
        if (event.message?.is_echo) continue;

        const senderId = event.sender?.id;
        if (!senderId) continue;

        // متن پیام یا postback
        const messageText =
          event.message?.text ||
          event.postback?.payload ||
          event.postback?.title;

        if (!messageText) continue;

        try {
          // 1) اگر ZIP پیدا شد، قیمت UsedConex
          const zipMatch = messageText.match(/\b\d{5}\b/);
          if (zipMatch) {
            const zip = zipMatch[0];
            const quote = await getUsedConexQuote(zip);
            const total =
              Number(quote?.totalPrice || 0) + Number(quote?.totalTransport || 0);
            await sendMessage(
              senderId,
              `Price for ZIP ${zip}: $${total.toFixed(2)}`
            );
            continue;
          }

          // 2) در غیر اینصورت پاسخ Gemini
          const responseText = await generateAIResponse(messageText);
          await sendMessage(senderId, responseText);
        } catch (innerErr) {
          console.error("Error handling single event:", {
            msg: innerErr?.message,
            data: innerErr?.response?.data,
            status: innerErr?.response?.status,
          });
          // تلاش برای ارسال پیام خطا به کاربر
          try {
            await sendMessage(
              senderId,
              "Sorry, I'm having trouble processing your request."
            );
          } catch (_) {}
        }
      }
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", {
      msg: error?.message,
      data: error?.response?.data,
      status: error?.response?.status,
    });
    return res.sendStatus(500);
  }
});

// --- UsedConex Quote ---
async function getUsedConexQuote(zip) {
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

// --- Send message to Facebook ---
async function sendMessage(recipientId, text) {
  try {
    await axios.post(
      "https://graph.facebook.com/v20.0/me/messages",
      {
        recipient: { id: recipientId },
        messaging_type: "RESPONSE", // لازم برای Send API
        message: { text: String(text).slice(0, 2000) }, // حداکثر طول مناسب
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

// --- Vertex AI (Gemini) via REST ---
async function generateAIResponse(prompt) {
  const endpoint =
    process.env.VERTEX_ENDPOINT ||
    `https://us-central1-aiplatform.googleapis.com/v1/projects/${
      process.env.VERTEX_PROJECT || "facebook-ai-agent"
    }/locations/${
      process.env.VERTEX_LOCATION || "us-central1"
    }/publishers/google/models/gemini-1.5-pro:generateContent`;

  try {
    const { data } = await axios.post(
      `${endpoint}?key=${process.env.VERTEX_API_KEY}`,
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // در صورت نیاز: safetySettings، generationConfig
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 20000,
      }
    );

    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
      "I couldn't generate a response.";
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

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
