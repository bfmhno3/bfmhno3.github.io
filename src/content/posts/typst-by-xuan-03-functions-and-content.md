---
title: "函数与 content：一切都是函数调用"
commentId: "post:typst-by-xuan-03-functions-and-content"
published: "2026-10-19 10:00:00 +08:00"
description: "用 Xuan 从零学 Typst 第 3 篇：我用 Typst 0.15.1 写了命名参数、..args、闭包和 .with，亲手触发了“外部变量只读”的编译错误，打印出 [*a* b] 的 content 树，再据此写出 xuan 的第一个模块 util.typ 和它的 assert 测试。"
category: Tutorial
tags:
  - Typst
  - Xuan
  - 函数
  - 闭包
series: "用 Xuan 从零学 Typst"
seriesOrder: 3
draft: false
comment: true
slug: typst-by-xuan-03-functions-and-content
---

在 Typst 里写 `[*a* b]`，编译器看到的不是一串字符，而是这个：

```text
sequence(strong(body: [a]), [ ], [b])
```

`*a*` 是对函数 `strong` 的一次调用，`b` 是一段文本，中间的空格是第三个元素，三者被一个 `sequence` 串起来。这一篇的全部内容都围绕这一行：函数怎么定义、参数怎么传、闭包能看到什么，以及“一切都是函数调用”落到 content 上到底长什么样。最后用这些知识写出 `xuan` 的第一个模块 `src/util.typ`。

