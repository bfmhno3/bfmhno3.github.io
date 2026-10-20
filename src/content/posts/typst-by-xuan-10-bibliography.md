---
title: "参考文献：BibTeX、Hayagriva 与 GB/T 7714"
commentId: "post:typst-by-xuan-10-bibliography"
published: "2026-10-19 17:00:00 +08:00"
description: "用 Xuan 从零学 Typst 第 10 篇：我用 Typst 0.15.1 编译了 ch10 的 6 个 lab 文件，让同一份三条目的数据分别以 BibTeX 和 Hayagriva YAML 进入文档，用 GB/T 7714、IEEE、APA、Chicago 和一个原样拷来的 CSL 文件各排一遍，量出样式的语言环境跟着 text.lang 走而不是跟着条目走，用 0.15 的 target 与 group 在同一篇文档里放了三个参考文献列表，最后把 bibliography 参数接进 xuan 的 note 模板。"
category: Tutorial
tags:
  - Typst
  - Xuan
  - 参考文献
  - BibTeX
series: "用 Xuan 从零学 Typst"
seriesOrder: 10
draft: false
comment: true
slug: typst-by-xuan-10-bibliography
---

下面这张图是 `lab/ch10/multi-bib.typ` 的渲染结果：同一份三条目的数据，在一页里排出了三个参考文献列表，编号分别是 `[1] [2]`、`[1]` 和 `[3]`，而正文里没有手写过一个编号。

![multi-bib.typ 的渲染：蓝色左边线的块里有两条引用和它自己的列表，红色左边线的块里再引一次并从 [1] 重新编号，最后是只含一条的总参考文献](/assets/images/typst-by-xuan/ch10-multi-bib.png)

这一篇我想弄清楚的是这条路径上的每个环节：Typst 里引用一篇文献的写法和引用一个标签完全一样（`@strang2023`），编译器发现这个标签不在文档里时，会去已声明的参考文献文件里找同名的键。数据文件有哪两种格式，样式文件（CSL）是什么，为什么同一份数据在中文文档里会冒出“6 版”而在英文列表里是“6th ed.”，以及 0.15 新增的 `target` 与 `group` 怎么做出上面这张图。最后我会把这些接进 `xuan` 的 `note` 模板，让笔记末尾自动长出一份 GB/T 7714 的列表。

> [!NOTE] 本篇检查点
> 这一篇没有新增 `src/` 文件。`src/note.typ` 在这一篇变成**最终版**（文中完整展示，48 行），它相对第 4 篇的版本多了 `bibliography` 参数和末尾 3 行；`lib.typ` 与 `src/base.typ` 仍是此前讲过的状态，这一篇不再改。`lab/ch10/` 下的 6 个 Typst 文件（`bib-basic`、`bib-hayagriva`、`custom-csl` 三个子目录里的 `main.typ`，加 `cite-forms.typ`、`multi-bib.typ`、`fig-bib.typ`）全部通过 `make ch10`，同目录还有数据文件 `refs.bib`、`refs.yml` 和样式文件 `custom-csl/ams-label.csl`。
> 前置：[第 9 篇](/posts/typst-by-xuan-09-figures-tables-code/)（图、表、交叉引用，`@label` 的解析规则）。如果你想了解 `.bib` 文件本身的字段和条目类型，我之前写过一篇[BibTeX 与 BibLaTeX 入门](/posts/bibtex-and-biblatex-guide/)，这里默认你知道 `@book{key, ...}` 长什么样。

## 数据：一份 .bib，三个条目

整个 ch10 共用一份数据。`lab/ch10/refs.bib`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch10/refs.bib)）里有三本书，两本英文教材，一本中文教材：

```bibtex
@book{strang2023,
  author    = {Strang, Gilbert},
  title     = {Introduction to Linear Algebra},
  edition   = {6},
  publisher = {Wellesley-Cambridge Press},
  address   = {Wellesley, MA},
  year      = {2023},
  isbn      = {978-1-7331466-7-8},
  language  = {en},
}

@book{golub2013,
  author    = {Golub, Gene H. and {Van Loan}, Charles F.},
  title     = {Matrix Computations},
  edition   = {4},
  publisher = {Johns Hopkins University Press},
  address   = {Baltimore},
  year      = {2013},
  isbn      = {978-1-4214-0794-4},
  language  = {en},
}

@book{tongji2014,
  author    = {同济大学数学系},
  title     = {工程数学 线性代数},
  edition   = {6},
  publisher = {高等教育出版社},
  address   = {北京},
  year      = {2014},
  isbn      = {978-7-04-039661-4},
  language  = {zh},
}
```

