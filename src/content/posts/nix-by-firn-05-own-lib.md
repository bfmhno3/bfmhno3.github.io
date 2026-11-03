---
title: "自己写一个 lib：递归、错误处理与测试"
commentId: "post:nix-by-firn-05-own-lib"
published: "2026-11-03 23:00:00 +08:00"
description: "用 Firn 从零学 Nix 第 5 篇：我用 Nix 2.34.9 给 Firn 的 lib 补上 lists、generators 和 debug，把 73 个测试接进 nix flake check；朴素递归 sumTo 在深度 10000 就被 max-call-depth 拦下，真正的 C 栈要到 29100 到 29200 层之间才爆，而 Firn 自己写的 findFirst 在 9000 个元素上分配了 nixpkgs 版本 289 倍的内存。"
category: Tutorial
tags:
  - Nix
  - NixOS
  - Firn
  - 递归
  - 测试
  - 调试
series: "用 Firn 从零学 Nix"
seriesOrder: 5
draft: false
comment: true
slug: nix-by-firn-05-own-lib
---

我写了一个把 1 加到 n 的函数，一行，一个初学者教程里都不好意思放的那种。n 是 9999 的时候它给出 49995000，n 是 10000 的时候它报错，而这台机器还有 30 GiB 内存。

```text
$ cat out/ch05/recursion_depth.stdout
{ depth = 9999; expected = 49995000; result = 49995000; }
$ grep 'error:' out/ch05/stack_overflow_fail.stderr
       error: stack overflow; max-call-depth exceeded
```

这一篇我们回到 Firn 的 `lib`，把它写完整：补上 `lists`、`generators` 和 `debug`，让 `tests/lib.nix` 改用和 nixpkgs 同一个约定的 `runTests`，再把它接进 `nix flake check`。写的过程中会撞上几堵墙：求值器的调用深度、真实的 C 栈、`foldl'` 到底严格在哪里，以及一个我自己写进去的平方复杂度。每一堵墙我都会用 `--show-trace` 或者 `--debugger` 去看一眼里面。

> [!NOTE] 本篇检查点
> 这一篇结束时，Firn 仓库的标签 `ch05` 里有：`lib/lists.nix`、`lib/generators.nix`、`lib/debug.nix` 三个新文件，`lib/attrsets.nix` 补全到 9 个函数，`lib/default.nix` 导出 48 个名字，`tests/lib.nix` 是 73 个 `runTests` 用例，`flake.nix` 多了输出 `lib` 和两个检查 `lib-tests`、`readme-table`，`Makefile` 的 `ci` 变成 `lint chapters check`；`lab/ch05/` 下有 11 个实验和 1 个 fixture。`make ch05` 通过。这几个 lib 文件和 `tests/lib.nix` 在这一章写完之后，后面只会增补：第 6 篇给 `lib` 加 `store-path`，第 15 篇在 `generators` 之上写模块。
> 涉及的 Nix 特性：递归与 `max-call-depth`、`builtins.foldl'`、`builtins.genList`/`concatMap`、`--show-trace`、`builtins.break` 与 `--debugger`、`runTests`、`nix flake check`。
> 前置：[第 4 篇：builtins 深挖](/posts/nix-by-firn-04-builtins/)；第 3 篇的[惰性求值与 thunk](/posts/nix-by-firn-03-functions-and-laziness/)会反复用到。

## 这一章往 lib 里放了什么

先把账摆出来。第 4 篇结束时 `lib/default.nix` 导出 31 个名字，现在是 48 个：

```text
$ nix eval --impure --expr 'builtins.length (builtins.attrNames (import ./lib))'
48
```

多出来的 17 个是三个新子集的名字（`lists`、`generators`、`debug`）加上 14 个函数：`lists` 里 6 个，`attrsets` 里新增 5 个，`generators` 里 2 个，`debug` 里 1 个。nixpkgs 的 `lib` 在锁定的版本上导出多少？

```text
$ nix eval --impure --expr 'builtins.length (builtins.attrNames (import "${(import ./nix/pins.nix).nixpkgs}/lib"))'
494
```

494 个。Firn 的 `lib` 离那个规模差一个数量级，这是故意的：我要的不是替代它，而是一个小到能一次读完、又足够真实到会出错的版本。出错是目的。

`lib` 加载本身有多贵？对 nixpkgs 的 `lib` 只取 `attrNames`：

```text
$ NIX_SHOW_STATS=1 nix eval --impure --expr 'builtins.attrNames (import "${(import ./nix/pins.nix).nixpkgs}/lib")' 2>&1 >/dev/null | jq -c '{nrThunks, nrFunctionCalls, cpuTime}'
{"nrThunks":530,"nrFunctionCalls":2,"cpuTime":0.020891999825835228}
```

530 个 thunk，21 毫秒 CPU。对比第 1 篇里加载整个 nixpkgs 的 27959 个顶层属性要 182 毫秒：`lib` 轻得多。这不是巧合，也是后面“为什么 `lib` 要和 `builtins`、`pkgs` 分开”的答案，我放到文章靠后的位置再算。

### lists：六个函数

