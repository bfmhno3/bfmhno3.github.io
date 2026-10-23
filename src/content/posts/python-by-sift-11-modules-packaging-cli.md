---
title: "模块、包、导入系统与命令行：把 PYTHONPATH 换成 pip install -e"
commentId: "post:python-by-sift-11-modules-packaging-cli"
published: "2026-10-23 12:00:00 +08:00"
description: "用 Sift 重学 Python 第 11 篇：我用 Python 3.14.7、hatchling 1.31.0 和 pip 26.2.1 把 Sift 打成带 sift 命令的包，用 argparse 重写了命令行，并把 import 拆成 find_spec、module_from_spec、exec_module 三步亲手走了一遍；-X importtime 把 28 ms 记在 importlib.metadata 头上，交替计时真去掉它只省整条命令的 17%，而 nix 里的 pytest 看不见可编辑安装，换成 python3 -m pytest 才跑过 338 个测试。"
category: Tutorial
tags:
  - Python
  - Sift
  - 模块
  - 包
  - import
  - argparse
series: "用 Sift 重学 Python"
seriesOrder: 11
draft: false
comment: true
slug: python-by-sift-11-modules-packaging-cli
---

同一个仓库、同一份 338 个测试：nix 给我的 `pytest` 说找不到 `sift`，`python3 -m pytest` 一个不落地跑过了。两条命令都叫 pytest，差别只在哪个解释器去读它们的 `sys.path`，而 `sift` 能不能被 import，取决于 `sys.path` 里有没有一行字。上一篇结尾我说要看 `PYTHONPATH` 换掉以后这批测试还绿不绿，答案是绿，但前提是先搞清楚 `import` 是怎么找到东西的：

```text
$ pytest -q -x 2>&1 | tail -4
ImportError while loading conftest '~/Projects/sift/tests/conftest.py'.
tests/conftest.py:7: in <module>
    from sift.corpus import iter_documents
E   ModuleNotFoundError: No module named 'sift'
$ python3 -m pytest 2>&1 | tail -1
338 passed, 1 xfailed in 4.76s
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch11`：新增 `pyproject.toml`（取代 `pytest.ini`）、`src/sift/cli.py`、`src/sift/analysis/stopwords.txt`、`tests/test_cli.py`（取代 `tests/test_main.py`），以及 `lab/ch11` 下 13 个脚本、4 个辅助包目录和 `extra.sh`；改动了 `src/sift/__init__.py`、`src/sift/__main__.py`、`src/sift/analysis/filters.py`、`flake.nix`、`Makefile`、`README.md`、`tests/test_analysis.py`，以及第 4、8、9、10 篇的 8 个实验文件（它们的 import 路径或 `pytest` 的调用方式变了）。`cli.py` 里 `index` 和 `stats` 仍然在内存里建索引，`pyproject.toml` 的依赖表还是空的，我猜这两处会随着后面的章节继续变；`__main__.py` 只有 6 行，`__init__.py` 和 `stopwords.txt` 我也不指望再动。`make ch11` 通过，`make lint` 通过。
> 涉及的 Python 特性：模块对象与 `types.ModuleType`、`sys.modules`、`sys.meta_path`、`sys.path`、finder、loader 与 spec、包与 `__init__.py`、绝对与相对导入、`__all__`、命名空间包、循环导入、`python -m` 与 `__main__.py`、`src` 布局、`pyproject.toml` (PEP 517, 518, 621, 660)、入口点、`importlib.metadata`、`importlib.resources`、`argparse`、`os.environ`、`subprocess`、`signal`。
> 前置：[第 10 篇](/posts/python-by-sift-10-testing/)，需要知道 pytest 怎么跑、`conftest.py` 是什么。

前十篇里 Sift 能被找到，靠的是 `flake.nix` 的 `shellHook` 里一行 `export PYTHONPATH="$PWD/src..."`，命令行是 `python3 -m sift` 加一个手写的 `if args[:1] == ["search"]`。这一篇把两样东西都换掉：`PYTHONPATH` 换成 `pip install -e`（结果是一个只有一行的 `.pth` 文件），手写分发换成 argparse，最后 `sift` 是一条真正装得上的命令。顺序是先把 `import` 那一行拆开，因为后面每个现象（那个 `pytest`、`-m`、循环导入、`.pth`）都是它的推论；然后是打包，最后是命令行和它周围的进程世界。

## 环境

和前几篇同一台机器，仓库在标签 `ch11`，命令都在 `nix develop` 里、仓库根目录 `~/Projects/sift` 下跑：

```text
$ uname -r; python3 -VV; pip --version; git describe --tags; git log --oneline -3
6.18.57
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
pip 26.2.1 from ~/Projects/sift/.venv/lib/python3.14/site-packages/pip (python 3.14)
ch11
7567993 feat(ch11): pyproject, sift command line, stopwords.txt, import system labs
e0cc29a fix(ch10): tokenize snippets from the original text, drop vacuous asserts
a69014e feat(ch10): pytest suite, hypothesis properties, doctests, CI
$ pip list 2>/dev/null | grep -iE '^(hatchling|build|pytest|sift) '
build             1.5.1
hatchling         1.31.0
pytest            9.1.1
sift              0.1.0       ~/Projects/sift
$ hyperfine --version
hyperfine 1.20.0
```

`pip list` 在 venv 里列出的是 venv 自己的包加上系统环境的包，原因在“可编辑安装”一节。下文的草稿脚本放在 `$S` 里，产物和副本放在 `$T` 里，都不进仓库：

```bash
T=/tmp/p11
S=$T/scratch
mkdir -p $S
```

上游源码我从各自的标签取原文：CPython `v3.14.7`、hatchling `v1.31.0`（在 pypa/hatch 仓库的标签 `hatchling-v1.31.0` 里，文件在 `backend/src/` 下，下文省略这个前缀）、pip `26.2.1`，引用的行号都是这些标签下的行号。输出里的主目录换成了 `~`，Python 的 nix 环境目录 `/nix/store/...-python3-3.14.7-env` 换成了 `PYENV`；显示宽度超过 100 的行我在空格处折成两行，续行不缩进；`load_index took N ms` 是 `@timed` 写到 stderr 的，命令里合并了 `2>&1` 的地方会混进来。

计时要先交代一件事：这台机器的 CPU 调速器是 `powersave`，同一条命令在不同时刻能差 2 倍多（后面有一个脚本在同一张表里并排打出三个钟），所以下面所有比较都是交替着跑的，我会写明轮数，绝对值只当参考。

## 模块是对象

一个 `import json` 之后，`json` 是一个名字，指向一个 `types.ModuleType` 的实例。这个实例没有什么神秘的，我手工造一个，不给它任何文件，再让 `import` 找到它：

```python
"""A module is an object: build one by hand, then import it."""

import sys
import types


def main() -> None:
    """Make a module with no file and let ``import`` find it."""
    mod = types.ModuleType("handmade", "A module with no file.")
    source = "def shout(text): return text.upper() + '!'"
    exec(source, mod.__dict__)
    mod.ANSWER = 42
    print(type(mod), "|", mod.__name__, "|", mod.__doc__)
    print("has __file__:", hasattr(mod, "__file__"))
    print("names:", sorted(k for k in vars(mod) if not k.startswith("__")))
    print(
        "globals of shout is the module dict:",
        mod.shout.__globals__ is mod.__dict__,
    )

    sys.modules["handmade"] = mod
    import handmade
    from handmade import shout

    print("import finds it:", handmade is mod, shout("ok"))


if __name__ == "__main__":
    main()
```

保存为 `$S/module_object.py`：

```text
$ python3 $S/module_object.py
<class 'module'> | handmade | A module with no file.
has __file__: False
names: ['ANSWER', 'shout']
globals of shout is the module dict: True
import finds it: True OK!
```

`mod.__dict__` 就是它的命名空间，`exec` 把 `shout` 定义进去之后，`shout.__globals__` 就是这个字典：函数的全局变量是“它出生的那个模块的 `__dict__`”，不是什么调用时的全局环境。最后两行说明 `import handmade` 不管文件，只管 `sys.modules` 里有没有这个名字（下一节会看到它是第一个被查的）。所以“模块是文件”这个说法并不对：文件只是模块最常见的来源。

真正从文件来的模块带着一组属性，是 import 系统在创建时贴上去的。仓库里的 `lab/ch11/module_attrs.py` 打印它们：

```text
$ python3 lab/ch11/module_attrs.py | sed -n 1,5p
this script:
  __name__ = '__main__'
  __package__ = None
  __spec__ = None
  __file__ = ~/Projects/sift/lab/ch11/module_attrs.py
$ python3 lab/ch11/module_attrs.py | grep -A7 -E '^sift.search$'
sift.search
  __file__    = ~/Projects/sift/src/sift/search.py
  __package__ = 'sift'
  __path__    = None
  __spec__    = sift.search
  loader      = SourceFileLoader
  origin      = ~/Projects/sift/src/sift/search.py
  cached      = ~/Projects/sift/src/sift/__pycache__/search.cpython-314.pyc
```

脚本自己是 `__main__`，`__package__` 和 `__spec__` 都是 `None`，这一点后面讲 `-m` 和相对导入时会用到。`sift.search` 是普通模块（`__path__` 为 `None`），`__package__` 是它所在的包 `sift`；包有 `__path__`，一个目录列表，子模块就在那里找（下一节）。`spec.cached` 是对应的 `.pyc` 路径，在 `__pycache__` 里，“冷启动”一节会删它。`__spec__` 是 `importlib.machinery.ModuleSpec`，它记着 loader、origin 和上面这些路径，是下一节的主角。

## import 到底做了什么

### 先查 sys.modules

`import x` 的第一步不是找文件，是查缓存 `sys.modules`，一个普通的 `dict`。命中就直接返回，模块体不会再跑第二遍：

```text
$ python3 lab/ch11/sys_modules_cache.py
same object: True
cached under: True
first import:
  (module body runs)
second import:
same object: True
VALUE before reload: 1
reload:
  (module body runs)
reload returns the same module: True
VALUE after reload: 22
del sys.modules entry, import again:
  (module body runs)
new object: True
None in sys.modules: import of json halted; None in sys.modules
```

这个脚本是 `lab/ch11/sys_modules_cache.py`。第一次 `import cached_mod` 打印了 `(module body runs)`，第二次没有；改了源文件后 `importlib.reload` 才让模块体重跑，并且复用同一个模块对象（`VALUE` 从 1 变成 22）；从 `sys.modules` 里 `pop` 掉再导入，得到的是一个新对象。最后一行是个冷知识：把 `sys.modules["json"]` 设成 `None`，之后 `import json` 就报 `import of json halted; None in sys.modules`，这是 import 系统留的“禁止导入”开关。缓存命中和这个 `None` 检查都在 `_find_and_load` 里（CPython 的 `importlib._bootstrap`）：

```python
# Lib/importlib/_bootstrap.py:1360-1371 and 1387-1391 (CPython v3.14.7)
def _find_and_load(name, import_):
    """Find and load the module."""

    # Optimization: we avoid unneeded module locking if the module
    # already exists in sys.modules and is fully initialized.
    module = sys.modules.get(name, _NEEDS_LOADING)
    if (module is _NEEDS_LOADING or
        getattr(getattr(module, "__spec__", None), "_initializing", False)):
        with _ModuleLockManager(name):
            module = sys.modules.get(name, _NEEDS_LOADING)
            if module is _NEEDS_LOADING:
                return _find_and_load_unlocked(name, import_)
# ...
    if module is None:
        message = f'import of {name} halted; None in sys.modules'
        raise ModuleNotFoundError(message, name=name)

    return module
```

注意缓存检查那里多了一个 `_initializing`：一个正在初始化的模块虽然在 `sys.modules` 里，也要走锁，这和后面的循环导入有关。

### 找：finder 与 spec；进：loader

缓存没命中，`_find_spec` 就问 `sys.meta_path` 上的 finder，一个个问下去，谁先回答一个 spec 就用谁的：

```python
# Lib/importlib/_bootstrap.py:1259-1268 and 1284-1287 (CPython v3.14.7)
    is_reload = name in sys.modules
    for finder in meta_path:
        with _ImportLockContext():
            try:
                find_spec = finder.find_spec
            except AttributeError:
                continue
            else:
                spec = find_spec(name, path, target)
        if spec is not None:
# ...
            else:
                return spec
    else:
        return None
```

我把这个过程用四步手工走一遍，对象是 `sift` 本身。`PathFinder` 找 spec，`module_from_spec` 造模块，`exec_module` 跑模块体：

```python
"""Import sift by hand: find a spec, make a module, run its body."""

import importlib.machinery
import importlib.util
import sys
from pathlib import Path


def main() -> None:
    """Do the four steps of ``import sift`` one at a time."""
    for finder in sys.meta_path:
        print("meta_path:", getattr(finder, "__name__", type(finder).__name__))

    spec = importlib.machinery.PathFinder.find_spec("sift")
    print("1. spec.name:", spec.name)
    print("   spec.origin:", spec.origin)
    print("   spec.loader:", type(spec.loader).__name__)
    print("   spec.submodule_search_locations:")
    print("     ", spec.submodule_search_locations)
    print("   in sys.modules?", "sift" in sys.modules)

    module = importlib.util.module_from_spec(spec)
    print("2. module made, has __version__?", hasattr(module, "__version__"))
    print("   __spec__ is spec:", module.__spec__ is spec)

    sys.modules["sift"] = module
    spec.loader.exec_module(module)
    print("3. body ran, __version__ =", module.__version__)

    import sift

    print("4. import sift is the same object:", sift is module)
    entry = str(Path(spec.origin).parent.parent)
    finder = sys.path_importer_cache[entry]
    print("   cached path entry finder:", type(finder).__name__)


if __name__ == "__main__":
    main()
```

保存为 `$S/spec_steps.py`：

```text
$ python3 $S/spec_steps.py
meta_path: DistutilsMetaFinder
meta_path: BuiltinImporter
meta_path: FrozenImporter
meta_path: PathFinder
1. spec.name: sift
   spec.origin: ~/Projects/sift/src/sift/__init__.py
   spec.loader: SourceFileLoader
   spec.submodule_search_locations:
      ['~/Projects/sift/src/sift']
   in sys.modules? False
2. module made, has __version__? False
   __spec__ is spec: True
3. body ran, __version__ = 0.1.0
4. import sift is the same object: True
   cached path entry finder: FileFinder
```

`find_spec` 只是找，`sift` 此时不在 `sys.modules` 里；`module_from_spec` 造出来的模块是空的（没有 `__version__`），但 `__spec__` 已经贴上了；直到 `exec_module` 才跑 `sift/__init__.py` 的模块体，`__version__` 才出现。真正的 import 在这三步之间还夹着一步，把模块放进 `sys.modules`，而且是在跑模块体之前：

