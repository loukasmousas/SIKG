// PixelMatrix.js
//
// Purpose: Minimal RGBA pixel container with convenience methods for setting/getting
// pixels and serializing to/from a compact binary representation. Used by serializers
// to persist pixel data to `.pht` files.

class PixelMatrix {
  constructor(width, height, channels) {
    this.width = width;
    this.height = height;
    this.channels = channels;
    this.pixels = new Uint8Array(width * height * channels);
  }

  /** Set the pixel at (x,y) with RGBA values. */
  setPixel(x, y, r, g, b, a) {
    const index = (y * this.width + x) * this.channels;
    this.pixels[index] = r;
    this.pixels[index + 1] = g;
    this.pixels[index + 2] = b;
    this.pixels[index + 3] = a;
  }

  /** Get the pixel at (x,y) as an object {r,g,b,a}. */
  getPixel(x, y) {
    const index = (y * this.width + x) * this.channels;
    return {
      r: this.pixels[index],
      g: this.pixels[index + 1],
      b: this.pixels[index + 2],
      a: this.pixels[index + 3],
    };
  }

  /** Return a Buffer with raw interleaved pixel bytes (RGBA...). */
  toBinary() {
    return Buffer.from(this.pixels);
  }

  /** Initialize from a raw binary buffer of pixel data (width*height*channels). */
  static fromBinary(width, height, channels, buffer) {
    const expected = width * height * channels;
    const actual = buffer?.length ?? 0;
    let ch = channels;
    if (actual !== expected && width > 0 && height > 0) {
      const perPixel = actual / (width * height);
      // Auto-correct common cases (3 or 4 channels). Otherwise keep original and let consumers throw.
      if (Number.isInteger(perPixel) && (perPixel === 3 || perPixel === 4)) {
        ch = perPixel;
        // no console here; leave to higher-level logger if needed
      }
    }
    const instance = new PixelMatrix(width, height, ch);
    instance.pixels = new Uint8Array(buffer);
    return instance;
  }

  /** JSON round‑trip */
  toJSON() {
    return {
      width: this.width,
      height: this.height,
      channels: this.channels,
      pixels: Array.from(this.pixels),
    };
  }

  /** JSON round‑trip */
  static fromJSON(json) {
    const instance = new PixelMatrix(json.width, json.height, json.channels);
    instance.pixels = new Uint8Array(json.pixels);
    return instance;
  }
}

export default PixelMatrix;
