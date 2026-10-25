---
title: "命令行体验与分发：typer、rich、uv 与 wheel"
commentId: "post:python-by-sift-19-typer-rich-uv"
published: "2026-10-25 12:00:00 +08:00"
description: "用 Sift 重学 Python 第 19 篇：我用 Python 3.14.7、typer 0.25.1、click 8.3.3、rich 15.0.0、uv 0.12.5、build 1.5.1 和 hatchling 1.31.0 把 Sift 的命令行从 argparse 换成 typer，输出换成 rich，再打成 wheel 装进干净的虚拟环境。换完之后 sift --help 从 144.5 毫秒变成 180.4 毫秒，sift --version 却从 143.6 毫秒变成 97.0 毫秒；慢的那 36 毫秒是 rich 画帮助页，设 TYPER_USE_RICH=0 就只要 81.0 毫秒；wheel 96,448 字节 49 个文件，sdist 298,117 字节装下了整个仓库，加一个 include 列表后 139,755 字节；同一个 wheel 装进新虚拟环境，pip 要 2.59 秒，uv 0.03 秒。"
category: Tutorial
tags:
  - Python
  - Sift
  - 命令行
  - typer
  - rich
  - uv
  - 打包
series: "用 Sift 重学 Python"
seriesOrder: 19
draft: false
comment: true
slug: python-by-sift-19-typer-rich-uv
---

我把 Sift 的命令行从 argparse 换成了 typer，换之前的预期很朴素：代码少一点，别的不变。然后我用 hyperfine 量了启动时间：`sift --help` 慢了 36 毫秒（145 到 180），`sift --version` 却快了 47 毫秒（144 到 97）。同一个库，一个变慢一个变快，差别在于 `--help` 要用 rich 画一个带边框的帮助页，而 `--version` 现在连 rich 和 asyncio 都不导入；把 rich 关掉，`--help` 只要 81 毫秒。这一篇从这几行数字出发：先看 typer 怎么把类型注解变成命令行，再看 rich 怎么画表格，最后用 uv 和 hatchling 把项目打成 wheel，装进一个什么都没有的虚拟环境。

```text
$ python3 /tmp/sift-scratch/ch19/startup_pair.py
sift --help     argparse                   144.5 ms
sift --help     typer                      180.4 ms
sift --help     typer, TYPER_USE_RICH=0     81.0 ms
sift --version  argparse                   143.6 ms
sift --version  typer                       97.0 ms
```

> [!NOTE] Note
> 这一篇结束时仓库处于标签 `ch19`（提交 `40e1608`）。改写的有 `src/sift/cli.py`（argparse 换成 typer，命令、选项、`--json` 输出和退出码不变）、`src/sift/log.py`（`rich=True` 真正起作用）、`src/sift/__init__.py`（`__version__` 改成第一次用到时才去读）、`src/sift/parallel.py` 和 `src/sift/storage/store.py`（多一个进度回调）、`pyproject.toml`（多了 typer、click、rich 三个依赖）、`README.md` 和 `lab/ch16/extra.sh`。新增 `src/sift/render.py`（rich 的表格、进度条和回溯）和 `tests/test_render.py`。
> 后面的章节里，第 20 篇给 `src/sift/cli.py` 加 `sift gui --tk`，给 `pyproject.toml` 加 `gui` 可选依赖；第 21 篇让 `sift gui` 默认走 Qt，并扩充这个可选依赖；第 22 篇再给 `src/sift/cli.py` 加 `sift similar` 和 `sift report`，给 `pyproject.toml` 加 `data` 可选依赖；第 24 和 25 篇给 `sift index` 加 `--tokenizer`。
> 涉及的 Python 特性：`Annotated` 与函数签名反射、模块级 `__getattr__`、`importlib.metadata`、类型检查器对方法重写的检查、pty 与信号、PEP 517 构建后端。
> 前置：[第 18 篇](/posts/python-by-sift-18-fastapi-pydantic-httpx/)。上一篇的服务器已经有了完整的路由和退出码，这一篇不动它们的行为，只换外面那层壳。

## 环境

和前几篇同一台机器，仓库在标签 `ch19`，命令都在 `nix develop` 里、仓库根目录下跑。库的版本是 `importlib.metadata` 报的，`uv`、`hyperfine` 和 `pip` 的版本是它们自己报的：

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ git describe --tags; git rev-parse --short HEAD
ch19
40e1608
$ lscpu | sed -n '/Model name/p;/^CPU(s):/p'
CPU(s):                                  16
Model name:                              AMD Ryzen 7 PRO 6850U with Radeon Graphics
$ python3 -c "import importlib.metadata as m; \
[print(n, m.version(n)) for n in ('typer', 'click', 'rich', 'sqlalchemy', \
'build', 'hatchling', 'pygments', 'markdown-it-py', 'shellingham', 'mdurl')]"
typer 0.25.1
click 8.3.3
rich 15.0.0
sqlalchemy 2.0.51
build 1.5.1
hatchling 1.31.0
pygments 2.20.0
markdown-it-py 4.2.0
shellingham 1.5.4
mdurl 0.1.2
$ uv --version; hyperfine --version; python3 -m pip --version | cut -d' ' -f1,2
uv 0.12.5 (x86_64-unknown-linux-gnu)
hyperfine 1.20.0
pip 26.2.1
```

这台机器的 CPU 有快慢两个状态（第 11 篇测到过约 2.5 倍），所以计时前后我各夹一次 `cpu_state.py`（第 12 篇贴过的固定忙循环，快状态下 5 个数在 110 到 120 毫秒）。`make ch19` 前后是 `121 115 112 112 115` 和 `112 112 117 118 122`；下面每个以毫秒计的计时脚本前后我也夹了，读数都在 109 到 124 之间，没有出现过慢状态的 280 毫秒上下。所以全篇是快状态的数字。以秒计、主要花在网络上的几个数（`uv lock`、隔离构建）没有夹，那里快慢状态的差别淹没在网络里。

文中引用的第三方源码都是这个环境里装的版本，我在 nix 存储里按路径读的，行号在读的那份文件里数，路径相对于 `site-packages`：

- `typer` 0.25.1、`click` 8.3.3、`rich` 15.0.0、`hatchling` 1.31.0、`build` 1.5.1。
- `uv` 是编译好的二进制，Rust 源码不在环境里。我读的是 GitHub 仓库标签 `0.12.5`（提交 `210d1f6785e9`）下的 `docs/`，所以 uv 的行为我引的是文档，行为本身用命令验证。
- PEP 取自 `python/peps` 的提交 `018ddd7`，打包规范取自 `pypa/packaging.python.org` 的提交 `d1ad4ad`（都是读的时候的 `HEAD`）。PEP 427 和 PEP 566 页首都写着“规范的现行版本在 packaging.python.org”，所以关于 wheel 和核心元数据的细节我读的是 `binary-distribution-format.rst` 和 `core-metadata.rst`，不是 PEP 原文。

仓库这一头，`make ch19` 跑 4 个 Python 实验再加 `extra.sh`，完整测试、类型检查和格式检查：

```text
$ python3 /tmp/sift-scratch/cpu_state.py
121 115 112 112 115 ms
$ make ch19 > /tmp/ch19_make.txt 2>&1; echo $?; grep -c ^ok /tmp/ch19_make.txt
0
5
$ python3 /tmp/sift-scratch/cpu_state.py
112 112 117 118 122 ms
$ python3 -m pytest | tail -1
956 passed, 1 xfailed, 1 warning in 33.83s
$ make typecheck | tail -2
Success: no issues found in 41 source files
0 errors, 0 warnings, 0 informations
$ make lint | tail -3
324 files already formatted
ruff check .
All checks passed!
```

5 个 `ok` 是 4 个 Python 脚本和 `extra.sh`。那 1 个 warning 是 Starlette 的 `TestClient` 对 `httpx` 的弃用提示，第 18 篇就有，和这一篇无关。1 个 xfailed 是第 10 篇留下的行内代码那个已知缺口。

两件事先交代清楚。第一，这一篇会装包、会联网：`uv add`、`uv lock`、`uv pip install` 都要访问 PyPI，所以那几处的数字会随网络和 PyPI 的当下状态变。第二，我讲发布到 PyPI 和 TestPyPI 的流程，但我没有真的发布过任何东西，发布那一节没有一条命令是我跑出来的，我会在那里再说一次。

## 从类型注解到命令行

先看 typer 到底做了什么。我写一个最小的程序，函数签名里放 `list[str]`、带范围的 `int`、`Path | None`、布尔值和枚举，然后不运行命令，直接把 typer 生成的 click 对象打印出来：

```python
"""Show the click objects that typer builds from a signature."""

from enum import StrEnum
from pathlib import Path
from typing import Annotated

import click
import typer
from typer.main import get_command
from typer.testing import CliRunner


class Mode(StrEnum):
    """The kinds of worker, as in ``sift index --mode``."""

    process = "process"
    thread = "thread"


app = typer.Typer()
SEEN: dict[str, object] = {}


@app.command()
def search(
    words: list[str],
    limit: Annotated[int, typer.Option(min=1, max=100)] = 10,
    corpus: Path | None = None,
    as_json: Annotated[bool, typer.Option("--json")] = False,
    mode: Mode = Mode.process,
) -> None:
    """Record what the function was called with."""
    SEEN.update(words=words, limit=limit, corpus=corpus, mode=mode)
    SEEN.update(as_json=as_json)


@app.command()
def stats() -> None:
    """Exist, so that typer builds a group."""


def describe(param: click.Parameter) -> str:
    """Return one line about a click parameter."""
    return (
        f"{type(param).__name__:<12} {param.name:<8} "
        f"opts={param.opts!r:<22} type={param.type.name:<8} "
        f"required={param.required!s:<5} default={param.default!r}"
    )


def main() -> None:
    """Print the click tree of ``app``, then run it on four lines."""
    group = get_command(app)
    print(type(group).__mro__[:3])
    assert isinstance(group, click.Group)
    command = group.commands["search"]
    for param in command.params:
        print(describe(param))
    runner = CliRunner(env={"COLUMNS": "100"})
    for argv in (
        ["search", "kalman", "filter"],
        ["search", "--limit", "5", "--json", "--mode", "thread", "x"],
        ["search", "--limit", "500", "x"],
        ["search", "--mode", "async", "x"],
    ):
        SEEN.clear()
        result = runner.invoke(app, argv)
        print("$ sift", " ".join(argv), "-> exit", result.exit_code)
        lines = [x for x in result.output.splitlines() if "Invalid" in x]
        print("  ", SEEN or lines[0].strip("│ "))


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/ch19/typer_to_click.py
(<class 'typer.core.TyperGroup'>, <class 'click.core.Group'>, <class 'click.core.Command'>)
TyperArgument words    opts=['words']              type=text     required=True  default=None
TyperOption  limit    opts=['--limit']            type=integer range required=False default=10
TyperOption  corpus   opts=['--corpus']           type=path     required=False default=None
TyperOption  as_json  opts=['--json']             type=boolean  required=False default=False
TyperOption  mode     opts=['--mode']             type=choice   required=False default=<Mode.process: 'process'>
$ sift search kalman filter -> exit 0
   {'words': ['kalman', 'filter'], 'limit': 10, 'corpus': None, 'mode': <Mode.process: 'process'>, 'as_json': False}
$ sift search --limit 5 --json --mode thread x -> exit 0
   {'words': ['x'], 'limit': 5, 'corpus': None, 'mode': <Mode.thread: 'thread'>, 'as_json': True}
$ sift search --limit 500 x -> exit 2
   Invalid value for '--limit': 500 is not in the range 1<=x<=100.
$ sift search --mode async x -> exit 2
   Invalid value for '--mode': 'async' is not one of 'process', 'thread'.
```

规则全在输出里了，我再对着源码把它们一条一条核实（`typer/main.py`，typer 0.25.1）：

- 没有默认值的参数是命令行参数（Argument），有默认值的是选项（Option）。`words` 没有默认值，所以是 `TyperArgument`，`list[str]` 让它的 `nargs` 变成 -1（`typer/main.py` 第 1642 到 1644 行、第 1757 行）；其余四个有默认值，都是 `TyperOption`（第 1647 行）。选项名是参数名里的下划线换成连字符再加 `--`（`get_click_param` 里的 `default_option_declaration`，第 1708 到 1717 行）。我给 `as_json` 手写了 `"--json"`，所以它的选项名是 `--json` 而不是 `--as-json`。
- `bool` 变成开关：第 1701 到 1702 行把 `is_flag` 设成 `True`。不手写选项名的话，声明是 `--x/--no-x` 一对（第 1708 到 1710 行）；我写了 `"--json"`，所以只剩一个。Sift 里的 `--no-log` 是我手写的单个开关，不是 typer 自动生成的反向开关。
- `Annotated[int, typer.Option(min=1, max=100)]` 里的元数据由 `get_params_from_function` 拆出来（`typer/utils.py` 第 107 到 121 行，用 `_split_annotation_from_typer_annotations`）。同一个参数既写 `Annotated[..., Option()]` 又写 `= Option()` 当默认值会直接报错（第 124 到 129 行），我试了一次，抛出的是 `MixedAnnotatedAndDefaultStyleError`，信息里说 `Option` 和默认值不能同时给。两种风格不能混在一个参数上。
- `StrEnum` 变成 `TyperChoice`，也就是 `click.Choice` 的一个子类（`get_click_type` 里 `Enum` 的分支，第 1605 到 1612 行；`typer/_types.py` 第 9 行），报错信息里自动列出候选值（上面最后一行）。`Path | None` 里的 `None` 被剥掉（`get_click_param` 的 `is_union` 分支，第 1662 到 1672 行），类型变成 `path`。
- 只注册了一个命令的 `Typer` 不会生成命令组，而是一个单独的命令（`get_command`，`main.py` 第 1171 到 1200 行）。这条我用实验确认了：

```text
$ python3 -c '
import typer
from typer.main import get_command
from typer.testing import CliRunner
app = typer.Typer()
@app.command()
def search(query: list[str]) -> None:
    print("query:", query)
print(type(get_command(app)).__name__)
print(CliRunner().invoke(app, ["search", "kalman"]).output.strip())
'
TyperCommand
query: ['search', 'kalman']
```

`search` 被当成了查询词。所以 `lab/ch19/argparse_vs_typer.py` 里那个什么都不做的 `stats` 命令不是摆设：没有它，`sift search kalman` 在 typer 眼里就是搜两个词。

### 同一个命令，两种写法

`lab/ch19/argparse_vs_typer.py` 把 `search` 命令用 argparse 和 typer 各写一遍，用同样的五条命令行跑，再数行数。我把输出全部贴出来：

```text
$ python3 lab/ch19/argparse_vs_typer.py | grep -E 'same|lines'
  same: True
  same: True
  same: True
  same: True
  same: True