```python
# Lib/importlib/_bootstrap.py:924-944 (CPython v3.14.7)
    module = module_from_spec(spec)

    # This must be done before putting the module in sys.modules
    # (otherwise an optimization shortcut in import.c becomes
    # wrong).
    spec._initializing = True
    try:
        sys.modules[spec.name] = module
        try:
            if spec.loader is None:
                if spec.submodule_search_locations is None:
                    raise ImportError('missing loader', name=spec.name)
                # A namespace package so do nothing.
            else:
                spec.loader.exec_module(module)
        except:
            try:
                del sys.modules[spec.name]
            except KeyError:
                pass
            raise
```

`sys.modules[spec.name] = module` 在 `exec_module` 之前，失败了才 `del` 掉。这个顺序就是循环导入能“半成功”的原因，下面讲到它。

打个比方：`sys.meta_path` 是一排前台，每个前台被问“有没有叫 `sift` 的人”，有人答应就递过来一张名片 (spec)，名片上写着人在哪、谁负责去叫 (loader)；`sys.modules` 是大堂的签到簿，已经来过的人不会再问前台。比喻到此为止。

`meta_path` 里默认有三个 finder，nix 的 Python 环境多放了一个（`DistutilsMetaFinder`，我猜是 setuptools 带来的 `distutils-precedence.pth`，没去追）：`BuiltinImporter` 管内置模块，`FrozenImporter` 管冻结模块，`PathFinder` 管其余所有东西。`PathFinder` 沿着 `sys.path`（子模块则是父包的 `__path__`）一个目录一个目录问，每个目录有一个 `FileFinder`，缓存在 `sys.path_importer_cache` 里（上面最后一行）：

```python
# Lib/importlib/_bootstrap_external.py:1233-1253 (CPython v3.14.7)
    @classmethod
    def _path_importer_cache(cls, path):
        """Get the finder for the path entry from sys.path_importer_cache.

        If the path entry is not in the cache, find the appropriate finder
        and cache it. If no finder is available, store None.

        """
        if path == '':
            try:
                path = _os.getcwd()
            except (FileNotFoundError, PermissionError):
                # Don't cache the failure as the cwd can easily change to
                # a valid directory later on.
                return None
        try:
            finder = sys.path_importer_cache[path]
        except KeyError:
            finder = cls._path_hooks(path)
            sys.path_importer_cache[path] = finder
        return finder
```

自己写一个 finder 很简单，只要有 `find_spec`。`lab/ch11/custom_finder.py` 装了两个：一个只记录名字、不回答（返回 `None`，让后面的继续），另一个按名字从字典里取源码字符串，造一个没有文件的模块：

```python
# lab/ch11/custom_finder.py:18-26 and 48-58
    def find_spec(
        self,
        fullname: str,
        path: Sequence[str] | None = None,
        target: ModuleType | None = None,
    ) -> ModuleSpec | None:
        """Log fullname and decline, so the next finder runs."""
        self.seen.append(fullname)
        return None
# ...
    def find_spec(
        self,
        fullname: str,
        path: Sequence[str] | None = None,
        target: ModuleType | None = None,
    ) -> ModuleSpec | None:
        """Return a spec for a known name, else None."""
        if fullname in self.sources:
            loader = StringLoader(self.sources[fullname])
            return importlib.util.spec_from_loader(fullname, loader)
        return None
```

```text
$ python3 lab/ch11/custom_finder.py
virtual_hello.GREETING: hi from a string
its spec loader: StringLoader
its __file__: None
names the logger saw: ['colorsys', 'virtual_hello']
default finders:
   <_distutils_hack.DistutilsMetaFinder object at 0x7ffff7337770>
   BuiltinImporter
   FrozenImporter
   PathFinder
```

记录者看到的是 `colorsys` 和 `virtual_hello`：它只被问到没有缓存的名字，已经在 `sys.modules` 里的模块根本到不了 finder。字符串模块的 `__file__` 是 `None`，loader 是我自己的 `StringLoader`，和上一节手工造的模块一样没有文件。

### sys.path 与 .pth

`PathFinder` 的搜索范围是 `sys.path`。`lab/ch11/sys_path.py` 打印它，并用子进程演示 `PYTHONPATH`、`-P` 和 `-I`：

```text
$ python3 lab/ch11/sys_path.py
sys.path[0] is the script directory: ~/Projects/sift/lab/ch11
entries:
   ~/Projects/sift/lab/ch11
   PYENV/lib/python314.zip
   PYENV/lib/python3.14
   PYENV/lib/python3.14/lib-dynload
   ~/Projects/sift/.venv/lib/python3.14/site-packages
   ~/Projects/sift/src
   PYENV/lib/python3.14/site-packages
path hooks: ['zipimporter', 'path_hook_for_FileFinder']
importer cache keys: True
     PYTHONPATH: ['', '/tmp/first']
 -P (safe path): ['/tmp/first', '/tmp/second']
  -I (isolated): ['PYENV/lib/python314.zip', 'PYENV/lib/python3.14']
after insert: /tmp/inserted
$ cat .venv/lib/python3.14/site-packages/_editable_impl_sift.pth
~/Projects/sift/src
```

第一项是脚本所在目录（`python3 -m` 和 `-c` 的第一项分别是当前目录和空串，后面的 `whoami` 实验会看到）；然后是标准库；再是 venv 的 `site-packages`；倒数第二项 `~/Projects/sift/src` 不是我设的，它来自 `site-packages` 里的 `_editable_impl_sift.pth`，一个只有一行的文本文件（输出最后一行），`site` 模块启动时把每一行都加进 `sys.path`。这就是上面那个 `pytest` 找不到 `sift` 的全部真相：能不能 `import sift`，等于 `src` 在不在 `sys.path` 上，而 `.pth` 只在读到它的解释器里生效。`PYTHONPATH` 的两项出现在子进程 `sys.path` 的 `''` 之后；`-P` 不往前面插当前目录或脚本目录（所以是 `/tmp/first` 打头）；`-I` 忽略 `PYTHONPATH`，前两项就是标准库。

## 包

### `__init__.py` 与绝对导入

一个带 `__init__.py` 的目录是一个常规包：它自己就是一个模块，多一个 `__path__`。`__init__.py` 的内容在 `import sift.analysis` 时执行，所以它是包的“门面”。`sift/analysis/__init__.py` 就是这样写的，重新导出子模块里的名字，并用 `__all__` 声明哪些是公开的：

```python
# src/sift/analysis/__init__.py:1-34
"""Text analysis: turning text into index terms."""

from sift.analysis.base import REGISTRY, Analyzer, TokenFilter
from sift.analysis.filters import (
    FILTERS,
    STOPWORDS,
    NfkcCasefold,
    StopwordFilter,
)
from sift.analysis.pipeline import Pipeline, build_pipeline
from sift.analysis.tokenize import Token, iter_tokens, tokenize
from sift.analysis.tokenizers import (
    CjkBigramTokenizer,
    LatinTokenizer,
    MixedTokenizer,
)

__all__ = [
    "FILTERS",
    "REGISTRY",
    "STOPWORDS",
    "Analyzer",
    "CjkBigramTokenizer",
    "LatinTokenizer",
    "MixedTokenizer",
    "NfkcCasefold",
    "Pipeline",
    "StopwordFilter",
    "Token",
    "TokenFilter",
    "build_pipeline",
    "iter_tokens",
    "tokenize",
]
```

Sift 里全是绝对导入（PEP 8 的推荐，`docs/code-style.md` 也这么写），没有相对导入，也没有星号导入：

```text
$ grep -rnE '^\s*from \.' src | wc -l
0
$ grep -rnE '^\s*from sift' src | wc -l
51
$ grep -rn 'import \*' src | wc -l
0
```

绝对导入里藏着一个我写这一节时才注意到的坑。`__init__.py` 里的 `from sift.analysis.tokenize import ..., tokenize` 把函数 `tokenize` 绑进了包的命名空间，盖掉了 import 系统在加载子模块之后 `setattr` 上去的同名子模块（`_find_and_load_unlocked` 末尾的 `setattr(parent_module, child, module)`）：

```text
$ python3 -c "import sift.analysis as a; print(type(a.tokenize).__name__)"
function
$ python3 -c "import sys, sift.analysis; m = sys.modules; \
print(type(m['sift.analysis.tokenize']).__name__)"
module
$ python3 -c "import sift.analysis.tokenize as t; print(type(t).__name__)"
function
```

`sys.modules` 里的 `sift.analysis.tokenize` 是模块，属性 `sift.analysis.tokenize` 却是函数，`import sift.analysis.tokenize as t` 绑到的也是函数（我猜 `as` 形式是沿着属性一路取下来的，没有去读 `sys.modules`，这一点我没有验证）。代码没有错，测试也都是绿的，但这种名字重合迟早会咬人；我没有改它，第 2 篇起这个名字就是这样的。

### 相对导入

相对导入以当前模块的 `__package__` 为基准。`lab/ch11/relative_imports` 是一个两模块的包：

```python
# lab/ch11/relative_imports/a.py:1-12
"""Module a: one relative import and one absolute import."""

import relative_imports.b

from .b import OFFSET

ABSOLUTE_OFFSET = relative_imports.b.OFFSET


def double(value: int) -> int:
    """Return twice value plus the offset that b defines."""
    return value * 2 + OFFSET
```

`from .b import OFFSET` 是相对导入，`import relative_imports.b` 是绝对导入，两条路拿到的值一样：

```text
$ python3 lab/ch11/relative_imports_demo.py
package: relative_imports
a.__package__: relative_imports
b.__package__: relative_imports
double(5) = 11
a.b is b (one module object): True
a.ABSOLUTE_OFFSET: 1
__init__ exports: ['double']
submodules loaded: ['relative_imports.a', 'relative_imports.b']
$ python3 lab/ch11/relative_import_fail.py 2>&1 | tail -3
  File "~/Projects/sift/lab/ch11/relative_import_fail.py", line 5, in <module>
    from .relative_imports import a
ImportError: attempted relative import with no known parent package
$ cd lab/ch11 && python3 -m relative_imports.a; echo $?
<frozen runpy>:130: RuntimeWarning: 'relative_imports.a' found in sys.modules after import of
package 'relative_imports', but prior to execution of 'relative_imports.a'; this may result in
unpredictable behaviour
0
$ cd lab/ch11 && python3 relative_imports/a.py 2>&1 | tail -2
    import relative_imports.b
ModuleNotFoundError: No module named 'relative_imports'
```

`relative_imports_demo.py` 的输出是前八行：两个子模块的 `__package__` 都是 `relative_imports`，`.b` 就是据此解析成 `relative_imports.b` 的（脚本里那行 `a.b is b` 用 `is` 比较，两条路确实是同一个模块对象）。点号的解析只有几行，`__package__` 为空时的报错在它旁边：

```python
# Lib/importlib/_bootstrap.py:1234-1240 and 1296-1301 (CPython v3.14.7)
def _resolve_name(name, package, level):
    """Resolve a relative module name to an absolute one."""
    bits = package.rsplit('.', level - 1)
    if len(bits) < level:
        raise ImportError('attempted relative import beyond top-level package')
    base = bits[0]
    return f'{base}.{name}' if name else base
# ...
    if level > 0:
        if not isinstance(package, str):
            raise TypeError('__package__ not set to a string')
        elif not package:
            raise ImportError('attempted relative import with no known parent '
                              'package')
```

（解释器自己执行 `import` 语句时用的是 C 版本，`Python/import.c` 里的 `resolve_name`，从第 3567 行起，同一句报错在第 3707 到 3709 行；上面这份 Python 是 `importlib.import_module` 走的等价实现，所以我读它，行为是一样的。）后面三条命令更有意思。`relative_import_fail.py` 把带相对导入的文件当脚本跑，`__package__` 和 `__spec__` 都是 `None`，`_calc___package__` 退回到 `__name__` (`'__main__'`) 去掉最后一段，得到空串，于是走到上面第二段的 `elif not package`，报 `attempted relative import with no known parent package`，这和 `module_attrs` 里脚本的 `__package__ = None` 对上了。

第二条 `python3 -m relative_imports.a` 成功了（退出码 0），因为 `-m` 把模块放在包里运行；但有一条 `RuntimeWarning`：`relative_imports/__init__.py` 已经 `from .a import double` 把 `a` 导入过一次，`-m` 又把同一个文件当 `__main__` 再执行一次，同一份代码跑了两遍，两个模块对象互不相干。这个警告是 `runpy` 专门写的：

```python
# Lib/runpy.py:122-130 (CPython v3.14.7)
        # Warn if the module has already been imported under its normal name
        existing = sys.modules.get(mod_name)
        if existing is not None and not hasattr(existing, "__path__"):
            from warnings import warn
            msg = "{mod_name!r} found in sys.modules after import of " \
                "package {pkg_name!r}, but prior to execution of " \
                "{mod_name!r}; this may result in unpredictable " \
                "behaviour".format(mod_name=mod_name, pkg_name=pkg_name)
            warn(RuntimeWarning(msg))
```

第三条直接 `python3 relative_imports/a.py`，`sys.path[0]` 变成了包目录本身，`import relative_imports.b` 找不到 `relative_imports` (`ModuleNotFoundError`)。三条加起来是一个实用规则：包里的文件要么被 import，要么用 `-m` 跑，不要拿路径当脚本。

### `__all__` 与 `import *`

`__all__` 只有一个语言层面的用途：决定 `from m import *` 绑定哪些名字。没有 `__all__` 时，星号导入取所有不以下划线开头的名字，包括模块自己 import 进来的 `json`：

```text
$ python3 lab/ch11/all_and_star.py
with __all__:    ['public', 'CONSTANT']
star imports:    ['CONSTANT', 'public']
without __all__: False
star imports:    ['CONSTANT', 'helper', 'json']
sift.analysis.__all__ has 15 names
explicit import still reaches helper:
   "helper"
```

这是 `lab/ch11/all_and_star.py`（旁边的 `star_pkg` 有两个模块，一个有 `__all__`、一个没有）。有 `__all__` 的模块，星号只带走 `CONSTANT` 和 `public`；没有的，连 `json` 一起带走。显式 `from star_pkg.with_all import helper` 不受 `__all__` 约束，它不是防护，是约定。`sift.analysis.__all__` 的 15 个名字就是上面 `__init__.py` 里那份清单。

### 命名空间包

没有 `__init__.py` 的目录也能当包用，叫命名空间包 (PEP 420)，而且同一个包名可以分散在 `sys.path` 的多个目录里：

```text
$ python3 lab/ch11/namespace_pkg_demo.py
alpha lives in: one
beta lives in: two
package type: module
__file__: None
__path__ is a _NamespacePath
   namespace/one/nspkg
   namespace/two/nspkg
loader: <_frozen_importlib_external.NamespaceLoader object at 0x7ffff6e2e510>
```

`namespace_pkg_demo.py` 把 `namespace/one` 和 `namespace/two` 都加进 `sys.path`，两个目录里各有一个 `nspkg/` 但都没有 `__init__.py`，`alpha` 和 `beta` 分别从两边导入。它没有 `__file__`，`__path__` 是一个动态的 `_NamespacePath`，loader 是 `NamespaceLoader`。机制在 `PathFinder._get_spec`：每个目录的 `FileFinder` 遇到没有 `__init__.py` 的目录，返回一个 `loader` 为 `None` 的 spec，只带 `submodule_search_locations`，`PathFinder` 把这些位置攒起来继续往后找：

