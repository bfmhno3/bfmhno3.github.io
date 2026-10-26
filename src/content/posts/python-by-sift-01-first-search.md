---
title: "第一次搜索：解释器、对象与 123 篇文章"
commentId: "post:python-by-sift-01-first-search"
published: "2026-10-22 00:00:00 +08:00"
description: "用 Sift 重学 Python 第 1 篇：我在 Python 3.14.7 里写了 48 行的朴素全文搜索，扫完这个博客的 123 篇文章（4,614,185 字节）只要约 20 ms，再拿它当靶子，把解释器、字节码、对象模型、数字类型、控制流和 ruff 逐条跑了一遍。"
category: Tutorial
tags:
  - Python
  - Sift
  - 入门
  - 解释器
  - CPython
series: "用 Sift 重学 Python"
seriesOrder: 1
draft: false
comment: true
slug: python-by-sift-01-first-search
---

这个博客现在有 123 篇文章，合起来 4,614,185 字节。我想知道哪几篇最常提到 `kalman`，所以写了一个 48 行的 Python 程序，每次都把所有文章从头读一遍：

```text
$ python3 -m sift kalman
    23  corpus/posts/kalman-filter-01-one-dimension.md
    21  corpus/posts/kalman-filter-02-multivariate.md
    15  corpus/posts/kalman-filter-06-eskf.md
    15  corpus/posts/kalman-filter-07-ukf.md
    15  corpus/posts/kalman-filter-08-porting.md
    11  corpus/posts/kalman-filter-03-tuning-diagnostics.md
     9  corpus/posts/kalman-filter-04-attitude-imu.md
     8  corpus/posts/kalman-filter-05-ekf.md
     2  corpus/posts/pid-control-10-embedded.md
     1  corpus/posts/linear-algebra-17-orthogonal-matrices-gram-schmidt.md
searched 123 files in 20.0 ms
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch01`：有 `flake.nix`、`Makefile`、`ruff.toml`、语料抓取脚本 `scripts/fetch-corpus.sh`、实验场运行器 `scripts/chapter.py`、8 篇固定的迷你语料 `tests/fixtures/mini/`、12 条基准查询 `bench/queries.txt`，以及 `src/sift/__main__.py` 里的朴素搜索。其中朴素搜索在第 2 篇会换掉比较方式，在第 3 篇起会拆出索引，其余构建文件在整个系列里基本不再变。`make ch01` 通过，`lab/ch01` 下 6 个 Python 实验加 1 个 shell 实验都按预期退出。
> 涉及的 Python 特性：`nix develop` 里的 Python 3.14.7、REPL、`python file.py` 与 `python -m`、`__name__ == "__main__"`、源码到字节码到解释器循环、`.pyc`、对象与引用计数、名字绑定、动态强类型、`int`/`float`/`bool`/`None`、运算符、控制流、`def` 与 f-string、PEP 8 与 `ruff`。
> 这是第 1 篇，没有前置章节。

## 这个系列怎么读

没有索引，没有数据库，没有第三方库，只有标准库和一个 `for` 循环。这个系列要做的事，是以这 48 行为起点，一章一章把它长成一个真正的搜索引擎：倒排索引、BM25、手写的查询语言、二进制索引文件、SQLite、多进程建索引、asyncio 和 FastAPI 服务、tkinter 和 PySide6 客户端、numpy 和 pandas 做分析、剖析和优化，最后用 C 和 Rust 重写最热的那个函数。25 章结束，你对 Python 这门语言、它的标准库和最常用的几个第三方库，应该能说出每一块在内存里长什么样、代价是多少。

我定了几条规矩，因为我自己重学东西的时候吃过“看懂了但跑不起来”的亏。