[`lib/lists.nix`](https://github.com/bfmhno3/firn/blob/ch05/lib/lists.nix) 只有 38 行，只依赖 `builtins`。我挑其中四个来读，剩下两个（`range` 和 `imap0`）就是对 `genList` 的一层包装。

```nix
  # 保留首次出现的元素，用 == 比较，O(n^2)。
  unique = builtins.foldl' (acc: x: if builtins.elem x acc then acc else acc ++ [ x ]) [ ];

  # 递归拍平嵌套列表；非列表的参数当作单元素列表。
  flatten = x: if builtins.isList x then builtins.concatMap flatten x else [ x ];

  # foldl' 是严格的，不会堆出一长串 thunk。
  sum = builtins.foldl' builtins.add 0;
```

三行里有三个常用手法。`unique` 把“带状态的遍历”写成 `foldl'`：累加器是已经见过的元素，每一步决定要不要追加。`flatten` 是教科书式的递归，但递归发生在 `concatMap` 里，每一层的深度只是嵌套的层数，不是列表的长度。`sum` 没有写参数（`foldl' add 0` 是个偏应用，第 3 篇讲过柯里化），所以它的类型是“列表到整数的函数”。

第四个是 `findFirst`，它藏着一个问题，我放到“让我意外的事”之前再拆：

```nix
  findFirst =
    pred: default: list:
    if list == [ ] then
      default
    else if pred (builtins.head list) then
      builtins.head list
    else
      findFirst pred default (builtins.tail list);
```

它在找到之后立刻停止，不会去看后面的元素。`tests/lib.nix` 里有个用例专门盯这一点：`testFindFirstLazyTail` 把 `(throw "never forced")` 放在列表第二个位置，如果实现多看了一个元素，测试就会炸。

### attrsets：补全剩下五个

第 2 篇留了四个函数，这一章补齐其余五个：`nameValuePair`、`genAttrs`、`mapAttrsToList`、`filterAttrs`、`mapAttrs'`。它们的共同点是：属性集在 Nix 里按键排序，所以所有“遍历属性集”的函数，遍历的都是排序后的键。

```nix
  # 按键排序后把每个键值对映射成列表元素。
  mapAttrsToList = f: attrs: map (name: f name attrs.${name}) (builtins.attrNames attrs);

  # ...

  # f 返回 { name; value; }，可以改键；键冲突时先出现的（按键排序）胜出。
  mapAttrs' = f: set: builtins.listToAttrs (map (n: f n set.${n}) (builtins.attrNames set));
```

“键冲突时先出现的胜出”不是我的设计，是 `builtins.listToAttrs` 的规则：同一个名字出现多次，第一个生效。我在命令行里确认过：

```text
$ nix eval --expr 'builtins.listToAttrs [ { name = "a"; value = 1; } { name = "a"; value = 2; } ]'
{ a = 1; }
```

`testMapAttrsPrime` 只测了不冲突的情形，冲突的那一半留给练习。

### 入口：一条 `//` 链，和 nixpkgs 的不动点

[`lib/default.nix`](https://github.com/bfmhno3/firn/blob/ch05/lib/default.nix) 把十个子文件 `import` 进来，然后导出两份：每个子集按名字（`lib.lists.range`），所有函数摊平（`lib.range`）。摊平靠的是一条 `//` 链：

```nix
{
  version = "0.1.0";
  inherit
    trivial
    attrsets
    # ...
    debug
    ;
}
// trivial
// attrsets
// fixed-points
// strings
// importers
// sources
// readme
// lists
// generators
// debug
```

`//` 右边赢。所以如果两个子文件定义了同名的函数，后面的会悄悄盖掉前面的，没有警告。这是这种写法的代价，我用一个查询确认现在没有撞名：

```text
$ nix eval --impure --expr 'let lib = import ./lib; subsets = [ "trivial" "attrsets" "fixed-points" "strings" "importers" "sources" "readme" "lists" "generators" "debug" ]; names = builtins.concatMap (s: builtins.attrNames lib.${s}) subsets; in { perSubset = builtins.listToAttrs (map (s: { name = s; value = builtins.length (builtins.attrNames lib.${s}); }) subsets); total = builtins.length names; distinct = builtins.length (lib.unique names); flat = builtins.length (builtins.attrNames lib); }'
{ distinct = 37; flat = 48; perSubset = { attrsets = 9; debug = 1; fixed-points = 5; generators = 2; importers = 3; lists = 6; readme = 1; sources = 1; strings = 5; trivial = 4; }; total = 37; }
```

37 个函数名，37 个不同；48 就是 37 个函数加 10 个子集名加 `version`。顺带一提，这个查询里的 `lib.unique` 是本章新写的函数，库拿自己的函数检查了自己。

nixpkgs 的做法不一样，而且和第 3 篇的主题直接相关。它的 `lib/default.nix` 把整个库做成一个**不动点**：

```nix
# nixpkgs lib/default.nix:45-53
  lib = makeExtensible' (
    self:
    let
      callLibs = file: import file { lib = self; };
    in
    {

      # often used, or depending on very little
      trivial = callLibs ./trivial.nix;
```

出处：[`lib/default.nix#L45-L53`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/default.nix#L45-L53)。每个子文件是一个 `{ lib }: ...` 的函数，拿到的 `lib` 就是最终的 `self`：`lists.nix` 的第 4 行是 `{ lib }:`，第 14 行是 `inherit (lib.attrsets) mapAttrs attrNames attrValues;`，它引用的是另一个子文件里的函数，不用知道它定义在哪个文件里，也不用 `import` 它。整个库还带一个 `.extend`（[第 40 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/default.nix#L40)），可以像第 3 篇的 `makeExtensible` 那样打补丁。平铺的名字则是一长串显式的 `inherit (self.attrsets) attrByPath ...`（[第 200 行起](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/default.nix#L200)）。每个名字都要点名，好处是撞名时 Nix 会报错，而不是静默覆盖：

```text
$ nix eval --expr '{ inherit ({ a = 1; }) a; inherit ({ a = 2; }) a; }' 2>&1 | head -2
error: attribute 'a' already defined at «string»:1:24
       at «string»:1:48:
```

Firn 的版本简单得多：子文件之间只能用相对路径互相 `import`（比如 `importers.nix` 里的 `strings = import ./strings.nix;`），也没有 `.extend`。我选简单，是因为我想让你一次把它读完：整个 `lib/` 加起来 427 行。

## 把 Firn 和 nixpkgs 并排读

写完之后我想知道：我写的和人家写的，到底差在哪。`lab/ch05/compare_nixpkgs_lib.nix` 用同一组输入跑 14 个函数，两边结果必须相等，否则求值失败。它从锁定的 nixpkgs 里直接导入 `lib`，不经过 `pkgs`：

```nix
let
  firn = import ../../lib;
  nixpkgsLib = import "${(import ../../nix/pins.nix).nixpkgs}/lib";
  cases = {
    attrByPath = f: f.attrByPath [ "a" "b" ] 0 { a.b = 5; };
    hasAttrByPath = f: f.hasAttrByPath [ "a" "c" ] { a.b = 1; };
    # ...
    findFirst =
      f:
      f.findFirst (x: x > 2) 0 [
        1
        3
        5
      ];
  };
  # ...
in
if mismatches == [ ] then
  builtins.mapAttrs (_: r: r.ours) results
else
  throw "Firn lib differs from nixpkgs lib for: ${builtins.concatStringsSep ", " mismatches}"
```

`cases` 里每一项是一个“拿 lib 当参数的函数”：同一个表达式分别喂给 Firn 和 nixpkgs。这是在 Nix 里写“差分测试”最省事的形态，因为 `lib` 只是一个属性集，没有全局状态。输出：

```text
$ cat out/ch05/compare_nixpkgs_lib.stdout
{ attrByPath = 5; filterAttrs = { b = 2; }; findFirst = 3; flatten = [ 1 2 3 ]; genAttrs = { a = 1; bb = 2; }; hasAttrByPath = false; hasPrefix = true; imap0 = [ "0a" "1b" ]; mapAttrsToList = [ "a=1" "b=2" ]; range = [ 2 3 4 5 6 ]; recursiveUpdate = { a = { b = 1; d = 2; }; c = 1; }; setAttrByPath = { a = { b = 1; }; }; splitString = [ "a" "b" "" "c" ]; unique = [ 3 1 2 ]; }
```

14 个函数的结果全部一致。Firn 的 `sum` 不在表里，因为 nixpkgs 的 `lib` 里没有同名的函数，两边没有可比的对象。我没有凭记忆说这句话，查了一下：

```text
$ nix eval --impure --expr 'let l = import "${(import ./nix/pins.nix).nixpkgs}/lib"; in { sum = l ? sum; listsSum = l.lists ? sum; add = l ? add; count = l ? count; foldl = l ? foldl; }'
{ add = true; count = true; foldl = true; listsSum = false; sum = false; }
```

nixpkgs 没有 `sum`，习惯写法是 `lib.foldl' builtins.add 0 xs`，它另外提供了 `lib.count`（带谓词的计数）和 `lib.add`。我把 `sum` 留在 Firn 里，因为它是 `foldl'` 严格性的最短演示。

### 逐个读 nixpkgs 的实现

对照的价值在于看出差异。`lib/attrsets.nix` 和 `lib/debug.nix` 是这一章最该读的两个文件。先看 `attrByPath`，我的版本和它做的是同一件事：

```nix
# nixpkgs lib/attrsets.nix:88-106
  attrByPath =
    attrPath: default: set:
    let
      lenAttrPath = length attrPath;
      attrByPath' =
        n: s:
        (
          if n == lenAttrPath then
            s
          else
            (
              let
                attr = elemAt attrPath n;
              in
              if s ? ${attr} then attrByPath' (n + 1) s.${attr} else default
            )
        );
    in
    attrByPath' 0 set;
```

出处：[`lib/attrsets.nix#L88-L106`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/attrsets.nix#L88-L106)。差别有两处。第一，它用下标 `n` 走路径，不是像我那样每一步 `builtins.tail path`。我猜 `tail` 要把剩下的元素复制一份（Nix 的列表是数组，没有共享的链表尾巴；这一点我没有读实现，后面会用分配的字节数验证它），路径很短时无所谓，但这个习惯在长列表上会变成平方，后面的 `findFirst` 就吃了这个亏。第二，它不检查 `isAttrs`：`s ? ${attr}` 对非属性集本来就返回 `false`，一个运算符做了我两行做的事。

再看 `filterAttrs` 和 `mapAttrsToList`：

```nix
# nixpkgs lib/attrsets.nix:667 和 1092，中间省略
  filterAttrs = pred: set: removeAttrs set (filter (name: !pred name set.${name}) (attrNames set));
  # ...
  mapAttrsToList = f: attrs: attrValues (mapAttrs f attrs);
```

两行。`filterAttrs` 不是“挑出满足条件的键重新建一个属性集”，而是“从原集合里删掉不满足的”，用 `removeAttrs`；`mapAttrsToList` 是 `mapAttrs` 之后取 `attrValues`，不用先 `attrNames` 再索引。我的 `filterAttrs` 多构造了一次 `listToAttrs` 和一批 `nameValuePair`，我的 `mapAttrsToList` 多做了一次 `attrs.${name}` 的查找，结果相同，但 nixpkgs 的写法更短，也让求值器少干点活。我不打算把 Firn 的版本改成它：这个仓库的目的是让你看见“朴素写法”和“成熟写法”之间的差别。

`recursiveUpdate` 的差别更大：

```nix
# nixpkgs lib/attrsets.nix:1778-1783
  recursiveUpdate =
    lhs: rhs:
    recursiveUpdateUntil (
      path: lhs: rhs:
      !(isAttrs lhs && isAttrs rhs)
    ) lhs rhs;
```

它是更一般的 `recursiveUpdateUntil` 的特例：“什么时候停止递归”这个谓词可以由调用者给。Firn 把“两边都是属性集就继续递归”写死了。好处是 Firn 的版本不到 10 行就读完，坏处是想要“到某一层就整体替换”时要改源码。第 15 篇的模块系统有 `mkForce` 这类显式的优先级，我猜它们部分是为了不必为每个特例改合并函数，不过这是猜测，我没有查设计文档。

## 先别自己递归：把循环交给 builtins

写这一章的 `lib` 时我有一条越来越硬的经验：能用一个 builtin 表达的循环，就别自己递归。这不是风格偏好。builtin 是 C++ 里的循环，不吃 Nix 的调用深度，后面 `foldl_strict.nix` 里 `genList` 造出的一百万个元素和 `foldl'` 的一百万步，都没有碰到任何限制。下面是我反复用到的十二个。每一条都是 `nix eval --impure --expr '<表达式>'` 的结果，右边的输出原样抄下：

| 表达式 | 结果 | 用在哪 |
| --- | --- | --- |
| `builtins.genList (i: i * i) 6` | `[ 0 1 4 9 16 25 ]` | `range`、`imap0` |
| `builtins.concatMap (x: [ x x ]) [ 1 2 3 ]` | `[ 1 1 2 2 3 3 ]` | `flatten` |
| `builtins.sort (a: b: a > b) [ 3 1 2 ]` | `[ 3 2 1 ]` | 排序，比较函数返回布尔 |
| `builtins.groupBy (x: if x > 2 then "big" else "small") [ 1 2 3 4 ]` | `{ big = [ 3 4 ]; small = [ 1 2 ]; }` | 按键分组 |
| `builtins.partition (x: x > 2) [ 1 2 3 4 5 ]` | `{ right = [ 3 4 5 ]; wrong = [ 1 2 ]; }` | 练习 1 的原型 |
| `builtins.listToAttrs (map (n: { name = n; value = builtins.stringLength n; }) [ "a" "bb" ])` | `{ a = 1; bb = 2; }` | `genAttrs`、`mapAttrs'` |
| `builtins.mapAttrs (n: v: "${n}=${toString v}") { a = 1; b = 2; }` | `{ a = "a=1"; b = "b=2"; }` | 保持键，换值 |
| `builtins.attrValues { b = 2; a = 1; }` | `[ 1 2 ]` | 按键排序后取值 |
| `builtins.removeAttrs { a = 1; b = 2; c = 3; } [ "a" "c" ]` | `{ b = 2; }` | nixpkgs 的 `filterAttrs` |
| `builtins.intersectAttrs { a = null; c = null; } { a = 1; b = 2; c = 3; }` | `{ a = 1; c = 3; }` | 第 7、10 篇的 `callPackage` |
| `builtins.zipAttrsWith (n: vs: vs) [ { a = 1; } { a = 2; b = 3; } ]` | `{ a = [ 1 2 ]; b = [ 3 ]; }` | nixpkgs 的 `recursiveUpdateUntil` |
| `builtins.foldl' (acc: x: acc // { ${x} = true; }) { } [ "a" "b" ]` | `{ a = true; b = true; }` | 用累加器逐步建一个属性集 |

这十二个可以分成三类：列表变列表（`genList`、`map`、`filter`、`concatMap`、`sort`），列表变属性集（`listToAttrs`、`groupBy`、`foldl'` 配 `//`），属性集变属性集（`mapAttrs`、`removeAttrs`、`intersectAttrs`、`zipAttrsWith`）。拿到一个新问题，我先问它属于哪一类，再看有没有现成的 builtin，最后才考虑手写递归。有几个名字值得记一下：`intersectAttrs` 会在第 7 篇回来，`callPackage` 就是靠它把“函数要的参数”和“包集合有的参数”求交集；`zipAttrsWith` 就是 nixpkgs 的 [`recursiveUpdateUntil`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/attrsets.nix#L1718) 里调用的那个函数。

手写递归的时机，是前面这些都不能表达的时候：比如 `findFirst` 想“找到就停”，`attrByPath` 要沿着路径一层层往下走。下一节说的就是这种情形下会发生什么。

## 递归与求值器的栈

回到开头那个 `sumTo`。三个实验文件，一组数字。

### 实验一：9999 过，10000 不过

```nix
# lab/ch05/recursion_depth.nix
let
  sumTo = n: if n == 0 then 0 else n + sumTo (n - 1);
in
{
  depth = 9999;
  result = sumTo 9999;
  expected = 9999 * 10000 / 2;
}
```

这个函数在每一层调用 `sumTo` 之后还要做一次加法，所以它不是尾递归，每一层调用都必须在栈上等着下一层返回。`depth = 9999` 给出 `49995000`，等于 $9999 \times 10000 / 2$。把 9999 换成 10000 同样会失败；仓库里的 [`stack_overflow_fail.nix`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/stack_overflow_fail.nix) 干脆直接算 `sumTo 1000000`，报错如下：

```text
$ cat out/ch05/stack_overflow_fail.stderr
error:
       … while evaluating the file '/home/bfmhno3/Projects/firn/lab/ch05/stack_overflow_fail.nix':

       … while evaluating a branch condition
         at /home/bfmhno3/Projects/firn/lab/ch05/stack_overflow_fail.nix:4:14:
            3| let
            4|   sumTo = n: if n == 0 then 0 else n + sumTo (n - 1);
             |              ^
            5| in

       error: stack overflow; max-call-depth exceeded
       at /home/bfmhno3/Projects/firn/lab/ch05/stack_overflow_fail.nix:4:49:
            3| let
            4|   sumTo = n: if n == 0 then 0 else n + sumTo (n - 1);
             |                                                 ^
            5| in
```

“stack overflow”这个说法有点误导：这时候真正的栈还远没有满。这条消息来自一个计数器。

### 两道关卡

求值器在每次函数调用时检查调用深度，这段代码在 Nix 2.34.9 的 [`eval-inline.hh` 第 171 到 177 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/include/nix/expr/eval-inline.hh#L171-L177)：

```cpp
inline CallDepth EvalState::addCallDepth(const PosIdx pos)
{
    if (callDepth > settings.maxCallDepth)
        error<StackOverflowError>().atPos(pos).debugThrow();

    return CallDepth(callDepth);
};
```

`maxCallDepth` 的默认值是 10000，定义在 [`eval-settings.hh` 第 314 到 315 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/include/nix/expr/eval-settings.hh#L314-L315)，对应用户可见的设置 [`max-call-depth`](https://nix.dev/manual/nix/2.34/command-ref/conf-file#conf-max-call-depth)；错误消息 `stack overflow; max-call-depth exceeded` 来自 [`eval-error.hh` 第 64 到 67 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/include/nix/expr/eval-error.hh#L64-L67) 的 `StackOverflowError`。

这像是电路里的保险丝：保险丝在前，墙在后。保险丝熔断时你得到一条带位置的错误；如果没有它，你撞上的就是墙，也就是进程自己的 C 栈。我把保险丝调高，看看墙在哪里。这是 [`lab/ch05/call_depth_limit.sh`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/call_depth_limit.sh)，核心是一个函数，对同一个 `sumTo N` 加不同选项再试一次，只打印最后一行结果或错误：

```bash
try_depth() {
  local n="$1"
  shift
  local out
  out="$(nix eval "$@" --expr "${sum_to} ${n}" 2>&1 | grep -E '^[0-9]+$|^ *error: ' | sed 's/^ *//' | tail -n 1)" || true
  echo "${n} [$*]: ${out}"
}

echo "max-call-depth default: $(nix config show max-call-depth)"
try_depth 9999
try_depth 10000
try_depth 20000 --option max-call-depth 1000000
try_depth 100000 --option max-call-depth 1000000
echo "stack limit: $(ulimit -s) KiB"
```

输出：

```text
$ cat out/ch05/call_depth_limit.stdout
max-call-depth default: 10000
9999 []: 49995000
10000 []: error: stack overflow; max-call-depth exceeded
20000 [--option max-call-depth 1000000]: 200010000
100000 [--option max-call-depth 1000000]: error: stack overflow (possible infinite recursion)
stack limit: 8192 KiB
```

输出里有两个不同的错误。第 4 行把保险丝调到一百万，深度 20000 就过了。第 5 行深度 100000 失败，但消息变了，是 `stack overflow (possible infinite recursion)`，没有 `max-call-depth`。这一条不是计数器给的：它来自 [`libmain/unix/stack.cc` 第 75 行](https://github.com/NixOS/nix/blob/2.34.9/src/libmain/unix/stack.cc#L75)，那里装了一个 `SIGSEGV` 处理器，进程真的踩到栈边界以后，由它判断“故障地址是不是栈附近”，是的话打印这一行再退出。“possible infinite recursion”只是它对所有栈溢出的统一说法（第 3 篇讲过的 `infinite recursion encountered` 是另一回事，那是 black-holing，不是栈）。

墙在哪一层？[`lab/ch05/call_depth_wall.sh`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/call_depth_wall.sh) 把保险丝调到一百万，先探测一张固定的深度表，再在 25000 到 30000 之间以 100 层为步长二分，最后在 `ulimit -s 65536` 下重复探测。核心是 `probe` 和二分循环：

```bash
probe() {
  nix eval --option max-call-depth 1000000 --expr "${sum_to} $1" 2>&1 \
    | grep -E '^[0-9]+$|error: ' | sed 's/^ *//' | tail -n 1 || true
}
# ...
lo=25000
hi=30000
while ((hi - lo > 100)); do
  mid=$(((lo + hi) / 2))
  mid=$((mid - mid % 100))
  if passes "${mid}"; then
    lo="${mid}"
  else
    hi="${mid}"
  fi
done
echo "first failing depth (100-step bisect): ${hi}"
```

```text
$ cat out/ch05/call_depth_wall.stdout
25000: 312512500
28000: 392014000
29000: 420514500
29100: 423419550
29200: error: stack overflow (possible infinite recursion)
30000: error: stack overflow (possible infinite recursion)
first failing depth (100-step bisect): 29200
stack limit: 8192 KiB
ulimit -s 8192, depth 29200: error: stack overflow (possible infinite recursion)
ulimit -s 8192, depth 200000: error: stack overflow (possible infinite recursion)
ulimit -s 65536, depth 29200: 426334600
ulimit -s 65536, depth 200000: error: stack overflow (possible infinite recursion)
```

墙在 29100 和 29200 之间：二分给出的第一个失败深度是 29200（步长 100，所以只精确到百位）。8 MiB 的栈除以大约 29150 层，每层大约是 $8388608 / 29150 \approx 288$ 字节。`ulimit -s` 是 8192 KiB，数字对得上，但这是除法算出来的，不是量出来的，所以它是一个估计：一层 Nix 调用在 C++ 里要经过几层函数，288 字节是它们合起来的平均开销。实验的后半段就是为了验证“墙就是 `ulimit -s`”：栈放大到 64 MiB，29200 就过了，200000 仍然过不去（$65536 \text{ KiB} / 288 \text{ B} \approx 233000$，不过我没有二分验证这个上界，别当成测出来的）。所以结论是：默认设置下是保险丝先断，保险丝之后才是 `ulimit -s`；默认的 10000 给 8 MiB 的栈留了大约 3 倍的余量（10000 对 29150）。这个余量是不是有意设计的，我没有读到注释，不敢断言。

这个结论对写库的人有一个直接的后果：默认设置下，对输入长度递归的函数，深度上限是 `max-call-depth`（一万）除以每个元素占的调用层数；再往上是 `ulimit -s`。我猜 nixpkgs 里到处是 `foldl'` 和 `genList`，一部分原因就在这里（这是猜测，我没有去翻它的提交历史）。

## foldl'：严格到底严格在哪

### 同一个和，两种写法

`foldl'` 是 `builtins` 里的原语，不是 Nix 写的函数。它在 Nix 2.34.9 里的实现在 [`primops.cc` 第 3868 到 3887 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/primops.cc#L3868-L3887)，核心是一个 C++ 的 `for` 循环：

```cpp
    if (args[2]->listSize()) {
        Value * vCur = args[1];

        auto listView = args[2]->listView();
        for (auto [n, elem] : enumerate(listView)) {
            Value * vs[]{vCur, elem};
            vCur = n == args[2]->listSize() - 1 ? &v : state.allocValue();
            state.callFunction(*args[0], vs, *vCur, pos);
        }
        state.forceValue(v, pos);
    } else {
```

每一轮循环直接 `callFunction`，也就是当场把 `op acc elem` 算出来，结果放进下一轮的 `vCur`；没有“先记下这个调用，以后再算”的 thunk，所以不会堆出一串 `((0 + 1) + 2) + 3...` 的链，名字里的撇号指的就是这个。注意 `vCur` 的初值是 `args[1]`，没有被 `forceValue` 过：这就是后面 nixpkgs 那条注释说“初始累加器不会先被求值”的出处（我是对着这几行推出来的，没有跑实验去复现）。[`foldl_strict.nix`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/foldl_strict.nix) 是 3 行：

```nix
builtins.foldl' builtins.add 0 (builtins.genList (i: i + 1) 1000000)
```

```text
$ cat out/ch05/foldl_strict.stdout
500000500000
```

一百万项，没有任何深度问题。它和 `sumTo 1000000` 做的是同一件事，差别只在于“一个循环”和“一百万层调用”。

[`fold_memory.sh`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/fold_memory.sh) 用 `NIX_SHOW_STATS=1`（第 3 篇用过）量化这个差别。因为朴素版本在 9999 层以上不行，我在 9000 层上比：

```bash
readonly naive='let sumTo = n: if n == 0 then 0 else n + sumTo (n - 1); in sumTo 9000'
readonly fold9k="builtins.foldl' builtins.add 0 (builtins.genList (i: i + 1) 9000)"
readonly fold1m="builtins.foldl' builtins.add 0 (builtins.genList (i: i + 1) 1000000)"
```

```text
$ cat out/ch05/fold_memory.stdout
naive 1..9000      : nrThunks=9001 nrFunctionCalls=9001 envs=9003 heapSize=402915328 totalBytes=304272
foldl' 1..9000     : nrThunks=3 nrFunctionCalls=9000 envs=9001 heapSize=402915328 totalBytes=662992
foldl' 1..1000000  : nrThunks=3 nrFunctionCalls=1000000 envs=1000001 heapSize=402915328 totalBytes=72017552
median ms: naive 9000 = 42, foldl' 9000 = 25, foldl' 1000000 = 157
```

排成表：

| 表达式 | thunk | 函数调用 | `totalBytes` | 中位耗时 |
| --- | --- | --- | --- | --- |
| 朴素递归 1..9000 | 9001 | 9001 | 304,272 | 42 ms |
| `foldl'` 1..9000 | 3 | 9000 | 662,992 | 25 ms |
| `foldl'` 1..1000000 | 3 | 1,000,000 | 72,017,552 | 157 ms |

thunk 数从 9001 掉到 3，这是严格性的直接证据：朴素递归每一层给 `n - 1` 造了一个 thunk，`foldl'` 一个都不需要。耗时 42 对 25 毫秒，快 1.7 倍，但这里面有一大块是 `nix eval` 启动的固定开销，所以我不会把它说成“`foldl'` 快 1.7 倍”。

注意最右列之前的那一列：`totalBytes`，`foldl'` 反而**更大**：662,992 对 304,272，2.2 倍。我一开始以为 `foldl'` 会更省内存，数字不是这样。原因很简单：`foldl'` 的输入是一个 9000 个元素的列表，`genList` 要把它造出来，朴素递归没有列表，只有栈。所以 `foldl'` 赢的不是内存，是**深度**：它能跑一百万项，而朴素版本在一万项就倒下。`heapSize` 三行一模一样（402,915,328 字节，384 MiB 多一点），说明这个数字在这个规模上没有信息量，我猜它是垃圾回收器的初始堆大小，没有进一步确认。

### 严格不等于深度严格

`foldl'` 只把累加器求值到 WHNF。累加器是整数时这就是全部，累加器是属性集时，它只保证最外层的 `{ ... }` 被求值，里面的字段仍然可以是 thunk。nixpkgs 的 `lib.foldl'` 在这上面又加了一笔，它的注释写得很清楚（[`lib/lists.nix` 第 278 到 286 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/lists.nix#L278-L286)）：

```nix
  foldl' =
    let
      inherit (builtins) foldl';
    in
    op: acc:
    # The builtin `foldl'` is a bit lazier than one might expect.
    # See https://github.com/NixOS/nix/pull/7158.
    # In particular, the initial accumulator value is not forced before the first iteration starts.
    seq acc (foldl' op acc);
```

内建版本连初始累加器也不先求值，所以 nixpkgs 在它前面加了一个 `seq acc`。这一点我没有设计实验去复现，只是引用它的注释；你可以把它当作“严格性是一个有版本历史的细节”的证据。

nixpkgs 里还有一个**不**严格的 `lib.foldl`，实现是纯 Nix 递归（[第 195 到 200 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/lists.nix#L195-L200)）。[`lab/ch05/lib_foldl_depth.sh`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/lib_foldl_depth.sh) 在默认的 `max-call-depth` 下拿它和 `foldl'` 比同一个加法：

```text
$ cat out/ch05/lib_foldl_depth.stdout
foldl 2000: 2001000
foldl 4000: 8002000
foldl 5000: error: stack overflow; max-call-depth exceeded
foldl 20000: error: stack overflow; max-call-depth exceeded
foldl' 2000: 2001000
foldl' 4000: 8002000
foldl' 5000: 12502500
foldl' 20000: 200010000
```

纯 Nix 递归的 `lib.foldl` 在 4000 项还行，5000 项就撞上保险丝：每个元素吃掉不止一层调用深度（我没有拆开数是几层，从 4000 到 5000 之间翻过 10000 来看，大约是两层）。同一个函数名多了一个撇号，天花板从五千项变成了至少一百万项（上面的 `foldl_strict.nix` 跑过）。

### 累加器是属性集的时候

上面说“累加器是属性集时里面的字段仍然可以是 thunk”，这不是假想：[`ex_partition.nix`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/ex_partition.nix) 用 `foldl'` 写 `partition`，一次遍历把列表分成满足和不满足两组，累加器正是 `{ right; wrong; }`，每一步 `right` 或 `wrong` 里有一个是还没有求值的 `acc.right ++ [ x ]`。这是练习 1，答案在文章末尾，这里只放结果：

```text
$ cat out/ch05/ex_partition.stdout
{ right = [ 3 4 5 ]; wrong = [ 1 2 ]; }
```

## 错误信息：看见调用链

### 一个故意埋深的错误

写库的人调试靠两样东西：错误消息里的位置，和 `--show-trace` 里的调用链。[`show_trace_fail.sh`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/show_trace_fail.sh) 造一个三层深的错误：`pipe` 里放一个 `mapAttrsToList`，传给它的函数先取属性路径再把结果和字符串 `"s"` 相加：

```bash
readonly expr='let lib = import '"${FIRN_ROOT}"'/lib; in lib.pipe { a = { x = 1; }; } [ (lib.mapAttrsToList (_: v: lib.attrByPath [ "x" ] 0 v + "s")) ]'

status=0
plain="$(nix eval --impure --json --expr "${expr}" 2>&1)" || status=$?
traced="$(nix eval --impure --json --show-trace --expr "${expr}" 2>&1)" || true
```

注意 `--json`。这不是随手加的：

```text
$ nix eval --impure --expr 'let lib = import ./lib; in lib.pipe { a = { x = 1; }; } [ (lib.mapAttrsToList (_: v: v.x + "s")) ]'
[ «error: cannot add a string to an integer» ]
$ echo $?
0
```

这段表达式里的错误，被 `nix eval` 当成一个可以打印的值，**退出码是 0**。因为 `mapAttrsToList` 返回的是一个列表，列表的元素是惰性的，`nix eval` 默认只把外层求值到可以打印的程度，遇到元素求值失败就把错误当成一个占位符印出来，不再向外抛。`--json` 要求每个元素都变成 JSON，所以必须真的求值，错误才会作为错误出现。我是写这个实验时才撞上的：我以为错误在，退出码就非零，结果它安静地成功了。这条规则的意义在测试里很重要：判断一个函数是否报错，不能只看它的返回值能不能打印。

### 不加 --show-trace 和加了

```text
$ cat out/ch05/show_trace_fail.stdout
== without --show-trace: 1, 7 lines
error:
       … while evaluating list element at index 0

       error: cannot add a string to an integer
       at «string»:1:141:
            1| let lib = import $FIRN_ROOT/lib; in lib.pipe { a = { x = 1; }; } [ (lib.mapAttrsToList (_: v: lib.attrByPath [ "x" ] 0 v + "s")) ]
             |                                                                                                                                             ^
== with --show-trace: 26 lines
error:
       … while evaluating list element at index 0
       … while calling anonymous lambda
         at $FIRN_ROOT/lib/attrsets.nix:48:35:
         at $FIRN_ROOT/lib/attrsets.nix:48:41:
       … while calling anonymous lambda
       error: cannot add a string to an integer
```

脚本的第一行 `1, 7 lines` 是退出状态 1 和输出的行数。不带 `--show-trace` 是 7 行：一个 `while evaluating list element at index 0`，错误本身，错误位置。带了是 26 行，我用 `grep` 过滤出了框架行，上面的块里是过滤后的结果。多出来的就是“你写的代码是被哪一层 lib 函数调起来的”：`lib/attrsets.nix:48:35` 和 `48:41` 是 `mapAttrsToList` 里 `map (name: f name attrs.${name})` 那一行，我的匿名函数是被它调用的。

读 trace 有一个次序：**最下面一条是错误本身，往上是它的调用者**，最上面是你敲命令的地方。错误位置只说“哪个表达式不对”，trace 才说“谁让它被求值”。在没有 trace 的情况下遇到 `lib.pipe` 里的错误，你只知道是第 0 个元素有问题，却不知道是 `mapAttrsToList` 的回调。这就是 `--show-trace` 的价值：第 3 篇用 `builtins.trace` 打印求值顺序，是“主动往日志里写”，`--show-trace` 是“出了事回头翻调用栈”。

### 另外几种常见的错误长相

`show_trace_fail.sh` 只演示了一种。[`lab/ch05/error_kinds.sh`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/error_kinds.sh) 把写 `lib` 的过程中我撞上的另外四类放在一起，都用 Firn 的函数触发；脚本用 `grep` 去掉源码片段，只留框架行和最后的消息：

```text
$ cat out/ch05/error_kinds.stdout
== 1. type error
error:
       … while evaluating a branch condition
       … in the right operand of the AND (&&) operator
       error: expected a list but found a string: "a"
== 2. thrown by the library
error:
       … while calling the 'throw' builtin
       error: firn: splitString: separator must not be empty
== 3. missing attribute
error: attribute 'nosuchfn' missing
       at «string»:1:28:
            1| let lib = import ./lib; in lib.nosuchfn
             |                            ^
== 4. error inside a value
{ a = «error: attempt to call something which is not a function but an integer: 5»; }
exit (printed as a value): 0
error:
       error: attempt to call something which is not a function but an integer: 5
exit (forced with --json): 1
```

第一类是类型不对：传了字符串，函数要列表。读法是从下往上：最后一行是“什么错”，上面带 `…` 的是“在做什么的时候”。注意这条消息没有说哪个函数的哪个参数错了。完整输出里的位置指向 `lib/attrsets.nix` 第 8 行的 `builtins.head path`，那是抱怨的地方，不是传错参数的人；真正的肇事者是调用者，把 `"a"` 当成了 `[ "a" ]`。完整输出的末尾还有一行 `(stack trace truncated; use '--show-trace' to show the full, detailed trace)`：不加 `--show-trace` 的时候，Nix 自己就告诉你它折叠了东西。

第二类是库自己抛的错。这一条来自 `lib/strings.nix` 第 53 行的 `throw`。我给库里所有自己抛的错加了 `firn: <函数名>:` 前缀：没有前缀的话，你看到的是一句孤零零的 `separator must not be empty`，在一个同时加载了二十个库的求值里，没人知道是谁说的。这是我自己定的规矩，不是 Nix 的要求。

第三类是属性不存在，最短也最好认：没有 `…` 框架行，因为错误发生在最外层表达式里，没有谁在调用谁。

第四类前面已经见过一次，这里换成属性集版本：第一条命令把错误当成值打印，退出码是 0；加了 `--json` 之后同一个错误被强制求值，退出码是 1。`runTests` 用 `==` 比较，`==` 会强制，所以测试能发现它；只靠“命令跑完了没报错”来检查，发现不了。

## builtins.break 与 --debugger

### 在表达式中间停下来

看调用链只能事后诸葛。`builtins.break` 让你在表达式**中间**停下来看当时的变量，实现在 Nix 2.34.9 的 [`primops.cc` 第 959 到 980 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/primops.cc#L959-L980)：

```cpp
         if (state.canDebug()) {
             auto error = Error(
                 ErrorInfo{
                     .level = lvlInfo,
                     .msg = HintFmt("breakpoint reached"),
                     .pos = state.positions[pos],
                 });

             state.runDebugRepl(&error);
         }

         // Return the value we were passed.
         v = *args[0];
```

两点：`canDebug()` 为假时（没加 `--debugger`），`break` 就是恒等函数，原样返回参数，所以可以放心把它留在代码里；为真时，它构造一个 `lvlInfo` 级别的“错误”，把它交给调试器 REPL。官方对这个 builtin 的描述在[手册的 `builtins.break`](https://nix.dev/manual/nix/2.34/language/builtins#builtins-break)，`--debugger` 选项在 [`nix eval` 的文档](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-eval#opt-debugger)里。

[`debugger_host.sh`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/debugger_host.sh) 是一个 `_host` 实验：调试器要终端，所以我用 `script(1)` 起一个伪终端，把命令从标准输入灌进去。它的主体：

```bash
readonly expr='let x = 40; y = x + 2; in builtins.break (x + y)'

printf ':env\n:bt\n:q\n' \
  | script -qec "nix eval --debugger --expr '${expr}'" /dev/null 2>&1 \
  | tr -d '\r' \
  | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' \
  | head -n 40 || true
```

`tr` 和 `sed` 是去掉伪终端带来的回车和 ANSI 转义。输出：

```text
$ cat out/ch05/debugger_host.stdout
:env
:bt
:q
info: breakpoint reached

Nix 2.34.9 debugger
Type :? for help.
nix-repl> :env
Env level 0
static: x y 

Env level 1
builtins true false null fromTOML fetchTree fetchTarball fetchGit fetchMercurial scopedImport import isNull break abort throw derivationStrict placeholder baseNameOf dirOf removeAttrs map toString derivation 


nix-repl> :bt

0: error: breakpoint reached

1: while calling a function
«string»:1:27

     1| let x = 40; y = x + 2; in builtins.break (x + y)
      |                           ^

2: while evaluating a 'let' expression

nix-repl> :q
error:
       … while calling the 'break' builtin
         at «string»:1:27:
            1| let x = 40; y = x + 2; in builtins.break (x + y)
             |                           ^

       error: breakpoint reached
```

开头三行 `:env`、`:bt`、`:q` 是伪终端把我灌进去的输入回显出来的。`:env` 列出当前作用域：Env level 0 是 `let` 的静态绑定 `x y`，Env level 1 是不写 `builtins.` 前缀也能直接用的那批全局名字（`import`、`map`、`derivation` 等）。`:bt` 打印回溯：第 0 帧是这个断点，第 1 帧是调用 `break` 的位置，第 2 帧是外层的 `let`。`:q` 离开以后，Nix 把断点当成一个未处理的错误打出来并以非零状态退出，这就是脚本末尾 `|| true` 的原因。

### 出错也会进来

调试器不只服务于 `break`：任何错误都会在抛出的地方打开同一个 REPL。同样的伪终端手法，对一个最简单的 `throw`：

```text
$ printf ':bt\n:q\n' | script -qec "nix eval --debugger --expr 'throw \"x\"'" /dev/null 2>&1 | tr -d '\r' | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' | head -n 15
:bt
:q
error: x

Nix 2.34.9 debugger
Type :? for help.
nix-repl> :bt

0: error: x
«string»:1:1

     1| throw "x"
      | ^

1: while calling a function
```

我在写库的时候最常用的不是 `break`，而是这一种：报错的时候不想去 `--show-trace` 里翻，加上 `--debugger`，在出错那一刻敲 `:env` 看当时的局部变量，通常一眼就看出是哪个值不是我以为的样子。局限是它只在命令行里用：交互式 REPL 要终端，所以它进不了 CI，这也是为什么我给这个实验加了 `_host` 后缀：`CI=true` 时被运行器跳过。

## generators：行序要从列表里来

`lib/generators.nix` 做的事很小：把 Nix 的值渲染成配置文件文本，`toKeyValue` 渲染 `key = value` 的行，`toINI` 在外面套一层 `[节]`。它只有 50 行，但是里面有一个设计，是第 2 篇留下的问题换来的：属性集是按键排序的，所以如果参数是一个属性集，你没法决定输出里哪个键在前。

nixpkgs 的 `generators.toKeyValue` 吃属性集，排序后输出，对大多数配置文件无所谓。Firn 要写的是 Cairn 的配置文本，第 15 篇里 `cairn.configText` 要和一个固定的 fixture 逐字节相等，行序是 `repo`、`source`（可重复）、`exclude`（可重复）、`keep_last`、`keep_daily`、`keep_weekly`。按键排序的话，`keep_*` 会排在 `repo` 前面。所以我让 `toKeyValue` 同时接受两种参数：

```nix
  # 属性集按键排序，行序只能来自列表：
  # 参数可以是属性集（按键排序，和 nixpkgs 一致），
  # 也可以是 { name; value; } 的列表（保持列表顺序）。
  toPairs =
    input:
    if builtins.isList input then
      input
    else
      builtins.attrValues (builtins.mapAttrs (name: value: { inherit name value; }) input);
```

`toPairs` 把两种输入都规整成“`{ name; value; }` 的列表”，后面的渲染只认列表。属性集那一支顺带借用了 `attrValues` 按键排序的性质，行为和 nixpkgs 一致。列表值再展开成每个元素一行：

```nix
  toKeyValue =
    {
      sep ? " = ",
    }:
    input:
    builtins.concatStringsSep "" (
      map (
        pair:
        let
          values = if builtins.isList pair.value then pair.value else [ pair.value ];
        in
        builtins.concatStringsSep "" (map (v: "${pair.name}${sep}${renderScalar v}\n") values)
      ) (toPairs input)
    );
```

[`lab/ch05/generators.nix`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/generators.nix) 用它渲染一份 Cairn 配置，并把“如果传属性集，会怎样”也放进输出里做对照（如果渲染结果不等于期望文本，实验直接 `throw`）：

```nix
  cairnConf = lib.toKeyValue { } [
    (pair "repo" "/var/lib/cairn/repo")
    (pair "source" [
      "/srv/data"
      "/etc"
    ])
    (pair "exclude" [ "*.tmp" ])
    (pair "keep_last" 5)
    (pair "keep_daily" 7)
    (pair "keep_weekly" 4)
  ];
```

```text
$ cat out/ch05/generators.stdout
{ cairnConf = [ "repo = /var/lib/cairn/repo" "source = /srv/data" "source = /etc" "exclude = *.tmp" "keep_last = 5" "keep_daily = 7" "keep_weekly = 4" "" ]; ini = [ "[service]" "enabled = true" "port = 8080" "" "[paths]" "root = /srv" "" ]; sortedAttrsetOrder = [ "keep_last = 5" "repo = /r" "source = /a" "" ]; }
```

`cairnConf` 是我要的顺序；`sortedAttrsetOrder` 是同样的三个键以属性集传进去的结果，`keep_last` 排在最前，`repo` 在中间。每个列表末尾的 `""` 是我为了显示用 `splitString "\n"` 切开的，文本以换行结尾，所以最后一段是空串。`ini` 里布尔值渲染成 `true`、整数渲染成 `8080`，节之间空一行。`renderScalar` 处理的就是这三种：布尔、字符串、其余用 `toString`。

## 测试：runTests

### 约定

`tests/lib.nix` 在第 2 篇是一个自己写的失败列表：一堆 `{ expr; expected; }`，用 `builtins.filter` 筛出 `expr != expected` 的。这一章把它改成 nixpkgs 的约定：[`lib/debug.nix`](https://github.com/bfmhno3/firn/blob/ch05/lib/debug.nix) 里的 `runTests`，27 行，我整个贴出来：

```nix
# 调试与测试工具。runTests 的约定和 nixpkgs 的 lib.debug.runTests 相同。
let
  # tests 是属性集，名字以 test 开头的属性必须是 { expr; expected; }。
  # 返回失败用例的列表，每项是 { name; expected; result; }；空列表表示全部通过。
  runTests =
    tests:
    builtins.concatLists (
      builtins.attrValues (
        builtins.mapAttrs (
          name: test:
          if builtins.substring 0 4 name == "test" && test.expr != test.expected then
            [
              {
                inherit name;
                inherit (test) expected;
                result = test.expr;
              }
            ]
          else
            [ ]
        ) tests
      )
    );
in
{
  inherit runTests;
}
```

读法是：对 `tests` 的每个属性做一次 `mapAttrs`，每一项返回 0 或 1 个元素的列表，再 `concatLists` 拍平。这是一个小的“filter + map”合并手法，因为失败的用例要带上名字，单独 `filter` 做不到。属性名必须以 `test` 开头，这让你可以在同一个属性集里放辅助值（`helper`、`fixtures`）而不被当成用例。

它和 nixpkgs 的版本，在锁定的 revision 里是这样（[`lib/debug.nix#L512-L538`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/debug.nix#L512-L538)）：

```nix
# nixpkgs lib/debug.nix:512-538
  runTests =
    tests:
    concatLists (
      attrValues (
        mapAttrs (
          name: test:
          let
            testsToRun = if tests ? tests then tests.tests else [ ];
          in
          if
            (substring 0 4 name == "test" || elem name testsToRun)
            && ((testsToRun == [ ]) || elem name tests.tests)
            && (test.expr != test.expected)

          then
            [
              {
                inherit name;
                expected = test.expected;
                result = test.expr;
              }
            ]
          else
            [ ]
        ) tests
      )
    );
```

结构一模一样，多出来的是一个 `tests = [ "testName" ]` 子集选择：在属性集里放一个叫 `tests` 的列表，只有列表里的用例会跑，而且名字不必以 `test` 开头（它的[文档注释在第 457 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/debug.nix#L457)）。我没有抄这一支，因为 Firn 的测试集只有 73 个，全跑只要几十毫秒：

```text
$ time nix eval --file tests/lib.nix
[ ]

real	0m0.045s
```

`[ ]` 是空的失败列表，45 毫秒，其中大半是 `nix` 进程自己的启动。同一份文件里 `lib/debug.nix` 之外，nixpkgs 还有 `traceVal`、`traceSeq` 一族（[第 78 到 307 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/debug.nix#L78-L307)）和 `testAllTrue`（[第 682 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/debug.nix#L682)），Firn 不放：`builtins.trace` 已经够用，Firn 的 `debug` 子集只放这一章要用的东西。

### 从 47 个到 73 个

改写 `tests/lib.nix` 的 diff 小得出奇。第 4 篇的末尾：

```nix
  failed = builtins.filter (t: t.expr != t.expected) (
    builtins.attrValues (builtins.mapAttrs (name: t: t // { inherit name; }) cases)
  );
in
failed
```

现在：

```nix
  failed = lib.runTests cases;
in
failed
```

所有用例的名字加了 `test` 前缀（`id` 变成 `testId`），这是唯一必须改的地方。同时用例从 47 个增加到 73 个：

```text
$ grep -c '^    test' tests/lib.nix
73
```

新增的 26 个是这一章写的函数：`range` 3 个、`unique` 2 个、`flatten` 2 个、`sum` 2 个、`findFirst` 3 个、`imap0` 1 个、`attrsets` 的新增 5 个各 1 个、`toKeyValue` 5 个、`toINI` 1 个、`runTests` 自己 2 个。最后这两个是“测试测试者”：一个确认名字不以 `test` 开头的属性被忽略，一个确认失败的用例确实被报告：

```nix
    testRunTestsReportsFailure = {
      expr = lib.runTests {
        testBad = {
          expr = 1;
          expected = 2;
        };
        testGood = {
          expr = 1;
          expected = 1;
        };
      };
      expected = [
        {
          name = "testBad";
          expected = 2;
          result = 1;
        }
      ];
    };
```

如果一个测试框架的“失败”分支从来没有被执行过，那它的绿色就没有信息量。`testRunTestsReportsFailure` 保证的是这个分支至少被走过一次。

### 看一份失败的记录

[`lab/ch05/run_tests.nix`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/run_tests.nix) 对 [`fixtures/broken_tests.nix`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/fixtures/broken_tests.nix) 跑 `runTests`。fixture 里 4 个属性：两个故意写错、一个正确、一个名字不以 `test` 开头所以不被执行：

```text
$ cat out/ch05/run_tests.stdout
[ { expected = 3; name = "testAddWrong"; result = 2; } { expected = "ba"; name = "testStringWrong"; result = "ab"; } ]
```

两个失败，各自带 `name`、`expected`、`result`。`notATest` 的期望值明明是错的（`1` 不等于 `2`），却没有出现，正是前缀规则起了作用。

### 写测试的几个层次

`runTests` 只是其中一层。Firn 这个系列会用到四层，各自检查的东西不一样：

| 层次 | 检查什么 | 在哪里发生 | 失败的样子 | 篇目 |
| --- | --- | --- | --- | --- |
| `runTests` | 纯函数的输入输出 | 求值时 | 一个失败记录的列表 | 本篇 |
| flake 检查 | 把上一层接进 `nix flake check` | 求值加一个构建 | 构建日志里的记录 | 本篇 |
| NixOS VM 测试 | 服务真的能在虚拟机里跑起来 | 虚拟机里 | Python 驱动脚本的断言失败 | 第 16 篇 |
| nix-unit | 和 `runTests` 同样形状的用例，由专门的工具运行和报告 | 求值时 | 逐用例的报告 | 第 20 篇 |

前两层是“对着一个值说话”，成本最低：`runTests` 这一层 45 毫秒，整个 `make check` 在输出已经在 store 里的情况下 2.0 秒。它们抓不住的是“这个服务启动后能不能工作”，那是第 16 篇用虚拟机回答的问题。第 20 篇会用 nix-unit 把同样的用例再写一遍，看它怎样报告同样的失败。

## 接进 nix flake check

### lib 和两个检查

跑 `nix eval --file tests/lib.nix` 是我手动做的事，没人保证下次改完 `lib` 我还会跑。`flake.nix` 现在多了三样：

```nix
    {
      lib = firnLib;
      devShells = nixpkgs.lib.mapAttrs (_: devShell: { default = devShell; }) devShells;
      checks = forAllSystems checksFor;
    }
```

`lib = firnLib` 把 Firn 的 `lib` 作为 flake 输出暴露出来，别的 flake 可以用 `firn.lib.toKeyValue`；`nix flake check` 认得这个输出名（下面 `make check` 的日志里有一行 `checking flake output 'lib'`），nixpkgs 的 flake 也导出自己的 `lib`（Firn 的 `flake.nix` 里就在用 `nixpkgs.lib.genAttrs`）。两个检查在 `checksFor` 里：

```nix
          # 失败列表非空时把它打印出来并让构建失败。
          lib-tests = pkgs.runCommand "firn-lib-tests" { } (
            if failures == [ ] then
              "echo ok > $out"
            else
              ''
                echo ${pkgs.lib.escapeShellArg (builtins.toJSON failures)} | ${pkgs.jq}/bin/jq . >&2
                exit 1
              ''
          );
```

这里有一个值得停一下的地方：`failures == [ ]` 是在**求值**时判断的，不是在构建时。`runCommand` 的第三个参数是一个字符串，`if` 在求值时就选好了写哪一个。通过的时候，构建只是 `echo ok > $out`，一个空操作；失败的时候，构建脚本是“把失败记录打印出来，然后 `exit 1`”。所以真正的测试发生在求值，构建只是把“求值得到的结论”变成一个会失败的派生物，让 `nix flake check` 能认出来。后果是：如果某个测试表达式自己 `throw` 了，失败不会出现在构建日志里，而是求值直接中断。我在同一份 `/tmp/firn-scratch05` 副本里（下一节会说明它是怎么来的）先 `git checkout -- .` 丢掉上一次的修改，再把 `testId` 的表达式换成 `throw "boom"`：

```text
$ git checkout -- .
$ sed -i '0,/expr = lib.id 3;/s//expr = throw "boom";/' tests/lib.nix
$ nix build -L .#checks.x86_64-linux.lib-tests 2>&1 | grep -E '^ *(error|… while evaluating)'
error:
       … while evaluating derivation 'firn-lib-tests'
       … while evaluating attribute 'buildCommand' of derivation 'firn-lib-tests'
       error: boom
```

这里没有 `building`，也没有 `firn-lib-tests>` 开头的日志行：错误出在“求值 `buildCommand` 属性”的时候，消息是 `boom`，没有失败记录，没有“哪个用例”。这是这种写法的局限：它能报告“期望不符”，报告不了“表达式自己出错”。

第二个检查守住第 4 篇生成的 README 表：

```nix
          readme-table =
            pkgs.runCommand "firn-readme-table"
              {
                readme = ./README.md;
                expected = firnLib.renderChapterTable chapters;
              }
              ''
                sed -n '/<!-- chapters:begin -->/,/<!-- chapters:end -->/p' "$readme" | sed '1d;$d' > actual
                printf '%s' "$expected" > want
                diff -u want actual >&2
                echo ok > $out
              '';
```

`runCommand` 的第二个参数是一个属性集，里面的属性会变成构建环境里的环境变量：`readme` 是 `./README.md`（路径放进派生物的属性时会先被复制进 store，第 2 篇讲过，变量里是 store 路径），`expected` 是 Nix 里算好的字符串。脚本把 README 里两个标记之间的内容取出来，和 `expected` 做 `diff -u`，不同则 `diff` 返回非零，构建失败。这是一个**读取源码树文件**的检查：README 是仓库里的文件，沙箱里的构建本来看不见它，是 Nix 在求值时把它复制进 store、再把 store 路径交给构建脚本，它才读得到。

### make check 和 make ci

`Makefile` 里 `check` 就是一行：

```make
check:
	nix flake check -L

ci: lint chapters check
```

`ci` 从这一章起是 `lint chapters check`，这就是第 1 篇的 `make ci` 加上了第三项。运行：

```text
$ make check
nix flake check -L
evaluating flake...
checking flake output 'lib'...
checking flake output 'devShells'...
checking derivation devShells.x86_64-linux.default...
derivation evaluated to /nix/store/hqf6pjp28l6xfrnaccyc1x6y1877qj0n-nix-shell.drv
checking flake output 'checks'...
checking derivation checks.x86_64-linux.dev-shell...
derivation evaluated to /nix/store/hqf6pjp28l6xfrnaccyc1x6y1877qj0n-nix-shell.drv
checking derivation checks.x86_64-linux.lib-tests...
derivation evaluated to /nix/store/lr09padw7kwxbdf5ck6s24ygksxggk9i-firn-lib-tests.drv
checking derivation checks.x86_64-linux.readme-table...
derivation evaluated to /nix/store/sijbmandklhrpags309nab61gnajf4p3-firn-readme-table.drv
running 0 flake checks...
all checks passed!
warning: The check omitted these incompatible systems: aarch64-linux
Use '--all-systems' to check all.
```

这一次整个命令用了 2.0 秒。两件事要说明。其一，我在这一章已经构建过这两个检查，输出在 store 里，所以日志里没有任何 `building`：`nix flake check` 求值每个检查，再去 store 里找它们的输出，找到了就不重做。“running 0 flake checks”里的 0 我没有深究是在数什么，我猜它指的是不属于 `checks` 派生物的另一类检查，没有读源码确认。其二，最后的警告：flake 声明了两个系统，`nix flake check` 默认只检查当前系统，加 `--all-systems` 才检查另一个。

注意 `checks.x86_64-linux.dev-shell` 和 `devShells.x86_64-linux.default` 得到同一个 `.drv`（两行日志里的哈希相同），这是第 1 篇里 `dev-shell` 检查的写法：检查就是“这个 shell 能求值”。

### 让它失败一次

绿色的检查如果从没红过，我不会信它。要让它红，不能在 `~/Projects/firn` 里改：我克隆一份到 `/tmp`，在副本里做三次互不相干的破坏。每次破坏前先 `git checkout -- .`，把上一次的修改丢掉，这样每个实验都从干净的 `ch05` 出发。第一次，把 `testId` 的期望值改错，再构建：

```text
$ git clone -q --branch ch05 ~/Projects/firn /tmp/firn-scratch05
$ cd /tmp/firn-scratch05
$ git checkout -- .
$ sed -i '0,/expected = 3;/s//expected = 4;/' tests/lib.nix
$ nix build -L .#checks.x86_64-linux.lib-tests
warning: Git tree '/tmp/firn-scratch05' is dirty
this derivation will be built:
  /nix/store/hcm4ql3nphpripi0v4303ai37m0pm0r6-firn-lib-tests.drv
building '/nix/store/hcm4ql3nphpripi0v4303ai37m0pm0r6-firn-lib-tests.drv'...
firn-lib-tests> [
firn-lib-tests>   {
firn-lib-tests>     "expected": 4,
firn-lib-tests>     "name": "testId",
firn-lib-tests>     "result": 3
firn-lib-tests>   }
firn-lib-tests> ]
error: Cannot build '/nix/store/hcm4ql3nphpripi0v4303ai37m0pm0r6-firn-lib-tests.drv'.
       Reason: builder failed with exit code 1.
       Output paths:
         /nix/store/7nc3vmaq8gn2iqndmdh13n8pp4ymj38d-firn-lib-tests
       Last 7 log lines:
       > [
       >   {
       >     "expected": 4,
       >     "name": "testId",
       >     "result": 3
       >   }
       > ]
       For full logs, run:
         nix log /nix/store/hcm4ql3nphpripi0v4303ai37m0pm0r6-firn-lib-tests.drv
```

构建失败，退出码 1，日志里是我想要的失败记录：哪个用例、期望什么、实际得到什么。这是我设计这段 `jq .` 管道的原因：只说“失败了”没用，要把 `runTests` 的记录原样送到日志里。（第一行警告只是因为这份副本里有未提交的修改。）

另一个检查同理。把副本里 README 表的第一行从“第一次求值”改成 `第1次求值`：

```text
$ git checkout -- .
$ sed -i 's/^| `ch01` | 第一次求值/| `ch01` | 第1次求值/' README.md
$ nix build -L .#checks.x86_64-linux.readme-table
firn-readme-table> --- want     2026-11-03 15:46:20.454536050 +0000
firn-readme-table> +++ actual   2026-11-03 15:46:20.454536050 +0000
firn-readme-table> @@ -1,6 +1,6 @@
firn-readme-table>  | Chapter | Topic | Post |
firn-readme-table>  | --- | --- | --- |
firn-readme-table> -| `ch01` | 第一次求值：nix repl、三副面孔与一段历史 | `/posts/nix-by-firn-01-first-eval/` |
firn-readme-table> +| `ch01` | 第1次求值：nix repl、三副面孔与一段历史 | `/posts/nix-by-firn-01-first-eval/` |
```

（上面这份输出省略了 `building` 行、`ch02` 到 `ch04` 三行上下文和最后的 `error:` 段，真实日志更长。）`diff -u` 的输出直接成了日志：`-` 是 `renderChapterTable` 算出来的，`+` 是 README 里实际的。这样一个人改了 README 里生成的部分但忘了改 `data/chapters.toml`，`make check` 会拦住他。

再做一次破坏，这次不改测试，改**被测的代码**。先丢掉 README 的修改，再在 `lib/lists.nix` 里把 `range` 的元素个数 `last - first + 1` 少算一个：

```text
$ git checkout -- .
$ sed -i 's/(last - first + 1)/(last - first)/' lib/lists.nix
$ nix build -L .#checks.x86_64-linux.lib-tests 2>&1 | sed -n 's/^firn-lib-tests> //p' | jq -c '.[]'
{"expected":[2,3,4,5],"name":"testRangeBasic","result":[2,3,4]}
{"expected":[3],"name":"testRangeSingle","result":[]}
```

73 个测试里有 2 个变红：`testRangeBasic` 期望 `[ 2 3 4 5 ]` 得到 `[ 2 3 4 ]`，`testRangeSingle` 期望 `[ 3 ]` 得到 `[ ]`；`testRangeEmpty` 仍然绿，因为空区间本来就返回空列表。一个差一的错误，被 3 个 `range` 用例里的 2 个抓住，漏掉的那个只守着空区间这一种形状。每个用例守一种形状，所以边界要各写一个。

## 为什么 lib 和 builtins、pkgs 都分开

### 和 builtins

`foldl'` 那一节已经给了答案：`builtins` 是求值器里的 C++ 函数，跟着 Nix 版本走；`lib` 是 nixpkgs 里的 Nix 文件，跟着 nixpkgs 走。想给 `builtins.foldl'` 修一个行为，要等 Nix 发新版；想让 `lib.foldl'` 在它前面补一个 `seq acc`，改一个文件就行，那一行补丁已经躺在上面引用的第 278 到 286 行里。`lib` 是 `builtins` 上面的一层，可以在上面加东西、修东西，不需要重新发布求值器。

### 和 pkgs

`lib` 没有包依赖，这一点可以直接验证：

```text
$ nix eval --impure --expr 'let pkgs = import ./nix/pkgs.nix { }; l = import "${(import ./nix/pins.nix).nixpkgs}/lib"; in { viaPkgs = builtins.length (builtins.attrNames pkgs.lib); direct = builtins.length (builtins.attrNames l); isFn = builtins.isFunction l; version = l.version; }'
{ direct = 494; isFn = false; version = "26.11pre-git"; viaPkgs = 494; }
```

`import ".../lib"` 不是函数（`isFn = false`），不需要 `system`，不需要 `config`，不需要 `overlays`，直接是一个有 494 个名字的属性集；通过 `pkgs.lib` 拿到的是同一个。而 `pkgs` 是 `import nixpkgs { system; ... }` 的结果，是一个函数的返回值，要选平台、解析 overlay，第 1 篇量过：27959 个顶层属性，182 毫秒；`lib` 是 530 个 thunk，20 毫秒左右。

Firn 的 `lib` 也守这条线。它不依赖 nixpkgs 这件事，我用 `grep` 查：

```text
$ grep -rnE 'nixpkgs|pkgs' lib/
lib/debug.nix:1:# 调试与测试工具。runTests 的约定和 nixpkgs 的 lib.debug.runTests 相同。
lib/default.nix:1:# Firn 自己的库入口，不依赖 nixpkgs。导出子集和扁平的常用函数。
lib/fixed-points.nix:2:# 和 nixpkgs 的 lib/fixed-points.nix 同一个思路，去掉了文档和别名。
lib/generators.nix:4:  # 参数可以是属性集（按键排序，和 nixpkgs 一致），
```

4 行，全是注释。这条规则的好处不止是快：一个不依赖包的库可以在任何地方求值（flake 的 `lib` 输出、`nixosModules` 的参数、`nix eval` 的一行命令），而且不会意外把“构建一个包”拖进“算一个字符串”。第 15 篇里 `modules/cairn-settings.nix` 会 `import` Firn 的 `lib`，同一份代码在 NixOS 和 Home Manager 两个求值里都能用，就是靠这一点。

## 让我意外的事

写这一篇之前，我对“写一个自己的 lib”的预期，是它大概会是 nixpkgs 的缩小版，简单、能用、慢一点。结果是它比我想的更不一样：

**`foldl'` 的赢面不是内存。** 我原本以为严格求值的意义是省空间。量下来 `foldl'` 1 到 9000 分配了 662,992 字节，朴素递归只有 304,272，多 2.2 倍，因为它要先造一个 9000 个元素的列表。thunk 数从 9001 降到 3，是真的，但这件事带来的好处是深度：一百万项能跑，一万项的朴素版本就不行。我猜这就是它在 `builtins` 里被实现成 C++ 循环的原因，不过那是我的推测。

**我自己写的 `findFirst` 是平方的，而测试全是绿的。** 73 个测试里有 3 个专门测 `findFirst`，包括“找到后不看后面的元素”。它们全部通过，我是在把它和 nixpkgs 的实现对读时才发现问题的。[`lab/ch05/find_first_cost.sh`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/find_first_cost.sh) 把两个实现放在一起量：在 9000 个元素的列表里找最后一个，再在 20000 个元素的列表里找最后一个。

```text
$ cat out/ch05/find_first_cost.stdout
firn:    {"nrThunks":18059,"nrFunctionCalls":45002,"cpuTime":0.11943899840116501,"totalBytes":325441376}
nixpkgs: {"nrThunks":695,"nrFunctionCalls":36013,"cpuTime":0.01769700087606907,"totalBytes":1124416}
allocation ratio: 289x, cpu ratio: 6.7x, bytes per step: 36160
== 20000 elements
firn: error: stack overflow; max-call-depth exceeded
nixpkgs: 20000
```

分配 325,441,376 字节对 1,124,416 字节，289 倍；CPU 时间这一次是 0.119 秒对 0.018 秒，6.7 倍（`cpuTime` 每次跑都不一样，只有分配的字节数是稳定的，所以别把 CPU 比值当常数）。每一步我调用一次 `builtins.tail`，`tail` 要复制剩下的列表：9000 步里平均剩下 4500 个元素，每个指针 8 字节，每步 36,000 字节，实验打印的每步字节数是 36160。数字对得上，所以我相信机制就是这个，虽然我没有读 `tail` 的实现。更糟的是它还背着一个天花板：因为是递归，列表长到 20000 就撞上 `max-call-depth`，而 nixpkgs 的版本毫无压力（最后两行）。

nixpkgs 用的是 `foldl'` 扫整个列表，累加器是 `{ found; value; }`（[`lib/lists.nix` 第 648 行起](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/lists.nix#L648)）。它**不会**提前停下，找到之后后面的元素还是要走一遍，但每个元素的代价只是一次 `acc.found` 的判断，而且不会为了避开元素而去复制列表。时间复杂度是 $O(n)$ 而不是 $O(n^2)$，也没有深度问题。我把 Firn 里这份写法留在仓库里没有改：它是这一章最诚实的反例，练习 3 让你把它改对。

**`nix eval` 会把错误当成值打印出来，退出码还是 0。** 我说的是 `[ «error: cannot add a string to an integer» ]` 那一行。我以前以为 Nix 的错误是“要么整个表达式求值成功，要么整个失败”，可是惰性意味着“求值成功”只到你实际去用的那一层为止。给 CI 写检查的时候，“命令退出 0”不能当作“表达式没有错误”，要么加 `--json`（强制每个元素求值），要么像 `runTests` 那样自己用 `==` 去比较。

## 检查点

在 `~/firn` 里，`nix develop` 之内：

```bash
make ch05
make lint
make check
for f in lib/default.nix lib/attrsets.nix lib/lists.nix lib/generators.nix \
  lib/debug.nix tests/lib.nix flake.nix Makefile README.md \
  lab/ch05/*.nix lab/ch05/*.sh lab/ch05/fixtures/*.nix; do
  diff <(git -C ~/firn-ref show ch05:"${f}") "${f}" && echo "same ${f}"
done
```

`make ch05`（设了 `CI` 的环境下，`debugger_host.sh` 会被跳过；没设就是下面这样）应当打印这 16 行：

```text
bash scripts/chapter.sh ch05
ok   lab/ch05/call_depth_limit.sh
ok   lab/ch05/call_depth_wall.sh
ok   lab/ch05/compare_nixpkgs_lib.nix
ok   lab/ch05/debugger_host.sh
ok   lab/ch05/error_kinds.sh
ok   lab/ch05/ex_partition.nix
ok   lab/ch05/find_first_cost.sh
ok   lab/ch05/fold_memory.sh
ok   lab/ch05/foldl_strict.nix
ok   lab/ch05/generators.nix
ok   lab/ch05/lib_foldl_depth.sh
ok   lab/ch05/recursion_depth.nix
ok   lab/ch05/run_tests.nix
ok   lab/ch05/show_trace_fail.sh
ok   lab/ch05/stack_overflow_fail.nix
```

`show_trace_fail.sh` 和 `stack_overflow_fail.nix` 这两个名字以 `_fail` 结尾：运行器要求它们以非零状态退出（实际都是 1），所以它们的 `ok` 恰恰说明它们失败了。另外几个需要 `nix eval` 失败的实验（`call_depth_limit.sh`、`call_depth_wall.sh`、`error_kinds.sh`）把失败都吞进了变量或 `|| true`，自己退出 0。`debugger_host.sh` 以 `_host` 结尾：设了 `CI=true` 时运行器会打印 `skip lab/ch05/debugger_host.sh (host only)` 并跳过它，这一章的 `make ch05` 在 CI 里只有 14 行 `ok` 加一行 `skip`。

`make lint` 只回显它跑的那几条命令（`nixfmt --check`、`deadnix --fail`、`shellcheck`、`shfmt`；`statix` 那一行以 `@` 开头，`make` 不回显它），没有任何诊断，退出码 0。`make check` 应当以 `all checks passed!` 结束，退出码 0，在你的机器上第一次会真的去构建两个检查，所以会多出 `building` 行。

`diff` 循环应当打印 25 行 `same ...`，不打印 diff：9 个仓库文件、7 个 `.nix` 实验、8 个 `.sh` 实验和 1 个 fixture。

**必须和标签一致的文件：** `lib/lists.nix`、`lib/generators.nix`、`lib/debug.nix`、`lib/attrsets.nix`，以及 `lab/ch05/` 下全部 15 个实验和 1 个 fixture。它们已经是这一章的最终版本，后面的章节只会使用它们（`lib/lists.nix` 里的 `findFirst` 我有意没改，见上面的“意外”）。`lab/ch05/*.sh` 里的 8 个脚本在标签里有可执行位，`diff` 不比权限位；你的副本要直接运行它们才需要 `chmod +x`，经运行器调用时用的是 `bash`。

**中间版本（后面的章节会继续改）：**

- [`lib/default.nix`](https://github.com/bfmhno3/firn/blob/ch05/lib/default.nix)：现在导出 48 个名字。第 6 篇加 `store-path`。
- [`tests/lib.nix`](https://github.com/bfmhno3/firn/blob/ch05/tests/lib.nix)：现在是 73 个用例。第 6 篇给 `textStorePath` 加用例，之后每次加函数都会加。第 20 篇把其中一部分改写成 nix-unit 的版本，但这个文件本身继续保留。
- [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch05/flake.nix)：现在有 `lib`、`devShells` 和三个检查（`dev-shell`、`lib-tests`、`readme-table`）。几乎每一章都会往里加输出。
- [`Makefile`](https://github.com/bfmhno3/firn/blob/ch05/Makefile)：现在的 `ci` 是 `lint chapters check`。第 20 篇加 `repro` 目标。
- [`README.md`](https://github.com/bfmhno3/firn/blob/ch05/README.md)：章节表由 `lab/ch04/render_table.nix` 生成，标记之间的内容不要手改（`readme-table` 检查会替你盯着）。

### 文件清单

这一篇的所有文件都在仓库里，链接指向标签 `ch05` 上的那一份。带 `make ch05` 的行是通过运行器跑的（`debugger_host.sh` 要在没设 `CI` 的环境里：`env -u CI make ch05`）；`.nix` 实验也可以直接用 `nix eval --file` 运行，在仓库根目录下。许可证文本不在表里。结果列是我在 Nix 2.34.9 上的真实输出，路径里的用户名和目录是我机器上的。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`Makefile`](https://github.com/bfmhno3/firn/blob/ch05/Makefile) | `make check` | 退出码 0，最后是 `all checks passed!`；`ci` 现在是 `lint chapters check`，31 行 |
| [`README.md`](https://github.com/bfmhno3/firn/blob/ch05/README.md) | `make check` | 退出码 0；`readme-table` 检查通过；Layout 一节的 `lib/` 行多了 `lists, generators, debug` |
| [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch05/flake.nix) | `nix eval .#lib.version` | `"0.1.0"`；`nix build --no-link --print-out-paths .#checks.x86_64-linux.lib-tests` 打印 `/nix/store/hm91ddl7gz228cq1cbg2zgf7c5wak08r-firn-lib-tests`，里面是 `ok`；105 行 |
| [`lib/attrsets.nix`](https://github.com/bfmhno3/firn/blob/ch05/lib/attrsets.nix) | `nix eval --impure --expr '(import ./lib).genAttrs [ "a" "bb" ] builtins.stringLength'` | `{ a = 1; bb = 2; }`；71 行，9 个函数 |
| [`lib/debug.nix`](https://github.com/bfmhno3/firn/blob/ch05/lib/debug.nix) | `nix eval --impure --expr '(import ./lib).runTests { testA = { expr = 1; expected = 1; }; }'` | `[ ]`；27 行 |
| [`lib/default.nix`](https://github.com/bfmhno3/firn/blob/ch05/lib/default.nix) | `nix eval --impure --expr 'builtins.length (builtins.attrNames (import ./lib))'` | `48` |
| [`lib/generators.nix`](https://github.com/bfmhno3/firn/blob/ch05/lib/generators.nix) | `nix eval --impure --expr '(import ./lib).toKeyValue { sep = "="; } { a = 1; }'` | `"a=1\n"`；50 行 |
| [`lib/lists.nix`](https://github.com/bfmhno3/firn/blob/ch05/lib/lists.nix) | `nix eval --impure --expr '(import ./lib).range 2 6'` | `[ 2 3 4 5 6 ]`；38 行，6 个函数 |
| [`tests/lib.nix`](https://github.com/bfmhno3/firn/blob/ch05/tests/lib.nix) | `nix eval --file tests/lib.nix` | `[ ]`，0.045 秒；73 个用例，543 行 |
| [`lab/ch05/call_depth_limit.sh`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/call_depth_limit.sh) | `make ch05` | 退出码 0；`9999` 得 `49995000`，`10000` 得 `error: stack overflow; max-call-depth exceeded`；`max-call-depth` 调到一百万后 `20000` 过、`100000` 得 `stack overflow (possible infinite recursion)`；`stack limit: 8192 KiB` |
| [`lab/ch05/call_depth_wall.sh`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/call_depth_wall.sh) | `make ch05` | 退出码 0；二分得到第一个失败深度 `29200`（步长 100）；`ulimit -s 65536` 下 `29200` 过、`200000` 仍得 `stack overflow (possible infinite recursion)` |
| [`lab/ch05/compare_nixpkgs_lib.nix`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/compare_nixpkgs_lib.nix) | `nix eval --file lab/ch05/compare_nixpkgs_lib.nix` | 退出码 0；14 个函数两边结果相同，不同则 `throw` |
| [`lab/ch05/debugger_host.sh`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/debugger_host.sh) | `env -u CI make ch05` | 退出码 0；`:env` 里 `static: x y`，`:bt` 三帧，末尾 `error: breakpoint reached`；`CI=true` 时 `skip` |
| [`lab/ch05/error_kinds.sh`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/error_kinds.sh) | `make ch05` | 退出码 0；四类错误：类型不对、库自己 `throw`（`firn: splitString: separator must not be empty`）、`attribute 'nosuchfn' missing`、值里的错误（打印时退出码 0，`--json` 强制后 1） |
| [`lab/ch05/ex_partition.nix`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/ex_partition.nix) | `nix eval --file lab/ch05/ex_partition.nix` | 退出码 0；`{ right = [ 3 4 5 ]; wrong = [ 1 2 ]; }`，练习 1 |
| [`lab/ch05/find_first_cost.sh`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/find_first_cost.sh) | `make ch05` | 退出码 0；`totalBytes` 325441376 对 1124416，`allocation ratio: 289x`，`cpu ratio: 6.7x`（每次不同）；20000 个元素 Firn 溢出、nixpkgs 得 `20000` |
| [`lab/ch05/fold_memory.sh`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/fold_memory.sh) | `make ch05` | 退出码 0；`nrThunks` 9001 对 3，`totalBytes` 304272 对 662992，中位耗时 42、25、157 ms（每次不同） |
| [`lab/ch05/foldl_strict.nix`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/foldl_strict.nix) | `nix eval --file lab/ch05/foldl_strict.nix` | 退出码 0；`500000500000` |
| [`lab/ch05/generators.nix`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/generators.nix) | `nix eval --file lab/ch05/generators.nix` | 退出码 0；`cairnConf` 7 行按 `repo`、`source`、`exclude`、`keep_*` 的顺序；`sortedAttrsetOrder` 第一行是 `keep_last = 5` |
| [`lab/ch05/lib_foldl_depth.sh`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/lib_foldl_depth.sh) | `make ch05` | 退出码 0；`foldl 4000` 过、`foldl 5000` 得 `max-call-depth exceeded`，`foldl' 20000` 得 `200010000` |
| [`lab/ch05/recursion_depth.nix`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/recursion_depth.nix) | `nix eval --file lab/ch05/recursion_depth.nix` | 退出码 0；`{ depth = 9999; expected = 49995000; result = 49995000; }` |
| [`lab/ch05/run_tests.nix`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/run_tests.nix) | `nix eval --file lab/ch05/run_tests.nix` | 退出码 0；两个失败记录 `testAddWrong` 和 `testStringWrong` |
| [`lab/ch05/show_trace_fail.sh`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/show_trace_fail.sh) | `make ch05` | 退出码 1（按设计失败）；不带 `--show-trace` 7 行，带了 26 行；错误是 `cannot add a string to an integer` |
| [`lab/ch05/stack_overflow_fail.nix`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/stack_overflow_fail.nix) | `make ch05` | 退出码 1（按设计失败）；stderr 里是 `error: stack overflow; max-call-depth exceeded` |
| [`lab/ch05/fixtures/broken_tests.nix`](https://github.com/bfmhno3/firn/blob/ch05/lab/ch05/fixtures/broken_tests.nix) | `nix eval --file lab/ch05/run_tests.nix` | 被 `run_tests.nix` 导入的数据：4 个属性，其中 2 个失败、1 个通过、1 个因名字不以 `test` 开头被忽略 |

## 练习

**1.** 用 `foldl'` 写 `partition`，一次遍历把列表分成满足和不满足条件的两组，结果是 `{ right; wrong; }`。用 `[ 1 2 3 4 5 ]` 和 `x: x > 2` 检查。

<details>
<summary>参考答案</summary>

这就是 `lab/ch05/ex_partition.nix`，函数本体是：

```nix
  partition =
    pred: list:
    builtins.foldl'
      (
        acc: x:
        if pred x then
          {
            right = acc.right ++ [ x ];
            inherit (acc) wrong;
          }
        else
          {
            wrong = acc.wrong ++ [ x ];
            inherit (acc) right;
          }
      )
      {
        right = [ ];
        wrong = [ ];
      }
      list;
```

累加器是一个属性集，每一步构造一个新的。`inherit (acc) wrong;` 是 `wrong = acc.wrong;` 的缩写，两个分支各自只改一边，另一边原样带过去。运行器的输出：

```text
$ cat out/ch05/ex_partition.stdout
{ right = [ 3 4 5 ]; wrong = [ 1 2 ]; }
```

顺便说一句，nixpkgs 里 `partition` 就是内置的 `builtins.partition`（[`lib/lists.nix` 第 972 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/lists.nix#L972)）。自己写一个的价值是练习累加器的形状，不是替代它。

</details>

**2.** `lib.mapAttrs' (n: v: lib.nameValuePair "x" v) { a = 1; b = 2; }` 的结果是什么？两个键都映射成了 `x`。先预测，再检查，并说明哪一个值留下来、为什么。

<details>
<summary>参考答案</summary>

```text
$ nix eval --impure --expr 'let lib = import ./lib; in lib.mapAttrs'"'"' (n: v: lib.nameValuePair "x" v) { a = 1; b = 2; }'
{ x = 1; }
```

留下来的是 `a` 对应的 `1`。机制有两步：`mapAttrs'` 先按键排序遍历（`a` 在 `b` 前），得到 `[ { name = "x"; value = 1; } { name = "x"; value = 2; } ]`；`builtins.listToAttrs` 遇到重复的名字，第一个生效。nixpkgs 的 `mapAttrs'` 是 `listToAttrs (mapAttrsToList f set)`（[`lib/attrsets.nix` 第 1058 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/attrsets.nix#L1058)），`mapAttrsToList` 同样按键排序，所以同一个规则也适用。写库的时候，这意味着“谁先谁后”是键的字母顺序决定的，不是你的直觉决定的。

</details>

**3.** 把 `findFirst` 改成线性的，并且不会在两万个元素的列表上撞到 `max-call-depth`。不需要自己发明，看看 nixpkgs 怎么做。

<details>
<summary>参考答案</summary>

nixpkgs 的做法（[`lib/lists.nix` 第 648 到 670 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/lists.nix#L648-L670)）：

```nix
  findFirst =
    let
      init = {
        found = false;
      };
    in
    pred: default: list:
    let
      result = foldl' (
        acc: el:
        if !acc.found && pred el then
          # We haven't found a match yet, and the current element passes the
          # predicate!
          {
            found = true;
            value = el;
          }
        else
          # There's already a match, or the current element fails the predicate
          acc
      ) init list;
    in
    if result.found then result.value else default;
```

三点：用 `foldl'` 把递归换成循环，所以没有调用深度的限制；累加器 `{ found; value; }` 记住“找到了没有”和“找到了什么”，所以不需要 `tail`；`!acc.found && pred el` 在找到之后不再调用 `pred`，元素也就不会被求值，`testFindFirstLazyTail` 那个用例的语义保留。代价是找到之后仍然要走完列表。这个版本在 9000 个元素的列表上分配 1,124,416 字节，Firn 当前的实现是 325,441,376 字节，20000 个元素时它能出结果，Firn 的不能，数据见上面的“意外”。如果想保留“找到就停”，另一个办法是用下标递归：`go = i: if i == n then default else if pred (elemAt list i) then elemAt list i else go (i + 1)`，每步 $O(1)$，但递归深度仍然是列表长度，撞不撞 `max-call-depth` 取决于元素位置，我没有为它写实验，不替它做保证。

</details>

**4.** `lab/ch05/compare_nixpkgs_lib.nix` 里没有 `sum`，因为 nixpkgs 的 `lib` 没有同名的函数。用一行命令证明 Firn 的 `sum` 和 nixpkgs 里的 `foldl' builtins.add 0` 在 `range 1 100` 上给出相同的结果。

<details>
<summary>参考答案</summary>

```text
$ nix eval --impure --expr 'let f = import ./lib; n = import "${(import ./nix/pins.nix).nixpkgs}/lib"; xs = f.range 1 100; in [ (f.sum xs) (n.foldl'"'"' builtins.add 0 xs) ]'
[ 5050 5050 ]
```

两个都是 5050，$100 \times 101 / 2$。Firn 的 `sum` 本来就是 `builtins.foldl' builtins.add 0`，`testSumBasic` 和 `testSumEmpty` 是它的两个用例；它不进差分对照，只是因为对照的前提是“两边都有这个名字”。一个函数在 nixpkgs 里不存在，不等于没有等价物，只等于它的使用者每次都自己写那一行。

</details>

## 下一篇

这一篇里 `lib-tests` 和 `readme-table` 都是用 `pkgs.runCommand` 写的，我一直把它当成“一个会跑一段脚本的东西”，没有回答它到底是什么、它的输出为什么在 `/nix/store/hm91ddl7gz228cq1cbg2zgf7c5wak08r-firn-lib-tests` 这种路径里、那串哈希又是怎么算出来的。第 6 篇《derivation 与 /nix/store：.drv、哈希与沙箱》会把这个盒子拆开：我们不用 nixpkgs，只用一个静态链接的 busybox 手写 `derivation`，看 `.drv` 文件里到底写了什么，再在 Firn 的 `lib` 里加一个 `textStorePath`，用 Nix 自己算出和 `builtins.toFile` 一模一样的 store 路径。
