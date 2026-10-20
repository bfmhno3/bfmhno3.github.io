---
title: "导出、工具链与 CI"
commentId: "post:typst-by-xuan-16-export-and-tooling"
published: "2026-10-19 23:00:00 +08:00"
description: "用 Xuan 从零学 Typst 第 16 篇：我用 Typst 0.15.1 在 tutorial-v1 的干净克隆里跑通 106 个 ok 的 make ci（实测 12.2 秒），用 --pdf-standard a-2b,ua-1、HTML、bundle、typst eval、--timings、--deps 导出并检查了 lab/ch16，用 tinymist 0.15.2 的 LSP 验证了编辑器端的诊断、悬停和格式化，补上模板、测试和 GitHub Actions 工作流，最后列出“Typst 特性 → 第几篇”的索引。"
category: Tutorial
tags:
  - Typst
  - Xuan
  - 工程化
  - CI
  - 导出
series: "用 Xuan 从零学 Typst"
seriesOrder: 16
draft: false
comment: true
slug: typst-by-xuan-16-export-and-tooling
---

在干净克隆里，`nix develop --command make ci` 在我的机器上用了 12.2 秒：检查了所有 `.typ` 的格式，编译了 5 份示例文档、16 章的实验文件和各章 `extra.sh` 里的额外命令、6 个测试文件，一共打印 106 行 `ok`，0 行 `FAIL`。这一篇讲的就是这 12 秒里发生的事，以及我怎么确认“它绿了”这件事是可信的：PDF 的元数据和标准、PNG/SVG/HTML/bundle 几种输出、`typst eval`、`--timings`、`--deps`、测试、格式化、编辑器端的 tinymist、模板、CI。最后把整个系列对一遍。

> [!NOTE] 本篇检查点
> 这一篇结束时，仓库里本篇涉及的文件都已经存在，且都是**最终版**：`lab/ch16/`（含 `extra.sh`）、`tests/` 下的 6 个文件、`packages/local/xuan/0.1.0/template/main.typ`、`.github/workflows/ci.yml`、`README.md`、`Makefile` 里的 `test`/`fmt`/`fmt-check`/`install`/`ci` 几个目标。`lib.typ`、`src/base.typ`、`src/note.typ` 在前面的篇章里已经加完，这一篇没有再改它们。`make ch16` 和 `make ci` 通过。
> 前置：[第 15 篇](/posts/typst-by-xuan-15-wasm-plugin/)（Rust 插件和术语表；这一篇的测试和 CI 都要用到它产出的 `.wasm`）。如果你一路跟着写，到这里 `git diff tutorial-v1 --stat` 应该什么也不打印，文末有这个检查。

## 先看结果：干净克隆里的 make ci

我先把标签克隆到一个全新的目录里，再跑一遍：

```bash
git clone --branch tutorial-v1 https://github.com/bfmhno3/typst-lab.git /tmp/lab16
cd /tmp/lab16
( time nix develop --command make ci ) > /tmp/ci.log 2>&1
```

（我克隆的是本机仓库的同一个标签，读者用上面的 GitHub 地址。`@preview` 缓存在我这台机器上是热的，第 14 篇的包不需要重新下载，后面 CI 一节会谈冷缓存。）

```text
$ grep -c '^ok ' /tmp/ci.log
106
$ grep -c FAIL /tmp/ci.log
0
$ grep '^real' /tmp/ci.log
real	0m12.222s
```

`/tmp/ci.log` 里本篇的那一章是这样的：

```text
./scripts/chapter.sh ch16
ok   lab/ch16/eval.typ
ok   lab/ch16/metadata.typ
ok   lab/ch16/pdf-standards.typ
ok   pdf-standards a-2b,ua-1
ok   html
ok   bundle
ok   eval items = 3
ok   eval problems = 4
ok   timings (18842 events)
ok   deps
```

12.2 秒花在哪里？`Makefile` 里决定顺序的是这几行（缩进是制表符）：

```make
ci: fmt-check all

all: examples $(CHAPTERS) test
```

我用 `hyperfine` 单独量了其中几块：

| 步骤 | 命令 | 耗时 |
| --- | --- | --- |
| 格式检查 | `hyperfine -w 2 -N "make fmt-check"` | 22.7 ms ± 1.1 ms |
| 5 份示例 | `hyperfine -w 1 -r 5 "make examples"` | 1.352 s ± 0.015 s |
| 6 个测试 | `hyperfine -w 1 -r 5 "make test"` | 434.5 ms ± 4.2 ms |
| 16 章（含一次 `examples`） | `make ch01 ch02 ... ch16`，单次 | 11.44 s |

剩下的零头是 `nix develop` 进入环境本身（`nix develop --command true` 0.23 s）。结论很直白：测试只占 0.43 s，时间几乎都在编译各章的实验文件。这个比例是我愿意把测试写得多一点的原因，后面“测试”一节会说怎么写。

## document：PDF 元数据从哪来

PDF 的标题、作者、关键词不是排版出来的，是 `document` 这个“设置规则”写进文件信息字典和 XMP 里的。[`lab/ch16/metadata.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch16/metadata.typ)：

```typst
// `document` sets the PDF metadata; the template fills it from `note`.
#set document(
  title: "元数据演示",
  author: ("bfmhno3", "Zhang San"),
  keywords: ("Typst", "PDF"),
  date: datetime(year: 2026, month: 10, day: 19),
)

= 元数据

用 `pdfinfo` 或 `exiftool` 查看这份 PDF 的标题、作者和关键词。
```

`pdfinfo out/ch16/metadata.pdf`（这台机器没有 `exiftool`，我用的是 poppler 的 `pdfinfo`）：

```text
Title:           元数据演示
Keywords:        Typst, PDF
Author:          bfmhno3, Zhang San
Creator:         Typst 0.15.1
CreationDate:    Sun Oct 18 17:00:00 2026 PDT
ModDate:         Sun Oct 18 17:00:00 2026 PDT
Custom Metadata: no
```

作者的数组被 `pdfinfo` 用逗号连起来了。时间看起来差了一天，是因为 `datetime(year:, month:, day:)` 不带时分秒，取当天 00:00，而这台机器的时区让 `pdfinfo` 把它换算成了 PDT。换成 UTC 就对了：

```text
$ TZ=UTC pdfinfo out/ch16/metadata.pdf | grep CreationDate
CreationDate:    Mon Oct 19 00:00:00 2026 UTC
```

不写 `date` 会怎样？`examples/notes` 就没写，它的创建时间是编译那一刻（`Mon Oct 19 09:12:56 2026 PDT`，是我跑 `make ci` 的时间；前一次编译读到的是 `08:54:07`），每次编译都不同。要让 PDF 的元数据可复现，就要显式写 `date`。`flake.nix` 的 `shellHook` 里有一行 `unset SOURCE_DATE_EPOCH`，也是为了让 `datetime.today()` 在 nix 里取到真实日期（否则它会返回 1980-01-01）。

`xuan` 的 `note` 在第 4 篇就已经替你做了这件事，[`src/note.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/packages/local/xuan/0.1.0/src/note.typ) 里：

```typst
  set document(
    title: title,
    author: ensure-array(author),
    keywords: keywords,
  )
```

