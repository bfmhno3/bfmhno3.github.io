---
title: "测试：pytest、hypothesis 与 CI：让机器替我去找没想到的输入"
commentId: "post:python-by-sift-10-testing"
published: "2026-10-23 05:00:00 +08:00"
description: "用 Sift 重学 Python 第 10 篇：我用 Python 3.14.7、pytest 9.1.1 和 hypothesis 6.156.1 给 Sift 写了 312 个通过、1 个预期失败的测试（5.3 秒跑完），hypothesis 在 snippet 高亮里撞出一个真 bug，我修了两次才修干净，第二次是 597,871 个字符串的暴力扫描找到的；行覆盖率 99%，GitHub Actions 上用 Nix 跑完 lint、测试和全部实验是 3 分 40 秒，其中 pytest 只占 5.3 秒。"
category: Tutorial
tags:
  - Python
  - Sift
  - 测试
  - pytest
  - hypothesis
  - CI
series: "用 Sift 重学 Python"
seriesOrder: 10
draft: false
comment: true
slug: python-by-sift-10-testing
---

我给 snippet 高亮写了一条 11 行的性质测试：任意文本、任意词，高亮出来的片段折叠之后必须是这个词；hypothesis 在默认的 100 个输入里的最后一个上把它打破了，然后把输入缩成了两个字符，一个连字 `ﬁ` 加一个组合重音符。这个 bug 是真的，修复和回归测试都在标签 `ch10` 里；下面是对修复之前的 `snippet.py` 跑这条测试的输出（`pre` 是我下面定义的一个小函数，让命令用旧代码跑）：

```text
$ pre pytest -q --no-header tests/test_properties.py -k highlights | grep -m1 -A2 Falsif
E       Falsifying example: test_snippet_highlights_exactly_the_matching_words(
E           text='ﬁ́',
E       )
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch10`：新增 `tests/conftest.py` 和 15 个测试文件（它们用的 `tests/fixtures/mini/` 里的 8 篇样本文章从第 1 篇起就在仓库里，没有改）、`pytest.ini`、`.github/workflows/ci.yml`，`lab/ch10` 下有 5 个脚本、`extra.sh` 和 `pytest_features.sh`；改动了 `Makefile`（新增 `test` 和 `cov` 目标，`ci` 先 lint 再测试再跑各章实验）、`README.md`、`src/sift/query/ast.py`（新增 `print_query`）、`query/__init__.py`、`scoring.py` 和 `snippet.py`（修了两次的一个 bug，加 doctest）。这些文件里 `pytest.ini` 到第 11 篇会搬进 `pyproject.toml`，`Makefile` 的 `ci` 目标后面还会加类型检查和扩展模块两项（文件里的注释这么写），`tests/` 我猜会随着新模块一起长，其余在后面只会被扩展。`make ch10` 通过，`make lint` 通过，GitHub Actions 对这个标签的运行也是绿的。
> 涉及的 Python 特性：`assert` 语句与 pytest 的断言重写、fixture 与作用域、`conftest.py`、`parametrize`、`tmp_path`/`monkeypatch`/`capsys`、`pytest.raises(match=)`、标记与 `xfail(strict=True)`、`unittest` 与 `doctest`、`unittest.mock`、基于性质的测试与缩小、覆盖率、pytest-benchmark、GitHub Actions 加 Nix。
> 前置：[第 9 篇](/posts/python-by-sift-09-exceptions-context-logging/)，需要读得懂 `SiftError` 和 `IndexWriter`。

前九篇我都是手工造输入、看输出、凭眼睛判断对不对。第 9 篇结尾说过，这些手工造的情形要留下来，变成每次提交都重新跑的东西。这一篇做的就是这件事：312 个通过的测试，1 个我明知会失败、让它继续失败的测试，13 条让 hypothesis 生成输入的性质，以及一个在别人的机器上从零重跑这一切的工作流。中间有几处不体面的地方：hypothesis 找到了我自己的 bug，而我的第一次修复是不完整的，剩下的是一次暴力扫描找到的；另一条性质失败，是因为我写的测试是错的。都留在文章里。

## 环境

和前几篇同一台机器，仓库在标签 `ch10`，命令都在 `nix develop` 里、仓库根目录 `~/Projects/sift` 下跑：

```text
$ uname -r; python3 -VV; pytest --version; git describe --tags; git log --oneline -3
6.18.57
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
pytest 9.1.1
ch10
e0cc29a fix(ch10): tokenize snippets from the original text, drop vacuous asserts
a69014e feat(ch10): pytest suite, hypothesis properties, doctests, CI
9782c2c fix(ch10): map snippet offsets when folding keeps the length
```

有一件事要先交代，因为它会改变 hypothesis 的行为：我的 shell 里 `CI=true`，`nix develop` 把它原样带进了开发环境。我一开始以为是 flake 设的，其实不是：`flake.nix` 里没有 `CI`，用 `env -i` 清空环境再进去，`CI` 是空的。

```text
$ echo "CI=[$CI]"
CI=[true]
$ env -i HOME=$HOME PATH=$PATH nix develop --command bash -c 'echo "CI=[$CI]"' 2>/dev/null
sift dev shell: Python 3.14.7, Python 3.14.7 (free-threaded), ruff 0.16.3, rustc 1.97.1 (8bab26f4f
2026-07-14) (built from a source tarball)
CI=[]
```

所以下面所有没特别说明的命令都带着 `CI=true`，hypothesis 因此选了它的 `ci` 配置，后面有一节专门讲这件事。

下面的文章里会用到的目录和函数，先定义好。`S` 放只为这篇写的脚本，不进仓库；`PRE` 是一份“修复之前”的仓库副本，由 `ch10` 导出后只把 `src/sift/snippet.py` 换成 `ch09` 标签里的版本；`pre` 在这份副本里跑命令，`PYTHONPATH` 的第一项换成副本的 `src`：

```bash
S=/tmp/p10/scratch
PRE=/tmp/p10/pre
mkdir -p $S $PRE
git archive ch10 | tar -x -C $PRE
git show ch09:src/sift/snippet.py > $PRE/src/sift/snippet.py
ln -s ~/Projects/sift/corpus $PRE/corpus
pre() { (cd $PRE && PYTHONPATH=$PRE/src:${PYTHONPATH#*:} "$@"); }
```

上游源码我从各自的标签直接取原文：pytest `9.1.1`、hypothesis `v6.156.1`、CPython `v3.14.7`，下文引用的行号都是这些标签下的行号。输出里的主目录路径换成了 `~`，行尾空格去掉了；显示宽度（中日韩字符算 2 列）超过 100 的行我在空格处折成两行，续行不缩进。`$S` 下带 `pytest.ini` 的目录是小型的独立项目，那个文件只有一项配置，让输出短一点：`-p no:cacheprovider` 不写 `.pytest_cache`，`--no-header` 去掉版本头，`-q` 只留点：

```ini
[pytest]
addopts = -p no:cacheprovider --no-header -q
```

## 一个能跑的套件

配置只有 5 行：

```ini
# pytest.ini
[pytest]
addopts = --doctest-modules -q
testpaths = tests src
markers =
    slow: needs the full corpus or many generated cases
```

`-q` 让输出只剩点；`--doctest-modules` 让 pytest 把 `testpaths` 里模块 docstring 的 `>>>` 示例也当测试收集；`testpaths = tests src` 同时覆盖测试目录和源码目录；`slow` 是我登记的标记。`lab/` 不在 `testpaths` 里，所以后面的基准文件不会被普通的 `pytest` 收进来。

```text
$ make test
pytest
........................................................................ [ 23%]
........................................................................ [ 46%]
...x.................................................................... [ 69%]
........................................................................ [ 92%]
.........................                                                [100%]
312 passed, 1 xfailed in 6.38s
```

312 个通过、1 个 `xfailed`。第一次 6.38 秒，接着连跑五次是这个样子：

```text
$ for i in 1 2 3 4 5; do pytest | tail -1; done
312 passed, 1 xfailed in 5.35s
312 passed, 1 xfailed in 5.19s
312 passed, 1 xfailed in 5.26s
312 passed, 1 xfailed in 5.34s
312 passed, 1 xfailed in 5.36s
```

五次是 5.19 到 5.36 秒，第一次慢了两成。这台机器上我反复见到空闲一阵之后的第一次运行偏慢（后面的基准里是 2.6 倍），我猜是冷缓存或者 CPU 频率，没有验证，所以下面的计时凡是我自己比较的，都先做一次预热。收集到的数目在这里：

```text
$ pytest --collect-only -q
src/sift/query/ast.py: 1
src/sift/scoring.py: 4
src/sift/snippet.py: 4
tests/test_analysis.py: 30
tests/test_corpus.py: 8
tests/test_document.py: 18
tests/test_errors.py: 11
tests/test_frontmatter.py: 18
tests/test_index.py: 22
tests/test_log.py: 4
tests/test_main.py: 12
tests/test_markdown.py: 25
tests/test_properties.py: 13
tests/test_query.py: 93
tests/test_scoring.py: 14
tests/test_search.py: 13
tests/test_snippet.py: 19
tests/test_util.py: 4
```

304 个在 `tests/` 里，9 个是 docstring 里的 doctest，加起来 313，等于 312 个通过加 1 个 `xfailed`。`tests/` 共 1,810 行，`src/sift` 的 24 个文件共 2,297 行。时间花在哪？最慢的 5 个全是性质测试：

```text
$ pytest --durations=5 | tail -7
============================= slowest 5 durations ==============================
0.43s call     tests/test_properties.py::test_or_agrees_with_set_union
0.40s call     tests/test_properties.py::test_merged_positions_are_the_sorted_union
0.39s call     tests/test_properties.py::test_sub_agrees_with_set_difference
0.37s call     tests/test_properties.py::test_parse_inverts_print_query
0.35s call     tests/test_properties.py::test_set_laws
312 passed, 1 xfailed in 5.33s
```

这 5 个加起来 1.9 秒；13 条性质单独跑要 4.56 秒（后面的文件表里有），而只选一个测试的运行，在后面各节里总是 0.67 到 0.74 秒，那是 pytest 和它的插件自己启动的开销。所以 5.3 秒里性质测试是大头。GitHub Actions 上同一个命令跑了 5.32 秒，几乎一样，CI 一节会贴日志。

## assert 重写

写 pytest 测试的人都习惯了这件事：测试里是裸的 `assert`，失败时它却能告诉你两边的值、哪个下标不同、整个列表的 diff。Python 的 `assert` 语句只会抛一个没有内容的 `AssertionError`。信息是从哪来的？先看一个会失败的测试，它是 `$S/rewrite` 下的一个独立文件：

```python
"""A failing assertion, to see what pytest prints for it."""

from sift.analysis import tokenize


def test_tokens() -> None:
    text = "Rust 所有权"
    # BAD: tokenize makes CJK bigrams, so this expectation is wrong
    # error: AssertionError: assert ['rust', '所有', '有权'] == ...
    assert tokenize(text) == ["rust", "所有权"]
```

```text
$ cd $S/rewrite && pytest test_rewrite_demo.py
F                                                                        [100%]
=================================== FAILURES ===================================
_________________________________ test_tokens __________________________________

    def test_tokens() -> None:
        text = "Rust 所有权"
        # BAD: tokenize makes CJK bigrams, so this expectation is wrong
        # error: AssertionError: assert ['rust', '所有', '有权'] == ...
>       assert tokenize(text) == ["rust", "所有权"]
E       AssertionError: assert ['rust', '所有', '有权'] == ['rust', '所有权']
E
E         At index 1 diff: '所有' != '所有权'
E         Left contains one more item: '有权'
E
E         Full diff:
E           [
E               'rust',
E         -     '所有权',
E         ?        -
E         +     '所有',
E         +     '有权',
E           ]

test_rewrite_demo.py:10: AssertionError
=========================== short test summary info ============================
FAILED test_rewrite_demo.py::test_tokens - AssertionError: assert ['rust', '所有', '有权'] ==
['rust', '所有权']

  At index 1 diff: '所有' != '所有权'
  Left contains one more item: '有权'

  Full diff:
    [
        'rust',
  -     '所有权',
  ?        -
  +     '所有',
  +     '有权',
    ]
1 failed in 0.69s
```

`tokenize` 对 CJK 做二元组，所以 `所有权` 是 `所有` 加 `有权`，我写错了期望，失败报告把两边的列表、第一个不同的下标和逐项 diff 都列了出来。关掉重写再跑一次：

```text
$ cd $S/rewrite && pytest --assert=plain test_rewrite_demo.py | grep -E "^(>|E)"
>       assert tokenize(text) == ["rust", "所有权"]
E       AssertionError
```

`--assert=plain` 之后，`>` 行下面只剩一个 `AssertionError`，没有任何值（我用 `grep` 只留了 `>` 和 `E` 开头的行）。所以信息不是 Python 给的，是 pytest 在导入测试模块的时候改写了语法树。入口在 `src/_pytest/assertion/rewrite.py:343-351` (pytest 9.1.1)：它是一个 import hook，读源码、`ast.parse`、`rewrite_asserts` 改写、再 `compile`。

我不想只看文档的描述，所以直接调用同一个函数，把改写后的语法树打印回源码。脚本只做这一件事：

```python
"""Print what pytest turns a test module's asserts into."""

import ast
import sys
from pathlib import Path

from _pytest.assertion.rewrite import rewrite_asserts


def main() -> None:
    """Rewrite the asserts of argv[1] and print the result."""
    path = Path(sys.argv[1])
    source = path.read_bytes()
    tree = ast.parse(source, filename=str(path))
    rewrite_asserts(tree, source, str(path))
    print(ast.unparse(tree))


if __name__ == "__main__":
    main()
```

```text
$ cd $S/rewrite && python3 show_rewrite.py test_rewrite_demo.py
"""A failing assertion, to see what pytest prints for it."""
import builtins as @py_builtins
import _pytest.assertion.rewrite as @pytest_ar
from sift.analysis import tokenize

def test_tokens() -> None:
    text = 'Rust 所有权'
    @py_assert2 = tokenize(text)
    @py_assert5 = ['rust', '所有权']
    @py_assert4 = @py_assert2 == @py_assert5
    if not @py_assert4:
        @py_format7 = @pytest_ar._call_reprcompare(('==',), (@py_assert4,), ('%(py3)s\n{%(py3)s =
%(py0)s(%(py1)s)\n} == %(py6)s',), (@py_assert2, @py_assert5)) % {'py0':
@pytest_ar._saferepr(tokenize) if 'tokenize' in @py_builtins.locals() or
@pytest_ar._should_repr_global_name(tokenize) else 'tokenize', 'py1': @pytest_ar._saferepr(text) if
'text' in @py_builtins.locals() or @pytest_ar._should_repr_global_name(text) else 'text', 'py3':
@pytest_ar._saferepr(@py_assert2), 'py6': @pytest_ar._saferepr(@py_assert5)}
        @py_format9 = ('' + 'assert %(py8)s') % {'py8': @py_format7}
        raise AssertionError(@pytest_ar._format_explanation(@py_format9))
    @py_assert2 = @py_assert4 = @py_assert5 = None
```

