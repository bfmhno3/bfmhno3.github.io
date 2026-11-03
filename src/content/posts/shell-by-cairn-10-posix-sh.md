---
title: "POSIX sh：当你没有 bash 的时候"
commentId: "post:shell-by-cairn-10-posix-sh"
published: "2026-11-02 23:00:00 +08:00"
description: "用 Cairn 从零学 Shell 第 10 篇：我在 Bash 5.3.15、dash 0.5.13.5、BusyBox 1.37.0、mksh R59 和 yash 2.61 上给 Cairn 写了一个 236 行的 POSIX sh 安装脚本，五个 shell 都装得上；顺便量了启动，bash -c : 要 3.01 ms，是 dash 的 2.4 倍。"
category: Tutorial
tags:
  - Shell
  - Bash
  - Cairn
  - POSIX
  - 可移植性
  - dash
series: "用 Cairn 从零学 Shell"
seriesOrder: 10
draft: false
comment: true
slug: shell-by-cairn-10-posix-sh
---

前九篇里我写的每一行都在假设 bash 在场，只有 `install.sh` 不能：它要在 Cairn 还没装上去的机器上跑，而那台机器连 bash 都可能没有。所以我做了一个很蠢的实验：建一个 `PATH`，里面只有 `cp`、`mkdir`、`chmod`、`rm`、`rmdir` 五个符号链接，用 dash 跑这个安装脚本。输出的第一行是警告，之后装了 13 个文件，退出码 0；最后两条命令是装完以后我用正常的 `PATH` 跑的（安装脚本一个 bash 的东西都没用到，Cairn 本体却一行都离不开 bash，这一篇就是讲这件事）：

