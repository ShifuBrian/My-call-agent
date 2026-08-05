# Fleur Call Agent

Eén Render-service voor:

- inkomende Twilio-gesprekken met de ElevenLabs-agent;
- een beveiligde webpagina waarmee Brian Fleur een uitgaande boodschap kan laten overbrengen;
- Nederlandse e-mailverslagen via Resend na inkomende én uitgaande gesprekken.

## GitHub-bestanden

Upload minimaal `index.js`, `package.json`, `pnpm-lock.yaml`, `render.yaml`, `.env.example`, `test.js` en deze `README.md`. Upload nooit echte API-keys of wachtwoorden.

## Render-variabelen

Behoud de bestaande variabelen en voeg toe:

```text
ELEVENLABS_OUTBOUND_AGENT_ID=agent_...
ELEVENLABS_PHONE_NUMBER_ID=phnum_...
OUTBOUND_ENABLED=true
OUTBOUND_USERNAME=brian
OUTBOUND_COMMAND_SECRET=een-lange-unieke-willekeurige-waarde
OUTBOUND_MAX_CALLS_PER_HOUR=5
OUTBOUND_CONTACTS_JSON={"joanne":{"name":"Joanne","number":"+31612345678"}}
```

`ELEVENLABS_PHONE_NUMBER_ID` is de ID die op de ElevenLabs-detailpagina van het geïmporteerde Twilio-nummer onder het nummer staat. Dit is niet het telefoonnummer zelf. Alle nummers in `OUTBOUND_CONTACTS_JSON` moeten het internationale E.164-formaat hebben, bijvoorbeeld `+31612345678`.

Genereer `OUTBOUND_COMMAND_SECRET` met een wachtwoordmanager. Deel deze waarde niet en plaats hem niet in GitHub. `OUTBOUND_ENABLED=false` schakelt alle nieuwe uitgaande opdrachten onmiddellijk uit.

## ElevenLabs-agent instellen

Maak voor uitgaande boodschappen bij voorkeur een aparte agent en gebruik deze dynamische variabelen in de agent:

- First message: `{{opening_message}}`
- System prompt: gebruik `{{recipient_name}}`, `{{message}}` en `{{question}}`.

Voorbeeldinstructie:

```text
Je bent Fleur, de AI-assistent van Brian. Je belt {{recipient_name}} namens Brian.
Maak direct duidelijk dat je een AI-assistent bent. Breng deze boodschap exact en vriendelijk over:
{{message}}
Stel daarna, alleen als deze niet leeg is, de volgende vraag: {{question}}
Vraag of de boodschap duidelijk is en noteer het antwoord. Doe geen toezeggingen namens Brian.
Spreek standaard Nederlands. Schrijf de samenvatting en verzamelde gegevens in het Nederlands.
```

Wijs dezelfde geïmporteerde Twilio-telefoonlijn toe en publiceer de outbound-agent. Zorg dat de workspace post-call webhook `post_call_transcription` naar deze URL stuurt:

```text
https://my-call-agent-lgm3.onrender.com/elevenlabs/post-call
```

Het webhooksecret van deze actieve HMAC-webhook moet gelijk zijn aan `ELEVENLABS_WEBHOOK_SECRET` in Render.

## Uitgaande oproep starten

Na een succesvolle deploy open je:

```text
https://my-call-agent-lgm3.onrender.com/outbound
```

Log in met `OUTBOUND_USERNAME` en `OUTBOUND_COMMAND_SECRET`. Kies een toegestaan contact, schrijf de boodschap en eventueel een vraag, en verstuur het formulier. De server kiest het telefoonnummer; de browser kan geen willekeurige nummers bellen.

Voor toekomstige automatisering bestaat ook `POST /api/outbound-call`. Deze route vereist `Authorization: Bearer <OUTBOUND_COMMAND_SECRET>` en JSON met `contact_id`, `message` en optioneel `question`.

## Beveiliging

- Twilio-requests worden cryptografisch gecontroleerd.
- ElevenLabs-post-call webhooks worden via HMAC gecontroleerd.
- Alleen expliciet toegestane contacten kunnen outbound worden gebeld.
- De webpagina gebruikt Basic Auth, een eenmalig CSRF-token en beveiligingsheaders.
- De API gebruikt Bearer-authenticatie.
- Tekstlengtes en oproepsnelheid zijn begrensd.
- Resend krijgt een idempotency-key om dubbele e-mails te beperken.

Laat bellers weten dat Fleur een AI-assistent is. Controleer ook de toepasselijke AVG-, opname- en telecomregels voordat je gesprekken opneemt of persoonsgegevens bewaart.

## Deploy en controle

Render gebruikt:

```text
Build Command: pnpm install --frozen-lockfile
Start Command: node index.js
Health Check: /health
```

Na het uploaden naar GitHub laat je Render automatisch deployen of kies je **Manual Deploy → Deploy latest commit**. Open daarna `/health`; de verwachte respons is `{"status":"ok"}`.

Lokaal testen:

```bash
pnpm test
```
