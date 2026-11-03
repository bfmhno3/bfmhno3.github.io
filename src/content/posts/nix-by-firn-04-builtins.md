---
title: "builtins 深挖：import、文件、JSON、正则与字符串上下文"
commentId: "post:nix-by-firn-04-builtins"
published: "2026-11-03 22:00:00 +08:00"
description: "用 Firn 从零学 Nix 第 4 篇：我用 Nix 2.34.9 把 builtins 的 118 个名字分成 12 组，验证 import 只求值一次，故意丢掉字符串上下文做出一个指向不存在路径的文件，还量了导入派生物 (IFD)：nixpkgs 已加载时静态 import 要 170 毫秒，经过 IFD 要 346 毫秒。"
category: Tutorial
tags:
  - Nix
  - NixOS
  - Firn
  - builtins
  - 字符串上下文
  - IFD
series: "用 Firn 从零学 Nix"
seriesOrder: 4
draft: false
comment: true
slug: nix-by-firn-04-builtins
---

[上一篇](/posts/nix-by-firn-03-functions-and-laziness/)结尾我留了一个问题：我一直在写 `import ./lib`，它每次都会重新读文件、解析、求值吗？`lab/ch04/import_tour.nix` 把同一个文件 import 了三次（两个 `let` 绑定，外加一个内联的），这个文件每次被求值都会在 stderr 打印一行：

```nix
# 被 import 时会在 stderr 打印一行；缓存生效时只打印一次。
builtins.trace "traced.nix evaluated" (x: x * 2)
```

```text
$ nix eval --file lab/ch04/import_tour.nix
trace: traced.nix evaluated
{ fromDir = { name = "dir/default.nix"; }; fromFile = 42; sameAsExplicit = true; tracedAgain = 6; tracedTwice = 6; }
```

三次 import，一行 trace。这一篇剩下的部分都是这类问题：`builtins` 里那 118 个名字，哪些碰文件、哪些碰网络、哪些碰 store，碰了之后求值器会变成什么样；以及每个字符串背后那份看不见的账本，它决定了 `"${pkgs.hello}"` 为什么不只是一段文字。

> [!NOTE] 本篇检查点
> 这一篇结束时，`~/firn` 里会有这些文件：`lib/strings.nix`、`lib/importers.nix`、`lib/sources.nix`、`lib/readme.nix`（最终版本），`lib/default.nix`（现在导出 31 个名字，以后还会变多），`data/chapters.toml`（20 章的编号、slug、标题和主题），`tests/lib.nix`（现在 47 个用例，第 5 篇会重写），`lab/ch04/` 下 26 个实验和 4 个 fixtures（最终版本），还有 README 里由程序生成的章节表。`make ch04` 全部通过。
> 涉及的 Nix 特性：`builtins` 目录、`import`、`scopedImport`、`readFile`/`readDir`/`pathExists`、`fromJSON`/`toJSON`/`fromTOML`、`match`/`split`、字符串上下文、`builtins.path`/`filterSource`、求值期 fetcher、纯求值的限制、import from derivation、`genericClosure`。
> 前置：[第 3 篇：函数与惰性求值](/posts/nix-by-firn-03-functions-and-laziness/)。

## builtins 目录：118 个名字，12 组

[第 2 篇](/posts/nix-by-firn-02-values-and-types/)数过：这台机器上 `nix eval --expr` 是纯模式，`builtins` 有 116 个名字；`--file` 和 `--impure` 下是 118 个，多出来的是 `currentSystem` 和 `currentTime`。

```text
$ nix eval --expr 'builtins.length (builtins.attrNames builtins)'
116
$ nix eval --file lab/ch04/builtins_groups.nix total
118
```

