---
title: "模块系统：从零写一个，再读懂 lib.evalModules"
commentId: "post:nix-by-firn-15-module-system"
published: "2026-11-06 22:00:00 +08:00"
description: "用 Firn 从零学 Nix 第 15 篇：我用 Nix 2.34.9 先写了一个 194 行、只依赖 builtins 的模块系统，再用 nixpkgs 的 lib.evalModules 求值同一份 cairn 设置模块；钉住的 lib/modules.nix 有 2342 行，是它的 12.1 倍，最小的 NixOS 配置有 16555 个选项，求值 system.build.toplevel.drvPath 的中位数是 3578 毫秒。"
category: Tutorial
tags:
  - Nix
  - NixOS
  - Firn
  - 模块系统
  - 类型
  - 优先级
series: "用 Firn 从零学 Nix"
seriesOrder: 15
draft: false
comment: true
slug: nix-by-firn-15-module-system
---

我的 NixOS 配置里满是 `mkDefault`、`mkForce` 和 `mkIf`，我用了很久，从来没数过它们各是多少优先级。第 14 篇结尾我说，最缺的是一套能回答“这个选项从哪儿来、被谁改过”的工具，nixpkgs 里这套东西叫模块系统，`lib/modules.nix` 在钉住的 rev 上有 2342 行。所以这一篇我先自己写一个，194 行，只依赖 `builtins`，再回头读那 2342 行，看我漏掉了什么。先看它最终能回答的问题：`cairn.repo` 的值是什么，哪些定义赢了。

```text
$ cat out/ch15/where_defined.stdout
{ declarations = [ "modules/cairn-settings.nix" ]; definitions = [ { file = "host.nix"; value = "/srv/backup"; } ]; highestPrio = 100; value = "/srv/backup"; }
```

> [!NOTE] 本篇检查点
> 这一篇结束时，Firn 仓库的标签 `ch15` 里：`modules/mini-modules.nix`（194 行，我自己写的模块系统，只用 `builtins`）、`modules/cairn-settings.nix`（81 行，Cairn 设置的模块，声明选项并渲染 `cairn.conf`）和 `tests/fixtures/cairn.conf`（7 行，渲染结果的标准答案）；`flake.nix` 对外提供 `lib.evalMini`、`lib.modules.cairnSettings` 和 `checks.<system>.cairn-settings`，x86\_64-linux 上的检查是 15 个（`ch14` 标签上是 14 个）；`lab/ch15/` 下 15 个实验（13 个 `.nix`，2 个 `.sh`，其中 5 个 `_fail` 按预期失败）加 3 个 fixture。`git diff --name-only ch14 ch15` 一共列出 23 个文件，其中 `lab/ch08/fixtures/untracked_setup.sh` 是第 8 篇的 fixture，原因在“让我意外的事”里。`make ch15` 通过（15 个 `ok`）。
> 涉及的概念：模块的形状(`imports`, `options`, `config`)，声明与定义，`config` 这个惰性定点，类型与合并，优先级（`mkOptionDefault`、`mkDefault`、`mkForce` 的数字），`mkIf` 的惰性，`mkBefore`、`mkAfter`、`mkOrder`，子模块，`specialArgs` 与 `_module.args`，`definitionsWithLocations`，以及我这 194 行比 `lib/modules.nix` 少了什么。
> 前置：[第 14 篇：给 nixpkgs 提 PR：by-name、nixpkgs-review 与 channel](/posts/nix-by-firn-14-contributing-to-nixpkgs/)。惰性求值和 `fix` 在[第 3 篇](/posts/nix-by-firn-03-functions-and-laziness/)讲过，`generators.toKeyValue` 为什么吃有序列表在[第 5 篇](/posts/nix-by-firn-05-own-lib/)讲过，flake 的 `checks` 在[第 8 篇](/posts/nix-by-firn-08-flakes/)讲过。
> 终稿与否：`modules/`、`tests/fixtures/cairn.conf` 和 `lab/ch15/` 在这里就是终稿；`flake.nix` 之后的章节还会改，`lab/ch08/fixtures/untracked_setup.sh` 不会再变。

## 环境

这一篇所有输出来自这台机器：NixOS 26.05 (Yarara)，Linux 6.18.60，`x86_64`，上游 Nix 2.34.9，Firn 钉的 nixpkgs 是 `56c02bc00adcf003215cc4bd996d6efaf4cff188`。文中引用的 `lib/modules.nix`、`lib/types.nix`、`lib/options.nix` 和一处 `nixos/modules/misc/nixpkgs.nix` 都是这个 rev 上的文件，行号我在本地那份源码上核对过，链接指向同一个 rev。这一篇没有引用 Nix 本身的源码。

我的 shell 里设了 `CI=true`，Firn 的运行器会据此跳过 `_host` 实验；`lab/ch15/` 里没有 `_host` 实验，所以 `CI` 设不设都一样，我仍然按惯例跑 `env -u CI make ch15`。我先删掉 `out/ch15`，再在 `nix develop` 里跑，整条命令（含 `nix develop` 的启动）花了 22.619 秒。这个数字里最大的一块是 `nixos_option_count.sh`：它对最小 NixOS 配置做一次选项计数，再做五次 `drvPath` 求值，单次中位数 3578 毫秒，按中位数算光那五次就约 18 秒。

实验分两类。一类在 `lab/ch15/` 里，我给出文件路径、摘录和 `out/ch15/` 里的真实输出。另一类是我为了回答某个问题当场敲的，每一条都标着“（手敲，不在 `lab/ch15/` 里）”，输出同样是真跑出来的。手敲的命令都假设你在 `~/firn` 里。

`nix eval --file` 对嵌套的错误很宽容，“类型和合并”那一节会用一个实验把这件事摆出来；`_fail` 实验靠 `builtins.deepSeq` 才能真的失败。另外，文中所有 `lib/modules.nix` 之类的行号都是钉住的 rev 上的行号，换一个 nixpkgs 就不对了。

## 这一篇停在哪里

先看 flake 对外提供的东西：一个函数，一个路径，和一个检查：

```text
$ nix eval .#lib --apply 'lib: { hasEvalMini = lib ? evalMini; modules = builtins.attrNames lib.modules; }'
{ hasEvalMini = true; modules = [ "cairnSettings" ]; }
$ nix eval .#checks.x86_64-linux --apply builtins.attrNames --json
["cairn-settings","dev-shell","lib-tests","mini-site","pkg-cairn","pkg-cairn-report","pkg-firn-hello","pkg-firn-hello-aarch64","pkg-firn-hello-hallo","pkg-firn-hello-musl","pkg-firn-hello-static","pkg-firn-tools","pkg-pebble","pkg-sift","readme-table"]
```

（手敲，不在 `lab/ch15/` 里）

`lib.evalMini` 是我写的 `evalMini` 函数，`lib.modules.cairnSettings` 是 `modules/cairn-settings.nix` 这个文件的路径，让别的 flake 用 `imports = [ firn.lib.modules.cairnSettings ];` 就能拿到同一份设置模块。检查 `cairn-settings` 用 nixpkgs 的 `lib.evalModules` 求值这份模块，把 `configText` 和 `tests/fixtures/cairn.conf` 逐字比较：

```nix
          # 模块系统：用 nixpkgs 的 evalModules 求值 cairn-settings，
          # 渲染出的 configText 必须逐字等于 tests/fixtures/cairn.conf。
          cairn-settings =
            let
              evaluated = pkgs.lib.evalModules {
                modules = [
                  ./modules/cairn-settings.nix
                  {
                    cairn = {
                      repo = "/var/lib/cairn/repo";
                      sources = [
                        "/srv/data"
                        "/etc"
                      ];
                      excludes = [ "*.tmp" ];
                      keep.last = 10;
                      keep.weekly = 2;
                    };
                  }
                ];
              };
            in
            pkgs.runCommand "firn-cairn-settings"
              {
                expected = ./tests/fixtures/cairn.conf;
                actual = evaluated.config.cairn.configText;
                passAsFile = [ "actual" ];
              }
              ''
                diff -u "$expected" "$actualPath" >&2
                echo ok > $out
              '';
```

渲染结果必须逐字等于的 `tests/fixtures/cairn.conf`：

```ini
repo = /var/lib/cairn/repo
source = /srv/data
source = /etc
exclude = *.tmp
keep_last = 10
keep_daily = 7
keep_weekly = 2
```

检查的名字是 `cairn-settings`，构建它就是做一次这个比较，`diff -u` 不一致就失败：

```text
$ nix build .#checks.x86_64-linux.cairn-settings --no-link --print-out-paths
/nix/store/07cx18aa69rr82jz361a670bpk7l2nda-firn-cairn-settings
```

（手敲，不在 `lab/ch15/` 里）

它被缓存了，所以不到半秒就返回。这个检查之后会一直在，第 16 篇的 NixOS 模块和第 18 篇的 Home Manager 模块都要复用这份设置，所以它的渲染结果不能悄悄变。

## 一个模块长什么样

模块系统的词汇很少。一个模块是一个属性集，或者一个返回属性集的函数；函数的参数里最常见的是 `config` 和 `lib`。属性集有三个有意义的键：

- `imports`：别的模块（路径、属性集或函数），先被展开，再并入当前模块
- `options`：这个模块**声明**的选项，每个选项是 `mkOption { type; default; description; ... }`
- `config`：这个模块**定义**的值，形状和 `options` 对应

声明和定义是两件事。一个选项有且只有一个声明（“mini 少了什么”一节会看到这个“只有一个”有例外），但可以有任意多个定义，分散在任意多个模块里；模块系统的工作就是把某个选项的所有定义按类型合并成一个值。Cairn 的设置模块把这三样都用上了：

```nix
{ config, lib, ... }:
let
  inherit (lib) mkOption types;
  firnLib = import ../lib;
  cfg = config.cairn;
in
{
  options.cairn = {
    repo = mkOption {
      type = types.str;
      description = "Path of the cairn repository.";
      example = "/var/lib/cairn/repo";
    };
    # ...
    configText = mkOption {
      type = types.str;
      readOnly = true;
      description = "The rendered cairn.conf.";
    };
  };

  # 属性集会按键排序，行序要靠列表：repo、source、exclude、keep_*。
  config.cairn.configText = firnLib.generators.toKeyValue { } [
    {
      name = "repo";
      value = cfg.repo;
    }
    # ...
```

模块是函数 `{ config, lib, ... }:`，`cfg = config.cairn` 读的是**最终**的 `config`，也就是包含所有模块贡献之后的那个。这一点值得停一下：`configText` 是这个模块自己定义的，它的值依赖 `cfg.sources`，而 `cfg.sources` 可能是另一个模块定义的。顺序不重要，因为 `config` 是一个定点，“从零写一个”那一节我自己写一个。

还有一个省事的写法。如果一个模块没有 `options` 也没有 `config` 键，整个属性集会被当成 `config`，所以 `flake.nix` 的检查里可以直接写 `cairn.repo = ...`。这个简写在 `lib/modules.nix` 的 `unifyModuleSyntax`(L633)里：有 `config` 或 `options` 键就按完整形式处理，并且对其余未知的键报错；没有就把剩下的键整体当作 `config`。我的 mini 没有这个简写，模块里的 `config` 必须写出来。

用 nixpkgs 的 `lib.evalModules` 求值这个模块，`configText` 应当和 fixture 一字不差。`real_eval.nix` 做的就是 flake 检查做的事，只是把结果打印出来：

