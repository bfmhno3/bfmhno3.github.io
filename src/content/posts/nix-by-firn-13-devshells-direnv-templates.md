---
title: "开发环境：devShell、direnv 与 templates"
commentId: "post:nix-by-firn-13-devshells-direnv-templates"
published: "2026-11-06 09:00:00 +08:00"
description: "用 Firn 从零学 Nix 第 13 篇：我用 Nix 2.34.9、nixpkgs 56c02bc 和 nix-direnv 3.2.0 给 Firn 加了 C 与 Python 两个 devShell 和两个 flake 模板，用 10 个实验拆开 mkShell、inputsFrom、shellHook 和 direnv：同样的两个包，mkShell 的闭包是 415,167,120 字节，mkShellNoCC 只有 83,268,840 字节，相差 5.0 倍；nix-direnv 的缓存让进入目录从 10,195 ms 降到 118 ms。"
category: Tutorial
tags:
  - Nix
  - NixOS
  - Firn
  - devShell
  - direnv
  - 模板
series: "用 Firn 从零学 Nix"
seriesOrder: 13
draft: false
comment: true
slug: nix-by-firn-13-devshells-direnv-templates
---

第 12 篇里有一件事我当时没追究：交叉构建环境里明明没有 `gcc`，`gcc -dumpmachine` 却照样打印出一个架构，因为 Firn 开发 shell 里的 x86\_64 `gcc` 漏进了 `PATH`。这个 shell 是 `mkShell` 做的，而 `mkShell` 是 `stdenv.mkDerivation`，stdenv 自带编译器，你要不要都给。这一篇我把开发环境整个拆开：`nix develop` 进去之后到底有什么、为什么同样的两个包，`mkShell` 的闭包比 `mkShellNoCC` 的大 5 倍，以及怎么让“进目录就进环境”不再每次等一个多余的求值。最后一个数字先放在这里，是 `direnv exec . true` 在同一个项目里的三种耗时：

```text
$ cat out/ch13/direnv_cache.stdout
volatile: nix-direnv first call    10195 ms
volatile: nix-direnv cached (med)    118 ms
volatile: first / cached            86.4 x
volatile: plain direnv (med)         248 ms
volatile: plain / cached             2.1 x
```

> [!NOTE] 本篇检查点
> 这一篇结束时，Firn 仓库的标签 `ch13` 里：`flake.nix` 多了 56 行、删了 1 行（新增 `projectShellsFor`，`devShells` 输出从只有 `default` 变成 `c`、`default`、`python` 三个，再加 `templates` 输出）；新目录 `templates/c/`（5 个文件）和 `templates/python/`（5 个文件）；`lab/ch13/` 下有 10 个实验（9 个 `.sh` 和 1 个 `.nix`）和 10 个 fixture 文件。`git diff --name-only ch12 ch13` 一共列出 31 个文件。`README.md`、`pkgs/` 和 `overlays/` 没有变。`make ch13` 通过（10 个 `ok`）。
> 涉及的 Nix 特性：`pkgs.mkShell`、`pkgs.mkShellNoCC`、`inputsFrom`、`packages`、`shellHook`、`env` 与裸属性，`nix develop`、`nix shell`、`nix print-dev-env`，`strictDeps` 对环境变量的影响，flake 的 `templates` 输出 (`path`、`description`、`welcomeText`)，`nix flake init` 与 `nix flake new`，direnv 与 nix-direnv（`use flake`、缓存、GC root），`--override-input`，`programs.nix-ld`。
> 前置：[第 12 篇：交叉编译与静态链接：pkgsCross、pkgsStatic 与 splicing](/posts/nix-by-firn-12-cross-and-static/)。这一篇用到第 10 篇的 `firn-hello`（`inputsFrom` 借它的依赖），用到第 7 篇讲过的 `nativeBuildInputs` 与 `buildInputs` 的区别，flake 的写法见第 8 篇。
> 终稿与否：`templates/` 和 `lab/ch13/*` 在这里就是终稿；`flake.nix` 之后每章还会改。

## 环境

这一篇所有输出来自这台机器：NixOS 26.05，Linux 6.18.60，`x86_64`，上游 Nix 2.34.9，nixpkgs 钉在 `56c02bc00adcf003215cc4bd996d6efaf4cff188`。文中引用的 nixpkgs 源码都链接到这个 rev，行号我在本地那份源码上核对过；引用的 Nix 源码链接到 `2.34.9` 标签，行号是从那个标签下载的文件里数的。几个相关工具的版本：gdb 17.2，clang-tools 21.1.8，gcc 15.3.0，Python 3.14.7，ruff 0.16.3，uv 0.12.5，direnv 2.37.1，nix-direnv 3.2.0。

我的 shell 里设了 `CI=true`，Firn 的运行器会据此跳过 `_host` 实验；这一章没有 `_host` 实验，所以直接 `make ch13` 也一样，但我跑的仍是 `env -u CI make ch13`，和前几篇保持一致。我先删掉 `out/ch13`，再跑，整条命令（含 `nix develop` 的启动）花了 54.1 秒；更早两次是 82.4 秒和 71.3 秒，那时实验锁模板的 nixpkgs 用的还是 `github:` 形式的 override，后来仓库改成了离线的 `path:` 形式（模板一节会讲）。冷启动没有量。还有一件事要如实说：有一次 `mkshell_vs_nocc.sh` 卡住了超过 15 分钟，我把整条命令中断了；同一条 `nix build` 我手动跑只要 0.5 秒，重新跑 `make ch13` 也恢复正常。我没有查出那次为什么卡住，所以这个现象我只能记在这里，不能解释。

文中的命令分两类。一类在 `lab/ch13/` 里，我会给出文件路径、摘录和 `out/ch13/` 里的真实输出。另一类是我为了回答某个问题当场敲的，每一条都标着“（手敲，不在 `lab/ch13/` 里）”，输出也是真跑出来的。

## Firn 里多了什么

先看改动本身。`flake.nix` 里新增的 `projectShellsFor` 是两个 shell 的全部定义：

```nix
      # 第 13 章：C 和 Python 项目的开发环境。c 借 firn-hello 的构建依赖，
      # python 不需要 C 编译器，用 mkShellNoCC。
      projectShellsFor =
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          c = pkgs.mkShell {
            inputsFrom = [ pkgs.firn-hello ];
            packages = with pkgs; [
              gdb
              clang-tools
            ];
          };
          python = pkgs.mkShellNoCC {
            packages = with pkgs; [
              (python3.withPackages (ps: [
                ps.sqlalchemy
                ps.typer
                ps.rich
                ps.pytest
              ]))
              ruff
              uv
            ];
          };
        };
```

`c` 是一个 `mkShell`，`inputsFrom = [ pkgs.firn-hello ]` 的意思是“把 `firn-hello` 的构建依赖搬进来”（它的 `buildInputs` 是 `zlib`，`nativeBuildInputs` 是 `pkgs.pkg-config`），再用 `packages` 追加调试器 gdb 和 clang-tools（里面有 `clang-format` 和 `clangd`）。`python` 是一个 `mkShellNoCC`，因为 Python 项目不需要 C 编译器；它的 `packages` 里有一个 `python3.withPackages` 做出来的解释器环境，加上 ruff 和 uv。

这两个 shell 接进输出的那一行：

```nix
      devShells = forAllSystems (system: { default = devShells.${system}; } // projectShellsFor system);
```

`devShells.${system}` 在等号右边指向的是 `let` 里那个同名的 `devShells`（第 93 行的 `forAllSystems devShellFor`，也就是原来那个 Firn 开发 shell），不是正在定义的输出，因为输出那个属性集不是 `rec`。同一个名字在同一个文件里指两个东西，我读第一遍的时候停了一下。结果是 `devShells.x86_64-linux` 下有三个名字：

```text
$ nix eval .#devShells.x86_64-linux --apply builtins.attrNames
[ "c" "default" "python" ]
```

（手敲，不在 `lab/ch13/` 里）

`c`、`python` 和原来的 `default`。三个 shell 的 `name` 都是 `nix-shell`，这是 `mkShell` 的默认名字，`mkShell` 的源码里有它。

## mkShell：一个会被构建的派生

