---
title: "生态：Typst Universe 与第三方包"
commentId: "post:typst-by-xuan-14-packages-ecosystem"
published: "2026-10-19 21:00:00 +08:00"
description: "用 Xuan 从零学 Typst 第 14 篇：我用 Typst 0.15.1 在空的 --package-cache-path 下编译 CeTZ 与 Lilaq 的图，量出首次下载约 11.1 秒、缓存命中后 51.6 毫秒，列出下载后缓存里的 8 个包，再把 examples/slides 的三页用 Touying 重写，数出 31 行对 28 行，最后把一个玩具包装成 @local 包并用 typst init 展开模板。"
category: Tutorial
tags:
  - Typst
  - Xuan
  - 包管理
  - CeTZ
  - Touying
series: "用 Xuan 从零学 Typst"
seriesOrder: 14
draft: false
comment: true
slug: typst-by-xuan-14-packages-ecosystem
---

前十三篇里，`xuan` 的每一行都是我自己写的，连幻灯片和作业都是。这一篇我要看看别人写的包：`import "@preview/cetz:0.5.2"` 这一行执行时，Typst 到底做了什么，下载了哪些文件，放在哪里，第二次为什么不再联网，以及“版本写死在导入字符串里”究竟保护了我什么。我顺手用 CeTZ 画了编译流水线图，用 Lilaq 画了一条阻尼振荡曲线，还把 `examples/slides` 里的三页用 Touying 重写了一遍，结果发现它并不比我自己的 `xuan` 更短。

> [!NOTE] 本篇检查点
> 这一篇不新增 `xuan` 的源文件，`lib.typ` 仍是第 4 篇的**中间版本**，`src/base.typ`、`src/note.typ` 这一章没有改动（它们分别在第 9、10 篇之后才是最终版）。你会新得到 `lab/ch14/` 下的 4 个入口（`fig-cetz.typ`、`fig-lilaq.typ`、`import-preview.typ`、`manifest/main.typ`）、`lab/ch14/extra.sh`，以及 `examples/ecosystem/` 下的 `main.typ`、`touying.typ` 和 `data/damped.csv`。`make ch14` 全部通过；它需要联网（首次运行会下载 8 个包）。
> 前置：[第 13 篇](/posts/typst-by-xuan-13-slides-and-drawing/)（幻灯片与绘图）。这一篇会把第 13 篇的 `examples/slides` 当作对照，把第 4 篇的“包目录布局”和 `--package-path` 补完，第 12 篇的 `import` 语法默认你已经会了。

## 第一次导入：11.1 秒与 52 毫秒

先看一个最小的例子，`lab/ch14/import-preview.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch14/import-preview.typ)）：

```typst
// `@preview` imports download the package on first use, then hit the cache.
#import "@preview/cetz:0.5.2": canvas, draw

#canvas(length: 1cm, {
  draw.circle((0, 0), radius: 0.6, fill: rgb("#cfe0f5"), name: "a")
  draw.circle((3, 0), radius: 0.6, fill: rgb("#f5d9cf"), name: "b")
  draw.line("a.east", "b.west", mark: (end: ">"))
})

// The version is part of the import: a new release never changes this file.
```

没有任何 `pip install` 之类的前置步骤。我把缓存目录指到一个不存在的 `/tmp/pc14`，让这次编译成为真正的“第一次”：

```text
$ rm -rf /tmp/pc14
$ time typst compile --root . --ignore-system-fonts --package-cache-path /tmp/pc14 lab/ch14/import-preview.typ /tmp/ip.pdf
downloading @preview/cetz:0.5.2
downloading @preview/oxifmt:1.0.0

