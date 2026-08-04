'use strict';
/*
 * Where to cut a size-capped read of the wake channel.
 *
 * Its own file only because it is worth testing directly: it is twelve lines of byte arithmetic whose
 * failure mode is silent data loss. Returning more than was read advances the reader's offset past
 * captions nobody ever saw; returning zero when a usable prefix exists stalls that reader forever.
 */

// Prefer the last newline: the channel is line-oriented, so a consumer should never receive half a
// sentence, and a line boundary is always a character boundary too. A single line longer than the cap has
// no newline to cut at, so fall back to walking back off an incomplete multi-byte sequence - cutting
// mid-character costs a replacement glyph on each side of the boundary and leaves the next read starting
// inside a character, permanently.
//
// Invalid UTF-8 in the input cannot be rescued by any choice of cut; the guarantee is only that we never
// introduce a new split.
function utf8SafeCut(buf, len) {
  // Clamp first: Buffer.lastIndexOf treats a negative fromIndex as an offset from the END, so len 0 would
  // search the whole buffer and could report a cut past what was actually read.
  if (!(len > 0)) return 0;
  const end = Math.min(len, buf.length);
  const nl = buf.lastIndexOf(0x0a, end - 1);
  if (nl >= 0) return nl + 1;
  let i = end - 1;
  let back = 0;
  while (i >= 0 && (buf[i] & 0xc0) === 0x80 && back < 3) { i--; back++; }
  if (i < 0) return end;
  const lead = buf[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return i + need <= end ? end : i;
}

module.exports = { utf8SafeCut };
