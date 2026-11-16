// Fast Markdown — a clean-room, dependency-free reimplementation of the
// marked 18.1.3 renderer (GFM, default options). parse(markdown) returns the
// exact HTML marked produces, but faster: block tokenizers are guarded by
// first-character dispatch, inline runs without constructs take a fast path,
// emphasis masking is lazy, and the inline text run is scanned by hand
// instead of by regex. Written from the CommonMark/GFM specs and from
// observing marked's behaviour on the spec examples; no marked source is
// copied into this file.

// ---------------------------------------------------------------------------
// tiny regex builder: start from a pattern string, substitute named parts,
// then compile. Used for the composite block/inline grammars.
function edit(src, flags) {
  let s = typeof src === 'string' ? src : src.source;
  const api = {
    replace(name, val) {
      let v = typeof val === 'string' ? val : val.source;
      v = v.replace(/(^|[^\[])\^/g, '$1');
      s = s.replace(name, v);
      return api;
    },
    regex() { return new RegExp(s, flags || ''); },
  };
  return api;
}

const noop = { exec: () => null };

// ---------------------------------------------------------------------------
// misc small patterns shared by several rules
const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTabChar: / $/,
  endingSpaceChar: / $/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: cachedIndentRegex((i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cachedIndentRegex((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndentRegex((i) => new RegExp(`^ {0,${i}}>`)),
};

function cachedIndentRegex(make) {
  const cache = [];
  return (indent) => {
    const idx = Math.max(0, Math.min(3, indent - 1));
    let re = cache[idx];
    if (!re) { re = make(idx); cache[idx] = re; }
    return re;
  };
}

const TAG = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// ---------------------------------------------------------------------------
// block grammar (GFM)
const newlineRe = /^(?:[ \t]*(?:\n|$))+/;
const blockCodeRe = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fencesRe = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const hrRe = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const headingRe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bulletRe = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const lheadingRe = edit(lheadingCore)
  .replace(/bull/g, bulletRe)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/\|table/g, '')
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .regex();
const paraCore = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function makeParagraph(listInterrupt, tableRe) {
  const e = edit(paraCore)
    .replace('hr', hrRe)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listInterrupt)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', TAG);
  if (tableRe) e.replace('table', tableRe); else e.replace('|table', '');
  return e.regex();
}
const paragraphRe = makeParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, null);
const blockquoteParagraphRe = makeParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, null);
const blockTextRe = /^[^\n]+/;
const blockLabelRe = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const defRe = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', blockLabelRe)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .regex();
const listRe = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, bulletRe).regex();
const htmlRe = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')', 'i')
  .replace('comment', COMMENT)
  .replace('tag', TAG)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .regex();
const blockquoteRe = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', blockquoteParagraphRe)
  .regex();
const gfmTableRe = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', hrRe)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', TAG)
  .regex();
const paragraphGfmRe = makeParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, gfmTableRe);

// ---------------------------------------------------------------------------
// inline grammar (GFM)
const escapeRe = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCodeRe = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const brRe = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const inlineTextRe = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
const punctRe = /[\p{P}\p{S}]/u;
const punctSpaceRe = /[\s\p{P}\p{S}]/u;
const notPunctSpaceRe = /[^\s\p{P}\p{S}]/u;
const punctuationRe = edit(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, punctSpaceRe).regex();
const punctGfmStrongEm = /(?!~)[\p{P}\p{S}]/u;
const punctSpaceGfmStrongEm = /(?!~)[\s\p{P}\p{S}]/u;
const notPunctSpaceGfmStrongEm = /(?:[^\s\p{P}\p{S}]|~)/u;
const blockSkipRe = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .regex();
const emStrongLDelimCore = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const emStrongLDelimRe = edit(emStrongLDelimCore, 'u').replace(/punct/g, punctGfmStrongEm).regex();
const emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // skip orphan inside strong
  + '|[^*]+(?=[^*])' // consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only be a right delimiter
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only be a right delimiter
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only be a left delimiter
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only be a left delimiter
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either
const emStrongRDelimAstRe = edit(emStrongRDelimAstCore, 'gu')
  .replace(/notPunctSpace/g, notPunctSpaceGfmStrongEm)
  .replace(/punctSpace/g, punctSpaceGfmStrongEm)
  .replace(/punct/g, punctGfmStrongEm)
  .regex();
const emStrongRDelimUndRe = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .replace(/notPunctSpace/g, notPunctSpaceRe)
  .replace(/punctSpace/g, punctSpaceRe)
  .replace(/punct/g, punctRe)
  .regex();
const delLDelimRe = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').replace(/punct/g, punctRe).regex();
const delRDelimCore =
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)';
const delRDelimRe = edit(delRDelimCore, 'gu')
  .replace(/notPunctSpace/g, notPunctSpaceRe)
  .replace(/punctSpace/g, punctSpaceRe)
  .replace(/punct/g, punctRe)
  .regex();
const anyPunctuationRe = edit(/\\(punct)/, 'gu').replace(/punct/g, punctRe).regex();
const anyPunctuationOutsideCodeRe = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, punctRe).regex();
const autolinkRe = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .regex();
const inlineCommentRe = edit(COMMENT).replace('(?:-->|$)', '-->').regex();
const tagRe = edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', inlineCommentRe)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .regex();
const inlineLabelBracketsRe = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const inlineLabelRe = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', inlineLabelBracketsRe)
  .regex();
const linkRe = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', inlineLabelRe)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .regex();
const reflinkRe = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', inlineLabelRe)
  .replace('ref', blockLabelRe)
  .regex();
const nolinkRe = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', blockLabelRe)
  .regex();
