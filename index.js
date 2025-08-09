const express = require("express");
const axios = require("axios");
const { VertexAI } = require("@google-cloud/vertexai");

const app = express();
app.use(express.json());

// Initialize Vertex AI
const vertexAI = new VertexAI({
  project: "facebook-ai-agent",
  location: "us-central1",
  apiEndpoint: process.env.VERTEX_ENDPOINT
});

const model = vertexAI.getGenerativeModel({
  model: "gemini-1.5-pro",
  safetySettings: {
    harassment: "BLOCK_NONE",
    hate: "BLOCK_NONE",
    sexual: "BLOCK_NONE",
    dangerous: "BLOCK_NONE"
  }
});

// Webhook verification
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" &&
      req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

// Message handling
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body.entry?.[0]?.messaging?.[0];
    if (!event) return res.sendStatus(200);

    const senderId = event.sender.id;
    const messageText = event.message?.text;

    if (messageText) {
      const response = await handleMessage(messageText);
      await sendMessage(senderId, response);
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error("Error:", error);
    res.sendStatus(500);
  }
});

async function handleMessage(text) {
  try {
    // Extract ZIP code
    const zipMatch = text.match(/\b\d{5}\b/);
    if (zipMatch) {
      const zip = zipMatch[0];
      const quote = await getUsedConexQuote(zip);
      return `Price for ZIP ${zip}: $${quote.totalPrice + quote.totalTransport}`;
    }

    // Default AI response
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text }] }]
    });
    return result.response.candidates[0].content.parts[0].text;
    
  } catch (error) {
    console.error("Error handling message:", error);
    return "Sorry, I couldn't process your request.";
  }
}

async function getUsedConexQuote(zip) {
  const token = await axios.post(
    `${process.env.USEDCONEX_API}/client/v1/User/login/website`,
    {},
    { headers: { "Content-Type": "application/json" } }
  ).then(res => res.data.data.Token);

  const quote = await axios.post(
    `${process.env.USEDCONEX_API}/client/v1/Quote/create`,
    {
      zipcode: zip,
      isDelivery: true,
      items: [{ size: "20ft", condition: "cargo-worthy", quantity: 1 }]
    },
    { headers: { Authorization: `Bearer ${token}` } }
  ).then(res => res.data.data[0]);

  return quote;
}

async function sendMessage(recipientId, text) {
  await axios.post(
    `https://graph.facebook.com/v20.0/me/messages`,
    {
      recipient: { id: recipientId },
      message: { text }
    },
    { params: { access_token: process.env.PAGE_ACCESS_TOKEN } }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));