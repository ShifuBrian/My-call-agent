"use strict";

const express = require("express");
const twilio = require("twilio");
const { ElevenLabsClient } = require("@elevenlabs/elevenlabs-js");

const ELEVENLABS_REGISTER_CALL_URL =
  "https://api.elevenlabs.io/v1/convai/twilio/register-call";
const RESEND_EMAIL_URL = "https://api.resend.com/emails";

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
  return twilio.validateRequest(
    requiredEnv("TWILIO_AUTH_TOKEN"),
    req.get("x-twilio-signature") || "",
    publicWebhookUrl(req),
    req.body
  );
}

async function verifyElevenLabsEvent(rawBody, signature, secret) {
  const client = new ElevenLabsClient();
  return client.webhooks.constructEvent(rawBody, signature, secret);
}

function resultValue(value) {
  if (value && typeof value === "object") {
    return value.value ?? value.result ?? value.data ?? JSON.stringify(value);
  }
  return value;
}

function formatCollectedData(results) {
  if (!results || typeof results !== "object" || !Object.keys(results).length) return "Geen";
  return Object.entries(results)
    .map(([key, value]) => `- ${key.replaceAll("_", " ")}: ${resultValue(value) ?? "Niet bekend"}`)
    .join("\n");
}

function findCollectedValue(results, names) {
  if (!results || typeof results !== "object") return "";
  const wanted = names.map((name) => name.toLowerCase());
  for (const [key, value] of Object.entries(results)) {
    if (wanted.includes(key.toLowerCase())) return String(resultValue(value) || "").trim();
  }
  return "";
}

function formatTranscript(transcript) {
  if (!Array.isArray(transcript) || !transcript.length) return "Geen transcript beschikbaar";
  return transcript
    .filter((turn) => turn && turn.message)
    .map((turn) => `${turn.role === "agent" ? "Fleur" : "Beller"}: ${turn.message}`)
    .join("\n\n");
}

function buildCallEmail(event) {
  const data = event.data || {};
  const analysis = data.analysis || {};
  const metadata = data.metadata || {};
  const collected = analysis.data_collection_results || {};
  const dynamic = data.conversation_initiation_client_data?.dynamic_variables || {};
  const callerName = findCollectedValue(collected, ["caller_name", "naam", "name"]);
  const callerNumber = dynamic.caller_number || dynamic.system__caller_id || "Onbekend nummer";
  const duration = metadata.call_duration_secs
    ? `${Math.round(Number(metadata.call_duration_secs))} seconden`
    : "Onbekend";
  const successful = analysis.call_successful;
  const outcome = successful === true ? "Geslaagd" : successful === false ? "Niet geslaagd" : "Niet beoordeeld";
  const summary = analysis.transcript_summary || "Geen automatische samenvatting beschikbaar";

  const text = [
    "Nieuwe telefonische boodschap voor Brian",
    "",
    `Naam beller: ${callerName || "Niet opgegeven"}`,
    `Telefoonnummer: ${callerNumber}`,
    `Gespreksduur: ${duration}`,
    `Resultaat: ${outcome}`,
    "",
    "SAMENVATTING",
    summary,
    "",
    "VERZAMELDE GEGEVENS",
    formatCollectedData(collected),
    "",
    "VOLLEDIG TRANSCRIPT",
    formatTranscript(data.transcript),
    "",
    `Conversation ID: ${data.conversation_id || "onbekend"}`
  ].join("\n");

  return {
    subject: `Nieuwe telefonische boodschap${callerName ? ` van ${callerName}` : ""}`,
    text
  };
}

function recipients(value) {
  return value.split(",").map((address) => address.trim()).filter(Boolean);
}

async function sendEmail(fetchImpl, event) {
  const email = buildCallEmail(event);
  const conversationId = event.data?.conversation_id || "unknown";
  const response = await fetchImpl(RESEND_EMAIL_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${requiredEnv("RESEND_API_KEY")}`,
      "content-type": "application/json",
      "idempotency-key": `call-notes-${conversationId}`.slice(0, 256)
    },
    body: JSON.stringify({
      from: requiredEnv("EMAIL_FROM"),
      to: recipients(requiredEnv("EMAIL_TO")),
      subject: email.subject,
      text: email.text
    }),
    signal: AbortSignal.timeout(10000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Resend antwoordde met ${response.status}: ${body.slice(0, 300)}`);
}

function createApp({ fetchImpl = global.fetch, verifyWebhookEvent = verifyElevenLabsEvent } = {}) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // Deze route moet vóór parsers staan: HMAC-controle vereist de exacte raw body.
  app.post("/elevenlabs/post-call", express.raw({ type: "application/json", limit: "2mb" }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const signature = req.get("elevenlabs-signature") || "";
    let event;

    try {
      if (!rawBody || !signature) return res.status(401).json({ error: "Ontbrekende webhook-handtekening" });
      event = await verifyWebhookEvent(rawBody, signature, requiredEnv("ELEVENLABS_WEBHOOK_SECRET"));
    } catch (error) {
      console.warn("ElevenLabs-webhook geweigerd:", error instanceof Error ? error.message : error);
      return res.status(401).json({ error: "Ongeldige webhook-handtekening" });
    }

    if (event.type !== "post_call_transcription") {
      return res.status(200).json({ received: true, ignored: "event_type" });
    }
    if (event.data?.agent_id !== requiredEnv("ELEVENLABS_AGENT_ID")) {
      return res.status(200).json({ received: true, ignored: "other_agent" });
    }

    try {
      await sendEmail(fetchImpl, event);
      console.log("Gespreksnotities verzonden voor", event.data?.conversation_id || "onbekend gesprek");
      return res.status(200).json({ received: true, emailed: true });
    } catch (error) {
      console.error("E-mail verzenden mislukt:", error instanceof Error ? error.message : error);
      return res.status(502).json({ error: "E-mail verzenden mislukt" });
    }
  });

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
      if (!fromNumber || !toNumber) return res.status(400).send(errorTwiml("De oproepgegevens zijn onvolledig."));

      const response = await fetchImpl(ELEVENLABS_REGISTER_CALL_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": requiredEnv("ELEVENLABS_API_KEY") },
        body: JSON.stringify({
          agent_id: requiredEnv("ELEVENLABS_AGENT_ID"),
          from_number: fromNumber,
          to_number: toNumber,
          direction: "inbound",
          conversation_initiation_client_data: { dynamic_variables: { caller_number: fromNumber } }
        }),
        signal: AbortSignal.timeout(10000)
      });

      const rawBody = await response.text();
      if (!response.ok) {
        console.error("ElevenLabs register-call fout", response.status, rawBody.slice(0, 500));
        return res.status(502).send(errorTwiml("Sorry, de assistent is nu niet bereikbaar. Probeer het later opnieuw."));
      }
      let twiml = rawBody;
      try {
        const parsed = JSON.parse(rawBody);
        if (typeof parsed === "string") twiml = parsed;
      } catch { /* Directe XML is ook geldig. */ }
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

module.exports = { createApp, buildCallEmail, errorTwiml, publicWebhookUrl };
