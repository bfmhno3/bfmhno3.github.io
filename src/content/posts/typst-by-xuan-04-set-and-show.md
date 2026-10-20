---
title: "set 与 show：样式是规则，不是命令"
commentId: "post:typst-by-xuan-04-set-and-show"
published: "2026-10-19 11:00:00 +08:00"
description: "用 Xuan 从零学 Typst 第 4 篇：我用 Typst 0.15.1 编译了 ch04 的 6 个 lab 文件和一批临时实验，弄清 set、show、选择器和 numbering 各自管什么，再把它们收进本地包 @local/xuan:0.1.0 的 base 与 note 模板，让 #show: note.with(...) 一行排出带目录的 A4 笔记。"
category: Tutorial
tags:
  - Typst
  - Xuan
  - 样式
  - 模板
series: "用 Xuan 从零学 Typst"
seriesOrder: 4
draft: false
comment: true
slug: typst-by-xuan-04-set-and-show
---

在 Typst 里改字号只需要写一行 `#set text(size: 14pt)`，但这一行不是“从现在起把字号调成 14pt”的命令，而是往样式表里登记一条规则：从这里到所在作用域结束，所有 `text` 的 `size` 默认值是 14pt。区别听上去很学究，直到你要写模板的时候：一个模板，就是一组被登记进去的规则，加上一个把正文包起来的函数。这一篇我把 `set`、`show`、选择器和编号逐个跑一遍，然后用它们搭出 `xuan` 的第一版 `note` 模板。

> [!NOTE] 本篇检查点
> 这一篇结束时你会有：本地包 `@local/xuan:0.1.0` 的骨架，即 `typst.toml`、`lib.typ`、`src/base.typ`、`src/note.typ`。这四个文件里 `typst.toml` 是最终版，其余三个是**中间版本**，后面的章节还会往里加 import 和参数，我会在文中说明每个文件之后长了什么。`lab/ch04/` 下的 6 个文件（含一个预期失败的）全部通过 `make ch04`。
> `note` 依赖的 `fonts.typ`、`cjk.typ`、`page.typ`、`header.typ`、`theorem.typ` 要到第 5 到第 7 篇才逐个讲，现在先把仓库里的 `src/` 整个拷过来用，把它们当黑盒就行。
> 前置：[第 3 篇](/posts/typst-by-xuan-03-functions-and-content/)（函数、`arguments`、content 树）。`util.typ` 在那一篇已经写好。

## set：往样式表里登记默认值

我先把整个 `lab/ch04/set-rules.typ` 摆出来（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch04/set-rules.typ)），后面逐条拆：

```typst
#set page(width: 14cm, height: auto, margin: 1cm)

// A set rule changes defaults from this point to the end of its scope.
#set text(size: 11pt, lang: "zh")
#set par(justify: true, leading: 0.8em)
正文使用 11pt。

#[
  // Inside a content block the rule ends at the closing bracket.
  #set text(fill: blue, size: 14pt)
  这一段是蓝色 14pt。
]

回到 11pt。

// A conditional set rule.
#let draft = true
#set text(fill: red) if draft
草稿状态下整篇变红。

// Rules fold: `stroke` of a table merges with the previous set rule.
#set table(stroke: 0.5pt, inset: 6pt)
#set table(fill: (x, y) => if y == 0 { luma(230) })
#table(
  columns: 2,
  [名称], [值],
  [alpha], [0.05],
)

// Set rules also work on numbering.
#set heading(numbering: "一、")
= 第一节
= 第二节
```

在仓库里用 Typst 0.15.1 编译：

```text
$ nix develop --command make ch04
./scripts/chapter.sh ch04
ok   lab/ch04/fig-show-heading.typ
ok   lab/ch04/not-settable.fail.typ (failed as expected)
ok   lab/ch04/selectors.typ
ok   lab/ch04/set-rules.typ
ok   lab/ch04/show-rules.typ
ok   lab/ch04/first-note/main.typ
```

渲染出来是这样：

![set-rules.typ 的渲染：正文 11pt，方括号内一段蓝色 14pt，之后回到 11pt，从 draft 那行起所有文字包括表格变红，最后两个标题带“一、”“二、”编号](/assets/images/typst-by-xuan/ch04-set-rules.png)