real	0m8.398s
```

（终端里还有一条随下载刷新的进度条，我省略了。）注意有两行 `downloading`：我只导入了 CeTZ，但它自己又导入了 `oxifmt`，Typst 顺着依赖一并拉了下来。依赖不需要我声明，也没有锁文件，因为每个包的导入字符串里都已经写死了版本。

冷启动和热启动的差距要用 hyperfine 量。冷的那一组每次运行前删掉缓存目录，所以每次都要下载：

```text
$ hyperfine -N --warmup 0 --runs 5 --prepare "rm -rf /tmp/pc14" "typst compile --root . --ignore-system-fonts --package-cache-path /tmp/pc14 lab/ch14/import-preview.typ /tmp/ip.pdf"
  Time (mean ± σ):     11.106 s ±  3.311 s    [User: 0.107 s, System: 0.024 s]
  Range (min … max):    5.831 s … 14.515 s    5 runs
```

热的那一组先编译一次填好缓存，再用 `--warmup 2` 预热，命令完全相同：

```text
$ hyperfine -N --warmup 2 "typst compile --root . --ignore-system-fonts --package-cache-path /tmp/pc14 lab/ch14/import-preview.typ /tmp/ip.pdf"
  Time (mean ± σ):      51.6 ms ±   6.1 ms    [User: 40.0 ms, System: 13.7 ms]
  Range (min … max):    46.6 ms …  70.5 ms    43 runs
```

11.106 s 对 51.6 ms，约 215 倍。但这个比值不能当成 Typst 的性能数字：冷启动的 `User` 只有 0.107 s，剩下全是等网络，5.8 到 14.5 秒的跨度也是网络抖出来的（我的网络，你的会不一样）。这里真正要记住的结论只有一个：**下载只发生一次，之后包就是磁盘上的一个目录**。

## 缓存里到底有什么

我用一个新的空目录 `/tmp/pc14b` 编译 `examples/ecosystem/main.typ`（CeTZ 加 Lilaq），再编译 `examples/ecosystem/touying.typ`，两条命令都带 `--package-cache-path /tmp/pc14b`：

```text
$ typst compile --root . --ignore-system-fonts --package-cache-path /tmp/pc14b examples/ecosystem/main.typ /tmp/eco.pdf
downloading @preview/cetz:0.5.2
downloading @preview/oxifmt:1.0.0
downloading @preview/lilaq:0.6.0
downloading @preview/elembic:1.1.1
downloading @preview/zero:0.6.1
downloading @preview/tiptoe:0.4.0
$ typst compile --root . --ignore-system-fonts --package-cache-path /tmp/pc14b examples/ecosystem/touying.typ /tmp/tou.pdf
downloading @preview/touying:0.8.0
downloading @preview/uniwarn:0.1.1
```

三个“我写在源码里”的包（`cetz`、`lilaq`、`touying`），加上五个“它们自己引入的”，一共 8 个。缓存的结构是 `<命名空间>/<名字>/<版本>`：

```text
$ cd /tmp/pc14b && ls -d preview/*/* && du -sh . && du -s preview/*/* | sort -rn && find . -type f | wc -l
preview/cetz/0.5.2
preview/elembic/1.1.1
preview/lilaq/0.6.0
preview/oxifmt/1.0.0
preview/tiptoe/0.4.0
preview/touying/0.8.0
preview/uniwarn/0.1.1
preview/zero/0.6.1
3.5M	.
1360	preview/touying/0.8.0
796	preview/cetz/0.5.2
596	preview/lilaq/0.6.0
376	preview/elembic/1.1.1
128	preview/zero/0.6.1
100	preview/tiptoe/0.4.0
88	preview/oxifmt/1.0.0
28	preview/uniwarn/0.1.1
214
```

3.5 MiB，214 个文件，8 个包（`du -s` 的单位是 1 KiB 块）。`touying` 占的空间最大，1360 KiB，其次是 `cetz` 的 796 KiB。

再看一个包的里面。前面 `/tmp/pc14` 里的 `cetz/0.5.2`：

```text
/tmp/pc14/preview/cetz/0.5.2/cetz-core
/tmp/pc14/preview/cetz/0.5.2/cetz-core/cetz_core.wasm
/tmp/pc14/preview/cetz/0.5.2/gallery
/tmp/pc14/preview/cetz/0.5.2/LICENSE
/tmp/pc14/preview/cetz/0.5.2/README.md
/tmp/pc14/preview/cetz/0.5.2/src
/tmp/pc14/preview/cetz/0.5.2/typst.toml
```

一个包就是一个普通文件夹：`typst.toml` 是清单，`src/` 是代码，外加许可证和说明。有意思的是 `cetz-core/cetz_core.wasm`：CeTZ 0.5.2 自带一个 WebAssembly 文件，也就是说我下一篇要自己写的东西（`plugin`），已经在你每天用的包里悄悄运行了。（我没有去读 CeTZ 用它做什么，别把这一句当成对它实现的判断。）

缓存放在哪里，由系统决定。我这台 Linux 上是 `~/.cache/typst/packages/`，`typst compile --help` 说 `--package-cache-path` 的默认值是“system-dependent location”，也可以用环境变量 `TYPST_PACKAGE_CACHE_PATH` 设置。上面所有实验我都用 `--package-cache-path` 指向 `/tmp`，原因很简单：这样我可以随时 `rm -rf` 而不碰你机器上真正的缓存。仓库的 CI 没有缓存这个目录（`.github/workflows/ci.yml` 里没有任何 cache 步骤），每次都从头下载，8 个包的体量下这是可以接受的。

`make ch14` 的 `extra.sh` 还会把你默认缓存目录里的包列成 `out/ch14/cache.txt`；那份清单里除了这 8 个还有什么，因机器而异，与这一章无关。

## 导入字符串的结构

`@preview/cetz:0.5.2` 由三段组成：`@命名空间/名字:版本`。三段缺一不可，我故意写错三次看 Typst 怎么说（以下三个文件都在 `/tmp/p14/` 里，不在仓库里，每个文件一行）：

```typst
#import "@preview/cetz": canvas
```

```text
error: package specification is missing version
  ┌─ nov2.typ:1:8
  │
