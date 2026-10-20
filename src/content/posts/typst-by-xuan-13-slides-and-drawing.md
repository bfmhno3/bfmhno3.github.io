---
title: "幻灯片与绘图"
commentId: "post:typst-by-xuan-13-slides-and-drawing"
published: "2026-10-19 20:00:00 +08:00"
description: "用 Xuan 从零学 Typst 第 13 篇：我用 Typst 0.15.1 把 examples/slides 编成 17 页（13 个幻灯片编号，135.5 ms），逐页渲染检查了分步页、进度条页脚和绘图页，用 ch13 的 8 个 lab 文件跑通形状、颜色、渐变、tiling 与描边，并写出 xuan 的 slides.typ（95 行）。"
category: Tutorial
tags:
  - Typst
  - Xuan
  - 幻灯片
  - 绘图
series: "用 Xuan 从零学 Typst"
seriesOrder: 13
draft: false
comment: true
slug: typst-by-xuan-13-slides-and-drawing
---

一份幻灯片，在 Typst 眼里就是一份页面比较特别的文档：页面是 16:9，字号 20pt，每个“幻灯片”占一页，页脚里画一条进度条。`examples/slides` 这份《Typst 一小时入门》有 9 张内容幻灯片（两张是分步显示的），编出来是 17 页，`xuan` 里负责它的 `src/slides.typ` 只有 95 行。这一篇我先把这 17 页逐页渲染出来看，再把那 95 行拆开，最后补上它里面用到的绘图原语：`rect`、`circle`、`curve`、颜色、渐变、`tiling` 和描边。

> [!NOTE] 本篇检查点
> 这一篇结束时你会有一个新文件 `src/slides.typ`（**最终版**，95 行，文中完整展示），并在 `lib.typ` 里加上一行 `#import "src/slides.typ": only, slide, slides, uncover`。`lib.typ` 仍是**中间版本**（后面的章节还要往里加行）。`examples/slides/main.typ` 和 `lab/ch13/` 下的 8 个文件全部通过 `make ch13`。
> 前置：[第 12 篇](/posts/typst-by-xuan-12-homework/)（模块与 `include`）。`fonts.typ` 与 `page.typ`（`title-block`）在第 5、6 篇已经写好，这一篇的 `slides.typ` 直接复用它们。

## 先看成品：17 页，13 个编号

在 `~/Projects/typst-lab` 里，`nix develop` 之后 `make examples` 已经把 `out/examples/slides.pdf` 编好了。先数页数和页面尺寸：

```bash
pdfinfo out/examples/slides.pdf | grep -E 'Pages|Page size'
```

```text
Pages:           17
Page size:       841.89 x 473.563 pts
```

841.89 × 473.563 pt 是 `presentation-16-9` 这个纸张名对应的尺寸。再看页脚上印的数字，`pdftotext -layout` 把 17 页的文字抽出来，只留 `n / N` 的行：

```bash
pdftotext -layout out/examples/slides.pdf - | grep -E '[0-9]+ / [0-9]+' | tr -s ' ' | tr '\n' ';'
```

```text
 1 / 13; 2 / 13; 3 / 13; 3 / 13; 3 / 13; 4 / 13; 5 / 13; 6 / 13; 7 / 13; 8 / 13; 9 / 13; 9 / 13; 10 / 13; 11 / 13; 12 / 13; 13 / 13;
```

17 页只有 16 行，因为第 1 页是标题页，没有页脚。16 行里编号一共到 13，`3 / 13` 出现了三次，`9 / 13` 出现了两次：这就是“分步显示”在页脚上的样子，同一张幻灯片占几页，编号就重复几次。17 = 1 张标题页 + 4 张章节分隔页 + 12 页内容（其中“编译很快”占 3 页，“内置图形”占 2 页，另有 7 张单页幻灯片）；13 = 4 + 9，即 4 张分隔页加 9 张内容幻灯片。

这份文档编译要多久？`hyperfine` 的结果（`--warmup 2`，20 次运行）：

```bash
mkdir -p /tmp/p13
hyperfine -w 2 "typst compile --root . --ignore-system-fonts examples/slides/main.typ /tmp/p13/s.pdf"
```

```text
Benchmark 1: typst compile --root . --ignore-system-fonts examples/slides/main.typ /tmp/p13/s.pdf
  Time (mean ± σ):     135.5 ms ±   4.2 ms    [User: 229.0 ms, System: 86.5 ms]
  Range (min … max):   127.0 ms … 143.5 ms    20 runs
```

135.5 ms 编完 17 页，其中包括字体加载和页脚里要求 `counter.final()` 带来的多遍排版（这一机制见[第 7 篇](/posts/typst-by-xuan-07-context-counters-state/)）。

我把每一页渲染成 PNG 来看（这里的命令把输出放在 `/tmp`，`{0p}` 是补零的页码模板）：

```bash
typst compile --root . --ignore-system-fonts --format png --ppi 72 examples/slides/main.typ "/tmp/p13/slides-{0p}.png"
```

（路径里的 `/tmp/p13` 是我建的目录，先 `mkdir -p` 一下。）然后用 ImageMagick 7.1.2 的 `magick montage`（在 dev shell 之外运行，不是仓库的一部分）拼成一张总览：

![examples/slides 的 17 页总览：标题页、四张蓝色章节分隔页、三页逐步出现的“编译很快”、公式页、表格页、代码页、两页逐步出现的“内置图形”、渐变与描边页、小结与结束页](/assets/images/typst-by-xuan/ch13-deck-sheet.png)

源文件 `examples/slides/main.typ` 共 99 行，下面是它的前 26 行：用 `show: slides.with(...)` 套上模板，`=` 一级标题产生章节页，`#slide(...)[...]` 是内容页，第二张用了函数形式的 body 来分步（[完整源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/examples/slides/main.typ)）：

```typst
#import "@local/xuan:0.1.0": *

#show: slides.with(
  title: "Typst 一小时入门",
  subtitle: "标记、脚本与排版",
  author: "张三",
  date: "2026 年 10 月",
)

= 为什么是 Typst

#slide(title: "三种模式")[
  - 标记模式：默认，写正文
  - 代码模式：`#` 进入，写逻辑
  - 数学模式：`$ ... $`，写公式

  整个文档是一棵函数调用树，`set` 与 `show` 改变它的样式。
]