作者 `{Van Loan}` 外面的花括号是 BibTeX 的老惯例，告诉解析器这是一个整体的姓；稍后会看到它在某个样式里仍然被拆开，先记着。

## 最小用法：`@key` 加一行 `bibliography`

`lab/ch10/bib-basic/main.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch10/bib-basic/main.typ)）：

```typst
// BibTeX: cite with @key, print with `bibliography`.
#import "@local/xuan:0.1.0": *
#set page(width: 12cm, height: auto, margin: 1cm)
#show: xuan-base

= 最小二乘

正规方程的几何解释见 @strang2023，数值稳定性见 @golub2013[Ch.~5]。
国内教材参见 @tongji2014。

#bibliography("../refs.bib", style: "gb-7714-2015-numeric")
```

三个机制都在这几行里。

**`@strang2023` 是 `ref` 的特例。** 第 9 篇讲过 `@label` 找文档里的标签。找不到时，Typst 去所有 `bibliography` 声明的文件里按键名找，找到就把它当成一次 `cite`。所以引用文献不需要任何额外语法，代价是：文档里没有对应的 `bibliography` 或键写错时，报的是标签找不到。我在 `/tmp/p10`（这一篇里 `/tmp` 下的实验都不在仓库里，代码都在文中）里各试了一次：

```typst
#set page(width: 12cm, height: auto)
见 @nokey 与 @strang2023。
#bibliography("refs.bib")
```

```text
error: label `<nokey>` does not exist in the document
  ┌─ nokey.typ:2:2
  │
2 │ 见 @nokey 与 @strang2023。
  │    ^^^^^^
```

把最后一行 `#bibliography` 去掉，报错就变成 `@strang2023` 找不到。所以看到“label does not exist”，两个方向都要查：键拼错了，或者忘了声明数据文件。

**`[Ch.~5]` 是 supplement。** `@key` 后面紧跟的方括号是 content，成为引用的补充说明（页码、章节），由样式决定放在哪、怎么标点。这里 `~` 是不换行空格，保证 `Ch.` 和 `5` 不被拆到两行。

**`style:` 选择样式，数据文件和样式是两回事。** `gb-7714-2015-numeric` 是 Typst 内置的样式名，对应国标顺序编码制。渲染结果（`make ch10` 之后 `out/ch10/bib-basic.pdf`，下图是同一文件的 PNG）：

![bib-basic.typ 的渲染：正文三处引用显示为上标方括号数字，下方“参考文献”列表按 GB/T 7714 格式排版，英文作者姓大写，文献类型标记 [M]](/assets/images/typst-by-xuan/ch10-bib-basic.png)

`pdftotext -layout out/ch10/bib-basic.pdf -` 给出的纯文本：

```text
1 最小二乘
    正规方程的几何解释见[1]，数值稳定性见[2]。 国内教材
参见[3]。

参考文献
[1] STRANG G. Introduction to Linear Algebra[M]. 6 版 .
   Wellesley, MA: Wellesley-Cambridge Press, 2023.
[2] GOLUB G H, VAN LOAN C F. Matrix Computations[M]. 4
   版. Baltimore: Johns Hopkins University Press, 2013.
[3] 同济大学数学系. 工程数学 线性代数[M]. 6 版. 北京: 高
   等教育出版社, 2014.
```

注意三件事。引用按**首次出现的顺序**编号，`[1]` 是 Strang 而不是按键名字母序。`[2, Ch. 5]` 这样的补充说明在国标样式里被丢掉了：正文里写的是 `[2]`，`Ch.~5` 不见了；换成 `ieee`（下一节）补充说明就保留了，所以这是样式的决定，不是 `@golub2013[Ch.~5]` 写错了。第三，英文书的版本写成了“6 版”，这个我留到后面的“语言环境”一节单独讲。

“参考文献”这个标题不是我写的，是 `bibliography` 的默认 `title`，按 `text.lang` 取本地化名称；`xuan-base` 里设了 `heading.numbering: "1.1"`，但这个标题没有编号（原因在最后一节）。

## 另一种数据格式：Hayagriva YAML

Typst 自带的参考文献引擎叫 Hayagriva，`.bib` 只是它能读的格式之一，原生格式是 YAML。`lab/ch10/refs.yml`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch10/refs.yml)）与 `refs.bib` 条目一一对应，键完全一样。我只贴前两条，第三条同理：