我开始写这一篇的时候，脑子里的 `mkShell` 是一个“拒绝被构建”的派生：它只是一个壳，里面装着 `buildInputs` 和 `shellHook`，谁敢 `nix build` 它就报错。`mkShell` 的源码在 [`pkgs/build-support/mkshell/default.nix`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/mkshell/default.nix#L7-L64)，一共 65 行。先看前半，它决定 `packages`、`inputsFrom` 和 `shellHook` 各自去了哪里：

```nix
lib.extendMkDerivation {
  constructDrv = stdenv.mkDerivation;

  excludeDrvArgNames = [
    "packages"
    "inputsFrom"
  ];

  extendDrvArgs =
    _finalAttrs:
    {
      name ? "nix-shell",
      # a list of packages to add to the shell environment
      packages ? [ ],
      # propagate all the inputs from the given derivations
      inputsFrom ? [ ],
      ...
    }@attrs:
    let
      mergeInputs =
        name:
        (attrs.${name} or [ ])
        ++
          # 1. get all `{build,nativeBuild,...}Inputs` from the elements of `inputsFrom`
          # 2. since that is a list of lists, `flatten` that into a regular list
          # 3. filter out of the result everything that's in `inputsFrom` itself
          # this leaves actual dependencies of the derivations in `inputsFrom`, but never the derivations themselves
          (lib.subtractLists inputsFrom (lib.flatten (lib.catAttrs name inputsFrom)));
    in
    {
      inherit name;

      buildInputs = mergeInputs "buildInputs";
      nativeBuildInputs = packages ++ (mergeInputs "nativeBuildInputs");
      propagatedBuildInputs = mergeInputs "propagatedBuildInputs";
      propagatedNativeBuildInputs = mergeInputs "propagatedNativeBuildInputs";

      shellHook = lib.concatStringsSep "\n" (
        lib.catAttrs "shellHook" (lib.reverseList inputsFrom ++ [ attrs ])
      );
```

四件事，行号是 `mkshell/default.nix` 里的：

- 第 8 行，`constructDrv = stdenv.mkDerivation`：`mkShell` 就是 `stdenv.mkDerivation`，只是换了一组默认值。第 10 到 13 行把 `packages` 和 `inputsFrom` 从传给 `mkDerivation` 的参数里排除，它们不是派生的属性，是 `mkShell` 自己消化掉的。
- 第 26 到 34 行，`mergeInputs`：自己写的那份列表，接上 `inputsFrom` 里每个派生的同名列表（`catAttrs` 取出来，`flatten` 压平），最后用 `lib.subtractLists inputsFrom` 把 `inputsFrom` 里的派生本身剔除。注释写得明白：留下的是“actual dependencies”，“never the derivations themselves”。
- 第 40 行，`nativeBuildInputs = packages ++ (mergeInputs "nativeBuildInputs")`：`packages` 其实就是 `nativeBuildInputs` 的前缀，没有任何特殊待遇。
- 第 44 到 46 行，`shellHook` 是 `inputsFrom` 里各个 hook 的**反序**，再接上自己的。这个顺序有一个实验 (`shellhook_order.sh`)。

后半是它的构建阶段：

```nix
      phases = attrs.phases or [ "buildPhase" ];

      buildPhase =
        attrs.buildPhase or ''
          { echo "------------------------------------------------------------";
            echo " WARNING: the existence of this path is not guaranteed.";
            echo " It is an internal implementation detail for pkgs.mkShell.";
            echo "------------------------------------------------------------";
            echo;
            # Record all build inputs as runtime dependencies
            export;
          } >> "$out"
        '';

      preferLocalBuild = attrs.preferLocalBuild or true;
      allowSubstitutes = attrs.allowSubstitutes or false;
```

`phases` 默认只有 `buildPhase`，`buildPhase` 把一段横幅和 `export` 的输出写进 `$out`。`export` 不带参数，会把当前环境里所有导出变量打印出来，其中包括 `buildInputs`、`nativeBuildInputs` 这些列表里的每一个 store 路径，于是 `$out` 通过引用扫描引用了所有输入。这个派生**会**被构建，而且构建出来的东西有用。我手敲验证一次：

```text
$ out="$(nix build --no-link --print-out-paths .#devShells.x86_64-linux.c)"
$ echo "${out}"
$ head -n 6 "${out}"
$ grep -c '^declare -x' "${out}"
$ nix path-info -r "${out}" | wc -l
/nix/store/mb353rspalwcfm5psh98ixhzbjg57cyv-nix-shell
------------------------------------------------------------
 WARNING: the existence of this path is not guaranteed.
 It is an internal implementation detail for pkgs.mkShell.
------------------------------------------------------------

declare -x AR="ar"
80
109
```

（手敲，不在 `lab/ch13/` 里）

`nix build` 成功了，`$out` 是一个 7272 字节的文本文件，开头是那条“the existence of this path is not guaranteed”的横幅，再往下是 80 行 `declare -x`；它的闭包有 109 个路径。Nixpkgs 手册的 [mkShell 一节](https://nixos.org/manual/nixpkgs/unstable/#sec-pkgs-mkShell-building)自己就是这么说的：输出是一个文本文件，引用了所有构建输入，用处是在 CI 里确认每个依赖都能构建，或者拿它当 GC root，免得依赖被垃圾回收。所以“拒绝构建”在这个 rev 上不成立，我把这个预期删了。

那么 `nix develop` 为什么说它“从不构建”这个 shell？它构建的不是这个派生。Nix 的 [`develop.cc`](https://github.com/NixOS/nix/blob/2.34.9/src/nix/develop.cc#L233-L311) 里，`getDerivationEnvironment` 先检查派生的 builder 必须是 `bash`（第 238 行），然后**改写**这个派生：第 252 行 `drv.args = {store->printStorePath(getEnvShPath)}`，把构建脚本换成 Nix 自带的 [`get-env.sh`](https://github.com/NixOS/nix/blob/2.34.9/src/nix/get-env.sh#L11)；第 258 行起删掉 `allowedReferences` 之类的输出检查；第 268 行给名字加 `-env` 后缀；输入原样保留。然后构建这个改写过的派生。`get-env.sh` 的第 11 行是：

```bash
    source "$stdenv"/setup
```

它先 `source "$stdenv"/setup`，也就是 stdenv 的那份 `setup.sh`（第 7 篇我们读过 Firn 的 63 行版本，nixpkgs 的是 1839 行），让所有依赖的 setup hook、环境变量和 `PATH` 都按构建时的方式布置好，然后把整个环境导出成 JSON 写到 `$out`。`nix develop` 读这份 JSON，生成一个 bash 脚本，再 `exec` 一个 bash 去执行它。所以 mkShell 自己的 `buildPhase` 在 `nix develop` 里一次也没有跑过。

一个不太严谨的比喻，我只用这一次：mkShell 的输出像一张订在空箱子上的装箱单。`nix develop` 读的是单子（输入列表和 hook），不是箱子；`nix build` 才会真的把箱子做出来，箱子里装的就是单子的复印件。

`fixtures/refuses.nix` 把这件事做成了可以证明的东西。它不是 `mkShell`，是一个手写的、真的拒绝被构建的派生，整个文件：

```nix
# 一个拒绝被构建的派生：buildPhase 直接失败。`nix build` 因此失败，但
# `nix develop -f` 只构建它的输入，从不运行它，所以照样能进入环境。
# 这就是 mkShell 的做法：派生只是用来承载 buildInputs 和 shellHook 的壳。
let
  pkgs = import ../../../nix/pkgs.nix { };
in
pkgs.stdenv.mkDerivation {
  name = "refuses-to-build";
  phases = [ "buildPhase" ];
  nativeBuildInputs = [ pkgs.hello ];
  buildPhase = ''
    echo "this derivation is not meant to be built" >&2
    false
  '';
  shellHook = ''
    echo "shellHook ran, hello is $(command -v hello)"
  '';
}
```

`mkshell_env.sh` 的第三段对它做了两件事。函数本体：

```bash
show_refusal() {
  local status=0
  echo
  echo "== a derivation that refuses to build"
  nix build --no-link --file "${REFUSES}" 2>&1 \
    | grep 'not meant' | strip_hash || true
  nix build --no-link --file "${REFUSES}" >/dev/null 2>&1 || status=$?
  echo "nix build exit: ${status}"
  # shellcheck disable=SC2016  # the probe is code for the child shell
  nix develop --file "${REFUSES}" \
    --command bash -c 'echo "nix develop works, IN_NIX_SHELL=${IN_NIX_SHELL}"' \
    2>/dev/null | strip_hash
}
```

输出（`mkshell_env.stdout` 的最后五行）：

```text
$ tail -n 5 out/ch13/mkshell_env.stdout
== a derivation that refuses to build
       > this derivation is not meant to be built
nix build exit: 1
shellHook ran, hello is hello-2.12.3/bin/hello
nix develop works, IN_NIX_SHELL=impure
```

`buildPhase` 里的 `false` 让 `nix build` 退出码是 1，错误信息 `this derivation is not meant to be built` 是它自己 `echo` 的；同一个 `refuses.nix`，`nix develop --file ... --command` 照样进去了，`shellHook` 也跑了（它在 PATH 里找到了 `hello`，因为 `hello` 在 `nativeBuildInputs` 里），`IN_NIX_SHELL` 是 `impure`，这个值是 `get-env.sh` 第 6 行 `export IN_NIX_SHELL=impure` 设的，不是 mkShell 设的。拒绝构建的派生仍然能当开发环境，因为 `nix develop` 要的只是它的输入。

## 进去之后能看到什么

`mkshell_env.sh` 的前两段是对 c shell 的盘点。第一段用 `nix print-dev-env --json` 读变量，第二段用 `env -i` 启动一个干净环境，数子进程看到的变量：

```text
$ head -n 24 out/ch13/mkshell_env.stdout
== variables of the c shell (print-dev-env --json)
volatile: variables 123
volatile: functions 99
volatile: array 21
volatile: exported 77
volatile: var 25

== buildInputs and NIX_CFLAGS_COMPILE in the c shell
buildInputs:
zlib-1.3.2-dev
NIX_CFLAGS_COMPILE (flags, hashes stripped):
      2 gdb-17.2/include
      2 zlib-1.3.2-dev/include
FIRN_GREETING flags: 0
nativeBuildInputs (first 8, hashes stripped):
gdb-17.2
clang-tools-21.1.8
pkg-config-wrapper-0.29.2

== env vars seen by a child process under env -i
volatile: default  92
volatile: c        84
volatile: python   63

```

逐段读。`nix print-dev-env --json` 报告 123 个变量、99 个 bash 函数，其中 77 个是导出的 (`exported`)，21 个数组，25 个普通变量 (`var`)；这些是 `get-env.sh` 看见的整个 stdenv 环境，没有一个是我写的。`env -i` 之后，子进程真正看到的环境变量是：Firn 原来的 `default` shell 92 个，`c` 84 个，`python` 63 个。两个数不能直接相减：77 个导出变量和 84 个子进程变量之间，大概差在 `nix develop` 自己丢掉一批（`develop.cc` 的 [`ignoreVars`](https://github.com/NixOS/nix/blob/2.34.9/src/nix/develop.cc#L315-L331) 列了 `HOME`、`TERM`、`TMP` 之类 16 个）、又补上几个（`makeRcScript` 会设 `NIX_BUILD_TOP` 和 `TMP` 一族，`SHELL` 由 `nix develop` 另外设，见 `develop.cc` 第 679 和 682 行）。我没有逐个对账，不给差值。

`buildInputs` 里只有一个 `zlib-1.3.2-dev`，来自 `inputsFrom`；`nativeBuildInputs` 的顺序是 `gdb`、`clang-tools`、`pkg-config-wrapper`：`packages` 在前，借来的在后，正好是 `mkShell` 源码第 40 行 `packages ++ ...` 的顺序。

这里有两处和 `firn-hello` 自己的包定义不同，值得一问。

**第一，`-DFIRN_GREETING` 没有来。** `firn-hello` 的 `package.nix` 里有 `env.NIX_CFLAGS_COMPILE = "-DFIRN_GREETING=\"${greeting}\""`。`inputsFrom` 只搬 `buildInputs` 这几类依赖列表，不搬别的属性，所以 shell 里的 `NIX_CFLAGS_COMPILE` 没有这一项：`FIRN_GREETING flags: 0`。`inputs_from.nix` 从求值层面证明同一件事，下一节读。

**第二，`-isystem` 每个路径出现了两次。** `NIX_CFLAGS_COMPILE` 里 gdb 和 zlib 的 `include` 目录各两个。`gdb` 是编译器不需要的工具，却因为目录里恰好有 `include/` 被塞进了头文件搜索路径。这是 stdenv 在“没设 `strictDeps`”时的行为，我手敲验证：同一个 shell，加 `strictDeps = true`，再数 `-isystem`。先把计数的那段写成一个函数：

```bash
cflags() {
  jq -r .variables.NIX_CFLAGS_COMPILE.value \
    | grep -o -e '-isystem [^ ]*' \
    | sed -E 's|/nix/store/[a-z0-9]{32}-||' | sort | uniq -c
}
```

```text
$ nix print-dev-env --json .#devShells.x86_64-linux.c | cflags
      2 -isystem gdb-17.2/include
      2 -isystem zlib-1.3.2-dev/include
$ nix print-dev-env --json --impure --expr '
  let
    pkgs = import ./nix/pkgs.nix { };
  in
  pkgs.mkShell {
    strictDeps = true;
    inputsFrom = [ pkgs.firn-hello ];
    packages = [ pkgs.gdb pkgs.clang-tools ];
  }
' | cflags
      1 -isystem zlib-1.3.2-dev/include
```

（手敲，不在 `lab/ch13/` 里）

两条命令的 stderr 我都丢掉了，第二条会多打一行 `building ... nix-shell-env.drv`。加了 `strictDeps = true`，gdb 的 `-isystem` 消失了，zlib 的从两个变成一个。机制在 stdenv 的 `setup.sh` 里：[`_addToEnv`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L901-L944) 在没有 `strictDeps` 时（第 911 行）把**所有**依赖交给每一个已注册的 env hook（第 931 行），不管它是构建期工具还是目标库；有 `strictDeps` 时（第 938 行）只按各自的偏移量交给对应的 hook。cc-wrapper 的 hook 是 [`ccWrapper_addCVars`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/cc-wrapper/setup-hook.sh#L66-L95)，它给每个带 `include/` 的目录追加 `-isystem`。为什么是两份而不是一份，我的猜测是 cc-wrapper 这个包在环境里被激活了两次，每次激活都会 `addEnvHooks` 注册一遍 hook；`strictDeps` 设了之后，setup hook 第 61 行的守卫 `[[ -z ${strictDeps-} ]] || (( "$hostOffset" < 0 )) || return 0` 会让偏移量不小于 0 的那一次直接 `return`，只剩一份。这个守卫的上一行注释是 `TODO(@Ericson2314): No native exception`，也就是说“没设 `strictDeps` 时原生编译全放行”是 nixpkgs 自己标着要去掉的例外。这条因果链我没有用调试输出验证，只有结果（1 对 2）是实测的。

这个结果对 Firn 的 `c` shell 意味着什么：它是 `mkShell { ... }` 没设 `strictDeps`，所以 gdb 的头文件目录会出现在编译命令里。多半无害（gdb 的 `include/` 里的头文件大概不会和你的程序重名），但它说明了 `inputsFrom = [ firn-hello ]` 不会把 `firn-hello` 的 `strictDeps = true` 一起搬来，shell 的 `strictDeps` 要自己设。`strictDeps` 的作用，就是把“构建期工具”和“目标库”分开对待。

## nix print-dev-env：一个能 source 的脚本

`nix develop` 做的事可以拆成两步：造出环境，再进去。`nix print-dev-env` 只做第一步，把环境打印成一个 bash 脚本，谁都可以 `source`。`print_dev_env.sh` 对 c shell 做了这件事，然后只看脚本里有什么。核心几行：

```bash
  local script="${LAB_TMP}/dev-env.sh"
  nix print-dev-env "${SHELL_ATTR}" >"${script}" 2>/dev/null

  printf 'volatile: lines %d\n' "$(wc -l <"${script}")"
  echo "first line: $(head -n 1 "${script}")"
  echo "last line:  $(grep -v '^$' "${script}" | tail -n 1)"
```

输出：

```text
$ cat out/ch13/print_dev_env.stdout
volatile: lines 2161
first line: unset shellHook
last line:  eval "${shellHook:-}"
volatile: declared functions 99
== phase functions
buildPhase
checkPhase
configurePhase
distPhase
fixupPhase
installCheckPhase
installPhase
patchPhase
runPhase
unpackPhase
updateAutotoolsGnuConfigScriptsPhase
== other well-known functions
genericBuild
patchShebangs
runHook
runPhase
stripHash
substituteInPlace
== the line that sources setup
12:    source "$stdenv"/setup
```

2161 行，一个 shell 脚本。第一行是 `unset shellHook`，最后一行是 `eval "${shellHook:-}"`，正好是 `develop.cc` 里 `makeRcScript` 的第 364 行 (`out << "unset shellHook\n"`) 和第 380 行 (`out << "eval \"${shellHook:-}\"\n"`)：先清掉可能从外面继承来的 `shellHook`，把所有变量和函数写进去，最后求值 hook。中间的 2000 多行是变量赋值和 99 个函数，`declare -F` 数出来的函数数量和 `mkshell_env.sh` 的 JSON 里的 `functions 99` 一致。stdenv 的 `setup.sh` 是整个被内联进来的，所以 `buildPhase`、`configurePhase`、`installPhase` 这些阶段函数，以及 `genericBuild`、`patchShebangs`、`substituteInPlace`，在 `nix develop` 的 shell 里都能直接调用：在一个 C 项目里敲 `configurePhase` 和 `buildPhase`，就是在重放 `nix build` 会做的事（我没有在这篇里演示，只验证了函数在）。

最后一段输出回答“`nix develop` sources `$stdenv/setup`”这件事的证据：`12:    source "$stdenv"/setup`。这一行在 Nix 存进 store 的那份 `get-env.sh` 里是第 12 行，在 `2.34.9` 标签的[源文件](https://github.com/NixOS/nix/blob/2.34.9/src/nix/get-env.sh#L11)里是第 11 行。差一行是因为我拿两份都看过：store 里那份开头多一个空行（我猜是内嵌进二进制时加的，没有去查）。实验靠的是 `print-dev-env -vvv` 打出来的 `nix-shell-env.drv`，再用 `nix derivation show` 读它的 `args[0]`，找到的就是这份被换掉的构建脚本。

`print-dev-env` 的两个实际用法：在一个没有 `nix develop` 的地方（CI 脚本、一个已经开着的 shell）`source <(nix print-dev-env .#c)`；以及，direnv 靠的就是它，“direnv 和 nix-direnv”一节会读到 `nix-direnv` 的 `use_flake` 调的就是 `nix print-dev-env --profile`。

## inputsFrom：借依赖，不借包

`inputs_from.nix` 只求值，不构建，整个文件 28 行：

```nix
# inputsFrom 只取别的派生的各类 inputs 列表，不取派生本身：
# firn-hello 的 buildInputs、nativeBuildInputs 进了 shell，firn-hello 没有进。
# packages 追加在 nativeBuildInputs 的最前面。只求值，不构建。
let
  pkgs = import ../../nix/pkgs.nix { };
  inherit (pkgs) lib;
  names = map (drv: drv.name);
  shell = pkgs.mkShell {
    inputsFrom = [ pkgs.firn-hello ];
    packages = [ pkgs.gdb ];
  };
in
{
  firnHello = {
    buildInputs = names pkgs.firn-hello.buildInputs;
    nativeBuildInputs = names pkgs.firn-hello.nativeBuildInputs;
  };
  shell = {
    buildInputs = names shell.buildInputs;
    nativeBuildInputs = names shell.nativeBuildInputs;
    propagatedBuildInputs = names shell.propagatedBuildInputs;
  };
  firnHelloItselfInShell = lib.any (drv: drv == pkgs.firn-hello) (
    shell.buildInputs ++ shell.nativeBuildInputs
  );
  # firn-hello 的 env.NIX_CFLAGS_COMPILE 不属于 inputs，不会带进 shell。
  shellHasGreetingFlag = shell ? env && shell.env ? NIX_CFLAGS_COMPILE;
}
```

输出：

```text
$ cat out/ch13/inputs_from.stdout
{ firnHello = { buildInputs = [ "zlib-1.3.2" ]; nativeBuildInputs = [ "pkg-config-wrapper-0.29.2" ]; }; firnHelloItselfInShell = false; shell = { buildInputs = [ "zlib-1.3.2" ]; nativeBuildInputs = [ "gdb-17.2" "pkg-config-wrapper-0.29.2" ]; propagatedBuildInputs = [ ]; }; shellHasGreetingFlag = false; }
```

排成可读的样子：`firn-hello` 自己的 `buildInputs` 是 `zlib-1.3.2`，`nativeBuildInputs` 是 `pkg-config-wrapper-0.29.2`；shell 的 `buildInputs` 同样是 `zlib-1.3.2`，`nativeBuildInputs` 是 `gdb-17.2` 加上 `pkg-config-wrapper-0.29.2`（`packages` 在前），`propagatedBuildInputs` 是空；`firnHelloItselfInShell = false`，也就是 `firn-hello` 本身没有进 shell；`shellHasGreetingFlag = false`，`env.NIX_CFLAGS_COMPILE` 同样没有进。这和 `mkShell` 源码第 30 到 34 行的注释一致：只搬依赖，不搬派生，也不搬派生的其他属性。

有一个小地方对不上：这里 zlib 叫 `zlib-1.3.2`，`mkshell_env.sh` 里 `print-dev-env` 的 `buildInputs` 里叫 `zlib-1.3.2-dev`。差别来自 `mkDerivation`：它在把依赖列表交给构建环境之前，对每一个都套一层 `getDev`（[`make-derivation.nix` 第 563 行和第 582 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L582)分别处理 `nativeBuildInputs` 和 `buildInputs`），有 `dev` 输出的就换成 `dev`。`drv.name` 读到的是换之前的名字。这是为什么 `-isystem` 里是 `zlib-1.3.2-dev/include`：头文件在 `dev` 输出里，`out` 里没有 `include/`。

`lib.subtractLists inputsFrom` 那一步我没有单独做实验。源码注释只说这一步保证留下的是依赖，“never the derivations themselves”；什么情况下依赖列表里会混进派生本身，我没有构造出例子。

## shellHook：顺序和时机

`inputsFrom` 搬的不只是依赖，`shellHook` 也搬（第 44 到 46 行）。顺序是反的。`fixtures/hooks.nix` 的整个文件：

```nix
# 三个带 shellHook 的 shell；combined 用 inputsFrom 把 a、b 合并进来。
let
  pkgs = import ../../../nix/pkgs.nix { };
in
rec {
  a = pkgs.mkShellNoCC { shellHook = ''echo "hook: a"''; };
  b = pkgs.mkShellNoCC { shellHook = ''echo "hook: b"''; };
  combined = pkgs.mkShellNoCC {
    inputsFrom = [
      a
      b
    ];
    shellHook = ''echo "hook: combined (own)"'';
  };
}
```

`combined` 的 `inputsFrom = [ a b ]`。`shellhook_order.sh` 做三件事：进入 `combined` 并带一个 `--command`，打印合并后的 `shellHook` 属性，看 `print-dev-env` 的最后一行：

```text
$ cat out/ch13/shellhook_order.stdout
== nix develop combined --command echo command
hook: b
hook: a
hook: combined (own)
command: runs after the hooks

== the merged shellHook attribute
echo "hook: b"
echo "hook: a"
echo "hook: combined (own)"

== end of print-dev-env
eval "${shellHook:-}"
```

顺序是 `b`、`a`，然后是 `combined` 自己的，最后才是 `--command` 的输出。`inputsFrom = [ a b ]` 的 hook 按 `lib.reverseList` 倒着排（源码第 45 行），这个顺序在 `shellHook` 属性里是肉眼可见的三行 `echo`，被 `"\n"` 连起来。为什么要倒着排，我在源码和手册里都没有找到说法，只有“倒着排”这个事实。写 hook 的人要知道的是：`inputsFrom` 里的书写顺序，不是 hook 的执行顺序。

`--command` 在 hook 之后跑，是因为 hook 在 rc 脚本里被 `eval` 掉（`develop.cc` 第 380 行），而 [第 615 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/develop.cc#L615)才把 `exec <命令>` 追加到脚本末尾；`--phase` 走的是第 607 行，追加的是 `runHook <阶段>Phase`，所以 `nix develop --phase build` 会在 shell 里把 `buildPhase` 跑一遍（这一条我没有跑，是读代码的结论）。Firn 自己的 `default` shell 用 `shellHook` 做了三件事：导出 `FIRN_DEVSHELL`，导出 `FIRN_NIX_DIRENV`，打印一行版本横幅。第二件是我在 direnv 实验里要用的：

```nix
          shellHook = ''
            export FIRN_DEVSHELL=1
            export FIRN_NIX_DIRENV="${pkgs.nix-direnv}/share/nix-direnv/direnvrc"
            echo "firn dev shell: $(nix --version), nixfmt $(nixfmt --version), statix ${pkgs.statix.version}, $(deadnix --version)"
          '';
```

`FIRN_NIX_DIRENV` 是 nix-direnv 的 `direnvrc` 在 store 里的路径，`direnv_cache.sh` 靠它让 direnv 加载 nix-direnv。注意 hook 里的 `${pkgs.nix-direnv}` 是 Nix 的插值，在求值时就变成了 store 路径；`$(nix --version)` 没有被插值，留给 bash 在进入 shell 时执行。这是 `''...''` 字符串里两种 `$` 的区别。

## env 属性：给 shell 加变量的三种写法

`shellHook` 里 `export` 是一种；另外两种是直接在 `mkShell` 的参数里写属性。我手敲对比：

```text
$ nix develop --impure --expr '
  let
    pkgs = import ./nix/pkgs.nix { };
  in
  pkgs.mkShellNoCC {
    GREETING = "from attribute";
    env.FROM_ENV = "from env";
    count = 3;
    flag = true;
    list = [ "a" "b" ];
    shellHook = '"''"'
      echo "GREETING=$GREETING FROM_ENV=$FROM_ENV count=$count flag=[$flag] list=[$list]"
    '"''"';
  }
' --command true 2>/dev/null
GREETING=from attribute FROM_ENV=from env count=3 flag=[1] list=[a b]
```

（手敲，不在 `lab/ch13/` 里）

`--impure` 是因为 `--expr` 里有相对路径 `./nix/pkgs.nix`；`'"''"'` 是在单引号字符串里写出 Nix 的 `''`，纯粹是转义，不是 Nix 语法。裸属性 (`GREETING`) 和 `env.` 下的属性 (`FROM_ENV`) 都变成了 shell 里的环境变量，整数 `3` 变成 `3`，布尔 `true` 变成 `1`，列表变成空格连接的字符串 `a b`。这是 `mkDerivation` 对所有属性的统一处理，开发 shell 只是顺便继承了它。想要一个传给 shell 的常量，直接写属性；想要在进入时计算的值，写 `shellHook`；想要跟某个依赖路径绑定的值，用 `shellHook` 里的 `${pkgs.x}` 插值，如 Cairn 的 `CAIRN_BUSYBOX`（Sift 一节读它）。

## mkShellNoCC：少了 316.5 MiB

`python` shell 用的是 `mkShellNoCC`，它在 nixpkgs 里只有一行，[`all-packages.nix` 的第 759 到 760 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/all-packages.nix#L759-L760)：

```nix
  mkShell = callPackage ../build-support/mkshell { };
  mkShellNoCC = mkShell.override { stdenv = stdenvNoCC; };
```

`mkShellNoCC` 就是把 `mkShell` 的 `stdenv` 换成 `stdenvNoCC`，一个没有 C 编译器的 stdenv。区别大到什么程度，`mkshell_vs_nocc.sh` 用同一份 `packages`（`hello` 和 `jq`，两个都不需要编译器）做了对比。fixture 是：

```nix
# 同样的 packages，一个用 mkShell，一个用 mkShellNoCC。
let
  pkgs = import ../../../nix/pkgs.nix { };
  packages = with pkgs; [
    hello
    jq
  ];
in
{
  withCc = pkgs.mkShell { inherit packages; };
  noCc = pkgs.mkShellNoCC { inherit packages; };
}
```

脚本分别构建 `withCc` 和 `noCc`，量它们输出的闭包大小和路径数，然后用 `comm` 找出只在其中一个闭包里的路径：

```text
$ cat out/ch13/mkshell_vs_nocc.stdout
shell           closure  paths
volatile: withCc        415167120     65
volatile: noCc           83268840     52

== paths only in the mkShell closure
binutils-2.46
binutils-2.46-lib
binutils-wrapper-2.46
expand-response-params
gcc-15.3.0
gcc-wrapper-15.3.0
glibc-2.42-67-bin
glibc-2.42-67-dev
gmp-6.3.0
isl-0.20
libmpc-1.4.1
linux-headers-7.1
mpfr-4.2.2
stdenv-linux
== paths only in the mkShellNoCC closure
stdenv-linux-no-cc
```

`mkShell` 的闭包是 415,167,120 字节（65 个路径），`mkShellNoCC` 是 83,268,840 字节（52 个路径）：5.0 倍，差 331,898,280 字节，316.5 MiB。多出来的 13 个路径（`mkShell` 独有 14 个，`mkShellNoCC` 独有 1 个 `stdenv-linux-no-cc`）是整套编译器：`gcc` 和 `gcc-wrapper`，`binutils`（连同它的 `lib` 和 wrapper），`glibc` 的 `bin` 和 `dev` 输出，`linux-headers`，加上 `gmp`、`mpfr`、`libmpc`、`isl`、`expand-response-params`，再加 `stdenv-linux` 本身。哪一个最大？手敲量一下：

```text
$ cc_out="$(nix build --no-link --print-out-paths --file lab/ch13/fixtures/shells.nix withCc)"
$ nix path-info -r -s "${cc_out}" | sed -E 's|/nix/store/[a-z0-9]{32}-||' \
    | sort -k2 -n -r | head -n 4
gcc-15.3.0                              	  277242232
glibc-2.42-67                           	   35073096
binutils-2.46                           	   34164200
file-5.48                               	   11036360
```

（手敲，不在 `lab/ch13/` 里）

`path-info -s` 给的是 NAR 大小。`gcc-15.3.0` 一个就是 277,242,232 字节，占 `mkShell` 闭包的 66.8%，占两者差值的 83.5%。`glibc` 和 `binutils` 各 35 MB 和 34 MB。第 4 行的 `file-5.48` 是 stdenv 的 `initialPath` 带进来的，[`common-path.nix` 第 17 到 23 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/common-path.nix#L17-L23)的注释解释了原因：大量包的 `./configure` 里藏着对 `file` 的依赖。它同时在两个闭包里，所以不在差值里。

第 12 篇里那个“漏进来的 gcc”就是从这里来的：Firn 的 `default` shell 是 `mkShell`，所以 `gcc` 在 `PATH` 里。三个 shell 的实际大小，我手敲量一遍：

```text
$ for n in default c python; do
>   p="$(nix build --no-link --print-out-paths ".#devShells.x86_64-linux.${n}")"
>   printf '%-8s %s\n' "${n}" "$(nix path-info -S "${p}" | awk '{ print $2 }') $(nix path-info -r "${p}" | wc -l)"
> done
default  1458270248 281
c        2268745744 109
python   420640240 83
```

（手敲，不在 `lab/ch13/` 里）

每行是名字、闭包字节数、路径数。`python`（`mkShellNoCC`，Python 加 ruff 加 uv）是 420,640,240 字节、83 个路径，`default`（`mkShell`，34 个工具）是 1,458,270,248 字节、281 个，`c`（`mkShell`，gdb 加 clang-tools）是 2,268,745,744 字节、109 个。`c` 的路径数比 `default` 少得多（109 对 281），体积却最大：路径少是因为 `firn-hello` 只借来 `zlib` 和 `pkg-config`，体积大是因为 clang-tools 带着 `clang-21.1.8-lib`（852,470,608 字节）和 `llvm-21.1.8-lib`（566,455,640 字节）。这两个数我是从 `path-info` 里读的，没有追究 clang-tools 为什么需要整份 LLVM。（给 8 行的 `main.c` 配 2.27 GB 的 shell，有点过分。）

选哪一个，我现在的规则是：要编译 C、C++ 或带原生扩展的东西，用 `mkShell`；只是跑解释器和工具，用 `mkShellNoCC`。Python 那边有一个后果要想清楚：`mkShellNoCC` 的 shell 里没有 `cc`，如果一个依赖没有预编译的 wheel，`uv pip install` 需要从源码编译，就会因为找不到编译器失败。我没有构造这个失败来验证，这是从 shell 里没有 `cc` 这一点推出来的。

## nix develop 和 nix shell

两个命令都是“进入一个环境”，进去之后能做的事不一样。同一个 flake 里，进 `c` shell 和用 `nix shell` 取 `firn-hello` 这个包，得到的东西不同：

```text
$ P="$(dirname "$(command -v nix)"):$(dirname "$(command -v bash)"):/run/current-system/sw/bin"
$ env -i HOME="${HOME}" PATH="${P}" nix develop .#c --command bash -c \
    'command -v cc; echo "${IN_NIX_SHELL-unset}"; env | wc -l'
/nix/store/3d1c302vw7kc8a5vknhmn34c0pd7zm6m-gcc-wrapper-15.3.0/bin/cc
impure
84
$ env -i HOME="${HOME}" PATH="${P}" nix shell .#firn-hello --command bash -c \
    'command -v cc; echo "${IN_NIX_SHELL-unset}"; env | wc -l'
unset
5
```

（手敲，不在 `lab/ch13/` 里）

`P` 只是让 `env -i` 之后还能找到 `nix`、`bash` 和 `env`。`nix develop` 里 `cc` 是 `gcc-wrapper-15.3.0/bin/cc`，`IN_NIX_SHELL` 是 `impure`，环境变量 84 个，和 `mkshell_env.sh` 里数的 `c 84` 一致。`nix shell` 里没有 `cc`（`command -v cc` 什么也没打印），`IN_NIX_SHELL` 没设，环境变量只有 5 个。第 9 篇我量过同样的两个数字，另一个 shell 里是 46 和 5，`nix shell` 这一侧的 5 没有变。

区别就是 `develop.cc` 和 `setup.sh` 那套机制。`nix shell` 把包的 `bin/` 加进 `PATH`，别的什么也不做，不 `source` `setup`，不跑 hook，不关心包是怎么构建的；它适合“我想用这个程序”。`nix develop` 要的是构建这个东西的环境：stdenv 的 `setup`、编译器包装器、`NIX_CFLAGS_COMPILE`、`pkg-config` 的搜索路径，它适合“我想改这个程序”。两个命令在手册里各有一页：[`nix develop`](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-develop.html)、[`nix shell`](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-env-shell.html)，`nix print-dev-env` 的页面[在这里](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-print-dev-env.html)。

还有一个机制上的差别，在 `develop.cc` 里：[第 633 到 634 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/develop.cc#L633-L634)，`// prevent garbage collection until shell exits`，然后 `setEnv("NIX_GCROOT", ...)`。注释的意思是 shell 活着的时候环境不会被回收。我猜 shell 一退出，这个保护就没了，下次进去之前如果跑过垃圾回收，就得重新构建；这条我没有验证。nix-direnv 要补的正是这个洞，只是它补的方式是留下一个磁盘上的 GC root，不是一个环境变量。

## direnv 和 nix-direnv：进目录就进环境

每次开发都先敲 `nix develop` 有两个问题：我会忘，而且它每次都要求值一遍 flake。[direnv](https://direnv.net/) 解决第一个：它是 shell 的一个 hook，进入目录时读 `.envrc`，把里面的环境变化应用到当前 shell，离开时撤销。Firn 的根目录和两个模板里的 `.envrc` 都只有一行：

```text
$ cat templates/c/.envrc
use flake
```

`use flake` 是 direnv 标准库里的一个函数。[direnv 2.37.1 的 `stdlib.sh` 第 1326 到 1332 行](https://github.com/direnv/direnv/blob/v2.37.1/stdlib.sh#L1326-L1332)是这样的：

```bash
use_flake() {
  watch_file flake.nix
  watch_file flake.lock
  mkdir -p "$(direnv_layout_dir)"
  eval "$(nix --extra-experimental-features "nix-command flakes" print-dev-env --profile "$(direnv_layout_dir)/flake-profile" "$@")"
  nix --extra-experimental-features "nix-command flakes" profile wipe-history --profile "$(direnv_layout_dir)/flake-profile"
}
```

它监视 `flake.nix` 和 `flake.lock`，每次 `.envrc` 被重新求值，就跑一遍 `nix print-dev-env`，把输出 `eval` 掉。`print_dev_env.sh` 那一节读过 `print-dev-env` 打印什么，所以每次进目录都要走一遍“求值 flake、构建（或查缓存）`-env` 派生、生成 2161 行脚本、`eval`”。第二个问题就在这里。

[nix-direnv](https://github.com/nix-community/nix-direnv) 重新定义了 `use_flake`。装法是让 direnv 的配置加载它的 `direnvrc`：Firn 的开发 shell 里已经有 `nix-direnv`，`shellHook` 把它的路径导出成 `FIRN_NIX_DIRENV`（`flake.nix` 第 89 行，`shellHook` 一节读过）。`direnv_cache.sh` 用这个变量做实验，实验用的项目由 `fixtures/direnv_project.sh` 搭：

```bash
direnv_project::setup() {
  local mode="$1"
  export XDG_CONFIG_HOME="${LAB_TMP}/xdg/config"
  export XDG_DATA_HOME="${LAB_TMP}/xdg/data"
  export XDG_CACHE_HOME="${LAB_TMP}/xdg/cache"
  mkdir -p "${XDG_CONFIG_HOME}/direnv" "${XDG_DATA_HOME}" "${XDG_CACHE_HOME}"
  if [[ "${mode}" == with ]]; then
    printf 'source "%s"\n' "${FIRN_NIX_DIRENV}" \
      >"${XDG_CONFIG_HOME}/direnv/direnvrc"
  fi

  mkdir -p "${LAB_TMP}/proj"
  cd "${LAB_TMP}/proj" || return 1
  nix flake init -t "${FIRN_ROOT}#c" >/dev/null 2>&1
  git init -q
  git add -A
  pin_nixpkgs::lock
  git add -A
  printf 'use flake\n' >.envrc
  # 外层 shell 如果也在用 direnv，这些变量会让 direnv 以为已经加载过。
  unset "${!DIRENV_@}"
  direnv allow . 2>/dev/null
}
```

三件事值得读。第一，`XDG_CONFIG_HOME`、`XDG_DATA_HOME` 和 `XDG_CACHE_HOME` 全指向 `LAB_TMP`：direnv 的配置、允许列表和缓存都在那里，`direnv allow` 不会碰我真正的 allow 列表。第二，`with` 模式写一个只有一行的 `direnvrc`，`source` 到 nix-direnv，`without` 模式则是空配置，用 direnv 自带的 `use flake`。第三，`direnv allow` 之前那行 `unset "${!DIRENV_@}"`，它前一行的注释说，外层 shell 如果也在用 direnv，这些变量会让 direnv 以为已经加载过。这是脚本注释给的理由，我没有把这一行去掉再跑一遍。锁 nixpkgs 的 `pin_nixpkgs::lock` 在模板一节讲。

计时用 `EPOCHREALTIME` 的差，毫秒：

```bash
time_ms() {
  local start end
  start="${EPOCHREALTIME/./}"
  direnv exec . true >/dev/null 2>&1
  end="${EPOCHREALTIME/./}"
  echo $(((end - start) / 1000))
}
```

```bash
median5() {
  local _
  for _ in 1 2 3 4 5; do
    time_ms
  done | sort -n | sed -n 3p
}
```

`main` 先用 nix-direnv 测一次首次调用（什么缓存都没有），再测 5 次缓存命中的中位数；然后删掉项目，用空配置（direnv 自带的 `use flake`）重建，先预热一次，再测 5 次的中位数：

```bash
main() {
  local first cached plain
  direnv_project::setup with
  first="$(time_ms)"
  cached="$(median5)"
  printf 'volatile: nix-direnv first call   %6d ms\n' "${first}"
  printf 'volatile: nix-direnv cached (med) %6d ms\n' "${cached}"
  awk -v a="${first}" -v b="${cached}" \
    'BEGIN { printf "volatile: first / cached          %6.1f x\n", a / b }'

  rm -rf "${LAB_TMP}/proj" "${LAB_TMP}/xdg"
  direnv_project::setup without
  direnv exec . true >/dev/null 2>&1
  plain="$(median5)"
  printf 'volatile: plain direnv (med)      %6d ms\n' "${plain}"
  awk -v a="${plain}" -v b="${cached}" \
    'BEGIN { printf "volatile: plain / cached          %6.1f x\n", a / b }'

  rm -rf "${LAB_TMP}/proj"
  nix-store --gc --print-roots >/dev/null 2>&1
}
```

输出是这一篇开头那几行，现在逐行读：

```text
$ cat out/ch13/direnv_cache.stdout
volatile: nix-direnv first call    10195 ms
volatile: nix-direnv cached (med)    118 ms
volatile: first / cached            86.4 x
volatile: plain direnv (med)         248 ms
volatile: plain / cached             2.1 x
```

首次调用 10,195 ms；缓存命中的中位数 118 ms，快 86.4 倍；direnv 自带的 `use flake` 中位数 248 ms，是缓存命中的 2.1 倍。这个实验的数字抖得厉害，我之后单独又跑了 5 次：首次调用 5,060 到 10,238 ms，缓存命中 95 到 237 ms，自带 210 到 248 ms；有一次缓存命中和自带几乎一样（235 对 228 ms）。机器上当时有别的负载（load average 2 到 3），我没有隔离。请记住量级，不要记住单个数字：缓存命中约为自带的 0.4 到 1 倍。这个仓库改用 `path:` 锁之前我没有保存过首次调用的数字，所以没法说变快还是变慢；首次调用为什么要 5 到 10 秒，我没有去查，猜测和把整份 nixpkgs 源码当 `path:` 输入处理有关，这只是猜测。这些数是在 Nix 的求值缓存已经热了的机器上量的：自带的 248 ms 里没有冷求值（第 8 篇量过 eval cache 冷热的差别），所以它只是下限。118 ms 里有什么，我没有 profile：direnv 自己的启动、nix-direnv 的预检、`eval` 一个 2161 行的脚本都在里面。

nix-direnv 为什么能跳过求值，要读它的 `use_flake`。以下行号是 [nix-direnv 3.2.0 `direnvrc`](https://github.com/nix-community/nix-direnv/blob/3.2.0/direnvrc#L294) 里的（我先读的是 store 里的那份，它把 `rm`、`mkdir` 换成了绝对路径，行号和标签里的文件略有不同；这里所有引用和行号都取自标签里的文件）。缓存是否有效，看两件事。一是 `profile` 和 `profile_rc` 这两个文件在不在（第 332 到 342 行）；二是被监视的文件有没有比缓存新：

```bash
  local file=
  local newer_files=()
  for file in "${watches[@]}"; do
    if [[ $file -nt $profile_rc ]]; then
      newer_files+=("$file")
    fi
  done
```

`watches` 是 direnv 已经在监视的文件（`use_flake` 开头 `watch_file` 加进去的 `flake.nix`、`flake.lock` 和 `devshell.toml`，第 321 行），任何一个比缓存文件 `profile_rc` 新，缓存就失效。缓存失效了才重新跑 `nix print-dev-env`，并且把输出存起来：

```bash
      local tmp_profile_rc
      local tmp_profile="${layout_dir}/flake-tmp-profile.$$"
      if tmp_profile_rc=$(_nix print-dev-env --profile "$tmp_profile" "$@"); then
        # If we've gotten here, the user's current devShell is valid and we should cache it
        _nix_clean_old_gcroots "$layout_dir"

        # We need to update our cache
        echo "$tmp_profile_rc" >"$profile_rc"
        _nix_add_gcroot "$tmp_profile" "$profile"
        rm -f "$tmp_profile" "$tmp_profile"*

        # also add garbage collection root for source
        local flake_input_paths
        mkdir -p "$flake_inputs"
        flake_input_paths=$(_nix flake archive \
          --json --no-write-lock-file \
          -- "$flake_uri")

        while [[ $flake_input_paths =~ /nix/store/[^\"]+ ]]; do
          local store_path="${BASH_REMATCH[0]}"
          _nix_add_gcroot "${store_path}" "${flake_inputs}/${store_path##*/}"
          flake_input_paths="${flake_input_paths/${store_path}/}"
        done
```

`profile_rc` 就是 `nix print-dev-env` 的 stdout，原样存在 `.direnv/flake-profile-<hash>.rc`；缓存命中时第 182 行 `eval "$(<"$profile_rc")"` 直接把它读回来，第 405 行打印 `Using cached dev shell`，没有 `nix` 进程参与。这就是缓存命中那一百来毫秒的来源。

注意第 372 行的 `_nix_add_gcroot "$tmp_profile" "$profile"`。这是缓存之外的另一件事，也是这个设计最有意思的地方。

## GC root：缓存也会让环境一直留在磁盘上

[`_nix_add_gcroot`](https://github.com/nix-community/nix-direnv/blob/3.2.0/direnvrc#L208-L211) 只有一行：`nix build --out-link "$symlink" "$storepath"`。`--out-link` 在项目的 `.direnv/` 里放一个符号链接指向 store 路径，同时 Nix 在 `/nix/var/nix/gcroots/auto/` 里放一个指向这个符号链接的间接 GC root。垃圾回收只要这个符号链接还在，它指的 store 路径就不会被回收。`use_flake` 做两种：`flake-profile-<hash>`（开发 shell 的环境，闭包里是所有依赖），和 `flake-inputs/` 下的每个 flake 输入的源码（第 378 到 385 行，`nix flake archive --json` 列出来的路径）。`devshell_gc_root.sh` 把这些找出来：

```text
$ cat out/ch13/devshell_gc_root.stdout
== .direnv/
bin
flake-inputs
flake-profile-<hash>
flake-profile-<hash>.rc

== gc roots under .direnv/
"$LAB_TMP/proj/.direnv/flake-inputs/<hash>-source" -> /nix/store/<hash>-source
"$LAB_TMP/proj/.direnv/flake-inputs/<hash>-source" -> /nix/store/<hash>-source
"$LAB_TMP/proj/.direnv/flake-profile-<hash>" -> /nix/store/<hash>-nix-shell-env

== after rm -rf .direnv
roots under .direnv/: 0
```

`.direnv/` 里有四项：`bin`（`nix-direnv-reload` 手动刷新脚本放在这里，[第 75 到 105 行](https://github.com/nix-community/nix-direnv/blob/3.2.0/direnvrc#L75-L105)的 `_nix_direnv_install_reload`，我没有打开看内容）、`flake-inputs`、一个 `flake-profile-<hash>` 链接和它的 `.rc`。`nix-store --gc --print-roots` 列出三个属于这个项目的根：两个 `flake-inputs/...-source`（一个是项目自己，一个是 nixpkgs，我用 `nix flake archive --json` 对着模板项目核对过：`path` 一个、`inputs.nixpkgs.path` 一个），一个 `flake-profile-<hash>` 指向 `nix-shell-env`。`rm -rf .direnv` 之后，属于这个项目的根是 0 个：它们的存在完全取决于 `.direnv/` 里的那几个符号链接。

这个设计的两面。好的一面：我的 `c` shell 闭包是 2,268,745,744 字节，109 个路径（`mkShellNoCC` 一节量的），没有这些根，下一次 `nix-collect-garbage` 就会把它们整个删掉，再次进目录要重新下载或构建。nix-direnv 缓存的不只是“不用求值”，也是“不用重新下载”。坏的一面：`nix-collect-garbage` 管不到它们。一个早就不碰了的项目，只要 `.direnv/` 还在，它的整个开发 shell 就一直占着磁盘。清理的办法是删 `.direnv/`，或者删项目。direnv 自带的 `use flake` 其实也会在 `.direnv/` 里留一个 `flake-profile` 链接（`stdlib.sh` 那段里的 `--profile`），但不会像 nix-direnv 那样给 flake 输入也加根；这是读代码的结论，我没有对着自带模式的项目看 `.direnv/`。

还有一处我第一次跑时没有预料到。实验的沙箱目录用完就被 `rm -rf` 删掉，这时 `/nix/var/nix/gcroots/auto/` 里那些间接根指向的符号链接已经不存在，成了悬空的链接。ch13 标签最早的版本在 `make ch13` 跑完之后，`ls -l /nix/var/nix/gcroots/auto | grep -c firn-lab` 是 5，再跑一次 `nix-store --gc --print-roots`，这个数变成 0。Nix 在扫描根的时候会清掉失效的间接根（这是我从数字变化推出来的，没有去读 `local-gc.cc`）。现在的 `direnv_cache.sh` 在末尾加了 `rm -rf "${LAB_TMP}/proj"` 和一次 `nix-store --gc --print-roots >/dev/null 2>&1`，标签更新后我重跑了 `make ch13`，同一条 `ls | grep -c` 的结果是 0。
## templates：把一个项目变成一条命令

开发环境解决的是“进去之后有什么”。另一半问题是“一个新项目从哪里开始”。flake 有一个专门的输出，`templates`：一个属性集，每个值是一个目录加两段文字。Firn 的在 `flake.nix` 的第 192 到 216 行：

```nix
      templates = {
        c = {
          path = ./templates/c;
          description = "C project: stdenv package, Makefile and mkShell dev shell";
          welcomeText = ''
            Created a C project. Next steps:

            - `git init && git add -A`
            - `nix build && ./result/bin/hello-c`
            - `nix develop`
          '';
        };
        python = {
          path = ./templates/python;
          description = "Python project: hatchling package built with buildPythonApplication";
          welcomeText = ''
            Created a Python project. Next steps:

            - `git init && git add -A`
            - `nix run`
            - `nix develop`
          '';
        };
        default = self.templates.c;
      };
```

`path` 是模板目录，`nix flake init -t` 会把这个目录里的文件拷出来；`description` 是 `nix flake show` 里显示的一行介绍；`welcomeText` 是拷完之后 `nix` 打印给用户的话。`default = self.templates.c` 让 `nix flake init -t <flake>`（不带 `#`）也有意义（见紧接着的实验），这里 `self.templates.c` 引用的是同一个输出属性集里的另一个值，所以 `c` 和 `default` 是同一份内容，`template_c.sh` 的第一段输出里能看到它们的 `description` 相同。

`default` 的效果我手敲验证：在一个空目录里不带 `#` 地对 Firn `init`：

```text
$ cd "$(mktemp -d)"
$ nix flake init -t "${FIRN}" > /dev/null 2>&1
$ LC_ALL=C ls -A
.envrc
.gitignore
Makefile
flake.nix
src
```

（手敲，不在 `lab/ch13/` 里）

拷出来的是 C 模板的 5 个文件（`FIRN` 是我的 Firn 仓库路径，`LC_ALL=C` 只是为了让 `ls` 的顺序固定）。

两个命令都用模板，区别在于去哪里。[`nix flake init`](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-flake-init.html) 往**当前目录**拷；[`nix flake new`](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-flake-new.html) 先建一个目录再拷。拷的时候 Nix 不会覆盖已经存在的文件，我手敲验证了，在一个已经有 `flake.nix` 的目录里 `init`：

```text
$ cd "$(mktemp -d)"
$ echo '{ }' > flake.nix
$ nix flake init -t "${FIRN}#c"; echo "rc=$?"
wrote: "$DIR/.envrc"
wrote: "$DIR/.gitignore"
wrote: "$DIR/Makefile"
refusing to overwrite existing file "$DIR/flake.nix"
 please merge it manually with '$FIRN/templates/c/flake.nix'
wrote: "$DIR/src/main.c"
wrote: "$DIR/src"


Created a C project. Next steps:

  · git init && git add -A 
  · nix build && ./result/bin/hello-c 
  · nix develop 

error: encountered 1 conflicts - see above
rc=1
$ ls -A; cat flake.nix
.envrc
flake.nix
.gitignore
Makefile
src
{ }
```

（手敲，不在 `lab/ch13/` 里）

`FIRN` 是我的 Firn 仓库路径，输出里的临时目录和仓库路径我换成了 `$DIR` 和 `$FIRN`，`rc=` 是 `nix` 的退出码。`flake.nix` 被拒绝覆盖，其余四个文件照拷，`welcomeText` 照样打印，最后 `error: encountered 1 conflicts`，退出码 1，已有的 `flake.nix` 还是那个 `{ }`。它没有帮我合并，只是告诉我该自己合并；悄悄覆盖一个已有的 `flake.nix` 才是危险的。

### C 模板

`templates/c/` 有 5 个文件：`flake.nix`、`Makefile`、`src/main.c`、`.envrc` 和 `.gitignore`。`src/main.c` 和 `Makefile` 是最小的东西：

```c
// SPDX-License-Identifier: MIT OR Apache-2.0
#include <stdio.h>

int main(void)
{
	puts("hello from template");
	return 0;
}
```

```make
CC ?= cc
PREFIX ?= /usr/local

CFLAGS ?= -g -O2 -Wall -Wextra

.PHONY: all install clean

all: hello-c

hello-c: src/main.c
	$(CC) $(CFLAGS) -o $@ $<

install: hello-c
	install -D -m 755 hello-c $(DESTDIR)$(PREFIX)/bin/hello-c

clean:
	rm -f hello-c
```

`CC ?= cc`、`PREFIX ?= /usr/local` 和 `CFLAGS ?= ...` 都用 `?=`，也就是“没人设置才用这个默认”，所以 Nix 可以从外面传 `PREFIX`。`flake.nix` 的包那一半是：

```nix
          default = pkgs.stdenv.mkDerivation {
            pname = "hello-c";
            version = "0.1.0";

            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [
                ./Makefile
                ./src
              ];
            };

            makeFlags = [ "PREFIX=${placeholder "out"}" ];

            meta = {
              description = "Prints a greeting from a template";
              mainProgram = "hello-c";
              platforms = pkgs.lib.platforms.unix;
            };
          };
```

`lib.fileset.toSource` 只把 `Makefile` 和 `src` 放进构建的源码（第 10 篇讲过）；`makeFlags = [ "PREFIX=${placeholder "out"}" ]` 让 `make install` 装进 `$out`；`meta.mainProgram` 让 `nix run` 知道该跑哪个。`devShell` 那一半就是 Firn `c` shell 的同一个模式：

```nix
          default = pkgs.mkShell {
            inputsFrom = [ self.packages.${system}.default ];
            packages = with pkgs; [
              gdb
              clang-tools
            ];
          };
```

`inputsFrom = [ self.packages.${system}.default ]`：依赖只写一遍，写在包里，shell 借过来，再加开发工具。`self.packages.${system}.default` 是这个 flake 自己的输出，Firn 的 `c` shell 借的是 `pkgs.firn-hello`，是同一种做法。模板里的 `nixpkgs` 用 `github:NixOS/nixpkgs/nixos-unstable`，是没锁的，rev 在第一次 `nix flake lock` 时才定。

`template_c.sh` 把整条路走一遍：

```bash
main() {
  echo "== templates of the firn flake"
  nix eval --json "${FIRN_ROOT}#templates" \
    --apply 'ts: builtins.mapAttrs (_: t: t.description) ts' | jq .

  echo
  echo "== nix flake init -t firn#c"
  mkdir "${LAB_TMP}/hello-c"
  cd "${LAB_TMP}/hello-c"
  nix flake init -t "${FIRN_ROOT}#c" 2>&1 \
    | grep -v "^warning" | sed "s|${LAB_TMP}|\$LAB_TMP|"
  git init -q
  git add -A
  find . -path ./.git -prune -o -type f -print | LC_ALL=C sort

  echo
  echo "== nix build"
  pin_nixpkgs::lock
  git add -A
  local out
  out="$(nix build --no-link --print-out-paths 2>/dev/null)"
  printf 'volatile: %s\n' "${out}"
  "${out}/bin/hello-c"

  echo
  echo "== nix run"
  nix run 2>/dev/null
}

main "$@"
```

```text
$ cat out/ch13/template_c.stdout
== templates of the firn flake
{
  "c": "C project: stdenv package, Makefile and mkShell dev shell",
  "default": "C project: stdenv package, Makefile and mkShell dev shell",
  "python": "Python project: hatchling package built with buildPythonApplication"
}

== nix flake init -t firn#c
wrote: "$LAB_TMP/hello-c/.envrc"
wrote: "$LAB_TMP/hello-c/.gitignore"
wrote: "$LAB_TMP/hello-c/Makefile"
wrote: "$LAB_TMP/hello-c/flake.nix"
wrote: "$LAB_TMP/hello-c/src/main.c"
wrote: "$LAB_TMP/hello-c/src"


Created a C project. Next steps:

  · git init && git add -A 
  · nix build && ./result/bin/hello-c 
  · nix develop 

./.envrc
./.gitignore
./Makefile
./flake.nix
./src/main.c

== nix build
volatile: /nix/store/8kp9avgdnhza020w4ncxc4frk7hf8gbm-hello-c-0.1.0
hello from template

== nix run
hello from template
```

读输出。第一段 `nix eval --json ...#templates` 把三个名字的 `description` 打出来，`default` 和 `c` 的一样。第二段 `nix flake init` 先为每个文件打印 `wrote: ...`，然后是 `welcomeText`（`·` 我猜是 Nix 把 Markdown 的 `-` 列表渲染成的圆点，行尾的空格也是渲染带的）；`git init -q && git add -A` 是因为 flake 只看被 git 跟踪的文件（第 8 篇）；`find` 列出 5 个文件，没有 `flake.lock`，要等下一步。第三段先锁 `flake.lock`，再 `nix build`，二进制打印 `hello from template`，`nix run` 也打印同一句。锁的那一步是 `fixtures/pin_nixpkgs.sh` 里的一个函数：

```bash
#######################################
# Write flake.lock in the current directory with nixpkgs from nix/pins.nix.
# Globals:
#   FIRN_ROOT
# Returns:
#   Non-zero if the lock cannot be written.
#######################################
pin_nixpkgs::lock() {
  local source nar_hash
  source="$(nix eval --raw --file "${FIRN_ROOT}/nix/pins.nix" nixpkgs \
    2>/dev/null)" || return 1
  nar_hash="$(jq -r '.nodes.nixpkgs.locked.narHash' \
    "${FIRN_ROOT}/flake.lock")" || return 1
  nix --offline flake lock --override-input nixpkgs \
    "path:${source}?narHash=${nar_hash}" 2>/dev/null
}
```

模板的 `flake.nix` 写的是 `github:NixOS/nixpkgs/nixos-unstable`，没锁，不处理的话 `nix flake lock` 会去网上解析“现在的”那一份。函数把 `nixpkgs` 输入覆盖成 `nix/pins.nix` 里那份源码在 store 里的路径，用 `path:` 加 `?narHash=`，`narHash` 读自 Firn 自己的 `flake.lock`，所以项目锁到的是和本系列同一个 nixpkgs，而且带着 `--offline`，不碰网络。这个文件的头注释交代了它为什么存在：此前实验里用的是 `github:NixOS/nixpkgs/<rev>?narHash=...` 形式的 override，注释说它在一次完整的 `make ci` 里仍然访问了 GitHub，第一次锁花了 20.8 秒，后来一次在网络不可达时失败。那是仓库作者的观察，我没有复现，我这边只验证了新版。我手敲量了新版：

```text
$ source lab/ch13/fixtures/pin_nixpkgs.sh
$ s=$(date +%s%N); pin_nixpkgs::lock; echo "rc=$?"; e=$(date +%s%N); echo "ms=$(( (e - s) / 1000000 ))"
$ jq -c '.nodes.nixpkgs.locked | {type, narHash}' flake.lock
$ jq -r '.nodes.nixpkgs.locked.path' flake.lock
$ jq -r '.nodes.nixpkgs.locked.narHash' "${FIRN_ROOT}/flake.lock"
rc=0
ms=86
{"type":"path","narHash":"sha256-9i/VTdusq/+NM/tz+J1Re+ojkMB8MBf0QshnYfzHz30="}
/nix/store/<hash>-source
sha256-9i/VTdusq/+NM/tz+J1Re+ojkMB8MBf0QshnYfzHz30=
```

（手敲，不在 `lab/ch13/` 里）

在刚 `nix flake init` 出来的 C 模板目录里，`FIRN_ROOT` 指向 Firn 仓库。锁一次 86 ms，退出码 0；锁里 `nixpkgs` 的类型是 `path`，`narHash` 和 Firn 的 `flake.lock` 里的那个一模一样（最后两行，store 路径的哈希我替换成了 `<hash>`）。`path:` 输入的代价是锁里不再有 `rev`，所以这个项目的 `flake.lock` 离开这台机器就没有意义，对一个实验来说没关系，对真实项目就不是了：真实项目要的是 `github:` 形式的锁。

我顺手在这个项目里试了开发 shell，因为模板里 `inputsFrom` 借的是包，所以 `make` 能直接用：

```text
$ nix develop --command bash -c \
    'echo "CC=${CC}"; make; ./hello-c; gdb --batch -ex "info line main" ./hello-c 2>&1 | tail -n 1'
CC=gcc
gcc -g -O2 -Wall -Wextra -o hello-c src/main.c
hello from template
Line 6 of "src/main.c" starts at address 0x1050 <main> and ends at 0x1051 <main+1>.
```

（手敲，不在 `lab/ch13/` 里）

`nix develop` 在 `init` 出来、`flake.lock` 已经锁好的那个项目目录里跑，stderr 丢掉了。`CC=gcc` 是 stdenv 导出的，`Makefile` 里的 `CC ?= cc` 因为环境里已经有 `CC` 而没有生效，所以编译命令是 `gcc ...`；`CFLAGS ?= -g -O2 -Wall -Wextra` 里有 `-g`，所以 shell 里的 gdb 能给 `main` 报出源码行号 (`Line 6 of "src/main.c"`)。ch13 标签最早的版本这里是 `-O2 -Wall -Wextra`，没有 `-g`，gdb 只说 `No line number information available`；仓库后来补上了。装了调试器却不产生调试信息的模板，是一个只验证产出、不在 shell 里用一遍就发现不了的缺陷。

### Python 模板

`templates/python/` 同样 5 个文件。包的部分用 `buildPythonApplication`：

```nix
          default = pkgs.python3Packages.buildPythonApplication {
            pname = "hello";
            version = "0.1.0";
            pyproject = true;

            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [
                ./pyproject.toml
                ./src
              ];
            };

            build-system = [ pkgs.python3Packages.hatchling ];

            meta = {
              description = "Prints a greeting from a template";
              mainProgram = "hello";
            };
          };
```

`pyproject = true` 和 `build-system = [ hatchling ]` 说这个包用 PEP 517 的方式构建，后端是 hatchling（Python 构建后端的一种），`pyproject.toml` 告诉它怎么构建，`[project.scripts]` 声明命令入口：

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "hello"
version = "0.1.0"
description = "Prints a greeting from a template"
requires-python = ">=3.10"
dependencies = []

[project.scripts]
hello = "hello:main"

[tool.hatch.build.targets.wheel]
packages = ["src/hello"]
```

```python
"""Print a greeting from a template."""


def main() -> None:
    """Print the greeting."""
    print("hello from template")
```

`hello = "hello:main"` 的意思是安装后在 `bin/` 里生成一个叫 `hello` 的命令，调用 `hello` 包里的 `main()`。（对照：Sift 的 [`pyproject.toml` 第 38 到 39 行](https://github.com/bfmhno3/sift/blob/ch25/pyproject.toml#L38-L39)是同一种声明，`sift = "sift.cli:main"`。）`template_python.sh` 这次用 `nix flake new`：

```bash
main() {
  echo "== nix flake new -t firn#python"
  cd "${LAB_TMP}"
  nix flake new hello-py -t "${FIRN_ROOT}#python" 2>&1 \
    | grep -v "^warning" | sed "s|${LAB_TMP}|\$LAB_TMP|"
  cd hello-py
  git init -q
  git add -A
  find . -path ./.git -prune -o -type f -print | LC_ALL=C sort

  echo
  echo "== nix run"
  pin_nixpkgs::lock
  git add -A
  nix run 2>/dev/null

  echo
  echo "== nix develop"
  nix develop --command bash -c \
    'python3 --version; ruff --version; pytest --version' 2>/dev/null \
    | sed 's/^/volatile: /'
}
```

```text
$ cat out/ch13/template_python.stdout
== nix flake new -t firn#python
wrote: "$LAB_TMP/hello-py/.envrc"
wrote: "$LAB_TMP/hello-py/.gitignore"
wrote: "$LAB_TMP/hello-py/flake.nix"
wrote: "$LAB_TMP/hello-py/pyproject.toml"
wrote: "$LAB_TMP/hello-py/src/hello/__init__.py"
wrote: "$LAB_TMP/hello-py/src/hello"
wrote: "$LAB_TMP/hello-py/src"


Created a Python project. Next steps:

  · git init && git add -A 
  · nix run 
  · nix develop 

./.envrc
./.gitignore
./flake.nix
./pyproject.toml
./src/hello/__init__.py

== nix run
hello from template

== nix develop
volatile: Python 3.14.7
volatile: ruff 0.16.3
volatile: pytest 9.1.1
```

`flake new hello-py` 建了目录，其余和 C 的一样；`nix run` 构建 wheel、装进 `$out`、运行 `hello`，打印 `hello from template`；最后在 `nix develop` 里 `python3`、`ruff`、`pytest` 的版本分别是 3.14.7、0.16.3、9.1.1。

但是这个模板的开发 shell 有一个我没料到的缺口。我手敲：

```text
$ P="$(dirname "$(command -v nix)"):$(dirname "$(command -v bash)"):/run/current-system/sw/bin"
$ env -i HOME="${HOME}" PATH="${P}" nix develop --command bash -c \
    'python3 -c "import hello" 2>&1 | tail -n 1; command -v pip || echo "no pip"; command -v uv || echo "no uv"; echo "PYTHONPATH has src: $([[ ${PYTHONPATH} == *src* ]] && echo yes || echo no)"'
ModuleNotFoundError: No module named 'hello'
no pip
no uv
PYTHONPATH has src: no
```

（手敲，不在 `lab/ch13/` 里）

在 `nix flake new` 出来并锁好的 Python 项目里跑。shell 里有 `python3`、`ruff`、`pytest`（`PYTHONPATH` 里能看到 `pytest` 和 hatchling 这些包），但 `import hello` 失败：项目自己没有装进去，`src/` 也不在 `PYTHONPATH` 里。`inputsFrom` 借来的是 `hello` 包的**依赖**，不是 `hello` 自己（这正是 `inputs_from.nix` 的结论）。shell 没有提供 `pip` 和 `uv`（这个实验在 `env -i` 加最小 `PATH` 下跑，避免宿主机的 `PATH` 混进来），所以要么改 `PYTHONPATH`，要么把它们加进 `packages`。我把它记作仓库缺陷，练习 2 给出一个修法。

## 别的项目怎么做：Pebble、Cairn 和 Sift

Firn 的 `c` 和 `python` 是为这一篇写的。另外三个项目，Pebble、Cairn 和 Sift，各自的仓库里早就有 `flake.nix` 和 `.envrc`，只做一件事：开发 shell。第 11 篇打包它们用的是 Pebble 的 `tutorial-v1`、Cairn 的 `ch10` 和 Sift 的 `ch25` 标签，我就读这三个标签上的文件：[Pebble 的 `flake.nix`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/flake.nix)（41 行）、[Cairn 的](https://github.com/bfmhno3/cairn/blob/ch10/flake.nix)（64 行）、[Sift 的](https://github.com/bfmhno3/sift/blob/ch25/flake.nix)（117 行）。三个文件的骨架是同一个：`inputs.nixpkgs` 在 Pebble 里是 `nixos-26.05`，在 Cairn 和 Sift 里是 `nixos-unstable`，其余结构一样。Pebble 的最短，整个骨架在它里面：

```nix
  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      devShellsBySystem = nixpkgs.lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        pkgs.mkShell {
          packages = with pkgs; [
            rustc
            cargo
            rust-analyzer
            clippy
            rustfmt
            gdb
            hyperfine
            pkg-config
            zlib
          ];
          shellHook = ''
            echo "Pebble dev shell: $(rustc --version)"
            echo "Try: cargo run -p pebble-cli -- repl"
          '';
        }
      );
    in
    {
      devShells = nixpkgs.lib.mapAttrs (_: devShell: { default = devShell; }) devShellsBySystem;
      checks = nixpkgs.lib.mapAttrs (_: devShell: { dev-shell = devShell; }) devShellsBySystem;
    };
```

`devShellsBySystem` 对每个系统做一个 `mkShell`；`devShells` 把它包成 `{ default = ...; }`，这样 `nix develop` 不带参数就能进；`checks` 把同一个 shell 登记成 `dev-shell`，`nix flake check` 因此会**构建**它。这正是 `mkShell` 一节读过的那个输出的用处：构建的结果是一个引用所有输入的文本文件，CI 构建它就等于确认所有依赖都还拿得到。Firn 自己的 `flake.nix` 第 138 行也是这么做的 (`dev-shell = devShells.${system}`)，只是这一章新加的 `c` 和 `python` 没有登记进 `checks`，目前只有 `default` 在里面。三个仓库的 `.envrc` 都是一行 `use flake`，Pebble 的我 `git show` 看过：

```text
$ git -C ~/Projects/pebble show tutorial-v1:.envrc
use flake
```

（手敲，不在 `lab/ch13/` 里）

路径是我本机的 Pebble 仓库，读者在自己克隆的目录里用同样的命令。

三个仓库的差别在 `packages` 和 `shellHook` 里。Pebble 要的是 `rustc`、`cargo`、`rust-analyzer`、`clippy`、`rustfmt`、`gdb`、`hyperfine`，以及 `pkg-config` 和 `zlib`；shell 只在进入时打印 `rustc --version`。Cairn 的 shell 有 26 个工具（`bash`、`shellcheck`、`shfmt`、`bats` 带三个库、`kcov`、`strace`，还有 `dash`、`yash`、`mksh` 三个别的 shell，大概是用来测可移植性的），它的 `shellHook` 把测试需要的路径导出成变量：

```nix
          shellHook = ''
            export CAIRN_BUSYBOX="${pkgs.busybox}/bin/busybox"
            export CAIRN_BASH_COMPLETION="${pkgs.bash-completion}/share/bash-completion/bash_completion"
            export LOCALE_ARCHIVE="${pkgs.glibcLocales}/lib/locale/locale-archive"
            echo "cairn dev shell: $(bash --version | head -n 1), shellcheck $(shellcheck --version | sed -n 's/^version: //p'), shfmt $(shfmt --version), $(bats --version)"
          '';
```

`"${pkgs.busybox}/bin/busybox"` 是 Nix 的插值，在求值时变成 store 路径，所以 `CAIRN_BUSYBOX` 指向一个固定的、被 Nix 保证存在的 busybox，测试脚本不用在 `PATH` 里碰运气。`LOCALE_ARCHIVE` 那一行，我猜是因为 Nix 里的 glibc 找不到系统的 locale 数据，要明确告诉它去哪找；这是我对这行意图的推断，没有去掉它试。

Sift 的 shell 最大。它用的是 `python314.withPackages`，加上自由线程版的 `python314FreeThreading`、`ruff`、`uv`、`pyright`、`maturin`，还有整套 Rust 工具链和 `gcc`，大概是给 Rust 写的扩展用的，我没有去读 Sift 的代码确认。更有意思的是它的 `shellHook`：

```nix
          shellHook = ''
            export FONTCONFIG_FILE=${fontsConf}
            export SIFT_CJK_FONT="${pkgs.noto-fonts-cjk-sans}/share/fonts/opentype/noto-cjk/NotoSansCJK-VF.otf.ttc"
            unset PYTHONPATH _PYTHON_SYSCONFIGDATA_NAME _PYTHON_HOST_PLATFORM
            if [ ! -d .venv ]; then python3 -m venv --system-site-packages .venv; fi; source .venv/bin/activate; pip install -q --no-deps --no-build-isolation -e .
            export UV_PYTHON_DOWNLOADS=never UV_PYTHON=python3.14 PYTHONHASHSEED=0
            echo "sift dev shell: $(python3 --version), $(python3.14t --version) (free-threaded), $(ruff --version), $(rustc --version)"
          '';
```

第 105 行 `unset PYTHONPATH _PYTHON_SYSCONFIGDATA_NAME _PYTHON_HOST_PLATFORM` 清掉一批从外面带来的 Python 环境变量；第 106 行，如果没有 `.venv` 就建一个，`--system-site-packages` 让它看得见 Nix 提供的包，然后 `pip install -q --no-deps --no-build-isolation -e .` 把项目以可编辑方式装进去；第 107 行 `UV_PYTHON_DOWNLOADS=never UV_PYTHON=python3.14` 禁止 uv 自己下载 Python，指定用 Nix 的。这三行是下一节的主题。

## Python：venv、uv 和 Nix 放在一起

Firn 的 `python` shell 里是 `python3.withPackages (ps: [ ps.sqlalchemy ps.typer ps.rich ps.pytest ])`，它是一个固定的解释器加固定的一组包，全部来自 nixpkgs，`import sqlalchemy` 立刻可用，也不依赖网络。代价是想要 nixpkgs 里没有的包，或者不是 nixpkgs 里那个版本，就得自己打包（第 11 篇的 `buildPythonApplication`）。`uv` 在同一个 shell 里，是给这种情况留的出口：用 uv 建一个 venv，从 PyPI 装。这条路有一个我踩到了的坑。

我手敲，在 `python` shell 里用 uv 建 venv 并装 numpy，然后 import：

```text
$ rm -rf /tmp/venv-nix
$ nix develop .#python --command bash -c '
uv venv -q --python "$(command -v python3)" /tmp/venv-nix
uv pip install -q --python /tmp/venv-nix numpy
/tmp/venv-nix/bin/python -c "import numpy" 2>&1 | grep "Original error"'
Original error was: libstdc++.so.6: cannot open shared object file: No such file or directory
```

（手敲，不在 `lab/ch13/` 里）

stderr 里 uv 的进度我用 `-q` 压掉了，`grep` 只留 numpy 报错的最后一行。`import numpy` 失败：`libstdc++.so.6: cannot open shared object file`。numpy 的 wheel 是为普通 Linux 发行版编译的 (manylinux)，里面的 `.so` 假定 `libstdc++.so.6` 在系统标准路径里，而 NixOS 没有标准路径。

我的机器上开着 `programs.nix-ld`，按理这类东西应该能跑，所以我想确认一件事：这个 shell 里，nix-ld 的库路径是不是真的在：

```text
$ nix develop .#python --command bash -c '
echo "NIX_LD_LIBRARY_PATH=${NIX_LD_LIBRARY_PATH}"
ls /run/current-system/sw/share/nix-ld/lib | grep -c "^libstdc++.so.6$"'
NIX_LD_LIBRARY_PATH=/run/current-system/sw/share/nix-ld/lib
1
```

（手敲，不在 `lab/ch13/` 里）

`NIX_LD_LIBRARY_PATH` 在，目录里也有 `libstdc++.so.6`，计数是 1。库就在那里，numpy 照样找不到。我的解释是：nix-ld 只对解释器写成 `/lib64/ld-linux-x86-64.so.2` 的程序生效，这个 `python3` 是 Nix 构建的，解释器是 Nix 自己的 glibc 里的 `ld.so`，它 `dlopen` numpy 的 `.so` 时用它自己的搜索路径，从来不看 `NIX_LD_LIBRARY_PATH`。这个解释是从现象推的，我没有去读 glibc 或者 nix-ld 的代码；修法二是它的旁证。

修法一：在 shell 里设 `LD_LIBRARY_PATH`，指向 `libstdc++` 和 numpy 接着要的库。我用一个一次性的 shell，把这两个库放进 `env.LD_LIBRARY_PATH`：

```text
$ nix develop --impure --expr '
  let
    pkgs = import ./nix/pkgs.nix { };
  in
  pkgs.mkShellNoCC {
    env.LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [
      pkgs.stdenv.cc.cc.lib
      pkgs.zlib
    ];
  }
' --command /tmp/venv-nix/bin/python -c 'import numpy; print(numpy.__version__)'
2.5.4
```

（手敲，不在 `lab/ch13/` 里）

`--command` 的参数直接是 venv 里的 python，没有再套一层 `bash -c`。`2.5.4`。我先试的是只有 `stdenv.cc.cc.lib`，这次报错变成了 `libz.so.1: cannot open shared object file`，加上 `zlib` 才过。也就是说这个办法要一个库一个库地补：下一个包需要的库不在列表里，就再报一个。它还有一个我没有测、但由 `LD_LIBRARY_PATH` 的定义推得出的副作用：它对这个 shell 里启动的每一个程序都生效。

修法二：不用 Nix 的 Python，让 uv 自己下载一个，靠 nix-ld 跑：

```text
$ rm -rf /tmp/venv-managed /tmp/uv-pythons
$ nix develop .#python --command bash -c '
export UV_PYTHON_INSTALL_DIR=/tmp/uv-pythons UV_PYTHON_PREFERENCE=only-managed
uv venv -q --python 3.13 /tmp/venv-managed
file -bL /tmp/venv-managed/bin/python | cut -d, -f1,2,5 | cut -c1-150
uv pip install -q --python /tmp/venv-managed numpy
/tmp/venv-managed/bin/python -c "import numpy; print(numpy.__version__)"'
ELF 64-bit LSB executable, x86-64, interpreter /lib64/ld-linux-x86-64.so.2
2.5.4
```

（手敲，不在 `lab/ch13/` 里）

这次 uv 下载了一个独立构建的 CPython 3.13，`file` 说它的解释器是 `/lib64/ld-linux-x86-64.so.2`：它是一个没有为 Nix 打过补丁的普通可执行文件，正是 nix-ld 要接管的那一类。numpy 装进去，`import` 成功，`2.5.4`。同一个 wheel，同一台机器：Nix 的 Python 失败，uv 下载的 Python 成功。我没有在没开 nix-ld 的机器上试，所以不知道那里 uv 下载的 Python 会怎么失败，也不知道你的机器上 nix-ld 的库列表里有没有这次需要的库。

Sift 的 shellHook（Sift 一节读过的第 105 到 107 行）走的是第三条路：禁止下载 (`UV_PYTHON_DOWNLOADS=never`)，所有 Python 都是 Nix 的，venv 带上 `--system-site-packages` 去借 Nix 的包，只用 `pip install --no-deps` 装项目本身。它避开的是“下载来的 Python 在 Nix 之外”这个问题，代价是：能装进 venv 的东西被限制成 nixpkgs 里有的，纯 Python 的包没问题，带原生扩展的从 PyPI 来的 wheel 还会再撞上 numpy 这个问题。

把三条路并排放，我自己的取舍是这样的：

- 包都在 nixpkgs 里：`withPackages`，不碰 venv。可复现，不需要网络，没有 `.so` 找不到的问题。Firn 的 `python` shell 就是这样。
- 要装 nixpkgs 里没有的纯 Python 包：Nix 的 Python 加 uv 的 venv，禁止 uv 下载 Python。
- 要装带原生扩展的 wheel：要么设 `LD_LIBRARY_PATH` 并且接受库一个一个地补，要么换 uv 下载的 Python 并且接受“只在装了 nix-ld 的 NixOS 上能跑”。我不喜欢这两个，因为它们都让 flake 之外的东西成了环境的一部分，`nix develop` 不再是自洽的。我还没有真的把一个需要 numpy 这类包的项目放进 Firn，所以我对这两条路的长期体验是空白的。

## programs.nix-ld，一段话

修法二里用到的 nix-ld 是 NixOS 的一个模块，[`nixos/modules/programs/nix-ld.nix`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/programs/nix-ld.nix#L35-L65) 是 `programs.nix-ld.enable = true;` 打开后的全部内容：第 36 行 `environment.ldso` 让 `/lib64/ld-linux-x86-64.so.2` 存在，指向 nix-ld 的加载器（我这台机器上 `readlink /lib64/ld-linux-x86-64.so.2` 去掉哈希是 `nix-ld-2.0.6/libexec/nix-ld`）；第 42 到 45 行设了 `NIX_LD` 和 `NIX_LD_LIBRARY_PATH` 两个会话变量，前者指向真正的动态链接器，后者指向一个由 `programs.nix-ld.libraries` 拼出来的库目录；第 49 到 64 行是这个库列表的默认值，里面有 `zlib`、`stdenv.cc.cc`（就是 libstdc++ 的来源）、`openssl`、`curl` 等 14 项。它让“从别处下载来的、没有为 Nix 打补丁的二进制”能直接跑，这正是修法二用到的东西。它不是 flake 的一部分，是整台机器的配置，所以依赖它的项目在没开它的机器上不能复现；这是一个比 `LD_LIBRARY_PATH` 干净、但同样跳出了 flake 的方案。

## 让我意外的事

我原来以为这一篇讲的是“怎么把常用工具装进一个 shell”，写完发现真正的内容是“`nix develop` 从来不运行你以为它在运行的那个派生”。四件事：

**`mkShell` 的派生会被构建，`nix develop` 却一次也不构建它。** 我带着“它是个拒绝构建的壳”的印象开始，结果 `nix build .#devShells.x86_64-linux.c` 成功了，产出一个 7272 字节的文本文件，它的闭包有 109 个路径，手册里明明白白写着那是给 CI 和 GC root 用的。`nix develop` 读的是另一个东西：把它的 `args` 换成 `get-env.sh`、名字加 `-env` 后缀的那个改写版。`fixtures/refuses.nix` 才是真的拒绝构建（`nix build` 退出码 1），却能 `nix develop`。

**`inputsFrom` 只借依赖，不借别的，连 `strictDeps` 也不借。** `firn-hello` 的 `package.nix` 里有 `strictDeps = true` 和 `env.NIX_CFLAGS_COMPILE`，c shell 里一个也没有：`FIRN_GREETING flags: 0`。没有 `strictDeps`，`NIX_CFLAGS_COMPILE` 里 gdb 和 zlib 的 `-isystem` 各出现两次，加上 `strictDeps = true`，gdb 没了，zlib 变成一次。

**一个讲 GC root 的实验，第一版自己留下了 5 个失效的 GC root；据仓库注释，第一版锁 nixpkgs 的那一行可能也不够离线。** `direnv_cache.sh` 最早跑完，`/nix/var/nix/gcroots/auto/` 里有 5 个指向已删除的 `LAB_TMP` 的间接根，要等下一次 `nix-store --gc --print-roots` 才会被清掉；仓库的注释说 `github:` 形式的 override 仍然访问过网络。两个都已经在重打的标签里修了，我只是在第一版上先撞到了前一个。

**模板自己的开发 shell 有两处不趁手，一处修了，一处没有。** C 模板的 `Makefile` 最早没有 `-g`，gdb 找不到行号，现在补上了；Python 模板里 `import hello` 仍然失败。两个都是 `nix flake init` 出来之后的第一分钟就会撞上的。`template_c.sh` 和 `template_python.sh` 验证的是 `nix build`、`nix run` 和工具的版本，没有一个实验在 shell 里 `import hello`。这是“只验证产出，不验证开发体验”，我把 Python 这个记作缺陷，练习 2 修它。

## 检查点

在 `~/firn` 里，`nix develop` 之内：

```bash
make ch13
make lint
make check
while read -r f; do
  diff <(git -C ~/firn-ref show ch13:"${f}") "${f}" && echo "same ${f}"
done < <(git -C ~/firn-ref diff --name-only ch12 ch13 \
  | grep -v -e '^flake.nix$')
```

我的环境里设了 `CI=true`，我跑的是 `env -u CI make ch13`。这一章没有 `_host` 实验，所以 `CI=true` 时也是同样的 10 个 `ok`。`make ch13` 应当打印这 11 行（命令回显加 10 行 `ok`），整条命令（含 `nix develop` 的启动）在这台机器上花了 54.1 秒（更早两次是 82.4 秒和 71.3 秒，当时用的是旧版的锁法）：

```text
$ env -u CI make ch13
bash scripts/chapter.sh ch13
ok   lab/ch13/devshell_gc_root.sh
ok   lab/ch13/direnv_cache.sh
ok   lab/ch13/ex_rust_template.sh
ok   lab/ch13/inputs_from.nix
ok   lab/ch13/mkshell_env.sh
ok   lab/ch13/mkshell_vs_nocc.sh
ok   lab/ch13/print_dev_env.sh
ok   lab/ch13/shellhook_order.sh
ok   lab/ch13/template_c.sh
ok   lab/ch13/template_python.sh
```

10 个实验全部是 `ok`，没有 `_fail`，所以 `out/ch13/*.status` 全是 0。`make lint` 回显它跑的几条命令（`nixfmt --check`、`deadnix --fail`、`shellcheck`、`shfmt`；`statix` 那一行以 `@` 开头，`make` 不回显），没有任何诊断，退出码 0；`NIX_STRICT` 排除了 `lab/` 和 `templates/`，所以 `statix` 和 `deadnix` 不检查模板，`nixfmt --check` 检查。`make check` 以 `all checks passed!` 结束，退出码 0，x86\_64-linux 上仍是 14 个检查（这一章没有往 `checks` 里加东西）：

```text
$ make check 2>&1 | tail -n 5; echo "rc=${PIPESTATUS[0]}"
derivation evaluated to /nix/store/sxj15y2pgk96v1kv2si52j1i2dqbbd5q-nixfmt-tree-2.5.0.drv
running 0 flake checks...
all checks passed!
warning: The check omitted these incompatible systems: aarch64-linux
Use '--all-systems' to check all.
rc=0
```

`diff` 循环应当打印 30 行 `same ...`，不打印 diff（30 = 31 - 1，`flake.nix` 被排除）。我用 `git -C` 指向我本机的仓库跑过，数出来是 30。

**必须和标签一致的文件：** `templates/` 下全部 10 个文件，`lab/ch13/` 下全部 20 个文件（10 个实验加 10 个 fixture）。

**中间版本（之后的章节会继续改）：**

- [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch13/flake.nix)：`devShells` 现在是 `c`、`default`、`python` 三个，加上 `templates`；之后每章都会往 `packages`、`checks` 里加东西。
- `README.md`：这一章没有改。

### 文件清单

这一篇的所有文件都在仓库里，链接指向标签 `ch13` 上的那一份。`git diff --name-only ch12 ch13` 列出 31 个文件，这里一个不少；`lab/ch13/` 下有 20 个文件（9 个 `.sh`、1 个 `.nix` 实验，和 10 个 fixture 文件），它们都已经在那 31 个里。`README.md`、`pkgs/` 和 `overlays/` 没有变，不在表里。实验需要沙箱目录和 `FIRN_ROOT`，所以只能由 `make ch13` 启动。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch13/flake.nix) | `nix eval .#devShells.x86_64-linux --apply builtins.attrNames`；`make check` | `[ "c" "default" "python" ]`；`templates` 也是 `c`、`default`、`python`；`make check` 以 `all checks passed!` 结束 |
| [`lab/ch13/devshell_gc_root.sh`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/devshell_gc_root.sh) | `make ch13` | 退出码 0；`.direnv/` 里 4 项（`bin`、`flake-inputs`、`flake-profile-<hash>` 和它的 `.rc`）；3 个 GC root；`rm -rf .direnv` 之后 0 个 |
| [`lab/ch13/direnv_cache.sh`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/direnv_cache.sh) | `make ch13` | 退出码 0；nix-direnv 首次 10195 ms、缓存命中 118 ms（86.4 倍）；自带 `use flake` 248 ms（缓存命中的 2.1 倍）；结尾 `rm -rf proj` 加 `nix-store --gc --print-roots`，不留悬空的根 |
| [`lab/ch13/ex_rust_template.sh`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/ex_rust_template.sh) | `make ch13` | 退出码 0；练习 1 的答案；模板 `description` 一行，`nix build` 的二进制打印 `hello from template`，`cargo 1.97.0`、`rustfmt 1.9.0` |
| [`lab/ch13/fixtures/direnv_project.sh`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/fixtures/direnv_project.sh) | `make ch13`（被 `direnv_cache.sh` 和 `devshell_gc_root.sh` `source`） | 它自己不被运行器执行；建项目、三个 `XDG_*` 目录，写 `direnvrc`，`direnv allow` |
| [`lab/ch13/fixtures/hooks.nix`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/fixtures/hooks.nix) | `make ch13`（由 `shellhook_order.sh` 使用） | `combined` 的 hook 顺序是 `b`、`a`、`combined (own)` |
| [`lab/ch13/fixtures/pin_nixpkgs.sh`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/fixtures/pin_nixpkgs.sh) | `make ch13`（被 `template_c.sh`、`template_python.sh`、`ex_rust_template.sh` 和 `direnv_project.sh` `source`） | 它自己不被运行器执行；`pin_nixpkgs::lock` 用 `nix --offline flake lock --override-input nixpkgs path:...?narHash=...` 锁 nixpkgs，手敲量下来 86 ms，锁里的 `narHash` 与 Firn 的 `flake.lock` 相同 |
| [`lab/ch13/fixtures/refuses.nix`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/fixtures/refuses.nix) | `make ch13`（由 `mkshell_env.sh` 使用） | `nix build` 退出码 1 并打印 `this derivation is not meant to be built`；`nix develop` 成功，`IN_NIX_SHELL=impure` |
| [`lab/ch13/fixtures/rust-template/.envrc`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/fixtures/rust-template/.envrc) | `make ch13`（由 `ex_rust_template.sh` 拷贝） | 一行 `use flake`；`find` 的第一个文件 |
| [`lab/ch13/fixtures/rust-template/Cargo.lock`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/fixtures/rust-template/Cargo.lock) | `make ch13`（由 `ex_rust_template.sh` 拷贝） | 7 行，`version = 4`，只有 `hello-rs` 一个包、没有依赖；`cargoLock.lockFile` 要它 |
| [`lab/ch13/fixtures/rust-template/Cargo.toml`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/fixtures/rust-template/Cargo.toml) | `make ch13`（由 `ex_rust_template.sh` 拷贝） | 包名 `hello-rs`，`edition = "2024"` |
| [`lab/ch13/fixtures/rust-template/flake.nix`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/fixtures/rust-template/flake.nix) | `make ch13`（由 `ex_rust_template.sh` 拷贝） | `rustPlatform.buildRustPackage` 加 `mkShell { inputsFrom ...; packages = [ cargo clippy rustfmt ]; }`；`nix build` 成功 |
| [`lab/ch13/fixtures/rust-template/src/main.rs`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/fixtures/rust-template/src/main.rs) | `make ch13`（由 `ex_rust_template.sh` 拷贝） | 打印 `hello from template` |
| [`lab/ch13/fixtures/shells.nix`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/fixtures/shells.nix) | `make ch13`（由 `mkshell_vs_nocc.sh` 使用） | `withCc` 和 `noCc` 两个 shell，同样的 `hello` 和 `jq` |
| [`lab/ch13/inputs_from.nix`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/inputs_from.nix) | `make ch13` | 退出码 0；`firnHelloItselfInShell = false`，`shellHasGreetingFlag = false`；shell 的 `nativeBuildInputs` 是 `gdb-17.2`、`pkg-config-wrapper-0.29.2` |
| [`lab/ch13/mkshell_env.sh`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/mkshell_env.sh) | `make ch13` | 退出码 0；123 个变量、99 个函数；`env -i` 下 `default 92`、`c 84`、`python 63`；`-isystem` 各出现 2 次；`FIRN_GREETING flags: 0` |
| [`lab/ch13/mkshell_vs_nocc.sh`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/mkshell_vs_nocc.sh) | `make ch13` | 退出码 0；`withCc` 415167120 字节、65 个路径，`noCc` 83268840 字节、52 个路径；`mkShell` 独有 14 个路径，`mkShellNoCC` 独有 1 个 |
| [`lab/ch13/print_dev_env.sh`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/print_dev_env.sh) | `make ch13` | 退出码 0；2161 行；首行 `unset shellHook`，末行 `eval "${shellHook:-}"`；99 个函数；`12:    source "$stdenv"/setup` |
| [`lab/ch13/shellhook_order.sh`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/shellhook_order.sh) | `make ch13` | 退出码 0；`hook: b`、`hook: a`、`hook: combined (own)`，然后才是 `--command` 的输出 |
| [`lab/ch13/template_c.sh`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/template_c.sh) | `make ch13` | 退出码 0；`init` 拷出 5 个文件；`nix build` 和 `nix run` 都打印 `hello from template` |
| [`lab/ch13/template_python.sh`](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/template_python.sh) | `make ch13` | 退出码 0；`flake new` 拷出 5 个文件；`nix run` 打印 `hello from template`；Python 3.14.7、ruff 0.16.3、pytest 9.1.1 |
| [`templates/c/.envrc`](https://github.com/bfmhno3/firn/blob/ch13/templates/c/.envrc) | `make ch13`（由 `template_c.sh` 拷出） | 一行 `use flake` |
| [`templates/c/.gitignore`](https://github.com/bfmhno3/firn/blob/ch13/templates/c/.gitignore) | `make ch13`（由 `template_c.sh` 拷出） | 3 行：`.direnv/`、`result`、`hello-c` |
| [`templates/c/Makefile`](https://github.com/bfmhno3/firn/blob/ch13/templates/c/Makefile) | `make ch13`（由 `template_c.sh` 的 `nix build` 调用） | 构建成功；`CFLAGS ?= -g -O2 -Wall -Wextra`，手敲的 `make` 回显 `gcc -g -O2 -Wall -Wextra -o hello-c src/main.c`，gdb 能给出 `main` 的行号 |
| [`templates/c/flake.nix`](https://github.com/bfmhno3/firn/blob/ch13/templates/c/flake.nix) | `make ch13`（由 `template_c.sh` 的 `nix build` 构建） | `nix build` 出 `hello-c-0.1.0`；`nix develop` 的 `CC` 是 `gcc` |
| [`templates/c/src/main.c`](https://github.com/bfmhno3/firn/blob/ch13/templates/c/src/main.c) | `make ch13`（由 `template_c.sh` 编译） | 运行打印 `hello from template` |
| [`templates/python/.envrc`](https://github.com/bfmhno3/firn/blob/ch13/templates/python/.envrc) | `make ch13`（由 `template_python.sh` 拷出） | 一行 `use flake` |
| [`templates/python/.gitignore`](https://github.com/bfmhno3/firn/blob/ch13/templates/python/.gitignore) | `make ch13`（由 `template_python.sh` 拷出） | 4 行：`.direnv/`、`result`、`__pycache__/`、`.venv/` |
| [`templates/python/flake.nix`](https://github.com/bfmhno3/firn/blob/ch13/templates/python/flake.nix) | `make ch13`（由 `template_python.sh` 的 `nix run` 构建） | `buildPythonApplication` 构建成功；`nix develop` 里有 `python3`、`ruff`、`pytest`，但 shell 没有提供 `uv` 和 `pip` |
| [`templates/python/pyproject.toml`](https://github.com/bfmhno3/firn/blob/ch13/templates/python/pyproject.toml) | `make ch13`（由 `template_python.sh` 的 `nix run` 读取） | 16 行；hatchling 构建 wheel；`[project.scripts]` 里 `hello = "hello:main"` |
| [`templates/python/src/hello/__init__.py`](https://github.com/bfmhno3/firn/blob/ch13/templates/python/src/hello/__init__.py) | `make ch13`（由 `template_python.sh` 的 `nix run` 运行） | `main()` 打印 `hello from template` |

## 练习

**1.** 给 Firn 加第三个模板，Rust 的：`nix flake init -t` 之后 `nix build` 能出一个打印 `hello from template` 的二进制，`nix develop` 里有 `cargo`。不要改 Firn 的 `templates` 输出，在一个临时副本里做。

<details>
<summary>参考答案</summary>

答案是 `lab/ch13/ex_rust_template.sh`（[链接](https://github.com/bfmhno3/firn/blob/ch13/lab/ch13/ex_rust_template.sh)）。它在 `LAB_TMP` 里建一个只有 `templates.rust` 的小 flake，模板目录是 `lab/ch13/fixtures/rust-template/`。关键是包的那一半：

```nix
          default = pkgs.rustPlatform.buildRustPackage {
            pname = "hello-rs";
            version = "0.1.0";

            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [
                ./Cargo.toml
                ./Cargo.lock
                ./src
              ];
            };

            cargoLock.lockFile = ./Cargo.lock;

            meta = {
              description = "Prints a greeting from a template";
              mainProgram = "hello-rs";
            };
          };
```

`cargoLock.lockFile = ./Cargo.lock` 要求模板里带一个 `Cargo.lock`；这里的 `Cargo.lock` 没有任何依赖，所以不需要 `outputHashes` 之类的东西。`fileset` 里要把 `Cargo.lock` 列出来，否则它进不了源码。输出：

```text
$ cat out/ch13/ex_rust_template.stdout
== a temporary flake with a third template
"Rust project: buildRustPackage and a cargo dev shell"

== nix flake init -t tpl#rust
./.envrc
./Cargo.lock
./Cargo.toml
./flake.nix
./src/main.rs

== nix build
volatile: /nix/store/qljwk2hwzclhix4f7yslrj6w8nqrpybi-hello-rs-0.1.0
hello from template

== nix develop
volatile: cargo 1.97.0 (c980f4866 2026-06-30)
volatile: rustfmt 1.9.0
```

`devShell` 是同一个模式：`inputsFrom = [ self.packages.${system}.default ]`，`packages = [ cargo clippy rustfmt ]`。`cargo 1.97.0` 和 `rustfmt 1.9.0` 是 shell 里的版本。

</details>

**2.** Python 模板的开发 shell 里 `import hello` 失败。不改 `package`，只改 `devShell`，让它成功。

<details>
<summary>参考答案</summary>

最小的改法是在 `devShells` 里加一个 `shellHook`，把项目的 `src/` 放进 `PYTHONPATH`。`''${` 是 Nix 里写出字面量 `${` 的方式，让 bash 去展开：

```nix
          default = pkgs.mkShellNoCC {
            inputsFrom = [ self.packages.${system}.default ];
            packages = with pkgs; [
              ruff
              python3Packages.pytest
            ];
            shellHook = ''
              export PYTHONPATH="$PWD/src''${PYTHONPATH:+:$PYTHONPATH}"
            '';
          };
```

这是我在 `nix flake new` 出来的项目里改的，改后整个 `flake.nix` 通过了 `nixfmt --check`。验证：

```text
$ nix develop --command python3 -c 'import hello; hello.main()'
hello from template
```

（手敲，不在 `lab/ch13/` 里）

输出里 `nix` 会多打一行 `building ... nix-shell-env.drv`，我丢掉了 stderr。这个改法只在 `$PWD` 是项目根目录时对，在子目录里进 shell 就错了，更稳的办法是用 `git rev-parse --show-toplevel`，或者装一个可编辑的包。我没有试这两个。

</details>

**3.** 在一个 nix-direnv 管理的项目里，什么会让缓存失效？`touch flake.nix` 之后再进一次目录，会看到什么？

<details>
<summary>参考答案</summary>

答案在 nix-direnv 的源码里（第 344 到 350 行：被监视的文件比 `profile_rc` 新），也可以直接观察。用 `direnv_project.sh` 搭同一个项目，让 `direnv` 的消息出来（实验里它们被 `>/dev/null 2>&1` 丢掉了）：

```bash
export FIRN_ROOT="${PWD}"
LAB_TMP="$(mktemp -d)"
export LAB_TMP
source lab/ch13/fixtures/direnv_project.sh
direnv_project::setup with
direnv exec . true
direnv exec . true
touch flake.nix
direnv exec . true
```

`direnv_project::setup` 结束时已经 `cd` 进了项目目录。三次 `direnv exec` 的输出（临时目录我换成了 `$LAB_TMP`）：

```text
$ direnv exec . true
[0mdirenv: loading $LAB_TMP/proj/.envrc
[0mdirenv: using flake
[0mdirenv: nix-direnv: cache invalidated: profile ($LAB_TMP/proj/.direnv/flake-profile-a5d5b61aa8a61b7d9d765e1daf971a9a578f1cfa) does not exist
[0mdirenv: nix-direnv: cache invalidated: profile_rc ($LAB_TMP/proj/.direnv/flake-profile-a5d5b61aa8a61b7d9d765e1daf971a9a578f1cfa.rc) does not exist
[0mdirenv: nix-direnv: cache invalidated: files newer than cache:
nix-direnv: $LAB_TMP/proj/.envrc
$LAB_TMP/proj/flake.nix
$LAB_TMP/proj/flake.lock
[0mdirenv: nix-direnv: Renewed cache
$ direnv exec . true
[0mdirenv: loading $LAB_TMP/proj/.envrc
[0mdirenv: using flake
[0mdirenv: nix-direnv: Using cached dev shell
$ touch flake.nix; direnv exec . true
[0mdirenv: loading $LAB_TMP/proj/.envrc
[0mdirenv: using flake
[0mdirenv: nix-direnv: cache invalidated: files newer than cache:
nix-direnv: $LAB_TMP/proj/flake.nix
[0mdirenv: nix-direnv: Renewed cache
```

（手敲，不在 `lab/ch13/` 里）

第二、三条命令前的 `$` 行是我加的标记，不是 `direnv` 打印的，`touch` 前我 `sleep 1` 了一下，避免和上一次写缓存的时间戳相同。第一次什么都没有，缓存因为 `profile` 不存在、`profile_rc` 不存在、`.envrc`、`flake.nix` 和 `flake.lock` 比缓存新而失效，打印 `Renewed cache`；第二次是 `Using cached dev shell`；`touch flake.nix` 之后只有 `flake.nix` 比缓存新，缓存失效，重新求值，又是 `Renewed cache`。注意只有 `flake.nix` 一项：没有改 `flake.lock` 和 `.envrc`，它们不触发。

</details>

**4.** 把 `hooks.nix` 里 `combined` 的 `inputsFrom` 从 `[ a b ]` 改成 `[ b a ]`，进入 shell 后三个 hook 的顺序是什么？不用改文件。

<details>
<summary>参考答案</summary>

`mkShell` 把 `inputsFrom` 反过来，所以是 `a`、`b`，再是自己的。我手敲验证：

```text
$ nix develop --impure --expr '
  let
    pkgs = import ./nix/pkgs.nix { };
    a = pkgs.mkShellNoCC { shellHook = "echo hook-a"; };
    b = pkgs.mkShellNoCC { shellHook = "echo hook-b"; };
  in
  pkgs.mkShellNoCC {
    inputsFrom = [ b a ];
    shellHook = "echo hook-own";
  }
' --command true 2>/dev/null
hook-a
hook-b
hook-own
```

（手敲，不在 `lab/ch13/` 里）

`inputsFrom = [ b a ]` 给出 `hook-a`、`hook-b`、`hook-own`，和 `[ a b ]` 给出 `b`、`a`、`own` 一样，都是 `inputsFrom` 的反序。

</details>

## 下一篇

[第 14 篇：给 nixpkgs 提 PR：by-name、nixpkgs-review 与 channel](/posts/nix-by-firn-14-contributing-to-nixpkgs/)要把 Cairn 按 nixpkgs 自己的写法重写一遍，放进一份 nixpkgs 工作树，用 `nixpkgs-review`、`nixpkgs-vet` 一类工具检查，再去量合并之后它要等多久才会出现在 channel 里。这一篇里模板写的是 `nixos-unstable`，Firn 钉的却是 2026-08-23 的一个固定 rev；一个 rev 从合并到进 channel 要走多久，我还没有量过。我猜最麻烦的不是写包，是等 channel 前进。