#slide(title: "编译很快", steps: 3, k => [
  编译一份 10 页文档：
  #v(0.5em)
  #uncover(k, from: 1)[- 解析：把标记变成语法树]
  #uncover(k, from: 2)[- 求值：运行代码，得到 content]
  #uncover(k, from: 3)[- 排版：多遍迭代，直到页码和引用稳定]
])
```

注意标题页上的日期是写死的字符串 `"2026 年 10 月"`，这不是偷懒，下面“日期”一节解释原因。

## 一张幻灯片就是一个 pagebreak 之后的内容

先把 95 行全文放在这里（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/packages/local/xuan/0.1.0/src/slides.typ)），后面按功能拆开讲：

```typst
// Slides: one page per slide, steps as extra pages, progress bar footer.
#import "fonts.typ": fonts
#import "page.typ": title-block

/// Content shown from step `from` on; before that it is hidden, so the
/// layout does not jump. `hide` leaves list markers and enum numbers drawn,
/// so they are blanked inside the hidden copy.
#let uncover(k, from: 1, body) = {
  if k >= from { body } else {
    hide({
      set list(marker: [])
      set enum(numbering: _ => [])
      body
    })
  }
}

/// Content present only at the listed step(s).
#let only(k, at: (1,), body) = {
  let steps = if type(at) == array { at } else { (at,) }
  if k in steps { body }
}

/// A slide. `body` is content, or a function `k => content` that is called
/// once per step and produces `steps` pages sharing one slide number.
#let slide(title: none, steps: 1, body) = {
  let steps = if type(body) == function { steps } else { 1 }
  for k in range(1, steps + 1) {
    pagebreak(weak: true)
    if k == 1 { counter("xuan-slide").step() }
    if title != none {
      block(text(size: 1.4em, weight: "bold", title), below: 0.9em)
    }
    if type(body) == function { body(k) } else { body }
  }
}

/// Footer: progress bar over `n / N`.
#let slide-footer() = context {
  let n = counter("xuan-slide").get().first()
  let total = counter("xuan-slide").final().first()
  let accent = rgb("#1f4e9c")
  stack(
    spacing: 4pt,
    block(width: 100%, height: 2pt, fill: luma(225), rect(
      width: 100% * n / calc.max(total, 1),
      height: 2pt,
      fill: accent,
      stroke: none,
    )),
    align(right, text(size: 0.6em, fill: luma(110))[#n / #total]),
  )
}

/// The whole deck. Level-1 headings become section-divider slides.
#let slides(
  title: none,
  subtitle: none,
  author: (),
  date: auto,
  aspect: "16-9",
  lang: "zh",
  body,
) = {
  set document(title: if title == none { "" } else { title })
  set page(
    paper: "presentation-" + aspect,
    margin: (x: 2em, top: 2.5em, bottom: 2em),
    footer: slide-footer(),
  )
  set text(font: fonts.sans, size: 20pt, lang: lang)
  set par(leading: 0.7em, spacing: 1em)
  show raw: set text(font: fonts.mono, size: 0.85em)
  show math.equation: set text(font: fonts.math)
  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    counter("xuan-slide").step()
    v(1fr)
    align(center, text(
      size: 1.8em,
      weight: "bold",
      fill: rgb("#1f4e9c"),
      it.body,
    ))
    v(1fr)
  }
  page(footer: none, align(horizon, title-block(
    title: title,
    subtitle: subtitle,
    author: author,
    date: date,
    lang: lang,
  )))
  body
}
```

它由四部分组成：`uncover`/`only`（逐步显示的两个小工具）、`slide`（一张幻灯片）、`slide-footer`（页脚）、`slides`（整份文档的模板）。从最外层的 `slides` 说起。

### 模板函数 slides：页面、字体和两种特殊页

`slides` 的签名和第 4 篇的 `note` 是一个路数：命名参数加最后一个位置参数 `body`，在 `#show: slides.with(...)` 里被当作模板调用。它做了四件事。

**第一，`set page`。** `paper: "presentation-16-9"` 是 `"presentation-" + aspect` 拼出来的，`aspect` 默认 `"16-9"`，传 `"4-3"` 就得到 4:3 的页面。边距写成 `(x: 2em, top: 2.5em, bottom: 2em)`，用 `em` 而不是 `cm`，大概是想让页边距跟着字号走。我在 72 ppi 的渲染图里看左边距：幻灯片标题的左缘大约在 40 px 处，也就是 40 pt，等于 20pt 字号的 2em，和预期一致。`footer: slide-footer()` 把页脚挂到每一页上。

**第二，字体。** `set text(font: fonts.sans, size: 20pt, lang: lang)` 用第 5 篇 `fonts.typ` 里的无衬线栈；幻灯片投影时无衬线更清晰，这是选择它而不是衬线栈的原因。`raw` 单独用等宽字体并缩到 0.85em（我觉得 20pt 的页面上代码块按默认大小会偏大），公式用 `fonts.math`。

**第三，章节页。** `show heading.where(level: 1)` 把一级标题整个重写成一张分隔页：先 `pagebreak(weak: true)`，再 `counter("xuan-slide").step()`，然后 `v(1fr)`、居中的标题、`v(1fr)`。两个 `1fr` 平分页面剩余的高度，标题就落在垂直正中。它输出的是 `it.body` 而不是 `it`，标题完全由这条规则自己排版。章节页也算一个“幻灯片”，要占一个编号（总览图里的 `1 / 13` 就是第一张章节页）。

**第四，标题页。** 最后一段 `page(footer: none, align(horizon, title-block(...)))`：`page` 作为函数调用，自成一页，并在这一页上覆盖了 `footer`，所以标题页没有页脚（这也是为什么上面 17 页只有 16 行 `n / N`）。里面直接复用第 6 篇写好的 `title-block`，`align(horizon, ...)` 让它垂直居中。

这四件事做完，用户在 `body` 里写的 `=` 和 `#slide` 就是全部输入。

### slide：一页，或者 N 页

```typst
#let slide(title: none, steps: 1, body) = {
  let steps = if type(body) == function { steps } else { 1 }
  for k in range(1, steps + 1) {
    pagebreak(weak: true)
    if k == 1 { counter("xuan-slide").step() }
    if title != none {
      block(text(size: 1.4em, weight: "bold", title), below: 0.9em)
    }
    if type(body) == function { body(k) } else { body }
  }
}
```

