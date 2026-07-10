# My Call Agent — Twilio + ElevenLabs + Render

Deze service laat een inkomende Twilio-oproep beantwoorden door een ElevenLabs Agent. De route is:

`iPhone/provider → Twilio +31 97010276901 → Render webhook → ElevenLabs Agent met Fleur-stem`

## Belangrijke beperking van de iPhone

iOS kan niet selectief **alleen gemiste onbekende contacten** naar Twilio doorschakelen. Het telefoonboek wordt niet aan Twilio of deze app doorgegeven. Wat doorgaans wél kan, afhankelijk van je mobiele provider:

- conditioneel doorschakelen bij *geen gehoor* (dan gaan ook bekende gemiste bellers naar Fleur);
- alle oproepen doorschakelen;
- onbekende nummers door iOS laten screenen of stilhouden, maar dit is niet hetzelfde als doorschakelen naar Twilio.

Vraag je provider daarom om **conditioneel doorschakelen bij geen antwoord** naar `+3197010276901`. Laat de provider bevestigen welke code, wachttijd en kosten voor jouw abonnement gelden. Gebruik geen willekeurige GSM-code zonder die bevestiging.

## 1. ElevenLabs instellen

1. Open **Agents** in ElevenLabs en maak of selecteer een Conversational AI Agent.
2. Kies in de Voice-instellingen de stem **Fleur - PA van Brian**. Alleen een Voice maken is niet genoeg: de stem moet aan de Agent zijn toegewezen.
3. Stel input én output audio in op **μ-law 8000 Hz**; dit is het Twilio-formaat.
4. Geef de Agent bijvoorbeeld deze eerste boodschap: `Goedendag, je spreekt met Fleur, de AI-assistent van Brian. Brian kan nu niet opnemen. Met wie spreek ik en waarvoor belt u?`
5. Neem in de prompt op dat Fleur geen toezeggingen, betalingen of gevoelige gegevens mag accepteren en duidelijk zegt dat zij een AI-assistent is.
6. Kopieer bij de Agent-instellingen de **Agent ID**.
7. Maak onder je profiel/API Keys een API-key en bewaar die veilig. Upload hem nooit naar GitHub.

## 2. Bestanden naar GitHub uploaden

1. Open de lege repository `ShifuBrian/My-call-agent`.
2. Kies **Add file → Upload files**.
3. Sleep de uitgepakte bestanden uit deze map naar het uploadvak. Upload de ZIP zelf niet: GitHub pakt die niet uit.
4. Controleer dat onder andere `index.js`, `package.json`, `pnpm-lock.yaml`, `render.yaml` en `.env.example` zichtbaar zijn.
5. Kies **Commit directly to the main branch** en klik **Commit changes**.

De `.env.example` bevat alleen voorbeeldwaarden. Zet nooit een Twilio Auth Token of ElevenLabs API-key in een commit.

## 3. Render koppelen aan GitHub

1. Log in op Render en kies **New → Blueprint**.
2. Verbind GitHub en selecteer `ShifuBrian/My-call-agent`.
3. Render leest `render.yaml` en vraagt om vier geheime waarden:
   - `ELEVENLABS_API_KEY`: de ElevenLabs API-key;
   - `ELEVENLABS_AGENT_ID`: de Agent ID van de Agent waaraan Fleur is toegewezen;
   - `TWILIO_AUTH_TOKEN`: Twilio Console → Account Dashboard → Auth Token;
   - `PUBLIC_BASE_URL`: eerst tijdelijk `https://my-call-agent.onrender.com`; vervang dit door de exacte URL die Render werkelijk toewijst, zonder slash aan het einde.
4. Maak de Blueprint aan en wacht op **Live**.
5. Open `https://<jouw-render-host>/health`. Verwacht `{"status":"ok"}`.

Render deployt daarna automatisch na iedere commit op GitHub. Een gratis Render-service kan na inactiviteit slapen; dat kan de eerste beantwoording vertragen. Voor telefonie is een always-on betaald instance betrouwbaarder.

## 4. Twilio koppelen aan Render

1. Open Twilio Console → **Phone Numbers → Manage → Active numbers**.
2. Klik op `+31 97010276901`.
3. Ga naar **Voice configuration**.
4. Stel **A call comes in** in op `Webhook`.
5. URL: `https://<jouw-render-host>/twilio/inbound`.
6. Methode: `HTTP POST`.
7. Sla op.

De app valideert iedere Twilio-handtekening met `TWILIO_AUTH_TOKEN`. Daarom moet `PUBLIC_BASE_URL` exact overeenkomen met de publieke Render-URL die Twilio gebruikt (inclusief `https`, zonder pad of afsluitende slash).

## 5. iPhone/provider instellen en testen

1. Vraag je mobiele provider conditioneel doorschakelen **bij geen antwoord** naar `+3197010276901` te activeren.
2. Bel vanaf een nummer dat niet in je contacten staat.
3. Neem de iPhone niet op en wacht tot de provider doorschakelt.
4. Controleer of Fleur opneemt.
5. Bekijk bij problemen eerst Render **Logs**, daarna Twilio **Monitor → Logs → Calls**, en ten slotte ElevenLabs **Conversations**.

Test ook met een bekend contact: door de iOS/provider-beperking zal een gemiste bekende beller waarschijnlijk eveneens worden doorgeschakeld.

## API-koppelingen

- **GitHub → Render:** Render leest de repository en deployt automatisch bij commits.
- **Twilio → Render:** Twilio verstuurt een ondertekende `POST` met onder andere `From` en `To`.
- **Render → ElevenLabs:** de app roept `POST /v1/convai/twilio/register-call` aan met de Agent ID en telefoonnummers.
- **ElevenLabs → Twilio:** ElevenLabs retourneert TwiML waarmee Twilio de live audio via WebSocket verbindt.

Je hoeft de Twilio Account SID niet in Render te zetten; voor deze inbound webhook is het Auth Token alleen nodig om verzoeken cryptografisch te controleren.

## Privacy en veiligheid

Vertel bellers direct dat Fleur een AI-assistent is. Als je gesprekken opneemt, transcribeert, samenvat of bewaart, kondig dit vóór de opname duidelijk aan en controleer de toepasselijke AVG- en telecomregels. Verzamel zo min mogelijk persoonsgegevens, stel bewaartermijnen in en sluit waar nodig verwerkersovereenkomsten met leveranciers. Deze repository neemt zelf niets op en heeft geen database; eventuele conversatiegegevens kunnen wel volgens je ElevenLabs/Twilio-instellingen worden verwerkt of bewaard.

## Lokaal testen

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
```

Voor een handmatige lokale webhooktest mag tijdelijk `SKIP_TWILIO_SIGNATURE_VALIDATION=true` worden gebruikt. Zet dit nooit als Render-secret in productie.
