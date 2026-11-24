// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Same answers as the reference on every input, written for CPU time:
// no regex in hot paths, batched HTML escaping, ASCII fast paths for slugs,
// index-based line scans instead of split-then-regex, per-build slug cache.
//
// Built in this Muse session (muse-app / meta route): the HMS/DeepSeek route
// was attempted first and failed technically (helper read timeouts at 120 s;
// a streaming call delivered only 93 bytes of non-code text in ~11.5 min),
// so no DeepSeek code is used here.

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------ text helpers

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/; // no /g: .test must always start at 0
const ESC_REP = /[&<>"']/g;
const ESC_FN = (c) => ESC[c];

/** escapeHtml: fast path when nothing needs escaping, else a native regex replace. */
function esc(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_REP, ESC_FN) : s;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** date_long from the string alone: "2026-11-09" -> "9 November 2026". */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** JS \s whitespace, by UTF-16 code unit (the set is all BMP). */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;

/** Whether code unit `c` is JS \s whitespace. */
function isWS(c) { return WS_TABLE[c] === 1; }

/** Words of a body: runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)] === 0) {
      if (!inWord) { n++; inWord = true; }
    } else inWord = false;
  }
  return n;
}

/** The slug of `text` (reference rule). ASCII is handled in one pass; any
 * non-ASCII character restarts through the Unicode path (NFKD + marks). */
function slugifyRaw(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c.charCodeAt(0) > 127) return slugifyUnicode(text);
    let keep = null;
    if (c >= 'A' && c <= 'Z') keep = c.toLowerCase();
    else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) keep = c;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  return slugCut(out);
}

/** The slug of `text` through NFKD + combining-mark removal. */
function slugifyUnicode(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  return slugCut(out);
}

/** Cut a slug to 64 characters, drop a trailing '-' left at the cut, or 'untitled'. */
function slugCut(out) {
  if (out.length > 64) out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out[e - 1] === '-') e--;
  out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isLower(c) { return (c >= 'a' && c <= 'z') || c === '_'; }
