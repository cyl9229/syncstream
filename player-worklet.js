// Port of ReceiverEngine::pullAudio (Source/Common/ReceiverEngine.cpp).
// Plays each 64-frame block exactly when the sender hears it; timing is corrected
// only inside digital silence, using the buffer's low point (bursty arrivals).
const BLOCK = 64;
const SILENCE = 1e-6;

class SyncPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.slots = new Map();   // seq -> Float32Array(128) interleaved L/R
    this.session = 0; this.highest = -1;
    this.readSeq = 0; this.readOffset = 0; this.pendingZeros = 0; this.started = false;
    this.cfg = null;          // {targetBase, senderOut}
    this.outLat = 0; this.extraMs = 0; this.resync = false;
    this.winMin = Infinity; this.winFrames = 0; this.measuredMin = -1;
    this.stats = { lost: 0, underruns: 0, adjusts: 0 }; this.lastReport = 0;
    this.port.onmessage = (e) => this.onMsg(e.data);
  }
  onMsg(m) {
    if (m.type === "audio") {
      if (m.session !== this.session) {
        this.session = m.session; this.slots.clear(); this.highest = -1;
        this.readSeq = m.prev ? m.seq - 1 : m.seq; this.readOffset = 0; this.pendingZeros = 0; this.started = false;
      }
      if (m.prev && m.seq > 0 && !this.slots.has(m.seq - 1) && m.seq - 1 >= this.readSeq) this.slots.set(m.seq - 1, m.prev);
      if (m.seq >= this.readSeq) this.slots.set(m.seq, m.cur);
      if (m.seq > this.highest) this.highest = m.seq;
    } else if (m.type === "config") {
      this.cfg = { targetBase: Math.max(0, m.latency - m.oneWay + m.senderOut), senderOut: m.senderOut };
    } else if (m.type === "outLat") {
      this.outLat = Math.max(0, m.frames | 0);
    } else if (m.type === "extra") {
      if (m.ms !== this.extraMs) { this.extraMs = m.ms; this.resync = true; }
    }
  }
  level() { return (this.highest + 1 - this.readSeq) * BLOCK - this.readOffset; }
  isSilent(b) { for (let i = 0; i < b.length; i++) if (Math.abs(b[i]) > SILENCE) return false; return true; }

  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    const n = L.length;
    let done = 0;
    const zeros = (k) => { L.fill(0, done, done + k); R.fill(0, done, done + k); done += k; };

    if (!this.cfg || this.highest < 0) { zeros(n); this.report(false); return true; }
    const target = Math.max(BLOCK, this.cfg.targetBase - this.outLat + Math.round(this.extraMs * sampleRate / 1000));
    let lv = this.level();
    const resync = this.resync; this.resync = false;
    if (resync) this.started = false;
    if (lv > target + sampleRate / 2 || (resync && lv > target)) {
      this.readSeq = this.highest + 1 - Math.ceil(target / BLOCK);
      this.readOffset = 0; this.pendingZeros = 0; this.started = false; lv = this.level();
    }
    if (!this.started) {
      this.winMin = Infinity; this.winFrames = 0; this.measuredMin = -1;
      const burst = Math.max(BLOCK, this.cfg.senderOut);
      if (lv >= target + burst) {
        this.readSeq += Math.floor((lv - (target + burst)) / BLOCK);
        this.started = true;
      } else { zeros(n); this.report(false, lv); return true; }
    }
    const tol = Math.max(BLOCK * 1.5, sampleRate * 0.002);
    let adjusted = false;

    while (done < n) {
      if (this.pendingZeros > 0) { const k = Math.min(this.pendingZeros, n - done); zeros(k); this.pendingZeros -= k; continue; }
      const blk = this.slots.get(this.readSeq);
      if (blk) {
        if (this.readOffset === 0 && !adjusted && this.isSilent(blk)) {
          if (this.measuredMin >= 0 && this.measuredMin > target + tol) {
            this.slots.delete(this.readSeq++); this.measuredMin -= BLOCK; this.stats.adjusts++; adjusted = true; continue;
          }
          if (this.measuredMin >= 0 && this.measuredMin < target - tol) {
            this.pendingZeros = BLOCK; this.measuredMin += BLOCK; this.stats.adjusts++; adjusted = true; continue;
          }
        }
        if (this.readOffset === 0) {           // timing probe: first sound after a pause
          const silent = this.isSilent(blk);
          if (!silent && this.silentRun >= sampleRate * 0.3) this.port.postMessage({ type: "onset", ctxTime: currentTime + done / sampleRate });
          this.silentRun = silent ? (this.silentRun || 0) + BLOCK : 0;
        }
        const k = Math.min(BLOCK - this.readOffset, n - done);
        for (let i = 0; i < k; i++) { L[done + i] = blk[2 * (this.readOffset + i)]; R[done + i] = blk[2 * (this.readOffset + i) + 1]; }
        done += k; this.readOffset += k;
        if (this.readOffset === BLOCK) { this.slots.delete(this.readSeq); this.readOffset = 0; this.readSeq++; }
      } else if (this.highest >= this.readSeq + 2) {
        this.pendingZeros = BLOCK - this.readOffset; this.readOffset = 0; this.readSeq++; this.stats.lost++;
      } else {
        zeros(n - done); this.stats.underruns++; this.started = false; break;
      }
    }
    // drop anything we've passed (keeps memory flat)
    if (this.slots.size > 4096) for (const k of this.slots.keys()) if (k < this.readSeq) this.slots.delete(k);

    const after = this.level();
    if (this.started) {
      this.winMin = Math.min(this.winMin, after); this.winFrames += n;
      if (this.winFrames >= sampleRate / 2) { this.measuredMin = this.winMin; this.winMin = Infinity; this.winFrames = 0; }
    }
    this.report(this.started, this.measuredMin >= 0 ? this.measuredMin : after, target);
    return true;
  }
  report(playing, lv = 0, target = 0) {
    if (currentTime - this.lastReport < 0.25) return;
    this.lastReport = currentTime;
    this.port.postMessage({ playing, bufferMs: 1000 * lv / sampleRate, targetMs: 1000 * target / sampleRate, ...this.stats });
  }
}
registerProcessor("sync-player", SyncPlayer);
