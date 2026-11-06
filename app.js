import { normaliseRoomCode, formatRoomCode, deriveRoomKeys, sealText, openText } from "./crypto.js";
import { Rendezvous } from "./mqtt.js";

const PREFIX = "syncstream/v2/";
const MAGIC = 0x434e5953, VERSION = 3;
const T = { Hello: 1, Ping: 2, Pong: 3, Config: 4, Audio: 5, Bye: 6, Punch: 7 };
const $ = (id) => document.getElementById(id);

let keys = null, rdv = null, pc = null, dc = null, clientId = "";
let config = null, ctx = null, node = null, helloTimer = 0, offerTimer = 0, answered = false;
let lastPacket = 0, workletStats = null, phase = "idle";

function setStatus(text, kind = "") { $("status").textContent = text; $("status").className = "status " + kind; }

let outLatFrames = 0;
function sendHello() {
  if (!dc || dc.readyState !== "open") return;
  const b = new ArrayBuffer(12), v = new DataView(b);
  v.setUint32(0, MAGIC, true); v.setUint8(4, T.Hello); v.setUint8(5, VERSION);
  v.setUint32(8, outLatFrames, true); // tells the sender how late our speaker is
  dc.send(b);
}

function header(type) {
  const b = new ArrayBuffer(8), v = new DataView(b);
  v.setUint32(0, MAGIC, true); v.setUint8(4, type); v.setUint8(5, VERSION);
  return b;
}

async function start(codeInput) {
  const code = normaliseRoomCode(codeInput);
  if (!code) { setStatus("방 코드가 올바르지 않아요 (8자리)", "warn"); return; }
  localStorage.setItem("code", code);
  $("code").value = formatRoomCode(code);
  stop();
  phase = "keys"; setStatus("보안 연결 준비 중...", "warn");
  keys = await deriveRoomKeys(code);
  clientId = Math.random().toString(36).slice(2, 12);
  const answerTopic = PREFIX + keys.topicId + "/w/" + clientId;
  rdv = new Rendezvous([answerTopic], onSignal);
  phase = "offer"; setStatus("방을 찾는 중...", "warn");
  await makeOffer();
}

function stop() {
  clearInterval(helloTimer); clearInterval(offerTimer);
  try { dc && dc.close(); } catch {}
  try { pc && pc.close(); } catch {}
  try { rdv && rdv.close(); } catch {}
  dc = pc = rdv = null; answered = false; config = null;
}

async function makeOffer() {
  pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }] });
  dc = pc.createDataChannel("audio", { ordered: false, maxRetransmits: 0 });
  dc.binaryType = "arraybuffer";
  dc.onopen = () => {
    phase = "connected"; setStatus("연결됨 — 지연 측정 중", "warn");
    clearInterval(offerTimer);
    helloTimer = setInterval(sendHello, 500);
    sendHello();
  };
  dc.onmessage = (e) => onPacket(e.data);
  dc.onclose = () => { if (phase === "connected") { setStatus("연결이 끊겼어요 — 다시 연결 중...", "warn"); retry(); } };
  pc.onconnectionstatechange = () => { if (pc && pc.connectionState === "failed") retry(); };

  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((res) => {
    if (pc.iceGatheringState === "complete") return res();
    const t = setTimeout(res, 3000);
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); res(); } };
  });
  const send = async () => {
    if (answered || !rdv) return;
    const payload = await sealText(keys, JSON.stringify({ id: clientId, sdp: pc.localDescription.sdp }));
    rdv.publish(PREFIX + keys.topicId + "/w", payload);
  };
  rdv.onConnected = send;
  send();
  offerTimer = setInterval(() => {
    send();
    if (!answered) setStatus(rdv && rdv.online ? "방을 찾는 중... (보내는 사람 플러그인이 켜져 있나요?)" : "인터넷 연결 확인 중...", "warn");
  }, 3000);
}

let retrying = false;
function retry() {
  if (retrying) return; retrying = true;
  setTimeout(() => { retrying = false; const c = localStorage.getItem("code"); if (c) start(c); }, 1500);
}

async function onSignal(topic, payload) {
  if (answered || !pc) return;
  const text = await openText(keys, payload);
  if (!text) return;
  try {
    const m = JSON.parse(text);
    if (!m.sdp) return;
    answered = true;
    phase = "answer"; setStatus("상대 PC와 연결하는 중...", "warn");
    await pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
  } catch { answered = false; }
}

