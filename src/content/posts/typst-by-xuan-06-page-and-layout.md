---
title: "页面与布局：盒子、网格与浮动"
commentId: "post:typst-by-xuan-06-page-and-layout"
published: "2026-10-19 13:00:00 +08:00"
description: "用 Xuan 从零学 Typst 第 6 篇：我用 Typst 0.15.1 编译了 ch06 的 6 个 lab 文件和十几个临时实验，实测 fr 怎样分配剩余空间、弱间距怎样折叠、float 怎样改变正文流，再把纸张、边距和标题块收进 @local/xuan:0.1.0 的 page.typ。"
category: Tutorial
tags:
  - Typst
  - Xuan
  - 布局
series: "用 Xuan 从零学 Typst"
seriesOrder: 6
draft: false
comment: true
slug: typst-by-xuan-06-page-and-layout
---

下面这段 Typst 在一个句子中间放了一个旋转的盒子：`前 #rotate(10deg, ...) 后`。编出来的 PDF 上，“前”“后”和盒子各占一行，一句话被劈成三段。Typst 没有出错，这是它的布局模型：页面里是一条自上而下的块级流，段落是其中的一种块，段落里面才是自左向右的行内流，而 `rotate` 站在了块这一边。这一篇我把页面和布局的全部构件逐个跑一遍，每个都用数字回答“它到底占多少空间”，最后把纸张、边距和标题块收进 `xuan` 的 `page.typ`。

> [!NOTE] 本篇检查点
> 这一篇结束时你会有 `src/page.typ`（**最终版**，40 行，下面完整展示）。`lib.typ` 和 `note.typ` 不变：第 4 篇的 `lib.typ` 已经带着 `#import "src/page.typ": title-block, xuan-page` 这一行，`note` 也已经在调用它们，这一篇只是把黑盒打开。`lab/ch06/` 下的 6 个文件全部通过 `make ch06`。
> 前置：[第 5 篇](/posts/typst-by-xuan-05-fonts-and-cjk/)（字体与中文排版）。本篇示例的字体列表 `("Libertinus Serif", "Noto Serif CJK SC")` 就是第 5 篇 `fonts.serif` 的内容，写死在每个文件里是为了让它们能单独编译。

先在仓库里确认 lab 能跑，环境是 Typst 0.15.1，字体来自 flake（`typst --ignore-system-fonts` 由 `scripts/chapter.sh` 传入）：

```text
$ nix develop --command make ch06
./scripts/chapter.sh ch06
ok   lab/ch06/blocks.typ
ok   lab/ch06/fig-layout.typ
ok   lab/ch06/grid.typ
ok   lab/ch06/page.typ
ok   lab/ch06/place.typ
ok   lab/ch06/transforms.typ
```

6 个文件的 stderr 加起来是 0 字节：没有警告。本文里标注 `/tmp/p6` 的实验不在仓库里，代码全文都在文中，可以原样粘贴；它们和 lab 文件一样用 `typstyle -l 80` 检查过格式。

## 布局模型：块级流与行内流

先把那个让我吃惊的实验摆出来（`/tmp/p6/post/inline.typ`）：

```typst
#set page(width: 12cm, height: auto, margin: 8pt)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"))
#let tag(body) = box(stroke: 0.5pt, inset: 3pt, body)

前 #tag[box] 中 #tag[box] 后，行内容器不打断段落。

前 #rotate(10deg, tag[旋转]) 后，rotate 独占一行。

前 #scale(120%, tag[缩放]) 后，scale 也是。

前 #rect[矩形] 后，rect 是块级。

前 #box(rotate(10deg, tag[旋转])) 后，包进 box 就回到行内。
```

![五个段落：第一段两个带边框的 box 嵌在句子中间；第二到四段里 rotate、scale、rect 把句子切成前、盒子、后三行；最后一段把 rotate 包进 box，旋转的盒子又回到了句子中间](/assets/images/typst-by-xuan/ch06-inline.png)

读这张图，Typst 0.15.1 的行为是：

1. `box` 是**行内**元素：和文字、`h()` 一样排在行里，随文字折行。
2. `rect` 是**块级**元素：它出现在段落中间，就把当前段落在这里截断，自己占一整行，后面的文字另起一段。
3. `rotate` 和 `scale` 在这个版本里同样是块级。我没有去查文档里怎么说，这条结论只来自上面这张渲染图。解决办法也在图里：外面套一层 `box`，它就成了行内元素。

这就是 Typst 的布局模型，两层嵌套：

- 外层是**块流**：页面（或 `block`、`grid` 的单元格）里，块级元素自上而下堆叠，相邻块之间有间距（`block.spacing`，`par.spacing`）。段落、`block`、`grid`、`table`、`stack`、`align`、`pad`、`rect`、`columns` 都在这一层：我把它们各自塞进句子中间，`pdftotext` 看到的都是“前、元素、后”三行。
- 内层是**行流**：一个段落由一串行内元素组成，文字、`box`、`h()`、公式、符号，按宽度折行、对齐、两端对齐。

CSS 用过的读者可以直接对号入座：`box` 近似 `display: inline-block`，`block` 近似 `display: block`（我用这个类比只这一次，后面不再打比方）。段落是自动形成的：连续的行内内容被隐式收成一个段落，遇到块级元素就收尾。

### box 和 block 的参数

`lab/ch06/blocks.typ` 是这一节的主角（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch06/blocks.typ)）：

```typst
#set page(width: 14cm, height: auto, margin: 1cm)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"))

// `box` is inline, `block` is a paragraph-level container.
行内的 #box(fill: yellow, inset: 3pt, baseline: 20%)[box] 不会打断段落，
而 #block(fill: aqua, inset: 6pt, width: 100%)[block 独占一行，可以设宽度、
  圆角、描边、内边距和断页策略。]

#block(stroke: 0.5pt, radius: 4pt, inset: 8pt, breakable: false)[
  `breakable: false` 保证这个块不会被分页切开。
]

// Alignment, padding, spacing.
#align(right)[右对齐]
#align(center + horizon, rect(height: 1.5cm, width: 100%)[居中且垂直居中])
#pad(x: 1cm, rect(width: 100%)[`pad` 向内缩 1cm])
左 #h(1fr) 右（`1fr` 吃掉剩余空间）

#v(1em)
上面空了 `1em`，下面是 `stack`：
#stack(
  dir: ltr,
  spacing: 6pt,
  rect(width: 1cm),
  rect(width: 2cm),
  rect(width: 1cm),
)

// `repeat` fills a line; `hide` keeps the space but not the ink.
目录项 #box(width: 1fr, repeat[.]) 12
隐藏的 #hide[看不见] 仍占位
```

