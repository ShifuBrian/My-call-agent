"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, buildCallEmail, parseContacts } = require("./index");

async function start(options = {}) {
  const server = createApp(options).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function setBaseEnvironment() {
  process.env.NODE_ENV = "test";
  process.env.SKIP_TWILIO_SIGNATURE_VALIDATION = "true";
  process.env.ELEVENLABS_API_KEY = "test-key";
  process.env.ELEVENLABS_AGENT_ID = "inbound-agent";
  process.env.ELEVENLABS_OUTBOUND_AGENT_ID = "outbound-agent";
  process.env.ELEVENLABS_PHONE_NUMBER_ID = "phnum-test";
  process.env.ELEVENLABS_WEBHOOK_SECRET = "secret";
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "Fleur <onboarding@resend.dev>";
  process.env.EMAIL_TO = "brian@example.com";
  process.env.OUTBOUND_ENABLED = "true";
  process.env.OUTBOUND_USERNAME = "brian";
  process.env.OUTBOUND_COMMAND_SECRET = "a-very-long-test-secret";
  process.env.OUTBOUND_CONTACTS_JSON = JSON.stringify({ joanne: { name: "Joanne", number: "+31612345678" } });
}

test.beforeEach(setBaseEnvironment);

test("health endpoint werkt", async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("inbound call wordt bij ElevenLabs geregistreerd", async (t) => {
  let sent;
  const fakeFetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify("<Response><Connect /></Response>"), { status: 200 });
  };
  const { server, base } = await start({ fetchImpl: fakeFetch });
  t.after(() => server.close());
  const response = await fetch(`${base}/twilio/inbound`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "From=%2B31612345678&To=%2B3197010276901"
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<Connect/);
  assert.equal(sent.agent_id, "inbound-agent");
});

test("outbound API belt uitsluitend een contact uit de allowlist", async (t) => {
  let request;
  const fakeFetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ success: true, conversation_id: "conv-out", callSid: "CA123" }), { status: 200 });
  };
  const { server, base } = await start({ fetchImpl: fakeFetch });
  t.after(() => server.close());
  const response = await fetch(`${base}/api/outbound-call`, {
    method: "POST",
    headers: { authorization: "Bearer a-very-long-test-secret", "content-type": "application/json" },
    body: JSON.stringify({ contact_id: "joanne", message: "Ik ben twintig minuten later.", question: "Kun je dit bevestigen?" })
  });
  assert.equal(response.status, 202);
  assert.equal(request.url, "https://api.elevenlabs.io/v1/convai/twilio/outbound-call");
  assert.equal(request.body.agent_id, "outbound-agent");
  assert.equal(request.body.agent_phone_number_id, "phnum-test");
  assert.equal(request.body.to_number, "+31612345678");
  assert.equal(request.body.conversation_initiation_client_data.dynamic_variables.recipient_name, "Joanne");
});

test("outbound API weigert ongeautoriseerde en onbekende contacten", async (t) => {
  const { server, base } = await start({ fetchImpl: async () => { throw new Error("mag niet worden aangeroepen"); } });
  t.after(() => server.close());
  const unauthorized = await fetch(`${base}/api/outbound-call`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(unauthorized.status, 401);
  const unknown = await fetch(`${base}/api/outbound-call`, {
    method: "POST", headers: { authorization: "Bearer a-very-long-test-secret", "content-type": "application/json" },
    body: JSON.stringify({ contact_id: "onbekend", message: "Test" })
  });
  assert.equal(unknown.status, 400);
});

test("contactconfiguratie vereist E.164-nummers", () => {
  process.env.OUTBOUND_CONTACTS_JSON = JSON.stringify({ fout: { name: "Fout", number: "0612345678" } });
  assert.throws(parseContacts, /Ongeldig contact/);
});

test("post-call webhook verstuurt inbound transcript via Resend", async (t) => {
  let emailRequest;
  const fakeFetch = async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    emailRequest = options;
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  };
  const verifyWebhookEvent = async (body, signature, secret) => {
    assert.equal(signature, "test-signature");
    assert.equal(secret, "secret");
    return JSON.parse(body);
  };
  const { server, base } = await start({ fetchImpl: fakeFetch, verifyWebhookEvent });
  t.after(() => server.close());
  const event = {
    type: "post_call_transcription",
    data: { agent_id: "inbound-agent", conversation_id: "conv-123", transcript: [{ role: "user", message: "Bel mij terug." }], analysis: { transcript_summary: "Beller wil worden teruggebeld.", call_successful: true }, metadata: { call_duration_secs: 42 } }
  };
  const response = await fetch(`${base}/elevenlabs/post-call`, { method: "POST", headers: { "content-type": "application/json", "elevenlabs-signature": "test-signature" }, body: JSON.stringify(event) });
  assert.equal(response.status, 200);
  assert.equal(emailRequest.headers["idempotency-key"], "call-notes-conv-123");
  assert.match(JSON.parse(emailRequest.body).text, /Beller wil worden teruggebeld/);
});

test("outbound e-mailverslag is Nederlands en bevat opdracht", () => {
  const email = buildCallEmail({ type: "post_call_transcription", data: {
    agent_id: "outbound-agent", conversation_id: "conv-out",
    conversation_initiation_client_data: { dynamic_variables: { call_type: "message_delivery", recipient_name: "Joanne", message: "Brian komt later.", question: "Kun je dit bevestigen?", task_id: "task-1" } },
    transcript: [{ role: "agent", message: "Hallo Joanne." }, { role: "user", message: "Dat is goed." }],
    analysis: { transcript_summary: "Joanne heeft de boodschap ontvangen.", call_successful: true }
  }});
  assert.match(email.subject, /uitgaande Fleur-oproep aan Joanne/);
  assert.match(email.text, /OPGEDRAGEN BOODSCHAP/);
  assert.match(email.text, /Ontvanger: Dat is goed/);
});

test("ontbrekende data-collectionwaarden worden alleen als Onbekend getoond", () => {
  const email = buildCallEmail({ type: "post_call_transcription", data: {
    agent_id: "outbound-agent",
    conversation_initiation_client_data: { dynamic_variables: { call_type: "message_delivery", recipient_name: "Eddy", message: "Testbericht" } },
    analysis: { data_collection_results: {
      recipient_response: {
        data_collection_id: "recipient_response",
        value: null,
        json_schema: { type: "string", description: "Technische instructie die niet in de e-mail hoort" },
        rationale: "Technische uitleg die niet in de e-mail hoort"
      },
      message_delivered: { value: "Ja" }
    } }
  }});
  assert.match(email.text, /- recipient response: Onbekend/);
  assert.match(email.text, /- message delivered: Ja/);
  assert.doesNotMatch(email.text, /json_schema|rationale|Technische instructie|Technische uitleg/);
});

test("post-call webhook weigert een ongeldige handtekening", async (t) => {
  const { server, base } = await start({ verifyWebhookEvent: async () => { throw new Error("invalid"); } });
  t.after(() => server.close());
  const response = await fetch(`${base}/elevenlabs/post-call`, { method: "POST", headers: { "content-type": "application/json", "elevenlabs-signature": "wrong" }, body: "{}" });
  assert.equal(response.status, 401);
});
