const express = require("express");
const axios = require("axios");
const { VertexAI } = require("@google-cloud/vertexai");

const app = express();
app.use(express.json());

// Initialize Vertex AI with API Key
const vertexAI = new VertexAI({
  project: "facebook-ai-agent",
  location: "us-central1",
  apiEndpoint: process.env.VERTEX_ENDPOINT,
  googleAuthOptions: {
    credentials: {
      client_email: "api-key@project.iam.gserviceaccount.com", // dummy email
      private_key: process.env.VERTEX_API_KEY
    }
  }
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

// Facebook Webhook Verification
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" &&
      req.query["hub.verify_token"] === process.env.VERTIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    console.error("Failed verification");
    res.sendStatus(403);
  }
});

// Message Handler
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body.entry?.[0]?.messaging?.[0];
    if (!event) return res.sendStatus(200);

    const senderId = event.sender.id;
    const messageText = event.message?.text;

    if (messageText) {
      try {
        // Try to get ZIP code
        const zipMatch = messageText.match(/\b\d{5}\b/);
        if (zipMatch) {
          const zip = zipMatch[0];
          const quote = await getUsedConexQuote(zip);
          await sendMessage(senderId, `Price for ZIP ${zip}: $${quote.totalPrice + quote.totalTransport}`);
          return res.sendStatus(200);
        }

        // Fallback to AI response
        const result = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: messageText }] }]
        });
        const responseText = result.response.candidates[0].content.parts[0].text;
        await sendMessage(senderId, responseText);
      } catch (error) {
        console.error("Error handling message:", error);
        await sendMessage(senderId, "Sorry, I'm having trouble processing your request.");
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

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
    { 
      headers: { 
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}` 
      }
    }
  ).then(res => res.data.data[0]);

  return quote;
}

async function sendMessage(recipientId, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/me/messages`,
      {
        recipient: { id: recipientId },
        message: { text: text }
      },
      { 
        params: { access_token: process.env.PAGE_ACCESS_TOKEN },
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch (error) {
    console.error("Facebook API Error:", error.response?.data || error.message);
    throw error;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));