1 │ #import "@preview/cetz": canvas
  │         ^^^^^^^^^^^^^^^
```

没有“默认取最新版”这回事。这是故意的：如果取最新版，同一份源文件今天和明年就可能编译出不同结果，一次包升级就足以让你一份旧文档的排版变掉。把版本写进导入字符串，源码本身就成了锁文件。（类比：这就像文献引用里必须写版次，“Strang《线性代数导论》”和“Strang《线性代数导论》第 6 版”指向的不是同一份文本。）

```typst
#import "@preview/cetz:9.9.9": canvas
```

```text
error: package found, but version 9.9.9 does not exist (latest is 0.5.2)
  ┌─ nover.typ:1:8
  │
1 │ #import "@preview/cetz:9.9.9": canvas
  │         ^^^^^^^^^^^^^^^^^^^^^
```

包名对、版本错，Typst 会去 Universe 的索引里查，并顺便告诉你最新是多少。2026 年 10 月 19 日这一天索引里 CeTZ 的最新版就是 0.5.2，这也是这一章写死的版本。

```typst
#import "@preview/nosuchpkg:0.1.0": x
```

```text
error: package not found (searched for @preview/nosuchpkg:0.1.0)
  ┌─ nopkg.typ:1:8
  │
1 │ #import "@preview/nosuchpkg:0.1.0": x
  │         ^^^^^^^^^^^^^^^^^^^^^^^^^^
```

至于命名空间，Typst 里有两个有实际意义的：`@preview` 是 Universe 上的公开包（对应缓存目录和网络下载），`@local` 是你自己机器上的包（不联网，下一节讲）。我也试了一个自己编的命名空间 `@foo/toy:0.1.0`，得到的是同一句 `package not found (searched for @foo/toy:0.1.0)`，没有更多提示。

## 清单 typst.toml：compiler 字段是怎么被检查的

每个包的根目录都有一份 `typst.toml`。先看我自己的 `xuan`（`packages/local/xuan/0.1.0/typst.toml`，全文）：

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

`[package]` 里每个字段的含义：

- `name`、`version`：包自己的名字和版本。我的所有包都按 `<名字>/<版本>/` 摆放目录，导入字符串里的名字、版本也是这样对应的。
- `entrypoint`：`#import "@local/xuan:0.1.0": *` 实际加载的文件，相对包根目录。CeTZ 是 `src/lib.typ`，Lilaq 是 `src/lilaq.typ`，Touying 是 `lib.typ`（我读了缓存里三个包的 `typst.toml`）。
- `compiler`：这个包要求的 Typst 最低版本。
- `authors`、`license`、`description`：元数据，说明作者、许可证和一句话介绍。