（这是该文件第 20 到 24 行的原样引用，函数头和其余部分在第 4、10 篇已经展示。）`pdfinfo out/examples/notes.pdf` 因此直接给出 `Title: 线性代数笔记：最小二乘与 SVD`、`Keywords: 最小二乘, SVD, 伪逆`、`Author: bfmhno3`。模板的价值之一就在这里：作者只写一次 `title:`，页面上的标题块、页眉和 PDF 元数据三处同时对上。

## --pdf-standard：同时满足 PDF/A 和 PDF/UA

[`lab/ch16/pdf-standards.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch16/pdf-standards.typ)：

```typst
// Compiled twice: plain, and with `--pdf-standard a-2b,ua-1` (see extra.sh).
#set document(title: "PDF/A 与 PDF/UA", author: "bfmhno3")
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"), lang: "zh")

= 带标签的 PDF

标准要求字体全部嵌入、文档有标题和语言，PDF/UA 还要求图片有替代文字。

#figure(
  rect(width: 3cm, height: 1cm, fill: aqua),
  alt: "一个浅蓝色矩形",
  caption: [图片必须有 alt。],
)
```

同一个文件编译了两次：`chapter.sh` 的通用循环出一份不带标准的 PDF，`extra.sh` 再带 `--pdf-standard a-2b,ua-1` 出一份。0.15 起这个选项可以接逗号分隔的多个标准，一个归档标准（PDF/A）和一个无障碍标准（PDF/UA）可以叠在一起。我从 XMP 元数据里把标准声明抠出来对比：

```text
$ pdfinfo -meta out/ch16/pdf-standards.pdf | grep -Eo '<pdfaid:[a-z]*>[^<]*|<pdfuaid:[a-z]*>[^<]*|<pdf:PDFVersion>[^<]*'
<pdf:PDFVersion>1.7
$ pdfinfo -meta out/ch16/pdf-standards-a2b-ua1.pdf | grep -Eo '<pdfaid:[a-z]*>[^<]*|<pdfuaid:[a-z]*>[^<]*|<pdf:PDFVersion>[^<]*'
<pdfaid:part>2
<pdfaid:conformance>B
<pdfuaid:part>1
<pdf:PDFVersion>1.7
```

普通的那份没有任何标准声明；带标准的那份声明了 PDF/A-2b 和 PDF/UA-1。文件大小从 25566 字节涨到 29557 字节，我猜多出来的主要是 XMP 里那批 PDF/A 扩展 schema（`pdfinfo -meta` 的输出里能看到 `pdfaExtension:schemas`），没有逐字节核对。`pdffonts` 显示四个字体子集（两个 Noto Serif CJK、两个 Libertinus Serif）全部 `emb yes`。

至于 `Tagged: yes`：两份 PDF 都是。`typst compile --help` 对 `--no-pdf-tags` 的说明是，即使不要求 PDF/UA，Typst 默认也会写出带标签的 PDF 作为无障碍基线。所以带标准的那份并不是“多了标签”，而是“多了检查”。检查不过会直接报错，我写了两个会失败的小文件（不在仓库里，在 `/tmp` 里）：

```typst
#set document(title: "t", author: "a")
#figure(rect(width: 3cm, height: 1cm, fill: aqua), caption: [x])
```

```text
$ typst compile --pdf-standard a-2b,ua-1 noalt.typ noalt.pdf
error: PDF/UA-1 error: missing alt text
  ┌─ ../p16/noalt.typ:2:1
  │
2 │ #figure(rect(width: 3cm, height: 1cm, fill: aqua), caption: [x])
  │  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  │
  = hint: make sure your images and equations have alt text
```

另一个文件只有一行 `= hi`，用 `--pdf-standard ua-1` 编译：

```text
error: PDF/UA-1 error: missing document title
 = hint: set the title with `set document(title: [...])`
```

两个标准的组合也有硬约束。PDF/A 只能选一个，A-4 要求 PDF 2.0 而 UA-1 只到 1.7：

```text
$ typst compile --pdf-standard a-1b,a-2b ...
error: choose at most one PDF/A standard
$ typst compile --pdf-standard a-4,ua-1 ...
error: PDF/A-4 and PDF/UA-1 are mutually incompatible because they do not have any overlapping PDF versions
hint: PDF/A-4 requires version PDF 2.0
hint: PDF/UA-1 requires a version between PDF 1.4 and PDF 1.7
```

我试了 `a-3b,ua-1`，通过；`xuan` 的几份模板我没有逐个拿去过这个检查，所以不声称它们都满足 PDF/UA（`note` 里的图要带 `alt`，这需要写文档的人负责）。

## PNG 与 SVG：--ppi 和页码模板

位图和矢量图的输出用同一组选项：`--format png|svg`，`--pages` 选页，`--ppi` 定位图的分辨率（默认 144），输出路径里的 `{p}` 和 `{0p}` 是页码模板。我拿 17 页的 `examples/slides` 来试：

```bash
typst compile --root . --ignore-system-fonts --pages 1-3 --format png --ppi 72 \
  examples/slides/main.typ "/tmp/p16/png/s-{0p}.png"
```

```text
$ ls -l /tmp/p16/png
-rw-r--r-- 1 bfmhno3 users 14794 Oct 19 08:55 s-01.png
-rw-r--r-- 1 bfmhno3 users 11569 Oct 19 08:55 s-02.png
-rw-r--r-- 1 bfmhno3 users 27361 Oct 19 08:55 s-03.png
```

这条命令（`--pages 1-3`，72 ppi）的挂钟时间是 0.137 s。注意文件名是 `01` 而不是 `1`：我只导出了前 3 页，文件名却补了零，我猜是 `{0p}` 按文档的总页数（17 页，宽度 2）补零，没有去核对源码。`{p}` 则不补零。同一份文档导出 SVG：

```text
$ typst compile ... --format svg examples/slides/main.typ "/tmp/p16/png/v-{p}.svg"
$ ls /tmp/p16/png | grep svg | head -20 | tr "\n" " "
v-10.svg v-11.svg v-12.svg v-13.svg v-14.svg v-15.svg v-16.svg v-17.svg v-1.svg v-2.svg v-3.svg v-4.svg v-5.svg v-6.svg v-7.svg v-8.svg v-9.svg
```

17 个文件，`v-1.svg` 到 `v-17.svg`。想按字典序排好就用 `{0p}`，这是它存在的全部理由。如果输出多页却不写模板，Typst 直接拒绝：

```text
error: cannot export multiple images without a page number template ({p}, {0p}) in the output path
```

`--ppi` 控制像素尺寸，不改变页面的物理尺寸。`examples/slides` 的第 1 页是 16:9 的演示页：

```text
$ file s-01.png s144.png s288.png      # 分别是 --ppi 72、144、288
s-01.png: PNG image data, 842 x 474, ...
s144.png: PNG image data, 1684 x 947, ...
s288.png: PNG image data, 3368 x 1894, ...
```

像素数正好随 ppi 线性变化。博客里嵌图我一直用 144，是在清晰度和体积之间的折中，没有更深的道理。

## HTML 与 MathML

HTML 导出在 0.15.1 里仍然要用 `--features html` 打开，编译器会明说它在开发中。[`lab/ch16/html/site.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch16/html/site.typ)：

