---
title: "类型系统：从注解到 mypy --strict"
commentId: "post:python-by-sift-14-type-system"
published: "2026-10-24 19:00:00 +08:00"
description: "用 Sift 重学 Python 第 14 篇：我用 Python 3.14.7、mypy 2.1.0 和 pyright 1.1.412 给整个 src/sift 补全类型注解，第一次 mypy --strict 报 9 处错误、pyright strict 报 33 处，逐条修完以后 make typecheck 在 34 个源文件上都是 0 错误；中途拆开泛型、变型、Protocol、ParamSpec、TypeIs 和 Python 3.14 的延迟注解，并量了新加的 LRUCache：命中率 95%，12 条查询的总耗时却没有可测的变化。"
category: Tutorial
tags:
  - Python
  - Sift
  - 类型注解
  - mypy
  - pyright
  - 泛型
series: "用 Sift 重学 Python"
seriesOrder: 14
draft: false
comment: true
slug: python-by-sift-14-type-system
---

我把第 13 篇的 Sift 原封不动交给 `mypy --strict`，再交给 pyright 的 strict 模式，一行代码没改。那时候它有 489 个测试，全绿，每次提交都跑；mypy 说有 9 处错误，分布在 4 个文件里，pyright 说有 33 处，分布在 9 个文件里，两份名单只在 `cli.py` 的两处 `Searcher` 和 `segment.py` 的一处上重合。这一篇我把这 42 条抱怨一条一条读完，看哪些是真问题，哪些只是我没把话说清楚。

```text
$ cd /tmp/sift-scratch/first
$ mypy | grep -v ': note:'
src/sift/document.py:89: error: List item 0 has incompatible type "str | int"; expected "str"  [list-item]
src/sift/index.py:79: error: No overload variant of "bisect_left" matches argument types "list[Posting]", "object", "attrgetter[Any]"  [call-overload]
src/sift/index.py:80: error: Returning Any from function declared to return "bool"  [no-any-return]
src/sift/storage/segment.py:169: error: List item 2 has incompatible type "bytearray"; expected "bytes"  [list-item]
src/sift/storage/segment.py:169: error: List item 3 has incompatible type "bytearray"; expected "bytes"  [list-item]
src/sift/cli.py:208: error: Argument 1 to "Searcher" has incompatible type "SegmentIndex"; expected "InvertedIndex"  [arg-type]
src/sift/cli.py:315: error: Argument 1 to "Searcher" has incompatible type "SegmentIndex"; expected "InvertedIndex"  [arg-type]
src/sift/cli.py:440: error: Assignment to variable "error" outside except: block  [misc]
src/sift/cli.py:441: error: Trying to read deleted variable "error"  [misc]
Found 9 errors in 4 files (checked 33 source files)
$ pyright | tail -1
33 errors, 0 warnings, 0 informations
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch14`：新增 `src/sift/cache.py` (`LRUCache[K, V]`)、`src/sift/py.typed`、`tests/test_cache.py`，以及 `lab/ch14` 下 12 个脚本、`extra.sh` 和一个带 `.pyi` 的 `legacy/` 目录；改动了 `src/sift` 下的 10 个源文件、`pyproject.toml`（两段检查器配置）、`Makefile`（`typecheck` 目标，并入 `ci`）、`README.md` 和两个已有的测试文件。`make ch14` 通过，`make typecheck` 在 34 个源文件上给出 0 个错误。后面的篇章还会继续改 `config.py`、`cli.py`、`search.py`、`cache.py` 和 `log.py`，`pyproject.toml` 和 `Makefile` 也会再添条目。
> 涉及的 Python 特性：渐进类型 (PEP 484)、注解语法 (PEP 526)、`typing` 常用件、泛型的旧写法和 PEP 695、变型、`Protocol` (PEP 544)、`TypedDict`、`Literal`、`Final`、`Callable`、`ParamSpec`/`Concatenate`、`TypeVarTuple`、`@overload`、窄化（`isinstance`、`TypeIs`、`TypeGuard`、`assert_never`）、`NewType`、`Annotated`、`Self`、`Never`、`TYPE_CHECKING`、`.pyi` 存根、mypy 与 pyright 的分歧、Python 3.14 的延迟注解和 `annotationlib`。
> 前置：[第 13 篇](/posts/python-by-sift-13-sqlite-sqlalchemy/)，这一篇检查的就是它留下的 `src/sift`。

## 环境

和前几篇同一台机器（AMD Ryzen 7 PRO 6850U，16 个线程），仓库在标签 `ch14`，命令都在 `nix develop` 里、仓库根目录下跑：

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ mypy --version
mypy 2.1.0 (compiled: yes)
$ pyright --version
pyright 1.1.412
$ git describe --tags
ch14
```

两件事先交代。第一，所有 `mypy` 和 `pyright` 命令都从仓库根目录启动，所以 `pyproject.toml` 里的严格模式对它们都生效，命令后面不再加 `--strict`。第二，这台机器的 CPU 有快慢两个状态（前几篇测到过差约 2.5 倍），所以每个计时脚本都让对手轮流跑，并且前后各跑一遍 `cpu_state.py`（第 12 篇贴过的固定忙循环，快状态下 5 个数都在 110 到 120 ms 之间）；这一篇的每一组计时，前后两次都落在快状态里，我没有在慢状态下重跑，所以慢状态下绝对值会偏大，比例才可信。

输出里的家目录缩写成 `~`，输出行里的 `/tmp/sift-scratch/` 和仓库路径前缀省略了。临时脚本放在 `/tmp/sift-scratch/`，不进仓库，整份贴出，都满足 79 列并通过仓库的 `ruff` 配置；仓库里的实验文件只贴被讲到的片段，省略处标 `# ...`。故意写错的行标 `# BAD`，故意让运行时抛异常的行标 `# error: 异常类型: 真实的消息`。

## 渐进类型：贴错标签的罐子

先看一个能运行、但有 6 处类型错误的文件。`lab/ch14/bad_types.py` 把六种常见的错误各写一遍，Python 照常运行它。`main()` 是这样的：

```python
# ...
def main() -> None:
    """Run all six mistakes; Python does not stop any of them."""
    # error: arg-type: Argument 1 to "double" has incompatible type
    # "str"; expected "int"
    print(double("ab"))
    # error: union-attr: Item "None" of "str | None" has no attribute
    # "upper"
    print(find(["tea", "tar"], "ta").upper())
    print(count(["a", "b"]))
    post: Post = {"title": "tea", "views": 3}
    # error: typeddict-unknown-key: TypedDict "Post" has no key "view"
    post["view"] = 4
    print(post)
    ints: list[int] = [1, 2, 3]
    # error: arg-type: Argument 1 to "mean" has incompatible type
    # "list[int]"; expected "list[float]"
    print(mean(ints))
    try:
        # error: arg-type: Argument 1 to "show" has incompatible type
        # "NoTitle"; expected "Titled"
        print(show(NoTitle()))
    except AttributeError as exc:
        print("AttributeError:", exc)
# ...
```

辅助函数是 `double(n: int) -> int`、`find(words: list[str], prefix: str) -> str | None`、`count(words: list[str]) -> int`（函数体里 `return str(len(words))`，它自己就是一个错误）、`mean(values: list[float]) -> float` 和 `show(item: Titled) -> str`，`Titled` 是只有一个 `title()` 方法的协议。先让 Python 跑，再让两个检查器看：

```text
$ python3 lab/ch14/bad_types.py
abab
TAR
2
{'title': 'tea', 'views': 3, 'view': 4}
2.0
AttributeError: 'NoTitle' object has no attribute 'title'
$ mypy lab/ch14/bad_types.py
lab/ch14/bad_types.py:44: error: Incompatible return value type (got "str", expected "int")  [return-value]
lab/ch14/bad_types.py:61: error: Argument 1 to "double" has incompatible type "str"; expected "int"  [arg-type]
lab/ch14/bad_types.py:64: error: Item "None" of "str | None" has no attribute "upper"  [union-attr]
lab/ch14/bad_types.py:68: error: TypedDict "Post" has no key "view"  [typeddict-unknown-key]
lab/ch14/bad_types.py:68: note: Did you mean "views"?
lab/ch14/bad_types.py:73: error: Argument 1 to "mean" has incompatible type "list[int]"; expected "list[float]"  [arg-type]
lab/ch14/bad_types.py:73: note: "list" is invariant -- see https://mypy.readthedocs.io/en/stable/common_issues.html#variance
lab/ch14/bad_types.py:73: note: Consider using "Sequence" instead, which is covariant
lab/ch14/bad_types.py:77: error: Argument 1 to "show" has incompatible type "NoTitle"; expected "Titled"  [arg-type]
Found 6 errors in 1 file (checked 1 source file)
$ pyright lab/ch14/bad_types.py
lab/ch14/bad_types.py
  lab/ch14/bad_types.py:44:12 - error: Type "str" is not assignable to return type "int"
    "str" is not assignable to "int" (reportReturnType)
  lab/ch14/bad_types.py:61:18 - error: Argument of type "Literal['ab']" cannot be assigned to parameter "n" of type "int" in function "double"
    "Literal['ab']" is not assignable to "int" (reportArgumentType)
  lab/ch14/bad_types.py:64:38 - error: "upper" is not a known attribute of "None" (reportOptionalMemberAccess)
  lab/ch14/bad_types.py:68:5 - error: Could not assign item in TypedDict
    "view" is not a defined key in "Post" (reportGeneralTypeIssues)
  lab/ch14/bad_types.py:73:16 - error: Argument of type "list[int]" cannot be assigned to parameter "values" of type "list[float]" in function "mean"
    "list[int]" is not assignable to "list[float]"
      Type parameter "_T@list" is invariant, but "int" is not the same as "float"
      Consider switching from "list" to "Sequence" which is covariant (reportArgumentType)
  lab/ch14/bad_types.py:77:20 - error: Argument of type "NoTitle" cannot be assigned to parameter "item" of type "Titled" in function "show"
    "NoTitle" is incompatible with protocol "Titled"
      "title" is not present (reportArgumentType)
6 errors, 0 warnings, 0 informations
```

六处错误里五处在运行时毫无反应：`double("ab")` 打印 `abab`，`.upper()` 碰巧在 `TAR` 上能用，`count` 把 `"2"` 当成 `2` 打印，字典多了个键 `'view'`，`mean` 恰好能处理整数；只有最后一处因为真的缺方法，变成了 `AttributeError`。mypy 和 pyright 各报 6 个错误，位置一一对应，措辞不同。这就是渐进类型 (gradual typing) 的全部含义：注解是写给检查器和下一个读代码的人的标签，解释器在运行时视而不见。

一个厨房里的类比，只用这一次：罐子上的标签写着“盐”，里面装的是糖，炒菜的人照样能炒，只是尝一口才知道。类型检查器是一个只读标签、从不开罐的帮厨：他能拦住你把“糖”罐拿去腌肉，拦不住贴错标签的人。检查器证明的是“标签之间彼此一致”，不是“罐子里确实是那个东西”，下面都要放在这个前提里读。