这段是这份文件的核心，值得逐行读。

- `body` 有两种形态：普通 content，或者一个 `k => content` 的函数。`type(body) == function` 判断是哪一种。
- 第一行 `let steps = ...` 把参数 `steps` 遮蔽（第 2 篇讲过的 shadowing）成一个新值：body 是 content 时一律是 1，`steps: 3` 配一个静态 body 不会生成三页一模一样的页面。
- 循环里每个 `k` 生成一页。`pagebreak(weak: true)` 放在每页的**开头**，而不是结尾：函数调用没有“结束时”的钩子，把分页写在开头，最后一页后面就不会拖一个空页。`weak` 的意思是：如果当前页本来就是空的（刚刚被 `page(...)` 或者前一次分页开出来），这次分页不生效。17 页的结果印证了这一点：1 + 4 + 12 = 17，没有任何空页。
- `if k == 1 { counter("xuan-slide").step() }`：**只有第一步**让编号加一。后面的步骤与它共享编号，页脚读到的就是同一个数，这就是上面 `3 / 13` 重复三次的来源。
- 标题是 1.4em 粗体的一个 `block`，`below: 0.9em` 拉开和正文的距离。
- 最后一行把 `k` 传给函数形态的 body。

分步显示在这里不是“在同一页上改动”，而是每一步重画一整页，像手绘动画的逐帧：每一帧都是完整的画。一张幻灯片因此就是 `steps` 次完整排版，代价是 body 要写成函数，好处是没有任何隐藏状态，任何一页单独拿出来都是自洽的。

用法就是前面摘录里的“编译很快”：把 `body` 写成 `k => [...]`，`steps: 3` 说明要三页。这个函数是最后一个位置参数，所以写在括号里面，前面的 `title:` 和 `steps:` 是命名参数。

### uncover 与 only：占位与不占位

```typst
#let uncover(k, from: 1, body) = {
  if k >= from { body } else {
    hide({
      set list(marker: [])
      set enum(numbering: _ => [])
      body
    })
  }
}

#let only(k, at: (1,), body) = {
  let steps = if type(at) == array { at } else { (at,) }
  if k in steps { body }
}
```

两个函数回答同一个问题的两个答案：“这一步还没到的时候，这块内容的位置要不要留着？”

- `uncover` 用 `hide`：内容被隐藏，但**仍然占着位置**。后面的内容不会因为它出现而被挤下去，页面布局在每一步之间保持不动。
- `only` 用“不输出”：内容只在列出的步骤里存在，其他步骤里完全不存在，不占位。`at` 可以是单个整数或者整数数组，函数开头用 `type(at) == array` 把单个数包成一元数组，再用 `k in steps` 判断。默认 `(1,)` 表示只在第一步出现，用来写“第一步的占位提示，下一步换掉”之类的内容。

`uncover` 里多出来的那两行 `set` 有一段来历。最朴素的写法是 `if k >= from { body } else { hide(body) }`，xuan 的 `uncover` 一开始就是这样写的，渲染出来第 4 页是这样（这张图来自 `uncover` 修复之前的仓库状态）：

![修复前的“编译很快”第一步：第一条有文字，后两条没有文字却留着圆点](/assets/images/typst-by-xuan/ch13-deck-step1-before.png)

被隐藏的条目只有文字消失了，圆点还在。我在 `/tmp` 里把它缩成最小复现（`k = 1`，只有 `/tmp`，不在仓库中）：

```typst
#set page(width: 8cm, height: auto, margin: 8pt)
#let uncover(k, from: 1, body) = if k >= from { body } else { hide(body) }
#let k = 1
#uncover(k, from: 2)[- 乙]
#uncover(k, from: 3)[- 丙]
#line(length: 100%)
#uncover(k, from: 1)[- 甲]
#uncover(k, from: 2)[- 乙]
```

`pdftotext -layout` 的输出：

```text
•
•


• 甲
•
```

上半部分两个条目都被 `hide` 了，输出里却有两个 `•`；下半部分只有“甲”可见，“乙”也留下了圆点。（我另外试过单独一个 `#hide[- 隐藏的列表项]` 后面跟一段正文，它连圆点一起隐藏了，所以这个现象和列表相邻的情形有关，具体原因我没有深挖。）把圆点放在 `uncover` 外面的写法 `- #uncover(k, from: 2)[乙]` 我也试了，圆点同样会显示。

结论是：`hide` 在这里只保证文字不可见，列表的标记（和枚举的数字）仍会被画出来。xuan 的做法是在隐藏的那一份里，把标记本身换成空内容：`set list(marker: [])` 和 `set enum(numbering: _ => [])`。两条 `set` 写在 `hide({ ... })` 的代码块里，作用范围只到这个块，可见的那一份不受影响；`hide` 之后条目的行高和位置没变，所以布局仍然不跳。我用 xuan 里现在的 `uncover` 重跑同样的三项（`k = 1`，同样只在 `/tmp`）：

```typst
#import "@local/xuan:0.1.0": uncover
#set page(width: 8cm, height: auto, margin: 8pt)
#let k = 1
#uncover(k, from: 1)[- 甲]
#uncover(k, from: 2)[- 乙]
#uncover(k, from: 3)[- 丙]
```

```text
• 甲
```

现在只有“甲”那一行。真实的第 4 页（`pdftotext` 的输出里只有一行条目）：

![修复后的“编译很快”第一步：只有第一条条目可见，后两条完全看不见](/assets/images/typst-by-xuan/ch13-deck-step1.png)

第 6 页（`k = 3`）三条全部可见，第一条在两张图里的位置没有动：

![“编译很快”第三步：三条条目全部可见](/assets/images/typst-by-xuan/ch13-deck-step3.png)

`only` 在不涉及占位的场景里没有这个问题，例如“内置图形”那一页：

```typst
#slide(title: "内置图形", steps: 2, k => [
  #align(center, box(width: 12em, height: 6em, {
    place(rect(width: 5em, height: 4em, fill: rgb("#cfe0f5"), radius: 4pt))
    place(dx: 6.5em, circle(radius: 2em, fill: rgb("#f5d9cf")))
    only(k, at: 2, place(dx: 4.8em, dy: 2em, line(
      length: 2em,
      stroke: 2pt + rgb("#1f4e9c"),
    )))
  }))
  #uncover(k, from: 2)[矩形与圆之间多了一条线。]
])
```