```python
# Lib/importlib/_bootstrap_external.py:1260-1282 (CPython v3.14.7)
        namespace_path = []
        for entry in path:
            if not isinstance(entry, str):
                continue
            finder = cls._path_importer_cache(entry)
            if finder is not None:
                spec = finder.find_spec(fullname, target)
                if spec is None:
                    continue
                if spec.loader is not None:
                    return spec
                portions = spec.submodule_search_locations
                if portions is None:
                    raise ImportError('spec missing loader')
                # This is possibly part of a namespace package.
                #  Remember these path entries (if any) for when we
                #  create a namespace package, and continue iterating
                #  on path.
                namespace_path.extend(portions)
        else:
            spec = _bootstrap.ModuleSpec(fullname, None)
            spec.submodule_search_locations = namespace_path
            return spec
```

后面的目录里如果真有一个常规包或模块，那个 spec 有 loader，直接返回，攒的位置作废；只有一路找到底都没有，才用攒下来的所有位置造一个命名空间包（`for` 的 `else` 分支）。所以 Sift 的每个目录都有 `__init__.py`：漏掉一个不会让 import 立刻失败，只会悄悄让那个目录变成命名空间包，`__file__` 变成 `None`。

### 循环导入

`lab/ch11/circular/a.py` 在顶部从 `b` 导入一个名字，`b.py` 在顶部从 `a` 导入一个名字：

```python
# lab/ch11/circular/a.py:3-5
from circular.b import b_value  # BAD: b imports a back, at the top

a_value = b_value + 1
```

```text
$ python3 lab/ch11/circular_import_fail.py 2>&1
fix 1 own_value: 11
fix 1 both: 11
fix 2 own_value: 11
fix 2 chained: 11
half-built modules left behind:
  circular.a False
  circular.b False
after the failure, circular.a in sys.modules: False
after the failure, circular.b in sys.modules: False
Traceback (most recent call last):
  File "~/Projects/sift/lab/ch11/circular_import_fail.py", line 46, in <module>
    main()
    ~~~~^^
  File "~/Projects/sift/lab/ch11/circular_import_fail.py", line 34, in main
    import circular.a
  File "~/Projects/sift/lab/ch11/circular/a.py", line 3, in <module>
    from circular.b import b_value  # BAD: b imports a back, at the top
    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "~/Projects/sift/lab/ch11/circular/b.py", line 3, in <module>
    from circular.a import a_value  # BAD: a is only half initialized
    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
ImportError: cannot import name 'a_value' from partially initialized module 'circular.a' (most
likely due to a circular import) (~/Projects/sift/lab/ch11/circular/a.py)
```

`lab/ch11/circular_import_fail.py` 先把两种修法跑通（前四行），再跑那个会失败的。按上一节的顺序走一遍：`import circular.a` 把 `circular.a` 放进 `sys.modules`，开始跑它的模块体，第 3 行去导入 `circular.b`；`b` 的模块体第 3 行 `from circular.a import a_value`，`circular.a` 在 `sys.modules` 里（命中了，没有再跑一遍），但它还停在第 3 行，`a_value` 没有定义，于是报 `cannot import name 'a_value' from partially initialized module`。出错之后 `_load_unlocked` 的 `except` 把失败模块从 `sys.modules` 里删掉，脚本捕获这个 `ImportError` 之后检查 `sys.modules`，`circular.a` 和 `circular.b` 都不在了（输出里“after the failure”那两行；更早那三行“half-built”是失败之前打的，当然也是 `False`，不说明什么），然后脚本把异常原样抛出，所以才有回溯和退出码 1。

修法有三种，前两种我都跑了：

1. 导入模块，不导入名字 (`from circular import fix_module_other`)，用的时候才取属性，那时两边都已经初始化完毕：

   ```python
   # lab/ch11/circular/fix_module.py:3-8
   from circular import fix_module_other


   def own_value() -> int:
       """Return a value that depends on the other module."""
       return fix_module_other.other_value() + 1
   ```

2. 在函数里导入，推迟到第一次调用：

   ```python
   # lab/ch11/circular/fix_local.py:4-8
   def own_value() -> int:
       """Import the other module on the first call, not at load."""
       from circular.fix_local_other import other_value

       return other_value() + 1
   ```

3. 把两边都需要的东西抽到第三个模块里，让依赖变成一条线。这是真正的修法，前两种是止血。

## `python -m` 与 `__main__.py`

跑一段 Python 有三种入口，区别在 `__name__`、`__package__` 和 `sys.path[0]`。同一个文件用三种方式跑：

```python
"""Print what the import system set on this module."""

import sys


def main() -> None:
    """Print __name__, __package__, the spec name and sys.path[0]."""
    spec = __spec__.name if __spec__ else None
    print(f"__name__={__name__!r} __package__={__package__!r} spec={spec!r}")
    print("sys.path[0] =", sys.path[0])


if __name__ == "__main__":
    main()
```

保存为 `$S/whoami.py`：

```text
$ cd $S && python3 whoami.py
__name__='__main__' __package__=None spec=None
sys.path[0] = /tmp/p11/scratch
$ cd $S && python3 -m whoami
__name__='__main__' __package__='' spec='whoami'
sys.path[0] = /tmp/p11/scratch
$ cd $S && python3 -c "import whoami; whoami.main()"
__name__='whoami' __package__='' spec='whoami'
sys.path[0] =
$ python3 -m sift.analysis; echo $?
~/Projects/sift/.venv/bin/python3: No module named sift.analysis.__main__; 'sift.analysis' is a
package and cannot be directly executed
1
$ python3 -m sift --version
sift 0.1.0
```

前三条是 `whoami`。直接跑脚本，`__spec__` 是 `None`，`sys.path[0]` 是脚本所在目录。`-m` 先按模块名找 spec（和 `import` 一样），所以 `__spec__` 有值，`sys.path[0]` 是当前目录，`__name__` 仍然是 `__main__`。`-c` 里 `import` 它，`__name__` 就是 `whoami`，`sys.path[0]` 是空串，意思是“当前目录”。`python3 -m sift.analysis` 那条的错误说明 `-m` 碰到包时的规则：去找包里的 `__main__` 子模块，没有就报错。`runpy` 里就这几行：

```python
# Lib/runpy.py:146-151 (CPython v3.14.7)
    if spec.submodule_search_locations is not None:
        if mod_name == "__main__" or mod_name.endswith(".__main__"):
            raise error("Cannot use package as __main__ module", **kwargs)
        try:
            pkg_main_name = mod_name + ".__main__"
            return _get_module_details(pkg_main_name, error)
```

所以 `sift` 这个包能被 `python3 -m sift` 运行，只需要 `src/sift/__main__.py`。ch10 的这个文件有 144 行，里面有手写的分发：

```python
# src/sift/__main__.py:105-114 (tag ch10)
def dispatch(args: list[str]) -> None:
    """Run the subcommand named by args, or exit with the usage."""
    if args[:1] == ["search"] and len(args) > 1:
        run_search(args[1:])
    elif args == ["stats"]:
        run_stats()
    elif args == ["bench"]:
        run_bench()
    else:
        sys.exit(USAGE)
```

现在它和 `__init__.py` 一起只有 11 行：

```python
# src/sift/__main__.py:1-6
"""Run ``python -m sift``: the same command line as ``sift``."""

from sift.cli import main

if __name__ == "__main__":
    main()
```

```python
# src/sift/__init__.py:1-5
"""Sift: a local full-text search engine for Markdown posts."""

from importlib.metadata import version

__version__ = version("sift")
```

`-m sift` 先 import `sift`（跑 `__init__.py`），再把 `sift.__main__` 当 `__main__` 跑。`if __name__ == "__main__"` 的用处是别人 `import sift.__main__` 时不会开跑。`sift.cli.main` 另有一个入口，后面“入口点”一节会看到；两个入口的 usage 第一行都是 `usage: sift ...`，不是巧合。不写 `prog` 时 argparse 自己取名，用一个小脚本看（保存为 `$S/prog_default.py`，分别直接跑和用 `-m` 跑）：

```python
"""Show the program name argparse picks when prog is not given."""

import argparse


def main() -> None:
    """Print the default prog of a bare ArgumentParser."""
    print(argparse.ArgumentParser().prog)


if __name__ == "__main__":
    main()
```


```text
$ cd $S && python3 prog_default.py
prog_default.py
$ cd $S && python3 -m prog_default
python3 -m prog_default
```

没有 `prog` 的 `ArgumentParser` 在 3.14 里会照实写出 `python3 -m prog_default`，所以 `cli.py` 里写死了 `prog="sift"`（下面 argparse 一节）。

## src 布局与 pyproject.toml

### 为什么是 `src/sift`

仓库根目录下没有 `sift/` 目录，包放在 `src/sift` 里，这叫 src 布局。差别在 `sys.path` 的第一项（当前目录）上：平铺布局里，当前目录下的 `sift/` 会抢在已安装的包前面被找到：

```text
$ rm -rf $T/flat && mkdir $T/flat
$ git archive ch11 src/sift | tar -x -C $T/flat --strip-components=1
$ cd $T/flat && python3 -c "import sift; print(sift.__file__)"
/tmp/p11/flat/sift/__init__.py
$ python3 -c "import sift; print(sift.__file__)"
~/Projects/sift/src/sift/__init__.py
```

平铺的那份是 `git archive` 导出的 `src/sift`：在 `$T/flat` 里，`import sift` 找到的是当前目录里的副本，不管装没装；在仓库根目录里找到的是装好的那份。所以 src 布局意味着想 import 就必须先装，测试测的是装好的包，包里漏了文件（比如 `stopwords.txt`）测试会先发现，而不是用户。

### pyproject.toml

整个文件 25 行：

```toml
# pyproject.toml:1-25
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
dependencies = []

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
```

`[build-system]` 是 PEP 518：`requires` 列出构建需要装什么，`build-backend` 指明用哪个模块来构建。前端 (pip, `python3 -m build`) 按 PEP 517 去调后端暴露的钩子，hatchling 暴露的钩子（只看 `build_` 开头的）是这些：

```text
$ python3 -c "import hatchling.build as b; print([n for n in dir(b) if n.startswith('build_')])"
['build_editable', 'build_sdist', 'build_wheel']
```

`build_wheel` 造 wheel，`build_sdist` 造源码包，`build_editable` 是 PEP 660 加的，下面可编辑安装一节要用。没有这张表会怎样？pip 会假定你要 setuptools 的老式后端：

```python
# src/pip/_internal/pyproject.py:69-78 (pip 26.2.1)
    if build_system is None:
        # In the absence of any explicit backend specification, we
        # assume the setuptools backend that most closely emulates the
        # traditional direct setup.py execution, and require wheel and
        # a version of setuptools that supports that backend.

        build_system = {
            "requires": ["setuptools>=40.8.0"],
            "build-backend": "setuptools.build_meta:__legacy__",
        }
```

`[project]` 是 PEP 621，把元数据从 `setup.py` 里搬到声明里：名字、版本、`requires-python`、`dependencies`（现在是空的，Sift 只用标准库）。`license = "MIT OR Apache-2.0"` 是 SPDX 表达式 (PEP 639)，`license-files` 把两份许可证文本带进包里。`[project.scripts]` 留到“入口点”一节。`[tool.pytest.ini_options]` 是上一篇 `pytest.ini` 的内容搬过来，`addopts` 从 ini 的一行变成 TOML 字符串，`markers` 变成列表；`pytest.ini` 我删掉了，免得两处各有一份配置。

`[tool.hatch.build.targets.wheel]` 那两行告诉 hatchling 把 `src/sift` 打进 wheel。我好奇它是不是必须的，拿一份 `git archive ch11` 导出的干净副本把这两行删掉，再各造一个 wheel，比较里面的文件：

```text
$ rm -rf $T/tree $T/tree2 $T/dist $T/dist2 $T/site; mkdir $T/tree
$ git archive ch11 | tar -x -C $T/tree
$ cd $T/tree && python3 -m build --wheel --no-isolation --outdir $T/dist . 2>&1 | tail -2
* Building wheel...
Successfully built sift-0.1.0-py3-none-any.whl
$ unzip -Z1 $T/dist/*.whl | grep -E "stopwords|cli|dist-info"
sift/cli.py
sift/analysis/stopwords.txt
sift-0.1.0.dist-info/METADATA
sift-0.1.0.dist-info/WHEEL
sift-0.1.0.dist-info/entry_points.txt
sift-0.1.0.dist-info/licenses/LICENSE-APACHE
sift-0.1.0.dist-info/licenses/LICENSE-MIT
sift-0.1.0.dist-info/RECORD
$ unzip -p $T/dist/*.whl sift-0.1.0.dist-info/METADATA
Metadata-Version: 2.4
Name: sift
Version: 0.1.0
Summary: A local full-text search engine for Markdown posts.
License-Expression: MIT OR Apache-2.0
License-File: LICENSE-APACHE
License-File: LICENSE-MIT
Requires-Python: >=3.14
```

```text
$ cp -r $T/tree $T/tree2
$ cd $T/tree2 && grep -v -e "^\[tool.hatch" -e "^packages =" pyproject.toml > new \
    && mv new pyproject.toml && grep -c hatch.build pyproject.toml
0
$ cd $T/tree2 && python3 -m build --wheel --no-isolation --outdir $T/dist2 . 2>&1 | tail -1
Successfully built sift-0.1.0-py3-none-any.whl
$ diff <(unzip -Z1 $T/dist/*.whl | sort) <(unzip -Z1 $T/dist2/*.whl | sort) && echo same
same
```

文件清单一样，所以这两行是多余的：hatchling 自己会找 `src/<项目名>/__init__.py`，上游的代码在这里：

```python
# hatchling/builders/wheel.py:241-249 (hatchling v1.31.0)
            self.builder.normalize_file_name_component(self.builder.metadata.core.name),
        ):
            if os.path.isfile(os.path.join(self.root, project_name, "__init__.py")):
                normalized_project_name = self.get_raw_fs_path_name(self.root, project_name)
                return FileSelectionOptions([], exclude, [normalized_project_name], [])

            if os.path.isfile(os.path.join(self.root, "src", project_name, "__init__.py")):
                normalized_project_name = self.get_raw_fs_path_name(os.path.join(self.root, "src"), project_name)
                return FileSelectionOptions([], exclude, [f"src/{normalized_project_name}"], [])
```

我留着它，因为“显式比隐式好”，但知道它不起作用。wheel 就是一个 zip，里面是这些东西：

```text
$ unzip -Z1 $T/dist/*.whl | wc -l
32
$ unzip -Z1 $T/dist/*.whl | grep -cE "^(tests|lab|corpus)"
0
$ git ls-files src | wc -l; find src -name "*.py" | wc -l
26
25
```

32 个文件，没有 `tests`、`lab`、`corpus`，`stopwords.txt` 在里面（它在包目录里，hatchling 默认带上）；`METADATA` 里是 `License-Expression: MIT OR Apache-2.0` 和 `Requires-Python: >=3.14`（上面造 wheel 那一块的最后一条命令）。最后确认一下这份 wheel 单独能用，装到一个不在仓库里的目录再从那里导入：