![blocks.typ 的渲染：一行里嵌着黄底的 box，下面是浅蓝底占满行宽的 block，接着是带圆角描边的块、右对齐的文字、居中的方框、向内缩进的方框、左右两端对齐的一行字、三个并排的方框、带点线引导的目录项和一处空白](/assets/images/typst-by-xuan/ch06-blocks.png)

逐项看：

- `box(baseline: 20%)` 把盒子相对文字基线抬高 20%，所以渲染图里黄色小盒子比周围文字略高。`box` 能设 `width`、`height`、`inset`、`outset`、`fill`、`stroke`、`radius`、`clip`，这些 `block` 也都有。
- `block` 多出来的是**块间距**（`above`、`below`，或一次性写 `spacing`）和**断页策略**。第一个 `block` 出现在句子中间，“而”字之后被截断，渲染图第一段确实停在“而”字上：这是上面第 2 条的又一次验证。
- `breakable: false` 的效果我专门验证了（`/tmp/p6/post/breakable.typ`）。页面只有 4cm 高，装不下 6 行内容，默认的块会被分页切开，不可断的块整个挪到下一页：

```typst
#set page(width: 7cm, height: 4cm, margin: 8pt)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"), size: 10pt)
#let lines = [一 \ 二 \ 三 \ 四 \ 五 \ 六]
前一行。
#block(stroke: 0.5pt, inset: 4pt, lines)
#pagebreak()
前一行。
#block(stroke: 0.5pt, inset: 4pt, breakable: false, lines)
```

我用 `pdftotext -f N -l N` 逐页取文字，共 4 页：

```text
p1: 前一行。  一 二 三 四
p2: 五 六
p3: 前一行。
p4: 一 二 三 四 五 六
```

默认的块在第 1 页放了四行，剩下两行去了第 2 页；`breakable: false` 的块把第 3 页只留给“前一行。”，六行整体落在第 4 页。代价是第 3 页下面一大片空白，所以这个参数适合小块（定理框、代码片段），不适合整页大表格。

### align、pad、h、v、stack、repeat、hide

blocks.typ 的后半段是一组“摆位置”的小工具，它们的共同点是：每个都是普通元素，没有特殊布局通道。

- `align(right)[...]` 在当前容器宽度内对齐内容。参数是对齐值，可以用 `+` 组合水平和垂直：`center + horizon`（水平居中加垂直居中）。例子里给 `rect` 设了 `height: 1.5cm`，让垂直方向有空间可以居中。
- `pad(x: 1cm, ...)` 给内容加外侧留白，`rect` 因此向内缩了 1cm。参数有 `left right top bottom x y rest` 几种写法。
- `h(1fr)` 和 `v(1em)` 是水平和垂直间距，下面两节专门讲。
- `stack(dir: ltr, spacing: 6pt, ...)` 把一组子元素沿一个方向依次摆放，`dir` 取 `ltr rtl ttb btt`，`spacing` 是子元素之间的距离。stack 的子项里可以直接写 `1fr` 这样的比例间距，见下一节。
- `repeat[.]` 把内容重复到填满可用宽度，`box(width: 1fr, repeat[.])` 就是目录里的点线引导。我另外试了 `gap`（`/tmp/p6/post/hide-repeat.typ`）：

```typst
#set page(width: 12cm, height: auto, margin: 8pt)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"))
#context [显示时 #measure[看不见].width，`hide` 后 #measure(hide[看不见]).width]

第一章 #box(width: 1fr, repeat[.]) 3 \
第二章 #box(width: 1fr, repeat(gap: 4pt)[·]) 17
```

![上面一行文字报告 hide 前后宽度都是 33pt；下面两行是目录项，第一行的点线引导很密，第二行用 gap: 4pt 之后点间距明显变大](/assets/images/typst-by-xuan/ch06-hide-repeat.png)

输出的第一行是 `显示时 33pt，hide 后 33pt`：`hide` 只擦掉墨迹，宽度分毫不差，这就是 blocks.typ 里“看不见却仍占位”的含义。常见用法是幻灯片的逐步显示，第 13 篇会用到。

## fr 到底怎么分配空间

`1fr` 是 Typst 里“按份额瓜分剩余空间”的单位，网格列、行、`h`、`v`、`stack` 间距、`box` 宽度都认它。我想知道分配顺序，于是让每一格自己报告宽度（`/tmp/p6/post/fr.typ`）：

```typst
#set page(width: 14cm, height: auto, margin: 1cm)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"))
#let w(len) = calc.round(len.pt(), digits: 2)

// 12cm of usable width = 340.16pt. `auto` is measured first, fixed lengths
// next, and `fr` shares what is left.
#let probe = block(width: 100%, layout(s => repr(w(s.width))))
#grid(
  columns: (auto, 2cm, 1fr, 2fr),
  stroke: 0.4pt,
  inset: 4pt,
  [auto], probe, probe, probe,
)
#context [`auto` 列内容宽：#repr(w(measure[auto].width))]

// On a line, a box with an `fr` width behaves like `h(fr)`.
#let slot(width) = box(width: width, layout(s => repr(w(s.width))))
#slot(3cm) #slot(1fr) #slot(2fr)

// stack takes bare fr values as spacing.
#stack(dir: ltr, rect(width: 1cm), 1fr, rect(width: 1cm), 3fr, rect(width: 1cm))
```

![第一行是四列的网格，格子里分别写着 auto、48.69、77.19、162.38；下面一行是 auto 列内容宽 19.89；再下面一行是 85.04、83.21、166.41 三个数字；最后一行是三个方块，第一和第二个靠近，第二和第三个相距很远](/assets/images/typst-by-xuan/ch06-fr.png)

（`layout` 和 `measure` 在后面单独讲，这里只借它们读出尺寸：`layout(s => ...)` 里的 `s.width` 是这个盒子分到的宽度。）

第一行网格，页面可用宽度 14cm − 2 × 1cm = 12cm = 340.16pt，每格 `inset: 4pt`，也就是内容比格子窄 8pt。数据读出来是：

