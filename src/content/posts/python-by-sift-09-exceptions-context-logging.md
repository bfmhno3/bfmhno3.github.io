---
title: "异常、上下文管理器、日志与调试：把错误收成一个层次"
commentId: "post:python-by-sift-09-exceptions-context-logging"
published: "2026-10-22 23:00:00 +08:00"
description: "用 Sift 重学 Python 第 9 篇：我在 Python 3.14.7 里给 Sift 加上 SiftError 异常层次、带位置的查询语法错误、ExceptionGroup 收集的坏文件、会回滚的 IndexWriter 和 logging，顺手把异常链、except*、add_note、PEP 758 与 PEP 765、with 协议、warnings、pdb 和 PEP 768 的远程附加各跑一遍；括号写错的查询原来要先花 2145 ms 建索引才报错，现在 68 ms 就带着脱字符退出。"
category: Tutorial
tags:
  - Python
  - Sift
  - 异常处理
  - 上下文管理器
  - logging
  - pdb
series: "用 Sift 重学 Python"
seriesOrder: 9
draft: false
comment: true
slug: python-by-sift-09-exceptions-context-logging
---

上一篇的括号写漏了一个，Sift 要先花两秒把整个语料建成索引，然后才告诉我 `expected ')'`；这一篇之后，同一条命令在 68 ms 里就带着脱字符退出，退出码是 3，错误是一个有层次、有位置、能被捕获的对象，而不是一行 `sys.exit` 的字符串：

```text
$ python3 -m sift search '(rust'; echo "exit $?"
expected ')'
  (rust
       ^
exit 3
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch09`：新增 `src/sift/errors.py`（`SiftError` 和它的五个子类，`QuerySyntaxError` 从 `query/errors.py` 搬来，那个文件已删除）和 `src/sift/log.py`；`corpus.py`、`document.py`、`frontmatter.py`、`index.py`（新增 `IndexWriter`）、`analysis/pipeline.py`、`query/parser.py`、`query/lexer.py`、`query/__init__.py` 和 `__main__.py` 都有改动；`lab/ch09` 下有 16 个实验脚本、`extra.sh`、`pdb_session.sh` 和 `helpers/` 里的两个辅助文件，另外 `lab/ch06/frontmatter_corpus.py` 和 `lab/ch08/syntax_error_demo_fail.py` 因为异常类换了位置也改了一行。这些文件里 `errors.py` 的 `IndexMissingError` 和 `IndexCorruptError` 要到第 12 篇才有人抛，`log.py` 的 `rich` 参数要到第 19 篇才生效，`__main__.py` 的退出码约定第 11 篇还会重写；其余在后面只会被扩展。`make ch09` 通过，`make lint` 通过。
> 涉及的 Python 特性：`BaseException` 与 `Exception` 的层次、`try`/`except`/`else`/`finally` 的全部子句、异常表、`__cause__` 与 `__context__` 与 `from None`、自定义异常层次与 `args`、`ExceptionGroup` 与 `except*`、`add_note`、PEP 758 的无括号 `except`、PEP 765 的 `finally` 警告、EAFP、`with` 协议与 `contextlib`、`warnings`、`logging`、`traceback`、`breakpoint()` 与 `pdb`、PEP 768 的 `sys.remote_exec`。
> 前置：[第 8 篇](/posts/python-by-sift-08-bm25-query-language/)，需要读得懂 `parse()` 和 `QuerySyntaxError`。

这一篇修的毛病有一部分是上一篇自己记下来的账：索引先于解析、`build_pipeline` 在第 7 篇留下的 `ValueError` 和 `KeyError`、嵌套括号压垮递归。修完之后我另外发现 `main()` 里一个我自己写的错误处理根本没有生效，它一上来就把整个异常组重新抛了出去，这个也留在文章里。账上还有三笔没有平：平铺的 1000 个词仍然是 `RecursionError`；`keep_going` 跳过的文件留下一个没人用的 `doc_id`；`setup_logging` 接受 `rich` 参数但现在什么也不做。每一笔都放在它出现的地方。

## 环境

和前几篇同一台机器，仓库在标签 `ch09`，命令都在 `nix develop` 里、仓库根目录 `~/Projects/sift` 下跑：

```text
$ uname -r; python3 -VV; git describe --tags; git log --oneline -2
6.18.57
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
ch09
aa823a1 fix(ch09): label intentional errors, clearer lab output and docstrings
cf073fe fix(ch09): report grouped SiftErrors instead of re-raising
```

比较两个版本时，各候选轮流跑（A、B、A、B……，轮数写在每个脚本里），不剔除离群值，看最小值和中位数。`ch08` 和 `ch09` 要放进同一个会话里比，所以用 `git archive` 各导出一份，语料用符号链接共享。函数 `at` 把 `PYTHONPATH` 里仓库的 `src` 换成导出目录再切过去，`here` 只换 `src`、不切目录：

```bash
mkdir -p /tmp/p09/ch08 /tmp/p09/ch09 /tmp/p09/scratch /tmp/p09/cpython
for c in ch08 ch09; do
  git -C ~/Projects/sift archive $c | tar -x -C /tmp/p09/$c
  ln -s ~/Projects/sift/corpus /tmp/p09/$c/corpus
done
```

```bash
SITE=${PYTHONPATH#*:}
at() { (cd /tmp/p09/$1 && PYTHONPATH=/tmp/p09/$1/src:$SITE python3 "${@:2}"); }
here() { PYTHONPATH=/tmp/p09/$1/src:$SITE python3 "${@:2}"; }
S=/tmp/p09/scratch
```

CPython 的源码我直接 `curl` `v3.14.7` 标签下的原文放进 `/tmp/p09/cpython`，下文引用的行号都是这个标签下的行号：

```bash
cd /tmp/p09/cpython
for f in Lib/_collections_abc.py Lib/contextlib.py Lib/pdb.py \
         Python/ast_preprocess.c Python/bytecodes.c \
         Lib/traceback.py Python/bltinmodule.c Python/ceval.c \
         Python/ceval_gil.c \
         InternalDocs/exception_handling.md; do
  mkdir -p $(dirname $f)
  curl -sSfL https://raw.githubusercontent.com/python/cpython/v3.14.7/$f -o $f
done
```

`lab/ch09` 里的是仓库文件，节选处标了行号，命令在仓库根目录跑；放在 `/tmp/p09/scratch/` 的是只为这篇写的脚本，不进仓库，我贴全文，带 `main()` 和 `__main__` 守卫。省略的部分用 `# ...`（输出里用 `...`）标出。输出里的主目录路径换成了 `~`，行尾空格去掉了，宽度超过 100 列的行我在空格处折成两行，续行不缩进。命令末尾没有重定向的地方，`@timed` 打到 stderr 的 `load_index took ... ms` 也在输出里。

## 层次：BaseException 在上，Exception 在下

先数一数。这个脚本遍历 `BaseException` 的子类树，只数 `builtins` 里有名字的：

```python
"""Count the builtin exceptions under each child of BaseException."""

import builtins


def below(cls: type) -> set[type]:
    """Return the builtin exception classes that derive from cls."""
    found: set[type] = set()
    for sub in cls.__subclasses__():
        if getattr(builtins, sub.__name__, None) is sub:
            found |= {sub} | below(sub)
    return found


def main() -> None:
    """Print the direct children of BaseException."""
    print(f"BaseException: {len(below(BaseException)) + 1} classes in all")
    for sub in BaseException.__subclasses__():
        if getattr(builtins, sub.__name__, None) is sub:
            print(f"  {sub.__name__:20} {len(below(sub)):2} below it")
    mro = [c.__name__ for c in KeyboardInterrupt.__mro__]
    print("KeyboardInterrupt mro:", mro)
    mro = [c.__name__ for c in ExceptionGroup.__mro__]
    print("ExceptionGroup mro:", mro)


if __name__ == "__main__":
    main()
```

```text
$ python3 $S/exc_tree.py
BaseException: 69 classes in all
  BaseExceptionGroup    1 below it
  Exception            63 below it
  GeneratorExit         0 below it
  KeyboardInterrupt     0 below it
  SystemExit            0 below it
KeyboardInterrupt mro: ['KeyboardInterrupt', 'BaseException', 'object']
ExceptionGroup mro: ['ExceptionGroup', 'BaseExceptionGroup', 'Exception', 'BaseException', 'object']
```

`BaseException` 下面只有五个直接孩子，`Exception` 一个就占了 63 个，其余四个是 `BaseExceptionGroup`、`GeneratorExit`、`KeyboardInterrupt` 和 `SystemExit`。这个分法的意思是：`Exception` 是“程序出了错”，另外几个是“有人要这个程序停下来”。Ctrl-C、`sys.exit()`、生成器被 `close()`，都不该被一句 `except Exception` 吞掉。我给自己发一个 SIGINT 验证：

```python
"""Send SIGINT to ourselves: who sees the KeyboardInterrupt?"""

import os
import signal


def main() -> None:
    """Try to catch Ctrl-C with `except Exception`, then without."""
    try:
        try:
            os.kill(os.getpid(), signal.SIGINT)
            for _ in range(1_000_000):  # the signal lands in here
                pass
        except Exception:
            print("except Exception caught it")
    except BaseException as exc:
        print("only except BaseException caught it:", repr(exc))


if __name__ == "__main__":
    main()
```

```text
$ python3 $S/sigint_demo.py
only except BaseException caught it: KeyboardInterrupt()
```

`except Exception` 没接住，只有 `except BaseException` 接住了。这就是 PEP 8 说不要写裸的 `except:` 的原因：它等价于 `except BaseException:`，连 Ctrl-C 和 `sys.exit()` 都一并吞掉。Sift 里所有预期的失败都继承自 `Exception`（见下文的 `SiftError`），最外层的 `main()` 只捕获 `SiftError`，所以一个 `KeyboardInterrupt` 会原样冒出去。

`ExceptionGroup` 是个有趣的例外：它的 MRO 是 `ExceptionGroup`、`BaseExceptionGroup`、`Exception`、`BaseException`（上面脚本最后一行），所以 `except Exception` 能接住它；而 `BaseExceptionGroup` 才能装 `KeyboardInterrupt` 这类东西，下面异常组一节会看到。

## try 的全部子句

`try` 后面可以跟三种子句：`except`（可以有很多个）、`else` 和 `finally`，另外还有 3.11 的 `except*`，下面单独讲。`lab/ch09/try_except_else_finally.py` 把每一种走法的执行顺序打印出来。先看被测的函数：

```python
# lab/ch09/try_except_else_finally.py:4-22
def clauses(label: str, action: str) -> str:
    """Run one try statement and print each clause as it executes."""
    print(f"-- {label}")
    try:
        print("  try: start")
        if action == "value":
            raise ValueError("bad value")
        if action == "key":
            raise KeyError("missing")
        if action == "return":
            return "returned from try"
        print("  try: end")
    except ValueError as exc:
        print(f"  except ValueError: {exc}")
    else:
        print("  else: the try block raised nothing")
    finally:
        print("  finally: always runs")
    return "fell off the end"
```

```text
$ python3 lab/ch09/try_except_else_finally.py
-- no exception
  try: start
  try: end
  else: the try block raised nothing
  finally: always runs
fell off the end
-- exception caught by except
  try: start
  except ValueError: bad value
  finally: always runs
fell off the end
-- return inside try
  try: start
  finally: always runs
returned from try
-- exception no except matches
  try: start
  finally: always runs
  KeyError 'missing' left the function after finally
```

三个规则从输出里直接读得出来。`else` 只在 `try` 里什么也没抛的时候跑，而且它里面抛的异常不会被同一个 `try` 的 `except` 接住，这是它存在的理由：`try` 块里只放你要保护的那一句。`finally` 无论怎么离开 `try` 都会跑，包括 `return`：第三段里 `try` 已经决定返回 `"returned from try"`，`finally` 还是先打印了才真的返回。没被任何 `except` 匹配的 `KeyError` 也是先跑完 `finally` 才离开函数。

输出的后半段是循环里的 `break`、`continue` 和 `return` 值：

```python
# lab/ch09/try_except_else_finally.py:25-46
def loop_with_finally() -> None:
    """Show that break and continue also run the finally clause."""
    print("-- finally inside a loop")
    for i in range(3):
        try:
            if i == 1:
                continue
            if i == 2:
                break
            print(f"  body {i}")
        finally:
            print(f"  finally {i}")


def finally_runs_before_return() -> int:
    """Show that the return value is computed before finally runs."""
    value = 1
    try:
        return value
    finally:
        value = 2
        print(f"  finally set value to {value}, return still gives 1")
```

```text
-- finally inside a loop
  body 0
  finally 0
  finally 1
  finally 2
-- return value
  finally set value to 2, return still gives 1
  got 1
```

`continue` 和 `break` 同样会先过 `finally`。最后一段是个常见的误会：`return value` 在 `finally` 之前就把值算好了，`finally` 里再改 `value` 也改不了返回值，所以返回的是 1。

### try 不花钱，捕获才花钱

Python 3.11 以后进入 `try` 不需要任何指令。用 `dis` 看一个最小的例子：

```python
"""Disassemble a try/except: the handler is a table, not code."""

import dis


def lookup(d: dict[str, int], key: str) -> int:
    """Return d[key], or 0 when the key is missing."""
    try:
        return d[key]
    except KeyError:
        return 0


def main() -> None:
    """Show the bytecode and the exception table of lookup."""
    dis.dis(lookup, show_caches=False)


if __name__ == "__main__":
    main()
```

```text
$ python3 $S/dis_try.py
   6           RESUME                   0

   8           NOP

   9   L1:     LOAD_FAST_BORROW_LOAD_FAST_BORROW 1 (d, key)
               BINARY_OP               26 ([])
       L2:     RETURN_VALUE

  --   L3:     PUSH_EXC_INFO

  10           LOAD_GLOBAL              0 (KeyError)
               CHECK_EXC_MATCH
               POP_JUMP_IF_FALSE        5 (to L5)
               NOT_TAKEN
               POP_TOP

  11   L4:     POP_EXCEPT
               LOAD_SMALL_INT           0
               RETURN_VALUE

  10   L5:     RERAISE                  0

  --   L6:     COPY                     3
               POP_EXCEPT
               RERAISE                  1
ExceptionTable:
  L1 to L2 -> L3 [0]
  L3 to L4 -> L6 [1] lasti
  L5 to L6 -> L6 [1] lasti
```

`try:` 那一行只有一个 `NOP`，`d[key]` 的字节码前后没有任何“压入处理器”的指令。处理器是最下面的 `ExceptionTable`：`L1 to L2 -> L3`，意思是“偏移量在 L1 到 L2 之间的指令抛异常时，跳到 L3”。CPython 自己的文档是这么说的：

```text
InternalDocs/exception_handling.md:47-53 (v3.14.7)

`SETUP_FINALLY` and `POP_BLOCK` have no effect when no exceptions
are raised. The idea of zero-cost exception handling is to replace
these pseudo-instructions by metadata which is stored alongside the
bytecode, and which is inspected only when an exception occurs.
This metadata is the exception table, and it is stored in the code
object's `co_exceptiontable` field.
```