> [!NOTE] 本篇检查点
> 这一篇结束时你会有：`packages/local/xuan/0.1.0/src/util.typ`（final，33 行，一个字都不会再改），`lab/ch03/` 下四个实验文件，以及 `tests/util.typ` 里对 util 的断言。`make ch03` 通过（三个正常文件加一个预期失败的 `capture-mutation.fail.typ`），`make test` 通过。
> `lab/ch03/content-tree.typ` 从 `@local/xuan:0.1.0` 导入 `plain-text`，而包的清单 `typst.toml` 和入口 `lib.typ` 要到[下一篇](/posts/typst-by-xuan-04-set-and-show/)才从零搭起；现在先把仓库里的 `packages/` 整个拿来用即可。`lib.typ` 的第一行就是 `#import "src/util.typ": ensure-array, pick, plain-text`，其余行以后再长。
> 前置：[第 2 篇：代码模式](/posts/typst-by-xuan-02-code-mode/)。所有命令都在 `typst-lab` 的 `nix develop` 里用 Typst 0.15.1 跑出，仓库固定在 [`tutorial-v1`](https://github.com/bfmhno3/typst-lab/tree/tutorial-v1) 标签。

## 函数是值

先看 [`lab/ch03/functions.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch03/functions.typ)：

```typst
#set page(width: 14cm, height: auto, margin: 1cm)

// Named and default parameters; the last expression is the return value.
#let badge(text-fill: blue, size: 1em, body) = box(
  fill: text-fill.lighten(80%),
  inset: (x: 0.4em, y: 0.2em),
  radius: 3pt,
  text(fill: text-fill, size: size, body),
)

#badge[默认] #badge(text-fill: red)[红色] #badge(size: 1.4em)[大号]

// Functions are values: store them, pass them, return them.
#let twice(f) = x => f(f(x))
#assert.eq(twice(x => x + 3)(10), 16)

// `.with` fixes some arguments and returns a new function.
#let warn = badge.with(text-fill: orange)
#warn[警告]
#assert.eq(type(warn), function)

// Recursion works because `let` binds the name before the body runs.
#let fib(n) = if n < 2 { n } else { fib(n - 1) + fib(n - 2) }
#assert.eq(range(10).map(fib), (0, 1, 1, 2, 3, 5, 8, 13, 21, 34))

// Anonymous functions are closures over the scope where they were written.
#let make-adder(n) = x => x + n
#assert.eq(make-adder(5)(1), 6)
```

**函数定义就是 `let` 加一个参数列表。** `#let badge(text-fill: blue, size: 1em, body) = ...` 里，带冒号的是命名参数，冒号右边是默认值；最后那个没有默认值的 `body` 是位置参数，调用时既可以写 `badge("x")`，也可以把最后一个内容参数挪到方括号里写成 `badge[x]`。后一种写法不是特例，`[...]` 就是一个 content 值，作为最后一个位置参数跟在调用后面而已。`#badge(size: 1.4em)[大号]` 里圆括号管命名参数，方括号管 `body`。

**没有 `return`。** 函数体是一个表达式，值就是返回值。`badge` 的体就是一次 `box(...)` 调用；`fib` 的体是 `if` 表达式，两个分支各给出一个值。需要多条语句时写 `{ ... }`，花括号里最后一个表达式（或者前面所有表达式 join 起来的结果）是返回值，规则在第 2 篇讲过，这里不再重复。

**函数是值。** `twice(f)` 接受一个函数，返回另一个函数；`.with` 把部分参数固定住，得到新的函数（`warn` 就是默认颜色改成橙色的 `badge`）。`type(warn)` 是 `function`，这和 `type(1)` 是 `int` 没有区别，所以函数可以放进数组、字典，传给 `map`，被别的函数返回。

递归不需要额外声明：`let` 先绑定名字再求值函数体，所以 `fib` 在体内能看到自己。（我没有给 `fib(30)` 计时，看它的写法就知道指数级；真要算斐波那契，用 `range` 加 `fold` 循环。）

编译一下：

```text
$ make ch03
ok   lab/ch03/arguments.typ
ok   lab/ch03/capture-mutation.fail.typ (failed as expected)
ok   lab/ch03/content-tree.typ
ok   lab/ch03/functions.typ
```

四个 `assert` 都过了，页面上是三个彩色标签和一个橙色的“警告”。

## 参数：收集与展开

[`lab/ch03/arguments.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch03/arguments.typ)：

```typst
#set page(width: 14cm, height: auto, margin: 1cm)

// `..args` collects the extra positional and named arguments.
#let describe(..args) = {
  let pos = args.pos()
  let named = args.named()
  [位置参数 #pos.len() 个：#repr(pos)；命名参数 #named.len() 个：#repr(named)。]
}

#describe(1, "二", a: 3, b: 4) \
#describe()

// Spreading goes the other way: `..xs` expands an array or a dictionary.
#let rect-of(w, h, fill: none) = rect(width: w, height: h, fill: fill)
#let size = (2cm, 1cm)
#let style = (fill: aqua)
#rect-of(..size, ..style)

// 0.15: named values of `arguments` are available as fields.
#let args = arguments(1, 2, color: "red")
#assert.eq(args.color, "red")
#assert.eq(args.pos(), (1, 2))
#assert.eq(args.named(), (color: "red"))

// Forwarding: wrap a function and pass everything through.
#let loud(..args) = text(weight: "bold", ..args)
#loud(fill: red)[转发命名参数]
#assert.eq(calc.max(..(3, 9, 4)), 9)
```

我用 `pdftotext` 读出前两行的输出：

```text
位置参数 2 个：(1, "二")；命名参数 2 个：(a: 3, b: 4)。
位置参数 0 个：()；命名参数 0 个：(:)。
```

`(:)` 是空字典的写法，`()` 是空数组，这两个字面量在第 2 篇出现过。

**`..args` 把剩下的参数全部收进一个 `arguments` 值。** 它不是数组也不是字典，而是两者的合体：`.pos()` 取出位置参数（数组），`.named()` 取出命名参数（字典）。0.15 起可以直接用字段访问读命名值，`args.color` 等于 `args.named().color`，上面三条断言里第一条用的就是这个新写法。

**`..xs` 出现在调用处是反向操作：展开。** `rect-of(..size, ..style)` 把数组 `(2cm, 1cm)` 展开成两个位置参数，把字典 `(fill: aqua)` 展开成命名参数，等价于 `rect-of(2cm, 1cm, fill: aqua)`。`calc.max(..(3, 9, 4))` 同理，`calc.max` 本身也是接受任意个位置参数的函数。

两件事合起来就是转发：`loud(..args)` 不关心调用者传了什么，原样交给 `text`，再额外塞一个 `weight: "bold"`。写模板的时候，这是给内置函数包一层默认样式最省事的形式，`xuan` 后面的 `note`、`slide` 都会用到。

## 闭包：捕获的是当时的值

`make-adder(5)(1)` 得到 6，说明内层的 `x => x + n` 记住了 `n`。问题是记住的是什么：值，还是变量本身？我写了一个小实验（放在 `/tmp` 里，没有进仓库）：

```typst
#let n = 1
#let show-n = () => n
#let n = 2
#let fs = range(3).map(i => () => i * 10)
#let total = (1, 2, 3).fold(0, (acc, x) => acc + x)
#let counter-values(xs) = {
  let count = 0
  for x in xs { count += x }
  count
}
```

在文档里用 `#repr(...)` 把这几个值逐个打印出来，结果依次是（表达式和结果的对应是我按顺序整理的）：

```text
show-n()               1
n                      2
fs.map(f => f())       (0, 10, 20)
total                  6
counter-values((4, 5)) 9
```

`show-n` 是在 `n` 等于 1 的时候定义的，之后我又 `let n = 2` 遮蔽了它，`show-n()` 仍然返回 1。也就是说：**闭包在创建的那一刻拿走了外部变量的值**，之后外面怎么变，它都看不见。`range(3).map(i => () => i * 10)` 里每一轮的 `i` 各是各的，三个小函数分别捕获 0、1、2，没有“全都拿到最后一个值”这种坑。

这个模型像拍照：闭包带走的是创建时刻的一张照片，不是一个通往冰箱的钥匙。照片上的东西可以看，不能在照片上做改动让真冰箱里的东西变化。

后果在 [`lab/ch03/capture-mutation.fail.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch03/capture-mutation.fail.typ) 里：

```typst
// Variables from outside a function are read-only inside it.
#let count = 0
#let bump() = {
  count += 1
}
#bump()
```

```text
error: variables from outside the function are read-only and cannot be modified
  ┌─ lab/ch03/capture-mutation.fail.typ:4:2
  │
4 │   count += 1
  │   ^^^^^

  while calling `bump` at lab/ch03/capture-mutation.fail.typ:6:1
    bump()
```

这是 `make ch03` 抓到的 `out/ch03/capture-mutation.stderr` 原文。`chapter.sh` 要求 `*.fail.typ` 必须编译失败，所以这个文件失败才算“ok”。

错误信息说得很准：外部变量**只读**。函数里面自己 `let` 出来的变量是可以改的，上面实验里的 `counter-values` 就在循环里 `count += x`，结果 9，没有任何问题。只有**从外面捕获来的**变量不能被改。如果想让函数“累加”，办法是让状态流经参数和返回值：`fold`，或者把新值作为返回值交回去。需要真正跨函数、跨页面的可变状态时，Typst 有 `state`，第 7 篇会讲，它的代价（二次求值、收敛）是这篇的纯函数模型换来的。

（说“纯函数”并不严格：`panic` 和 `assert` 是副作用，但它们只会终止编译，而不改变任何值。这也是我愿意放心在 `tests/` 里大量使用 `assert` 的原因。）

## content 树

回到开头那行 `sequence(...)`。[`lab/ch03/content-tree.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch03/content-tree.typ)：