```typst
// Compiled with `--features html --format html` (see ../extra.sh).
#set document(title: "HTML 导出", author: "bfmhno3")

= HTML 导出

段落、*强调*与行内公式 $x^2 + y^2 = z^2$ 会变成语义化的标签，公式导出为 MathML。

- 列表
- 也一样

#html.elem("div", attrs: (class: "note"))[自定义元素：`html.elem`。]
```

编译后的 `out/ch16/site.html` 一共 2109 字节，其中一大半是 `<head>` 里内联的 MathML 样式表。我只取 `<body>`：

```text
$ grep -o '<body>.*' out/ch16/site.html
<body><h2>HTML 导出</h2><p>段落、<strong>强调</strong>与行内公式 <math><msup><mi>𝑥</mi><mn>2</mn></msup><mo>+</mo><msup><mi>𝑦</mi><mn>2</mn></msup><mo>=</mo><msup><mi>𝑧</mi><mn>2</mn></msup></math> 会变成语义化的标签，公式导出为 MathML。</p><ul><li>列表</li><li>也一样</li></ul><div class="note">自定义元素：<code>html.elem</code>。</div></body></html>
```

几个值得看的点：

- `= HTML 导出` 变成了 `<h2>`，不是 `<h1>`。我猜 Typst 把一级标题降了一级，是为了留出 `<h1>` 给页面标题，但没有查文档证实；`<title>` 里确实是 `HTML 导出`。
- 公式是 `<math>` 加 `<msup>`、`<mi>`、`<mo>` 这套 MathML，不是图片也不是 SVG。字母 `x` 写成了 `𝑥`（U+1D465，Unicode 的数学斜体字母），不是普通的 `x`。
- `html.elem("div", attrs: (class: "note"))[...]` 是通往原始 HTML 的后门：标签名和属性自己指定。
- 编译时 stderr 有一段警告：`warning: html export is under active development and incomplete`，附 `hint: its behaviour may change at any time` 和一个 issue 链接。不加 `--features html` 则报错 `error: html export is only available when `--features html` is passed`。环境变量 `TYPST_FEATURES=html` 与命令行开关效果相同：我用环境变量编译出的文件和上面那份 `cmp` 比较，逐字节相同。

还有一个细节。上面的 `<html lang="en">`：这个实验文件没有 `#set text(lang: "zh")`，所以尽管内容是中文，`lang` 仍是默认的 `en`。块公式（`display="block"`）我在 `/tmp` 里单独试了：

```typst
#set text(lang: "zh")
#set document(title: "t")
= 标题
块公式：
$ A = U Sigma V^T $
```

```text
<html lang="zh">
<body><h2>标题</h2><p>块公式：</p><math display="block"><mi>𝐴</mi><mo>=</mo><mi>𝑈</mi><mi mathvariant="normal">Σ</mi><msup><mi>𝑉</mi><mi>𝑇</mi></msup></math></body></html>
```

`lang` 传到了 `<html lang="zh">`，块公式带 `display="block"`，希腊字母 `Σ` 是 `mathvariant="normal"`（直立），拉丁字母 `A`、`U`、`V`、`T` 是 Unicode 数学斜体字母。

## bundle：一次编译出一个站点

bundle 是 0.15 的实验性导出：一份源文件里用 `document(...)` 声明多个输出文档，用 `asset(...)` 声明原样输出的文件，整个编译产出一个目录。[`lab/ch16/bundle/site.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch16/bundle/site.typ)：

```typst
// Compiled with `--features bundle,html --format bundle` (see ../extra.sh).
#document("index.html", title: [首页])[
  = 首页
  #link(<blog>)[进入博客] 或下载 #link(<blog-pdf>)[PDF 版]。
]

#let post = [
  == 博客
  同一份内容同时输出为网页和 PDF。
]

#document("blog.html", title: [博客])[#post] <blog>

#document("blog.pdf", title: [博客])[#post] <blog-pdf>

#asset("hello.txt", bytes("hello from bundle"))
```

注意命令行要同时打开 `bundle` 和 `html`：

```bash
typst compile --root . --ignore-system-fonts --features bundle,html --format bundle \
  lab/ch16/bundle/site.typ out/ch16/bundle
```

只开 `bundle` 会失败，因为里面有 `.html` 文档：

```text
error: html export is only available when the `html` feature is enabled
  ┌─ lab/ch16/bundle/site.typ:2:1
```

编译成功后输出路径是一个目录：

```text
$ ls -l out/ch16/bundle
-rw-r--r-- 1 bfmhno3 users   243 Oct 19 09:13 blog.html
-rw-r--r-- 1 bfmhno3 users 14093 Oct 19 09:13 blog.pdf
-rw-r--r-- 1 bfmhno3 users    17 Oct 19 09:13 hello.txt
-rw-r--r-- 1 bfmhno3 users   277 Oct 19 09:13 index.html
```

输出格式由文件名后缀决定：`blog.html` 是网页，`blog.pdf` 是一份真的 PDF（`pdfinfo` 读出 `Title: 博客`、`Pages: 1`）。最妙的是交叉引用，`index.html` 里：

```text
<p><a href="blog.html">进入博客</a> 或下载 <a href="blog.pdf">PDF 版</a>。</p>
```

`#link(<blog>)` 指向的是另一个文档的标签，在 HTML 里变成了相对路径 `blog.html`。同一份 `post` 内容被同时放进网页和 PDF，这也是我以后想用它的场景：同一个笔记，既能在网上读又能打印。至于 `==` 在 `blog.html` 里是 `<h3>`：它在 `document` 里是二级标题，降一级之后就是 `h3`。

stderr 里有 `warning: bundle export is experimental` 和 `hint: do not rely on this feature for production use cases`。我听从它：这一章只验证它能编译，没有拿它生产任何东西。

## typst eval：不生成文档，只问一个问题

