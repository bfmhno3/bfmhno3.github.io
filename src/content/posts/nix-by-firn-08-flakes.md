---
title: "flake：inputs、outputs、flake.lock 与纯求值"
commentId: "post:nix-by-firn-08-flakes"
published: "2026-11-05 16:00:00 +08:00"
description: "用 Firn 从零学 Nix 第 8 篇：我用 Nix 2.34.9 重排了 Firn 的 flake.nix，加上 apps 和 formatter，再用 16 个实验拆开 flake.lock、git 跟踪规则、纯求值和 eval cache：同一条 nix path-info --derivation，冷缓存 481 ms，热缓存 52 ms，快了 9.2 倍。"
category: Tutorial
tags:
  - Nix
  - NixOS
  - Firn
  - flake
  - 可复现性
series: "用 Firn 从零学 Nix"
seriesOrder: 8
draft: false
comment: true
slug: nix-by-firn-08-flakes
---

前七章里我每次都敲 `nix develop`，每次都先 `git add -A`，`flake.nix` 和 `flake.lock` 也一直躺在仓库根目录，但要是有人问我“flake 比 `nix-build` 多了什么”，我只能答出一句“有个锁文件”。这一篇我先把 Firn 的 `flake.nix` 整理了一遍（`forAllSystems`、每个输出一行注释，再加上 `apps` 和 `formatter`），然后写了 16 个实验去拆它：锁文件里到底锁了什么，一个没 `git add` 的文件为什么“不存在”，纯求值到底禁了哪些东西，以及一个我完全没料到的数字：同一个 flake，同一条命令，第二次跑居然快了 9 倍多。先看 Firn 现在对外暴露了哪些输出，下面是 `flake_show.sh` 打印的 `nix flake show --json | jq 'keys'`：

```text
$ grep -A8 "jq 'keys'" out/ch08/flake_show.stdout
== nix flake show --json | jq 'keys'
[
  "apps",
  "checks",
  "devShells",
  "formatter",
  "legacyPackages",
  "lib"
]
```

六个顶层输出，其中 `apps` 和 `formatter` 是这一章新加的，`legacyPackages` 是上一章的 mini 包集。这六个名字不是我起的，它们是一份“约定俗成的表”里的名字，`nix` 命令靠它们找东西。这一篇的主线就是这张表，和围着它的三样东西：把依赖钉死的 `flake.lock`，把求值关进笼子的纯求值模式，以及决定哪些文件算“flake 的一部分”的 git 规则。

> [!NOTE] 本篇检查点
> 这一篇结束时，Firn 仓库的标签 `ch08` 里：`flake.nix` 重排成 144 行（新增 `pkgsFor`，每个输出前一行注释），新增 `apps.<system>.mini-hello`(`type = "app"`, `program`, `meta.description`) 和 `formatter.<system>` (`pkgs.nixfmt-tree`)；`README.md` 多了 “Flake outputs” 一节；`lab/ch08/` 下有 16 个实验和 2 个 fixture。`make ch08` 通过，其中 `untracked_invisible_fail.sh` 和 `pure_eval_fail.sh` 按约定以退出码 1 结束；`make lint` 和 `make check` 干净。这一章的 `flake.nix` 还会变：之后每个加包、加模块的章节都会往里加输出。
> 涉及的 Nix 特性：`inputs`、`outputs`、`self`、`flake.lock`、`nix flake lock` 与 `nix flake update`、`follows`、`flake = false`、flakeref 语法、registry、git 跟踪规则、纯求值与 `--impure`、eval cache、`nixConfig`。
> 前置：[第 7 篇：从零写 stdenv，再拆开 nixpkgs 的 stdenv](/posts/nix-by-firn-07-stdenv-from-scratch/)。第 1 篇里 `git add -A` 那条规则和 `pure-eval` 那个我没读源码的猜测，这一篇都会交代。

环境照旧：NixOS 26.05，Nix 2.34.9，锁定的 nixpkgs 是 `56c02bc00adcf003215cc4bd996d6efaf4cff188`。引用 nixpkgs 源码时行号都是这个提交上的，引用 Nix 源码时用的是 2.34.9 标签的行号。本篇所有 `out/ch08/` 的输出来自 `env -u CI make ch08`（我的 shell 里设了 `CI=true`；这一章没有 `_host` 实验，所以设不设输出一样）。

## 一点历史：RFC 49、Nix 2.4 和“实验性”

先把历史说清楚，因为这个功能的“实验性”会在后面反复出现。

