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


// --------------------------------------------------------------------------------------------
// Latency measurement: end of your speech -> first agent audio you can hear
//
//   lastLoudAt ........ last mic chunk above GATE.rmsThreshold (you stop talking)
//   speech_stopped .... server decided your turn is over        -> "End-of-speech detection"
//   response.created .. server started an answer                -> "Response start"
//   first audio chunk . first agent audio arrives in the browser -> "Generation to 1st audio"
//   + AudioContext output latency (dot on the chart) = what you actually hear
//
// Timestamps use performance.now(). Accuracy is roughly +/- one mic chunk (~45 ms).
// --------------------------------------------------------------------------------------------
const LATENCY_MAX_TURNS = 30;
const LAT_COLORS = { detect: "#7F77DD", start: "#1D9E75", gen: "#EF9F27" };

const latencyTurns = []; // finished turns, newest last (also available as window.latencyTurns)
window.latencyTurns = latencyTurns;

let lastLoudAt = 0;   // performance.now() of the last loud mic chunk
let onsetAt = 0;      // performance.now() of the first loud chunk of the current utterance
let currentTurn = null;
let turnSeq = 0;

function resetLatencyState() {
  lastLoudAt = 0;
  onsetAt = 0;
  currentTurn = null;
}

// Called for every mic chunk that reaches the gate logic (mic not muted)
function noteMicLevel(rms) {
  if (rms <= GATE.rmsThreshold) return;
  const t = performance.now();
  if (t - lastLoudAt > 1500) onsetAt = t; // a new utterance starts
  lastLoudAt = t;
}

// Called for every raw server event
function onLatencyEvent(type) {
  const now = performance.now();

  if (type === "input_audio_buffer.speech_started") {
    currentTurn = {
      id: ++turnSeq,
      // upstream + VAD + downstream: how long the server needed to notice you started talking
      onsetLag: onsetAt && now - onsetAt < 5000 ? now - onsetAt : null,
    };
  } else if (type === "input_audio_buffer.speech_stopped" && currentTurn) {
    currentTurn.stoppedAt = now;
    currentTurn.endAt = lastLoudAt && now - lastLoudAt < 5000 ? lastLoudAt : null;
  } else if (type === "response.created" && currentTurn && !currentTurn.createdAt) {
    currentTurn.createdAt = now;
  }
}

// Called when the FIRST audio chunk of a response arrives
function finishLatencyTurn() {
  const t = currentTurn;
  if (!t || !t.stoppedAt) return; // e.g. test greeting or a response not triggered by your voice
  currentTurn = null;

  const firstAudioAt = performance.now();
  const endAt = t.endAt ?? t.stoppedAt;
  const createdAt = Math.max(t.createdAt ?? t.stoppedAt, t.stoppedAt);

  const detect = Math.max(0, t.stoppedAt - endAt);
  const start = createdAt - t.stoppedAt;
  const gen = Math.max(0, firstAudioAt - createdAt);

  const ctx = wavStreamPlayer?.context;
  const output = ((ctx?.outputLatency ?? ctx?.baseLatency) || 0) * 1000;

  const total = detect + start + gen;
  const turn = {
    id: t.id,
    detect,
    start,
    gen,
    total,                       // end of speech -> first audio chunk received
    output,                      // browser audio output latency (estimate)
    perceived: total + output,   // end of speech -> sound starts in the speakers
    onset: t.onsetLag,
  };

  latencyTurns.push(turn);
  while (latencyTurns.length > LATENCY_MAX_TURNS) latencyTurns.shift();

  log(
    `Latency #${turn.id}: ${Math.round(turn.perceived)} ms ` +
    `(end of speech ${Math.round(detect)} + response start ${Math.round(start)} + ` +
    `to 1st audio ${Math.round(gen)} + output ${Math.round(output)})`
  );

  drawLatencyChart();
  renderLatencyStats();
}

function percentile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (!n) return 0;
  return sortedAsc[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];
}

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

// Chart + stats panel (created below the log; no changes to index.html needed.
// If your page already has <canvas id="latencyChart"> / <div id="latencyStats">, they are used instead.)
function createLatencyPanel() {
  let canvas = document.getElementById("latencyChart");
  let stats = document.getElementById("latencyStats");
  if (!canvas) {
    const panel = document.createElement("div");
    panel.style.cssText = "margin-top:16px";

    const title = document.createElement("div");
    title.textContent = "End-to-end latency (end of your speech → first agent audio)";
    title.style.cssText = "font-size:13px;font-weight:600;margin-bottom:6px";

    canvas = document.createElement("canvas");
    canvas.id = "latencyChart";
    canvas.style.cssText = "width:100%;max-width:760px;height:260px;display:block";

    stats = document.createElement("div");
    stats.id = "latencyStats";
    stats.style.cssText = "font-size:12px;white-space:pre-wrap;margin-top:6px";

    panel.append(title, canvas, stats);
    logEl.parentNode.insertBefore(panel, logEl.nextSibling);
  }
  return { canvas, stats };
}

