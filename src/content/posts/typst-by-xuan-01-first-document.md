---
title: "第一份文档：标记语法、编译与 watch"
commentId: "post:typst-by-xuan-01-first-document"
published: "2026-10-19 08:00:00 +08:00"
description: "用 Xuan 从零学 Typst 第 1 篇：我在 Typst 0.15.1 里编译了四份成品文档，用同一份 8 节、30 个公式、5 张表的中文文档对比 Typst 与 latexmk（226 ms 对 3.131 s，快 13.85 倍），并亲手跑了 compile、watch、fonts 和 --root，把标记语法与三种模式逐条编译了一遍。"
category: Tutorial
tags:
  - Typst
  - Xuan
  - 入门
  - 排版
  - LaTeX
series: "用 Xuan 从零学 Typst"
seriesOrder: 1
draft: false
comment: true
slug: typst-by-xuan-01-first-document
---

我手上有一个叫 `xuan`（宣纸）的 Typst 模板包，加一个叫 `typst-lab` 的仓库，它们能产出四种文档：带目录和公式编号的笔记、可以开关解答的作业、幻灯片、中英文双语的简历。下面是四份成品的第一页，全部由 Typst 0.15.1 编译而来：

![笔记第一页：标题、摘要、目录，正文有带编号的公式和交叉引用](/assets/images/typst-by-xuan/ch01-tour-notes.png)

![作业第一页：课程、姓名、学号、总分 100，四道题，每题下方有带左侧竖线的解答块](/assets/images/typst-by-xuan/ch01-tour-homework.png)

![幻灯片标题页：Typst 一小时入门，居中的标题、副标题、作者和日期](/assets/images/typst-by-xuan/ch01-tour-slides.png)

![简历：张三，教育经历、实习经历、项目经历、技能四个分节，一页 A4](/assets/images/typst-by-xuan/ch01-tour-cv.png)

这个系列要做的事：从一份空文件开始，一章一章把 `xuan` 和这四份文档重新写出来。写完第 16 章，你的目录和我的仓库一致，而 Typst 这门语言（标记、脚本、样式、布局、数学、数据、模块、包、WebAssembly 插件、导出）会在第一次被用到的地方讲清楚。不需要先读文档。

> [!NOTE] 本篇检查点
> 这一篇结束时你会有：克隆好的 `typst-lab` 仓库和一个能用的 `nix develop` 环境，`make ch01` 通过（4 个文件全部 `ok`，其中 `unclosed.fail.typ` 按预期编译失败），以及对 Typst 标记语法、三种模式和 `compile`/`watch`/`fonts`/`--root` 四组命令行选项的第一手认识。`xuan` 包的源文件在这一篇里还一个都没有写，从第 3 篇起才出现。
> 涉及的 Typst 特性：标记语法（段落、强调、行内与块级 raw、自动链接、标题、三种列表、标签与引用、换行与转义、注释）、标记/代码/数学三种模式与 `#` 嵌入规则、`typst compile`、`typst watch`、`typst fonts`、`--root`、`--font-path`、`--ignore-system-fonts`、`--ignore-embedded-fonts`。
> 这是第 1 篇，没有前置章节。

## 先看一个数字

我很快就会让你去写 Typst，但在那之前我想先交代为什么值得换：同一份文档，Typst 比 LaTeX 快多少。

我用脚本 `scripts/gen-bench.sh` 生成了两份内容等价的文档（一份 `.typ`，一份 `.tex`）：8 节，30 个带编号的公式，5 张表，目录，20 处交叉引用，大段中英混排正文。两边都用同一个字体 Maple Mono NF CN 来排中文，LaTeX 用 `fontspec` + `xeCJK` + `amsmath` + `booktabs` + `hyperref`，由 `latexmk -xelatex` 编译。

为什么是 Maple Mono 而不是正文该用的 Noto Serif CJK？因为 `xdvipdfmx` 嵌不进可变字体版的 Noto TTC（报 `sfnt: table not found`），而我这台机器上唯一的静态 CJK 字体就是 Maple Mono。对比要公平，就得让两个引擎吃同一个静态 TTF。（顺带一提，这意味着这份基准不是排版好看的基准，只是引擎速度的基准。）

跑法是 `make bench`，里面是 `hyperfine`，每轮 LaTeX 之前先 `latexmk -C` 清掉辅助文件，所以 LaTeX 是冷启动：