（`ast.unparse` 打印出来的 `@py_assert2` 不是合法的 Python 标识符，pytest 用它大概是为了不和用户的变量名冲突，这段输出是看的，不是用来再运行的。）一个 `assert tokenize(text) == [...]` 变成了这样：先把每个子表达式的值存进 `@py_assert2`、`@py_assert5` 这样的临时变量，比较的结果放进 `@py_assert4`；只有 `if not @py_assert4` 为真，才调用 `_call_reprcompare` 去格式化解释，抛出 `AssertionError`；最后一行把临时变量清成 `None`，免得它们拖住大对象。通过的断言只多做几次赋值，失败了才有东西可读，有点像飞机上的黑匣子：平时只是多背了一点重量。

改写后的代码对象缓存在 `__pycache__` 里，文件名带着 pytest 的版本（`rewrite.py:68-70` 里的 `PYTEST_TAG`，pytest 9.1.1），所以换一个版本的 pytest 不会读到旧缓存：

```text
$ ls tests/__pycache__ | head -3; ls src/sift/__pycache__ | head -3
conftest.cpython-314-pytest-9.1.1.pyc
test_analysis.cpython-314-pytest-9.1.1.pyc
test_corpus.cpython-314-pytest-9.1.1.pyc
corpus.cpython-314.pyc
document.cpython-314.pyc
errors.cpython-314.pyc
```

`tests/` 下的是 `conftest.cpython-314-pytest-9.1.1.pyc`，`src/sift/` 下的是普通的 `corpus.cpython-314.pyc`：`src/sift` 没被改写。哪些模块会被改写，由 `_should_rewrite` 决定：

```python
# src/_pytest/assertion/rewrite.py:229-248 (pytest 9.1.1)
    def _should_rewrite(self, name: str, fn: str, state: AssertionState) -> bool:
        # always rewrite conftest files
        if os.path.basename(fn) == "conftest.py":
            state.trace(f"rewriting conftest file: {fn!r}")
            return True

        if self.session is not None:
            if self.session.isinitpath(absolutepath(fn)):
                state.trace(f"matched test file (was specified on cmdline): {fn!r}")
                return True

        # modules not passed explicitly on the command line are only
        # rewritten if they match the naming convention for test files
        fn_path = PurePath(fn)
        for pat in self.fnpats:
            if fnmatch_ex(pat, fn_path):
                state.trace(f"matched test file {fn!r}")
                return True

        return self._is_marked_for_rewrite(name, state)
```

只有 `conftest.py`、命令行上点名的文件、以及符合 `python_files` 命名（默认 `test_*.py` 和 `*_test.py`，见 `src/_pytest/python.py:88-93`）的文件会被改写，其余只有被 `register_assert_rewrite` 标记的才算。这有一个不太明显的后果：把断言写进一个测试辅助模块里，辅助模块的 `assert` 就是普通的 `assert`。我做了一对对照，两个目录里的 `helpers.py` 和 `test_helper.py` 完全一样，只有第二个目录多一个 `conftest.py`，里面一行 `pytest.register_assert_rewrite("helpers")`：

```python
"""A helper module: its name does not match test_*.py."""


def check_order(got: list[int]) -> None:
    """Assert that got is [6, 7]."""
    assert got == [6, 7]
```

```python
"""Ask pytest to rewrite the asserts of helpers.py as well."""

import pytest

pytest.register_assert_rewrite("helpers")
```

两个目录里的 `test_helper.py` 也一样：

```python
"""The assert lives in helpers.py, the test only calls it."""

from helpers import check_order


def test_helper() -> None:
    # BAD: check_order wants [6, 7]
    # error: AssertionError: assert [7, 6] == [6, 7] (or just the type)
    check_order([7, 6])
```

```text
$ cd $S/helper_plain && pytest | grep -E "^E "
E   AssertionError
$ cd $S/helper_registered && pytest | grep -E "^E "
E   assert [7, 6] == [6, 7]
E
E     At index 0 diff: 7 != 6
E
E     Full diff:
E       [
E     +     7,
E           6,
E     -     7,
E       ]
```

第一个只有 `AssertionError`，第二个有完整的解释（我用 `grep` 只留了 `E` 开头的行）。`src/sift` 里的函数我从不在里面写“给测试用的断言”，所以这一点在 Sift 里没有踩到，但如果你抽出一个 `tests/helpers.py` 之类的模块，记得它。

## fixture、作用域和 conftest.py

fixture 是 pytest 的依赖注入：测试函数的参数名就是要什么，pytest 按名字找到同名的 fixture 函数，调用它，把返回值传进去。Sift 的第一个共享 fixture 放在 `tests/conftest.py` 里：

```python
# tests/conftest.py:14-37
@pytest.fixture(scope="session")
def mini_root() -> Path:
    """Return the directory of the eight fixture posts."""
    return MINI


@pytest.fixture(scope="session")
def mini_docs(mini_root: Path) -> list[Document]:
    """Return the fixture posts as Documents, doc_id 0 to 7."""
    return list(iter_documents(mini_root))


@pytest.fixture(scope="session")
def mini_index(mini_docs: list[Document]) -> InvertedIndex:
    """Return an index over the fixture posts.

    The scope is the session, so a test must only read it. A test that
    adds or removes documents builds its own InvertedIndex.
    """
    index = InvertedIndex()
    with IndexWriter(index) as writer:
        for doc in mini_docs:
            writer.add(doc)
    return index
```

三个 fixture 的作用域都是 `session`：整个 pytest 进程里只执行一次，结果缓存起来，后面所有要它的测试拿到的是同一个对象。缓存的实现在 `FixtureDef.execute` 里（`src/_pytest/fixtures.py:1189-1206`，pytest 9.1.1）：先看有没有缓存的结果，命中判断就是比较 `cache_key`（同一个文件的 1241-1242 行，它返回 `getattr(request, "param", None)`，没有参数化的 fixture 永远是 `None`），命中就直接返回缓存的值。

`conftest.py` 是 pytest 自动发现的特殊文件：同一目录下所有测试都能直接用它定义的 fixture，不需要 `import`；上一节的 `_should_rewrite` 第一条也说了，它总是被改写。`--fixtures` 可以看到每个 fixture 来自哪里：

```text
$ pytest --fixtures tests/test_search.py | grep -E -- "-- tests/"
mini_root [session scope] -- tests/conftest.py:15
mini_docs [session scope] -- tests/conftest.py:21
mini_index [session scope] -- tests/conftest.py:27
searcher -- tests/test_search.py:24
```

`searcher` 是 `tests/test_search.py` 里自己定义的函数作用域 fixture，依赖 session 作用域的 `mini_index`：

```python
# tests/test_search.py:23-27
@pytest.fixture
def searcher(mini_index: InvertedIndex) -> Searcher:
    """Return a Searcher over the shared mini index."""
    return Searcher(mini_index)

```

`--setup-show` 把 fixture 的创建和销毁顺序打出来，`S` 是 session，`F` 是 function，缩进表示属于哪个测试：

```text
$ pytest --setup-show --no-header tests/test_search.py -k "test_result_fields or test_no_match"

SETUP    S event_loop_policy
SETUP    S mini_root
SETUP    S mini_docs (fixtures used: mini_root)
SETUP    S mini_index (fixtures used: mini_docs)
        SETUP    F searcher (fixtures used: mini_index)
        tests/test_search.py::test_result_fields (fixtures used: event_loop_policy, mini_docs,
mini_index, mini_root, searcher) .
        TEARDOWN F searcher
        SETUP    F searcher (fixtures used: mini_index)
        tests/test_search.py::test_no_match (fixtures used: event_loop_policy, mini_docs,
mini_index, mini_root, searcher) .
        TEARDOWN F searcher
TEARDOWN S mini_index
TEARDOWN S mini_docs
TEARDOWN S mini_root
TEARDOWN S event_loop_policy
2 passed, 11 deselected in 0.71s
```

三个 session fixture 在第一个要它们的测试之前创建一次，`searcher` 每个测试创建一次、测完销毁，最后才拆 session 的。`event_loop_policy` 不是我的，是 pytest-asyncio 的 session 级自动 fixture，每次 `--setup-show` 都会出现。

带 `yield` 的 fixture 把“创建”和“清理”写在同一个函数里，`yield` 之前是 setup，之后是 teardown。`autouse=True` 让它对目录里每个测试自动生效。`tests/test_log.py` 用它保护全局的 logger：

```python
# tests/test_log.py:9-17

@pytest.fixture(autouse=True)
def clean_sift_logger():
    """Restore the sift logger after every test."""
    logger = logging.getLogger("sift")
    handlers, level = logger.handlers[:], logger.level
    yield logger
    logger.handlers[:] = handlers
    logger.setLevel(level)
```

`setup_logging` 会替换 `sift` logger 的处理器并改级别，不恢复的话，下一个测试读到的就是被改过的全局状态。（pytest 自己的 `monkeypatch` 就是同一种写法：`yield mpatch` 之后调 `mpatch.undo()`，下面会看到。）

### 作用域是用时间换隔离

为什么 `mini_index` 不是函数作用域？我量了一下。脚本建 8 篇样本文章的索引，两个 fixture 做同一件事，一个每个测试建一次，一个整个会话建一次，各 200 个测试：

```python
"""What a fixture's scope costs: one index per test, or one in all."""

from pathlib import Path

import pytest

from sift.corpus import iter_documents
from sift.index import IndexWriter, InvertedIndex

MINI = Path("tests/fixtures/mini")


def build() -> InvertedIndex:
    """Return an index over the eight fixture posts."""
    index = InvertedIndex()
    with IndexWriter(index) as writer:
        for doc in iter_documents(MINI):
            writer.add(doc)
    return index


@pytest.fixture
def per_test() -> InvertedIndex:
    return build()


@pytest.fixture(scope="session")
def once() -> InvertedIndex:
    return build()


@pytest.mark.parametrize("n", range(200))
def test_function_scope(per_test: InvertedIndex, n: int) -> None:
    assert per_test.n_docs == 8


@pytest.mark.parametrize("n", range(200))
def test_session_scope(once: InvertedIndex, n: int) -> None:
    assert once.n_docs == 8
```

`$S/scopes/pytest.ini` 是那一项配置：

```ini
[pytest]
addopts = -p no:cacheprovider --no-header -q
```

交替跑五轮（先一个后另一个，轮流），看 pytest 自己报的总时间：

```bash
#!/usr/bin/env bash
# Alternate the two scopes, five rounds, and print pytest's own wall
# time for the 200 tests of each. Run from the repository root with
# S pointing at the scratch directory.
set -euo pipefail
for round in 1 2 3 4 5; do
    for name in function_scope session_scope; do
        printf '%-14s ' "$name"
        pytest -c "$S/scopes/pytest.ini" -k "$name" \
            "$S/scopes/test_scopes.py" | tail -1
    done
done
```

```text
$ bash $S/scopes/run.sh
function_scope 200 passed, 200 deselected in 1.74s
session_scope  200 passed, 200 deselected in 0.83s
function_scope 200 passed, 200 deselected in 1.69s
session_scope  200 passed, 200 deselected in 0.83s
function_scope 200 passed, 200 deselected in 1.83s
session_scope  200 passed, 200 deselected in 0.86s
function_scope 200 passed, 200 deselected in 1.74s
session_scope  200 passed, 200 deselected in 0.83s
function_scope 200 passed, 200 deselected in 1.76s
session_scope  200 passed, 200 deselected in 0.83s
```

函数作用域每轮 1.68 到 1.75 秒，会话作用域 0.82 到 0.86 秒，同一轮里差 0.82 到 0.91 秒，也就是每次建索引约 4.1 到 4.6 毫秒（200 次）。八篇样本都要这个价钱；第 9 篇量过，真实语料的 123 篇建一次索引要 2145 毫秒，所以 fixture 用 8 篇小样本，而且用 session 作用域。代价是 `mini_index` 的 docstring 写的那一句：测试只能读它，不能改。要往里加文档的测试自己建 `InvertedIndex`，比如 `tests/test_index.py` 里的：

```python
# tests/test_index.py:136-142
def test_add_refreshes_the_prefix_cache(mini_docs: list[Document]) -> None:
    index = InvertedIndex()
    assert index.terms_with_prefix("a") == []
    with IndexWriter(index) as writer:
        writer.add(mini_docs[1])
    assert "a" in index.terms_with_prefix("a")

```

## parametrize：一个函数，许多输入

同一个断言要对很多输入做，复制粘贴是最差的写法。`tests/test_markdown.py` 的 `strip_markdown` 测试这样写：

```python
# tests/test_markdown.py:38-56
@pytest.mark.parametrize(
    ("markdown", "plain"),
    [
        ("# Title", "Title"),
        ("### Deep heading", "Deep heading"),
        ("**bold** and __bold__", "bold and bold"),
        ("*it* and _it_", "it and it"),
        ("~~gone~~", "gone"),
        ("[text](https://example.com/x)", "text"),
        ("before ![alt](img.png) after", "before  after"),
        ("<https://example.com>", "https://example.com"),
        ("a <b>tag</b> b", "a tag b"),
        ("> quoted line", "quoted line"),
        ("snake_case_name stays", "snake_case_name stays"),
        ("2 * 3 * 4", "2 * 3 * 4"),
    ],
)
def test_strip_inline_syntax(markdown: str, plain: str) -> None:
    assert strip_markdown(markdown) == plain
```

装饰器的第一个参数是参数名元组，第二个是每组参数的列表。pytest 在收集测试的时候把它展开成 12 个独立的测试，各自通过或失败、各自可以被 `-k` 选中。测试名里方括号里的是 id，没有显式给 `ids=` 时，pytest 从值生成（`src/_pytest/python.py:1037-1056`，pytest 9.1.1）：字符串直接用，数字、布尔值用 `str`，枚举和有 `__name__` 的对象用名字，其余用参数名加序号：

```text
$ pytest -vv --no-header tests/test_markdown.py -k "strip_inline_syntax and (bold or snake)"
============================= test session starts ==============================
collecting ... collected 25 items / 23 deselected / 2 selected

tests/test_markdown.py::test_strip_inline_syntax[**bold** and __bold__-bold and bold] PASSED [ 50%]
tests/test_markdown.py::test_strip_inline_syntax[snake_case_name stays-snake_case_name stays] PASSED
[100%]

======================= 2 passed, 23 deselected in 0.68s =======================
```

多个参数的 id 用 `-` 连起来，所以 `[**bold** and __bold__-bold and bold]` 是第一组加第二组。短的字符串这样挺好，长一点或者含换行的就难读了，`tests/test_markdown.py` 的 `split_front_matter` 测试给了显式的 `ids=`：

