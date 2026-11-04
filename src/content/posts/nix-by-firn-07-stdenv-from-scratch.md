---
title: "从零写 stdenv，再拆开 nixpkgs 的 stdenv"
commentId: "post:nix-by-firn-07-stdenv-from-scratch"
published: "2026-11-04 22:00:00 +08:00"
description: "用 Firn 从零学 Nix 第 7 篇：我用 Nix 2.34.9 写了一个 63 行 setup.sh 的 mini stdenv 和五个包，hello 的闭包只有 1,496,288 字节；再对照 nixpkgs 1839 行的 setup.sh，数出 stdenv 的 572 个 .drv，它们的根是一个 229 字节的 hex0 种子。"
category: Tutorial
tags:
  - Nix
  - NixOS
  - Firn
  - stdenv
  - bootstrap
  - 包集合
series: "用 Firn 从零学 Nix"
seriesOrder: 7
draft: false
comment: true
slug: nix-by-firn-07-stdenv-from-scratch
---

第 6 篇我手写的 `raw` 包只有一个 busybox 加一行 `sh`，写到第三个就开始重复：设 `PATH`、`mkdir -p $out/bin`、把脚本里的 `#!/bin/sh` 换成绝对路径。这一篇我把重复抽出来，写一个 29 行的 `mkDerivation` 和一个 63 行的 `setup.sh`，用它们写五个包，然后拿 nixpkgs 里那份 1839 行的 `setup.sh` 对照着读。先看结果，mini 包集里的 `hello`：

```text
$ grep -A3 '^== hello' out/ch07/mini_build.stdout
== hello: /nix/store/idksigadaj3inqj8kyl5gajvyxmlzbi5-hello
/nix/store/8mid8wh1kxb0gl4g6s9l3bwawd9xzfkj-busybox-static-x86_64-unknown-linux-musl-1.37.0	    1495056
/nix/store/d76bjdvj1ppdyyj6x1plf7nb0dij1g2g-greeting	        472
/nix/store/idksigadaj3inqj8kyl5gajvyxmlzbi5-hello	    1496288
```

闭包 3 个路径、1,496,288 字节。第 6 篇里锁定版 nixpkgs 的 `hello` 是 5 个路径、37,997,512 字节，是它的 25.4 倍，差别几乎全在 glibc。这一篇的主线有两条：先从零长出一个 stdenv（phases、`setup.sh`、`callPackage`、能被 overlay 改写的包集），再回头读真的 stdenv，看它的阶段表、setup hook、九种依赖分类和多输出，最后问一个我一直没想过的问题：这个 stdenv 本身是谁编译出来的。

> [!NOTE] 本篇检查点
> 这一篇结束时，Firn 仓库的标签 `ch07` 里新增：`mini/stdenv/default.nix`(29 行)、`mini/stdenv/setup.sh`(63 行)、`mini/default.nix`(25 行)、`mini/pkgs/` 下五个包(`greeting`、`hello`、`wordfreq`、`cairn-src`、`site`)和 `mini/pkgs/site/index.md`；`flake.nix` 多了 `legacyPackages.<system>.mini` 和 `checks.<system>.mini-site`；`lab/ch07/` 下有 15 个实验，没有 fixture。`make ch07` 通过，`make lint` 和 `make check` 干净。`mini/stdenv/` 和 `mini/pkgs/` 里已有的五个包这一篇是最终形态；`mini/default.nix` 第 20 篇会再加一个 `nondeterministic` 包；`flake.nix` 第 8 篇会重排。
> 涉及的 Nix 特性：derivation 属性到环境变量的转换、`builtins.functionArgs`、`builtins.intersectAttrs`、`builtins.derivation` 的 `builder` 和 `args`、`<nix/fetchurl.nix>`、`nix log`、`nix print-dev-env`、`nix develop`、多输出 derivation。
> 前置：[第 6 篇：derivation 与 /nix/store](/posts/nix-by-firn-06-derivations-and-store/)。`mini/seed.nix` 和 `mini/raw.nix` 来自那一篇，这一篇不改它们。第 3 篇的 `fix`、`extends`、`makeExtensible` 会在“包集合是一个不动点”一节回来。

环境照旧：NixOS 26.05，Nix 2.34.9，锁定的 nixpkgs 是 `56c02bc00adcf003215cc4bd996d6efaf4cff188`。引用 nixpkgs 源码时行号都是这个提交上的，引用 Nix 源码时用的是 2.34.9 标签的行号。

## raw 到第三个包就烦了