```nix
let
  pkgs = import ../../nix/pkgs.nix { };
  inherit (pkgs) lib;

  evaluated = lib.evalModules {
    modules = [
      ../../modules/cairn-settings.nix
      {
        cairn = {
          repo = "/var/lib/cairn/repo";
          sources = [
            "/srv/data"
            "/etc"
          ];
          excludes = [ "*.tmp" ];
          keep.last = 10;
          keep.weekly = 2;
        };
      }
    ];
  };

  inherit (evaluated.config.cairn) configText;
  fixture = builtins.readFile ../../tests/fixtures/cairn.conf;
in
if configText == fixture then
  {
    lines = lib.splitString "\n" configText;
    matchesFixture = true;
  }
else
  throw "configText differs from tests/fixtures/cairn.conf"
```

```text
$ cat out/ch15/real_eval.stdout
{ lines = [ "repo = /var/lib/cairn/repo" "source = /srv/data" "source = /etc" "exclude = *.tmp" "keep_last = 10" "keep_daily = 7" "keep_weekly = 2" "" ]; matchesFixture = true; }
```

`lines` 里最后一个空串是因为 `configText` 以换行结尾，`splitString "\n"` 在末尾多切出一段。`keep_daily = 7` 没有人写，它来自选项的 `default`；`keep_last = 10` 和 `keep_weekly = 2` 是调用方写的。哪些行来自默认值、哪些来自定义，是模块系统在合并时决定的，所以我接着自己动手写这个合并。

## 从零写一个：模块系统的骨架

`modules/mini-modules.nix` 是我写的 `evalMini`。它做三件事：把所有模块收集起来，按路径合并声明，再对每个选项把定义收集、过滤、检查、合并。它的全部状态都是属性集和函数，没有一样东西需要 `lib`。mkOption、mkIf 和 mkOverride 都只是带一个 `_type` 字符串的普通属性集，求值器靠 `_type` 认出它们：

```nix
  isOption = v: builtins.isAttrs v && (v._type or "") == "option";
  isIf = v: builtins.isAttrs v && (v._type or "") == "if";
  isOverride = v: builtins.isAttrs v && (v._type or "") == "override";

  mkOption = args: args // { _type = "option"; };
  mkOverride = priority: content: {
    _type = "override";
    inherit priority content;
  };
  mkDefault = mkOverride 1000;
  mkForce = mkOverride 50;
  mkIf = condition: content: {
    _type = "if";
    inherit condition content;
  };

  # 选项的默认值是优先级 1500 的定义，任何人写的值都能盖过它。
  defaultPriority = 1500;
  plainPriority = 100;
```

`lib/modules.nix` 用的是同一个技巧：`mkIf` 在 L1545，`mkMerge` 在 L1554，`mkOverride` 在 L1564，都是 `{ _type = "..."; ... }`。`_type` 不是一个类型系统，是一个约定的标签，所以你可以在 `nix eval` 里直接看到它们：

```text
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; in lib.mkIf true { a = 1; }'
{ _type = "if"; condition = true; content = { a = 1; }; }
```

（手敲，不在 `lab/ch15/` 里）

### config 是一个定点

骨架的核心是 `evalMini` 里的这几行：

```nix
  evalMini =
    { modules }:
    let
      # 模块函数拿到的 config 就是最终的 config：定点。
      applyModule =
        m:
        if builtins.isFunction m then
          m { inherit config; }
        else if builtins.isPath m then
          applyModule (import m)
        else
          m;

      # 和 lib.evalModules 一样先收顶层模块，再收它们的 imports（逐层），
      # 定义按这个顺序倒过来排：同优先级的列表定义，后写的模块在前。
      collect =
        ms:
        let
          applied = map applyModule ms;
          next = builtins.concatMap (m: m.imports or [ ]) applied;
        in
        applied ++ (if next == [ ] then [ ] else collect next);

      all = collect modules;
      reversed = builtins.genList (i: builtins.elemAt all (builtins.length all - 1 - i)) (
        builtins.length all
      );
      options = mergeDeclarations [ ] (map (m: m.options or { }) all);
      # ...
      config = build [ ] options;
    in
    {
      inherit config options;
    };
```

`applyModule` 把模块函数应用到 `{ inherit config; }`，而这个 `config` 就是同一个 `let` 里最后一行 `config = build [ ] options` 绑定的那个。每个模块函数拿到的都是**最终**的 `config`，不是“到目前为止”的 `config`。这是[第 3 篇](/posts/nix-by-firn-03-functions-and-laziness/)里 `fix` 的样子：`config` 是一个 thunk，被求值时它需要的别的 thunk 会各自去求值，只要没有环，就能收敛。

我只用一个跨领域的比喻，用完就放下：`config` 像一张电子表格。每个选项是一个格子，模块 A 的公式引用模块 B 的格子，没人关心哪个模块先加载，求值器只关心依赖有没有成环。`mini_lazy_config.nix` 用这张表做实验：模块 A 读 `config.x` 和 `config.y`，`x` 由模块 B 定义，A 和 B 的顺序反过来结果一样；B 里还有两个没人该去求值的定义，一个是 `throw "never forced"`，没人读它，另一个是 `guarded` 选项的 `mkIf false (throw ...)`，它应当回到默认值：

```nix
  moduleA =
    { config, ... }:
    {
      options.sum = mkOption { type = types.int; };
      config.sum = config.x + config.y;
    };

  moduleB = {
    options = {
      x = mkOption { type = types.int; };
      y = mkOption {
        type = types.int;
        default = 10;
      };
      unused = mkOption { type = types.str; };
      guarded = mkOption {
        type = types.str;
        default = "default";
      };
    };
    config.x = 32;
    config.unused = throw "never forced";
    config.guarded = mkIf false (throw "mkIf false never forces its content");
  };
# ...
in
{
  forward = forward.sum;
  backward = backward.sum;
  sameResult = forward.sum == backward.sum;
  guarded = forward.guarded;
}
```

```text
$ cat out/ch15/mini_lazy_config.stdout
{ backward = 42; forward = 42; guarded = "default"; sameResult = true; }
```

`forward` 和 `backward` 都是 42，`unused` 的 `throw` 从来没有触发。这不是巧合，是 `build` 用 `builtins.mapAttrs` 对选项树建立了一棵惰性的结果树：`config.sum` 只会去求值 `sum` 这个选项，求值它时 `select` 只看每个模块的 `config` 有没有这个属性名，不会碰 `unused` 的值。

我的 `evalMini` 对选项的合并是“每个选项把所有模块扫一遍”：`evalOption` 里的 `fromModules` 对排好序的 `reversed` 里每个模块调用 `select`。选项很少的时候这没有问题。`lib/modules.nix` 做得不一样：`mergeModules'`(L787)先用 `zipAttrs` 把所有模块的声明按属性名分组，再把所有定义也按属性名分组，然后沿着属性名一层层往下递归，只在某一层所有声明都是选项时才去 `evalOptionValue`(L1102)。我没有跑过“每个选项扫一遍”的版本，只是算了一下：16555 个选项乘上 `module-list.nix` 里的 2093 个条目，约 3465 万次 `select`，光数字就让我不想试。

### 声明、定义、evalOption

选项求值的全部逻辑在 `evalOption` 里：

```nix
      evalOption =
        loc: opt:
        let
          fromModules = builtins.concatMap (m: select loc (m.config or { })) reversed;
          fromDefault = if opt ? default then [ (mkOverride defaultPriority opt.default) ] else [ ];
          resolved = builtins.filter (d: d.active) (map resolve (fromModules ++ fromDefault));
          best = builtins.foldl' (a: d: if d.priority < a then d.priority else a) 1000000 resolved;
          winners = map (d: d.value) (builtins.filter (d: d.priority == best) resolved);
          bad = builtins.filter (v: !opt.type.check v) winners;
        in
        if resolved == [ ] then
          throw "firn: option '${showLoc loc}' is used but not defined"
        else if bad != [ ] then
          throw "firn: option '${showLoc loc}' has type ${opt.type.name} but got ${show (builtins.head bad)}"
        else
          opt.type.merge loc winners;
```

五步：

1. `fromModules`：收集所有模块里这个路径上的定义，`fromDefault`：选项自己的 `default` 当作一个优先级 1500 的定义
2. `resolve` 把每个定义拆成 `{ active; priority; value }`，`mkIf` 条件为假的定义 `active = false`，被 `filter` 丢掉
3. `best` 是剩下的定义里最小的优先级数字，`winners` 是优先级等于 `best` 的那些
4. 只对 `winners` 做类型检查；一个输掉的定义，哪怕类型不对，也不会报错
5. `opt.type.merge` 把赢家合成一个值

第 4 步这个“只检查赢家”的行为值得验证。我给 `port` 声明 `int`，然后写一个 `mkDefault "8080"`（类型不对，优先级 1000）和一个普通的 `80`（类型对，优先级 100），mini 和真的 `lib.evalModules` 各来一遍：

```text
$ nix eval --impure --expr 'let mini = import ./modules/mini-modules.nix; in (mini.evalMini { modules = [ { options.port = mini.mkOption { type = mini.types.int; }; } { config.port = mini.mkDefault "8080"; } { config.port = 80; } ]; }).config'
{ port = 80; }
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; in (lib.evalModules { modules = [ { options.port = lib.mkOption { type = lib.types.int; }; } { port = lib.mkDefault "8080"; } { port = 80; } ]; }).config.port'
80
```

（手敲，不在 `lab/ch15/` 里）

两边都是 80，没人抱怨那个字符串。真的实现里，`mergeDefinitions`(L1187)在 `filterOverrides'` 之后才检查 `defsFinal`(L1255)，顺序和我的一致。后果是：输掉的定义哪怕类型不对，也没有人会发现；赢了但类型不对的定义，要等有人读那个选项时才报错。

`mini_basic.nix` 把三个模块串起来：一个声明选项，一个只写定义，一个是读 `config` 的函数：

```nix
let
  mini = import ../../modules/mini-modules.nix;
  inherit (mini) evalMini mkOption types;

  declarations =
    { ... }:
    {
      options = {
        greeting = mkOption {
          type = types.str;
          default = "hello";
        };
        name = mkOption { type = types.str; };
        port = mkOption {
          type = types.int;
          default = 8080;
        };
        message = mkOption { type = types.str; };
      };
    };

  definitions = {
    config.name = "firn";
  };

  derived =
    { config, ... }:
    {
      config.message = "${config.greeting}, ${config.name}";
    };
in
(evalMini {
  modules = [
    declarations
    definitions
    derived
  ];
}).config
```

```text
$ cat out/ch15/mini_basic.stdout
{ greeting = "hello"; message = "hello, firn"; name = "firn"; port = 8080; }
```

`greeting` 和 `port` 用的是 `default`，`name` 来自 `definitions`，`message` 是 `derived` 把 `config.greeting` 和 `config.name` 拼起来。`nix eval --file` 把属性集按键排序打印，所以输出里是 `greeting`、`message`、`name`、`port` 的字母顺序，和我写的顺序无关。

## 类型和合并

类型在模块系统里干两件事：`check` 判断一个值合不合格，`merge` 把多个定义合成一个。我的 mini 只有五个：

```nix
  conflict = loc: throw "firn: option '${showLoc loc}' has conflicting definitions";

  # 标量：所有定义必须相等。
  mergeEqual =
    loc: defs:
    let
      first = builtins.head defs;
    in
    if builtins.all (d: d == first) defs then first else conflict loc;

  scalar = name: check: {
    inherit name check;
    merge = mergeEqual;
  };

  types = {
    str = scalar "str" builtins.isString;
    int = scalar "int" builtins.isInt;
    bool = scalar "bool" builtins.isBool;

    listOf = elem: {
      name = "listOf ${elem.name}";
      check = v: builtins.isList v && builtins.all elem.check v;
      merge = _loc: defs: builtins.concatLists defs;
    };

    attrsOf = elem: {
      name = "attrsOf ${elem.name}";
      check = v: builtins.isAttrs v && builtins.all elem.check (builtins.attrValues v);
      merge =
        loc: defs:
        builtins.mapAttrs (name: values: elem.merge (loc ++ [ name ]) values) (
          builtins.zipAttrsWith (_name: values: values) defs
        );
    };
  };
```