```text
$ pip install -q --no-deps --target $T/site $T/dist/*.whl
$ cd /tmp && PYTHONPATH=$T/site python3 -c "import sift; print(sift.__file__)"
/tmp/p11/site/sift/__init__.py
$ cd /tmp && PYTHONPATH=$T/site python3 \
    -c "from sift.analysis import STOPWORDS; print(len(STOPWORDS))"
25
```

`sift.__file__` 指向安装出来的副本，`STOPWORDS` 有 25 个词：`stopwords.txt` 是跟着 wheel 走的，不是靠仓库里的相对路径。这就是后面“resources”一节要讲的事。

## 可编辑安装与 Nix 里的 venv

### 可编辑安装是什么

`pip install -e .` 不拷贝文件。它向后端要一个“可编辑 wheel”（PEP 660 的 `build_editable`），装的是一个只含元数据和路径的 wheel：

```python
# src/pip/_internal/operations/build/wheel_editable.py:30-35 (pip 26.2.1)
        with backend.subprocess_runner(runner):
            try:
                wheel_name = backend.build_editable(
                    wheel_directory=wheel_directory,
                    metadata_directory=metadata_directory,
                )
```

hatchling 的实现把 `src` 登记进一个 `.pth`（`editables` 这个库负责写出文件）：

```python
# hatchling/builders/wheel.py:591-598 (hatchling v1.31.0)
            editable_project = EditableProject(self.metadata.core.name, self.root)

            if self.config.dev_mode_exact:
                for module, relative_path in exposed_packages.items():
                    editable_project.map(module, relative_path)
            else:
                for relative_path in exposed_packages.values():
                    editable_project.add_to_path(os.path.dirname(relative_path))
```

装完以后 `site-packages` 里是这些，没有一行 `sift` 的源码：

```text
$ cut -d, -f1 .venv/lib/python3.14/site-packages/sift-0.1.0.dist-info/RECORD
../../../bin/sift
_editable_impl_sift.pth
sift-0.1.0.dist-info/INSTALLER
sift-0.1.0.dist-info/METADATA
sift-0.1.0.dist-info/RECORD
sift-0.1.0.dist-info/REQUESTED
sift-0.1.0.dist-info/WHEEL
sift-0.1.0.dist-info/direct_url.json
sift-0.1.0.dist-info/entry_points.txt
sift-0.1.0.dist-info/licenses/LICENSE-APACHE
sift-0.1.0.dist-info/licenses/LICENSE-MIT
```

只有一个 `.pth`（就是上面 `sys.path` 里多出来的那行）、元数据和 `bin/sift`。`direct_url.json` 记着它是从哪个目录来的，`pip list --local` 把它标成“可编辑”：

```text
$ cat .venv/bin/sift
#!~/Projects/sift/.venv/bin/python3
import sys
from sift.cli import main
if __name__ == '__main__':
    sys.argv[0] = sys.argv[0].removesuffix('.exe')
    sys.exit(main())
$ cat .venv/lib/python3.14/site-packages/sift-0.1.0.dist-info/entry_points.txt
[console_scripts]
sift = sift.cli:main
$ cat .venv/lib/python3.14/site-packages/sift-0.1.0.dist-info/direct_url.json; echo
{"dir_info": {"editable": true}, "url": "file://~/Projects/sift"}
$ pip list --local 2>/dev/null
Package Version Editable project location
------- ------- ---------------------------
pip     26.2.1
sift    0.1.0   ~/Projects/sift
```

### 为什么要 venv，为什么 `--system-site-packages`

Nix 的 Python 环境在 `/nix/store`，只读：

```text
$ touch "$(python3 -c "import sys; print(sys.base_prefix)")/lib/x"
touch: cannot touch 'PYENV/lib/x': Read-only file system
$ rm -rf $T/plain $T/shared; python3 -m venv $T/plain
$ $T/plain/bin/python3 -c "import pytest" 2>&1 | tail -1
ModuleNotFoundError: No module named 'pytest'
$ python3 -m venv --system-site-packages $T/shared
$ $T/shared/bin/python3 -c "import pytest; print(pytest.__version__)"
9.1.1
```

装东西要有一个可写的 `site-packages`，所以要 venv。但是普通 venv（第二、三条）看不到 nix 环境里的 pytest、hypothesis 和 hatchling，要在里面重装一遍，网络、版本都得再管一次。`--system-site-packages` 让 venv 的 `sys.path` 尾部带上 nix 环境的 `site-packages`（第四、五条），nix 管第三方库，venv 只放 Sift 自己的安装。`pyvenv.cfg` 里对应的开关是：

```text
$ grep -E 'home|include-system' .venv/pyvenv.cfg
home = PYENV/bin
include-system-site-packages = true
command = PYENV/bin/python3 -m venv --system-site-packages ~/Projects/sift/.venv
```

`pip install` 的另外两个选项也各有原因：`--no-deps` 是因为 `dependencies = []`，没有东西要解析；`--no-build-isolation` 是因为默认的构建隔离会新建一个临时环境，去 PyPI 下载 `requires` 里的 hatchling，而 nix 环境里本来就有 hatchling 1.31.0。我拿一个不通的代理试了一下：

```text
$ cd $T/tree && HTTPS_PROXY=http://127.0.0.1:9 $T/shared/bin/pip install \
    --no-deps --retries 0 -e . 2>&1 | grep -E "ERROR: (Could|Failed)"
      ERROR: Could not find a version that satisfies the requirement hatchling (from versions: none)
ERROR: Failed to build 'file:///tmp/p11/tree' when installing build dependencies
$ cd $T/tree && HTTPS_PROXY=http://127.0.0.1:9 $T/shared/bin/pip install -q \
    --no-deps --no-build-isolation --retries 0 -e . \
    && $T/shared/bin/pip list --local 2>/dev/null | tail -1
sift    0.1.0   /tmp/p11/tree
```

第一条（隔离）要联网，失败了；第二条不隔离，直接成功，并且装到了 `$T/tree`。这是在一个新建的 venv 里试的，不是在仓库的 `.venv` 里。

### 两个 Nix 特有的坑

`flake.nix` 的 `shellHook` 现在是这样：

```nix
# flake.nix:88-89
            unset PYTHONPATH _PYTHON_SYSCONFIGDATA_NAME _PYTHON_HOST_PLATFORM
            if [ ! -d .venv ]; then python3 -m venv --system-site-packages .venv; fi; source .venv/bin/activate; pip install -q --no-deps --no-build-isolation -e .
```

第 89 行有 163 列（缩进算在内），按分号拆开是三件事：没有 `.venv` 就建（带 `--system-site-packages`），激活它，每次进 shell 都重装一遍 Sift（可编辑安装是幂等的，所以重装几乎没有代价，下面量）。第 88 行的 `unset` 是整个改动里我最不情愿写的一行（另有一个后果：venv 只在 `.venv` 不存在时才建，而 `pyvenv.cfg` 里的 `home` 写死了一个 store 路径，见上面的输出，所以 nixpkgs 升级之后 `.venv/bin/python3` 可能还指着旧的 store 路径，删掉 `.venv` 重进一次就好）：

先看是哪三个变量。`nix print-dev-env` 在 `shellHook` 运行之前就给出了 `PYTHONPATH`，指向 `python3.14t`（自由线程版，`flake.nix` 的 `packages` 里放了它，用来跑自由线程的实验）的 `site-packages`，还有 `_PYTHON_SYSCONFIGDATA_NAME` 和 `_PYTHON_HOST_PLATFORM`。这三个变量是为那个 Python 设的，我猜是它的 setup hook，没有追下去。它们对普通的 `python3` 做了什么，用一个打印 `SOABI`（解释器自称的 ABI 标签）的小脚本看：

```python
"""Print the ABI tag this interpreter's sysconfig data claims."""

import sysconfig


def main() -> None:
    """Print SOABI, e.g. cpython-314-x86_64-linux-gnu."""
    print(sysconfig.get_config_var("SOABI"))


if __name__ == "__main__":
    main()
```

保存为 `$S/soabi.py`（下面的 `$D` 是第一块输出的第二行，`$FT` 是第一行）：

```text
$ nix print-dev-env --json | jq -r ".variables | \
    [.PYTHONPATH, ._PYTHON_SYSCONFIGDATA_NAME, ._PYTHON_HOST_PLATFORM] | .[].value"
/nix/store/3dpgr9419zdgf8byapsy6vnqy2zsdvb4-python3-3.14.7/lib/python3.14t/site-packages
_sysconfigdata_t_linux_x86_64-linux-gnu
linux-x86_64
$ python3 $S/soabi.py
cpython-314-x86_64-linux-gnu
$ _PYTHON_SYSCONFIGDATA_NAME=$D python3 $S/soabi.py 2>&1 | tail -1
ModuleNotFoundError: No module named '_sysconfigdata_t_linux_x86_64-linux-gnu'
$ _PYTHON_SYSCONFIGDATA_NAME=$D PYTHONPATH=$FT python3 $S/soabi.py
cpython-314t-x86_64-linux-gnu
$ rm -rf $T/bad; _PYTHON_SYSCONFIGDATA_NAME=$D PYTHONPATH=$FT \
    python3 -m venv --system-site-packages $T/bad; echo $?
Error: Command '['/tmp/p11/bad/bin/python3.14', '-m', 'ensurepip', '--upgrade', '--default-pip']'
returned non-zero exit status 1.
1
$ python3.14t -c "import sys; print(sys.abiflags, sys._is_gil_enabled())"
t False
$ python3 -c "import sys; print(repr(sys.abiflags), sys._is_gil_enabled())"
'' True
```

普通的 `python3` 说自己是 `cpython-314-...`（第二条）。只设 `_PYTHON_SYSCONFIGDATA_NAME`，它去读自由线程版的 sysconfig 数据，找不到，`ModuleNotFoundError`（第三条）；`PYTHONPATH` 也补上就找到了，但 `SOABI` 变成了 `cpython-314t-...`，一个不是自由线程的解释器在自称自由线程（第四条）。`python3 -m venv` 建好环境以后，会用新环境的解释器跑 `ensurepip`，建环境的代码把 `PYTHONPATH` 和 `PYTHONHOME` 从环境里去掉（CPython 的 `Lib/venv/__init__.py:447-454`），却不管 `_PYTHON_SYSCONFIGDATA_NAME`，新解释器遇到的就是第三条的错误，`venv` 以 `ensurepip` 非零退出失败（第五条）。三个变量一起 `unset`，两个 Python 就互不相干了；最后两条命令确认它们确实是两种构建，`t` 是 ABI 标志，自由线程版的 GIL 是关的。

第二个坑在 `pytest` 本身。nix 的 `pytest` 不是 Python 脚本，是一个包装程序，写死了解释器：

```text
$ strings $(which pytest) | grep -E '^NIX_PYTHON(EXECUTABLE|PATH)='
NIX_PYTHONEXECUTABLE=PYENV/bin/python3.14
NIX_PYTHONPATH=PYENV/lib/python3.14/site-packages
$ which python3 sift pytest
~/Projects/sift/.venv/bin/python3
~/Projects/sift/.venv/bin/sift
PYENV/bin/pytest
$ python3 -m pytest tests/test_cli.py 2>&1 | tail -1
32 passed in 2.59s
```

它用的是 `NIX_PYTHONEXECUTABLE`，也就是 nix 环境的 `python3.14`，不是 venv 的，所以它的 `sys.path` 里没有 `_editable_impl_sift.pth`，找不到 `sift`，这就是开篇那条报错。`python3` 和 `sift` 在 venv 里，`pytest` 在 nix 环境里。办法是不用那个包装程序，用 venv 的解释器去跑 pytest 模块：`Makefile` 里是这样：

```make
# Makefile:23-27
test:
	python3 -m pytest

cov:
	python3 -m pytest --cov=sift --cov-report=term-missing
```

第 10 篇的两个实验脚本 `lab/ch10/extra.sh` 和 `pytest_features.sh` 里写了同样的东西（所以它们在“改动的文件”里）：

```bash
# lab/ch10/extra.sh:6-10
# The nix pytest script runs its own interpreter, which does not see the
# editable install in .venv: go through the venv python instead.
pytest() {
    python3 -m pytest "$@"
}
```

最后算一下这行 `shellHook` 的代价。进一次 shell 的时间，和其中 `pip install` 占多少，交替量五轮（脚本跑在 shell 外面，自己启动 `nix develop`）：

```python
"""Where do the seconds of ``nix develop`` go? Alternate 5 rounds.

Run from the repository root.
"""

import statistics
import subprocess
import time

PIP = (
    "t0=$EPOCHREALTIME; "
    "pip install -q --no-deps --no-build-isolation -e .; "
    'echo "$t0 $EPOCHREALTIME"'
)


def wall(argv: list[str]) -> float:
    """Return the wall time of argv in seconds."""
    start = time.perf_counter()
    subprocess.run(argv, check=True, capture_output=True)
    return time.perf_counter() - start


def pip_inside() -> float:
    """Return the seconds the hook's pip line takes inside the shell."""
    done = subprocess.run(
        ["nix", "develop", "--command", "bash", "-c", PIP],
        check=True,
        capture_output=True,
        text=True,
    )
    t0, t1 = done.stdout.split()[-2:]
    return float(t1) - float(t0)


def main() -> None:
    """Alternate the three measurements and print the medians."""
    rows: dict[str, list[float]] = {
        "nix develop --command true": [],
        "nix print-dev-env (no hook)": [],
        "pip line of the hook, alone": [],
    }
    for _ in range(5):
        rows["nix develop --command true"].append(
            wall(["nix", "develop", "--command", "true"])
        )
        rows["nix print-dev-env (no hook)"].append(
            wall(["nix", "print-dev-env"])
        )
        rows["pip line of the hook, alone"].append(pip_inside())
    for name, times in rows.items():
        print(f"{statistics.median(times):5.2f} s  {name}")


if __name__ == "__main__":
    main()
```

```text
$ python3 $S/reentry.py
 1.41 s  nix develop --command true
 0.61 s  nix print-dev-env (no hook)
 0.71 s  pip line of the hook, alone
```

保存为 `$S/reentry.py`。进一次 shell 1.41 秒，`nix` 自己求值 0.61 秒，`pip` 那一行 0.71 秒：重装占了一半。第一次进一个新克隆则要久得多（`.venv` 还不存在）：

```bash
#!/usr/bin/env bash
# Time the first and the second `nix develop` of a fresh clone.
# Run it at the root of a clone that has no .venv yet.
set -euo pipefail
for round in first second third; do
    start=$EPOCHREALTIME
    nix develop --command true > /dev/null
    echo "$round entry: $((${EPOCHREALTIME/./} - ${start/./})) us"
done
ls -d .venv
```

```text
$ git clone --branch ch11 ~/Projects/sift /tmp/p11/clone
$ cd /tmp/p11/clone && bash $S/first_entry.sh
first entry: 3911473 us
second entry: 1402236 us
third entry: 1373498 us
.venv
```