`box(width: 12em, height: 6em, { ... })` 先给出一块固定大小的画布，里面的矩形和圆都用 `place` 摆放，`place` 不占流内空间，所以 `only(k, at: 2, place(...))` 在第 2 步才出现的那条线，既不需要预留位置，也不会推动任何东西。第 12、13 页如下：

![“内置图形”第一步：一个蓝色矩形和一个浅红色圆，中间没有线](/assets/images/typst-by-xuan/ch13-deck-draw1.png)

![“内置图形”第二步：矩形与圆之间多了一条蓝色短线，下方出现说明文字](/assets/images/typst-by-xuan/ch13-deck-draw2.png)

第二步下方多出来的“矩形与圆之间多了一条线。”是 `uncover(k, from: 2)` 控制的：第一步里它是隐藏的，位置留着，所以图在两步之间没有跳动。

### 页脚：进度条是怎么算出来的

```typst
#let slide-footer() = context {
  let n = counter("xuan-slide").get().first()
  let total = counter("xuan-slide").final().first()
  let accent = rgb("#1f4e9c")
  stack(
    spacing: 4pt,
    block(width: 100%, height: 2pt, fill: luma(225), rect(
      width: 100% * n / calc.max(total, 1),
      height: 2pt,
      fill: accent,
      stroke: none,
    )),
    align(right, text(size: 0.6em, fill: luma(110))[#n / #total]),
  )
}
```

它用到了上一篇的全部家当：

- 整个函数体包在 `context` 里，因为 `counter(...).get()` 和 `.final()` 都需要知道“当前在哪”。页脚在每一页上各被求值一次，每次的 `get()` 都是该页的编号。
- `counter("xuan-slide")` 是一个按字符串命名的自定义计数器，不绑定任何元素。`slide` 和章节页在各自开头 `step()` 它，页脚只读。
- `.get().first()` 是当前页的编号 `n`，`.final().first()` 是整份文档最后的值 `total`（这里是 13，不是页数 17：编号按“幻灯片”算，不按“页”算）。读 `.final()` 的代价是文档至少要排两遍，这也是 135.5 ms 里包含的东西。
- 进度条是两层：灰色轨道 `block(width: 100%, height: 2pt, fill: luma(225), ...)`，里面一条 `n / total` 比例的蓝色 `rect`。`rect` 的宽度写成 `100% * n / calc.max(total, 1)`，这是一个相对长度，相对于外层轨道 `block` 的宽度，所以不需要知道页面有多宽。`calc.max(total, 1)` 防止没有任何幻灯片编号时除以零。右下角是 `n / total` 的数字，0.6em 灰色。
- 我在 `/tmp` 里核对了这个比例（只在 `/tmp`，不在仓库里）：200pt 宽的页面，`n = 3`、`total = 13`，渲染到 72 ppi 后蓝色条的宽度是 46 px，与 200 × 3 / 13 = 46.15 相符。

进度条的几何关系，我用一张手绘的假幻灯片（`lab/ch13/fig-slide.typ`）单独画了出来（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch13/fig-slide.typ)）：`rect` 当页面边框，`place(bottom + left, ...)` 把一条 33% 宽的蓝条放在左下角：

```typst
// One slide of examples/slides, rendered as a PNG figure.
#import "@local/xuan:0.1.0": *

#set page(width: auto, height: auto, margin: 12pt)
#set text(font: fonts.sans, size: 14pt, lang: "zh")

#rect(
  width: 20em,
  height: 11.25em,
  stroke: 0.6pt + luma(160),
  inset: 1.2em,
)[
  #text(size: 1.4em, weight: "bold")[三种模式]
  #v(0.6em)
  - 标记模式：默认，写正文
  - 代码模式：`#` 进入，写逻辑
  - 数学模式：`$ ... $`，写公式
  #place(bottom + left, dy: 0.6em, rect(
    width: 33%,
    height: 2pt,
    fill: rgb("#1f4e9c"),
    stroke: none,
  ))
]
```

![用 rect 手绘的一页假幻灯片：粗体标题“三种模式”，三条要点，左下角一条蓝色进度条，宽度约为页面的三分之一](/assets/images/typst-by-xuan/ch13-slide.png)

### 日期：datetime.today() 与 SOURCE_DATE_EPOCH

`slides` 把 `date` 原样交给第 6 篇的 `title-block`。`title-block` 对 `date` 有三种处理：`auto` 取 `datetime.today()` 并按中文格式显示，`datetime` 值显示成 `2026-10-19` 的样式，字符串原样输出。`examples/slides` 传的是第三种。

原因在 dev shell。`nix develop` 的 stdenv 习惯把 `SOURCE_DATE_EPOCH` 设成 1980-01-01，这会让 `datetime.today()` 永远是 1980 年；`typst-lab` 的 `flake.nix` 在 `shellHook` 里把它 `unset` 了（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/flake.nix)里就是一行 `unset SOURCE_DATE_EPOCH`，为的是让 `datetime.today()` 回到真实的日期）。我在 `/tmp` 里写了两个文件验证（只在 `/tmp`，不在仓库里）：

```typst
#import "@local/xuan:0.1.0": *
#show: slides.with(title: "日期", date: auto)
```

```typst
#import "@local/xuan:0.1.0": *
#show: slides.with(title: "日期", date: datetime(
  year: 2026,
  month: 10,
  day: 19,
))
```

```bash
typst compile --root /tmp --ignore-system-fonts today.typ a.pdf
pdftotext a.pdf - | grep 年
SOURCE_DATE_EPOCH=315532800 typst compile --root /tmp --ignore-system-fonts today.typ b.pdf
pdftotext b.pdf - | grep 年
SOURCE_DATE_EPOCH=315532800 typst compile --root /tmp --ignore-system-fonts today-fixed.typ c.pdf
pdftotext c.pdf - | grep -E '[0-9]{4}'
```

```text
2026 年 10 月 19 日
1980 年 1 月 1 日
2026-10-19
```

第一行是 dev shell 里 `date: auto` 的结果（`SOURCE_DATE_EPOCH` 未设置）。第二行我手动设 `SOURCE_DATE_EPOCH=315532800`（1980-01-01 00:00 UTC，也就是上面说的 nix 默认值）后，`date: auto` 变成了 1980 年；第三行里同样设置，但源码里传的是显式的 `datetime(...)`，仍然是 2026-10-19，不受环境变量影响。

所以结论是：`date: auto` 的幻灯片，其日期取决于编译时的环境，不是源文件的函数。想要可复现的输出（CI 里、别人机器上），就像 `examples/slides` 那样写死日期。

## 绘图原语

幻灯片里的图形来自 Typst 内置的绘图函数，不需要任何包。`lab/ch13/` 的 6 个文件逐个过一遍：形状、曲线、颜色、渐变、tiling、描边。为了在文中放图，我用一个 `/tmp` 里的包装文件把每个 lab 文件 `include` 进一个 `width: auto, height: auto` 的页面，再渲染成 PNG（只在 `/tmp`，不在仓库里）：

```typst
#set page(width: auto, height: auto, margin: 8pt)
#include "/home/bfmhno3/Projects/typst-lab/lab/ch13/" + sys.inputs.name + ".typ"
```

```bash
typst compile --root / --ignore-system-fonts --input name=shapes --format png --ppi 144 crop.typ shapes.png
```

`make ch13` 本身的输出：

```text
$ make ch13
./scripts/chapter.sh ch13
ok   lab/ch13/color.typ
ok   lab/ch13/curve.typ
ok   lab/ch13/fig-drawing.typ
ok   lab/ch13/fig-slide.typ
ok   lab/ch13/gradient.typ
ok   lab/ch13/shapes.typ
ok   lab/ch13/stroke.typ
ok   lab/ch13/tiling.typ
```

### 形状：rect、square、circle、ellipse、line、polygon

`lab/ch13/shapes.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch13/shapes.typ)）：

