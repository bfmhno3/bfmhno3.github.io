---
title: "代码模式：值、类型与控制流"
commentId: "post:typst-by-xuan-02-code-mode"
published: "2026-10-19 09:00:00 +08:00"
description: "用 Xuan 从零学 Typst 第 2 篇：我用 Typst 0.15.1 的 typst eval 和 6 个实验文件把代码模式逐项撞了一遍，量出两个汉字的 len() 是 6 而 clusters 只有 2，撞出字符边界和类型错误，并亲手触发 assert、assert.eq 与 panic 看真实报错。"
category: Tutorial
tags:
  - Typst
  - Xuan
  - 脚本
  - 类型
series: "用 Xuan 从零学 Typst"
seriesOrder: 2
draft: false
comment: true
slug: typst-by-xuan-02-code-mode
---

先问 Typst 一个问题：

```text
$ typst eval '"中文".len()'
6
$ typst eval '"中文".clusters()'
["中","文"]
```

两个汉字，长度是 6。这个 6 会咬人：只要你在 Typst 里切过中文字符串，就会撞上它。这一篇我们把 Typst 的“代码”半边从头走一遍：值和类型、字符串、绑定、控制流、数组和字典、断言。标记语法在[上一篇](/posts/typst-by-xuan-01-first-document/)已经过了一遍，这里的所有东西你都可以在 `#` 后面写出来。

> [!NOTE] 本篇检查点
> 这一篇结束时你会有：`lab/ch02/` 下的 6 个实验文件（4 个正常编译，2 个预期失败的 `*.fail.typ`），`make ch02` 通过。还没有任何 `xuan` 包文件，包从第 3 篇开始长。
> 涉及的 Typst 特性：三种模式与 `#` 嵌入规则、`none`/`auto`/`bool`/`int`/`float`/`decimal`/`str`、长度与比例类、`version`/`label`/`regex`/`symbol`、`let`、遮蔽、解构、`if`/`for`/`while`/`break`/`continue`、数组与字典方法、`assert`/`assert.eq`/`panic`/`repr`/`type`。
> 前置：[第 1 篇](/posts/typst-by-xuan-01-first-document/)（能进 `nix develop`，会 `typst compile`）。

## 环境与实验场