第一次 3.9 秒，多出来的 2.5 秒是建 venv 和第一次安装，之后是 1.4 秒。我开始以为 0.7 秒花得不值，后来想到每次重装有个好处：改了 `pyproject.toml` 里的 `[project.scripts]`（比如加一个命令），下一次进 shell 就自动生效，不会有一个 `sift` 脚本和 `pyproject.toml` 对不上的旧安装。这笔账我觉得合算，但如果以后每天要进几十次，我会把 `pip install` 改成只在 `pyproject.toml` 比 `.venv` 新的时候才跑，这是我没有做的优化。

## 入口点

`[project.scripts]` 里的 `sift = "sift.cli:main"` 不是 Python 代码，是写进元数据 `entry_points.txt` 的一行，pip 装的时候读它，在 `bin/` 下生成一个脚本。上面可编辑安装一节里 `cat` 出来的 `bin/sift` 就是它。生成它的模板在 pip 里：

```python
# src/pip/_internal/operations/install/wheel.py:417-426 (pip 26.2.1)
class PipScriptMaker(ScriptMaker):
    # Override distlib's default script template with one that
    # doesn't import `re` module, allowing scripts to load faster.
    script_template = textwrap.dedent("""\
        import sys
        from %(module)s import %(import_name)s
        if __name__ == '__main__':
            sys.argv[0] = sys.argv[0].removesuffix('.exe')
            sys.exit(%(func)s())
""")
```

`PipScriptMaker` 的注释说，这个模板特意不 import `re`，让脚本加载得更快（上游的默认模板 import 了 `re`）：脚本启动时每个 import 都是钱，后面会量。注意最后一行是 `sys.exit(%(func)s())`：`main()` 的返回值就是退出码，所以 `main()` 成功时返回 `None`（退出码 0），失败时自己调 `sys.exit(3)`，两种写法在入口脚本里一样。

入口点是元数据，别的程序可以查它。`$S/metadata_resources.py` 用 `importlib.metadata` 和 `importlib.resources` 问已安装的 Sift 一些事：

```python
"""Ask the installed Sift about itself, then read a data file."""

from importlib import metadata, resources


def main() -> None:
    """Print metadata, the entry point and the stopwords resource."""
    print("version:", metadata.version("sift"))
    meta = metadata.metadata("sift")
    print("license:", meta["License-Expression"])
    print("requires-python:", meta["Requires-Python"])
    for entry in metadata.entry_points(group="console_scripts"):
        if entry.name == "sift":
            print("entry point:", entry.value)
            main_function = entry.load()
            print("loads:", main_function.__module__, main_function.__name__)
    folder = resources.files("sift.analysis")
    print("files() returns:", type(folder).__name__)
    words = folder.joinpath("stopwords.txt")
    print("is_file:", words.is_file())
    print("first words:", words.read_text(encoding="utf-8").split()[:4])
    with resources.as_file(words) as path:
        print("as_file gives a real path:", path.name, path.exists())


if __name__ == "__main__":
    main()
```


```text
$ python3 $S/metadata_resources.py
version: 0.1.0
license: MIT OR Apache-2.0
requires-python: >=3.14
entry point: sift.cli:main
loads: sift.cli main
files() returns: PosixPath
is_file: True
first words: ['a', 'an', 'and', 'are']
as_file gives a real path: stopwords.txt True
```

`importlib.metadata` 能列出所有已安装包声明的 `console_scripts`，`entry.load()` 导入 `sift.cli` 并返回 `main` 函数。

## importlib.metadata 与 importlib.resources

### 版本号从哪来

`sift/__init__.py` 里没有版本字符串，`__version__` 是问元数据要的：

```python
# src/sift/__init__.py:3-5
from importlib.metadata import version

__version__ = version("sift")
```

`version("sift")` 的实现是找到名叫 `sift` 的分发包再取它的 `Version`：

```python
# Lib/importlib/metadata/__init__.py:980-988 (CPython v3.14.7)
def version(distribution_name: str) -> str:
    """Get the version string for the named package.

    :param distribution_name: The name of the distribution package to query.
    :return: The version string for the package as defined in the package's
        "Version" metadata key.
    """
    return distribution(distribution_name).version

```

“找到”的意思是沿 `sys.path` 扫描 `*.dist-info`（`MetadataPathFinder`，同一个文件的 870 行起），一次调用的开销是：

```text
$ python3 -m timeit -s 'from importlib.metadata import version' 'version("sift")'
2000 loops, best of 5: 148 usec per loop
$ python3 -m timeit -s 'from importlib.metadata import version' 'version("sift")'
2000 loops, best of 5: 150 usec per loop
```

这个函数调用约 0.15 毫秒，不是问题（上面两次是 148 和 150 微秒）。问题是 `import importlib.metadata` 本身，下面单独算。好处也要说清楚：版本号只写在 `pyproject.toml` 一处，`sift --version` 不可能和 wheel 对不上。还有一个代价：版本号来自已安装的元数据，所以在一份没装过的源码树里，`import sift` 本身就会失败（这里用没有可编辑安装的 nix 环境解释器，把 `src` 放到 `sys.path` 最前面）：

```text
$ BASE=$(python3 -c 'import sys; print(sys.base_prefix)')
$BASE/bin/python3 -c "import sys; sys.path.insert(0, 'src'); import sift" 2>&1 | tail -1
importlib.metadata.PackageNotFoundError: No package metadata was found for sift
```

### 资源文件从哪来

停用词表现在是 `src/sift/analysis/stopwords.txt`，25 个词，用 `importlib.resources` 读：

```python
# src/sift/analysis/filters.py:4 and 10-11
from importlib.resources import files
# ...
_STOPWORDS_FILE = files("sift.analysis").joinpath("stopwords.txt")
STOPWORDS = frozenset(_STOPWORDS_FILE.read_text(encoding="utf-8").split())
```

为什么不写 `Path(__file__).parent / "stopwords.txt"`？包不一定是个目录：从 zip 里导入时没有这个路径。`files("sift.analysis")` 通过包的 loader 要一个 `Traversable`（在普通文件系统上它碰巧是 `PosixPath`，见入口点一节里 `metadata_resources.py` 的输出），`joinpath`、`read_text` 对 zip 也有效；只有需要一个真实路径时（比如把文件交给外部程序）才用 `as_file`，它必要时会拷出一份临时文件。实现很短，`from_package` 向 loader 要一个 reader：

```python
# Lib/importlib/resources/_common.py:108-117 (CPython v3.14.7)
def from_package(package: types.ModuleType):
    """
    Return a Traversable object for the given package.

    """
    # deferred for performance (python/cpython#109829)
    from ._adapters import wrap_spec

    spec = wrap_spec(package)
    reader = spec.loader.get_resource_reader(spec.name)
```

前面把 wheel 装到别的目录再导入的那次已经证明：非可编辑的安装副本也读得到这个文件。

### importlib.metadata 值不值

`import sift.search` 要多久？`lab/ch11/extra.sh` 用 `-X importtime` 打出每个模块的自用时间和累计时间，按累计排序：

```text
$ sed -n 1,7p out/ch11/import_trace.txt
top 15 imports by cumulative time (us):
import time:      1572 |      59815 | sift.search
import time:       834 |      39064 |   sift
import time:      1080 |      27848 |     importlib.metadata
import time:       251 |       9688 |     importlib.metadata._adapters
import time:      2780 |       9281 |       email.message
import time:      2186 |       7445 |       inspect
$ tail -1 out/ch11/import_trace.txt
cumulative import of sift.search: 59815 us
```

`sift.search` 累计 59,815 微秒，其中 `sift` 这个包自己（也就是 `__init__.py` 里的 `from importlib.metadata import version`）占了 39,064，`importlib.metadata` 一个就是 27,848，是整个 `sift.search` 的 47%。我读到这个数的第一反应是：为了一个版本号花掉一半的启动时间？

先别急。同一条命令再跑五次，外加把 `__version__` 换成字面量之后 `inspect` 的位置：

```text
$ for i in 1 2 3 4 5; do python3 -X importtime -c "import sift.search" 2>&1 \
    | grep -E "[|] sift.search$"; done
import time:      1806 |      67383 | sift.search
import time:      1295 |      60261 | sift.search
import time:      1765 |      60747 | sift.search
import time:      1241 |      61284 | sift.search
import time:      1821 |      67447 | sift.search
$ PYTHONPATH=$T/lit python3 -X importtime -c "import sift.search" 2>&1 \
    | grep -A1 -E "[|] +inspect$"
import time:      2475 |       7111 |     inspect
import time:       795 |      11941 |   dataclasses
```

五次是 60.3 到 67.4 毫秒，和上面的 59.8 毫秒一致。先看第二条命令：字面量版本里 `inspect` 仍然在，只是它的父亲变成了 `dataclasses`。`-X importtime` 的“累计”记的是谁先付了钱，不是谁造成的：`importlib.metadata` 带来的 `inspect`，别的模块（`dataclasses` 就 import `inspect`）本来也要带。

绝对值也不能全信：这台机器慢的时候，同一条命令要 18 万微秒左右（我第一次跑 `extra.sh` 得到的就是这个量级）。下面这个脚本每一轮在一行里同时打印三个钟：空解释器，`import sift.search` 的整条命令，同一个 import 在 `-X importtime` 下的累计：

```python
"""Three clocks on one import: empty interpreter, wall, importtime.

Each round runs ``python3 -c pass``, ``python3 -c "import sift.search"``
and the same import under ``-X importtime``, then prints the three
numbers on one line (ms). Usage: python3 state.py ROUNDS [PAUSE].
"""

import re
import subprocess
import sys
import time

TOTAL = re.compile(r"\|\s+(\d+) \| sift\.search\s*$", re.M)


def wall(argv: list[str]) -> tuple[float, str]:
    """Run argv, return (wall time in ms, stderr)."""
    start = time.perf_counter()
    done = subprocess.run(argv, capture_output=True, text=True, check=True)
    return (time.perf_counter() - start) * 1000, done.stderr


def main() -> None:
    """Print one line per round."""
    rounds = int(sys.argv[1])
    pause = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
    code = "import sift.search"
    print("  pass  import  importtime(sift.search)")
    for _ in range(rounds):
        empty, _ = wall(["python3", "-c", "pass"])
        plain, _ = wall(["python3", "-c", code])
        _, err = wall(["python3", "-X", "importtime", "-c", code])
        trace = int(TOTAL.search(err).group(1)) / 1000
        print(f"{empty:6.1f} {plain:7.1f} {trace:10.1f}")
        time.sleep(pause)


if __name__ == "__main__":
    main()
```

保存为 `$S/state.py`：

```text
$ python3 $S/state.py 12
  pass  import  importtime(sift.search)
  51.5   251.7      180.8
  49.8   250.4      181.9
  50.7   237.1      183.3
  51.4   231.8      180.9
  50.9   250.5      181.0
  51.1   234.3      184.8
  51.6   246.4      181.9
  51.1   249.2      172.4
  36.1   246.8      181.4
  50.2   246.5      177.5
  49.3   229.6      154.0
  40.7   187.2      128.7
```

前面十行里，空解释器 51 毫秒，整条命令 250 毫秒，`importtime` 说 181 毫秒，三个钟互相对得上，只是整台机器慢了两倍半；最后两行已经在往快状态切换。另一些时候空解释器只要 20.7 毫秒（下面的交替计时是那时跑的，`pass` 一行就是它的刻度）。所以绝对值不可比，比例才可比。

要知道去掉元数据真正省多少，得真的去掉它做对照。三个版本的 `sift/__init__.py`：原样（急切），PEP 562 的模块级 `__getattr__`（第一次用 `__version__` 时才 import 元数据），和一个字面量 `__version__ = "0.1.0"`。后两个放在 `$T/lazy` 和 `$T/lit` 里，是 `src/sift` 的副本加上改过的 `__init__.py`，`PYTHONPATH` 让它们排在可编辑安装前面：

```bash
for v in lazy lit; do
    mkdir -p $T/$v && cp -r src/sift $T/$v/
    find $T/$v -name __pycache__ -prune -exec rm -rf {} +
done
cat > $T/lazy/sift/__init__.py <<'EOF'
"""Sift: a local full-text search engine for Markdown posts."""


def __getattr__(name: str) -> str:
    """Compute __version__ on first use (PEP 562)."""
    if name == "__version__":
        from importlib.metadata import version

        return version("sift")
    raise AttributeError(f"module 'sift' has no attribute {name!r}")
EOF
cat > $T/lit/sift/__init__.py <<'EOF'
"""Sift: a local full-text search engine for Markdown posts."""

__version__ = "0.1.0"
EOF
```

`$S/alt.py` 轮流跑每条命令，每一轮换起点，顺序按 ABC、BCA、CAB 轮转，共 40 轮：

```python
"""Time command variants in alternation: A B C A B C ... (rounds).

usage: python3 alt.py ROUNDS LABEL=CMD [LABEL=CMD ...]
Each CMD is split with shlex. A PYTHONPATH=dir prefix is honoured.
The order is rotated every round so no variant always runs first.
"""

import os
import shlex
import statistics
import subprocess
import sys
import time


def run_once(command: str) -> float:
    """Run one command line, return its wall time in ms."""
    env = dict(os.environ)
    words = shlex.split(command)
    while "=" in words[0]:
        key, _, value = words.pop(0).partition("=")
        env[key] = value
    start = time.perf_counter_ns()
    subprocess.run(words, env=env, check=True, stdout=subprocess.DEVNULL)
    return (time.perf_counter_ns() - start) / 1e6


def main() -> None:
    """Alternate the variants and print median and min of each."""
    rounds = int(sys.argv[1])
    variants = [arg.split("=", 1) for arg in sys.argv[2:]]
    samples: dict[str, list[float]] = {name: [] for name, _ in variants}
    for i in range(rounds):
        shift = i % len(variants)
        for name, command in variants[shift:] + variants[:shift]:
            samples[name].append(run_once(command))
    base = statistics.median(samples[variants[0][0]])
    for name, times in samples.items():
        med = statistics.median(times)
        print(
            f"{name:<22} median {med:7.1f} ms  min {min(times):7.1f} ms"
            f"  x{med / base:.2f}"
        )


if __name__ == "__main__":
    main()
```

```text
$ python3 $S/alt.py 40 "pass=python3 -c pass" \
    "eager=python3 -c \"import sift.search\"" \
    "lazy=PYTHONPATH=$T/lazy python3 -c \"import sift.search\"" \
    "literal=PYTHONPATH=$T/lit python3 -c \"import sift.search\"" \
    "metadata=python3 -c \"import importlib.metadata\""
pass                   median    20.7 ms  min    18.2 ms  x1.00
eager                  median    98.5 ms  min    93.2 ms  x4.76
lazy                   median    81.4 ms  min    75.7 ms  x3.94
literal                median    82.1 ms  min    76.0 ms  x3.97
metadata               median    59.3 ms  min    52.9 ms  x2.87
```

