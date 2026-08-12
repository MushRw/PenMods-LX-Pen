'use strict';
/*
 * lx-sdk mini bundler.
 *
 * Wraps each vendor ES module into a CommonJS-like factory and concatenates
 * everything (topologically sorted) into dist/lx-sdk.js, which penmusic can
 * eval_file() after lx-shim.js.
 *
 * Usage: node tools/build.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const PORT = path.join(ROOT, 'port');
const OUTDIR = path.join(ROOT, 'dist');

/* ---------- module collection ---------- */

const modules = new Map(); // id -> { kind: 'vendor'|'port', file }

function walk(dir, prefix) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, prefix);
    else {
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      const id = rel.replace(/^vendor\//, '').replace(/^port\//, '__port/');
      modules.set(id, { kind: prefix === VENDOR ? 'vendor' : 'port', file: full });
    }
  }
}

walk(VENDOR, VENDOR);
walk(PORT, PORT);

/* reference-only files: keep in vendor/, exclude from bundle */
const EXCLUDE = new Set([
  'musicSdk/index.js',
  'musicSdk/api-source.js',
  'renderer/request.js',
  'renderer/message.ts',
  'renderer/index.ts',
  'common/common.ts',
  'common/lyricUtils/util.ts',
  'main/kw_decodeLyric.ts',
  'main/tx_decodeLyric.ts',
  'userApi/preload.js',
]);
for (const id of EXCLUDE) modules.delete(id);

/*
 * 上游代码的已知 bug 最小补丁（保持 vendor 原样，打包时应用）。
 * mg/musicInfo.js: createGetMusicInfosTask 已返回 Promise，再包一层 Promise.all 会
 * “object is not iterable”（桌面版同样存在）。
 */
const PATCHES = {
  'musicSdk/mg/musicInfo.js': [
    [
      /return filterMusicInfoList\(await Promise\.all\(createGetMusicInfosTask\(copyrightIds\)\)\.then\(data => data\.flat\(\)\)\)/,
      'return filterMusicInfoList((await createGetMusicInfosTask(copyrightIds)).flat())',
    ],
  ],
  /* 酷我 newlyric 接口需要 Referer，否则返回 TP=ERROR REQUEST。
   * 用字符串定位第 2 处出现（第一处在注释块里）。 */
  'musicSdk/kw/lyric.js': [
    {
      find: 'const requestObj = httpFetch(`http://newlyric.kuwo.cn/newlyric.lrc?${buildParams(musicInfo.songmid, isGetLyricx)}`',
      nth: 2,
      insert: ', { headers: { Referer: \'http://www.kuwo.cn/\', \'User-Agent\': \'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36\' }, binary: true }',
    },
    /* QuickJS 不支持 V8 遗留的 RegExp.$1，改用 exec 捕获组 */
    [/let time = RegExp\.\$1/, 'let time = result[1]'],
  ],
  'musicSdk/mg/musicInfo.js': [
    [/interval: intervalTest \? RegExp\.\$1 : null/, 'interval: (/(\\d\\d:\\d\\d)$/.exec(item.length) || [])[1] || null'],
  ],
};

/* ---------- import/export transforms ---------- */

const ALIASES = {
  '../../request': '__port/http.js',
  '../../../request': '__port/http.js',
  '../../message': '__port/stubs.js',
  '../../index': '__port/common.js',
  '../../../index': '__port/common.js',
  '@common/utils/lyricUtils/kg': 'common/lyricUtils/kg.js',
  '@renderer/utils': '__port/common.js',
  '@renderer/utils/musicSdk/kg/vendors/infSign.min': 'musicSdk/kg/vendors/infSign.min.js',
  '@common/ipcNames': '__port/stubs.js',
  '@common/rendererIpc': '__port/stubs.js',
  'crypto': '__port/crypto.js',
  'node:crypto': '__port/crypto.js',
  'zlib': '__port/zlib.js',
  'node:zlib': '__port/zlib.js',
  'dns': '__port/stubs.js',
  '../api-source': '__port/stubs.js',
};

/* per-file specifier overrides (checked before ALIASES) */
const FILE_ALIASES = {
  'common/lyricUtils/kg.js': {
    './util': '__port/lyric-util.js',
  },
};