```yaml
strang2023:
  type: book
  title: Introduction to Linear Algebra
  author: Strang, Gilbert
  edition: 6
  date: 2023
  language: en
  publisher:
    name: Wellesley-Cambridge Press
    location: Wellesley, MA
  serial-number:
    isbn: 978-1-7331466-7-8

golub2013:
  type: book
  title: Matrix Computations
  author:
    - Golub, Gene H.
    - Van Loan, Charles F.
  edition: 4
  date: 2013
  language: en
  publisher:
    name: Johns Hopkins University Press
    location: Baltimore
  serial-number:
    isbn: 978-1-4214-0794-4
```

对照一下就能看出 BibTeX 里扁平的字段在 YAML 里怎么嵌套：`publisher` 加 `address` 变成带 `name` 与 `location` 的子字典，`isbn` 进了 `serial-number`，多个作者是列表，所以不再需要 `{Van Loan}` 那种花括号技巧：列表里每一项本来就是一个完整的人名。`.bib` 的好处是 Zotero、Google Scholar 之类的工具能直接导出，YAML 则好读好手写；我自己的选择是，数据来自工具就留 `.bib`，条目少又手写就用 YAML。

两种格式可以混用吗？`bibliography` 的第一个参数既可以是一个路径，也可以是路径数组。我试了 `("refs.bib", "refs.yml")`（`/tmp/p10/mixed.typ`，同一份数据两种格式各一份）：

```typst
#set page(width: 12cm, height: auto)
见 @strang2023 与 @golub2013。
#bibliography(("refs.bib", "refs.yml"), style: "ieee")
```

```text
error: duplicate bibliography keys: strang2023, golub2013, tongji2014
  ┌─ mixed.typ:3:14
  │
3 │ #bibliography(("refs.bib", "refs.yml"), style: "ieee")
  │               ^^^^^^^^^^^^^^^^^^^^^^^^
```

数组本身是合法的，只是我这里两个文件的键撞了，所以编译器拒绝。我另外把 `refs.bib` 拆成 `a.bib`（Strang）和 `b.bib`（Golub），用 `#bibliography(("a.bib", "b.bib"), style: "ieee")` 编译（`/tmp/p10/t2.typ`），正文 `[1]` 与 `[2]` 都解析成功，列表里两条齐全；键不重叠，数组就合并成一个列表。

`lab/ch10/bib-hayagriva/main.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch10/bib-hayagriva/main.typ)）读的就是 YAML：

```typst
// Hayagriva YAML: same keys, same entries, different file format.
#import "@local/xuan:0.1.0": *
#set page(width: 12cm, height: auto, margin: 1cm)
#show: xuan-base

= 最小二乘

正规方程的几何解释见 @strang2023，数值稳定性见 @golub2013[Ch.~5]。

// Style locale follows `text.lang` where the list is placed: an English
// list inside a Chinese document gets "and" and "6th ed." back.
// `full: true` lists every entry, cited or not.
#[
  #set text(lang: "en")
  #bibliography("../refs.yml", style: "ieee", full: true, title: [References])
]
```

这里新出现三样东西：`full: true`、`title:` 和包在 `#[ ... ]` 里的 `set text(lang: "en")`。

`full: true` 让列表包含数据文件里**所有**条目，不管正文有没有引用。正文只引用了 `strang2023` 和 `golub2013`，渲染出来列表里有三条，`tongji2014` 也在里面，编号 `[3]`。`title:` 接受 content（覆盖默认标题）或 `none`（不要标题，后面多列表那一节会用）。

![bib-hayagriva.typ 的渲染：中文正文里的引用显示为 [1] 和 [2, Ch. 5]，下方是英文标题 References 的 IEEE 样式列表，英文书版本写作 6th ed.，中文教材也在列表里](/assets/images/typst-by-xuan/ch10-bib-hayagriva.png)

```text
1 最小二乘
     正规方程的几何解释见 [1]，数值稳定性见 [2, Ch. 5]。

References
[1] G. Strang, Introduction to Linear Algebra, 6th ed. Wellesley,
    MA: Wellesley-Cambridge Press, 2023.
[2] G. H. Golub and C. F. Van Loan, Matrix Computations, 4th
    ed. Baltimore: Johns Hopkins University Press, 2013.
[3] 同济大学数学系, 工程数学 线性代数, 6th ed. 北京: 高等
    教育出版社, 2014.
```