`str`、`int` 和 `bool` 共用 `mergeEqual`：所有赢家必须相等，不相等就是冲突。`listOf` 的 `merge` 是把所有列表拼起来，`attrsOf` 按属性名分组，每个名字下的值交给元素类型的 `merge`。真的 `lib/types.nix` 里，`str` 在 L519，`merge = mergeEqualOption`，`mergeEqualOption` 在 `lib/options.nix` 的 L500；`lines` 在 L581(`separatedString "\n"`)，`listOf` 在 L708，`attrsOf` 在 L947，`submodule` 在 L1300。

先看 mini 的两种失败。`mini_type_fail.nix` 给 `int` 选项写了一个字符串，`mini_conflict_fail.nix` 给同一个 `int` 选项写了 8080 和 9090：

```nix
let
  mini = import ../../modules/mini-modules.nix;
  inherit (mini) evalMini mkOption types;
  result =
    (evalMini {
      modules = [
        { options.port = mkOption { type = types.int; }; }
        { config.port = "8080"; }
      ];
    }).config;
in
builtins.deepSeq result result
```

```nix
let
  mini = import ../../modules/mini-modules.nix;
  inherit (mini) evalMini mkOption types;
  result =
    (evalMini {
      modules = [
        { options.port = mkOption { type = types.int; }; }
        { config.port = 8080; }
        { config.port = 9090; }
      ];
    }).config;
in
builtins.deepSeq result result
```

两个实验结尾都有 `builtins.deepSeq result result`，这不是装饰。`nix eval --file` 打印一个属性集时，遇到出错的属性只会把它显示成 `«error: ...»`，退出码仍然是 0。我把同一个类型错误不加 `deepSeq` 直接打印，让你看到这个行为：

```text
$ nix eval --impure --expr 'let mini = import ./modules/mini-modules.nix; in (mini.evalMini { modules = [ { options.port = mini.mkOption { type = mini.types.int; }; } { config.port = "8080"; } ]; }).config'; echo "exit: $?"
{ port = «error: firn: option 'port' has type int but got "8080"»; }
exit: 0
```

（手敲，不在 `lab/ch15/` 里）

没有 `deepSeq`，错误被吞进了输出里，`make ch15` 就会把一个本该失败的实验判成通过。有了它，两个实验都以非零退出码结束，错误文本在 stderr 的最后一行：

```text
$ tail -n 1 out/ch15/mini_type_fail.stderr
       error: firn: option 'port' has type int but got "8080"
$ tail -n 1 out/ch15/mini_conflict_fail.stderr
       error: firn: option 'port' has conflicting definitions
```

我给 mini 的错误文本选了一行：选项路径、期望的类型、实际的值。真正的模块系统要啰嗦得多，而且啰嗦得有道理。`real_type_fail.nix` 把 `cairn.keep.last` 设成 0，它的类型是 `types.ints.positive`(L462, `addCheck lib.types.int (x: x > 0)`)；`real_conflict_fail.nix` 让两个模块给 `cairn.repo` 写了不同的字符串：

```nix
let
  pkgs = import ../../nix/pkgs.nix { };
  evaluated = pkgs.lib.evalModules {
    modules = [
      ../../modules/cairn-settings.nix
      {
        _file = "lab/ch15/real_type_fail.nix";
        cairn = {
          repo = "/var/lib/cairn/repo";
          keep.last = 0;
        };
      }
    ];
  };
in
evaluated.config.cairn.configText
```

```nix
let
  pkgs = import ../../nix/pkgs.nix { };
  evaluated = pkgs.lib.evalModules {
    modules = [
      ../../modules/cairn-settings.nix
      {
        _file = "team-a.nix";
        cairn.repo = "/srv/backup-a";
      }
      {
        _file = "team-b.nix";
        cairn.repo = "/srv/backup-b";
      }
    ];
  };
in
evaluated.config.cairn.configText
```

```text
$ tail -n 2 out/ch15/real_type_fail.stderr
       error: A definition for option `cairn.keep.last' is not of type `positive integer, meaning >0'. Definition values:
       - In `lab/ch15/real_type_fail.nix': 0
$ tail -n 5 out/ch15/real_conflict_fail.stderr

       error: The option `cairn.repo' has conflicting definition values:
       - In `team-b.nix': "/srv/backup-b"
       - In `team-a.nix': "/srv/backup-a"
       Use `lib.mkForce value` or `lib.mkDefault value` to change the priority on any of these definitions.
```

类型错误的文本在 `mergeDefinitions` 的 L1261：选项路径、类型的描述(`positive integer, meaning >0`)、以及每个不合格的定义和它所在的文件。文件名能出现，是因为我在模块里写了 `_file = "lab/ch15/real_type_fail.nix"`；不写的话，内联的模块只能显示 `<unknown-file>`，路径形式的模块则显示文件路径。冲突的文本来自 `mergeEqualOption`：它列出两个冲突的定义和它们的文件，并且告诉你怎么办，`lib.mkForce` 或者 `lib.mkDefault`，也就是“优先级”一节的主题。

有一个细节我没料到：冲突里 `team-b.nix` 先于 `team-a.nix` 列出，和我写的模块顺序相反。这不是报错路径特有的，同一个原因影响所有合并的顺序，我留到“合并顺序”那一节。

## 优先级

两个模块给同一个标量写了不同的值，冲突，除非有人说“我的更重要”。这就是优先级。规则很简单：每个定义有一个数字，数字**小**的赢，同一个数字的再按类型合并。`mini_priority.nix` 对一个选项试了五种组合，每一个是一次独立的求值：

```nix
  declare = {
    options.level = mkOption {
      type = types.str;
      default = "option default (1500)";
    };
  };

  levelOf =
    defs:
    (evalMini {
      modules = [ declare ] ++ map (value: { config.level = value; }) defs;
    }).config.level;
in
{
  onlyOptionDefault = levelOf [ ];
  mkDefaultBeatsOptionDefault = levelOf [ (mkDefault "mkDefault (1000)") ];
  plainBeatsMkDefault = levelOf [
    (mkDefault "mkDefault (1000)")
    "plain (100)"
  ];
  mkForceBeatsPlain = levelOf [
    "plain (100)"
    (mkForce "mkForce (50)")
    (mkDefault "mkDefault (1000)")
  ];
  # 顺序无关：定义列表反过来结果一样。
  orderDoesNotMatter = levelOf [
    (mkDefault "mkDefault (1000)")
    (mkForce "mkForce (50)")
    "plain (100)"
  ];
}
```

```text
$ cat out/ch15/mini_priority.stdout
{ mkDefaultBeatsOptionDefault = "mkDefault (1000)"; mkForceBeatsPlain = "mkForce (50)"; onlyOptionDefault = "option default (1500)"; orderDoesNotMatter = "mkForce (50)"; plainBeatsMkDefault = "plain (100)"; }
```

`onlyOptionDefault` 是选项自己的 `default`(1500)；`mkDefault`(1000)盖过它；普通定义(100)盖过 `mkDefault`；`mkForce`(50)盖过普通定义。最后一个例子把定义列表反过来，结果一样，说明优先级和模块顺序无关。

这几个数字不是我选的，是我从 `lib/modules.nix` 抄来的。真的数字在 L1569 到 L1574，我把这几行连同行号打印出来：

```text
$ NIXPKGS="$(nix eval --raw --impure --expr '(import ./nix/pins.nix).nixpkgs')"
$ sed -n '1569,1574p' "${NIXPKGS}/lib/modules.nix" | nl -ba -v1569
  1569	  mkOptionDefault = mkOverride 1500; # priority of option defaults
  1570	  mkDefault = mkOverride 1000; # used in config sections of non-user modules to set a default
  1571	  defaultOverridePriority = 100;
  1572	  mkImageMediaOverride = mkOverride 60; # image media profiles can be derived by inclusion into host config, hence needing to override host config, but do allow user to mkForce
  1573	  mkForce = mkOverride 50;
  1574	  mkVMOverride = mkOverride 10; # used by ‘nixos-rebuild build-vm’
```

（手敲，不在 `lab/ch15/` 里）

六个名字，六个数字（我用了这么久的 `mkForce`，它只是个 50）：

| 名字 | 优先级 | 位置 | 用在哪 |
| --- | --- | --- | --- |
| `mkOptionDefault` | 1500 | L1569 | 选项的 `default`；`evalOptionValue` 在 L1111 把 `opt.default` 包成它 |
| `mkDefault` | 1000 | L1570 | 非用户模块里写的默认值 |
| `defaultOverridePriority` | 100 | L1571 | 普通定义，没有 `mkOverride` 包着的值 |
| `mkImageMediaOverride` | 60 | L1572 | 镜像 profile 要盖过宿主配置，又要让用户的 `mkForce` 盖过它 |
| `mkForce` | 50 | L1573 | 强制 |
| `mkVMOverride` | 10 | L1574 | `nixos-rebuild build-vm` 用 |

我再让求值器自己把这些数字吐出来，免得只信我抄的：

```text
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; in { inherit (lib.modules) defaultOverridePriority defaultOrderPriority; mkOptionDefault = (lib.mkOptionDefault 0).priority; mkDefault = (lib.mkDefault 0).priority; mkImageMediaOverride = (lib.mkImageMediaOverride 0).priority; mkForce = (lib.mkForce 0).priority; mkVMOverride = (lib.mkVMOverride 0).priority; mkBefore = (lib.mkBefore 0).priority; mkAfter = (lib.mkAfter 0).priority; }'
{ defaultOrderPriority = 1000; defaultOverridePriority = 100; mkAfter = 1500; mkBefore = 500; mkDefault = 1000; mkForce = 50; mkImageMediaOverride = 60; mkOptionDefault = 1500; mkVMOverride = 10; }
```

（手敲，不在 `lab/ch15/` 里）

`defaultOrderPriority = 1000` 和 `mkBefore`、`mkAfter` 的 500 和 1500 是另一套数字，管顺序，不管输赢，“合并顺序”一节再说。

选哪个定义不用任何魔法。`filterOverrides'`(L1417)先给每个定义算优先级（L1419 到 L1420：被 `mkOverride` 包着的取它的 `priority`，否则是 `defaultOverridePriority`），再取最小值，最后只留下等于最小值的：

```text
$ sed -n '1419,1420p' "$(nix eval --raw --impure --expr '(import ./nix/pins.nix).nixpkgs')/lib/modules.nix" | nl -ba -v1419
  1419	      getPrio =
  1420	        def: if def.value._type or "" == "override" then def.value.priority else defaultOverridePriority;
$ sed -n '1430,1433p' "$(nix eval --raw --impure --expr '(import ./nix/pins.nix).nixpkgs')/lib/modules.nix" | nl -ba -v1430
  1430	      }
  1431	    else
  1432	      let
  1433	        highestPrio = foldl' (prio: def: min (getPrio def) prio) 9999 defs;
```

（手敲，不在 `lab/ch15/` 里）

这个 `foldl'` 和我 `evalOption` 里的 `best` 是同一件事，差别只是初值：真的用 9999，我用 1000000。

## mkIf 和惰性

条件配置是模块系统里最常见的写法：`config = mkIf cfg.enable { ... }`。为什么不能写 `config = if cfg.enable then { ... } else { }`？我在 mini 里把答案写在了 `select` 的注释里：