```typst
#set page(width: 14cm, height: auto, margin: 1cm)
#import "@local/xuan:0.1.0": plain-text

// Markup is sugar for element function calls.
#let c = [*粗体* 与 _斜体_]

#assert.eq(type(c), content)
#assert.eq(repr(c.func()), "sequence")
#assert(c.has("children"))
#assert.eq(repr(strong[a].func()), "strong")
#assert.eq(strong[a].body, [a])
#assert.eq(heading(level: 2)[x].level, 2)

// `fields()` lists every field, `at` reads one, `has` tests for it.
#let h = heading(level: 2, [标题])
#assert.eq(h.fields().level, 2)
#assert.eq(h.at("level"), 2)
#assert(h.has("body"))
#assert(not h.has("nothing"))

// What the compiler actually sees:
#raw(repr([*a* b]), block: true, lang: "text")
#raw(repr(c.children.map(x => x.func())), block: true, lang: "text")

// Flatten a tree back to a string.
#assert.eq(plain-text([*粗体* 与 _斜体_]), "粗体 与 斜体")
#assert.eq(plain-text[= 标题 *加粗*], "标题 加粗")
```

编译出的页面上这两个 `raw` 块的内容是（`pdftotext` 读出）：

```text
sequence(strong(body: [a]), [ ], [b])
(strong, space, text, space, emph)
```

