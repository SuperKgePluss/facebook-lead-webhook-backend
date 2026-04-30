require("dotenv").config();

const { fetchLeadDetail } = require("./services/facebook");
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
app.post("/webhook/facebook", async (req, res) => {
    try {
        console.log("Facebook webhook event received:");
        console.log(JSON.stringify(req.body, null, 2));

        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];

        if (change?.field === "leadgen") {
            const leadgenId = change.value?.leadgen_id;

            console.log("Leadgen ID:", leadgenId);

            if (leadgenId) {
                let lead = null;

                try {
                    const leadData = await fetchLeadDetail(leadgenId);

                    console.log("=== LEAD DETAIL ===");
                    console.log(JSON.stringify(leadData, null, 2));

                    lead = {
                        name: "Facebook Lead",
                        phone: "",
                    };
                } catch (err) {
                    console.warn("Fetch lead detail failed, using mock lead:", err.message);

                    lead = {
                        name: "Mock Facebook Lead",
                        phone: "0899999999",
                    };
                }

                const { appendLeadToSheet } = require("./services/googleSheets");
                await appendLeadToSheet(lead);
            }
        }

        return res.sendStatus(200);
    } catch (err) {
        console.error("Webhook error:", err.message);
        return res.sendStatus(200);
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});