```typst
// Built-in shapes: rect, square, circle, ellipse, line, polygon.
#import "@local/xuan:0.1.0": *
#set text(font: fonts.sans, size: 10pt)
#let blue = rgb("#1f4e9c")
#let tint = rgb("#cfe0f5")

#grid(
  columns: 3,
  gutter: 1.2em,
  rect(width: 4em, height: 2.5em, fill: tint, stroke: blue),
  // `radius` rounds corners; a dictionary sets each corner.
  rect(
    width: 4em,
    height: 2.5em,
    fill: tint,
    radius: (top-left: 8pt, bottom-right: 8pt),
  ),
  // `square` is a rect whose `size` fixes both sides.
  square(size: 2.5em, fill: tint, stroke: blue),
  circle(radius: 1.2em, fill: tint, stroke: blue),
  ellipse(width: 4em, height: 2.5em, fill: tint, stroke: blue),
  // A shape can hold content; `inset` pads it.
  rect(fill: tint, inset: 8pt)[文字],
  line(length: 4em, stroke: 2pt + blue),
  line(start: (0pt, 0pt), end: (4em, 2em), stroke: 1pt),

  polygon(
    fill: tint,
    stroke: blue,
    (0pt, 2.5em),
    (1.5em, 0pt),
    (3em, 2.5em),
  ),
)
// Shapes are ordinary content: they have a type and can be inspected.
#assert.eq(repr(rect().func()), "rect")
```

![六种形状：矩形、两个对角圆角的矩形、正方形、圆、椭圆、带文字的矩形，下一行是粗直线、斜线和三角形](/assets/images/typst-by-xuan/ch13-shapes.png)

几点值得记：

- 所有形状都有 `fill` 和 `stroke`。`stroke: blue` 只指定颜色，粗细用默认值。
- `rect` 的 `radius` 可以是一个长度，也可以是一个字典（`top-left`、`bottom-right` 等四个角分别设置）。图里第二个矩形的左上和右下是圆角。
- `square(size: ...)` 就是 `width` 和 `height` 相等的 `rect`；`circle(radius: ...)` 用半径，`ellipse` 给 `width` 和 `height`。
- 形状可以带内容：`rect(fill: tint, inset: 8pt)[文字]`，`inset` 是内容到边框的距离。不给尺寸时它收缩到内容的大小，这就是图里“文字”那个浅蓝色块。
- `line` 有两种写法：`line(length: 4em)` 画一条水平线，`line(start: ..., end: ...)` 给出两个端点。三角形用 `polygon` 给顶点列表。
- 形状是普通 content：文件最后一行 `#assert.eq(repr(rect().func()), "rect")` 说明 `rect()` 的 `func` 就是 `rect`，可以用第 3 篇的内省办法检查。

### curve：由分段组成的路径

`curve` 与 `polygon` 的区别在于它的参数是一串**路径分段**，包括直线、二次与三次贝塞尔曲线，可以画出光滑的形状。`lab/ch13/curve.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch13/curve.typ)）：

```typst
// `curve` draws paths from components: move, line, quad, cubic, close.
#let blue = rgb("#1f4e9c")

// A closed triangle.
#curve(
  fill: rgb("#cfe0f5"),
  stroke: blue,
  curve.move((0pt, 40pt)),
  curve.line((30pt, 0pt)),
  curve.line((60pt, 40pt)),
  curve.close(),
)

#v(1em)
// A cubic Bezier: start, two control points, end.
#curve(
  stroke: 2pt + blue,
  curve.move((0pt, 40pt)),
  curve.cubic((20pt, -10pt), (60pt, 90pt), (80pt, 40pt)),
)