const { canvas: latencyCanvas, stats: latencyStatsEl } = createLatencyPanel();

function drawLatencyChart() {
  const c = latencyCanvas;
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth || 640;
  const H = 260;
  c.width = Math.round(W * dpr);
  c.height = Math.round(H * dpr);

  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const fg = getComputedStyle(c).color || "#888"; // follows the page's text colour (light/dark)
  const m = { l: 50, r: 12, t: 46, b: 26 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  g.font = "11px sans-serif";

  // ---- legend (wraps to a second row on narrow screens)
  const legend = [
    { col: LAT_COLORS.detect, label: "End-of-speech detection" },
    { col: LAT_COLORS.start, label: "Response start" },
    { col: LAT_COLORS.gen, label: "Generation to 1st audio" },
    { col: fg, label: "incl. audio output latency", dot: true },
  ];
  let lx = m.l;
  let ly = 12;
  g.textAlign = "left";
  for (const it of legend) {
    const w = 14 + g.measureText(it.label).width + 14;
    if (lx + w > W - 8 && lx > m.l) { lx = m.l; ly += 16; }
    g.fillStyle = it.col;
    if (it.dot) {
      g.beginPath();
      g.arc(lx + 5, ly - 3, 3.5, 0, Math.PI * 2);
      g.fill();
    } else {
      g.fillRect(lx, ly - 9, 10, 10);
    }
    g.fillStyle = fg;
    g.fillText(it.label, lx + 14, ly);
    lx += w;
  }

  if (!latencyTurns.length) {
    g.fillStyle = fg;
    g.globalAlpha = 0.6;
    g.textAlign = "center";
    g.fillText("No measurements yet – say something to the agent", W / 2, m.t + ph / 2);
    g.globalAlpha = 1;
    return;
  }

  // ---- y axis
  const maxVal = Math.max(...latencyTurns.map((t) => t.perceived));
  const step = niceStep(maxVal / 4);
  const yMax = Math.max(step, Math.ceil(maxVal / step) * step);
  const yOf = (v) => m.t + ph - (v / yMax) * ph;

  g.strokeStyle = "rgba(128,128,128,0.25)";
  g.lineWidth = 1;
  g.fillStyle = fg;
  g.textAlign = "right";
  for (let v = 0; v <= yMax + 1e-6; v += step) {
    const y = Math.round(yOf(v)) + 0.5;
    g.beginPath();
    g.moveTo(m.l, y);
    g.lineTo(W - m.r, y);
    g.stroke();
    g.fillText(String(Math.round(v)), m.l - 6, y + 4);
  }
  g.save();
  g.translate(12, m.t + ph / 2);
  g.rotate(-Math.PI / 2);
  g.textAlign = "center";
  g.fillText("ms", 0, 0);
  g.restore();

  // ---- stacked bars + dot for "perceived" latency
  const slots = Math.max(latencyTurns.length, 10);
  const slot = pw / slots;
  const barW = Math.min(40, slot * 0.7);
  const labelEvery = Math.max(1, Math.ceil(26 / slot));
  const parts = [["detect", LAT_COLORS.detect], ["start", LAT_COLORS.start], ["gen", LAT_COLORS.gen]];

  latencyTurns.forEach((t, i) => {
    const x = m.l + i * slot + (slot - barW) / 2;
    const cx = x + barW / 2;
    let acc = 0;
    for (const [key, col] of parts) {
      const y0 = yOf(acc);
      const y1 = yOf(acc + t[key]);
      g.fillStyle = col;
      g.fillRect(x, y1, barW, Math.max(0, y0 - y1));
      acc += t[key];
    }
    g.fillStyle = fg;
    g.beginPath();
    g.arc(cx, yOf(t.perceived), 3, 0, Math.PI * 2);
    g.fill();
    g.textAlign = "center";
    if (slot >= 34) g.fillText(String(Math.round(t.perceived)), cx, yOf(t.perceived) - 7);
    if (i % labelEvery === 0) g.fillText("#" + t.id, cx, H - 8);
  });

  // ---- median line
  const sorted = latencyTurns.map((t) => t.perceived).sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  g.save();
  g.setLineDash([4, 4]);
  g.strokeStyle = fg;
  g.globalAlpha = 0.6;
  g.beginPath();
  g.moveTo(m.l, yOf(p50));
  g.lineTo(W - m.r, yOf(p50));
  g.stroke();
  g.restore();
  g.fillStyle = fg;
  g.textAlign = "right";
  g.fillText(`median ${Math.round(p50)} ms`, W - m.r - 2, yOf(p50) - 4);
}

function renderLatencyStats() {
  const arr = latencyTurns;
  if (!arr.length) { latencyStatsEl.textContent = ""; return; }

  const sorted = arr.map((t) => t.perceived).sort((a, b) => a - b);
  const avg = (k) => Math.round(arr.reduce((s, t) => s + t[k], 0) / arr.length);
  const last = arr[arr.length - 1];
  const lines = [
    `Turns: ${arr.length} · last: ${Math.round(last.perceived)} ms · median: ${Math.round(percentile(sorted, 50))} ms · ` +
      `p95: ${Math.round(percentile(sorted, 95))} ms · min–max: ${Math.round(sorted[0])}–${Math.round(sorted[sorted.length - 1])} ms`,
    `Average: end of speech ${avg("detect")} ms + response start ${avg("start")} ms + to 1st audio ${avg("gen")} ms + audio output ${avg("output")} ms`,
  ];
  const onsets = arr.filter((t) => t.onset != null);
  if (onsets.length) {
    const o = Math.round(onsets.reduce((s, t) => s + t.onset, 0) / onsets.length);
    lines.push(`Server detection of speech start (network + VAD): ~${o} ms (average)`);
  }
  latencyStatsEl.textContent = lines.join("\n");
}

window.addEventListener("resize", drawLatencyChart);
drawLatencyChart();

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
  resetLatencyState();

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
      if (responseAudioChunks === 1) {
        log("Server audio: response started");
        finishLatencyTurn(); // latency: first agent audio arrived
      }

      // Browser may suspend the context again (e.g. tab in background)
      const ctx = wavStreamPlayer.context;
      if (ctx && ctx.state !== "running") {
        log(`AudioContext was "${ctx.state}" – resuming`);
        ctx.resume().catch(() => {});
      }

      // Track when the queued audio will finish playing (24 kHz, 16-bit mono)
      const durationMs = (event.data.byteLength / 2 / 24000) * 1000;
      playUntil = Math.max(playUntil, Date.now()) + durationMs;

      wavStreamPlayer.add16BitPCM(event.data); // ArrayBuffer, PCM16
    });

    session.on("audio_interrupted", () => {
      log("Audio interrupted by the server (speech / noise detected on the input).");
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
      onLatencyEvent(ev.type);

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
        log(`Response finished: status=${status}, audio chunks=${responseAudioChunks}`);
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
        log(`You: ${ev.transcript}`);
      }
    });

    // ------------------------------------------------------------------
    // 5. Connect, then make sure the socket is still open
    // ------------------------------------------------------------------
    log("Connecting WebSocket to ElevenLabs...");
    await session.connect({ apiKey: clientSecret });
    log("session.connect() finished.");

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
        if (!micClosed) { micClosed = true; log("Microphone muted (agent is speaking)"); }
        preRoll = [];     // never keep the agent's own voice as "lead-in"
        lastVoiceAt = 0;  // and don't carry the gate hangover over
        gateWasOpen = false;
        return;
      }
      if (micClosed) { micClosed = false; log("Microphone active"); }

      noteMicLevel(rms); // latency: remember when you were last loud

      chunkCount++;
      if (GATE.debug && chunkCount % Math.round(1000 / chunkMs) === 0) {
        log(`Input level: rms=${Math.round(rms)} (threshold ${GATE.rmsThreshold})`);
      }

      try {
        if (!GATE.enabled) {
          session.sendAudio(chunk);
          return;
        }

        if (rms > GATE.rmsThreshold) lastVoiceAt = now;
        const gateOpen = now - lastVoiceAt < GATE.hangoverMs;

        if (gateOpen) {
          if (!gateWasOpen) log("Gate: sending audio");
          // flush the buffered lead-in first, then the current chunk
          for (const c of preRoll) session.sendAudio(c);
          preRoll = [];
          session.sendAudio(chunk);
        } else {
          if (gateWasOpen) log("Gate: silence – sending paused");
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

    statusTxt.innerText = "Connected!";
    statusTxt.style.color = "#11a37f";
    log("Session ready. Start speaking into the microphone.");

    if (TEST_GREETING && connected) {
      log("Test: sending a text message to the agent...");
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