---
title: "我终于学会了 grep，然后换成了 ripgrep"
published: "2026-08-31 15:00:00 +08:00"
description: "我一直在复制 grep 命令，却没有真正理解它。这次我从单个日志文件开始，弄清模式、正则、管道和退出状态，再把同一套搜索迁移到更适合代码仓库的 ripgrep，并做了一次 126 MiB 的实测。"
category: Tutorial
tags:
  - Linux
  - CLI
  - grep
  - ripgrep
  - Development
draft: false
comment: true
slug: grep-ripgrep-search-guide
series: "Linux 命令行实验室"
seriesOrder: 1
---

我每天都能看到 `grep`：查日志时有它，读脚本时有它，甚至 AI 给出的命令里也经常有它。但我对它的理解长期停留在 "把一段神秘字符粘到管道后面"。这多少有点尴尬，所以我建了一个很小的实验目录，从一份 5 行日志开始，最后又让 `grep` 和 `ripgrep` 扫了 4096 个文件。搜索工具嘛，最好还是搜点东西再谈。

`grep` 的名字来自早期 Unix 编辑器 `ed` 中的命令 `g/re/p`，大意是全局寻找正则表达式并打印匹配行。名字已经半个世纪了，但它今天仍然在做同一件事：**读取文本，寻找匹配模式，输出匹配的行。** 它像一把文本世界里的筛子，标准输入或文件从上面倒进去，符合模式的行从下面落出来。这个比喻到这里就够了，后面我们直接看命令。

## 先做一份可以搜索的日志

我创建了一个 `app.log`：

```text
INFO boot
WARN cache slow
ERROR database timeout
INFO retry
ERROR recovered
```

最小的 `grep` 由模式和文件组成：

```bash
$ grep 'ERROR' app.log
ERROR database timeout
ERROR recovered
```

它的通用形状是：

```bash
grep [选项] '模式' [文件...]
```

我现在会默认用单引号包住模式。不是 `grep` 强制要求，而是 shell 也认识 `*`、`$`、`[` 等字符。加引号等于先告诉 shell "这段别碰，完整交给 grep"，可以少掉一类很无聊的错误。

## grep 到底匹配什么

`grep` 默认按**行**工作。只要模式匹配一行中的任意部分，它就输出整行，而不是只输出命中的几个字符。根据 [POSIX grep 规范](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/grep.html)，默认模式是基本正则表达式，也就是 BRE (Basic Regular Expression)。

先看几个我最常用的模式：

```bash
# 以 ERROR 开头
$ grep '^ERROR' app.log
ERROR database timeout
ERROR recovered

# 以 timeout 结尾
$ grep 'timeout$' app.log
ERROR database timeout

# 匹配 WARN 或 ERROR，-E 启用扩展正则表达式
$ grep -E 'WARN|ERROR' app.log
WARN cache slow
ERROR database timeout
ERROR recovered
```

`^` 锚定行首，`$` 锚定行尾，`|` 表示二选一。这里最容易踩的坑是：默认 BRE 和 `grep -E` 使用的 ERE (Extended Regular Expression) 语法并不完全一样。我如果需要 `|`、`+`、`?` 或分组，通常直接写 `grep -E`，而不是开始和反斜杠进行某种古老仪式。

如果我根本不需要正则表达式，只想搜索字面文本，就用 `-F`：

```bash
$ grep -F 'ERROR database' app.log
ERROR database timeout
```

这在搜索包含 `.`、`[`、`*` 的配置或代码时尤其省心。`-F` 的意思不是 "更弱的 grep"，而是 "不要解释特殊字符"。

## 我真正会记住的选项

`grep --help` 很长，但日常使用不需要背完整本手册。下面这组已经覆盖了我大部分需求：

| 选项 | 作用 | 示例 |
| --- | --- | --- |
| `-n` | 显示行号 | `grep -n 'ERROR' app.log` |
| `-i` | 忽略大小写 | `grep -i 'error' app.log` |
| `-v` | 反选不匹配的行 | `grep -v '^INFO' app.log` |
| `-c` | 统计匹配行数 | `grep -c 'ERROR' app.log` |
| `-l` | 只输出包含匹配的文件名 | `grep -l 'ERROR' *.log` |
| `-w` | 匹配完整单词 | `grep -w 'ERROR' app.log` |
| `-x` | 匹配完整一行 | `grep -x 'INFO retry' app.log` |
| `-A 2` | 输出命中行及后 2 行 | `grep -A 2 'timeout' app.log` |
| `-B 2` | 输出命中行及前 2 行 | `grep -B 2 'timeout' app.log` |
| `-C 2` | 输出命中行前后各 2 行 | `grep -C 2 'timeout' app.log` |
| `-E` | 使用扩展正则表达式 | `grep -E 'WARN|ERROR' app.log` |
| `-F` | 按字面字符串匹配 | `grep -F 'a[b]' file.txt` |

