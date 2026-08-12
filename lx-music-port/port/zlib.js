'use strict';
/*
 * zlib shim -> pen native zlib_inflate / zlib_deflate.
 * Native inflate uses windowBits = 15+32 (auto zlib/gzip), matching Node's
 * zlib.inflate (zlib wrapper, not raw).
 */

const I = globalThis.__lxinternal;
require('__port/buffer.js');
const Buf = globalThis.Buffer;

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return I.strToBytes(v);
  if (Array.isArray(v)) return Uint8Array.from(v);
  throw new Error('zlib: unsupported input');
}

function inflate(buf, cb) {
  const p = new Promise((resolve, reject) => {
    try {
      resolve(Buf.from(I.native.zlib_inflate(toBytes(buf))));
    } catch (e) {
      reject(e);
    }
  });
  if (typeof cb === 'function') {
    p.then(data => cb(null, data), err => cb(err));
    return;
  }
  return p;
}

function deflate(data, cb) {
  const p = new Promise((resolve, reject) => {
    try {
      resolve(Buf.from(I.native.zlib_deflate(toBytes(data))));
    } catch (e) {
      reject(e);
    }
  });
  if (typeof cb === 'function') {
    p.then(buf => cb(null, buf), err => cb(err));
    return;
  }
  return p;
}

module.exports = { inflate, deflate };
