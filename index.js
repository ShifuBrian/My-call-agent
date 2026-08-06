"use strict";

const crypto = require("node:crypto");
const express = require("express");
const twilio = require("twilio");
const { ElevenLabsClient } = require("@elevenlabs/elevenlabs-js");

const ELEVENLABS_REGISTER_CALL_URL = "https://api.elevenlabs.io/v1/convai/twilio/register-call";
const ELEVENLABS_OUTBOUND_CALL_URL = "https://api.elevenlabs.io/v1/convai/twilio/outbound-call";
const RESEND_EMAIL_URL = "https://api.resend.com/emails";
const CSRF_TTL_MS = 30 * 60 * 1000;
const MAX_CSRF_TOKENS = 500;
const MAX_RATE_LIMIT_CLIENTS = 1000;

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Ontbrekende omgevingsvariabele: ${name}`);
  return value;
}

function optionalEnv(name) {
  return process.env[name]?.trim() || "";
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function errorTwiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="nl-NL">${xmlEscape(message)}</Say><Hangup/></Response>`;
}

function publicWebhookUrl(req) {
  const base = optionalEnv("PUBLIC_BASE_URL").replace(/\/$/, "");
  return base ? `${base}${req.originalUrl}` : `${req.protocol}://${req.get("host")}${req.originalUrl}`;
}

function validateTwilioRequest(req) {
  if (process.env.NODE_ENV !== "production" && process.env.SKIP_TWILIO_SIGNATURE_VALIDATION === "true") return true;
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
    // ElevenLabs data-collection objects can also contain technical fields such
    // as `json_schema` and `rationale`. Those must never end up in the report.
    if (Object.prototype.hasOwnProperty.call(value, "value")) return value.value;
    if (Object.prototype.hasOwnProperty.call(value, "result")) return value.result;
    if (Object.prototype.hasOwnProperty.call(value, "data")) return value.data;
    return null;
  }
  return value;
}

function emailValue(value) {
  const resolved = resultValue(value);
  if (resolved === null || resolved === undefined) return "Onbekend";
  if (typeof resolved === "string" && !resolved.trim()) return "Onbekend";
  if (typeof resolved === "object") return "Onbekend";
  return String(resolved);
}

