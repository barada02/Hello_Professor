import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const BINARY_MAGIC_1 = 0x4c
const BINARY_MAGIC_2 = 0x47
const BINARY_FRAME_TYPE_AUDIO_PCM16 = 0x01
const BINARY_FRAME_TYPE_IMAGE_JPEG = 0x02

const DEFAULT_HTTP_BASE = import.meta.env.VITE_BACKEND_HTTP ?? 'http://localhost:8080'

const makeId = () => Math.random().toString(36).slice(2)

function base64ToArrayBuffer(base64) {
  let standardBase64 = base64.replace(/-/g, '+').replace(/_/g, '/')
  while (standardBase64.length % 4) {
    standardBase64 += '='
  }
  const binaryString = window.atob(standardBase64)
  const bytes = new Uint8Array(binaryString.length)
  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index)
  }
  return bytes.buffer
}

function createBinaryFrame(frameType, payloadBuffer) {
  const payload = new Uint8Array(payloadBuffer)
  const framed = new Uint8Array(payload.byteLength + 3)
  framed[0] = BINARY_MAGIC_1
  framed[1] = BINARY_MAGIC_2
  framed[2] = frameType
  framed.set(payload, 3)
  return framed.buffer
}

function toPcm16Buffer(float32Data) {
  const pcm16 = new Int16Array(float32Data.length)
  for (let index = 0; index < float32Data.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, float32Data[index]))
    pcm16[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return pcm16.buffer
}

