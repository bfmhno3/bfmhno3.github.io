---
title: "nixpkgs：callPackage、override、overlay 与 fetcher"
commentId: "post:nix-by-firn-10-callpackage-overrides-overlays"
published: "2026-11-05 22:00:00 +08:00"
description: "用 Firn 从零学 Nix 第 10 篇：我用 Nix 2.34.9 和钉死的 nixpkgs 56c02bc 把一个 47 行的 C 程序打成 firn-hello，用 14 个实验把 callPackage、override、overrideAttrs、overlay、fetcher、lib.fileset 和 cc-wrapper 各拆了一遍：在 overlay 里改一个 zlib，firn-hello 要重建 100 个 derivation；只对 firn-hello 自己 override，只要 2 个。"
category: Tutorial
tags:
  - Nix
  - NixOS
  - Firn
  - nixpkgs
  - overlay
  - fetcher
series: "用 Firn 从零学 Nix"
seriesOrder: 10
draft: false
comment: true
slug: nix-by-firn-10-callpackage-overrides-overlays
---

我的 NixOS 机器上到处是 `pkgs.callPackage ./foo.nix { }`、`overrideAttrs (old: ...)` 和 `final: prev: { ... }`，我复制过很多次，从来没认真问过 `final` 和 `prev` 差在哪，也说不清 `override` 和 `overrideAttrs` 为什么是两个东西。这一篇我自己写一个包，把这几样东西拆开。包很小：47 行 C，链接 zlib，打印一句问候和这句问候的 crc32。同一份源码，只改 `greeting` 这一个参数：

```text
$ nix run .#firn-hello -- nix
Hello, nix, from firn-hello 0.1.0
crc32: 8bb8f4d3
$ nix run .#firn-hello-hallo -- nix
Hallo, nix, from firn-hello 0.1.0
crc32: fa32eef9
```

（这两条是手敲的，不在 `lab/ch10/` 里；下面手敲的命令我都这样标。）

> [!NOTE] 本篇检查点
> 这一篇结束时，Firn 仓库的标签 `ch10` 里：新增 `src/firn-hello/`（`firn-hello.c` 47 行，`Makefile` 20 行）、`pkgs/firn-hello/package.nix`（52 行）、`overlays/default.nix`（3 行）；`nix/pkgs.nix` 的 `overlays` 默认值变成 `[ (import ../overlays) ]`；`default.nix` 多了 `firn-hello`；`flake.nix` 多了 `overlays.default`、`packages.<system>.{firn-hello,firn-hello-hallo,default}` 和每个包一个的 `checks.<system>.pkg-<name>`；`lab/ch10/` 下有 14 个实验（6 个 `.nix`，8 个 `.sh`，其中 `overlay_final_recursion_fail.nix` 按设计失败）和 9 个 fixture 文件。`make ch10` 通过，`make lint` 和 `make check` 干净。`default.nix`、`flake.nix` 和 `overlays/default.nix` 以后每个加包的章节都会继续改，`pkgs/firn-hello/package.nix` 只有第 12 篇交叉编译暴露真 bug 时才可能改，其余文件在这一章之后我不打算再动；
> 涉及的 Nix 特性：`callPackage` 与 `lib.callPackageWith`、`builtins.functionArgs`、`override`、`overrideAttrs`、`lib.overrideDerivation`、`finalAttrs`、overlay 的 `final` 与 `prev`、`lib.composeManyExtensions`、`import nixpkgs { overlays; config; }`、`allowUnfree`、`fetchurl`、`fetchFromGitHub`、`fetchgit`、固定输出 derivation 的 `flat` 与 `nar` 哈希、`lib.fakeHash`、`nurl`、`nix-prefetch-url`、`nix hash convert`、`lib.fileset`、`meta`、`nix log`、cc-wrapper（`NIX_CFLAGS_COMPILE`、rpath、加固），以及 `pkgs/by-name` 的预览。
> 前置：[第 9 篇：两代 CLI：nix-env、nix-build、nix-shell 与 nix profile](/posts/nix-by-firn-09-cli-generations/)。上一篇结尾留下的问题，“`-A hello` 里那个 `hello` 是怎么写出来的”，这一篇从自己写一个开始回答。

两个包的输出路径不一样（`w1z9af05...` 和 `kvhqb82g...`），crc32 也跟着变，因为 crc32 算的正是第一行。`firn-hello-hallo` 在 `flake.nix` 里只有一行 `.override { greeting = "Hallo"; }`。这一篇要回答的就是这一行背后发生了什么：谁调用了 `package.nix`、谁把 `greeting` 换掉、换掉之后哪些东西要重建，以及为什么在 overlay 里改一个无关紧要的 `zlib` 会让编译器也跟着重建。

## 环境

