---
title: "值与类型：attrset、list、字符串与路径"
commentId: "post:nix-by-firn-02-values-and-types"
published: "2026-11-03 17:00:00 +08:00"
description: "用 Firn 从零学 Nix 第 2 篇：我用 Nix 2.34.9 把语言里的每一种值过了一遍，发现 builtins 在纯求值下有 116 个、非纯下有 118 个，把文件改一个字节再做路径插值，store 路径的 32 个字符只剩 2 个位置没变，还给 Firn 写出了第一个模块 lib 和 20 个测试用例。"
category: Tutorial
tags:
  - Nix
  - NixOS
  - Firn
  - 类型
  - attrset
  - 字符串
series: "用 Firn 从零学 Nix"
seriesOrder: 2
draft: false
comment: true
slug: nix-by-firn-02-values-and-types
---

上一篇我在 repl 里让 `2 * 3.0` 打印出了 `6`，然后绕了过去，没有解释。这一篇不绕：我把 Nix 的每一种值都拿出来，让 `builtins.typeOf` 当面回答它是什么，再逐个看它们之间的运算、转换和相等。先看最短的那份结果，它来自仓库里的第一个实验：

```text
$ nix eval --file lab/ch02/types.nix
{ bool = "bool"; builtinCount = 118; float = "float"; int = "int"; lambda = "lambda"; list = "list"; null = "null"; path = "path"; set = "set"; string = "string"; }
```

> [!NOTE] 本篇检查点
> 这一篇结束时，你的 `~/firn` 里多出这些东西：`lib/default.nix`、`lib/trivial.nix`、`lib/attrsets.nix`（Firn 自己的库，这一版有 `id`、`const`、`flip` 和四个属性集函数，后面会继续长），`tests/lib.nix`（20 个用例，第 5 篇整个重写），README 的 Layout 里多出两行，以及 `lab/ch02/` 下的 16 个实验和一个 fixture 文件。`make ch02` 通过，`make lint` 通过。
> 涉及的 Nix 内容：全部值类型，整数与浮点，字符串的三种写法、插值与转义，`''` 缩进剥离，`toString`，attrset 的语法与糖（`rec`、`inherit`、`?`、`or`、动态键、`a.b.c`），`//` 与递归合并，列表，路径与“插值时拷进 store”，`==` 与比较，`with` 的作用域规则，`toJSON`/`fromJSON`。
> 前置：[第 1 篇](/posts/nix-by-firn-01-first-eval/)，你需要一个能跑 `nix eval` 的 Nix 和 `nix develop` 里的 `make`。

## 十种值，其中九种我能写出来