function App() {
  const [backendHttpBase, setBackendHttpBase] = useState(DEFAULT_HTTP_BASE)
  const [proactivity, setProactivity] = useState(false)
  const [affectiveDialog, setAffectiveDialog] = useState(false)
  const [connectionState, setConnectionState] = useState('connecting')
  const [textInput, setTextInput] = useState('')
  const [messages, setMessages] = useState([])
  const [events, setEvents] = useState([])
  const [audioEnabled, setAudioEnabled] = useState(false)
  const [liveCamEnabled, setLiveCamEnabled] = useState(false)
  const [framesSent, setFramesSent] = useState(0)

  const websocketRef = useRef(null)
  const reconnectTimerRef = useRef(null)

  const audioRecorderCtxRef = useRef(null)
  const audioRecorderNodeRef = useRef(null)
  const micStreamRef = useRef(null)

  const audioPlayerCtxRef = useRef(null)
  const audioPlayerNodeRef = useRef(null)

  const cameraStreamRef = useRef(null)
  const cameraFrameTimerRef = useRef(null)
  const liveVideoRef = useRef(null)

  const lastAssistantMessageIdRef = useRef(null)

  const userId = useMemo(() => `student-${makeId()}`, [])
  const sessionId = useMemo(() => `hello-prof-${makeId()}`, [])

  const addSystemMessage = (text) => {
    setMessages((previous) => [
      ...previous,
      { id: makeId(), role: 'system', text, final: true },
    ])
  }

  const addEvent = (direction, summary, payload) => {
    setEvents((previous) => [
      ...previous,
      {
        id: makeId(),
        timestamp: new Date().toLocaleTimeString(),
        direction,
        summary,
        payload,
      },
    ])
  }

  const sendTextPayload = (payload) => {
    const websocket = websocketRef.current
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      return false
    }
    websocket.send(JSON.stringify(payload))
    addEvent('up', `Sent ${payload.type}`, payload)
    return true
  }

  const sendBinaryPayload = (frameType, payloadBuffer) => {
    const websocket = websocketRef.current
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      return false
    }
    websocket.send(createBinaryFrame(frameType, payloadBuffer))
    return true
  }

  const updateAssistantMessage = (incomingText, isFinal = false) => {
    if (!incomingText) {
      return
    }
    setMessages((previous) => {
      if (!lastAssistantMessageIdRef.current) {
        const newId = makeId()
        lastAssistantMessageIdRef.current = newId
        return [
          ...previous,
          { id: newId, role: 'assistant', text: incomingText, final: isFinal },
        ]
      }

      return previous.map((message) => {
        if (message.id !== lastAssistantMessageIdRef.current) {
          return message
        }
        return {
          ...message,
          text: `${message.text}${incomingText}`,
          final: isFinal,
        }
      })
    })
  }

  const finalizeAssistantMessage = () => {
    if (!lastAssistantMessageIdRef.current) {
      return
    }
    setMessages((previous) =>
      previous.map((message) =>
        message.id === lastAssistantMessageIdRef.current
          ? { ...message, final: true }
          : message,
      ),
    )
    lastAssistantMessageIdRef.current = null
  }

  const connectWebSocket = () => {
    if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
      return
    }

    const wsBase = backendHttpBase
      .replace(/^http:/i, 'ws:')
      .replace(/^https:/i, 'wss:')
      .replace(/\/$/, '')

    const params = new URLSearchParams()
    if (proactivity) {
      params.append('proactivity', 'true')
    }
    if (affectiveDialog) {
      params.append('affective_dialog', 'true')
    }

    const wsUrl = `${wsBase}/v1/ws/${userId}/${sessionId}${
      params.size ? `?${params.toString()}` : ''
    }`
    const websocket = new WebSocket(wsUrl)
    websocketRef.current = websocket

    setConnectionState('connecting')

    websocket.onopen = () => {
      setConnectionState('connected')
      addSystemMessage('Connected to Hello Professor backend')
      addEvent('system', 'WebSocket connected', { wsUrl })
    }

    websocket.onmessage = (event) => {
      let parsed
      try {
        parsed = JSON.parse(event.data)
      } catch {
        addEvent('down', 'Received non-JSON event', null)
        return
      }

      if (parsed.turnComplete) {
        finalizeAssistantMessage()
      }

      if (parsed.interrupted) {
        finalizeAssistantMessage()
        addSystemMessage('Assistant response interrupted')
      }

      if (parsed.inputTranscription?.text) {
        setMessages((previous) => [
          ...previous,
          {
            id: makeId(),
            role: 'user',
            text: `🎤 ${parsed.inputTranscription.text}`,
            final: !!parsed.inputTranscription.finished,
          },
        ])
      }

      if (parsed.outputTranscription?.text) {
        setMessages((previous) => [
          ...previous,
          {
            id: makeId(),
            role: 'assistant',
            text: `🔊 ${parsed.outputTranscription.text}`,
            final: !!parsed.outputTranscription.finished,
          },
        ])
      }

      if (parsed.content?.parts?.length) {
        for (const part of parsed.content.parts) {
          if (part.text && !part.thought) {
            updateAssistantMessage(part.text, !parsed.partial)
          }

          if (part.inlineData?.data && part.inlineData?.mimeType?.startsWith('audio/pcm')) {
            if (audioPlayerNodeRef.current) {
              const audioChunk = base64ToArrayBuffer(part.inlineData.data)
              audioPlayerNodeRef.current.port.postMessage(audioChunk)
            }
          }
        }
      }

      addEvent('down', 'Received ADK event', parsed)
    }

    websocket.onerror = () => {
      setConnectionState('disconnected')
      addEvent('system', 'WebSocket error', null)
    }

    websocket.onclose = () => {
      setConnectionState('disconnected')
      websocketRef.current = null
      addSystemMessage('WebSocket closed; retrying in 5s')
      reconnectTimerRef.current = window.setTimeout(connectWebSocket, 5000)
    }
  }

  const stopAudio = () => {
    if (audioRecorderNodeRef.current) {
      audioRecorderNodeRef.current.disconnect()
      audioRecorderNodeRef.current = null
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop())
      micStreamRef.current = null
    }
    if (audioRecorderCtxRef.current) {
      audioRecorderCtxRef.current.close()
      audioRecorderCtxRef.current = null
    }
    if (audioPlayerNodeRef.current) {
      audioPlayerNodeRef.current.disconnect()
      audioPlayerNodeRef.current = null
    }
    if (audioPlayerCtxRef.current) {
      audioPlayerCtxRef.current.close()
      audioPlayerCtxRef.current = null
    }
    setAudioEnabled(false)
  }

  const startAudio = async () => {
    if (audioEnabled) {
      return
    }

    const playerContext = new AudioContext({ sampleRate: 24000 })
    const playerProcessorCode = `
      class PcmPlayerProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.bufferSize = 24000 * 30;
          this.buffer = new Float32Array(this.bufferSize);
          this.writeIndex = 0;
          this.readIndex = 0;
          this.port.onmessage = (event) => {
            const int16Data = new Int16Array(event.data);
            for (let i = 0; i < int16Data.length; i += 1) {
              this.buffer[this.writeIndex] = int16Data[i] / 32768;
              this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
              if (this.writeIndex === this.readIndex) {
                this.readIndex = (this.readIndex + 1) % this.bufferSize;
              }
            }
          };
        }

        process(inputs, outputs) {
          const out = outputs[0];
          const frameCount = out[0].length;
          for (let i = 0; i < frameCount; i += 1) {
            const sample = this.buffer[this.readIndex];
            out[0][i] = sample;
            if (out.length > 1) out[1][i] = sample;
            if (this.readIndex !== this.writeIndex) {
              this.readIndex = (this.readIndex + 1) % this.bufferSize;
            }
          }
          return true;
        }
      }
      registerProcessor('pcm-player-processor', PcmPlayerProcessor);
    `

    const playerBlob = new Blob([playerProcessorCode], { type: 'text/javascript' })
    const playerBlobUrl = URL.createObjectURL(playerBlob)
    await playerContext.audioWorklet.addModule(playerBlobUrl)
    URL.revokeObjectURL(playerBlobUrl)

    const playerNode = new AudioWorkletNode(playerContext, 'pcm-player-processor')
    playerNode.connect(playerContext.destination)

    const recorderContext = new AudioContext({ sampleRate: 16000 })
    const recorderProcessorCode = `
      class PcmRecorderProcessor extends AudioWorkletProcessor {
        process(inputs) {
          if (inputs.length > 0 && inputs[0].length > 0) {
            const inputChannel = inputs[0][0];
            this.port.postMessage(new Float32Array(inputChannel));
          }
          return true;
        }
      }
      registerProcessor('pcm-recorder-processor', PcmRecorderProcessor);
    `

    const recorderBlob = new Blob([recorderProcessorCode], { type: 'text/javascript' })
    const recorderBlobUrl = URL.createObjectURL(recorderBlob)
    await recorderContext.audioWorklet.addModule(recorderBlobUrl)
    URL.revokeObjectURL(recorderBlobUrl)

    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1 },
      video: false,
    })

    const source = recorderContext.createMediaStreamSource(mediaStream)
    const recorderNode = new AudioWorkletNode(recorderContext, 'pcm-recorder-processor')
    source.connect(recorderNode)

    recorderNode.port.onmessage = (event) => {
      const pcmBuffer = toPcm16Buffer(event.data)
      sendBinaryPayload(BINARY_FRAME_TYPE_AUDIO_PCM16, pcmBuffer)
    }

    audioPlayerCtxRef.current = playerContext
    audioPlayerNodeRef.current = playerNode
    audioRecorderCtxRef.current = recorderContext
    audioRecorderNodeRef.current = recorderNode
    micStreamRef.current = mediaStream

    setAudioEnabled(true)
    addSystemMessage('Audio streaming enabled')
  }

  const sendSnapshot = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 768 }, height: { ideal: 768 } },
      audio: false,
    })

    const video = document.createElement('video')
    video.srcObject = stream
    await video.play()

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 768
    canvas.height = video.videoHeight || 768
    const context = canvas.getContext('2d')
    context.drawImage(video, 0, 0, canvas.width, canvas.height)

    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.85)
    })

    if (blob) {
      const imageBuffer = await blob.arrayBuffer()
      sendBinaryPayload(BINARY_FRAME_TYPE_IMAGE_JPEG, imageBuffer)

      const imageUrl = URL.createObjectURL(blob)
      setMessages((previous) => [
        ...previous,
        { id: makeId(), role: 'user', imageUrl, text: 'Snapshot sent', final: true },
      ])
      addEvent('up', 'Sent image snapshot', { bytes: imageBuffer.byteLength })
    }

    stream.getTracks().forEach((track) => track.stop())
  }

  const stopLiveCamera = () => {
    if (cameraFrameTimerRef.current) {
      window.clearInterval(cameraFrameTimerRef.current)
      cameraFrameTimerRef.current = null
    }
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop())
      cameraStreamRef.current = null
    }
    if (liveVideoRef.current) {
      liveVideoRef.current.srcObject = null
    }
    setLiveCamEnabled(false)
  }

  const startLiveCamera = async () => {
    if (liveCamEnabled) {
      return
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 768 },
        height: { ideal: 768 },
        facingMode: 'user',
      },
      audio: false,
    })

    cameraStreamRef.current = stream
    if (liveVideoRef.current) {
      liveVideoRef.current.srcObject = stream
      await liveVideoRef.current.play()
    }

    setFramesSent(0)
    setLiveCamEnabled(true)

    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')

    cameraFrameTimerRef.current = window.setInterval(async () => {
      const video = liveVideoRef.current
      if (!video || !video.videoWidth || !video.videoHeight) {
        return
      }

      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      context.drawImage(video, 0, 0, canvas.width, canvas.height)

      const blob = await new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', 0.75)
      })

      if (!blob) {
        return
      }

      const imageBuffer = await blob.arrayBuffer()
      sendBinaryPayload(BINARY_FRAME_TYPE_IMAGE_JPEG, imageBuffer)
      setFramesSent((value) => value + 1)
    }, 1000)

    addSystemMessage('Live camera started at 1 FPS')
  }

  const sendTextMessage = (event) => {
    event.preventDefault()
    const trimmed = textInput.trim()
    if (!trimmed) {
      return
    }

    const didSend = sendTextPayload({ type: 'text', text: trimmed })
    if (didSend) {
      setMessages((previous) => [
        ...previous,
        { id: makeId(), role: 'user', text: trimmed, final: true },
      ])
      setTextInput('')
      lastAssistantMessageIdRef.current = null
    }
  }

  const applyRunOptionChange = (setter, value) => {
    setter(value)
    if (connectionState === 'connected' && websocketRef.current) {
      websocketRef.current.close()
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    connectWebSocket()

    return () => {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current)
      }
      if (websocketRef.current) {
        websocketRef.current.close()
      }
      stopAudio()
      stopLiveCamera()
    }
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Hello Professor</h1>
          <p>Live student mentor with text, voice, and visual context</p>
        </div>
        <div className="status-wrap">
          <span className={`status-dot ${connectionState === 'connected' ? 'ok' : ''}`} />
          <span>{connectionState}</span>
        </div>
      </header>

      <section className="controls">
        <label>
          Backend URL
          <input
            value={backendHttpBase}
            onChange={(event) => setBackendHttpBase(event.target.value)}
            placeholder="http://localhost:8080"
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={proactivity}
            onChange={(event) =>
              applyRunOptionChange(setProactivity, event.target.checked)
            }
          />
          Proactivity
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={affectiveDialog}
            onChange={(event) =>
              applyRunOptionChange(setAffectiveDialog, event.target.checked)
            }
          />
          Affective dialog
        </label>
        <button type="button" onClick={connectWebSocket}>
          Reconnect
        </button>
      </section>

      <main className="main-grid">
        <section className="panel chat-panel">
          <div className="panel-title">Conversation</div>
          <div className="messages">
            {messages.map((message) => (
              <div key={message.id} className={`bubble ${message.role}`}>
                {message.imageUrl ? (
                  <img src={message.imageUrl} alt="sent snapshot" className="bubble-image" />
                ) : (
                  <span>{message.text}</span>
                )}
              </div>
            ))}
          </div>
          <form className="composer" onSubmit={sendTextMessage}>
            <input
              value={textInput}
              onChange={(event) => setTextInput(event.target.value)}
              placeholder="Ask your professor assistant..."
            />
            <button type="submit">Send</button>
          </form>
          <div className="action-row">
            <button type="button" onClick={() => (audioEnabled ? stopAudio() : startAudio())}>
              {audioEnabled ? 'Stop Audio' : 'Start Audio'}
            </button>
            <button type="button" onClick={sendSnapshot}>
              Send Snapshot
            </button>
            <button
              type="button"
              onClick={() => (liveCamEnabled ? stopLiveCamera() : startLiveCamera())}
            >
              {liveCamEnabled ? 'Stop Live Cam' : 'Start Live Cam (1 FPS)'}
            </button>
          </div>
        </section>

        <section className="panel camera-panel">
          <div className="panel-title">Live Camera</div>
          <video ref={liveVideoRef} autoPlay playsInline muted className="live-video" />
          <div className="camera-meta">
            <span>Status: {liveCamEnabled ? 'streaming' : 'stopped'}</span>
            <span>Frames sent: {framesSent}</span>
          </div>
        </section>

        <section className="panel event-panel">
          <div className="panel-title">Event Log</div>
          <div className="events">
            {events.map((entry) => (
              <details key={entry.id} className={`event ${entry.direction}`}>
                <summary>
                  <strong>{entry.direction.toUpperCase()}</strong> {entry.summary}{' '}
                  <span>{entry.timestamp}</span>
                </summary>
                {entry.payload ? <pre>{JSON.stringify(entry.payload, null, 2)}</pre> : null}
              </details>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
