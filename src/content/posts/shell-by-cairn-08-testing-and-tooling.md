---
title: 测试与工程化：bats、ShellCheck、shfmt 与定时运行
commentId: "post:shell-by-cairn-08-testing-and-tooling"
published: "2026-11-01 22:00:00 +08:00"
description: "用 Cairn 从零学 Shell 第 8 篇：我在 Bash 5.3.15、Bats 1.14.0、ShellCheck 0.11.0、shfmt 3.13.1 和 kcov 43 上给 Cairn 写了 93 个测试、CI 工作流和 systemd 用户定时器；串行跑 22.3 s，bats --jobs 16 只要 6.1 s，kcov 量出 60.32% 的行覆盖率。"
category: Tutorial
tags:
  - Shell
  - Bash
  - Cairn
  - 测试
  - ShellCheck
  - CI
  - systemd
series: "用 Cairn 从零学 Shell"
seriesOrder: 8
draft: false
comment: true
slug: shell-by-cairn-08-testing-and-tooling
---

第 7 篇的结尾是全绿的：`make ch07` 的实验全部符合预期，`make lint` 一声不吭。可是在一个刚 `init`、还没有任何快照的仓库上运行 `cairn list`，`ch07` 标签会往 stderr 写一行报错，然后照常打印表头，退出码是 0。这一篇的全部内容就是怎样让这类事情在发生的当天被一台机器发现，而不是被我碰巧看到。下面是 `ch07` 标签的真实输出（`conf` 是沙箱里的配置文件，仓库刚用 `cairn init` 建好）：

```text
$ cairn -c "${conf}" list; echo "exit=$?"
/tmp/cairn-ch07/bin/../lib/cairn/repo.sh: line 121: dirs: unbound variable
NAME               FILES     SIZE
exit=0
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库（标签 `ch08`）有 134 个被跟踪的文件，比 `ch07` 多 22 个：新增 `tests/` 下的 7 个 `.bats` 文件和 `test_helper.bash`（八个文件共 1130 行，最终版本）、`.github/workflows/ci.yml`（16 行，最终版本）、`contrib/systemd/` 下的两个单元（`cairn.service` 7 行、`cairn.timer` 10 行，最终版本），以及 `lab/ch08/` 里的 7 个实验脚本和 4 个夹具（最终版本）；另有四个旧文件被修改：`Makefile`（22 行长到 28 行，第 10 篇还会加 `install`）、`README.md`（59 行变 63 行，以后还会加内容）、`lib/cairn/prune.sh`（多 1 行日志，最终版本）和 `lib/cairn/repo.sh`（改 1 行，最终版本）。`make ch08` 通过：7 个实验全部符合预期（其中 `shellcheck_demo_fail.sh` 和 `bash_n_fail.sh` 按约定以非 0 退出码结束，运行器认为这才是正确的）；`make test` 跑 93 个测试全部通过；`make ci` 在这台机器上整套 3 分 42 秒。
> 涉及的工具和特性：bats 的 `@test`、`run`、`$status`、`$output`、`${lines[@]}`、`setup`/`teardown`/`setup_file`、`skip`、`--jobs`，`bats-support`/`bats-assert`/`bats-file`，ShellCheck 的指令与常见编号，shfmt 的 `-i 2 -bn -ci`，`bash -n`、`bash -x`、`PS4` 与 `BASH_XTRACEFD`，kcov，GitHub Actions，systemd 用户定时器，以及 [Google Shell 风格指南](https://google.github.io/styleguide/shellguide.html)里的 [ShellCheck](https://google.github.io/styleguide/shellguide.html#s6.1-shellcheck)、[缩进](https://google.github.io/styleguide/shellguide.html#s5.1-indentation)、[管道](https://google.github.io/styleguide/shellguide.html#s5.3-pipelines)和 [case 语句](https://google.github.io/styleguide/shellguide.html#s5.5-case-statement)四条规则。
> 前置：[第 7 篇：出错时：set -e、trap 与信号](/posts/shell-by-cairn-07-errors-traps-signals/)。

这一篇的所有输出来自这台机器：Linux 6.18.59，Bash 5.3.15，Bats 1.14.0（连同它自带的 `bats-support`、`bats-assert`、`bats-file`），ShellCheck 0.11.0，shfmt 3.13.1，kcov 43，GNU parallel 20260722，rsync 3.4.4，systemd 260 (260.5)。硬件是 AMD Ryzen 7 PRO 6850U，`nproc` 是 16，30 GiB 内存。仓库在我这里放在 `~/Projects/cairn`，所以输出里的路径带着这个前缀，你的会是 `~/cairn`。这台机器的时区是 `-0800`（`systemd-analyze` 的输出里会看到 `PST`）。

## 动手清单

你自己的 `~/cairn` 从第 7 篇的状态出发，这一篇要做这几件事，每件在哪一节出现都会指出来：

- 新建 `tests/test_helper.bash` 和 7 个 `.bats` 文件。见“bats 做了什么”“每个测试自己的目录和环境”“退出码和错误消息”“把库当库来测”“时间、环境变量和假的 rsync”“锁和信号”六节。
- 改 `lib/cairn/repo.sh` 里的一行 (`local -a dirs=()`) 和 `lib/cairn/prune.sh` 里的一行（`prune` 删除快照时写日志）。见“第 7 篇留下的两个错”一节。
- 改 `Makefile`：加 `test`、`coverage`，`ci` 变成 `lint chapters test`，`.bats` 文件进入 lint。见“并行：`--jobs`”“ShellCheck”“覆盖率：kcov”三节。
- 新建 `.github/workflows/ci.yml`、`contrib/systemd/cairn.service` 和 `cairn.timer`。见“CI”和“定时运行：systemd 用户定时器”两节。
- 新建 `lab/ch08/` 下的 7 个实验和 4 个夹具，`make ch08` 全部跑一遍。

直接从参考仓库复制的话，写法和前几篇一样（新增的目录要先建出来）：

```bash
git -C ~/cairn-ref fetch --tags
cd ~/cairn || exit 1
mkdir -p tests lab/ch08/fixtures .github/workflows contrib/systemd
mapfile -t files < <(git -C ~/cairn-ref diff --name-only ch07 ch08)
for f in "${files[@]}"; do
  git -C ~/cairn-ref show ch08:"${f}" >"${f}"
done
```

测试的价值在于你亲手写一遍，所以我建议至少自己敲完 `tests/test_helper.bash` 和 `tests/prune.bats`，再对着标签 `diff`。

## 全貌

一个测试像棘轮上的一个齿：它不让程序变得更好，只保证程序不会退回到这个行为之前。Cairn 现在有 93 个齿，加上不运行代码就能检查的 `bash -n`、ShellCheck 和 shfmt，再加上每次推送都全跑一遍的 CI。下图是这一篇要走的顺序，从不运行代码的检查到每天自己运行的定时器：

```mermaid
flowchart LR
    static["bash -n、ShellCheck、shfmt<br/>不运行代码"] --> unit["bats：source 库，<br/>直接调用函数"]
    unit --> cli["bats：运行 bin/cairn，<br/>看退出码、stdout、stderr"]
    cli --> proc["bats：后台进程、<br/>信号、锁"]
    proc --> cov["kcov：量哪些行跑过"]
    cov --> ci["GitHub Actions：<br/>make ci"]
    ci --> timer["systemd 定时器：<br/>每天运行 cairn 本身"]
