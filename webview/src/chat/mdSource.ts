// A reply's markdown source is rewritten before parsing, outside code spans
// and fences, for two things plain GFM gets wrong in agent output.
//
// Math. remark-math runs with single-dollar math off, so a lone $ is always
// text; what agents write is turned into what it parses. $$…$$ and \[…\]
// starting a line become a display block with the $$ fences on lines of
// their own (remark-math reads TeX after an opening fence as meta and drops
// it), \(…\) and a $…$ pair that reads as math become $$…$$ inline math.
// Over real replies most $…$ pairs are not math (shell variables, JSON
// $ref, .debug$S), so a pair without TeX markup must stand apart from
// letters and digits and read like a formula; a pair holding CJK text or
// quotes is never math, unless they are all in the text a command such as
// \text{…} takes ("$7\text{ 个实例}$"). An underscore in that text, an
// error to TeX and KaTeX alike, is escaped ("\text{split_k}").
//
// Bare URLs. GFM ends one only at whitespace or "<", so in Chinese prose
// ("见 https://x.com/a，然后…") the link swallows the rest of the sentence.
// A bare URL ends at the first CJK character, full-width or curly
// punctuation and is written as an explicit <…> autolink, so emphasis
// around it still pairs up. Nothing inside a URL is taken for math.
//
// Every search is bounded or cached: this runs on each streamed frame.