```text
$ make bench
Benchmark 1: typst compile --root . lab/ch01/bench/same.typ out/bench/same.pdf
  Time (mean ± σ):     226.1 ms ±   5.4 ms    [User: 145.9 ms, System: 85.8 ms]
  Range (min … max):   214.6 ms … 236.3 ms    13 runs

Benchmark 2: latexmk -xelatex -interaction=nonstopmode -outdir=out/bench/tex lab/ch01/bench/same.tex >/dev/null
  Time (mean ± σ):      3.131 s ±  0.072 s    [User: 2.416 s, System: 0.687 s]
  Range (min … max):    3.025 s …  3.252 s    10 runs

Summary
  typst compile --root . lab/ch01/bench/same.typ out/bench/same.pdf ran
   13.85 ± 0.46 times faster than latexmk -xelatex -interaction=nonstopmode -outdir=out/bench/tex lab/ch01/bench/same.tex >/dev/null
```

226 ms 对 3.131 s，14 倍。输出都是 9 页（`pdfinfo` 数的）。机器是 AMD Ryzen 7 PRO 6850U，16 个线程，LaTeX 是 TeX Live 2025（`XeTeX 3.141592653-2.6-0.999997`）。注意 `nix develop` 不提供 `xelatex` 和 `latexmk`，它们是我系统里自带的；你的机器上没有的话，`make bench` 会打印 `skip: xelatex not found`，然后只测 Typst 那一半。

几条诚实的限定：这是一台机器上、一份合成文档的数字，我猜换成你的论文会有出入。LaTeX 一侧我用的是 `latexmk`，它会按需要重复调用 `xelatex` 直到目录和引用稳定，我没有数它实际跑了几遍，所以这 14 倍里有多少是“遍数”、有多少是引擎本身，我说不清。但对“每次保存都想看结果”的日常写作来说，3 秒和 0.2 秒是两种体验，下面的 `watch` 会让你直接看到。

## 这个系列怎么读

规矩有四条。