```text
$ pytest -o addopts= --collect-only -q tests/test_markdown.py -k split_front_matter
tests/test_markdown.py::test_split_front_matter[basic]
tests/test_markdown.py::test_split_front_matter[empty]
tests/test_markdown.py::test_split_front_matter[none]
tests/test_markdown.py::test_split_front_matter[empty-text]
tests/test_markdown.py::test_split_front_matter[unclosed]
tests/test_markdown.py::test_split_front_matter[trailing]
tests/test_markdown.py::test_split_front_matter[late]

7/25 tests collected (18 deselected) in 0.69s
```

（我加了 `-o addopts=` 去掉仓库配置里的 `-q`，否则 `--collect-only -q` 只会打每个文件的计数。）含换行的字符串在 id 里被转义，下面是 `tests/test_frontmatter.py` 里把错误信息当参数的那个：

```text
$ pytest -vv --no-header tests/test_frontmatter.py -k "malformed and (duplicate or unsupported)"
============================= test session starts ==============================
collecting ... collected 18 items / 14 deselected / 4 selected

tests/test_frontmatter.py::test_malformed_input_raises[a: 1\na: 2-duplicate key 'a'] PASSED [ 25%]
tests/test_frontmatter.py::test_malformed_input_raises[a: {b}-unsupported syntax] PASSED [ 50%]
tests/test_frontmatter.py::test_malformed_input_raises[t: "\\q"-unsupported escape \\\\q] PASSED [
75%]
tests/test_frontmatter.py::test_malformed_input_raises[a: >+\n  x-unsupported block scalar header]
PASSED [100%]

======================= 4 passed, 14 deselected in 0.69s =======================
```

`a: 1\na: 2` 是真的换行，`\\q` 是 id 里转义过的反斜杠。后面一列是传给 `pytest.raises` 的 `match`，下面讲它是怎么用的。

## 内置 fixture：tmp_path、monkeypatch、capsys

大多数需要的东西 pytest 已经备好了，我在 Sift 里用到三个。

**`tmp_path`** 给每个测试一个独一无二的空目录，类型是 `pathlib.Path`。`tests/test_corpus.py` 测遍历语料的函数，需要真的有文件在磁盘上；`write_posts` 是文件里的一个小函数，把“文件名到内容”的字典写到目录下：

```python
# tests/test_corpus.py:23-38
def test_documents_come_in_sorted_path_order(tmp_path: Path) -> None:
    write_posts(
        tmp_path,
        {
            "b.md": GOOD.format(n=2),
            "a.md": GOOD.format(n=1),
            "sub/c.md": GOOD.format(n=3),
            "note.txt": "ignored",
        },
    )
    docs = list(iter_documents(tmp_path))
    assert [(d.doc_id, d.path.name) for d in docs] == [
        (0, "a.md"),
        (1, "b.md"),
        (2, "c.md"),
    ]
```

目录在哪、留多久，我用一个小测试看：两个测试各打印自己的 `tmp_path`，第二个还断言目录是空的（第一个往自己的目录里写了 `a.md`）：

```python
"""Where tmp_path lives and how long it stays."""

from pathlib import Path


def test_first(tmp_path: Path) -> None:
    (tmp_path / "a.md").write_text("x", encoding="utf-8")
    print(f"\nfirst : {tmp_path}")


def test_second(tmp_path: Path) -> None:
    print(f"\nsecond: {tmp_path}")
    assert list(tmp_path.iterdir()) == []
```

```text
$ cd $S/tmpdemo && pytest -s test_tmp_demo.py && ls $TMPDIR/pytest-of-$USER

first : /tmp/nix-shell.n6RpM2/pytest-of-bfmhno3/pytest-20/test_first0
.
second: /tmp/nix-shell.n6RpM2/pytest-of-bfmhno3/pytest-20/test_second0
.
2 passed in 0.67s
pytest-18
pytest-19
pytest-20
pytest-current
```

每个测试一个目录，名字是 `test_` 加测试名再加序号，放在 `pytest-N/` 下（路径里的 `nix-shell.XXXX` 是开发环境的 `TMPDIR`）。`N` 是这个开发环境会话里第几次运行 pytest；我在同一个会话里跑了很多次，所以序号已经是 20，而 `ls` 只剩 18、19、20 三个，更老的已经被删掉，也就是默认保留最近 3 次运行的目录；保留策略默认是 `all`，不管成败都留着（两个默认值在 `src/_pytest/tmpdir.py:257-273`，pytest 9.1.1）。

**`monkeypatch`** 临时替换一个属性、字典项或环境变量，测试结束自动还原。命令行测试要让 `sift search` 去搜 8 篇样本文章，而不是真的 `corpus/posts`，就把 `sift.__main__` 里的 `CORPUS` 换掉；**`capsys`** 拿走测试期间写到 stdout 和 stderr 的字节，`readouterr()` 返回 `(out, err)`：

```python
# tests/test_main.py:9-24
@pytest.fixture
def mini_cli(monkeypatch: pytest.MonkeyPatch, mini_root):
    """Point the CLI at the fixture posts instead of corpus/posts."""
    monkeypatch.setattr(cli, "CORPUS", mini_root)
    return cli


def test_search_prints_ranked_hits(
    mini_cli, capsys: pytest.CaptureFixture[str]
) -> None:
    mini_cli.dispatch(["search", "chain", "tool"])
    out = capsys.readouterr().out
    assert "bicycle-repair.md" in out
    assert "Fixing a bicycle chain" in out
    assert "[chain]" in out.lower()
    assert "1 hits in 8 files" in out
```

要换的是被使用方查找的那个名字：`dispatch` 在 `sift.__main__` 的命名空间里查 `CORPUS`，所以换 `cli.CORPUS`，不是 `sift.corpus` 里的什么。还原靠的是 fixture 末尾的那次 `undo()`（`src/_pytest/monkeypatch.py:60-62`，pytest 9.1.1），它按相反的顺序把每一项改动恢复（同一个文件的 407-412 行）。

`capsys` 同样是 `yield` 之后 `close()`，在 `src/_pytest/capture.py:1007-1031` 里，按它的 docstring，作用是拦截对 `sys.stdout` 和 `sys.stderr` 的写入。两个 fixture 都用“生成器加 teardown”的写法，和上一节我自己的 `clean_sift_logger` 是同一个模式。

## pytest.raises 与 match

测异常是否抛出，要说清楚两件事：抛的是哪个类，消息是什么。`tests/test_log.py` 的最后一个测试：

```python
# tests/test_log.py:46-48
def test_unknown_level_is_refused() -> None:
    with pytest.raises(ValueError, match="unknown log level: 'LOUD'"):
        setup_logging("LOUD")
```

`match` 是一个正则表达式，用 `re.search` 去找异常的字符串形式，不是相等比较，也不是 `fullmatch`（`src/_pytest/_code/code.py:776-791`，pytest 9.1.1；同一个函数里，如果你写的 `match` 恰好等于消息，它会提示你用 `re.escape()`）。

这个区别我用三个测试来看，一个对、两个错。第一个用 `LOUD` 去搜消息，找到了；第二个加了 `^`，消息以 `unknown` 开头，找不到；第三个期望 `KeyError`，实际抛的是 `ValueError`，那么 `raises` 不会吞掉别的异常，它原样冒出来，测试以那个 `ValueError` 失败：

```python
"""pytest.raises: the type, then the message as a regular expression."""

import pytest

from sift.log import setup_logging


def test_message_is_searched() -> None:
    with pytest.raises(ValueError, match="LOUD"):
        setup_logging("LOUD")


def test_anchored_pattern() -> None:
    # BAD: ^ anchors at the start, the message starts with "unknown"
    # error: AssertionError: Regex pattern did not match.
    with pytest.raises(ValueError, match="^LOUD"):
        setup_logging("LOUD")


def test_wrong_type() -> None:
    # BAD: setup_logging raises ValueError, not KeyError
    # error: ValueError: unknown log level: 'LOUD'
    with pytest.raises(KeyError):
        setup_logging("LOUD")
```

```text
$ cd $S/marks && pytest --tb=short test_raises_demo.py
.FF                                                                      [100%]
=================================== FAILURES ===================================
____________________________ test_anchored_pattern _____________________________
test_raises_demo.py:16: in test_anchored_pattern
    with pytest.raises(ValueError, match="^LOUD"):
         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
E   AssertionError: Regex pattern did not match.
E     Expected regex: '^LOUD'
E     Actual message: "unknown log level: 'LOUD'"
_______________________________ test_wrong_type ________________________________
test_raises_demo.py:24: in test_wrong_type
    setup_logging("LOUD")
~/Projects/sift/src/sift/log.py:23: in setup_logging
    raise ValueError(f"unknown log level: {level!r}")
E   ValueError: unknown log level: 'LOUD'
=========================== short test summary info ============================
FAILED test_raises_demo.py::test_anchored_pattern - AssertionError: Regex pattern did not match.
  Expected regex: '^LOUD'
  Actual message: "unknown log level: 'LOUD'"
FAILED test_raises_demo.py::test_wrong_type - ValueError: unknown log level: 'LOUD'
2 failed, 1 passed in 0.70s
```

这件事在 `tests/test_frontmatter.py` 里有一个真的用处。那个参数化测试把“预期的错误消息”当参数，传给 `match`：

```python
# tests/test_frontmatter.py:45-48
@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("a: [x", "unterminated inline list"),
# ...
# tests/test_frontmatter.py:62-65
)
def test_malformed_input_raises(text: str, message: str) -> None:
    with pytest.raises(FrontMatterError, match=message):
        parse_front_matter(text)
```

消息里有 `\q` 这样的字符的那一行，参数写的是 `r"unsupported escape \\q"`，因为 `match` 是正则，一个字面的反斜杠要写成 `\\`；上一节的输出里，id 里显示成 `\\\\q` 是 pytest 又转义了一次。（源码里 `if regexp == value` 那一行，会在你写的 `match` 恰好等于消息时提示你用 `re.escape()`。）

## 标记：slow、skipif 和 xfail

标记是贴在测试上的标签，`-m` 按标签选测试。`pytest.ini` 登记了一个 `slow`；`tests/test_corpus.py` 里读完整个真实语料的那一个测试用它，并且加了 `skipif`，语料还没下载时跳过而不是失败：

```python
# tests/test_corpus.py:92-97
@pytest.mark.slow
@pytest.mark.skipif(not CORPUS.is_dir(), reason="run `make corpus` first")
def test_full_corpus_parses_strictly() -> None:
    docs = list(iter_documents(CORPUS))
    assert len(docs) == 123
    assert len({d.title for d in docs}) > 100
```

```text
$ pytest -m slow -vv --no-header | tail -4

tests/test_corpus.py::test_full_corpus_parses_strictly PASSED            [100%]

====================== 1 passed, 312 deselected in 1.19s =======================
$ pytest -m "not slow" | tail -1
311 passed, 1 deselected, 1 xfailed in 4.99s
```

只选 `slow` 是 1 个、1.19 秒（读 123 个文件并严格解析）；排除它是 311 个通过、1 个 `xfailed`、1 个被取消选择，5 秒不到。

### xfail(strict=True)：一个已知的缺口

第 2 篇我就说过 `strip_markdown` 会弄坏行内代码里的尖括号。现在这件事有一个测试：

```python
# tests/test_markdown.py:78-83
@pytest.mark.xfail(
    strict=True,
    reason="known gap: the HTML-tag pass eats <u8> inside inline code",
)
def test_inline_code_with_angle_brackets() -> None:
    assert strip_markdown("use `Vec<u8>` here") == "use Vec<u8> here"
```

```text
$ pytest -rx tests/test_markdown.py -k angle_brackets
x                                                                        [100%]
=========================== short test summary info ============================
XFAIL tests/test_markdown.py::test_inline_code_with_angle_brackets - known gap: the HTML-tag pass
eats <u8> inside inline code
24 deselected, 1 xfailed in 0.68s
$ python3 -c 'from sift.markdown import strip_markdown as s; print(repr(s("use `Vec<u8>` here")))'
'use Vec here'
```

`Vec<u8>` 变成了 `Vec`。原因在 `strip_markdown` 先去掉 HTML 标签、后处理行内代码，`<u8>` 被当成标签吞掉了：

```python
# src/sift/markdown.py:10
_HTML_TAG = re.compile(r"</?[A-Za-z][^>]*>|<!--.*?-->")
# ...
# src/sift/markdown.py:40-41
    line = _HTML_TAG.sub("", line)
    line = _CODE_SPAN.sub(r"\1", line)
```

这个测试断言的是**正确**的行为，然后标上“我知道它现在会失败”。`xfail` 的好处是缺口被写进了套件，不会被忘掉；`strict=True` 的好处是反过来的：哪天有人修了它，这个测试意外通过，strict 模式把这个“意外通过”当成失败，逼着人去掉标记，而不是让它悄悄过期。我没有修这个缺口，修复需要决定 HTML 标签该不该先于行内代码处理，它会改变别的输出，不在这一篇的范围里。

strict 和不 strict 的区别，我用两个“其实已经能通过”的测试看：

```python
"""Marks: strict and lenient xfail, and a mark nobody registered."""

import pytest

from sift.markdown import strip_markdown


@pytest.mark.xfail(strict=True, reason="demo: this case already works")
def test_strict_xfail_that_passes() -> None:
    # BAD: marked as expected to fail, but it passes
    # error: [XPASS(strict)] demo: this case already works
    assert strip_markdown("call `parse()` now") == "call parse() now"


@pytest.mark.xfail(reason="demo: lenient xfail that passes")
def test_lenient_xfail_that_passes() -> None:
    # BAD: same mistake, but without strict it is only reported
    # error: none, the test is counted as xpassed
    assert strip_markdown("call `parse()` now") == "call parse() now"


# BAD: "slwo" is a typo for "slow", pytest only warns
# error: PytestUnknownMarkWarning: Unknown pytest.mark.slwo
@pytest.mark.slwo
def test_misspelled_mark() -> None:
    assert True
```

```text
$ cd $S/marks && pytest -rxX --tb=short test_marks_demo.py
FX.                                                                      [100%]
=================================== FAILURES ===================================
________________________ test_strict_xfail_that_passes _________________________
[XPASS(strict)] demo: this case already works
=============================== warnings summary ===============================
test_marks_demo.py:24
  /tmp/p10/scratch/marks/test_marks_demo.py:24: PytestUnknownMarkWarning: Unknown pytest.mark.slwo -
is this a typo?  You can register custom marks to avoid this warning - for details, see
https://docs.pytest.org/en/stable/how-to/mark.html
    @pytest.mark.slwo

-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=================================== XPASSES ====================================
=========================== short test summary info ============================
XPASS test_marks_demo.py::test_lenient_xfail_that_passes - demo: lenient xfail that passes
1 failed, 1 passed, 1 xpassed, 1 warning in 0.67s
```

严格的那个失败，原因是 `[XPASS(strict)]`；宽松的只被计成 `xpassed`（计数行里是 `1 failed, 1 passed, 1 xpassed`），摘要里多一行 `XPASS`。输出里还有一条我故意留的告警：第三个测试贴了一个拼错的标记 `slwo`，pytest 默认只是警告。`--strict-markers` 会让它变成收集时的错误：

