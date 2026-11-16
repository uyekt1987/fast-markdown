// parse.js — a fast CommonMark + GFM renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// its default options (gfm on, breaks off, pedantic off, async off), for
// every input. It is a clean-room implementation: the grammar below follows
// the CommonMark 0.31.2 + GFM 0.29 rules as marked applies them, written here
// from the spec and from marked's observable behaviour, not copied from its
// source. Where marked departs from the spec, marked's output wins.
//
// Speed: blocks are parsed and rendered in one fused pass (no token tree),
// inline content is rendered straight to strings, and plain text takes a
// fast path that skips the inline loop entirely.

/* ------------------------------------------------------------------ */
/* Small regex-building helper: substitute a named placeholder in a    */
/* pattern source, then compile. Used once at load time.               */
/* ------------------------------------------------------------------ */

const CARET = /(^|[^\[])\^/g;
function buildRegex(source, flags, subs) {
  let src = typeof source === 'string' ? source : source.source;
  if (subs) {
    for (const [name, val] of subs) {
      const v = typeof val === 'string' ? val : val.source;
      src = src.replace(name, v.replace(CARET, '$1'));
    }
  }
  return new RegExp(src, flags);
}

/* ------------------------------------------------------------------ */
/* Shared small patterns                                               */
/* ------------------------------------------------------------------ */

const TAG_NAMES = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const HR_SRC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const FENCES_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const BLOCKQUOTE_SRC = ' {0,3}>';
const HTML_START_SRC = ' {0,3}(?:</?(?:' + TAG_NAMES + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

/* ------------------------------------------------------------------ */
/* Block grammar                                                       */
/* ------------------------------------------------------------------ */

const R_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const R_BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const R_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const R_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const R_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const R_BLOCK_TEXT = /^[^\n]+/;

const LHEADING_CORE = '^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
const R_LHEADING = buildRegex(LHEADING_CORE, '', [
  [/bull/g, BULLET],
  [/blockCode/g, /(?: {4}| {0,3}\t)/],
  [/fences/g, / {0,3}(?:`{3,}|~{3,})/],
  [/blockquote/g, / {0,3}>/],
  [/heading/g, / {0,3}#{1,6}(?:\s|$)/],
  [/hr/g, new RegExp(HR_SRC)],
  [/html/g, / {0,3}<[^\n>]+>\n/],
  [/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/],
]);

const R_TABLE = buildRegex(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
  '',
  [
    [/hr/g, new RegExp(HR_SRC)],
    [/heading/g, new RegExp(HEADING_SRC)],
    [/blockquote/g, / {0,3}>/],
    [/code/g, /(?: {4}| {0,3}\t)[^\n]/],
    [/fences/g, new RegExp(FENCES_SRC)],
    [/list/g, / {0,3}(?:[*+-]|1[.)])[ \t]/],
    [/html/g, new RegExp(HTML_START_SRC)],
  ],
);

const PARAGRAPH_CORE = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
const R_PARAGRAPH = buildRegex(PARAGRAPH_CORE, '', [
  [/hr/g, new RegExp(HR_SRC)],
  [/heading/g, new RegExp(HEADING_SRC)],
  [/\|lheading/g, ''],
  [/table/g, R_TABLE],
  [/blockquote/g, / {0,3}>/],
  [/fences/g, new RegExp(FENCES_SRC)],
  [/list/g, / {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/],
  [/html/g, new RegExp(HTML_START_SRC)],
]);
// Inside a blockquote a bare list marker (any number) starts a sibling list,
// so it must not be lazily continued as paragraph text.
const R_BQ_PARAGRAPH = buildRegex(PARAGRAPH_CORE, '', [
  [/hr/g, new RegExp(HR_SRC)],
  [/heading/g, new RegExp(HEADING_SRC)],
  [/\|lheading/g, ''],
  [/table/g, R_TABLE],
  [/blockquote/g, / {0,3}>/],
  [/fences/g, new RegExp(FENCES_SRC)],
  [/list/g, / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/],
  [/html/g, new RegExp(HTML_START_SRC)],
]);

const R_BLOCKQUOTE = buildRegex(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+',
  '',
  [[/paragraph/g, R_BQ_PARAGRAPH]],
);

const BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const DEF_TITLE = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
const R_DEF = buildRegex(
  '^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)',
  '',
  [
    [/label/g, BLOCK_LABEL],
    [/title/g, DEF_TITLE],
  ],
);

const R_LIST = buildRegex('^(bull)([ \\t][^\\n]*?)?(?:\\n|$)', '', [[/bull/g, BULLET]]);

const R_HTML = buildRegex(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' // (1)
  + '|comment[^\\n]*(\\n+|$)' // (2)
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' // (3)
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' // (4)
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' // (5)
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (6)
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) open
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) close
  + ')', 'i',
  [
    [/comment/g, COMMENT],
    [/tag/g, TAG_NAMES],
    [/attribute/g, / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/],
  ],
);

/* ------------------------------------------------------------------ */
/* "other" small patterns                                              */
/* ------------------------------------------------------------------ */

const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
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
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
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
  nextBulletRegex: (indent) => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),
  hrRegex: (indent) => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`),
  fencesBeginRegex: (indent) => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}(?:\`\`\`|~~~)`),
  headingBeginRegex: (indent) => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}#{1,6}(?:\\s|$)`),
  htmlBeginRegex: (indent) => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'),
  blockquoteBeginRegex: (indent) => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}>`),
};

/* ------------------------------------------------------------------ */
/* Inline grammar                                                      */
/* ------------------------------------------------------------------ */

const I_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const I_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const I_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const I_AUTOLINK = buildRegex(
  '^<(scheme:[^\\s\x00-\\x1f<>]*|email)>',
  '',
  [
    [/scheme/g, /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/],
    [/email/g, /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/],
  ],
);
const INLINE_COMMENT = /<!--(?:-?>|[\s\S]*?-->)/;
const I_TAG = buildRegex(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' // closing tag
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>' // open tag
  + '|^<\\?[\\s\\S]*?\\?>' // processing instruction
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>' // declaration
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>', // CDATA
  '',
  [
    [/comment/g, INLINE_COMMENT],
    [/attribute/g, /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/],
  ],
);

// One matched pair of brackets, holding no bracket of its own.
const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const INLINE_LABEL = buildRegex(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
  '',
  [[/brackets/g, INLINE_LABEL_BRACKETS]],
);
const I_LINK = buildRegex(
  /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/,
  '',
  [
    [/label/g, INLINE_LABEL],
    [/href/g, /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/],
    [/title/g, /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/],
  ],
);
const I_REFLINK = buildRegex(/^!?\[(label)\]\[(ref)\]/, '', [
  [/label/g, INLINE_LABEL],
  [/ref/g, BLOCK_LABEL],
]);
const I_NOLINK = buildRegex(/^!?\[(ref)\](?:\[\])?/, '', [[/ref/g, BLOCK_LABEL]]);

const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = buildRegex(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
  '',
  [[/brackets/g, INLINE_LABEL_BRACKETS]],
);
const I_REFLINK_SEARCH = buildRegex('reflink|nolink(?!\\()', 'g', [
  [/reflink/g, buildRegex(/^!?\[(label)\]\[(ref)\]/, '', [
    [/label/g, BOUNDED_INLINE_LABEL],
    [/ref/g, BOUNDED_BLOCK_LABEL],
  ])],
  [/nolink/g, buildRegex(/^!?\[(ref)\](?:\[\])?/, '', [[/ref/g, BOUNDED_BLOCK_LABEL]])],
]);

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u;
// GFM: ~ is not punctuation for emphasis purposes (strikethrough owns it).
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;

const BLOCK_SKIP = buildRegex(/link|precode-code|html/, 'g', [
  [/link/g, /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/],
  [/precode-/g, '(^^|[^`])'],
  [/code/g, /(?<b>`+)[^`]+\k<b>(?!`)/],
  [/html/g, /<(?! )[^<>]*?>/],
]);

const EM_STRONG_L_DELIM = buildRegex(
  /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,
  'u',
  [[/punct/g, PUNCT_GFM]],
);
const EM_STRONG_R_DELIM_AST_CORE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // skip orphan inside strong
  + '|[^*]+(?=[^*])' // consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1)
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2)
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3)
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4)
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5)
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6)
const EM_STRONG_R_DELIM_AST = buildRegex(EM_STRONG_R_DELIM_AST_CORE, 'gu', [
  [/notPunctSpace/g, NOT_PUNCT_OR_SPACE_GFM],
  [/punctSpace/g, PUNCT_OR_SPACE_GFM],
  [/punct/g, PUNCT_GFM],
]);
const EM_STRONG_R_DELIM_UND = buildRegex(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // skip orphan inside strong
  + '|[^_]+(?=[^_])' // consume to delim
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1)
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2)
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3)
  + '|[\\s](_+)(?!_)(?=punct)' // (4)
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu', // (5)
  [
    [/notPunctSpace/g, NOT_PUNCT_OR_SPACE],
    [/punctSpace/g, PUNCT_OR_SPACE],
    [/punct/g, PUNCT],
  ],
);
const DEL_L_DELIM = buildRegex(/^~~?(?:((?!~)punct)|[^\s~])/, 'u', [[/punct/g, PUNCT]]);
const DEL_R_DELIM = buildRegex(
  '^[^~]+(?=[^~])' // consume to delim
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1)
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2)
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3)
  + '|[\\s](~~?)(?!~)(?=punct)' // (4)
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5)
  + '|notPunctSpace(~~?)(?=notPunctSpace)', 'gu', // (6)
  [
    [/notPunctSpace/g, NOT_PUNCT_OR_SPACE],
    [/punctSpace/g, PUNCT_OR_SPACE],
    [/punct/g, PUNCT],
  ],
);
const ANY_PUNCT = buildRegex(/\\(punct)/, 'gu', [[/punct/g, PUNCT]]);
const ANY_PUNCT_OUTSIDE_CODE = buildRegex(
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu',
  [[/punct/g, PUNCT]],
);
const PUNCT_RE = buildRegex(/^((?![*_])punctSpace)/, 'u', [[/punctSpace/g, PUNCT_OR_SPACE]]);

const CASE_INSENSITIVE_PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EXTENDED_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EXTENDED_EMAIL_PROTOCOL = buildRegex(
  /(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/,
  '',
  [[/email/g, EXTENDED_EMAIL]],
);
const I_URL = buildRegex(
  /^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/,
  '',
  [
    [/emailProtocol/g, EXTENDED_EMAIL_PROTOCOL],
    [/protocol/g, CASE_INSENSITIVE_PROTOCOL],
    [/email/g, /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/],
  ],
);
const I_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const I_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// GFM inline text: stops before a construct that could start, before a
// hard-break marker, and before www/email autolink starts.
const I_TEXT = buildRegex(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  '',
  [
    [/protocol/g, CASE_INSENSITIVE_PROTOCOL],
    [/emailProtocol/g, /(?:mailto|xmpp):/],
    [/wwwStart/g, 'www\\.'],
  ],
);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(html, encode) {
  if (encode) {
    if (O.escapeTest.test(html)) {
      return html.replace(O.escapeReplace, (ch) => ESCAPE_MAP[ch]);
    }
  } else if (O.escapeTestNoEncode.test(html)) {
    return html.replace(O.escapeReplaceNoEncode, (ch) => ESCAPE_MAP[ch]);
  }
  return html;
}

// Numeric character references are recognised outside code and stand for the
// character they name. Zero, out of range, or a surrogate becomes U+FFFD.
// A decoded character must not join its neighbours into a new reference, so
// every `&` that is not already one is escaped here.
function decodeNumericRefs(text) {
  if (!O.numericCharacterReference.test(text)) {
    return text;
  }
  return text.replace(O.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) {
      return '&amp;';
    }
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return '\uFFFD';
    }
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(O.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  // Make sure every cell-delimiting pipe has a space before it, so an
  // escaped pipe is told apart from a delimiter.
  const row = tableRow.replace(O.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(O.splitPipe);
  let i = 0;
  if (!cells[0].trim()) {
    cells.shift();
  }
  if (cells.length > 0 && !cells.at(-1)?.trim()) {
    cells.pop();
  }
  if (count) {
    if (cells.length > count) {
      cells.splice(count);
    } else {
      while (cells.length < count) cells.push('');
    }
  }
  for (; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(O.slashPipe, '|');
  }
  return cells;
}

// Remove trailing 'c's. Equivalent to str.replace(/c*$/, '').
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) {
    return '';
  }
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) {
      suffLen++;
    } else if (currChar !== c && invert) {
      suffLen++;
    } else {
      break;
    }
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && O.blankLine.test(lines[end])) {
    end--;
  }
  if (lines.length - end <= 2) {
    return str;
  }
  return lines.slice(0, end + 1).join('\n');
}

// Normalise a link label so definitions and references match. Unicode case
// folding is approximated by round-tripping through upper case (as in
// commonmark.js): `ẞ` lowercases to `ß` and never meets `SS` otherwise.
function normalizeLabel(label) {
  return label.trim().replace(O.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) {
    return -1;
  }
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) {
        return i;
      }
    }
  }
  if (level > 0) {
    return -2;
  }
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

/* ------------------------------------------------------------------ */
/* Block nodes. A node is a small object; `t` is its type:             */
/*   0 space  1 code  2 heading  3 hr  4 blockquote  5 list  6 html    */
/*   7 def  8 table  9 paragraph  10 text                             */
/* `raw` is the source the node consumed; `text` is the inline source */
/* for nodes that hold inline content. Rendering happens in a second   */
/* pass, after every link definition in the document has been seen.    */
/* ------------------------------------------------------------------ */

function indentCodeCompensation(raw, text) {
  const m = raw.match(O.indentCodeCompensation);
  if (m === null) {
    return text;
  }
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mi = node.match(O.beginningSpace);
    if (mi === null) {
      return node;
    }
    return node.slice(Math.min(mi[0].length, indentToCode.length));
  }).join('\n');
}

// Index of the first non-space character when the line has at most 3
// leading spaces, or -1 when the line is indented (4+ spaces, or a tab)
// or blank. Most block forms allow at most 3 leading spaces, so a quick
// look at that character decides whether the form's regex can match.
function blockStart(src) {
  let i = 0;
  while (i < 3 && src.charCodeAt(i) === 32) {
    i++;
  }
  const c = src.charCodeAt(i);
  if (c === 32 || c === 9) {
    return -1;
  }
  return i;
}

// Index of the first non-space character of `line` when it has at most
// `maxLead` leading spaces, or -1 when the line is blank, has more leading
// spaces than allowed, or starts with a tab. (A tab is not a space, so the
// space-counted begin-regexes cannot match past one.)
function firstNonSpaceInLine(line, maxLead) {
  let i = 0;
  while (i < maxLead && line.charCodeAt(i) === 32) {
    i++;
  }
  if (i >= line.length) {
    return -1;
  }
  if (line.charCodeAt(i) === 32) {
    return -1;
  }
  return i;
}

function tokSpace(src) {
  const c = src.charCodeAt(0);
  if (c !== 10 && c !== 32 && c !== 9) {
    return null;
  }
  const cap = R_NEWLINE.exec(src);
  if (cap && cap[0].length > 0) {
    return { t: 0, raw: cap[0] };
  }
  return null;
}

function tokCode(src) {
  // Indented code: four spaces, or a tab after at most three spaces.
  if (src.charCodeAt(0) !== 9 && !src.startsWith('    ')) {
    let i = 0;
    while (i < 3 && src.charCodeAt(i) === 32) {
      i++;
    }
    if (src.charCodeAt(i) !== 9) {
      return null;
    }
  }
  const cap = R_BLOCK_CODE.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    const text = raw.replace(O.codeRemoveIndent, '');
    return { t: 1, raw, text };
  }
  return null;
}

function tokFences(src) {
  const i = blockStart(src);
  if (i < 0) {
    return null;
  }
  const c = src.charCodeAt(i);
  if (c !== 96 && c !== 126) {
    return null;
  }
  const cap = R_FENCES.exec(src);
  if (cap) {
    const raw = cap[0];
    const text = indentCodeCompensation(raw, cap[3] || '');
    return {
      t: 1,
      raw,
      lang: cap[2] ? cap[2].trim().replace(ANY_PUNCT, '$1') : cap[2],
      text,
    };
  }
  return null;
}

function tokHeading(src) {
  const i = blockStart(src);
  if (i < 0 || src.charCodeAt(i) !== 35) {
    return null;
  }
  const cap = R_HEADING.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (O.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || O.endingSpaceTabChar.test(trimmed)) {
        text = trimmed.trim();
      }
    }
    return {
      t: 2,
      raw: rtrim(cap[0], '\n'),
      depth: cap[1].length,
      text,
    };
  }
  return null;
}

function tokHr(src) {
  const i = blockStart(src);
  if (i < 0) {
    return null;
  }
  const c = src.charCodeAt(i);
  if (c !== 42 && c !== 45 && c !== 95) {
    return null;
  }
  const cap = R_HR.exec(src);
  if (cap) {
    return { t: 3, raw: rtrim(cap[0], '\n') };
  }
  return null;
}

function tokHtml(src) {
  const i = blockStart(src);
  if (i < 0 || src.charCodeAt(i) !== 60) {
    return null;
  }
  const cap = R_HTML.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return {
      t: 6,
      raw,
      pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
      text: raw,
    };
  }
  return null;
}

function tokDef(src) {
  const i = blockStart(src);
  if (i < 0 || src.charCodeAt(i) !== 91) {
    return null;
  }
  const cap = R_DEF.exec(src);
  if (cap) {
    if (!O.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) {
      return null;
    }
    const tag = normalizeLabel(cap[1]);
    const href = cap[2]
      ? cap[2].replace(O.hrefBrackets, '$1').replace(ANY_PUNCT, '$1')
      : '';
    const title = cap[3]
      ? cap[3].substring(1, cap[3].length - 1).replace(ANY_PUNCT, '$1')
      : cap[3];
    return {
      t: 7,
      tag,
      raw: rtrim(cap[0], '\n'),
      href,
      title,
    };
  }
  return null;
}

function tokTable(src) {
  // A table needs a header line and a delimiter line; the delimiter line
  // starts (after at most three spaces) with :, - or |.
  const nl = src.indexOf('\n');
  if (nl < 0) {
    return null;
  }
  const d = blockStart(src.slice(nl + 1));
  if (d < 0) {
    return null;
  }
  const dc = src.charCodeAt(nl + 1 + d);
  if (dc !== 58 && dc !== 45 && dc !== 124) {
    return null;
  }
  const cap = R_TABLE.exec(src);
  if (!cap) {
    return null;
  }
  if (!O.tableDelimiter.test(cap[2])) {
    return null;
  }
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(O.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(O.tableRowBlankLine, '').split('\n') : [];
  if (headers.length !== aligns.length) {
    return null;
  }
  const align = [];
  for (const a of aligns) {
    if (O.tableAlignRight.test(a)) {
      align.push('right');
    } else if (O.tableAlignCenter.test(a)) {
      align.push('center');
    } else if (O.tableAlignLeft.test(a)) {
      align.push('left');
    } else {
      align.push(null);
    }
  }
  const header = [];
  for (let i = 0; i < headers.length; i++) {
    header.push({ text: headers[i], align: align[i] });
  }
  const rowNodes = [];
  for (const row of rows) {
    rowNodes.push(splitCells(row, headers.length).map((cell, i) => ({
      text: cell,
      align: align[i],
    })));
  }
  return {
    t: 8,
    raw: rtrim(cap[0], '\n'),
    header,
    rows: rowNodes,
    align,
  };
}

function tokLheading(src) {
  const cap = R_LHEADING.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return {
      t: 2,
      raw: rtrim(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2,
      text,
    };
  }
  return null;
}

function tokParagraph(src) {
  const cap = R_PARAGRAPH.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n'
      ? cap[1].slice(0, -1)
      : cap[1];
    return {
      t: 9,
      raw: cap[0],
      text,
    };
  }
  return null;
}

function tokText(src) {
  const cap = R_BLOCK_TEXT.exec(src);
  if (cap) {
    return {
      t: 10,
      raw: cap[0],
      text: cap[0],
    };
  }
  return null;
}

function tokBlockquote(src) {
  const cap = R_BLOCKQUOTE.exec(src);
  if (!cap) {
    return null;
  }
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const items = [];

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
      } else {
        break;
      }
    }
    lines = lines.slice(i);

    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      // A tab after the marker runs to the next tab stop; the marker only
      // consumes one space of it, the rest is content.
      .replace(
        O.blockquoteMarkerWhitespace,
        (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
      )
      // Precede a setext continuation with 4 spaces so it is not a setext.
      .replace(O.blockquoteSetextReplace, '\n    $1')
      .replace(O.blockquoteSetextReplace2, '');
    raw = raw ? raw + '\n' + currentRaw : currentRaw;
    text = text ? text + '\n' + currentText : currentText;

    // Parse the chunk's lines as top level blocks; merge paragraphs when
    // this is a continuation.
    blockLoop(currentText, items, true, true);

    if (lines.length === 0) {
      break;
    }

    const lastToken = items.at(-1);
    if (lastToken?.t === 1 || lastToken?.t === 2 || lastToken?.t === 3
      || lastToken?.t === 6 || lastToken?.t === 8) {
      // A continuation cannot follow a code block, heading, hr, html block
      // or table.
      break;
    } else if (lastToken?.t === 4) {
      // Include the continuation in the nested blockquote.
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(O.blockquoteSetextReplace2, '');
      const newToken = tokBlockquote(newText);
      items[items.length - 1] = newToken;
      // Only include continuation lines the nested blockquote consumed.
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) {
        raw = raw + '\n' + consumed.join('\n');
      }
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && O.blockquoteStart.test(lines[0])) {
        continue;
      }
      break;
    } else if (lastToken?.t === 5) {
      // Include the continuation in the nested list.
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokList(newText);
      items[items.length - 1] = newToken;
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = raw + '\n' + consumed;
        text = text + '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }

  return {
    t: 4,
    raw,
    text,
    items,
  };
}

function tokList(src) {
  // A list starts (after at most three spaces) with a bullet (*, +, -) or
  // an ordered marker (a digit). Anything else cannot be a list.
  const i = blockStart(src);
  if (i < 0) {
    return null;
  }
  const c = src.charCodeAt(i);
  if (c !== 42 && c !== 43 && c !== 45 && (c < 48 || c > 57)) {
    return null;
  }
  let cap = R_LIST.exec(src);
  if (!cap) {
    return null;
  }
  // src is only consumed from the front, so every raw below is a slice of
  // listSrc rather than a string built up line by line.
  const listSrc = src;
  const taken = () => listSrc.length - src.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;

  const list = {
    t: 5,
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };

  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

  const itemRegex = O.listItemRegex(bull);
  let endsWithBlankLine = false;
  while (src) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(src))) {
      break;
    }
    if (R_HR.test(src)) {
      break;
    }

    const itemStart = taken();
    src = src.substring(cap[0].length);

    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(O.leadingSpaceTab, (whitespace) => expandTabs(whitespace, bulletIndent));
    let nextLine = src.split('\n', 1)[0];
    let blankLine = !line.trim();

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(O.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && O.blankLine.test(nextLine)) {
      src = src.substring(nextLine.length + 1);
      endEarly = true;
    }

    if (!endEarly) {
      const {
        nextBullet: nextBulletRegex,
        hr: hrRegex,
        fences: fencesBeginRegex,
        heading: headingBeginRegex,
        html: htmlBeginRegex,
        blockquote: blockquoteBeginRegex,
      } = listBeginRegexes(indent);
      // The begin-regexes allow at most this many leading spaces. A line
      // whose first non-space character is none of the block-start markers
      // cannot match any of them, so the regexes are only run when the
      // first character says one might.
      const maxLead = Math.max(0, Math.min(3, indent - 1));

      while (src) {
        const nlIdx = src.indexOf('\n');
        const rawLine = nlIdx < 0 ? src : src.slice(0, nlIdx);
        nextLine = rawLine;
        const nextLineWithoutTabs = nextLine.includes('\t')
          ? nextLine.replace(O.leadingSpaceTab, (whitespace) => expandTabs(whitespace))
          : nextLine;

        const lead = firstNonSpaceInLine(nextLine, maxLead);
        if (lead >= 0) {
          const lc = nextLine.charCodeAt(lead);
          if (lc === 96 || lc === 126) {
            if (fencesBeginRegex.test(nextLine)) break;
          } else if (lc === 35) {
            if (headingBeginRegex.test(nextLine)) break;
          } else if (lc === 60) {
            if (htmlBeginRegex.test(nextLine)) break;
          } else if (lc === 62) {
            if (blockquoteBeginRegex.test(nextLine)) break;
          } else if (lc === 42 || lc === 43 || lc === 45 || (lc >= 48 && lc <= 57)) {
            if (nextBulletRegex.test(nextLine)) break;
            if (hrRegex.test(nextLine)) break;
          } else if (lc === 95) {
            if (hrRegex.test(nextLine)) break;
          }
        }

        if (nextLineWithoutTabs.search(O.nonSpaceChar) >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) {
            break;
          }
          if (line.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4) {
            break;
          }
          if (fencesBeginRegex.test(line)) {
            break;
          }
          if (headingBeginRegex.test(line)) {
            break;
          }
          if (htmlBeginRegex.test(line)) {
            break;
          }
          if (hrRegex.test(line)) {
            break;
          }
          // A lazy continuation can look like a setext underline after list
          // indentation is removed. Keep it in the paragraph.
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && R_LHEADING.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }

        blankLine = !nextLine.trim();
        src = src.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }

    const raw = listSrc.slice(itemStart, taken());

    if (!list.loose) {
      if (endsWithBlankLine) {
        list.loose = true;
      } else if (O.doubleBlankLine.test(raw)) {
        endsWithBlankLine = true;
      }
    }

    list.items.push({
      raw,
      task: O.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      nodes: [],
    });
  }

  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return null;
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();

  // Tokenize items; finalize list.loose from spacers before checkboxes.
  for (const item of list.items) {
    blockLoop(item.text, item.nodes, false, false);
    if (!list.loose) {
      const spacers = item.nodes.filter((n) => n.t === 0);
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((n) => O.anyLine.test(n.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }

  // Place task checkboxes using the final list.loose.
  for (const item of list.items) {
    const itemNode = item.nodes[0];
    if (item.task && (itemNode?.t === 10 || itemNode?.t === 9)) {
      item.text = item.text.replace(O.listReplaceTask, '');
      itemNode.raw = itemNode.raw.replace(O.listReplaceTask, '');
      itemNode.text = itemNode.text.replace(O.listReplaceTask, '');
      const taskRaw = O.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checkbox = {
          checked: taskRaw[0] !== '[ ]',
          raw: taskRaw[0] + ' ',
        };
        item.checked = checkbox.checked;
        if (list.loose) {
          if (item.nodes[0] && [9, 10].includes(item.nodes[0].t)) {
            // The checkbox raw prefixes the node's raw (bookkeeping, as in
            // marked), but NOT its text: text is the inline source here, and
            // the marker was already stripped from it above.
            item.nodes[0].raw = checkbox.raw + item.nodes[0].raw;
            item.nodes[0].checkbox = checkbox;
          } else {
            item.nodes.unshift({
              t: 9,
              raw: checkbox.raw,
              text: checkbox.raw,
              checkbox,
            });
          }
        } else {
          item.checkbox = checkbox;
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const node of item.nodes) {
        if (node.t === 10) {
          node.t = 9;
        }
      }
    }
  }

  return list;
}

/* ------------------------------------------------------------------ */
/* Block loop: walk the source, trying each block form in marked's     */
/* order, and build the block-node tree. Link definitions are collected */
/* into `links` as they are seen; inline rendering is deferred until   */
/* the whole document has been walked, so a definition later in the    */
/* document still applies to a link earlier in it.                     */
/* ------------------------------------------------------------------ */

let links;
let linkCount = 0;

function blockLoop(src, nodes, top, clipped) {
  let lastParagraphClipped = clipped;
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }

    let node;

    // Blank lines: a lone newline joins the previous block's raw.
    if ((node = tokSpace(src))) {
      src = src.substring(node.raw.length);
      const last = nodes.at(-1);
      if (node.raw.length === 1 && last !== undefined) {
        last.raw += '\n';
      } else {
        nodes.push(node);
      }
      continue;
    }

    // Indented code: cannot interrupt a paragraph or loose text; it joins it.
    if ((node = tokCode(src))) {
      src = src.substring(node.raw.length);
      const last = nodes.at(-1);
      if (last?.t === 9 || last?.t === 10) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + node.raw;
        last.text += '\n' + node.text;
      } else {
        nodes.push(node);
      }
      continue;
    }

    if ((node = tokFences(src))) {
      src = src.substring(node.raw.length);
      nodes.push(node);
      continue;
    }

    if ((node = tokHeading(src))) {
      src = src.substring(node.raw.length);
      nodes.push(node);
      continue;
    }

    if ((node = tokHr(src))) {
      src = src.substring(node.raw.length);
      nodes.push(node);
      continue;
    }

    if ((node = tokBlockquote(src))) {
      src = src.substring(node.raw.length);
      nodes.push(node);
      continue;
    }

    if ((node = tokList(src))) {
      src = src.substring(node.raw.length);
      nodes.push(node);
      continue;
    }

    if ((node = tokHtml(src))) {
      src = src.substring(node.raw.length);
      nodes.push(node);
      continue;
    }

    // Link definition: joins a paragraph or loose text when one precedes it;
    // otherwise it is recorded (first definition of a label wins) and renders
    // nothing.
    if ((node = tokDef(src))) {
      src = src.substring(node.raw.length);
      const last = nodes.at(-1);
      if (last?.t === 9 || last?.t === 10) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + node.raw;
        last.text += '\n' + node.raw;
      } else {
        if (!links[node.tag]) {
          links[node.tag] = { href: node.href, title: node.title };
          linkCount++;
        }
        nodes.push(node);
      }
      continue;
    }

    if ((node = tokTable(src))) {
      src = src.substring(node.raw.length);
      nodes.push(node);
      continue;
    }

    if ((node = tokLheading(src))) {
      src = src.substring(node.raw.length);
      nodes.push(node);
      continue;
    }

    // Top-level paragraph. Inside a list item paragraphs are not formed
    // here; the item's content is lexed as text and loosened later.
    if (top && (node = tokParagraph(src))) {
      const last = nodes.at(-1);
      if (lastParagraphClipped && last?.t === 9) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + node.raw;
        last.text += '\n' + node.text;
      } else {
        nodes.push(node);
      }
      lastParagraphClipped = false;
      src = src.substring(node.raw.length);
      continue;
    }

    // Loose text: a line that is not any other block. Consecutive text
    // lines merge into one node.
    if ((node = tokText(src))) {
      src = src.substring(node.raw.length);
      const last = nodes.at(-1);
      if (last?.t === 10) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + node.raw;
        last.text += '\n' + node.text;
      } else {
        nodes.push(node);
      }
      continue;
    }

    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Block rendering                                                     */
/* ------------------------------------------------------------------ */

function renderCode(node) {
  const langString = (node.lang || '').match(O.notSpaceStart)?.[0];
  // An empty code block has no content, so it must not gain a newline.
  const code = node.text ? node.text.replace(O.endingNewline, '') + '\n' : '';
  const body = escapeHtml(code, true);
  if (!langString) {
    return '<pre><code>' + body + '</code></pre>\n';
  }
  return '<pre><code class="language-' + escapeHtml(langString) + '">' + body + '</code></pre>\n';
}

function checkboxHtml(checkbox) {
  return '<input ' + (checkbox.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderList(node) {
  const type = node.ordered ? 'ol' : 'ul';
  const startAttr = (node.ordered && node.start !== 1) ? (' start="' + node.start + '"') : '';
  let body = '';
  for (const item of node.items) {
    body += '<li>';
    if (item.checkbox) {
      body += checkboxHtml(item.checkbox);
    }
    body += renderBlocks(item.nodes);
    body += '</li>\n';
  }
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderTable(node) {
  let header = '';
  for (let j = 0; j < node.header.length; j++) {
    const cell = node.header[j];
    const tag = cell.align ? `<th align="${cell.align}">` : '<th>';
    header += tag + inlineBlock(cell.text) + '</th>\n';
  }
  header = `<tr>\n${header}</tr>\n`;

  let body = '';
  for (const row of node.rows) {
    let cells = '';
    for (const cell of row) {
      const tag = cell.align ? `<td align="${cell.align}">` : '<td>';
      cells += tag + inlineBlock(cell.text) + '</td>\n';
    }
    body += `<tr>\n${cells}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;

  return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}

function renderBlocks(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.t) {
      case 0: // space
      case 7: // def
        break;
      case 1:
        out += renderCode(node);
        break;
      case 2:
        out += `<h${node.depth}>${inlineBlock(node.text)}</h${node.depth}>\n`;
        break;
      case 3:
        out += '<hr>\n';
        break;
      case 4:
        out += `<blockquote>\n${renderBlocks(node.items)}</blockquote>\n`;
        break;
      case 5:
        out += renderList(node);
        break;
      case 6:
        out += node.text;
        break;
      case 8:
        out += renderTable(node);
        break;
      case 9: {
        let inner = inlineBlock(node.text);
        if (node.checkbox) inner = checkboxHtml(node.checkbox) + inner;
        out += `<p>${inner}</p>\n`;
        break;
      }
      case 10: {
        let inner = inlineBlock(node.text);
        if (node.checkbox) inner = checkboxHtml(node.checkbox) + inner;
        out += inner;
        break;
      }
      default:
        throw new Error('Unknown block type: ' + node.t);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Inline state. Shared across a parse, saved and restored around     */
/* nested runs (a link's label, an emphasis span) exactly as marked    */
/* scopes it.                                                          */
/* ------------------------------------------------------------------ */

const IST = {
  inLink: false,
  inRawBlock: false,
  linkEmitted: false,
  linkParenPossible: true,
};

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) {
    return false;
  }
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = I_CODE.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') {
      continue;
    }
    const tokenSrc = src.slice(labelStart + i);
    const token = I_TAG.exec(tokenSrc) || I_AUTOLINK.exec(tokenSrc);
    if (!token) {
      continue;
    }
    if (token[0].length > label.length - i) {
      return true;
    }
    i += token[0].length - 1;
  }
  return false;
}