`compiler` 到底在什么时候检查？我用一个玩具包验证。`lab/ch14/manifest/` 是一个只有三个文件的包（[目录](https://github.com/bfmhno3/typst-lab/tree/tutorial-v1/lab/ch14/manifest)）。`typst.toml`：

```toml
# The manifest of a toy package. Compare packages/local/xuan/0.1.0/typst.toml.
[package]
name = "toy"
version = "0.1.0"
entrypoint = "lib.typ"
authors = ["bfmhno3"]
license = "MIT OR Apache-2.0"
description = "A toy package for the manifest demo"
compiler = "0.15.1"
```

`lib.typ`：

```typst
// The entrypoint named in typst.toml. Everything public is a top-level let.
#let greet(name) = [你好，#name。]
```

`main.typ` 是包内部自己测试用的，它直接 `#import "lib.typ": greet`，所以这个目录单独就能被 `make ch14` 当作一份文档编译。要作为 `@local/toy:0.1.0` 使用，必须把目录放到 `<包路径>/local/toy/0.1.0/`。`lab/ch14/extra.sh` 做的正是这件事：复制到 `out/ch14/pkgs/local/toy/0.1.0`，删掉 `main.typ`，再写一份 `use-toy.typ` 导入它：

```text
$ typst compile --root . --ignore-system-fonts --package-path out/ch14/pkgs out/ch14/use-toy.typ out/ch14/use-toy.pdf
```

`make ch14` 的输出里有一行 `ok   @local/toy:0.1.0 via --package-path out/ch14/pkgs`，说明导入成功。

然后我在 `/tmp/p14/` 里把那份清单的 `compiler` 改成 `"0.16.0"`（只改副本，不动仓库），再导入：

```text
error: package requires Typst 0.16.0 or newer (current version is 0.15.1)
  ┌─ toy.typ:1:8
  │
1 │ #import "@local/toy:0.1.0": greet
  │         ^^^^^^^^^^^^^^^^^^
```

所以：`compiler` 是导入时检查的下限，不是编译到某个函数时才发现它不存在。这对你选包很有用：我用到的三个包要求的下限分别是 CeTZ 0.14.0、Lilaq 0.13.0、Touying 0.15.0（读自缓存里的 `typst.toml`），都不超过我的 0.15.1，所以全部能编译。Touying 的 0.15.0 是最紧的一个：按同样的机制，在 0.14 的编译器上导入它应该会在导入这一行报上面那样的错（我没有装 0.14 去验证）。

`[template]` 小节让这个包可以被 `typst init` 展开成一个起始项目。我在 `/tmp/p14/pk3/local/toy/0.1.0/` 里给玩具包加了 `template/main.typ` 和这一节（仍然不在仓库里）：

```toml
[template]
path = "template"
entrypoint = "main.typ"
```

```text
$ typst init --package-path pk3 @local/toy:0.1.0 ti2
$ ls ti2
main.typ
$ cat ti2/main.typ
#import "@local/toy:0.1.0": greet
#greet("模板")
```

（`typst init` 成功时还会打印几行提示语，我没有贴，那一行里有一个 emoji。）它把 `template/` 目录里的文件复制到新目录，模板文件里仍然写着 `@local/toy:0.1.0`，所以展开出来的项目不是一份自包含的拷贝，而是依赖这个包。Touying 没有 `[template]`，对它 `typst init` 得到的是 `error: package @preview/touying:0.8.0 is not a template`。`xuan` 的模板是第 16 篇的内容。

## @local 与 --package-path

`@local` 包没有索引也不联网，Typst 只会去磁盘上的包目录里找。我先用 `--package-path` 的“找不到”报错确认这一点：

```text
error: package not found (searched for @local/toy:0.1.0)
  ┌─ nolocal.typ:1:8
  │
1 │ #import "@local/toy:0.1.0": greet
  │         ^^^^^^^^^^^^^^^^^^
```

（那次编译没有设 `TYPST_PACKAGE_PATH`，也没有 `--package-path`，所以找不到。）

包目录的约定是 `<包路径>/<命名空间>/<名字>/<版本>/typst.toml`。有两种告诉 Typst 包路径的办法：

- `--package-path <DIR>` 或环境变量 `TYPST_PACKAGE_PATH`。仓库的 `flake.nix` 在 `shellHook` 里导出了 `TYPST_PACKAGE_PATH="$PWD/packages"`，这就是 `xuan` 在 `nix develop` 里什么都不装就能用的原因。
- 默认位置。我用 `XDG_DATA_HOME=/tmp/p14/xdg` 和一个符号链接 `xdg/typst/packages/local/toy -> /tmp/p14/pk/local/toy` 验证了默认位置在 `$XDG_DATA_HOME/typst/packages` 之下；命令里 `env -u TYPST_PACKAGE_PATH` 清掉了环境变量，编译输出的文字是 `你好，x。`。没有设 `XDG_DATA_HOME` 时，我猜是 `~/.local/share/typst/packages`（Linux 的惯例，我没有单独验证这一情形）。`make install` 做的就是这件事：把仓库里的 `packages/local/xuan` 链接到 `~/.local/share/typst/packages/local/xuan`，这样不进 `nix develop` 也能导入 `@local/xuan:0.1.0`。

还有一个事实容易被忽略：`--package-path` 不限于 `@local`，任何命名空间都先找这里。我在 `/tmp/p14/pk2/preview/zzdemo/1.0.0/` 里写了一个 `@preview/zzdemo:1.0.0`（Universe 上并没有这个包），导入它：

```typst
#import "@preview/zzdemo:1.0.0": hi
#hi
```

不带 `--package-path` 时得到 `error: package not found (searched for @preview/zzdemo:1.0.0)`；带上 `--package-path pk2`，同一份文件编译通过，`pdftotext` 读出 `from package path`。

这个特性在离线环境里很好用：把需要的 `@preview` 包预先放进一个目录，提交进仓库或打进镜像，编译就不依赖网络。（我没有在断网环境里实测这一点，上面只证明了“包路径先于下载”这一半。）

## CeTZ 与 Lilaq：画图的两种思路

第 13 篇用内置的 `rect`、`line` 画过图，那是“按坐标摆形状”。CeTZ 是它的升级：有命名锚点，可以写 `a.east` 这样的位置。`lab/ch14/fig-cetz.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch14/fig-cetz.typ)，全文 28 行）：

```typst
// CeTZ: the compile pipeline as boxes and arrows.
#import "@preview/cetz:0.5.2": canvas, draw
#import "@local/xuan:0.1.0": fonts

#set page(width: auto, height: auto, margin: 12pt)
#set text(font: fonts.sans, size: 9pt, lang: "zh")

#let stage(x, name, label) = {
  draw.rect(
    (x - 1, -0.6),
    (x + 1, 0.6),
    name: name,
    fill: rgb("#cfe0f5"),
    stroke: 0.8pt + rgb("#1f4e9c"),
    radius: 0.15,
  )
  draw.content(name, label)
}