```nix
  # 把一个定义拆成 { active, priority, value }；mkIf 的条件只在 active 被用到时才求值。
  resolve =
    def:
    if isIf def then
      # 条件为假时不碰 content：mkIf false (throw "…") 是安全的。
      if def.condition then
        resolve def.content
      else
        {
          active = false;
          priority = plainPriority;
          value = null;
        }
    else if isOverride def then
      (resolve def.content) // { inherit (def) priority; }
    else
      {
        active = true;
        priority = plainPriority;
        value = def;
      };

  # 在一个模块的 config 里找 path 处的定义。mkIf 往下推：
  # 只看 content 的属性名，不碰条件，这就是 mkIf 不会递归的原因。
  select =
    path: cfg:
    if path == [ ] then
      [ cfg ]
    else if isIf cfg then
      map (mkIf cfg.condition) (select path cfg.content)
    else if builtins.isAttrs cfg && cfg ? ${builtins.head path} then
      select (builtins.tail path) cfg.${builtins.head path}
    else
      [ ];
```

`select` 在一个模块的 `config` 里找某个路径上的定义，遇到 `mkIf` 就把它“往下推”：保留条件，只钻进 `content` 去看属性名。`cfg.content` 的属性名不依赖条件，所以不需要先知道条件的值。条件被包在每一个叶子定义里，等到 `resolve` 要判断 `active` 的时候才求值，那时所有模块的 `config` 的**形状**早已确定。`resolve` 里 `mkIf` 的分支更直接：条件为真就继续 `resolve def.content`，条件为假就返回 `active = false`，根本不碰 `content`，所以 `mkIf false (throw ...)` 是安全的；`mini_lazy_config.nix` 的 `guarded` 选项用的就是这一点。

真的实现是 `pushDownProperties`(L1337)，做的是同一件事：

```text
$ sed -n '1350,1356p' "$(nix eval --raw --impure --expr '(import ./nix/pins.nix).nixpkgs')/lib/modules.nix" | nl -ba -v1350
  1350	    if cfg._type or "" == "merge" then
  1351	      concatMap pushDownProperties cfg.contents
  1352	    else if cfg._type or "" == "if" then
  1353	      map (mapAttrsIfAttrs (n: v: mkIf cfg.condition v)) (pushDownProperties cfg.content)
  1354	    else if cfg._type or "" == "override" then
  1355	      map (mapAttrsIfAttrs (n: v: mkOverride cfg.priority v)) (pushDownProperties cfg.content)
  1356	    # FIXME: handle mkOrder?
```

（手敲，不在 `lab/ch15/` 里）

`mkIf` 那个分支（L1352 到 L1353）对 `content` 的每个属性调用 `mkIf cfg.condition v`：属性名从 `content` 来，条件只是跟着每个值走。`if cfg.enable then { out = ...; } else { }` 就没有这个待遇：`config` 本身的**形状**（有没有 `out` 这个属性）取决于 `cfg.enable`，而 `cfg.enable` 要去收集所有模块的 `config` 里对 `demo.enable` 的定义，其中包括这个模块自己的 `config`，于是自己等自己。这是练习 1，答案是 `lab/ch15/ex_mkif.sh`：它分别求值两个只有 `config` 写法不同的 fixture，`if` 的那个递归，`mkIf` 的那个返回 `"on"`。

真的实现在选项这一层同样不碰条件为假的 `content`：`dischargeProperties` 的 L1383 是 `if def.condition then dischargeProperties def.content else [ ]`。“mini 少了什么”一节里我让两边各跑一遍同一个表达式。

`mkIf` 常和 `mkMerge` 配合：一个定义可以是 `mkMerge [ ... ]`，里面每一项各自带条件。我的 mini 没有 `mkMerge`，真的有(L1554)：它把几项捆成一个定义，`dischargeProperties` 在 L1379 到 L1380 把它拆开，每一项各自走一遍，`mkIf false` 的那些被丢掉，同一个 `mkMerge` 里的顺序保持不变：

```text
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; in (lib.evalModules { modules = [ { options.x = lib.mkOption { type = lib.types.listOf lib.types.str; }; } { x = lib.mkMerge [ (lib.mkIf true [ "a" ]) (lib.mkIf false [ "b" ]) [ "c" ] ]; } ]; }).config.x'
[ "a" "c" ]
```

（手敲，不在 `lab/ch15/` 里）

`config = mkMerge [ (mkIf cfg.a { ... }) (mkIf cfg.b { ... }) ]` 是 NixOS 模块里条件配置的常见形状，每个 `mkIf` 管一块，互不干扰。

## 合并顺序

优先级决定谁赢，`mkOrder` 决定赢家们的排列顺序，只对列表和 `lines` 这类有顺序的类型有意义。`merge_order.nix` 用三个模块给 `steps`(`listOf str`)和 `script`(`lines`)各写了一份，再加上不带任何包装的两个：

```nix
  evaluated = lib.evalModules {
    modules = [
      {
        options = {
          steps = mkOption { type = types.listOf types.str; };
          script = mkOption { type = types.lines; };
        };
      }
      {
        steps = [ "plain-1" ];
        script = "plain-1";
      }
      {
        steps = mkAfter [ "after" ];
        script = mkAfter "after";
      }
      {
        steps = mkBefore [ "before" ];
        script = mkBefore "before";
      }
      {
        steps = mkOrder 750 [ "order-750" ];
        script = mkOrder 750 "order-750";
      }
      {
        steps = [ "plain-2" ];
        script = "plain-2";
      }
    ];
  };
in
{
  inherit (evaluated.config) steps;
  script = lib.splitString "\n" evaluated.config.script;
}
```

```text
$ cat out/ch15/merge_order.stdout
{ script = [ "before" "order-750" "plain-2" "plain-1" "after" ]; steps = [ "before" "order-750" "plain-2" "plain-1" "after" ]; }
```

`mkBefore` 是 `mkOrder 500`，`mkAfter` 是 `mkOrder 1500`，没有包装的定义顺序号是 `defaultOrderPriority` 也就是 1000（L1605 到 L1607）：

```text
$ sed -n '1605,1607p' "$(nix eval --raw --impure --expr '(import ./nix/pins.nix).nixpkgs')/lib/modules.nix" | nl -ba -v1605
  1605	  mkBefore = mkOrder 500;
  1606	  defaultOrderPriority = 1000;
  1607	  mkAfter = mkOrder 1500;
```

（手敲，不在 `lab/ch15/` 里）

顺序是 `before`(500)，`order-750`(750)，然后是两个顺序号为 1000 的普通定义，最后是 `after`(1500)。让我停下来的是中间那两个：我先写 `plain-1`，后写 `plain-2`，结果却是 `plain-2` 在前。`sortProperties`(L1451)的比较是 `a.priority < b.priority`，同号的定义保持输入顺序，所以问题在输入顺序本身。`evalModules` 在 L274 有一行：

```text
$ sed -n '274p' "$(nix eval --raw --impure --expr '(import ./nix/pins.nix).nixpkgs')/lib/modules.nix" | nl -ba -v274
   274	      merged = mergeModules prefix (reverseList (doCollect { }).modules);
```

（手敲，不在 `lab/ch15/` 里）

`reverseList`：收集到的模块列表在合并之前被整个反过来。我不确定为什么，也没有去翻这一行的提交记录。同号的定义保持输入顺序还要靠 `sort` 是稳定的，我先拿一个小例子确认这一点，再把现象量出来：两个模块，顺序对调，列表选项的结果也对调；再加一个带 `imports` 的模块，看导入的模块排在哪里；最后让我的 mini 跑同样的事。

```text
$ nix eval --impure --expr 'builtins.sort (a: b: a.p < b.p) [ { p = 1; n = "a"; } { p = 1; n = "b"; } { p = 0; n = "c"; } { p = 1; n = "d"; } ]'
[ { n = "c"; p = 0; } { n = "a"; p = 1; } { n = "b"; p = 1; } { n = "d"; p = 1; } ]
```

（手敲，不在 `lab/ch15/` 里）

`c` 排到了队首，`a`、`b`、`d` 保持输入顺序。接着是模块顺序的实验：

```text
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; run = ms: (lib.evalModules { modules = [ { options.steps = lib.mkOption { type = lib.types.listOf lib.types.str; }; } ] ++ ms; }).config.steps; in { forward = run [ { steps = [ "a" ]; } { steps = [ "b" ]; } ]; backward = run [ { steps = [ "b" ]; } { steps = [ "a" ]; } ]; }'
{ backward = [ "a" "b" ]; forward = [ "b" "a" ]; }
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; in (lib.evalModules { modules = [ { options.steps = lib.mkOption { type = lib.types.listOf lib.types.str; }; } { imports = [ { steps = [ "imported" ]; } ]; steps = [ "a" ]; } { steps = [ "b" ]; } ]; }).config.steps'
[ "imported" "b" "a" ]
$ nix eval --impure --expr 'let mini = import ./modules/mini-modules.nix; in (mini.evalMini { modules = [ { options.steps = mini.mkOption { type = mini.types.listOf mini.types.str; }; } { config.steps = [ "a" ]; } { config.steps = [ "b" ]; } ]; }).config.steps'
[ "b" "a" ]
$ nix eval --impure --expr 'let mini = import ./modules/mini-modules.nix; in (mini.evalMini { modules = [ { options.steps = mini.mkOption { type = mini.types.listOf mini.types.str; }; } { imports = [ { config.steps = [ "imported" ]; } ]; config.steps = [ "a" ]; } { config.steps = [ "b" ]; } ]; }).config.steps'
[ "imported" "b" "a" ]
```

（手敲，不在 `lab/ch15/` 里）

这一点 mini 和真的一致：同顺序号的定义按模块顺序的**反方向**排，导入的模块排在队首。我的 `collect` 先收顶层模块，再逐层收 `imports`，最后把整个列表反过来，和 L274 的 `reverseList` 是同一个意思，所以 mini 给出 `[ "b" "a" ]` 和 `[ "imported" "b" "a" ]`，和真的逐个相等；`merge_order.nix` 的文件头注释也是这么写的。如果你在乎列表的顺序，仍然别靠它：用 `mkBefore`、`mkAfter` 或 `mkOrder` 明说。

## 子模块

选项的值还可以是一堆小模块：`types.attrsOf (types.submodule job)`，每个键得到一份独立的求值，键就是 `name`。`submodule.nix` 声明一个 `jobs` 选项，两个顶层模块各定义同一个 job 的不同字段：

```nix
  job =
    { name, config, ... }:
    {
      options = {
        title = mkOption {
          type = types.str;
          default = "job ${name}";
        };
        sources = mkOption {
          type = types.listOf types.str;
          default = [ ];
        };
        summary = mkOption {
          type = types.str;
          readOnly = true;
        };
      };
      config.summary = "${config.title}: ${toString (builtins.length config.sources)} source(s)";
    };

  evaluated = lib.evalModules {
    modules = [
      { options.jobs = mkOption { type = types.attrsOf (types.submodule job); }; }
      {
        jobs.home.sources = [ "/home/alice" ];
        jobs.etc.title = "system config";
      }
      {
        jobs.home.sources = [ "/home/bob" ];
        jobs.etc.sources = [ "/etc" ];
      }
    ];
  };
in
lib.mapAttrs (_: j: { inherit (j) title sources summary; }) evaluated.config.jobs
```

```text
$ cat out/ch15/submodule.stdout
{ etc = { sources = [ "/etc" ]; summary = "system config: 1 source(s)"; title = "system config"; }; home = { sources = [ "/home/alice" "/home/bob" ]; summary = "job home: 2 source(s)"; title = "job home"; }; }
```

