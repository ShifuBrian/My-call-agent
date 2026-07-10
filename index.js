"use strict";

const express = require("express");
const twilio = require("twilio");

const ELEVENLABS_REGISTER_CALL_URL =
  "https://api.elevenlabs.io/v1/convai/twilio/register-call";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Ontbrekende omgevingsvariabele: ${name}`);
  return value;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function errorTwiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="nl-NL">${xmlEscape(message)}</Say><Hangup/></Response>`;
}

function publicWebhookUrl(req) {
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  return base ? `${base}${req.originalUrl}` : `${req.protocol}://${req.get("host")}${req.originalUrl}`;
}

function validateTwilioRequest(req) {
  if (process.env.SKIP_TWILIO_SIGNATURE_VALIDATION === "true") return true;
  const signature = req.get("x-twilio-signature") || "";
  return twilio.validateRequest(
    requiredEnv("TWILIO_AUTH_TOKEN"),
    signature,
    publicWebhookUrl(req),
    req.body
  );
}

function createApp({ fetchImpl = global.fetch } = {}) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));

  app.get("/", (_req, res) => res.status(200).json({ service: "my-call-agent", status: "ok" }));
  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

  app.post("/twilio/inbound", async (req, res) => {
    res.type("application/xml");

    try {
      if (!validateTwilioRequest(req)) {
        console.warn("Twilio-webhook geweigerd: ongeldige handtekening");
        return res.status(403).send(errorTwiml("Deze oproep kon niet worden geverifieerd."));
      }

      const fromNumber = String(req.body.From || "").trim();
      const toNumber = String(req.body.To || "").trim();
      if (!fromNumber || !toNumber) {
        return res.status(400).send(errorTwiml("De oproepgegevens zijn onvolledig."));
      }

      const response = await fetchImpl(ELEVENLABS_REGISTER_CALL_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "xi-api-key": requiredEnv("ELEVENLABS_API_KEY")
        },
        body: JSON.stringify({
          agent_id: requiredEnv("ELEVENLABS_AGENT_ID"),
          from_number: fromNumber,
          to_number: toNumber,
          direction: "inbound",
          conversation_initiation_client_data: {
            dynamic_variables: { caller_number: fromNumber }
          }
        }),
        signal: AbortSignal.timeout(10000)
      });

      const rawBody = await response.text();
      if (!response.ok) {
        console.error("ElevenLabs register-call fout", response.status, rawBody.slice(0, 500));
        return res.status(502).send(errorTwiml("Sorry, de assistent is nu niet bereikbaar. Probeer het later opnieuw."));
      }

      // De REST API retourneert de TwiML als JSON-string of als directe XML.
      let twiml = rawBody;
      try {
        const parsed = JSON.parse(rawBody);
        if (typeof parsed === "string") twiml = parsed;
      } catch {
        // Directe XML is eveneens geldig.
      }
      if (!twiml.includes("<Response")) throw new Error("ElevenLabs gaf geen geldige TwiML terug");

      return res.status(200).send(twiml);
    } catch (error) {
      console.error("Inbound-call fout", error instanceof Error ? error.message : error);
      return res.status(500).send(errorTwiml("Sorry, er ging iets mis. Probeer het later opnieuw."));
    }
  });

  app.use((_req, res) => res.status(404).json({ error: "Niet gevonden" }));
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 10000);
  createApp().listen(port, "0.0.0.0", () => console.log(`Luistert op poort ${port}`));
}

module.exports = { createApp, errorTwiml, publicWebhookUrl };