#canvas({
  stage(0, "parse", [解析])
  stage(3.2, "eval", [求值])
  stage(6.4, "layout", [排版])
  stage(9.6, "export", [导出])
  for (a, b) in (("parse", "eval"), ("eval", "layout"), ("layout", "export")) {
    draw.line(a + ".east", b + ".west", mark: (end: ">"))
  }
})
```

![CeTZ 画的编译流水线：四个浅蓝色圆角方框依次写着解析、求值、排版、导出，相邻方框之间有从左指向右的箭头](/assets/images/typst-by-xuan/ch14-cetz.png)

三点值得讲。第一，`canvas({ ... })` 的参数是一个**代码块**，里面不是 content 而是一串 `draw.*` 调用，每个调用返回的是“绘图指令”，由 `canvas` 统一执行；这和第 3 篇讲的“函数返回 content”不同，它是 CeTZ 自己的一层小语言。第二，`name: name` 给矩形起了名字，后面 `draw.content(name, label)` 把文字放在那个名字的中心，`draw.line(a + ".east", ...)` 用的是名字加锚点，不用算坐标，加一个阶段只需要多写一行 `stage(...)`。第三，`for (a, b) in (...)` 是第 2 篇的解构，直接用在了画图的循环上。

`#import "@local/xuan:0.1.0": fonts` 是为了字体名不重复写：这里 `fonts.sans` 就是第 5 篇的 `Noto Sans CJK SC`。包和包之间可以随便混用，`@preview` 的 CeTZ 和 `@local` 的 `xuan` 在同一份文件里互不干扰。