function formatCollectedData(results) {
  if (!results || typeof results !== "object" || !Object.keys(results).length) return "Onbekend";
  return Object.entries(results)
    .map(([key, value]) => `- ${key.replaceAll("_", " ")}: ${emailValue(value)}`)
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

function safeSubjectPart(value, fallback) {
  const text = String(value || "").replace(/[\r\n\0]+/g, " ").trim();
  return (text || fallback).slice(0, 120);
}

function storeCsrfToken(tokens, token, now = Date.now()) {
  for (const [key, expires] of tokens) {
    if (expires < now) tokens.delete(key);
  }
  while (tokens.size >= MAX_CSRF_TOKENS) tokens.delete(tokens.keys().next().value);
  tokens.set(token, now + CSRF_TTL_MS);
}

function formatTranscript(transcript, outbound = false) {
  if (!Array.isArray(transcript) || !transcript.length) return "Geen transcript beschikbaar";
  return transcript
    .filter((turn) => turn && turn.message)
    .map((turn) => `${turn.role === "agent" ? "Fleur" : outbound ? "Ontvanger" : "Beller"}: ${turn.message}`)
    .join("\n\n");
}

function dynamicVariables(data) {
  return data.conversation_initiation_client_data?.dynamic_variables || {};
}

function isOutboundEvent(event) {
  const dynamic = dynamicVariables(event.data || {});
  return event.data?.agent_id === optionalEnv("ELEVENLABS_OUTBOUND_AGENT_ID") || dynamic.call_type === "message_delivery";
}

function buildCallEmail(event) {
  const data = event.data || {};
  const analysis = data.analysis || {};
  const metadata = data.metadata || {};
  const collected = analysis.data_collection_results || {};
  const dynamic = dynamicVariables(data);
  const outbound = isOutboundEvent(event);
  const callerName = findCollectedValue(collected, ["caller_name", "naam", "name"]);
  const callerNumber = dynamic.caller_number || dynamic.system__caller_id || "Onbekend nummer";
  const recipientName = safeSubjectPart(dynamic.recipient_name, "Niet opgegeven");
  const duration = Number.isFinite(Number(metadata.call_duration_secs))
    ? `${Math.round(Number(metadata.call_duration_secs))} seconden`
    : "Onbekend";
  const successful = analysis.call_successful;
  const outcome = successful === true ? "Geslaagd" : successful === false ? "Niet geslaagd" : "Niet beoordeeld";
  const dutchSummary = findCollectedValue(collected, ["email_summary_nl", "samenvatting_nl", "summary_nl"]);
  const summary = dutchSummary || analysis.transcript_summary || "Geen automatische samenvatting beschikbaar";

  if (outbound) {
    return {
      subject: `Verslag uitgaande Fleur-oproep aan ${recipientName}`,
      text: [
        "Verslag van een uitgaande oproep door Fleur",
        "",
        `Ontvanger: ${recipientName}`,
        `Opdracht-ID: ${dynamic.task_id || "Onbekend"}`,
        `Gespreksduur: ${duration}`,
        `Resultaat: ${outcome}`,
        "",
        "OPGEDRAGEN BOODSCHAP",
        dynamic.message || "Niet beschikbaar",
        "",
        "EVENTUELE VRAAG",
        dynamic.question || "Geen vraag meegegeven",
        "",
        "SAMENVATTING",
        summary,
        "",
        "VERZAMELDE GEGEVENS",
        formatCollectedData(collected),
        "",
        "VOLLEDIG TRANSCRIPT",
        formatTranscript(data.transcript, true),
        "",
        `Conversation ID: ${data.conversation_id || "onbekend"}`
      ].join("\n")
    };
  }

  return {
    subject: `Nieuwe telefonische boodschap${callerName ? ` van ${safeSubjectPart(callerName, "onbekende beller")}` : ""}`,
    text: [
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
    ].join("\n")
  };
}

function recipients(value) {
  return value.split(",").map((address) => address.trim()).filter(Boolean);
}

async function sendEmail(fetchImpl, event) {
  const email = buildCallEmail(event);
  const conversationId = event.data?.conversation_id || crypto.randomUUID();
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

function parseContacts() {
  let parsed;
  try {
    parsed = JSON.parse(requiredEnv("OUTBOUND_CONTACTS_JSON"));
  } catch {
    throw new Error("OUTBOUND_CONTACTS_JSON bevat geen geldige JSON");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("OUTBOUND_CONTACTS_JSON moet een JSON-object zijn");
  }
  const contacts = Object.entries(parsed).map(([id, contact]) => {
    const value = typeof contact === "string" ? { name: id, number: contact } : contact;
    if (!/^[a-z0-9_-]{1,40}$/i.test(id) || !value || typeof value.name !== "string" || !/^\+[1-9]\d{7,14}$/.test(value.number || "")) {
      throw new Error(`Ongeldig contact in OUTBOUND_CONTACTS_JSON: ${id}`);
    }
    return { id, name: value.name.trim().slice(0, 80), number: value.number };
  });
  if (!contacts.length) throw new Error("OUTBOUND_CONTACTS_JSON bevat geen contacten");
  return contacts;
}

function authenticateBasic(req) {
  const header = req.get("authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); } catch { return false; }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return safeEqual(username, optionalEnv("OUTBOUND_USERNAME") || "brian") && safeEqual(password, requiredEnv("OUTBOUND_COMMAND_SECRET"));
}

function basicAuth(req, res, next) {
  try {
    if (authenticateBasic(req)) return next();
  } catch (error) {
    console.error("Outbound-authenticatie niet geconfigureerd:", error.message);
    return res.status(503).send("Outbound-functie is niet geconfigureerd.");
  }
  res.set("WWW-Authenticate", 'Basic realm="Fleur Outbound", charset="UTF-8"');
  return res.status(401).send("Inloggen vereist.");
}

function bearerAuth(req, res, next) {
  try {
    const supplied = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (supplied && safeEqual(supplied, requiredEnv("OUTBOUND_COMMAND_SECRET"))) return next();
  } catch (error) {
    console.error("Outbound-authenticatie niet geconfigureerd:", error.message);
    return res.status(503).json({ error: "Outbound-functie is niet geconfigureerd" });
  }
  return res.status(401).json({ error: "Ongeldige toegangscode" });
}

function cleanText(value, field, maxLength, required = true) {
  const text = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (required && !text) throw new Error(`${field} is verplicht`);
  if (text.length > maxLength) throw new Error(`${field} mag maximaal ${maxLength} tekens bevatten`);
  return text;
}

function outboundPage({ contacts = [], csrfToken = "", notice = "", error = "" }) {
  const options = contacts.map((contact) => `<option value="${htmlEscape(contact.id)}">${htmlEscape(contact.name)}</option>`).join("");
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fleur laten bellen</title><style>body{font-family:system-ui,sans-serif;max-width:680px;margin:32px auto;padding:0 18px;color:#172033}form{display:grid;gap:14px}label{font-weight:650}select,textarea,input,button{font:inherit;padding:12px;border:1px solid #aab3c2;border-radius:9px}textarea{min-height:120px}button{background:#172033;color:#fff;border:0;font-weight:700}.ok{background:#e8f7ec;padding:12px;border-radius:9px}.error{background:#fdecec;padding:12px;border-radius:9px}</style></head><body><h1>Fleur laten bellen</h1><p>Kies een goedgekeurd contact en geef de boodschap door. Fleur belt namens Brian en je ontvangt na afloop een e-mailverslag.</p>${notice ? `<p class="ok">${htmlEscape(notice)}</p>` : ""}${error ? `<p class="error">${htmlEscape(error)}</p>` : ""}<form method="post" action="/outbound"><input type="hidden" name="csrf_token" value="${htmlEscape(csrfToken)}"><label>Ontvanger<select name="contact_id" required>${options}</select></label><label>Boodschap<textarea name="message" maxlength="1000" required></textarea></label><label>Vraag aan de ontvanger (optioneel)<textarea name="question" maxlength="500"></textarea></label><button type="submit">Laat Fleur bellen</button></form></body></html>`;
}

async function startOutboundCall(fetchImpl, input) {
  if (optionalEnv("OUTBOUND_ENABLED").toLowerCase() !== "true") throw new Error("Uitgaande oproepen zijn uitgeschakeld");
  const contacts = parseContacts();
  const contact = contacts.find((item) => item.id === input.contactId);
  if (!contact) throw new Error("Dit contact staat niet op de toegestane contactenlijst");
  const message = cleanText(input.message, "Boodschap", 1000);
  const question = cleanText(input.question, "Vraag", 500, false);
  const taskId = crypto.randomUUID();
  const openingMessage = `Hallo ${contact.name}, je spreekt met Fleur, de assistent van Brian. Ik bel om namens Brian een boodschap door te geven.`;
  const response = await fetchImpl(ELEVENLABS_OUTBOUND_CALL_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": requiredEnv("ELEVENLABS_API_KEY") },
    body: JSON.stringify({
      agent_id: requiredEnv("ELEVENLABS_OUTBOUND_AGENT_ID"),
      agent_phone_number_id: requiredEnv("ELEVENLABS_PHONE_NUMBER_ID"),
      to_number: contact.number,
      conversation_initiation_client_data: {
        dynamic_variables: {
          call_type: "message_delivery",
          recipient_name: contact.name,
          opening_message: openingMessage,
          message,
          question,
          task_id: taskId
        }
      }
    }),
    signal: AbortSignal.timeout(15000)
  });
  const rawBody = await response.text();
  let body;
  try { body = JSON.parse(rawBody); } catch { body = {}; }
  if (!response.ok || body.success === false) {
    console.error("ElevenLabs outbound-call fout", response.status, rawBody.slice(0, 500));
    throw new Error("ElevenLabs kon de oproep niet starten");
  }
  return { taskId, conversationId: body.conversation_id || null, callSid: body.callSid || null, contactName: contact.name };
}

function createRateLimiter() {
  const calls = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000;
    const limit = Math.max(1, Math.min(50, Number(optionalEnv("OUTBOUND_MAX_CALLS_PER_HOUR") || 5)));
    for (const [client, timestamps] of calls) {
      const active = timestamps.filter((time) => now - time < windowMs);
      if (active.length) calls.set(client, active);
      else calls.delete(client);
    }
    while (calls.size >= MAX_RATE_LIMIT_CLIENTS) calls.delete(calls.keys().next().value);
    const key = req.ip || "unknown";
    const recent = calls.get(key) || [];
    if (recent.length >= limit) {
      res.set("Retry-After", String(Math.ceil((windowMs - (now - recent[0])) / 1000)));
      return res.status(429).json({ error: "Te veel oproepen gestart; probeer het later opnieuw" });
    }
    recent.push(now);
    calls.set(key, recent);
    return next();
  };
}

function createApp({ fetchImpl = global.fetch, verifyWebhookEvent = verifyElevenLabsEvent } = {}) {
  const app = express();
  const csrfTokens = new Map();
  const outboundRateLimit = createRateLimiter();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
    });
    next();
  });

  // Deze route moet voor de bodyparsers staan: HMAC-controle vereist de exacte raw body.
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

    if (event.type !== "post_call_transcription") return res.status(200).json({ received: true, ignored: "event_type" });
    const allowedAgentIds = [optionalEnv("ELEVENLABS_AGENT_ID"), optionalEnv("ELEVENLABS_OUTBOUND_AGENT_ID")].filter(Boolean);
    if (!allowedAgentIds.includes(event.data?.agent_id)) return res.status(200).json({ received: true, ignored: "other_agent" });

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
  app.use(express.json({ limit: "32kb" }));
  app.get("/", (_req, res) => res.status(200).json({ service: "my-call-agent", status: "ok" }));
  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

  app.get("/outbound", basicAuth, (_req, res) => {
    try {
      const token = crypto.randomBytes(32).toString("base64url");
      storeCsrfToken(csrfTokens, token);
      res.set({ "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
      return res.type("html").send(outboundPage({ contacts: parseContacts(), csrfToken: token }));
    } catch (error) {
      return res.status(503).send(htmlEscape(error.message));
    }
  });

  app.post("/outbound", basicAuth, outboundRateLimit, async (req, res) => {
    const expires = csrfTokens.get(String(req.body.csrf_token || ""));
    csrfTokens.delete(String(req.body.csrf_token || ""));
    if (!expires || expires < Date.now()) return res.status(403).send("Formulier verlopen. Open de pagina opnieuw.");
    try {
      const result = await startOutboundCall(fetchImpl, { contactId: req.body.contact_id, message: req.body.message, question: req.body.question });
      const token = crypto.randomBytes(32).toString("base64url");
      storeCsrfToken(csrfTokens, token);
      return res.type("html").send(outboundPage({ contacts: parseContacts(), csrfToken: token, notice: `De oproep aan ${result.contactName} is gestart.` }));
    } catch (error) {
      const token = crypto.randomBytes(32).toString("base64url");
      storeCsrfToken(csrfTokens, token);
      return res.status(400).type("html").send(outboundPage({ contacts: parseContacts(), csrfToken: token, error: error.message }));
    }
  });

  app.post("/api/outbound-call", bearerAuth, outboundRateLimit, async (req, res) => {
    try {
      const result = await startOutboundCall(fetchImpl, { contactId: req.body.contact_id, message: req.body.message, question: req.body.question });
      return res.status(202).json({ started: true, ...result });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.post("/twilio/inbound", async (req, res) => {
    res.type("application/xml");
    try {
      if (!validateTwilioRequest(req)) return res.status(403).send(errorTwiml("Deze oproep kon niet worden geverifieerd."));
      const fromNumber = String(req.body.From || "").trim();
      const toNumber = String(req.body.To || "").trim();
      if (!fromNumber || !toNumber) return res.status(400).send(errorTwiml("De oproepgegevens zijn onvolledig."));
      const response = await fetchImpl(ELEVENLABS_REGISTER_CALL_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": requiredEnv("ELEVENLABS_API_KEY") },
        body: JSON.stringify({
          agent_id: requiredEnv("ELEVENLABS_AGENT_ID"), from_number: fromNumber, to_number: toNumber, direction: "inbound",
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
      try { const parsed = JSON.parse(rawBody); if (typeof parsed === "string") twiml = parsed; } catch { /* Directe XML is geldig. */ }
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

module.exports = { createApp, buildCallEmail, errorTwiml, publicWebhookUrl, parseContacts, startOutboundCall };