IEEE 样式保留了补充说明（`[2, Ch. 5]`），国标样式把它丢了，这是同一个 `@golub2013[Ch.~5]` 写法在不同样式里的两种命运。

## 语言环境：跟着 `text.lang` 走，不跟着条目走

对比前两份输出：同一条 Strang，在 `bib-basic` 里是“6 版”，在 `bib-hayagriva` 里是“6th ed.”；同一条同济教材，在 IEEE 列表里是“6th ed.”，作者之间的连接词是 `and`。两份数据里每个条目都写了 `language`（`en` 或 `zh`），然而这个字段并没有决定输出：

- `bib-basic` 里 `strang2023` 的 `language` 是 `en`，列表里照样出现“6 版”。
- `bib-hayagriva` 里 `tongji2014` 的 `language` 是 `zh`，列表里照样是“6th ed.”。

决定输出语言的是列表所在位置的 `text.lang`。第 5 篇里 `xuan-cjk` 把整篇文档设成了 `lang: "zh"`，所以 `bib-basic` 里的 `bibliography` 取中文术语（“版”“和”“参考文献”）；`bib-hayagriva` 里我用 `#[ #set text(lang: "en") ... ]` 把这一个列表的语言单独改回英文，于是 `ed.`、`and`、`References` 全回来了。

这个设计的后果是：中英文混合的列表无法让每一条按各自的语言排，列表整体用哪种语言，是你要在列表所在位置选择的事。GB/T 7714 的纯中文环境里英文条目也写成“6 版”那样的中文术语，这时跟着文档 `lang: "zh"` 走恰好是对的；像 IEEE 这样的英文期刊样式，你要么整篇用 `lang: "en"`，要么像这里一样给列表单独设。

（至于条目的 `language` 字段在别的场景里是否有用，那要翻 Hayagriva 的源码才知道，我没翻。我能断言的只是：在这两份文件、这几个样式里，条目带着 `language: en` 或 `zh` 都被 `text.lang` 盖过了。）

## 样式：同一条目，四种面孔

`style:` 接受内置样式名的字符串。我用 `lab/ch10/fig-bib.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch10/fig-bib.typ)）把同一条 Golub 在四个样式里各排一遍：

```typst
// One source, four styles: each block owns a local bibliography.
#import "@local/xuan:0.1.0": *
#set page(width: auto, height: auto, margin: 12pt)
#show: xuan-base
#set par(first-line-indent: 0pt)
#set text(size: 9pt)

#let sample(style) = block(width: 11cm, context {
  strong(raw(style))
  [: ] + cite(<golub2013>)
  bibliography(
    "refs.bib",
    style: style,
    title: none,
    target: selector(cite).within(here()),
    group: none,
  )
  v(0.8em)
})

#sample("gb-7714-2015-numeric")
#sample("ieee")
#sample("apa")
#sample("chicago-author-date")
```

这里先不管 `target` 和 `group`（后面单独一节），只关注它的产出：

![同一条文献 Matrix Computations 在四个样式下的引用和列表：gb-7714-2015-numeric 为上标 [1] 与大写作者名，ieee 为 [1] 与首字母缩写，apa 为（Golub 与 Van Loan，2013）形式，chicago-author-date 为 Golub 和 Van Loan 2013 形式](/assets/images/typst-by-xuan/ch10-styles.png)

| 样式 | 正文引用 | 条目开头 |
| --- | --- | --- |
| `gb-7714-2015-numeric` | 上标 `[1]` | `GOLUB G H, VAN LOAN C F. Matrix Computations[M]. 4 版.` |
| `ieee` | `[1]` | `G. H. Golub 和 C. F. Van Loan, Matrix Computations, 4 版.` |
| `apa` | `(Golub & Van Loan, 2013)` | `Golub, G. H., & Van Loan, C. F. (2013). Matrix Computations (4 版).` |
| `chicago-author-date` | `(Golub 和 Van Loan 2013)` | `Golub, Gene H., 和 Charles F. Van Loan. 2013. Matrix Computations. 4 版.` |

前两个是顺序编码制（正文里放编号，列表按引用顺序），后两个是著者出版年制（正文里放作者和年份，列表按作者字母序）。`apa` 的 `&` 和 `chicago-author-date` 的“和”来源不同：前者是 APA 的规定，后者是 Chicago 样式在 `lang: "zh"` 下取到的本地化“and”。这也再次印证了上一节：文档语言是中文，连接词就是中文。

写错样式名会怎样？我试了 `style: "gb-7714"`：

```text
error: unknown style: gb-7714
  ┌─ badstyle.typ:3:33
  │
