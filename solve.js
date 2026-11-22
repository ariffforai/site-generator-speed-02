// solve.js — a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build
// returns for the same input: every path it writes and that file's text,
// byte for byte. Written from makefun-site's README and the behaviour of
// its reference program; the code below is my own re-implementation,
// shaped for speed: hand-rolled scanners instead of per-line regular
// expressions, a single-pass inline renderer that batches plain text,
// a per-case slug cache, and templates compiled once per case into
// small render functions. No dependencies, no network, no clock, no
// randomness: the answer is a function of the input alone, and nothing
// is kept from one case to the next.

export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

/** HTML escape table, indexed by character code. */
const ESC_ARR = [];
ESC_ARR[38] = '&amp;';
ESC_ARR[60] = '&lt;';
ESC_ARR[62] = '&gt;';
ESC_ARR[34] = '&quot;';
ESC_ARR[39] = '&#39;';

/** `text` with & < > " and ' escaped. A fast native test first: most
 * strings hold nothing to escape, and those leave here untouched. */
const NEEDS_ESCAPE = /[&<>"']/;
function esc(text) {
  if (!NEEDS_ESCAPE.test(text)) return text;
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) {
      const e = ESC_ARR[c];
      if (e !== undefined) {
        out += text.slice(last, i);
        out += e;
        last = i + 1;
      }
    }
  }
  return out + text.slice(last);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every
 * run of characters other than a-z and 0-9 one "-", none at either end,
 * at most 64 characters (a "-" left at the cut dropped), and "untitled"
 * when nothing is left. Pure-ASCII text skips the normalisation step
 * (it is the identity there). Results are cached per case in `cache`.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  let end = Math.min(out.length, SLUG_MAX);
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = out.slice(0, end);
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** Whether character code `c` is JavaScript whitespace. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [32, 9, 10, 11, 12, 13, 160, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;
function isWSCode(c) {
  return WS_TABLE[c] === 1;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** `s` with trailing spaces and tabs dropped. */
function stripTrailing(s) {
  let e = s.length;
  while (e > 0) {
    const c = s.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return s.slice(0, e);
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function parseString(raw, key) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: `key "${key}": a quoted string is not closed` };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: `key "${key}": a quoted string holds an escape other than \\" or \\\\` };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: `key "${key}": a quoted string holds a stray quote` };
      } else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: `key "${key}": a bare string opens on [` };
  return { value: raw };
}

/** A date value: YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31. */
function parseDate(raw) {
  let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
  if (ok) {
    for (let i = 0; i < 10; i++) {
      if (i === 4 || i === 7) continue;
      const c = raw.charCodeAt(i);
      if (c < 48 || c > 57) {
        ok = false;
        break;
      }
    }
  }
  let y = 0;
  let mo = 0;
  let d = 0;
  if (ok) {
    y = Number(raw.slice(0, 4));
    mo = Number(raw.slice(5, 7));
    d = Number(raw.slice(8, 10));
    if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
  }
  if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  return { value: raw };
}

/** A tags value: [a, b, c], each name trimmed, none empty or holding " [ ]. */
function parseTags(raw) {
  if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
    return { error: 'key "tags": not a list [a, b]' };
  }
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return { value: [] };
  const parts = inner.split(',');
  const tags = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].trim();
    if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    for (let j = 0; j < t.length; j++) {
      const c = t.charCodeAt(j);
      if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    tags[i] = t;
  }
  return { value: tags };
}