第二行来自 `c.children.map(x => x.func())`：`[*粗体* 与 _斜体_]` 有五个子节点，依次是 `strong`、一个空格（`space`）、文本“与”（`text`）、又一个空格、`emph`。

**Markup 是语法糖，每个构造对应一个元素函数。** `*粗体*` 就是 `strong[粗体]`，`= 标题` 是 `heading(level: 1)[标题]`，空行分段是 `parbreak()`，连一个空格都是 `space` 元素。`content` 是这一切的类型：一棵由元素构成的树，字符串变成文本元素 `text`，多个元素并排就套一层 `sequence`。

这棵树可以被读出来，有四个入口：

- `c.func()` 返回元素函数本身，`[*a*].func() == strong` 为真（我编译验证过）。上面我用 `repr(c.func())` 取名字，是因为 `sequence` 和 `space` 这类内部元素没有公开的名字可以引用。
- `c.has("body")` 问有没有这个字段，`c.at("level")` 或 `c.level` 读字段，`c.fields()` 一次拿到全部字段的字典。
- 字段是什么由元素决定。`strong` 有 `body`，`heading` 有 `level` 和 `body`，`text` 有 `text`（一个 `str`），`sequence` 有 `children`（一个数组），这些都是上面断言的真实结果。
- 反过来，所有元素函数都能用关键字参数构造，`heading(level: 2, [标题])` 与 `== 标题` 是同一棵树。

后面的章节会不断回到这里：show 规则（第 4 篇）匹配的就是这些元素，`query`（第 7 篇）返回的就是这些元素，`figure` 的 `kind`、`ref` 的 `supplement` 也都是元素字段。

## 第一个模块：`util.typ`

树能读，就能写一个遍历它的函数。`xuan` 里的第一个模块 [`src/util.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/packages/local/xuan/0.1.0/src/util.typ) 就是这样来的，它是 final 版，全文如下：

```typst
// Small helpers shared by every other module.

/// Flatten content to a plain string.
#let plain-text(it) = {
  if type(it) == str {
    it
  } else if type(it) == content {
    if it.has("text") {
      it.text
    } else if repr(it.func()) == "space" {
      " "
    } else if it.has("children") {
      let parts = it.children.map(plain-text)
      if parts.len() == 0 { "" } else { parts.join() }
    } else if it.has("child") {
      plain-text(it.child)
    } else if it.has("body") {
      plain-text(it.body)
    } else {
      ""
    }
  } else {
    ""
  }
}

/// Wrap a single value in an array; arrays pass through.
#let ensure-array(x) = if type(x) == array { x } else { (x,) }