```text
$ cd $S/marks && pytest --strict-markers test_marks_demo.py

==================================== ERRORS ====================================
_____________________ ERROR collecting test_marks_demo.py ______________________
'slwo' not found in `markers` configuration option
=========================== short test summary info ============================
ERROR test_marks_demo.py - Failed: 'slwo' not found in `markers` configuration option
!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!
1 error in 0.77s
```

Sift 的 `pytest.ini` 没有开 `--strict-markers`，所以今天写错 `@pytest.mark.slow` 只会得到一条警告，而那个测试也就悄悄地不再被 `-m "not slow"` 排除。这是个我没补的漏洞，放进练习。

### --lf：只重跑上次失败的

`pytest_features.sh` 里还演示了 `--lf` (last failed)。仓库里的测试都是绿的，所以脚本在 `out/ch10/scratch` 里放了一个一过一败的小文件：

```python
def test_passes():
    assert 1 + 1 == 2


def test_fails():
    got = [7, 6]
    # BAD: the expected order is wrong on purpose
    # error: AssertionError: assert [7, 6] == [6, 7]
    assert got == [6, 7]
```

```text
$ cd out/ch10/scratch && rm -rf .pytest_cache && pytest --tb=no -q | grep -E '^[.F]+ |failed'; \
    pytest --tb=no -q --lf | grep -E '^[.F]+ |failed'
.F                                                                       [100%]
1 failed, 1 passed in 0.68s
F                                                                        [100%]
1 failed in 0.67s
```

第一次两个测试都跑，第二次只剩上次失败的那一个。测试套件大了以后，改完一处先 `--lf`，比整个重跑省得多。

## unittest 与 doctest

标准库自带两套测试工具，pytest 都能跑。`unittest` 的写法是一个 `TestCase` 子类，`setUp` 在每个测试方法前执行，比较要用 `assertEqual` 这一族方法，因为它们需要知道你在比什么才能报告。同一个测试，我在 `lab/ch10/unittest_demo.py` 里写了两遍：

```python
# lab/ch10/unittest_demo.py:14-33 and 42-44
class TokenizeTests(unittest.TestCase):
    """The unittest version: a class, setUp and assert methods."""

    def setUp(self) -> None:
        """Run before every test method."""
        self.text = "Rust 所有权 and C++"

    def test_terms(self) -> None:
        self.assertEqual(
            tokenize(self.text), ["rust", "所有", "有权", "and", "c++"]
        )

    def test_empty(self) -> None:
        self.assertEqual(tokenize(""), [])

    def test_many_inputs_with_subtest(self) -> None:
        cases = {"ABC": ["abc"], "ﬁ": ["fi"], "索": ["索"], "...": []}
        for text, terms in cases.items():
            with self.subTest(text=text):
                self.assertEqual(tokenize(text), terms)
# ...
def test_terms() -> None:
    text = "Rust 所有权 and C++"
    assert tokenize(text) == ["rust", "所有", "有权", "and", "c++"]
```

`subTest` 做的是参数化的事：一个测试方法里的一个循环，每一轮独立报告。脚本自己用 `unittest.main(exit=False)` 把它跑起来，输出走 stderr，随后才是我打印的统计：

```text
$ python3 lab/ch10/unittest_demo.py
test_a_type_error (__main__.TokenizeTests.test_a_type_error) ... ok
test_empty (__main__.TokenizeTests.test_empty) ... ok
test_many_inputs_with_subtest (__main__.TokenizeTests.test_many_inputs_with_subtest) ... ok
test_terms (__main__.TokenizeTests.test_terms) ... ok

----------------------------------------------------------------------
Ran 4 tests in 0.000s

OK
unittest: wasSuccessful() = True
unittest: tests run = 4
pytest-style function called by hand: ok
```

同一个文件交给 pytest，两种写法都会被收集：5 个（4 个方法加一个裸函数），`subTest` 的 4 轮也被计数：

```text
$ pytest -o addopts= -v --no-header lab/ch10/unittest_demo.py
============================= test session starts ==============================
collecting ... collected 5 items

lab/ch10/unittest_demo.py::TokenizeTests::test_a_type_error PASSED       [ 20%]
lab/ch10/unittest_demo.py::TokenizeTests::test_empty PASSED              [ 40%]
lab/ch10/unittest_demo.py::TokenizeTests::test_many_inputs_with_subtest
lab/ch10/unittest_demo.py::TokenizeTests::test_many_inputs_with_subtest PASSED [ 60%]
lab/ch10/unittest_demo.py::TokenizeTests::test_terms PASSED              [ 80%]
lab/ch10/unittest_demo.py::test_terms PASSED                             [100%]

===================== 5 passed, 4 subtests passed in 0.68s =====================
```

我在 Sift 里没有用 `unittest` 写测试，原因就是上面这两段对比：同一个断言，pytest 版是一行裸 `assert`，失败时有第一节那份报告；`unittest` 版要先继承、再选对方法。但 `unittest` 里有一样东西我会单独用，就是下一节的 `mock`。

`doctest` 是另一回事：它把文档里的示例当测试。`>>>` 后面是输入，下面一行是期望的 `repr`，逐字比较。`snippet.py` 的 `make_snippet` 是这样写的：

```python
# src/sift/snippet.py:82-98
def make_snippet(text: str, terms: Collection[str], width: int = 160) -> Parts:
    """Return parts of text around the densest cluster of hits.

    terms are index terms (analyzed). The result is a list of
    ``(text, is_hit)`` pairs covering a window of about width
    characters; ``…`` marks a cut edge. With no hit, the window is
    the start of the text. Whitespace runs are collapsed to a space.

    >>> text = "The quick brown fox jumps over the lazy dog"
    >>> parts = make_snippet(text, {"fox"}, width=20)
    >>> parts[2]
    ('fox', True)
    >>> render_plain(parts)
    '…rown [fox] jumps over …'
    >>> make_snippet("one two", {"zebra"})
    [('one two', False)]
    """
```

找示例的是 `doctest.DocTestParser` 里的一个正则（`Lib/doctest.py:618-630`，v3.14.7）：`>>>` 开头是源码，其后没有空行、不以 `>>>` 开头的行是期望输出。

我写了一个脚本，用 `doctest.testmod` 在三个模块上跑，再用两段字符串演示指令和失败时的报告：

```text
$ python3 lab/ch10/doctest_demo.py
sift.scoring: TestResults(failed=0, attempted=9)
sift.snippet: TestResults(failed=0, attempted=10)
sift.query.ast: TestResults(failed=0, attempted=2)
--- directives: 3 examples
--- broken: 1 examples
**********************************************************************
Line 2, in broken
Failed example:
    1 + 1
Expected:
    3
Got:
    2
**********************************************************************
1 item had failures:
   1 of   1 in broken
***Test Failed*** 1 failure and 1 skipped test.
summary: TestResults(failed=1, attempted=4, skipped=1)
```

`attempted` 数的是 `>>>` 示例的条数（`sift.snippet` 是 10 条），而 `pytest --doctest-modules` 一个 docstring 记一个测试项：

```text
$ pytest -vv --no-header src/sift/snippet.py src/sift/query/ast.py
============================= test session starts ==============================
collecting ... collected 5 items

src/sift/snippet.py::sift.snippet.html PASSED                            [ 20%]
src/sift/snippet.py::sift.snippet.make_snippet PASSED                    [ 40%]
src/sift/snippet.py::sift.snippet.render_html PASSED                     [ 60%]
src/sift/snippet.py::sift.snippet.render_plain PASSED                    [ 80%]
src/sift/query/ast.py::sift.query.ast.print_query PASSED                 [100%]

============================== 5 passed in 0.71s ===============================
```

一个 docstring 一个项：`snippet.py` 4 个，`scoring.py` 4 个，`ast.py` 1 个，就是前面收集数字里 313 个中的 9 个（上面只列了两个文件的 5 个）。浮点数要小心：`scoring.py` 的示例写的是 `round(idf(1, 3), 4)` 和 `1.3863`，不是 `idf(1, 3)` 和一串 17 位的小数，因为 `repr` 要逐字相等：

```python
# src/sift/scoring.py:17-20
    >>> round(idf(1, 3), 4)
    1.3863
    >>> idf(3, 3) > 0
    True
```

doctest 适合短的、能当文档读的示例；要铺开写的断言、要用 fixture 的、要看失败细节的，不是它的事。

## unittest.mock：替换时钟

被测代码里有一个每次都变的值，比如耗时，就没法断言它。`mock.patch` 在 `with` 块里把一个名字换成假的，`Mock` 对象可以预先排好每次调用返回什么，还记住自己被怎么调用过。`util.timed` 用 `time.perf_counter` 打印耗时到 stderr，我让时钟依次返回 10.0 和 10.25：

```python
# lab/ch10/mock_demo.py:22-39
@timed
def work() -> int:
    """Return a value; timed prints how long this took."""
    return 42


def timed_with_a_fake_clock() -> None:
    """Show the decorator's output with a clock that jumps 0.25 s."""
    err = io.StringIO()
    clock = mock.Mock(side_effect=[10.0, 10.25])
    with (
        mock.patch("sift.util.time.perf_counter", clock),
        contextlib.redirect_stderr(err),
    ):
        value = work()
    print(f"value={value}, stderr={err.getvalue()!r}")
    print(f"clock calls: {clock.call_count}")
    clock.assert_called_with()
```

```text
$ python3 lab/ch10/mock_demo.py
value=42, stderr='work took 250.0 ms\n'
clock calls: 2
took_ms=125.0, hits=1
terms called 2 times: [call('tea ceremony'), call('river')]
autospec call: ['x']
TypeError: missing a required argument: 'text'
```

`work took 250.0 ms` 是精确的，时钟被调用了两次，一次进、一次出。`mock_demo.py` 里后面三个演示用同一种办法：把 `Searcher.search` 的耗时固定成 125.0，用 `wraps=` 监视一个真方法被调了几次，以及 `create_autospec`：它按真函数的签名生成假的，少传一个参数会像真函数一样报 `TypeError`（上面输出的最后一行）。对照一下，一个普通的 `Mock` 什么调用都肯接受：

```text
$ python3 -c 'from unittest import mock; mock.Mock()(); print("accepted")'
accepted
```

这里有一个容易漏看的地方：补丁的目标写的是 `"sift.util.time.perf_counter"`，不是 `"sift.util.perf_counter"`。`patch` 把点号路径拆成“目标”和“属性”，先导入目标，再对它 `setattr` (`Lib/unittest/mock.py:1623-1624`)，退出时再改回去（同一个文件的 1640-1648 行，v3.14.7）。拆路径的是这个函数：

```python
# Lib/unittest/mock.py:1684-1690 (v3.14.7)
def _get_target(target):
    try:
        target, attribute = target.rsplit('.', 1)
    except (TypeError, ValueError, AttributeError):
        raise TypeError(
            f"Need a valid target to patch. You supplied: {target!r}")
    return partial(pkgutil.resolve_name, target), attribute
```

目标 `sift.util.time` 是什么？

```text
$ python3 -c 'import time, sift.util; print(sift.util.time is time)'
True
```

它就是标准库的 `time` 模块本身。所以这个补丁改的是**全局的** `time.perf_counter`，`with` 块里所有人读到的时钟都是那个假的：如果块里有别的代码也读了时钟，`Mock` 排好的两个返回值就会被它们吃掉，`timed` 拿到的数字就不对。这个演示恰好没有，所以 `call_count` 是 2；套件里真要这么补，补丁块要尽可能窄。

## 基于性质的测试：hypothesis

前面所有测试都是我挑的输入：我想得到的边界、我想得到的坏例子。想不到的就测不到。基于性质的测试换一个问法：不写“这个输入应该得到那个输出”，写“对所有这类输入，这条关系都成立”，然后让 hypothesis 去生成输入。它生成的输入不是均匀随机的，会偏向小的、空的、重复的、边界上的值；一旦某个输入让性质不成立，它不会把那个又长又乱的输入扔给你，而是**缩小**它：反复删、换成更简单的值，直到找到一个再简化就不再失败的输入。

Sift 的 `tests/test_properties.py` 有 13 条性质：4 条管分词器（词不为空、偏移量能切回折叠后的文本、位置连续、起点不递减），1 条管查询语言的往返 `parse(print_query(node)) == node`，5 条对着 Python 的集合检查 `PostingList` 的 `&`、`|`、`-`，1 条拿手写的集合参考实现检查 `evaluate`，2 条管片段。

生成输入的是“策略”。分词器那几条用的是一个偏向有趣字符的文本策略：任意 Unicode 字符，再混进 ASCII、CJK、全角字符和会被 NFKC 改写的连字：

```python
# tests/test_properties.py:30-38
# Any text at all, with a bias toward the interesting scripts: ASCII,
# CJK, fullwidth forms and ligatures that NFKC rewrites.
TEXT = st.text(
    alphabet=st.one_of(
        st.characters(),
        st.sampled_from("abcXYZ019_+# \t\n搜索引擎全文ﬁＡ㎏…"),
    ),
    max_size=60,
)
# ...
# tests/test_properties.py:41-43
@given(TEXT)
def test_tokens_are_never_empty(text: str) -> None:
    assert all(token.text for token in iter_tokens(text))
```

查询的往返要先有 `print_query`，它是这一章加进 `query/ast.py` 的：只在语法需要的地方加括号，运算符全部写成单词。`_level`（`ast.py:62-72`，这里没贴）给每种节点一个优先级：`Or` 1、`And` 2、`Not` 3，其余 4；`_print` 在子节点的优先级比所需的低时套一层括号；`print_query` 带两个 doctest：

```python
# src/sift/query/ast.py:75-109
def _print(node: Node, least: int) -> str:
    """Print node, in parentheses if it binds looser than least."""
    match node:
        case Term(text):
            out = text
        case Prefix(text):
            out = f"{text}*"
        case Phrase(words):
            out = f'"{" ".join(words)}"'
        case Field(name, value):
            out = f"{name}:{_print(value, 4)}"
        case Or(left, right):
            out = f"{_print(left, 1)} OR {_print(right, 2)}"
        case And(left, right):
            out = f"{_print(left, 2)} AND {_print(right, 3)}"
        case Not(operand):
            out = f"NOT {_print(operand, 3)}"
        case _:
            assert_never(node)
    return out if _level(node) >= least else f"({out})"


def print_query(node: Node) -> str:
    """Return query text that parses back to node.

    Operators are spelled out and parentheses appear only where the
    grammar needs them: ``parse(print_query(node)) == node`` for every
    tree whose words the lexer reads back as one word each.

    >>> print_query(And(Term("a"), Or(Term("b"), Not(Prefix("c")))))
    'a AND (b OR NOT c*)'
    >>> print_query(Field("title", Phrase(("x", "y"))))
    'title:"x y"'
    """
    return _print(node, 1)
```