Lilaq 的思路则是“数据在前”，`lab/ch14/fig-lilaq.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch14/fig-lilaq.typ)，全文 21 行）：

```typst
// Lilaq: plot the CSV that examples/ecosystem ships.
#import "@preview/lilaq:0.6.0" as lq
#import "@local/xuan:0.1.0": fonts

#set page(width: auto, height: auto, margin: 12pt)
#set text(font: fonts.serif, size: 9pt)

#let rows = csv("/examples/ecosystem/data/damped.csv", row-type: dictionary)

#lq.diagram(
  width: 9cm,
  height: 4.5cm,
  xlabel: $t$,
  ylabel: $y$,
  lq.plot(
    rows.map(r => float(r.t)),
    rows.map(r => float(r.y)),
    mark: none,
    stroke: 1.2pt + rgb("#1f4e9c"),
  ),
)
```

![Lilaq 画的曲线：横轴 t 从 0 到 10，纵轴 y 在 1 与负 0.6 之间振荡，振幅逐渐衰减的阻尼余弦曲线，带网格](/assets/images/typst-by-xuan/ch14-lilaq.png)

数据来自 `data/damped.csv`（201 行，$y = e^{-0.3t}\cos 2t$，第 11 篇的 `csv(..., row-type: dictionary)` 加上第 2 篇的 `map`）。这里路径是 `"/examples/ecosystem/data/damped.csv"`，以 `/` 开头，相对 `--root .`，因为 `lab/ch14/` 离 `examples/` 隔了好几层；`examples/ecosystem/main.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/examples/ecosystem/main.typ)，48 行，里面同时用 CeTZ 和 Lilaq 画了这两张图）则和数据同在一个目录树里，直接写相对路径 `data/damped.csv`。`import ... as lq` 与 `import ...: canvas, draw` 是第 12 篇讲的两种导入形式，这里一个包各用了一种：CeTZ 的名字只有两个，直接导入；Lilaq 的名字多且容易和别处撞，留在 `lq.` 前缀后面。

这份文档热缓存下的编译时间：`hyperfine -N --warmup 2 "typst compile --root . --ignore-system-fonts examples/ecosystem/main.typ /tmp/eco.pdf"`，543.3 ms ± 65.1 ms。比第一节里只导入 CeTZ 的 51.6 ms 慢了十倍，原因我没有拆开量，大概是 Lilaq 的包体量和求值开销，别当成结论。

## Touying：包不一定更短

第 13 篇的 `slides` 是我自己写的，95 行。Touying 是 Universe 上成熟的幻灯片包。我想知道的是：用它重写同样的内容，我能省下多少？`examples/ecosystem/touying.typ`（[源文件](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/examples/ecosystem/touying.typ)，全文）：

```typst
// Three slides of examples/slides, rebuilt with Touying.
#import "@preview/touying:0.8.0": *
#import themes.simple: *
#import "@local/xuan:0.1.0": fonts

#set text(font: fonts.sans, lang: "zh")
#show: simple-theme.with(aspect-ratio: "16-9")

= Typst 一小时入门

== 三种模式

- 标记模式：默认，写正文
- 代码模式：`#` 进入，写逻辑
- 数学模式：`$ ... $`，写公式

== 编译很快

