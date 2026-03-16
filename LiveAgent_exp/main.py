"""FastAPI application demonstrating ADK Gemini Live API Toolkit with WebSocket."""

import asyncio
import base64
import json
import logging
import time
import warnings
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

# Load environment variables from .env file BEFORE importing agent
load_dotenv(Path(__file__).parent / ".env")

# Import agent after loading environment variables
# pylint: disable=wrong-import-position
from liveagent.agent import agent  # noqa: E402

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Suppress Pydantic serialization warnings
warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

# Application name constant
APP_NAME = "bidi-demo"
BINARY_MAGIC = b"LG"
BINARY_FRAME_TYPE_AUDIO_PCM16 = 0x01
BINARY_FRAME_TYPE_IMAGE_JPEG = 0x02

# ========================================
# Phase 1: Application Initialization (once at startup)
# ========================================

app = FastAPI()

# Mount static files
static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=static_dir), name="static")
app.mount("/v1/ui/static", StaticFiles(directory=static_dir), name="ui-static-v1")

# Define your session service
session_service = InMemorySessionService()

# Define your runner
runner = Runner(app_name=APP_NAME, agent=agent, session_service=session_service)

# ========================================
# HTTP Endpoints
# ========================================


@app.get("/")
async def root():
    """Backend service root endpoint."""
    return {
        "service": APP_NAME,
        "status": "ok",
        "version": "v1",
        "endpoints": {
            "root": "/v1/root",
            "ui": "/v1/ui",
            "websocket": "/v1/ws/{user_id}/{session_id}",
        },
    }


@app.get("/v1/root")
async def v1_root():
    """Versioned backend health/info endpoint."""
    return {
        "service": APP_NAME,
        "status": "ok",
        "version": "v1",
        "message": "Backend is running",
    }


@app.get("/v1/ui")
async def v1_ui():
    """Serve optional UI for local/backend validation."""
    return FileResponse(Path(__file__).parent / "static" / "index.html")


@app.get("/ui")
async def ui_legacy():
    """Legacy UI endpoint for backward compatibility."""
    return FileResponse(Path(__file__).parent / "static" / "index.html")


# ========================================
# WebSocket Endpoint
# ========================================