- `auto` 列：内容 `auto` 宽 19.89pt，加 8pt 内边距，列宽 27.89pt。
- `2cm` 列：探针报告 48.69pt，加 8pt 是 56.69pt，正好 2cm。
- 剩下 340.16 − 27.89 − 56.69 = 255.58pt 给 `fr` 列。`1fr` 的探针报告 77.19pt（列宽 85.19pt），`2fr` 是 162.38pt（列宽 170.38pt），列宽之比恰好 1 : 2，三份各 85.19pt。

所以顺序是：**先量 `auto` 列的内容，再扣掉固定长度（和百分比），剩下的按 fr 份数平分。** 固定长度和百分比我另外验证了一遍（`/tmp/p6/post/fr-overflow.typ`）：

```typst
#set page(width: 10cm, height: auto, margin: 0pt)
#let w(len) = calc.round(len.pt(), digits: 2)
#let probe = block(width: 100%, layout(s => repr(w(s.width))))

// Fixed tracks first: 200pt + 100pt already exceed the 283.46pt page.
#grid(
  columns: (200pt, 100pt, 1fr),
  probe, probe, probe,
)

// Percentages are relative to the grid width.
#grid(
  columns: (50%, 1fr),
  probe, probe,
)
```

```text
200.0             100.0
141.73   141.73
```

第一个网格里，两个固定列合计 300pt，已经超过页面的 283.46pt，它们照样是 200pt 和 100pt，没有被挤压；`1fr` 那一列的探针没有输出任何可见内容，我没有再去量它的确切宽度，只记结论：固定长度优先，`fr` 吃剩下的。第二个网格里 `50%` 是 141.73pt，正好是页面宽度的一半，也是 `1fr` 分到的另一半：百分比的基准是网格自身的宽度。

行内的规则一样。`box(width: 1fr)` 在一行里和 `h(1fr)` 等价：`#slot(3cm) #slot(1fr) #slot(2fr)` 那一行，固定的 3cm 是 85.04pt，340.16 − 85.04 − 83.21 − 166.41 = 5.5pt，是两个空格占去的宽度，剩下 249.62pt 按 1 : 2 分成 83.21pt 和 166.41pt，和报告的数字对得上。`stack` 里直接写 `1fr`、`3fr` 当间距，渲染图最后一行三个 1cm 方块之间的空隙之比就是 1 : 3。

## 弱间距与强间距

`v(...)` 和 `h(...)` 有一个 `weak` 参数。弱间距遇到别的间距，或者落在行首、页首这类边缘，就会被吞掉一部分或全部。具体吞多少、怎么吞，我用 `/tmp/p6/post/weak.typ` 量了一遍。`y()` 函数在每个段落末尾报告当前纵坐标，全局 `par.spacing` 设成 10pt：

```typst
#set page(width: 10cm, height: auto, margin: 1cm)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"), size: 10pt)
#set par(spacing: 10pt)
#let y() = context repr(calc.round(here().position().y.pt(), digits: 1))

段落 A #y()

段落 B #y()

#v(30pt)
段落 C（前面有强 `v(30pt)`）#y()

#v(4pt, weak: true)
段落 D（弱 `v(4pt)` 比段落间距 10pt 小）#y()

#v(30pt, weak: true)
#v(20pt, weak: true)
段落 E（两个弱 `v` 取较大的 30pt）#y()

// Weak horizontal space vanishes at a line start.
#h(2cm, weak: true)行首的弱 `h(2cm)` 被丢弃，#h(2cm)强的不会。
```

```text
段落 A 35.6
段落 B 52.9
段落 C（前面有强 v(30pt)）100.2
段落 D（弱 v(4pt) 比段落间距 10pt 小）111.5
段落 E（两个弱 v 取较大的 30pt）148.8
```

![渲染图：A、B 两段间距正常，B 和 C 之间有一大块空白，C 和 D 几乎紧挨着，D 和 E 之间的空白中等；最后一行的行首没有缩进，句中的强 h 留出了一大段空白](/assets/images/typst-by-xuan/ch06-weak.png)

A 到 B 的纵坐标差是 17.3pt，其中 10pt 是段落间距，剩下的 7.3pt 是一行的高度。把每一对相邻段落的纵坐标差扣掉这 7.3pt，就是实际的间隙：

- A 到 B：10pt，纯段落间距。
- B 到 C：47.3 − 7.3 = **40pt**。强 `v(30pt)` 没有取代段落间距，而是叠在它上面：10 + 30。
- C 到 D：11.3 − 7.3 = **4pt**。弱 `v(4pt)` 遇到 10pt 的段落间距，结果不是 10pt，也不是 14pt，而是 4pt：弱间距**取代**了段落间距，即使它更小。
- D 到 E：37.3 − 7.3 = **30pt**。两个相邻的弱 `v`（30pt 和 20pt）合并成较大的那个。
- 最后一行：行首的弱 `h(2cm)` 被丢掉，句子从页边直接开始；行内的强 `h(2cm)` 照常留白，渲染图上能看到一段明显的空隙。

我对这组数字的解释是：Typst 内部给间距分了强弱等级，段落间距最弱，显式 `v(weak: true)` 比它强一档，强 `v` 不参与折叠。这是从数据反推的，没有去读排版引擎源码，细节以后遇到反例再修正。实用的结论只有两条：想在标题前后加固定留白，用 `v(..., weak: true)`，不会和段落间距叠加；想要无条件的额外空隙，用强 `v`。

## grid：二维排版

`grid` 把一组子元素按列轨道和行轨道摆成表格。`lab/ch06/grid.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch06/grid.typ)）：

```typst
#set page(width: 14cm, height: auto, margin: 1cm)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"))

// Track sizes: auto fits content, a length is fixed, `fr` shares the rest.
#grid(
  columns: (auto, 3cm, 1fr),
  rows: (auto, 1cm),
  gutter: 4pt,
  stroke: 0.4pt,
  inset: 5pt,
  align: (left, center, right),
  [auto], [3cm], [1fr],
  grid.cell(colspan: 2)[跨两列], [右],
)

