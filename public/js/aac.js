// AAC AudioSpecificConfig for MP4 files the editor writes (fast export). No DOM: also used by the tests.

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Does these bytes start like an AAC AudioSpecificConfig (object type, sample rate index, channels)? */
export function looksLikeAsc(c) {
  if (!c || c.length < 2) return false;
  const objectType = c[0] >> 3;
  const rateIndex = ((c[0] & 7) << 1) | (c[1] >> 7);
  const channels = (c[1] >> 3) & 15;
  return [1, 2, 3, 4, 5, 29].includes(objectType) && (rateIndex < 13 || rateIndex === 15) && channels > 0;
}

/**
 * The AudioSpecificConfig for the esds box. Encoders hand it over differently: Chromium gives the raw config (2 bytes
 * for AAC-LC), Safari a whole ES_Descriptor (its "magic cookie": 03 … 04 … 05 <config> 06 …). Written as is,
 * Safari's made players read "audio object type 0, 0 channels" and refuse the whole file (Android, PCs, WhatsApp).
 * A config that still does not look like AAC is built from the sample rate and channel count (AAC-LC).
 */
export function aacConfig(desc, sampleRate, channels) {
  const d = desc?.length ? Uint8Array.from(desc) : null;
  if (d && (d[0] === 0x03 || d[0] === 0x04)) {
    const inner = findDecoderConfig(d);
    if (looksLikeAsc(inner)) return inner;
  } else if (looksLikeAsc(d)) {
    return d;
  }
  const rateIndex = Math.max(0, AAC_RATES.indexOf(sampleRate));
  const ch = Math.min(7, Math.max(1, channels || 2));
  return Uint8Array.of((2 << 3) | (rateIndex >> 1), ((rateIndex & 1) << 7) | (ch << 3));
}

/** The body of the DecoderSpecificInfo (tag 5) inside an ES_Descriptor (tag 3) / DecoderConfigDescriptor (tag 4). */
function findDecoderConfig(d) {
  const walk = (p, end) => {
    while (p < end) {
      const tag = d[p++];
      let len = 0;
      for (let i = 0; i < 4 && p < end; i++) { const v = d[p++]; len = (len << 7) | (v & 0x7f); if (!(v & 0x80)) break; }
      const body = p;
      const stop = Math.min(end, body + len);
      if (tag === 0x05) return d.subarray(body, stop);
      if (tag === 0x03) { // ES_ID (2), flags (1), optional fields, then the sub-descriptors
        const flags = d[body + 2];
        let q = body + 3;
        if (flags & 0x80) q += 2;
        if (flags & 0x40) q += 1 + d[q];
        if (flags & 0x20) q += 2;
        const r = walk(q, stop);
        if (r) return r;
      }
      if (tag === 0x04) { // object type, stream type, buffer size, bitrates (13 bytes), then tag 5
        const r = walk(body + 13, stop);
        if (r) return r;
      }
      p = stop;
    }
    return null;
  };
  return walk(0, d.length);
}
