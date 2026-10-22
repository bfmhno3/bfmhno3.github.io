---
title: "继承、ABC 与 Protocol：分析器插件"
commentId: "post:python-by-sift-07-inheritance-protocols"
published: "2026-10-22 13:00:00 +08:00"
description: "用 Sift 重学 Python 第 7 篇：我在 Python 3.14.7 里把写死的分词函数换成 Analyzer 抽象基类、TokenFilter 协议和 Pipeline，再让 InvertedIndex 继承 collections.abc.Mapping，沿途把 MRO、mixin、`__init_subclass__`、Protocol 和 singledispatchmethod 各跑一遍；默认流水线的搜索结果和上一篇逐字节相同，而整个 load_index 从 1662 ms 涨到了 1850 ms。"
category: Tutorial
tags:
  - Python
  - Sift
  - 继承
  - 抽象基类
  - Protocol
  - MRO
series: "用 Sift 重学 Python"
seriesOrder: 7
draft: false
comment: true
slug: python-by-sift-07-inheritance-protocols
---

上一篇的 `tokenize` 是一个写死的函数：想只切拉丁词，或者只切 CJK 双字组，只能去改源码。这一篇之后，分词器是注册表里的三个类，同一句 `Kalman 滤波器 in C++` 喂给它们，得到三个不同的答案：

```text
$ python3 -c '
from sift.analysis import REGISTRY, build_pipeline

text = "Kalman 滤波器 in C++"
for name in REGISTRY:
    print(f"{name:11}", build_pipeline([name, "nfkc"]).terms(text))
'
latin       ['kalman', 'in', 'c++']
cjk-bigram  ['滤波', '波器']
mixed       ['kalman', '滤波', '波器', 'in', 'c++']
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch07`：`src/sift/analysis/` 从一个文件变成一个包，新增 `base.py`（`Analyzer` 和 `TokenFilter`）、`tokenizers.py`（三个分词器）、`filters.py`（两个过滤器）、`pipeline.py`（`Pipeline` 和 `build_pipeline`），`__init__.py` 改成导出这些名字；`tokenize.py` 原样不动，`tokenize` 和 `iter_tokens` 仍然能从 `sift.analysis` 导入。`src/sift/index.py` 里的 `InvertedIndex` 改成继承 `collections.abc.Mapping`，并且新增了 `documents`、`doc_len()`、`n_docs` 和 `avg_doc_len`，`add()` 也随之多记录文档和文档长度；`src/sift/__main__.py` 改成通过 `Pipeline` 分析文本。这些文件都不是终稿：`filters.py` 里的停用词表只是占位，第 11 篇才换成文件；`build_pipeline` 抛的 `KeyError` 在第 9 篇换成 `ConfigError`；`index.py` 和 `__main__.py` 之后的章节还会动。`make ch07` 通过，`lab/ch07` 下 13 个文件按预期退出（11 个正常，2 个按预期失败）。
> 涉及的 Python 特性：单继承与多继承、`super()` 与 C3 线性化 (MRO)、mixin、`abc.ABC` 与 `abstractmethod`、`__subclasshook__` 与 `register`、鸭子类型、`typing.Protocol` 与 `runtime_checkable`、`__init_subclass__`、`collections.abc`、组合优于继承、`functools.singledispatchmethod`。
> 前置：[第 6 篇](/posts/python-by-sift-06-classes-data-model/)，需要会进 `nix develop`，读得懂 `Posting`、`PostingList` 和 `InvertedIndex` 的数据模型方法。

这一篇的账不全是好看的。默认流水线是 `mixed` 加 `nfkc`，搜索输出和上一篇完全一样（后面会贴 `cmp` 的结果）；但同一个 `load_index` 从 1662 ms 涨到了 1850 ms，继承来的 `in` 对不存在的词慢了 5 倍，停用词过滤器默认关着，里面只有 25 个词的占位表。每一笔我都会量，放在它出现的地方。

先把 Python 的继承机制从头走一遍，每一站一个 `lab/ch07` 里的小实验，然后回到 Sift。

## 环境

和前几篇同一台机器，仓库在标签 `ch07`：

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ git describe --tags
ch07
```

CPU 是 AMD Ryzen 7 PRO 6850U，内存 30 GiB。计时的做法沿用前几篇：每一组对比，各个版本轮流跑（7 轮），每轮一个新进程，离群值不剔除，看最小值和中位数；纳秒级的微基准用 `timeit`，取 5 次重复里的最小值。

`ch06` 和 `ch07` 要放在同一个会话里比，做法和上一篇一样：用 `git archive` 各导出一份到 `/tmp/p07`，语料用符号链接共享，函数 `at` 把 `PYTHONPATH` 里仓库的 `src` 换成导出目录：

```bash
mkdir -p /tmp/p07/ch06 /tmp/p07/ch07 /tmp/p07/scratch /tmp/p07/cpython
for c in ch06 ch07; do
  git -C ~/Projects/sift archive $c | tar -x -C /tmp/p07/$c
  ln -s ~/Projects/sift/corpus /tmp/p07/$c/corpus