编译一份 10 页文档：

#pause
- 解析：把标记变成语法树
#pause
- 求值：运行代码，得到 content
#pause
- 排版：多遍迭代，直到页码和引用稳定

== 一个公式

最小二乘的正规方程：
$ A^T A hat(x) = A^T b $
```

这里的结构和 `xuan` 完全不同：幻灯片不是 `#slide(...)[...]` 调用，而是由**标题级别**决定的：`=` 是章节，`==` 是一页，`#pause` 让后面的内容在下一个子页出现。这一切由 `#show: simple-theme.with(aspect-ratio: "16-9")` 驱动，也就是第 4 篇的 `show: template.with(...)` 形状，只是这个“模板”是整个包的主题。我猜它是用 show 规则读取标题来切页的，但我没有去读 Touying 的实现。

行数我用 `extra.sh` 数了，结果写进 `out/ch14/linecount.txt`：

```text
touying.typ        31 lines (3 slides)
examples/slides    28 lines (same 3 slides plus preamble)
examples/slides    99 lines (whole deck)
```

Touying 的 3 页是 31 行，我自己的 `xuan` 版本是 28 行：**Touying 更长**。第二行的 28 行由两部分组成：`examples/slides/main.typ` 到第一个 `=` 标题之前的 9 行前言（导入和 `slides.with(...)`），加上 `三种模式`、`编译很快`、`一个公式` 这三个 `#slide(...)` 块的 19 行（统计规则在 [`lab/ch14/extra.sh`](https://github.com/bfmhno3/typst-lab/blob/tutorial-v1/lab/ch14/extra.sh) 里的一段 awk）。

这个对比有几处不公平，我都列出来：

- 我的 `slides` 只做了我要的功能，而 Touying 的缓存目录里有 8 个主题文件（`themes/` 下的 aqua、article、default、dewdrop、metropolis、simple、stargazer、university），我只用了其中的 `simple`。比行数只比了一个维度。
- Touying 用标题切页，省掉了 `#slide(title: "...")[ ]` 的括号，但 `#pause` 单独占了 3 行，我的 `steps: 3, k => [...]` 把同样的事放在了函数里。
- 页数不同：Touying 编出 7 页（`pdfinfo out/ch14/touying.pdf`）。我数出来的构成是：标题页 1，三种模式 1，编译很快 4（3 个 `#pause` 切出 4 个子页，第一个子页只有那句引导语），公式 1。页脚显示 `2/4`、`3/4`、`4/4`，也就是“第几张幻灯片”，同一张幻灯片的子页共用一个编号，而不是页码。
- 体量：缓存里 Touying 占 1360 KiB，我的 `src/slides.typ` 是 95 行。当然我的版本只在我自己的文档里工作。

如果我只想要一份自己的幻灯片，自己写的 95 行够用；如果要换主题、做动画，Touying 把这些工作做完了。这个选择不是“包比自己写好”，而是“谁来维护这部分代码”。我猜多数日常场景下，自己写 100 行比读懂别人的 1360 KiB 更省事，但我没有做任何用户研究，这只是我的偏好。

`touying.typ` 热缓存编译 197.1 ms ± 15.6 ms（`hyperfine -N --warmup 2 "typst compile --root . --ignore-system-fonts examples/ecosystem/touying.typ /tmp/tou.pdf"`）。

## 版本，固定在哪里

回头看这一章用到的所有版本：`cetz:0.5.2`、`lilaq:0.6.0`、`touying:0.8.0`，全部写在 `import` 字符串里，没有别的地方。要升级只改那一行；不改，源码就永远指向同一份包代码，缓存目录里的 `preview/cetz/0.5.2/` 也不会被覆盖（版本在路径里，新版本是另一个目录）。对一个会发表、会交作业、会隔几年再打开的文档，这是我想要的行为。

下一篇我写自己的包里最“重”的一块：用 Rust 编译一个 WebAssembly 文件，放进 `xuan` 的 `plugin/` 目录，让术语表按拼音排序。你刚才在 `cetz-core/cetz_core.wasm` 里见过它的同类。