几个值得停一下的地方。

**作用域就是代码块的边界。** 方括号 `#[ ... ]` 里的 `set text(fill: blue)` 在右方括号处结束，下一段回到 11pt。这和 shell 里 `( cd /tmp; export X=1 )` 一个意思：子 shell 里改的环境变量，括号一关就消失。函数体和 `for` 循环体同样是作用域。我在 `/tmp/p4/scope.typ` 里验证了：

```typst
#set page(width: 12cm, height: auto, margin: 8pt)
#let f() = {
  set text(fill: red)
  [函数里变红]
}
#f() 函数外不受影响。
#for i in range(2) {
  set text(fill: blue)
  [循环内 #i ]
}
循环外还是黑色。
#show heading: set text(fill: purple)
#[
  #show heading: set text(fill: orange)
  = 块内标题
]
= 块外标题
```

![函数里的文字为红色，函数外黑色；循环内的两段为蓝色，循环外黑色；方括号内的标题为橙色，方括号外的标题为紫色](/assets/images/typst-by-xuan/ch04-scope.png)

这几个 `/tmp/p4` 下的小实验没有放进仓库，代码就在文中，你可以原样粘贴。

**后写的覆盖先写的。** `set text(size: 14pt)` 之后，同一作用域里再写一次，以后一次为准。再看一个容易忽略的细节：`size` 接受相对单位，`2em` 是相对继承来的字号，不是相对 11pt 之类的固定值：

```typst
#set text(size: 10pt)
#set text(size: 2em)
#context text.size

#[
  #set text(size: 2em)
  #context text.size
]

#context text.size
```

```text
20pt

40pt
20pt
```

第一次 `2em` 乘的是 10pt，方括号里再来一次就是 20pt 的两倍。`xuan` 里一级标题写的 `set text(size: 1.4em)` 就依赖这个行为：它放大的是正文字号，所以正文字号变了，标题也跟着变。（`context text.size` 是第 7 篇的内容，这里只借它读出当前字号。）

**`set ... if` 是条件登记。** `#set text(fill: red) if draft` 在 `draft` 为真时才登记。注意渲染图里 `draft` 那行之后的所有内容都变红了，表格里的字和后面的标题也不例外，因为规则一直有效到文件结束。

**规则会折叠（fold）。** 对字典或描边这类复合值，后一条规则只覆盖它写出的那几个键，其余保留。我在 `/tmp/p4/fold.typ` 里跑了：

```typst
#set page(width: 12cm, height: auto, margin: 8pt)
#set table(stroke: 0.5pt + blue)
#set table(stroke: (bottom: 2pt + red))
#table(
  columns: 2,
  [a], [b],
  [c], [d],
)
```

![一个两行两列的表格，所有格线是细蓝线，只有最下面一条是粗红线](/assets/images/typst-by-xuan/ch04-fold.png)

第二条规则只指定了 `bottom`，其余三边保留蓝色细线。如果它是覆盖语义，表格会只剩一条红线。

**不是所有字段都能 `set`。** `heading` 的 `body` 是内容本身，不属于样式，所以：

```typst
// `body` is not a parameter of `set`: only settable fields are accepted.
#set heading(body: [x])
```

```text
error: unexpected argument: body
  ┌─ lab/ch04/not-settable.fail.typ:2:13
  │
2 │ #set heading(body: [x])
  │              ^^^^^^^^^
```

这条错误信息是 `make ch04` 从 `out/ch04/not-settable.stderr` 里存下来的。判断一个参数能不能 `set`，最快的办法就是试，反正报错只有这一行。

## show：改写某一类元素

`set` 只能改元素的参数。要换掉元素长什么样，或者给一类元素多套一层，就轮到 `show`。`lab/ch04/show-rules.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch04/show-rules.typ)）：

```typst
#set page(width: 14cm, height: auto, margin: 1cm)

// `show <selector>: set ...` restyles matching elements.
#show heading: set text(fill: blue)
#show heading.where(level: 1): set text(size: 1.4em)

// `show <selector>: it => ...` replaces them with new content.
#show strong: it => text(fill: red, it.body)
#show "Typst": it => box(fill: yellow.lighten(60%), it)
#show regex("\d+%"): it => text(fill: green, weight: "bold", it)

