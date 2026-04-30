require("dotenv").config();

const express = require("express");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;

// Health check
app.get("/health", (req, res) => {
    return res.status(200).send("OK");
});

// Facebook Webhook Verify
app.get("/webhook/facebook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    console.log("Facebook verify request:", {
        mode,
        token,
        challenge,
    });

    if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
        console.log("Facebook webhook verified");
        return res.status(200).send(challenge);
    }

    console.warn("Facebook webhook verification failed");
    return res.sendStatus(403);
});

// Facebook Webhook Receiver
app.post("/webhook/facebook", (req, res) => {
    console.log("Facebook webhook event received:");
    console.log(JSON.stringify(req.body, null, 2));

    return res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});