打个比方：旧办法是每次进门都有个保安站在门口举着牌子；现在是一张疏散图贴在墙上，没着火就没人看它。这张图的代价在着火的时候才付，后面 EAFP 一节会量这笔钱有多大。

## 异常链：`__context__`、`__cause__` 和 `from None`

在 `except` 里再抛一个异常，Python 会把正在处理的那个挂在新异常的 `__context__` 上；写成 `raise X from Y` 则把 `Y` 放进 `__cause__`，并且把 `__suppress_context__` 设为真；`from None` 把 `__cause__` 设为 `None`，同样让 `__suppress_context__` 为真，回溯里就不再打印旧异常。我用 `ConfigError` 把三种写法各抛一次，脚本只打印回溯里不带缩进的行（帧信息都去掉了，空行让它打印成 `(blank)`）：

```python
"""Print the traceback text of the three ways to raise inside except."""

import traceback

from sift.errors import ConfigError

SETTINGS: dict[str, str] = {}


def implicit(key: str) -> str:
    """Raise inside except without saying how the errors relate."""
    try:
        return SETTINGS[key]
    except KeyError:
        raise ConfigError(f"missing setting {key!r}")  # noqa: B904


def explicit(key: str) -> str:
    """Raise inside except with `from`: the KeyError is the cause."""
    try:
        return SETTINGS[key]
    except KeyError as exc:
        raise ConfigError(f"missing setting {key!r}") from exc


def hidden(key: str) -> str:
    """Raise inside except with `from None`: hide the KeyError."""
    try:
        return SETTINGS[key]
    except KeyError:
        raise ConfigError(f"missing setting {key!r}") from None


def main() -> None:
    """Print each traceback with the frame lines left out."""
    for fn in (implicit, explicit, hidden):
        print(f"-- {fn.__name__}")
        try:
            fn("tokenizer")
        except ConfigError as exc:
            text = "".join(traceback.format_exception(exc))
            for line in text.splitlines():
                if not line.startswith(("  ", "Traceback")):
                    print(line or "(blank)")


if __name__ == "__main__":
    main()
```

```text
$ python3 $S/chain_text.py
-- implicit
KeyError: 'tokenizer'
(blank)
During handling of the above exception, another exception occurred:
(blank)
sift.errors.ConfigError: missing setting 'tokenizer'
-- explicit
KeyError: 'tokenizer'
(blank)
The above exception was the direct cause of the following exception:
(blank)
sift.errors.ConfigError: missing setting 'tokenizer'
-- hidden
sift.errors.ConfigError: missing setting 'tokenizer'
```

两个措辞值得记住：隐式的是 “During handling of the above exception, another exception occurred”，意思是“处理 A 的时候又出了 B”，B 可能是你的 bug；显式的是 “The above exception was the direct cause of the following exception”，意思是“B 是 A 的翻译”。所以在 `except` 里转译异常时写 `from exc`；确定旧异常对读者没有价值时才写 `from None`。`lab/ch09/raise_from.py` 把这些属性直接打印出来：

```python
# lab/ch09/raise_from.py:36-54
    try:
        try:
            {}["title"]
        except KeyError as inner:
            raise ValueError("no title") from inner  # explicit: __cause__
    except ValueError as exc:
        show("raise ... from inner", exc)
        text = "".join(traceback.format_exception(exc))
        print("  mentions 'direct cause':", "direct cause" in text)

    try:
        try:
            {}["title"]
        except KeyError:
            raise ValueError("no title") from None  # hide the old one
    except ValueError as exc:
        show("raise ... from None", exc)
        text = "".join(traceback.format_exception(exc))
        print("  mentions KeyError at all:", "KeyError" in text)
```

```text
$ python3 lab/ch09/raise_from.py
-- implicit chaining
  __cause__    = None
  __context__  = KeyError('title')
  __suppress_context__ = False
  last line: ValueError: no title
  mentions 'During handling': True
-- raise ... from inner
  __cause__    = KeyError('title')
  __context__  = KeyError('title')
  __suppress_context__ = True
  last line: ValueError: no title
  mentions 'direct cause': True
-- raise ... from None
  __cause__    = None
  __context__  = KeyError('title')
  __suppress_context__ = True
  last line: ValueError: no title
  mentions KeyError at all: False
```

第二段里 `__cause__` 和 `__context__` 是同一个 `KeyError`；第三段的 `__cause__` 是 `None`，`__context__` 仍然保留着 `KeyError`，只是 `__suppress_context__` 让回溯不再打印它。所以 `from None` 隐藏的只是打印，对象还在，调试器里照样拿得到。Sift 自己的 front matter 解析器就这么用：`frontmatter.py` 里把内部的 `ValueError` 转成带行号的 `FrontMatterError`，`raise FrontMatterError(...) from None`，读者看到的是一行 `FrontMatterError`，而不是两层回溯。同一个脚本的最后一段：

```text
-- sift front matter parser
  __cause__    = None
  __context__  = ValueError('unterminated inline list: [oops')
  __suppress_context__ = True
  last line: sift.errors.FrontMatterError: line 1: unterminated inline list: [oops
```

最后一段是仓库里真实的解析器，不是为演示写的代码。

## 自定义层次：SiftError

Sift 抛出的每一个“有意为之”的错误都挂在同一个基类下面，这是 `src/sift/errors.py` 开头的文档字符串：

```python
# src/sift/errors.py:1-15
"""The exception hierarchy of Sift: every error it raises on purpose.

::

    Exception
    └── SiftError
        ├── QuerySyntaxError
        ├── FrontMatterError
        ├── ConfigError
        ├── IndexMissingError
        └── IndexCorruptError

``except SiftError`` catches every failure that Sift reports on
purpose and nothing else: a bug stays a plain TypeError or KeyError.
"""
```

只需要这一个基类，调用者就有了一个“Sift 的所有预期失败”的捕获点：`except SiftError` 接得住它们，接不住 `TypeError` 和 `KeyError`，后者是 bug，不该被吞。类的定义很短，难的是 `args`：

```python
# src/sift/errors.py:40-65
class QuerySyntaxError(SiftError):
    """A query that does not follow the grammar.

    str(error) is the message alone. query is the text that failed
    and position an offset into it.
    """

    def __init__(self, message: str, query: str, position: int) -> None:
        """Keep the message, the query and the offset."""
        super().__init__(message, query, position)
        self.message = message
        self.query = query
        self.position = position

    def __str__(self) -> str:
        """Return the message alone."""
        return self.message

    def render(self) -> str:
        """Return the message, the query line and a caret line.

        The caret sits under the character at position, also when
        the query has wide (CJK) characters before it.
        """
        pad = " " * _display_width(self.query[: self.position])
        return f"{self.message}\n  {self.query}\n  {pad}^"
```

`super().__init__(message, query, position)` 是故意传三个参数：`BaseException` 把 `args` 原样保存，`pickle` 和 `copy` 就用 `args` 重新调用 `cls(*args)`。如果只传 `message`，`cls(*args)` 就缺两个参数，下面的 `BadError` 正是这个后果。`custom_exceptions.py` 里有个对照，`BadError` 就是上面那个错误的做法，故意标了 `# BAD`：

```python
# lab/ch09/custom_exceptions.py:16-22,52-61
class BadError(Exception):
    """An exception whose __init__ forgets to pass every argument."""

    def __init__(self, message: str, detail: str) -> None:
        """Keep detail, but give only message to Exception."""
        super().__init__(message)  # BAD: args lacks detail
        self.detail = detail
    # ...
    original = QuerySyntaxError("expected ')'", "(rust", 5)
    copy = pickle.loads(pickle.dumps(original))
    print("pickle round trip:", copy.message, copy.query, copy.position)

    try:
        pickle.loads(pickle.dumps(BadError("boom", "details")))
    except TypeError as exc:
        # error: TypeError: BadError.__init__() missing 1 required
        # positional argument: 'detail'
        print("BadError pickle fails:", exc)
```

```text
$ python3 lab/ch09/custom_exceptions.py
QuerySyntaxError   mro: ['QuerySyntaxError', 'SiftError', 'Exception', 'BaseException', 'object']
...
SiftError is an Exception: True
SiftError is not a ValueError: True
caught QuerySyntaxError: expected ')'
  args = ("expected ')'", '(rust', 5)
caught FrontMatterError: post.md:3: duplicate key 'title'
  args = (PosixPath('post.md'), 3, "duplicate key 'title'")
caught ConfigError: unknown tokenizer 'x'
  args = ("unknown tokenizer 'x'",)
pickle round trip: expected ')' (rust 5
```

`QuerySyntaxError` 来回 `pickle` 之后三个字段都在；`BadError` 的 `args` 里只有 `message`，反序列化时 `BadError.__init__()` 就缺了 `detail`。异常要跨进程的话（`concurrent.futures` 的进程池会把子进程的异常 `pickle` 回父进程，第 16 篇会用到进程池），`args` 必须能重建对象。五个类的 MRO 我都打印了（上面只留了第一个），每个都是 `[类, 'SiftError', 'Exception', 'BaseException', 'object']`，而且 `SiftError` 不是 `ValueError`。这个选择有代价：以前 `except ValueError` 接得住的地方现在要改成接 `SiftError`，这一章的 diff 里 `corpus.py`、`document.py` 和 `frontmatter.py` 都动了，两个旧实验也跟着改了：`lab/ch06/frontmatter_corpus.py` 原来捕获 `ValueError`，`lab/ch08/syntax_error_demo_fail.py` 注释里的异常路径变了：

```text
$ git diff -U0 ch08 ch09 -- lab/ch06 lab/ch08
diff --git a/lab/ch06/frontmatter_corpus.py b/lab/ch06/frontmatter_corpus.py
index 74c125d..f5aba1f 100644
--- a/lab/ch06/frontmatter_corpus.py
+++ b/lab/ch06/frontmatter_corpus.py
@@ -4,6 +4,7 @@ from collections import Counter
 from pathlib import Path

 from sift.corpus import iter_documents
+from sift.errors import FrontMatterError
 from sift.frontmatter import parse_front_matter
 from sift.markdown import split_front_matter

@@ -59,8 +60,8 @@ def main() -> None:
     for text in BAD:
         try:
             parse_front_matter(text)
-        except ValueError as exc:
-            print(f"  {text!r:36} -> ValueError: {exc}")
+        except FrontMatterError as exc:
+            print(f"  {text!r:36} -> FrontMatterError: {exc}")
         else:
             print(f"  {text!r:36} -> parsed (unexpected)")

diff --git a/lab/ch08/syntax_error_demo_fail.py b/lab/ch08/syntax_error_demo_fail.py
index c5063cf..c0bd9d1 100644
--- a/lab/ch08/syntax_error_demo_fail.py
+++ b/lab/ch08/syntax_error_demo_fail.py
@@ -1,6 +1,6 @@
 """An unbalanced parenthesis: the parser's exception, uncaught."""

-# error: sift.query.errors.QuerySyntaxError: expected ')'
+# error: sift.errors.QuerySyntaxError: expected ')'

 from sift.query import parse

```

第 8 篇的 `QuerySyntaxError` 住在 `sift/query/errors.py`，这一章搬到了 `sift/errors.py`，旧文件删掉了，`sift.query` 也不再重新导出它：

```text
$ python3 -c 'import sift.query.errors'
Traceback (most recent call last):
  File "<string>", line 1, in <module>
    import sift.query.errors
ModuleNotFoundError: No module named 'sift.query.errors'
```

### 脱字符：CJK 要按显示宽度数

`QuerySyntaxError.render()` 在查询下面画一个 `^`。第 8 篇的版本是 `" " * position`，查询里有汉字时脱字符会偏到一半。现在 `_display_width` 按东亚宽度数列，宽字符算两列，组合符号算零列。`query_error_render.py` 对六条查询逐条解析，打印出来的是：

```text
$ python3 lab/ch09/query_error_render.py
query    '(rust'
position 5
expected ')'
  (rust
       ^

query    '"device tree'
position 0
unterminated phrase
  "device tree
  ^

query    'rust AND'
position 8
expected a term
  rust AND
          ^

query    '(奇异 值'
position 5
expected ')'
  (奇异 值
          ^

query    '-latex'
position 0
query needs at least one positive term
  -latex
  ^

```

六条里报错的是五条：`tag: rust`（冒号后面有空格）没有报错，词法分析器允许冒号后面有空白，我跑了一下：

```text
$ python3 -c 'from sift.query import parse; print(parse("tag: rust"))'
Field(name='tag', value=Term(text='rust'))
```

这是第 8 篇的词法规则，不是这一篇的问题。`(奇异 值` 的 `position` 是 5（字符偏移），脱字符前面却有 10 个空格：`  ` 两个缩进、`(`、四列的“奇异”、空格、两列的“值”。位置指向查询末尾，因为解析器是读到结尾才发现括号没有关。

## 三处补账

### 解析先于索引

第 8 篇的 `run_search` 先建索引再解析，一条拼错的查询要付完两秒的索引钱。`ch09` 里它多了一行，原来包在搜索外面的 `try/except QuerySyntaxError` 也去掉了，那部分挪到了 `main()`（下面异常组一节会引用）：

```python
# src/sift/__main__.py:51-58
    """Print the top 10 documents for the query made of words.

    The words are joined with spaces back into one query string, so
    ``search '"device tree"'`` and ``search device tree`` both work.
    """
    query = " ".join(words)
    parse(query)  # fail fast: a typo must not cost an index build
    start = time.perf_counter()
```

交替跑 7 轮 `python3 -m sift search '(rust'`，`ch08` 和 `ch09` 各一份导出目录，量的是整个进程的墙钟时间：

```text
$ python3 $S/alternate.py 7 python3 -m sift search '(rust'
ch08: 2200 2204 2212 2217 2219 2223 2226  (median 2217)
ch09: 68 69 69 70 71 71 72  (median 70)
```

脚本是这个，它只负责轮流起子进程并计时：

```python
"""Run one command in two exported trees, alternating, and time it."""

import os
import statistics
import subprocess
import sys
import time

LABELS = ("ch08", "ch09")


def wall_ms(label: str, argv: list[str]) -> float:
    """Return the milliseconds one run of argv takes in tree label."""
    site = os.environ["PYTHONPATH"].split(":", 1)[1]
    env = dict(os.environ, PYTHONPATH=f"/tmp/p09/{label}/src:{site}")
    start = time.perf_counter()
    subprocess.run(
        argv,
        cwd=f"/tmp/p09/{label}",
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return (time.perf_counter() - start) * 1000


def main() -> None:
    """Alternate A, B, A, B, ... for the given rounds."""
    rounds = int(sys.argv[1])
    argv = sys.argv[2:]
    runs: dict[str, list[float]] = {label: [] for label in LABELS}
    for _ in range(rounds):
        for label in LABELS:
            runs[label].append(wall_ms(label, argv))
    for label, times in runs.items():
        shown = " ".join(f"{t:.0f}" for t in sorted(times))
        print(f"{label}: {shown}  (median {statistics.median(times):.0f})")


if __name__ == "__main__":
    main()
```