= 标题一
== 标题二
这里有 *不再加粗但变红* 的文字，提到 Typst，完成度 80%。

// Wrapping a function as a show rule: the usual template shape.
#let boxed(body) = {
  set text(size: 0.9em)
  block(stroke: 0.5pt, inset: 8pt, body)
}
#show: boxed
整段内容都被 `boxed` 包住。
```

![show-rules.typ 的渲染：两个蓝色标题，一级更大；正文里“不再加粗但变红”为红色非粗体，Typst 带黄色底色，80% 为绿色粗体；最后一行被带边框的盒子包住，字号稍小](/assets/images/typst-by-xuan/ch04-show-rules.png)

`show` 的冒号后面有三种形态，对应这个文件的三段：

1. `show X: set ...`：只改匹配元素的样式。`show heading: set text(fill: blue)` 与全局 `set text` 的区别是只作用在标题上。
2. `show X: it => ...`：函数接收匹配到的元素 `it`，返回的内容替换原位。`strong` 那条取 `it.body`，把粗体外壳丢了，所以渲染里是红色的非粗体字。
3. `show: f`：没有选择器，匹配“后面所有内容”，函数 `f` 收到整段剩余文档。这就是模板的形状，下一节专讲。

选择器 `X` 不一定是元素函数：字符串 `"Typst"` 匹配字面文字，`regex("\d+%")` 匹配正则（渲染里 `80%` 变绿加粗），标签 `<name>` 匹配带那个标签的元素。

**多条 show 规则叠在同一元素上，谁先谁后？** 直觉上后写的会覆盖先写的，实验结果没有这么简单。`/tmp/p4/order.typ`：

```typst
#set page(width: 12cm, height: auto, margin: 8pt)
#set text(size: 10pt)
#set text(size: 14pt)
大小是 #context text.size。

#show "Typst": it => text(fill: red, it)
#show "Typst": it => text(fill: blue, it)
这里的 Typst 是什么颜色？

#show strong: it => [(#it.body)]
#show strong: it => text(fill: green, it)
*粗体*

#show heading: it => [#it]
= 不会死循环
#show heading.where(level: 2): none
== 这一行消失了
#show "旧": "新"
旧词被换成新词。
```

![order.typ 的渲染：Typst 一词是红色，不是后写的蓝色；粗体被括号包住且整体为绿色；一级标题可见，二级标题消失；旧词被替换成新词](/assets/images/typst-by-xuan/ch04-rule-order.png)

读这张图：

- `"Typst"` 是**红色**，先写的红色规则赢了。两条规则的输出里都含有原来的 `it`，读法是：后写的规则先匹配（外层），它输出的 `text(fill: blue, it)` 里又出现了一个 `"Typst"`，这个内层的被先写的规则接着包成红色，红在内层，字面上盖过蓝。
- `strong` 那组把这个读法钉死了：结果是括号包着的绿色文字。绿色（后写）在外层，括号替换（先写）在内层。
- 所以：**后写的 show 规则在外，先写的在内，每条规则都会看到前面规则的输出。** 想用颜色覆盖前面的 show 规则，最稳的办法是用 `show X: set text(...)`，`set` 形式不产生嵌套。
- `show heading: it => [#it]` 没有无限递归（有输出就说明它终止了）。
- `show heading.where(level: 2): none` 让匹配元素消失，`show "旧": "新"` 这类字符串替换也能直接写。

渲染里还可以看一个常用组合：`lab/ch04/fig-show-heading.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch04/fig-show-heading.typ)）把标题换成带蓝色下划线的块，用到了标题的 `it.body`。这是文件里定义“后”那一半的部分（完整文件还有一个 `grid` 把前后并排放在一起）：

```typst
#let styled = {
  show heading: it => block(
    width: 5cm,
    stroke: (bottom: 1pt + blue),
    inset: (bottom: 4pt),
    text(fill: blue, it.body),
  )
  before
}
```

`make ch04` 编出来的图：

![左边是默认样式的“标题”和“正文。”，右边同样的内容，标题变成蓝色并带蓝色下划线](/assets/images/typst-by-xuan/ch04-show-heading.png)

一个陷阱：`it => ... it.body` 只取了标题的正文，**编号没了**。我在 `/tmp/p4/t1.typ` 里验证：

```typst
#set heading(numbering: "1.")
#show heading: it => text(fill: blue, it.body)
= 无号
```

`pdftotext` 的输出只有 `无号`，没有 `1.`。如果标题有编号又想自己画标题，要把编号拼回去，或者改用 `show heading: set ...` 的形式。`xuan` 的 `base` 里所有标题调整都用后者，所以编号完好。

## 选择器：能选什么

`lab/ch04/selectors.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch04/selectors.typ)）：

