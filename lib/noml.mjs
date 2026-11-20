/**
 * noml 解析与格式化。
 *
 * 覆盖 docs/noml-format.md 第 2 节定义的语法：
 *   - 顶层对象 / 数组
 *   - 键：裸标识符（[a-z_][a-z0-9_-]*）或单引号字符串
 *   - 值：单引号字符串（\' \\ \n \t \r）、true / false、nil、数字、对象、数组
 *   - 对象成员换行分隔（容忍逗号）；数组逗号分隔，支持尾随逗号
 *   - 注释：`;` 到行尾；独立成行的 `;;` 之间的多行注释
 *   - 成员注解 `#{…}`：整行或尾随，解析时跳过
 *
 * 格式化风格与 `no fmt` 对齐：嵌套一律 2 空格缩进，数组元素带尾随逗号，
 * 成员无逗号，空数组 / 空对象写成 `[]` / `{}`。
 */

const ID_START = /[a-z_]/;
const ID_CHAR = /[a-z0-9_-]/;
const ESCAPES = { "'": "'", '\\': '\\', n: '\n', t: '\t', r: '\r' };

/** 解析 noml 文本，返回 JS 值（对象 / 数组 / 字符串 / 数字 / 布尔 / null）。 */
export function parseNoml(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];

  function parseValue() {
    const tk = peek();
    if (!tk) throw new Error('noml: 意外的输入结束');
    if (tk.t === 'str' || tk.t === 'num' || tk.t === 'bool') {
      p++;
      return tk.v;
    }
    if (tk.t === 'nil') {
      p++;
      return null;
    }
    if (tk.t === '{') return parseObject();
    if (tk.t === '[') return parseArray();
    throw new Error(`noml: 意外的 token "${tk.raw}"`);
  }

  function parseObject() {
    next(); // {
    const obj = {};
    while (p < toks.length && peek().t !== '}') {
      const k = next();
      if (k.t !== 'id' && k.t !== 'str') throw new Error('noml: 对象键必须是标识符或字符串');
      if (peek().t === ',') next();
      if (peek().t !== ':') throw new Error('noml: 对象成员缺少 ":"');
      next();
      obj[k.v] = parseValue();
      if (peek().t === ',') next();
    }
    next(); // }
    return obj;
  }

  function parseArray() {
    next(); // [
    const arr = [];
    while (p < toks.length && peek().t !== ']') {
      arr.push(parseValue());
      if (peek().t === ',') next();
    }
    next(); // ]
    return arr;
  }

  const value = parseValue();
  if (p !== toks.length) throw new Error(`noml: 顶层值之后仍有内容（"${toks[p].raw}"）`);
  return value;
}

function tokenize(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  let lineStart = true;

  while (i < n) {
    const c = src[i];

    if (c === '\n') {
      i++;
      lineStart = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }

    // 多行注释：一对独立成行的 ;;
    if (lineStart && c === ';' && src[i + 1] === ';') {
      i = skipBlockComment(src, i);
      lineStart = true;
      continue;
    }
    // 行注释
    if (c === ';') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    lineStart = false;

    // 成员注解 #{…}
    if (c === '#' && src[i + 1] === '{') {
      i = skipAnnotation(src, i + 2);
      continue;
    }

    if (c === "'") {
      const r = readString(src, i);
      toks.push({ t: 'str', v: r.v, raw: r.v });
      i = r.i;
      continue;
    }

    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const r = readNumber(src, i);
      toks.push({ t: 'num', v: r.v, raw: String(r.v) });
      i = r.i;
      continue;
    }

    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_CHAR.test(src[j])) j++;
      const w = src.slice(i, j);
      if (w === 'true') toks.push({ t: 'bool', v: true, raw: w });
      else if (w === 'false') toks.push({ t: 'bool', v: false, raw: w });
      else if (w === 'nil') toks.push({ t: 'nil', v: null, raw: w });
      else toks.push({ t: 'id', v: w, raw: w });
      i = j;
      continue;
    }

    if ('{}[]:,'.includes(c)) {
      toks.push({ t: c, v: c, raw: c });
      i++;
      continue;
    }

    throw new Error(`noml: 无法识别的字符 "${c}"`);
  }

  return toks;
}

function skipBlockComment(src, i) {
  const n = src.length;
  while (i < n && src[i] !== '\n') i++; // 跳过起始行的剩余部分
  while (i < n) {
    let j = i;
    while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
    if (src[j] === ';' && src[j + 1] === ';') {
      i = j + 2;
      while (i < n && src[i] !== '\n') i++;
      return i;
    }
    while (i < n && src[i] !== '\n') i++;
    if (i < n) i++;
  }
  return i;
}

function skipAnnotation(src, i) {
  const n = src.length;
  let depth = 1;
  while (i < n) {
    const c = src[i];
    if (c === "'") {
      i = readString(src, i).i;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

function readString(src, i) {
  const n = src.length;
  i++; // 起始引号
  let s = '';
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      const e = src[i + 1];
      if (!(e in ESCAPES)) throw new Error(`noml: 未知转义 "\\${e}"`);
      s += ESCAPES[e];
      i += 2;
    } else if (c === "'") {
      return { v: s, i: i + 1 };
    } else {
      s += c;
      i++;
    }
  }
  throw new Error('noml: 字符串未闭合');
}

function readNumber(src, i) {
  const n = src.length;
  let j = i;
  if (src[j] === '-') j++;
  while (j < n && /[0-9]/.test(src[j])) j++;
  if (src[j] === '.') {
    j++;
    while (j < n && /[0-9]/.test(src[j])) j++;
  }
  if (src[j] === 'e' || src[j] === 'E') {
    let k = j + 1;
    if (src[k] === '+' || src[k] === '-') k++;
    if (/[0-9]/.test(src[k] ?? '')) {
      j = k;
      while (j < n && /[0-9]/.test(src[j])) j++;
    }
  }
  return { v: Number(src.slice(i, j)), i: j };
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

/** 把 JS 值格式化为 noml 文本（不含末尾换行）。 */
export function stringifyNoml(value) {
  return formatValue(value, 0);
}

function formatValue(v, indent) {
  if (typeof v === 'string') return quote(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null || v === undefined) return 'nil';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const pad = ' '.repeat(indent + 2);
    const inner = v.map((x) => `${pad}${formatValue(x, indent + 2)},`).join('\n');
    return `[\n${inner}\n${' '.repeat(indent)}]`;
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return '{}';
  const pad = ' '.repeat(indent + 2);
  const inner = keys
    .map((k) => `${pad}${formatKey(k)}: ${formatValue(v[k], indent + 2)}`)
    .join('\n');
  return `{\n${inner}\n${' '.repeat(indent)}}`;
}

function formatKey(k) {
  return /^[a-z_][a-z0-9_-]*$/.test(k) ? k : quote(k);
}

function quote(s) {
  let out = "'";
  for (const ch of s) {
    if (ch === "'") out += "\\'";
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else out += ch;
  }
  return out + "'";
}
