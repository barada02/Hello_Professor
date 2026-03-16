# Architecture Overview

This project is backend-first with a versioned API (`/v1/*`) and an optional built-in UI for validation/testing.

## 1) Current Architecture (Backend-First + Optional UI)

```mermaid
flowchart TD
  subgraph Current[Current: Backend-First Service]
    U[User Browser / External Frontend]
    P["python main.py\n(Uvicorn + FastAPI)"]
    ROOT["GET / and GET /v1/root"]
    UI["GET /v1/ui"]
    UISTATIC["GET /v1/ui/static/*"]
    WS["WS /v1/ws/{user_id}/{session_id}"]
    ADK["ADK Runner + Agent\n(liveagent/agent.py)"]

    U -->|Health/Info| ROOT --> P
    U -->|Optional demo UI| UI --> P
    U -->|UI assets| UISTATIC --> P
    U -->|Bidi stream| WS --> P
    P --> ADK
    ADK --> P
    P -->|event JSON + audio| U
  end
```

### Current endpoint map
- Backend info: `/`, `/v1/root`
- Primary websocket: `/v1/ws/{user_id}/{session_id}`
- Optional built-in UI: `/v1/ui`
- Optional UI static assets: `/v1/ui/static/*`
- Backward compatibility: `/ui`, `/ws/{user_id}/{session_id}`

### Protocol summary
- Text input: JSON text frame (`{"type":"text","text":"..."}`)
- Binary framed media: `LG + frame_type + payload`
  - `0x01` = PCM16 audio (`audio/pcm;rate=16000`)
  - `0x02` = JPEG image (`image/jpeg`)

### Current built-in UI composition
- Slim header with connection status + run-config toggles.
- Chat-first main layout (messages + sticky composer).
- Event console in right-side drawer (open/close, persisted state).
- Live camera as floating overlay panel (does not push chat layout).
- Camera snapshot remains modal-based for single-image capture.

---

## 2) Target Architecture (Split Frontend + Backend Service)

```mermaid
flowchart TD
  subgraph Future[Future: Split Frontend + Backend]
    U2[User Browser]
    FE["Frontend App\n(Static hosting / CDN)"]
    BE["Backend API Service\n(Cloud Run FastAPI)"]
    WS2["WS /v1/ws/*"]
    ADK2["ADK Runner + Agent"]
    STORE["Session Store\n(Redis/DB)"]

    U2 -->|Load frontend| FE
    U2 -->|HTTP API + WS| BE
    WS2 --> BE
    BE --> ADK2
    ADK2 --> BE
    BE <--> STORE
    BE -->|streamed responses| U2
  end
```

### Why this split
- Reuse one backend across multiple UIs.
- Independent frontend/backend deployments.
- Better scaling path with shared session store.

---

## 3) Streaming Lifecycle (Current)

```mermaid
sequenceDiagram
  participant C as Client UI
  participant B as FastAPI /v1/ws
  participant A as ADK Runner

  C->>B: Open WebSocket (/v1/ws/{user}/{session})
  C->>B: Binary audio/image frames or JSON text
  B->>A: live_request_queue (content/realtime)
  A-->>B: Streaming events (partials/transcriptions/audio)
  B-->>C: Event JSON text frames
  C-->>B: Continue sending user media/text
```

### Lifecycle details
1. Client loads UI from `/v1/ui` and static assets from `/v1/ui/static/*`.
2. Client opens websocket to `/v1/ws/{user_id}/{session_id}`.
3. Upstream messages:
   - Text JSON messages (`type=text`).
   - Framed binary audio (`0x01`).
   - Framed binary image (`0x02`, snapshot/live-cam 1 FPS).
4. Backend pushes upstream data to ADK `LiveRequestQueue`.
5. ADK runner streams downstream events (transcriptions/content/audio/turn markers).
6. Client renders chat/transcriptions, plays returned audio, and logs event details in drawer console.