```typst
#set page(width: 14cm, height: auto, margin: 1cm)
#set heading(numbering: "1.")

// where: filter by field.
#show heading.where(level: 2): set text(fill: blue)
// label: only the element carrying <special>.
#show <special>: set text(fill: red)
// or: either selector.
#show selector(strong).or(emph): set text(fill: purple)

= 一级标题
== 二级标题
#[这是 *粗体* 与 _斜体_。] <special>
#metadata(none) <mark>

= 标记之后的一级标题
== 标题里的 _斜体_

// `before`, `after` and 0.15 `within` cannot drive a show rule, but they work
// in `query`.
#context [
  标记之后有 #query(heading.where(level: 1).after(<mark>)).len() 个一级标题，
  之前有 #query(heading.where(level: 1).before(<mark>)).len() 个。
]
#context [
  标题里的斜体有 #query(selector(emph).within(heading)).len() 处，
  全文共 #query(emph).len() 处。
]
```

![selectors.typ 的渲染：二级标题蓝色；“这是”“与”和句号是红色，“粗体”“斜体”是紫色；后面两行是查询得到的计数](/assets/images/typst-by-xuan/ch04-selectors.png)

这个文件里 `<special>` 贴在一个用 `#[ ... ]` 括起来的整句上，所以整句被选中：“这是”“与”和句号是红色。“粗体”和“斜体”仍然是紫色，因为它们各自还有一条 `strong`/`emph` 的规则，我观察到的结果是里层的颜色盖过外层。标签总是附着在**紧挨它之前的那个元素**上，所以标签与元素之间有没有空格会改变选中的范围。`/tmp/p4/label.typ`（不在仓库里）把这一点单独拿出来：

```typst
#set page(width: 12cm, height: auto, margin: 8pt)
#show <warn>: set text(fill: red)
#show <warn>: it => block(stroke: 0.5pt + red, inset: 4pt, it)
普通段落。

这一段带标签。 <warn>

直接贴着标签的 *词*<warn> 才被选中。

#[#set text(fill: blue); 用函数调用加标签：#text[蓝色]<warn>]
```

![第一行普通文字无框；“这一段带标签。”被红框包住；“词”被红框包住，其余文字无框；最后“蓝色”被红框包住，但“用函数调用加标签：”是蓝色字](/assets/images/typst-by-xuan/ch04-label.png)

第二段里 `。 <warn>` 中间有空格，标签落在了前面那句文字上；第三段 `*词*<warn>` 中间没空格，落在 `strong` 元素上，所以只框住“词”字。（最后一行的蓝色来自方括号里的 `set`，红框来自标签规则，两条规则互不干扰。）

选择器清单，除 `and` 外每一项都在上面的文件里出现过：

- 元素函数：`heading`、`strong`、`emph`。
- 带字段过滤的：`heading.where(level: 2)`。
- 字符串和正则：`"Typst"`、`regex("\d+%")`。
- 标签：`<special>`。
- 组合：`selector(strong).or(emph)`。
- 求交集：`selector(heading).and(<x>)`，实验见下面。
- 位置关系：`.before(<mark>)`、`.after(<mark>)`，以及 0.15 新增的 `.within(heading)`，意为“位于某个 heading 内部”。写法是 `selector(emph).within(heading)`，不是 `emph.within(...)`。

`and` 不在上面的文件里，我另写了 `/tmp/p4/and.typ`（不在仓库里）：

```typst
#set page(width: 12cm, height: auto, margin: 8pt)
#show selector(heading).and(<x>): set text(fill: red)
= 带标签 <x>
= 无标签
#text[正文] <x>
```

