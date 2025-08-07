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

app.post('/webhook', async (req, res) => {
  try {
    if (req.body.object !== 'page') return res.sendStatus(404);

    for (const entry of req.body.entry || []) {
      const event = entry.messaging?.[0];
      if (!event?.sender?.id) continue;

      const senderId = event.sender.id;
      const userText = event.message?.text || '';

      // دستورالعمل: اول ZIP رو چک کن، بعد اگر معتبر بود quote بگیر
      const systemPrompt = [
        'You are a helpful sales assistant for shipping containers.',
        'If the user provides a ZIP, first call get_zip_info to validate/resolve it.',
        'If the ZIP is valid and they ask for price/availability, call get_quote.',
        'If no ZIP is found, ask politely for a 5-digit ZIP code.',
        'Reply in clear, friendly English.'
      ].join('\n');

      // گام 1: از مدل بخواهیم تصمیم بگیرد چه ابزاری لازم است
      let convo = [
        { role: 'user', parts: [{ text: systemPrompt }] },
        { role: 'user', parts: [{ text: userText }] }
      ];

      let finalReply = null;
      for (let step = 0; step < 3; step++) { // حداکثر 3 بار چرخه tool-call
        const result = await model.generateContent({ tools, contents: convo });
        const resp = result.response;
        const parts = resp?.candidates?.[0]?.content?.parts || [];
        const toolCalls = parts.filter(p => p.functionCall);

        if (!toolCalls.length) {
          // هیچ ابزاری لازم نشد → جواب نهایی
          finalReply = parts.map(p => p.text).filter(Boolean).join(' ').trim();
          break;
        }

        // تنها یک call در هر مرحله پردازش می‌کنیم (کافیه)
        const call = toolCalls[0].functionCall;
        const args = call.args || {};

        if (call.name === 'get_zip_info') {
          const zip = (args.zipcode || '').toString().trim();
          if (!/^\d{5}$/.test(zip)) {
            await sendText(senderId, 'Please provide a valid 5-digit ZIP code.');
            finalReply = null; break;
          }
          let toolResp;
          try {
            toolResp = await ucZipLookup(zip);
          } catch (e) {
            console.error('ZIP lookup error:', e?.response?.data || e.message);
            await sendText(senderId, `I couldn’t validate that ZIP right now. Please try again shortly.`);
            finalReply = null; break;
          }

          // پاسخ ابزار را به مدل می‌دهیم تا مرحله بعدی (مثلاً get_quote) را درخواست کند
          convo.push({
            role: 'tool',
            parts: [{
              functionResponse: {
                name: 'get_zip_info',
                response: { name: 'get_zip_info', content: toolResp }
              }
            }]
          });
          continue;
        }

        if (call.name === 'get_quote') {
          const zip = (args.zipcode || '').toString().trim();
          if (!/^\d{5}$/.test(zip)) {
            await sendText(senderId, 'Please provide a valid 5-digit ZIP code.');
            finalReply = null; break;
          }

          let quoteResult;
          try {
            quoteResult = await ucQuote({
              zipcode: zip,
              isDelivery: args.isDelivery !== undefined ? !!args.isDelivery : true,
              size: args.size || '20ft',
              condition: args.condition || 'cargo-worthy',
              quantity: Number(args.quantity || 1)
            });
          } catch (e) {
            console.error('UC quote error:', e?.response?.data || e.message);
            await sendText(senderId, `Sorry, I couldn't retrieve a quote right now. Please try again in a moment.`);
            finalReply = null; break;
          }

          // «خروجی quote» را هم به مدل بده تا متن پاسخ نهایی را بسازد
          const composed = await model.generateContent({
            tools, contents: [
              { role: 'user', parts: [{ text: userText }] },
              { role: 'tool', parts: [{ functionResponse: { name: 'get_quote', response: { name: 'get_quote', content: quoteResult } } }] }
            ]
          });

          finalReply =
            composed?.response?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join(' ').trim()
            || `Here is your quote for ZIP ${zip}.`;
          break;
        }

        // ابزار ناشناخته
        await sendText(senderId, `Sorry, I can’t do that yet.`);
        finalReply = null; break;
      }

      if (finalReply) {
        await sendText(senderId, finalReply);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});


app.listen(3000, () => {
  console.log("Webhook server running on port 3000");
});