这一篇所有输出都来自这台机器：NixOS 26.05，上游 Nix 2.34.9（不是 Determinate），nixpkgs 钉在 `56c02bc00adcf003215cc4bd996d6efaf4cff188`（`flake.lock` 里的 `lastModified` 是 2026-08-23），`x86_64-linux`。在这个 rev 上 gcc 是 15.3.0，glibc 是 2.42，zlib 是 1.3.2。文中引用的 nixpkgs 源码都链接到这个 rev，Nix 源码链接到 [2.34.9 标签](https://github.com/NixOS/nix/tree/2.34.9)，行号都核对过。

我的 shell 里设了 `CI=true`，Firn 的运行器会据此跳过 `_host` 实验。第 10 章没有 `_host` 实验，但三个要联网的实验 (`fetchers.sh`, `tarball_vs_nar.sh`, `overlay_rebuild_scope.sh`) 在连不上 GitHub 或 cache.nixos.org 时会打印 `offline:` 然后以 0 退出，所以我和第 9 篇一样，跑的是 `env -u CI make ch10`，整条命令（含 `nix develop` 启动）花了 247 秒。

## firn-hello：47 行 C，和一个留了后门的 Makefile

`src/firn-hello/firn-hello.c` 做三件事：从宏 `FIRN_GREETING` 拿到问候词（没给就是 `"Hello"`），拼出 `<GREETING>, <NAME or world>, from firn-hello 0.1.0`，再调 zlib 的 `crc32()` 算这一行的校验和。它按 Linux 内核风格写，所以缩进是 tab：

```c
#ifndef FIRN_GREETING
#define FIRN_GREETING "Hello"
#endif

#define FIRN_VERSION "0.1.0"
#define USAGE "usage: firn-hello [--version] [NAME]\n"
/* ... */
	len = snprintf(line, sizeof(line), "%s, %s, from firn-hello %s",
		       FIRN_GREETING, argc == 2 ? argv[1] : "world",
		       FIRN_VERSION);
	if (len < 0 || (size_t)len >= sizeof(line)) {
		fputs("firn-hello: name too long\n", stderr);
		return 2;
	}

	crc = crc32(0L, (const Bytef *)line, (uInt)len);
	printf("%s\ncrc32: %08lx\n", line, crc);
```

问候词不是运行时参数，是编译时的宏。这是故意的：我要一个“改一个参数就得到一个不同的包”的例子，而不是一个读环境变量的程序。`package.nix` 会传 `-DFIRN_GREETING=...`，没传就是 `"Hello"`。

Makefile 里最要紧的是三行 `?=`：

```make
CFLAGS ?= -O2 -Wall -Wextra
ZLIB_CFLAGS ?= $(shell $(PKG_CONFIG) --cflags zlib)
ZLIB_LIBS ?= $(shell $(PKG_CONFIG) --libs zlib)
```

`?=` 的意思是“环境或命令行没给，才用右边的值”。`ZLIB_CFLAGS` 和 `ZLIB_LIBS` 默认问 `pkg-config`，但调用者可以直接覆盖它们：`make ZLIB_LIBS=-lz`。为什么要留这个后门，要到 cc-wrapper 那一节才能说清楚，先记下 `package.nix` 真的覆盖了它。在 `nix develop` 给 `firn-hello` 准备的构建环境里让 `make -n` 只打印要跑的命令，能看到不覆盖时 pkg-config 给出了什么（手敲，不在 `lab/ch10/` 里）：

```text
$ nix develop --file nix/pkgs.nix firn-hello --command make -n -C src/firn-hello PREFIX=/tmp/x
make: Entering directory '/home/bfmhno3/Projects/firn/src/firn-hello'
gcc -O2 -Wall -Wextra -I/nix/store/dfb5jybg1sakjy1zahpgrxfqmz5rfwmc-zlib-1.3.2-dev/include -o firn-hello firn-hello.c -L/nix/store/0c5qg74fw50vz6scy5dn2zm6h2bvsscn-zlib-1.3.2-static/lib -L/nix/store/zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb-zlib-1.3.2/lib -lz
make: Leaving directory '/home/bfmhno3/Projects/firn/src/firn-hello'
```

注意两个 `-L`：先是 `...-zlib-1.3.2-static/lib`，然后才是 `...-zlib-1.3.2/lib`。先放着，它会回来。

## package.nix：一个函数，三类参数

`pkgs/firn-hello/package.nix` 有 52 行，我分五块看。第一块是它的签名和 `mkDerivation` 的开头：

```nix
{
  lib,
  stdenv,
  pkg-config,
  zlib,
  greeting ? "Hello",
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "firn-hello";
  version = "0.1.0";
```

它是一个函数，参数是一个属性集，五个名字里 `lib`、`stdenv`、`pkg-config`、`zlib` 是“依赖”，nixpkgs 里有同名的属性；`greeting` 是“旋钮”，nixpkgs 里没有叫这个名字的包，所以它走默认值 `"Hello"`，除非有人显式传一个。谁来区分这两类，下一节讲。

`mkDerivation` 收到的是 `(finalAttrs: { ... })`，一个函数而不是一个属性集。`finalAttrs` 是这组属性自己的最终版本，包括别人事后 `overrideAttrs` 加上去的改动，和第 3 篇的 `fix` 是同一个技巧；后面有一节专门看它在源码里长什么样。

第二块是源码：

```nix
  src = lib.fileset.toSource {
    root = ../../src/firn-hello;
    fileset = lib.fileset.unions [
      ../../src/firn-hello/firn-hello.c
      ../../src/firn-hello/Makefile
    ];
  };
```

`src` 不是 `../../src/firn-hello` 整个目录，而是 `lib.fileset.toSource` 从那里只挑出两个文件：目录里别的东西（比如一个 README）变了，`src` 的 store 路径不会变，后面有一节验证。

第三块是构建，这一块最啰嗦：

```nix
  nativeBuildInputs = [ pkg-config ];
  buildInputs = [ zlib ];

  # pkg-config 的 zlib.pc 把 static 输出的目录排在前面，-lz 会选中 libz.a；
  # 这里用 -lz 配合 cc-wrapper 的 -L，让它动态链接 libz.so。
  makeFlags = [
    "PREFIX=${placeholder "out"}"
    "ZLIB_LIBS=-lz"
  ];

  env.NIX_CFLAGS_COMPILE = "-DFIRN_GREETING=\"${greeting}\"";

  strictDeps = true;
```

`makeFlags` 传给 `make`：`PREFIX` 用 `placeholder "out"`（求值时输出路径还没有定，它先生成一个占位符，构建时才换成真路径），`ZLIB_LIBS=-lz` 是上一节那个后门，覆盖 `pkg-config --libs zlib` 的结果。

问候词走的是 `env.NIX_CFLAGS_COMPILE`，不是 `makeFlags` 里的 `CFLAGS=...`：Makefile 里的 `CFLAGS ?= -O2 -Wall -Wextra` 会被命令行的 `CFLAGS=` 整个替掉，而 `NIX_CFLAGS_COMPILE` 是 cc-wrapper 在编译器命令行末尾追加的，不动 Makefile 里的警告选项。`strictDeps = true` 让 `nativeBuildInputs`（构建机上跑的工具，`pkg-config`）和 `buildInputs`（链进产物的库，`zlib`）严格分开，第 12 篇讲交叉编译时会用到这个区分。

第四块是安装后检查：

```nix
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    first="$("$out/bin/${finalAttrs.meta.mainProgram}" nix | head -n 1)"
    test "$first" = '${greeting}, nix, from firn-hello 0.1.0'
    runHook postInstallCheck
  '';
```

`doInstallCheck = true` 打开 `installCheckPhase`，它在安装之后、`fixupPhase` 之后跑。我让它真的运行刚装好的程序，检查第一行是不是 `${greeting}, nix, from firn-hello 0.1.0`。这里有一个细节要先说在前面：`0.1.0` 是写死的，没有用 `finalAttrs.version`。原因是 C 源码里 `#define FIRN_VERSION "0.1.0"` 也是写死的，程序打印的版本号和 Nix 里的 `version` 属性本来就没有连起来。这个后果在 override 那一节会出来。

`${finalAttrs.meta.mainProgram}` 倒是用上了 `finalAttrs`：这样别人改了 `meta.mainProgram`，检查跟着走。

第五块是 `meta`：

```nix
  meta = {
    description = "Greeting program that prints a zlib crc32 of its first line";
    license = [
      lib.licenses.mit
      lib.licenses.asl20
    ];
    mainProgram = "firn-hello";
    platforms = lib.platforms.unix;
  };
})
```

`meta` 不影响构建出来的东西，它是写给人和工具看的：一句话描述、许可证、`nix run` 找哪个可执行文件（`mainProgram`，[`src/nix/app.cc` 第 111 到 113 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/app.cc#L111-L113)先取 `meta.mainProgram`，没有再取 `pname`，再没有才从 `name` 里拆）、在哪些平台可用。我把 `meta` 实际输出的 JSON 放在后面 `nix log` 那一节旁边。

## callPackage：从参数名猜依赖

`package.nix` 是一个函数，总得有人调用它，并且知道 `lib`、`stdenv`、`pkg-config`、`zlib` 该传什么。`overlays/default.nix` 里只有三行：

```nix
final: _prev: {
  firn-hello = final.callPackage ../pkgs/firn-hello/package.nix { };
}
```

`final.callPackage ../pkgs/firn-hello/package.nix { }`：第一个参数是函数（或者一个文件路径，`callPackage` 会 `import` 它），第二个参数是显式给的参数，这里是空。第 7 篇我给 mini 包集手写过一个三行的 `callPackage`，nixpkgs 里的真货在 [`lib/customisation.nix` 第 267 到 330 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/customisation.nix#L267-L330)。`lab/ch10/callpackage_source.sh` 把其中核心的一段从钉死的 nixpkgs 里直接摘出来：

```text
$ sed -n '1,/abort (makeErrorMessage/p' out/ch10/callpackage_source.stdout
== lib/customisation.nix: callPackageWith (core)
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
    else
      # Only show the error for the first missing argument
      # This needs to be an abort so it can't be caught with `builtins.tryEval`,
      # which is used by nix-env and ofborg to filter out packages that don't evaluate.
      # This way we're forced to fix such errors in Nixpkgs,
      # which is especially relevant with allowAliases = false
      abort (makeErrorMessage autoArgs fn args fargs unpassedArgs);
```

逐行读：`functionArgs` 问函数要哪些名字；`intersectAttrs fargs autoArgs // args` 从 `autoArgs`（包集）里只挑名字匹配的，再让显式参数 `args` 覆盖；没凑齐的名字如果全有默认值，就 `makeOverridable f allArgs` 调用，否则 `abort`。

`functionArgs` 返回的属性集，值是布尔：这个参数有没有默认值。Nix 里的实现就是[`prim_functionArgs` 里那句 `attrs.insert(i.name, state.getBool(i.def), i.pos)`](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/primops.cc#L3477)，`i.def` 是形参的默认值表达式是否存在。`intersectAttrs` 在[同一个文件第 3348 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/primops.cc#L3348)，源码注释里写着，对两个集合做同步线性扫描，对 nixpkgs 里的 `callPackage` 来说不可接受（这个包集有两万七千多个属性），所以它用了别的算法。

`lab/ch10/callpackage_auto.nix` 把这几步手工做一遍，核对结果和 `pkgs.firn-hello` 是同一个 derivation：

```nix
let
  pkgs = import ../../nix/pkgs.nix { };
  f = import ../../pkgs/firn-hello/package.nix;
  wanted = builtins.functionArgs f;
  auto = builtins.intersectAttrs wanted pkgs;
  byHand = f auto;
  viaCallPackage = pkgs.callPackage f { };
  hallo = pkgs.callPackage f { greeting = "Hallo"; };
in
```

输出（`nix eval --file`，一行）：

```text
$ cat out/ch10/callpackage_auto.stdout
{ byHandHasOverride = false; callPackageHasOverride = true; explicitArgChangesDrv = true; functionArgs = { greeting = true; lib = false; pkg-config = false; stdenv = false; zlib = false; }; missingFromPkgs = [ "greeting" ]; sameDrvAsByHand = true; sameDrvAsOverlay = true; suppliedNames = [ "lib" "pkg-config" "stdenv" "zlib" ]; }
```

拆开读：只有 `greeting` 有默认值 (`true`)；`suppliedNames` 是 `pkgs` 里有的四个名字，`missingFromPkgs` 是 `[ "greeting" ]`，它走默认值。`sameDrvAsByHand` 和 `sameDrvAsOverlay` 都是 `true`：手工 `f auto`、`pkgs.callPackage f { }` 和 overlay 里的 `pkgs.firn-hello` 是同一个 `.drvPath`；`explicitArgChangesDrv = true`：显式传 `greeting = "Hallo"` 覆盖默认值，换了 `.drvPath`。

最后两行值得停一下：`callPackageHasOverride = true`，`byHandHasOverride = false`。`callPackage` 的返回值带 `.override`，手工 `f auto` 的没有。`.override` 是 `makeOverridable` 加上去的，下一节看它。顺便说 `pkgs.callPackage` 本身是什么：[`pkgs/top-level/splice.nix` 第 120 到 124 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/splice.nix#L120-L124)，`callPackage = pkgs.newScope { }`，`newScope = extra: lib.callPackageWith (pkgsForCall // extra)`。`autoArgs` 就是整个包集。

没凑齐的名字会怎样？同一个实验的另一半调用一个要 `zliib`（我故意拼错）的函数：

```text
$ sed -n '/^== a function whose/,$p' out/ch10/callpackage_source.stdout
== a function whose argument pkgs does not have
lib.customisation.callPackageWith: Function called without required argument "zliib" at <unknown location>, did you mean "zlib", "clib" or "dlib"?
```

nixpkgs 的 `callPackageWith` 在这里把参数名做了 Levenshtein 距离不超过 2 的匹配，给出 `did you mean "zlib", "clib" or "dlib"?`（[`makeErrorMessage`，第 269 到 306 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/customisation.nix#L269-L306)）。`at <unknown location>` 是因为这个函数是在 `--expr` 里定义的，没有文件位置。源码注释还说了一件事：这里用 `abort` 而不是 `throw`，因为 `abort` 不能被 `builtins.tryEval` 接住，nix-env 和 ofborg 靠 `tryEval` 过滤“不能求值的包”，nixpkgs 想让这种错误必须被修，而不是被悄悄过滤掉。

## override 与 overrideAttrs：改参数，还是改属性

`callPackage` 返回的东西带 `.override`，是上一节最后留下的线头。它来自 `makeOverridable`，[第 152 行开始的那个函数](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/customisation.nix#L152)。我只摘和这一篇相关的几行：

```nix
            newArgs: makeOverridable f (origArgs // (if isFunction newArgs then newArgs origArgs else newArgs))
# ...
        if isAttrs result then
          result
          // {
            override = overrideArgs;
# ...
              fdrv: makeOverridable (mirrorArgs (args: (f args).overrideAttrs fdrv)) origArgs;
```

第一行是 `override` 的全部实现：拿到新参数 `newArgs`（可以是属性集，也可以是一个吃旧参数的函数），和最初调用时的参数 `origArgs` 合并，再 `makeOverridable f` 重新调一遍 `package.nix` 里那个函数。`customisation.nix` 的第 175 到 178 行把 `override` 加到结果上，第 192 行给 `overrideAttrs` 套了一层：先让 `mkDerivation` 自己的 `overrideAttrs` 去改属性，然后再 `makeOverridable` 一次，这样 `.overrideAttrs` 之后的结果仍然有 `.override`。

所以 `override` 和 `overrideAttrs` 改的是调用链上两个不同的位置：

- `override { greeting = "Hallo"; }` 重新调用 `package.nix` 的函数，改的是它的**参数**：`lib`、`stdenv`、`pkg-config`、`zlib`、`greeting`。它只能改 `package.nix` 的作者愿意暴露为参数的东西，但可以换依赖 (`override { zlib = otherZlib; }`)。
- `overrideAttrs (old: { ... })` 改的是 `package.nix` 里传给 `stdenv.mkDerivation` 的那个**属性集**：`version`、`src`、`patches`、`env`、`installCheckPhase`，任何属性。代价是你得知道那些属性长什么样。

`lab/ch10/override_kinds.sh` 用 `fixtures/overrides.nix` 里的五种改法，各取一次 out path 和 `name`：

```nix
{
  inherit base;
  # 改 package.nix 的参数：drv 换，name 不变。
  overridden = base.override { greeting = "Hallo"; };
  # 改 mkDerivation 的属性：version 变，mkDerivation 由 pname 和 version 算出的 name 跟着变。
  bumped = base.overrideAttrs (_: {
    version = "0.1.1";
    __intentionallyOverridingVersion = true;
  });
  # 同样的改法，不加 __intentionallyOverridingVersion：求值时 nixpkgs 会警告只改了 version。
  bumpedNoisy = base.overrideAttrs (_: {
    version = "0.1.1";
  });
  # 在 old 的基础上追加：env 是属性集，这里整体替换。
  rebuilt = base.overrideAttrs (old: {
    env = old.env // {
      NIX_CFLAGS_COMPILE = "-DFIRN_GREETING=\"Moin\"";
    };
  });
  # 不推荐（手册称 discouraged）：直接改最终传给 derivation 的参数，name 已经算好，不会跟着变。
  legacy = pkgs.lib.overrideDerivation base (_: {
    version = "0.1.1";
  });
```

```text
$ head -12 out/ch10/override_kinds.stdout
== out path and name per variant
base       /nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0
           name = firn-hello-0.1.0
overridden /nix/store/kvhqb82g03ixgkcj3nkvg6zi2m3b95w4-firn-hello-0.1.0
           name = firn-hello-0.1.0
bumped     /nix/store/bqg6w3vazwcj7ygi92lfq5c5h2x1zvn9-firn-hello-0.1.1
           name = firn-hello-0.1.1
rebuilt    /nix/store/5innyayfkihfyxsg47a232jxq582bgrh-firn-hello-0.1.0
           name = firn-hello-0.1.0
legacy     /nix/store/iynl760caqh5xnhhrbfbmjs7sqmpzlpy-firn-hello-0.1.0
           name = firn-hello-0.1.0
```

五个变体五个不同的 out path，其中只有 `bumped` 的 `name` 变了。`overridden` (`greeting = "Hallo"`) 的 `name` 没变，`rebuilt`（把 `env` 里的宏换成 `Moin`）和 `legacy` 的也没变，所以光看 store 路径的名字后缀，你看不出一个包被改过：路径的哈希部分才是区别。同一个实验接着验证 flake 里的 `packages.x86_64-linux.firn-hello-hallo` 和 `override { greeting = "Hallo"; }` 是同一个 derivation：

```text
$ sed -n 13,20p out/ch10/override_kinds.stdout
== firn-hello-hallo of the flake is the same derivation as override { greeting = "Hallo"; }
same out path

== run base and overridden
Hello, nix, from firn-hello 0.1.0
crc32: 8bb8f4d3
Hallo, nix, from firn-hello 0.1.0
crc32: fa32eef9
```

`same out path`，两个 `Hello` / `Hallo` 的 crc32 也和开头手敲的一致。

### `rebuilt` 为什么不能构建

这里有个我没想到的结果。实验只对五个变体求值，没有构建它们（`override_kinds.sh` 只 `nix build` 了 `base` 和 `overridden`）。我把 `rebuilt` 和 `bumped` 真的构建了一遍（手敲，不在 `lab/ch10/` 里）：

```text
$ nix build --no-link --file lab/ch10/fixtures/overrides.nix rebuilt 2>&1 | grep -E '^error|Reason|installCheckPhase'
error: Cannot build '/nix/store/2pp2halcqfrrajqw91vrj72mk1n4m7rl-firn-hello-0.1.0.drv'.
       Reason: builder failed with exit code 1.
       > Running phase: installCheckPhase
```

日志的最后一行是 `Running phase: installCheckPhase`，后面什么都没有：`test "$first" = ...` 不相等，退出 1。原因在 `package.nix`：`greeting` 这个参数被用了**两次**，一次在 `env.NIX_CFLAGS_COMPILE`，一次在 `installCheckPhase` 的字符串里。`override { greeting = "Moin"; }` 会同时改两处，因为两处都是从同一个参数插值出来的；而 `rebuilt` 用 `overrideAttrs` 只替换了 `env`，`installCheckPhase` 里那个字符串在 `package.nix` 被调用的时候就已经插值成 `Hello, nix, from firn-hello 0.1.0` 了，`overrideAttrs` 够不到它。程序打印 `Moin, ...`，检查期待 `Hello, ...`，构建失败。

这是 `override` 和 `overrideAttrs` 区别最干净的一个例子：`override` 在**数据流的上游**改，凡是从这个参数算出来的东西都跟着变；`overrideAttrs` 在**下游**改，只改你指到的那个属性。

`bumped` 没有这个问题，它能构建，只是有点荒诞（手敲，不在 `lab/ch10/` 里）：

```text
$ nix build --no-link --print-out-paths -f lab/ch10/fixtures/overrides.nix bumped
/nix/store/bqg6w3vazwcj7ygi92lfq5c5h2x1zvn9-firn-hello-0.1.1
$ /nix/store/bqg6w3vazwcj7ygi92lfq5c5h2x1zvn9-firn-hello-0.1.1/bin/firn-hello --version
firn-hello 0.1.0 (zlib 1.3.2)
```

包名是 `0.1.1`，程序自己说 `0.1.0`。前面解释过：版本号在 C 源码里也是写死的，`overrideAttrs` 改的是 Nix 这一侧的 `version` 属性，不会碰 C 的宏。要让两边连起来，得把 `finalAttrs.version` 传给编译器；但 C 源码里的 `#define FIRN_VERSION` 没有 `#ifndef` 保护，单靠 `-D` 改不动它，我也没有为了这一章去改 C 程序。

### 改了 version 却没改 src

`bumped` 带着的 `__intentionallyOverridingVersion = true` 消除的是一条求值警告。同样的改法不加它，就是 `bumpedNoisy`：

```text
$ sed -n 22,23p out/ch10/override_kinds.stdout
== overrideAttrs without __intentionallyOverridingVersion: eval warning
evaluation warning: firn-hello-0.1.0 was overridden with `version` but not `src`
```

nixpkgs 认为改了 `version` 却没改 `src` 几乎肯定不是你想要的，条件在 [`make-derivation.nix` 第 266 到 274 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L266-L274)；这个属性在[第 305 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L305)被去掉，不进 derivation。`firn-hello` 的 `src` 是本地文件集，不依赖版本号，所以这里是“有意”的。

## finalAttrs：属性集自己的不动点

`overrideAttrs` 能让 `name` 跟着 `version` 走，靠的是什么？`override_kinds.sh` 最后一段用 `fixtures/rec_vs_final.nix` 对比了 `rec` 和 `finalAttrs`：

```nix
  withRec = pkgs.stdenv.mkDerivation rec {
    pname = "tagged-rec";
    version = "1";
    dontUnpack = true;
    # BAD: version 在 rec 里已经定死，overrideAttrs 改不到这里
    TAG = "v${version}";
    installPhase = "echo \"$TAG\" > $out";
  };
  withFinal = pkgs.stdenv.mkDerivation (finalAttrs: {
    pname = "tagged-final";
    version = "1";
    dontUnpack = true;
    TAG = "v${finalAttrs.version}";
    installPhase = "echo \"$TAG\" > $out";
  });
  bump = _: { version = "2"; };
```

两个只差一个写法的小包，各用 `overrideAttrs` 把 `version` 改成 `"2"`，然后看 `name` 和从 `version` 算出来的 `TAG`：

```text
$ tail -n 1 out/ch10/override_kinds.stdout
{ final_TAG = "v2"; final_name = "tagged-final-2"; rec_TAG = "v1"; rec_name = "tagged-rec-2"; }
```

`name` 两边都跟着变了：`tagged-rec-2` 和 `tagged-final-2`。`TAG` 只有 `finalAttrs` 那个变了，`rec` 的还是 `v1`。

`name` 为什么两边都变？因为它不是你写的：你只写了 `pname` 和 `version`，`name` 是 `mkDerivation` 在所有 overlay 都应用完以后，[从最终的属性里拼出来的](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L651-L689)(`"${attrs.pname}${staticMarker}${hostSuffix}-${attrs.version}"`)。所以 `firn-hello` 的 `name` 本来就会跟着 `version` 走，和 `package.nix` 用不用 `finalAttrs` 无关；我在做这个实验之前以为是后者。`TAG` 不一样：它是你自己在 `rec` 里写的 `"v${version}"`，`rec` 里的 `version` 指的是 `rec` 自己那一份，`overrideAttrs` 之后产生的新 `version` 够不到它。`finalAttrs` 把“我的 `version`”从“当前这个属性集里的 `version`”换成了“最终那个属性集里的 `version`”。

这个“最终”是怎么来的，看 `mkDerivation` 的实现：

```nix
      args = rattrs (args // { inherit finalPackage overrideAttrs; });
# ...
      overrideAttrs =
        f0:
        makeDerivationExtensible (
          final:
          let
            prev = rattrs final;
# ...
            (prev // (removeAttrs thisOverlay [ "__intentionallyOverridingVersion" ]))
```

[第 236 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L236)：`args = rattrs (args // { inherit finalPackage overrideAttrs; })`。`rattrs` 是你传给 `mkDerivation` 的那个 `finalAttrs: { ... }`，`args` 是它的结果，而它的参数又是 `args` 自己（加上两个方法）：这就是第 3 篇的 `fix`，一个属性集拿自己的结果当参数。`overrideAttrs`（第 243 行起）再造一个新的 `makeDerivationExtensible`，它的 `final` 是新的不动点，`prev = rattrs final` 是旧属性在新不动点下的取值，最后 `prev // thisOverlay`（第 305 行）把你的改动盖上去：

```text
overrideAttrs f = fix (final: (原属性 final) // f final (原属性 final))   # 示意，f 也可以只取一个参数 old
```

这个式子就是第 3 篇的 `extends`。所以 `overrideAttrs` 是“套在一个包上的 overlay”，而后面 overlay 一节的 nixpkgs overlay 是“套在整个包集上的 overlay”。同一个技巧用了两层。

## lib.overrideDerivation：旧的那个

第五个变体 `legacy` 用的是 `pkgs.lib.overrideDerivation base (_: { version = "0.1.1"; })`。它的 `name` 没有变，还是 `firn-hello-0.1.0`，即使 `version` 属性确实被改了：

```text
$ sed -n 10,11p out/ch10/override_kinds.stdout
legacy     /nix/store/iynl760caqh5xnhhrbfbmjs7sqmpzlpy-firn-hello-0.1.0
           name = firn-hello-0.1.0
```

`overrideDerivation` 不是改 `mkDerivation` 的参数，而是改**最终交给内建 `derivation` 的参数**（[实现在 `customisation.nix` 第 99 到 112 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/customisation.nix#L99-L112)：`derivation (drv.drvAttrs // (f drv))`）。那时 `name` 早就拼好了，`version` 变了也不会再触发重新拼。它也看不到 `finalAttrs`，必须先求值整个 derivation 才能改它。

人们常说它“已弃用”。Nixpkgs 手册的措辞要小心一点：[`overrideDerivation` 一节](https://nixos.org/manual/nixpkgs/unstable/#sec-pkg-overrideDerivation)写的是“你应当几乎总是优先用 `overrideAttrs`”，同时明确说 “`overrideDerivation` 没有被弃用，也会继续可用”，只是它更难用、能力也更少；并且警告不要在 Nixpkgs 里用它，因为它会在修改之前先求值整个 derivation，破坏了包的抽象。所以我的规则是：自己写的东西里不用，读到别人用的时候知道它在干什么。

## 两个顺序，一个结果

最后一个问题：`.override` 和 `.overrideAttrs` 能不能链起来，顺序有没有关系？按前面的源码，`overrideAttrs` 的结果会重新带上 `override`，所以能链。我手敲了一个表达式去验证两个顺序是不是同一个 derivation（手敲，不在 `lab/ch10/` 里）：

```text
$ nix eval --impure --expr '
let
  p = import ./nix/pkgs.nix { };
  a = (p.firn-hello.override { greeting = "Hallo"; }).overrideAttrs (o: { pname = "x"; });
  b = (p.firn-hello.overrideAttrs (o: { pname = "x"; })).override { greeting = "Hallo"; };
in
{ hasOverride = a ? override; hasOverrideAttrs = a ? overrideAttrs; same = a.drvPath == b.drvPath; }'
{ hasOverride = true; hasOverrideAttrs = true; same = true; }
```

两个顺序得到同一个 `.drvPath`。我只试了这一个例子，两次改动互不相干；碰同一个东西的话，顺序大概会有关系，就像上面的 `rebuilt`。

顺带一提，`overrideAttrs` 也接受 `final: prev: { ... }` 的两参数形式：[`make-derivation.nix` 第 251 到 262 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L251-L262)先试 `f0 prev`，返回的是函数就当两参数的用，`final` 是最终属性集，想读“改完以后的值”就用它。

## overlay：final 与 prev

`override` 和 `overrideAttrs` 都是改**一个包**。如果想让整个包集里所有用到 `zlib` 的东西都换成我的 `zlib`，或者往包集里加一个 `firn-hello`，要用 overlay。overlay 就是一个两参数函数 `final: prev: { ... }`，返回的属性集会被盖到包集上。`overlays/default.nix` 是最小的一个：

```nix
final: _prev: {
  firn-hello = final.callPackage ../pkgs/firn-hello/package.nix { };
}
```

两个参数怎么选，我给自己写了条规则：

- `prev` 是**排在我前面的所有层叠起来的结果**。我要改一个已有的东西，并且要基于它原来的样子改，就从 `prev` 取：`prev.zlib.overrideAttrs ...`。
- `final` 是**所有层（包括我自己和排在我后面的）叠完以后的结果**。我要“用包集里别人的最终版本”，就从 `final` 取：`final.callPackage ...`、`final.zlib`。
- 在 overlay 里定义属性 `x`，**永远不要**从 `final.x` 取旧值，要取旧值只有 `prev.x`。

打个比方：想象投影仪上叠了一摞透明胶片。`prev` 是从我这张胶片往下看到的画面，`final` 是观众从屏幕上看到的、所有胶片叠完之后的画面。我用胶片改一块颜色，要基于下面那张的颜色，就得看下面 (`prev`)；要知道观众最后会看到什么，就得看屏幕 (`final`)。

### nixpkgs 里 overlay 在哪一层

第 3 篇里 `extends` 是 `overlay: f: final: let prev = f final; in prev // overlay final prev`。nixpkgs 里的包集就是用一串 `extends` 折叠出来的，[`pkgs/top-level/stage.nix` 第 338 到 360 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/stage.nix#L338-L360)：

```nix
  toFix = lib.foldl' (lib.flip lib.extends) (self: { }) (
    [
      stdenvBootstappingAndPlatforms
      stdenvAdapters
      trivialBuilders
      splice
      autoCalledPackages
      # ...
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

先是 11 层 nixpkgs 自己的 overlay（引导 stdenv、`allPackages`（也就是 `all-packages.nix`）、别名、`configOverrides` ……），然后是我们传进来的 `overlays`，最后是 `stdenvOverrides`，它必须排在最后，因为它要把引导阶段已经做好的包拉到前面来。用户的 overlay 因此在 nixpkgs 自己所有的层之上、`stdenvOverrides` 之下，`prev` 能看见 `all-packages.nix` 里的一切。

第 344 行的 `autoCalledPackages` 是 `import ./by-name-overlay.nix ../by-name`（[第 18 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/stage.nix#L18)），也就是 `pkgs/by-name/` 目录本身就是第 5 层 overlay，每个 `package.nix` 自动被 `callPackage`。我们的 `overlays/default.nix` 做的是同一件事，只是手写的。

### lab/ch10/overlay_order.nix：顺序决定结果

两个 overlay 都想改 `firn-hello`，谁赢？`overlay_order.nix` 定义了 `hallo`、`bonjour` 两个都改 `prev.firn-hello` 的 overlay，以及一个“观察者”，它把 `prev.firn-hello` 和 `final.firn-hello` 各存成一个属性：

```nix
  hallo = _final: prev: {
    firn-hello = prev.firn-hello.override { greeting = "Hallo"; };
  };
  bonjour = _final: prev: {
    firn-hello = prev.firn-hello.override { greeting = "Bonjour"; };
  };
  observe = final: prev: {
    firn-hello-prev = prev.firn-hello;
    firn-hello-final = final.firn-hello;
  };
```

然后用 `pkgs.appendOverlays` 以三种顺序叠在已经带着 Firn overlay 的 `pkgs` 上（`nix/pkgs.nix` 的默认 `overlays` 里已经有 `overlays/default.nix`），读出各自 `NIX_CFLAGS_COMPILE` 里的问候词，不构建任何东西。原始输出是一行 `nix eval` 的属性集，太长，我用 `jq` 去掉 `-DFIRN_GREETING=` 前缀重新排版（手敲，不在 `lab/ch10/` 里）：

```text
$ nix eval --json --file lab/ch10/overlay_order.nix | jq 'walk(if type == "string" then ltrimstr("-DFIRN_GREETING=") else . end)'
{
  "bonjour_hallo_observe": {
    "final_seen_by_observe": "\"Hallo\"",
    "firn-hello": "\"Hallo\"",
    "prev_seen_by_observe": "\"Hallo\""
  },
  "composeManyExtensions_equals_list": true,
  "hallo_bonjour_observe": {
    "final_seen_by_observe": "\"Bonjour\"",
    "firn-hello": "\"Bonjour\"",
    "prev_seen_by_observe": "\"Bonjour\""
  },
  "observe_hallo_bonjour": {
    "final_seen_by_observe": "\"Bonjour\"",
    "firn-hello": "\"Bonjour\"",
    "prev_seen_by_observe": "\"Hello\""
  }
}
```

两件事：

- `hallo` 在前、`bonjour` 在后，`firn-hello` 是 Bonjour；反过来是 Hallo。**后面的赢**，因为后面的 `prev.firn-hello` 已经是前面的结果，再 `.override { greeting = ... }` 一次，`greeting` 被后者覆盖。
- `observe` 排在最前时，`prev_seen_by_observe` 是 `"Hello"`（Firn overlay 的默认），而 `final_seen_by_observe` 是 `"Bonjour"`：`final` 看到了排在它**后面**的 `hallo` 和 `bonjour`。这就是 `final` 和 `prev` 的区别。

`composeManyExtensions_equals_list` 是 `true`：`lib.composeManyExtensions [ hallo bonjour ]` 作为**一个** overlay，和把 `hallo`、`bonjour` 作为**两个** overlay 放在列表里，结果的 `firn-hello` 一样。[`composeExtensions`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/fixed-points.nix#L340-L346) 做的就是 `fApplied // g final (prev // fApplied)`，让后一个 overlay 的 `prev` 包含前一个的结果，和 `stage.nix` 里逐层 `extends` 同构。`composeManyExtensions` 是 [`lib.foldr composeExtensions (final: prev: { })`（第 412 行）](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/fixed-points.nix#L412)。

### overlay_final_recursion_fail.nix：从 final 取自己

规则第三条的反例，故意写错的：

```nix
let
  # BAD: 应该用 prev.firn-hello
  bad = final: _prev: {
    firn-hello = final.firn-hello.override { greeting = "Hallo"; };
  };
  pkgs = import ../../nix/pkgs.nix {
    overlays = [
      (import ../../overlays)
      bad
    ];
  };
in
pkgs.firn-hello.name
```

`bad` 要定义 `firn-hello`，却从 `final.firn-hello` 取旧值。`final.firn-hello` 就是**这个 overlay 正在定义的那个属性**，所以求值它需要先求值它自己。这个实验按设计失败，运行器要求 `_fail` 实验以非零退出（退出码是 1），`out/ch10/overlay_final_recursion_fail.stderr` 里：

```text
$ sed -n '11,23p' out/ch10/overlay_final_recursion_fail.stderr
       … while evaluating the attribute 'firn-hello.override'
         at /home/bfmhno3/Projects/firn/lab/ch10/overlay_final_recursion_fail.nix:7:5:
            6|   bad = final: _prev: {
            7|     firn-hello = final.firn-hello.override { greeting = "Hallo"; };
             |     ^
            8|   };

       error: infinite recursion encountered
       at /home/bfmhno3/Projects/firn/lab/ch10/overlay_final_recursion_fail.nix:7:18:
            6|   bad = final: _prev: {
            7|     firn-hello = final.firn-hello.override { greeting = "Hallo"; };
             |                  ^
            8|   };
```

错误里有两层 `while evaluating the attribute`：上面一层没有摘出来，是 `'firn-hello.name'`（实验最后一行 `pkgs.firn-hello.name` 要它），摘出来的是 `'firn-hello.override'`（求值 `.override` 之前要先求值 `final.firn-hello`），最后是 `infinite recursion encountered`，位置指向 `final.firn-hello` 的 `final`。改成 `prev.firn-hello.override { ... }` 就对了，`overlay_order.nix` 里的 `hallo` 就是这样写的。

`final.x` 本身并不危险：`final.callPackage` 和 `final.zlib` 都是安全的，因为它们取的是别的属性，不是我正在定义的这个。危险的只是“我定义 `x`，又去读 `final.x`”。

### prev.callPackage 其实和 final.callPackage 一样

`overlays/default.nix` 写的是 `final.callPackage`。我原来以为这是必须的：如果写成 `prev.callPackage`，`firn-hello` 的依赖就是在**下层**解析的，排在它后面的 `zlib` overlay 影响不到它。我手敲了一个实验去验证，结果和我想的不一样（手敲，不在 `lab/ch10/` 里）：

```text
$ nix eval --impure --expr '
let
  mk = cp: import ./nix/pkgs.nix {
    overlays = [
      (final: prev: { firn-hello = (if cp == "prev" then prev else final).callPackage ./pkgs/firn-hello/package.nix { }; })
      (_final: prev: { zlib = prev.zlib.overrideAttrs (_: { env.FIRN_TWEAK = "1"; }); })
    ];
  };
in
{ same_drv = (mk "prev").firn-hello.drvPath == (mk "final").firn-hello.drvPath; }'
{ same_drv = true; }
```

两个 `firn-hello` 是同一个 `.drvPath`。原因在上面引过的 `splice.nix`：`pkgs.callPackage = pkgs.newScope { }`，而这个 `pkgs` 是[第 144 行 `splice = self: super: import ./splice.nix lib self ...`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/stage.nix#L144)传进去的 `self`，也就是**最终的**不动点。下层的 `callPackage` 早就是一个绑定了最终包集的函数，`prev.callPackage` 取到的不过是同一个函数。这个结论只对 `callPackage` 和它的兄弟 `newScope` 成立：`prev.zlib` 就是下层的 `zlib`，不是最终的。我仍然保留 `final.callPackage` 的写法，因为它不依赖这个实现细节，也和 nixpkgs 里的习惯一致，不过现在我知道它在这里“只是习惯”。

## 接线：flake、nix/pkgs.nix 与 default.nix

overlay 写好了，要让它被用上。有三个入口，对应三种拿到 nixpkgs 的方式。

**不用 flake 的实验：`nix/pkgs.nix`。** 第 1 篇起每个实验都用它拿到钉死的 nixpkgs。这一章它的 `overlays` 默认值从 `[ ]` 变成了 Firn 自己的 overlay：

```nix
# 不经过 flake 导入锁定版本的 nixpkgs。
{
  system ? builtins.currentSystem,
  overlays ? [ (import ../overlays) ],
}:
import (import ./pins.nix).nixpkgs {
  inherit system overlays;
  config = { };
}
```

`import ./nix/pkgs.nix { }` 默认带 Firn 的 overlay，`overlays = [ ]` 则是干净的 nixpkgs；实验要在默认值之后再叠别的 overlay 时，写成 `[ (import ../../overlays) 别的 ]`。这个默认值带来的后果可以数出来（手敲，不在 `lab/ch10/` 里）：

```text
$ nix eval --impure --expr 'let p = import ./nix/pkgs.nix { overlays = [ ]; }; in builtins.length (builtins.attrNames p)'
27959
$ nix eval --impure --expr 'let p = import ./nix/pkgs.nix { }; in builtins.length (builtins.attrNames p)'
27960
```

27959 是第 1 篇量过的 nixpkgs 属性数，加上 overlay 之后 27960：整个 overlay 给包集多了一个名字，`firn-hello`。

**`default.nix`：不用 flake 的入口。** 第 9 篇留下的 `default.nix` 里只有 `mini`，这一章加一行：

```nix
let
  pkgs = import ./nix/pkgs.nix { inherit system; };
in
{
  inherit (pkgs) firn-hello;
  mini = import ./mini {
    busybox = pkgs.pkgsStatic.busybox;
    inherit system;
  };
}
```

`inherit (pkgs) firn-hello;`。旧入口第一次承载一个 nixpkgs 风格的包：`nix-build -A firn-hello`。

**`flake.nix`：`pkgsFor` 换了。** 之前每个系统的 `pkgs` 是 `nixpkgs.legacyPackages.${system}`，没有 Firn overlay；现在是：

```nix
      # 每个系统一份 pkgs，带上 Firn 自己的 overlay。
      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          overlays = [ self.overlays.default ];
        };
      packagesFor = system: {
        inherit (pkgsFor system) firn-hello;
        firn-hello-hallo = (pkgsFor system).firn-hello.override { greeting = "Hallo"; };
        default = (pkgsFor system).firn-hello;
      };
```

`import nixpkgs { inherit system; overlays = [ self.overlays.default ]; }`：自己 `import` 一次，传 `overlays`。这是一个新的 nixpkgs 实例。nixpkgs 的 flake 暴露的 `legacyPackages.${system}` 本身也是一次 `import ./. { inherit system; overlays = ...; }`（[`flake.nix` 第 224 到 241 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/flake.nix#L224-L241)），没有 `config`，也没有我们的 overlay；我们自己再 `import` 一次，就得到一个带着 Firn overlay 的包集。`self.overlays.default` 是这个 flake 自己的输出，`overlays.default = import ./overlays;`，所以 flake 在定义自己的 overlay 的同时就用上它，靠的是 `self`。`packagesFor` 列出三个包：`firn-hello`，`firn-hello-hallo`（那一行 `override`），`default`。

输出和检查（手敲，不在 `lab/ch10/` 里）：

```text
$ nix flake show 2>/dev/null | tail -4
    └───x86_64-linux
        ├───default: package 'firn-hello-0.1.0'
        ├───firn-hello: package 'firn-hello-0.1.0'
        └───firn-hello-hallo: package 'firn-hello-0.1.0'
$ nix eval .#checks.x86_64-linux --apply builtins.attrNames
[ "dev-shell" "lib-tests" "mini-site" "pkg-firn-hello" "pkg-firn-hello-hallo" "readme-table" ]
```

`checks` 里新增的 `pkg-firn-hello` 和 `pkg-firn-hello-hallo` 来自 `flake.nix` 里的 `pkgs.lib.mapAttrs' (name: pkg: pkgs.lib.nameValuePair "pkg-${name}" pkg) (removeAttrs (packagesFor system) [ "default" ])`：每个包一个检查，`default` 只是别名所以去掉。以后每章加包，只要加进 `packagesFor`，检查就自动出现。

flake 路径和 `nix-build` 的旧路径是不是同一个包？（手敲，不在 `lab/ch10/` 里）

```text
$ nix build .#firn-hello --no-link --print-out-paths
/nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0
$ nix-build -A firn-hello --no-out-link
/nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0
```

同一个路径，和第 9 篇 `mini.hello` 的结论一样。因为 `nix/pins.nix` 从 `flake.lock` 读出同一个 nixpkgs，flake 的 `import nixpkgs { ... }` 和 `nix/pkgs.nix` 的 `import (import ./pins.nix).nixpkgs { ... }` 是同一个源码、同一个 overlay、同一个系统。

## import nixpkgs { overlays; config; }：config 和 allowUnfree

`import nixpkgs { ... }` 的参数里，除了 `system` 和 `overlays`，另一个常用的是 `config`。它在**导入时**决定哪些包可以求值。`lab/ch10/allow_unfree.nix` 用 `unrar`（许可证是 `unfreeRedistributable`）演示：

```nix
  nixpkgs = (import ../../nix/pins.nix).nixpkgs;
  system = builtins.currentSystem;
  withConfig =
    config:
    import nixpkgs {
      inherit system config;
    };
  evaluates = pkg: (builtins.tryEval pkg.drvPath).success;
  plain = withConfig { };
  onlyUnrar = withConfig {
    allowUnfreePredicate = pkg: (plain.lib.getName pkg) == "unrar";
  };
in
{
  unrar_meta_unfree = plain.unrar.meta.unfree;
  config_empty = evaluates plain.unrar;
  allowUnfree_true = evaluates (withConfig { allowUnfree = true; }).unrar;
  predicate_unrar_ok = evaluates onlyUnrar.unrar;
  predicate_vscode_rejected = !(evaluates onlyUnrar.vscode);
  # 纯自由软件不受影响。
  hello_with_empty_config = evaluates plain.hello;
}
```

```text
$ cat out/ch10/allow_unfree.stdout
{ allowUnfree_true = true; config_empty = false; hello_with_empty_config = true; predicate_unrar_ok = true; predicate_vscode_rejected = true; unrar_meta_unfree = true; }
```

`config = { }` 时 `unrar` 不能求值 (`config_empty = false`)；`allowUnfree = true` 放行所有 unfree 包 (`allowUnfree_true = true`)；`allowUnfreePredicate` 只放行点名的包 (`predicate_unrar_ok = true`, `predicate_vscode_rejected = true`)；纯自由软件不受影响 (`hello_with_empty_config = true`)。`unrar_meta_unfree = true` 是读 `meta.unfree` 本身，这一步不检查，所以可以读。

拒绝发生在哪？这个实验的注释写着“取 `drvPath` 时”，取 `name` 不检查。`check-meta.nix` 里[第 163 到 196 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/check-meta.nix#L163-L196)定义 `allowUnfree`、`allowUnfreePredicate`、`allowUnfreePackages` 各自的判断，[第 73 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/check-meta.nix#L73)还有一个旁路：`allowUnfree = config.allowUnfree || getEnv "NIXPKGS_ALLOW_UNFREE" == "1"`，环境变量，但 flake 在纯模式下读不到它（要 `--impure`）。直接不带 `config` 去取 `unrar` 的 `drvPath`，报错的第一行就说清了原因（手敲，不在 `lab/ch10/` 里，只截了开头）：

```text
$ nix eval --file nix/pkgs.nix unrar.drvPath 2>&1 | grep -A3 'Refusing' | sed 's/^ *//'
error: Refusing to evaluate package 'unrar-7.2.7' in /nix/store/z4wkdlk69gck09s64a8ghpn6h7bxhkyy-source/pkgs/by-name/un/unrar/package.nix:58 because it has an unfree license (‘unfreeRedistributable’)
a) To temporarily allow unfree packages, you can use an environment variable
for a single invocation of the nix tools.
```

后面 nixpkgs 接着列了三条出路：环境变量 `NIXPKGS_ALLOW_UNFREE=1`（用 flake 的命令要加 `--impure`）、NixOS 里的 `nixpkgs.config.allowUnfree`（第 16 篇）、`nix-env` 和 `nix-build` 读的 `~/.config/nixpkgs/config.nix`。后两个最后都是 `import nixpkgs { config = ...; }` 里的 `config`，环境变量是 `check-meta.nix` 里那个旁路。Firn 自己的 `import nixpkgs { ... }` 没有传 `config`，所以没有 unfree 包；如果以后需要，要同时加在 `pkgsFor` 和 `nix/pkgs.nix` 两个地方，缺一个，flake 和旧入口就会不一致。

## 改一个 overlay，要重建多少

overlay 的“范围”是什么？`final` 是整个包集，所以我在 overlay 里改一个被很多包依赖的东西，所有依赖它的包都会换 `.drv`。`lab/ch10/overlay_rebuild_scope.sh` 量这个：对 `firn-hello` 做 `nix build --dry-run`，数 `will be built` 列表里有多少个 derivation。三个包集：不加别的 overlay；加一个只改 `hello` 的 overlay（`hello` 不是 `firn-hello` 的依赖）；加一个改 `zlib` 的 overlay（`zlib` 是 `firn-hello` 的 `buildInputs`）：

```nix
# 带一个 zlib overlay 的 pkgs：zlib 的 drv 换了，依赖它的包都跟着换。
import ../../../nix/pkgs.nix {
  overlays = [
    (import ../../../overlays)
    (_final: prev: {
      zlib = prev.zlib.overrideAttrs (_: {
        env.FIRN_TWEAK = "1";
      });
    })
  ];
}
```

改动本身毫无意义，往 `zlib` 的 `env` 里加一个 `FIRN_TWEAK = "1"`，只是为了让它的 `.drv` 变。结果：

```text
$ cat out/ch10/overlay_rebuild_scope.stdout
== no extra overlay (nix/pkgs.nix)
volatile: 0 derivations will be built

== overlay changes hello (unrelated)
volatile: 0 derivations will be built

== overlay changes zlib
volatile: 100 derivations will be built
  in the list: zlib-1.3.2
  in the list: firn-hello-0.1.0
  in the list: glibc-2.42-67
  in the list: gcc-15.3.0
  not in the list: ^hello-
```

不加 overlay 是 0，改 `hello` 是 0，改 `zlib` 是 100。前两个 0 是有前提的：`firn-hello` 自己已经在我本地的 store 里了（它不在任何公共缓存里），所以不需要“build”。真正有信息量的是第三行：`zlib-1.3.2` 要重建，`firn-hello` 要重建，这两个不奇怪；奇怪的是 `glibc-2.42-67` 和 `gcc-15.3.0` 也在列表里。这个 100 是 `volatile`：它取决于缓存里有什么，换一台机器或者换一天可能是别的数；列表里有哪些名字倒是稳定的。

我去查了为什么 `gcc` 也要重建：

```text
$ nix-store -q --references $(nix-instantiate nix/pkgs.nix -A stdenv.cc.cc 2>/dev/null) | sed 's|^/nix/store/[a-z0-9]*-||' | grep -E 'zlib|gmp|mpfr|isl'
gmp-6.3.0.drv
zlib-1.3.2.drv
mpfr-4.2.2.drv
isl-0.20.drv
```

（手敲，不在 `lab/ch10/` 里。）`gcc-15.3.0.drv` 的输入里直接有 `zlib-1.3.2.drv`。编译器自己要链 zlib，所以把 `zlib` 换掉，编译器换，用这个编译器构建的东西（`glibc`，然后是依赖它们的全部）全换。`firn-hello` 的 `.drv` 自己只有四个直接输入，但 `stdenv-linux` 这一个就把编译器带进来了：

```text
$ nix derivation show $(nix-instantiate nix/pkgs.nix -A firn-hello 2>/dev/null) | jq -r '.derivations[].inputs.drvs | keys[]' | sed 's|^[a-z0-9]*-||'
stdenv-linux.drv
zlib-1.3.2.drv
pkg-config-wrapper-0.29.2.drv
bash-5.3p15.drv
```

（以上两条是手敲，不在 `lab/ch10/` 里；`2>/dev/null` 滤掉 `--add-root` 警告。）这个 100 里有多少是引导 stdenv 的各个阶段，我没有逐个分类，列表里能看到 `bootstrap-stage2-gcc-wrapper`、`bootstrap-stage3-stdenv-linux` 这样的名字。开头几行和下载量（手敲，不在 `lab/ch10/` 里）：

```text
$ nix build --dry-run --file lab/ch10/fixtures/zlib_tweak.nix firn-hello 2>&1 | sed -n '1,4p'
these 100 derivations will be built:
  /nix/store/65zr7hprnv2vixdbmlyk8gjl8kvr00k2-zlib-1.3.2.drv
  /nix/store/allhvnjry5h1spghybzbin02iaw65vih-perl-5.42.0.drv
  /nix/store/0v140la4ja2rrdmyv8slgraq3nfh0mwb-bison-3.8.2.drv
$ nix build --dry-run --file lab/ch10/fixtures/zlib_tweak.nix firn-hello 2>&1 | grep 'will be fetched'
these 166 paths will be fetched (642.8 MiB download, 1.2 GiB unpacked):
```

100 个 derivation 要构建，另外 166 个路径 (642.8 MiB) 要从缓存下载，用来构建它们。

那应该怎么只改 `firn-hello` 用的 zlib？不要用 overlay，用 `override`，改**这一个包的参数**（手敲，不在 `lab/ch10/` 里）：

```text
$ nix build --dry-run --impure --expr '
let p = import ./nix/pkgs.nix { };
in p.firn-hello.override { zlib = p.zlib.overrideAttrs (_: { env.FIRN_TWEAK = "1"; }); }' 2>&1 | sed 's|/nix/store/[a-z0-9]*-||' | head -3
these 2 derivations will be built:
  zlib-1.3.2.drv
  firn-hello-0.1.0.drv
```

**2 个**，对 100 个。overlay 换的是包集里的 `zlib`，所有人都看到，包括编译器；`override` 换的是 `firn-hello` 的参数，只有它看到，编译器还是用原来那个。overlay 的好处是一致（整个包集用同一个 zlib，不会出现两个版本的 zlib 链进同一个程序），代价是范围。

## 抓源码：fetchurl、fetchFromGitHub、fetchgit 与固定输出

`firn-hello` 的源码在本地，没有抓取，但下一篇要打包 GitHub 上的三个项目，所以先把 fetcher 拆开。第 4 篇我用过求值期的 `builtins.fetchTarball`，第 6 篇写过一个手工的固定输出 derivation；nixpkgs 的 fetcher 是后者的包装。Nixpkgs 手册[的说法](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/doc/build-helpers/fetchers.chapter.md#L6-L17)：内建 fetcher 在**求值时**下载，受 `tarball-ttl` 影响，不走 substituter；Nixpkgs 的 fetcher 创建固定输出 derivation，在**构建时**下载，hash 没变且 store 里已有就不重新下载，还能透明地用二进制缓存，所以 Nixpkgs 里不允许用内建 fetcher。

`lab/ch10/fetchers.sh` 用 `fixtures/fetchers.nix` 里的四个 fetcher 抓同一个仓库：`bfmhno3/cairn` 的标签 `ch10` (commit `3febd7b1a00b7dcbb94d6c6258d38327e3bb24d1`)：

```nix
{
  fake ? false,
}:
let
  pkgs = import ../../../nix/pkgs.nix { };
  inherit (pkgs) lib;
  rev = "3febd7b1a00b7dcbb94d6c6258d38327e3bb24d1";
  treeHash = "sha256-y+6fZYN1bMicL+IzPC1Wr4mrol+VEVkiDFWuxtsiSxg=";
in
{
  # 单个文件：flat 模式，hash 是文件字节的 sha256。
  installSh = pkgs.fetchurl {
    url = "https://raw.githubusercontent.com/bfmhno3/cairn/${rev}/install.sh";
    hash = "sha256-gOmM4E80qTik/4JH2kqzv2sQwTqUBVfbkkXjbyi845U=";
  };
  # GitHub 生成的 tarball 当作普通文件：flat 模式，hash 是 .tar.gz 字节的 sha256。
  tarball = pkgs.fetchurl {
    url = "https://github.com/bfmhno3/cairn/archive/refs/tags/ch10.tar.gz";
    hash = "sha256-klYYGug+UKdeu0kHZ5o17A7CSIGSImy+3cipzH0ZeY8=";
  };
  # 解包后的目录树：nar 模式，hash 是目录的 NAR 序列化的 sha256。
  fromGitHub = pkgs.fetchFromGitHub {
    owner = "bfmhno3";
    repo = "cairn";
    tag = "ch10";
    hash = if fake then lib.fakeHash else treeHash;
  };
  # 直接用 git 取同一个 commit，目录树相同，所以 hash 也相同。
  fromGit = pkgs.fetchgit {
    url = "https://github.com/bfmhno3/cairn";
    inherit rev;
    hash = treeHash;
  };
```

实验为每一个取出 `nix derivation show` 里的输出的 `method` 和 `hash`：

```text
$ sed -n 1,8p out/ch10/fetchers.stdout
== tag ch10 of bfmhno3/cairn
3febd7b1a00b7dcbb94d6c6258d38327e3bb24d1	refs/tags/ch10^{}

== build the four FODs (name, hash mode, hash)
installSh: flat sha256-gOmM4E80qTik/4JH2kqzv2sQwTqUBVfbkkXjbyi845U=
tarball: flat sha256-klYYGug+UKdeu0kHZ5o17A7CSIGSImy+3cipzH0ZeY8=
fromGitHub: nar sha256-y+6fZYN1bMicL+IzPC1Wr4mrol+VEVkiDFWuxtsiSxg=
fromGit: nar sha256-y+6fZYN1bMicL+IzPC1Wr4mrol+VEVkiDFWuxtsiSxg=
```

`git ls-remote` 看到的标签指向的 commit 和 `rev` 一致；后面四行是四个固定输出 derivation 的 hash 模式：

- `installSh`（`fetchurl` 抓单个文件）：`flat`，hash 是文件字节的 sha256。
- `tarball`（`fetchurl` 抓 GitHub 生成的 `.tar.gz`，当普通文件看）：`flat`，hash 是 `.tar.gz` 字节的 sha256。
- `fromGitHub` (`fetchFromGitHub`)：`nar`，hash 是**解包后目录**的 NAR 序列化的 sha256。
- `fromGit` (`fetchgit`)：`nar`，目录同一个，hash 也**一样**：`sha256-y+6fZYN1...`。

模式是从 nixpkgs 的实现来的：[`fetchurl` 里 `outputHashMode = if (recursiveHash || executable) then "recursive" else "flat"`（第 348 行）](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/fetchurl/default.nix#L348)，`recursive` 在 `nix derivation show` 里叫 `nar`；[`fetchzip` 设 `recursiveHash = true`（第 64 行）](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/fetchzip/default.nix#L64)；[`fetchgit` 设 `outputHashMode = "recursive"`（第 172 行）](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/fetchgit/default.nix#L172)；而 `fetchFromGitHub` 在[第 127 到 129 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/fetchgithub/default.nix#L127-L129)的选择是 `fetcher = if useFetchGit then fetchgit else fetchzip`，注释说“不需要 submodule 的时候我们优先用 fetchzip，因为这样 hash 更稳定”。所以普通的 `fetchFromGitHub` 下载的是 GitHub 生成的 tarball，解包，再哈希目录。

固定输出 derivation 能联网，是因为它的输出由 hash 事后检查，不是由构建过程决定的。Nix 里这一点体现在两处：Linux 沙箱只有在 derivation 是“沙箱化”的时候才[给它一个新的网络命名空间](https://github.com/NixOS/nix/blob/2.34.9/src/libstore/unix/build/linux-derivation-builder.cc#L459-L460)(`CLONE_NEWNET`)，固定输出不是，所以它保留主机网络；沙箱还会[为它准备 `/etc/resolv.conf` 等文件](https://github.com/NixOS/nix/blob/2.34.9/src/libstore/unix/build/linux-derivation-builder.cc#L658-L661)（注释里写着“固定输出 derivation 通常需要访问网络”）。机制第 6 篇已经讲过，这里不重复。

### fakeHash：先让它失败，再抄走答案

写一个新包的时候你没有 hash。工作流是用 `lib.fakeHash` 占位，让构建失败，从错误里抄真的 hash。`fetchers.nix` 里有一个开关 `fake`，把 `fetchFromGitHub` 的 `hash` 换成 `lib.fakeHash`：

```text
$ sed -n 10,12p out/ch10/fetchers.stdout
== the fakeHash workflow: lib.fakeHash makes the build fail and print the real hash
specified: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
got:    sha256-y+6fZYN1bMicL+IzPC1Wr4mrol+VEVkiDFWuxtsiSxg=
```

`lib.fakeHash` 是 [`sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/deprecated/misc.nix#L434)，43 个字符的 `A` 加一个 `=`，也就是 32 个零字节的 SRI 写法，当然不会匹配任何真的内容。Nix 把 `fetchFromGitHub` 抓下来、解包、算出 NAR 的 sha256，和你写的比较，不一致就报错，消息文本在 [`derivation-check.cc` 第 40 到 44 行](https://github.com/NixOS/nix/blob/2.34.9/src/libstore/build/derivation-check.cc#L40-L44)：`hash mismatch in fixed-output derivation '%s':\n  specified: %s\n     got:    %s`。`got:` 那一行就是答案，抄进 `hash = ...`，重新构建一次就行。

`fakeHash` 是一个**工作流**，不是**状态**：提交里留着 `lib.fakeHash` 是 bug，而 `make lint` 查不出来，因为它是一个合法的字符串。

### nurl、nix-prefetch-url 和 nix hash convert

不想靠失败来拿 hash，有两种办法。`nurl` 直接给整段 `fetchFromGitHub` 的 Nix 表达式，包括 hash：

```text
$ sed -n 14,20p out/ch10/fetchers.stdout
== nurl https://github.com/bfmhno3/cairn ch10
fetchFromGitHub {
  owner = "bfmhno3";
  repo = "cairn";
  tag = "ch10";
  hash = "sha256-y+6fZYN1bMicL+IzPC1Wr4mrol+VEVkiDFWuxtsiSxg=";
}
```

它输出的 `hash` 和上面的 `got:` 一样。第二个办法是旧工具 `nix-prefetch-url --unpack`，它对 URL 下载、解包，打印目录的 hash，但格式是 Nix 自己的 base32，不是 SRI。要转成 SRI，用 `nix hash convert`：

```text
$ sed -n 22,25p out/ch10/fetchers.stdout
== nix-prefetch-url --unpack (prints nix32), then nix hash convert to SRI
nix32: 062b4bdwdbjm1hi5j4cmbyiap2dgaqnkqcz25yfchv3mhdjrzvnb
sri:   sha256-y+6fZYN1bMicL+IzPC1Wr4mrol+VEVkiDFWuxtsiSxg=
matches the fetchFromGitHub hash
```

`nix32` 是 52 个字符的 Nix base32（[字母表](https://github.com/NixOS/nix/blob/2.34.9/src/libutil/include/nix/util/base-nix-32.hh#L17)里没有 `e`、`o`、`u`、`t`），`nix hash convert --hash-algo sha256 --to sri` 把它变成 `sha256-y+6fZYN1...`，实验里和 `fetchFromGitHub` 的 `outputHash` 对比了一遍，一致。手册里的[`nix hash convert`](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-hash-convert)和[`nix-prefetch-url`](https://nix.dev/manual/nix/2.34/command-ref/nix-prefetch-url)可以查细节。

SRI 是 `<算法>-<base64>`，Firn 的代码风格要求 hash 一律用这种形式（第 6 篇的 `outputHash` 就是）。

### tarball_vs_nar.sh：为什么 fetchFromGitHub 哈希的是目录

为什么 `fetchFromGitHub` 不直接对 `.tar.gz` 的字节算 hash，而要解包后算目录？`lab/ch10/tarball_vs_nar.sh` 在沙箱里下载同一个 tarball，用两种方式算：

```text
$ cat out/ch10/tarball_vs_nar.stdout
== bytes of the tarball
size: 88024
sha256sum:      9256181ae83e50a75ebb4907679a35ec0ec2488192226cbeddc8a9cc7d19798f
nix hash file:  sha256-klYYGug+UKdeu0kHZ5o17A7CSIGSImy+3cipzH0ZeY8=

== NAR hash of the unpacked tree
nix hash path:  sha256-y+6fZYN1bMicL+IzPC1Wr4mrol+VEVkiDFWuxtsiSxg=

== what the fetchers check
tarball: flat sha256-klYYGug+UKdeu0kHZ5o17A7CSIGSImy+3cipzH0ZeY8=
fromGitHub: nar sha256-y+6fZYN1bMicL+IzPC1Wr4mrol+VEVkiDFWuxtsiSxg=
```

88,024 字节的 `.tar.gz`，字节的 sha256 是 `sha256-klYYGug+...`，和 `tarball` 那个 `fetchurl` (`flat`) 的 hash 一样（输出里 `nix hash file` 那行和最后的 `tarball:` 那行）；解包后的目录的 NAR sha256 是 `sha256-y+6fZYN1...`，和 `fromGitHub` (`nar`) 一样。同一份内容，两个不同的 hash，各自对应一种“你在检查什么”：字节还是内容。

理由不在 Nix 里，在 GitHub 那一边。GitHub 自己的说法是，它[不保证自动生成的归档的校验和稳定](https://github.blog/changelog/2023-01-30-git-archive-checksums-may-change/)（就是 Releases 页面上的 “Source code (tar.gz)”）：2023 年 1 月 Git 改了归档的默认压缩，内容没变，校验和变了，GitHub 随后表示先把这个改动回退；如果需要稳定的校验和，应该把归档作为 Release 资产上传。`.tar.gz` 的字节取决于 `tar` 和 `gzip` 怎么压，目录的 NAR 只取决于文件。fetcher 对目录算 hash，就绕开了压缩层的变动，nixpkgs 的注释说的“hash 更稳定”（上面那个第 127 行）就是这个意思。

`tag = "ch10"` 这样的标签是可以被挪动的，hash 是它的保险：标签被挪到别的 commit，抓下来的目录变了，hash 对不上，构建失败而不是悄悄换内容。第 11 篇要用的正是这个：`cairn` 的 `src` 是 `fetchFromGitHub { owner = "bfmhno3"; repo = "cairn"; tag = "ch10"; hash = ...; }`。

## lib.fileset：用集合而不是函数选源码

回到 `package.nix` 的 `src`。第 4 篇我用 `cleanSource` 过滤目录，它是一个“黑名单”：给一个函数，告诉它哪些文件不要。`lib.fileset` 是“集合”：先说想要哪些文件，用并、交、差组合。`lab/ch10/fileset.nix` 用 `fixtures/fileset_demo/`（`main.c`，`Makefile`，和一个与构建无关的 `notes.txt`）演示：

```nix
  root = ./fixtures/fileset_demo;
  picked = lib.fileset.unions [
    (root + "/main.c")
    (root + "/Makefile")
  ];
  src = lib.fileset.toSource {
    inherit root;
    fileset = picked;
  };
  everything = lib.fileset.toSource {
    inherit root;
    fileset = root;
  };
  rel = p: lib.removePrefix "${toString root}/" (toString p);
in
```

```text
$ cat out/ch10/fileset.stdout
{ c_files_only = [ "main.c" ]; everything_in_store = [ "Makefile" "main.c" "notes.txt" ]; picked_files = [ "Makefile" "main.c" ]; picked_in_store = [ "Makefile" "main.c" ]; same_store_path = false; traced = "done"; without_notes = [ "Makefile" "main.c" ]; }
$ cat out/ch10/fileset.stderr
trace: /home/bfmhno3/Projects/firn/lab/ch10/fixtures/fileset_demo
trace: - Makefile (regular)
trace: - main.c (regular)
```

`picked_files` 是 `Makefile` 和 `main.c`；`toSource` 之后 store 里只有这两个 (`picked_in_store`)，整个目录当 `src` 则多了 `notes.txt` (`everything_in_store`)；`without_notes` (`difference`) 和 `c_files_only` (`fileFilter`) 是两种别的组合方式；`same_store_path = false`，两种选法得到不同的路径。`lib.fileset.trace` 把集合的树打到 stderr：只有 `Makefile` 和 `main.c` 两个 `regular` 文件，这在调试“我到底选了什么”的时候很有用。`toSource` 在 [`lib/fileset/default.nix` 第 418 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/fileset/default.nix#L418)，`unions` 在[第 617 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/fileset/default.nix#L617)，`trace` 在[第 245 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/fileset/default.nix#L245)；手册里是[“fileset”一章](https://nixos.org/manual/nixpkgs/unstable/#sec-functions-library-fileset)。

它真正的价值，是“改一个无关文件不会重新构建”。我手敲了一个验证：把 `fileset_demo` 拷到 `/tmp/fs_demo`，往 `notes.txt` 追加一行，然后对两个根目录各算两种选法的 store 路径，每行的两列是“只选两个文件”和“整个目录”（手敲，不在 `lab/ch10/` 里）：

```text
$ cp -r lab/ch10/fixtures/fileset_demo /tmp/fs_demo && echo changed >> /tmp/fs_demo/notes.txt
$ for root in ./lab/ch10/fixtures/fileset_demo /tmp/fs_demo; do
>   nix eval --impure --json --expr "
>     let lib = (import ./nix/pkgs.nix { }).lib; root = ${root}; in
>     [
>       (lib.fileset.toSource { inherit root; fileset = lib.fileset.unions [ (root + \"/main.c\") (root + \"/Makefile\") ]; }).outPath
>       (lib.fileset.toSource { inherit root; fileset = root; }).outPath
>     ]" | jq -r 'join(" ")'
> done
/nix/store/hnhsvqyq6r34m5jl16gmr8140332hz50-source /nix/store/qvg7kq7dwhn8gvpmca4qzk8zs2xb99j6-source
/nix/store/hnhsvqyq6r34m5jl16gmr8140332hz50-source /nix/store/f4fhq8cq6bn5a5gwmkhr4xjsqq38rhbk-source
```

第一列两行相同：`notes.txt` 变了，被选中的源码没变。第二列不同：整个目录当 `src`，改 `notes.txt` 就换路径。`firn-hello` 的 `src` 是第一种，所以以后我在 `src/firn-hello/` 里放一个 README，它不会引起重建。

`fileset` 的另一个好处是**选了一个不存在的文件会立刻报错**，而不是静默忽略（手敲，不在 `lab/ch10/` 里）：

```text
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix {}).lib; in lib.fileset.toSource { root = ./lab/ch10/fixtures/fileset_demo; fileset = lib.fileset.unions [ ./lab/ch10/fixtures/fileset_demo/main.c ./lab/ch10/fixtures/fileset_demo/nosuch.c ]; }' 2>&1 | grep 'does not exist'
       error: lib.fileset.unions: Element 1 (/home/bfmhno3/Projects/firn/lab/ch10/fixtures/fileset_demo/nosuch.c) is a path that does not exist.
```

如果 `package.nix` 里的 `firn-hello.c` 被改了名，求值就会失败，而不是造出一个缺文件的源码目录。

## meta 和 nix log

`package.nix` 的 `meta` 求出来是什么，和构建的时候到底跑了哪些命令，`lab/ch10/meta_and_log.sh` 各看一遍。`meta` 是 `nix eval --json` 出来的，我让 `jq` 去掉 `identifiers`、`position`、`problems`，把 `platforms` 换成个数：

```text
$ sed -n 2,39p out/ch10/meta_and_log.stdout
{
  "available": true,
  "broken": false,
  "description": "Greeting program that prints a zlib crc32 of its first line",
  "insecure": false,
  "license": [
    {
    ...（license 数组中两个对象的字段在这里省略）
  ],
  "mainProgram": "firn-hello",
  "maintainers": [],
  "name": "firn-hello-0.1.0",
  "nonTeamMaintainers": [],
  "outputsToInstall": [
    "out"
  ],
  "platforms": 45,
  "unfree": false,
  "unsupported": false
}
```

`platforms` 是 45，`lib.platforms.unix` 在这个 nixpkgs 里有 45 个系统。`license` 是两个对象（MIT 和 Apache 2.0，各自的字段在上面省略了）。`available`、`broken`、`insecure`、`unsupported`、`unfree` 不是 `package.nix` 里写的，是 nixpkgs 补上去的：`meta` 里不止有你写的，还有 `check-meta.nix` 算出来的，和上一节 `Refusing to evaluate` 用的是同一批检查。

构建日志：`nix log` 读 Nix 守护进程保存的构建日志（手册里的[`nix log`](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-log)）。实验过滤出有用的几行：

```text
$ sed -n 41,53p out/ch10/meta_and_log.stdout
== nix log: phases and the lines that matter
Running phase: unpackPhase
Running phase: patchPhase
Running phase: updateAutotoolsGnuConfigScriptsPhase
Running phase: configurePhase
Running phase: buildPhase
gcc -O2 -Wall -Wextra -I<zlib-dev>/include -o firn-hello firn-hello.c -lz
Running phase: installPhase
install -D -m 755 firn-hello <out>/bin/firn-hello
Running phase: fixupPhase
shrinking <out>/bin/firn-hello
stripping (with command strip and flags -S -p) in <out>/bin
Running phase: installCheckPhase
```

`<zlib-dev>` 和 `<out>` 是脚本把 store 路径换成的占位符。逐行说：

- 一共八个 phase：`unpackPhase`、`patchPhase`、`updateAutotoolsGnuConfigScriptsPhase`、`configurePhase`、`buildPhase`、`installPhase`、`fixupPhase`，最后是 `installCheckPhase`，`doInstallCheck` 打开的那个。第 7 篇我手写的 mini stdenv 只有 `unpack`、`patch`、`build`、`install`、`fixup` 五个。
- `gcc -O2 -Wall -Wextra -I<zlib-dev>/include -o firn-hello firn-hello.c -lz`：`-O2 -Wall -Wextra` 是 Makefile 的 `CFLAGS ?=`，`-I<zlib-dev>/include` 是 `ZLIB_CFLAGS` (`pkg-config --cflags zlib`)，`-lz` 是 `package.nix` 覆盖的 `ZLIB_LIBS`。**没有** `-DFIRN_GREETING=...`：它不在命令行里，是 cc-wrapper 从 `NIX_CFLAGS_COMPILE` 加的，下一节说。
- `install -D ...` 是 Makefile 的 `install` 目标（`PREFIX` 已是真路径）；`shrinking` 和 `stripping` 是 `fixupPhase` 里 stdenv 自己做的两件事：缩 rpath、去调试符号。

日志是本机构建时守护进程保存的；从二进制缓存拿到 (substituted) 的 derivation 没有日志，实验里专门处理了这种情况，打印 `no build log: this derivation was substituted, not built here` 后退出。

## cc-wrapper：NIX_CFLAGS_COMPILE、rpath 与加固

上面那条 `gcc` 命令里的 `gcc`，不是直接的 GCC。stdenv 里的 `gcc` 是 **cc-wrapper** 生成的脚本，真的编译器在它里面，你看不到的那部分工作都在这个脚本里。`lab/ch10/rpath.sh` 看三处：构建环境里的变量、结果文件里的 ELF 头、和闭包。

先是构建环境。`nix develop --file nix/pkgs.nix firn-hello` 给出 `firn-hello` 的构建环境（第 9 篇那种），实验在里面打印几个变量：

```text
$ sed -n 16,23p out/ch10/rpath.stdout
== inside the build environment
NIX_HARDENING_ENABLE=bindnow format fortify fortify3 libcxxhardeningfast pic relro stackclashprotection stackprotector strictflexarrays1 strictoverflow zerocallusedregs
NIX_CFLAGS_COMPILE=-DFIRN_GREETING="Hello" -isystem /nix/store/dfb5jybg1sakjy1zahpgrxfqmz5rfwmc-zlib-1.3.2-dev/include
NIX_LDFLAGS=-L/nix/store/zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb-zlib-1.3.2/lib
pkg-config --libs zlib:
  -L/nix/store/0c5qg74fw50vz6scy5dn2zm6h2bvsscn-zlib-1.3.2-static/lib
  -L/nix/store/zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb-zlib-1.3.2/lib
  -lz
```

`NIX_CFLAGS_COMPILE` 里有我关心的两样：`-DFIRN_GREETING="Hello"`（`package.nix` 的 `env.NIX_CFLAGS_COMPILE`）和 `-isystem .../zlib-1.3.2-dev/include`（stdenv 的 setup hook 看到 `zlib-dev` 有 `include` 目录，[就追加了 `-isystem`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/cc-wrapper/setup-hook.sh#L74)）。真实的值里还有一个 `-frandom-seed=...`，`NIX_LDFLAGS` 里还有一个指向构建目录的 `-rpath` 项，`rpath.sh` 用 `sed` 把它们去掉了。cc-wrapper 在命令行**后面**追加它们：[`cc-wrapper.sh` 第 198 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/cc-wrapper/cc-wrapper.sh#L198)，`extraAfter=(... $NIX_CFLAGS_COMPILE_@suffixSalt@)`。

`NIX_LDFLAGS=-L.../zlib-1.3.2/lib`：[bintools-wrapper 的 setup hook](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/bintools-wrapper/setup-hook.sh#L27)看到 `zlib` 的 `out` 输出里有 `lib/lib*`，就加一个 `-L`。注意只有一个，是 `out` 的，不是 `static` 的：从这个结果看，`buildInputs = [ zlib ]` 没有把 `static` 输出带进 `NIX_LDFLAGS`。

上面最后三行 `pkg-config --libs zlib` 的输出里，`-L` 的顺序是 static 在前。这是 `zlib.pc` 里写的，再看两个目录里各有什么（手敲，不在 `lab/ch10/` 里）：

```text
$ grep -E '^(libdir|sharedlibdir|Libs)' /nix/store/dfb5jybg1sakjy1zahpgrxfqmz5rfwmc-zlib-1.3.2-dev/share/pkgconfig/zlib.pc
libdir=/nix/store/0c5qg74fw50vz6scy5dn2zm6h2bvsscn-zlib-1.3.2-static/lib
sharedlibdir=/nix/store/zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb-zlib-1.3.2/lib
Libs: -L${libdir} -L${sharedlibdir} -lz
$ ls /nix/store/0c5qg74fw50vz6scy5dn2zm6h2bvsscn-zlib-1.3.2-static/lib /nix/store/zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb-zlib-1.3.2/lib
/nix/store/0c5qg74fw50vz6scy5dn2zm6h2bvsscn-zlib-1.3.2-static/lib:
libz.a

/nix/store/zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb-zlib-1.3.2/lib:
libz.so
libz.so.1
libz.so.1.3.2
```

`Libs: -L${libdir} -L${sharedlibdir} -lz`，`libdir` 在 nixpkgs 的 zlib 里指向 `static` 输出，`sharedlibdir` 指向 `out`。nixpkgs 把静态库拆到单独的输出，是为了避免[“上游这个有问题的行为带来的闭包体积惩罚”](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/development/libraries/zlib/default.nix#L14-L19)（注释里说，zlib 的 `./configure` 总是会构建静态库，而 `--static` 是 `--disable-shared` 的别名；nixpkgs 用一个单独的 `static` 输出装静态库，对应的开关是 [`splitStaticOutput`，第 21 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/development/libraries/zlib/default.nix#L21)）。而 `-lz` 前面是两个 `-L`，按 `ld` 的搜索规则，它一个目录一个目录地找，每个目录里 `libz.so` 和 `libz.a` 都接受，第一个有的就用。`static` 目录里只有 `libz.a`，排在前面，所以 `-lz` 就选了静态库（这是我从结果反推的，没有去读 `ld` 的源码；下面不覆盖时的 `NEEDED` 里没有 `libz.so.1`，和这个解释一致）。

这就是为什么 `package.nix` 里有 `"ZLIB_LIBS=-lz"`。不覆盖它，Makefile 会用 `pkg-config --libs zlib`，得到上面三行，链接器就静态链接了 `libz.a`。不覆盖会怎样，`lab/ch10/fixtures/firn_hello_default_link.nix` 保留了那个版本，它把 `makeFlags` 里的 `ZLIB_LIBS=` 去掉：

```nix
let
  pkgs = import ../../../nix/pkgs.nix { };
in
pkgs.firn-hello.overrideAttrs (old: {
  pname = "firn-hello-pcstatic";
  makeFlags = builtins.filter (f: !(pkgs.lib.hasPrefix "ZLIB_LIBS=" f)) old.makeFlags;
})
```

```text
$ sed -n 41,46p out/ch10/rpath.stdout
== variant without ZLIB_LIBS=-lz (zlib.pc order)
needed:
  libc.so.6
references:
  glibc-2.42-67
crc32: 8bb8f4d3
```

`NEEDED` 里只有 `libc.so.6`，引用里只有 `glibc`，程序照样跑，`crc32: 8bb8f4d3` 和动态链接的版本一样。静态链接不是错，闭包甚至小了一点：我手敲量了一下，这个版本是 36.0 MiB，5 个路径（手敲，不在 `lab/ch10/` 里）：

```text
$ nix path-info -S -h $(nix build --no-link --print-out-paths --file lab/ch10/fixtures/firn_hello_default_link.nix)
/nix/store/871b7jjjakv18gcp8k9wzfviyncy9yb9-firn-hello-pcstatic-0.1.0	  36.0 MiB
```

对比动态版本的 36.1 MiB、6 个路径，只差一个 129.5 KiB 的 `zlib`，因为 glibc 一个就占 33.4 MiB。我选动态链接，主要是想让 `zlib` 作为运行时依赖出现在闭包里，这样下面的 rpath 和 `NEEDED` 才有东西可看。

### rpath、NEEDED 和闭包

动态版本的结果文件：

```text
$ sed -n 1,14p out/ch10/rpath.stdout
== patchelf
interpreter: /nix/store/0d8g8n0a11v6f5m2h416ajyxmnkwc3md-glibc-2.42-67/lib/ld-linux-x86-64.so.2
rpath:
  /nix/store/zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb-zlib-1.3.2/lib
  /nix/store/0d8g8n0a11v6f5m2h416ajyxmnkwc3md-glibc-2.42-67/lib
needed:
  libz.so.1
  libc.so.6

== ldd
	linux-vdso.so.1
	libz.so.1 => /nix/store/zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb-zlib-1.3.2/lib/libz.so.1
	libc.so.6 => /nix/store/0d8g8n0a11v6f5m2h416ajyxmnkwc3md-glibc-2.42-67/lib/libc.so.6
	/nix/store/0d8g8n0a11v6f5m2h416ajyxmnkwc3md-glibc-2.42-67/lib/ld-linux-x86-64.so.2 => /nix/store/0d8g8n0a11v6f5m2h416ajyxmnkwc3md-glibc-2.42-67/lib64/ld-linux-x86-64.so.2
```

`RUNPATH` 有两项，都是 store 路径：`zlib-1.3.2/lib` 和 `glibc-2.42-67/lib`，`NEEDED` 是 `libz.so.1` 和 `libc.so.6`，`ldd` 把它们解析进 store，解释器是 store 里的 `ld-linux-x86-64.so.2`，没有 `/lib64`，没有 `ld.so.conf`。rpath 是链接器 wrapper 加的：[`ld-wrapper.sh` 第 196 到 242 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/bintools-wrapper/ld-wrapper.sh#L196-L242)里，它按顺序遍历 `-L` 目录，看哪个目录里有被某个 `-l` 用到的动态库，有就 `-rpath` 它。命令行里没有人写过 `-rpath`，`firn-hello` 也能运行，靠的就是这个。`fixupPhase` 的 `shrinking` 再把没用的 rpath 项去掉。

加固 (hardening)：

```text
$ sed -n 25,30p out/ch10/rpath.stdout
== hardening in the binary
 Type: DYN (Position-Independent Executable file)
GNU_RELRO segments: 1
 0x000000000000001e (FLAGS) BIND_NOW
 0x000000006ffffffb (FLAGS_1) Flags: NOW PIE
__stack_chk_fail symbols: 2
```

`NIX_HARDENING_ENABLE` 是构建环境里第一行，12 个标志：`bindnow format fortify fortify3 libcxxhardeningfast pic relro stackclashprotection stackprotector strictflexarrays1 strictoverflow zerocallusedregs`。它是编译器 wrapper 读的，[`add-hardening.sh` 第 9 到 11 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/cc-wrapper/add-hardening.sh#L9-L11)把它读成一个集合，再按它往命令行里加相应的选项（具体加哪些是 wrapper 的事，我没有逐项展开；手册里有[一节](https://nixos.org/manual/nixpkgs/unstable/#sec-hardening-in-nixpkgs)讲每个标志）。结果里能看到的是：`DYN (Position-Independent Executable file)` (`pic`)，一个 `GNU_RELRO` 段 (`relro`)，`BIND_NOW`（`bindnow`，加上 RELRO 就是完整 RELRO），`FLAGS_1: NOW PIE`，以及对 `__stack_chk_fail` 的引用（应当对应 `stackprotector`）。最后一行的“2”是 `readelf -s` 里出现的行数，一行是动态符号表，一行是普通符号表（`strip -S` 只去调试符号，没有去掉符号表）；我手敲 `readelf --dyn-syms -W ... | grep -c __stack_chk_fail` 确认过动态符号表那边是 1。

闭包：

```text
$ sed -n 32,39p out/ch10/rpath.stdout
== closure
libunistring-1.4.2	 2.0 MiB
libidn2-2.3.8 	 359.5 KiB
xgcc-15.3.0-libgcc	 193.0 KiB
glibc-2.42-67 	 33.4 MiB
zlib-1.3.2 	 129.5 KiB
firn-hello-0.1.0 	 16.1 KiB
closure: firn-hello-0.1.0	 36.1 MiB
```

6 个路径，36.1 MiB（我手敲 `nix path-info -S` 得到 37,866,984 字节），`firn-hello` 自己是 16.1 KiB，`glibc` 是 33.4 MiB，约占 92%。`libidn2`、`libunistring` 和 `libgcc` 是 `glibc` 带来的，不是我们的。`firn-hello` 自己只引用 `glibc` 和 `zlib` 两个路径。47 行 C 打出来的包，用上面四舍五入的数粗算，闭包体积约 99.6% 是 `glibc` 和它带来的三个路径，我觉得这是理解 nixpkgs 闭包的好起点：库就是这么大，你的程序只占一个舍入误差。

## by-name：下一个版本的写法

最后一个预告。`firn-hello` 是在 `pkgs/firn-hello/package.nix` 里写的，由 `overlays/default.nix` 手工 `callPackage`。nixpkgs 自己的新包不是这样的：新包放到 `pkgs/by-name/<xx>/<name>/package.nix`，`<xx>` 是名字前两个字母（小写），不用再往 `all-packages.nix` 里登记。`lab/ch10/by_name_layout.sh` 看这个布局：

```text
$ cat out/ch10/by_name_layout.stdout
== where hello is defined (meta.position)
pkgs/by-name/he/hello/package.nix:57
== files of pkgs/by-name/he/hello
package.nix
test.nix

== shard rule: <xx> = first two letters of the name, lower case
volatile: 21634 package directories under pkgs/by-name at this pin
directories that break the shard rule: 0
```

`hello` 定义在 `pkgs/by-name/he/hello/package.nix:57`（`meta.position` 里记录的位置），那个目录里有 `package.nix` 和 `test.nix`。这个 nixpkgs 里有 21,634 个 `by-name` 包目录（`volatile`，这个 rev 下的数），没有一个违反分片规则。前面看 `stage.nix` 的时候说过：`by-name` 不是一种特殊机制，它就是第 5 层 overlay ([`by-name-overlay.nix`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/by-name-overlay.nix))，和我们的 `overlays/default.nix` 做同一件事：给每个目录 `callPackage` 一次。第 14 篇给 nixpkgs 提 PR 的时候会用这个布局。

## 让我意外的事

这一篇写完，我对 nixpkgs 里“改一个包”的印象换了。四件事：

**`override` 和 `overrideAttrs` 的区别是“在哪一层改”。** `greeting` 在 `package.nix` 里用了两次，`override` 改的是源头，两处一起变；`overrideAttrs` 只改我指到的那一处，于是 `rebuilt` 变体的 `installCheckPhase` 期待 `Hello`，程序却打印 `Moin`，构建失败，日志只有最后一行 `Running phase: installCheckPhase`。同理 `bumped` 的包名是 `0.1.1`，程序自己说 `0.1.0`：Nix 里的 `version` 和 C 里的 `FIRN_VERSION` 是两份，谁也不管谁。

**一个无关紧要的 `zlib` overlay，让 `firn-hello` 要重建 100 个 derivation，下载 642.8 MiB。** 原因是 `gcc-15.3.0.drv` 直接引用 `zlib-1.3.2.drv`，换 zlib 就换编译器，换编译器就换所有东西。对 `firn-hello` 做 `override { zlib = ...; }` 是 2 个，差 50 倍。我现在读别人的 overlay 时，会先看它改的是不是一个“很深”的包。

**`firn-hello` 默认会静态链接 zlib。** `zlib.pc` 的 `Libs` 里 `-L${libdir}` 在前，`libdir` 指向只有 `libz.a` 的 `static` 输出，所以 `package.nix` 里要多一行 `"ZLIB_LIBS=-lz"`；`rpath.sh` 用 `fixtures/firn_hello_default_link.nix` 保留了不覆盖的样子，`NEEDED` 里只有 `libc.so.6`。

**`prev.callPackage` 和 `final.callPackage` 是同一个函数。** 我一直以为“依赖要从 `final` 取”是写 overlay 的第一条规矩，验证时发现 `prev.callPackage` 得到的 `.drvPath` 一模一样，因为 `callPackage` 在 `splice.nix` 里已经绑定了最终的包集。规矩对 `final.zlib` 这样的属性仍然成立，`prev.zlib` 还是下层的 `zlib`。

## 检查点

在 `~/firn` 里，`nix develop` 之内：

```bash
make ch10
make lint
make check
while read -r f; do
  diff <(git -C ~/firn-ref show ch10:"${f}") "${f}" && echo "same ${f}"
done < <(git -C ~/firn-ref diff --name-only ch09 ch10 \
  | grep -v -e '^default.nix$' -e '^flake.nix$' -e '^overlays/')
```

我的环境里设了 `CI=true`，下面的输出是 `env -u CI make ch10`。第 10 章没有 `_host` 实验，`CI=true` 不会让任何一个被跳过，但 `fetchers.sh`、`tarball_vs_nar.sh`、`overlay_rebuild_scope.sh` 三个实验要联网，没网的话它们会打印 `offline:` 开头的一行并以 0 退出，这时它们的“通过”不说明任何事。`make ch10` 应当打印这 15 行，整条命令（包含 `nix develop` 的启动）在这台机器上花了 247 秒：

```text
bash scripts/chapter.sh ch10
ok   lab/ch10/allow_unfree.nix
ok   lab/ch10/by_name_layout.sh
ok   lab/ch10/callpackage_auto.nix
ok   lab/ch10/callpackage_source.sh
ok   lab/ch10/ex_greeting_overlay.nix
ok   lab/ch10/fetchers.sh
ok   lab/ch10/fileset.nix
ok   lab/ch10/meta_and_log.sh
ok   lab/ch10/overlay_final_recursion_fail.nix
ok   lab/ch10/overlay_order.nix
ok   lab/ch10/overlay_rebuild_scope.sh
ok   lab/ch10/override_kinds.sh
ok   lab/ch10/rpath.sh
ok   lab/ch10/tarball_vs_nar.sh
```

14 个实验全部是 `ok`。其中 `overlay_final_recursion_fail.nix` 的 `ok` 是“按设计失败”：运行器见到 `_fail` 后缀，期待非零退出码，它的退出码是 1。

`make lint` 回显它跑的几条命令（`nixfmt --check`、`deadnix --fail`、`shellcheck`、`shfmt`；`statix` 那一行以 `@` 开头，`make` 不回显），没有任何诊断，退出码 0。`make check` 以 `all checks passed!` 结束，退出码 0，x86_64-linux 上现在有 6 个检查，比第 9 篇多了 `pkg-firn-hello` 和 `pkg-firn-hello-hallo`。它还会打印 `running 0 flake checks...`，和一行说 `aarch64-linux` 被跳过的 `warning`：这是正常的，第一行的解释在练习 3 里。

`diff` 循环应当打印 27 行 `same ...`，不打印 diff (27 = 30 - 3)。

**必须和标签一致的文件：** `src/firn-hello/` 下 2 个文件、`nix/pkgs.nix`，以及 `lab/ch10/` 下全部 23 个文件（14 个实验加 9 个 fixture 文件）。`pkgs/firn-hello/package.nix` 见下面的列表。

**中间版本（后面的章节会继续改）：**

- [`overlays/default.nix`](https://github.com/bfmhno3/firn/blob/ch10/overlays/default.nix)：现在只有 `firn-hello` 一个属性，第 11 篇起每打一个新包都会往里加一行。
- [`default.nix`](https://github.com/bfmhno3/firn/blob/ch10/default.nix)：现在是 `firn-hello` 和 `mini`，同样会随包增加。
- [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch10/flake.nix)：`packagesFor` 现在只有三个包，后面每章都会往 `packages`、`checks` 里加东西。
- [`pkgs/firn-hello/package.nix`](https://github.com/bfmhno3/firn/blob/ch10/pkgs/firn-hello/package.nix)：这一章定稿；第 12 篇交叉编译如果暴露出真 bug，可能会改它。

### 文件清单

这一篇的所有文件都在仓库里，链接指向标签 `ch10` 上的那一份。`git diff --name-only ch09 ch10` 列出 30 个文件，这里一个不少；`lab/ch10/` 下有 23 个文件，14 个实验加 9 个 fixture 文件（包括 `fixtures/fileset_demo/` 里的三个）。`LICENSE-MIT` 和 `LICENSE-APACHE` 没有变，不在表里。实验需要沙箱目录，所以它们的命令都是 `make ch10`；命令列里不是 `make ch10` 的，都是我手敲的，不在 `lab/ch10/` 里。fixture 文件不单独运行，命令列写的是读它的那个实验。结果列是我在 Nix 2.34.9 下实际跑出来的，标 `volatile` 的数字取决于缓存和 nixpkgs 的 rev。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`default.nix`](https://github.com/bfmhno3/firn/blob/ch10/default.nix) | `nix-build -A firn-hello --no-out-link` | 退出码 0，输出 `/nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0`，和 `nix build .#firn-hello` 是同一个路径 |
| [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch10/flake.nix) | `make check` | 退出码 0，`all checks passed!`；x86_64-linux 的 `checks` 有 6 个，`packages` 有 3 个，另有 `overlays.default` |
| [`lab/ch10/allow_unfree.nix`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/allow_unfree.nix) | `make ch10` | 退出码 0；`config_empty = false`、`allowUnfree_true = true`、`predicate_unrar_ok = true`、`predicate_vscode_rejected = true` |
| [`lab/ch10/by_name_layout.sh`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/by_name_layout.sh) | `make ch10` | 退出码 0；`hello` 在 `pkgs/by-name/he/hello/package.nix:57`；`volatile: 21634` 个包目录，0 个违反分片规则 |
| [`lab/ch10/callpackage_auto.nix`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/callpackage_auto.nix) | `make ch10` | 退出码 0；`functionArgs` 5 个名字，只有 `greeting` 有默认值；`sameDrvAsOverlay = true` |
| [`lab/ch10/callpackage_source.sh`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/callpackage_source.sh) | `make ch10` | 退出码 0；打印一行标题和 `callPackageWith` 核心的 23 行，缺参数的报错带 `did you mean "zlib", "clib" or "dlib"?` |
| [`lab/ch10/ex_greeting_overlay.nix`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/ex_greeting_overlay.nix) | `make ch10` | 退出码 0；`same_drv_as_override = true`；练习 1 的答案 |
| [`lab/ch10/fetchers.sh`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/fetchers.sh) | `make ch10` | 退出码 0；四个固定输出，两个 `flat`、两个 `nar`；`got:    sha256-y+6fZYN1bMicL+IzPC1Wr4mrol+VEVkiDFWuxtsiSxg=`；离线时打印 `offline:` |
| [`lab/ch10/fileset.nix`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/fileset.nix) | `make ch10` | 退出码 0；`picked_in_store = [ "Makefile" "main.c" ]`，`same_store_path = false`；stderr 里 3 行 `trace:` |
| [`lab/ch10/fixtures/fetchers.nix`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/fixtures/fetchers.nix) | `make ch10`（`fetchers.sh`、`tarball_vs_nar.sh` 读它） | 四个固定输出，hash 是 `sha256-y+6fZYN1...`（目录）、`sha256-klYYGug+...` (tarball) 和 `sha256-gOmM4E80...` (`install.sh`) |
| [`lab/ch10/fixtures/fileset_demo/Makefile`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/fixtures/fileset_demo/Makefile) | `make ch10`（`fileset.nix` 读它） | 2 行（`all:` 和 `@true`），被 `toSource` 选中 |
| [`lab/ch10/fixtures/fileset_demo/main.c`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/fixtures/fileset_demo/main.c) | `make ch10`（`fileset.nix` 读它） | 4 行的空 `main`，被 `toSource` 选中 |
| [`lab/ch10/fixtures/fileset_demo/notes.txt`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/fixtures/fileset_demo/notes.txt) | `make ch10`（`fileset.nix` 读它） | 1 行 `not part of the build`，只出现在 `everything_in_store` 里 |
| [`lab/ch10/fixtures/firn_hello_default_link.nix`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/fixtures/firn_hello_default_link.nix) | `make ch10`（`rpath.sh` 读它） | `NEEDED` 只有 `libc.so.6`，引用只有 `glibc-2.42-67`；手敲 `nix path-info -S -h` 得 36.0 MiB |
| [`lab/ch10/fixtures/hello_tweak.nix`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/fixtures/hello_tweak.nix) | `make ch10`（`overlay_rebuild_scope.sh` 读它） | `volatile: 0 derivations will be built` |
| [`lab/ch10/fixtures/overrides.nix`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/fixtures/overrides.nix) | `make ch10`（`override_kinds.sh` 读它） | 五个变体五个不同的 out path，只有 `bumped` 的 `name` 是 `firn-hello-0.1.1`；手敲构建 `rebuilt` 失败、`bumped` 成功 |
| [`lab/ch10/fixtures/rec_vs_final.nix`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/fixtures/rec_vs_final.nix) | `make ch10`（`override_kinds.sh` 读它） | `rec_TAG = "v1"`，`final_TAG = "v2"`，两个 `name` 都带 `-2` |
| [`lab/ch10/fixtures/zlib_tweak.nix`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/fixtures/zlib_tweak.nix) | `make ch10`（`overlay_rebuild_scope.sh` 读它） | `volatile: 100 derivations will be built`，含 `zlib-1.3.2`、`firn-hello-0.1.0`、`glibc-2.42-67`、`gcc-15.3.0` |
| [`lab/ch10/meta_and_log.sh`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/meta_and_log.sh) | `make ch10` | 退出码 0；`"platforms": 45`；`nix log` 过滤后 12 行，最后一行 `Running phase: installCheckPhase` |
| [`lab/ch10/overlay_final_recursion_fail.nix`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/overlay_final_recursion_fail.nix) | `make ch10` | 退出码 1（按设计失败），stderr 里是 `infinite recursion encountered` |
| [`lab/ch10/overlay_order.nix`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/overlay_order.nix) | `make ch10` | 退出码 0；`composeManyExtensions_equals_list = true`；`observe_hallo_bonjour` 里 `prev` 是 `Hello`、`final` 是 `Bonjour` |
| [`lab/ch10/overlay_rebuild_scope.sh`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/overlay_rebuild_scope.sh) | `make ch10` | 退出码 0；`volatile:` 0、0、100 个 derivation；离线时打印 `offline:` |
| [`lab/ch10/override_kinds.sh`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/override_kinds.sh) | `make ch10` | 退出码 0；五个变体五个 out path；`same out path`；``evaluation warning: ... was overridden with `version` but not `src` ``；最后一行里 `rec_TAG = "v1"`、`final_TAG = "v2"` |
| [`lab/ch10/rpath.sh`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/rpath.sh) | `make ch10` | 退出码 0；`RUNPATH` 2 项，`NEEDED` 是 `libz.so.1` 和 `libc.so.6`；`NIX_HARDENING_ENABLE` 12 个标志；闭包 6 个路径、36.1 MiB |
| [`lab/ch10/tarball_vs_nar.sh`](https://github.com/bfmhno3/firn/blob/ch10/lab/ch10/tarball_vs_nar.sh) | `make ch10` | 退出码 0；`size: 88024`；tarball 字节的 hash 是 `sha256-klYYGug+...`，解包目录的 NAR hash 是 `sha256-y+6fZYN1...`；离线时打印 `offline:` |
| [`nix/pkgs.nix`](https://github.com/bfmhno3/firn/blob/ch10/nix/pkgs.nix) | `nix eval --impure --expr 'let p = import ./nix/pkgs.nix { }; in builtins.length (builtins.attrNames p)'` | 退出码 0，输出 `27960`；`overlays = [ ]` 时是 `27959` |
| [`overlays/default.nix`](https://github.com/bfmhno3/firn/blob/ch10/overlays/default.nix) | `nix eval .#overlays.default --apply builtins.typeOf` | 退出码 0，输出 `"lambda"` |
| [`pkgs/firn-hello/package.nix`](https://github.com/bfmhno3/firn/blob/ch10/pkgs/firn-hello/package.nix) | `nix build .#firn-hello --no-link --print-out-paths` | 退出码 0，输出 `/nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0`；`installCheckPhase` 通过 |
| [`src/firn-hello/Makefile`](https://github.com/bfmhno3/firn/blob/ch10/src/firn-hello/Makefile) | `nix develop --file nix/pkgs.nix firn-hello --command make -n -C src/firn-hello PREFIX=/tmp/x` | 退出码 0，打印的 `gcc` 行里有 `-L...-zlib-1.3.2-static/lib -L...-zlib-1.3.2/lib -lz` |
| [`src/firn-hello/firn-hello.c`](https://github.com/bfmhno3/firn/blob/ch10/src/firn-hello/firn-hello.c) | `nix run .#firn-hello -- nix` | 退出码 0，打印 `Hello, nix, from firn-hello 0.1.0` 和 `crc32: 8bb8f4d3`；多于一个参数时退出码 2，stderr 里是 `usage: firn-hello [--version] [NAME]` |

## 练习

**1.** 写一个 overlay，让所有用到 `firn-hello` 的包都默认使用 `"Hallo"`，不需要它们各自改参数。给一个只依赖 `firn-hello` 的包验证一下。

<details>
<summary>参考答案</summary>

这是 `lab/ch10/ex_greeting_overlay.nix`：

```nix
  hallo = _final: prev: {
    firn-hello = prev.firn-hello.override { greeting = "Hallo"; };
  };
  consumer = final: _prev: {
    firn-consumer = final.callPackage (
      { runCommand, firn-hello }:
      runCommand "firn-consumer" { } ''
        ${firn-hello}/bin/firn-hello consumer > $out
      ''
    ) { };
  };
  pkgs = import ../../nix/pkgs.nix {
    overlays = [
      (import ../../overlays)
      hallo
      consumer
    ];
  };
```

关键是 `prev.firn-hello.override { greeting = "Hallo"; }` **替换** `firn-hello` 这个属性本身，而不是另造一个新名字：这样之后任何通过 `callPackage` 拿 `firn-hello` 的包（这里是 `firn-consumer`，`consumer` 这个 overlay 用 `final.callPackage`）拿到的都是改过的那份。文件后半段用两个 `assert` 保证：改过的 `firn-hello` 和 `plain.firn-hello.override { greeting = "Hallo"; }` 是同一个 `.drvPath`，并且 `firn-consumer` 的构建命令里引用的正是改过的路径，不一致求值就失败。输出（一行）：

```text
$ cat out/ch10/ex_greeting_overlay.stdout
{ consumer_uses_overlaid_firn_hello = true; firn_hello = "-DFIRN_GREETING=\"Hallo\""; plain_firn_hello = "-DFIRN_GREETING=\"Hello\""; same_drv_as_override = true; }
```

`hallo` 必须排在 Firn 自己的 overlay 后面：顺序反过来，`prev.firn-hello` 还不存在。

</details>

**2.** 用 `lib.fakeHash` 的工作流，不看 `nurl` 的输出，拿到 `bfmhno3/cairn` 的标签 `ch09` 的 hash，再用 `nurl` 核对。

<details>
<summary>参考答案</summary>

把 `hash` 写成 `lib.fakeHash`，让构建失败，抄 `got:` 那一行（手敲，不在 `lab/ch10/` 里）：

```text
$ nix build --no-link --impure --expr '(import ./nix/pkgs.nix { }).fetchFromGitHub { owner = "bfmhno3"; repo = "cairn"; tag = "ch09"; hash = (import ./nix/pkgs.nix { }).lib.fakeHash; }' 2>&1 | grep -E '^ +(specified|got):' | sed 's/^ *//'
specified: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
got:    sha256-QPvGEuD2OOgYuo6RVTJsm1dkRJd+PliakHEnrRYoleQ=
```

用 `nurl https://github.com/bfmhno3/cairn ch09` 核对（手敲，不在 `lab/ch10/` 里）：它打印的 `hash` 也是 `sha256-QPvGEuD2OOgYuo6RVTJsm1dkRJd+PliakHEnrRYoleQ=`，两个一样。`ch09` 和 `ch10` 的 hash 不一样（`sha256-QPvGEuD2...` 对 `sha256-y+6fZYN1...`），因为 Cairn 的两个标签指向的目录不同。

</details>

**3.** `make check` 打印的是 `running 0 flake checks...`。这是不是说明 `pkg-firn-hello` 没有被检查？

<details>
<summary>参考答案</summary>

不是，它说明那些检查不需要再构建。`nix flake check` 先求值每个检查的 derivation（输出里的 `derivation evaluated to ...` 行，包括 `pkg-firn-hello` 和 `pkg-firn-hello-hallo`），再调 `queryMissing`，只构建 `willBuild` 里的（[`src/nix/flake.cc` 第 802 到 813 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/flake.cc#L802-L813)；源码注释说，已经能从缓存拿到的输出不再构建，因为 `flake check` 只需要验证“能构建”）。`pkg-firn-hello` 刚在这台机器上构建过，已经在 store 里，所以是 0。`--dry-run` 能看到同样的结论（手敲，不在 `lab/ch10/` 里）：

```text
$ nix build --dry-run .#checks.x86_64-linux.pkg-firn-hello .#checks.x86_64-linux.dev-shell; echo "rc=$?"
rc=0
```

没有 `will be built`，没有别的输出。换一台没有构建过的机器，像 `pkg-firn-hello` 这种不在任何公共缓存里的检查会先被构建。

</details>

## 下一篇

这一篇的包只有一个，源码在本地，依赖只有一个 zlib。下一篇要打的包没有这么乖：[第 11 篇：打包真项目：Cairn、Sift 与 Pebble](/posts/nix-by-firn-11-packaging-real-projects/)，三个我自己写过的项目，分别是 Bash、Python 和 Rust，`src` 要从 GitHub 抓（用的就是这一篇推出来的 `fetchFromGitHub`），Cairn 的脚本要被 `patchShebangs` 改掉解释器路径，还要用 `makeWrapper` 把它依赖的命令包进去。我最想知道的是闭包有多大：`firn-hello` 是 36.1 MiB，其中 glibc 占了 92%，Rust 和 Python 会不会把这个比例翻过来，我还不知道。