`typst eval <表达式> --in <文件>`（取代已弃用的 `typst query`）在那份文档的上下文里求值一个表达式，把结果序列化成 JSON 或 YAML 打印。[`lab/ch16/eval.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch16/eval.typ)：

```typst
// A small target for `typst eval`: three labelled items and two headings.
= 标题一
== 标题二

#metadata("甲") <item>
#metadata("乙") <item>
#metadata("丙") <item>
```

```text
$ typst eval --root . "query(<item>).len()" --in lab/ch16/eval.typ
3
$ typst eval --root . "query(<item>).map(m => m.value)" --in lab/ch16/eval.typ
["甲","乙","丙"]
$ typst eval --root . --format yaml "query(<item>).map(m => m.value)" --in lab/ch16/eval.typ
- 甲
- 乙
- 丙
$ typst eval --root . --pretty "query(heading).map(h => h.level)" --in lab/ch16/eval.typ
[
  1,
  2
]
```

第 12 篇里我用 `query` 在文档内部数过 `<xuan-problem>`，现在它跑在文档外面：

```text
$ typst eval --root . --in examples/homework/main.typ "query(<xuan-problem>).len()"
4
$ typst eval --root . --in examples/homework/main.typ "query(<xuan-problem>).map(m => m.value)"
[25,25,20,30]
$ typst eval --root . --in examples/homework/main.typ "query(<xuan-problem>).map(m => m.value).sum()"
100
```

作业的总分 100 不用打开 PDF 就能读出来，`make ch16` 把第一条的结果存进 `out/ch16/eval.txt`（内容是 `4`），这就是仓库里的“集成测试”：模板能不能把题目的分值正确地暴露给 `query`。不带 `--in` 时它就是一个计算器：`typst eval "range(1, 6).map(x => x * x).sum()"` 打印 `55`。

有一条边界我是撞出来的。`--in` 带来的是那份文档的**内省数据**（`query` 能查到东西），不是它的绑定：我在 `eval.typ` 上调用 `plain-text`，得到

```text
error: unknown variable: plain-text
  ┌─ <input-expression>:1:34
  │
1 │ query(heading).map(h => (h.level, plain-text(h.body)))
  │                                   ^^^^^^^^^^
```

我没有去查 `typst eval` 对表达式作用域的规定，只记录这次的结果：`eval.typ` 里没有 `import xuan`，表达式没有看到 `plain-text`。内容值被序列化时也不是“文本”：我把 `h.body` 换成 `repr(h.body)`，得到 `[[1,"[标题一]"],[2,"[标题二]"]]`，标题的内容被写成了字符串 `"[标题一]"`。要做更多处理就在表达式里自己拼，或者像第 7 篇那样把数据放进 `metadata`。`--target html|bundle` 也能选（`typst eval --help` 里列了 `paged`、`html`、`bundle` 三个值），我没有用。

## --timings 与 --deps：看编译器在忙什么

`--timings` 写出一个 JSON 数组，每个元素有 `name`、`cat`、`ph`、`ts`、`pid`、`tid`、`args` 这几个字段，是 Chrome 追踪事件的形状（`typst compile --help` 说这个 JSON 可以载入 https://ui.perfetto.dev 之类的追踪工具，该选项仍是实验性的；我没有试过），`extra.sh` 里的那一行是：

```bash
typst compile --root . --ignore-system-fonts --timings out/ch16/timings.json \
  examples/notes/main.typ out/ch16/notes-timed.pdf
```

这份 4 页的笔记一共写出 18842 个事件，开头两个是：

```text
$ jq length out/ch16/timings.json
18842
$ jq -c '.[0:2]' out/ch16/timings.json
[{"name":"compile once","cat":"typst","ph":"B","ts":0.0,"pid":1,"tid":1,"args":null},{"name":"compile","cat":"typst","ph":"B","ts":1.112,"pid":1,"tid":1,"args":null}]
```

`ph` 是 `B`（开始）或 `E`（结束），`ts` 是时间戳。我写了一个 jq 程序（`timing.jq`，在 `/tmp` 里，不在仓库里），把每个名字的最早开始到最晚结束之间的跨度算出来：

```text
map(select(.name | test("^(compile|iter \\(.\\))$")))
| group_by(.name)[]
| "\(.[0].name)\t\(((map(select(.ph == "E").ts) | max) - (map(select(.ph == "B").ts) | min)) / 1000 * 10 | round / 10) ms"
```

```text
$ jq -r -f timing.jq out/ch16/timings.json
compile	207.5 ms
iter (1)	102.8 ms
iter (2)	60.5 ms
iter (3)	10.3 ms
iter (4)	2.2 ms
```

这里我把 `ts` 当作微秒（除以 1000 得到毫秒）。依据是 `compile` 的跨度 207.5 ms 小于我用 `hyperfine -w 2 -r 10 'typst compile --root . --ignore-system-fonts examples/notes/main.typ out.pdf'` 量到的整条命令 248.5 ms ± 1.9 ms（进程启动、发现字体和导出也在里面），数量级吻合，但文档里没有写，所以只是合理的猜测。数字本身是确定的：笔记的布局迭代了 4 轮，第一轮 102.8 ms，随后 60.5、10.3、2.2 ms。这正是第 7 篇说的“多遍编译”：每一轮用上一轮的 `counter`、`state`、`query` 结果重新排版，直到结果不再变化。我猜第四轮就是“确认已稳定”的那一遍，所以它最便宜（事件名里确实有 `check stabilized`）。事件名里还有 `call plugin`：整份文档调用了一次 Rust 插件（第 15 篇术语表的排序键），也出现在时间线上。开始事件（`ph` 为 `B`）数得最多的是 `func call`（2157 个）、`handle text`（1837）、`realize`（837）和 `math glyph layout`（708）。

四次运行里 `compile` 的跨度是 207.5、209.6、224.2 和 242 ms（分别在不同的克隆和时间），所以 207.5 ms 不是一个稳定值，只是这一次的读数。

`--deps` 写出这次编译读取了哪些文件，格式由 `--deps-format` 选 `json`（默认）、`zero`（以 NUL 分隔，能表达任意路径）或 `make`（输出 Makefile 的依赖行）。`extra.sh` 对第 12 篇的模块实验这样用：

```text
$ cat out/ch16/deps.json
{"inputs":["lab/ch12/modules/b.typ","lab/ch12/modules/a.typ","lab/ch12/modules/main.typ"],"outputs":["out/ch16/deps-demo.pdf"]}
$ typst compile --root . --ignore-system-fonts --deps - --deps-format make lab/ch12/modules/main.typ /tmp/p16/f/d.pdf
/tmp/p16/f/d.pdf: lab/ch12/modules/b.typ lab/ch12/modules/a.typ lab/ch12/modules/main.typ
```

`make` 格式正好是一条 Makefile 规则，按 Makefile 的语法可以用 `-include` 引入它来让 `make` 跟踪依赖（我没有试过）。笔记示例的依赖要多得多：

```text
$ jq ".inputs | length" deps2.json
23
$ jq -r ".inputs[]" deps2.json | grep -vE "src/|lib.typ"
examples/notes/glossary.yaml
examples/notes/main.typ
examples/notes/refs.bib
packages/local/xuan/0.1.0/typst.toml
packages/local/xuan/0.1.0/plugin/xuan_pinyin.wasm
examples/notes/figs/projection.svg
```

23 个文件，除了 `src/` 下的 xuan 源码，就是笔记的 `.typ`、YAML 术语表、`.bib`、SVG 图、包清单，以及那个 `.wasm`。这个清单是“改了哪些文件需要重编”的准确答案，比我手写的依赖规则可靠。

## 测试：assert 就是断言框架

Typst 没有测试框架，也不需要：`assert`、`assert.eq` 在编译期求值，失败就是编译错误，`typst compile` 退出码非零。所以 `tests/` 下每个文件就是一份普通的 `.typ`，对模块的行为写断言，`make test` 把它们逐个编译成一次性的 PDF：

```make
test:
	@mkdir -p out/tests
	@for f in tests/*.typ; do \
		echo "typst compile $$f"; \
		typst compile $(TFLAGS) $$f out/tests/$$(basename $$f .typ).pdf || exit 1; \
	done
```

六个文件，共 109 行，一个模块一个文件。[`tests/units.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/tests/units.typ) 是最直白的：

```typst
#import "@local/xuan:0.1.0": *

#let thin = "\u{2009}"

// Groups of three from the decimal point outwards, from 5 digits up.
#assert.eq(num("1234567.891"), "1" + thin + "234" + thin + "567.891")
#assert.eq(num("1234"), "1234")
#assert.eq(num("12345"), "12" + thin + "345")
#assert.eq(num("0.123456"), "0." + "123" + thin + "456")
#assert.eq(num(-1234567), "\u{2212}1" + thin + "234" + thin + "567")

// Quantities: upright unit, thin space after the number, `^n` superscripts.
#assert.eq(plain-text(qty(9.81, "m/s^2")), "9.81" + thin + "m/s2")
#assert.eq(
  plain-text(qty-range(0, 50, "mm", lang: "zh")),
  "0～50" + thin + "mm",
)
#assert.eq(plain-text(qty-range(0, 50, "mm", lang: "en")), "0–50" + thin + "mm")
```

`num` 返回字符串，`qty` 返回 `box`，所以测试 `qty` 要先用第 3 篇的 `plain-text` 把内容摊平成字符串。这就是我当初把 `plain-text` 放进 `util.typ` 的真正原因：它是测试的基础设施。

依赖“编译之后才知道”的行为就要上 `context`。[`tests/theorem.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/tests/theorem.typ)：

```typst
#import "@local/xuan:0.1.0": *
#show: xuan-base

= 第一章
#theorem[甲] <t1>
#lemma[乙] <t2>
#proof[略。]
#example[丙] <t3>

= 第二章
#theorem[丁] <t4>

#context {
  // One counter is shared by all environments and restarts at each chapter.
  let n(l) = counter(figure.where(kind: "xuan-theorem")).at(l).first()
  assert.eq((n(<t1>), n(<t2>), n(<t3>), n(<t4>)), (1, 2, 3, 1))
  // `proof` is unnumbered.
  assert.eq(query(figure.where(kind: "xuan-theorem")).len(), 4)
}
```

文档本身像往常一样排版，最后的 `context` 块在整个文档排完之后读取计数器在四个标签处的值：定理、引理、例题共用一个计数器，第二章重新从 1 数。`proof` 不编号，所以 `query` 只数到 4 个。其余四个文件的主题：`util.typ` 测 `plain-text`、`ensure-array`、`pick`；`homework.typ` 测 3 道有分值的题和 1 道无分值的题的总分是 35；`slides.typ` 测 3 步的页面会产出 5 页（标题页加 3 步加 1 页普通页）；`glossary.typ` 测码点顺序与拼音顺序不同，它用到仓库里**已提交的** `.wasm`。

测试能不能抓到错误？我临时在 `tests/` 里放了一个故意写错的文件（跑完删除，没有提交）：

```typst
#import "@local/xuan:0.1.0": *

#assert.eq(num("1234"), "1 234")
```

```text
$ typst compile --root . --ignore-system-fonts tests/bad-units.typ /tmp/p16/f/x.pdf
error: equality assertion failed: value "1234" was not equal to "1 234"
  ┌─ tests/bad-units.typ:3:1
  │
3 │ #assert.eq(num("1234"), "1 234")
  │  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
$ echo $?
1
```

失败信息带着两边的值和位置，和任何测试框架的输出一样有用。局限也明显：没有测试名、没有汇总、第一个失败就中止（`|| exit 1`）。对 6 个文件、0.43 s 的套件，这些都不算问题。“预期会失败”的行为不放在 `tests/` 里，由 `*.fail.typ` 的约定负责：`scripts/chapter.sh` 要求它们必须失败，退出码 0 反而算错。

## typstyle：格式化也是一道门

仓库里每个 Typst 片段（包括这个系列里贴出来的）都过了 `typstyle -l 80`。`make fmt-check` 的文件列表来自一条 `find`：

```make
TYP_FILES = $(shell find . -name '*.typ' -not -path './plugin/*' -not -path './out/*' -not -path './.direnv/*' -not -name '*.fail.typ')

fmt-check:
	typstyle --check -l 80 $(TYP_FILES)
```

排除了 `*.fail.typ`：它们本来就有语法错误，我实测 `typstyle --check` 对 `lab/ch01/unclosed.fail.typ` 打印 `warn: Failed to parse ... The source is erroneous.` 并退出 0，也就是它不会让检查失败，只是多一行噪音。我拿一个故意写乱的文件（`/tmp` 里，不在仓库里）试了 typstyle 的几种用法：

```typst
#let   greet( name,greeting:"hi" )={
 [#greeting, #name!]
}
#set text(font:("Libertinus Serif","Noto Serif CJK SC"),size:11pt)
#greet( "Typst" )
```

```text
$ typstyle --check -l 80 messy.typ
Would reformat: messy.typ
exit=1
$ typstyle --diff -l 80 messy.typ
--- messy.typ
+++ messy.typ
@@ -1,5 +1,5 @@
-#let   greet( name,greeting:"hi" )={
- [#greeting, #name!]
+#let greet(name, greeting: "hi") = {
+  [#greeting, #name!]
 }
-#set text(font:("Libertinus Serif","Noto Serif CJK SC"),size:11pt)
-#greet( "Typst" )
+#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"), size: 11pt)
+#greet("Typst")
exit=1
$ typstyle -i -l 80 messy2.typ     # 对一份拷贝原地改写
exit=0
$ typstyle --check -l 80 messy2.typ
exit=0
```

`--check` 只判断、不动手，不通过退出码为 1；`--diff` 打印补丁，退出码同样是 1；`-i` 原地改写，之后 `--check` 通过。把这个乱文件放进 `lab/ch01/` 再跑 `make fmt-check`，输出 `Would reformat: lab/ch01/messy-tmp.typ` 和 `make: *** [Makefile:45: fmt-check] Error 1`（make 自己退出 2），说明 `ci` 在格式不对时会在编译之前停下。（我放进去又删掉了，没有提交。）

为什么 Makefile 里每次都写 `-l 80`？因为这是 `typstyle` 的默认值，写出来是给读者看的：这个系列的代码块宽度限制和博客的 80 列规则一致，不是为了覆盖默认。

## tinymist：我验证了什么，没验证什么

tinymist 是 Typst 的语言服务器。先交代清楚：**这一篇里我没有在任何编辑器里交互式地用过它。** 这台机器上装了 Helix（`hx --version` 为 `helix 25.07.1`），我用 Helix 的体检命令验证接线，再用一个自己写的 LSP 客户端脚本直接驱动 `tinymist lsp`，核对它对诊断、悬停、格式化请求的回应。实时预览（`tinymist preview` 或编辑器里的预览面板）、保存即导出、其他编辑器（VS Code、Neovim）的配置，我都没有测试，下面不对它们做任何声明。

先是接线。`hx --health typst` 在开发 shell 外面和里面的结果不同（每行开头有一个叉或勾的符号，我略去了，叉表示没找到，勾表示找到了）：

```text
$ hx --health typst            # 不在 nix develop 里
Configured language servers:
  tinymist: 'tinymist' not found in $PATH
$ nix develop --command hx --health typst
Configured language servers:
  tinymist: /nix/store/mpdcjcaxcdy8wr9r4j3prmrs3yixs5aj-tinymist-0.15.2/bin/tinymist
```

（`Tree-sitter parser`、`Highlight queries` 两项在两种情况下都是勾，我只贴了语言服务器那一行。）这就是为什么我把 `tinymist` 放进 `flake.nix` 的 `packages` 里：版本和 Typst 一起锁定，在 `nix develop` 里启动的 Helix 就能找到它。

然后是协议。脚本不在仓库里，核心只有几行 bash：用 `coproc` 启动 `tinymist lsp`，按 LSP 的 `Content-Length` 帧格式收发 JSON：

```bash
# 节选自 /tmp/p16/lsp.sh（不在仓库里）
export LC_ALL=C   # ${#1} 要数字节，不是字符
coproc TM { tinymist lsp 2>/tmp/p16/tinymist.err; }
send() { printf 'Content-Length: %d\r\n\r\n%s' "${#1}" "$1" >&"${TM[1]}"; }
send "$(jq -cn --arg u "file://$ROOT/$1" --rawfile t "$1" \
  '{jsonrpc:"2.0",method:"textDocument/didOpen",params:{textDocument:{uri:$u,languageId:"typst",version:1,text:$t}}}')"
```

`initialize` 的回应里：

```text
{"server":{"name":"tinymist","version":"0.15.2"},"formatting":true,"hover":true}
```

接着对几份文件发 `didOpen`，收集它们的诊断。对 `lab/ch01/unclosed.fail.typ`（第 1 篇的预期失败文件）和一个我写的坏文件 `broken-tmp.typ`（三行：`#let x = 1`、`#y`、`#x.foo()`，放在克隆里验证完就删了）：

```text
## diagnostics: lab/ch01/unclosed.fail.typ
[{"line":3,"severity":1,"message":"unclosed delimiter"}]
## diagnostics: broken-tmp.typ
[{"line":2,"severity":1,"message":"unknown variable: y"}]
```

`severity: 1` 是 LSP 里的 Error。第二个文件三行里 tinymist 只返回了一条诊断，也就是第 2 行的未知变量。对 `lab/ch04/first-note/main.typ` 和 `examples/notes/main.typ`，它没有发布任何诊断，说明从语言服务器的角度，`#import "@local/xuan:0.1.0": *` 能解析。

这个“能”是有代价的。我刚开始做这一章时，`typst.toml` 里写着 `compiler = "0.15.1"`，同样的两份文件得到：

```text
## diagnostics: lab/ch04/first-note/main.typ
[{"line":1,"severity":1,"message":"package requires Typst 0.15.1 or newer (current version is 0.15.0)"}]
```

原因在 `tinymist --version` 里：

```text
$ tinymist --version | grep -E 'tinymist|Typst Version'
tinymist 
Typst Version:       0.15.0
```

nixpkgs 里的 tinymist 0.15.2 内嵌的是 Typst 0.15.0 的编译器，比命令行的 0.15.1 低一个补丁版本。包的 `compiler` 字段是下限，写 0.15.1 的包在编辑器里被拒绝，编译却在命令行里正常。我把它改成 `"0.15.0"`（第 4 篇里就是这个值，那里说了原因），在克隆里来回切了两次，每次都用同一个脚本复现：写 0.15.1 报错，写 0.15.0 无诊断，`make all` 在两种取值下都是 106 个 `ok`。所以仓库现在的值是 0.15.0，它是“命令行和编辑器都能用”的最大值。

悬停也核对了：对 `lab/ch04/first-note/main.typ` 里 `note.with` 的 `note`（0 起算的第 2 行第 9 列）发 `textDocument/hover`，返回的是 `xuan` 里 `note` 函数的签名，Markdown 代码块的语言标记是 `typc`（Typst 的代码模式）：

```text
let note(
  body: any,
  abstract: content | none = none,
  author: array | type = (),
  bibliography: none = none,
  ...
```

（我把它截到前几行，实际回应更长。）这就是 `note` 的参数列表，从包里的定义直接读出来，开头那句 “Notes and reports.” 来自 `note.typ` 里的 `///` 文档注释。

最后是格式化。我用一个 87 列的单行文件（`/tmp` 里）试，看 tinymist 的格式化和命令行的 `typstyle -l 80` 是否一致：

```typst
#let sum-of-squares(values) = values.map(v => v * v).fold(0, (acc, x) => acc + x) + 100
```

用默认配置向 tinymist 发 `textDocument/formatting`，返回的编辑列表是空的 `[]`，也就是它认为不用改。在 `initialize` 的 `initializationOptions` 里加 `{formatterPrintWidth: 80}` 后，同一请求返回：

```text
[{"range":[0,30,0,87],"newText":"(\n  values.map(v => v * v).fold(0, (acc, x) => acc + x) + 100\n)"}]
```

这个编辑和 `typstyle -l 80` 对同一个文件的输出完全一致：

```typst
#let sum-of-squares(values) = (
  values.map(v => v * v).fold(0, (acc, x) => acc + x) + 100
)
```

所以如果你想让编辑器里的保存格式化和 `make fmt-check` 不打架，要把 tinymist 的 `formatterPrintWidth` 设成 80。具体写在哪个编辑器的哪个配置文件里，我没有实测，不写。

## 模板与安装：typst init 和 make install

第 4 篇的 `typst.toml` 里有一节 `[template]`，指向 `template/main.typ`，这一篇才把它建出来。[`packages/local/xuan/0.1.0/template/main.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/packages/local/xuan/0.1.0/template/main.typ)，11 行：

```typst
#import "@local/xuan:0.1.0": *

#show: note.with(
  title: "标题",
  author: "作者",
  abstract: [一两句话说明这份文档写什么。],
)

= 开始

在这里写正文，公式写成 $a^2 + b^2 = c^2$。
```

```text
$ typst init @local/xuan:0.1.0 /tmp/xxx
Successfully created new project from @local/xuan:0.1.0 ...
To start writing, run:
> cd /tmp/xxx
> typst watch main.typ
$ ls /tmp/xxx
main.typ
$ typst compile --root /tmp/xxx --ignore-system-fonts /tmp/xxx/main.typ /tmp/xxx/main.pdf
$ pdfinfo /tmp/xxx/main.pdf | grep -E "Title|Author|Pages"
Title:           标题
Author:          作者
Pages:           1
```

（成功提示的第一行末尾有一个庆祝用的 emoji，我没有贴。）`typst init` 只复制 `template/` 目录里的内容，所以展开出来的项目里只有 `main.typ`，它仍然写着 `@local/xuan:0.1.0`，也就是说 `xuan` 本身必须在 Typst 找得到的地方。这条命令在我这里成功，是因为 `nix develop` 设了 `TYPST_PACKAGE_PATH=$PWD/packages`。

开发 shell 之外怎么办？`make install` 就一行：

```make
install:
	mkdir -p ~/.local/share/typst/packages/local && ln -sfn "$(CURDIR)/packages/local/xuan" ~/.local/share/typst/packages/local/xuan
```

它在用户级的包目录里建一个符号链接，指向仓库里的包。我用一个临时的 `HOME`（`/tmp/p16/home`）验证，不碰真实的家目录：

```text
$ HOME=/tmp/p16/home make install
$ ls -l /tmp/p16/home/.local/share/typst/packages/local/
lrwxrwxrwx 1 bfmhno3 users 30 Oct 19 09:15 xuan -> /tmp/lab16/packages/local/xuan
$ env -u TYPST_PACKAGE_PATH HOME=/tmp/p16/home typst compile --ignore-system-fonts main.typ main.pdf
$ echo $?
0
$ env -u TYPST_PACKAGE_PATH HOME=/tmp/p16/empty typst compile --ignore-system-fonts main.typ x.pdf
error: package not found (searched for @local/xuan:0.1.0)
  ┌─ ../p16/proj/main.typ:1:8
  │
1 │ #import "@local/xuan:0.1.0": *
  │         ^^^^^^^^^^^^^^^^^^^
```

取消 `TYPST_PACKAGE_PATH`、只靠安装的链接，编译通过；换一个没装过的 `HOME`，就是第 4 篇讲过的 `package not found`。用符号链接而不是复制，是因为你改仓库里的 `src/*.typ`，所有用 `@local/xuan` 的文档立刻看到改动，不用重新安装。代价是链接指向仓库路径，仓库搬家就断。

## CI：同一条命令再跑一遍

[`.github/workflows/ci.yml`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/.github/workflows/ci.yml)，25 行：

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: cachix/install-nix-action@v31
      - run: nix develop --command make ci

  plugin:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: cachix/install-nix-action@v31
      - run: >-
          nix develop --command bash -c
          'cd plugin && cargo fmt --check && cargo clippy --release --target wasm32-unknown-unknown -- -D warnings'
```

整份工作流的设计原则就一条：**CI 里跑的必须是你本地跑的那条命令。** `build` 任务的 `run` 就是 `nix develop --command make ci`，也就是本篇开头那 12.2 秒；`nix develop` 读 `flake.lock`，而 `flake.lock` 把 nixpkgs 锁在 `56c02bc00adcf003215cc4bd996d6efaf4cff188`，和这个博客仓库的 `flake.lock` 锁的是同一个提交（我用 `jq -r '.nodes.nixpkgs.locked.rev'` 对比了两份锁文件）。所以 CI 里的 Typst 是 0.15.1、typstyle 是 0.15.0、字体是同样的 Noto CJK，不会出现“我这里是绿的，CI 里是红的”。Actions 的版本我用 `gh api` 查了今天的最新发布：`actions/checkout` 是 `v7.0.1`，`cachix/install-nix-action` 是 `v31.11.2`，工作流里写的是浮动的主版本标签 `@v7` 和 `@v31`。

要打个比方的话，CI 每次都给你换一张干净的桌子，重做一遍实验：桌上昨天留下的东西（缓存、你装过但没写进依赖的工具、忘了提交的文件）都不算数。我在 `/tmp` 里重新克隆，是同一个意思，只是把桌子留在本地。

`plugin` 任务只检查 Rust 源码的格式和 lint：`cargo fmt --check` 和 `cargo clippy --release --target wasm32-unknown-unknown -- -D warnings`。我在本地跑了它们，格式检查无输出（`fmt-ok`），clippy 的最后三行是 `Checking pinyin v0.11.0`、`Checking xuan-pinyin v0.1.0` 和 `Finished`，用时 0.67 s。注意它**没有**把 Rust 重新编译成 `.wasm` 放进包里。

为什么测试用提交进仓库的 `.wasm`，而不在 CI 里临时编译？我有三个理由，其中第一个是实测的：

1. 编译是可复现的。我在克隆里对已提交的 `.wasm` 跑 `sha256sum`，再跑 `make plugin`（依赖已缓存的机器上用时 3.4 s）重新编译、覆盖，再跑一次：两次都是 `280cfb1184870d980cb321dc9fd27048c263440a8ecea10b31b23e329da90d07`，`git status` 干净，字节相同。既然重编出来一样，提交的那份就不是“不知道怎么来的二进制”。
2. 包要能被 `typst init` 和 `make install` 的使用者直接用，他们不需要 Rust 工具链。`.wasm` 是包的一部分，跟 `lib.typ` 一样要提交。
3. `build` 任务的职责是验证包的行为，不是验证 Rust 的构建；把后者拆到 `plugin` 任务里，哪个坏了一眼就知道。

冷缓存的代价也量过一次。第 14 篇的 `examples/ecosystem/main.typ` 要下载 `@preview` 包，CI 的每次运行都从空缓存开始。我用一个空的 `--package-cache-path` 量了：

```bash
typst compile --root . --ignore-system-fonts --package-cache-path /tmp/p16/cache \
  examples/ecosystem/main.typ /tmp/p16/eco.pdf
```

第一次（冷）25.07 s，第二次（热）0.49 s，缓存目录里留下 `cetz`、`elembic`、`lilaq`、`oxifmt`、`tiptoe`、`zero` 六个包（Touying 用在 `touying.typ` 里，这条命令没有编译它）。冷启动的耗时取决于当时的网络，第 14 篇量到的是 11.1 s，这次是 25 s，我不会把任何一个当成常数。如果 CI 因此变慢，可以用 `actions/cache` 缓存这个目录，我没有配置它，12 秒级的 CI 目前不需要。

我没有在这里贴 GitHub 上 Actions 的运行结果，因为我能在本机验证的是工作流所执行的那条命令，而不是 GitHub 的调度。仓库的 Actions 页上有它的真实状态。

## 索引：Typst 特性 → 第几篇

这张表按系列开头定下的覆盖清单一行一行列，每一行的每个条目按下面的对应关系出现在那一篇里。

| Typst 特性 | 条目 | 篇 |
| --- | --- | --- |
| CLI 基础 | `compile`、`watch`、`fonts`、`--root`、`--font-path`、`--ignore-system-fonts`、内嵌字体 | [01](/posts/typst-by-xuan-01-first-document/)、[05](/posts/typst-by-xuan-05-fonts-and-cjk/) |
| 标记语法 | 段落、`*strong*`、`_emph_`、行内与块 `raw`、自动链接、标题 `=`、列表 `-`、编号列表 `+`、术语列表 `/ a: b`、标签 `<a>`、引用 `@a`、`\` 换行、`~`、`--`/`---`、智能引号、注释、转义、`\u{...}` | [01](/posts/typst-by-xuan-01-first-document/) |
| 模式 | 标记、代码、数学三种模式，`#` 嵌入规则，`#(...)` | [01](/posts/typst-by-xuan-01-first-document/)、[02](/posts/typst-by-xuan-02-code-mode/) |
| 值与类型 | `none`、`auto`、`bool`、`int`（`int.min`/`int.max`）、`float`、`decimal`、`str`（字节、字素簇与码点）、长度单位、`ratio`、`relative`、`fraction`、`angle`、`version`、`type`、`regex`、`label`、`symbol`/`sym` | [02](/posts/typst-by-xuan-02-code-mode/) |
| 控制与绑定 | `let`、遮蔽、解构、`if`/`for`/`while`/`break`/`continue`、代码块与内容块的拼接、运算符、`range(inclusive:)` | [02](/posts/typst-by-xuan-02-code-mode/) |
| 集合 | 数组与字典的方法：`map`、`filter`、`fold`、`zip`、`enumerate`、`sorted(key:)`、`dedup`、`join`、`at(default:)`，0.15 的 `dictionary.map`/`filter` | [02](/posts/typst-by-xuan-02-code-mode/) |
| 诊断 | `assert`、`assert.eq`、`panic`、`repr`、`type` | [02](/posts/typst-by-xuan-02-code-mode/)，测试里的用法见本篇 |
| 函数 | 命名与默认参数、`..args`、`arguments`（`pos`、`named`、字段访问）、展开、闭包、递归、`.with`、纯度与捕获的不可变性 | [03](/posts/typst-by-xuan-03-functions-and-content/) |
| 内容模型 | 元素函数、`func`、`fields`、`has`、`at`、序列、`plain-text` | [03](/posts/typst-by-xuan-03-functions-and-content/) |
| 样式 | `set`、`set ... if`、作用域、折叠、`show` 的 set 与变换形式、选择器（元素、`where`、字符串、正则、标签、`or`/`and`/`before`/`after`、`within`）、`show: template.with(...)` | [04](/posts/typst-by-xuan-04-set-and-show/) |
| 编号 | `numbering` 的字符串与函数形式，中文编号（`"一"`、`"壹"`） | [04](/posts/typst-by-xuan-04-set-and-show/)、[05](/posts/typst-by-xuan-05-fonts-and-cjk/) |
| 文本 | `text` 的参数（字体列表、`covers`、`lang`/`region`、字号、字重、字形、`tracking`、`spacing`、`features`、`number-type`、`variations`、`cjk-latin-spacing`、`fallback`）、`smartquote`、`linebreak`、`lorem`、`highlight`、`underline`、`strike`、`overline`、`sub`、`super`、`upper`、`lower`、`smallcaps` | [05](/posts/typst-by-xuan-05-fonts-and-cjk/)、[09](/posts/typst-by-xuan-09-figures-tables-code/) |
| 段落 | `par` 的 `justify`、`leading`、`spacing`、`first-line-indent`（折叠）、`hanging-indent`、`linebreaks` | [05](/posts/typst-by-xuan-05-fonts-and-cjk/) |
| 页面与布局 | `page`（纸张、边距、装订、分栏、页眉页脚、页码、填充、背景/前景、出血）、`pagebreak`、`block`、`box`、`align`、`pad`、`h`/`v`（弱间距、`fr`）、`stack`、`grid`、`columns`/`colbreak`、`place`（浮动、`scope`）、`move`/`rotate`/`scale`/`skew`、`repeat`、`hide`、`layout`、`measure` | [06](/posts/typst-by-xuan-06-page-and-layout/) |
| 内省 | `context`、`here`、`locate`、`location`、`counter`（内置、自定义、`display(at:)`）、`state`、`query`、`metadata`、收敛 | [07](/posts/typst-by-xuan-07-context-counters-state/) |
| 数学 | 行内与块公式、标识符、数学中的文本、符号与修饰、附标、`frac`、`sqrt`/`root`、`vec`、`mat`、`cases`、`lr`/`mid`/`abs`/`norm`/`floor`/`ceil`、`&` 对齐、`op`、`limits`/`scripts`、字体变体（`bold`、`upright`、`cal`、`bb`、`frak`、`sans`、`mono`）、`cancel`、`underbrace`/`overbrace`、撇号、`class`、数学中的代码、`math.equation` 的编号与补充语 | [08](/posts/typst-by-xuan-08-math/) |
| 模型元素 | `figure`（种类、标题、放置）、`image`、`table`（表头、表尾、`cell`、`hline`、`vline`、`stroke`/`fill`/`align` 的函数形式）、`grid.cell`、`ref` 的补充语、`link`、`footnote`、`outline`（目标）、`quote`、`divider`、对 `emph`/`strong` 的 show 规则 | [09](/posts/typst-by-xuan-09-figures-tables-code/) |
| 代码显示 | `raw`（`lang`、`block`、`theme`、`tab-size`、`raw.line`、`syntaxes`） | [09](/posts/typst-by-xuan-09-figures-tables-code/) |
| 参考文献 | `bibliography`（`.bib`、Hayagriva YAML、样式、CSL 文件、`full`、`title`）、`cite` 的形式与补充语、0.15 的 `target`/`group` | [10](/posts/typst-by-xuan-10-bibliography/) |
| 数据加载 | `yaml`、`toml`、`json`、`csv`、`xml`、`cbor`、`read`、字节、`sys.inputs`、`eval`（标记模式）、`datetime`、`duration` | [11](/posts/typst-by-xuan-11-data-driven-cv/) |
| 模块 | `import` 的各种形式、`include`、根相对路径、0.15 的 `path` 类型、循环导入错误 | [12](/posts/typst-by-xuan-12-homework/) |
| 可视化 | `rect`/`square`/`circle`/`ellipse`/`line`/`polygon`/`curve`、`color` 的色彩空间与方法、`color.map`、`gradient`（线性、径向、锥形）、`tiling`、`stroke` 字典 | [13](/posts/typst-by-xuan-13-slides-and-drawing/) |
| 包 | `@preview` 导入、缓存与 `--package-cache-path`、`--package-path`、`typst.toml` 的字段、`typst init`、`@local` | [14](/posts/typst-by-xuan-14-packages-ecosystem/)、本篇（`typst init`、`make install`） |
| 插件 | `plugin`、字节协议、确定性、错误、Rust 的 `wasm-minimal-protocol` | [15](/posts/typst-by-xuan-15-wasm-plugin/) |
| 导出与工具链 | PDF 元数据（`document`）、`--pdf-standard`（多个）、PNG/SVG（`--ppi`、`{p}`）、HTML（`--features html`、MathML）、bundle（实验性）、`typst eval`、`--timings`、`--deps`、tinymist、typstyle、测试、CI | 本篇 |

这张表我是对着覆盖清单抄的，抄完后我 `grep` 了第 1 到 15 篇里的一批关键词（`bleed`、`measure`、`display(at`、`conic`、`package-cache-path` 等）确认它们都出现过，但没有逐行逐条重编译；每一行是否真讲到，以各篇里那条命令的输出为准。

## 验证你手里的树

这个系列只有一个“权威版本”，就是 `tutorial-v1` 标签。如果你用 `git clone --branch tutorial-v1` 拿的仓库，一路上只是跟着改文件，那么到这里，你的工作树应该和标签完全一致。检查它只需要一条命令：

```bash
git diff tutorial-v1 --stat
```

它把**工作树**和标签比较，没有任何改动时什么也不打印。我在 `/tmp/lab16`（标签的全新克隆，`git describe --tags --exact-match HEAD` 输出 `tutorial-v1`）里验证：

```text
$ git status --short
$ git diff tutorial-v1 --stat
$ echo $?
0
```

两条命令都没有输出。再往 `util.typ` 里追加一行注释：

```text
$ echo "// scratch" >> packages/local/xuan/0.1.0/src/util.typ
$ git diff tutorial-v1 --stat
 packages/local/xuan/0.1.0/src/util.typ | 1 +
 1 file changed, 1 insertion(+)
$ git checkout -q packages/local/xuan/0.1.0/src/util.typ
$ git diff tutorial-v1 --stat
$ echo $?
0
```

改动被报告出来，还原之后又没有输出了。有两点要小心：`git diff` 看不到**未跟踪**的新文件（你自己新建的文件要看 `git status --short`），退出码也不会因为有差异而变成非零，它只是打印；要拿它做脚本判断，用 `git diff --quiet tutorial-v1`。

走到这一步你手里有的东西：一个 70 行的 Makefile 驱动的、16 章实验的小型文档系统，一个能 `typst init` 的本地包，四类文档（笔记、作业、幻灯片、简历）的 Typst 模板，一个 Rust 写的 235242 字节的插件，6 个测试，和一个只做一件事的 CI。Typst 的导出方向里，HTML 和 bundle 在 0.15.1 里都还挂着“实验性”的警告，这两个我没有用来生产任何东西，只放进 `extra.sh` 当“金丝雀”：以后 nixpkgs 升级 Typst，`make ch16` 会第一个告诉我它们的行为有没有变。`typst compile --help` 里 `--features` 的取值还列了一个 `a11y-extras`，我没有试，下一次想让 `note` 的图和公式过 PDF/UA 的时候我会从它开始。