// Does this link text hold a link already? An image does not count: an
// image may hold a link, a link may not.
function linkInText(text) {
  if (!text.includes('[')) {
    return false;
  }
  for (const match of text.matchAll(BLOCK_SKIP)) {
    if (I_LINK.test(match[0]) && text.charAt(match.index - 1) !== '!') {
      return true;
    }
  }
  for (const match of text.matchAll(I_REFLINK_SEARCH)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
      continue;
    }
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1))) {
      continue;
    }
    return true;
  }
  return false;
}

// Mask links, code, html and escapes so emStrong and del do not see their
// delimiters inside them. Every mask keeps the length it replaces, so the
// masked source lines up with the real one by slicing from the end.
// The begin-regexes a list item tests depend only on the item indent,
// which yields at most four distinct patterns; compiling one per item is
// pure waste, so they are built once per indent and reused.
const listBeginRegexCache = new Map();
function listBeginRegexes(indent) {
  let entry = listBeginRegexCache.get(indent);
  if (!entry) {
    entry = {
      nextBullet: O.nextBulletRegex(indent),
      hr: O.hrRegex(indent),
      fences: O.fencesBeginRegex(indent),
      heading: O.headingBeginRegex(indent),
      html: O.htmlBeginRegex(indent),
      blockquote: O.blockquoteBeginRegex(indent),
    };
    listBeginRegexCache.set(indent, entry);
  }
  return entry;
}