例如带上行号后，我的 5 行日志给出：

```bash
$ grep -n -E 'WARN|ERROR' app.log
2:WARN cache slow
3:ERROR database timeout
5:ERROR recovered
```

统计也确实是 2 行：

```bash
$ grep -c 'ERROR' app.log
2
```

注意，`-c` 统计的是**匹配行数**，不是一行内出现了多少次模式。这个区别在脚本里很容易偷偷制造 bug。

## grep 为什么总出现在管道里

如果没有文件参数，`grep` 就从标准输入读取。于是任何能输出文本的命令都能接到它前面：

```bash
# 查找进程列表中的 ssh
ps aux | grep '[s]sh'

# 只保留日志中的错误
journalctl -u nginx | grep -i 'error'

# 在命令输出中寻找某个配置项
some-command --verbose | grep -F 'cache_dir='
```

第一条里的 `[s]sh` 是个老而实用的小技巧：它能匹配 `ssh`，但 `grep` 自己的命令行中出现的是 `[s]sh`，因此不会把自己也匹配出来。不过，如果系统提供 `pgrep`，按进程名或属性找进程通常更直接。能用结构化工具时，不必强迫文本筛子兼职数据库。

`grep` 还通过退出状态告诉脚本发生了什么：

- `0`：至少匹配到一行。
- `1`：没有匹配。
- 大于 `1`：发生错误。

所以检查是否存在时，我会使用 `-q`，而不是先输出再扔掉：

```bash
if grep -q 'ERROR' app.log; then
    echo 'found an error'
fi
```

"没有匹配" 是正常结果，不是工具坏了。理解这 3 种状态后，`grep` 才真正从交互命令变成了可靠的脚本部件。

## 从单个文件走进整个目录

GNU grep 和很多现代实现支持递归搜索：

```bash
grep -R -n --include='*.ts' --exclude-dir=node_modules 'TODO' src
```

这里 `-R` 递归遍历目录，`--include` 只保留 TypeScript 文件，`--exclude-dir` 排除依赖目录。它能工作，但我必须逐项告诉 `grep` 什么值得搜索。项目一大，命令就开始长出越来越多的过滤条件。

这也是我开始理解 `ripgrep` 的位置。它并不是发明了另一种 "找字符串" 的方式，而是把**递归搜索代码仓库**设成了默认场景。

> [!NOTE]
> `grep` 存在 POSIX、GNU、BSD 以及其他实现，不同系统的扩展选项可能不同。`-E`、`-F`、`-i`、`-n`、`-q`、`-v` 等核心选项有 POSIX 定义；`-R`、`--include` 这样的能力应以本机 `man grep` 或 `grep --help` 为准。写可移植脚本时，我不会假设所有机器都运行 GNU grep。

## ripgrep：把代码仓库当成默认环境

`ripgrep` 的可执行文件名是 `rg`。它同样逐行搜索模式，但直接递归搜索当前目录：

```bash
# grep 需要显式递归和目录
grep -R -n 'TODO' .

# rg 默认递归搜索当前目录
rg 'TODO'
```

在 Ubuntu 或 Debian、Fedora、Arch Linux 和 macOS 上，可以分别安装：

```bash
sudo apt install ripgrep
sudo dnf install ripgrep
sudo pacman -S ripgrep
brew install ripgrep
```

Windows 可以使用 Scoop：

```powershell
scoop install ripgrep
```

安装后先确认实际版本：

```bash
rg --version
```