argparse: 27 lines, 25 code lines
typer   : 25 lines, 23 code lines
```

五条命令行（`search kalman filter`、`--limit 3 --json device tree`、`--no-log rust`、`--limit 101 a`、什么都不带）解析出来的值和退出码完全一样，后两条都是退出码 2。行数呢？27 对 25，少了 2 行。我本来以为 typer 会省下一大截，结果几乎打平，原因在代码里：两边都要自己写 `limit_arg` 之类的转换函数（argparse 的 `type=`，typer 的 `parser=`），这是占行数最多的部分，而 typer 的 `Annotated[...]` 把每个参数写成了好几行。所以我不会说 typer 让代码变短了。它换来的是另一样东西：参数的类型、默认值、帮助文字和函数体用的变量名在同一个地方，函数可以直接当普通函数调用和测试，不用先造一个 `Namespace`。

`parser=` 这一项值得多说一句，因为它是 Sift 的 `--limit` 能保住第 15 篇那套校验的原因。typer 把 `parser` 包成 `click.types.FuncParamType`（`main.py` 第 1526 到 1527 行），而 `FuncParamType.convert` 只接住 `ValueError`（`click/types.py` 第 181 到 192 行，click 8.3.3）。我的转换函数抛的是 `typer.BadParameter`，它是 click 的 `UsageError` 的子类，不是 `ValueError`，所以不会被这里吞掉，一路传到 click 的主循环，被印成 Invalid value for --limit 那一行，退出码 2。上面的 `sift search --limit 101 a` 就是这条路。

### 回调：`--version` 和 `--debug` 是怎么抢在前面的

Sift 的根命令有两个全局选项，`--version` 和 `--debug`。它们不属于任何一个子命令，在 typer 里写成 `@app.callback()` 装饰的函数，每次调用都先跑。下面是 `src/sift/cli.py` 第 132 到 167 行（标签 `ch19`），这两个函数我原样摘出来：

```python
def show_version(value: bool) -> None:
    """Print the version and exit, for the eager ``--version``."""
    if value:
        from sift import __version__

        typer.echo(f"sift {__version__}")
        raise typer.Exit


@app.callback()
def run_root(
    ctx: typer.Context,
    version: Annotated[
        bool,
        typer.Option(
            "--version",
            callback=show_version,
            is_eager=True,
            help="Show the version and exit.",
        ),
    ] = False,
    debug: Annotated[
        bool,
        typer.Option(
            "--debug",
            help="Log at DEBUG level and print tracebacks with rich.",
        ),
    ] = False,
) -> None:
    """Set up logging, and the rich traceback with --debug."""
    ctx.meta[DEBUG_KEY] = debug
    setup_logging(
        "DEBUG" if debug else "WARNING", rich=render.wants_rich(sys.stderr)
    )
    if debug:
        render.install_traceback()
```

`is_eager=True` 是 click 的概念：eager 参数先于其他参数处理。排序规则在 `click/core.py` 的 `iter_params_for_processing`（第 116 到 138 行，click 8.3.3），排序键是 `(not item.is_eager, 出现顺序)`，所以 eager 的排在最前，其余的按命令行上出现的顺序。`Command.parse_args` 里就是按这个顺序逐个处理参数的（第 1255 行）。它的后果我可以直接试：

```text
$ sift nonsense; echo "exit $?"
Usage: sift [OPTIONS] COMMAND [ARGS]...
Try 'sift -h' for help.
╭─ Error ──────────────────────────────────────────────────────────────────────╮
│ No such command 'nonsense'.                                                  │
╰──────────────────────────────────────────────────────────────────────────────╯
exit 2
$ sift --version nonsense; echo "exit $?"
sift 0.1.0
exit 0
```

第二条里 `nonsense` 根本没有被看到：`--version` 的回调先跑，`typer.Exit` 一抛，click 就收尾退出了，后面的命令名没人去解析。`show_version` 里用 `raise typer.Exit` 而不是 `sys.exit(0)`，是因为 `typer.Exit` 就是 `click.exceptions.Exit`（`typer/__init__.py` 第 9 行），click 的主循环认识它，上下文照常收尾。

`ctx.meta` 值得多说一句。`run_root` 把 `--debug` 的值存进 `ctx.meta[DEBUG_KEY]`，后面的 `fail()` 和 `run_serve` 都从这里读。`Context.meta` 是一个在整条上下文链上共享的字典（`click/core.py` 第 329 行，子上下文拿到的是父上下文的同一个对象）。我不用全局变量存 `--debug`，原因是测试：`CliRunner` 在同一个进程里连着调用几十次命令，全局状态会漏到下一个测试里。

### click 在 typer 底下

一段话交代 click 的位置。typer 自己不解析命令行：它读函数签名，造出 `click.Command`、`click.Group`、`click.Option` 这些对象（上一节打印出来的类名是 `TyperGroup`、`TyperOption`，都是 click 类的子类），然后把整个命令行交给 click 跑。`Typer.__call__` 只做一件事：`get_command(self)(*args, **kwargs)`（`typer/main.py` 第 1131 到 1135 行，其余是给异常加标记），后面是 click 的 `Command.main`，再回到 `typer/core.py` 的 `_main`（第 156 行起）。错误的语义、退出码和选项的处理顺序都是 click 的。所以读 typer 的报错和行为，很多时候要去读 click 的文档。

这一层关系在 Sift 里留下一个具体的后果：`pyproject.toml` 里 `click` 是直接依赖。原因是我要重写 `TyperGroup.invoke`，它的参数类型是 `click.Context`。我最初想写 `typer.Context`（它的名字更顺手），两个类型检查器都不答应：

```python
"""Override TyperGroup.invoke with a narrower parameter type."""

import typer
from typer.core import TyperGroup


class BadGroup(TyperGroup):
    """Override invoke with a narrower parameter type."""

    def invoke(self, ctx: typer.Context) -> object:  # BAD
        """Run the command."""
        return super().invoke(ctx)


def main() -> None:
    """Build the group, so that the file is also a program."""
    print(BadGroup.__mro__[1].__name__)


if __name__ == "__main__":
    main()
```

```text
$ python3 bad_override.py; pyright bad_override.py
TyperGroup
/tmp/sift-scratch/ch19/bad_override.py
  /tmp/sift-scratch/ch19/bad_override.py:10:9 - error: Method "invoke" overrides class "Group" in an incompatible manner
    Parameter 2 type mismatch: base parameter is type "Context", override parameter is type "Context"
      "click.core.Context" is not assignable to "typer.models.Context" (reportIncompatibleMethodOverride)
1 error, 0 warnings, 0 informations
```

脚本本身能跑（第一行 `TyperGroup`），错的是类型：重写的方法把参数收窄成了子类 `typer.models.Context`，违反里氏替换（`mypy --strict` 也拒绝，报 `[override]`）。pyright 把两个类都显示成 `Context`，要读到第三行才看得出一个是 `click.core.Context`，一个是 `typer.models.Context`。修法就是 `cli.py` 里写的 `ctx: click.Context`，于是 `import click` 出现在 `cli.py` 里，`click` 就得进 `pyproject.toml` 的依赖：靠 typer 顺带装进来的东西不应该直接 `import`。我写的下限是 `click>=8.2.1`，这个数我没有验证过（unverified：8.2.1 本身我没有装过），我只知道开发环境的 8.3.3 和下面干净环境装出来的 8.5.0 都能跑。

### 退出码：从 `main()` 搬进命令组

第 11 篇起，`sift` 的退出码是约定好的：0 成功（没有命中也是 0），2 用法错误，3 查询语法错，4 没有索引，1 其他 `SiftError`，Ctrl-C 是 130。argparse 版本把这套映射写在 `main()` 里：`try: args.func(args)`，一串 `except`。typer 版本不能照搬，因为测试用的 `CliRunner` 调的是 click 命令，不经过 `main()`。映射放在 `main()` 里，就只有真的起一个子进程才测得到。所以我把它搬进 `TyperGroup` 的子类，重写 `invoke`。`src/sift/cli.py` 第 71 到 112 行：

```python
class SiftGroup(TyperGroup):
    """The root command group: Sift errors become exit codes.

    A usage error (bad option, bad value) is raised by click while it
    parses the arguments and leaves through typer, which prints it and
    exits 2. The errors of Sift are caught here, around the whole
    invocation, because they come out of the command functions.
    """

    def invoke(self, ctx: click.Context) -> object:
        """Run the command; print a Sift error and exit with its code."""
        try:
            return super().invoke(ctx)
        except QuerySyntaxError as error:
            fail(ctx, error.render(), 3)
        except IndexMissingError as error:
            fail(ctx, f"sift: {error}", 4)
        except SiftError as error:
            fail(ctx, f"error: {error}", 1)
        except KeyboardInterrupt:
            fail(ctx, "interrupted", 130, trace=False)
        except ExceptionGroup as group:
            _, other = group.split(SiftError)
            if other is not None:
                raise
            lines = [f"error: {group.message}"]
            lines += [f"  {failure}" for failure in group.exceptions]
            fail(ctx, "\n".join(lines), 1)


def fail(
    ctx: click.Context, message: str, code: int, *, trace: bool = True
) -> NoReturn:
    """Print message on stderr and exit with code.

    Call it from an ``except`` block. With --debug the exception
    being handled is first printed as a rich traceback.
    """
    if trace and ctx.meta.get(DEBUG_KEY):
        render.print_traceback()
    print(message, file=sys.stderr)
    ctx.exit(code)
```

`except` 的顺序是第 9 篇定下的：子类在前，`QuerySyntaxError` 和 `IndexMissingError` 先于它们共同的父类 `SiftError`。`ctx.exit(code)` 抛 `click.exceptions.Exit`（`click/core.py` 第 759 到 767 行，先 `self.close()` 再 `raise Exit(code)`），一直传到 `typer/core.py` 的 `_main`，那里 `except click.exceptions.Exit` 再 `sys.exit(e.exit_code)`（第 223 到 225 行）。`KeyboardInterrupt` 其实 typer 自己也接（第 202 到 203 行，转成 `Exit(130)`），但它在 `_main` 里，比我的 `invoke` 晚，所以我自己先接住，好打印 `interrupted`。

我把每一个出口都跑一遍。argparse 一侧的对照用标签 `ch18` 的源码，我用 `git archive ch18 src | tar -x` 解到一个临时目录（下面的 `/tmp/c18src`，其实是指向它的符号链接），再用 `PYTHONPATH` 指过去。脚本很短，`run` 函数把命令、输出的前 12 行和退出码打印出来：

```bash
#!/usr/bin/env bash
# Run sift in the ways that fail and print each exit code.
# Usage: bash exit_codes.sh INDEX_DIR CH18_SRC
idx=$1
old=$2

run() {
    printf '$'; printf ' %q' "$@"; echo
    "$@" 2>&1 | sed -n 1,12p
    echo "exit ${PIPESTATUS[0]}"
    echo
}

export SIFT_INDEX=$idx
run sift search kalman --limit 1 --no-log
run sift search nonexistentword --no-log
run sift search --limit 101 a
run sift search '"kalman' --no-log
run env SIFT_INDEX=/nonexistent sift search kalman
run sift index --corpus /nonexistent
run sift show 99999
echo '# the same usage error from the argparse version (ch18)'
run env PYTHONPATH="$old" python3 -m sift search --limit 101 a
```

```text
$ bash /tmp/sift-scratch/ch19/exit_codes.sh /tmp/sift-scratch/ch19/idx \
    /tmp/c18src
$ sift search kalman --limit 1 --no-log
 1    5.062  corpus/posts/kalman-filter-01-one-dimension.md
    一维卡尔曼滤波：两个高斯相乘
    …： git clone https://github.com/bfmhno3/[kalman]-lab.git cd [kalman]-lab git checkout tutorial-v1 nix develop [kalman]-lab dev shell: Python 3.13.15, gcc (GCC) 15.3.…
8 hits in 123 files: index opened in 138.4 ms, query took 7.044 ms
exit 0

$ sift search nonexistentword --no-log
0 hits in 123 files: index opened in 138.5 ms, query took 0.127 ms
exit 0

$ sift search --limit 101 a
Usage: sift search [OPTIONS] QUERY...
Try 'sift search -h' for help.
╭─ Error ──────────────────────────────────────────────────────────────────────╮
│ Invalid value for '--limit': [search] limit must be an integer between 1 and │
│ 100                                                                          │
╰──────────────────────────────────────────────────────────────────────────────╯
exit 2

$ sift search \"kalman --no-log
unterminated phrase
  "kalman
  ^
exit 3

$ env SIFT_INDEX=/nonexistent sift search kalman
sift: no index at /nonexistent, run 'sift index' first
exit 4

$ sift index --corpus /nonexistent
error: no corpus at /nonexistent
exit 1

$ sift show 99999
error: no document with id 99999
exit 1

# the same usage error from the argparse version (ch18)
$ env PYTHONPATH=/tmp/c18src python3 -m sift search --limit 101 a
usage: sift search [-h] [--limit LIMIT] [--json] [--no-log] query [query ...]
sift search: error: argument --limit: [search] limit must be an integer between 1 and 100
exit 2
```

退出码一个没变，变的是用法错误的样子：argparse 是两行纯文本，typer 是 click 的用法提示加一个红框（颜色在管道里看不到，框线还在）。第一条搜索的输出里有 `[kalman]` 这样的方括号，那是纯文本模式用方括号标记命中的词；它和后面 rich 一节里的一个坑有关，先记着。

Ctrl-C 和 SIGTERM 不能在上面的脚本里试：非交互 shell 里用 `&` 放到后台的作业会忽略 SIGINT，Python 继承了“忽略”的设置，就不装自己的处理器了。我第一次用 `kill -INT` 试，`sift open` 照常睡满 30 秒，退出码 0，什么都没发生。所以信号得从 Python 里用 `subprocess.Popen(...).send_signal` 发（那个二十来行的脚本我没有贴进来）。发完之后：`sift open` 和 `sift serve` 收到 SIGINT 都在约 2.8 秒后以 130 退出，stderr 上是 `interrupted`；`sift serve` 收到 SIGTERM 以 0 退出，stderr 为空。这和第 17、18 篇的约定一致（`serve` 自己装了 SIGTERM 的处理，干净退出）。

最后一个细节是 `main()` 末尾的那个 `except SystemExit`。typer 的 `app(...)` 在命令成功、`--help` 和 `--version` 时也会 `sys.exit(0)`，而 `main()` 是 `[project.scripts]` 里的入口，也被别的代码当普通函数调用，它不应该退出。`src/sift/cli.py` 第 771 到 787 行，退出码为 0 的 `SystemExit` 在这里被吞掉，其余原样抛出：

```python
def main(argv: Sequence[str] | None = None) -> None:
    # (docstring left out)
    try:
        app(args=None if argv is None else list(argv), prog_name="sift")
    except SystemExit as stop:
        if stop.code:
            raise