function maskSrc(src) {
  let maskedSrc = src;
  // Link definitions are collected as the document is walked; without any,
  // a reflink cannot match and the replace is a wasted scan.
  if (linkCount > 0 && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        return match0;
      }
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text)) {
          return '[' + text.replace(I_REFLINK_SEARCH, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(I_REFLINK_SEARCH, maskReflink);
  }
  // Escapes and code spans are the only things this replace can match.
  if (src.includes('\\') || src.includes('`')) {
    maskedSrc = maskedSrc.replace(ANY_PUNCT_OUTSIDE_CODE, (match0, code, punct) => {
      if (punct) {
        return '+'.repeat(match0.length);
      }
      if (code) {
        return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      }
      return match0;
    });
  }
  // Links, code spans and tags are the only things this replace can match.
  if (src.includes('[') || src.includes('<') || src.includes('`')) {
    maskedSrc = maskedSrc.replace(BLOCK_SKIP, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return maskedSrc;
}

// Last indexes of `*` / `_` runs that can close emphasis or strong, and of
// a `~` run that can close strikethrough. A run can close only when it is
// not preceded by ASCII whitespace or the start of the string.
function scanClosers(src) {
  let lastStar = -1;
  let lastUnder = -1;
  let lastTilde = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') {
      continue;
    }
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) {
      j++;
    }
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') {
        lastTilde = i;
      } else if (ch === '*') {
        lastStar = i;
      } else {
        lastUnder = i;
      }
    }
    i = j - 1;
  }
  return { lastStar, lastUnder, lastTilde };
}