function isAlnum(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_'; }
function isDigit(c) { return c >= '0' && c <= '9'; }

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      // YYYY-MM-DD, a real day 1970-01-01..2099-12-31.
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw[i])) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        let t = parts[i];
        let a = 0;
        let b = t.length;
        while (a < b && (t[a] === ' ' || t[a] === '\t')) a++;
        while (b > a && (t[b - 1] === ' ' || t[b - 1] === '\t')) b--;
        t = t.slice(a, b);
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t[j];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true; // slug must not start with '-'
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '-') {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * `text` has "\n" line ends. Mirrors the reference exactly, including
 * its error strings and the line numbers in them.
 */
function parseFrontMatter(text) {
  // First line must be exactly '---'.
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Find the closing line '---' (a line of its own). It can sit right after
  // the opening line, so the search starts at the '\n' ending the opening.
  let closeStart = -1; // index of the '\n' before the closing line, or -1
  let searchFrom = 3;
  while (true) {
    const nl = text.indexOf('\n---', searchFrom);
    if (nl === -1) break;
    const after = nl + 4;
    if (after === text.length || text[after] === '\n') { closeStart = nl; break; }
    searchFrom = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const fmBlock = text.slice(4, closeStart); // between the two '---' lines, without their '\n's
  const data = {};
  // Walk the block's lines with their 1-based numbers (opening '---' is line 1).
  let lineNo = 1;
  let pos = 0;
  while (pos <= fmBlock.length) {
    let eol = fmBlock.indexOf('\n', pos);
    if (eol === -1) eol = fmBlock.length;
    const line = fmBlock.slice(pos, eol);
    lineNo++;
    pos = eol + 1;
    // Blank (spaces/tabs only) or a comment (opening on '#').
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== ' ' && line[i] !== '\t') { blank = false; break; }
    }
    if (blank || line[0] === '#') {
      if (pos > fmBlock.length) break;
      continue;
    }
    // "key: value": key of a-z and '_', a colon, one space and the value.
    let k = 0;
    while (k < line.length && isLower(line[k])) k++;
    if (k === 0 || k >= line.length || line[k] !== ':') return { error: `line ${lineNo} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line[k + 1] === ' ') raw = line.slice(k + 2);
    else return { error: `line ${lineNo} is not "key: value"` };
    // Trailing spaces and tabs dropped.
    let e = raw.length;
    while (e > 0 && (raw[e - 1] === ' ' || raw[e - 1] === '\t')) e--;
    raw = raw.slice(0, e);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    if (pos > fmBlock.length) break;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const bodyStart = closeStart + 4 + (closeStart + 4 < text.length ? 1 : 0);
  return { data, body: bodyStart <= text.length ? text.slice(bodyStart) : '' };
}

// ------------------------------------------------------------ markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/**
 * The first index from `from` where `s` holds `what` outside a backslash escape, or -1.
 * Found with indexOf; a match is escaped when an odd run of backslashes
 * stands right before it (counted back to `from`, as the reference's
 * left-to-right scan from `from` pairs them).
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let n = 0;
    for (let b = j - 1; b >= from && s[b] === '\\'; b--) n++;
    if (n % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let n = 0;
    for (let b = j - 1; b >= from && s[b] === '\\'; b--) n++;
    if (n % 2 === 1) { j = s.indexOf('*', j + 1); continue; } // escaped
    if (s[j + 1] === '*') { j = s.indexOf('*', j + 2); continue; } // part of **
    return j;
  }
  return -1;
}

const MARK_RE = /[\\`*[]/g;
/** Index of the next markup character (`\`, backtick, `*` or `[`) at or after `from`, or -1. */
function findMark(s, from) {
  MARK_RE.lastIndex = from;
  const m = MARK_RE.exec(s);
  return m === null ? -1 : m.index;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href.
 * Markup characters are found with native indexOf scans (one per construct),
 * plain runs go through esc() in one piece; failed constructs stay plain.
 */
function inline(s, env) {
  let out = '';
  let plainStart = 0; // start of the current plain run
  let searchPos = 0; // where the next markup search resumes
  while (true) {
    const pos = findMark(s, searchPos);
    if (pos === -1) {
      if (plainStart < s.length) out += esc(s.slice(plainStart));
      return out;
    }
    const c = s[pos];
    if (c === '\\') {
      if (pos + 1 < s.length && ESCAPABLE.has(s[pos + 1])) {
        if (pos > plainStart) out += esc(s.slice(plainStart, pos));
        out += esc(s[pos + 1]);
        plainStart = pos + 2;
        searchPos = pos + 2;
      } else {
        // A backslash before any other character is itself.
        searchPos = pos + 1;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', pos + 1);
      if (j > pos + 1) {
        if (pos > plainStart) out += esc(s.slice(plainStart, pos));
        out += `<code>${esc(s.slice(pos + 1, j))}</code>`;
        plainStart = j + 1;
        searchPos = j + 1;
      } else {
        searchPos = pos + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[pos + 1] === '*') {
        const j = findUnescaped(s, '**', pos + 2);
        if (j > pos + 2) {
          if (pos > plainStart) out += esc(s.slice(plainStart, pos));
          out += `<strong>${inline(s.slice(pos + 2, j), env)}</strong>`;
          plainStart = j + 2;
          searchPos = j + 2;
        } else {
          searchPos = pos + 2;
        }
        continue;
      }
      const j = findSingleStar(s, pos + 1);
      if (j > pos + 1) {
        if (pos > plainStart) out += esc(s.slice(plainStart, pos));
        out += `<em>${inline(s.slice(pos + 1, j), env)}</em>`;
        plainStart = j + 1;
        searchPos = j + 1;
      } else {
        searchPos = pos + 1;
      }
      continue;
    }
    // '[': a link, or itself.
    const k = findUnescaped(s, ']', pos + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      if (pos > plainStart) out += esc(s.slice(plainStart, pos));
      out += `<a href="${esc(env.link(target))}">${inline(s.slice(pos + 1, k), env)}</a>`;
      plainStart = m + 1;
      searchPos = m + 1;
    } else {
      searchPos = pos + 1;
    }
  }
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** Trim spaces and tabs at both ends (the original string when nothing is trimmed). */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-';
}

/** Fence open: ``` + optional language, then spaces/tabs only. Returns the language or null. */
function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  while (i < line.length && isLangChar(line[i])) i++;
  const lang = line.slice(3, i);
  while (i < line.length) {
    if (line[i] !== ' ' && line[i] !== '\t') return null;
    i++;
  }
  return lang;
}

/** Fence close: ``` then spaces/tabs only. */
function fenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length || (line[n] !== ' ' && line[n] !== '\t')) return null;
  let a = n;
  while (a < line.length && (line[a] === ' ' || line[a] === '\t')) a++;
  let b = line.length;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** A thematic break: --- or ***, then spaces/tabs only. */
function isHr(line) {
  if (line !== '---' && line !== '***') {
    if (!line.startsWith('---') && !line.startsWith('***')) return false;
    const head = line.slice(0, 3);
    if (head !== '---' && head !== '***') return false;
    for (let i = 3; i < line.length; i++) {
      if (line[i] !== ' ' && line[i] !== '\t') return false;
    }
    return true;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  const c0 = line[0];
  if (c0 === undefined || c0 === ' ' || c0 === '\t') return isBlank(line);
  if (c0 === '`') return fenceOpen(line) !== null;
  if (c0 === '#') return headingOf(line) !== null;
  if (c0 === '-' || c0 === '*') return isHr(line);
  return false;
}

/** Bullet item: line is "- " or "* ". Returns the item text or null. */
function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** Ordered item: digits (1-9) + ". ". Returns { num, text } or null. */
function orderedOf(line) {
  let n = 0;
  while (n < line.length && line[n] >= '0' && line[n] <= '9') n++;
  if (n === 0 || n > 9) return null;
  if (line[n] !== '.' || line[n + 1] !== ' ') return null;
  return { num: Number(line.slice(0, n)), text: line.slice(n + 2) };
}

/** A continuation line: 2+ spaces then a non-space. */
function isContinued(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  if (n < 2 || n >= line.length) return false;
  const c = line.charCodeAt(n);
  return !isWS(c);
}

/**
 * `src` rendered: its HTML, its table of contents (level 2/3 headings) and
 * its excerpt (the first paragraph's inline HTML, or "").
 * Lines are scanned by index, never split into an array.
 */
function renderMarkdown(src, env, slugCache) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  // One native split; the trailing '' of a final '\n' is a blank line, as in
  // the reference's own split.
  const lines = src.split('\n');
  let li = 0;
  const nextLine = () => (li < lines.length ? lines[li++] : null);
  let line = nextLine();
  while (line !== null) {
    const c0 = line[0];
    if (c0 === undefined || c0 === ' ' || c0 === '\t') {
      // A blank line, or a paragraph line opening on spaces/tabs.
      if (isBlank(line)) { line = nextLine(); continue; }
    } else if (c0 === '`') {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        line = nextLine();
        while (line !== null && !fenceClose(line)) { body.push(line); line = nextLine(); }
        if (line !== null) line = nextLine(); // skip the closing fence
        const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
        let code = `<pre><code${cls}>`;
        for (let i = 0; i < body.length; i++) code += `${esc(body[i])}\n`;
        code += '</code></pre>';
        blocks.push(code);
        continue;
      }
    } else if (c0 === '#') {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugifyCached(heading.text, slugCache), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        line = nextLine();
        continue;
      }
    } else if (c0 === '-' || c0 === '*') {
      if (isHr(line)) {
        blocks.push('<hr>');
        line = nextLine();
        continue;
      }
      const bText = bulletOf(line);
      if (bText !== null) {
        const items = [];
        while (line !== null) {
          const m = bulletOf(line);
          if (m !== null) { items.push([trimLine(m)]); line = nextLine(); continue; }
          if (isContinued(line)) { items[items.length - 1].push(trimLine(line)); line = nextLine(); continue; }
          break;
        }
        let html = '<ul>\n';
        for (let i = 0; i < items.length; i++) html += `<li>${inline(items[i].join('\n'), env)}</li>\n`;
        html += '</ul>';
        blocks.push(html);
        continue;
      }
    } else if (c0 === '>') {
      const body = [];
      while (line !== null && line[0] === '>') {
        let t = line.slice(1);
        if (t[0] === ' ') t = t.slice(1);
        t = trimLine(t);
        if (t !== '') body.push(t);
        line = nextLine();
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(body.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= '0' && c0 <= '9') {
      const oItem = orderedOf(line);
      if (oItem !== null) {
        const items = [];
        while (line !== null) {
          const m = orderedOf(line);
          if (m !== null) { items.push([trimLine(m.text)]); line = nextLine(); continue; }
          if (isContinued(line)) { items[items.length - 1].push(trimLine(line)); line = nextLine(); continue; }
          break;
        }
        const open = oItem.num !== 1 ? `<ol start="${oItem.num}">` : '<ol>';
        let html = `${open}\n`;
        for (let i = 0; i < items.length; i++) html += `<li>${inline(items[i].join('\n'), env)}</li>\n`;
        html += '</ol>';
        blocks.push(html);
        continue;
      }
    }
    // Paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    const body = [trimLine(line)];
    line = nextLine();
    while (line !== null && !endsParagraph(line)) { body.push(trimLine(line)); line = nextLine(); }
    const text = body.length === 1 ? body[0] : body.join('\n');
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

/** Cached slugify (per build): titles and tag names repeat across pages. */
function slugifyCached(text, cache) {
  let s = cache.get(text);
  if (s === undefined) {
    s = slugifyRaw(text);
    cache.set(text, s);
  }
  return s;
}

// ------------------------------------------------------------ templates

const INCLUDE_DEPTH = 8;

class TemplateError extends Error {}

function isNameStart(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'; }

function isSpacesOnly(src, a, b) {
  for (let i = a; i < b; i++) {
    if (src[i] !== ' ' && src[i] !== '\t') return false;
  }
  return true;
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  const n = text.length;
  let i = 0;
  while (true) {
    if (i >= n || !isNameStart(text[i])) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
    i++;
    while (i < n && isAlnum(text[i])) i++;
    if (i === n) return text.split('.');
    if (text[i] !== '.') throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
    i++;
  }
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
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
    const standalone = isSpacesOnly(src, lineStart, open) && isSpacesOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `for x in path` or null. */
function parseFor(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  if (i >= tag.length || !isNameStart(tag[i])) return null;
  const start = i;
  i++;
  while (i < tag.length && isAlnum(tag[i])) i++;
  const varName = tag.slice(start, i);
  if (tag.slice(i, i + 4) !== ' in ') return null;
  i += 4;
  if (i >= tag.length) return null;
  const path = tag.slice(i);
  for (let j = 0; j < path.length; j++) {
    if (isWS(path.charCodeAt(j))) return null;
  }
  return { name: varName, path };
}

/** `if [not] path` or null. */
function parseIf(tag) {
  if (!tag.startsWith('if ')) return null;
  let i = 3;
  let not = false;
  if (tag.startsWith('not ', i)) { not = true; i += 4; }
  if (i >= tag.length) return null;
  const path = tag.slice(i);
  for (let j = 0; j < path.length; j++) {
    if (isWS(path.charCodeAt(j))) return null;
  }
  return { not, path };
}

/** `include "name"` or null. */
function parseInclude(tag) {
  if (!tag.startsWith('include "') || tag.length < 11 || tag[tag.length - 1] !== '"') return null;
  const incName = tag.slice(9, -1);
  if (incName.length === 0) return null;
  for (let i = 0; i < incName.length; i++) {
    const c = incName[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return null;
  }
  return incName;
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
      let m;
      if ((m = parseFor(tag)) !== null) {
        const node = { kind: 'for', name: m.name, path: pathOf(name, m.path), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = parseIf(tag)) !== null) {
        const node = { kind: 'if', not: m.not, path: pathOf(name, m.path), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = parseInclude(tag)) !== null) body.push({ kind: 'include', name: m });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: string itself, number in JS digits, true/false, array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The value at `name` in the scope chain (for names no lexical binding covers). */
function lk(S, name) {
  let s = S;
  while (s !== null && !Object.hasOwn(s.vars, name)) s = s.parent;
  return s === null ? undefined : s.vars[name];
}

/** Own-property walk for the segments after the first: `v.a.b.c`, or undefined. */
function getp(v, a, b, c) {
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, a)) return undefined;
  v = v[a];
  if (b === undefined) return v;
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  v = v[b];
  if (c === undefined) return v;
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, c)) return undefined;
  return v[c];
}

/**
 * The same walk without the own-property check, for value positions only
 * ({{ }}, {{{ }}} and for-arrays): a prototype value reached there collapses
 * to "" under textOf, or fails Array.isArray, exactly as undefined would.
 * If-conditions keep getp, where a prototype function would read truthy.
 */
function getf(v, a, b, c) {
  if (v === null || typeof v !== 'object') return undefined;
  v = v[a];
  if (b === undefined) return v;
  if (v === null || typeof v !== 'object') return undefined;
  v = v[b];
  if (c === undefined) return v;
  if (v === null || typeof v !== 'object') return undefined;
  return v[c];
}

/** Own-property walk for paths with more than 3 segments after the first. */
function getpN(v, segs) {
  for (let i = 0; i < segs.length; i++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, segs[i])) return undefined;
    v = v[segs[i]];
  }
  return v;
}

/** The same, without the own-property check, for value positions only. */
function getfN(v, segs) {
  for (let i = 0; i < segs.length; i++) {
    if (v === null || typeof v !== 'object') return undefined;
    v = v[segs[i]];
  }
  return v;
}

/** The names the build ever puts in a render's root vars. */
const TOP_NAMES = new Set(['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag']);

/**
 * Compile a parsed template into a render function
 * (R, S, D, esc, textOf, truthy, lk, getp, getpN, getf, getfN, F) -> string:
 * R is the root vars, S the scope chain (null at the top), D the include
 * depth; the rest are the helpers, passed separately so the generated code
 * calls them directly instead of through an object.
 * Loop variables become lexical consts, so the body reads them directly;
 * anything else resolves through R (top names) or lk (outer loop vars seen
 * from an include). Parsing already validated the template, so codegen here
 * cannot fail on it. The output is built with += on a local string: V8
 * keeps it a rope, and the one flattening pass happens when the caller
 * uses the string, outside the hot render loop.
 */
function compileTemplate(nodes) {
  let tmp = 0;
  const lines = ['let $o=\'\';'];
  const env = []; // bound names, innermost last (a loop var and 'loop' per for)
  const pathExpr = (path, fast) => {
    const first = path[0];
    let base;
    if (env.includes(first)) base = first;
    else if (TOP_NAMES.has(first)) base = `R.${first}`;
    else base = `lk(S,${JSON.stringify(first)})`;
    if (path.length === 1) return base;
    const g = fast ? 'getf' : 'getp';
    const gN = fast ? 'getfN' : 'getpN';
    if (path.length <= 4) return `${g}(${base},${path.slice(1).map((s) => JSON.stringify(s)).join(',')})`;
    return `${gN}(${base},[${path.slice(1).map((s) => JSON.stringify(s)).join(',')}])`;
  };
  // Does a for-body need the scope frame it would build per iteration?
  // The frame is only read by include calls (they pass S on) and by lk()
  // lookups for names no lexical binding covers. If the body subtree has
  // neither, the loop variable and `loop` are lexical and the frame (and
  // the S save/restore) can be skipped entirely.
  const analyzeBody = (ns, envSet) => {
    const r = { hasInclude: false, needsLk: false, usesLoop: false };
    const merge = (o) => { r.hasInclude ||= o.hasInclude; r.needsLk ||= o.needsLk; r.usesLoop ||= o.usesLoop; };
    for (const n of ns) {
      if (n.kind === 'include') { r.hasInclude = true; continue; }
      if (n.kind === 'text') continue;
      if (n.path[0] === 'loop') r.usesLoop = true;
      else if (!envSet.has(n.path[0]) && !TOP_NAMES.has(n.path[0])) r.needsLk = true;
      if (n.kind === 'if') {
        merge(analyzeBody(n.then, envSet));
        if (n.else !== null) merge(analyzeBody(n.else, envSet));
      } else if (n.kind === 'for') {
        const inner = new Set(envSet);
        inner.add(n.name);
        inner.add('loop');
        merge(analyzeBody(n.body, inner));
      }
    }
    return r;
  };
  const emit = (ns) => {
    for (let ni = 0; ni < ns.length; ni++) {
      const n = ns[ni];
      switch (n.kind) {
        case 'text':
          lines.push(`$o+=${JSON.stringify(n.text)};`);
          break;
        case 'var': {
          const t = `$v${tmp++}`;
          lines.push(`const ${t}=${pathExpr(n.path, true)};$o+=esc(typeof ${t}==="string"?${t}:textOf(${t}));`);
          break;
        }
        case 'raw': {
          const t = `$v${tmp++}`;
          lines.push(`const ${t}=${pathExpr(n.path, true)};$o+=typeof ${t}==="string"?${t}:textOf(${t});`);
          break;
        }
        case 'if': {
          lines.push(`if(${n.not ? '!' : ''}truthy(${pathExpr(n.path)})){`);
          emit(n.then);
          lines.push('}');
          if (n.else !== null) {
            lines.push('else{');
            emit(n.else);
            lines.push('}');
          }
          break;
        }
        case 'for': {
          const a = `$a${tmp++}`;
          const k = `$k${tmp++}`;
          const isLoopName = n.name === 'loop';
          const info = analyzeBody(n.body, new Set(env));
          const needsFrame = info.hasInclude || info.needsLk;
          if (needsFrame) {
            lines.push(`{const ${a}=${pathExpr(n.path, true)};if(Array.isArray(${a})){for(let ${k}=0;${k}<${a}.length;${k}++){`);
            if (!isLoopName) lines.push(`const ${n.name}=${a}[${k}];`);
            lines.push(`const loop={index:${k}+1,first:${k}===0,last:${k}===${a}.length-1,length:${a}.length};`);
            lines.push(`const $s={vars:{[${JSON.stringify(n.name)}]:${isLoopName ? 'loop' : n.name},loop},parent:S};const $p=S;S=$s;`);
            env.push(n.name);
            env.push('loop');
            emit(n.body);
            env.pop();
            env.pop();
            lines.push('S=$p;}}}');
          } else {
            lines.push(`{const ${a}=${pathExpr(n.path, true)};if(Array.isArray(${a})){for(let ${k}=0;${k}<${a}.length;${k}++){`);
            if (!isLoopName) lines.push(`const ${n.name}=${a}[${k}];`);
            if (info.usesLoop || isLoopName) lines.push(`const loop={index:${k}+1,first:${k}===0,last:${k}===${a}.length-1,length:${a}.length};`);
            env.push(n.name);
            env.push('loop');
            emit(n.body);
            env.pop();
            env.pop();
            lines.push('}}}');
          }
          break;
        }
        case 'include':
          lines.push(`if(D<${INCLUDE_DEPTH}){const $f=F.get(${JSON.stringify(n.name)});if($f)$o+=$f(R,S,D+1,esc,textOf,truthy,lk,getp,getpN,getf,getfN,F);}`);
          break;
      }
    }
  };
  emit(nodes);
  lines.push('return $o;');
  return new Function('R', 'S', 'D', 'esc', 'textOf', 'truthy', 'lk', 'getp', 'getpN', 'getf', 'getfN', 'F', lines.join('\n'));
}

// ------------------------------------------------------------ the build

/** `rel` (a link's path) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A target with a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true; // ':'
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const slugOf = (text) => slugifyCached(text, slugCache);
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const b = {
    input,
    base,
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. Sources, in code-unit order of their paths.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      b.sources.push({ path: f.path, text });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter and the drop checks, in order.
  const kept = [];
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Permalinks.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target[0] === '/' || target[0] === '#') return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let i = 0; i < tags.length; i++) {
      const name = tags[i];
      const slug = slugOf(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (let i = 0; i < b.posts.length; i++) {
    const p = b.posts[i];
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => bySlug.get(slugOf(name)) ?? { name, slug: slugOf(name), url: '', posts: [] });
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, pages and layouts.
  const tagLink = new Map();
  for (const t of b.tags) tagLink.set(t, { name: t.name, slug: t.slug, url: t.url });
  for (const s of b.sources) s.cardTags = s.tagRefs.map((t) => tagLink.get(t) ?? { name: t.name, slug: t.slug, url: t.url });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.cardTags,
  });
  const pageOf = (s) => ({
    ...(s.post ? b.cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, input.site.recent).map((p) => b.cards.get(p));
  // Compile every template once per case, then render through the compiled
  // functions (R = root vars, S = scope chain, D = include depth).
  const compiled = new Map();
  for (const [name, nodes] of b.templates) compiled.set(name, compileTemplate(nodes));
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    return fn(vars, null, 0, esc, textOf, truthy, lk, getp, getpN, getf, getfN, compiled);
  };
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    b.output[`${s.outDir}/index.html`] = render(s.layout, { site, tags: allTags, recent, page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      site,
      tags: allTags,
      recent,
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
  for (let i = 0; i < b.tags.length; i++) {
    const t = b.tags[i];
    const html = render('tag', { site, tags: allTags, recent, tag: tagOf(t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < b.statics.length; i++) {
    const f = b.statics[i];
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 7. The report.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pageCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return b.output;
}