`jobs.home.sources` 在两个模块里各写了一个，合成 `[ "/home/alice" "/home/bob" ]`，因为 `sources` 是 `listOf str`；`jobs.etc.title` 只有第一个模块写了，`jobs.etc.sources` 只有第二个。`summary` 是 `readOnly` 的，它的值来自子模块自己的 `config`，用了子模块自己的 `config.title` 和 `config.sources`。`title` 的 `default` 用了 `name`：`job home` 和 `job etc` 里的 `home`、`etc` 就是键。

`name` 是哪来的？看 `lib/types.nix` 里 `submoduleWith`(L1391)。每个键的合并在 L1477 调用一次 `base.extendModules`，并且给它一个模块 `{ _module.args.name = last loc; }`(L1478)。所以 `name` 不是 `specialArgs`，是 `_module.args`，“specialArgs 和 _module.args”一节会讲两者的区别。每个键一份独立的 `extendModules`，意味着 `attrsOf (submodule ...)` 里有多少个键，就有多少次小型的 `evalModules`；这大概是 NixOS 里 `systemd.services.<name>` 这类选项不便宜的原因之一，我没有量。

我的 mini 没有子模块，这是它最大的缺口之一：`submodule` 要求求值器能递归地调用自己，并且为每个键重新建一个定点。

## specialArgs 和 _module.args

模块函数的参数从两个地方来：`specialArgs` 和 `_module.args`。它们看上去一样，在 `imports` 里的区别最要紧。`evalModules` 在 L269 到 L271 构造了收集模块用的参数：`config` 加上 `specialArgs` 展开。我把那串很长的提示文字缩成了 `...`，其余原样：

```text
$ sed -n '269,271p' "$(nix eval --raw --impure --expr '(import ./nix/pins.nix).nixpkgs')/lib/modules.nix" | sed 's/addErrorContext ".*" config/addErrorContext "..." config/' | nl -ba -v269
   269	            config = addErrorContext "..." config;
   270	          }
   271	          // specialArgs
```

（手敲，不在 `lab/ch15/` 里）

L269 的 `config = addErrorContext "..." config` 是说：这些参数在**收集模块**的时候就已经给了模块函数，所以 `specialArgs` 里的名字是现成的值，能用在 `imports` 里。`_module.args` 里的名字不在这里，它们要通过 `config._module.args.${name}` 现取(L731)，而 `config` 要等所有模块收集完才有：

```text
$ sed -n '729,731p' "$(nix eval --raw --impure --expr '(import ./nix/pins.nix).nixpkgs')/lib/modules.nix" | nl -ba -v729
   729	          args.${name} or (addErrorContext
   730	            "noting that argument `${name}` is not externally provided, so querying `_module.args` instead, requiring `config`"
   731	            config._module.args.${name}
```

（手敲，不在 `lab/ch15/` 里）

`specialargs.nix` 把两种用法并排放：`specialArgs.flavor` 决定导入哪个模块，`_module.args.suffix` 只在函数体里用：

```nix
  evaluated = lib.evalModules {
    specialArgs.flavor = "sweet";
    modules = [
      (
        { flavor, ... }:
        {
          imports = [ (if flavor == "sweet" then sweet else salty) ];
        }
      )
      (
        { suffix, flavor, ... }:
        {
          options.out = lib.mkOption { type = lib.types.str; };
          config = {
            _module.args.suffix = "!";
            out = "${flavor}${suffix}";
          };
        }
      )
    ];
  };
```

```text
$ cat out/ch15/specialargs.stdout
{ declared = [ "dessert" "out" ]; out = "sweet!"; }
```

`flavor` 是 `specialArgs`，所以 `imports = [ (if flavor == "sweet" then sweet else salty) ]` 成立，只导入了 `sweet`，`declared` 里有 `dessert` 没有 `snack`；`suffix` 是 `_module.args`，只在 `out = "${flavor}${suffix}"` 里读，得到 `sweet!`。

反过来会怎么样？`imports_pkgs_recursion_fail.nix` 在 `imports` 里读 `_module.args` 的值：

```nix
  evaluated = lib.evalModules {
    modules = [
      (
        { extra, ... }:
        {
          imports = if extra then [ { options.x = lib.mkOption { default = 1; }; } ] else [ ]; # BAD
        }
      )
      { _module.args.extra = true; }
    ];
  };
in
evaluated.config.x
```

```text
$ grep -E 'noting that|if you get an infinite|error: infinite' out/ch15/imports_pkgs_recursion_fail.stderr
       … noting that argument `extra` is not externally provided, so querying `_module.args` instead, requiring `config`
       … if you get an infinite recursion here, you probably reference `config` in `imports`. If you are trying to achieve a conditional import behavior dependent on `config`, consider importing unconditionally, and using `mkEnableOption` and `mkIf` to control its effect.
       error: infinite recursion encountered
```