// Render a link or image token. Returns null when the link text holds a
// link already (a link may not contain one); the caller then falls through
// to plain text and the inner link is the one kept.
function outputLink(cap, href, title, raw, textMode) {
  const text = cap[1].replace(O.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = IST.inLink;
  const outerLinkEmitted = IST.linkEmitted;
  const outerInRawBlock = IST.inRawBlock;
  IST.inLink = true;
  IST.linkEmitted = false;
  // An image's alt text is the plain-text rendering of its content; a
  // link's content is rendered in the caller's mode.
  const inner = inline(text, isImage ? true : textMode);
  const textHasLink = IST.linkEmitted;
  IST.linkEmitted = outerLinkEmitted;
  IST.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      IST.inRawBlock = outerInRawBlock;
      return null;
    }
    IST.linkEmitted = true;
  }
  if (textMode) {
    // Plain-text rendering (image alt text): the content, no markup.
    return inner;
  }
  if (isImage) {
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      return escapeHtml(inner);
    }
    let out = `<img src="${escapeHtml(cleanHref)}" alt="${escapeHtml(inner)}"`;
    if (title) {
      out += ` title="${escapeHtml(title)}"`;
    }
    out += '>';
    return out;
  }
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) {
    return inner;
  }
  let out = '<a href="' + escapeHtml(cleanHref) + '"';
  if (title) {
    out += ' title="' + escapeHtml(title) + '"';
  }
  out += '>' + inner + '</a>';
  return out;
}