Nix 手册的[数据类型一页](https://nix.dev/manual/nix/2.34/language/types)开头就是一个列表：Integer、Float、Boolean、String、Path、Null、Attribute set、List、Function、External，一共十种。整个语言的文法在[这一组页面](https://nix.dev/manual/nix/2.34/language/)里，我这一篇需要的细节都从它里面核对。下面这张表把手册的名字、字面量和 `types.nix` 里 `typeOf` 的回答对在一起：

| 手册里的名字 | 字面量 | `builtins.typeOf` | 备注 |
| --- | --- | --- | --- |
| Integer | `1` | `"int"` | 64 位有符号整数 |
| Float | `1.5` | `"float"` | 64 位 IEEE 754 |
| Boolean | `true` | `"bool"` | |
| String | `"s"` | `"string"` | 字节序列加一个“字符串上下文”（第 4 篇） |
| Path | `./.` | `"path"` | 不是字符串，下面一节专门讲 |
| Null | `null` | `"null"` | 只有一个值 |
| List | `[ 1 ]` | `"list"` | 元素类型可以不同 |
| Attribute set | `{ }` | `"set"` | `typeOf` 说 `set`，不说 `attrset` |
| Function | `x: x` | `"lambda"` | 用户函数和 `builtins.add` 都是 `lambda`（第 1 篇） |
| External | 无字面量 | 无 | 插件造出来的不透明值 |

最后一行我没法实验：External 只能由 Nix 插件创建，我没有装任何插件，所以那一格我留空，也不去猜 `typeOf` 会说什么。

实验本身很短。这是 `lab/ch02/types.nix` 的开头，剩下的行都是同一个模式：

```nix
# 每种值类型各取一个，看 builtins.typeOf 怎么说。
{
  int = builtins.typeOf 1;
  float = builtins.typeOf 1.5;
  # ...
  lambda = builtins.typeOf (x: x);
  builtinCount = builtins.length (builtins.attrNames builtins);
}
```

有两件事值得停一下。

第一，`true`、`false`、`null` 不是关键字。手册说它们是 `builtins` 的属性，只是恰好在全局作用域里有同名的绑定。所以你可以把它们遮蔽掉：

```text
$ nix eval --expr 'let true = false; null = 1; in [ true null ]'
[ false 1 ]
```

没有人会这么写（我希望如此），但它说明了一件事：Nix 的保留字比你以为的少，`true`、`false`、`null` 不在其中。后面讲 `with` 的时候，我们会遇到同一种“名字被悄悄换掉”的现象，那一次它是真的会出事的。

这个现象在 repl 里会自己找上门。上一篇讲过 `:l` 会把文件求值出来的属性集的每个属性放进当前作用域，而 `types.nix` 里恰好有一个属性叫 `null`（它的值是字符串 `"null"`）：

```text
$ printf ':l lab/ch02/types.nix\n:t null\n:t builtins.null\nnull == builtins.null\n:q\n' | nix repl 2>&1 | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | grep -v '^$'
Nix 2.34.9
Type :? for help.
Added 10 variables.
bool, builtinCount, float, int, lambda, list, null, path, set, string
a string
null
false
```

加载之后，裸的 `null` 是一个字符串（`:t` 说 `a string`），和真正的 `builtins.null` 不相等。（命令里的 `sed` 是在去掉 repl 打印的终端控制码。）所以用 `:l` 的时候，别载入一个带 `null`、`true` 或 `map` 这类属性的文件，它们会悄悄遮蔽同名的全局名字。

第二，函数和属性集的边界没有你想的那么清楚。一个带 `__functor` 的属性集可以被调用，手册的运算符一页把它列为“callable value”的第三种（另外两种是用户函数和内建函数）。可 `typeOf` 对它说的还是 `"set"`，`isFunction` 说 `false`：

```text
$ nix eval --expr 'let f = { __functor = self: x: x + self.n; n = 1; }; in [ (builtins.typeOf f) (f 2) (builtins.isFunction f) ]'
[ "set" 3 false ]
```

这不是纸上谈兵。nixpkgs 的 [`lib.trivial.setFunctionArgs`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/trivial.nix#L1081-L1085) 返回的就是这样一个属性集（`__functor = self: f;` 加一个 `__functionArgs`），所以同一个文件里的 [`lib.isFunction`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/trivial.nix#L1127-L1131) 必须多写半句 `f ? __functor && isFunction (f.__functor f)`。第 3 篇讲 `functionArgs` 时，这个 `__functionArgs` 会再出现。现在只需要记住：可以调用它，不等于它的类型是 `lambda`。

### typeOf 之外：isInt 家族

`typeOf` 返回一个字符串，你得去比较它。如果只是想问一个问题，`builtins` 里还有一组谓词，每种类型一个。对整数 `1` 把它们全部问一遍：

```text
$ nix eval --expr 'builtins.filter (n: builtins.match "is.*" n != null) (builtins.attrNames builtins)'
[ "isAttrs" "isBool" "isFloat" "isFunction" "isInt" "isList" "isNull" "isPath" "isString" ]
$ nix eval --expr 'map (f: f 1) [ builtins.isInt builtins.isFloat builtins.isBool builtins.isString builtins.isPath builtins.isNull builtins.isList builtins.isAttrs builtins.isFunction ]'
[ true false false false false false false false false ]
```

九个谓词，对应九种能写出来的类型，对任何值恰好有一个返回 `true`（上一节那个带 `__functor` 的集合，只有 `isAttrs` 说 `true`）。上面那个列出所有 `is*` 的命令用到了 `builtins.match`，那是第 4 篇的正则。写 Firn 的库时我两种都会用：需要分情况的地方用谓词，需要报错信息的地方用 `typeOf`，因为后者可以直接拼进消息。

### builtins 有多少个：116，还是 118

`types.nix` 的最后一行是 `builtinCount`，答案是 118。我第一次是直接在命令行用 `nix eval --expr` 数的，得到 116：

```text
$ nix eval --expr 'builtins.length (builtins.attrNames builtins)'
116
$ nix eval --impure --expr 'builtins.length (builtins.attrNames builtins)'
118
$ nix eval --file lab/ch02/types.nix builtinCount
118
```

差的两个是 `currentSystem` 和 `currentTime`。这两个名字只在非纯求值下存在，纯求值的 `builtins` 里根本没有它们：

```text
$ nix eval --expr 'builtins ? currentSystem'
false
$ nix eval --impure --expr 'builtins.filter (n: !(builtins.hasAttr n (builtins.removeAttrs builtins [ "currentSystem" "currentTime" ]))) (builtins.attrNames builtins)'
[ "currentSystem" "currentTime" ]
```

我在上一篇说过，`nix eval --file` 是非纯的，而这台机器上 `nix config show pure-eval` 是 `true`，`--expr` 因此走纯模式。同一个 `builtins`，两种模式两个大小。这是我见过的最直白的一个例子：纯不纯不是评价代码风格的词，它改变的是当前作用域里有什么。第 4 篇讲纯求值的限制时，这个例子会再用一次。

那 116 个里，有 108 个是函数，另外 8 个不是：

```text
$ nix eval --expr 'let b = builtins; names = b.attrNames b; in { total = b.length names; functions = b.length (b.filter (n: b.isFunction b.${n}) names); others = map (n: "${n}:${b.typeOf b.${n}}") (b.filter (n: !(b.isFunction b.${n})) names); }'
{ functions = 108; others = [ "builtins:set" "false:bool" "langVersion:int" "nixPath:list" "nixVersion:string" "null:null" "storeDir:string" "true:bool" ]; total = 116; }
```

`builtins` 里有一个叫 `builtins` 的属性，指回它自己（这是一个循环结构，第 3 篇的惰性求值让它成立）；`storeDir` 是 `/nix/store`；`nixPath` 就是你熟悉的 `NIX_PATH`，第 9 篇会讲它为什么不纯。这些名字之后会一个个出现。第 4 篇再把 108 个函数按用途分组。

## 整数与浮点：打印出来的不是值

先说整数。手册说 Nix 的整数是 64 位有符号数，非负整数有字面量，**负整数是对正整数取负得到的**。这一句话有一个后果：`-9223372036854775808`（64 位有符号整数的最小值）写不出来，因为 `9223372036854775808` 这个正数字面量本身就超界了：

```text
$ nix eval --expr '9223372036854775808'
error: invalid integer '9223372036854775808'
       at «string»:1:1:
            1| 9223372036854775808
             | ^
$ nix eval --expr '-9223372036854775808'
error: invalid integer '9223372036854775808'
       at «string»:1:2:
            1| -9223372036854775808
             |  ^
```

最小值只能这样写，`lab/ch02/numbers.nix` 里就是这样：

```nix
{
  # ...
  intMax = 9223372036854775807;
  intMin = -9223372036854775807 - 1;
  toJsonFloat = builtins.toJSON 1.0;
}
```

溢出又怎样？`lab/ch02/int_overflow_fail.nix` 只有一行 `9223372036854775807 + 1`。它按设计失败，退出码 1：

```text
$ cat out/ch02/int_overflow_fail.stderr
error:
       … while evaluating the file '/home/bfmhno3/Projects/firn/lab/ch02/int_overflow_fail.nix':

       error: integer overflow in adding 9223372036854775807 + 1
       at /home/bfmhno3/Projects/firn/lab/ch02/int_overflow_fail.nix:2:23:
            1| # Nix 的整数是 64 位有符号数，加法溢出会报错，不会回绕。
            2| 9223372036854775807 + 1
             |                       ^
            3|
```

不回绕，不静默，是一个求值错误。手册的运算符一页把它和除以零并列：这两种情况“throws an evaluation error”。C 里有符号溢出是未定义行为；Rust 对溢出有一整套选择（回绕、饱和、检查），我在 [Pebble 第 1 篇](/posts/rust-by-pebble-01-first-crate/)里一个个跑过。Nix 选了最保守的一种：拒绝继续。对一个主要工作是计算哈希和版本号的语言，我觉得这是对的。

### 浮点：显示精度只有 6 位

浮点数是 64 位 IEEE 754，所以 `0.1 + 0.2` 不等于 `0.3`。下面的结果来自 `numbers.nix` 的前几行（输出是同一个文件）：

```text
$ nix eval --file lab/ch02/numbers.nix
{ floatSum = 0.3; floatSumEq = false; intMax = 9223372036854775807; intMin = -9223372036854775808; toJsonFloat = "1.0"; toStringFrac = "0.500000"; toStringOne = "1.000000"; }
```

`floatSum` 打印 `0.3`，`floatSumEq`（`0.1 + 0.2 == 0.3`）却是 `false`。显示和值不是一回事，这是上一篇 `6` 的同一个故事。再换几个值，就能看出显示用了多少位：

```text
$ nix eval --expr '1.23456789'
1.23457
$ nix eval --expr '123456789.123'
1.23457e+08
$ nix eval --expr 'builtins.toJSON (0.1 + 0.2)'
"0.30000000000000004"
```

显示是 6 位有效数字（看起来是 C 的 `%g` 的默认精度，这是我从输出反推的，没有去读源码），而 `toJSON` 给出完整的 17 位。所以，**想知道一个浮点数真正是多少，用 `toJSON`，不要看打印出来的样子**。

`toString` 更奇怪一点：`toString 1.0` 是 `"1.000000"`，`toString 0.5` 是 `"0.500000"`，固定六位小数。这一点我留作后面的伏笔：第 5 篇写生成配置文件的 `generators.toKeyValue` 时，整数用十进制，字符串原样，我不会让它碰浮点，原因就在这里。想把 `1.0` 变成 `"1"`，先取整：

```text
$ nix eval --expr 'toString (builtins.floor 1.0)'
"1"
```

最后是混合运算：整数和浮点混在一起，结果总是浮点（`builtins.typeOf (1 + 1.0)` 是 `"float"`），而 `1 == 1.0` 是 `true`，下面比较相等的一节会放进同一张表里。

## 字符串：三种写法，一个插值规则

Nix 的字符串有三种写法。最常见的是双引号，其次是两个单引号括起来的“缩进字符串”，第三种是不加引号的 URI，手册的[字符串字面量一页](https://nix.dev/manual/nix/2.34/language/string-literals)把文法列得很清楚：

```text
$ nix eval --expr 'https://example.com/x.tar.gz'
"https://example.com/x.tar.gz"
```

第三种我在本系列里不用，因为它会把看起来像别的东西的文本吞进去。`x:y:x+y` 在你眼里是一个两参数函数，在文法里它是一个 URI（`x:` 是 scheme）：

```text
$ nix eval --expr '{ f = x:y:x+y; }'
{ f = "x:y:x+y"; }
$ nix eval --expr '(x: y: x + y) 1 2'
3
```

冒号后面加了空格才是函数。我是在试 `nixfmt` 的时候撞上它的：我把一份写得很挤的文件交给它，其中的 `f=x:y:x+y` 被它改写成了 `f = "x:y:x+y";`，它比我先发现这是个字符串。下面只讲前两种和它们共用的东西：插值、转义和转换。

### 转义：两套规则，别混

`lab/ch02/strings.nix` 里放了一组转义。下面是其中的片段（文件 38 行，其余是 `toString` 的各种参数，后面再看）：

```nix
# 字符串：插值、'' 缩进剥离、转义、toString、toJSON。
let
  name = "firn";
in
{
  interpolated = "hello ${name}, 1 + 1 = ${toString (1 + 1)}";
  nested = "a${"b${"c"}"}";
  # ...
  escDollar = "cost: \${HOME} stays literal";
  escQuotes = "two single quotes: ''. done";
  escNewline = ''tab:''\tend'';
  plainEscape = "quote \" and backslash \\ and \${not}";
  # ...
}
```

我用 `--json` 输出再用 `jq` 挑字段，因为 Nix 自己打印字符串时会把 `${` 再转义一遍，读起来很费劲，JSON 才是字符串真正的内容：

```text
$ nix eval --json --file lab/ch02/strings.nix | jq -c '{interpolated, nested}'
{"interpolated":"hello firn, 1 + 1 = 2","nested":"abc"}
$ nix eval --json --file lab/ch02/strings.nix | jq -c '{escDollar, escQuotes, escNewline, plainEscape}'
{"escDollar":"cost: ${HOME} stays literal","escQuotes":"two single quotes: ''. done","escNewline":"tab:\tend","plainEscape":"quote \" and backslash \\ and ${not}"}
```

两套规则的对照，全部来自手册，也都被这个文件验证过：

| 想要的字符 | 在 `"…"` 里写 | 在 `''…''` 里写 |
| --- | --- | --- |
| 字面的 `${` | `\${` | `''${` |
| 双引号 | `\"` | 直接写 `"` |
| 反斜杠 | `\\` | 直接写 `\` |
| 两个单引号 | 直接写 `''` | `'''` |
| 制表符、换行 | `\t`、`\n` | `''\t`、`''\n` |
| 字面的 `$${` | 直接写 `$${` | 直接写 `$${` |

规则的一半是对称的：谁的定界符是什么，谁就需要转义什么。第一行最重要，因为你写 shell 脚本的时候一定会遇到它：shell 的 `${HOME}` 要写成 `''${HOME}`，否则 Nix 会把它当成插值，然后报 `undefined variable 'HOME'`。系列的代码风格里也写着同一条：多行 shell 片段用 `''…''`，用 `''${` 转义。错误长这样：

```text
$ nix eval --expr '"echo ${HOME}"' 2>&1 | grep 'error: '
error: undefined variable 'HOME'
```

### 插值接受什么

`"${expr}"` 对 `expr` 只有三种可接受的值，手册的[插值一页](https://nix.dev/manual/nix/2.34/language/string-interpolation)里列得明明白白：字符串、路径、以及带 `__toString` 或 `outPath` 属性的属性集。别的都不行，包括整数。实验 `interpolate_int_fail.nix`（`"${1}"`）和 `string_plus_int_fail.nix`（`"a" + 1`）按设计失败，退出码都是 1，两个文件的最后一段错误是同一句：

```text
$ grep -h 'error:' out/ch02/string_plus_int_fail.stderr out/ch02/interpolate_int_fail.stderr
error:
       error: cannot coerce an integer to a string: 1
error:
       error: cannot coerce an integer to a string: 1
```

（`error:` 那一行是 Nix 的错误头，真正的消息在下一行。）两处错误都被放在 `while evaluating a path segment` 之下，措辞里的 `path segment` 我没有去追，我猜是内部把插值的每一段都叫 segment。我对这件事的态度是：它和 Python 的 `"a" + 1` 一样不做隐式转换（[Sift 第 1 篇](/posts/python-by-sift-01-first-search/)里 Python 在运行到那一行才报 `TypeError`，Nix 也是在求值到那里才报），和 JavaScript 不同。要把整数放进字符串，用 `toString`。

带 `__toString` 或 `outPath` 的属性集可以被插值，也可以被 `toString`。`strings.nix` 里各放了一个：

```nix
  toStringSet = toString { __toString = self: "from __toString"; };
  outPathSet = "${{ outPath = "/nix/store/fake"; }}";
```

```text
$ nix eval --json --file lab/ch02/strings.nix | jq -c '{toStringSet, outPathSet}'
{"toStringSet":"from __toString","outPathSet":"/nix/store/fake"}
```

`outPath` 是整个 Nix 里最重要的一个约定：一个 derivation（第 6 篇）就是一个带 `outPath` 的属性集，所以 `"${pkgs.hello}"` 才能得到 `/nix/store/…-hello-2.12.3`。两者都有的时候谁赢？我试了一下：

```text
$ nix eval --expr 'toString { outPath = "a"; __toString = _: "b"; }'
"b"
```

`__toString` 赢。没有它也没有 `outPath` 的集合直接报错：

```text
$ nix eval --expr '"${{ a = 1; }}"' 2>&1 | grep 'error: '
       error: cannot coerce a set to a string: { a = 1; }
```

### toString：除了字符串以外的转换

`toString` 是把非字符串变成字符串的主要工具。`strings.nix` 把常见的几种放在一起：

```text
$ nix eval --json --file lab/ch02/strings.nix | jq -c '{toStringList, toStringTrue, toStringFalse, toStringNull, toStringInt, toStringFloat}'
{"toStringList":"1 2 3","toStringTrue":"1","toStringFalse":"","toStringNull":"","toStringInt":"42","toStringFloat":"1.500000"}
```

几个值得盯着看的：

- 列表是用空格连接的元素，`[ 1 2 3 ]` 变成 `"1 2 3"`。
- `true` 是 `"1"`，`false` 是 `""`，`null` 也是 `""`。三者里有两个都是空串，所以 `"${toString flag}"` 里你分不清一个 `false` 和一个 `null`；写 shell 脚本的时候，空串和 `"1"` 很方便地对应 `[ -n "$x" ]`，这大概就是它这样设计的原因（我猜的）。
- 浮点是六位小数，上一节说过。
- 路径呢？

```text
$ nix eval --json --file lab/ch02/strings.nix | jq -c '{toStringPath}'
{"toStringPath":"/home/bfmhno3/Projects/firn/lab/ch02"}
```

`toString ./.` 得到的是路径本身的文本，**没有**拷进 store。这和 `"${./.}"` 完全不同，下面讲路径时会专门对比。

### 缩进字符串：剥掉最小缩进

`''…''` 存在的理由很实际：你在 Nix 里嵌一段 shell、一个 systemd 单元或一份配置文件的时候，希望它在 Nix 代码里按 Nix 的缩进写，而结果里不带这些缩进。`strings.nix` 里的例子：

```nix
  indented = ''
    first
      second (indented by 2)
    third
  '';
```

```text
$ nix eval --json --file lab/ch02/strings.nix | jq -c '{indented}'
{"indented":"first\n  second (indented by 2)\nthird\n"}
```

规则是手册写的那样：每一行去掉“整段字符串最小的缩进”（忽略空行），开头 `''` 后面如果只有空白和换行，那一行不算。我换一个缩进不齐的例子验证：

```text
$ nix eval --expr "''
    a
  b
''"
"  a\nb\n"
```

最小缩进是 `b` 的 2 个空格，所以 `a` 保留了 2 个。还有一个细节手册特意放进了警告：**制表符不算缩进**。把一行前面放一个制表符，另一行放四个空格，两行的“缩进”按空格数算是 0 和 4，最小是 0，什么都不剥：

```text
$ printf "''\n\ttabbed\n    spaced\n''" > /tmp/tab.nix && nix eval --file /tmp/tab.nix
"\ttabbed\n    spaced\n"
```

Makefile 的配方必须用制表符，你要在 Nix 里生成 Makefile 就会撞上它，所以手册的示例恰好就是一个 `all:` 目标。

### 常用的字符串内建

`builtins` 里和字符串有关的函数不多，我在这个系列里最常用的是这三个：

```text
$ nix eval --expr 'builtins.concatStringsSep ", " [ "a" "b" "c" ]'
"a, b, c"
$ nix eval --expr 'builtins.replaceStrings [ "-" "_" ] [ "_" "-" ] "a-b_c"'
"a_b-c"
$ nix eval --expr 'builtins.substring 1 3 "firn-lib"'
"irn"
```

`replaceStrings` 的两个列表是一一对应的“找什么、换成什么”，同时替换，所以 `-` 和 `_` 互换才能一次做完（顺序替换的话，第二步会把第一步的结果再换回去）。`substring` 的参数是“起点、长度、字符串”，起点从 0 算。`builtins` 里没有 `hasPrefix`、`splitString` 这些你在别的语言里期待的函数，它们是 nixpkgs 的 `lib` 的活儿，Firn 会在第 4 篇自己写。

### 字符串是字节

还有一个和我的处境有关的事实：手册说 Nix 的字符串是“字节序列加字符串上下文”，“does not assume or support working natively with character encodings”。所以：

```text
$ nix eval --expr 'builtins.stringLength "你好"'
6
```

两个汉字，长度 6。`substring`、`stringLength` 都按字节算，切到汉字中间会得到非法 UTF-8。这个系列里所有字符串都是 ASCII，我没有为此付出代价，但你要在 Nix 里处理中文标题的话，要记住这一点。

## attrset：语法糖比你以为的多

属性集是 Nix 里唯一重要的数据结构：包是属性集，flake 的输出是属性集，NixOS 的配置是一棵巨大的属性集。`lab/ch02/attrsets.nix` 把它的所有语法放进一个文件，每个属性是一个小实验。先看基本操作：

```nix
let
  x = {
    a = 1;
    b = 2;
  };
  # ...
in
{
  # ...
  update = x // {
    b = 20;
    c = 30;
  };
  hasA = x ? a;
  hasZ = x ? z;
  orDefault = x.z or "fallback";
  orNested = x.a.deep.er or "no deeper";
  # ...
}
```

```text
$ nix eval --json --file lab/ch02/attrsets.nix | jq -c '{hasA, hasZ, orDefault, orNested, update}'
{"hasA":true,"hasZ":false,"orDefault":"fallback","orNested":"no deeper","update":{"a":1,"b":20,"c":30}}
```

`x ? a` 问“有没有这个属性”，`x.z or "fallback"` 在没有的时候给默认值。`orNested` 值得多看一眼：`x.a` 是整数 `1`，不是属性集，`.deep.er` 在它上面根本无从谈起，但 `or` 也兜住了这种情况，没有报错。同样的道理，`1 ? a` 不报错，直接是 `false`：

```text
$ nix eval --expr '1 ? a'
false
```

手册的运算符一页给出了优先级：属性选择（`.`）最高，函数调用其次，`?` 排第四，`//` 排第九。这就是为什么 `f x.a` 是 `f (x.a)` 而不是 `(f x).a`。

### 属性是排好序的

这件事在打印里一直都看得见，只是没人说：属性集没有顺序，`builtins.attrNames` 永远按名字排序，打印也是。你在源码里的书写顺序不算数：

```text
$ nix eval --expr 'builtins.attrNames { b = 1; a = 2; c = 3; }'
[ "a" "b" "c" ]
```

所以 `toJSON` 的键也是排序的（后面 JSON 一节的输出里能看到），所以后面凡是要输出“按固定顺序排列”的文本，都不能依赖属性集的书写顺序，要用列表。

### inherit 和动态键

`inherit` 是纯粹的缩写：

```nix
  inheritPlain =
    let
      inherit a;
    in
    {
      inherit a;
    };
  inheritFrom = {
    inherit (x) a b;
  };
```

`inherit a;` 等于 `a = a;`（取外层作用域里的 `a`），`inherit (x) a b;` 等于 `a = x.a; b = x.b;`。`inheritPlain` 里的 `let inherit a; in` 在这里是多余的，我放它只是为了说明 `let` 里面也可以用 `inherit`：两处都从外层作用域取 `a = 10`，结果是 `{ a = 10; }`。风格规则里的 `inherit (lib) x;` 就是这个写法的日常用法。

动态键用 `${…}`，键名在求值时才确定，也可以在字符串里：

```nix
  dynamicKey = {
    ${name} = 1;
    "${name}-2" = 2;
  };
```

```text
$ nix eval --json --file lab/ch02/attrsets.nix | jq -c '{recSet, inheritPlain, inheritFrom, dynamicKey}'
{"recSet":{"p":1,"q":2},"inheritPlain":{"a":10},"inheritFrom":{"a":1,"b":2},"dynamicKey":{"dyn":1,"dyn-2":2}}
```

（`recSet` 是下面要说的 `rec`。）

### a.b.c = 1：嵌套的糖，和一个合并规则

`{ a.b.c = 1; }` 就是 `{ a = { b = { c = 1; }; }; }`。实验 `sugarEqualsNested` 用 `==` 验证了这一点，结果是 `true`。有意思的是同一个字面量里出现多行这样的写法时：

```nix
  sugarMerge = {
    a.b.c = 1;
    a.b.d = 2;
    a.e = 3;
  };
```

```text
$ nix eval --json --file lab/ch02/attrsets.nix | jq -c '{sugar, sugarMerge, sugarEqualsNested}'
{"sugar":{"a":{"b":{"c":1}}},"sugarMerge":{"a":{"b":{"c":1,"d":2},"e":3}},"sugarEqualsNested":true}
```

三行共享前缀 `a`，结果合并成一棵树，没有冲突。我顺手试了两条边界：

```text
$ nix eval --expr '{ a = 1; a = 2; }' 2>&1 | head -1
error: attribute 'a' already defined at «string»:1:3
$ nix eval --expr '{ a.b = 1; a = { c = 2; }; }'
{ a = { b = 1; c = 2; }; }
```

同一个名字赋两次值是错误，但一边是 `a.b = 1`、另一边是 `a = { c = 2; }`（两边都是属性集字面量）会合并。规则大概是这样：同一个字面量里，两处定义如果都是“属性集的内部”，Nix 在解析时把它们并起来；只要有一边是别的东西，就是重复定义（我没有去读解析器，这是从几个例子归纳出来的）。

这个合并只发生在**一个字面量内部**。你在 NixOS 配置里看到的 `services.nginx.enable = true;` 散落在不同文件，靠的是第 15 篇的模块系统，不是这条糖。

### rec 和第一次无限递归

普通属性集里，属性之间互相看不见。`rec` 让它们能互相引用：

```nix
  recSet = rec {
    p = 1;
    q = p + 1;
  };
```

`q` 的结果是 `2`。`rec { … }` 是一个“作用域里包含自己所有属性”的字面量。这给了你一个最小的方式写出死循环：

```text
$ nix eval --expr 'rec { a = a; }.a' 2>&1 | grep -A3 'error: '
       error: infinite recursion encountered
       at «string»:1:11:
            1| rec { a = a; }.a
             |           ^
```

`a = a` 里右边的 `a` 就是这个属性自己，求值它需要先求值它。Nix 没有卡死，而是在第一次走回自己的时候报告 `infinite recursion encountered`。它怎么发现的（一个叫 black-holing 的技巧），以及 `rec` 到底是什么（一个不动点），是第 3 篇的内容，现在我只想让你记住这个错误的样子：以后你在 NixOS 配置里看到它，我猜多半是某个 `config.xxx` 在定义自己。

`rec` 还有一个更隐蔽的坑，没有错误，只有错的结果：

```text
$ nix eval --expr 'let a = 1; in { a = 2; b = a; }'
{ a = 2; b = 1; }
$ nix eval --expr 'let a = 1; in rec { a = 2; b = a; }'
{ a = 2; b = 2; }
```

同一份字面量，加了 `rec`，`b` 从 `1` 变成了 `2`，因为里面的 `a` 现在指向属性集自己的 `a`，而不是外面的 `let`。这就是代码风格规则说“避免 `rec { }`”的原因：用 `let … in` 把依赖写在明处，或者第 10 篇的 `finalAttrs` 模式。

### let 本来就是递归的

顺便说一件和 `rec` 相关的事：`let` 的绑定也可以按任意顺序互相引用，不需要写 `rec`：

```text
$ nix eval --expr 'let a = b; b = c + 1; c = 1; in a'
2
```

`a` 用到 `b`，`b` 用到写在它后面的 `c`，照样求出 `2`。所以更准确的说法是：`let` 是递归的绑定，`rec { }` 是“把递归绑定的名字收进一个属性集”。前面那个 `rec` 的坑，换成 `let` 的写法就不会发生，因为 `let` 里的名字不会混进结果里。`if` 在 Nix 里是表达式，永远有值，所以 `else` 不能省：

```text
$ nix eval --expr 'if true then "yes" else "no"'
"yes"
$ nix eval --expr 'if true then 1' 2>&1 | head -1
error: syntax error, unexpected end of file, expecting 'else'
```

### 属性集的内建函数

属性集上的几个常用操作，`builtins` 里就有，我一次性试了：

```text
$ nix eval --expr 'builtins.attrValues { b = 2; a = 1; }'
[ 1 2 ]
$ nix eval --expr 'builtins.mapAttrs (name: value: "${name}=${toString value}") { x = 1; y = 2; }'
{ x = "x=1"; y = "y=2"; }
$ nix eval --expr 'builtins.listToAttrs [ { name = "a"; value = 1; } { name = "b"; value = 2; } ]'
{ a = 1; b = 2; }
$ nix eval --expr 'builtins.removeAttrs { a = 1; b = 2; c = 3; } [ "a" "c" ]'
{ b = 2; }
$ nix eval --expr 'builtins.intersectAttrs { a = null; c = null; } { a = 1; b = 2; c = 3; }'
{ a = 1; c = 3; }
```

读法：`attrValues` 按**键排序后**的顺序给出值（所以 `b = 2; a = 1;` 得到 `[ 1 2 ]`）；`mapAttrs` 对每个键值对调用一个两参数函数，返回同样键的新集合；`listToAttrs` 吃 `{ name; value; }` 的列表；`removeAttrs` 删键；`intersectAttrs a b` 保留 `b` 里同时也出现在 `a` 里的键。`listToAttrs` 对重名有个值得知道的规则，是先出现的赢：

```text
$ nix eval --expr 'builtins.listToAttrs [ { name = "a"; value = 1; } { name = "a"; value = 2; } ]'
{ a = 1; }
```

`mapAttrs` 是 Firn 的 `recursiveUpdate` 用过的那一个。`intersectAttrs` 配上 `functionArgs`（第 3 篇）是第 7 篇手写 `callPackage` 的全部原料。`builtins` 里没有 `filterAttrs` 和 `genAttrs`，它们是 nixpkgs 的 `lib` 的函数：

```text
$ nix eval --expr '[ (builtins ? mapAttrs) (builtins ? filterAttrs) (builtins ? genAttrs) ]'
[ true false false ]
```

第 5 篇 Firn 自己写它们。属性路径也可以放在 `?` 的右边，一次问一整条路径：

```text
$ nix eval --expr '{ a.b.c = 1; } ? a.b.c'
true
$ nix eval --expr '{ a.b.c = 1; } ? a.x.c'
false
```

这和 `attrByPath` 的“任何一层缺失”是一回事，只不过路径是写死在代码里的，不是一个列表。

### 一个例子：拼一份配置文本

把上面学到的几样东西合起来，我用一行 `--raw` 表达式把一个属性集渲染成 `key = value` 的配置文本（Cairn 的配置文件就是这个格式）：

```text
$ nix eval --raw --expr 'let conf = { repo = "/var/lib/cairn/repo"; keep_last = 5; keep_daily = 7; }; in builtins.concatStringsSep "\n" (builtins.attrValues (builtins.mapAttrs (k: v: "${k} = ${toString v}") conf)) + "\n"'
keep_daily = 7
keep_last = 5
repo = /var/lib/cairn/repo
```

`mapAttrs` 把每一对变成一行，`attrValues` 把它们取成列表，`concatStringsSep` 用换行连起来，末尾补一个换行。这个例子里有三处刚才学过的东西在起作用：整数要 `toString` 才能放进插值，`conf` 的书写顺序是 `repo`、`keep_last`、`keep_daily`，而输出里是 `keep_daily`、`keep_last`、`repo`，因为属性是排好序的。这个排序对一份配置文件常常是无所谓的，但对 diff 和测试不是：以后我要生成“固定顺序”的文本，就不能把顺序托付给属性集。

## `//` 与 recursiveUpdate

`//` 是“更新”运算符：右边覆盖左边。它**只合并最外层**。`lab/ch02/merge_shallow.nix` 做的就是这个对比：

```nix
let
  lib = import ../../lib;
in
{
  shallow = {
    a.b = 1;
  }
  // {
    a.c = 2;
  };
  deep = lib.recursiveUpdate { a.b = 1; } { a.c = 2; };
  rightWins = lib.recursiveUpdate { a.b = 1; } { a.b = 2; };
}
```

```text
$ nix eval --file lab/ch02/merge_shallow.nix
{ deep = { a = { b = 1; c = 2; }; }; rightWins = { a = { b = 2; }; }; shallow = { a = { c = 2; }; }; }
```

`shallow` 把 `a.b` 丢了：左边的 `a` 是 `{ b = 1; }`，右边的 `a` 是 `{ c = 2; }`，`//` 只看到“两边都有 `a`”，于是整个右边的值替换整个左边的值。手册对这个运算符的描述是，两边都只求值到“属性集本身”，属性值不动。`//` 甚至不介意类型变了：

```text
$ nix eval --expr '{ a = 1; } // { a.b = 2; }'
{ a = { b = 2; }; }
```

要保留 `b`，需要递归地合并，也就是 Firn 的第一个真正的函数。这是 `lib/attrsets.nix` 里的 `recursiveUpdate`：

```nix
  # 与 `//` 不同：两边都是属性集的键会递归合并。
  recursiveUpdate =
    lhs: rhs:
    lhs
    // builtins.mapAttrs (
      name: value:
      if builtins.isAttrs value && builtins.isAttrs (lhs.${name} or null) then
        recursiveUpdate lhs.${name} value
      else
        value
    ) rhs;
```

读法：先把整个 `lhs` 作为底，再用 `//` 盖上 `rhs` 的每个键处理后的结果。处理规则是，如果 `rhs` 的这个值是属性集，而且 `lhs` 里同名的值也是属性集（`lhs.${name} or null` 保证没有这个键时得到 `null`，`isAttrs null` 是 `false`），那就递归；否则 `rhs` 的值赢。这决定了列表不会被合并，只会被替换（这是练习 4）。

这个函数在 nixpkgs 里也有，名字一样。我去钉住的那个版本里找了一下，它不是直接写的，而是两层：

```nix
  recursiveUpdate =
    lhs: rhs:
    recursiveUpdateUntil (
      path: lhs: rhs:
      !(isAttrs lhs && isAttrs rhs)
    ) lhs rhs;
```

这是 [`lib/attrsets.nix` 第 1778 到 1783 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/attrsets.nix#L1778-L1783)。它调用的 [`recursiveUpdateUntil`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/attrsets.nix#L1718-L1734) 多接受一个谓词 `pred`，参数是当前的属性路径和两边的值，由调用者决定“在哪里停止递归”；`recursiveUpdate` 只是谓词为“不是两边都是属性集”的特例，也就是我手写的那个规则。nixpkgs 的这个文件有 2282 行，我的有 49 行，但我写的那一个函数和它的特例是同一件事。

## Firn 的第一个库

仓库里 `lib/` 现在有三个文件。入口 `lib/default.nix` 只有 11 行：

```nix
# Firn 自己的库入口，不依赖 nixpkgs。导出子集和扁平的常用函数。
let
  trivial = import ./trivial.nix;
  attrsets = import ./attrsets.nix;
in
{
  version = "0.1.0";
  inherit trivial attrsets;
}
// trivial
// attrsets
```

它把两个子集作为 `lib.trivial`、`lib.attrsets` 导出，再用刚学的 `//` 把它们的函数摊平到顶层，所以 `lib.id` 和 `lib.trivial.id` 是同一个东西。这里 `//` 的“只合并最外层”恰好是够用的：几个文件之间没有重名的键。它不依赖 nixpkgs，只有 `builtins`，这是整个 `lib/` 的设计原则，第 5 篇会专门说它为什么重要。

`lib/trivial.nix` 现在只有三个函数，13 行：

```nix
  # 原样返回参数。
  id = x: x;

  # 忽略第二个参数，总是返回第一个。
  const = x: _: x;

  # 交换二元函数的两个参数。
  flip =
    f: a: b:
    f b a;
```

`const = x: _: x` 里的 `_` 是一个普通的参数名，约定上表示“我不用它”。`flip` 的格式是 `nixfmt` 打印的：多参数函数的参数列表独占一行。

`lib/attrsets.nix` 里有四个函数：`attrByPath`、`hasAttrByPath`、`setAttrByPath` 和上面的 `recursiveUpdate`。看一下 `attrByPath`，它沿着一条路径在嵌套的属性集里取值，任何一层缺失就返回默认值：

```nix
  # 沿 path 取值，任何一层缺失就返回 default。
  attrByPath =
    path: default: set:
    if path == [ ] then
      set
    else if builtins.isAttrs set && builtins.hasAttr (builtins.head path) set then
      attrByPath (builtins.tail path) default set.${builtins.head path}
    else
      default;
```

它每一步取列表的头，递归处理尾巴。注意 `builtins.isAttrs set &&` 这一半：`builtins.hasAttr` 对不是属性集的东西会报错，不会返回 `false`：

```text
$ nix eval --expr 'builtins.hasAttr "a" 1' 2>&1 | grep 'error: '
       error: expected a set but found an integer: 1
```

nixpkgs 的 [`attrByPath`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/attrsets.nix#L88-L106) 不一样：它用列表下标 `n` 往前走，判断用的是 `s ? ${attr}`，所以不需要先问 `isAttrs`，因为上面我们看到 `1 ? a` 是 `false`。这是同一件事的两种写法，我的练习答案 `lab/ch02/ex_deep_get.nix` 用的就是后一种。

另外两个函数是同一个递归模式的变体。`hasAttrByPath` 只问“这条路径存在吗”，不取值：

```nix
  hasAttrByPath =
    path: set:
    if path == [ ] then
      true
    else
      builtins.isAttrs set
      && builtins.hasAttr (builtins.head path) set
      && hasAttrByPath (builtins.tail path) set.${builtins.head path};
```

三个条件用 `&&` 串起来，而 `&&` 是短路的（手册说它只在左边为 `true` 时才求值右边），所以 `set` 不是属性集的时候，`builtins.hasAttr` 根本没有机会报错。末尾的 `set.${builtins.head path}` 也是同一回事：它只在前两个条件成立之后才会被求值。路径存在但值是 `null` 的情形算存在（测试里有这一条）：

```text
$ nix eval --impure --expr '(import ./lib).hasAttrByPath [ "a" "b" ] { a = "s"; }'
false
$ nix eval --impure --expr '(import ./lib).hasAttrByPath [ "a" "b" ] { a.b = null; }'
true
```

`setAttrByPath` 反过来，从路径造出嵌套的属性集，靠的是前面讲的动态键：

```nix
  setAttrByPath =
    path: value:
    if path == [ ] then
      value
    else
      { ${builtins.head path} = setAttrByPath (builtins.tail path) value; };
```

```text
$ nix eval --impure --expr '(import ./lib).setAttrByPath [ "a" "b" "c" ] 1'
{ a = { b = { c = 1; }; }; }
```

它和 `a.b.c = 1` 那条糖做的事一样，区别是路径这次是一个运行时的列表，不是写死在源码里的。这三个函数两两互相验证：`setAttrByPath` 造出来的东西，`hasAttrByPath` 和 `attrByPath` 都应当能找到，这类“往返”性质第 5 篇写更多用例时我会用得很多。

`lib/` 的版本是 `0.1.0`，`version` 是一个字符串属性：`lib.version`。

### 格式交给 nixfmt

上面所有的 Nix 代码，包括仓库里的文件和我在文章里贴的片段，都是 `nixfmt` 打印出来的，我从来不手工对齐。我把一份写得很挤的文件交给它，看它做了什么：

```text
$ cat /tmp/ugly.nix
{a=1;b={c=2;d=[1 2 3];};f=x: y: x+y;s="hello";l=[(1+2) 4];}
$ nixfmt --check /tmp/ugly.nix; echo "rc=$?"
/tmp/ugly.nix: not formatted
rc=1
$ nixfmt /tmp/ugly.nix && cat /tmp/ugly.nix
{
  a = 1;
  b = {
    c = 2;
    d = [
      1
      2
      3
    ];
  };
  f = x: y: x + y;
  s = "hello";
  l = [
    (1 + 2)
    4
  ];
}
$ nixfmt --check /tmp/ugly.nix; echo "rc=$?"
rc=0
```

两点值得注意。其一，`nixfmt` 把三个数字的列表拆成一行一个，`[ 1 2 3 ]` 变成 5 行（它拆与不拆的完整规则我没有去核对：`tests/lib.nix` 里 `[ "a" "b" ]` 这样的两个字符串就留在一行）。这就是为什么你读到的 Nix 代码常常又瘦又长，也是为什么 `lab/ch02/lists.nix` 里的 `xs` 占了 6 行。其二，只要还有语法错误，`nixfmt` 就拒绝格式化，并且指给你看位置：我第一次写的例子里有一个 `[(1+2) -3]`，它被报成 `unexpected '-'`，我猜是因为 `(1+2) -3` 在列表里被读成了减法的开头，而不是两个元素；`nix eval` 对同一份文件报的是同一个位置的 `syntax error, unexpected '-'`。`make lint` 里的第一条命令就是 `nixfmt --check`，所以仓库里每一个 `.nix` 文件在每一个标签上都是这个样子。

## 第一个测试：20 个用例

库要有测试。第 5 篇会用 nixpkgs 的 `runTests` 重写，这一版是最小的：`tests/lib.nix` 是一个文件，求值出来是**失败用例的列表**，空列表 `[ ]` 表示全部通过：

```text
$ nix eval --file tests/lib.nix
[ ]
```

结构只有两段。第一段是用例表，每个用例是 `{ expr; expected; }`，名字是属性名：

```nix
let
  lib = import ../lib;
  cases = {
    id = {
      expr = lib.id 3;
      expected = 3;
    };
    # ...
    attrByPathMiss = {
      expr = lib.attrByPath [ "a" "x" ] 0 { a.b = 5; };
      expected = 0;
    };
    # ...
  };
```

第二段把用例变成失败列表：

```nix
  failed = builtins.filter (t: t.expr != t.expected) (
    builtins.attrValues (builtins.mapAttrs (name: t: t // { inherit name; }) cases)
  );
in
failed
```

读法从里往外：`mapAttrs` 给每个用例补上 `name`（`t // { inherit name; }`），`attrValues` 把属性集变成列表，`filter` 留下 `expr != expected` 的。`!=` 是深度比较，列表和属性集都可以直接比（下面“相等”一节会验证）。用例的数量：

```text
$ grep -c '^    [A-Za-z]* = {$' tests/lib.nix
20
```

20 个：`id`、`const`、`flip`，`attrByPath` 的命中、缺失、穿过非属性集、空路径，`hasAttrByPath` 的三种，`setAttrByPath` 的两种，`recursiveUpdate` 的 5 种，`version`，一个“扁平与子集是同一个”的用例，和下面要说的 `const` 那一个。

测试得会失败才有价值。我把 `attrByPathMiss` 的期望从 `0` 改成 `1`（我是在仓库的一份拷贝里做的；你在自己的 `~/firn` 里试的话，之后用 `git checkout tests/lib.nix` 恢复）：

```text
$ sed -i 's/expected = 0;/expected = 1;/' tests/lib.nix && nix eval --file tests/lib.nix
[ { expected = 1; expr = 0; name = "attrByPathMiss"; } ]
```

失败的用例带着它的名字、实际值和期望值回来。它也有局限，我也试了：把第一个用例的 `expr` 换成 `throw "boom"`，整个求值直接报错，得不到一份列表：

```text
$ nix eval --file tests/lib.nix 2>&1 | grep 'error: '
       error: boom
```

用例里的 `throw` 没有被拦住，所有人都看不到别的用例的结果。第 3 篇的 `tryEval` 就是对付这个的。

最后一个用例的写法有点调皮：

```nix
    constIgnoresSecond = {
      expr = lib.const "x" (throw "never forced");
      expected = "x";
    };
```

`throw` 作为第二个参数传进了 `const`，而 `const` 从不看它，所以这个用例通过。传进去一个会炸的表达式，没有炸，这是惰性求值，第 3 篇的主题。

## 列表：空格分隔，元素可以是任何东西

列表用方括号，元素之间只用空白分隔，没有逗号。`lab/ch02/lists.nix` 把常用的操作放在一起：

```nix
let
  xs = [
    10
    20
    30
    40
  ];
in
{
  concat = xs ++ [ 50 ];
  second = builtins.elemAt xs 1;
  first = builtins.head xs;
  rest = builtins.tail xs;
  doubled = map (n: n * 2) xs;
  big = builtins.filter (n: n > 20) xs;
  squares = builtins.genList (i: i * i) 6;
  len = builtins.length xs;
  # ...
}
```

```text
$ nix eval --file lab/ch02/lists.nix
{ big = [ 30 40 ]; concat = [ 10 20 30 40 50 ]; doubled = [ 20 40 60 80 ]; first = 10; len = 4; mixed = [ 1 "two" 3 null [ ] { } ]; rest = [ 20 30 40 ]; second = 20; squares = [ 0 1 4 9 16 25 ]; }
```

几件事：

- `elemAt` 的下标从 0 开始，所以 `elemAt xs 1` 是 `20`。越界和对空列表取 `head` 都是求值错误，不会返回 `null`：

  ```text
  $ nix eval --expr 'builtins.head [ ]' 2>&1 | grep 'error: '
         error: 'builtins.head' called on an empty list
  $ nix eval --expr 'builtins.elemAt [ 1 2 ] 5' 2>&1 | grep 'error: '
         error: 'builtins.elemAt' called with index 5 on a list of size 2
  ```

- `map` 没有 `builtins.` 前缀，`toString`、`import`、`throw` 这几个也没有，它们是少数在全局作用域里有别名的内建函数。其他的（比如 `filter`、`head`）要写全。
- `mixed` 是一个混合类型的列表：整数、字符串、浮点、`null`、空列表、空属性集。它里面的 `3.0` 被打印成 `3`，又是显示精度的老戏法。
- 列表元素之间用空白分隔，这带来一个新手的经典坑：函数调用也是空白，所以列表里的调用必须加括号。手册在运算符一页专门放了一条警告。这个实验我顺手做了：

  ```text
  $ nix eval --expr 'builtins.length [ builtins.head [ 1 ] ]'
  2
  ```

  `[ builtins.head [ 1 ] ]` 是**两个**元素：函数 `builtins.head` 和列表 `[ 1 ]`，不是一个调用的结果。写成 `[ (builtins.head [ 1 ]) ]` 才是一个元素。

还有几个我常用的：

```text
$ nix eval --expr 'builtins.concatLists [ [ 1 ] [ 2 3 ] ]'
[ 1 2 3 ]
$ nix eval --expr 'builtins.sort (a: b: a < b) [ 3 1 2 ]'
[ 1 2 3 ]
$ nix eval --expr 'builtins.elem 2 [ 1 2 3 ]'
true
$ nix eval --expr 'builtins.any (x: x > 2) [ 1 2 3 ]'
true
$ nix eval --expr "builtins.foldl' (a: b: a + b) 0 [ 1 2 3 4 ]"
10
```

`sort` 的第一个参数是“a 是否应该排在 b 前面”的谓词。最后那个 `foldl'` 末尾的撇号不是笔误，它是一个严格的左折叠，第 5 篇我会量它和朴素递归在栈、thunk 和时间上的差别。

列表的内建操作就这些。第 5 篇我会写 `range`、`unique`、`flatten` 这些 nixpkgs 的 `lib` 里的列表函数，到时候会用到递归，会遇到 Nix 求值器的栈。

## 路径：一个不是字符串的类型

路径是我以前最不当回事的一种值。我一直把 `./foo` 当作“带点的字符串”，实验证明它不是。

### 路径字面量

`./fixtures/note.txt` 是一个路径值，不是字符串。它**相对于所在文件的目录**解析，不相对于你运行命令时的当前目录。`lab/ch02/paths.nix` 的开头：

```nix
# 路径是一等类型：相对路径按所在文件的目录解析，插值时被复制进 store。
{
  relative = ./fixtures/note.txt;
  type = builtins.typeOf ./fixtures/note.txt;
  appended = ./. + "/fixtures";
  dirOfThisFile = toString ./.;
  exists = builtins.pathExists ./fixtures/note.txt;
  content = builtins.readFile ./fixtures/note.txt;
  # ...
}
```

我从两个不同的目录读它的 `relative`，结果是同一个绝对路径：

```text
$ (cd /tmp && nix eval --file ~/Projects/firn/lab/ch02/paths.nix relative)
/home/bfmhno3/Projects/firn/lab/ch02/fixtures/note.txt
$ (cd ~/Projects/firn/lab && nix eval --file ch02/paths.nix relative)
/home/bfmhno3/Projects/firn/lab/ch02/fixtures/note.txt
```

整个文件的输出（一行，排好序）：

```text
$ nix eval --file lab/ch02/paths.nix
{ appended = /home/bfmhno3/Projects/firn/lab/ch02/fixtures; content = "firn note\n"; dirOfThisFile = "/home/bfmhno3/Projects/firn/lab/ch02"; exists = true; interpolated = "/nix/store/bnms6f4g2pjk31qq96cs11hfb38c49a8-note.txt"; plainString = "string"; relative = /home/bfmhno3/Projects/firn/lab/ch02/fixtures/note.txt; stringIsNotPath = "string"; type = "path"; }
```

注意输出里 `relative` 和 `appended` 没有引号（它们是路径），`dirOfThisFile` 和 `interpolated` 有引号（它们是字符串）。`./. + "/fixtures"` 是路径加字符串，结果仍然是路径；反过来，字符串加路径的结果是字符串，而且手册明确说那个路径“is copied to the store”。运算符一页里 `+` 有五种重载：字符串加字符串，路径加路径，路径加字符串，字符串加路径，数值加数值。

路径也有它自己的几个小工具，操作的是路径的文本，不碰文件系统：

```text
$ nix eval --expr 'builtins.baseNameOf /tmp/a/b.txt'
"b.txt"
$ nix eval --expr 'builtins.dirOf /tmp/a/b.txt'
/tmp/a
```

`baseNameOf` 返回字符串，`dirOf` 对路径返回路径。路径和字符串即使文本一样也不是同一个东西，`typeOf` 和 `==` 都会告诉你：

```text
$ nix eval --file lab/ch02/equality.nix | tr ';' '\n' | grep stringPath
 stringPath = false
```

`"/tmp" == /tmp` 是 `false`，`builtins.isString ./.` 也是 `false`。

### 插值：路径被拷进 store

重点在 `interpolated = "${./fixtures/note.txt}"` 这一行。结果是 `/nix/store/bnms6f4g2pjk31qq96cs11hfb38c49a8-note.txt`，一个**字符串**（`stringIsNotPath` 是 `"string"`）。手册说得明白：路径在被插值的时候会先拷贝进 Nix store，字符串里是新对象的 store 路径。这是我这一篇里最想让你看到的一件事，所以我检查了那个 store 里的文件：

```text
$ cat /nix/store/bnms6f4g2pjk31qq96cs11hfb38c49a8-note.txt
firn note
$ stat -c '%a %U %n' /nix/store/bnms6f4g2pjk31qq96cs11hfb38c49a8-note.txt
444 root /nix/store/bnms6f4g2pjk31qq96cs11hfb38c49a8-note.txt
```

文件在 store 里，属于 root，权限 `444`，只读。你在源码里写的是 `./fixtures/note.txt`，而被写进构建脚本、配置文件、systemd 单元的永远是 `/nix/store/…` 开头的那个。原因要到第 6 篇才会完整：构建在沙箱里进行，沙箱看不到你的 `/home`，只看得到 store 里它声明过的东西，所以每个文件在被引用之前都必须先进 store。

一个比喻，只用这一次。路径值像是你写在便条上的家庭住址，插值像是把东西送进银行保管箱，再把箱号抄在信里。这里的箱号还有个特别的性质：它是由箱子里的东西决定的。

我用 `path_copy.sh` 验证这个性质。它在沙箱里写一个 `note.txt`，取插值后的 store 路径，改一个字节，再取一次，再改回去，复制成另一个文件名，第三次取路径：

```bash
cd "${LAB_TMP}"
printf 'firn note\n' >note.txt
before="$(store_path "${EXPR}")"
printf 'firn Note\n' >note.txt
after="$(store_path "${EXPR}")"
printf 'firn note\n' >note.txt
cp note.txt other-name.txt
renamed="$(store_path "${OTHER}")"
```

（`store_path` 是脚本里的函数，用 `nix eval --impure --raw --expr` 对 `"${./note.txt}"` 求值，`--impure` 是必需的，下面解释。）

```text
$ cat out/ch02/path_copy.stdout
before  /nix/store/bnms6f4g2pjk31qq96cs11hfb38c49a8-note.txt
after   /nix/store/r95g5q1jwfwvg3gw4phv4shj93r4gcv0-note.txt
renamed /nix/store/p2cf733k60cby4vxlxsmxsf2x3q629vs-other-name.txt
one byte changed: hash part differs
same content, other name, hash part: /nix/store/bnms6f4g2pjk31qq96cs11hfb38c49a8 vs /nix/store/p2cf733k60cby4vxlxsmxsf2x3q629vs
```

`firn note` 改成 `firn Note`（一个字节，`n` 到 `N`），32 个字符的哈希里逐位比较：只有 2 个位置碰巧相同，剩下 30 个都变了。名字（`-note.txt`）没变。第三行更说明问题：内容和第一次完全一样，只是换了文件名，哈希部分也换了，因为文件名同样是哈希的输入（[store 路径的格式](https://nix.dev/manual/nix/2.34/protocols/store-path)是第 6 篇我自己动手算的内容）。

这个 `--impure` 是有原因的。这台机器上纯求值默认开着，`nix eval --expr` 因此不允许读取求值之外的绝对路径：

```text
$ nix eval --expr '"${./lab/ch02/fixtures/note.txt}"' 2>&1 | grep 'error: '
error: access to absolute path '/home/bfmhno3/Projects/firn/lab/ch02/fixtures/note.txt' is forbidden in pure evaluation mode (use '--impure' to override)
```

`nix eval --file` 则不受此限，因为它是非纯的（第 1 篇的运行器就是靠这个跑 `.nix` 实验的）。flake 里的相对路径又是另一套规则，第 8 篇会说。

最后是一个陷阱，也是 `toString` 一节我埋下的。**`toString ./x` 不会拷进 store，`"${./x}"` 会：**

```text
$ nix eval --impure --expr '"${./lab/ch02/fixtures/note.txt}" == toString ./lab/ch02/fixtures/note.txt'
false
```

一个得到 `/nix/store/…-note.txt`，一个得到 `/home/…/note.txt`，当然不相等。后者把你自己机器上的绝对路径写进了结果，构建出来的东西不能在别人的机器上复现，是最常见的“在我这里能用”的来源之一（这是我的判断，没有统计）。还有一个更大的陷阱：目录也能被插值，然后**整个目录**被拷进去。我拿 `lab/ch02` 试：

```text
$ p=$(nix eval --impure --raw --expr '"${./lab/ch02}"'); echo "$p"
/nix/store/qr0h868rsi8xc4xdz9m7fyvpawkcc134-ch02
$ ls "$p" | wc -l
17
$ du -sb "$p" lab/ch02
7803	/nix/store/qr0h868rsi8xc4xdz9m7fyvpawkcc134-ch02
7803	lab/ch02
```

17 个条目，7803 字节，和源目录一模一样：16 个实验加一个 `fixtures/`。它这次小，是因为 `lab/ch02` 小。如果你写的是 `"${./.}"`，被拷进 store 的是整个仓库，包括你的 `.git` 和 `out/`，而且任何一个无关文件改了一个字节，这个路径的哈希都会变，所有依赖它的东西都要重建。怎样只拷需要的文件：`cleanSource` 在第 4 篇、`lib.fileset` 在第 10 篇处理。

## 相等与比较

`==` 在 Nix 里比你预期的聪明，也比你预期的怪。`lab/ch02/equality.nix` 把十个情形放进一个属性集：

```text
$ nix eval --file lab/ch02/equality.nix
{ differentTypes = false; intFloat = true; keyOrderIrrelevant = true; lambdas = false; listOrderMatters = false; listsEqual = true; nullEq = true; sameLambda = false; setsEqual = true; stringPath = false; }
```

先把十个结果和它们对应的表达式对齐（表达式取自 `equality.nix`，我把大括号和换行压缩了）：

| 键 | 表达式 | 结果 |
| --- | --- | --- |
| `setsEqual` | `{ a = [ 1 { b = 2; } ]; } == { a = [ 1 { b = 2; } ]; }` | `true` |
| `keyOrderIrrelevant` | `{ a = 1; b = 2; } == { b = 2; a = 1; }` | `true` |
| `listsEqual` | `[ 1 2 [ 3 ] ] == [ 1 2 [ 3 ] ]` | `true` |
| `listOrderMatters` | `[ 1 2 ] == [ 2 1 ]` | `false` |
| `lambdas` | `(x: x) == (x: x)` | `false` |
| `sameLambda` | `let f = x: x; in f == f` | `false` |
| `intFloat` | `1 == 1.0` | `true` |
| `stringPath` | `"/tmp" == /tmp` | `false` |
| `nullEq` | `null == null` | `true` |
| `differentTypes` | `1 == "1"` | `false` |

逐条读：

- 属性集和列表是**深度**比较（`setsEqual`、`listsEqual`）。属性集的键序无所谓（`keyOrderIrrelevant`），反正属性集本来就是排序的；列表的顺序有所谓（`listOrderMatters` 是 `false`）。手册说属性集先比属性名，再比值，列表先比长度，再比元素。
- 不同类型比较是 `false`，不会报错（`differentTypes`，`1 == "1"`）。`"/tmp" == /tmp` 同理。
- `1 == 1.0` 是 `true`（`intFloat`）：数值跨类型比较的时候按数值算。
- 两个函数（`(x: x) == (x: x)`）永远是 `false`，因为函数相等是不可判定的，Nix 不去判断。

而最后一个怪事，实验里 `sameLambda` 是 `false`：把一个函数绑定给 `f`，再比 `f == f`，仍然是 `false`。但是放进列表里：

```text
$ nix eval --expr 'let f = x: x; in [ f ] == [ f ]'
true
```

`[ f ] == [ f ]` 是 `true`。手册在“Value identity optimization”一段里把这件事承认了：Nix 在比较嵌套值的时候先比指针，指针相同就判相等，这样做更快，还让循环结构（`let x = { x = x; }; in x == x`）可以比较；代价是“a function equal to itself when the comparison is made in a list or attribute set, in contradiction to a simple direct comparison”。手册管这个叫“有争议的好处”（disputable benefit），我同意这个措辞。结论是：永远不要依赖函数的相等。

大小比较 `<`、`>` 对数值是算术，对字符串和路径是字典序，对列表是逐项的字典序：

```text
$ nix eval --expr '[ 1 2 ] < [ 1 3 ]'
true
$ nix eval --expr '1 < "a"' 2>&1 | grep 'error: '
       error: cannot compare an integer with a string; values are 1 and "a"
```

有意思的不对称：`==` 对类型不同的值给 `false`，`<` 给错误。

## with：名字从哪里来

`with 集合; 表达式` 把集合的所有属性放进表达式的作用域。看上去很方便，所以我读到的很多 Nix（包括我自己 NixOS 配置里的一些）到处都是 `with pkgs;`。`lab/ch02/with_scope.nix` 做的是一个对照实验：

```nix
let
  x = "let";
in
{
  letBeatsWith = with { x = "with"; }; x;
  innerWins = with { y = "outer"; }; with { y = "inner"; }; y;
  outerStillVisible = with { p = "p-outer"; }; with { q = "q-inner"; }; "${p} ${q}";
  # BAD: 文件级 with 让读者无法知道名字从哪里来；风格规则禁止。
  silentShadow = with { x = "with"; }; x;
}
```

```text
$ nix eval --file lab/ch02/with_scope.nix
{ innerWins = "inner"; letBeatsWith = "let"; outerStillVisible = "p-outer q-inner"; silentShadow = "let"; }
```

规则来自手册的[作用域一页](https://nix.dev/manual/nix/2.34/language/scope)：`let`、`rec` 属性集和函数参数创建**显式**定义，`with` 创建**隐式**定义；显式定义可以替换任何类型的定义，隐式定义只能替换另一个隐式定义。落到实验上：

- `letBeatsWith`：`let` 的 `x` 赢过 `with` 里的 `x`，不管 `with` 离使用处多近。
- `innerWins`：两个 `with` 都提供 `y`，里面的赢。
- `outerStillVisible`：两个 `with` 提供不同的名字，两个都可见。
- `silentShadow`：我故意写错的例子。你读这一行，看见 `with { x = "with"; }; x`，会以为结果是 `"with"`，实际是 `"let"`。因为作用域里还有一个外层的 `let x`，它悄悄地赢了。

这就是系列的风格规则禁止文件级 `with` 的原因：**你读到一个名字，无法判断它从哪来**。名字可能来自 `with` 的集合，也可能来自外层的 `let` 或参数，而且上游往集合里添加一个新属性，就可能悄悄换掉你以为在用的那个。规则只留了一个例外：`with pkgs;` 直接放在包列表的前面，比如 `packages = with pkgs; [ jq git ];`，因为那里的作用域只覆盖一个简单列表，不会和别的名字混。

`with` 还有一个不那么戏剧的毛病：名字找不到的时候，错误和没有 `with` 的时候一样，只是告诉你变量没定义：

```text
$ nix eval --expr 'with { }; y' 2>&1 | grep 'error: '
error: undefined variable 'y'
```

它不会告诉你“我在哪个集合里找过”。

这个实验文件带着 `# BAD` 标记，是系列约定的一部分：故意违反风格规则的代码要明说。`make lint` 对 `lab/` 里的文件不跑 `statix` 和 `deadnix`，但 `nixfmt` 还是照样检查。

## Nix 是“JSON 加函数”吗

人们常这么说。我用 `lab/ch02/json_roundtrip.nix` 验证这句话对到什么程度。先是对应关系：

| JSON | Nix | 往返之后 |
| --- | --- | --- |
| object | attrset | 键按名字排序 |
| array | list | 原样 |
| string | string | 原样（带“上下文”的字符串留到第 4 篇） |
| number | int 或 float | `1` 和 `1.0` 分得清 |
| true、false | bool | 原样 |
| null | null | 原样 |
| 无 | path、function | 路径变成字符串，函数报错 |

对纯数据，来回一趟是 `true`：

```text
$ nix eval --json --file lab/ch02/json_roundtrip.nix | jq -c '{roundtrip, pathJsonHasContext, pathJsonIsString}'
{"roundtrip":true,"pathJsonHasContext":true,"pathJsonIsString":"string"}
$ nix eval --json --file lab/ch02/json_roundtrip.nix | jq -r '.json'
{"b":true,"f":1.5,"l":[1,[2],{"k":"v"}],"n":1,"nested":{"deep":{"er":[]}},"s":"text","z":null}
```

键是排序的（`b`、`f`、`l`、`n`、`nested`、`s`、`z`），不是书写顺序。数字里 `1` 和 `1.0` 是分开的：

```text
$ nix eval --expr 'map builtins.typeOf (builtins.fromJSON "[1, 1.0, 1e2]")'
[ "int" "float" "float" ]
```

JSON 里没有的两样东西是实验的另一半。路径会被 `toJSON` 先拷进 store 再变成字符串（这和插值是同一个规则），所以往返之后你得到的是 store 路径，不是路径：

```text
$ nix eval --json --file lab/ch02/json_roundtrip.nix | jq -r '.pathJson'
"/nix/store/bnms6f4g2pjk31qq96cs11hfb38c49a8-note.txt"
```

带 `outPath` 的属性集被折叠成它的 `outPath` 字符串，其他的键直接消失：

```text
$ nix eval --json --file lab/ch02/json_roundtrip.nix | jq -r '.outPathCollapses'
"/nix/store/x"
```

函数干脆不能序列化。`json_lambda_fail.nix`（`builtins.toJSON { f = x: x; }`）按设计失败，最后一段错误是：

```text
$ grep 'error: ' out/ch02/json_lambda_fail.stderr
       error: cannot convert a function to JSON
```

所以这句话对了一半：数据的一半确实是 JSON，而且 Nix 把 JSON 当成它的通用交换格式（`fromJSON`、`toJSON`、第 4 篇的 `fromTOML`）。可是 Nix 还多出路径、函数，带上下文的字符串，以及惰性，这一半往返丢掉的东西，正是 Nix 之所以不只是配置语言的原因。

这一章里每一条断言，我都回到手册的这五页核对过：[数据类型](https://nix.dev/manual/nix/2.34/language/types)、[字符串字面量](https://nix.dev/manual/nix/2.34/language/string-literals)、[字符串插值](https://nix.dev/manual/nix/2.34/language/string-interpolation)、[运算符](https://nix.dev/manual/nix/2.34/language/operators)和[作用域](https://nix.dev/manual/nix/2.34/language/scope)。我估计它们加起来不到一个小时的阅读量，写得比我印象中的 Nix 文档好得多，值得你自己通读一遍，再回来对照上面的实验。

## 读错误信息：三种常见的形状

这一篇的实验里有四个故意失败的文件，我自己手敲时又撞到了一些别的错误。把它们放在一起，你会发现 Nix 的求值错误其实只有几种形状，认得出形状比记住每一句话有用。

**属性不存在。** 对象是 `{ a = 1; }.b`：

```text
$ nix eval --expr '{ a = 1; }.b' 2>&1 | head -5
error: attribute 'b' missing
       at «string»:1:1:
            1| { a = 1; }.b
             | ^
       Did you mean a?
```

注意最后一行：Nix 会对拼写相近的键给出提示。

**变量没有定义。** 前面看过的 `"echo ${HOME}"` 和 `with { }; y` 都是这种，消息固定是 `undefined variable 'x'`，位置指向用到它的地方。

**类型不对。** 这是最多的一种，消息的句式是“expected X but found Y”或者“cannot coerce X to a string”：

```text
$ nix eval --expr 'if 1 then 2 else 3' 2>&1 | grep 'error: '
       error: expected a Boolean but found an integer: 1
$ nix eval --expr 'builtins.hasAttr "a" 1' 2>&1 | grep 'error: '
       error: expected a set but found an integer: 1
```

另外两类（`cannot coerce`、`cannot compare`）前面已经出现过。它们的共同点是 Nix 在**运行到那里**才发现错，不像编译型语言在编译期拦住（第 1 篇对比过 Rust 和 Python）。所以一个类型错误会在“恰好被求值到的那一刻”才出现，离写错的地方可能很远。这是第 3 篇惰性求值的直接后果，也是第 5 篇要用 `--show-trace` 去追调用链的原因。

我的习惯是：看到错误，先看“形状”（缺属性、没定义、类型错），再看最内层的那一行 `error:`，最后才去看它上面那一串 `while evaluating…`。那一串是调用栈，告诉你是怎么走到这里的，但真相通常就在最下面那一句。

## 让我意外的事

写这一篇之前，我以为“值与类型”是语言里最乏味的一章：十种类型，背一遍就行。结果有四件事我没有料到，它们分别和纯度、显示、相等、路径有关，没有一件是语法。

**`builtins` 有多大，取决于你纯不纯。** 我数出 116，实验文件数出 118，我一度以为自己数错了，或者 `nix eval --file` 的行为不同。差的两个是 `currentSystem` 和 `currentTime`，它们只在非纯求值里存在。我原来把“纯”理解为“一个影响缓存的开关”，现在我知道它首先是一个**改变作用域内容**的开关：同一个名字，在一个模式里是值，在另一个模式里是 `attribute 'currentSystem' missing`。写出的 Nix 代码里只要出现 `builtins.currentSystem`，它的含义就已经被限定在非纯模式了，这是系列风格规则禁止它的另一层理由。

**打印出来的又一次不是值。** 第二次了。`0.1 + 0.2` 打印 `0.3`，却不等于 `0.3`，因为打印只给 6 位有效数字；`toString 1.0` 是 `"1.000000"`，`toString 1.5` 是 `"1.500000"`。我现在的习惯是：想知道一个浮点数到底是多少，永远用 `builtins.toJSON`，它给的是 17 位。显示的精度比值的精度低得多，在一门以“结果可复现”为卖点的语言里，这算不上缺陷，但值得先知道。

**函数和自己比，直接比是 `false`，放进列表比是 `true`。** `let f = x: x; in f == f` 是 `false`，`[ f ] == [ f ]` 是 `true`。手册承认这是为了比较速度和循环结构做的优化的副作用，并称它为“有争议的好处”。我没有预期会在手册里读到“disputable”这个词，也没有预期一门函数式语言的相等性在函数上有两个答案。

**`toString ./x` 和 `"${./x}"` 的差别比我想象的大。** 我原来把它们当作同一件事的两种写法。一个只是把路径变成文本，一个把文件拷进 store 再给你 store 路径。前者造出来的字符串里有我机器上的 `/home/…`，后者没有。这是这一篇的实验里最实用的一个发现，也是你在 NixOS 配置里经常看到 `"${./foo}"` 的原因：它不是装饰，是在把文件交给构建。

## 检查点

在 `~/firn` 里，`nix develop` 之内：

```bash
make ch02
make lint
for f in lib/default.nix lib/trivial.nix lib/attrsets.nix tests/lib.nix \
  lab/ch02/*.nix lab/ch02/*.sh lab/ch02/fixtures/note.txt; do
  diff <(git -C ~/firn-ref show ch02:"${f}") "${f}" && echo "same ${f}"
done
```

`make ch02` 应当打印这 17 行（命令回显加 16 行 `ok`；这一章没有 `_host` 实验，所以设不设 `CI` 都一样）：

```text
bash scripts/chapter.sh ch02
ok   lab/ch02/attrsets.nix
ok   lab/ch02/equality.nix
ok   lab/ch02/ex_deep_get.nix
ok   lab/ch02/int_overflow_fail.nix
ok   lab/ch02/interpolate_int_fail.nix
ok   lab/ch02/json_lambda_fail.nix
ok   lab/ch02/json_roundtrip.nix
ok   lab/ch02/lists.nix
ok   lab/ch02/merge_shallow.nix
ok   lab/ch02/numbers.nix
ok   lab/ch02/path_copy.sh
ok   lab/ch02/paths.nix
ok   lab/ch02/string_plus_int_fail.nix
ok   lab/ch02/strings.nix
ok   lab/ch02/types.nix
ok   lab/ch02/with_scope.nix
```

`int_overflow_fail`、`interpolate_int_fail`、`json_lambda_fail`、`string_plus_int_fail` 这四个文件名以 `_fail` 结尾，运行器要求它们以非零状态退出，所以也是 `ok`。`make lint` 只回显它跑的四条命令（`nixfmt --check`、`deadnix --fail`、`shellcheck`、`shfmt`，`statix` 那一行以 `@` 开头，make 不回显它），没有任何诊断，退出码 0。`nix eval --file tests/lib.nix` 应当打印 `[ ]`。

`diff` 循环应当打印 21 行 `same ...`，不打印 diff：

```text
same lib/default.nix
same lib/trivial.nix
same lib/attrsets.nix
same tests/lib.nix
same lab/ch02/attrsets.nix
same lab/ch02/equality.nix
same lab/ch02/ex_deep_get.nix
same lab/ch02/int_overflow_fail.nix
same lab/ch02/interpolate_int_fail.nix
same lab/ch02/json_lambda_fail.nix
same lab/ch02/json_roundtrip.nix
same lab/ch02/lists.nix
same lab/ch02/merge_shallow.nix
same lab/ch02/numbers.nix
same lab/ch02/paths.nix
same lab/ch02/string_plus_int_fail.nix
same lab/ch02/strings.nix
same lab/ch02/types.nix
same lab/ch02/with_scope.nix
same lab/ch02/path_copy.sh
same lab/ch02/fixtures/note.txt
```

**必须和标签一致的文件：** 上面这 21 个文件。`lab/ch02/` 下的全部实验是最终版本。`lib/default.nix` 的结构（`let` 里 import 子集、`//` 摊平）也不会变，只是子集会变多，所以我把它放在下面的中间版本里讲。第 1 篇的文件仍然要和 `ch01` 一致，这一章没有改动它们，`scripts/chapter.sh` 在标签里带可执行位，复制来的副本要确认一下；运行器本身是 `bash scripts/chapter.sh` 调用的，没有可执行位也能工作，`path_copy.sh` 同理。

**中间版本（后面的章节会继续改）：**

- [`lib/default.nix`](https://github.com/bfmhno3/firn/blob/ch02/lib/default.nix)：现在只导入 `trivial` 和 `attrsets`。第 3 篇加 `fixed-points`，第 4 篇加 `strings`、`importers`、`sources`、`readme`，第 5 篇加 `lists`、`generators`、`debug`，第 6 篇加 `store-path`。
- [`lib/trivial.nix`](https://github.com/bfmhno3/firn/blob/ch02/lib/trivial.nix)：现在是 `id`、`const`、`flip`。第 3 篇加 `pipe`。
- [`lib/attrsets.nix`](https://github.com/bfmhno3/firn/blob/ch02/lib/attrsets.nix)：现在是四个函数。第 5 篇加 `genAttrs`、`mapAttrsToList`、`filterAttrs`、`mapAttrs'` 和 `nameValuePair`。
- [`tests/lib.nix`](https://github.com/bfmhno3/firn/blob/ch02/tests/lib.nix)：现在是自己写的“失败列表”，20 个用例。第 5 篇整个改用 `runTests`，用例增加到 40 个以上，并接入 `nix flake check`。
- [`README.md`](https://github.com/bfmhno3/firn/blob/ch02/README.md)：每当仓库多出一个顶层目录，“Layout”一节就会更新，这一篇加了 `lib/` 和 `tests/lib.nix` 两行；第 4 篇起章节表由程序生成。

### 文件清单

这一篇的所有文件都在仓库里，链接指向标签 `ch02` 上的那一份。实验需要沙箱目录和 `FIRN_ROOT`，所以带 `make ch02` 的行是通过运行器跑的；`.nix` 实验也可以直接用 `nix eval --file` 运行（`--file` 是非纯的，上面讲过）。许可证文本不在表里。结果列是我在 Nix 2.34.9 上的真实输出，路径里的用户名和目录是我机器上的。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`README.md`](https://github.com/bfmhno3/firn/blob/ch02/README.md) | `-` | Layout 里多出 `lib/` 和 `tests/lib.nix` 两行；不是脚本 |
| [`lib/attrsets.nix`](https://github.com/bfmhno3/firn/blob/ch02/lib/attrsets.nix) | `nix eval --impure --expr '(import ./lib).recursiveUpdate { a.b = 1; } { a.c = 2; }'` | `{ a = { b = 1; c = 2; }; }` |
| [`lib/default.nix`](https://github.com/bfmhno3/firn/blob/ch02/lib/default.nix) | `nix eval --impure --expr '(import ./lib).version'` | `"0.1.0"` |
| [`lib/trivial.nix`](https://github.com/bfmhno3/firn/blob/ch02/lib/trivial.nix) | `nix eval --impure --expr '(import ./lib).flip builtins.sub 1 10'` | `9` |
| [`tests/lib.nix`](https://github.com/bfmhno3/firn/blob/ch02/tests/lib.nix) | `nix eval --file tests/lib.nix` | `[ ]`；20 个用例；把某个期望改错，打印 `[ { expected = 1; expr = 0; name = "attrByPathMiss"; } ]` |
| [`lab/ch02/attrsets.nix`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/attrsets.nix) | `nix eval --file lab/ch02/attrsets.nix` | 退出码 0；`orNested = "no deeper"`，`sugarMerge = { a = { b = { c = 1; d = 2; }; e = 3; }; }`，`sugarEqualsNested = true` |
| [`lab/ch02/equality.nix`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/equality.nix) | `nix eval --file lab/ch02/equality.nix` | 退出码 0；`intFloat = true`，`lambdas = false`，`sameLambda = false`，`stringPath = false` |
| [`lab/ch02/ex_deep_get.nix`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/ex_deep_get.nix) | `nix eval --file lab/ch02/ex_deep_get.nix` | 退出码 0；`[ 1 "dflt" "dflt" { a = { b = { c = 1; }; s = "str"; }; } "dflt" ]`，练习 1 |
| [`lab/ch02/int_overflow_fail.nix`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/int_overflow_fail.nix) | `make ch02` | 退出码 1（按设计失败）；stderr 里是 `error: integer overflow in adding 9223372036854775807 + 1` |
| [`lab/ch02/interpolate_int_fail.nix`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/interpolate_int_fail.nix) | `make ch02` | 退出码 1（按设计失败）；stderr 里是 `error: cannot coerce an integer to a string: 1` |
| [`lab/ch02/json_lambda_fail.nix`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/json_lambda_fail.nix) | `make ch02` | 退出码 1（按设计失败）；stderr 里是 `error: cannot convert a function to JSON` |
| [`lab/ch02/json_roundtrip.nix`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/json_roundtrip.nix) | `nix eval --file lab/ch02/json_roundtrip.nix` | 退出码 0；`roundtrip = true`，`pathJsonHasContext = true`，`outPathCollapses = "\"/nix/store/x\""` |
| [`lab/ch02/lists.nix`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/lists.nix) | `nix eval --file lab/ch02/lists.nix` | 退出码 0；`squares = [ 0 1 4 9 16 25 ]`，`mixed = [ 1 "two" 3 null [ ] { } ]` |
| [`lab/ch02/merge_shallow.nix`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/merge_shallow.nix) | `nix eval --file lab/ch02/merge_shallow.nix` | 退出码 0；`shallow = { a = { c = 2; }; }`，`deep = { a = { b = 1; c = 2; }; }` |
| [`lab/ch02/numbers.nix`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/numbers.nix) | `nix eval --file lab/ch02/numbers.nix` | 退出码 0；`floatSum = 0.3`，`floatSumEq = false`，`toStringOne = "1.000000"`，`intMin = -9223372036854775808` |
| [`lab/ch02/path_copy.sh`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/path_copy.sh) | `make ch02` | 退出码 0；5 行输出，第 4 行 `one byte changed: hash part differs`；单独运行要先设 `LAB_TMP` |
| [`lab/ch02/paths.nix`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/paths.nix) | `nix eval --file lab/ch02/paths.nix` | 退出码 0；`type = "path"`，`interpolated = "/nix/store/bnms6f4g2pjk31qq96cs11hfb38c49a8-note.txt"` |
| [`lab/ch02/string_plus_int_fail.nix`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/string_plus_int_fail.nix) | `make ch02` | 退出码 1（按设计失败）；stderr 里是 `error: cannot coerce an integer to a string: 1` |
| [`lab/ch02/strings.nix`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/strings.nix) | `nix eval --json --file lab/ch02/strings.nix \| jq -c .indented` | 退出码 0；`"first\n  second (indented by 2)\nthird\n"` |
| [`lab/ch02/types.nix`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/types.nix) | `nix eval --file lab/ch02/types.nix` | 退出码 0；10 个属性，`builtinCount = 118` |
| [`lab/ch02/with_scope.nix`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/with_scope.nix) | `nix eval --file lab/ch02/with_scope.nix` | 退出码 0；`letBeatsWith = "let"`，`innerWins = "inner"`，`silentShadow = "let"`（含 `# BAD` 示例） |
| [`lab/ch02/fixtures/note.txt`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/fixtures/note.txt) | `cat lab/ch02/fixtures/note.txt` | 一行：`firn note`，10 字节；被 `paths.nix` 引用，不单独运行 |

## 练习

**1.** 不用 Firn 的 `lib`，自己写一个 `attrByPath`：沿一条键路径在嵌套的属性集里取值，缺一层就返回默认值。用 `lib.attrByPath` 对拍。

<details>
<summary>参考答案</summary>

这就是 [`lab/ch02/ex_deep_get.nix`](https://github.com/bfmhno3/firn/blob/ch02/lab/ch02/ex_deep_get.nix)。核心是下面这一段，它和 Firn 的版本只差一处，判断“这一层有没有这个键”用的是 `?`，而不是先 `isAttrs` 再 `hasAttr`：

```nix
  get =
    path: default: set:
    if path == [ ] then
      set
    else if builtins.isAttrs set && set ? ${builtins.head path} then
      get (builtins.tail path) default set.${builtins.head path}
    else
      default;
```

（我保留了 `isAttrs` 的守卫，没有赌 `?` 的行为；上面验证过 `1 ? a` 是 `false`，所以去掉它也成立，nixpkgs 就是这样写的。）文件末尾用 `assert builtins.all` 对 5 条路径同时检查自己和 `lib.attrByPath`，结果一致才返回：

```text
$ nix eval --file lab/ch02/ex_deep_get.nix
[ 1 "dflt" "dflt" { a = { b = { c = 1; }; s = "str"; }; } "dflt" ]
```

五条探测依次是：命中（`a.b.c`），中间缺键（`a.b.x`），穿过非属性集（`a.s.t`，`s` 是字符串），空路径（返回整个集合），顶层缺键（`q`）。第三条是最容易写错的：没有 `isAttrs` 守卫、又用 `builtins.hasAttr` 的实现会在那里报错。

</details>

**2.** `toString 1.0` 是 `"1.000000"`。怎样得到 `"1"`？`builtins.toJSON 1.0` 又是什么？

<details>
<summary>参考答案</summary>

先取整，再转字符串：

```text
$ nix eval --expr 'toString (builtins.floor 1.0)'
"1"
$ nix eval --expr 'builtins.toJSON 1.0'
"1.0"
```

`builtins.floor 1.0` 返回的是整数 `1`，整数的 `toString` 就是十进制。`toJSON` 的结果是 `"1.0"`，它保留了“这是浮点”这个事实（`numbers.nix` 的 `toJsonFloat` 一行）。所以三种转换的语义不同：`toString` 给 6 位小数，`toJSON` 给能原样读回的完整表示，要整数就得自己取整。

</details>

**3.** 把 shell 文本 `echo ${HOME}` 分别用 `"…"` 和 `''…''` 写成两个 Nix 字符串，让 `==` 证明它们相同。

<details>
<summary>参考答案</summary>

注意缩进字符串会剥掉缩进并保留结尾的换行，所以双引号版本要补一个 `\n`。把下面的内容存成 `esc.nix`：

```nix
let
  quoted = "echo \${HOME}\n";
  indented = ''
    echo ''${HOME}
  '';
in
{
  inherit quoted indented;
  same = quoted == indented;
}
```

```text
$ nix eval --file esc.nix
{ indented = "echo \${HOME}\n"; quoted = "echo \${HOME}\n"; same = true; }
```

（Nix 打印字符串时把 `${` 又转义了一遍，所以输出里的 `\${` 才是字符串里的 `${`。）两种写法的转义规则不同：`"…"` 里是 `\${`，`''…''` 里是 `''${`，对应上面的转义对照表。如果你把这段只写成一行，`nixfmt` 还会替你把 `''echo ''${HOME}''` 改成双引号写法。

</details>

**4.** 预测 `recursiveUpdate { a.b = 1; a.c = [ 1 ]; } { a.c = [ 2 ]; }` 的结果。列表会被合并吗？

<details>
<summary>参考答案</summary>

不会：

```text
$ nix eval --impure --expr '(import ./lib).recursiveUpdate { a.b = 1; a.c = [ 1 ]; } { a.c = [ 2 ]; }'
{ a = { b = 1; c = [ 2 ]; }; }
```

递归只发生在“两边都是属性集”的键上；`c` 的两边是列表，按规则右边赢，所以是 `[ 2 ]`，不是 `[ 1 2 ]`。`b` 被保留了，因为右边没有 `a.b`。如果你想要列表被连接起来，就不再是一个“更新”，而是一个“合并”，需要告诉合并函数每种类型怎么合并。这正是第 15 篇的模块系统在做的事：给每个选项一个类型，类型决定怎么合并。

</details>

**5.** `rec { a = a; }.a` 会无限递归。那 `rec { a = { b = a; }; }.a.b.b.b` 呢？

<details>
<summary>参考答案</summary>

不会递归，而是返回一个属性集：

```text
$ nix eval --expr 'rec { a = { b = a; }; }.a.b.b.b'
{ b = «repeated»; }
```

`a = a` 的问题是：求值 `a` 本身就需要 `a` 的值。而 `a = { b = a; }` 求值出来是一个属性集，`b` 的值（又是 `a`）是这个属性集里还没有被求值的一个槽，只在你去取 `.b` 的时候才求值，取到的恰好又是那个属性集。所以 `.a.b.b.b` 沿着这个环走了三步就停下，没有任何东西需要无限展开。打印的时候 Nix 发现回到了已经见过的值，把它显示成 `«repeated»`，没有死循环。把属性集变成“包含自己”的数据结构是 `rec` 的合法用途，也是第 3 篇用懒惰来解释不动点的起点。

</details>

## 下一篇

这一篇里有几处我故意没有往下问：`constIgnoresSecond` 那个用例里的 `throw` 为什么没有炸，`rec { a = { b = a; }; }` 为什么能走三步，`attrByPath` 里的 `&&` 为什么能挡住后面那一半。它们是同一个问题的三个面孔：Nix 什么时候才真的去算一个表达式。下一篇，第 3 篇《函数与惰性求值：thunk、seq 与不动点》，我们先把函数讲清楚（柯里化、pattern 参数、`...`），再用 `NIX_SHOW_STATS` 去数求值 `hello.name` 到底造了多少个 thunk，最后从零写出 `fix`，看看 nixpkgs 为什么是一个巨大的不动点。
