import { OpenAIRealtimeWebSocket, RealtimeAgent, RealtimeSession } from "@openai/agents-realtime";
import { WavRecorder, WavStreamPlayer } from "wavtools";


const startBtn = document.getElementById("startBtn");
const statusTxt = document.getElementById("statusTxt");
const logEl = document.getElementById("log");

// Backend endpoint that mints a client secret at ElevenLabs. Returns { "value": "<client secret>" }.
const TOKEN_URL = "/api/token";

// Sends a text prompt right after the session is ready, to test the output path without the mic.
const TEST_GREETING = false;

// Echo protection: do not send mic audio while the agent's audio is still playing.
// Set to false if you use headphones and want to be able to interrupt the agent.
const HALF_DUPLEX = true;

// How long to keep the mic closed after the agent's audio has finished playing.
const ECHO_TAIL_MS = 800;

// Optional barge-in while the agent speaks: mic chunks louder than this RMS are still sent.
// 0 = disabled (safest against loops). Try 3000-6000 with headphones or a quiet speaker.
const BARGE_IN_RMS = 0;

// Noise gate: send mic audio to ElevenLabs only while you are speaking.
const GATE = {
  enabled: true,
  rmsThreshold: 800, // raise if background noise gets through, lower if quiet speech is cut
  hangoverMs: 800,   // keep sending this long after the last loud chunk (server needs trailing silence)
  preRollMs: 300,    // audio from just BEFORE speech starts, so the first syllable isn't cut
  chunkSize: 1024,   // samples per chunk at 24 kHz (~43 ms) – smaller = more responsive gate
  debug: false,      // true = log the RMS level about once per second (helps to tune rmsThreshold)
};

function log(msg) {
  const div = document.createElement("div");
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// ------------------------------------------------------------------------------
// Diagnostic: log every WebSocket open/close/error (with close code and reason). 
// Reveals WHY the server drops the connection.
// ------------------------------------------------------------------------------
const NativeWebSocket = window.WebSocket;
window.WebSocket = class extends NativeWebSocket {
  constructor(...args) {
    super(...args);
    const shortUrl = String(args[0]).split("?")[0];
    this.addEventListener("open", () => log(`WS open: ${shortUrl}`));
    this.addEventListener("close", (e) =>
      log(`WS close: code=${e.code} reason="${e.reason || "-"}" clean=${e.wasClean}`)
    );
    this.addEventListener("error", () => log("WebSocket error"));
  }
};

// wavtools calls getUserMedia({ audio: true }) internally; ask the browser explicitly
// for acoustic echo cancellation and noise suppression on that stream.
if (navigator.mediaDevices?.getUserMedia) {
  const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (constraints) => {
    if (constraints && constraints.audio) {
      const base = typeof constraints.audio === "object" ? constraints.audio : {};
      constraints = {
        ...constraints,
        audio: { ...base, echoCancellation: true, noiseSuppression: true },
      };
    }
    return nativeGetUserMedia(constraints);
  };
}

let session = null;
let wavRecorder = null;
let wavStreamPlayer = null;
let playUntil = 0;      // timestamp (ms) until which queued agent audio is playing
let connected = false;  // true only while the transport reports "connected"

function rmsOf(arrayBuffer) {
  const s = new Int16Array(arrayBuffer);
  if (!s.length) return 0;
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i] * s[i];
  return Math.sqrt(sum / s.length);
}

async function getClientSecret() {
  log("Retrieving client secret...");
  const res = await fetch(TOKEN_URL, { method: "POST", cache: "no-store" });
  const raw = await res.text();

  if (!res.ok) {
    throw new Error(`Token HTTP ${res.status}: ${raw.slice(0, 80)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Response is not in JSON format (beginning: ${raw.slice(0, 60).replace(/\s+/g, " ")})`);
  }

  if (!parsed.value) throw new Error("Missing 'value' in response");
  return parsed.value;
}