function tokLink(src, textMode) {
  if (IST.linkParenPossible === false) {
    return null;
  }
  const cap = I_LINK.exec(src);
  if (!cap) {
    return null;
  }
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) {
    return null;
  }
  const trimmedUrl = cap[2].trim();
  if (O.startAngleBracket.test(trimmedUrl)) {
    if (!O.endAngleBracket.test(trimmedUrl)) {
      return null;
    }
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) {
      return null;
    }
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) {
      return null;
    }
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  // The ')' that ends the match is the link closer only when it is not
  // escaped. `[foo](/url\)` has no closer.
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) {
    return null;
  }
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (O.startAngleBracket.test(href)) {
    href = href.slice(1, -1);
  }
  const html = outputLink(cap, href ? href.replace(ANY_PUNCT, '$1') : href,
    title ? title.replace(ANY_PUNCT, '$1') : title, cap[0], textMode);
  if (html === null) {
    return null;
  }
  return { raw: cap[0], html };
}

function tokReflink(src, textMode) {
  let cap = I_REFLINK.exec(src) || I_NOLINK.exec(src);
  if (!cap) {
    return null;
  }
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) {
    return null;
  }
  const link = links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    // Not a reference: only the opening bracket is text; parsing continues
    // after it.
    const ch = cap[0].charAt(0);
    return { raw: ch, html: textMode ? ch : escapeHtml(ch), isText: true };
  }
  const html = outputLink(cap, link.href, link.title, cap[0], textMode);
  if (html === null) {
    return null;
  }
  return { raw: cap[0], html };
}