中位数 2145 ms 对 68 ms，31.5 倍。代价是一次多余的解析：`Searcher.search` 里还会再解析一遍同一个字符串（读代码得知，我没有单独量它；第 8 篇量过解析、求值和评分加起来只有 3.4 ms）。

### ConfigError 代替 ValueError 和 KeyError

第 7 篇记下了 `build_pipeline([])` 抛 `ValueError: not enough values to unpack`，名字拼错抛 `KeyError: 'nope'`，都不是“用户配置错了”该有的样子。`ch09` 改成统一的 `ConfigError`，而且把已知的名字列出来。同一个脚本在两个版本里各跑一次：

```python
"""What build_pipeline raises for bad names, before and after."""

from sift.analysis import build_pipeline


def main() -> None:
    """Call build_pipeline with three bad name lists."""
    for names in ([], ["nope"], ["mixed", "nope"]):
        try:
            build_pipeline(names)
        except Exception as exc:
            print(f"{names!r:20} {type(exc).__qualname__}: {exc}")


if __name__ == "__main__":
    main()
```

```text
$ at ch08 $S/config_probe.py
[]                   ValueError: not enough values to unpack (expected at least 1, got 0)
['nope']             KeyError: 'nope'
['mixed', 'nope']    KeyError: 'nope'
$ at ch09 $S/config_probe.py
[]                   ConfigError: a pipeline needs a tokenizer, got no names
['nope']             ConfigError: unknown tokenizer 'nope'; known: cjk-bigram, latin, mixed
['mixed', 'nope']    ConfigError: unknown filter 'nope'; known: nfkc, stopwords
```

代码里先判空、再判第一个名字、再判后面的名字，每一种各有各的消息：

```python
# src/sift/analysis/pipeline.py:38-54
def build_pipeline(names: Sequence[str] = DEFAULT_NAMES) -> Pipeline:
    """Build a Pipeline from names: a tokenizer, then filters.

    Raise ConfigError for an empty list, an unknown name, a filter
    name in the first place or a tokenizer name after it.
    """
    if not names:
        raise ConfigError("a pipeline needs a tokenizer, got no names")
    first, *rest = names
    if first not in REGISTRY:
        known = ", ".join(sorted(REGISTRY))
        raise ConfigError(f"unknown tokenizer {first!r}; known: {known}")
    for name in rest:
        if name not in FILTERS:
            known = ", ".join(sorted(FILTERS))
            raise ConfigError(f"unknown filter {name!r}; known: {known}")
    return Pipeline(REGISTRY[first](), *(FILTERS[name]() for name in rest))
```

### 嵌套括号：MAX_DEPTH = 100，平铺的链不管

第 8 篇量到 250 层括号会让递归下降的解析器抛 `RecursionError`。`ch09` 给解析器加了一个深度计数器，嵌套超过 `MAX_DEPTH = 100` 层就抛 `QuerySyntaxError`。计数器在 `parser.py` 里，常量定义在文件开头，增减在 `LPAREN` 分支里：

```python
# src/sift/query/parser.py:20-26,100-108
MAX_DEPTH = 100
"""Deepest nesting of parentheses that parse accepts.

Each level costs four Python frames, so 100 levels stay far below the
default recursion limit of 1000. Only parentheses are counted: a flat
chain of a thousand terms still hits the limit (a known gap).
"""
        # ...
        token = self.take()
        match token.kind:
            case Kind.LPAREN:
                self.depth += 1
                if self.depth > MAX_DEPTH:
                    raise self.fail("query nested too deeply", token)
                node = self.parse_or()
                self.depth -= 1
                if self.peek.kind is not Kind.RPAREN:
```

```python
"""How deep can a query nest, and how long can a flat chain be?"""

from sift.query import parse


def attempt(label: str, query: str) -> None:
    """Parse query and print what happened, in one line."""
    try:
        parse(query)
    except RecursionError:
        print(f"{label:24} RecursionError")
    except Exception as exc:
        print(f"{label:24} {type(exc).__name__}: {exc}")
    else:
        print(f"{label:24} parsed")


def main() -> None:
    """Try nested parentheses and flat OR chains of growing size."""
    for depth in (50, 100, 101, 250):
        attempt(f"{depth} nested parens", "(" * depth + "a" + ")" * depth)
    for terms in (100, 300, 1000):
        attempt(f"{terms} terms in a chain", " OR ".join(["a"] * terms))


if __name__ == "__main__":
    main()
```

```text
$ at ch08 $S/depth_probe.py
50 nested parens         parsed
100 nested parens        parsed
101 nested parens        parsed
250 nested parens        RecursionError
100 terms in a chain     parsed
300 terms in a chain     parsed
1000 terms in a chain    RecursionError
$ at ch09 $S/depth_probe.py
50 nested parens         parsed
100 nested parens        parsed
101 nested parens        QuerySyntaxError: query nested too deeply
250 nested parens        QuerySyntaxError: query nested too deeply
100 terms in a chain     parsed
300 terms in a chain     parsed
1000 terms in a chain    RecursionError
```

注释里写了每层括号要四个 Python 栈帧，100 层大约 400 个，远在默认的 1000 以内。但它只数括号：`a OR a OR ...` 的平铺链在 1000 项时仍然是 `RecursionError`，我没修，也没有量出它从多少项开始崩，只知道 300 项没事。这是已知的缺口。

## 异常组：一次报告所有坏文件

语料里有 123 个文件，如果第 3 个的 front matter 坏了，该不该在这里就停？停下来的好处是简单，坏处是你修完第 3 个，再跑一次才发现第 7 个也坏了。`ch09` 的做法是读完所有文件，把每个 `FrontMatterError` 收进一个列表，读完后抛一个 `ExceptionGroup`。`iter_documents` 的主体：

```python
# src/sift/corpus.py:31-44
    errors: list[FrontMatterError] = []
    for doc_id, path in enumerate(sorted(root.rglob("*.md"))):
        text = path.read_text(encoding="utf-8")
        try:
            doc = Document.from_markdown(doc_id, path, text)
        except FrontMatterError as error:
            errors.append(error)
            if keep_going:
                logger.warning("skipping %s", error)
            continue
        yield doc
    if errors and not keep_going:
        noun = "file" if len(errors) == 1 else "files"
        raise ExceptionGroup(f"{len(errors)} {noun} failed", errors)
```

先把语言本身弄清楚。`exception_groups.py` 里的前半段：

```python
# lab/ch09/exception_groups.py:16-37
def main() -> None:
    """Handle a group with except*, then take it apart by hand."""
    try:
        fail_all()
    except* ValueError as group:
        print("except* ValueError got:", repr(group))
        print("  members:", [str(e) for e in group.exceptions])
    except* KeyError as group:
        print("except* KeyError got:", repr(group))

    try:
        try:
            fail_all()
        except* ValueError:
            print("handled the ValueErrors, KeyError goes on")
    except ExceptionGroup as rest:
        print("left over:", repr(rest))

    group = ExceptionGroup("mixed", [OSError("disk"), ValueError("v")])
    match, rest = group.split(OSError)
    print("split match:", repr(match), "rest:", repr(rest))
    print("subgroup:", repr(group.subgroup(ValueError)))
```

```text
$ python3 lab/ch09/exception_groups.py
except* ValueError got: ExceptionGroup('3 files failed', [ValueError('a.md: bad title'),
ValueError('b.md: bad date')])
  members: ['a.md: bad title', 'b.md: bad date']
except* KeyError got: ExceptionGroup('3 files failed', [KeyError('c.md')])
handled the ValueErrors, KeyError goes on
left over: ExceptionGroup('3 files failed', [KeyError('c.md')])
```

`except*` 不是“匹配一个类型”，而是“从组里把属于这个类型的拆出来”：`except* ValueError` 拿到的是只含两个 `ValueError` 的新组，`except* KeyError` 拿到的是只含 `KeyError` 的组，每个 `except*` 子句都可能运行，不像 `except` 那样只有第一个匹配的运行。没被任何子句拆走的部分，在 `try` 语句结束后作为一个新组重新抛出（第 4、5 行的 `left over`）。`group.split` 返回 ` `(匹配的, 剩下的)` `，`subgroup` 只返回匹配的，`derive` 用同样的消息和新成员造一个组。

再看边角：

```text
split match: ExceptionGroup('mixed', [OSError('disk')]) rest: ExceptionGroup('mixed',
[ValueError('v')])
subgroup: ExceptionGroup('mixed', [ValueError('v')])
derive: ExceptionGroup('mixed', [TypeError('t')])
nested except* OSError: ExceptionGroup('outer', [ExceptionGroup('mixed', [OSError('disk')])])
nested except* ValueError: ExceptionGroup('outer', [ValueError(1), ExceptionGroup('mixed',
[ValueError('v')])])
a plain error is wrapped: ExceptionGroup('', (ValueError('single'),))
BaseExceptionGroup member: BaseExceptionGroup('with exit', [KeyboardInterrupt()])
and the OSError
empty group: second argument (exceptions) must be a non-empty sequence
base in group: Cannot nest BaseExceptions in an ExceptionGroup
mixing except and except*: cannot have both 'except' and 'except*' on the same 'try'
```

嵌套组按层次拆，保持嵌套结构。裸的 `ValueError` 被 `except*` 接住时会被包进一个消息为空的组里 (`ExceptionGroup('', (ValueError('single'),))`)，所以 `except*` 子句里拿到的永远是组。`ExceptionGroup` 的成员不能是 `BaseException` 的非 `Exception` 子类，要装 `KeyboardInterrupt` 得用 `BaseExceptionGroup`；空组不行；`except` 和 `except*` 不能混在同一个 `try` 里，是编译期 `SyntaxError`。拆的逻辑在 `Python/ceval.c` 里：

```c
/* Python/ceval.c:2308-2341 (v3.14.7) */
    if (PyErr_GivenExceptionMatches(exc_value, match_type)) {
        /* Full match of exc itself */
        bool is_eg = _PyBaseExceptionGroup_Check(exc_value);
        if (is_eg) {
            *match = Py_NewRef(exc_value);
        }
        else {
            /* naked exception - wrap it */
            PyObject *excs = PyTuple_Pack(1, exc_value);
            if (excs == NULL) {
                return -1;
            }
            PyObject *wrapped = _PyExc_CreateExceptionGroup("", excs);
            Py_DECREF(excs);
            if (wrapped == NULL) {
                return -1;
            }
            PyFrameObject *f = _PyFrame_GetFrameObject(frame);
            if (f == NULL) {
                Py_DECREF(wrapped);
                return -1;
            }

            PyObject *tb = _PyTraceBack_FromFrame(NULL, f);
            if (tb == NULL) {
                return -1;
            }
            PyException_SetTraceback(wrapped, tb);
            Py_DECREF(tb);
            *match = wrapped;
        }
        *rest = Py_NewRef(Py_None);
        return 0;
    }
```

“裸异常被包起来”就是 `naked exception - wrap it` 那一段。

### 真实的坏文件

`index_bad_files_fail.py` 把 `tests/fixtures/mini` 复制到临时目录，弄坏两个文件，再调 `load_index`。它按约定以非零退出，回溯是 3.11 引入的异常组格式：

```python
# lab/ch09/index_bad_files_fail.py:21-29
def main() -> None:
    """Copy the fixture, break two files, then load the index."""
    source = MINI.resolve()
    with tempfile.TemporaryDirectory() as tmp, contextlib.chdir(tmp):
        root = Path("mini")
        shutil.copytree(source, root)
        break_front_matter(root / "tea-brewing.md", "title:", "title: [")
        break_front_matter(root / "river-flow.md", "published:", "published")
        load_index(root)
```

```text
$ python3 lab/ch09/index_bad_files_fail.py; echo "exit $?"
load_index took 9.1 ms
  + Exception Group Traceback (most recent call last):
  |   File "~/Projects/sift/lab/ch09/index_bad_files_fail.py", line 33, in <module>
  |     main()
  |     ~~~~^^
  |   File "~/Projects/sift/lab/ch09/index_bad_files_fail.py", line 29, in main
  |     load_index(root)
  |     ~~~~~~~~~~^^^^^^
  |   File "~/Projects/sift/src/sift/util.py", line 17, in wrapper
  |     return fn(*args, **kwargs)
  |   File "~/Projects/sift/src/sift/__main__.py", line 44, in load_index
  |     for doc in iter_documents(root, keep_going=keep_going):
  |                ~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  |   File "~/Projects/sift/src/sift/corpus.py", line 44, in iter_documents
  |     raise ExceptionGroup(f"{len(errors)} {noun} failed", errors)
  | ExceptionGroup: 2 files failed (2 sub-exceptions)
  +-+---------------- 1 ----------------
    | Traceback (most recent call last):
    |   File "~/Projects/sift/src/sift/corpus.py", line 35, in iter_documents
    |     doc = Document.from_markdown(doc_id, path, text)
    |   File "~/Projects/sift/src/sift/document.py", line 82, in from_markdown
    |     meta = parse_front_matter(front, path, first_line=2)
    |   File "~/Projects/sift/src/sift/frontmatter.py", line 150, in parse_front_matter
    |     raise FrontMatterError(
    |         path, first_line + i - 1, str(exc)
    |     ) from None
    | sift.errors.FrontMatterError: mini/river-flow.md:3: cannot parse line: 'published
"2026-01-04 08:00:00 +08:00"'
    +---------------- 2 ----------------
    | Traceback (most recent call last):
    |   File "~/Projects/sift/src/sift/corpus.py", line 35, in iter_documents
    |     doc = Document.from_markdown(doc_id, path, text)
    |   File "~/Projects/sift/src/sift/document.py", line 82, in from_markdown
    |     meta = parse_front_matter(front, path, first_line=2)
    |   File "~/Projects/sift/src/sift/frontmatter.py", line 150, in parse_front_matter
    |     raise FrontMatterError(
    |         path, first_line + i - 1, str(exc)
    |     ) from None
    | sift.errors.FrontMatterError: mini/tea-brewing.md:2: unterminated inline list: [
泡茶的温度与时间
    +------------------------------------
exit 1
```

（回溯的全文在 `out/ch09/index_bad_files_fail.stderr`，上面是我这次重跑的结果。）顶层回溯到 `ExceptionGroup: 2 files failed (2 sub-exceptions)` 为止，然后每个子异常带着自己的回溯缩进显示，两个文件各一份，一次看全。

### 我自己的 bug：把组整个抛回去了

库里能抛 `ExceptionGroup` 了，命令行就得接住它。我写 `main()` 的第一版（提交 `7b45c86`）是这样的：

```python
# src/sift/__main__.py:133-136 (commit 7b45c86)
    except ExceptionGroup as group:
        if group.subgroup(lambda e: not isinstance(e, SiftError)):
            raise
        print(f"error: {group.message}", file=sys.stderr)
```

意思是“组里有不是 `SiftError` 的就重新抛，否则印出来”。我拿一个有两个坏文件的语料跑 `python3 -m sift search tea`，预期是一行 `error: 2 files failed` 加两行文件名。准备这个语料：