// `fill` and `align` accept functions of (column, row).
#grid(
  columns: (1fr,) * 4,
  fill: (x, y) => if calc.odd(x + y) { luma(235) },
  inset: 6pt,
  ..range(8).map(i => [#i]),
)

// `columns` splits the page flow instead.
#columns(2, gutter: 1em)[
  #lorem(30)
  #colbreak()
  第二栏。
]
```

![grid.typ 的渲染：第一个网格有两行三列，第一行是 auto、3cm、1fr 三个格子，第二行第一格跨两列写着跨两列，右下格内容靠右；第二个网格是 2 行 4 列，数字 0 到 7，奇偶交替的格子是浅灰底；最下面是两栏文字，左栏是 Lorem ipsum，右栏只有第二栏三个字](/assets/images/typst-by-xuan/ch06-grid.png)

这个文件涉及的点：

- **`columns` 与 `rows`**：每个轨道可以是 `auto`、固定长度、百分比或 `fr`，规则就是上一节量过的。只给一个整数 `columns: 3` 时，我用三个内容宽度悬殊的格子试过，探针报告三列都是 113.39pt，也就是 340.16pt 的三等分，而不是各自贴着内容。
- **单元格按顺序填入**：子元素依次填满第一行、第二行，不够一行的补空。`grid.cell(colspan: 2)` 让一个格子跨两列。
- **`gutter`**：轨道之间的间隙，横竖同时设；也可以分开写 `column-gutter`、`row-gutter`。渲染图里第一个网格的格线之间有 4pt 空隙就来自这里。
- **`stroke`、`inset`**：每个格子的描边和内边距。
- **`align`**：可以是单个对齐值，也可以是每列一个的元组：`(left, center, right)` 让第一列靠左、第二列居中、第三列靠右。
- **`fill` 和 `align` 接受函数 `(x, y) => ...`**：参数是列号和行号（从 0 起）。`calc.odd(x + y)` 给出棋盘格，函数返回 `none`（条件为假时 `if` 的返回值）就不填色。
- **`(1fr,) * 4`** 是一个含四个 `1fr` 的元组，用来写等宽四列；`..range(8).map(i => [#i])` 把数组展开成 8 个子元素，这是第 3 篇讲过的参数展开。

最后的 `columns(2, gutter: 1em)[...]` 和网格不同：它是把**内容流**拆成两栏，内容先填满左栏再溢出到右栏，`colbreak()` 强制从右栏开始。渲染图里左栏是 `lorem(30)` 的 7 行，右栏只有“第二栏。”三个字，因为 `colbreak` 之后的内容就这么少。

至于 `table`，它在 `grid` 的基础上加了表头、表脚和默认的框线样式，第 9 篇再讲。

### 一个跨列的页面骨架

`lab/ch06/fig-layout.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch06/fig-layout.typ)）把上面的规则合在一个小图里：固定列宽、固定行高、`gutter`、跨三列的 `grid.cell`。`cell` 是个局部函数，用 `rect(width: 100%, height: 100%)` 填满分到的格子：

```typst
#set page(width: auto, height: auto, margin: 12pt)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"), size: 10pt)

#let cell(fill, body) = rect(
  width: 100%,
  height: 100%,
  fill: fill.lighten(70%),
  stroke: 0.5pt,
  align(center + horizon, body),
)

#grid(
  columns: (2cm, 4cm, 2cm),
  rows: (1cm, 3cm, 1cm),
  gutter: 3pt,
  grid.cell(colspan: 3, cell(blue)[header]),
  cell(red)[左栏 2cm],
  cell(green)[正文 4cm],
  cell(red)[侧栏 2cm],
  grid.cell(colspan: 3, cell(blue)[footer]),
)
```

![fig-layout.typ 的渲染：最上和最下是跨三列的蓝色横条，写着 header 和 footer，中间一行是三格：左右两侧窄的红色格子写着左栏 2cm 和侧栏 2cm，中间宽的绿色格子写着正文 4cm](/assets/images/typst-by-xuan/ch06-layout.png)

页眉页脚两条各占一行并跨满三列，中间三格的宽度比是 2 : 4 : 2。

## place：脱离流的定位与浮动

`place` 是 Typst 里“不占位置”的那一类。`lab/ch06/place.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch06/place.typ)）：

```typst
#set page(width: 12cm, height: 8cm, margin: 1cm)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"))

// `place` takes its content out of the flow and positions it in the parent.
#place(top + right, dx: -4pt, dy: 4pt, text(fill: red)[角标])
#place(bottom + center, float: true, rect(fill: aqua, width: 100%)[
  `float: true` 的内容会被推到页面顶部或底部，正文绕开。
])

#lorem(70)

#place(
  top + center,
  scope: "parent",
  float: true,
  text(size: 8pt)[`scope: "parent"` 让浮动体跨过分栏。],
)
```

这个文件编出来是 2 页，第一页：

![place.typ 第 1 页：一段 Lorem ipsum 正文，右上角有一个红色的角标压在正文最后一个词上，页面底部有一块浅蓝色的矩形，里面写着 float: true](/assets/images/typst-by-xuan/ch06-place.png)

第二页：

![place.typ 第 2 页：顶部居中是一行小字，写着 scope: parent 让浮动体跨过分栏，下面是第一页放不下的两行正文](/assets/images/typst-by-xuan/ch06-place-parent.png)

**普通 `place`（没有 `float`）是零尺寸的。** 红色“角标”按 `top + right` 定位到父容器的右上角，再偏移 `dx: -4pt, dy: 4pt`，渲染图里它压在第一行正文的末尾：正文没有给它让位，因为它根本不在流里。这是一个特点：叠层标注方便，但小心遮住内容。

**`float: true` 才会改变正文流。** 我把几种情形做成对照实验（`/tmp/p6/post/float.typ`），每个 `#page[...]` 里两个段落，A 在前，B 在后，`place` 夹在中间，页面 4cm 高、边距 8pt，`bar` 是 1cm 高的色块：

```typst
#set page(width: 8cm, height: 4cm, margin: 8pt)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"), size: 10pt)
#let y(tag) = context [#tag：#calc.round(here().position().y.pt(), digits: 1)pt]
#let bar = rect(width: 100%, height: 1cm, fill: aqua)

#page[#y[基线 A]

  #y[基线 B]]
#page[#y[A] #place(top + right, bar)

  #y[普通 place 之后的 B]]
#page[#y[A] #place(top, float: true, bar)

  #y[顶部 float 之后的 B]]
#page[#y[A] #place(top, float: true, clearance: 0pt, bar)

  #y[clearance: 0pt 的 B]]
#page[#y[A] #place(bottom, float: true, bar)

  #y[底部 float 之后的 B]]
```

这 5 页报告的纵坐标（pt）：

|情形|A|B|A 相对基线下移|
|---|---|---|---|
|基线（没有 place）|15.3|34.6|0|
|普通 `place(top + right)`|15.3|34.6|0|
|`float: true`，顶部|58.6|77.9|43.3|
|`float: true, clearance: 0pt`|43.6|62.9|28.3|
|`float: true`，底部|15.3|34.6|0|

