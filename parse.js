// A fast drop-in for marked 18.1.3 (default options: gfm on, breaks off,
// pedantic off, async off). Written from scratch to match marked's HTML
// byte for byte on CommonMark 0.31.2 + GFM 0.29 inputs. No dependencies.

const TAG_NAMES = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// --- small string helpers -------------------------------------------------
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_NOENC_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_TEST = /[&<>"']/;
const ESC_NOENC_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
function esc(s, encodeAll) {
  if (encodeAll) {
    return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESC_MAP[c]) : s;
  }
  return ESC_NOENC_TEST.test(s) ? s.replace(ESC_NOENC_RE, (c) => ESC_MAP[c]) : s;
}
const NUM_REF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function unesc(s) {
  if (!NUM_REF_RE.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP_RE, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}
function cleanUrl(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return null; }
}
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}
function findClose(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1]) { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}
// strip trailing chars: if invert, strip chars != ch; else strip chars == ch
function rtrim(s, ch, invert) {
  let n = s.length, k = 0;
  while (k < n) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !invert) k++;
    else if (c !== ch && invert) k++;
    else break;
  }
  return s.slice(0, n - k);
}
function stripTrailBlank(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}
function expandTabs(s, col) {
  let out = '', c = col || 0;
  for (const ch of s) {
    if (ch === '\t') { const r = 4 - c % 4; out += ' '.repeat(r); c += r; }
    else { out += ch; c++; }
  }
  return out;
}
// split a table row on unescaped pipes
function splitCells(s, count) {
  const t = s.replace(/\|/g, (m, off, str) => {
    let escaped = false, p = off;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(' |');
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim() && cells.pop(), count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}
// regex-source builder: replace placeholders in a source string
function rep(src, ...pairs) {
  let t = typeof src === 'string' ? src : src.source;
  for (let i = 0; i < pairs.length; i += 2) {
    const pat = pairs[i], val = pairs[i + 1];
    const v = (typeof val === 'string' ? val : val.source).replace(/(^|[^\[])\^/g, '$1');
    t = t.replace(pat, v);
  }
  return t;
}
function rx(src, flags) { return new RegExp(src, flags); }

// --- block grammar (GFM) --------------------------------------------------
const RE_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const RE_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const RE_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const RE_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const RE_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const RE_TEXT = /^[^\n]+/;
const LABEL_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const TITLE_SRC = '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))';
const RE_DEF = rx(rep('^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)', 'label', LABEL_SRC, 'title', TITLE_SRC));
const BULLET_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const RE_LIST_START = rx('^' + BULLET_SRC);
const RE_LIST_ITEM = rx(rep('^(bull)([ \\t][^\\n]*?)?(?:\\n|$)', 'bull', BULLET_SRC));
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const RE_HTML_BLOCK = rx(rep('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'comment', HTML_COMMENT, 'tag', TAG_NAMES, 'attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/), 'i');
const HTML_BEGIN_SRC = rep('^ {0,3}(?:</?(?:tag)(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'tag', TAG_NAMES);
const PARA_SRC = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
function paraRegex(listSrc) {
  return rx(rep(PARA_SRC, 'hr', RE_HR, 'heading', ' {0,3}#{1,6}(?:\\s|$)', '|lheading', '', 'table', RE_TABLE_SRC, 'blockquote', ' {0,3}>', 'fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)', 'list', listSrc, 'html', rep(' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'tag', TAG_NAMES)));
}
const RE_TABLE_SRC = rep('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)', 'hr', RE_HR, 'heading', ' {0,3}#{1,6}(?:\\s|$)', 'blockquote', ' {0,3}>', 'code', '(?: {4}| {0,3}\t)[^\\n]', 'fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)', 'list', ' {0,3}(?:[*+-]|1[.)])[ \\t]', 'html', rep(' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'tag', TAG_NAMES));
const RE_TABLE = rx(RE_TABLE_SRC);
const HR_FRAG = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const RE_LHEADING = rx(rep('^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)', /bull/g, BULLET_SRC, 'blockCode', /(?: {4}| {0,3}\t)/, /fences/g, / {0,3}(?:`{3,}|~{3,})/, /blockquote/g, / {0,3}>/, /heading/g, / {0,3}#{1,6}(?:\s|$)/, /hr/g, HR_FRAG, /html/g, / {0,3}<[^\n>]+>\n/, /table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/));
const RE_PARAGRAPH = paraRegex(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]');
const RE_BLOCKQUOTE = rx(rep('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+', 'paragraph', paraRegex(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)')));

// misc block regexes
const RE_CODE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const RE_INDENT_FENCE = /^(\s+)(?:```)/;
const RE_BEGIN_SPACE = /^\s+/;
const RE_END_HASH = /#$/;
const RE_START_SPACE = /^ /;
const RE_END_SPACE = / $/;
const RE_END_SPACE_TAB = /[ \t]$/;
const RE_NON_SPACE = /[^ ]/;
const RE_NEWLINE_G = /\n/g;
const RE_TAB_G = /\t/g;
const RE_LEAD_SPACE_TAB = /^[ \t]+/;
const RE_BLANK = /^[ \t]*$/;
const RE_DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const RE_BQ_START = /^ {0,3}>/;
const RE_BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RE_BQ_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const RE_BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const RE_LIST_NEST = /^ {1,4}(?=( {4})*[^ ])/g;
const RE_LIST_TASK = /^\[[ xX]\][ \t]+\S/;
const RE_LIST_TASK_REP = /^\[[ xX]\][ \t]+/;
const RE_LIST_CHECKBOX = /\[[ xX]\]/;
const RE_ANY_LINE = /\n.*\n/;
const RE_HREF_BRACKETS = /^<(.*)>$/;
const RE_TABLE_DELIM = /[:|]/;
const RE_TABLE_ALIGN_TRIM = /^\||\| *$/g;
const RE_TABLE_ROW_BLANK = /\n[ \t]*$/;
const RE_TABLE_RIGHT = /^ *-+: *$/;
const RE_TABLE_CENTER = /^ *:-+: *$/;
const RE_TABLE_LEFT = /^ *:-+ *$/;
const RE_START_A = /^<a /i;
const RE_END_A = /^<\/a>/i;
const RE_START_PRE = /^<(pre|code|kbd|script)(\s|>)/i;
const RE_END_PRE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const RE_START_ANGLE = /^</;
const RE_END_ANGLE = />$/;

// --- inline grammar (GFM) -------------------------------------------------
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_NO_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NO_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const RE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const RE_CODE_SPAN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const RE_PUNCT_ONLY = /^((?![*_])[\s\p{P}\p{S}])/u;
const RE_AUTOLINK = rx(rep('^<(scheme:[^\\s\\x00-\\x1f<>]*|email)>', 'scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/, 'email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/));
const EMAIL_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_GRP_RE = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const PROTOCOL_RE = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const MAILTO_RE = rx(rep('(?:mailto:email|xmpp:email(?:\\/[A-Za-z0-9@.]+)?)', /email/g, EMAIL_RE));
const RE_URL = rx(rep('^emailProtocol|^((?:protocol):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^email', 'emailProtocol', MAILTO_RE, 'protocol', PROTOCOL_RE, 'email', EMAIL_GRP_RE));
const RE_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const HTML_COMMENT_FULL = /<!--(?:-?>|[\s\S]*?-->)/;
const RE_TAG = rx(rep('^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>', 'comment', HTML_COMMENT_FULL, 'attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/));
const BRACKET_INNER = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_INNER = rx(rep('(?:\\[(?:brackets|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?', 'brackets', BRACKET_INNER));
const RE_LINK = rx(rep('^!?\\[(label)\\]\\([ \\t\\n]*(href)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(title))?[ \\t\\n]*\\)', 'label', LABEL_INNER, 'href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/, 'title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/));
const RE_REFLINK = rx(rep('^!?\\[(label)\\]\\[(ref)\\]', 'label', LABEL_INNER, 'ref', LABEL_SRC));
const RE_NOLINK = rx(rep('^!?\\[(ref)\\](?:\\[\\])?', 'ref', LABEL_SRC));
const REFLINK_SEARCH_LABEL = rx(rep('(?:[^\\[\\]\\\\`]*(?:\\[(?:brackets|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?', 'brackets', BRACKET_INNER));
const REFLINK_SEARCH_REF = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const RE_REFLINK_SEARCH = rx(rep('reflink|nolink(?!\\()', 'reflink', rx(rep('^!?\\[(label)\\]\\[(ref)\\]', 'label', REFLINK_SEARCH_LABEL, 'ref', REFLINK_SEARCH_REF)), 'nolink', rx(rep('^!?\\[(ref)\\](?:\\[\\])?', 'ref', REFLINK_SEARCH_REF))), 'g');
const RE_BLOCK_SKIP = rx(rep('link|precode-code|html', 'link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/, 'precode-', '(?<!`)()', 'code', /(?<b>`+)[^`]+\k<b>(?!`)/, 'html', /<(?! )[^<>]*?>/), 'g');
const EM_L_DELIM_SRC = '^(?:\\*+(?:((?!\\*)punct)|([^\\s*]))?)|^_+(?:((?!_)punct)|([^\\s_]))?';
const RE_EM_L_DELIM = rx(rep(EM_L_DELIM_SRC, /punct/g, PUNCT_NO_TILDE), 'u');
const EM_R_AST_SRC = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const RE_EM_R_AST = rx(rep(EM_R_AST_SRC, /notPunctSpace/g, NOT_PUNCT_SPACE_TILDE, /punctSpace/g, PUNCT_SPACE_NO_TILDE, /punct/g, PUNCT_NO_TILDE), 'gu');
const EM_R_UND_SRC = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const RE_EM_R_UND = rx(rep(EM_R_UND_SRC, /notPunctSpace/g, NOT_PUNCT_SPACE, /punctSpace/g, PUNCT_SPACE, /punct/g, PUNCT), 'gu');
const RE_DEL_L_DELIM = rx(rep('^(~~?)(?:((?!~)punct)|[^\\s~])', 'punct', PUNCT), 'u');
const DEL_R_SRC = '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
const RE_DEL_R = rx(rep(DEL_R_SRC, /notPunctSpace/g, NOT_PUNCT_SPACE, /punctSpace/g, PUNCT_SPACE, /punct/g, PUNCT), 'gu');

// --- emphasis masking + link helpers --------------------------------------
const RE_OUTPUT_LINK = /\\([\[\]])/g;
function fenceIndentFix(raw, code) {
  const m = raw.match(RE_INDENT_FENCE);
  if (m === null) return code;
  const ind = m[1];
  return code.split('\n').map((line) => {
    const o = line.match(RE_BEGIN_SPACE);
    if (o === null) return line;
    return line.slice(Math.min(o[0].length, ind.length));
  }).join('\n');
}
function labelHasTag(src, label, startIdx) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const m = RE_CODE_SPAN.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const r = src.slice(startIdx + s);
    const o = RE_TAG.exec(r) || RE_AUTOLINK.exec(r);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}
// scan masked source for the last position a *, _ or ~ run could close
const RUN_RE = /(\*+|_+|~+)/g;
function scanClosers(a) {
  const e = { '*': -1, '_': -1 };
  let t = -1;
  RUN_RE.lastIndex = 0;
  let m;
  while ((m = RUN_RE.exec(a)) !== null) {
    const s = m.index;
    const o = s === 0 ? '\n' : a[s - 1];
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      const r = m[0][0];
      if (r === '~') t = s; else e[r] = s;
    }
  }
  return { em: e, del: t };
}
function linkInText(src, links) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(RE_BLOCK_SKIP)) {
    if (RE_LINK.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(RE_REFLINK_SEARCH)) {
    const s = m[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !links.has(normLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}
function maskSrc(src, links, st) {
  let t = src;
  if (links.size > 0 && src.includes('[')) {
    const repl = (r) => {
      const o = r.lastIndexOf('[');
      if (!links.has(normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, links)) return '[' + inner.replace(RE_REFLINK_SEARCH, repl) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(RE_REFLINK_SEARCH, repl);
  }
  if (src.includes('`') || src.includes('\\')) {
    t = t.replace(ANY_PUNCT_OUTSIDE_CODE, (n, s, r) =>
      r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  }
  if (src.includes('](') || src.includes('`') || src.includes('<')) {
    t = t.replace(RE_BLOCK_SKIP, (n, s, r) => {
      const o = r ? r.length : 0;
      return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
    });
  }
  return t;
}
// build a link/image token; returns undefined when a link nested in a link
function makeLink(match, link, raw, st, textOnly) {
  const text = match[1].replace(RE_OUTPUT_LINK, '$1');
  const isImage = match[0].charAt(0) === '!';
  const prevInLink = st.inLink, prevEmitted = st.linkEmitted, prevRaw = st.inRawBlock;
  st.inLink = true; st.linkEmitted = false;
  const inner = inlineRenderNow(text, st, isImage ? true : textOnly);
  const emitted = st.linkEmitted;
  st.linkEmitted = prevEmitted; st.inLink = prevInLink;
  if (!isImage) {
    if (emitted) { st.inRawBlock = prevRaw; return undefined; }
    st.linkEmitted = true;
    if (textOnly) return { raw, html: inner };
    const href = cleanUrl(link.href);
    if (href === null) return { raw, html: inner };
    let a = '<a href="' + esc(href) + '"';
    if (link.title) a += ' title="' + esc(link.title) + '"';
    return { raw, html: a + '>' + inner + '</a>' };
  }
  const alt = inner;
  if (textOnly) return { raw, html: alt };
  const href = cleanUrl(link.href);
  if (href === null) return { raw, html: esc(alt) };
  let img = '<img src="' + esc(href) + '" alt="' + esc(alt) + '"';
  if (link.title) img += ' title="' + esc(link.title) + '"';
  return { raw, html: img + '>' };
}

// --- block tokenizers -----------------------------------------------------
function queueInline(src, st) {
  const q = { src, html: '', prefix: '' };
  st.inlineQ.push(q);
  return q;
}
function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}
function tokSpace(src) {
  const m = RE_NEWLINE.exec(src);
  if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
}
function tokCode(src) {
  const m = RE_CODE.exec(src);
  if (m) {
    const raw = stripTrailBlank(m[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(RE_CODE_INDENT, '') };
  }
}
function tokFences(src) {
  const m = RE_FENCES.exec(src);
  if (m) {
    const lang = m[2] ? m[2].trim().replace(ANY_PUNCT, '$1') : m[2];
    return { type: 'code', raw: m[0], lang, text: fenceIndentFix(m[0], m[3] || '') };
  }
}
function tokHeading(src, st) {
  const m = RE_HEADING.exec(src);
  if (m) {
    let text = m[2].trim();
    if (RE_END_HASH.test(text)) {
      const s = rtrim(text, '#');
      if (!s || RE_END_SPACE_TAB.test(s)) text = s.trim();
    }
    return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[1].length, text, inline: queueInline(text, st) };
  }
}
function tokHr(src) {
  const m = RE_HR.exec(src);
  if (m) return { type: 'hr', raw: rtrim(m[0], '\n') };
}
function tokHtml(src) {
  const m = RE_HTML_BLOCK.exec(src);
  if (m) {
    const raw = stripTrailBlank(m[0]);
    return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
  }
}
function tokDef(src) {
  const m = RE_DEF.exec(src);
  if (m) {
    if (!RE_START_ANGLE.test(m[2]) && findClose(m[2], '()') !== -1) return undefined;
    const href = m[2] ? m[2].replace(RE_HREF_BRACKETS, '$1').replace(ANY_PUNCT, '$1') : '';
    const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT, '$1') : m[3];
    return { type: 'def', tag: normLabel(m[1]), raw: rtrim(m[0], '\n'), href, title };
  }
}
function tokTable(src, st) {
  const m = RE_TABLE.exec(src);
  if (!m || !RE_TABLE_DELIM.test(m[2])) return undefined;
  const headerCells = splitCells(m[1]);
  const aligns = m[2].replace(RE_TABLE_ALIGN_TRIM, '').split('|');
  const rowLines = m[3]?.trim() ? m[3].replace(RE_TABLE_ROW_BLANK, '').split('\n') : [];
  if (headerCells.length !== aligns.length) return undefined;
  const tok = { type: 'table', raw: rtrim(m[0], '\n'), header: [], align: [], rows: [] };
  for (const a of aligns) {
    if (RE_TABLE_RIGHT.test(a)) tok.align.push('right');
    else if (RE_TABLE_CENTER.test(a)) tok.align.push('center');
    else if (RE_TABLE_LEFT.test(a)) tok.align.push('left');
    else tok.align.push(null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    tok.header.push({ text: headerCells[i], inline: queueInline(headerCells[i], st), header: true, align: tok.align[i] });
  }
  for (const line of rowLines) {
    tok.rows.push(splitCells(line, tok.header.length).map((cell, p) => ({
      text: cell, inline: queueInline(cell, st), header: false, align: tok.align[p],
    })));
  }
  return tok;
}
function tokLheading(src, st) {
  const m = RE_LHEADING.exec(src);
  if (m) {
    const text = m[1].trim();
    return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, inline: queueInline(text, st) };
  }
}
function tokParagraph(src, st) {
  const m = RE_PARAGRAPH.exec(src);
  if (m) {
    const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return { type: 'paragraph', raw: m[0], text, inline: queueInline(text, st) };
  }
}
function tokText(src, st) {
  const m = RE_TEXT.exec(src);
  if (m) return { type: 'text', raw: m[0], text: m[0], inline: queueInline(m[0], st) };
}
// necessary-condition pre-checks for the two expensive block regexes
function hasSetextUnderline(src) {
  let pos = 0;
  while (true) {
    const nl = src.indexOf('\n', pos);
    if (nl === -1) return false;
    const ls = nl + 1;
    const le = src.indexOf('\n', ls);
    const lineEnd = le === -1 ? src.length : le;
    let i = ls;
    while (i < lineEnd && (src[i] === ' ' || src[i] === '\t')) i++;
    if (i === lineEnd) return false;
    let j = ls, sp = 0;
    while (j < lineEnd && src[j] === ' ' && sp < 4) { j++; sp++; }
    if (sp <= 3 && j < lineEnd && (src[j] === '=' || src[j] === '-')) {
      const c = src[j];
      while (j < lineEnd && src[j] === c) j++;
      while (j < lineEnd && (src[j] === ' ' || src[j] === '\t')) j++;
      if (j === lineEnd) return true;
    }
    pos = ls;
  }
}
function maybeTable(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  let j = nl + 1;
  let hasDash = false;
  while (j < src.length && src[j] !== '\n') {
    const c = src[j];
    if (c === '-' || c === ':' || c === '|' || c === ' ' || c === '\t') { if (c === '-') hasDash = true; }
    else return false;
    j++;
  }
  return hasDash;
}
function endsWithBlankLine(s) {
  let i = s.length - 1;
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t')) i--;
  if (i < 0 || s[i] !== '\n') return false;
  i--;
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t')) i--;
  return i >= 0 && s[i] === '\n';
}
function blockTokens(src, toks, nested, st) {
  for (; src;) {
    let tok;
    if ((tok = tokSpace(src))) {
      src = src.substring(tok.raw.length);
      const prev = toks.at(-1);
      if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n'; else toks.push(tok);
      continue;
    }
    if ((tok = tokCode(src))) {
      src = src.substring(tok.raw.length);
      const prev = toks.at(-1);
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        st.inlineQ.at(-1).src = prev.text;
      } else toks.push(tok);
      continue;
    }
    if ((tok = tokFences(src))) { src = src.substring(tok.raw.length); toks.push(tok); continue; }
    if ((tok = tokHeading(src, st))) { src = src.substring(tok.raw.length); toks.push(tok); continue; }
    if ((tok = tokHr(src))) { src = src.substring(tok.raw.length); toks.push(tok); continue; }
    if ((tok = tokBlockquote(src, st))) { src = src.substring(tok.raw.length); toks.push(tok); continue; }
    if ((tok = tokList(src, st))) { src = src.substring(tok.raw.length); toks.push(tok); continue; }
    if ((tok = tokHtml(src))) { src = src.substring(tok.raw.length); toks.push(tok); continue; }
    if ((tok = tokDef(src))) {
      src = src.substring(tok.raw.length);
      const prev = toks.at(-1);
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.raw;
        st.inlineQ.at(-1).src = prev.text;
      } else {
        if (!st.links.has(tok.tag)) st.links.set(tok.tag, { href: tok.href, title: tok.title });
        toks.push(tok);
      }
      continue;
    }
    if (maybeTable(src) && (tok = tokTable(src, st))) { src = src.substring(tok.raw.length); toks.push(tok); continue; }
    if (hasSetextUnderline(src) && (tok = tokLheading(src, st))) { src = src.substring(tok.raw.length); toks.push(tok); continue; }
    if (st.top && (tok = tokParagraph(src, st))) {
      const prev = toks.at(-1);
      if (nested && prev?.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        st.inlineQ.pop();
        st.inlineQ.at(-1).src = prev.text;
      } else toks.push(tok);
      src = src.substring(tok.raw.length);
      continue;
    }
    if ((tok = tokText(src, st))) {
      src = src.substring(tok.raw.length);
      const prev = toks.at(-1);
      if (prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        st.inlineQ.pop();
        st.inlineQ.at(-1).src = prev.text;
      } else toks.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  st.top = true;
  return toks;
}

// --- blockquote + list ----------------------------------------------------
function cacheByIndent(fn) {
  const cache = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return cache[i] || (cache[i] = fn(i));
  };
}
const nextBulletRe = cacheByIndent((n) => rx(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
const hrRe = cacheByIndent((n) => rx(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const fencesBeginRe = cacheByIndent((n) => rx(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRe = cacheByIndent((n) => rx(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRe = cacheByIndent((n) => rx(HTML_BEGIN_SRC.replace('^ {0,3}', `^ {0,${n}}`), 'i'));
const blockquoteBeginRe = cacheByIndent((n) => rx(`^ {0,${n}}>`));
function tokBlockquote(src, st) {
  const m = RE_BLOCKQUOTE.exec(src);
  if (!m) return undefined;
  let lines = rtrim(m[0], '\n').split('\n');
  let raw = '', text = '';
  const toks = [];
  while (lines.length > 0) {
    let inQuote = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (RE_BQ_START.test(lines[p])) { chunk.push(lines[p]); inQuote = true; }
      else if (!inQuote) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = chunk.join('\n');
    const u = h.replace(RE_BQ_MARKER_WS, (g, b, ws) => b + expandTabs(ws, b.length))
      .replace(RE_BQ_SETEXT, '\n    $1')
      .replace(RE_BQ_SETEXT2, '');
    raw = raw ? raw + '\n' + h : h;
    text = text ? text + '\n' + u : u;
    const savedTop = st.top;
    st.top = true;
    blockTokens(u, toks, true, st);
    st.top = savedTop;
    if (lines.length === 0) break;
    const last = toks.at(-1);
    if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
    if (last?.type === 'blockquote') {
      const g = last;
      const m2 = g.raw + '\n' + lines.join('\n').replace(RE_BQ_SETEXT2, '');
      const f = tokBlockquote(m2, st);
      toks[toks.length - 1] = f;
      const y = m2.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) {
        raw = raw + '\n' + A.join('\n');
        text = text.substring(0, text.length - g.text.length) + f.text;
        lines = lines.slice(A.length);
      }
      if (lines.length > 0 && RE_BQ_START.test(lines[0])) continue;
      break;
    } else if (last?.type === 'list') {
      const g = last;
      const b = g.raw + '\n' + lines.join('\n');
      const mm = tokList(b, st);
      toks[toks.length - 1] = mm;
      const f = mm.raw.length > g.raw.length ? b.slice(g.raw.length + 1, mm.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join('\n');
        raw = raw + '\n' + y;
        text = text + '\n' + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens: toks, text };
}
function tokList(src, st) {
  const first = RE_LIST_ITEM.exec(src);
  if (!first) return undefined;
  let pos = 0;
  const bullet = first[1].trim();
  const ordered = bullet.length > 1;
  const list = { type: 'list', raw: '', ordered, start: ordered ? +bullet.slice(0, -1) : '', loose: false, items: [] };
  const bulletPat = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = rx(`( {0,3}${bulletPat})((?:[\\t ][^\\n]*)?(?:\\n|$))`, 'y');
  let p = false;
  while (pos < src.length) {
    let emptyItem = false, d = '';
    itemRe.lastIndex = pos;
    const t = itemRe.exec(src);
    if (!t || isHrLine(src, pos)) break;
    const k = pos;
    pos += t[0].length;
    const gi = t[2].indexOf('\n');
    const g = gi === -1 ? t[2] : t[2].slice(0, gi);
    const b = t[1].length;
    let m = expandLead(g, b);
    let f = lineAt(src, pos);
    let y = isBlankTrim(m);
    let R = 0;
    if (y) R = b + 1;
    else {
      R = firstNonSpace(m);
      if (R > 4) R = 1;
      d = m.slice(R);
      R += b;
    }
    if (y && isBlankLine(f)) { pos += f.length + 1; emptyItem = true; }
    if (!emptyItem) {
      const parts = [d];
      const n = Math.max(0, Math.min(3, R - 1));
      while (pos < src.length) {
        const nl = src.indexOf('\n', pos);
        const U = nl === -1 ? src.slice(pos) : src.slice(pos, nl);
        f = U;
        const Z = expandLeadTabs(U);
        if (lineBreaksList(U, n, true)) break;
        const fBlank = isBlankTrim(f);
        if (firstNonSpace(Z) >= R || fBlank) parts.push(Z.slice(R));
        else {
          if (y || expandedFirstNonSpace(m) >= 4 || lineBreaksList(m, n, false)) break;
          const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && RE_LHEADING.test(m + '\n' + f)
            ? '    ' + Z.slice(leadSpaces(Z, 3)) : f;
          parts.push(qe);
        }
        y = fBlank;
        pos = nl === -1 ? src.length : nl + 1;
        m = Z.slice(R);
      }
      d = parts.join('\n');
    }
    const A = src.slice(k, pos);
    if (!list.loose) {
      if (p) list.loose = true;
      else if (endsWithBlankLine(A)) p = true;
    }
    list.items.push({ type: 'list_item', raw: A, task: RE_LIST_TASK.test(d), loose: false, text: d, tokens: [] });
  }
  const last = list.items.at(-1);
  if (last) { last.raw = last.raw.trimEnd(); last.text = last.text.trimEnd(); }
  else return undefined;
  list.raw = src.slice(0, pos).trimEnd();
  for (const item of list.items) {
    st.top = false;
    item.tokens = blockTokens(item.text, [], false, st);
    if (!list.loose) {
      for (const g of item.tokens) {
        if (g.type === 'space' && RE_ANY_LINE.test(g.raw)) { list.loose = true; break; }
      }
    }
  }
  for (const item of list.items) {
    const d0 = item.tokens[0];
    if (item.task && (d0?.type === 'text' || d0?.type === 'paragraph')) {
      item.text = item.text.replace(RE_LIST_TASK_REP, '');
      d0.raw = d0.raw.replace(RE_LIST_TASK_REP, '');
      d0.text = d0.text.replace(RE_LIST_TASK_REP, '');
      for (let g = st.inlineQ.length - 1; g >= 0; g--) {
        if (RE_LIST_TASK.test(st.inlineQ[g].src)) {
          st.inlineQ[g].src = st.inlineQ[g].src.replace(RE_LIST_TASK_REP, '');
          break;
        }
      }
      const k = RE_LIST_CHECKBOX.exec(item.raw);
      if (k) {
        const cb = { type: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
        item.checked = cb.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'inline' in item.tokens[0] && item.tokens[0].inline) {
            item.tokens[0].inline.prefix = checkboxHtml(cb.checked);
          } else item.tokens.unshift({ type: 'paragraph', raw: cb.raw, text: cb.raw, inline: { src: '', html: checkboxHtml(cb.checked), prefix: '' } });
        } else item.tokens.unshift(cb);
      }
    } else if (item.task) item.task = false;
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const d of item.tokens) if (d.type === 'text') d.type = 'paragraph';
    }
  }
  return list;
}
function lineAt(src, pos) {
  if (pos >= src.length) return '';
  const nl = src.indexOf('\n', pos);
  return nl === -1 ? src.slice(pos) : src.slice(pos, nl);
}
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 32 && c !== 160 && c !== 0x2028 && c !== 0x2029 && c !== 0xFEFF) return false;
  }
  return true;
}
function isBlankTrim(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 9 && c !== 10 && c !== 11 && c !== 12 && c !== 13 && c !== 32 && c !== 160 &&
      c !== 0x1680 && c !== 0x2028 && c !== 0x2029 && c !== 0x202F && c !== 0x205F &&
      c !== 0x3000 && c !== 0xFEFF && !(c >= 0x2000 && c <= 0x200A)) return false;
  }
  return true;
}
function firstNonSpace(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  return i;
}
function expandedFirstNonSpace(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\t') col += 4;
    else if (c === ' ') col++;
    else break;
  }
  return col;
}
function leadSpaces(s, max) {
  let i = 0;
  while (i < s.length && i < max && s[i] === ' ') i++;
  return i;
}
function expandLeadTabs(s) {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (i === 0) return s;
  let hasTab = false;
  for (let j = 0; j < i; j++) if (s[j] === '\t') { hasTab = true; break; }
  if (!hasTab) return s;
  return expandTabs(s.slice(0, i)) + s.slice(i);
}
function expandLead(s, col) {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (i === 0) return s;
  let hasTab = false;
  for (let j = 0; j < i; j++) if (s[j] === '\t') { hasTab = true; break; }
  if (!hasTab) return s;
  return expandTabs(s.slice(0, i), col) + s.slice(i);
}
// is the line starting at pos an hr line (marked's hr regex, anchored)?
function isHrLine(src, pos) {
  let i = pos, sp = 0;
  while (i < src.length && src[i] === ' ' && sp < 3) { i++; sp++; }
  if (i >= src.length) return false;
  const c = src[i];
  if (c !== '-' && c !== '_' && c !== '*') return false;
  let count = 0;
  while (i < src.length && src[i] !== '\n') {
    const ch = src[i];
    if (ch === c) count++;
    else if (ch !== ' ' && ch !== '\t') return false;
    i++;
  }
  return count >= 3;
}
// manual equivalent of the six break-tests in the list inner loop.
// line: raw line (no \n). n: clamped indent limit. full: include bullet+blockquote tests.
// htmlOnly: only the html test (used for the expanded Z line, which marked tests only for fences/heading/html/bq/bullet/hr on f... see below)
function lineBreaksList(line, n, full, expanded) {
  let s = 0;
  while (s < line.length && line[s] === ' ') s++;
  if (s > n) return false;
  const c = line[s];
  if (c === undefined) return false;
  if (c === '`' || c === '~') {
    return line[s + 1] === c && line[s + 2] === c;
  }
  if (c === '#') {
    let i = s, h = 0;
    while (i < line.length && line[i] === '#' && h < 6) { i++; h++; }
    if (h === 0 || h > 6) return false;
    return i >= line.length || line[i] === ' ' || line[i] === '\t';
  }
  if (c === '<') return htmlBeginRe(n).test(line);
  if (full && c === '>') return true;
  if (c === '*' || c === '+' || c === '-') {
    if (full) {
      const rest = line.slice(s + 1);
      if (rest === '' || rest[0] === ' ' || rest[0] === '\t') return true;
    }
    if (c === '+') return false;
    return isHrChars(line, s, c);
  }
  if (full && c >= '0' && c <= '9') {
    let i = s, d = 0;
    while (i < line.length && line[i] >= '0' && line[i] <= '9' && d < 9) { i++; d++; }
    if (d === 0 || d > 9) return false;
    if (line[i] !== '.' && line[i] !== ')') return false;
    const rest = line.slice(i + 1);
    return rest === '' || rest[0] === ' ' || rest[0] === '\t';
  }
  if (c === '_') return isHrChars(line, s, c);
  return false;
}
function isHrChars(line, s, c) {
  let count = 0;
  for (let i = s; i < line.length; i++) {
    const ch = line[i];
    if (ch === c) count++;
    else if (ch !== ' ' && ch !== '\t') return false;
  }
  return count >= 3;
}

// --- inline tokenizers ----------------------------------------------------
const RE_NON_SPACE_CHAR = /[^ ]/;
const RE_START_END_SPACE = / /;
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;
function tokEscape(e, textOnly) {
  const m = RE_ESCAPE.exec(e);
  if (m) return { raw: m[0], html: textOnly ? m[1] : esc(m[1]) };
}
function tokTag(e, st) {
  const m = RE_TAG.exec(e);
  if (m) {
    if (!st.inLink && RE_START_A.test(m[0])) st.inLink = true;
    else if (st.inLink && RE_END_A.test(m[0])) st.inLink = false;
    if (!st.inRawBlock && RE_START_PRE.test(m[0])) st.inRawBlock = true;
    else if (st.inRawBlock && RE_END_PRE.test(m[0])) st.inRawBlock = false;
    return { raw: m[0], html: m[0] };
  }
}
function tokLink(e, st, textOnly) {
  if (st.linkParenPossible === false) return undefined;
  const m = RE_LINK.exec(e);
  if (!m) return undefined;
  const n = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasTag(e, m[1], n)) return undefined;
  const s = m[2].trim();
  if (RE_START_ANGLE.test(s)) {
    if (!RE_END_ANGLE.test(s)) return undefined;
    const l = rtrim(s.slice(0, -1), '\\');
    if ((s.length - l.length) % 2 === 0) return undefined;
  } else {
    const l = findClose(m[2], '()');
    if (l === -2) return undefined;
    if (l > -1) {
      const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + l;
      m[2] = m[2].substring(0, l);
      m[0] = m[0].substring(0, h).trim();
      m[3] = '';
    }
  }
  const r = rtrim(m[0].slice(0, -1), '\\');
  if ((m[0].length - r.length) % 2 === 0) return undefined;
  let href = m[2], title = '';
  title = m[3] ? m[3].slice(1, -1) : '';
  href = href.trim();
  if (RE_START_ANGLE.test(href)) href = href.slice(1, -1);
  return makeLink(m, { href: href && href.replace(ANY_PUNCT, '$1'), title: title && title.replace(ANY_PUNCT, '$1') }, m[0], st, textOnly);
}
function tokReflink(e, st, textOnly) {
  const m = RE_REFLINK.exec(e) || RE_NOLINK.exec(e);
  if (!m) return undefined;
  const n = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasTag(e, m[1], n)) return undefined;
  const link = st.links.get(normLabel(m[2] || m[1]));
  if (!link) {
    const o = m[0].charAt(0);
    return { raw: o, html: o };
  }
  return makeLink(m, link, m[0], st, textOnly);
}
const PUNCT_WS_ASCII = new Uint8Array(128);
for (const [a, b] of [[9, 13], [32, 32], [33, 47], [58, 64], [91, 96], [123, 126]]) for (let i = a; i <= b; i++) PUNCT_WS_ASCII[i] = 1;
// mirrors RE_PUNCT_ONLY: first code point is whitespace/punct/symbol, not * _
function isPunctWs(s) {
  if (!s) return false;
  const c = s.charCodeAt(0);
  if (c === 42 || c === 95) return false;
  if (c < 128) return PUNCT_WS_ASCII[c] === 1;
  return !!RE_PUNCT_ONLY.exec(s);
}
// true if the single code point (or '') trims to empty
function isWsSingle(s) {
  if (!s) return true;
  const c = s.charCodeAt(0);
  if (c < 128) return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32;
  if (s.length > 1 && c >= 0xD800 && c <= 0xDBFF) return false;
  return c === 160 || c === 0x1680 || c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF || (c >= 0x2000 && c <= 0x200A);
}
function tokEmStrong(e, masked, prevChar, st, ctx, textOnly) {
  let s = RE_EM_L_DELIM.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return undefined;
  const t = masked;
  const r = s[0][0];
  const o = prevChar === r;
  const i = t.length - e.length;
  let l = i;
  while (l > 0 && t[l - 1] === r) l--;
  const p = [...t.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || isPunctWs(p);
  let n = prevChar;
  if (l < i) n = p;
  const u = l < i ? h : isPunctWs(n);
  if (s[4] && n.match(UNICODE_ALNUM)) return undefined;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let g, b, m = k, f = 0;
    const y = i - l + k;
    const R = p !== '' && !isWsSingle(p) && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return undefined;
    const A = r === '*' ? RE_EM_R_AST : RE_EM_R_UND;
    if (!ctx.closers) ctx.closers = scanClosers(t);
    const v = ctx.closers.em[r];
    const Q = t.length - e.length + k;
    if (v < Q) return undefined;
    const tt = t.slice(-e.length + k);
    const ee = v - Q;
    for (A.lastIndex = 0; (s = A.exec(tt)) !== null && !(s.index > ee);) {
      g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      b = [...g].length;
      if (s[3] || s[4]) { m += b; continue; }
      else if (s[5] || s[6] || R) {
        if (o && (s[5] || s[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...s[0]][0].length;
      const M = e.slice(0, k + s.index + te + b);
      if (Math.min(k, b) % 2) {
        const U = M.slice(1, -1);
        const inner = inlineRenderNow(U, st, textOnly);
        return { raw: M, html: textOnly ? inner : '<em>' + inner + '</em>' };
      }
      const ne = M.slice(2, -2);
      const inner = inlineRenderNow(ne, st, textOnly);
      return { raw: M, html: textOnly ? inner : '<strong>' + inner + '</strong>' };
    }
  }
  return undefined;
}
function tokCodespan(e, textOnly) {
  const m = RE_CODE_SPAN.exec(e);
  if (m) {
    let n = m[2].replace(RE_NEWLINE_G, ' ');
    const s = RE_NON_SPACE_CHAR.test(n);
    const r = RE_START_SPACE.test(n) && RE_END_SPACE.test(n);
    if (s && r) n = n.substring(1, n.length - 1);
    return { raw: m[0], html: textOnly ? n : '<code>' + esc(n, true) + '</code>' };
  }
}
function tokBr(e, textOnly) {
  const m = RE_BR.exec(e);
  if (m) return { raw: m[0], html: textOnly ? '' : '<br>' };
}
function tokDel(e, masked, prevChar, st, ctx, textOnly) {
  const t = masked;
  let s = RE_DEL_L_DELIM.exec(e);
  if (!s) return undefined;
  if (!(s[1] || '') || !prevChar || isPunctWs(prevChar)) {
    const o = [...s[0]].length - 1;
    let i, l, p = o;
    const h = RE_DEL_R;
    if (!ctx.closers) ctx.closers = scanClosers(t);
    const u = ctx.closers.del;
    const d = t.length - e.length + o;
    if (u < d) return undefined;
    const tt = t.slice(-e.length + o);
    const k = u - d;
    for (h.lastIndex = 0; (s = h.exec(tt)) !== null && !(s.index > k);) {
      i = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!i) continue;
      l = [...i].length;
      if (l !== o) continue;
      if (s[3] || s[4]) { p += l; continue; }
      p -= l;
      if (p > 0) continue;
      l = Math.min(l, l + p);
      const g = [...s[0]][0].length;
      const b = e.slice(0, o + s.index + g + l);
      const m = b.slice(o, -o);
      const inner = inlineRenderNow(m, st, textOnly);
      return { raw: b, html: textOnly ? inner : '<del>' + inner + '</del>' };
    }
  }
  return undefined;
}
function tokAutolink(e, textOnly) {
  const m = RE_AUTOLINK.exec(e);
  if (m) {
    let n, s;
    if (m[2] === '@') { n = m[1]; s = 'mailto:' + n; }
    else { n = m[1]; s = n; }
    if (textOnly) return { raw: m[0], html: n };
    const href = cleanUrl(s);
    if (href === null) return { raw: m[0], html: esc(n, true) };
    return { raw: m[0], html: '<a href="' + esc(href, true) + '">' + esc(n, true) + '</a>' };
  }
}
function tokUrl(e, textOnly) {
  const m = RE_URL.exec(e);
  if (m) {
    let n, s;
    if (m[2] === '@') { n = m[0]; s = 'mailto:' + n; }
    else {
      let r;
      do { r = m[0]; m[0] = RE_BACKPEDAL.exec(m[0])?.[0] ?? ''; } while (r !== m[0]);
      n = m[0];
      s = m[1] === 'www.' ? 'http://' + m[0] : m[0];
    }
    if (textOnly) return { raw: m[0], html: n };
    const href = cleanUrl(s);
    if (href === null) return { raw: m[0], html: esc(n, true) };
    return { raw: m[0], html: '<a href="' + esc(href, true) + '">' + esc(n, true) + '</a>' };
  }
}
const RE_TEXT_FAST = /^(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*~_])|[^ ](?= {2,}\n)|$))/;
const EMAIL_CHAR = new Uint8Array(128);
for (const ch of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?_`{|}~-") EMAIL_CHAR[ch.charCodeAt(0)] = 1;
function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isProtocolStart(e, i) {
  const c0 = e.charCodeAt(i);
  if (c0 === 104 || c0 === 72) { // h
    const c1 = e.charCodeAt(i + 1), c2 = e.charCodeAt(i + 2), c3 = e.charCodeAt(i + 3);
    if ((c1 === 116 || c1 === 84) && (c2 === 116 || c2 === 84) && (c3 === 112 || c3 === 80)) {
      let j = i + 4;
      if (e.charCodeAt(j) === 115 || e.charCodeAt(j) === 83) j++;
      return e.charCodeAt(j) === 58 && e.charCodeAt(j + 1) === 47 && e.charCodeAt(j + 2) === 47;
    }
    return false;
  }
  if (c0 === 102 || c0 === 70) { // f
    const c1 = e.charCodeAt(i + 1), c2 = e.charCodeAt(i + 2);
    if ((c1 === 116 || c1 === 84) && (c2 === 112 || c2 === 80)) {
      return e.charCodeAt(i + 3) === 58 && e.charCodeAt(i + 4) === 47 && e.charCodeAt(i + 5) === 47;
    }
  }
  return false;
}
function isWwwStart(e, i) {
  if (e.charCodeAt(i) !== 119) return false; // w
  if (e.charCodeAt(i + 1) !== 119 || e.charCodeAt(i + 2) !== 119 || e.charCodeAt(i + 3) !== 46) return false;
  if (i === 0) return true;
  const p = e.charCodeAt(i - 1);
  return p === 32 || p === 9 || p === 10 || p === 13 || p === 11 || p === 12 || p === 42 || p === 95 || p === 126 || p === 40 ||
    p === 160 || p === 0x1680 || p === 0x2028 || p === 0x2029 || p === 0x202F || p === 0x205F || p === 0x3000 || p === 0xFEFF ||
    (p >= 0x2000 && p <= 0x200A);
}
// earliest position < len where the full text regex would stop on an
// email/www/protocol/mailto trigger (Infinity if none). m0 is e.slice(0, len).
const TRIG_RE = /@|www\.|:\/\/|mailto:|xmpp:/g;
function firstTrigger(e, len, m0) {
  const c0 = e.charCodeAt(0);
  let i0 = 1;
  if (c0 === 96) { while (e.charCodeAt(i0) === 96) i0++; }
  else if (c0 === 126) { while (e.charCodeAt(i0) === 126) i0++; }
  let emailOk = false;
  TRIG_RE.lastIndex = 0;
  let m;
  while ((m = TRIG_RE.exec(m0)) !== null) {
    const idx = m.index;
    const k = m[0];
    if (k === '@') {
      let rs = idx - 1;
      while (rs >= 0) {
        const c = m0.charCodeAt(rs);
        if (c >= 128 || !EMAIL_CHAR[c]) break;
        rs--;
      }
      rs++;
      if (rs >= idx || i0 >= idx) continue;
      return rs < i0 ? i0 : rs;
    }
    if (k === 'www.') {
      if (idx >= 1 && isWwwStart(m0, idx)) return idx;
      continue;
    }
    if (k === '://') {
      let t = -1;
      if (idx - 5 >= 1 && isProtocolStart(m0, idx - 5)) t = idx - 5;
      else if (idx - 4 >= 1 && isProtocolStart(m0, idx - 4)) t = idx - 4;
      else if (idx - 3 >= 1 && isProtocolStart(m0, idx - 3)) t = idx - 3;
      if (t !== -1) return t;
      continue;
    }
    // mailto: / xmpp:
    if (idx >= 1 && !isAlnumCode(m0.charCodeAt(idx - 1))) return idx;
  }
  // no valid trigger inside m0; an email run may still span a * / ` / ~
  // hard stop at len, with its @ past len
  if (len < e.length) {
    const lc = e.charCodeAt(len);
    if (lc === 42 || lc === 96 || lc === 126) {
      let at = -1;
      while ((at = e.indexOf('@', at + 1)) !== -1) {
        let rs = at - 1;
        while (rs >= 0) {
          const c = e.charCodeAt(rs);
          if (c >= 128 || !EMAIL_CHAR[c]) break;
          rs--;
        }
        rs++;
        if (rs >= at) continue;
        if (i0 >= at) continue;
        const t = rs < i0 ? i0 : rs;
        if (t < len) return t;
        break;
      }
    }
  }
  return Infinity;
}

function tokInlineText(e, st, textOnly) {
  const m = RE_TEXT_FAST.exec(e);
  if (m) {
    let len = m[0].length;
    const T = firstTrigger(e, len, m[0]);
    if (T < len) len = T;
    const m0 = e.slice(0, len);
    const inRaw = st.inRawBlock;
    const t = inRaw ? m0 : unesc(m0);
    return { raw: m0, html: textOnly ? t : (inRaw ? m0 : esc(t)) };
  }
}

// --- inline driver + rendering --------------------------------------------
function isUrlStart(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 43 || c === 45;
}
function inlineRender(e, st, textOnly) {
  const hasDelim = e.includes('*') || e.includes('_') || e.includes('~');
  const masked = hasDelim && (e.includes('[') || e.includes('`') || e.includes('<') || e.includes('\\'))
    ? maskSrc(e, st.links, st) : e;
  const ctx = { closers: null };
  let out = '';
  let isText = false, prevChar = '', guard = Infinity;
  while (e) {
    if (e.length < guard) guard = e.length;
    else throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
    if (!isText) prevChar = '';
    isText = false;
    let tok;
    const c = e.charCodeAt(0);
    let done = false;
    if (c === 92) { // backslash: escape, then br
      if ((tok = tokEscape(e, textOnly)) || (tok = tokBr(e, textOnly))) { e = e.substring(tok.raw.length); out += tok.html; done = true; }
    } else if (c === 60) { // <: tag, then autolink
      if ((tok = tokTag(e, st)) || (tok = tokAutolink(e, textOnly))) { e = e.substring(tok.raw.length); out += tok.html; done = true; }
    } else if (c === 91 || c === 33) { // [ or !: link, then reflink
      if ((tok = tokLink(e, st, textOnly))) { e = e.substring(tok.raw.length); out += tok.html; done = true; }
      else if ((tok = tokReflink(e, st, textOnly))) { e = e.substring(tok.raw.length); out += tok.html; done = true; }
    } else if (c === 42 || c === 95) { // * or _: emphasis (and url for _)
      if ((tok = tokEmStrong(e, masked, prevChar, st, ctx, textOnly))) { e = e.substring(tok.raw.length); out += tok.html; done = true; }
      else if (c === 95 && !st.inLink && (tok = tokUrl(e, textOnly))) { e = e.substring(tok.raw.length); out += tok.html; done = true; }
    } else if (c === 96) { // backtick: code span
      if ((tok = tokCodespan(e, textOnly))) { e = e.substring(tok.raw.length); out += tok.html; done = true; }
    } else if (c === 32) { // space: br
      if ((tok = tokBr(e, textOnly))) { e = e.substring(tok.raw.length); out += tok.html; done = true; }
    } else if (c === 126) { // ~: strikethrough
      if ((tok = tokDel(e, masked, prevChar, st, ctx, textOnly))) { e = e.substring(tok.raw.length); out += tok.html; done = true; }
    } else if (!st.inLink && isUrlStart(c)) { // extended autolink
      if ((tok = tokUrl(e, textOnly))) { e = e.substring(tok.raw.length); out += tok.html; done = true; }
    }
    if (!done) {
      if ((tok = tokInlineText(e, st, textOnly))) {
        e = e.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        isText = true;
        out += tok.html;
        continue;
      }
      throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
    }
  }
  return out;
}
function inlineRenderNow(src, st, textOnly) {
  const saved = st.linkParenPossible;
  st.linkParenPossible = saved && src.includes(')');
  try {
    return inlineRender(src, st, textOnly);
  } finally {
    st.linkParenPossible = saved;
  }
}
function renderBlocks(toks) {
  let out = '';
  for (const tok of toks) {
    switch (tok.type) {
      case 'space': case 'def': break;
      case 'checkbox': out += '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += '<h' + tok.depth + '>' + tok.inline.html + '</h' + tok.depth + '>\n'; break;
      case 'code': {
        const lang = (tok.lang || '').match(/^\S*/)?.[0];
        const text = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        out += lang
          ? '<pre><code class="language-' + esc(lang) + '">' + esc(text, true) + '</code></pre>\n'
          : '<pre><code>' + esc(text, true) + '</code></pre>\n';
        break;
      }
      case 'table': {
        let head = '';
        for (const c of tok.header) head += renderCell(c);
        let body = '';
        for (const row of tok.rows) {
          let cells = '';
          for (const c of row) cells += renderCell(c);
          body += '<tr>\n' + cells + '</tr>\n';
        }
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' +
          (body ? '<tbody>' + body + '</tbody>' : '') + '</table>\n';
        break;
      }
      case 'blockquote': out += '<blockquote>\n' + renderBlocks(tok.tokens) + '</blockquote>\n'; break;
      case 'list': {
        let items = '';
        for (const item of tok.items) items += '<li>' + renderBlocks(item.tokens) + '</li>\n';
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        out += '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
        break;
      }
      case 'html': out += tok.text; break;
      case 'paragraph': out += '<p>' + tok.inline.html + '</p>\n'; break;
      case 'text': out += tok.inline.html; break;
      default: break;
    }
  }
  return out;
}
function renderCell(c) {
  const tag = c.header ? 'th' : 'td';
  return (c.align ? '<' + tag + ' align="' + c.align + '">' : '<' + tag + '>') +
    c.inline.html + '</' + tag + '>\n';
}

export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const st = {
    links: new Map(), inLink: false, inRawBlock: false, linkEmitted: false,
    linkParenPossible: true, top: true, inlineQ: [],
  };
  const toks = blockTokens(src, [], false, st);
  for (const q of st.inlineQ) {
    st.inRawBlock = false;
    q.html = (q.prefix || '') + inlineRender(q.src, st, false);
  }
  return renderBlocks(toks);
}