```bash
mkdir -p /tmp/p09/broken/corpus
cp -r tests/fixtures/mini /tmp/p09/broken/corpus/posts
sed -i '0,/^title:/s//title: [/' /tmp/p09/broken/corpus/posts/tea-brewing.md
sed -i '0,/^published:/s//published/' \
    /tmp/p09/broken/corpus/posts/river-flow.md
```

那个有毛病的提交我也导出了一份（`git archive 7b45c86`，目录 `/tmp/p09/ch09pre`），在坏语料里跑：

```text
$ cd /tmp/p09/broken && here ch09pre -m sift search tea; echo "exit $?"
load_index took 8.4 ms
  + Exception Group Traceback (most recent call last):
  |   File "<frozen runpy>", line 203, in _run_module_as_main
  |   File "<frozen runpy>", line 88, in _run_code
  |   File "/tmp/p09/ch09pre/src/sift/__main__.py", line 143, in <module>
...
  | ExceptionGroup: 2 files failed (2 sub-exceptions)
  +-+---------------- 1 ----------------
...
    |     raise FrontMatterError(
    |         path, first_line + i - 1, str(exc)
    |     ) from None
    | sift.errors.FrontMatterError: corpus/posts/river-flow.md:3: cannot parse line: 'published
"2026-01-04 08:00:00 +08:00"'
    +---------------- 2 ----------------
    | Traceback (most recent call last):
    |   File "/tmp/p09/ch09pre/src/sift/corpus.py", line 35, in iter_documents
    |     doc = Document.from_markdown(doc_id, path, text)
    |   File "/tmp/p09/ch09pre/src/sift/document.py", line 82, in from_markdown
```

（中间的帧用 `...` 省略了。）整个异常组被原样抛了出来，退出码也是 1，所以看上去“失败了”，错的是格式。原因在 `subgroup` 的语义：它先把条件函数应用在组对象本身上，一个 `ExceptionGroup` 当然不是 `SiftError`，`not isinstance(...)` 为真，于是返回整个组，整个组为真，永远 `raise`。我写 `if` 条件时想的是“组里的成员”，函数却先看了容器。（单元测试要到第 10 篇才有，所以抓住它的是一次手工跑，不是测试。）修法是用 `split(SiftError)` 取“剩下的”部分，`ch09` 标签现在是这样：

```python
# src/sift/__main__.py:117-141
def main() -> None:
    """Run the command line and turn Sift errors into exit codes.

    A QuerySyntaxError prints the query and a caret line and exits 3.
    Any other SiftError, alone or inside an ExceptionGroup, prints
    ``error: ...`` and exits 1. The full contract arrives in ch11.
    """
    setup_logging()
    try:
        dispatch(sys.argv[1:])
    except QuerySyntaxError as error:
        print(error.render(), file=sys.stderr)
        sys.exit(3)
    except SiftError as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
    except ExceptionGroup as group:
        _, other = group.split(SiftError)
        if other is not None:
            raise
        print(f"error: {group.message}", file=sys.stderr)
        for error in group.exceptions:
            print(f"  {error}", file=sys.stderr)
        sys.exit(1)

```

```text
$ cd /tmp/p09/broken && here ch09 -m sift search tea; echo "exit $?"
load_index took 8.5 ms
error: 2 files failed
  corpus/posts/river-flow.md:3: cannot parse line: 'published "2026-01-04 08:00:00 +08:00"'
  corpus/posts/tea-brewing.md:2: unterminated inline list: [ 泡茶的温度与时间
exit 1
```

每个文件一行，路径和行号都有，退出码 1（`QuerySyntaxError` 是 3，下面“跑一遍”里会再看到）。

### keep_going：跳过，但记账

有时候你不想停：有 3 个坏文件，先搜另外 120 个。`iter_documents(root, keep_going=True)` 把错误记成 `sift.corpus` 这个 logger 的 warning 然后继续。`load_index` 有同名的参数，不过命令行没有对应的开关，`run_search` 调 `load_index` 时没有传 `keep_going`，现在只能从 Python 里用。我弄坏 `mini` 里排第二的文件，看看索引里还有哪些 `doc_id`：

```python
"""Index a broken copy of the mini fixture with keep_going=True."""

import contextlib
import shutil
import tempfile
from pathlib import Path

from sift.__main__ import load_index
from sift.log import setup_logging

MINI = Path("tests/fixtures/mini")


def main() -> None:
    """Break one file, index with keep_going, look at the doc_ids."""
    setup_logging("WARNING")
    source = MINI.resolve()
    with tempfile.TemporaryDirectory() as tmp, contextlib.chdir(tmp):
        root = Path("mini")
        shutil.copytree(source, root)
        victim = sorted(root.glob("*.md"))[1]
        text = victim.read_text(encoding="utf-8")
        victim.write_text(text.replace("title:", "title: [", 1))
        documents, index = load_index(root, keep_going=True)
    ids = sorted(index.documents)
    print("doc_ids in the index:", ids)
    print("len(documents):      ", len(documents))
    print("index.n_docs:        ", index.n_docs)
    print("largest doc_id + 1:  ", ids[-1] + 1)
    print("documents[1].doc_id: ", documents[1].doc_id)


if __name__ == "__main__":
    main()
```

```text
$ python3 $S/keep_going_probe.py
WARNING sift.corpus: skipping mini/bicycle-repair.md:2: unterminated inline list: [ Fixing a
bicycle chain
load_index took 9.0 ms
doc_ids in the index: [0, 2, 3, 4, 5, 6, 7]
len(documents):       7
index.n_docs:         7
largest doc_id + 1:   8
documents[1].doc_id:  2
```

第一行是 warning，`setup_logging("WARNING")` 把 `sift.*` 的记录送到 stderr。然后是代价：`doc_id` 是文件在排序后路径列表里的位置，所以坏掉的文件让出了编号 1，索引里的 `doc_id` 是 `[0, 2, 3, ...]`，没有 1；7 篇文档的最大编号是 7，`largest doc_id + 1` 是 8，比 `n_docs` 多 1；`documents` 列表里下标 1 的文档，它的 `doc_id` 是 2。凡是把 `doc_id` 当 `documents` 列表下标的代码都会错位，所以要用 `index.documents[doc_id]`。我只读了 `load_index` 这一处，没有去查所有调用点。

### 严格解析会让多少篇真文章失败？

我最担心的是新的严格解析会让真实语料里的文章炸掉。`corpus_strict_parse.py` 把 `corpus/posts` 里的文件逐个解析，收集 `ExceptionGroup`：

```text
$ python3 lab/ch09/corpus_strict_parse.py
files:  123
failed: 0
parsed: 123
```

0 篇失败，123 篇都能读。

## add_note：把上下文贴在异常上

`add_note`(3.11) 给异常加一行文字，回溯会把它打印在异常消息的下面。比 `raise ... from` 轻：不用造新异常，也不丢类型。`add_note.py` 在读文件的循环里捕获 `SiftError`，补上是第几个文件，再原样 `raise`：

```python
# lab/ch09/add_note.py:12-22
def read_all(root: Path) -> None:
    """Parse every file, annotating the failure with its path."""
    for doc_id, path in enumerate(sorted(root.glob("*.md"))):
        text = path.read_text(encoding="utf-8")
        text = text.replace("title:", "title: [", 1) if doc_id == 3 else text
        try:
            Document.from_markdown(doc_id, path, text)
        except SiftError as exc:
            exc.add_note(f"while reading file {doc_id}: {path.name}")
            exc.add_note("try the file in an editor first")
            raise
```

```text
$ python3 lab/ch09/add_note.py
type: FrontMatterError
__notes__: ['while reading file 3: compiler-stages.md', 'try the file in an editor first']
--- format_exception_only:
sift.errors.FrontMatterError: tests/fixtures/mini/compiler-stages.md:2: unterminated inline
list: [ 编译器的几个阶段
while reading file 3: compiler-stages.md
try the file in an editor first
has __notes__ before: False
after two notes: ['first', 'second']
non-str note: add_note() argument must be str, not int
```

`__notes__` 是个普通列表，第一次 `add_note` 时才创建 (`has __notes__ before: False`)，只收 `str`。`iter_documents` 本身没用 `add_note`，因为每个 `FrontMatterError` 已经带着路径和行号；`add_note` 适合的是上面这种：捕获的地方比抛出的地方知道更多（这里是文件的编号），又不想换掉异常的类型。

## 3.14 的两处语法变化

### PEP 758：不带括号的 except

3.14 允许 `except ValueError, TypeError:`，不用括号。注意这不是 Python 2 里“把异常绑到名字”的旧语法：现在逗号就是“或”：

```python
# lab/ch09/bracketless_except.py:4-9,23-29
def parse(raw: str) -> int | None:
    """Return int(raw), or None for text and for non-strings."""
    try:
        return int(raw)
    except ValueError, TypeError:
        return None
    # ...
    source = "try:\n    pass\nexcept ValueError, TypeError as e:\n    pass\n"
    try:
        compile(source, "<no-parens-with-as>", "exec")
    except SyntaxError as exc:
        # error: SyntaxError: multiple exception types must be
        # parenthesized when using 'as'
        print("no parentheses with as:", exc.msg)
```

```text
$ python3 lab/ch09/bracketless_except.py
parse('42') = 42
parse('forty-two') = None
parse(None) = None
with as: ValueError
no parentheses with as: multiple exception types must be parenthesized when using 'as'
```

带 `as` 的时候括号仍然必须有，否则是编译期 `SyntaxError`。我猜这条限制是为了不让读者把 `as e` 看成只绑定最后一个类型。Sift 里我仍然写括号：加括号的写法在 3.13 及以前也能读，没有括号的写法只有 3.14 认。

### PEP 765：finally 里的 return

`finally` 里的 `return`（以及 `break`、`continue` 跳出 `finally`）会吞掉正在传播的异常。3.14 开始，编译器对这个发 `SyntaxWarning`：

```python
# lab/ch09/finally_return_warning.py:4-9
def swallow() -> str:
    """Raise, then lose the exception in the finally block."""
    try:
        raise RuntimeError("this error disappears")
    finally:
        return "finally won"  # BAD: hides the error  # noqa: B012
```

```text
$ python3 lab/ch09/finally_return_warning.py
~/Projects/sift/lab/ch09/finally_return_warning.py:9: SyntaxWarning: 'return' in a 'finally' block
  return "finally won"  # BAD: hides the error  # noqa: B012
finally won
```

警告是编译期发的，所以跑之前就出现了，而且这个文件仍然运行，输出 `finally won`，那个 `RuntimeError` 凭空消失了。警告在 `Python/ast_preprocess.c` 里：

```c
/* Python/ast_preprocess.c:65-91 (v3.14.7) */
static int
control_flow_in_finally_warning(const char *kw, stmt_ty n, _PyASTPreprocessState *state)
{
    PyObject *msg = PyUnicode_FromFormat("'%s' in a 'finally' block", kw);
    if (msg == NULL) {
        return 0;
    }
    int ret = _PyErr_EmitSyntaxWarning(msg, state->filename, n->lineno,
                                       n->col_offset + 1, n->end_lineno,
                                       n->end_col_offset + 1);
    Py_DECREF(msg);
    return ret < 0 ? 0 : 1;
}

static int
before_return(_PyASTPreprocessState *state, stmt_ty node_)
{
    if (state->enable_warnings && state->cf_finally_used > 0) {
        ControlFlowInFinallyContext *ctx = get_cf_finally_top(state);
        if (ctx->in_finally && ! ctx->in_funcdef) {
            if (!control_flow_in_finally_warning("return", node_, state)) {
                return 0;
            }
        }
    }
    return 1;
}
```

`-W error` 把它升级成错误，脚本直接编译失败（`extra.sh` 里也跑了这个）：

```text
$ python3 -W error lab/ch09/finally_return_warning.py; echo "exit $?"
  File "~/Projects/sift/lab/ch09/finally_return_warning.py", line 9
    return "finally won"  # BAD: hides the error  # noqa: B012
    ^^^^^^^^^^^^^^^^^^^^
SyntaxError: 'return' in a 'finally' block
exit 1
```

## EAFP 与 LBYL：try 到底贵不贵

“请求原谅比请求许可容易”(EAFP) 是 Python 的惯用法：直接做，出错再处理；对立面是“先看再跳”(LBYL)：先 `if key in d`。哪个快？前面的异常表说 `try` 本身不花钱，所以 EAFP 的代价全在捕获，也就是抛出 `KeyError`、构造回溯、跳到处理器。`lab/ch09/eafp_lbyl.py` 先量一遍：

```python
# lab/ch09/eafp_lbyl.py:16-19,34-38
def per_call_ns(stmt: str, setup: str, number: int = N) -> float:
    """Return the median ns per execution of stmt."""
    runs = timeit.repeat(stmt, setup, repeat=REPEAT, number=number)
    return statistics.median(runs) / number * 1e9
    # ...
    for name, template in variants.items():
        for case in ("hit", "miss"):
            ns = per_call_ns(template.format(k=case), setup)
            results[name, case] = ns
            print(f"  {name:26} {case:5} {ns:7.1f} ns")
```

```text
$ python3 lab/ch09/eafp_lbyl.py
plain dict, median of 7 runs of 1,000,000 calls
  EAFP try/except KeyError   hit      24.0 ns
  EAFP try/except KeyError   miss    137.8 ns
  LBYL if k in d             hit      40.3 ns
  LBYL if k in d             miss     18.6 ns
  dict.get                   hit      34.0 ns
  dict.get                   miss     28.5 ns
  try / in on a hit: 0.59x
  try / in on a miss: 7.42x
...
```

那个脚本是先把一种写法跑完再跑下一种，不是交替，所以我另写了一个把各候选轮流跑 9 轮的（每轮每个候选 20 万次，取最小值和中位数），并且多加了两个对象：一个是继承 `InvertedIndex` 但自己定义 `__contains__` 的，一个是数 `__getitem__` 被调用几次的。脚本全文：