#v(1em)
// A quadratic Bezier; `relative: false` makes the control point absolute.
#curve(
  stroke: 2pt + blue,
  curve.move((0pt, 30pt)),
  curve.quad((30pt, -20pt), (60pt, 30pt), relative: false),
)
```

![curve 的三个例子：闭合的浅蓝三角形，一条三次贝塞尔曲线（S 形），一条二次贝塞尔曲线（拱形）](/assets/images/typst-by-xuan/ch13-curve.png)

分段都是 `curve` 下的子函数：`curve.move` 把笔移到起点，`curve.line` 画直线，`curve.quad` 给一个控制点和终点，`curve.cubic` 给两个控制点和终点，`curve.close` 把路径封闭回起点，图里的三角形用它。

最后一个例子传的是 `relative: false`，也就是控制点和终点都是绝对坐标（这是默认值）。我在 `/tmp` 里把 `relative` 分别设成 `false` 和 `true` 画在一起（左 `false`，右 `true`）：

```typst
#set page(width: auto, height: auto, margin: 8pt)
#let blue = rgb("#1f4e9c")
#grid(
  columns: 2,
  gutter: 2em,
  curve(
    stroke: 2pt + blue,
    curve.move((0pt, 30pt)),
    curve.quad((30pt, -20pt), (60pt, 30pt), relative: false),
  ),
  curve(
    stroke: 2pt + blue,
    curve.move((0pt, 30pt)),
    curve.quad((30pt, -20pt), (60pt, 30pt), relative: true),
  ),
)
```

![两条二次曲线：左边是拱形（绝对坐标），右边的整体向右下偏移（相对坐标，控制点和终点都以上一个点为原点）](/assets/images/typst-by-xuan/ch13-curve-relative.png)

`relative: true` 时点是相对于上一个点的偏移，所以同样的数字画出来完全是另一条线。所以 lab 文件里的注释写成“`relative: false` makes the control point absolute”，`false` 是默认值，写出来是为了让读的人看见这一点。

### 颜色：色彩空间与方法

`lab/ch13/color.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch13/color.typ)）：

```typst
// Color spaces, color methods and built-in maps.
#let swatch(c) = box(width: 2.2em, height: 1.2em, fill: c)
#let row(name, ..cs) = [#name: #cs.pos().map(swatch).join(h(2pt)) \ ]

#row("rgb", rgb("#1f4e9c"), rgb(31, 78, 156), rgb(12%, 30%, 61%))
#row("luma", luma(0), luma(128), luma(230))
#row("oklab", oklab(70%, 0.1, 0.1), oklab(70%, -0.1, 0.1))
#row("oklch", oklch(70%, 0.15, 30deg), oklch(70%, 0.15, 200deg))
#row("cmyk", cmyk(100%, 50%, 0%, 20%))
#row("hsl", color.hsl(210deg, 70%, 40%))

// Methods return new colors; the original is unchanged.
#let base = rgb("#1f4e9c")
#row(
  "methods",
  base.lighten(40%),
  base.darken(30%),
  base.rotate(120deg),
  base.transparentize(60%),
  base.negate(),
)
// `mix` blends in a chosen space; `components` reads the numbers back.
#row("mix", color.mix(red, blue), color.mix(red, blue, space: oklab))
#assert.eq(luma(50%).components(alpha: false).len(), 1)
// `color.map` holds ready-made color arrays (here 9 stops), also usable in gradients.
#row("map", ..color.map.viridis)
```

![九行色块：rgb 三块几乎相同的蓝色、luma 的黑灰浅灰、oklab 的橙与绿、oklch 的粉红与青、cmyk 的深蓝、hsl 的蓝、methods 的五种变换（浅蓝、深蓝、暗红、淡蓝、褐黄）、mix 的两块相同的紫色、map 的 viridis 九色](/assets/images/typst-by-xuan/ch13-colors.png)

Typst 的颜色是带“色彩空间”的值：`rgb`、`luma`（灰度）、`oklab`、`oklch`、`cmyk` 都是顶层构造函数，lab 文件里的 hsl 写成了 `color.hsl`。同一个蓝色可以用不同方式表达，我用 `typst eval` 核对了第一行的三块：

```bash
typst eval 'rgb("#1f4e9c").to-hex()'
typst eval 'repr(rgb(31, 78, 156) == rgb("#1f4e9c"))'
typst eval 'repr(rgb(12%, 30%, 61%).to-hex())'
```

```text
"#1f4e9c"
"true"
"\"#1f4c9c\""
```

十六进制和 `rgb(31, 78, 156)` 是同一个颜色；百分比那一块是我凑的数，其实是 `#1f4c9c`，红绿蓝各差一两个单位，肉眼分不出来，所以图里三块“几乎相同”。

颜色的方法**都返回新颜色**，原来的不变。同一个基色 `#1f4e9c`，我用 `typst eval` 读出每个方法的结果：

|表达式|结果|
|---|---|
|`base.lighten(40%)`|`#7995c4`|
|`base.darken(30%)`|`#16376d`|
|`base.rotate(120deg)`|`#8e2731`|
|`base.transparentize(60%)`|`#1f4e9c66`（最后两位 `66` 是 alpha）|
|`base.negate()`|`#9e6900`|
|`base.components()`|`["12.16%", "30.59%", "61.18%", "100%"]`|

这正好对上图里 methods 那一行的五块色。`rotate(120deg)` 是在色相环上转 120 度，所以蓝变成了暗红；`transparentize(60%)` 把透明度加到 60%，alpha 变成 40%，十六进制里就是 `66`。

`color.mix` 的混合空间是个坑：

```bash
typst eval 'color.mix(red, blue).to-hex()'
typst eval 'color.mix(red, blue, space: oklab).to-hex()'
typst eval 'color.mix(red, blue, space: rgb).to-hex()'
```

```text
"#a37095"
"#a37095"
"#805b87"
```

默认空间是 `oklab`（前两行相同），所以 lab 里 mix 那一行的两块是同一个紫色（图里确实一样）；在 `rgb` 里混合是 `#805b87`，更暗更灰，因为 sRGB 的数值空间对人眼来说不均匀。

最后一行 `color.map.viridis` 是一个内置的颜色数组，`.len()` 是 9；`color.map.turbo` 的长度是 256（我同样用 `typst eval` 核对了）。lab 里用 `..cs.pos()` 之类把它展开，在渐变里则直接 `..color.map.turbo` 展开成色标。

### 渐变：linear、radial、conic

`lab/ch13/gradient.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch13/gradient.typ)）：

```typst
// Three gradient kinds, all usable wherever a fill or stroke is.
#let stops = (rgb("#1f4e9c"), rgb("#e7a33e"))
#let box(g) = rect(width: 8em, height: 4em, fill: g)