[手册](https://nix.dev/manual/nix/2.34/language/builtins)按字母顺序把它们列成一页，查名字很方便，但读不出结构。我想要一张地图，所以我手工把 118 个名字分成了 12 组，写成 `lab/ch04/builtins_groups.nix`。这个文件有一个我喜欢的性质：它自己就是测试。

```nix
let
  groups = {
    types = [
      "isAttrs"
      "isBool"
      # ...
      "typeOf"
    ];
    # ...
  };
  all = builtins.attrNames builtins;
  grouped = builtins.concatLists (builtins.attrValues groups);
  missing = builtins.filter (n: !(builtins.hasAttr n builtins)) grouped;
  uncategorized = builtins.filter (n: !(builtins.elem n grouped)) all;
  duplicates = builtins.filter (n: builtins.length (builtins.filter (m: m == n) grouped) > 1) grouped;
  report = {
    total = builtins.length all;
    groupedTotal = builtins.length grouped;
    perGroup = builtins.mapAttrs (_: builtins.length) groups;
  };
in
assert missing == [ ] || throw "names not in builtins: ${toString missing}";
assert uncategorized == [ ] || throw "uncategorized builtins: ${toString uncategorized}";
assert duplicates == [ ] || throw "names in two groups: ${toString duplicates}";
report
```

三个 `assert` 分别查拼错的名字、漏分类的名字和分在两组的名字。我拷了一份删掉 `"typeOf"`，再拷了一份把它拼成 `"typeof"`，验证它真的会叫：

```text
$ sed '/"typeOf"/d' lab/ch04/builtins_groups.nix > /tmp/bg1.nix
$ nix eval --file /tmp/bg1.nix
error: uncategorized builtins: typeOf
$ sed 's/"typeOf"/"typeof"/' lab/ch04/builtins_groups.nix > /tmp/bg2.nix
$ nix eval --file /tmp/bg2.nix
error: names not in builtins: typeof
```

所以以后 Nix 升级、`builtins` 多出一个名字，这个实验会在 `make ch04` 里第一个失败，并且告诉你多了谁。下面是它的真实输出，加上每一组里我认为最值得先认识的几个名字：

```text
$ cat out/ch04/builtins_groups.stdout
{ groupedTotal = 118; perGroup = { arithmetic = 10; attrsets = 11; control = 11; derivations = 9; environment = 11; fetchers = 8; files = 14; hashing = 3; lists = 17; serialization = 4; strings = 10; types = 10; }; total = 118; }
```

| 组 | 个数 | 代表 | 在哪一篇出场 |
| --- | --- | --- | --- |
| `types` | 10 | `typeOf`、`isAttrs`、`isFunction` | 第 2 篇 |
| `arithmetic` | 10 | `add`、`div`、`ceil`、`bitXor` | 第 1、2 篇，第 6 篇用 `bitXor` 折叠哈希 |
| `strings` | 10 | `substring`、`replaceStrings`、`split`、`match`、`compareVersions` | 本篇 |
| `lists` | 17 | `map`、`filter`、`foldl'`、`genericClosure`、`sort` | 本篇和第 5 篇 |
| `attrsets` | 11 | `mapAttrs`、`listToAttrs`、`intersectAttrs`、`functionArgs` | 第 2、3 篇，第 7 篇 |
| `control` | 11 | `throw`、`trace`、`tryEval`、`seq`、`break` | 第 3、5 篇 |
| `files` | 14 | `import`、`readFile`、`readDir`、`path`、`toFile` | 本篇 |
| `serialization` | 4 | `fromJSON`、`toJSON`、`fromTOML`、`toXML` | 本篇 |
| `hashing` | 3 | `hashString`、`hashFile`、`convertHash` | 第 6 篇 |
| `fetchers` | 8 | `fetchurl`、`fetchTarball`、`fetchGit`、`fetchTree` | 本篇和第 8 篇 |
| `derivations` | 9 | `derivation`、`placeholder`、`getContext`、`unsafeDiscardStringContext` | 本篇和第 6 篇 |
| `environment` | 11 | `nixVersion`、`storeDir`、`getEnv`、`currentSystem`、`true`、`null` | 第 2 篇，本篇的纯求值一节 |

读这张表，我有两个意外。第一，分成 12 组之后，真正会碰到“世界”的名字并不多：`files` 里的 `import` 和 `readFile` 一族，`fetchers`，`environment` 里的 `getEnv` 和 `currentTime`，以及 `derivations` 里的 `derivation`。其余的几乎全是纯函数，输入决定输出，和你在任何函数式语言里见到的一样。这一篇要讲的“特别的东西”，几乎都挤在前面这几个名字里。第二，`true`、`false`、`null` 居然也在 `builtins` 里。它们当然是，在 Nix 里这三个也只是全局作用域里的名字，不是关键字（`nix eval --expr 'let true = 1; in true'` 打印 `1`）。

不是每个名字都要写 `builtins.` 前缀。我写了个小循环，对 118 个名字逐个试它能不能不加前缀直接用：

```bash
for n in $(nix eval --impure --json --expr 'builtins.attrNames builtins' | jq -r '.[]'); do
  if nix eval --impure --expr "builtins.typeOf (${n})" >/dev/null 2>&1; then
    echo "${n}"
  fi
done
```

```text
abort baseNameOf break builtins derivation derivationStrict dirOf false fetchGit fetchMercurial fetchTarball fetchTree fromTOML import isNull map null placeholder removeAttrs scopedImport throw toString true
```

23 个。所以 `map f xs` 和 `builtins.map f xs` 是同一个函数，而 `filter` 就必须写成 `builtins.filter`（nixpkgs 的 `lib` 开头就是一大串 [`inherit (builtins) head tail length isList elemAt concatLists filter elem genList map`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/lists.nix#L18-L28)，原因在此）。为什么是这 23 个，不是别的？答案在 C++ 里：每个 primop 注册时带一个名字，求值器先用这个名字把它放进全局作用域，再去掉开头的 `__`，放进 `builtins`（[`eval.cc` 的 538 到 540 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/eval.cc#L538-L540)）。`import` 注册为 [`.name = "import"`](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/primops.cc#L364)，所以两边同名；`genericClosure` 注册为 [`.name = "__genericClosure"`](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/primops.cc#L903)，所以全局里它叫 `__genericClosure`，`builtins` 里叫 `genericClosure`：

```text
$ nix eval --expr '__genericClosure'
«primop genericClosure»
$ nix eval --expr '__add 1 2'
3
$ nix eval --expr 'builtins.genericClosure'
«primop genericClosure»
```

这些带下划线的全局名是历史遗留，我没有在任何现代代码里见过有人用它们，也不推荐；知道它们存在，是为了在错误信息里看到 `__` 时不被吓到。

还有一点：不是每个 builtin 都是 C++ 函数。

```text
$ nix eval --expr 'builtins.derivation'
«lambda @ «nix-internal»/derivation-internal.nix:30:1»
$ nix eval --expr 'builtins.derivationStrict'
«primop derivationStrict»
$ nix eval --expr 'builtins.map'
«primop map»
```

`derivation` 是一个包在 `derivationStrict` 外面的 Nix lambda，源码嵌在 Nix 二进制里。第 6 篇我们会解剖它。

## import：读、解析、求值，而且只做一次

手册对 `import` 的描述里有一句 “Unlike some languages, `import` is a regular function in Nix”，意思是它就是一个普通函数。我觉得这句话的分量需要一个例子才能感受到：它能被 `map` 过，能放进列表，能作为参数传来传去，因为它的参数是一个值，不是语法。

```text
$ nix eval --impure --expr 'map import [ ./lab/ch04/fixtures/gen.nix ./lab/ch04/fixtures/dir ]'
[ { x = 42; } { name = "dir/default.nix"; } ]
```

`lab/ch04/import_tour.nix` 的结果里有五个字段。文件的值是个函数，`import` 之后就是那个函数；参数是目录，取其中的 `default.nix`：

```nix
let
  adder = import ./fixtures/adder.nix;
  # ...
in
{
  # 文件的值是函数，import 之后就是那个函数。
  fromFile = adder 41;
  # 目录：import ./fixtures/dir 等于 import ./fixtures/dir/default.nix。
  fromDir = import ./fixtures/dir;
  sameAsExplicit = import ./fixtures/dir == import ./fixtures/dir/default.nix;
  # ...
}
```

这个文件开头的输出你已经见过：`fromFile = 42`，`fromDir = { name = "dir/default.nix"; }`，`sameAsExplicit = true`。出错的时候，错误信息把规则说得很明白：

```text
$ nix eval --impure --expr 'import ./lab/ch04/fixtures'
error: path '/home/bfmhno3/Projects/firn/lab/ch04/fixtures/default.nix' does not exist
$ nix eval --impure --expr 'import "lab/ch04/fixtures/gen.nix"'
error: string 'lab/ch04/fixtures/gen.nix' doesn't represent an absolute path
$ nix eval --impure --expr 'import "/home/bfmhno3/Projects/firn/lab/ch04/fixtures/gen.nix"'
{ x = 42; }
```

`import` 吃路径，也吃字符串，但字符串必须是绝对路径。（[第 2 篇](/posts/nix-by-firn-02-values-and-types/)讲过路径字面量是相对于写它的那个文件的，字符串没有这个机制，因为字符串不知道自己是在哪个文件里写出来的。）

还有一种我原来没想到的：把一个 `.drv` 路径交给 `import`，它不会去解析那个文件，而是读出 derivation，包成一个值：

```text
$ nix eval --impure --expr 'builtins.attrNames (import (import ./nix/pkgs.nix { }).hello.drvPath)'
[ "all" "drvPath" "name" "out" "outPath" "outputName" "type" ]
```

[`import` 的实现](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/primops.cc#L292-L312)三个分支：`.drv` 就 `derivationToValue`，有 `scopedImport` 的 scope 就走 `scopedImport`，其他情况是 `state.evalFile(path, v)`。真正的缓存在最后这个 `evalFile` 里：

```cpp
    if (auto v2 = getConcurrent(*fileEvalCache, *resolvedPath)) {
        forceValue(**v2, noPos);
        v = **v2;
        return;
    }
```

这段是 [`src/libexpr/eval.cc` 的 1126 到 1130 行](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/eval.cc#L1126-L1130)。`fileEvalCache` 的键是解析之后的文件路径，值是一个 thunk。所以“import 一次”的意思是：每个文件对应一个 thunk，第一次有人要它的值，它被解析和求值；以后所有 `import` 同一个路径的人拿到的是同一个 thunk（[第 3 篇](/posts/nix-by-firn-03-functions-and-laziness/)的共享）。源码里的注释自己也这么说：[“ensuring that every file is parsed/evaluated only once”](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/eval.cc#L1077)。

这解释了一个容易被误读的现象。`import_tour.nix` 里有 `tracedTwice = again 1 + traced 2;`，结果是 6，trace 只有一行。文件的顶层表达式 `builtins.trace "..." (x: x * 2)` 被求值了一次，得到一个 lambda；之后每次调用这个 lambda 都是真的在算，缓存的是 lambda，不是它的调用结果（那就是[第 3 篇](/posts/nix-by-firn-03-functions-and-laziness/)的“函数调用不记忆”）。

反过来，`scopedImport` 不走这条缓存，因为同一个文件配不同的 scope 是不同的程序。[`lab/ch04/scoped_import.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/scoped_import.nix) 验证了这一点：

```nix
# import 缓存文件的求值结果；scopedImport 不缓存。
let
  traced = builtins.getEnv "FIRN_ROOT" + "/lab/ch04/fixtures/traced.nix";
  a = builtins.scopedImport { } (/. + traced);
  b = builtins.scopedImport { } (/. + traced);
in
a 1 + b 2
```

```text
$ FIRN_ROOT=$PWD nix eval --file lab/ch04/scoped_import.nix
trace: traced.nix evaluated
trace: traced.nix evaluated
6
```

两个 `scopedImport`，两行 trace。（`make ch04` 里它的结果在 `out/ch04/scoped_import.stdout` 和 `out/ch04/scoped_import.stderr`。）nixpkgs 里几乎没有人用 `scopedImport`，我在这个系列里也不会再用它；知道它为什么存在就够了：它是 Nix 里仅有的“带着环境加载另一个文件”的办法。

最后一个性质和路径有关：`import` 的参数如果是一个还没有构建好的 store 路径，求值器会先去构建它。这就是“导入派生物” (IFD)，我们放到后面单独一节。

## 读文件系统：readFile、readDir、pathExists

`import` 之外，`files` 组里最常用的三个是 `readFile`、`readDir` 和 `pathExists`。`lab/ch04/read_dir.nix` 把它们都用了一遍，目标是上一章的 `lab/ch02/`：

```nix
let
  entries = builtins.readDir ../ch02;
in
{
  inherit entries;
  names = builtins.attrNames entries;
  directories = builtins.attrNames (
    builtins.removeAttrs entries (
      builtins.filter (n: entries.${n} != "directory") (builtins.attrNames entries)
    )
  );
  exists = {
    present = builtins.pathExists ../ch02/types.nix;
    absent = builtins.pathExists ../ch02/nope.nix;
  };
  fileType = builtins.readFileType ../ch02/fixtures;
}
```

```text
$ nix eval --json --file lab/ch04/read_dir.nix | jq -c '{names, directories, exists, fileType}'
{"names":["attrsets.nix","equality.nix","ex_deep_get.nix","fixtures","int_overflow_fail.nix","interpolate_int_fail.nix","json_lambda_fail.nix","json_roundtrip.nix","lists.nix","merge_shallow.nix","numbers.nix","path_copy.sh","paths.nix","string_plus_int_fail.nix","strings.nix","types.nix","with_scope.nix"],"directories":["fixtures"],"exists":{"absent":false,"present":true},"fileType":"directory"}
```

`readDir` 返回一个属性集，键是目录项的名字，值是类型字符串（`"regular"`、`"directory"`、`"symlink"`，文件系统说不清的时候是 `"unknown"`）。因为是属性集，所以键天然是排好序的，输出顺序稳定，实验可以放心地做字符串比较。这 17 个条目就是第 2 篇说的“16 个实验加一个 `fixtures/`”。那串 `removeAttrs` 是在“只留下目录”：Nix 里没有 `filterAttrs`（`lib` 里才有，第 5 篇我们自己写），所以先找出不是目录的名字，再把它们从属性集里去掉。

`readFile` 把整个文件读成一个字符串，**换行符原样保留**：

```text
$ nix eval --impure --expr 'builtins.readFile ./lab/ch04/fixtures/gen.nix'
"# IFD 实验里被“生成”的内容的静态版本。\n{ x = 42; }\n"
```

最后那个 `\n` 在你要按行切的时候会变成一个多余的空元素。Firn 的 `lib/importers.nix` 里的 `readLines` 就是为这个写的：

```nix
  # 按行切开；文件末尾的换行不产生多余的空行。
  readLines =
    path:
    let
      lines = strings.splitString "\n" (builtins.readFile path);
      count = builtins.length lines;
    in
    if count > 0 && builtins.elemAt lines (count - 1) == "" then
      builtins.genList (builtins.elemAt lines) (count - 1)
    else
      lines;
```

`tests/lib.nix` 里有两个用例：`"a\nb\n"` 是 `[ "a" "b" ]`，`"a\n\nb"` 是 `[ "a" "" "b" ]`（中间的空行保留，只去掉末尾那一个）。用真实文件验证一下，README 是 71 行：

```text
$ nix eval --impure --expr 'builtins.length ((import ./lib).readLines ./README.md)'
71
$ wc -l README.md
71 README.md
```

`readFile` 还有一条限制：Nix 字符串里不能有 NUL 字节。

```text
$ printf 'a\0b' > /tmp/nul.bin
$ nix eval --impure --expr 'builtins.readFile /tmp/nul.bin'
error: the contents of the file '/tmp/nul.bin' cannot be represented as a Nix string
```

所以 `readFile` 读不了二进制文件。读二进制要把它当成 store 路径传给别的东西，让 `cat` 或者 `base64` 在构建里处理，而不是在求值器里。

`pathExists` 返回布尔值。`readFileType` 是 `readDir` 的单个文件版。这三个函数的参数如果是 store 路径，而那个路径还没有构建好，它们就会触发构建；这个行为在 IFD 一节讲。如果参数在纯模式下不被允许访问，它们的反应也各不相同，纯求值一节会列出来。

## JSON 和 TOML：数据进出 Nix

Nix 本身没有配置文件格式，所以每个项目都把数据放进 JSON 或 TOML，再让 `builtins` 读进来。`lib/importers.nix` 的前两个函数一行一个：

```nix
  importJSON = path: builtins.fromJSON (builtins.readFile path);

  importTOML = path: builtins.fromTOML (builtins.readFile path);
```

Firn 从这一章开始有一个真正的数据文件，`data/chapters.toml`，121 行，20 个 `[[chapters]]` 表，每个表长这样：

```toml
[[chapters]]
n = 1
stem = "nix-by-firn-01-first-eval"
title = "第一次求值：nix repl、三副面孔与一段历史"
topics = [ "入门", "函数式", "历史" ]
```

`[[chapters]]` 是 TOML 的“表数组”，`fromTOML` 把它变成 `chapters` 这个键下的一个列表，每项一个属性集，**顺序和文件里一致**。`lab/ch04/json_toml.nix` 验证了这一点，也顺手测了往返：

```text
$ nix eval --file lab/ch04/json_toml.nix --json | jq -c 'del(.firstChapter,.lastChapter)'
{"chapterCount":20,"toJson":"{\"a\":[\"x\",null,2.5],\"b\":1}","fromJson":{"a":[1,2.5,null,true],"b":{"c":"x"}},"inlineToml":{"name":"firn","owner":{"login":"bfmhno3"}},"intFloat":["int","float"],"sameAsLib":true}
$ nix eval --file lab/ch04/json_toml.nix --json | jq -c '.firstChapter'
{"n":1,"stem":"nix-by-firn-01-first-eval","title":"第一次求值：nix repl、三副面孔与一段历史","topics":["入门","函数式","历史"]}
```

JSON 一侧我专门去找它的边角。`toJSON` 总是按键排序（`{ b = 1; a = 2; }` 出来是 `{"a":2,"b":1}`），因为输入是个属性集，属性集没有顺序；`fromJSON` 遇到重复的键，后一个赢；整数和浮点各保各的类型（`fromJSON "[1, 1.0]"` 的 `typeOf` 是 `[ "int" "float" ]`）；超出 64 位有符号整数的数直接报错：

```text
$ nix eval --expr 'builtins.fromJSON "{\"a\": 1, \"a\": 2}"'
{ a = 2; }
$ nix eval --expr 'builtins.fromJSON "[1, 1.0, 10000000000000000000]"'
error: unsigned json number 10000000000000000000 outside of Nix integer range
$ nix eval --expr 'builtins.toJSON (x: x)'
error: cannot convert a function to JSON
$ nix eval --expr 'builtins.toJSON { outPath = "/p"; other = 1; }'
"\"/p\""
```

最后一行很怪：带 `outPath` 的属性集被 `toJSON` 当成了字符串 `"/p"`，`other` 被扔掉了。这是[第 2 篇](/posts/nix-by-firn-02-values-and-types/)讲的“带 `outPath` 的属性集可以被当成字符串”的另一个出口（`__toString` 也一样：`toJSON { __toString = _: "s"; }` 是 `"\"s\""`）。以后把整个 derivation 丢给 `toJSON` 时，你会得到一条 store 路径，而不是一棵属性树。

TOML 一侧有一个更实际的限制：`fromTOML` 不认 TOML 的日期时间类型。`lab/ch04/toml_datetime_fail.nix` 的表达式只有一行：

```nix
builtins.fromTOML "released = 1979-05-27T07:32:00Z"
```

```text
$ nix eval --file lab/ch04/toml_datetime_fail.nix 2>&1 | tail -1
       error: while parsing TOML: Dates and times are not supported
```

它在解析时就失败了，文件里别的键再合法也没用。我猜原因是 Nix 没有对应的值类型（日期要么是字符串，要么是时间戳整数，两种都会让往返丢信息），不过这只是我的推测，手册没有解释。实际做法是：把日期写成字符串。这个错误也不是 `tryEval` 能拦的：

```text
$ nix eval --impure --expr 'builtins.tryEval (builtins.fromTOML "r = 1979-05-27T07:32:00Z")'
error: while parsing TOML: Dates and times are not supported
```

[第 3 篇](/posts/nix-by-firn-03-functions-and-laziness/)量过，`tryEval` 只拦 `throw` 和 `assert`，这里的 `error:` 是另一类。

TOML 的其它部分基本都能用，包括十六进制整数和 `inf`/`nan`：

```text
$ nix eval --expr 'builtins.fromTOML "a = 0x10\nb = 1_000\nc = inf\nd = nan"'
{ a = 16; b = 1000; c = inf; d = nan; }
$ nix eval --expr 'builtins.fromTOML "a = 1\na = 2"'
error: while parsing TOML: [error] toml::insert_value: failed to insert a value, value already exists
```

最后一行的 `toml::insert_value` 说明解析是一个 C++ 的 TOML 库做的，错误信息是它的，不是 Nix 的。

## 正则：POSIX ERE，而且要匹配整个字符串

Nix 只有两个正则函数，`builtins.match` 和 `builtins.split`，手册说它们用的是 POSIX 扩展正则 (ERE)，源码里它们背后是 C++ 标准库的 [`std::regex`，语法选项是 `std::regex::extended`](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/primops.cc#L4724)。如果你的手指习惯了 Perl 或 Python 的写法，前五分钟会很痛。`lab/ch04/regex.nix` 是我踩的坑的集合：

```text
$ nix eval --file lab/ch04/regex.nix --json | jq -c .
{"contains":true,"full":["04"],"noGroups":[],"noMatch":null,"optionalGroup":[null],"partial":null,"posixClass":[],"split":["a",[],"b",[],"c"],"splitNoMatch":["abc"],"splitWithGroup":["a",["1"],"b",["2"],"c"],"twoGroups":["nix","2"]}
```

对着源文件逐个读：

- `full = builtins.match "ch([0-9]+)" "ch04"` 是 `[ "04" ]`：成功时返回**捕获组**组成的列表。
- `noGroups = builtins.match "ch[0-9]+" "ch04"` 是 `[ ]`：成功了，但没有捕获组，所以是空列表。这和“没匹配上” (`null`) 不是一回事，两者都不能直接放进 `if`（`if builtins.match "a" "a" then 1 else 2` 报 `expected a Boolean but found a list: [ ]`，不匹配时报 `found null`）；要写 `!= null`。
- `partial = builtins.match "[0-9]+" "ch04"` 是 `null`。`match` 是**整串匹配**，等于两边隐含了锚点。要做“包含”判断，两端加 `.*`：`contains = builtins.match ".*ix.*" "nix" != null`。
- `optionalGroup = builtins.match "a(b)?c" "ac"` 是 `[ null ]`：没有参与匹配的捕获组是 `null`，不是空字符串。
- `split` 返回一个**交替的列表**：字符串、捕获组列表、字符串、捕获组列表……最后一项是字符串。没有捕获组时，中间夹的是 `[ ]`：`split = builtins.split "[,;]" "a,b;c"` 是 `[ "a" [ ] "b" [ ] "c" ]`。

交替这件事很容易被忽略，直到你看到 `split` 在不同输入下的形状：

```text
$ nix eval --expr 'builtins.split "(a)|b" "xaby"'
[ "x" [ "a" ] "" [ null ] "y" ]
$ nix eval --expr 'builtins.match "(a)|(b)" "b"'
[ null "b" ]
$ nix eval --expr 'builtins.match "a|b" "b"'
[ ]
```

第一行里，`a` 匹配时，捕获组 `(a)` 是 `"a"`；`b` 匹配时，捕获组没有参与，是 `null`。中间的 `""` 是两个匹配之间的空字符串。这个“字符串、列表、字符串”的节奏，是 `lib.splitString` 要用 `filter isString` 的原因，下面马上会看到。

再往下是 ERE 不支持的东西：

```text
$ nix eval --file lab/ch04/regex_perl_fail.nix
error: invalid regular expression '\d+'
$ nix eval --expr 'builtins.match "(?:a)" "a"'
error: invalid regular expression '(?:a)'
$ nix eval --expr 'builtins.match "[[:digit:]]+" "42"'
[ ]
$ nix eval --expr 'builtins.match "a{2,3}" "aaa"'
[ ]
```

`\d` 不是合法写法，非捕获组 `(?:...)` 也不是；数字类要写成 POSIX 的 `[[:digit:]]`，次数 `{2,3}` 是合法的。还有一个我没料到的：`.` 匹配换行。

```text
$ nix eval --expr 'builtins.match "a.b" "a\nb"'
[ ]
```

（`[ ]` 是成功，没有捕获组。）最后是极限：整串匹配对长字符串会爆栈。我拿一串 `a` 试，`.*` 匹配 90000 个没问题，100000 个就不行：

```text
$ nix eval --expr 'builtins.length (builtins.match ".*" (builtins.concatStringsSep "" (builtins.genList (_: "a") 90000)))'
0
$ nix eval --expr 'builtins.length (builtins.match ".*" (builtins.concatStringsSep "" (builtins.genList (_: "a") 100000)))'
error: stack overflow (possible infinite recursion)
```

“可能是无限递归”这句话在这里是误导，真相只是字符串太长。想用 `match` 去切一个 `readFile` 读进来的大文件，请先按行切，再对每一行用正则。（阈值在 90000 和 100000 之间，我没有再二分；它多半取决于栈大小，我没有验证。）

最后，版本号别用正则。`compareVersions` 按分量比较，而不是按字符串：

```text
$ nix eval --expr 'builtins.compareVersions "2.34.9" "2.4"'
1
```

`2.34.9` 比 `2.4` 大，因为 34 大于 4，和字典序相反。

### Firn 的 strings：splitString 为什么要转义

`lib/strings.nix` 的 `splitString` 是这一章第一个需要同时用 `split`、`filter` 和正则转义的函数：

```nix
  # splitString "," "a,b,,c" == [ "a" "b" "" "c" ]；分隔符不能为空。
  splitString =
    sep: s:
    if sep == "" then
      throw "firn: splitString: separator must not be empty"
    else
      builtins.filter builtins.isString (builtins.split (escapeRegex sep) s);
```

三个设计决定。`split` 的第一个参数是**正则**，所以 `.` 这类分隔符必须转义，否则 `.` 会匹配任意字符：

```text
$ nix eval --expr 'builtins.split "." "a.b.c"'
[ "" [ ] "" [ ] "" [ ] "" [ ] "" [ ] "" ]
```

五个字符，每一个都被当成了分隔符，剩下六个空字符串。`escapeRegex` 是文件里的另一个值，它用 `builtins.replaceStrings` 把 14 个元字符各自前面加一个反斜杠：

```nix
  escapeRegex =
    builtins.replaceStrings
      [
        "\\"
        "."
        # ...
        "$"
      ]
      [
        "\\\\"
        "\\."
        # ...
        "\\$"
      ];
```

这里 `replaceStrings` 的“同时替换”性质帮了大忙：如果它是顺序替换，先把 `\` 换成 `\\`，再把 `.` 换成 `\.`，第二步会把第一步新加的反斜杠再处理一遍。[第 2 篇](/posts/nix-by-firn-02-values-and-types/)讲过，`replaceStrings` 在原字符串上同时找所有模式，不会二次替换：

```text
$ nix eval --expr 'builtins.replaceStrings [ "a" "b" ] [ "b" "a" ] "aabb"'
"bbaa"
```

第二个决定是 `filter builtins.isString`，把 `split` 交替列表里夹的捕获组列表扔掉。第三个决定是空分隔符直接 `throw`：`builtins.split "" "abc"` 是 `[ "" [ ] "a" [ ] "b" [ ] "c" [ ] "" ]`，在每个字符之间都“匹配”了一次，几乎没有人想要这个结果。`tests/lib.nix` 里有三个用例锁住它：基本用法、`.` 这类元字符、没有匹配时返回原字符串。

`hasPrefix` 和 `hasSuffix` 反而没有用正则，它们用 `substring` 和 `stringLength`：

```nix
  hasPrefix = prefix: s: builtins.substring 0 (builtins.stringLength prefix) s == prefix;
```

这是我故意的。正则要先转义前缀，才能避免 `.` 的问题，而 `substring` 直接按字节比较，不会错，也不会爆栈。一个简单的比较，不该为它请出一台自动机。

## 字符串上下文：每个字符串背后的账本

到现在为止我一直在说“字符串是字节”。这是第 2 篇留下的那个谎，现在要补上：**Nix 里的字符串是一个字节序列加一个集合**，集合里记着“这段文字依赖哪些 store 对象”。[手册](https://nix.dev/manual/nix/2.34/language/string-context)说得很直白：Nix 里的字符串不只是像别的语言那样的一串字符，而是一对，一串字符加一个*字符串上下文*。这个集合就是字符串上下文。

我想用一个例子建立直觉。字符串像一份货物清单，上下文是钉在清单上的提货单：清单上写着“集装箱 X”，提货单告诉码头“这批货在 Y 号船上，卸货前我不能把它交给别人”。把清单抄一份（拷贝文字）而不拷提货单，抄出来的清单上的集装箱就成了没有来历的名字。接下来的几节，就是在看提货单什么时候被一起带走，什么时候被悄悄丢掉。（这个比喻只用这一次。）

### 它记什么

`lab/ch04/string_context.nix` 先看最简单的情形：

```nix
let
  pkgs = import ../../nix/pkgs.nix { };
  s = "${pkgs.hello}";
  plain = "just text";
  discarded = builtins.unsafeDiscardStringContext s;
in
{
  helloPath = s;
  hasContext = builtins.hasContext s;
  # ...
  context = builtins.getContext s;
  # 拼接会合并上下文。
  concatenated = builtins.attrNames (builtins.getContext "${s} and ${pkgs.jq}");
  discardedHasContext = builtins.hasContext discarded;
  # 字符串比较不看上下文，所以丢掉之后仍然相等。
  samePath = discarded == s;
}
```

```text
$ cat out/ch04/string_context.stdout
{ concatenated = [ "/nix/store/ah6860fcg10q4krlwgqg957pln19xin6-jq-1.8.2.drv" "/nix/store/gx2drhxsvkh7xr490rg7dpqyn53iw3z0-hello-2.12.3.drv" ]; context = { "/nix/store/gx2drhxsvkh7xr490rg7dpqyn53iw3z0-hello-2.12.3.drv" = { outputs = [ "out" ]; }; }; discardedHasContext = false; hasContext = true; helloPath = "/nix/store/lcxc2z1h2g8wq8dxfpizy1di85kyxnqx-hello-2.12.3"; plainHasContext = false; samePath = true; }
```

这里有三件事要读。`helloPath` 是 `/nix/store/lcxc...-hello-2.12.3`，一个再普通不过的路径字符串；`context` 却不是这个路径，而是 `/nix/store/gx2d...-hello-2.12.3.drv`，带着 `outputs = [ "out" ]`：“我依赖的是这个 derivation 的 `out` 输出”。为什么记 `.drv` 而不是输出路径？因为在你写下 `"${pkgs.hello}"` 的时候，输出路径可能还不存在（没构建、没下载），但 `.drv` 已经存在了，它能算出来；上下文要表达的是“要用这个字符串，得先让这个输出存在”，不是“这个路径现在存在”。

拼接会**合并**上下文：`"${s} and ${pkgs.jq}"` 的上下文里有 hello 和 jq 两个 drv。比较不看上下文：`discarded == s` 是 `true`，两个字符串在字节上完全一样，只是账本被撕掉了。

上下文的元素有三种。[`lab/ch04/context_kinds.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/context_kinds.nix) 把它们都构造出来（直接运行要设 `FIRN_ROOT`）：

```nix
let
  pkgs = import (builtins.getEnv "FIRN_ROOT" + "/nix/pkgs.nix") { };
  hello = "${pkgs.hello}";
  keeps = s: builtins.hasContext s;
in
{
  kinds = {
    output = builtins.getContext "${pkgs.hello}";
    allOutputs = builtins.getContext pkgs.hello.drvPath;
    path = builtins.getContext "${./context_kinds.nix}";
    otherOutput = builtins.getContext "${pkgs.zlib.dev}";
  };
  # ...
}
```

```text
$ FIRN_ROOT=$PWD nix eval --json --file lab/ch04/context_kinds.nix | jq -c '.kinds | to_entries[] | {(.key): .value}'
{"allOutputs":{"/nix/store/gx2drhxsvkh7xr490rg7dpqyn53iw3z0-hello-2.12.3.drv":{"allOutputs":true}}}
{"otherOutput":{"/nix/store/9ajxamlix3fhv713l3h1jp67p7cz555b-zlib-1.3.2.drv":{"outputs":["dev"]}}}
{"output":{"/nix/store/gx2drhxsvkh7xr490rg7dpqyn53iw3z0-hello-2.12.3.drv":{"outputs":["out"]}}}
{"path":{"/nix/store/2pb249v2ymzgdwvyr3lh12h5ibm8x7ab-context_kinds.nix":{"path":true}}}
```

- `outputs = [ "out" ]`：某个 derivation 的某几个输出（`zlib.dev` 是 `[ "dev" ]`）。这是最常见的一种。
- `path = true`：一个**普通的 store 路径**。`"${./context_kinds.nix}"` 把本地文件拷进 store（第 2 篇）时产生的就是它：这个路径现在就存在，没有 `.drv`。
- `allOutputs = true`：一个 derivation 的**全部输出，连同它的整个构建依赖**（手册里叫 “derivation deep”）。`pkgs.hello.drvPath` 那个字符串带的就是它。手册说它是给 [`exportReferencesGraph`](https://nix.dev/manual/nix/2.34/language/advanced-attributes#adv-attr-exportReferencesGraph) 用的，这个系列里我们不会用到。

### 谁保留，谁丢掉

接下来是我最想知道的：哪些字符串操作会把上下文带过去？同一个实验的后半部分把一堆常用的 builtins 逐个试了一遍：

```text
$ FIRN_ROOT=$PWD nix eval --json --file lab/ch04/context_kinds.nix | jq -c '{keeps, drops}'
{"keeps":{"baseNameOf":true,"concatStringsSep":true,"replaceStrings":true,"substring":true,"toJSON":true},"drops":{"hashString":false,"match":false,"readFile":false,"split":false}}
```

保留的有 `substring`、`replaceStrings`、`concatStringsSep`、`toJSON`、`baseNameOf`：它们的输出是输入的一部分或变形，依赖没有变。丢掉的有 `match`、`split`（捕获出来的子串没有上下文），`hashString`（哈希是另一个值了），`readFile`（读出来的是**文件内容**，而内容不会带着“我来自哪个 derivation”这件事）。

`split` 丢上下文，意味着 Firn 的 `splitString` 也丢。nixpkgs 的版本是[这样写的](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/strings.nix#L1742-L1747)：

```nix
  splitString =
    sep:
    let
      escapedSep = escapeRegex (toString sep);
    in
    s: map (addContextFrom s) (filter isString (split escapedSep (toString s)));
```

多出来的 `map (addContextFrom s)`，是把原字符串的上下文补回每一段。`addContextFrom` 的[定义](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/strings.nix#L1709)只有一行，而且很有意思：

```nix
  addContextFrom = src: target: substring 0 0 src + target;
```

`substring 0 0 src` 是一个**空字符串，但保留了 `src` 的上下文**，再把它拼到目标前面。用空字符串搬运上下文，我是看到这行才反应过来这件事能这么做。我把两个版本放在一起对比（[`lab/ch04/split_context.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/split_context.nix)）：

```nix
let
  firn = import (builtins.getEnv "FIRN_ROOT" + "/lib");
  pkgs = import (builtins.getEnv "FIRN_ROOT" + "/nix/pkgs.nix") { };
  s = "${pkgs.hello}/bin/hello";
  first = parts: builtins.head parts;
in
{
  firn = builtins.hasContext (first (firn.splitString "/bin" s));
  nixpkgs = builtins.hasContext (first (pkgs.lib.splitString "/bin" s));
  trick = builtins.hasContext (builtins.substring 0 0 s + "plain");
}
```

```text
$ FIRN_ROOT=$PWD nix eval --file lab/ch04/split_context.nix
{ firn = false; nixpkgs = true; trick = true; }
```

Firn 这一版确实丢了。它目前的调用者只有 `readLines`（读文件内容，本来就没有上下文），所以没有出过事；等有一天往里传 store 路径字符串，就把 `addContextFrom` 那一行抄过来。

### 丢掉上下文会怎样

`lab/ch04/context_matters.sh` 用 `writeText` 写两个文本文件，内容都是 `uses ` 加 hello 的路径加 `/bin/hello`，唯一的区别是一个保留了字符串上下文，一个用 `unsafeDiscardStringContext` 丢掉了：

```bash
  # shellcheck disable=SC2016 # ${...} is Nix interpolation, not shell
  if [[ "${mode}" == keep ]]; then
    body='"uses ${pkgs.hello}/bin/hello"'
  else
    body='"uses ${builtins.unsafeDiscardStringContext (toString pkgs.hello)}/bin/hello"'
  fi
```

```text
$ cat out/ch04/context_matters.stdout
hello: /nix/store/lcxc2z1h2g8wq8dxfpizy1di85kyxnqx-hello-2.12.3
== with context: /nix/store/pq1sy5491ywg2pik2gq256gdbpacgfjy-ctx-kept
uses /nix/store/lcxc2z1h2g8wq8dxfpizy1di85kyxnqx-hello-2.12.3/bin/hello
references:
/nix/store/lcxc2z1h2g8wq8dxfpizy1di85kyxnqx-hello-2.12.3
== context discarded: /nix/store/vhlc84wsrz31106p9gimw1wwq4x39qnr-ctx-dropped
uses /nix/store/lcxc2z1h2g8wq8dxfpizy1di85kyxnqx-hello-2.12.3/bin/hello
references:
(empty above: the closure of this file no longer contains hello)
closure size with context: 6 paths
closure size without context: 1 paths
```

两个文件的**内容一模一样**，差别全在 store 里的元数据。保留上下文的那个，`nix-store -q --references` 列出了 hello，闭包是 6 个路径（它自己加上 hello 的运行时依赖）；丢掉的那个，没有引用，闭包只有它自己，1 个路径。这意味着垃圾回收可以在不碰第二个文件的情况下把 hello 删掉，剩下一个指着空气的文本文件。

不过这个实验用的是 hello，它当时已经在 store 里，所以你看不到“指着空气”。我想让它真的指着空气，就换了一个**从没构建过**的依赖：一个名字里带时间戳的 `runCommand`。（这是 [`lab/ch04/context_danger.sh`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/context_danger.sh)。）

```bash
  # shellcheck disable=SC2016 # ${...} is Nix interpolation, not shell
  if [[ "${mode}" == keep ]]; then
    ref='${dep}'
  else
    ref='${builtins.unsafeDiscardStringContext dep.outPath}'
  fi
  nix build --impure --no-link --print-out-paths --expr "
    let
      pkgs = import ${pkgs_nix} { };
      dep = pkgs.runCommand \"dep-${mode}-${stamp}\" { } \"echo built > \\\$out\";
    in pkgs.writeText \"user-${mode}-${stamp}\" \"depends on ${ref}\"
  " 2>/dev/null
```

```text
$ cat out/ch04/context_danger.stdout
== keep
text:       depends on /nix/store/s0xvqsx8z0jx3w8znc2s4rk0wxf61fd2-dep-keep-1793717990455068
dependency: exists (built)
input drvs of the text file:
  8675ls33jkfk599x2gmg5nc33gj4l641-stdenv-linux-no-cc.drv
  mkd21ikm0cr6m8g57hhls08bs4zha4a6-dep-keep-1793717990455068.drv
  yxs8g9wf1nmphw5xspgyykg37hwp8vgf-bash-5.3p15.drv
== discard
text:       depends on /nix/store/sjcyas338k195cj6kpjpq82bdx4b82cg-dep-discard-1793717990455068
dependency: MISSING
input drvs of the text file:
  8675ls33jkfk599x2gmg5nc33gj4l641-stdenv-linux-no-cc.drv
  yxs8g9wf1nmphw5xspgyykg37hwp8vgf-bash-5.3p15.drv
```

这就是字符串上下文在做的事。保留的版本里，文本文件那个 derivation 的 `inputDrvs`（最后一段列出来的）多了 `dep-keep-...drv`：它是靠上下文“长出来”的输入，Nix 因此先构建 `dep`，再构建文本文件。丢掉的版本里，输入里没有 `dep`，Nix 只构建了文本文件，于是文本里写着一条指向 `dep-discard-...` 的路径，而这个路径**从来没有存在过**。没有任何错误，构建成功，退出码 0。（`stdenv-linux-no-cc.drv` 和 `bash` 是 `writeText` 自己的输入，两边都有。）

字符串上下文被强制执行的地方不止 derivation 的输入。我又试了三处，Nix 都没有悄悄放过：

```text
$ nix eval --impure --expr 'let pkgs = import ./nix/pkgs.nix { }; in { "${pkgs.hello}" = 1; }'
error: the string '/nix/store/lcxc2z1h2g8wq8dxfpizy1di85kyxnqx-hello-2.12.3' is not allowed to refer to a store path (such as '/nix/store/gx2drhxsvkh7xr490rg7dpqyn53iw3z0-hello-2.12.3.drv^out')
$ nix eval --impure --expr 'let pkgs = import ./nix/pkgs.nix { }; in builtins.toFile "x" "uses ${pkgs.hello}"'
error: files created by builtins.toFile may not reference derivations, but x references !out!gx2drhxsvkh7xr490rg7dpqyn53iw3z0-hello-2.12.3.drv
$ nix eval --impure --expr 'let pkgs = import ./nix/pkgs.nix { }; in builtins.getContext (builtins.toFile "x" "uses ${./flake.nix}")'
{ "/nix/store/k4d847i1ch93dn9nj5s2k2nmbv8a61bs-x" = { path = true; }; }
```

带上下文的字符串不能当属性名（想让它当，必须先显式 `unsafeDiscardStringContext`，这个函数的名字里有 `unsafe` 就是这个原因）；`toFile` 可以引用普通的 store 路径（第三条里，新文件自己带着 `path = true`），但不能引用 derivation 的输出。这个限制的原因我猜是：`toFile` 在求值期就把文件写进 store，而求值期不应该等一次构建（IFD 一节会看到，这样做是有代价的）。这只是我的推测，手册没有解释。

另外还有三个 builtin 是专门摆弄上下文的：`appendContext`（手工追加）、`unsafeDiscardOutputDependency` 和 `addDrvOutputDependencies`（在“只要 `.drv` 这个文件”和“要整棵构建依赖”之间转换）。惯用的 Nix 代码里没人需要它们，[手册](https://nix.dev/manual/nix/2.34/language/string-context)里也明说“String contexts are *not* explicitly manipulated in idiomatic Nix language code”。我把它们列出来，是因为读 nixpkgs 里偶尔会撞上，不是因为你会写。

## 把目录放进 store：builtins.path、filterSource 和 cleanSource

[第 2 篇](/posts/nix-by-firn-02-values-and-types/)里 `"${./.}"` 会把整个目录拷进 store，包括 `.git` 和 `out/`。这一节是它的正经解法。`files` 组里有三个把路径拷进 store 的函数：`builtins.path`（现代版，参数是属性集）、`builtins.filterSource`（旧版，只能传过滤函数）和 `builtins.toFile`（拷的是字符串，不是路径）。过滤函数收到两个参数，路径和类型（`"regular"`、`"directory"`、`"symlink"`、`"unknown"`），返回 `true` 保留。想看一眼就明白，旧版的 `filterSource` 一行就够：目录里有一个 `keep` 文件和一个 `out/` 子目录，过滤函数丢掉名字叫 `out` 的东西。

```text
$ mkdir -p /tmp/fsdemo/out && touch /tmp/fsdemo/keep /tmp/fsdemo/out/x
$ nix eval --impure --raw --expr 'builtins.filterSource (p: t: baseNameOf p != "out") /tmp/fsdemo'
/nix/store/0d2g3ybdka1whvh6bi44papp9l98f2jl-fsdemo
$ ls -A /nix/store/0d2g3ybdka1whvh6bi44papp9l98f2jl-fsdemo
keep
```

结果里没有 `out/`。注意 store 路径的名字是 `fsdemo`，也就是源目录的名字，这一点下面会变成问题。

`lib/sources.nix` 用 `builtins.path` 写了一个 `cleanSource`：

```nix
  # builtins.path 的过滤器收到绝对路径和类型，按目录项的名字判断。
  isNoise =
    path:
    let
      name = baseNameOf path;
    in
    builtins.elem name [
      ".git"
      ".direnv"
      "out"
      "result"
    ]
    || strings.hasPrefix "result-" name;

  cleanSource =
    src:
    builtins.path {
      path = src;
      name = "source";
      filter = path: _type: !(isNoise path);
    };
```

`name = "source"` 不是装饰。store 路径的名字部分默认是源目录的名字，也就是说，同一份内容放在两个目录名不同的检出里，得到的 store 路径也不同：

```text
$ cat out/ch04/path_names.stdout
== checkout-a
/nix/store/fym31rfxclpgdfxmlvsr37iwmads9qy1-checkout-a
/nix/store/w65al5ddldfvzkd3d67nr5i22zl7hg47-source
/nix/store/f9llagip97vy00j0y1i654vrxmvn1srh-source
== checkout-b
/nix/store/n8n8dxpbkzspj5h4rjm4i1g8vjpgy14j-checkout-b
/nix/store/w65al5ddldfvzkd3d67nr5i22zl7hg47-source
/nix/store/f9llagip97vy00j0y1i654vrxmvn1srh-source
== files in the cleaned copy
.
./f.txt
./src
./src/main.c
```

每一组三行：`"${./.}"`（名字是 `checkout-a` 或 `checkout-b`，哈希不同），`builtins.path` 加固定名字（两个检出得到同一个路径），`cleanSource`（也是同一个路径）。固定名字让“内容相同”真的得到“路径相同”，这是二进制缓存能不能命中的前提（第 20 篇）。（这是 [`lab/ch04/path_names.sh`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/path_names.sh)，它在 `LAB_TMP` 里造出 `checkout-a` 和 `checkout-b`，里面各有 `.git/`、`src/out/`、一个叫 `result-1` 的符号链接，和一个叫 `src/result` 的普通文件。）

最后一行 `find` 的输出值得看：`.git/`、`result-1`、`src/out/` 被丢掉了，这符合预期，但 `src/result` **也被丢掉了**。`isNoise` 只看名字，不看类型，所以任何叫 `result` 的东西，不论目录层级，一律丢掉。这是 Firn 的取舍：它的实验输出放在 `out/`，`nix build` 的链接叫 `result`，我图省事用了名字匹配，代价就是上面这个误伤。nixpkgs 的 `cleanSource` 做得更细：它的 [`cleanSourceFilter`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/sources.nix#L54-L94) 只丢 `result*` **符号链接**（`type == "symlink" && hasResultPrefix baseName`，第 90 行），还丢版本控制目录、编辑器备份（`*~`、`.swp`）和 `.o`、`.so`。练习里有一题是让你把 Firn 的版本改成这样。

`lab/ch04/clean_source.sh` 在 `LAB_TMP` 里做了一个小项目，证明 `cleanSource` 的路径对噪音免疫，对真正的修改敏感：

```text
$ cat out/ch04/clean_source.stdout
clean, initial:            /nix/store/s954n1prrx7q44w1qqpjmag1s3j0bzmc-source
raw, initial:              /nix/store/g8k8fmwacwr0gdgf6kiz7b762a792gp6-source
clean, after touching out: /nix/store/s954n1prrx7q44w1qqpjmag1s3j0bzmc-source
raw, after touching out:   /nix/store/fkf70r5nf6858lwrarcjb3yspazd1y2z-source
clean, after edit:         /nix/store/k3zibgrxnlr9hw2kd4sh0s5hzv6p3c8x-source
== files inside the clean copy
README
src
```

往 `out/` 里写一个文件，`cleanSource` 的路径纹丝不动 (`s954n...`)，不过滤的 `builtins.path` 变了（`g8k8...` 到 `fkf7...`）；改了真正的文件，才变 (`k3zi...`)。如果你的 derivation 的 `src` 是 `cleanSource ./.`，改 README 才会触发重新构建，跑一遍测试留下的 `out/` 不会。后面的第 8 篇会讲，flake 做了类似的事（只拷 git 跟踪的文件），那时这个函数就退居二线了；第 10 篇的 `lib.fileset` 则是 nixpkgs 对同一个问题的更精细的答案。

## 求值期 fetcher 和构建期 fetcher

[第 1 篇](/posts/nix-by-firn-01-first-eval/)的 `nix/pins.nix` 用过 `builtins.fetchTarball`，当时我只说了一句“它是求值时取”。`fetchers` 组一共 8 个名字，常用的是四个：`fetchurl`、`fetchTarball`、`fetchGit` 和 `fetchTree`。`lab/ch04/eval_fetchers.nix` 把它们都指向 Cairn 的 `ch10` 标签：

```nix
  # 带 sha256（解包后目录的 NAR 哈希，SRI 形式）：纯模式也能用。
  fetchTarball = builtins.fetchTarball {
    url = "https://github.com/bfmhno3/cairn/archive/refs/tags/${cairnTag}.tar.gz";
    sha256 = "sha256-y+6fZYN1bMicL+IzPC1Wr4mrol+VEVkiDFWuxtsiSxg=";
  };
  fetchGit = builtins.fetchGit {
    url = "https://github.com/bfmhno3/cairn";
    ref = "refs/tags/${cairnTag}";
    rev = cairnRev;
  };
  fetchTree = builtins.fetchTree {
    type = "github";
    owner = "bfmhno3";
    repo = "cairn";
    rev = cairnRev;
  };
```

```text
$ nix eval --file lab/ch04/eval_fetchers.nix --json | jq -c .
{"fetchGit":"/nix/store/nalxmfxg37kgc46s1707ym3xvah710v3-source","fetchGitRev":"3febd7b1a00b7dcbb94d6c6258d38327e3bb24d1","fetchTarball":"/nix/store/nalxmfxg37kgc46s1707ym3xvah710v3-source","fetchTree":"/nix/store/nalxmfxg37kgc46s1707ym3xvah710v3-source","fetchurl":"/nix/store/99pr06byfmwnxmrxy5l4m9s2466624dm-README.md"}
$ nix eval --file lab/ch04/eval_fetchers.nix fetchGit --apply 'g: { inherit (g) rev shortRev revCount narHash lastModifiedDate; }'
{ lastModifiedDate = "20261102155012"; narHash = "sha256-y+6fZYN1bMicL+IzPC1Wr4mrol+VEVkiDFWuxtsiSxg="; rev = "3febd7b1a00b7dcbb94d6c6258d38327e3bb24d1"; revCount = 22; shortRev = "3febd7b"; }
```

三个不同的 fetcher（一个下压缩包，一个走 git 协议，一个走 GitHub API），**得到同一个 store 路径**，`nalxmfx...-source`。因为 store 路径只取决于内容，而这三条路最终都落到“这棵目录树的 NAR 哈希” (`sha256-y+6f...`)，这也是 `fetchTarball` 的 `sha256` 参数在 Nix 里是 **NAR 哈希**，而不是你对着 `.tar.gz` 文件跑 `sha256sum` 得到的那个哈希的原因（第 10 篇我们会量出两者不一样）。`fetchGit` 返回的不只是路径，还有一个属性集，带着 `rev`、`revCount` (22) 和 `lastModifiedDate`，flake 的 `self` 上也有同类的信息（第 8 篇）。

求值器做这件事的方式，才是这一节的主题：下载、解包、算 NAR 哈希、写进 store，**全发生在求值过程中，在求值器进程自己里面**。没有 `.drv`，没有沙箱，没有构建日志。对比一下构建期 fetcher。nixpkgs 里的 `pkgs.fetchurl` 是一个 `stdenvNoCC.mkDerivation`，带 `outputHash`，也就是一个**固定输出 derivation**（[`pkgs/build-support/fetchurl/default.nix` 的第 129 行和第 255 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/fetchurl/default.nix#L129)，第 6 篇讲固定输出）。Nix 自己带着一个更小的同类，`<nix/fetchurl.nix>`，nixpkgs 最底下的 bootstrap 种子就是用它取的（[`hex0.nix` 第 22 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/os-specific/linux/minimal-bootstrap/stage0-posix/hex0.nix#L22)），Firn 第 7 篇的 mini 包集也用它。[`lab/ch04/fod_vs_eval.sh`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/fod_vs_eval.sh) 对同一个 URL 各做一遍，看谁在什么时候真的碰了网络和 store（store 名字里带时间戳，保证两个路径一开始都不存在）：

```bash
readonly fod="import <nix/fetchurl.nix> {
  url = \"${url}\"; hash = \"${hash}\"; name = \"fod-${stamp}.tar.gz\";
}"
readonly eval_fetch="builtins.fetchurl {
  url = \"${url}\"; sha256 = \"${hash}\"; name = \"eval-${stamp}.tar.gz\";
}"
```

```text
$ cat out/ch04/fod_vs_eval.stdout
FOD out path:           /nix/store/ppngy8xx8hipyqd7krrq9y6kajr4zwyy-fod-1793717997145577.tar.gz
present at start:       no
eval drvPath:           29 ms
present after eval:     no
nix build:              7830 ms
present after build:    yes
{"builder":"builtin:fetchurl","outputs":{"out":{"hash":"sha256-tJN8k7bw4BvXCJPMHFnO9hwmE9xRDwdn91i0bBxNwgo=","method":"flat"}}}
builtins.fetchurl:      /nix/store/mxl0q1zndw6k7wvd5r98c3n57rh889wq-eval-1793717997145577.tar.gz
present after the eval: yes
```

固定输出 derivation 的路径在**下载之前就算得出来**（`FOD out path` 在文件还不存在的时候就已经打印了），因为路径由你声明的哈希和名字决定，不由下载的内容决定。求值它的 `.drvPath` 花了 29 毫秒，文件依然不存在；真正的下载发生在 `nix build` 里，这一次花了 7830 毫秒（我猜大部分是在等 GitHub 的重定向，没有拆开量过），做完文件才出现。而 `builtins.fetchurl` 在一次 `nix eval` 里就把文件放进了 store（最后两行）。

这个差别带来四个后果：

- 求值期 fetcher 会**卡住求值**。求值器是串行的，下载多慢，求值就多慢；构建期 fetcher 是构建图里的普通节点，可以和别的构建并行。
- 它让 `nix eval` 不再是无副作用的。一次纯粹的“看看这个表达式的值”，会在你的 store 里留下新路径。
- 没有 `.drv`，所以没有“这个路径是怎么来的”的记录，也没法被二进制缓存以 derivation 的身份命中（第 20 篇）。
- 不带哈希的版本 (`builtins.fetchTarball URL`) 只能在非纯模式下用，而且结果有一个“新鲜期”：这台机器上 `nix config show tarball-ttl` 是 `3600` 秒，过期之后，Nix 用 ETag 问一下服务器，没变就继续用缓存的（[设置的说明](https://nix.dev/manual/nix/2.34/command-ref/conf-file)里写得很清楚，同一个 TTL 管 `fetchGit`、`fetchTarball` 和 `fetchurl`）。

求值期 fetcher 有它不可替代的地方：**引导**。`nix/pins.nix` 要在没有 nixpkgs 的时候取到 nixpkgs，而构建期 fetcher 要靠 nixpkgs 才能用，鸡生蛋问题；flake 的 inputs 也是同样的机制 (`fetchTree`)。nixpkgs 内部，几乎所有包源码走构建期 fetcher，第 10 篇会展开。

## 纯求值到底禁了什么

[第 2 篇](/posts/nix-by-firn-02-values-and-types/)说过：这台机器上 `nix config show pure-eval` 是 `true`，`nix eval --expr` 因此走纯模式；`--file` 和 `--impure` 才是非纯的，`builtins` 才多出两个名字。纯求值到底禁了什么？[`lab/ch04/pure_table.sh`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/pure_table.sh) 对十个典型表达式各跑一次 `--pure-eval`，打印错误的最后一行：

```text
$ cat out/ch04/pure_table.stdout
$ nix eval --pure-eval --expr 'builtins.currentSystem'
error: attribute 'currentSystem' missing
$ nix eval --pure-eval --expr 'builtins.currentTime'
error: attribute 'currentTime' missing
$ nix eval --pure-eval --expr 'builtins.getEnv "HOME"'
""
$ nix eval --pure-eval --expr 'builtins.readFile /etc/hostname'
       error: access to absolute path '/etc/hostname' is forbidden in pure evaluation mode (use '--impure' to override)
$ nix eval --pure-eval --expr 'builtins.readDir /etc'
       error: access to absolute path '/etc' is forbidden in pure evaluation mode (use '--impure' to override)
$ nix eval --pure-eval --expr 'builtins.pathExists /etc/hostname'
false
$ nix eval --pure-eval --expr '<nixpkgs>'
       error: cannot look up '<nixpkgs>' in pure evaluation mode (use '--impure' to override)
$ nix eval --pure-eval --expr 'builtins.fetchurl "https://example.org/x"'
       error: in pure evaluation mode, 'fetchurl' requires a 'sha256' argument
$ nix eval --pure-eval --expr 'builtins.fetchGit "https://github.com/bfmhno3/cairn"'
       error: in pure evaluation mode, 'fetchGit' doesn't fetch unlocked input 'git+https://github.com/bfmhno3/cairn?exportIgnore=1'
$ nix eval --pure-eval --expr 'builtins.storePath /nix/store/lcxc2z1h2g8wq8dxfpizy1di85kyxnqx-hello-2.12.3'
       error: 'builtins.storePath' is not allowed in pure evaluation mode
```

按“怎么拒绝”分成三类。**少一个名字**：`currentSystem` 和 `currentTime`，它们根本不在 `builtins` 里，所以是 `attribute missing`，这是第 2 篇那个 116 对 118 的原因。**报错**：读绝对路径、查找路径 `<nixpkgs>`、没有哈希的 fetcher、`storePath`，错误信息大多还告诉你 `--impure` 能解开。**悄悄返回默认值**：`getEnv "HOME"` 是空字符串，`pathExists /etc/hostname` 是 `false`，没有任何提示。同一个表达式在 `--impure` 下是 `true`（`/etc/hostname` 在这台机器上存在）：

```text
$ nix eval --impure --expr 'builtins.pathExists /etc/hostname'
true
```

第三类是我最不喜欢的。报错至少让你知道出了事，悄悄的 `false` 会让一段 `if pathExists ./local.nix then import ./local.nix else {}` 在纯模式下静默地走到 `else` 分支，你要过很久才会发现“配置没生效”。顺便，`pathExists ./flake.nix` 在 `--pure-eval` 下也是 `false`：我的理解是，纯模式只允许访问求值器“知道”的路径（flake 自己的源码、store 里的、带哈希取来的），你当前目录不在其中。

反过来，带着哈希或 rev 的 fetcher 在纯模式下是允许的，因为内容被写死了。四个 fetcher 的纯模式版本得到的仍是同一个路径：

```text
$ nix eval --pure-eval --raw --expr 'builtins.fetchGit { url = "https://github.com/bfmhno3/cairn"; ref = "refs/tags/ch10"; rev = "3febd7b1a00b7dcbb94d6c6258d38327e3bb24d1"; }'
/nix/store/nalxmfxg37kgc46s1707ym3xvah710v3-source
$ nix eval --pure-eval --raw --expr 'builtins.fetchTarball { url = "https://github.com/bfmhno3/cairn/archive/refs/tags/ch10.tar.gz"; sha256 = "sha256-y+6fZYN1bMicL+IzPC1Wr4mrol+VEVkiDFWuxtsiSxg="; }'
/nix/store/nalxmfxg37kgc46s1707ym3xvah710v3-source
```

`lab/ch04/fetch_unpinned_pure_fail.sh` 是反面，同一个 URL，不带 `sha256`：

```text
$ cat out/ch04/fetch_unpinned_pure_fail.stderr
error:
       … while calling the 'fetchTarball' builtin
         at «string»:1:1:
            1| builtins.fetchTarball "https://github.com/bfmhno3/cairn/archive/refs/tags/ch10.tar.gz"
             | ^

       error: in pure evaluation mode, 'fetchTarball' requires a 'sha256' argument
```

纯求值的目的在这里就清楚了：**求值的结果只由输入决定**。URL 不能决定内容（今天和明天返回的可能不同），哈希能。flake（第 8 篇）把这条规则推到极致：整个求值默认是纯的，所有外部输入都得写进 `flake.lock`。

## import from derivation：求值被构建卡住的那一刻

前面几节里，`import`、`readFile`、`pathExists` 的参数都是普通文件。如果参数是一个**还没构建出来的 derivation 的输出**会怎样？[手册](https://nix.dev/manual/nix/2.34/language/import-from-derivation)列出了会触发的九个 builtin：`import`、`readFile`、`readFileType`、`readDir`、`pathExists`、`filterSource`、`path`、`hashFile` 和 `scopedImport`。会触发的原因是，它们要读的是一个 store 路径的**内容**，而这个路径必须已经存在，所以求值器会暂停，让 Nix 先构建那个 derivation，再继续求值。这就叫 import from derivation，IFD。

```mermaid
sequenceDiagram
    participant E as 求值器
    participant S as Nix store
    E->>E: 求值 import (runCommand ...)
    E->>S: 实例化 gen.drv
    E->>S: 构建 gen.drv（求值暂停）
    S-->>E: /nix/store/...-gen
    E->>S: 读取内容
    E->>E: 继续求值 { x = 42; }
```

上一节讲字符串上下文时我埋了一个伏笔：求值器怎么知道“这个路径还没构建”？答案就是上下文。`import` 的第一步是 [`realisePath`](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/primops.cc#L161)，它把参数字符串的上下文交给 [`realiseContext`](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/primops.cc#L70)，后者遍历上下文里的每个元素，把需要的 derivation 都构建出来。你在下面的错误里会看到这个名字：`while realising the context of path`。

`lab/ch04/ifd.sh` 测了 IFD 的代价。核心是这个表达式，`import` 一个 `runCommand` 的输出，文件内容是 `{ x = 42; }`：

```bash
# Gen name unique per run: the first IFD really builds.
readonly ifd_expr="
  let pkgs = import ${pkgs_nix} { };
  in import (pkgs.runCommand \"gen-${EPOCHREALTIME/./}\" { } ''
    echo '{ x = 42; }' > \$out
  '')
"
readonly plain_expr="import ${FIRN_ROOT}/lab/ch04/fixtures/gen.nix"
readonly pkgs_only_expr="builtins.seq (import ${pkgs_nix} { }).hello.name (import ${FIRN_ROOT}/lab/ch04/fixtures/gen.nix)"
```

名字里带着时间戳，所以每次运行第一遍真的要构建。三个数字要比：第一次（冷）的 IFD；derivation 已经构建好之后，IFD 的 5 次中位数（热）；以及一个**静态 import** 的 5 次中位数，我给了它两个版本，一个单独 import `fixtures/gen.nix`（那个文件内容和生成的一模一样），一个先加载一遍 nixpkgs 再 import（因为 IFD 版本里加载 nixpkgs 是躲不开的，不公平地只比前者没有意义）：

```text
$ cat out/ch04/ifd.stdout
result: { x = 42; }
ifd cold (builds during evaluation): 6706 ms
ifd warm median of 5: 346 ms
plain import median of 5: 23 ms
plain import after loading nixpkgs median of 5: 170 ms
ifd / plain-after-nixpkgs: 2.04
$ cat out/ch04/ifd.stderr
building '/nix/store/qlrihypv6pm3l00dwv67qmk107ykh3ff-gen-1793718018244416.drv'...
building '/nix/store/f71anl0w18cv2qc3g54f86zpamr69rh1-gen-cold-1793718018244416.drv'...
```

`ifd.sh` 的 stderr 里有两行 `building`，不是一行。脚本先用 `ifd_expr` 打印一次 `result:`，这一次构建的是第一个 `gen-…` derivation，后面热的 5 次都复用它；冷启动那次要真的构建，所以它用的是另一个 derivation，名字里的 `gen-` 被替换成 `gen-cold-`：

```bash
echo "result: $(nix eval --impure --expr "${ifd_expr}")"
cold_start="${EPOCHREALTIME/./}"
nix eval --impure --expr "${ifd_expr/gen-/gen-cold-}" >/dev/null
```

结果有两层。**冷**：6706 毫秒，为了一个 `echo`，它要实例化 derivation、起一个沙箱、跑、登记输出。（我另外几次跑出来的是 3796 毫秒和 9159 毫秒，这个数字抖得厉害，沙箱启动和守护进程的状态都会影响它；我没有去拆开看哪一段占大头。）**热**：derivation 已经构建完，346 毫秒，对比同样先加载 nixpkgs 的静态 import 的 170 毫秒，是 2.04 倍。就算什么都不用构建，IFD 仍然慢了一倍，我猜差的这 176 毫秒主要是实例化 `runCommand` 那个 derivation（算 `.drv`、写 store）和每次询问 store 的开销，这是猜测，没拆开量。

IFD 关掉之后是什么样？`lab/ch04/ifd_disabled_fail.sh` 用 `--option allow-import-from-derivation false` 重复同一个表达式，名字依然带时间戳：

```text
$ cat out/ch04/ifd_disabled_fail.stderr
error:
       … while calling the 'import' builtin
         at «string»:3:6:
            2|   let pkgs = import /home/bfmhno3/Projects/firn/nix/pkgs.nix { };
            3|   in import (pkgs.runCommand "gen-1793718033386178" { } ''
             |      ^
            4|     echo '{ x = 42; }' > $out

       … while realising the context of path '/nix/store/929m3f0l3z2frn1i20lcvd35qppv584a-gen-1793718033386178'

       error: cannot build '/nix/store/fgr00y8djr9v5jq1xn3wql75d5m12j1z-gen-1793718033386178.drv^out' during evaluation because the option 'allow-import-from-derivation' is disabled
```

这个选项默认是 `true` (`nix config show allow-import-from-derivation`)，错误来自 [`realiseContext` 里一段 6 行的检查](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/primops.cc#L108-L113)。手册说得很绝：关掉之后，即使需要的 store 对象“现成就在那里”，也一样报错。我拿 `hello` 验证了：它在 store 里，而且我们已经在上面用过它。

```text
$ nix eval --impure --option allow-import-from-derivation false --expr 'let pkgs = import ./nix/pkgs.nix { }; in builtins.pathExists pkgs.hello'
error: cannot build '/nix/store/gx2drhxsvkh7xr490rg7dpqyn53iw3z0-hello-2.12.3.drv^out' during evaluation because the option 'allow-import-from-derivation' is disabled
```

连 `pathExists` 也不行：只要路径带着“这是某个 derivation 的输出”的上下文，就算它碰巧已经存在，Nix 也不去看。代价是失去了便利，换来的是一个保证：求值**一定**不依赖构建。

nixpkgs 为什么禁 IFD？它自己在 [`pkgs/README.md`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/README.md#L520-L525) 里写了理由：因为性能。[Hydra](https://github.com/NixOS/hydra) 要求值整个包集合，求值期间的串行构建会让求值时间变得不可接受；绕过的办法是把生成出来的中间文件提交进版本控制，求值时读它们。它的 CI 也直接执行这一条：求值整个 nixpkgs 的命令里带着 `--option allow-import-from-derivation false`（[`ci/eval/default.nix` 第 84 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/ci/eval/default.nix#L84)和[第 121 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/ci/eval/default.nix#L121)，它们各自的上一行是 `--option restrict-eval true`，第 83 行和第 120 行）。手册里的解释和它一致：求值器是串行的，一次只能发现一个要读的 store 路径，而实现是并行的，所以 IFD 的构建没法一次铺开，比不用 IFD 慢得多。

所以 nixpkgs 里有一批“只能在 nixpkgs 外面用”的 helper，文档里明说了原因：Dart 的 [`autoPubspecLock`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/doc/languages-frameworks/dart.section.md#L14) “依赖 import-from-derivation，不允许在 Nixpkgs 里使用，但在别处很有用”，Haskell 的 [“Import-from-Derivation helpers”](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/doc/languages-frameworks/haskell.section.md#L1157) 是一整节。Firn 的 style 规则（`docs/code-style.md` 的 Nix 一节）也禁 IFD，理由相同。本章的 `ifd*.sh` 是**仅有的**两处故意使用它的地方，所以名字里都带着 `ifd`。

## genericClosure：Nix 原生的图遍历

`lists` 组里有一个看起来很不起眼的名字，`genericClosure`，它是 Nix 原生的图遍历原语：给一个起点集合和一个“邻居函数”，它算出传递闭包，按 `key` 去重，遇到环也能终止。`lab/ch04/generic_closure.nix` 用一张玩具依赖图试它（`cycle-a` 和 `cycle-b` 互相指向）：

```nix
  closure =
    root:
    builtins.genericClosure {
      startSet = [ { key = root; } ];
      operator = item: map (key: { inherit key; }) graph.${item.key};
    };
```

```text
$ nix eval --file lab/ch04/generic_closure.nix
{ app = [ "app" "lib" "cli" "libc" "zlib" ]; cycle = [ "cycle-a" "cycle-b" ]; zlib = [ "zlib" "libc" ]; }
```

`app` 依赖 `lib` 和 `cli`，`lib` 又依赖 `libc` 和 `zlib`，`cli` 也依赖 `lib` 和 `libc`：闭包里每个名字只出现一次。读[源码](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/primops.cc#L786)就知道为什么顺序是这样：它是一个先进先出的工作队列，从队首[弹出一个元素](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/primops.cc#L823)，用 `key` 在一个 `std::map` 里查重，新的就存进结果，并把 `operator` 返回的邻居[追加到队尾](https://github.com/NixOS/nix/blob/2.34.9/src/libexpr/primops.cc#L882)，所以是广度优先。去重靠的是 `key` 的比较，而且**先到先得**：

```text
$ nix eval --expr 'builtins.genericClosure { startSet = [ { key = 1; v = "x"; } { key = 1; v = "y"; } ]; operator = _: [ ]; }'
[ { key = 1; v = "x"; } ]
$ nix eval --expr 'builtins.genericClosure { startSet = [ { key = 1; } { key = "a"; } ]; operator = _: [ ]; }'
error: cannot compare a string with an integer; values are "a" and 1
$ nix eval --expr 'builtins.genericClosure { startSet = [ { k = 1; } ]; operator = _: [ ]; }'
error: attribute 'key' missing
```

两个 `key = 1`，第一个赢；`key` 的类型必须能互相比较（字符串和整数不行），而且必须叫 `key`。

这个原语的出场比想象的重要：nixpkgs 展开 NixOS 模块的 `imports`，用的就是它（[`lib/modules.nix` 第 569 到 572 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/modules.nix#L569-L572)）：

```nix
        catAttrs "module" (genericClosure {
          startSet = keyFilter modules;
          operator = attrs: keyFilter attrs.modules;
        });
```

“按 key 去重”解释了为什么两个模块各自 `imports` 同一个模块时，那个模块只会出现一次（我猜模块的 `key` 默认是文件路径，这一点第 15 篇我们自己写模块系统时再验证）。

## README 里的表：由程序生成

这一章 Firn 第一次有了一份“由程序渲染”的文档：README 里的章节表。数据在 `data/chapters.toml`，渲染函数是 `lib/readme.nix`：

```nix
  pad2 = n: if n < 10 then "0${toString n}" else toString n;

  row = c: "| `ch${pad2 c.n}` | ${c.title} | `/posts/${c.stem}/` |";

  # 参数是 TOML 里的 chapters 数组；属性集按键排序，行序只能来自列表。
  renderChapterTable =
    chapters:
    builtins.concatStringsSep "\n" (
      [
        "| Chapter | Topic | Post |"
        "| --- | --- | --- |"
      ]
      ++ map row chapters
    )
    + "\n";
```

最关键的是注释里那一句。属性集的键总是排好序的（第 2 篇），所以如果章节表的数据是 `{ ch01 = ...; ch02 = ...; }`，渲染出来的顺序是按名字排的：不补零的话，`ch10` 会排在 `ch2` 前面。TOML 里的 `[[chapters]]` 是数组，数组保持写入顺序，所以数据用列表，顺序由文件决定，而不是由键名决定。`pad2` 是个很小的补零函数，它存在是因为 `builtins` 里没有 `printf`。

README 里在两个标记之间放着表：

```text
$ grep -n 'chapters:' README.md
11:<!-- chapters:begin -->
34:<!-- chapters:end -->
```

`lab/ch04/render_table.nix` 输出渲染结果，README 里标记之间的内容必须和它完全一致：

```text
$ diff <(sed -n '/<!-- chapters:begin -->/,/<!-- chapters:end -->/p' README.md | sed '1d;$d') <(nix eval --raw --file lab/ch04/render_table.nix); echo "diff exit $?"
diff exit 0
```

没有任何 diff。从第 5 篇起，这条检查会变成 `nix flake check` 里的一个 check (`readme-table`)，在那之前，它靠你手动运行。`tests/lib.nix` 里还有一个更小的用例，`renderChapterTableTwoRows`，用两行假数据检验字符串格式，不依赖真实文件。

数据文件本身也是个好的小实验。`lab/ch04/ex_count_topics.nix` 是本章练习的答案，它对 20 章的 `topics` 做了一次统计：

```text
$ nix eval --file lab/ch04/ex_count_topics.nix
{ chapters = 20; repeated = { nixpkgs = 2; "函数式" = 2; "可复现性" = 2; "类型" = 2; }; topicsDistinct = 55; topicsTotal = 59; }
```

20 章，59 个主题标记，55 个不同的（`nixpkgs`、`函数式`、`可复现性`、`类型` 各出现两次，59 减 55 正好是 4）。

## 让我意外的事

写这一篇之前，我对 `builtins` 的印象是“一堆工具函数”。写完之后，我发现那些最有意思的东西，都不是函数本身，而是函数之间悄悄传递的、看不见的东西。四件事：

**`split` 和 `match` 会悄悄丢掉字符串上下文。** 我是对着 nixpkgs 的 `splitString` 才发现的：Firn 的版本在遇到带 store 路径的字符串时，返回的每一段都没有上下文，而 nixpkgs 的版本多了一个 `map (addContextFrom s)`。`addContextFrom` 本身只有 `substring 0 0 src + target` 一行，用一个**空字符串**把上下文搬到目标上。我以前以为上下文是字符串自带的性质，现在觉得它更像一条需要每个函数自觉维护的约定：谁拆开字符串，谁就负责把上下文补回去。这个约定的代价是，每个忘了补的函数，都会在不报错的情况下制造出一个悬空引用。

**纯求值最糟的失败方式不是报错，是返回 `false`。** 我原来以为纯模式就是一道墙，碰到就炸。实际上十个表达式里，`getEnv` 返回 `""`，`pathExists` 返回 `false`，连一个警告都没有。写 `if pathExists ./local.nix` 的人会把“这个文件不存在”和“纯模式不让我看这个文件”混成同一个答案。

**IFD 就算什么都不用构建，也慢一倍。** 我预期的是“冷的时候慢，热的时候和静态 import 一样”，因为 derivation 都构建好了，剩下的只是读一个文件。实测热的 IFD 是 346 毫秒，同样内容的静态 import 是 170 毫秒，2.04 倍。我没有拆开量，我的猜测是 `runCommand` 本身的实例化和对 store 的询问都不是免费的。无论如何，它至少说明 nixpkgs 不愿意让整个包集合的每一次求值都付这笔钱。

**正则会爆栈，而错误信息说的是“可能是无限递归”。** 100000 个字符的 `.*` 就让求值器报 `stack overflow (possible infinite recursion)`，而 90000 个没事。这个报错让我愣了一下：我用 `genList` 生成的那个字符串，只有一层调用，没有递归。我猜是 `std::regex` 对长输入递归得很深，而那句“可能是无限递归”是 Nix 对所有爆栈的统一说法。（这是我从报错和实现推测的，没有读 `std::regex` 的源码。）

## 检查点

在 `~/firn` 里，`nix develop` 之内：

```bash
make ch04
make lint
for f in lib/default.nix lib/strings.nix lib/importers.nix lib/sources.nix \
  lib/readme.nix tests/lib.nix data/chapters.toml \
  lab/ch04/*.nix lab/ch04/*.sh lab/ch04/fixtures/*.nix \
  lab/ch04/fixtures/dir/default.nix; do
  diff <(git -C ~/firn-ref show ch04:"${f}") "${f}" && echo "same ${f}"
done
```

`make ch04` 应当打印这 27 行（命令回显加 26 行 `ok`；这一章没有 `_host` 实验，所以设不设 `CI` 都一样）：

```text
bash scripts/chapter.sh ch04
ok   lab/ch04/builtins_groups.nix
ok   lab/ch04/clean_source.sh
ok   lab/ch04/clean_source_v2.nix
ok   lab/ch04/context_danger.sh
ok   lab/ch04/context_kinds.nix
ok   lab/ch04/context_matters.sh
ok   lab/ch04/eval_fetchers.nix
ok   lab/ch04/ex_clean_source_result.sh
ok   lab/ch04/ex_count_topics.nix
ok   lab/ch04/fetch_unpinned_pure_fail.sh
ok   lab/ch04/fod_vs_eval.sh
ok   lab/ch04/generic_closure.nix
ok   lab/ch04/ifd.sh
ok   lab/ch04/ifd_disabled_fail.sh
ok   lab/ch04/import_tour.nix
ok   lab/ch04/json_toml.nix
ok   lab/ch04/path_names.sh
ok   lab/ch04/pure_table.sh
ok   lab/ch04/read_dir.nix
ok   lab/ch04/regex.nix
ok   lab/ch04/regex_perl_fail.nix
ok   lab/ch04/render_table.nix
ok   lab/ch04/scoped_import.nix
ok   lab/ch04/split_context.nix
ok   lab/ch04/string_context.nix
ok   lab/ch04/toml_datetime_fail.nix
```

`fetch_unpinned_pure_fail`、`ifd_disabled_fail`、`regex_perl_fail` 和 `toml_datetime_fail` 这四个文件名以 `_fail` 结尾，运行器要求它们以非零状态退出（实际都是 1），所以也是 `ok`。这一章的实验需要网络（`eval_fetchers.nix`、`fetch_unpinned_pure_fail.sh` 访问 GitHub），`ifd.sh` 的时间会随机器变化，但不会让它失败。`make lint` 只回显它跑的几条命令（`nixfmt --check`、`deadnix --fail`、`shellcheck`、`shfmt`；`statix` 那一行以 `@` 开头，`make` 不回显它），没有任何诊断，退出码 0。

`diff` 循环应当打印 37 行 `same ...`，不打印 diff：`lib/` 下 5 个文件，`tests/lib.nix`，`data/chapters.toml`，26 个实验，4 个 fixtures。

**必须和标签一致的文件：** `lib/strings.nix`、`lib/importers.nix`、`lib/sources.nix`、`lib/readme.nix`、`data/chapters.toml`，以及 `lab/ch04/` 下全部 26 个实验和 4 个 fixtures。它们已经是最终版本，我不打算再改，后面的章节只会使用它们。`lab/ch04/*.sh` 在标签里没有可执行位（运行器用 `bash` 调用），你的副本不用 `chmod`。

**中间版本（后面的章节会继续改）：**

- [`lib/default.nix`](https://github.com/bfmhno3/firn/blob/ch04/lib/default.nix)：现在导入 7 个子集，导出 31 个名字（`version`、7 个子集名和 23 个平铺的函数）。第 5 篇加 `lists`、`generators`、`debug`，第 6 篇加 `store-path`。
- [`tests/lib.nix`](https://github.com/bfmhno3/firn/blob/ch04/tests/lib.nix)：现在是 47 个用例，这一章加了 16 个，运行器仍是自己写的“失败列表”。第 5 篇整个改用 `runTests`，并接入 `nix flake check`。
- [`README.md`](https://github.com/bfmhno3/firn/blob/ch04/README.md)：章节表现在由程序生成，标记之间的内容不要手改。以后每多一个顶层目录，Layout 一节就会更新。
- [`lib/attrsets.nix`](https://github.com/bfmhno3/firn/blob/ch04/lib/attrsets.nix)：这一章没有改，还是四个函数，第 5 篇补全。

### 文件清单

这一篇的所有文件都在仓库里，链接指向标签 `ch04` 上的那一份。实验需要沙箱目录和 `FIRN_ROOT`，所以带 `make ch04` 的行是通过运行器跑的；`.nix` 实验也可以直接用 `nix eval --file` 运行。许可证文本不在表里。直接运行 `scoped_import.nix`、`context_kinds.nix` 和 `split_context.nix` 时要自己设 `FIRN_ROOT=$PWD`，运行器替你设了。结果列是我在 Nix 2.34.9 上的真实输出，路径里的用户名和目录是我机器上的。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`README.md`](https://github.com/bfmhno3/firn/blob/ch04/README.md) | `diff <(sed -n '/<!-- chapters:begin -->/,/<!-- chapters:end -->/p' README.md \| sed '1d;$d') <(nix eval --raw --file lab/ch04/render_table.nix)` | 退出码 0，没有输出；标记在第 11 行和第 34 行 |
| [`data/chapters.toml`](https://github.com/bfmhno3/firn/blob/ch04/data/chapters.toml) | `nix eval --impure --expr 'builtins.length ((import ./lib).importTOML ./data/chapters.toml).chapters'` | `20`；121 行 |
| [`lib/default.nix`](https://github.com/bfmhno3/firn/blob/ch04/lib/default.nix) | `nix eval --impure --expr 'builtins.length (builtins.attrNames (import ./lib))'` | `31` |
| [`lib/importers.nix`](https://github.com/bfmhno3/firn/blob/ch04/lib/importers.nix) | `nix eval --impure --expr 'builtins.length ((import ./lib).readLines ./README.md)'` | `71`，和 `wc -l README.md` 一致 |
| [`lib/readme.nix`](https://github.com/bfmhno3/firn/blob/ch04/lib/readme.nix) | `nix eval --impure --raw --expr '(import ./lib).renderChapterTable [ ]'` | 两行表头：`\| Chapter \| Topic \| Post \|` 和 `\| --- \| --- \| --- \|` |
| [`lib/sources.nix`](https://github.com/bfmhno3/firn/blob/ch04/lib/sources.nix) | `nix eval --impure --raw --expr '(import ./lib).cleanSource ./lab/ch04/fixtures'` | `/nix/store/l91f48vfrydyhzl90ylpg4fpcybj88z0-source` |
| [`lib/strings.nix`](https://github.com/bfmhno3/firn/blob/ch04/lib/strings.nix) | `nix eval --impure --expr '(import ./lib).splitString "." "a.b.c"'` | `[ "a" "b" "c" ]`；空分隔符报 `firn: splitString: separator must not be empty` |
| [`tests/lib.nix`](https://github.com/bfmhno3/firn/blob/ch04/tests/lib.nix) | `nix eval --file tests/lib.nix` | `[ ]`；47 个用例 |
| [`lab/ch04/builtins_groups.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/builtins_groups.nix) | `nix eval --file lab/ch04/builtins_groups.nix` | 退出码 0；`total = 118`，12 组（`lists` 17 个最多，`hashing` 3 个最少） |
| [`lab/ch04/clean_source.sh`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/clean_source.sh) | `make ch04` | 退出码 0；`clean` 路径在改 `out/x` 之后不变，改 `README` 后才变；副本里只有 `README` 和 `src` |
| [`lab/ch04/clean_source_v2.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/clean_source_v2.nix) | `nix eval --file lab/ch04/clean_source_v2.nix` | 退出码 0；打印 `«lambda @ .../lab/ch04/clean_source_v2.nix:15:1»`，它是一个函数文件，不单独产生结果；被 `ex_clean_source_result.sh` 使用，练习 5 |
| [`lab/ch04/context_danger.sh`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/context_danger.sh) | `make ch04` | 退出码 0；`keep` 版本 `dependency: exists (built)`，`discard` 版本 `dependency: MISSING`，后者的输入 derivation 少了 `dep-...drv` |
| [`lab/ch04/context_kinds.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/context_kinds.nix) | `FIRN_ROOT=$PWD nix eval --file lab/ch04/context_kinds.nix --json` | 退出码 0；`keeps` 里 5 个 `true`，`drops` 里 4 个 `false`，`kinds` 里 3 种上下文元素 |
| [`lab/ch04/context_matters.sh`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/context_matters.sh) | `make ch04` | 退出码 0；保留上下文闭包 6 个路径，丢掉后 1 个 |
| [`lab/ch04/eval_fetchers.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/eval_fetchers.nix) | `nix eval --file lab/ch04/eval_fetchers.nix --json` | 退出码 0；`fetchGit`、`fetchTarball`、`fetchTree` 都是 `/nix/store/nalxmfxg37kgc46s1707ym3xvah710v3-source`；需要网络 |
| [`lab/ch04/ex_clean_source_result.sh`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/ex_clean_source_result.sh) | `make ch04` | 退出码 0；最后一行 `ok: src/result kept; result, result-1, .git, src/out dropped`，练习 5 |
| [`lab/ch04/ex_count_topics.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/ex_count_topics.nix) | `nix eval --file lab/ch04/ex_count_topics.nix` | 退出码 0；`chapters = 20`，`topicsTotal = 59`，`topicsDistinct = 55`，练习 1 |
| [`lab/ch04/fetch_unpinned_pure_fail.sh`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/fetch_unpinned_pure_fail.sh) | `make ch04` | 退出码 1（按设计失败）；stderr 里是 `error: in pure evaluation mode, 'fetchTarball' requires a 'sha256' argument` |
| [`lab/ch04/fod_vs_eval.sh`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/fod_vs_eval.sh) | `make ch04` | 退出码 0；`eval drvPath` 29 ms 且 `present after eval: no`，`nix build` 7830 ms 之后 `yes`，builder 是 `builtin:fetchurl`；需要网络（每次不同） |
| [`lab/ch04/generic_closure.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/generic_closure.nix) | `nix eval --file lab/ch04/generic_closure.nix` | 退出码 0；`app = [ "app" "lib" "cli" "libc" "zlib" ]`，`cycle = [ "cycle-a" "cycle-b" ]` |
| [`lab/ch04/ifd.sh`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/ifd.sh) | `make ch04` | 退出码 0；冷 6706 ms，热 346 ms，静态 import 23 ms，加载 nixpkgs 后 170 ms，比值 `2.04`（每次不同，冷启动我见过 3796 ms 到 9159 ms） |
| [`lab/ch04/ifd_disabled_fail.sh`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/ifd_disabled_fail.sh) | `make ch04` | 退出码 1（按设计失败）；stderr 里是 `error: cannot build '...drv^out' during evaluation because the option 'allow-import-from-derivation' is disabled` |
| [`lab/ch04/import_tour.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/import_tour.nix) | `nix eval --file lab/ch04/import_tour.nix` | 退出码 0；stderr 一行 `trace: traced.nix evaluated`，stdout `fromFile = 42`，`tracedTwice = 6` |
| [`lab/ch04/json_toml.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/json_toml.nix) | `nix eval --file lab/ch04/json_toml.nix --json` | 退出码 0；`chapterCount = 20`，`intFloat = [ "int" "float" ]`，`sameAsLib = true` |
| [`lab/ch04/path_names.sh`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/path_names.sh) | `make ch04` | 退出码 0；两个检出的 `cleanSource` 路径都是 `f9llagip97vy00j0y1i654vrxmvn1srh-source`；清理后的目录只剩 `f.txt`、`src/main.c` |
| [`lab/ch04/pure_table.sh`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/pure_table.sh) | `make ch04` | 退出码 0；10 个表达式：2 个 `attribute ... missing`，6 个报错，`getEnv` 返回 `""`、`pathExists` 返回 `false` |
| [`lab/ch04/read_dir.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/read_dir.nix) | `nix eval --file lab/ch04/read_dir.nix --json` | 退出码 0；17 个条目，`directories = [ "fixtures" ]`，`fileType = "directory"` |
| [`lab/ch04/regex.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/regex.nix) | `nix eval --file lab/ch04/regex.nix --json` | 退出码 0；`full = [ "04" ]`，`partial = null`，`split = [ "a" [ ] "b" [ ] "c" ]` |
| [`lab/ch04/regex_perl_fail.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/regex_perl_fail.nix) | `make ch04` | 退出码 1（按设计失败）；stderr 里是 `error: invalid regular expression '\d+'` |
| [`lab/ch04/render_table.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/render_table.nix) | `nix eval --raw --file lab/ch04/render_table.nix` | 退出码 0；22 行 Markdown 表（2 行表头加 20 行章节），和 README 标记之间的内容一致 |
| [`lab/ch04/scoped_import.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/scoped_import.nix) | `FIRN_ROOT=$PWD nix eval --file lab/ch04/scoped_import.nix` | 退出码 0；stdout `6`，stderr 两行 `trace: traced.nix evaluated` |
| [`lab/ch04/split_context.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/split_context.nix) | `FIRN_ROOT=$PWD nix eval --file lab/ch04/split_context.nix` | 退出码 0；`{ firn = false; nixpkgs = true; trick = true; }` |
| [`lab/ch04/string_context.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/string_context.nix) | `nix eval --file lab/ch04/string_context.nix` | 退出码 0；`hasContext = true`，`discardedHasContext = false`，`samePath = true` |
| [`lab/ch04/toml_datetime_fail.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/toml_datetime_fail.nix) | `make ch04` | 退出码 1（按设计失败）；stderr 里是 `error: while parsing TOML: Dates and times are not supported` |
| [`lab/ch04/fixtures/adder.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/fixtures/adder.nix) | `nix eval --impure --expr '(import ./lab/ch04/fixtures/adder.nix) 41'` | `42`；被 `import_tour.nix` 使用 |
| [`lab/ch04/fixtures/dir/default.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/fixtures/dir/default.nix) | `nix eval --impure --expr 'import ./lab/ch04/fixtures/dir'` | `{ name = "dir/default.nix"; }`；被 `import_tour.nix` 使用 |
| [`lab/ch04/fixtures/gen.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/fixtures/gen.nix) | `nix eval --impure --expr 'import ./lab/ch04/fixtures/gen.nix'` | `{ x = 42; }`；被 `ifd.sh` 使用，是 IFD 生成内容的静态版本 |
| [`lab/ch04/fixtures/traced.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/fixtures/traced.nix) | `nix eval --impure --expr '(import ./lab/ch04/fixtures/traced.nix) 21'` | 退出码 0；stdout `42`，stderr 一行 `trace: traced.nix evaluated` |

## 练习

**1.** 数一数 `data/chapters.toml` 里所有主题标记的出现次数：一共几个，不同的几个，哪些出现过不止一次。

<details>
<summary>参考答案</summary>

这就是 [`lab/ch04/ex_count_topics.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/ex_count_topics.nix)，全文 20 行：

```nix
# 练习参考答案：统计 data/chapters.toml 里所有主题的出现次数。
let
  lib = import ../../lib;
  chapters = (lib.importTOML ../../data/chapters.toml).chapters;
  allTopics = builtins.concatLists (map (c: c.topics) chapters);
  counts = builtins.mapAttrs (_: builtins.length) (builtins.groupBy (t: t) allTopics);
in
{
  chapters = builtins.length chapters;
  topicsTotal = builtins.length allTopics;
  topicsDistinct = builtins.length (builtins.attrNames counts);
  repeated = builtins.listToAttrs (
    builtins.filter (kv: kv.value > 1) (
      map (name: {
        inherit name;
        value = counts.${name};
      }) (builtins.attrNames counts)
    )
  );
}
```

`concatLists (map ... chapters)` 把 20 个列表压平，`groupBy (t: t)` 以主题本身为键分组（每组是出现的那几个相同字符串），`mapAttrs (_: length)` 把每组变成个数。输出是：

```text
$ nix eval --file lab/ch04/ex_count_topics.nix
{ chapters = 20; repeated = { nixpkgs = 2; "函数式" = 2; "可复现性" = 2; "类型" = 2; }; topicsDistinct = 55; topicsTotal = 59; }
```

`repeated` 的构造是个小技巧：Nix 没有 `filterAttrs`，所以先把属性集变成 `{ name; value; }` 的列表，用 `filter` 筛，再用 `listToAttrs` 变回去。

</details>

**2.** 不运行，预测这三个表达式的值，再运行验证：`builtins.match "a|b" "b"`、`builtins.match "(a)|(b)" "b"`、`builtins.split "(a)|b" "xaby"`。

<details>
<summary>参考答案</summary>

```text
$ nix eval --expr 'builtins.match "a|b" "b"'
[ ]
$ nix eval --expr 'builtins.match "(a)|(b)" "b"'
[ null "b" ]
$ nix eval --expr 'builtins.split "(a)|b" "xaby"'
[ "x" [ "a" ] "" [ null ] "y" ]
```

第一个没有捕获组，匹配成功，所以是空列表，不是 `null`。第二个有两个捕获组，第二个参与了匹配，第一个没有，所以是 `null` 和 `"b"`。第三个是 `split`：`xaby` 里有两处匹配，`a`（捕获组 `(a)` 是 `"a"`）和 `b`（捕获组没参与，是 `null`），两处之间夹着一个空字符串，所以是“字符串、列表、字符串、列表、字符串”五项，首尾是 `"x"` 和 `"y"`。

</details>

**3.** 把本章的 IFD 实验改成不会触发 IFD 的版本，让它在 `--option allow-import-from-derivation false` 下也能算出 `{ x = 42; }`。

<details>
<summary>参考答案</summary>

`builtins.toFile` 在求值期直接把文本写进 store，不经过构建，所以它的结果不属于“derivation 的输出”：

```text
$ nix eval --impure --option allow-import-from-derivation false --expr 'import (builtins.toFile "gen.nix" "{ x = 42; }")'
{ x = 42; }
$ nix eval --impure --option allow-import-from-derivation false --expr 'let pkgs = import ./nix/pkgs.nix { }; in builtins.readFile (pkgs.writeText "t" "hi")'
error: cannot build '/nix/store/fyy77krx61pzc7x3h10109c68rmli843-t.drv^out' during evaluation because the option 'allow-import-from-derivation' is disabled
```

第二条用 `pkgs.writeText` 做同样的事，就被拒了：`writeText` 是一个 derivation（要构建），`toFile` 不是。这也许解释了为什么 `toFile` 的内容不能引用 derivation 的输出（本章“丢掉上下文”一节里的 `toFile` 报错）：求值期写进 store 的文件，被引用的东西可能还没构建出来。这是我的猜测。nixpkgs 的建议是把生成的文件提交进版本控制，等价于手工做一次 `toFile`。

</details>

**4.** 属性名不能带字符串上下文，`{ "${pkgs.hello}" = 1; }` 会报错。怎么绕过去？绕过去之后失去了什么？

<details>
<summary>参考答案</summary>

用 `unsafeDiscardStringContext` 显式丢掉上下文：

```text
$ nix eval --impure --expr 'let pkgs = import ./nix/pkgs.nix { }; in { ${builtins.unsafeDiscardStringContext (toString pkgs.hello)} = 1; }'
{ "/nix/store/lcxc2z1h2g8wq8dxfpizy1di85kyxnqx-hello-2.12.3" = 1; }
```

失去的是 hello 这条依赖：这个属性集本身不再依赖 hello，别的 derivation 用它做输入时，hello 不会因此被构建。手册对这个函数的解释就是这个意思：必须显式丢弃上下文，目的是保证你不会不小心把它丢掉。

</details>

**5.** 把 `lib/sources.nix` 的 `isNoise` 改成 nixpkgs 的做法：`result` 和 `result-*` 只有在是符号链接时才丢。验证 `src/result` 这个普通文件被保住了。

<details>
<summary>参考答案</summary>

过滤函数已经收到类型参数，只需要用上它。答案是 [`lab/ch04/clean_source_v2.nix`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/clean_source_v2.nix)，一个接收目录、返回 store 路径的函数：

```nix
let
  inherit (import (builtins.getEnv "FIRN_ROOT" + "/lib")) hasPrefix;
  isNoise =
    path: type:
    let
      name = baseNameOf path;
    in
    builtins.elem name [
      ".git"
      ".direnv"
      "out"
    ]
    || (type == "symlink" && hasPrefix "result" name);
in
src:
builtins.path {
  path = src;
  name = "source";
  filter = path: type: !(isNoise path type);
}
```

它是函数，不是值，所以运行器直接对它 `nix eval` 时只会打印 `«lambda ...»`。真正验证它的是 [`lab/ch04/ex_clean_source_result.sh`](https://github.com/bfmhno3/firn/blob/ch04/lab/ch04/ex_clean_source_result.sh)：在 `LAB_TMP` 里造一个项目，里面有 `src/result` 这个普通文件、`result` 和 `result-1` 两个符号链接、`.git/` 和 `src/out/`，再用 `clean_source_v2.nix` 复制，只要结果和期望不同就以 1 退出：

```text
$ cat out/ch04/ex_clean_source_result.stdout
.
./src
./src/main.c
./src/result
ok: src/result kept; result, result-1, .git, src/out dropped
```

`src/result` 保住了，两个符号链接、`.git/` 和 `src/out/` 被丢掉了。代价是多一个参数、多一个判断；换来的是一个误伤更少的过滤器。

</details>

## 下一篇

这一篇里我一直在用 Firn 的 `lib`，却只验证过它的几个用例。下一篇，第 5 篇[《自己写一个 lib：递归、错误处理与测试》](/posts/nix-by-firn-05-own-lib/)，我们回到 `lib` 本身：写 `lists`、`generators` 和 `debug`，让 `foldl'` 和朴素递归在栈上拉开差距，用 `--show-trace` 和 `--debugger` 读错误，把 `tests/lib.nix` 改写成 `runTests`，接进 `nix flake check`。第 6 篇才轮到 `derivation` 和 `/nix/store` 本身，到那时，这一篇里“上下文指向 `.drv`”这件事会有一个完整的解释。