```python
"""try vs `in` on a dict and on InvertedIndex, runs interleaved."""

import statistics
import timeit
from pathlib import Path

from sift.analysis import build_pipeline
from sift.corpus import iter_documents
from sift.index import InvertedIndex, PostingList

MINI = Path("tests/fixtures/mini")
ROUNDS = 9
NUMBER = 200_000


class CountingIndex(InvertedIndex):
    """An InvertedIndex that counts __getitem__ calls."""

    getitem_calls = 0

    def __getitem__(self, term: str) -> PostingList:
        """Count the call, then look the term up."""
        CountingIndex.getitem_calls += 1
        return super().__getitem__(term)


class DirectIndex(InvertedIndex):
    """An InvertedIndex whose `in` asks the dict, not __getitem__."""

    def __contains__(self, term: object) -> bool:
        """Return whether term is a body term, without raising."""
        return term in self._postings


def make(cls: type[InvertedIndex]) -> InvertedIndex:
    """Index the mini fixture into a new cls instance."""
    pipeline = build_pipeline()
    index = cls()
    for doc in iter_documents(MINI):
        index.add(doc, pipeline.analyze(doc.body))
    return index


def race(stmts: dict[str, str], namespace: dict[str, object]) -> None:
    """Time every statement ROUNDS times, one after the other."""
    runs: dict[str, list[float]] = {name: [] for name in stmts}
    for _ in range(ROUNDS):
        for name, stmt in stmts.items():
            t = timeit.timeit(stmt, globals=namespace, number=NUMBER)
            runs[name].append(t / NUMBER * 1e9)
    for name, times in runs.items():
        print(
            f"  {name:28} min {min(times):6.1f} ns"
            f"  median {statistics.median(times):6.1f} ns"
        )


def main() -> None:
    """Race the idioms on a dict, then on the index."""
    plain = {str(i): i for i in range(1000)}
    index = make(InvertedIndex)
    direct = make(DirectIndex)
    term = next(iter(index))
    for case, key in (("hit", "500"), ("miss", "x")):
        print(f"dict, {case}")
        race(
            {
                "try/except KeyError": (
                    "try:\n    d[k]\nexcept KeyError:\n    pass"
                ),
                "if k in d": "if k in d:\n    d[k]",
            },
            {"d": plain, "k": key},
        )
    for case, key in (("hit", term), ("miss", "no-such-term")):
        print(f"InvertedIndex, {case}")
        race(
            {
                "try/except KeyError": (
                    "try:\n    d[k]\nexcept KeyError:\n    pass"
                ),
                "if k in d": "if k in d:\n    d[k]",
                "if k in d (own __contains__)": "if k in e:\n    e[k]",
            },
            {"d": index, "e": direct, "k": key},
        )
    counting = make(CountingIndex)
    for key in (term, "no-such-term"):
        CountingIndex.getitem_calls = 0
        key in counting  # noqa: B015
        print(
            f"`{key!r} in index` called __getitem__ "
            f"{CountingIndex.getitem_calls} time(s)"
        )


if __name__ == "__main__":
    main()
```

```text
$ python3 $S/eafp_alternating.py
dict, hit
  try/except KeyError          min   26.4 ns  median   28.7 ns
  if k in d                    min   43.7 ns  median   46.5 ns
dict, miss
  try/except KeyError          min  131.0 ns  median  134.3 ns
  if k in d                    min   20.4 ns  median   21.4 ns
InvertedIndex, hit
  try/except KeyError          min   40.2 ns  median   41.3 ns
  if k in d                    min  125.7 ns  median  126.7 ns
  if k in d (own __contains__) min  106.8 ns  median  107.8 ns
InvertedIndex, miss
  try/except KeyError          min  228.6 ns  median  230.7 ns
  if k in d                    min  305.7 ns  median  308.7 ns
  if k in d (own __contains__) min   61.3 ns  median   62.3 ns
`'自行' in index` called __getitem__ 1 time(s)
`'no-such-term' in index` called __getitem__ 1 time(s)
```

字典上，命中时 `try` 是 28.1 ns，`if k in d` 要查两次所以是 48.1 ns；未命中时 `try` 是 135.5 ns，`in` 只要 21.5 ns，`try` 慢 6.3 倍。设未命中的比例是 $p$，两者的平均成本相等的点是：

$$
28.1 (1 - p) + 135.5 p = 48.1 (1 - p) + 21.5 p
$$

```text
$ python3 -c 'print((48.1 - 28.1) / ((135.5 - 28.1) + (48.1 - 21.5)))'
0.14925373134328357
```

也就是约 15%：未命中的比例低于大约六分之一，`try` 更划算；高于这个数，先 `in` 更划算。搜索词在不在语料里，取决于用户输入，我没有量过真实查询里未命中的比例。

### InvertedIndex 上的意外

同样的两种写法放到第 7 篇的 `InvertedIndex` 上，结论翻过来了：命中时 `in` 加 `[]` 要 125.8 ns，是 `try` 的 3.08 倍；未命中时是 306.2 对 228.8 ns，`in` 反而慢 1.34 倍。LBYL 理应在未命中时很便宜。原因在最后两行输出：`'no-such-term' in index` 调用了一次 `__getitem__`。`InvertedIndex` 只写了 `__getitem__`、`__iter__` 和 `__len__`，`__contains__` 是从 `Mapping` 继承来的：

```python
# Lib/_collections_abc.py:799-805 (v3.14.7)
    def __contains__(self, key):
        try:
            self[key]
        except KeyError:
            return False
        else:
            return True
```

也就是说，`in` 就是一个藏在基类里的 `try/except KeyError`。未命中时它的成本是一次 Python 层的 `__getitem__` 加一次异常加一次捕获。第 7 篇量过这件事（未命中从 66 ns 变成 328 ns），当时留给了练习；这里是第二次碰到它。我在脚本里写了个子类，只重写 `__contains__` 为 `term in self._postings`，`in` 的未命中降到 61.9 ns，是继承版本的 4.95 倍快，也比 `try` 的 228.8 ns 快 3.7 倍；命中时 107.7 ns，仍然比 `try` 的 40.9 ns 慢，因为 `in` 之后还有一次 `[]`。我没有改仓库里的 `InvertedIndex`，留在练习里。

## with：协议、contextlib 和 IndexWriter

`with manager:` 对应的字节码比看上去的要长。3.14 里 `__enter__` 和 `__exit__` 是通过专门的 `LOAD_SPECIAL` 指令取的：

```python
"""Disassemble a with statement: where __enter__ and __exit__ go."""

import dis


def locked(manager: object) -> None:
    """Enter manager, run one call, leave it."""
    with manager:
        print("body")


def main() -> None:
    """Show the bytecode and the exception table of locked."""
    dis.dis(locked, show_caches=False)


if __name__ == "__main__":
    main()
```

```text
$ python3 $S/dis_with.py
   6           RESUME                   0

   8           LOAD_FAST_BORROW         0 (manager)
               COPY                     1
               LOAD_SPECIAL             1 (__exit__)
               SWAP                     2
               SWAP                     3
               LOAD_SPECIAL             0 (__enter__)
               CALL                     0
       L1:     POP_TOP

   9           LOAD_GLOBAL              1 (print + NULL)
               LOAD_CONST               1 ('body')
               CALL                     1
               POP_TOP

   8   L2:     LOAD_CONST               2 (None)
               LOAD_CONST               2 (None)
               LOAD_CONST               2 (None)
               CALL                     3
               POP_TOP
               LOAD_CONST               2 (None)
               RETURN_VALUE
       L3:     PUSH_EXC_INFO
               WITH_EXCEPT_START
               TO_BOOL
               POP_JUMP_IF_TRUE         2 (to L4)
               NOT_TAKEN
               RERAISE                  2
       L4:     POP_TOP
       L5:     POP_EXCEPT
               POP_TOP
               POP_TOP
               POP_TOP
               LOAD_CONST               2 (None)
               RETURN_VALUE

  --   L6:     COPY                     3
               POP_EXCEPT
               RERAISE                  1
ExceptionTable:
  L1 to L2 -> L3 [2] lasti
  L3 to L5 -> L6 [4] lasti
```

前面几行：把 `manager` 复制一份，先取 `__exit__` 压在栈底，再取 `__enter__` 调用，`POP_TOP` 丢掉返回值（没有 `as`）。正常离开时，`__exit__` 以三个 `None` 调用（`LOAD_CONST None` 三次、`CALL 3`）。异常离开时走 `L3`：`PUSH_EXC_INFO`，然后 `WITH_EXCEPT_START` 用 ` `(类型, 异常, 回溯)` ` 调用 `__exit__`，返回值经 `TO_BOOL`，真就吞掉，假就 `RERAISE`：

```c
/* Python/bytecodes.c:3524-3531 (v3.14.7) */
            /* At the top of the stack are 4 values:
               - val: TOP = exc_info()
               - unused: SECOND = previous exception
               - lasti: THIRD = lasti of exception in exc_info()
               - exit_self: FOURTH = the context or NULL
               - exit_func: FIFTH = the context.__exit__ function or context.__exit__ bound method
               We call FOURTH(type(TOP), TOP, GetTraceback(TOP)).
               Then we push the __exit__ return value.
```

`lab/ch09/context_managers.py` 用一个会打印每一步的类把这几件事演出来：

```python
# lab/ch09/context_managers.py:13-34
class Trace:
    """A class-based context manager that prints each step."""

    def __init__(self, name: str, *, swallow: bool = False) -> None:
        """Name the block; swallow decides what __exit__ returns."""
        self.name = name
        self.swallow = swallow

    def __enter__(self) -> str:
        """Print and return the value bound by ``as``."""
        print(f"  {self.name}: __enter__")
        return f"<{self.name}>"

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> bool:
        """Print what arrived; a true return value suppresses it."""
        print(f"  {self.name}: __exit__ got {exc_type}, {exc!r}")
        return self.swallow
```

```text
$ python3 lab/ch09/context_managers.py
-- normal exit
  a: __enter__
  body, as = <a>
  a: __exit__ got None, None
-- exception, __exit__ returns False
  b: __enter__
  b: __exit__ got <class 'ValueError'>, ValueError('boom')
  caught outside: boom
-- exception, __exit__ returns True
  c: __enter__
  c: __exit__ got <class 'ValueError'>, ValueError('swallowed')
  execution continues after the with
```

`__exit__` 返回真值，异常就消失，`with` 后面的语句继续跑 (`execution continues after the with`)。这个“吞掉”很危险，我下面写的 `IndexWriter.__exit__` 就明确不吞。

### contextlib

写一个类只为了配对 `__enter__` 和 `__exit__` 太重，`contextlib.contextmanager` 用生成器代替：`yield` 之前是 `__enter__`，之后是 `__exit__`，异常会在 `yield` 处被抛进生成器：

```python
# lab/ch09/context_managers.py:37-44
@contextlib.contextmanager
def announce(name: str) -> Iterator[str]:
    """Generator-based context manager with try/finally."""
    print(f"  {name}: before yield")
    try:
        yield name.upper()
    finally:
        print(f"  {name}: after yield (finally)")
```

```text
-- contextlib.contextmanager
  gen: before yield
  body, as = GEN
  gen: after yield (finally)
  gen2: before yield
  gen2: after yield (finally)
  the exception passed through the generator
```

关键是 `try/finally`：没有它，`with` 块里抛异常时 `yield` 之后的清理就不会跑（`gen2` 那一段证明它跑了）。`_GeneratorContextManager.__exit__` 里 `self.gen.throw(value)` 做的就是这件事：

```python
# Lib/contextlib.py:145-150,156-162 (v3.14.7)
    def __exit__(self, typ, value, traceback):
        if typ is None:
            try:
                next(self.gen)
            except StopIteration:
                return False
        # ...
        else:
            if value is None:
                # Need to force instantiation so we can reliably
                # tell if we get the same exception back
                value = typ()
            try:
                self.gen.throw(value)
```

然后是 `ExitStack`、`suppress`、`closing`、`redirect_stdout`、`chdir` 和 `nullcontext`。先看代码（`Resource` 是个只有 `close()` 的类）：

```python
# lab/ch09/context_managers.py:47-52,82-128
class Resource:
    """Something with a close() method, for contextlib.closing."""

    def close(self) -> None:
        """Print that the resource is closed."""
        print("  Resource.close() called")
    # ...
    print("-- two managers in one with (exit in reverse order)")
    with Trace("outer"), Trace("inner"):
        print("  body")

    print("-- ExitStack")
    with contextlib.ExitStack() as stack:
        for name in ("one", "two", "three"):
            stack.enter_context(Trace(name))
        stack.callback(print, "  callback runs first on the way out")
        print("  body")

    print("-- suppress")
    with contextlib.suppress(FileNotFoundError):
        Path("/no/such/file").read_text()
    print("  FileNotFoundError ignored")

    print("-- closing")
    with contextlib.closing(Resource()):
        print("  body")

    print("-- redirect_stdout")
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        print("this goes to the buffer")
    print("  captured:", repr(buffer.getvalue()))

    print("-- redirect_stderr")
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        print("to stderr", file=sys.stderr)
    print("  captured:", repr(err.getvalue()))

    print("-- contextlib.chdir")
    before = Path.cwd()
    with tempfile.TemporaryDirectory() as tmp, contextlib.chdir(tmp):
        inside = Path.cwd() == Path(tmp).resolve()
        print("  cwd is the temp dir:", inside)
    print("  cwd restored:", Path.cwd() == before)

    print("-- files are context managers too")
    with open(os.devnull, "w", encoding="utf-8") as f:
        print("  closed inside:", f.closed)
    print("  closed after:", f.closed)

    print("-- nullcontext")
    with contextlib.nullcontext("placeholder") as value:
        print("  value:", value)
```

输出里值得看的有两处：`ExitStack` 按进入的逆序退出，`callback` 注册的函数在最后注册，所以最先跑；`suppress` 用的是 `issubclass` 语义，`Lib/contextlib.py` 第 451 到 458 行的注释写明了原因：

```text
-- two managers in one with (exit in reverse order)
  outer: __enter__
  inner: __enter__
  body
  inner: __exit__ got None, None
  outer: __exit__ got None, None
-- ExitStack
  one: __enter__
  two: __enter__
  three: __enter__
  body
  callback runs first on the way out
  three: __exit__ got None, None
  two: __exit__ got None, None
  one: __exit__ got None, None
-- suppress
  FileNotFoundError ignored
-- closing
  body
  Resource.close() called
-- redirect_stdout
  captured: 'this goes to the buffer\n'
-- redirect_stderr
  captured: 'to stderr\n'
-- contextlib.chdir
  cwd is the temp dir: True
  cwd restored: True
-- files are context managers too
  closed inside: False
  closed after: True
-- nullcontext
  value: placeholder
```

### IndexWriter：失败时回滚

`IndexWriter` 是这一章在仓库里加的上下文管理器：`with IndexWriter(index) as w: w.add(doc)`，块内抛异常就把块内加的文档全部删掉，异常继续往外抛。`__enter__`、`add` 和 `__exit__` 三个方法：

```python
# src/sift/index.py:285-314
    def __enter__(self) -> Self:
        """Start a block with nothing added yet."""
        self._added.clear()
        return self

    def add(self, doc: Document) -> None:
        """Analyze the body and the title of doc and index them.

        A doc_id that is already indexed raises ValueError and is
        left alone, also by the rollback.
        """
        if doc.doc_id in self.index.documents:
            raise ValueError(f"doc_id {doc.doc_id} is already indexed")
        self._added.append(doc.doc_id)
        self.index.add(
            doc,
            self.pipeline.analyze(doc.body),
            self.pipeline.analyze(doc.title),
        )

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        """Roll back on an exception; never swallow it."""
        if exc_type is not None:
            self.index.remove(self._added)
        self._added.clear()
```

`__exit__` 没有返回值（返回 `None`），所以异常不会被吞。`index.remove` 对全部词表扫一遍，不论删几篇都是一遍。`index_writer.py` 演示了成功的块、失败的块、之后的块和重复的 `doc_id`：

```text
$ python3 lab/ch09/index_writer.py
after a good block: 3 docs, 205 terms
inside the block: 6 docs
the exception still escapes: disk full
rolled back: True (3, 205, 16)
a later block works: 4 docs
duplicate id: doc_id 3 is already indexed
doc 3 kept by the failed block: True
```