这个错误会出现在你第一次试着在 `imports` 里用 `pkgs` 的时候。`pkgs` 在 NixOS 里是 `_module.args.pkgs`（定义在 [`nixos/modules/misc/nixpkgs.nix` 的 L353](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/misc/nixpkgs.nix#L353) 起的 `_module.args` 里），所以 `imports = [ (pkgs.callPackage ...) ]` 这种写法一定递归：`imports` 要在 `config` 之前展开，`pkgs` 要在 `config` 之后取。错误文本把这个因果写得很清楚，连解决办法也给了（先无条件导入，再用 `mkEnableOption` 和 `mkIf` 控制效果）；要用外面的值决定导入什么，就走 `specialArgs`。

我的 mini 有同样的结构性问题：`collect` 要读每个模块的 `imports`，而模块函数拿到的 `config` 是最终的 `config`。让 `imports` 依赖 `config`，mini 同样递归，只是不会告诉你为什么：

```text
$ nix eval --impure --expr 'let mini = import ./modules/mini-modules.nix; in (mini.evalMini { modules = [ ({ config, ... }: { imports = if config.flag then [ { options.y = mini.mkOption { type = mini.types.int; default = 1; }; } ] else [ ]; }) { options.flag = mini.mkOption { type = mini.types.bool; default = true; }; } ]; }).config' 2>&1 | grep 'error: '
       error: infinite recursion encountered
```

（手敲，不在 `lab/ch15/` 里）

只有一行 `error: infinite recursion encountered`，没有 `noting that argument ...`，也没有指向 `imports` 的提示。真的实现里那几行提示是 `addErrorContext`（L269 和 L730）加的，整个 `lib/modules.nix` 里这类上下文随处可见，我的 mini 一条也没有。

## 值是从哪来的

回到开头那个实验。`where_defined.nix` 问了四件事：值是什么，选项在哪个文件里声明，哪些定义赢了，最高优先级是多少：

```nix
  evaluated = lib.evalModules {
    modules = [
      ../../modules/cairn-settings.nix
      {
        _file = "defaults.nix";
        cairn.repo = lib.mkDefault "/var/lib/cairn/repo";
      }
      {
        _file = "host.nix";
        cairn.repo = "/srv/backup";
      }
    ];
  };

  inherit (evaluated.options.cairn) repo;
in
{
  value = evaluated.config.cairn.repo;
  declarations = map (lib.removePrefix root) repo.declarations;
  definitions = map (d: {
    inherit (d) file;
    value = d.value;
  }) repo.definitionsWithLocations;
  highestPrio = repo.highestPrio;
}
```

`declarations` 是声明所在的文件，`definitionsWithLocations` 是 `{ file; value; }` 的列表。注意输出里 `definitions` 只有 `host.nix`，没有 `defaults.nix`：`definitionsWithLocations` 在 L1153 被设成 `res.defsFinal`，也就是经过 `filterOverrides'` 和 `sortProperties` 之后留下的那些，输掉的 `mkDefault` 不在里面。所以它回答的是“**谁**决定了这个值”，不是“谁写过这个选项”；输掉的定义在选项对象里找不到，我也没有找到别的接口能把它们列出来。

选项对象带着很多别的东西，我列一下属性名：

```text
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; in builtins.attrNames (lib.evalModules { modules = [ ./modules/cairn-settings.nix ]; }).options.cairn.repo'
[ "__toString" "_type" "declarationPositions" "declarations" "definitions" "definitionsWithLocations" "description" "example" "files" "highestPrio" "isDefined" "loc" "options" "type" "value" "valueMeta" ]
```

（手敲，不在 `lab/ch15/` 里）

`declarations`、`declarationPositions`、`definitions`、`definitionsWithLocations`、`files`、`highestPrio`、`isDefined`、`loc`、`type`……这些都是模块系统在合并选项时顺手留下来的元数据，`nixos-option` 这类工具靠它们回答问题（L1265 的注释提到 `nixos-option` 会识别某条错误消息）。`highestPrio` 尤其有用：它告诉你赢的是哪一档。我用同一个选项 `cairn.keep.last` 试四种情形，看 `value`、`highestPrio` 和 `definitionsWithLocations` 怎么变：

```text
$ nix eval --impure --expr 'let
  lib = (import ./nix/pkgs.nix { }).lib;
  root = toString ./. + "/";
  ev =
    ms:
    lib.evalModules {
      modules = [
        ./modules/cairn-settings.nix
        { cairn.repo = "/r"; }
      ]
      ++ ms;
    };
  show =
    e:
    let
      o = e.options.cairn.keep.last;
    in
    {
      value = e.config.cairn.keep.last;
      inherit (o) highestPrio;
      defs = map (d: {
        file = lib.removePrefix root d.file;
        inherit (d) value;
      }) o.definitionsWithLocations;
    };
in
{
  unset = show (ev [ ]);
  mkDefault = show (ev [
    {
      _file = "d.nix";
      cairn.keep.last = lib.mkDefault 6;
    }
  ]);
  plain = show (ev [
    {
      _file = "p.nix";
      cairn.keep.last = 7;
    }
  ]);
  mkForce = show (ev [
    {
      _file = "f.nix";
      cairn.keep.last = lib.mkForce 8;
    }
  ]);
}'
{ mkDefault = { defs = [ { file = "d.nix"; value = 6; } ]; highestPrio = 1000; value = 6; }; mkForce = { defs = [ { file = "f.nix"; value = 8; } ]; highestPrio = 50; value = 8; }; plain = { defs = [ { file = "p.nix"; value = 7; } ]; highestPrio = 100; value = 7; }; unset = { defs = [ { file = "modules/cairn-settings.nix"; value = 5; } ]; highestPrio = 1500; value = 5; }; }
```

（手敲，不在 `lab/ch15/` 里）

没人写的时候，`highestPrio = 1500`，唯一的定义是选项自己的 `default`，它的“文件”是声明它的 `modules/cairn-settings.nix`（`evalOptionValue` 在 L1110 用 `head opt.declarations` 当作它的位置）；`mkDefault` 是 1000，普通定义是 100，`mkForce` 是 50。每一种情形 `definitionsWithLocations` 里都只有一项。

### 整条流水线，一次调用

`mergeDefinitions` 是 `lib.modules` 导出的，可以直接调用。我给它一个 `listOf str` 类型和五个来自不同“文件”的定义，这一篇讲过的每一步都会用到：`mkDefault` 输掉，`mkIf false` 被丢，`mkBefore`、`mkAfter` 决定顺序：

```text
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; r = lib.modules.mergeDefinitions [ "x" ] (lib.types.listOf lib.types.str) [ { file = "a.nix"; value = lib.mkDefault [ "default" ]; } { file = "b.nix"; value = lib.mkAfter [ "after" ]; } { file = "c.nix"; value = lib.mkIf false [ "never" ]; } { file = "d.nix"; value = [ "plain" ]; } { file = "e.nix"; value = lib.mkBefore [ "before" ]; } ]; in { inherit (r) mergedValue; highestPrio = r.defsFinal'"'"'.highestPrio; files = map (d: d.file) r.defsFinal; }'
{ files = [ "e.nix" "d.nix" "b.nix" ]; highestPrio = 100; mergedValue = [ "before" "plain" "after" ]; }
```

（手敲，不在 `lab/ch15/` 里）

`files` 里只有 `e.nix`、`d.nix` 和 `b.nix`：`a.nix` 是 `mkDefault`(1000)，输给了普通定义(100)；`c.nix` 是 `mkIf false`，被 `dischargeProperties` 丢掉。三个赢家按顺序号排：`mkBefore`(500)、普通定义(1000)、`mkAfter`(1500)，`mergedValue` 是 `[ "before" "plain" "after" ]`，`highestPrio = 100`。流程图里这几步的先后就是这么来的：先展开 `mkIf` 和 `mkMerge`，再按优先级过滤，再按顺序号排序，最后检查类型并合并。

还有一个现成的“从哪来”：冲突和类型错误的文本本身。“类型和合并”那一节的两个真实错误都列出了定义所在的文件和值，这是 `showDefs` 干的活，也是我的 mini 最没做出来的东西。

## 它到底多大

我的 `mini-modules.nix` 是 194 行，`lib/modules.nix` 是 2342 行。这个比例不是很公平，因为我还省掉了 `lib/types.nix`（1910 行）和 `lib/options.nix`（913 行）的绝大部分。三个文件一起数：

```text
$ NIXPKGS="$(nix eval --raw --impure --expr '(import ./nix/pins.nix).nixpkgs')"
$ wc -l modules/mini-modules.nix modules/cairn-settings.nix "${NIXPKGS}/lib/modules.nix" "${NIXPKGS}/lib/types.nix" "${NIXPKGS}/lib/options.nix"
   194 modules/mini-modules.nix
    81 modules/cairn-settings.nix
  2342 /nix/store/z4wkdlk69gck09s64a8ghpn6h7bxhkyy-source/lib/modules.nix
  1910 /nix/store/z4wkdlk69gck09s64a8ghpn6h7bxhkyy-source/lib/types.nix
   913 /nix/store/z4wkdlk69gck09s64a8ghpn6h7bxhkyy-source/lib/options.nix
  5440 total
```

（手敲，不在 `lab/ch15/` 里）

194 对 2342 是 12.1 倍；194 对三个文件加起来的 5165 行是 26.6 倍。注释和文档占了不少，我没有数代码行。这些代码究竟在服务多大的东西？`nixos_option_count.sh` 求值一个最小的 NixOS 配置（`fixtures/minimal_nixos.nix`：没有服务，tmpfs 当根，不装引导加载器），数 `lib.collect lib.isOption` 能找到多少个选项，`module-list.nix` 里有多少个条目，再对 `system.build.toplevel.drvPath` 求值五次取中位数：

```nix
let
  nixpkgs = (import ../../../nix/pins.nix).nixpkgs;
in
import "${nixpkgs}/nixos" {
  system = "x86_64-linux";
  configuration = {
    boot.loader.grub.enable = false;
    fileSystems."/" = {
      device = "none";
      fsType = "tmpfs";
    };
    system.stateVersion = "26.05";
  };
}
```

```text
$ cat out/ch15/nixos_option_count.stdout
options (lib.collect lib.isOption): 16555
modules in module-list.nix: 2093
volatile: toplevel drvPath eval, median of 5: 3578 ms
```

16555 个选项，2093 个条目，这套模块系统求值一遍 `system.build.toplevel.drvPath` 的中位数是 3578 毫秒。选项数是钉住的 rev 决定的，求值时间是这台机器的、这一次的，标成 `volatile:`。`module-list.nix` 的条目数不等于求值时真的会载入的模块数（有些模块被条件导入），我没有数过后者。`lib.collect lib.isOption` 也不会钻进子模块类型的内部，所以 16555 是顶层能看到的选项，子模块里的我没有算。

拿它和 Cairn 的模块比：

```text
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; in builtins.length (lib.collect lib.isOption (lib.evalModules { modules = [ ./modules/cairn-settings.nix ]; }).options.cairn)'
7
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; in builtins.length (lib.collect lib.isOption (lib.evalModules { modules = [ ./modules/cairn-settings.nix ]; }).options)'
11
```

（手敲，不在 `lab/ch15/` 里）

`cairn` 这个前缀下有 7 个选项，加上 `evalModules` 自带的 `_module.args`、`_module.check`、`_module.freeformType` 和 `_module.specialArgs` 一共 11 个。一个有 7 个选项的模块和一个有 16555 个选项的系统走的是同一条代码路径，差别只在量。我也量了这两个量级的求值时间，`mini_basic.nix` 和 `real_eval.nix` 各跑五次：

```text
$ TIMEFORMAT='%R s'; for f in mini_basic real_eval; do echo "== ${f}"; for i in 1 2 3 4 5; do time nix eval --file "lab/ch15/${f}.nix" >/dev/null; done; done
== mini_basic
0.023 s
0.024 s
0.024 s
0.025 s
0.023 s
== real_eval
0.169 s
0.170 s
0.169 s
0.176 s
0.172 s
```

（手敲，不在 `lab/ch15/` 里）

`real_eval.nix` 每次要把 `nix/pkgs.nix` 引进来，才能拿到 nixpkgs 的 `lib`，所以它的耗时里大头不是 `evalModules`，我没有把两者分开量。这几个数字只说明一件事：一个小模块的代价很小，`real_eval.nix` 每次约 0.18 秒，最小 NixOS 的 3578 毫秒是它的二十倍上下。把 3578 毫秒平摊到 16555 个选项上，每个选项 0.22 毫秒；这个数字很粗糙，因为 `toplevel` 的求值远不止选项。

### 读一个选项，付多少钱

`config` 是惰性的，读一个选项只会求值它依赖的那部分。我拿最小 NixOS 的 `networking.hostName` 和整个 `toplevel.drvPath` 比一比，用 `NIX_SHOW_STATS=1` 让 Nix 打印求值统计，取 thunk 数、函数调用数和 CPU 时间：

```text
$ for what in os.config.networking.hostName os.config.system.build.toplevel.drvPath; do
  echo "== ${what}"
  NIX_SHOW_STATS=1 nix eval --impure --raw --expr "let os = import ./lab/ch15/fixtures/minimal_nixos.nix; in toString (${what})" 2>&1 >/dev/null | jq -c '{nrThunks, nrFunctionCalls, cpuTime}'
done
== os.config.networking.hostName
{"nrThunks":847250,"nrFunctionCalls":607854,"cpuTime":0.6314989924430847}
== os.config.system.build.toplevel.drvPath
{"nrThunks":7371514,"nrFunctionCalls":4686368,"cpuTime":4.154315948486328}
```

（手敲，不在 `lab/ch15/` 里）

读 `hostName` 用了 847250 个 thunk，读整个 `toplevel` 用了 7371514 个，前者是后者的 11.5%。惰性确实在起作用，没有把 16555 个选项全算一遍；但只读一个选项也要先付 85 万个 thunk，我猜这是收集模块、合并全部声明的固定成本，没有拆开量。thunk 数每次都一样，CPU 时间每次不同。

## mini 少了什么

`mini-modules.nix` 的开头注释列了“故意没做”的几样：`mkMerge`、`mkOrder`、`submodule`、未声明选项的报错、`_module.args` 和定义位置。其中除了未声明选项，别的都在各自的那一节里看过了。剩下的这一样，加上同一个选项声明两次的处理，各用一个命令看一眼，最后让两边各跑一遍 `mkIf false`。

**未声明的选项。** 我在 `cairn.repo` 旁边写了一个拼错的 `cairn.reop`，真的求值器会告诉你，我的 mini 不会：

```text
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; in (lib.evalModules { modules = [ ./modules/cairn-settings.nix { cairn.repo = "/r"; cairn.reop = "/typo"; } ]; }).config.cairn.configText' 2>&1 | tail -n 4
       error: The option `cairn.reop' does not exist. Definition values:
       - In `<unknown-file>': "/typo"

       Did you mean `cairn.keep', `cairn.repo' or `cairn.sources'?
$ nix eval --impure --expr 'let mini = import ./modules/mini-modules.nix; in (mini.evalMini { modules = [ { options.repo = mini.mkOption { type = mini.types.str; }; } { config.repo = "/r"; config.reop = "/typo"; } ]; }).config'
{ repo = "/r"; }
```

（手敲，不在 `lab/ch15/` 里）

真的会说选项不存在，列出定义的值和位置，还猜你想写的是 `cairn.repo`（`checkUnmatched` 在 L303，文本在 L348）。mini 把 `reop` 悄悄丢掉。这个检查由 `_module.check` 控制，选项在 L213 声明，默认是开的。

**同一个选项声明两次。** mini 一律报错，真的实现在类型能合并、且两边都没有 `default`、`example`、`description`、`apply` 时允许（`mergeOptionDecls` 在 L1012）。这是我在“一个模块长什么样”里说“一个选项只有一个声明”的例外，练习 4 会验证。

**`mkIf` 的惰性。** mini 的 `resolve` 在条件为假时不碰 `content`，真的实现在选项这一层同样不碰：`dischargeProperties` 的 L1383 是 `if def.condition then dischargeProperties def.content else [ ]`。我拿 `mkIf false (throw "boom")` 让两边各试一次，选项的默认值都是 1：

```text
$ nix eval --impure --expr 'let mini = import ./modules/mini-modules.nix; in (mini.evalMini { modules = [ { options.x = mini.mkOption { type = mini.types.int; default = 1; }; } { config.x = mini.mkIf false (throw "boom"); } ]; }).config'
{ x = 1; }
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; in (lib.evalModules { modules = [ { options.x = lib.mkOption { type = lib.types.int; default = 1; }; } { config.x = lib.mkIf false (throw "boom"); } ]; }).config.x'
1
```

（手敲，不在 `lab/ch15/` 里）

两边都回到默认值 1，没有人去求值 `boom`。mini 靠的是 `resolve` 里 `if def.condition then ... else { active = false; ... }` 这一支，`mini_lazy_config.nix` 的 `guarded` 选项把它固定成了一个实验。

我不想只列缺口。这 194 行已经够把 Cairn 以外的小例子跑起来；它的价值是让你看清楚 `lib/modules.nix` 那 2342 行里有多少是为了三样东西：按路径合并声明、定义收集和类型合并，而其余的（`mkMerge`、`mkOrder`、子模块、`_module.args`、错误上下文、`freeformType`、`disabledModules`、`extendModules`）都是加在这副骨架上的。

这张图是我读完之后画的，每个框对应某一节里出现过的函数：

```mermaid
flowchart LR
  A["collectModules<br/>展开 imports"] --> B["mergeModules'<br/>按名字分组声明和定义"]
  B --> C["mergeOptionDecls<br/>合并同一选项的声明"]
  C --> D["evalOptionValue<br/>加上 mkOptionDefault"]
  D --> E["dischargeProperties<br/>mkIf、mkMerge"]
  E --> F["filterOverrides'<br/>优先级"]
  F --> G["sortProperties<br/>mkOrder"]
  G --> H["type.check<br/>type.merge"]
```

读 `lib/modules.nix` 时我手边放着一张对照表，左边是流程图里的步骤，右边是我的 `mini-modules.nix` 里做同一件事的地方（行号指 `modules/mini-modules.nix`）：

| 步骤 | `lib/modules.nix` 的函数 | mini 里对应的 |
| --- | --- | --- |
| 展开 `imports` | `collectModules`(L413) | `collect`(L141) |
| 按名字分组声明和定义 | `mergeModules'`(L787) | `mergeDeclarations`(L114)和 `select`(L102) |
| 合并同一选项的声明 | `mergeOptionDecls`(L1012) | 没有，声明两次直接报错 |
| 加上选项默认值 | `evalOptionValue`（L1102，默认值在 L1111） | `fromDefault`(L159) |
| 展开 `mkIf`、`mkMerge` | `dischargeProperties`(L1377) | `resolve`(L79)，没有 `mkMerge` |
| 按优先级过滤 | `filterOverrides'`(L1417) | `best` 和 `winners`（L161 到 L162） |
| 按顺序号排序 | `sortProperties`(L1451) | 没有 |
| 检查类型并合并 | `mergeDefinitions`(L1187)里的 `type.check` 和 `type.merge` | `bad` 和 `opt.type.merge`（L163 到 L170） |

表里有三样 mini 没有对应物：同一选项的重复声明合并(`mergeOptionDecls`)、`mkMerge` 和排序。mini 之外的两千多行都是什么？我猜大头是类型（`lib/types.nix` 自己就有 1910 行）和错误文本，不是这条流水线，我没有逐段数过。

## 让我意外的事

**同优先级的定义是倒着排的。** 我先写 `plain-1`，后写 `plain-2`，`merge_order.nix` 给我 `[ "before" "order-750" "plain-2" "plain-1" "after" ]`。`lib/modules.nix` 的 L274 把收集到的模块列表整个 `reverseList` 了一遍，所以同号的 `listOf` 定义、`lines` 的每一行、`mergeEqualOption` 报冲突时列出的两个定义，顺序都和你写的相反：`real_conflict_fail.nix` 的错误里 `team-b.nix` 先于 `team-a.nix` 列出。我的 mini 照这个顺序收集（先顶层模块，再逐层收 `imports`，最后整个反过来），同样的两个模块也给 `[ "b" "a" ]`。我没有去查手册里有没有这方面的承诺，所以别靠它，需要顺序就写 `mkOrder`。

**`builtins.tryEval` 接不住无限递归。** 我想在实验里演示“有 `mkIf` 的写法求值成功，没有的写法失败”，第一反应是用 `tryEval` 包住坏的那个，打印 `success = false`。结果是整条命令以错误退出。[Nix 手册](https://nix.dev/manual/nix/2.34/language/builtins.html#builtins-tryEval)写着 `tryEval` 只拦 `throw` 和 `assert` 抛的错，无限递归不在其中。我把两种错误并排放一遍：

```text
$ nix eval --impure --expr 'builtins.tryEval (import ./lab/ch15/fixtures/mkif_bad.nix)' 2>&1 | tail -n 1; echo "exit: ${PIPESTATUS[0]}"
       error: infinite recursion encountered
exit: 1
$ nix eval --impure --expr 'builtins.tryEval (throw "boom")'
{ success = false; value = false; }
```

（手敲，不在 `lab/ch15/` 里）

这也是 `ex_mkif.sh` 用子进程跑 `nix eval`、再 `grep` 错误文本的原因，而不是在 Nix 里捕获。

**第 8 篇的一个实验靠 `flake.nix` 里的一行字。** `lab/ch08/fixtures/untracked_setup.sh` 要往一份克隆的 `flake.nix` 里插一个输出 `extra`。ch14 标签上的版本用 `sed` 把它插在 `lib = firnLib;` 的下一行；ch15 的 `flake.nix` 里这一行是 `lib = firnLib // {`，我在两个标签上数这一行出现几次：

```text
$ echo "ch14: $(git show ch14:flake.nix | grep -c '^      lib = firnLib;')"
ch14: 1
$ echo "ch15: $(grep -c '^      lib = firnLib;' flake.nix)"
ch15: 0
```

（手敲，不在 `lab/ch15/` 里）

那条 `sed` 就什么也匹配不到，而且不报错。我把 ch14 的 fixture 放到 ch15 的树上，跑第 8 篇的两个实验：

```text
$ rm -rf /tmp/oldfx /tmp/oldfx-lab
$ git clone -q . /tmp/oldfx
$ git show ch14:lab/ch08/fixtures/untracked_setup.sh > /tmp/oldfx/lab/ch08/fixtures/untracked_setup.sh
$ git -C /tmp/oldfx -c user.name=t -c user.email=t@t commit -qam old
$ for s in untracked_fixed untracked_invisible_fail; do
  echo "== ${s}"
  mkdir -p "/tmp/oldfx-lab/${s}"
  FIRN_ROOT=/tmp/oldfx LAB_TMP="/tmp/oldfx-lab/${s}" bash "/tmp/oldfx/lab/ch08/${s}.sh" 2>&1 | tail -n 1
  echo "exit: ${PIPESTATUS[0]}"
done
== untracked_fixed
error: flake 'git+file:///tmp/oldfx-lab/untracked_fixed/clone' does not provide attribute 'packages.x86_64-linux.extra', 'legacyPackages.x86_64-linux.extra' or 'extra'
exit: 1
== untracked_invisible_fail
error: flake 'git+file:///tmp/oldfx-lab/untracked_invisible_fail/clone' does not provide attribute 'packages.x86_64-linux.extra', 'legacyPackages.x86_64-linux.extra' or 'extra'
exit: 1
```

（手敲，不在 `lab/ch15/` 里）

`untracked_fixed.sh` 本该成功，却以 1 退出；`untracked_invisible_fail.sh` 本该因为“文件没被 git 跟踪”而失败，实际的原因是 `extra` 根本不存在。ch15 标签上的 fixture 锚在 `overlays.default = import ./overlays;` 这一行（它从第 10 篇起一直在 `flake.nix` 里），并且找不到锚点时直接失败，`make ch08` 的 16 个实验照样全部 `ok`。让我意外的是第二个：一个期望失败的实验换了失败的原因，运行器完全看不出来（它只看退出码，对原因没有意见）。

想继续往下读的话，有三个入口：NixOS 手册的 [Writing NixOS Modules](https://nixos.org/manual/nixos/stable/#sec-writing-modules) 一章，nix.dev 的[模块系统教程](https://nix.dev/tutorials/module-system/)，以及钉住的 rev 上的 [`lib/modules.nix`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/modules.nix)。我自己的读法是先读 `evalModules`（L91 起）和 `mergeDefinitions`（L1187 起），别的函数大多是它们的配件。

## 检查点

在 `~/firn` 里，`nix develop` 之内：

```bash
env -u CI make ch15
make lint
make check
while read -r f; do
  diff <(git -C ~/firn-ref show ch15:"${f}") "${f}" && echo "same ${f}"
done < <(git -C ~/firn-ref diff --name-only ch14 ch15)
```

`make ch15` 在我这里打印这 16 行（命令回显加 15 行 `ok`），整条命令（含 `nix develop` 的启动）花了 22.619 秒；`lab/ch15/` 里没有 `_host` 实验，所以 `CI=true` 时也是这 15 个。其中 5 个 `_fail` 实验以非零退出码结束，运行器把它们记成 `ok`：

```text
$ env -u CI make ch15
bash scripts/chapter.sh ch15
ok   lab/ch15/ex_mkif.sh
ok   lab/ch15/imports_pkgs_recursion_fail.nix
ok   lab/ch15/merge_order.nix
ok   lab/ch15/mini_basic.nix
ok   lab/ch15/mini_conflict_fail.nix
ok   lab/ch15/mini_lazy_config.nix
ok   lab/ch15/mini_priority.nix
ok   lab/ch15/mini_type_fail.nix
ok   lab/ch15/nixos_option_count.sh
ok   lab/ch15/real_conflict_fail.nix
ok   lab/ch15/real_eval.nix
ok   lab/ch15/real_type_fail.nix
ok   lab/ch15/specialargs.nix
ok   lab/ch15/submodule.nix
ok   lab/ch15/where_defined.nix
```

`make lint` 回显它跑的几条命令，没有任何诊断，退出码 0；`make check` 以 `all checks passed!` 结束，退出码 0，x86\_64-linux 上是 15 个检查：

```text
$ make lint >/dev/null 2>&1; echo "lint rc=$?"
lint rc=0
$ make check 2>&1 | tail -n 5; echo "rc=${PIPESTATUS[0]}"
derivation evaluated to /nix/store/sxj15y2pgk96v1kv2si52j1i2dqbbd5q-nixfmt-tree-2.5.0.drv
running 0 flake checks...
all checks passed!
warning: The check omitted these incompatible systems: aarch64-linux
Use '--all-systems' to check all.
rc=0
```

（手敲，不在 `lab/ch15/` 里）

15 这个数来自这一篇开头那条 `nix eval .#checks.x86_64-linux --apply builtins.attrNames --json` 的输出：列出的名字正好 15 个。输出里的 `running 0 flake checks...` 我没有去查它的含义，不拿它下结论。

`diff` 循环应当打印 23 行 `same ...`，和 `git diff --name-only ch14 ch15` 的 23 个文件一一对应。我这里没有单独的 `~/firn-ref`，拿 Firn 仓库自己的 `ch15` 标签当参照跑了一遍，打印的行数是：

```text
$ while read -r f; do
  diff <(git show ch15:"${f}") "${f}" && echo "same ${f}"
done < <(git diff --name-only ch14 ch15) | wc -l
23
```

（手敲，不在 `lab/ch15/` 里）

**必须和标签一致的文件：** `modules/mini-modules.nix`、`modules/cairn-settings.nix`、`tests/fixtures/cairn.conf`、`lab/ch15/` 下全部 18 个文件（15 个实验加 3 个 fixture），以及 `lab/ch08/fixtures/untracked_setup.sh`。

**中间版本：** [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch15/flake.nix) 之后的章节还会改，到那时 `diff` 循环里它会和 `ch15` 标签对不上。`modules/cairn-settings.nix` 的文件头注释说同一个模块之后会放进 NixOS（第 16 章）和 Home Manager（第 18 章），所以它的选项名和渲染结果是被 `cairn-settings` 检查钉死的。

### 文件清单

链接指向标签 `ch15` 上的那一份；`git diff --name-only ch14 ch15` 的 23 个文件一个不少（其中 `lab/ch15/` 下 18 个）。实验的命令都是 `env -u CI make ch15`，输出在 `out/ch15/`。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch15/flake.nix) | `nix build .#checks.x86_64-linux.cairn-settings --no-link --print-out-paths` | 退出码 0；打印一个以 `-firn-cairn-settings` 结尾的 store 路径；比 `ch14` 多 38 行、少 2 行；x86\_64-linux 上有 15 个检查 |
| [`lab/ch08/fixtures/untracked_setup.sh`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch08/fixtures/untracked_setup.sh) | `env -u CI make ch08` | 退出码 0，16 个 `ok`；比 `ch14` 多 6 行、少 1 行；锚点是 `overlays.default`，找不到时 `return 1` |
| [`lab/ch15/ex_mkif.sh`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/ex_mkif.sh) | `env -u CI make ch15` | 退出码 0；`error: infinite recursion encountered`，`exit: 1`，然后 `"on"`（练习 1 的答案） |
| [`lab/ch15/fixtures/minimal_nixos.nix`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/fixtures/minimal_nixos.nix) | 被 `nixos_option_count.sh` 求值 | 15 行；16555 个选项，`module-list.nix` 里 2093 个条目 |
| [`lab/ch15/fixtures/mkif_bad.nix`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/fixtures/mkif_bad.nix) | 被 `ex_mkif.sh` 求值 | 26 行；`error: infinite recursion encountered` |
| [`lab/ch15/fixtures/mkif_good.nix`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/fixtures/mkif_good.nix) | 被 `ex_mkif.sh` 求值 | 26 行；`"on"` |
| [`lab/ch15/imports_pkgs_recursion_fail.nix`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/imports_pkgs_recursion_fail.nix) | `env -u CI make ch15` | 退出码 1（预期）；`error: infinite recursion encountered`，错误里带着 `_module.args` 和 `imports` 的提示 |
| [`lab/ch15/merge_order.nix`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/merge_order.nix) | `env -u CI make ch15` | 退出码 0；`steps` 是 `before`、`order-750`、`plain-2`、`plain-1`、`after`，`script` 的行序相同 |
| [`lab/ch15/mini_basic.nix`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/mini_basic.nix) | `env -u CI make ch15` | 退出码 0；`{ greeting = "hello"; message = "hello, firn"; name = "firn"; port = 8080; }` |
| [`lab/ch15/mini_conflict_fail.nix`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/mini_conflict_fail.nix) | `env -u CI make ch15` | 退出码 1（预期）；`firn: option 'port' has conflicting definitions` |
| [`lab/ch15/mini_lazy_config.nix`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/mini_lazy_config.nix) | `env -u CI make ch15` | 退出码 0；`forward` 和 `backward` 都是 42，`sameResult = true`，`guarded = "default"`，`unused` 的 `throw` 没触发 |
| [`lab/ch15/mini_priority.nix`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/mini_priority.nix) | `env -u CI make ch15` | 退出码 0；1500、1000、100、50 各自胜出，定义顺序反过来结果不变 |
| [`lab/ch15/mini_type_fail.nix`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/mini_type_fail.nix) | `env -u CI make ch15` | 退出码 1（预期）；`firn: option 'port' has type int but got "8080"` |
| [`lab/ch15/nixos_option_count.sh`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/nixos_option_count.sh) | `env -u CI make ch15` | 退出码 0；16555 个选项，2093 个条目；`volatile:` 一行是 `drvPath` 求值五次的中位数 3578 毫秒 |
| [`lab/ch15/real_conflict_fail.nix`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/real_conflict_fail.nix) | `env -u CI make ch15` | 退出码 1（预期）；``The option `cairn.repo' has conflicting definition values:``，列出 `team-b.nix` 和 `team-a.nix` |
| [`lab/ch15/real_eval.nix`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/real_eval.nix) | `env -u CI make ch15` | 退出码 0；`configText` 切成 8 段（7 行加末尾一个空串），`matchesFixture = true` |
| [`lab/ch15/real_type_fail.nix`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/real_type_fail.nix) | `env -u CI make ch15` | 退出码 1（预期）；`cairn.keep.last` 不是 `positive integer, meaning >0`，定义值 0 来自 `lab/ch15/real_type_fail.nix` |
| [`lab/ch15/specialargs.nix`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/specialargs.nix) | `env -u CI make ch15` | 退出码 0；`{ declared = [ "dessert" "out" ]; out = "sweet!"; }` |
| [`lab/ch15/submodule.nix`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/submodule.nix) | `env -u CI make ch15` | 退出码 0；`home` 合并出两个 source，`etc` 的 `title` 是 `system config` |
| [`lab/ch15/where_defined.nix`](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/where_defined.nix) | `env -u CI make ch15` | 退出码 0；`value = "/srv/backup"`，`definitions` 只有 `host.nix`，`highestPrio = 100` |
| [`modules/cairn-settings.nix`](https://github.com/bfmhno3/firn/blob/ch15/modules/cairn-settings.nix) | `env -u CI make ch15`(`real_eval.nix`) | 81 行；7 个选项；`configText` 和 `tests/fixtures/cairn.conf` 逐字相同 |
| [`modules/mini-modules.nix`](https://github.com/bfmhno3/firn/blob/ch15/modules/mini-modules.nix) | `env -u CI make ch15`（`mini_*` 实验） | 194 行；`lib/modules.nix` 的 2342 行是它的 12.1 倍；5 个 `mini_*` 实验全部按预期 |
| [`tests/fixtures/cairn.conf`](https://github.com/bfmhno3/firn/blob/ch15/tests/fixtures/cairn.conf) | `nix build .#checks.x86_64-linux.cairn-settings` | 7 行；`diff -u` 无输出，检查通过 |

## 练习

**1\.** 把 `config = mkIf cfg.enable { demo.out = "on"; }` 换成 `config = if cfg.enable then { demo.out = "on"; } else { }`，模块系统会怎样？为什么？

<details>
<summary>参考答案</summary>

答案是 `lab/ch15/ex_mkif.sh`（[链接](https://github.com/bfmhno3/firn/blob/ch15/lab/ch15/ex_mkif.sh)）。两个 fixture 是同一个模块，只有 `config` 的形状不同：

```nix
      (
        { config, ... }:
        let
          cfg = config.demo;
        in
        {
          options.demo.enable = lib.mkEnableOption "the demo";
          options.demo.out = lib.mkOption {
            type = lib.types.str;
            default = "off";
          };
          config = if cfg.enable then { demo.out = "on"; } else { }; # BAD
        }
      )
```

```nix
          config = lib.mkIf cfg.enable { demo.out = "on"; };
```

```text
$ cat out/ch15/ex_mkif.stdout
== if/else around config (BAD)
       error: infinite recursion encountered
exit: 1
== mkIf
"on"
```

`if` 版本递归，`mkIf` 版本返回 `"on"`。`if cfg.enable` 在求值 `config` 属性本身的时候就要读 `cfg.enable`，而 `demo.enable` 的值要收集所有模块的 `config` 里的定义，包括这个模块自己，于是自己等自己。`mkIf` 把条件留在定义里，`config` 的形状先确定，条件到合并 `demo.out` 时才求值。想用 `tryEval` 捕获这个错误是行不通的，原因在“让我意外的事”里。

</details>

**2\.** `cairn.sources` 是 `listOf str`。一个模块写 `cairn.sources = lib.mkDefault [ "/a" ]`，另一个写 `cairn.sources = [ "/b" ]`，结果是 `[ "/a" "/b" ]` 还是别的？

<details>
<summary>参考答案</summary>

不是拼接。优先级先过滤，只有赢家参与 `listOf` 的合并；`mkDefault`(1000)输给普通定义(100)，`/a` 被整个丢掉：

```text
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; in (lib.evalModules { modules = [ ./modules/cairn-settings.nix { cairn.repo = "/r"; cairn.sources = lib.mkDefault [ "/a" ]; } { cairn.sources = [ "/b" ]; } ]; }).config.cairn.sources'
[ "/b" ]
```

（手敲，不在 `lab/ch15/` 里）

想要拼接，两边都写普通定义，或者都写 `mkDefault`。

</details>

**3\.** `mkForce`、`mkVMOverride` 和 `mkImageMediaOverride` 同时给同一个字符串选项写值，再加一个普通定义，谁赢？`highestPrio` 是多少？

<details>
<summary>参考答案</summary>

数字最小的赢：`mkVMOverride` 是 10，`mkImageMediaOverride` 是 60，`mkForce` 是 50（L1572 到 L1574）：

```text
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; ev = ms: (lib.evalModules { modules = [ { options.x = lib.mkOption { type = lib.types.str; }; } ] ++ ms; }); r = ev [ { x = lib.mkForce "force"; } { x = lib.mkVMOverride "vm"; } { x = lib.mkImageMediaOverride "image"; } { x = "plain"; } ]; in { value = r.config.x; highestPrio = r.options.x.highestPrio; }'
{ highestPrio = 10; value = "vm"; }
```

（手敲，不在 `lab/ch15/` 里）

`vm`，`highestPrio = 10`。`mkForce` 不是最强的，只是普通用户写得出来的最强的。

</details>

**4\.** mini 把同一个选项声明两次一律当错误。真的 `lib.evalModules` 也是吗？

<details>
<summary>参考答案</summary>

不是。同样两份只有 `type` 的声明，真的允许；两边都带 `description` 就报错；两个类型不能合并（`str` 和 `int`）也报错。mini 对这三种情形报的是同一个错，我把三条命令都跑了：

```text
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; opt = { options.x = lib.mkOption { type = lib.types.str; }; }; in (lib.evalModules { modules = [ opt opt { x = "v"; } ]; }).config.x'
"v"
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; opt = { options.x = lib.mkOption { type = lib.types.str; description = "d"; }; }; in (lib.evalModules { modules = [ opt opt { x = "v"; } ]; }).config.x' 2>&1 | tail -n 1
       error: The option `x' in `<unknown-file>' is already declared in `<unknown-file>'.
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; in (lib.evalModules { modules = [ { options.x = lib.mkOption { type = lib.types.str; }; } { options.x = lib.mkOption { type = lib.types.int; }; } { x = "v"; } ]; }).config.x' 2>&1 | tail -n 1
       error: The option `x' in `<unknown-file>' is already declared in `<unknown-file>'.
$ nix eval --impure --expr 'let mini = import ./modules/mini-modules.nix; opt = { options.x = mini.mkOption { type = mini.types.str; }; }; in (mini.evalMini { modules = [ opt opt { config.x = "v"; } ]; }).config.x' 2>&1 | tail -n 1
       error: firn: option 'x' is declared more than once
$ nix eval --impure --expr 'let mini = import ./modules/mini-modules.nix; opt = { options.x = mini.mkOption { type = mini.types.str; description = "d"; }; }; in (mini.evalMini { modules = [ opt opt { config.x = "v"; } ]; }).config.x' 2>&1 | tail -n 1
       error: firn: option 'x' is declared more than once
$ nix eval --impure --expr 'let mini = import ./modules/mini-modules.nix; in (mini.evalMini { modules = [ { options.x = mini.mkOption { type = mini.types.str; }; } { options.x = mini.mkOption { type = mini.types.int; }; } { config.x = "v"; } ]; }).config.x' 2>&1 | tail -n 1
       error: firn: option 'x' is declared more than once
```

（手敲，不在 `lab/ch15/` 里）

这是 `mergeOptionDecls`(L1012)的规则：类型能 `typeMerge` 就合并，`default`、`example`、`description`、`apply` 任何一个两边都有就报 already declared。我猜这条规则是为了让 `types.lines` 之类的选项能在多个模块里各自补一点声明，没有查它的来历。

</details>

**5\.** `real_type_fail.nix` 的错误里有 `lab/ch15/real_type_fail.nix`，是因为我写了 `_file`。不写会怎样？

<details>
<summary>参考答案</summary>

内联的模块没有文件，错误里写 `<unknown-file>`：

```text
$ nix eval --impure --expr 'let lib = (import ./nix/pkgs.nix { }).lib; in (lib.evalModules { modules = [ ./modules/cairn-settings.nix { cairn.repo = "/r"; cairn.keep.last = 0; } ]; }).config.cairn.configText' 2>&1 | tail -n 2
       error: A definition for option `cairn.keep.last' is not of type `positive integer, meaning >0'. Definition values:
       - In `<unknown-file>': 0
```

（手敲，不在 `lab/ch15/` 里）

路径形式的模块（比如 `./modules/cairn-settings.nix`）自带文件名；内联的属性集和函数要自己写 `_file`，否则你只知道有人写错了，不知道是谁。

</details>

## 下一篇

第 16 篇《NixOS：services.cairn、VM 测试与一次 switch》要把这份设置模块放进一个真正的 NixOS 配置：写 `services.cairn`，让 `/etc/cairn/cairn.conf` 从 `configText` 生成，起一个 systemd 单元，再在一台 VM 里跑测试。这一篇我数过最小的 NixOS 有 16555 个选项，我猜到时候最难的不是写 `services.cairn` 自己的几个选项，而是别和那 16555 个里的某一个打起来。