function tokEmStrong(src, getMask, prevChar, textMode) {
  let match = EM_STRONG_L_DELIM.exec(src);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;

  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  let { masked: maskedSrc, scan } = getMask();
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) {
    runStart--;
  }
  const runPrevChar = charBefore(maskedSrc, runStart);
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!PUNCT_RE.exec(runPrevChar);
  if (runStart < srcStart) {
    prevChar = runPrevChar;
  }
  const prevPunct = runStart < srcStart ? runPrevPunct : !!PUNCT_RE.exec(prevChar);

  // _ can't be between two alphanumerics.
  if (match[4] && prevChar.match(O.unicodeAlphaNumeric)) return null;

  const nextChar = match[1] || match[3] || '';

  if (!nextChar || !prevChar || prevPunct) {
    const afterChar = match[1] || match[2] || match[3] || match[4] || '';
    const lLength = match[0].length - afterChar.length;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? EM_STRONG_R_DELIM_AST : EM_STRONG_R_DELIM_UND;
    const lastPossible = delimChar === '*' ? scan.lastStar : scan.lastUnder;
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return null;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = rDelim.length;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) {
          break;
        }
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = match[0].codePointAt(0) > 0xFFFF ? 2 : 1;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        const inner = inline(text, textMode);
        return { raw, html: textMode ? inner : `<em>${inner}</em>` };
      }
      const text = raw.slice(2, -2);
      const inner = inline(text, textMode);
      return { raw, html: textMode ? inner : `<strong>${inner}</strong>` };
    }
  }
  return null;
}

function tokDel(src, getMask, prevChar, textMode) {
  let match = DEL_L_DELIM.exec(src);
  if (!match) return null;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || PUNCT_RE.exec(prevChar)) {
    let { masked: maskedSrc, scan } = getMask();
    const afterChar = match[1] || match[2] || '';
    const lLength = match[0].length - (afterChar.length === 2 ? 1 : 0) - 1;
    let rDelim, rLength, delimTotal = lLength;
    const lastPossible = scan.lastTilde;
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return null;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    DEL_R_DELIM.lastIndex = 0;
    while ((match = DEL_R_DELIM.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = rDelim.length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = match[0].codePointAt(0) > 0xFFFF ? 2 : 1;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      const inner = inline(text, textMode);
      return { raw, html: textMode ? inner : `<del>${inner}</del>` };
    }
  }
  return null;
}