function resolveId(fromId, spec) {
  if (FILE_ALIASES[fromId] && FILE_ALIASES[fromId][spec]) return FILE_ALIASES[fromId][spec];
  if (ALIASES[spec]) return ALIASES[spec];
  if (spec.startsWith('.')) {
    const base = path.posix.dirname(fromId);
    const cands = [
      path.posix.normalize(path.posix.join(base, spec)),
      path.posix.normalize(path.posix.join(base, spec + '.js')),
      path.posix.normalize(path.posix.join(base, spec + '.ts')),
      path.posix.normalize(path.posix.join(base, spec, 'index.js')),
      path.posix.normalize(path.posix.join(base, spec, 'index.ts')),
    ];
    for (const c of cands) if (modules.has(c)) return c;
    throw new Error(`cannot resolve '${spec}' from '${fromId}'`);
  }
  throw new Error(`cannot resolve bare specifier '${spec}' from '${fromId}'`);
}

const IMPORT_RE = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/;
const IMPORT_SIDE_RE = /^import\s+['"]([^'"]+)['"]\s*;?\s*$/;
const EXPORT_DEFAULT_RE = /^export\s+default\s+/;
const EXPORT_FUNC_RE = /^export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/;
const EXPORT_CONST_RE = /^export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;
const EXPORT_BRACE_RE = /^export\s*\{([^}]*)\}\s*;?\s*$/;
const EXPORT_EMPTY_RE = /^export\s*\{\}\s*;?\s*$/;

function parseImportSpec(spec) {
  spec = spec.trim();
  const result = { default: null, named: [], ns: null };
  let rest = spec;
  const brace = spec.match(/^\{([^}]*)\}/);
  if (brace) {
    for (const item of brace[1].split(',')) {
      const t = item.trim();
      if (!t) continue;
      const m = t.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!m) throw new Error('bad named import: ' + t);
      result.named.push({ from: m[1], to: m[2] || m[1] });
    }
    rest = spec.slice(brace[0].length).trim();
  }
  if (rest) {
    for (const part of rest.split(',').map(s => s.trim()).filter(Boolean)) {
      if (part.startsWith('* as ')) result.ns = part.slice(5).trim();
      else result.default = part;
    }
  }
  return result;
}