渐进的另一半是“没贴标签的罐子”：[PEP 484](https://peps.python.org/pep-0484/) 规定没有注解的函数，参数和返回值都是 `Any`，检查器对 `Any` 放行一切。严格模式 (`--strict`) 的大半内容，就是把这个默认放行逐项关掉：不许有没注解的函数，不许调用它们，不许从函数里返回 `Any`。

## 注解语法：从 `x: int` 到 `__annotate__`

注解有三个位置：变量、参数、返回值。运行时它们各自留下什么，我用一个临时脚本看：

```python
"""Print what each annotation form leaves behind at run time."""

import sys
from annotationlib import get_annotations

counter: int
names: list[str] = []


def f(a: int, /, b: str = "", *args: int, c: bool, **kwargs: float) -> None:
    """Take every kind of parameter."""


class Point:
    """Annotate attributes of a class."""

    x: float
    y: float = 0.0


def main() -> None:
    """Show the annotation dicts and the name that was never bound."""
    print(get_annotations(sys.modules[__name__]))
    print(f.__annotations__)
    print(Point.__annotations__, vars(Point).get("x", "no attribute x"))
    try:
        # error: NameError: name 'counter' is not defined
        print(counter)  # BAD: annotated, never assigned
    except NameError as exc:
        print(f"NameError: {exc}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/annotation_syntax.py
{'counter': <class 'int'>, 'names': list[str]}
{'b': <class 'str'>, 'a': <class 'int'>, 'args': <class 'int'>, 'c': <class 'bool'>, 'kwargs': <class 'float'>, 'return': None}
{'x': <class 'float'>, 'y': <class 'float'>} no attribute x
NameError: name 'counter' is not defined
```

第一，模块级的 `counter: int` 只登记了注解，没有创建变量：读 `counter` 得到 `NameError`，这是 [PEP 526](https://peps.python.org/pep-0526/) 的设计，可以先声明、后赋值。第二，类里的 `x: float` 同样只进 `__annotations__`，`vars(Point)` 里没有 `x`，有默认值的 `y` 才是类属性。第三，`*args: int` 登记在 `args` 下，`-> None` 登记在 `return` 下，而且是 `None` 本身，不是 `NoneType`。

还有一处让我多看了一眼：`f` 的参数顺序是 `a, /, b, ...`，字典的键序却是 `b` 排在 `a` 前面。我没有深究原因，猜是编译器先访问位置或关键字参数、再访问仅限位置参数，所以别靠键序还原参数顺序，用 `inspect.signature`。

更要紧的是 3.14 的新机制：注解不再在 `def` 执行时求值，而是编译成一个 `__annotate__` 小函数，第一次读 `__annotations__` 时才调用，参数 `format` 选择怎么求值。最后一节细讲。

### reveal_type：看检查器怎么想

最直接的办法是问它。`typing.reveal_type` 在运行时把类型打印到标准错误并原样返回对象，在检查器里则打印推断出的静态类型。`lab/ch14/reveal_types.py` 的 `main()` 问了 16 个表达式：

```python
# ...
def main() -> None:
    """Reveal the inferred types of literals, calls and sift names."""
    count = 3
    ratio = count / 2
    names = ["a", "b"]
    mixed = [1, "x"]
    table = {"a": 1, "b": 2.5}
    squares = {n: n * n for n in range(3)}
    pair = (1, "x")
    reveal_type(count)
    reveal_type(ratio)
    reveal_type(names)
    reveal_type(mixed)
    reveal_type(table)
    reveal_type(squares)
    reveal_type(pair)
    reveal_type(first_word("sift search"))
# ...
```

```text
$ mypy lab/ch14/reveal_types.py
lab/ch14/reveal_types.py:33: note: Revealed type is "int"
lab/ch14/reveal_types.py:34: note: Revealed type is "float"
lab/ch14/reveal_types.py:35: note: Revealed type is "list[str]"
lab/ch14/reveal_types.py:36: note: Revealed type is "list[object]"
lab/ch14/reveal_types.py:37: note: Revealed type is "dict[str, float]"
lab/ch14/reveal_types.py:38: note: Revealed type is "dict[int, int]"
lab/ch14/reveal_types.py:39: note: Revealed type is "tuple[int, str]"
lab/ch14/reveal_types.py:40: note: Revealed type is "str | None"
```

```text
$ pyright lab/ch14/reveal_types.py
lab/ch14/reveal_types.py
  lab/ch14/reveal_types.py:33:17 - information: Type of "count" is "Literal[3]"
  lab/ch14/reveal_types.py:34:17 - information: Type of "ratio" is "float"
  lab/ch14/reveal_types.py:35:17 - information: Type of "names" is "list[str]"
  lab/ch14/reveal_types.py:36:17 - information: Type of "mixed" is "list[int | str]"
  lab/ch14/reveal_types.py:37:17 - information: Type of "table" is "dict[str, int | float]"
  lab/ch14/reveal_types.py:38:17 - information: Type of "squares" is "dict[int, int]"
  lab/ch14/reveal_types.py:39:17 - information: Type of "pair" is "tuple[Literal[1], Literal['x']]"
```

mypy 的行号和 pyright 一致，值却有 4 处不同（pyright 的格式是 `Type of "表达式" is "类型"`，我只贴了前 8 行）：

| 表达式 | mypy 2.1.0 | pyright 1.1.412 |
| --- | --- | --- |
| `count = 3` | `int` | `Literal[3]` |
| `mixed = [1, "x"]` | `list[object]` | `list[int \| str]` |
| `table = {"a": 1, "b": 2.5}` | `dict[str, float]` | `dict[str, int \| float]` |
| `pair = (1, "x")` | `tuple[int, str]` | `tuple[Literal[1], Literal['x']]` |

mypy 把不同类型的字面量合并成最近的公共父类（`1` 和 `"x"` 之间是 `object`，`1` 和 `2.5` 之间因为数值塔的规则是 `float`），pyright 保留并集。两个都是合法的推断，差别在你往 `mixed` 里 `append` 一个 `None` 的时候：mypy 说 `object` 里什么都能放，pyright 说 `int | str` 里没有 `None`。

## `typing` 里最常用的几样

先说 `Any` 和 `object`：它们看起来都是“什么都行”，对检查器的意义正好相反。`Any` 是“别检查我”，`object` 是“我什么都不假设”。

```python
"""Compare Any and object: one disables the checker, one does not."""

from typing import Any


def loose(value: Any) -> int:
    """Accept anything and trust it."""
    return value.size + 1


def strict(value: object) -> int:
    """Accept anything but assume nothing."""
    return value.size + 1  # BAD: object has no attribute size


def main() -> None:
    """Call both with a value that has no size."""
    for func in (loose, strict):
        try:
            print(func("text"))
        except AttributeError as exc:
            print(f"AttributeError: {exc}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/any_object.py
AttributeError: 'str' object has no attribute 'size'
AttributeError: 'str' object has no attribute 'size'
$ mypy /tmp/sift-scratch/any_object.py
any_object.py:8: error: Returning Any from function declared to return "int"  [no-any-return]
any_object.py:13: error: Returning Any from function declared to return "int"  [no-any-return]
any_object.py:13: error: "object" has no attribute "size"  [attr-defined]
Found 3 errors in 1 file (checked 1 source file)
$ pyright /tmp/sift-scratch/any_object.py
any_object.py
  any_object.py:13:12 - error: Type of "size" is unknown (reportUnknownMemberType)
  any_object.py:13:12 - error: Return type is unknown (reportUnknownVariableType)
  any_object.py:13:18 - error: Cannot access attribute "size" for class "object"
    Attribute "size" is unknown (reportAttributeAccessIssue)
3 errors, 0 warnings, 0 informations
```

运行时两个函数一模一样，都因为字符串没有 `size` 而失败。静态上 `loose` 是 `Any` 的天下（`Any` 是类型系统里的“这事别问我”）：mypy 只抱怨 `Returning Any from function declared to return "int"`（`--strict` 的 `warn_return_any`），pyright 在 `loose` 上一个字都没说；`strict` 里的 `value.size` 两个检查器都拦住了。所以 `object` 是类型系统的顶，所有类型都是它的子类型，但从它身上读不出什么，得先窄化才行。Sift 里含 `Any` 的有 10 行（含导入，主要在 `util.compose` 的签名、`config.py` 的 TOML 字典和 `analysis/base.py` 的 `**kwargs`），`# type: ignore` 一行都没有，`cast` 两行，都在 `config.py`：

```text
$ grep -rn --include='*.py' 'type: ignore' src | wc -l
0
$ grep -rn --include='*.py' '\bAny\b' src | grep -v 'Any other' | wc -l
10
$ grep -rn --include='*.py' 'cast(' src | wc -l
2
```

其余常用的东西，下面各节都会用到：

- `X | None` (PEP 604, 3.10) 取代 `Optional[X]`；`list[int]`、`dict[str, int]` 直接用内建容器 (PEP 585, 3.9)，不再需要 `typing.List`。
- 参数写宽、返回写窄：参数用 `Iterable`、`Sequence`、`Mapping` 这样的 `collections.abc` 抽象类，返回用具体的 `list`、`dict`。
- 类型别名：3.12 起用 `type Json = ...` 语句，建立一个懒求值的 `TypeAliasType`，可以递归；老写法是直接赋值。

## 泛型：TypeVar 的旧写法和 PEP 695

`lab/ch14/generics_695.py` 把同一个栈写了两遍。旧写法需要先声明一个模块级的 `TypeVar`，再让类继承 `Generic[T]`；3.12 的 [PEP 695](https://peps.python.org/pep-0695/) 把类型参数直接写在类名后面的方括号里：

```python
# ...
class OldStack(Generic[T_old]):  # noqa: UP046  (old style on purpose)
    """A stack in the pre-3.12 style: TypeVar plus Generic."""

    def __init__(self) -> None:
        """Create an empty stack."""
        self._items: list[T_old] = []

    def push(self, item: T_old) -> None:
        """Put item on top."""
        self._items.append(item)

    def pop(self) -> T_old:
        """Remove and return the top item."""
        return self._items.pop()


class Stack[T]:
    """The same stack with PEP 695 syntax: no TypeVar, no Generic."""

    def __init__(self) -> None:
        """Create an empty stack."""
        self._items: list[T] = []

    def push(self, item: T) -> None:
        """Put item on top."""
        self._items.append(item)

    def pop(self) -> T:
        """Remove and return the top item."""
        return self._items.pop()

    def __len__(self) -> int:
        """Return the number of items."""
        return len(self._items)
# ...
```

旧写法里 `T_old` 是个模块级的名字，所有用到它的类和函数共享，作用域是模糊的；新写法的 `T` 只在 `class Stack[T]` 内部可见，`def first[T](...)` 里的 `T` 是另一个参数，互不干扰。运行起来一样，还能问出 3.12 新增的运行时痕迹：

```text
$ python3 lab/ch14/generics_695.py
1 sift 0
3 empty
{'t': ['tea', 'tar'], 'b': ['bike']}
SIFT b'SIFT'
4
('x', 1) {1: 0.5} {'scores': [1, 2.5, None], 'ok': True}
tuple[A, B] (T,)
```

```text
$ PYTHONPATH=lab/ch14 python3 -c "from generics_695 import Stack; \
    print(type(Stack[int]()) is type(Stack[str]()), Stack[int])"
True generics_695.Stack[int]
```

`Stack.__type_params__` 是 `(T,)`，一个真正的 `TypeVar` 对象；`Pair.__value__` 给出别名展开后的 `tuple[A, B]`。方括号语法由编译器翻译成隐式的类型参数作用域，不需要 `Generic` 基类。最后一条命令说明 Python 没有单态化：`Stack[int]()` 和 `Stack[str]()` 的类型是同一个 `Stack`，泛型信息只在检查器的世界里存在。Rust 读者会注意到这和 `struct Stack<T>` 相反，那边每个 `T` 编译出一份专门的机器码，我在[另一个系列](/posts/rust-by-pebble-05-ast-generics/)里看过符号表。

### 上界、约束和 TypeVarTuple

方括号里还能写上界和约束（`generics_695.py` 里的 `group_by` 和 `shout`）。`K: Hashable` 是上界 (bound)：`K` 可以是任何 `Hashable` 的子类型，检查器保留具体类型，所以 `group_by` 的返回类型随 `key` 而变。`S: (str, bytes)` 是约束 (constraint)：`S` 只能恰好是 `str` 或 `bytes`，不能是它们的联合。`[*Ts]` 是 `TypeVarTuple` ([PEP 646](https://peps.python.org/pep-0646/))，代表“任意个类型”，用来描述元组的形状。上界被违反的样子，我写了一个故意出错的脚本（`group_by` 的定义和实验文件里一样，`Slot` 留给变型一节）：

```python
"""Break the rules of generics, bounds and variance."""

from collections.abc import Callable, Hashable, Iterable


class Animal:
    """The base class of a tiny hierarchy."""


class Dog(Animal):
    """A subtype of Animal."""


class Stack[T]:
    """A stack of T."""

    def __init__(self) -> None:
        """Create an empty stack."""
        self.items: list[T] = []

    def push(self, item: T) -> None:
        """Put item on top."""
        self.items.append(item)


class Slot[T]:
    """Read and write: invariant in T."""

    def __init__(self, item: T) -> None:
        """Keep item."""
        self.item = item


def group_by[K: Hashable, V](
    items: Iterable[V], key: Callable[[V], K]
) -> dict[K, list[V]]:
    """Group items by key(item)."""
    groups: dict[K, list[V]] = {}
    for item in items:
        groups.setdefault(key(item), []).append(item)
    return groups


def main() -> None:
    """Run three mistakes; the first and the last run to the end."""
    stack = Stack[int]()
    stack.push("one")  # BAD: str is not int
    print(stack.items)
    try:
        print(group_by(["ab"], key=lambda w: [w]))  # BAD: unhashable
    except TypeError as exc:
        print(f"TypeError: {exc}")
    dog_slot = Slot(Dog())
    animal_slot: Slot[Animal] = dog_slot  # BAD: Slot is invariant
    animal_slot.item = Animal()
    print(type(dog_slot.item).__name__)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/generics_bad.py
['one']
TypeError: cannot use 'list' as a dict key (unhashable type: 'list')
Animal
$ mypy /tmp/sift-scratch/generics_bad.py
generics_bad.py:47: error: Argument 1 to "push" of "Stack" has incompatible type "str"; expected "int"  [arg-type]
generics_bad.py:50: error: Value of type variable "K" of "group_by" cannot be "list[str]"  [type-var]
generics_bad.py:54: error: Incompatible types in assignment (expression has type "Slot[Dog]", variable has type "Slot[Animal]")  [assignment]
Found 3 errors in 1 file (checked 1 source file)
```

```text
$ pyright /tmp/sift-scratch/generics_bad.py
generics_bad.py
  generics_bad.py:47:16 - error: Argument of type "Literal['one']" cannot be assigned to parameter "item" of type "int" in function "push"
    "Literal['one']" is not assignable to "int" (reportArgumentType)
  generics_bad.py:50:15 - error: Argument type is partially unknown
    Argument corresponds to parameter "values" in function "print"
    Argument type is "dict[Unknown, list[str]]" (reportUnknownArgumentType)
  generics_bad.py:50:36 - error: Argument of type "(w: str) -> list[str]" cannot be assigned to parameter "key" of type "(V@group_by) -> K@group_by" in function "group_by"
    Type "(w: str) -> list[str]" is not assignable to type "(str) -> K@group_by"
      Function return type "list[str]" is incompatible with type "K@group_by"
        Type "list[str]" is not assignable to type "Hashable"
          "list[str]" is incompatible with protocol "Hashable"
            "__hash__" is an incompatible type
            "__hash__" is not defined as a ClassVar in protocol (reportArgumentType)
  generics_bad.py:54:33 - error: Type "Slot[Dog]" is not assignable to declared type "Slot[Animal]"
    "Slot[Dog]" is not assignable to "Slot[Animal]"
      Type parameter "T@Slot" is invariant, but "Dog" is not the same as "Animal" (reportAssignmentType)
4 errors, 0 warnings, 0 informations
```

运行时 `push("one")` 把字符串放进了“`int` 栈”，`Slot` 的别名写入毫无反应，只有 `group_by` 因为列表不能做字典键抛了 `TypeError`；两个检查器都拦在调用点，没等运行。pyright 一共报了 4 条：除了三处违规，还有一条 `50:15` 的 `reportUnknownArgumentType`，那是 `group_by` 调用失败以后返回值变成未知类型的连锁反应；`group_by` 那条 (`50:36`) 的细节有 6 行，沿着 `Hashable` 协议一路讲到 `__hash__` 不是 `ClassVar`。

`TypeVarTuple` 只给一个例子：保持元组的形状。

```python
"""Keep the shape of a tuple with a TypeVarTuple."""

from typing import reveal_type


def same_shape[*Ts](left: tuple[*Ts], right: tuple[*Ts]) -> tuple[*Ts]:
    """Return left; right must have the same shape."""
    print(len(right))
    return left


def main() -> None:
    """Call same_shape with matching, widened and mismatched shapes."""
    reveal_type(same_shape((1, "a"), (2, "b")))
    reveal_type(same_shape((1, "a"), (2, 3)))
    reveal_type(same_shape((1, "a"), (2,)))  # BAD: lengths differ


if __name__ == "__main__":
    main()
```

```text
$ mypy /tmp/sift-scratch/tuple_shapes.py
tuple_shapes.py:14: note: Revealed type is "tuple[int, str]"
tuple_shapes.py:15: note: Revealed type is "tuple[int, object]"
tuple_shapes.py:16: note: Revealed type is "tuple[Literal[1]? | Literal['a']?, ...]"
Success: no issues found in 1 source file
$ pyright /tmp/sift-scratch/tuple_shapes.py
tuple_shapes.py
  tuple_shapes.py:14:17 - information: Type of "same_shape((1, "a"), (2, "b"))" is "tuple[int, str]"
  tuple_shapes.py:15:17 - information: Type of "same_shape((1, "a"), (2, 3))" is "tuple[int, str | int]"
  tuple_shapes.py:16:17 - information: Type of "same_shape((1, "a"), (2, ))" is "tuple[int, str]"
  tuple_shapes.py:16:38 - error: Argument of type "tuple[Literal[2]]" cannot be assigned to parameter "right" of type "tuple[*Ts@same_shape]" in function "same_shape"
    "tuple[Literal[2]]" is not assignable to "tuple[int, str]"
      Tuple size mismatch; expected 2 but received 1 (reportArgumentType)
1 error, 0 warnings, 3 informations
```

这里两个检查器**真的不一致**。第 14 行形状相同，两者都推断出 `tuple[int, str]`。第 15 行长度相同、类型不同，mypy 推出 `tuple[int, object]`，pyright 推出 `tuple[int, str | int]`，都是合理的取并。关键在第 16 行：两个元组长度不一样，pyright 报 `Tuple size mismatch; expected 2 but received 1`，mypy 却什么也没说，悄悄把 `Ts` 解成了变长元组 `tuple[Literal[1]? | Literal['a']?, ...]`，丢掉了长度。靠 `TypeVarTuple` 守长度的话，在 2.1.0 里只有 pyright 在替我守。

## 变型：为什么 `list[int]` 不是 `list[float]`

`bad_types.py` 的第 5 个错误是变型 (variance) 问题：`mean(values: list[float])` 不接受 `list[int]`，尽管 `int` 在数值塔里是 `float` 的子类型。原因很直白：如果 `list[int]` 能当 `list[float]` 用，函数里一句 `values.append(2.5)` 就把一个 `float` 塞进了调用者的整数列表。又读又写的容器必须是**不变**的 (invariant)；只读的，比如 `Sequence[float]`，可以是**协变**的 (covariant)；只写的，比如“能接收 `Animal` 的东西也能接收 `Dog`”，是**逆变**的 (contravariant)。`lab/ch14/variance.py` 用三个小类各演示一遍：

```python
# ...
class Box[T]:
    """Read only: T is only returned, so Box is covariant in T."""

    def __init__(self, item: T) -> None:
        """Keep item."""
        self._item = item

    def get(self) -> T:
        """Return the item."""
        return self._item


class Sink[T]:
    """Write only: T is only taken, so Sink is contravariant in T."""

    def __init__(self) -> None:
        """Start with nothing seen."""
        self.seen: list[str] = []

    def put(self, item: T) -> None:
        """Record the repr of item."""
        self.seen.append(repr(item))


class Slot[T]:
    """Read and write: Slot is invariant in T."""

    def __init__(self, item: T) -> None:
        """Keep item."""
        self.item = item
# ...
```

三个类里没有任何“我是协变的”声明，PEP 695 的 `class Box[T]` 由检查器根据 `T` 怎么被使用来推断变型：`Box` 只通过 `get` 返回 `T`，协变；`Sink` 只接收 `T`，逆变；`Slot` 的 `item` 是公开可变的属性，既读又写，不变。`main()` 里这些赋值（`Box[Dog]` 当 `Box[Animal]`、`Sink[Animal]` 当 `Sink[Dog]`）都被两个检查器放行，运行结果：

```text
$ python3 lab/ch14/variance.py
dog
True
2.0
dog
```

`Box` 的协变有一个容易漏看的前提：它把 `T` 存在 `self._item` 里，下划线开头。[类型规范里的变型推断](https://typing.python.org/en/latest/spec/generics.html#variance-inference)（最初来自 PEP 695）的算法是：把目标类型参数分别特化成 `object` 和它自己，看两个特化后的类能不能互相赋值，没有提到下划线。但两个检查器的实现都把 `_` 开头的属性当作私有、不计入，`__init__` 的参数也不计入，这是我从下面的实测里得到的，没有在规范里找到依据。把属性改成公开的 `self.item`，推断就变成不变：

```python
"""Compare a private and a public attribute in a generic class."""


class Animal:
    """The base class of a tiny hierarchy."""


class Dog(Animal):
    """A subtype of Animal."""


class BoxPrivate[T]:
    """Keep the item in an underscore attribute."""

    def __init__(self, item: T) -> None:
        """Keep item."""
        self._item = item

    def get(self) -> T:
        """Return the item."""
        return self._item


class BoxPublic[T]:
    """Keep the item in a public, writable attribute."""

    def __init__(self, item: T) -> None:
        """Keep item."""
        self.item = item


def main() -> None:
    """Widen a box of dogs to a box of animals, both ways."""
    private_dogs = BoxPrivate(Dog())
    private: BoxPrivate[Animal] = private_dogs
    public_dogs = BoxPublic(Dog())
    public: BoxPublic[Animal] = public_dogs  # BAD: invariant
    public.item = Animal()
    print(type(private.get()).__name__, type(public_dogs.item).__name__)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/box_public.py
Dog Animal
$ mypy /tmp/sift-scratch/box_public.py
box_public.py:37: error: Incompatible types in assignment (expression has type "BoxPublic[Dog]", variable has type "BoxPublic[Animal]")  [assignment]
Found 1 error in 1 file (checked 1 source file)
$ pyright /tmp/sift-scratch/box_public.py
box_public.py
  box_public.py:37:33 - error: Type "BoxPublic[Dog]" is not assignable to declared type "BoxPublic[Animal]"
    "BoxPublic[Dog]" is not assignable to "BoxPublic[Animal]"
      Type parameter "T@BoxPublic" is invariant, but "Dog" is not the same as "Animal" (reportAssignmentType)
1 error, 0 warnings, 0 informations
```

`BoxPrivate[Dog]` 可以当 `BoxPrivate[Animal]` 用，`BoxPublic[Dog]` 不行（mypy 和 pyright 都拒绝，pyright 说 `Type parameter "T@BoxPublic" is invariant`）；运行时没人拦，最后一行 `Dog Animal` 就是后果：`public.item = Animal()` 通过别名改写了 `public_dogs` 里的那个“狗盒子”。

违反变型的写法，上一节的 `generics_bad.py` 里已经有一个：`animal_slot: Slot[Animal] = dog_slot` 被 mypy 以 `assignment` 拒绝，pyright 的说法是 `Type parameter "T@Slot" is invariant, but "Dog" is not the same as "Animal"`。`bad_types.py` 里的 `mean(ints)` 则让两个检查器顺便给出了修法：`Consider using "Sequence" instead, which is covariant`。

## Protocol：让检查器去查鸭子

[第 7 篇](/posts/python-by-sift-07-inheritance-protocols/)讲过 `Protocol` 是什么，这里只看它在检查器里的行为（协议本身见 [PEP 544](https://peps.python.org/pep-0544/)）。`lab/ch14/protocols_typed.py` 定义了三个协议（一个可调用的 `Scorer`，一个带只读属性的 `HasTitle`，一个带方法的 `SupportsClose`），再把毫不相干的对象传进去：

```python
# ...
class Scorer(Protocol):
    """Anything callable like tf_idf: no inheritance needed."""

    def __call__(self, tf: int, df: int, n_docs: int) -> float:
        """Return the score of one term in one document."""
        ...


@runtime_checkable
class HasTitle(Protocol):
    """An object with a readable title attribute."""

    @property
    def title(self) -> str:
        """Return the title."""
        ...


class SupportsClose(Protocol):
    """An object that can be closed."""

    def close(self) -> None:
        """Release resources."""
        ...
# ...
```

```python
# ...
def main() -> None:
    """Pass unrelated objects to functions typed with Protocols."""
    pairs = [(1, 10), (3, 2)]
    print(round(best(tf_idf, pairs), 3), best(constant, pairs))
    handles = [Handle(), Handle()]
    print(close_all(handles), all(h.closed for h in handles))
    print(titles([Post("a"), Post("b")]))
    things: list[object] = [Post("x"), Handle()]
    print([isinstance(thing, HasTitle) for thing in things])
# ...
```

```text
$ python3 lab/ch14/protocols_typed.py
11.795 1.0
2 True
['a', 'b']
[True, False]
```

`best` 收到的 `tf_idf`（Sift 的 `scoring.tf_idf`）和 `constant` 都没有继承 `Scorer`，两个检查器都认它们符合协议：只要 `(tf: int, df: int, n_docs: int) -> float` 对得上。`Post` 是 dataclass，字段 `title: str` 满足 `HasTitle` 的只读属性；`Handle` 有 `close()` 就是 `SupportsClose`。`isinstance(thing, HasTitle)` 在运行时也能用，只因为它被 `@runtime_checkable` 装饰过：没装饰的协议拿去 `isinstance` 会抛 `TypeError`，而装饰过的也只按名字检查成员是否存在，不看签名，比静态检查弱得多。CPython 里是 `typing.py` 的 [`_ProtocolMeta.__instancecheck__`](https://github.com/python/cpython/blob/v3.14.7/Lib/typing.py#L2035-L2066)（v3.14.7，第 2035 到 2066 行）：第 2048 行抛出那条 `TypeError`，其余成员用 `inspect.getattr_static` 一个一个按名字查。Sift 里真正在用的协议是第一次运行暴露出来的，下一节细看。

## TypedDict、Literal 和 Final

这三样都是让字面量更精确的工具。`TypedDict` 给只在 JSON 或配置里出现的字典一份键的清单；`Literal` 把类型缩窄到几个具体的值；`Final` 声明一个名字不再被赋值。`lab/ch14/typeddict_literal.py`：

```python
# ...
MAX_HITS: Final = 10
DEFAULT_MODE: Final[str] = "and"

type Mode = Literal["and", "or"]


class HitDict(TypedDict):
    """A hit as it travels in JSON: every key is required."""

    doc_id: int
    title: str
    score: float


class SearchRequest(TypedDict, total=False):
    """A request where only ``query`` is required."""

    query: Required[str]
    limit: int
    mode: Mode
    tag: NotRequired[str]
# ...
```

```text
$ python3 lab/ch14/typeddict_literal.py
{"doc_id": 1, "title": "tea", "score": 1.5} dict
'rust' limit=10 mode=and
'rust' limit=3 mode=or
or and 10
['query']
['limit', 'mode', 'tag']
```

`HitDict` 在运行时就是个 `dict`；`SearchRequest` 里 `total=False` 把所有键变成可选，`Required[str]` 把 `query` 单独拉回必填，`NotRequired[str]` 是反方向的写法，所以 `__required_keys__` 只有 `query`，`__optional_keys__` 是其余三个。这两个属性是 `_TypedDictMeta` 在创建类时填的（[第 3268 行](https://github.com/python/cpython/blob/v3.14.7/Lib/typing.py#L3268)），此后没有任何检查键的代码；`Final` 的 [docstring](https://github.com/python/cpython/blob/v3.14.7/Lib/typing.py#L722-L741) 直接写着 `There is no runtime checking of these properties.`

静态的一侧，我写了四处违规：

```python
"""Break four typing rules on purpose and run the result anyway."""

from typing import Final, Literal, NewType, assert_never

MAX_HITS: Final = 10
MAX_HITS = 11  # BAD: a Final name assigned twice
DocId = NewType("DocId", int)
type Level = Literal["debug", "info", "warning"]


def title_of(doc_id: DocId) -> str:
    """Return a fake title; only a DocId is accepted."""
    return f"doc-{doc_id}"


def number(level: Level) -> int:
    """Map a level to its number, but forget one case."""
    match level:
        case "debug":
            return 10
        case "info":
            return 20
        case _:
            assert_never(level)  # BAD: "warning" is not handled


def mode(value: Literal["and", "or"]) -> str:
    """Return the search mode."""
    return value


def main() -> None:
    """Run each mistake; only assert_never stops."""
    print(MAX_HITS)
    print(title_of(7))  # BAD: 7 is an int, not a DocId
    print(mode("xor"))  # BAD: not one of the two literals
    try:
        print(number("warning"))
    except AssertionError as exc:
        print(f"AssertionError: {exc}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/bad_extras.py
11
doc-7
xor
AssertionError: Expected code to be unreachable, but got: 'warning'
$ mypy /tmp/sift-scratch/bad_extras.py
bad_extras.py:6: error: Cannot assign to final name "MAX_HITS"  [misc]
bad_extras.py:24: error: Argument 1 to "assert_never" has incompatible type "Literal['warning']"; expected "Never"  [arg-type]
bad_extras.py:35: error: Argument 1 to "title_of" has incompatible type "int"; expected "DocId"  [arg-type]
bad_extras.py:36: error: Argument 1 to "mode" has incompatible type "Literal['xor']"; expected "Literal['and', 'or']"  [arg-type]
Found 4 errors in 1 file (checked 1 source file)
$ pyright /tmp/sift-scratch/bad_extras.py
bad_extras.py
  bad_extras.py:6:1 - error: "MAX_HITS" is constant (because it is uppercase) and cannot be redefined (reportConstantRedefinition)
  bad_extras.py:6:1 - error: "MAX_HITS" is declared as Final and cannot be reassigned (reportGeneralTypeIssues)
  bad_extras.py:24:26 - error: Argument of type "Literal['warning']" cannot be assigned to parameter "arg" of type "Never" in function "assert_never"
    Type "Literal['warning']" is not assignable to type "Never" (reportArgumentType)
  bad_extras.py:35:20 - error: Argument of type "Literal[7]" cannot be assigned to parameter "doc_id" of type "DocId" in function "title_of"
    "Literal[7]" is not assignable to "DocId" (reportArgumentType)
  bad_extras.py:36:16 - error: Argument of type "Literal['xor']" cannot be assigned to parameter "value" of type "Literal['and', 'or']" in function "mode"
    Type "Literal['xor']" is not assignable to type "Literal['and', 'or']"
      "Literal['xor']" is not assignable to type "Literal['and']"
      "Literal['xor']" is not assignable to type "Literal['or']" (reportArgumentType)
5 errors, 0 warnings, 0 informations
```

Python 全部放行：`MAX_HITS` 变成了 11，`title_of(7)` 打印出 `doc-7`，`mode("xor")` 返回 `xor`，只有 `assert_never` 在运行时真的抛 `AssertionError`（它的实现里有一行 `raise`，源码在 [`typing.py` 第 2572 到 2594 行](https://github.com/python/cpython/blob/v3.14.7/Lib/typing.py#L2572-L2594)）。两个检查器各抓到了全部四个；pyright 共 5 条，在 `MAX_HITS` 上给了两条，因为它的 strict 还把大写名字的重定义当成 `reportConstantRedefinition`。

## Callable、ParamSpec 和 Concatenate

装饰器是 Python 里最典型的“签名变形机”。没有类型的装饰器会把被装饰函数的签名吃掉：

```python
"""Compare a decorator without types and the ParamSpec one of Sift."""

import functools
from collections.abc import Callable
from typing import Any, reveal_type

from sift.util import timed


def untyped(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap fn and forget its signature."""

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        return fn(*args, **kwargs)

    return wrapper


@untyped
def add_loose(a: int, b: int = 0) -> int:
    """Return a + b."""
    return a + b


@timed
def add_typed(a: int, b: int = 0) -> int:
    """Return a + b."""
    return a + b


def main() -> None:
    """Reveal both decorated functions and call each wrongly."""
    reveal_type(add_loose)
    reveal_type(add_typed)
    print(add_loose("a", "b"))
    print(add_typed("a", "b"))  # BAD: str arguments


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/paramspec_reveal.py
Runtime type is 'function'
Runtime type is 'function'
ab
add_typed took 0.0 ms
ab
$ mypy /tmp/sift-scratch/paramspec_reveal.py
paramspec_reveal.py:34: note: Revealed type is "def (*Any, **Any) -> Any"
paramspec_reveal.py:35: note: Revealed type is "def (a: int, b: int =) -> int"
paramspec_reveal.py:37: error: Argument 1 to "add_typed" has incompatible type "str"; expected "int"  [arg-type]
paramspec_reveal.py:37: error: Argument 2 to "add_typed" has incompatible type "str"; expected "int"  [arg-type]
Found 2 errors in 1 file (checked 1 source file)
$ pyright /tmp/sift-scratch/paramspec_reveal.py
paramspec_reveal.py
  paramspec_reveal.py:34:17 - information: Type of "add_loose" is "(...) -> Any"
  paramspec_reveal.py:35:17 - information: Type of "add_typed" is "(a: int, b: int = 0) -> int"
  paramspec_reveal.py:37:21 - error: Argument of type "Literal['a']" cannot be assigned to parameter "a" of type "int"
    "Literal['a']" is not assignable to "int" (reportArgumentType)
  paramspec_reveal.py:37:26 - error: Argument of type "Literal['b']" cannot be assigned to parameter "b" of type "int"
    "Literal['b']" is not assignable to "int" (reportArgumentType)
2 errors, 0 warnings, 2 informations
```

`add_loose` 被无类型的装饰器包过，两个检查器都认为它是 `(...) -> Any`，随便传什么都不报错；`add_typed` 用的是 Sift 自己的 `util.timed`，签名完整保留，第 37 行的两个错误参数都被抓到。`timed` 从第 4 篇起就是这样写的：

```python
# ...
def timed[**P, R](fn: Callable[P, R]) -> Callable[P, R]:
    """Wrap fn so each call prints its name and time to stderr."""

    @functools.wraps(fn)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        start = time.perf_counter()
        try:
            return fn(*args, **kwargs)
        finally:
            ms = (time.perf_counter() - start) * 1000
            print(f"{fn.__qualname__} took {ms:.1f} ms", file=sys.stderr)

    return wrapper
# ...
```

`**P` 是 `ParamSpec`：“一整组参数”；`Callable[P, R]` 是“参数为 P、返回 R 的函数”；`wrapper(*args: P.args, **kwargs: P.kwargs)` 把 P 传递下去。这是 [PEP 612](https://peps.python.org/pep-0612/) (3.10)，PEP 695 的 `[**P, R]` 是它的新写法。`git diff ch13 ch14 -- src/sift/util.py` 是空的：这个函数不需要为了 mypy 改一个字。`Concatenate` 是在 P 前面加几个参数或去掉前几个，`lab/ch14/paramspec.py` 里的两个装饰器分别改返回值和改参数：

```python
# ...
def with_clock[**P, R](
    fn: Callable[P, R],
) -> Callable[P, tuple[R, float]]:
    """Return a function that gives (result, seconds).

    The result type changes, the parameters (P) do not.
    """

    @functools.wraps(fn)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> tuple[R, float]:
        start = time.perf_counter()
        result = fn(*args, **kwargs)
        return result, time.perf_counter() - start

    return wrapper


def with_logger[**P, R](
    fn: Callable[Concatenate[logging.Logger, P], R],
) -> Callable[P, R]:
    """Inject a logger as the first argument and hide it.

    Concatenate adds one parameter in front of P: fn takes
    (Logger, *P), the decorated function takes just P.
    """

    @functools.wraps(fn)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        return fn(log, *args, **kwargs)

    return wrapper
# ...
```

`with_clock` 保持参数 `P` 不变，把返回值从 `R` 变成 `tuple[R, float]`；`with_logger` 接收的函数第一个参数是 `Logger`，装饰之后这个参数消失，调用者只看见 `P`：

```text
$ python3 lab/ch14/paramspec.py
add took 0.0 ms
3
42 True
SIFT
```

`describe("sift", upper=True)` 只传了 `name` 和关键字 `upper`，`logger` 是装饰器偷偷塞进去的，检查器却知道 `describe` 的完整签名是 `(name: str, *, upper: bool = False) -> str`。

## @overload：一个函数，多个签名

返回类型取决于参数的时候，用 `@overload`。`lab/ch14/overloads.py` 里的 `first_or`：没有默认值时返回 `T | None`，有默认值 `D` 时返回 `T | D`：

```python
# ...
@overload
def first_or[T](items: Sequence[T], default: None = None) -> T | None: ...
@overload
def first_or[T, D](items: Sequence[T], default: D) -> T | D: ...
def first_or(items: Sequence[object], default: object = None) -> object:
    """Return the first item, or default when the sequence is empty."""
    return items[0] if items else default


@overload
def best_scores(
    raw: dict[int, float], k: None = None
) -> tuple[int, float]: ...
@overload
def best_scores(raw: dict[int, float], k: int) -> list[tuple[int, float]]: ...
def best_scores(
    raw: dict[int, float], k: int | None = None
) -> tuple[int, float] | list[tuple[int, float]]:
    """Return the best entry without k, else the best k entries."""
    best = top_k(raw, 1 if k is None else k)
    return best[0] if k is None else best
# ...
```

```text
$ mypy lab/ch14/overloads.py
lab/ch14/overloads.py:51: note: Revealed type is "int | None"
lab/ch14/overloads.py:52: note: Revealed type is "int | str"
lab/ch14/overloads.py:53: note: Revealed type is "tuple[int, float]"
lab/ch14/overloads.py:54: note: Revealed type is "list[tuple[int, float]]"
```

```text
$ pyright lab/ch14/overloads.py
  lab/ch14/overloads.py:51:17 - information: Type of "first_or([1, 2])" is "int | None"
  lab/ch14/overloads.py:52:17 - information: Type of "first_or([1, 2], "none")" is "int | str"
  lab/ch14/overloads.py:53:17 - information: Type of "best_scores(table)" is "tuple[int, float]"
  lab/ch14/overloads.py:54:17 - information: Type of "best_scores(table, 2)" is "list[tuple[int, float]]"
0 errors, 0 warnings, 4 informations
```

两个检查器对四个 `reveal_type` 给出一致的答案：`first_or([1, 2])` 是 `int | None`，`first_or([1, 2], "none")` 是 `int | str`，`best_scores(table)` 是 `tuple[int, float]`，`best_scores(table, 2)` 是 `list[tuple[int, float]]`。运行时没有这回事：`@overload` 装饰的函数被 [`typing.overload`](https://github.com/python/cpython/blob/v3.14.7/Lib/typing.py#L2663-L2701) 登记到 `_overload_registry`，然后换成一个被调用就抛 `NotImplementedError` 的 `_overload_dummy`（[第 2650 行](https://github.com/python/cpython/blob/v3.14.7/Lib/typing.py#L2650-L2657)），真正执行的是最后那个没有装饰器的实现。所以重载只是给检查器的说明书，实现要自己兼容所有重载。Sift 的产品代码里没有一个重载，不同的返回类型用不同的函数名表达更直接。

## 窄化：isinstance、TypeIs、TypeGuard、assert_never

联合类型靠窄化 (narrowing) 变成具体类型，`isinstance` 和 `is None` 是最熟悉的两种，`lab/ch14/narrowing.py` 里的 `length` 同时用了两种（`main()` 里 `length(None)`、`length("a b c")`、`length([1, 2])` 的输出是 `0 3 2`）：

```python
# ...
def length(value: str | list[int] | None) -> int:
    """Return len(value); None is 0. Each branch narrows the type."""
    if value is None:
        return 0
    if isinstance(value, str):
        return len(value.split())
    return len(value)
# ...
```

自己写判断函数的时候，3.13 的 `TypeIs` 和 3.10 的 `TypeGuard` 的区别是：`TypeIs[X]` 在返回 `True` 时窄化为 `X`，在 `False` 时窄化为“去掉 `X` 以后剩下的”；`TypeGuard[X]` 只在 `True` 时窄化，`False` 时什么都不说。对照一下，顺便带上 `Never`：

```python
"""Compare TypeIs and TypeGuard on both branches, then reach Never."""

from typing import Never, TypeGuard, TypeIs, reveal_type


def is_int_is(value: int | str) -> TypeIs[int]:
    """Return True if value is an int; both branches narrow."""
    return isinstance(value, int)


def is_int_guard(value: int | str) -> TypeGuard[int]:
    """Return True if value is an int; only the True branch narrows."""
    return isinstance(value, int)


def fail(message: str) -> Never:
    """Raise ValueError; the checker knows this never returns."""
    raise ValueError(message)


def describe(value: int | str) -> str:
    """Show the narrowed type in each branch."""
    if is_int_is(value):
        reveal_type(value)
    else:
        reveal_type(value)
    if is_int_guard(value):
        reveal_type(value)
    else:
        reveal_type(value)
    return str(value)


def after_fail() -> int:
    """Call fail and keep going: the last line can never run."""
    fail("stop")
    return 1  # unreachable


def main() -> None:
    """Call describe and the helper that never returns."""
    print(describe(3), describe("a"))
    reveal_type(fail)
    try:
        after_fail()
    except ValueError as exc:
        print("ValueError:", exc)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/typeis_vs_guard.py 2>/dev/null
3 a
ValueError: stop
$ mypy /tmp/sift-scratch/typeis_vs_guard.py
typeis_vs_guard.py:24: note: Revealed type is "int"
typeis_vs_guard.py:26: note: Revealed type is "str"
typeis_vs_guard.py:28: note: Revealed type is "int"
typeis_vs_guard.py:30: note: Revealed type is "int | str"
typeis_vs_guard.py:43: note: Revealed type is "def (message: str) -> Never"
Success: no issues found in 1 source file
$ pyright /tmp/sift-scratch/typeis_vs_guard.py
typeis_vs_guard.py
  typeis_vs_guard.py:24:21 - information: Type of "value" is "int"
  typeis_vs_guard.py:26:21 - information: Type of "value" is "str"
  typeis_vs_guard.py:28:21 - information: Type of "value" is "int"
  typeis_vs_guard.py:30:21 - information: Type of "value" is "int | str"
  typeis_vs_guard.py:43:17 - information: Type of "fail" is "(message: str) -> Never"
0 errors, 0 warnings, 5 informations
$ mypy --warn-unreachable /tmp/sift-scratch/typeis_vs_guard.py | grep unreachable
typeis_vs_guard.py:37: error: Statement is unreachable  [unreachable]
```

四行 `reveal_type`，两个检查器的结果相同：用 `TypeIs` 时 `True` 分支是 `int`，`False` 分支是 `str`；用 `TypeGuard` 时 `True` 分支是 `int`，`False` 分支仍然是 `int | str`。判断函数是“精确判断”就用 `TypeIs`；只是“有时候能证明是 `X`”就用 `TypeGuard`。

`fail(message: str) -> Never` 声明“这个函数从不正常返回”。调用它之后的代码就是不可达的：我在 `after_fail` 里 `fail("stop")` 之后写了一句 `return 1`，默认的 mypy 和 pyright 对此沉默，只有 mypy 加上 `--warn-unreachable` 才抱怨 `Statement is unreachable`（pyright 在命令行里我没找到对应的开关）。`Never` 是类型系统的底：没有任何值属于它，所以 `assert_never(x: Never)` 才能当作穷尽性检查。`lab/ch14/narrowing.py` 里用它让检查器验证 `match` 覆盖了联合的所有成员：

```python
# ...
def show(node: Node) -> str:
    """Render a query tree; a new Node class would fail type checking."""
    match node:
        case Term(text) | Prefix(text):
            return text
        case Phrase(words):
            return '"' + " ".join(words) + '"'
        case Field(name, value):
            return f"{name}:{show(value)}"
        case And(left, right):
            return f"({show(left)} AND {show(right)})"
        case Or(left, right):
            return f"({show(left)} OR {show(right)})"
        case Not(operand):
            return f"NOT {show(operand)}"
        case _:
            assert_never(node)
# ...
```

`show(node: Node)` 把查询语法树的 7 种节点都匹配了一遍，最后的 `case _: assert_never(node)` 要求到这里 `node` 已经是 `Never`。如果有人给 `Node` 加一个新类而忘了处理，检查器会在这一行报错。上一节 `bad_extras.py` 里的 `number("warning")` 就是反例：`Argument 1 to "assert_never" has incompatible type "Literal['warning']"; expected "Never"`，而运行时会在 `assert_never` 里抛出 `AssertionError: Expected code to be unreachable, but got: 'warning'`。静态和动态的双保险：检查器没跑过的路径，运行时至少响一声。

## NewType 和 Annotated

`NewType("DocId", int)` 造一个“运行时就是 `int`、静态上是新类型”的东西，避免把 `DocId` 和 `TermId` 混用。`lab/ch14/newtype_annotated.py` 里还有一个 `Annotated`：`type Limit = Annotated[int, Gt(0)]`，`Gt` 是我自己定义的元数据类：

```python
# ...
type Limit = Annotated[int, Gt(0)]


@dataclass
class Query:
    """A query; Annotated metadata is data, nothing checks it."""

    text: str
    limit: Limit = 10
    doc: Annotated[DocId, "the document to start from"] = DocId(0)


def title_of(doc_id: DocId) -> str:
    """Return a fake title; only a DocId is accepted."""
    return f"doc-{doc_id}"
# ...
```

`DocId(7)` 没有创建对象，但也不是免费的：[`typing.NewType`](https://github.com/python/cpython/blob/v3.14.7/Lib/typing.py#L3435-L3494) 的 `__call__` 是 `_idfunc`（[第 3457 行](https://github.com/python/cpython/blob/v3.14.7/Lib/typing.py#L3457)），一个 Python 层面的恒等函数，每次调用仍是一次函数调用。我量了一下：

```python
"""Time a literal, a NewType call and a plain identity function."""

import statistics
import timeit
from typing import NewType

DocId = NewType("DocId", int)


def ident(value: int) -> int:
    """Return value unchanged."""
    return value


def main() -> None:
    """Print the best of 5 timings in nanoseconds per call."""
    loops = 2_000_000
    cases = {
        "literal 7": "7",
        "DocId(7)": "DocId(7)",
        "ident(7)": "ident(7)",
    }
    results: dict[str, list[float]] = {name: [] for name in cases}
    for _ in range(5):
        for name, stmt in cases.items():
            seconds = timeit.timeit(stmt, globals=globals(), number=loops)
            results[name].append(seconds / loops * 1e9)
    for name, values in results.items():
        print(
            f"{name:<10} min {min(values):5.1f} ns  "
            f"median {statistics.median(values):5.1f} ns"
        )


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/cpu_state.py; \
    python3 /tmp/sift-scratch/newtype_cost.py; \
    python3 /tmp/sift-scratch/cpu_state.py
112 113 113 113 115 ms
literal 7  min   6.8 ns  median   8.1 ns
DocId(7)   min  47.5 ns  median  48.1 ns
ident(7)   min  22.8 ns  median  23.4 ns
111 113 114 114 115 ms
```

字面量 `7` 约 8 ns（这里的循环开销也算在内，而且字面量大概被编译器折叠了），`DocId(7)` 约 48 ns，自己写的 `ident(7)` 约 23 ns，前后两次 `cpu_state.py` 都在快状态。第一行 `doc-7 int True`（下面的输出）说明返回的就是那个 `int`。静态的一侧，`title_of(7)` 在 `bad_extras.py` 里被两个检查器都拒绝 (`"Literal[7]" is not assignable to "DocId"`)，要写 `title_of(DocId(7))`。

`Annotated` 的元数据对运行时只是数据，检查器完全不理，要自己读。这个实验文件的第一版是这样读的：`get_type_hints(..., include_extras=True)` 之后对每个提示取 `__metadata__`。我把上一个提交的文件解到临时目录，和现在的版本各跑一遍：

```text
$ cd /tmp/sift-scratch/prev
$ python3 lab/ch14/newtype_annotated.py
doc-7 int True
[] []
typing.Annotated[int, Gt(bound=0)]
```

旧版的第二行 `[] []` 是我没料到的：`Query("rust", limit=0)` 应该违反 `Gt(0)`，却什么也没报。原因是 `limit: Limit` 引用的是 `type` 语句建的别名，`get_type_hints` 把它原样留成 `TypeAliasType`，没有 `__metadata__`，要手动取 `__value__` 才看得到里面的 `Annotated`。老写法 `Limit = Annotated[...]` 直接是 `_AnnotatedAlias`，没有这个问题。这个缺口修在仓库里了：

```python
# ...
def metadata(hint: object) -> tuple[object, ...]:
    """Return the Annotated metadata of hint, through type aliases.

    get_type_hints leaves ``type Limit = ...`` as a TypeAliasType, so
    unwrap ``__value__`` until an Annotated (or something else) shows.
    """
    while isinstance(hint, TypeAliasType):
        hint = hint.__value__
    return tuple(getattr(hint, "__metadata__", ()))


def check(obj: object) -> list[str]:
    """Read Gt(...) metadata and report fields that break it."""
    problems: list[str] = []
    hints = get_type_hints(type(obj), include_extras=True)
    for name, hint in hints.items():
        for meta in metadata(hint):
            value = getattr(obj, name)
            if isinstance(meta, Gt) and value <= meta.bound:
                problems.append(f"{name}={value} must be > {meta.bound}")
    return problems
# ...
```

```text
$ cd ~/Projects/sift
$ python3 lab/ch14/newtype_annotated.py
doc-7 int True
limit=10: []
limit=0:  ['limit=0 must be > 0']
typing.Annotated[int, Gt(bound=0)]
$ mypy lab/ch14/newtype_annotated.py
Success: no issues found in 1 source file
$ pyright lab/ch14/newtype_annotated.py | tail -1
0 errors, 0 warnings, 0 informations
```

`metadata` 先循环展开 `TypeAliasType`，再读 `__metadata__`；修好后 `limit=10` 没有问题，`limit=0` 报出 `limit=0 must be > 0`，两个检查器对这个文件也都是干净的。教训是：元数据没有强制力，pydantic 和 FastAPI（第 18 篇）读它，是因为它们自己实现了“读”这一步，而“读”这一步本身就容易写漏。

## Self、TYPE_CHECKING 和存根

返回“调用它的那个类的实例”的方法，以前要写 `TypeVar("T", bound="Builder")` 再 `def add(self: T) -> T`，3.11 的 `Self` 省掉了这些。`lab/ch14/self_type.py`：

```python
# ...
class Builder:
    """A fluent builder; subclasses keep their own type in chains."""

    def __init__(self) -> None:
        """Start with no parts."""
        self.parts: list[str] = []

    def add(self, part: str) -> Self:
        """Append part and return the same object."""
        self.parts.append(part)
        return self

    @classmethod
    def of(cls, *parts: str) -> Self:
        """Build an instance of the class it is called on."""
        built = cls()
        for part in parts:
            built.add(part)
        return built

    def copy(self) -> Self:
        """Return a new object of the same class with the same parts."""
        return type(self).of(*self.parts)


class QueryBuilder(Builder):
    """Adds methods that the base class does not have."""

    def and_(self, word: str) -> Self:
        """Join word with AND."""
        return self.add("AND").add(word)
# ...
```

```text
$ python3 lab/ch14/self_type.py
rust AND lifetime AND borrow QueryBuilder
Runtime type is 'QueryBuilder'
Runtime type is 'QueryBuilder'
$ mypy lab/ch14/self_type.py
lab/ch14/self_type.py:43: note: Revealed type is "self_type.QueryBuilder"
lab/ch14/self_type.py:44: note: Revealed type is "self_type.QueryBuilder"
Success: no issues found in 1 source file
```

```text
$ pyright lab/ch14/self_type.py
  lab/ch14/self_type.py:43:17 - information: Type of "query.add("x")" is "QueryBuilder"
  lab/ch14/self_type.py:44:17 - information: Type of "QueryBuilder.of()" is "QueryBuilder"
```

`QueryBuilder.of("rust")` 是 `QueryBuilder` 而不是 `Builder`，所以能继续 `.and_("lifetime")` 链式调用；基类的 `add` 返回的也是 `QueryBuilder`，两个检查器一致。

`typing.TYPE_CHECKING` 在运行时恒为 `False`，检查器当它是 `True`，用来导入只给检查器看的名字，比如避开循环导入（[`typing.py:3502`](https://github.com/python/cpython/blob/v3.14.7/Lib/typing.py#L3502) 里它就是一行 `TYPE_CHECKING = False`）。3.14 之前，被保护的导入引入的名字要写成字符串注解，否则 `def` 一执行就 `NameError`；3.14 的延迟注解让它不再需要引号：

```python
"""Import a name for the checker only and see what runs."""

import annotationlib
import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sift.index import InvertedIndex


def size(index: InvertedIndex) -> int:
    """Return the number of documents of index."""
    return index.n_docs


def main() -> None:
    """Show that the guarded import never ran."""
    print("TYPE_CHECKING:", TYPE_CHECKING)
    print("sift.index imported:", "sift.index" in sys.modules)
    hints = annotationlib.get_annotations(
        size, format=annotationlib.Format.FORWARDREF
    )
    print(hints)
    try:
        # error: NameError: name 'InvertedIndex' is not defined
        print(annotationlib.get_annotations(size))
    except NameError as exc:
        print(f"NameError: {exc}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/type_checking.py
TYPE_CHECKING: False
sift.index imported: False
{'index': ForwardRef('InvertedIndex', owner=<function size at 0x7ffff6e76c40>), 'return': <class 'int'>}
NameError: name 'InvertedIndex' is not defined
$ mypy /tmp/sift-scratch/type_checking.py
Success: no issues found in 1 source file
$ pyright /tmp/sift-scratch/type_checking.py
0 errors, 0 warnings, 0 informations
```

`TYPE_CHECKING` 是 `False`，`sift.index` 没被导入，函数却定义成功了，两个检查器也都没有意见。读注解时就分情况：`FORWARDREF` 格式返回一个 `ForwardRef('InvertedIndex')` 占位符，默认的 `VALUE` 格式要真正求值，于是 `NameError`。`src/sift` 里一次 `TYPE_CHECKING` 都没有，我还没碰到需要它的循环导入。

### 存根文件：给没标签的罐子贴标签

`lab/ch14/legacy/scores.py` 是一个没有任何注解的模块，旁边的 `scores.pyi` 是它的存根 (stub file)：只有签名，没有实现。

```python
from collections.abc import Mapping

def normalize(
    scores: Mapping[int, float], top: int | None = None
) -> list[tuple[int, float]]: ...
```

我把 `scores.py`（没有注解的那份，见仓库）连同一个故意传错参数的调用者复制到两个临时目录，一个带 `.pyi`，一个不带：

```python
"""Call an untyped module, with and without its stub."""

from scores import normalize


def main() -> None:
    """Normalize a score table and a bad one."""
    print(normalize({1: 2.0, 2: 4.0}, top=1))
    print(normalize({1: 2.0}, top="x"))  # BAD: top is int | None


if __name__ == "__main__":
    main()
```

```text
$ cd /tmp/sift-scratch/stub_demo/without
$ python3 use_scores.py 2>&1 | tail -1
TypeError: slice indices must be integers or None or have an __index__ method
$ mypy --strict use_scores.py
scores.py:4: error: Function is missing a type annotation  [no-untyped-def]
use_scores.py:8: error: Call to untyped function "normalize" in typed context  [no-untyped-call]
use_scores.py:9: error: Call to untyped function "normalize" in typed context  [no-untyped-call]
Found 3 errors in 2 files (checked 1 source file)
$ cd /tmp/sift-scratch/stub_demo/with
$ mypy --strict use_scores.py
use_scores.py:9: error: Argument "top" to "normalize" has incompatible type "str"; expected "int | None"  [arg-type]
Found 1 error in 1 file (checked 1 source file)
```

不带存根的时候，mypy 的严格模式把 `scores.py` 本身（缺注解）和两次调用 (`no-untyped-call`) 都报了出来，却**没有发现** `top="x"` 这个真错误，因为 `normalize` 对它来说是个什么都收的 `Any` 函数；运行时它以 `TypeError: slice indices must be integers...` 现身。带存根的时候，检查器只读 `.pyi`，不再检查 `.py` 的实现，并抓住了 `top` 的类型错误。存根还用来给 C 扩展和第三方库补类型：typeshed 就是这样一堆 `.pyi`，mypy 2.1.0 自带一份，pyright 1.1.412 自带另一份，后面引用的 `bisect_left` 和 `getLevelName` 的签名都来自那里。

`src/sift/py.typed` 是 [PEP 561](https://peps.python.org/pep-0561/) 的标记文件，一个 0 字节的空文件，意思是“这个包自带内联类型，使用者的检查器可以直接信它”；按 PEP 561，没有这个标记的话，别人安装 `sift` 之后，检查器不会去读它的内联类型。我没有构建 wheel 去验证打包是否带上这个文件，留给第 19 篇。


## 第一次运行：42 条抱怨

配置只有 10 行，写在 `pyproject.toml` 里：

```toml
# ...
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

`mypy_path = "src"` 不是装饰：没有它，`lab/` 里的文件找不到 `sift`（我删掉这一行试过，`from sift.cache import LRUCache` 就报 `import-not-found`）。

第一次运行的数字要在干净的现场测：把标签 `ch13` 的源码解到临时目录，只借用 ch14 的 `pyproject.toml`，这样两个检查器看到的是没有为它们改过的代码：

```text
$ mkdir /tmp/sift-scratch/first
$ git archive ch13 | tar -x -C /tmp/sift-scratch/first
$ git show ch14:pyproject.toml > /tmp/sift-scratch/first/pyproject.toml
```

开头那个代码块就是这个目录里的输出。按文件和规则统计：

```text
$ cd /tmp/sift-scratch/first
$ mypy | grep ": error:" | cut -d: -f1 | sort | uniq -c
      4 src/sift/cli.py
      1 src/sift/document.py
      2 src/sift/index.py
      2 src/sift/storage/segment.py
$ pyright | grep -E "^  /" | cut -d: -f1 | sed "s|.*/src/|src/|" | sort | uniq -c
     14 src/sift/cli.py
      8 src/sift/config.py
      3 src/sift/index.py
      1 src/sift/log.py
      2 src/sift/query/evaluate.py
      2 src/sift/search.py
      1 src/sift/storage/db.py
      1 src/sift/storage/manifest.py
      1 src/sift/storage/segment.py
$ pyright | grep -o "(report[A-Za-z]*)" | sort | uniq -c | sort -rn
     11 (reportUnknownArgumentType)
     10 (reportUnknownVariableType)
      4 (reportUnknownMemberType)
      3 (reportUnnecessaryIsInstance)
      3 (reportArgumentType)
      2 (reportDeprecated)
```

pyright 的 33 条里有 25 条属于同一个家族，`reportUnknown*`（“这个类型里有 `Unknown`”），这是 pyright strict 最爱抱怨的东西，mypy 的 `--strict` 完全不会为这些说话。逐条对号入座，42 条可以归成 11 个原因，下面按顺序讲修法：

| 位置 | mypy | pyright | 原因 | 修法 |
| --- | --- | --- | --- | --- |
| `cli.py:208,315` | 2 | 2 | `Searcher` 参数写成 `InvertedIndex`，传进来的是 `SegmentIndex` | 协议 `IndexView`、`PostingLookup` |
| `cli.py:440,441` | 2 | 0 | `except ... as error` 之后复用名字 `error` | 改名 `failure` |
| `cli.py` 等三个文件 | 0 | 16 | `x = []` 没有元素类型 | 写出 `list[float]` 之类 |
| `index.py:79,80` | 2 | 0 | `bisect_left` 的键函数返回 `Any`，要找的值是 `object` | `isinstance` 守卫，注解 `_DOC_ID` |
| `index.py:94,112,141` | 0 | 3 | `isinstance(other, PostingList)` 永远为真 | `other: object` |
| `document.py:89` | 1 | 0 | 给 `tags` 重新绑定了另一种列表 | 新变量 `raw_tags` |
| `segment.py:169` | 2 | 1 | `bytearray` 不是 `bytes` | `Iterable[Buffer]` |
| `config.py` | 0 | 8 | `isinstance(x, dict)` 得到 `dict[Unknown, Unknown]` | `cast` 和 `TypeIs` |
| `log.py:21` | 0 | 1 | `getLevelName(str)` 被弃用 | `getLevelNamesMapping()` |
| `db.py:187` | 0 | 1 | `@contextmanager` 配 `Iterator` 被弃用 | `Generator[Session]` |
| `manifest.py:34` | 0 | 1 | `default_factory=dict` 无类型 | `dict[str, FileEntry]` |

mypy 一列加起来 9，pyright 一列加起来 33。下面每处的 diff 来自 `git diff ch13 ch14`，上下文压缩到 0 或 1 行（`-U0`、`-U1`），去掉了开头的 `diff --git` 和 `index` 两行，只摘与这一类问题相关的 hunk。

### 真问题：Searcher 的标签撒谎

`cli.py:208` 和 `:315` 两个检查器都认。`Searcher.__init__(self, index: InvertedIndex, ...)` 是第 8 篇写的，那时索引只有内存里的 `InvertedIndex`；第 12 篇加了 mmap 的 `SegmentIndex`，`sift search` 开始传它，签名没人改。代码一直是对的（两个类的接口一样），只是标签贴错了，测试发现不了（测试里的 `Searcher` 用的是 `InvertedIndex`）。修法是把 `Searcher` 和 `evaluate` 真正用到的接口写成协议，`index.py` 新增了这两个：

```python
# ...
class PostingLookup(Protocol):
    """Anything that maps a term to its PostingList, with a default."""

    def get(self, term: str, default: PostingList, /) -> PostingList:
        """Return the postings of term, or default if it has none."""
        ...


class IndexView(PostingLookup, Protocol):
    """What Searcher and evaluate need from an index.

    InvertedIndex (in memory) and SegmentIndex (mmap) both conform;
    neither inherits from this class.
    """

    @property
    def documents(self) -> Mapping[int, Document]:
        """Return the live documents by doc_id."""
        ...
# ...
```

`PostingLookup` 只有 `get(term, default, /)`，因为 `evaluate.py` 里的 `phrase_postings` 只用了 `lookup.get`；`IndexView` 继承它，再加上 `Searcher` 需要的成员。`InvertedIndex` 和 `SegmentIndex` 都没有继承它们，也没改一个字，检查器逐个成员比对，确认符合。`evaluate.py` 的改动只是把参数类型换成协议：

```diff
--- a/src/sift/query/evaluate.py
+++ b/src/sift/query/evaluate.py
@@ -7 +7 @@ from sift.analysis import Pipeline, build_pipeline
-from sift.index import InvertedIndex, Posting, PostingList
+from sift.index import IndexView, Posting, PostingList, PostingLookup
```

`IndexView` 里的 `documents` 用 `@property` 声明：实现可以是真正的 `@property`，也可以是普通的实例属性，只读的协议不要求实现可写。

### 名字复用（mypy 独有）

`cli.py:440` 和 `:441` 只有 mypy 抱怨。`main()` 的前一个分支是 `except SiftError as error`，后一个在 `except ExceptionGroup as group` 里写了 `for error in group.exceptions`。Python 在 `except ... as error` 的块结束时会 `del error`（为了打断异常和 traceback 之间的引用环），mypy 因此把 `error` 当成“只在那个子句内有效的名字”，在别处再绑定就报 `Assignment to variable "error" outside except: block`。代码本身没问题，我猜 mypy 宁可误报，也不漏掉真正的 `UnboundLocalError`。修法是改名：

```diff
--- a/src/sift/cli.py
+++ b/src/sift/cli.py
@@ -439,4 +439,4 @@ def main(argv: Sequence[str] | None = None) -> None:
         print(f"error: {group.message}", file=sys.stderr)
-        for error in group.exceptions:
-            print(f"  {error}", file=sys.stderr)
+        for failure in group.exceptions:
+            print(f"  {failure}", file=sys.stderr)
         sys.exit(1)
```

### 空列表（pyright 独有，16 条）

最大的一批是 `x = []`。mypy 看到 `seconds = []` 后紧跟 `seconds.append(...)`，会按第一次 `append` 的参数推断出 `list[float]`；pyright 的 strict 不这么做，它说 `Type of "append" is partially unknown`，下游每个用到这个列表的表达式都跟着变成 `Unknown`，一个根源引出十几条报错。`cli.py` 占 12 条，`evaluate.py` 和 `search.py` 各 2 条，修法都是在空列表那一行写出类型：

```diff
--- a/src/sift/cli.py
+++ b/src/sift/cli.py
@@ -292,3 +292,3 @@ def run_bench_index(args: argparse.Namespace) -> None:
     config = load_config()
-    seconds = []
+    seconds: list[float] = []
     with tempfile.TemporaryDirectory(prefix="sift-bench-") as tmp:
@@ -311,3 +311,3 @@ def run_bench_search(args: argparse.Namespace) -> None:
     queries = QUERIES.read_text(encoding="utf-8").splitlines()
-    timings = []
+    timings: list[tuple[str, int, float]] = []
     with open_index(directory) as index:
```

这 16 条里没有一条是 bug，全是“我没说”。

### `__contains__` 和运算符

`index.py` 的 5 条是同一个家族。`PostingList.__contains__(self, doc_id: object)` 里有一行 `bisect_left(self._postings, doc_id, key=_DOC_ID)`，mypy 报 `No overload variant of "bisect_left" matches argument types "list[Posting]", "object", "attrgetter[Any]"`。typeshed 里 [`bisect_left` 的 `key=` 版本](https://github.com/python/mypy/blob/v2.1.0/mypy/typeshed/stdlib/_bisect.pyi#L26-L47)要求要找的值和键函数的返回值是同一个“可比较”类型 (`SupportsRichComparisonT`)，mypy 认为 `object` 不满足它；调用失败以后 `i` 变成 `Any`，下一行的表达式跟着是 `Any`，又触发 `no-any-return`。这是个**真的**边界缺陷：`"3" in postings` 会让 `bisect_left` 拿 `int` 和 `str` 比较，抛 `TypeError`，而 Python 的惯例是 `"3" in {1, 2}` 回答 `False`。修法是先判断类型，再把键函数的类型说清楚：

```diff
--- a/src/sift/index.py
+++ b/src/sift/index.py
@@ -12,3 +12,3 @@ from sift.document import Document
 
-_DOC_ID = attrgetter("doc_id")
+_DOC_ID: Callable[[Posting], int] = attrgetter("doc_id")
 
@@ -78,2 +78,4 @@ class PostingList:
         """Return True if some posting has this doc_id."""
+        if not isinstance(doc_id, int):
+            return False
         i = bisect_left(self._postings, doc_id, key=_DOC_ID)
```

这是一次**行为变更**，不只是类型改动。我写了个脚本，拿 ch13 和 ch14 两份源码对同一组值各问一遍（用 `PYTHONPATH` 切换 `sift` 来自哪一份）：

```python
"""Probe PostingList.__contains__ with values that are not ints."""

import sift
from sift.index import Posting, PostingList


def probe(plist: PostingList, value: object) -> str:
    """Return the result of ``value in plist`` or the exception."""
    try:
        return str(value in plist)
    except TypeError as exc:
        return f"TypeError: {exc}"


def main() -> None:
    """Print one line per probe value."""
    print(sift.__file__)
    plist = PostingList([Posting(1, (0,)), Posting(3, (2,))])
    for value in (3, 2, 3.0, "3", None):
        print(f"{value!r:>5} in plist -> {probe(plist, value)}")


if __name__ == "__main__":
    main()
```

```text
$ PYTHONPATH=/tmp/sift-scratch/first/src \
    python3 /tmp/sift-scratch/contains_change.py
first/src/sift/__init__.py
    3 in plist -> True
    2 in plist -> False
  3.0 in plist -> True
  '3' in plist -> TypeError: '<' not supported between instances of 'int' and 'str'
 None in plist -> TypeError: '<' not supported between instances of 'int' and 'NoneType'
$ PYTHONPATH=src python3 /tmp/sift-scratch/contains_change.py
src/sift/__init__.py
    3 in plist -> True
    2 in plist -> False
  3.0 in plist -> False
  '3' in plist -> False
 None in plist -> False
```

`'3' in plist` 和 `None in plist` 从抛 `TypeError` 变成了 `False`，这是我想要的。`3.0 in plist` 却从 `True` 变成了 `False`：`isinstance(3.0, int)` 为假，而 `3.0 in {3}` 和 `3.0 in [3]` 都是 `True`。我把它修得比 `dict` 和 `set` 更严格了（修一个边界，顺手造出半个新边界），这是修复的副作用，也是仓库里的一个缺口，练习 3 请你定夺。

pyright 抱怨的另一处是三个运算符。`__and__(self, other: PostingList)` 的第一行是 `if not isinstance(other, PostingList): return NotImplemented`，这是数据模型的规矩（遇到不认识的操作数，返回 `NotImplemented`，让 Python 去试对方的反向方法），而注解说 `other` 一定是 `PostingList`，pyright 的 `reportUnnecessaryIsInstance` 就说这个判断永远为真。要么删守卫，要么放宽注解；删守卫会让 `plist & {1}` 在运行时变成 `AttributeError`，不如放宽：

```diff
--- a/src/sift/index.py
+++ b/src/sift/index.py
@@ -91,3 +93,3 @@ class PostingList:
 
-    def __and__(self, other: PostingList) -> PostingList:
+    def __and__(self, other: object) -> PostingList:
         """Return the documents found in both lists."""
```

另外两个运算符（`__or__`、`__sub__`）是同样的改动。代价我也测了：`other: object` 之后，检查器不再拦 `plist & {1}`：

```python
"""Use & on a PostingList with something that is not a PostingList."""

from sift.index import Posting, PostingList


def main() -> None:
    """Intersect a PostingList with a set of ints."""
    postings = PostingList([Posting(1, (0,))])
    try:
        print(postings & {1})  # BAD: a set is not a PostingList
    except TypeError as exc:
        print(f"TypeError: {exc}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/operator_object.py
TypeError: unsupported operand type(s) for &: 'PostingList' and 'set'
$ mypy /tmp/sift-scratch/operator_object.py
Success: no issues found in 1 source file
$ MYPYPATH=/tmp/sift-scratch/first/src mypy --python-executable python3 \
    /tmp/sift-scratch/operator_object.py | grep operator_object
operator_object.py:10: error: Unsupported operand types for & ("PostingList" and "set[int]")  [operator]
```

第三条命令用 ch13 的源码检查同一个脚本，`grep` 滤掉了 ch13 自己的 3 条报错（`document.py:89`、`index.py:79`、`index.py:80`）：它说 `Unsupported operand types for & ("PostingList" and "set[int]")`；在 ch14 里它安静地通过了，运行时的 `TypeError` 却一模一样。这是放宽注解的真实代价：运算符的类型安全从静态检查退回成运行时检查。`tests/test_index.py` 里为此写的 3 个 `# type: ignore[operator]` 因此删掉了，`src` 里一个 `# type: ignore` 也没有。

### 其余几条

`document.py:89` 只有 mypy 报告。原来的 `tags = meta.get("tags", [])` 把 `tags` 推断成 `list[str]`，再 `tags = [tags]` 给它绑一个 `list[str | int]`。换一个名字 `raw_tags` 保留原始类型，`tuple(map(str, tags))` 照旧把任何标量转成字符串，行为没变：

```diff
--- a/src/sift/document.py
+++ b/src/sift/document.py
@@ -86,5 +86,4 @@ class Document:
         updated = _optional_str(meta, "updated")
-        tags = meta.get("tags", [])
-        if not isinstance(tags, list):
-            tags = [tags]
+        raw_tags = meta.get("tags", [])
+        tags = raw_tags if isinstance(raw_tags, list) else [raw_tags]
         return cls(
```

`segment.py:169` 两个检查器都报（上面 hook 里的 mypy 输出就是它的原文），修法却在另一个文件里。

`segment.py` 写出文件前把 `header`、`lengths`、`dictionary`、`postings` 放进一个列表，其中两项是 `bytearray`，而 `atomic_write` 声明的是 `Iterable[bytes]`。mypy 2.1.0 默认开着 `--strict-bytes`，`mypy --help` 里只列出关掉它的那个开关：

```text
$ mypy --help | grep -A1 -e '--no-strict-bytes'
  --no-strict-bytes         Treat bytearray and memoryview as subtypes of
                            bytes (inverse: --strict-bytes)
```

于是 `bytearray` 不再被当成 `bytes` 的子类型，pyright 在同一行也报了一条（见上面 `segment.py` 的计数）。`tmp.write(chunk)` 本来就接收任何支持缓冲区协议的对象，所以正确的类型是 3.12 的 `collections.abc.Buffer` ([PEP 688](https://peps.python.org/pep-0688/))：

```diff
--- a/src/sift/storage/atomic.py
+++ b/src/sift/storage/atomic.py
@@ -4,3 +4,3 @@ import os
 import tempfile
-from collections.abc import Iterable
+from collections.abc import Buffer, Iterable
 from pathlib import Path
@@ -8,3 +8,3 @@ from pathlib import Path
 
-def atomic_write(path: Path, chunks: Iterable[bytes]) -> None:
+def atomic_write(path: Path, chunks: Iterable[Buffer]) -> None:
     """Replace path with the concatenated chunks, all or nothing.
```

`config.py` 是 pyright 的 8 条。`section = data.get(name, {})` 来自 `dict[str, Any]`，`isinstance(section, dict)` 把它窄化成 `dict[Unknown, Unknown]`；TOML 字典来自 `tomllib`，值本来就是 `Any`，所以这里的 `cast` 是诚实的：`isinstance` 已经证明它是字典，键是字符串由 TOML 规范保证。这一处 `cast` 解决了第 37 到 42 行的 5 条；`pipeline` 那一处（第 90 和 109 行共 3 条）写成了 `TypeIs`：

```diff
--- a/src/sift/config.py
+++ b/src/sift/config.py
@@ -33,5 +33,6 @@ def _section(
     """Return data[name] after checking that it only has known keys."""
-    section = data.get(name, {})
-    if not isinstance(section, dict):
+    found: object = data.get(name, {})
+    if not isinstance(found, dict):
         raise ConfigError(f"{path}: [{name}] must be a table")
+    section = cast("dict[str, Any]", found)
     unknown = sorted(set(section) - keys)
@@ -44,2 +45,10 @@ def _section(
 
+def _is_str_list(value: object) -> TypeIs[list[str]]:
+    """Return True if value is a list that holds only strings."""
+    if not isinstance(value, list):
+        return False
+    items = cast("list[object]", value)
+    return all(isinstance(item, str) for item in items)
+
+
 def _number(
@@ -86,7 +95,3 @@ def load_config(path: Path | None = None) -> Config:
     names = analysis.get("pipeline", list(default.pipeline))
-    if (
-        not isinstance(names, list)
-        or not names
-        or not all(isinstance(name, str) for name in names)
-    ):
+    if not _is_str_list(names) or not names:
         raise ConfigError(
```

`_is_str_list` 里还有一次 `cast("list[object]", value)`，因为 `isinstance(value, list)` 只能窄化成 `list[Unknown]`；这就是 `src` 里仅有的两处 `cast`。

`log.py` 里，typeshed 把 `getLevelName(level: str)` 标成 `@deprecated("The str -> int case is considered a mistake.")` 并让它返回 `Any`（[pyright 1.1.412 自带的 `logging/__init__.pyi` 第 558 到 562 行](https://github.com/microsoft/pyright/blob/1.1.412/packages/pyright-internal/typeshed-fallback/stdlib/logging/__init__.pyi#L558-L562)），3.11 起有 `getLevelNamesMapping()`，直接返回 `dict[str, int]`：

```diff
--- a/src/sift/log.py
+++ b/src/sift/log.py
@@ -21,2 +21,2 @@ def setup_logging(level: str = "WARNING", *, rich: bool = False) -> None:
-    number = logging.getLevelName(level.upper())
-    if not isinstance(number, int):
+    number = logging.getLevelNamesMapping().get(level.upper())
+    if number is None:
```

`manifest.py` 里 `default_factory=dict` 对 pyright 是 `dict[Unknown, Unknown]`，参数化的泛型别名被调用时仍然创建普通的 `dict`（`type(dict[str, int]())` 在 3.14.7 里是 `<class 'dict'>`）：

```diff
--- a/src/sift/storage/manifest.py
+++ b/src/sift/storage/manifest.py
@@ -34 +34 @@ class Manifest:
-    files: dict[str, FileEntry] = field(default_factory=dict)
+    files: dict[str, FileEntry] = field(default_factory=dict[str, FileEntry])
```

`db.py` 里，pyright 自带的 typeshed 给 `contextmanager` 加了一个重载（[`contextlib.pyi` 第 87 到 93 行](https://github.com/microsoft/pyright/blob/1.1.412/packages/pyright-internal/typeshed-fallback/stdlib/contextlib.pyi#L87-L93)），函数被标注为 `-> Iterator[Foo]` 时发出弃用警告，建议 `Generator[Foo]`：

```diff
--- a/src/sift/storage/db.py
+++ b/src/sift/storage/db.py
@@ -188 +194 @@ def open_db(path: Path) -> sessionmaker[Session]:
-def session_scope(path: Path) -> Iterator[Session]:
+def session_scope(path: Path) -> Generator[Session]:
```

`Generator` 的第二、第三个类型参数从 3.13 起默认是 `None`，所以单参数写法合法，我在 3.14.7 里确认了它能构造：

```text
$ python3 -c 'from collections.abc import Generator; print(Generator[int])'
collections.abc.Generator[int]
```

mypy 自带的 `contextlib.pyi` 里 `contextmanager` 只有一个签名（[第 89 行](https://github.com/python/mypy/blob/v2.1.0/mypy/typeshed/stdlib/contextlib.pyi#L89)），所以这一条 mypy 看不到。

### 修完以后

两个检查器都说干净，测试还在，从 489 个涨到 505 个（`tests/test_cache.py` 13 个，`test_index.py` 1 个，`test_search.py` 2 个）：

```text
$ make typecheck
mypy && pyright
Success: no issues found in 34 source files
0 errors, 0 warnings, 0 informations
```

```text
$ python3 -m pytest 2>&1 | tail -1
505 passed, 1 xfailed in 11.20s
```

42 条抱怨里，我只愿意把 3 件事叫真问题：`Searcher` 的签名撒谎（4 条记录，其实是同一件事），`__contains__` 对非整数抛 `TypeError`（2 条），`atomic_write` 的 `bytes` 太窄（3 条）。其余 33 条都是“我没说清楚”：16 个空列表、8 个 `Unknown`、3 个多余的 `isinstance`，和 6 条改名、重新绑定和弃用的小事。只有 `__contains__` 一处行为变了，修的基本都是标签。

## 两个检查器，一份分歧清单

mypy 的 9 条里有 5 条 pyright 没说（`bisect_left` 两条、`error` 两条、`tags` 一条），pyright 的 33 条里有 30 条 mypy 没说。我把几种分歧收在一个脚本里：

```python
# pyright: strict
"""Compare four snippets where mypy --strict and pyright disagree."""

from bisect import bisect_left
from dataclasses import dataclass
from operator import attrgetter


@dataclass(frozen=True)
class Posting:
    """A document id with a term frequency."""

    doc_id: int
    tf: int


def find(postings: list[Posting], doc_id: object) -> int:
    """Return the insertion point of doc_id (sorted by doc_id)."""
    return bisect_left(postings, doc_id, key=attrgetter("doc_id"))


def empty_list() -> int:
    """Fill an empty list literal with append."""
    seconds = []
    seconds.append(1.5)
    return len(seconds)


def known_type(posting: Posting) -> bool:
    """Test a value whose type is already Posting."""
    return isinstance(posting, Posting)


def reuse_name() -> None:
    """Reuse the name that an except clause bound."""
    try:
        int("x")
    except ValueError as error:
        print(error)
    error = "ok"
    print(error)


def main() -> None:
    """Call every snippet once."""
    print(find([Posting(1, 2), Posting(3, 1)], 3), empty_list())
    print(known_type(Posting(1, 1)))
    reuse_name()


if __name__ == "__main__":
    main()
```

第一行的 `# pyright: strict` 让 pyright 对这个文件开严格模式，mypy 的严格模式来自仓库配置；mypy 的输出里我滤掉了 `bisect_left` 的 6 行重载清单：

```text
$ python3 /tmp/sift-scratch/disagree/disagree.py
1 1
True
invalid literal for int() with base 10: 'x'
ok
$ mypy /tmp/sift-scratch/disagree/disagree.py | grep -v ':     def'
disagree/disagree.py:19: error: Returning Any from function declared to return "int"  [no-any-return]
disagree/disagree.py:19: error: No overload variant of "bisect_left" matches argument types "list[Posting]", "object", "attrgetter[Any]"  [call-overload]
disagree/disagree.py:19: note: Possible overload variants:
disagree/disagree.py:40: error: Assignment to variable "error" outside except: block  [misc]
disagree/disagree.py:41: error: Trying to read deleted variable "error"  [misc]
Found 4 errors in 1 file (checked 1 source file)
$ mypy --warn-unreachable /tmp/sift-scratch/disagree/disagree.py | grep -c unreachable
0
$ pyright /tmp/sift-scratch/disagree/disagree.py
disagree/disagree.py
  disagree/disagree.py:25:5 - error: Type of "append" is partially unknown
    Type of "append" is "(object: Unknown, /) -> None" (reportUnknownMemberType)
  disagree/disagree.py:26:16 - error: Argument type is partially unknown
    Argument corresponds to parameter "obj" in function "len"
    Argument type is "list[Unknown]" (reportUnknownArgumentType)
  disagree/disagree.py:31:12 - error: Unnecessary isinstance call; "Posting" is always an instance of "Posting" (reportUnnecessaryIsInstance)
3 errors, 0 warnings, 0 informations
```

四个分歧点：

- `bisect_left`：只有 mypy 在 `object` 上抱怨。这是个真缺陷，pyright 却没说；我猜是因为 `attrgetter[Any]` 的返回值是 `Any`，pyright 求解 `SupportsRichComparisonT` 时没有再拿 `object` 去对它，但我没读 pyright 的求解过程，这只是猜测。
- 空列表：只有 pyright strict 抱怨。
- `isinstance(posting, Posting)` 永远为真：只有 pyright strict 抱怨，mypy 对这一行沉默，加 `--warn-unreachable` 也一样（上面输出里那条 `grep -c unreachable` 数到 0 行）。
- `except ... as error` 之后复用名字：只有 mypy 抱怨。

再加上前面看过的三处：`[1, "x"]` 的推断，`TypeVarTuple` 的长度检查（只有 pyright 抱怨），协议不匹配时 pyright 会逐个列出缺的成员（`bad_types.py` 的输出里有 `"title" is not present`）。我的用法是两个都放进 `make typecheck`，因为它们各自抓到了对方放过的东西。

### 要多久

我让它们轮流跑 7 轮：每轮先删掉 `.mypy_cache` 测 mypy 冷缓存，立刻再测一次热缓存，然后测 pyright。仓库的一份干净拷贝 (`git archive ch14`) 放在 `/tmp/sift-scratch/ch14tree`：

```python
"""Time mypy (cold and warm cache) and pyright, taking turns."""

import shutil
import statistics
import subprocess
import time
from pathlib import Path

ROOT = Path("/tmp/sift-scratch/ch14tree")
ROUNDS = 7


def run(cmd: list[str]) -> float:
    """Return the wall milliseconds of cmd, which must exit 0."""
    start = time.perf_counter()
    subprocess.run(cmd, cwd=ROOT, check=True, capture_output=True)
    return (time.perf_counter() - start) * 1000


def main() -> None:
    """Alternate mypy cold, mypy warm and pyright for ROUNDS rounds."""
    times: dict[str, list[float]] = {
        "mypy cold": [],
        "mypy warm": [],
        "pyright": [],
    }
    for _ in range(ROUNDS):
        shutil.rmtree(ROOT / ".mypy_cache", ignore_errors=True)
        times["mypy cold"].append(run(["mypy"]))
        times["mypy warm"].append(run(["mypy"]))
        times["pyright"].append(run(["pyright"]))
    for name, values in times.items():
        print(
            f"{name:<10} min {min(values):7.0f}  "
            f"median {statistics.median(values):7.0f}  "
            f"max {max(values):7.0f} ms"
        )


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/cpu_state.py; \
    python3 /tmp/sift-scratch/typecheck_time.py; \
    python3 /tmp/sift-scratch/cpu_state.py
115 117 114 114 115 ms
mypy cold  min    4749  median    4843  max    4913 ms
mypy warm  min     166  median     171  max     172 ms
pyright    min    2218  median    2291  max    2351 ms
114 114 114 114 114 ms
```

mypy 冷缓存 4843 ms（中位数），热缓存 171 ms，pyright 2291 ms，34 个文件。热缓存快 28 倍：mypy 把每个模块的分析结果存在 `.mypy_cache`，没改动的直接加载。pyright 的 7 轮在 2218 到 2351 ms 之间，没有冷热之分，比 mypy 的冷缓存快约 2.1 倍。前后两次 `cpu_state.py` 都在 110 到 120 ms，快状态。`make typecheck` 是 `mypy && pyright`，热缓存时的开销是两者之和：$171 + 2291 \approx 2.5$ 秒。

## LRUCache：新加的缓存有用吗

ch14 的最后一个源码改动是 `src/sift/cache.py`，一个用 PEP 695 写的 `LRUCache[K, V]`，`Searcher` 用它缓存“查询里的一个词分析出来的索引项”：

```python
# ...
class LRUCache[K, V]:
    """Keep the maxsize most recently used entries.

    A read or a write moves the key to the fresh end of an
    OrderedDict; when the cache is full, the key at the stale end is
    evicted. ``hits`` and ``misses`` count the lookups made through
    ``get``, ``__getitem__`` and ``get_or_set``. Not thread-safe:
    lookups and evictions are several steps, so guard it with a lock
    if threads share one cache.
    """

    def __init__(self, maxsize: int) -> None:
        """Create an empty cache; maxsize must be at least 1."""
        if maxsize < 1:
            raise ValueError(f"maxsize must be at least 1, got {maxsize}")
        self.maxsize = maxsize
        self.hits = 0
# ...
```

类名后面的 `[K, V]` 是 PEP 695 语法。实现是 `OrderedDict` 加 `move_to_end`：读或写都把键挪到“新”的一端，满了就从“旧”的一端 `popitem(last=False)`。`get_or_set` 值得多看一眼，它的第一版有一个经典的坑：在 `except KeyError:` 里调用 `make(key)`，于是 `make` 自己抛出的异常会带着一条“During handling of the above exception”的 `KeyError` 链，指向一个和它无关的缓存未命中。现在的写法先 `key in self._data` 判断，`make` 在任何 `except` 之外运行，失败了什么都不缓存。类的文档也写明了它不是线程安全的：查找和淘汰是好几步，几个线程共用一个缓存要自己加锁。

```python
# ...
    def get_or_set(self, key: K, make: Callable[[K], V]) -> V:
        """Return the value of key, computing make(key) on a miss.

        A cached None is a hit; only an absent key calls make. If make
        raises, the exception propagates as is and nothing is cached.
        """
        if key in self._data:
            return self[key]
        self.misses += 1
        value = make(key)
        self[key] = value
        return value
# ...
```

`Searcher` 里的用法：

```diff
--- a/src/sift/search.py
+++ b/src/sift/search.py
@@ -79,2 +82,9 @@ class Searcher:
         self.pipeline = pipeline or build_pipeline()
+        self.term_cache = LRUCache[str, tuple[str, ...]](cache_size)
+
+    def _terms(self, text: str) -> tuple[str, ...]:
+        """Return the index terms of a query word, cached."""
+        return self.term_cache.get_or_set(
+            text, lambda word: tuple(self.pipeline.terms(word))
+        )
 
```

这个缓存管用吗？我先怀疑过：`pipeline.terms(word)` 只做 NFKC、折叠大小写和去停用词，是微秒级的操作，而 `search` 里最贵的是给每个命中建摘要（第 8 篇量过，占 99.6%）。我写了一个脚本量三件事：重复跑 `bench/queries.txt` 的 12 条查询看命中率；单个词命中和未命中各花多少微秒；12 条查询在有缓存和没缓存的 `Searcher` 上各花多少毫秒，轮流跑 15 轮，每轮里两者的先后顺序交替：

```python
"""Measure what the LRU cache of Searcher saves, taking turns."""

import statistics
import time
from pathlib import Path

from sift.analysis import build_pipeline
from sift.search import Searcher
from sift.storage.store import open_index

ROUNDS = 15
QUERIES = [
    line
    for line in Path("bench/queries.txt").read_text("utf-8").splitlines()
    if line
]


class Uncached(Searcher):
    """A Searcher that analyzes every query word again."""

    def _terms(self, text: str) -> tuple[str, ...]:
        """Return the index terms of a query word, never cached."""
        return tuple(self.pipeline.terms(text))


def run_all(searcher: Searcher) -> float:
    """Return the milliseconds of every bench query in a row."""
    start = time.perf_counter()
    for query in QUERIES:
        searcher.search(query, 10)
    return (time.perf_counter() - start) * 1000


def per_call(searcher: Searcher, word: str) -> tuple[float, float]:
    """Return (miss, hit) microseconds of _terms for one word."""
    start = time.perf_counter()
    for _ in range(1000):
        searcher.term_cache.clear()
        searcher._terms(word)
    miss = (time.perf_counter() - start) / 1000
    start = time.perf_counter()
    for _ in range(1000):
        searcher._terms(word)
    hit = (time.perf_counter() - start) / 1000
    return miss * 1e6, hit * 1e6


def main() -> None:
    """Print hit rates, per-call costs and whole-benchmark times."""
    with open_index(Path(".sift")) as index:
        pipeline = build_pipeline(index.pipeline_names)
        cached = Searcher(index, pipeline=pipeline)
        plain = Uncached(index, pipeline=pipeline)
        run_all(cached)
        cache = cached.term_cache
        print(
            f"pass 1: {cache.misses} misses, {cache.hits} hits, "
            f"hit rate {cache.hit_rate:.2f}, {len(cache)} entries"
        )
        for _ in range(19):
            run_all(cached)
        print(
            f"pass 20: {cache.misses} misses, {cache.hits} hits, "
            f"hit rate {cache.hit_rate:.2f}"
        )
        miss, hit = per_call(cached, "kalman")
        print(f"_terms('kalman'): miss {miss:.1f} us, hit {hit:.2f} us")
        times: dict[str, list[float]] = {"cached": [], "uncached": []}
        for i in range(ROUNDS):
            pair = [("cached", cached), ("uncached", plain)]
            for name, searcher in pair[:: 1 if i % 2 == 0 else -1]:
                times[name].append(run_all(searcher))
        for name, values in times.items():
            print(
                f"{name:<9} 12 queries: min {min(values):6.1f}  "
                f"median {statistics.median(values):6.1f} ms"
            )


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/cpu_state.py; \
    python3 /tmp/sift-scratch/lru_effect.py; \
    python3 /tmp/sift-scratch/cpu_state.py
112 113 112 114 115 ms
pass 1: 21 misses, 0 hits, hit rate 0.00, 21 entries
pass 20: 21 misses, 399 hits, hit rate 0.95
_terms('kalman'): miss 2.7 us, hit 0.28 us
cached    12 queries: min  979.1  median  989.4 ms
uncached  12 queries: min  982.9  median  987.0 ms
113 114 114 114 114 ms
```

- 第一遍 12 条查询里有 21 个不同的词，21 次未命中、0 次命中；跑满 20 遍后命中 399 次，命中率 $399 / 420 = 0.95$。
- 单个词 `kalman`：未命中 2.7 µs（算一遍并写入），命中 0.28 µs，差约 10 倍。
- 但 12 条查询的总耗时，有缓存的是 989.4 ms（中位数，最小 979.1），没缓存的是 987.0 ms（最小 982.9），有缓存的中位数反而高 2.4 ms，最小值又低 3.8 ms，而每一组的中位数和最小值之间就差了 4 到 10 ms：看不出差别。

命中一次省 $2.7 - 0.28 \approx 2.4$ µs，20 遍共省 $399 \times 2.4 \approx 1.0$ ms，而 20 遍总共花了约 20 秒，占 0.006%。**这个缓存在这个工作负载上没有帮助。**更糟的是，`sift search` 一个进程只跑一条查询，缓存永远是空的，命中率是 0；只有长期存活的 `Searcher`（比如第 17、18 篇的服务器）里重复的词才会命中，省下的也是微秒。我保留了这个类（今天删代码的勇气不够），因为它是 PEP 695 泛型最干净的一个落点，但不会说它让 Sift 变快了。要让 `search` 真的变快，缓存的对象应该是摘要（`make_snippet` 的结果），这是练习 2。

## 运行时的注解：3.14 的 annotationlib

3.14 之前，`def f(x: Missing)` 在 `Missing` 还没定义的时候会直接 `NameError`，所以要写成字符串 `"Missing"`，或者 `from __future__ import annotations`。3.14 实现了 [PEP 649](https://peps.python.org/pep-0649/) 和 [PEP 749](https://peps.python.org/pep-0749/)：注解不在定义时求值，而是编译成 `__annotate__` 函数，第一次读 `__annotations__` 才调用，参数 `format` 决定怎么求值。标准库里读它的新模块是 [`annotationlib`](https://github.com/python/cpython/blob/v3.14.7/Lib/annotationlib.py)：`Format` 枚举（[第 22 到 27 行](https://github.com/python/cpython/blob/v3.14.7/Lib/annotationlib.py#L22-L27)）有四个成员，`VALUE`（1，真求值）、`VALUE_WITH_FAKE_GLOBALS`（2，我猜是给 `annotationlib` 自己用的，没细读）、`FORWARDREF`（3，读不到的名字换成占位符）和 `STRING`（4，返回源码文本），入口是 [`get_annotations`](https://github.com/python/cpython/blob/v3.14.7/Lib/annotationlib.py#L928)。`lab/ch14/runtime_annotations.py` 里的 `Node` 提到了自己和后面才定义的 `Weight`，`main()` 把四种读法都试一遍：

```python
# ...
def main() -> None:
    """Read annotations in each format; call with a wrong type."""
    print(annotationlib.get_annotations(double))
    print(annotationlib.get_annotations(Node, format=Format.STRING))
    print(annotationlib.get_annotations(Node, format=Format.FORWARDREF))
    print(get_type_hints(Node))
    print(double.__annotations__)
    print(double(cast("int", "ab")))  # cast tells the checker a lie
    node = Node()
    node.weight = cast("Weight", "heavy")
    print(node.weight)
# ...
```

```text
$ python3 lab/ch14/runtime_annotations.py
{'x': <class 'int'>, 'return': <class 'int'>}
{'parent': 'Node | None', 'weight': 'Weight'}
{'parent': __main__.Node | None, 'weight': <class '__main__.Weight'>}
{'parent': __main__.Node | None, 'weight': <class '__main__.Weight'>}
{'x': <class 'int'>, 'return': <class 'int'>}
abab
heavy
```

`STRING` 把注解还原成源码文本 `'Node | None'` 和 `'Weight'`，`FORWARDREF` 和 `get_type_hints` 都把它们解析成真正的类（读的时候 `Weight` 已经存在，所以没有占位符）。倒数第二行是整个实验的主题：`double(cast("int", "ab"))` 返回 `abab`，`cast` 对解释器什么都不做（[`typing.cast`](https://github.com/python/cpython/blob/v3.14.7/Lib/typing.py#L2308-L2316) 就是 `return val`），`node.weight = cast("Weight", "heavy")` 之后 `node.weight` 就是字符串 `heavy`。

“`Weight` 还不存在的时候读”是怎样？这是 `runtime_annotations.py` 没演示的，我另写了一个脚本，在 `Missing` 定义之前读一次，之后再读一次，并让 dataclass 接收一个错误类型的值：

```python
"""Show that 3.14 defers annotations and that nothing enforces them."""

import annotationlib
from annotationlib import Format
from dataclasses import dataclass


def late(x: Missing) -> int:
    """Use a class that is defined further down."""
    return 1


def read_early() -> str:
    """Read late's annotations while Missing does not exist yet."""
    try:
        # error: NameError: name 'Missing' is not defined
        return str(late.__annotations__)
    except NameError as exc:
        return f"NameError: {exc}"


EARLY = read_early()


class Missing:
    """Defined after late: the name resolves when asked for."""


@dataclass
class Counter:
    """A dataclass whose field types are only hints."""

    n: int


def main() -> None:
    """Read late's annotations before and after Missing exists."""
    print("late(Missing()) =", late(Missing()))
    print("before Missing:", EARLY)
    print(annotationlib.get_annotations(late, format=Format.STRING))
    print(annotationlib.get_annotations(late, format=Format.FORWARDREF))
    print("after Missing:", late.__annotations__)
    counter = Counter("seven")  # BAD: n is declared int
    print(counter, isinstance(counter.n, int))


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/sift-scratch/lazy_annotations.py
late(Missing()) = 1
before Missing: NameError: name 'Missing' is not defined
{'x': 'Missing', 'return': 'int'}
{'x': <class '__main__.Missing'>, 'return': <class 'int'>}
after Missing: {'x': <class '__main__.Missing'>, 'return': <class 'int'>}
Counter(n='seven') False
```

`def late(x: Missing)` 执行成功（`Missing` 尚未存在），`late(Missing())` 正常运行；在 `Missing` 定义之前读 `late.__annotations__` 得到 `NameError: name 'Missing' is not defined`（`EARLY` 是在模块加载时读的）；`STRING` 格式在任何时候都能读，`FORWARDREF` 在 `Missing` 存在之后读，已经解析成类。最后一行再次证明：`Counter("seven")` 创建成功，`n` 是字符串，`isinstance(counter.n, int)` 为 `False`，dataclass 完全不查类型。前面 `type_checking.py` 里的 `ForwardRef('InvertedIndex', owner=...)` 就是 `FORWARDREF` 格式留下的占位符，和这里是同一套机制。

运行时要强制类型，得用别的东西：`pydantic` 在构造时验证（第 18 篇），`typeguard` 和 `beartype` 用装饰器包起来检查，`dataclass` 本身不会。注解是静态工具链的数据，运行时的框架（pydantic、FastAPI，还有第 19 篇的 typer）靠 `annotationlib` 和 `get_type_hints` 去读它们，检查是它们自己另外实现的。


## 本篇文件

这一章动了 34 个文件（`git diff --shortstat ch13 ch14`：`34 files changed, 1286 insertions(+), 56 deletions(-)`）。`/tmp/sift-scratch/` 里的脚本不进仓库，不在表里。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`Makefile`](https://github.com/bfmhno3/sift/blob/ch14/Makefile) | `make typecheck \| tail -1` | 输出 `0 errors, 0 warnings, 0 informations` |
| [`README.md`](https://github.com/bfmhno3/sift/blob/ch14/README.md) | `git diff --shortstat ch13 ch14 -- README.md` | 退出码 0，`2 insertions(+), 1 deletion(-)` |
| [`pyproject.toml`](https://github.com/bfmhno3/sift/blob/ch14/pyproject.toml) | `python3 -c 'import tomllib; print(tomllib.load(open("pyproject.toml", "rb"))["tool"]["mypy"])'` | 退出码 0，输出 `{'strict': True, 'python_version': '3.14', 'files': ['src'], 'mypy_path': 'src'}` |
| [`py.typed`](https://github.com/bfmhno3/sift/blob/ch14/src/sift/py.typed) | `wc -c src/sift/py.typed` | 退出码 0，输出 `0 src/sift/py.typed` |
| [`cache.py`](https://github.com/bfmhno3/sift/blob/ch14/src/sift/cache.py) | `python3 -m pytest tests/test_cache.py \| tail -1` | `13 passed` |
| [`cli.py`](https://github.com/bfmhno3/sift/blob/ch14/src/sift/cli.py) | `git diff --shortstat ch13 ch14 -- src/sift/cli.py` | 退出码 0，`4 insertions(+), 4 deletions(-)` |
| [`config.py`](https://github.com/bfmhno3/sift/blob/ch14/src/sift/config.py) | `git diff --shortstat ch13 ch14 -- src/sift/config.py` | 退出码 0，`13 insertions(+), 8 deletions(-)` |
| [`document.py`](https://github.com/bfmhno3/sift/blob/ch14/src/sift/document.py) | `git diff --shortstat ch13 ch14 -- src/sift/document.py` | 退出码 0，`2 insertions(+), 3 deletions(-)` |
| [`index.py`](https://github.com/bfmhno3/sift/blob/ch14/src/sift/index.py) | `git diff --shortstat ch13 ch14 -- src/sift/index.py` | 退出码 0，`52 insertions(+), 6 deletions(-)` |
| [`log.py`](https://github.com/bfmhno3/sift/blob/ch14/src/sift/log.py) | `git diff --shortstat ch13 ch14 -- src/sift/log.py` | 退出码 0，`2 insertions(+), 2 deletions(-)` |
| [`evaluate.py`](https://github.com/bfmhno3/sift/blob/ch14/src/sift/query/evaluate.py) | `git diff --shortstat ch13 ch14 -- src/sift/query/evaluate.py` | 退出码 0，`11 insertions(+), 13 deletions(-)` |
| [`search.py`](https://github.com/bfmhno3/sift/blob/ch14/src/sift/search.py) | `git diff --shortstat ch13 ch14 -- src/sift/search.py` | 退出码 0，`18 insertions(+), 8 deletions(-)` |
| [`atomic.py`](https://github.com/bfmhno3/sift/blob/ch14/src/sift/storage/atomic.py) | `git diff --shortstat ch13 ch14 -- src/sift/storage/atomic.py` | 退出码 0，`2 insertions(+), 2 deletions(-)` |
| [`db.py`](https://github.com/bfmhno3/sift/blob/ch14/src/sift/storage/db.py) | `git diff --shortstat ch13 ch14 -- src/sift/storage/db.py` | 退出码 0，`8 insertions(+), 2 deletions(-)` |
| [`manifest.py`](https://github.com/bfmhno3/sift/blob/ch14/src/sift/storage/manifest.py) | `git diff --shortstat ch13 ch14 -- src/sift/storage/manifest.py` | 退出码 0，`1 insertion(+), 1 deletion(-)` |
| [`test_cache.py`](https://github.com/bfmhno3/sift/blob/ch14/tests/test_cache.py) | `python3 -m pytest tests/test_cache.py \| tail -1` | `13 passed` |
| [`test_index.py`](https://github.com/bfmhno3/sift/blob/ch14/tests/test_index.py) | `python3 -m pytest tests/test_index.py \| tail -1` | `23 passed` |
| [`test_search.py`](https://github.com/bfmhno3/sift/blob/ch14/tests/test_search.py) | `python3 -m pytest tests/test_search.py \| tail -1` | `15 passed` |
| [`reveal_types.py`](https://github.com/bfmhno3/sift/blob/ch14/lab/ch14/reveal_types.py) | `python3 lab/ch14/reveal_types.py` | 退出码 0，标准错误 16 行，第一行 `Runtime type is 'int'`，最后一行 `Runtime type is 'list'` |
| [`generics_695.py`](https://github.com/bfmhno3/sift/blob/ch14/lab/ch14/generics_695.py) | `python3 lab/ch14/generics_695.py` | 退出码 0，第一行 `1 sift 0`，最后一行 `tuple[A, B] (T,)` |
| [`variance.py`](https://github.com/bfmhno3/sift/blob/ch14/lab/ch14/variance.py) | `python3 lab/ch14/variance.py` | 退出码 0，第一行 `dog`，最后一行 `dog` |
| [`protocols_typed.py`](https://github.com/bfmhno3/sift/blob/ch14/lab/ch14/protocols_typed.py) | `python3 lab/ch14/protocols_typed.py` | 退出码 0，第一行 `11.795 1.0`，最后一行 `[True, False]` |
| [`typeddict_literal.py`](https://github.com/bfmhno3/sift/blob/ch14/lab/ch14/typeddict_literal.py) | `python3 lab/ch14/typeddict_literal.py` | 退出码 0，第一行 `{"doc_id": 1, "title": "tea", "score": 1.5} dict`，最后一行 `['limit', 'mode', 'tag']` |
| [`paramspec.py`](https://github.com/bfmhno3/sift/blob/ch14/lab/ch14/paramspec.py) | `python3 lab/ch14/paramspec.py 2>/dev/null` | 退出码 0，第一行 `3`，最后一行 `SIFT`（标准错误里有 `add took 0.0 ms`） |
| [`overloads.py`](https://github.com/bfmhno3/sift/blob/ch14/lab/ch14/overloads.py) | `python3 lab/ch14/overloads.py 2>/dev/null` | 退出码 0，第一行 `True True`，最后一行 `(2, 1.5) [(2, 1.5), (3, 1.0)]` |
| [`narrowing.py`](https://github.com/bfmhno3/sift/blob/ch14/lab/ch14/narrowing.py) | `python3 lab/ch14/narrowing.py` | 退出码 0，第一行 `0 3 2`，最后一行 `(rust AND NOT "a b")` |
| [`newtype_annotated.py`](https://github.com/bfmhno3/sift/blob/ch14/lab/ch14/newtype_annotated.py) | `python3 lab/ch14/newtype_annotated.py` | 退出码 0，第一行 `doc-7 int True`，最后一行 `typing.Annotated[int, Gt(bound=0)]`（第三行 `limit=0:  ['limit=0 must be > 0']`） |
| [`self_type.py`](https://github.com/bfmhno3/sift/blob/ch14/lab/ch14/self_type.py) | `python3 lab/ch14/self_type.py 2>/dev/null` | 退出码 0，输出 `rust AND lifetime AND borrow QueryBuilder` |
| [`runtime_annotations.py`](https://github.com/bfmhno3/sift/blob/ch14/lab/ch14/runtime_annotations.py) | `python3 lab/ch14/runtime_annotations.py` | 退出码 0，第一行 `{'x': <class 'int'>, 'return': <class 'int'>}`，最后一行 `heavy` |
| [`bad_types.py`](https://github.com/bfmhno3/sift/blob/ch14/lab/ch14/bad_types.py) | `python3 lab/ch14/bad_types.py` | 退出码 0，第一行 `abab`，最后一行 `AttributeError: 'NoTitle' object has no attribute 'title'` |
| [`extra.sh`](https://github.com/bfmhno3/sift/blob/ch14/lab/ch14/extra.sh) | `bash lab/ch14/extra.sh \| tail -1` | 输出 `6 errors, 0 warnings, 0 informations`（脚本内部要求两个检查器对 `bad_types.py` 都退出 1） |
| [`__init__.py`](https://github.com/bfmhno3/sift/blob/ch14/lab/ch14/legacy/__init__.py) | `wc -c lab/ch14/legacy/__init__.py` | 退出码 0，输出 `0 lab/ch14/legacy/__init__.py` |
| [`scores.py`](https://github.com/bfmhno3/sift/blob/ch14/lab/ch14/legacy/scores.py) | `cd lab/ch14 && python3 -c 'from legacy.scores import normalize; print(normalize({1: 2.0, 2: 4.0}, top=1))'` | 退出码 0，输出 `[(2, 1.0)]` |
| [`scores.pyi`](https://github.com/bfmhno3/sift/blob/ch14/lab/ch14/legacy/scores.pyi) | `mypy lab/ch14/legacy/scores.pyi` | 退出码 0，输出 `Success: no issues found in 1 source file` |

## 练习

**1.** 把 `lab/ch14/variance.py` 里的 `Box[T]` 改成同时有 `get` 和 `set` 两个方法，先预测检查器对 `name_of(Box(Dog()))` 会说什么，再用 `mypy` 和 `pyright` 验证，看两者的报错措辞各点出了哪个类型参数。

**2.** 缓存的对象选错了。把缓存换成缓存 `make_snippet(doc.body, terms)` 的结果（键是 `(doc_id, frozenset(terms))`），再用 `lru_effect.py` 的做法重新量总耗时和命中率。256 项够不够？

**3.** `PostingList.__contains__` 现在对 `3.0` 说 `False`，而 `3.0 in {3}` 是 `True`。先写一个失败的测试，定下你认为正确的行为，再改实现，并让 `make typecheck` 继续通过。`True in plist` 应该是什么？

## 下一篇

下一篇是《对象模型与元编程：描述符、元类、字节码》。这一篇里 `config.py` 的两处 `cast` 是我最不放心的地方：它们是我告诉检查器“这里我比你清楚”的地方，而配置值的校验目前还是散落在 `_number` 和 `_section` 里的手写 `isinstance`。我想把校验收进一个描述符 `Setting[T]`，让 `config.k1` 在检查器眼里是 `float`、在运行时有范围检查；我猜这是 mypy 和 pyright 争得最凶的地方，因为描述符协议的 `__get__` 需要重载才能让类属性和实例属性有不同的类型。
