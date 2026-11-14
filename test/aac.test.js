// AAC config written into exported MP4s (v1.8.1): Safari's AudioEncoder hands over a whole ES_Descriptor; written
// as is it made exports unplayable on Android/PCs/WhatsApp ("audio object type 0, 0 channels").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aacConfig, looksLikeAsc } from '../public/js/aac.js';

const hex = (u) => Buffer.from(u).toString('hex');

test('Safari ES_Descriptor (taken from a broken export): the AAC-LC 48 kHz stereo config inside', () => {
  const safari = Buffer.from('038080802200000004808080144014001800000000000000000005808080021190068080800102', 'hex');
  assert.equal(hex(aacConfig(safari, 48000, 2)), '1190');
});
test('Chromium raw config is kept; HE-AAC configs too', () => {
  assert.equal(hex(aacConfig(Uint8Array.of(0x11, 0x90), 48000, 2)), '1190');
  assert.equal(hex(aacConfig(Uint8Array.of(0x2b, 0x92, 0x08, 0x00), 24000, 2)), '2b920800');
});
test('missing or broken config: built from sample rate and channels', () => {
  assert.equal(hex(aacConfig(null, 44100, 2)), '1210');
  assert.equal(hex(aacConfig(Uint8Array.of(0, 0, 0), 48000, 1)), '1188');
  assert.equal(looksLikeAsc(Uint8Array.of(0x03, 0x80)), false);
});
