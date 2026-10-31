---
title: "展开：bash 怎样把一行字拆成参数"
commentId: "post:shell-by-cairn-02-expansion-and-quoting"
published: "2026-10-31 23:00:00 +08:00"
description: "用 Cairn 从零学 Shell 第 2 篇：我在 Bash 5.3.15 里写了夹具生成器 make_tree.sh 和 cairn snapshot 的第一版，用 set -x 看清展开的顺序，让 for f in $(ls) 在只有 10 个顶层条目的目录里迭代了 11 次，再用数组把含 -rf 和带换行名字的目录原样备份，并复现了 Bumblebee 和 Steam 两起 rm 事故收到的参数。"
category: Tutorial
tags:
  - Shell
  - Bash
  - Cairn
  - 引用
  - 通配符
  - 数组
series: "用 Cairn 从零学 Shell"
seriesOrder: 2
draft: false
comment: true
slug: shell-by-cairn-02-expansion-and-quoting
---

我以前一直默认，命令行上敲的那一行字，就是程序收到的参数，中间只多了一层“按空格分开”。这一篇我把这个默认量了一遍：我用 `scripts/make_tree.sh` 造了一个只有 13 个条目的目录，里面有带空格的文件名、以 `-` 开头的文件名、名字里带换行的文件，然后让 shell 脚本里最常见的那种循环去遍历它：

```text
$ scripts/make_tree.sh /tmp/tree
$ cd /tmp/tree
$ find . -mindepth 1 -print0 | tr -cd '\0' | wc -c
13
$ n=0; for f in $(ls); do n=$((n + 1)); done; echo "${n}"
11
```

13 是整棵树的条目数（`find` 数的是 NUL 分隔符，所以换行不会干扰它），顶层其实只有 10 个，其中 `.hidden` 被 `ls` 默认藏了起来，可见的是 9 个。循环却迭代了 11 次：两个名字被切成了四块。这不是 Bash 的 bug，它是严格按手册里写好的顺序干活的结果。这一篇我们把那个顺序一步一步看清楚，然后用它写 Cairn 第一个真正会碰用户文件的命令：`cairn snapshot`。

> [!NOTE] 本篇检查点
> 这一篇结束时仓库（标签 `ch02`）有 37 个被跟踪的文件，比 `ch01` 多 14 个：`scripts/make_tree.sh`（96 行的夹具生成器，已经是最终版本）、`lib/cairn/snapshot.sh`（54 行，第一版，后面几篇会改）、`lab/ch02/` 里的 12 个实验脚本（已经是最终版本）；另有两个旧文件被修改：`bin/cairn`（66 行长到 74 行，多了一条 `source` 加它的 ShellCheck 指令、用法文本两行和一个 `snapshot)` 分支，之后还会改）和 `README.md`（`Layout` 里多了一行，也还会改）。`make ch02` 通过：12 个实验全部以 0 退出，没有一个需要宿主机。
> 涉及的 Shell 特性：展开的顺序（花括号、波浪线、参数、算术、命令替换、分词、路径名、去引号）、`set -x` 与 `BASH_XTRACEFD`、`printf '<%s>\n'` 探针、四种引用与嵌套的 `"$(...)"`、分词与 `IFS`、空参数的消失、`"$@"` 与 `"$*"`、`nullglob`/`failglob`/`dotglob`/`globstar`/`extglob`、`--` 与 `./*`、数组当 argv、`mapfile`、`${var:?}`、ShellCheck 的 SC2086，以及 Google 指南里关于引用和 `"${var}"` 的规则。
> 前置：[第 1 篇：第一个脚本：shebang、fork/exec 与退出码](/posts/shell-by-cairn-01-first-script/)。

## 一行字变成 argv 的路上

