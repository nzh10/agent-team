import { describe, it, expect } from "vitest";
import { prepareSource } from "../src/chat/mdSource";

const text = (md: string) => prepareSource(md).text;
const unchanged = (md: string) =>
  expect(prepareSource(md), md).toEqual({ text: md, hasMath: false });

describe("math in the source", () => {
  it("turns a $…$ pair that reads as math into inline math", () => {
    expect(prepareSource("area $\\pi r^2$ here")).toEqual({
      text: "area $$\\pi r^2$$ here",
      hasMath: true,
    });
    for (const [src, out] of [
      ["$x$", "$$x$$"],
      ["$a + b$ and $O(n log n)$", "$$a + b$$ and $$O(n log n)$$"],
      ["长度为$n$的数组", "长度为$$n$$的数组"],
      ["SiO$_2$ at 25$^\\circ$C", "SiO$$_2$$ at 25$$^\\circ$$C"],
      ["0.20$\\sim$0.25 cm$^3$/g", "0.20$$\\sim$$0.25 cm$$^3$$/g"],
      ["H$_2$O and (x+1)$^2$ at 30$\\mu$m", "H$$_2$$O and (x+1)$$^2$$ at 30$$\\mu$$m"],
      ["$\\{1, 2\\}$ and $x^{n+1}$", "$$\\{1, 2\\}$$ and $$x^{n+1}$$"],
    ]) {
      expect(text(src), src).toBe(out);
    }
  });

  // Real replies: most $…$ pairs are not math.
  it("leaves prices, shell variables, templates and identifiers as text", () => {
    unchanged("costs $5 and $10");
    unchanged("set $HOME and $PATH");
    unchanged("path: $T/$d/.clice");
    unchanged('rewrite it as "${T:?}"/"${d:?}"');
    unchanged('{"$ref": "#/$defs/Node"}');
    unchanged(".debug$S section while keeping .debug$T");
    unchanged("现有的 $() 和 @[] 语法都有问题($ 用于变量)");
    unchanged('write "$x$" for inline math');
    unchanged("${a} and ${b}");
    unchanged("hash(${pkg.version}_${nodeVersion}_${x})");
    unchanged('NF==1 && $0 ~ /^[0-9]+\\t[0-9]+\\t/ { split($0, t, "\\t");');
    unchanged("NF==1 && $0 ~ /^[0-9]+\\t[0-9]+\\t/ { split($0, t, sep);");
    unchanged("NF==1 && $0 ~ /^[0-9]+/ && $1 == 2");
    unchanged("awk '{ if ($0 ~ /^[0-9]+$/) print $1 }'");
    unchanged("($0 ~ /[0-9]+$/) and ($0 ~ /a_b$/)");
    unchanged("echo $a_1+$b_2 and $HOME/foo_bar/$USER");
    unchanged("echo $_/$1 and a$_/$1 and foo$\\d+$1");
    unchanged("unbalanced $a^{2$ and $x_{1$ and $\\frac{1}{$");
  });

  it("takes a formula whose CJK text is all in \\text{…}, escaping that text's underscores", () => {
    const md = [
      "*   原来需要：$\\text{模型数} \\times (8\\text{ Prologue} \\times \\text{split_k} + 14\\text{ Mega}) = \\text{几百上千个实例}$；",
      "*   **精简后只需要**：**$3\\text{ 个 Prologue} + 4\\text{ 个 Mega} = 7\\text{ 个实例}$**（最多十几个）",
    ].join("\n");
    expect(prepareSource(md)).toEqual({
      text: [
        "*   原来需要：$$\\text{模型数} \\times (8\\text{ Prologue} \\times \\text{split\\_k} + 14\\text{ Mega}) = \\text{几百上千个实例}$$；",
        "*   **精简后只需要**：**$$3\\text{ 个 Prologue} + 4\\text{ 个 Mega} = 7\\text{ 个实例}$$**（最多十几个）",
      ].join("\n"),
      hasMath: true,
    });
    expect(text("so \\(\\text{a_b} + \\mathrm{x_1} + \\text{c\\_d}\\) holds")).toBe(
      "so $$\\text{a\\_b} + \\mathrm{x_1} + \\text{c\\_d}$$ holds",
    );
    // CJK outside such text is still prose.
    unchanged("$\\alpha 是角度$");
    unchanged("$5 到 $10 之间，\\text{两边}都有");
  });

  it("rewrites \\( \\) inline and a lone \\[ \\] line as a display block", () => {
    expect(text("so \\(a_1\\) holds")).toBe("so $$a_1$$ holds");
    expect(text("- sum:\n  \\[ \\sum_i x_i \\]\n")).toBe("- sum:\n  $$\n  \\sum_i x_i\n  $$\n");
    expect(text("\\[\nE = mc^2\n\\]")).toBe("$$\nE = mc^2\n$$");
  });

  it("distinguishes escaped regex groups and quoted syntax from inline TeX", () => {
    for (const s of [
      String.raw`Key\(word\) and id_\(x\)`,
      String.raw`\s*\(x\)`,
      String.raw`\(([^)]+)\) and \([x)\)`,
      String.raw`\(a_{1\) and \((x\)`,
      String.raw`\((?:a|b)\) and \([-\d.]\)`,
      String.raw`\(\d\) \(\D\) \(\s\) \(\S\) \(\w\) \(\W\)`,
      String.raw`write "\(x\)" or “\(x\)” or use /\(x\)/`,
      String.raw`Use /\(x\)+/g or /\(x\){2,5}?/g`,
      String.raw`\s*\(x\)*`,
      String.raw`\(中文\) and \(\(x`,
    ])
      unchanged(s);
    for (const [src, expected] of [
      [String.raw`长度为\(n\)`, "长度为$$n$$"],
      [String.raw`\(a_1 + b_2\)`, "$$a_1 + b_2$$"],
      [String.raw`\(O(n \log n)\)`, String.raw`$$O(n \log n)$$`],
      [String.raw`\(\text{中文}\)`, String.raw`$$\text{中文}$$`],
      [String.raw`**\(x = 1\) holds**`, "**$$x = 1$$ holds**"],
      [String.raw`_\(x = 1\) holds_`, "_$$x = 1$$ holds_"],
      [String.raw`区间为\(\left[0,1\right)\)`, String.raw`区间为$$\left[0,1\right)$$`],
      [String.raw`\(x \in (0,1]\)`, String.raw`$$x \in (0,1]$$`],
      [String.raw`\(x \in ]0,1[\)`, String.raw`$$x \in ]0,1[$$`],
      [
        String.raw`\(\begin{matrix}a\\d\end{matrix}\)`,
        String.raw`$$\begin{matrix}a\\d\end{matrix}$$`,
      ],
      [
        String.raw`\(\begin{matrix}a\\(b)\end{matrix}\)`,
        String.raw`$$\begin{matrix}a\\(b)\end{matrix}$$`,
      ],
      [
        String.raw`\(\begin{matrix}(a\\)b\end{matrix}\)`,
        String.raw`$$\begin{matrix}(a\\)b\end{matrix}$$`,
      ],
      [String.raw`\(\text{中文 \textbf{a_b}}\)`, String.raw`$$\text{中文 \textbf{a\_b}}$$`],
      [String.raw`\(\sqrt{x} + \sin x\)`, String.raw`$$\sqrt{x} + \sin x$$`],
    ])
      expect(prepareSource(src), src).toEqual({ text: expected, hasMath: true });
  });

  it("keeps subscripts inside a text argument's embedded math", () => {
    for (const formula of [
      String.raw`\text{first_item \(x_{i}\) last_item}`,
      String.raw`\text{first_item $x_{i}$ last_item}`,
    ]) {
      expect(text(`$$${formula}$$`)).toBe(
        `$$\n${formula.replaceAll("_item", String.raw`\_item`)}\n$$`,
      );
    }
  });

  it("keeps literal double-dollar ellipses as prose, not math", () => {
    expect(prepareSource("write $$...$$ or $$…$$ then $x$")).toEqual({
      text: String.raw`write \$\$...\$\$ or \$\$…\$\$ then $$x$$`,
      hasMath: true,
    });
    expect(prepareSource("$$\n...\n$$").hasMath).toBe(false);
    expect(prepareSource(String.raw`$$\ldots$$`).hasMath).toBe(true);
  });

  it("puts display fences on lines of their own", () => {
    expect(text("$$x^2$$")).toBe("$$\nx^2\n$$");
    expect(text("$$\\begin{aligned}\na &= b\n\\end{aligned}$$\n\nAfter.")).toBe(
      "$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$\n\nAfter.",
    );
    expect(text("$$x = 1 \\\\\ny = 2\n$$")).toBe("$$\nx = 1 \\\\\ny = 2\n$$");
    expect(text("$$\na\n\nb\n$$")).toBe("$$\na\n\nb\n$$");
    expect(text("a $$x^2$$ b")).toBe("a $$x^2$$ b");
  });

  it("escapes an unpaired $$ so it cannot swallow the rest of the reply", () => {
    expect(text("$$ some text\n\nlater $x$")).toBe("\\$\\$ some text\n\nlater $$x$$");
  });

  it("keeps escaped brackets that are not TeX", () => {
    unchanged("*\\[interrupted\\]* and a\\[0\\]");
  });

  it("does not touch code", () => {
    unchanged("run `echo $a$b` then\n\n```sh\necho $x$ \\(y\\)\n```\n");
    unchanged("> ~~~\n> echo $a$b\n> ~~~");
    unchanged("~~~sh\r\necho $a$b\r\n~~~\r\n");
    // An unmatched backtick does not reach past its paragraph.
    expect(text("It`s $x$ fine\n\nand `code $a$b`")).toBe("It`s $$x$$ fine\n\nand `code $a$b`");
  });

  it("reports a ```math fence as math", () => {
    expect(prepareSource("```math\nE=mc^2\n```").hasMath).toBe(true);
  });

  it("does not throw on truncated input", () => {
    for (const s of [
      "\\",
      "$",
      "$$",
      "`",
      "```",
      "\\[",
      "\\(",
      "$a",
      "$$a",
      "\\[a",
      "a\\",
      "$\\",
    ]) {
      expect(() => prepareSource(s)).not.toThrow();
    }
  });
});