`pass` 是 20.7 毫秒的空解释器；`import sift.search` 的原样版本 98.5 毫秒，字面量版本 82.1 毫秒，PEP 562 版本 81.4 毫秒，单独的 `import importlib.metadata` 是 59.3 毫秒。去掉元数据真正省下的是 16.4 毫秒，整条命令的 17%，而不是 `-X importtime` 记在它头上的 28 毫秒：孤立地 `import importlib.metadata` 要 38.6 毫秒（59.3 减 20.7），其中只有 16.4 毫秒是 Sift 独占的，剩下的 22.2 毫秒别的模块也要付。

账怎么算？好处是版本号单一来源；代价是整条命令的约 17% (16 ms)，也就是每个 `sift` 命令和每个测试进程多付 16 毫秒左右。`sift search` 光建索引就要约 2 秒，16 毫秒不到 1%；真正感觉得到的只有 `sift --version` 和 `sift --help`（下面冷热一节里 `sift --version` 是 125 毫秒，空解释器是 21 毫秒，16 毫秒占 13%）。PEP 562 那个版本对命令行帮助不大，因为 `cli.py` 顶部有 `from sift import __version__`，argparse 的 `version=` 在建解析器时就要字符串；要省就得让 `--version` 用一个自定义的 action 延后取值。另一个办法是反过来，在 `pyproject.toml` 里写 `dynamic = ["version"]`，由 hatchling 的 `regex` 版本源从 `__init__.py` 的字面量里读 (`hatchling/version/source/regex.py`)，这样 `__init__.py` 什么都不用 import，也不再需要安装才能 import；这个我没有试过，写在这里只是指一条路。结论是现在不动：16 毫秒买到一个不会错的版本号，我留着；我猜它值得动的那一天，是 `sift` 要接 shell 补全、每按一次 Tab 都要启动一次进程的时候。

### 冷启动与热启动

`.pyc` 呢？`sift --version` 冷的（先删掉 `src` 下所有 `__pycache__`，每个 sift 模块都要重新编译）和热的交替各跑 40 轮：

```python
"""Alternate cold and warm ``sift --version`` runs, ROUNDS times.

Cold means the .pyc files of sift are deleted first, so every sift
module is compiled again. Run from the repository root.
"""

import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path


def timed() -> float:
    """Run ``sift --version`` once, return wall time in ms."""
    start = time.perf_counter_ns()
    subprocess.run(["sift", "--version"], check=True, capture_output=True)
    return (time.perf_counter_ns() - start) / 1e6


def main() -> None:
    """Alternate cold, warm, cold, warm... and print the medians."""
    rounds = int(sys.argv[1])
    cold: list[float] = []
    warm: list[float] = []
    timed()
    for _ in range(rounds):
        for cache in Path("src").rglob("__pycache__"):
            shutil.rmtree(cache)
        cold.append(timed())
        warm.append(timed())
    for name, times in (("cold", cold), ("warm", warm)):
        print(f"{name}: median {statistics.median(times):.1f} ms")
    ratio = statistics.median(cold) / statistics.median(warm)
    print(f"cold/warm: {ratio:.2f}x over {rounds} rounds")


if __name__ == "__main__":
    main()
```

```text
$ python3 $S/cold_warm.py 40
cold: median 146.1 ms
warm: median 123.0 ms
cold/warm: 1.19x over 40 rounds
$ python3 $S/cold_warm.py 40
cold: median 146.1 ms
warm: median 123.6 ms
cold/warm: 1.18x over 40 rounds
$ hyperfine --warmup 3 --runs 30 'python3 -c pass' 'sift --version' 2>&1 | grep -E 'Benchmark|Time'
Benchmark 1: python3 -c pass
  Time (mean ± σ):      20.7 ms ±   2.5 ms    [User: 15.2 ms, System: 5.2 ms]
Benchmark 2: sift --version
  Time (mean ± σ):     124.7 ms ±   7.4 ms    [User: 102.3 ms, System: 21.1 ms]
```

保存为 `$S/cold_warm.py`，从仓库根目录跑。两次分别是 1.19 倍和 1.18 倍，冷的多花约 23 毫秒，是重新编译 `src/sift` 下 25 个 `.py` 的价钱。`python3 -c pass` 是 20.7 毫秒，`sift --version` 是 124.7 毫秒（上面最后一条 hyperfine）：一条除了 import 和建解析器什么都没做的命令，比空解释器多了约 104 毫秒。`lab/ch11/extra.sh` 里用 hyperfine 量冷热，是先跑完冷的再跑热的，不是交替：

```text
$ sed -n 1,9p out/ch11/startup.txt
Benchmark 1: cold (no sift .pyc)
  Time (mean ± σ):     134.8 ms ±  19.0 ms    [User: 112.2 ms, System: 21.3 ms]
  Range (min … max):   121.1 ms … 218.7 ms    30 runs

Benchmark 2: warm (.pyc present)
  Time (mean ± σ):     105.6 ms ±   1.5 ms    [User: 85.0 ms, System: 19.7 ms]
  Range (min … max):   102.1 ms … 109.0 ms    30 runs

Summary
$ tail -1 out/ch11/startup.txt
    1.28 ± 0.18 times faster than cold (no sift .pyc)
```

`extra.sh` 里的 hyperfine 我跑过好几次，冷热比在 1.15 到 1.28 倍之间浮动，这里贴的是最后一次（冷的那一组标准差有 19 毫秒，是最吵的一次）；上面交替脚本的两次是 1.19 倍和 1.18 倍。

### 推迟一个 import

既然 import 花钱，就想推迟。`lab/ch11/lazy_import.py` 在新的解释器里量五种写法：什么都不做、立刻 `import asyncio`、把 import 放进一个没被调用的函数、用 `importlib.util.LazyLoader` 注册但不碰、注册之后读一个属性。它不是交替计时的（每个变体连跑 15 次取中位数），所以只看量级：

```text
$ python3 lab/ch11/lazy_import.py
   17.2 ms  (+  0.6)  nothing
   64.8 ms  (+ 48.2)  eager import asyncio
   17.1 ms  (+  0.5)  import inside a function, never called
   17.7 ms  (+  1.1)  LazyLoader, never touched
   65.7 ms  (+ 49.1)  LazyLoader, one attribute read
```

`asyncio` 的 import 要多花约 48 毫秒；放进函数或用 `LazyLoader` 而没用到时，几乎不花钱（+0.5 和 +1.1）；`LazyLoader` 读了一个属性，又付了全价（+49.1）。懒加载是把钱挪到第一次用的时候，不是省钱。`cli.py` 里别的标准库 import（`subprocess`、`shlex`、`statistics`）我没有逐个量，我猜都很轻，所以 Sift 现在没有值得挪的。
## argparse

`cli.py` 是新文件，375 行，里面 `build_parser()` 一个函数约 70 行，建出整个命令行。节选它的骨架：

```python
# src/sift/cli.py:271-283 and 296-306 and 312 and 325-338
    parser = argparse.ArgumentParser(
        prog="sift",
        description="Search the Markdown posts of a blog.",
        epilog=(
            "exit codes: 0 ok, 2 usage, 3 bad query, 4 no index, 1 other error"
        ),
    )
    parser.add_argument(
        "--version", action="version", version=f"sift {__version__}"
    )
    commands = parser.add_subparsers(
        title="commands", dest="command", metavar="COMMAND", required=True
    )
# ...
    cmd = commands.add_parser("search", help="search the index")
    cmd.add_argument(
        "query", nargs="+", help="query words; a lone - reads stdin"
    )
    cmd.add_argument(
        "--limit",
        type=positive_int,
        default=10,
        help="most hits to print (default: %(default)s)",
    )
    cmd.add_argument("--json", action="store_true", help="print JSON")
# ...
    cmd.set_defaults(func=run_search)
# ...
    cmd = commands.add_parser("bench", help="time indexing or searching")
    kinds = cmd.add_subparsers(
        title="benchmarks", dest="kind", metavar="KIND", required=True
    )
    sub = kinds.add_parser("index", help="time in-memory index builds")
    sub.add_argument(
        "--repeat",
        type=positive_int,
        default=8,
        help="number of builds (default: %(default)s)",
    )
    sub.set_defaults(func=run_bench_index)
    sub = kinds.add_parser("search", help="run bench/queries.txt")
    sub.set_defaults(func=run_bench_search)
```

几点值得拆开说。

**`add_subparsers` 返回什么。** 它返回一个 `_SubParsersAction`，里面是“名字到解析器”的字典；解析时它把名字后面的所有参数交给对应的子解析器：

```python
# Lib/argparse.py:1290-1300 and 1318 (CPython v3.14.7)
    def __call__(self, parser, namespace, values, option_string=None):
        parser_name = values[0]
        arg_strings = values[1:]

        # set the parser name if requested
        if self.dest is not SUPPRESS:
            setattr(namespace, self.dest, parser_name)

        # select the parser
        try:
            subparser = self._name_parser_map[parser_name]
# ...
        subnamespace, arg_strings = subparser.parse_known_args(arg_strings, None)
```

`required=True` 让 `sift`（不带命令）报错而不是悄悄通过，`dest="command"` 把选中的名字存下来；`metavar="COMMAND"` 决定帮助里写什么。每个子解析器用 `set_defaults(func=run_xxx)` 把自己的处理函数放进命名空间，`main()` 解析完直接 `args.func(args)`，这就是 ch10 里那串 `if args[:1] == ["search"]` 的替代品。`bench` 自己还有一层子解析器（`index` 和 `search`），所以 `sift bench` 单独一个词也会报错，见下面。

**`type=` 是一个可调用对象。** `positive_int` 是我写的：

```python
# src/sift/cli.py:97-107
def positive_int(text: str) -> int:
    """Convert text to an int greater than zero, for argparse."""
    try:
        number = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"invalid int value: {text!r}"
        ) from None
    if number < 1:
        raise argparse.ArgumentTypeError(f"must be at least 1: {text!r}")
    return number
```

argparse 怎么处理它？`ArgumentTypeError` 的消息原样当错误信息，`ValueError` 和 `TypeError` 换成一句通用的 `invalid <类型名> value: ...`（对 `int` 就是 `invalid int value`）：

```python
# Lib/argparse.py:2649-2671 (CPython v3.14.7)
    def _get_value(self, action, arg_string):
        type_func = self._registry_get('type', action.type, action.type)
        if not callable(type_func):
            raise TypeError(f'{type_func!r} is not callable')

        # convert the value to the appropriate type
        try:
            result = type_func(arg_string)

        # ArgumentTypeErrors indicate errors
        except ArgumentTypeError as err:
            msg = str(err)
            raise ArgumentError(action, msg)

        # TypeErrors or ValueErrors also indicate errors
        except (TypeError, ValueError):
            name = getattr(action.type, '__name__', repr(action.type))
            args = {'type': name, 'value': arg_string}
            msg = _('invalid %(type)s value: %(value)r')
            raise ArgumentError(action, msg % args)

        # return the converted value
        return result
```

所以我自己的 `positive_int` 在 `int(text)` 失败时抛 `ArgumentTypeError`，消息写得和通用版本一样；整数小于 1 时给出自己的话。类型函数是放校验的好地方，因为它的错误会被 argparse 带上选项名，变成一条标准的用法错误。

`choices`、`nargs` 和互斥组，`cli.py` 现在都没有用到：

```text
$ grep -c mutually_exclusive src/sift/cli.py
0
```

所以我写一个小解析器把它们和 `type=` 放在一起试，形状像 `sift search`。`positive_int` 直接从 `sift.cli` 导入：

```python
"""argparse: types, choices, nargs, mutually exclusive groups."""

import argparse
import contextlib
import io

from sift.cli import positive_int


def build() -> argparse.ArgumentParser:
    """Return a small parser shaped like ``sift search``."""
    parser = argparse.ArgumentParser(prog="demo")
    parser.add_argument("query", nargs="+")
    parser.add_argument("--limit", type=positive_int, default=10)
    parser.add_argument("--order", choices=["score", "date"], default="score")
    parser.add_argument("--jobs", type=int, nargs="?", const=0, default=1)
    shape = parser.add_mutually_exclusive_group()
    shape.add_argument(
        "--json", dest="shape", action="store_const", const="json"
    )
    shape.add_argument(
        "--tsv", dest="shape", action="store_const", const="tsv"
    )
    return parser


def attempt(argv: list[str]) -> None:
    """Parse argv; print the namespace, or the exit code and message."""
    err = io.StringIO()
    print("$ demo", " ".join(argv))
    try:
        with contextlib.redirect_stderr(err):
            args = build().parse_args(argv)
    except SystemExit as stop:
        message = err.getvalue().strip().splitlines()[-1]
        print(f"  exit {stop.code}: {message}")
    else:
        print(f"  {vars(args)}")


def main() -> None:
    """Run the parser on good and bad command lines."""
    for argv in (
        ["device", "tree", "--limit", "3"],
        ["rust", "--json", "--order", "date"],
        ["rust", "--jobs"],
        ["rust", "--limit", "0"],
        ["rust", "--limit", "many"],
        ["rust", "--order", "size"],
        ["rust", "--json", "--tsv"],
        ["--limit", "3"],
        ["rust", "--lim", "2"],
        ["rust", "--no-such"],
    ):
        attempt(argv)


if __name__ == "__main__":
    main()
```

保存为 `$S/args_demo.py`：

```text
$ python3 $S/args_demo.py
$ demo device tree --limit 3
  {'query': ['device', 'tree'], 'limit': 3, 'order': 'score', 'jobs': 1, 'shape': None}
$ demo rust --json --order date
  {'query': ['rust'], 'limit': 10, 'order': 'date', 'jobs': 1, 'shape': 'json'}
$ demo rust --jobs
  {'query': ['rust'], 'limit': 10, 'order': 'score', 'jobs': 0, 'shape': None}
$ demo rust --limit 0
  exit 2: demo: error: argument --limit: must be at least 1: '0'
$ demo rust --limit many
  exit 2: demo: error: argument --limit: invalid int value: 'many'
$ demo rust --order size
  exit 2: demo: error: argument --order: invalid choice: 'size' (choose from 'score', 'date')
$ demo rust --json --tsv
  exit 2: demo: error: argument --tsv: not allowed with argument --json
$ demo --limit 3
  exit 2: demo: error: the following arguments are required: query
$ demo rust --lim 2
  {'query': ['rust'], 'limit': 2, 'order': 'score', 'jobs': 1, 'shape': None}
$ demo rust --no-such
  exit 2: demo: error: unrecognized arguments: --no-such
```

逐条看：`--order` 是 `choices`，错误会列出所有合法值；`--jobs` 带 `nargs="?"` 和 `const=0`，不给值时取 `const`，不写时取 `default`（第 3 条）；`--json` 和 `--tsv` 在同一个互斥组里，用 `dest="shape"` 和 `store_const` 写进同一个字段，同时给就报 `not allowed with argument --json`，检查在这里：

```python
# Lib/argparse.py:2112-2118 (CPython v3.14.7)
            if action.option_strings or argument_strings:
                seen_non_default_actions.add(action)
                for conflict_action in action_conflicts.get(action, []):
                    if conflict_action in seen_non_default_actions:
                        msg = _('not allowed with argument %s')
                        action_name = _get_action_name(conflict_action)
                        raise ArgumentError(action, msg % action_name)
```