3 │ #bibliography("refs.bib", style: "gb-7714")
  │                                  ^^^^^^^^^
```

内置名必须拼全（`gb-7714-2015-numeric`，或者著者出版年制的 `gb-7714-2015-author-date`）。至于其他几百种学术期刊的样式，要么在 Typst 文档的 `bibliography` 页面查内置列表，要么用下面的 CSL 文件。

## 引用的写法：`cite` 与它的 `form`

`@key` 只能表达“一个括号引用”。要表达“作者名”“只要年份”“把引用放进句子里”，用 `cite` 函数。`lab/ch10/cite-forms.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch10/cite-forms.typ)）在著者出版年制（`apa`）下把几种写法并排：

```typst
// cite forms: `@key`, supplements and `cite(form:)` under author-date style.
#import "@local/xuan:0.1.0": *
#set page(width: 12cm, height: auto, margin: 1cm)
#show: xuan-base
#set par(first-line-indent: 0pt)

普通引用 @strang2023；带页码 @golub2013[p.~12]。\
作者形式：#cite(<golub2013>, form: "author")；
年份形式：#cite(<golub2013>, form: "year")；
文中形式：#cite(<strang2023>, form: "prose")。\
隐藏引用只登记条目：#cite(<tongji2014>, form: none)。

#bibliography("refs.bib", style: "apa")
```

选 `apa` 是因为 `author`、`year` 这类形式只在著者出版年制里有明显区别；顺序编码制里我没有编译过这些组合，不下结论。著者出版年制的结果：

![cite-forms.typ 的渲染：普通引用 (Strang, 2023)，带页码 (Golub & Van Loan, 2013, p. 12)，作者形式只有姓名，年份形式只有 2013，文中形式 Strang (2023)，隐藏引用处为空；下方列表三条文献俱全，同济教材排在最前](/assets/images/typst-by-xuan/ch10-cite-forms.png)

```text
普通引用 (Strang, 2023)；带页码 (Golub & Van Loan, 2013,
p. 12)。
作者形式：Golub & Van Loan； 年份形式：2013； 文中形式：
Strang (2023)。
隐藏引用只登记条目：。

参考文献
同济大学数学系. (2014). 工程数学 线性代数 (6 版). 高等教育
   出版社.
Golub, G. H., & Van Loan, C. F. (2013). Matrix Computations (4
   版). Johns Hopkins University Press.
Strang, G. (2023). Introduction to Linear Algebra (6 版).
   Wellesley-Cambridge Press.
```

`form` 的取值有 `"normal"`（默认，`@key` 就是它）、`"author"`、`"year"`、`"prose"`，以及 `none`。关键的是最后一个：“隐藏引用只登记条目：”后面是空的，什么都没印，但同济教材仍然出现在了下方的列表里。想让某条文献进列表又不想在正文里提它时，这就是手段。`full: true` 是整个文件都进列表，`form: none` 是挑几条进。

著者出版年制的列表按作者排序，这里同济教材排在 Golub 与 Strang 之前。这一条我只记录结果，没有去区分排序规则是按拼音还是按码点。

## 本地 CSL 文件：不用等 Typst 内置