```

用一行 Python 确认它们结束的方式不同：

```text
$ python3 -c '
import sift.cli as cli
for name in ("app", "main"):
    try:
        print(name, "returned", getattr(cli, name)(["--version"]))
    except SystemExit as stop:
        print(name, "raised SystemExit", stop.code)'
sift 0.1.0
app raised SystemExit 0
sift 0.1.0
main returned None
```

同一个命令行，`app` 以 `SystemExit(0)` 结束，`main` 返回 `None`。

### 用法错误不是 sift 画的

`sift search --limit 101 a` 那个红框不是 `sift.render` 画的，是 typer 在 click 抛出 `UsageError` 之后画的。`click/exceptions.py` 第 65 行写着 `UsageError.exit_code = 2`，所以退出码 2 一直是 click 的约定，argparse 的也是 2，不是巧合。typer 的 `_main` 接住 `click.ClickException`，如果装了 rich，就调 `rich_utils.rich_format_error`，没装才用 click 自己的 `e.show()`（`typer/core.py` 第 204 到 215 行）。“装没装 rich”由模块加载时的一行决定：`HAS_RICH = parse_boolean_env_var(os.getenv("TYPER_USE_RICH"), default=True)`（第 29 行）。这里有一个我之前没想到的地方：`render.py` 的 `wants_rich` 在管道里返回假，Sift 自己的输出在管道里就是纯文本，但 typer 的用法错误和 `--help` 在管道里照样是 rich 的框，因为 typer 不看 `isatty`。我设 `TYPER_USE_RICH=0` 试了：

```text
$ TYPER_USE_RICH=0 sift search --limit 101 a; echo "exit $?"
Usage: sift search [OPTIONS] QUERY...
Try 'sift search -h' for help.

Error: Invalid value for '--limit': [search] limit must be an integer between 1 and 100
exit 2
$ TYPER_USE_RICH=0 sift --help | head -n 12
Usage: sift [OPTIONS] COMMAND [ARGS]...

  Search the Markdown posts of a blog.

Options:
  --version             Show the version and exit.
  --debug               Log at DEBUG level and print tracebacks with rich.
  --install-completion  Install completion for the current shell.
  --show-completion     Show completion for the current shell, to copy it or
                        customize the installation.
  -h, --help            Show this message and exit.

```

退出码还是 2，只是回到了 click 原来的样子。`render.py` 里“其他地方都是第 18 篇的纯文本”这句话只对 Sift 自己的输出成立，对 typer 的帮助页和错误不成立。我没有让 `sift` 在管道里自动设 `TYPER_USE_RICH=0`（要在 import typer 之前设，而且是改 typer 的行为），这是一个已知的缺口。

### 补全

`sift --help` 里多出来两个选项，`--install-completion` 和 `--show-completion`，是 typer 默认加的（`get_command` 里的 `_add_completion`，`typer/main.py` 第 1172 到 1173 行）。`--install-completion` 会改我的 shell 配置文件，我没有跑它。`--show-completion` 只打印，补全的协议我可以直接试：

```text
$ _SIFT_COMPLETE=complete_bash COMP_WORDS="sift se" COMP_CWORD=1 sift
search
serve
$ _SIFT_COMPLETE=complete_bash COMP_WORDS="sift search --" COMP_CWORD=2 sift
--limit
--json
--no-log
--help
$ _SIFT_COMPLETE=complete_bash COMP_WORDS="sift index --mode " \
    COMP_CWORD=3 sift
```

补全脚本是一个 bash 函数（`_SIFT_COMPLETE=source_bash sift` 会打印它），每次按 Tab 就用环境变量 `_SIFT_COMPLETE=complete_bash` 再启动一次 `sift`，让它把候选词打印出来。`typer/core.py` 的 `_main` 开头（第 183 行）调 `_typer_main_shell_completion`（第 626 到 644 行），后者读 `_{prog_name}_COMPLETE` 这个环境变量，有值就调 `shell_complete` 并 `sys.exit`，不跑命令。所以每次补全都是一次完整的 Python 启动，延迟不会比 `sift --version` 的约 95 毫秒更小。

最后一条是空的：`--mode` 在 Sift 里是 `str` 加自己的 `parser=`，typer 不知道它有三个合法值，所以补不出来。第 16 篇的 `Mode` 是 `Literal["process", "thread", "interp"]`，而 typer 认识 `Literal`（`get_click_type` 第 1615 到 1618 行）。我用一个二十来行的玩具程序试过（没有贴进来）：同样的 `--mode`，标成 `Literal` 能补出 `process`、`thread`、`interp` 三个值，标成 `str` 补不出来，而且前者的报错信息是 typer 自动生成的。Sift 没这么写的原因我没有查，猜是为了保住 `mode_arg` 自己的报错文字，这只是猜测。所以 `--mode` 补不出来是 Sift 的写法造成的，不是 typer 的限制。

## 启动时间：一慢一快

回到开头的数字。这个小脚本是后面几个实验共用的做法：每个命令用 hyperfine 量，`-N` 不经过 shell，预热 3 次，各跑 20 次；一组命令量三轮，每一轮轮换先后顺序，机器中途变慢就不会只罚其中一边。argparse 一侧是标签 `ch18` 的源码，用 `git archive ch18 src` 解到临时目录，靠 `PYTHONPATH` 指过去。`--help` 多量了一种：设了 `TYPER_USE_RICH=0` 的 typer，原因马上说。

```python
"""Compare the start-up of `sift --help` and `sift --version`.

Each argument is timed with hyperfine for the argparse source tree
(ch18), the typer one, and, for --help, typer without rich. The three
rounds rotate the order, so a slow stretch of the machine cannot favour
one side.
"""

import json
import subprocess
import tempfile
from pathlib import Path

OLD = Path("/tmp/sift-scratch/ch19/ch18/src")
NEW = Path("src").resolve()
ROUNDS = 3


def variants(arg: str) -> dict[str, str]:
    """Return the label and command line of every variant of arg."""
    run = f"python3 -m sift {arg}"
    found = {
        "argparse": f"env PYTHONPATH={OLD} {run}",
        "typer": f"env PYTHONPATH={NEW} {run}",
    }
    if arg == "--help":
        found["typer, TYPER_USE_RICH=0"] = (
            f"env TYPER_USE_RICH=0 PYTHONPATH={NEW} {run}"
        )
    return found


def hyperfine(commands: list[str]) -> list[float]:
    """Return the mean in ms of each command, in the order given."""
    with tempfile.TemporaryDirectory() as tmp:
        report = Path(tmp) / "out.json"
        argv = ["hyperfine", "-N", "--warmup", "3", "--runs", "20"]
        argv += ["--export-json", str(report)] + commands
        subprocess.run(argv, check=True, capture_output=True)
        results = json.loads(report.read_text())["results"]
    return [r["mean"] * 1000 for r in results]


def main() -> None:
    """Print the mean over the rounds of every variant."""
    for arg in ("--help", "--version"):
        commands = variants(arg)
        labels = list(commands)
        totals = dict.fromkeys(labels, 0.0)
        for n in range(ROUNDS):
            order = labels[n % len(labels) :] + labels[: n % len(labels)]
            means = hyperfine([commands[label] for label in order])
            for label, mean in zip(order, means, strict=True):
                totals[label] += mean / ROUNDS
        for label, total in totals.items():
            print(f"sift {arg:<10} {label:<25} {total:6.1f} ms")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/cpu_state.py; \
    python3 /tmp/sift-scratch/ch19/startup_pair.py; \
    python3 /tmp/sift-scratch/cpu_state.py
114 116 116 114 114 ms
sift --help     argparse                   144.5 ms
sift --help     typer                      180.4 ms
sift --help     typer, TYPER_USE_RICH=0     81.0 ms
sift --version  argparse                   143.6 ms
sift --version  typer                       97.0 ms
113 113 113 114 114 ms
```

`make ch19` 里的 `extra.sh` 做的是同一件事，结果落在 `out/ch19/startup_compare.txt`，三轮的均值是：`--help` argparse 139.0、137.4、138.3 毫秒，typer 174.4、172.6、173.8 毫秒；`--version` argparse 137.3、138.6、138.1 毫秒，typer 93.3、93.9、93.1 毫秒；只启动解释器（`python3 -c pass`）17.8 毫秒。两次测量差几个毫秒（这次机器稍慢一点，但 `cpu_state` 仍在快状态里），结论一样：`--help` 慢约 35 到 36 毫秒（约 1.25 倍），`--version` 快约 45 到 47 毫秒（约 1.48 倍），每组的标准差只有 2 到 5 毫秒，所以这两个差不是噪声。

### `--help` 慢在哪

我的第一个猜测是 typer 比 argparse 重。`--version` 是反例。第二个猜测是 rich：typer 的帮助页是 rich 画的。表里最后一行已经回答了：关掉 rich 的 `--help` 只要 81.0 毫秒，比 argparse 的 144.5 毫秒还快 63.5 毫秒；打开 rich，多出 99.4 毫秒。开关是 `typer/core.py` 第 29 行的 `TYPER_USE_RICH`。再看每条路径载入了多少模块：

```bash
#!/usr/bin/env bash
# Count the modules loaded by `sift --help` and `sift --version`.
# Usage: bash module_count.sh   (inside nix develop, at the repo root)
for tree in /tmp/c18src src; do
    for arg in --help --version; do
        PYTHONPATH=$tree python3 -c '
import sys
from sift.cli import main
try:
    main([sys.argv[1]])
except SystemExit:
    pass
names = ("rich", "asyncio", "importlib.metadata")
print(*[f"{n}={n in sys.modules}" for n in names],
      f"modules={len(sys.modules)}")' "$arg" | tail -n 1 | sed "s|^|$tree $arg: |"
    done
done
```

```text
$ bash /tmp/sift-scratch/ch19/module_count.sh
/tmp/c18src --help: rich=False asyncio=True importlib.metadata=True modules=289
/tmp/c18src --version: rich=False asyncio=True importlib.metadata=True modules=289
src --help: rich=True asyncio=False importlib.metadata=True modules=370
src --version: rich=False asyncio=False importlib.metadata=True modules=206
```

`--help` 的路径比 `--version` 多载入 164 个模块（370 对 206），多出来的主要就是 rich。`typer/rich_utils.py` 第 12 到 25 行在模块顶部就 `from rich import ...` 一串，而 `TyperCommand.format_help` 和 `TyperGroup.format_help` 在运行时才 `from . import rich_utils`（`typer/core.py` 第 726 行和第 808 行）：只有真的要画帮助页，rich 才会被加载。argparse 版本的两条路径都是 289 个模块，不分 `--help` 和 `--version`，因为它在导入阶段就把 asyncio 之类全拉进来了，下面会看到。

这是个取舍。我换 typer 的理由之一是 rich 的帮助页好看，代价是每次 `--help` 多花约 100 毫秒，对一个人偶尔在终端里敲一次的命令，这不算什么。一个每秒要被调用很多次的脚本可以设 `TYPER_USE_RICH=0`，但那会把 typer 的帮助页和错误页一起换回 click 的样子，我没有在 Sift 里这么做。

### `--version` 为什么快了

`--version` 比 argparse 版快了 45 毫秒上下，这不是 typer 的功劳，是我顺手把启动路径上的东西挪走了。`-X importtime` 能看每个模块的累计导入时间，我只摘几个名字：

```bash
#!/usr/bin/env bash
# Cumulative import time of a few modules while `sift --version` runs.
# Usage: bash importtime_names.sh SRC_DIR
PYTHONPATH=$1 python3 -X importtime -c '
from sift.cli import main
try:
    main(["--version"])
except SystemExit:
    pass' 2>&1 >/dev/null |
    awk -F'|' '
        $3 ~ /^ *(sift|sift.cli|importlib.metadata|asyncio|typer|click|argparse|logging|sqlalchemy|rich)$/ {
            gsub(/^ +| +$/, "", $3)
            printf "%-20s %7.1f ms\n", $3, $2 / 1000
        }'
```

```text
$ for t in /tmp/c18src src; do echo "== $t"; \
    bash /tmp/sift-scratch/ch19/importtime_names.sh $t; done
== /tmp/c18src
importlib.metadata      31.6 ms
sift                    53.2 ms
argparse                 1.3 ms
logging                  7.9 ms
asyncio                 29.0 ms
sift.cli               121.5 ms
== src
sift                     0.1 ms
click                   14.8 ms
typer                   26.7 ms
logging                  2.6 ms
sift.cli                56.7 ms
importlib.metadata       8.9 ms
```

`-X importtime` 自己有开销，加起来比 hyperfine 量到的整条命令还长（121.5 毫秒的 `sift.cli`），数字的绝对值不要信，看对比。标签 `ch18` 的 `src/sift/cli.py` 顶部有 `import asyncio`（第 23 行）和 `from sift import __version__`（第 37 行），再加上 `sift.analysis`、`sift.index`、`sift.parallel`、`sift.search`、`sift.server.raw` 等一长串 `from sift... import`：`import sift` 一进来就执行 `importlib.metadata.version("sift")`，这一项占 31.6 毫秒，整个 `sift` 包 53.2 毫秒；`asyncio` 又是 29.0 毫秒。而 `--version` 和 `--help` 其实一样都用不着它们。这一章里这几样都挪走了。先是 `src/sift/__init__.py`，现在是这样（全文）：

```python
"""Sift: a local full-text search engine for Markdown posts."""


def __getattr__(name: str) -> str:
    """Return ``sift.__version__``, read from the metadata on first use.

    ``importlib.metadata`` costs about 30 ms to import, which every
    ``sift`` command would pay at start-up for a number that only
    ``--version`` and the web server print.
    """
    if name != "__version__":
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from importlib.metadata import PackageNotFoundError, version

    try:
        found = version("sift")
    except PackageNotFoundError:
        # run from a source tree (PYTHONPATH=src) with no installed copy
        found = "0.0.0+source"
    globals()["__version__"] = found
    return found