**固定的代码快照。** 参考实现是仓库 [`typst-lab`](https://github.com/bfmhno3/typst-lab/tree/tutorial-v1) 的 `tutorial-v1` 标签。这一篇的所有命令都在它上面跑过。每章末尾的检查点会告诉你哪些文件已经是最终版（必须和标签一致），哪些还是中间版本，后面的篇章会继续改它们。

**每章一个实验目录。** 第 N 篇对应仓库里的 [`lab/chNN/`](https://github.com/bfmhno3/typst-lab/tree/tutorial-v1/lab/ch01)，里面是一堆小的 `.typ` 文件，`make chNN` 一次编译全部。我引用它们时会写出路径。文件我都按 `typstyle -l 80` 格式化过，贴在文中的就是它们的原样；太长的文件我会只贴有教学价值的部分并明说。

**`*.fail.typ` 与 `*.warn.typ`。** 凡是文件名带 `.fail.typ` 的，它的使命就是编译失败；带 `.warn.typ` 的必须编译成功但有警告。`scripts/chapter.sh` 会检查这个预期，期望失败却成功了，脚本本身就报错。仓库里文件的错误信息，我都是从 `out/chNN/*.stderr` 里原样贴出来的；少数是我在 `/tmp` 里为讲解临时写的小实验，我会明说。

**真实输出。** 本系列的所有命令输出，都是在 Typst 0.15.1（`9dfd3a08`）上跑出来的。输出偶尔会被我截断（用 `...` 标出），但不会改写。版本不同时，错误信息的措辞可能略有出入。

下面是整个系列的地图：

| 篇 | 标题 | 主要的 Typst 内容 |
| --- | --- | --- |
| 1 | 第一份文档：标记语法、编译与 watch | 标记语法、三种模式、`compile`/`watch`/`fonts`、`--root` |
| 2 | [代码模式：值、类型与控制流](/posts/typst-by-xuan-02-code-mode/) | 值与类型、`let`、`if`/`for`/`while`、数组与字典、`assert` |
| 3 | [函数与 content：一切都是函数调用](/posts/typst-by-xuan-03-functions-and-content/) | 函数、`..args`、闭包、content 树、`xuan` 的 `util.typ` |
| 4 | [set 与 show：样式是规则，不是命令](/posts/typst-by-xuan-04-set-and-show/) | `set`/`show`、选择器、第一个模板 `note`、包的目录结构 |
| 5 | [字体与中文排版](/posts/typst-by-xuan-05-fonts-and-cjk/) | 字体回退、`text` 参数、`cjk-latin-spacing`、`par`、中文编号 |
| 6 | [页面与布局：盒子、网格与浮动](/posts/typst-by-xuan-06-page-and-layout/) | `page`、`block`/`box`、`grid`、`place`、`rotate`、`layout`/`measure` |
| 7 | [context、计数器与状态：Typst 如何“多遍”编译](/posts/typst-by-xuan-07-context-counters-state/) | `context`、`counter`、`state`、`query`、定理环境、收敛警告 |
| 8 | [数学公式](/posts/typst-by-xuan-08-math/) | 数学模式全部语法、LaTeX 对照表、公式编号 |
| 9 | [图、表、代码与交叉引用](/posts/typst-by-xuan-09-figures-tables-code/) | `figure`、`table`、`raw`、`ref`、`outline`、`footnote`、单位 |
| 10 | [参考文献：BibTeX、Hayagriva 与 GB/T 7714](/posts/typst-by-xuan-10-bibliography/) | `bibliography`、`cite`、CSL、多个参考文献表 |
| 11 | [数据驱动：用一份 YAML 生成中英文简历](/posts/typst-by-xuan-11-data-driven-cv/) | `yaml`/`csv`/`json`、`sys.inputs`、`eval`、`datetime` |
| 12 | [作业模板：模块、多文件与条件编译](/posts/typst-by-xuan-12-homework/) | `import`、`include`、`path` 类型、条件编译解答 |
| 13 | [幻灯片与绘图](/posts/typst-by-xuan-13-slides-and-drawing/) | 图形函数、颜色、渐变、`tiling`、幻灯片模板 |
| 14 | [生态：Typst Universe 与第三方包](/posts/typst-by-xuan-14-packages-ecosystem/) | `@preview` 包、CeTZ、Lilaq、Touying、`typst.toml` |
| 15 | [用 Rust 写一个 WebAssembly 插件：按拼音排序术语表](/posts/typst-by-xuan-15-wasm-plugin/) | `plugin`、字节协议、Rust `wasm-minimal-protocol` |
| 16 | [导出、工具链与 CI](/posts/typst-by-xuan-16-export-and-tooling/) | PDF 标准、PNG/SVG/HTML、`typst eval`、tinymist、typstyle、CI |

顺序就是依赖顺序：每一篇只会用到前面讲过的东西。

## 装环境

`typst-lab` 有一个 `flake.nix`，`nix develop` 进去就是我用的全部工具，字体也在里面：

```bash
git clone --branch tutorial-v1 https://github.com/bfmhno3/typst-lab.git
cd typst-lab
nix develop
```

进去的时候 shell 会打印一行横幅，我这边是：

```text
typst-lab dev shell: typst 0.15.1 (9dfd3a08), 0.15.0, rustc 1.97.1 (8bab26f4f 2026-07-14) (built from a source tarball)
```

三个版本依次是 Typst 0.15.1、typstyle 0.15.0（代码格式化器，第 16 篇用）、Rust 1.97.1（第 15 篇用）。`flake.lock` 钉死的 nixpkgs 版本和这个博客的一样，所以你装出来的版本应该就是这几个。没有 Nix 的话，你需要自己装 Typst 0.15.1 和 Noto Serif CJK、Noto Sans CJK 字体，再把字体目录写进环境变量 `TYPST_FONT_PATHS`、把仓库里的 `packages/` 写进 `TYPST_PACKAGE_PATH`；我没有在非 Nix 环境里验证过完整流程，所以这条路径上的输出我不替你担保。

shell 还做了三件事，后面都会用到：把字体目录放进 `TYPST_FONT_PATHS`，把仓库的 `packages/` 放进 `TYPST_PACKAGE_PATH`（第 4 篇讲为什么），以及 `unset SOURCE_DATE_EPOCH`（不然 `datetime.today()` 在 nix shell 里永远是 1980-01-01）。

之后所有命令都在仓库根目录、`nix develop` 里执行，Makefile 开头有个守卫，不在 shell 里就报 `run inside nix develop`。

## 第一次编译

最小的文件是 [`lab/ch01/hello.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch01/hello.typ)：

```typst
= 你好，Typst

这是第一份文档。保存后 `typst watch` 会立刻重新编译。
```

没有 `\documentclass`，没有 `\begin{document}`，没有导言区。第一行 `=` 加空格是一级标题，空一行是新段落，反引号包起来的是行内代码。编译：

```text
$ typst compile hello.typ
$ ls
hello.pdf  hello.typ
```

没有输出就是成功。输出文件默认是同名的 `.pdf`。这个文件在我机器上编译一次，`hyperfine -N` 测得：带 `--ignore-system-fonts` 是 83.5 ± 5.4 ms，不带是 182.9 ± 2.6 ms。多出来的约 100 ms，我猜是扫描这台机器上 284 个系统字体族的代价（下面讲 `typst fonts` 时你会看到这个数字），我没有单独验证。两个数字都含进程启动。

有一件事我先点一下：这个文件没有指定字体，但标题和正文里的汉字显示出来了。我用 `pdffonts` 看了（带 `--ignore-system-fonts` 编译出来的）PDF，里面嵌了 `LibertinusSerif`（拉丁字母，Typst 内置的默认字体）、`DejaVuSansMono`（行内代码，也是内置的）和一个叫 `NotoSansCJKjp-Thin` 的字体（汉字）。Libertinus 里没有汉字，所以 Typst 往后找，找到了我环境变量里的 Noto Sans CJK。这个“碰巧能用”不可靠（连选中了哪个变体都不由我决定），第 5 篇我们会把每一层字体都显式钉死，那个奇怪的字体名也到时再解释。

### watch：保存即编译

`typst watch` 和 `compile` 参数一样，但进程不退出，文件一变就重新编译。我在一个临时目录里拷了 `hello.typ`，后台起 watch，隔几秒往文件末尾追加一行，再追加一次：

```bash
mkdir -p /tmp/t01 && cp lab/ch01/hello.typ /tmp/t01/ && cd /tmp/t01
typst watch hello.typ >watch.log 2>&1 &
W=$!
sleep 3; echo "这是新增的一行。" >> hello.typ
sleep 2; echo "再改一次。" >> hello.typ
sleep 2; kill $W
```

日志里（我去掉了重复打印的头两行 `watching hello.typ` / `writing to hello.pdf`：输出到文件时 watch 每次都会重复它们，我猜在真终端里它们是原地刷新的，这一点我没有核实）有价值的行是：

```text
[08:19:30] compiling ...
[08:19:30] compiled successfully in 50.47 ms
[08:19:33] compiling ...
[08:19:33] compiled successfully in 3.36 ms
[08:19:35] compiling ...
[08:19:35] compiled successfully in 2.66 ms
```

首次编译 50.47 ms，之后每次增量编译 3.36 ms 和 2.66 ms。我猜是 Typst 缓存了没变的部分，改一行只重排受影响的内容，不过我没有去读它的源码确认。（我这份文档只有一个段落，所以三毫秒是下限，不是你 100 页论文的数字。）

这就是我说的“保存即看到”：编辑器里按保存，旁边开一个 PDF 阅读器，PDF 在你抬头之前已经刷新。第 16 篇我们会让 tinymist 在编辑器里做同样的事，带实时预览。

## 标记语法：一次过一遍

下面是本篇的主角 [`lab/ch01/markup-tour.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch01/markup-tour.typ)，我把 Typst 日常写作用到的标记几乎都塞进了它：

````typst
#set page(width: 14cm, height: auto, margin: 1cm)
#set heading(numbering: "1.1")

= 标记语法速览 <tour>

普通段落，*加粗*，_强调_，行内代码 `let x = 1`，自动链接 https://typst.app。
空行分段；行末加反斜杠 \
可以强制换行。不换行空格 10~km，连字符 -- 与 --- 分别是 en dash 与 em dash。
智能引号："double" 与 'single'。

== 列表与术语

- 无序列表
- 第二项
  - 嵌套一层

+ 有序列表
+ 编号自动递增

/ 术语: 这是术语列表的说明。
/ Typst: 一门基于标记的排版语言。

== 代码块与标签 <code>

```rust
fn main() {
    println!("hello");
}
```

转义：\#、\*、\_，Unicode：\u{4e2d}\u{6587}。
引用：见 @tour 与 @code。

// 这一行是注释，不会出现在输出里。
/* 块注释
也一样。 */
````

开头两行 `#set` 先不管（它们是第 4 篇的主题，这里只是让页面窄一点、标题带编号，方便截图和引用）。编译它，用 `--pages 1 --format png --ppi 72` 渲染成图：

```text
$ typst compile --root . --ignore-system-fonts lab/ch01/markup-tour.typ out/ch01/markup-tour.pdf
$ typst compile --root . --ignore-system-fonts --pages 1 --format png --ppi 72 lab/ch01/markup-tour.typ out/figures/ch01-markup-page.png
```

结果：

![markup-tour.typ 的第一页：一级标题带编号 1，下面是加粗、强调、行内代码、自动链接，两个二级标题 1.1 与 1.2，列表、术语表、带语法高亮的 Rust 代码块，以及“见 Section 1 与 Section 1.2”](/assets/images/typst-by-xuan/ch01-markup-page.png)

我把每一条语法对应到它的效果，逐个说明。

### 行内格式

**`*加粗*`、`_强调_`。** 星号包的是 strong，下划线包的是 emph。它们是 `strong[...]` 和 `emph[...]` 这两个函数调用的语法糖，第 3 篇会证明这一点。

中文里不需要空格，`中文*加粗*中文` 照样生效。但紧贴在英文单词里的星号就不会触发加粗。我编译了一个暂存文件 `cjkstrong.typ`（不在仓库里，只是我为这一节做的实验）：

```typst
中文*加粗*中文，English*not*Strong，中_强调_文。
```

`pdftotext` 抽出来的文字是：

```text
中文加粗中文，English*not*Strong，中强调文。
```

汉字之间的 `*...*` 被当作加粗，而紧贴在英文单词里的 `*not*` 原样输出了星号。我另外试了 `2*3*4 与 a*b*c`，输出仍是 `2*3*4 与 a*b*c`：夹在字母数字之间的星号不触发加粗。

**行内代码与代码块。** 单个反引号包的是行内 raw，等宽字体；三个反引号包的是块级 raw，开头紧跟语言名（上面的 `rust`）就会按该语言高亮。raw 里面的 `*`、`_`、`#` 都不再有含义，所以里面可以放任何字符。

**自动链接。** 以 `http://` 或 `https://` 开头的片段不需要任何包装就是可点击链接。句子末尾的标点不会被吞：

```typst
网址 https://typst.app/docs，之后。
再 https://typst.app/docs. 之后。
```

我用 `typst eval 'query(link).map(l => l.dest)' --in link.typ --format json` 看这两个链接（一个后面跟全角逗号，一个后面跟英文句号和空格），得到 `["https://typst.app/docs","https://typst.app/docs"]`：标点没有被吞进链接。

### 段落、换行与空格

**空行分段。** 一个空行是一个新段落，两行之间的单个换行只是空白。

**`\` 强制换行。** 行末写反斜杠，段落内断行，不开新段。上面的“空行分段；行末加反斜杠 \\”之后下一行就是强制换行的结果。

**`~` 不换行空格。** `10~km` 是一个不可拆的空格，`10` 与 `km` 不会被拆到两行。

**`--` 与 `---`。** 分别是 en dash（U+2013）与 em dash（U+2014）。这是 Typst 的“shorthand”，在编译阶段替换。同类的还有 `...` 变成 U+2026 省略号：我编译 `省略号...` 得到 `省略号…`。但箭头 `->` 和 `<=` 在标记模式里原样输出（我编译验证过）；换到数学模式 `$a -> b <= c$`，它们变成了 `→` 和 `≤`。符号简写的这一半，第 8 篇再讲。

**智能引号。** 直引号 `"double"` 与 `'single'` 会变成弯引号，图里正是 “double” 与 ‘single’；我加了 `#set text(lang: "zh")` 再编译，抽出来的还是弯引号。这是 `smartquote` 的工作，第 5 篇再细讲。

### 标题、列表与术语

**标题。** 行首 `=` 加空格是一级标题，`==` 是二级，以此类推。`=` 后面如果没有空格，它就只是普通文字：我编译 `=标题`，输出的是原样的 `=标题`。

**列表。** 三种：

- `-` 无序列表，缩进两个空格再写 `-` 就是嵌套（图里嵌套一层变成了三角形项目符号）。
- `+` 有序列表，编号自动递增，不用手写 1. 2. 3.。
- `/ 术语: 说明` 术语列表，冒号前面是术语，后面是解释。

三种列表是三个函数的语法糖：`list`、`enum`、`terms`。

### 标签、引用与转义

**`<tour>` 与 `@tour`。** 在标题（或任何元素）后面写 `<名字>` 给它贴一个标签，之后在任何地方写 `@名字` 引用它。图里的 “见 Section 1 与 Section 1.2” 就是 `@tour` 和 `@code` 的渲染结果，前缀 `Section` 是因为这个文件没有设 `lang`。我把 `lang` 设成 `"zh"` 编译了另一个暂存文件 `refzh.typ`，同一种引用变成“见 小节 1。”，第 5 篇和第 9 篇会处理这类本地化。

引用有一个前提，我故意没满足的时候能看到：

```typst
= 引言 <intro>

见 @intro。
```

```text
error: cannot reference heading without numbering
  ┌─ noref.typ:3:2
  │
3 │ 见 @intro。
  │    ^^^^^^
  │
  = hint: you can enable heading numbering with `#set heading(numbering: "1.")`
```

标题没有编号的时候，引用不知道该显示什么，Typst 直接报错并告诉你怎么修。这就是 `markup-tour.typ` 开头 `#set heading(numbering: "1.1")` 的原因。

**转义。** `\#`、`\*`、`\_` 让特殊字符按字面输出，`\u{4e2d}\u{6587}` 是按码点写 Unicode，输出“中文”。我另外试了 `\u{e9}` 与 `\u{20ac}`，编译后 `pdftotext` 抽出的是 `é€`，花括号里是十六进制码点。`\#65` 输出的只是字面的 `#65`。

**注释。** `//` 到行尾，`/* ... */` 可以跨行，它们都不会出现在输出里。

### 语法一览

| 想要的效果 | 写法 | 对应函数 |
| --- | --- | --- |
| 加粗 | `*文字*` | `strong` |
| 强调 | `_文字_` | `emph` |
| 行内代码 | `` `code` `` | `raw` |
| 代码块 | 三个反引号加语言名 | `raw(block: true)` |
| 一级标题 | `= 标题` | `heading(level: 1)` |
| 无序列表 | `- 项` | `list` |
| 有序列表 | `+ 项` | `enum` |
| 术语列表 | `/ 术语: 说明` | `terms` |
| 标签 | `<name>` | 贴在前一个元素上 |
| 引用 | `@name` | `ref` |
| 强制换行 | 行末 `\` | `linebreak` |
| 不换行空格 | `~` | 编译期替换 |
| en/em dash | `--` / `---` | 编译期替换 |
| 转义 | `\#`、`\u{4e2d}` | 编译期替换 |
| 注释 | `//`、`/* */` | 无 |

## 三种模式

上面的 `#set heading(...)` 是我偷偷用到的第一处“代码”。Typst 有三种模式，在它们之间切换，是这门语言最核心的设计。我用一个暂存文件 `modes.typ`（不在仓库里）把三种模式混在一起：

```typst
#let w = 3
#let name = "Typst"

// 代码模式：# 后面接一个表达式，到表达式结束为止
宽度是 #w 厘米，#name.len() 个字母。
// 方法调用、字段访问会被吃进去，标点不会
先 #name，再 #name.
// 想让表达式带上后面的文字，用括号或者 #[]
#(w + 1)cm，#(name)er，#upper[hello]world

// 代码块内部是代码模式，方括号回到标记模式
#{
  let n = 2 + 3
  [n 等于 #n，]
  "字符串也会被拼进来。"
}

// 数学模式
行内 $x^2 + y^2 = z^2$，块级：
$ sum_(i=1)^n i = (n(n+1)) / 2 $
数学里嵌代码：$#w dot 2 = #(w * 2)$。
```

编译（`typst compile modes.typ`）后，`pdftotext -layout` 抽出的文字是：

```text
宽度是 3 厘米，5 个字母。 先 Typst，再 Typst. 4cm，Typster，HELLOworld
n 等于 5，字符串也会被拼进来。
行内 𝑥2 + 𝑦2 = 𝑧 2 ，块级：
                             𝑛
                                   𝑛(𝑛 + 1)
                            ∑𝑖 =
                            𝑖=1
                                      2

数学里嵌代码：3 ⋅ 2 = 6。
```

（数学公式在文本抽取里会被拆散，这不影响 PDF 里的样子，第 8 篇我们会直接看渲染图。）

三种模式的规则，逐条对着这个输出看。

**标记模式是默认模式。** 文件开头就在标记模式：你写的字就是文字，`*`、`_`、`=`、`-` 这些有含义。这像一场普通话的对话，偶尔夹一句另一种语言，说完自动切回来：`#` 就是那个“我要换一种说法”的信号。

**`#` 进入代码模式，只管一个表达式。** `#w` 取变量值，`#name.len()` 连方法调用一起吃进去（“Typst”有 5 个字母），`#upper[hello]` 是函数调用，方括号里是内容参数。表达式到哪里结束：标识符、字段访问和方法调用、函数调用的括号和方括号是表达式的一部分；其他字符，包括中文逗号和句号，结束它。所以 `先 #name，再 #name.` 里第二个 `.` 后面没有标识符，句号留在文字里，输出的是 `Typst.`。

**想紧贴后面的字，用括号。** `#(w + 1)cm` 把 `w + 1` 算完得到 4，后面的 `cm` 原样输出，最终是 `4cm`。`#(name)er` 同理得到 `Typster`。没有括号写 `#namer` 就是在引用变量 `namer`，会报“unknown variable”。

**`#{ ... }` 是代码块，`[ ... ]` 是内容块。** 花括号里是代码模式，每一行是一条语句，`let` 声明变量；方括号里又回到标记模式，`[n 等于 #n，]` 是一段含代码的内容。块里最后那个字符串字面量也被拼进了输出：代码块把每条语句的结果“连接”（join）起来，这一点第 2 篇讲得很细。

**`$ ... $` 是数学模式。** 美元符号紧贴内容是行内公式，美元符号与内容之间各留一个空格是块级公式（居中，单独一行）。上标 `^`、下标 `_`、分式 `/`、求和 `sum` 都是数学模式自己的语法，和标记模式里的符号含义不同。在数学里再次嵌入代码也是 `#`：`$#w dot 2 = #(w * 2)$` 得到 `3 ⋅ 2 = 6`。

这一节的规则，我压成一张表：

| 位置 | 默认模式 | 进入下一种的符号 |
| --- | --- | --- |
| 文件顶层、`[...]` 内部 | 标记 | `#` 进入代码，`$` 进入数学 |
| `#{ ... }`、`#(...)`、函数参数 | 代码 | `[...]` 回到标记，`$...$` 进入数学 |
| `$ ... $` | 数学 | `#` 进入代码 |

进入代码之后就不需要再写 `#` 了：`#{ ... }` 里面的 `let`、函数调用前面都没有 `#`，只有从方括号回到标记模式、再嵌入代码时才重新需要它（`[n 等于 #n，]`）。

## 编译失败长什么样

我在 [`lab/ch01/unclosed.fail.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch01/unclosed.fail.typ) 里故意写了一个忘记关闭的加粗：

```typst
= 标题

*忘记关闭的加粗
```

```text
error: unclosed delimiter
  ┌─ lab/ch01/unclosed.fail.typ:3:0
  │
3 │ *忘记关闭的加粗
  │ ^

```

Typst 指出第 3 行第 0 列，高亮的是起始的那个 `*`，也就是没关的那个。`make ch01` 里它显示为 `ok   lab/ch01/unclosed.fail.typ (failed as expected)`。

## 命令行：fonts 与 --root

到这里已经够写一份笔记了。下面把命令行补全。`typst --help` 里的子命令只有这些：

```text
Commands:
  compile      Compiles an input file into a supported output format [aliases: c]
  watch        Watches an input file and recompiles on changes [aliases: w]
  init         Initializes a new project from a template
  eval         Evaluates a piece of Typst code, optionally in the context of a document
  fonts        Lists all discovered fonts in system and custom font paths
  completions  Generates shell completion scripts
  info         Displays debugging information about Typst
  help         Print this message or the help of the given subcommand(s)
```

（我把换行折回了一行。`init` 在第 14、16 篇，`eval` 在第 16 篇。）

### `typst fonts` 与字体的三层来源

Typst 会从三个地方找字体：二进制里内置的、系统安装的、命令行或环境变量指定的目录。`typst fonts` 列出它找到的全部，每行一个字体族。在我的机器上：

```text
$ typst fonts | wc -l
284
$ typst fonts --ignore-system-fonts | wc -l
20
```

284 个字体族（这台机器装了很多字体）对 20 个。`--ignore-system-fonts` 把系统字体全部忽略，只剩内置字体加上 `TYPST_FONT_PATHS` 里的目录，这是我给整个系列设的规矩：所有 `make` 目标都带这个选项，这样同一份文档在你的机器上和在我的机器上用的是同一组字体，不会因为我多装了几个字体而让输出悄悄不同。

这 20 个是：

```text
$ typst fonts --ignore-system-fonts
DejaVu Sans Mono
Libertinus Serif
Maple Mono NF
New Computer Modern
New Computer Modern Math
Noto Sans CJK HK
Noto Sans CJK JP
Noto Sans CJK KR
Noto Sans CJK SC
Noto Sans CJK TC
Noto Sans Mono CJK HK
Noto Sans Mono CJK JP
Noto Sans Mono CJK KR
Noto Sans Mono CJK SC
Noto Sans Mono CJK TC
Noto Serif CJK HK
Noto Serif CJK JP
Noto Serif CJK KR
Noto Serif CJK SC
Noto Serif CJK TC
```

前面四个（DejaVu Sans Mono、Libertinus Serif、New Computer Modern 与它的 Math）是 Typst 内置的，不需要安装；Noto 的 15 个和 Maple Mono 来自 flake 设置的 `TYPST_FONT_PATHS`。我把环境变量拿掉，看每个选项单独的效果：

```text
$ env -u TYPST_FONT_PATHS typst fonts --ignore-system-fonts | wc -l
4
$ env -u TYPST_FONT_PATHS typst fonts --ignore-system-fonts --ignore-embedded-fonts | wc -l
0
$ SER=$(echo $TYPST_FONT_PATHS | tr ':' '\n' | grep serif)
$ env -u TYPST_FONT_PATHS typst fonts --ignore-system-fonts --font-path "$SER" | wc -l
9
$ env -u TYPST_FONT_PATHS typst fonts --ignore-system-fonts --ignore-embedded-fonts --font-path "$SER" | wc -l
5
```

- 没有任何额外路径、忽略系统字体：只剩 4 个内置的。
- 再加 `--ignore-embedded-fonts`：连内置字体也扔掉，0 个。
- `--font-path` 指向 Noto Serif CJK 的目录（递归搜索）：4 + 5 = 9 个。
- 同时忽略内置字体：只剩那 5 个 Noto Serif CJK（HK、JP、KR、SC、TC）。

`--font-path` 用系统的路径分隔符（Linux 上是冒号）接受多个目录，环境变量 `TYPST_FONT_PATHS` 是它的等价写法，这就是 flake 里那一长串路径的来源。`--ignore-embedded-fonts` 平常用不到；上面的实验里它把内置的 4 个字体族全部去掉了，所以需要“文档绝不能依赖内置字体”的时候可以打开它。

字体的真正学问，比如为什么 `NotoSerifCJKsc-ExtraLight` 这个名字会出现在 PDF 里，还有字体回退列表，我们留给第 5 篇。

### `--root`：谁是项目的根

`import` 和 `include` 里以 `/` 开头的路径，相对于“项目根”，而根默认是输入文件所在的目录。我在 `/tmp/t01/proj` 里放了两个文件：

```text
proj/
├── common.typ
└── sub/
    └── page.typ
```

```typst
子目录里的页面。

#include "/common.typ"
```

先按默认编译 `sub/page.typ`，根是 `sub/`，找不到 `/common.typ`：

```text
$ typst compile sub/page.typ
error: file not found (searched at /tmp/t01/proj/sub/common.typ)
  ┌─ sub/page.typ:3:9
  │
3 │ #include "/common.typ"
  │          ^^^^^^^^^^^^^

```

指定根目录之后，同一个文件编译通过：

```text
$ typst compile --root . sub/page.typ
$ pdftotext sub/page.pdf -
子目录里的页面。
共用的页脚。
```

这也是仓库所有 `make` 目标都带 `--root .` 的原因：文档放在 `lab/ch12/modules/` 之类的子目录里，但它们都想用从仓库根算起的路径。`--root` 同时还限定了可读文件的范围：我把根设成 `sub`，让 `sub/o.typ` 去 `#include "../common.typ"`，得到

```text
error: path `"../common.typ"` would escape the project root
  ┌─ sub/o.typ:1:9
  │
1 │ #include "../common.typ"
  │          ^^^^^^^^^^^^^^^
  │
  = hint: cannot access files outside of the project sandbox
  = hint: you can adjust the project root with the `--root` argument
```

第 12 篇讲模块的时候会再回来。

## 跑一遍 `make ch01`

四个选项加上 `typst compile` 的 `--pages`、`--format`、`--ppi`，就是 `lab/ch01/extra.sh` 做的事：它读 `examples/*/main.typ`，把每份成品的第一页渲染成 72 dpi 的 PNG，也就是本文开头的四张图。命令是 `make ch01`，它会先 `make examples`（编译全部成品）。第一次跑要联网：`examples/ecosystem` 会从 Typst Universe 下载 `@preview` 包（第 14 篇的内容），之后走缓存。然后它编译 `lab/ch01/` 里的每个文件：

```text
$ make ch01
typst compile examples/cv/main.typ
typst compile examples/ecosystem/main.typ
typst compile examples/homework/main.typ
typst compile examples/notes/main.typ
typst compile examples/slides/main.typ
./scripts/chapter.sh ch01
ok   lab/ch01/fig-markup.typ
ok   lab/ch01/hello.typ
ok   lab/ch01/markup-tour.typ
ok   lab/ch01/unclosed.fail.typ (failed as expected)
```

五份成品的页数（`pdfinfo`）：笔记 4 页，作业 1 页（`homework-questions.pdf` 同样 1 页），简历 1 页（中文和英文版各一页），幻灯片 17 页，`ecosystem` 1 页（第 14 篇的）。其中 `fig-markup.typ` 把一段标记源码和它的渲染结果并排放在一张图里：

![左边是标记语法的源码，右边是同一段源码被 eval 之后的渲染结果：标题、加粗、强调、行内代码、列表、编号、术语](/assets/images/typst-by-xuan/ch01-markup.png)

它的源码有 12 行：

```typst
#set page(width: auto, height: auto, margin: 12pt)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"), lang: "zh")

#let src = "= 标题\n*粗体* _斜体_ `code`\n- 项一\n+ 编号一\n/ 术语: 说明"

#grid(
  columns: 2,
  gutter: 1.5em,
  align: horizon,
  raw(src, lang: "typ", block: true),
  block(width: 6cm, eval(src, mode: "markup")),
)
```

（这里用到了 `eval(src, mode: "markup")`：把一个字符串当 Typst 标记来编译。第 11 篇我们会用它让 YAML 里的字符串带格式。左边源码里的 `*粗体*`、`_斜体_` 被上了色，是 `raw(..., lang: "typ")` 的效果，我猜 `typ` 指的是 Typst 标记的高亮，没有去查。`#grid`、`#set` 都是后面几篇的内容，这里只需要看效果。）

## 接下来

下一篇我们进入代码模式的内部：`#let w = 3` 里的 `3` 是什么类型，两个汉字的字符串为什么 `len()` 是 6 而 `clusters().len()` 是 2，`if`、`for` 的结果为什么能直接拼进文档。`modes.typ` 里那个“代码块把每条语句拼起来”的行为，到那时会有一张完整的规则表。

在那之前，你可以先把 `watch` 开着，自己试三件事：把 `markup-tour.typ` 里的 `@tour` 换成一个不存在的标签看错误信息；把 `-- ---` 换成 `----` 看它变成什么；把 `#set page(width: 14cm ...)` 删掉，看 Typst 的默认页面长什么样。错误信息的格式一旦认识，后面十五篇里的所有 `*.fail.typ` 你都读得懂。

下一篇：[代码模式：值、类型与控制流](/posts/typst-by-xuan-02-code-mode/)。
