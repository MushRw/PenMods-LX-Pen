'use strict';
/*
 * GB18030/GBK -> UTF-8 解码，走 penmusic 原生 __lx_native_call__iconv_convert
 * （glibc iconv，dlopen libc.so.6）。失败时原生抛错，这里原样上抛。
 */

const I = globalThis.__lxinternal;

function convert(bytes, from, to) {
  /* lx-shim 的 I.native 只暴露固定名单，iconv 需直接读 register_natives 注册的全局函数 */
  const raw = globalThis['__lx_native_call__iconv_convert'];
  if (typeof raw !== 'function') {
    throw new Error('iconv unavailable: native iconv_convert missing');
  }
  return raw(I.bytesArg(bytes), String(from || 'GB18030'), String(to || 'UTF-8'));
}

function decodeGbk(bytes) {
  const s = convert(bytes, 'GB18030', 'UTF-8');
  return typeof s === 'string' ? s : '';
}

module.exports = { convert, decodeGbk };