`print_query` 自己带两个 doctest，上一节算在那 9 个里。往返性质需要的策略是递归的：叶子是词、前缀、短语、字段，节点是 `And`、`Or`、`Not`，最多 8 片叶子；`has_positive` 过滤掉第 8 篇定义的“每个 `OR` 分支需要一个正向部分”的违例：

```python
# tests/test_properties.py:66-76
# A word the query lexer reads back as exactly one WORD token.
WORD = st.text(
    alphabet=st.characters(
        blacklist_categories=("Cs", "Cc", "Zs", "Zl", "Zp"),
        blacklist_characters='()"*',
    ),
    min_size=1,
    max_size=6,
).filter(
    lambda w: [t.kind for t in iter_query_tokens(w)] == [Kind.WORD, Kind.EOF]
)
# ...
# tests/test_properties.py:99-104
QUERIES = NODES.filter(has_positive)


@given(QUERIES)
def test_parse_inverts_print_query(node: Node) -> None:
    assert parse(print_query(node)) == node
```

`WORD` 的 `filter` 保证词被词法分析器读回来恰好是一个词，字符里不含括号、引号和星号。测试本身只有两行。`PostingList` 的策略是一个字典 `doc_id -> 位置`，每个集合运算对着 Python 的集合：

```python
# tests/test_properties.py:107-128
POSTING_LISTS = st.dictionaries(
    st.integers(min_value=0, max_value=40),
    st.lists(st.integers(0, 30), unique=True, max_size=5).map(
        lambda ps: tuple(sorted(ps))
    ),
    max_size=15,
).map(lambda d: PostingList(Posting(i, ps) for i, ps in d.items()))


@given(POSTING_LISTS, POSTING_LISTS)
def test_and_agrees_with_set_intersection(a, b) -> None:
    assert (a & b).doc_ids() == sorted(set(a.doc_ids()) & set(b.doc_ids()))


@given(POSTING_LISTS, POSTING_LISTS)
def test_or_agrees_with_set_union(a, b) -> None:
    assert (a | b).doc_ids() == sorted(set(a.doc_ids()) | set(b.doc_ids()))


@given(POSTING_LISTS, POSTING_LISTS)
def test_sub_agrees_with_set_difference(a, b) -> None:
    assert (a - b).doc_ids() == sorted(set(a.doc_ids()) - set(b.doc_ids()))
```

每条性质默认生成 100 个满足条件的输入，`--hypothesis-show-statistics` 把数字打出来（我只留了含 `passing examples` 的行，把 `invalid` 的计数去掉，再用 `sort | uniq -c` 合并成一行）：

```text
$ pytest --hypothesis-show-statistics tests/test_properties.py | grep 'passing examples' | sed \
    's/, [0-9]* invalid examples//' | sort | uniq -c
     13     - 100 passing examples, 0 failing examples
```

13 条，每条 100 个通过的例子、0 个失败。`invalid` 的计数我用 `sed` 去掉了，它在 0 到 17 之间：那是策略里的 `filter` 或 `assume` 丢掉的候选，比如 `QUERIES` 要过滤掉没有正向部分的树。这是 1,300 个我没有一个个挑过的输入。

### 它找到了 Sift 里的一个 bug

篇首那段输出就是它。先说这条性质检查什么：

```python
# tests/test_properties.py:206-216
@given(
    st.text(alphabet="aAbB \u0301\u00e9\ufb01\u2026\u00df\u1e9e", max_size=14),
)
def test_snippet_highlights_exactly_the_matching_words(text) -> None:
    # Latin words only and a window wider than the text: every hit is
    # one whole word, so folded it is one of the terms. The offset bug
    # in snippet.py (see test_snippet.py) broke this, for example for
    # "A", U+0301, "ﬁ": the hit was the accent plus the ligature.
    terms = set(tokenize(text))
    parts = make_snippet(text, terms, width=100)
    assert all(fold(shown) in terms for shown, hit in parts if hit)
```

文本只用拉丁字母、空格、重音符、`é`、连字 `ﬁ`、省略号，以及 `ß` 和 `ẞ`（最后这两个是后来才加的，下一小节讲），窗口宽得放得下整段文本，所以每个高亮片段是一个完整的词，折叠之后一定是某个词项。`make_snippet` 的毛病在偏移量上：`iter_tokens` 给的偏移量是**折叠后**文本（NFKC 加 `casefold`）里的，而片段要显示原文，所以 `_origin` 在折叠改变了长度时返回一张“折叠偏移到原文偏移”的表。修复之前它先折叠一次（下面 diff 里带减号的几行就是旧代码）：长度相等，就当偏移量没变。这个推理的漏洞是：NFKC 对不同的字符有的变长有的变短，加起来可以刚好抵消。一个连字 `ﬁ` (U+FB01) 折叠成两个字符 `fi`，一个字母加组合重音符 (U+0301) 折叠成一个预组合字符，两者各占一处，总长不变，而重音符之后每个字符的偏移量都挪了。`tests/test_snippet.py` 里本来有一个测试覆盖“长度变了”的情形（省略号 `…` 折叠成三个点），代码信了“长度相等就没变”这一条，没有任何测试去反驳它。

用一个脚本把三个文本的折叠、偏移量和片段打出来，先在修复之前的副本里跑，再在 `ch10` 里跑（第三个文本后面才用到，先放着）：

```python
"""Why equal lengths are not enough: fold() and offsets, two texts."""

from sift.analysis import iter_tokens, tokenize
from sift.analysis.tokenize import fold
from sift.snippet import make_snippet, render_plain

# U+0301 is a combining acute accent, U+FB01 is the ligature "fi" and
# U+00DF is the sharp s, which folds to "ss".
TEXTS = ["\ufb01\u0301", "A\u0301\ufb01", "a\u0301\u00df\u0301a"]


def main() -> None:
    """Print lengths, token offsets and the snippet of each text."""
    for text in TEXTS:
        folded = fold(text)
        print(f"text      {ascii(text)}  len {len(text)}")
        print(f"fold      {ascii(folded)}  len {len(folded)}")
        again = fold(folded)
        print(f"fold x2   {ascii(again)}  len {len(again)}")
        each = [len(fold(ch)) for ch in text]
        print(f"per char  {each}  sum {sum(each)}")
        spans = [(t.text, t.start, t.end) for t in iter_tokens(text)]
        print(f"tokens    {ascii(spans)}")
        parts = make_snippet(text, set(tokenize(text)))
        print(f"snippet   {ascii(render_plain(parts))}")
        print()


if __name__ == "__main__":
    main()
```

```text
$ pre python3 $S/bug/show_offset_bug.py | sed -n 1,14p
text      '\ufb01\u0301'  len 2
fold      'f\xed'  len 2
fold x2   'f\xed'  len 2
per char  [2, 1]  sum 3
tokens    [('f', 0, 1)]
snippet   '[\ufb01]\u0301'

text      'A\u0301\ufb01'  len 3
fold      '\xe1fi'  len 3
fold x2   '\xe1fi'  len 3
per char  [1, 1, 2]  sum 4
tokens    [('fi', 1, 3)]
snippet   'A[\u0301\ufb01]'
$ python3 $S/bug/show_offset_bug.py | sed -n 1,14p
text      '\ufb01\u0301'  len 2
fold      'f\xed'  len 2
fold x2   'f\xed'  len 2
per char  [2, 1]  sum 3
tokens    [('f', 0, 1)]
snippet   '[f]\xed'

text      'A\u0301\ufb01'  len 3
fold      '\xe1fi'  len 3
fold x2   '\xe1fi'  len 3
per char  [1, 1, 2]  sum 4
tokens    [('fi', 1, 3)]
snippet   '\xe1[fi]'
```

（输出用 `ascii()` 打印，否则组合重音符会和前一个字符叠在一起看不清。）第二个文本是 `A` 加 U+0301 加 `ﬁ`：折叠后是 `áfi`，三个字符，和原文等长；逐字折叠的长度是 1、1、2，和是 4，不等于整体折叠的 3，因为重音符和 `A` 合并了。词项 `fi` 的偏移量是 (1, 3)，落在原文的下标 1 和 2 上，而原文的下标 1 是重音符，所以修复之前高亮的是 `\u0301\ufb01` 两个字符，而不是 `\ufb01`。第一个文本是 hypothesis 缩出来的两字符例子，那里的词项只有 `f`，修复之前高亮了整个 `ﬁ`。

为什么词项只有 `f`，没有 `fí`？拉丁分词的正则只认 `[0-9a-z_]`，`í` 不在里面：

```text
$ python3 -c 'from sift.analysis import tokenize; print(tokenize("caf\u00e9"))'
['caf']
```

`café` 的词项是 `caf`。这不是这次的 bug，是分词器正则的取舍，我没有动它，也没有给它写测试。

hypothesis 是怎么找到它的？`--hypothesis-verbosity=verbose` 能看到它试过的每个输入，我用 `awk` 数到第一次失败为止，只打印那个位置和输入：

```text
$ pre pytest -q --no-header --hypothesis-verbosity=verbose -s tests/test_properties.py -k \
    highlights | awk \
    '/^    text=/{n++; t=$0} /^E       assert False/{print "example " n ":" t; exit}'
example 100:    text='éﬁ́',
```

它到第 100 个输入才第一次失败。统计信息补上其余的：

```text
$ pre pytest -q --no-header --hypothesis-show-statistics tests/test_properties.py -k highlights | \
    grep -A16 "Hypothesis Statistics"
============================ Hypothesis Statistics =============================
tests/test_properties.py::test_snippet_highlights_exactly_the_matching_words:

  - during generate phase (0.15 seconds):
    - Typical runtimes: < 1ms, of which < 1ms in data generation
    - 100 passing examples, 1 failing examples, 0 invalid examples
    - Found 1 distinct error in this phase

  - during shrink phase (0.05 seconds):
    - Typical runtimes: ~ 1-8 ms, of which < 1ms in data generation
    - 16 passing examples, 2 failing examples, 0 invalid examples
    - Tried 18 shrinks of which 1 were successful

  - Stopped because nothing left to do


=========================== short test summary info ============================
```

生成输入的那一轮报告 100 个通过、1 个失败，找到 1 个不同的错误；缩小的那一轮试了 18 次，只有 1 次成功，我猜是把 `é` 删掉，`'éﬁ́'` 变成 `'ﬁ́'`（输出里没有这一步的记录，这是我从两个输入推的）。注意 100 是默认的例子数：这个 bug 是在预算的最后一个输入上才被撞到的。hypothesis 说的“缩小”，按 `Shrinker` 的 docstring（`hypothesis/src/hypothesis/internal/conjecture/shrinker.py:147-153`，v6.156.1），是找一个 shortlex 更小的、仍然让测试失败的选择序列；shortlex 的通常意思是先比长度，长度相同再按字典序比。

修复是单独的一个提交，`9782c2c`。下面是它对 `_origin` 的改动（`git diff` 的前两个 hunk，后面的 hunk 是 doctest）：

```text
$ git diff -U1 ch09 a69014e -- src/sift/snippet.py | sed -n '5,/^     return text, table/p'
@@ -31,10 +31,12 @@ def _origin(text: str) -> tuple[str, list[int] | None]:
     offset in fold(text) where character i starts, plus the final
-    length, so a folded offset maps back with bisect. None means the
-    two texts have the same length and offsets are the same. If the
-    per-character folds do not add up to fold(text) (combining
+    length, so a folded offset maps back with bisect. None means that
+    every character folds to exactly one character and offsets are
+    the same. A text of equal length is not enough: ``"A\\u0301ﬁ"``
+    loses one character to composition and gains one to the ligature.
+    If the per-character folds do not add up to fold(text) (combining
     marks), the folded text itself is shown, with offsets as they are.
     """
-    folded = fold(text)
-    if len(folded) == len(text):
+    if text.isascii():
         return text, None
+    folded = fold(text)
     lengths = [_folded_len(ch) for ch in text]
@@ -43,2 +45,4 @@ def _origin(text: str) -> tuple[str, list[int] | None]:
         return folded, None
+    if all(length == 1 for length in lengths):
+        return text, None
     return text, table
```

偏移表在文本不是纯 ASCII 时总是先建出来；只有当每个字符恰好折叠成一个字符时才丢掉它。`table[-1] != len(folded)` 这个分支，修复之前只有整体长度变了才走得到，现在等长的文本也走得到：对 `A` 加 U+0301 加 `ﬁ`，逐字折叠的长度加起来是 4，整体折叠是 3，说明有字符和前一个字符合并了，这时不再试图映射，直接显示折叠后的文本。这就是回归测试断言 `á[fi]` 的原因：

```python
# tests/test_snippet.py:95-105
def test_equal_length_does_not_mean_equal_offsets() -> None:
    # Regression, found by hypothesis
    # (test_snippet_highlights_exactly_the_matching_words): "A" plus a
    # combining accent composes to one character and the ligature "ﬁ"
    # expands to two, so fold(text) has the length of text and yet
    # every offset after the accent moves. The hit must be "fi", not
    # the accent.
    text = "A\u0301\ufb01"
    parts = make_snippet(text, {"fi"})
    assert [t for t, hit in parts if hit] == ["fi"]
    assert render_plain(parts) == "á[fi]"
```

先在旧代码上跑，它失败：

```text
$ pre pytest -q --no-header --tb=short tests/test_snippet.py -k equal_length | grep -E "^E "
E   AssertionError: assert ['́ﬁ'] == ['fi']
E
E     At index 0 diff: '́ﬁ' != 'fi'
E
E     Full diff:
E       [
E     -     'fi',
E     ?      ^^
E     +     '́ﬁ',
E     ?      ^^
E       ]
```

（回归测试用的是三字符的例子，不是 hypothesis 缩出来的两字符例子，两者破坏的是同一个假设。）

### 第一个修复是不完整的

我当时以为到这里就完了。我想知道还有没有别的漏洞，第一个办法是加大搜索：把每条性质的例子数从 100 调到 2000。我写了一个只注册配置的 pytest 插件，放在 `$S/thorough` 里（里面还有一个后面要用的 `random100`）。`$MID` 是第一个修复完成时的整个仓库，也就是提交 `a69014e`，带着当时的测试和当时的性质：

```bash
MID=/tmp/p10/mid
mkdir -p $MID
git archive a69014e | tar -x -C $MID
ln -s ~/Projects/sift/corpus $MID/corpus
mid() { (cd $MID && PYTHONPATH=$MID/src:${EXTRA:-}:${PYTHONPATH#*:} "$@"); }
midsrc() { PYTHONPATH=$MID/src:${EXTRA:-}:${PYTHONPATH#*:} "$@"; }
```

```python
"""A pytest plugin that registers two hypothesis profiles.

Use it with ``-p thorough_profile --hypothesis-profile=NAME``.
"""

from hypothesis import HealthCheck, settings

# Many more examples than the default 100.
settings.register_profile(
    "thorough",
    max_examples=2000,
    deadline=None,
    derandomize=False,
    database=None,
    suppress_health_check=[HealthCheck.too_slow],
)

# The default 100 examples, random on every run, nothing saved.
settings.register_profile(
    "random100",
    max_examples=100,
    deadline=None,
    derandomize=False,
    database=None,
)
```