编译通过，渲染里只有“带标签”这个标题变红：“无标签”没有 `<x>`，带 `<x>` 的“正文”不是标题，两个条件都满足才算。

**位置关系的三个选择器不能驱动 `show`。** 我直接试了：

```typst
#show heading.where(level: 1).before(<m>): set text(fill: red)
= 标题
#metadata(none) <m>
```

```text
error: this selector cannot be used with show
  ┌─ before-show.typ:1:6
  │
1 │ #show heading.where(level: 1).before(<m>): set text(fill: red)
  │       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

`within` 同样不行，但它的措辞不一样，还附带一句提示：

```typst
#show selector(emph).within(heading): set text(fill: red)
= 带 _斜体_ 的标题
```

```text
error: this selector cannot currently be used with show
  ┌─ within-show.typ:1:6
  │
1 │ #show selector(emph).within(heading): set text(fill: red)
  │       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  │
  = hint: support for this is planned for the future
```

我猜原因是 show 规则在元素被“实现化”（realize）时匹配，那一刻元素还没有文档里的位置，而 `before`/`after` 需要比较位置，不过这只是猜测，官方提示只说了“计划支持”。无论如何，它们在 `query` 里能用，上面的文件已经算出来了：标记前后各 1 个一级标题，标题里的斜体 1 处，全文斜体 2 处。`query` 要放在 `context` 里，这两样第 7 篇专讲，现在知道有这么一条路就行。

## numbering：编号是一个字符串，或一个函数

`set heading(numbering: ...)` 在上面两个文件里各出现了一次：`"一、"` 和 `"1."`。`numbering` 参数的值要么是**编号模式字符串**，要么是一个**函数**。`numbering()` 本身也是一个普通函数，可以直接调用，这是测试模式的最快办法。`/tmp/p4/numbering.typ`：

```typst
#set page(width: 12cm, height: auto, margin: 8pt)
#numbering("1.1.1", 1, 2, 3) \
#numbering("1.a.i", 1, 2, 3) \
#numbering("A.I.", 1, 2, 3) \
#numbering("(1)", 12) \
#numbering("a", 27) \
#numbering("I", 14) \
#numbering("一、", 3) \
#numbering("一", 23) \
#numbering("壹", 23) \
#numbering("①", 7) \
#set heading(numbering: (..n) => {
  let nums = n.pos()
  if nums.len() == 1 { "第 " + str(nums.first()) + " 章" } else {
    nums.map(str).join(".")
  }
})
= 起步
== 细节
#set heading(numbering: "1.1.")
= 换了编号
#set heading(numbering: none)
= 无编号
```

`pdftotext -layout` 的输出：

```text
1.2.3
1.b.iii
A.II.III.
(12)
aa
XIV
三、
二十三
贰拾叁
⑦

第 1 章 起步
1.1 细节

2. 换了编号

无编号
```

要点：

- 模式串里的 `1`、`a`、`A`、`i`、`I`、`一`、`壹`、`①` 等是“计数符号”，其余字符（点、括号、顿号）原样保留。传入的计数比符号多时，最后一个符号连同它前面的分隔符会重复：我另外试了 `numbering("1.a", 1, 2, 3)`，输出是 `1.b.c`。
- `numbering("a", 27)` 是 `aa`，我还试了 28 和 53，分别是 `ab` 和 `ba`，26 是 `z`，进位方式和电子表格的列名一样。
- 中文数字 `一` 和大写数字 `壹` 都是内置的，23 分别是“二十三”和“贰拾叁”。第 5 篇会把它们用到中文标题里。
- 函数形式接收所有层级的计数，返回字符串或 content。上面的例子给一级标题加“第 N 章”，其余层级用点号连接。
- 换模式串或者 `set heading(numbering: none)` 都**不会重置计数器**：输出里“换了编号”是 `2.`，因为前面已经有了“起步”这一章，计数一直在往上走。重置计数器是第 7 篇的内容。

## 模板：`show: f.with(...)`

前面说 `show: f` 把后面所有内容交给 `f`。模板就是这个形状的函数：`body` 是最后一个位置参数，其他参数有默认值，体内先 `set` 再 `show`，最后输出 `body`。先写一个最小的：

```typst
#let mini(title: none, body) = {
  set page(paper: "a6", margin: 1.5cm)
  set text(size: 10pt)
  set heading(numbering: "1.1")
  show heading.where(level: 1): set text(fill: blue)
  align(center, text(1.6em, strong(title)))
  body
}
```

调用：

```typst
#import "@local/mini:0.1.0": mini
#show: mini.with(title: "迷你模板")
= 一节
正文。
```

这里 `mini.with(title: "迷你模板")` 是第 3 篇讲过的 `.with`，返回一个只差 `body` 的新函数。`show: ` 后面没有选择器，所以这个新函数拿到的就是“从这一行往后的整个文档”。下面这样写完全等价：

```typst
#import "@local/mini:0.1.0": mini
#show: it => mini(it, title: "迷你模板")
= 一节
正文。
```

我把两份源文件各编成 PNG，用 `cmp` 比较，输出是 `identical`。写成函数体里先 `set` 后 `show` 还有一个原因：函数体也是作用域，这些规则只对 `body` 生效，不会漏到调用者的后续代码里。

`#show: x` 不一定要放在文件开头，放在中间就只管它后面的那一半文档。