#grid(
  columns: 3,
  gutter: 1em,
  box(gradient.linear(..stops)), box(gradient.linear(..stops, angle: 45deg)),
  // Explicit stops: (color, position).
  box(gradient.linear((red, 0%), (white, 30%), (blue, 100%))),
  box(gradient.radial(..stops)),
  box(gradient.radial(..stops, center: (20%, 30%), radius: 80%)),

  box(gradient.conic(..stops)),
  // Interpolation space changes the midpoint: try oklab vs srgb.
  box(gradient.linear(red, blue, space: oklab)),
  box(gradient.linear(red, blue, space: rgb)),
  // A built-in map plus `.sharp` for banding.
  box(gradient.linear(..color.map.turbo)),
  box(gradient.linear(..stops).sharp(5)),
)

#let g = gradient.linear(..stops)
// `sample` reads a color back at a ratio (in the gradient space, oklab).
#assert.eq(rgb(g.sample(0%)).to-hex(), "#1f4e9c")
#assert.eq(g.stops().len(), 2)
```

![十个渐变色块：线性渐变（水平、45 度、红白蓝三色显式色标）、径向渐变（居中、偏心）、圆锥渐变、红到蓝在 oklab 与 sRGB 两个空间里的对比、turbo 彩虹、五段硬边色带](/assets/images/typst-by-xuan/ch13-gradients.png)

渐变是一个值，可以出现在任何要颜色的地方（`fill`、`stroke`、文字的 `fill`）。三种：

- `gradient.linear(..)`：沿一个方向变化，`angle:` 改方向。色标可以直接给颜色（均分），也可以给 `(颜色, 位置)` 对，如图里第三个红、白、蓝，白色被拉到 30% 处。
- `gradient.radial(..)`：从中心向外，`center` 和 `radius` 控制圆心与半径。图里第二行的第二块把圆心移到 `(20%, 30%)`。
- `gradient.conic(..)`：绕中心旋转的角度渐变，图里第二行第三块，两种颜色在分界线上有一条硬边。

**插值空间**决定渐变的中间色。默认是 `oklab`，我核对了一下：

```bash
typst eval 'gradient.linear(red, blue).space() == oklab'
typst eval 'gradient.linear(red, blue, space: oklab).sample(50%).to-hex()'
typst eval 'gradient.linear(red, blue, space: rgb).sample(50%).to-hex()'
```

```text
true
"#a37095"
"#805b87"
```

和上面 `mix` 的两个结果一致：在 `oklab` 里红到蓝的中点是 `#a37095`，在 sRGB 里是 `#805b87`。图里第三行前两块就是这一对，左边（`oklab`）中间明显更亮。

另外两个值得一记的：`.sharp(5)` 把平滑渐变切成 5 段硬边色带，图里最后一块；`..color.map.turbo` 把 256 个色标一次展开成渐变，得到彩虹条。文件最后两条 `assert` 用 `sample` 和 `stops` 读回渐变：`rgb(g.sample(0%)).to-hex()` 等于起点色 `#1f4e9c`，`g.stops().len()` 是 2。`sample` 返回的颜色在渐变自己的空间（这里是 `oklab`）里，所以断言前先用 `rgb(...)` 转了一下。

### tiling：用一小块图案铺满

`tiling` 把一块小内容重复，当作 `fill` 用。`lab/ch13/tiling.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch13/tiling.typ)）：

```typst
// `tiling` repeats a cell to fill a shape (patterns).
#let blue = rgb("#1f4e9c")

// Diagonal hatching.
#let hatch = tiling(size: (8pt, 8pt))[
  #place(line(start: (0%, 100%), end: (100%, 0%), stroke: 0.8pt + blue))
]
// Dots, with `spacing` between cells.
#let dots = tiling(size: (10pt, 10pt), spacing: (4pt, 4pt))[
  #align(center + horizon, circle(radius: 2pt, fill: blue))
]
// Tilings take a relative frame: `parent` makes them align across shapes.
#let grid-cell = tiling(size: (12pt, 12pt), relative: "parent")[
  #rect(width: 100%, height: 100%, stroke: 0.4pt + luma(150))
]

#grid(
  columns: 3,
  gutter: 1em,
  rect(width: 6em, height: 4em, fill: hatch, stroke: blue),
  rect(width: 6em, height: 4em, fill: dots),
  rect(width: 6em, height: 4em, fill: grid-cell),
)
```

![三个矩形：左边是蓝色斜线填充，中间是整齐的蓝色圆点，右边是灰色方格网](/assets/images/typst-by-xuan/ch13-tiling.png)

左边是斜线填充，中间是圆点，右边的方格网用 `relative: "parent"` 让方格相对于父容器对齐。

圆点那一格用的是 `align(center + horizon, ...)`，而不是上面斜线用的 `place`。这不是风格问题：我在 `/tmp` 里把三种写法并排比较了（只在 `/tmp`，不在仓库里）：

```typst
#set page(width: auto, height: auto, margin: 8pt)
#let blue = rgb("#1f4e9c")
#let a = tiling(size: (10pt, 10pt), spacing: (4pt, 4pt))[
  #place(center + horizon, circle(radius: 2pt, fill: blue))
]
#let b = tiling(size: (10pt, 10pt), spacing: (4pt, 4pt))[
  #align(center + horizon, circle(radius: 2pt, fill: blue))
]
#let c = tiling(size: (10pt, 10pt), spacing: (4pt, 4pt))[
  #place(dx: 3pt, dy: 3pt, circle(radius: 2pt, fill: blue))
]
#grid(
  columns: 3,
  gutter: 1em,
  rect(width: 6em, height: 4em, fill: a),
  rect(width: 6em, height: 4em, fill: b),
  rect(width: 6em, height: 4em, fill: c),
)
```

![三种圆点图案：左边（place + center + horizon）每个点只剩左上角的四分之一，中间（align + center + horizon）和右边（place + dx/dy）都是完整的圆点](/assets/images/typst-by-xuan/ch13-tiling-fix.png)

`a` 用 `place(center + horizon, ...)`，每个点只剩左上角；`b` 用 `align`，`c` 用 `place` 加显式偏移，都是完整的圆点。我的猜测是：`tiling` 的 body 不是在一个固定 `size` 的容器里排版的，`place` 的对齐目标是一个没有尺寸的区域，`center + horizon` 因此对准了左上角这个原点；而 `align` 参与了内容自身的排版，用的是 `size` 给出的单元。我没有去翻 Typst 的源码确认，只能说这是三种写法的实测差异。

`tiling(size: ..., spacing: ..., relative: ...)` 的三个参数：`size` 是一个单元的大小，`spacing` 是单元之间的间距（中间那种圆点图案里的空白就来自它），`relative` 说明图案相对谁对齐，lab 里的方格网用了 `"parent"`，让图案相对于父容器对齐，多个形状上的图案就能连成一整块。

### 描边：字典的写法

`lab/ch13/stroke.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch13/stroke.typ)）：

