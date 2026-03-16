# LiveAgent Exp (Backend-First ADK Streaming Service)

FastAPI service for Gemini Live bidirectional streaming (audio, text, image), with an optional built-in UI for testing.

## Is it ready for integration/deployment?

Yes, this is ready for integration with other UIs and can be deployed now as a backend service.

Current maturity:
- Ready for dev/staging and integration testing.
- Suitable for production after adding auth, persistent session store, and stricter CORS/security settings.

## What this service exposes

### Backend endpoints
- `GET /` → backend status + versioned endpoint map
- `GET /v1/root` → backend health/info
- `WS /v1/ws/{user_id}/{session_id}` → primary bidirectional streaming endpoint

### Optional built-in UI endpoints
- `GET /v1/ui` → demo UI
- `GET /v1/ui/static/*` → UI assets

### Legacy compatibility
- `GET /ui`
- `WS /ws/{user_id}/{session_id}`

## Protocol (for external frontend integration)

Use one WebSocket connection per session:
- URL: `/v1/ws/{user_id}/{session_id}`
- Query params (optional):
  - `proactivity=true`
  - `affective_dialog=true`

### Client → Server messages

1) Text message (JSON text frame)
```json
{"type":"text","text":"Hello"}
```

2) Binary framed audio/image (binary frame)

Frame format:
- Byte 0: `0x4C` (`L`)
- Byte 1: `0x47` (`G`)
- Byte 2: frame type
  - `0x01` = PCM16 audio (`audio/pcm;rate=16000`)
  - `0x02` = JPEG image (`image/jpeg`)
- Byte 3..N: payload bytes

### Server → Client messages

Server sends ADK event JSON as text frames, including:
- content parts (`text`, `inlineData` audio)
- `inputTranscription`
- `outputTranscription`
- `turnComplete`
- `interrupted`
- `usageMetadata`

## Quick start (local)

### 1) Create env
Add `.env` at repo root:
```env
GOOGLE_API_KEY=your_key_here
DEMO_AGENT_MODEL=gemini-2.5-flash-native-audio-preview-12-2025
```

### 2) Install
```bash
pip install -r requirements.txt
```

If you do not yet have `requirements.txt`, install at minimum:
```bash
pip install fastapi uvicorn python-dotenv google-adk google-genai
```

### 3) Run
```bash
python main.py
```

### 4) Verify
- Backend health: `http://localhost:8000/`
- Versioned root: `http://localhost:8000/v1/root`
- Optional UI: `http://localhost:8000/v1/ui`

## Integrating another frontend

1) Point your frontend WS to:
- `ws://<host>/v1/ws/{user_id}/{session_id}`
- or `wss://<host>/v1/ws/{user_id}/{session_id}`

2) Implement message handling:
- Send text as JSON text frames.
- Send audio/image using the `LG + type + payload` binary frame format.
- Parse ADK JSON events from server.

3) Recommended frontend behaviors:
- Keep one WS per active conversation session.
- Reconnect on close and reuse session ID for continuity.
- Handle `turnComplete` and `interrupted` events explicitly.

## Deployment notes (Cloud Run)

Recommended for production readiness:
- Add authentication (JWT/session token) before accepting WS traffic.
- Move from in-memory sessions to shared store (Redis/DB) for multi-instance scale.
- Configure CORS/origin allow-list for trusted frontend domains.
- Keep API key in secret manager, not in source-controlled `.env`.

## Project layout (current)

- `main.py` → FastAPI app, HTTP + WS routes, protocol handling
- `liveagent/` → ADK agent config (kept as core agent directory)
- `static/` → optional built-in UI (served under `/v1/ui`)
- `architecture.md` → architecture diagrams and integration flow

## Troubleshooting

- WS connects but no response:
  - Verify API key and model configuration.
  - Check server logs for upstream frame counters and ADK errors.

- Audio/image not interpreted correctly:
  - Ensure binary frame starts with `0x4C 0x47` and correct type byte.

- UI works but external frontend fails:
  - Compare external payload framing with the protocol section above.