function onPacket(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 8) return;
  const v = new DataView(buf);
  if (v.getUint32(0, true) !== MAGIC || v.getUint8(5) !== VERSION) return;
  const type = v.getUint8(4);
  lastPacket = performance.now();
  if (type === T.Ping && buf.byteLength >= 16) {
    v.setUint8(4, T.Pong); dc.send(buf); // echo straight back: this is how the plugin measures the delay
  } else if (type === T.Config && buf.byteLength >= 28) {
    const c = { session: v.getUint32(8, true), rate: v.getUint32(12, true), latency: v.getUint32(16, true),
                oneWay: v.getUint32(20, true), senderOut: v.getUint32(24, true) };
    const first = !config;
    config = c;
    if (node) node.port.postMessage({ type: "config", ...c });
    if (first) onFirstConfig();
  } else if (type === T.Audio && buf.byteLength >= 20 + 1024) {
    if (!node) return;
    const cur = new Float32Array(buf.slice(20, 532));
    const prev = v.getUint8(16) ? new Float32Array(buf.slice(532, 1044)) : null;
    node.port.postMessage({ type: "audio", session: v.getUint32(8, true), seq: v.getUint32(12, true), cur, prev },
                          prev ? [cur.buffer, prev.buffer] : [cur.buffer]);
  }
}

function onFirstConfig() {
  if (ctx) { node && node.port.postMessage({ type: "config", ...config }); return; }
  setStatus("준비됐어요 — 아래 버튼을 누르면 들려요", "ok");
  $("play").hidden = false;
}

async function startAudio() {
  if (!config) return;
  $("play").hidden = true;
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {} // iPhone: play even in silent mode
  ctx = new AudioContext({ sampleRate: config.rate, latencyHint: "interactive" });
  await ctx.audioWorklet.addModule("player-worklet.js");
  node = new AudioWorkletNode(ctx, "sync-player", { numberOfInputs: 0, outputChannelCount: [2] });
  node.connect(ctx.destination);
  window.__onsets = [];
  node.port.onmessage = (e) => {
    if (e.data.type === "onset") {
      // wall-clock moment this sample reaches the speaker (getOutputTimestamp includes output latency)
      const ts = ctx.getOutputTimestamp();
      window.__onsets.push(performance.timeOrigin + ts.performanceTime + (e.data.ctxTime - ts.contextTime) * 1000);
      if (window.__onsets.length > 50) window.__onsets.shift();
    } else workletStats = e.data;
  };
  node.port.postMessage({ type: "config", ...config });
  node.port.postMessage({ type: "extra", ms: Number($("sync").value) });
  const sendLatency = () => {
    const sec = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    outLatFrames = Math.round(sec * ctx.sampleRate) + 128;
    node.port.postMessage({ type: "outLat", frames: outLatFrames });
  };
  sendLatency(); setInterval(sendLatency, 2000);
  await ctx.resume();
  try { await navigator.wakeLock?.request("screen"); } catch {}
}

function render() {
  const s = workletStats;
  if (config) {
    const rate = config.rate;
    $("info").textContent = `동기화 지연 ${(1000 * config.latency / rate).toFixed(1)} ms (네트워크 ${(1000 * config.oneWay / rate).toFixed(1)} ms) · ${rate} Hz 무손실`;
  }
  if (phase === "connected" && performance.now() - lastPacket > 3000) setStatus("신호가 끊겼어요 — 다시 연결 중...", "warn"), retry();
  else if (ctx && s) {
    if (s.playing) setStatus("● 동시 재생 중", "ok");
    else if (phase === "connected") setStatus("● 연결됨 — 버퍼 맞추는 중", "ok");
    $("stats").textContent = `버퍼 ${s.bufferMs.toFixed(1)} / ${s.targetMs.toFixed(1)} ms · 끊김 ${s.underruns} · 손실 ${s.lost} · 보정 ${s.adjusts}`;
  }
  if (ctx && ctx.state !== "running") $("play").hidden = false;
}

// ---- UI wiring
$("connect").onclick = () => start($("code").value);
$("code").onkeydown = (e) => { if (e.key === "Enter") start($("code").value); };
$("play").onclick = () => (ctx ? ctx.resume().then(() => ($("play").hidden = true)) : startAudio());
$("sync").value = localStorage.getItem("extraMs") || "0";
$("syncVal").textContent = $("sync").value + " ms";
$("sync").oninput = () => {
  $("syncVal").textContent = $("sync").value + " ms";
  localStorage.setItem("extraMs", $("sync").value);
  node && node.port.postMessage({ type: "extra", ms: Number($("sync").value) });
};
setInterval(render, 250);

const fromLink = normaliseRoomCode(decodeURIComponent(location.hash.slice(1)));
const saved = fromLink || localStorage.getItem("code") || "";
if (saved) { $("code").value = formatRoomCode(saved); start(saved); }
if (!window.RTCPeerConnection || !window.AudioWorkletNode) setStatus("이 브라우저는 지원하지 않아요. 크롬이나 사파리 최신 버전을 써 주세요.", "warn");