```text
$ EXTRA=$S/thorough mid pytest -p thorough_profile --hypothesis-profile=thorough \
    tests/test_properties.py -k highlights | tail -1
1 passed, 12 deselected in 1.37s
```

2000 个输入，通过。这是个错误的安慰：这份代码里还有一个我没发现的 bug。后来有人（不是 hypothesis）用暴力扫描找到了它。下面的脚本是我照那个办法写的：9 个字符的字母表，长度 0 到 6，共 597,871 个字符串，每个都检查和性质一样的东西。不是抽样，是全部：

```python
"""Brute-force sweep: every short string over a small alphabet.

Checks the same property as test_snippet_highlights_exactly_the_
matching_words, but for all strings instead of sampled ones. Which
sift gets imported (PYTHONPATH) decides which snippet.py is tested.
"""

from itertools import product

from sift.analysis import tokenize
from sift.analysis.tokenize import fold
from sift.snippet import make_snippet

# a, A, b, space, combining acute, e acute, fi ligature, ss, capital ss
ALPHABET = "aAb \u0301\u00e9\ufb01\u00df\u1e9e"
MAX_LEN = 6


def bad(text: str) -> bool:
    """Return True if some highlighted part is not a whole term."""
    terms = set(tokenize(text))
    parts = make_snippet(text, terms, width=100)
    return any(fold(shown) not in terms for shown, hit in parts if hit)


def main() -> None:
    """Count the failing strings and print the first two."""
    total = 0
    failing: list[str] = []
    for size in range(MAX_LEN + 1):
        for chars in product(ALPHABET, repeat=size):
            text = "".join(chars)
            total += 1
            if bad(text):
                failing.append(text)
    print(f"strings {total:,}, failing {len(failing):,}")
    for text in failing[:2]:
        print(f"  first failures: {ascii(text)}")


if __name__ == "__main__":
    main()
```

同一个脚本，分别在三份代码上跑：修复之前的副本、第一个修复之后的 `$MID`、`ch10`：

```text
$ pre python3 $S/sweep/sweep.py
strings 597,871, failing 36,563
  first failures: '\ufb01\u0301'
  first failures: 'a\u0301\ufb01'
$ mid python3 $S/sweep/sweep.py
strings 597,871, failing 3,412
  first failures: '\xdf\u0301\ufb01\u0301'
  first failures: '\u1e9e\u0301\ufb01\u0301'
$ python3 $S/sweep/sweep.py
strings 597,871, failing 0
```

36,563、3,412、0。第一个修复把失败的字符串减少了约 91%，没有减到 0。`sweep_mid` 的第一个失败是 `ß`、组合重音符、`ﬁ`、组合重音符这四个字符。把前面脚本里的第三个文本 `a`、U+0301、`ß`、U+0301、`a` 在第一个修复之后的代码和 `ch10` 里各跑一遍：

```text
$ mid python3 $S/bug/show_offset_bug.py | tail -8

text      'a\u0301\xdf\u0301a'  len 5
fold      '\xe1ss\u0301a'  len 5
fold x2   '\xe1s\u015ba'  len 4
per char  [1, 1, 2, 1, 1]  sum 6
tokens    [('ss', 1, 3), ('a', 4, 5)]
snippet   '\xe1ss[\u0301]a'
$ python3 $S/bug/show_offset_bug.py | tail -8

text      'a\u0301\xdf\u0301a'  len 5
fold      '\xe1ss\u0301a'  len 5
fold x2   '\xe1s\u015ba'  len 4
per char  [1, 1, 2, 1, 1]  sum 6
tokens    [('ss', 1, 3), ('a', 4, 5)]
snippet   '\xe1[ss]\u0301[a]'
```

`ß` 折叠成 `ss`，后面跟着一个组合重音符：逐字折叠的长度加起来是 6，整体折叠是 5，所以走进“显示折叠文本”那条分支。毛病在这条分支的下一步：`_hit_spans` 去给**这份已经折叠过一次的文本**分词，而分词会再折叠一次。折叠不是幂等的，输出里的 `fold x2` 一行就是把折叠过的文本再折叠一次：`ss` 后面的 U+0301 和 `s` 合成了 `ś`（U+015B），长度从 5 变成 4，偏移量又挪了。结果是高亮了孤零零的重音符 `[\u0301]`，而不是后面的 `a`。

修复在 `ch10`：`_hit_spans` 改成接收原文，只分一次词；偏移量本来就是折叠后文本里的，和显示的那份折叠文本一致。`_origin` 的 docstring 也把这件事写了下来：

```python
# src/sift/snippet.py:25-26, 36-51 and 54-65
def _origin(text: str) -> tuple[str, list[int] | None]:
    """Return the text to show and the offset table of its folding.
# ...
    If the per-character folds do not add up to fold(text) (combining
    marks), the folded text itself is shown: its offsets are exactly
    those iter_tokens reports for text, which must therefore be
    tokenized from text, never from the folded copy (folding twice
    is not idempotent: ``ss`` plus U+0301 composes on the second pass).
    """
    if text.isascii():
        return text, None
    folded = fold(text)
    lengths = [_folded_len(ch) for ch in text]
    table = list(accumulate(lengths, initial=0))
    if table[-1] != len(folded):
        return folded, None
    if all(length == 1 for length in lengths):
        return text, None
    return text, table
# ...
def _hit_spans(
    text: str, table: list[int] | None, terms: Collection[str]
) -> list[tuple[int, int]]:
    """Return disjoint (start, end) offsets in the shown text of hits.

    text is the original text, tokenized once; the offsets are into
    fold(text) and are mapped through table when there is one.
    """
    spans: list[tuple[int, int]] = []
    for token in iter_tokens(text):
        if token.text not in terms:
            continue
```

新的回归测试：

```python
# tests/test_snippet.py:108-116
def test_sharp_s_with_accent_is_tokenized_once() -> None:
    # Regression, found by a brute-force sweep after the fix above:
    # when the per-character folds do not add up (a combining mark
    # after a sharp s), the folded text is shown, and tokenizing that
    # copy folded it a second time ("ss" plus U+0301 composes).
    text = "a\u0301\u00df\u0301a"
    parts = make_snippet(text, {"a", "ss"})
    assert all(fold(shown) in {"a", "ss"} for shown, hit in parts if hit)
    assert "[\u0301]" not in render_plain(parts)
```

```text
$ midsrc pytest -q --no-header --tb=short tests/test_snippet.py -k sharp_s | grep -E "^E "
E   assert False
E    +  where False = all(<generator object
test_sharp_s_with_accent_is_tokenized_once.<locals>.<genexpr> at 0x7fffee7259a0>)
```

（上面是 `midsrc` 在 `$MID` 的代码上跑 `ch10` 的测试，所以它失败；`ch10` 上它通过。）性质本身也改了：字母表里加了 U+00DF 和 U+1E9E（大写 `ẞ`）。这才是这个故事的第二个教训：性质一直没变，是**生成器**的字母表里没有 `ß`，hypothesis 再努力也生成不出能触发它的字符串。字母表加上之后，同一条性质在 `$MID` 的代码上这样：

```text
$ midsrc pytest -q --no-header --tb=short tests/test_properties.py -k highlights | tail -1
.                                                                        [100%]
$ EXTRA=$S/thorough midsrc pytest -p thorough_profile --hypothesis-profile=thorough -q --no-header \
    --tb=short tests/test_properties.py -k highlights | grep -m1 -A2 Falsif
E   Falsifying example: test_snippet_highlights_exactly_the_matching_words(
E       text='ß́AÁ',
E   )
$ for i in 1 2 3 4 5; do EXTRA=$S/thorough midsrc pytest -p thorough_profile \
    --hypothesis-profile=random100 -q --no-header --tb=short tests/test_properties.py -k \
    highlights | grep -qm1 Falsifying && echo found || echo passed; done
found
passed
found
passed
found
```

`ci` 配置的 100 个固定输入仍然通过，也就是 CI 上默认的那一次运行在这份有 bug 的代码上是绿的；2000 个输入找到了 bug（`'ß́AÁ'`）；不固定种子的 100 个输入，五次里找到 3 次。所以我现在对 `ch10` 的信心有两个来源，而且都有限：暴力扫描在这 9 个字符、长度 6 以内是 0 个失败；性质在这个字母表里没找到。字母表之外的东西（别的会合成的字符、更长的文本），两个办法都没有看过。

结果：

```text
$ pytest -vv --no-header tests/test_snippet.py tests/test_properties.py -k \
    "equal_length or sharp_s or highlights"
============================= test session starts ==============================
collecting ... collected 32 items / 29 deselected / 3 selected

tests/test_snippet.py::test_equal_length_does_not_mean_equal_offsets PASSED [ 33%]
tests/test_snippet.py::test_sharp_s_with_accent_is_tokenized_once PASSED [ 66%]
tests/test_properties.py::test_snippet_highlights_exactly_the_matching_words PASSED [100%]

======================= 3 passed, 29 deselected in 1.00s =======================
```

### 配置：ci 与 default

hypothesis 的配置是一组命名的 profile。我在 `CI=true` 下问它当前用哪个，再把 `CI` 去掉问一遍：

```python
"""Print the hypothesis settings profile that is active right now."""

from hypothesis import settings


def main() -> None:
    """Print the profile name and the four settings that matter here."""
    current = settings()
    print(f"profile      {settings.get_current_profile_name()}")
    print(f"max_examples {current.max_examples}")
    print(f"derandomize  {current.derandomize}")
    print(f"deadline     {current.deadline}")
    print(f"database     {current.database}")


if __name__ == "__main__":
    main()
```

```text
$ python3 $S/profile/show_profile.py
profile      ci
max_examples 100
derandomize  True
deadline     None
database     None
$ env -u CI python3 $S/profile/show_profile.py
profile      default
max_examples 100
derandomize  False
deadline     0:00:00.200000
database     DirectoryBasedExampleDatabase(PosixPath('~/Projects/sift/.hypothesis/examples'))
```

两个配置的例子数都是 100。差别在三处：`ci` 把 `derandomize` 打开、去掉了数据库、去掉了 200 毫秒的截止时间。切换发生在 hypothesis 导入时，条件是环境变量里有没有 CI 的标记：

```python
# hypothesis/src/hypothesis/_settings.py:392-393 and 409-413 (v6.156.1)
_CI_VARS = {
    "CI": None,  # various, including GitHub Actions, Travis CI, and AppVeyor
# ...
def is_in_ci() -> bool:
    return any(
        key in os.environ and (value is None or os.environ[key] == value)
        for key, value in _CI_VARS.items()
    )
```

`_settings.py:1211-1223` 是切换本身：`ci` 配置在那里定义（`derandomize=True`、`deadline=None`、`database=None`、`print_blob=True`），模块末尾的 `if is_in_ci(): settings.load_profile("ci")` 在导入时执行。

注意 `"CI": None`：值是 `None` 表示只要变量存在就算，不看内容；另外 `GITHUB_ACTIONS`（值要等于 `"true"`）也在表里，所以 GitHub Actions 的 runner 上不管 `CI` 怎么设，都是 `ci` 配置。（我在 Actions 的日志里看不到 profile 那行，因为 `pytest.ini` 里有 `-q`，头部不打印，这一点是我从源码推的。）

`derandomize` 的意思是：不用随机种子，从测试函数本身派生出一个固定的种子，每次生成的输入序列一样。我用一个探针来看，它记下生成的全部输入，打印这个列表的摘要：

```python
"""Do two runs of the same property see the same generated inputs?"""

import hashlib

from hypothesis import given, settings
from hypothesis import strategies as st

seen: list[str] = []


@given(st.text(max_size=8))
def probe(text: str) -> None:
    seen.append(text)


def main() -> None:
    """Run the probe once and print a digest of what it was fed."""
    probe()
    digest = hashlib.sha1(repr(seen).encode()).hexdigest()[:10]
    name = settings.get_current_profile_name()
    print(f"{name:8} {len(seen)} examples, digest {digest}")


if __name__ == "__main__":
    main()
```

```text
$ cd $S/profile && for i in 1 2; do python3 examples_probe.py; done
ci       100 examples, digest 07bc41edd2
ci       100 examples, digest 07bc41edd2
$ cd $S/profile && for i in 1 2; do env -u CI python3 examples_probe.py; done
default  100 examples, digest 2b04649685
default  100 examples, digest 9a8bbf7727
```

`ci` 配置下两次摘要一样，`default` 下每次都不同。这是个取舍：`ci` 让一次红色的 CI 能在本地原样重现，不会因为运气红一次绿一次；代价是 CI 永远在检查同一批输入，**不会再发现新的 bug**。默认配置的随机性才是在探索，它还带着一个示例数据库（`.hypothesis/examples`，上面输出里的路径），用来记住失败的输入。所以我给自己留一个习惯：偶尔把 `CI` 去掉，在本地跑几遍性质：

```text
$ for i in 1 2 3 4 5; do env -u CI pytest tests/test_properties.py | tail -1; done
13 passed in 4.73s
13 passed in 4.84s
13 passed in 4.77s
13 passed in 5.06s
13 passed in 4.78s
```

五次随机的运行，每次 13 条、每条 100 个新输入，全部通过。

### 一个失败是测试自己的错

另一条性质失败，不是代码的错。我最初把集合律写成“差集加交集等于原集合”。仓库里留下的是改过之后的版本，所以下面是我把当时的写法重新写成的一个独立测试文件：

```python
"""My first version of a set law for PostingList, which was wrong."""

from hypothesis import given
from test_properties import POSTING_LISTS


@given(POSTING_LISTS, POSTING_LISTS)
def test_difference_plus_intersection_is_a(a, b) -> None:
    # BAD: & merges the positions of b into every posting it keeps
    # error: AssertionError: assert PostingList(...) == PostingList(...)
    assert (a - b) | (a & b) == a
```

```text
$ cd $S/setlaw && PYTHONPATH=~/Projects/sift/tests:$PYTHONPATH pytest --tb=short \
    test_set_law_mistake.py | grep -E "^E "
E   assert PostingList([...itions=(0,))]) == PostingList([...ositions=())])
E
E     Full diff:
E     - PostingList([Posting(doc_id=0, positions=())])
E     + PostingList([Posting(doc_id=0, positions=(0,))])
E     ?                                           ++
E   Falsifying example: test_difference_plus_intersection_is_a(
E       a=PostingList([Posting(doc_id=0, positions=())]),
E       b=PostingList([Posting(doc_id=0, positions=(0,))]),
E   )
E
E   You can reproduce this example by temporarily adding @reproduce_failure('6.156.1',
b'AAFBAAAAAUEAAUEAAAA=') as a decorator on your test case
```