/* split `a = 1, b = fn(x, y)` on top-level commas */
function splitDeclarators(str) {
  const out = [];
  let depth = 0, start = 0, quote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === quote && str[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(str.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(str.slice(start).trim());
  return out;
}

function transformVendor(source, id) {
  const lines = source.split('\n');
  const requireLines = [];
  const deps = [];
  const body = [];
  let hasDefault = false;
  const funcExports = [];
  const constExports = [];

  for (let line of lines) {
    const trimmed = line.trim();
    let m;
    if (EXPORT_EMPTY_RE.test(trimmed)) {
      continue;
    }
    if ((m = trimmed.match(IMPORT_RE))) {
      const target = resolveId(id, m[2]);
      deps.push(target);
      const parsed = parseImportSpec(m[1]);
      if (parsed.ns) requireLines.push(`const ${parsed.ns} = require(${JSON.stringify(target)});`);
      if (parsed.default) {
        requireLines.push(
          `const ${parsed.default} = require(${JSON.stringify(target)}).default !== undefined ? require(${JSON.stringify(target)}).default : require(${JSON.stringify(target)});`
        );
      }
      if (parsed.named.length) {
        const pairs = parsed.named.map(n => (n.from === n.to ? n.from : `${n.from}: ${n.to}`)).join(', ');
        requireLines.push(`const { ${pairs} } = require(${JSON.stringify(target)});`);
      }
      continue;
    }
    if ((m = trimmed.match(IMPORT_SIDE_RE))) {
      const target = resolveId(id, m[1]);
      deps.push(target);
      requireLines.push(`require(${JSON.stringify(target)});`);
      continue;
    }
    if (EXPORT_DEFAULT_RE.test(trimmed)) {
      hasDefault = true;
      body.push(trimmed.replace(EXPORT_DEFAULT_RE, 'module.exports.default = '));
      continue;
    }
    if ((m = trimmed.match(EXPORT_FUNC_RE))) {
      const name = m[2];
      funcExports.push(name);
      body.push(trimmed.replace(/^export\s+/, ''));
      continue;
    }
    if ((m = trimmed.match(EXPORT_CONST_RE))) {
      const kind = m[1];
      const declSrc = trimmed.replace(new RegExp('^export\\s+' + kind + '\\s+'), '');
      for (const d of splitDeclarators(declSrc)) {
        const mm2 = d.match(/^([A-Za-z_$][\w$]*)/);
        if (mm2) constExports.push(mm2[1]);
      }
      body.push(`${kind} ${declSrc}`);
      continue;
    }
    if ((m = trimmed.match(EXPORT_BRACE_RE))) {
      const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
      body.push(`exports = Object.assign(exports, { ${names.join(', ')} });`);
      continue;
    }
    body.push(line);
  }

  for (const name of funcExports.concat(constExports)) {
    body.push(`exports.${name} = ${name};`);
  }
  if (hasDefault) {
    body.push('module.exports.__default = module.exports.default;');
  }
  return { code: requireLines.concat(body).join('\n'), deps };
}

/* ---------- topo sort ---------- */

const parsedCache = new Map();

function parseModule(id) {
  if (parsedCache.has(id)) return parsedCache.get(id);
  const info = modules.get(id);
  let source = fs.readFileSync(info.file, 'utf8');
  if (PATCHES[id]) {
    for (const patch of PATCHES[id]) {
      if (typeof patch === 'string' || Array.isArray(patch)) {
        const [re, replacement] = Array.isArray(patch) ? patch : [new RegExp(patch), ''];
        source = source.replace(re, replacement);
      } else if (patch.find) {
        let pos = -1;
        for (let n = 0; n < (patch.nth || 1); n++) {
          pos = source.indexOf(patch.find, pos + 1);
          if (pos < 0) throw new Error('patch not found: ' + patch.find + ' (nth=' + (patch.nth || 1) + ') in ' + id);
        }
        source = source.slice(0, pos + patch.find.length) + patch.insert + source.slice(pos + patch.find.length);
      }
    }
  }
  let result;
  if (info.kind === 'port') {
    result = { code: source, deps: [] };
    const reqRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let mm;
    while ((mm = reqRe.exec(source))) {
      if (mm[1].startsWith('.') || modules.has(mm[1])) result.deps.push(mm[1]);
    }
  } else {
    result = transformVendor(source, id);
  }
  parsedCache.set(id, result);
  return result;
}

const ENTRY = '__port/index.js';
const order = [];
const visited = new Set();
const visiting = new Set();

function visit(id) {
  if (visited.has(id)) return;
  if (visiting.has(id)) throw new Error('circular dependency at ' + id);
  visiting.add(id);
  const parsed = parseModule(id);
  for (const dep of parsed.deps) {
    if (!modules.has(dep)) throw new Error('missing module: ' + dep + ' (required by ' + id + ')');
    visit(dep);
  }
  visiting.delete(id);
  visited.add(id);
  order.push(id);
}

visit(ENTRY);

/* ---------- emit ---------- */

const parts = [];
parts.push(`/* lx-music-desktop musicSdk port for YDP02X (PenMods) */`);
parts.push(`/* generated by tools/build.js — do not edit */`);
parts.push(`(function(){`);
parts.push(`'use strict';\n`);
parts.push(`/* env shims: infSign.min.js touches navigator/self at load time */`);
parts.push(`if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { userAgent: '' };`);
parts.push(`if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;`);
parts.push(`var __lx_modules = {};`);
parts.push(`var __lx_cache = {};`);
parts.push(`function __lx_require(id) {`);
parts.push(`  if (__lx_cache[id]) return __lx_cache[id].exports;`);
parts.push(`  var m = __lx_cache[id] = { exports: {} };`);
parts.push(`  var f = __lx_modules[id];`);
parts.push(`  if (!f) throw new Error('lx-sdk: module not found: ' + id);`);
parts.push(`  f(m, m.exports, __lx_require);`);
parts.push(`  return m.exports;`);
parts.push(`}`);
parts.push(`function __lx_define(id, factory) { __lx_modules[id] = factory; }`);

for (const id of order) {
  const parsed = parsedCache.get(id);
  parts.push(`__lx_define(${JSON.stringify(id)}, function(module, exports, require) {`);
  parts.push(parsed.code);
  parts.push(`});`);
}

parts.push(`__lx_require(${JSON.stringify(ENTRY)});`);
parts.push(`globalThis.__lxSdk = __lx_require(${JSON.stringify(ENTRY)});`);
parts.push(`})();`);

fs.mkdirSync(OUTDIR, { recursive: true });
const outFile = path.join(OUTDIR, 'lx-sdk.js');
fs.writeFileSync(outFile, parts.join('\n'), 'utf8');
console.log(`built: ${outFile} (${order.length} modules, ${fs.statSync(outFile).size} bytes)`);