`query` 是 `nargs="+"`，一个词都没有就报 `the following arguments are required: query`。有一条我没想到：`--lim 2` 被接受了。argparse 默认允许长选项的唯一前缀缩写 (`allow_abbrev=True`)，所以今天的 `--lim` 就是 `--limit`；以后如果我加一个 `--limit-per-file`，`--lim` 就变成歧义，用户的脚本会坏。需要关掉它的人，构造时传 `allow_abbrev=False`。

最后是错误怎么变成退出码 2：所有这些错误最终走到 `ArgumentParser.error`，打印 usage 和消息，`exit(2)`：

```python
# Lib/argparse.py:2774 and 2783-2785 (CPython v3.14.7)
    def error(self, message):
# ...
        self.print_usage(_sys.stderr)
        args = {'prog': self.prog, 'message': message}
        self.exit(2, _('%(prog)s: error: %(message)s\n') % args)
```

上面 `args_demo` 的每个“exit 2”都是它。`sift` 的契约里“退出码 2 是用法错误”，一行代码没写，是 argparse 白送的，真正的 `sift` 也一样（第二条走的是 `python3 -m sift`，usage 的第一行和 `sift` 的一样）：

```text
$ sift search --limit 0 rust; echo $?
usage: sift search [-h] [--limit LIMIT] [--json] [--no-log] query [query ...]
sift search: error: argument --limit: must be at least 1: '0'
2
$ python3 -m sift; echo $?
usage: sift [-h] [--version] COMMAND ...
sift: error: the following arguments are required: COMMAND
2
$ sift bench; echo $?
usage: sift bench [-h] KIND ...
sift bench: error: the following arguments are required: KIND
2
```

帮助页也是白送的（`sift --help` 会列出六个命令、`--version` 和 epilog）。`prog="sift"` 让 usage 的第一行不依赖入口（前面 `prog_default.py` 那个实验）；`epilog` 里是退出码，`%(default)s` 在各选项的帮助里展开成默认值，`--version` 是 `action="version"`，打印后以 0 退出。测试要能不起进程就调用命令行，所以 `main` 接收 `argv`，`parse_args(None)` 就用 `sys.argv[1:]`：

```python
# tests/test_cli.py:30-35
def run_main(*args: str) -> int:
    """Run main() with the args; return the exit status."""
    with pytest.raises(SystemExit) as caught:
        cli.main(args)
    assert isinstance(caught.value.code, int)
    return caught.value.code
```

## 进程的周围

### 环境变量与 SIFT_INDEX

环境变量是进程的一个字典，`os.environ` 是它的映射视图（类型 `_Environ`，键和值都是 `str`），赋值会调用 `putenv`，所以子进程能看到：

```text
$ python3 lab/ch11/process_env.py
sys.argv: ['process_env.py']
sys.orig_argv[:1]: ['python3']
pid > 0, parent pid > 0: True True
SIFT_INDEX: None
child sees: /tmp/demo-index
os.environ is a _Environ
os.environ values are str: True
exit statuses of child interpreters:
    0  pass
    3  import sys; sys.exit(3)
    1  import sys; sys.exit('message')
    0  import sys; sys.exit(None)
    1  raise RuntimeError('boom')
    7  import os; os._exit(7)
streams:
  <stdin>   fd=0 encoding=utf-8 tty=False
  <stdout>  fd=1 encoding=utf-8 tty=False
  <stderr>  fd=2 encoding=utf-8 tty=False
to stdout
to stderr
```

`lab/ch11/process_env.py` 的输出：`sys.argv` 是脚本路径加参数（我用 `basename` 去掉了目录），`sys.orig_argv` 是解释器的完整命令行（`-m`、`-c` 这些选项在里面，`sys.argv` 里没有）；设置 `SIFT_INDEX` 之后子进程读到了同一个值；子进程的退出状态表：`sys.exit(3)` 是 3，`sys.exit("message")` 把消息打到 stderr 然后退出 1，`sys.exit(None)` 是 0，未捕获的异常是 1，`os._exit(7)` 不经过清理直接退出。三个标准流在管道里都不是 tty (`tty=False`)，编码是 `utf-8`。

Sift 读一个环境变量，`SIFT_INDEX`，是索引目录。索引还没有落盘，所以现在它只有一个作用：设了它而目录不存在，读索引的命令退出 4：

```python
# src/sift/cli.py:80-94
def index_dir() -> Path | None:
    """Return the directory named by SIFT_INDEX, or None if unset."""
    value = os.environ.get("SIFT_INDEX")
    return Path(value) if value else None


def check_index_dir() -> None:
    """Raise IndexMissingError if SIFT_INDEX names a missing directory.

    With SIFT_INDEX unset there is nothing to check: until chapter 12
    the index lives in memory and is built on demand.
    """
    path = index_dir()
    if path is not None and not path.is_dir():
        raise IndexMissingError(f"no index at {path}, run 'sift index' first")
```

`cli.py` 的模块 docstring 里也这么写（第 7 到 12 行）。设成一个存在的目录，命令照旧在内存里建索引（`test_existing_index_dir_still_searches_in_memory` 测的就是这件事）。

### 退出码

契约是：0 成功（零命中也是成功），2 用法错误，3 查询语法错误（把 `render()` 的两行打到 stderr），4 索引缺失，1 其余的 `SiftError`。`main()` 把异常翻译成这几个数：

```python
# src/sift/cli.py:352-367
    setup_logging()
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except QuerySyntaxError as error:
        print(error.render(), file=sys.stderr)
        sys.exit(3)
    except IndexMissingError as error:
        print(f"sift: {error}", file=sys.stderr)
        sys.exit(4)
    except SiftError as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        sys.exit(130)
```

后面还有一个 `except ExceptionGroup`，是第 9 篇的那段，没变。`sys.exit(n)` 在 `main` 里调用，入口脚本里 `sys.exit(main())` 对 `None` 给 0。逐个跑一遍：

```text
$ sift search '(rust'; echo $?
expected ')'
  (rust
       ^
3
$ SIFT_INDEX=/nonexistent sift search kalman; echo $?
sift: no index at /nonexistent, run 'sift index' first
4
$ sift show 999999; echo $?
error: no document with id 999999
1
$ sift search --limit 2 --json kalman | jq -c ".hits[] | {doc_id, title, score}"
load_index took 1986.7 ms
{"doc_id":14,"title":"一维卡尔曼滤波：两个高斯相乘","score":5.0716688692750855}
{"doc_id":15,"title":"升到高维：多变量卡尔曼滤波的推导与实现","score":4.694905649916683}
```

前三条分别是 3、4、1，最后一条是正常的 JSON 查询，带出了 `load_index took 1986.7 ms`（`@timed` 打到 stderr 的）。`'(rust'` 那条是“快速失败”：`run_search` 在建索引之前先 `parse(query)`：

```python
# src/sift/cli.py:163-170
def run_search(args: argparse.Namespace) -> None:
    """Print the best documents for the query."""
    check_index_dir()
    query = read_query(args.query)
    parse(query)  # fail fast: a typo must not cost an index build
    start = time.perf_counter()
    pipeline = build_pipeline()
    documents, index = load_index(CORPUS, pipeline)
```

第 8 篇我提过一个缺口，打错一个括号要等索引建完（两秒）才报错。现在：

```text
$ TIMEFORMAT='%R s'; time sift search '(rust' 2>/dev/null
0.109 s
```

0.109 秒，不是两秒，几乎全是解释器启动加 import，和冷热一节里 `sift --version` 的 105.6 毫秒差不多。

### subprocess

`sift open DOC_ID` 是整个 CLI 里唯一启动别的程序的地方：

```python
# src/sift/cli.py:226-235
def run_open(args: argparse.Namespace) -> None:
    """Open one document in $EDITOR (default vi)."""
    doc = find_document(args.doc_id)
    editor = os.environ.get("EDITOR", "vi")
    try:
        done = subprocess.run([*shlex.split(editor), str(doc.path)])
    except FileNotFoundError:
        raise SiftError(f"cannot run editor {editor!r}") from None
    if done.returncode != 0:
        raise SiftError(f"{editor} exited with status {done.returncode}")
```

三个细节：命令用列表传，不经过 shell；`$EDITOR` 可能带参数 (`code -w`)，所以先 `shlex.split`，再拼上文件名；编辑器不存在是 `FileNotFoundError`，退出码非零是我自己的 `SiftError`，两个都走退出码 1：

```text
$ EDITOR=true sift open 0; echo $?
0
$ EDITOR=false sift open 0; echo $?
error: false exited with status 1
1
$ EDITOR=no-such-editor sift open 0; echo $?
error: cannot run editor 'no-such-editor'
1
```

`true` 退出 0，命令成功；`false` 退出 1，报 `false exited with status 1`；不存在的编辑器报 `cannot run editor`。`lab/ch11/subprocess_demo.py` 把 `subprocess.run` 的几个旋钮各跑了一遍：

```text
$ python3 lab/ch11/subprocess_demo.py
returncode: 0
stdout: 'sift 0.1.0\n'
args: ['python3', '-m', 'sift', '--version']
check=True raised: 3 CalledProcessError
timeout raised after 0.3 s
input=: FROM STDIN
stderr merged: ['out', 'err']
shell=True with a bad name: ['my notes', 'INJECTED']
argument list: my notes; echo INJECTED
shlex.quote: 'my notes; echo INJECTED'
shlex.split: ['vim', '-c', 'set ft=md', 'note.md']
quoted for the shell: my notes; echo INJECTED
missing program: FileNotFoundError [Errno 2] No such file or directory: 'no-such-program-sift'
```

`capture_output=True, text=True` 拿到 `str`；`check=True` 在非零退出时抛 `CalledProcessError`；`timeout` 超时抛 `TimeoutExpired`（同时杀掉子进程）；`input=` 往子进程的 stdin 写；`stderr=STDOUT` 把两路合并。最后几行是 shell 的坑，也是这个脚本里唯一一处故意写错的地方：

```python
# lab/ch11/subprocess_demo.py:54-61
    name = "my notes; echo INJECTED"
    # BAD: a string with shell=True runs whatever the name contains
    unsafe = subprocess.run(
        f"echo {name}", shell=True, capture_output=True, text=True
    )
    print("shell=True with a bad name:", unsafe.stdout.split("\n")[:2])
    safe = subprocess.run(["echo", name], capture_output=True, text=True)
    print("argument list:", safe.stdout.strip())
```

`shell=True` 配一个拼出来的字符串，文件名里的分号就变成了命令分隔符，`INJECTED` 真的被执行了（输出里 `['my notes', 'INJECTED']` 那行）；列表形式拿到的是原样的字符串；必须过 shell 的时候用 `shlex.quote`。

### signal

Ctrl-C 是一个信号。Python 启动时给 `SIGINT` 装了一个默认处理函数，把它翻译成 `KeyboardInterrupt`：

```text
$ python3 lab/ch11/signals_demo.py
default SIGINT handler: default_int_handler
default handler raised KeyboardInterrupt
handler ran: ['SIGINT']
SIGINT ignored, still running
alarm interrupted sleep: alarm fired
child exit status after SIGTERM: -15
that is SIGTERM
sift on Ctrl-C: 130 interrupted
SIGKILL cannot be caught: [Errno 22] Invalid argument
```

`lab/ch11/signals_demo.py` 的前半段给自己发信号：默认处理函数抛 `KeyboardInterrupt`；换成自己的函数，信号变成一次函数调用；`SIG_IGN` 让它什么也不发生；`alarm(1)` 加 `SIGALRM` 处理函数打断了一次 `sleep(5)`。后半段给子进程发 `SIGTERM`，`Popen.wait()` 返回 `-15`：负数表示“被这个信号杀死”，不是退出码。`SIGKILL` 不能被捕获，`signal.signal` 直接拒绝 (`OSError`)。

那 `sift` 自己被 Ctrl-C 会怎样？`ctrl_c.py` 在 `sift search rust` 建索引的过程中（1 秒后）发一个 `SIGINT`：

```python
"""Send SIGINT to a running ``sift search`` and see how it ends."""

import signal
import subprocess
import time


def main() -> None:
    """Start the CLI, interrupt it mid-index, print how it died."""
    child = subprocess.Popen(
        ["sift", "search", "rust"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    time.sleep(1.0)
    child.send_signal(signal.SIGINT)
    _, err = child.communicate()
    lines = err.strip().splitlines()
    code = child.returncode
    print("returncode:", code)
    if code < 0:
        print("killed by signal:", signal.Signals(-code).name)
    print("last stderr line:", lines[-1])
    print("stderr lines:", len(lines))


if __name__ == "__main__":
    main()
```

保存为 `$S/ctrl_c.py`，从仓库根目录跑。我先拿第一版（`git archive 7567993 src` 解到 `$T/old`，用 `PYTHONPATH` 排到前面），再拿现在的：

```bash
mkdir -p $T/old && git archive 7567993 src | tar -x -C $T/old
```

```text
$ PYTHONPATH=$T/old/src python3 $S/ctrl_c.py
returncode: -2
killed by signal: SIGINT
last stderr line: KeyboardInterrupt
stderr lines: 31
$ python3 $S/ctrl_c.py
returncode: 130
last stderr line: interrupted
stderr lines: 2
```

第一版的 `main()` 没有捕获 `KeyboardInterrupt`：31 行回溯，`returncode` 是 `-2`，进程是被 `SIGINT` 杀死的（shell 里看到的是 130）。我觉得这对命令行工具不体面，所以 `main()` 多了一个分支（上一节节选里的 `except KeyboardInterrupt`）：`interrupted` 打到 stderr，退出码 130，也就是 `128 + SIGINT`；输出里的两行是 `load_index took` 和 `interrupted`。`signals_demo.py` 里那行 `sift on Ctrl-C: 130 interrupted` 是同一件事的快速版：它在子进程里把 `run_stats` 换成给自己发 `SIGINT` 的函数，再调 `main`。

还有一个和进程环境有关的地方：当前目录。`CORPUS = Path("corpus/posts")` 是相对路径，只有在仓库根目录下才找得到语料。第一版在别的目录里什么也不报，第二条是现在的样子：

```text
$ cd /tmp && PYTHONPATH=$T/old/src sift search rust; echo $?
load_index took 0.2 ms
0 hits in 0 files: index built in 0.2 ms, query took 0.087 ms
0
$ cd /tmp && sift search rust; echo $?
load_index took 0.0 ms
error: no corpus at corpus/posts
1
```

第一版说“0 个命中，0 个文件”，退出码 0：“语料目录不存在”和“零命中”被混成了同一个成功。现在 `load_index` 和 `find_document` 先调 `check_corpus`：

```python
# src/sift/cli.py:47-50
def check_corpus(root: Path) -> None:
    """Raise SiftError if root is not a directory."""
    if not root.is_dir():
        raise SiftError(f"no corpus at {root}")
```

缺的是语料不是索引，所以退出码是通用的 1，不是 4。

## 旧命令还能用吗

