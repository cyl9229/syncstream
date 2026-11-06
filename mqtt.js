// Minimal MQTT 3.1.1 over WebSocket (QoS 0), used only to swap connection info
// through free public brokers — the same ones the plugin uses. Audio never goes here.
const BROKERS = ["wss://broker.hivemq.com:8884/mqtt", "wss://broker.emqx.io:8084/mqtt"];
const te = new TextEncoder(), td = new TextDecoder();

function lenBytes(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return out;
}
function str(s) { const b = te.encode(s); return [b.length >> 8, b.length & 255, ...b]; }
function packet(header, body) { return new Uint8Array([header, ...lenBytes(body.length), ...body]); }

class Link {
  constructor(url, owner) { this.url = url; this.owner = owner; this.connected = false; this.closed = false; this.open(); }
  open() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(this.url, "mqtt"); } catch { return this.retry(); }
    ws.binaryType = "arraybuffer";
    this.ws = ws; this.buf = new Uint8Array(0);
    ws.onopen = () => {
      const id = "ssw-" + Math.random().toString(36).slice(2, 10);
      ws.send(packet(0x10, [...str("MQTT"), 4, 0x02, 0, 60, ...str(id)]));
    };
    ws.onmessage = (e) => this.onData(new Uint8Array(e.data));
    ws.onclose = () => { this.connected = false; this.retry(); };
    ws.onerror = () => {};
  }
  retry() { if (!this.closed) setTimeout(() => this.open(), 3000); }
  onData(d) {
    const b = new Uint8Array(this.buf.length + d.length); b.set(this.buf); b.set(d, this.buf.length); this.buf = b;
    for (;;) {
      if (this.buf.length < 2) return;
      let len = 0, mult = 1, i = 1;
      for (;;) { if (i >= this.buf.length) return; const x = this.buf[i++]; len += (x & 127) * mult; mult *= 128; if (!(x & 128)) break; }
      if (this.buf.length < i + len) return;
      const h = this.buf[0], body = this.buf.subarray(i, i + len);
      this.buf = this.buf.slice(i + len);
      if (h === 0x20) { if (body[1] === 0) this.onConnack(); }
      else if ((h & 0xf0) === 0x30) {
        const tl = (body[0] << 8) | body[1];
        const topic = td.decode(body.subarray(2, 2 + tl));
        const off = 2 + tl + (((h >> 1) & 3) ? 2 : 0);
        this.owner._deliver(topic, td.decode(body.subarray(off)));
      }
    }
  }
  onConnack() {
    this.connected = true;
    let pid = 1;
    for (const t of this.owner.subs) this.ws.send(packet(0x82, [pid >> 8, pid++ & 255, ...str(t), 0]));
    clearInterval(this.ping);
    this.ping = setInterval(() => { try { this.ws.send(new Uint8Array([0xc0, 0])); } catch {} }, 30000);
    this.owner._onConnected();
  }
  publish(topic, payload) {
    if (!this.connected) return;
    this.ws.send(packet(0x30, [...str(topic), ...te.encode(payload)]));
  }
  subscribe(t) { if (this.connected) this.ws.send(packet(0x82, [0, 9, ...str(t), 0])); }
  close() { this.closed = true; clearInterval(this.ping); try { this.ws.close(); } catch {} }
}

export class Rendezvous {
  constructor(subs, onMessage) {
    this.subs = [...subs]; this.onMessage = onMessage; this.onConnected = () => {};
    this.links = BROKERS.map((u) => new Link(u, this));
  }
  get online() { return this.links.some((l) => l.connected); }
  subscribe(t) { this.subs.push(t); this.links.forEach((l) => l.subscribe(t)); }
  publish(topic, payload) { this.links.forEach((l) => l.publish(topic, payload)); }
  _deliver(t, p) { this.onMessage(t, p); }
  _onConnected() { this.onConnected(); }
  close() { this.links.forEach((l) => l.close()); }
}