async function cleanup() {
  connected = false;
  try { await wavRecorder?.end(); } catch {}
  try { await wavStreamPlayer?.interrupt(); } catch {}
  try { session?.close(); } catch {}
}

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  statusTxt.innerText = "Connecting...";
  statusTxt.style.color = "";
  connected = false;

  try {
    // ------------------------------------------------------------------
    // 1. Audio device
    // ------------------------------------------------------------------
    wavRecorder = new WavRecorder({ sampleRate: 24000 });
    wavStreamPlayer = new WavStreamPlayer({ sampleRate: 24000 });

    log("Audio initialization...");
    await wavStreamPlayer.connect();
    try { await wavStreamPlayer.context?.resume?.(); } catch {}
    log(`AudioContext: ${wavStreamPlayer.context?.state}, ${wavStreamPlayer.context?.sampleRate} Hz`);

    log("Provide access to use microphone...");
    await wavRecorder.begin();
    log("Microphone enabled.");
    try {
      const st = wavRecorder.stream?.getAudioTracks?.()[0]?.getSettings?.();
      if (st) {
        log(`Microphone: echoCancellation=${st.echoCancellation}, noiseSuppression=${st.noiseSuppression}, autoGainControl=${st.autoGainControl}`);
      }
    } catch {}

    // ------------------------------------------------------------------
    // 2. Client secret
    // ------------------------------------------------------------------
    const clientSecret = await getClientSecret();

    // ------------------------------------------------------------------
    // 3. SDK session
    // ------------------------------------------------------------------
    const agent = new RealtimeAgent({
      name: "ElevenLabs agent",
      instructions: "You are a helpful, friendly voice assistant. Keep replies concise.",
    });

    const transport = new OpenAIRealtimeWebSocket({
      url: "wss://api.elevenlabs.io/v1/convai/realtime",
    });

    session = new RealtimeSession(agent, {
      transport,
      model: "eleven_realtime_v1_mini",
      config: {
        outputModalities: ["audio"],
        audio: { output: { voice: "brian" } },
      },
    });

    // ------------------------------------------------------------------
    // 4. Event handlers (register before connect)
    // ------------------------------------------------------------------
    transport.on("connection_change", (status) => {
      connected = status === "connected";
      log(`Transport: ${status}`);
      if (status === "disconnected") {
        statusTxt.innerText = "Disconnected";
        statusTxt.style.color = "";
      }
    });

    let responseAudioChunks = 0; // audio chunks received for the current response
    playUntil = 0;

    session.on("audio", (event) => {
      responseAudioChunks++;
      if (responseAudioChunks === 1) log("Audio response:");

      // Browser may suspend the context again (e.g. tab in background)
      const ctx = wavStreamPlayer.context;
      if (ctx && ctx.state !== "running") {
        log(`AudioContext był "${ctx.state}" - resume`);
        ctx.resume().catch(() => {});
      }

      // Track when the queued audio will finish playing (24 kHz, 16-bit mono)
      const durationMs = (event.data.byteLength / 2 / 24000) * 1000;
      playUntil = Math.max(playUntil, Date.now()) + durationMs;

      wavStreamPlayer.add16BitPCM(event.data); // ArrayBuffer, PCM16
    });

    session.on("audio_interrupted", () => {
      log("Audio interrrupted.");
      playUntil = 0;
      wavStreamPlayer.interrupt();
    });

    session.on("error", (e) => {
      console.error("Session error:", e);
      log(`Session error: ${e?.error?.message || e?.message || JSON.stringify(e)}`);
    });

    // Resolve when the server confirms the session (or after a short timeout)
    let sessionReadyResolve;
    const sessionReady = new Promise((resolve) => { sessionReadyResolve = resolve; });

    session.on("transport_event", (ev) => {
      console.debug("Transport event", ev.type, ev);

      if (ev.type === "session.created" || ev.type === "session.updated") {
        log(`Server: ${ev.type}`);
        sessionReadyResolve();
      }

      if (ev.type === "error") {
        log(`Server error: ${ev.error?.message || JSON.stringify(ev)}`);
      }

      if (ev.type === "response.created") {
        responseAudioChunks = 0;
      }

      if (ev.type === "response.done") {
        const status = ev.response?.status || "?";
        log(`End of response: status=${status}, audio chunks=${responseAudioChunks}`);
        if (responseAudioChunks === 0) {
          log("Server didn't sent audio response.");
        }
      }

      if (
        ev.type === "input_audio_buffer.speech_started" ||
        ev.type === "input_audio_buffer.speech_stopped"
      ) {
        log(`VAD: ${ev.type}`);
      }

      if (
        ev.type === "response.output_audio_transcript.done" ||
        ev.type === "response.audio_transcript.done"
      ) {
        log(`Agent: ${ev.transcript}`);
      }

      if (
        ev.type === "conversation.item.input_audio_transcription.completed" &&
        ev.transcript
      ) {
        log(`Ty: ${ev.transcript}`);
      }
    });

    // ------------------------------------------------------------------
    // 5. Connect, then make sure the socket is still open
    // ------------------------------------------------------------------
    log("WebSocket connection with ElevenLabs...");
    await session.connect({ apiKey: clientSecret });
    log("session.connect() ended.");

    await Promise.race([sessionReady, new Promise((r) => setTimeout(r, 3000))]);

    if (!connected) {
      throw new Error(
        "Server closed connection"
      );
    }

    // ------------------------------------------------------------------
    // 6. Stream microphone – noise gate: send audio only while speaking
    // ------------------------------------------------------------------
    let lastVoiceAt = 0;
    let preRoll = [];
    let chunkCount = 0;
    let gateWasOpen = false;

    let micClosed = false;

    await wavRecorder.record((data) => {
      if (!connected) return;

      const now = Date.now();
      const chunk = data.mono;
      const chunkMs = (chunk.byteLength / 2 / 24000) * 1000;
      const rms = rmsOf(chunk);

      // Agent audio is playing (plus echo tail): keep the mic closed
      const agentSpeaking = HALF_DUPLEX && now < playUntil + ECHO_TAIL_MS;
      const bargeIn = BARGE_IN_RMS > 0 && rms > BARGE_IN_RMS;

      if (agentSpeaking && !bargeIn) {
        if (!micClosed) { micClosed = true; log("Microphone is muted"); }
        preRoll = [];     // never keep the agent's own voice as "lead-in"
        lastVoiceAt = 0;  // and don't carry the gate hangover over
        gateWasOpen = false;
        return;
      }
      if (micClosed) { micClosed = false; log("Microphone is active"); }

      chunkCount++;
      if (GATE.debug && chunkCount % Math.round(1000 / chunkMs) === 0) {
        log(`Input level: rms=${Math.round(rms)} (próg ${GATE.rmsThreshold})`);
      }

      try {
        if (!GATE.enabled) {
          session.sendAudio(chunk);
          return;
        }

        if (rms > GATE.rmsThreshold) lastVoiceAt = now;
        const gateOpen = now - lastVoiceAt < GATE.hangoverMs;

        if (gateOpen) {
          if (!gateWasOpen) log("Sending audio");
          // flush the buffered lead-in first, then the current chunk
          for (const c of preRoll) session.sendAudio(c);
          preRoll = [];
          session.sendAudio(chunk);
        } else {
          if (gateWasOpen) log("Silence detected - not sending data");
          // silence: keep only a short rolling buffer, send nothing
          preRoll.push(chunk);
          const maxChunks = Math.max(1, Math.ceil(GATE.preRollMs / chunkMs));
          while (preRoll.length > maxChunks) preRoll.shift();
        }
        gateWasOpen = gateOpen;
      } catch (e) {
        connected = false;
        log(`sendAudio failed: ${e.message}`);
      }
    }, GATE.chunkSize);

    statusTxt.innerText = "Connected";
    statusTxt.style.color = "#11a37f";
    log("Session is ready. Start speaking.");

    if (TEST_GREETING && connected) {
      log("Test: sending text message to agent...");
      session.sendMessage("Say hello in one short sentence.");
    }
  } catch (err) {
    console.error("Connection error:", err);
    statusTxt.innerText = "Error";
    statusTxt.style.color = "";
    log(`Error: ${err.message}`);
    await cleanup();
    startBtn.disabled = false;
  }
});