```text
$ mkdir /tmp/nobash
$ for t in cp mkdir chmod rm rmdir; do ln -s "$(command -v "${t}")" "/tmp/nobash/${t}"; done
$ PATH=/tmp/nobash "$(command -v dash)" ./install.sh --prefix /tmp/cairn-prefix
install.sh: warning: bash not found in PATH; cairn needs bash
installed /tmp/cairn-prefix/bin/cairn
installed /tmp/cairn-prefix/lib/cairn/config.sh
installed /tmp/cairn-prefix/lib/cairn/diff.awk
installed /tmp/cairn-prefix/lib/cairn/lock.sh
installed /tmp/cairn-prefix/lib/cairn/log.sh
installed /tmp/cairn-prefix/lib/cairn/manifest.sh
installed /tmp/cairn-prefix/lib/cairn/prune.sh
installed /tmp/cairn-prefix/lib/cairn/report.awk
installed /tmp/cairn-prefix/lib/cairn/repo.sh
installed /tmp/cairn-prefix/lib/cairn/snapshot.sh
installed /tmp/cairn-prefix/share/bash-completion/completions/cairn
installed /tmp/cairn-prefix/share/cairn/systemd/cairn.service
installed /tmp/cairn-prefix/share/cairn/systemd/cairn.timer
$ echo "exit $?"
exit 0
$ /tmp/cairn-prefix/bin/cairn --version
cairn 0.1.0
$ find /tmp/cairn-prefix -type f | wc -l
13
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库（标签 `ch10`）有 160 个被跟踪的文件，比 `ch09` 多 14 个：新增 `install.sh`（236 行）、`tests/install.bats`（358 行）和 `lab/ch10/` 里的 11 个实验脚本、1 个夹具；另有两个旧文件被修改：`Makefile`（28 行变 33 行，多了 `PREFIX`、`install` 目标，`lint` 多检查一个脚本）和 `README.md`（84 行变 125 行，多了 “Install” 一节）。这是最后一篇，这 16 个文件都是最终版本，后面没有哪一篇会再改它们。`make ch10` 通过：11 个实验全部 `ok`（`bashisms_fail.sh` 按设计以退出码 1 结束，运行器把它当作 `_fail` 实验）；`make test` 跑 150 个测试全部通过，比 `ch09` 多 35 个；`make ci` 在这台机器上整套 3 分 57 秒。
> 涉及的工具和特性：POSIX Shell Command Language、`/bin/sh` 在各发行版上指向谁、`bash --posix`、bashism 目录与 POSIX 写法、`local` 与 `name() ( ... )`、`echo` 与 `printf`、`set --` 当数组、`.` 与 `command -v`、`checkbashisms`、`shellcheck -s sh`、DESTDIR，以及 [Google Shell 风格指南](https://google.github.io/styleguide/shellguide.html)里的[选哪个 shell](https://google.github.io/styleguide/shellguide.html#s1.1-which-shell-to-use)与[何时用 shell](https://google.github.io/styleguide/shellguide.html#s1.2-when-to-use-shell) 两条。
> 前置：[第 9 篇：交互式 bash：启动文件、提示符、作业控制与补全](/posts/shell-by-cairn-09-interactive-shell/)。

这一篇的所有输出来自这台机器：NixOS 26.05，Linux 6.18.59，开发 shell 里的 Bash 5.3.15（系统的 `/bin/sh` 是另一份构建，5.3.9，后面会看到），[dash](http://gondor.apana.org.au/~herbert/dash/)（nixpkgs 里的包名是 0.5.13.5）、[BusyBox](https://busybox.net/) 1.37.0、[yash](https://github.com/magicant/yash) 2.61、[mksh](https://github.com/MirBSD/mksh) R59，[checkbashisms](https://manpages.debian.org/unstable/devscripts/checkbashisms.1.en.html) 2.25.10，ShellCheck 0.11.0，shfmt 3.13.1，Bats 1.14.0，[hyperfine](https://github.com/sharkdp/hyperfine) 1.20.0。硬件是 AMD Ryzen 7 PRO 6850U，`nproc` 是 16，30 GiB 内存。仓库在我这里放在 `~/Projects/cairn`，你的会是 `~/cairn`。版本号我这样确认过：

```text
$ readlink -f "$(command -v dash)" "$(command -v mksh)" "$(command -v yash)"
/nix/store/63jk1i00wv5ayp5cqnpacz4c8xvrz5k4-dash-0.5.13.5/bin/dash
/nix/store/83d3q01anbirmj1w8bickgdn4qj206sx-mksh-59c/bin/mksh
/nix/store/38vkhz4yqs1pprxpmcm33d393yimsbry-yash-2.61/bin/yash
$ mksh -c 'echo "${KSH_VERSION}"'
@(#)MIRBSD KSH R59 2020/10/31
$ yash --version | head -n 1
Yet another shell, version 2.61
$ "${CAIRN_BUSYBOX}" 2>&1 | head -n 1
BusyBox v1.37.0 () multi-call binary.
$ checkbashisms --version | head -n 1
This is checkbashisms, from the Debian devscripts package, version 2.25.10
$ hyperfine --version
hyperfine 1.20.0
```

## 动手清单

你自己的 `~/cairn` 从第 9 篇的状态出发，这一篇要做这几件事：

- 新建 `install.sh` 和 `tests/install.bats`。见 “install.sh：一个只许用 POSIX 的文件” 和 “一份安装，五个 shell” 两节。
- 改 `Makefile`（加 `PREFIX ?=`、`install` 目标，`lint` 里加 `checkbashisms install.sh`）和 `README.md`（加 “Install” 一节）。见 “一份安装，五个 shell” 一节和 “检查点” 一节。
- 新建 `lab/ch10/` 下的 11 个实验脚本和夹具 `lab/ch10/fixtures/bashisms.txt`，`make ch10` 全部跑一遍。它们分布在 “/bin/sh 是谁” 到 “Google 的 100 行规则，和 Cairn 的 1445 行” 各节里，`ex_posix_basename.sh` 是练习 1 的答案。

直接从参考仓库复制的话，和前几篇一样，只是多了两步：要先建出夹具目录，复制完要给 `install.sh` 加上执行权限：

```bash
git -C ~/cairn-ref fetch --tags
cd ~/cairn || exit 1
mkdir -p lab/ch10/fixtures
mapfile -t files < <(git -C ~/cairn-ref diff --name-only ch09 ch10)
for f in "${files[@]}"; do
  git -C ~/cairn-ref show ch10:"${f}" >"${f}"
done
chmod +x install.sh
```

`chmod +x` 不是可有可无。`git show` 重定向出来的文件没有执行位，而 `Makefile` 的 `install` 目标是 `./install.sh ...`。我在一个只含 `ch09` 内容的目录里跑过这段：复制了 16 个文件；没加 `chmod` 时 `make install` 打印 `Permission denied`，加了以后装上了（14 行输出是 `make` 回显的那一行加 13 个 `installed`）：

```text
$ printf "%s\n" "${#files[@]}"
16
$ make install PREFIX=/tmp/p10/rdp
./install.sh --prefix "/tmp/p10/rdp"
sh: line 1: ./install.sh: Permission denied
make: *** [Makefile:30: install] Error 126
$ chmod +x install.sh && make install PREFIX=/tmp/p10/rdp | wc -l
14
```

## POSIX 到底规定了什么

POSIX 里管 shell 的那一块叫 [Shell Command Language](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html)，是 `sh` 这个命令的语言部分，我读的是 IEEE Std 1003.1-2024 (Issue 8) 那一版。它是一章，十五节：2.1 到 2.15，从介绍、引用、词展开、重定向、命令，一直到作业控制、信号、模式匹配和特殊内建。我用它的标题表确认过这个数字，没有靠记忆。

读这一章我最在意的是它没有的东西。第 2.4 节的保留字表只有 16 个：`!`、`{`、`}`、`case`、`do`、`done`、`elif`、`else`、`esac`、`fi`、`for`、`if`、`in`、`then`、`until`、`while`。下面另有一张 “可能被识别为保留字，行为未指定” 的表：`[[`、`]]`、`function`、`namespace`、`select`、`time`。第 2.9.1.4 节讲命令查找的地方又有一张表，列的是 “如果命令名匹配这些，结果未指定”：`local`、`source`、`declare`、`typeset`、`let`、`mapfile`、`readarray`、`complete`、`compgen`、`bind`、`shopt`、`disown` 等等。注意它的措辞：不是 “不许有”，是 “未指定”。bash 有它们不违反标准，用了它们的脚本才不属于标准。所以 bashism 的准确定义是：标准没有规定、因此换一个 shell 就不保证能跑的写法。

函数名也一样。第 2.9.5 节说函数定义是 `fname ( ) compound-command`，应用要保证 `fname` 是一个 name（XBD 3.216 里的定义），并且不是特殊内建的名字；“实现可以允许其他字符作为扩展”。第 1 篇 “日志库” 一节说 Google 的 `package::function` 是库函数的命名规则，我当时顺手写了一句 “POSIX sh 不允许”；现在可以更准确地说：标准没有保证，所以 `cairn::log::err` 这种名字在 bash 里可以，在别的 shell 里要看运气。后面的对照表会给出运气的分布。

还有一点，标准是会变的。2017 年版 (Issue 7) 的这一章里没有 `pipefail`，没有 `$'...'`（第 2.2.4 节 Dollar-Single-Quotes），`case` 也没有 `;&` 这个结束符；2024 年版三样都有了。我对两份文档分别数了这三个词的出现次数，2017 年版是 0、0、0，2024 年版是 8、3、4。Cairn 从第 1 篇起就在用 `set -o pipefail`，所以严格说，它在 2024 年才变成 “标准写法”，而 dash 0.5.13 已经实现了：

```text
$ dash -c 'set -o pipefail; false | true; echo "$?"'
1
```

标准是一份可以引用的东西，但真正决定你的脚本能不能跑的，是 `/bin/sh` 这个符号链接指向谁。

## /bin/sh 是谁

脚本第一行写 `#!/bin/sh`，是在对内核说 “请用 `/bin/sh` 这个路径上的东西来解释我”。路径是固定的，路径上的东西不固定：它是一个符号链接，发行版想让它指向谁就指向谁。`lab/ch10/bin_sh_is.sh` 只有 8 行，问的就是这件事：

```bash
# shellcheck shell=bash
# Shows: what /bin/sh is on this machine. On NixOS it is bash (so a script
# with #!/bin/sh quietly gets bash); on Debian and Ubuntu it is dash.
# The output depends on the host, the lab never fails.
echo '$ readlink -f /bin/sh'
readlink -f /bin/sh
echo '$ ls -l /bin/sh'
ls -l /bin/sh
```

它在这台机器上的输出，加上我补的三条命令（`/bin` 和 `/usr/bin` 里到底有什么，以及两个 bash 各是哪个版本）：

```text
$ readlink -f /bin/sh
/nix/store/13czpvp88x852739v5xi04s871pn35b5-bash-interactive-5.3p9/bin/bash
$ ls -l /bin/sh
lrwxrwxrwx 1 root root 73 Oct 31 19:38 /bin/sh -> /nix/store/13czpvp88x852739v5xi04s871pn35b5-bash-interactive-5.3p9/bin/sh
$ ls /bin /usr/bin
/bin:
sh

/usr/bin:
env
$ /bin/sh -c 'echo "${BASH_VERSION}"'
5.3.9(1)-release
$ bash -c 'echo "${BASH_VERSION}"'
5.3.15(1)-release
```

NixOS 的 `/bin/sh` 是 bash，`readlink -f` 一路追到 `bash-interactive-5.3p9/bin/bash`。这台机器上整个 `/bin` 只有一个 `sh`，整个 `/usr/bin` 只有一个 `env`，这就是第 1 篇 “在 NixOS 上，Google 的 shebang 会失败” 一节里 `#!/bin/bash` 报 `bad interpreter` 的原因，也是 Google 的 `#!/bin/bash` 在这里要换成 `#!/usr/bin/env bash` 的原因。顺便注意版本：系统的 `/bin/sh` 是 bash 5.3.9，开发 shell 里的 `bash` 是 5.3.15，不是同一份构建。

Debian 这一边我能核实的是：Debian wiki 的 [Shell 页面](https://wiki.debian.org/Shell)写着 “在 Lenny 之前（含 Lenny），bash 是默认的非交互 shell；从 Squeeze 开始，Debian 用 dash 作为 `/bin/sh` 符号链接的目标”，并且 Squeeze 到 Bullseye 之间还可以用 `dpkg-reconfigure dash` 换回 bash，Bookworm 起不再支持。Squeeze (Debian 6.0) 的发布日期是 2011 年 2 月 6 日（[发布公告](https://chronicles.debian.org/www/News/2011/20110205a)），而把 “用 dash 当默认 shell 来改善启动性能” 写进 Squeeze 发布目标的新闻是 [2009 年 7 月 30 日](https://chronicles.debian.org/www/News/2009/20090730)的。所以 Debian 的日期我敢写：2011 年 2 月，Squeeze。Ubuntu 的 wiki 页 [DashAsBinSh](https://wiki.ubuntu.com/DashAsBinSh) 我直接打开是 404，搜索引擎的摘要里有它的开头：“In Ubuntu 6.10, the default system shell, /bin/sh, was changed to dash (the Debian Almquist Shell); previously it had been bash”，这是摘要，不是我在页面上读到的。6.10 按 Ubuntu 的版本号习惯（年.月）是 2006 年 10 月，一条日期是 2006 年 10 月 29 日的 [Slashdot 评论](https://linux.slashdot.org/story/06/10/28/239258/upgrading-to-ubuntu-edgy-eft-a-nightmare)也说 Edgy (6.10) 换成了 dash，对得上。具体哪一天我没有一手来源，所以只写 “2006 年 10 月，Ubuntu 6.10”。别的发行版我没查，不写。

### 在 NixOS 上，bashism “碰巧能跑”

于是有了这样一类脚本：第一行写 `#!/bin/sh`，里面却用了数组和 `[[`。在 NixOS 上它们从来没出过问题，因为 `/bin/sh` 就是 bash。我写了一个这样的脚本（`accident.sh`，一个不在仓库里的草稿），先直接跑，再交给 dash：

```sh
#!/bin/sh
# 草稿，不在仓库里：自称 sh，用的却是 bash 的写法。
# BAD: 数组和 [[ ]] 都不是 POSIX，这是故意的。
# shellcheck disable=SC3030,SC3010,SC3014,SC3054
files=(one two three)
if [[ "${#files[@]}" == 3 ]]; then
  echo "bash features worked: ${files[1]}"
fi
```

```text
$ ./accident.sh; echo "exit $?"
bash features worked: two
exit 0
$ dash ./accident.sh; echo "exit $?"
./accident.sh: 5: Syntax error: "(" unexpected
exit 2
```

Bash 手册里 “Invoked with name sh” 一节（我读的是 Bash 维护者 Chet Ramey 在 case.edu 上的[参考手册镜像](https://tiswww.case.edu/php/chet/bash/bashref.html#Invoked-with-name-sh)，因为 gnu.org 的手册页我这里连不上；这台机器上的 `man bash` 的 INVOCATION 一节是同一句话）写着：“以 `sh` 的名字调用时，Bash 在读完启动文件之后进入 POSIX 模式。” 这也能直接看到：

```text
$ /bin/sh -c 'echo "${SHELLOPTS}"'
braceexpand:hashall:interactive-comments:posix
$ bash -c 'echo "${SHELLOPTS}"'
braceexpand:hashall:interactive-comments
```

`posix` 出现在了 `SHELLOPTS` 里。可是 posix 模式没有关掉数组和 `[[`，`accident.sh` 照样跑得好好的，“bash --posix 改了什么，没改什么” 一节的实验会把这一点单独量出来。这就是 “碰巧能跑” 的机制：你在 NixOS 上测试 `#!/bin/sh` 脚本，测试的其实是 bash；换到 Debian，同一个文件交给 dash，才第一次真正被标准检查。

我给这件事找的类比是托运行李的尺寸标准：只要箱子不超标，哪条航线都收；bashism 是超标的箱子，而你常飞的那条航线（NixOS 的 `/bin/sh`）从来不量尺寸，于是你一直以为它没超标，直到换了航线才在登机口被拦下。

被拦下的方式比报错更讨厌。我把同一个文件分别交给 bash 和 dash，文件里有一个 `[[` 和一个数组：

```sh
#!/usr/bin/env bash
# 草稿，不在仓库里：同一个文件，让 bash 和 dash 各跑一遍。
echo '1: before'
# BAD: [[ is not POSIX
if [[ -f /etc/passwd ]]; then
  echo '2: exists'
else
  echo '2: missing'
fi
echo '3: after'
# BAD: arrays are not POSIX
files=(a b)
echo "4: ${#files[@]} files"
```

```text
$ bash half.sh; echo "exit $?"
1: before
2: exists
3: after
4: 2 files
exit 0
$ dash half.sh; echo "exit $?"
1: before
half.sh: 5: [[: not found
2: missing
3: after
half.sh: 12: Syntax error: "(" unexpected
exit 2
```

dash 对 `[[` 的反应是 `[[: not found`：在它眼里 `[[` 只是一个普通的词，去 `PATH` 里找一个叫这个名字的命令，找不到，退出码 127，`if` 把 127 当成假，于是走了 `else`，打印 `2: missing`，而 `/etc/passwd` 是存在的。脚本接着往下跑，`3: after` 也打印了。直到第 12 行的数组，dash 解析到这一行才报 `Syntax error`，退出码 2。这里有两种坏法：`[[` 是运行时的 “找不到命令”，条件悄悄变成假；数组是语法错误，但 shell 是读一条、解析一条、执行一条的，所以出错之前的命令已经执行过了。对一个会删文件的脚本来说，“跑了一半” 比 “根本没跑” 糟糕得多。

### bash --posix 改了什么，没改什么

既然 bash 自己有 posix 模式，能不能用它当检查器？`lab/ch10/posix_mode.sh` 把同一个片段在 `bash` 和 `bash --posix` 里各跑一遍，函数和前两个调用是这样（节选）：

```bash
both() {
  local snippet="$1"
  printf '$ %s\n' "${snippet}"
  printf '  bash:         '
  bash -c "${snippet}" 2>&1 | tr '\n' ' '
  printf '[exit %d]\n' "${PIPESTATUS[0]}"
  printf '  bash --posix: '
  bash --posix -c "${snippet}" 2>&1 | tr '\n' ' '
  printf '[exit %d]\n' "${PIPESTATUS[0]}"
}

echo '--- same in both: [ is a builtin either way ---'
both 'type -t ['
echo '--- differs: a function may not take a special builtin name ---'
both 'export() { echo fn; }; export; echo after'
# ...
```

```text
--- same in both: [ is a builtin either way ---
$ type -t [
  bash:         builtin [exit 0]
  bash --posix: builtin [exit 0]
--- differs: a function may not take a special builtin name ---
$ export() { echo fn; }; export; echo after
  bash:         fn after [exit 0]
  bash --posix: bash: line 1: `export': is a special builtin [exit 2]
--- differs: an error in a special builtin ends the shell ---
$ set -o nosuchopt; echo after
  bash:         bash: line 1: set: nosuchopt: invalid option name after [exit 0]
  bash --posix: bash: line 1: set: nosuchopt: invalid option name [exit 2]
--- differs: SHELLOPTS lists posix ---
$ echo "${SHELLOPTS}"
  bash:         braceexpand:hashall:interactive-comments [exit 0]
  bash --posix: braceexpand:hashall:interactive-comments:posix [exit 0]
--- not different: bash-only syntax is still accepted ---
$ echo {a,b}; [[ x == x ]] && echo dbl; a=(1 2); echo "${a[1]}"
  bash:         a b dbl 2 [exit 0]
  bash --posix: a b dbl 2 [exit 0]
```

20 行输出，五组对比。第一组 `type -t [` 两边都是 `builtin`，没有区别。第二组：在 posix 模式下 `export() { echo fn; }` 是错误，退出码 2，因为第 2.9.5 节规定函数名不能是特殊内建的名字（`export` 是），而普通模式的 bash 欣然接受。第三组：`set -o nosuchopt` 是特殊内建 `set` 的错误，第 2.8.1 节说特殊内建的错误可以让非交互 shell 退出，posix 模式照做，所以没有打印 `after`，退出码 2；普通模式继续往下走。第四组：`SHELLOPTS` 里多了一个 `posix`。第五组是我最想让你看的：`{a,b}`、`[[ ]]`、数组，在 posix 模式下一样被接受，输出和普通模式逐字相同。

所以 `bash --posix` 改的是 bash 在标准有规定的地方的行为（特殊内建、错误处理），没有改的是 bash 自己加的语法。它不是检查器。要知道一个文件是不是 POSIX，得换一个根本不认识这些语法的实现，比如 dash，或者静态地读它，比如 “checkbashisms 和 shellcheck -s sh” 一节里的两个工具。

### NixOS 的 /etc/profile 是按 “谁来读都行” 写的

“`/bin/sh` 是 bash” 在这台机器上还有一个后果。第 9 篇的 “NixOS 在 /etc 里放了什么” 一节看过 `/etc/profile` 和 `/etc/bashrc` 谁读谁；这次问的是这两个文件自己是什么方言：

```text
$ dash -n /etc/profile; echo "exit $?"
exit 0
$ checkbashisms /etc/profile 2>&1 | tail -n 2
possible bashism in /etc/profile line 24 ($BASH_SOMETHING):
if [ -n "${BASH_VERSION:-}" ]; then
$ sed -n 22p /etc/bashrc
  ((UID)) && PROMPT_COLOR="1;32m"
```

`/etc/profile` 通得过 `dash -n`，checkbashisms 只报第 24 行的 `${BASH_VERSION:-}`，而它恰好被一个 `[ -n ... ]` 包着：只有 bash 才会走进 `. /etc/bashrc`。`/etc/bashrc` 第 22 行的 `((UID))` 是 bash 的写法，它不打算被别人读。这扇门开不开，看是谁在读：

```text
$ PS4='+ ${BASH_SOURCE}:${LINENO}: ' HOME=/nonexistent /bin/sh -l -x -c : 2>&1 \
    | grep -oE '^\++ [^ :]*/etc/(profile|bashrc)' | sort | uniq -c
      6 ++ /etc/bashrc
      8 + /etc/profile
$ HOME=/nonexistent /bin/sh -l -x -c : 2>&1 | grep -c '^+* \. /etc/bashrc'
1
$ HOME=/nonexistent dash -l -x -c : 2>&1 | grep -c '^+* \. /etc/bashrc'
0
```

`sh -l`（`/bin/sh` 以登录 shell 的方式启动）读了 `/etc/profile`（8 行跟踪），经过那扇门执行了 `. /etc/bashrc`（6 行跟踪，计数 1）；同样的 `-l` 交给 dash，计数 0，门没有开。所以 NixOS 上以登录 shell 启动的 `sh` 会拿到 `/etc/bashrc` 里 bash 的提示符和补全设置，换一个 `sh` 就拿不到。

## bashism 目录

先有一个靶子。`lab/ch10/fixtures/bashisms.txt` 有 12 行，每行一个 bashism，每行单独在 bash 里都能跑，行尾 `#` 后面的名字是实验打印时用的标签：

```sh
#!/bin/sh
# One bashism per line, each line works on its own under bash; the name
# after the last "#" is what lab/ch10 prints. Not linted.
[[ abc == a* ]] && echo match # [[ ]]
arr=(x y z); echo "${arr[1]}" # array
echo $'a\tb' # $'..'
function greet { echo hi; }; greet # function keyword
[ a == a ] && echo equal # == inside [
echo -e 'a\tb' # echo -e
cat <(echo hi) # <( )
echo {a,b} # {a,b}
source /dev/null && echo sourced # source
```

（它是 `.txt`，所以 `shfmt -f` 不会把它收进 `make lint`；我用它来演示的恰恰是 “应当被 lint 骂” 的写法。）

### 先让 dash 说话

`lab/ch10/bashisms_fail.sh` 对夹具里的每一行，分别用 bash 和 dash 跑一遍，输出相同就打印 `same`，不同就打印 `BREAKS`。核心是这个循环：

```bash
# ...
while IFS= read -r line; do
  [[ "${line}" == '#'* ]] && continue
  name="${line##*# }"
  total=$((total + 1))
  want="$(bash -c "${line}" 2>&1)"
  got="$(dash -c "${line}" 2>&1)"
  want="${want//$'\t'/<TAB>}"
  got="${got//$'\t'/<TAB>}"
  if [[ "${got}" == "${want}" ]]; then
    printf 'same    %s\n' "${name}"
  else
    broken=$((broken + 1))
    printf 'BREAKS  %-17s bash: %-9s dash: %s\n' "${name}" \
      "${want}" "${got##*: }"
  fi
done <"${fixture}"
echo "${broken} of ${total} constructs break under dash"
((broken == 0))
```

它是 `_fail` 实验：只要有一行坏了就以退出码 1 结束，运行器把 “预期会失败” 当成通过。输出：

```text
BREAKS  [[ ]]             bash: match     dash: not found
BREAKS  array             bash: y         dash: "(" unexpected
same    $'..'
BREAKS  function keyword  bash: hi        dash: "}" unexpected
BREAKS  == inside [       bash: equal     dash: unexpected operator
BREAKS  echo -e           bash: a<TAB>b   dash: -e a<TAB>b
BREAKS  <( )              bash: hi        dash: "(" unexpected
BREAKS  {a,b}             bash: a b       dash: {a,b}
BREAKS  source            bash: sourced   dash: not found
8 of 9 constructs break under dash
```

9 个构造里坏了 8 个，只有 `$'..'` 没坏：这台机器上的 dash 接受它，POSIX.1-2024 的第 2.2.4 节也把它写进了标准（“POSIX 到底规定了什么” 一节说过，2017 年版里没有）。坏掉的 8 个，`dash:` 那一列揭示了四种不同的坏法：

- **找不到命令**：`[[ ]]` 和 `source`。dash 里 `[[` 只是一个普通的词，去 `PATH` 里找，找不到。
- **语法错误**：数组 (`"(" unexpected`)、`function` 关键字 (`"}" unexpected`)、`<( )` (`"(" unexpected`)。整个文件在这一行之后不再被解析。
- **运行时的小错**：`[ a == a ]`。dash 的 `[` 不认 `==`，说 `unexpected operator`，退出状态是 2；在 `if` 里这就是 “条件为假”，`&&` 后面的东西悄悄不执行。
- **静默的错误输出**：`echo -e 'a\tb'` 打印出 `-e a<TAB>b`，选项当成了文本；`echo {a,b}` 打印 `{a,b}`，花括号没有展开。一个字都没报错。

最后一类最危险。前面几类至少会让你看见一行错误信息；静默的那类，脚本跑完了，退出码是 0，结果是错的。

### checkbashisms 和 shellcheck -s sh

不想让 dash 来试错，可以静态地读。`lab/ch10/checkbashisms_demo.sh` 是 8 行：

```bash
# shellcheck shell=bash
# Shows: checkbashisms on the same fixture as bashisms_fail.sh. It reads
# the file, runs nothing, and reports each bashism with its line. Its exit
# status is 1 when it finds something; the lab prints that status and
# exits 0.
cd "${CAIRN_ROOT}" || exit 1
checkbashisms lab/ch10/fixtures/bashisms.txt
echo "checkbashisms exit status: $?"
```

checkbashisms 是 Debian devscripts 里的一个 Perl 脚本（我看了它的 shebang，`#!/nix/store/...-perl-5.42.0/bin/perl`），按行用正则找已知的 bashism（脚本 822 行，其中 38 行用了 `=~`），我没有看到它建语法树。它把发现写到 stderr，退出码 1，stdout 只有实验自己打印的那一行：

```text
checkbashisms exit status: 1
```

stderr 一共 20 行，每条发现两行：一行问题，一行原文（完整的在 `out/ch10/checkbashisms_demo.stderr` 里）。下面把前缀和原文去掉，只留问题：

```text
$ checkbashisms lab/ch10/fixtures/bashisms.txt 2>&1 \
    | sed -n 's/^possible bashism in lab\/ch10\/fixtures\/bashisms.txt //p'
line 4 (alternative test command ([[ foo ]] should be [ foo ])):
line 4 (should be 'b = a'):
line 5 (bash arrays, ${name[0|*|@]}):
line 6 ($'...' should be "$(printf '...')"):
line 7 ('function' is useless):
line 8 (should be 'b = a'):
line 9 (echo -e):
line 10 (<() process substitution):
line 11 (brace expansion):
line 12 (should be '.', not 'source'):
```

10 条发现。夹具只有 9 行有东西，因为第 4 行同时有 `[[` 和 `==`，被报了两次。另一把尺子是 `lab/ch10/shellcheck_sh.sh`：

```bash
# shellcheck shell=bash
# Shows: shellcheck -s sh on the bashism fixture. -s sh makes shellcheck
# check against POSIX sh instead of the dialect the shebang names, so
# every construct that dash cannot run is reported. Exit status 1 means
# findings; the lab prints it and exits 0.
cd "${CAIRN_ROOT}" || exit 1
shellcheck -s sh -f gcc lab/ch10/fixtures/bashisms.txt
echo "shellcheck exit status: $?"
```

`-s sh` 的意思是 “不管 shebang 写什么，按 POSIX sh 来检查”（`-f gcc` 只是让输出一行一条）：

```text
lab/ch10/fixtures/bashisms.txt:4:1: warning: In POSIX sh, [[ ]] is undefined. [SC3010]
lab/ch10/fixtures/bashisms.txt:4:8: warning: In POSIX sh, == in place of = is undefined. [SC3014]
lab/ch10/fixtures/bashisms.txt:5:5: warning: In POSIX sh, arrays are undefined. [SC3030]
lab/ch10/fixtures/bashisms.txt:5:20: warning: In POSIX sh, array references are undefined. [SC3054]
...
lab/ch10/fixtures/bashisms.txt:12:1: warning: In POSIX sh, 'source' in place of '.' is undefined. [SC3046]
lab/ch10/fixtures/bashisms.txt:12:1: warning: In POSIX sh, 'source' in place of '.' is undefined. [SC3051]
shellcheck exit status: 1
```

上面省掉了中间 7 行（全文在 `out/ch10/shellcheck_sh.stdout` 里），一共 13 条发现加最后一行状态。每条都带一个 `SC` 编号，每个编号在 [ShellCheck 的 wiki](https://www.shellcheck.net/wiki/SC3010) 上有一页（URL 末尾换成编号即可）：`[[ ]]` 是 SC3010，数组是 SC3030（引用元素是 SC3054），`$'..'` 是 SC3003，`echo -e` 是 SC3037，`<( )` 是 SC3001，`{a,b}` 是 SC3009，`source` 是 SC3046，`==` 是 SC3014，`function` 关键字是 SC2113。两把尺子的结论不完全一样：ShellCheck 比 checkbashisms 多报了一条 SC2050（第 8 行 `[ a == a ]` 的左右两边都是常量，这是夹具设计的副作用，不是 bashism），`source` 那一行被两个编号各报了一次。它仍然把 `$'..'` 当成未定义 (SC3003)，按 2024 年版的标准这一条已经不算了，我猜是工具比标准慢了一拍。我的做法是两把都用：`make lint` 对 `install.sh` 跑 checkbashisms，测试里再用 `shellcheck -s sh` 和 `dash -n` 各检查一次，下面 “install.sh：一个只许用 POSIX 的文件” 一节会看到。

### 五个 shell 的对照表

所以我另写了一个草稿 `matrix.sh`（不在仓库里），把常用的 19 个写法分别交给五个 shell。全文如下，19 个探针和各自的期望值都在里面：

```bash
#!/usr/bin/env bash
# 草稿，不在仓库里：哪个 shell 接受哪种写法。
# shellcheck disable=SC2016
shells=(dash bash "${CAIRN_BUSYBOX} sh" mksh yash)
labels=(dash bash busybox mksh yash)
ok_count=(0 0 0 0 0)
rows=0

#######################################
# 在每个 shell 里跑一个片段，打印表格的一行。
# Arguments:
#   行标签、片段、期望的标准输出。
#######################################
probe() {
  local name="$1" snippet="$2" want="$3"
  local sh_cmd got i=0
  printf '%-14s' "${name}"
  rows=$((rows + 1))
  for sh_cmd in "${shells[@]}"; do
    # shellcheck disable=SC2086
    got="$(${sh_cmd} -c "${snippet}" 2>/dev/null)"
    if [[ "${got}" == "${want}" ]]; then
      printf ' %-8s' ok
      ok_count[i]=$((ok_count[i] + 1))
    else
      printf ' %-8s' no
    fi
    i=$((i + 1))
  done
  echo
}

printf '%-14s' construct
printf ' %-8s' "${labels[@]}"
echo
probe 'local' 'f() { local x=1; echo "${x}"; }; f' 1
probe 'f::g name' 'f::g() { echo hi; }; f::g' hi
probe 'pipefail' 'set -o pipefail; false | true; echo "$?"' 1
probe '${v//a/b}' 'v=banana; echo "${v//a/b}"' bbnbnb
probe '${v:0:3}' 'v=banana; echo "${v:0:3}"' ban
probe '${v^^}' 'v=banana; echo "${v^^}"' BANANA
probe '$((i++))' 'i=1; echo "$((i++))"' 1
probe '[[ =~ ]]' '[[ abc =~ b ]] && echo y' y
probe 'v+=x' 'v=a; v+=b; echo "${v}"' ab
probe '<<<' 'cat <<< hi' hi
probe '&>' 'echo hi &>/dev/null; echo ok' 'ok'
probe 'printf %q' 'printf "%q\n" "a b"' 'a\ b'
probe '${v@Q}' "v='a b'; echo \"\${v@Q}\"" "'a b'"
probe 'type -t' 'type -t cd' builtin
probe 'let' 'let x=1+1; echo "${x}"' 2
probe 'select' 'echo 1 | select a in x y; do echo "${a}"; break; done' x
probe 'RANDOM' '[ -n "${RANDOM}" ] && echo y' y
probe 'EPOCHSECONDS' '[ -n "${EPOCHSECONDS}" ] && echo y' y
probe 'trap ERR' 'trap : ERR && echo y' y
printf '%-14s' "ok of ${rows}"
printf ' %-8s' "${ok_count[@]}"
echo
```

```text
$ bash matrix.sh
construct      dash     bash     busybox  mksh     yash
local          ok       ok       ok       ok       ok
f::g name      no       ok       ok       ok       no
pipefail       ok       ok       ok       ok       ok
${v//a/b}      no       ok       ok       ok       ok
${v:0:3}       no       ok       ok       ok       no
${v^^}         no       ok       no       no       no
$((i++))       no       ok       ok       ok       ok
[[ =~ ]]       no       ok       ok       no       ok
v+=x           no       ok       no       ok       no
<<<            no       ok       no       ok       ok
&>             no       ok       ok       ok       no
printf %q      no       ok       no       no       no
${v@Q}         no       ok       no       ok       no
type -t        no       ok       no       no       no
let            no       ok       ok       ok       no
select         no       ok       no       ok       no
RANDOM         no       ok       ok       ok       ok
EPOCHSECONDS   no       ok       ok       no       no
trap ERR       no       ok       ok       ok       no
ok of 19       2        19       12       14       7
```

`ok` 的意思是 `SHELL -c 片段` 的输出等于期望值。几个值得停一下的格子：

- 最后一行：bash 19 个全过（它是参照物），mksh 14，BusyBox 的 ash 12，yash 7，dash 只有 2 个。dash 是最小公分母，一段代码能在 dash 里跑，基本上就能在别处跑。反过来不成立。
- `local` 在五个 shell 里都过了，尽管标准没有它。这是整张表里最有意思的一格，“local 不是 POSIX” 一节单独讲。
- `pipefail` 也在五个里都过了：这是标准刚刚才补上的，“POSIX 到底规定了什么” 一节说过。
- `f::g name`，也就是 Google 的 `package::function` 命名：dash 和 yash 拒绝（dash 的原话是 `Syntax error: Bad function name`，yash 是 `invalid function name`），BusyBox 和 mksh 接受。第 1 篇 “日志库” 一节说 `install.sh` 会受这件事影响，原因就在这里。
- `${v//a/b}` 只有 dash 不认；`${v:0:3}` dash 和 yash 不认；`${v^^}` 只有 bash 认。`$((i++))` 只有 dash 不认。
- `&>`：dash 没有报语法错误，它把 `echo hi &` 当成后台命令，再接一个单独的重定向，所以表里是 `no`，而 `hi` 还是被打印了出来。（后台输出的先后顺序不固定，我没有把这个例子放进表里，只是实验时看到的。）
- `printf '%q'` 和 `type -t`：只有 bash。`${v@Q}`：bash 和 mksh。我第一次探测用 `v=a`，mksh 在不需要引号时原样输出 `a`，和期望的 `'a'` 对不上，被我误判成不支持；换成带空格的 `v='a b'` 才看出 mksh R59 也认。第 3 篇 “把值写进变量：printf -v、%q、@Q 与 nameref” 一节把 `%q` 和 `@Q` 都算作 Bash 的扩展，这张表证实了 `%q`，`@Q` 要补上 mksh；第 1 篇 “找到程序：PATH、hash、内建与外部” 一节说 `type -t` 是 Bash 的扩展，这里也证实了。

### 替换对照

每个坏写法都有一个 POSIX 的写法，只是常常更啰嗦。我把上面能找到替代的写法各写了一遍，放进另一个草稿 `replace.sh`（也不在仓库里），每行打印 `名字: 结果`。它分成三段放在这里，按顺序拼起来就是整个文件：这一段、下面 “local 不是 POSIX” 一节里的 `scratch` 函数，和那一节末尾的三行 `mapfile` 替换。第一段是这样：

```sh
#!/bin/sh
# 草稿，不在仓库里：bashism 的 POSIX 替换，每行打印 名字: 结果。
f=report.txt
v=banana

case "${f}" in *.txt) echo 'glob: case' ;; esac
[ -f /etc/passwd ] && [ -r /etc/passwd ] && echo 'and: [ a ] && [ b ]'
[ "${v}" = banana ] && echo 'eq: ='

set -- a 'b c' d
echo "array: set -- gives $# items, second is '$2'"

printf 'echo-e: %s\n' "$(printf 'a\tb' | od -An -c | tr -s ' ')"
echo "replace: $(printf '%s\n' "${v}" | sed 's/a/o/g')"
printf 'slice: %.3s\n' "${v}"
echo "upper: $(printf '%s\n' "${v}" | tr '[:lower:]' '[:upper:]')"
i=1
i=$((i + 1))
echo "incr: ${i}"
v="${v}!"
echo "append: ${v}"
printf '%s\n' hi | sed 's/^/here-string: /'
echo hi >/dev/null 2>&1 && echo 'redirect: >/dev/null 2>&1'
echo "type: $(command -v cd)"
printf 'brace:'
for x in a b; do printf ' %s' "${x}"; done
echo
echo 'echo "source: sourced"' >"${TMPDIR:-/tmp}/p10_src.sh"
# shellcheck source=/dev/null
. "${TMPDIR:-/tmp}/p10_src.sh"
rm -f "${TMPDIR:-/tmp}/p10_src.sh"
```

然后把它交给五个 shell，比较输出：

```text
$ for s in dash mksh yash "${CAIRN_BUSYBOX} sh" "bash --posix"; do
    n="${s##*/}"; n="${n%% *}"; ${s} replace.sh >"out_${n}.txt"
  done
$ md5sum out_*.txt | cut -c1-8 | sort | uniq -c
      5 994da221
```

五个 shell 的输出完全相同（这是比较 md5 的前 8 个字符得到的，五个一样），其中一份是：

```text
glob: case
and: [ a ] && [ b ]
eq: =
array: set -- gives 3 items, second is 'b c'
echo-e:  a \t b
replace: bonono
slice: ban
upper: BANANA
incr: 2
append: banana!
here-string: hi
redirect: >/dev/null 2>&1
type: cd
brace: a b
source: sourced
local: inner
local: after, x is outer
mapfile: [one] [two]
```

整理成表：

| bash 的写法 | POSIX 的写法 | 备注 |
| --- | --- | --- |
| `[[ -f x && -r x ]]` | `[ -f x ] && [ -r x ]` | `[` 是命令，`&&` 在命令之间 |
| `[[ ${f} == *.txt ]]` | `case "${f}" in *.txt) ... ;; esac` | `case` 的模式是 glob，第 4 篇 “case：模式是 glob，不是正则” 一节讲过 |
| `[ a == a ]` | `[ a = a ]` | 标准的字符串比较只有 `=` |
| `files=(a "b c")`、`"${files[@]}"` | `set -- a "b c"`、`"$@"` | 唯一的数组，见 “set --：唯一的数组” 一节 |
| `echo -e 'a\tb'`、`$'a\tb'` | `printf 'a\tb'` | 见 “echo 还是 printf” 一节；`$'..'` 到 2024 年才进标准 |
| `${v//a/o}` | `printf '%s\n' "${v}" \| sed 's/a/o/g'` | 多一个进程 |
| `${v:0:3}` | `printf '%.3s\n' "${v}"` | 精度截断，没有进程 |
| `${v^^}` | `printf '%s\n' "${v}" \| tr '[:lower:]' '[:upper:]'` | 多一个进程 |
| `(( i++ ))`、`$((i++))` | `i=$((i + 1))` | `$(( ))` 在标准里，`++` 和 `--` 第 2.6.4 节说 “不是必需的”；dash 的报错是 `arithmetic expression: expecting primary: "i++"` |
| `v+=x` | `v="${v}x"` | |
| `cat <<< "$v"` | `printf '%s\n' "${v}" \| cat`，或 here-document | |
| `cmd &> file` | `cmd > file 2>&1` | 顺序是从左到右，第 5 篇 “重定向：从左到右，一次一个 dup2” 一节讲过 |
| `type -t cd` | `command -v cd` | `command -v` 打印名字或路径，不打印种类 |
| `echo {a,b}` | `for x in a b; do ...; done` | 花括号展开不在标准里 |
| `source file` | `. file` | `.` 是特殊内建 |
| `function f { ...; }` | `f() { ...; }` | |
| `diff <(a) <(b)` | 把两个命令的输出先写到临时文件 | 没有一行的替代 |
| `mapfile -t lines < file` | `while IFS= read -r line; do ...; done < file` | |
| `local x` | 子 shell 函数 `f() ( ... )` | 见 “local 不是 POSIX” 一节 |

`command -v` 那一行兑现了第 1 篇 “找到程序：PATH、hash、内建与外部” 一节的一句话：`command -v`/`-V` 是 POSIX 规定的写法，而 `type` 的 `-a`、`-t` 不是，“第 10 篇回到这个区别”，就是这一行。

## local 不是 POSIX

`local` 在 Cairn 里出现了 78 行（见 “Google 的 100 行规则，和 Cairn 的 1445 行” 一节的计数），Google 的指南也要求函数里的变量都用它。标准没有它：第 2.9.1.4 节那张 “结果未指定” 的表里就有 `local`。ShellCheck 对它的态度是：

```text
$ shellcheck -s sh loc.sh

In loc.sh line 4:
  local x=2
  ^-----^ SC3043 (warning): In POSIX sh, 'local' is undefined.

For more information:
  https://www.shellcheck.net/wiki/SC3043 -- In POSIX sh, 'local' is undefined.
```

[SC3043](https://www.shellcheck.net/wiki/SC3043)。可是 “五个 shell 的对照表” 一节里，`local` 是整张表里唯一一个五个 shell 全都接受的非标准写法。那为什么 `install.sh` 还要绕开它？因为 “都接受” 不等于 “行为一样”。`localsem.sh` 是我另写的一个小草稿（不在仓库里），问的是：外面有 `x=outer`，函数里写 `local x`（不给初值）和 `local x=`（给一个空值），`x` 各是什么？

```bash
#!/usr/bin/env bash
# 草稿，不在仓库里：local x 和 local x= 在函数里分别是什么？
x=outer
f() {
  local x
  echo "bare:  [${x-unset}]"
}
g() {
  local x=
  echo "empty: [${x-unset}]"
}
f
g
```

```text
$ for s in dash bash "${CAIRN_BUSYBOX} sh" mksh yash; do
    echo "--- ${s/#${CAIRN_BUSYBOX}/busybox}"; ${s} localsem.sh
  done
--- dash
bare:  [outer]
empty: []
--- bash
bare:  [unset]
empty: []
--- busybox sh
bare:  [unset]
empty: []
--- mksh
bare:  [unset]
empty: []
--- yash
bare:  [unset]
empty: []
```

`local x=` 在五个 shell 里都是空串；`local x` 在 bash、BusyBox、mksh、yash 里是 `unset`，在 dash 里是 `outer`：dash 的 `local x` 看起来只声明 “这个名字在函数里是局部的”，不清空它（我没有去读 dash 的源码，这是从输出猜的）。所以同一行 `local x`，后面接着写 `x=${x:-default}`，在 dash 和 bash 里会得到不同的东西。可移植的写法是永远给初值，`local x=`；可是这样 ShellCheck 还是会报 SC3043，所以 `install.sh` 干脆不用。

那函数里的临时变量放哪里？`install.sh` 的办法写在文件头的注释里：“需要临时变量的函数写成子 shell 函数，`name() ( ... )`，变量出不来；其余的用文件顶部的全局变量。” 函数体用圆括号而不是花括号，整个函数就在子 shell 里跑（第 5 篇 “子 shell 和花括号组” 一节讲过）：里面随便赋值，函数一返回就全部消失。“替换对照” 一节里的 `replace.sh` 后半部分验证了这一点：

```sh
#######################################
# 没有 local 的函数：子 shell 里的变量出不来。
#######################################
scratch() (
  x=inner
  echo "local: ${x}"
)
x=outer
scratch
echo "local: after, x is ${x}"
printf 'mapfile:'
printf 'one\ntwo\n' | while IFS= read -r line; do printf ' [%s]' "${line}"; done
echo
```

对应的输出是 `local: inner` 和 `local: after, x is outer`（见 “替换对照” 一节的输出）。代价有两个：每次调用多一个 `fork`，`install.sh` 总共只调用十几次，量不出来；以及函数不能给调用者留下变量，要返回信息只能打印或者用退出码。`exit` 在这里就是 `return`：它退出的是子 shell。

还有一个坑，是我在写这个脚本时才想清楚的。在子 shell 函数里到处写 `|| exit`，看起来多余：`set -eu` 不是已经让任何失败都退出了吗？不是的。`set -e` 在 “出现在 `||`、`&&`、`if` 条件里” 的命令里不生效，而且这个豁免会传进函数体。我写了一个草稿 `sete.sh`（不在仓库里）：

```sh
#!/bin/sh
# 草稿，不在仓库里：set -e 在 || 左边的函数里不生效。
set -e
f() {
  false
  echo "f went on after false"
}
f || echo "not reached"
echo '--- bare call'
f
echo "not reached either"
```

```text
$ bash sete.sh
f went on after false
--- bare call
$ dash sete.sh
f went on after false
--- bare call
```

`f || echo "not reached"` 这一行里，`f` 里的 `false` 没有让 shell 退出，`echo "f went on after false"` 照样执行了；单独调用 `f` 时才退出（所以 `--- bare call` 之后什么都没有了）。bash 和 dash 的行为相同。`install.sh` 里 `for_each_file "${src_dir}" install_file || return 1` 正是这种位置，所以函数里每个可能失败的命令后面都带一个显式的 `|| exit`，这是第 7 篇 “set -e 能管什么” 一节那个例外在 POSIX sh 里的样子。

## echo 还是 printf

第 6 篇 “echo 还是 printf” 一节说过，POSIX 的 [echo 页面](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/echo.html)在 APPLICATION USAGE 里说，除非避开转义序列，并且第一个参数不是 `-` 后面只跟 `e`、`E`、`n` 的形式，否则 `echo` 没法在所有 POSIX 系统上可移植地使用，并建议新程序用 `printf`；我当时答应以后把它在几个 shell 里跑一遍，就是这一节。`lab/ch10/echo_portability.sh` 就是这个实验，一共 19 行：

```bash
# shellcheck shell=bash
# Shows: echo is not portable. Each shell runs `echo 'a\nb'` and
# `echo -n x; echo`; the output is printed with printf %q so that a real
# newline and a backslash followed by n look different. An echo that
# does not understand -n prints it as text.
printf '%-14s %-14s %s\n' shell "echo 'a\\nb'" 'echo -n x'
row() {
  local label="$1"
  shift
  local a n
  a="$("$@" -c "echo 'a\\nb'")"
  n="$("$@" -c 'echo -n x; echo')"
  printf '%-14s %-14q %q\n' "${label}" "${a}" "${n}"
}
row dash dash
row bash bash
row 'busybox sh' "${CAIRN_BUSYBOX}" sh
row yash yash
row mksh mksh
```

每个 shell 跑 `echo 'a\nb'` 和 `echo -n x; echo`，结果用 `printf '%q'` 打印，这样一个真正的换行和一个反斜杠加 `n` 看起来不一样：

```text
shell          echo 'a\nb'    echo -n x
dash           $'a\nb'        x
bash           a\\nb          x
busybox sh     a\\nb          x
yash           $'a\nb'        -n\ x
mksh           $'a\nb'        x
```

读法：`$'a\nb'` 是 “中间有一个真的换行”，`a\\nb` 是 “反斜杠和 n 两个字符”（`%q` 把反斜杠写成 `\\`）。dash、yash、mksh 把 `\n` 解释成了换行；bash 和 BusyBox 的 ash 没有。第二列，dash 和 bash、BusyBox、mksh 都把 `-n` 当成选项（输出 `x`），yash 把它当成文本，打印 `-n x`。五个 shell，两个问题，答案不是一个。（bash 的手册里还有一个 `xpg_echo` 选项会改变 `echo` 对转义的处理；我没有测它，上面说的都是默认行为。）

这不只是实验室里的现象。一个 Windows 风格的路径放进 `echo "$1"`：

```text
$ line='C:\new\table'
$ dash -c 'echo "$1"' sh "${line}" | od -An -c
   C   :  \n   e   w  \t   a   b   l   e  \n
$ dash -c 'printf "%s\n" "$1"' sh "${line}" | od -An -c
   C   :   \   n   e   w   \   t   a   b   l   e  \n
$ bash -c 'echo "$1"' sh "${line}" | od -An -c
   C   :   \   n   e   w   \   t   a   b   l   e  \n
$ bash -c 'printf "%s\n" "$1"' sh "${line}" | od -An -c
   C   :   \   n   e   w   \   t   a   b   l   e  \n
```

dash 的 `echo` 把 `\n` 和 `\t` 吃成了换行和制表符，`C:\new\table` 面目全非；bash 的 `echo` 原样输出；两个 shell 的 `printf '%s\n'` 都原样输出。同一行 `echo "$line"`，在 NixOS 上是对的，到了 Debian 上悄悄变成别的东西。第 6 篇 “echo 还是 printf” 一节我说过 `printf` 是更好的选择，现在有了跨 shell 的证据：`printf '%s\n' "${line}"`，格式串自己控制，参数里的反斜杠永远不被解释。Cairn 的 `bin/cairn` 和 `lib/cairn/*.sh` 里有 30 行用了 `printf`，一行 `echo` 都没有（`cat bin/cairn lib/cairn/*.sh | grep -c '\becho\b'` 打印 0）；`install.sh` 里同样一个 `echo` 都没有。

## set --：唯一的数组

第 1 篇 “练习” 一节练习 1 的答案里说过 `set --` 会重置位置参数，还说后面会讲它是 POSIX shell 里仅有的 “数组”，这一节就是那个后面。POSIX sh 没有 `arr=(...)`，没有 `${arr[2]}`，没有关联数组；它有一个列表，就是位置参数 `"$@"`，一个 `$#`，一个 `shift`，和一个可以整个替换它的 `set --`。`lab/ch10/posix_idioms.sh` 把 “bash 习惯的 POSIX 替代” 写成一个能在 dash 里跑的脚本，先写到沙箱里，再用 `dash -n` 和 checkbashisms 检查，最后用 dash 执行（这个实验脚本一共 52 行，主体是下面这一段，节选）：

```bash
script="${LAB_TMP}/idioms.sh"
cat >"${script}" <<'IDIOMS'
#!/bin/sh
name=snapshot-2026.tar.gz
case "${name}" in
  *.tar.gz | *.tgz) echo "case: ${name} is a tarball" ;;
  *) echo "case: ${name} is something else" ;;
esac

set -- one 'two words' three
echo "set --: $# items, second is '$2'"
set -- "$@" four
for item in "$@"; do
  printf '  [%s]\n' "${item}"
done

printf 'printf: %s|%5d|%-6s|\n' x 42 ab

command -v dash >/dev/null && echo 'command -v: dash found'
command -v no_such_command_xyz >/dev/null 2>&1 \
  || echo 'command -v: no_such_command_xyz missing'

path=/a/b/c.txt
echo "expansion: ${path##*/} ${path%/*} ${path%.txt} ${#path}"
echo "arithmetic: $((2 + 3 * 4)) $((17 % 5)) $((1 << 4))"
# ...
dash -n "${script}" && echo 'dash -n: ok'
checkbashisms "${script}" && echo 'checkbashisms: clean'
echo '--- dash idioms.sh ---'
dash "${script}"
```

输出 15 行：

```text
dash -n: ok
checkbashisms: clean
--- dash idioms.sh ---
case: snapshot-2026.tar.gz is a tarball
set --: 3 items, second is 'two words'
  [one]
  [two words]
  [three]
  [four]
printf: x|   42|ab    |
command -v: dash found
command -v: no_such_command_xyz missing
expansion: c.txt /a/b /a/b/c 10
arithmetic: 14 2 16
getopts: verbose=1 out=file.txt rest=a b
```

逐个看。`case` 用 glob 模式代替 `[[ ... == pat ]]`（`*.tar.gz | *.tgz` 一个分支两个模式）。`set -- one 'two words' three` 之后 `$#` 是 3，`$2` 是 `two words`，带空格的元素没有被拆开；`set -- "$@" four` 是追加，列表里变成四项。`printf` 的 `%5d` 和 `%-6s` 宽度控制和 C 一样。`command -v` 判断命令在不在：`command -v dash >/dev/null && ...`，找不到时它不打印任何东西，退出状态非 0（我在这里看到 dash 是 127、bash 是 1，所以判断条件要写 `if command -v ...`，不要比较具体的数字）。参数展开 `${path##*/}` (`c.txt`)、`${path%/*}` (`/a/b`)、`${path%.txt}` (`/a/b/c`)、`${#path}` (10) 这四个都是标准里的（第 3 篇 “参数展开：${...} 里的运算符” 一节讲的另一批，`${v//a/b}` 和 `${v^^}` 一类，不是）。`$(( ))` 做整数运算，`2 + 3 * 4` 是 14、`17 % 5` 是 2、`1 << 4` 是 16。`getopts` 解析 `-v -o file.txt a b`：`verbose=1 out=file.txt rest=a b`；注意它放在 `parse() ( ... )` 里，`OPTIND=1` 每次重置，`shift "$((OPTIND - 1))"` 丢掉已经解析的选项，和第 4 篇 “getopts 和手写选项循环” 一节一样，只是函数体换成了圆括号。

数组的实际用处是装参数。`cairn::snapshot::create` 里有一个 `exclude_args` 数组，把配置里每个 `exclude` 变成一个 `--exclude=...` 传给 rsync。我用 `set --` 重写了它的骨架（`argv.sh`，不在仓库里），模式放在一个换行分隔的字符串里：

```sh
#!/bin/sh
# 草稿，不在仓库里：用 set -- 重写 cairn::snapshot::create 里的 exclude_args。
# 每行一个模式，模式里没有换行。
excludes='*.tmp
with space.cache'

#######################################
# 每行一个 <参数>，打印 rsync 的参数列表。
# Globals:
#   excludes
#######################################
show_rsync_args() (
  set -f # 模式里有 *，不让 shell 去通配
  IFS='
'
  set --
  # shellcheck disable=SC2086 # 就是要按换行分词
  for pat in ${excludes}; do
    set -- "$@" "--exclude=${pat}"
  done
  set -- --archive "$@" /src /dest
  printf '<%s>\n' "$@"
)

show_rsync_args
```

在五个 shell 里跑，输出完全一样：

```text
$ for s in dash mksh yash "${CAIRN_BUSYBOX} sh" "bash --posix"; do
    printf '%-13s' "${s##*/}"; ${s} argv.sh | paste -sd' '
  done
dash         <--archive> <--exclude=*.tmp> <--exclude=with space.cache> </src> </dest>
mksh         <--archive> <--exclude=*.tmp> <--exclude=with space.cache> </src> </dest>
yash         <--archive> <--exclude=*.tmp> <--exclude=with space.cache> </src> </dest>
busybox sh   <--archive> <--exclude=*.tmp> <--exclude=with space.cache> </src> </dest>
bash --posix <--archive> <--exclude=*.tmp> <--exclude=with space.cache> </src> </dest>
```

三个细节。`set -f` 关掉通配，因为 `*.tmp` 里的 `*` 不能被展开；`IFS` 只留换行，所以 `with space.cache` 不会在空格处断开；整个函数是子 shell 函数，`set -f` 和 `IFS` 的改动都出不来。限制也很清楚：一个函数只有一个 `"$@"`，所以第二个列表只能退化成字符串，像上面的 `excludes` 那样靠分隔符，而分隔符不能出现在元素里。这就是为什么 Cairn 这样需要 `exclude_args`、`CAIRN_SOURCES`、`CAIRN_EXCLUDES` 三个数组的程序，写成 POSIX sh 会很痛苦，而 `install.sh` 只需要一个文件列表（它直接用 `for f in "${src}"/lib/cairn/*` 的通配）。

## install.sh：一个只许用 POSIX 的文件

Google 的指南在 “[选哪个 shell](https://google.github.io/styleguide/shellguide.html#s1.1-which-shell-to-use)” 一节写得很绝对：可执行的 shell 脚本只许用 bash，因为这样 “我们所有的机器上都有一致的 shell 语言”，所以 “一般没有必要追求 POSIX 兼容，也不必避开 bashism”。紧接着是我这一篇要用的那句例外：“唯一的例外是你被你正在写的东西强迫的时候。比如一些老的操作系统或者受限的执行环境，可能要求某些脚本只能用纯 Bourne shell。” 这个站点的 `docs/code-style.md` 把它抄成了一条本地规则：只有目标强迫时才用 POSIX `sh`（安装脚本、`/bin/sh` 钩子、嵌入式系统），代码块标成 `sh`，而不是 `bash`。

安装脚本是这条例外最典型的住户。它是用户拿到 Cairn 之后跑的第一个东西，运行的机器我一无所知：可能是一个只有 BusyBox 的容器，可能是一台刚装好系统、还没装 bash 5 的机器。这时候说 “请先装一个 bash，再来运行安装脚本” 是自相矛盾的。所以 `install.sh` 是整个仓库里唯一一个真正要被执行的 `#!/bin/sh` 文件（夹具和实验脚本里也有 `#!/bin/sh`，那只是演示用的文本），也是唯一一个我不许它碰 bashism 的文件。它没有强迫到的地方，Google 的规则照旧：

| Google 的规则 | 在 `install.sh` 里 |
| --- | --- |
| `#!/usr/bin/env bash`（本站对 `#!/bin/bash` 的改写） | `#!/bin/sh`，这是例外本身 |
| `[[ ... ]]` | `[ ... ]` 和 `case` |
| 函数里的变量用 `local` | 没有 `local`，用子 shell 函数 `name() ( ... )`，见 “local 不是 POSIX” 一节 |
| 库函数叫 `package::function` | 函数叫 `err`、`usage`、`main`、`install_file`：dash 不接受 `::`，见 “五个 shell 的对照表” 一节 |
| 参数列表放数组 | 没有数组；文件列表是 `for f in "${src}"/lib/cairn/*` |
| 文件头注释；函数头注释 (`Globals:`, `Arguments:`, `Outputs:`, `Returns:`) | 照旧，每个函数都有 |
| 常量 `readonly` 放顶部；所有函数在后；`main "$@"` 在最后一行 | 照旧 |
| 2 空格缩进，80 列 | 照旧，我用 `LC_ALL=C.UTF-8 awk 'length > 80' install.sh \| wc -l` 按字符数过，0 行（`LC_ALL=C` 下 awk 按字节数，带汉字的注释会被多算，数出 2 行） |
| 报错写 stderr，经过一个函数 | `err()` |

整个文件 236 行。第 1 篇 “Google 规则，第一批，以及两个工具” 一节说过 Google 的指南建议超过 100 行的脚本就该换一门语言，所以我先把账摆出来：

```text
$ wc -l install.sh
236 install.sh
$ grep -cvE '^[[:space:]]*(#|$)' install.sh
132
```

236 行，去掉注释和空行还有 132 行，两种算法都超过了 100。它是这个系列里我最清楚理由的一条违规，理由在 “Google 的 100 行规则，和 Cairn 的 1445 行” 一节。下面分段读它，每段都不超过 40 行。

### 头部、常量和全局

头 31 行是文件头注释、`set -eu`、一个常量和两个全局变量：

```sh
#!/bin/sh
#
# install.sh: install or remove cairn.
#
# Usage: install.sh [--prefix DIR] [--uninstall] [-h]
#
# POSIX sh only (checked with checkbashisms, shellcheck -s sh and dash),
# because an installer must run where bash may not be installed yet. The
# style guide's rule "Bash for everything" has this one exception.
#
# `local` is not POSIX, so no function here declares one. Functions that
# need scratch variables are written as subshell functions, name() ( ... ),
# which cannot leak their variables; the rest use the globals below.

set -eu

# 卸载时按此顺序 rmdir (只删空目录), 先深后浅。
readonly CREATED_DIRS='
  share/cairn/systemd
  share/cairn
  share/bash-completion/completions
  share/bash-completion
  lib/cairn
  lib
  bin
  share
'

# Parsed from the command line by main; used by the helpers below.
PREFIX=
UNINSTALL=0
```

第 7 到 13 行的注释就是上面那段理由：用 checkbashisms、`shellcheck -s sh` 和 dash 检查过，因为安装脚本必须在 bash 可能还没装的地方跑；`local` 不是 POSIX，所以没有函数声明它。`set -eu` 是 POSIX 的两个选项：`-e` 失败就退出，`-u` 引用未设置的变量就报错。没有 `pipefail`，因为整个文件里没有一条管道。`CREATED_DIRS` 是 `readonly` 的多行字符串，卸载时按 “先深后浅” 的顺序去 `rmdir`。`PREFIX` 在这里是空串：默认的 `$HOME/.local` 要等 `main` 解析完命令行才决定，原因在 “两个修好的洞，一个没修的洞” 一节。

### 一份文件列表，两个动作

安装和卸载要处理的是同一份文件清单，所以它只写一次，动作用回调传进去。`for_each_file` 对每个文件调用一次 `${cmd}`，参数是模式、源文件、相对目标路径；`install_file` 和 `remove_file` 是两个回调：

```sh
#######################################
# Call a command once per file cairn installs.
# Arguments:
#   Source directory, command name. The command is called as
#   COMMAND MODE SOURCE_FILE RELATIVE_DESTINATION.
# Returns:
#   The first non-zero status of the command.
#######################################
for_each_file() (
  src="$1"
  cmd="$2"
  "${cmd}" 755 "${src}/bin/cairn" bin/cairn || exit
  for f in "${src}"/lib/cairn/*; do
    [ -f "${f}" ] || continue
    "${cmd}" 644 "${f}" "lib/cairn/${f##*/}" || exit
  done
  "${cmd}" 644 "${src}/completions/cairn.bash" \
    share/bash-completion/completions/cairn || exit
  for f in "${src}"/contrib/systemd/*; do
    [ -f "${f}" ] || continue
    "${cmd}" 644 "${f}" "share/cairn/systemd/${f##*/}" || exit
  done
)
```

```sh
#######################################
# Install one file below the staging root.
# Globals:
#   ROOT (set by main)
# Arguments:
#   Mode, source file, destination relative to ROOT.
# Outputs:
#   Writes "installed <path>" to stdout.
# Returns:
#   Non-zero if the source is missing or a command fails.
#######################################
install_file() (
  mode="$1"
  from="$2"
  to="${ROOT}/$3"
  if [ ! -f "${from}" ]; then
    err "missing source file ${from}"
    exit 1
  fi
  mkdir -p -- "${to%/*}" || exit
  cp -- "${from}" "${to}" || exit
  chmod "${mode}" "${to}" || exit
  printf 'installed %s\n' "${to}"
)
```

几个 POSIX 的惯用法在这里一起出现：`"${f##*/}"` 代替 `basename`，`"${to%/*}"` 代替 `dirname`，都是第 3 篇 “参数展开：${...} 里的运算符” 一节讲过的参数展开，不需要外部进程；`for f in "${src}"/lib/cairn/*` 后面跟 `[ -f "${f}" ] || continue`，是因为 POSIX 的通配在没有匹配时保持原样（那个字面的 `*`），要自己排除；`mkdir -p --`、`cp --` 的 `--` 保证带 `-` 开头的路径不会被当成选项（第 2 篇 “名字以 - 开头” 一节的老话）。我没有用 `install -m 755`，而是 `cp` 加 `chmod`：我在 POSIX 2024 的 [Utilities 索引](https://pubs.opengroup.org/onlinepubs/9799919799/idx/utilities.html)里没有找到 `install` 这个名字，而 `cp`、`mkdir`、`chmod`、`rm`、`rmdir` 都在。

卸载的回调和清理空目录是这样：

```sh
#######################################
# Remove one installed file; a file that is not there is not an error.
# Globals:
#   ROOT (set by main)
# Arguments:
#   Mode (unused), source file (unused), destination relative to ROOT.
# Outputs:
#   Writes "removed <path>" to stdout.
#######################################
remove_file() (
  to="${ROOT}/$3"
  if [ -f "${to}" ]; then
    rm -f -- "${to}" || exit
    printf 'removed %s\n' "${to}"
  fi
)

#######################################
# Remove the directories install uses, but only the empty ones, whoever
# created them.
# Globals:
#   ROOT, CREATED_DIRS
#######################################
remove_empty_dirs() (
  for d in ${CREATED_DIRS}; do
    rmdir -- "${ROOT}/${d}" 2>/dev/null || :
  done
)
```

因为安装和卸载共用 `for_each_file`，“卸载删除的恰好是安装放进去的” 是结构上成立的，不是靠两份清单手工保持一致。`remove_file` 的参数 `$1`、`$2` 用不上（注释里写明了），只用 `$3`。

`remove_empty_dirs` 不问目录是谁建的：`CREATED_DIRS` 里的 8 个目录，空的就删，包括安装之前就存在的。这是有意的取舍，“两个修好的洞，一个没修的洞” 一节讲。

### 命令行和 main

选项解析，没有 `getopts`：`--prefix` 是长选项，POSIX 的 `getopts` 只认单字符选项，所以和第 4 篇 “getopts 和手写选项循环” 一节里 Cairn 的主程序一样手写循环：

```sh
#######################################
# Parse the command line into PREFIX and UNINSTALL.
# Globals:
#   PREFIX, UNINSTALL
# Arguments:
#   The command line.
# Outputs:
#   Writes usage to stdout for -h, errors to stderr.
# Returns:
#   0 to go on, 10 if the caller should exit 0 (help), 2 on usage error.
#######################################
parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --prefix)
        if [ "$#" -lt 2 ] || [ -z "$2" ]; then
          err "--prefix needs a directory"
          return 2
        fi
        PREFIX="$2"
        shift 2
        ;;
      --uninstall)
        UNINSTALL=1
        shift
        ;;
      -h)
        usage
        return 10
        ;;
      *)
        err "unknown option '$1'"
        err "run 'install.sh -h' for usage"
        return 2
        ;;
    esac
  done
}
```

`parse_args` 的返回值是一个小协议：0 继续，10 是 “帮助已经打印，调用者应当以 0 退出”，2 是用法错误。我猜选 10 是为了让 `-h` 之后 `main` 仍然走统一的出口，不过这是猜的。接下来是 `main`（省略了它的函数头注释）：

```sh
main() {
  status=0
  parse_args "$@" || status=$?
  case "${status}" in
    0) ;;
    10) return 0 ;;
    *) return "${status}" ;;
  esac

  if [ -z "${PREFIX}" ]; then
    if [ -z "${HOME:-}" ]; then
      err 'HOME is not set; use --prefix DIR'
      return 2
    fi
    PREFIX="${HOME}/.local"
  fi

  # 去掉末尾的斜杠, 避免路径里出现 //; 前缀 "/" 因此得到空串, 路径照样成立。
  ROOT="${DESTDIR:-}"
  ROOT="${ROOT%/}${PREFIX%/}"

  # install.sh 所在目录就是源码目录; 不依赖 readlink -f 或 dirname。
  case "$0" in
    */*) src_dir="${0%/*}" ;;
    *) src_dir=. ;;
  esac
  src_dir="$(cd -- "${src_dir}" && pwd -P)" || return 1

  if [ "${UNINSTALL}" -eq 1 ]; then
    for_each_file "${src_dir}" remove_file || return 1
    remove_empty_dirs
    return 0
  fi

  if ! command -v bash >/dev/null 2>&1; then
    printf '%s\n' \
      'install.sh: warning: bash not found in PATH; cairn needs bash' >&2
  fi
  for_each_file "${src_dir}" install_file || return 1
}
```

`parse_args "$@" || status=$?` 是 `set -e` 下取返回值的标准写法：`||` 让这一行不会因为非零退出，同时 `status` 拿到了值。`ROOT` 是 `DESTDIR` 加 `PREFIX`，两边都先去掉末尾的斜杠，这样 `--prefix /` 得到空串，`${ROOT}/bin/cairn` 仍然是 `/bin/cairn`。`DESTDIR` 是打包工具的惯例：先装进一个暂存目录，再整个打成包。`src_dir` 的求法不用 `readlink -f` 也不用 `dirname`：`$0` 里有斜杠就取斜杠之前的部分，没有就是当前目录，再 `cd` 进去 `pwd -P`。最后，`command -v bash` 找不到就在 stderr 打印一行警告，但继续安装：`bash not found` 不是安装的错误，而是 Cairn 运行的前提，装完才会碰到。

新加的那一段是 `PREFIX` 的默认值：`parse_args` 没有从命令行拿到 `--prefix` 才轮到 `HOME`，`HOME` 没设置或者是空串就报错，退出码 2，不去猜一个路径。它为什么不在文件顶部，“两个修好的洞，一个没修的洞” 一节讲。

这套行为我在 dash 里跑一遍，用 `DESTDIR` 暂存，再卸载：

```text
$ DESTDIR=/tmp/stage dash ./install.sh --prefix /usr | sed -n '1p;$p'
installed /tmp/stage/usr/bin/cairn
installed /tmp/stage/usr/share/cairn/systemd/cairn.timer
$ find /tmp/stage -type f | wc -l
13
$ stat -c "%a %n" /tmp/stage/usr/bin/cairn /tmp/stage/usr/lib/cairn/log.sh
755 /tmp/stage/usr/bin/cairn
644 /tmp/stage/usr/lib/cairn/log.sh
$ DESTDIR=/tmp/stage dash ./install.sh --prefix /usr --uninstall | wc -l
13
$ find /tmp/stage -mindepth 1
/tmp/stage/usr
```

13 个文件，`bin/cairn` 是 755，`lib/cairn/log.sh` 是 644；卸载打印了 13 行 `removed`，最后 `/tmp/stage` 里只剩下一个 `/tmp/stage/usr`：前缀目录本身不在 `CREATED_DIRS` 里，卸载不会去动它，测试 “uninstall leaves no files and no directories” 断言的也是前缀目录里面什么都不剩。

### 两个修好的洞，一个没修的洞

写完脚本、跑测试的时候，我撞到了三个没有被任何测试盯住的行为。前两个在最终的 `ch10` 里已经修了，各带测试；第三个我没有修。下面先看前两个修之前的样子，因为它们说明了该测什么。

**一，`HOME` 没设置时默认前缀变成 `/.local`。** 我最初的写法是文件顶部一行 `PREFIX="${HOME:-}/.local"`，`HOME` 为空时给出 `/.local`，没有报错。我用 `DESTDIR` 把它挡在暂存目录里：

```text
$ env -u HOME DESTDIR=/tmp/p10/dd dash install.sh | sed -n 1p
installed /tmp/p10/dd/.local/bin/cairn
$ ls -a /tmp/p10/dd
.
..
.local
```

没有 `DESTDIR` 时同样的命令会在根目录下建一个 `/.local`（我没有用 root 跑过，不敢拿真的根目录做实验）。修法是把默认值往后推：`PREFIX` 一开始是空串，`main` 在解析完命令行之后才看 `HOME`（上一节 `main` 里新加的那一段）。默认值不能留在文件顶部，因为那时还不知道有没有 `--prefix`：给了 `--prefix`，`HOME` 没设置就不是错误。现在是这样：

```text
$ env -u HOME DESTDIR=/tmp/p10/dd2 dash install.sh; echo "exit $?"
install.sh: error: HOME is not set; use --prefix DIR
exit 2
$ ls /tmp/p10/dd2
ls: cannot access '/tmp/p10/dd2': No such file or directory
$ env -u HOME dash install.sh --prefix /tmp/p10/dd2p | sed -n 1p
installed /tmp/p10/dd2p/bin/cairn
```

三个新测试盯着它：`HOME` 没设置、`HOME` 是空串、`HOME` 没设置但给了 `--prefix`。

**二，卸载会删掉安装之前就存在的空目录。** 最初 `usage` 和 README 写的是卸载会删 “它自己创建的空目录”，实际行为是 “`CREATED_DIRS` 里这 8 个目录，只要是空的就删”，不管是谁创建的。我先建一个空的 `bin`，装，再卸载：

```text
$ mkdir -p /tmp/p10/bug/bin
$ dash install.sh --prefix /tmp/p10/bug > /dev/null
$ dash install.sh --prefix /tmp/p10/bug --uninstall > /dev/null
$ ls -d /tmp/p10/bug/bin
ls: cannot access '/tmp/p10/bug/bin': No such file or directory
```

`bin` 是我自己建的，卸载把它删了。在 `~/.local` 下这个后果很小，一个空的 `~/.local/bin` 很快就会再被谁建出来，所以我选了改文档，不改行为：`dash install.sh -h` 的文字和 README 现在直说，卸载先删文件，再删这 8 个目录里已经空了的，“even if they existed before”。再加一个测试把它钉住，这样文档、行为、测试三者一致：

```bash
@test "--uninstall removes a pre-existing empty bin directory" {
  mkdir -p -- "${PREFIX_DIR}/bin"
  run_installer dash -- --prefix "${PREFIX_DIR}" --uninstall
  assert_success
  assert_not_exist "${PREFIX_DIR}/bin"
}
```

真要做到 “只删自己建的”，得在安装时记下哪些目录是这次建的，这是练习 3。

**三，标准输出被提前关闭会让安装停在一半。** 这一个没修。`install_file` 每装一个文件就 `printf` 一行到 stdout；如果下游关了管道，`printf` 收到 `SIGPIPE`，整个脚本死掉，剩下的文件就不装了，而且没有任何错误信息：

```text
$ dash install.sh --prefix /tmp/p10/x | head -n 3
installed /tmp/p10/x/bin/cairn
installed /tmp/p10/x/lib/cairn/config.sh
installed /tmp/p10/x/lib/cairn/diff.awk
$ find /tmp/p10/x -type f | wc -l
4
```

`head -n 3` 读了三行就走，安装在第四个文件之后死掉，只装了 4 个，而不是 13 个。正常使用 `install.sh` 的人不会把它接给 `head`；它可能被一个日志收集器接走，收集器先退出。要避免半装，大概得先确定 `printf` 失败时的处理方式（忽略 `PIPE` 信号再检查返回值，或者干脆不往 stdout 写），我没有试过具体的修法，因为它改变的是输出约定，而我想让这个脚本停在测试已经盯住的那一版。

## 一份安装，五个 shell

脚本说自己是 POSIX，要有人证明。`lab/ch10/install_matrix.sh` 把 `install.sh` 交给五个 shell，每个装进自己的前缀，装完要求已安装的 `cairn --version` 打印 `cairn 0.1.0`，有一个失败就以退出码 1 结束，一共 21 行：

```bash
# shellcheck shell=bash
# Shows: install.sh run under five shells into five prefixes. A shell
# passes when install.sh exits 0 and the installed cairn prints its
# version. Exits 1 if any shell fails.
shells=(dash "${CAIRN_BUSYBOX} sh" yash mksh 'bash --posix')
failed=0
n=0
for sh_cmd in "${shells[@]}"; do
  n=$((n + 1))
  prefix="${LAB_TMP}/prefix${n}"
  label="${sh_cmd/#${CAIRN_BUSYBOX}/busybox}"
  # shellcheck disable=SC2086
  if ${sh_cmd} "${CAIRN_ROOT}/install.sh" --prefix "${prefix}" >/dev/null \
    && [[ "$("${prefix}/bin/cairn" --version)" == 'cairn 0.1.0' ]]; then
    echo "ok ${label}"
  else
    echo "FAIL ${label}"
    failed=1
  fi
done
exit "${failed}"
```

```text
ok dash
ok busybox sh
ok yash
ok mksh
ok bash --posix
```

五行 `ok`：dash、BusyBox 的 ash、yash、mksh，以及 `bash --posix`。这个脚本自己是 bash（它在 `lab/` 下面，用数组和 `${sh_cmd/#.../}`），所以 `${sh_cmd}` 那一行要写 `# shellcheck disable=SC2086`：我就是要让 `"busybox sh"` 被分成两个词，这是第 2 篇 “分词与 IFS” 的反面：平时要防止分词，这里要的就是分词。

实验只验证 “能装”，测试验证细节。`tests/install.bats` 有 35 个测试，358 行，分成几类：五个 shell 各装一次并检查每个文件的模式；文件集合和仓库一致；默认前缀是 `$HOME/.local`，`HOME` 没设置或为空又没给 `--prefix` 是退出码 2，带空格和末尾斜杠的前缀，装两次，`DESTDIR`；源文件缺失是退出码 1；装好的 `cairn` 真的能跑，通过符号链接也能找到自己的库；卸载后什么都不剩，不碰不是它装的文件，会删掉安装前就存在的空 `bin`；`-h`、未知选项、缺 `--prefix` 的值都是退出码 2 并且什么都不装；`install.sh` 以 `#!/bin/sh` 开头，通得过 `dash -n`、checkbashisms 和 `shellcheck -s sh`。开头的辅助函数把 “用哪个 shell 跑” 做成参数：

```bash
run_installer() {
  local shell_cmd=()
  while (($# > 0)) && [[ "$1" != -- ]]; do
    shell_cmd+=("$1")
    shift
  done
  shift
  run --separate-stderr "${shell_cmd[@]}" "${INSTALL}" "$@"
}
```

这里的 `--` 是我自己约定的：它前面是 shell 命令（一个词一个参数，所以 `busybox sh` 是两个词），后面是 `install.sh` 的选项。文章开头那个 “没有 bash 的 `PATH`” 实验，就是第 31 个测试 “warns, but still installs, when bash is not in PATH”：

```bash
@test "warns, but still installs, when bash is not in PATH" {
  # PATH 里只放安装脚本用得到的外部命令, 没有 bash。
  local bin="${BATS_TEST_TMPDIR}/nobash" tool
  mkdir -- "${bin}"
  for tool in cp mkdir chmod rm rmdir; do
    ln -s "$(command -v "${tool}")" "${bin}/${tool}"
  done
  PATH="${bin}" run_installer "$(command -v dash)" -- --prefix "${PREFIX_DIR}"
  assert_success
  assert_equal "${stderr}" \
    'install.sh: warning: bash not found in PATH; cairn needs bash'
  assert_file_exist "${PREFIX_DIR}/bin/cairn"
}
```

跑一遍，再跑整套：

```text
$ bats tests/install.bats | sed -n '1p;$p'
1..35
ok 35 shellcheck -s sh finds nothing in install.sh
$ bats tests/install.bats | grep -c '^ok'
35
$ make test 2>&1 | grep -E '^(1\.\.|not ok)'
1..150
```

35 个，加上 `ch09` 的 115 个，一共 150 个，没有 `not ok`。`Makefile` 也变了。`ch09` 的 `SHELL_FILES` 里就已经列着 `install.sh`（那时文件还不存在），所以 `shellcheck` 和 `shfmt` 现在自动会看它（ShellCheck 按 `#!/bin/sh` 这一行用 POSIX 的方言检查）。这一篇对 `Makefile` 的全部改动是：

```text
$ git diff ch09 ch10 -- Makefile | grep -E '^[+-][^+-]'
+PREFIX ?= $(HOME)/.local
-.PHONY: chapters lint test coverage ci clean $(CHAPTERS)
+.PHONY: chapters lint test coverage ci install clean $(CHAPTERS)
+	checkbashisms install.sh
+install:
+	./install.sh --prefix "$(PREFIX)"
```

`make install` 在不设 `PREFIX` 的时候装到 `$(HOME)/.local`，我用 `make -n` 看它会做什么，而不是真的装：

```text
$ make -n install
./install.sh --prefix "/home/bfmhno3/.local"
```

这个路径不是随便选的：第 8 篇的 systemd 单元里写的是 `ExecStart=%h/.local/bin/cairn snapshot`，`%h` 是用户的主目录，所以默认前缀装出来的 `~/.local/bin/cairn` 恰好是单元要找的那个。第 8 篇 “定时运行：systemd 用户定时器” 一节说 “真正的路径要等第 10 篇的安装脚本才存在”，现在存在了。换了前缀就得改单元里的 `ExecStart`，README 的 “Install” 一节写了这一点。`make -s lint` 和 `install.sh` 的四个检查 (checkbashisms, `shellcheck -s sh`, `dash -n`, `shfmt`) 都是静默的，退出码 0：

```text
$ checkbashisms install.sh; echo "exit $?"
exit 0
$ shellcheck -s sh install.sh; echo "exit $?"
exit 0
$ dash -n install.sh; echo "exit $?"
exit 0
$ shfmt -i 2 -bn -ci -d install.sh; echo "exit $?"
exit 0
$ make -s lint; echo "exit $?"
exit 0
```

## 启动成本

Debian 当年换 dash，理由写在 2009 年那条新闻里：改善启动性能。dash 比 bash 快多少？`lab/ch10/startup_cost.sh` 用 hyperfine 量 `SHELL -c :`，也就是启动、什么都不做、退出（23 行）：

```bash
# shellcheck shell=bash
# Shows: how long each shell takes to start and exit (`-c :`), measured with
# hyperfine without an intermediate shell (-N), 200 runs after 20 warm-up
# runs. Prints the median in ms and the ratio to dash. Timings differ from
# run to run; no threshold is asserted.
json="${LAB_TMP}/hyperfine.json"
names=(dash bash 'busybox sh' mksh yash)
cmds=(
  'dash -c :'
  'bash -c :'
  "${CAIRN_BUSYBOX} sh -c :"
  'mksh -c :'
  'yash -c :'
)
hyperfine -N --warmup 20 --runs 200 --export-json "${json}" \
  "${cmds[@]}" >/dev/null || exit 1
printf '%-12s %10s %8s\n' shell 'median ms' 'vs dash'
jq -r --argjson n "$(printf '%s\n' "${names[@]}" | jq -R . | jq -s .)" \
  '(.results[0].median * 1000) as $base
   | .results | to_entries[]
   | [$n[.key], (.value.median * 1000), (.value.median * 1000 / $base)]
   | @tsv' "${json}" \
  | awk -F '\t' '{ printf "%-12s %10.2f %7.1fx\n", $1, $2, $3 }'
```

`-N` 让 hyperfine 不经过中间 shell，`--warmup 20` 先热身，`--runs 200` 取 200 次，输出的是中位数，单位 ms，再除以 dash 的中位数：

```text
shell         median ms  vs dash
dash               1.26     1.0x
bash               3.01     2.4x
busybox sh         1.18     0.9x
mksh               1.24     1.0x
yash               2.58     2.0x
```

bash 3.01 ms，dash 1.26 ms，比值 2.4x (3.01 / 1.26 = 2.39)；yash 2.58 ms，2.0x；BusyBox 的 ash 1.18 ms，0.9x，比 dash 还快一点；mksh 1.24 ms，1.0x。屏幕上是取整以后的数，比值是用没取整的中位数除的，所以自己除末位可能差一点。每次运行也不同：这一天里我在机器空闲时跑了 10 次，bash 的中位数在 2.83 到 3.04 ms 之间，比值在 2.3x 到 2.6x 之间，所以 “bash 的启动时间是 dash 的两倍多” 是我敢说的，具体是几倍不是。换成 dash，一个 `#!/bin/sh` 脚本每次启动大约省 1.75 ms (3.01 - 1.26 = 1.75)；假设一个启动流程跑一千个 `sh` 脚本，就是 1.75 s，我猜 2009 年那条新闻的算法就是这样，一千是我假设的数，Debian 实际跑多少个我没有数过。

回到 Cairn 自己。`bin/cairn --version` 要多久？它不只是 `bash -c :`，它还要解析 `CAIRN_LIB`、`source` 七个库（`lib/cairn/*.sh` 一共 964 行）：

```text
$ hyperfine -N --warmup 20 --runs 200 --export-json cv.json \
    "bin/cairn --version" "bash -c :" "dash -c :" > /dev/null
$ jq -r '.results[] | [.command, .median * 1000] | @tsv' cv.json
bin/cairn --version	9.543975
bash -c :	2.8746375
dash -c :	1.2696905
```

9.54 ms，是裸 `bash -c :` (2.87 ms) 的 3.3 倍 (9.5440 / 2.8746 = 3.32)，是 `dash -c :` (1.27 ms) 的 7.5 倍 (9.5440 / 1.2697 = 7.52)。比裸 bash 多出来的 6.7 ms (9.5440 - 2.8746 = 6.669) 是 Cairn 自己的启动：解析路径、读那 964 行库代码。对一个会跑 rsync 的备份工具来说，每次运行多花 6.7 ms 不值得讨论（我没有为这个判断另外量 rsync 的耗时）；这些倍数只是告诉你，shell 的 `source` 不是免费的。

## Google 的 100 行规则，和 Cairn 的 1445 行

第 1 篇 “Google 规则，第一批，以及两个工具” 一节我预告了这一节：把 “超过 100 行就该换一门更结构化的语言” 这条规则，放在 Cairn 的最终行数上。`lab/ch10/line_counts.sh` 只有 5 行：

```bash
# shellcheck shell=bash
# Shows: how long Cairn really is. wc -l of every file under bin/ and
# lib/, in C-locale order, and the total (the last line).
cd "${CAIRN_ROOT}" || exit 1
find bin lib -type f | LC_ALL=C sort | xargs wc -l
```

```text
  367 bin/cairn
  155 lib/cairn/config.sh
   43 lib/cairn/diff.awk
   33 lib/cairn/lock.sh
   84 lib/cairn/log.sh
  127 lib/cairn/manifest.sh
  137 lib/cairn/prune.sh
  129 lib/cairn/repo.sh
   71 lib/cairn/report.awk
  299 lib/cairn/snapshot.sh
 1445 total
```

总共 1445 行，是 100 的 14.45 倍。其中 1331 行是 shell (367 + 155 + 33 + 84 + 127 + 137 + 129 + 299)，114 行是 awk (43 + 71)。八个 shell 文件里有六个超过 100 行，只有 `lock.sh` (33) 和 `log.sh` (84) 没有。

`wc -l` 把注释和空行也算进去了，这对 Cairn 不太公平：Google 的指南要求每个文件有头注释、每个库函数有 `Globals:`/`Arguments:`/`Outputs:`/`Returns:`，注释越规范，行数越多。所以我换一种数法，去掉注释行和空行，并把 `install.sh` 也摆进来：

```text
$ for f in bin/cairn lib/cairn/*.sh install.sh; do
    printf '%5d %5d  %s\n' "$(wc -l <"${f}")" \
      "$(grep -cvE '^[[:space:]]*(#|$)' "${f}")" "${f}"
  done
  367   232  bin/cairn
  155    96  lib/cairn/config.sh
   33     9  lib/cairn/lock.sh
   84    27  lib/cairn/log.sh
  127    66  lib/cairn/manifest.sh
  137    83  lib/cairn/prune.sh
  129    69  lib/cairn/repo.sh
  299   180  lib/cairn/snapshot.sh
  236   132  install.sh
```

去掉注释之后，只有 `bin/cairn` (232) 和 `snapshot.sh` (180) 还超过 100，`install.sh` 是 122，别的都在 100 以内；八个 shell 文件合起来 762 行 (232 + 96 + 9 + 27 + 66 + 83 + 69 + 180)。所以结论取决于你怎么数：按 `wc -l`，六个文件违规；按代码行，两个违规，加上 `install.sh` 三个。Google 的原文只说 “超过 100 行”，没有说怎么数，我偏向第一种：读的人读到的是全部的行。

### 什么时候该重写 Cairn

[选哪个 shell](https://google.github.io/styleguide/shellguide.html#s1.1-which-shell-to-use) 的下一条，[何时用 shell](https://google.github.io/styleguide/shellguide.html#s1.2-when-to-use-shell)，给了四条判断：主要在调用别的工具、很少处理数据，shell 可以；性能重要，就用别的；超过 100 行或者控制流不直白，现在就该换一门更结构化的语言，“要记住脚本会长大，早重写比晚重写省事”；评估复杂度时要看代码是否容易被作者之外的人维护。最后还有一句，我引原文：“如果你想把一个现有的程序从 shell 迁移到一门正规语言，但不知道怎么做，请看 [Deshell Playbook](https://github.com/google/deshell/blob/main/playbook.md)。它会带你用一种稳健的办法平滑地替换生产代码。” 我读的是这份指南的原文，指南里就有这个链接。

把 Cairn 放在这四条下面：

- **主要在调用别的工具。** 对。`rsync`、`sha256sum`、`find`、`sort`、`xargs`、`flock`、`du`、`numfmt` 才是干活的，Cairn 在它们之间传参数和退出码。这是 shell 的主场。
- **性能。** 不在乎，“启动成本” 一节量过：每次启动多花的 6.7 ms 对这个工具无关紧要。
- **100 行或不直白的控制流。** 两个都中。1445 行是第一个；第二个是我这个系列公开承认的那些洞，几乎全是同一个形状：“进程在中间被打断，或者一步失败了，状态停在半截”。第 4 篇的 “一个我没有修的洞” 里 `cairn::prune::run` 吞掉了 `select` 的失败；第 5 篇的 “两个同样写法的洞：一个修了，一个没修” 里 `prune::remove` 对硬链接文件的 `chmod -R`；第 6 篇的 “FNR == NR 的一个洞” 里 `diff.awk` 对空的旧清单；第 7 篇的 “没有修的洞” 里 `manifest::write` 失败和信号落在改名之后，都会留下一份没有清单的快照，同一篇的 “会被继承的锁：一个孤儿 rsync” 里是 `SIGKILL` 之后孤儿 rsync 还握着锁；第 9 篇的 “一个没修的洞：~”；再加上这一篇没修的那一个（`SIGPIPE` 之后装到一半）。150 个测试盯着绝大多数行为，可这类洞是 “所有步骤的所有中断点” 的组合，而 shell 里能说 “无论怎么退出都要释放” 的只有手工的 `trap`。
- **别人能不能维护。** 这一条我没法替别人回答。我能说的是：47 行用了 `[[`，78 行用了 `local`，7 处进程替换，5 处 `mapfile`/`readarray`，2 处关联数组，32 行有 `((`：

  ```text
  $ cat bin/cairn lib/cairn/*.sh | grep -Ec '\[\['
  47
  $ cat bin/cairn lib/cairn/*.sh | grep -Ec '^[[:space:]]*local '
  78
  $ cat bin/cairn lib/cairn/*.sh | grep -Ec '<\('
  7
  $ cat bin/cairn lib/cairn/*.sh | grep -Ec 'mapfile|readarray'
  5
  $ cat bin/cairn lib/cairn/*.sh | grep -Ec 'declare -A|local -A'
  2
  $ cat bin/cairn lib/cairn/*.sh | grep -Ec '\(\('
  32
  ```

  这是 Cairn 靠着 bash 才成立的证据：把它改成 POSIX sh 不是一个改写，是一个重新设计。另外，`date -d`、`readlink -f`、`realpath -m`、`du --block-size`、`numfmt`、`flock`、`-print0` 这类 GNU 或 Linux 的写法也有 10 行：

  ```text
  $ cat bin/cairn lib/cairn/*.sh | grep -Ec 'date (-u )?-d|readlink -f|realpath -m|block-size|numfmt|flock|print0'
  10
  ```

  `flock` 和 `sha256sum` 都不在 POSIX 的 Utilities 索引里（我查了），所以即使把 bash 换掉，Cairn 也只能运行在有这些工具的系统上。我没有在 macOS 上试过。

我的判断：按 Google 的标准，Cairn 早就过线了；如果它只给我一个人用，在一台我熟悉的机器上，我大概不会重写它，我读得懂每一行，也知道每个洞在哪；如果它要交给别人，或者要在我不看着的时候替我保管备份，我会把核心（`snapshot`、`prune`、`manifest` 的逻辑）用一门有类型和析构的语言重写，留在 shell 里的是 `install.sh`（它必须在别的东西都不存在的时候运行）、`completions/cairn.bash`（补全是 bash 自己的机制）、systemd 单元和 bats 测试。我猜重写之后，最先消失的不是行数，是上面那类 “半截” 的洞。想走这条路的话，Rust 的版本从[用 Pebble 从零学 Rust 的第 1 篇](/posts/rust-by-pebble-01-first-crate/)开始，Python 的版本从[用 Sift 重学 Python 的第 1 篇](/posts/python-by-sift-01-first-search/)开始。

`install.sh` 自己有 236 行，违反了同一条规则，我在 “install.sh：一个只许用 POSIX 的文件” 里说过理由：它是例外本身，而且 236 行里有 84 行是注释。要重写它的话，“更结构化的语言” 恰恰是它没得选的东西：它必须在那门语言还没装上的时候就能跑。

## 十篇的索引

十篇里一共讲了多少 shell 特性，我没有数过，所以这一节是我把十篇各讲了什么逐条对了一遍：一条一条找它在哪篇的哪一节。下面的表里每一格的小节名，我都用脚本对照过那篇文章的标题表，确认它真的是一个标题（117 行），链接也带着这个标题的锚点，点进去直接落在那一节：

| 主题 | 在哪一篇，哪一节 |
| --- | --- |
| Cairn 的整体结构，十篇的路线图 | [第 1 篇 “Cairn 长什么样”](/posts/shell-by-cairn-01-first-script/#cairn-长什么样) |
| 这个系列怎么读 | [第 1 篇 “这个系列怎么读”](/posts/shell-by-cairn-01-first-script/#这个系列怎么读) |
| `#!` 与内核 | [第 1 篇 “内核怎么读 #!”](/posts/shell-by-cairn-01-first-script/#内核怎么读-) |
| `env bash`，NixOS 的 `bad interpreter` | [第 1 篇 “在 NixOS 上，Google 的 shebang 会失败”](/posts/shell-by-cairn-01-first-script/#在-nixos-上google-的-shebang-会失败) |
| `bash file`、`./file`、`source file`；`cd` 为什么必须是内建 | [第 1 篇 “三种运行脚本的方式”](/posts/shell-by-cairn-01-first-script/#三种运行脚本的方式) |
| `PATH`、`hash`、内建与外部命令 | [第 1 篇 “找到程序：PATH、hash、内建与外部”](/posts/shell-by-cairn-01-first-script/#找到程序pathhash内建与外部) |
| fork 与 exec (`strace`) | [第 1 篇 “看一次 fork 和 exec”](/posts/shell-by-cairn-01-first-script/#看一次-fork-和-exec) |
| 退出码 126、127、128+n | [第 1 篇 “退出码”](/posts/shell-by-cairn-01-first-script/#退出码) |
| shell 的历史 | [第 1 篇 “一段简短的历史：回到 1971 年”](/posts/shell-by-cairn-01-first-script/#一段简短的历史回到-1971-年) |
| shell 是什么：一个只会 fork 和 exec 的 REPL | [第 1 篇 “shell 是什么：一个只会 fork 和 exec 的 REPL”](/posts/shell-by-cairn-01-first-script/#shell-是什么一个只会-fork-和-exec-的-repl) |
| `scripts/chapter.sh` | [第 1 篇 “scripts/chapter.sh：第一个真正的脚本”](/posts/shell-by-cairn-01-first-script/#scriptschaptersh第一个真正的脚本) |
| Google 规则第一批 | [第 1 篇 “Google 规则，第一批，以及两个工具”](/posts/shell-by-cairn-01-first-script/#google-规则第一批以及两个工具) |
| 展开的顺序 | [第 2 篇 “展开的顺序”](/posts/shell-by-cairn-02-expansion-and-quoting/#展开的顺序) |
| `set -x`、`printf` 探针 | [第 2 篇 “两件工具：探针和显微镜”](/posts/shell-by-cairn-02-expansion-and-quoting/#两件工具探针和显微镜) |
| 四种引用 | [第 2 篇 “引用：四种写法”](/posts/shell-by-cairn-02-expansion-and-quoting/#引用四种写法) |
| 分词与 `IFS` | [第 2 篇 “分词与 IFS”](/posts/shell-by-cairn-02-expansion-and-quoting/#分词与-ifs) |
| `"$@"` | [第 2 篇 “`"$@"` 为什么一个字符都不能少”](/posts/shell-by-cairn-02-expansion-and-quoting/#-为什么一个字符都不能少) |
| 通配符与 `shopt` | [第 2 篇 “引用不到的地方：通配符”](/posts/shell-by-cairn-02-expansion-and-quoting/#引用不到的地方通配符) |
| `--` 与 `./*` | [第 2 篇 “名字以 - 开头”](/posts/shell-by-cairn-02-expansion-and-quoting/#名字以---开头) |
| 数组当作安全的 argv | [第 2 篇 “数组：保存 argv 的正确容器”](/posts/shell-by-cairn-02-expansion-and-quoting/#数组保存-argv-的正确容器) |
| Steam、Bumblebee 事故，SC2086 | [第 2 篇 “两起事故”](/posts/shell-by-cairn-02-expansion-and-quoting/#两起事故) |
| `"${var}"` 与引用规则 | [第 2 篇 “Google 的引用规则，以及为什么是 `"${var}"`”](/posts/shell-by-cairn-02-expansion-and-quoting/#google-的引用规则以及为什么是-var) |
| 一切都是字符串 | [第 3 篇 “一切都是字符串”](/posts/shell-by-cairn-03-variables-and-parameters/#一切都是字符串) |
| shell 变量与环境变量 | [第 3 篇 “两种变量：shell 变量和环境变量”](/posts/shell-by-cairn-03-variables-and-parameters/#两种变量shell-变量和环境变量) |
| 动态作用域 | [第 3 篇 “动态作用域：函数看得见调用者的 local”](/posts/shell-by-cairn-03-variables-and-parameters/#动态作用域函数看得见调用者的-local) |
| `declare` 的属性 | [第 3 篇 “declare：给字符串加上行为”](/posts/shell-by-cairn-03-variables-and-parameters/#declare给字符串加上行为) |
| 参数展开的所有运算符 | [第 3 篇 “参数展开：${...} 里的运算符”](/posts/shell-by-cairn-03-variables-and-parameters/#参数展开-里的运算符) |
| 索引数组与关联数组 | [第 3 篇 “数组：索引的和关联的”](/posts/shell-by-cairn-03-variables-and-parameters/#数组索引的和关联的) |
| `set -u` | [第 3 篇 “set -u：把拼写错误变成错误”](/posts/shell-by-cairn-03-variables-and-parameters/#set--u把拼写错误变成错误) |
| `printf -v`、`%q`、`@Q`、nameref | [第 3 篇 “把值写进变量：printf -v、%q、@Q 与 nameref”](/posts/shell-by-cairn-03-variables-and-parameters/#把值写进变量printf--vqq-与-nameref) |
| `IFS= read -r` 读配置 | [第 3 篇 “读配置：IFS= read -r”](/posts/shell-by-cairn-03-variables-and-parameters/#读配置ifs-read--r) |
| 配置为什么解析而不是 `source` | [第 3 篇 “为什么配置是解析的，不是 source 的”](/posts/shell-by-cairn-03-variables-and-parameters/#为什么配置是解析的不是-source-的) |
| 选项与配置的优先级 | [第 3 篇 “选项和优先级”](/posts/shell-by-cairn-03-variables-and-parameters/#选项和优先级) |
| Google 的命名、`readonly`、`local`、声明与赋值分开写的规矩；内建优于外部进程 | [第 3 篇 “Google 的几条规矩，和一个 462 倍”](/posts/shell-by-cairn-03-variables-and-parameters/#google-的几条规矩和一个-462-倍) |
| 退出状态是唯一的布尔值 | [第 4 篇 “if 后面跟的是命令”](/posts/shell-by-cairn-04-control-flow-and-functions/#if-后面跟的是命令) |
| `test`、`[`、`[[`、`(( ))` | [第 4 篇 “test、`[` 和 `[[`”](/posts/shell-by-cairn-04-control-flow-and-functions/#test-和-) |
| `=~` 与 `BASH_REMATCH` | [第 4 篇 “正则：`=~` 和 `BASH_REMATCH`”](/posts/shell-by-cairn-04-control-flow-and-functions/#正则-和-bash_rematch) |
| `case` | [第 4 篇 “case：模式是 glob，不是正则”](/posts/shell-by-cairn-04-control-flow-and-functions/#case模式是-glob不是正则) |
| `for`、`while`、`until`、`select` | [第 4 篇 “四种循环”](/posts/shell-by-cairn-04-control-flow-and-functions/#四种循环) |
| 逐行读文件 | [第 4 篇 “逐行读文件”](/posts/shell-by-cairn-04-control-flow-and-functions/#逐行读文件) |
| 管道进 `while` 的子 shell 陷阱 | [第 4 篇 “管道进 while：子 shell 陷阱”](/posts/shell-by-cairn-04-control-flow-and-functions/#管道进-while子-shell-陷阱) |
| 函数的参数与返回 | [第 4 篇 “函数：参数、`local` 和两条返回通道”](/posts/shell-by-cairn-04-control-flow-and-functions/#函数参数local-和两条返回通道) |
| 函数名里的 `::` | [第 4 篇 “函数名里的 `::`”](/posts/shell-by-cairn-04-control-flow-and-functions/#函数名里的-) |
| 算术 | [第 4 篇 “算术：整数，64 位，到此为止”](/posts/shell-by-cairn-04-control-flow-and-functions/#算术整数64-位到此为止) |
| `date`、`printf %(...)T` | [第 4 篇 “日期：`date`、`%G` 和 `printf '%(...)T'`”](/posts/shell-by-cairn-04-control-flow-and-functions/#日期dateg-和-printf-t) |
| `getopts` 与手写选项循环 | [第 4 篇 “getopts 和手写选项循环”](/posts/shell-by-cairn-04-control-flow-and-functions/#getopts-和手写选项循环) |
| `prune` 的保留算法 | [第 4 篇 “保留策略：写一个算法”](/posts/shell-by-cairn-04-control-flow-and-functions/#保留策略写一个算法) |
| Google 的控制流与 `case` 写法 | [第 4 篇 “Google 的几条规矩”](/posts/shell-by-cairn-04-control-flow-and-functions/#google-的几条规矩) |
| 文件描述符与继承 | [第 5 篇 “文件描述符：一张进程里的小表”](/posts/shell-by-cairn-05-redirection-pipes-processes/#文件描述符一张进程里的小表) |
| 重定向的顺序与 `dup2` | [第 5 篇 “重定向：从左到右，一次一个 dup2”](/posts/shell-by-cairn-05-redirection-pipes-processes/#重定向从左到右一次一个-dup2) |
| here-document 与 here-string | [第 5 篇 “here-document 和 here-string”](/posts/shell-by-cairn-05-redirection-pipes-processes/#here-document-和-here-string) |
| 进程替换 | [第 5 篇 “进程替换：把命令的输出当成文件名”](/posts/shell-by-cairn-05-redirection-pipes-processes/#进程替换把命令的输出当成文件名) |
| 管道是并发的进程 | [第 5 篇 “管道里的每一段都是一个进程”](/posts/shell-by-cairn-05-redirection-pipes-processes/#管道里的每一段都是一个进程) |
| `SIGPIPE` | [第 5 篇 “SIGPIPE”](/posts/shell-by-cairn-05-redirection-pipes-processes/#sigpipe) |
| `PIPESTATUS` 与 `pipefail` | [第 5 篇 “`$?`、`PIPESTATUS` 和 `pipefail`”](/posts/shell-by-cairn-05-redirection-pipes-processes/#pipestatus-和-pipefail) |
| 子 shell 与花括号组 | [第 5 篇 “子 shell 和花括号组”](/posts/shell-by-cairn-05-redirection-pipes-processes/#子-shell-和花括号组) |
| `&`、`wait`、`$!` | [第 5 篇 “`&`、`wait` 和 `$!`”](/posts/shell-by-cairn-05-redirection-pipes-processes/#wait-和-) |
| `-print0`、`sort -z`、`xargs -0 -P` | [第 5 篇 “NUL 分隔：`find -print0`、`sort -z`、`xargs -0 -P`”](/posts/shell-by-cairn-05-redirection-pipes-processes/#nul-分隔find--print0sort--zxargs--0--p) |
| 硬链接、inode 与 `--link-dest` | [第 5 篇 “硬链接和 inode”](/posts/shell-by-cairn-05-redirection-pipes-processes/#硬链接和-inode) |
| 原子改名 | [第 5 篇 “原子改名”](/posts/shell-by-cairn-05-redirection-pipes-processes/#原子改名) |
| Google 的管道写法与 `PIPESTATUS` 规矩 | [第 5 篇 “Google 的几条规矩”](/posts/shell-by-cairn-05-redirection-pipes-processes/#google-的几条规矩) |
| `echo` 与 `printf` | [第 6 篇 “echo 还是 printf”](/posts/shell-by-cairn-06-text-processing/#echo-还是-printf) |
| `cut`、`tr`、`paste`、`wc`、`head`、`tail` | [第 6 篇 “cut、tr、paste、wc、head、tail”](/posts/shell-by-cairn-06-text-processing/#cuttrpastewcheadtail) |
| `sort` 与 `uniq` | [第 6 篇 “sort 和 uniq”](/posts/shell-by-cairn-06-text-processing/#sort-和-uniq) |
| locale 与 `LC_ALL=C` | [第 6 篇 “locale：LC_ALL=C 到底在省什么”](/posts/shell-by-cairn-06-text-processing/#localelc_allc-到底在省什么) |
| `comm` 与 `join` | [第 6 篇 “comm 和 join”](/posts/shell-by-cairn-06-text-processing/#comm-和-join) |
| `sed` 与 `sed -i` 的 inode | [第 6 篇 “sed”](/posts/shell-by-cairn-06-text-processing/#sed) |
| `awk` | [第 6 篇 “awk 是一门小语言”](/posts/shell-by-cairn-06-text-processing/#awk-是一门小语言) |
| 按位置切，不按字段切 | [第 6 篇 “按位置切，不要按字段”](/posts/shell-by-cairn-06-text-processing/#按位置切不要按字段) |
| 内建循环与外部进程的取舍 | [第 6 篇 “内建，还是外部进程”](/posts/shell-by-cairn-06-text-processing/#内建还是外部进程) |
| `report.awk` 逐行 | [第 6 篇 “report.awk 逐行”](/posts/shell-by-cairn-06-text-processing/#reportawk-逐行) |
| `numfmt` | [第 6 篇 “numfmt”](/posts/shell-by-cairn-06-text-processing/#numfmt) |
| `diff.awk` 逐行 | [第 6 篇 “diff.awk 逐行”](/posts/shell-by-cairn-06-text-processing/#diffawk-逐行) |
| `grep` | [《我终于学会了 grep，然后换成了 ripgrep》](/posts/grep-ripgrep-search-guide/)，第 6 篇在 “sed” 一节里指向它 |
| `set -e` 及其例外、`inherit_errexit` | [第 7 篇 “set -e 能管什么”](/posts/shell-by-cairn-07-errors-traps-signals/#set--e-能管什么) |
| Google 的显式检查返回值规则，和 `set -e` 为什么仍然要开 | [第 7 篇 “那为什么还要开”](/posts/shell-by-cairn-07-errors-traps-signals/#那为什么还要开) |
| `pipefail` | [第 7 篇 “pipefail”](/posts/shell-by-cairn-07-errors-traps-signals/#pipefail) |
| `ERR` 陷阱与 `errtrace` | [第 7 篇 “ERR 陷阱”](/posts/shell-by-cairn-07-errors-traps-signals/#err-陷阱) |
| `EXIT` 陷阱与清理 | [第 7 篇 “EXIT 陷阱：清理放在一个地方”](/posts/shell-by-cairn-07-errors-traps-signals/#exit-陷阱清理放在一个地方) |
| 信号、`kill -l`、128+n | [第 7 篇 “信号与退出码”](/posts/shell-by-cairn-07-errors-traps-signals/#信号与退出码) |
| trap 延迟与后台加 `wait` | [第 7 篇 “前台的 sleep 5：为什么 trap 晚到”](/posts/shell-by-cairn-07-errors-traps-signals/#前台的-sleep-5为什么-trap-晚到) |
| 杀掉子进程：可以被打断的 `snapshot::create` | [第 7 篇 “可以被打断的 snapshot::create”](/posts/shell-by-cairn-07-errors-traps-signals/#可以被打断的-snapshotcreate) |
| `mktemp` 与原子性 | [第 7 篇 “mktemp 和原子改名”](/posts/shell-by-cairn-07-errors-traps-signals/#mktemp-和原子改名) |
| `flock` 与文件描述符的继承 | [第 7 篇 “锁：flock 与一个会被继承的文件描述符”](/posts/shell-by-cairn-07-errors-traps-signals/#锁flock-与一个会被继承的文件描述符) |
| `SIGKILL` 与陈旧的 partial | [第 7 篇 “SIGKILL 与陈旧的 partial”](/posts/shell-by-cairn-07-errors-traps-signals/#sigkill-与陈旧的-partial) |
| bats | [第 8 篇 “bats 做了什么”](/posts/shell-by-cairn-08-testing-and-tooling/#bats-做了什么) |
| 每个测试自己的目录和环境 | [第 8 篇 “每个测试自己的目录和环境”](/posts/shell-by-cairn-08-testing-and-tooling/#每个测试自己的目录和环境) |
| 测试库 | [第 8 篇 “把库当库来测”](/posts/shell-by-cairn-08-testing-and-tooling/#把库当库来测) |
| 注入时间与环境变量 | [第 8 篇 “时间、环境变量和假的 rsync”](/posts/shell-by-cairn-08-testing-and-tooling/#时间环境变量和假的-rsync) |
| 测试信号与锁 | [第 8 篇 “锁和信号”](/posts/shell-by-cairn-08-testing-and-tooling/#锁和信号) |
| `bats --jobs` | [第 8 篇 “并行：`--jobs`”](/posts/shell-by-cairn-08-testing-and-tooling/#并行--jobs) |
| ShellCheck | [第 8 篇 “ShellCheck”](/posts/shell-by-cairn-08-testing-and-tooling/#shellcheck) |
| shfmt | [第 8 篇 “shfmt”](/posts/shell-by-cairn-08-testing-and-tooling/#shfmt) |
| `bash -n`、`bash -x`、`PS4` | [第 8 篇 “bash -n、bash -x 与 PS4”](/posts/shell-by-cairn-08-testing-and-tooling/#bash--nbash--x-与-ps4) |
| kcov 覆盖率 | [第 8 篇 “覆盖率：kcov”](/posts/shell-by-cairn-08-testing-and-tooling/#覆盖率kcov) |
| CI 工作流 | [第 8 篇 “CI”](/posts/shell-by-cairn-08-testing-and-tooling/#ci) |
| systemd 用户定时器 | [第 8 篇 “定时运行：systemd 用户定时器”](/posts/shell-by-cairn-08-testing-and-tooling/#定时运行systemd-用户定时器) |
| 登录与交互式的启动文件 | [第 9 篇 “启动文件：谁读哪一个”](/posts/shell-by-cairn-09-interactive-shell/#启动文件谁读哪一个) |
| `.bash_profile` 里 `source .bashrc` | [第 9 篇 “.bash_profile 里 source .bashrc”](/posts/shell-by-cairn-09-interactive-shell/#bash_profile-里-source-bashrc) |
| NixOS 的 `/etc/profile` | [第 9 篇 “NixOS 在 /etc 里放了什么”](/posts/shell-by-cairn-09-interactive-shell/#nixos-在-etc-里放了什么) |
| `$-` | [第 9 篇 “我是交互式的吗：`$-`”](/posts/shell-by-cairn-09-interactive-shell/#我是交互式的吗-) |
| 别名与脚本 | [第 9 篇 “别名：交互式的便利，脚本里的陷阱”](/posts/shell-by-cairn-09-interactive-shell/#别名交互式的便利脚本里的陷阱) |
| `PS1`、`PS0`、`PS4`、`PROMPT_COMMAND` | [第 9 篇 “提示符：PS1、PS0、PS4 与 PROMPT_COMMAND”](/posts/shell-by-cairn-09-interactive-shell/#提示符ps1ps0ps4-与-prompt_command) |
| 历史变量 | [第 9 篇 “历史：HISTFILE、HISTCONTROL 与 histappend”](/posts/shell-by-cairn-09-interactive-shell/#历史histfilehistcontrol-与-histappend) |
| readline 与 `~/.inputrc` | [第 9 篇 “readline 与 ~/.inputrc”](/posts/shell-by-cairn-09-interactive-shell/#readline-与-inputrc) |
| 作业控制与进程组 | [第 9 篇 “作业控制与进程组”](/posts/shell-by-cairn-09-interactive-shell/#作业控制与进程组) |
| `complete`、`compgen`、`COMPREPLY` | [第 9 篇 “补全：complete、compgen 与 COMPREPLY”](/posts/shell-by-cairn-09-interactive-shell/#补全completecompgen-与-compreply) |
| bash-completion 的按需加载 | [第 9 篇 “bash-completion 与按需加载”](/posts/shell-by-cairn-09-interactive-shell/#bash-completion-与按需加载) |
| POSIX 规定了什么 (Shell Command Language) | [第 10 篇 “POSIX 到底规定了什么”](/posts/shell-by-cairn-10-posix-sh/#posix-到底规定了什么) |
| `/bin/sh` 指向谁 (NixOS, Debian)，bashism 为什么 “碰巧能跑” | [第 10 篇 “/bin/sh 是谁”](/posts/shell-by-cairn-10-posix-sh/#binsh-是谁) |
| `bash --posix` | [第 10 篇 “bash --posix 改了什么，没改什么”](/posts/shell-by-cairn-10-posix-sh/#bash---posix-改了什么没改什么) |
| bashism 目录、`checkbashisms`、`shellcheck -s sh` | [第 10 篇 “bashism 目录”](/posts/shell-by-cairn-10-posix-sh/#bashism-目录) |
| `local` 不是 POSIX；子 shell 函数 | [第 10 篇 “local 不是 POSIX”](/posts/shell-by-cairn-10-posix-sh/#local-不是-posix) |
| `echo` 与 `printf` 在五个 shell 里的差别 | [第 10 篇 “echo 还是 printf”](/posts/shell-by-cairn-10-posix-sh/#echo-还是-printf) |
| `set --` 当数组 | [第 10 篇 “set --：唯一的数组”](/posts/shell-by-cairn-10-posix-sh/#set---唯一的数组) |
| POSIX sh 的安装脚本、`DESTDIR`、Google 的 “只有被强迫才用 POSIX” 例外 | [第 10 篇 “install.sh：一个只许用 POSIX 的文件”](/posts/shell-by-cairn-10-posix-sh/#installsh一个只许用-posix-的文件) |
| 启动成本 | [第 10 篇 “启动成本”](/posts/shell-by-cairn-10-posix-sh/#启动成本) |
| 100 行规则与重写的判断 | [第 10 篇 “Google 的 100 行规则，和 Cairn 的 1445 行”](/posts/shell-by-cairn-10-posix-sh/#google-的-100-行规则和-cairn-的-1445-行) |

## 检查点

先把参考仓库更新到带 `ch10` 标签的状态：

```bash
git -C ~/cairn-ref fetch --tags
```

在 `~/cairn` 下：

```bash
make ch10
make test
make -s lint
```

`make ch10` 应当打印这 12 行，整套大约 3 秒：

```text
$ make ch10
bash scripts/chapter.sh ch10
ok   lab/ch10/bashisms_fail.sh
ok   lab/ch10/bin_sh_is.sh
ok   lab/ch10/checkbashisms_demo.sh
ok   lab/ch10/echo_portability.sh
ok   lab/ch10/ex_posix_basename.sh
ok   lab/ch10/install_matrix.sh
ok   lab/ch10/line_counts.sh
ok   lab/ch10/posix_idioms.sh
ok   lab/ch10/posix_mode.sh
ok   lab/ch10/shellcheck_sh.sh
ok   lab/ch10/startup_cost.sh
```

（开头一行加上 11 个实验，一共 12 行。`bashisms_fail.sh` 是 `_fail` 实验，它按设计以退出码 1 结束，运行器因此打印 `ok`；另外 10 个的退出码是 0。这一章没有宿主机专用的实验，所以 `CI=true` 时输出也一样。）`make test` 应当打印 `1..150`，然后 150 行 `ok`，没有 `not ok`，比 `ch09` 多的 35 个都在 `tests/install.bats` 里。`make -s lint` 什么都不输出，退出码 0。我在这台机器上跑 `make ci`（`lint`、所有章节、`test`，`CI=true`，所以三个宿主机实验 `skip`）共 3 分 57 秒，116 个实验 `ok`、3 个 `skip`，150 个测试 `ok`。

**必须和标签一致的文件：** 这是最后一篇，没有后面的章节会再改任何文件，所以这一章新增或修改的 16 个都是终版：`install.sh`、`Makefile`、`README.md`、`tests/install.bats`，以及 `lab/ch10/` 下的 11 个脚本和 1 个夹具。每个都用 `diff` 对照：

```text
$ for f in install.sh Makefile README.md tests/install.bats lab/ch10/*.sh lab/ch10/fixtures/*; do
  if diff <(git -C ~/cairn-ref show ch10:"${f}") "${f}" >/dev/null; then
    printf 'same %s\n' "${f}"
  else
    printf 'DIFF %s\n' "${f}"
  fi
done | cut -d' ' -f1 | sort | uniq -c
     16 same
```

应当打印 `16 same`（我在一个只含 `ch09` 内容、再按 “动手清单” 的命令复制过来的 `~/cairn` 里跑的，没有一行是 `DIFF`）。`diff` 不比较权限位，标签里有可执行位的文件现在是五个，比第 9 篇多了 `install.sh`。仓库现在有 160 个被跟踪的文件，和上一个标签相比 14 个新增、2 个修改：

```text
$ git diff --stat ch09 ch10 | tail -n 1
 16 files changed, 915 insertions(+), 2 deletions(-)
$ git diff --name-status ch09 ch10 | cut -c1 | sort | uniq -c
     14 A
      2 M
$ git ls-files | wc -l
160
$ git ls-files -s | awk '$1 == "100755" { print $4 }'
bin/cairn
install.sh
lab/ch01/shebang_exec.sh
scripts/chapter.sh
scripts/make_tree.sh
```

**中间版本（后面的章节会继续改）：** 没有。`Makefile` 和 `README.md` 在前九篇里一直是 “以后还会变” 的中间版本，这一篇之后它们也定了。

### 文件清单

这一篇新增或修改的 16 个文件 (`git diff --name-only ch09 ch10`) 都在这里，其中 14 个是新增，链接指向标签 `ch10` 上的那一份。实验需要沙箱目录和 `CAIRN_ROOT`，所以命令都是 `make ch10`。结果列是我在 Bash 5.3.15 下实际跑出来的；计时每次会不同。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`Makefile`](https://github.com/bfmhno3/cairn/blob/ch10/Makefile) | `make -n install` | 33 行；打印 `./install.sh --prefix "/home/bfmhno3/.local"` |
| [`README.md`](https://github.com/bfmhno3/cairn/blob/ch10/README.md) | `-` | 125 行，多了 “Install” 一节 |
| [`install.sh`](https://github.com/bfmhno3/cairn/blob/ch10/install.sh) | `dash install.sh --prefix DIR` | 236 行；退出码 0，13 行 `installed`；加 `--uninstall` 打印 13 行 `removed` |
| [`lab/ch10/bashisms_fail.sh`](https://github.com/bfmhno3/cairn/blob/ch10/lab/ch10/bashisms_fail.sh) | `make ch10` | 退出码 1（按设计，`_fail` 实验）；最后一行 `8 of 9 constructs break under dash` |
| [`lab/ch10/bin_sh_is.sh`](https://github.com/bfmhno3/cairn/blob/ch10/lab/ch10/bin_sh_is.sh) | `make ch10` | 退出码 0；`readlink -f /bin/sh` 指向 `bash-interactive-5.3p9/bin/bash` |
| [`lab/ch10/checkbashisms_demo.sh`](https://github.com/bfmhno3/cairn/blob/ch10/lab/ch10/checkbashisms_demo.sh) | `make ch10` | 退出码 0；stderr 20 行（10 条发现），stdout `checkbashisms exit status: 1` |
| [`lab/ch10/echo_portability.sh`](https://github.com/bfmhno3/cairn/blob/ch10/lab/ch10/echo_portability.sh) | `make ch10` | 退出码 0；输出 6 行，yash 的 `echo -n x` 打印 `-n x` |
| [`lab/ch10/ex_posix_basename.sh`](https://github.com/bfmhno3/cairn/blob/ch10/lab/ch10/ex_posix_basename.sh) | `make ch10` | 退出码 0；练习 1，9 行 `ok` |
| [`lab/ch10/fixtures/bashisms.txt`](https://github.com/bfmhno3/cairn/blob/ch10/lab/ch10/fixtures/bashisms.txt) | `-` | 12 行，被 `bashisms_fail.sh`、`checkbashisms_demo.sh`、`shellcheck_sh.sh` 读取 |
| [`lab/ch10/install_matrix.sh`](https://github.com/bfmhno3/cairn/blob/ch10/lab/ch10/install_matrix.sh) | `make ch10` | 退出码 0；5 行 `ok` (dash, busybox, yash, mksh, `bash --posix`) |
| [`lab/ch10/line_counts.sh`](https://github.com/bfmhno3/cairn/blob/ch10/lab/ch10/line_counts.sh) | `make ch10` | 退出码 0；11 行，最后一行 `1445 total` |
| [`lab/ch10/posix_idioms.sh`](https://github.com/bfmhno3/cairn/blob/ch10/lab/ch10/posix_idioms.sh) | `make ch10` | 退出码 0；输出 15 行，第一行 `dash -n: ok` |
| [`lab/ch10/posix_mode.sh`](https://github.com/bfmhno3/cairn/blob/ch10/lab/ch10/posix_mode.sh) | `make ch10` | 退出码 0；输出 20 行，5 组对比 |
| [`lab/ch10/shellcheck_sh.sh`](https://github.com/bfmhno3/cairn/blob/ch10/lab/ch10/shellcheck_sh.sh) | `make ch10` | 退出码 0；14 行（13 条发现加一行状态） |
| [`lab/ch10/startup_cost.sh`](https://github.com/bfmhno3/cairn/blob/ch10/lab/ch10/startup_cost.sh) | `make ch10` | 退出码 0；6 行，dash 1.26 ms，bash 3.01 ms，2.4x |
| [`tests/install.bats`](https://github.com/bfmhno3/cairn/blob/ch10/tests/install.bats) | `bats tests/install.bats` | 358 行；35 个 `ok` |

## 练习

**1.** 写一个函数 `posix_basename PATH [SUFFIX]`，只用参数展开和内建，不调用 `basename`，在 bash 和 dash 里的结果都和真的 `basename` 一致。注意末尾的斜杠、全是斜杠的路径，以及 “`.txt` 去掉后缀 `.txt`” 这个特殊情况。

<details>
<summary>参考答案</summary>

我的答案是 [`lab/ch10/ex_posix_basename.sh`](https://github.com/bfmhno3/cairn/blob/ch10/lab/ch10/ex_posix_basename.sh)。函数是这样（POSIX sh，没有 `local`，所以函数体是子 shell）：

```sh
posix_basename() (
  p="$1"
  suffix="${2:-}"
  [ -n "${p}" ] || exit 0
  while [ "${p}" != "${p%/}" ]; do
    p="${p%/}"
  done
  if [ -z "${p}" ]; then
    printf '/\n'
    exit 0
  fi
  p="${p##*/}"
  if [ -n "${suffix}" ] && [ "${p}" != "${suffix}" ]; then
    p="${p%"${suffix}"}"
  fi
  printf '%s\n' "${p}"
)
```

三个要点。先用 `while [ "${p}" != "${p%/}" ]` 把末尾的斜杠一个个去掉，剩下空串说明原来全是斜杠，答案是 `/`。再用 `${p##*/}` 取最后一段。最后去后缀：`"${p%"${suffix}"}"` 里面那层引号让后缀按字面匹配（否则 `.` 或 `*` 会被当成模式），并且只在 `p` 不等于后缀时才去，这是 `basename .txt .txt` 打印 `.txt` 的原因。实验把九个用例交给 bash 和 dash，和真的 `basename` 比较，不一致就退出码 1。用例是 `路径|后缀`，一行一个，写在脚本末尾的 here-document 里：

```text
/usr/bin/cairn|
cairn|
dir/file.txt|.txt
dir/file.txt|.sh
/a/b///|
/|
//|
.txt|.txt
a b/c d|
```

输出只打印路径和结果，不打印后缀，所以第三、四行看起来一样：它们的区别在上面的后缀，`.txt` 被去掉，`.sh` 不匹配所以保持 `file.txt`：

```text
ok   /usr/bin/cairn       -> cairn
ok   cairn                -> cairn
ok   dir/file.txt         -> file
ok   dir/file.txt         -> file.txt
ok   /a/b///              -> b
ok   /                    -> /
ok   //                   -> /
ok   .txt                 -> .txt
ok   a\ b/c\ d            -> c d
```

九行全是 `ok`。

</details>

**2.** 下面这个 bash 函数数一数参数里有几个 `.txt` 文件，请把它改成 dash 能跑的版本，输出相同：

```bash
#!/usr/bin/env bash
count_txt() {
  local files=("$@") count=0 f
  for f in "${files[@]}"; do
    [[ "${f}" == *.txt ]] && count=$((count + 1))
  done
  echo "${count} of ${#files[@]}"
}
count_txt a.txt "b c.txt" d.log
```

<details>
<summary>参考答案</summary>

数组换成函数自己的 `"$@"`，`[[ ... == glob ]]` 换成 `case`，`local` 换成子 shell 函数（函数体用圆括号）。因为参数列表本来就是 “数组”，连那一步复制都省了：

```sh
#!/bin/sh
count_txt() (
  count=0
  total=$#
  for f in "$@"; do
    case "${f}" in
      *.txt) count=$((count + 1)) ;;
    esac
  done
  echo "${count} of ${total}"
)
count_txt a.txt "b c.txt" d.log
```

我在 bash 里跑第一个版本，在 dash、mksh、yash、BusyBox 里跑第二个版本；两个版本各自通过对应方言的 ShellCheck 和 shfmt，第二个版本还通过 checkbashisms；第一个版本交给 dash 则是语法错误：

```text
$ shellcheck ex2_bash.sh && shfmt -i 2 -bn -ci -d ex2_bash.sh && echo clean
clean
$ shellcheck -s sh ex2_sh.sh && shfmt -i 2 -bn -ci -d ex2_sh.sh \
    && checkbashisms ex2_sh.sh && echo clean
clean
$ bash ex2_bash.sh
2 of 3
$ for s in dash mksh yash "${CAIRN_BUSYBOX} sh"; do ${s} ex2_sh.sh; done
2 of 3
2 of 3
2 of 3
2 of 3
$ dash ex2_bash.sh
ex2_bash.sh: 3: Syntax error: "(" unexpected (expecting "}")
```

</details>

**3.** `--uninstall` 现在会删掉安装之前就存在的空目录，这是 “两个修好的洞，一个没修的洞” 一节里我选的取舍。请换另一个取舍：只删除 `install.sh` 自己创建的目录，不改变其余行为，`usage` 的文字一起改。

<details>
<summary>参考答案</summary>

只靠卸载时的现状没法知道哪些目录是谁建的，所以安装时必须记下来。办法是一份回执：安装前列出 `CREATED_DIRS` 里还不存在的目录，装完把这份列表写到 `share/cairn/created-dirs`；卸载时读回执，先删回执，再按里面的顺序（先深后浅）`rmdir`；已经有回执就不再重写，免得第二次安装把第一次的记录盖掉。我写了一个草稿（`install_receipt.sh`，不在仓库里），和 `install.sh` 的差别是（`usage` 里 `--uninstall` 的说明文字也得跟着改，这里省略）：

```text
$ diff -u install.sh install_receipt.sh
--- install.sh
+++ install_receipt.sh
@@ -132,13 +130,29 @@
 )
 
 #######################################
-# Remove the directories install uses, but only the empty ones, whoever
-# created them.
+# Print the directories of CREATED_DIRS that do not exist yet.
 # Globals:
 #   ROOT, CREATED_DIRS
 #######################################
-remove_empty_dirs() (
+list_new_dirs() (
   for d in ${CREATED_DIRS}; do
+    [ -d "${ROOT}/${d}" ] || printf '%s\n' "${d}"
+  done
+)
+
+#######################################
+# Remove the directories the first install created, if they are empty.
+# The receipt lists them, deepest first. It is removed before the rmdirs
+# because it lives in one of the directories.
+# Globals:
+#   ROOT
+#######################################
+remove_empty_dirs() (
+  receipt="${ROOT}/share/cairn/created-dirs"
+  [ -f "${receipt}" ] || exit 0
+  dirs="$(cat -- "${receipt}")"
+  rm -f -- "${receipt}"
+  for d in ${dirs}; do
     rmdir -- "${ROOT}/${d}" 2>/dev/null || :
   done
 )
@@ -230,7 +244,10 @@
     printf '%s\n' \
       'install.sh: warning: bash not found in PATH; cairn needs bash' >&2
   fi
+  new_dirs="$(list_new_dirs)"
   for_each_file "${src_dir}" install_file || return 1
+  receipt="${ROOT}/share/cairn/created-dirs"
+  [ -f "${receipt}" ] || printf '%s\n' "${new_dirs}" >"${receipt}"
 }
 
 main "$@"
```

在五个 shell 里验证两件事：先建一个空的 `bin`，装，再卸载，`bin` 还在（卸载后前缀目录里只剩这一项）；在一个全新的前缀里装两次再卸载，什么都不剩：

```text
dash         pre-existing bin: kept (1 entries left); fresh: 0 left
mksh         pre-existing bin: kept (1 entries left); fresh: 0 left
yash         pre-existing bin: kept (1 entries left); fresh: 0 left
busybox sh   pre-existing bin: kept (1 entries left); fresh: 0 left
bash --posix pre-existing bin: kept (1 entries left); fresh: 0 left
```

shellcheck `-s sh`、shfmt 和 checkbashisms 对它都是静默的（我检查过）。代价是多了一个文件，卸载的行为也变了，所以现有的测试里会有四个失败：前三个断言 “一个文件一行 `installed`/`removed`” 和 “文件个数等于仓库里的文件个数”，第四个就是上一节加的、把旧行为钉住的那个。我把改过的 `install.sh` 放进一份 `ch10` 的副本里，在副本里跑 `bats`：

```text
$ bats tests/install.bats | grep -E '^(1\.\.|not ok)'
1..35
not ok 6 installed file set matches the repository
not ok 7 install prints one 'installed' line per file
not ok 16 uninstall prints one 'removed' line per file
not ok 29 --uninstall removes a pre-existing empty bin directory
```

要么给回执单独打印一行，要么把前三个测试的期望加 1；第四个要反过来，改成 “保留已经存在的空 `bin`”。另一个办法是干脆不删共享目录（`bin`、`lib`、`share` 以及两个 `bash-completion` 目录），只删 `lib/cairn`、`share/cairn` 和 `share/cairn/systemd`，那样不需要回执，代价是 “卸载后前缀里什么都不剩” 的测试要改，而且共享目录会一直留下来。我选了回执，因为它保持了 “只删自己建的” 这句话的字面意思。

</details>

**4.** 第 1 篇和这一篇用 `wc -l` 数行。请写一个命令，改成按 “代码行”（去掉注释行和空行）数，只列出 `bin/cairn` 和 `lib/cairn/*.sh` 里超过 100 行的文件。

<details>
<summary>参考答案</summary>

```text
$ for f in bin/cairn lib/cairn/*.sh; do
    n="$(grep -cvE '^[[:space:]]*(#|$)' "${f}")"
    if [ "${n}" -gt 100 ]; then printf '%5d  %s\n' "${n}" "${f}"; fi
  done
  232  bin/cairn
  180  lib/cairn/snapshot.sh
```

`grep -cvE '^[[:space:]]*(#|$)'` 数的是既不是注释行也不是空行的行：`-c` 数行，`-v` 取反。只有 `bin/cairn` 232 行和 `lib/cairn/snapshot.sh` 180 行超过 100，和 “Google 的 100 行规则，和 Cairn 的 1445 行” 一节按 `wc -l` 数出来的六个不一样，说明规则怎么数也是一个选择。

</details>

**5.** 把 `bin/cairn` 和 `lib/cairn/*.sh` 交给 `shellcheck -s sh` 和 `checkbashisms -f`，数一数各有多少条发现，并说出出现最多的五个编号分别是什么意思。你的结论是 “把 Cairn 本体改成 POSIX sh” 大约是一个多大的工程？

<details>
<summary>参考答案</summary>

```text
$ shellcheck -s sh -f gcc bin/cairn lib/cairn/*.sh > /tmp/sc.txt
$ wc -l < /tmp/sc.txt
297
$ grep -o 'SC[0-9]*' /tmp/sc.txt | sort | uniq -c | sort -rn | head -n 5
     78 SC3043
     46 SC3010
     30 SC3033
     27 SC3006
     19 SC3054
$ checkbashisms -f bin/cairn lib/cairn/*.sh 2>&1 | grep -c "possible bashism"
193
```

ShellCheck 297 条（`bin/cairn` 和 7 个库，全部是 `SC3xxx`），checkbashisms 193 条（它默认不检查以 `#!/usr/bin/env bash` 开头的 `bin/cairn`，所以要加 `-f` 强制）。前五名依次是 78 条 SC3043（`local`，和上面数出来的 78 行 `local` 恰好一致）、46 条 SC3010 (`[[ ]]`)、30 条 SC3033（函数名超出了 `[a-zA-Z_][a-zA-Z0-9_]*`：Cairn 里恰好有 30 个 `cairn::...` 函数定义，一个一条）、27 条 SC3006（独立的 `((..))`）、19 条 SC3054（数组引用）。

前五名加起来 200 条，占 297 条的三分之二多一点。这只是机械的数量，真正的工作量在别处：Cairn 有几个数组要靠 `set --` 和分隔符字符串去模拟（`CAIRN_SOURCES`、`CAIRN_EXCLUDES`、`exclude_args`），有关联数组，有 `<( )`，有 `flock`（POSIX 里没有）。我的结论：这不是改写，是重新设计；与其降级成 POSIX sh，不如让它留在 bash，把需要 POSIX 的部分（安装）单独写成 `install.sh`。

</details>

## 下一站

2017 年版的 POSIX Shell Command Language 里没有 `pipefail`，没有 `$'...'`，`case` 也没有 `;&`；2024 年版三样都有了，我数过出现次数。这个速度不快，但方向是清楚的：标准在慢慢吃掉一部分 bashism。`local` 现在还躺在第 2.9.1.4 节那张 “结果未指定” 的表里，可是在我试过的五个 shell 里它全都能用，只是 `local x` 不给初值时 dash 和别人不一样，这种 “大家都有，只是细节不同” 的东西，我猜是标准最爱收的。我愿意打赌它是下一个，也愿意认输；赌输了对 `install.sh` 没有影响，它里面一个 `local` 都没有。

十年后的某个周末，大概会有人在一台我没见过的机器上运行 `make install`，而那台机器的 `/bin/sh` 是我今天没听说过的某个东西。我对那一刻没有什么要求，只有一条：`install.sh` 在它上面也应当先警告我 `bash not found in PATH; cairn needs bash`，再打印那 13 行 `installed`。至于装上去的东西还要不要 bash，那是另一个下午的问题了。