flake 最早的正式提案是 [RFC 49](https://github.com/NixOS/rfcs/pull/49)，标题是 “[RFC 0049] Flakes”。它的摘要是一句分了三段的话，正好是后面每一节的主题：“Flakes allow hermetic, reproducible evaluation of multi-repository Nix projects; impose a discoverable, standard structure on Nix projects; and replace previous mechanisms such as Nix channels and the Nix search path.” 拆开就是三件事：

- 可复现的依赖（钉死版本）：`flake.lock` 那几节；
- 封闭的求值 (hermetic evaluation)：纯求值那一节；
- 标准的结构：输出的 schema 那几节。

这个 PR 在 GitHub 上现在的状态是 closed，没有合并；我没有去考证它为什么这样收场，也不打算猜。我能确认的是，nixpkgs 自己的 `flake.nix` 在锁定的提交上还保留着对它的引用：[第 1 到 2 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/flake.nix#L1-L2)写着 `# Experimental flake interface to Nixpkgs.` 和 `# See https://github.com/NixOS/rfcs/pull/49 for details.`。

flake 真正进入 Nix 是在 2.4。[Nix 手册里的 2.4 发布说明](https://nix.dev/manual/nix/2.34/release-notes/rl-2.4)（发布日期 2021-11-01）写道：“Flakes are currently marked as experimental.” 第 1 篇的历史表里已经有这一行。到了 2.34.9，[实验性功能一页](https://nix.dev/manual/nix/2.34/development/experimental-features)里仍然列着 `flakes` (“Enable flakes. See the manual entry for `nix flake` for details.”)，[`nix flake` 的手册页](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-flake)顶上也还挂着“experimental, interface subject to change”的警告（那条警告链接的是 `nix-command` 这个实验性功能）。所以截至这一篇的 Nix 版本，flake 在上游手册里的身份是：自 2.4 起，整整五年，仍是实验性功能。第 1 篇里我提到的 `/etc/nix/nix.conf`，就靠 `experimental-features = nix-command flakes` 这一行才让本系列的每条命令能跑起来。

这个别扭，一个“实验性”的东西同时是我的日常，我会留到后面“我对 flake 不满意的三件事”一节再展开。先把它拆开。

## flake.nix 的四块

一个 flake 就是一棵目录树，根目录有 `flake.nix`。[手册](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-flake#flake-format)列的属性有四个：`description`、`inputs`、`outputs`、`nixConfig`。Firn 的 `flake.nix` 开头是这样的：

```nix
# flake.nix 第 1 到 15 行
{
  description = "firn: companion code for the series 用 Firn 从零学 Nix";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      # 每个系统一份 pkgs；第 10 章起它会带上 Firn 自己的 overlay。
      pkgsFor = system: nixpkgs.legacyPackages.${system};
      # ...
```

`description` 是一行说明，`nix flake metadata` 会打印它。`inputs` 是依赖，一个属性集：名字对应 flakeref（下面有一节专门讲），`inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable"` 的意思是“我依赖 GitHub 上 NixOS/nixpkgs 仓库的 `nixos-unstable` 分支”。注意这时候还没有版本：分支是会动的。把它变成确定的提交，是 `flake.lock` 的事。

`outputs` 是一个函数。[手册](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-flake#flake-format)的说法是：它接受一个属性集，里面是每个输入的输出，键是输入的名字，返回这个 flake 提供的值。Firn 里写的 `{ nixpkgs, ... }:` 就是从这个属性集里取出 `nixpkgs`；`...` 吃掉其他的（比如 `self`，下一节）。

这个 `nixpkgs` 是什么？是 nixpkgs 那个 flake 的**输出**，加上几个元数据。所以 `nixpkgs.lib` 是 nixpkgs 的 `outputs` 返回的 `lib`，`nixpkgs.legacyPackages.${system}` 是它返回的 `legacyPackages` 在某个系统上的那一份，也就是我们前几章一直在用的整个 nixpkgs。它同时还带着 `outPath`（源码树在 store 里的路径），手册的说法是，这样这个属性集可以像路径一样传给 `import`，`import nixpkgs { ... }` 这种写法就是这么成立的。

最后一个 `nixConfig`，是一组 `nix.conf` 选项，评估这个 flake 时生效。因为涉及信任，放到后面的小节，和第 20 篇的 CI 一起讲。

Firn 的 `nixpkgs.lib.genAttrs systems` 是整篇里最“样板”的一行。`genAttrs` 的文档例子在 nixpkgs 里：[`lib/attrsets.nix` 的 1344 到 1347 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/attrsets.nix#L1344-L1347)，`genAttrs [ "foo" "bar" ] (name: "x_" + name)` 得到 `{ foo = "x_foo"; bar = "x_bar"; }`。所以 `forAllSystems f` 就是“对 `systems` 里的每个名字调用 `f`，把结果放进以名字为键的属性集”。为什么每个输出都要按系统展开一遍，会在“纯求值”那一节有答案。

## self：flake 对自己的描述

`outputs` 的参数里还有一个特殊的名字 `self`：这个 flake 自己的输出加元数据。[手册](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-flake#flake-format)列的元数据有 `outPath`、`rev`、`revCount`、`lastModifiedDate`、`lastModified`、`narHash`。哪些存在，取决于这个 flake 是怎么被取来的。`lab/ch08/self_attrs.sh` 在 `LAB_TMP` 里建了一个只有一个文件的 git 仓库，固定 commit 日期，三种方式各取一次。它的 `flake.nix`：

```nix
{
  outputs =
    { self }:
    {
      info = {
        rev = self.rev or null;
        dirtyRev = self.dirtyRev or null;
        lastModifiedDate = self.lastModifiedDate;
        lastModified = self.lastModified;
        selfOutPath = self.outPath;
      };
    };
}
```

这里 `rev` 和 `dirtyRev` 用 `self.rev or null`，因为不存在就会报“attribute missing”。三次求值是：干净的 git 树、改了 `flake.nix` 但没提交的 git 树、同一个目录当成 `path:` flake。输出（`selfOutPath` 里的哈希被脚本换成了 `<hash>`，因为每次编辑内容都变）：

```text
$ cat out/ch08/self_attrs.stdout
== clean git tree
{"dirtyRev":null,"lastModified":1767323045,"lastModifiedDate":"20260102030405","rev":"16ecad9cf5ea82a93c2c96c7ca66b2116a60fbd3","selfOutPath":"/nix/store/<hash>-source"}

== after editing flake.nix (dirty tree)
{"dirtyRev":"16ecad9cf5ea82a93c2c96c7ca66b2116a60fbd3-dirty","lastModified":1767323045,"lastModifiedDate":"20260102030405","rev":null,"selfOutPath":"/nix/store/<hash>-source"}

== the same directory as a path: flake (git is ignored)
{"dirtyRev":null,"lastModified":1793868664,"lastModifiedDate":"20261105085104","rev":null,"selfOutPath":"/nix/store/<hash>-source"}
```

三行里值得停下来看的有四点。第一，干净的树有 `rev`，脏的树没有 `rev`，换成了 `dirtyRev`：就是 `rev` 后面加 `-dirty`，这是 [`git.cc` 的 1044 行](https://github.com/NixOS/nix/blob/2.34.9/src/libfetchers/git.cc#L1044)拼出来的。所以凡是写 `self.rev` 来给程序打版本号的 flake，都得准备一个 `or` 兜底，否则你在改到一半的目录里 `nix build` 会直接求值失败。第二，`lastModified` 前两行都是 `1767323045`，也就是我设的 `GIT_COMMITTER_DATE` 2026-01-02T03:04:05Z，`lastModifiedDate` 是同一个时间换成 `%Y%m%d%H%M%S` 的格式（和手册描述的格式一致）；脏的树不改它，它还是 HEAD 提交的时间。第三，第三行的 `path:` 版本没有 `rev` 也没有 `dirtyRev`：`path:` 不看 git，它的 `lastModified` 是 `1793868664`，即 2026-11-05T08:51:04Z，和我跑这个实验的时刻吻合，我猜是目录里文件最近一次的修改时间（手册只说 tarball 是“the most recent timestamp of any file”，没说 `path:`，所以这是我的推测）。第四，三种情况下 `selfOutPath` 都是 `/nix/store/<hash>-source`：不管你的目录叫什么，flake 的源码在 store 里都叫 `source`，所以 flake 里没法靠目录名知道项目名。后面“只有被 git 跟踪的文件”那一节会回到这个 `source`。

`self` 还能干一件事，就是让 flake 的输出互相引用，这样不用重复写：`self.packages.${system}.default` 在 `apps` 里引用 `packages`。Firn 这一章还没有 `packages`（第 10 章才加），所以现在 `self` 只出现在实验里。

## outputs 的约定：一张表

`outputs` 返回的是一个任意的属性集，手册说得很直白：“The attributes can have arbitrary values; however, various `nix` subcommands require specific attributes to have a specific value”。所以“schema”不是语言规定的，是 `nix` 命令各自的约定。[`nix flake check` 的手册页](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-flake-check)把能被检查的列出来了，[NixOS Wiki 的 Flakes 一页](https://wiki.nixos.org/wiki/Flakes)有一份带注释的 schema。我把它们和 Firn 对照成一张表（`<sys>` 是 `x86_64-linux` 这样的系统名，`<n>` 是任意名字）：

| 输出 | 形状 | 谁读它 | Firn |
| --- | --- | --- | --- |
| `packages.<sys>.<n>` | derivation；`default` 是不写名字时的默认 | `nix build .#<n>`、`nix build` | 第 10 章 |
| `apps.<sys>.<n>` | `{ type = "app"; program = "/nix/store/..."; meta.description = "..."; }` | `nix run .#<n>` | `mini-hello` |
| `devShells.<sys>.<n>` | derivation（通常是 `mkShell`） | `nix develop` | `default` |
| `checks.<sys>.<n>` | derivation | `nix flake check` 构建它们 | 4 项 |
| `formatter.<sys>` | derivation，有可执行的主程序 | `nix fmt` | `nixfmt-tree` |
| `overlays.<n>` | `final: prev: { ... }` | 别的 flake 或 `nixpkgs.overlays` | 第 10 章 |
| `nixosModules.<n>` | NixOS 模块 | 别人的 NixOS 配置 `imports` | 第 16 章 |
| `nixosConfigurations.<n>` | `nixosSystem` 的结果 | `nixos-rebuild --flake` | 第 16 章 |
| `templates.<n>` | `{ path = ...; description = ...; }` | `nix flake init -t` | 第 13 章 |
| `legacyPackages.<sys>` | 嵌套的包集（不要求拍平） | `nix build .#<attr>` 的备选 | `mini` |
| `lib` | 任意值 | 别的 flake | Firn 自己的库 |

这张表里有三个规则要单独记。

**第一，哪些带系统层。** `packages`、`apps`、`devShells`、`checks`、`formatter`、`legacyPackages` 的第一层是系统名；`overlays`、`nixosModules`、`nixosConfigurations`、`templates` 和 `lib` 没有。道理很简单：前一类是“构建出来的东西”，它们属于某个平台；后一类是“代码”（一个 overlay 是个函数，一个模块是个函数），平台在它被用起来的时候才确定。

**第二，`nix` 命令怎么按名字找。** `nix build .#hello` 里的 `hello` 要变成一个完整的属性路径，规则在源码里：[`installables.cc` 的 249 到 257 行](https://github.com/NixOS/nix/blob/2.34.9/src/libcmd/installables.cc#L249-L257)，默认前缀是 `packages.<当前系统>.`，再退一步是 `legacyPackages.<当前系统>.`（源码里的注释把后者叫作“a temporary hack until Nixpkgs is properly converted”）。[`nix run` 在前面多放了 `apps.<系统>.`](https://github.com/NixOS/nix/blob/2.34.9/src/nix/run.cc#L151-L157)，[`nix develop` 多放了 `devShells.<系统>.`](https://github.com/NixOS/nix/blob/2.34.9/src/nix/develop.cc#L469-L474)。这就是为什么 `nix build .#mini.hello` 这样的写法能成立：`packages.x86_64-linux.mini.hello` 不存在，退到 `legacyPackages.x86_64-linux.mini.hello`，它存在。

**第三，`nix flake check` 认得的有哪些，认不得的怎么办。** [`flake.cc` 的 425 到 464 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/flake.cc#L425-L464)是 `apps` 的检查：必须有 `type` 和 `program`，`meta` 缺了会警告，除了这三个键再多一个就抛错 (`app '%s' has unsupported attribute '%s'`)。检查的末尾，[770 到 779 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/flake.cc#L770-L779)，对不认识的输出名字发 `unknown flake output '%s'` 警告，但有一份白名单是“已知但不检查”的，里面有 `lib`、`homeConfigurations`、`homeModules`、`flakeModules` 这类社区约定的名字。所以 Firn 的 `lib` 不会被警告。

`legacyPackages` 的“legacy”经常被误读，nixpkgs 自己的 `flake.nix` 在[205 到 223 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/flake.nix#L205-L223)解释了：它是 `packages` 的替代名字，原因是 `packages` 会让 `nix flake show nixpkgs` “unusably slow”，因为 CLI 得判断每个属性是包还是子包集；换成 `legacyPackages`，CLI 只显示 `omitted`。这条解释马上就会在下面的 `nix flake show` 输出里兑现。

## 重排 Firn 的 flake.nix

这一章的 `flake.nix` 改动不大。`git diff ch07 ch08 -- flake.nix` 里有三类：加 `pkgsFor`（每个系统一份 pkgs，原来散在三处的 `nixpkgs.legacyPackages.${system}` 都换成它）、给每个输出前面加一行注释、加 `apps` 和 `formatter`。输出部分现在是这样的（第 116 到 144 行，原样）：

```nix
    # flake.nix 第 116 到 144 行
    in
    {
      # Firn 自己的库，不依赖 nixpkgs。
      lib = firnLib;

      # nix develop 进入的开发环境。
      devShells = nixpkgs.lib.mapAttrs (_: devShell: { default = devShell; }) devShells;

      # nix flake check 构建的东西。
      checks = forAllSystems checksFor;

      # 不属于 packages 的包集；mini 是第 7 章的从零包集。
      legacyPackages = forAllSystems (system: {
        mini = miniFor system;
      });

      # nix run .#mini-hello：运行 mini 的 hello。
      apps = forAllSystems (system: {
        mini-hello = {
          type = "app";
          program = "${(miniFor system).hello}/bin/hello";
          meta.description = "Print the greeting of the mini package set";
        };
      });

      # nix fmt：格式化整个仓库。
      formatter = forAllSystems (system: (pkgsFor system).nixfmt-tree);
    };
}
```

`apps.<sys>.mini-hello` 的三个字段，和上面检查代码要求的完全对应：`type = "app"`；`program` 是一个 store 路径（这里是 mini 的 `hello` 的 `bin/hello`，字符串插值会让它依赖 `hello`；[`app.cc` 的 143 到 145 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/app.cc#L143-L145)在 `nix run` 时还会检查它确实在 store 里，否则报 `app program '%s' is not in the Nix store`）；`meta.description` 是可选的，缺了只是警告，`nix flake show` 会把它打在后面（下一节的输出里能看到）。`nix run .#mini-hello` 的结果在 `lab/ch08/run_app.sh` 里：

```text
$ cat out/ch08/run_app.stdout
== nix run .#mini-hello
Hello from mini

== formatter name
nixfmt-tree-2.5.0
```

`Hello from mini` 就是第 7 篇里 mini 的 `hello` 打印的那句话。`formatter` 是一个 derivation，`nix fmt` 是 `nix formatter run` 的别名（[`formatter.cc` 的 162 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/formatter.cc#L162)），它默认找 `formatter.<当前系统>`（[39 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/formatter.cc#L39)）；Nix 手册用来举例的正好也是 `nixfmt-tree`。`nixfmt-tree-2.5.0` 是锁定的 nixpkgs 里的版本。README 里的 “Flake outputs” 一节把现有的输出也列了一遍，供读仓库的人用（`README.md` 的 61 到 72 行，原样）：

```markdown
## Flake outputs

`nix flake show` lists them; every output has a comment in `flake.nix`. `<sys>` is `x86_64-linux` or `aarch64-linux`.

| Output | Contents |
| --- | --- |
| `lib` | Firn's own library (no nixpkgs) |
| `devShells.<sys>.default` | the dev shell: `nix develop` |
| `checks.<sys>.{dev-shell,lib-tests,readme-table,mini-site}` | `nix flake check` |
| `legacyPackages.<sys>.mini` | the from-scratch package set |
| `apps.<sys>.mini-hello` | `nix run .#mini-hello` prints the mini greeting |
| `formatter.<sys>` | `nixfmt-tree`: `nix fmt` |
```

这一节我把它和上面那张 schema 表分开，是因为它描述的是 Firn 现在有什么，那张表描述的是 Nix 认得什么。

## nix flake show：把输出树打出来

`lab/ch08/flake_show.sh` 做的事很朴素，三条命令：

```bash
echo '== nix flake show'
nix flake show "${FIRN_ROOT}"

echo
echo "== nix flake show --json | jq 'keys'"
nix flake show --json "${FIRN_ROOT}" | jq 'keys'
```

第一条的输出（`jq 'keys'` 那段已经在文章开头出现过）：

```text
$ sed -n '/^== nix flake show$/,/^$/p' out/ch08/flake_show.stdout
== nix flake show
git+file:///home/bfmhno3/Projects/firn?ref=refs/heads/main&rev=bebc41bde7786a147b624d5af6ac5d27a122b777
├───apps
│   ├───aarch64-linux
│   │   └───mini-hello: app: Print the greeting of the mini package set
│   └───x86_64-linux
│       └───mini-hello: app: Print the greeting of the mini package set
├───checks
│   ├───aarch64-linux
│   │   ├───dev-shell omitted (use '--all-systems' to show)
│   │   ├───lib-tests omitted (use '--all-systems' to show)
│   │   ├───mini-site omitted (use '--all-systems' to show)
│   │   └───readme-table omitted (use '--all-systems' to show)
│   └───x86_64-linux
│       ├───dev-shell: derivation 'nix-shell'
│       ├───lib-tests: derivation 'firn-lib-tests'
│       ├───mini-site: derivation 'firn-mini-site'
│       └───readme-table: derivation 'firn-readme-table'
├───devShells
│   ├───aarch64-linux
│   │   └───default omitted (use '--all-systems' to show)
│   └───x86_64-linux
│       └───default: development environment 'nix-shell'
├───formatter
│   ├───aarch64-linux omitted (use '--all-systems' to show)
│   └───x86_64-linux: package 'nixfmt-tree-2.5.0'
├───legacyPackages
│   ├───aarch64-linux omitted (use '--legacy' to show)
│   └───x86_64-linux omitted (use '--legacy' to show)
└───lib: unknown
```

这棵树里有几处值得读。

**第一行带着提交的哈希，所以它每个提交都不一样。** `rev=bebc41b...` 是 `ch08` 标签指向的那个提交；你的 `~/firn` 如果是自己的提交，这一行的路径和 `rev` 都会不同，其余的树应当一样。它也解释了开头那个 `git+file://`：Firn 的目录在 git 仓库里，手册说这种路径形式的 flakeref“会被当作 `git+file:` URL”，所以 `nix flake show /home/.../firn` 就等于 `git+file:///home/.../firn`。

**`aarch64-linux` 被标成 `omitted`。** 我的机器是 `x86_64-linux`，`nix flake show` 默认只展开当前系统，别的系统打印 `omitted (use '--all-systems' to show)`（[`flake.cc` 的 1321 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/flake.cc#L1321)就是这句话）。这样做的原因我猜是省求值：每个系统的每个输出都得求到能判断它是不是 derivation。

**`legacyPackages` 整个被 `omitted`，提示是 `--legacy`。** 这是前面“outputs 的约定”一节里 nixpkgs 注释说的那件事的实物：CLI 看到 `legacyPackages` 就不展开（[`flake.cc` 的 1365 到 1373 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/flake.cc#L1365-L1373)）。所以你在这里看不到 mini 的任何一个包，要看得加 `--legacy`。顺带一提，Firn 的 `mini` 是个只有五个包的小集合，也被一视同仁地省略了。

**`lib: unknown`。** `nix flake show` 对它不认识的输出，打印类型 `unknown`（[1447 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/flake.cc#L1447)）。这和 `nix flake check` 的白名单是两回事：`lib` 在 `check` 里是“已知但不检查”，在 `show` 里没有类型。

**`apps` 的行尾是 `meta.description`。** `mini-hello: app: Print the greeting of the mini package set`，冒号后面的 `app` 是类型，再后面就是我在 `flake.nix` 里写的那句话。`--json` 的版本把这两个字段拆开了，脚本最后一段把它打出来：

```text
$ sed -n '/^== apps/,$p' out/ch08/flake_show.stdout
== apps.x86_64-linux
{
  "mini-hello": {
    "description": "Print the greeting of the mini package set",
    "type": "app"
  }
}
```

`checks` 下面四项里的 `dev-shell` 是上一章之前就有的；`devShells` 的描述是 `development environment 'nix-shell'`，因为 `mkShell` 造出来的 derivation 的名字就是 `nix-shell`。

## flake.lock：锁的是什么

`flake.nix` 里写 `nixos-unstable`，就像菜谱上写“一袋面粉”：哪个牌子、哪一天的货，你不知道。`flake.lock` 是采购单：哪家超市的哪个货架 (`rev`)，称出来多重 (`narHash`)。采购单一旦写下来，下次不管超市今天进了什么新货，你拿到的还是那一袋。（这个比喻到 `narHash` 就不够用了：称重单是用来**验货**的，不只是记账。）Rust 读者可以把锁文件对应到 `Cargo.lock`，[Pebble 第 1 篇](/posts/rust-by-pebble-01-first-crate/)里 workspace 共享的就是那一份。

锁文件是一个 UTF-8 JSON，手册的描述是：一张和依赖图同构的图，每个节点（根除外）把“通常没有锁定的输入说明”映射成“锁定的输入说明”。`lab/ch08/lock_anatomy.sh` 用 `jq` 把 Firn 的 `flake.lock` 拆开。关键三段：

```bash
echo "== nodes.nixpkgs.original: what flake.nix asked for"
jq '.nodes.nixpkgs.original' "${lock}"

echo
echo "== nodes.nixpkgs.locked: what was pinned"
jq '.nodes.nixpkgs.locked' "${lock}"

echo
echo "== keys only in locked"
jq -c '(.nodes.nixpkgs.locked | keys) - (.nodes.nixpkgs.original | keys)' \
  "${lock}"
```

输出：

```text
$ cat out/ch08/lock_anatomy.stdout
== top-level keys
["nodes","root","version"]
version: 7

== root
root

== nodes
["nixpkgs","root"]
node count: 2

== nodes.root: the inputs of the top-level flake (name -> node)
{"inputs":{"nixpkgs":"nixpkgs"}}

== nodes.nixpkgs.original: what flake.nix asked for
{
  "owner": "NixOS",
  "ref": "nixos-unstable",
  "repo": "nixpkgs",
  "type": "github"
}

== nodes.nixpkgs.locked: what was pinned
{
  "lastModified": 1787498568,
  "narHash": "sha256-9i/VTdusq/+NM/tz+J1Re+ojkMB8MBf0QshnYfzHz30=",
  "owner": "NixOS",
  "repo": "nixpkgs",
  "rev": "56c02bc00adcf003215cc4bd996d6efaf4cff188",
  "type": "github"
}

== keys only in locked
["lastModified","narHash","rev"]
```

按顺序读：

- 顶层只有三个键：`nodes`、`root`、`version`。`version` 是 7，和手册里的示例锁文件一致。
- `root` 的值是 `"root"`，它**不是**一个固定名字，而是“根节点的标签”。手册的示例里它是 `n1`，节点标签是任意的；Nix 目前给我的 flake 起的名字是 `root`。
- `nodes` 一共 2 个：`root` 和 `nixpkgs`。`root` 没有 `locked` 也没有 `original`：手册解释了，因为根 flake 的提交哈希和内容哈希没法记在锁文件里，改一下锁文件它们就变了。它只有 `inputs`：`{"nixpkgs":"nixpkgs"}`，输入的名字映射到节点标签，这里碰巧同名。
- `original` 是 `flake.nix` 里写的那个东西的属性集形式：`ref` 是分支名 `nixos-unstable`。`locked` 是被钉住的版本：多了 `lastModified`、`narHash`、`rev` 三个键（最后一行是脚本算的差集），同时 `ref` 不见了：锁定之后，分支名不再有用，有用的是 `rev`。
- `narHash` 的作用，手册说得很具体：它让 store 路径可以被算出来，所以输入能从二进制缓存里取，不用重新下载；`lastModified` 这类属性存在，是因为它们“provide information not stored in the store path”。

`flake_metadata.sh` 从另一侧看同一件事：`nix flake metadata --json` 把锁文件和当前取到的信息合在一起报告。核心是这几行：

```bash
json="$(nix flake metadata --json "${FIRN_ROOT}")"
readonly json

echo "== locked nixpkgs"
jq -r '.locks.nodes.nixpkgs.locked
  | "rev:          \(.rev)",
    "narHash:      \(.narHash)",
    "lastModified: \(.lastModified) = \(.lastModified | todate)"' <<<"${json}"
```

```text
$ cat out/ch08/flake_metadata.stdout
== locked nixpkgs
rev:          56c02bc00adcf003215cc4bd996d6efaf4cff188
narHash:      sha256-9i/VTdusq/+NM/tz+J1Re+ojkMB8MBf0QshnYfzHz30=
lastModified: 1787498568 = 2026-08-23T15:22:48Z

== original (what flake.nix asked for)
{"owner":"NixOS","ref":"nixos-unstable","repo":"nixpkgs","type":"github"}

== the keys of the whole report
["description","fingerprint","lastModified","locked","locks","original","originalUrl","path","resolved","resolvedUrl","revCount","revision","url"]
```

这就是整个系列钉死的那一个 nixpkgs：提交 `56c02bc0`，时间戳 `1787498568`，换成日期是 2026-08-23T15:22:48Z（`jq` 的 `todate` 打的是 UTC）。后面 flakeref 一节里 `nix flake metadata` 直接打印的是本机时区的 `08:22:48`，差 7 个小时，因为我这台机器的时区不是上海。报告顶层的 13 个键里，`locks` 就是锁文件本身，`fingerprint` 会在 eval cache 一节里再出现。第 1 篇里的 `nix/pins.nix` 读 `flake.lock` 里的 `nodes.nixpkgs.locked`，让不用 flake 的代码拿到同一份 nixpkgs，读的就是这里的 `rev` 和 `narHash`。

## nix flake lock 与 nix flake update

第一次对一个没有锁文件的 flake 运行 `nix build` 或 `nix develop`，Nix 会自动生成它，stderr 里会出现 `warning: creating lock file`。[手册](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-flake#lock-files)也说，锁文件存在而且是最新的时候，Nix 不会再去看依赖的锁文件。真正要你管的是两个命令：

- `nix flake lock`：“create missing lock file entries”，只补缺的，不动已经有的；
- `nix flake update [输入名...]`：重新锁定，不带参数就是全部输入（手册的说法是“recreate the lock file from scratch”），带名字就只动那几个。

这两个命令的区别，我没有在 Firn 本身上试（那会改我的 `flake.lock`），写了一个离线的小实验：`lab/ch08/flake_update.sh`。它在 `LAB_TMP` 下建一个叶子 flake `c` 和一个依赖它的根 flake（都是 `path:` 输入，不用联网），按顺序做三件事：

```bash
nix flake lock "path:${base}/root"
show_hash 'after first lock:'

echo x >"${base}/c/x"
nix flake lock "path:${base}/root"
show_hash 'c changed, lock again:'

nix flake update c --flake "path:${base}/root"
show_hash 'after flake update c:'
```

`show_hash` 打印锁文件里 `c` 的 `narHash`。第一次锁定后，我往 `c` 里加了一个文件（它的内容变了，`narHash` 理应变），然后再运行一次 `nix flake lock`，最后用 `nix flake update c`：

```text
$ cat out/ch08/flake_update.stdout
after first lock:      sha256-PdalhNbpJqRcoErBhYf2wJI/jhH7wMCCoDJY1+QeFlE=
c changed, lock again: sha256-PdalhNbpJqRcoErBhYf2wJI/jhH7wMCCoDJY1+QeFlE=
after flake update c:  sha256-rriJMpn44arJnC0+RtYaArTN5dFanSUXA9j5bohOiIA=
```

`c` 的内容变了，第二次 `nix flake lock` 之后 `narHash` 一个字符都没动：锁文件里那一项是“已有的”，`lock` 不碰它。只有 `nix flake update c` 才换成了新的哈希。stderr 里一共只有两条警告：第一次锁定时的 `creating lock file`，和 `update` 时的 `updating lock file`；中间那次 `nix flake lock` 什么都没打印。后一条是这样的：

```text
$ sed -n 4,7p out/ch08/flake_update.stderr
warning: updating lock file "/tmp/nix-shell.mdhIs8/firn-lab.vWryh6/update/root/flake.lock":
• Updated input 'c':
    'path:/tmp/nix-shell.mdhIs8/firn-lab.vWryh6/update/c?lastModified=1793868663&narHash=sha256-PdalhNbpJqRcoErBhYf2wJI/jhH7wMCCoDJY1%2BQeFlE%3D' (2026-11-05)
  → 'path:/tmp/nix-shell.mdhIs8/firn-lab.vWryh6/update/c?lastModified=1793868663&narHash=sha256-rriJMpn44arJnC0%2BRtYaArTN5dFanSUXA9j5bohOiIA%3D' (2026-11-05)
```

格式是“旧锁定 → 新锁定”，和手册里 `nix flake update` 的示例一模一样。对 Firn 这种钉着 `nixos-unstable` 的 flake，日常节奏就是：不动它；想升级的时候，`nix flake update nixpkgs`，看这个 `→` 前后差几天，提交锁文件，再跑一遍 `make ch08` 看哪些东西坏了。第 20 篇的 CI 会让一个机器人每周做这件事。

## follows：把重复的依赖合并

锁文件是图，不是列表。这一点在两个依赖共用同一个依赖的时候会变得具体。`lab/ch08/follows.sh` 建了四个离线的 flake：叶子 `c`，中间的 `a` 和 `b`（都依赖 `c`），以及根 flake（依赖 `a`、`b` 和 `c`）。它写了两次根 flake，一次什么都不加，一次加两行 `follows`：

```bash
write_leaves
write_root plain ''
write_root followed '  inputs.a.inputs.c.follows = "c";
  inputs.b.inputs.c.follows = "c";'
```

```text
$ cat out/ch08/follows.stdout
== plain/flake.nix inputs
  inputs.a.url = "path:$BASE/a";
  inputs.b.url = "path:$BASE/b";
  inputs.c.url = "path:$BASE/c";
nodes:  a b c c_2 c_3 root
count:  6
root inputs:     {"a":"a","b":"b","c":"c_3"}
a's inputs:      {"c":"c"}

== followed/flake.nix inputs
  inputs.a.url = "path:$BASE/a";
  inputs.b.url = "path:$BASE/b";
  inputs.c.url = "path:$BASE/c";
  inputs.a.inputs.c.follows = "c";
  inputs.b.inputs.c.follows = "c";
nodes:  a b c root
count:  4
root inputs:     {"a":"a","b":"b","c":"c"}
a's inputs:      {"c":["c"]}
```

没有 `follows`，锁文件里有 6 个节点：`root`、`a`、`b`，加上**三个** `c`：`c`、`c_2`、`c_3`。三个 `c` 内容完全一样（同一个目录），但它们是三个独立的节点：`a` 的 `c` 是一个，`b` 的 `c` 是一个，根自己依赖的 `c` 是第三个（`root inputs` 里 `c` 指向的是 `c_3`，`a` 的 `c` 指向 `c`）。节点的名字 `c_2`、`c_3` 是 Nix 为避免重名自己加的后缀，手册说节点标签是任意的。

加上两行 `follows`，节点变成 4 个：`a.inputs.c` 不再是一个节点，而是 `["c"]`：一个列表，意思是“沿着从根开始的这条输入路径找”，也就是根自己的 `c`。手册对 `follows` 的描述正是这个：值是“`/` 分隔的输入名序列，表示从根 flake 出发要跟随的输入路径”，比如手册的例子 `inputs.nixpkgs.follows = "dwarffs/nixpkgs"`。6 变成 4，被消掉的是两个重复的 `c`。

这个例子里 `c` 是个空 flake，节点多一个不过是 JSON 多几行。真实世界里 `c` 往往是 nixpkgs，我的推测是，三个节点意味着三份对那个 flake 的 `outputs` 调用，如果每一份都去实例化一遍 nixpkgs，求值时间和内存都会成倍增加（这一句是我从“节点就是独立的输入”推出来的，实验里没有量）。手册里有一段反向的提醒：把传递依赖的 `nixpkgs` 消掉“generally not useful”，因为大多数 flake 通过 overlay 或 NixOS 模块提供功能，而它们是被合成进顶层 `nixpkgs` 的，它们自己的 `nixpkgs` 输入通常根本用不到。所以 `follows` 不是“越多越好”，它是在你确实看到锁文件里一个大依赖出现了好几份的时候用的。

还有一种输入连 `flake.nix` 都没有，比如一个只放数据的目录。手册的做法是把它标成 `flake = false`。`lab/ch08/flake_false.sh` 全部用 `path:` flake 离线做这件事。根 flake 把一个目录当输入，用 `builtins.readDir` 列出它，用 `builtins.readFile` 读其中一个文件（脚本里的 heredoc，原样）：

```bash
cat >"${base}/root/flake.nix" <<NIX
{
  inputs.src = {
    url = "path:${base}/src";
    flake = false;
  };
  outputs =
    { src, ... }:
    {
      listing = builtins.readDir src;
      hello = builtins.readFile "\${src}/hello.txt";
    };
}
NIX
```

```text
$ cat out/ch08/flake_false.stdout
== nodes.src in flake.lock
{
  "flake": false,
  "locked": {
    "path": "/tmp/nix-shell.mdhIs8/firn-lab.OnlhYU/flakefalse/src",
    "type": "path"
  },
  "original": {
    "path": "/tmp/nix-shell.mdhIs8/firn-lab.OnlhYU/flakefalse/src",
    "type": "path"
  }
}
root inputs: {"src":"src"}

== nix eval --json .#listing
{"hello.txt":"regular","sub":"directory"}

== nix eval --raw .#hello
hello from src

== without flake = false (first lines of the error)
error:
       … while updating the lock file of flake 'path:$BASE/root-bad'

       … while updating the flake input 'src'

       error: path '/nix/store/<hash>-source/flake.nix' does not exist
exit status of nix flake lock: 1
```

三件事。第一，锁文件里 `src` 节点带着 `"flake": false`，而且它没有 `inputs`：Nix 不会去求值它。（这里的 `locked` 只有 `path` 和 `type`，是因为脚本用 `jq` 删掉了 `lastModified` 和 `narHash`，它们每次都会变。）第二，`outputs` 收到的 `src` 就是源码树本身：`readDir` 得到 `{"hello.txt":"regular","sub":"directory"}`，`readFile` 读到 `hello from src`，所以它可以直接当 `src` 喂给 `mkDerivation`。第三，同一个输入去掉 `flake = false`，`nix flake lock` 以退出码 1 失败：Nix 默认认为输入是个 flake，去找它的 `flake.nix`，找不到就报 `path '.../flake.nix' does not exist`。这是用 flake 来钉一个“不是 flake 的仓库”的办法。

## flakeref：同一个东西的四种写法

inputs 里的 `url`、命令行上 `nix build` 后面 `#` 之前的那部分，都是 flakeref。[手册](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-flake#flake-references)说它有两种形态：URL 式 (`github:NixOS/nixpkgs`) 和属性集式 (`{ type = "github"; owner = "NixOS"; repo = "nixpkgs"; }`)，后者在 `flake.nix` 里和前者等价；另外还有路径式，`/abs/path` 或 `./rel/path`，开头的 `./` 必须写，不然会被当成 URL 式去 registry 里查。`type` 有 `indirect`（默认，经 registry 查）、`path`、`git`、`github`、`gitlab`、`sourcehut`、`tarball` 这些。

`lab/ch08/flakeref_forms.sh` 把四种形态各用 `nix flake metadata` 看一遍，每次只留几行关键输出：

```bash
meta() {
  local ref="$1"
  shift
  local args="$*"
  echo "\$ nix flake metadata ${ref} ${args//${LAB_TMP}/\$LAB_TMP}"
  # `nix flake metadata` bolds its labels even when piped; strip the escapes.
  nix flake metadata "$@" "${ref}" \
    | sed -E 's/\x1b\[[0-9;]*m//g' \
    | grep -E '^(Resolved URL|Locked URL|Description|Path|Revision|Last modified)' \
    | sed -E 's|/nix/store/[0-9a-z]{32}-|/nix/store/<hash>-|'
  echo
}
```

前三种的输出：

```text
$ sed '/^== indirect/,$d' out/ch08/flakeref_forms.stdout
== github:OWNER/REPO/REV
$ nix flake metadata github:NixOS/nixpkgs/56c02bc00adcf003215cc4bd996d6efaf4cff188 
Resolved URL:  github:NixOS/nixpkgs/56c02bc00adcf003215cc4bd996d6efaf4cff188
Locked URL:    github:NixOS/nixpkgs/56c02bc00adcf003215cc4bd996d6efaf4cff188?narHash=sha256-9i/VTdusq/%2BNM/tz%2BJ1Re%2BojkMB8MBf0QshnYfzHz30%3D
Description:   A collection of packages for the Nix package manager
Path:          /nix/store/<hash>-source
Revision:      56c02bc00adcf003215cc4bd996d6efaf4cff188
Last modified: 2026-08-23 08:22:48

== path:
$ nix flake metadata path:/home/bfmhno3/Projects/firn 
Resolved URL:  path:/home/bfmhno3/Projects/firn
Locked URL:    path:/home/bfmhno3/Projects/firn?lastModified=1793868664&narHash=sha256-gLRPIlH7MNByvgfAHmq9S%2B1f/5IHMKDa84WI1XazFY8%3D
Description:   firn: companion code for the series 用 Firn 从零学 Nix
Path:          /nix/store/<hash>-source
Last modified: 2026-11-05 00:51:04

== git+file://
$ nix flake metadata git+file:///home/bfmhno3/Projects/firn 
Resolved URL:  git+file:///home/bfmhno3/Projects/firn
Locked URL:    git+file:///home/bfmhno3/Projects/firn?ref=refs/heads/main&rev=bebc41bde7786a147b624d5af6ac5d27a122b777
Description:   firn: companion code for the series 用 Firn 从零学 Nix
Path:          /nix/store/<hash>-source
Revision:      bebc41bde7786a147b624d5af6ac5d27a122b777
Revisions:     19
Last modified: 2026-11-05 00:46:13
```

三种写法的**锁定后的形态**不同，这正是 `Locked URL` 一行告诉你的：

- `github:` 的版本，`Resolved URL` 和我写的一样（我已经写了完整的 `rev`），`Locked URL` 多了 `?narHash=...`：它只靠内容哈希来确认拿到的是对的东西。没有 `Revisions` 一行，因为手册说 `revCount` 对 `github` 不可用，它们是当 tarball 取的，不是 git 仓库。
- `path:` 的版本，`Locked URL` 带的是 `lastModified` 和 `narHash`，没有 `Revision`：目录没有提交可言。`Description` 是 `flake.nix` 里那一行。
- `git+file://` 的版本，`Locked URL` 带 `ref` 和 `rev`，多了 `Revisions: 19`（这个仓库有 19 个提交）。`Last modified` 是 HEAD 提交的时间 `2026-11-05 00:46:13`（本机时区）。

同一个目录，`path:` 和 `git+file://` 报告的信息不一样，这是上面 `self_attrs.sh` 那一节的原因：前者不看 git。

第四种，`nixpkgs` 这种不带类型的名字，属于 `indirect`，要经过 registry 才知道它指向哪里。[`nix registry` 的手册页](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-registry)说有多个 registry，优先级从低到高：全局的（一个从 `flake-registry` 设置的 URL 下载来的文件，默认放在 GitHub 的一个仓库里）、系统的（默认 `/etc/nix/registry.json`；NixOS 上由选项 `nix.registry` 生成）、用户的 (`~/.config/nix/registry.json`)、命令行 `--override-flake`。手册还有一句重要的话：系统和用户 registry **不会**被用来解析 `flake.nix` 里的 flakeref，它们只用在命令行上。（全局 registry 解析 `flake.nix` 里 `url = "nixpkgs"` 这样的写法，解析的结果会记进 `flake.lock`，手册的锁文件示例里 `original` 就是 `{ "id": "nixpkgs", "type": "indirect" }`；Firn 把 `github:NixOS/nixpkgs/nixos-unstable` 写全，就是不让结果取决于任何 registry。）

实验的最后一段不能动我机器上的 registry，所以脚本做了两件事：用 `--flake-registry` 指向 `LAB_TMP` 下的一个私有全局 registry 文件（里面写了 `flake-utils` 和 `home-manager` 两条），再把 `XDG_CONFIG_HOME` 指到 `LAB_TMP`，这样 `nix registry add` 写的是一个临时的用户 registry：

```text
$ sed -n '/^== indirect/,$p' out/ch08/flakeref_forms.stdout
== indirect: nixpkgs, resolved by a registry
$ nix registry add nixpkgs github:NixOS/nixpkgs/56c02bc00adcf003215cc4bd996d6efaf4cff188

$ nix registry list | sed -n 1,5p
user   flake:nixpkgs github:NixOS/nixpkgs/56c02bc00adcf003215cc4bd996d6efaf4cff188
system flake:nixpkgs path:/nix/store/<hash>-source
global flake:flake-utils github:numtide/flake-utils
global flake:home-manager github:nix-community/home-manager

$ nix flake metadata nixpkgs --flake-registry $LAB_TMP/registry.json
Resolved URL:  github:NixOS/nixpkgs/56c02bc00adcf003215cc4bd996d6efaf4cff188
Locked URL:    github:NixOS/nixpkgs/56c02bc00adcf003215cc4bd996d6efaf4cff188?narHash=sha256-9i/VTdusq/%2BNM/tz%2BJ1Re%2BojkMB8MBf0QshnYfzHz30%3D
Description:   A collection of packages for the Nix package manager
Path:          /nix/store/<hash>-source
Revision:      56c02bc00adcf003215cc4bd996d6efaf4cff188
Last modified: 2026-08-23 08:22:48
```

`nix registry list` 先列用户的，再列系统的，最后是全局的，和优先级相反（高的在前）。`nixpkgs` 这个名字在用户和系统两层都有条目：用户的指向我钉的那个 GitHub 提交，系统的（我这台 NixOS 上的 `/etc/nix/registry.json`）指向一个 store 路径。解析 `nixpkgs` 的结果是 `Resolved URL: github:NixOS/nixpkgs/56c02bc0...`，也就是用户那条赢了，和手册说的优先级一致。最后一次 `nix flake metadata nixpkgs` 打印的 `Revision` 和第一次直接写 `github:...` 的完全一样：同一个东西，两个名字。

## 只有被 git 跟踪的文件

第 1 篇里我说过 `git add -A` 不是仪式，是规则，还说会让它在你面前失败一次。现在兑现。

`lab/ch08/fixtures/untracked_setup.sh` 是两个实验共用的准备函数：把 Firn 克隆到 `LAB_TMP`，新建一个 `extra.nix`，再在克隆里的 `flake.nix` 里加一个输出 `extra`，让它 `import ./extra.nix`：

```bash
setup_clone() {
  git clone --quiet "${FIRN_ROOT}" "${LAB_TMP}/clone"
  cd "${LAB_TMP}/clone" || return 1
  echo '"extra output from an untracked file"' >extra.nix
  # flake.nix is tracked, so this edit is visible; extra.nix is not.
  sed -i 's|^      lib = firnLib;|      lib = firnLib;\n      extra = import ./extra.nix;|' flake.nix
  echo '== git status --short'
  git status --short
}
```

`untracked_invisible_fail.sh` 在这样的克隆里直接 `nix eval .#extra`，并把 stderr 并进 stdout，让整个错误可见：

```text
$ cat out/ch08/untracked_invisible_fail.stdout
== git status --short
 M flake.nix
?? extra.nix

== nix eval .#extra
warning: Git tree '/tmp/nix-shell.mdhIs8/firn-lab.xlFIs9/clone' is dirty
error:
       … while calling the 'import' builtin
         at /tmp/nix-shell.mdhIs8/firn-lab.xlFIs9/clone/flake.nix:120:15:
          119|       lib = firnLib;
          120|       extra = import ./extra.nix;
             |               ^
          121|

       error: Path 'extra.nix' in the repository "/tmp/nix-shell.mdhIs8/firn-lab.xlFIs9/clone" is not tracked by Git.

       To make it visible to Nix, run:

       git -C "/tmp/nix-shell.mdhIs8/firn-lab.xlFIs9/clone" add "extra.nix"
```

（这大概是整个 Nix 里最体贴的一条错误信息：连该敲的命令都替你拼好了，路径还带着引号。）

脚本以退出码 1 结束（它的名字以 `_fail` 结尾，`make ch08` 把非零当作成功）。这段输出里有三件事。

第一，文件**在磁盘上**，错误却说它不被 git 跟踪。错误信息的源码在 [`git.cc` 的 768 到 784 行](https://github.com/NixOS/nix/blob/2.34.9/src/libfetchers/git.cc#L768-L784)：对一个不在 flake 源码里的路径，如果磁盘上确实有这个文件，就说 “is not tracked by Git” 并给出该运行的 `git add` 命令；如果磁盘上也没有，说的是 “does not exist in Git repository”。这条信息已经把规则告诉你了：flake 的源码是 git 知道的那些文件。

第二，**修改过但没暂存的 `flake.nix` 是可见的**。错误的位置是 `flake.nix:120:15`，那一行 `extra = import ./extra.nix;` 是脚本改出来的，只是工作区里的修改，我没有 `git add`。所以可见的集合不是“HEAD 里的文件”，而是“git 知道的文件，取它们工作区里现在的内容”。这也是开头那行警告 `Git tree '...' is dirty` 的意思：树是脏的，Nix 允许你这样用，但提醒一下。

第三，**暂存就够了，不用提交**。`untracked_fixed.sh` 用同样的克隆，只多了一步：

```text
$ cat out/ch08/untracked_fixed.stdout
== git status --short
 M flake.nix
?? extra.nix

== git add extra.nix
A  extra.nix
 M flake.nix

== nix eval .#extra
"extra output from an untracked file"
```

`A  extra.nix` 是“已暂存的新文件”，提交还没有发生，求值就成功了。

这条规则让人烦，但我猜得出来它为什么存在：flake 是一个要被复制进 store、按内容哈希的东西，如果目录里的任何东西都算数，`.gitignore` 里的 `out/`、`result`、`.direnv/` 这些每次构建都在变的文件会一起进哈希，flake 的内容就永远不一样。以 git 为准，等于借用了一个现成的“哪些文件属于项目”的清单。下一节的实验会证明这些被排除的东西确实没有进 store。

## 源码被整份复制进 store

`self.outPath` 是 `/nix/store/<hash>-source`，这个 `source` 就是 flake 的源码树在 store 里的副本。`lab/ch08/copy_to_store.sh` 把它量出来：

```text
$ sed -n '/^== the copy/,/^== top level/p' out/ch08/copy_to_store.stdout
== the copy
path:  /nix/store/<hash>-source
size:  824K
bytes: 170536
files: 174

== the same repository in the working directory
tracked files: 174
du -sh whole directory (with .git, out/, result): 3.0M
du -sh .git: 824K

== top level of the copy (no .git, no out/)
```

副本是 170,536 字节，174 个文件，和 `git ls-files` 的 174 个文件一一对上。`du -sh` 说 824K，比字节数大了近 5 倍，我猜是 `du` 按磁盘块（大概每个文件向上取整到 4 KiB）算的。整个工作目录是 3.0M，其中 `.git` 就占了 824K，剩下的还有 `out/` 和 `result` 这些被 `.gitignore` 排除的东西。看副本的顶层：

```text
$ sed -n '/^== top level/,/^$/p' out/ch08/copy_to_store.stdout
== top level of the copy (no .git, no out/)
data
.envrc
flake.lock
flake.nix
.gitignore
lab
lib
LICENSE-APACHE
LICENSE-MIT
Makefile
mini
nix
README.md
scripts
tests
```

没有 `.git`，没有 `out/`，没有 `result`；`.envrc` 和 `.gitignore` 因为被跟踪，所以在。这就是上一节那条规则的实物。

要留意的是代价：这份复制是**整份**的，不管你的表达式只用到其中几个文件。只改一行，副本的内容哈希就变了，store 里就多出一份新的 `-source`（旧的要等 GC）。对 Firn 这样 168 KB 的仓库没什么感觉，对一个几百 MB 的 monorepo 就不是这么回事了。这个问题是有人解决的：Determinate Systems 的 Determinate Nix 有一个叫 lazy trees 的功能，[官方文档](https://docs.determinate.systems/determinate-nix/lazy-trees/)的说法是“Nix scopes file copying to what the specific expression demands”，用一个虚拟文件系统在需要的时候才取文件，自 3.5.2 起可用。实验的最后一段试了一下上游的 Nix 有没有这个设置：

```text
$ sed -n '/^== lazy trees/,$p' out/ch08/copy_to_store.stdout
== lazy trees
nix (Nix) 2.34.9
error: could not find setting 'lazy-trees'
(no such setting in this Nix; Determinate Nix has it: post 19)
```

2.34.9 里没有 `lazy-trees` 这个设置。Determinate Nix 和它的 lazy trees 在第 19 篇里讲，这里只是先预告一下：你现在读到的“整份复制”，是上游 Nix 2.34.9 的行为。

## 纯求值

`flake.nix` 的求值是**纯**的。这一节回答第 1 篇留下的那个问题。第 1 篇我看到 `nix config show pure-eval` 是 `true`，而手册里 `pure-eval` 写的默认值是 `false`，我“没有读源码”，猜是新命令的专门行为。现在读了：

- `pure-eval` 这个设置的默认值确实是 `false`（[`eval-settings.hh` 的 181 到 184 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/include/nix/expr/eval-settings.hh#L181-L184)），和手册一致；
- 但 `nix` 这个命令在启动时，处理完 `nix-build` 这类旧命令之后，直接把它改成 `true`：[`main.cc` 的 428 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/main.cc#L428)，`evalSettings.pureEval = true;`；
- 例外有两个：`nix repl` 是“默认不纯”的（[`repl.cc` 的 55 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/repl.cc#L55)，`main.cc` 的 580 行据此把它改回 `false`），`--file` 也会把它改回 `false`（[`installables.cc` 的 461 到 463 行](https://github.com/NixOS/nix/blob/2.34.9/src/libcmd/installables.cc#L461-L463)，如果你显式写了 `--pure-eval` 就报错：`'--file' is not compatible with '--pure-eval'`）。

所以我的猜测对了一半：它确实是新命令的专门行为，而旧的 `nix-instantiate`、`nix-build` 根本走不到这一行。

纯求值禁止什么？[手册的 `pure-eval` 一节](https://nix.dev/manual/nix/2.34/command-ref/conf-file#conf-pure-eval)列了：文件系统和网络访问只允许“files specified by cryptographic hash”，加上四个“不纯的常量”：`builtins.currentSystem`、`builtins.currentTime`、`builtins.nixPath`、`builtins.storePath`。`lab/ch08/pure_eval_fail.sh` 用一个最短的 flake 试第一个，`fixtures/currentsystem_flake.sh` 负责写这个 flake（注释里的 `# BAD` 是标记，这个 flake 故意违反了 Firn 的 Nix 规则）：

```bash
  # BAD: flakes must not depend on the machine they are evaluated on.
  cat >"${LAB_TMP}/cs/flake.nix" <<'NIX'
{
  outputs = _: {
    system = builtins.currentSystem;
  };
}
NIX
```

```text
$ cat out/ch08/pure_eval_fail.stdout
== flake.nix
{
  outputs = _: {
    system = builtins.currentSystem;
  };
}

== nix eval path:/tmp/nix-shell.mdhIs8/firn-lab.MQ7bLr/cs#system
error: attribute 'currentSystem' missing
       at /nix/store/pc3zgiws7d14vmxiq599rkn9qp9pqcyh-source/flake.nix:3:14:
            2|   outputs = _: {
            3|     system = builtins.currentSystem;
             |              ^
            4|   };
```

错误是 `attribute 'currentSystem' missing`，不是“被禁止了”。这个措辞有它的道理：在纯模式下 `builtins.currentSystem` 根本**不存在**。[`eval.cc` 的 470 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/eval.cc#L470)是注册常量的地方，`if (!(settings.pureEval && info.impureOnly))`：标成 `impureOnly` 的常量在纯模式下不会被放进 `builtins`；`currentSystem` 的定义在 [`primops.cc` 的 5262 到 5292 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/primops.cc#L5262-L5292)，末尾带着 `.impureOnly = true`。同一个 flake 加上 `--impure`，`pure_eval_impure.sh`：

```text
$ cat out/ch08/pure_eval_impure.stdout
== flake.nix
{
  outputs = _: {
    system = builtins.currentSystem;
  };
}

== nix eval --impure path:/tmp/nix-shell.mdhIs8/firn-lab.0vkVtb/cs#system
"x86_64-linux"
```

`--impure` 的定义在 [`common-eval-args.cc` 的 117 到 122 行](https://github.com/NixOS/nix/blob/2.34.9/src/libcmd/common-eval-args.cc#L117-L122)，就是把 `pureEval` 设回 `false`。

**为什么 flake 要这样？** 我的理解是：flake 的卖点是“同样的输入，同样的输出”。输入是源码树加锁文件。如果求值时允许读 `currentSystem`、环境变量、`<nixpkgs>` 这样的查找路径，结果就还取决于跑它的那台机器，锁文件就白锁了。所以纯求值才会连着 flake 一起出现，也才会有后面的 eval cache：只有求值是输入的纯函数，才能按输入的指纹缓存它的结果。

这还解释了本篇开头那个“样板”：为什么每个输出都要 `forAllSystems`。一个 flake 不能问“我在哪种机器上”（上面刚证明过），所以它只能把每个系统的答案都列出来，由 CLI 挑：`nix build .#hello` 查 `packages.<当前系统>.hello`，当前系统是 CLI 带进来的（`installables.cc` 的 253 行用的是 `settings.thisSystem`），不是 flake 自己去读的。表达式不能自己知道系统，才有了每个输出多出来的一层系统名。这是我把几处源码放在一起之后的理解，不是哪份文档的原话。

纯求值还管到了别处：`builtins.getFlake` 在纯模式下拒绝没有锁定的 flakeref，报 `cannot call 'getFlake' on unlocked flake reference`（[`flake-primops.cc` 的 41 到 45 行](https://github.com/NixOS/nix/blob/2.34.9/src/libflake/flake-primops.cc#L41-L45)）；访问绝对路径和查找路径的拒绝信息都带着 `(use '--impure' to override)`（[`eval.cc` 的 283 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/eval.cc#L283)和 [3272 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/eval.cc#L3272)），第 1 篇里我已经撞到过其中一个。

## eval cache

求值是纯的，就可以缓存。`eval-cache` 这个设置的[手册描述](https://nix.dev/manual/nix/2.34/command-ref/conf-file#conf-eval-cache)只有几句：使用 flake 求值缓存；某些命令在第二次对某个版本的 flake 调用时不必再求值；中间结果不缓存；默认开启。我想量一下它到底值多少，同时发现一件和这三句不完全对得上的事。

缓存的键是 flake 的**指纹**。`LockedFlake::getFingerprint`（[`flake.cc` 的 979 到 1002 行](https://github.com/NixOS/nix/blob/2.34.9/src/libflake/flake.cc#L979-L1002)）把源码的指纹、子目录、锁文件的文本，以及 `revCount` 和 `lastModified` 拼起来取 SHA-256；锁文件里有没锁定的输入，就没有指纹，也就没有缓存。对 git 来源，指纹是提交哈希；工作区是脏的、又没有子模块的时候，是提交哈希加上改动文件的内容哈希（[`git.cc` 的 1082 到 1107 行](https://github.com/NixOS/nix/blob/2.34.9/src/libfetchers/git.cc#L1082-L1107)）。[`openEvalCache`](https://github.com/NixOS/nix/blob/2.34.9/src/libflake/flake.cc#L1006-L1010) 只在 `eval-cache` 打开而且求值是纯的时候才算指纹。缓存本身是一个 SQLite 文件，放在 `eval-cache-v6/<指纹>.sqlite`，位置由缓存目录决定（[`eval-cache.cc` 的 73 到 76 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/eval-cache.cc#L73-L76)）。

`lab/ch08/eval_cache.sh` 对两条命令各测三种状态，每种 5 次取中位数：冷（每次一个全新的空缓存目录，靠 `XDG_CACHE_HOME`）、热（缓存已经被填过）、关 (`--option eval-cache false`)。为了让指纹固定，脚本先把仓库克隆到 `LAB_TMP`，每次测量前先用一个单独的缓存目录白跑一遍，这样没有哪一次测量要为拉取源码付钱。计时的核心是：

```bash
  for ((i = 0; i < runs; i++)); do
    cold+=("$(XDG_CACHE_HOME="${LAB_TMP}/cold-${label}-${i}" time_ms "$@")")
  done
  # The cache directory of the priming run already holds the result.
  for ((i = 0; i < runs; i++)); do
    warm+=("$(XDG_CACHE_HOME="${prime}" time_ms "$@")")
  done
  for ((i = 0; i < runs; i++)); do
    off+=("$(XDG_CACHE_HOME="${prime}" time_ms "$@" --option eval-cache false)")
  done
```

两条命令是：

```bash
bench eval-outpath nix eval --raw ".#${attr}"
bench path-info-drv nix path-info --derivation ".#legacyPackages.${system}.mini.site"
```

结果：

```text
$ cat out/ch08/eval_cache.stdout
== eval-outpath
$ nix eval --raw .#legacyPackages.x86_64-linux.mini.site.outPath
cold (empty cache):      455 503 508 535 491 -> median 503 ms
warm (cache filled):     434 428 433 444 457 -> median 434 ms
off  (eval-cache false): 449 442 483 447 469 -> median 449 ms
ratio cold/warm: 1.2x
ratio off/warm:  1.0x

== path-info-drv
$ nix path-info --derivation .#legacyPackages.x86_64-linux.mini.site
cold (empty cache):      474 507 481 510 479 -> median 481 ms
warm (cache filled):     50 50 53 52 56 -> median 52 ms
off  (eval-cache false): 480 418 442 438 439 -> median 439 ms
ratio cold/warm: 9.2x
ratio off/warm:  8.4x
```

第二条，`nix path-info --derivation`：冷 481 ms，热 52 ms，快了 9.2 倍；关缓存是 439 ms，所以热缓存比“没有缓存”快 8.4 倍。（这个脚本我反复跑过几遍，比值在 9.2 到 10.4 之间晃，所以别记 9.2 这个数，记“大约十倍”。）冷缓存比关缓存还慢了约 42 ms，我猜是第一次求值要把结果写进 SQLite 的开销，这一句没有单独量过。

第一条，`nix eval --raw ...outPath`：冷 503，热 434，关 449。热缓存只比关缓存快 15 ms，在噪声之内，缓存几乎没有帮上忙。同一个 flake，同一个属性，同一个缓存，一条命令快将近十倍，另一条纹丝不动。

我先想到的解释是“`outPath` 是带字符串上下文的字符串，缓存不存这种东西”。源码不支持这个说法：`AttrDb::setString` 在写入时把上下文也存进去了（[`eval-cache.cc` 的 139 到 157 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/eval-cache.cc#L139-L157)），读的时候再还原（[266 到 270 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/eval-cache.cc#L266-L270)）。真正的原因在另一头，这是我读 2.34.9 的源码得到的解释：

1. `nix eval` 的 `run` 调用 `installable->toValue(*state)`（[`eval.cc` 的 67 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/eval.cc#L67)）；
2. 对 flake 的 installable，`toValue` 是 `return {&getCursor(state)->forceValue(), noPos};`（[`installable-flake.cc` 的 155 到 158 行](https://github.com/NixOS/nix/blob/2.34.9/src/libcmd/installable-flake.cc#L155-L158)）；
3. `AttrCursor::forceValue()`（[`eval-cache.cc` 的 394 到 426 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/eval-cache.cc#L394-L426)）对**最后这个属性**无条件地求值，求完之后如果缓存里还没有，把结果写进去；它不会先去读。

读缓存的是另一类函数：`getString()`（[528 到 547 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/eval-cache.cc#L528-L547)）先 `fetchCachedValue`，命中了就返回。`nix path-info --derivation` 走的是 `InstallableFlake::toDerivedPaths`，里面调用 `attr->forceDerivation()`（[`installable-flake.cc` 的 104 行](https://github.com/NixOS/nix/blob/2.34.9/src/libcmd/installable-flake.cc#L104)），而 `forceDerivation` 取 `drvPath` 用的正是 `getString()`（[`eval-cache.cc` 的 705 到 719 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/eval-cache.cc#L705-L719)）；注释里还说，如果缓存里的 `.drv` 已经被垃圾回收了，会强制重新求值。所以 `nix path-info` 能直接从缓存里读到叶子 `drvPath`，而 `nix eval` 只能读到沿路的中间属性集，最后那个属性总是重新求值。`nix build` 也是同一个 `toDerivedPaths`，应该同样受益；我没有给它单独测，这一句是从源码推的。

这个解释我另外用 `--debug` 验证过。下面是我手敲的，不在仓库的实验里：先各跑一遍把缓存填好，再各跑第二遍，只留缓存相关的行：

```text
$ nix eval --raw .#legacyPackages.x86_64-linux.mini.site.outPath --debug 2>&1 | grep -E "^(using cached|evaluating uncached)"
using cached attrset attribute ''
using cached attrset attribute 'legacyPackages.x86_64-linux'
evaluating uncached attribute 'legacyPackages.x86_64-linux.mini.site.outPath'
$ nix path-info --derivation .#legacyPackages.x86_64-linux.mini.site --debug 2>&1 | grep -E "^(using cached|evaluating uncached)"
using cached attrset attribute ''
using cached attrset attribute 'legacyPackages.x86_64-linux'
using cached string attribute 'legacyPackages.x86_64-linux.mini.site.type'
using cached string attribute 'legacyPackages.x86_64-linux.mini.site.drvPath'
```

`nix eval` 命中了两层中间的属性集，最后的 `outPath` 是 `evaluating uncached`；`nix path-info` 一路命中到字符串 `drvPath`。而 `outPath` 那一步恰恰是整个求值里最贵的，所以缓存对它几乎没有可见的好处。

这里有一个我觉得很值得记下来的教训：量一下，再下结论。如果我拿 `nix eval` 测缓存，会得出“eval cache 几乎没用”，手册里那句 “Certain commands won't have to evaluate” 里的 “certain” 一词，原来是字面意思。

## 我对 flake 不满意的三件事

写到这里，我对 flake 的日常使用是满意的：一个锁文件，一组命令都认得的输出名，一个不会被我的环境变量弄脏的求值。但上面的每个实验里都有一个让我皱眉的地方，我挨个说。

**样板。** 每个按系统展开的输出都得套一层 `forAllSystems`，Firn 里有 `systems` 列表、`forAllSystems`、`pkgsFor` 三个只为这一层服务的名字，连 `devShells = nixpkgs.lib.mapAttrs (_: devShell: { default = devShell; }) devShells;` 这一行（`flake.nix` 的 122 行）也是同一种样板换了个写法。nixpkgs 自己也这样：它的 `flake.nix` [第 12 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/flake.nix#L12)写的是 `forAllSystems = lib.genAttrs lib.systems.flakeExposed;`，`flakeExposed` 在锁定的提交里是 [9 个系统](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/systems/flake-systems.nix)。前面“纯求值”一节我给了这层样板的来由（表达式不能问“我在哪”），可知道来由不等于喜欢它：它让每个输出都深了一层，也让每个新手第一次读 `flake.nix` 时先看到的是一堆和他的项目无关的东西。

**整份复制。** `copy_to_store.sh` 量的是 Firn 这种 170,536 字节、174 个文件的仓库，没什么感觉。但它的机制是整树复制，不管你求值时用到几个文件；Determinate Nix 的 lazy trees 就是冲着这个来的（上面已经引了它的文档），而 2.34.9 没有。我没有在大仓库里测，所以这一条我只能说机制是这样，代价有多大取决于你的仓库有多大。

**仍然是实验性的。** 上面已经引过：自 2.4 (2021-11-01) 起，手册里一直把 flakes 列在实验性功能下。我不知道上游为什么一直没有把它转正，也不打算猜；我能说的是它现在的状态：你要在 `nix.conf` 里手动开 `experimental-features`，手册会提醒你接口“subject to change”，而 nixpkgs 自己的 `flake.nix` 第一行还写着 “Experimental flake interface to Nixpkgs”。我的日常是建在它上面的，所以我有偏见；这个偏见的成本，是要接受这件事哪天可能变：一个“实验性”的东西，没有人答应你它不变。

## flake-utils 与 flake-parts

样板的问题有人解决了，两个最常见的方案我各说一段，Firn 两个都不用，继续用手写的 `nixpkgs.lib.genAttrs`。

[flake-utils](https://github.com/numtide/flake-utils) 是 numtide 的一个库。它的 README 一开头说目标是“a collection of pure Nix functions that don't depend on nixpkgs, and that are useful in the context of writing other Nix flakes”。最常见的用法是 `eachDefaultSystem`：`eachSystem` 预先填上 `defaultSystems`（README 里写的默认值是 `x86_64-linux`、`aarch64-linux`、`x86_64-darwin`、`aarch64-darwin`），你写一个从系统名到属性集的函数，它替你把每个键下面的系统层搭好：README 的例子是 `eachSystem [ system.x86_64-linux ] (system: { hello = 42; })` 得到 `{ hello = { x86_64-linux = 42; }; }`。它和 Firn 的 `forAllSystems` 想法一样，区别是 Firn 是在每个输出上各写一次系统层，flake-utils 是在整个函数外面写一次、里面不再提系统。代价是多一个输入，多一个锁文件节点（README 还提到它本身有一个叫 `systems` 的输入，可以用 `follows` 覆盖，见前面的 follows 一节）。

[flake-parts](https://flake.parts/) 是 hercules-ci 的一个框架，自称“Core of a distributed framework for writing Nix Flakes”。它的做法不一样：把 flake 的输出建模成模块系统的选项，所以你写的是 `perSystem = { config, pkgs, ... }: { packages.foo = ...; };`，加一个 `systems = [ ... ]` 声明要哪些系统，非按系统的东西放进 `flake = { ... }`，用 `imports` 把一个大 `flake.nix` 拆成几个文件。文档对自己的定位是“a minimal mirror of the Nix flake schema”，机制靠模块系统，这个会在第 15 篇讲，所以我这里不展开。

Firn 不用它们的理由很朴素：现在只有两个系统、一百多行、六个输出，我想把约定的那张表原样摆在眼前读；再往后，模块系统那几章会让我回头看这个选择，到时候我再说我对它的看法。

## nixConfig

四块里的最后一块 `nixConfig` 我一直没讲。[手册](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-flake#flake-format)说它是“a set of `nix.conf` options to be set when evaluating any part of a flake”，出于安全，只有一小组选项可以在没有确认的情况下设置（除非全局配置里打开了 [`accept-flake-config`](https://nix.dev/manual/nix/2.34/command-ref/conf-file#conf-accept-flake-config)）：`bash-prompt`、`bash-prompt-prefix`、`bash-prompt-suffix`、`flake-registry`、`commit-lock-file-summary`。其余的（比如额外的 substituter）会让 Nix 问你一次。Firn 的 `flake.nix` 现在没有 `nixConfig`，因为它要等到第 20 篇的 CI：那时我要让 flake 带上 Cachix 的缓存地址，那是一个会让你信任别人的缓存的设置，所以到时候我会专门讲它为什么要你确认。

## 让我意外的事

**`nix eval` 的缓存是零，`nix path-info` 的缓存是十倍。** 我一开始是用 `nix eval --raw ...outPath` 去测 eval cache 的，得到 1.2 倍，差点就写成“eval cache 在这里几乎没用”。换成 `nix path-info --derivation` 之后是 9.2 倍（481 ms 对 52 ms）。同一个缓存，`nix path-info` 能直接读到叶子 (`drvPath`)，`nix eval` 只能读到中间的 attrset，最后那个属性总是重新求值。如果不去读 `eval-cache.cc` 里 `forceValue` 和 `getString` 的区别，我会带着一个错误的印象走很久。

**手册、配置和实际行为说了三种话。** 手册的 `pure-eval` 一节说默认是 `false`；`nix config show pure-eval` 说 `true`；真正起作用的是 `main.cc` 的 428 行一句赋值，而 `nix repl` 又在另一个地方被改回去。第 1 篇里我猜这是“新命令的专门行为”。读完源码，对了一半：确实是 `nix` 命令自己的行为，而不是版本有意改了默认值。

**锁定之后，`ref` 不见了。** `original` 里有 `"ref": "nixos-unstable"`，`locked` 里没有，多出来的是 `rev`、`narHash`、`lastModified`。我原来以为锁文件是“在原来的基础上补上一个提交哈希”，实际上它是“把分支名换成提交哈希”：钉住之后，分支叫什么已经不重要了。

**改过没暂存的 `flake.nix` 可见，git 不认识的 `extra.nix` 不可见。** 这条规则我背了七章，但从来没想过它的精确含义。实验里一个**修改过没暂存**的 `flake.nix` 被 Nix 读到了，一个**根本没被 git 知道**的 `extra.nix` 没有；而 `git add` 之后什么都不用提交，它就可见了。所以规则不是“提交过的文件”，是“git 知道的文件，取工作区里的内容”。

## 检查点

在 `~/firn` 里，`nix develop` 之内：

```bash
make ch08
make lint
make check
for f in lab/ch08/*.sh lab/ch08/fixtures/*.sh; do
  diff <(git -C ~/firn-ref show ch08:"${f}") "${f}" && echo "same ${f}"
done
```

我的环境里设了 `CI=true`，下面的输出是 `env -u CI make ch08`（这一章没有 `_host` 实验，设不设 `CI` 输出一样）。`make ch08` 应当打印这 17 行：

```text
bash scripts/chapter.sh ch08
ok   lab/ch08/copy_to_store.sh
ok   lab/ch08/eval_cache.sh
ok   lab/ch08/ex_add_app.sh
ok   lab/ch08/flake_false.sh
ok   lab/ch08/flake_metadata.sh
ok   lab/ch08/flake_show.sh
ok   lab/ch08/flake_update.sh
ok   lab/ch08/flakeref_forms.sh
ok   lab/ch08/follows.sh
ok   lab/ch08/lock_anatomy.sh
ok   lab/ch08/pure_eval_fail.sh
ok   lab/ch08/pure_eval_impure.sh
ok   lab/ch08/run_app.sh
ok   lab/ch08/self_attrs.sh
ok   lab/ch08/untracked_fixed.sh
ok   lab/ch08/untracked_invisible_fail.sh
```

16 个实验里，`pure_eval_fail.sh` 和 `untracked_invisible_fail.sh` 两个以退出码 1 结束，这是它们的名字 (`_fail`) 要求的，所以仍然打印 `ok`；其余 14 个退出 0。`eval_cache.sh` 里每条命令要测 15 次，所以它是最慢的一个。`flakeref_forms.sh` 里的 `github:NixOS/nixpkgs/<rev>` 在本机没有缓存时需要联网；其余实验在 `nix develop` 已经把锁定的 nixpkgs 放进 store 之后不需要网络。实验不会改你机器上的东西：`nix registry add` 写的是 `LAB_TMP` 下的临时用户 registry。

`make lint` 只回显它跑的几条命令（`nixfmt --check`、`deadnix --fail`、`shellcheck`、`shfmt`；`statix` 那一行以 `@` 开头，`make` 不回显它），没有任何诊断，退出码 0。`make check` 以 `all checks passed!` 结束，退出码 0；这一章新增的两个输出会出现在 `make check` 的末尾（前面各项的输出我用 `...` 省略了）：

```text
...
checking flake output 'apps'...
checking app 'apps.x86_64-linux.mini-hello'...
checking flake output 'formatter'...
checking derivation formatter.x86_64-linux...
running 0 flake checks...
all checks passed!
warning: The check omitted these incompatible systems: aarch64-linux
Use '--all-systems' to check all.
```

因为都已经在缓存里，`make check` 打印 `running 0 flake checks...`；最后的警告和第 7 篇一样，是 `nix flake check` 默认只查当前系统。注意没有出现 `unknown flake output` 的警告：`lib` 在白名单里。

`diff` 循环应当打印 18 行 `same ...`，不打印 diff：16 个实验加 `fixtures/` 下的 2 个文件。

**必须和标签一致的文件：** `lab/ch08/` 下全部 16 个实验和 2 个 fixture。

**中间版本（后面的章节会继续改）：** [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch08/flake.nix)：现在是 144 行，每个往里加输出的章节（第 10 章的 `packages` 和 `overlays`，第 13 章的 `templates` 等）都会再改它。[`README.md`](https://github.com/bfmhno3/firn/blob/ch08/README.md)：“Flake outputs” 那张表会随着新增的输出一起改。

### 文件清单

这一篇的所有文件都在仓库里，链接指向标签 `ch08` 上的那一份。这张表和 `git diff --name-only ch07 ch08` 的 20 行一一对应：`flake.nix`、`README.md`、16 个 `lab/ch08/` 实验、2 个 `lab/ch08/fixtures/` 文件。实验用 `make ch08` 跑；`lab/ch08/*.sh` 需要 `FIRN_ROOT` 和 `LAB_TMP`，所以不单独运行，两个 fixture 是被别的脚本 `source` 的，不运行。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch08/flake.nix) | `make check` | 退出码 0，`all checks passed!`；144 行，比 ch07 增加 24 行、删除 3 行；多出 `checking app 'apps.x86_64-linux.mini-hello'...` 和 `checking derivation formatter.x86_64-linux...` |
| [`README.md`](https://github.com/bfmhno3/firn/blob/ch08/README.md) | `git diff --stat ch07 ch08 -- README.md` | 多 13 行：“Flake outputs” 一节，一张 6 行的输出表 |
| [`lab/ch08/copy_to_store.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/copy_to_store.sh) | `make ch08` | 退出码 0；副本 170,536 字节，174 个文件，`du -sh` 824K，整个工作目录 3.0M；`could not find setting 'lazy-trees'` |
| [`lab/ch08/eval_cache.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/eval_cache.sh) | `make ch08` | 退出码 0；`path-info --derivation` 冷 481 / 热 52 / 关 439 ms，9.2 倍；`eval --raw` 503 / 434 / 449 ms，1.2 倍 |
| [`lab/ch08/ex_add_app.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/ex_add_app.sh) | `make ch08` | 退出码 0；`mini-wordfreq` 出现在 `apps` 里，`nix run` 打印 `3 a`、`2 b`，练习 1 |
| [`lab/ch08/fixtures/currentsystem_flake.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/fixtures/currentsystem_flake.sh) | `make ch08`（被 `pure_eval_*.sh` 引用） | 25 行；写出 5 行的 `flake.nix`，里面是 `builtins.currentSystem` |
| [`lab/ch08/fixtures/untracked_setup.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/fixtures/untracked_setup.sh) | `make ch08`（被 `untracked_*.sh` 引用） | 22 行；`git status --short` 打印 ` M flake.nix` 和 `?? extra.nix` |
| [`lab/ch08/flake_false.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/flake_false.sh) | `make ch08` | 退出码 0；锁文件节点 `"flake": false`；`readDir` 得到 `{"hello.txt":"regular","sub":"directory"}`，`readFile` 得到 `hello from src`；去掉 `flake = false` 后 `nix flake lock` 退出码 1 |
| [`lab/ch08/flake_metadata.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/flake_metadata.sh) | `make ch08` | 退出码 0；`rev` 是 `56c02bc0...`，`lastModified: 1787498568 = 2026-08-23T15:22:48Z`，报告有 13 个键 |
| [`lab/ch08/flake_show.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/flake_show.sh) | `make ch08` | 退出码 0；`jq 'keys'` 是 6 个：`apps`、`checks`、`devShells`、`formatter`、`legacyPackages`、`lib`；`lib: unknown` |
| [`lab/ch08/flake_update.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/flake_update.sh) | `make ch08` | 退出码 0；`narHash` 是 `PdalhNbp...`，`c` 变了再 `lock` 仍是 `PdalhNbp...`，`update c` 之后是 `rriJMpn4...` |
| [`lab/ch08/flakeref_forms.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/flakeref_forms.sh) | `make ch08` | 退出码 0；四种写法；`git+file://` 的 `Revisions: 19`；`nix registry list` 先 `user` 后 `system` 再 `global`，`nixpkgs` 解析到 `56c02bc0...` |
| [`lab/ch08/follows.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/follows.sh) | `make ch08` | 退出码 0；没有 `follows` 6 个节点，有 `follows` 4 个；`a` 的 `c` 是 `["c"]` |
| [`lab/ch08/lock_anatomy.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/lock_anatomy.sh) | `make ch08` | 退出码 0；`version: 7`，`node count: 2`，`locked` 比 `original` 多 `["lastModified","narHash","rev"]` |
| [`lab/ch08/pure_eval_fail.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/pure_eval_fail.sh) | `make ch08` | 退出码 1 (`_fail`)；`error: attribute 'currentSystem' missing` |
| [`lab/ch08/pure_eval_impure.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/pure_eval_impure.sh) | `make ch08` | 退出码 0；加 `--impure` 后 `"x86_64-linux"` |
| [`lab/ch08/run_app.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/run_app.sh) | `make ch08` | 退出码 0；`Hello from mini`，`nixfmt-tree-2.5.0` |
| [`lab/ch08/self_attrs.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/self_attrs.sh) | `make ch08` | 退出码 0；干净树有 `rev`，脏树有 `dirtyRev` (`...-dirty`)，`path:` 两个都没有 |
| [`lab/ch08/untracked_fixed.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/untracked_fixed.sh) | `make ch08` | 退出码 0；`git add` 之后 `"extra output from an untracked file"` |
| [`lab/ch08/untracked_invisible_fail.sh`](https://github.com/bfmhno3/firn/blob/ch08/lab/ch08/untracked_invisible_fail.sh) | `make ch08` | 退出码 1 (`_fail`)；`Path 'extra.nix' in the repository ... is not tracked by Git.` |

## 练习

**1.** 给 Firn 加一个 `apps.<system>.mini-wordfreq`，运行 mini 的 `wordfreq`，在一份临时拷贝里做，不要改真的 `flake.nix`。

<details>
<summary>参考答案</summary>

这就是 `lab/ch08/ex_add_app.sh`。它把 `git ls-files` 列出的文件复制到 `LAB_TMP`，`git init`、`git add -A`（因为 flake 只看得到被跟踪的文件），然后用 `sed` 在 `apps = forAllSystems (system: {` 后面插入一个新条目：

```bash
sed -i '/^      apps = forAllSystems (system: {$/a\
        mini-wordfreq = {\
          type = "app";\
          program = "${(miniFor system).wordfreq}/bin/wordfreq";\
          meta.description = "Count words on stdin";\
        };' flake.nix
```

结果：

```text
$ cat out/ch08/ex_add_app.stdout
== the new apps
{
  "mini-hello": {
    "description": "Print the greeting of the mini package set",
    "type": "app"
  },
  "mini-wordfreq": {
    "description": "Count words on stdin",
    "type": "app"
  }
}

== printf 'a b a\nc a b\n' | nix run .#mini-wordfreq -- 2
3 a
2 b
```

`-- 2` 之后的 `2` 是传给 `wordfreq` 的参数（它只打印出现次数最多的前 2 个词），输出 `3 a`、`2 b` 说明 `a` 出现了 3 次，`b` 出现了 2 次。`type`、`program` 两个键缺一不可，`meta.description` 缺了只是警告。

</details>

**2.** 实验 `follows.sh` 里有两个中间 flake（`a` 和 `b`），没有 `follows` 时 6 个节点，有 `follows` 时 4 个。如果有 $k$ 个中间 flake，各自依赖同一个叶子 `c`，根也依赖 `c`，两种情况各有多少节点？

<details>
<summary>参考答案</summary>

按上面“每条依赖边一个节点，除非被 `follows` 合并”的规则推：没有 `follows` 时是 1 个根、$k$ 个中间 flake、$k$ 个中间 flake 各自带的 `c`，再加根自己的 1 个 `c`，共 $1 + k + k + 1 = 2k + 2$；有 `follows` 时所有 `c` 合并成一个，共 $1 + k + 1 = k + 2$。$k = 2$ 时是 6 和 4，和 `follows.stdout` 吻合。这是我从图的规则推的，实验只跑了 $k = 2$，没有跑别的 $k$。

</details>

**3.** 按 `eval_cache.stdout`，`path-info-drv` 一项里冷缓存比关缓存多花了多少毫秒？热缓存比关缓存省了多少毫秒？

<details>
<summary>参考答案</summary>

冷缓存中位数 481 ms，关缓存 439 ms，冷缓存多 42 ms，约 9.6% ($42 / 439$)：这是第一次求值之后把结果写进 SQLite 的开销（我猜，没有单独量）。热缓存 52 ms，比关缓存 439 ms 省 387 ms，约 88.2% ($387 / 439$)，也就是 8.4 倍。`eval-outpath` 一项里三个数差别不大（503、434、449），因为 `nix eval` 只能读到中间的属性集，最后那个属性总是重新求值，见前面“eval cache”一节。

</details>

**4.** `flakeref_forms.stdout` 里 `nix registry list` 列了四行，而 `nixpkgs` 有两条。为什么 `nix flake metadata nixpkgs` 解析出来的是 `github:NixOS/nixpkgs/56c02bc0...`，而不是 `system` 那条的 store 路径？

<details>
<summary>参考答案</summary>

[手册](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-registry)说 registry 的优先级从低到高是全局、系统、用户、命令行 `--override-flake`，用户的覆盖系统的。脚本用 `nix registry add` 往（`LAB_TMP` 下的）用户 registry 里加了一条 `nixpkgs`，所以它赢了系统的那条。`nix registry list` 把优先级高的列在前面：`user`、`system`、`global`。另外手册说系统和用户 registry 只在命令行上起作用，不用来解析 `flake.nix` 里的 `inputs`，所以 Firn 的 `flake.nix` 里那个 `github:NixOS/nixpkgs/nixos-unstable` 不受它们影响。

</details>

**5.** `flake_show.stdout` 里 `lib: unknown`，`nix flake check` 却不会对 `lib` 发 `unknown flake output` 警告。后者的白名单在 Nix 源码的哪一段？还有哪些名字在里面？

<details>
<summary>参考答案</summary>

在 [`src/nix/flake.cc` 的 770 到 776 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/flake.cc#L770-L776)：`lib`、`darwinConfigurations`、`darwinModules`、`flakeModule`、`flakeModules`、`herculesCI`、`homeConfigurations`、`homeModule`、`homeModules`、`nixopsConfigurations`，注释写的是 “Known but unchecked community attribute”。不在这张表里、也不在前面各种已知输出里的名字，走到 [779 行](https://github.com/NixOS/nix/blob/2.34.9/src/nix/flake.cc#L779)：`warn("unknown flake output '%s'", name)`。`nix flake show` 打印 `unknown` 是另一个地方的事（1447 行，没有给 `lib` 的类型分支），两者没有关系。

</details>

## 下一篇

这一篇我们一直在用“新”命令：`nix flake show`、`nix eval`、`nix run`、`nix path-info`，它们都从 flake 的输出树里按名字找东西，也都顺带享受了锁文件和纯求值。但是你机器上还有另一套命令：`nix-env`、`nix-build`、`nix-shell`，它们不认 flake 的 schema，靠 `<nixpkgs>` 这样的查找路径和 channel 工作；第 1 篇里我们已经看到，同一台机器上的 `<nixpkgs>` 和钉死的 nixpkgs 是两个版本。下一篇，第 9 篇《两代 CLI：nix-env、nix-build、nix-shell 与 nix profile》，我把两代命令并排摆开：同一件事新旧各怎么写，channel 到底是什么，`nix profile` 和 `nix-env` 的差别，以及它们各自留在磁盘上的 profile 和 GC 根。这一页 `nix flake show` 的树只有六个顶层输出，到系列结束的时候它会长得多，而每多一个输出，上面那张 schema 表里就会有一行被点亮。Firn 的 `default.nix` 和 `shell.nix` 会在那一章出现，让不认 flake 的旧命令也能读到你在这一篇里钉死的那份 nixpkgs。