规律很清楚：

- 普通 `place` 对 A、B 的位置毫无影响。
- 顶部浮动体把后面的所有内容往下推它自己的高度，再加上 `clearance`：1cm 是 28.35pt，默认 `clearance` 在 10pt 字号下让位置多推了 15pt（43.3 − 28.3，看起来是 1.5em，这个倍数是我从数字推的，没有核对文档），设成 0 就只剩 28.3pt。
- 底部浮动体把空间留在页面下沿，上面的文字一点没动。
- 放不下的浮动体会被推到下一页，前面 place.typ 的第二页就是例子：`scope: "parent"` 的浮动体在文件末尾才出现，第一页已经满了，它去了第 2 页的顶部。

**`scope: "parent"` 是给多栏用的。** place.typ 的页面是单栏，所以那个例子里 `scope` 没有可见的效果，要看效果得有栏。`/tmp/p6/post/columns.typ`：

```typst
#set page(width: 12cm, height: 8cm, margin: 8pt, columns: 2)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"), size: 9pt)
#place(top + center, scope: "parent", float: true, text(
  size: 14pt,
  weight: "bold",
)[跨栏标题 scope: "parent"])
#lorem(60)
#colbreak()
右栏。#lorem(20)
```

![双栏页面：顶部是横跨两栏的粗体标题，下面左栏是一整段 Lorem ipsum，右栏以右栏两个字开头，同样是 Lorem ipsum 但更短](/assets/images/typst-by-xuan/ch06-columns-parent.png)

默认的浮动体只能放进一栏里，`scope: "parent"` 让它的参照物变成栏的父容器，也就是整个页面宽度，标题因此横跨两栏，两栏正文都被推到它下面。论文里跨栏的大图大表就是这么放的。

## 变换：只改外观，不改布局

`lab/ch06/transforms.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch06/transforms.typ)）：

```typst
#set page(width: 14cm, height: auto, margin: 1cm)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"))

// Transforms change appearance, not layout: the original box stays in place.
#let tag(body) = box(stroke: 0.5pt, inset: 4pt, body)

#tag[原样] #h(1cm)
#rotate(20deg, tag[旋转 20°]) #h(1cm)
#scale(x: 150%, y: 80%, tag[缩放]) #h(1cm)
#skew(ax: -15deg, tag[斜切]) #h(1cm)
#move(dx: 6pt, dy: -6pt, tag[平移])

// `rotate(reflow: true)` makes the layout follow the rotation.
#rotate(90deg, reflow: true, tag[reflow])
```

![transforms.typ 的渲染：六个带边框的小盒子竖着排成一列，分别是原样、旋转 20 度、横向放大纵向缩小、向左斜切、平移和旋转 90 度的 reflow 盒子，最后一个盒子是竖排的，它占的高度比横着时大](/assets/images/typst-by-xuan/ch06-transforms.png)

四个变换 `rotate`、`scale`、`skew`、`move`：

- `rotate(20deg, ...)` 绕内容中心旋转，`origin` 可以改旋转中心。
- `scale(x: 150%, y: 80%, ...)` 横纵独立缩放，只写一个百分比（`scale(120%, ...)`）是等比缩放。
- `skew(ax: -15deg, ...)` 沿水平方向斜切，`ay` 是垂直方向。
- `move(dx: 6pt, dy: -6pt, ...)` 平移。

这一节开头的注释 “Transforms change appearance, not layout” 是核心：**变换后的内容在布局里占的仍然是变换之前的尺寸。** 那个文件里六个盒子竖着排，是因为它们都是块级元素（上一节的结论），不是变换造成的。真正看占位，要放到行里（`/tmp/p6/post/transforms-inline.typ`）：

```typst
#set page(width: 8cm, height: auto, margin: 8pt)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"))
#let t(body) = box(stroke: 0.5pt, inset: 3pt, body)

前 #box(rotate(20deg, t[旋转])) #box(scale(150%, t[缩放]))
#box(skew(ax: 20deg, t[斜切])) 后。变换只改外观，
每个盒子在行里占的仍是原尺寸。
```

![一行文字中间有三个带边框的盒子：旋转的、放大的、斜切的，它们互相重叠，放大的盒子明显盖住了左右邻居](/assets/images/typst-by-xuan/ch06-transforms-inline.png)

放大 150% 的“缩放”盒子压住了左右邻居，旋转和斜切的盒子也彼此交叠：布局只给每个盒子留了原尺寸的位置，变换后的图形溢出来。如果希望布局跟着变，就像 transforms.typ 最后一行那样用 `rotate(90deg, reflow: true, ...)`，渲染图里最后一个盒子是竖着的，它占的高度就是旋转之后的高度。

## layout 与 measure：在布局阶段读尺寸

前面两节已经借用过它们了。这里把它们讲清楚。

- `layout(size => ...)`：回调里能拿到**当前容器**分到的宽高。内容不是在书写时确定，而是在放进具体容器时才生成。
- `measure(content)`：返回一个有 `width` 和 `height` 的字典，是内容**自然尺寸**。`measure(width: 3cm, content)` 在限定宽度下重新折行再量。

`/tmp/p6/post/layout.typ`，我让它同时展示三件事：容器尺寸、按容器收缩内容、量未折行和折行后的尺寸：

```typst
#set page(width: 12cm, height: auto, margin: 8pt)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"))

// `layout` hands you the size of the box it lives in.
#block(width: 6cm, stroke: 0.5pt, inset: 3pt, layout(size => [
  宽 #size.width，高 #size.height \
  `50%` 换算为 #(50% * size.width)
]))
#box(width: 5cm, stroke: 0.5pt, inset: 3pt, layout(size => [宽 #size.width]))

// Shrink to fit: scale down only when the content is wider than its box.
#let fit(body) = layout(size => {
  let natural = measure(body).width
  if natural > size.width {
    scale(size.width / natural * 100%, reflow: true, body)
  } else {
    body
  }
})
#block(
  width: 5cm,
  stroke: 0.5pt,
  inset: 3pt,
  fit[一行很长很长很长很长很长很长的文字],
)
#block(width: 5cm, stroke: 0.5pt, inset: 3pt, fit[短文字])