第 1 篇里我们看到，shell 最后做的事是 `fork` 一个子进程，再 `execve(path, argv, envp)`。`argv` 是一个字符串数组，程序（C 里的 `main(int argc, char **argv)`，Python 里的 `sys.argv`）看到的只有它：没有引号，没有空格的信息，没有“这是一个通配符”的信息。从你敲下的那一行字到这个数组之间，是 bash 的展开。手册 [Shell Expansions](https://www.gnu.org/software/bash/manual/bash.html#Shell-Expansions) 一节有一段非常短的话，规定了它的顺序：

1. 先把命令行切成词 (token)，**引号在这一步生效**：手册第一句就是“展开是在命令行被切成词之后进行的”。
2. 花括号展开。
3. 波浪线展开、参数和变量展开、算术展开、命令替换，这四个按从左到右的顺序一起做。进程替换（`<(...)`，第 5 篇）和它们同时发生。
4. 分词。
5. 路径名展开（通配符）。
6. 去引号，永远是最后一步。

```mermaid
flowchart LR
    line["一行文本"] --> tok["切成词<br/>(引号在这里生效)"]
    tok --> brace["花括号展开"]
    brace --> four["波浪线、参数、算术、<br/>命令替换 (从左到右)"]
    four --> split["分词 (IFS)"]
    split --> glob["路径名展开"]
    glob --> rm["去引号"]
    rm --> argv["argv"]
    argv --> exec["execve"]
```

手册还有一句我觉得比顺序本身更重要：只有花括号展开、分词和路径名展开能让词的数量变多，其他展开都是一个词进、一个词出（例外只有 `"$@"`、`$*` 和数组的 `"${name[@]}"`）。换句话说，一行命令里“多出来的参数”只可能来自这三处，而分词和路径名展开恰好是**对变量和命令替换的结果**动手，也就是对你没有亲眼看过的文本动手。这一篇的全部内容大致就是：怎样让这两步只发生在你想让它发生的地方。

## 动手清单

你自己的 `~/cairn` 从第 1 篇的状态出发，这一篇要做这几件事，每件事在下面的哪一节出现都会指出来：

- 新建 `scripts/make_tree.sh` (`chmod +x`)，造夹具目录的脚本。
- 新建 `lib/cairn/snapshot.sh`，在 `bin/cairn` 里加三处：`source` 一行、用法文本、`snapshot)` 分支。
- 新建 `lab/ch02/` 下的 12 个实验。`make ch02` 全部跑一遍。

## 两件工具：探针和显微镜

### printf 探针

要看一个词有没有被切开，`echo` 是最差的工具：它把所有参数用一个空格接起来再打印，词的边界恰好就被抹掉了。我用的探针是 `printf` 加一个格式串：

```text
$ printf '<%s>\n' a 'b c' ''
<a>
<b c>
<>
```

`printf` 的格式串会被每个参数重复使用一次，所以每个参数占一行，尖括号把首尾的空格和空字符串也变得看得见。但它有一个盲点，是我写这一篇的时候才注意到的：**没有参数**和**一个空参数**，它打印出来是一样的。

```text
$ bash -c 'a=(); printf "<%s>\n" "${a[@]}"'
<>
```

数组是空的，一个参数都没传给 `printf`，它却打印了一行 `<>`：没有参数时格式串仍然被用了一次，`%s` 取空串。所以我的探针脚本要先打印参数个数。这就是 `lab/ch02/args.sh`，整个文件只有 8 行：

```bash
# shellcheck shell=bash
# Helper, not a lesson: prints argc=N, then every argument as <arg>.
# Other labs call it as: bash "${CAIRN_ROOT}/lab/ch02/args.sh" ARG...
# Run alone by the chapter runner it prints argc=0.
printf 'argc=%d\n' "$#"
for arg in "$@"; do
  printf '<%s>\n' "${arg}"
done
```

后面所有实验都用 `bash "${CAIRN_ROOT}/lab/ch02/args.sh" ...` 当“被调用的程序”。它是一个真正的子进程，经过真正的 `execve`，所以它看到的 argc 和 argv 就是任何外部程序会看到的。第 1 篇的运行器把 `CAIRN_ROOT` 导出给每个实验，`make ch02` 里它单独跑一次，输出 `argc=0`。以后遇到我不想真的执行的命令（`rm -rf` 一类），我都用它顶替，你可以放心跑。

### set -x

第二件工具是 `set -x`，bash 自带的显微镜。它在每条简单命令**展开完成之后、执行之前**把它打印到 stderr，前面加一个 `+`：

```text
$ bash -xc 'v="x y"; printf "<%s>\n" $v "$v"'
+ v='x y'
+ printf '<%s>\n' x y 'x y'
<x>
<y>
<x y>
```

跟踪行里 `$v` 已经被换成 `x y` 两个词，而 `"$v"` 是 `'x y'`，一个词，bash 在打印时重新加上了引号，让你能把这一行原样贴回终端。看到 `'x y'` 带引号，就说明那是一个词；两个裸的词 `x y`，就是被切开了。前缀由变量 `PS4` 决定，默认是 `+ `，命令替换里面的命令会多一个 `+` (`++`)，下一节马上能看到。把 `PS4` 设成 `'+ ${BASH_SOURCE##*/}:${LINENO}: '`，每一行跟踪前面还会带上文件名和行号，后面跟踪 `cairn` 自己的时候会用到。

## 展开的顺序

`lab/ch02/expansion_order.sh` 对手册里的每一步各做一次探针，打开 `set -x`，让 `args.sh` 把真正收到的参数打印出来。下面是它的开头和前两个阶段（后面的阶段都是同样的三行）：

```bash
# shellcheck shell=bash
# Shows: the order of expansions, one probe per stage. Each probe is a
# command line given to args.sh; `set -x` shows the words after expansion.
# The trace goes to a copy of stdout (fd 3, via BASH_XTRACEFD) so it
# interleaves with the output of args.sh in order and is not captured by
# $(...).
# BAD: most probes below are deliberately unquoted.
# shellcheck disable=SC2016,SC2046,SC2116,SC2086,SC2035,SC2028,SC1001,SC2051
exec 3>&1
BASH_XTRACEFD=3
args="${CAIRN_ROOT}/lab/ch02/args.sh"
cd "${LAB_TMP}" || exit 1
touch a.txt b.txt
HOME=/home/demo
n=3
v='x y'

echo '--- 1 brace expansion: {a,b}{1,2}'
set -x
bash "${args}" {a,b}{1,2}
set +x
echo '--- 2 tilde expansion: ~/docs'
set -x
bash "${args}" ~/docs
set +x
# ...
```

这里有两个我之前没用过的东西。`set -x` 默认把跟踪写到 stderr，而运行器把 stdout 和 stderr 存在两个文件里，贴出来就对不上顺序了。`BASH_XTRACEFD=3` 让跟踪写到文件描述符 3，前一行 `exec 3>&1` 把 3 做成 stdout 的一个副本，于是跟踪和 `args.sh` 的输出会按真实顺序交织在一起（文件描述符第 5 篇细讲，现在把它当成“另一根指向同一个终端的线”就够了）。第二，文件开头那一长串 `shellcheck disable`：这个脚本整个就是在演示“不打引号会怎样”，ShellCheck 对大多数探针都会报警（阶段 3 的两个展开本来就带了引号），我在文件头一次关掉，并且用 `# BAD:` 标明这是故意的，这是 `docs/code-style.md` 里写的规矩。

输出的前半部分，从花括号到命令替换：

```text
--- 1 brace expansion: {a,b}{1,2}
+ bash /home/bfmhno3/Projects/cairn/lab/ch02/args.sh a1 a2 b1 b2
argc=4
<a1>
<a2>
<b1>
<b2>
+ set +x
--- 2 tilde expansion: ~/docs
+ bash /home/bfmhno3/Projects/cairn/lab/ch02/args.sh /home/demo/docs
argc=1
</home/demo/docs>
+ set +x
--- 3 parameter expansion: "${v}" "${v:-none}"
+ bash /home/bfmhno3/Projects/cairn/lab/ch02/args.sh 'x y' 'x y'
argc=2
<x y>
<x y>
+ set +x
--- 4 arithmetic expansion: $((n * 2))
+ bash /home/bfmhno3/Projects/cairn/lab/ch02/args.sh 6
argc=1
<6>
+ set +x
--- 5 command substitution: $(echo one two)
++ echo one two
+ bash /home/bfmhno3/Projects/cairn/lab/ch02/args.sh one two
argc=2
<one>
<two>
+ set +x
```

阶段 1：一个词 `{a,b}{1,2}` 变成了四个。花括号展开是纯文本操作，它不看文件系统，`a1` 这些文件根本不存在。阶段 2：`~` 换成了 `$HOME`，我在实验开头把 `HOME` 设成了 `/home/demo`，所以输出里没有我的用户名。阶段 3：`"${v}"` 和 `"${v:-none}"` 都是**一个**词，空格留在里面（`${v:-none}` 是“`v` 为空或未设时用 `none`”，第 3 篇细讲）。阶段 4：算术展开 `$((n * 2))` 里的 `n` 不需要写 `$`。阶段 5 的跟踪里有两行：`++ echo one two` 比 `+ bash ...` 早出现，因为命令替换要先跑完，才有东西可以填回命令行；前缀多出来的那个 `+` 表示它是嵌套在里面的命令。

后半部分：

```text
--- 6 word splitting: ${v} unquoted
+ bash /home/bfmhno3/Projects/cairn/lab/ch02/args.sh x y
argc=2
<x>
<y>
+ set +x
--- 7 pathname expansion: *.txt
+ bash /home/bfmhno3/Projects/cairn/lab/ch02/args.sh a.txt b.txt
argc=2
<a.txt>
<b.txt>
+ set +x
--- 8 quote removal: "q" 's' \e
+ bash /home/bfmhno3/Projects/cairn/lab/ch02/args.sh q s e
argc=3
<q>
<s>
<e>
+ set +x
--- order: brace runs before parameter, so {1..$n} stays literal
+ bash /home/bfmhno3/Projects/cairn/lab/ch02/args.sh '{1..3}'
argc=1
<{1..3}>
+ set +x
```

阶段 6：没打引号的 `${v}` 被切成两个词，阶段 7：`*.txt` 被换成两个真实存在的文件名。阶段 8：`"q" 's' \e` 被去引号，三个词 `q s e`，`\e` 的反斜杠也被拿掉了。

最后一段是顺序带来的一个有名的陷阱：`{1..$n}` 想产生 1 到 3，实际上 `n` 确实被换成了 3（跟踪里的 `'{1..3}'` 就是证据），但花括号展开在参数展开**之前**已经做完了，等 `$n` 有了值，没有人再回头展开花括号，于是 `argc=1`，`<{1..3}>` 作为一个字面的词被传了下去。需要计数循环的时候，写 `for ((i = 1; i <= n; i++))`，下一节的 `make_tree.sh` 里就有一个。

## 先造一个有毒的目录

后面所有实验和 Cairn 自己都要有一个“用户真实的目录”，而真实的目录里什么怪名字都有。`scripts/make_tree.sh DIR [--big MB]` 造出这么一棵树，所有名字都是我故意挑的。它的头和 `build_tree` 函数（96 行里最有意思的一段）：

```bash
#!/usr/bin/env bash
#
# Creates a fixture tree full of awkward file names for the chapter 2
# labs and, from chapter 5 on, for snapshot tests.
#
# Usage: scripts/make_tree.sh DIR [--big MB]
#
# DIR is created if needed and must be empty, otherwise exit status 1.
# --big MB adds big/file_NNN.bin, MB files of 1 MiB random data each.

set -o nounset
set -o pipefail

# ...

build_tree() {
  local dir="$1"
  local big_mb="$2"
  cd -- "${dir}" || return 1

  printf 'plain\n' >plain.txt || return 1
  printf 'space\n' >'with space.txt' || return 1
  printf 'dash\n' >./-rf || return 1
  printf 'star\n' >'star*.txt' || return 1
  printf 'newline\n' >$'new\nline.txt' || return 1
  printf '中文\n' >中文.md || return 1
  printf 'hidden\n' >.hidden || return 1
  mkdir empty_dir || return 1
  mkdir -p nested/a/b || return 1
  printf 'deep\n' >nested/a/b/c.txt || return 1
  ln -s plain.txt link_to_plain || return 1

  if ((big_mb > 0)); then
    mkdir big || return 1
    local i
    local name
    for ((i = 1; i <= big_mb; i++)); do
      printf -v name 'big/file_%03d.bin' "${i}"
      head -c 1048576 /dev/urandom >"${name}" || return 1
    done
  fi
}
```

几处值得停一下：

- **`$'new\nline.txt'`** 是第三种引用，`$'...'`，里面的 `\n` 被解释成真正的换行字符。下一节细讲。
- **`cd -- "${dir}"`**：`--` 告诉 `cd` “选项到此为止”，所以一个叫 `-rf` 的目录也能进。习惯从现在养成，本篇后半部分是它的正式讲解。
- **`|| return 1`** 到处都是，因为这个脚本没有 `set -e`（第 7 篇讲它的六个坑，现在我们手动检查每个返回值，这也是 Google 指南的要求）。`set -o nounset` 和 `pipefail` 有：前者让用了没赋值的变量时报错，后者让管道里任何一环失败都算失败。
- **`for ((i = 1; i <= big_mb; i++))`** 是算术 `for`，正好绕开上一节的花括号陷阱；`printf -v name '...' "${i}"` 把格式化的结果直接写进变量，不开子进程。`local i` 和 `local name` 各占一行，Google 指南要求声明和赋值分开（对命令替换尤其如此），这里没有命令替换，我也就顺手分开了。

文件名的选择各有目的。`with space.txt` 考验分词，`-rf` 考验“看起来像选项的文件名”，`star*.txt` 考验通配符，带换行的名字考验一切按行处理的东西，`中文.md` 考验非 ASCII，`.hidden` 考验通配符默认不匹配的点文件，`empty_dir/` 和 `nested/a/b/c.txt` 一个考验空目录会不会丢，一个考验递归，符号链接 `link_to_plain` 考验“链接本身”和“链接指向的文件”。造一棵树，列一遍（`%q` 把不可见字符写成能粘贴回终端的形式）：

```text
$ find . -mindepth 1 -print0 | LC_ALL=C sort -z | xargs -0 printf '%q\n'
./-rf
./.hidden
./empty_dir
./link_to_plain
./nested
./nested/a
./nested/a/b
./nested/a/b/c.txt
'./new'$'\n''line.txt'
./plain.txt
'./star*.txt'
'./with space.txt'
./中文.md
```

13 个条目：8 个普通文件、1 个符号链接、4 个目录。这三个数是在夹具目录里分别数出来的：

```text
$ for t in f l d; do find . -mindepth 1 -type "${t}" -print0 | tr -cd '\0' | wc -c; done
8
1
4
```

`%q` 把那个带换行的名字写成了 `'./new'$'\n''line.txt'`，这正是 bash 自己的引用语法：单引号、`$'...'`、再单引号，拼成一个词。

脚本的另外两项职责也跑一下：目录非空时拒绝（退出码 1），参数错误给用法（退出码 2），`--big 3` 加三个 1 MiB 的文件：

```text
$ scripts/make_tree.sh /tmp/tree; echo "rc=$?"
make_tree.sh: /tmp/tree is not empty
rc=1
$ scripts/make_tree.sh; echo "rc=$?"
make_tree.sh: usage: make_tree.sh DIR [--big MB]
rc=2
$ scripts/make_tree.sh /tmp/tree2 --big 3; echo "rc=$?"
rc=0
$ du -sb /tmp/tree2/big
3145728	/tmp/tree2/big
$ find /tmp/tree2 -mindepth 1 -print0 | tr -cd '\0' | wc -c
17
```

`3145728` 就是 3 × 1048576，加上 `big/` 目录自己和三个文件，条目数从 13 变成 17。不过检查“目录是否为空”的那一行用了 `ls -A`：`[[ -n "$(ls -A -- "${dir}")" ]]`。这是整篇里唯一一处不是反面教材的 `ls` 命令替换：我只看它**有没有**输出，不拆它的输出。

## 引用：四种写法

引用的作用只有一个：告诉 bash“这一段不要再动了”。它有四种写法，`lab/ch02/quotes.sh` 把它们并排放在一起（整个文件 24 行）：

```bash
# shellcheck shell=bash
# Shows: single quotes, double quotes, $'...', backslash and nested
# "$(...)" quoting.
args="${CAIRN_ROOT}/lab/ch02/args.sh"
name='world'

echo "--- single quotes: nothing is special"
bash "${args}" 'hello $name \n $(date)'
echo '--- double quotes: $, ` and \ still work'
bash "${args}" "hello ${name} $((1 + 1))"
echo '--- $'"'"'...'"'"': ANSI-C escapes'
bash "${args}" $'tab\there' $'two\nlines'
echo '--- backslash outside quotes'
bash "${args}" a\ b \$name
echo '--- backslash inside double quotes'
bash "${args}" "a\"b" "c\\d" "e\nf"
echo '--- a single quote inside single quotes'
bash "${args}" 'it'\''s'
echo "--- \"\$(...)\" nests: inner quotes are independent"
bash "${args}" "$(printf '%s' "a  b")"
bash "${args}" "outer $(printf '<%s>' "in ner") end"
echo "--- unquoted \$(...) splits"
# shellcheck disable=SC2046 # BAD: deliberate
bash "${args}" $(printf '%s' "a  b")
```

输出（`tab` 和 `here` 之间是一个真正的制表符，`two` 和 `lines` 之间是一个真正的换行）：

```text
--- single quotes: nothing is special
argc=1
<hello $name \n $(date)>
--- double quotes: $, ` and \ still work
argc=1
<hello world 2>
--- $'...': ANSI-C escapes
argc=2
<tab	here>
<two
lines>
--- backslash outside quotes
argc=2
<a b>
<$name>
--- backslash inside double quotes
argc=3
<a"b>
<c\d>
<e\nf>
--- a single quote inside single quotes
argc=1
<it's>
--- "$(...)" nests: inner quotes are independent
argc=1
<a  b>
argc=1
<outer <in ner> end>
--- unquoted $(...) splits
argc=2
<a>
<b>
```

- **单引号**里什么都不特殊：`$name`、`\n`、`$(date)` 原样传给了程序，`date` 根本没有运行。它也是唯一一种里面放不下它自己的引用，所以 `it's` 要写成 `'it'\''s'`：关掉单引号，用反斜杠转义一个单引号，再重新打开。三段拼成一个词。
- **双引号**只保留三样特殊：`$`（参数、算术、命令替换）、反引号和反斜杠，所以 `${name}` 和 `$((1 + 1))` 照常展开，结果是一个词 `hello world 2`。手册对反斜杠的规定很具体：它只在后面跟着 `$`、反引号、`"`、`\` 或换行时才是转义，别的情况原样保留。实验里 `"e\nf"` 的输出是 `e\nf`，反斜杠和 `n` 都还在，而 `"c\\d"` 只剩一个反斜杠，就是这条规则。
- **`$'...'`**（ANSI-C 引用，手册里的 [ANSI-C Quoting](https://www.gnu.org/software/bash/manual/bash.html#ANSI_002dC-Quoting) 一节）像单引号一样不做展开，但会解释 `\t`、`\n`、`\xHH` 这类转义。要在 shell 里写一个换行或制表符，这是最干净的写法。
- **反斜杠**转义下一个字符：`a\ b` 是一个词，`\$name` 是字面的 `$name`。

最后三个实验是嵌套。`"$(...)"` 里面是一个**全新的引用上下文**：`"$(printf '%s' "a  b")"` 里，里面那一对双引号和外面那一对互不相干，所以内层的 `a  b`（两个空格）完整地走了出来。Google 指南的示例注释里也有这一句：嵌套在 `"$()"` 里的引号不需要转义。这样的嵌套在第 1 篇的 `bin/cairn` 里已经出现过，只是我当时没有指出来，第 13 行：

```bash
CAIRN_LIB="${CAIRN_LIB:-$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")/../lib/cairn}"
```

从外到内一共三层引用：最外层的 `"${CAIRN_LIB:-...}"`，里面的 `"$(readlink -f -- "${BASH_SOURCE[0]}")"`，最里层的 `"${BASH_SOURCE[0]}"`。每一层都独立判断。如果脚本被放在 `/home/me/my tools/cairn/bin/cairn`，这一行仍然能解出正确的库目录，靠的就是每一层都加了引号。

最后一个实验，没有外层引号的 `$(printf '%s' "a  b")`，里面的引号只管 `printf` 收到什么，命令替换的结果 `a  b` 回到外面以后没有任何保护，于是被分词成 `a` 和 `b`。这引出下一个话题。

## 分词与 IFS

命令替换和参数展开的结果，在没有引号包住的时候，会被切开。我习惯用快递分拣线来想它。`argv` 是一排包裹，每个包裹就是一个参数；引号是封箱的胶带，**一个**包裹贴了胶带就不会被拆；分词是传送带尽头的分拣机，它看到一个没有胶带的大箱子，就按 `IFS` 里的字符把它拆开。这个比喻我就用这一次，以后直接说分词。

`lab/ch02/word_splitting.sh`：

```bash
# shellcheck shell=bash
# Shows: word splitting on spaces, an empty unquoted variable vanishing,
# and a custom IFS.
args="${CAIRN_ROOT}/lab/ch02/args.sh"
file='my notes.txt'
empty=''