```

我先讲 bats 本身（它是这一篇里最小的一块，但是 93 个测试都建在它上面），然后是测试怎样隔离环境，再按“退出码和错误消息、库函数、时间和环境变量、信号和锁”四种被测对象逐个看，其中信号和锁那一组是最难写的。接着回到那个 `unbound variable`：看这套测试在 `ch07` 的代码上会怎么失败。最后是并行、静态检查工具、覆盖率、CI 和定时器。

## bats 做了什么

`.bats` 文件不是合法的 Bash：`@test "名字" {` 这一行 Bash 不认识。Bats 读它之前先过一遍预处理器，把每个 `@test` 改写成一个普通函数加一行注册语句。我拿一个两行的测试看它改写成什么（`bats-preprocess` 在 Bats 安装目录的 `libexec/bats-core/` 里，`${libexec}` 是我给它起的变量名）：

```text
$ cat mini.bats
@test "adds numbers" {
  run echo hi
  [ "$status" -eq 0 ]
}
$ bash "${libexec}/bats-preprocess" mini.bats
bats_test_function --description adds\ numbers  --tags "" --tags "" -- test_adds_numbers;test_adds_numbers() {
  run echo hi
  [ "$status" -eq 0 ]
}
```

所以一个测试就是一个函数，没有什么魔法。ShellCheck 和 shfmt 也认识这种语法：shfmt 有一个 `-ln bats` 方言（默认按扩展名自动选），ShellCheck 我直接对 `.bats` 文件跑过（下面的 `demo.bats` 退出码是 0）。这是第 8 篇可以把 `.bats` 文件放进 `make lint` 的前提，“ShellCheck”一节会回来。

怎样才算失败？函数里任何一条命令返回非 0，测试就在那一行停下：Bats 的 `bats-exec-test` 第 2 行是 `set -eET`，测试函数就在这样的 shell 里运行。下面是我写的一个小文件，把 `setup`、`teardown`、`run`、`skip` 和失败各演一遍（它不在仓库里，在 `/tmp/p8-scratch/` 里；`>&3` 是往终端打印，原因看[文档里的“文件描述符 3”](https://bats-core.readthedocs.io/en/stable/writing-tests.html#file-descriptor-3-read-this-if-bats-hangs)）：

```bash
bats_require_minimum_version 1.5.0

setup_file() {
  echo 'setup_file' >&3
}

setup() {
  echo 'setup' >&3
}

teardown() {
  echo 'teardown' >&3
}

@test "run keeps status, output and lines" {
  run bash -c 'echo out; echo err >&2; exit 3'
  echo "status=${status} output=${output//$'\n'/|}" >&3
  echo "lines=${#lines[@]}" >&3
  (( status == 3 ))
}

@test "run --separate-stderr and run -3" {
  run --separate-stderr bash -c 'echo out; echo err >&2'
  echo "output=${output} stderr=${stderr}" >&3
  run -3 bash -c 'exit 3'
}

@test "a failing command ends the test" {
  false
  echo 'never printed' >&3
}

@test "skip" {
  skip 'not today'
}
```

```text
$ bats demo.bats
1..4
setup_file
setup
status=3 output=out|err
lines=2
teardown
ok 1 run keeps status, output and lines
setup
output=out stderr=err
teardown
ok 2 run --separate-stderr and run -3
setup
teardown
not ok 3 a failing command ends the test
# (in test file demo.bats, line 29)
#   `false' failed
setup
teardown
ok 4 skip # skip not today
```

几件事要看清楚。`setup_file` 每个文件跑一次，`setup` 和 `teardown` 在每个测试前后各跑一次，`teardown` 在失败的测试后面也跑（第 3 个测试就是）。`run` 把命令放进子 shell 执行，把退出码存到 `$status`，把 stdout 和 stderr **合在一起**存到 `$output`，按行拆成数组 `${lines[@]}`；`run` 自己永远返回 0，所以后面的 `(( status == 3 ))` 才是断言。加上 `--separate-stderr` 之后 stderr 单独放进 `$stderr`，`run -3` 把“退出码必须是 3”写进了 `run` 里，这两个选项要 Bats 1.5.0 以上，不写 `bats_require_minimum_version 1.5.0` 的话 Bats 会打印一条 BW02 警告，大意是“给 `run` 加选项至少需要 BATS_VERSION=1.5.0”。

`${lines[@]}` 有个脾气：它不含空行。我拿一个中间带空行的输出验证：

```text
$ cat lines.bats
bats_require_minimum_version 1.5.0

@test "lines and blank lines" {
  run printf 'a\n\nb\n'
  echo "default: ${#lines[@]} lines, lines[1]=${lines[1]}" >&3
  run --keep-empty-lines printf 'a\n\nb\n'
  echo "keep-empty-lines: ${#lines[@]} lines, lines[1]=<${lines[1]}>" >&3
}
$ bats lines.bats
1..1
default: 2 lines, lines[1]=b
keep-empty-lines: 3 lines, lines[1]=<>
ok 1 lines and blank lines
```

原因在 Bats 的源码里（`lib/bats-core/test_functions.bash` 的 `bats_separate_lines`）：默认的拆分是 `IFS=$'\n' read -d '' -r -a`，换行在 `IFS` 里是空白字符，连续的几个会合并成一个分隔符，第 2 篇讲过的分词规则原样适用。要保留空行就给 `run` 加 `--keep-empty-lines`。Cairn 的 `report` 输出里有一个空行，所以 `tests/report.bats` 里有一条注释写着“表头是第 6 行而不是第 7 行”，后面“退出码和错误消息”一节会看到它。

只靠 `[ ... ]` 写断言，失败时 Bats 只告诉你哪一行失败，不告诉你值是什么。`bats-assert` 和 `bats-file`（还有它们依赖的 `bats-support`）解决这个问题。Cairn 的测试用到的是这几个：

- `assert_success`、`assert_failure N`：检查 `$status`；`assert_failure 4` 检查它恰好是 4。
- `assert_output 文本`：检查整个 `$output`；`--partial` 是包含，`--regexp` 是正则；`assert_output -` 从 stdin 读期望值（`report.bats` 用 here-document 写整张表）；`refute_output` 是反向。
- `assert_line -n 0 文本`：检查第 0 行；不带 `-n` 是“任何一行等于”。
- `assert_equal 实际 期望`、`assert_regex 值 正则`：通用比较。
- `assert_file_exist`、`assert_dir_exist`、`assert_not_exist`：来自 `bats-file`。

它们失败时会把期望值和实际值并排打出来，后面“第 7 篇留下的两个错”一节有一份真实的。这些库怎么被找到？`tests/test_helper.bash` 里用 `bats_load_library bats-support` 这样的写法，[文档](https://bats-core.readthedocs.io/en/stable/writing-tests.html#bats-load-library-load-system-wide-libraries)说它按 `BATS_LIB_PATH` 查找；Cairn 的开发 shell 里 `flake.nix` 用 `bats.withLibraries` 把三个库打包进了 `bats` 命令，所以我这里 `BATS_LIB_PATH` 是空的，照样找得到。在别的发行版上你要自己装这三个库并设 `BATS_LIB_PATH`。

`bats --tap` 打印 TAP (Test Anything Protocol) 格式：一行 `1..N`（TAP 里叫 plan，写明一共有几个测试），然后每个测试一行 `ok` 或 `not ok`。`lab/ch08/bats_tap.sh` 对 `tests/prune.bats` 跑一遍 `--tap`，把输出存下来，再数 `1..N` 那一行和 `ok`、`not ok` 的行数（节选）：

```bash
bats --tap tests/prune.bats >"${LAB_TMP}/prune.tap"
status=$?
plan="$(grep -m 1 -E '^1\.\.[0-9]+$' "${LAB_TMP}/prune.tap")"
passed="$(grep -c -E '^ok ' "${LAB_TMP}/prune.tap")"
failed="$(grep -c -E '^not ok ' "${LAB_TMP}/prune.tap")"
echo "plan: ${plan}, ok: ${passed}, not ok: ${failed}"
```

真实输出（中间 10 行 `ok` 我省掉了）：

```text
$ bats --tap tests/prune.bats
1..14
ok 1 select keeps the newest KEEP_LAST and removes the rest
ok 2 select keeps one snapshot per day as daily
ok 3 select keeps one snapshot per ISO week as weekly
...
ok 14 prune does not touch the repository outside snapshots and manifests
plan: 1..14, ok: 14, not ok: 0
bats exit status: 0
```

`1..N` 在最前面，所以读的人一开始就知道该有几个结果；少一行 `ok` 和多一行 `not ok` 一样是问题。

## 每个测试自己的目录和环境

93 个测试能并行、能按任意顺序跑，只有一个前提：每个测试看到的世界是它自己的。Bats 给每个测试建一个新的空目录 `$BATS_TEST_TMPDIR`。我连续跑两个测试，第一个往里写文件，第二个数一数里面有几个条目：

```bash
@test "first" {
  echo "${BATS_TEST_TMPDIR}" >&3
  touch "${BATS_TEST_TMPDIR}/marker"
}

@test "second" {
  echo "${BATS_TEST_TMPDIR}" >&3
  find "${BATS_TEST_TMPDIR}" -mindepth 1 | wc -l >&3
}
```

```text
$ bats tmpdir.bats
1..2
/tmp/nix-shell.eLRNJi/bats-run-2eOEbN/test/1
ok 1 first
/tmp/nix-shell.eLRNJi/bats-run-2eOEbN/test/2
0
ok 2 second
```

目录名里的 `test/1`、`test/2` 是测试的序号，第二个测试里的 `find` 数出 0 个条目：第一个测试留下的 `marker` 不在了。光有空目录不够，Cairn 读的是 `HOME`、`XDG_CONFIG_HOME`、`CAIRN_CONFIG` 这几个环境变量，也读 `CAIRN_NOW`、`CAIRN_BWLIMIT` 这些调节行为的变量，它们要和 `BATS_TEST_TMPDIR` 一起被隔离。`tests/test_helper.bash` 前半段是这样（所有 `.bats` 文件开头都有 `load test_helper`）：

```bash
# run 的 --separate-stderr 等选项要 bats 1.5.0 以上。
bats_require_minimum_version 1.5.0

bats_load_library bats-support
bats_load_library bats-assert
bats_load_library bats-file

CAIRN_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
CAIRN="${CAIRN_ROOT}/bin/cairn"
export CAIRN_ROOT
```

`CAIRN_ROOT` 靠 `BASH_SOURCE[0]` 往上找一层，和 `bin/cairn` 找自己的库是同一个办法。第 1 篇讲 `${CAIRN_LIB:-默认值}` 的时候我说过第 8 篇的测试会用这个后门指向别处，真写下来发现用不上：测试直接让 `bin/cairn` 用它旁边的 `lib/cairn/`，所以后面 `common_setup` 里 `CAIRN_LIB` 只出现在 `unset` 的那一行。真正的隔离在 `common_setup` 里：

```bash
common_setup() {
  HOME="${BATS_TEST_TMPDIR}/home"
  XDG_CONFIG_HOME="${HOME}/.config"
  CAIRN_CONFIG="${XDG_CONFIG_HOME}/cairn/cairn.conf"
  SRC="${BATS_TEST_TMPDIR}/src"
  REPO="${BATS_TEST_TMPDIR}/repo"
  export HOME XDG_CONFIG_HOME CAIRN_CONFIG
  # 外部环境里的 CAIRN_* 不能漏进测试: 每个测试自己设需要的变量。
  unset CAIRN_NOW CAIRN_BWLIMIT CAIRN_JOBS CAIRN_LIB CAIRN_QUIET \
    CAIRN_VERBOSE
  PATH="${CAIRN_ROOT}/bin:${PATH}"
  mkdir -p -- "${HOME}"
  bash "${CAIRN_ROOT}/scripts/make_tree.sh" "${SRC}"
  "${CAIRN}" -q init "${REPO}"
  write_config
}

setup() {
  common_setup
}
```

读一遍就知道每一行为什么在这里。`HOME` 等三个变量指向 `BATS_TEST_TMPDIR` 里面，Cairn 的任何“默认配置位置”都落在临时目录里，不会碰你真实的 `~/.config`。`unset CAIRN_NOW ...` 是为了防止外面的变量漏进来，让每个测试的行为只取决于它自己写下的那几行（第 2 篇里 `CAIRN_NOW` 就是为了让快照名可预测才有的，所以它最该被隔离）。`PATH` 前面加上 `bin/` 是让测试里能直接写 `cairn`。最后三行搭好一个源目录（`scripts/make_tree.sh`，第 2 篇的夹具生成器，8 个普通文件，其中有中文名、带空格的名字和一个隐藏文件），一个用 `-q` 静默初始化的仓库，和一份指向它们的配置。`write_config` 接受额外的配置行：测试要改保留策略时写 `write_config 'keep_last = 2'` 就行，它会把整份配置重写一遍。

文件里还有一条 `# shellcheck disable=SC2119,SC2120`，是给 `write_config` 的：函数定义里用了 `$@`，调用处 (`setup`) 不传参，ShellCheck 就提示“这个函数引用了参数，但调用时没给”。测试文件里会传参，所以我把这两条提示关掉了。这是仓库里 `shellcheck disable` 的第一处，“ShellCheck”一节会数一数一共有几处。

## 退出码和错误消息

Cairn 对外承诺的东西很具体：7 个退出码和一批逐字固定的错误消息。每个退出码至少有一个测试按名字认领它：

| 退出码 | 含义 | 测试（文件里的名字） |
| --- | --- | --- |
| 0 | 成功 | `--version prints the version` (`cli.bats`) |
| 1 | 运行时失败 | `an existing snapshot name: exit 1` (`snapshot.bats`) |
| 2 | 用法错误 | `unknown command: exit 2 with both messages` (`cli.bats`) |
| 3 | 配置或仓库错误 | `init on a non-empty directory: exit 3` (`cli.bats`) |
| 4 | 锁被占用 | `a second snapshot while the lock is held: exit 4` (`lock_signal.bats`) |
| 130 | SIGINT | `SIGINT: exit 130, partial removed, status=interrupted logged` (`lock_signal.bats`) |
| 143 | SIGTERM | `SIGTERM: exit 143, partial removed, status=interrupted logged` (`lock_signal.bats`) |

用法错误是两行：先是具体的错误，再是 `run 'cairn --help' for usage`。测试把两行都钉住：

```bash
@test "unknown command: exit 2 with both messages" {
  run "${CAIRN}" frobnicate
  assert_failure 2
  assert_line -n 0 "cairn: error: unknown command 'frobnicate'"
  assert_line -n 1 "cairn: error: run 'cairn --help' for usage"
}
```

`assert_failure 2` 检查的是 `$status` 恰好是 2，不是“非 0”。这一点很重要：Cairn 区分 2（你敲错了）、3（配置错了）和 1（它自己运行出了问题），测试写成 `assert_failure` 就把这个区分丢了。

stdout 和 stderr 的分工也是行为的一部分。`--help` 的用法说明必须在 stdout，因为用户会把它传给 `less`；没有参数时的用法说明必须在 stderr，因为那是一个错误。两条都用 `--separate-stderr` 钉住：

```bash
@test "--help prints usage and the exit code table on stdout" {
  run --separate-stderr "${CAIRN}" --help
  assert_success
  assert_line 'Usage: cairn [OPTIONS] COMMAND [ARGS]'
  assert_line 'Exit codes:'
  assert_line --partial '4    another cairn holds the repository lock'
  assert_equal "${stderr}" ''
}
```

6 个命令各有一种参数个数的错法（`init` 有两种：一个参数也没有，或者多了一个），一共 7 种情形。不想写 7 个几乎一样的测试，就用循环；每一项带着它期望的第一行消息，用 `|` 隔开。`cli.bats` 里“参数个数不对”的那个测试是这样的：

```bash
@test "wrong argument count is a usage error for every command" {
  local entry cmd msg
  for entry in \
    'init|usage: cairn init REPO' \
    'init a b|usage: cairn init REPO' \
    'snapshot extra|snapshot takes no arguments' \
    'list extra|list takes no arguments' \
    'prune extra|prune takes no arguments' \
    'report extra|report takes no arguments' \
    'verify a b|usage: cairn verify [NAME]'; do
    cmd="${entry%%|*}"
    msg="${entry#*|}"
    # 故意不加引号: 要把 $cmd 拆成多个参数。
    # shellcheck disable=SC2086
    run "${CAIRN}" ${cmd}
    assert_failure 2
    assert_line -n 0 "cairn: error: ${msg}"
    assert_line -n 1 "cairn: error: run 'cairn --help' for usage"
  done
}
```

这里 `${cmd}` 没有加引号，是为了让第 2 篇讲过的分词把 `init a b` 拆成三个参数，ShellCheck 的 SC2086 会为这一行报警，所以前面有一条 `disable`，并且用注释写明了为什么。（这也说明一个习惯：`disable` 永远带一句理由，否则半年后没人敢删它。）`${entry%%|*}` 取第一个 `|` 之前的部分（命令行），`${entry#*|}` 取它之后的部分（消息）。循环里两行都被钉住：第 0 行是各命令自己的措辞，第 1 行是共同的提示。

配置错误一共 9 种消息，每一种有一个测试，大多数形如 `cairn: error: <文件>:<行号>: <原因>`（缺必填项和缺配置文件的那几种没有行号）。测试用 `write_config` 追加一行坏配置，行号因此是固定的 3（`setup` 写的配置里 `repo` 是第 1 行、`source` 是第 2 行）：

```bash
@test "line without '=': expected 'key = value'" {
  write_config 'keep_last 3'
  run "${CAIRN}" list
  assert_failure 3
  assert_output "cairn: error: ${CAIRN_CONFIG}:3: expected 'key = value'"
}
```

配置文件的查找顺序是 `-c` 选项优先于 `CAIRN_CONFIG` 再优先于 `XDG_CONFIG_HOME`。这个优先级我用三份“各缺一样”的配置文件来测：

```bash
@test "path precedence: -c beats CAIRN_CONFIG beats XDG_CONFIG_HOME" {
  local env_conf="${BATS_TEST_TMPDIR}/env.conf"
  local opt_conf="${BATS_TEST_TMPDIR}/opt.conf"
  # XDG: 空文件, 缺 repo; 环境变量指向的文件缺 source; -c 的文件完整。
  cp -- "${CAIRN_CONFIG}" "${opt_conf}"
  printf 'repo = %s\n' "${REPO}" >"${env_conf}"
  : >"${XDG_CONFIG_HOME}/cairn/cairn.conf"

  unset CAIRN_CONFIG
  run "${CAIRN}" list
  assert_failure 3
  assert_output \
    "cairn: error: ${XDG_CONFIG_HOME}/cairn/cairn.conf: missing required key 'repo'"

  CAIRN_CONFIG="${env_conf}" run "${CAIRN}" list
  assert_failure 3
  assert_output "cairn: error: ${env_conf}: missing required key 'source'"

  CAIRN_CONFIG="${env_conf}" run "${CAIRN}" -c "${opt_conf}" list
  assert_success
}
```

每种来源各缺一样，所以哪个文件被读到，错误消息里的文件名和缺失的键就会说出来；最后一条 `-c` 命令成功，证明环境变量被它盖过了。

`report` 的输出是一张固定格式的表，用 `assert_output -`（从 stdin 读期望值）和 here-document 写整张表，空日志的情形下是这样的：

```bash
@test "report on a missing log: zeros, no day rows" {
  run "${CAIRN}" report
  assert_success
  assert_output - <<'EXPECTED'
snapshots    0
ok           0
failed       0
interrupted  0
bytes        0
seconds      avg 0.0 max 0

DAY         SNAPSHOTS  BYTES
EXPECTED
}
```

对真实快照的那一条 (`report counts real snapshots per day`) 有两处要解释。第一，`bytes` 一行是 `49`，三个快照按日期分开后，第一天是 `49`，第二天是 `0`：`report` 数的是 rsync 实际传输的字节，后两个快照全部硬链接到第一个，传输了 0 字节，测试里的注释写着这一点。第二，表头是 `assert_line -n 6` 而不是 7，注释也写了原因：`lines` 不含空行（见“bats 做了什么”）。耗时那一行值得多看一眼：

```bash
  # 真实快照的耗时取决于秒边界, 只检查格式; 精确值由固定日志的测试验证。
  assert_line -n 5 --regexp '^seconds      avg [0-9]+\.[0-9] max [0-9]+$'
```

这行在我第一次写的时候是 `assert_line -n 5 'seconds      avg 0.0 max 0'`，“真实快照的耗时是 0 秒”看起来很合理，因为 3 个快照每个只传几十字节。它在“一个会时灵时不灵的测试”一节里造成了一次真实的事故。

最后一个例子是跳过。`ERR` 陷阱那个测试用 `chmod 000` 让日志不可读，好让 `awk` 失败，但 root 读文件不看权限位，所以它在 root 下没有意义，用 `skip` 跳过而不是失败：

```bash
@test "ERR trap names the failed command, -v adds the call frames" {
  [[ "${EUID}" -ne 0 ]] || skip 'root reads files whatever their mode'
  make_snapshots 20261031T090000Z
  chmod 000 "${REPO}/logs/cairn.log"
  run "${CAIRN}" report
  assert_failure
  assert_output --partial 'cairn: error: command failed (exit 2): awk -f'
  refute_output --partial '  at cmd_report ('
  run "${CAIRN}" -v report
  assert_failure
  assert_output --partial '  at cmd_report ('
  assert_output --partial '  at main ('
}
```

`skip` 会在 TAP 输出里变成 `ok 4 skip # skip not today` 那样的一行（见 `demo.bats`），不算失败也不算通过，我愿意让它在 CI 的统计里露个脸。

## 把库当库来测

Cairn 的库文件只定义函数和几个全局变量的初值，被 `source` 时不执行任何命令；`bin/cairn` 才有 `main "$@"`。这让库成了最容易测的东西：`source` 它，直接调用函数，不需要启动一个 `cairn` 进程。`snapshot.sh` 里有一个按 `CAIRN_NOW` 或当前时间产生快照名的函数，它的两个测试是这样：

```bash
@test "snapshot::name returns CAIRN_NOW unchanged" {
  source "${CAIRN_ROOT}/lib/cairn/log.sh"
  source "${CAIRN_ROOT}/lib/cairn/snapshot.sh"
  CAIRN_NOW=20300102T030405Z run cairn::snapshot::name
  assert_success
  assert_output 20300102T030405Z
}

@test "snapshot::name rejects a malformed CAIRN_NOW with status 2" {
  source "${CAIRN_ROOT}/lib/cairn/log.sh"
  source "${CAIRN_ROOT}/lib/cairn/snapshot.sh"
  CAIRN_NOW=2030-01-02 run cairn::snapshot::name
  assert_failure 2
  assert_output 'cairn: error: CAIRN_NOW must look like 20261031T090000Z'
}
```

两个 `source` 放在测试函数里，不放在文件顶部，因为每个测试是独立的进程，谁需要谁自己 `source`；先 `log.sh` 再 `snapshot.sh`，因为后者调用了前者的 `cairn::log::err`。`CAIRN_NOW=... run 函数名` 把环境变量赋值放在 `run` 前面，它只对这一次调用有效，不会污染下一个测试。`prune.bats` 的 14 个测试里有 7 个是纯函数的测试，所以它把 `source` 放进了 `setup`：

```bash
setup() {
  common_setup
  source "${CAIRN_ROOT}/lib/cairn/log.sh"
  source "${CAIRN_ROOT}/lib/cairn/prune.sh"
}

@test "select keeps the newest KEEP_LAST and removes the rest" {
  run cairn::prune::select 2 0 0 \
    20261029T090000Z 20261030T090000Z 20261031T090000Z 20261101T090000Z
  assert_success
  assert_line -n 0 'keep 20261101T090000Z last'
  assert_line -n 1 'keep 20261031T090000Z last'
  assert_line -n 2 'remove 20261030T090000Z'
  assert_line -n 3 'remove 20261029T090000Z'
  assert_equal "${#lines[@]}" 4
}
```

覆盖 `setup` 的时候别忘了先调用 `common_setup`，不然这个文件里的测试就没有隔离。`prune::select` 是第 4 篇写的纯函数（给它保留策略和一串名字，它只往 stdout 打印 `keep ... 原因` 和 `remove ...`，不碰文件系统），这一类函数的测试只有输入和输出，没有环境。我最喜欢的是 `week` 那一条，它钉住了 ISO 周的边界：

```bash
@test "week: ISO week of a snapshot name" {
  run cairn::prune::week 20261031T090000Z
  assert_output '2026-W44'
  run cairn::prune::week 20261228T090000Z
  assert_output '2026-W53'
  run cairn::prune::week 20270101T090000Z
  assert_output '2026-W53'
}
```

2027 年 1 月 1 日属于 ISO 2026 年的第 53 周，写 `date +%Y-W%V` 的人会得到 `2027-W53`，这样的测试是我在改 `date` 格式串之前最想先有的那一条。

锁也可以当库来测，但有一个陷阱：`run` 在子 shell 里执行函数，子 shell 退出时锁（一个文件描述符）也释放了，所以“先拿锁、再测第二次拿不到”必须在当前 shell 里拿第一次：

```bash
@test "lock::acquire: 0 on a free repository, 4 on a busy one" {
  source "${CAIRN_ROOT}/lib/cairn/log.sh"
  source "${CAIRN_ROOT}/lib/cairn/lock.sh"
  run cairn::lock::acquire "${REPO}"
  assert_success
  # run 在子 shell 里执行, 子 shell 退出时锁已释放; 这次在当前 shell 里拿。
  cairn::lock::acquire "${REPO}"
  run cairn::lock::acquire "${REPO}"
  assert_failure 4
  assert_output "cairn: error: another cairn is running on ${REPO}"
}
```

第一次 `run` 只证明“空闲时返回 0”，第二行不带 `run` 的调用才真正持有锁，第三次 `run` 看到的是占用。`assert_failure 4` 加上完整的错误消息，一个测试里钉住了第 7 篇的退出码 4 和它的措辞。

## 时间、环境变量和假的 rsync

测试最怕的两样东西是现在几点和外面有什么，Cairn 给这两样都留了注入口。时间靠 `CAIRN_NOW`（第 2 篇引入，快照名因此可预测）。`test_helper.bash` 里有一个 `make_snapshots`，按名字依次做快照：

```bash
make_snapshots() {
  local name
  for name in "$@"; do
    CAIRN_NOW="${name}" "${CAIRN}" -q snapshot >/dev/null || return
  done
}
```

于是“prune 保留最新两个”这种测试可以写成 `make_snapshots 20261028T090000Z 20261029T090000Z ...`，不用 `sleep 1` 等时钟走。注入不了的东西就退一步只断言形状，比如“不设 `CAIRN_NOW` 时快照名是当前的 UTC 时间”：

```bash
@test "without CAIRN_NOW the name is the current UTC time" {
  run "${CAIRN}" -q snapshot
  assert_success
  assert_regex "${output}" '^[0-9]{8}T[0-9]{6}Z$'
  assert_dir_exist "${REPO}/snapshots/${output}"
}
```

这是整套测试的一条原则：能注入的就注入成确定值，注入不了的只断言形状，不断言值。违反这条原则的那个测试，在“一个会时灵时不灵的测试”一节出场。

外面的程序也可以替换。Cairn 把 rsync 的退出码 24（传输时有文件消失）当成成功并给一条警告，可是在真实的 rsync 上很难稳定地制造“传输中文件消失”。测试的办法是在 `PATH` 前面放一个假的 `rsync`：

```bash
@test "rsync exit 24 is a success with a warning" {
  local stub="${BATS_TEST_TMPDIR}/stub"
  mkdir "${stub}"
  # 假 rsync: 建好目标目录, 打印 --stats 的两行, 以 24 退出。
  cat >"${stub}/rsync" <<'STUB'
#!/usr/bin/env bash
mkdir -p -- "${@: -1}"
printf 'Number of files: 3 (reg: 2, dir: 1)\n'
printf 'Total transferred file size: 1,234 bytes\n'
exit 24
STUB
  chmod +x "${stub}/rsync"
  PATH="${stub}:${PATH}" CAIRN_NOW="${NAME}" run --separate-stderr \
    "${CAIRN}" snapshot
  assert_success
  assert_output "${NAME}"
  assert_regex "${stderr}" 'cairn: warning: some files vanished during the snapshot'
  assert_regex "${stderr}" 'cairn: snapshot .*: 2 files, 1234 bytes'
  assert_dir_exist "${REPO}/snapshots/${NAME}"
}
```

`'STUB'` 加引号，是为了让 here-document 里的 `${@: -1}`（最后一个参数，也就是目标目录）留给假 rsync 自己展开，而不是在测试里被提前展开（第 5 篇讲过 here-document 的引用规则）。这个假 rsync 输出的两行统计恰好够 `cairn::snapshot::stats` 读出“2 个文件、1234 字节”（`reg: 2`，逗号被去掉了），所以最后两个断言一起检查了警告、退出码映射和统计解析。

不需要假的地方就不要假：rsync 的真实失败很容易得到，把 `source` 指向一个不存在的目录，rsync 退出 23，Cairn 要把它变成 `rsync failed with exit 23`、记一行 `status=failed` 的日志并且不留 `.partial`。这个测试 (`rsync failure: exit 1, no partial, status=failed in the log`) 没有用任何替身。

## 锁和信号

这是整套测试里最难写的一组，因为被测的东西是一个正在运行的进程。要在 `cairn snapshot` 跑到一半的时候发信号，就得先有一个“跑到一半”的快照。`tests/lock_signal.bats` 的 `setup` 造了一个 8 MiB 的源目录，再用 `CAIRN_BWLIMIT=256`（KiB/s，第 5 篇引入的限速变量）限速：8 × 1024 ÷ 256 = 32 秒，信号一定落在 rsync 运行期间。

```bash
setup() {
  common_setup
  # 一个 8 MiB 的源目录, 配合 CAIRN_BWLIMIT=256 (KiB/s) 至少要跑 30 秒,
  # 所以信号一定在 rsync 运行期间到达。
  BIG="${BATS_TEST_TMPDIR}/big"
  bash "${CAIRN_ROOT}/scripts/make_tree.sh" "${BIG}" --big 8
  printf 'repo = %s\nsource = %s\n' "${REPO}" "${BIG}" >"${CAIRN_CONFIG}"
  SLOW_PID=''
}

teardown() {
  # 保险: 测试失败时不要留下仍在跑的 cairn。
  if [[ -n "${SLOW_PID}" ]]; then
    kill -KILL "${SLOW_PID}" 2>/dev/null || :
    pkill -KILL -f "rsync .*${BATS_TEST_TMPDIR}" 2>/dev/null || :
  fi
}
```

32 秒的快照，测试当然不能等它结束，也不能靠 `sleep 1` 去猜“这时 rsync 应该已经开始了”：猜错一次，信号落在 rsync 启动之前，测试就变成一个时灵时不灵的测试。我的办法是等一个标记：rsync 把数据写进 `<快照名>.partial` 目录，这个目录一出现就说明 rsync 在跑了。

```bash
start_slow_snapshot() {
  # 后台作业 (没有作业控制时) 和 bats --jobs 下的测试进程都会忽略 SIGINT,
  # 而 bash 无法重新打开已被忽略的信号: 用 env --default-signal 在 exec
  # 之前把 INT 恢复成默认处理, cairn 才能装它的 INT trap。
  CAIRN_BWLIMIT=256 CAIRN_NOW="${NAME}" \
    env --default-signal=INT "${CAIRN}" snapshot \
    >"${BATS_TEST_TMPDIR}/slow.out" 2>"${BATS_TEST_TMPDIR}/slow.err" &
  SLOW_PID=$!
  local tries
  for ((tries = 0; tries < 400; tries++)); do
    if compgen -G "${REPO}/snapshots/*.partial" >/dev/null; then
      return 0
    fi
    sleep 0.05
  done
  echo 'timeout: rsync never created the .partial directory' >&2
  return 1
}
```

循环最多等 400 × 0.05 = 20 秒，超时就让 `start_slow_snapshot` 失败，测试带着一条看得懂的消息结束，而不是挂住。`sleep 0.05` 还在，但它只是轮询的间隔：条件满足时一轮也不多等。

函数开头那条 `env --default-signal=INT` 是这一组测试里最贵的一课，我把它拆开来验证。第一件事：一个在启动时就被忽略的信号，Bash 里没法再捕获。下面第一组里 `(trap '' INT; ...)` 先把 INT 设成忽略，里面再启动的 `bash -c` 继承了这个忽略状态，它自己的 `trap "echo trapped" INT` 没有任何效果：

```text
$ (trap '' INT; bash -c 'trap "echo trapped" INT; kill -INT $$; echo "after, still alive"')
after, still alive
$ (trap '' INT; env --default-signal=INT bash -c 'trap "echo trapped" INT; kill -INT $$; echo "after, still alive"')
trapped
after, still alive
```

两条命令的唯一区别是 `env --default-signal=INT`：它在 `exec` 之前把 INT 恢复成默认处理，里面的 `bash` 才有机会装自己的 `trap`。第二件事：谁会让 INT 被忽略？有两个。后台启动的作业：没有作业控制的非交互 shell 会让 `&` 启动的命令忽略 INT 和 QUIT。我读 `/proc/self/status` 里的 `SigIgn`（被忽略信号的位掩码，第 n 位对应信号 n+1）：

```text
$ bash -c 'grep SigIgn /proc/self/status; grep SigIgn /proc/self/status & wait'
SigIgn:	0000000001000000
SigIgn:	0000000001000006
```

后台那一行多出来的 `6` 是 `0x2`(INT) 加 `0x4`(QUIT)。这就是 `start_slow_snapshot` 里的 `&`。第二个是 `bats --jobs`：它通过 GNU parallel 启动测试进程（没有 parallel 的话 `--jobs` 根本跑不起来，“并行：`--jobs`”一节有真实的报错）。我用一个只打印 `SigIgn` 的测试，分别串行和并行地跑：

```bash
@test "signal dispositions" {
  grep SigIgn /proc/$$/status >&3
}
```

```text
$ bats signals.bats | grep SigIgn
SigIgn:	0000000001000004
$ bats --jobs 2 signals.bats | grep SigIgn
SigIgn:	0000000001002006
```

串行时测试进程不忽略 INT（`0x4` 是 QUIT，我的普通 shell 里也是这样），`--jobs 2` 之后掩码里多了 `0x2`。我没有去 GNU parallel 的源码里找它为什么这样做，大概是为了让 Ctrl-C 停掉整个任务而不是只杀死某个 worker，但这是我的猜测。结论是：用了 `&`，或者用了 `--jobs`，被测的程序在测试里就收不到默认的 INT，两个原因各自都足以让 `trap` 失效，所以串行和并行都需要 `env --default-signal=INT`。

有了慢快照，SIGINT 的测试读起来就是一份清单：

```bash
@test "SIGINT: exit 130, partial removed, status=interrupted logged" {
  start_slow_snapshot
  kill -INT "${SLOW_PID}"
  local status=0
  wait "${SLOW_PID}" || status=$?
  assert_equal "${status}" 130
  run compgen -G "${REPO}/snapshots/*.partial"
  assert_failure
  assert_equal "$(snapshot_names)" ''
  run tail -n 1 "${REPO}/logs/cairn.log"
  assert_regex "${output}" \
    "WARN snapshot name=${NAME} status=interrupted\$"
  run cat "${BATS_TEST_TMPDIR}/slow.err"
  # rsync 自己也会在 stderr 写几行 "received SIGINT", 只看 cairn 的那一行。
  assert_line "cairn: warning: interrupted, removing ${NAME}.partial"
  assert_equal "$(<"${BATS_TEST_TMPDIR}/slow.out")" ''
}
```

注意退出码没有用 `run` 取，而是用 `wait "${SLOW_PID}" || status=$?`：`wait` 对后台进程返回它的退出状态，我只关心它恰好是 130（128 + 2，第 7 篇讲过）。接下来 5 个断言一一对应第 7 篇的承诺：没有 `.partial`，没有快照，日志最后一行是 `status=interrupted`，stderr 里有 cairn 自己的警告，stdout 是空的。`assert_regex` 里的 `\$` 是在双引号里写一个字面的 `$` 锚点。

锁的测试比信号简单。“持有锁”不需要启动 `cairn`，测试自己拿：

```bash
@test "a second snapshot while the lock is held: exit 4" {
  exec {held}>"${REPO}/.lock"
  flock -n "${held}"
  run "${CAIRN}" snapshot
  assert_failure 4
  assert_output "cairn: error: another cairn is running on ${REPO}"
  assert_equal "$(snapshot_names)" ''
}
```

`exec {held}>"${REPO}/.lock"` 让 Bash 选一个空闲的文件描述符号存进 `held`（第 7 篇讲过这个写法），`flock -n` 在上面加锁；测试结束，那个进程里的描述符随之关闭，锁自然释放，所以这里连 `teardown` 都不需要。同一组里的其他锁测试：`prune` 和 `snapshot -n` 也要拿锁（退出码都是 4），`list`、`verify`、`report` 这类只读命令不拿锁（锁被占用时照样成功），`cairn` 正常退出后锁会释放，以及“把库当库来测”一节里那个直接调用 `cairn::lock::acquire` 的测试。

剩下一个测试需要等：“SIGTERM 之后锁又空闲了”。我本来以为 `wait` 返回，锁就空闲了，实际不是。第 7 篇讲过 rsync 的辅助进程会继承锁的文件描述符，`cairn` 退出之后它们还要活一会儿，所以 helper 函数 `wait_for_free_lock` 是轮询：

```bash
wait_for_free_lock() {
  local tries fd
  for ((tries = 0; tries < 200; tries++)); do
    exec {fd}>"${REPO}/.lock"
    if flock -n "${fd}"; then
      exec {fd}>&-
      return 0
    fi
    exec {fd}>&-
    sleep 0.05
  done
  return 1
}
```

这个函数头上的注释起初把这个延迟写成“几毫秒”，我量了一下，因为“几毫秒”是我会不信的数字。下面是我写的另一个小测试（不在仓库里）：每一轮起一个慢快照，等 `.partial` 出现，发 SIGTERM，`wait` 返回之后立刻开始计时，每 5 毫秒试一次 `flock -n`，直到拿到锁：

```bash
    kill -TERM "${pid}"
    wait "${pid}" || :
    t0="${EPOCHREALTIME/./}"
    until flock -n "${REPO}/.lock" true; do
      sleep 0.005
    done
    t1="${EPOCHREALTIME/./}"
    echo "lock free $(((t1 - t0) / 1000)) ms after cairn exited" >&3
```

```text
$ bats race.bats
1..1
lock free 100 ms after cairn exited
lock free 100 ms after cairn exited
lock free 91 ms after cairn exited
lock free 96 ms after cairn exited
lock free 100 ms after cairn exited
ok 1 how long until the lock is free after cairn exits?
```

5 次测得 91 到 100 ms，每次 `wait` 返回时锁都还被持有（我另外跑过 10 轮不轮询的版本，10 轮全部是“仍被持有”，所以不轮询的测试一定失败，而不是偶尔失败）。`${EPOCHREALTIME/./}` 去掉小数点，得到微秒整数，是 Bash 5 的内建变量，不用启动 `date`。这个 100 ms 比“几毫秒”大一个数量级，所以我把仓库里的注释改成了“about 100 ms”（`ch08` 标签上就是这样）。我没有追究它具体花在哪儿，大概是 rsync 被 TERM 之后收尾的时间。轮询的上限是 200 × 0.05 = 10 秒，足够宽松，又不会让一个真的坏掉的测试挂住。

## 第 7 篇留下的两个错

现在回到开头那个 `unbound variable`。第 8 篇的 93 个测试里，有 4 个在 `ch07` 的代码上失败。我把 `ch08` 的 `tests/` 复制到一份 `ch07` 的检出里（`git archive ch07` 解到 `/tmp/cairn-ch07`，再 `git archive ch08 tests` 解进去），不改任何库代码，直接跑：

```text
$ bats --jobs 16 tests | grep -E '^(not ok|1\.\.)'
1..93
not ok 9 -c FILE, --config FILE and --config=FILE are equivalent
not ok 27 comments, blank lines and blanks around '=' are accepted
not ok 51 prune logs one INFO line per removed snapshot, none on -n
not ok 76 list on an empty repository prints only the header
```

四个失败是两个错。第 9、27、76 号都是在空仓库上运行 `cairn list`：76 号专门测这件事，9 号和 27 号只是顺手用 `list` 当探针，它们期望的输出是单独一行表头。看失败是怎么呈现的，76 号是这样：

```text
not ok 1 list on an empty repository prints only the header
# (from function `assert_equal' in file ..., line 40,
#  in test file tests/snapshot.bats, line 156)
#   `assert_equal "${stderr}" ''' failed
#
# -- values do not equal --
# expected :
# actual   : /tmp/cairn-ch07/bin/../lib/cairn/repo.sh: line 121: dirs: unbound variable
# --
```

27 号则是 `assert_output` 的格式，期望一行，实际两行（`run` 把 stderr 合进了 `$output`）：

```text
# -- output differs --
# expected (1 lines):
#   NAME               FILES     SIZE
# actual (2 lines):
#   /tmp/cairn-ch07/bin/../lib/cairn/repo.sh: line 121: dirs: unbound variable
#   NAME               FILES     SIZE
# --
```

这就是前面答应过的“期望值和实际值并排”。76 号的 `list` 测试是这样写的（`cairn list` 打印表头，stderr 必须是空的）：

```bash
@test "list on an empty repository prints only the header" {
  run --separate-stderr "${CAIRN}" list
  assert_success
  assert_output 'NAME               FILES     SIZE'
  assert_equal "${stderr}" ''
}
```

`assert_success` 和 `assert_output` 在 `ch07` 上都是通过的，只有最后一行 `assert_equal "${stderr}" ''` 失败。这个错为什么能一路活到 `ch07` 的标签：`cairn::repo::sizes` 里有一个 `local -a dirs`，只声明、没有赋值。在这台机器的 Bash 5.3.15 里，开着 `set -u` 对一个声明了但没有任何元素的数组取 `${#dirs[@]}` 会报 `unbound variable`；`cmd_list` 是用 `readarray -t sizes < <(cairn::repo::sizes ...)` 读它的输出的，进程替换里的失败，主 shell 看不到。三条命令把整个因果链摆出来：

```text
$ bash -c 'set -u; f() { local -a d; echo "${#d[@]}"; }; f; echo "status=$?"'
bash: line 1: d: unbound variable
$ bash -c 'set -u; f() { local -a d=(); echo "${#d[@]}"; }; f'
0
$ bash -c 'set -u; f() { local -a d; echo "${#d[@]}"; }; readarray -t out < <(f); echo "status=$? n=${#out[@]}"'
bash: line 1: d: unbound variable
status=0 n=0
```

第一条里 `echo "status=$?"` 没有出现，整个 shell 在报错处就退出了；第二条加上 `=()` 就好了；第三条把它放进进程替换，`readarray` 成功读到 0 个元素，状态是 0，`names` 和 `sizes` 两个数组都是空的，长度相等，`cmd_list` 一路顺利地打印了表头。一个会失败的东西，被一个吞掉它状态的结构接住，而结果碰巧长得像正确答案。这和第 4 篇披露、这一篇没有修的 `prune::run` 里的 `readarray < <(cairn::prune::select ...)` 是同一类结构。修复是一行：

```diff
-  local -a dirs
+  local -a dirs=()
```

（`git diff ch07 ch08 -- lib/cairn/repo.sh`，它是 `lib/cairn/repo.sh` 里的第 116 行。）我很难想象一个只看退出码和 stdout 的测试会发现它，这个测试之所以能抓住，只因为它多看了一眼 stderr。前几篇的实验都是打印它要展示的东西，没有谁断言“另一个流是空的”，这是实验和测试的区别。

第二个错是 51 号：`prune` 删除一个快照时应该往日志写一行 `INFO prune removed=<名字>`。`ch07` 里没有这一行，`ch08` 补上了，一行：

```diff
         elif cairn::prune::remove "${name}"; then
           printf 'removed %s\n' "${name}"
+          cairn::log::file INFO prune "removed=${name}"
         else
```

这不是新功能：`prune` 删掉一个快照就该留下一条记录，这是它从一开始的设计，`ch07` 只是漏了。测试怎么发现的？它在 `ch07` 上这样失败：

```text
not ok 1 prune logs one INFO line per removed snapshot, none on -n
#   `assert_line -n 0 --regexp ' INFO prune removed=20261030T090000Z$'' failed
# ...: line 134: lines: parameter not set
```

`grep ' INFO prune ' cairn.log` 没有输出，`lines` 数组因此根本没被设置，bats-assert 抱怨的是 `lines: parameter not set`，不是漂亮的“期望什么、得到什么”，需要多读一眼才能看出是日志里缺了行。这个测试同时钉住了 `-n` 的情形：`-n prune` 之后日志里必须没有 `INFO prune`（`grep -c` 数出 0），因为 dry run 什么都没删。

## 一个会时灵时不灵的测试

我自己写的这套测试里也有一个测试是坏的，找到它也是因为我跑了很多遍。第一次把 `--jobs 16` 跑通之后，我把整套测试连跑 12 遍，每遍把 `not ok` 的行收集起来：

```text
$ for i in $(seq 1 12); do bats --jobs 16 tests | grep '^not ok'; done | sort | uniq -c
      2 not ok 59 report counts real snapshots per day
```

12 遍里 2 遍失败，失败的永远是同一个测试，也就是上面“退出码和错误消息”一节引用的 `report counts real snapshots per day`，它当时检查耗时的那一行是 `assert_line -n 5 'seconds      avg 0.0 max 0'`：

```text
# -- line differs --
# index    : 5
# expected : seconds      avg 0.0 max 0
# actual   : seconds      avg 0.3 max 1
```

原因在 `snapshot.sh` 里：快照的耗时是 `seconds=$((SECONDS - start))`，`SECONDS` 是整数秒，一个只花几十毫秒的快照，只要碰巧跨过一个整秒的边界，就记成 1 秒。并行时机器忙，快照变慢，跨边界的概率也变大。串行时它藏得更深：我串行连跑了 8 遍全过，只有后来 hyperfine 给串行跑计时的第一次尝试失败过一次（我当时没来得及看是哪个测试，我猜是它）。这是“时间、环境变量和假的 rsync”一节那条原则的反面教材：快照的耗时是我无法注入的值，我却断言了它的值。修复就是原则的另一半，只断言形状：

```bash
  # 真实快照的耗时取决于秒边界, 只检查格式; 精确值由固定日志的测试验证。
  assert_line -n 5 --regexp '^seconds      avg [0-9]+\.[0-9] max [0-9]+$'
```

“精确值由固定日志的测试验证”指的是同一个文件里 `report counts ok, failed and interrupted lines from the log` 那一条：它把一份手写的日志放进 `cairn.log`，其中 `seconds=4` 和 `seconds=1` 是写死的，所以 `avg 2.5 max 4` 是确定的。这样 `report.awk` 的算术仍然被钉住了，只是不再依赖时钟。修复之后我再跑了同样的 12 遍并行，没有一个 `not ok`。

“12 遍里 2 遍”是我真实测到的数字，但样本太少，我没有精确估计失败概率，只够说它是个真实的、必须修的问题。同一个断言在 `ch07` 代码上跑这套测试的那次也失败了一次，表现完全一样。

## 并行：`--jobs`

`Makefile` 里的 `test` 目标只有一行：

```make
test:
	bats --jobs "$$(nproc)" tests
```

`$$` 是 make 的转义，到 shell 那里是 `$(nproc)`，也就是 16。[Bats 文档](https://bats-core.readthedocs.io/en/stable/usage.html#parallel-execution)说 `--jobs` 要有 GNU parallel 或兼容的替代品，没有的话是什么样子？我把 `parallel` 所在的目录从 `PATH` 里去掉，再跑一个文件：

```text
$ bats --jobs 4 tests/report.bats
1..5
.../libexec/bats-core/bats-exec-suite: line 323: parallel: command not found
# bats warning: Executed 0 instead of expected 5 tests
```

没有 parallel 时 Bats 先打印 `1..5` 这一行，然后一个测试也没跑，退出码是 1（`bats warning` 那行是它自己发现“预期 5 个，实际执行 0 个”）。所以 `make test` 在没有 `parallel` 的机器上不是变慢，是直接失败，这也是 `flake.nix` 里要把 `parallel` 列进开发 shell 的原因。

快多少？我用 hyperfine 各跑 5 轮（先预热 1 轮），串行 `bats tests` 对 `bats --jobs 16 tests`：

```text
$ hyperfine -N --warmup 1 --runs 5 "bats tests" "bats --jobs 16 tests"
Benchmark 1: bats tests
  Time (mean ± σ):     22.341 s ±  0.074 s    [User: 8.379 s, System: 10.261 s]
  Range (min … max):   22.244 s … 22.425 s    5 runs

Benchmark 2: bats --jobs 16 tests
  Time (mean ± σ):      6.125 s ±  0.440 s    [User: 12.750 s, System: 14.406 s]
  Range (min … max):    5.706 s …  6.792 s    5 runs

Summary
  bats --jobs 16 tests ran
    3.65 ± 0.26 times faster than bats tests
```

93 个测试，22.3 s 对 6.1 s，3.65 倍。16 个任务只换来 3.65 倍，我有三个猜测，都没有验证：最长的一个文件（`lock_signal.bats`，12 个测试合计 4.75 s，它每个测试的 `setup` 都要造一个 8 MiB 的目录）限制了并行的下限；每个测试都在 fork 一堆进程 (`rsync`, `find`, `sha256sum`, `flock`)，系统时间从串行的 10.3 s 涨到 14.4 s，说明内核的 fork 和文件操作在 16 个核上并不能线性扩展；以及这台机器的 `lscpu` 说 8 个物理核、每核 2 个线程，超线程的第二个线程拿不到整核的算力。每个测试单独的耗时可以用 `bats --timing` 看，最慢的是这几个（`bats --timing tests` 的 TAP 输出，按末尾的毫秒数降序排的前 5 行）：

```text
ok 41 the lock is free again after SIGTERM in 901ms
ok 42 interrupted snapshots show up in the report in 662ms
ok 39 SIGINT: exit 130, partial removed, status=interrupted logged in 628ms
ok 38 a running snapshot holds the lock: the second one exits 4 in 625ms
ok 40 SIGTERM: exit 143, partial removed, status=interrupted logged in 615ms
```

93 个测试各自耗时之和大约是 15.5 s（另一次 `--timing` 的合计），比 22.3 s 的总时间少了 6.8 s，剩下的大概是 Bats 自己启动每个测试、加载三个库的开销，我没有拆开量。最慢的测试都是信号和锁，没有一个超过 0.9 s：没有哪个测试在等一个固定的睡眠。

并行跑测试有两个前提，前面都见过了：每个测试自己的 `BATS_TEST_TMPDIR`，以及进程之间不共享任何固定的名字、端口或文件。`--jobs` 也改变输出：一个文件跑完后它的结果才整块出现，TAP 里的编号还是按文件顺序排，不是按完成顺序。

## 没有人写的测试

93 个测试抓住了 `ch07` 的两个错，这件事我愿意高兴一会儿，然后马上做一件更重要的事：找出它没抓住什么。`ch07` 留下的已知缺口（第 4 篇到第 7 篇各自披露过）有四个：

- 信号落在 `mv` 和 `CAIRN_SNAP_PARTIAL` 复位之间，或者落在 `manifest::write` 期间，会留下一个没有清单的快照。
- 没有 HUP 陷阱：终端关闭时 `cairn` 以 129 退出，rsync 还活着，锁一直被它持有。
- `prune::run` 里 `readarray < <(cairn::prune::select ...)` 把 `select` 的失败藏在了进程替换里。
- `prune::remove` 用 `chmod -R` 去动硬链接共享的文件。

这套测试没有写其中任何一个，而且是故意的：它不去钉一个已知有错的行为（钉下去等于认可它）。所以这四个洞在测试里都是空白，不是绿色的。第 3 个我跑了一遍：在 `snapshots/` 里放一个名字不是时间戳的目录，`prune` 会遇到一个让 `date` 失败的名字：

```text
$ mkdir "${repo}/snapshots/not-a-timestamp"
$ cairn -c "${conf}" prune; echo "exit=$?"
date: invalid date ‘not-a-ti es:ta:mp’
exit=0
$ ls "${repo}/snapshots"
not-a-timestamp
```

`date` 在进程替换里失败了，错误消息漏到 stderr，退出码是 0，`prune` 什么也没删，也没有告诉你它没删。这和“第 7 篇留下的两个错”一节里 `list` 的 `unbound variable` 是同一种形状。（错误消息里的 `‘not-a-ti es:ta:mp’` 不是我打错了：`prune` 把名字切成日期和时间交给 `date -u -d`，切出来的就是这样。）写一个会失败的测试去钉住它，是“练习”一节的第 2 题。HUP 那一条也一样，是第 3 题。

第二类缺口更平淡：错误消息。我把 `bin/` 和 `lib/` 里每个 `cairn::log::err`、`cairn::log::warn` 和 `usage_error` 的调用点数了一遍，一共 41 个，去重后 39 条消息，再逐条用 `grep -F` 在 `tests/` 里找它的原文。39 条里有 33 条在断言里找得到，包括“退出码和错误消息”一节那个循环钉住的 6 条用法消息；剩下 6 条在任何断言里都找不到：

- `cannot compute the snapshot sizes`、`cannot remove <name>`、`cannot rename <name>.partial`、`cannot write the manifest of <name>`、`cannot update the latest link`：它们都是 I/O 失败的消息，要造出这些失败得做点手脚（比如把某个目录改成只读），我没有做。
- `rsync failed`：那是 `cairn snapshot REPO SOURCE...` 这个第 2 篇留下的旧形式的消息，整条路径没有测试。（`rsync failed with exit 23` 是另一条，`snapshot.bats` 里有。）

这不是说这些消息有错，而是说它们现在是否有错，没有机器知道。我想要的是“每一个退出码和每一条错误消息都有测试”，现在的结果是：7 个退出码都有人认领，错误消息认领了 39 条里的 33 条，还差 6 条，没有做到。“覆盖率：kcov”一节的数字会再说一遍这件事。

## ShellCheck

[ShellCheck](https://www.shellcheck.net/) 不运行你的脚本，它读语法树，按一张编号的清单找常见的坑，每个坑有一个 `SCxxxx` 编号和一个级别 (error, warning, info, style)。[Google 风格指南说](https://google.github.io/styleguide/shellguide.html#s6.1-shellcheck)所有脚本不论大小都推荐用它。`lab/ch08/shellcheck_demo_fail.sh` 对一个 11 行的故意写坏的夹具运行它：

```bash
cd "${CAIRN_ROOT}/lab/ch08/fixtures" || exit 1
echo '$ shellcheck --shell=bash bad_script.txt'
shellcheck --shell=bash bad_script.txt
status=$?
count="$(shellcheck --shell=bash --format=gcc bad_script.txt | wc -l)"
echo "shellcheck exit status: ${status}"
echo "findings: ${count}"
exit "${status}"
```

夹具 `fixtures/bad_script.txt` 是一个故意写坏的脚本，里面的写法大多是反面教材，不要照抄（扩展名 `.txt` 是为了不让 `make lint` 去检查它）：

```bash
# 故意写坏的脚本: 只给 ShellCheck 看, 不运行。
backup() {
  dir=$1
  cd $dir
  local stamp=$(date +%F)
  echo "backup at $stamp"
  for f in $(ls $dir); do
    echo "copy $f at `date`"
  done
}
backup "$@"
```

输出（`make ch08` 之后在 `out/ch08/shellcheck_demo_fail.stdout`）：

```text
$ shellcheck --shell=bash bad_script.txt

In bad_script.txt line 4:
  cd $dir
  ^-----^ SC2164 (warning): Use 'cd ... || exit' or 'cd ... || return' in case cd fails.
     ^--^ SC2086 (info): Double quote to prevent globbing and word splitting.

Did you mean:
  cd "$dir" || exit


In bad_script.txt line 5:
  local stamp=$(date +%F)
        ^---^ SC2155 (warning): Declare and assign separately to avoid masking return values.


In bad_script.txt line 7:
  for f in $(ls $dir); do
           ^--------^ SC2045 (error): Iterating over ls output is fragile. Use globs.
                ^--^ SC2086 (info): Double quote to prevent globbing and word splitting.

Did you mean:
  for f in $(ls "$dir"); do


In bad_script.txt line 8:
    echo "copy $f at `date`"
                     ^----^ SC2006 (style): Use $(...) notation instead of legacy backticks `...`.

Did you mean:
  echo "copy $f at $(date)"

For more information:
  https://www.shellcheck.net/wiki/SC2045 -- Iterating over ls output is fragi...
  https://www.shellcheck.net/wiki/SC2155 -- Declare and assign separately to ...
  https://www.shellcheck.net/wiki/SC2164 -- Use 'cd ... || exit' or 'cd ... |...
shellcheck exit status: 1
findings: 6
```

我数了：6 条发现，对应 5 个编号，`SC2086` 出现了两次（第 4 行和第 7 行）。它们逐个对上一条本系列已经讲过的规则：

- [SC2086](https://www.shellcheck.net/wiki/SC2086)：没有加引号的展开会被分词和通配（第 2 篇的主题），`cd $dir` 遇到带空格的目录就会拆成两个参数。
- [SC2164](https://www.shellcheck.net/wiki/SC2164)：`cd` 可能失败，失败之后脚本在错误的目录里继续往下跑，第 7 篇的 `cd ... || exit 1` 就是这个原因。
- [SC2155](https://www.shellcheck.net/wiki/SC2155)：`local stamp=$(date +%F)` 的退出状态是 `local` 的（几乎永远是 0），`date` 的失败被吞了。这就是 Google 指南[“Use Local Variables”](https://google.github.io/styleguide/shellguide.html#s7.5-use-local-variables)里“声明和赋值必须是两条语句”的理由（指南的说法：`local` 内建不传播命令替换的退出码），`set -e` 也救不了它。
- [SC2045](https://www.shellcheck.net/wiki/SC2045)：`for f in $(ls ...)` 遇到带空格和换行的文件名会拆坏，要用通配符（第 2 篇里让 `for` 遍历 `ls` 输出的那个实验）。它是 error 级别。
- [SC2006](https://www.shellcheck.net/wiki/SC2006)：反引号是老写法，嵌套要转义，[Google 指南的“命令替换”](https://google.github.io/styleguide/shellguide.html#s6.2-command-substitution)要求用 `$(...)`。

退出状态是 1，而且只要有一条发现，哪怕只是 `info` 或 `style` 级别，退出状态就是 1，所以 `make lint` 里 ShellCheck 一旦出声，整个目标就失败。这个夹具一次凑齐了 error、warning、info、style 四个级别。

仓库自己的脚本怎么让它安静下来？三类指令，都是写在脚本里的注释。第一类是 `source=`：`bin/cairn` 在运行时 `source` 七个库，ShellCheck 静态读不到变量里的路径，所以每个 `source` 前有一行指令告诉它去哪找：

```bash
# shellcheck source=../lib/cairn/log.sh
source "${CAIRN_LIB}/log.sh"
```

`.shellcheckrc` 里的 `source-path=SCRIPTDIR` 让这个相对路径以脚本所在目录为起点，`external-sources=true` 允许它读被 `source` 的文件。第二类是 `shell=bash`：没有 shebang 的文件（库、实验脚本、`test_helper.bash`）第一行是 `# shellcheck shell=bash`，不写的话 ShellCheck 不知道该按哪种 shell 解析。第三类就是 `disable=`，`tests/` 里总共 7 处。我很好奇它们是不是都需要，所以把 `tests/` 复制到一个临时目录，把所有 `# shellcheck disable=` 行删掉再跑一遍，看哪几处真的报警：

```text
$ shellcheck --format=gcc tests/*.bats tests/test_helper.bash
tests/cli.bats:70:20: note: Double quote to prevent globbing and word splitting. [SC2086]
tests/lock_signal.bats:18:38: note: Possible misspelling: REPO may not be assigned. Did you mean repo? [SC2153]
tests/snapshot.bats:16:22: note: Possible misspelling: REPO may not be assigned. Did you mean repo? [SC2153]
tests/test_helper.bash:27:1: warning: write_config references arguments, but none are ever passed. [SC2120]
tests/test_helper.bash:57:3: note: Use write_config "$@" if function's $1 should mean script's $1. [SC2119]
```

（这是复制出来、删光了 `disable` 之后的 `tests/` 跑出来的结果，`--format=gcc` 把每条发现压成一行，一共 5 条。）SC2120 和 SC2119 是一对：`write_config` 的定义里用了参数，调用处一个也没传。`REPO` 是 `test_helper.bash` 里赋的值，ShellCheck 不会跟着 `load` 去找，所以它觉得 `REPO` 可能是拼写错误；真有报警的只有 `cli.bats`、`lock_signal.bats`、`snapshot.bats` 和 `test_helper.bash` 四个文件。`prune.bats`、`report.bats` 和 `verify_diff.bats` 里的 `SC2153` 指令删掉也没有报警，是多余的。多余的 `disable` 是无害的，只是下次有人看到它，会以为这里有什么难处。我没有去改它们（这一篇不改仓库里别的东西），只是把这个观察记在这里。

怎么让 `.bats` 文件进入 `make lint`？`Makefile` 是这样：

```make
SHELL_FILES = $(shell shfmt -f bin lib scripts lab tests completions install.sh 2>/dev/null) $(wildcard tests/*.bats)
```

`shfmt -f` 递归列出目录下所有它认识的 shell 文件，包括 `.bats`，所以后面的 `$(wildcard tests/*.bats)` 其实是多余的：我用 `make -n lint` 看了展开后的命令，`tests/cli.bats` 在 `shellcheck` 的参数里出现了两次，每个 `.bats` 文件都被检查了两遍。无害，只是重复，我也没有改它。`make -s lint` 在这个标签上什么也不输出：

```text
$ make -s lint; echo "lint exit $?"
lint exit 0
```

## shfmt

[shfmt](https://github.com/mvdan/sh) 做的是另一半：格式。Google 指南里关于排版的规则有一半是机械的（缩进几格、管道怎么折行、`case` 怎么缩进），机械的规则不应该靠人眼来守，shfmt 把它们变成三个开关：

| 开关 | 做什么 | 对应的 Google 规则 |
| --- | --- | --- |
| `-i 2` | 缩进 2 个空格 | [缩进](https://google.github.io/styleguide/shellguide.html#s5.1-indentation)：2 个空格，不用 tab |
| `-bn` | 二元运算符 (`\|`, `&&`, `\|\|`) 放在续行的行首 | [管道](https://google.github.io/styleguide/shellguide.html#s5.3-pipelines)：折行时每段一行，`\|` 在新行 |
| `-ci` | `case` 的各个分支缩进一层 | [case 语句](https://google.github.io/styleguide/shellguide.html#s5.5-case-statement)：分支缩进 2 格 |

`; then` 和 `; do` 放在同一行（[控制流](https://google.github.io/styleguide/shellguide.html#s5.4-control-flow)）不需要开关，shfmt 总是这样做。我拿一个 12 行的小脚本，分别不加开关、只加 `-i 2`、加全三个（脚本故意不合规，所以第一行标了 `# BAD`）：

```bash
# BAD: not Google style on purpose, only for shfmt to look at.
check() {
  if [[ -r $1 ]] &&
    grep -q x "$1"; then
    echo yes
  fi
  case "$1" in
  a) echo A ;;
  esac
  sort "$1" |
    uniq
}
```

```text
$ shfmt check.sh | cat -A | head -5
# BAD: not Google style on purpose, only for shfmt to look at.$
check() {$
^Iif [[ -r $1 ]] &&$
^I^Igrep -q x "$1"; then$
^I^Iecho yes$
$ shfmt -i 2 check.sh
# BAD: not Google style on purpose, only for shfmt to look at.
check() {
  if [[ -r $1 ]] &&
    grep -q x "$1"; then
    echo yes
  fi
  case "$1" in
  a) echo A ;;
  esac
  sort "$1" |
    uniq
}
$ shfmt -i 2 -bn -ci check.sh
# BAD: not Google style on purpose, only for shfmt to look at.
check() {
  if [[ -r $1 ]] \
    && grep -q x "$1"; then
    echo yes
  fi
  case "$1" in
    a) echo A ;;
  esac
  sort "$1" \
    | uniq
}
```

默认的 shfmt 用 tab，`-i 2` 换成两个空格（`cat -A` 里的 `^I` 就是 tab）；`-bn` 把行尾的 `&&` 和 `|` 挪到下一行行首，并补上续行的反斜杠；`-ci` 让 `a)` 缩进两格。`lab/ch08/shfmt_demo.sh` 对一个故意写得难看的夹具做同样的事，并且让 shfmt 自己检查自己的输出（格式化两次，第二次不能再有差别）：

```bash
cd "${CAIRN_ROOT}/lab/ch08/fixtures" || exit 1
echo '$ shfmt -ln bash -i 2 -bn -ci -d ugly_script.txt'
shfmt -ln bash -i 2 -bn -ci -d ugly_script.txt
echo "shfmt -d exit status: $?"

echo '--- formatted twice ---'
shfmt -ln bash -i 2 -bn -ci ugly_script.txt \
  | shfmt -ln bash -i 2 -bn -ci -d
echo "second pass exit status: $?"
exit 0
```

```text
$ shfmt -ln bash -i 2 -bn -ci -d ugly_script.txt
diff ugly_script.txt.orig ugly_script.txt
--- ugly_script.txt.orig
+++ ugly_script.txt
@@ -1,18 +1,17 @@
 # 故意写得难看的脚本: 只给 shfmt 看, 不运行。
-greet(){
-    local name="$1"
-    if [[ -n "$name" ]]
-    then
-        echo "hello, $name"
-    else
-        echo "hello"
-    fi
-    case "$name" in
-        root) echo admin;;
-        *) echo user;;
-    esac
-    cat file \
-        | sort \
-        | uniq
+greet() {
+  local name="$1"
+  if [[ -n "$name" ]]; then
+    echo "hello, $name"
+  else
+    echo "hello"
+  fi
+  case "$name" in
+    root) echo admin ;;
+    *) echo user ;;
+  esac
+  cat file \
+    | sort \
+    | uniq
 }
 greet "$@"
shfmt -d exit status: 1
--- formatted twice ---
second pass exit status: 0
```

注意 `-ln bash`：夹具的扩展名是 `.txt`，shfmt 没法从扩展名和 shebang 判断语言，所以实验里显式指定了方言。`shfmt -d` 有差别时退出码是 1，实验把它打印出来，然后自己用 `exit 0` 结束（运行器要求这个实验成功）；格式化后的结果再喂给 `shfmt -d`，第二遍退出码是 0，说明格式化是幂等的。

shfmt 不管的规则也值得知道：它不折长行，80 列的限制仍然是我的事（我用 `awk 'length > 80'` 扫过 `bin/`、`lib/`、`tests/`、`scripts/` 和 `lab/ch08/`，只在 `tests/` 里找到 10 行，全是长字符串字面量，Google 指南允许）；它不改变量名，不加引号，不替你写函数头注释，这些归 ShellCheck 和眼睛。

## bash -n、bash -x 与 PS4

静态检查之外还有最原始的两个开关，都在 Bash 本身里。`bash -n` 只解析、不执行，`lab/ch08/bash_n_fail.sh` 把它对准一个少了 `fi` 的夹具：

```bash
# shellcheck shell=bash
fixture="${CAIRN_ROOT}/lab/ch08/fixtures/broken_script.txt"
cd "$(dirname -- "${fixture}")" || exit 1
echo '$ bash -n broken_script.txt'
bash -n broken_script.txt
status=$?
echo "bash -n exit status: ${status}"
exit "${status}"
```

```text
$ cat out/ch08/bash_n_fail.stdout
$ bash -n broken_script.txt
bash -n exit status: 2
$ cat out/ch08/bash_n_fail.stderr
broken_script.txt: line 6: syntax error near unexpected token `}'
broken_script.txt: line 6: `}'
```

退出码 2，错误消息指向第 6 行的 `}`，而不是少了 `fi` 的位置（第 5 行之后），因为 Bash 要读到 `}` 才发现 `if` 没有结束：语法错误的行号是“Bash 终于糊涂的地方”，不是“你写错的地方”。`bash -n` 只管语法：一个根本不存在的命令，它照样放行：

```text
$ bash -n <(printf 'nosuchcommand foo\n'); echo "exit=$?"
exit=0
```

所以它抓住的是括号、`fi`、引号这类低级错，不是逻辑错。真正的排错用 `bash -x`：`set -x` 让 Bash 在执行每条命令之前把它展开后的样子打印到 stderr，前缀是 `PS4`，默认是 `+ `。默认前缀只有一个加号，脚本一长，你不知道这一行来自哪个文件的第几行。`lab/ch08/xtrace_ps4.sh` 把前缀改成 `脚本名:行号:函数名`，并且让 trace 去一个文件而不是 stderr：

```bash
trace="${LAB_TMP}/trace.log"
exec {trace_fd}>"${trace}"
export BASH_XTRACEFD="${trace_fd}"
# 单引号: PS4 在每次输出跟踪行时才展开, 不是赋值的时候。
PS4='+${BASH_SOURCE##*/}:${LINENO}:${FUNCNAME[0]:-main}: '

double() {
  local n="$1"
  echo $((n * 2))
}

set -x
total=0
for n in 1 2 3; do
  total=$((total + $(double "${n}")))
done
set +x
```

```text
total: 12
--- trace.log ---
+xtrace_ps4.sh:17:main: total=0
+xtrace_ps4.sh:18:main: for n in 1 2 3
++xtrace_ps4.sh:19:main: double 1
++xtrace_ps4.sh:12:double: local n=1
++xtrace_ps4.sh:13:double: echo 2
+xtrace_ps4.sh:19:main: total=2
+xtrace_ps4.sh:18:main: for n in 1 2 3
++xtrace_ps4.sh:19:main: double 2
++xtrace_ps4.sh:12:double: local n=2
++xtrace_ps4.sh:13:double: echo 4
+xtrace_ps4.sh:19:main: total=6
+xtrace_ps4.sh:18:main: for n in 1 2 3
++xtrace_ps4.sh:19:main: double 3
++xtrace_ps4.sh:12:double: local n=3
++xtrace_ps4.sh:13:double: echo 6
+xtrace_ps4.sh:19:main: total=12
+xtrace_ps4.sh:21:main: set +x
```

（节选，省掉了头注释；输出一字未改。）三件事要看。第一，`PS4` 用单引号：双引号会让 `${LINENO}` 在赋值那一刻就被展开，之后每一行 trace 的行号都一样。我拿 `PS4="+${LINENO}: "` 配 `set -x` 试了一遍，三条命令 (`a=1`, `b=2`, `set +x`) 打印出来的都是 `+1: `，因为 `PS4` 那一行是第 1 行；单引号保留 `${...}`，Bash 每输出一行 trace 才展开一次。第二，`++` 是嵌套深度：`PS4` 的第一个字符在更深的层级会重复，`$(double "${n}")` 是命令替换，里面的命令在子 shell 里，所以多一个 `+`；`FUNCNAME[0]` 在 `double` 里面就是 `double`。第三，`exec {trace_fd}>"${trace}"` 让 Bash 选一个空闲的文件描述符，`BASH_XTRACEFD` 指向它，trace 因此写进文件，`stdout` 里干干净净只有 `total: 12`，不用把 stderr 和程序的真实 stderr 分开。

同样的 `PS4` 用在 `bin/cairn` 上，能看到它启动时在做什么（前 14 行，`cairn:` 是 `BASH_SOURCE` 去掉目录后的名字）：

```text
$ PS4='+${BASH_SOURCE##*/}:${LINENO}:${FUNCNAME[0]:-main}: ' bash -x bin/cairn --version 2>&1 | head -14
+cairn:8:main: set -o errexit -o nounset -o pipefail
+cairn:10:main: shopt -s inherit_errexit
+cairn:11:main: set -o errtrace
+cairn:13:main: readonly CAIRN_VERSION=0.1.0
+cairn:13:main: CAIRN_VERSION=0.1.0
+cairn:16:main: CAIRN_CONFIG_OPT=
+cairn:19:main: CAIRN_DRY_RUN=0
++cairn:22:main: readlink -f -- bin/cairn
+cairn:22:main: cairn_script=/home/bfmhno3/Projects/cairn/bin/cairn
++cairn:23:main: dirname -- /home/bfmhno3/Projects/cairn/bin/cairn
+cairn:23:main: CAIRN_LIB=/home/bfmhno3/Projects/cairn/bin/../lib/cairn
+cairn:24:main: readonly CAIRN_LIB
+cairn:27:main: source /home/bfmhno3/Projects/cairn/bin/../lib/cairn/log.sh
++log.sh:7:main: CAIRN_QUIET=0
```

第 8 到 11 行是第 7 篇加的三条 `set`/`shopt`；第 22 到 24 行是 `CAIRN_LIB` 的解析 (`readlink -f`, `dirname`)；第 27 行开始 `source` 库，进入 `log.sh` 之后 `BASH_SOURCE` 变了，前缀里的文件名也跟着变。`BASH_XTRACEFD` 还有一个我在下面“覆盖率：kcov”一节才会说的用处：不是只有人在读 trace。

## 覆盖率：kcov

93 个测试到底执行了 `bin/` 和 `lib/` 里的多少行？[kcov](https://github.com/SimonKagstrom/kcov) 回答这个问题，它不修改脚本，而是在脚本运行时记录跑过的行。`Makefile` 里有一个 `coverage` 目标：

```make
coverage:
	kcov --bash-parser="$$(command -v bash)" --include-path=bin,lib out/coverage bats tests
```

最短的写法是 `kcov --include-path=bin,lib out/coverage bats tests`，它在 NixOS 上跑不起来，所以 Makefile 里多了一个选项 `--bash-parser="$$(command -v bash)"`（`$$` 是 make 对 `$` 的转义）。原因是 kcov 默认用 `/bin/bash` 去解析脚本，而 NixOS 没有 `/bin/bash`。我不带这个选项跑一次 (`kcov --include-path=bin,lib /tmp/p8-kc1 bats --jobs 16 tests/report.bats`)：

```text
sh: line 1: /bin/bash: No such file or directory
Failed to execute script: No such file or directory
kcov: error: Can't start/attach to /nix/store/n7r9923x8j54q7fdr3cfp65j0vgb4vqs-bats-with-libraries-1.14.0/bin/bats
```

`sh` 说没有 `/bin/bash`，kcov 因此启动不了 `bats`。（`bats` 脚本自己的 shebang 是 Nix 里的绝对路径，没有问题，出问题的是 kcov 内部拼出来的那条命令。）加上 `--bash-parser="$(command -v bash)"` 之后，`make coverage` 在这台机器上花了 30.3 秒（`time` 的 `real`）。它跑的是串行的 `bats tests`，所以该和 22.3 s 的串行时间比：kcov 多花了 8.0 s。这是它不在 `make ci` 里的原因之一；另一个原因是覆盖率是一个读数，不是通过或失败，没有一个“合格线”可以让 CI 去判定。结果在 `out/coverage/` 里，`index.html` 是网页报告，`bats.<hash>/coverage.json` 是机器可读的汇总：

```text
$ jq -r '.files[] | [.file, .percent_covered, .covered_lines, .total_lines] | @tsv' out/coverage/bats.*/coverage.json | sed 's|.*/cairn/||'
prune.sh	72.88	43	59
manifest.sh	20.45	9	44
repo.sh	51.11	23	45
lock.sh	66.67	4	6
snapshot.sh	68.18	90	132
config.sh	75.76	50	66
log.sh	71.43	10	14
bin/cairn	54.14	72	133
$ jq '[.percent_covered, .covered_lines, .total_lines]' out/coverage/bats.*/coverage.json
[
  "60.32",
  301,
  499
]
```

60.32%，499 行可执行的代码里 301 行被执行过：8 个文件的覆盖行数相加是 `43 + 9 + 23 + 4 + 90 + 50 + 10 + 72 = 301`，总行数相加是 `59 + 44 + 45 + 6 + 132 + 66 + 14 + 133 = 499`，301 ÷ 499 = 60.32%。我在最终的 `ch08` 标签上又跑了一遍 `make coverage` 的那条命令，数字就是这样；`cli.bats` 补上用法消息的断言之后，`bin/cairn` 比之前多了一行，其余文件不变。

60% 这个数字，我愿意先怀疑它，再读它。最低的是 `manifest.sh`，20.45%，44 行里只有 9 行被记为执行过。我从 HTML 报告背后的数据文件（`manifest.sh.<hash>.js`，每行带一个 `lineCov` 或 `lineNoCov` 标记）里把没跑的行列出来：9 行 `lineCov`，35 行 `lineNoCov`，就是 28、33、35、36、51、52、53、55、72 到 78、80 到 82、84 到 86、88 到 90、110 到 115、117 到 119、122 和 125。这 35 行分成两类。第一类是真的没有测试：36、53、125 是 `return 1`，分别是 `manifest::write` 里 `sha256sum` 或 `sort` 中途失败、`count` 找不到清单、`diff` 里 `awk` 或 `sort` 失败的分支，要让它们失败得做手脚，和“没有人写的测试”一节列出的 I/O 失败消息是同一批。第二类是测过但 kcov 没记：72 到 90 行是整个 `verify`，110 到 125 行是 `diff`，`verify_diff.bats` 的 12 个测试每次都会跑它们，78、82、86、115、119 这几个失败分支的错误消息还被逐字断言过。这是覆盖率最有用的读法：不是看总数，而是看没跑的行是谁，再去问它是没有测试，还是没被记下来。

但它也会漏记。`bin/cairn` 第 310 行是 `CAIRN_DRY_RUN=1`，`-n` 选项的处理，`tests/snapshot.bats` 里有一个 `-n shows the name and changes nothing`，它显然执行了这一行（测试断言输出是 `would create <名字>`，没有这一行就不会是）。我在数据文件里查：

```text
$ grep -ho '"lineNum":" *310"[^}]*}' out/coverage/bats.*/cairn.*.js
"lineNum":"  310","line":"        CAIRN_DRY_RUN=1","class":"lineNoCov","hits":"0","possible_hits":"0",}
$ grep -ho '"lineNum":" *116"[^}]*}' out/coverage/bats.*/repo.sh.*.js
"lineNum":"  116","line":"  local -a dirs=()","class":"lineNoCov","hits":"0","possible_hits":"0",}
```

第二行是我刚在“第 7 篇留下的两个错”一节讲的那一行，修复之后那个测试通过，说明它被执行过（不然 `unbound variable` 不会消失），kcov 却说它没跑。所以 60.32% 是一个下限，真实的数字更高，我不知道高多少。我猜是这样：kcov 靠 Bash 的追踪机制记行，被测的代码在子 shell、进程替换和 `run` 启动的新进程里，追踪线路可能没接上；但这只是猜测，我没有查 kcov 的源码。输出目录里留着它用的两个辅助脚本，能看出它的做法和 `PS4` 有关系，下面是 `bash-helper.sh` 和 `bash-helper-debug-trap.sh`：

```text
$ cat out/coverage/bash-helper.sh
#!/bin/sh

# Set PS4, the sh -x prompt.
PS4='kcov@${BASH_SOURCE}@${LINENO}@'

# Turn on tracing
set -x
$ cat out/coverage/bash-helper-debug-trap.sh
#!/bin/sh

set -o functrace
trap 'echo "kcov@${BASH_SOURCE}@${LINENO}@" >&$KCOV_BASH_XTRACEFD' DEBUG
unset BASH_ENV
```

这就是“bash -n、bash -x 与 PS4”一节里 `PS4` 和 `BASH_XTRACEFD` 的另一种用法：不是给人读，是给 kcov 读。它让 Bash 在每一行之前把 `kcov@文件@行号@` 写进一个描述符，kcov 在另一端数。大概这也是覆盖率比普通运行慢的原因：每一行都多一次输出（这一点我没有单独验证）。

## CI

`.github/workflows/ci.yml` 是从我的另一个项目 `typst-lab` 抄来的，只留了一个 job：

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: cachix/install-nix-action@v31
      - run: nix develop --command make ci
```

`diff ~/Projects/typst-lab/.github/workflows/ci.yml .github/workflows/ci.yml` 的输出是 `17,25d16`，也就是 `typst-lab` 那份多出来的 9 行（第二个 `plugin` job，跑 `cargo fmt` 和 `clippy`），这一份没有别的差别。[`on:`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) 这一段说推送到 `main`、对 `main` 的 PR 和手动触发都会运行；[`actions/checkout`](https://github.com/actions/checkout) 取代码；[`cachix/install-nix-action`](https://github.com/cachix/install-nix-action) 在 runner 上装好 Nix；最后一步 `nix develop --command make ci` 进入 `flake.nix` 定义的开发 shell，那里面有 Bash 5.3、ShellCheck、shfmt、bats、kcov、GNU parallel，runner 上的工具链因此和我本地一模一样，这就是为什么 CI 里只需要一个 job 和三行 `steps`。

`make ci` 是 `lint chapters test`，不包含 `coverage`：

```make
ci: lint chapters test
```

有一个细节：[GitHub 的 runner 会设 `CI=true`](https://docs.github.com/en/actions/reference/workflows-and-actions/variables#default-environment-variables)，而 `scripts/chapter.sh` 看到 `CI=true` 会跳过名字以 `_host.sh` 结尾的实验（第 1 篇的约定：依赖宿主机能力的实验，比如这一篇的 `systemd_verify_host.sh`，在 CI 里没有 systemd 可用）。我在这台机器上完整跑了一遍 `make ci`（我的 shell 恰好已经导出了 `CI=true`），整套花了 3 分 42 秒（`time` 的 `real`），输出的最后几行是：

```text
bash scripts/chapter.sh ch08
ok   lab/ch08/bash_n_fail.sh
ok   lab/ch08/bats_tap.sh
ok   lab/ch08/ex_init_test.sh
ok   lab/ch08/shellcheck_demo_fail.sh
ok   lab/ch08/shfmt_demo.sh
skip lab/ch08/systemd_verify_host.sh (host only)
ok   lab/ch08/xtrace_ps4.sh
bats --jobs "$(nproc)" tests
1..93
ok 1 --version prints the version
```

（`ok 1` 之后是 92 行类似的输出，我只留了开头。）整份输出里，实验有 96 行 `ok` 和 2 行 `skip`（`ch01` 的 `fork_exec_host.sh` 和这一篇的 `systemd_verify_host.sh`），测试有 93 行 `ok` 和 0 行 `not ok`。需要说明的是：我没有在 GitHub Actions 上运行过这份工作流，标签推送之前这个仓库没有它的运行记录，我验证的是它调用的那个 `make ci`，不是 Actions 本身。

## 定时运行：systemd 用户定时器

备份要靠定时运行才有意义。Linux 上有两种常见的办法：cron，或者 systemd 的定时器。我没有在这台机器上装 cron，所以关于 cron 我只说我知道的：它按时间表启动一个命令，关机错过的那次就错过了（据我所知，补跑要靠 anacron 这样的另一个程序）。systemd 用两个单元表达同一件事：服务单元说做什么，定时器单元说什么时候做，两者同名（`cairn.service` 和 `cairn.timer`）就自动配对。定时器多出来的好处里，有一条是我从手册里核实过的：`Persistent=true` 会补跑停机期间错过的那一次（下面细说）；代价是它只存在于用 systemd 的系统上。

`contrib/systemd/cairn.service`：

```ini
[Unit]
Description=Cairn snapshot and prune

[Service]
Type=oneshot
ExecStart=%h/.local/bin/cairn snapshot
ExecStart=%h/.local/bin/cairn prune
```

`contrib/systemd/cairn.timer`：

```ini
[Unit]
Description=Run cairn daily

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=15min

[Install]
WantedBy=timers.target
```

逐个字段看。`%h` 是 systemd 的说明符，展开成运行这个用户单元的用户的家目录。`Type=oneshot` 加两行 `ExecStart=`：[手册](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#ExecStart=)说只有 `oneshot` 允许写多个 `ExecStart=`，它们一个接一个地执行，其中一个失败（不带 `-` 前缀的话），后面的就不执行，整个单元算失败。这正是我要的：`snapshot` 失败了就不该接着 `prune`，不然一个坏掉的备份会反过来吃掉好的旧快照。`OnCalendar=daily`，[手册](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html#OnCalendar=)里的日历表达式，我让 systemd 自己翻译成规范形式：

```text
$ systemd-analyze calendar daily | grep -E '^ *(Original form|Normalized form)'
  Original form: daily
Normalized form: *-*-* 00:00:00
```

每天零点。[`Persistent=true`](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html#Persistent=)：手册说它把服务上次触发的时间存在磁盘上，定时器启动时如果在停机期间错过了一次，就立刻触发，用来补上关机时错过的运行；[`RandomizedDelaySec=15min`](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html#RandomizedDelaySec=) 在每次触发时间上随机加 0 到 15 分钟，让很多机器不在同一秒钟去敲同一个备份服务器（Cairn 是单机工具，我加它主要是示范这个旋钮）。`WantedBy=timers.target` 让 `enable` 把定时器挂到开机目标上。

单元写对了吗？我只在宿主机上运行 `systemd-analyze`，不真的启用它（启用会改动你的用户会话，这个实验不该替你做）。`lab/ch08/systemd_verify_host.sh` 是这样的：

```bash
units="${LAB_TMP}/units"
mkdir "${units}" || exit 1
for unit in cairn.service cairn.timer; do
  sed "s|%h/.local/bin/cairn|${CAIRN_ROOT}/bin/cairn|" \
    "${CAIRN_ROOT}/contrib/systemd/${unit}" >"${units}/${unit}" || exit 1
done
echo '$ systemd-analyze --user verify cairn.service cairn.timer'
(cd "${units}" && systemd-analyze --user verify cairn.service cairn.timer)
status=$?
echo "verify exit status: ${status}"
echo '$ systemd-analyze calendar daily'
systemd-analyze calendar daily | grep -E '^ *(Original form|Normalized form)'
exit "${status}"
```

它先把单元复制到沙箱里，用 `sed` 把 `%h/.local/bin/cairn` 换成这个检出里的 `bin/cairn`，因为真正的路径要等第 10 篇的安装脚本才存在。不换的话 `verify` 会抱怨：

```text
$ systemd-analyze --user verify contrib/systemd/cairn.service contrib/systemd/cairn.timer
cairn.service: Command /home/bfmhno3/.local/bin/cairn is not executable: No such file or directory
cairn.service: Command /home/bfmhno3/.local/bin/cairn is not executable: No such file or directory
$ echo $?
1
```

这是一个有用的失败：`verify` 不光检查语法，还会检查 `ExecStart` 指向的程序是否可执行。同一行出现了两次，我猜是因为 `ExecStart=` 有两个。换成真实存在的路径之后，`CI= make ch08` 里这个实验是：

```text
$ cat out/ch08/systemd_verify_host.stdout
$ systemd-analyze --user verify cairn.service cairn.timer
verify exit status: 0
$ systemd-analyze calendar daily
  Original form: daily
Normalized form: *-*-* 00:00:00
```

`verify` 没有输出，退出码 0，就是通过。真正启用它（我没有运行，也不会替你运行）是这样的：先把两个单元放到 systemd 找用户单元的目录，再让 systemd 重新读取，最后启用并立刻启动定时器：

```bash
mkdir -p ~/.config/systemd/user
cp contrib/systemd/cairn.service contrib/systemd/cairn.timer \
  ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cairn.timer
```

`~/.config/systemd/user/` 在[手册列出的用户单元查找路径](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html)里。还有一件事：用户单元由用户的 systemd 管理器运行，登出之后这个管理器默认不一定还在；[`loginctl enable-linger`](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html) 按手册的说法，会让用户管理器在开机时启动、登出后继续存在，这样没登录的时候定时器也能触发。

## 检查点

先把参考仓库更新到带 `ch08` 标签的状态：

```bash
git -C ~/cairn-ref fetch --tags
```

在 `~/cairn` 下：

```bash
make ch08
make test
make -s lint
```

`make ch08` 在装了 systemd 的机器上应当打印这 8 行（整套大约 6 秒）：

```text
bash scripts/chapter.sh ch08
ok   lab/ch08/bash_n_fail.sh
ok   lab/ch08/bats_tap.sh
ok   lab/ch08/ex_init_test.sh
ok   lab/ch08/shellcheck_demo_fail.sh
ok   lab/ch08/shfmt_demo.sh
ok   lab/ch08/systemd_verify_host.sh
ok   lab/ch08/xtrace_ps4.sh
```

设了 `CI=true`（GitHub 的 runner 就是这样）时 `systemd_verify_host.sh` 那一行变成 `skip lab/ch08/systemd_verify_host.sh (host only)`，其余不变。两个 `_fail` 实验（`bash_n_fail.sh` 退出码 2，`shellcheck_demo_fail.sh` 退出码 1）以非 0 结束，运行器要求 `_fail.sh` 必须非 0，所以它们是 `ok`。

`make test` 应当打印 `1..93` 这一行，然后 93 行 `ok`，没有 `not ok`，退出码 0（我的输出里 `grep -c '^ok'` 是 93，`grep -c '^not ok'` 是 0），在我这台 16 线程的机器上约 6 秒。`make -s lint` 什么都不输出：

```text
$ make -s lint; echo "lint exit $?"
lint exit 0
```

**必须和标签一致的文件**（仓库保留的就是这一版，每个都用 `diff` 对照）：`tests/` 下的 8 个文件、`.github/workflows/ci.yml`、`contrib/systemd/` 下的两个单元、`lab/ch08/` 下的 7 个脚本和 4 个夹具，以及 `lib/cairn/prune.sh` 和 `lib/cairn/repo.sh`，一共 24 个。

```text
$ for f in tests/*.bats tests/test_helper.bash .github/workflows/ci.yml \
  contrib/systemd/*.service contrib/systemd/*.timer lab/ch08/*.sh \
  lab/ch08/fixtures/* lib/cairn/prune.sh lib/cairn/repo.sh; do
  if diff <(git -C ~/cairn-ref show ch08:"${f}") "${f}" >/dev/null; then
    printf 'same %s\n' "${f}"
  else
    printf 'DIFF %s\n' "${f}"
  fi
done | cut -d' ' -f1 | sort | uniq -c
     24 same
```

应当打印 `24 same`（我是在参考仓库自己里对着标签跑的，没有一行是 `DIFF`）。`diff` 不比较权限位，标签里有可执行位的文件是这四个，`tests/` 下的文件都不可执行：

```text
$ git -C ~/cairn-ref ls-tree -r ch08 | grep ^100755 | cut -f2
bin/cairn
lab/ch01/shebang_exec.sh
scripts/chapter.sh
scripts/make_tree.sh
```

仓库现在有 134 个被跟踪的文件，和上一个标签相比 22 个新增、4 个修改：

```text
$ git -C ~/cairn-ref ls-files | wc -l
134
$ git -C ~/cairn-ref diff --name-status ch07 ch08 | cut -c1 | sort | uniq -c
     22 A
      4 M
```

**中间版本（后面的章节会继续改）：**

- [`Makefile`](https://github.com/bfmhno3/cairn/blob/ch08/Makefile)：现在有 `test`、`coverage`，`ci` 是 `lint chapters test`；第 10 篇会加 `install`，`lint` 也会多检查一个脚本。
- [`README.md`](https://github.com/bfmhno3/cairn/blob/ch08/README.md)：目录布局和命令列表已经包含 `tests/`、`contrib/systemd/`、`make test`、`make coverage`；以后的篇章还会加内容。

### 文件清单

这一篇新增或修改的 26 个文件 (`git diff --name-only ch07 ch08`) 都在这里，其中 22 个是新增，链接指向标签 `ch08` 上的那一份。实验需要沙箱目录和 `CAIRN_ROOT`，所以命令都是 `make ch08`。结果列是我在 Bash 5.3.15 下实际跑出来的；计时每次会不同。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`.github/workflows/ci.yml`](https://github.com/bfmhno3/cairn/blob/ch08/.github/workflows/ci.yml) | `-` | 16 行，只有一个 job，运行 `nix develop --command make ci`；本地跑 `make ci` 共 3 分 42 秒，96 个实验 `ok`、2 个 `skip`，93 个测试 `ok` |
| [`Makefile`](https://github.com/bfmhno3/cairn/blob/ch08/Makefile) | `make test`、`make -s lint` | `make test` 93 个 `ok`；`make -s lint` 无输出，退出码 0 |
| [`README.md`](https://github.com/bfmhno3/cairn/blob/ch08/README.md) | `-` | 目录布局多了 `tests/` 和 `contrib/systemd/` 两行，命令列表多了 `make test` 和 `make coverage` |
| [`contrib/systemd/cairn.service`](https://github.com/bfmhno3/cairn/blob/ch08/contrib/systemd/cairn.service) | `make ch08` | 7 行；`systemd-analyze --user verify` 对 `ExecStart` 指向 `bin/cairn` 的副本无输出，退出码 0 |
| [`contrib/systemd/cairn.timer`](https://github.com/bfmhno3/cairn/blob/ch08/contrib/systemd/cairn.timer) | `make ch08` | 10 行；`OnCalendar=daily` 规范形式 `*-*-* 00:00:00` |
| [`lab/ch08/bash_n_fail.sh`](https://github.com/bfmhno3/cairn/blob/ch08/lab/ch08/bash_n_fail.sh) | `make ch08` | 退出码 2(`_fail`)；`line 6: syntax error near unexpected token` |
| [`lab/ch08/bats_tap.sh`](https://github.com/bfmhno3/cairn/blob/ch08/lab/ch08/bats_tap.sh) | `make ch08` | 退出码 0；`1..14` 这一行，14 个 `ok`，0 个 `not ok` |
| [`lab/ch08/ex_init_test.sh`](https://github.com/bfmhno3/cairn/blob/ch08/lab/ch08/ex_init_test.sh) | `make ch08` | 退出码 0；`1..2`，两个测试 `ok`，练习 1 |
| [`lab/ch08/fixtures/bad_script.txt`](https://github.com/bfmhno3/cairn/blob/ch08/lab/ch08/fixtures/bad_script.txt) | `-` | 被 `shellcheck_demo_fail.sh` 读取；11 行，6 条发现 |
| [`lab/ch08/fixtures/broken_script.txt`](https://github.com/bfmhno3/cairn/blob/ch08/lab/ch08/fixtures/broken_script.txt) | `-` | 被 `bash_n_fail.sh` 读取；7 行，少一个 `fi` |
| [`lab/ch08/fixtures/ex_init.bats.txt`](https://github.com/bfmhno3/cairn/blob/ch08/lab/ch08/fixtures/ex_init.bats.txt) | `-` | 被 `ex_init_test.sh` 复制成 `.bats` 运行；30 行，2 个测试 |
| [`lab/ch08/fixtures/ugly_script.txt`](https://github.com/bfmhno3/cairn/blob/ch08/lab/ch08/fixtures/ugly_script.txt) | `-` | 被 `shfmt_demo.sh` 读取；18 行，`shfmt -d` 退出码 1，格式化两次后第二遍 0 |
| [`lab/ch08/shellcheck_demo_fail.sh`](https://github.com/bfmhno3/cairn/blob/ch08/lab/ch08/shellcheck_demo_fail.sh) | `make ch08` | 退出码 1(`_fail`)；`findings: 6` |
| [`lab/ch08/shfmt_demo.sh`](https://github.com/bfmhno3/cairn/blob/ch08/lab/ch08/shfmt_demo.sh) | `make ch08` | 退出码 0；`shfmt -d exit status: 1`，`second pass exit status: 0` |
| [`lab/ch08/systemd_verify_host.sh`](https://github.com/bfmhno3/cairn/blob/ch08/lab/ch08/systemd_verify_host.sh) | `CI= make ch08` | 退出码 0（只在宿主机上跑，`CI=true` 时 `skip`）；`verify exit status: 0` |
| [`lab/ch08/xtrace_ps4.sh`](https://github.com/bfmhno3/cairn/blob/ch08/lab/ch08/xtrace_ps4.sh) | `make ch08` | 退出码 0；`total: 12`，`trace.log` 17 行 |
| [`lib/cairn/prune.sh`](https://github.com/bfmhno3/cairn/blob/ch08/lib/cairn/prune.sh) | `cairn prune` | 被 `bin/cairn` 引用；每删一个快照，日志多一行 `INFO prune removed=<名字>` |
| [`lib/cairn/repo.sh`](https://github.com/bfmhno3/cairn/blob/ch08/lib/cairn/repo.sh) | `cairn list` | 被 `bin/cairn` 引用；空仓库上 `list` 的 stderr 是空的 |
| [`tests/cli.bats`](https://github.com/bfmhno3/cairn/blob/ch08/tests/cli.bats) | `bats tests/cli.bats` | 16 个 `ok` |
| [`tests/config.bats`](https://github.com/bfmhno3/cairn/blob/ch08/tests/config.bats) | `bats tests/config.bats` | 14 个 `ok` |
| [`tests/lock_signal.bats`](https://github.com/bfmhno3/cairn/blob/ch08/tests/lock_signal.bats) | `bats tests/lock_signal.bats` | 12 个 `ok`，其中 5 个测试要 0.6 s 以上 |
| [`tests/prune.bats`](https://github.com/bfmhno3/cairn/blob/ch08/tests/prune.bats) | `bats tests/prune.bats` | 14 个 `ok` |
| [`tests/report.bats`](https://github.com/bfmhno3/cairn/blob/ch08/tests/report.bats) | `bats tests/report.bats` | 5 个 `ok` |
| [`tests/snapshot.bats`](https://github.com/bfmhno3/cairn/blob/ch08/tests/snapshot.bats) | `bats tests/snapshot.bats` | 20 个 `ok` |
| [`tests/test_helper.bash`](https://github.com/bfmhno3/cairn/blob/ch08/tests/test_helper.bash) | `-` | 被 7 个 `.bats` 文件 `load`；83 行 |
| [`tests/verify_diff.bats`](https://github.com/bfmhno3/cairn/blob/ch08/tests/verify_diff.bats) | `bats tests/verify_diff.bats` | 12 个 `ok` |

## 练习

**1.** 给 `cairn init` 的幂等性写一个 bats 测试：对同一个目录运行两次，第二次要报告“已经是仓库”，并且不改动配置文件，也不动仓库里已有的文件。

<details>
<summary>参考答案</summary>

我的答案是 [`lab/ch08/ex_init_test.sh`](https://github.com/bfmhno3/cairn/blob/ch08/lab/ch08/ex_init_test.sh)，它把 [`fixtures/ex_init.bats.txt`](https://github.com/bfmhno3/cairn/blob/ch08/lab/ch08/fixtures/ex_init.bats.txt) 复制成 `.bats` 再运行。测试本身：

```bash
load "${CAIRN_ROOT}/tests/test_helper"

@test "init twice: the second run reports and changes nothing" {
  local dir="${BATS_TEST_TMPDIR}/again"
  run "${CAIRN}" init "${dir}"
  assert_success
  # 在仓库里放一个标记文件, 再记下配置和标记文件的状态。
  touch "${dir}/snapshots/marker"
  local config_before marker_before
  config_before="$(sha256sum <"${CAIRN_CONFIG}")"
  marker_before="$(stat -c '%i %Y' "${dir}/snapshots/marker")"

  run "${CAIRN}" init "${dir}"
  assert_success
  assert_output "cairn: ${dir} is already a cairn repository"
  assert_file_exist "${dir}/snapshots/marker"
  assert_equal "$(stat -c '%i %Y' "${dir}/snapshots/marker")" \
    "${marker_before}"
  assert_equal "$(sha256sum <"${CAIRN_CONFIG}")" "${config_before}"
  assert_equal "$(<"${dir}/cairn.repo")" 'cairn-repo 1'
}

@test "init -q stays silent when the repository already exists" {
  run "${CAIRN}" -q init "${REPO}"
  assert_success
  assert_output ''
}
```

真实输出：

```text
$ cat out/ch08/ex_init_test.stdout
$ bats --tap ex_init.bats
1..2
ok 1 init twice: the second run reports and changes nothing
ok 2 init -q stays silent when the repository already exists
bats exit status: 0
```

标记文件的 inode 和修改时间一起比较，是为了发现“重新创建了一个同名文件”这类改动，只看文件存在发现不了。

</details>

**2.** 第 4 篇披露过：`prune` 遇到名字不是时间戳的快照目录时，`select` 的失败被进程替换吞掉。写一个测试钉住“`prune` 必须失败”。它应当现在就是红的。

<details>
<summary>参考答案</summary>

放在 `tests/prune_hole.bats`（我在一份 `ch08` 的干净检出里试的，没有放进仓库）：

```bash
#!/usr/bin/env bats
# Pins a known hole: prune must not report success when it cannot
# understand a snapshot name. Fails until the hole is fixed.

load test_helper

@test "prune fails when a snapshot name is not a timestamp" {
  mkdir "${REPO}/snapshots/not-a-timestamp"
  run "${CAIRN}" prune
  assert_failure
}
```

```text
$ bats tests/prune_hole.bats
1..1
not ok 1 prune fails when a snapshot name is not a timestamp
# (from function `assert_failure' in file ..., line 66,
#  in test file tests/prune_hole.bats, line 10)
#   `assert_failure' failed
#
# -- command succeeded, but it was expected to fail --
# output : date: invalid date ‘not-a-ti es:ta:mp’
# --
```

这个测试有 `shellcheck` 和 `shfmt -i 2 -bn -ci -d` 都干净。它现在是红的，修好 `prune::run`（让 `readarray` 之后检查 `select` 的状态，或者不用进程替换）之后会变绿；到那时它就不再是“已知的洞”，是一个普通的测试。

</details>

**3.** 写一个测试，证明 `cairn snapshot` 收到 SIGHUP 之后，没有 rsync 还握着仓库的锁。它应当现在就是红的。

<details>
<summary>参考答案</summary>

放在 `tests/hup.bats`（同样没有放进仓库）：

```bash
#!/usr/bin/env bats
# Pins a known hole: after SIGHUP no rsync may keep the repository lock.
# Fails until cairn traps HUP.

load test_helper

@test "SIGHUP: no rsync keeps the repository lock" {
  local big="${BATS_TEST_TMPDIR}/big"
  bash "${CAIRN_ROOT}/scripts/make_tree.sh" "${big}" --big 8
  printf 'repo = %s\nsource = %s\n' "${REPO}" "${big}" >"${CAIRN_CONFIG}"
  CAIRN_BWLIMIT=256 CAIRN_NOW=20261031T090000Z \
    env --default-signal=INT "${CAIRN}" snapshot >/dev/null 2>&1 &
  local pid=$!
  until compgen -G "${REPO}/snapshots/*.partial" >/dev/null; do
    sleep 0.05
  done
  kill -HUP "${pid}"
  local status=0
  wait "${pid}" || status=$?
  assert_equal "${status}" 129
  sleep 1
  run flock -n "${REPO}/.lock" true
  pkill -KILL -f "rsync .*${BATS_TEST_TMPDIR}" || :
  assert_success
}
```

```text
not ok 2 SIGHUP: no rsync keeps the repository lock
# (from function `assert_success' in file ..., line 42,
#  in test file tests/hup.bats, line 24)
#   `assert_success' failed
# /tmp/cairn-ex/tests/hup.bats: line 19: 2961852 Hangup   ...
#
# -- command failed --
# status : 1
# output :
# --
```

`assert_equal "${status}" 129` 通过了（`cairn` 确实以 129 退出），红的是最后一行：`flock -n` 拿不到锁，因为孤儿 rsync 还握着继承来的描述符。这里的 `sleep 1` 是故意的，它只用在一个“证明洞存在”的测试里；修好之后，这一行该换成上文的 `wait_for_free_lock` 轮询。`pkill` 放在 `assert_success` 前面，保证测试失败时也不留下孤儿进程。

</details>

**4.** `cmd_list` 在 `du` 失败时应当打印 `cannot compute the snapshot sizes` 并以 1 退出，测试里没有这条。不要去改 `du`，写出这个测试。

<details>
<summary>参考答案</summary>

办法和“假的 rsync”一样，在 `PATH` 前面放一个总是失败的 `du`：

```bash
#!/usr/bin/env bats

load test_helper

@test "list: a failing du is reported, exit 1" {
  make_snapshots 20261031T090000Z
  local stub="${BATS_TEST_TMPDIR}/stub"
  mkdir "${stub}"
  printf '#!/usr/bin/env bash\nexit 1\n' >"${stub}/du"
  chmod +x "${stub}/du"
  PATH="${stub}:${PATH}" run --separate-stderr "${CAIRN}" list
  assert_failure 1
  assert_regex "${stderr}" 'cairn: error: cannot compute the snapshot sizes$'
}
```

我把它放在 `tests/list_du.bats` 里跑过：`ok 1 list: a failing du is reported, exit 1`。先做快照、再放假 `du`，这样只有 `list` 这一次调用看得到它。

</details>

**5.** 把定时器改成“工作日凌晨 2:30”，用 `systemd-analyze` 检查表达式，并说明为什么检查这一步不需要启用任何单元。

<details>
<summary>参考答案</summary>

把 `OnCalendar=daily` 换成 `OnCalendar=Mon..Fri *-*-* 02:30:00`。检查：

```text
$ systemd-analyze calendar 'Mon..Fri *-*-* 02:30:00' --iterations=2
Normalized form: Mon..Fri *-*-* 02:30:00
    Next elapse: Mon 2026-11-02 02:30:00 PST
       (in UTC): Mon 2026-11-02 10:30:00 UTC
       From now: 20h left
   Iteration #2: Tue 2026-11-03 02:30:00 PST
       (in UTC): Tue 2026-11-03 10:30:00 UTC
       From now: 1 day 20h left
```

`calendar` 子命令只解析表达式、计算接下来几次触发的时间，不读也不改任何单元文件，所以不需要启用任何东西。`--iterations=2` 让它多算一次，周五之后应当跳到周一，你可以把 `--iterations` 加大到 6 看看。

</details>

## 下一篇

下一篇是第 9 篇，交互式 bash：启动文件、提示符、作业控制与补全。到这里 Cairn 已经有了测试、检查和定时器，但它还不能被敲出来：补全没有，你每次都得整个单词打完。我猜最有意思的不是 `complete -F` 怎么写，而是 `.bashrc`、`.bash_profile`、`.profile` 究竟哪一个会在你的终端里跑，以及我这台 NixOS 上的真实答案。