// `measure` needs a context; give it a width to measure wrapped text.
#context {
  let m = measure[一行很长很长很长很长很长很长的文字]
  let n = measure(width: 3cm)[一行很长很长很长很长很长很长的文字]
  [自然宽 #m.width，高 #m.height；限宽 3cm 后宽 #n.width，高 #n.height]
}
```

```text
宽 164.08pt，高 float.inf * 1pt
50% 换算为 82.04pt

宽 135.73pt

一行很长很长很长很长很长很长的文字

短文字

自然宽 187pt，高 8.02pt；限宽 3cm 后宽 77pt，高 38.36pt
```

![layout.typ 的渲染：第一个框里写着宽 164.08pt 和高 float.inf * 1pt，下面一行是 50% 的换算；第二个框写着宽 135.73pt；第三个框里长句被缩小后刚好放进框内；第四个框里短文字保持原样；最后一行是自然宽与限宽后的数值](/assets/images/typst-by-xuan/ch06-layout-fn.png)

几个读数：

- 6cm 宽的块，减去 `inset: 3pt` 的两侧，内部宽 170.08 − 6 = **164.08pt**，`layout` 看到的是减过内边距的内部宽度。`50%` 乘这个宽度得到 82.04pt。这是 `layout` 最常见的用途：把比例换算成绝对长度。
- `size.height` 是 `float.inf * 1pt`：我给的 `block` 没有固定高度，高度向下不设上限，所以 `layout` 只能说“无限”。需要真实高度时容器要显式给 `height`。
- `fit` 是一个自己写的“缩小以适应”：自然宽 187pt 的长句放不进 5cm（141.73pt）的框，就用 `scale(.., reflow: true)` 按 `size.width / natural` 缩小，渲染图上它确实塞进了框里；短句没超，原样返回。注意 `layout` 的回调里可以直接调 `measure`，不需要再写 `context`。
- 限宽 3cm 后同样一句话折成了 3 行：宽度 77pt（每行 7 个字，每字 11pt），高度从 8.02pt 涨到 38.36pt。这个数字对得上：3 × 8.02 + 2 × 7.15 = 38.36，7.15pt 是 11pt 字号下 `0.65em` 的行距（`par.leading` 的默认值，我是从算术对上才认出来的，没有另外查）。

`measure` 在没有 `context` 的地方会被拒绝：

```typst
#measure[x].width
```

```text
error: can only be used when context is known
  ┌─ measure-fail.typ:1:1
  │
1 │ #measure[x].width
  │  ^^^^^^^^^^
  │
  = hint: try wrapping this in a `context` expression
  = hint: the `context` expression should wrap everything that depends on this function
```

因为内容的自然尺寸取决于周围的样式（字号、字体），所以必须知道上下文。`layout` 的回调里已经有上下文，`#context` 则是给没有 `layout` 的地方用的。`context` 是下一篇的主题，这里先当成“告诉 Typst 这段表达式要在知道环境之后再算”的标记。

## page：纸张、边距、页眉页脚、背景

`page` 和前面的元素不太一样，它不是流里的一个块，而是**页面容器**本身的参数，所以几乎总是用 `set` 设置。`lab/ch06/page.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch06/page.typ)）：

```typst
// `page` is a set-rule target: size, margins, header, footer, numbering.
#set page(
  paper: "a5",
  margin: (x: 2cm, top: 2.5cm, bottom: 2cm),
  binding: left,
  header: context [
    #set text(size: 9pt)
    第 #counter(page).display() 页
    #h(1fr) `page` 演示
  ],
  footer: align(center, context counter(page).display("1 / 1", both: true)),
  numbering: "1",
  fill: rgb("#fffdf5"),
  background: place(center + horizon, text(60pt, fill: luma(240), "DRAFT")),
  bleed: 3mm,
)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"))

= 第一页

正文。#lorem(60)

#pagebreak()

= 第二页

`pagebreak` 强制换页；`pagebreak(weak: true)` 在已经是新页时不再多换一页。

#pagebreak(weak: true)

#set page(columns: 2)
= 双栏