echo '--- unquoted: two words'
# shellcheck disable=SC2086 # BAD: deliberate
bash "${args}" ${file}
echo '--- quoted: one word'
bash "${args}" "${file}"
echo '--- empty variable, unquoted: the argument vanishes'
# shellcheck disable=SC2086 # BAD: deliberate
bash "${args}" ${empty}
echo '--- empty variable, quoted: one empty argument'
bash "${args}" "${empty}"
echo '--- IFS=: splits only on colons'
path='/usr/bin:/opt/my tools:/bin'
IFS=:
# shellcheck disable=SC2086 # BAD: deliberate
bash "${args}" ${path}
unset IFS
echo '--- IFS unset again: back to blank, tab, newline'
# shellcheck disable=SC2086 # BAD: deliberate
bash "${args}" ${path}
echo '--- read -a with a local IFS'
IFS=: read -r -a parts <<<"${path}"
bash "${args}" "${parts[@]}"
```

```text
--- unquoted: two words
argc=2
<my>
<notes.txt>
--- quoted: one word
argc=1
<my notes.txt>
--- empty variable, unquoted: the argument vanishes
argc=0
--- empty variable, quoted: one empty argument
argc=1
<>
--- IFS=: splits only on colons
argc=3
</usr/bin>
</opt/my tools>
</bin>
--- IFS unset again: back to blank, tab, newline
argc=2
</usr/bin:/opt/my>
<tools:/bin>
--- read -a with a local IFS
argc=3
</usr/bin>
</opt/my tools>
</bin>
```

`my notes.txt` 没打引号变成两个词，加上引号是一个。这是最常见、也最容易被看出来的情形。我觉得真正让我停下来想的是第三个：**空变量不打引号，参数直接消失**，`argc=0`。手册把它说得很清楚：展开出来是空值的未加引号的参数叫“隐式空参数”，会被删掉；字面写出的 `""` 或 `''` 是“显式空参数”，会被保留。所以 `"${empty}"` 给你一个 `<>`，`${empty}` 给你什么都没有。它也是下面 `[ $x = y ]` 报错的原因。

先看看它平时怎么坑人。判断一个变量是不是某个值，最常见的写法是：

```text
$ bash -c 'x=""; [ $x = y ]; echo "rc=$?"'
bash: line 1: [: =: unary operator expected
rc=2
$ bash -c 'x=""; [ "$x" = y ]; echo "rc=$?"'
rc=1
```

`[ $x = y ]` 里的 `$x` 消失以后，`[` 收到的是 `=`、`y` 和一个 `]`，只有两个操作数，它理解成“`=` 是一个一元运算符”，报错，退出码 2。加上引号才是我们想要的：比较不相等，退出码 1。这也是 Google 指南偏爱 `[[ ... ]]` 的理由，`[[` 里面不分词也不展开通配符。分词不是在每个地方都发生，手册给的范围是“参数展开、命令替换、算术展开的结果”，所以赋值、`[[ ]]`、`case` 这些地方天然是安全的：

```text
$ bash -c 'v="a b"; x=$v; printf "<%s>\n" "$x"; [ $v = x ]; echo "rc=$?"; [[ $v == x ]]; echo "rc=$?"; case $v in "a b") echo match ;; esac'
<a b>
bash: line 1: [: too many arguments
rc=2
rc=1
match
```

赋值 `x=$v` 没有切开 `v`，`case` 也没有，`[[ ]]` 比较的是完整的 `a b`，只有 `[ $v = x ]` 里的 `$v` 被切成 `a` 和 `b`，`[` 收到四个参数，所以是“参数太多”。

这几处不分词，但 Google 指南仍然要求照样加引号：因为“这里恰好安全”是一个要记住的例外，而“永远加”是一条不需要记忆的规则。

`IFS` 是 Internal Field Separator 的缩写，它决定“在哪里切”。默认值是空格、制表符、换行（`printf '%q\n' "$IFS"` 在这台机器上打印 `$' \t\n'`）。实验里把它设成 `:` 以后，`/usr/bin:/opt/my tools:/bin` 被切成三个词，`my tools` 里的空格**不再**是分隔符；`unset IFS` 回到默认值，同样的变量就被空格切成了两个词，冒号反而不起作用。

最后一个实验是一个我很喜欢的写法：`IFS=: read -r -a parts <<<"${path}"`。变量赋值写在命令前面，只对这一条命令生效，所以不用事后手动恢复 `IFS`，不会忘记，也不会在中途出错的时候留下被改过的 `IFS`。`read -a` 把切出来的字段放进数组 `parts`，三个元素，每个元素里的空格都完好无损。（`<<<` 叫 here-string，第 5 篇细讲。）

手册里还有两句话值得抄下来：`IFS` 设成空串，就完全不分词（但隐式空参数仍然被删掉）；`IFS` 里如果有非空白字符，那么相邻的两个这样的分隔符之间会有一个空字段。后者我放到练习 4 里让你自己验证。

## `"$@"` 为什么一个字符都不能少

分词和空参数这两件事合在一起，决定了脚本怎样把自己收到的参数转给别人。`bin/cairn` 里的 `cairn::snapshot::create "$@"` 就是这样一行，而 `lab/ch02/at_vs_star.sh` 用三个参数（一个带空格，一个是空串）把四种写法排在一起：

```bash
# shellcheck shell=bash
# Shows: $@, "$@", $* and "$*" with three arguments, one containing
# spaces and one empty.
args="${CAIRN_ROOT}/lab/ch02/args.sh"
set -- one 'two words' ''

echo '--- $@ (unquoted)'
# shellcheck disable=SC2068 # BAD: deliberate
bash "${args}" $@
echo '--- "$@"'
bash "${args}" "$@"
echo '--- $* (unquoted)'
# shellcheck disable=SC2048,SC2086 # BAD: deliberate
bash "${args}" $*
echo '--- "$*"'
bash "${args}" "$*"
echo '--- "$*" with IFS=,'
IFS=,
bash "${args}" "$*"
unset IFS
```

`set -- one 'two words' ''` 是给当前脚本的位置参数赋值的惯用写法：`--` 之后的所有东西，哪怕以 `-` 开头，都成为 `$1`、`$2`……

```text
--- $@ (unquoted)
argc=3
<one>
<two>
<words>
--- "$@"
argc=3
<one>
<two words>
<>
--- $* (unquoted)
argc=3
<one>
<two>
<words>
--- "$*"
argc=1
<one two words >
--- "$*" with IFS=,
argc=1
<one,two words,>
```

注意前两段：未加引号的 `$@` 和 `"$@"` 的 `argc` **都是 3**。只数个数的测试会觉得它们一样，但内容完全不同：前者是 `one`、`two`、`words`（带空格的参数被切开，空参数消失了），后者才是原来的三个。`"$@"` 是唯一一种“按原样保留每个参数”的写法，它甚至是一个特例：双引号里的 `$@` 不像别的展开那样“一个词进、一个词出”，而是每个参数各成一个词（手册在 Special Parameters 一节里明确写了这个例外，我们在开头引的展开一节里也提过）。零个参数的时候，它一个词也不产生：

```text
$ bash -c 'set --; printf "<%s>\n" "$@"; echo "n=$#"'
<>
n=0
```

这里 `n=0` 才是真相，`<>` 是第一个盲点，`printf` 在没有参数时仍然把格式串用了一次。不用探针换成 `args.sh`，它会正确地打印 `argc=0`。

`"$*"` 是另一回事：它把所有参数拼成**一个**词，用 `IFS` 的第一个字符连接（默认是空格，所以 `one two words ` 末尾的那个空格来自最后那个空参数）。`IFS=,` 以后连接符就是逗号，`one,two words,`。这是 `$*` 唯一合理的用途：做一条日志或提示信息，Google 指南也只给了这个例外：“除非你有具体的理由，比如把参数追加进一条日志，否则用 `"$@"`。”

所以 Cairn 里所有“把收到的参数交给别人”的地方，`main "$@"`、`cairn::snapshot::create "$@"` 和数组里的 `"$@"`，都是这四个字符。少一对引号，`with space.txt` 变成两个文件；换成 `"$*"`，所有源路径粘成一个不存在的路径。

## 引用不到的地方：通配符

分词之后是路径名展开，也就是通配符。**没打引号的变量展开的结果，也会被当成模式。** 这一点在 SC2086 的 wiki 里写得很直白：看起来是“打印第一个参数”的 `echo $1`，实际上是“按 IFS 切开，对每一块当成通配符展开，再用空格接起来，打印”。在夹具目录里试一下：

```text
$ cd /tmp/tree
$ f='*.txt'; printf '<%s>\n' $f
<new
line.txt>
<plain.txt>
<star*.txt>
<with space.txt>
$ printf '<%s>\n' "$f"
<*.txt>
```

`f` 里存的只是 5 个字符 `*.txt`，不打引号时它变成了当前目录里四个真实文件，包括那个带换行的名字。加上引号，就是 `*.txt` 字面量。（这个例子的意思不是“变量里不能放星号”，而是“变量里放什么，由你决定，由引号保证它一直是你放进去的东西”。）

通配符的行为由几个 `shopt` 选项控制，`lab/ch02/glob_options.sh` 把它们逐个演示一遍。我挑出里面的各段：

```bash
# shellcheck shell=bash
# Shows: nullglob, failglob (in a subshell), dotglob, globstar, extglob.
export LC_ALL=C
args="${CAIRN_ROOT}/lab/ch02/args.sh"
cd "${LAB_TMP}" || exit 1
mkdir -p sub/deep
touch a.txt b.txt .hidden sub/c.txt sub/deep/d.txt

echo '--- default: no match leaves the pattern'
bash "${args}" ./*.nope
echo '--- nullglob: no match expands to nothing'
shopt -s nullglob
bash "${args}" ./*.nope
shopt -u nullglob
echo '--- failglob in a subshell: the command is not run'
(
  shopt -s failglob
  bash "${args}" ./*.nope
  echo 'not reached'
)
echo "subshell status: $?"
# ...
echo '--- extglob: !(a).txt and @(a|b).txt'
shopt -s extglob
bash "${args}" ./!(a).txt
bash "${args}" ./@(a|b).txt
shopt -u extglob
```

```text
--- default: no match leaves the pattern
argc=1
<./*.nope>
--- nullglob: no match expands to nothing
argc=0
--- failglob in a subshell: the command is not run
subshell status: 1
--- default: * skips dotfiles
argc=3
<./a.txt>
<./b.txt>
<./sub>
--- dotglob: * includes dotfiles
argc=4
<./.hidden>
<./a.txt>
<./b.txt>
<./sub>
--- default: ** is just *
argc=1
<./sub/c.txt>
--- globstar: ** recurses
argc=4
<./a.txt>
<./b.txt>
<./sub/c.txt>
<./sub/deep/d.txt>
--- extglob: !(a).txt and @(a|b).txt
argc=1
<./b.txt>
argc=2
<./a.txt>
<./b.txt>
```

- **默认**：没有匹配的模式保持原样，`./*.nope` 被原样传给程序 (`argc=1`)。这是通配符最阴险的地方：它在“有文件”和“没有文件”时给出完全不同形状的参数。
- **`nullglob`**：没有匹配就展开成空，`argc=0`。循环 `for f in ./*.log` 在没有日志的时候就是零次迭代，这是我在脚本里要的行为。
- **`failglob`**：没有匹配就报错，**命令不执行**：输出里没有 `argc=` 那一行，`echo 'not reached'` 也没有被执行（整个子 shell 被中止，状态 1）。报错在 stderr 里，运行器把它保存在 `out/ch02/glob_options.stderr`：`.../lab/ch02/glob_options.sh: line 18: no match: ./*.nope`。我把它放在子 shell 里，是因为它会让当前 shell 的这条命令失败，一个脚本里通常只想对某一小段开启它。
- **`dotglob`**：`*` 默认不匹配以点开头的文件，所以 `./*` 少了 `.hidden`。下一节 `ls` 少一个条目是同一个原因的另一种形式（`ls` 默认也不列点文件）。
- **`globstar`**：默认 `**` 只是两个 `*`，`./**/*.txt` 等于 `./*/*.txt`，只找到下一层里的 `sub/c.txt`；打开 `globstar` 以后它才会递归，四个 `.txt` 都在。
- **`extglob`**：`!(a).txt` 是“除 `a` 以外的任何名字加 `.txt`”，`@(a|b).txt` 是“`a` 或 `b`”。注意它**必须**在包含它的那一行被解析**之前**就打开，所以实验里的 `shopt -s extglob` 单独占一行。

这个实验的开头有一句 `export LC_ALL=C`：路径名展开的结果是排过序的，排序规则取决于 locale，我想让每个人跑出来的顺序一样。locale 第 6 篇再讲。

## 数一数：for f in $(ls)

现在可以回到开头的 11 了。`lab/ch02/nasty_names.sh` 用同一棵夹具树，数了五个数：

```bash
# shellcheck shell=bash
# Shows: how many entries `for f in $(ls)` sees in the make_tree fixture
# compared with a glob and with find -print0.
export LC_ALL=C
tree="${LAB_TMP}/tree"
bash "${CAIRN_ROOT}/scripts/make_tree.sh" "${tree}" || exit 1
cd "${tree}" || exit 1

ls_count=0
# shellcheck disable=SC2045 # BAD: deliberate
for f in $(ls); do
  ls_count=$((ls_count + 1))
done

dotglob_count=0
shopt -s dotglob
# shellcheck disable=SC2034 # f is only counted
for f in ./*; do
  dotglob_count=$((dotglob_count + 1))
done
shopt -u dotglob
# ...
find_count=0
while IFS= read -r -d ''; do
  find_count=$((find_count + 1))
done < <(find . -mindepth 1 -maxdepth 1 -print0)

all_count="$(find . -mindepth 1 -print0 | tr -cd '\0' | wc -c)"
```

输出：

```text
entries at top level (find -print0):  10
iterations of for f in $(ls):         11
iterations of for f in ./*:           9
iterations of ./* with dotglob:       10
entries in the whole tree (find):     13
--- what $(ls) produced, one word per line
argc=11
<-rf>
<empty_dir>
<link_to_plain>
<nested>
<new>
<line.txt>
<plain.txt>
<star*.txt>
<with>
<space.txt>
<中文.md>
```

五个数的关系：顶层 10 个条目，`ls` 默认不显示点文件，所以输出 9 个名字；`new\nline.txt` 被换行切成 `new` 和 `line.txt`，`with space.txt` 被空格切成 `with` 和 `space.txt`，9 - 2 + 4 = 11。`for f in ./*` 是 9 次，因为 `./*` 不含点文件；打开 `dotglob` 以后是 10，和 `find` 数的顶层条目一致。13 是整棵树，包括 `nested/a`、`nested/a/b` 和 `nested/a/b/c.txt` 三个深层条目。

迭代 11 次，其中有 4 次拿到的是“半个名字”，而且一个 `.hidden` 悄无声息地丢了。`ls` 没有错，它只是被要求把名字写在 stdout 上，用换行分隔，而名字里本来就可以有换行。ShellCheck 对这种写法有专门的规则（SC2045，“遍历 `ls` 的输出是脆弱的，用通配符”），后面我们会让它说话。

正确的写法有两种：要简单遍历当前目录，用 `./*`；要递归、要处理任意名字，用 `find -print0`（名字之间用 NUL 分隔，因为文件名里可以有除 `/` 和 NUL 以外的任何字节），再用 `read -r -d ''` 一个一个读。实验里的 `find_count` 就是后一种，数出 10。

那个 `done < <(find ...)` 的写法不是随意的。Google 指南和我们的 `docs/code-style.md` 都要求“用进程替换或 `readarray` 喂循环，不要管道进 `while`”，理由可以直接数出来：

```text
$ c=0; find . -mindepth 1 -maxdepth 1 -print0 | while IFS= read -r -d ''; do c=$((c + 1)); done; echo "${c}"
0
$ c=0; while IFS= read -r -d ''; do c=$((c + 1)); done < <(find . -mindepth 1 -maxdepth 1 -print0); echo "${c}"
10
```

管道的每一段都在自己的子进程里跑，`while` 在子 shell 里累加了 10 次，`c` 的修改随子 shell 一起消失了，外面看到的是 0。用 `< <(...)`，`while` 留在当前 shell，`c` 是 10。如果你只是想把名字装进数组，`mapfile -d '' -t entries < <(find . -mindepth 1 -maxdepth 1 -print0)` 一步到位，`${#entries[@]}` 也是 10。

## 名字以 - 开头

夹具树里有一个叫 `-rf` 的文件。通配符展开的结果是一排名字，如果有一个以 `-` 开头，它在被展开后看起来**就是一个选项**。`lab/ch02/dash_filename.sh` 用 `args.sh` 代替 `ls`，也代替我们绝对不会在这里运行的 `rm`：

```bash
# shellcheck shell=bash
# Shows: a file named -rf turns into an option when * expands to it.
# args.sh stands in for ls (and for rm, which we never run here).
export LC_ALL=C
args="${CAIRN_ROOT}/lab/ch02/args.sh"
tree="${LAB_TMP}/tree"
bash "${CAIRN_ROOT}/scripts/make_tree.sh" "${tree}" || exit 1
cd "${tree}" || exit 1
rm -r empty_dir nested link_to_plain
rm -- 'star*.txt' $'new\nline.txt'

echo '--- ls * (BAD): -rf sorts first and looks like an option'
# shellcheck disable=SC2035 # BAD: deliberate
bash "${args}" *
echo '--- ls ./*: every word starts with ./'
bash "${args}" ./*
echo '--- ls -- *: -- ends option parsing'
bash "${args}" -- *
echo '--- what real ls does with the first one'
# shellcheck disable=SC2035,SC2012 # BAD: deliberate
ls * 2>&1 | head -n 3
```

（实验在沙箱里删掉了几个条目，让输出短一点；沙箱每次都是新建的，这些 `rm` 碰不到别的东西。）输出：

```text
--- ls * (BAD): -rf sorts first and looks like an option
argc=4
<-rf>
<plain.txt>
<with space.txt>
<中文.md>
--- ls ./*: every word starts with ./
argc=4
<./-rf>
<./plain.txt>
<./with space.txt>
<./中文.md>
--- ls -- *: -- ends option parsing
argc=5
<-->
<-rf>
<plain.txt>
<with space.txt>
<中文.md>
--- what real ls does with the first one
plain.txt
with space.txt
中文.md
```

`LC_ALL=C` 下 `-` 排在字母前面，所以 `-rf` 是 `*` 展开的第一个词，传给程序后它是一个合法的选项。最后一段是真的 `ls`：它把 `-rf` 吃掉当成了 `-r` 和 `-f`，所以输出里没有这个文件。要是那个程序是 `rm`，`-rf` 就把“递归、强制”两个开关送给了后面所有的名字，这正是 Google 指南里那个例子的结局：`rm -v *` 在一个有 `-f` 和 `-r` 两个文件的目录里“几乎把整个目录强制删掉了”。

两种解法，两种机制。**`./*`**：让每个词都以 `./` 开头，它不再可能以 `-` 开头，这是 Google 指南的规则（“展开通配符时用显式路径”）。**`--`**：几乎所有 Unix 命令行程序都约定“`--` 之后不再解析选项”，所以 `args.sh -- *` 里 `-rf` 是一个普通参数（`argc=5` 里第一个是 `--` 自己）。两者我都用：`./*` 在我自己控制通配符的地方，`--` 在我不得不把别人给的路径传给命令的地方，比如 `make_tree.sh` 里的 `cd -- "${dir}"`，`mkdir -p -- "${dir}"`，还有下面 `cairn snapshot` 里的 `rsync` 调用。不过 `--` 要看程序愿不愿意遵守约定，所以 `./*` 更保险。

## 两起事故

上面这些单个实验看起来像“小心点就好了”。2011 年和 2015 年各有一个项目的用户用真实数据验证过它们：

- **Bumblebee，2011 年 5 月。** 这个项目的安装脚本里有一行 `rm -rf /usr /lib/nvidia-current/xorg/xorg`。[issue #123](https://github.com/MrMEEE/bumblebee-Old-and-abbandoned/issues/123) 的标题是“install script does rm -rf /usr for ubuntu”，报告人说第 351 行多了一个空格，在 Ubuntu 上装它会让脚本把 `/usr` 整个删掉，他自己是重装系统恢复的。维护者当天回复：“GIANT BUG... causing /usr to be deleted... so sorry...”。
- **Steam for Linux，2015 年 1 月。** [issue #3671](https://github.com/ValveSoftware/steam-for-linux/issues/3671)，标题是“Moved ~/.local/share/steam. Ran steam. It deleted everything on system owned by user.”。用户把 Steam 的目录搬到了外接盘上，再启动 Steam，之后发现属于自己的文件几乎全没了，包括挂在 `/media` 下的 3 TB 备份盘。评论区有人贴出了启动脚本里的一行：`rm -rf "$STEAMROOT/"*`，并推测 `STEAMROOT` 在脚本开头那条取脚本所在目录的命令替换里变成了空串。这只是评论者的推测，而那份 issue 有 266 条评论，我没有读完，所以不对触发路径下结论，只拿这一行的参数形状做实验。

先用探针看 Bumblebee 那一行。我当然不会运行 `rm -rf /usr`，只看它会收到什么（路径是我从 issue 里抄来的，想要的版本是 `/usr/lib/nvidia-current/xorg/xorg`）：

```text
$ printf '<%s>\n' /usr /lib/nvidia-current/xorg/xorg
</usr>
</lib/nvidia-current/xorg/xorg>
$ printf '<%s>\n' /usr/lib/nvidia-current/xorg/xorg
</usr/lib/nvidia-current/xorg/xorg>
```

一个多余的空格，一个参数变成两个，第一个就是 `/usr`。这一例里没有变量，没有引号能救你，因为问题出在字面文本上。分词在**写脚本的人**这一侧也发生：你打字时敲出的每个空格，就是一次分词。

Steam 那一行更有意思，因为它的引号是对的。`"$STEAMROOT/"*` 里变量被引号保护，通配符在引号**外**面，这正是 SC2086 的 wiki 推荐的写法。问题在于 `STEAMROOT` 是空串的时候，引号里剩下一个 `/`，后面接一个 `*`，整条就是 `rm -rf /*`。[SC2115](https://www.shellcheck.net/wiki/SC2115) 的 wiki 把 `rm -rf "$STEAMROOT/"*` 原样列为有问题的写法，建议改成 `rm -rf "${STEAMROOT:?}/"*`。`lab/ch02/steam_bug.sh` 把它做成可以安全复现的形式：

```bash
# shellcheck shell=bash
# Shows: what `rm -rf "$STEAMROOT/"*` receives when STEAMROOT is empty
# (the Steam for Linux bug). args.sh is run instead of rm, so nothing is
# deleted. The count of root entries depends on the host.
export LC_ALL=C
args="${CAIRN_ROOT}/lab/ch02/args.sh"
STEAMROOT=''

echo '--- STEAMROOT empty: the pattern becomes /*'
# BAD: the unguarded form, printed only
bash "${args}" -rf "${STEAMROOT}/"*
echo '--- guarded form with :? aborts instead'
(bash "${args}" -rf "${STEAMROOT:?}/"*) 2>&1
echo "status: $?"
```

```text
--- STEAMROOT empty: the pattern becomes /*
argc=18
<-rf>
</bin>
</boot>
</dev>
</etc>
</home>
</lib64>
</lost+found>
</nix>
</opt>
</proc>
</root>
</run>
</srv>
</sys>
</tmp>
</usr>
</var>
--- guarded form with :? aborts instead
/home/bfmhno3/Projects/cairn/lab/ch02/steam_bug.sh: line 13: STEAMROOT: parameter null or not set
status: 1
```

`argc=18`：`-rf` 加上 17 个根目录条目。**这个数字取决于你的机器**：它是你那里 `/` 下的非隐藏条目数加 1，我的是 NixOS，有 `nix` 和 `lib64`，没有 `lib` 和 `sbin`，你的会不一样。（`/*` 不匹配点文件，所以 `/.something` 即使存在也不在里面。）重点是形状：一个程序，被告知“递归、强制”，目标是系统里每一个顶层目录。

`${STEAMROOT:?}` 是第 3 篇会细讲的参数展开形式，意思是“如果为空或未设，打印错误并中止”。这里它让引号里的变量在是空串的时候不再无声无息地变成 `/`，子 shell 以状态 1 终止，`args.sh` 根本没有被调用。issue 评论里有人建议的就是这个，我也认为这是对这一类问题最便宜的保险：这一条记号让“变量不能为空”成为代码里可见的断言，而不是作者心里的假设。

现在让 ShellCheck 看一眼。我把这两起事故和上面那个循环写成一个只用来被检查、从不运行的文件。它是本篇第一个没有带 `# shellcheck disable` 指令的反面教材，因为这次我就是要听 ShellCheck 怎么说：

```bash
#!/usr/bin/env bash
# BAD: deliberately wrong lines, never run.
STEAMROOT=''
rm -rf $STEAMROOT/*
rm -rf "$STEAMROOT/"*
for f in $(ls); do
  echo $f
done
```

```text
$ shellcheck /tmp/demo/bad.sh

In /tmp/demo/bad.sh line 4:
rm -rf $STEAMROOT/*
       ^----------^ SC2115 (warning): Use "${var:?}" to ensure this never expands to /* .
       ^--------^ SC2086 (info): Double quote to prevent globbing and word splitting.

Did you mean:
rm -rf "$STEAMROOT"/*


In /tmp/demo/bad.sh line 5:
rm -rf "$STEAMROOT/"*
       ^------------^ SC2115 (warning): Use "${var:?}" to ensure this never expands to /* .


In /tmp/demo/bad.sh line 6:
for f in $(ls); do
         ^---^ SC2045 (error): Iterating over ls output is fragile. Use globs.


In /tmp/demo/bad.sh line 7:
  echo $f
       ^-- SC2086 (info): Double quote to prevent globbing and word splitting.

Did you mean:
  echo "$f"

For more information:
  https://www.shellcheck.net/wiki/SC2045 -- Iterating over ls output is fragile...
  https://www.shellcheck.net/wiki/SC2115 -- Use "${var:?}" to ensure this nev...
  https://www.shellcheck.net/wiki/SC2086 -- Double quote to prevent globbing ...
```

[SC2086](https://www.shellcheck.net/wiki/SC2086)（“加双引号以防止通配和分词”）在第 4 行和第 7 行响了，而且它的修复建议 `"$STEAMROOT"/*` 是对的。它在第 5 行，也就是 Steam 那一行，**没有**响，因为那一行已经引用好了。取而代之响的是 SC2115：“用 `"${var:?}"` 确保它永远不会展开成 `/*`”。同一类 `rm -rf "$var/"*`，ShellCheck 的建议和 2015 年评论区里的人的建议是一样的。所以这件事的教训不是“记得加引号”，我现在认为是两件事：引号管的是分词和通配符，**不管空值**；而且你不能靠自己的记忆保证这一点，得让工具替你盯着（SC2086 的 wiki 里也承认，它自己有例外，可以用 `# shellcheck disable=` 逐行关闭，我们在实验里就是这么做的，每次都配着 `# BAD`）。

## 数组：保存 argv 的正确容器

上面所有的“不打引号”都有一个共同的动机：我手里有**一串**东西（几个选项、几个路径），想把它们存起来，等会儿传给某个命令。把它们存成一个字符串，是最自然的想法，也是最常出错的想法。`lab/ch02/arrays_argv.sh` 把几种存法放在一起比较：

```bash
# shellcheck shell=bash
# Shows: flags kept in a string versus kept in an array.
args="${CAIRN_ROOT}/lab/ch02/args.sh"
dest='/tmp/my backups'

echo '--- flags in a string, unquoted: the quotes inside are literal'
# shellcheck disable=SC2089 # BAD: deliberate
flags="--exclude='*.tmp' --exclude=.cache --link-dest=${dest}"
# shellcheck disable=SC2086,SC2090 # BAD: deliberate
bash "${args}" ${flags}
echo '--- flags in a string, quoted: one argument'
bash "${args}" "${flags}"
echo '--- flags in an array: one word per element'
flags=(--exclude='*.tmp' --exclude=.cache "--link-dest=${dest}")
bash "${args}" "${flags[@]}"
echo '--- building the array conditionally'
opts=(--archive)
verbose=1
if ((verbose)); then
  opts+=(--verbose)
fi
opts+=(--exclude 'a b')
bash "${args}" "${opts[@]}" src/ "${dest}/"
echo "--- empty array: \"\${opts[@]}\" vanishes, \"\${opts[*]}\" is one word"
opts=()
bash "${args}" "${opts[@]}"
bash "${args}" "${opts[*]}"
```

```text
--- flags in a string, unquoted: the quotes inside are literal
argc=4
<--exclude='*.tmp'>
<--exclude=.cache>
<--link-dest=/tmp/my>
<backups>
--- flags in a string, quoted: one argument
argc=1
<--exclude='*.tmp' --exclude=.cache --link-dest=/tmp/my backups>
--- flags in an array: one word per element
argc=3
<--exclude=*.tmp>
<--exclude=.cache>
<--link-dest=/tmp/my backups>
--- building the array conditionally
argc=6
<--archive>
<--verbose>
<--exclude>
<a b>
<src/>
</tmp/my backups/>
--- empty array: "${opts[@]}" vanishes, "${opts[*]}" is one word
argc=0
argc=1
<>
```

字符串版本有两个相反的失败，而且没有一个中间的写法能同时避开它们。不打引号：**引号字符变成了数据**，`--exclude='*.tmp'` 里的两个单引号被原样传给了程序（rsync 收到的模式带着两个引号字符，多半什么也排除不了），而目标目录 `/tmp/my backups` 被空格切成了两个词。打上引号：整串变成一个参数 `argc=1`，程序会把它当成一个叫“`--exclude='*.tmp' --exclude=...`”的选项。因为**引号是 bash 读命令行时才处理的东西**，它在变量赋值的那一刻已经用完了，存进字符串里的引号只是普通字符，没有人会再回头解释它。

数组没有这个问题：每个元素是一个独立的字符串，引号在**赋值那一行**被处理（所以 `--exclude='*.tmp'` 进数组以后是 `--exclude=*.tmp`，没有引号字符），`"${flags[@]}"` 把每个元素各自变成一个词，不分词，也不展开通配符。`+=(...)` 追加元素，可以按条件拼出一个选项列表，最后的 `bash "${args}" "${opts[@]}" src/ "${dest}/"` 得到 6 个正确的参数，`--exclude` 和它的值 `a b` 也保持是两个独立的词。

最后一对是空数组。`"${opts[@]}"` 和 `"$@"` 行为一致：没有元素就**一个词也不产生** (`argc=0`)；`"${opts[*]}"` 像 `"$*"` 一样把所有元素拼成**一个**词，即使数组为空也是一个空串 (`argc=1`, `<>`)。我在 `set -u` 下试过空数组的 `"${a[@]}"`，在这台 5.3.15 上不会报“未绑定变量”，这个行为在更老的 bash 上不一样，我没有查是从哪个版本开始变的。

Google 指南关于数组的规定很简短，值得原文记住：用数组存列表，特别是命令行选项；用 `"${array[@]}"` 展开；别用字符串存序列，否则作者最终一定会去用 `eval`，或者试图在字符串里嵌套引号，“既不可靠，也不好读”。它还点名了一个反例：`declare -a files=($(ls /directory))`，先把 `ls` 的输出展开成一个字符串，再分词、再展开通配符，最后才变成列表。从命令输出填数组，用上一节的 `mapfile -d '' -t arr < <(find ... -print0)`。

## cairn snapshot 第一版

现在我们有足够的工具来写 Cairn 的第一个会碰用户文件的命令了。这一版故意很小：**没有配置文件**（第 3 篇才有），**没有硬链接**（第 5 篇，现在只是一份完整的拷贝），没有锁，也没有 `.partial` 目录。它要做的只是：`cairn snapshot REPO SOURCE...` 把所有 `SOURCE` 复制进 `REPO/snapshots/<名字>`，打印这个名字。

`bin/cairn` 的改动一共三处。在 `source` 日志库的那一行后面：

```bash
# shellcheck source=../lib/cairn/log.sh
source "${CAIRN_LIB}/log.sh"
# shellcheck source=../lib/cairn/snapshot.sh
source "${CAIRN_LIB}/snapshot.sh"
```

在 `usage()` 的 here-document 里多两行，在 `main` 的 `case` 里多一个分支：

```bash
    snapshot)
      shift
      cairn::snapshot::create "$@"
      ;;
```

`shift` 把 `snapshot` 这个子命令自己从位置参数里去掉，剩下的 `REPO SOURCE...` 用 `"$@"` 原封不动地传给函数：这是整个转发链上唯一该用的写法，参数里有空格、有空串、有 `-rf`，都不会被动。`lib/cairn/snapshot.sh` 是新文件，它的头部和第一个函数：

```bash
# shellcheck shell=bash
# Snapshot helpers for cairn. Library: sourced by bin/cairn, not executed.
#
# Version 1 (chapter 2): a plain rsync copy, no config, no hard links.

#######################################
# Print the name of a new snapshot.
# Globals:
#   CAIRN_NOW
# Outputs:
#   Writes the UTC timestamp name (CAIRN_NOW if set) to stdout.
# Returns:
#   0 on success, 2 if CAIRN_NOW is malformed.
#######################################
cairn::snapshot::name() {
  if [[ -n "${CAIRN_NOW:-}" ]]; then
    if [[ ! "${CAIRN_NOW}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
      cairn::log::err 'CAIRN_NOW must look like 20261031T090000Z'
      return 2
    fi
    printf '%s\n' "${CAIRN_NOW}"
    return 0
  fi
  printf '%(%Y%m%dT%H%M%SZ)T\n' -1
}
```

快照的名字是一个 UTC 时间戳，形如 `20261031T090000Z`。环境变量 `CAIRN_NOW` 如果设了，就用它当名字，这样测试和实验可以得到确定的名字，不依赖时钟。几处细节：

- `"${CAIRN_NOW:-}"`：`bin/cairn` 开了 `set -o nounset`，没设的变量直接引用会中止脚本。`:-` 给它一个空串默认值，这里是第 3 篇才系统讲的参数展开形式，现在只要知道“未设就当空”。
- `[[ ! "${CAIRN_NOW}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]`：`[[ ]]` 里右边的正则**不要**加引号，加了就变成字面比较（Google 指南里专门有一段写这个）；`[[ ]]` 里也不需要为左边担心分词。`$` 在正则里是行尾锚，不是变量，它在 `]]` 之前，不会被误当作参数展开。
- `printf '%(%Y%m%dT%H%M%SZ)T\n' -1`：`printf` 内建自己格式化时间，`-1` 表示“现在”，不需要 fork 一个 `date`。第 1 篇量过：一次内建调用 1.4 微秒，一次外部程序 1.39 毫秒。

第二个函数是主体：

```bash
#######################################
# Copy SOURCE... into REPO/snapshots/<name> with rsync.
# Arguments:
#   Repository directory, one or more source paths.
# Outputs:
#   Writes the snapshot name to stdout.
# Returns:
#   0 on success, 2 on usage errors, 1 if rsync fails.
#######################################
cairn::snapshot::create() {
  if (($# < 2)); then
    cairn::log::err 'usage: cairn snapshot REPO SOURCE...'
    return 2
  fi
  local repo="$1"
  shift
  local name
  name="$(TZ=UTC cairn::snapshot::name)" || return 2
  local dest="${repo}/snapshots/${name}"
  local -a rsync_args=(--archive --relative -- "$@" "${dest}/")

  mkdir -p -- "${repo}/snapshots" || return 1
  if ! rsync "${rsync_args[@]}"; then
    cairn::log::err 'rsync failed'
    return 1
  fi
  printf '%s\n' "${name}"
}
```

最值得看的是那一行数组：`local -a rsync_args=(--archive --relative -- "$@" "${dest}/")`。它把所有东西装进一个数组：两个固定选项，`--`，调用者传来的全部 `SOURCE`（这里 `"$@"` 在数组里展开成每个参数一个元素，和在命令行上一样），最后是目标目录。之后 `rsync "${rsync_args[@]}"` 一次展开。它之所以必须是数组，是因为 `SOURCE` 的个数在写代码的时候不知道，每一个都可能有空格；它必须有 `--`，因为 `SOURCE` 可能叫 `-rf`。后者我直接在命令行上试过 rsync：

```text
$ cd /tmp/tree
$ rsync --archive --relative -rf /tmp/demo/d/; echo "rc=$?"
Unknown filter rule: `/tmp/demo/d/'
rsync error: syntax or usage error (code 1) at exclude.c(1213) [client=3.4.4]
rc=1
$ rsync --archive --relative -- -rf /tmp/demo/d/; echo "rc=$?"
rc=0
$ ls -A /tmp/demo/d
-rf
```

没有 `--`，rsync 把 `-rf` 解析成了 `-r` 和 `-f`（`-f` 是“加一条过滤规则”，它把后面的目标目录吃掉当成规则，于是报错）。加了 `--`，文件 `-rf` 被当成源文件，复制进了目标目录。`--relative` 的作用是让目标里保留源的完整路径，所以两个不同目录下的同名条目不会撞车，代价是目标里多了一串前缀目录：下面马上能看到。`--archive` 是 `-rlptgoD` 的简写（递归、保留符号链接、权限、时间、属主、设备），这是 rsync 自己的帮助里写的。

另外两处风格要点：`local name` 和 `name="$(...)"` 分成两行，是因为 `local name="$(cmd)"` 会让 `local` 的退出状态（成功时是 0）盖住 `cmd` 的退出状态，后面的 `|| return 2` 就失效了，所以我们的 `docs/code-style.md` 里（出自 Google 指南）要求分开写；`TZ=UTC cairn::snapshot::name` 在函数调用前加一个临时变量赋值，让这次调用里的 `printf '%(...)T'` 按 UTC 取时间。我在 `TZ=Asia/Shanghai` 下验证了它：

```text
$ export TZ=Asia/Shanghai
$ date '+local  %Y%m%dT%H%M%S'; date -u '+utc    %Y%m%dT%H%M%SZ'
local  20261031T231321
utc    20261031T151321Z
$ bin/cairn snapshot /tmp/demo/repo4 /tmp/tree
20261031T151321Z
```

名字是 UTC 的，不是本地时间的，和 `date -u` 同一秒。

把显微镜对准 `cairn` 自己。`PS4` 里带上文件名和行号，参数里放一个带空格的路径：

```text
$ CAIRN_NOW=20261101T000000Z PS4='+ ${BASH_SOURCE##*/}:${LINENO}: ' bash -x bin/cairn snapshot /tmp/demo/repo6 "/tmp/tree/with space.txt" 2>&1 | grep -v '^++ '
+ cairn:8: set -o nounset
+ cairn:10: readonly CAIRN_VERSION=0.1.0
+ cairn:10: CAIRN_VERSION=0.1.0
+++ cairn:13: readlink -f -- bin/cairn
+ cairn:13: CAIRN_LIB=/home/bfmhno3/Projects/cairn/bin/../lib/cairn
+ cairn:14: readonly CAIRN_LIB
+ cairn:17: source /home/bfmhno3/Projects/cairn/bin/../lib/cairn/log.sh
+ cairn:19: source /home/bfmhno3/Projects/cairn/bin/../lib/cairn/snapshot.sh
+ cairn:74: main snapshot /tmp/demo/repo6 '/tmp/tree/with space.txt'
+ cairn:51: (( 3 == 0 ))
+ cairn:55: case "$1" in
+ cairn:63: shift
+ cairn:64: cairn::snapshot::create /tmp/demo/repo6 '/tmp/tree/with space.txt'
+ snapshot.sh:37: (( 2 < 2 ))
+ snapshot.sh:41: local repo=/tmp/demo/repo6
+ snapshot.sh:42: shift
+ snapshot.sh:43: local name
+ snapshot.sh:44: name=20261101T000000Z
+ snapshot.sh:45: local dest=/tmp/demo/repo6/snapshots/20261101T000000Z
+ snapshot.sh:46: rsync_args=('--archive' '--relative' '--' '/tmp/tree/with space.txt' '/tmp/demo/repo6/snapshots/20261101T000000Z/')
+ snapshot.sh:46: local -a rsync_args
+ snapshot.sh:48: mkdir -p -- /tmp/demo/repo6/snapshots
+ snapshot.sh:49: rsync --archive --relative -- '/tmp/tree/with space.txt' /tmp/demo/repo6/snapshots/20261101T000000Z/
+ snapshot.sh:53: printf '%s\n' 20261101T000000Z
20261101T000000Z
```

（`grep -v '^++ '` 去掉了命令替换内部的 `++` 行，它们和参数的转发无关。）整条转发链都在这里：`main` 收到三个词，`'/tmp/tree/with space.txt'` 是**一个**，带着引号；`shift` 之后 `cairn::snapshot::create` 收到两个；第 46 行的数组有 6 个元素，带空格的那个仍然是一个元素；最后真正的 `rsync` 命令行里它依然是一个词。第 74 行的 `main "$@"` 在跟踪里是 `main snapshot ...`，`$@` 已经被展开了，所以 `set -x` 看不到 `"$@"` 这个写法本身，只看得到它的后果。

跑一下，用 `CAIRN_NOW` 固定名字：

```text
$ CAIRN_NOW=20261101T000000Z bin/cairn snapshot /tmp/demo/repo /tmp/tree
20261101T000000Z
$ find /tmp/demo/repo -mindepth 1 -maxdepth 2 | LC_ALL=C sort
/tmp/demo/repo/snapshots
/tmp/demo/repo/snapshots/20261101T000000Z
$ find /tmp/demo/repo/snapshots/20261101T000000Z -mindepth 1 -print0 | LC_ALL=C sort -z | xargs -0 printf '%q\n' | head -n 6
/tmp/demo/repo/snapshots/20261101T000000Z/tmp
/tmp/demo/repo/snapshots/20261101T000000Z/tmp/tree
/tmp/demo/repo/snapshots/20261101T000000Z/tmp/tree/-rf
/tmp/demo/repo/snapshots/20261101T000000Z/tmp/tree/.hidden
/tmp/demo/repo/snapshots/20261101T000000Z/tmp/tree/empty_dir
/tmp/demo/repo/snapshots/20261101T000000Z/tmp/tree/link_to_plain
$ ls -l /tmp/demo/repo/snapshots/20261101T000000Z/tmp/tree/link_to_plain
lrwxrwxrwx 1 bfmhno3 users 9 Oct 31 08:13 /tmp/demo/repo/snapshots/20261101T000000Z/tmp/tree/link_to_plain -> plain.txt
```

快照里有 `tmp/tree/...`，这是 `--relative` 保留下来的 `/tmp/tree` 路径，`-rf` 和 `.hidden` 都在，符号链接还是符号链接（`--archive` 里的 `l`）。用户错误也都有明确的出口：

```text
$ bin/cairn snapshot; echo "rc=$?"
cairn: error: usage: cairn snapshot REPO SOURCE...
rc=2
$ CAIRN_NOW=bogus bin/cairn snapshot /tmp/demo/repo /tmp/tree; echo "rc=$?"
cairn: error: CAIRN_NOW must look like 20261031T090000Z
rc=2
```

一个参数、零个参数都是用法错误（退出码 2，和第 1 篇的约定一致）。而这一版**不检查快照是否已经存在**：对同一个 `CAIRN_NOW` 再跑一遍，它安静地退出码 0，把文件合并进了已有的目录（我试过，输出还是 `20261101T000000Z`，rc=0）。后面的版本会拒绝这种情况，这一版没有，我就在这里写明，免得你以为它有。

`lab/ch02/snapshot_tricky.sh` 把整个流程变成一个自动检查：

```bash
# shellcheck shell=bash
# Shows: cairn snapshot copies every entry of the make_tree fixture,
# including names with spaces, a leading dash, a newline and a symlink.
# Exit 1 if the find -print0 counts of source and snapshot differ.
export LC_ALL=C

count_entries() {
  find "$1" -mindepth 1 -print0 | tr -cd '\0' | wc -c
}

src="${LAB_TMP}/tree"
repo="${LAB_TMP}/repo"
bash "${CAIRN_ROOT}/scripts/make_tree.sh" "${src}" || exit 1

name="$(CAIRN_NOW=20261101T000000Z cairn snapshot "${repo}" "${src}")" \
  || exit 1
echo "snapshot name: ${name}"
copy="${repo}/snapshots/${name}${src}"

src_count="$(count_entries "${src}")"
copy_count="$(count_entries "${copy}")"
echo "source entries:   ${src_count}"
echo "snapshot entries: ${copy_count}"
if ((src_count != copy_count)); then
  echo 'MISMATCH' >&2
  exit 1
fi
echo 'counts match'
```

```text
snapshot name: 20261101T000000Z
source entries:   13
snapshot entries: 13
counts match
```

13 对 13，不匹配时实验以 1 退出，运行器会当成失败。`copy="${repo}/snapshots/${name}${src}"` 这一行是 `--relative` 的另一面：源路径整个接在快照名后面。这个实验在 `"$@"` 的转发链、数组、`--` 三处都挨了一遍：任何一处丢了引号，13 就不会等于 13。

## Google 的引用规则，以及为什么是 `"${var}"`

到这里，`docs/code-style.md` 里“展开与引用”那一条的每一个词我们都碰过了：

> 引用每一个展开；写 `"${var}"`，但 `$1`、`$@`、`$?`、`$#`、`$$`、`$!` 不加花括号（`${10}` 需要）。`"$@"` 传参数。参数列表放进数组，用 `"${array[@]}"` 展开。`$(command)`，不用反引号。

Google 指南的 [Quoting](https://google.github.io/styleguide/shellguide.html#s5.7-quoting) 一节列出几条：含变量、命令替换、空格或元字符的字符串，总是加引号，除非你明确需要未加引号的展开；列表用数组；优先 `"$@"` 而不是 `$*`，原话是 `Use "$@" unless you have a specific reason to use $*, such as simply appending the arguments to a string in a message or log.`；`$?`、`$#`、`$$`、`$!` 这些 shell 内部的整数可以不加引号，但“命名的”内部变量，例如 `PPID`，最好加，求一致。

[Variable expansion](https://google.github.io/styleguide/shellguide.html#s5.6-variable-expansion) 一节规定了花括号：与已有风格一致，先于引号变量，其次才是偏爱 `"${var}"` 而不是 `"$var"`；单个字符的特殊参数和位置参数不加花括号。它还有一个提示框：**花括号不是引用**，双引号必须**同时**加。我花了一些时间想“为什么是 `"${var}"`”，试出来的理由有这几条。

**边界。** `${w}_old` 和 `$w_old` 是两回事，后者读的是名叫 `w_old` 的变量：

```text
$ w=x; echo "[$w_old]" "[${w}_old]"
[] [x_old]
$ bash -c 'set -u; w=x; echo "$w_old"'; echo "rc=$?"
bash: line 1: w_old: unbound variable
rc=127
```

没开 `nounset`，`$w_old` 是空串，没有任何报错；开了，才能立刻发现问题。同一个位置参数的例子更典型：`set -- a b c` 之后 `"$10"` 读的不是第 10 个参数，而是 `$1` 后面跟一个 `0`：

```text
$ set -- a b c; echo "$10$20$30"; echo "${1}0${2}0${3}0"
a0b0c0
a0b0c0
```

两行输出一样，这是 Google 指南里那个“令人困惑的用法”，要取第 10 个位置参数必须写 `${10}`，这也是指南说“花括号必要”的唯一情形。

**统一。** `"${var}"` 永远成立，不用每次判断“这个变量后面会不会紧跟字母或下划线”。我找不出一个 `"${var}"` 比 `"$var"` 在引用安全性上更好的例子，所以它的价值不在保护，在不用动脑子。

**不是引用。** 花括号对 `v='a b'; printf '<%s>\n' ${v}` 没有任何帮助，仍然是两个词。`${v}` 只防边界，防不了分词。很容易写出满是 `${var}` 却没有一对引号的脚本，看起来很规范，实际上一点保护也没有。

指南里还有两条与此有关的规则，这一篇的代码已经遵守了：**测试用 `[[ ... ]]`**（不分词、不展开通配符）和**通配符用显式路径 `./*`**。还有一条这一篇没有用上，但每次看到都想起：**避免 `eval`**，因为它把整个字符串再过一遍上面这条流水线，所有引号问题又回来一次。

## 几件让我意外的事

**`set -x` 是一个引用调试器。** 我原来把它当成“打印我执行了什么”的工具。实验里它真正好用的地方是：它打印的是 bash **重新加了引号之后**的词，`'x y'` 和 `x y` 的区别直接告诉你一个词有没有被切开。接下来每次遇到“为什么这个命令收到的参数不对”，第一步我都会先开 `set -x`，而不是对着代码猜。

**两起事故里没有一起是“忘了打引号”。** 我写这一篇之前的印象是，这类事故的原因是不加引号。实际上我读了 Bumblebee 的全文和 Steam 的部分评论，再看 ShellCheck 的反应：Bumblebee 是字面文本里多了一个空格；Steam 那一行引号是对的，按评论者的推测是变量为空（这个原因我没有验证）。引号是必要的，但是不够，防御是三层：引号管分词，`${var:?}` 管空值，工具和审查管“你自己没看见”的那一行。我猜这也是为什么有经验的人写 `rm` 之前会有一个停顿。

**探针本身也有盲点。** `printf '<%s>\n'` 对“零个参数”和“一个空参数”给出同样的输出，我是看着 `<>` 想了好几分钟才明白的。所以 `args.sh` 先打印 `argc`。我的猜测是，shell 里几乎每个“看起来对”的调试方法都有这样的盲点，这一点值得对每个新工具重新问一遍：它在什么情况下会把两种不同的情况显示成一样的？

写完这一篇，我对“shell 为什么这么设计”有一个并不确定的猜测：展开是为交互设计的。你在终端里敲 `ls *.txt`，希望它“就是能用”，没有人想在一次性命令里写 `"$HOME"/"${dir}"/"${file}"`。脚本继承了交互式的默认，却没有继承交互式的容错：你敲错了，立刻看到；脚本错了，可能是三个月后在别人的机器上，而且是 `rm -rf`。如果这个猜测对，那么整个系列里每一条 Google 规则，大概都是在把交互式的默认值一条一条换成脚本该有的默认值。

## 检查点

先把参考仓库更新到带 `ch02` 标签的状态（你在第 1 篇克隆过 `~/cairn-ref`，只需要拉标签）：

```bash
git -C ~/cairn-ref fetch --tags
```

在 `~/cairn` 下：

```bash
make ch02
make -s lint
```

`make ch02` 应当打印这 13 行（有没有设 `CI` 都一样，这一章没有只在宿主机上跑的实验）：

```text
bash scripts/chapter.sh ch02
ok   lab/ch02/args.sh
ok   lab/ch02/arrays_argv.sh
ok   lab/ch02/at_vs_star.sh
ok   lab/ch02/dash_filename.sh
ok   lab/ch02/ex_count_args.sh
ok   lab/ch02/expansion_order.sh
ok   lab/ch02/glob_options.sh
ok   lab/ch02/nasty_names.sh
ok   lab/ch02/quotes.sh
ok   lab/ch02/snapshot_tricky.sh
ok   lab/ch02/steam_bug.sh
ok   lab/ch02/word_splitting.sh
```

`make -s lint` 什么都不输出，退出码 0（ShellCheck 0.11.0 和 `shfmt -i 2 -bn -ci -d` 都安静）。再亲手备份一次夹具树，两边的条目数应当一样：

```text
$ scripts/make_tree.sh /tmp/cairn-check/src && CAIRN_NOW=20261101T000000Z bin/cairn snapshot /tmp/cairn-check/repo /tmp/cairn-check/src
20261101T000000Z
$ find /tmp/cairn-check/src -mindepth 1 -print0 | tr -cd '\0' | wc -c
13
$ find /tmp/cairn-check/repo/snapshots/20261101T000000Z/tmp/cairn-check/src -mindepth 1 -print0 | tr -cd '\0' | wc -c
13
```

**必须和标签一致的文件：** `scripts/make_tree.sh`，以及 `lab/ch02/` 下全部 12 个实验脚本。它们已经是最终版本。第 1 篇列的那些最终文件（`flake.nix`、`flake.lock`、`.envrc`、`.gitignore`、`.shellcheckrc`、`scripts/chapter.sh`、`lab/ch01/` 下的脚本）这一章没有碰。一次验证新的这 13 个：

```bash
for f in scripts/make_tree.sh lab/ch02/*.sh; do
  diff <(git -C ~/cairn-ref show ch02:"${f}") "${f}" && echo "same ${f}"
done
```

每个文件应当打印一行 `same ...`，共 13 行，不打印 diff：

```text
same scripts/make_tree.sh
same lab/ch02/args.sh
same lab/ch02/arrays_argv.sh
same lab/ch02/at_vs_star.sh
same lab/ch02/dash_filename.sh
same lab/ch02/ex_count_args.sh
same lab/ch02/expansion_order.sh
same lab/ch02/glob_options.sh
same lab/ch02/nasty_names.sh
same lab/ch02/quotes.sh
same lab/ch02/snapshot_tricky.sh
same lab/ch02/steam_bug.sh
same lab/ch02/word_splitting.sh
```

`diff` 不比较权限位。`scripts/make_tree.sh` 在标签里有可执行位，你的副本要 `chmod +x`；`lab/ch02/` 下的脚本都不是可执行的，运行器用 `bash` 启动它们。标签里有可执行位的文件一共四个：

```text
$ git -C ~/cairn-ref ls-tree -r ch02 | grep '^100755' | cut -f2
bin/cairn
lab/ch01/shebang_exec.sh
scripts/chapter.sh
scripts/make_tree.sh
```

**中间版本（后面的章节会继续改）：**

- [`bin/cairn`](https://github.com/bfmhno3/cairn/blob/ch02/bin/cairn)：现在是 74 行，比第 1 篇多出 `source` 一行（加上 ShellCheck 的指令是两行）、用法文本里的两行和 `snapshot)` 分支。第 3 篇加 `-c`/`--config` 和 `init`，第 4 篇写完整的选项解析和命令分发，第 7 篇加 `errexit`、`ERR` 陷阱和锁。
- [`lib/cairn/snapshot.sh`](https://github.com/bfmhno3/cairn/blob/ch02/lib/cairn/snapshot.sh)：现在是第一版，54 行，只有 `cairn::snapshot::name` 和 `cairn::snapshot::create`；`create` 还不读配置，没有硬链接，没有 `.partial`，没有锁。它会在第 3、5、7 篇逐步长成最终形态。
- [`README.md`](https://github.com/bfmhno3/cairn/blob/ch02/README.md)：`Layout` 一节里 `scripts/` 那一行多了 `fixture generator (make_tree.sh)`，以后每多一个顶层目录或脚本它还会更新。

### 文件清单

这一篇新增或修改的 16 个文件 (`git diff --name-only ch01 ch02`) 都在这里，链接指向标签 `ch02` 上的那一份。实验需要沙箱目录和 `CAIRN_ROOT`，所以它们的命令都是 `make ch02`；`args.sh` 和 `ex_count_args.sh` 也可以在 `~/cairn` 下直接运行，后者需要自己提供 `CAIRN_ROOT`。结果列是我在 Bash 5.3.15 下实际跑出来的，实验的退出码都是 0。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`README.md`](https://github.com/bfmhno3/cairn/blob/ch02/README.md) | `-` | `Layout` 里 `scripts/` 一行多了 `fixture generator (make_tree.sh)`；不是脚本 |
| [`bin/cairn`](https://github.com/bfmhno3/cairn/blob/ch02/bin/cairn) | `bin/cairn snapshot` | 退出码 2，`cairn: error: usage: cairn snapshot REPO SOURCE...`；给两个以上参数时退出码 0，打印快照名 |
| [`lib/cairn/snapshot.sh`](https://github.com/bfmhno3/cairn/blob/ch02/lib/cairn/snapshot.sh) | `-` | 被 `bin/cairn` 引用，不单独运行 |
| [`scripts/make_tree.sh`](https://github.com/bfmhno3/cairn/blob/ch02/scripts/make_tree.sh) | `scripts/make_tree.sh /tmp/tree` | 退出码 0，造出 13 个条目；目录非空时退出码 1，`make_tree.sh: /tmp/tree is not empty` |
| [`lab/ch02/args.sh`](https://github.com/bfmhno3/cairn/blob/ch02/lab/ch02/args.sh) | `bash lab/ch02/args.sh a 'b c' ''` | 退出码 0，第一行 `argc=3`；被运行器单独跑时输出 `argc=0` |
| [`lab/ch02/arrays_argv.sh`](https://github.com/bfmhno3/cairn/blob/ch02/lab/ch02/arrays_argv.sh) | `make ch02` | 退出码 0；字符串版本 `argc=4`，数组版本 `argc=3`，空数组 `"${opts[@]}"` 为 `argc=0` |
| [`lab/ch02/at_vs_star.sh`](https://github.com/bfmhno3/cairn/blob/ch02/lab/ch02/at_vs_star.sh) | `make ch02` | 退出码 0；`"$@"` 为 `argc=3`（含一个空参数），`"$*"` 为 `argc=1`，内容 `one two words ` |
| [`lab/ch02/dash_filename.sh`](https://github.com/bfmhno3/cairn/blob/ch02/lab/ch02/dash_filename.sh) | `make ch02` | 退出码 0；`*` 展开成 4 个词且第一个是 `-rf`，`./*` 的每个词以 `./` 开头 |
| [`lab/ch02/ex_count_args.sh`](https://github.com/bfmhno3/cairn/blob/ch02/lab/ch02/ex_count_args.sh) | `CAIRN_ROOT="$PWD" bash lab/ch02/ex_count_args.sh` | 退出码 0；四段 `argc=3`、`argc=4`、`argc=1`、`argc=3`，练习 1 |
| [`lab/ch02/expansion_order.sh`](https://github.com/bfmhno3/cairn/blob/ch02/lab/ch02/expansion_order.sh) | `make ch02` | 退出码 0；8 个阶段加 `{1..$n}` 一段，最后一段 `<{1..3}>` |
| [`lab/ch02/glob_options.sh`](https://github.com/bfmhno3/cairn/blob/ch02/lab/ch02/glob_options.sh) | `make ch02` | 退出码 0；stderr 有 `no match: ./*.nope`（`failglob` 的报错），`subshell status: 1` |
| [`lab/ch02/nasty_names.sh`](https://github.com/bfmhno3/cairn/blob/ch02/lab/ch02/nasty_names.sh) | `make ch02` | 退出码 0；顶层 10 个条目，`for f in $(ls)` 迭代 11 次，整棵树 13 个条目 |
| [`lab/ch02/quotes.sh`](https://github.com/bfmhno3/cairn/blob/ch02/lab/ch02/quotes.sh) | `make ch02` | 退出码 0；第一段 `<hello $name \n $(date)>`，最后一段 `argc=2` |
| [`lab/ch02/snapshot_tricky.sh`](https://github.com/bfmhno3/cairn/blob/ch02/lab/ch02/snapshot_tricky.sh) | `make ch02` | 退出码 0；`source entries:   13`、`snapshot entries: 13`、`counts match`；两边不等时退出码 1 |
| [`lab/ch02/steam_bug.sh`](https://github.com/bfmhno3/cairn/blob/ch02/lab/ch02/steam_bug.sh) | `make ch02` | 退出码 0；`argc=18`（取决于宿主机 `/` 下的条目数，我的是 17 个加 `-rf`），`${STEAMROOT:?}` 版本报 `parameter null or not set`，`status: 1` |
| [`lab/ch02/word_splitting.sh`](https://github.com/bfmhno3/cairn/blob/ch02/lab/ch02/word_splitting.sh) | `make ch02` | 退出码 0；`${file}` 未加引号为 `argc=2`，空变量未加引号为 `argc=0` |

## 练习

**1.** 下面四行，每一行作为命令的参数列表 (`cmd LINE`)，展开之后 `cmd` 会收到几个参数？先预测，再用 `lab/ch02/ex_count_args.sh` 验证：

- `a b "c d"`
- `{a,b}{1,2}`
- `"$HOME"/*.nothing`
- `$(echo x  y) ""`

<details>
<summary>参考答案</summary>

答案就是 [`lab/ch02/ex_count_args.sh`](https://github.com/bfmhno3/cairn/blob/ch02/lab/ch02/ex_count_args.sh)，它的默认输入就是这四行。它把每一行拼在 `set --` 后面交给一个子 bash，让 bash 按真实命令那样展开，再用 `args.sh` 打印结果（只运行你自己敲的行，因为它会真的展开命令替换）：

```bash
# shellcheck shell=bash
# shellcheck disable=SC2016 # the lines are expanded by the child bash
# Exercise solution: how many arguments does `cmd LINE` receive after
# expansion? Each LINE is pasted after `set --` in a child bash, which
# expands it exactly as it would for a real command, and args.sh prints
# the result. Only run lines you typed yourself.
# Usage: ex_count_args.sh 'LINE'...
if (($# == 0)); then
  set -- 'a b "c d"' '{a,b}{1,2}' '"$HOME"/*.nothing' '$(echo x  y) ""'
fi
export ARGS_SH="${CAIRN_ROOT}/lab/ch02/args.sh"
for line in "$@"; do
  printf '=== cmd %s\n' "${line}"
  bash -c "set -- ${line}; bash \"\${ARGS_SH}\" \"\$@\""
done
```

```text
=== cmd a b "c d"
argc=3
<a>
<b>
<c d>
=== cmd {a,b}{1,2}
argc=4
<a1>
<a2>
<b1>
<b2>
=== cmd "$HOME"/*.nothing
argc=1
</home/bfmhno3/*.nothing>
=== cmd $(echo x  y) ""
argc=3
<x>
<y>
<>
```

第一行：`a`、`b`，加上引号里的 `c d`，3 个。第二行：花括号展开 2 × 2 = 4 个。第三行：`"$HOME"` 被展开，但后面的 `/*.nothing` 在引号**外**面，是通配符，没有匹配，所以保持原样，1 个（这正是默认情况下“没有匹配保留模式”的表现）。第四行：命令替换的结果 `x  y` 未加引号，被切成 `x` 和 `y`（中间的两个空格只算一个分隔），加上显式的空参数 `""`，3 个。

</details>

**2.** 写一个函数 `count_entries DIR`，打印 `DIR` 下一层所有条目的个数，隐藏文件和怪名字都算，空目录打印 0。不许用 `ls`。

<details>
<summary>参考答案</summary>

```bash
#!/usr/bin/env bash
#
# Prints how many entries DIR has, hidden ones and odd names included.
#
# Usage: ex_entries.sh DIR

#######################################
# Count the entries directly inside a directory.
# Arguments:
#   Directory path.
# Outputs:
#   Writes the count to stdout.
#######################################
count_entries() {
  local -a entries
  shopt -s dotglob nullglob
  entries=("$1"/*)
  printf '%d\n' "${#entries[@]}"
}

count_entries "$1"
```

我把它存成 `/tmp/demo/ex_entries.sh`，ShellCheck 和 `shfmt -i 2 -bn -ci -d` 都没有输出。在夹具树和空目录上：

```text
$ bash /tmp/demo/ex_entries.sh /tmp/tree
10
$ bash /tmp/demo/ex_entries.sh /tmp/tree/empty_dir
0
```

`dotglob` 让 `*` 包含点文件（这样 `.hidden` 也算），`nullglob` 让空目录的 `"$1"/*` 展开成零个元素，而不是字面量 `/tmp/tree/empty_dir/*`，所以数出来是 0 而不是 1。`"$1"/*` 把变量加了引号、通配符留在引号外，`entries` 数组里每个元素是一个完整的名字，包括那个带换行的。`shopt` 在函数里设置会留在整个 shell 里；这是个独立的小脚本，没问题，要在库函数里写，就得在函数里恢复它。

</details>

**3.** 下面这个脚本被 ShellCheck 报了 5 条（其中一条是 error；和上面一样，它故意没有带 `disable` 指令），实际运行起来对夹具树也是错的。找出每个问题并改写，改写后 ShellCheck 和 `shfmt -i 2 -bn -ci -d` 都不应有输出：

```bash
#!/usr/bin/env bash
# BAD: the exercise, a copy loop with four problems.
src=$1
dest=$2
for f in $(ls $src); do
  cp $src/$f $dest
done
```

<details>
<summary>参考答案</summary>

先看 ShellCheck 怎么说：

```text
$ shellcheck ex_bad.sh

In ex_bad.sh line 5:
for f in $(ls $src); do
         ^--------^ SC2045 (error): Iterating over ls output is fragile. Use globs.
              ^--^ SC2086 (info): Double quote to prevent globbing and word splitting.

Did you mean:
for f in $(ls "$src"); do


In ex_bad.sh line 6:
  cp $src/$f $dest
     ^--^ SC2086 (info): Double quote to prevent globbing and word splitting.
          ^-- SC2086 (info): Double quote to prevent globbing and word splitting.
             ^---^ SC2086 (info): Double quote to prevent globbing and word splitting.

Did you mean:
  cp "$src"/"$f" "$dest"

For more information:
  https://www.shellcheck.net/wiki/SC2045 -- Iterating over ls output is fragi...
  https://www.shellcheck.net/wiki/SC2086 -- Double quote to prevent globbing ...
```

实际运行（`/tmp/tree` 里有 10 个顶层条目，目标目录是空的）：

```text
$ bash ex_bad.sh /tmp/tree out2; echo "rc=$?"
cp: -r not specified; omitting directory '/tmp/tree/empty_dir'
cp: -r not specified; omitting directory '/tmp/tree/nested'
cp: cannot stat '/tmp/tree/new': No such file or directory
cp: cannot stat '/tmp/tree/line.txt': No such file or directory
cp: cannot stat '/tmp/tree/with': No such file or directory
cp: cannot stat '/tmp/tree/space.txt': No such file or directory
rc=0
$ find out2 -mindepth 1 -maxdepth 1 -print0 | tr -cd '\0' | wc -c
5
```

问题有四个：遍历 `ls` 的输出（带空格和换行的名字被切碎，点文件被漏掉）；`$src` 没加引号（源目录名里有空格就会坏）；`$f` 没加引号；`$dest` 没加引号。结果是顶层 10 个条目只复制了 5 个：`ls` 只给出 9 个名字，`.hidden` 根本不在其中；循环迭代 11 次，两个目录被省略，两个名字被切成四块、四块都找不到，剩下 5 次复制成功。而且退出码仍然是 0：脚本没有检查 `cp` 的返回值，是最糟的那种出错。改写：

```bash
#!/usr/bin/env bash
#
# Copies every entry of SRC, hidden ones included, into DEST.
#
# Usage: ex_copy_all.sh SRC DEST

#######################################
# Copy every entry of a directory into another directory.
# Arguments:
#   Source directory, destination directory.
# Returns:
#   0 on success, 1 if a copy fails.
#######################################
copy_all() {
  local src="$1"
  local dest="$2"
  local f
  shopt -s dotglob nullglob
  for f in "${src}"/*; do
    cp -R -- "${f}" "${dest}/" || return 1
  done
}

copy_all "$1" "$2"
```

```text
$ bash ex_copy_all.sh /tmp/tree out; echo "rc=$?"
rc=0
$ find out -mindepth 1 -maxdepth 1 -print0 | tr -cd '\0' | wc -c
10
```

用通配符代替 `ls`，`dotglob` 补上点文件，`"${src}"/*` 的变量引起来，`cp -R -- "${f}"` 里的 `--` 保护 `-rf` 这样的名字（`"${src}"/*` 展开后每个词都以 `${src}/` 开头，其实已经不会以 `-` 开头了，这里的 `--` 是保险；真正的隐患是 `src` 为空的时候 `"${src}"/*` 就是 `/*`，和 Steam 一样，防御是第 3 篇的 `${src:?}`），`|| return 1` 检查返回值。10 个条目全部复制，ShellCheck 和 `shfmt` 都没有输出。

</details>

**4.** `IFS=: read -r -a parts <<<'a::b:'` 之后，`parts` 里有几个元素？分别是什么？`IFS=: read -r -a parts <<<'a b:c d'` 呢？

<details>
<summary>参考答案</summary>

```text
$ IFS=: read -r -a parts <<<'a::b:'; echo "${#parts[@]}"; printf '<%s>\n' "${parts[@]}"
3
<a>
<>
<b>
$ IFS=: read -r -a parts <<<'a b:c d'; echo "${#parts[@]}"
2
```

第一个是 3 个元素：`a`、一个空串、`b`。`IFS` 里有非空白字符 `:` 时，相邻的两个 `:` 之间是一个空字段（手册：“相邻的非 IFS 空白分隔符产生一个空字段”），所以 `a::b` 里有一个 `<>`；结尾的那个 `:` 后面没有字段，没有产生第四个元素。第二个是 2 个元素，`a b` 和 `c d`：`IFS` 只剩 `:`，空格不再是分隔符。这也是处理 `PATH` 这样冒号分隔的列表的标准写法，而空字段在 `PATH` 里有真实含义（空项表示当前目录），这个例子我留给你查手册。

</details>

## 下一篇

`cairn snapshot REPO SOURCE...` 现在能把一棵有毒的目录备份下来，可是每次都要在命令行上敲出 `REPO` 和所有的 `SOURCE`。真正的备份工具会有一个配置文件：仓库在哪、备份哪些目录、排除什么、保留几份。配置文件要怎么读？最省事的做法是 `source` 它，把它当成一个 shell 脚本，而这一篇的两起事故都在提醒，让 shell 去解释一行它自己展开的文本是一件危险的事：一个值里的 `$(...)` 就会被执行。所以第 3 篇我们会用 `read` 一行一行读它，自己解析，而这需要一整套我们还没有用过的工具：变量到底是什么、`declare`、环境变量与普通变量的区别、`${var:-default}`、`${var#prefix}`、`${var//a/b}` 这样的参数展开运算符、关联数组、`set -u`。第 3 篇，变量与参数展开：一门只有字符串的语言，我们让 `cairn init` 写出第一份配置，再让 `cairn` 把它读回来；我猜，写完那一篇你会觉得这一篇的“引用”是在为它铺路。