describe("bare URLs in the source", () => {
  it("ends a bare URL where Chinese text begins, as an explicit autolink", () => {
    expect(text("见 https://github.com/a/b，然后看")).toBe("见 <https://github.com/a/b>，然后看");
    expect(text("https://x.com/path的说明")).toBe("<https://x.com/path>的说明");
    expect(text("访问https://x.com/a.。好")).toBe("访问<https://x.com/a>.。好");
    expect(text("www.example.com。下一句")).toBe(
      "[www.example.com](http://www.example.com)。下一句",
    );
    expect(text("https://a.com，https://b.com/x。")).toBe("<https://a.com>，<https://b.com/x>。");
  });

  it("keeps emphasis around the URL paired", () => {
    expect(text("链接：**https://x.com/a**，然后看")).toBe("链接：**<https://x.com/a>**，然后看");
    expect(text("**http://localhost:5173/a**(状态 200)")).toBe(
      "**<http://localhost:5173/a>**(状态 200)",
    );
  });

  it("stops at curly quotes, dashes and ellipses", () => {
    expect(text("见“https://x.com/a”，然后")).toBe("见“<https://x.com/a>”，然后");
    expect(text("https://x.com/a——然后")).toBe("<https://x.com/a>——然后");
  });

  it("never takes $ inside a URL for math", () => {
    unchanged("GET https://graph.microsoft.com/v1.0/me/messages?$select=subject&$top=5 now");
    unchanged("see [docs](https://example.com/$v$/x)");
  });

  it("leaves links that spell out their extent", () => {
    unchanged("<https://zh.wikipedia.org/wiki/中文> 和 [中文](https://zh.wikipedia.org/wiki/中文)");
    unchanged("plain https://x.com/a, then");
  });
});

describe("cost", () => {
  const time = (md: string) => {
    const t = performance.now();
    prepareSource(md);
    return performance.now() - t;
  };

  it("stays linear on adversarial text", () => {
    for (const md of [
      "\\(a ".repeat(20_000),
      "\\(a ".repeat(20_000) + "[^x]\\)",
      String.raw`\(\text{中文 ${"{".repeat(10_000)}x${"}".repeat(10_000)}}\)`,
      String.raw`\(${String.raw`\\(x\\)`.repeat(10_000)}\)`,
      "$a ".repeat(12_000),
      "$$x$$\n".repeat(20_000),
      "``a ```b ````c ".repeat(20_000),
      "$$a$$ b\n".repeat(20_000),
      "https://x.com/中".repeat(10_000),
    ]) {
      expect(time(md), md.slice(0, 12)).toBeLessThan(300);
    }
  });
});