#lorem(80)
#colbreak()
右栏从这里开始。#lorem(40)
```

编出来是 3 页。第 1 页：

![page.typ 第 1 页：A5 纸，淡黄色底，页眉左边是第 1 页、右边是 page 演示，一级标题第一页和一小段正文，页面中间有很淡的 DRAFT 水印，页脚居中写着 1 / 3](/assets/images/typst-by-xuan/ch06-page-first.png)

第 3 页，双栏：

![page.typ 第 3 页：页眉是第 3 页，标题双栏横在左栏顶端，左栏是一整栏 Lorem ipsum，右栏以右栏从这里开始起头，页面中部同样有很淡的 DRAFT 水印，页脚是 3 / 3](/assets/images/typst-by-xuan/ch06-page-columns.png)

逐个参数：

- **`paper`**：`"a5"`、`"a4"`、`"us-letter"` 之类的纸型名；也可以直接给 `width` 和 `height`，还可以设 `flipped: true` 横置。省略时是 A4：我用 `context [页宽 #page.width ...]` 读出默认值，页宽 595.28pt，页高 841.89pt，`pdfinfo` 报告 595.276 x 841.89 pts (A4)。
- **`margin`**：可以是一个长度（四边相同），也可以是字典：`(x: 2cm, top: 2.5cm, bottom: 2cm)` 如这个文件所写；`rest` 表示“其余各边”，`(rest: 1cm, top: 2cm)` 我试过，左边缘落在 28.35pt 也就是 1cm 处；`inside` 与 `outside` 用于装订，见下面。默认值是 `auto`：我读到 A4 默认页面的正文左缘在 70.87pt，正好是 25mm。（我记得公式是页面短边的 2.5/21，这里只验证了 A4 这一个结果。）
- **`header` 与 `footer`**：任意内容，画在页边距区域里。这里页眉用了 `context` 和 `counter(page).display()` 显示当前页码，页脚用 `display("1 / 1", both: true)` 显示“当前 / 总数”，渲染图里是 `1 / 3`。计数器与 `context` 留到下一篇系统地讲。
- **`numbering`**：页码的格式，和标题编号一样吃 `"1"`、`"一"`、`"i"` 这类字符串或函数。
- **`fill`**：纸张底色。
- **`background`**：画在正文下面的东西，这里用 `place(center + horizon, ...)` 放了一个很淡的 `DRAFT`。每一页都会重复一次。
- **`columns`**：整页分栏。这个文件最后的 `set page(columns: 2)` 之后，标题和正文都进了两栏，`colbreak()` 把右栏起头的位置钉住。
- **`bleed`**：出血。`bleed: 3mm` 让页面的实际尺寸向四周扩出 3mm，用于印刷裁切。我用 `/tmp/p6/post/bleed.typ` 验证：

```typst
#set page(width: 6cm, height: 4cm, margin: 8pt, bleed: 3mm, fill: yellow)
出血 3mm
```

```text
$ pdfinfo -box bleed.pdf | grep -E "Media|Trim|Bleed"
MediaBox:            0.00     0.00   187.09   130.39
BleedBox:            0.00     0.00   187.09   130.39
TrimBox:             8.50     8.50   178.58   121.89
```

6cm × 4cm 的页面是 170.08 × 113.39pt，每边多出 3mm = 8.50pt，MediaBox 变成 187.09 × 130.39pt；`TrimBox` 的 8.50 到 178.58 标出裁切线，印刷厂靠它知道哪里该切。`fill: yellow` 铺满了整个出血区，这正是出血要的效果。

### 装订、foreground 与强制换页

`binding` 决定哪一侧是装订侧，`margin` 里的 `inside` 和 `outside` 配合它让左右页的边距互为镜像。`/tmp/p6/post/binding.typ`，每页用 `here().position().x` 报告正文左缘：

```typst
#set page(
  width: 8cm,
  height: 3cm,
  margin: (inside: 3cm, outside: 0.5cm),
  binding: left,
)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"), size: 9pt)
#let x() = context [第 #here().page() 页，正文左缘 #calc.round(here().position().x.pt(), digits: 1)pt]
#x()
#pagebreak()
#x()
```

```text
第 1 页，正文左缘 85pt
第 2 页，正文左缘 14.2pt
```

奇数页的装订侧在左边，所以 `inside: 3cm`（85pt）落在左边；偶数页镜像过来，`inside` 在右边，左边只剩 `outside: 0.5cm`（14.2pt）。我把 `binding: left` 改成 `binding: right`，两页的读数互换：第 1 页 14.2pt，第 2 页 85pt。双面打印的书稿用这一组参数。

`foreground` 和 `background` 对称：前者画在正文**上面**。`/tmp/p6/post/foreground.typ`：

```typst
#set page(
  width: 8cm,
  height: 4cm,
  margin: 12pt,
  background: place(center + horizon, text(40pt, fill: luma(225), [背景])),
  foreground: place(top + right, dx: -6pt, dy: 6pt, rotate(-12deg, rect(
    stroke: red + 1pt,
    inset: 3pt,
    text(red, size: 9pt)[已审阅],
  ))),
)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"))
背景在正文下面，前景盖在正文上面。#lorem(15)
```

![一个小页面：浅灰色的背景两个字在正文下方，正文的第一行末尾被一个红色边框、略微倾斜的已审阅图章盖住了一部分](/assets/images/typst-by-xuan/ch06-foreground.png)

`background` 里的浅灰大字被正文压在下面，`foreground` 里的红色图章盖住了第一行的句号。水印用前者，审阅章、裁切标记用后者。

换页方面，`page.typ` 这个 lab 已经演示了 `pagebreak()` 和 `pagebreak(weak: true)`。还有两个常用变体（`/tmp/p6/post/breaks.typ`）：

```typst
#set page(width: 6cm, height: 3cm, margin: 8pt)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"))
第 1 页
#pagebreak(to: "odd")
这里是奇数页，第 #context here().page() 页
#pagebreak(to: "odd")
下一个奇数页，第 #context here().page() 页
#page(
  paper: "a6",
  flipped: true,
  margin: 1cm,
)[用 `page(..)[..]` 单独开一页：A6 横向]
#page(width: auto, height: auto, margin: 4pt)[`auto` 尺寸贴着内容]
```

```text
Pages: 7
Page    1 size:  170.079 x 85.0394 pts
Page    2 size:  170.079 x 85.0394 pts
Page    3 size:  170.079 x 85.0394 pts
Page    4 size:  170.079 x 85.0394 pts
Page    5 size:  170.079 x 85.0394 pts
Page    6 size:  419.528 x 297.638 pts
Page    7 size:  97.9422 x 16.019 pts
```

- `pagebreak(to: "odd")` 保证下一页是奇数页，必要时塞入空白页：第 1 页的下一个奇数页是第 3 页，第 2 页是自动补的空白页；再来一次，第 4 页空白，内容落在第 5 页，共 5 页。我用 `pdftotext -f N -l N` 逐页确认：第 3 页是“这里是奇数页，第 3 页”，第 5 页是“下一个奇数页，第 5 页”，第 2、4 页是空的。章首右页起排就靠它。
- `page(...)[...]` 是函数形式：只给这一块内容单独开一页，不影响后面。第 6 页是 A6 横向（419.528 × 297.638pt），第 7 页 `width: auto, height: auto` 贴着内容收缩，只有 97.94 × 16.02pt，一个字条大小的 PDF 页面。仓库里的 `fig-*.typ` 用 `#set page(width: auto, height: auto, margin: 12pt)` 做同样的事：页面贴着内容，截出来的 PNG 没有多余的白边。

还有一个陷阱：**在文档中间 `set page(...)` 会强制换页**，页面参数是整页的属性，改了就得另起一页。`/tmp/p6/post/midset.typ`：

```typst
#set page(width: 6cm, height: 3cm)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"))
第一页
#set page(fill: yellow)
这一行在第 #context here().page() 页。
```

```text
Pages: 2
这一行在第 2 页。
```

我没有写 `pagebreak`，只是改了底色，文档就多出了一页。这也解释了 page.typ lab 为什么只有 3 页而不是 4 页：`pagebreak(weak: true)` 已经把内容带到第 3 页了，随后的 `set page(columns: 2)` 要求换页，但当前页还是空的，不会再多出一页。

## xuan 的 page.typ

上面这些零件，`xuan` 只用到很小的一部分，因为选择已经在 `note` 里做完了：纸张默认 A4，边距 2.5cm。`src/page.typ` 全文 40 行（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/packages/local/xuan/0.1.0/src/page.typ)）。它是**最终版**：