/** Whether `s` is a template name: a-z, 0-9 and -, at least one character. */
function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug: a-z and 0-9, single - between, at most 64 chars. */
function isSlugValue(s) {
  if (s.length === 0 || s.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return false;
  }
  return !prevDash;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      return parseString(raw, key);
    case 'date':
      return parseDate(raw);
    case 'tags':
      return parseTags(raw);
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugValue(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let closeStart = -1;
  let bodyStart = -1;
  let idx = text.indexOf('\n---', 3);
  while (idx !== -1) {
    const after = idx + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeStart = idx + 1;
      bodyStart = after === text.length ? text.length : after + 1;
      break;
    }
    idx = text.indexOf('\n---', idx + 1);
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const fmText = text.slice(4, closeStart - 1);
  const lines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 2;
    let blank = true;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${n} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = stripTrailing(line.slice(k + 2));
    else return { error: `line ${n} is not "key: value"` };
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

/** Whether `line` is blank: spaces and tabs only. */
function isBlankLine(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/**
 * A fence-open line's language, or null: three backticks, an optional
 * language of A-Z, a-z, 0-9, _ + -, then spaces or tabs only.
 */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6) return null;
  let j = k;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j === k) return null;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === j) return null;
  return { depth: k, text: line.slice(j, e) };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  let core = 0;
  if (line.startsWith('---')) core = 3;
  else if (line.startsWith('***')) core = 3;
  else return false;
  for (let i = core; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== c0 || c0 === 32 || c0 === 9) return isBlankLine(line);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/**
 * A list starting at `lines[i]` with `marker` already read: its HTML and
 * the index of the first line after it.
 */
function renderList(lines, i, marker, env) {
  const ordered = marker.ordered;
  const items = [];
  while (i < lines.length) {
    const m = listMarker(lines[i]);
    if (m !== null && m.ordered === ordered) {
      items.push([trimLine(m.text)]);
      i++;
    } else if (isContinued(lines[i])) {
      items[items.length - 1].push(trimLine(lines[i]));
      i++;
    } else break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const open = ordered && marker.start !== 1 ? `<ol start="${marker.start}">` : `<${tag}>`;
  let list = open + '\n';
  for (const parts of items) list += `<li>${inline(parts.join('\n'), env)}</li>\n`;
  list += `</${tag}>`;
  return { html: list, next: i };
}

/** A list item's marker, or null: `- ` / `* `, or digits and `. `. */
function listMarker(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
    return { ordered: false, start: 1, text: line.slice(2) };
  }
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
    if (i >= 1 && i <= 9 && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
      return { ordered: true, start: Number(line.slice(0, i)), text: line.slice(i + 2) };
    }
  }
  return null;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWSCode(line.charCodeAt(i));
}

/** The characters a backslash escapes. */
const ESCAPABLE_STR = '\\`*_[]()#+-.!>';
const HAS_WS = /\s/;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE_STR.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE_STR.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. A native
 * scan finds the next character that needs work, so plain text runs are
 * copied whole and no character is visited in JavaScript until it
 * matters. Each call makes its own scan, so a nested render cannot move
 * another's place. A `**` with no closer is left as plain text, both
 * stars at once, exactly as a character-by-character walk would.
 */