内置样式够用的时候用内置名；不够用，`style:` 也可以是一个 `.csl` 文件的路径。CSL（Citation Style Language）是一种 XML 格式，Zotero 和 Pandoc 也用它，社区在 [citation-style-language/styles](https://github.com/citation-style-language/styles) 仓库里维护着大量学术期刊与机构的样式。

`lab/ch10/custom-csl/ams-label.csl` 是我从那个仓库**原样拷来**的美国数学会 label 样式，153 行，没有改过一个字符。文件头部有它的许可证声明，我保留了：

```xml
<rights license="http://creativecommons.org/licenses/by-sa/3.0/">This work is licensed under a Creative Commons Attribution-ShareAlike 3.0 License</rights>
```

也就是 CC BY-SA 3.0。这份许可证的要求是署名和相同方式共享，所以这个文件不适用本仓库的 MIT OR Apache-2.0；它保持着自己的头部，仓库里别的文件不依赖它的授权。如果你要在自己的项目里拷它，也请保留这一行 `<rights>`。

`lab/ch10/custom-csl/main.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch10/custom-csl/main.typ)）：

```typst
// A CSL file used as-is. ams-label.csl comes verbatim from
// github.com/citation-style-language/styles (CC BY-SA 3.0, see its <rights>).
#import "@local/xuan:0.1.0": *
#set page(width: 12cm, height: auto, margin: 1cm)
#show: xuan-base

= 引用

矩阵计算 @golub2013 与线性代数 @strang2023。

#bibliography("../refs.bib", style: "ams-label.csl")
```

注意 `style` 的值以 `.csl` 结尾，Typst 据此把它当成路径，而不是内置名字。路径相对于**写下这个字符串的文件**，所以这里的 `"ams-label.csl"` 在 `custom-csl/` 里，而 `refs.bib` 是 `"../refs.bib"`（第 12 篇会专门讲路径解析）。

![custom-csl 的渲染：引用显示为 [GV13] 和 [Str23] 这样由作者姓缩写加年份后两位构成的标签，下方列表条目前缀为同样的标签，作者名为姓在前](/assets/images/typst-by-xuan/ch10-custom-csl.png)

```text
1 引用
    矩阵计算 [GV13] 与线性代数 [Str23]。

参考文献
[GV13] Golub, Gene H., 和 Loan, Charles F. Van, Matrix
          Computations, 4 版, Johns Hopkins University Press,
          Baltimore, 2013.
[Str23]   Strang, Gilbert, Introduction to Linear Algebra, 6 版,
          Wellesley-Cambridge Press, Wellesley, MA, 2023.
```

AMS 的 label 样式把 `[GV13]`、`[Str23]` 这样的字母标签当作引用，这是前面几个按编号或按作者年份的样式做不到的，也是我拿它当例子的原因。

输出里有一个我没料到的细节：第一条是 `Golub, Gene H., 和 Loan, Charles F. Van`，Van Loan 被拆成了 `Loan ... Van`。前面 `ieee`、`apa` 里它都是整体的 `Van Loan`。我的猜测是：Hayagriva 把 `Van` 当成姓的“非丢弃小品词”（non-dropping particle），而这个样式要求作者名全部以“姓，名”倒序显示，CSL 在倒序显示时默认把小品词移到名字后面。我没有去验证这个解释，所以只能说：这是这个样式和这条数据配合起来的实际输出，如果你的数据里有这类姓，要在自己的样式里检查一遍。`.bib` 里的 `{Van Loan}` 花括号没有挡住它，这一点我是看到输出才确认的。

## 多个参考文献：`target` 与 `group`（0.15）

到 0.14 为止，一个文档只能有一个参考文献列表。0.15 的 `bibliography` 多了两个参数：

- `target`：一个选择器，决定这个列表显示**哪些引用**。默认的 `auto` 不是“剩余的引用”，而是按 0.15 文档的优先级归属：先看有没有某个显式 `target` 包含这条引用（有，就归第一个这样的列表）；否则归文档里排在它之后、最近的一个 `target: auto` 且数据里有这个键的列表；再没有，就归排在它之前、最近的一个。
- `group`：决定**编号是否跨列表连续**。`auto` 是和别的 `auto` 列表共享同一组（编号连续），`none` 是自成一组、从头编号。

如果要找个类比：列表是引用表上的一个视图，`target` 是视图的 WHERE 子句，`group` 是视图要不要共享同一个序号序列。下面是 `lab/ch10/multi-bib.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch10/multi-bib.typ)）：

```typst
// 0.15: several bibliographies. `target` picks which citations a list
// shows; `group` decides whether numbering continues across lists.
#import "@local/xuan:0.1.0": *
#set page(width: 12cm, height: auto, margin: 1cm)
#show: xuan-base
#show bibliography: set heading(offset: 1)

// A local list: cites inside `body` go here and nowhere else.
#let local-bib(body, group: auto) = context {
  body
  bibliography(
    "refs.bib",
    style: "ieee",
    title: none,
    target: selector(cite).within(here()),
    group: group,
  )
}

= 正文
正文引用 @tongji2014。

#block(stroke: (left: 1.5pt + blue), inset: 0.8em)[
  #local-bib[英文教材 @strang2023 与 @golub2013。]
]

#block(stroke: (left: 1.5pt + red), inset: 0.8em)[
  // group: none restarts at [1]; with `auto` it would continue at [3].
  #local-bib(group: none)[再引一次 @golub2013。]
]

#bibliography("refs.bib", style: "ieee", title: [总参考文献])
```