hypothesis 缩出来的例子很小：`a` 里有一个没有位置的 posting，`b` 里同一个 `doc_id` 带位置 `(0,)`。`a - b` 是空的，`a & b` 保留了这个文档，而且按 `PostingList` 的文档所说，`&` 对两边都有的文档取位置的并集，所以它带上了 `b` 的 `(0,)`，结果和 `a` 不相等。代码没错，我写错了期望：`&` 保留的不是 `a` 的 posting，是合并后的。这个事实在 `tests/test_index.py` 里本来就有一个单元测试，我没想起来：

```python
# tests/test_index.py:71-76
def test_both_sides_merge_their_positions() -> None:
    a = plist(d1=(0, 4))
    b = plist(d1=(2, 4))
    assert (a & b)[0].positions == (0, 2, 4)
    assert (a | b)[0].positions == (0, 2, 4)

```

最后留在仓库里的 `test_set_laws` 只比较 `doc_id`：

```python
# tests/test_properties.py:143-148
@given(POSTING_LISTS, POSTING_LISTS)
def test_set_laws(a, b) -> None:
    assert (a & b).doc_ids() == (b & a).doc_ids()
    assert (a | b).doc_ids() == (b | a).doc_ids()
    assert ((a - b) | (a & b)).doc_ids() == a.doc_ids()
    assert not set((a - b).doc_ids()) & set(b.doc_ids())
```

另有一条 `test_merged_positions_are_the_sorted_union` 专门说位置。性质测试失败时先问是代码错还是性质错，缩小之后的例子通常两三行就够回答。（那个缩出来的 `positions=()` 是我的策略允许的；只要 `b` 里有位置，结论就一样。）

### 缩小的样子：一个有意埋的 bug

要看缩小本身，不必等 Sift 出 bug，我埋一个。`lab/ch10/hypothesis_found_bug.py` 里的 `merge_sorted`（14-33 行）合并两个有序表时，相等的头元素只留一份；性质（50-60 行）是“结果等于 `sorted(a + b)`”：

```text
$ python3 lab/ch10/hypothesis_found_bug.py
buggy merge_sorted: property failed
Falsifying example: check(
    a=[0],
    b=[0],
)
property calls, generating and shrinking: 61
last call: merge_sorted([0], [0]) = [0]
fixed merge_sorted: 200 examples, all passed
```

它缩到了 `a=[0]`、`b=[0]`：最小的、两边相等的输入。生成加缩小一共调用了 61 次性质函数，最后一次调用打印出 `merge_sorted([0], [0]) = [0]`，少了一个 0；修好之后的版本 200 个例子全过。

## 覆盖率

覆盖率回答的问题是：测试跑过的时候，源码的哪些行被执行了。`pytest-cov` 是 `coverage.py` 的 pytest 插件，`Makefile` 里是一个目标：

```make
# Makefile:23-27
test:
	pytest

cov:
	pytest --cov=sift --cov-report=term-missing
```

```text
$ make cov | grep -vE '^src.* 100%'
pytest --cov=sift --cov-report=term-missing
........................................................................ [ 23%]
........................................................................ [ 46%]
...x.................................................................... [ 69%]
........................................................................ [ 92%]
.........................                                                [100%]
================================ tests coverage ================================
_______________ coverage: platform linux, python 3.14.7-final-0 ________________

Name                              Stmts   Miss  Cover   Missing
---------------------------------------------------------------
src/sift/__main__.py                 92      1    99%   144
src/sift/document.py                 46      1    98%   44
---------------------------------------------------------------
TOTAL                              1160      2    99%
312 passed, 1 xfailed in 5.50s
```

1,160 条语句，2 条没跑到，99%（表里 100% 的 22 行我用 `grep` 去掉了）。哪两条：

```python
# src/sift/__main__.py:143-144
if __name__ == "__main__":
    main()
```

```python
# src/sift/document.py:41-44
    for number, line in enumerate(front.splitlines(), 2):
        if line.startswith(f"{key}:"):
            return number
    return 1
```

第一条是 `if __name__ == "__main__":` 下的 `main()`，测试调的是 `dispatch`，从不把模块当脚本跑；第二条是行号查找的兜底：front matter 里找不到那个键，就报第 1 行，没有测试构造这样的文件。我没有为凑 100% 去补这两个。`python3 -m sift` 本身不是没人检查：第 1 篇的基准实验每次 CI 都会用它搜 `kalman`（CI 一节的日志里有），它只是不在 pytest 的覆盖统计里。

默认只数“语句执行过没有”。加上 `--cov-branch`，还数每个分支的两个方向都走过没有：

```text
$ pytest --cov=sift --cov-branch --cov-report=term-missing | grep -E \
    "^(Name|TOTAL)|[0-9]+ +[0-9]+ +[0-9]+ +[0-9]+ +[0-9]+%" | grep -v " 100%"
Name                              Stmts   Miss Branch BrPart  Cover   Missing
src/sift/__main__.py                 92      1     22      1    98%   144
src/sift/document.py                 46      1     12      1    97%   44
src/sift/search.py                   69      0     26      2    98%   97->90, 100->90
src/sift/snippet.py                  90      0     42      1    99%   156->150
TOTAL                              1160      2    406      5    99%
```

（我用 `grep` 去掉了 100% 的行。）406 条分支里有 5 条只走了一边，总数仍然是 99%。`snippet.py:156->150` 和 `search.py:97->90` 是 `match` 里最后一个 `case` 之后“一个都不匹配”、回到循环头的那条边（`search.py:97` 是 `case Prefix(text):`，`snippet.py:156` 是 `html` 里最后一个 `case`），`search.py:100->90` 是 `if tokens:` 为假、回到循环头的那一边。

覆盖率只说明一行被执行过，没说明它被检查过：一个只调用函数、什么都不断言的测试，同样会让那些行变绿。这个 99% 里，性质测试和 doctest 也有份，我没有把它们拆开算。

## pytest-benchmark：测时间的测试

性能也是一种行为，但它不能写成 `assert time < 0.1`，机器一忙就红。`pytest-benchmark` 的做法是一个 `benchmark` fixture：把要测的函数交给它，它自己校准每轮跑多少次、一共跑几轮，最后报统计量。`lab/ch10/bench_tokenize.py` 对第 7 篇的分词流水线做了四个基准：

```python
# lab/ch10/bench_tokenize.py:23-58
def sample_text() -> str:
    """Return about 100 KB of text: posts if present, else fixtures."""
    root = POSTS if POSTS.is_dir() else MINI
    parts: list[str] = []
    size = 0
    for path in sorted(root.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        parts.append(text)
        size += len(text)
        if size > 100_000:
            break
    return "\n".join(parts)


@pytest.fixture(scope="module")
def text() -> str:
    """Return the benchmark input, built once per module."""
    return sample_text()


def test_tokenize_to_list(benchmark, text: str) -> None:
    terms = benchmark(tokenize, text)
    assert terms


def test_iter_tokens_consumed(benchmark, text: str) -> None:
    def consume() -> int:
        return sum(1 for _ in iter_tokens(text))

    assert benchmark(consume) > 0


def test_default_pipeline_terms(benchmark, text: str) -> None:
    pipeline = build_pipeline()
    assert benchmark(pipeline.terms, text)

```

它放在 `lab/` 下而不是 `tests/`，所以普通的 `pytest` 不会收集它，要显式给路径，`extra.sh` 就是这么做的。轮数的选择在 `src/pytest_benchmark/fixture.py:209-221` (pytest-benchmark v5.2.3)：先用一次校准的耗时 `duration`，轮数是 `ceil(max_time / duration)`，但不少于 `min_rounds`。

`--benchmark-max-time=0.2` 下，慢的函数轮数少，下限是 `min_rounds`（默认 5）；下面输出的 `Rounds` 一列是 16、7、6、5。输入是什么，用一个脚本数一下：

```python
"""How much text does bench_tokenize.py feed the tokenizer?"""

import sys

sys.path.insert(0, "lab/ch10")

from bench_tokenize import sample_text  # noqa: E402

from sift.analysis import build_pipeline, tokenize  # noqa: E402


def main() -> None:
    """Print the sample size and the term count of three analyzers."""
    text = sample_text()
    latin = build_pipeline(["latin", "nfkc"])
    print(f"characters      {len(text):>8,}")
    print(f"bytes (UTF-8)   {len(text.encode()):>8,}")
    print(f"tokenize        {len(tokenize(text)):>8,} terms")
    print(f"default         {len(build_pipeline().terms(text)):>8,} terms")
    print(f"latin + nfkc    {len(latin.terms(text)):>8,} terms")


if __name__ == "__main__":
    main()
```

```text
$ python3 $S/bench/sample_size.py
characters       101,250
bytes (UTF-8)    164,171
tokenize          31,197 terms
default           31,197 terms
latin + nfkc       7,553 terms
```

约 10 万字符（语料前面若干篇拼起来）。基准的结果，列是最小、平均、中位数、最大和轮数，单位毫秒：

```text
$ pytest lab/ch10/bench_tokenize.py --benchmark-only \
    --benchmark-columns=min,mean,median,max,rounds --benchmark-max-time=0.2 --benchmark-disable-gc \
    | grep -E '^(Name|test_)'
Name (time in ms)                      Min               Mean             Median                Max
Rounds
test_latin_only_pipeline_terms     11.5193 (1.0)      12.0960 (1.0)      11.9461 (1.0)      13.3294
(1.0)          16
test_iter_tokens_consumed          30.2611 (2.63)     31.0487 (2.57)     31.2658 (2.62)     31.5706
(2.37)          7
test_tokenize_to_list              31.7855 (2.76)     32.3438 (2.67)     32.4341 (2.72)     32.9307
(2.47)          6
test_default_pipeline_terms        38.0976 (3.31)     39.6724 (3.28)     39.6734 (3.32)     40.5870
(3.04)          5
```

怎么比两个数？`extra.sh` 里的默认是一次调用，每个测试各跑一遍。我在外面再套了一层：脚本调用三次 pytest，每次跑完四个测试，所以三次调用是 A、B、C、D、A、B、C、D……地交替；另外先扔掉一次预热。我的第一版脚本没有预热，第一轮 `test_tokenize_to_list` 是 84.69 毫秒，之后两轮是 32.63 和 31.21，这是我说的“空闲之后的第一次”慢了 2.6 倍的一个例子（那次的输出我没有留，数字是从当时的终端抄下来的）；加了预热之后：

```python
"""Run lab/ch10/bench_tokenize.py three times and tabulate the means.

Every invocation times the four tests in turn, so the runs alternate
A, B, C, D, A, B, C, D, ... A first invocation is thrown away (warm-up).
Run it from the repository root.
"""

import json
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

RUNS = 3
FILE = "lab/ch10/bench_tokenize.py"


def run_once(out: Path) -> dict[str, dict[str, float]]:
    """Run the benchmarks once and return stats keyed by test name."""
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            FILE,
            "-q",
            "-p",
            "no:cacheprovider",
            "--benchmark-only",
            "--benchmark-max-time=0.2",
            "--benchmark-disable-gc",
            f"--benchmark-json={out}",
        ],
        check=True,
        capture_output=True,
    )
    data = json.loads(out.read_text())
    return {b["name"]: b["stats"] for b in data["benchmarks"]}


def main() -> None:
    """Print mean per run and the mean of the means, in ms."""
    with tempfile.TemporaryDirectory() as tmp:
        run_once(Path(tmp) / "warmup.json")
        runs = [run_once(Path(tmp) / f"{i}.json") for i in range(RUNS)]
    print(f"{'test':32} {'run 1':>8} {'run 2':>8} {'run 3':>8} {'mean':>8}")
    for name in runs[0]:
        means = [run[name]["mean"] * 1000 for run in runs]
        cells = " ".join(f"{m:8.2f}" for m in means)
        print(f"{name:32} {cells} {statistics.mean(means):8.2f}")
    rounds = [run[name]["rounds"] for run in runs for name in run]
    print(f"rounds per test: min {min(rounds)}, max {max(rounds)}")


if __name__ == "__main__":
    main()
```

```text
$ python3 $S/bench/run_bench.py
test                                run 1    run 2    run 3     mean
test_tokenize_to_list               31.38    32.34    32.86    32.19
test_iter_tokens_consumed           30.67    31.17    31.34    31.06
test_default_pipeline_terms         40.72    41.05    41.47    41.08
test_latin_only_pipeline_terms      12.27    12.11    11.85    12.08
rounds per test: min 5, max 18
```

三次调用的平均值：`tokenize` 32.19 毫秒，`iter_tokens` 31.06 毫秒，默认流水线 41.08 毫秒，拉丁语加 NFKC 的流水线 12.08 毫秒。`iter_tokens` 在三轮里每次都比 `tokenize` 低 0.7 到 1.5 毫秒，约 3%；我只有三轮，不敢说这是真的差。最后一个比其余的快 2.6 到 3.4 倍，但这不是它的单个词项更快：输入里有 31,197 个词项，拉丁语流水线只产出 7,553 个（CJK 二元组被它丢了），平均每个词项分别是 1.32 微秒（默认）和 1.60 微秒（拉丁语），后者其实更慢。

## CI：GitHub Actions 加 Nix

本地绿了不算，要有一台干净的、不是我的机器从零把一切跑一遍。工作流文件很短：

```yaml
# .github/workflows/ci.yml
name: ci

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  ci:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v5
      - uses: cachix/install-nix-action@v31
      - name: Fetch the corpus, then lint, test and run the labs
        run: nix develop --command make corpus ci
```

只有一个任务、三个步骤。触发条件是推到 `main`、对 `main` 的 PR、或手动；`permissions: contents: read` 把令牌的权限收到只读；`timeout-minutes: 45` 防止卡死烧钱。第一步 `actions/checkout@v5` 取代码，第二步 `cachix/install-nix-action@v31` 在 runner 上装 Nix，第三步 `nix develop --command make corpus ci`：进入和我本地同一个开发环境（Python 3.14.7、pytest、hypothesis 都是 `flake.lock` 钉死的版本），先 `make corpus` 按固定的提交把 123 篇文章取下来（语料不进仓库，因为文章是 CC BY-NC-SA，仓库是 MIT/Apache），然后 `make ci`，也就是 `ruff` 检查、`pytest`、再把每一章的实验都跑一遍。

两个版本号我要交代。`cachix/install-nix-action` 用的是 `v31`，是最新的大版本，我现在用 `gh api` 查：

```text
$ gh api repos/actions/checkout/releases/latest --jq .tag_name; gh api \
    repos/cachix/install-nix-action/releases/latest --jq .tag_name
v7.0.1
v31.11.2
```

`actions/checkout` 我钉在 `v5`，而最新的发布是 v7.0.1。`v5` 不是废弃的版本：

```text
$ gh api repos/actions/checkout/releases --jq '.[0:4][]|.tag_name+" "+.published_at'
v7.0.1 2026-07-20T15:10:05Z
v6.1.0 2026-07-20T15:23:28Z
v5.1.0 2026-07-20T15:27:58Z
v4.4.0 2026-07-20T15:36:10Z
```