function inline(s, env) {
  let out = '';
  let i = 0;
  const scan = /[\\`*\[&<>"']/g;
  let m;
  while ((m = scan.exec(s)) !== null) {
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) {
      // backslash: an escaped character is written, escaped
      if (j + 1 < s.length && ESCAPABLE_STR.indexOf(s[j + 1]) !== -1) {
        out += s.slice(i, j) + esc(s[j + 1]);
        i = j + 2;
        scan.lastIndex = i;
      }
      continue;
    }
    if (c === 96) {
      // backtick: a code span closed by the next backtick
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += s.slice(i, j) + '<code>' + esc(s.slice(j + 1, k)) + '</code>';
        i = k + 1;
        scan.lastIndex = i;
      }
      continue;
    }
    if (c === 42) {
      // '*': strong with **, emphasis with a single *
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += s.slice(i, j) + '<strong>' + inline(s.slice(j + 2, k), env) + '</strong>';
          i = k + 2;
          scan.lastIndex = i;
        } else scan.lastIndex = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        out += s.slice(i, j) + '<em>' + inline(s.slice(j + 1, k), env) + '</em>';
        i = k + 1;
        scan.lastIndex = i;
      }
      continue;
    }
    if (c === 91) {
      // '[': a link, [text](target) with a non-empty target holding no whitespace
      const k = findUnescaped(s, ']', j + 1);
      const t = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = t === -1 ? '' : s.slice(k + 2, t);
      if (target !== '' && !HAS_WS.test(target)) {
        out += s.slice(i, j) + '<a href="' + esc(env.link(target)) + '">' + inline(s.slice(j + 1, k), env) + '</a>';
        i = t + 1;
        scan.lastIndex = i;
      }
      continue;
    }
    // one of & < > " ': written as its entity
    out += s.slice(i, j);
    out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
    i = j + 1;
    scan.lastIndex = i;
  }
  out += s.slice(i);
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id
 * and its inline HTML) and its excerpt (the first paragraph's inline
 * HTML, or ""). Lexing and rendering run in one pass, no tokens built.
 * Each line is dispatched on its first character: only the block kinds
 * that can open on it are tested.
 */
function renderMarkdown(src, env, slugCache) {
  const lines = src.split('\n');
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        let code = '<pre><code';
        if (lang !== '') code += ' class="language-' + esc(lang) + '"';
        code += '>';
        while (i < lines.length && !isFenceClose(lines[i])) {
          code += esc(lines[i]) + '\n';
          i++;
        }
        code += '</code></pre>';
        html += code + '\n';
        i++;
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text, slugCache), ids);
        const inner = inline(h.text, env);
        html += `<h${h.depth} id="${id}">${inner}</h${h.depth}>\n`;
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: inner });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        html += '<hr>\n';
        i++;
        continue;
      }
      const marker = listMarker(line);
      if (marker !== null) {
        const r = renderList(lines, i, marker, env);
        html += r.html + '\n';
        i = r.next;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        i++;
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) html += '<blockquote>\n</blockquote>\n';
      else html += '<blockquote>\n<p>' + inline(kept.join('\n'), env) + '</p>\n</blockquote>\n';
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const marker = listMarker(line);
      if (marker !== null) {
        const r = renderList(lines, i, marker, env);
        html += r.html + '\n';
        i = r.next;
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const phtml = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = phtml;
    html += `<p>${phtml}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** Whether `c` starts a path segment: a letter or _. */
function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

/** Whether `c` continues a path segment: a letter, digit or _. */
function isNameChar(c) {
  return isNameStart(c) || (c >= 48 && c <= 57);
}

/** Whether `s` is one path segment. */
function isSegment(s) {
  if (s.length === 0 || !isNameStart(s.charCodeAt(0))) return false;
  for (let i = 1; i < s.length; i++) if (!isNameChar(s.charCodeAt(i))) return false;
  return true;
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  const parts = text.split('.');
  for (const p of parts) {
    if (!isSegment(p)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return parts;
}

/** Whether `s` holds only spaces and tabs. */
function onlySpacesTabs(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpacesTabs(src.slice(lineStart, open)) && onlySpacesTabs(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** A for tag's name and path, or null: `for x in path`. */
function parseForTag(tag) {
  if (!tag.startsWith('for ')) return null;
  let j = 4;
  if (j >= tag.length || !isNameStart(tag.charCodeAt(j))) return null;
  const s = j;
  j++;
  while (j < tag.length && isNameChar(tag.charCodeAt(j))) j++;
  const varName = tag.slice(s, j);
  if (tag.slice(j, j + 4) !== ' in ') return null;
  const rest = tag.slice(j + 4);
  if (rest === '' || HAS_WS.test(rest)) return null;
  return { name: varName, path: rest };
}

/** An if tag's negation and path, or null: `if path` / `if not path`. */
function parseIfTag(tag) {
  if (!tag.startsWith('if ')) return null;
  let not = false;
  let rest = tag.slice(3);
  if (rest.startsWith('not ')) {
    not = true;
    rest = rest.slice(4);
  }
  if (rest === '' || HAS_WS.test(rest)) return null;
  return { not, path: rest };
}

/** An include tag's template name, or null: `include "name"`. */
function parseIncludeTag(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"') || tag.length < 11) return null;
  const inner = tag.slice(9, -1);
  if (inner === '') return null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return inner;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      const f = parseForTag(tag);
      if (f !== null) {
        const node = { kind: 'for', name: f.name, path: pathOf(name, f.path), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
        continue;
      }
      const cond = parseIfTag(tag);
      if (cond !== null) {
        const node = { kind: 'if', not: cond.not, path: pathOf(name, cond.path), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
        continue;
      }
      if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else {
        const inc = parseIncludeTag(tag);
        if (inc !== null) body.push({ kind: 'include', name: inc });
        else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * The value at `path` in the scope chain: its first name from the nearest
 * scope holding it, then own properties of the value so far.
 */
function lookup(scopes, parts) {
  let found = false;
  let v;
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (Object.hasOwn(scopes[i], parts[0])) {
      v = scopes[i][parts[0]];
      found = true;
      break;
    }
  }
  if (!found) return undefined;
  for (let k = 1; k < parts.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, parts[k])) return undefined;
    v = v[parts[k]];
  }
  return v;
}

/** A value as text: string itself, a number in JavaScript's digits, true/false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A parsed template compiled to a render function (S, T, D): S is the
 * scope chain (innermost last), T the map of compiled templates, D the
 * include depth. The generated code is built from the template's own
 * nodes, so a render walks no tree: text is appended, values are looked
 * up and written, loops push and pop one scope each.
 */
function compileTemplate(nodes) {
  let uid = 0;
  const parts = ['"use strict";return function(S,T,D){let o="";'];
  const gen = (ns) => {
    for (const n of ns) {
      if (n.kind === 'text') parts.push('o+=' + JSON.stringify(n.text) + ';');
      else if (n.kind === 'var') parts.push('o+=E(X(L(S,' + JSON.stringify(n.path) + ')));');
      else if (n.kind === 'raw') parts.push('o+=X(L(S,' + JSON.stringify(n.path) + '));');
      else if (n.kind === 'if') {
        parts.push('if(Y(L(S,' + JSON.stringify(n.path) + '))!==' + (n.not ? 'true' : 'false') + '){');
        gen(n.then);
        parts.push('}');
        if (n.else !== null) {
          parts.push('else{');
          gen(n.else);
          parts.push('}');
        }
      } else if (n.kind === 'for') {
        const a = '_a' + ++uid;
        const k = '_k' + uid;
        parts.push(
          '{const ' + a + '=L(S,' + JSON.stringify(n.path) + ');if(Array.isArray(' + a + ')){for(let ' + k + '=0;' + k + '<' + a + '.length;' + k + '++){S.push({' +
          n.name + ':' + a + '[' + k + '],loop:{index:' + k + '+1,first:' + k + '===0,last:' + k + '===' + a + '.length-1,length:' + a + '.length}});',
        );
        gen(n.body);
        parts.push('S.pop();}}}');
      } else if (n.kind === 'include') {
        const f = '_f' + ++uid;
        parts.push('{const ' + f + '=T.get(' + JSON.stringify(n.name) + ');if(' + f + '!==undefined&&D<' + INCLUDE_DEPTH + ')o+=' + f + '(S,T,D+1);}');
      }
    }
  };
  gen(nodes);
  parts.push('return o;}');
  return new Function('L', 'Y', 'X', 'E', parts.join(''))(lookup, truthy, textOf, esc);
}

// ---------------------------------------------------------------- the build

/** The directory of `path`: up to its last /, or "" at the root. */
function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `t` opens on a scheme: a letter, then letters, digits, + - ., then ':'. */
function isScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  let i = 1;
  while (i < t.length) {
    const c = t.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) i++;
    else break;
  }
  return i < t.length && t.charCodeAt(i) === 58;
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. A post's card is the one the cards map
 * already holds; any other page's card is built here. */
function pageOf(s, cachedCard) {
  return {
    ...(cachedCard ?? cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');

  // Templates, parsed in code-unit order of their name; one that does not
  // parse is reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // 1. The sources, in code-unit order of their paths, line ends made
  // "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    // A source that is not .md is static; a source's \r\n and lone \r
    // become \n (most files hold no \r at all, and those skip the pass).
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter, in the checks' order: refused, the
  // generator's own directories, a post with no date, a layout no
  // template has, then a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static
  // files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  // Link targets repeat across a site's bodies; a target's resolution
  // from a directory is remembered, though a broken link is still
  // reported once per source that holds it.
  const resolved = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (isScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const key = `${dir}\0${rel}`;
        let path = resolved.get(key);
        if (path === undefined) {
          path = rel === '' ? null : resolvePath(dir, rel);
          resolved.set(key, path);
        }
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and
  // older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the
  // posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing
  // (url "") where no post has it.
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages
  // through theirs, then each static file at its own path.
  const output = {};
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const render = (name, vars) => {
    const fn = templates.get(name);
    return fn === undefined ? null : fn([{ site, tags: allTags, recent, ...vars }], templates, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, cards.get(s)) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that
  // did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