`local-bib` 的写法值得停一下。`target: selector(cite).within(here())` 的意思是“位于 `here()` 这个位置之内的 `cite`”。`within` 是 0.15 新增的选择器方法，第 4 篇的踩坑里提过它不能用在 `show` 规则里，只能用在 `query` 和这样的参数里。而 `here()` 需要 context，所以整个函数体包在 `context { ... }` 里（第 7 篇的内容：`here()` 是当前位置，要在 context 里才有定义）。`body` 和 `bibliography(...)` 放在同一个 `context` 块里，二者所在位置一致，所以 `body` 里的引用都落在 `here()` 之内。

渲染：

![multi-bib.typ 的渲染：正文引用 [3]；蓝色左边线的块里引用 [1] 与 [2] 并紧跟一个只含这两条的列表；红色左边线的块里再次引用 Golub，编号为 [1]，下方只列这一条；最后的总参考文献列表只含同济教材，编号 [3]](/assets/images/typst-by-xuan/ch10-multi-bib.png)

```text
1 正文
   正文引用 [3]。

     英文教材 [1] 与 [2]。
 [1] G. Strang, Introduction to Linear Algebra, 6 版 .
     Wellesley, MA: Wellesley-Cambridge Press, 2023.
 [2] G. H. Golub 和 C. F. Van Loan, Matrix Computations, 4
     版. Baltimore: Johns Hopkins University Press, 2013.


     再引一次 [1]。
 [1] G. H. Golub 和 C. F. Van Loan, Matrix Computations, 4
     版. Baltimore: Johns Hopkins University Press, 2013.


总参考文献
[3] 同济大学数学系, 工程数学 线性代数, 6 版. 北京: 高等教
   育出版社, 2014.
```

读这份输出要注意几点。

**显式 `target` 优先。** 最后那个没写 `target` 的列表只显示 `tongji2014`：`@tongji2014` 不在任何 `within` 之内，没有显式列表包含它，于是按 `auto` 的规则归了它后面最近的列表；`strang2023` 和 `golub2013` 被前面的显式列表包含，规则的第一条就把它们分走了，不再出现在总列表里。我另外在 `/tmp/p10/prec.typ` 里把一个默认列表放在前面、一个显式列表放在后面，中间引用 `@strang2023`：

```typst
#set page(width: 12cm, height: auto)
#bibliography("refs.bib", style: "ieee", title: [前面的默认列表])
#context {
  [引用 @strang2023。]
  bibliography(
    "refs.bib",
    style: "ieee",
    title: [后面的显式列表],
    target: selector(cite).within(here()),
  )
}
```

```text
前面的默认列表
引用 [1]。

后面的显式列表
[1] G. Strang, Introduction to Linear Algebra, 6th ed.
    Wellesley, MA: Wellesley-Cambridge Press, 2023.
```

条目出现在后面的显式列表里，前面的默认列表是空的：位置在前不如显式声明。

**编号是按列表在文档里出现的顺序给的，不是按引用的先后。** 同济教材是正文里**最先**被引用的，但它的编号是 `[3]`：它所在的列表在文档的最后。蓝色块的 `[1]`、`[2]` 是因为它们的列表更靠前。

**`group: none` 的作用我对照着做了一遍。** 源文件里的注释说“`auto` 会从 `[3]` 接着编”，我把红色块那一行改成 `group: auto` 编译了（`/tmp/p10/mb-auto.typ`，在 `/tmp` 里，不在仓库）：

```text
     再引一次 [3]。
 [3] G. H. Golub 和 C. F. Van Loan, Matrix Computations, 4
     版. Baltimore: Johns Hopkins University Press, 2013.
```

红块编号变成 `[3]`，总列表里的同济教材则变成了 `[4]`。`group: auto` 的三个列表共用一个编号序列（蓝色 1、2，红色 3，总列表 4）；`group: none` 的红色列表脱离这个序列，从 `[1]` 重新开始，总列表则和蓝色列表同属 `auto` 组，继续用 `[3]`。

这个功能的真实用途：每章末尾一个独立的参考文献（学位论文常见），或者把“推荐阅读”和“引用文献”分成两个列表。

`#show bibliography: set heading(offset: 1)` 让所有参考文献的标题降一级，这样“总参考文献”和上面的 `= 正文` 不在同一级。

## 把它接进 `note`

