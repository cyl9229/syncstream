// Same crypto as the plugin (Source/Common/Crypto.cpp):
//  room code -> PBKDF2-HMAC-SHA256 (600k) -> enc/mac/topic keys
//  sealed message = "SYN2" | nonce(12) | ChaCha20(ct) | HMAC-SHA256(mac, all before)[0..16]
const te = new TextEncoder();
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function normaliseRoomCode(s) {
  const c = (s || "").toUpperCase().replace(/[\s-]/g, "");
  if (c.length !== 8) return "";
  for (const ch of c) if (!CODE_ALPHABET.includes(ch)) return "";
  return c;
}
export const formatRoomCode = (c) => c.slice(0, 4) + "-" + c.slice(4);

async function hmac(keyBytes, data) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

export async function deriveRoomKeys(code) {
  const base = await crypto.subtle.importKey("raw", te.encode(code), "PBKDF2", false, ["deriveBits"]);
  const master = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: te.encode("SyncStream room key v2"), iterations: 600000 }, base, 256));
  const enc = await hmac(master, te.encode("enc"));
  const mac = await hmac(master, te.encode("mac"));
  const topic = await hmac(master, te.encode("topic"));
  const topicId = [...topic.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { enc, mac, topicId };
}

// ---- ChaCha20 (RFC 8439) ----
function chacha20Xor(key, nonce, counter, data) {
  const st = new Uint32Array(16);
  st.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  const kv = new DataView(key.buffer, key.byteOffset, 32);
  for (let i = 0; i < 8; i++) st[4 + i] = kv.getUint32(i * 4, true);
  st[12] = counter;
  const nv = new DataView(nonce.buffer, nonce.byteOffset, 12);
  for (let i = 0; i < 3; i++) st[13 + i] = nv.getUint32(i * 4, true);
  const x = new Uint32Array(16), ks = new Uint8Array(64), ksv = new DataView(ks.buffer);
  const rotl = (v, c) => (v << c) | (v >>> (32 - c));
  const qr = (a, b, c, d) => {
    x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 16);
    x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 12);
    x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 8);
    x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 7);
  };
  for (let off = 0; off < data.length; off += 64) {
    x.set(st);
    for (let i = 0; i < 10; i++) {
      qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
      qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
    }
    for (let i = 0; i < 16; i++) ksv.setUint32(i * 4, (x[i] + st[i]) >>> 0, true);
    const n = Math.min(64, data.length - off);
    for (let i = 0; i < n; i++) data[off + i] ^= ks[i];
    st[12]++;
  }
}
export const _chacha20Xor = chacha20Xor; // for the self-test

const MAGIC = te.encode("SYN2");

export async function seal(keys, plain) {
  const out = new Uint8Array(16 + plain.length + 16);
  out.set(MAGIC, 0);
  crypto.getRandomValues(out.subarray(4, 16));
  out.set(plain, 16);
  chacha20Xor(keys.enc, out.subarray(4, 16), 1, out.subarray(16, 16 + plain.length));
  const tag = await hmac(keys.mac, out.subarray(0, 16 + plain.length));
  out.set(tag.subarray(0, 16), 16 + plain.length);
  return out;
}

export async function open(keys, pkt) {
  if (pkt.length < 32 || pkt[0] !== 0x53 || pkt[1] !== 0x59 || pkt[2] !== 0x4e || pkt[3] !== 0x32) return null;
  const body = pkt.length - 32;
  const tag = await hmac(keys.mac, pkt.subarray(0, 16 + body));
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= tag[i] ^ pkt[16 + body + i];
  if (diff !== 0) return null;
  const plain = pkt.slice(16, 16 + body);
  chacha20Xor(keys.enc, pkt.subarray(4, 16), 1, plain);
  return plain;
}

export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
export function fromBase64(str) {
  try {
    const s = atob(str);
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  } catch { return null; }
}
export async function sealText(keys, text) { return toBase64(await seal(keys, te.encode(text))); }
export async function openText(keys, b64) {
  const b = fromBase64(b64);
  if (!b) return null;
  const p = await open(keys, b);
  return p ? new TextDecoder().decode(p) : null;
}