第 3 篇起的 `python3 -m sift search ...`、`python3 -m sift stats` 都照旧能用（`-m` 经过 `__main__.py` 到同一个 `main`），`sift` 只是同一个 `main` 的另一个入口；唯一不兼容的是第 8 篇的裸 `bench`，它现在叫 `bench search`（同时多了 `bench index`），裸 `bench` 退出码是 2：

```text
$ python3 -m sift stats | sed -n 1,2p
load_index took 5367.5 ms
documents: 123
vocabulary: 81192
$ python3 -m sift search --limit 1 --json kalman | jq -c ".hits[0].title"
load_index took 2272.9 ms
"一维卡尔曼滤波：两个高斯相乘"
$ python3 -m sift bench search | tail -2
load_index took 2234.0 ms
  163.95 ms     6 hits  owner*
 1220.65 ms  total for 12 queries
$ python3 -m sift bench; echo $?
usage: sift bench [-h] KIND ...
sift bench: error: the following arguments are required: KIND
2
```

第 4、8、9 篇的实验脚本原来是 `from sift.__main__ import CORPUS, load_index`，而 `__main__.py` 现在只剩 6 行，所以我把它们改成了 `from sift.cli import ...`，一共 6 个文件（`lab/ch04/tfidf_vs_tf.py`、`lab/ch08` 下的 4 个和 `lab/ch09/index_bad_files_fail.py`），文件表里有一条命令数它们。

## 跑一遍

整章一个 `make` 目标加 `make lint`，再加完整的测试：

```text
$ make lint
ruff format --check --line-length 79 .
197 files already formatted
ruff check .
All checks passed!
$ make ch11 2>&1 | grep -E "^ok"
ok   lab/ch11/all_and_star.py
ok   lab/ch11/circular_import_fail.py
ok   lab/ch11/custom_finder.py
ok   lab/ch11/lazy_import.py
ok   lab/ch11/module_attrs.py
ok   lab/ch11/namespace_pkg_demo.py
ok   lab/ch11/process_env.py
ok   lab/ch11/relative_import_fail.py
ok   lab/ch11/relative_imports_demo.py
ok   lab/ch11/signals_demo.py
ok   lab/ch11/subprocess_demo.py
ok   lab/ch11/sys_modules_cache.py
ok   lab/ch11/sys_path.py
ok   lab/ch11/extra.sh
```

```text
$ python3 -m pytest 2>&1 | tail -1
338 passed, 1 xfailed in 4.73s
$ python3 -m pytest tests/test_cli.py tests/test_analysis.py 2>&1 | tail -1
68 passed in 0.90s
$ git diff --shortstat ch10 ch11
 50 files changed, 1614 insertions(+), 302 deletions(-)
```

`extra.sh` 的输出上面各节都出现过。测试 338 个通过、1 个预期失败，和第 10 篇的 312 个相比多了 26 个（`tests/test_cli.py` 现在有 37 个，取代了 `tests/test_main.py` 里原来的 12 个，加上 `tests/test_analysis.py` 里新增的 1 个）。

`extra.sh` 里有一个我差点没发现的坑。它原来用 `| head -15` 截取前 15 行，而脚本开着 `set -o pipefail`：`head` 读够就退出，上游命令再写就收到 SIGPIPE，整条管道的状态成了 141，脚本悄悄退出。是否发生取决于上游写得多快，所以我本地没撞到，是打标签前的一次 CI 跑出来的。最小复现如下，以及把 `head` 换成读完全部输入的 `sed -n`（现在的 `extra.sh` 就是这么写的）之后的样子：

```text
$ bash -c 'set -eo pipefail; seq 100000 | head -1; echo survived'; echo "exit $?"
1
exit 141
$ bash -c 'set -eo pipefail; seq 100000 | sed -n 1p; echo survived'; echo "exit $?"
1
survived
exit 0
```

## 本篇文件

这一章动了 50 个文件（上一节最后一块里的 `git diff --shortstat ch10 ch11`）：4 个新增、7 个改动、2 个删除、8 个更早章节的实验脚本、29 个在 `lab/ch11` 下（其中 4 个辅助包目录里有 15 个文件）。结果列是我在本篇环境里重新跑出来的；`lab/ch11` 下每个脚本的命令都是 `python3 lab/ch11/<名字>.py`，计时和对象地址以外的输出是确定的。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`pyproject.toml`](https://github.com/bfmhno3/sift/blob/ch11/pyproject.toml) | `python3 -c 'import tomllib; print(tomllib.load(open("pyproject.toml", "rb"))["project"]["scripts"])'` | 退出码 0，输出 `{'sift': 'sift.cli:main'}`；25 行 |
| `pytest.ini`、`tests/test_main.py`（已删除，所以没有链接） | `git ls-files pytest.ini tests/test_main.py \| wc -l` | 退出码 0，输出 `0`：前者搬进了 `pyproject.toml`，后者被 `tests/test_cli.py` 取代 |
| [`src/sift/__init__.py`](https://github.com/bfmhno3/sift/blob/ch11/src/sift/__init__.py) | `python3 -c 'import sift; print(sift.__version__)'` | 退出码 0，输出 `0.1.0`；5 行 |
| [`src/sift/__main__.py`](https://github.com/bfmhno3/sift/blob/ch11/src/sift/__main__.py) | `python3 -m sift --version` | 退出码 0，输出 `sift 0.1.0`；6 行 |
| [`src/sift/cli.py`](https://github.com/bfmhno3/sift/blob/ch11/src/sift/cli.py) | `sift search '(rust'; echo $?` | 退出码 0（`echo` 的），stderr 三行 `expected ')'`、查询行、`^` 行，stdout 最后一行 `3`；375 行 |
| [`src/sift/analysis/stopwords.txt`](https://github.com/bfmhno3/sift/blob/ch11/src/sift/analysis/stopwords.txt) | `wc -w src/sift/analysis/stopwords.txt` | 退出码 0，输出 `25 src/sift/analysis/stopwords.txt` |
| [`src/sift/analysis/filters.py`](https://github.com/bfmhno3/sift/blob/ch11/src/sift/analysis/filters.py) | `python3 -c 'from sift.analysis import STOPWORDS; print(len(STOPWORDS))'` | 退出码 0，输出 `25`（通过 `importlib.resources` 读上面那个文件） |
| [`tests/test_cli.py`](https://github.com/bfmhno3/sift/blob/ch11/tests/test_cli.py) | `python3 -m pytest tests/test_cli.py \| tail -1` | 退出码 0，`37 passed in 0.83s`；316 行 |
| [`tests/test_analysis.py`](https://github.com/bfmhno3/sift/blob/ch11/tests/test_analysis.py) | `python3 -m pytest tests/test_analysis.py \| tail -1` | 退出码 0，`31 passed in 0.57s`（新增 `test_stopwords_come_from_the_resource_file`） |
| [`flake.nix`](https://github.com/bfmhno3/sift/blob/ch11/flake.nix) | `grep -n unset flake.nix` | 退出码 0，输出 `88:            unset PYTHONPATH _PYTHON_SYSCONFIGDATA_NAME _PYTHON_HOST_PLATFORM` |
| [`Makefile`](https://github.com/bfmhno3/sift/blob/ch11/Makefile) | `make -n test` | 退出码 0，输出 `python3 -m pytest` |
| [`README.md`](https://github.com/bfmhno3/sift/blob/ch11/README.md) | `git diff --shortstat ch10 ch11 -- README.md` | 退出码 0，`1 file changed, 5 insertions(+), 2 deletions(-)` |
| [`lab/ch04/tfidf_vs_tf.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch04/tfidf_vs_tf.py)、[`lab/ch08/bm25_by_hand.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch08/bm25_by_hand.py)、[`lab/ch08/bm25_params.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch08/bm25_params.py)、[`lab/ch08/phrase_search.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch08/phrase_search.py)、[`lab/ch08/queries_bench.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch08/queries_bench.py)、[`lab/ch09/index_bad_files_fail.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch09/index_bad_files_fail.py) | `grep -l 'from sift.cli import' lab/ch04/*.py lab/ch08/*.py lab/ch09/*.py \| wc -l` | 退出码 0，输出 `6`（`sift.__main__` 改成了 `sift.cli`） |
| [`lab/ch10/extra.sh`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch10/extra.sh)、[`lab/ch10/pytest_features.sh`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch10/pytest_features.sh) | `grep -c 'python3 -m pytest' lab/ch10/extra.sh lab/ch10/pytest_features.sh` | 退出码 0，每个文件 1 处（`pytest()` 函数；后者另把 `tests/test_main.py` 换成了 `tests/test_cli.py`） |
| [`lab/ch11/module_attrs.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch11/module_attrs.py) | `python3 lab/ch11/module_attrs.py` | 退出码 0，第一行 `this script:`，最后一行 `modules are objects: <class 'module'> True` |
| [`lab/ch11/sys_path.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch11/sys_path.py) | `python3 lab/ch11/sys_path.py` | 退出码 0，第一行 `sys.path[0] is the script directory: ~/Projects/sift/lab/ch11` |
| [`lab/ch11/sys_modules_cache.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch11/sys_modules_cache.py) | `python3 lab/ch11/sys_modules_cache.py` | 退出码 0，第一行 `same object: True`，最后一行是 `None in sys.modules: import of json halted; None in sys.modules` |
| [`lab/ch11/relative_imports/`](https://github.com/bfmhno3/sift/tree/ch11/lab/ch11/relative_imports)(`__init__.py`, `a.py`, `b.py`)、[`lab/ch11/relative_imports_demo.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch11/relative_imports_demo.py) | `python3 lab/ch11/relative_imports_demo.py` | 退出码 0，第一行 `package: relative_imports`，`double(5) = 11` |
| [`lab/ch11/relative_import_fail.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch11/relative_import_fail.py) | `python3 lab/ch11/relative_import_fail.py` | 退出码 1：`ImportError: attempted relative import with no known parent package`（文件里有对应的 `# error:` 注释） |
| [`lab/ch11/circular/`](https://github.com/bfmhno3/sift/tree/ch11/lab/ch11/circular)（`__init__.py`、`a.py`、`b.py` 和四个 `fix_*` 模块）、[`lab/ch11/circular_import_fail.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch11/circular_import_fail.py) | `python3 lab/ch11/circular_import_fail.py` | 退出码 1：前四行是两种修法的 `11`，接着是捕获后检查 `sys.modules` 的两行 `False`，最后 `ImportError: cannot import name 'a_value' from partially initialized module 'circular.a'` |
| [`lab/ch11/namespace/`](https://github.com/bfmhno3/sift/tree/ch11/lab/ch11/namespace)(`one/nspkg/alpha.py`, `two/nspkg/beta.py`)、[`lab/ch11/namespace_pkg_demo.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch11/namespace_pkg_demo.py) | `python3 lab/ch11/namespace_pkg_demo.py` | 退出码 0，第一行 `alpha lives in: one`，`__path__ is a _NamespacePath` |
| [`lab/ch11/star_pkg/`](https://github.com/bfmhno3/sift/tree/ch11/lab/ch11/star_pkg)(`__init__.py`, `with_all.py`, `without_all.py`)、[`lab/ch11/all_and_star.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch11/all_and_star.py) | `python3 lab/ch11/all_and_star.py` | 退出码 0，第一行 `with __all__:    ['public', 'CONSTANT']`，没有 `__all__` 的那个星号导入带出了 `json` |
| [`lab/ch11/custom_finder.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch11/custom_finder.py) | `python3 lab/ch11/custom_finder.py` | 退出码 0，第一行 `virtual_hello.GREETING: hi from a string` |
| [`lab/ch11/lazy_import.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch11/lazy_import.py) | `python3 lab/ch11/lazy_import.py` | 退出码 0，5 行计时，第一行以 `nothing` 结尾，数值每次不同 |
| [`lab/ch11/process_env.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch11/process_env.py) | `python3 lab/ch11/process_env.py` | 退出码 0，第一行 `sys.argv: ['process_env.py']`，最后一行 (stderr) `to stderr` |
| [`lab/ch11/subprocess_demo.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch11/subprocess_demo.py) | `python3 lab/ch11/subprocess_demo.py` | 退出码 0，第一行 `returncode: 0`，`stdout: 'sift 0.1.0\n'` |
| [`lab/ch11/signals_demo.py`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch11/signals_demo.py) | `python3 lab/ch11/signals_demo.py` | 退出码 0，第一行 `default SIGINT handler: default_int_handler`，`child exit status after SIGTERM: -15`，`sift on Ctrl-C: 130 interrupted` |
| [`lab/ch11/extra.sh`](https://github.com/bfmhno3/sift/blob/ch11/lab/ch11/extra.sh) | `bash lab/ch11/extra.sh` | 退出码 0，第一行 `top 15 imports by cumulative time (us):`，十条退出码命令各带一个 `(expected N)`，最后一行形如 `cold/warm: 1.20x (146.0 ms vs 121.3 ms)` |

## 练习

**1.** 给 `main()` 的 `except` 链再加一个分支：收到 `SIGTERM` 时安静退出，退出码 143 (`128 + 15`)。仿照 `signals_demo.py` 里那段子进程代码写测试：用 `signal.signal(signal.SIGTERM, ...)` 装一个抛 `SystemExit(143)` 的处理函数，再让子进程给自己发 `SIGTERM`。想一想：什么时候直接退出反而更糟（提示：`index` 写到一半的时候）。

**2.** 给 `build_parser()` 的 `ArgumentParser` 传 `allow_abbrev=False`，再写一个测试确认 `sift search --lim 2 rust` 现在以退出码 2 结束，而 `--limit 2` 照常工作；子解析器要不要也传，先在 `$S/args_demo.py` 里试。

**3.** 把 `__version__` 改成 `__init__.py` 里的字面量，让 hatchling 从那里读版本（`dynamic = ["version"]` 加 `[tool.hatch.version] path = "src/sift/__init__.py"`，先读 `hatchling/version/source/regex.py`）。重新造 wheel，确认 `METADATA` 里的 `Version`，再用 `$S/alt.py` 量 `import sift.search` 的前后，看它是不是真的落在上面“字面量”那一行附近。

**4.** `lab/ch11/circular` 的 `a.py` 和 `b.py` 用第三种办法修：把双方都需要的东西抽到第三个模块 `circular/shared.py`，让依赖变成一条线。用一个 mermaid 流程图画出修前和修后的依赖，并在 `python3 -X importtime` 里确认没有模块被导入两次。

## 下一篇

下一篇是《文件与二进制格式：struct、varint、mmap 与压缩》。这一篇里 `SIFT_INDEX` 只会检查一个目录在不在，因为索引还只存在于内存里，每条 `sift search` 都要付 2 秒建索引的钱；这笔钱要在下一篇里换成磁盘上的一个文件，`IndexMissingError` 第一次有了真实的原因。我想看的是，一个 `struct` 打包出来的头加上 `mmap` 出来的词典，能不能让第一次查询从 2 秒掉到一个我能忍受的数；还有一个小问题，`stopwords.txt` 需要 `importlib.resources` 才能躲开路径，一个二进制索引文件在 wheel 里会不会遇到同样的事。
