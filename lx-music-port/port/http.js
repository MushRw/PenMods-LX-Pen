'use strict';
/*
 * needle/httpFetch-compatible shim over the pen's native request
 * (__lxinternal.request, backed by libcurl).
 *
 * Desktop contract implemented here:
 *   httpFetch(url, options) -> { promise, cancelHttp }
 *     promise resolves with { statusCode, statusMessage, headers, body, raw }
 *     body: JSON-parsed when possible, otherwise the raw string
 */

const I = globalThis.__lxinternal;

function mapResp(resp) {
  let body = resp.body;
  let raw = '';
  if (typeof body === 'string') {
    raw = body;
    try {
      body = JSON.parse(body);
    } catch (e) {
      /* keep raw string */
    }
  } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    /* binary: desktop 代码常用 raw.toString('base64')。
     * 注意 lx-shim 的 b64ToBytes 返回 ArrayBuffer（原生 JS_NewArrayBufferCopy），两种都要认。 */
    raw = globalThis.Buffer ? globalThis.Buffer.from(body) : body;
  }
  return {
    statusCode: resp.status,
    statusMessage: resp.status >= 400 ? 'HTTP ' + resp.status : '',
    headers: resp.headers || {},
    body,
    raw,
  };
}

/**
 * Desktop httpFetch(url, options). promise resolves {statusCode, headers, body};
 * supports options.method/headers/body/form/formData/timeout/binary.
 */
function httpFetch(url, options) {
  options = options || {};
  /* 桌面 request.js 对所有请求默认带 Chrome UA；缺失时部分接口会返回错误编码/拒绝 */
  if (!options.headers || !(options.headers['User-Agent'] || options.headers['user-agent'])) {
    const headers = {};
    for (const k of Object.keys(options.headers || {})) headers[k] = options.headers[k];
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36';
    options = { ...options, headers };
  }
  /* 桌面 needle 会把对象 body 序列化成 JSON；pen 的 lx-request 只会 String()，
   * 这里在入口统一补上，避免 "[object Object]" */
  if (options.body !== undefined && options.body !== null && typeof options.body === 'object') {
    const headers = {};
    for (const k of Object.keys(options.headers || {})) headers[k] = options.headers[k];
    if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
    options = {
      ...options,
      body: JSON.stringify(options.body),
      headers,
    };
  }
  let cancelled = false;
  let cancelFn = null;

  const obj = {
    promise: null,
    cancelHttp() {
      if (cancelled) return;
      cancelled = true;
      if (cancelFn) {
        try { cancelFn(); } catch (e) { /* ignore */ }
        cancelFn = null;
      }
      obj.promise = null;
      if (obj.cancelFn) {
        obj.cancelFn(new Error('取消http请求'));
        obj.cancelFn = null;
      }
    },
    cancelFn: null,
    isCancelled: false,
  };

  obj.promise = new Promise((resolve, reject) => {
    obj.cancelFn = reject;
    cancelFn = I.request(url, options, (err, resp) => {
      if (cancelled) return;
      obj.cancelFn = null;
      if (err) {
        reject(err);
      } else {
        resolve(mapResp(resp));
      }
    });
  });

  return obj;
}

module.exports = { httpFetch };
