const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { VertexAI } = require('@google-cloud/vertexai');
require("dotenv").config();

// Configuration
const {
  VERIFY_TOKEN,
  PAGE_ACCESS_TOKEN,
  GCLOUD_PROJECT,
  VERTEX_LOCATION = "us-central1",
  USEDCONEX_API = "https://api.usedconex.com",
  ZIP_URL = "/client/v1/Order/zip",
  QUOTE_URL = "/client/v1/Quote/create",
} = process.env;

// Initialize Vertex AI
const vertexAI = new VertexAI({
  project: GCLOUD_PROJECT,
  location: VERTEX_LOCATION,
});
const model = vertexAI.getGenerativeModel({ model: "gemini-1.5-pro" });

// Tools for function calling
const tools = [
  {
    functionDeclarations: [
      {
        name: "get_zip_info",
        description: "Validate a US ZIP code and get depot information",
        parameters: {
          type: "OBJECT",
          properties: {
            zipcode: { 
              type: "STRING", 
              description: "5-digit US ZIP code" 
            },
          },
          required: ["zipcode"],
        },
      },
      {
        name: "get_container_quote",
        description: "Get a shipping container quote for a given ZIP code",
        parameters: {
          type: "OBJECT",
          properties: {
            zipcode: { 
              type: "STRING",
              description: "5-digit US ZIP code for delivery" 
            },
            size: { 
              type: "STRING",
              description: "Container size (20ft or 40ft)",
              enum: ["20ft", "40ft"],
              default: "20ft"
            },
            condition: { 
              type: "STRING",
              description: "Container condition",
              enum: ["cargo-worthy", "wind-water-tight"],
              default: "cargo-worthy"
            },
            quantity: { 
              type: "NUMBER",
              description: "Number of containers",
              default: 1
            },
          },
          required: ["zipcode"],
        },
      },
    ],
  },
];

const app = express();
app.use(bodyParser.json());

/* ----------------- UsedConex API Helpers ----------------- */
async function getAuthToken() {
  try {
    const response = await axios.post(
      `${USEDCONEX_API}/client/v1/User/login/website`,
      {},
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );
    return response?.data?.data?.Token;
  } catch (error) {
    console.error("Login error:", error.message);
    throw new Error("Failed to authenticate with UsedConex API");
  }
}

async function getQuote({ zipcode, size = "20ft", condition = "cargo-worthy", quantity = 1 }) {
  try {
    const token = await getAuthToken();
    const response = await axios.post(
      `${USEDCONEX_API}${QUOTE_URL}`,
      {
        zipcode,
        isDelivery: true,
        items: [{ size, condition, quantity }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        timeout: 15000,
      }
    );
    
    return response.data?.data || response.data;
  } catch (error) {
    console.error("Quote error:", error.response?.data || error.message);
    throw new Error("Failed to get quote");
  }
}

/* ----------------- Messenger Helpers ----------------- */
async function sendMessage(recipientId, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/me/messages`,
      {
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text: message },
      },
      {
        params: { access_token: PAGE_ACCESS_TOKEN },
        timeout: 10000,
      }
    );
  } catch (error) {
    console.error("Messenger send error:", error.response?.data || error.message);
  }
}

/* ----------------- Webhook Endpoints ----------------- */
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && 
      req.query["hub.verify_token"] === VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  try {
    if (req.body.object !== "page") return res.sendStatus(200);

    for (const entry of req.body.entry || []) {
      const event = entry.messaging?.[0];
      if (!event?.message || !event?.sender?.id) continue;

      const senderId = event.sender.id;
      const messageText = event.message.text.trim();

      // System prompt for Gemini
      const systemPrompt = `
        You are a helpful sales assistant for UsedConex shipping containers.
        Your task is to help customers get price quotes for shipping containers.
        
        Rules:
        1. Always ask for a 5-digit US ZIP code if not provided
        2. For price inquiries, call get_container_quote with the ZIP code
        3. Keep responses friendly and professional
        4. Prices include delivery to the provided ZIP code
        5. Default container is 20ft cargo-worthy (1 unit)
        
        Example responses:
        - "Please provide a 5-digit ZIP code for delivery."
        - "Here's your quote for 20ft container to ZIP 12345: $X (including delivery)"
      `;

      // Prepare conversation history
      let conversation = [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "user", parts: [{ text: messageText }] },
      ];

      let finalResponse = null;

      // Allow up to 3 steps for function calling
      for (let step = 0; step < 3; step++) {
        const result = await model.generateContent({ 
          tools, 
          contents: conversation 
        });
        
        const response = result.response;
        const textParts = response?.candidates?.[0]?.content?.parts || [];
        const toolCalls = textParts.filter(p => p.functionCall);

        if (toolCalls.length === 0) {
          // No function calls - we have our final response
          finalResponse = textParts.map(p => p.text).join(" ").trim();
          break;
        }

        // Process function calls
        const functionCall = toolCalls[0].functionCall;
        const args = functionCall.args || {};

        if (functionCall.name === "get_container_quote") {
          try {
            // Validate ZIP code
            const zipcode = (args.zipcode || "").toString().trim();
            if (!/^\d{5}$/.test(zipcode)) {
              await sendMessage(senderId, "Please provide a valid 5-digit ZIP code.");
              break;
            }

            // Get quote from API
            const quoteData = await getQuote({
              zipcode,
              size: args.size || "20ft",
              condition: args.condition || "cargo-worthy",
              quantity: Number(args.quantity || 1),
            });

            // Format the response
            if (!quoteData || !quoteData.length) {
              finalResponse = "Sorry, we don't have availability for that location.";
              break;
            }

            const quote = quoteData[0];
            const totalPrice = (quote.totalPrice + quote.totalTransport).toFixed(2);
            
            finalResponse = `Here's your quote for a ${args.size || "20ft"} container ` +
                           `delivered to ${zipcode}: $${totalPrice} (including delivery).`;
            
          } catch (error) {
            console.error("Quote processing error:", error);
            finalResponse = "Sorry, I couldn't get a quote right now. Please try again later.";
          }
          break;
        }

        // Handle other function calls if needed
        conversation.push({
          role: "model",
          parts: [{ functionCall }],
        });
      }

      if (finalResponse) {
        await sendMessage(senderId, finalResponse);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});