和上一篇一样，在 [typst-lab](https://github.com/bfmhno3/typst-lab/tree/tutorial-v1) 里进 `nix develop`，版本是 `typst 0.15.1 (9dfd3a08)`。本章的文件在 [`lab/ch02/`](https://github.com/bfmhno3/typst-lab/tree/tutorial-v1/lab/ch02)：

```text
lab/ch02/
├── types.typ
├── strings.typ
├── collections.typ
├── control.typ
├── str-index.fail.typ
└── type-error.fail.typ
```

整章跑一遍：

```text
$ make ch02
./scripts/chapter.sh ch02
ok   lab/ch02/collections.typ
ok   lab/ch02/control.typ
ok   lab/ch02/str-index.fail.typ (failed as expected)
ok   lab/ch02/strings.typ
ok   lab/ch02/type-error.fail.typ (failed as expected)
ok   lab/ch02/types.typ
```

文件里大量使用 `assert`：只要有一条断言不成立，整个文件编译失败，`make ch02` 就红。所以“编译通过”本身就是证据，我在正文里只额外贴你看不到的东西：PDF 里的输出和报错。

另外一个小工具：`typst eval '表达式'` 直接对一段代码求值，不用建文件。输出默认是 JSON，所以长度、小数这类非 JSON 类型会被序列化成字符串（后面能看到 `"70.87pt"`）。它在第 16 篇还会出场，这里当计算器用。

## 三种模式，一个 `#`

Typst 的源文件有三种“模式”：

- **标记模式**：文件的默认状态，写文章用的。
- **代码模式**：写表达式的地方，在标记里用 `#` 进入，或者在 `{ }` 里。
- **数学模式**：`$ ... $` 里面，第 8 篇单讲。

进入代码模式的规则只有一条：`#` 后面跟一个表达式，Typst 取“最长的合法表达式”，到不能再延伸为止。光读规则不好记，我写了一个临时文件 `/tmp/ch02/modes.typ`（不进仓库）：

```typst
#let n = 3
#let name = "Typst"
Markup: n 是 #n，name 是 #name.
Field: #name.len() 个字节，#(n + 1) 与 #n+1 与 #n;+1。
Math: $n^2 = #(n * n)$ 与 $#name$ 与 $"text"$。
Content in code: #{
  let b = [*粗* 与 _斜_]
  b + [，拼接]
}
Content arg: #strong[参数] #text(fill: red)[红色] #emph(name)
Strings in content: #"*不是粗体*" 与 *粗体*。
Escape: \#n 与 \$。
#let joined = {
  "a"
  "b"
}
#joined
```

```text
$ typst compile --root . modes.typ modes.pdf && pdftotext modes.pdf -
Markup: n 是 3，name 是 Typst. Field: 5 个字节，4 与 3+1 与 3+1。 Math: 𝑛2 = 9 与 Typst 与
text。 Content in code: 粗 与 斜，拼接 Content arg: 参数 红色 Typst Strings in content: *不是粗体
* 与 粗体。 Escape: #n 与 $。 ab
```

（`pdftotext` 把换行压平了，但每一项都能对上。）逐条看：

- `n 是 #n`：没有 `#` 的 `n` 只是字母，`#n` 才是变量 `n` 的值 3。
- `#name.` 行末的句号没有被吃掉：`.` 后面必须紧跟标识符才算字段访问。`#name.len()` 则是方法调用，得到 5（`"Typst"` 五个字节）。
- `#(n + 1)` 是 4。`#n+1` 输出 `3+1`：`#n` 是表达式，`+1` 回到标记里当文字。想让 `+` 属于表达式必须加括号；`#n;+1` 里的 `;` 只是显式结束表达式，自己不输出。
- `$#name$` 在数学模式里再次用 `#` 回到代码模式，所以 `Typst` 是直立体字符串，而 `n^2` 的 `n` 是数学斜体 𝑛。
- `{ ... }` 是**代码块**：里面每一行都是语句，没有 `#`；`[ ... ]` 是**内容块**，里面回到标记。两者可以任意嵌套。
- 代码里的字符串 `"*不是粗体*"` 是字符串，星号原样输出，不会被当成加粗。
- `\#n` 转义，输出 `#n`。

标记里的 `#` 加 `(`、`[`、`{` 的组合有个固定读法：函数调用后面可以跟一个或多个 `[...]` 当最后的内容参数，比如 `#strong[参数]` 等价于 `#strong([参数])`。第 3 篇讲函数时会回到这里。

## 值与类型

Typst 里每个值都有类型，`type(x)` 返回它，`repr(x)` 返回它的“源码样子”。我把一串典型值塞进数组，两列表格打出来（[`types.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch02/types.typ)，省略开头的 `#set page(...)` 一行，下同）：

```typst
// Every built-in value has a type; `type` returns it, `repr` shows the source.
#let samples = (
  none,
  auto,
  true,
  42,
  3.14,
  decimal("0.1"),
  "字",
  2.5cm,
  50%,
  1em + 3pt,
  1fr,
  90deg,
  version(0, 15, 1),
  <label>,
  regex("a+"),
  sym.arrow.r,
)

#table(
  columns: 2,
  [*repr*], [*type*],
  ..samples.map(v => (raw(repr(v)), raw(repr(type(v))))).flatten(),
)
```

（`..` 展开和 `.map`、`.flatten` 稍后细讲，这里先看结果。）`pdftotext -layout out/ch02/types.pdf -` 的前 16 行：

```text
repr                               type
none                               type(none)
auto                               type(auto)
true                               bool
42                                 int
3.14                               float
decimal("0.1")                     decimal
"字"                                str
70.87pt                            length
50%                                ratio
3pt + 1em                          length
1fr                                fraction
90deg                              angle
version(0, 15, 1)                  version
<label>                            label
regex("a+")                        regex
```

有几处值得停一下。

**`none` 和 `auto` 是两个不同的值。** `none` 表示“没有”，`auto` 表示“你帮我定”。比如页面的 `margin: auto` 是“按纸张大小算”，`fill: none` 是“不填充”。它们各自有一个类型，打印出来是 `type(none)` 和 `type(auto)`，有点绕，但我实测确实如此。`none` 还有一个小脾气：它对 `+` 是单位元，`none + 1` 得 `1`。

**`2.5cm` 的 `repr` 是 `70.87pt`。** 长度在内部以 pt 存储，`cm` 只是字面量后缀。需要换算时用方法：`2.5cm.mm()` 得 `25.0`，`(1em + 3pt).em` 得 `1.0`。`1em + 3pt` 保留成两项的和（`3pt + 1em`），因为 `em` 要等字号确定才知道多长。

**长度、比例、相对、分数。** `50%` 是 `ratio`，`50% + 10pt` 是 `relative`（百分比加绝对长度，布局时才解析），`1fr` 是 `fraction`（分剩余空间的份数，第 6 篇用）。它们按量纲相加：

```text
$ typst eval '(2cm + 5mm, 50% + 10pt, 2fr + 1fr)'
["70.87pt","50% + 10pt","3fr"]
```

**整数是 64 位，0.15 新增了 `int.min` 和 `int.max`。** 实验文件里：

```typst
// Floats are binary, decimals are not.
#assert(0.1 + 0.2 != 0.3)
#assert.eq(decimal("0.1") + decimal("0.2"), decimal("0.3"))

// Integers are 64 bit; 0.15 added `int.min` and `int.max`.
#assert.eq(int.max, 9223372036854775807)
#assert.eq(int.min, -9223372036854775808)
```

整数溢出不会回绕，也不会悄悄变成浮点，直接报错（临时文件 `overflow.typ`，内容 `#(int.max + 1)`）：

```text
error: value is too large
  ┌─ overflow.typ:1:2
  │
1 │ #(int.max + 1)
  │   ^^^^^^^^^^^
```

浮点就是 IEEE 754：`0.1 + 0.2` 是 `0.30000000000000004`，所以断言写 `!=`。要精确十进制（金额、报表），用 `decimal("0.1")`，字符串进、字符串出。`/` 永远返回浮点，`7 / 2` 是 `3.5`，`4 / 2` 是 `2.0`，类型是 `float`；整除用 `calc.quo(7, 2)` 得 `3`，取余 `calc.rem(7, 2)` 得 `1`。

**单位和版本。** `90deg` 的 `angle` 用 `.rad()` 转弧度；`version(0, 15, 1) > version(0, 14)` 逐段比较，`sys.version` 是当前编译器版本。这一组在 `types.typ` 末尾：

```typst
// Units convert through methods.
#assert.eq(2.5cm.mm(), 25.0)
#assert.eq((1em + 3pt).em, 1.0)
#assert(calc.abs(90deg.rad() - calc.pi / 2) < 1e-12)

// Versions compare component-wise.
#assert(version(0, 15, 1) > version(0, 14))
#assert(sys.version >= version(0, 15, 1))
```

**`label`、`regex`、`symbol`。** `<label>` 是标签，第 1 篇用来给东西起名、用 `@` 引用；`regex("a+")` 是正则；`sym.arrow.r` 是符号。符号是个“带修饰符变体的字符”：`sym.arrow.r` 默认是 `→`，`sym.arrow.r.double` 是 `⇒`，`.long` 是 `⟶`。`repr` 会把整个符号连同全部变体打出来，这一格的 `repr` 有 54 行、1224 字节，所以表格最后一行特别长，我就让它留在输出里。要注意符号不是字符串：`sym.arrow.r == "→"` 是 `false`，`type` 是 `symbol`。

还有一个坑：`type` 的结果本身也是值，可以拿来比较。断言里写 `type(42) == int`，不是 `== "integer"`：

```typst
#assert.eq(type(none), type(none))
#assert.eq(type(42), int)
#assert.eq(type(3.14), float)
#assert.eq(type(1em + 3pt), length)
#assert.eq(type(50% + 2pt), relative)
```

## 字符串：字节、码点和簇

回到开头那个 6。Typst 的 `str` 是 UTF-8，`len()` 数字节。一个汉字在 UTF-8 里占 3 字节，所以两个汉字是 6。这就像量一本书：`len()` 量书脊的厚度（毫米），`clusters()` 数它有几本，两个数都对，但你要哪个得想清楚。[`strings.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch02/strings.typ) 把三种“长度”并排放：

```typst
// A str is UTF-8: len() counts bytes, not characters.
#let s = "中文"
#assert.eq(s.len(), 6)
#assert.eq(s.clusters().len(), 2)
#assert.eq(s.codepoints().len(), 2)

// A decomposed é is one grapheme cluster but two codepoints and three bytes.
#let e = "e\u{0301}"
#assert.eq(e.len(), 3)
#assert.eq(e.codepoints().len(), 2)
#assert.eq(e.clusters().len(), 1)
```

文件末尾把它们做成一张表：

```typst
#table(
  columns: 4,
  [*str*], [*bytes*], [*codepoints*], [*clusters*],
  ..(s, e, "abc")
    .map(x => (
      raw(repr(x)),
      str(x.len()),
      str(x.codepoints().len()),
      str(x.clusters().len()),
    ))
    .flatten(),
)
```

```text
str          bytes codepoints clusters
"中文"         6     2           2
"e\u{301}"   3     2           1
"abc"        3     3           3
```

三列的意义：

- `len()`：字节数，索引和切片用的单位。
- `codepoints()`：Unicode 码点，`"中".to-unicode()` 是 `20013`，反过来 `str.from-unicode(20013)` 是 `"中"`。
- `clusters()`：字素簇，也就是人眼数到的“一个字”。`é` 如果写成 `e` 加组合重音符 `\u{0301}`，是一个簇、两个码点、三个字节。

`\u{...}` 是字符串里的码点转义，上一篇在标记里也见过。想在 Typst 里按“字”数数或裁剪标题，用 `clusters()`，不要用 `slice`。

**`slice` 和 `at` 用字节偏移，落在字符中间就报错。** 合法的切法：

```typst
// Slicing takes byte offsets and must land on a character boundary.
#assert.eq(s.slice(0, 3), "中")
#assert.eq(s.at(3), "文")
```

故意切在“中”的中间（[`str-index.fail.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch02/str-index.fail.typ)）：

```typst
// Byte offset 1 is inside the three-byte character 中.
#"中文".slice(1)
```

`out/ch02/str-index.stderr`：

```text
error: string index 1 is not a character boundary
  ┌─ lab/ch02/str-index.fail.typ:2:1
  │
2 │ #"中文".slice(1)
  │  ^^^^^^^^^^^^^^^
```

报错里没有“推荐偏移”，只告诉你 1 不是边界。可以这样自查：`.len()` 倍数不对劲时，把字符串转 `clusters()` 或 `codepoints()` 数组再切，数组按元素下标，不会落到字符中间。

字符串的其他常用方法也都在同一个文件里，每条都带断言：

```typst
// Conversions and searching.
#assert.eq("中".to-unicode(), 20013)
#assert.eq(str.from-unicode(20013), "中")
#assert.eq("a,b,,c".split(","), ("a", "b", "", "c"))
#assert.eq("  trim me ".trim(), "trim me")
#assert.eq("Typst".replace(regex("[aeiou]"), "_"), "Typst")
#assert.eq("2026-10-19".find(regex("\d+")), "2026")
#assert.eq("ab" * 3, "ababab")
#assert.eq(upper("typst"), "TYPST")
```

注意 `"Typst".replace(regex("[aeiou]"), "_")` 的结果仍是 `"Typst"`：没有元音，我一开始还以为我写错了正则。另外 `upper` 是函数而不是字符串方法：`"ab".upper()` 会报 ``type string has no method `upper` ``，要写 `upper("ab")`。

## 类型之间不隐式转换

字符串和整数相加，别的语言会替你拼接或者转换。Typst 不会（[`type-error.fail.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch02/type-error.fail.typ)）：

```typst
// Typst never coerces between types.
#("1" + 1)
```

`out/ch02/type-error.stderr`：

```text
error: cannot add string and integer
  ┌─ lab/ch02/type-error.fail.typ:2:2
  │
2 │ #("1" + 1)
  │   ^^^^^^^
```

要转就显式写：`str(42) + "!"` 得 `"42!"`，`int("42") + 1` 得 `43`，`float("1.5")` 得 `1.5`。`str(3.0)` 得 `"3"`，不是 `"3.0"`：整数值的浮点转字符串时小数点会丢，要保留的话得自己格式化（我实测过，没有深究原因）。我猜这种严格是刻意的：排版里的数据多来自文件，类型不对应该尽早报错。

### 字符串不是内容

Typst 里 `"a"` 和 `[a]` 是两种值：前者是 `str`，后者是 `content`，上一篇所有的标记最终都是 `content`。两者之间有一条单向的路，字符串可以“升级”成内容，内容不能“降级”回字符串：

```text
$ typst eval 'type([a] + [b])'
"content"
$ typst eval '"a" + [b]'
{"func":"sequence","children":[{"func":"text","text":"a"},{"func":"text","text":"b"}]}
$ typst eval 'str([a])'
error: expected integer, float, decimal, version, bytes, label, type, or string, found content
  ┌─ <input-expression>:1:4
  │
1 │ str([a])
  │     ^^^
```

第 3 篇讲 content 的内部结构，并在 `src/util.typ` 里写一个 `plain-text` 来做这个“降级”。另外 `for` 遍历字符串是按簇走的：`for c in "中e\u{301}x"` 一共循环 3 次（这个字符串有 4 个码点、7 个字节，`typst eval` 数出来的是 3）。

## 绑定、遮蔽与解构

`let` 绑定一个名字。再次 `let` 同名是**遮蔽**，不是修改，之前捕获了旧值的函数不受影响（[`control.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch02/control.typ) 开头）：

```typst
// `let` binds; a later `let` shadows, the old value is untouched.
#let x = 1
#let f() = x
#let x = 2
#assert.eq(f(), 1)
#assert.eq(x, 2)
```

`f` 定义时看见的 `x` 是 1，后来的 `let x = 2` 不会回头改它。这和 Typst “函数是纯的”是一回事，下一篇会专门讲，并给出修改外部变量的报错。

函数也用 `let` 定义：`#let f() = x` 是 `#let f = () => x` 的简写。

**解构。** `let` 左边可以是数组或字典的模式，`..` 收集剩余部分（[`collections.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch02/collections.typ) 末尾）：

```typst
// Destructuring in `let` and in `for`.
#let (first, ..rest) = xs
#assert.eq(first, 3)
#assert.eq(rest, (1, 2, 3, 1))
#for (k, v) in d [#k: #repr(v) \ ]
#for (i, x) in xs.enumerate() [#i=#x #h(0.5em)]
```

输出：

```text
name: "Typst"
year: 2023
stable: true
0=3 1=1 2=2 3=3 4=1
```

`for (k, v) in d` 遍历字典得到键值对；`for (i, x) in xs.enumerate()` 是数组带下标遍历。`[...]` 紧跟在 `for` 头后面是内容块作循环体，每轮产出一小段内容，所有轮的产出拼接起来，这就是下一节的“连接”。

## 控制流和“块的值”

`if` 是表达式，有值：

```typst
// if / else is an expression.
#let sign(n) = if n > 0 { 1 } else if n < 0 { -1 } else { 0 }
#assert.eq((-5, 0, 7).map(sign), (-1, 0, 1))
```

`if`、`for`、`while` 都能用在 `#` 后面直接产出内容，也能作为表达式给变量赋值。关键规则是**代码块的值是它里面所有语句值的“连接”**（join）：字符串连字符串，内容连内容，数组连数组，没有值的语句（`let`、`none`）不贡献。

```typst
// Code blocks join the values of their statements (strings with strings,
// content with content; mixing a string and an integer is an error).
#let joined = {
  "a"
  "b"
}
#assert.eq(joined, "ab")
```

类型不一致就是错，我拿临时文件 `joinerr.typ` 试过：

```text
$ cat joinerr.typ
#{
  "a"
  3
}
$ typst compile --root . joinerr.typ x.pdf
error: cannot join string with integer
  ┌─ joinerr.typ:3:2
  │
3 │   3
  │   ^
```

循环也遵守这条规则，`for` 的值就是各轮值的连接。想要数组，每轮产出一个单元素数组 `(i,)`，连起来就是数组；`break` 和 `continue` 照常可用：

```typst
// Loops; `break` and `continue` work in both.
#let collatz(n) = {
  let steps = 0
  while n != 1 {
    n = if calc.even(n) { calc.quo(n, 2) } else { 3 * n + 1 }
    steps += 1
  }
  steps
}
#assert.eq(collatz(27), 111)

#let odds = for i in range(1, 10) {
  if i > 7 { break }
  if calc.even(i) { continue }
  (i,)
}
#assert.eq(odds, (1, 3, 5, 7))
```

`while` 里的赋值 `n = ...` 和 `steps += 1` 能修改函数**自己的**局部变量（对外层变量不行，下一篇）。27 要 111 步，这是个有名的数字，上面的断言也验证了。

文件最后两行把值嵌回标记：

```typst
// Embedding code in markup: `#` takes the longest valid expression.
Collatz(27) = #collatz(27) 步，奇数 #odds.map(str).join("、")。
#("一" + "二")，#(1 + 2) 与 #1+2 不同：后者先输出 1。
```

```text
Collatz(27) = 111 步，奇数 1、3、5、7。 一二，3 与 1+2 不同：后者先
输出 1。
```

运算符一览，都是你预期的那些：`+ - * /`、比较 `== != < <= > >=`、逻辑 `and or not`、成员 `in` 和 `not in`（对数组、字符串、字典的键都有效）、赋值 `= += -= *= /=`。这一串我也跑了一遍：

```text
$ typst eval '(1 + 2 * 3 - 4, 2 in (1, 2, 3), "ell" in "hello", "x" in (x: 1))'
[3,true,true,true]
```

几个我专门核对过的细节，因为别的语言里它们不一样：

```text
$ typst eval '(1 == 1.0, "a" < "b", (1, 2) == (1, 2), (a: 1) == (a: 1), 7 - -2)'
[true,true,true,true,9]
$ typst eval '(calc.pow(2, 10), calc.round(3.14159, digits: 2), calc.clamp(15, 0, 10), calc.gcd(12, 18))'
[1024,3.14,10,6]
$ typst eval 'if none { 1 } else { 2 }'
error: expected boolean, found none
  ┌─ <input-expression>:1:3
  │
1 │ if none { 1 } else { 2 }
  │    ^^^^
```

- `1 == 1.0` 是 `true`：整数和浮点可以比较，也可以混着算，`1 + 1.0` 得 `2.0`，结果是 `float`。
- 数组和字典按内容比较，不是比较引用，所以 `assert.eq` 可以直接比整个集合。
- 条件必须是 `bool`。`if none` 报 `expected boolean, found none`，`if 0` 报 `expected boolean, found integer`，没有“零或空算假”这回事。想判断数组空不空，写 `xs.len() == 0`。
- 数学函数在 `calc` 模块里：`calc.pow`、`calc.round(x, digits: 2)`、`calc.clamp`、`calc.gcd`、`calc.quo`、`calc.rem`、`calc.even`。

## 数组与字典

数组 `(1, 2, 3)`，字典 `(name: "x", year: 1)`，空数组 `()`，空字典 `(:)`。单元素数组必须带逗号，`(1,)`，否则它只是加了括号的 `1`。字典保持插入顺序。

多数方法不改原值，返回新值；少数（`push`、`pop`、`insert`、`remove`）会就地修改变量，后面单独讲。[`collections.typ`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch02/collections.typ) 的前半：

```typst
// Arrays
#let xs = (3, 1, 2, 3, 1)
#assert.eq(xs.map(x => x * x), (9, 1, 4, 9, 1))
#assert.eq(xs.filter(x => x > 1), (3, 2, 3))
#assert.eq(xs.fold(0, (sum, x) => sum + x), 10)
#assert.eq(xs.dedup(), (3, 1, 2))
#assert.eq(xs.sorted(), (1, 1, 2, 3, 3))
#assert.eq(xs.sorted(key: x => -x), (3, 3, 2, 1, 1))
#assert.eq(("a", "b").enumerate(), ((0, "a"), (1, "b")))
#assert.eq(("a", "b").zip((1, 2)), (("a", 1), ("b", 2)))
#assert.eq(("a", "b", "c").join(", "), "a, b, c")
#assert.eq(range(1, 5, inclusive: true), (1, 2, 3, 4, 5))
#assert.eq(xs.at(10, default: none), none)
```

要点：

- `map`、`filter`、`fold`：箭头 `x => ...` 是匿名函数，`fold` 的第一个参数是初值。
- `dedup` 保留首次出现的顺序，`sorted(key: ...)` 按键排序。
- `enumerate`、`zip` 返回数组的数组，配合解构很顺手。
- `join(", ")` 用分隔符连接；不带参数就直接连接。
- `range(1, 5)` 默认不含终点，得 `(1, 2, 3, 4)`；0.15 新增 `inclusive: true` 让它含终点。
- `at(i, default: ...)` 越界时返回默认值。不写 `default` 就是错：

```text
$ typst eval '(1, 2, 3).at(5)'
error: array index out of bounds (index: 5, len: 3) and no default value was specified
  ┌─ <input-expression>:1:0
  │
1 │ (1, 2, 3).at(5)
  │ ^^^^^^^^^^^^^^^
```

其他常用的我也跑过：`first()`、`last()`、`slice(1)`、`rev()`、`sum()`、`contains(2)`、`chunks(2)`、`windows(2)`、`any`/`all`、`position`、`find`，行为和字面意思一致。

字典同理，后半段：

```typst
// Dictionaries keep insertion order.
#let d = (name: "Typst", year: 2023, stable: true)
#assert.eq(d.keys(), ("name", "year", "stable"))
#assert.eq(d.at("version", default: "?"), "?")

// 0.15: `map` and `filter` on a dictionary act on the values.
#assert.eq((a: 1, b: 2, c: 3).map(v => v * 2), (a: 2, b: 4, c: 6))
#assert.eq((a: 1, b: 2, c: 3).filter(v => v > 1), (b: 2, c: 3))
```

0.15 给字典加了 `map` 和 `filter`。要小心：回调只拿到**值**，拿不到键，结果仍是字典，键保持不变。`d.y` 访问不存在的键是个明确的错误，`dictionary does not contain key "y"`，用 `d.at("y", default: ...)` 才安全。

### 就地修改的方法

`push`、`pop`、`insert`、`remove` 这几个方法改的是变量本身，不是返回副本。字符串的 `+=` 同理。临时文件 `mut.typ`：

```typst
#let xs = (1, 2)
#xs.push(3)
#let d = (a: 1)
#{ d.insert("b", 2) }
#let last = xs.pop()
#let s = "ab"
#{ s += "c" }
#raw(repr(xs) + " " + repr(d) + " " + str(last) + " " + s)
```

```text
(1, 2) (a: 1, b: 2) 3 abc
```

`xs` 先 `push(3)` 变成 `(1, 2, 3)`，`pop()` 又取走 3，所以最后是 `(1, 2)`；`d` 多了键 `b`；字符串长成 `abc`。`#xs.push(3)` 在标记里不输出任何东西，因为方法返回 `none`。

有一条限制：这种修改只能发生在变量所在的那一层。如果在函数里对**函数外**的数组 `push`，Typst 拒绝：

```text
error: variables from outside the function are read-only and cannot be modified
  ┌─ mut2.typ:9:13
  │
9 │ #let f() = { xs.push(9) }
  │              ^^

  while calling `f` at mut2.typ:10:1
    f()
```

（`mut2.typ` 是 `mut.typ` 末尾追加 `#let f() = { xs.push(9) }` 和 `#f()` 两行。原因和解决办法放到下一篇，那里有仓库里的正式实验 `capture-mutation.fail.typ`。）

## 诊断：assert、panic、repr 和 type

开发时你要靠它们说话。我把四个入口在 `/tmp/ch02/` 下各触发了一遍，贴真实报错。

**`assert(cond, message: ...)`**：

```text
$ cat assert.typ
#assert(1 + 1 == 3, message: "arithmetic is broken")
$ typst compile --root . assert.typ x.pdf
error: assertion failed: arithmetic is broken
  ┌─ assert.typ:1:1
  │
1 │ #assert(1 + 1 == 3, message: "arithmetic is broken")
  │  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

**`assert.eq(a, b)`** 更好用，不匹配时告诉你左值：

```text
$ cat asserteq.typ
#assert.eq(2 * 3, 7)
$ typst compile --root . asserteq.typ x.pdf
error: equality assertion failed: value 6 was not equal to 7
  ┌─ asserteq.typ:1:1
  │
1 │ #assert.eq(2 * 3, 7)
  │  ^^^^^^^^^^^^^^^^^^^
```

加 `message:` 则输出 `equality assertion failed: area mismatch`，不再给值。所以我的习惯是：不加消息，让它自己说值。本章所有“断言就是测试”的文件都是这个风格，第 16 篇的 `tests/` 目录整个是 `assert.eq`。

**`panic(...)`**：无条件失败，接受多个参数。0.15 起字符串参数按原样打印，不再带引号。我写了个会触发它的函数（`panic.typ`）：

```typst
#let area(w, h) = {
  if w < 0 or h < 0 { panic("negative side: " + repr((w, h))) }
  w * h
}
#area(3, -2)
```

```text
$ typst compile --root . panic.typ panic.pdf; echo "exit=$?"
error: panicked with: negative side: (3, -2)
  ┌─ panic.typ:2:22
  │
2 │   if w < 0 or h < 0 { panic("negative side: " + repr((w, h))) }
  │                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

  while calling `area` at panic.typ:5:1
    area(3, -2)

exit=1
```

两点：消息里没有引号，`repr((w, h))` 生成的 `(3, -2)` 是我主动拼进去的；报错还带了调用栈 `while calling area at ...`，这是 panic 比 assert 好用的地方，库作者在自己的函数里检查参数用它（第 15 篇的 `term` 会这么用）。

再验证“字符串原样、多参数”（`panic2.typ`，内容 `#panic("path: C:\\data\\\"x\"", "second", 42)`）：

```text
error: panicked with: path: C:\data\"x", second, 42
  ┌─ panic2.typ:1:1
  │
1 │ #panic("path: C:\\data\\\"x\"", "second", 42)
  │  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

源码里的 `\\` 和 `\"` 是字符串转义，运行后字符串本身是 `path: C:\data\"x"`，报错里原样出现，三个参数用逗号隔开。

**`repr` 和 `type`**：`repr(x)` 给出值的“源码”字符串，`type(x)` 给出类型。对内容用 `repr` 能看到树结构（下一篇的主角）：

```text
$ typst eval 'repr([*a* b])'
"sequence(strong(body: [a]), [ ], [b])"
```

这一行告诉你 `[*a* b]` 其实是三个子节点的序列：一个 `strong`、一个空格、一个文字 `b`。

在调试时把 `#raw(repr(x))` 直接放进文档，是最快的 print 调试，这一章的表格就是这么来的。

一个收尾小练习，自己先猜再跑：

```text
$ typst eval '"中文".slice(0, 3) + "!" * 2'
"中!!"
```

`slice(0, 3)` 刚好取走第一个汉字的 3 个字节，`"!" * 2` 是 `"!!"`，`*` 比 `+` 先算。下一篇进入函数：`#let f(x) = ...` 只是开头，真正有意思的是 `arguments`、闭包为什么不能改外面的变量，以及 `[*a* b]` 那棵树怎么被你的函数遍历。[第 3 篇](/posts/typst-by-xuan-03-functions-and-content/)见。