最后一步是让模板替你把列表放在文末。`src/note.typ` 在这一篇定型，完整的最终版（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/packages/local/xuan/0.1.0/src/note.typ)）如下：

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
  bibliography: none,
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
  if bibliography != none {
    bibliography
  }
}
```

这一章它长出的只有两处：参数表里的 `bibliography: none,`，和末尾的 `if bibliography != none { ... }` 这 3 行，整个文件 48 行。`git log --oneline -- packages/local/xuan/0.1.0/src/note.typ` 在仓库里有三条提交：第一条建立文件，第二条（`feat(xuan): math, figure, ...`）加上这些，第三条（`fix(xuan): ...`）删掉了我写这篇时发现多余的一行，见下文。

设计上有三点值得说。

**参数的类型是“一个 `bibliography` 值”，不是一个路径。** 调用时写 `bibliography: bibliography("refs.bib", style: "gb-7714-2015-numeric")`（`examples/notes/main.typ` 里就是这么用的）。我没有让 `note` 接收 `bib-file:` 和 `bib-style:` 两个参数再自己拼，理由是 `bibliography` 的参数会越来越多（`full`、`title`、`target`、`style`），转发它们只会让 `note` 的签名变成 `bibliography` 的拙劣复制。`bibliography(...)` 的返回值是一个 content 值，可以像别的 content 一样存进变量、当参数传递；把它直接传进来，`note` 就不需要知道里面有什么。

**参数叫 `bibliography`，会遮蔽标准库的同名函数。** `note` 的参数就叫 `bibliography`，在函数体里直接写 `bibliography` 拿到的是参数，上面末尾那段用的就是这个。如果你在 `note` 里还想调用标准库的 `bibliography(...)` 函数本身，要写 `std.bibliography`。现在这个文件不需要，但我保留这条说明，因为文件原先正是用它写了一条 `show std.bibliography: ...` 规则。

**为什么没有一条把参考文献标题设成不编号的规则。** `xuan-base` 设了 `heading.numbering: "1.1"`，文件原先在 `note` 里加了 `show std.bibliography: set heading(numbering: none)`，想让“参考文献”前面不带数字。后来发现它是多余的：不经过 `note` 的 `bib-basic` 里没有这条规则，标题也没有编号；我还把 `note.typ` 里这一行删掉，在 `/tmp` 里用拷贝的包重新编译 `examples/notes/main.typ`，`pdftotext -layout` 的输出和带规则的版本逐字相同。所以在 0.15.1 里 `bibliography` 的标题默认就不编号，这一行已经从仓库里删掉，上面展示的是删除之后的 HEAD 版本。

整篇笔记的最后一页（`examples/notes/main.typ` 编译出的 `out/examples/notes.pdf` 第 4 页，用 `typst compile --pages 4 --format png --ppi 72` 取出）：

![examples/notes 的第 4 页：先是术语表的最后几条，然后是未编号的“参考文献”标题和三条 GB/T 7714 格式的条目，页脚为“第 4 页 / 共 4 页”](/assets/images/typst-by-xuan/ch10-notes-bib.png)

这一页上面的术语表是第 15 篇的内容；现在只需要看下半部分：标题“参考文献”没有编号，三条是 `[1]` 到 `[3]`，格式和 `bib-basic` 里一模一样。`examples/notes/refs.bib` 与 `lab/ch10/refs.bib` 逐字相同（我用 `diff` 比过）。

## 留给你的几条路

如果你要排毕业论文，国标有两种：顺序编码制（`gb-7714-2015-numeric`）和著者出版年制（`gb-7714-2015-author-date`，我用它编译过 `/tmp/p10/t1.typ`，正文引用变成 `(Strang, 2023)` 与 `(Golub 等, 2013)`）。学校要求哪个就选哪个；学校的细则与内置样式不一致时，轮到 CSL 文件出场：在样式仓库里找最接近的一个，拷下来保留许可证头，再改你要动的 `<macro>`。如果数据已经躺在 Zotero 里，导出 `.bib` 直接用。如果你想在文档里读某条文献的某个字段（比如在页脚打印书名），`bibliography` 不是为这件事设计的，那得回到下一篇的数据加载。

`make ch10` 通过时 6 个文件各输出一行 `ok`，没有 `*.fail.typ`，所以这一章的“失败演示”（`@nokey`、重复键、未知样式名）都是我在 `/tmp/p10` 里做的，仓库里没有对应文件。下一篇换个方向，用一份 YAML 生成中英文两版简历：[第 11 篇](/posts/typst-by-xuan-11-data-driven-cv/)。