/// `default` when `value` is `auto` or `none`.
#let pick(value, default) = {
  if value == auto or value == none { default } else { value }
}
```

`plain-text` 是个递归函数，分支顺序就是 content 的节点种类：

1. 已经是 `str`，原样返回。
2. 有 `text` 字段（文本元素），返回它。
3. 是 `space`，返回一个空格。
4. 有 `children`（`sequence`），每个孩子递归，再 `join`。空序列的 `join` 会得到 `none`，所以单独判断长度并返回 `""`，保证结果永远是字符串。
5. 有 `child`，递归它。
6. 有 `body`（`strong`、`emph`、`heading`、`box` 等），递归它。
7. 其他（图片、`h(1em)` 等）返回 `""`，不是 content（比如 `none`）也返回 `""`。公式要分情况：`$x + y = 1$` 这种扁平的公式在树上就是文本，结果是 `"x + y = 1"`，`$arrow.r$` 得到 `"→"`；带结构的部分（求和、上下标、分式）会被丢掉，`$sum_(i=1)^n i = a/b$` 只剩 `" i = "`。这是我编译出来的结果，所以 `plain-text` 不适合拿来提取公式文字。

另外两个小函数：`ensure-array` 让调用方可以写 `author: "张三"` 也可以写 `author: ("张三", "李四")`，`pick` 把 `auto` 和 `none` 都当作“没给”，给标题之类的参数提供默认值。以后 `note.typ` 会 `#import "util.typ": ensure-array`，`glossary.typ` 会用 `pick`。

### 为什么要处理 `child`

第 5 个分支最不起眼，却不能省。看下面这个例子（放在 `/tmp`，`naive` 是和 `util.typ` 同一套逻辑，只是少了 `child` 分支）：

```typst
#let c = [前 #text(fill: red)[红字 _斜_] 后]
#assert.eq(plain-text(c), "前 红字 斜 后")
#assert.eq(naive(c), "前  后")
```

两条断言都通过，屏幕上的结果：

```text
tree : sequence(
[前],
[ ],
styled(child: sequence([红字], [ ], emph(body: [斜])), ..),
[ ],
[后],
)
xuan : "前 红字 斜 后"
naive: "前  后"
```

`text(fill: red)[...]` 不是一个有 `body` 的元素，在 0.15.1 里它在树上是 `styled(child: ..., ..)`：一个 `styled` 节点，字段只有 `child` 和 `styles`（我对 `text(fill: red)[x]` 打印过 `fields().keys()`，结果就是 `("child", "styles")`），`styles` 里存着那条红色的规则，`child` 才是被包裹的内容。`#[#set text(...) ...]` 这种带 `set` 的内容块在树上同样是 `styled`。没有 `child` 分支的版本走到这里就掉进“其他”分支，红字整个丢了，得到 `"前  后"`（两个空格，因为前后各有一个 `space`）。

所以只要被 `text(...)` 包过、或者带 `set` 的片段混进来，不处理 `child` 就会静默丢字，不报错。

### 测试