## 把模板装成包：`@local/xuan:0.1.0`

文件开头那句 `#import "@local/mini:0.1.0": mini` 里的 `@local/mini:0.1.0` 是一个**包说明符**，形状是 `@命名空间/包名:版本`。`@preview` 是 Typst Universe 的命名空间（第 14 篇），`@local` 是留给本机包的。Typst 怎么把说明符变成磁盘上的目录？规则是：

```text
<package-path>/<命名空间>/<包名>/<版本>/typst.toml
```

我在 `/tmp/p4/mini/` 里放了这个最小包，目录是这样：

```text
$ find packages -type f | sort
packages/local/mini/0.1.0/lib.typ
packages/local/mini/0.1.0/typst.toml
```

先不告诉 Typst 包在哪，直接编译：

```text
$ typst compile doc.typ doc.pdf
error: package not found (searched for @local/mini:0.1.0)
  ┌─ doc.typ:1:8
  │
1 │ #import "@local/mini:0.1.0": mini
  │         ^^^^^^^^^^^^^^^^^^^

```

（这一步我在 `typst-lab` 的 `nix develop` 里跑，环境变量 `TYPST_PACKAGE_PATH` 已经指向 `typst-lab/packages`，那里只有 `xuan`，所以找不到 `mini`。）

告诉 Typst 去哪找，有两种等价写法，一个是命令行参数，一个是环境变量：

```text
$ typst compile --package-path packages doc.typ doc.pdf
$ TYPST_PACKAGE_PATH=$PWD/packages typst compile doc.typ doc2.pdf
```

两条命令都以退出码 0 结束。命令行参数和环境变量同时存在时，参数覆盖环境变量，我把 `TYPST_PACKAGE_PATH` 设成 `typst-lab/packages` 的同时传 `--package-path packages` 就编译成功了。

`typst-lab` 的 `flake.nix` 里 `shellHook` 把它设成 `$PWD/packages`：

```nix
export TYPST_PACKAGE_PATH="$PWD/packages"
```

所以仓库里每一份文档都可以直接写 `#import "@local/xuan:0.1.0": *`，不需要任何安装步骤。

如果既不传参数也不设环境变量，`@local` 回落到系统默认目录。我把 `XDG_DATA_HOME` 指到 `/tmp/p4/xdg`，在 `$XDG_DATA_HOME/typst/packages/local/mini` 放了一个符号链接指向包目录，取消 `TYPST_PACKAGE_PATH` 后直接 `typst compile doc.typ doc3.pdf`，退出码 0。这条路就是 `typst-lab` 里 `make install` 在做的事：往 `~/.local/share/typst/packages/local/` 链一个 `xuan`，这样你在仓库之外写文档也能 `@local/xuan:0.1.0`（第 16 篇会用到）。

### `typst.toml`

`xuan` 的 `typst.toml`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/packages/local/xuan/0.1.0/typst.toml)）：

```toml
[package]
name = "xuan"
version = "0.1.0"
entrypoint = "lib.typ"
compiler = "0.15.0"
authors = ["bfmhno3"]
license = "MIT OR Apache-2.0"
description = "Notes, homework, slides and CV templates for Chinese and English writing"

[template]
path = "template"
entrypoint = "main.typ"
```