```typst
/// Paper and margins.
#let xuan-page(body, paper: "a4", margin: 2.5cm) = {
  set page(paper: paper, margin: margin)
  body
}

/// Centered title, subtitle, authors and date.
#let title-block(
  title: none,
  subtitle: none,
  author: (),
  date: auto,
  lang: "zh",
) = {
  let authors = if type(author) == array { author } else { (author,) }
  let shown = if date == auto {
    let today = datetime.today()
    if lang == "zh" {
      today.display("[year] 年 [month padding:none] 月 [day padding:none] 日")
    } else {
      today.display("[month repr:long] [day padding:none], [year]")
    }
  } else if type(date) == datetime {
    date.display("[year]-[month]-[day]")
  } else {
    date
  }
  align(center, block(width: 100%, spacing: 2em)[
    #if title != none {
      block(text(size: 1.8em, weight: "bold", title), below: 0.6em)
    }
    #if subtitle != none {
      block(text(size: 1.2em, subtitle), below: 0.8em)
    }
    #if authors.len() > 0 {
      block(authors.join(h(1.5em)), below: 0.6em)
    }
    #if shown != none { shown }
  ])
}
```

### xuan-page：为什么 set 写在函数里也管用

`xuan-page(body, ...)` 的形状是第 4 篇讲的模板形状：最后一个位置参数是 `body`，通过 `#show: xuan-page.with(paper: "a4")` 接收“文档剩下的所有内容”。函数体第一行 `set page(...)` 的作用域是这个函数体，也就是后面返回的 `body`；`body` 里的内容整个落在这条规则之下。这和第 4 篇 `scope.typ` 里 `let f() = { set text(fill: red) ... }` 是同一个机制。

`note` 在调用 `xuan-page` 之后又写了 `set page(header: ..., footer: ...)`：这是第二条 `set page`，只设了页眉页脚，和第一条设的字段不重叠，两条规则一起生效，所以 `paper` 和 `margin` 还在。又因为这两条规则都出现在页面还空着的时候，不会像上一节的 `midset.typ` 那样额外换页（我用 `set page(paper: "a6")` 后接 `set page(fill: yellow)` 试过，没有多出页面）。

页边距为什么选 2.5cm？A4 的 `margin: auto` 在上面验证过是 25mm，所以对 A4 来说 `xuan-page` 的默认就是 Typst 的默认值。我把它写成显式参数，是为了让调用方一眼知道页面是 A4，而且能改（`note(paper: "a5")` 往下传的就是这个参数）。

### title-block：一个把几种输入统一成显示文字的函数

`title-block` 不排版页面，它排“标题、副标题、作者、日期”四行，用上面讲过的 `align`、`block`、`h` 搭起来：

- **作者归一化**：`author` 可以是字符串，也可以是数组。第一行 `if type(author) == array { author } else { (author,) }` 统一成数组，空数组 `()` 则不显示作者那一行（后面的 `authors.len() > 0`）。
- **日期的三种来源**：`auto` 取今天，中文格式 `2026 年 10 月 19 日`（`[month padding:none]` 去掉前导零），英文格式 `October 19, 2026`；传入 `datetime` 就显示 ISO 风格的 `2026-10-19`；其他值（字符串、内容）原样显示，所以可以写 `date: "Draft 2"`。我分别编译了这三种。`auto` 的中英文输出（今天，在 nix shell 里）是 `2026 年 10 月 19 日` 和 `October 19, 2026`。
- **垂直结构**：外面是 `align(center, block(width: 100%, spacing: 2em)[...])`，里面每一行是一个单独的 `block`，用 `below:` 控制它和下一行的间距：标题 0.6em、副标题 0.8em、作者 0.6em。块间距这一块用的就是前面讲的块流模型：竖向距离靠 `block.below` 和 `spacing` 决定，不需要手写 `v()`。
- **作者之间的间距**：`authors.join(h(1.5em))` 把作者名用一个 1.5em 的水平间距连起来，不加逗号，保持页面简洁。
- **`#if title != none { block(...) }`**：这是一段内容块里的代码块，`if` 为假时什么也不产生，所以缺省的标题、副标题不会留下空行。

`/tmp/p6/post/xuan-title.typ`（日期用 `datetime(...)` 写死是为了让输出每天一样；`#set page(height: auto)` 只是为了截图，不是 xuan 的一部分）：

```typst
#import "@local/xuan:0.1.0": *
#show: xuan-page.with(paper: "a6", margin: 1.5cm)
// Shrink the page to its content, only to keep the screenshot small.
#set page(height: auto)
#set text(font: ("Libertinus Serif", "Noto Serif CJK SC"))
#title-block(
  title: "线性代数笔记",
  subtitle: "最小二乘与 SVD",
  author: ("张三", "李四"),
  date: datetime(year: 2026, month: 10, day: 19),
)
#title-block(
  title: "Notes on SVD",
  author: "Zhang San",
  date: "Draft 2",
  lang: "en",
)
```

![A6 纸：上面是居中的粗体中文标题线性代数笔记，下面是副标题、两位作者名和日期 2026-10-19，再往下是英文标题 Notes on SVD，作者 Zhang San，日期位置写着 Draft 2](/assets/images/typst-by-xuan/ch06-xuan-title.png)

第一块是中文标题，作者名之间隔着 1.5em，日期显示为 ISO 格式；第二块里 `author: "Zhang San"` 是个字符串，被包成单元素数组，`date: "Draft 2"` 原样显示。`lang: "en"` 在这里只影响 `date: auto` 的格式，这个例子里没用上。

`page.typ` 为什么把这两个函数放在一起？因为它们都在回答同一个问题：文档第一页的物理形状是什么。`xuan-page` 决定纸，`title-block` 决定纸上第一块内容。其余的页面特性（页眉、页脚、页码）放在 `header.typ`，因为它们要靠 `context` 和计数器才能写，那是下一篇的事。

## 下一步

`xuan-header` 里有一句 `query(heading.where(level: 1).before(here()))`，它要回答“这一页上方最近的章标题是什么”。这句话为什么要放在 `context` 里、`here()` 在这里又是什么，以及 Typst 为什么要把同一份文档排好几遍才收敛，是[第 7 篇](/posts/typst-by-xuan-07-context-counters-state/)的内容。本篇用过的 `here().position()` 就是它的近亲。

如果想自己多做几个对照，仓库里 `lab/ch06/` 的 6 个文件都是现成的底稿：把 `blocks.typ` 里的 `inset` 改成 0 看边框怎么挤，把 `grid.typ` 的 `columns` 改成 `(1fr, 1fr, 1fr)` 再加一个宽内容，看 `auto` 和 `fr` 怎么争空间。`make ch06` 不到两秒。