v5.1.0 和 v7.0.1 是同一天发的，所以那一天 `v5` 这条线还在出版本，但它的确不是最新的；我没有试过 `v6` 和 `v7`，不知道升级会不会改变什么，也不想让这一章的绿色运行建立在一个我没验证的升级上。另外 `@v5` 是一个会移动的标签，不是提交哈希；要更严，该钉哈希。

这个标签对应的那次运行，我用 `gh run view` 取（下面命令里的 `$R` 是 `bfmhno3/sift`，`$J` 是任务 id `120075387367`，日志存在 `$S/ci.log`）：

```text
$ gh run view 39850599587 -R $R

✓ main ci · 39850599587
Triggered via push about 15 minutes ago

JOBS
✓ ci in 3m40s (ID 120075387367)

ANNOTATIONS
- "The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026. For more
information, see https://github.com/actions/runner-images/issues/14748"
ci: .github#1


For more information about the job, try: gh run view --job=120075387367
View this run on GitHub: https://github.com/bfmhno3/sift/actions/runs/39850599587
```

任务 `ci` 用了 3 分 40 秒，成功。这个运行对应的提交就是 `ch10` 标签指向的提交：

```text
$ gh run view 39850599587 -R $R --json headSha --jq .headSha; git rev-parse ch10^{commit}
e0cc29a4c2ac04307199cd1e33f2ee842c46f845
e0cc29a4c2ac04307199cd1e33f2ee842c46f845
```

（上面输出里 “about 15 minutes ago” 是我取输出时的时间，现在读到它会不一样。）底下那条注释是 GitHub 的通知：`ubuntu-latest` 从 2026 年 10 月 19 日起开始迁到 Ubuntu 26；这次运行的镜像还是 `ubuntu-24.04`（日志里的 `Image:` 一行），我没在 Ubuntu 26 上试过。

3 分 40 秒花在哪？先把日志存下来，再把几个标志行的时间拿出来：

```text
$ gh run view --job=$J -R $R --log > $S/ci.log; wc -l < $S/ci.log
1555
$ grep -E "ruff format|All checks|passed,|Run nix" $S/ci.log | cut -f3-
2026-10-22T20:38:35.6861458Z ##[group]Run nix develop --command make corpus ci
2026-10-22T20:39:35.5970686Z ruff format --check --line-length 79 .
2026-10-22T20:39:35.6278390Z All checks passed!
2026-10-22T20:39:41.5918697Z 312 passed, 1 xfailed in 5.32s
2026-10-22T20:42:02.3561682Z 312 passed, 1 xfailed in 4.25s
```

```text
$ grep -c 'copying path' $S/ci.log; grep 'copying path' $S/ci.log | cut -f3 | cut -c1-28 | sed -n \
    '1p;$p'
707
2026-10-22T20:38:35.8377170Z
2026-10-22T20:39:33.1956993Z
$ grep -E 'chapter.py ch(01|10)|ok   lab/ch(01|10)/extra' $S/ci.log | cut -f3 | cut -c1-70
2026-10-22T20:39:41.6897852Z python3 scripts/chapter.py ch01
2026-10-22T20:40:33.2956767Z ok   lab/ch01/extra.sh
2026-10-22T20:41:32.5327952Z python3 scripts/chapter.py ch10
2026-10-22T20:42:06.9792178Z ok   lab/ch10/extra.sh
```

从 20:38:30（作业开始）到 20:38:35（开始 `nix develop`），取代码和装 Nix 一共约 5 秒；接着到 20:39:33，花了约 1 分钟从 `cache.nixos.org` 下载日志里 `copying path` 出现的那 707 个路径；`ruff` 不到 0.1 秒；`pytest` 5.32 秒，几乎和我本地一样；剩下的约 2 分 25 秒是 `make ci` 里的各章实验。第 1 篇的实验用了 52 秒（20:39:41 到 20:40:33），第 10 篇自己的实验占 34 秒（20:41:32 到 20:42:06），因为 `extra.sh` 里又跑了一遍覆盖率和基准。真正的测试是 5 秒，在 CI 的 3 分 40 秒里只占 2.4%，其余是装环境和重放前面九篇的实验（某种意义上，每次提交现在都会把前九篇文章重读一遍）。这个比例我不想改：CI 的目的就是让每篇文章里的每个实验都保持能跑。

CI 没有缓存 Nix 的存储，每次都重新下载这 1 分钟。我没有加缓存：1 分钟对一个教程仓库还能忍，而缓存会让“从零跑一遍”变得不那么从零。

## 跑一遍

整章一个 `make` 目标，再加 `make lint`：

```text
$ make ch10
python3 scripts/chapter.py ch10
ok   lab/ch10/bench_tokenize.py
ok   lab/ch10/doctest_demo.py
ok   lab/ch10/hypothesis_found_bug.py
ok   lab/ch10/mock_demo.py
ok   lab/ch10/unittest_demo.py
pytest_features: 235 lines
...
ok   lab/ch10/extra.sh
```

（`make ch10` 中间是 `extra.sh` 的输出，我用 `...` 省略了：覆盖率表和上面 `make cov` 的类似，基准表比上面 `bench_run` 的少一列平均值，因为 `extra.sh` 里的列是 `min,median,max,rounds`。）

```text
$ make lint
ruff format --check --line-length 79 .
168 files already formatted
ruff check .
All checks passed!
```

## 本篇文件

这一章新增或修改的文件共 31 个：

```text
$ git diff --shortstat ch09 ch10
 31 files changed, 2451 insertions(+), 19 deletions(-)
```

结果列是我在本篇环境里重新跑出来的。测试文件按组列出，每个都有链接；组里的命令一次跑这几个文件。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`tests/conftest.py`](https://github.com/bfmhno3/sift/blob/ch10/tests/conftest.py) | `pytest --fixtures tests \| grep -c -- "-- tests/conftest.py"` | 退出码 0，输出 `3`（三个 session fixture）；37 行。它用的 [`tests/fixtures/mini/`](https://github.com/bfmhno3/sift/tree/ch10/tests/fixtures/mini) 里的 8 篇样本文章在第 1 篇的仓库里就有，这一章没改 |
| [`tests/test_markdown.py`](https://github.com/bfmhno3/sift/blob/ch10/tests/test_markdown.py)、[`tests/test_frontmatter.py`](https://github.com/bfmhno3/sift/blob/ch10/tests/test_frontmatter.py)、[`tests/test_document.py`](https://github.com/bfmhno3/sift/blob/ch10/tests/test_document.py)、[`tests/test_corpus.py`](https://github.com/bfmhno3/sift/blob/ch10/tests/test_corpus.py) | `pytest tests/test_markdown.py tests/test_frontmatter.py tests/test_document.py tests/test_corpus.py` | 退出码 0，68 个通过、1 个 `xfailed` |
| [`tests/test_analysis.py`](https://github.com/bfmhno3/sift/blob/ch10/tests/test_analysis.py)、[`tests/test_index.py`](https://github.com/bfmhno3/sift/blob/ch10/tests/test_index.py)、[`tests/test_scoring.py`](https://github.com/bfmhno3/sift/blob/ch10/tests/test_scoring.py) | `pytest tests/test_analysis.py tests/test_index.py tests/test_scoring.py` | 退出码 0，66 个通过 |
| [`tests/test_query.py`](https://github.com/bfmhno3/sift/blob/ch10/tests/test_query.py)、[`tests/test_search.py`](https://github.com/bfmhno3/sift/blob/ch10/tests/test_search.py)、[`tests/test_snippet.py`](https://github.com/bfmhno3/sift/blob/ch10/tests/test_snippet.py) | `pytest tests/test_query.py tests/test_search.py tests/test_snippet.py` | 退出码 0，125 个通过；`test_snippet.py` 里有这一章两次修复各自的回归测试 |
| [`tests/test_errors.py`](https://github.com/bfmhno3/sift/blob/ch10/tests/test_errors.py)、[`tests/test_log.py`](https://github.com/bfmhno3/sift/blob/ch10/tests/test_log.py)、[`tests/test_main.py`](https://github.com/bfmhno3/sift/blob/ch10/tests/test_main.py)、[`tests/test_util.py`](https://github.com/bfmhno3/sift/blob/ch10/tests/test_util.py) | `pytest tests/test_errors.py tests/test_log.py tests/test_main.py tests/test_util.py` | 退出码 0，31 个通过 |
| [`tests/test_properties.py`](https://github.com/bfmhno3/sift/blob/ch10/tests/test_properties.py) | `pytest tests/test_properties.py` | 退出码 0，13 个通过（约 4.5 秒） |
| [`pytest.ini`](https://github.com/bfmhno3/sift/blob/ch10/pytest.ini) | `pytest --markers \| head -1` | 退出码 0，`@pytest.mark.slow: needs the full corpus or many generated cases`；5 行 |
| [`Makefile`](https://github.com/bfmhno3/sift/blob/ch10/Makefile) | `make -n test cov` | 退出码 0，两行：`pytest` 和 `pytest --cov=sift --cov-report=term-missing` |
| [`.github/workflows/ci.yml`](https://github.com/bfmhno3/sift/blob/ch10/.github/workflows/ci.yml) | `gh run view 39850599587 -R bfmhno3/sift` | 退出码 0，`✓ ci in 3m40s`；21 行 |
| [`README.md`](https://github.com/bfmhno3/sift/blob/ch10/README.md) | `git diff --shortstat ch09 ch10 -- README.md Makefile pytest.ini .github` | 退出码 0，4 个文件（含 `Makefile`、`pytest.ini` 和 `ci.yml`）共 39 行新增、5 行删除；README 里改了测试目录、CI 目录和 `make test`、`make ci` 的说明 |
| [`src/sift/query/ast.py`](https://github.com/bfmhno3/sift/blob/ch10/src/sift/query/ast.py) | `python3 -c 'from sift.query import parse, print_query; print(print_query(parse("a b OR c*")))'` | 退出码 0，输出 `a AND b OR c*` |
| [`src/sift/query/__init__.py`](https://github.com/bfmhno3/sift/blob/ch10/src/sift/query/__init__.py) | `python3 -c 'import sift.query as q; print(hasattr(q, "print_query"))'` | 退出码 0，输出 `True` |
| [`src/sift/scoring.py`](https://github.com/bfmhno3/sift/blob/ch10/src/sift/scoring.py) | `pytest src/sift/scoring.py` | 退出码 0，4 个 doctest 通过 |
| [`src/sift/snippet.py`](https://github.com/bfmhno3/sift/blob/ch10/src/sift/snippet.py) | `pytest src/sift/snippet.py` | 退出码 0，4 个 doctest 通过；这个文件里有这一章修了两次的 bug |
| [`lab/ch10/unittest_demo.py`](https://github.com/bfmhno3/sift/blob/ch10/lab/ch10/unittest_demo.py) | `python3 lab/ch10/unittest_demo.py` | 退出码 0，stdout 第一行 `unittest: wasSuccessful() = True`，stderr 里是 4 行 `ok` |
| [`lab/ch10/doctest_demo.py`](https://github.com/bfmhno3/sift/blob/ch10/lab/ch10/doctest_demo.py) | `python3 lab/ch10/doctest_demo.py` | 退出码 0，第一行 `sift.scoring: TestResults(failed=0, attempted=9)`；故意写错的示例报告 `Expected: 3`、`Got: 2` |
| [`lab/ch10/mock_demo.py`](https://github.com/bfmhno3/sift/blob/ch10/lab/ch10/mock_demo.py) | `python3 lab/ch10/mock_demo.py` | 退出码 0，第一行 `value=42, stderr='work took 250.0 ms\n'` |
| [`lab/ch10/hypothesis_found_bug.py`](https://github.com/bfmhno3/sift/blob/ch10/lab/ch10/hypothesis_found_bug.py) | `python3 lab/ch10/hypothesis_found_bug.py` | 退出码 0，第一行 `buggy merge_sorted: property failed`，缩出 `a=[0]`、`b=[0]` |
| [`lab/ch10/bench_tokenize.py`](https://github.com/bfmhno3/sift/blob/ch10/lab/ch10/bench_tokenize.py) | `python3 lab/ch10/bench_tokenize.py` | 退出码 0，4 个基准通过，第一行是 pytest 的 `test session starts` |
| [`lab/ch10/pytest_features.sh`](https://github.com/bfmhno3/sift/blob/ch10/lab/ch10/pytest_features.sh) | `bash lab/ch10/pytest_features.sh >/dev/null; wc -l out/ch10/pytest_features.txt` | 退出码 0，`235 out/ch10/pytest_features.txt`；它把文章里的 `-k`、`-m`、`--lf`、`--setup-show` 等各跑一遍 |
| [`lab/ch10/extra.sh`](https://github.com/bfmhno3/sift/blob/ch10/lab/ch10/extra.sh) | `bash lab/ch10/extra.sh` | 退出码 0，第一行 `pytest_features: 235 lines`，随后是覆盖率表和基准表 |

## 练习

**1.** 给 `pytest.ini` 的 `addopts` 加上 `--strict-markers`，再把 `tests/test_corpus.py` 里的 `slow` 改成 `slwo`，确认收集时就报错。然后想一想：没开 `--strict-markers` 时，这个拼写错误会让 `pytest -m "not slow"` 多跑一个什么测试？

**2.** 修掉 `xfail` 的那个缺口：让 `strip_markdown("use `Vec<u8>` here")` 得到 `use Vec<u8> here`。你需要决定 `_HTML_TAG` 先还是后于 `_CODE_SPAN`，以及“行内代码里的 `<b>`”该怎么处理。修好之后第一件事是跑 `pytest`：strict 的 `xfail` 会因为意外通过而失败，那正是它的用处；删掉标记，再给 `<b>` 的情形补一个参数化的用例。

**3.** 用 `hypothesis.stateful.RuleBasedStateMachine` 给 `IndexWriter` 写一个状态机测试：规则是 `add`（一个新文档）、`remove`、以及“块里抛异常并回滚”，不变量是 `index.n_docs` 等于模型里的集合大小，且 `doc_len` 里没有已被删除的文档。先预测它会不会找到东西，再跑。

**4.** 本篇的 `_origin` 在整体折叠和逐字折叠不一致时直接显示折叠后的文本。这样做的代价是什么？（想想 `ﬁ` 在片段里显示成了 `fi`。）写出一个比“显示折叠文本”更好的映射方案，并用 `test_snippet_highlights_exactly_the_matching_words` 当裁判。

## 下一篇

下一篇是《[模块、包、导入系统与命令行](/posts/python-by-sift-11-modules-packaging-cli/)》。这一篇的 `pytest.ini` 和 `python3 -m sift` 都靠 `nix develop` 设好的 `PYTHONPATH` 里的 `src` 才找得到包。下一篇要把这件事交给 `pyproject.toml`：`import sift` 到底去哪里找、`sift` 命令怎么从 `__main__.py` 变成一个真的入口，`pytest.ini` 的内容也会搬进去。我想看的是 `PYTHONPATH` 换掉之后，这批测试还绿不绿；再往后，第 12 篇索引要落盘，我猜“写下去再读回来还是同一个索引”会是我最先想写的一条性质。
