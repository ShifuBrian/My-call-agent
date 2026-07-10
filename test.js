"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("./index");

async function start(fetchImpl) {
  const server = createApp({ fetchImpl }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

test("health endpoint werkt", async (t) => {
  const { server, base } = await start(global.fetch);
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
  const { server, base } = await start(fakeFetch);
  t.after(() => server.close());

  const response = await fetch(`${base}/twilio/inbound`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "From=%2B31612345678&To=%2B3197010276901"
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<Connect/);
  assert.equal(sent.agent_id, "test-agent");
  assert.equal(sent.from_number, "+31612345678");
});