```

模块级的 `__getattr__` 是 PEP 562（Python 3.7）加的：访问模块上不存在的属性时，解释器会调用它（`pep-0562.rst` 第 44 行起的例子就是这种写法）。第一次访问 `sift.__version__` 才去读元数据，之后把结果写进 `globals()`，下次就是普通的模块属性，不再进 `__getattr__`。这样 `import sift` 是 0.1 毫秒。`--version` 自己当然还是要读一次元数据，所以 `importlib.metadata` 还是出现在了第二个列表里，但只花 8.9 毫秒，比以前的 31.6 毫秒少，我猜是因为 typer 和 click 已经把它依赖的一些标准库模块带进来了，这只是猜测，我没有逐个模块对。

`sift.cli` 顶部现在只剩 `click`、`typer` 和 `sift.render`、`sift.errors`、`sift.log`、`sift.util`；`asyncio`、`json`、存储和搜索模块都改成了命令函数里的导入（比如 `run_serve` 里才 `import asyncio`，`render.py` 的顶部只导入标准库，用到 rich 的函数各自在调用时 `from rich... import`）。这个做法第 11 篇的 `lazy_import.py` 讲过，代价是缺依赖的错误从启动时推迟到第一次调用那个命令的时候。ch19 的 `--version` 路径上没有 `asyncio`，也没有 `rich`（前面的表里可以看到），省下的主要就是这几块。

## rich：什么时候画，画什么

typer 管输入，rich 管输出。先把 rich 的几样东西过一遍。`lab/ch19/rich_tour.py` 里的 `tour` 函数（第 28 到 53 行）在一个固定宽度的、可录制的 `Console` 上每样画一个：规则线、标记语言、表格、语法高亮、面板、进度条、`Live` 和 JSON。

```python
def tour(console: Console) -> None:
    """Print one of each rich feature on console."""
    console.rule("[bold cyan]rich tour")
    console.print("[bold]bold[/bold] [i]italic[/i] [red on white]red[/]")
    console.print(
        "a [link=https://rich.readthedocs.io]link[/link], :sparkles:"
    )
    table = Table(title="hits", box=box.ROUNDED)
    table.add_column("#", justify="right")
    table.add_column("title", style="cyan")
    table.add_column("score", justify="right")
    table.add_row("1", "Kalman filter, part 2", "8.279")
    table.add_row("2", "The UKF", "7.872")
    console.print(table)
    console.print(Syntax(CODE, "python", line_numbers=True))
    console.print(Panel("Panel text", title="Panel", subtitle="subtitle"))
    with Progress(console=console) as progress:
        task = progress.add_task("indexing", total=20)
        for _ in range(20):
            progress.advance(task)
            time.sleep(0.005)
    with Live(Panel("starting"), console=console, auto_refresh=False) as live:
        for step in ("reading", "analyzing", "writing"):
            live.update(Panel(step, title="live"), refresh=True)
            time.sleep(0.01)
    console.print_json('{"query": "kalman", "total": 5, "hits": [1, 2]}')
```

```text
$ python3 lab/ch19/rich_tour.py | grep -v '^a link' | sed -n 1,9p
────────────────────────────────── rich tour ───────────────────────────────────
bold italic red
                hits                 
╭───┬───────────────────────┬───────╮
│ # │ title                 │ score │
├───┼───────────────────────┼───────┤
│ 1 │ Kalman filter, part 2 │ 8.279 │
│ 2 │ The UKF               │ 7.872 │
╰───┴───────────────────────┴───────╯
```

我用 `grep -v` 去掉了一行，又只贴了前 9 行（后面是 `Syntax`、`Panel`、进度条、`Live` 和 JSON）：`:sparkles:` 这个记号被 rich 换成了一个表情符号字符，我不想把它抄进文章里。输出里的颜色在纯文本里看不到。进度条和 `Live` 在导出的文本里只剩最后一帧（`Live` 循环里更新了三次，只留下 `writing`），中间的帧去哪了我没有追究。

### 一个坑：方括号

rich 的 `Console.print` 默认把字符串当标记语言解析，方括号里的东西是样式标签（`console.py` 第 1438 行：`markup_enabled = markup or (markup is None and self._markup)`）。而 Sift 要打印的是博客正文的片段，正文里满是方括号：链接、数组下标、Markdown 的 `[text]`。我先把这个问题单独做成一个实验：

```python
"""Print a snippet with square brackets through rich, three ways."""

import io

from rich.console import Console
from rich.markup import escape
from rich.text import Text

SNIPPET = "git clone https://github.com/x/[kalman]-lab.git [bold] done"


def render(renderable: object) -> str:
    """Return what a 100-column recording console prints."""
    buffer = io.StringIO()
    console = Console(file=buffer, width=100, color_system=None)
    console.print(renderable)
    return buffer.getvalue().rstrip("\n")


