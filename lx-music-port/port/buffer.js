'use strict';
/*
 * Buffer shim for the pen QuickJS runtime.
 * Backed by Uint8Array (subclass). Supports the subset of the Node Buffer API
 * that lx-music-desktop's musicSdk relies on:
 *   from / alloc / concat / subarray / slice / toString(utf8|base64|hex|utf16le|binary)
 *   reverse / map / indexOf / readUInt8 / writeUInt8 / length / [i]
 *
 * Encodings are routed through the pen natives where available (__lxinternal).
 */

const I = globalThis.__lxinternal;

function utf16leEncode(str) {
  const u = new Uint16Array(str.length);
  for (let i = 0; i < str.length; i++) u[i] = str.charCodeAt(i);
  return new Uint8Array(u.buffer, 0, u.length * 2);
}

function utf16leDecode(bytes) {
  const n = Math.floor(bytes.byteLength / 2);
  const u = new Uint16Array(bytes.buffer, bytes.byteOffset, n);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(u[i]);
  return s;
}

function hexEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

function hexDecode(str) {
  const out = new Uint8Array(Math.floor(str.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16);
  return out;
}

class Buf extends Uint8Array {
  static from(input, encoding) {
    if (input instanceof ArrayBuffer) {
      /* 原生函数（str_to_bytes 等）返回 ArrayBuffer，需要适配 */
      const v = new Uint8Array(input);
      const out = new Buf(v.length);
      out.set(v);
      return out;
    }
    if (input instanceof Uint8Array) {
      const out = new Buf(input.length);
      out.set(input);
      return out;
    }
    if (ArrayBuffer.isView(input)) {
      /* Uint16Array 等：逐字节取低 8 位（酷我 buildParams 用 Uint16Array 存 xor 结果） */
      const out = new Buf(input.length);
      for (let i = 0; i < input.length; i++) out[i] = input[i] & 0xff;
      return out;
    }
    if (typeof input === 'string') {
      encoding = (encoding || 'utf8').toLowerCase();
      let bytes;
      if (encoding === 'utf8' || encoding === 'utf-8') bytes = I.strToBytes(input);
      else if (encoding === 'base64') bytes = I.b64ToBytes(input);
      else if (encoding === 'hex') bytes = hexDecode(input);
      else if (encoding === 'utf16le' || encoding === 'ucs2' || encoding === 'ucs-2') bytes = utf16leEncode(input);
      else if (encoding === 'binary' || encoding === 'latin1') {
        bytes = new Uint8Array(input.length);
        for (let i = 0; i < input.length; i++) bytes[i] = input.charCodeAt(i) & 0xff;
      } else throw new Error('Buffer.from: unsupported encoding ' + encoding);
      /* 原生 str_to_bytes/b64_to_bytes 返回 ArrayBuffer（非 Uint8Array），统一归一化 */
      if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
      const out = new Buf(bytes.length);
      out.set(bytes);
      return out;
    }
    if (Array.isArray(input)) {
      const out = new Buf(input.length);
      for (let i = 0; i < input.length; i++) out[i] = input[i] & 0xff;
      return out;
    }
    throw new Error('Buffer.from: unsupported input');
  }

  static alloc(size, fill) {
    const out = new Buf(size);
    if (fill !== undefined) out.fill(fill);
    return out;
  }

  static allocUnsafe(size) {
    return new Buf(size);
  }

  static allocUnsafeSlow(size) {
    return new Buf(size);
  }

  static byteLength(str, encoding) {
    return Buf.from(str, encoding).length;
  }

  static concat(list) {
    let total = 0;
    for (const b of list) total += b.length;
    const out = new Buf(total);
    let off = 0;
    for (const b of list) {
      out.set(b, off);
      off += b.length;
    }
    return out;
  }

  static isBuffer(v) {
    return v instanceof Uint8Array;
  }

  toString(encoding) {
    encoding = (encoding || 'utf8').toLowerCase();
    if (encoding === 'utf8' || encoding === 'utf-8') return I.bytesToStr(this);
    if (encoding === 'base64') return I.bytesToB64(this);
    if (encoding === 'hex') return hexEncode(this);
    if (encoding === 'utf16le' || encoding === 'ucs2' || encoding === 'ucs-2') return utf16leDecode(this);
    if (encoding === 'binary' || encoding === 'latin1') {
      let s = '';
      for (let i = 0; i < this.length; i++) s += String.fromCharCode(this[i]);
      return s;
    }
    throw new Error('Buffer.toString: unsupported encoding ' + encoding);
  }

  subarray(start, end) {
    const out = new Buf(Math.max(0, (end === undefined ? this.length : end) - start));
    for (let i = 0; i < out.length; i++) out[i] = this[start + i];
    return out;
  }

  slice(start, end) {
    return this.subarray(start === undefined ? 0 : start, end === undefined ? this.length : end);
  }

  reverse() {
    let i = 0, j = this.length - 1;
    while (i < j) {
      const t = this[i]; this[i] = this[j]; this[j] = t;
      i++; j--;
    }
    return this;
  }

  map(fn) {
    const out = new Buf(this.length);
    for (let i = 0; i < this.length; i++) out[i] = fn(this[i]);
    return out;
  }

  fill(v) {
    for (let i = 0; i < this.length; i++) this[i] = v & 0xff;
    return this;
  }

  indexOf(needle, from) {
    from = from || 0;
    const target = needle instanceof Uint8Array
      ? needle
      : Buf.from(typeof needle === 'string' ? needle : [needle]);
    outer:
    for (let i = from; i <= this.length - target.length; i++) {
      for (let j = 0; j < target.length; j++) {
        if (this[i + j] !== target[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  readUInt8(off) { return this[off]; }
  writeUInt8(v, off) { this[off] = v & 0xff; return off + 1; }
}

globalThis.Buffer = Buf;
module.exports = Buf;