`name` 和 `version` 必须与目录名 `xuan/0.1.0` 对得上，`entrypoint` 是 `import` 这个包时真正被加载的文件，`compiler` 声明最低编译器版本。这里写的是 0.15.0 而不是我编译用的 0.15.1：编辑器的语言服务器 tinymist 0.15.2 内嵌的是 Typst 0.15.0，写 0.15.1 它会拒绝导入这个包（第 16 篇讲 tinymist）。`[template]` 一节让 `typst init @local/xuan:0.1.0 项目目录` 能拷出一份起始文档，对应的 `template/` 目录第 16 篇才建，现在它还不存在，当前章节编译不用它。这个文件之后没有再改。

### `lib.typ`：只做再导出

`lib.typ` 里不写任何逻辑，只用 `#import` 把其他文件里的名字汇到一处，这样使用者只需要 `#import "@local/xuan:0.1.0": *`。下面是第 4 章结束时的状态，也是仓库历史里最早的版本（`tutorial-v1` 标签里是最终状态）：

```typst
#import "src/util.typ": ensure-array, pick, plain-text
#import "src/fonts.typ": fonts
#import "src/cjk.typ": xuan-cjk
#import "src/page.typ": title-block, xuan-page
#import "src/header.typ": xuan-footer, xuan-header
#import "src/theorem.typ": (
  corollary, definition, example, lemma, make-env, proof, theorem,
)
#import "src/base.typ": xuan-base
#import "src/note.typ": note
```

第一行是第 3 篇写好的 `util.typ`。其余几行指向后面几篇的文件，就是前面说的“先拷过来”。这是**中间版本**：之后每一章有新模块，这里就多几行 `#import`，到 `tutorial-v1` 它长到 16 行（`slides`、`cv`、`homework`、`glossary`、`math`、`units` 的导入是后面章节加的）。

包内部文件之间用相对路径互相 import（`"src/util.typ"`、`"cjk.typ"`），相对的是**写这行 import 的文件**自己所在的目录，不是调用者的目录。这一点在第 12 篇讲模块时再展开。

### `src/base.typ`：全文通用的默认值

```typst
#import "cjk.typ": xuan-cjk
#import "theorem.typ": theorem-rules

/// Document-wide defaults: CJK typography, heading numbering and spacing,
/// link colour, theorem environments.
#let xuan-base(body, lang: "zh", title: none) = {
  show: xuan-cjk.with(lang: lang)
  set heading(numbering: "1.1")
  show heading: set block(above: 1.4em, below: 0.9em)
  show heading.where(level: 1): set text(size: 1.4em)
  show heading.where(level: 1): set block(above: 1.8em, below: 1em)
  show link: set text(fill: rgb("#1f4e9c"))
  show: theorem-rules
  body
}
```

15 行，每一行都是这一篇学过的东西：

- `show: xuan-cjk.with(lang: lang)`：**模板可以嵌套**。`xuan-cjk` 本身也是 `(body, lang:)` 形状的函数，它被另一个模板用 `show:` 调用。字体和段落规则在第 5 篇。
- `set heading(numbering: "1.1")`：登记标题编号模式。
- 两条 `show heading ...: set block(...)`：全部标题和一级标题各自的上下间距。三条标题规则都是 show-set 形式，没有产生嵌套，也就没有前面说的先后顺序问题。
- `show heading.where(level: 1): set text(size: 1.4em)`：一级标题放大 1.4 倍，相对继承字号（上面 `em` 实验）。
- `show link: set text(fill: ...)`：链接的颜色。
- `show: theorem-rules`：又是一个无选择器的 show，把定理环境的规则装进来（第 7 篇）。

之后它还会长：到 `tutorial-v1`，文件是 21 行，多了 `math-rules`、`figure-rules`、`code-rules` 三个 import 和对应三行 `show:`（第 8 到第 9 篇）。

### `src/note.typ`：把一切装配起来

