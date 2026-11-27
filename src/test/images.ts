/** Smallest PNG, JPEG and WebP headers the image inspectors accept, for tests that need image bytes of a known size. */

/**
 * A PNG header (signature and IHDR) with the given size. `seed` appends a few trailing bytes so two images of the same
 * size differ and hash differently.
 */
export function pngBytes(width: number, height: number, seed?: number): Buffer {
  const header = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'latin1')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  header[24] = 8
  header[25] = 6
  return seed === undefined ? header : Buffer.concat([header, Buffer.from([seed & 0xff, 0xff, 0x00, (seed ^ 0x55) & 0xff, 0x80])])
}

/** A JPEG with an APP0 segment, one baseline frame header at the given size, and an end marker. */
export function jpegBytes(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01,
    0x01, 0x11, 0x00, 0xff, 0xd9
  ])
}

/** A WebP header (RIFF, then a VP8X, VP8L or VP8 chunk) with the given size: not a decodable picture. */
export function webpBytes(width: number, height: number, flavour: 'VP8X' | 'VP8L' | 'VP8 ' = 'VP8L'): Buffer {
  const bytes = Buffer.alloc(40)
  bytes.write('RIFF', 0, 'latin1')
  bytes.writeUInt32LE(32, 4)
  bytes.write(`WEBP${flavour}`, 8, 'latin1')
  bytes.writeUInt32LE(20, 16)
  if (flavour === 'VP8X') {
    bytes.writeUIntLE(width - 1, 24, 3)
    bytes.writeUIntLE(height - 1, 27, 3)
  } else if (flavour === 'VP8L') {
    bytes[20] = 0x2f
    bytes.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21)
  } else {
    bytes.set([0x9d, 0x01, 0x2a], 23)
    bytes.writeUInt16LE(width, 26)
    bytes.writeUInt16LE(height, 28)
  }
  return bytes
}