def main() -> None:
    """Show the string, the escaped string and Text side by side."""
    print("source        :", SNIPPET)
    print("str   (BAD)   :", render(SNIPPET))  # BAD: parsed as markup
    print("escape(str)   :", render(escape(SNIPPET)))
    print("Text(str)     :", render(Text(SNIPPET)))
    try:
        render("[/kalman] closes nothing")  # BAD: closing tag, no opener
    except Exception as error:
        print(f"# error: {type(error).__name__}: {error}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/ch19/rich_markup_trap.py
source        : git clone https://github.com/x/[kalman]-lab.git [bold] done
str   (BAD)   : git clone https://github.com/x/-lab.git  done
escape(str)   : git clone https://github.com/x/[kalman]-lab.git [bold] done
Text(str)     : git clone https://github.com/x/[kalman]-lab.git [bold] done
# error: MarkupError: closing tag '[/kalman]' at position 0 doesn't match any open tag
```

直接传字符串（`BAD`），`[kalman]` 和 `[bold]` 都被当成标签吃掉了，没有报错，文章里的字就这样悄悄少了；最糟的是 `[/xxx]` 这种看起来像关闭标签的，会抛 `MarkupError`（`rich/markup.py` 第 168 行），一条命令因为一篇博客里的一个方括号崩掉。解法有两个：`rich.markup.escape` 转义，或者干脆不用字符串，用 `Text`。`Text.append` 只是把字符串加进去，样式靠 `Span` 另外挂，从不去解析标记（`rich/text.py` 里的 `append`）。`render.py` 的 `snippet_text` 走的是第二条路。`src/sift/render.py` 第 55 到 67 行：

```python
def snippet_text(parts: Parts) -> Text:
    """Return the snippet as rich Text, the matched parts highlighted.

    The parts are the ``(text, matched)`` pairs of ``Hit.snippet``.
    The text is never parsed as console markup, so a ``[chain]`` in a
    post stays what it is.
    """
    from rich.text import Text

    text = Text()
    for piece, matched in parts:
        text.append(piece, style=HIT_STYLE if matched else None)
    return text
```

这里用到第 8 篇以来的 `Hit.snippet`：一个 `(文字, 是否命中)` 的列表，命中的片段用样式 `bold black on yellow` 标出来。纯文本模式里同一个列表被 `render_plain` 用方括号标出来，这也是前面输出里 `[kalman]` 的来源。同一份数据，两种出口。

### 什么时候画：`wants_rich`

第二个问题是“要不要用 rich”。如果输出被管道到 `grep` 或写进文件，满屏的框线和转义序列会毁掉下游。第 18 篇及以前的纯文本输出是别的脚本在解析的，所以这一章给自己立了一条规矩：只有输出是终端时才用 rich，其余情况逐字节和 `ch18` 一样。判定集中在一个函数里，`src/sift/render.py` 第 32 到 43 行：

```python
def wants_rich(stream: TextIO) -> bool:
    """Return True if rich output suits stream.

    False for a stream that is not a terminal, when NO_COLOR is set
    to a non-empty value (https://no-color.org) and when TERM is
    ``dumb``.
    """
    if os.environ.get("NO_COLOR"):
        return False
    if os.environ.get("TERM") == "dumb":
        return False
    return stream.isatty()
```

我没有直接用 rich 自己的检测。`Console.is_terminal` 在 `rich/console.py` 第 931 到 976 行：先看 `force_terminal` 参数，再看 `TTY_COMPATIBLE`、`FORCE_COLOR` 这些环境变量，最后才问 `isatty()`；`NO_COLOR` 在 rich 里只关颜色（第 725 到 729 行的 `no_color`），不关框线。我要的是“`NO_COLOR` 就整个退回纯文本”，所以自己判，不依赖 rich。

两个出口我都要验证：在真终端里画 rich，在管道里和 `ch18` 逐字节相同。终端我用 `pty` 造一个。脚本把 `sift index --full` 和 `sift search` 放在一个 100 乘 30 的伪终端里跑，把它写出来的字节读回来：

```python
"""Run sift on a pseudo-terminal and show what it draws.

The command gets a real terminal of 100 x 30 on stdout and stderr, so
``sift.render.wants_rich`` is true. The bytes it writes are shown with
the escape sequences visible, then with them removed.
"""

import fcntl
import os
import pty
import re
import struct
import subprocess
import sys
import termios

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def run_on_tty(argv: list[str], env: dict[str, str]) -> bytes:
    """Run argv with a 100 x 30 terminal; return everything written."""
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    child = subprocess.Popen(
        argv, env=env, stdin=slave, stdout=slave, stderr=slave
    )
    os.close(slave)
    chunks = []
    while True:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        chunks.append(data)
    child.wait()
    os.close(master)
    return b"".join(chunks)


def main() -> None:
    """Index and search on a terminal, with and without NO_COLOR."""
    index = sys.argv[1]
    base = dict(os.environ, SIFT_INDEX=index, TERM="xterm-256color")
    base.pop("NO_COLOR", None)
    build = ["sift", "index", "--full", "--corpus", "corpus/posts"]
    out = run_on_tty(build, base).decode()
    frames = [ANSI.sub("", f).strip() for f in out.split("\r")]
    frames = [f for f in frames if f]
    print(f"$ sift index --full (tty): {len(frames)} frames, some of them:")
    for frame in frames[:3] + frames[-5:]:
        print(" ", frame)
    print()

    search = ["sift", "search", "--limit", "1", "--no-log", "kalman"]
    raw = run_on_tty(search, base).decode()
    print("$ sift search ... (tty), the first 300 characters, repr():")
    print(repr(raw[:300]))
    print(f"escape sequences: {len(ANSI.findall(raw))}")
    print()

    plain = run_on_tty(search, dict(base, NO_COLOR="1")).decode()
    count = len(ANSI.findall(plain))
    print(f"$ NO_COLOR=1 sift search ... (tty): escape sequences: {count}")
    print(plain.splitlines()[0])


if __name__ == "__main__":
    main()
```

```text
$ rm -rf /tmp/sift-scratch/ch19/idx2; \
    python3 /tmp/sift-scratch/ch19/pty_run.py /tmp/sift-scratch/ch19/idx2
$ sift index --full (tty): 34 frames, some of them:
  indexing ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   0/123 0:00:00
  indexing ━━╸━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   8/123 0:00:00
  indexing ━━━━━╺━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  16/123 0:00:00
  indexing ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 123/123 0:00:01
  indexing ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 123/123 0:00:01
  documents: 123
  vocabulary: 81167
  full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took 3277.7 ms

$ sift search ... (tty), the first 300 characters, repr():
'╭───┬───────┬──────────────────────────────────────────────────────────────────────────────────────╮\r\n│\x1b[1m \x1b[0m\x1b[1m#\x1b[0m\x1b[1m \x1b[0m│\x1b[1m \x1b[0m\x1b[1mscore\x1b[0m\x1b[1m \x1b[0m│\x1b[1m \x1b[0m\x1b[1mdocument                                                                            \x1b[0m\x1b[1m \x1b[0m│\r\n├───┼───────┼───────────'
escape sequences: 30

$ NO_COLOR=1 sift search ... (tty): escape sequences: 0
 1    5.062  corpus/posts/kalman-filter-01-one-dimension.md
```

三件事。第一，进度条：它在 stderr 上用回车重画同一行，我把输出按 `\r` 切开得到 34 帧，前三帧的计数是 0、8、16，步长 8 和 `ceil(123/16)` 吻合：123 个文件被切成 16 块，每合并一块回调一次。最后一帧的 `123/123` 出现在第 1 秒，后面还有近 2 秒花在写段文件和数据库上，进度条那时已经满了，这是个小缺憾：它只表示“解析完”，不表示“整个命令完”。进度条是 `transient=True`，结束时擦掉，所以最后三行才是 `documents`、`vocabulary` 和 `full rebuild`。第二，搜索：终端上输出的是圆角表格，一共 30 个转义序列，前 300 个字符里能看到的是表头的粗体。第三，同一个终端上设 `NO_COLOR=1`，转义序列 0 个，第一行回到了第 18 篇的纯文本：序号、分数、路径。

管道里逐字节相同，我用 `md5sum` 比。脚本对每条命令各跑一遍 `ch18` 和 `ch19` 的源码，把耗时那一部分的数字掩掉（`N ms`、`"took_ms": N`），只比其余：

```bash
#!/usr/bin/env bash
# Compare the piped output of the ch18 and ch19 command lines.
# Usage: bash plain_parity.sh INDEX_DIR CH18_SRC CH19_SRC
export SIFT_INDEX=$1
old=$2
new=$3

mask() {
    sed -E 's/[0-9]+(\.[0-9]+)? ms/N ms/g; s/"took_ms": [0-9.e-]+/"took_ms": N/'
}

check() {
    local a b
    a=$(PYTHONPATH=$old python3 -m sift "$@" 2>&1 | mask | md5sum)
    b=$(PYTHONPATH=$new python3 -m sift "$@" 2>&1 | mask | md5sum)
    if [ "$a" = "$b" ]; then verdict=same; else verdict=DIFFERENT; fi
    printf '%-10s sift' "$verdict"
    printf ' %q' "$@"
    echo
}

check search kalman --no-log
check search --json --no-log "device tree"
check search --no-log '"kalman filter" -ukf'
check search --no-log '"kalman'
check stats
check show 3
check index --corpus corpus/posts
check index --corpus /nonexistent
```

```text
$ bash /tmp/sift-scratch/ch19/plain_parity.sh /tmp/sift-scratch/ch19/idx \
    /tmp/c18src "$PWD/src"
same       sift search kalman --no-log
same       sift search --json --no-log device\ tree
same       sift search --no-log \"kalman\ filter\"\ -ukf
same       sift search --no-log \"kalman
same       sift stats
same       sift show 3
same       sift index --corpus corpus/posts
same       sift index --corpus /nonexistent
```

八条都一样，包括错误信息（`2>&1` 把 stderr 也并进来了）。`--json` 一条值得单独说：JSON 输出是别的程序要读的，所以它不走 rich，`run_search` 里 `as_json` 为真就直接 `print(json.dumps(...))` 然后 `return`（`src/sift/cli.py` 第 463 到 480 行）。这套规则的边界是上一节说过的：typer 自己的帮助页和用法错误不受它管。

### 表格

终端里的搜索结果由 `hit_table` 画，`src/sift/render.py` 第 70 到 88 行：

```python
def hit_table(result: SearchResult) -> Table:
    """Return the table of the hits: rank, score, title, path, snippet."""
    from rich import box
    from rich.table import Table
    from rich.text import Text

    table = Table(box=box.ROUNDED, show_lines=True, expand=True)
    table.add_column("#", justify="right", no_wrap=True)
    table.add_column("score", justify="right", no_wrap=True)
    table.add_column("document", ratio=1, overflow="fold")
    for rank, hit in enumerate(result.hits, 1):
        cell = Text()
        cell.append(hit.title, style="bold cyan")
        cell.append("\n")
        cell.append(str(hit.path), style="dim")
        cell.append("\n")
        cell.append_text(snippet_text(hit.snippet))
        table.add_row(str(rank), f"{hit.score:.3f}", cell)
    return table
```

三列：序号和分数不换行、右对齐，第三列 `ratio=1` 吃掉剩下的宽度，`overflow="fold"` 让超长的路径折行而不是被截断。标题、路径和摘要放在同一个单元格里用换行分开，因为 rich 的表格按列算宽度，中文标题和英文摘要混在一列里，rich 按单元格宽度（`cell_len`，一个汉字占两格）折行，这是它比我手写对齐强的地方。

### 日志和回溯

第 9 篇留下的 `setup_logging(level, *, rich=...)` 以前忽略 `rich`，这一章让它起作用。

用两个处理器各记三条同样的日志（一个二十行的脚本，没有贴进来），在管道上得到：

```text
--- setup_logging('DEBUG', rich=False)
DEBUG sift.demo: opened segment.sft
WARNING sift.demo: skipping a.md: bad front matter [x]
--- setup_logging('DEBUG', rich=True)
DEBUG    sift.demo: opened segment.sft                                          
WARNING  sift.demo: skipping a.md: bad front matter [x]                         
```

`RichHandler` 把级别放进固定宽度的一列，消息和后面补满的空格对齐，在终端里级别还会上色。注意第二条消息里的 `[x]` 原样保留了：`log.py` 里创建处理器时写了 `markup=False`，否则日志消息里的方括号又会掉进上一节那个坑。命令行只在 stderr 是终端时才传 `rich=True`。

`--debug` 还会让未捕获的异常和 Sift 自己处理的错误用 rich 的回溯显示（`install_traceback` 和 `fail()` 里的 `print_traceback`）。`rich` 的回溯会把出错的几行源码带出来，路径是绝对路径，下面我把仓库路径用 `sed` 去掉再贴：

```text
$ sift --debug search --no-log '"kalman' 2>&1 | sed "s|$PWD/||" \
    | sed -n 1,6p
╭───────────────────── Traceback (most recent call last) ──────────────────────╮
│ src/sift/cli.py:441 in run_search                │
│                                                                              │
│   438 │   directory = index_dir(config)                                      │
│   439 │   require_index(directory)                                           │
```

我只贴了前 6 行；后面是出错的那一行 `parse(text)` 和 `parse`、`__init__`、词法分析器 `iter_tokens` 三帧，退出码是 3，和不加 `--debug` 时一样。这里 `--debug` 把一个“预期内的用户错误”也印成了调用栈，这正是它存在的目的：平时用户只看到 `unterminated phrase` 和一个插入符，要排查时再加 `--debug`。框的右边竖线有两处对不齐，是因为我用 `sed` 把绝对路径换成了相对路径，字符串变短了，框是 rich 按原来的路径长度画的，不是 rich 的毛病。

### 那张图

这一章要求有一张 `sift search "kalman filter"` 的图。rich 能把录下来的控制台导出成 SVG：`Console(record=True)` 把所有输出连同样式都记下来，`save_svg` 写出一个 SVG 文件（`rich/console.py` 第 2606 行起）。`lab/ch19/rich_search_svg.py` 的 `main`（第 28 到 55 行）在临时目录里建索引，用 `Searcher` 搜 `kalman filter`，在一个 `Console(file=io.StringIO(), width=100, force_terminal=True, color_system="truecolor", record=True)` 上依次打印命令行、`render.hit_table(result)` 和摘要行，最后 `console.save_svg(...)`。


输出到 `io.StringIO`，宽度固定 100 列，`force_terminal=True` 逼 rich 以为自己在终端里。它跑得通（`make ch19` 里是 `ok`），文本部分的输出也对。但我把生成的 `lab/ch19/ch19-rich-search.svg` 在 Chromium 里打开一看，标题和摘要里的中文挤成一团，高亮的黄框也错了位。我先用 ImageMagick 转成 PNG，怀疑是它换了字体，再换成无头 Chromium 直接渲染，一模一样，所以不是渲染器的问题，是文件本身。

![sift search “kalman filter” 的终端画面：一个圆角表格，三列依次是序号、分数和文档，共五行结果，每个文档格里有青色的中文标题、灰色的路径和摘要，摘要里的 Kalman 与 filter 是黄底高亮](/assets/images/python-by-sift/ch19-rich-search.svg)

上面这张是修好之后的版本。翻 SVG 的文本，看到问题：

```text
$ grep -o '<text[^>]*>[^<]*升到高维[^<]*</text>' lab/ch19/ch19-rich-search.svg
<text class="terminal-2074516607-r4" x="170.8" y="117.6" textLength="231.8" clip-path="url(#terminal-2074516607-line-4)">升到高维：多变量卡尔曼滤波的推导与实现</text>
```

这个标题有 19 个字，每个字占两格，一格 12.2 像素，应该撑满 `19 × 2 × 12.2 = 463.6` 像素，可是 `textLength` 写的是 231.8，正好一半（`19 × 12.2`）。`textLength` 告诉浏览器“把这段文字压缩或拉伸到这个宽度”，于是每个汉字被压成了半宽，叠在一起。原因在 `rich/console.py`：高亮背景的宽度用的是 `text_length = cell_len(text)`（第 2514 行），算的是终端格数，是对的；而 `<text>` 元素的 `textLength=char_width * len(text)`（第 2534 行）用的是字符个数，对中文就少算了一半。背景框按格数画，文字按字数压，两者在第一个汉字之后就对不上了，后面的英文单词于是错位。（我读的是 rich 15.0.0 里装的那份，上游有没有改过我没有查。）

修法很小：把每个 `<text>` 的 `textLength` 改成 `cell_len(文本) × 12.2`。我写了一个脚本做这件事，原文件不动，写到另一个文件：

```python
"""Rewrite the textLength of a rich SVG from characters to cells."""

import html
import re
import sys
from pathlib import Path

from rich.cells import cell_len

CHAR_WIDTH = 12.2  # font size 20 times rich's aspect ratio 0.61
TEXT = re.compile(r'<text([^>]*?)textLength="[\d.]+"([^>]*)>([^<]*)</text>')


def fix(match: re.Match[str]) -> str:
    """Return the element with textLength = cells * CHAR_WIDTH."""
    head, tail, text = match.groups()
    cells = cell_len(html.unescape(text))
    if cells == 0:
        return match.group(0)  # a bare newline: nothing to measure
    length = round(cells * CHAR_WIDTH, 1)
    return f'<text{head}textLength="{length}"{tail}>{text}</text>'


def main() -> None:
    """Read argv[1], write the fixed copy to argv[2]."""
    source = Path(sys.argv[1]).read_text(encoding="utf-8")
    Path(sys.argv[2]).write_text(TEXT.sub(fix, source), encoding="utf-8")


if __name__ == "__main__":
    main()
```

`CHAR_WIDTH = 12.2` 是 rich 的 `font_aspect_ratio` 0.61 乘字号 20（`save_svg` 的默认参数在 `console.py` 第 2606 到 2616 行）；`html.unescape` 是因为 SVG 里的空格写成了 `&#160;`；只含换行的元素宽度是 0，我让它保持原样。文件里共 220 个 `<text>` 元素，数值真正变了的是 14 个，全是含中文的，其余原样。我把改过的文件放进了这个博客的 `public/assets/images/python-by-sift/ch19-rich-search.svg`，上面的图用的就是它。仓库里的 `lab/ch19/ch19-rich-search.svg` 我没有动，它还是有问题的那一份，列在文末的缺口里。

这张 SVG 有一点值得知道：文件里有 `@font-face` 指向 `cdnjs.cloudflare.com` 上的 Fira Code（`grep` 出了四个网址），作为 `<img>` 嵌进网页时，我猜浏览器不会去加载这些外部字体，会退回本机的等宽字体，字形和 Fira Code 不同，但 `textLength` 把宽度锁死了，所以版面不会乱。这只是我的推测，我在无头 Chromium 里的截图（本机字体）是对的，没有在别的浏览器或别的字体下验证。

## uv：装得快，只是因为它在做另一件事

这一章的另一半是项目怎么管、怎么发给别人。先量一个最直接的问题：把同一个 wheel 装进一个新的虚拟环境，`python -m venv` 加 `pip` 要多久，`uv venv` 加 `uv pip` 要多久。为了让网络不插手，我先把 `sift` 和它的 10 个依赖的 wheel 都下载到一个本地目录，两个安装器都只从这个目录装（pip 用 `--no-index --find-links`，uv 加上 `--offline`）。两边都轮流跑，每一轮换先后顺序：

```python
"""Time venv and install of the sift wheel: venv + pip, or uv.

All wheels (sift and its 10 dependencies) are downloaded once into a
directory; both installers then work from it with no index, so the
network is out of the picture. Rounds swap the order of the two.
"""

import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROUNDS = 7


def run(*argv: str | Path) -> None:
    """Run a command quietly; raise if it fails."""
    subprocess.run([str(a) for a in argv], check=True, capture_output=True)


def with_pip(wheels: Path, work: Path) -> tuple[float, float]:
    """Return seconds for `python -m venv` and for `pip install`."""
    env = work / "pip-venv"
    start = time.perf_counter()
    run(sys.executable, "-m", "venv", env)
    made = time.perf_counter()
    run(
        env / "bin" / "pip", "install", "--no-index",
        "--find-links", wheels, "sift",
    )  # fmt: skip
    done = time.perf_counter()
    shutil.rmtree(env)
    return made - start, done - made


def with_uv(wheels: Path, work: Path) -> tuple[float, float]:
    """Return seconds for `uv venv` and for `uv pip install`."""
    env = work / "uv-venv"
    start = time.perf_counter()
    run("uv", "venv", env)
    made = time.perf_counter()
    run(
        "uv", "pip", "install", "--python", env / "bin" / "python",
        "--offline", "--no-index", "--find-links", wheels, "sift",
    )  # fmt: skip
    done = time.perf_counter()
    shutil.rmtree(env)
    return made - start, done - made


def main() -> None:
    """Download once, then alternate the two installers."""
    wheel = next(Path(sys.argv[1]).glob("*.whl"))
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        wheels = work / "wheels"
        run(sys.executable, "-m", "pip", "download", "-d", wheels, wheel)
        count = len(list(wheels.glob("*.whl")))
        print(f"{count} wheels in the local directory")
        results: dict[str, list[tuple[float, float]]] = {"pip": [], "uv": []}
        steps = {"pip": with_pip, "uv": with_uv}
        for n in range(ROUNDS):
            order = ("pip", "uv") if n % 2 == 0 else ("uv", "pip")
            for name in order:
                results[name].append(steps[name](wheels, work))
        for name, values in results.items():
            venv = statistics.median(v for v, _ in values)
            install = statistics.median(i for _, i in values)
            print(
                f"{name:<4} venv {venv:5.2f} s  install {install:5.2f} s  "
                f"(median of {ROUNDS})"
            )


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/cpu_state.py; \
    python3 /tmp/sift-scratch/ch19/install_compare.py out/ch19/dist; \
    python3 /tmp/sift-scratch/cpu_state.py
113 110 112 114 112 ms
11 wheels in the local directory
pip  venv  2.08 s  install  2.59 s  (median of 7)
uv   venv  0.01 s  install  0.03 s  (median of 7)
119 117 113 115 114 ms
```

pip 一侧一共 4.7 秒，uv 一侧 0.04 秒。拆开看：`python -m venv` 要 2.08 秒，因为它还要在新环境里装一份 pip (`ensurepip`)，uv 的环境里没有 pip，0.01 秒；装 11 个 wheel，pip 2.59 秒，uv 0.03 秒，约 86 倍。我想强调一下这个比较的范围：它比的是“本地已有 wheel、没有网络”这种最理想的情形，也只量了这一个包；uv 快主要是因为它是编译的程序、用硬链接从缓存里“装”文件，而不是一个个复制，这后半句是我的理解，我没有去验证 uv 这次是不是用了硬链接。真实世界里有网络、有解析，差距没有这么大，下面 `uv lock` 的 4 秒就是网络和解析。

### 用 uv 管一个项目

`lab/ch19/extra.sh` 里的 `uv_demo` 在临时目录里从头建一个小项目：`uv init --package`、`uv add rich`、`uv lock`、`uv run`、`uv tree`，仓库保持干净。`lab/ch19/uv_demo/` 里放的是它产生的 `pyproject.toml` 和 `uv.lock` 作参考。下面是 `out/ch19/uv_demo.txt` 的内容，三处处理：临时目录替换成 `$TMP`；`uv init` 从我的 git 配置里填进 `pyproject.toml` 的 `authors` 三行我删掉了（里面是我的邮箱）；中间的 `cat pyproject.toml` 和 `head -n 20 uv.lock` 两段我省略了（前者就是下面说的 `uv_build` 那几行，后者是 `uv.lock` 的头部）。

```text
$ bash lab/ch19/extra.sh   # the uv_demo part of out/ch19/uv_demo.txt
uv 0.12.5 (x86_64-unknown-linux-gnu)
$ uv init --package --vcs none --name uv-demo
Initialized project `uv-demo`
$ uv add rich
Using CPython 3.14.7 interpreter at: /nix/store/ls26898yzdy2wn1cvh3zkr420lsx2dvw-python3-3.14.7-env/bin/python
Creating virtual environment at: .venv
Resolved 5 packages in 4.24s
   Building uv-demo @ file://$TMP/uv-project
      Built uv-demo @ file://$TMP/uv-project
Downloading pygments (1.2MiB)
 Downloaded pygments
Prepared 5 packages in 2.52s
Installed 5 packages in 7ms
 + markdown-it-py==4.2.0
 + mdurl==0.1.2
 + pygments==2.21.0
 + rich==15.0.0
 + uv-demo==0.1.0 (from file://$TMP/uv-project)
$ uv lock   # cache already filled by uv add
Resolved 5 packages in 1ms
uv lock, warm cache: 0.085 s
Resolved 5 packages in 4.71s
uv lock, empty cache: 4.800 s
$ uv run uv-demo
Hello from uv-demo!
$ uv tree
Resolved 5 packages in 1ms
uv-demo v0.1.0
└── rich v15.0.0
    ├── markdown-it-py v4.2.0
    │   └── mdurl v0.1.2
    └── pygments v2.21.0
--- diff against lab/ch19/uv_demo (versions move with PyPI) ---
```

最后一行是脚本把这次生成的文件和仓库里留的参考副本做 `diff` 的标题，下面没有输出，这一次两者没有差别。我对此不会下保证：`uv.lock` 里的版本跟着 PyPI 走，`pygments` 在这个 uv 项目里是 2.21.0，而 `nix develop` 里装的是 2.20.0；几个月后重跑，这个 diff 大概率不是空的。

几件事可以从输出里读出来：

- `uv add rich` 一条命令做了五件事：创建 `.venv`（它在 `Using CPython 3.14.7 interpreter` 那里选了解释器），解析依赖（`Resolved 5 packages`），写 `pyproject.toml` 的 `dependencies`，写 `uv.lock`，把包装进 `.venv`。5 个包是 `rich` 加它的 4 个传递依赖，`uv tree` 画出了树。`uv-demo` 自己也在那 5 个里，是以可编辑方式装进去的（`Built uv-demo @ file://...`）。
- `uv lock` 的耗时有两个：缓存已经有内容时 0.085 秒，缓存清空后 4.800 秒（脚本里 `rm uv.lock; rm -rf "$UV_CACHE_DIR"` 再锁一次）。差的 4.7 秒是联网取 `rich` 及其依赖的元数据。之前我手动跑过一次冷缓存是 4.211 秒，所以“约 4 到 5 秒”才是我敢说的，不是某个精确值；这几个数以秒计，我没有夹 `cpu_state`。
- `uv.lock` 是文本的 TOML，记录每个包的版本、来源、下载地址和哈希。文档（`docs/concepts/projects/layout.md` 第 79 到 96 行，uv 0.12.5）说它是“通用的”、跨平台的锁文件，应该提交进版本控制，由 uv 管理，不要手改。`uv run` 会自动保证锁文件是新的、环境同步到它（`docs/concepts/projects/sync.md` 第 9 到 32 行），想关掉用 `--locked`、`--frozen` 或 `--no-sync`。
- `uv init --package` 默认选的构建后端是 uv 自己的 `uv_build`（`lab/ch19/uv_demo/pyproject.toml` 里是 `build-backend = "uv_build"`；`docs/concepts/projects/init.md` 第 67 到 68 行也是这样写的）。Sift 用的是 hatchling。后端可以换，这正是 PEP 517 要的，下面打包那一节会看到。

### `uv tool` 和 `uvx`

`pipx` 解决的问题是：一个命令行程序不该装进某个项目的环境，也不该污染系统 Python，而是每个程序一个独立的环境，入口脚本放到 `PATH` 上。`uv tool install` 做的是同一件事（文档 `docs/concepts/tools.md` 第 20 到 21 行：为每个工具建一个隔离环境，可执行文件放进 `PATH`）；`uvx` 是 `uv tool run` 的别名，临时建环境、运行、不留痕迹（同一文档第 16 行）。我把 Sift 的 wheel 当工具装一遍，用临时的 `UV_TOOL_DIR` 和 `UV_TOOL_BIN_DIR`，不碰我自己的工具目录：

```bash
#!/usr/bin/env bash
# uv tool install and uvx, in a throw-away directory.
# Usage: bash uv_tools.sh WHEEL   (inside nix develop, at the repo root)
set -euo pipefail
repo=$PWD
wheel=$(realpath "$1")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export UV_TOOL_DIR=$work/tools UV_TOOL_BIN_DIR=$work/bin
export UV_CACHE_DIR=$work/cache UV_NO_PROGRESS=1
unset VIRTUAL_ENV

# Keep the output free of this machine's paths.
mask() { sed "s|$work|\$TMP|g; s|$wheel|<wheel>|g; s|$repo/||g"; }

echo '$ uv tool install sift-0.1.0-py3-none-any.whl'
uv tool install "$wheel" 2>&1 | mask
echo '$ uv tool list'
uv tool list 2>&1 | mask
echo '$ ls $UV_TOOL_BIN_DIR; head -n 3 $UV_TOOL_BIN_DIR/sift'
ls "$UV_TOOL_BIN_DIR"
head -n 3 "$UV_TOOL_BIN_DIR/sift" | mask
echo '$ $UV_TOOL_BIN_DIR/sift --version'
"$UV_TOOL_BIN_DIR/sift" --version
echo '$ uv tool uninstall sift'
uv tool uninstall sift 2>&1
echo '$ uvx --from sift-0.1.0-py3-none-any.whl sift --version'
uvx --from "$wheel" sift --version 2>&1 | mask
```

```text
$ bash /tmp/sift-scratch/ch19/uv_tools.sh \
    out/ch19/dist/sift-0.1.0-py3-none-any.whl
$ uv tool install sift-0.1.0-py3-none-any.whl
Resolved 11 packages in 4.27s
Downloading pygments (1.2MiB)
Downloading sqlalchemy (4.4MiB)
 Downloaded pygments
 Downloaded sqlalchemy
Prepared 11 packages in 3.38s
Installed 11 packages in 9ms
 + annotated-doc==0.0.5
 + click==8.5.0
 + markdown-it-py==4.2.0
 + mdurl==0.1.2
 + pygments==2.21.0
 + rich==15.0.0
 + shellingham==1.5.4
 + sift==0.1.0 (from file://<wheel>)
 + sqlalchemy==2.1.6
 + typer==0.27.3
 + typing-extensions==4.16.0
Installed 1 executable: sift
warning: `$TMP/bin` is not on your PATH. To use installed tools, run `export PATH="$TMP/bin:$PATH"` or `uv tool update-shell`.
$ uv tool list
sift v0.1.0
- sift
$ ls $UV_TOOL_BIN_DIR; head -n 3 $UV_TOOL_BIN_DIR/sift
sift
#!$TMP/tools/sift/bin/python
# -*- coding: utf-8 -*-
import sys
$ $UV_TOOL_BIN_DIR/sift --version
sift 0.1.0
$ uv tool uninstall sift
Uninstalled 1 executable: sift
$ uvx --from sift-0.1.0-py3-none-any.whl sift --version
Installed 11 packages in 10ms
sift 0.1.0
```

`sift` 这个入口脚本的第一行是工具自己的 Python (`$TMP/tools/sift/bin/python`)，不是系统的，所以它能找到自己的依赖，不管我当前在哪个环境。`uvx` 做同一件事但不留下东西，第二次运行只花了 10 毫秒装包，因为缓存是热的。

### Nix 上为什么关掉 Python 下载

flake 的 `shellHook` 里导出了 `UV_PYTHON_DOWNLOADS=never UV_PYTHON=python3.14`。uv 的默认行为是找不到合适的 Python 就自己下载一份（文档 `docs/concepts/python-versions.md` 第 50 到 52 行），用 `python-downloads` 设置可以关（第 367 到 372 行）。我在这个 shell 里把几种情形都试一遍：

```bash
#!/usr/bin/env bash
# What uv does about Python versions in this dev shell, and why the
# flake turns downloads off. Run inside nix develop.
unset VIRTUAL_ENV
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo '$ echo $UV_PYTHON $UV_PYTHON_DOWNLOADS'
echo "$UV_PYTHON $UV_PYTHON_DOWNLOADS"
echo '$ uv venv --python 3.12 $TMP/v   # no 3.12 on this machine'
uv venv --python 3.12 "$tmp/v" 2>&1 | sed "s|$tmp|\$TMP|g"
echo "exit ${PIPESTATUS[0]}"

echo '$ UV_PYTHON_DOWNLOADS=automatic uv python install 3.13'
UV_PYTHON_DOWNLOADS=automatic UV_PYTHON_INSTALL_DIR="$tmp/py" \
    uv python install 3.13 2>&1 | sed "s|$tmp|\$TMP|g"
python=$(ls -d "$tmp"/py/cpython-3.13.15-*/bin/python3.13)
echo '$ <downloaded python> -V'
"$python" -V
echo '$ readelf -l <downloaded python> | grep interpreter'
readelf -l "$python" | grep -i interpreter
echo '$ readlink -f /lib64/ld-linux-x86-64.so.2'
readlink -f /lib64/ld-linux-x86-64.so.2 | sed 's|-[0-9.]*/bin/nix-ld|-VERSION/bin/nix-ld|'
echo '$ <the stub loader NixOS uses without nix-ld> <downloaded python>'
stub=$(ls -d /nix/store/*-stub-ld-x86_64-unknown-linux-musl | head -n 1)
"$stub" "$python" 2>&1 | sed "s|$stub|\$STUB_LD|g"
echo "exit ${PIPESTATUS[0]}"
```

```text
$ bash /tmp/sift-scratch/ch19/python_downloads.sh
$ echo $UV_PYTHON $UV_PYTHON_DOWNLOADS
python3.14 never
$ uv venv --python 3.12 $TMP/v   # no 3.12 on this machine
error: No interpreter found for Python 3.12 in managed installations or search path

hint: A managed Python download is available for Python 3.12, but Python downloads are set to 'never'
exit 2
$ UV_PYTHON_DOWNLOADS=automatic uv python install 3.13
Downloading cpython-3.13.15-linux-x86_64-gnu (download) (33.2MiB)
 Downloaded cpython-3.13.15-linux-x86_64-gnu (download)
Installed Python 3.13.15 in 12.55s
 + cpython-3.13.15-linux-x86_64-gnu (python3.13)
$ <downloaded python> -V
Python 3.13.15
$ readelf -l <downloaded python> | grep interpreter
      [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]
$ readlink -f /lib64/ld-linux-x86-64.so.2
/nix/store/hdbkdfbfblpp8xsgmy05mzfmanvry8cw-nix-ld-VERSION/bin/nix-ld
$ <the stub loader NixOS uses without nix-ld> <downloaded python>
Could not start dynamically linked executable: $STUB_LD
NixOS cannot run dynamically linked executables intended for generic
linux environments out of the box. For more information, see:
https://nix.dev/permalink/stub-ld
exit 127
```

关掉以后，要不存在的 Python 版本会明确报错（退出码 2），而不是悄悄下载一份。原因在后面几行：uv 下载的是预编译的、动态链接的 CPython，ELF 头里写着解释器是 `/lib64/ld-linux-x86-64.so.2`，那是一个通用 Linux 的路径。NixOS 默认没有这个文件，那个位置放的是一个 stub，打印上面那段“NixOS cannot run dynamically linked executables”然后退出 127；`nix-ld` 这个模块可以把它换成一个真的加载器。我的这台机器恰好启用了 `nix-ld`（`readlink` 的结果），所以下载的 Python 3.13.15 在这里能跑（`-V` 打印了版本）。这意味着：我这台机器上关掉下载并不是“因为它在这里会坏”，而是 flake 给所有人写的默认，别的 NixOS 机器没有 `nix-ld` 就会坏。“没有 `nix-ld` 的机器上下载的 Python 会失败”这一点我没有在那样的机器上试过，stub 的输出只能说明 stub 会说什么，这是个推断（unverified）。另外 `UV_PYTHON=python3.14` 把 uv 钉在了 shell 里的解释器上，所以前面所有 `uv` 命令用的都是 `nix develop` 给的那个 3.14.7。

## 打包：wheel 和 sdist

### 三份文档划分了谁管什么

一个 Python 项目要变成可安装的东西，涉及三份 PEP，它们各管一件事。我读的是上面说的 `python/peps` 提交 `018ddd7`：

- PEP 518 (`Status: Final`) 规定 `pyproject.toml` 里的 `[build-system]` 表，其中的 `requires` 列出构建要用的包。
- PEP 517 (`Status: Final`) 规定构建后端的接口：`[build-system]` 里的 `build-backend` 指向一个 Python 对象，它必须提供 `build_wheel` 这个钩子（`pep-0517.rst` 第 211 行）；前端（`pip`、`build`、`uv`）调它，而不关心后端内部怎么做。
- PEP 621 (`Status: Final`) 规定 `[project]` 表：名字、版本、依赖、可选依赖、脚本入口都写在这里，不再是后端自己的格式；动态字段必须在 `dynamic` 里声明。

Sift 的 `pyproject.toml`（标签 `ch19`，全文）：

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "sift"
version = "0.1.0"
description = "A local full-text search engine for Markdown posts."
requires-python = ">=3.14"
license = "MIT OR Apache-2.0"
license-files = ["LICENSE-MIT", "LICENSE-APACHE"]
dependencies = [
  "sqlalchemy>=2.0.51",
  "typer>=0.25",
  "click>=8.2.1",
  "rich>=15",
]

[project.optional-dependencies]
web = [
  "fastapi>=0.139",
  "uvicorn>=0.51",
  "httpx>=0.28",
  "pydantic>=2.13",
]

[project.scripts]
sift = "sift.cli:main"

[tool.hatch.build.targets.wheel]
packages = ["src/sift"]

[tool.pytest.ini_options]
addopts = "--doctest-modules -q"
testpaths = ["tests", "src"]
markers = [
  "slow: needs the full corpus or many generated cases",
]

[tool.mypy]
strict = true
python_version = "3.14"
files = ["src"]
mypy_path = "src"

[tool.pyright]
typeCheckingMode = "strict"
include = ["src"]
pythonVersion = "3.14"
```

`requires = ["hatchling"]` 没有版本。这有一个后果，我下面会量到。`[project.scripts]` 里的 `sift = "sift.cli:main"` 就是命令行入口：安装时生成一个叫 `sift` 的可执行文件，调用 `sift.cli.main()`，这也是为什么 `main` 要能当普通函数调用并且成功时返回。

hatchling 把这些钩子写成了薄薄的包装：`hatchling/build.py`（1.31.0）里的 `build_wheel`（第 33 到 44 行）和 `build_sdist`（第 22 到 29 行）各自建一个 `WheelBuilder` 或 `SdistBuilder` 然后 `build`。`python -m build`（build 1.5.1）是个前端：不带参数时先从源码树造 sdist，再从 sdist 造 wheel（`build/__main__.py` 第 844 行：`build_package_via_sdist`，日志里是 `Building wheel from sdist`）。

### 隔离构建

PEP 518 的 `requires` 是给“隔离构建”用的：前端为每次构建建一个临时环境，只装 `requires` 里的东西。我的 `make ch19` 里用 `--no-isolation`，直接用 `nix develop` 里已有的 hatchling 1.31.0，因为在 Nix 里让前端联网装一份 hatchling 不是我要的。三种方式我量一下，对一个干净的检出 (`git archive HEAD`) 建 wheel：

```bash
#!/usr/bin/env bash
# Build the wheel of a clean checkout three ways and time each.
# Usage: bash isolated_build.sh REPO_DIR   (inside nix develop)
set -euo pipefail
repo=$(realpath "$1")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -C "$repo" archive HEAD | tar -x -C "$work"
cd "$work"
unset VIRTUAL_ENV
export UV_CACHE_DIR=$work/uv-cache PIP_CACHE_DIR=$work/pip-cache

timeit() {
    local label=$1
    shift
    local start=$EPOCHREALTIME
    "$@" > "$work/log.txt" 2>&1
    awk -v a="$start" -v b="$EPOCHREALTIME" -v l="$label" \
        'BEGIN { printf "%-34s %5.2f s\n", l, b - a }'
}

timeit 'build --no-isolation' \
    python3 -m build --wheel --no-isolation --outdir o1 .
timeit 'build (isolated, pip, cold cache)' \
    python3 -m build --wheel --outdir o2 .
timeit 'build --installer uv (cold cache)' \
    python3 -m build --wheel --installer uv --outdir o3 .
echo '# the isolated run, as pip saw it:'
python3 -m build --wheel --outdir o4 . 2>&1 | sed -n 1,6p
```

```text
$ bash /tmp/sift-scratch/ch19/isolated_build.sh .
build --no-isolation                0.32 s
build (isolated, pip, cold cache)  58.96 s
build --installer uv (cold cache)   4.90 s
# the isolated run, as pip saw it:
* Creating isolated environment: venv+pip...
* Installing packages in isolated environment:
  - hatchling
* Getting build dependencies for wheel...
* Installed build dependency versions:
  - hatchling==1.32.4
```

不隔离 0.32 秒；隔离、用 pip、冷缓存 58.96 秒；隔离、`--installer uv`、冷缓存 4.90 秒。58.96 秒这个数让我意外，我把这一项单独重跑了两次：第一次 59.05 秒，紧接着的第二次（pip 缓存已经热了）1.10 秒。它可复现，所以不是网络偶然抖了一下，但为什么 pip 冷缓存要等将近一分钟，我没有查出来（`python -m venv` 单独要 2.04 秒，不是它），这是我留下的疑问。

这里面更重要的是最后一行：隔离环境装的是 `hatchling==1.32.4`，而我的开发环境是 1.31.0。同一份源码，两种方式建出来的 wheel，`WHEEL` 文件里的 `Generator:` 就不同了，我重跑那次打印了它：隔离构建的是 `Generator: hatchling 1.32.4`，`RECORD` 的哈希也就跟着不同（`add603642ac9` 对 `c23f2d1b4949` 的前 12 位）。原因是 `requires = ["hatchling"]` 没有上限甚至没有下限，每次隔离构建装的是当天 PyPI 上最新的 hatchling。要可复现的构建，该给它加约束，比如 `hatchling>=1.31,<2`。我没有改仓库里的 `pyproject.toml`，这在文末列为缺口。（这个 wheel 里的 `.py` 文件内容当然是一样的，两个 `RECORD` 的差别只在 `WHEEL` 那一行；我没有逐行比较整个 `RECORD`，这是个推断，依据是 `WHEEL` 是唯一记录 hatchling 版本的文件。）

### wheel 里面是什么

wheel 是一个 ZIP，格式在 `binary-distribution-format.rst`（packaging.python.org 的规范页，提交 `d1ad4ad`）里写得很清楚：文件名是 `{distribution}-{version}-{python tag}-{abi tag}-{platform tag}.whl`（第 92 行），里面是要装到 `site-packages` 的文件加一个 `{distribution}-{version}.dist-info/` 目录，目录里有 `METADATA`、`WHEEL`、`RECORD`（第 187 到 199 行），许可证文件放在 `licenses/` 子目录（第 188 行）。Sift 的 wheel：

```text
$ w=out/ch19/dist/sift-0.1.0-py3-none-any.whl
$ unzip -l "$w" | sed -n '1,8p;/dist-info/p;$p'
Archive:  sift-0.1.0-py3-none-any.whl
  Length      Date    Time    Name
---------  ---------- -----   ----
      768  01-01-1980 00:00   sift/__init__.py
      131  01-01-1980 00:00   sift/__main__.py
     2885  01-01-1980 00:00   sift/cache.py
    24594  01-01-1980 00:00   sift/cli.py
     6694  01-01-1980 00:00   sift/client.py
      539  01-01-1980 00:00   sift-0.1.0.dist-info/METADATA
       87  01-01-1980 00:00   sift-0.1.0.dist-info/WHEEL
       39  01-01-1980 00:00   sift-0.1.0.dist-info/entry_points.txt
    11358  01-01-1980 00:00   sift-0.1.0.dist-info/licenses/LICENSE-APACHE
     1064  01-01-1980 00:00   sift-0.1.0.dist-info/licenses/LICENSE-MIT
     3727  01-01-1980 00:00   sift-0.1.0.dist-info/RECORD
   264197                     49 files
$ ls -l out/ch19/dist
total 388
-rw-r--r-- 1 user group  96448 Oct 24 21:46 sift-0.1.0-py3-none-any.whl
-rw-r--r-- 1 user group 298117 Oct 24 21:46 sift-0.1.0.tar.gz
```

（`Archive:` 那行我把路径缩成了文件名，`ls` 里把用户名和组换成了 `user group`。）wheel 是 96,448 字节，49 个文件，解压后 264,197 字节：压缩比约 2.7。所有时间戳都是 1980-01-01，是 ZIP 格式能表示的最早日期，构建工具把它固定下来，同样的输入就能得到同样的字节，我没有为这一点单独做实验。里面没有 `tests/`、`lab/`、没有 `__pycache__`（`wheel_anatomy.sh` 数过，是 0）。

文件名里的 `py3-none-any` 是三个标签：Python 3、不依赖具体 ABI、任何平台。`WHEEL` 文件里的 `Tag: py3-none-any` 和 `Root-Is-Purelib: true` 说的是同一件事（规范第 204 行）：纯 Python，装到 `purelib`。这个包没有编译扩展，所以一个 wheel 通吃；到第 24、25 篇有了 C 和 Rust 的扩展，标签就会变成平台相关的了。元数据文件：

```text
$ unzip -p "$w" '*.dist-info/METADATA'
Metadata-Version: 2.4
Name: sift
Version: 0.1.0
Summary: A local full-text search engine for Markdown posts.
License-Expression: MIT OR Apache-2.0
License-File: LICENSE-APACHE
License-File: LICENSE-MIT
Requires-Python: >=3.14
Requires-Dist: click>=8.2.1
Requires-Dist: rich>=15
Requires-Dist: sqlalchemy>=2.0.51
Requires-Dist: typer>=0.25
Provides-Extra: web
Requires-Dist: fastapi>=0.139; extra == 'web'
Requires-Dist: httpx>=0.28; extra == 'web'
Requires-Dist: pydantic>=2.13; extra == 'web'
Requires-Dist: uvicorn>=0.51; extra == 'web'

$ unzip -p "$w" '*.dist-info/WHEEL'
Wheel-Version: 1.0
Generator: hatchling 1.31.0
Root-Is-Purelib: true
Tag: py3-none-any

$ unzip -p "$w" '*.dist-info/entry_points.txt'
[console_scripts]
sift = sift.cli:main
```

三个点。第一，`Metadata-Version: 2.4`。核心元数据规范（`core-metadata.rst`）列的合法值是 2.1 到 2.6 等（第 53 行）；`License-Expression` 和 `License-File` 这两个字段是 2.4 加的（第 488 行、第 517 行的 `versionadded`），来自 PEP 639，所以我 `pyproject.toml` 里写的 `license = "MIT OR Apache-2.0"`（一个 SPDX 表达式，不是旧的 `{text = ...}`）才会变成 `License-Expression`；`license-files` 列的两个文件被收进 `licenses/`。PEP 566 的元数据版本是 2.1，现在已经是历史了。第二，可选依赖变成了两样东西：一个 `Provides-Extra: web` 声明有这个 extra，加上四行带环境标记 `extra == 'web'` 的 `Requires-Dist`；装 `sift[web]` 时，安装器才把这四行当成必须。第三，`entry_points.txt` 里的 `[console_scripts]` 就是 `[project.scripts]` 的翻译；`pip` 或 `uv` 装 wheel 时按它生成那个 `sift` 的可执行脚本。

`RECORD` 是一份清单，列出 wheel 里每个文件、它的 sha256 和大小，规范要求除了 `RECORD` 自己以外每个文件都必须有哈希，`RECORD` 那一行的哈希和大小留空（第 239 到 244 行），安装时安装器要核对（第 250 到 253 行）。我写一个脚本来核对，哈希是 `urlsafe-base64-nopad`（第 401 到 407 行的示例）：

```python
"""Check every hash and size in the RECORD of a wheel (PEP 427)."""

import base64
import csv
import hashlib
import io
import sys
import zipfile


def digest(data: bytes) -> str:
    """Return sha256 as urlsafe base64 without padding."""
    raw = hashlib.sha256(data).digest()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def main() -> None:
    """Compare RECORD with the files in the wheel given as argv[1]."""
    with zipfile.ZipFile(sys.argv[1]) as wheel:
        names = set(wheel.namelist())
        record = next(n for n in names if n.endswith(".dist-info/RECORD"))
        rows = list(csv.reader(io.StringIO(wheel.read(record).decode())))
        bad = 0
        for path, hash_field, size in rows:
            if path == record:
                print(f"{path}: hash and size empty: {hash_field == ''}")
                continue
            data = wheel.read(path)
            want = f"sha256={digest(data)}"
            if hash_field != want or int(size) != len(data):
                bad += 1
                print("MISMATCH", path)
        listed = {row[0] for row in rows}
        print(f"{len(rows)} rows, {bad} mismatches")
        print("files not in RECORD:", sorted(names - listed))


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/ch19/record_check.py "$w"
sift-0.1.0.dist-info/RECORD: hash and size empty: True
49 rows, 0 mismatches
files not in RECORD: []
```

49 行对 49 个文件，0 个不一致。（脚本的文档字符串写着 PEP 427，现在这条规则的现行文本在 packaging.python.org 的规范页上，PEP 页首写着这一点，我引的行号是规范页的。）

### sdist：整个仓库

另一个产物是 sdist，`sift-0.1.0.tar.gz`，298,117 字节，是 wheel 的 3.1 倍。sdist 的规范（`source-distribution-format.rst`）要求里面是单个顶层目录 `{name}-{version}`，并且有 `pyproject.toml`，以及版本 2.2 以上的 `PKG-INFO`（第 17 行、第 61 到 64 行）。里面有什么，由 hatchling 决定，下面把成员按顶层目录数一遍；再在一份干净检出的副本里给 sdist 加一个 `include` 列表，看看有什么变化：

```bash
#!/usr/bin/env bash
# Build the sdist of a clean checkout twice: as is, and with include.
# Usage: bash sdist_include.sh REPO_DIR   (run inside nix develop)
set -euo pipefail
repo=$(realpath "$1")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -C "$repo" archive HEAD | tar -x -C "$work"
# git archive exports the tracked files only, like a fresh clone; the
# tracked .gitignore is what hatchling reads to leave files out.
cd "$work"
python3 -m build --sdist --no-isolation --outdir out-all . > /dev/null
cp pyproject.toml pyproject.orig
cat >> pyproject.toml <<'TOML'

[tool.hatch.build.targets.sdist]
include = ["/src", "/tests", "/LICENSE-*", "/README.md"]
TOML
python3 -m build --sdist --no-isolation --outdir out-inc . > /dev/null
for d in out-all out-inc; do
    f=$(ls $d/*.tar.gz)
    printf '%-8s %7d bytes %4d members\n' "$d" "$(stat -c %s "$f")" \
        "$(tar tzf "$f" | wc -l)"
done
echo '# members of out-all by top-level directory'
tar tzf out-all/*.tar.gz | cut -d/ -f2 | sort | uniq -c | sort -rn
```

```text
$ bash /tmp/sift-scratch/ch19/sdist_include.sh . 2>&1 | grep -v '^\*' \
    | sed -n 1,8p
out-all   298117 bytes  357 members
out-inc   139755 bytes   87 members
# members of out-all by top-level directory
    260 lab
     43 src
     38 tests
      2 scripts
      1 sift.toml
```

默认的 sdist 有 357 个成员，其中 260 个是 `lab/`，也就是前 19 章的全部实验脚本，加上 CI 配置、`flake.nix`、`.envrc`；真正的源码 `src/` 只有 43 个。给它一个 `include`（`src`、`tests`、许可证、`README.md`）后，只剩 87 个成员，139,755 字节，约一半。为什么默认这样？hatchling 的规则在 `hatchling/builders/config.py`：`include_spec` 在没有任何 `include` 或 `packages` 时是 `None`（第 118 到 150 行，`default_include()` 在第 803 行返回 `[]`），而 `path_is_included` 在 `include_spec` 为 `None` 时对每个路径都返回 `True`（第 76 到 79 行）；排除靠 `.gitignore`（第 740 到 775 行 `load_vcs_exclusion_patterns` 读它）加上两条内置的：`*.py[cdo]` 和 `/dist`（第 815 到 818 行，`DEFAULT_BUILD_DIRECTORY = "dist"`，在 `constants.py` 第 1 行）。我仓库的 `.gitignore` 排除了 `/corpus/`、`/out/`、`/.sift/`、`/.venv/`、`/.tutorial/`、`/dist/` 等，所以这些没进去；其余的一切都进去了。我在仓库工作区（里面有 `corpus/`、`out/`、`.venv/`）里直接建的 sdist 也是 298,117 字节，和干净检出一样，印证了这一点。

wheel 靠 `[tool.hatch.build.targets.wheel] packages = ["src/sift"]` 只收 `src/sift`。`hatchling/builders/wheel.py` 的 `default_file_selection_options`（第 229 到 260 行）自己也会找 `src/<项目名>/__init__.py`，我在一份临时副本里去掉这个表重建过（脚本没有贴进来）：wheel 的字节数和 `RECORD` 的哈希都没变，所以那一行是多余的。

### 版本号写在哪

`pyproject.toml` 里有 `version = "0.1.0"`，运行时 `sift --version` 打印的是 `importlib.metadata.version("sift")`，两处是不是同一个东西？`lab/ch19/version_bump.py` 读三个地方的版本，再在临时副本里把 `pyproject.toml` 的补丁号加一，看会怎样：

```text
$ python3 lab/ch19/version_bump.py
importlib.metadata.version : 0.1.0
sift.__version__           : 0.1.0
pyproject.toml             : 0.1.0
Name / Requires-Python     : sift >=3.14
Requires-Dist              :
   click>=8.2.1
   rich>=15
   sqlalchemy>=2.0.51
   typer>=0.25
   fastapi>=0.139; extra == 'web'
   httpx>=0.28; extra == 'web'
   pydantic>=2.13; extra == 'web'
   uvicorn>=0.51; extra == 'web'
console script             : sift.cli:main

after a bump in a temp copy: pyproject says 0.1.1,
importlib.metadata still says 0.1.0
(pip install -e . / uv sync rewrites the METADATA)
```

`importlib.metadata` 读的是已经安装的包的 `METADATA` 文件，不是 `pyproject.toml`。改了 `pyproject.toml` 的版本号，要重新安装一次（`pip install -e .` 或 `uv sync`）元数据才跟着变。可编辑安装也是这样：它装的是源码的链接，元数据却是安装那一刻生成的快照。这就是为什么 `__init__.py` 里有一个 `0.0.0+source` 的后备值：没安装、只靠 `PYTHONPATH=src` 跑的时候，`PackageNotFoundError` 会接住它。

## 装进一个什么都没有的环境

最后一道检验：把 wheel 装进新环境，看它自己能不能跑。`clean_venv_install` 在临时目录里 `uv venv`，`uv pip install` 这个 wheel，然后用这个环境里的 `sift` 对仓库的语料建索引并搜索。下面是 `out/ch19/clean_venv_install.txt`，临时目录换成了 `$TMP`，仓库路径换成了 `REPO`，超过 110 列的行截断了，中间的 `uv pip list` 一段（和上面的安装列表重复）我省略了；`sift search` 在脚本里带 `--limit 3`，所以只有 3 条：

```text
$ uv venv $TMP/sift-venv
Using CPython 3.14.7 interpreter at: /nix/store/ls26898yzdy2wn1cvh3zkr420lsx2dvw-python3-3.14.7-env/bin/python
Creating virtual environment at: $TMP/sift-venv
Activate with: source $TMP/sift-venv/bin/activate
$ uv pip install sift-0.1.0-py3-none-any.whl
Using Python 3.14.7 environment at: $TMP/sift-venv
Resolved 11 packages in 3.60s
Downloading pygments (1.2MiB)
Downloading sqlalchemy (4.4MiB)
 Downloaded pygments
 Downloaded sqlalchemy
Prepared 11 packages in 2.80s
Installed 11 packages in 9ms
 + annotated-doc==0.0.5
 + click==8.5.0
 + markdown-it-py==4.2.0
 + mdurl==0.1.2
 + pygments==2.21.0
 + rich==15.0.0
 + shellingham==1.5.4
 + sift==0.1.0 (from file://REPO/out/ch19/dist/sift-0.1.0-py3-none-any.whl)
 + sqlalchemy==2.1.6
 + typer==0.27.3
 + typing-extensions==4.16.0
uv pip install: 6.486 s
$ python -c "import sift, rich; print(sift.__file__, rich.__file__)"
$TMP/sift-venv/lib/python3.14/site-packages/sift/__init__.py
$TMP/sift-venv/lib/python3.14/site-packages/rich/__init__.py
$ sift index --corpus corpus/posts
documents: 123
vocabulary: 81167
full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took 3116.2 ms
$ sift --version
sift 0.1.0
$ sift search kalman
 1    5.062  corpus/posts/kalman-filter-01-one-dimension.md
    一维卡尔曼滤波：两个高斯相乘
    …： git clone https://github.com/bfmhno3/[kalman]-lab.git cd [kalman]-lab git checkout tutorial-v1 nix 
 2    4.717  corpus/posts/kalman-filter-02-multivariate.md
    升到高维：多变量卡尔曼滤波的推导与实现
    …aw measurement: 1.436 m position RMSE [Kalman] filter: 0.542 m velocity RMSE [Kalman] filter: 0.616 m/s
 3    4.604  corpus/posts/kalman-filter-07-ukf.md
    无迹卡尔曼滤波，以及四个滤波器同台
    …ier 和 Uhlmann 的 "A new extension of the [Kalman] filter to nonlinear systems"（1997），缩放参
8 hits in 123 files: index opened in 136.3 ms, query took 38.989 ms
```

它跑起来了，搜索结果和用开发环境跑的一样（同样的分数 5.062、4.717、4.604）。`sift` 的 `__file__` 在新环境的 `site-packages` 里，不是源码目录，所以这确实是装上去的 wheel，不是 `PYTHONPATH` 在帮忙。

这里有一件事我必须讲清楚：新环境解析出来的版本和 `nix develop` 里的不一样。`typer` 是 0.27.3（开发环境 0.25.1），`click` 是 8.5.0（8.3.3），`sqlalchemy` 是 2.1.6（2.0.51），都更新。我的依赖写的是 `typer>=0.25`、`click>=8.2.1`、`sqlalchemy>=2.0.51`，只有下限，没有上限，所以安装器取了当天最新的。它们都能跑，是一个好结果，但是一个运气：我没有拿 `sqlalchemy` 2.1 的变更去核对 `storage/db.py`，也没有跑测试套件在新环境里（`pytest` 不在这个环境里）。如果要保证“装出来的和测过的一样”，需要一个锁文件；`uv.lock` 就是做这个的，不过 Sift 本身这一章还没有锁，只有 `lab/ch19/uv_demo` 里那个小项目有。

还有一件小事：`sift index --corpus corpus/posts` 在新环境里要 3.1 秒（SQLAlchemy 2.1.6 的版本，开发环境里的全量构建是 3.3 到 3.6 秒），我不把这个当成 SQLAlchemy 2.1 变快的证据，两次测量的条件不同，波动也比这个差大。

## 发布到 PyPI：只说，没做

这一节没有一条命令是我跑出来的。我没有在 PyPI 或 TestPyPI 上注册、上传过任何东西，下面是流程的说明，你照着做之前要自己核对当时的文档。

发布分三步：构建（上面做过了，`python -m build` 产出 sdist 和 wheel），检查，上传。检查可以用 `twine check dist/*`，上传可以用 `twine upload` 或者 `uv publish`；TestPyPI 是一个独立的、可以随便试的索引，和正式的 PyPI 账号体系分开。更推荐的做法是 Trusted Publishing（让 CI 用 OIDC 令牌上传，不留长期 API 令牌）。这些命令我没有装 `twine`，也没有执行 `uv publish`，所以它们的选项和输出我都没有核对过。

有一件事我能确认：Sift 现在的名字发不了。我向 PyPI 的 JSON 接口查了一下（一个只读的 GET，没有登录）：

```text
$ curl -s -o /dev/null -w 'pypi.org/pypi/sift/json -> HTTP %{http_code}\n' \
    https://pypi.org/pypi/sift/json
pypi.org/pypi/sift/json -> HTTP 200
$ curl -s https://pypi.org/pypi/sift/json | python3 -c \
    'import json,sys; d=json.load(sys.stdin)["info"]; print(d["name"], d["version"], d["summary"][:60])'
Sift 6.1.0 Python bindings for Sift Science's API
```

`sift` 已经被另一个项目占了（一家公司的 API 绑定，版本 6.1.0）。所以真要发布，`name` 得换一个，比如 `sift-search`，而包的导入名（`import sift`）可以不变，因为 PyPI 上的名字和导入名是两回事；但同一环境里要是同时装了那个 `sift` 和我的包，就会撞同一个 `sift/` 目录，这一点我没有试。

## 本篇文件

这一章动了 22 个文件，`git diff --shortstat ch18 ch19` 给出 `22 files changed, 2226 insertions(+), 651 deletions(-)`。表里的 `+N -M` 来自 `git diff --numstat ch18 ch19`，命令是跑它对应的测试或脚本，结果是我在标签 `ch19` 上最后一次实际跑出来的；`/tmp/sift-scratch/ch19/` 里的草稿脚本不进仓库，不在表里。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`README.md`](https://github.com/bfmhno3/sift/blob/ch19/README.md) | `git diff --numstat ch18 ch19 -- README.md` | 退出码 0；`+14 -2` |
| [`extra.sh`](https://github.com/bfmhno3/sift/blob/ch19/lab/ch16/extra.sh) (ch16) | `bash lab/ch16/extra.sh` | 退出码 0，最后一行 `python3.14t / python3 = 1.18`；`+22 -3` |
| [`argparse_vs_typer.py`](https://github.com/bfmhno3/sift/blob/ch19/lab/ch19/argparse_vs_typer.py) | `python3 lab/ch19/argparse_vs_typer.py` | 退出码 0，`typer   : 25 lines, 23 code lines`；`+155 -0` |
| [`ch19-rich-search.svg`](https://github.com/bfmhno3/sift/blob/ch19/lab/ch19/ch19-rich-search.svg) | `python3 lab/ch19/rich_search_svg.py` | 退出码 0，重新生成后 `git status` 无改动（文件里中文的 `textLength` 是错的，见正文）；`+207 -0` |
| [`extra.sh`](https://github.com/bfmhno3/sift/blob/ch19/lab/ch19/extra.sh) (ch19) | `make ch19 > /tmp/ch19_make.txt 2>&1` | 退出码 0，5 个 `ok`；`+149 -0` |
| [`rich_search_svg.py`](https://github.com/bfmhno3/sift/blob/ch19/lab/ch19/rich_search_svg.py) | `python3 lab/ch19/rich_search_svg.py` | 退出码 0，`5 hits in 123 files`；`+59 -0` |
| [`rich_tour.py`](https://github.com/bfmhno3/sift/blob/ch19/lab/ch19/rich_tour.py) | `python3 lab/ch19/rich_tour.py` | 退出码 0，`saved out/ch19/rich-tour.svg (34527 bytes)`；`+73 -0` |
| [`pyproject.toml`](https://github.com/bfmhno3/sift/blob/ch19/lab/ch19/uv_demo/pyproject.toml) (uv_demo) | `python3 -c "import tomllib; ..."` 读依赖和后端 | 退出码 0，`['rich>=15.0.0'] uv_build`；`+19 -0` |
| [`uv.lock`](https://github.com/bfmhno3/sift/blob/ch19/lab/ch19/uv_demo/uv.lock) | `uv lock --check`（在临时副本里） | 退出码 0，`Resolved 5 packages in 0.81ms`；`+57 -0` |
| [`version_bump.py`](https://github.com/bfmhno3/sift/blob/ch19/lab/ch19/version_bump.py) | `python3 lab/ch19/version_bump.py` | 退出码 0，`importlib.metadata still says 0.1.0`；`+50 -0` |
| [`pyproject.toml`](https://github.com/bfmhno3/sift/blob/ch19/pyproject.toml) | `python3 -c "import tomllib; ..."` 读 `dependencies` | 退出码 0，`['sqlalchemy>=2.0.51', 'typer>=0.25', 'click>=8.2.1', 'rich>=15']`；`+3 -0` |
| [`__init__.py`](https://github.com/bfmhno3/sift/blob/ch19/src/sift/__init__.py) | `python3 -c "import sys, sift; ..."` 读 `__version__` 前后看 `importlib.metadata` | 退出码 0，`False 0.1.0 True`；`+18 -6` |
| [`cli.py`](https://github.com/bfmhno3/sift/blob/ch19/src/sift/cli.py) | `python3 -m pytest tests/test_cli.py` | 退出码 0，`126 passed in 9.31s`；`+407 -312` |
| [`log.py`](https://github.com/bfmhno3/sift/blob/ch19/src/sift/log.py) | `python3 -m pytest tests/test_log.py` | 退出码 0，`6 passed in 0.60s`；`+23 -6` |
| [`parallel.py`](https://github.com/bfmhno3/sift/blob/ch19/src/sift/parallel.py) | `python3 -m pytest tests/test_parallel.py` | 退出码 0，`44 passed in 1.98s`；`+30 -9` |
| [`render.py`](https://github.com/bfmhno3/sift/blob/ch19/src/sift/render.py) | `python3 -m pytest tests/test_render.py` | 退出码 0，`21 passed in 0.67s`；`+181 -0` |
| [`store.py`](https://github.com/bfmhno3/sift/blob/ch19/src/sift/storage/store.py) | `python3 -m pytest tests/test_store.py` | 退出码 0，`39 passed in 3.37s`；`+6 -2` |
| [`test_cli.py`](https://github.com/bfmhno3/sift/blob/ch19/tests/test_cli.py) | `python3 -m pytest tests/test_cli.py` | 退出码 0，`126 passed in 9.31s`；`+439 -311` |
| [`test_log.py`](https://github.com/bfmhno3/sift/blob/ch19/tests/test_log.py) | `python3 -m pytest tests/test_log.py` | 退出码 0，`6 passed in 0.60s`；`+28 -0` |
| [`test_parallel.py`](https://github.com/bfmhno3/sift/blob/ch19/tests/test_parallel.py) | `python3 -m pytest tests/test_parallel.py` | 退出码 0，`44 passed in 1.98s`；`+41 -0` |
| [`test_render.py`](https://github.com/bfmhno3/sift/blob/ch19/tests/test_render.py) | `python3 -m pytest tests/test_render.py` | 退出码 0，`21 passed in 0.67s`；`+204 -0` |
| [`test_store.py`](https://github.com/bfmhno3/sift/blob/ch19/tests/test_store.py) | `python3 -m pytest tests/test_store.py` | 退出码 0，`39 passed in 3.37s`；`+41 -0` |

整个测试套件是 `956 passed, 1 xfailed, 1 warning in 33.83s`，类型检查和格式检查的结果在正文开头。计时类的数每次都不一样，表里挑的是不带计时的那一行或我最后一次跑出的值。

这一章留下、而我没有动仓库去修的几处：

- `lab/ch19/ch19-rich-search.svg` 里含中文的文字被压成半宽，原因在 rich 的 `save_svg`；修好的版本放在了这个博客里，仓库里的那份还是旧的。
- `pyproject.toml` 的 `requires = ["hatchling"]` 没有版本约束，隔离构建会用当天最新的 hatchling；sdist 没有 `include` 列表，装下了整个仓库。
- `[tool.hatch.build.targets.wheel]` 那一表是多余的，hatchling 自己能推出来。
- typer 的帮助页和用法错误在管道里也是 rich 的框，`wants_rich` 管不到它们。
- `--mode` 是 `str` 加 `parser=`，没有补全。

## 练习

**1.** 把 `sift index` 的 `--mode` 直接标成 `Literal["process", "thread", "interp"]`，看补全能不能补出三个值，错误信息会变成什么样。然后跑 `tests/test_cli.py`，找出哪些测试因为报错文字变了而失败，决定是改测试还是保留 `mode_arg`。先写下预测。

**2.** 把 `requires` 改成 `["hatchling>=1.31,<2"]`，给 sdist 加一个 `include` 列表，让它只带 `src`、`tests`、许可证和 `README.md`，再分别用 `--no-isolation` 和隔离构建各造一次 wheel。比较两个 wheel 的 `RECORD` 哈希是否一致；再想想为什么我在正文里看到的两个哈希不同，而你的应该相同。

**3.** rich 的 `Text.append` 只去掉响铃、退格、垂直制表、换页和回车这五种控制字符（`rich/control.py` 第 9 到 15 行），我在一个小测试里看到 ESC 原样通过。写一篇正文里含 `\x1b[31m` 的假文章，让 `sift search` 在终端上分别走 rich 路径和纯文本路径，看哪条会把终端染红；然后决定该在 `snippet_text` 里剥掉它，还是在建索引时就剥。

## 下一篇

下一篇是《GUI（上）：tkinter 与事件循环》。命令行已经能用了，我想看 `sift` 放进一个窗口里，界面卡住的时候事件循环到底在干什么。