[`tests/util.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/tests/util.typ) 就是那些断言的家：

```typst
#import "@local/xuan:0.1.0": *

#assert.eq(plain-text([*粗* 与 _斜_]), "粗 与 斜")
#assert.eq(plain-text([a #h(1em) b]), "a  b")
#assert.eq(plain-text("already a string"), "already a string")
#assert.eq(plain-text(none), "")

#assert.eq(ensure-array(1), (1,))
#assert.eq(ensure-array((1, 2)), (1, 2))

#assert.eq(pick(auto, 3), 3)
#assert.eq(pick(none, 3), 3)
#assert.eq(pick(0, 3), 0)
#assert.eq(pick(false, 3), false)

// `text(..., body)` and `box` wrap their content in other elements.
#assert.eq(plain-text(text(fill: red)[红 *色*]), "红 色")
#assert.eq(plain-text(box[a#super[2]]), "a2")
```

几处刻意选的样例：`a #h(1em) b` 的结果是两个空格，因为 `h(1em)` 落进“其他”分支被当成空串，两侧的空格保留；`pick(0, 3)` 和 `pick(false, 3)` 保证 `0` 与 `false` 不被当作“没给”（只有 `auto` 和 `none` 才是）；最后两行是上一节 `child` 的回归测试。

跑一下：

```text
$ make test
typst compile tests/glossary.typ
typst compile tests/homework.typ
typst compile tests/slides.typ
typst compile tests/theorem.typ
typst compile tests/units.typ
typst compile tests/util.typ
```

没有任何输出就是通过：`assert` 失败会让 `typst compile` 返回非零，`make` 随即停下。整套测试在我的机器上用时 0.4 秒。后面几个测试文件（`units`、`homework`、`glossary`……）会在它们各自的模块出现的那一篇再讲，它们现在都已经在仓库里，所以输出里也一并列出了。

为了确认断言真的会失败，我把期望值改错编译了一次（`/tmp` 里的临时文件，没有改仓库）：

```text
error: equality assertion failed: value "a" was not equal to "b"
  ┌─ bad.typ:2:1
  │
2 │ #assert.eq(plain-text([a]), "b")
  │  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

## 合起来用一次

函数、参数转发、content 树、`util.typ`，放在一起能做什么？我写了一个一次性的小文件（在 `/tmp`，不属于仓库）：

```typst
#import "@local/xuan:0.1.0": pick, plain-text

#let lead(who: auto, body) = {
  let name = pick(who, "匿名")
  strong[#name：] + body
}

#let chars(body) = plain-text(body).clusters().filter(c => c != " ").len()

#let note-box(..args, body) = block(
  stroke: 0.5pt,
  inset: 6pt,
  ..args,
  body,
)

#let c = [#lead(who: "我")[函数也是 _值_。] #lead[没署名。]]
#c

#note-box(fill: luma(240))[字符数：#chars(c)]
#assert.eq(chars(c), 15)
```

页面上的两行文字是：

```text
我：函数也是 值。 匿名：没署名。
字符数：15
```

这里每一项都对应前面讲过的一条：

- `lead` 的 `who: auto` 配合 `pick` 实现“没给就用默认值”；`strong[...] + body` 是把两个 content 相加，结果仍是一个 content。我把 `lead(who: "我")[函数也是 _值_。]` 的 `repr` 打出来看过，加号把它们压平成一个 `sequence`：`strong(body: sequence([我], [：]))`、`[函数也是]`、`[ ]`、`emph(body: [值])`、`[。]` 依次排开，没有多嵌套一层。
- `chars` 先用 `plain-text` 把树压成字符串，再用 `.clusters()` 按字素簇切开、滤掉空格、数个数。第 2 篇说过 `"中文".len()` 是 6 个字节，所以这里必须用 `clusters`，数出来的 15 才是人眼看到的字数：“我：函数也是值。”8 个，“匿名：没署名。”7 个。
- `note-box(..args, body)` 把 `body` 之外的所有参数转发给 `block`，调用时只写 `fill: luma(240)`，`stroke` 和 `inset` 用它内置的默认值。

函数的参数里既有普通值也有 content，二者在语法上没有任何区别，区别只在 `type()` 返回什么。这是 Typst 里“模板”其实就是函数的原因：`note`、`slide`、`homework` 都是这样一个吃 `..args` 和一个 `body` 的函数。

## 接下来

现在函数和 content 都能写能读了，但这棵树目前只是被看着：我们还没有改变任何一个节点的样子。下一篇用 `set` 和 `show` 去改样式，同时第一次把 `xuan` 搭成一个真正的包，`typst.toml`、`lib.typ`、`base.typ` 和 `note.typ`（intermediate）都会在那里出现，到时 `lab/ch03/content-tree.typ` 里那行 `@local/xuan:0.1.0` 的导入才算完整落地。

如果想自己多玩一会儿：试着给 `plain-text` 加一个 `sequence` 之外的分支，比如把 `h(1em)` 也翻译成空格，再看看 `tests/util.typ` 里哪条断言会因此变红。（我猜是 `"a  b"` 那条，但这一条我没有试，留给你。）