const FENCE = /^([ \t>]*)(`{3,}|~{3,})(.*?)\r?$/;
const FENCE_CLOSE = /^[ \t>]*(`{3,}|~{3,})[ \t]*\r?$/;
const CJK =
  /[\u2014\u2018\u2019\u201C\u201D\u2026\u2E80-\u2FFF\u3000-\u303F\u3040-\u30FF\u3100-\u31FF\u3200-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;
// \[…\] also escapes brackets in plain text ("\[interrupted\]"): only
// something that reads as TeX is taken for math.
const TEXISH = /[\\^_{}=]/;
const TEX_MARKUP = /[\\^_]/;
const NEVER_MATH = new RegExp(`${CJK.source}|["\`]`);
const TEXT_ARG = /\\(?:text(?:rm|bf|it|tt|sf|normal)?|mbox|mathrm|operatorname)\s*\{/y;
const TEXT_MODE_ARG = /\\(?:text(?:rm|bf|it|tt|sf|normal)?|mbox)\s*\{/y;
const SIZED_DELIMITER = /\\(left|right)\s*(?:\\(?:[A-Za-z]+|[^\n])|[()[\].<>|/])/y;
const REGEX_LITERAL_END = /(?:[*+?]|\{\d+(?:,\d*)?\})?\??\//y;
const ALNUM = /[A-Za-z0-9]/;
const REGEX_ESCAPE = /\\(?:[dDsSwW](?![A-Za-z])|[1-9])/y;
const LITERAL_ELLIPSIS = /^(?:\.{3,}|…+)$/;
const URL_START = /^(?:https?:\/\/|www\.)/i;
const URL_END = /[\s<>]/;
const QUICK = /[$\\]|https?:\/\/|www\.|^[ \t>]*(`{3,}|~{3,})[ \t]*math/im;

export interface PreparedSource {
  text: string;
  hasMath: boolean;
}

// Line geometry, computed once per text.
class Lines {
  starts: number[] = [0];
  firstText: number[] = [];
  lastText: number[] = [];
  nextBlank: number[] = [];
  constructor(private md: string) {
    for (let i = 0; i < md.length; i++) if (md[i] === "\n") this.starts.push(i + 1);
    const count = this.starts.length;
    for (let l = 0; l < count; l++) {
      const end = this.end(l);
      let a = this.starts[l];
      while (a < end && /\s/.test(md[a])) a++;
      let b = end - 1;
      while (b >= a && /\s/.test(md[b])) b--;
      this.firstText.push(a);
      this.lastText.push(b);
    }
    let next = count;
    this.nextBlank = new Array<number>(count);
    for (let l = count - 1; l >= 0; l--) {
      this.nextBlank[l] = next;
      if (this.lastText[l] < this.firstText[l]) next = l;
    }
  }
  of(pos: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  end(line: number): number {
    return line + 1 < this.starts.length ? this.starts[line + 1] - 1 : this.md.length;
  }
  // Where the paragraph holding `pos` ends: its next blank line.
  paragraphEnd(pos: number): number {
    const blank = this.nextBlank[this.of(pos)];
    return blank < this.starts.length ? this.starts[blank] : this.md.length;
  }
  // The whitespace before `pos` if nothing else precedes it on its line.
  indentBefore(pos: number): string | null {
    const l = this.of(pos);
    return this.firstText[l] >= pos ? this.md.slice(this.starts[l], pos) : null;
  }
  blankFrom(pos: number): boolean {
    return this.lastText[this.of(pos)] < pos;
  }
}

// Next occurrence of `needle` at or after a position; cached, so increasing
// queries scan the text once.
function finder(md: string, needle: string, skipEscaped = false) {
  let from = Infinity;
  let found = Infinity;
  return (pos: number): number => {
    if (from <= pos && found >= pos) return found;
    from = pos;
    let at = md.indexOf(needle, pos);
    while (skipEscaped && at >= 0) {
      let start = at;
      while (md[start - 1] === "\\") start--;
      if ((at - start) % 2 === 0) break;
      at = md.indexOf(needle, at + needle.length);
    }
    found = at < 0 ? Infinity : at;
    return found;
  };
}

export function prepareSource(md: string): PreparedSource {
  if (!QUICK.test(md)) return { text: md, hasMath: false };
  const n = md.length;
  const lines = new Lines(md);
  const nextParen = finder(md, "\\)", true);
  const nextParenOpen = finder(md, "\\(", true);
  const nextBracket = finder(md, "\\]");
  const nextDouble = finder(md, "$$");
  const runFinders = new Map<number, (pos: number) => number>();
  let out = "";
  let hasMath = false;
  let i = 0;

  const display = (body: string, indent: string) =>
    `$$\n${indent}${textMode(body.trim())}\n${indent}$$`;

  // The closing run of a code span opened by `len` backticks, or -1.
  const codeSpanClose = (from: number, len: number, limit: number): number => {
    let find = runFinders.get(len);
    if (!find) runFinders.set(len, (find = finder(md, "`".repeat(len))));
    for (let s = find(from); s < limit;) {
      let e = s;
      while (md[e] === "`") e++;
      if (md[s - 1] !== "`" && e - s === len) return s;
      s = find(e);
    }
    return -1;
  };

  // A display block opened by $$ at the start of a line: closed by the first
  // $$ that ends a line. One opened by $$ alone on its line may hold blank
  // lines; otherwise it stays in its paragraph and stops at the next line
  // that opens another $$.
  const displayClose = (open: number): number => {
    const limit = lines.blankFrom(open + 2) ? n : lines.paragraphEnd(open);
    for (let s = nextDouble(open + 2); s < limit; s = nextDouble(s + 2)) {
      if (lines.blankFrom(s + 2)) return s;
      if (lines.indentBefore(s) !== null) return -1;
    }
    return -1;
  };

  while (i < n) {
    if (i === 0 || md[i - 1] === "\n") {
      const l = lines.of(i);
      const fence = FENCE.exec(md.slice(i, lines.end(l)));
      if (fence && !(fence[2][0] === "`" && fence[3].includes("`"))) {
        if (/^math\b/i.test(fence[3].trim())) hasMath = true;
        let close = n;
        for (let k = l + 1; k < lines.starts.length; k++) {
          const m = FENCE_CLOSE.exec(md.slice(lines.starts[k], lines.end(k)));
          if (m && m[1][0] === fence[2][0] && m[1].length >= fence[2].length) {
            close = lines.end(k);
            break;
          }
        }
        out += md.slice(i, close);
        i = close;
        continue;
      }
    }

    const ch = md[i];

    if (ch === "`") {
      let k = i;
      while (md[k] === "`") k++;
      const close = codeSpanClose(k, k - i, lines.paragraphEnd(i));
      const upto = close >= 0 ? close + (k - i) : k;
      out += md.slice(i, upto);
      i = upto;
      continue;
    }

    if (ch === "\\") {
      const next = md[i + 1];
      if (next === "(" || next === "[") {
        const end = next === "(" ? nextParen(i + 2) : nextBracket(i + 2);
        const limit = next === "(" ? lines.end(lines.of(i)) : lines.paragraphEnd(i);
        // A nested opener is not inline TeX. Stop before slicing so a run
        // of rejected openers cannot repeatedly validate the same suffix.
        const body =
          end < limit && (next === "[" || end < nextParenOpen(i + 2)) ? md.slice(i + 2, end) : "";
        if (body.trim() && (next === "(" ? parenMath(md, i, end, body) : TEXISH.test(body))) {
          const after = end + 2;
          const indent = next === "[" ? lines.indentBefore(i) : null;
          if (indent !== null && lines.blankFrom(after)) {
            hasMath = true;
            out += display(body, indent);
            i = after;
            continue;
          }
          if (!body.includes("\n")) {
            hasMath = true;
            out += `$$${textMode(body.trim())}$$`;
            i = after;
            continue;
          }
        }
      }
      out += md.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (ch === "$" && md[i + 1] === "$") {
      const indent = lines.indentBefore(i);
      const close = indent !== null ? displayClose(i) : -1;
      const displayBody = close < 0 ? "" : md.slice(i + 2, close).trim();
      if (LITERAL_ELLIPSIS.test(displayBody)) {
        out += `\\$\\$${md.slice(i + 2, close)}\\$\\$`;
        i = close + 2;
        continue;
      }
      if (displayBody) {
        hasMath = true;
        out += display(displayBody, indent!);
        i = close + 2;
        continue;
      }
      const end = nextDouble(i + 2);
      const body = end < lines.paragraphEnd(i) ? md.slice(i + 2, end) : "";
      if (LITERAL_ELLIPSIS.test(body.trim())) {
        out += `\\$\\$${body}\\$\\$`;
        i = end + 2;
        continue;
      }
      if (body.trim() && !neverMath(body)) {
        hasMath = true;
        out += `$$${textMode(body)}$$`;
        i = end + 2;
        continue;
      }
      // Unpaired: escaped, or remark-math would open a block that runs to
      // the end of the message.
      out += "\\$\\$";
      i += 2;
      continue;
    }

    if (ch === "$") {
      const close = inlineClose(md, i);
      if (close >= 0) {
        hasMath = true;
        out += `$$${textMode(md.slice(i + 1, close))}$$`;
        i = close + 1;
        continue;
      }
    }

    if (
      (ch === "h" || ch === "H" || ch === "w" || ch === "W") &&
      !ALNUM.test(md[i - 1] ?? "") &&
      URL_START.test(md.slice(i, i + 8))
    ) {
      // <…> and [text](…) spell out their extent.
      const spelledOut = md[i - 1] === "<" || md.slice(i - 2, i) === "](";
      let j = i;
      while (j < n && !URL_END.test(md[j]) && (spelledOut || !CJK.test(md[j]))) j++;
      if (spelledOut || j >= n || !CJK.test(md[j])) {
        out += md.slice(i, j);
        i = j;
        continue;
      }
      const url = trimTrailing(md.slice(i, j));
      const host = url.replace(URL_START, "");
      if (host && !/^[./]/.test(host)) {
        out += /^www\./i.test(url) ? `[${url}](http://${url})` : `<${url}>`;
        i += url.length;
      } else {
        out += md.slice(i, j);
        i = j;
      }
      continue;
    }

    out += ch;
    i++;
  }
  return { text: out, hasMath };
}

// The closing $ of an inline pair opened at `open`, or -1. The body ends at
// the first unescaped $ on the line; a code span or line end means no pair.
function inlineClose(md: string, open: number): number {
  if (md[open + 1] === undefined || /\s/.test(md[open + 1])) return -1;
  let j = open + 1;
  while (j < md.length && md[j] !== "$" && md[j] !== "\n" && md[j] !== "`") {
    j += md[j] === "\\" ? 2 : 1;
  }
  if (md[j] !== "$" || md[j + 1] === "$" || /\s/.test(md[j - 1])) return -1;
  const body = md.slice(open + 1, j);
  if (neverMath(body) || !balancedBraces(body)) return -1;
  const before = md[open - 1] ?? "";
  const after = md[j + 1] ?? "";
  // "$x$" quoted is talking about the syntax.
  if ((before === "'" || before === '"') && after === before) return -1;
  // "${name}" is a template placeholder, not TeX.
  if (body[0] === "{" && !body.includes("\\")) return -1;
  // Awk regex match `~ /.../` paired across `$0` and trailing `$/`.
  if (/~\s*\//.test(body)) return -1;
  const attachedLeft = ALNUM.test(before) || (before === "_" && after !== "_");
  const attachedRight = ALNUM.test(after) || (after === "_" && before !== "_");
  if (attachedLeft || attachedRight) {
    return attachedTex(body, before) ? j : -1;
  }
  if (TEX_MARKUP.test(body)) {
    // Regex `/^...$/` paired across shell/awk `$0` has `^` right after `/`.
    if (/(?<!\\)\/\^/.test(body)) return -1;
    if (!body.includes("\\") && /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(body)) return -1;
    return j;
  }
  if (/[{}]/.test(body) || /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(body)) return -1;
  return j;
}

// ASCII identifiers and regex quantifiers can be glued to an escaped group;
// CJK prose can be glued to real math. Allow Markdown emphasis around math.
function parenMath(md: string, open: number, close: number, body: string): boolean {
  const before = md[open - 1] ?? "";
  const after = md[close + 2] ?? "";
  if (
    (before === after && (before === "'" || before === '"')) ||
    (before === "“" && after === "”") ||
    (before === "‘" && after === "’")
  )
    return false;
  if (before === "/") {
    REGEX_LITERAL_END.lastIndex = close + 2;
    if (REGEX_LITERAL_END.test(md)) return false;
  }
  const left = md[open - 2] ?? "";
  if (ALNUM.test(before) || (before === "_" && ALNUM.test(left))) return false;
  if (/[*+?]/.test(before) && /[\w.)\]}]/.test(left)) return false;
  if (!balancedBraces(body) || neverMath(body)) return false;

  // Ignore text arguments and escaped glyphs; only math delimiters must pair.
  const math = mapTextArgs(body, TEXT_MODE_ARG, () => "");
  const stack: { kind: string; comma?: boolean }[] = [];
  for (let k = 0; k < math.length; k++) {
    const ch = math[k];
    if (ch === "\\") {
      REGEX_ESCAPE.lastIndex = k;
      if (REGEX_ESCAPE.test(math)) return false;
      SIZED_DELIMITER.lastIndex = k;
      const sized = SIZED_DELIMITER.exec(math);
      if (!sized) k++;
      else {
        if (sized[1] === "left") stack.push({ kind: "left" });
        else if (stack.pop()?.kind !== "left") return false;
        k = SIZED_DELIMITER.lastIndex - 1;
      }
    } else if (ch === "(" && math[k + 1] === "?" && /[:=!<]/.test(math[k + 2] ?? "")) {
      return false;
    } else if (ch === "[" && math[k + 1] === "^") {
      return false;
    } else if (ch === "(" || ch === "[" || ch === ")" || ch === "]" || ch === ",") {
      const top = stack[stack.length - 1];
      if (ch === ",") {
        if (top) top.comma = true;
      } else if (ch === "[" && top?.kind === "]" && top.comma) {
        // Reversed brackets also denote an open interval: ]a,b[.
        stack.pop();
      } else if (ch === "(" || ch === "[" || (ch === "]" && (!top || top.kind === "left"))) {
        stack.push({ kind: ch });
      } else {
        if (!top || top.kind === "left" || (!top.comma && top.kind !== (ch === ")" ? "(" : "[")))
          return false;
        stack.pop();
      }
    }
  }
  return stack.length === 0;
}

function balancedBraces(body: string): boolean {
  let depth = 0;
  for (let k = 0; k < body.length; k++) {
    if (body[k] === "\\") {
      k++;
      continue;
    }
    if (body[k] === "{") depth++;
    else if (body[k] === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

// Inline math glued to letters or digits is either a sub/superscript on a
// preceding base (`SiO$_2$`, `25$^\circ$C`, `(x+1)$^2$`) or a single TeX symbol
// (`0.20$\sim$0.25`, `30$\mu$m`), never a shell/awk `$0`/`$1` across code.
function attachedTex(body: string, before: string): boolean {
  if (body[0] === "^" || body[0] === "_") {
    return (
      body.length > 1 && body[1] !== "/" && (ALNUM.test(before) || before === ")" || before === "]")
    );
  }
  return /^\\(?:[A-Za-z]{2,}|[^A-Za-z0-9\s])$/.test(body);
}

function neverMath(body: string): boolean {
  if (!NEVER_MATH.test(body)) return false;
  return NEVER_MATH.test(mapTextArgs(body, TEXT_ARG, () => ""));
}

function textMode(body: string): string {
  if (!body.includes("_")) return body;
  return mapTextArgs(body, TEXT_MODE_ARG, escapeTextUnderscores);
}

// Text can embed math, which can in turn take text arguments. Track mode
// changes in one pass so only text underscores are escaped, never subscripts.
function escapeTextUnderscores(arg: string): string {
  const modes: ("$" | "\\)" | number)[] = []; // Text frames close at their brace depth.
  let depth = 0;
  let out = "";
  let last = 0;
  for (let i = 0; i < arg.length; i++) {
    const mode = modes[modes.length - 1];
    const inMath = typeof mode === "string";
    const ch = arg[i];
    if (ch === "\\") {
      const next = arg[i + 1];
      if (mode === "\\)" && next === ")") modes.pop();
      else if (!inMath && next === "(") modes.push("\\)");
      else if (inMath) {
        TEXT_MODE_ARG.lastIndex = i;
        if (TEXT_MODE_ARG.test(arg)) {
          modes.push(++depth);
          i = TEXT_MODE_ARG.lastIndex - 1;
          continue;
        }
      }
      i++;
    } else if (ch === "%") i = texCommentEnd(arg, i);
    else if (ch === "{") depth++;
    else if (ch === "}") {
      if (mode === depth) modes.pop();
      depth--;
    } else if (ch === "$") {
      if (mode === "$") modes.pop();
      else if (!inMath) modes.push("$");
    } else if (ch === "_" && !inMath) {
      out += arg.slice(last, i) + "\\_";
      last = i + 1;
    }
  }
  return out + arg.slice(last);
}

function texCommentEnd(body: string, from: number): number {
  const newline = body.indexOf("\n", from);
  return newline < 0 ? body.length : newline;
}

// Text-mode arguments can contain subgroups and nested commands. Walk each
// argument once and leave an incomplete argument alone while it is streaming.
function mapTextArgs(body: string, command: RegExp, replace: (arg: string) => string): string {
  let out = "";
  let last = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "%") i = texCommentEnd(body, i);
    if (body[i] !== "\\") continue;
    command.lastIndex = i;
    if (!command.test(body)) {
      i++;
      continue;
    }
    let depth = 1;
    let j = command.lastIndex;
    for (; j < body.length && depth; j++) {
      if (body[j] === "\\") j++;
      else if (body[j] === "%") j = texCommentEnd(body, j);
      else if (body[j] === "{") depth++;
      else if (body[j] === "}") depth--;
    }
    if (depth) break;
    out += body.slice(last, i) + replace(body.slice(i, j));
    last = j;
    i = j - 1;
  }
  return out + body.slice(last);
}

// GFM's trailing-punctuation rule, re-applied after the cut: "a.，" → "a".
function trimTrailing(url: string): string {
  for (;;) {
    const last = url[url.length - 1];
    if (last && "?!.,:;*_~'\"([{".includes(last)) {
      url = url.slice(0, -1);
    } else if (last === ")" && url.split(")").length > url.split("(").length) {
      url = url.slice(0, -1);
    } else {
      return url;
    }
  }
}