```typst
#import "base.typ": xuan-base
#import "header.typ": xuan-footer, xuan-header
#import "page.typ": title-block, xuan-page
#import "util.typ": ensure-array

/// Notes and reports.
#let note(
  title: none,
  subtitle: none,
  author: (),
  date: auto,
  abstract: none,
  keywords: (),
  toc: true,
  paper: "a4",
  lang: "zh",
  body,
) = {
  set document(
    title: title,
    author: ensure-array(author),
    keywords: keywords,
  )
  show: xuan-page.with(paper: paper)
  set page(header: xuan-header(), footer: xuan-footer(lang: lang))
  show: xuan-base.with(lang: lang, title: title)
  title-block(
    title: title,
    subtitle: subtitle,
    author: author,
    date: date,
    lang: lang,
  )
  if abstract != none {
    align(center, block(width: 85%, align(left, {
      set par(first-line-indent: 0pt)
      strong(if lang == "zh" [摘要] else [Abstract])
      h(1em)
      abstract
    })))
  }
  if toc { outline(title: if lang == "zh" [目录] else [Contents]) }
  body
}
```

44 行。三件事值得点出来：

- 前面是一串 `set`/`show: ...with`，**顺序有意义**：先装页面，再装全文默认值，最后才输出标题块、摘要和目录，它们已经处在这些规则的作用域里。
- `ensure-array(author)` 来自 `util.typ`，让调用者既可以传 `"bfmhno3"` 也可以传 `("a", "b")`。
- `outline()` 生成目录，具体用法第 9 篇。`xuan-page`、`title-block`、`xuan-header`、`xuan-footer` 分别在第 6、7 篇。

它也是中间版本：之后 `note` 多一个 `bibliography: none,` 参数和文末 4 行把参考文献放到末尾的代码（第 10 篇）。

### 用起来

`lab/ch04/first-note/main.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch04/first-note/main.typ)）：

```typst
#import "@local/xuan:0.1.0": *

#show: note.with(
  title: "我的第一份笔记",
  author: "bfmhno3",
  abstract: [用 `xuan` 的 `note` 模板写一页带目录的文档。],
  keywords: ("Typst", "笔记"),
)

= 开始

模板把页边距、字体、标题编号和页眉页脚都收进了一次 `show:`。

== 小节

后面的篇章会把这个模板一点点补全。
```

输出 `out/ch04/first-note.pdf`，1 页：

![first-note 的第一页：居中的标题“我的第一份笔记”，下面是作者和日期，摘要框，目录，两级编号标题和正文，页脚是“第 1 页 / 共 1 页”](/assets/images/typst-by-xuan/ch04-first-note.png)

为了确认“本章检查点”这个说法站得住，我从仓库历史最早的一次提交里取出包（只有本章之前写好的那些文件），放到 `/tmp` 下，用 `--package-path` 指过去编译同一份 `main.typ`，同样 1 页（上面那张图就是这次编译的结果）。你不需要重复这一步：`tutorial-v1` 标签里的是最终状态，本文里引用的早期版本以文中所列内容为准。它与最终版本的输出相比，`pdftotext` 只有一处差别：行内代码 `show:` 和后面句号之间的空格。我猜这来自后面章节给行内代码加的样式，没有去追。

## 几个常见的坑

1. **用 `set` 想改的参数不是 settable。** 报错只有一行 `unexpected argument`，看上面的 `not-settable.fail.typ`。
2. **想用 `show` 选“某个标记之后的”元素。** 选择器位置关系不能进 `show`，只能放在 `query` 里数一数、取出来。`query` 本身第 7 篇专讲。
3. **`show X: it => ... it.body`** 会丢掉元素自己的属性，比如标题编号、`strong` 的粗体。要么重新拼，要么改用 `show X: set ...`。
4. **多条 `show` 转换规则的先后。** 后写的在外层。要覆盖就用 `set`。
5. **标签空格。** `*词*<warn>` 与 `*词* <warn>` 不是同一回事。

## 接下来

这一篇把 `xuan` 的骨架立起来了，但 `base.typ` 里 `xuan-cjk` 到底设了什么，我只说了“字体和段落规则”。第 5 篇就是它：`text` 的字体列表、`cjk-latin-spacing`、`par` 的首行缩进，以及 Typst 0.15 新增的可变字体 `variations`。想自己先试的话，从 `lab/ch05/` 开始：[`lab/ch05`](https://github.com/bfmhno3/typst-lab/tree/tutorial-v1/lab/ch05)。