done
SITE=${PYTHONPATH#*:}
at() { (cd /tmp/p07/$1 && PYTHONPATH=/tmp/p07/$1/src:$SITE python3 "${@:2}"); }
```

CPython 的源码我直接 `curl` `v3.14.7` 标签下的原文，放进 `/tmp/p07/cpython`，下文的行号都是这个标签下的行号：

```bash
cd /tmp/p07/cpython
for f in Lib/abc.py Lib/_collections_abc.py Lib/typing.py Lib/functools.py \
         Lib/_py_abc.py Objects/typeobject.c; do
  mkdir -p $(dirname $f)
  curl -sSfL https://raw.githubusercontent.com/python/cpython/v3.14.7/$f -o $f
done
```

`lab/ch07` 里的是仓库文件，节选处用行号标明，命令都在仓库根目录 `~/Projects/sift` 里跑；放在 `/tmp/p07/scratch/` 的是只为这篇写的脚本，不进仓库，我贴全文，带 `main()` 和 `__main__` 守卫。输出里的主目录路径用 `sed "s|$HOME|~|"` 换成了 `~`，别的地方一字不改；输出里超过 100 列的行，我在空格处折成两行、续行多缩进两格，受影响的只有 `Can't instantiate abstract class` 那三行报错。引用的 CPython 原文保持上游的格式，有三行超过 79 列，没有折行；省略的部分用 `...` 标出。

## 继承是一条查找路径

`class Child(Parent)` 不复制任何东西：它只是在 `Child.__bases__` 里记下 `Parent`，再算出一个叫 `__mro__` 的类元组。取属性的时候，Python 沿着 `__mro__` 一个类一个类地翻它们的 `__dict__`，翻到就停。所以“继承”这个词有点误导，真实情况是“没找到，去下一个地方找”。`lab/ch07/inheritance.py` 先放三个类（第 4 到 45 行）：

```python
class Tokenizer:
    """Split text on whitespace."""

    name = "whitespace"

    def __init__(self, lowercase: bool = False) -> None:
        """Remember whether to lowercase."""
        self.lowercase = lowercase

    def tokens(self, text: str) -> list[str]:
        """Return the whitespace-separated words of text."""
        if self.lowercase:
            text = text.lower()
        return text.split()

    def describe(self) -> str:
        """Return a one-line description."""
        return f"{type(self).__name__}({self.name})"


class CommaTokenizer(Tokenizer):
    """Override tokens() to split on commas, reuse the rest."""

    name = "comma"

    def tokens(self, text: str) -> list[str]:
        """Return comma-separated fields, stripped."""
        parts = text.split(",")
        return [part.strip() for part in parts]


class LoudTokenizer(Tokenizer):
    """Extend __init__ and tokens() through super()."""

    def __init__(self, shout: str = "!") -> None:
        """Call the parent __init__ first, then add own state."""
        super().__init__(lowercase=True)
        self.shout = shout

    def tokens(self, text: str) -> list[str]:
        """Return the parent's tokens with a suffix on each."""
        return [word + self.shout for word in super().tokens(text)]
```

主函数（第 48 到 63 行）打印哪个方法在跑、属性是在哪个类上找到的：

```python
def main() -> None:
    """Show which method runs and where attributes are found."""
    text = "Red, Green Blue"
    for tok in (Tokenizer(), CommaTokenizer(), LoudTokenizer()):
        print(f"{tok.describe():32} {tok.tokens(text)}")
    loud = LoudTokenizer()
    print("instance dict:", vars(loud))
    owners = [c.__name__ for c in type(loud).__mro__ if "name" in vars(c)]
    print("name found on:", owners)
    print("issubclass:", issubclass(LoudTokenizer, Tokenizer))
    print("isinstance:", isinstance(loud, Tokenizer))
    print("isinstance, reversed:", isinstance(Tokenizer(), LoudTokenizer))
    print(
        "describe is inherited:", LoudTokenizer.describe is Tokenizer.describe
    )
    print("tokens is the parent's:", LoudTokenizer.tokens is Tokenizer.tokens)
```

```text
$ python3 lab/ch07/inheritance.py
Tokenizer(whitespace)            ['Red,', 'Green', 'Blue']
CommaTokenizer(comma)            ['Red', 'Green Blue']
LoudTokenizer(whitespace)        ['red,!', 'green!', 'blue!']
instance dict: {'lowercase': True, 'shout': '!'}
name found on: ['Tokenizer']
issubclass: True
isinstance: True
isinstance, reversed: False
describe is inherited: True
tokens is the parent's: False
```

输出里能直接读出三件事：

- `name found on: ['Tokenizer']`：`LoudTokenizer` 自己没有 `name`，是沿着 MRO 在 `Tokenizer` 上找到的。`vars(loud)` 里只有 `lowercase` 和 `shout`，类属性不在实例里。
- `LoudTokenizer.describe is Tokenizer.describe` 是 `True`：同一个函数对象，没有复制。被覆盖的 `tokens` 就不是了（最后一行 `False`）。
- `isinstance(Tokenizer(), LoudTokenizer)` 是 `False`：is-a 只朝一个方向。

`LoudTokenizer.tokens` 里的 `super().tokens(text)` 常被说成“调用父类的方法”。单继承里这句话碰巧不错，多继承里它是错的，所以我想说准确。无参的 `super()` 是 `super(__class__, self)` 的缩写，`__class__` 不是魔法：编译器发现一个函数体里写了 `super` 或 `__class__`，就给这个函数加一个隐藏的自由变量，指向定义它的那个类。可以直接看到：

```text
$ python3 -c '
import sys

sys.path.insert(0, "lab/ch07")
from inheritance import LoudTokenizer
from mro_diamond import Bottom, Left

tokens = LoudTokenizer.tokens
print(tokens.__code__.co_freevars)
print(tokens.__closure__[0].cell_contents)
print(super(Left, Bottom()))
print(super(Left, Bottom()).hello())
'
('__class__',)
<class 'inheritance.LoudTokenizer'>
<super: <class 'Left'>, <Bottom object>>
['Right', 'Base']
```

`('__class__',)` 是 `tokens` 的自由变量表，闭包单元里装的是 `LoudTokenizer` 本身。`super(Left, Bottom())` 这一行先放一放，它马上有用。

`super` 对象取属性时做什么，在 `Objects/typeobject.c` 的 `_super_lookup_descr`（第 11840 行起）里。核心是第 11858 到 11881 行：

```c
    /* ... */
    /* No need to check the last one: it's gonna be skipped anyway.  */
    for (i = 0; i+1 < n; i++) {
        if ((PyObject *)(su_type) == PyTuple_GET_ITEM(mro, i))
            break;
    }
    i++;  /* skip su->type (if any)  */
    if (i >= n) {
        _PyThreadState_PopCStackRef(tstate, &mro_ref);
        return NULL;
    }

    do {
        PyObject *obj = PyTuple_GET_ITEM(mro, i);
        PyObject *dict = lookup_tp_dict(_PyType_CAST(obj));
        assert(dict != NULL && PyDict_Check(dict));

        if (PyDict_GetItemRef(dict, name, &res) != 0) {
            // found or error
            _PyThreadState_PopCStackRef(tstate, &mro_ref);
            return res;
        }

        i++;
    } while (i < n);
    /* ... */
```

这里的 `mro` 是 `type(self).__mro__`（`su_obj_type` 的），`su_type` 是 `super` 的第一个参数，也就是 `__class__`。先在 MRO 里找到 `su_type` 的位置，然后从它的下一个类开始，一个类一个类地翻 `__dict__`，翻到就返回。没有“父类”这个概念，只有“`type(self)` 的 MRO 里，排在 `__class__` 后面的那些类”。

MRO 像一张排好序的值班表，`super()` 的意思是“把活交给表上排在我后面的那一位”，而不是“交给我爸爸”。这个比喻我只用这一次，下面的实验里，Left 的“后面那位”会是个出乎意料的人。

## MRO：C3 线性化

`lab/ch07/mro_diamond.py` 把经典的菱形继承写出来（第 4 到 37 行）：

```python
class Base:
    """Root of the diamond."""

    def hello(self) -> list[str]:
        """Return the trail so far: just this class."""
        return ["Base"]


class Left(Base):
    """Left side: calls super() once."""

    def hello(self) -> list[str]:
        """Add Left to whatever super() returns."""
        return ["Left", *super().hello()]


class Right(Base):
    """Right side: calls super() once."""

    def hello(self) -> list[str]:
        """Add Right to whatever super() returns."""
        return ["Right", *super().hello()]


class Bottom(Left, Right):
    """Bottom of the diamond: Left first, then Right."""

    def hello(self) -> list[str]:
        """Add Bottom to whatever super() returns."""
        return ["Bottom", *super().hello()]


class Flipped(Right, Left):
    """The same bases in the other order."""
```

主函数（第 45 到 55 行）打印各类的 `__mro__`，再各调一次 `hello()`：

```python
def main() -> None:
    """Print the MROs and the call trails."""
    print("Bottom.__mro__ ", names(Bottom))
    print("Flipped.__mro__", names(Flipped))
    print("Left.__mro__   ", names(Left))
    # Left.hello calls super(): in a Bottom it reaches Right, not Base.
    print("Bottom().hello()", Bottom().hello())
    print("Flipped().hello()", Flipped().hello())
    # A plain Left has no Right behind it: super() reaches Base.
    print("Left().hello()  ", Left().hello())
    print("Base comes just before object:", names(Bottom)[-2] == "Base")
```

```text
$ python3 lab/ch07/mro_diamond.py
Bottom.__mro__  ['Bottom', 'Left', 'Right', 'Base', 'object']
Flipped.__mro__ ['Flipped', 'Right', 'Left', 'Base', 'object']
Left.__mro__    ['Left', 'Base', 'object']
Bottom().hello() ['Bottom', 'Left', 'Right', 'Base']
Flipped().hello() ['Right', 'Left', 'Base']
Left().hello()   ['Left', 'Base']
Base comes just before object: True
```

`Bottom().hello()` 的轨迹是 Bottom、Left、Right、Base：`Left.hello` 里的 `super().hello()` 没有去 `Base`，而是去了 `Right`。`Left` 的源码里从没出现过 `Right`，但在 `Bottom` 的实例上，MRO 里排在 `Left` 后面的就是 `Right`。上一节那条命令输出的最后两行，`super(Left, Bottom()).hello()` 得到 `['Right', 'Base']`，就是在手动演示这件事。


同一个 `Left().hello()` 单独跑，轨迹是 `['Left', 'Base']`。`Left.hello` 的行为取决于它被谁继承，这是多继承里最容易被忽略的一点，也是协作式 `super()` 能成立的前提：每个类只管“交给下一位”，不管下一位是谁。

这张表怎么排出来的？C3 线性化：一个类的 MRO 是它自己，加上“各基类的 MRO 和基类列表本身”这几张名单的归并。归并的规则只有一条：从各张名单的队首里挑第一个“不在任何一张名单的尾巴里”的类，放进结果，并把它从所有名单里划掉；挑不出来就失败。`Objects/typeobject.c` 的 `pmerge` 里，这条规则是第 3297 到 3316 行（失败的出口在第 3318 到 3321 行，`empty_cnt != to_merge_size` 时调 `set_mro_error`）：

```c
        /* ... */
        candidate = PyTuple_GET_ITEM(cur_tuple, remain[i]);
        for (j = 0; j < to_merge_size; j++) {
            PyObject *j_lst = to_merge[j];
            if (tail_contains(j_lst, remain[j], candidate))
                goto skip; /* continue outer loop */
        }
        res = PyList_Append(acc, candidate);
        if (res < 0)
            goto out;

        for (j = 0; j < to_merge_size; j++) {
            PyObject *j_lst = to_merge[j];
            if (remain[j] < PyTuple_GET_SIZE(j_lst) &&
                PyTuple_GET_ITEM(j_lst, remain[j]) == candidate) {
                remain[j]++;
            }
        }
        goto again;
      skip: ;
    }
    /* ... */
```

`tail_contains` 问的是“这个候选在不在某张名单剩下部分的非队首位置”，`remain[j]` 是第 `j` 张名单划到哪了（用下标代替真的删元素）。我用 Python 把它重写了一遍，放在 `/tmp/p07/scratch/c3.py`，并让它和解释器自己算出的 `__mro__` 对答案：

```python
"""C3 linearization in a dozen lines, checked against __mro__."""

import collections.abc
import sys

sys.path.insert(0, "lab/ch07")

from mixins import RichHit  # noqa: E402
from mro_diamond import Bottom, Flipped  # noqa: E402

from sift.analysis import REGISTRY  # noqa: E402


def c3(cls: type) -> list[type]:
    """Return the C3 linearization of cls, computed from its bases."""
    seqs = [c3(base) for base in cls.__bases__] + [list(cls.__bases__)]
    result = [cls]
    while any(seqs):
        for seq in seqs:
            if not seq:
                continue
            head = seq[0]
            if not any(head in other[1:] for other in seqs):
                break
        else:
            raise TypeError(f"no consistent order for {cls.__name__}")
        result.append(head)
        for seq in seqs:
            if seq and seq[0] is head:
                del seq[0]
    return result


def main() -> None:
    """Compare c3() with the interpreter on a few hierarchies."""
    abcs = [v for v in vars(collections.abc).values() if isinstance(v, type)]
    cases = [Bottom, Flipped, RichHit, *REGISTRY.values(), *abcs]
    bad = [c for c in cases if c3(c) != list(c.__mro__)]
    print(f"checked {len(cases)} classes, {len(bad)} differ")
    print([c.__name__ for c in c3(Bottom)])


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p07/scratch/c3.py
checked 60 classes, 0 differ
['Bottom', 'Left', 'Right', 'Base', 'object']
```

菱形、翻转的菱形、下一节的 `RichHit`、Sift 的三个分词器，加上 `collections.abc` 里所有的类，60 个类，一个不差。我本来预期会在哪个边角翻车，没有：十几行的 C3 和解释器的 C 实现在这些例子上结果一致。

### 排不出来的时候

把基类的顺序写成“先父后子”，规则就无解。`lab/ch07/mro_conflict_fail.py`（第 4 到 18 行）：

```python
class A:
    """The parent."""


class B(A):
    """The child."""


def main() -> None:
    """List the parent before its child: C3 cannot satisfy both."""
    print("A.__mro__:", [c.__name__ for c in A.__mro__])
    print("B.__mro__:", [c.__name__ for c in B.__mro__])
    # error: TypeError: Cannot create a consistent method resolution
    # order (MRO) for bases A, B
    type("C", (A, B), {})
```

```text
$ python3 lab/ch07/mro_conflict_fail.py 2>&1 | sed "s|$HOME|~|"
A.__mro__: ['A', 'object']
B.__mro__: ['B', 'A', 'object']
Traceback (most recent call last):
  File "~/Projects/sift/lab/ch07/mro_conflict_fail.py", line 22, in <module>
    main()
    ~~~~^^
  File "~/Projects/sift/lab/ch07/mro_conflict_fail.py", line 18, in main
    type("C", (A, B), {})
    ~~~~^^^^^^^^^^^^^^^^^
TypeError: Cannot create a consistent method resolution order (MRO) for bases A, B
```

基类元组 `(A, B)` 要求 `A` 排在 `B` 前面，而 `B` 自己的 MRO 要求 `B` 在 `A` 前面。两个要求互相咬死，没有任何一个队首能被放进结果。错误信息是 3.14.7 的原样输出，注意其中的 `(MRO)`。消息的格式串在 `Objects/typeobject.c` 的 `set_mro_error`（第 3209 行起，格式串在第 3229 和 3230 行），列出来的 `A, B` 是卡住的那一刻各张名单的队首。

实验里用 `type("C", (A, B), {})` 只是为了让出错的那一行落在 `main` 里；`class` 语句得到同样的报错：

```text
$ python3 -c '
class A: ...
class B(A): ...
class C(A, B): ...
' 2>&1 | tail -n 1
TypeError: Cannot create a consistent method resolution order (MRO) for bases A, B
```

## mixin：一次只加一样本事

mixin 是不打算单独用的小类，每个类只给别人加一样东西。`lab/ch07/mixins.py` 里有三个（第 7 到 33 行），外加一个真正的基类和把它们攒在一起的 `RichHit`（第 36 到 46 行）：

```python
class JsonMixin:
    """Add to_json() to any class with a __dict__."""

    def to_json(self) -> str:
        """Return the instance attributes as sorted JSON."""
        return json.dumps(vars(self), sort_keys=True, ensure_ascii=False)


class ReprMixin:
    """Add a __repr__ built from the instance attributes."""

    def __repr__(self) -> str:
        """Return ClassName(attr=value, ...)."""
        fields = ", ".join(f"{k}={v!r}" for k, v in vars(self).items())
        return f"{type(self).__name__}({fields})"


class CountMixin:
    """Count instances per concrete class, via cooperative super()."""

    counts: dict[str, int] = {}

    def __init__(self, *args: object, **kwargs: object) -> None:
        """Count, then pass every argument on along the MRO."""
        name = type(self).__name__
        CountMixin.counts[name] = CountMixin.counts.get(name, 0) + 1
        super().__init__(*args, **kwargs)


class Hit:
    """A search hit: a title and a score."""

    def __init__(self, title: str, score: float) -> None:
        """Store the fields."""
        self.title = title
        self.score = score


class RichHit(CountMixin, ReprMixin, JsonMixin, Hit):
    """Hit plus three mixins; mixins come first, the real base last."""
```

```text
$ python3 lab/ch07/mixins.py
RichHit(title='Kalman', score=2.5)
{"score": 1.0, "title": "卡尔曼"}
titles: ['Kalman', '卡尔曼']
counts: {'RichHit': 2}
MRO: ['RichHit', 'CountMixin', 'ReprMixin', 'JsonMixin', 'Hit', 'object']
```

最后一行的 MRO 是 `RichHit`、`CountMixin`、`ReprMixin`、`JsonMixin`、`Hit`。`RichHit("Kalman", 2.5)` 先进 `CountMixin.__init__`，它数一个数，然后 `super().__init__(*args, **kwargs)`：MRO 里排在 `CountMixin` 后面的是 `ReprMixin`，它没有 `__init__`，查找继续往后，一路经过 `JsonMixin`，到 `Hit.__init__` 才找到，参数原样到达。`*args, **kwargs` 是协作的约定：mixin 不知道后面是谁，所以它不拦截参数。

mixin 要写在真正的基类前面，原因就是这张表的顺序。我故意把它放到后面试一下 (`/tmp/p07/scratch/mixin_order.py`)：

```python
"""A cooperative mixin placed after the class that stops the chain."""

import sys

sys.path.insert(0, "lab/ch07")

from mixins import CountMixin, Hit  # noqa: E402


class GoodHit(CountMixin, Hit):
    """Mixin first: its __init__ runs, then Hit's."""


# BAD: Hit.__init__ never calls super(), so CountMixin is never reached.
class BadHit(Hit, CountMixin):
    """Mixin last: the chain ends in Hit.__init__."""


def main() -> None:
    """Build one of each and look at the counter."""
    GoodHit("a", 1.0)
    BadHit("b", 2.0)
    print("counts:", CountMixin.counts)
    print("BadHit MRO:", [c.__name__ for c in BadHit.__mro__])


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p07/scratch/mixin_order.py
counts: {'GoodHit': 1}
BadHit MRO: ['BadHit', 'Hit', 'CountMixin', 'object']
```

`BadHit("b", 2.0)` 没有任何报错，计数器里却没有它：`Hit.__init__` 排在前面，它不调用 `super().__init__`，链子就在这里断了，`CountMixin.__init__` 永远没机会跑。没有异常，只是少了一行记录，这是 mixin 顺序写反时最典型的症状。

`lab/ch07/mixins.py` 末尾还有一个 `Hits(list[RichHit])`（第 49 到 54 行）：内置的 `list` 也只是 MRO 里的一个类，可以继承，`titles()` 方法照常工作（输出里的 `titles:` 一行）。

## ABC：没写完的类不让实例化

`abc.ABC` 做的事很少：把类的元类换成 `ABCMeta`，让 `@abstractmethod` 有意义。`lab/ch07/abc_demo.py`（第 7 到 57 行）里有两个例子，一个是 `Scorer`，子类必须实现 `score`；另一个是 `Closer`，后面再讲：

```python
class Scorer(ABC):
    """Anything that turns (tf, df, n_docs) into a score."""

    @abstractmethod
    def score(self, tf: int, df: int, n_docs: int) -> float:
        """Return the score of one term in one document."""

    def describe(self) -> str:
        """Describe the analyzer; subclasses inherit this method."""
        return f"{type(self).__name__}: {self.score(3, 10, 100):.3f}"


class RawTf(Scorer):
    """Score by term frequency alone."""

    def score(self, tf: int, df: int, n_docs: int) -> float:
        """Return tf as a float."""
        return float(tf)
```

`@abstractmethod` 本身只做一件事，`Lib/abc.py` 第 24 行：`funcobj.__isabstractmethod__ = True`，给函数贴一个标记。真正数标记的是元类。`ABCMeta.__new__` 在 `Lib/abc.py` 第 105 到 108 行，调用的是 C 模块 `_abc` 里的 `_abc_init`；我没有读 `Modules/_abc.c`，下面是同一个文件里作为后备的纯 Python 版本，`Lib/_py_abc.py` 第 35 到 46 行，语义上应该和 C 版一致：

```python
    def __new__(mcls, name, bases, namespace, /, **kwargs):
        cls = super().__new__(mcls, name, bases, namespace, **kwargs)
        # Compute set of abstract method names
        abstracts = {name
                     for name, value in namespace.items()
                     if getattr(value, "__isabstractmethod__", False)}
        for base in bases:
            for name in getattr(base, "__abstractmethods__", set()):
                value = getattr(cls, name, None)
                if getattr(value, "__isabstractmethod__", False):
                    abstracts.add(name)
        cls.__abstractmethods__ = frozenset(abstracts)
        # ...
```

类体里带标记的名字，加上基类的 `__abstractmethods__` 里“到现在还是带标记”的名字，合起来存成 `cls.__abstractmethods__`。这个属性的 setter 在 `Objects/typeobject.c` 的 `type_set_abstractmethods`（第 1647 行起），按它是否为空，打开或关闭类型对象上的一个标志（第 1676 到 1679 行）：

```c
    if (abstract)
        type_add_flags(type, Py_TPFLAGS_IS_ABSTRACT);
    else
        type_clear_flags(type, Py_TPFLAGS_IS_ABSTRACT);
```

拦住实例化的不是元类，而是 `object.__new__`：它检查这个标志，第 6867 行 `if (type->tp_flags & Py_TPFLAGS_IS_ABSTRACT) {`；消息的格式串在第 6905 到 6910 行：

```c
        PyErr_Format(PyExc_TypeError,
                     "Can't instantiate abstract class %s "
                     "without an implementation for abstract method%s '%U'",
                     type->tp_name,
                     method_count > 1 ? "s" : "",
                     joined);
```

`lab/ch07/abc_instantiate_fail.py` 让一个类只实现两个抽象方法里的一个，然后实例化它：

```python
class Scorer(ABC):
    """Two abstract methods."""

    @abstractmethod
    def score(self, tf: int) -> float:
        """Return a score."""

    @abstractmethod
    def name(self) -> str:
        """Return the scorer name."""


class Half(Scorer):
    """Implements only score()."""

    def score(self, tf: int) -> float:
        """Return tf as a float."""
        return float(tf)


def main() -> None:
    """Try to build the incomplete subclass."""
    print("still abstract:", sorted(Half.__abstractmethods__))
    # error: TypeError: Can't instantiate abstract class Half without
    # an implementation for abstract method 'name'
    Half()
```

```text
$ python3 lab/ch07/abc_instantiate_fail.py 2>&1 | sed "s|$HOME|~|"
still abstract: ['name']
Traceback (most recent call last):
  File "~/Projects/sift/lab/ch07/abc_instantiate_fail.py", line 35, in <module>
    main()
    ~~~~^^
  File "~/Projects/sift/lab/ch07/abc_instantiate_fail.py", line 31, in main
    Half()
    ~~~~^^
TypeError: Can't instantiate abstract class Half without an implementation for abstract method
  'name'
```

这是 3.14.7 的原样输出：`Can't instantiate abstract class Half without an implementation for abstract method 'name'`。第 6909 行的 `method_count > 1 ? "s" : ""` 说明两个以上会变成复数，排好序再用 `', '` 连起来，我也跑了一遍：

```text
$ python3 -c '
from abc import ABC, abstractmethod

class Scorer(ABC):
    @abstractmethod
    def score(self): ...
    @abstractmethod
    def name(self): ...

Scorer()
' 2>&1 | tail -n 1
TypeError: Can't instantiate abstract class Scorer without an implementation for abstract methods
  'name', 'score'
```

`@abstractmethod` 离开 `ABCMeta` 就只是个标记。`/tmp/p07/scratch/abc_without_meta.py` 把同一个装饰器贴在普通类和 ABC 上：

```python
"""@abstractmethod without ABCMeta is only a marker."""

from abc import ABC, abstractmethod


class NotABC:
    """Plain class: the decorator sets a flag and nothing else."""

    @abstractmethod
    def run(self) -> None:
        """Marked abstract."""


class RealABC(ABC):
    """ABC: the metaclass collects the flagged names."""

    @abstractmethod
    def run(self) -> None:
        """Marked abstract."""


def main() -> None:
    """Instantiate both."""
    print("flag:", NotABC.run.__isabstractmethod__)
    print("type(NotABC):", type(NotABC).__name__)
    print("type(RealABC):", type(RealABC).__name__)
    NotABC()
    print("NotABC() worked")
    RealABC()


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p07/scratch/abc_without_meta.py 2>&1 | sed "s|$HOME|~|"
flag: True
type(NotABC): type
type(RealABC): ABCMeta
NotABC() worked
Traceback (most recent call last):
  File "/tmp/p07/scratch/abc_without_meta.py", line 33, in <module>
    main()
    ~~~~^^
  File "/tmp/p07/scratch/abc_without_meta.py", line 29, in main
    RealABC()
    ~~~~~~~^^
TypeError: Can't instantiate abstract class RealABC without an implementation for abstract method
  'run'
```

普通类 `NotABC` 实例化成功，标记躺在函数上没人理；`RealABC` 同样的写法就拒绝实例化。顺手一提 Rust：漏实现一个 trait 方法，`cargo build` 就不让过；ABC 把同样的检查推迟到 `Half()` 那一行，运行到那里才发现。早报错和晚报错之间的差别，是静态类型和动态类型的差别，而不是 ABC 好不好。

### 虚拟子类和 `__subclasshook__`

ABC 还有另一半：`isinstance(x, SomeABC)` 不一定要求继承。`abc_demo.py` 的后半（第 27 到 57 行）：

```python
class Closer(ABC):
    """Anything with a close() method, declared or not."""

    @abstractmethod
    def close(self) -> None:
        """Release the resource."""

    @classmethod
    def __subclasshook__(cls, subclass: type) -> bool:
        """Say yes to every class that defines close()."""
        if cls is Closer and callable(getattr(subclass, "close", None)):
            return True
        return NotImplemented


class Handle:
    """Never mentions Closer, yet counts as one."""

    def close(self) -> None:
        """Do nothing."""


class Unrelated:
    """No close() at all."""


class Legacy:
    """Registered by hand with Closer.register."""


Closer.register(Legacy)
```

```text
$ python3 lab/ch07/abc_demo.py
RawTf: 3.000
Scorer.__abstractmethods__: {'score'}
RawTf.__abstractmethods__: set()
RawTf is a Scorer: True
Handle is a Closer: True
Unrelated is a Closer: False
Legacy is a Closer: True
Closer in Handle.__mro__: False
list is a Sequence: True
```

`Handle` 从没提过 `Closer`，`Closer in Handle.__mro__` 是 `False`，`isinstance(Handle(), Closer)` 却是 `True`。`isinstance` 调的是元类的 `__instancecheck__`（`Lib/abc.py` 第 117 到 119 行），最后落到 `__subclasscheck__`。`_py_abc.py` 里这一步的次序是：先查缓存，再查负缓存，然后问 `__subclasshook__`，第 122 到 130 行：

```python
        # ...
        # Check the subclass hook
        ok = cls.__subclasshook__(subclass)
        if ok is not NotImplemented:
            assert isinstance(ok, bool)
            if ok:
                cls._abc_cache.add(subclass)
            else:
                cls._abc_negative_cache.add(subclass)
            return ok
            # ...
```

钩子返回 `True` 或 `False` 就是定论，返回 `NotImplemented` 才继续往下查：是不是直接子类（看 MRO），是不是注册过的类的子类，是不是某个子类的子类。`Legacy` 走的是 `Closer.register(Legacy)`，注册表这一路。`list is a Sequence: True` 也是这样来的：`Lib/_collections_abc.py` 第 1171 行 `MutableSequence.register(list)`，`Sequence` 再通过“某个子类的子类”这一步认出它（这一步我是读 `_py_abc.py` 得出的，C 版我没读）。`tuple` 则是第 1062 行直接注册到 `Sequence`。

钩子的代价是它说的是“有一个叫 `close` 的可调用属性”，仅此而已：不检查签名，也不管语义。这个缺点会在 `Protocol` 里再出现一次，而且更明显。

## 鸭子类型：不问是什么，只问能不能

不要基类、不要钩子、不要注册，直接用。`lab/ch07/duck_typing.py` 里的 `dump` 对 `out` 只有一个要求（第 9 到 36 行）：

```python
class Shout:
    """Has write() like a file, but only collects upper-case text."""

    def __init__(self) -> None:
        """Start empty."""
        self.parts: list[str] = []

    def write(self, text: str) -> int:
        """Keep text in upper case; return its length."""
        self.parts.append(text.upper())
        return len(text)


def dump(lines: Iterable[str], out: Any) -> None:
    """Write every line to out: anything with write() will do."""
    for line in lines:
        out.write(line + "\n")


def total_length(items: Iterable[Any]) -> int:
    """Sum len() of items: EAFP instead of an isinstance check."""
    total = 0
    for item in items:
        try:
            total += len(item)
        except TypeError:
            total += len(str(item))
    return total
```

主函数（第 39 到 55 行）把三个互不相干的对象交给同一个函数：

```python
def main() -> None:
    """Pass three unrelated objects to the same function."""
    words = ["kalman", "filter"]
    buffer = StringIO()
    shout = Shout()
    dump(words, buffer)
    dump(words, shout)
    print("StringIO:", repr(buffer.getvalue()))
    print("Shout   :", repr("".join(shout.parts)))
    with open(os.devnull, "w", encoding="utf-8") as sink:
        dump(words, sink)
    print("devnull : accepted too")
    print("total_length:", total_length(["ab", (1, 2, 3), 12345, {1: 2}]))
    try:
        dump(words, 42)
    except AttributeError as exc:
        print("AttributeError:", exc)
```

```text
$ python3 lab/ch07/duck_typing.py
StringIO: 'kalman\nfilter\n'
Shout   : 'KALMAN\nFILTER\n'
devnull : accepted too
total_length: 11
AttributeError: 'int' object has no attribute 'write'
```

`StringIO`、自己写的 `Shout`、`open(os.devnull)` 打开的文件，`dump` 一视同仁；`total_length` 干脆不检查类型，`len()` 不行就捕获 `TypeError` 换个办法（EAFP，“先做，错了再说”）。最后一行是代价：`dump(words, 42)` 的错在 `out.write(...)` 那一行才炸，消息只说 `'int' object has no attribute 'write'`，不说“`dump` 要的是什么”。契约只存在于调用者的脑子里和函数的文档字符串里。

这就是 `Protocol` 想补的缺口：让契约写在代码里，由类型检查器去查，运行时的行为照旧是鸭子类型。

## Protocol：写在代码里的鸭子

`lab/ch07/protocols.py`（第 7 到 55 行）有两个协议，和四个“恰好有或恰好没有”某个方法的类：

```python
class Scorer(Protocol):
    """Static only: isinstance() refuses it."""

    def score(self, tf: int) -> float:
        """Return a score."""
        ...


@runtime_checkable
class Closable(Protocol):
    """runtime_checkable: isinstance() checks method names."""

    def close(self) -> None:
        """Release the resource."""
        ...


class Doubler:
    """Never mentions Scorer; has a matching score()."""

    def score(self, tf: int) -> float:
        """Return twice tf."""
        return 2.0 * tf


class File:
    """Has close()."""

    def close(self) -> None:
        """Do nothing."""


class WrongSignature:
    """Has close(), but with a signature a checker would reject."""

    def close(self, force: bool, timeout: float) -> str:
        """Need two arguments and return a str."""
        return f"{force} {timeout}"


class Disabled:
    """Sets close to None: the protocol treats it as not implemented."""

    close = None


def best(scorers: Iterable[Scorer], tf: int) -> float:
    """Return the highest score; a type checker verifies the shape."""
    return max(s.score(tf) for s in scorers)
```

主函数（第 58 到 73 行）看运行时能查到多少：

```python
def main() -> None:
    """Check structure at run time, and see its limits."""
    print("best:", best([Doubler(), Doubler()], 4))
    try:
        isinstance(Doubler(), Scorer)
    except TypeError as exc:
        print("TypeError:", exc)
    print("File is Closable:", isinstance(File(), Closable))
    print("Doubler is Closable:", isinstance(Doubler(), Closable))
    # runtime_checkable tests names, not signatures or types.
    print(
        "WrongSignature is Closable:", isinstance(WrongSignature(), Closable)
    )
    print("Disabled is Closable:", isinstance(Disabled(), Closable))
    print("issubclass(File, Closable):", issubclass(File, Closable))
    print("Closable.__mro__:", [c.__name__ for c in Closable.__mro__])
```

```text
$ python3 lab/ch07/protocols.py
best: 8.0
TypeError: Instance and class checks can only be used with @runtime_checkable protocols
File is Closable: True
Doubler is Closable: False
WrongSignature is Closable: True
Disabled is Closable: False
issubclass(File, Closable): True
Closable.__mro__: ['Closable', 'Protocol', 'Generic', 'object']
```

逐行读：

- `best([Doubler(), Doubler()], 4)` 工作，`Doubler` 从没提过 `Scorer`：结构上有一个 `score(self, tf: int) -> float`，就算满足协议。按 PEP 544，类型检查器也会接受它；这一篇我没有跑类型检查器（仓库里还没有这个目标），所以这半句只是规范，不是我验证过的。
- 没有 `runtime_checkable` 的 `Scorer` 拒绝 `isinstance`：`TypeError: Instance and class checks can only be used with @runtime_checkable protocols`。协议默认只给静态检查用。
- 加了 `@runtime_checkable` 之后 `isinstance(File(), Closable)` 为真，`Doubler` 为假，这是意料之中的。
- `WrongSignature` 的 `close` 要两个参数、返回 `str`，和协议的 `close(self) -> None` 完全对不上，运行时检查照样说 `True`。它只查名字。
- `Disabled` 把 `close` 设成 `None`，检查说 `False`：`None` 是协议规定的“显式声明不实现”。

这三个现象都在 `Lib/typing.py` 里。`runtime_checkable` 的文档字符串自己就警告过：“this will check only the presence of the required methods, not their type signatures”（第 2282 行起）。检查本身是 `_proto_hook`（第 2070 到 2096 行）：

```python
def _proto_hook(cls, other):
    if not cls.__dict__.get('_is_protocol', False):
        return NotImplemented

    for attr in cls.__protocol_attrs__:
        for base in other.__mro__:
            # Check if the members appears in the class dictionary...
            if attr in base.__dict__:
                if base.__dict__[attr] is None:
                    return NotImplemented
                break

            # ...or in annotations, if it is a sub-protocol.
            if issubclass(other, Generic) and getattr(other, "_is_protocol", False):
                # We avoid the slower path through annotationlib here because in most
                # cases it should be unnecessary.
                try:
                    annos = base.__annotations__
                except Exception:
                    annos = _lazy_annotationlib.get_annotations(
                        base, format=_lazy_annotationlib.Format.FORWARDREF
                    )
                if attr in annos:
                    break
        else:
            return NotImplemented
    return True
```

对协议里的每个成员名，沿着 `other.__mro__` 一个类一个类地看 `__dict__`，找到了就算满足，除非值是 `None`（第 2077 到 2079 行）。没有任何一处看签名。而这个函数是怎么被调到的？`Protocol` 的子类创建时，第 2143 到 2145 行：

```python
        # ...
        # Set (or override) the protocol subclass hook.
        if '__subclasshook__' not in cls.__dict__:
            cls.__subclasshook__ = _proto_hook
            # ...
```

`_proto_hook` 被装成协议类的 `__subclasshook__`。也就是说，`runtime_checkable` 的协议就是一个自动生成了 `__subclasshook__` 的 ABC，和上一节手写的 `Closer` 是同一个机制；输出末行 `Closable.__mro__` 里的 `Protocol` 和 `Generic` 也能印证它们走的是普通的继承链。没有加 `runtime_checkable` 时抛 `TypeError` 的那一段在第 2044 到 2049 行。

Rust 的 trait 要显式写 `impl Trait for Type`，哪怕 `Type` 恰好有同名方法；`Protocol` 不要任何声明，名字对得上就行，代价是名字对上不等于语义对上。

### 分析器里的两种选择

Sift 里两种都用了。`src/sift/analysis/base.py` 第 35 到 40 行是过滤器的协议：

```python
class TokenFilter(Protocol):
    """Anything callable that maps a token stream to a token stream."""

    def __call__(self, tokens: Iterable[Token]) -> Iterator[Token]:
        """Return the filtered tokens."""
        ...
```

任何“接收一个 `Token` 流、返回一个 `Token` 流”的可调用对象都是过滤器。`Pipeline` 不要求它们继承任何东西，所以一个普通函数也行。`/tmp/p07/scratch/function_filter.py`：

```python
"""A plain function is a TokenFilter: no base class, no registry."""

from collections.abc import Iterable, Iterator

from sift.analysis import (
    LatinTokenizer,
    NfkcCasefold,
    Pipeline,
    Token,
    TokenFilter,
)


def drop_short(tokens: Iterable[Token]) -> Iterator[Token]:
    """Drop tokens shorter than three characters."""
    return (token for token in tokens if len(token.text) >= 3)


def main() -> None:
    """Put a function into a Pipeline; try isinstance on the Protocol."""
    pipeline = Pipeline(LatinTokenizer(), NfkcCasefold(), drop_short)
    print(pipeline)
    print(pipeline.terms("The Kalman Filter in C++ is on"))
    print("TokenFilter members:", sorted(TokenFilter.__protocol_attrs__))
    try:
        isinstance(drop_short, TokenFilter)
    except TypeError as exc:
        print("TypeError:", exc)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p07/scratch/function_filter.py
Pipeline(LatinTokenizer, NfkcCasefold, function)
['the', 'kalman', 'filter', 'c++']
TokenFilter members: ['__call__']
TypeError: Instance and class checks can only be used with @runtime_checkable protocols
```

`drop_short` 是个函数，没有继承、没有注册，和 `NfkcCasefold` 并排放进 `Pipeline`，工作正常（`Pipeline` 的 `__repr__` 把它显示成 `function`）。最后两行说明我没有给 `TokenFilter` 加 `runtime_checkable`：`isinstance` 会直接报上面那个 `TypeError`。我猜运行时检查一个 `__call__` 在名字上比 `callable()` 多不了什么，所以没有加；这是猜测，没有对照实验。

分词器则选了 ABC：它们需要一个共同的 `analyze` 抽象方法，需要注册表，需要“漏了实现就不能实例化”的保证，这些都是名义上的继承才能给的。选哪个，看你要的是“能做某件事的任何东西”，还是“被我登记在册的一类东西”。

## `__init_subclass__`：class 语句就是注册

注册表这件事，最省事的写法是不写注册代码：让 `class` 语句自己注册。`lab/ch07/init_subclass_registry.py` 第 5 到 20 行：

```python
REGISTRY: dict[str, type[Plugin]] = {}


class Plugin:
    """Base class; each subclass names itself in its class line."""

    name: str

    def __init_subclass__(cls, /, name: str, **kwargs: Any) -> None:
        """Run once per subclass, right after the class is built."""
        super().__init_subclass__(**kwargs)
        if name in REGISTRY:
            raise ValueError(f"name taken: {name!r}")
        cls.name = name
        REGISTRY[name] = cls
        print(f"  registered {cls.__name__} as {name!r}")
```

主函数（第 23 到 48 行）定义两个插件，查注册表，再试着违反规则两次：

```python
def main() -> None:
    """Define plugins, look them up, then break the rules."""
    print("defining:")

    class Upper(Plugin, name="upper"):
        """Upper-case the text."""

    class Lower(Plugin, name="lower"):
        """Lower-case the text."""

    print("REGISTRY:", {k: v.__name__ for k, v in REGISTRY.items()})
    print("Upper.name:", Upper.name, "| Lower.name:", Lower.name)
    for attempt in ("duplicate", "missing"):
        try:
            if attempt == "duplicate":

                class Again(Plugin, name="upper"):
                    """Same name as Upper."""

            else:

                class Nameless(Plugin):
                    """No name keyword."""

        except (ValueError, TypeError) as exc:
            print(f"{attempt}: {type(exc).__name__}: {exc}")
```

```text
$ python3 lab/ch07/init_subclass_registry.py
defining:
  registered Upper as 'upper'
  registered Lower as 'lower'
REGISTRY: {'upper': 'Upper', 'lower': 'Lower'}
Upper.name: upper | Lower.name: lower
duplicate: ValueError: name taken: 'upper'
missing: TypeError: Plugin.__init_subclass__() missing 1 required positional argument: 'name'
```

`class Upper(Plugin, name="upper")` 里的 `name="upper"` 不是给 `Plugin` 的构造参数，是 `class` 语句的关键字参数，原样传给 `__init_subclass__`。每定义一个子类，`Plugin.__init_subclass__` 就跑一次，在类刚建好的时候，`print` 的缩进行能看到执行次序。两种违规各有各的报错：重名是我自己抛的 `ValueError`，漏写 `name` 是 Python 的 `TypeError`，因为它只是一个缺了必填参数的普通函数调用，消息里的 `Plugin.__init_subclass__()` 点明了被调用的是谁。

机制在 C 里很短。`Objects/typeobject.c` 第 4553 到 4557 行：定义里写成普通函数的 `__init_subclass__`，创建类时被偷偷改成 classmethod，所以代码里不用写 `@classmethod`：

```c
    /* Special-case __init_subclass__ and __class_getitem__:
       if they are plain functions, make them classmethods */
    if (type_new_classmethod(dict, &_Py_ID(__init_subclass__)) < 0) {
        return -1;
    }
```

类建好之后，`type_new_init_subclass`（第 11576 到 11600 行）做的是 `super(cls, cls).__init_subclass__(**kwds)`：

```c
static int
type_new_init_subclass(PyTypeObject *type, PyObject *kwds)
{
    PyObject *args[2] = {(PyObject *)type, (PyObject *)type};
    PyObject *super = PyObject_Vectorcall((PyObject *)&PySuper_Type,
                                          args, 2, NULL);
    if (super == NULL) {
        return -1;
    }

    PyObject *func = PyObject_GetAttr(super, &_Py_ID(__init_subclass__));
    Py_DECREF(super);
    if (func == NULL) {
        return -1;
    }

    PyObject *result = PyObject_VectorcallDict(func, NULL, 0, kwds);
    Py_DECREF(func);
    if (result == NULL) {
        return -1;
    }

    Py_DECREF(result);
    return 0;
}
```

先造一个 `super(type, type)`，再取它的 `__init_subclass__`，把类语句里的关键字参数倒进去。所以被调用的是 MRO 里排在新类后面的那个类的 `__init_subclass__`，也就是上一节 `super()` 的那套规则。这也是为什么 `super().__init_subclass__(**kwargs)` 要写在自己的钩子里：多重继承时，别的基类的钩子才轮得到。

### Sift 的注册表

`src/sift/analysis/base.py` 第 9 到 32 行，`Analyzer` 和它的 `REGISTRY`：

```python
REGISTRY: dict[str, type[Analyzer]] = {}


class Analyzer(ABC):
    """Turn text into a stream of tokens.

    A concrete subclass names itself in the class statement,
    ``class Foo(Analyzer, name="foo")``, and lands in REGISTRY under
    that name.
    """

    name: str

    def __init_subclass__(cls, /, name: str, **kwargs: Any) -> None:
        """Register the subclass in REGISTRY under name."""
        super().__init_subclass__(**kwargs)
        if name in REGISTRY:
            raise ValueError(f"analyzer name taken: {name!r}")
        cls.name = name
        REGISTRY[name] = cls

    @abstractmethod
    def analyze(self, text: str) -> Iterator[Token]:
        """Yield the tokens of text."""
```

和 lab 里的 `Plugin` 几乎一样，多了 `ABC` 和一个 `@abstractmethod`。第 9 行有个有意思的地方：`REGISTRY` 的注解里用了 `Analyzer`，而这个类要到第 12 行才定义。3.14 之前（没有 `from __future__ import annotations` 时），这行在导入时就会对注解求值，抛 `NameError`，我这里只有 3.14，没有验证旧版本；3.14 起注解是延迟求值的（PEP 649，实现在 `annotationlib`），模块级变量的注解也一样，直到有人读 `__annotations__` 才求。读一下：

```text
$ python3 -c '
import sift.analysis.base as base

print(base.__annotations__)
'
{'REGISTRY': dict[str, type[sift.analysis.base.Analyzer]]}
```

到了读的时候，`Analyzer` 早就存在了，注解于是求值成功。三个分词器的类语句各带一个名字，注册表里是什么：

```text
$ python3 -c '
from sift.analysis import FILTERS, REGISTRY

print(list(REGISTRY))
print(list(FILTERS))
'
['latin', 'cjk-bigram', 'mixed']
['nfkc', 'stopwords']
```

注册表按类语句执行的顺序排：`latin`、`cjk-bigram`、`mixed`。另有一个和它平行的字典 `FILTERS`，装着两个过滤器 `nfkc` 和 `stopwords`。为什么是两个字典，下一节说。

漏写 `name` 的限制在 Sift 里也存在，而且更扎眼：想在 `Analyzer` 和具体分词器之间加一个不注册的中间类（比如放共用的辅助方法），做不到：

```text
$ python3 -c '
from sift.analysis import Analyzer

class Middle(Analyzer): ...
' 2>&1 | tail -n 1
TypeError: Analyzer.__init_subclass__() missing 1 required positional argument: 'name'
```

`__init_subclass__` 对每一个子类都跑，包括中间类。要绕过它，得给 `name` 一个默认值，或者让中间类用别的办法声明自己不参与注册；我没有做，因为现在没有需要。

## 组合优于继承：`Pipeline`

分析器有两个正交的维度：怎么切词，切完之后要不要再加工（折叠大小写、去停用词）。用继承表达“切词加加工”，每多一种加工，类就翻倍。`lab/ch07/composition.py` 先把继承的写法摆出来（第 20 到 48 行）：

```python
# BAD: 每多一种组合就多一层继承
class LatinBase:
    """Hierarchy level 1: split into Latin words."""

    def analyze(self, text: str) -> Iterator[Token]:
        """Yield one token per Latin or digit run."""
        for i, m in enumerate(
            re.finditer(r"[0-9a-zA-Z_]+(?:\+{1,2}|#)?", text)
        ):
            yield Token(m[0], i, m.start(), m.end())


class LatinFolded(LatinBase):
    """Hierarchy level 2: tokenizer plus folding in one class."""

    def analyze(self, text: str) -> Iterator[Token]:
        """Fold token texts after the parent tokenizes."""
        for token in super().analyze(text):
            yield token._replace(text=token.text.casefold())


class LatinFoldedStop(LatinFolded):
    """Hierarchy level 3: one more behaviour, one more level."""

    def analyze(self, text: str) -> Iterator[Token]:
        """Drop stopwords after the parent folds."""
        for token in super().analyze(text):
            if token.text not in STOPWORDS:
                yield token
```

`LatinFolded` 是“拉丁切词加折叠”，`LatinFoldedStop` 又在它上面“加去停用词”，每个组合一个类，而且只能按这个顺序叠。主函数（第 56 到 76 行）用 Sift 真正的 `Pipeline` 重做一遍，并数类的个数：

```python
def main() -> None:
    """Build the same analyzer both ways and count the classes."""
    by_hierarchy = texts(list(LatinFoldedStop().analyze(TEXT)))
    by_pipeline = build_pipeline(["latin", "nfkc", "stopwords"])
    print("hierarchy:", by_hierarchy)
    print("pipeline :", by_pipeline.terms(TEXT))
    print("same     :", by_hierarchy == by_pipeline.terms(TEXT))

    n_tok, n_filt = len(REGISTRY), len(FILTERS)
    # every subset of filters, in a fixed order, per tokenizer
    combos = n_tok * 2**n_filt
    print(f"{n_tok} tokenizers, {n_filt} filters")
    print(f"one class per combination: {combos} classes")
    print(f"composition: {n_tok + n_filt} classes + Pipeline")
    print("with 10 tokenizers and 10 filters:", 10 * 2**10, "vs", 20)

    print("every combination, built by composition:")
    for tok, flags in product(REGISTRY, product([0, 1], repeat=n_filt)):
        names = [tok, *(f for f, on in zip(FILTERS, flags, strict=True) if on)]
        print(f"  {' + '.join(names):32}", build_pipeline(names).terms(TEXT))
    print("filters used:", NfkcCasefold.name, StopwordFilter.name)
```

```text
$ python3 lab/ch07/composition.py
hierarchy: ['kalman', 'filter', 'c++', 'port']
pipeline : ['kalman', 'filter', 'c++', 'port']
same     : True
3 tokenizers, 2 filters
one class per combination: 12 classes
composition: 5 classes + Pipeline
with 10 tokenizers and 10 filters: 10240 vs 20
every combination, built by composition:
  latin                            ['The', 'Kalman', 'Filter', 'and', 'the', 'C++', 'port']
  latin + stopwords                ['The', 'Kalman', 'Filter', 'C++', 'port']
  latin + nfkc                     ['the', 'kalman', 'filter', 'and', 'the', 'c++', 'port']
  latin + nfkc + stopwords         ['kalman', 'filter', 'c++', 'port']
  cjk-bigram                       []
  cjk-bigram + stopwords           []
  cjk-bigram + nfkc                []
  cjk-bigram + nfkc + stopwords    []
  mixed                            ['the', 'kalman', 'filter', 'and', 'the', 'c++', 'port']
  mixed + stopwords                ['kalman', 'filter', 'c++', 'port']
  mixed + nfkc                     ['the', 'kalman', 'filter', 'and', 'the', 'c++', 'port']
  mixed + nfkc + stopwords         ['kalman', 'filter', 'c++', 'port']
filters used: nfkc stopwords
```

两种写法对同一句话给出同一个答案 (`same : True`)，但账不一样：3 个分词器、2 个过滤器，每个过滤器可有可无，一个类一个组合是 $3 \times 2^2 = 12$ 个类；组合的写法是 3 + 2 = 5 个类，外加一个 `Pipeline`。到了 10 个分词器和 10 个过滤器，$10 \times 2^{10} = 10240$ 个类对 20 个。输出末尾的十二个组合是 `Pipeline` 在运行时现拼出来的，没有写一个新的类。

十二行输出还顺带说明了一件继承写法表达不了的事：过滤器的顺序和有无是数据。`latin + stopwords` 去掉了 `and` 和小写的 `the`，留下了 `The`，因为没有先折叠，停用词表又区分大小写；`latin + nfkc + stopwords` 先折叠再过滤，两个 `the` 都没了。`cjk-bigram` 一行全是空列表：它根本不看拉丁文。

`src/sift/analysis/pipeline.py` 第 9 到 45 行就是这个类和 `build_pipeline`：

```python
DEFAULT_NAMES = ("mixed", "nfkc")


class Pipeline:
    """Run a tokenizer, then each filter on the stream in order."""

    def __init__(self, tokenizer: Analyzer, *filters: TokenFilter) -> None:
        """Keep the tokenizer and the filters."""
        self.tokenizer = tokenizer
        self.filters = filters

    def analyze(self, text: str) -> Iterator[Token]:
        """Yield the tokens of text after every stage."""
        tokens = self.tokenizer.analyze(text)
        for stage in self.filters:
            tokens = stage(tokens)
        return tokens

    def terms(self, text: str) -> list[str]:
        """Return the token texts of text."""
        return [token.text for token in self.analyze(text)]

    def __repr__(self) -> str:
        """Return a repr that names every stage."""
        stages = [self.tokenizer, *self.filters]
        return f"Pipeline({', '.join(type(s).__name__ for s in stages)})"


def build_pipeline(names: Sequence[str] = DEFAULT_NAMES) -> Pipeline:
    """Build a Pipeline from names: a tokenizer, then filters.

    Raise KeyError for an unknown name, or for a filter name in the
    first place or a tokenizer name after it.
    """
    first, *rest = names
    tokenizer = REGISTRY[first]()
    return Pipeline(tokenizer, *(FILTERS[name]() for name in rest))
```

`analyze` 里的循环只是把生成器一层包一层：`tokens = stage(tokens)` 不消费任何东西，谁迭代最外层，谁才驱动整条链，每个词元一次一次地穿过每一层，中间没有列表（第 5 篇讲过惰性的账）。代价也是同一个来源：每多一层，每个词元就多一次生成器帧的恢复，后面会量。`DEFAULT_NAMES` 是 `("mixed", "nfkc")`，也就是说默认流水线是 `mixed` 加 `nfkc`。

`build_pipeline` 对坏名字的反应，我用 `/tmp/p07/scratch/pipeline_errors.py` 试了四种：

```python
"""What build_pipeline says about bad names."""

from sift.analysis import build_pipeline


def main() -> None:
    """Try four bad name lists and print what comes out."""
    for names in (["nope"], ["nfkc"], ["mixed", "latin"], []):
        try:
            build_pipeline(names)
        except (KeyError, ValueError) as exc:
            print(f"{names!s:20} {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p07/scratch/pipeline_errors.py
['nope']             KeyError: 'nope'
['nfkc']             KeyError: 'nfkc'
['mixed', 'latin']   KeyError: 'latin'
[]                   ValueError: not enough values to unpack (expected at least 1, got 0)
```

未知名字、放错位置的名字（`["nfkc"]` 把过滤器放在第一位，`["mixed", "latin"]` 把分词器放在后面）都是 `KeyError`，和文档字符串说的一样。空列表不是：`first, *rest = names` 解包失败，抛的是 `ValueError`，文档字符串没提这一种。这是个小疏漏，我没法在这一篇里改仓库，记在这里。

### 两个注册表

过滤器也要有名字，好让 `build_pipeline(["mixed", "nfkc"])` 找到它们，但它们不是 `Analyzer`：分词器吃文本，过滤器吃词元流。所以 `filters.py` 里有另一个基类和另一个字典，和 `REGISTRY` 平行。第 7 到 11 行是字典和占位的停用词表（中间的 25 个词我省略了，后面会数），第 37 到 86 行是表的收尾、基类和两个过滤器：

```python
FILTERS: dict[str, type[TokenFilterBase]] = {}

# Placeholder list; ch11 moves it into stopwords.txt.
STOPWORDS = frozenset(
    {
    # ...
    }
)


class TokenFilterBase:
    """Base of the named filters: registers itself in FILTERS."""

    name: str

    def __init_subclass__(cls, /, name: str) -> None:
        """Register the subclass in FILTERS under name."""
        super().__init_subclass__()
        if name in FILTERS:
            raise ValueError(f"filter name taken: {name!r}")
        cls.name = name
        FILTERS[name] = cls

    def __call__(self, tokens: Iterable[Token]) -> Iterator[Token]:
        """Return the filtered tokens."""
        raise NotImplementedError


class NfkcCasefold(TokenFilterBase, name="nfkc"):
    """NFKC-normalize and casefold the text of every token."""

    def __call__(self, tokens: Iterable[Token]) -> Iterator[Token]:
        """Yield each token with its text folded."""
        for token in tokens:
            text = fold(token.text)
            if text != token.text:
                token = token._replace(text=text)
            yield token


class StopwordFilter(TokenFilterBase, name="stopwords"):
    """Drop tokens whose text is a stopword.

    Positions of the other tokens are not renumbered, so a phrase
    match still sees the gap.
    """

    def __init__(self, words: frozenset[str] = STOPWORDS) -> None:
        """Keep the stopword set."""
        self.words = words

    def __call__(self, tokens: Iterable[Token]) -> Iterator[Token]:
        """Yield the tokens that are not stopwords."""
        for token in tokens:
            if token.text not in self.words:
                yield token
```

这不是我想要的样子，三处别扭：

- `TokenFilterBase.__init_subclass__` 是 `Analyzer.__init_subclass__` 的复制，只差字典名、错误消息，以及不转发 `**kwargs`。
- `TokenFilterBase` 不是 ABC，`__call__` 靠 `raise NotImplementedError` 来要求子类实现。后果是漏写 `__call__` 的子类照样能实例化，到第一次调用才炸：

  ```text
  $ python3 -c '
  from sift.analysis.filters import TokenFilterBase

  class Bad(TokenFilterBase, name="bad"): ...

  bad = Bad()
  print("instantiated:", bad.name)
  bad([])
  ' 2>&1 | sed "s|$HOME|~|"
  instantiated: bad
  Traceback (most recent call last):
    File "<string>", line 8, in <module>
      bad([])
      ~~~^^^^
    File "~/Projects/sift/src/sift/analysis/filters.py", line 56, in __call__
      raise NotImplementedError
  NotImplementedError
  ```

  对比上面 `Half()` 在实例化时就拒绝，这个检查晚得多，也没有 `Analyzer` 那种“少哪个方法”的消息。

- 两个字典各管各的名字，所以按代码推断，一个分词器和一个过滤器可以同名（我没有试），`build_pipeline` 只能靠位置（第一个是分词器，其余是过滤器）判断去哪个字典查。

`TokenFilterBase` 也不是上一节的 `TokenFilter` 协议：协议描述形状，基类负责登记，两件事现在混在了名字相近的两个东西里。要合并成一个泛型的注册基类并不难，我留给练习 1。

## `collections.abc`：写三个方法，送六个

上一篇的 `InvertedIndex` 手写了四个方法，每一个都只是把调用转给内部字典。我猜让它继承 `collections.abc.Mapping`，写 `__getitem__`、`__iter__`、`__len__` 三个，`keys`、`items`、`get`、`__eq__` 就送上门，这一章我来验证。先在一个小类上试：`lab/ch07/collections_abc.py` 第 6 到 23 行，一个键不区分大小写的只读映射：

```python
class Upper(Mapping[str, int]):
    """A read-only copy of a dict with upper-cased keys."""

    def __init__(self, data: dict[str, int]) -> None:
        """Store the data under upper-cased keys."""
        self._data = {k.upper(): v for k, v in data.items()}

    def __getitem__(self, key: str) -> int:
        """Return the value of key, ignoring case."""
        return self._data[key.upper()]

    def __iter__(self) -> Iterator[str]:
        """Iterate over the upper-cased keys."""
        return iter(self._data)

    def __len__(self) -> int:
        """Return the number of keys."""
        return len(self._data)
```

主函数（第 26 到 65 行）把 `Mapping` 提供的每个方法都调一遍，最后看 `InvertedIndex`：

```python
def main() -> None:
    """Call every method that Mapping provides."""
    view = Upper({"tea": 3, "River": 5})
    mine = ("__getitem__", "__iter__", "__len__", "__contains__", "get")
    print("own methods :", [n for n in mine if n in vars(Upper)])
    print("keys()      :", list(view.keys()))
    print("values()    :", list(view.values()))
    print("items()     :", list(view.items()))
    print("get         :", view.get("tea"), view.get("none", -1))
    print("in          :", "river" in view, "bicycle" in view)
    print("==          :", view == {"TEA": 3, "RIVER": 5})
    print("dict(view)  :", dict(view))
    inherited = [
        name
        for name in (
            "keys",
            "items",
            "values",
            "get",
            "__contains__",
            "__eq__",
        )
        if name not in vars(Upper)
    ]
    print("inherited   :", inherited)
    print("MRO         :", [c.__name__ for c in Upper.__mro__])
    try:
        view["x"] = 1  # type: ignore[index]
    except TypeError as exc:
        print("TypeError   :", exc)

    from sift.index import InvertedIndex

    print("InvertedIndex is a Mapping:", issubclass(InvertedIndex, Mapping))
    own = [
        n
        for n in ("__getitem__", "__iter__", "__len__", "keys", "get")
        if n in vars(InvertedIndex)
    ]
    print("defined on InvertedIndex:", own)
```

```text
$ python3 lab/ch07/collections_abc.py
own methods : ['__getitem__', '__iter__', '__len__']
keys()      : ['TEA', 'RIVER']
values()    : [3, 5]
items()     : [('TEA', 3), ('RIVER', 5)]
get         : 3 -1
in          : True False
==          : True
dict(view)  : {'TEA': 3, 'RIVER': 5}
inherited   : ['keys', 'items', 'values', 'get', '__contains__', '__eq__']
MRO         : ['Upper', 'Mapping', 'Collection', 'Sized', 'Iterable', 'Container', 'object']
TypeError   : 'Upper' object does not support item assignment
InvertedIndex is a Mapping: True
defined on InvertedIndex: ['__getitem__', '__iter__', '__len__']
```

三个方法是 `__getitem__`、`__iter__`、`__len__`（`own methods` 一行），其余都是继承来的：`keys`、`items`、`values`、`get`、`__contains__`、`__eq__`。MRO 里的 `Mapping`、`Collection`、`Sized`、`Iterable`、`Container` 就是这些方法的来处。`view["x"] = 1` 报 `TypeError`，因为 `Mapping` 是只读的，没有 `__setitem__`。`InvertedIndex` 在最后两行：它是 `Mapping`，自己的字典里正好是那三个。

“免费”的东西在 `Lib/_collections_abc.py` 第 792 到 824 行：

```python
    # ...
    def get(self, key, default=None):
        'D.get(k[,d]) -> D[k] if k in D, else d.  d defaults to None.'
        try:
            return self[key]
        except KeyError:
            return default

    def __contains__(self, key):
        try:
            self[key]
        except KeyError:
            return False
        else:
            return True

    def keys(self):
        "D.keys() -> a set-like object providing a view on D's keys"
        return KeysView(self)

    def items(self):
        "D.items() -> a set-like object providing a view on D's items"
        return ItemsView(self)

    def values(self):
        "D.values() -> an object providing a view on D's values"
        return ValuesView(self)

    def __eq__(self, other):
        if not isinstance(other, Mapping):
            return NotImplemented
        return dict(self.items()) == dict(other.items())

    __reversed__ = None
```

全是用 `self[key]` 和 `self.items()` 写的，所以只要 `__getitem__` 对，其余就对。`InvertedIndex` 现在是这样（`src/sift/index.py` 第 139 到 144 行和第 185 到 195 行，中间的 `add` 等方法我省略了）：

```python
class InvertedIndex(Mapping[str, PostingList]):
    """Map each term to the PostingList of the documents holding it.

    Only __getitem__, __iter__ and __len__ are written here; Mapping
    supplies keys, items, values, get, __contains__ and __eq__.
    """
    # ...
    def __getitem__(self, term: str) -> PostingList:
        """Return the posting list of term; KeyError if unknown."""
        return self._postings[term]

    def __len__(self) -> int:
        """Return the number of distinct terms."""
        return len(self._postings)

    def __iter__(self) -> Iterator[str]:
        """Iterate over the terms in the order they first appeared."""
        return iter(self._postings)
```

这一章对 `InvertedIndex` 的改动不只是换基类：`__init__` 多了 `_doc_lens` 和 `documents` 两个字典，`add()` 在建倒排表的同时数每篇文档的词元数、记下文档，另外新增了 `doc_len(doc_id)`、`n_docs` 和 `avg_doc_len`（都在 `src/sift/index.py` 第 146 到 183 行，上面的节选里省略了）。这些是后面做评分要用的语料统计，和 `Mapping` 无关。

上一篇手写的 `__contains__` 被删掉了。这一删有三个后果，各有各的数。

**`in` 变慢了。** 第 799 到 805 行的 `__contains__` 是 `try: self[key] except KeyError`：词不存在时，真的会抛一个异常再捕获。`/tmp/p07/scratch/contains_cost.py` 在上一篇和这一篇的 `InvertedIndex` 上各量 `term in index` 的纳秒数（脚本很短：建一次索引，对命中词 `kalman` 和不存在的词 `zzzz` 各跑 100 万次 `timeit`，取 5 次里的最小值），两版轮流跑 5 轮：

```python
"""Cost of `term in index`: hand-written vs inherited __contains__."""

import timeit
from pathlib import Path

from sift.__main__ import load_index

N = 1_000_000


def main() -> None:
    """Print ns per membership test for a hit and for a miss."""
    _, index = load_index(Path("corpus/posts"))
    for label, term in (("hit ", "kalman"), ("miss", "zzzz")):
        env = {"term": term, "index": index}
        runs = timeit.repeat("term in index", globals=env, number=N, repeat=5)
        print(f"{label} {min(runs) / N * 1e9:6.0f} ns")


if __name__ == "__main__":
    main()
```

```text
$ for i in 1 2 3 4 5; do
  for c in ch06 ch07; do
    echo "$c $(at $c /tmp/p07/scratch/contains_cost.py 2>/dev/null | tr '\n' ' ')"
  done
done
ch06 hit      66 ns miss     66 ns 
ch07 hit      98 ns miss    328 ns 
ch06 hit      67 ns miss     67 ns 
ch07 hit      94 ns miss    346 ns 
ch06 hit      68 ns miss     70 ns 
ch07 hit      97 ns miss    341 ns 
ch06 hit      65 ns miss     69 ns 
ch07 hit      94 ns miss    330 ns 
ch06 hit      69 ns miss     69 ns 
ch07 hit      93 ns miss    333 ns 
```

最小值：命中从 65 ns 到 93 ns（1.4 倍），不存在的词从 66 ns 到 328 ns（5.0 倍）。差的 260 来 ns 就是抛出并捕获一个 `KeyError` 的价格。`search_index` 对每个查询词做一次 `index[t] if t in index else PostingList()`，一次查询几个词，这点开销看不见；但如果在遍历词表的循环里这样查，它就会变成热点。两行的覆盖 (`return term in self._postings`) 就能找回，我留给练习 2。

**`==` 白送。** 用前 5 篇文档各建一个索引，建两次，再比较（`/tmp/p07/scratch/mapping_gifts.py`，建索引用的是默认流水线）：

```python
"""What InvertedIndex gained from Mapping, and what it lost."""

import sys
from pathlib import Path

from sift.analysis import build_pipeline
from sift.corpus import iter_documents
from sift.index import InvertedIndex


def build(limit: int) -> InvertedIndex:
    """Index the first limit documents with the default pipeline."""
    pipeline = build_pipeline()
    index = InvertedIndex()
    for i, doc in enumerate(iter_documents(Path("corpus/posts"))):
        if i == limit:
            break
        index.add(doc, pipeline.analyze(doc.body))
    return index


def main() -> None:
    """Show keys, get, ==, hash and a mapping pattern."""
    a, b = build(5), build(5)
    print("len:", len(a), "| keys sample:", list(a.keys())[:4])
    print("get miss:", a.get("zzzz"), "| get hit:", a.get("the") is not None)
    print("a == b:", a == b, "| a is b:", a is b)
    print("a == build(4):", a == build(4))
    print("__hash__:", InvertedIndex.__hash__)
    try:
        hash(a)
    except TypeError as exc:
        print("TypeError:", exc)
    match a:
        case {"the": posting}:
            print("mapping pattern:", type(posting).__name__)
    print("python:", sys.version_info[:3])


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p07/scratch/mapping_gifts.py
len: 8475 | keys sample: ['i', 'mx6ull', '的核', '核心']
get miss: None | get hit: True
a == b: True | a is b: False
a == build(4): False
__hash__: None
TypeError: unhashable type: 'InvertedIndex'
mapping pattern: PostingList
python: (3, 14, 7)
```

`a == b` 为真，`a == build(4)` 为假。继承来的 `__eq__`（第 819 到 822 行）把两边的 `items()` 各倒成字典再比，值是 `PostingList`，比的是第 6 篇写的 `PostingList.__eq__`。

**`InvertedIndex` 不能哈希了。** 同一份输出里 `__hash__: None` 和 `TypeError: unhashable type: 'InvertedIndex'`：`Mapping` 定义了 `__eq__` 却没有定义 `__hash__`，第 6 篇说过，这样的类 `__hash__` 会被设成 `None`。上一版的索引是普通类，按身份哈希。直接对比：

```text
$ at ch06 -c 'from sift.index import InvertedIndex as I; print(I.__hash__ is object.__hash__)'
True
$ at ch07 -c 'from sift.index import InvertedIndex as I; print(I.__hash__)'
None
```

我没有逐处检查有没有代码依赖索引可哈希，这是行为变化，记在这里。

还有一个意外收获，也在同一份输出里：`match a: case {"the": posting}` 匹配成功，`posting` 是 `PostingList`。`Mapping` 的第 786 行 `__abc_tpflags__ = 1 << 6`，注释写着 `Py_TPFLAGS_MAPPING`，这个标志让它的子类在 `match` 里被当成映射（我没有读 `match` 的实现，这是对照注释的推断，匹配成功是实测）。下一篇的查询语言要用 `match`，这一条用得上。

## `singledispatchmethod`：按类型选方法体

最后一个特性只在 lab 里出现，Sift 里没有用它（`grep -rn singledispatch src | wc -l` 的输出是 0，见下面输出的最后一行）。`lab/ch07/singledispatch_method.py` 第 8 到 33 行：

```python
class Analyze:
    """Turn a str, a list of str or a bytes object into terms."""

    def __init__(self, pipeline: Pipeline) -> None:
        """Keep the pipeline."""
        self.pipeline = pipeline

    @singledispatchmethod
    def terms(self, source: object) -> list[str]:
        """Reject a source type nobody registered."""
        raise TypeError(f"cannot analyze {type(source).__name__}")

    @terms.register
    def _(self, source: str) -> list[str]:
        """Analyze one string."""
        return self.pipeline.terms(source)

    @terms.register
    def _(self, source: list) -> list[str]:
        """Analyze each item and concatenate."""
        return [t for item in source for t in self.terms(item)]

    @terms.register
    def _(self, source: bytes) -> list[str]:
        """Decode as UTF-8, then analyze the string."""
        return self.terms(source.decode("utf-8"))
```

```text
$ python3 lab/ch07/singledispatch_method.py
['kalman', 'filter']
['kalman', '卡尔', '尔曼', '曼滤', '滤波']
['所有', '有权']
TypeError: cannot analyze float
$ grep -rn singledispatch src | wc -l
0
```

`@singledispatchmethod` 装饰的第一个函数是兜底，不认识的类型落到这里，抛 `TypeError`；后面三个 `@terms.register` 没有传类型，靠的是第一个参数（`self` 之后）的注解 `str`、`list`、`bytes`。`bytes` 那个版本解码以后又调一次 `self.terms(...)`，再次分派到 `str` 的版本。

“`self` 之后的第一个参数”从哪来？`singledispatchmethod` 是个描述符，`__get__` 返回一个绑定了实例的小对象，它的 `__call__` 才是分派的地方，`Lib/functools.py` 第 1063 到 1069 行：

```python
    def __call__(self, /, *args, **kwargs):
        if not args:
            funcname = getattr(self._unbound.func, '__name__',
                               'singledispatchmethod method')
            raise TypeError(f'{funcname} requires at least '
                            '1 positional argument')
        return self._dispatch(args[0].__class__).__get__(self._obj, self._cls)(*args, **kwargs)
```

`self._obj` 是实例，`args` 里没有它，所以 `args[0]` 就是 `self` 之后的第一个参数；`args[0].__class__` 交给 `singledispatch` 的分派函数，挑出实现，再用 `__get__` 绑上实例调用。分派只看这一个参数的类型，所以叫“单分派”。

## 三个分词器，一份语料

注册表里有了三个分词器，该看看它们在真实语料上差多少。`src/sift/analysis/tokenizers.py` 第 9 到 57 行：

```python
_LATIN = re.compile(r"[0-9a-z_]+(?:\+{1,2}|\#)?", re.IGNORECASE)
_CJK_RUN = re.compile(f"[{CJK}]+")


class LatinTokenizer(Analyzer, name="latin"):
    """Yield Latin and digit runs; CJK text produces nothing.

    The text is not folded: offsets are into the argument and the
    token text keeps its case. Add NfkcCasefold to the pipeline.
    """

    def analyze(self, text: str) -> Iterator[Token]:
        """Yield one token per Latin or digit run."""
        for position, match in enumerate(_LATIN.finditer(text)):
            yield Token(match[0], position, match.start(), match.end())


class CjkBigramTokenizer(Analyzer, name="cjk-bigram"):
    """Yield overlapping bigrams of CJK runs; Latin text is skipped.

    A run of one character yields one unigram. The text is not
    folded, and offsets are into the argument.
    """

    def analyze(self, text: str) -> Iterator[Token]:
        """Yield the bigrams of every CJK run."""
        position = 0
        for match in _CJK_RUN.finditer(text):
            run = match[0]
            if len(run) == 1:
                yield Token(run, position, match.start(), match.end())
                position += 1
                continue
            for i in range(len(run) - 1):
                start = match.start() + i
                yield Token(run[i : i + 2], position, start, start + 2)
                position += 1


class MixedTokenizer(Analyzer, name="mixed"):
    """Latin words and CJK bigrams together: the ch05 iter_tokens.

    Unlike the other two it folds the text itself, so its offsets are
    into the NFKC-normalized, casefolded text.
    """

    def analyze(self, text: str) -> Iterator[Token]:
        """Yield the tokens of iter_tokens(text)."""
        return iter_tokens(text)
```

`MixedTokenizer` 不过是上一篇的 `iter_tokens`，包了一层 `Analyzer` 的壳；另外两个把它拆成两半，一个只认拉丁词和数字，一个只认 CJK 双字组。`lab/ch07/analyzers_compare.py` 对同样的三篇文章数词元，再对整个语料算词表大小（第 17 到 43 行）：

```python
def vocabulary(name: str) -> tuple[int, int]:
    """Return (distinct terms, tokens) of the whole corpus."""
    pipeline = build_pipeline([name, "nfkc"])
    terms: set[str] = set()
    count = 0
    for doc in iter_documents(CORPUS):
        for token in pipeline.analyze(doc.body):
            terms.add(token.text)
            count += 1
    return len(terms), count


def main() -> None:
    """Print counts and samples per post, then corpus vocabularies."""
    docs = {d.path.name: d for d in iter_documents(CORPUS)}
    for post in POSTS:
        body = docs[post].body
        print(f"== {post} ({len(body)} chars)")
        for name in REGISTRY:
            terms = build_pipeline([name, "nfkc"]).terms(body)
            print(f"{name:11} {len(terms):6} tokens  {terms[:SAMPLE]}")
    print("== whole corpus, tokenizer + nfkc")
    print(f"{'analyzer':11} {'vocabulary':>10} {'tokens':>8}")
    for name in REGISTRY:
        vocab, tokens = vocabulary(name)
        print(f"{name:11} {vocab:>10} {tokens:>8}")
    print("registry:", list(REGISTRY))
```

```text
$ python3 lab/ch07/analyzers_compare.py
== notes-of-effective-cmake.md (21861 chars)
latin         3179 tokens  ['1', 'the', 'philosophy', 'of', 'modern', 'cmake', 'why', 'effective']
cjk-bigram       0 tokens  []
mixed         3179 tokens  ['1', 'the', 'philosophy', 'of', 'modern', 'cmake', 'why', 'effective']
== vmware-keyboard-lag-fix.md (1448 chars)
latin           92 tokens  ['vmware', 'workstation', '17', 'x', 'vmware', 'workstatio', '17', 'pro']
cjk-bigram     697 tokens  ['问题', '题描', '描述', '在', '中的', '的虚', '虚拟', '拟机']
mixed          789 tokens  ['问题', '题描', '描述', '在', 'vmware', 'workstation', '17', 'x']
== understanding-logic-of-concession.md (1545 chars)
latin           54 tokens  ['a', 'rightarrow', 'b', 'a', 'b', 'leftarrow', 'a', 'b']
cjk-bigram     751 tokens  ['什么', '么是', '让步', '的逻', '逻辑', '辑内', '内核', '在正']
mixed          805 tokens  ['什么', '么是', '让步', '的逻', '逻辑', '辑内', '内核', '在正']
== whole corpus, tokenizer + nfkc
analyzer    vocabulary   tokens
latin            14248   360303
cjk-bigram       66938   452028
mixed            81192   812338
registry: ['latin', 'cjk-bigram', 'mixed']
```

先看整个语料那一段，三行：

| 分析器 | 词表大小 | 词元数 |
| --- | --- | --- |
| `latin` | 14,248 | 360,303 |
| `cjk-bigram` | 66,938 | 452,028 |
| `mixed` | 81,192 | 812,338 |

纯英文的 `notes-of-effective-cmake.md` 上，`latin` 和 `mixed` 一样是 3179 个词元，`cjk-bigram` 是 0。中文为主的 `vmware-keyboard-lag-fix.md` 上，`latin` 只剩 92 个词元，`mixed` 有 789 个（8.6 倍）：它的正文几乎全是中文，拉丁分词器只捡得到夹在里面的 `VMware` 这几个词。`latin` 样本里那个 `workstatio` 不是我的 bug，是原文的笔误，该文件第 23 行写的就是 `VMware Workstatio 17 Pro`：

```text
$ grep -n 'Workstatio ' corpus/posts/vmware-keyboard-lag-fix.md
23:+ VMware Workstatio 17 Pro：17.6.3 build-24583834
```

注册表的内容和顺序（`registry:` 那一行）已经在上一节见过。`mixed` 的词表（81,192 个词）和上一篇完全一样。

### 7 个词元的差

`latin` 加 `cjk-bigram` 的词元数是 360,303 加 452,028，等于 812,331，`mixed` 是 812,338。差 7。两个分词器拼起来应该就是 `mixed` 才对，这 7 个是哪来的？我猜是折叠发生的时机：`MixedTokenizer` 先对整篇文本做 NFKC 和 `casefold`，再切词；`LatinTokenizer` 和 `CjkBigramTokenizer` 按 `tokenizers.py` 第 14 到 18 行的文档字符串，不折叠，切完再交给后面的 `nfkc` 过滤器。逐篇对一下 (`/tmp/p07/scratch/gap.py`)：

```python
"""Documents where latin + cjk-bigram tokens differ from mixed."""

from pathlib import Path

from sift.analysis import build_pipeline
from sift.corpus import iter_documents


def main() -> None:
    """Print the token counts of each document with a nonzero gap."""
    names = ("latin", "cjk-bigram", "mixed")
    pipelines = {name: build_pipeline([name, "nfkc"]) for name in names}
    total = 0
    for doc in iter_documents(Path("corpus/posts")):
        counts = [len(pipelines[n].terms(doc.body)) for n in names]
        gap = counts[2] - counts[0] - counts[1]
        if gap:
            total += gap
            print(f"{doc.path.name:50} {counts} {gap:+d}")
    print("total gap:", total)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p07/scratch/gap.py
linear-algebra-12-graphs-and-incidence-matrices.md [1737, 2871, 4599] -9
linear-algebra-14-orthogonal-subspaces.md          [1521, 2797, 4317] -1
linear-algebra-15-projections.md                   [2004, 2182, 4179] -7
linear-algebra-24b-quiz-2-review.md                [1769, 2050, 3811] -8
pid-control-08-mimo.md                             [4630, 5400, 10031] +1
typst-by-xuan-01-first-document.md                 [1714, 4401, 6121] +6
typst-by-xuan-02-code-mode.md                      [2198, 2604, 4803] +1
typst-by-xuan-04-set-and-show.md                   [1956, 3344, 5303] +3
typst-by-xuan-05-fonts-and-cjk.md                  [3023, 4613, 7641] +5
typst-by-xuan-07-context-counters-state.md         [3277, 4779, 8063] +7
typst-by-xuan-08-math.md                           [3499, 4404, 7901] -2
typst-by-xuan-15-wasm-plugin.md                    [1877, 3813, 5693] +3
typst-by-xuan-16-export-and-tooling.md             [3940, 4996, 8944] +8
total gap: 7
```

13 篇文档有差，符号两个方向都有，合计 +7。差在上标、下标之类的字符上，NFKC 会把它们变成普通字母。我挑了两种情形验证：

```text
$ python3 -c '
from sift.analysis import build_pipeline

for text in ("Aᵀb", "a ⁿ b"):
    for name in ("latin", "mixed"):
        terms = build_pipeline([name, "nfkc"]).terms(text)
        print(f"{text!r:9} {name:6}", terms)
'
'Aᵀb'     latin  ['a', 'b']
'Aᵀb'     mixed  ['atb']
'a ⁿ b'   latin  ['a', 'b']
'a ⁿ b'   mixed  ['a', 'n', 'b']
```

`Aᵀb` 在 `latin` 里是 `a` 和 `b`（`ᵀ` 不是 `[0-9a-z_]`，把词切断了），在 `mixed` 里先折叠成 `Atb`，是一个词 `atb`：三个字符连成了一个词，词元少了一个。`a ⁿ b` 反过来，`ⁿ` 折叠成 `n`，原来看不见的字符多出一个词元。两个方向各有一例，和上面 13 篇里正负号都有是对得上的。这是我的推断加两个例子，不是对 13 篇逐个验证。

还有一个更要紧的差别：偏移量。`/tmp/p07/scratch/offsets.py` 把 `Token` 的 `start`、`end` 拿去切原文：

```python
"""Offsets: unfolded tokenizers against the folding one."""

from sift.analysis import build_pipeline

TEXT = "ﬁnal Aᵀb on 滤波"


def main() -> None:
    """Print every token with its offsets and the text it covers."""
    print(f"text: {TEXT!r} ({len(TEXT)} chars)")
    for name in ("latin", "cjk-bigram", "mixed"):
        for token in build_pipeline([name, "nfkc"]).analyze(TEXT):
            cut = TEXT[token.start : token.end]
            print(f"{name:11} {token}  TEXT[start:end] = {cut!r}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p07/scratch/offsets.py
text: 'ﬁnal Aᵀb on 滤波' (14 chars)
latin       Token(text='nal', position=0, start=1, end=4)  TEXT[start:end] = 'nal'
latin       Token(text='a', position=1, start=5, end=6)  TEXT[start:end] = 'A'
latin       Token(text='b', position=2, start=7, end=8)  TEXT[start:end] = 'b'
latin       Token(text='on', position=3, start=9, end=11)  TEXT[start:end] = 'on'
cjk-bigram  Token(text='滤波', position=0, start=12, end=14)  TEXT[start:end] = '滤波'
mixed       Token(text='final', position=0, start=0, end=5)  TEXT[start:end] = 'ﬁnal '
mixed       Token(text='atb', position=1, start=6, end=9)  TEXT[start:end] = 'ᵀb '
mixed       Token(text='on', position=2, start=10, end=12)  TEXT[start:end] = 'n '
mixed       Token(text='滤波', position=3, start=13, end=15)  TEXT[start:end] = '波'
```

`latin` 和 `cjk-bigram` 的 `TEXT[start:end]` 切出来的就是词元对应的原文：`ﬁ` 连字不是 `[0-9a-z_]`，`latin` 只切出 `nal`；`A` 的词元文本被后面的 `nfkc` 过滤器折叠成了 `a`，偏移量照旧是对原文的。`mixed` 的偏移量不是对原文的，而是对折叠后的文本的：`ﬁ` 连字折叠成两个字母 `fi`，后面的所有偏移量都比原文大 1，`TEXT[start:end]` 切出来就是 `'ﬁnal '`、`'ᵀb '`、`'n '`，歪了。`Token` 的文档字符串（`tokenize.py` 第 28 到 30 行）早就说了 `start`、`end` 是折叠后文本的偏移量，但只有 `mixed` 这么做。三个分词器对偏移量的含义不一致，我没有统一它们，只在各自的文档字符串里写明（`LatinTokenizer`：“offsets are into the argument”，`MixedTokenizer`：“its offsets are into the NFKC-normalized, casefolded text”）。任何拿偏移量回头切原文的代码，都要先知道自己拿的是哪一种。

## 默认流水线：和上一篇一模一样

`pipeline.py` 里的 `DEFAULT_NAMES` 是 `("mixed", "nfkc")`，所以不指定流水线时，`load_index` 和 `search_index` 用的就是它。`src/sift/__main__.py` 第 22 到 37 行：

```python
@timed
def load_index(
    root: Path, pipeline: Pipeline | None = None
) -> tuple[list[Document], InvertedIndex]:
    """Read, analyze and index every Markdown file under root.

    pipeline defaults to build_pipeline().

    The doc_id of a document is its position in the sorted path list.
    """
    pipeline = pipeline or build_pipeline()
    documents: list[Document] = []
    index = InvertedIndex()
    for doc in iter_documents(root):
        documents.append(doc)
        index.add(doc, pipeline.analyze(doc.body))
```

`search_index` 里同样有一个 `pipeline` 参数，默认也是 `build_pipeline()`，而且文档字符串要求它必须是建索引的那一个：索引里存的是折叠后的词，用不同的流水线切查询词，就查不到。拿默认流水线建的索引，分别用默认流水线和只有 `latin` 的流水线（不折叠）查 `Kalman`：

```text
$ python3 -c '
from sift.__main__ import CORPUS, load_index, search_index
from sift.analysis import build_pipeline

docs, index = load_index(CORPUS)
for names in (["mixed", "nfkc"], ["latin"]):
    pipeline = build_pipeline(names)
    hits = search_index(index, ["Kalman"], len(docs), pipeline=pipeline)
    print(names, len(hits))
' 2>/dev/null
['mixed', 'nfkc'] 8
['latin'] 0
```

不折叠的 `Kalman` 不在索引里，没有报错，只是一条命中也没有。

默认流水线应该让搜索结果和上一篇完全一样，我对七个查询（英文、中文、`c++`、多词）各比一次输出，再比 `stats`。两版输出里只有最后一行带耗时，先用 `sed` 把耗时那一截删掉，再用 `cmp` 逐字节比：

```text
$ for q in kalman "kalman filter" "rust ownership" 所有权 "c++ cmake" \
         "linux device tree" 卡尔曼滤波; do
  for c in ch06 ch07; do
    at $c -m sift search $q 2>/dev/null | sed 's/index built in .*//' \
      > /tmp/p07/$c.txt
  done
  printf '%-18s %2d lines  ' "$q" $(wc -l < /tmp/p07/ch07.txt)
  cmp /tmp/p07/ch06.txt /tmp/p07/ch07.txt && echo identical
done
diff <(at ch06 -m sift stats 2>/dev/null | sed 's/index built in .*//') \
     <(at ch07 -m sift stats 2>/dev/null | sed 's/index built in .*//') \
  && echo stats identical
kalman              9 lines  identical
kalman filter       6 lines  identical
rust ownership      5 lines  identical
所有权          11 lines  identical
c++ cmake           9 lines  identical
linux device tree   5 lines  identical
卡尔曼滤波    11 lines  identical
stats identical
```

七个查询和 `stats` 都逐字节相同。`mixed` 已经自己折叠过文本，后面的 `nfkc` 对它是第二遍，对这个语料不改变任何词元（结果相同就是证据，词表大小也一样），但它也不是免费的，后面会量。

默认流水线不含停用词。`StopwordFilter` 存在，`build_pipeline(["mixed", "nfkc", "stopwords"])` 能造出来，但它用的是 `filters.py` 里一个只有 25 个词的占位 `frozenset` (`STOPWORDS`)，第 11 篇才换成 `stopwords.txt`。`/tmp/p07/scratch/stopwords_effect.py` 量它对整个语料的影响，顺便看位置有没有被重新编号：

```python
"""What the placeholder stopword filter removes from the corpus."""

from pathlib import Path

from sift.analysis import STOPWORDS, build_pipeline
from sift.corpus import iter_documents


def main() -> None:
    """Count tokens and vocabulary with and without the filter."""
    docs = list(iter_documents(Path("corpus/posts")))
    for names in (["mixed", "nfkc"], ["mixed", "nfkc", "stopwords"]):
        pipeline = build_pipeline(names)
        terms = [t for doc in docs for t in pipeline.terms(doc.body)]
        print(f"{'+'.join(names):24} {len(terms):>8} tokens", end=" ")
        print(f"{len(set(terms)):>6} terms")
    print(f"{len(STOPWORDS)} stopwords, type {type(STOPWORDS).__name__}")
    pipeline = build_pipeline(["mixed", "nfkc", "stopwords"])
    for token in pipeline.analyze("The kalman filter is in the loop"):
        print(" ", token)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p07/scratch/stopwords_effect.py
mixed+nfkc                 812338 tokens  81192 terms
mixed+nfkc+stopwords       792920 tokens  81167 terms
25 stopwords, type frozenset
  Token(text='kalman', position=1, start=4, end=10)
  Token(text='filter', position=2, start=11, end=17)
  Token(text='loop', position=6, start=28, end=32)
```

词元数从 812,338 降到 792,920，少了 19,418 个 (2.4%)，词表从 81,192 降到 81,167：正好少 25 个，占位表里的每个词在语料里都出现过。位置没有重新编号：`The kalman filter is in the loop` 里 `kalman`、`filter`、`loop` 的 `position` 是 1、2、6，中间的空缺留着，后面做短语匹配时知道这里隔了词。这个表是英文的，占位的意思就是我没有认真对待它。

上一篇的接口没有断：`tokenize` 和 `iter_tokens` 还能从两个地方导入，`sift.analysis` 和 `sift.analysis.tokenize`：

```text
$ python3 -c '
from sift.analysis import tokenize
from sift.analysis.tokenize import iter_tokens

print(tokenize("Rust 所有权"))
print(next(iter_tokens("Rust 所有权")))
'
['rust', '所有', '有权']
Token(text='rust', position=0, start=0, end=4)
```

## 索引又变慢了

最后一笔账。先量整体：`ch06` 和 `ch07` 各跑 7 个新进程，轮流跑，计时的是 `/tmp/p07/scratch/build_probe.py` 里的一次 `load_index`：

```python
"""Time one load_index call, in a fresh process."""

import time

from sift.__main__ import CORPUS, load_index


def main() -> None:
    """Print the milliseconds one load_index call takes."""
    start = time.perf_counter()
    result = load_index(CORPUS)
    print(f"{(time.perf_counter() - start) * 1000:.0f}")
    assert result is not None


if __name__ == "__main__":
    main()
```

```text
$ for i in 1 2 3 4 5 6 7; do
  for c in ch06 ch07; do
    echo "$c $(at $c /tmp/p07/scratch/build_probe.py 2>/dev/null)"
  done
done | sort -k1,1 -k2,2n \
  | awk '{a[$1]=a[$1]" "$2} END{for(k in a)print k":"a[k]}' | sort
ch06: 1662 1667 1677 1685 1686 1703 1709
ch07: 1850 1866 1867 1868 1868 1876 1881
```

最小值 1662 ms 对 1850 ms，慢了 1.11 倍 (188 ms)；中位数 1685 对 1868 ms，也是 1.11 倍。我先前跑过一遍同样的 7 轮，是 1694 对 1901 ms，同样 1.12 倍。这一次会话里 `ch06` 的最小值是 1662 ms，上一篇报的是 1747 ms，不同会话之间差了 5%，所以我只拿同一次会话里的数互相比。

多出来的 188 ms 花在哪？每个流水线配置各量两样：只跑分析（把所有文档的词元数一遍），和分析加建索引 (`add`)。`/tmp/p07/scratch/pipeline_cost.py`：

```python
"""Time analysis and indexing of one pipeline, in a fresh process."""

import sys
import time
from pathlib import Path

from sift.analysis import build_pipeline, iter_tokens
from sift.corpus import iter_documents
from sift.index import InvertedIndex


def main() -> None:
    """Print tokens, analysis-only ms and analysis-plus-index ms.

    The argument "raw" means iter_tokens itself, the ch06 path; any
    other arguments are the names given to build_pipeline.
    """
    names = sys.argv[1:]
    docs = list(iter_documents(Path("corpus/posts")))
    analyze = (
        iter_tokens if names == ["raw"] else build_pipeline(names).analyze
    )
    start = time.perf_counter()
    count = sum(1 for doc in docs for _ in analyze(doc.body))
    middle = time.perf_counter()
    index = InvertedIndex()
    for doc in docs:
        index.add(doc, analyze(doc.body))
    end = time.perf_counter()
    print(
        count, f"{(middle - start) * 1000:.0f}", f"{(end - middle) * 1000:.0f}"
    )


if __name__ == "__main__":
    main()
```

`raw` 是上一篇的路径：直接调 `iter_tokens`，不经过 `Pipeline`。每个配置在新进程里各跑 7 轮，轮流进行，结果追加进 `/tmp/p07/cost.txt`（这个循环跑了大约 100 秒，没有输出，之后脚本只被 `ruff format` 重排过格式）：

```bash
CONFIGS=("raw" "mixed" "mixed nfkc" "mixed nfkc stopwords" "latin nfkc" "cjk-bigram nfkc")
rm -f /tmp/p07/cost.txt
for i in 1 2 3 4 5 6 7; do
  for cfg in "${CONFIGS[@]}"; do
    echo "$cfg | $(at ch07 /tmp/p07/scratch/pipeline_cost.py $cfg)" >> /tmp/p07/cost.txt
  done
done
```

再用 `/tmp/p07/scratch/summarize.py` 求最小值和中位数：

```python
"""Summarize lines of "config | tokens analyze_ms index_ms" on stdin."""

import sys
from statistics import median


def main() -> None:
    """Print min and median per config, in order of first appearance."""
    rows: dict[str, list[tuple[int, int, int]]] = {}
    for line in sys.stdin:
        config, numbers = line.split(" | ")
        tokens, analyze, index = map(int, numbers.split())
        rows.setdefault(config, []).append((tokens, analyze, index))
    print(f"{'config':22} {'tokens':>7} {'analyze':>12} {'analyze+add':>13}")
    for config, runs in rows.items():
        analyze = sorted(run[1] for run in runs)
        index = sorted(run[2] for run in runs)
        print(
            f"{config:22} {runs[0][0]:>7} "
            f"{analyze[0]:>5} {median(analyze):>6.0f} "
            f"{index[0]:>6} {median(index):>6.0f}"
        )


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p07/scratch/summarize.py < /tmp/p07/cost.txt
config                  tokens      analyze   analyze+add
raw                     812338   672    698   1471   1577
mixed                   812338   677    689   1436   1515
mixed nfkc              812338   849    864   1617   1699
mixed nfkc stopwords    792920   906    939   1674   1799
latin nfkc              360303   410    416    552    565
cjk-bigram nfkc         452028   387    400    922    970
```

（`analyze` 和 `analyze+add` 各两列，是最小值和中位数，单位 ms；`analyze+add` 里包含了一遍分析，不是两遍。）

- `raw` 对 `mixed`：672 ms 对 677 ms，多了 5 ms，不到 1%。`MixedTokenizer.analyze` 只是 `return iter_tokens(text)`，把生成器原样递出去，没有多包一层。继承和一层方法调用的价格，在每篇文档一次的粒度上，可以忽略。
- `mixed` 对 `mixed nfkc`：677 ms 对 849 ms，多了 172 ms (+25%)，相当于每个词元 0.21 微秒。`NfkcCasefold` 是新的一层生成器，每个词元要再恢复一次生成器帧，再调一次 `fold`（`unicodedata.normalize` 加 `casefold`），再比较一遍。是哪一部分占大头我没有拆开量。这个价格买的是对 `mixed` 没有任何效果的一次折叠（上面的 `cmp` 已经证明结果不变）。
- 加上 `stopwords`：分析 906 ms，又多 57 ms，但索引里少了 19,418 个词元，`analyze+add` 只多了 57 ms，说明少存这些词元省下的时间，没有大到能抵消多一层过滤。
- `latin nfkc` 和 `cjk-bigram nfkc` 的词元数少得多，所以总时间也少得多，但按词元算，`latin nfkc` 是 1.14 微秒，比同样带 `nfkc` 的 `mixed nfkc`（849 ms 除以 812,338，1.05 微秒）贵约 9%，`cjk-bigram nfkc` 是 0.86 微秒。差别不大，我没有去找原因；单位词元的价格大概还和每个词元对应多少原文字符有关，这只是猜测。

整体慢的 188 ms 里，分析这一步多出的 172 ms 是大头，两个数同一量级；剩下的十几毫秒我没有再拆，大概是 `InvertedIndex.add` 里新增的文档长度记账和 `Pipeline` 的方法调用。这是第三次索引变慢：上一篇 1747 ms 的账，这一篇又加了 188 ms，换来的是可以换掉的分词器。结果一样，功能更多，每次启动多等 0.19 秒。第 12 篇要做索引的持久化，我猜到那时这笔账就不必每次启动都付了。

## 跑一遍

整章一个 `make` 目标，再加 `make lint`：

```text
$ make ch07
python3 scripts/chapter.py ch07
ok   lab/ch07/abc_demo.py
ok   lab/ch07/abc_instantiate_fail.py
ok   lab/ch07/analyzers_compare.py
ok   lab/ch07/collections_abc.py
ok   lab/ch07/composition.py
ok   lab/ch07/duck_typing.py
ok   lab/ch07/inheritance.py
ok   lab/ch07/init_subclass_registry.py
ok   lab/ch07/mixins.py
ok   lab/ch07/mro_conflict_fail.py
ok   lab/ch07/mro_diamond.py
ok   lab/ch07/protocols.py
ok   lab/ch07/singledispatch_method.py
```

```text
$ make lint
ruff format --check --line-length 79 .
107 files already formatted
ruff check .
All checks passed!
```

`mro_conflict_fail.py` 和 `abc_instantiate_fail.py` 也显示 `ok`，因为运行器知道 `_fail.py` 结尾的文件应该非零退出，我另外确认了它们的退出码：

```text
$ for f in mro_conflict_fail abc_instantiate_fail; do
  python3 lab/ch07/$f.py >/dev/null 2>&1
  echo $f $?
done
mro_conflict_fail 1
abc_instantiate_fail 1
```

## 本篇文件

这一章改过的 `src/sift` 文件和新增的 `lab/ch07` 文件：

```text
$ git diff --stat ch06 ch07 -- src lab | cat
 lab/ch07/abc_demo.py               | 74 ++++++++++++++++++++++++++++++++
 lab/ch07/abc_instantiate_fail.py   | 35 ++++++++++++++++
 lab/ch07/analyzers_compare.py      | 47 +++++++++++++++++++++
 lab/ch07/collections_abc.py        | 69 ++++++++++++++++++++++++++++++
 lab/ch07/composition.py            | 79 ++++++++++++++++++++++++++++++++++
 lab/ch07/duck_typing.py            | 58 +++++++++++++++++++++++++
 lab/ch07/inheritance.py            | 67 +++++++++++++++++++++++++++++
 lab/ch07/init_subclass_registry.py | 52 +++++++++++++++++++++++
 lab/ch07/mixins.py                 | 68 ++++++++++++++++++++++++++++++
 lab/ch07/mro_conflict_fail.py      | 22 ++++++++++
 lab/ch07/mro_diamond.py            | 58 +++++++++++++++++++++++++
 lab/ch07/protocols.py              | 79 ++++++++++++++++++++++++++++++++++
 lab/ch07/singledispatch_method.py  | 49 ++++++++++++++++++++++
 src/sift/__main__.py               | 29 +++++++++----
 src/sift/analysis/__init__.py      | 33 +++++++++++++++
 src/sift/analysis/base.py          | 40 ++++++++++++++++++
 src/sift/analysis/filters.py       | 86 ++++++++++++++++++++++++++++++++++++++
 src/sift/analysis/pipeline.py      | 45 ++++++++++++++++++++
 src/sift/analysis/tokenizers.py    | 57 +++++++++++++++++++++++++
 src/sift/index.py                  | 40 ++++++++++++++----
 20 files changed, 1069 insertions(+), 18 deletions(-)
```

[`lab/ch07`](https://github.com/bfmhno3/sift/tree/ch07/lab/ch07) 下的 13 个文件，加上这一章改过或新增的七个 `src/sift` 文件。`src/sift/analysis/tokenize.py` 没有改，所以不在表里。结果列是我在本篇的环境里重新跑出来的。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`src/sift/analysis/__init__.py`](https://github.com/bfmhno3/sift/blob/ch07/src/sift/analysis/__init__.py) | `python3 -c 'from sift.analysis import tokenize; print(tokenize("Rust 所有权"))'` | 退出码 0，输出 `['rust', '所有', '有权']`；34 行 |
| [`src/sift/analysis/base.py`](https://github.com/bfmhno3/sift/blob/ch07/src/sift/analysis/base.py) | `python3 -c 'from sift.analysis.base import Analyzer; print(Analyzer.__abstractmethods__)'` | 退出码 0，输出 `frozenset({'analyze'})`；40 行 |
| [`src/sift/analysis/tokenizers.py`](https://github.com/bfmhno3/sift/blob/ch07/src/sift/analysis/tokenizers.py) | `python3 -c 'from sift.analysis import LatinTokenizer; print([t.text for t in LatinTokenizer().analyze("C++ 与 Rust")])'` | 退出码 0，输出 `['C++', 'Rust']`（没有折叠，大小写保留）；57 行 |
| [`src/sift/analysis/filters.py`](https://github.com/bfmhno3/sift/blob/ch07/src/sift/analysis/filters.py) | `python3 -c 'from sift.analysis import STOPWORDS; print(len(STOPWORDS))'` | 退出码 0，输出 `25`；86 行 |
| [`src/sift/analysis/pipeline.py`](https://github.com/bfmhno3/sift/blob/ch07/src/sift/analysis/pipeline.py) | `python3 -c 'from sift.analysis import build_pipeline; print(build_pipeline())'` | 退出码 0，输出 `Pipeline(MixedTokenizer, NfkcCasefold)`；45 行 |
| [`src/sift/index.py`](https://github.com/bfmhno3/sift/blob/ch07/src/sift/index.py) | `python3 -c 'from sift.__main__ import CORPUS, load_index; idx = load_index(CORPUS)[1]; print(len(idx), idx.n_docs, round(idx.avg_doc_len, 1))' 2>/dev/null` | 退出码 0，输出 `81192 123 6604.4`（词表大小、文档数、平均文档长度）；195 行 |
| [`src/sift/__main__.py`](https://github.com/bfmhno3/sift/blob/ch07/src/sift/__main__.py) | `python3 -m sift search kalman filter` | 退出码 0，stdout 第一行 `  40.154  corpus/posts/kalman-filter-02-multivariate.md`，stderr 一行 `load_index took ... ms`；121 行 |
| [`lab/ch07/inheritance.py`](https://github.com/bfmhno3/sift/blob/ch07/lab/ch07/inheritance.py) | `python3 lab/ch07/inheritance.py` | 退出码 0，第一行 `Tokenizer(whitespace)            ['Red,', 'Green', 'Blue']` |
| [`lab/ch07/mro_diamond.py`](https://github.com/bfmhno3/sift/blob/ch07/lab/ch07/mro_diamond.py) | `python3 lab/ch07/mro_diamond.py` | 退出码 0，第一行 `Bottom.__mro__  ['Bottom', 'Left', 'Right', 'Base', 'object']` |
| [`lab/ch07/mro_conflict_fail.py`](https://github.com/bfmhno3/sift/blob/ch07/lab/ch07/mro_conflict_fail.py) | `python3 lab/ch07/mro_conflict_fail.py` | 退出码 1：先打印 `A.__mro__: ['A', 'object']` 和 `B.__mro__: ['B', 'A', 'object']`，随后 `TypeError: Cannot create a consistent method resolution order (MRO) for bases A, B` |
| [`lab/ch07/mixins.py`](https://github.com/bfmhno3/sift/blob/ch07/lab/ch07/mixins.py) | `python3 lab/ch07/mixins.py` | 退出码 0，第一行 `RichHit(title='Kalman', score=2.5)` |
| [`lab/ch07/abc_demo.py`](https://github.com/bfmhno3/sift/blob/ch07/lab/ch07/abc_demo.py) | `python3 lab/ch07/abc_demo.py` | 退出码 0，第一行 `RawTf: 3.000` |
| [`lab/ch07/abc_instantiate_fail.py`](https://github.com/bfmhno3/sift/blob/ch07/lab/ch07/abc_instantiate_fail.py) | `python3 lab/ch07/abc_instantiate_fail.py` | 退出码 1：先打印 `still abstract: ['name']`，随后 `TypeError: Can't instantiate abstract class Half without an implementation for abstract method 'name'` |
| [`lab/ch07/duck_typing.py`](https://github.com/bfmhno3/sift/blob/ch07/lab/ch07/duck_typing.py) | `python3 lab/ch07/duck_typing.py` | 退出码 0，第一行 `StringIO: 'kalman\nfilter\n'` |
| [`lab/ch07/protocols.py`](https://github.com/bfmhno3/sift/blob/ch07/lab/ch07/protocols.py) | `python3 lab/ch07/protocols.py` | 退出码 0，第一行 `best: 8.0` |
| [`lab/ch07/init_subclass_registry.py`](https://github.com/bfmhno3/sift/blob/ch07/lab/ch07/init_subclass_registry.py) | `python3 lab/ch07/init_subclass_registry.py` | 退出码 0，第一行 `defining:` |
| [`lab/ch07/collections_abc.py`](https://github.com/bfmhno3/sift/blob/ch07/lab/ch07/collections_abc.py) | `python3 lab/ch07/collections_abc.py` | 退出码 0，第一行 `own methods : ['__getitem__', '__iter__', '__len__']` |
| [`lab/ch07/composition.py`](https://github.com/bfmhno3/sift/blob/ch07/lab/ch07/composition.py) | `python3 lab/ch07/composition.py` | 退出码 0，第一行 `hierarchy: ['kalman', 'filter', 'c++', 'port']` |
| [`lab/ch07/analyzers_compare.py`](https://github.com/bfmhno3/sift/blob/ch07/lab/ch07/analyzers_compare.py) | `python3 lab/ch07/analyzers_compare.py` | 退出码 0，第一行 `== notes-of-effective-cmake.md (21861 chars)` |
| [`lab/ch07/singledispatch_method.py`](https://github.com/bfmhno3/sift/blob/ch07/lab/ch07/singledispatch_method.py) | `python3 lab/ch07/singledispatch_method.py` | 退出码 0，第一行 `['kalman', 'filter']` |

## 练习

**1.** 把 `REGISTRY` 和 `FILTERS` 合成一套机制：写一个泛型的注册基类（比如 PEP 695 的 `class Registered[T]`，带 `__init_subclass__`），让 `Analyzer` 和 `TokenFilterBase` 都用它，各自保留自己的字典。改完后 `list(REGISTRY)` 和 `list(FILTERS)` 应该和上面一样。想一想：过滤器的 `__call__` 能不能也变成抽象方法，让漏写的子类在实例化时就失败，而不是调用时？

**2.** 给 `InvertedIndex` 写一个两行的 `__contains__`，`return term in self._postings`，再用本篇的办法（`contains_cost.py`，两版轮流跑 5 轮）量命中和未命中的 ns 数。`keys`、`items`、`get` 和 `__eq__` 还能继续用吗？类的文档字符串里“三个方法”那句该怎么改？

**3.** 默认流水线里的 `nfkc` 对 `mixed` 是多余的，上面量出它花了 172 ms。设计一个办法，让 `build_pipeline` 在分词器已经折叠过文本时跳过它（比如在 `Analyzer` 上加一个类属性），再用 `pipeline_cost.py` 和 `summarize.py` 量一次。你的办法对 `latin` 加 `nfkc` 有什么影响？偏移量的含义变了没有？

**4.** 预测下面六个类里哪一行会抛 `TypeError`，`D` 和 `E` 的 `__mro__` 各是什么，再运行验证。报错信息里列出的是哪些类？它们是 `F` 的基类吗？

```python
class A: ...
class B(A): ...
class C(A): ...
class D(B, C): ...
class E(C, B): ...
class F(D, E): ...
```

## 下一篇

下一篇是《[BM25 与查询语言：match/case 和递归下降](/posts/python-by-sift-08-bm25-query-language/)》。`InvertedIndex` 现在有 `n_docs`、`doc_len` 和 `avg_doc_len`，BM25 公式要的语料统计就是这三个数；它又是个 `Mapping`，`match` 的映射模式已经认得它。我想看看递归下降的解析器配上 `match`/`case` 写出来是什么样子，还有查询里的 `所有权` 这种词，会被分析器切成 `所有` 和 `有权`，它们怎么变成一个短语。