失败块里先加了 3 篇 (`inside the block: 6 docs`)，异常逃出来之后，文档数、词数和标题词数都回到 `(3, 205, 16)`。最后两行是个细节：重复的 `doc_id` 抛 `ValueError`，而且这一篇文档（3 号）在块失败时没有被回滚，因为 `add` 在记账之前就检查并抛了，回滚只删本块新加的。

`load_index` 现在就是这么用它的：

```python
# src/sift/__main__.py:41-47
    documents: list[Document] = []
    index = InvertedIndex()
    with IndexWriter(index, pipeline) as writer:
        for doc in iter_documents(root, keep_going=keep_going):
            documents.append(doc)
            writer.add(doc)
    return documents, index
```

这里有个限制要说清楚：`ExceptionGroup` 是在 `iter_documents` 耗尽时、`for` 向生成器要下一个值的那一刻抛出的，那一刻仍在 `with` 块里，所以 `IndexWriter.__exit__` 会收到它并回滚，`load_index` 什么索引也不返回，也就是“要么全部成功，要么没有索引”。不过那个 `index` 是 `load_index` 的局部变量，异常一出来它就没有引用了，所以在这条路径上回滚不会被调用者看到，真正能看到回滚的是上面 `index_writer.py` 里那种长期存在的索引。

## warnings：不是异常的异常

`warnings.warn` 提醒调用者“这个能用，但别这么用”，默认不中断程序。`warnings_demo.py` 逐项看过滤器：

```python
# lab/ch09/warnings_demo.py:7-16,27-50
def old_search(query: str) -> str:
    """Call warnings.warn the way a library does."""
    warnings.warn("old_search is slow", DeprecationWarning, stacklevel=2)
    return query


@deprecated("use Searcher.search instead")
def legacy(query: str) -> str:
    """Return query; the decorator warns on every call (3.13+)."""
    return query
# ...
def main() -> None:
    """Show which warnings appear and why."""
    print("default filters (first three):")
    for entry in warnings.filters[:3]:
        print("  ", entry[0], entry[2].__name__, entry[3] or "")

    print("-- default filters: who sees a DeprecationWarning?")
    with warnings.catch_warnings(record=True) as caught:
        warnings.warn("from __main__", DeprecationWarning, stacklevel=1)
        warnings.warn_explicit(
            "from another module",
            DeprecationWarning,
            filename="library.py",
            lineno=1,
            module="library",
        )
    show(caught)

    print("-- the default action shows a location once")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("default")
        for _ in range(3):
            warnings.warn("careful", UserWarning, stacklevel=1)
    show(caught)
```

```text
$ python3 lab/ch09/warnings_demo.py
default filters (first three):
   default DeprecationWarning __main__
   ignore DeprecationWarning
   ignore PendingDeprecationWarning
-- default filters: who sees a DeprecationWarning?
  DeprecationWarning: from __main__
-- the default action shows a location once
  UserWarning: careful
```

默认过滤器的前三条：`__main__` 里的 `DeprecationWarning` 显示，其余模块的 `DeprecationWarning` 和 `PendingDeprecationWarning` 忽略。这个默认值是故意的：库的作者看得见（跑自己的 `__main__` 或测试），最终用户看不见。所以第二行里“来自 `__main__`”的显示出来了，而 `warn_explicit` 声称来自模块 `library` 的那一条被丢弃了。第二段的 `default` 动作对同一个位置（模块加行号）只显示第一次，所以循环里警告了三次，`caught` 里只有一条 `careful`。其余的演示：

```python
# lab/ch09/warnings_demo.py:52-95
    print("-- simplefilter('always')")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        old_search("x")
        old_search("x")
    show(caught)

    print("-- simplefilter('ignore')")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("ignore")
        old_search("x")
    show(caught)

    print("-- simplefilter('error') turns a warning into an exception")
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        try:
            old_search("x")
        except DeprecationWarning as exc:
            print("  raised DeprecationWarning:", exc)

    print("-- filterwarnings by message and category")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        warnings.filterwarnings("ignore", message="old_.*")
        old_search("x")
        warnings.warn("other", DeprecationWarning, stacklevel=1)
    show(caught)

    print("-- @warnings.deprecated")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        legacy("x")
    show(caught)

    print("-- custom category")

    class SlowQueryWarning(UserWarning):
        """A warning that a caller can filter on its own."""

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        warnings.warn("took 2 s", SlowQueryWarning, stacklevel=1)
    show(caught)
```

```text
-- simplefilter('always')
  DeprecationWarning: old_search is slow
  DeprecationWarning: old_search is slow
-- simplefilter('ignore')
  (nothing recorded)
-- simplefilter('error') turns a warning into an exception
  raised DeprecationWarning: old_search is slow
-- filterwarnings by message and category
  DeprecationWarning: other
-- @warnings.deprecated
  DeprecationWarning: use Searcher.search instead
-- custom category
  SlowQueryWarning: took 2 s
```

`@warnings.deprecated`（3.13 起在标准库里）把“弃用”变成装饰器，消息就是 `legacy` 那一行的参数。过滤动作有 `default`、`always`、`ignore`、`error`：`error` 把警告变成异常，所以可以用 `-W error` 把弃用当成失败：

```text
$ python3 -W error -c 'import warnings; warnings.warn("x")'
Traceback (most recent call last):
  File "<string>", line 1, in <module>
    import warnings; warnings.warn("x")
                     ~~~~~~~~~~~~~^^^^^
UserWarning: x
```

## logging：一个 logger 树，一个处理器

`logging` 的核心只有四个东西：logger（有层次的名字）、level、handler（发到哪）和 formatter（长什么样）。名字里的点就是层次，`sift.corpus` 的父亲是 `sift`，`sift` 的父亲是根：

```python
# lab/ch09/logging_tour.py:24-47
    print("-- hierarchy: names with dots form a tree")
    root = logging.getLogger()
    sift = logging.getLogger("sift")
    corpus = logging.getLogger("sift.corpus")
    print("  corpus.parent is sift:", corpus.parent is sift)
    print("  sift.parent is root:  ", sift.parent is root)
    print(
        "  getLogger is a singleton:",
        corpus is logging.getLogger("sift.corpus"),
    )
    print("  effective level of sift.corpus:", corpus.getEffectiveLevel())

    print("-- handler + formatter on the parent, records from the child")
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(
        logging.Formatter("%(levelname)-7s %(name)s: %(message)s")
    )
    sift.addHandler(handler)
    sift.setLevel(logging.INFO)
    sift.propagate = False
    corpus.debug("dropped: below INFO")
    corpus.info("indexed %d files", 123)
    corpus.warning("skipping %s", "bad.md")
```

```text
$ python3 lab/ch09/logging_tour.py
-- hierarchy: names with dots form a tree
  corpus.parent is sift: True
  sift.parent is root:   True
  getLogger is a singleton: True
  effective level of sift.corpus: 30
-- handler + formatter on the parent, records from the child
  INFO    sift.corpus: indexed 123 files
  WARNING sift.corpus: skipping bad.md
  ERROR   sift.corpus: unreadable: x.md
  ERROR   sift.corpus: caught something
  ... then the traceback: Traceback (most recent call last): | ZeroDivisionError: division by zero
```

`sift.corpus` 自己没设级别，`getEffectiveLevel()` 沿着树往上找，找到根的 30(`WARNING`)。所以 `sift.*` 的所有模块只需要在自己的文件里写 `logger = logging.getLogger(__name__)`，不需要关心发到哪；发到哪由顶层的一个处理器决定，这就是 `src/sift/log.py`：

```python
# src/sift/log.py:13-30
def setup_logging(level: str = "WARNING", *, rich: bool = False) -> None:
    """Send ``sift.*`` log records to stderr at the given level.

    level is a level name such as ``"DEBUG"`` or ``"WARNING"``; an
    unknown name raises ValueError. Calling it again replaces the
    handler, it never adds a second one. rich is accepted and
    ignored: the rich handler arrives in chapter 19.
    """
    number = logging.getLevelName(level.upper())
    if not isinstance(number, int):
        raise ValueError(f"unknown log level: {level!r}")
    logger = logging.getLogger("sift")
    for handler in logger.handlers[:]:
        logger.removeHandler(handler)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(_FORMAT))
    logger.addHandler(handler)
    logger.setLevel(number)
```

`setup_logging` 调两次，`sift` logger 仍然只有一个处理器（先删后加），否则每条记录会打印两遍。`rich` 参数现在被接受而且被忽略：富文本处理器要到第 19 篇才有，我先把签名定下来，调用方不用以后再改。`main()` 的第一行就是 `setup_logging()`，所以默认级别 `WARNING` 的记录（`keep_going` 的跳过）会打印到 stderr。

`Expensive` 是个会数自己被转成字符串几次的类，下面的代码把级别、延迟格式化、过滤器、`extra` 和 `dictConfig` 各演一遍：

```python
# lab/ch09/logging_tour.py:11-19,59-70
class Expensive:
    """An object that counts how often it is turned into text."""

    calls = 0

    def __str__(self) -> str:
        """Count the call and return a fixed text."""
        Expensive.calls += 1
        return "expensive"
    # ...
    for name in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
        print(f"  {name:8} = {logging.getLevelName(name)}")
    print("  isEnabledFor(DEBUG):", corpus.isEnabledFor(logging.DEBUG))

    print("-- lazy % formatting: no str() when the level is off")
    Expensive.calls = 0
    corpus.debug("value: %s", Expensive())
    print("  after debug (off), __str__ calls:", Expensive.calls)
    corpus.debug(f"value: {Expensive()}")
    print("  after f-string debug, __str__ calls:", Expensive.calls)
    corpus.info("value: %s", Expensive())
    print("  after info (on), __str__ calls:", Expensive.calls)
```

`OnlyBad` 只放行消息里带 `bad` 的记录，`extra={"file": ...}` 把字段挂到记录上给格式串里的 `%(file)s` 用；`dictConfig` 用一个字典描述同样的 formatter、handler 和 logger：

```python
# lab/ch09/logging_tour.py:72-89,94-108
    print("-- filters and extra")

    class OnlyBad(logging.Filter):
        """Keep records whose message mentions 'bad'."""

        def filter(self, record: logging.LogRecord) -> bool:
            """Return True for the records to keep."""
            return "bad" in record.getMessage()

    other = io.StringIO()
    second = logging.StreamHandler(other)
    second.addFilter(OnlyBad())
    second.setFormatter(logging.Formatter("%(message)s [%(file)s]"))
    sift.addHandler(second)
    corpus.warning("bad front matter", extra={"file": "a.md"})
    corpus.warning("all good", extra={"file": "b.md"})
    print("  filtered handler saw:", other.getvalue().strip())
    sift.removeHandler(second)
    # ...
    config = {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {"short": {"format": "[%(levelname)s] %(message)s"}},
        "handlers": {
            "out": {
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stdout",
                "formatter": "short",
            }
        },
        "loggers": {"sift": {"handlers": ["out"], "level": "DEBUG"}},
    }
    logging.config.dictConfig(config)
    logging.getLogger("sift.index").debug("hello from dictConfig")
```

```text
-- levels
  DEBUG    = 10
  INFO     = 20
  WARNING  = 30
  ERROR    = 40
  CRITICAL = 50
  isEnabledFor(DEBUG): False
-- lazy % formatting: no str() when the level is off
  after debug (off), __str__ calls: 0
  after f-string debug, __str__ calls: 1
  after info (on), __str__ calls: 2
-- filters and extra
  filtered handler saw: bad front matter [a.md]
-- dictConfig
[DEBUG] hello from dictConfig
-- sift.log.setup_logging
  handlers after two calls: 1
  the handler writes to stderr: True
  bad level: unknown log level: 'LOUD'
```

两件事值得看。一是 `corpus.exception("caught something")` 是 `ERROR` 加回溯，通常放在 `except` 块里调用（第 11 行是回溯的首尾两行）。二是“延迟格式化”：`corpus.debug("value: %s", Expensive())` 在 `DEBUG` 关着的时候 `__str__` 调用 0 次，而 `corpus.debug(f"value: {Expensive()}")` 无论日志开不开都先格式化，调用了 1 次。那么这笔钱有多大？

```python
"""What a disabled log call costs, with %-style args and f-strings."""

import logging
import statistics
import timeit

ROUNDS = 9
NUMBER = 500_000


def main() -> None:
    """Race debug() calls while the logger is at WARNING."""
    logger = logging.getLogger("sift.corpus")
    logger.setLevel(logging.WARNING)
    namespace = {"logger": logger, "path": "corpus/posts/a.md", "n": 123}
    stmts = {
        "pass (loop overhead)": "pass",
        'debug("%s: %d", path, n)': 'logger.debug("%s: %d", path, n)',
        'debug(f"{path}: {n}")': 'logger.debug(f"{path}: {n}")',
        "if enabled: debug(...)": (
            'if logger.isEnabledFor(10):\n    logger.debug("%s: %d", path, n)'
        ),
    }
    runs: dict[str, list[float]] = {name: [] for name in stmts}
    for _ in range(ROUNDS):
        for name, stmt in stmts.items():
            t = timeit.timeit(stmt, globals=namespace, number=NUMBER)
            runs[name].append(t / NUMBER * 1e9)
    for name, times in runs.items():
        print(f"{name:26} median {statistics.median(times):6.1f} ns")


if __name__ == "__main__":
    main()
```

```text
$ python3 $S/log_cost.py
pass (loop overhead)       median    8.6 ns
debug("%s: %d", path, n)   median  119.0 ns
debug(f"{path}: {n}")      median  221.8 ns
if enabled: debug(...)     median   52.0 ns
```

`logger` 在 `WARNING` 时，一次关着的 `debug("%s: %d", path, n)` 要 118.7 ns（其中 8.5 ns 是循环自己的开销），f-string 版本是 222.8 ns，是前者的 1.88 倍，因为字符串先被造出来再被丢掉。先问一句 `isEnabledFor(DEBUG)` 可以降到 51.8 ns，但只有在参数本身很贵（比如要序列化一个大对象）的时候才值得写出来。

## traceback 模块和 3.14 的错误提示

回溯是一串帧，`traceback` 模块把它们变成可处理的对象。`traceback_demo.py` 让解析器在三层调用之下抛 `QuerySyntaxError`，然后三种方式读出来：

```text
$ python3 lab/ch09/traceback_demo.py
-- format_exception_only
sift.errors.QuerySyntaxError: expected ')'
-- walk_tb: file, function, line
  main line 21
  outer line 15
  inner line 10
  parse line 161
  parse_query line 63
  parse_or line 70
  parse_and line 78
  parse_unary line 96
  parse_atom line 109
...
  parse_atom: raise self.fail("expected ')'")
-- TracebackException.format(chain=False) last line
  sift.errors.QuerySyntaxError: expected ')'
```

`walk_tb` 给出每一帧的函数名和行号，`extract_tb` 的 `StackSummary` 还带着源码行。递归下降的每个非终结符一帧，所以 `parse_atom` 是回溯里最深的一层，最后一行 `raise self.fail("expected ')'")` 就是出错的位置。再往下是 `Did you mean` 建议：