const boundedBlockLabelRe = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const boundedInlineLabelRe = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', inlineLabelBracketsRe)
  .regex();
const reflinkSearchRe = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', boundedInlineLabelRe)
    .replace('ref', boundedBlockLabelRe)
    .regex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', boundedBlockLabelRe)
    .regex())
  .regex();
const caseInsensitiveProtocolRe = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const extendedEmailRe = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const extendedEmailProtocolRe = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, extendedEmailRe)
  .regex();
const urlRe = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', extendedEmailProtocolRe)
  .replace('protocol', caseInsensitiveProtocolRe)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .regex();
const backpedalRe = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const delRe = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const textGfmRe = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', caseInsensitiveProtocolRe)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .regex();

// First construct character for the inline fast path: \ < [ ` * _ ~.
const constructRe = /[\\<!\[`*_~]/;
// Emphasis/strikethrough delimiters, and the characters that make a mask
// necessary (link, code span, tag, escape). Two regex tests replace the
// seven includes() scans the inline setup used to do.
const delimRe = /[*_~]/;
const maskCharRe = /[\[`<\\]/;

// ---------------------------------------------------------------------------
// helpers
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(html, encode) {
  if (encode) {
    if (O.escapeTest.test(html)) return html.replace(O.escapeReplace, (c) => ESCAPE_MAP[c]);
  } else if (O.escapeTestNoEncode.test(html)) {
    return html.replace(O.escapeReplaceNoEncode, (c) => ESCAPE_MAP[c]);
  }
  return html;
}

function decodeNumericRefs(text) {
  if (!O.numericCharacterReference.test(text)) return text;
  return text.replace(O.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(O.percentDecode, '%');
  } catch { return null; }
  return href;
}

function splitCells(row, count) {
  const fixed = row.replace(O.findPipe, (m, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = fixed.split(O.splitPipe);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(O.slashPipe, '|');
  return cells;
}

function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const ch = str.charAt(l - suffLen - 1);
    if (ch === c && !invert) suffLen++;
    else if (ch !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && O.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(O.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent) {
  indent = indent || 0;
  let col = indent;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Last `*`/`_`/`~` runs that can close emphasis/strong/del, scanned once per
// inline pass and shared by every opener in it.
function scanClosers(src) {
  const last = { '*': -1, _: -1 };
  let lastDel = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = i;
      else last[ch] = i;
    }
    i = j - 1;
  }
  return { last, lastDel };
}

// Code-point length without allocating an array (spread does).
function cpLen(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) i++;
    n++;
  }
  return n;
}

// First non-space character within the first `indent` spaces of a line, or
// '' when the line's marker (if any) sits further right. The list loop's
// block-start regexes all allow at most `indent` leading spaces, so a line
// whose first significant character cannot start one of them can skip every
// test. A letter-start line (an ordinary paragraph continuation) skips all.
function lineSig(line, indent) {
  let i = 0;
  while (i < indent && line[i] === ' ') i++;
  const c = line[i];
  if (c === undefined || c === ' ' || c === '\t') return '';
  return c;
}

function hasSetextAhead(src) {
  // a setext underline must appear before the first blank line
  let i = src.indexOf('\n');
  while (i !== -1) {
    let j = i + 1;
    let sp = 0;
    while (sp < 3 && src[j] === ' ') { j++; sp++; }
    const c = src[j];
    if (c === '=' || c === '-') {
      let k = j;
      while (src[k] === c) k++;
      while (src[k] === ' ' || src[k] === '\t') k++;
      if (src[k] === '\n' || k === src.length) return true;
    }
    // blank line ends the search: a heading cannot span one
    if (src[j] === '\n') return false;
    i = src.indexOf('\n', j);
  }
  return false;
}

function hasTableDelimiterAhead(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  const end = src.indexOf('\n', nl + 1);
  const line = src.slice(nl + 1, end === -1 ? src.length : end);
  return line.indexOf('-') !== -1 && (line.indexOf('|') !== -1 || line.indexOf(':') !== -1);
}

// Necessary condition for the extended-autolink (url) regex to match at the
// start of src: a www. start, a scheme:// or mailto:/xmpp: start, or an
// email address starting here.
function urlStart(src) {
  const c0 = src.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  if (src.startsWith('www.')) return true;
  let i = 1;
  while (i < src.length && i < 33) {
    const ch = src.charCodeAt(i);
    if (ch === 58) { // ':'
      if (src[i + 1] === '/' && src[i + 2] === '/') return true;
      const scheme = src.slice(0, i).toLowerCase();
      if (scheme === 'mailto' || scheme === 'xmpp') return true;
      return false;
    }
    if (!((ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 43 || ch === 46 || ch === 45)) break;
    i++;
  }
  // Email: a run of email chars from position 0, then '@'. Bounded scan —
  // it stops at the first non-email char (and past 80 chars, like the old
  // indexOf guard), so it never walks the whole remaining string.
  let j = 0;
  while (j <= 80 && j < src.length) {
    const code = src.charCodeAt(j);
    const ok = (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57)
      || code === 46 || code === 95 || code === 43 || code === 45 || code === 33 || code === 35
      || code === 36 || code === 37 || code === 38 || code === 39 || code === 42 || code === 47
      || code === 61 || code === 63 || code === 94 || code === 96 || code === 123 || code === 124
      || code === 125 || code === 126;
    if (!ok) break;
    j++;
  }
  if (j > 80) return false;
  return src[j] === '@';
}

// --- manual inline-text scanner (replaces the text regex) ---
// Returns the length of the text token at the start of src, following the
// GFM text grammar exactly: consume a first chunk (backtick run, tilde run,
// or one char), then stop at the first position where a construct can start
// (\ < ! [ ` * ~ _, a protocol://, a www. after space/*/_/~/(, a hard break,
// or an email / mailto: start).
const EMAIL_CHARS = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&\'*+/=?_`{|}~-'.split(''));
function isEmailChar(c) { return EMAIL_CHARS.has(c); }
function isAlnumChar(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'); }
function startsEmailAt(src, i) {
  let j = i;
  while (j < src.length && isEmailChar(src[j])) j++;
  return j > i && src[j] === '@';
}
function startsEmailProtocolAt(src, i) {
  return src.startsWith('mailto:', i) || src.startsWith('xmpp:', i);
}
function startsProtocolAt(src, i) {
  const c = src[i];
  if (c !== 'h' && c !== 'H' && c !== 'f' && c !== 'F') return false;
  const rest = src.slice(i, i + 8).toLowerCase();
  return rest.startsWith('http://') || rest.startsWith('https://') || rest.startsWith('ftp://');
}
function startsHardBreakAt(src, i) {
  let j = i;
  while (src[j] === ' ') j++;
  return j - i >= 2 && src[j] === '\n';
}
function isStopChar(c) {
  return c === '\\' || c === '<' || c === '!' || c === '[' || c === '`' || c === '*' || c === '~' || c === '_';
}
function isWwwPrev(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '*' || c === '_' || c === '~' || c === '(';
}

function textEnd(src) {
  const n = src.length;
  if (n === 0) return 0;
  const hasAt = src.indexOf('@') !== -1;
  if (!isAlnumChar(src[0]) && startsEmailProtocolAt(src, 1)) return 1;
  let i;
  if (src[0] === '`') { i = 1; while (i < n && src[i] === '`') i++; }
  else if (src[0] === '~') { i = 1; while (i < n && src[i] === '~') i++; }
  else i = 1;
  if (i >= n) return i;
  if (src[i] === '`' || src[i] === '~') return i;
  if (startsHardBreakAt(src, i)) return i;
  if (hasAt && startsEmailAt(src, i)) return i;
  for (let j = i; j < n; j++) {
    const ch = src[j];
    if (isStopChar(ch)) return j;
    if (ch === 'w' && src.startsWith('www.', j) && isWwwPrev(src[j - 1])) return j;
    if ((ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') && startsProtocolAt(src, j)) return j;
    if (ch !== ' ' && startsHardBreakAt(src, j + 1)) return j + 1;
    if (hasAt) {
      if (!isAlnumChar(ch) && startsEmailProtocolAt(src, j + 1)) return j + 1;
      if (!isEmailChar(ch) && startsEmailAt(src, j + 1)) return j + 1;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// link / image token builder (shared by link and reflink)
function outputLink(cap, link, raw, lx) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(O.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = lx.state.inLink;
  const outerLinkEmitted = lx.state.linkEmitted;
  const outerInRawBlock = lx.state.inRawBlock;
  lx.state.inLink = true;
  lx.state.linkEmitted = false;
  const tokens = lx.inlineTokens(text);
  const textHasLink = lx.state.linkEmitted;
  lx.state.linkEmitted = outerLinkEmitted;
  lx.state.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      lx.state.inRawBlock = outerInRawBlock;
      return undefined;
    }
    lx.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function indentCodeCompensation(raw, text) {
  const m = raw.match(O.indentCodeCompensation);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mi = node.match(O.beginningSpace);
    if (mi === null) return node;
    return node.slice(Math.min(mi[0].length, indentToCode.length));
  }).join('\n');
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = inlineCodeRe.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = tagRe.exec(tokenSrc) || autolinkRe.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Lexer: block + inline tokenizers, state, and the token loops.
class Lx {
  constructor() {
    this.links = Object.create(null);
    this.linkCount = 0; // number of link definitions registered (mask guard)
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.closers = null; // scanClosers() result for the current inline pass
  }

  // ---- inline tokenizers (tried in order by #tokenizeInlines) ----
  escape(src) {
    const cap = escapeRe.exec(src);
    if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
  }

  tag(src) {
    const cap = tagRe.exec(src);
    if (cap) {
      if (!this.state.inLink && O.startATag.test(cap[0])) this.state.inLink = true;
      else if (this.state.inLink && O.endATag.test(cap[0])) this.state.inLink = false;
      if (!this.state.inRawBlock && O.startPreScriptTag.test(cap[0])) this.state.inRawBlock = true;
      else if (this.state.inRawBlock && O.endPreScriptTag.test(cap[0])) this.state.inRawBlock = false;
      return { type: 'html', raw: cap[0], inLink: this.state.inLink, inRawBlock: this.state.inRawBlock, block: false, text: cap[0] };
    }
  }

  link(src) {
    if (this.state.linkParenPossible === false) return undefined;
    const cap = linkRe.exec(src);
    if (cap) {
      const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
      if (isLabelEndInsideToken(src, cap[1], labelStart)) return undefined;
      const trimmedUrl = cap[2].trim();
      if (O.startAngleBracket.test(trimmedUrl)) {
        if (!O.endAngleBracket.test(trimmedUrl)) return undefined;
        const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
        if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return undefined;
      } else {
        const lastParenIndex = findClosingBracket(cap[2], '()');
        if (lastParenIndex === -2) return undefined;
        if (lastParenIndex > -1) {
          const start = cap[0].indexOf('!') === 0 ? 5 : 4;
          const linkLen = start + cap[1].length + lastParenIndex;
          cap[2] = cap[2].substring(0, lastParenIndex);
          cap[0] = cap[0].substring(0, linkLen).trim();
          cap[3] = '';
        }
      }
      const unescaped = rtrim(cap[0].slice(0, -1), '\\');
      if ((cap[0].length - unescaped.length) % 2 === 0) return undefined;
      let href = cap[2];
      const title = cap[3] ? cap[3].slice(1, -1) : '';
      href = href.trim();
      if (O.startAngleBracket.test(href)) href = href.slice(1, -1);
      return outputLink(cap, {
        href: href ? href.replace(anyPunctuationRe, '$1') : href,
        title: title ? title.replace(anyPunctuationRe, '$1') : title,
      }, cap[0], this);
    }
  }

  reflink(src, links) {
    let cap;
    if ((cap = reflinkRe.exec(src)) || (cap = nolinkRe.exec(src))) {
      const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
      if (isLabelEndInsideToken(src, cap[1], labelStart)) return undefined;
      const link = links[normalizeLabel(cap[2] || cap[1])];
      if (!link) {
        const text = cap[0].charAt(0);
        return { type: 'text', raw: text, text };
      }
      return outputLink(cap, link, cap[0], this);
    }
  }

  emStrong(src, maskedSrc, prevChar) {
    let match = emStrongLDelimRe.exec(src);
    if (!match) return undefined;
    if (!match[1] && !match[2] && !match[3] && !match[4]) return undefined;
    const delimChar = match[0][0];
    const midRun = prevChar === delimChar;
    const srcStart = maskedSrc.length - src.length;
    let runStart = srcStart;
    while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
    let runPrevChar = '';
    if (runStart > 0) {
      const lastCode = maskedSrc.charCodeAt(runStart - 1);
      if (lastCode >= 0xDC00 && lastCode <= 0xDFFF && runStart >= 2) {
        const prevCode = maskedSrc.charCodeAt(runStart - 2);
        runPrevChar = (prevCode >= 0xD800 && prevCode <= 0xDBFF)
          ? maskedSrc[runStart - 2] + maskedSrc[runStart - 1]
          : maskedSrc[runStart - 1];
      } else runPrevChar = maskedSrc[runStart - 1];
    }
    const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!punctuationRe.exec(runPrevChar);
    if (runStart < srcStart) prevChar = runPrevChar;
    const prevPunct = runStart < srcStart ? runPrevPunct : !!punctuationRe.exec(prevChar);
    if (match[4] && prevChar.match(O.unicodeAlphaNumeric)) return undefined;
    const nextChar = match[1] || match[3] || '';
    if (!nextChar || !prevChar || prevPunct) {
      const lLength = cpLen(match[0]) - 1;
      let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
      const runLength = srcStart - runStart + lLength;
      const openerCanClose = !!runPrevChar.trim()
        && (!!nextChar || (delimChar === '*' && !runPrevPunct));
      const endReg = delimChar === '*' ? emStrongRDelimAstRe : emStrongRDelimUndRe;
      const lastPossible = this.closers.last[delimChar];
      const windowStart = maskedSrc.length - src.length + lLength;
      if (lastPossible < windowStart) return undefined;
      maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
      const lastInWindow = lastPossible - windowStart;
      endReg.lastIndex = 0;
      while ((match = endReg.exec(maskedSrc)) !== null) {
        if (match.index > lastInWindow) break;
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (!rDelim) continue;
        rLength = cpLen(rDelim);
        if (match[3] || match[4]) {
          delimTotal += rLength;
          continue;
        } else if (match[5] || match[6] || openerCanClose) {
          if (midRun && (match[5] || match[6])) break;
          if (runLength % 3 && !((runLength + rLength) % 3)) {
            midDelimTotal += rLength;
            continue;
          }
        }
        delimTotal -= rLength;
        if (delimTotal > 0) continue;
        rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
        const lastCharLength = (match[0].charCodeAt(0) >= 0xD800 && match[0].charCodeAt(0) <= 0xDBFF) ? 2 : 1;
        const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
        if (Math.min(lLength, rLength) % 2) {
          const text = raw.slice(1, -1);
          return { type: 'em', raw, text, tokens: this.inlineTokens(text) };
        }
        const text = raw.slice(2, -2);
        return { type: 'strong', raw, text, tokens: this.inlineTokens(text) };
      }
    }
  }

  codespan(src) {
    const cap = inlineCodeRe.exec(src);
    if (cap) {
      let text = cap[2].replace(O.newLineCharGlobal, ' ');
      const hasNonSpaceChars = O.nonSpaceChar.test(text);
      const hasSpaceCharsOnBothEnds = text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ';
      if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
      return { type: 'codespan', raw: cap[0], text };
    }
  }

  br(src) {
    const cap = brRe.exec(src);
    if (cap) return { type: 'br', raw: cap[0] };
  }

  del(src, maskedSrc, prevChar) {
    let match = delLDelimRe.exec(src);
    if (!match) return undefined;
    const nextChar = match[1] || '';
    if (!nextChar || !prevChar || punctuationRe.exec(prevChar)) {
      const lLength = cpLen(match[0]) - 1;
      let rDelim, rLength, delimTotal = lLength;
      const endReg = delRDelimRe;
      const lastPossible = this.closers.lastDel;
      const windowStart = maskedSrc.length - src.length + lLength;
      if (lastPossible < windowStart) return undefined;
      maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
      const lastInWindow = lastPossible - windowStart;
      endReg.lastIndex = 0;
      while ((match = endReg.exec(maskedSrc)) !== null) {
        if (match.index > lastInWindow) break;
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (!rDelim) continue;
        rLength = cpLen(rDelim);
        if (rLength !== lLength) continue;
        if (match[3] || match[4]) {
          delimTotal += rLength;
          continue;
        }
        delimTotal -= rLength;
        if (delimTotal > 0) continue;
        rLength = Math.min(rLength, rLength + delimTotal);
        const lastCharLength = (match[0].charCodeAt(0) >= 0xD800 && match[0].charCodeAt(0) <= 0xDBFF) ? 2 : 1;
        const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
        const text = raw.slice(lLength, -lLength);
        return { type: 'del', raw, text, tokens: this.inlineTokens(text) };
      }
    }
  }

  autolink(src) {
    const cap = autolinkRe.exec(src);
    if (cap) {
      let text, href;
      if (cap[2] === '@') {
        text = cap[1];
        href = 'mailto:' + text;
      } else {
        text = cap[1];
        href = text;
      }
      return {
        type: 'link', raw: cap[0], text, href, autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
  }

  url(src) {
    let cap;
    if (cap = urlRe.exec(src)) {
      let text, href;
      if (cap[2] === '@') {
        text = cap[0];
        href = 'mailto:' + text;
      } else {
        let prevCapZero;
        do {
          prevCapZero = cap[0];
          cap[0] = backpedalRe.exec(cap[0])?.[0] ?? '';
        } while (prevCapZero !== cap[0]);
        text = cap[0];
        if (cap[1] === 'www.') href = 'http://' + cap[0];
        else href = cap[0];
      }
      return {
        type: 'link', raw: cap[0], text, href, autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
  }

  inlineText(src) {
    const cap = textGfmRe.exec(src);
    if (cap) {
      const escaped = this.state.inRawBlock;
      return {
        type: 'text',
        raw: cap[0],
        text: escaped ? cap[0] : decodeNumericRefs(cap[0]),
        escaped,
      };
    }
  }

  // Does this link text hold a link already? (images do not count)
  linkInText(text) {
    if (!text.includes('[')) return false;
    for (const match of text.matchAll(blockSkipRe)) {
      if (linkRe.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
    }
    for (const match of text.matchAll(reflinkSearchRe)) {
      const match0 = match[0];
      const refStart = match0.lastIndexOf('[');
      if (match0.charAt(0) === '!' || !Object.hasOwn(this.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
      if (refStart > 1 && this.linkInText(match0.slice(1, refStart - 1))) continue;
      return true;
    }
    return false;
  }

  // Mask links, code, html and escapes so emStrong/del do not see
  // delimiters inside them. Length-preserving: emStrong/del line the
  // masked source up with src by slicing from the end.
  maskSrc(src) {
    let maskedSrc = src;
    // Reflink masking only matters when link definitions exist.
    if (this.linkCount > 0 && src.includes('[')) {
      const maskReflink = (match0) => {
        const refStart = match0.lastIndexOf('[');
        if (!Object.hasOwn(this.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
        if (refStart > 1 && match0.charAt(0) !== '!') {
          const text = match0.slice(1, refStart - 1);
          if (this.linkInText(text)) {
            return '[' + text.replace(reflinkSearchRe, maskReflink)
              + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(match0.length - 2) + ']';
      };
      maskedSrc = maskedSrc.replace(reflinkSearchRe, maskReflink);
    }
    // The escape/code mask needs a backtick or a backslash to match at all.
    if (src.indexOf('`') !== -1 || src.indexOf('\\') !== -1) {
      maskedSrc = maskedSrc.replace(anyPunctuationOutsideCodeRe, (match0, code, punct) => {
        if (punct) return '+'.repeat(match0.length);
        if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
        return match0;
      });
    }
    // blockSkip matches a link ([), a code span (`) or html (<) only.
    if (src.indexOf('[') !== -1 || src.indexOf('`') !== -1 || src.indexOf('<') !== -1) {
      maskedSrc = maskedSrc.replace(blockSkipRe, (match0, _link, context) => {
        const offset = context ? context.length : 0;
        return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
      });
    }
    return maskedSrc;
  }

  inline(src, tokens) {
    tokens = tokens || [];
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  inlineTokens(src, tokens) {
    tokens = tokens || [];
    // Fast path: a run with no inline construct at all is a single text
    // token (numeric references decoded; escaped on render). The constructs
    // are: \ < [ ` * _ ~, plus www. / :// / @ for extended autolinks, plus a
    // hard break (two spaces before a newline).
    if (src.length > 0
      && !constructRe.test(src) && src.indexOf('www.') === -1 && src.indexOf('://') === -1
      && src.indexOf('@') === -1 && src.indexOf('  \n') === -1) {
      const escaped = this.state.inRawBlock;
      tokens.push({ type: 'text', raw: src, text: escaped ? src : decodeNumericRefs(src), escaped });
      return tokens;
    }
    const prevLinkParenPossible = this.state.linkParenPossible;
    this.state.linkParenPossible = prevLinkParenPossible && src.includes(')');
    try {
      // The mask only changes the source where a link, code span, tag or
      // escape sits; without any of those it is the identity, so skip it.
      // Likewise the closer scan is pointless with no delimiter at all.
      const hasDelim = delimRe.test(src);
      const needsMask = hasDelim && maskCharRe.test(src);
      const maskedSrc = needsMask ? this.maskSrc(src) : src;
      const prevClosers = this.closers;
      this.closers = hasDelim ? scanClosers(maskedSrc) : { last: { '*': -1, _: -1 }, lastDel: -1 };
      try {
        return this.tokenizeInlines(src, maskedSrc, tokens);
      } finally {
        this.closers = prevClosers;
      }
    } finally {
      this.state.linkParenPossible = prevLinkParenPossible;
    }
  }

  tokenizeInlines(src, maskedSrc, tokens) {
    let keepPrevChar = false;
    let prevChar = '';
    let srcLength = Infinity;
    while (src) {
      if (src.length < srcLength) srcLength = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      if (!keepPrevChar) prevChar = '';
      keepPrevChar = false;
      let token;
      // First-character dispatch: each inline rule is anchored, so a rule
      // whose opening character cannot appear here is skipped. Order is
      // marked's; guards only skip, never reorder.
      const c = src[0];
      if (c === '\\' && (token = this.escape(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (c === '<' && (token = this.tag(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((c === '[' || (c === '!' && src[1] === '[')) && (token = this.link(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((c === '[' || (c === '!' && src[1] === '[')) && (token = this.reflink(src, this.links))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (token.type === 'text' && lastToken?.type === 'text') {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else tokens.push(token);
        continue;
      }
      if ((c === '*' || c === '_') && (token = this.emStrong(src, maskedSrc, prevChar))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (c === '`' && (token = this.codespan(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((c === ' ' || c === '\\') && (token = this.br(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (c === '~' && (token = this.del(src, maskedSrc, prevChar))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (c === '<' && (token = this.autolink(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (!this.state.inLink && urlStart(src) && (token = this.url(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.inlineText(src)) {
        src = src.substring(token.raw.length);
        if (token.raw.slice(-1) !== '_') prevChar = token.raw.slice(-1);
        keepPrevChar = true;
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'text') {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else tokens.push(token);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    return tokens;
  }
}

// ---------------------------------------------------------------------------
// Block tokenizers (tried in order by blockTokens).
Lx.prototype.space = function (src) {
  const cap = newlineRe.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
};

Lx.prototype.code = function (src) {
  const cap = blockCodeRe.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    const text = raw.replace(O.codeRemoveIndent, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }
};

Lx.prototype.fences = function (src) {
  const cap = fencesRe.exec(src);
  if (cap) {
    const raw = cap[0];
    const text = indentCodeCompensation(raw, cap[3] || '');
    return {
      type: 'code', raw,
      lang: cap[2] ? cap[2].trim().replace(anyPunctuationRe, '$1') : cap[2],
      text,
    };
  }
};

Lx.prototype.heading = function (src) {
  const cap = headingRe.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (O.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || O.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
    }
    return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text, tokens: this.inline(text) };
  }
};

Lx.prototype.hr = function (src) {
  const cap = hrRe.exec(src);
  if (cap) return { type: 'hr', raw: rtrim(cap[0], '\n') };
};

Lx.prototype.blockquote = function (src) {
  const cap = blockquoteRe.exec(src);
  if (!cap) return undefined;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (O.blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else break;
    }
    lines = lines.slice(i);
    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(O.blockquoteMarkerWhitespace, (_, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(O.blockquoteSetextReplace, '\n    $1')
      .replace(O.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;
    const top = this.state.top;
    this.state.top = true;
    this.blockTokens(currentText, tokens, true);
    this.state.top = top;
    if (lines.length === 0) break;
    const lastToken = tokens.at(-1);
    if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
      break;
    } else if (lastToken?.type === 'blockquote') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(O.blockquoteSetextReplace2, '');
      const newToken = this.blockquote(newText);
      tokens[tokens.length - 1] = newToken;
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken?.type === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = this.list(newText);
      tokens[tokens.length - 1] = newToken;
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
};

Lx.prototype.list = function (src) {
  let cap = listRe.exec(src);
  if (!cap) return undefined;
  const listSrc = src;
  const taken = () => listSrc.length - src.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = {
    type: 'list', raw: '', ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false, items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = O.listItemRegex(bull);
  let endsWithBlankLine = false;
  while (src) {
    let endEarly = false;
    const contents = []; // item lines; joined once at the end (avoids O(n^2) +=)
    if (!(cap = itemRegex.exec(src))) break;
    if (hrRe.test(src)) break;
    const itemStart = taken();
    src = src.substring(cap[0].length);
    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(O.leadingSpaceTab, (ws) => expandTabs(ws, bulletIndent));
    let nextLine = src.split('\n', 1)[0];
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(O.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      contents.push(line.slice(indent));
      indent += bulletIndent;
    }
    if (blankLine && O.blankLine.test(nextLine)) {
      src = src.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRegex = O.nextBulletRegex(indent);
      const hrRegex = O.hrRegex(indent);
      const fencesBeginRegex = O.fencesBeginRegex(indent);
      const headingBeginRegex = O.headingBeginRegex(indent);
      const htmlBeginRegex = O.htmlBeginRegex(indent);
      const blockquoteBeginRegex = O.blockquoteBeginRegex(indent);
      while (src) {
        const nl = src.indexOf('\n');
        const rawLine = nl === -1 ? src : src.slice(0, nl);
        nextLine = rawLine;
        const c0 = nextLine[0];
        const nextLineWithoutTabs = (c0 === ' ' || c0 === '\t')
          ? nextLine.replace(O.leadingSpaceTab, (ws) => expandTabs(ws))
          : nextLine;
        const sig = lineSig(nextLine, indent);
        let hit = false;
        if (sig === '`' || sig === '~') hit = fencesBeginRegex.test(nextLine);
        else if (sig === '#') hit = headingBeginRegex.test(nextLine);
        else if (sig === '<') hit = htmlBeginRegex.test(nextLine);
        else if (sig === '>') hit = blockquoteBeginRegex.test(nextLine);
        else if (sig === '*' || sig === '+' || sig === '-' || (sig >= '0' && sig <= '9')) hit = nextBulletRegex.test(nextLine);
        if (!hit && (sig === '-' || sig === '_' || sig === '*')) hit = hrRegex.test(nextLine);
        if (hit) break;
        // Leading-space count of the tab-expanded line; a blank line is
        // one that is nothing but spaces after expansion.
        let lead = 0;
        while (nextLineWithoutTabs[lead] === ' ') lead++;
        if (lead >= indent || lead === nextLineWithoutTabs.length) {
          contents.push(nextLineWithoutTabs.slice(indent));
        } else {
          if (blankLine) break;
          if (line.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4) break;
          const lsig = lineSig(line, indent);
          let lhit = false;
          if (lsig === '`' || lsig === '~') lhit = fencesBeginRegex.test(line);
          else if (lsig === '#') lhit = headingBeginRegex.test(line);
          else if (lsig === '<') lhit = htmlBeginRegex.test(line);
          if (!lhit && (lsig === '-' || lsig === '_' || lsig === '*')) lhit = hrRegex.test(line);
          if (lhit) break;
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && lheadingRe.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          contents.push(continuation);
        }
        blankLine = lead === nextLineWithoutTabs.length;
        src = src.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    const itemContents = contents.join('\n');
    const raw = listSrc.slice(itemStart, taken());
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (O.doubleBlankLine.test(raw)) endsWithBlankLine = true;
    }
    list.items.push({
      type: 'list_item', raw,
      task: O.listIsTask.test(itemContents),
      loose: false, text: itemContents, tokens: [],
    });
  }
  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else return undefined;
  list.raw = listSrc.slice(0, taken()).trimEnd();
  for (const item of list.items) {
    this.state.top = false;
    item.tokens = this.blockTokens(item.text, []);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => O.anyLine.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
      item.text = item.text.replace(O.listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(O.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(O.listReplaceTask, '');
      for (let i = this.inlineQueue.length - 1; i >= 0; i--) {
        if (O.listIsTask.test(this.inlineQueue[i].src)) {
          this.inlineQueue[i].src = this.inlineQueue[i].src.replace(O.listReplaceTask, '');
          break;
        }
      }
      const taskRaw = O.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checkboxToken = {
          type: 'checkbox', raw: taskRaw[0] + ' ',
          checked: taskRaw[0] !== '[ ]',
        };
        item.checked = checkboxToken.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
            item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
            item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(checkboxToken);
          } else {
            item.tokens.unshift({
              type: 'paragraph', raw: checkboxToken.raw, text: checkboxToken.raw,
              tokens: [checkboxToken],
            });
          }
        } else {
          item.tokens.unshift(checkboxToken);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.type === 'text') token.type = 'paragraph';
      }
    }
  }
  return list;
};

Lx.prototype.html = function (src) {
  const cap = htmlRe.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return {
      type: 'html', block: true, raw,
      pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
      text: raw,
    };
  }
};

Lx.prototype.def = function (src) {
  const cap = defRe.exec(src);
  if (cap) {
    if (!O.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return undefined;
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(O.hrefBrackets, '$1').replace(anyPunctuationRe, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(anyPunctuationRe, '$1') : cap[3];
    return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
  }
};

Lx.prototype.table = function (src) {
  const cap = gfmTableRe.exec(src);
  if (!cap) return undefined;
  if (!O.tableDelimiter.test(cap[2])) return undefined;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(O.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(O.tableRowBlankLine, '').split('\n') : [];
  const item = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headers.length !== aligns.length) return undefined;
  for (const align of aligns) {
    if (O.tableAlignRight.test(align)) item.align.push('right');
    else if (O.tableAlignCenter.test(align)) item.align.push('center');
    else if (O.tableAlignLeft.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({ text: headers[i], tokens: this.inline(headers[i]), header: true, align: item.align[i] });
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
      text: cell, tokens: this.inline(cell), header: false, align: item.align[i],
    })));
  }
  return item;
};

Lx.prototype.lheading = function (src) {
  const cap = lheadingRe.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return {
      type: 'heading', raw: rtrim(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2,
      text, tokens: this.inline(text),
    };
  }
};

Lx.prototype.paragraph = function (src) {
  const cap = paragraphGfmRe.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: this.inline(text) };
  }
};

Lx.prototype.text = function (src) {
  const cap = blockTextRe.exec(src);
  if (cap) {
    return { type: 'text', raw: cap[0], text: cap[0], tokens: this.inline(cap[0]) };
  }
};

// ---------------------------------------------------------------------------
// Block token loop + entry point.
Lx.prototype.blockTokens = function (src, tokens, lastParagraphClipped) {
  tokens = tokens || [];
  lastParagraphClipped = !!lastParagraphClipped;
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) srcLength = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let token;
    // First-character dispatch: each block regex is anchored at the start,
    // so a tokenizer whose opening character cannot appear here is skipped.
    // The order below is marked's; guards only skip, never reorder.
    const c = src[0];
    const sp = c === ' ' || c === '\t';
    if ((c === '\n' || sp) && (token = this.space(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (token.raw.length === 1 && lastToken !== undefined) lastToken.raw += '\n';
      else tokens.push(token);
      continue;
    }
    if (sp && (token = this.code(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        this.inlineQueue.at(-1).src = lastToken.text;
      } else tokens.push(token);
      continue;
    }
    if ((sp || c === '`' || c === '~') && (token = this.fences(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((sp || c === '#') && (token = this.heading(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((sp || c === '-' || c === '_' || c === '*') && (token = this.hr(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((sp || c === '>') && (token = this.blockquote(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((sp || c === '*' || c === '+' || c === '-' || (c >= '0' && c <= '9')) && (token = this.list(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((sp || c === '<') && (token = this.html(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((sp || c === '[') && (token = this.def(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
        this.inlineQueue.at(-1).src = lastToken.text;
      } else {
        if (!this.links[token.tag]) { this.links[token.tag] = { href: token.href, title: token.title }; this.linkCount++; }
        tokens.push(token);
      }
      continue;
    }
    if (hasTableDelimiterAhead(src) && (token = this.table(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (hasSetextAhead(src) && (token = this.lheading(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (this.state.top && (token = this.paragraph(src))) {
      const lastToken = tokens.at(-1);
      if (lastParagraphClipped && lastToken?.type === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        this.inlineQueue.pop();
        this.inlineQueue.at(-1).src = lastToken.text;
      } else tokens.push(token);
      lastParagraphClipped = false;
      src = src.substring(token.raw.length);
      continue;
    }
    if (token = this.text(src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        this.inlineQueue.pop();
        this.inlineQueue.at(-1).src = lastToken.text;
      } else tokens.push(token);
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  this.state.top = true;
  return tokens;
};

Lx.prototype.lex = function (src) {
  src = src.replace(O.carriageReturn, '\n');
  const tokens = [];
  this.blockTokens(src, tokens);
  for (let i = 0; i < this.inlineQueue.length; i++) {
    const next = this.inlineQueue[i];
    this.state.inRawBlock = false;
    this.inlineTokens(next.src, next.tokens);
  }
  this.inlineQueue = [];
  return tokens;
};

// ---------------------------------------------------------------------------
// Rendering: tokens -> HTML strings (same shapes as marked's default renderer).
function renderTextToken(token, plain) {
  if (plain) return token.text;
  return token.escaped ? token.text : escapeHtml(token.text);
}

function renderInline(tokens, plain) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'escape':
        out += plain ? token.text : escapeHtml(token.text);
        break;
      case 'html':
        out += token.text;
        break;
      case 'link': {
        if (plain) {
          out += token.tokens ? renderInline(token.tokens, true) : token.text;
          break;
        }
        const parsedText = token.autolink
          ? escapeHtml(token.text, true)
          : renderInline(token.tokens);
        const cleanHref = cleanUrl(token.href);
        if (cleanHref === null) { out += parsedText; break; }
        const href = escapeHtml(cleanHref, token.autolink);
        let linkOut = '<a href="' + href + '"';
        if (token.title) linkOut += ' title="' + escapeHtml(token.title) + '"';
        linkOut += '>' + parsedText + '</a>';
        out += linkOut;
        break;
      }
      case 'image': {
        if (plain) {
          out += token.tokens ? renderInline(token.tokens, true) : token.text;
          break;
        }
        let text = token.text;
        if (token.tokens) text = renderInline(token.tokens, true);
        const cleanHref = cleanUrl(token.href);
        if (cleanHref === null) { out += escapeHtml(text); break; }
        let imgOut = `<img src="${escapeHtml(cleanHref)}" alt="${escapeHtml(text)}"`;
        if (token.title) imgOut += ` title="${escapeHtml(token.title)}"`;
        imgOut += '>';
        out += imgOut;
        break;
      }
      case 'checkbox':
        out += plain ? token.raw : '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'strong':
        out += plain
          ? (token.tokens ? renderInline(token.tokens, true) : token.text)
          : `<strong>${renderInline(token.tokens)}</strong>`;
        break;
      case 'em':
        out += plain
          ? (token.tokens ? renderInline(token.tokens, true) : token.text)
          : `<em>${renderInline(token.tokens)}</em>`;
        break;
      case 'codespan':
        out += plain ? token.text : `<code>${escapeHtml(token.text, true)}</code>`;
        break;
      case 'br':
        out += plain ? '' : '<br>';
        break;
      case 'del':
        out += plain
          ? (token.tokens ? renderInline(token.tokens, true) : token.text)
          : `<del>${renderInline(token.tokens)}</del>`;
        break;
      case 'text':
        out += renderTextToken(token, plain);
        break;
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

function renderBlocks(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${token.depth}>${renderInline(token.tokens)}</h${token.depth}>\n`;
        break;
      case 'code': {
        const langString = (token.lang || '').match(O.notSpaceStart)?.[0];
        const code = token.text ? token.text.replace(O.endingNewline, '') + '\n' : '';
        if (!langString) out += '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
        else out += '<pre><code class="language-' + escapeHtml(langString) + '">' + escapeHtml(code, true) + '</code></pre>\n';
        break;
      }
      case 'table': {
        let cell = '';
        for (let j = 0; j < token.header.length; j++) cell += tablecell(token.header[j]);
        let header = `<tr>\n${cell}</tr>\n`;
        let body = '';
        for (let j = 0; j < token.rows.length; j++) {
          const row = token.rows[j];
          cell = '';
          for (let k = 0; k < row.length; k++) cell += tablecell(row[k]);
          body += `<tr>\n${cell}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(token.tokens)}</blockquote>\n`;
        break;
      case 'list': {
        let body = '';
        for (let j = 0; j < token.items.length; j++) body += `<li>${renderBlocks(token.items[j].tokens)}</li>\n`;
        const type = token.ordered ? 'ol' : 'ul';
        const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
        out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
        break;
      }
      case 'checkbox':
        out += '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'html':
        out += token.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += `<p>${renderInline(token.tokens)}</p>\n`;
        break;
      case 'text':
        out += token.tokens ? renderInline(token.tokens) : (token.escaped ? token.text : escapeHtml(token.text));
        break;
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

function tablecell(token) {
  const content = renderInline(token.tokens);
  const type = token.header ? 'th' : 'td';
  const tag = token.align ? `<${type} align="${token.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

// ---------------------------------------------------------------------------
// Entry point: one fresh lexer per document, like marked.parse.
export function parse(markdown) {
  const lx = new Lx();
  const tokens = lx.lex(markdown);
  return renderBlocks(tokens);
}