function tokCodespan(src, textMode) {
  const cap = I_CODE.exec(src);
  if (cap) {
    let text = cap[2].replace(O.newLineCharGlobal, ' ');
    const hasNonSpaceChars = O.nonSpaceChar.test(text);
    const hasSpaceCharsOnBothEnds = O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text);
    if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
      text = text.substring(1, text.length - 1);
    }
    return { raw: cap[0], html: textMode ? text : `<code>${escapeHtml(text, true)}</code>` };
  }
  return null;
}

function tokAutolink(src, textMode) {
  const cap = I_AUTOLINK.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[1];
      href = 'mailto:' + text;
    } else {
      text = cap[1];
      href = text;
    }
    if (textMode) {
      return { raw: cap[0], html: text };
    }
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      return { raw: cap[0], html: escapeHtml(text, true) };
    }
    return {
      raw: cap[0],
      html: '<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>',
    };
  }
  return null;
}

function tokUrl(src, textMode) {
  let cap = I_URL.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prevCapZero;
      do {
        prevCapZero = cap[0];
        cap[0] = I_BACKPEDAL.exec(cap[0])?.[0] ?? '';
      } while (prevCapZero !== cap[0]);
      text = cap[0];
      href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
    }
    if (textMode) {
      return { raw: cap[0], html: text };
    }
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      return { raw: cap[0], html: escapeHtml(text, true) };
    }
    return {
      raw: cap[0],
      html: '<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>',
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Inline loop: render an inline source straight to HTML (or, in text */
/* mode, to the plain text an image alt attribute holds).              */
/* ------------------------------------------------------------------ */

// Anything that can start an inline construct: \ < [ ! ` * ~ _ , a bare URL
// (http://, ftp://, www.) or an email (@), or a hard break (two spaces
// before a newline). If none of these is present the source is one plain
// text run and needs no tokenizing.
const INLINE_SPECIAL = /[\\<\[!`*_~@]|:\/\/|www\.|  \n/;

function inline(src, textMode) {
  const prevLinkParenPossible = IST.linkParenPossible;
  IST.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return inlineInner(src, textMode);
  } finally {
    IST.linkParenPossible = prevLinkParenPossible;
  }
}

function inlineInner(src, textMode) {
  // Fast path: no inline construct can start in this source, so it is one
  // plain text run. A construct needs one of \ < [ ! ` * ~ _ , a bare URL
  // (http://, ftp://, www.) or an email (@), or a hard break (two spaces
  // before a newline).
  if (!INLINE_SPECIAL.test(src)) {
    if (IST.inRawBlock) {
      return src;
    }
    const decoded = decodeNumericRefs(src);
    return textMode ? decoded : escapeHtml(decoded);
  }
  // The emphasis mask is built lazily: many sources hold a `*`, `_` or `~`
  // that never becomes an emphasis attempt (inside a link or a code span),
  // and a source with no link, code span, tag, or escaped delimiter needs
  // no masking at all. The mask is always of the full source; the loop
  // below shortens `src`, so the full text is kept apart.
  const fullSrc = src;
  let maskCache = null;
  const getMask = () => {
    if (!maskCache) {
      const masked = (fullSrc.includes('[') || fullSrc.includes('`') || fullSrc.includes('<')
        || fullSrc.includes('\\*') || fullSrc.includes('\\_') || fullSrc.includes('\\~'))
        ? maskSrc(fullSrc) : fullSrc;
      maskCache = { masked, scan: scanClosers(masked) };
    }
    return maskCache;
  };
  let out = '';
  let prevChar = '';
  let keepPrevChar = false;
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    if (!keepPrevChar) {
      prevChar = '';
    }
    keepPrevChar = false;
    let m;
    // Dispatch on the first character: only the tokenizers that can start
    // with it are tried, in marked's order among those.
    const c0 = src.charCodeAt(0);

    if (c0 === 92) {
      // Backslash: escape, then the backslash hard break.
      if ((m = I_ESCAPE.exec(src))) {
        src = src.substring(m[0].length);
        out += textMode ? m[1] : escapeHtml(m[1]);
        continue;
      }
      if ((m = I_BR.exec(src))) {
        src = src.substring(m[0].length);
        out += textMode ? '' : '<br>';
        continue;
      }
    } else if (c0 === 60) {
      // <: raw HTML tag, then autolink.
      if ((m = I_TAG.exec(src))) {
        if (!IST.inLink && O.startATag.test(m[0])) {
          IST.inLink = true;
        } else if (IST.inLink && O.endATag.test(m[0])) {
          IST.inLink = false;
        }
        if (!IST.inRawBlock && O.startPreScriptTag.test(m[0])) {
          IST.inRawBlock = true;
        } else if (IST.inRawBlock && O.endPreScriptTag.test(m[0])) {
          IST.inRawBlock = false;
        }
        src = src.substring(m[0].length);
        out += m[0];
        continue;
      }
      if ((m = tokAutolink(src, textMode))) {
        src = src.substring(m.raw.length);
        out += m.html;
        continue;
      }
    } else if (c0 === 91 || c0 === 33) {
      // [ or !: inline link or image, then reference link.
      if ((m = tokLink(src, textMode))) {
        src = src.substring(m.raw.length);
        out += m.html;
        continue;
      }
      if ((m = tokReflink(src, textMode))) {
        src = src.substring(m.raw.length);
        out += m.html;
        continue;
      }
    } else if (c0 === 42 || c0 === 95) {
      // * or _: emphasis and strong.
      if ((m = tokEmStrong(src, getMask, prevChar, textMode))) {
        src = src.substring(m.raw.length);
        out += m.html;
        continue;
      }
      // `_` can also start an email local part.
      if (c0 === 95 && !IST.inLink && urlStart(src) && (m = tokUrl(src, textMode))) {
        src = src.substring(m.raw.length);
        out += m.html;
        continue;
      }
    } else if (c0 === 96) {
      // `: code span.
      if ((m = tokCodespan(src, textMode))) {
        src = src.substring(m.raw.length);
        out += m.html;
        continue;
      }
    } else if (c0 === 126) {
      // ~: strikethrough.
      if ((m = tokDel(src, getMask, prevChar, textMode))) {
        src = src.substring(m.raw.length);
        out += m.html;
        continue;
      }
    } else if (c0 === 32) {
      // Space: the hard break of two or more spaces before a newline.
      if ((m = I_BR.exec(src))) {
        src = src.substring(m[0].length);
        out += textMode ? '' : '<br>';
        continue;
      }
    } else if (!IST.inLink && isUrlStartChar(c0) && urlStart(src)) {
      // GFM extended autolink (bare URL, www., email), never inside a link.
      if ((m = tokUrl(src, textMode))) {
        src = src.substring(m.raw.length);
        out += m.html;
        continue;
      }
    }

    // Plain text run, up to the next construct. Inside a raw block the text
    // keeps whatever it was written with; elsewhere a numeric character
    // reference stands for the character itself. Most runs hold no
    // character that needs escaping, so they are appended as-is.
    {
      const end = textEnd(src);
      const text = src.slice(0, end);
      src = src.substring(end);
      if (text.slice(-1) !== '_') {
        prevChar = text.slice(-1);
      }
      keepPrevChar = true;
      if (IST.inRawBlock || !TEXT_ESCAPABLE.test(text)) {
        out += text;
      } else {
        out += escapeHtml(decodeNumericRefs(text));
      }
      continue;
    }
  }
  return out;
}

// Index just past the plain-text run starting at the beginning of `src`.
// Mirrors the text regex: the first character is a run of backticks, a run
// of tildes, or a single other character, and the run ends before the next
// character that can start an inline construct. A tight character loop is
// far cheaper than the lookaheads the regex carried; stopping early only
// costs an extra loop turn, which then falls back to text again.
function textEnd(src) {
  const len = src.length;
  let i;
  const c0 = src.charCodeAt(0);
  if (c0 === 96 || c0 === 126) {
    // A backtick or tilde run is the first character.
    i = 1;
    while (i < len && src.charCodeAt(i) === c0) {
      i++;
    }
  } else {
    i = 1;
  }
  while (i < len) {
    const c = src.charCodeAt(i);
    // \ < [ ! ` * ~ _ : always a construct start.
    if (c === 92 || c === 60 || c === 91 || c === 33 || c === 96 || c === 42
      || c === 126 || c === 95) {
      return i;
    }
    if (c === 32) {
      // Hard break: two or more spaces before a newline.
      let j = i + 1;
      while (j < len && src.charCodeAt(j) === 32) {
        j++;
      }
      if (j - i >= 2 && src.charCodeAt(j) === 10) {
        return i;
      }
      i = j;
      continue;
    }
    if (c === 64) {
      // @: possibly an email. Find the local-part start; stop before it
      // when there is text before it in this run. When the local part
      // starts at the run start the URL check already ran and failed, so
      // it is plain text and scanning continues past the @.
      let k = i - 1;
      while (k > 0 && isEmailLocalChar(src.charCodeAt(k))) {
        k--;
      }
      if (!isEmailLocalChar(src.charCodeAt(k))) {
        k++;
      }
      if (k > 0) {
        return k;
      }
      i++;
      continue;
    }
    if (c === 104 || c === 72) {
      // h/H: http:// or https://
      let j = i + 1;
      if (lowerAt(src, j) === 116 && lowerAt(src, j + 1) === 116
        && lowerAt(src, j + 2) === 112) {
        j += 3;
        if (lowerAt(src, j) === 115) {
          j++;
        }
        if (src.charCodeAt(j) === 58 && src.charCodeAt(j + 1) === 47
          && src.charCodeAt(j + 2) === 47) {
          return i;
        }
      }
      i++;
      continue;
    }
    if (c === 102 || c === 70) {
      // f/F: ftp://
      if (lowerAt(src, i + 1) === 116 && lowerAt(src, i + 2) === 112
        && src.charCodeAt(i + 3) === 58 && src.charCodeAt(i + 4) === 47
        && src.charCodeAt(i + 5) === 47) {
        return i;
      }
      i++;
      continue;
    }
    if (c === 119 || c === 87) {
      // w/W: www.
      if (lowerAt(src, i + 1) === 119 && lowerAt(src, i + 2) === 119
        && src.charCodeAt(i + 3) === 46) {
        return i;
      }
      i++;
      continue;
    }
    if (c === 109 || c === 77) {
      // m/M: mailto:
      if (lowerAt(src, i + 1) === 97 && lowerAt(src, i + 2) === 105
        && lowerAt(src, i + 3) === 108 && lowerAt(src, i + 4) === 116
        && lowerAt(src, i + 5) === 111 && src.charCodeAt(i + 6) === 58) {
        return i;
      }
      i++;
      continue;
    }
    if (c === 120 || c === 88) {
      // x/X: xmpp:
      if (lowerAt(src, i + 1) === 109 && lowerAt(src, i + 2) === 112
        && lowerAt(src, i + 3) === 112 && src.charCodeAt(i + 4) === 58) {
        return i;
      }
      i++;
      continue;
    }
    i++;
  }
  return len;
}

function isWordChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
}

// Lowercase ASCII letter code at `src[i]`, or the code itself.
function lowerAt(src, i) {
  const c = src.charCodeAt(i);
  return c >= 65 && c <= 90 ? c + 32 : c;
}

// A character of an email local part: [A-Za-z0-9.!#$%&'*+/=?^_`{|}~-].
function isEmailLocalChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)
    || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38
    || c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63
    || c === 94 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126
    || c === 45 || c === 95;
}