```text
-- suggestions are computed by the traceback module (3.12+)
AttributeError: 'str' object has no attribute 'uper'. Did you mean: 'upper'?
-- NameError suggestions
NameError: name 'prnt' is not defined
-- print_exc goes to stderr, format_exc returns a string
  lines in format_exc(): 5
```

`uper` 得到了 `Did you mean: 'upper'?`，`prnt` 在这里却没有建议，而直接跑 `python3 -c 'prnt("x")'` 是有的。原因在 `Lib/traceback.py`：`format_exception_only` 构造 `TracebackException` 时不传回溯（第 180 行）；`NameError` 的建议要到最内层帧的局部、全局和内置名里找，没有回溯就没有帧，`_compute_suggestion_error` 直接返回 `None`（第 1630 行）；`AttributeError` 的建议只需要 `exc.obj`（第 1605 行），所以不受影响：

```python
# Lib/traceback.py:178-180,1601-1605,1627-1631 (v3.14.7)
    if value is _sentinel:
        value = exc
    te = TracebackException(type(value), value, None, compact=True)
# ...
def _compute_suggestion_error(exc_value, tb, wrong_name):
    if wrong_name is None or not isinstance(wrong_name, str):
        return None
    if isinstance(exc_value, AttributeError):
        obj = exc_value.obj
    # ...
    else:
        assert isinstance(exc_value, NameError)
        # find most recent frame
        if tb is None:
            return None
```

换成带回溯的 `format_exception`，同一个异常就有建议了：

```python
"""Compare format_exception_only with format_exception on NameError."""

import traceback


def main() -> None:
    """Print the last line each of the two functions returns."""
    try:
        prnt("x")  # noqa: F821
    except NameError as exc:
        only = traceback.format_exception_only(exc)
        full = traceback.format_exception(exc)
        print("format_exception_only:", only[-1], end="")
        print("format_exception:     ", full[-1], end="")


if __name__ == "__main__":
    main()
```

```text
$ python3 $S/format_nameerror.py
format_exception_only: NameError: name 'prnt' is not defined
format_exception:      NameError: name 'prnt' is not defined. Did you mean: 'print'?
```

回溯的颜色由环境变量控制：`FORCE_COLOR=1` 强制输出颜色码，`NO_COLOR=1` 不输出。同一条错误，带颜色的是 296 字节，不带的是 227 字节：

```text
$ env -u NO_COLOR FORCE_COLOR=1 python3 -c 'import math; print(math.sqroot(2))' 2>&1 | wc -c
$ env NO_COLOR=1 python3 -c 'import math; print(math.sqroot(2))' 2>&1 | wc -c
296
227
```

## breakpoint() 和 pdb

`breakpoint()` 是内置函数，它很薄：取出 `sys.breakpointhook`，先发一个 `builtins.breakpoint` 审计事件，再把参数原样转发给它（`Python/bltinmodule.c` 第 466 到 482 行的 `builtin_breakpoint`）。钩子按环境变量 `PYTHONBREAKPOINT` 决定调什么，默认是 `pdb.set_trace`：

```text
$ python3 -c 'import sys; print(sys.breakpointhook, sys.breakpointhook is sys.__breakpointhook__)'
<built-in function breakpointhook> True
```

这给你三个开关：`PYTHONBREAKPOINT=0` 让所有 `breakpoint()` 变成空操作（下面第 4 段演示），`PYTHONBREAKPOINT=模块.函数` 换成别的函数，不设就是 `pdb.set_trace`（第 3 段停在 `pdb` 里）。换函数的参数会原样传过去：

```text
$ PYTHONBREAKPOINT=builtins.print python3 -c 'breakpoint("hello", 42)'
hello 42
```

要在没有终端的地方演示 `pdb`，我把命令从 stdin 喂进去。被调试的程序很小，第二次调用会 `ZeroDivisionError`：

```python
# lab/ch09/helpers/pdb_target.py
"""A small program to debug: the mean of a list, twice."""

import sys


def mean(values: list[float]) -> float:
    """Return the arithmetic mean of values."""
    total = 0.0
    for value in values:
        total += value
    return total / len(values)


def main() -> None:
    """Print two means; the second list is empty and fails."""
    if "--breakpoint" in sys.argv:
        breakpoint()
    print("mean of [1, 2, 3]:", mean([1, 2, 3]))
    print("mean of []:", mean([]))


if __name__ == "__main__":
    main()
```

```bash
# lab/ch09/pdb_session.sh:8-10
echo '### 1. breakpoint on mean(): b, c, p, w, n, q'
printf '%s\n' 'b mean' c 'p values' w n n n 'p total' q \
    | python3 -m pdb "$TARGET" 2>&1
```

输出里的 `(Pdb)` 是提示符，每条命令的结果紧跟在后面：

```text
$ bash lab/ch09/pdb_session.sh
### 1. breakpoint on mean(): b, c, p, w, n, q
> ~/Projects/sift/lab/ch09/helpers/pdb_target.py(1)<module>()
-> """A small program to debug: the mean of a list, twice."""
(Pdb) Breakpoint 1 at ~/Projects/sift/lab/ch09/helpers/pdb_target.py:6
(Pdb) > ~/Projects/sift/lab/ch09/helpers/pdb_target.py(8)mean()
-> total = 0.0
(Pdb) [1, 2, 3]
(Pdb)
/nix/store/ls26898yzdy2wn1cvh3zkr420lsx2dvw-python3-3.14.7-env/lib/python3.14/bdb.py(913)run()
-> exec(cmd, globals, locals)
  <string>(1)<module>()
  ~/Projects/sift/lab/ch09/helpers/pdb_target.py(23)<module>()
-> main()
  ~/Projects/sift/lab/ch09/helpers/pdb_target.py(18)main()
-> print("mean of [1, 2, 3]:", mean([1, 2, 3]))
> ~/Projects/sift/lab/ch09/helpers/pdb_target.py(8)mean()
-> total = 0.0
(Pdb) > ~/Projects/sift/lab/ch09/helpers/pdb_target.py(9)mean()
-> for value in values:
(Pdb) > ~/Projects/sift/lab/ch09/helpers/pdb_target.py(10)mean()
-> total += value
(Pdb) > ~/Projects/sift/lab/ch09/helpers/pdb_target.py(9)mean()
-> for value in values:
(Pdb) 1.0
(Pdb)
```

`b mean` 在函数 `mean` 上设断点 (`Breakpoint 1 at ...:6`)，`c` 跑到断点，`p values` 打印表达式 (`[1, 2, 3]`)，`w` 打印栈，`n` 一行一行走，`p total` 在循环转了一圈之后是 `1.0`，`q` 退出。注意一点：`w` 的栈最上面是 `bdb.py` 里的 `run`，因为 `python -m pdb` 是让调试器用 `exec` 调用你的脚本的，这几帧是调试器自己的。

命令很多，`help` 一次列全：

```text
$ printf '%s\n' help q | python3 -m pdb lab/ch09/helpers/pdb_target.py
> ~/Projects/sift/lab/ch09/helpers/pdb_target.py(1)<module>()
-> """A small program to debug: the mean of a list, twice."""
(Pdb)
Documented commands (type help <topic>):
========================================
EOF    cl         disable     ignore    n        return  u          where
a      clear      display     interact  next     retval  unalias
alias  commands   down        j         p        run     undisplay
args   condition  enable      jump      pp       rv      unt
b      cont       exceptions  l         q        s       until
break  continue   exit        list      quit     source  up
bt     d          h           ll        r        step    w
c      debug      help        longlist  restart  tbreak  whatis
...
```

我实际用得最多的是这些：

| 命令 | 作用 |
| --- | --- |
| `l` / `ll` | 列出当前位置附近的源码 / 整个函数 |
| `n` / `s` | 下一行（不进函数）/ 进入函数 |
| `r` | 一直跑到当前函数返回 |
| `c` | 继续，到下一个断点 |
| `u` / `d` | 在栈里上移 / 下移一帧 |
| `w` | 打印整个栈 |
| `p expr` / `pp expr` | 打印 / 漂亮打印表达式 |
| `b 行号` / `b 函数` / `tbreak` | 设断点 / 设一次性断点 |
| `until 行号` | 跑到指定行（`-c 'until X'` 也行） |
| `interact` | 开一个带当前变量的 Python 交互环境 |
| `q` | 退出 |

### 事后调试

最有用的是崩了再看。`python -m pdb -c continue script.py` 让脚本先跑，崩溃的时候停在出错的那一帧，不是在崩溃之前：

```bash
# lab/ch09/pdb_session.sh:13-15
echo '### 2. post-mortem: -c continue runs to the crash, then w, p, u'
printf '%s\n' w 'p values' u 'p __name__' q \
    | python3 -m pdb -c continue "$TARGET" 2>&1
```

下面是同一次 `bash lab/ch09/pdb_session.sh` 的第 2 段，前面是脚本自己的那一大段回溯，我省略了：

```text
Uncaught exception. Entering post mortem debugging
Running 'cont' or 'step' will restart the program
> ~/Projects/sift/lab/ch09/helpers/pdb_target.py(11)mean()
-> return total / len(values)
(Pdb)
/nix/store/ls26898yzdy2wn1cvh3zkr420lsx2dvw-python3-3.14.7-env/lib/python3.14/pdb.py(3656)main()
-> pdb._run(target)
  /nix/store/ls26898yzdy2wn1cvh3zkr420lsx2dvw-python3-3.14.7-env/lib/python3.14/pdb.py(2566)_run()
-> self.run(target.code)
  /nix/store/ls26898yzdy2wn1cvh3zkr420lsx2dvw-python3-3.14.7-env/lib/python3.14/bdb.py(913)run()
-> exec(cmd, globals, locals)
  <string>(1)<module>()
  ~/Projects/sift/lab/ch09/helpers/pdb_target.py(23)<module>()
-> main()
  ~/Projects/sift/lab/ch09/helpers/pdb_target.py(19)main()
-> print("mean of []:", mean([]))
> ~/Projects/sift/lab/ch09/helpers/pdb_target.py(11)mean()
-> return total / len(values)
(Pdb) []
(Pdb) > ~/Projects/sift/lab/ch09/helpers/pdb_target.py(19)main()
-> print("mean of []:", mean([]))
(Pdb) '__main__'
(Pdb)
```

“Uncaught exception. Entering post mortem debugging” 之后，停在了 `mean()` 里 `return total / len(values)` 那一行，`p values` 是 `[]`，`u` 回到 `main()`，`p __name__` 是 `'__main__'`。除零的原因一眼就看到：列表是空的。在代码里也可以用 `pdb.pm()`（交互式会话里出错后调用）或者 `pdb.post_mortem(exc.__traceback__)`。

脚本里写了 `breakpoint()` 的情形，第 3 段会停在那一行；`PYTHONBREAKPOINT=0` 的第 4 段直接跑到底：

```bash
# lab/ch09/pdb_session.sh:18-20,23-24
echo '### 3. breakpoint() in the code stops in pdb by default'
printf '%s\n' 'p __name__' c \
    | python3 "$TARGET" --breakpoint 2>&1
# ...
echo '### 4. PYTHONBREAKPOINT=0 turns every breakpoint() into a no-op'
PYTHONBREAKPOINT=0 python3 "$TARGET" --breakpoint 2>&1
```

```text
### 3. breakpoint() in the code stops in pdb by default
> ~/Projects/sift/lab/ch09/helpers/pdb_target.py(17)main()
-> breakpoint()
(Pdb) '__main__'
(Pdb) mean of [1, 2, 3]: 2.0
...
### 4. PYTHONBREAKPOINT=0 turns every breakpoint() into a no-op
mean of [1, 2, 3]: 2.0
...
ZeroDivisionError: division by zero
```

## 远程附加：`python -m pdb -p PID`

PEP 768(3.14) 让 `pdb` 可以附加到一个正在运行、而且没有为调试做过任何准备的进程。它的底层是 `sys.remote_exec(pid, script_path)`：往目标进程里写一个“请在下一个安全点执行这个脚本”的请求。目标进程在 eval breaker 的处理代码里（同一个文件第 1430 行）调用下面这个函数来读它：

```c
/* Python/ceval_gil.c:1258-1268 (v3.14.7) */
int _PyRunRemoteDebugger(PyThreadState *tstate)
{
    const PyConfig *config = _PyInterpreterState_GetConfig(tstate->interp);
    if (config->remote_debug == 1
         && tstate->remote_debugger_support.debugger_pending_call == 1)
    {
        tstate->remote_debugger_support.debugger_pending_call = 0;

        // Immediately make a copy in case of a race with another debugger
        // process that's trying to write to the buffer. At least this way
        // we'll be internally consistent: what we audit is what we run.
```

`pdb.attach` 就是在这个机制上做的：开一个本地套接字，写一个小脚本让目标进程连回来，然后在本地起客户端：

```python
# Lib/pdb.py:3435-3442,3469-3482 (v3.14.7)
def attach(pid, commands=()):
    """Attach to a running process with the given PID."""
    with ExitStack() as stack:
        server = stack.enter_context(
            closing(socket.create_server(("localhost", 0)))
        )
        port = server.getsockname()[1]

        # ...
        sys.remote_exec(pid, connect_script.name)

        # TODO Add a timeout? Or don't bother since the user can ^C?
        client_sock, _ = server.accept()
        stack.enter_context(closing(client_sock))

        if use_signal_thread:
            interrupt_sock, _ = server.accept()
            stack.enter_context(closing(interrupt_sock))
            interrupt_sock.setblocking(False)
        else:
            interrupt_sock = None

        _PdbClient(pid, client_sock, interrupt_sock).cmdloop()
```

先试一试。起一个空转的 Python 进程，用 `pdb -p` 附加：

```text
$ cat /proc/sys/kernel/yama/ptrace_scope
$ python3 -c 'import time
while True:
    time.sleep(0.1)' & pid=$!; sleep 1
$ printf 'where\ncontinue\n' \
  | timeout 20 python3 -m pdb -p $pid
$ echo "pdb -p exit status: $?"; kill $pid
1
Error: The specified process cannot be attached to due to insufficient permissions.
See the Python documentation for details on required privileges and troubleshooting:
https://docs.python.org/3.14/howto/remote_debugging.html#permission-requirements

pdb -p exit status: 1
```

我在这台机器上拿到的是权限错误。第一行是 `/proc/sys/kernel/yama/ptrace_scope` 的值 1：Yama 的 `ptrace_scope = 1` 只允许一个进程附加到自己的后代，不允许附加到任意同用户的进程，而这个空转的进程是 shell 的子进程，不是 `pdb` 的子进程。错误信息来自 `Lib/pdb.py` 第 3552 到 3563 行的 `exit_with_permission_help_text`。把值改成 0 或者用 root 可以绕过，我没有试：改系统的 ptrace 策略不是写一篇文章该做的事。

权限规则本身是可以演示的：一个进程附加到**自己的子进程**是允许的。`helpers/remote_exec_demo.py` 启动一个子进程，再用 `sys.remote_exec` 往里注入一段脚本，读它的 `__main__`：