```typst
// A stroke is paint + thickness + dash + cap + join, or a dictionary.
#let blue = rgb("#1f4e9c")
#let ln(s) = line(length: 8em, stroke: s)

#ln(1pt + blue) // shorthand: length + color
#ln((paint: blue, thickness: 3pt, cap: "round"))
#ln((paint: blue, thickness: 2pt, dash: "dashed"))
#ln((paint: blue, thickness: 2pt, dash: "dotted"))
#ln((paint: blue, thickness: 2pt, dash: (array: (6pt, 3pt, 1pt, 3pt))))
#ln((paint: gradient.linear(red, blue), thickness: 4pt))

// Per-side strokes on a rect; `none` hides a side.
#rect(
  width: 8em,
  height: 3em,
  stroke: (top: 2pt + blue, bottom: 2pt + blue, rest: 0.5pt + luma(150)),
)
// `join` matters on sharp corners.
#polygon(
  stroke: (paint: blue, thickness: 6pt, join: "round"),
  (0pt, 30pt),
  (30pt, 0pt),
  (60pt, 30pt),
)
// A stroke value is inspectable.
#assert.eq((1pt + blue).thickness, 1pt)
```

![八个描边示例：细蓝线、圆头粗线、虚线、点线、点划线、红到蓝渐变的粗线、上下蓝边其余灰边的矩形、圆角连接的三角形](/assets/images/typst-by-xuan/ch13-strokes.png)

描边是 `paint`（颜色或渐变）、`thickness`、`dash`、`cap`、`join` 的组合。有两种写法：

- 简写：`1pt + blue`，长度加颜色。`repr(1pt + rgb("#1f4e9c"))` 的输出是 `1pt + rgb("#1f4e9c")`。
- 字典：`(paint: blue, thickness: 3pt, cap: "round")`，可以写全部五个键。

`dash` 接受预设字符串或者自定义数组。我用 `typst eval` 把预设展开成了数组：

```bash
typst eval 'repr(stroke((paint: red, thickness: 2pt, dash: "dashed")).dash)'
typst eval 'repr(stroke((paint: red, thickness: 2pt, dash: "dotted")).dash)'
```

```text
"(array: (3pt, 3pt), phase: 0pt)"
"(array: (\"dot\", 2pt), phase: 0pt)"
```

`"dashed"` 是“线 3pt、空 3pt”；`"dotted"` 是一个 `"dot"` 加 2pt 空。自定义的 `(array: (6pt, 3pt, 1pt, 3pt))` 是“线 6pt、空 3pt、线 1pt、空 3pt”循环，就是图里的点划线。`paint` 也可以是渐变（图里第六条红到蓝的粗线）。

图里倒数第二个矩形展示了**逐边描边**：`stroke: (top: 2pt + blue, bottom: 2pt + blue, rest: 0.5pt + luma(150))`，上下两条蓝色粗边，剩下的边（`rest`）是灰色细边。最后一个三角形用 `join: "round"` 让尖角变圆；文件末尾的 `assert.eq((1pt + blue).thickness, 1pt)` 说明描边值可以读回属性。

### 一张小拼图

`lab/ch13/fig-drawing.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch13/fig-drawing.typ)）把以上的东西拼在一起，是 `make ch13` 直接输出的图（`out/figures/ch13-drawing.png`）：

```typst
// A small gallery: shapes, a gradient, a tiling and a dashed stroke.
#set page(width: auto, height: auto, margin: 12pt)
#let blue = rgb("#1f4e9c")
#let hatch = tiling(size: (8pt, 8pt))[
  #place(line(start: (0%, 100%), end: (100%, 0%), stroke: 0.8pt + blue))
]

#grid(
  columns: 4,
  gutter: 14pt,
  rect(width: 60pt, height: 40pt, fill: rgb("#cfe0f5"), stroke: blue),
  circle(radius: 20pt, fill: gradient.radial(white, blue)),
  rect(width: 60pt, height: 40pt, fill: hatch, stroke: blue),
  polygon(
    fill: rgb("#f5d9cf"),
    stroke: (paint: blue, thickness: 2pt, dash: "dashed"),
    (0pt, 40pt),
    (30pt, 0pt),
    (60pt, 40pt),
  ),
)
```

![四个图形：浅蓝矩形、白到蓝的径向渐变圆、斜线填充的矩形、虚线描边的浅红三角形](/assets/images/typst-by-xuan/ch13-drawing.png)

## 回到幻灯片：把图形放进 slide

`examples/slides` 里有一页专门用了这篇的东西，“渐变与描边”（第 14 页）：左边 `gradient.linear` 填充的矩形，右边 `fill: none` 加虚线描边的矩形，放在一个两列的 `grid` 里（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/examples/slides/main.typ) 的 70 到 86 行）：

```typst
#slide(title: "渐变与描边")[
  #grid(
    columns: 2,
    gutter: 1em,
    rect(
      width: 100%,
      height: 4em,
      fill: gradient.linear(rgb("#1f4e9c"), rgb("#e7a33e")),
    ),
    rect(
      width: 100%,
      height: 4em,
      fill: none,
      stroke: (paint: rgb("#1f4e9c"), thickness: 2pt, dash: "dashed"),
    ),
  )
]
```

渲染出来就是总览图里倒数第四页，左右各一个 `width: 100%` 的块，`gutter: 1em` 隔开。

## 往下走

`slides.typ` 的 95 行已经够做一份像样的课堂幻灯片，但缺的东西也很明显：没有备注页、没有页眉、没有主题切换、没有动画之外的过渡。这些都有现成的包。[第 14 篇](/posts/typst-by-xuan-14-packages-ecosystem/)会用同一份内容的三张幻灯片，用 `touying` 重做一遍，并把代码量与 `examples/slides` 做对比；同一篇里还会用 `cetz` 画图、`lilaq` 画函数曲线，处理的正是这一篇里的“手写 `place` 和 `rect`”之外的需求。