`rg` 最重要的特性可能不是速度，而是它默认不搜索什么。根据 [ripgrep 官方指南](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md#automatic-filtering)，它默认跳过：

- `.gitignore`、`.ignore` 和 `.rgignore` 排除的路径。
- 隐藏文件和隐藏目录。
- 检测到的二进制文件。
- 符号链接指向的内容。

我在一个 Git 仓库里做了 3 文件的小实验：`visible.txt`、被 `.gitignore` 排除的 `ignored.log`，以及隐藏文件 `.hidden.txt`。三个文件都只有一行 `SECRET`。为了不让 `grep` 顺手钻进 `.git`，我显式排除了它：

```bash
$ grep -R -n --exclude-dir=.git 'SECRET' .
./.hidden.txt:1:SECRET hidden
./visible.txt:1:SECRET visible
./ignored.log:1:SECRET ignored

$ rg -n 'SECRET' .
./visible.txt:1:SECRET visible
```

同一个目录里，`grep` 找到 3 行，`rg` 默认只给我 1 行。`rg` 不是漏搜了，它执行了更适合代码仓库的过滤策略。

需要掀开过滤器时，也有明确的开关：

```bash
# 搜索被 ignore 规则排除的路径
rg --no-ignore 'SECRET'

# 同时搜索隐藏文件
rg --hidden --no-ignore 'SECRET'

# -u 逐级解除限制：-u 忽略 ignore，-uu 包含隐藏文件，-uuu 还包含二进制文件
rg -uuu 'SECRET'
```

`-uuu` 很好记，但我不会把它设成默认别名。二进制内容可能把控制字符直接送进终端，而且 `node_modules`、构建产物和 `.git` 往往正是噪声的主要来源。只有当 "我明明知道它在这里" 时，我才逐级加 `u`。

## rg 中最顺手的几种搜索

多数 `grep` 习惯可以直接迁移：

```bash
rg -i 'error'                 # 忽略大小写
rg -F 'array[index]'          # 字面字符串
rg -w 'Result'                # 完整单词
rg -C 3 'panic'               # 前后各 3 行上下文
rg -l 'TODO|FIXME'            # 只列出文件名
rg -c 'TODO'                  # 按文件统计匹配行数
rg -q 'needle' path/to/file   # 静默检查，依靠退出状态
```

针对仓库筛选文件时，glob 比一长串目录参数更舒服：

```bash
rg 'fetchData' -g '*.ts' -g '*.tsx'
rg 'password' -g '!dist/**' -g '!*.min.js'
```

`-g` 可以重复使用，前面的 `!` 表示排除。记得给 glob 加单引号，否则 shell 可能在 `rg` 看到它之前就先展开。

`rg` 还内置文件类型：

```bash
rg -tpy 'def main'       # 只搜索 Python
rg -tts 'fetchData'      # 只搜索 TypeScript
rg -Tjs 'TODO'           # 排除 JavaScript
rg --type-list           # 查看当前支持的类型
```

这里的文件类型本质上是一组扩展名和 glob，不是在做语法分析。如果我需要寻找真正的函数调用、声明或引用，AST 或语言服务器才是对的工具。正则表达式看起来像一把锤子，而代码仓库里碰巧到处都是长得像钉子的字符串，仅此而已。

## 两套正则表达式并不完全相同

`grep` 默认使用 BRE，`grep -E` 使用 ERE。`rg` 默认使用 Rust 的 regex 引擎，支持 Unicode，并保证线性时间搜索，但默认不支持反向引用和 look-around。简单的搜索通常可以直接对应：

```bash
grep -E 'WARN|ERROR' app.log
rg 'WARN|ERROR' app.log
```

如果确实需要 look-around 或反向引用，并且当前 `rg` 构建包含 PCRE2，可以使用 `-P`：

```bash
rg -P 'ERROR(?= database)' app.log
```

我不会因为 PCRE2 更 "强" 就默认打开它。大多数代码搜索只需要字面量、字符类、分支和重复；默认引擎更可预测，也更不容易写出性能悬崖。复杂正则如果已经需要一杯咖啡才能读懂，通常也到了该换脚本或结构化工具的时候。

## 我测了一次速度，但不准备宣布宇宙真理

为了不只复述 "ripgrep 很快"，我生成了 4096 个文本文件，并让其中每 16 个文件有 1 个包含固定字符串 `needle-search-marker`。当时我在 Python 会话中直接执行实验；下面把同一段生成逻辑整理成可独立运行的 `generate_benchmark.py`：

```python
#!/usr/bin/env python3

from pathlib import Path

ROOT = Path("bench")
FILE_COUNT = 4096
MATCH_INTERVAL = 16
PATTERN = b"needle-search-marker\n"

if ROOT.exists():
    raise SystemExit("bench/ already exists; remove it before regenerating")

ROOT.mkdir()

line = ("alpha beta gamma delta epsilon 0123456789 " * 16 + "\n").encode()
plain_payload = line * 48

for index in range(FILE_COUNT):
    payload = plain_payload
    if index % MATCH_INTERVAL == 0:
        payload += PATTERN
    (ROOT / f"file-{index:04d}.txt").write_bytes(payload)

total_bytes = sum(path.stat().st_size for path in ROOT.iterdir())
matching_files = FILE_COUNT // MATCH_INTERVAL

print(f"files: {FILE_COUNT}")
print(f"size: {total_bytes} bytes ({total_bytes / 1024 / 1024:.2f} MiB)")
print(f"matching files: {matching_files}")
```

这组参数最终生成 4096 个文件，总大小为 132322560 bytes，也就是 126.19 MiB，其中 256 个文件包含目标字符串。接下来的两组命令都会搜索这份固定语料。

```bash
$ python generate_benchmark.py
files: 4096
size: 132322560 bytes (126.19 MiB)
matching files: 256
```

下面再把同一次实验的计时逻辑整理成 `benchmark.py`。它先让每个工具预热 1 次，使语料进入系统缓存，然后正式运行 9 次。`time.perf_counter()` 测量的是从创建子进程到进程退出的墙钟时间，命令输出则送到 `/dev/null`，避免终端渲染成为主要开销。

```python
#!/usr/bin/env python3

from pathlib import Path
import statistics
import subprocess
import time

ROOT = Path("bench")
PATTERN = "needle-search-marker"
RUNS = 9

if not ROOT.is_dir():
    raise SystemExit("bench/ does not exist; run generate_benchmark.py first")

commands = {
    "grep": ["grep", "-R", "-l", "-F", PATTERN, str(ROOT)],
    "rg": ["rg", "-l", "-F", PATTERN, str(ROOT)],
}

timings = {}

for command in commands.values():
    subprocess.run(command, stdout=subprocess.DEVNULL, check=True)

for name, command in commands.items():
    samples = []
    for _ in range(RUNS):
        started = time.perf_counter()
        subprocess.run(command, stdout=subprocess.DEVNULL, check=True)
        samples.append((time.perf_counter() - started) * 1000)
    timings[name] = samples

for name, samples in timings.items():
    formatted = ", ".join(f"{sample:.2f}" for sample in samples)
    print(f"{name}: {formatted} ms")
    print(f"{name} median: {statistics.median(samples):.2f} ms")

ratio = statistics.median(timings["grep"]) / statistics.median(timings["rg"])
print(f"grep / rg: {ratio:.2f}x")
```

这份计时脚本通过 `subprocess.run()` 直接启动外部可执行文件，不经过 shell；在我的环境中，它解析到 GNU grep 3.12 和 ripgrep 15.1.0。因此，下面的数据确实来自 GNU grep 3.12，而不是其他 `grep` 实现。9 次原始数据按脚本记录的执行顺序列出，没有挑选或删除离群值：

| 次数 | `grep` | `rg` |
| ---: | ---: | ---: |
| 1 | 44.67 ms | 13.90 ms |
| 2 | 45. 36ms | 14.66 ms |
| 3 | 43.01 ms | 14.96 ms |
| 4 | 42.65 ms | 15.72 ms |
| 5 | 44.68 ms | 15.91 ms |
| 6 | 42.72 ms | 11.92 ms |
| 7 | 44.74 ms | 15.04 ms |
| 8 | 43.28 ms | 13.66 ms |
| 9 | 44.01 ms | 14.59 ms |
| **中位数** | **44.01 ms** | **14.66 ms** |

两个命令实际分别是：

```bash
grep -R -l -F 'needle-search-marker' bench/
rg -l -F 'needle-search-marker' bench/
```

因此，中位时间和相对值为：

| 工具 | 中位时间 | 相对值 |
| --- | ---: | ---: |
| `grep` | 44.01 ms | 3.00x |
| `rg` | 14.66 ms | 1.00x |

这次 `rg` 大约快 3 倍。数字很具体，结论却必须克制：它只描述这台机器、这两个版本、热缓存、固定字符串和 4096 个文件。换成单个大文件、高匹配率、不同正则、机械硬盘或另一个 `grep` 实现，比例都可能变化。`ripgrep` 项目的 [官方 README](https://github.com/BurntSushi/ripgrep#quick-examples-comparing-tools) 也明确提醒，单个 benchmark 永远不够。

我反而更在意前一个实验：在包含忽略文件和隐藏文件的目录中，默认输出从 3 行降到了 1 行。少掉的 2 行不是性能指标，而是我原本就不想看的噪声。这种默认行为每天都会影响搜索体验，44 ms 和 15 ms 则未必。

## 我现在怎么选

我的规则最后变得很简单：

- **脚本要跨陌生的 Unix 环境运行**：优先使用 POSIX `grep` 的核心选项。它普遍存在，而且契约有标准。
- **搜索单个文件或管道输出**：`grep` 已经足够直接，尤其是系统上不一定安装 `rg` 时。
- **交互式搜索代码仓库**：优先使用 `rg`。递归、ignore、隐藏文件过滤、glob 和文件类型都围绕这个场景设计。
- **搜索结果疑似被过滤**：先试 `rg -u`、`rg --hidden` 或 `rg --debug`，不要立刻断言文件不存在。
- **需要理解代码结构**：停止继续堆正则，换语言服务器、AST 搜索或 IDE 引用查找。

`grep` 没有因为 `ripgrep` 出现就过时。它更像 shell 世界里的基础协议，而 `rg` 是针对现代代码仓库重新安排过默认值的高性能客户端。我大概会继续在脚本里写 `grep`，在终端里敲 `rg`。至少下一次看到 `grep -Eiv` 时，我不再需要假装那是一串不可分割的魔法咒语了。

## 继续查阅

- [POSIX grep 规范](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/grep.html)
- [GNU grep 3.12 手册](https://www.gnu.org/software/grep/manual/grep.html)
- [ripgrep User Guide](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md)
- [ripgrep README 与性能说明](https://github.com/BurntSushi/ripgrep/blob/master/README.md)