**一个项目，25 个标签。** 仓库是 [`bfmhno3/sift`](https://github.com/bfmhno3/sift)。第 N 篇对应标签 `chNN`，`git checkout ch01` 就是写第 1 篇时的样子。标签一旦推送就不再改：后面章节发现的问题，会在后面的章节里修，并在那一篇里说明。

**每个论断都有命令。** 文章里所有输出都是我在这台机器上跑出来的：

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
```

CPU 是 AMD Ryzen 7 PRO 6850U（16 个线程），内存 30 GiB。计时用 `time.perf_counter` 或 `hyperfine`，报告的是多次运行的均值或中位数；机器不同数字会变，我会尽量同时给出与机器无关的比值。

**实验场。** 每一章有一个 `lab/chNN/` 目录，里面是一个个很小的、自包含的脚本，每个脚本只演示一件事，文件名就是那件事。会出错的实验以 `_fail.py` 结尾，出错是它存在的目的。你可以把它们当成 REPL 的存档。

**不贴整个文件。** 文章只引用正在讲的那几行，剩下的在仓库里，每章末尾有一张 `本篇文件` 表，把这一章碰过的每个文件、运行命令和真实结果列出来，每个文件都链到对应标签。

**我假设你已经会写脚本。** 变量、循环、函数，不会从“什么是变量”讲起。我们直接问：它在 CPython 里是怎么实现的，代价是什么，为什么这样设计。我在学 Rust（见 [Pebble 系列](/posts/rust-by-pebble-01-first-crate/)），所以会偶尔拿 Rust 或 C++ 做一句话的对照，但它们不是叙述的框架。

下面是 25 篇的地图，每个标题都链到对应的文章。

| 篇 | 标题 | 仓库标签 |
| --- | --- | --- |
| 1 | [第一次搜索：解释器、对象与 123 篇文章](/posts/python-by-sift-01-first-search/) | `ch01` |
| 2 | [文本：str、bytes、Unicode 与正则](/posts/python-by-sift-02-text-and-unicode/) | `ch02` |
| 3 | [容器：list、dict、set 的实现与代价](/posts/python-by-sift-03-containers/) | `ch03` |
| 4 | [函数：参数、作用域、闭包与装饰器](/posts/python-by-sift-04-functions/) | `ch04` |
| 5 | [迭代器与生成器：惰性的建索引流水线](/posts/python-by-sift-05-iterators-generators/) | `ch05` |
| 6 | [类与数据模型：让倒排表像内置类型](/posts/python-by-sift-06-classes-data-model/) | `ch06` |
| 7 | [继承、ABC 与 Protocol：分析器插件](/posts/python-by-sift-07-inheritance-protocols/) | `ch07` |
| 8 | [BM25 与查询语言：match/case 和递归下降](/posts/python-by-sift-08-bm25-query-language/) | `ch08` |
| 9 | [异常、上下文管理器、日志与调试：把错误收成一个层次](/posts/python-by-sift-09-exceptions-context-logging/) | `ch09` |
| 10 | [测试：pytest、hypothesis 与 CI：让机器替我去找没想到的输入](/posts/python-by-sift-10-testing/) | `ch10` |
| 11 | [模块、包、导入系统与命令行：把 PYTHONPATH 换成 pip install -e](/posts/python-by-sift-11-modules-packaging-cli/) | `ch11` |
| 12 | [文件与二进制格式：struct、varint、mmap 与压缩](/posts/python-by-sift-12-files-binary-format/) | `ch12` |
| 13 | [数据库：sqlite3、FTS5 与 SQLAlchemy](/posts/python-by-sift-13-sqlite-sqlalchemy/) | `ch13` |
| 14 | [类型系统：从注解到 mypy --strict](/posts/python-by-sift-14-type-system/) | `ch14` |
| 15 | [对象模型与元编程：描述符、元类、字节码](/posts/python-by-sift-15-metaprogramming/) | `ch15` |
| 16 | [并发（上）：线程、进程、GIL 与自由线程](/posts/python-by-sift-16-threads-processes-gil/) | `ch16` |
| 17 | [并发（下）：asyncio 与手写 HTTP 服务器](/posts/python-by-sift-17-asyncio/) | `ch17` |
| 18 | [Web：FastAPI、pydantic 与 httpx](/posts/python-by-sift-18-fastapi-pydantic-httpx/) | `ch18` |
| 19 | [命令行体验与分发：typer、rich、uv 与 wheel](/posts/python-by-sift-19-typer-rich-uv/) | `ch19` |
| 20 | [GUI（上）：tkinter 与事件循环](/posts/python-by-sift-20-tkinter/) | `ch20` |
| 21 | [GUI（下）：用 PySide6 做一个好看的桌面客户端](/posts/python-by-sift-21-pyside6/) | `ch21` |
| 22 | [数据分析：numpy、pandas、matplotlib 与齐夫定律](/posts/python-by-sift-22-numpy-pandas-matplotlib/) | `ch22` |
| 23 | [性能：剖析、字节码特化与优化](/posts/python-by-sift-23-profiling-performance/) | `ch23` |
| 24 | [原生扩展（上）：C、ctypes、cffi、Cython 与 C API](/posts/python-by-sift-24-c-extensions/) | `ch24` |
| 25 | [原生扩展（下）：用 PyO3 写 Rust 扩展](/posts/python-by-sift-25-pyo3-rust/) | `ch25` |

没有哪一篇是选读，顺序就是依赖顺序。第 N 篇只会用到前 N-1 篇讲过的东西；偶尔要提前露个脸，我会写明“先当成 X，第 M 篇细讲”。

## 装环境

我用 Nix 固定所有工具的版本，这样你和我的输出能对得上。仓库里的 `flake.nix` 把 nixpkgs 锁在 `56c02bc00adcf003215cc4bd996d6efaf4cff188`，整个系列要用的东西都在里面：Python 3.14.7、自由线程版的 3.14.7、`ruff`、`uv`、`pyright`、`hyperfine`、`rustc`、`gcc` 等等（后面的章节才会用到的那些，现在只是躺在那里）。

```bash
git clone https://github.com/bfmhno3/sift
cd sift
git checkout ch01
nix develop
```

进去以后 `shellHook` 会打一行横幅：

```text
sift dev shell: Python 3.14.7, Python 3.14.7 (free-threaded), ruff 0.16.3, rustc 1.97.1 (8bab26f4f 2026-07-14) (built from a source tarball)
```

这一行是我自己写的，作用是让你一眼确认版本对不对。两个 `Python 3.14.7` 是两个不同的可执行文件：`python3` 是普通版，`python3.14t` 是 3.14 正式支持的自由线程版（没有 GIL，第 16 篇才用）。看一下普通版是从哪来的：

```text
$ which python3
/nix/store/ls26898yzdy2wn1cvh3zkr420lsx2dvw-python3-3.14.7-env/bin/python3
$ python3 --version
Python 3.14.7
```

路径在 `/nix/store` 里，说明它不是系统自带的 Python，而是 flake 构建出来的一个环境，里面已经装好了后面章节要用的 pytest、numpy、PySide6 等等。你不用 `pip install` 任何东西。

> 如果你不用 Nix：任何 Python 3.14 加上 `ruff`、`hyperfine`、`make` 都能跑本篇的内容；后面几章会用到更多包，到时候看 `flake.nix` 里的清单装就行。但版本不同输出会有差异，字节码尤其明显（下文会看到）。

`Makefile` 开头有一道门：不在 `nix develop` 里就拒绝干活。这是故意的，省得你在错的 Python 上排查半小时：

```text
$ make ch01
Makefile:2: *** run inside nix develop.  Stop.
```

这个检查靠的是 `shellHook` 导出的 `FONTCONFIG_FILE`（它第 21 篇才会派上真正用场），`Makefile` 里是 `ifndef FONTCONFIG_FILE`。一个变量借来当“我在 shell 里”的标记，有点投机取巧，但很便宜。

### 取语料

语料就是这个博客本身。文章用 CC BY-NC-SA 4.0 发布，所以仓库里只放抓取脚本，不放文章：`scripts/fetch-corpus.sh` 从 GitHub 上拉取固定提交 `2c3f11a4fefafdfd6baa58bd3e09db679227cbcc` 的 `src/content/posts`，数一数是不是 123 篇，不是就报错。

我在一个临时目录里把脚本重新跑了一遍，看它真正干了什么（语料已经在仓库里了，这样不会动它）：

```text
$ ./scripts/fetch-corpus.sh
corpus: 123 posts at 2c3f11a4fefafdfd6baa58bd3e09db679227cbcc

real	1m26.162s
$ du -sb corpus/posts
4614185	corpus/posts
```

86 秒，几乎全花在网络上（用户态加内核态一共 1.5 秒）。`git fetch` 按提交号浅拉取这条路在这次没走通，脚本回退到了 `git clone --filter=blob:none` 再 `git checkout`；这两条路径脚本里都写了。拿到的 123 篇和我仓库里已有的那份用 `diff -rq` 比过，一字节不差。以后的章节里 `make corpus` 只会在 `corpus/COMMIT` 不存在时才跑这个脚本。

4,614,185 字节，这是本篇会反复出现的数字。（它比字符数大得多，因为文章是中文，一个汉字在 UTF-8 里占 3 字节。字符数是 3,320,875，为什么两个数不一样，第 2 篇讲。）

## REPL

Python 最快的反馈回路是 REPL。不带参数敲 `python3` 就进去了。我不能在文章里给你放一段动图，所以我把几行输入喂给 `python3 -i`，让它读标准输入。因为不是终端，输入没有回显，只剩提示符和结果：

```text
$ python3 -i < repl.txt
>>> 1267650600228229401496703205376
>>> 1267650600228229401496703205377
>>> <class 'int'>
>>> Help on built-in function divmod in module builtins:

divmod(x, y, /)
    Return the tuple (x//y, x%y).  Invariant: div*y + mod == x.

>>> ... ... kalman 6
rust 4
>>> >>> True
```

这里喂进去的是：`2 ** 100`，然后 `_ + 1`，然后 `type(_)`，然后 `help(divmod)`，再然后是一个两行的 `for` 循环，最后 `import sys` 加一个 `sys.getrefcount(None) > 1000`（它是 `True`，原因下面讲）。`_` 是 REPL 里的一个特殊变量，存着上一个表达式的值（所以第二行是第一行加 1，第三行问它的类型）；`help(divmod)` 打印的是内置函数的文档；`...` 是续行提示符，`for` 循环用了两行。`/` 出现在 `divmod(x, y, /)` 里是什么意思，第 4 篇讲函数参数时才解释，先当成“前面的参数只能按位置传”。

3.13 起，REPL 不再是 C 写的那个简陋版本，而是 Python 写的 `_pyrepl`：支持多行编辑（把一个 `def` 当一个整体上下移动和修改）、F1 看帮助、F2 翻历史、F3 进入粘贴模式。3.14 又加了语法高亮。多行编辑和这三个功能键是我从官方 What’s New 转述的，我没有在本机演示过，不保证；语法高亮我验证了。先确认 REPL 的实现在哪：

```text
$ python3 -c 'import _pyrepl; print(_pyrepl.__file__)'
/nix/store/ls26898yzdy2wn1cvh3zkr420lsx2dvw-python3-3.14.7-env/lib/python3.14/_pyrepl/__init__.py
```

REPL 就是标准库里一个普通的包。高亮我是这样验证的：我的终端设了 `NO_COLOR=1`，所以平时在 REPL 里什么颜色也看不到。用 `script` 起一个伪终端，打开 `FORCE_COLOR=1`（并且 `env -u NO_COLOR` 去掉我那个变量），用 `printf` 往里喂 `def f(x): return x`、两个回车和一个 Ctrl-D，再用 `cat -v` 把转义序列显示出来，取第 3 到 4 行：

```bash
(sleep 1; printf 'def f(x): return x\r'; sleep 0.3; printf '\r'; sleep 0.3; printf '\004') \
  | env -u NO_COLOR TERM=xterm-256color FORCE_COLOR=1 script -qec python3 /dev/null \
  | cat -v | sed -n 3,4p | cut -c1-330
```

```text
^[[?2004h^[[?1h^[=^[[?25l^[[1;35m>>> ^[[0m^[[4D^[[?12l^[[?25h^[[4C^[[?25l^[[4D^[[1;35m>>> ^[[0md^[[5D^[[?12l^[[?25h^[[5C^[[?25l^[[5D^[[1;35m>>> ^[[0mde^[[6D^[[?12l^[[?25h^[[6C^[[?25l^[[6D^[[1;35m>>> ^[[0m^[[1;34mdef^[[0m^[[7D^[[?12l^[[?25h^[[7C^[[?25l^[[7D^[[1;35m>>> ^[[0m^[[1;34mdef^[[0m ^[[8D^[[?12l^[[?25h^[[8C^[[?25l^[[8D^[[1
^[[1;35m... ^[[0m^[[4D^[[?12l^[[?25h^[[4C^[[4D
```

每敲一个字符整行都重画一遍，所以 `>>> ` 一遍遍出现（第一行被 `cut` 截断了）。提示符 `>>> ` 被 `ESC[1;35m` 包住（粗体紫色），敲完 `def` 之后关键字被 `ESC[1;34m` 包住（粗体蓝色）；第二行的续行提示符 `... ` 同样是紫色。颜色由 `_colorize` 模块决定，`NO_COLOR` 设了，或者标准输出不是终端的时候它返回 `False`，我这个 shell 里就是这样：

```text
$ python3 -c 'import _colorize; print(_colorize.can_colorize())'
False
```

我不在 REPL 里做大实验。我的习惯是：想试一个想法，在 REPL 里敲；想留下来，就把它存成 `lab/` 里的一个文件。REPL 里还有一件常用的事是查文档：`help(obj)`，或者在 shell 里 `python3 -m pydoc divmod`，结果和上面一样。

## 三种跑法

跑一段 Python 代码有三种方式，区别比看起来大：

| 方式 | 命令 | 在做什么 |
| --- | --- | --- |
| 脚本 | `python3 path/to/file.py` | 把文件当 `__main__` 执行，`sys.path[0]` 是**文件所在目录** |
| 模块 | `python3 -m pkg.mod` | 用导入系统找到模块，再当 `__main__` 执行，`sys.path[0]` 是**当前目录** |
| 命令 | `python3 -c 'code'` | 把字符串当 `__main__` 执行 |

我写了一个 4 行的探针，文件名 `who.py`，放在 `/tmp/p01/` 里（不在仓库里，它只是为了这一节）：

```python
# who.py
import sys

print("__name__ =", __name__)
print("__package__ =", __package__)
print("__spec__ =", __spec__)
print("sys.path[0] =", sys.path[0])
```

先当脚本跑 `who.py`；再 `cp who.py whom.py` 复制一份，用 `-m whom` 跑的是这份副本（`-m` 后面写的是模块名，不带 `.py`）：

```text
$ python3 /tmp/p01/who.py
__name__ = __main__
__package__ = None
__spec__ = None
sys.path[0] = /tmp/p01
$ cp /tmp/p01/who.py /tmp/p01/whom.py
$ cd /tmp/p01 && python3 -m whom
__name__ = __main__
__package__ = 
__spec__ = ModuleSpec(name='whom', loader=<_frozen_importlib_external.SourceFileLoader object at 0x7ffff6ff06d0>, origin='/tmp/p01/whom.py')
sys.path[0] = /tmp/p01
```

两种方式里 `__name__` 都是 `"__main__"`，这是整个 `if __name__ == "__main__":` 惯用法的基础：**被直接执行的那个模块，名字被改成了 `__main__`**。区别在 `__spec__`：脚本方式下它是 `None`，因为解释器根本没经过导入系统；`-m` 方式下它是一个真正的 `ModuleSpec`，记着加载器和文件来源。（`sys.path[0]` 在这里两次都是 `/tmp/p01`，是因为我第二次正好在那个目录里跑；如果换个目录，`-m` 的会跟着变成那个目录，脚本方式的不会。）

`src/sift/__main__.py` 的最后两行就是这个惯用法：

```python
if __name__ == "__main__":
    main()
```

为什么需要它？因为同一个文件既可能被执行，也可能被 `import`。被导入时 `__name__` 是模块的真名，条件为假，`main()` 不会跑。我直接验证：

```text
$ python3 -c 'import sift, sift.__main__ as m; print(sift.__name__, sift.__file__); print(m.__name__)'
sift /home/bfmhno3/Projects/sift/src/sift/__init__.py
sift.__main__
```

导入了 `sift.__main__` 却没有任何搜索输出，也没有 usage 报错（没有参数的话 `main()` 会退出）。要是没有那个守卫，这行 `import` 就会直接执行一次搜索，然后因为没有参数而退出整个进程。

Sift 的入口放在 `__main__.py`，所以用 `python3 -m sift` 跑：Python 把 `sift` 当包，找到里面的 `__main__.py` 执行。它能找到 `sift` 靠的是 `shellHook` 里的这一行：

```bash
export PYTHONPATH="$PWD/src''${PYTHONPATH:+:$PYTHONPATH}"
```

（`''${...}` 是 Nix 字符串里转义 `${` 的写法，到了 shell 里就是 `${PYTHONPATH:+:$PYTHONPATH}`，意思是“如果原来有就接在后面”。）`PYTHONPATH` 里的目录会被加进 `sys.path`。第 11 篇我们会换成正经的可编辑安装，到时候这行就删了。

现在还有一个小陷阱，我故意留着。语料目录写的是相对路径 `Path("corpus/posts")`，所以只有在仓库根目录跑才对：

```text
$ cd /tmp && python3 -m sift kalman
searched 0 files in 0.1 ms
$ echo $?
0
```

不在仓库根目录的话，`Path.glob` 对一个不存在的目录不会报错，只是什么也不返回。我们得到的是“搜了 0 个文件，退出码 0”，一个安静的错误，比崩溃更难发现。它会在第 9 篇（异常）和第 12 篇（配置文件）里被正经修掉。

## 源码、字节码、解释器

CPython 跑你的程序分三步：把源码**编译**成字节码（一种面向栈的虚拟机指令），把字节码缓存到 `.pyc`，再由一个用 C 写的**解释器循环**一条一条执行。编译这一步我们用标准库的 `dis` 就能看。`lab/ch01/bytecode_peek.py` 反汇编了一个 3 行的函数：

```python
def add_one(n: int) -> int:
    """Return n + 1."""
    total = n + 1
    return total
```

```text
$ python3 lab/ch01/bytecode_peek.py
  6           RESUME                   0

  8           LOAD_FAST_BORROW         0 (n)
              LOAD_SMALL_INT           1
              BINARY_OP                0 (+)
              STORE_FAST               1 (total)

  9           LOAD_FAST_BORROW         1 (total)
              RETURN_VALUE
...
```

每一行从左到右是：源码行号（只在新的一行开头出现）、操作码、参数、括号里是 `dis` 帮你翻译的参数含义。读法是在脑子里放一个栈：

1. `LOAD_FAST_BORROW 0 (n)`：把局部变量 `n`（第 0 号槽）压栈。
2. `LOAD_SMALL_INT 1`：把整数 `1` 压栈。
3. `BINARY_OP 0 (+)`：弹出两个，做加法，结果压栈。
4. `STORE_FAST 1 (total)`：弹出栈顶，存进局部变量 `total`（第 1 号槽）。
5. `LOAD_FAST_BORROW 1 (total)` 然后 `RETURN_VALUE`：压栈，返回。

`RESUME` 是函数入口的标记，用来给调试和监控挂钩子。注意函数的文档字符串（第 7 行）没有出现在指令里：它被放进了代码对象的常量里，不会执行。

`LOAD_FAST_BORROW` 和 `LOAD_SMALL_INT` 都是 3.14 的新面孔（我不记得 3.12 的输出里有它们，没有在本机验证过）：前者“借”一个引用，不增加引用计数；后者把 0 到 255 的小整数直接编码在指令参数里，不再去常量表里取。这是版本差异的一个例子：你在网上看到的字节码教程，指令名多半和这里不同，原理不变。

函数在运行时就是一个对象，字节码在它的 `__code__` 里，那是一个代码对象。脚本接下来把它的字段打出来：

```text
co_name: add_one
co_argcount: 1
co_varnames: ('n', 'total')
co_consts: ('Return n + 1.',)
co_stacksize: 2
co_code bytes: 24
```

`co_stacksize: 2` 就是上面那个栈最深的时候装两个东西（`n` 和 `1`）。`co_code` 有 24 字节，但我数出来只有 7 条指令，每条 2 字节应该是 14 字节。多出来的 10 字节是什么？用 `show_caches=True` 看：

```text
$ python3 -c 'import dis, sys; sys.path.insert(0, "lab/ch01"); from bytecode_peek import add_one; dis.dis(add_one, show_caches=True)'
  6           RESUME                   0

  8           LOAD_FAST_BORROW         0 (n)
              LOAD_SMALL_INT           1
              BINARY_OP                0 (+)
              CACHE                    0 (counter: 0)
              CACHE                    0 (descr: 0)
              CACHE                    0
              CACHE                    0
              CACHE                    0
              STORE_FAST               1 (total)

  9           LOAD_FAST_BORROW         1 (total)
              RETURN_VALUE
$ python3 -c 'import opcode; print(opcode._inline_cache_entries["BINARY_OP"])'
5
```

`BINARY_OP` 后面跟着 5 个 `CACHE` 槽位，每个 2 字节，7 条指令加 5 个槽位正好 12 个 2 字节单元，24 字节。这些槽位是给**自适应解释器**留的空间：函数跑热了以后，解释器会把通用的 `BINARY_OP` 原地改成针对具体类型的版本，缓存信息就存在这些槽位里。我让 `add_one` 跑 2000 次，再用 `adaptive=True` 反汇编（普通的 `dis.dis` 会把特化隐藏掉，只给你源码级的指令名，要看真实的就得加这个参数）：

```text
$ python3 -c 'import dis, sys; sys.path.insert(0, "lab/ch01"); from bytecode_peek import add_one; [add_one(1) for _ in range(2000)]; dis.dis(add_one, adaptive=True)'
  6           RESUME_CHECK             0

  8           LOAD_FAST_BORROW         0 (n)
              LOAD_SMALL_INT           1
              BINARY_OP_ADD_INT        0 (+)
              STORE_FAST               1 (total)

  9           LOAD_FAST_BORROW         1 (total)
              RETURN_VALUE
```

`BINARY_OP` 变成了 `BINARY_OP_ADD_INT`，`RESUME` 变成了 `RESUME_CHECK`。同一个函数，同一份源码，字节码在运行时被改写过。这是 3.11 引入的 PEP 659，第 23 篇做性能优化的时候会专门拆它，这里只想让你知道：**字节码不是静态的**。

`compile()` 把字符串直接编译成代码对象，`exec()` 执行它。脚本里：

```python
compiled = compile("x = 2 + 3\nprint(x * 10)", "<demo>", "exec")
```

```text
type: code
co_consts: (2, None)
co_names: ('x', 'print')
50
```

我反汇编它：

```text
$ python3 -c 'import dis; dis.dis(compile("x = 2 + 3\nprint(x * 10)", "<demo>", "exec"))'
  0           RESUME                   0

  1           LOAD_SMALL_INT           5
              STORE_NAME               0 (x)

  2           LOAD_NAME                1 (print)
              PUSH_NULL
              LOAD_NAME                0 (x)
              LOAD_SMALL_INT          10
              BINARY_OP                5 (*)
              CALL                     1
              POP_TOP
              LOAD_CONST               1 (None)
              RETURN_VALUE
```

源码里写的是 `2 + 3`，字节码里已经是 `LOAD_SMALL_INT 5`：编译器在生成字节码之前就把常量表达式算掉了（常量折叠）。`co_consts` 里那个孤零零的 `2` 是折叠之后的残留，没有指令用它。另外这里变量用的是 `STORE_NAME`/`LOAD_NAME`，函数里用的是 `STORE_FAST`/`LOAD_FAST`：模块级代码的变量存在一个字典里，要按名字查；函数里的局部变量存在数组里，按下标取。**同样一个循环，放进函数里跑比放在模块顶层快，这就是原因之一。** 我用 500 万次 `total += i` 量了一下：模块顶层 449.3 ms，放进函数 231.6 ms，函数版快 1.94 倍（`hyperfine -N`，15 次）。

字节码是每次启动都重新编译吗？不是，编译结果缓存在 `__pycache__/` 里：

```text
$ ls src/sift/__pycache__
__init__.cpython-314.pyc
__main__.cpython-314.pyc
```

文件名里的 `cpython-314` 来自 `sys.implementation.cache_tag`，所以不同版本的解释器各存各的，互不覆盖。`.pyc` 的结构很简单：16 字节的头加上 `marshal` 序列化的代码对象。头我可以直接拆开：

```python
magic, flags, mtime, size = struct.unpack("<4sIII", raw[:16])
```

```text
b'+\x0e\r\n' 0 1792599242 1481 1792599242.8366814 1792599242
```

依次是：魔数（它和解释器版本绑定，版本变了旧的 `.pyc` 就被忽略）；标志位 0（表示“基于时间戳的缓存”）；源文件修改时间 `1792599242`（和 `os.stat` 给的 `1792599242.83...` 取整一致）；源文件大小 `1481`（`__main__.py` 的字节数就是 1481）。下次导入时，解释器比较这两个数：不一样就重新编译。`marshal.loads(raw[16:])` 取回来的就是一个代码对象，和 `__code__` 同一种东西。

有一点反直觉：**直接执行的脚本不会生成 `.pyc`**。上面的探针 `who.py` 当脚本跑了，`/tmp/p01/__pycache__` 里只有 `whom.cpython-314.pyc`，也就是用 `-m` 跑的那一个。只有被导入的模块（和 `-m` 执行的模块，它们走导入系统）才会缓存，脚本每次都要重新编译。所以大程序的入口文件最好很短，把真正的代码放进模块里。

缓存有用吗？我把 `__pycache__` 删掉，用 `PYTHONDONTWRITEBYTECODE=1` 让它不写，跑 30 次搜索一个不存在的词；再让它写好缓存，跑 30 次：

```text
$ hyperfine -N --runs 30 -p 'rm -rf src/sift/__pycache__' 'env PYTHONDONTWRITEBYTECODE=1 python3 -m sift zzzzqq'
  Time (mean ± σ):      55.1 ms ±   3.9 ms
$ hyperfine -N --runs 30 --warmup 3 'python3 -m sift zzzzqq'
  Time (mean ± σ):      49.6 ms ±   4.4 ms
```

差 5.5 ms，噪声是 4 ms 左右，所以我只敢说方向（缓存略快），不敢说量级。一个 48 行的文件编译起来本来就快；`.pyc` 真正省时间的场景是几十个模块的大项目，第 11 篇用 `-X importtime` 量。

最后是“解释器循环”本身。CPython 的核心是一个用 C 写的大循环：取下一条指令，`switch` 到它的实现，操作值栈，再取下一条。指令的实现写在 CPython 源码的 `Python/bytecodes.c` 里，构建时生成真正的 C 代码。它不是什么魔法，每一条字节码是一小段 C，`BINARY_OP_ADD_INT` 做的事大概就是“确认两边都是 `int`，加起来，分配一个新的 `int` 对象”。这个“分配一个新的对象”，就引出下一节。
## 一切皆对象

整数是对象，字符串是对象，函数是对象，模块是对象，类也是对象，`None` 也是对象。这不是修辞，是 CPython 的实现方式：任何你能放进变量里的东西，在 C 层面都是一个以 `PyObject` 头开始的结构体，头里有两个字段，**引用计数**和**指向它的类型对象的指针**。

```text
$ python3 - <<'PY'
import sys
print(type(1), type(type), type(len), type(print), type(sys), type(lambda: 0), type(None), type(...))
def f(): pass
print(type(f), f.__class__.__mro__)
print(isinstance(len, object), isinstance(int, object), isinstance(type, type))
PY
<class 'int'> <class 'type'> <class 'builtin_function_or_method'> <class 'builtin_function_or_method'> <class 'module'> <class 'function'> <class 'NoneType'> <class 'ellipsis'>
<class 'function'> (<class 'function'>, <class 'object'>)
True True True
```

`type(type)` 是 `type`：类型本身也是对象，而且它们的类型是 `type`（第 15 篇会讲这个闭环为什么不会无限递归）。函数 `f` 的类是 `function`，往上数就是 `object`，所有东西都是 `object` 的（直接或间接）实例。`print` 和 `len` 是 C 写的，所以类型是 `builtin_function_or_method`，Python 写的函数才是 `function`。

对象有多大？

```text
$ python3 -c 'import sys; print(sys.getsizeof(1), sys.getsizeof(2**200), sys.getsizeof(None), sys.getsizeof("a"), sys.getsizeof(""), sys.getsizeof([]), sys.getsizeof(object()))'
28 52 16 42 41 56 16
```

一个 `1` 占 28 字节，`None` 占 16 字节，也就是上面说的头：8 字节引用计数加 8 字节类型指针。同样一个整数 `1`，Rust 的 `i64` 是 8 字节。Python 为每一个整数付 3.5 倍的内存，换来的是它可以长到任意大。`2**200` 是 52 字节，我们接着数：

```text
$ python3 -c 'import sys; print(sys.int_info)'
sys.int_info(bits_per_digit=30, sizeof_digit=4, default_max_str_digits=4300, str_digits_check_threshold=640)
```

`int` 内部是一个“数字数组”，每个数字存 30 位，占 4 字节。`2**200` 有 201 个二进制位，需要 7 个这样的数字，7 × 4 = 28 字节，加上 24 字节的头（引用计数、类型指针和一个记录长度与符号的字段）等于 52。`1` 需要 1 个数字：24 + 4 = 28。`2**30` 要 2 个数字：32。`2**60` 要 3 个：36（我都跑了，输出是 `32` 和 `36`）。这就是 Python 的整数没有溢出的原因：**没有固定宽度，只有一个会增长的数组。**

### `is` 和 `==`

每个对象有一个身份，`id()` 返回它，在 CPython 里这就是对象的内存地址。`is` 比较身份，`==` 比较值。`lab/ch01/repl_tour.py` 里有一段对比：

```python
a = int("256")
b = int("256")
c = int("257")
d = int("257")
print("256 is 256 (built at runtime):", a is b)
print("257 is 257 (built at runtime):", c is d)
print("257 == 257:", c == d)
print("id(256) same:", id(a) == id(b), "| id(257) same:", id(c) == id(d))
```

```text
256 is 256 (built at runtime): True
257 is 257 (built at runtime): False
257 == 257: True
id(256) same: True | id(257) same: False
```

我用 `int("257")` 在运行时造整数，是因为直接写两个字面量 `257` 的话，编译器可能把它们合并成同一个常量，结果就和运行时的行为不一样了。上面的结果说明：CPython 预先造好了一批小整数，`int("256")` 每次返回的是同一个对象，257 就每次新造一个。边界我也验证了一下：

```text
$ python3 -c 'for n in (-6, -5, 256, 257): ...'
-6 False
-5 True
256 True
257 False
```

小整数缓存的范围是 -5 到 256。这是一个实现细节，不要在代码里依赖它。你唯一应该用 `is` 的场合是比较 `None`：`x is None`。拿 `is` 去比较整数字面量，Python 在编译时就会给一个 `SyntaxWarning`：

```text
<string>:6: SyntaxWarning: "is" with 'int' literal. Did you mean "=="?
```

（这是我在探针里写了 `True is 1` 得到的。）

### 名字是便利贴，对象是箱子

C 和 Rust 里，变量是一块内存，赋值是把值拷进去。Python 里**变量只是一个名字，名字指向对象**，赋值是把名字贴到对象上，就像把便利贴贴到一个箱子上。同一个箱子可以贴很多张便利贴，贴一张新的永远不会复制箱子。`lab/ch01/names_and_objects.py` 把这件事拆开演示：

```python
a = [1, 2, 3]
b = a
print("a is b:", a is b)
b.append(4)
print("after b.append(4), a =", a)
b = b + [5]
print("after b = b + [5], a =", a, "| b =", b)
print("a is b:", a is b)
```

```text
a is b: True
after b.append(4), a = [1, 2, 3, 4]
after b = b + [5], a = [1, 2, 3, 4] | b = [1, 2, 3, 4, 5]
a is b: False
```

`b = a` 之后只有一个列表、两个名字。通过 `b` 调用 `append` 修改的是那个共享的列表，所以 `a` 也看到了。但 `b = b + [5]` 先造出一个**新**列表，再把名字 `b` 贴过去，`a` 还贴在老的箱子上。同样是“改 `b`”，一个改了对象，一个只是挪了名字。区分这两件事，是 Python 里最重要的一条心智模型。

整数没有 `append` 之类的方法，因为它们不可变，所以不会有这种惊喜：

```python
x = 10
y = x
y += 1
print("ints are immutable: x =", x, "| y =", y)
```

```text
ints are immutable: x = 10 | y = 11
```

`y += 1` 对不可变的整数来说就是 `y = y + 1`：造出新对象 11，把 `y` 挪过去。列表是可变的，`+=` 的行为会不一样，这是第 3 篇的主题，也是下面练习 1 的主题。

引用计数怎么看？`sys.getrefcount`：

```python
obj = object()
print("refcount of a fresh object:", sys.getrefcount(obj))
alias = obj
print("after one alias:", sys.getrefcount(obj))
holder = [obj, obj]
print("after a list holding it twice:", sys.getrefcount(obj))
del alias
del holder
print("after del alias, del holder:", sys.getrefcount(obj))
```

```text
refcount of a fresh object: 1
after one alias: 2
after a list holding it twice: 4
after del alias, del holder: 1
```

引用计数就是“有几张便利贴（和容器里的槽位）指着它”：加一个别名 +1，放进列表两次 +2，`del` 一个名字 -1，`del` 列表连带释放列表对它的两个引用 -2。归零的时候，对象立刻被释放，这是 CPython 回收内存的主力机制（循环引用才轮到垃圾回收器，第 15 篇）。

第一行的 `1` 有点出人意料。按文档的说法，`getrefcount` 的返回值“一般比你以为的大 1”，因为把对象传给函数这件事本身就是一个临时引用，我记得更老的版本在这里打印的是 2。3.14 打印 1，是因为前面字节码里见过的 `LOAD_FAST_BORROW`：把局部变量“借”给调用，不增加引用计数。（旧版本的数字是我的记忆，没有在本机验证。）

再看几个常见对象的计数：

```text
$ python3 -c 'import sys; print(sys.getrefcount(None), sys.getrefcount(1))'
3221225472 3221225472
```

`None` 和小整数的“引用计数”是 3221225472，也就是 0xC0000000，一个固定的大数。3.12 起这些对象是**永生**的 (PEP 683)：解释器永远不会释放它们，所以也就不用再维护计数，加一减一变成了空操作。这个常量大到不会被加减到边界，是一种标记。

最后一个实验是 `del`。`del name` 删除的是**名字**，不是对象：

```python
name = "temp"
del name
try:
    print(name)  # noqa: F821
except NameError as exc:
    print("NameError:", exc)
```

```text
NameError: cannot access local variable 'name' where it is not associated with a value
```

这条消息的措辞值得读一遍：不是“`name` 没有定义”，而是“局部变量 `name` 没有关联值”。因为 `name` 在 `main()` 函数里被赋过值，编译器在编译时就确定它是局部变量；`del` 之后，名字存在，但是没有贴在任何对象上。（它的实际类型是 `UnboundLocalError`，是 `NameError` 的子类，所以 `except NameError` 抓得到。）

这套模型和 Rust 的所有权恰好相反。Python 里几个名字可以共享一个对象，谁最后一个放手谁负责释放；Rust 里 `let b = a` 是把所有权**移走**，`a` 从此不能用。我写了 6 行 Rust 验证（`rustc 1.97.1`，`rustfmt` 检查过）：

```rust
// error[E0382]: `a` is used after being moved into `b`
fn main() {
    let a = vec![1, 2, 3];
    let b = a;
    println!("{:?} {:?}", a, b);
}
```

```text
$ rustc --edition 2024 move.rs
error[E0382]: borrow of moved value: `a`
 --> move.rs:5:27
  |
3 |     let a = vec![1, 2, 3];
  |         - move occurs because `a` has type `Vec<i32>`, which does not implement the `Copy` trait
4 |     let b = a;
  |             - value moved here
5 |     println!("{:?} {:?}", a, b);
  |                           ^ value borrowed here after move
  |
help: consider cloning the value if the performance cost is acceptable
  |
```

同样的 `b = a`，Python 给你两张便利贴，Rust 给你一个编译错误。Rust 的做法在编译期就排除了“两个名字改同一个东西”的惊喜，Python 的做法让你可以随便共享，但惊喜要靠你自己的心智模型来避免。Rust 一侧的细节在 [所有权](/posts/rust-by-pebble-02-ownership/) 那一篇。

## 动态类型，强类型

“Python 是动态类型语言”这句话常被误读成“Python 不检查类型”。其实有两件互相独立的事：

- **动态**：名字没有类型，对象才有。同一个名字可以先贴到 `int` 上，再贴到 `str` 上。
- **强**：运算不会悄悄地把类型转来转去，类型对不上就报错。

```text
$ python3 -c 'x = 1; print(type(x)); x = "one"; print(type(x))'
<class 'int'>
<class 'str'>
$ python3 -c 'print("1" + 1)'
Traceback (most recent call last):
  File "<string>", line 1, in <module>
    print("1" + 1)
          ~~~~^~~
TypeError: can only concatenate str (not "int") to str
```

JavaScript 会把 `"1" + 1` 算成 `"11"`，Python 拒绝。这是强类型。而且这个检查发生在**运行时**：只有这一行真的执行到，才会报错，写错了的分支不执行就永远不报。

类型标注呢？不检查。`lab/ch01/` 里没有专门的实验，我现场验证：

```python
def shout(text: int) -> int:
    return text * 2


print(shout("ab"))
```

```text
abab
```

标注 `text: int`，传进去字符串，函数照样跑，因为 `"ab" * 2` 在 Python 里合法。标注是给人和静态检查器（第 14 篇的 mypy 和 pyright）看的，解释器基本不管它，只是把它存到函数对象上。

`lab/ch01/none_add_fail.py` 演示动态类型里最常见的一类错误：

```python
def find_count(table: dict[str, int], key: str) -> int | None:
    """Return the count for key, or None if it is missing."""
    return table.get(key)


def main() -> None:
    """Trigger the TypeError on purpose."""
    counts = {"rust": 3}
    # error: TypeError: unsupported operand type(s) for +: 'NoneType'
    # and 'int'
    print(find_count(counts, "python") + 1)
```

```text
$ python3 lab/ch01/none_add_fail.py
Traceback (most recent call last):
  File "/home/bfmhno3/Projects/sift/lab/ch01/none_add_fail.py", line 18, in <module>
    main()
    ~~~~^^
  File "/home/bfmhno3/Projects/sift/lab/ch01/none_add_fail.py", line 14, in main
    print(find_count(counts, "python") + 1)
          ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~^~~
TypeError: unsupported operand type(s) for +: 'NoneType' and 'int'
$ echo $?
1
```

`dict.get` 找不到键时返回 `None`，函数的标注老老实实写了 `int | None`，但是调用的人没看，直接加了 1。解释器在运行时才发现，退出码是 1。这类错误有名字，叫“忘了处理 `None`”，Rust 的 `Option` 就是为消灭它设计的。3.14 的回溯里那排 `~~~^^^` 指出了出错的子表达式，是 3.11 加入的，读错误信息时多看一眼，往往不用再加 `print` 调试。

### 真值和 `None`

`if x:` 里的 `x` 不需要是 `bool`。`lab/ch01/truthiness.py` 打印了十几个对象的真值，下面是 stdout 的前 18 行：

```text
NoneType  None                                False
bool      False                               False
int       0                                   False
float     0.0                                 False
complex   0j                                  False
str       ''                                  False
bytes     b''                                 False
list      []                                  False
tuple     ()                                  False
dict      {}                                  False
set       set()                               False
range     range(0, 0)                         False
str       '0'                                 True
str       ' '                                 True
list      [0]                                 True
Empty     <__main__.Empty object at 0x7ffff6  False
Flag      <__main__.Flag object at 0x7ffff6f  False
Flag      <__main__.Flag object at 0x7ffff6f  True
```

规则是：数字零、空容器、`None`、`False` 是假，其他都是真。`'0'` 是真（它是一个非空字符串），`[0]` 是真（它是一个非空列表）。自己的类可以通过 `__bool__` (`Flag`) 或者 `__len__`（`Empty`，长度 0 就是假）来决定自己的真值，第 6 篇会正式讲。

真值转换让 `and` 和 `or` 返回的是**操作数本身**，而不是 `True`/`False`：

```text
[] == False: False
0 == False: True
'' or 'default': default
'x' and 'y': y
None or 0 or []: []
```

`'' or 'default'` 是常用的“取默认值”写法；`None or 0 or []` 一路都是假，返回最后一个操作数 `[]`。注意 `[] == False` 是 `False`，`0 == False` 是 `True`：**空列表是假值，但它不等于 `False`**。`0 == False` 为真是因为 `bool` 是 `int` 的子类，下面会看到。

## 数

### `int`：没有溢出

`repl_tour.py` 里：

```text
2**200                      1606938044258990275541962092341162602522202993782792835301376 int
digits in 2**200: 61
bit_length of 2**200: 201
```

`2**200` 有 61 位十进制数字，201 个二进制位。

拿 Rust 对照，我写了一个把 `i64::MAX` 加 1 的程序，同时顺手算了 `-17 / 5` 和 `-17 % 5`（下面除法一节用）。运算数来自 `args().count()`，是为了不让编译器在编译期就拒绝这个明显的溢出：

```rust
// args().count() hides the values from the compile-time overflow lint
fn main() {
    let a: i64 = -17 + std::env::args().count() as i64 - 1;
    println!("{} {}", a / 5, a % 5);
    let x: i64 = i64::MAX - 1 + std::env::args().count() as i64;
    println!("{}", x + 1);
}
```

分别用发布和调试模式编译：

```text
$ rustc --edition 2024 -O -o div_release div.rs && ./div_release
-3 -2
-9223372036854775808
$ rustc --edition 2024 -o div_debug div.rs && ./div_debug
-3 -2

thread 'main' (207056) panicked at div.rs:6:20:
attempt to add with overflow
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
```

发布模式悄悄回绕成最小值 (`-9223372036854775808`)，调试模式 panic。Python 里 `2**63` 就是 `9223372036854775808`，`(2**63) * (2**63)` 也不会出事：

```text
$ python3 -c 'print(2**63, 2**64 + 1, (2**63) * (2**63))'
9223372036854775808 18446744073709551617 85070591730234615865843651857942052864
```

代价是速度和内存（上面的 28 字节）。有一个后果要知道：把一个超过 4300 位的 `int` 转成字符串会被拒绝，这是为了防止恶意输入让二次复杂度的转换拖死服务，上面 `sys.int_info` 里的 `default_max_str_digits=4300` 就是这个限制：

```text
$ python3 -c 'str(10**5000)'
Traceback (most recent call last):
  File "<string>", line 1, in <module>
    str(10**5000)
    ~~~^^^^^^^^^^
ValueError: Exceeds the limit (4300 digits) for integer string conversion; use sys.set_int_max_str_digits() to increase the limit
```

### `float`：IEEE 754

```text
0.1 + 0.2                   0.30000000000000004     float
0.1 + 0.2 == 0.3: False
math.isclose: True
```

这不是 Python 的毛病，是 IEEE 754 双精度的：1 位符号、11 位指数、52 位尾数。`0.1` 在二进制里是一个无限循环小数，存进去必须截断：

```text
$ python3 -c 'print((0.1).hex(), (0.1).as_integer_ratio())'
0x1.999999999999ap-4 (3602879701896397, 36028797018963968)
```

`0.1` 实际存的是 3602879701896397 / 2^55，不是 1/10。两个这样的近似值相加，再和 `0.3` 的近似值比，最后一位对不上。所以比较浮点数用 `math.isclose`，容差默认是相对 1e-9。机器精度可以直接问：`sys.float_info.epsilon` 是 `2.220446049250313e-16`，`sys.float_info.dig` 是 15，也就是十进制能可靠保留 15 位有效数字。溢出的方向也和整数不一样：

```text
$ python3 -c 'print(float("inf"), 1e308*10)'
inf inf
```

浮点数溢出得到的是无穷大，不是异常也不是回绕。BM25 要算对数和除法，第 8 篇再回来对付这些问题。

### `bool` 是 `int` 的子类，`None` 是单例

```text
True + True: 2
bool is int subclass: True
```

`True` 就是 `1`，`False` 就是 `0`，所以 `sum(x > 3 for x in xs)` 可以统计满足条件的个数。`None` 则是 `NoneType` 的唯一实例，只有一个，所以用 `is` 比较是对的。

### 除法、取余和 `**`

```text
divmod(17, 5): (3, 2)
divmod(-17, 5): (-4, 3)
-17 // 5: -4 | -17 % 5: 3
17 // -5: -4 | 17 % -5: -3
7 / 2: 3.5 | 7 // 2: 3 | 2 ** -1: 0.5
```

四个运算符的规则：`/` 永远得到 `float`；`//` 是**向下取整**的整除（往负无穷方向），`%` 的结果和除数同号，`divmod(a, b)` 一次给出两者，满足 `a == (a // b) * b + a % b`。`-17 // 5` 是 -4 而不是 -3，因为 -3.4 向下取整是 -4。`2 ** -1` 得到浮点数 `0.5`，负指数不能保持整数。

C、C++ 和 Rust 的整数除法是向零截断的，所以同样的数字会得到不同的答案。我在上面那个 Rust 程序里顺便算了 `-17 / 5` 和 `-17 % 5`，打印的是 `-3 -2`：Rust 的余数跟被除数同号。从 Rust 或者 C 移植代码到 Python，这是最容易悄悄出错的地方之一。

### 链式比较和海象运算符

```text
1 < x < 10: True
1 < x < 3: False
```

`1 < x < 10` 不是先算 `1 < x` 得到布尔值再拿它去比 10，而是 `1 < x and x < 10`，而且 `x` 只求值一次。反汇编看一下：

```text
$ python3 -c 'import dis; dis.dis("1 < x < 10")'
  0           RESUME                   0

  1           LOAD_SMALL_INT           1
              LOAD_NAME                0 (x)
              SWAP                     2
              COPY                     2
              COMPARE_OP               2 (<)
              COPY                     1
              TO_BOOL
              POP_JUMP_IF_FALSE        6 (to L1)
              NOT_TAKEN
              POP_TOP
              LOAD_SMALL_INT          10
              COMPARE_OP               2 (<)
              RETURN_VALUE
      L1:     SWAP                     2
              POP_TOP
              RETURN_VALUE
```

`x` 只 `LOAD_NAME` 了一次，`COPY` 复制栈顶供两次比较用；第一个比较为假就跳到 `L1` 直接返回，第二个比较根本不执行（短路）。

`:=`（海象运算符）是“在表达式里赋值”。`repl_tour.py` 里的 `while`：

```python
data = [3, 1, 4, 1, 5, 9, 2, 6]
queue = data[:]
while (n := len(queue)) > 5:
    queue.pop()
    print(f"walrus: len was {n}, now {len(queue)}")
```

```text
walrus: len was 8, now 7
walrus: len was 7, now 6
walrus: len was 6, now 5
```

`(n := len(queue)) > 5` 在判断的同时把长度存进 `n`，循环体里可以直接用，不用再调一次 `len`。`data[:]` 是切片，造了一份拷贝，否则 `queue` 和 `data` 就是同一个列表。

## 控制流

`if`/`elif`/`else`、`for`、`while`，没有大括号，**缩进就是语法**。下面是我在 `/tmp` 里写的一个演示（不在仓库里，我想把几个容易忘的形状放在一起）：

```python
for n in [3, 8, 12]:
    if n < 5:
        print(n, "small")
    elif n < 10:
        print(n, "medium")
    else:
        print(n, "large")

for word in ["tea", "bike", "kalman"]:
    if word.startswith("k"):
        print("found", word)
        break
else:
    print("no k-word")

for word in ["tea", "bike"]:
    if word.startswith("k"):
        break
else:
    print("no k-word")

i = 0
while i < 5:
    i += 1
    if i % 2 == 0:
        continue
    print("odd", i)
else:
    print("while finished without break, i =", i)


def todo():
    pass


print(todo())
```

```text
3 small
8 medium
12 large
found kalman
no k-word
odd 1
odd 3
odd 5
while finished without break, i = 5
None
```

最容易让人愣一下的是 `for ... else` 和 `while ... else`：`else` 分支在**循环没有被 `break` 打断**时执行。第一个 `for` 找到了 `kalman` 就 `break`，`else` 没有跑；第二个 `for` 一路走完，`else` 跑了，打印 `no k-word`。所以 `else` 的意思更接近“没找到”。我觉得这个关键字选得不好（叫 `nobreak` 会直白得多），但你读别人的代码迟早会碰上。`continue` 跳过本轮剩下的部分；`pass` 什么也不做，只用来占位，因为空缩进块是语法错误；没有 `return` 的函数返回 `None`，上面最后一行的 `None` 就是 `todo()` 的返回值。

缩进写错是什么后果？`lab/ch01/indent_syntaxerror.py` 编译两段写坏的源码。这两段源码放在字符串里，由 `compile()` 编译，所以文件本身是合法的，错误在运行时抛出。第一段是缩进不一致：

```text
IndentationError: unindent does not match any outer indentation level at line 3
```

第二段在同一个块里混用了制表符和空格，Python 3 拒绝这么做：

```text
$ python3 lab/ch01/indent_syntaxerror.py
...
  File "<mixed>", line 3
    	y = 2
    ^
TabError: inconsistent use of tabs and spaces in indentation
```

`TabError` 和 `IndentationError` 都是 `SyntaxError` 的子类，所以它们在程序**开始执行之前**就会暴露，不需要运行到那一行。不过注意这个文件名里的 `syntaxerror`：它的退出码是 1，实验场的运行器把后缀是 `_syntaxerror.py` 的文件也当成“应该失败”的，和 `_fail.py` 一样。

## 函数和 f-string

`def` 在运行时执行，它造一个函数对象，再把名字贴上去。Sift 里第一个函数是 `count_words`：

```python
def count_words(text: str, words: list[str]) -> int:
    """Return the total case-insensitive occurrences of words in text."""
    lowered = text.lower()
    return sum(lowered.count(word) for word in words)
```

参数后面的 `: str`、`-> int` 是标注，上面看到了解释器基本不管它；三引号字符串是**文档字符串**，放在函数第一行，会存进 `__doc__`（`help()` 打印的就是它）。`list[str]` 这种写法需要 3.9，`int | None` 需要 3.10，我们的 `requires-python` 是 3.14，所以随便用。

输出行用的是 f-string，在引号前面加 `f`，大括号里放表达式，冒号后面是格式规格：

```python
print(f"{count:>6}  {path}")
```

`>6` 是“右对齐，宽 6 格”。更多的格式规格我在 `/tmp` 里跑了一遍：

```python
count, path = 23, "corpus/posts/kalman-filter-01-one-dimension.md"
print(f"{count:>6}  {path}")
print(f"{count = }")
print(f"{4614185:,} bytes, {1 / 3:.3f}, {count:08.2f}, {count!r}")
```

```text
    23  corpus/posts/kalman-filter-01-one-dimension.md
count = 23
4,614,185 bytes, 0.333, 00023.00, 23
```

`{count = }` 打印“表达式 = 值”，调试时很好用；`:,` 加千位分隔；`.3f` 保留三位小数；`08.2f` 是总宽 8、补零、两位小数；`!r` 调用 `repr()` 而不是 `str()`。格式规格的完整语法和 3.14 的新成员模板字符串，是第 2 篇的主题。

## Sift 的第 0 版

现在可以读懂整个 `src/sift/__main__.py` 了。它有 48 行，三个函数。第一个是上面的 `count_words`。第二个扫描目录：

```python
def search(root: Path, words: list[str]) -> tuple[list[tuple[int, Path]], int]:
    """Scan every Markdown file under root.

    Return the hits as (count, path) sorted by count descending, then
    path, together with the number of files scanned.
    """
    lowered = [word.lower() for word in words]
    hits: list[tuple[int, Path]] = []
    n_files = 0
    for path in sorted(root.glob("*.md")):
        n_files += 1
        count = count_words(path.read_text(encoding="utf-8"), lowered)
        if count:
            hits.append((count, path))
    hits.sort(key=lambda hit: (-hit[0], hit[1]))
    return hits, n_files
```

逐行看：

- `root.glob("*.md")` 是 `pathlib` 的通配符，返回的是 `Path` 对象的**生成器**（第 5 篇），顺序由文件系统决定，所以外面套了 `sorted`，保证输出可复现。
- `path.read_text(encoding="utf-8")` 一次读完整个文件并解码成 `str`。显式写 `encoding` 是因为不写的话，默认编码取决于系统的区域设置，同一份代码在不同机器上行为可能不同。
- `if count:` 用的就是上一节的真值：0 是假，所以没命中的文件不会进列表。
- `hits.sort(key=lambda hit: (-hit[0], hit[1]))` 是这一段里最紧凑的一行。`key` 给每个元素算一个排序用的键，这里是一个二元组：先比 `-count`（取负，让大的排前面），分数相同再比路径。元组的比较是逐元素的，所以这一行同时完成了“按次数降序、同分按路径升序”。`lambda` 是没有名字的小函数，第 4 篇细讲。
- 返回值是一个二元组：命中列表和扫描的文件数，所以返回类型标注嵌套了两层 `tuple[list[tuple[int, Path]], int]`，已经难读了；第 14 篇学类型别名的时候，这是第一个会被改写的目标。

第三个函数是入口：

```python
def main() -> None:
    """Print the top 10 files for the words given on the command line."""
    words = sys.argv[1:]
    if not words:
        sys.exit("usage: python -m sift <word> [<word>...]")
    start = time.perf_counter()
    hits, n_files = search(CORPUS, words)
    elapsed_ms = (time.perf_counter() - start) * 1000
    for count, path in hits[:10]:
        print(f"{count:>6}  {path}")
    print(f"searched {n_files} files in {elapsed_ms:.1f} ms")
```

`sys.argv` 是命令行参数列表，`argv[0]` 是程序名，所以 `[1:]` 是用户给的词。没有词就 `sys.exit(消息)`：给 `sys.exit` 传一个字符串，它会把字符串写到 stderr，退出码是 1：

```text
$ python3 -m sift; echo "exit $?"
usage: python -m sift <word> [<word>...]
exit 1
```

`time.perf_counter()` 是计时用的单调时钟，两次相减得到秒，乘 1000 变毫秒。注意计时只包住了 `search`，不包括解释器启动和 `import`，所以程序自己报的 20 ms 比你从外面量到的要小，下面马上要比。

### 它的毛病

这个版本是为了有东西可以比，质量不是目标，毛病很多，其中有几条我现在就能演示。

**它数的是子串，不是单词。** 搜 `rust`，`rustc`、`rustup`、`rust-lab` 全算，`trust` 也算：

```text
$ python3 -m sift rust | sed -n '1,3p'
   201  corpus/posts/rust-by-pebble-13-ffi-nostd.md
   165  corpus/posts/rust-by-pebble-08-rc-refcell-values.md
   152  corpus/posts/rust-by-pebble-01-first-crate.md
```

第 3 行的 152，我用 `re` 在同一篇里数了整词匹配：

```text
substring rust: 152 | whole word: 131
```

差了 21 次，是 `rustc`、`rustup` 之类的。到底哪个更对，取决于你想要什么；第 2 篇我们会让分词器来回答。

**多个词是简单相加。** 搜 `kalman filter`，每个词的命中数加起来：

```text
$ python3 -m sift kalman filter | sed -n '1,6p'
    42  corpus/posts/kalman-filter-02-multivariate.md
    39  corpus/posts/kalman-filter-01-one-dimension.md
    34  corpus/posts/kalman-filter-08-porting.md
    30  corpus/posts/kalman-filter-07-ukf.md
    28  corpus/posts/kalman-filter-06-eskf.md
    28  corpus/posts/rust-by-pebble-12-vm-backends.md
```

一篇 Pebble 的文章排到了第 6，因为它提到了很多次 `filter`（Rust 的 `Iterator::filter`），但一次 `kalman` 都没有。搜索引擎应该要求两个词同时出现，并且让不常见的词 (`kalman`) 比常见的词 (`filter`) 更重要。这就是后面的 AND、TF-IDF 和 BM25。

**中文碰巧能用，但不是因为它对。** 子串匹配不需要分词，所以 `所有权` 搜得到：

```text
$ python3 -m sift 所有权 | sed -n '1,3p'
     7  corpus/posts/rust-by-pebble-02-ownership.md
     6  corpus/posts/rust-by-pebble-08-rc-refcell-values.md
     5  corpus/posts/rust-by-pebble-12-vm-backends.md
```

它只是碰巧工作。“所有”这个词会匹配“所有权”也会匹配“所有的人”，我们没法区分，下一章的 CJK 二元分词就是为了这个。

**它很慢**，慢到什么程度？

### 多慢

程序自己报的是 20 ms 左右。从外面用 `hyperfine` 量整个进程，并且和 `grep` 对比，这是 `lab/ch01/extra.sh` 做的事：

```text
$ make ch01   # 其中的 extra.sh 输出，保存在 out/ch01/naive_vs_grep.txt
Benchmark 1: python3 -m sift kalman
  Time (mean ± σ):      54.5 ms ±   3.6 ms    [User: 43.4 ms, System: 10.6 ms]
  Range (min … max):    48.8 ms …  60.3 ms    20 runs

Benchmark 2: grep -rci kalman corpus/posts
  Time (mean ± σ):       8.3 ms ±   1.3 ms    [User: 4.8 ms, System: 3.3 ms]
  Range (min … max):     6.7 ms …  11.5 ms    20 runs

Summary
  grep -rci kalman corpus/posts ran
    6.54 ± 1.13 times faster than python3 -m sift kalman
python/grep ratio: 6.5x
```

54.5 ms 对 8.3 ms，`grep` 快 6.5 倍。我同一天另外跑过几次这个脚本：一次是 58.2 ms 对 6.6 ms，比值 8.8 倍；一次是去掉 shell 开销的 `hyperfine -N`，50.4 ms 对 6.7 ms，7.5 倍。`grep` 只有几毫秒，`hyperfine` 自己也警告了“命令不到 5 ms，结果可能不准”，所以我只想说：**比值在 6.5 到 8.8 之间，量级是 7 倍上下**，不要记住小数点后面。

这个比较并不公平，原因有两条：

1. `grep -c` 数的是**包含这个词的行数**，不是出现次数。同一个文件 `kalman-filter-01-one-dimension.md`，Sift 报 23，`grep -c` 报 20，`grep -o ... | wc -l` 才是 23。两个程序做的不是同一件事。
2. 一个 Python 进程什么都不干也要启动。拿 `-N` 模式量：

```text
$ hyperfine -N --warmup 3 --runs 30 'python3 -m sift kalman' 'python3 -m sift zzzzqq' 'python3 -c pass' 'grep -rci kalman corpus/posts' | grep -E 'Benchmark|Time'
Benchmark 1: python3 -m sift kalman
  Time (mean ± σ):      50.4 ms ±   4.3 ms    [User: 38.4 ms, System: 11.2 ms]
Benchmark 2: python3 -m sift zzzzqq
  Time (mean ± σ):      51.1 ms ±   5.2 ms    [User: 39.0 ms, System: 11.3 ms]
Benchmark 3: python3 -c pass
  Time (mean ± σ):      22.4 ms ±   2.2 ms    [User: 15.4 ms, System: 6.5 ms]
Benchmark 4: grep -rci kalman corpus/posts
  Time (mean ± σ):       6.7 ms ±   0.6 ms    [User: 3.8 ms, System: 2.6 ms]
```

`python3 -c pass` 是什么也不做的 Python，22.4 ms，已经是 `grep` 全部工作量的 3.3 倍。搜 `kalman`（有 124 处命中）和搜一个不存在的 `zzzzqq`（0 处命中）耗时一样，说明**时间花在读文件上，不花在计数上**。

我把这 20 ms 拆开。下面全部用同一个口径：`hyperfine -N` 量整个进程（上面那组 50.4 ms），程序自己的计时器量搜索本身（20.0 ms，上面第一条命令打印的），再用 `/tmp` 里另写的一个脚本（先把 123 个文件全读成 `str`，再 `lower` 加 `count`）把搜索那一段拆成两半：

```text
read+decode 14.1 ms, lower+count 8.8 ms, total kalman 124, chars 3320875
```

| 步骤 | 耗时 |
| --- | --- |
| 解释器启动 (`python3 -c pass`) | 22.4 ms |
| `search()` 本身（程序自己的计时器） | 20.0 ms |
| 其余：`import`、`runpy` 之类 | 约 8 ms（50.4 减去前两行，没有单独量，大概是导入 `pathlib` 等标准库模块） |
| 合计 (`python3 -m sift kalman`) | 50.4 ms |

`search()` 那 20 ms 里，拆分脚本给出读文件加 UTF-8 解码 14.1 ms、`lower()` 加 `count()` 8.8 ms，加起来是 22.9 ms，比 20.0 多 2.9 ms：它们是不同的两次运行，而且拆分脚本一次性把所有文本留在内存里，不是同一个程序，所以只能当成大致的比例，读文件占六成多，计数占不到四成。

吞吐是 4,614,185 字节除以 20 ms，约 230 MB/s。这是我们要超过的基线。后面 24 个章节里，每一次说“更快”，说的都是相对于这 20 ms（以及 `bench/queries.txt` 里的 12 条查询）。
## 风格：PEP 8 和 ruff

Python 有一份社区公认的风格文档，PEP 8：4 个空格缩进，`snake_case` 命名函数和变量，`CapWords` 命名类，行宽 79，导入放文件顶部并分组，等等。我不想在这上面花讨论的力气，所以全部交给工具。`ruff` 是用 Rust 写的 Python 格式化器加检查器，仓库根目录的 `ruff.toml` 只有 9 行：

```toml
line-length = 79
target-version = "py314"
extend-exclude = ["lab/**/*_syntaxerror.py", "corpus"]

[lint]
select = ["E", "F", "W", "I", "B", "UP", "SIM"]

[format]
quote-style = "double"
```

`line-length = 79` 是 PEP 8 的数字（ruff 默认是 88，所以我把它写死在配置里，命令行里也显式传）。`select` 开了 7 组规则：`E`/`W` 是 pycodestyle（风格），`F` 是 pyflakes（未使用的变量和导入、未定义的名字），`I` 是导入排序，`B` 是 bugbear（一批容易写错的写法），`UP` 是 pyupgrade（提示用新语法），`SIM` 是 simplify。`extend-exclude` 排除了 `*_syntaxerror.py`，这类文件里可能有格式化器解析不了的源码（虽然本章那个文件把坏代码放在字符串里，没有这个问题）。

我写了一个故意写乱的 5 行文件，看它们各自抓什么：

```python
import os,sys
def add( a,b ):
    unused = 1
    return a+b
print(add(1,2))
```

```text
$ ruff format --check --line-length 79 --diff messy.py
--- messy.py
+++ messy.py
@@ -1,5 +1,9 @@
-import os,sys
-def add( a,b ):
+import os, sys
+
+
+def add(a, b):
     unused = 1
-    return a+b
-print(add(1,2))
+    return a + b
+
+
+print(add(1, 2))

1 file would be reformatted
$ ruff check --output-format concise messy.py
messy.py:1:1: E401 [*] Multiple imports on one line
messy.py:1:1: I001 [*] Import block is un-sorted or un-formatted
messy.py:1:8: F401 [*] `os` imported but unused
messy.py:1:11: F401 [*] `sys` imported but unused
messy.py:3:5: F841 Local variable `unused` is assigned to but never used
Found 5 errors.
[*] 4 fixable with the `--fix` option (1 hidden fix can be enabled with the `--unsafe-fixes` option).
```

两个工具分工明确：`ruff format` 只管排版（空格、空行、引号），不改语义；`ruff check` 管内容（没用的导入、没用的变量），能自动修的带 `[*]`。`E401` 说一行导入了两个模块，`I001` 说导入块没排序（这两条和格式化器的结果重叠）。5 个错误里 4 个能自动修，第 5 个 `F841`（没用的局部变量）涉及删赋值语句，ruff 觉得可能有副作用，默认不动，要你自己决定。

`make lint` 把两条都跑一遍，对整个仓库：

```text
$ make lint
ruff format --check --line-length 79 .
17 files already formatted
ruff check .
All checks passed!
```

17 比 `.py` 文件的数量多，因为 ruff 0.16 也会过一遍 Markdown 文件里的 Python 代码块（加 `-v` 能看到它把 `README.md` 和 8 篇迷你语料都列了进去）；被 `extend-exclude` 排除的 `indent_syntaxerror.py` 也在 `-v` 里被点了名。仓库里确实有几处故意违规，比如 `truthiness.py` 里的 `[] == False`，它的右边带着 `# noqa: E712`，告诉检查器“这一行我是故意的”。**故意违规必须说出理由**：每个 `noqa` 都对应实验要演示的东西，每个会失败的实验在出错的那一行上面都有一行 `# error: ...` 注释写明预期的错误，上面 `none_add_fail.py` 里你已经看到了。

## 实验场运行器

最后说说实验场本身，因为你会天天用它。`make ch01` 展开之后就是 `python3 scripts/chapter.py ch01`，这个 95 行的脚本（只用标准库）干的事很简单：

1. 找 `lab/ch01/*.py`，按文件名排序，一个一个用 `python3` 跑，工作目录是仓库根；
2. 环境里固定 `PYTHONHASHSEED=0`（让字符串的哈希可复现，第 3 篇会解释为什么需要），以及两个后面才用到的 `QT_QPA_PLATFORM=offscreen` 和 `MPLBACKEND=Agg`；
3. 每个脚本最多跑 300 秒；
4. 标准输出写进 `out/ch01/<名字>.stdout`，标准错误写进 `.stderr`；
5. 如果有 `lab/ch01/extra.sh`，最后用 bash 跑它。

判断“成功”靠文件名后缀，是整个系列里最重要的约定：

```python
def should_fail(stem: str) -> bool:
    """Return True if the file is expected to exit non-zero."""
    return stem.endswith(("_fail", "_syntaxerror"))
```

`_fail.py` 和 `_syntaxerror.py` **必须**以非零状态退出，其他文件**必须**以 0 退出。这样“演示错误的实验”也可以被自动验证：错误没有出现，反而是失败。后面还有两个后缀：`_ft.py` 用自由线程版的 `python3.14t` 跑，`_gui.py` 在虚拟显示器 Xvfb 里跑，本篇都没有用到。

```text
$ make ch01
python3 scripts/chapter.py ch01
ok   lab/ch01/bytecode_peek.py
ok   lab/ch01/indent_syntaxerror.py
ok   lab/ch01/names_and_objects.py
ok   lab/ch01/none_add_fail.py
ok   lab/ch01/repl_tour.py
ok   lab/ch01/truthiness.py
ok   lab/ch01/extra.sh
```

（`extra.sh` 的 `hyperfine` 输出会夹在最后两行中间，上面省略了，前文已经完整贴过。）注意 `none_add_fail.py` 和 `indent_syntaxerror.py` 这两行也是 `ok`，因为它们按预期失败了。所有输出都在 `out/` 里，这个目录不进 git，要看某个实验的原始输出就去那里：

```text
$ ls out/ch01
bytecode_peek.stderr
bytecode_peek.stdout
indent_syntaxerror.stderr
indent_syntaxerror.stdout
naive_vs_grep.json
naive_vs_grep.txt
names_and_objects.stderr
names_and_objects.stdout
none_add_fail.stderr
none_add_fail.stdout
repl_tour.stderr
repl_tour.stdout
truthiness.stderr
truthiness.stdout
```

本篇里所有 `Traceback` 都是从对应的 `.stderr` 里复制的。

整个仓库的“通过”标准是 `make ci`：先 `make lint`，再跑所有章节。它应该永远是绿的。

## 本篇文件

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`src/sift/__main__.py`](https://github.com/bfmhno3/sift/blob/ch01/src/sift/__main__.py) | `python3 -m sift kalman` | 退出码 0，打印 10 行，最后一行 `searched 123 files in 20.0 ms`；第 2 篇起改用分词器，第 3 篇起拆出索引 |
| [`src/sift/__init__.py`](https://github.com/bfmhno3/sift/blob/ch01/src/sift/__init__.py) | `python3 -c 'import sift'` | 空文件，0 行；让 `sift` 成为一个包 |
| [`lab/ch01/repl_tour.py`](https://github.com/bfmhno3/sift/blob/ch01/lab/ch01/repl_tour.py) | `python3 lab/ch01/repl_tour.py` | 退出码 0，第一行 `256 is 256 (built at runtime): True` |
| [`lab/ch01/names_and_objects.py`](https://github.com/bfmhno3/sift/blob/ch01/lab/ch01/names_and_objects.py) | `python3 lab/ch01/names_and_objects.py` | 退出码 0，第一行 `a is b: True` |
| [`lab/ch01/truthiness.py`](https://github.com/bfmhno3/sift/blob/ch01/lab/ch01/truthiness.py) | `python3 lab/ch01/truthiness.py` | 退出码 0，最后一行 `None or 0 or []: []` |
| [`lab/ch01/bytecode_peek.py`](https://github.com/bfmhno3/sift/blob/ch01/lab/ch01/bytecode_peek.py) | `python3 lab/ch01/bytecode_peek.py` | 退出码 0，反汇编 7 条指令，最后一行 `50` |
| [`lab/ch01/none_add_fail.py`](https://github.com/bfmhno3/sift/blob/ch01/lab/ch01/none_add_fail.py) | `python3 lab/ch01/none_add_fail.py` | 退出码 1：`TypeError: unsupported operand type(s) for +: 'NoneType' and 'int'` |
| [`lab/ch01/indent_syntaxerror.py`](https://github.com/bfmhno3/sift/blob/ch01/lab/ch01/indent_syntaxerror.py) | `python3 lab/ch01/indent_syntaxerror.py` | 退出码 1：先在 stdout 打印 `IndentationError: unindent does not match any outer indentation level at line 3`，再抛出 `TabError: inconsistent use of tabs and spaces in indentation` |
| [`lab/ch01/extra.sh`](https://github.com/bfmhno3/sift/blob/ch01/lab/ch01/extra.sh) | `bash lab/ch01/extra.sh` | 退出码 0，最后一行 `python/grep ratio: 6.5x`（多次运行在 6.5 到 8.8 之间） |
| [`flake.nix`](https://github.com/bfmhno3/sift/blob/ch01/flake.nix)、[`flake.lock`](https://github.com/bfmhno3/sift/blob/ch01/flake.lock)、[`.envrc`](https://github.com/bfmhno3/sift/blob/ch01/.envrc) | `nix develop` | 打印横幅 `sift dev shell: Python 3.14.7, ...`；`.envrc` 是 `use flake`，装了 direnv 的话进目录自动进环境；整个系列的工具版本都在这里，之后基本不动 |
| [`Makefile`](https://github.com/bfmhno3/sift/blob/ch01/Makefile) | `make ch01` | 退出码 0，7 行 `ok`；在 `nix develop` 外面运行会报 `Makefile:2: *** run inside nix develop.  Stop.`；后面章节会陆续加 `test`、`typecheck` 等目标 |
| [`ruff.toml`](https://github.com/bfmhno3/sift/blob/ch01/ruff.toml) | `make lint` | 退出码 0，`17 files already formatted` 和 `All checks passed!` |
| [`scripts/chapter.py`](https://github.com/bfmhno3/sift/blob/ch01/scripts/chapter.py) | `python3 scripts/chapter.py ch01` | 退出码 0，实验场运行器，只用标准库 |
| [`scripts/fetch-corpus.sh`](https://github.com/bfmhno3/sift/blob/ch01/scripts/fetch-corpus.sh) | `./scripts/fetch-corpus.sh` | 退出码 0，`corpus: 123 posts at 2c3f11a4fefafdfd6baa58bd3e09db679227cbcc`，在临时目录里用了 86 秒 |
| [`tests/fixtures/mini/`](https://github.com/bfmhno3/sift/tree/ch01/tests/fixtures/mini) | `ls tests/fixtures/mini` | 8 篇虚构主题的迷你文章（茶、自行车、编译器、河流），本篇没用到，第 2 篇起的实验和第 10 篇起的测试会用 |
| [`bench/queries.txt`](https://github.com/bfmhno3/sift/blob/ch01/bench/queries.txt) | `wc -l bench/queries.txt` | 12 行，每条一个基准查询，第 8 篇起开始用 |
| [`README.md`](https://github.com/bfmhno3/sift/blob/ch01/README.md)、[`.gitignore`](https://github.com/bfmhno3/sift/blob/ch01/.gitignore)、[`LICENSE-MIT`](https://github.com/bfmhno3/sift/blob/ch01/LICENSE-MIT)、[`LICENSE-APACHE`](https://github.com/bfmhno3/sift/blob/ch01/LICENSE-APACHE) | `git ls-tree -r --name-only ch01` | 代码双许可（MIT 或 Apache-2.0）；语料另有 CC BY-NC-SA 4.0，所以不提交 |

## 练习

**1.** 先不要运行，预测输出，再运行验证：

```python
a = [1, 2]
b = a
b += [3]
print(a, b, a is b)

t = (1, 2)
u = t
u += (3,)
print(t, u, t is u)
```

两段代码的 `+=` 看起来一模一样，答案却不同。把你的预测和结果之间的差异写下来，然后想一想：上面 `names_and_objects.py` 里的 `b = b + [5]` 和这里的 `b += [3]` 有什么区别。（这件事第 3 篇会讲透。）

**2.** 当前的 `CORPUS = Path("corpus/posts")` 是相对路径，在别的目录里跑就会得到“搜了 0 个文件，退出码 0”。把它改成由 `__main__.py` 自己的位置推出来的绝对路径（提示：`__file__` 是模块的文件路径，`Path` 有 `resolve()` 和 `parents`），然后在 `/tmp` 里 `python3 -m sift kalman` 验证。你要在 `src/sift/__main__.py` 里数清楚该往上走几层。

**3.** 我在上面的字节码一节里说，函数里的局部变量用 `STORE_FAST`，模块顶层的变量用 `STORE_NAME`。把下面这个循环分别放在模块顶层和一个函数里，用 `hyperfine` 比较（我这里是 449.3 ms 对 231.6 ms，1.94 倍；你的数字会不同），再用 `dis` 找出两个版本里 `total += i` 对应的指令各是哪几条：

```python
total = 0
for i in range(5_000_000):
    total += i
print(total)
```

**4.** 我量到 `python3 -c pass` 是 22.4 ms，用 `-S` 选项（不导入 `site` 模块）是 13.1 ms，差了将近一半。`site` 做了什么？为什么在 Nix 的 Python 环境里它可能格外费时？这个问题我没有查，我的猜测是和那一大堆预装的包有关，你去验证它。

## 下一篇

下一篇是《[文本：str、bytes、Unicode 与正则](/posts/python-by-sift-02-text-and-unicode/)》。今天的数字里有一个我一直没解释：语料有 4,614,185 字节，但字符数只有 3,320,875。差出来的 130 万是中文占的 3 字节和 1 字节之间的差。搜索引擎要把“所有权”拆成什么才能找到它，取决于你怎么理解“一个字符”，而我们要从 Python 里的 `str` 到底是什么开始。

我猜等到系列结束，现在这 20 ms 会掉到个位数毫秒甚至更低（还没量过，所以只是猜）。但它可能要等到我们把读文件这一步整个绕开以后才发生：一次搜索如果还要把 123 个文件读一遍，不管用什么语言写，14 ms 的读盘加解码都在那里。