回头看 [`mini/raw.nix`](https://github.com/bfmhno3/firn/blob/ch07/mini/raw.nix)，它只有 12 行：一个名字，一段脚本，`builder` 是 busybox 的 `sh`，`PATH` 是 busybox 的 `bin`。每个包都要自己做这几件事：

- 把依赖的 `bin` 目录接到 `PATH` 上；
- `mkdir -p "$out"`，因为 Nix 只告诉你输出路径，不替你建；
- 如果有源码，解开它并 `cd` 进去；
- 装完之后把脚本里的解释器路径改成 store 里的绝对路径。

这四件事和具体的包无关。把它们放进一份所有包共用的脚本，每个包只剩下“我的源码是什么、我的构建命令是什么、我的安装命令是什么”，这就是 stdenv 在做的事。这里值得停一下，想想“每个包只剩下差异”在 Nix 里怎么实现：差异只能通过 `derivation` 的属性传进去，而属性在构建时只有一种形态，就是环境变量。Nix 手册在[derivation 一章](https://nix.dev/manual/nix/2.34/language/derivations.html)里写得很明白：除了 `name`、`system`、`builder`、`args`、`outputs` 这些有特殊含义的，“Every other attribute is passed as an environment variable to the builder”，字符串原样传，store 路径展开成路径，列表用空格连起来，`true` 是 `1`，`false` 和 `null` 是空字符串（源文件 `doc/manual/source/language/derivations.md` 的 213 到 235 行）。

所以 stdenv 的骨架就是：包的差异是一组环境变量，builder 是共用的脚本，脚本按约定的名字(`buildPhase`、`installPhase`)去读这些变量。接下来我就这么写。

## mkDerivation：29 行

[`mini/stdenv/default.nix`](https://github.com/bfmhno3/firn/blob/ch07/mini/stdenv/default.nix) 整个文件：

```nix
# 最小的 stdenv：一个 mkDerivation，把 setup.sh 当作所有包共用的 builder。
{ busybox, system }:
{
  mkDerivation =
    {
      name,
      src ? null,
      buildInputs ? [ ],
      buildPhase ? "",
      installPhase ? "",
      ...
    }@args:
    derivation (
      removeAttrs args [ "src" ]
      // {
        inherit
          name
          system
          busybox
          buildInputs
          buildPhase
          installPhase
          ;
        builder = "${busybox}/bin/sh";
        args = [ ./setup.sh ];
      }
      // (if src == null then { } else { inherit src; })
    );
}
```

逐段看。参数是一个带 `...` 的 pattern，再用 `@args` 绑定整个 attrset（第 3 篇的内容）。`name` 必须有，其余有默认值。`...` 让包可以传任意额外的属性，它们会原样进 `removeAttrs args [ "src" ]` 然后进 derivation，也就是进环境变量。`greeting` 包里的 `text` 就是这么到达 `setup.sh` 的，下面会看到。

`src` 单独处理：只有非 `null` 才加进 derivation。按手册的规则，`null` 会变成空字符串的环境变量，那样 `.drv` 里会多一个空的 `src`；不传，`.drv` 里就干净。`setup.sh` 里对应的判断是 `[ -n "${src:-}" ]`。

`builder = "${busybox}/bin/sh"` 和 `args = [ ./setup.sh ]` 是整件事的核心：**所有包的 builder 是同一个 shell，同一个脚本**。`./setup.sh` 是个路径字面量，求值时被复制进 store，成为每个包的输入源文件。`inherit ... busybox` 让 busybox 的 store 路径作为环境变量 `busybox` 传给脚本，同时（字符串上下文，第 4 篇）把它登记成输入依赖。

mini 和 nixpkgs 的 `mkDerivation` 在这里的差别我先记一笔：nixpkgs 的参数是 `pname` 加 `version`，`system` 取自 `buildPlatform`，`builder` 是 stdenv 里那个 bash。结构一样：把包的属性变成 derivation 属性，再附上 `builder` 和 `args`。后面读 `make-derivation.nix` 时能看到对应的行。

我想直接看看这个函数交给 Nix 的东西。`lab/ch07/mini_drv_env.sh` 对 mini 的 `hello` 跑 `nix derivation show`，用 `jq` 只留 `system`、`builder`、`args` 和四个环境变量：

```text
$ cat out/ch07/mini_drv_env.stdout
{
  "system": "x86_64-linux",
  "builder": "/nix/store/8mid8wh1kxb0gl4g6s9l3bwawd9xzfkj-busybox-static-x86_64-unknown-linux-musl-1.37.0/bin/sh",
  "args": [
    "/nix/store/vfiirv54ls5pnc2qq42a41xslndpph8r-setup.sh"
  ],
  "env": {
    "buildInputs": "",
    "busybox": "/nix/store/8mid8wh1kxb0gl4g6s9l3bwawd9xzfkj-busybox-static-x86_64-unknown-linux-musl-1.37.0",
    "installPhase": "mkdir -p \"$out/bin\"\nprintf '%s\\n' '#!/bin/sh' '/nix/store/8mid8wh1kxb0gl4g6s9l3bwawd9xzfkj-busybox-static-x86_64-unknown-linux-musl-1.37.0/bin/cat /nix/store/d76bjdvj1ppdyyj6x1plf7nb0dij1g2g-greeting/share/greeting.txt' \\\n  > \"$out/bin/hello\"\nchmod +x \"$out/bin/hello\"\n",
    "name": "hello"
  }
}
```

三个观察。`args` 里是 `setup.sh` 在 store 里的路径，说明 `./setup.sh` 确实被复制进了 store。`installPhase` 是一个多行字符串，里面的 `${busybox}` 和 `${greeting}` 已经被替换成了绝对的 store 路径，这是引用扫描（第 6 篇）之后 hello 的闭包里有这两个路径的原因。`buildInputs` 是空字符串：`hello` 没有声明 `buildInputs`，它靠字符串插值直接引用 `greeting`，不靠 `buildInputs`。这是一个很容易搞混的区别，后面讲闭包时还会回来。

## setup.sh：63 行

[`mini/stdenv/setup.sh`](https://github.com/bfmhno3/firn/blob/ch07/mini/stdenv/setup.sh) 是 POSIX sh，由 busybox 的 `sh` 执行。我只引用要紧的部分。开头设 `PATH`：

```sh
set -eu

PATH="${busybox}/bin"
# shellcheck disable=SC2086 # 按空格拆开是故意的
for dep in ${buildInputs}; do
  PATH="${dep}/bin:${PATH}"
done
export PATH
```

`${buildInputs}` 在这里已经是 Nix 传进来的环境变量，是用空格连起来的 store 路径列表（手册规则里“列表用空格连起来”），所以 `for dep in ${buildInputs}` 不加引号，按空格拆开。这就是 nixpkgs 里那一大套依赖处理在 mini 里的全部：一个循环，把每个依赖的 `bin` 放到 `PATH` 最前面。

然后是整个脚本的发动机，`run_phase` 和主循环：

```sh
# 运行一个阶段：环境里有 <name>Phase 就写成文件再用 . 载入，
# 没有就用默认实现（有的话）。
run_phase() {
  echo "== phase $1"
  if printenv "$1Phase" >/dev/null 2>&1; then
    printenv "$1Phase" >"${TMPDIR}/phase-$1.sh"
    # shellcheck disable=SC1090 # 阶段文件在运行时才生成
    . "${TMPDIR}/phase-$1.sh"
  elif [ "$1" = unpack ] && [ -n "${src:-}" ]; then
    default_unpack
  elif [ "$1" = fixup ]; then
    default_fixup
  fi
}

mkdir -p "${out}"
for phase in unpack patch build install fixup; do
  run_phase "${phase}"
done
```

每个阶段先打印一行 `== phase <name>`，然后三选一：环境变量 `<name>Phase` 存在就执行它；否则 `unpack` 在有 `src` 时走默认实现；`fixup` 总是走默认实现；`patch`、`build`、`install` 没有默认，什么也不做。

为什么用 `printenv "$1Phase"`？阶段名是运行时拼出来的（`buildPhase` 这个变量名由 `$1` 加 `Phase` 拼成），要按名字取变量的值，需要“间接展开”。bash 有 `${!name}`，但这是 bash 的扩展，POSIX 没有定义，而 mini 的 `setup.sh` 要在 busybox 的 `sh` 下跑，所以我借 `printenv` 绕过去：让一个外部程序按名字取环境变量。nixpkgs 的 `setup.sh` 是 bash，直接写 `eval "${!curPhase:-$curPhase}"`，后面会看到那一行。

写成文件再用 `.` 载入而不是在子 shell 里跑，是因为我要阶段之间共享当前目录：`unpack` 阶段 `cd` 进源码目录，后面的 `build`、`install` 都在那里执行。`.` 在当前 shell 里执行文件，所以 `cd` 持续有效（对照：[Cairn 第 1 篇](/posts/shell-by-cairn-01-first-script/)练习 4 里 `source` 和 `bash ./f` 的区别，同一个道理）。`set -eu` 因此也对阶段里的每一行生效：任何一条命令失败，整个构建失败。

默认的 `unpack` 和 `fixup`：

```sh
# 默认 unpack：目录原样复制，压缩包解开；然后进入源码目录。
default_unpack() {
  mkdir -p "${TMPDIR}/source"
  cd "${TMPDIR}/source"
  if [ -d "${src}" ]; then
    cp -r "${src}/." .
    chmod -R u+w .
  else
    tar xf "${src}"
    # 压缩包只有一个顶层目录时进入它。
    set -- ./*
    if [ "$#" -eq 1 ] && [ -d "$1" ]; then
      cd "$1"
    fi
  fi
}
```

`src` 如果是目录（比如 `site` 的 `./site`），就复制过来再 `chmod -R u+w`，因为 store 里的东西是只读的，复制之后权限位还在，不加写权限后面没法改。如果是文件就 `tar xf`，并且在压缩包只有一个顶层目录时进去，GitHub 的源码包就是这个形状。`default_fixup` 只做一件事，把 `$out/bin` 里每个脚本第一行的 `#!/bin/sh` 或 `#!/usr/bin/env sh` 换成 `#!${busybox}/bin/sh`，是 nixpkgs 里 `patchShebangs` 的一个极小的替身。

写到这里，mini 的 stdenv 就完整了：29 行加 63 行，没有 `configure`，没有 `check`，没有 hook，没有多输出，没有依赖的分类。这些东西 nixpkgs 都有，下面会逐个读到。

## 五个包

`mini/pkgs/` 下的五个包，复杂度递增。最小的是 [`greeting.nix`](https://github.com/bfmhno3/firn/blob/ch07/mini/pkgs/greeting.nix)：

```nix
{
  mkDerivation,
  text ? "Hello from mini",
}:
mkDerivation {
  name = "greeting";
  inherit text;
  installPhase = ''
    mkdir -p "$out/share"
    printf '%s\n' "$text" > "$out/share/greeting.txt"
  '';
}
```

`text` 是个额外属性，经 `...` 进了 derivation，在构建里就是环境变量 `$text`。`''...''` 里的 `$out` 和 `$text` 是 shell 变量，不是 Nix 插值（Nix 的插值是 `${...}`），所以 Nix 不动它们，原样写进 `installPhase`。然后是 [`hello.nix`](https://github.com/bfmhno3/firn/blob/ch07/mini/pkgs/hello.nix)：

```nix
{
  mkDerivation,
  busybox,
  greeting,
}:
mkDerivation {
  name = "hello";
  installPhase = ''
    mkdir -p "$out/bin"
    printf '%s\n' '#!/bin/sh' '${busybox}/bin/cat ${greeting}/share/greeting.txt' \
      > "$out/bin/hello"
    chmod +x "$out/bin/hello"
  '';
}
```

这里的 `${busybox}` 和 `${greeting}` 是 Nix 插值，求值时变成 store 路径写进脚本，所以生成的 `hello` 脚本是 `/nix/store/...-busybox-static.../bin/cat /nix/store/...-greeting/share/greeting.txt`。这两个路径出现在输出文件的内容里，正是引用扫描能找到的东西。

另外三个我只讲要点。[`wordfreq.nix`](https://github.com/bfmhno3/firn/blob/ch07/mini/pkgs/wordfreq.nix) 用一个带引号的 here-document 写出一个 `awk` 加 `sort` 的词频脚本，`wordfreq 5 < file` 打印前 5 个词。[`cairn-src.nix`](https://github.com/bfmhno3/firn/blob/ch07/mini/pkgs/cairn-src.nix) 的源码是个 `fetchurl`：

```nix
  src = fetchurl {
    url = "https://github.com/bfmhno3/cairn/archive/refs/tags/ch10.tar.gz";
    hash = "sha256-klYYGug+UKdeu0kHZ5o17A7CSIGSImy+3cipzH0ZeY8=";
  };
```

这个 `fetchurl` 是 mini 包集里的 `fetchurl = import <nix/fetchurl.nix>`。`<nix/fetchurl.nix>` 是个查找路径表达式：Nix 求值器的 `findFile` 先逐个查 `NIX_PATH` 里的条目，都没有命中，并且路径以 `nix/` 开头，才回退到内置的 `corepkgsFS`（[`src/libexpr/eval.cc` 3246 到 3269 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/eval.cc#L3246-L3269)），那里面的 `fetchurl.nix` 是编译进 Nix 二进制的。它的 builder 是 [`builtin:fetchurl`](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/fetchurl.nix#L42)，也就是 Nix 自己下载，不需要 curl，也不需要 busybox 有网络能力。这也是第 6 篇固定输出一节里的那种 derivation，下载的结果由 `hash` 钉死。

最后是 [`site.nix`](https://github.com/bfmhno3/firn/blob/ch07/mini/pkgs/site.nix)，它是唯一用 `buildInputs` 和 `buildPhase` 的：

```nix
mkDerivation {
  name = "site";
  src = ./site;
  buildInputs = [
    hello
    wordfreq
  ];
  buildPhase = ''
    hello > hello.txt
    wordfreq 5 < ${cairn-src}/share/cairn/README.md > words.txt
    awk '
    # ...
    ' index.md > index.html
  '';
  installPhase = ''
    install -D index.html "$out/index.html"
  '';
}
```

`hello` 和 `wordfreq` 在 `buildInputs` 里，所以 `setup.sh` 把它们的 `bin` 放进 `PATH`，`buildPhase` 里才能直接敲 `hello`。`cairn-src` 不在 `buildInputs` 里，因为它的 `bin` 不用上 `PATH`，只需要读它的文件，用 `${cairn-src}` 插值。`awk` 脚本把 `index.md` 里的 `# `、`## ` 转成 `<h1>`、`<h2>`，把 `@HELLO@` 和 `@WORDFREQ@` 换成两段 `<pre>`。`checks.<system>.mini-site` 检查的就是这个页面：

```nix
          # mini 的 site 能构建，页面里有 hello 的输出和词频表。
          mini-site = pkgs.runCommand "firn-mini-site" { } ''
            grep -q '<h1>Firn mini site</h1>' ${mini.site}/index.html
            grep -q 'Hello from mini' ${mini.site}/index.html
            grep -q '^[0-9]* cairn$' ${mini.site}/index.html
            echo ok > $out
          '';
```

注意这个检查本身用的是 nixpkgs 的 `runCommand`，不是 mini 的 stdenv：检查是 nixpkgs 的世界在审查 mini 的世界。`make check` 以 `all checks passed!` 结束，其中包含 `mini-site`。

## 每个闭包里只有 busybox 和 mini 自己

`lab/ch07/mini_build.sh` 构建 mini 的每个包，并用 `nix path-info -rS` 打印每个闭包。它还有一个检查：闭包里出现任何名字不是 `busybox-static-*` 或 mini 包名的路径，就以 1 退出。核心是这一段：

```bash
pattern='^/nix/store/[0-9a-z]{32}-(busybox-static-[^/]*|'
pattern+="$(printf '%s|' "${names[@]}")"
pattern="${pattern%|})\$"
readonly pattern

status=0
for name in "${names[@]}"; do
  out="$(nix build --no-link --print-out-paths "${mini}.${name}")"
  echo "== ${name}: ${out}"
  nix path-info -rS "${out}"
  while read -r path _; do
    if [[ ! "${path}" =~ ${pattern} ]]; then
      echo "unexpected path in closure of ${name}: ${path}" >&2
      status=1
    fi
  done < <(nix path-info -rS "${out}")
done
exit "${status}"
```

结果(`out/ch07/mini_build.stdout`)：

```text
== cairn-src: /nix/store/rngqninsh1w9bjxd5bgxgld8rnypjjdl-cairn-src
/nix/store/8mid8wh1kxb0gl4g6s9l3bwawd9xzfkj-busybox-static-x86_64-unknown-linux-musl-1.37.0	    1495056
/nix/store/rngqninsh1w9bjxd5bgxgld8rnypjjdl-cairn-src                                      	    1798176
== greeting: /nix/store/d76bjdvj1ppdyyj6x1plf7nb0dij1g2g-greeting
/nix/store/d76bjdvj1ppdyyj6x1plf7nb0dij1g2g-greeting	        472
== hello: /nix/store/idksigadaj3inqj8kyl5gajvyxmlzbi5-hello
/nix/store/8mid8wh1kxb0gl4g6s9l3bwawd9xzfkj-busybox-static-x86_64-unknown-linux-musl-1.37.0	    1495056
/nix/store/d76bjdvj1ppdyyj6x1plf7nb0dij1g2g-greeting                                       	        472
/nix/store/idksigadaj3inqj8kyl5gajvyxmlzbi5-hello                                          	    1496288
== site: /nix/store/bvsd8nk1mywpmla0qviqh5snpd7iiw2n-site
/nix/store/bvsd8nk1mywpmla0qviqh5snpd7iiw2n-site	        544
== wordfreq: /nix/store/2s8pq5ngshyqh9spplgiqm60ajgabka1-wordfreq
/nix/store/8mid8wh1kxb0gl4g6s9l3bwawd9xzfkj-busybox-static-x86_64-unknown-linux-musl-1.37.0	    1495056
/nix/store/2s8pq5ngshyqh9spplgiqm60ajgabka1-wordfreq                                       	    1496048
```

最后一列是闭包大小。几个数字值得算一遍。busybox 是 1,495,056 字节，占 `hello` 闭包的 99.92%；`hello` 自己是 1,496,288 减去 1,495,056 再减去 greeting 的 472，等于 760 字节。`wordfreq` 是 1,496,048，自己 992 字节。`cairn-src` 是 1,798,176，自己 303,120 字节，我猜是因为它装着整个 Cairn ch10 的源码（没有去拆这个数字）。

最意外的是 `site`：它的闭包只有它自己，544 字节。可是我明明在构建 `site` 的时候用了 `hello`、`wordfreq` 和 `cairn-src`。原因是引用扫描只看**输出里**有没有出现别的 store 路径的哈希。`site` 的输出是一个 `index.html`，里面是 `hello` 的输出文本和词频表，没有任何 store 路径，所以它没有运行时依赖。`buildInputs` 是构建时依赖，进的是 `.drv` 的 `inputDrvs`（构建要先有它们），不进闭包。这和上面 `hello` 的情形正好相反：`hello` 的 `buildInputs` 是空的，但它的输出里写着 `greeting` 的路径，所以闭包里有 `greeting`。构建时依赖和运行时依赖是两个集合，stdenv 的所有依赖分类（下面会读到）都是为了把它们分清。

## 看一眼阶段日志

`lab/ch07/phases_log.sh` 共 16 行：先构建 mini 的 `hello`(已经构建过就是 no-op)，再 `nix log` 它。

```text
$ cat out/ch07/phases_log.stdout
== phase unpack
== phase patch
== phase build
== phase install
== phase fixup
$ cat out/ch07/phases_log.stderr
got build log for 'git+file:///home/bfmhno3/Projects/firn#legacyPackages.x86_64-linux.mini.hello' from 'daemon'
```

五个阶段按顺序跑了。`hello` 没有 `src`，所以 `unpack` 什么都没做；没写 `patchPhase` 和 `buildPhase`，它们也只是打印了一个标题。`install` 执行了 `installPhase`，`fixup` 做了 shebang 替换。构建日志是 Nix 守护进程存下来的，`nix log` 从守护进程取（标准错误里那一行）。这五行标题是 nixpkgs 构建日志里那些 `Running phase: unpackPhase` 的小号版本。

## callPackage：按名字取参数

`hello.nix` 的第一行是 `{ mkDerivation, busybox, greeting }:`，它没有说 `greeting` 从哪来。谁来填？[`mini/default.nix`](https://github.com/bfmhno3/firn/blob/ch07/mini/default.nix)：

```nix
# mini 包集：一个不动点，包之间靠 callPackage 从 self 里按名字取依赖。
{
  busybox,
  system,
  lib ? import ../lib,
}:
lib.makeExtensible (self: {
  inherit busybox;

  callPackage =
    fn: args:
    let
      f = if builtins.isFunction fn then fn else import fn;
    in
    f (builtins.intersectAttrs (builtins.functionArgs f) self // args);

  inherit (import ./stdenv { inherit busybox system; }) mkDerivation;
  fetchurl = import <nix/fetchurl.nix>;

  greeting = self.callPackage ./pkgs/greeting.nix { };
  hello = self.callPackage ./pkgs/hello.nix { };
  wordfreq = self.callPackage ./pkgs/wordfreq.nix { };
  cairn-src = self.callPackage ./pkgs/cairn-src.nix { };
  site = self.callPackage ./pkgs/site.nix { };
})
```

`callPackage` 三行：把 `fn` 变成函数(如果是路径就 `import`)，问它要哪些参数(`builtins.functionArgs f`)，从包集 `self` 里只挑出名字恰好匹配的那几项(`builtins.intersectAttrs`)，再用显式传的 `args` 覆盖(`//`)，最后调用。`lab/ch07/callpackage_by_hand.nix` 把这几步拆开做了一遍：

```nix
let
  system = builtins.currentSystem;
  busybox = import ../../mini/seed.nix { inherit system; };
  mini = import ../../mini { inherit busybox system; };
  f = import ../../mini/pkgs/site.nix;
  wanted = builtins.functionArgs f;
  supplied = builtins.intersectAttrs wanted mini;
in
{
  functionArgs = wanted;
  setAttrNames = builtins.attrNames mini;
  suppliedNames = builtins.attrNames supplied;
  sameOutPath = (f supplied).outPath == mini.site.outPath;
}
```

```text
$ cat out/ch07/callpackage_by_hand.stdout
{ functionArgs = { cairn-src = false; hello = false; mkDerivation = false; wordfreq = false; }; sameOutPath = true; setAttrNames = [ "busybox" "cairn-src" "callPackage" "extend" "fetchurl" "greeting" "hello" "mkDerivation" "site" "wordfreq" ]; suppliedNames = [ "cairn-src" "hello" "mkDerivation" "wordfreq" ]; }
```

`functionArgs` 返回的 attrset 里值是 `false` 表示这个参数没有默认值，必须提供（有默认值的是 `true`，比如 `greeting.nix` 的 `text`）。包集里有 10 个名字，`site.nix` 要 4 个，`intersectAttrs` 恰好挑出这 4 个：`busybox`、`greeting` 这些它没要的，一个也没多给。`sameOutPath = true` 说明手工拆开做出来的 `site` 和包集里的 `mini.site` 是同一个 store 路径。

nixpkgs 里的 `callPackage` 就是同一个算法。[`lib/customisation.nix` 的 308 到 323 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/customisation.nix#L308-L323)：

```nix
    autoArgs: fn: args:
    let
      f = if isFunction fn then fn else import fn;
      fargs = functionArgs f;

      # All arguments that will be passed to the function
      # This includes automatic ones and ones passed explicitly
      allArgs = intersectAttrs fargs autoArgs // args;

      # arguments that weren't passed automatically to the function
      unpassedArgs = removeAttrs fargs (attrNames allArgs);

    in
    # if nonempty, check if the function has defaults for those other args
    if unpassedArgs == { } || all (value: value) (attrValues unpassedArgs) then
      makeOverridable f allArgs
```

`f` 那一行和 `allArgs` 那一行，除了 `builtins.` 前缀，和我写的三行一一对应。多出来的两样：缺参数时的错误信息（会给“did you mean”的建议），以及 `makeOverridable`，它给结果加上 `.override`，让你在不改包文件的情况下换掉依赖。`.override` 是第 10 篇的事。一个注意：因为依赖是**按名字**取的，函数参数的名字就是一份合同。把 `greeting` 改叫 `greet`，`hello.nix` 就找不到它了。nixpkgs 的错误信息会告诉你最接近的名字，mini 的版本只会给你 Nix 自带的 “called without required argument”。

## 包集合是一个不动点

`mini/default.nix` 最外层是 `lib.makeExtensible (self: { ... })`。包里的 `self.callPackage ./pkgs/hello.nix { }` 从 `self` 里取 `greeting`，`self` 是整个包集合自己。这就是第 3 篇的 `fix`：包集是一个“以自己为参数的函数”的不动点。Firn 的 [`lib/fixed-points.nix`](https://github.com/bfmhno3/firn/blob/ch07/lib/fixed-points.nix) 里有它的三行定义：

```nix
  extends =
    f: rattrs: self:
    let
      super = rattrs self;
    in
    super // f self super;
```

`extends` 把一个 overlay `f`(`final: prev: { ... }`)套到原始的包集函数 `rattrs` 上。关键在 `rattrs self`：原始函数被求值时，拿到的 `self` 是**最终的**包集，不是它自己。这有个直接后果：overlay 改了 `greeting`，原来包集里所有 `self.callPackage ... ` 取 `greeting` 的包，取到的都是新的。

`lab/ch07/mini_overlay.nix` 验证这一点，只改 `greeting` 的文本：

```nix
  hallo = mini.extend (
    final: prev: {
      greeting = prev.callPackage ../../mini/pkgs/greeting.nix { text = "Hallo"; };
    }
  );
  changed = name: mini.${name}.outPath != hallo.${name}.outPath;
```

```text
$ cat out/ch07/mini_overlay.stdout
{ greeting = true; hello = true; site = true; wordfreq = false; }
```

`greeting` 变了（废话），`hello` 变了（它的 `installPhase` 里插值了 `${greeting}`，字符串变了，`.drv` 变了，输出路径变了），`site` 也变了（`hello` 在它的 `buildInputs` 里，`hello` 的 `.drv` 变了，`site` 的跟着变），`wordfreq` 没变，因为它不依赖 `greeting`。这是输入寻址（第 6 篇）的连锁反应，一个 overlay 只写了一个包，但它改变了依赖图里所有下游的路径。如果 `prev.callPackage` 拿到的是原来的 `self`，`hello` 就会还指向旧的 `greeting`，那一行会是 `hello = false`。

nixpkgs 整个包集也是这么搭的。[`pkgs/top-level/stage.nix` 的 335 到 360 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/stage.nix#L335-L360)：

```nix
  # The complete chain of package set builders, applied from top to bottom.
  # stdenvOverlays must be last as it brings package forward from the
  # previous bootstrapping phases which have already been overlaid.
  toFix = lib.foldl' (lib.flip lib.extends) (self: { }) (
    [
      stdenvBootstappingAndPlatforms
      stdenvAdapters
      trivialBuilders
      splice
      autoCalledPackages
      allPackages
      otherPackageSets
      aliases
      variants
      configOverrides
      internallyDisallowedAttrPathsOverlay
    ]
    ++ overlays
    ++ [
      stdenvOverrides
    ]
  );

in
# Return the complete set of packages.
lib.fix toFix
```

从空集合 `self: { }` 开始，把一串 overlay 依次 `extends` 上去，最后 `lib.fix`。你自己写的 overlay（`overlays` 那一项）夹在 `allPackages`、`aliases` 这些内部层和最后的 `stdenvOverrides` 之间。我的 `mini` 只有一层，nixpkgs 有十几层，机制完全一样。还有一处我觉得有趣：stage.nix 的 [`extend` 上方](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/stage.nix#L274-L281)有一条注释，说每次 `extend` 都会引起一次完整的 nixpkgs 重建，“adding ~130MB of allocations”，并且大写着 “DO NOT USE THIS IN NIXPKGS”。mini 的 `extend` 只重算 10 个名字，不心疼；换成第 1 篇数过的 27959 个顶层属性，就是另一回事了（这条注释我没有自己量过）。

## 拆开 nixpkgs 的 stdenv：builder 是谁

mini 的 builder 是 `busybox sh setup.sh`。nixpkgs 的 `mkDerivation` 设的是什么？[`pkgs/stdenv/generic/make-derivation.nix` 的 130 到 134 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L130-L134)：

```nix
  defaultBuilderArgs = [
    "-e"
    ./source-stdenv.sh
    ./default-builder.sh
  ];
```

然后 [692 到 703 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L692-L703)：`builder = attrs.realBuilder or stdenvShell`，`args` 缺省就是上面那个列表。所以 nixpkgs 里一个普通包的 builder 是 stdenv 里的 bash，参数是 `-e source-stdenv.sh default-builder.sh`。这两个脚本加起来很短：

```text
$ head -n 7 out/ch07/source_stdenv.stdout
== pkgs/stdenv/generic/source-stdenv.sh
     1	if [ -e "$NIX_ATTRS_SH_FILE" ]; then . "$NIX_ATTRS_SH_FILE"; fi
     2	source "$stdenv/setup"
     3	source "$1"

== pkgs/stdenv/generic/default-builder.sh
     1	genericBuild
```

(这是 `lab/ch07/source_stdenv.sh` 的输出，它从锁定的 nixpkgs 源码树里读这两个文件。)`$stdenv/setup` 就是那份 1839 行的 [`setup.sh`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh)：先 `source` 它，定义一大堆函数、处理所有依赖、跑完所有 setup hook，然后 `source` 包自己的 builder，默认的 builder 只有一行 `genericBuild`。结构上和 mini 的最后四行(`mkdir -p`、`for phase in ...; do`、`run_phase`、`done`)完全对应，只是 nixpkgs 把“准备环境”和“跑阶段”拆成了两步。

先量一量两份 `setup.sh` 有多大。`lab/ch07/setup_sizes.sh` 的前半：

```text
$ head -n 7 out/ch07/setup_sizes.stdout
== wc -l
mini:    63
nixpkgs: 1839

== function definitions (grep -c '^[a-zA-Z_]*() {')
mini:    3
nixpkgs: 64
```

63 行对 1839 行，29.2 倍；3 个函数对 64 个。这 1839 行里最大的几块是什么？`lab/ch07/source_stdenv.sh` 用一段 `awk` 量了每个函数的长度(从列 0 的 `name() {` 到下一个列 0 的 `}`)：

```text
$ tail -n 10 out/ch07/source_stdenv.stdout
== five longest functions of setup.sh (lines, name)
92 findInputs
81 configurePhase
72 unpackPhase
65 substituteStream
50 fixupPhase

== runHook and exitHandler
33 exitHandler
15 runHook
```

最长的是依赖发现 `findInputs`(92 行，下面会读)，接着是 `configurePhase`、`unpackPhase`、`substituteStream` 和 `fixupPhase`。`runHook` 15 行，`exitHandler`(错误处理)33 行。五个最长的函数加起来 360 行，不到全文件的 20%，剩下的是大量短小的辅助函数和顶层的初始化代码。

### 阶段表

mini 的阶段是 `unpack patch build install fixup`。真的 stdenv 的阶段在 `definePhases` 里，[`setup.sh` 的 1777 到 1785 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L1777-L1785)，下面是 `setup_sizes.sh` 的输出（行号是 `nl` 加的，和源文件一致）：

```text
== pkgs/stdenv/generic/setup.sh lines 1777-1785
  1777	definePhases() {
  1778	    # only defines phases if it is not already defined
  1779	    if [ -z "${phases[*]:-}" ]; then
  1780	        phases="${prePhases[*]:-} unpackPhase patchPhase ${preConfigurePhases[*]:-} \
  1781	            configurePhase ${preBuildPhases[*]:-} buildPhase checkPhase \
  1782	            ${preInstallPhases[*]:-} installPhase ${preFixupPhases[*]:-} fixupPhase installCheckPhase \
  1783	            ${preDistPhases[*]:-} distPhase ${postPhases[*]:-}"
  1784	    fi
  1785	}
```

默认有 9 个阶段：`unpack`、`patch`、`configure`、`build`、`check`、`install`、`fixup`、`installCheck`、`dist`。插槽只有五个：`configure`、`build`、`install`、`fixup`、`dist` 之前各有一个(`preConfigurePhases`、`preBuildPhases`、`preInstallPhases`、`preFixupPhases`、`preDistPhases`)，`patch`、`check`、`installCheck` 之前没有；另外开头有 `prePhases`，末尾有 `postPhases`。包可以往这些数组里插自己的阶段。注意第 1779 行：**只有在 `phases` 没有定义的时候**才用默认列表。这是个逃生口，包可以直接设 `phases = [ "buildPhase" ]`，我们等下就会撞上它。

真正跑阶段的是 `genericBuild` 末尾的一个循环（1817 到 1819 行）：

```text
== pkgs/stdenv/generic/setup.sh lines 1817-1819
  1817	    for curPhase in ${phases[*]}; do
  1818	        runPhase "$curPhase"
  1819	    done
```

每个阶段交给 `runPhase`，在 [1743 到 1775 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L1743-L1775)。我把里面和 mini 对应的部分摘出来：

```bash
# pkgs/stdenv/generic/setup.sh:1743-1763 (omitted lines marked)
runPhase() {
    local curPhase="$*"
    if [[ "$curPhase" = unpackPhase && -n "${dontUnpack:-}" ]]; then return; fi
    if [[ "$curPhase" = patchPhase && -n "${dontPatch:-}" ]]; then return; fi
    if [[ "$curPhase" = configurePhase && -n "${dontConfigure:-}" ]]; then return; fi
    if [[ "$curPhase" = buildPhase && -n "${dontBuild:-}" ]]; then return; fi
    if [[ "$curPhase" = checkPhase && -z "${doCheck:-}" ]]; then return; fi
    # ...
    showPhaseHeader "$curPhase"
    dumpVars
    # ...
    # Evaluate the variable named $curPhase if it exists, otherwise the
    # function named $curPhase.
    eval "${!curPhase:-$curPhase}"
```

三件事。第一，**跳过阶段靠一组 `dont*` 和 `do*` 变量**：`dontUnpack`、`dontPatch`、`dontConfigure`、`dontBuild`、`dontInstall`、`dontFixup` 设了就跳过；`checkPhase`、`installCheckPhase`、`distPhase` 相反，要 `doCheck`、`doInstallCheck`、`doDist` 非空才跑（1745 到 1753 行）。这就是为什么你在 nixpkgs 里到处看到 `doCheck = true;` 和 `dontBuild = true;`。mini 的做法是“没写就空着”，没有这一层开关。

第二，`showPhaseHeader` 打印的就是你在构建日志里看到的那行 `Running phase: unpackPhase`（[1713 到 1715 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L1713-L1715)）；它还会在 `NIX_LOG_FD` 存在时给 Nix 发一条 `setPhase` 的结构化日志，源码注释说这样当前阶段会显示在终端界面里。mini 的 `== phase` 是它的小号版本。

第三，最后那行 `eval "${!curPhase:-$curPhase}"`，是 mini 里 `printenv` 的 bash 版：`${!curPhase}` 是间接展开，取名叫 `buildPhase` 的变量的值；变量没设就 `eval` 阶段名本身，也就是调用叫 `buildPhase` 的**函数**。所以包的 `buildPhase = "make -j4"` 这样的字符串属性会替换掉默认的函数，而不写 `buildPhase` 就用 `setup.sh` 里定义的默认 `buildPhase()`。同样一套“环境变量优先，没有就用默认”的规则，mini 里要用 `printenv` 和一个 `if` 链，这里一行。

每个阶段函数的头尾各有一个 hook 的插槽：`buildPhase()` 一开头 `runHook preBuild`，结尾 `runHook postBuild`（[1511 到 1532 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L1511-L1532)）。其他阶段同理。`preBuild`、`postInstall` 这些你常写的属性，就是在这两个位置被执行的。`buildPhase()` 的默认实现也很有意思，它先看有没有 Makefile：

```bash
# pkgs/stdenv/generic/setup.sh:1514-1516
    if [[ -z "${makeFlags-}" && -z "${makefile:-}" && ! ( -e Makefile || -e makefile || -e GNUmakefile ) ]]; then
        echo "no Makefile or custom buildPhase, doing nothing"
    else
```

没有 Makefile 又没自定义 `buildPhase` 就什么也不做，和 mini 里“没写 `buildPhase` 就只打印标题”是同一个态度，只是它还会告诉你一声。

| | mini `setup.sh` | nixpkgs `setup.sh` |
| --- | --- | --- |
| 阶段 | `unpack patch build install fixup`，写死在一个 `for` 里 | 9 个默认阶段，`phases` 变量可整体替换，阶段间有 `pre*Phases` 插槽 |
| 取阶段内容 | `printenv "$1Phase"`（POSIX sh 没有间接展开） | `eval "${!curPhase:-$curPhase}"`（1763 行） |
| 跳过阶段 | 没有开关 | `dont*`、`do*` 变量（1745 到 1753 行） |
| hook | 没有 | 每个阶段头尾 `runHook pre*`、`runHook post*` |
| 阶段标题 | `== phase <name>` | `Running phase: <name>`，外加 `setPhase` 结构化日志 |

### 在 nix develop 里亲手跑阶段

手册的[“在 nix-shell 里构建一个 stdenv 包”一节](https://nixos.org/manual/nixpkgs/unstable/#sec-building-stdenv-package-in-nix-shell)教的办法是：进 shell，然后手动调阶段函数。`lab/ch07/real_stdenv_phases.sh` 在 `LAB_TMP` 里对锁定版的 `hello` 做这件事，分两步。

第一步，先用最直接的写法，`nix develop --command`：

```bash
nix develop -f "${pkgs_nix}" hello --command bash -c '
  type unpackPhase 2>&1 | head -n 1
  echo "phases: ${phases:-default}"
' 2>/dev/null
```

```text
== nix develop --command: are the phase functions there?
bash: line 2: type: unpackPhase: not found
phases: buildPhase
```

函数**不在**。原因在 Nix 源码里：`nix develop` 带 `--command` 时，把环境写进一个 rc 脚本，最后一行是 `exec <你的命令>`（[`src/nix/develop.cc` 的 610 到 616 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/develop.cc#L610-L616)）。命令是一个全新的 `bash -c`，bash 函数不会跨进程，除非 `export -f`，所以 `unpackPhase` 在那里不存在。要用函数，得在**同一个** shell 里 `source` 开发环境。`nix print-dev-env` 打印的就是这样一份脚本，交互式的 `nix develop` 在内部也是这么做的。所以实验的第二步改用它：

```bash
nix print-dev-env -f "${pkgs_nix}" hello >env.sh 2>/dev/null
bash -c '
  source ./env.sh
  unpackPhase
  cd hello-*
  configurePhase
  buildPhase
  echo "phases: ${phases:-default}"
' 2>&1 | tail -n 8 | cut -c1-100
```

```text
== phases from print-dev-env (tail, lines cut to 100 columns)
rm -f lib/libhello.a
ar cr lib/libhello.a lib/libhello_a-basename-lgpl.o lib/libhello_a-c-ctype.o lib/libhello_a-c-strcas
ranlib lib/libhello.a
gcc  -g -O2 -Wl,--as-needed  -o hello src/hello.o lib/libhello.a        
make[3]: Leaving directory '/tmp/nix-shell.BHq1Fv/firn-lab.kjIYiO/hello-2.12.3'
make[2]: Leaving directory '/tmp/nix-shell.BHq1Fv/firn-lab.kjIYiO/hello-2.12.3'
make[1]: Leaving directory '/tmp/nix-shell.BHq1Fv/firn-lab.kjIYiO/hello-2.12.3'
phases: buildPhase
```

`unpackPhase` 解开了 `hello-2.12.3`，`configurePhase` 跑了 `./configure`，`buildPhase` 跑了 `make`，最后一行 `gcc ... -o hello` 把二进制链出来了。这和 mini 的 `== phase` 日志是同一套阶段，只不过换成了 autotools 的真实内容。

注意这个输出里的另一行，`phases: buildPhase`，我最初很惊讶：`hello` 并没有设 `phases`。答案是它不是 `hello` 设的，是**我自己的 Firn 开发环境**设的。`nix develop` 进入 Firn 的 shell 时，那个 `mkShell` 把 `phases = [ "buildPhase" ]` 作为 derivation 属性（[`pkgs/build-support/mkshell/default.nix` 的 48 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/mkshell/default.nix#L48)），属性在环境里就是导出的变量，`lab` 脚本继承了它。而第 1779 行的规则是 `phases` 已经定义就不用默认列表，所以在这个环境里如果你敲 `genericBuild`，它只会跑一个 `buildPhase`。实验里我直接调阶段函数，没有走 `genericBuild`，所以不受影响。这一行对实验没有伤害，但我不想让它当成“`hello` 的 `phases` 是 `buildPhase`”留在你脑子里，所以特意说明。手册里重新跑单个阶段的写法也正是利用这一点：`phases="buildPhase" genericBuild`。

`nix develop` 还有一组省事的旗标：`--unpack`、`--configure`、`--build`、`--check`、`--install`、`--installcheck` 和通用的 `--phase`（[`develop.cc` 的 530 到 571 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/develop.cc#L530-L571)），它们的实现是在环境里执行 `runHook <phase>Phase`（601 到 608 行）。我没有在实验里用它们，`--build` 之类要求当前目录就是源码目录，对 `hello` 这种要先 `unpackPhase` 的包不方便。

## setup hook：依赖带着脚本来

mini 的 `setup.sh` 对依赖只做一件事：加 `PATH`。nixpkgs 的依赖还能**自带脚本**。一个包的输出里如果有 `nix-support/setup-hook`，所有把它放进依赖列表的包在构建开始时都会 `source` 这个文件。[`activatePackage` 在 `setup.sh` 的 835 到 871 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L835-L871)，最后几行：

```bash
# pkgs/stdenv/generic/setup.sh:867-870
    if [[ -f "$pkg/nix-support/setup-hook" ]]; then
        nixTalkativeLog "sourcing setup hook '$pkg/nix-support/setup-hook'"
        source "$pkg/nix-support/setup-hook"
    fi
```

更前面还有一段（843 到 846 行）：如果依赖**本身**是一个文件而不是目录，就直接 `source` 它。这是“把一个 `.sh` 路径放进 `nativeBuildInputs`”这种写法能工作的原因，`stdenv` 里就有这样的写法，下面会看到。

`lab/ch07/setup_hooks.sh` 演示最常见的一个：`pkg-config`。它在 `LAB_TMP` 里写一个 `shell.nix`，`mkShell` 里只有 `pkgs.pkg-config` 和 `pkgs.zlib`，没有任何一个地方设 `PKG_CONFIG_PATH`：

```nix
pkgs.mkShell {
  packages = [
    pkgs.pkg-config
    pkgs.zlib
  ];
}
```

然后 `nix-shell shell.nix --run` 打印这个变量、`pkg-config` 包装里的 `nix-support` 目录，以及 `pkg-config` 找到了什么：

```text
$ cat out/ch07/setup_hooks.stdout
PKG_CONFIG_PATH=/nix/store/dfb5jybg1sakjy1zahpgrxfqmz5rfwmc-zlib-1.3.2-dev/share/pkgconfig
== nix-support of pkg-config-wrapper
add-flags.sh
orig-pkg-config
propagated-user-env-packages
setup-hook
utils.bash
== pkg-config --cflags --libs zlib
-I/nix/store/dfb5jybg1sakjy1zahpgrxfqmz5rfwmc-zlib-1.3.2-dev/include -L/nix/store/0c5qg74fw50vz6scy5dn2zm6h2bvsscn-zlib-1.3.2-static/lib -L/nix/store/zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb-zlib-1.3.2/lib -lz
== pkg-config --modversion zlib
1.3.2
```

`PKG_CONFIG_PATH` 被设成了 zlib 的 `dev` 输出下的 `share/pkgconfig`。是谁设的？看列表里的 `setup-hook`，它就是 [`pkgs/build-support/pkg-config-wrapper/setup-hook.sh`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/pkg-config-wrapper/setup-hook.sh)：

```bash
# pkgs/build-support/pkg-config-wrapper/setup-hook.sh:11-24
pkgConfigWrapper_addPkgConfigPath () {
    # See ../setup-hooks/role.bash
    local role_post
    getHostRoleEnvHook

    addToSearchPath "PKG_CONFIG_PATH${role_post}" "$1/lib/pkgconfig"
    addToSearchPath "PKG_CONFIG_PATH${role_post}" "$1/share/pkgconfig"
}

# See ../setup-hooks/role.bash
getTargetRole
getTargetRoleWrapper

addEnvHooks "$targetOffset" pkgConfigWrapper_addPkgConfigPath
```

`pkg-config` 的 hook 做了一件事：注册一个“env hook”，`pkgConfigWrapper_addPkgConfigPath`（`addEnvHooks` 在 [665 到 673 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L665-L673)）。env hook 是 `setup.sh` 在激活完所有依赖之后，**对每个依赖调用一次**的函数（[`_addToEnv` 在 893 到 946 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L893-L946)），参数是依赖的 store 路径；这个函数把依赖的 `lib/pkgconfig` 和 `share/pkgconfig` 加进搜索路径。输出里只有 `share/pkgconfig`，是因为 zlib 的 `.pc` 文件装在那里（zlib 的 [`default.nix` 第 142 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/development/libraries/zlib/default.nix#L142)：`pkgconfigdir=${placeholder "dev"}/share/pkgconfig`），而 `addToSearchPath` 只会添加存在的目录。

hook 的第一行（[第 9 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/pkg-config-wrapper/setup-hook.sh#L9)）值得注意：`[[ -z ${strictDeps-} ]] || (( "$hostOffset" < 0 )) || return 0`。在 `strictDeps` 打开时，只有 `hostOffset < 0` 的依赖，也就是 build 平台上跑的东西，才会让它生效。`hostOffset` 是什么，下一节讲。

这就是 setup hook 的威力和代价：`buildInputs` 里放一个包，你的构建环境里就悄悄多了环境变量、多了函数、`PATH` 里多了目录，而你的 Nix 表达式里一个字都没写。查出它们是谁加的，只能去读 `nix-support/setup-hook`。手册在[“依赖传播”一节](https://nixos.org/manual/nixpkgs/unstable/#ssec-stdenv-dependencies-propagated)里用了一个词：propagated 依赖会“obscure the actual build inputs of dependent derivations and cause side effects through setup hooks”。

## 依赖的分类：偏移量

前面我一直在说“构建时依赖”和“运行时依赖”。nixpkgs 把这两个词换成了一套更精细的说法，因为它要同时支持交叉编译：同一个包可能要在一台机器上构建、在另一台机器上运行，还可能是一个为第三台机器生成代码的编译器。

Nixpkgs 手册的[交叉编译一章](https://nixos.org/manual/nixpkgs/unstable/#chap-cross)定义了三个平台：**build** 是构建这个包的机器，**host** 是这个包将要运行的机器，**target** 只对编译器之类产出机器码的工具有意义，是它产出的代码要运行的机器。依赖被分成几类，由两个数决定：依赖自己在哪个平台上运行（host 偏移），以及它（如果是编译器）为哪个平台产出代码（target 偏移）。偏移量是**相对于正在构建的包**的：`setup.sh` 的 [696 到 697 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L696-L697)定义了它们：

```text
== pkgs/stdenv/generic/setup.sh lines 696-697
   696	# Platform offsets: build = -1, host = 0, target = 1
   697	declare -a allPlatOffsets=(-1 0 1)
```

然后是整张表的实现，[808 到 825 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L808-L825)，`setup_sizes.sh` 打印的：

```text
== pkgs/stdenv/generic/setup.sh lines 808-825
   808	for pkg in ${depsBuildBuild[@]} ${depsBuildBuildPropagated[@]}; do
   809	    findInputs "$pkg" -1 -1
   810	done
   811	for pkg in ${nativeBuildInputs[@]} ${propagatedNativeBuildInputs[@]}; do
   812	    findInputs "$pkg" -1  0
   813	done
   814	for pkg in ${depsBuildTarget[@]} ${depsBuildTargetPropagated[@]}; do
   815	    findInputs "$pkg" -1  1
   816	done
   817	for pkg in ${depsHostHost[@]} ${depsHostHostPropagated[@]}; do
   818	    findInputs "$pkg"  0  0
   819	done
   820	for pkg in ${buildInputs[@]} ${propagatedBuildInputs[@]} ; do
   821	    findInputs "$pkg"  0  1
   822	done
   823	for pkg in ${depsTargetTarget[@]} ${depsTargetTargetPropagated[@]}; do
   824	    findInputs "$pkg"  1  1
   825	done
```

我把这六个循环和 [`make-derivation.nix` 的 398 到 412 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L398-L412)那几行注释(`# -1 -> 0  N.B. Legacy name`)以及手册里每个变量的描述逐个对过，整理成一张表。偏移量里的 `-1`、`0`、`1` 就是 build、host、target；“→”前面是依赖自己运行的平台，后面是它产出代码的目标平台：

| 属性 | 偏移 host → target | 依赖在哪里运行 → 为谁产出代码 | 典型用途 |
| --- | --- | --- | --- |
| `depsBuildBuild` | -1 → -1 | build → build | 构建时跑的、产出构建时用的东西的工具，例如构建平台的 C 编译器 |
| `nativeBuildInputs` | -1 → 0 | build → host | 构建这个包用的工具，`pkg-config`、`cmake`、编译器 |
| `depsBuildTarget` | -1 → 1 | build → target | 只有在打包编译器时才用 |
| `depsHostHost` | 0 → 0 | host → host | 工具在宏里用到的库，很少见 |
| `buildInputs` | 0 → 1 | host → target | 要链接进产物、或运行时要用的库 |
| `depsTargetTarget` | 1 → 1 | target → target | 编译器的标准库的运行时依赖，只在打包编译器时才用 |

每个属性都有一个 `...Propagated` 的孪生（`nativeBuildInputs` 和 `buildInputs` 的孪生沿用旧名 `propagatedNativeBuildInputs` 和 `propagatedBuildInputs`），在上面的每个循环里和原列表一起处理。手册列出的“九种依赖类型”比六个列表多，因为不关心 target 的 `→ *` 依赖（库）和相邻的编译器类依赖共用一个列表：`nativeBuildInputs` 的手册条目明说“If the dependency doesn't care about the target platform … put it here”。`findInputs` 的开头还有一行 [709 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L709)：`(( hostOffset <= targetOffset )) || exit 1`，所以没有“host → build”这一类。手册的说法是“we prohibit dependencies from a "later" platform to an earlier platform to limit confusion”。

这张表在原生构建里（build、host、target 是同一台机器）什么都不改变，只是标签。它要到交叉编译才起作用：`nativeBuildInputs` 里的 `pkg-config` 必须是**构建机**上能跑的那一份，`buildInputs` 里的 `zlib` 必须是**目标机**上的那一份。怎么从同一个包集里取出两份不同平台的依赖，是第 12 篇的 splicing，这里只要记住偏移量就是这个意思。

### strictDeps：不让你偷懒

在原生构建里，nixpkgs 默认是宽容的：你把一个构建工具错放进 `buildInputs`，它的 `bin` 也会进 `PATH`，构建照样成功。这个宽容是写在 `activatePackage` 里的，[855 到 857 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L855-L857)：

```bash
# pkgs/stdenv/generic/setup.sh:855-857
    if [[ -z "${strictDeps-}" || "$hostOffset" -le -1 ]]; then
        addToSearchPath _PATH "$pkg/bin"
    fi
```

`strictDeps` 没设，所有依赖的 `bin` 都进 `PATH`；设了，只有 `hostOffset <= -1` 的，也就是 `nativeBuildInputs` 和 `depsBuild*` 里的。`strictDeps` 的默认值在 [`make-derivation.nix` 的 355 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L355)：`if config.strictDepsByDefault then true else hostPlatform != buildPlatform`，也就是说交叉编译时默认严格，原生构建默认宽容（手册也说“The specialized `build*` functions for dlang, emacs, go, nim, ocaml, python, and rust enable this option by default”）。宽容的代价是：你在原生机器上写出一个交叉编译一定会炸的包，而你永远不会发现。`strictDeps = true` 就是让你在原生机器上提前发现。

### 实验：几个真包的分类

`lab/ch07/propagation.nix` 取了锁定版 nixpkgs 里五个包，打印它们各类依赖的名字和 `strictDeps`（输出是一行，我拆开了排版，内容没改；`...` 是我省略的包）：

```text
$ cat out/ch07/propagation.stdout
{ curl = { buildInputs = [ ]; nativeBuildInputs = [ "pkg-config-wrapper-0.29.2" "perl-5.42.0" "(path)" ]; propagatedBuildInputs = [ "brotli-1.2.0" "krb5-1.22.2" ... "zlib-1.3.2" "zstd-1.5.7" ]; propagatedNativeBuildInputs = [ ]; strictDeps = true; };
  hello = { buildInputs = [ ]; nativeBuildInputs = [ "version-check-hook" ]; propagatedBuildInputs = [ ]; propagatedNativeBuildInputs = [ ]; strictDeps = false; };
  libpng = { buildInputs = [ ]; nativeBuildInputs = [ ]; propagatedBuildInputs = [ "zlib-1.3.2" ]; propagatedNativeBuildInputs = [ ]; strictDeps = false; };
  pkg-config = { buildInputs = [ ]; nativeBuildInputs = [ ]; propagatedBuildInputs = [ ]; propagatedNativeBuildInputs = [ ]; strictDeps = true; };
  python3 = { buildInputs = [ "bash-5.3p15" "bzip2-1.0.8" ... "readline-8.3p3" ]; nativeBuildInputs = [ "nuke-refs" "autoconf-archive-2024.10.16" "autoreconf-hook" "pkg-config-wrapper-0.29.2" "(path)" ]; propagatedBuildInputs = [ ]; propagatedNativeBuildInputs = [ ]; strictDeps = false; }; }
```

逐个看：

- `hello` 是最简单的：`nativeBuildInputs` 里只有一个 `version-check-hook`（一个 setup hook，我猜它在 installCheck 阶段检查 `--version`，没有读它的源码），`buildInputs` 空，`strictDeps` 是 `false`。它在原生构建里宽容。
- `curl` 的 `strictDeps = true`，`nativeBuildInputs` 有 `pkg-config` 和 `perl`（构建工具，该在 build 平台跑），而 11 个库（`brotli`、`openssl`、`zlib` 等）在 `propagatedBuildInputs` 里，不在 `buildInputs`，用 curl 的人链接 libcurl 时，这些也要跟过去。
- `libpng` 的 `propagatedBuildInputs` 是 `zlib`。`propagated` 是怎么传播的：`fixupPhase` 在 1628 行调用 `recordPropagatedDependencies`（[1210 到 1240 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L1210-L1240)），把传播依赖的路径写进 `dev` 输出的 `nix-support/propagated-build-inputs`；后来某个包把 `libpng` 放进自己的 `buildInputs`，`findInputs` 会读这个文件（785 到 791 行），把 `zlib` 也递归地加进来，偏移量按 `mapOffset` 换算。所以依赖 `libpng` 的包不用自己写 `zlib`。这是按 `setup.sh` 的代码得出的行为，我没有为它单独做实验。
- `python3` 是个有趣的反例：`strictDeps = false`，一大堆库在 `buildInputs`，`nativeBuildInputs` 里有 `nuke-refs` 和 `autoreconf-hook`。
- `pkg-config` 自己的依赖列表全空，`strictDeps = true`。

还有一个不是名字的东西：`curl` 和 `python3` 的 `nativeBuildInputs` 里各有一个 `"(path)"`。`lab/ch07/path_entry.nix` 把这些 `path` 值取出来，去掉 nixpkgs 的前缀，并打印两个包的 `separateDebugInfo`：

```text
$ cat out/ch07/path_entry.stdout
{ curlSeparateDebugInfo = true; paths = [ "pkgs/build-support/setup-hooks/separate-debug-info.sh" "pkgs/build-support/setup-hooks/separate-debug-info.sh" ]; python3SeparateDebugInfo = true; }
```

两个包的那一项都是 `separate-debug-info.sh`，一个 setup hook **文件**，不是 derivation。它来自 [`make-derivation.nix` 的 545 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L545)：`++ optional separateDebugInfo' ../../build-support/setup-hooks/separate-debug-info.sh`。`curl` 和 `python3` 都开了 `separateDebugInfo`，于是 `mkDerivation` 往它们的 `nativeBuildInputs` 里塞了这个文件。这正是前面 `activatePackage` 843 到 846 行那一段的用途：依赖是文件，就直接 `source`。同理，stdenv 自己的默认 hook(`patch-shebangs.sh`、`strip.sh`、`multiple-outputs.sh` 等一共 14 个)也是这样放进每个包的 `nativeBuildInputs` 的([`stdenv/generic/default.nix` 的 18 到 33 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/default.nix#L18-L33))。mini 的 `default_fixup` 只改 shebang，对应的是其中的 `patch-shebangs.sh`；nixpkgs 的 `fixupPhase` 通过 `fixupOutputHooks` 依次调用这些 hook(`patchShebangsAuto` 在 [`patch-shebangs.sh` 第 10 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/setup-hooks/patch-shebangs.sh#L10)注册，`_doStrip` 在 `strip.sh` 里注册)。

## 多个输出

mini 的每个包只有一个输出 `out`。nixpkgs 的包经常有好几个，`lab/ch07/multiple_outputs.sh` 看锁定版 zlib 的：

```text
$ cat out/ch07/multiple_outputs.stdout
outputs: ["out","dev","static"]
outputName: out
== zlib.out: /nix/store/zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb-zlib-1.3.2
self size: 132608 bytes
closure size: 37850496 bytes
== zlib.dev: /nix/store/dfb5jybg1sakjy1zahpgrxfqmz5rfwmc-zlib-1.3.2-dev
self size: 122832 bytes
closure size: 38126240 bytes
== zlib.dev references
/nix/store/0c5qg74fw50vz6scy5dn2zm6h2bvsscn-zlib-1.3.2-static
/nix/store/zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb-zlib-1.3.2
/nix/store/dfb5jybg1sakjy1zahpgrxfqmz5rfwmc-zlib-1.3.2-dev
```

zlib 的 `outputs` 是 `[ "out" "dev" "static" ]`，在 [`default.nix` 的 64 到 68 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/development/libraries/zlib/default.nix#L64-L68)里写着 `outputs = [ "out" "dev" ] ++ lib.optional splitStaticOutput "static"`。三个输出是三个独立的 store 路径：运行时的共享库在 `out`（自己 132,608 字节），头文件和 `.pc` 在 `dev`（122,832 字节），静态库 `libz.a` 在 `static`。`out` 的闭包 37,850,496 字节，大头是 glibc；`dev` 的闭包 38,126,240 字节，比 `out` 多 275,744 字节，是 `dev` 自己的 122,832 加上 `static` 的大小（实验没有单独打印 `static`，这一项是推断）。差别是 0.7%，数字小，但意义是方向：一个只要运行 zlib 的包，闭包里**不需要**头文件和静态库；`dev` 引用 `out`（上面的 `references`），反过来不引用，所以放 `out` 不会拖进 `dev`。

机制分三层。Nix 这一层，`outputs` 列表里每个名字变成一个环境变量，值是对应的 store 路径，builder 往这些路径里分别写文件（[Nix 手册 derivation 一章](https://nix.dev/manual/nix/2.34/language/derivations.html)，`doc/manual/source/language/derivations.md` 136 行：“Each output name is passed to the builder executable as an environment variable”）。nixpkgs 这一层，[`multiple-outputs.sh`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/setup-hooks/multiple-outputs.sh) 这个 hook（也在上面那 14 个默认 hook 里）在 `preConfigureHooks` 里注册 `_multioutConfig`，自动给 `configure` 加上 `--includedir="${!outputInclude}"/include`、`--libdir="${!outputLib}"/lib` 这样的参数（[66 到 96 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/setup-hooks/multiple-outputs.sh#L66-L96)），把文件放进对的输出。zlib 的 `configure` 不是 autoconf，所以它设了 `setOutputFlags = false`（第 69 行）自己传 `--includedir=${placeholder "dev"}/include`（79 到 81 行）。依赖这一层，手册的[多输出一章](https://nixos.org/manual/nixpkgs/unstable/#chap-multiple-output)写：一个多输出的包放进别人的 `buildInputs` 时，“the `dev` output is added if it exists, otherwise the first output is added”。这就是上一节的 `PKG_CONFIG_PATH` 里是 `...-zlib-1.3.2-dev/share/pkgconfig` 而不是 `zlib-1.3.2` 的原因：`pkgs.zlib` 放进 `packages`，取到的是它的 `dev`，`dev` 的 `.pc` 文件再指回 `static` 的 `-L` 和 `out` 的 `-L`（上一节 `pkg-config --libs` 输出里的两个 `-L`）。

## 构建失败时怎么看现场

nixpkgs 里的构建失败了，我有三个办法。

**第一，在 `nix develop` 里重跑。** 上面 `real_stdenv_phases.sh` 是个完整的例子。手册的[那一节](https://nixos.org/manual/nixpkgs/unstable/#sec-building-stdenv-package-in-nix-shell)给了几个要点，我挑出来：开始前先 `export out=$(pwd)/out`，因为输出路径不可写；用 `phases="${prePhases[*]:-} unpackPhase patchPhase" genericBuild` 跑一组阶段；想修改某个阶段，先 `echo "$buildPhase"`，变量是空就 `type buildPhase` 看函数，改完粘回终端。手册也直说了它的局限：`TMPDIR` 可能指向有旧文件的目录，输出路径不可写，没有 `--pure` 时环境变量也可能和沙箱里不一致。

**第二，保留失败的构建目录。** `nix build --keep-failed`，手册在同一段里推荐的。

**第三，`breakpointHook`。** 把它放进 `nativeBuildInputs`，构建失败时它**不退出**，而是暂停，让你进到失败的那个沙箱里。它的全部源码是 [`pkgs/by-name/br/breakpointHook/breakpoint-hook.sh`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/br/breakpointHook/breakpoint-hook.sh)，18 行：

```bash
# pkgs/by-name/br/breakpointHook/breakpoint-hook.sh:1-18
breakpointHook() {
    local red='\033[0;31m'
    local cyan='\033[0;36m'
    local green='\033[0;32m'
    local no_color='\033[0m'

    # provide the user with an interactive shell for better experience
    export bashInteractive="@bashInteractive@"
    dumpVars

    local id
    id="$(shuf -i 999999-9999999 -n1)"
    echo -e "${red}build for ${cyan}${name:-unknown}${red} failed in ${curPhase:-unknown} with exit code ${exitCode:-unknown}${no_color}"
    echo -e "${green}To attach, run the following command:${no_color}"
    echo -e "${green}    sudo @attach@ $id${no_color}"
    sleep "$id"
}
failureHooks+=(breakpointHook)
```

机制全在最后一行和 `setup.sh` 里的 `exitHandler`。`failureHooks+=(breakpointHook)` 把函数加进 `failureHooks` 数组；`setup.sh` 开头 `trap "exitHandler" EXIT`（[331 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L331)），构建以非零状态退出时，`exitHandler` 在 [310 到 311 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L310-L311)调用 `runHook failureHook`，按 `runHook` 的约定（203 到 217 行）就是执行 `failureHooks` 数组里的所有函数。所以这个 hook 只是一个**普通的失败回调**，它做的事是打印一条 `sudo attach <id>` 的提示，然后 `sleep` 那个随机的 `id`。这个 `id` 是 `shuf -i 999999-9999999` 抽的，单位是秒，也就是 11.6 天到 115.7 天之间；构建会一直挂着，直到你用 `attach` 进去，或者杀掉它。`attach` 的实现用了 `nsenter`（[`package.nix`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/br/breakpointHook/package.nix) 里依赖 `util-linuxMinimal`）；`meta.broken = !stdenv.buildPlatform.isLinux`，手册也说它只在 Linux 上可用，并且远程构建时 `attach` 要在远程机器上跑。

11 天起步的挂起不适合实验运行器，所以 `lab/ch07/breakpoint_hook.sh` 给构建加了 `nix build --timeout 20 -L`，20 秒后 Nix 自己杀掉 builder。构建的是一个故意失败的 `runCommand`：

```nix
pkgs.runCommand "breakpoint-demo" { nativeBuildInputs = [ pkgs.breakpointHook ]; } ''
  echo before
  exit 1
''
```

脚本只留下日志里和 hook 有关的行，并把随机的 `id` 和 `attach` 的 store 路径抹掉：

```text
$ cat out/ch07/breakpoint_hook.stdout
breakpoint-demo> before
breakpoint-demo> build for breakpoint-demo failed in unknown with exit code 1
breakpoint-demo> To attach, run the following command:
breakpoint-demo>     sudo <attach>/bin/attach <id>
error: timed out after 20 seconds
nix build exit status: 1
```

hook 确实在失败时被调用了，打印了提示，然后构建一直挂到被 `--timeout` 杀掉，`nix build` 以 1 退出。注意这里是 `failed in unknown`：`runCommand` 没有阶段，所以 `curPhase` 是空的，hook 退回到 `unknown`。如果是 `stdenv.mkDerivation` 的包在某个阶段失败，我猜这里会是那个阶段的名字，这一点没有实验。`sudo attach <id>` 那一步我也没有在实验里跑：它要进入构建的沙箱，需要 root，而且是交互的。

## 引导：这个 stdenv 本身是谁编译的

读到这里有一个问题在我脑子里转了很久：stdenv 里有 gcc，gcc 要用 C 编译器编译，那第一个 C 编译器是哪来的？

bootstrappable.org 的首页开头是个类比：“Do you know how to make yoghurt? The first step is to add yoghurt to milk! How can you build a compiler like GCC? The first step is to get a compiler that can compile the compiler.” 它接着说，用户和发行版因此依赖不透明的预编译二进制，“our goal is to minimize the amount of bootstrap binaries.”([bootstrappable.org](https://bootstrappable.org/))这个类比我只用这一次：酸奶要靠上一罐酸奶，编译器要靠上一个编译器。一路追到头，总得有一个东西不是从“上一个”来的。Ken Thompson 的图灵奖演讲《[Reflections on Trusting Trust](https://www.ece.cmu.edu/~ganger/712.fall02/papers/p761-thompson.pdf)》说的就是这一路上藏东西有多容易，bootstrappable.org 把它列在延伸阅读里。

锁定版 nixpkgs 在 `x86_64-linux` 上的答案是：[`pkgs/stdenv/linux/stage0.nix`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/linux/stage0.nix) 的第 8 到 14 行里，`minbootSupportedSystems = [ "i686-linux" "x86_64-linux" ]`，`if minbootSupported then ...`。支持的系统不再下载一个预编译的 `bootstrap-tools` 压缩包(`else` 分支才是那条旧路)，而是用 `pkgs/os-specific/linux/minimal-bootstrap`，从一个极小的种子，按源码一步步编译到 gcc。这条路线叫 full-source bootstrap。`lab/ch07/bootstrap_seed.sh` 不构建 stdenv，只遍历它的 `.drv` 闭包(`nix-store -qR` 作用在 `stdenv.drvPath` 上)，再只构建(realise)种子这一个文件去量它。

```text
$ head -n 5 out/ch07/bootstrap_seed.stdout
stdenv drv: /nix/store/7ij08xmgibi8qzfra928qds7gjk77kh9-stdenv-linux.drv
derivations in closure: 572
fixed-output (fetched sources, seed, hex0): 137
other (built by a builder): 435
distinct names: 451
```

`stdenv` 的 `.drv` 闭包里有 **572 个** derivation：137 个是固定输出（下载的源码、种子等，第 6 篇的固定输出），435 个由 builder 构建。名字去重后 451 个，多出来的 121 个大概是同一个包在不同阶段重复出现（比如 gcc 要在好几个 stage 里各构建一次，我没有逐个核对）。其中 `bootstrap-stage0-stdenv-linux` 的闭包是 **307 个**，占 53.7%：

```text
== closure of bootstrap-stage0-stdenv-linux (the minimal-bootstrap part)
stage0 drv: /nix/store/cwry7i72nqjr604wlyxpbgqgqlz8ficd-bootstrap-stage0-stdenv-linux.drv
derivations in stage0 closure: 307
bash-2.05b bash-2.05b-builder bash-2.05b.tar.gz bash-5.3 bash-5.3.tar.gz 
bash-static-5.3 binutils-2.46.0 binutils-2.46.0.tar.xz binutils-static-2.46.0 
...
```

这 307 个 derivation 去重后是 236 个名字，lab 把它们打印成 86 行，我挑几行摘出来，它们是这条链上的几个里程碑(`...` 是我省略的行)：

```text
...
kaem-1.9.1 kaem-footer.M1-1.9.1 kaem.hex2-1.9.1 kaem.M1-1.9.1 
...
gawk-5.3.2.tar.gz gawk-mes-3.0.6 gawk-static-5.3.2 gcc-10.4.0 
gcc-10.4.0.tar.xz gcc-15.3.0 gcc-15.3.0.tar.xz gcc-4.6.4 
...
gzip-1.2.4.tar.gz gzip-static-1.14 hex0-1.9.1 hex0-seed hex1-1.9.1 
...
make-4.4.1.tar.gz mbstate.patch mes-0.27.1 mes-0.27.1-builder 
...
tinycc-boot0-unstable-2024-07-07 tinycc-boot0-unstable-2024-07-07-builder 
...
```

最后是种子本身：

```text
== the seed
seed drv: /nix/store/j76if9fyh6aw41qvc8nqr9c8ha4azayn-hex0-seed.drv
seed out: /nix/store/bq4dvl85p02x6ksj1cjn54fa75lr6wyd-hex0-seed
seed size: 229 bytes
first derivation built from it:
/nix/store/zf8dvv680i9z2wpggik614r20n54hyii-hex0-1.9.1.drv
```

**种子是 229 字节**。对比 mini 包集借来的种子，锁定版 nixpkgs 的静态 busybox，1,495,056 字节：1,495,056 除以 229 约等于 6529 倍。mini 在第 6 篇的“只借一个静态 busybox”是个很大的借，真 stdenv 借的只有这 229 字节。

种子长什么样？源码在 [`stage0-posix/hex0.nix`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/os-specific/linux/minimal-bootstrap/stage0-posix/hex0.nix#L20-L36)：

```nix
  # Pinned from https://github.com/oriansj/stage0-posix/commit/45d90f5955b6907dc6cdea9ebafce558359edcd3
  # This 181 byte seed is the only pre-compiled binary in the bootstrap chain.
  hex0-seed = import <nix/fetchurl.nix> {
    name = "hex0-seed";
    url = "https://github.com/oriansj/bootstrap-seeds/raw/cedec6b8066d1db229b6c77d42d120a23c6980ed/POSIX/${stage0Arch}/hex0-seed";
    executable = true;
    inherit hash;
  };
in
derivationWithMeta {
  inherit version;
  pname = "hex0";
  builder = hex0-seed;
  args = [
    "${src}/${stage0Arch}/hex0_${stage0Arch}.hex0"
    (placeholder "out")
  ];
```

三处值得停下来。种子是用**我们已经认识的** `<nix/fetchurl.nix>` 下载的，和 mini 的 `cairn-src` 用的是同一个函数（所以 `hex0-seed` 是 137 个固定输出之一）。`builder = hex0-seed`，**种子本身就是 builder**：它是一个可执行文件，参数是 `hex0` 的源码文件和输出路径，也就是用 hex0 的机器码去“编译”hex0 的十六进制源码。最后，种子的哈希被钉死，**产物**的哈希也被钉死：这个 derivation 本身就是固定输出（`outputHash = hash`，第 48 到 51 行），源码 hex0 被种子翻译出来之后，必须和已知的好结果逐字节一致。

注释里写的是 **181 字节**，实验量出来是 **229 字节**。我去查了原因：同一个 [`bootstrap-seeds`](https://github.com/oriansj/bootstrap-seeds/tree/cedec6b8066d1db229b6c77d42d120a23c6980ed) 仓库在这个提交上，GitHub 的 tree API 给出各架构的 `hex0-seed` 大小是：`POSIX/x86` 181 字节，`POSIX/AMD64` 229 字节(还有 `POSIX/AArch64` 526、`POSIX/riscv32` 356、`POSIX/riscv64` 392)。这几个数字是我用 GitHub API 临时查的，不在 `lab/ch07/` 里，你可以自己查一遍。`platforms.nix` 把 `x86_64-linux` 映射到 `AMD64`、`i686-linux` 映射到 `x86`。所以注释里的 181 对应的是 32 位 x86 的种子，我的 `x86_64-linux` 下载的是 229 字节的 AMD64 种子。注释大概是按最先支持的 x86 写的，我没有查它的提交历史，这一句是推断。种子仓库的 [README](https://github.com/oriansj/bootstrap-seeds/blob/cedec6b8066d1db229b6c77d42d120a23c6980ed/README.md) 开头一行是 “NEVER TRUST ANYTHING IN HERE”，后面解释 hex0 可以用 `sed 's/[;#].*$//g' $input_file | xxd -r -p > $output_file` 近似：去掉注释，把十六进制文本转成字节。所以我猜这 229 字节的二进制做的就是 `xxd -r -p` 这一件事。

接着是 `hex0-1.9.1.drv`，lab 输出里“first derivation built from it”那一行：第一个由种子**构建**出来的 derivation。名字里的 1.9.1 是 stage0-posix 的版本（`bootstrap-sources.nix` 里 `version = "1.9.1"`），它的源码本身也是一个固定输出（307 个里的 `stage0-posix-1.9.1-source`）。输出里能看到一个梯子：`hex0`、`hex1`、`hex2`、`M0`、`M1`、`M2`、`kaem`。我没有逐个读它们的源码，下面是从名字推断的：`hex1`、`hex2` 大概是一级比一级方便的汇编和链接工具，`M2` 那一级开始能编译 C，`kaem` 大概是种子 README 里提到的、用 hex0 写的那类最小 shell。stage0-posix 项目的仓库在[这里](https://github.com/oriansj/stage0-posix)。

在 `kaem` 之上，名字里出现 `mes`、`nyacc`、`tinycc-boot0` 到 `tinycc-boot3`、`bash-2.05b`、`gnused`、`coreutils-5.0` 这些，然后是 `gcc-4.6.4`、`gcc-10.4.0`、`gcc-15.3.0`、`glibc-2.42`、`musl-1.2.6`。其中 `mes` 的 [`default.nix`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/os-specific/linux/minimal-bootstrap/mes/default.nix) 确实用 `kaem.runCommand` 来构建它。顺序我从 [`minimal-bootstrap/default.nix` 的 141 到 171 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/os-specific/linux/minimal-bootstrap/default.nix#L141-L171)确认了其中一段：`gcc46` 用 `tinycc-musl` 编译，`gcc46-cxx` 用 `gcc46`，`gcc10` 用 `gcc46-cxx`，`gcc-latest-unwrapped`(15.3.0)用 `gcc10`。也就是 tinycc、gcc 4.6.4、gcc 10.4.0、gcc 15.3.0 这样一级套一级，每一个都是用上一个编译出来的。这条路线和 [live-bootstrap](https://github.com/fosslinux/live-bootstrap) 项目有渊源，这一点有源码为证：nixpkgs 里有明确的致谢，比如 `bash/2.nix` 的注释写着 “Thanks to the live-bootstrap project!”。

stage0 做完，才是 nixpkgs 熟悉的那几级：`bootstrap-stage1`，`bootstrap-stage-xgcc`，`bootstrap-stage2` 到 `bootstrap-stage4`，最后一级叫 `stdenv-linux`（[`stdenv/linux/default.nix` 的 279、328、443、550、618 和 691 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/linux/default.nix#L691)）。这个文件开头写着引导要达到的目标：“final stdenv must not reference any of the bootstrap files”，并且在 [724 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/linux/default.nix#L724)给最终的 stdenv 设了 `disallowedRequisites = stage0.disallowedInFinalStdenv`：只要最终 stdenv 的闭包里混进了任何一个 `minimal-bootstrap` 的输出，构建就会失败。梯子爬完之后，被踢掉了。

这给了我一个新的看 mini 的角度：mini 借的 busybox 和 nixpkgs 的 stage0 是同一类东西，一个“不是我们自己造的二进制”。区别是量：1,495,056 字节对 229 字节，一个二进制文件对一个 572 个 derivation 的梯子。如果有朝一日你想让 mini 也能自举，思路和 nixpkgs 一样：先有一个更小的种子。

## mini 和 nixpkgs 的 stdenv，并排

| | mini | nixpkgs（锁定版） |
| --- | --- | --- |
| builder | `busybox sh`，参数 `setup.sh` | stdenv 里的 bash，参数 `-e source-stdenv.sh default-builder.sh` |
| `setup.sh` 行数 | 63 | 1839 |
| 函数定义数 | 3 | 64 |
| 解释器 | POSIX sh(busybox) | bash |
| 阶段 | 5 个，写死 | 9 个，可整体替换，有 `pre*Phases` 插槽 |
| 跳过阶段 | 无 | `dont*`、`do*` |
| hook | 无 | `pre*`、`post*`，以及 setup hook、env hook |
| 依赖 | `buildInputs` 一个列表，只加 `PATH` | 六个列表加传播版本，按 host/target 偏移激活，`strictDeps` |
| 输出 | 只有 `out` | 多输出，`multiple-outputs.sh` 自动分流 |
| 解包 | 目录复制，`tar xf` | `unpackCmdHooks`，按扩展名选解压方式，多个 `srcs` |
| 修 shebang | `sed` 改第一行 | `patchShebangs`，以及十几个别的 fixup hook |
| 编译器 | 没有 | `cc-wrapper`(`pkgs/build-support/cc-wrapper`)包着的 gcc |
| 种子 | 1,495,056 字节的静态 busybox | 229 字节的 hex0 |
| 引导 | 一步 | 307 个 derivation 的 stage0，加 stage1 到 stage4 |
| 规模 | 5 个包，最大的闭包是 `cairn-src` 的 1,798,176 字节 | `stdenv` 的 `.drv` 闭包有 572 个 derivation |

要说 mini 少了什么，其实全在这张表右边的那一列：编译器、输出分流、交叉编译的分类、hook。我觉得最有教育意义的是左边的“少”：一个包能用一个 29 行函数加一个 63 行脚本跑起来，所以 nixpkgs 那 1839 行里的每一块，都是某个包的某个具体需求长出来的，它不是一块魔法。

## 让我意外的事

**我以为 `phases: buildPhase` 是 `hello` 的。** 实验的输出里它出现了两次，我盯着看了一会儿，想不通 `hello` 为什么只有一个阶段。后来去 `mkshell/default.nix` 里找到了 `phases = attrs.phases or [ "buildPhase" ]`：是我自己的 Firn 开发环境导出了这个变量，实验的子进程继承了它。写一个 stdenv 实验，结果被我自己的 stdenv 实验环境污染了，这个讽刺我觉得值得留着。它也说明了一件事：stdenv 的 `phases` 是个普通的环境变量，谁都可以在外面设。

**`site` 的闭包是 544 字节。** 构建时我用了三个包、一个 busybox，输出的闭包里一个也没有。`buildInputs` 和闭包是两个概念，我以前把它们混为一谈。这个差别在 mini 里一眼就能看出来，因为 mini 的包小到你能把 `.drv` 和输出都读完；在 nixpkgs 里，`hello` 的 5 个路径和 `curl` 的 11 个传播依赖，你得靠 `nix path-info -r` 才分得清。

**整个 572 个 derivation 的 stdenv 的根，是一个 229 字节的文件。** 我读 `hex0.nix` 时看到注释写着 181 字节，去量了一下是 229，又去查了才知道那是 32 位 x86 的种子。nixpkgs 里有一条注释和代码不一致，而我之前从来没想过去核对一条注释。相比之下 mini 借的静态 busybox 是它的 6529 倍大，这让我对“从零”这两个字重新有了概念：从零写 stdenv 我只花了 92 行（29 加 63），从零写一条编译器的引导链，nixpkgs 花了 307 个 derivation。

## 检查点

在 `~/firn` 里，`nix develop` 之内：

```bash
make ch07
make lint
make check
for f in mini/stdenv/default.nix mini/stdenv/setup.sh \
  mini/pkgs/*.nix mini/pkgs/site/index.md lab/ch07/*.nix lab/ch07/*.sh; do
  diff <(git -C ~/firn-ref show ch07:"${f}") "${f}" && echo "same ${f}"
done
```

我的环境里设了 `CI=true`，下面的输出是 `env -u CI make ch07`（这一章没有 `_host` 实验，所以设不设 `CI` 输出一样）。`make ch07` 应当打印这 16 行：

```text
bash scripts/chapter.sh ch07
ok   lab/ch07/bootstrap_seed.sh
ok   lab/ch07/breakpoint_hook.sh
ok   lab/ch07/callpackage_by_hand.nix
ok   lab/ch07/ex_mini_figlet.nix
ok   lab/ch07/mini_build.sh
ok   lab/ch07/mini_drv_env.sh
ok   lab/ch07/mini_overlay.nix
ok   lab/ch07/multiple_outputs.sh
ok   lab/ch07/path_entry.nix
ok   lab/ch07/phases_log.sh
ok   lab/ch07/propagation.nix
ok   lab/ch07/real_stdenv_phases.sh
ok   lab/ch07/setup_hooks.sh
ok   lab/ch07/setup_sizes.sh
ok   lab/ch07/source_stdenv.sh
```

这一章没有 `_fail` 实验，15 个全是正常退出 0。第一次跑会慢：`mini_build.sh` 要构建 mini 的五个包、下载 cairn ch10 的源码包，`real_stdenv_phases.sh` 要编译一遍 `hello`，`breakpoint_hook.sh` 固定要等 20 秒，`bootstrap_seed.sh` 只构建(下载)229 字节的种子，不构建 stdenv，其余大多只是求值。再跑走缓存。

`make lint` 只回显它跑的几条命令（`nixfmt --check`、`deadnix --fail`、`shellcheck`、`shfmt`；`statix` 那一行以 `@` 开头，`make` 不回显它），没有任何诊断，退出码 0。`make check` 以 `all checks passed!` 结束，退出码 0，这一次检查项多了 `mini-site`（`dev-shell`、`lib-tests`、`readme-table`、`mini-site` 四项），并且在 `checking flake output 'legacyPackages'...` 那一步评估了新增的 `legacyPackages`。因为都已经在缓存里，它打印 `running 0 flake checks...`，最后一行警告 `The check omitted these incompatible systems: aarch64-linux` 是 `nix flake check` 默认只查当前系统。

`diff` 循环应当打印 23 行 `same ...`，不打印 diff：8 个 `mini/` 文件、15 个实验。`flake.nix` 和 `mini/default.nix` 不在循环里，它们是下面的“中间版本”。`mini/seed.nix` 和 `mini/raw.nix` 是第 6 篇的，没有动。

**必须和标签一致的文件：** `mini/stdenv/default.nix`、`mini/stdenv/setup.sh`、`mini/pkgs/` 下的五个 `.nix` 和 `site/index.md`，以及 `lab/ch07/` 下全部 15 个实验。

**中间版本(后面的章节会继续改)：** [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch07/flake.nix)：这一章加了 `miniFor`、`legacyPackages` 和 `checks.<system>.mini-site`。第 8 篇会把它重排(`forAllSystems`、每个输出一行注释)，并加上 `apps` 和 `formatter`；之后每个加包的章节还会往里加输出。[`mini/default.nix`](https://github.com/bfmhno3/firn/blob/ch07/mini/default.nix)：现在是 25 行，第 20 篇会再加一个 `nondeterministic` 包。

### 文件清单

这一篇的所有文件都在仓库里，链接指向标签 `ch07` 上的那一份。这张表和 `git diff --name-only ch06 ch07` 的 25 行一一对应：1 个 `flake.nix`、9 个 `mini/` 文件、15 个 `lab/ch07/` 文件(没有 fixture)。实验用 `make ch07` 跑；`lab/ch07/*.sh` 需要 `FIRN_ROOT` 和 `LAB_TMP`，所以不单独运行。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch07/flake.nix) | `make check` | 退出码 0，`all checks passed!`；多出 `legacyPackages.<system>.mini` 和 `checks.<system>.mini-site` |
| [`mini/default.nix`](https://github.com/bfmhno3/firn/blob/ch07/mini/default.nix) | `make ch07` | 25 行；`callpackage_by_hand.nix` 里 `setAttrNames` 是 10 个名字 |
| [`mini/stdenv/default.nix`](https://github.com/bfmhno3/firn/blob/ch07/mini/stdenv/default.nix) | `make ch07` | 29 行；`mini_drv_env.stdout` 里 `builder` 是 busybox 的 `sh` |
| [`mini/stdenv/setup.sh`](https://github.com/bfmhno3/firn/blob/ch07/mini/stdenv/setup.sh) | `make ch07` | 63 行，3 个函数；`phases_log.stdout` 里 5 行 `== phase` |
| [`mini/pkgs/greeting.nix`](https://github.com/bfmhno3/firn/blob/ch07/mini/pkgs/greeting.nix) | `make ch07` | 12 行；闭包 472 字节 |
| [`mini/pkgs/hello.nix`](https://github.com/bfmhno3/firn/blob/ch07/mini/pkgs/hello.nix) | `make ch07` | 14 行；闭包 1,496,288 字节，3 个路径 |
| [`mini/pkgs/wordfreq.nix`](https://github.com/bfmhno3/firn/blob/ch07/mini/pkgs/wordfreq.nix) | `make ch07` | 22 行；闭包 1,496,048 字节 |
| [`mini/pkgs/cairn-src.nix`](https://github.com/bfmhno3/firn/blob/ch07/mini/pkgs/cairn-src.nix) | `make ch07` | 24 行；闭包 1,798,176 字节 |
| [`mini/pkgs/site.nix`](https://github.com/bfmhno3/firn/blob/ch07/mini/pkgs/site.nix) | `make check` | 34 行；`mini-site` 通过；闭包只有 544 字节 |
| [`mini/pkgs/site/index.md`](https://github.com/bfmhno3/firn/blob/ch07/mini/pkgs/site/index.md) | `make check` | 11 行，页面模板，被 `site.nix` 当 `src`；不是脚本 |
| [`lab/ch07/bootstrap_seed.sh`](https://github.com/bfmhno3/firn/blob/ch07/lab/ch07/bootstrap_seed.sh) | `make ch07` | 退出码 0；572 个 `.drv`，137 个固定输出，stage0 的闭包 307 个，`seed size: 229 bytes` |
| [`lab/ch07/breakpoint_hook.sh`](https://github.com/bfmhno3/firn/blob/ch07/lab/ch07/breakpoint_hook.sh) | `make ch07` | 退出码 0；`failed in unknown with exit code 1`，`error: timed out after 20 seconds`，`nix build exit status: 1`；固定耗时 20 秒 |
| [`lab/ch07/callpackage_by_hand.nix`](https://github.com/bfmhno3/firn/blob/ch07/lab/ch07/callpackage_by_hand.nix) | `make ch07` | 退出码 0；`suppliedNames` 4 个，`sameOutPath = true` |
| [`lab/ch07/ex_mini_figlet.nix`](https://github.com/bfmhno3/firn/blob/ch07/lab/ch07/ex_mini_figlet.nix) | `make ch07` | 退出码 0；`[ "+-----------------+" "\| Hello from mini \|" "+-----------------+" ]`，练习 1 |
| [`lab/ch07/mini_build.sh`](https://github.com/bfmhno3/firn/blob/ch07/lab/ch07/mini_build.sh) | `make ch07` | 退出码 0；五个闭包只含 busybox 和 mini 路径 |
| [`lab/ch07/mini_drv_env.sh`](https://github.com/bfmhno3/firn/blob/ch07/lab/ch07/mini_drv_env.sh) | `make ch07` | 退出码 0；`buildInputs` 是 `""`，`args` 是 `...-setup.sh` |
| [`lab/ch07/mini_overlay.nix`](https://github.com/bfmhno3/firn/blob/ch07/lab/ch07/mini_overlay.nix) | `make ch07` | 退出码 0；`{ greeting = true; hello = true; site = true; wordfreq = false; }` |
| [`lab/ch07/multiple_outputs.sh`](https://github.com/bfmhno3/firn/blob/ch07/lab/ch07/multiple_outputs.sh) | `make ch07` | 退出码 0；`outputs: ["out","dev","static"]`，`out` 闭包 37,850,496 字节，`dev` 闭包 38,126,240 字节 |
| [`lab/ch07/path_entry.nix`](https://github.com/bfmhno3/firn/blob/ch07/lab/ch07/path_entry.nix) | `make ch07` | 退出码 0；`paths` 两项都是 `pkgs/build-support/setup-hooks/separate-debug-info.sh`，`curl` 和 `python3` 的 `separateDebugInfo` 都是 `true` |
| [`lab/ch07/phases_log.sh`](https://github.com/bfmhno3/firn/blob/ch07/lab/ch07/phases_log.sh) | `make ch07` | 退出码 0；5 行 `== phase`，标准错误里是 `got build log for ... from 'daemon'` |
| [`lab/ch07/propagation.nix`](https://github.com/bfmhno3/firn/blob/ch07/lab/ch07/propagation.nix) | `make ch07` | 退出码 0；`curl` 的 `strictDeps = true`，`hello` 的是 `false`，`libpng` 传播 `zlib-1.3.2` |
| [`lab/ch07/real_stdenv_phases.sh`](https://github.com/bfmhno3/firn/blob/ch07/lab/ch07/real_stdenv_phases.sh) | `make ch07` | 退出码 0；`type: unpackPhase: not found`，然后是 `hello` 的 `make` 输出，两次 `phases: buildPhase` |
| [`lab/ch07/setup_hooks.sh`](https://github.com/bfmhno3/firn/blob/ch07/lab/ch07/setup_hooks.sh) | `make ch07` | 退出码 0；`PKG_CONFIG_PATH` 指向 `zlib-1.3.2-dev/share/pkgconfig`，`pkg-config --modversion zlib` 是 `1.3.2` |
| [`lab/ch07/setup_sizes.sh`](https://github.com/bfmhno3/firn/blob/ch07/lab/ch07/setup_sizes.sh) | `make ch07` | 退出码 0；`mini: 63`、`nixpkgs: 1839`，函数 3 对 64 |
| [`lab/ch07/source_stdenv.sh`](https://github.com/bfmhno3/firn/blob/ch07/lab/ch07/source_stdenv.sh) | `make ch07` | 退出码 0；`source-stdenv.sh` 3 行，`default-builder.sh` 1 行；最长的函数 `findInputs` 92 行，`runHook` 15 行，`exitHandler` 33 行 |

## 练习

**1.** 给 mini 加一个包 `figlet`，用 `awk` 把 `greeting` 装进字符框，求值时把框打印出来。不要改 `mini/` 下任何已有文件，用 `callPackage` 在实验里加。

<details>
<summary>参考答案</summary>

这就是 `lab/ch07/ex_mini_figlet.nix`，核心是用 `mini.callPackage` 现场接一个函数：

```nix
  figlet = mini.callPackage (
    { mkDerivation, greeting }:
    mkDerivation {
      name = "figlet";
      installPhase = ''
        mkdir -p "$out/share"
        awk '
          {
            bar = "+"
            for (i = 0; i < length($0) + 2; i++) bar = bar "-"
            bar = bar "+"
            print bar
            print "| " $0 " |"
            print bar
          }
        ' ${greeting}/share/greeting.txt > "$out/share/figlet.txt"
      '';
    }
  ) { };
```

整个函数只声明了 `mkDerivation` 和 `greeting` 两个参数，`callPackage` 就从包集里取出这两项。`awk` 在 busybox 里。求值最后用 `builtins.readFile` 读回构建结果（import from derivation，第 4 篇讲过，只在实验里用）：

```text
$ cat out/ch07/ex_mini_figlet.stdout
[ "+-----------------+" "| Hello from mini |" "+-----------------+" ]
```

注意 `${greeting}/share/greeting.txt` 是 Nix 插值，所以 `figlet` 的输出会带着对 `greeting` 的引用，这和 `hello` 一样。

</details>

**2.** 一个包什么都不设，`stdenv.mkDerivation` 默认会跑 `definePhases` 里 9 个阶段里的哪几个？依据 `setup.sh` 的哪几行？

<details>
<summary>参考答案</summary>

跑 6 个：`unpack`、`patch`、`configure`、`build`、`install`、`fixup`。跳过 3 个：`check`、`installCheck`、`dist`。依据是 `runPhase` 的 [1745 到 1753 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L1745-L1753)：前面的六个只在对应的 `dont*` 变量非空时才 `return`，默认没人设，就会跑；`checkPhase`、`installCheckPhase`、`distPhase` 要 `doCheck`、`doInstallCheck`、`doDist` 非空才跑，默认不设，就跳过。（`doCheck` 的默认值在 `make-derivation.nix` 里是 `doCheckByDefault`，所以这是 `setup.sh` 层面的答案，具体的包可能设了 `doCheck = true`。）

</details>

**3.** 为什么 mini 的 `hello` 闭包里有 `greeting`，而 `site` 的闭包里没有 `hello`？

<details>
<summary>参考答案</summary>

引用扫描只看**输出的内容**。`hello` 的 `installPhase` 用 `${greeting}` 把路径写进了输出里的脚本，所以 `greeting` 在它的闭包里（`mini_build.stdout`：3 个路径，1,496,288 字节）；`site` 的输出只有一个 HTML 文件，里面没有任何 store 路径，闭包只有它自己（544 字节），尽管它构建时用了 `hello`（`mini_drv_env.stdout` 里 `hello` 的 `buildInputs` 是空串，而 `site.nix` 的 `buildInputs` 里有 `hello` 和 `wordfreq`）。`buildInputs` 决定构建时能用什么，引用扫描决定运行时依赖什么，两个是独立的集合。

</details>

**4.** `findInputs` 的开头有一行 `(( hostOffset <= targetOffset )) || exit 1`。这对 `-1 0 1` 三个偏移意味着哪几个组合不存在？

<details>
<summary>参考答案</summary>

偏移是 (host, target)，要求 host 不大于 target。9 个组合里合法的是 (-1,-1)、(-1,0)、(-1,1)、(0,0)、(0,1)、(1,1) 六个，恰好对应 808 到 825 行的六个循环；不合法的是 (0,-1)、(1,-1)、(1,0) 三个，也就是依赖的 host 比 target 更“晚”。手册的说法是 “we prohibit dependencies from a "later" platform to an earlier platform to limit confusion because we've never seen a legitimate use for them”（交叉编译一章，`doc/stdenv/cross-compilation.chapter.md`）。所以没有 `depsHostBuild` 之类的名字，也不需要。

</details>

**5.** 按 `bootstrap_seed.sh` 的输出，572 个 `.drv` 里固定输出占多大比例？`bootstrap-stage0-stdenv-linux` 的闭包占多大比例？

<details>
<summary>参考答案</summary>

固定输出 137 个，137 除以 572 约等于 23.95%，也就是将近四分之一的 `.drv` 是“从外面下载一个东西”（源码包、补丁、种子）。stage0 的闭包 307 个，307 除以 572 约等于 53.67%。这两个集合有很大的重叠：stage0 里的很多名字是 `.tar.gz`、`.tar.xz`、`.patch`（见上面列表），都是固定输出。我没有算两个集合的精确交集。

</details>

## 下一篇

这一篇我们造了一个包集，它的所有东西都在 `legacyPackages.<system>.mini` 下面，而 `flake.nix` 里为它加的几行是我手写的、没有整理过的：`miniFor` 在每个系统上各建一份，`checks` 和 `legacyPackages` 各自 `forAllSystems`。下一篇，第 8 篇，《flake：inputs、outputs、flake.lock 与纯求值》，我们把 `flake.nix` 从头读一遍：`inputs` 和 `outputs` 是什么，`flake.lock` 里记了什么，为什么一个没被 `git add` 的文件在 flake 里会“不存在”，`nix eval` 在纯求值模式下为什么不让你碰 `builtins.currentSystem`，以及这个“实验性”的功能为什么五年来一直是我日常的地基。到那时，你会看到这篇里那一行 `legacyPackages.<system>.mini` 在 `nix flake show` 里是什么样子。
