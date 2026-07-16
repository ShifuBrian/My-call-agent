"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("./index");

async function start(options = {}) {
  const server = createApp(options).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("health endpoint werkt", async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("inbound call wordt bij ElevenLabs geregistreerd", async (t) => {
  process.env.SKIP_TWILIO_SIGNATURE_VALIDATION = "true";
  process.env.ELEVENLABS_API_KEY = "test-key";
  process.env.ELEVENLABS_AGENT_ID = "test-agent";
  let sent;
  const fakeFetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify("<Response><Connect /></Response>"), { status: 200 });
  };
  const { server, base } = await start({ fetchImpl: fakeFetch });
  t.after(() => server.close());
  const response = await fetch(`${base}/twilio/inbound`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "From=%2B31612345678&To=%2B3197010276901"
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<Connect/);
  assert.equal(sent.agent_id, "test-agent");
});

test("post-call webhook verstuurt transcript via Resend", async (t) => {
  process.env.ELEVENLABS_AGENT_ID = "test-agent";
  process.env.ELEVENLABS_WEBHOOK_SECRET = "secret";
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "Fleur <onboarding@resend.dev>";
  process.env.EMAIL_TO = "brian@example.com";
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
    data: {
      agent_id: "test-agent",
      conversation_id: "conv-123",
      transcript: [{ role: "user", message: "Ik wil graag teruggebeld worden." }],
      analysis: { transcript_summary: "Beller wil worden teruggebeld.", call_successful: true },
      metadata: { call_duration_secs: 42 }
    }
  };
  const response = await fetch(`${base}/elevenlabs/post-call`, {
    method: "POST",
    headers: { "content-type": "application/json", "elevenlabs-signature": "test-signature" },
    body: JSON.stringify(event)
  });
  assert.equal(response.status, 200);
  assert.equal(emailRequest.headers.authorization, "Bearer re_test");
  assert.equal(emailRequest.headers["idempotency-key"], "call-notes-conv-123");
  const email = JSON.parse(emailRequest.body);
  assert.deepEqual(email.to, ["brian@example.com"]);
  assert.match(email.text, /Beller wil worden teruggebeld/);
  assert.match(email.text, /Ik wil graag teruggebeld worden/);
});

test("post-call webhook weigert een ongeldige handtekening", async (t) => {
  process.env.ELEVENLABS_WEBHOOK_SECRET = "secret";
  const { server, base } = await start({ verifyWebhookEvent: async () => { throw new Error("invalid"); } });
  t.after(() => server.close());
  const response = await fetch(`${base}/elevenlabs/post-call`, {
    method: "POST",
    headers: { "content-type": "application/json", "elevenlabs-signature": "wrong" },
    body: "{}"
  });
  assert.equal(response.status, 401);
});