// The Unicode code point immediately before index `i` of `str`, as a
// string (a surrogate pair when the character is astral, else one unit).
function charBefore(str, i) {
  if (i <= 0) {
    return '';
  }
  const lo = str.charCodeAt(i - 1);
  if (lo >= 0xDC00 && lo <= 0xDFFF && i >= 2) {
    const hi = str.charCodeAt(i - 2);
    if (hi >= 0xD800 && hi <= 0xDBFF) {
      return str.slice(i - 2, i);
    }
  }
  return str[i - 1];
}

// A character that needs escaping in text, or that can start a character
// reference. A text run holding none of these is output as-is.
const TEXT_ESCAPABLE = /[&<>"']/;

// A bare URL or email can start with a letter, a digit, or . + -
// (the email local part). `_` is handled with emphasis above.
function isUrlStartChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)
    || c === 46 || c === 43 || c === 45;
}

// Does the source plausibly start with a bare URL (http://, https://,
// ftp://, www., mailto:, xmpp:) or an email (an @ in the first word)?
// A cheap guard so the URL regex is only run when it might match.
function urlStart(src) {
  const c0 = src.charCodeAt(0);
  if (c0 === 104 || c0 === 72) {
    if (src.slice(0, 5).toLowerCase().startsWith('http')) return true;
  } else if (c0 === 102 || c0 === 70) {
    if (src.slice(0, 4).toLowerCase() === 'ftp:') return true;
  } else if (c0 === 119 || c0 === 87) {
    if (src.slice(0, 4).toLowerCase() === 'www.') return true;
  } else if (c0 === 109 || c0 === 77) {
    if (src.slice(0, 7).toLowerCase() === 'mailto:') return true;
  } else if (c0 === 120 || c0 === 88) {
    if (src.slice(0, 5).toLowerCase() === 'xmpp:') return true;
  }
  const limit = Math.min(src.length, 512);
  for (let i = 1; i < limit; i++) {
    const ch = src.charCodeAt(i);
    if (ch === 64) return true;
    if (ch === 32 || ch === 10 || ch === 9 || ch === 60 || ch === 13) return false;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

// A block-level inline run: an inline `<pre>`, `<code>`, `<kbd>` or
// `<script>` left open ends with the block holding it, so the raw-block
// state is cleared before each block's inline content is rendered.
function inlineBlock(src) {
  IST.inRawBlock = false;
  return inline(src, false);
}

// Render `markdown` to HTML, exactly as marked 18.1.3 does with its
// default options.
export function parse(markdown) {
  const src = markdown.replace(O.carriageReturn, '\n');
  links = Object.create(null);
  linkCount = 0;
  IST.inLink = false;
  IST.inRawBlock = false;
  IST.linkEmitted = false;
  IST.linkParenPossible = true;
  const nodes = [];
  blockLoop(src, nodes, true, false);
  return renderBlocks(nodes);
}