```python
# lab/ch09/helpers/remote_exec_demo.py:14-29,37-46
TARGET = """\
import time

counter = 0
while True:
    counter += 1
    time.sleep(0.05)
"""
INJECTED = """\
import os
import sys

main = sys.modules["__main__"]
print("injected: counter > 0:", main.counter > 0, flush=True)
os._exit(0)
"""
        # ...
        with subprocess.Popen(
            [sys.executable, "-c", TARGET], stdout=subprocess.PIPE, text=True
        ) as child:
            try:
                time.sleep(0.5)
                print("parent: calling sys.remote_exec(child_pid, script)")
                sys.remote_exec(child.pid, str(script))
                out, _ = child.communicate(timeout=10)
                print("child printed:", out.strip())
                print("child exit status:", child.returncode)
```

```text
$ python3 lab/ch09/helpers/remote_exec_demo.py
parent: calling sys.remote_exec(child_pid, script)
child printed: injected: counter > 0: True
child exit status: 0
```

子进程的 `counter` 被注入的脚本读到了 (`counter > 0: True`)，它没有为此做任何配合。同一个条件下，完整的 `pdb.attach` 也能用：我把父进程当调试器，在 stdin 关掉的情况下喂两条命令，下面是我写的脚本和输出：

```python
"""pdb.attach() on our own child: the allowed side of PEP 768."""

import pdb
import subprocess
import sys
import time

TARGET = """\
import time

def work(n):
    time.sleep(0.05)
    return n + 1

total = 0
while True:
    total = work(total)
"""


def main() -> None:
    """Start a child, attach pdb to it, run two commands, detach."""
    with subprocess.Popen([sys.executable, "-c", TARGET]) as child:
        try:
            time.sleep(0.5)
            print(f"attaching to child {child.pid}", flush=True)
            pdb.attach(child.pid, commands=["where", "p total > 0"])
            time.sleep(1)
        finally:
            child.kill()


if __name__ == "__main__":
    main()
```

```text
$ python3 $S/attach_demo.py </dev/null
attaching to child 26601
  <string>(9)<module>()
> <string>(4)work()
True
> <string>(4)work()
(Pdb)
```

`where` 打印出子进程的栈，只有 `<module>` 和正停在其中的 `work()`，源码文件显示为 `<string>` 因为目标是用 `-c` 起的；`p total > 0` 得到 `True`。

## 跑一遍

整章一个 `make` 目标，再加 `make lint`：

```text
$ make ch09
python3 scripts/chapter.py ch09
ok   lab/ch09/add_note.py
ok   lab/ch09/bracketless_except.py
ok   lab/ch09/context_managers.py
ok   lab/ch09/corpus_strict_parse.py
ok   lab/ch09/custom_exceptions.py
ok   lab/ch09/eafp_lbyl.py
ok   lab/ch09/exception_groups.py
ok   lab/ch09/finally_return_warning.py
ok   lab/ch09/index_bad_files_fail.py
ok   lab/ch09/index_writer.py
ok   lab/ch09/logging_tour.py
ok   lab/ch09/query_error_render.py
ok   lab/ch09/raise_from.py
ok   lab/ch09/traceback_demo.py
ok   lab/ch09/try_except_else_finally.py
ok   lab/ch09/warnings_demo.py
  File "~/Projects/sift/lab/ch09/finally_return_warning.py", line 9
...
pdb_session: 99 lines
ptrace_scope: 1
Error: The specified process cannot be attached to due to insufficient permissions.
See the Python documentation for details on required privileges and troubleshooting:
https://docs.python.org/3.14/howto/remote_debugging.html#permission-requirements

pdb -p exit status: 1
parent: calling sys.remote_exec(child_pid, script)
child printed: injected: counter > 0: True
child exit status: 0
ok   lab/ch09/extra.sh
$ make lint
ruff format --check --line-length 79 .
147 files already formatted
ruff check .
All checks passed!
```

（`make ch09` 最后跑的 `extra.sh` 会把它自己的输出打到同一个终端，中间 42 行是上面各节已经看过的回溯、拼写错误和颜色码，我用 `...` 省略了。）

`index_bad_files_fail.py` 也显示 `ok`，因为运行器知道 `_fail.py` 结尾的文件应该非零退出，我另外确认了退出码，同时确认命令行对括号错误的退出码是 3：

```text
$ python3 lab/ch09/index_bad_files_fail.py >/dev/null 2>&1; echo $?
1
$ python3 -m sift search '(rust' >/dev/null 2>&1; echo $?
3
```

## 本篇文件

这一章改过的 `src/sift` 文件和新增的 `lab/ch09` 文件，再加上两个因为异常类换了位置而改了一行的旧实验：

```text
$ git diff --shortstat ch08 ch09 -- src lab
 34 files changed, 1570 insertions(+), 88 deletions(-)
```

[`lab/ch09`](https://github.com/bfmhno3/sift/tree/ch09/lab/ch09) 下有 16 个 `.py`、`extra.sh`、`pdb_session.sh` 和 `helpers/` 里的两个文件，加上这一章改过或新增的 `src/sift` 下的 12 个文件（其中 `query/errors.py` 是被删除的），再加两个旧实验，共 34 个。结果列是我在本篇的环境里重新跑出来的。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`src/sift/errors.py`](https://github.com/bfmhno3/sift/blob/ch09/src/sift/errors.py) | `python3 -c 'from sift.errors import SiftError, QuerySyntaxError as Q; print(issubclass(Q, SiftError))'` | 退出码 0，输出 `True`；98 行 |
| [`src/sift/log.py`](https://github.com/bfmhno3/sift/blob/ch09/src/sift/log.py) | `python3 -c 'from sift.log import setup_logging; import logging; setup_logging("INFO"); logging.getLogger("sift.x").info("hi")'` | 退出码 0，stderr 输出 `INFO sift.x: hi`；30 行 |
| [`src/sift/__main__.py`](https://github.com/bfmhno3/sift/blob/ch09/src/sift/__main__.py) | `python3 -m sift search '(rust'; echo $?` | 退出码 3（`echo` 打印的就是 3），前三行是 `expected ')'`、`  (rust` 和脱字符行；144 行；`main()` 的异常组分支是这一章的返工，见异常组一节 |
| [`src/sift/analysis/pipeline.py`](https://github.com/bfmhno3/sift/blob/ch09/src/sift/analysis/pipeline.py) | `python3 -c 'from sift.analysis import build_pipeline; build_pipeline(["nope"])'` | 退出码 1：`sift.errors.ConfigError: unknown tokenizer 'nope'; known: cjk-bigram, latin, mixed`；54 行 |
| [`src/sift/corpus.py`](https://github.com/bfmhno3/sift/blob/ch09/src/sift/corpus.py) | `python3 lab/ch09/corpus_strict_parse.py` | 退出码 0，第一行 `files:  123`，`failed: 0`；44 行 |
| [`src/sift/document.py`](https://github.com/bfmhno3/sift/blob/ch09/src/sift/document.py) | `python3 -c 'from pathlib import Path; from sift.document import Document; Document.from_markdown(0, Path("a.md"), "---\ntitle: x\n---\nbody\n")'` | 退出码 1：`sift.errors.FrontMatterError: a.md:1: missing 'published'`；104 行 |
| [`src/sift/frontmatter.py`](https://github.com/bfmhno3/sift/blob/ch09/src/sift/frontmatter.py) | `python3 -c 'from pathlib import Path; from sift.frontmatter import parse_front_matter as p; p("a: 1\nb: [x", Path("p.md"), 2)'` | 退出码 1：`sift.errors.FrontMatterError: p.md:3: unterminated inline list: [x`；155 行 |
| [`src/sift/index.py`](https://github.com/bfmhno3/sift/blob/ch09/src/sift/index.py) | `python3 lab/ch09/index_writer.py` | 退出码 0，第一行 `after a good block: 3 docs, 205 terms`；314 行 |
| [`src/sift/query/__init__.py`](https://github.com/bfmhno3/sift/blob/ch09/src/sift/query/__init__.py) | `python3 -c 'import sift.query as q; print(hasattr(q, "QuerySyntaxError"))'` | 退出码 0，输出 `False`；22 行 |
| [`src/sift/query/errors.py`](https://github.com/bfmhno3/sift/blob/ch08/src/sift/query/errors.py) | `python3 -c 'import sift.query.errors'` | 这个文件在 `ch09` 已删除（链接指向 `ch08`）：退出码 1，`ModuleNotFoundError: No module named 'sift.query.errors'` |
| [`src/sift/query/lexer.py`](https://github.com/bfmhno3/sift/blob/ch09/src/sift/query/lexer.py) | `python3 -c 'import sift.query.lexer as l; print(l.QuerySyntaxError.__module__)'` | 退出码 0，输出 `sift.errors`；95 行 |
| [`src/sift/query/parser.py`](https://github.com/bfmhno3/sift/blob/ch09/src/sift/query/parser.py) | `python3 -c 'from sift.query import parse; parse("(" * 101 + "a" + ")" * 101)'` | 退出码 1：`sift.errors.QuerySyntaxError: query nested too deeply`；166 行 |
| [`lab/ch09/try_except_else_finally.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/try_except_else_finally.py) | `python3 lab/ch09/try_except_else_finally.py` | 退出码 0，第一行 `-- no exception` |
| [`lab/ch09/raise_from.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/raise_from.py) | `python3 lab/ch09/raise_from.py` | 退出码 0，第一行 `-- implicit chaining` |
| [`lab/ch09/custom_exceptions.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/custom_exceptions.py) | `python3 lab/ch09/custom_exceptions.py` | 退出码 0，第一行是 `QuerySyntaxError` 的 MRO |
| [`lab/ch09/query_error_render.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/query_error_render.py) | `python3 lab/ch09/query_error_render.py` | 退出码 0，第一行 `query    '(rust'` |
| [`lab/ch09/exception_groups.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/exception_groups.py) | `python3 lab/ch09/exception_groups.py` | 退出码 0，第一行 `except* ValueError got: ExceptionGroup('3 files failed', [...])`（括号里是两个 `ValueError`） |
| [`lab/ch09/add_note.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/add_note.py) | `python3 lab/ch09/add_note.py` | 退出码 0，第一行 `type: FrontMatterError` |
| [`lab/ch09/bracketless_except.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/bracketless_except.py) | `python3 lab/ch09/bracketless_except.py` | 退出码 0，第一行 `parse('42') = 42` |
| [`lab/ch09/finally_return_warning.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/finally_return_warning.py) | `python3 lab/ch09/finally_return_warning.py` | 退出码 0，stdout `finally won`，stderr 第一行是 `SyntaxWarning: 'return' in a 'finally' block` |
| [`lab/ch09/eafp_lbyl.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/eafp_lbyl.py) | `python3 lab/ch09/eafp_lbyl.py` | 退出码 0，第一行 `plain dict, median of 7 runs of 1,000,000 calls`（耗时每次略有不同） |
| [`lab/ch09/context_managers.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/context_managers.py) | `python3 lab/ch09/context_managers.py` | 退出码 0，第一行 `-- normal exit` |
| [`lab/ch09/warnings_demo.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/warnings_demo.py) | `python3 lab/ch09/warnings_demo.py` | 退出码 0，第一行 `default filters (first three):` |
| [`lab/ch09/logging_tour.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/logging_tour.py) | `python3 lab/ch09/logging_tour.py` | 退出码 0，第一行 `-- hierarchy: names with dots form a tree` |
| [`lab/ch09/traceback_demo.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/traceback_demo.py) | `python3 lab/ch09/traceback_demo.py` | 退出码 0，第一行 `-- format_exception_only` |
| [`lab/ch09/corpus_strict_parse.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/corpus_strict_parse.py) | `python3 lab/ch09/corpus_strict_parse.py` | 退出码 0，第一行 `files:  123` |
| [`lab/ch09/index_bad_files_fail.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/index_bad_files_fail.py) | `python3 lab/ch09/index_bad_files_fail.py` | 退出码 1：回溯顶层是 `ExceptionGroup: 2 files failed (2 sub-exceptions)` |
| [`lab/ch09/index_writer.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/index_writer.py) | `python3 lab/ch09/index_writer.py` | 退出码 0，第一行 `after a good block: 3 docs, 205 terms` |
| [`lab/ch09/extra.sh`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/extra.sh) | `bash lab/ch09/extra.sh` | 退出码 0，第一行是 `-W error` 下的 `SyntaxError` 回溯，最后三行是 `remote_exec_demo.py` 的输出 |
| [`lab/ch09/pdb_session.sh`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/pdb_session.sh) | `bash lab/ch09/pdb_session.sh` | 退出码 0（脚本最后写了 `exit 0`），第一行 `### 1. breakpoint on mean(): b, c, p, w, n, q` |
| [`lab/ch09/helpers/pdb_target.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/helpers/pdb_target.py) | `python3 lab/ch09/helpers/pdb_target.py` | 退出码 1：先打印 `mean of [1, 2, 3]: 2.0`，末行 `ZeroDivisionError: division by zero` |
| [`lab/ch09/helpers/remote_exec_demo.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch09/helpers/remote_exec_demo.py) | `python3 lab/ch09/helpers/remote_exec_demo.py` | 退出码 0，第一行 `parent: calling sys.remote_exec(child_pid, script)` |
| [`lab/ch06/frontmatter_corpus.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch06/frontmatter_corpus.py) | `python3 lab/ch06/frontmatter_corpus.py` | 退出码 0，第一行 `front matter parsed: 123`，坏样例改成 `FrontMatterError` |
| [`lab/ch08/syntax_error_demo_fail.py`](https://github.com/bfmhno3/sift/blob/ch09/lab/ch08/syntax_error_demo_fail.py) | `python3 lab/ch08/syntax_error_demo_fail.py` | 退出码 1：回溯的最后一行是 `sift.errors.QuerySyntaxError: expected ')'` |

## 练习

**1.** 给 `InvertedIndex` 加一个 `__contains__`，只问内部字典。用 `eafp_alternating.py` 量改动前后，并且证明所有现有实验输出不变。想一想：为什么 `PostingList.__contains__`（第 6 篇）是自己写的，而 `InvertedIndex` 当时没有？

**2.** 让命令行支持 `--keep-going`，并且把跳过的文件数印在最后一行。`doc_id` 有洞的问题怎么处理：重新编号，还是把 `documents` 改成字典？各有什么代价？

**3.** 把 `MAX_DEPTH` 的思路搬到平铺的链上：`a OR a OR ...` 1000 项时 `RecursionError` 是从哪一层抛的？是解析器、`And`/`Or` 的构造，还是后面的求值？用 `traceback.walk_tb` 找出来，再决定在哪里限制。

**4.** 用 `contextlib.contextmanager` 重写 `IndexWriter`。回滚放在 `except` 里还是 `finally` 里？`writer.add` 这个方法该挂在哪个对象上，生成器版本 `yield` 什么给调用者？

## 下一篇

下一篇是《[测试：pytest、hypothesis 与 CI](/posts/python-by-sift-10-testing/)》。这一章里的错误都是我手工造出来再看它们怎么走的：坏的括号、坏的 front matter、不存在的流水线名字。测试要把这些手工造的情形留下来，变成每次提交都会重新跑的东西，包括这一篇里我没有修的那些边角。