@app.websocket("/v1/ws/{user_id}/{session_id}")
@app.websocket("/ws/{user_id}/{session_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: str,
    session_id: str,
    proactivity: bool = False,
    affective_dialog: bool = False,
) -> None:
    """WebSocket endpoint for bidirectional streaming with ADK.

    Args:
        websocket: The WebSocket connection
        user_id: User identifier
        session_id: Session identifier
        proactivity: Enable proactive audio (native audio models only)
        affective_dialog: Enable affective dialog (native audio models only)
    """
    logger.debug(
        f"WebSocket connection request: user_id={user_id}, session_id={session_id}, "
        f"proactivity={proactivity}, affective_dialog={affective_dialog}"
    )
    await websocket.accept()
    logger.debug("WebSocket connection accepted")

    # ========================================
    # Phase 2: Session Initialization (once per streaming session)
    # ========================================

    # Automatically determine response modality based on model architecture
    # Native audio models (containing "native-audio" in name)
    # ONLY support AUDIO response modality.
    # Half-cascade models support both TEXT and AUDIO,
    # we default to TEXT for better performance.
    model_name = agent.model
    is_native_audio = "native-audio" in model_name.lower()

    if is_native_audio:
        # Native audio models require AUDIO response modality
        # with audio transcription
        response_modalities = ["AUDIO"]

        # Build RunConfig with optional proactivity and affective dialog
        # These features are only supported on native audio models
        run_config = RunConfig(
            streaming_mode=StreamingMode.BIDI,
            response_modalities=response_modalities,
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            session_resumption=types.SessionResumptionConfig(),
            proactivity=(
                types.ProactivityConfig(proactive_audio=True) if proactivity else None
            ),
            enable_affective_dialog=affective_dialog if affective_dialog else None,
        )
        logger.debug(
            f"Native audio model detected: {model_name}, "
            f"using AUDIO response modality, "
            f"proactivity={proactivity}, affective_dialog={affective_dialog}"
        )
    else:
        # Half-cascade models support TEXT response modality
        # for faster performance
        response_modalities = ["TEXT"]
        run_config = RunConfig(
            streaming_mode=StreamingMode.BIDI,
            response_modalities=response_modalities,
            input_audio_transcription=None,
            output_audio_transcription=None,
            session_resumption=types.SessionResumptionConfig(),
        )
        logger.debug(
            f"Half-cascade model detected: {model_name}, "
            "using TEXT response modality"
        )
        # Warn if user tried to enable native-audio-only features
        if proactivity or affective_dialog:
            logger.warning(
                f"Proactivity and affective dialog are only supported on native "
                f"audio models. Current model: {model_name}. "
                f"These settings will be ignored."
            )
    logger.debug(f"RunConfig created: {run_config}")

    # Get or create session (handles both new sessions and reconnections)
    session = await session_service.get_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id
    )
    if not session:
        await session_service.create_session(
            app_name=APP_NAME, user_id=user_id, session_id=session_id
        )

    live_request_queue = LiveRequestQueue()

    # ========================================
    # Phase 3: Active Session (concurrent bidirectional communication)
    # ========================================

    async def upstream_task() -> None:
        """Receives messages from WebSocket and sends to LiveRequestQueue."""
        logger.debug("upstream_task started")
        audio_frame_count = 0
        image_frame_count = 0
        last_stats_log = time.monotonic()

        def maybe_log_upstream_stats() -> None:
            nonlocal last_stats_log
            now = time.monotonic()
            if now - last_stats_log >= 5:
                logger.info(
                    "Upstream frame stats (last 5s): "
                    f"audio_frames={audio_frame_count}, image_frames={image_frame_count}"
                )
                last_stats_log = now

        while True:
            # Receive message from WebSocket (text or binary)
            message = await websocket.receive()

            # Handle binary frames (typed binary protocol or legacy audio)
            if "bytes" in message:
                binary_data = message["bytes"]

                if not binary_data:
                    continue

                # Framed binary protocol:
                # [0x4C, 0x47, frame_type, ...payload]
                has_framed_header = (
                    len(binary_data) >= 3 and binary_data[:2] == BINARY_MAGIC
                )

                if has_framed_header:
                    frame_type = binary_data[2]
                    payload = binary_data[3:]

                    if frame_type == BINARY_FRAME_TYPE_AUDIO_PCM16:
                        logger.debug(
                            "Received framed binary audio chunk: "
                            f"{len(payload)} bytes"
                        )
                        audio_frame_count += 1
                        audio_blob = types.Blob(
                            mime_type="audio/pcm;rate=16000", data=payload
                        )
                        live_request_queue.send_realtime(audio_blob)
                    elif frame_type == BINARY_FRAME_TYPE_IMAGE_JPEG:
                        logger.debug(
                            "Received framed binary image chunk: "
                            f"{len(payload)} bytes"
                        )
                        image_frame_count += 1
                        image_blob = types.Blob(mime_type="image/jpeg", data=payload)
                        live_request_queue.send_realtime(image_blob)
                    else:
                        logger.warning(
                            "Unknown framed binary type received: " f"{frame_type}"
                        )
                else:
                    # Backward compatibility: treat unframed binary payload as audio PCM
                    logger.debug(
                        "Received legacy binary audio chunk: "
                        f"{len(binary_data)} bytes"
                    )
                    audio_frame_count += 1
                    audio_blob = types.Blob(
                        mime_type="audio/pcm;rate=16000", data=binary_data
                    )
                    live_request_queue.send_realtime(audio_blob)

                maybe_log_upstream_stats()

            # Handle text frames (JSON messages)
            elif "text" in message:
                text_data = message["text"]
                logger.debug(f"Received text message: {text_data[:100]}...")

                json_message = json.loads(text_data)

                # Extract text from JSON and send to LiveRequestQueue
                if json_message.get("type") == "text":
                    logger.debug(f"Sending text content: {json_message['text']}")
                    content = types.Content(
                        parts=[types.Part(text=json_message["text"])]
                    )
                    live_request_queue.send_content(content)

                # Handle image data
                elif json_message.get("type") == "image":
                    logger.debug("Received image data")

                    # Decode base64 image data
                    image_data = base64.b64decode(json_message["data"])
                    mime_type = json_message.get("mimeType", "image/jpeg")

                    logger.debug(
                        f"Sending image: {len(image_data)} bytes, " f"type: {mime_type}"
                    )

                    # Send image as blob
                    image_blob = types.Blob(mime_type=mime_type, data=image_data)
                    live_request_queue.send_realtime(image_blob)
                    image_frame_count += 1
                    maybe_log_upstream_stats()

    async def downstream_task() -> None:
        """Receives Events from run_live() and sends to WebSocket."""
        logger.debug("downstream_task started, calling runner.run_live()")
        logger.debug(
            f"Starting run_live with user_id={user_id}, " f"session_id={session_id}"
        )
        async for event in runner.run_live(
            user_id=user_id,
            session_id=session_id,
            live_request_queue=live_request_queue,
            run_config=run_config,
        ):
            event_json = event.model_dump_json(exclude_none=True, by_alias=True)
            logger.debug(f"[SERVER] Event: {event_json}")
            await websocket.send_text(event_json)
        logger.debug("run_live() generator completed")

    # Run both tasks concurrently
    # Exceptions from either task will propagate and cancel the other task
    try:
        logger.debug("Starting asyncio.gather for upstream and downstream tasks")
        await asyncio.gather(upstream_task(), downstream_task())
        logger.debug("asyncio.gather completed normally")
    except WebSocketDisconnect:
        logger.debug("Client disconnected normally")
    except Exception as e:
        logger.error(f"Unexpected error in streaming tasks: {e}", exc_info=True)
    finally:
        # ========================================
        # Phase 4: Session Termination
        # ========================================

        # Always close the queue, even if exceptions occurred
        logger.debug("Closing live_request_queue")
        live_request_queue.close()


if __name__ == "__main__":
    import uvicorn

    print("\n  App running at: http://localhost:8000\n")
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)