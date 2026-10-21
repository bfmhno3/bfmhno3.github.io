---
title: "函数：参数、作用域、闭包与装饰器"
commentId: "post:python-by-sift-04-functions"
published: "2026-10-22 04:00:00 +08:00"
description: "用 Sift 重学 Python 第 4 篇：我在 Python 3.14.7 里把分词拆成三个小函数再用 compose 接起来，给建索引挂上 timed 装饰器，用 functools.cache 缓存 idf，排序换成 TF-IDF；把函数当成对象拆开看，fib(30) 靠 functools.cache 从 261.4 ms 降到 0.067 ms，空闲机器上一次 Python 函数调用只多 12 到 18 ns，机器忙的时候这个数会翻几倍。"
category: Tutorial
tags:
  - Python
  - Sift
  - 函数
  - 闭包
  - 装饰器
  - functools
series: "用 Sift 重学 Python"
seriesOrder: 4
draft: false
comment: true
slug: python-by-sift-04-functions
---

我把同一个函数连续调用了两次，每次传一个不同的标签，两次拿回来的却是同一个列表，里面装着两个标签。这个函数没有全局变量，没有类，只有一个看上去人畜无害的 `tags=[]`：

```text
$ python3 lab/ch04/mutable_default.py
['a', 'b'] ['a', 'b']
(['a', 'b'],)
['a'] ['b']
(None,)
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch04`：新增 `src/sift/util.py`（`timed` 装饰器和 `compose`）和 `src/sift/scoring.py`（`tf_idf` 与带缓存的 `idf`）；`src/sift/__main__.py` 的排序从“词频之和”改成 TF-IDF，`load_index` 挂上 `timed`，每个文件的处理链改成 `compose`；`src/sift/analysis/tokenize.py` 拆成 `fold`、`find_runs`、`split_runs` 三个小函数再接起来。这四个文件之后的章节都还会改，没有哪个是终稿。`make ch04` 通过，`lab/ch04` 下 13 个文件按预期退出（10 个正常，3 个按预期失败）。
> 涉及的 Python 特性：函数对象与 `__code__`、`__defaults__`、全部参数种类、LEGB 与 `global`/`nonlocal`、闭包与 cell、`lambda`、高阶函数、装饰器（含带参数、叠放、类实现）、`functools`、`operator`、注解与 3.14 的延迟求值、递归与没有尾调用消除。
> 前置：[第 3 篇](/posts/python-by-sift-03-containers/)，需要会进 `nix develop`、读懂 `build_index` 返回的字典套字典。

答案不在列表里，在函数身上：`def` 是一条会执行的语句，它每执行一次就造出一个函数对象，默认值在那一刻算好、挂在这个对象上，之后每次调用都从那里取。这一篇我把函数当成对象拆开看，再回到 Sift：排序换成 TF-IDF，建索引的计时用装饰器，分词链用 `compose` 拼起来。先看最后的效果：

```text
$ python3 -m sift search kalman
load_index took 1325.3 ms
  19.570  corpus/posts/kalman-filter-02-multivariate.md
  16.775  corpus/posts/kalman-filter-01-one-dimension.md
  16.775  corpus/posts/kalman-filter-07-ukf.md
  13.979  corpus/posts/kalman-filter-06-eskf.md
  13.979  corpus/posts/kalman-filter-08-porting.md
   2.796  corpus/posts/pid-control-09-lqr.md
   2.796  corpus/posts/pid-control-10-embedded.md
   2.796  corpus/posts/typst-by-xuan-15-wasm-plugin.md
8 hits in 123 files: index built in 1325.4 ms, query took 0.122 ms
```

分数一列是新的，`19.570` 是 `7 × 2.796`：7 是 `kalman` 在 `kalman-filter-02-multivariate.md` 里出现的次数，2.796 是这个词的 idf。第一行 `load_index took ...` 来自 `@timed`，它写在 stderr，和命中列表不是一个流。分数、计时、拼起来的分词链，这三样都是函数的功课。

## 环境

和前三篇一样的机器，仓库在标签 `ch04`：

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ git describe --tags
ch04
$ hyperfine --version
hyperfine 1.20.0
```

CPU 是 AMD Ryzen 7 PRO 6850U，内存 30 GiB。这一篇有一个测量上的坑要先说。同一条 `search kalman`，我在这台机器上看到过两种速度：隔一阵子再起的单次运行，建索引常常要 2.1 到 2.2 s，连着跑就稳定在 0.82 s 左右。我猜是 CPU 在空闲后要一小会儿才升频，但没有去验证，所以下面凡是要比较的数，我都交替运行两边、取最小值和中位数，并把完整输出贴出来。顺带一提，第 3 篇里的 721.4 ms 是那天的机器状态，今天同一份 `ch03` 代码在连续运行时是 815.1 ms。

要把 `ch03` 和 `ch04` 放在同一个会话里比较，我用 `git archive` 各导出一份到 `/tmp/p04`，语料用符号链接共享：

```bash
mkdir -p /tmp/p04 && cd /tmp/p04
mkdir ch03 ch04
git -C ~/Projects/sift archive ch03 | tar -x -C ch03
git -C ~/Projects/sift archive ch04 | tar -x -C ch04
ln -s ~/Projects/sift/corpus ch03/corpus
ln -s ~/Projects/sift/corpus ch04/corpus
```

`nix develop` 把 `PYTHONPATH` 设成“仓库的 `src`，冒号，Python 的 site-packages”。要在导出的目录里运行，就把第一项换掉。我写了一个小函数 `at`，后面反复用：

```bash
SITE=${PYTHONPATH#*:}
at() { (cd /tmp/p04/$1 && PYTHONPATH=/tmp/p04/$1/src:$SITE python3 "${@:2}"); }
```

`at ch03 -m sift search kalman` 就是在 `ch03` 的树里跑那条命令。一次性的脚本放在 `/tmp/p04/scratch/`，不进仓库；除非另说，命令都在仓库根目录 `~/Projects/sift` 里运行。正文里的脚本都是完整源码（有 `main()` 和 `__main__` 守卫，只有 `ann313.py` 例外：它要演示的错误就发生在类定义那一行，所以故意写在模块级），照抄就能复现，仓库文件的节选都是原文里连续的整段函数，没有中间省略。

## 函数是一个对象

`def` 不是声明，是一条在运行时执行的语句：执行它，解释器就用编译好的代码对象（code object）和当时的默认值造出一个 `function` 对象，再把它绑定到名字上。这个对象上能看到的东西比想象的多。拿 Sift 里的 `search_index` 和 `tf_idf` 开刀：

```python
"""Look inside the function objects of Sift."""

import dis

from sift.__main__ import search_index
from sift.scoring import tf_idf


def main() -> None:
    """Print the fields of search_index and the bytecode of tf_idf."""
    code = search_index.__code__
    print(type(search_index), search_index.__qualname__)
    print(search_index.__defaults__)
    print(code.co_argcount, code.co_varnames[:4], code.co_freevars)
    print(tf_idf.__annotations__)
    dis.dis(tf_idf)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p04/scratch/fn_object.py
<class 'function'> search_index
(<function tf_idf at 0x7ffff6d5d0c0>,)
4 ('index', 'words', 'n_docs', 'scoring') ()
{'tf': <class 'int'>, 'df': <class 'int'>, 'n_docs': <class 'int'>, 'return': <class 'float'>}
 18           RESUME                   0

 20           LOAD_FAST_BORROW         0 (tf)
              LOAD_GLOBAL              1 (idf + NULL)
              LOAD_FAST_BORROW_LOAD_FAST_BORROW 18 (df, n_docs)
              CALL                     2
              BINARY_OP                5 (*)
              RETURN_VALUE
```

逐行读：

- `type` 是 `function`，`__qualname__` 是定义时的“点分名字”。
- `__defaults__` 是一个元组，里面只有一个元素：函数 `tf_idf` 本身。`search_index(..., scoring=tf_idf)` 的默认值是在 `def` 执行的那一刻求值的，求出来的是一个函数对象，之后一直挂在 `search_index` 上。
- `__code__` 是代码对象：`co_argcount` 是 4，`co_varnames` 的前四项就是四个参数名，`co_freevars` 为空（它不是闭包，后面会看到不为空的例子）。
- `__annotations__` 是一个普通字典，解释器不会据此检查任何东西。
- `dis` 的输出是 `tf_idf` 的字节码：`LOAD_GLOBAL idf` 在**调用时**才去模块全局里找 `idf`，两个参数入栈，`CALL 2`，然后乘。没有任何特殊的“函数调用协议”，一次调用就是这几条指令。

最后一点后面会派上用场：我可以在运行时把 `sift.scoring.idf` 换成别的函数，`tf_idf` 下一次调用就会用新的。

## 参数的各种形态

先说一句：`lab/ch04` 里的实验文件为了让签名保持原样、突出要演示的参数形态，没有给每个函数（尤其是嵌套函数）都标注类型；`src/sift` 里的公共函数都有标注。

Python 的形参有五种，`lab/ch04/params.py` 把它们放进了同一个函数里：

```python
def positional_only(a, b, /, c):
    """Take a and b by position only; c either way."""
    return a, b, c


def keyword_only(a, *, sep=" ", end="!"):
    """Take sep and end by keyword only."""
    return f"{a}{sep}{end}"


def everything(a, b=2, /, c=3, *args, d, e=5, **kwargs):
    """Use every parameter kind at once."""
    return a, b, c, args, d, e, kwargs


def search(query, *, limit=10, **filters):
    """Collect extra keyword arguments as filters."""
    return query, limit, filters
```

`/` 左边的只能按位置传，`*` 右边的只能按关键字传，`*args` 收多余的位置参数成元组，`**kwargs` 收多余的关键字参数成字典。调用处也有对称的写法：`*` 展开序列，`**` 展开映射。

```python
def main() -> None:
    """Call the functions in every legal way."""
    print(positional_only(1, 2, 3), positional_only(1, 2, c=3))
    print(keyword_only("hi"), keyword_only("hi", sep="-", end="?"))
    print(everything(1, d=4))
    print(everything(1, 9, 8, 7, 6, d=4, x=0))
    print(search("kalman", limit=3, tag="Rust", year=2026))

    # 调用处解包：* 展开序列，** 展开映射
    args = (1, 2)
    kwargs = {"c": 3}
    print(positional_only(*args, **kwargs))
    print(everything(*"abc", d=1, **{"z": 26}))
    merged = {**{"limit": 5}, **{"limit": 7, "tag": "c"}}
    print(search("pid", **merged))

    # 函数是对象：默认值和签名都存在对象上
    print(everything.__defaults__, everything.__kwdefaults__)
    print(everything.__code__.co_varnames[:7])
    print(
        everything.__code__.co_posonlyargcount,
        everything.__code__.co_kwonlyargcount,
    )
```

```text
$ python3 lab/ch04/params.py
(1, 2, 3) (1, 2, 3)
hi ! hi-?
(1, 2, 3, (), 4, 5, {})
(1, 9, 8, (7, 6), 4, 5, {'x': 0})
('kalman', 3, {'tag': 'Rust', 'year': 2026})
(1, 2, 3)
('a', 'b', 'c', (), 1, 5, {'z': 26})
('pid', 7, {'tag': 'c'})
(2, 3) {'e': 5}
('a', 'b', 'c', 'd', 'e', 'args', 'kwargs')
2 2
```

第三行 `everything(1, d=4)` 得到 `(1, 2, 3, (), 4, 5, {})`：`a=1`，`b`、`c` 取默认值 2 和 3，`*args` 是空元组，`d` 必须给，`e` 取默认值 5。第四行里 `9, 8` 填 `b` 和 `c`，`7, 6` 进了 `*args`，没有对应形参的 `x=0` 进了 `**kwargs`。

最后三行是看函数身上的记录：位置参数的默认值在 `__defaults__`（`(2, 3)`，对应 `b` 和 `c`），关键字专用参数的默认值在另一个字典 `__kwdefaults__`（`{'e': 5}`）；`co_varnames` 按“位置参数、关键字专用参数、`*args`、`**kwargs`”的顺序排；`co_posonlyargcount` 和 `co_kwonlyargcount` 都是 2。五种形态在代码对象里只是几个计数。

关键字专用参数不只是风格。`search(query, *, limit=10)` 保证调用处必须写 `limit=3`，读代码的人不用去猜那个孤零零的 `3` 是什么。传错的后果：

```python
def search(query, *, limit=10):
    """Return the query and limit."""
    return query, limit


def main() -> None:
    """Trigger the TypeError on purpose."""
    # error: TypeError: search() takes 1 positional argument but 2
    # were given
    print(search("kalman", 3))
```

```text
$ python3 lab/ch04/keyword_only_fail.py
Traceback (most recent call last):
  File "/home/bfmhno3/Projects/sift/lab/ch04/keyword_only_fail.py", line 17, in <module>
    main()
    ~~~~^^
  File "/home/bfmhno3/Projects/sift/lab/ch04/keyword_only_fail.py", line 13, in main
    print(search("kalman", 3))
          ~~~~~~^^^^^^^^^^^^^
TypeError: search() takes 1 positional argument but 2 were given
$ echo $?
1
```

（回溯里的 `~~~~^^` 标出了出错的子表达式。）Sift 的 `search_index(index, words, n_docs, scoring=tf_idf)` 里 `n_docs` 是必填的位置参数：它是文档总数，从 `len(paths)` 来，我不想让它有一个会悄悄过期的默认值。

如果你在学 Rust：Rust 没有默认参数，也没有关键字参数，上面这一整节对应的是 builder 模式和结构体更新语法。Python 这边把它们做进了调用约定，代价是调用约定本身变得复杂：我上面那个 `everything` 就是一个反面教材，现实里不要写。

## 默认值只算一次

回到开头的 bug。`mutable_default.py` 的前半部分：

```python
# BAD: tags=[] is built once and shared by every call
def add_tag_bad(tag, tags=[]):  # noqa: B006
    """Append tag to tags and return it."""
    tags.append(tag)
    return tags


def add_tag(tag, tags=None):
    """Append tag to tags, creating a fresh list when none is given."""
    if tags is None:
        tags = []
    tags.append(tag)
    return tags


def main() -> None:
    """Call both versions twice."""
    print(add_tag_bad("a"), add_tag_bad("b"))
    print(add_tag_bad.__defaults__)
    print(add_tag("a"), add_tag("b"))
    print(add_tag.__defaults__)
```

```text
$ python3 lab/ch04/mutable_default.py
['a', 'b'] ['a', 'b']
(['a', 'b'],)
['a'] ['b']
(None,)
```

`tags=[]` 在 `def add_tag_bad` 执行的那一刻求值，`[]` 创建一次，放进 `__defaults__`。之后每次不传 `tags` 的调用，都把形参绑定到**这同一个**列表。输出的第二行证明了这一点：`add_tag_bad.__defaults__` 是 `(['a', 'b'],)`，两次调用各往里追加了一次，这个列表就挂在函数对象上。修复是惯用的 `None` 哨兵：默认值是不可变的 `None`，函数体里每次现造一个列表，`add_tag.__defaults__` 永远是 `(None,)`。

`ruff` 的 B006 规则会抓这种写法，所以 BAD 那行带了 `# noqa: B006`。把 `noqa` 去掉再检查一遍：

```text
$ sed 's/  # noqa: B006//' lab/ch04/mutable_default.py > /tmp/p04/scratch/no_noqa.py
$ ruff check --select B006 --output-format concise /tmp/p04/scratch/no_noqa.py
/tmp/p04/scratch/no_noqa.py:5:27: B006 Do not use mutable data structures for argument defaults
Found 1 error.
No fixes available (1 hidden fix can be enabled with the `--unsafe-fixes` option).
```

`search_index` 的 `scoring=tf_idf` 没有问题：默认值是函数对象，调用者不会往它里面追加东西。

## 名字怎么找：LEGB

函数里用到一个名字，解释器按 Local（本函数）、Enclosing（外层函数）、Global（模块）、Built-in（内建）的顺序找。`scopes.py` 的前半部分把四层各演示一遍，再演示 `global` 和 `nonlocal`：

```python
x = "global"
counter = 0


def show_legb() -> None:
    """Resolve x through Local, Enclosing, Global and Built-in."""
    x = "enclosing"

    def inner() -> None:
        x = "local"
        print("L:", x)

    def inner_enclosing() -> None:
        print("E:", x)

    inner()
    inner_enclosing()


def show_global() -> None:
    """Read the global x, and len from the built-in scope."""
    print("G:", x)
    print("B:", len)


def bump_global() -> None:
    """Rebind a module-level name; needs the global declaration."""
    global counter
    counter += 1


def make_counter():
    """Return a function that counts calls in an enclosing variable."""
    count = 0

    def tick() -> int:
        nonlocal count
        count += 1
        return count

    return tick
```

```python
def main() -> None:
    """Exercise each rule."""
    show_legb()
    show_global()
    bump_global()
    bump_global()
    print("counter:", counter)
    tick = make_counter()
    print(tick(), tick(), tick())
    other = make_counter()
    print(other(), tick())
    # 推导式有自己的作用域，循环变量不会泄漏
    squares = [n * n for n in range(3)]
    print(squares, "n" in globals())
    # 这些名字在编译期就分好了类
    print(show_legb.__code__.co_varnames, tick.__code__.co_freevars)
```

```text
$ python3 lab/ch04/scopes.py
L: local
E: enclosing
G: global
B: <built-in function len>
counter: 2
1 2 3
1 4
[0, 1, 4] False
('inner', 'inner_enclosing') ('count',)
```

要留意的是 `make_counter` 的输出：`tick` 和 `other` 各有各的 `count`，`tick` 的第四次调用是 4，`other` 的第一次调用是 1。`count` 不是全局变量，也不是挂在对象上的属性，它属于 `make_counter` 的某一次调用，而 `tick` 把它带了出来。这就是下一节的主角。

名字属于哪一层，是**编译时**决定的，不是运行时。规则只有一条：函数体里只要出现了对某个名字的赋值（包括 `+=`、`for` 的循环变量、`import`），这个名字在整个函数里都是局部的。`unbound_local_fail.py` 忘了写 `global`：

```python
total = 0


def add(n):
    """Add n to total, forgetting the global declaration."""
    # error: UnboundLocalError: cannot access local variable 'total'
    # where it is not associated with a value
    total += n  # noqa: F823
    return total


def main() -> None:
    """Trigger the UnboundLocalError on purpose."""
    print(add(1))
```

```text
$ python3 lab/ch04/unbound_local_fail.py
Traceback (most recent call last):
  File "/home/bfmhno3/Projects/sift/lab/ch04/unbound_local_fail.py", line 20, in <module>
    main()
    ~~~~^^
  File "/home/bfmhno3/Projects/sift/lab/ch04/unbound_local_fail.py", line 16, in main
    print(add(1))
          ~~~^^^
  File "/home/bfmhno3/Projects/sift/lab/ch04/unbound_local_fail.py", line 10, in add
    total += n  # noqa: F823
    ^^^^^
UnboundLocalError: cannot access local variable 'total' where it is not associated with a value
$ echo $?
1
```

`total += n` 在编译时就把 `total` 判成了局部变量，所以执行到这一行时读到的是一个还没有值的局部变量，而不是全局那个 0。看字节码最直观。`dis_scopes.py` 反汇编三个函数（要从仓库根目录运行，它用相对路径 `lab/ch04/` 加载实验文件），我把其中和名字有关的指令筛了出来：

```python
"""Disassemble the lab functions; run from the repository root."""

import dis
from runpy import run_path

LAB = "lab/ch04/"


def main() -> None:
    """Show how the compiler classifies names in three lab functions."""
    closures = run_path(LAB + "closures.py")
    unbound = run_path(LAB + "unbound_local_fail.py")
    scopes = run_path(LAB + "scopes.py")
    print("--- make_multiplier")
    dis.dis(closures["make_multiplier"])
    print("--- add (forgot global)")
    dis.dis(unbound["add"])
    print("--- bump_global")
    dis.dis(scopes["bump_global"])


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p04/scratch/dis_scopes.py \
    | grep -E '^---|CELL|DEREF|FREE_VARS|FAST_CHECK|GLOBAL|closure|MAKE_FUNCTION'
--- make_multiplier
  --           MAKE_CELL                0 (factor)
               LOAD_CONST               1 (<code object multiply at 0x7ffff6f76f10, file "lab/ch04/closures.py", line 7>)
               MAKE_FUNCTION
               SET_FUNCTION_ATTRIBUTE   8 (closure)
Disassembly of <code object multiply at 0x7ffff6f76f10, file "lab/ch04/closures.py", line 7>:
  --           COPY_FREE_VARS           1
               LOAD_DEREF               1 (factor)
--- add (forgot global)
 10           LOAD_FAST_CHECK          1 (total)
--- bump_global
 31           LOAD_GLOBAL              0 (counter)
              STORE_GLOBAL             0 (counter)
```

`add` 里是 `LOAD_FAST_CHECK`：一个“读之前要检查是否已绑定”的局部变量加载，检查失败就抛出上面那个 `UnboundLocalError`。`bump_global` 里是 `LOAD_GLOBAL` 加 `STORE_GLOBAL`，这就是 `global` 声明换来的东西。`make_multiplier` 那几行（`MAKE_CELL`、`LOAD_DEREF`、`COPY_FREE_VARS`）留给下一节。

## 闭包与 cell

`make_multiplier` 返回一个内层函数，内层函数用到了外层的参数 `factor`。外层函数早就返回了，`factor` 还活着，这个结构叫闭包。`closures.py` 把它拆开：

```python
def make_multiplier(factor):
    """Return a function that multiplies by factor."""

    def multiply(x):
        return x * factor

    return multiply


def main() -> None:
    """Inspect cells and reproduce the late-binding trap."""
    double = make_multiplier(2)
    print(double.__closure__)
    print(double.__code__.co_freevars)
    print(double.__closure__[0].cell_contents)
    print(double(21))

    # BAD: 三个 lambda 共享同一个 cell，循环结束时 i 是 2
    late = [lambda: i for i in range(3)]  # noqa: B023
    print([f() for f in late])
    print([f.__closure__[0].cell_contents for f in late])
    print(late[0].__closure__[0] is late[1].__closure__[0])

    # 修复：用默认参数在定义时把当前值绑定进去
    bound = [lambda i=i: i for i in range(3)]
    print([f() for f in bound])
    print(bound[0].__closure__, bound[0].__defaults__)

    # 另一种修复：每次调用工厂函数，得到各自的 cell
    made = [make_multiplier(k) for k in range(3)]
    print([f(10) for f in made])

    # cell 是可变的：外层改了，内层看得到
    def outer():
        value = 1

        def read():
            return value

        value = 2
        return read

    print(outer()())
```

```text
$ python3 lab/ch04/closures.py
(<cell at 0x7ffff6e19570: int object at 0x7ffff7e5da10>,)
('factor',)
2
42
[2, 2, 2]
[2, 2, 2]
True
[0, 1, 2]
None (0,)
[0, 10, 20]
2
```

前四行：`double.__closure__` 是一个元组，里面一个 **cell** 对象，指向整数 2（十六进制地址每次运行都不同）；`co_freevars` 是 `('factor',)`，`cell_contents` 取出 2；`double(21)` 是 42。cell 是 CPython 为“被内层函数引用的外层变量”准备的一个小盒子：外层函数不再把 `factor` 存在自己的栈上，而是存在盒子里，内层函数拿到的是盒子。上一节 `dis` 的输出就是这个过程：外层开头 `MAKE_CELL` 造盒子，`MAKE_FUNCTION` 之后 `SET_FUNCTION_ATTRIBUTE 8 (closure)` 把盒子挂到新函数上，内层函数开头 `COPY_FREE_VARS` 把盒子拷进自己的帧，读取时用 `LOAD_DEREF`，多一次解引用。

打个比方：cell 像一个储物柜，闭包拿到的是柜子的编号，不是柜子里的东西。谁往柜子里放了新东西，所有拿着这个编号的人下次开柜子都会看到。比方就用这一次，下面回到字节码和对象。

这个“拿的是柜子不是东西”的性质，就是闭包最著名的坑，输出从第五行开始。三个 `lambda` 在列表推导式里创建，它们引用的 `i` 是同一个 cell（输出的 `True` 就是 `late[0].__closure__[0] is late[1].__closure__[0]`）。推导式跑完时 `i` 是 2，所以三个 lambda 调用都返回 2，`[2, 2, 2]`，这叫晚绑定（late binding）。有两种修法，都在输出里：

- `lambda i=i: i`：用默认值在 `lambda` 创建的那一刻把 `i` 的当前值存进 `__defaults__`，`__closure__` 变成 `None`，这个 `lambda` 不再是闭包。输出 `[0, 1, 2]` 和 `None (0,)`。
- 每次调用一次工厂函数（`make_multiplier(k)`），每次调用有自己的帧，所以有自己的 cell。输出 `[0, 10, 20]`。

最后一个小实验：`outer()` 里 `read` 定义之后，`value` 才从 1 改成 2，`outer()()` 返回 2。cell 是共享的、可变的，读的是调用那一刻的内容。

两个旁注。C++ 的 lambda 要你显式写 `[&]` 或 `[=]` 说清楚捕获的是引用还是拷贝，Python 没有这个选项，永远捕获变量本身（也就是 cell）；Rust 的闭包用 `move` 决定所有权，`Fn`、`FnMut`、`FnOnce` 三个 trait 对应“只读、可改、只能调一次”，我在 [Pebble 的第 9 篇](/posts/rust-by-pebble-09-interpreter-closures/)里写过那一边的故事。Python 的 `nonlocal count; count += 1` 对应 Rust 里的 `FnMut`，但没有任何编译期检查：谁都可以改。

## 函数是值

函数是对象，就能放进字典、传给别的函数、从函数里返回。`first_class.py`：

```python
from operator import itemgetter


def shout(s: str) -> str:
    """Return s in upper case with an exclamation mark."""
    return s.upper() + "!"


def apply(fn, value):
    """Call fn on value."""
    return fn(value)


def main() -> None:
    """Pass functions around."""
    handlers = {"shout": shout, "len": len, "rev": lambda s: s[::-1]}
    for name, fn in handlers.items():
        print(name, apply(fn, "sift"))
    print(type(shout), shout.__name__, callable(shout))

    words = ["tea", "Bicycle", "rust", "PID", "compiler"]
    print(sorted(words))
    print(sorted(words, key=str.lower))
    print(sorted(words, key=len))
    print(sorted(words, key=lambda w: (len(w), w)))
    print(max(words, key=len), min(words, key=len))
    pairs = [("tea", 3), ("bike", 1), ("rust", 2)]
    print(sorted(pairs, key=itemgetter(1)))

    nums = range(10)
    print(list(map(lambda n: n * n, nums)))
    print([n * n for n in nums])
    print(list(filter(lambda n: n % 2 == 0, nums)))
    print([n for n in nums if n % 2 == 0])
    # 已有具名函数时 map 更短；要写 lambda 时推导式更清楚
    print(list(map(str.strip, [" a ", "b  "])))
    print(list(map(pow, [2, 3], [3, 2], strict=True)))
    print(map(len, words))
```

```text
$ python3 lab/ch04/first_class.py
shout SIFT!
len 4
rev tfis
<class 'function'> shout True
['Bicycle', 'PID', 'compiler', 'rust', 'tea']
['Bicycle', 'compiler', 'PID', 'rust', 'tea']
['tea', 'PID', 'rust', 'Bicycle', 'compiler']
['PID', 'tea', 'rust', 'Bicycle', 'compiler']
compiler tea
[('bike', 1), ('rust', 2), ('tea', 3)]
[0, 1, 4, 9, 16, 25, 36, 49, 64, 81]
[0, 1, 4, 9, 16, 25, 36, 49, 64, 81]
[0, 2, 4, 6, 8]
[0, 2, 4, 6, 8]
['a', 'b']
[8, 9]
<map object at 0x7ffff6ffbd40>
```

`sorted(words, key=str.lower)` 是最常见的高阶函数用法：`key` 是一个“从元素算出排序依据”的函数，每个元素只调用一次。不带 `key` 的 `sorted(words)` 把大写字母开头的 `'Bicycle'` 和 `'PID'` 排在最前面，`key=str.lower` 之后按忽略大小写的顺序排。`sorted(words, key=lambda w: (len(w), w))` 用元组做复合键，先比长度，再比字典序。

`lambda` 是只能写一个表达式的匿名函数，不能有语句，也没有 `return`。它和 `def` 造出的是同一种对象，只是名字是 `<lambda>`：

```text
$ python3 -c "print((lambda: 0).__name__)"
<lambda>
```

`map` 和 `filter` 对着已有的具名函数很短（`map(str.strip, ...)`），要写 `lambda` 的时候推导式更清楚，也更常见。最后一行 `print(map(len, words))` 打印的是 `<map object at ...>`：`map` 不立刻算，返回的是一个惰性对象。它是怎么做到的，是第 5 篇的内容。

Sift 里这样的 `key` 也有：`search_index` 末尾 `hits.sort(key=lambda hit: (-hit[0], hit[1]))`，先按分数降序，同分按 `doc_id` 升序，用负号把降序变成升序的复合键。

### operator：不写 lambda

简单的 `lambda r: r[1]` 在标准库里有现成的版本。`operator_module.py`：

```python
def main() -> None:
    """Replace small lambdas with operator functions."""
    print(operator.add(2, 3), operator.mul(4, 5), operator.lt(1, 2))
    print(reduce(operator.mul, range(1, 6)))

    rows = [("tea", 3), ("bike", 1), ("rust", 2)]
    print(sorted(rows, key=itemgetter(1)))
    print(itemgetter(0, 1)(["a", "b", "c"]))
    print(itemgetter("x", "y")({"x": 1, "y": 2, "z": 3}))

    class Doc:
        def __init__(self, title: str, size: int) -> None:
            self.title = title
            self.size = size

        def __repr__(self) -> str:
            return f"Doc({self.title!r}, {self.size})"

    docs = [Doc("b", 2), Doc("a", 9), Doc("c", 5)]
    print(sorted(docs, key=attrgetter("size")))
    print(max(docs, key=attrgetter("size")))
    print(attrgetter("title", "size")(docs[0]))

    print(methodcaller("upper")("sift"))
    print(methodcaller("split", ",")("a,b,c"))
    print(list(map(methodcaller("strip"), [" a ", "b "])))

    # operator.itemgetter 比 lambda 快一点，也更能说明意图
    print(sorted(rows, key=lambda r: r[1]) == sorted(rows, key=itemgetter(1)))
```

```text
$ python3 lab/ch04/operator_module.py
5 20 True
120
[('bike', 1), ('rust', 2), ('tea', 3)]
('a', 'b')
(1, 2)
[Doc('b', 2), Doc('c', 5), Doc('a', 9)]
Doc('a', 9)
('b', 2)
SIFT
['a', 'b', 'c']
['a', 'b']
True
```

`itemgetter(1)` 等价于 `lambda r: r[1]`，`itemgetter(0, 1)` 一次取多个，返回元组；`attrgetter("size")` 取属性；`methodcaller("split", ",")` 调方法；`operator.mul` 是 `*` 的函数形式，所以 `reduce(operator.mul, range(1, 6))` 是 120。这些都不是 Python 函数，而是 C 实现的可调用对象：

```text
$ python3 -c "import inspect, operator; \
print(inspect.isfunction(operator.itemgetter(1)), \
inspect.isfunction(lambda r: r[1]))"
False True
```

这个差别可以量。`key_cost.py` 对 10 万个元组排序，只变 `key`：

```python
"""sorted(key=...) with a lambda, itemgetter and a plain def."""

import functools
import random
import timeit
from operator import itemgetter


def second(row):
    """Return the second field of row."""
    return row[1]


def main() -> None:
    """Time sorting 100,000 tuples with three equivalent keys."""
    random.seed(0)
    rows = [(f"w{i}", random.randrange(10**6)) for i in range(100_000)]
    keys = (
        ("lambda r: r[1]", lambda r: r[1]),
        ("def second(row)", second),
        ("itemgetter(1)", itemgetter(1)),
    )
    for label, key in keys:
        run = functools.partial(sorted, rows, key=key)
        best = min(timeit.repeat(run, number=3, repeat=5))
        print(f"{label:16} {best / 3 * 1000:6.1f} ms")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p04/scratch/key_cost.py
lambda r: r[1]     19.1 ms
def second(row)    19.9 ms
itemgetter(1)      16.0 ms
```

`itemgetter(1)` 比 `lambda` 快 3.1 ms，约 16%，10 万次 `key` 调用平均每次省 31 ns 左右；具名的 `def second` 和 `lambda` 一样快（19.9 ms 对 19.1 ms），因为它们是同一种对象。省下的是什么，等到下面“一次调用多贵”再回答。

Sift 里也用到了 `itemgetter`：每个文件的处理链第二步，从 `split_front_matter` 返回的 `(front matter, 正文)` 元组里取正文。这在下面的 `compose` 里出现。

## 装饰器

装饰器是接收一个函数、返回一个函数的函数，`@` 只是把赋值写得短一点。`decorators.py` 一个文件里放了五种：不规范的 `plain`、规范的 `wrapped`、带参数的 `repeat` 和 `tag`、类实现的 `CountCalls`。

```python
def plain(fn):
    """Log each call (no functools.wraps, on purpose)."""

    def wrapper(*args, **kwargs):
        print(f"plain: calling {fn.__name__}")
        return fn(*args, **kwargs)

    return wrapper


def wrapped(fn):
    """Log each call, keeping the metadata of fn."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        print(f"wrapped: calling {fn.__name__}")
        return fn(*args, **kwargs)

    return wrapper
```

```python
def repeat(times):
    """Return a decorator that calls the function times times."""

    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            result = None
            for _ in range(times):
                result = fn(*args, **kwargs)
            return result

        return wrapper

    return decorator


def tag(name):
    """Return a decorator that wraps the result in <name>...</name>."""

    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            return f"<{name}>{fn(*args, **kwargs)}</{name}>"

        return wrapper

    return decorator
```

```python
class CountCalls:
    """Class-based decorator: the instance is the wrapper."""

    def __init__(self, fn):
        functools.update_wrapper(self, fn)
        self.fn = fn
        self.calls = 0

    def __call__(self, *args, **kwargs):
        self.calls += 1
        return self.fn(*args, **kwargs)
```

被装饰的函数和 `main` 是这样的：

```python
@plain
def f_plain(x):
    """Docstring of f_plain."""
    return x


@wrapped
def f_wrapped(x):
    """Docstring of f_wrapped."""
    return x


@repeat(3)
def hello():
    """Print a greeting."""
    print("hello")


@tag("b")
@tag("i")
def text():
    """Return a word."""
    return "sift"


@CountCalls
def square(x):
    """Return x squared."""
    return x * x
```

```python
def main() -> None:
    """Show each decorator and what wraps preserves."""
    f_plain(1)
    f_wrapped(1)
    for fn in (f_plain, f_wrapped):
        print(fn.__name__, repr(fn.__doc__), hasattr(fn, "__wrapped__"))
    print(f_wrapped.__wrapped__(5))

    hello()

    # 叠放顺序：离函数最近的装饰器最先应用，所以最先包住结果
    print(text())
    print(text.__name__)

    square(3)
    square(4)
    print(square.calls, square.__name__, square(5))

    # 装饰器语法只是赋值：f = deco(f)
    def late(x):
        return x + 1

    late = wrapped(late)
    print(late(1), late.__name__)
```

```text
$ python3 lab/ch04/decorators.py
plain: calling f_plain
wrapped: calling f_wrapped
wrapper None False
f_wrapped 'Docstring of f_wrapped.' True
5
hello
hello
hello
<b><i>sift</i></b>
text
2 square 25
wrapped: calling late
2 late
```

第 3 行和第 4 行是同一件事的两面。`f_plain` 被 `plain` 换成了里面的 `wrapper` 函数，所以 `__name__` 是 `wrapper`，文档字符串是 `None`，`__wrapped__` 不存在；`f_wrapped` 用了 `functools.wraps(fn)`，名字、文档都保住了，还多出一个 `__wrapped__` 指回原函数（第 5 行 `f_wrapped.__wrapped__(5)` 绕过包装器直接调原函数，没有再打印 `wrapped: calling`）。`wraps` 拷贝的东西是固定的，可以直接问：

```text
$ python3 -c "import functools; print(functools.WRAPPER_ASSIGNMENTS, functools.WRAPPER_UPDATES)"
('__module__', '__name__', '__qualname__', '__doc__', '__annotate__', '__type_params__') ('__dict__',)
```

调试器、`help()`、`inspect.signature`、`pytest` 的 fixture 名字都靠这些属性。不写 `wraps` 的装饰器不会让程序出错，只会让后面排查问题的人莫名其妙。

### 带参数、叠放与类实现

带参数的装饰器是三层函数：最外层（`repeat`、`tag`）接收参数，返回真正的装饰器，装饰器再返回包装器。输出的 `hello` 打印了三次，因为 `@repeat(3)` 先执行 `repeat(3)` 得到装饰器，再用它装饰 `hello`。叠放的顺序是离函数最近的先生效：`@tag("b")` 在 `@tag("i")` 上面，所以先用 `i` 包住 `"sift"`，再用 `b` 包住那个结果，输出 `<b><i>sift</i></b>`。`text.__name__` 仍然是 `text`，因为每一层都有 `wraps`。

装饰器也可以是一个类，只要实例可调用（定义 `__call__`）。`CountCalls` 的状态（`self.calls`）存在实例属性上，闭包版本要靠 `nonlocal`。输出里 `2 square 25` 值得多看一眼：`print(square.calls, square.__name__, square(5))` 的参数从左到右求值，打印 `square.calls` 时第三次调用还没发生，所以是 2，不是 3。

类实现有一个闭包版本没有的坑：实例不是函数，没有 `__get__`，所以用在方法上不会绑定 `self`。`method_decorator.py` 把两种实现装饰在同一个类的两个方法上：

```python
"""A class-based decorator is not a function, so it never binds self."""

import functools


class CountCalls:
    """Count calls; the instance replaces the function."""

    def __init__(self, fn):
        functools.update_wrapper(self, fn)
        self.fn = fn
        self.calls = 0

    def __call__(self, *args, **kwargs):
        self.calls += 1
        return self.fn(*args, **kwargs)


def count_calls(fn):
    """Count calls; a plain function wrapper."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        wrapper.calls += 1
        return fn(*args, **kwargs)

    wrapper.calls = 0
    return wrapper


class Doc:
    """A document with two decorated methods."""

    def __init__(self, title):
        self.title = title

    @count_calls
    def shout(self):
        """Return the title in upper case."""
        return self.title.upper()

    # BAD: CountCalls has no __get__, so d.size() passes no self
    @CountCalls
    def size(self):
        """Return the title length."""
        return len(self.title)


def main() -> None:
    """Call both methods; the second one fails on purpose."""
    d = Doc("sift")
    print(d.shout(), Doc.shout.calls)
    print(hasattr(count_calls, "__get__"), hasattr(CountCalls, "__get__"))
    print(d.size())


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p04/scratch/method_decorator.py
SIFT 1
True False
Traceback (most recent call last):
  File "/tmp/p04/scratch/method_decorator.py", line 58, in <module>
    main()
    ~~~~^^
  File "/tmp/p04/scratch/method_decorator.py", line 54, in main
    print(d.size())
          ~~~~~~^^
  File "/tmp/p04/scratch/method_decorator.py", line 16, in __call__
    return self.fn(*args, **kwargs)
           ~~~~~~~^^^^^^^^^^^^^^^^^
TypeError: Doc.size() missing 1 required positional argument: 'self'
$ echo $?
1
```

`d.shout()` 正常，`Doc.shout.calls` 是 1。`hasattr(count_calls, "__get__")` 是 `True`（函数有），`hasattr(CountCalls, "__get__")` 是 `False`，所以 `d.size()` 访问到的是 `CountCalls` 实例本身，调用时 `self` 没有被传进来，抛出 `TypeError`。需要修的话给 `CountCalls` 加 `__get__`，这超出这一篇的范围，装饰方法的话直接用函数版。

最后，`@` 语法糖没有任何魔法：`decorators.py` 末尾的 `late = wrapped(late)` 和 `@wrapped` 写在 `def` 上面是一回事，输出最后两行 `wrapped: calling late` 和 `2 late` 证明了。

### Sift 里的 timed

`util.py` 里的 `timed` 是一个标准的无参数装饰器：

```python
"""Small function helpers: a timing decorator and compose."""

import functools
import sys
import time
from collections.abc import Callable
from typing import Any


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
```

几处细节：

- `wrapper` 用 `try`/`finally`，函数抛出异常时计时行也照样打印。
- 计时行写到 `sys.stderr`，不污染 stdout 里的结果。
- 名字用 `fn.__qualname__`，类里的方法会带上类名。
- `def timed[**P, R](fn: Callable[P, R]) -> Callable[P, R]` 是 Python 3.12 起的类型参数语法：`P` 是参数规格（`ParamSpec`），`R` 是返回值类型。意思是“装饰后的函数接受和原函数相同的参数，返回相同的类型”，类型检查器据此知道 `load_index` 被装饰之后签名没变。这对运行时没有任何影响。

两个流分开看：

```text
$ python3 -m sift search kalman 2>/dev/null | head -2
  19.570  corpus/posts/kalman-filter-02-multivariate.md
  16.775  corpus/posts/kalman-filter-01-one-dimension.md
$ python3 -m sift search kalman 2>&1 >/dev/null
load_index took 2142.1 ms
```

`try`/`finally` 和 `__qualname__` 各用一个探针确认。`boom` 抛异常，`Index.build` 是类里的方法：

```python
"""timed on an exception and on a method: what the stderr line says."""

from sift.util import timed


@timed
def boom() -> None:
    """Raise on purpose."""
    raise ValueError("boom")


class Index:
    """A class with one timed method."""

    @timed
    def build(self) -> int:
        """Return a number."""
        return 1


def main() -> None:
    """Call the failing function and the method."""
    print(Index().build(), flush=True)
    try:
        boom()
    except ValueError as exc:
        print("caught:", exc, flush=True)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p04/scratch/timed_probe.py
Index.build took 0.0 ms
1
boom took 0.0 ms
caught: boom
```

`boom` 的计时行照样打印了，异常也照样传了出去（`caught: boom`）；方法的名字是 `Index.build`。

`load_index` 现在是这个包装器，但从外面看几乎认不出：

```python
"""What functools.wraps left on the decorated load_index."""

import inspect

from sift.__main__ import load_index


def main() -> None:
    """Print the metadata of the decorated load_index."""
    print(load_index.__name__, load_index.__qualname__)
    print(load_index.__wrapped__)
    print(inspect.signature(load_index))
    print(load_index.__doc__.splitlines()[0])


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p04/scratch/wraps_check.py
load_index load_index
<function load_index at 0x7ffff6c05c70>
(root: pathlib.Path) -> tuple[list[pathlib.Path], dict[str, dict[int, int]]]
Read, tokenize and index every Markdown file under root.
```

名字、文档、签名（`inspect.signature` 顺着 `__wrapped__` 找到原函数）都是原来的，`__wrapped__` 指回未装饰的函数。

## compose：把处理链拼起来

第 2 篇里 `tokenize` 是一个函数：归一化、找 run、切成词元三步写在一起。第 3 篇里 `load_index` 里面还有“去 front matter、去 Markdown 标记、分词”三步。`ch04` 把这些步骤拆成小函数，再用 `compose` 按顺序接起来。`compose` 本身：

```python
def compose(*fns: Callable[[Any], Any]) -> Callable[[Any], Any]:
    """Return a function that applies fns left to right.

    ``compose(f, g, h)(x)`` is ``h(g(f(x)))``. With no functions it
    returns its argument unchanged.
    """

    def composed(value: Any) -> Any:
        for fn in fns:
            value = fn(value)
        return value

    return composed
```

`compose(f, g, h)(x)` 就是 `h(g(f(x)))`，从左到右，和读代码的顺序一致。它是一个闭包：`composed` 引用了外层的 `fns`（一个 cell），每次调用在 `for` 里把值递给下一个函数。没有函数时原样返回参数。注意它的类型是 `Callable[[Any], Any]`，类型检查器看不穿链的中间类型：这是一个我明知道有损失、但在这个体量下接受的取舍。

先看 `__main__.py` 里每个文件的处理链。`ch03` 的 `load_index`：

```text
$ git show ch03:src/sift/__main__.py | sed -n 16,27p
def load_index(root: Path) -> tuple[list[Path], dict[str, dict[int, int]]]:
    """Read, tokenize and index every Markdown file under root.

    The doc_id of a file is its position in the sorted path list.
    """
    paths = sorted(root.glob("*.md"))
    docs: dict[int, list[str]] = {}
    for doc_id, path in enumerate(paths):
        text = path.read_text(encoding="utf-8")
        body = strip_markdown(split_front_matter(text)[1])
        docs[doc_id] = tokenize(body)
    return paths, build_index(docs)
```

`ch04` 的版本（节选）：

```python
# 文件文本 -> 去掉 front matter -> 去掉 Markdown 标记 -> 词项
analyze_file = compose(
    split_front_matter, itemgetter(1), strip_markdown, tokenize
)


@timed
def load_index(root: Path) -> tuple[list[Path], dict[str, dict[int, int]]]:
    """Read, tokenize and index every Markdown file under root.

    The doc_id of a file is its position in the sorted path list.
    """
    paths = sorted(root.glob("*.md"))
    docs: dict[int, list[str]] = {}
    for doc_id, path in enumerate(paths):
        docs[doc_id] = analyze_file(path.read_text(encoding="utf-8"))
    return paths, build_index(docs)
```

`analyze_file` 是一个函数，由四个函数拼成：`split_front_matter` 返回 `(front matter, 正文)` 元组，`itemgetter(1)` 取出正文，`strip_markdown` 去标记，`tokenize` 分词。注释一行写的是数据流，代码一行写的也是数据流，两者一致。`load_index` 的循环体缩成了一行，`@timed` 在它上面。

`tokenize` 也是这样拆的：

```python
def fold(text: str) -> str:
    """NFKC-normalize and casefold text."""
    return unicodedata.normalize("NFKC", text).casefold()


def find_runs(folded: str) -> list[re.Match[str]]:
    """Return the Latin and CJK runs of already folded text."""
    return list(_TOKEN.finditer(folded))


def split_runs(runs: list[re.Match[str]]) -> list[str]:
    """Turn runs into terms: Latin runs whole, CJK runs as bigrams.

    A CJK run of a single character stays one unigram.
    """
    tokens: list[str] = []
    for match in runs:
        if match["latin"] is not None:
            tokens.append(match["latin"])
            continue
        run = match["cjk"]
        if len(run) == 1:
            tokens.append(run)
        else:
            tokens.extend(run[i : i + 2] for i in range(len(run) - 1))
    return tokens


_PIPELINE = compose(fold, find_runs, split_runs)


def tokenize(text: str) -> list[str]:
    """Split text into index terms.

    The text is NFKC-normalized and casefolded first. Latin and digit
    runs become one token each (``c++`` and ``c#`` keep their suffix).
    A CJK run becomes overlapping bigrams, or one unigram when the run
    has a single character.
    """
    return _PIPELINE(text)
```

三个小函数各做一件事（`fold` 归一化，`find_runs` 找 Latin 和 CJK 的 run，`split_runs` 把 run 变成词项），`_PIPELINE` 是模块级的一个 `compose` 结果，`tokenize` 的签名没变，所有调用它的地方都不用改。这是函数当值用的好处：中间步骤可以单独测试，换掉一步不用动别的。

这样拆应该不改变分词结果。验证这个说法：两棵树上 `stats` 的输出（词表大小、前 20 个词和次数）逐行比较，再比较 `kalman` 命中文档的顺序：

```text
$ diff <(at ch03 -m sift stats 2>/dev/null | grep -v "index built") \
       <(at ch04 -m sift stats 2>/dev/null | grep -v "index built"); \
  echo "diff exit $?"
diff exit 0
$ for t in ch03 ch04; do \
    at $t -m sift search kalman 2>/dev/null \
      | grep -o "corpus/posts.*" | md5sum; \
  done
55598ed70c47f904a108b5903a8ce4b8  -
55598ed70c47f904a108b5903a8ce4b8  -
```

`diff` 没有输出，两次 `md5sum` 一样：词表大小、前 20 个词的次数、单个词查询的命中顺序都没变。（单个词的 TF-IDF 排序和词频排序必然一致，因为同一个词的 idf 是一个正常数。这个结论在后面“多个词”的时候就不成立了。）

## 一次调用多贵

把一个函数拆成三个，调用次数就多了。这是我在拆之前最担心的事：Python 的函数调用是出了名的贵。我的直觉是肯定会慢一点，慢多少说不准。然后量：`ch03` 和 `ch04` 交替各跑 21 次，每次读 `search kalman` 打印出来的 `index built in ... ms`：

```python
"""Alternate ch03 and ch04 searches; report the index build times."""

import os
import re
import statistics
import subprocess
import sys

ROUNDS = 21
SITE = os.environ["PYTHONPATH"].split(":", 1)[1]
BUILT = re.compile(r"index built in ([\d.]+) ms")


def build_ms(tag: str) -> float:
    """Run one search in the tree of tag; return its build time."""
    env = dict(os.environ, PYTHONPATH=f"/tmp/p04/{tag}/src:{SITE}")
    proc = subprocess.run(
        [sys.executable, "-m", "sift", "search", "kalman"],
        cwd=f"/tmp/p04/{tag}",
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    return float(BUILT.search(proc.stdout).group(1))


def main() -> None:
    """Interleave the two trees so drift hits both equally."""
    times: dict[str, list[float]] = {"ch03": [], "ch04": []}
    for _ in range(ROUNDS):
        for tag, values in times.items():
            values.append(build_ms(tag))
    for tag, values in times.items():
        print(
            f"{tag}: min {min(values):7.1f}  "
            f"median {statistics.median(values):7.1f}  "
            f"max {max(values):7.1f} ms"
        )
    ratio_min = min(times["ch04"]) / min(times["ch03"])
    ratio_med = statistics.median(times["ch04"]) / statistics.median(
        times["ch03"]
    )
    print(f"ch04 / ch03: min {ratio_min:.3f}, median {ratio_med:.3f}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p04/scratch/bench_build.py
ch03: min   815.1  median   828.4  max  2198.9 ms
ch04: min   808.2  median   821.3  max  2186.1 ms
ch04 / ch03: min 0.992, median 0.991
```

最小值 815.1 ms 对 808.2 ms，中位数 828.4 ms 对 821.3 ms，比值 0.992 和 0.991。没有变慢，如果非要说什么，`ch04` 还稍微快一点，但这个差在噪声里：最大值那一列是 2,198.9 ms 和 2,186.1 ms，就是上面说的“慢速状态”。再用 `hyperfine` 量整条命令（不看内部计时）：

```text
$ hyperfine --warmup 2 --runs 15 \
    -n ch03 "cd /tmp/p04/ch03 && PYTHONPATH=/tmp/p04/ch03/src:$SITE \
      python3 -m sift search kalman 2>/dev/null" \
    -n ch04 "cd /tmp/p04/ch04 && PYTHONPATH=/tmp/p04/ch04/src:$SITE \
      python3 -m sift search kalman 2>/dev/null"
Benchmark 1: ch03
  Time (mean ± σ):     872.0 ms ±  11.6 ms    [User: 808.2 ms, System: 58.7 ms]
  Range (min … max):   857.3 ms … 895.9 ms    15 runs

Benchmark 2: ch04
  Time (mean ± σ):     869.7 ms ±  11.2 ms    [User: 804.2 ms, System: 60.4 ms]
  Range (min … max):   856.4 ms … 901.0 ms    15 runs

Summary
  ch04 ran
    1.00 ± 0.02 times faster than ch03
```

`872.0 ± 11.6 ms` 对 `869.7 ± 11.2 ms`，`1.00 ± 0.02`。端到端没有量出任何开销。要解释为什么，得看 CPython 是怎么调用一个 Python 函数的。

### 为什么这么便宜

`tokenize` 在整个建索引过程里只被调用 123 次（每个文件一次），不是每个词元一次。加了 `compose` 之后多出来的，是每个文件 4 个新的 Python 函数调用（`composed`、`fold`、`find_runs`、`split_runs`；`analyze_file` 那一层的调用在 `ch03` 里是内联的，我没有把它单独算）。我用 `cProfile` 数一遍调用总数，两棵树上跑同一段分析：

```python
"""Count Python-level and C-level calls of one full analysis pass."""

import cProfile
import pstats
from pathlib import Path

from sift.analysis.tokenize import tokenize
from sift.markdown import split_front_matter, strip_markdown


def analyze(texts: list[str]) -> list[list[str]]:
    """Run the three analysis steps on every text."""
    return [tokenize(strip_markdown(split_front_matter(t)[1])) for t in texts]


def main() -> None:
    """Profile one pass and print the number of calls."""
    paths = sorted(Path("corpus/posts").glob("*.md"))
    texts = [p.read_text(encoding="utf-8") for p in paths]
    prof = cProfile.Profile()
    prof.runcall(analyze, texts)
    stats = pstats.Stats(prof)
    print(f"{stats.total_calls} calls, {stats.prim_calls} primitive")


if __name__ == "__main__":
    main()
```

```text
$ at ch03 /tmp/p04/scratch/count_calls.py
1891450 calls, 1891450 primitive
$ at ch04 /tmp/p04/scratch/count_calls.py
1891942 calls, 1891942 primitive
```

多了 492 次，正好是 `123 × 4`。189 万次调用里，绝大多数是正则的 `sub`、`list.append`、生成器表达式这些（逐文件、逐行、逐词元发生的），`compose` 的贡献是 492 次。一次 Python 调用有多少钱？`call_cost.py` 量了一下，顺带量了 `compose` 一层、`timed` 一层：

```python
"""Price one Python-level call, a compose layer and a timed wrapper."""

import functools
import io
import time
import timeit
from contextlib import redirect_stderr

from sift.util import compose, timed


def ident(x):
    """Return x unchanged."""
    return x


def quiet(fn):
    """Like timed, but build the line and drop it, not print it."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        start = time.perf_counter()
        try:
            return fn(*args, **kwargs)
        finally:
            ms = (time.perf_counter() - start) * 1000
            _ = f"{fn.__qualname__} took {ms:.1f} ms"

    return wrapper


ENV = {
    "perf_counter": time.perf_counter,
    "q": "ident",
    "ms": 1.2345,
    "ident": ident,
    "three": compose(ident, ident, ident),
    "timed_ident": timed(ident),
    "quiet_ident": quiet(ident),
}


def ns_per_run(stmt: str, number: int = 1_000_000) -> float:
    """Return the best time of one execution of stmt, in ns."""
    runs = timeit.repeat(stmt, globals=ENV, number=number, repeat=25)
    return min(runs) / number * 1e9


def warm_up() -> float:
    """Re-measure the loop until two baselines agree within 5%."""
    previous = ns_per_run("x = 1", number=200_000)
    for _ in range(40):
        current = ns_per_run("x = 1", number=200_000)
        if abs(current - previous) <= 0.05 * previous:
            return current
        previous = current
    raise SystemExit("baseline never settled")


def main() -> None:
    """Measure each variant; mute the stderr line that timed prints."""
    settled = warm_up()
    base = ns_per_run("x = 1")
    print(f"baseline settled at {settled:.1f} ns, measured {base:.1f} ns")
    rows = [
        ("abs(1)  (C function)", "abs(1)"),
        ("ident(1)", "ident(1)"),
        ("quiet_ident(1)", "quiet_ident(1)"),
        ("three(1)  (compose of 3)", "three(1)"),
        ("perf_counter()", "perf_counter()"),
        ("f-string with :.1f", 'f"{q} took {ms:.1f} ms"'),
    ]
    for label, stmt in rows:
        ns = ns_per_run(stmt)
        print(f"{label:26} {ns:7.1f} ns  (+{ns - base:6.1f})")
    with redirect_stderr(io.StringIO()):
        ns = ns_per_run("timed_ident(1)", number=200_000)
    print(f"{'timed_ident(1)':26} {ns:7.1f} ns  (+{ns - base:6.1f})")
    end = ns_per_run("x = 1")
    print(f"baseline again: {end:.1f} ns")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p04/scratch/call_cost.py
baseline settled at 10.7 ns, measured 9.8 ns
abs(1)  (C function)          19.6 ns  (+   9.8)
ident(1)                      27.5 ns  (+  17.7)
quiet_ident(1)               673.0 ns  (+ 663.2)
three(1)  (compose of 3)     131.1 ns  (+ 121.3)
perf_counter()                56.2 ns  (+  46.4)
f-string with :.1f           246.2 ns  (+ 236.4)
timed_ident(1)               934.9 ns  (+ 925.1)
baseline again: 11.4 ns
```

（脚本开头的 `warm_up` 会反复量空循环，直到两次结果相差不到 5% 才开始；第一行打印它稳定到的基线，最后一行再量一次基线作对照。我跑了三次：`ident(1)` 比空循环多 14.7、17.7、12.3 ns，`three(1)` 多 119.0、121.3、125.8 ns，`timed_ident(1)` 多 938.7、925.1、937.2 ns，这里贴的是第二次。机器忙的时候这些数会变：在还没有 `warm_up` 的第一版脚本里，我见过 `ident(1)` 是 73.4 ns，比空闲时高好几倍。下面说的“十几纳秒”都指空闲的机器。）

读法是“减去 `x = 1` 那一行的循环开销”：

- 调用一个 C 函数 `abs(1)` 比空循环多约 10 ns，调用一个什么都不做的 Python 函数 `ident(1)` 多 12 到 18 ns（三次运行的范围），两者在一个量级。
- `three(1)`（`compose` 三个 `ident`，一共 4 次 Python 调用加一个 `for` 循环）比空循环多 119 到 126 ns。`compose` 每一层的成本是几十纳秒。
- `timed_ident(1)` 比空循环多 925 ns，比 `ident` 贵 50 多倍，但这几乎都不是“函数调用”的钱。我又写了一个不 `print` 的 `quiet` 版本，它仍然要多 663 ns。其中两次 `perf_counter()` 约 93 ns（各约 46 ns），一次 f-string 格式化约 236 ns，合计约 329 ns；剩下约 334 ns 是包装器本身的开销（多一层调用、`*args`/`**kwargs` 的打包与再展开、`try`/`finally`），我没有继续拆下去。`print` 到 `StringIO` 再加约 262 ns。

`ch04` 加的 `compose` 总共有 123 个文件乘以每个文件 2 次 `composed` 调用，即使按每次 200 ns 算，也不到 0.05 ms，占约 810 ms 的 0.006% 以下。这只算了 `compose` 自己的调用。拆分还改了别的（比如 `find_runs` 先把所有匹配收进一个列表），所以我另外把 `tokenize` 单独拿出来，交替运行两棵树，每次取 5 次里的最小值：

```python
"""Alternate ch03 and ch04 tokenize runs; time tokenize alone."""

import os
import statistics
import subprocess
import sys

ROUNDS = 15
SITE = os.environ["PYTHONPATH"].split(":", 1)[1]
CHILD = """
import timeit
from pathlib import Path

from sift.analysis.tokenize import tokenize
from sift.markdown import split_front_matter, strip_markdown

paths = sorted(Path("corpus/posts").glob("*.md"))
bodies = [
    strip_markdown(split_front_matter(p.read_text(encoding="utf-8"))[1])
    for p in paths
]
run = lambda: [tokenize(b) for b in bodies]
print(min(timeit.repeat(run, number=1, repeat=5)) * 1000)
"""


def tokenize_ms(tag: str) -> float:
    """Return the best-of-5 tokenize time in the tree of tag, in ms."""
    env = dict(os.environ, PYTHONPATH=f"/tmp/p04/{tag}/src:{SITE}")
    proc = subprocess.run(
        [sys.executable, "-c", CHILD],
        cwd=f"/tmp/p04/{tag}",
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    return float(proc.stdout)


def main() -> None:
    """Interleave the two trees so drift hits both equally."""
    times: dict[str, list[float]] = {"ch03": [], "ch04": []}
    for _ in range(ROUNDS):
        for tag, values in times.items():
            values.append(tokenize_ms(tag))
    for tag, values in times.items():
        print(
            f"{tag}: min {min(values):6.1f}  "
            f"median {statistics.median(values):6.1f}  "
            f"max {max(values):6.1f} ms"
        )
    lo = min(times["ch04"]) / min(times["ch03"])
    mid = statistics.median(times["ch04"]) / statistics.median(times["ch03"])
    print(f"ch04 / ch03: min {lo:.3f}, median {mid:.3f}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p04/scratch/tok_bench.py
ch03: min  395.7  median  401.7  max  404.5 ms
ch04: min  376.7  median  382.5  max  389.1 ms
ch04 / ch03: min 0.952, median 0.952
```

单独量 `tokenize`，`ch04` 的最小值是 376.7 ms，`ch03` 是 395.7 ms，没有变慢，反而快了约 5%；端到端的最小值比值是 0.992。两种量法方向一致，幅度不一样（5% 对 0.8%），我没有再追，也不解释为什么拆开之后反而快了一点。这个符号在别的机器或别的负载下很可能反过来，我能确认的只有：端到端没有可测的差别，`tokenize` 单独量也没有变慢到能被注意到。

至于为什么一次 Python 到 Python 的调用在空闲的机器上只要十几纳秒，可以直接读 CPython 3.14.7 的源码。`CALL` 指令在热路径上会被特化成 `CALL_PY_EXACT_ARGS`，`specialize.py` 能看到这个过程：

```python
"""Watch the interpreter specialize a call to a Python function."""

import dis


def ident(x):
    """Return x unchanged."""
    return x


def loop(n):
    """Call ident n times."""
    for _ in range(n):
        ident(1)


def main() -> None:
    """Disassemble loop before and after it has run 1000 times."""
    dis.dis(loop)
    loop(1000)
    print("--- after 1000 calls")
    dis.dis(loop, adaptive=True)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p04/scratch/specialize.py | grep -nE 'CALL|after'
5:              CALL                     1
12:              CALL                     1
20:--- after 1000 calls
25:              CALL                     1
32:              CALL_PY_EXACT_ARGS       1
```

调用 1000 次之后，`ident(1)` 那一行的 `CALL 1` 变成了 `CALL_PY_EXACT_ARGS 1`（第 32 行；第 25 行的 `CALL 1` 是 `range(n)`，C 函数，没有被特化成这个指令）。这条指令的定义在 CPython 的 `Python/bytecodes.c`，下面是 `v3.14.7` 里的原文，保留上游格式：

```text
$ curl -sL https://raw.githubusercontent.com/python/cpython/v3.14.7/Python/bytecodes.c \
    | sed -n '4041,4050p'
        macro(CALL_PY_EXACT_ARGS) =
            unused/1 + // Skip over the counter
            _CHECK_PEP_523 +
            _CHECK_FUNCTION_VERSION +
            _CHECK_FUNCTION_EXACT_ARGS +
            _CHECK_STACK_SPACE +
            _CHECK_RECURSION_REMAINING +
            _INIT_CALL_PY_EXACT_ARGS +
            _SAVE_RETURN_OFFSET +
            _PUSH_FRAME;
```

读这几行：先是五个“守卫”（没有人装 `eval_frame` 钩子；函数版本号和特化时一致，我的理解是函数的 `__code__` 之类被改写就会让它失效；实参个数正好；数据栈还有空间；递归深度没到上限），然后在线程自己的数据栈上预留一块帧空间并把实参拷进去（`_INIT_CALL_PY_EXACT_ARGS`），最后 `_PUSH_FRAME` 把“当前帧”指针指向它，**不递归调用 C 的求值函数**，继续在同一个解释器循环里取下一条指令。`_PUSH_FRAME` 里有这么几行：

```text
$ curl -sL https://raw.githubusercontent.com/python/cpython/v3.14.7/Python/bytecodes.c \
    | sed -n '4019,4021p'
            CALL_STAT_INC(inlined_py_calls);
            frame = tstate->current_frame = temp;
            tstate->py_recursion_remaining--;
```

`inlined_py_calls` 这个统计名字就说明了：Python 到 Python 的调用在解释器里是“内联”的。`py_recursion_remaining--` 是递归限制的真身：它数的是 Python 帧的深度，不是 C 栈的使用量。这可以验证：把递归限制调到一百万，递归 30 万层：

```python
"""Recursion depth: the limit counts Python frames, not C stack."""

import sys
from functools import cache


def count_down(n: int) -> int:
    """Recurse n frames deep and return 0."""
    return 0 if n == 0 else count_down(n - 1)


@cache
def total(n: int) -> int:
    """Sum 1..n recursively, remembering results."""
    return 0 if n == 0 else n + total(n - 1)


def main() -> None:
    """Show the limit, raise it, and show that a cache does not help."""
    print(sys.getrecursionlimit())
    sys.setrecursionlimit(1_000_000)
    print(count_down(300_000))
    sys.setrecursionlimit(1000)
    try:
        total(2000)
    except RecursionError as exc:
        print("RecursionError:", exc)
    for n in range(0, 2000, 100):
        total(n)
    print(total(2000))


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p04/scratch/recursion_depth.py
1000
0
RecursionError: maximum recursion depth exceeded
2001000
$ echo $?
0
```

30 万层 Python 递归没有爆 C 栈，没有 `Segmentation fault`，退出码是 0。`1000` 是默认的递归限制（`sys.getrecursionlimit()`）；脚本后半段讲缓存，放到 functools 一节。

这些都不意味着调用免费。把 `compose` 放到每个词元上，就是另一个故事：`per_token.py` 对语料的 812,338 个词元，每个调一次 `ident` 或一次 `compose` 三个 `ident`：

```python
"""Where call overhead shows up: one call per token, not per file."""

import timeit
from pathlib import Path

from sift.analysis.tokenize import tokenize
from sift.markdown import split_front_matter, strip_markdown
from sift.util import compose


def ident(token):
    """Return token unchanged."""
    return token


def best_ms(fn) -> float:
    """Return the best of 5 runs of fn, in ms."""
    return min(timeit.repeat(fn, number=1, repeat=5)) * 1000


def main() -> None:
    """Time a bare loop, ident per token and compose of 3 per token."""
    tokens = []
    for path in sorted(Path("corpus/posts").glob("*.md")):
        text = path.read_text(encoding="utf-8")
        body = strip_markdown(split_front_matter(text)[1])
        tokens.extend(tokenize(body))
    three = compose(ident, ident, ident)
    print(len(tokens), "tokens")
    loop = best_ms(lambda: [t for t in tokens])
    one = best_ms(lambda: [ident(t) for t in tokens])
    many = best_ms(lambda: [three(t) for t in tokens])
    print(f"loop only:       {loop:6.1f} ms")
    print(f"ident per token: {one:6.1f} ms")
    print(f"three per token: {many:6.1f} ms")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p04/scratch/per_token.py
812338 tokens
loop only:         11.3 ms
ident per token:   26.5 ms
three per token:  113.6 ms
```

空循环 11.3 ms，每个词元调一次 `ident` 是 26.5 ms，调一次三层 `compose` 是 113.6 ms，扣掉循环是 102.3 ms：约占建索引 808 ms 的 13%。同一个 `compose`，放在每个文件上是 0.05 ms 以下，放在每个词元上是 102.3 ms，差了 2,000 多倍，因为被调用的次数差了 3,300 倍（246 次对 812,338 次）。调用开销的账不看单次，看次数；按词元的粒度，我没有用在 Sift 里。

回到上面 `key_cost.py` 的那个问题：`itemgetter` 比 `lambda` 快的 31 ns 是什么？我的解释是一次 Python 帧的建立与销毁。`itemgetter(1)` 是 C 实现的可调用对象，`sorted` 调它的时候不需要给它建一个 Python 帧，`lambda r: r[1]` 需要。10 万次排序键调用省下来的是 10 万个帧，量级和上面的 12 到 18 ns 大致对得上（从 C 调进 Python 函数，比 Python 调 Python 多一点，这是我的猜测）。

## TF-IDF：打分是一个参数

排序要从“词频之和”换成 TF-IDF。思路是：一个词在越少的文档里出现，它对相关性的区分度越大。`scoring.py` 一共 20 行：

```python
"""Ranking: TF-IDF with a cached idf."""

import functools
import math


@functools.cache
def idf(df: int, n_docs: int) -> float:
    """Return the smoothed inverse document frequency of a term.

    ``log(1 + n_docs / df)`` stays positive even for a term that
    appears in every document. The result depends only on the two
    integers, so it is cached.
    """
    return math.log(1 + n_docs / df)


def tf_idf(tf: int, df: int, n_docs: int) -> float:
    """Return the TF-IDF weight of a term in one document."""
    return tf * idf(df, n_docs)
```

公式是：

$$
\mathrm{idf}(t) = \ln\left(1 + \frac{N}{\mathrm{df}(t)}\right), \qquad
\mathrm{score}(d) = \sum_{t \in q} \mathrm{tf}(t, d) \cdot \mathrm{idf}(t)
$$

$N$ 是文档总数，$\mathrm{df}(t)$ 是含有词 $t$ 的文档数。加 1 再取对数，是为了让出现在每个文档里的词（$N = \mathrm{df}$）也有一个正的权重，而不是 $\ln 1 = 0$。验证开头的 19.570：

```text
$ python3 -c "from sift.scoring import tf_idf, idf; \
print(round(tf_idf(7, 8, 123), 3), idf.cache_info().currsize)"
19.57 1
```

`7 × ln(1 + 123 / 8)` 是 19.57，`idf` 的缓存里存了 1 项。`search_index` 现在多了一个参数 `scoring: Callable[[int, int, int], float] = tf_idf`：打分函数是个参数，默认值就是 `tf_idf` 函数对象本身，所以 `tfidf_vs_tf.py` 可以传一个只返回 `tf` 的函数进去，拿到旧的排序，在同一个索引上比较两种排名：

```python
"""Top 3 by plain tf and by TF-IDF; idf cache hit rate on the corpus."""

from sift.__main__ import CORPUS, load_index, search_index
from sift.scoring import idf

QUERIES = ["linux device", "矩阵 matrix", "python function"]


def plain_tf(tf: int, df: int, n_docs: int) -> float:
    """Score a term by its raw frequency, ignoring df."""
    return tf


def main() -> None:
    """Compare the two rankings, then report idf cache statistics."""
    paths, index = load_index(CORPUS)
    n_docs = len(paths)
    idf.cache_clear()
    for query in QUERIES:
        words = query.split()
        by_tf = search_index(index, words, n_docs, plain_tf)
        by_idf = search_index(index, words, n_docs)
        print(f"query: {query!r}: {len(by_idf)} hits")
        print("  plain tf")
        for score, doc_id in by_tf[:3]:
            print(f"    {score:8.0f}  {paths[doc_id].name}")
        print("  tf-idf")
        for score, doc_id in by_idf[:3]:
            print(f"    {score:8.3f}  {paths[doc_id].name}")
    info = idf.cache_info()
    calls = info.hits + info.misses
    print(info)
    print(f"idf calls {calls}, hit rate {info.hits / calls:.4%}")
```

```text
$ python3 lab/ch04/tfidf_vs_tf.py
load_index took 2163.3 ms
query: 'linux device': 6 hits
  plain tf
          54  understanding-kbuild.md
          52  understanding-qemu.md
          44  understanding-kconfig.md
  tf-idf
     127.369  understanding-qemu.md
      90.564  understanding-kbuild.md
      74.271  understanding-kconfig.md
query: '矩阵 matrix': 23 hits
  plain tf
          82  linear-algebra-11-matrix-spaces-rank-one.md
          78  linear-algebra-25-symmetric-positive-definite.md
          57  linear-algebra-28-similar-matrices-jordan.md
  tf-idf
      97.581  linear-algebra-11-matrix-spaces-rank-one.md
      92.245  linear-algebra-25-symmetric-positive-definite.md
      69.335  pid-control-09-lqr.md
query: 'python function': 7 hits
  plain tf
          75  rust-by-pebble-09-interpreter-closures.md
          40  rust-by-pebble-08-rc-refcell-values.md
          29  gdb-debugging-guide.md
  tf-idf
     124.095  rust-by-pebble-09-interpreter-closures.md
      66.114  rust-by-pebble-08-rc-refcell-values.md
      46.235  rust-by-pebble-12-vm-backends.md
CacheInfo(hits=66, misses=6, maxsize=None, currsize=6)
idf calls 72, hit rate 91.6667%
```

三个查询、前三名：

- `linux device`：词频排序是 `kbuild`、`qemu`、`kconfig`，TF-IDF 排序是 `qemu`、`kbuild`、`kconfig`，前两名换了位置。
- `矩阵 matrix`：前两名一样，第三名词频是 `linear-algebra-28-similar-matrices-jordan`，TF-IDF 变成了 `pid-control-09-lqr`。
- `python function`：前两名一样，第三名从 `gdb-debugging-guide` 变成了 `rust-by-pebble-12-vm-backends`。

查询只有一个词时两种排序必然一致（上面 `kalman` 的 md5 是一个例子）。多个词的时候，每个词的 idf 不一样，TF-IDF 会让稀有词的出现更重要。拿 `linux device` 看看是为什么：

```python
"""Per-term df, idf and tf behind the 'linux device' ranking change."""

from pathlib import Path

from sift.__main__ import CORPUS, load_index
from sift.scoring import idf


def main() -> None:
    """Print df, idf and the tf in two documents for each query term."""
    paths, index = load_index(CORPUS)
    n_docs = len(paths)
    stems = ["kbuild", "qemu"]
    doc_ids = {
        s: paths.index(Path(CORPUS, f"understanding-{s}.md")) for s in stems
    }
    for term in ("linux", "device"):
        postings = index[term]
        df = len(postings)
        row = f"{term:7} df {df:3}  idf {idf(df, n_docs):.3f}"
        for stem, doc_id in doc_ids.items():
            row += f"  tf[{stem}] {postings[doc_id]:3}"
        print(row)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p04/scratch/df_terms.py
load_index took 835.1 ms
linux   df  30  idf 1.629  tf[kbuild]  52  tf[qemu]  19
device  df   7  idf 2.922  tf[kbuild]   2  tf[qemu]  33
```

`linux` 出现在 30 个文档里，idf 是 1.629；`device` 只出现在 7 个文档里，idf 是 2.922。`kbuild` 里 `linux` 52 次、`device` 2 次，词频之和 54，TF-IDF 是 `52 × 1.629 + 2 × 2.922 = 90.56`；`qemu` 里 `linux` 19 次、`device` 33 次，词频之和 52，TF-IDF 是 `19 × 1.629 + 33 × 2.922 = 127.37`。哪一种排序更好，我没有逐篇判断，也没有标注数据可以量；这里能确认的只是：两种排序确实不同，而差别来自 idf。

## functools

`scoring.py` 里的 `@functools.cache` 只是这个标准库模块的一角。先看它在 `idf` 上值不值，再把其余的过一遍。

### cache：idf 的缓存值得吗

`idf` 上面有 `@functools.cache`：同样的 `(df, n_docs)` 只算一次。理由是 `idf` 只依赖两个整数，而一次查询里每个命中文档都会调用一次它。`idf_cache.py` 看命中率，并且把缓存拿掉再量一遍：

```python
"""idf cache hit rate per query, and what the cache buys."""

import functools
import timeit

import sift.scoring
from sift.__main__ import CORPUS, load_index, search_index
from sift.scoring import idf

QUERIES = ["kalman", "kalman filter", "linux kernel module", "rust", "the"]


def main() -> None:
    """Report cache_info per query, then time cached vs uncached idf."""
    paths, index = load_index(CORPUS)
    n_docs = len(paths)
    for query in QUERIES:
        idf.cache_clear()
        hits = search_index(index, query.split(), n_docs)
        info = idf.cache_info()
        calls = info.hits + info.misses
        rate = info.hits / calls if calls else 0.0
        print(
            f"{query!r:24} {len(hits):3} docs  calls {calls:4}  "
            f"misses {info.misses}  hit rate {rate:.2%}"
        )

    cached = idf
    uncached = idf.__wrapped__
    words = ["rust"]
    for label, fn in (("cached", cached), ("uncached", uncached)):
        sift.scoring.idf = fn
        best = min(
            timeit.repeat(
                lambda: search_index(index, words, n_docs),
                number=20,
                repeat=7,
            )
        )
        print(f"search 'rust', {label:8}: {best / 20 * 1000:.3f} ms")
    sift.scoring.idf = cached
    for label, fn in (("cached", cached), ("uncached", uncached)):
        call = functools.partial(fn, 30, 123)
        t = min(timeit.repeat(call, number=10**6, repeat=5))
        print(f"idf(30, 123), {label:8}: {t * 1000:.1f} ns per call")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p04/scratch/idf_cache.py
load_index took 812.3 ms
'kalman'                   8 docs  calls    8  misses 1  hit rate 87.50%
'kalman filter'            5 docs  calls   10  misses 2  hit rate 80.00%
'linux kernel module'      2 docs  calls    6  misses 3  hit rate 50.00%
'rust'                    43 docs  calls   43  misses 1  hit rate 97.67%
'the'                     78 docs  calls   78  misses 1  hit rate 98.72%
search 'rust', cached  : 0.033 ms
search 'rust', uncached: 0.039 ms
idf(30, 123), cached  : 46.7 ns per call
idf(30, 123), uncached: 156.5 ns per call
```

`kalman` 8 个命中文档，`idf` 调了 8 次，1 次未命中（`df` 只有一个值），命中率 87.5%；`rust` 命中 43 个文档，命中率 97.67%；`the` 78 个文档，98.72%。前一节 `tfidf_vs_tf.py` 三个查询加起来是 72 次调用、6 次未命中，命中率 91.6667%。命中率不低，但钱呢：`idf(30, 123)` 一次调用，缓存命中 46.7 ns，不缓存 156.5 ns，一次省 110 ns；`search rust` 这个查询整个，有缓存 0.033 ms，没缓存 0.039 ms，慢了约 18%。（这里的 `sift.scoring.idf = fn` 能生效，就是前面说的“`LOAD_GLOBAL` 在调用时才找名字”。）`idf` 的类型可以直接问：

```text
$ python3 -c "from sift.scoring import idf; print(type(idf))"
<class 'functools._lru_cache_wrapper'>
```

所以对 `idf` 这个函数，`@cache` 帮不上大忙：`math.log` 本来就快，而 Python 层的调用开销没法被缓存消掉（缓存命中也要走一次调用，`idf` 本身是一个 `_lru_cache_wrapper` 对象）。我加它是为了演示接口，更适合它的场景是下面这种。

### partial、reduce 与 singledispatch

`functools_tour.py` 的主要内容：

```python
def fib_naive(n: int) -> int:
    """Return the n-th Fibonacci number, recomputing everything."""
    return n if n < 2 else fib_naive(n - 1) + fib_naive(n - 2)


@cache
def fib_cached(n: int) -> int:
    """Return the n-th Fibonacci number, remembering each result."""
    return n if n < 2 else fib_cached(n - 1) + fib_cached(n - 2)


@lru_cache(maxsize=2)
def square(n: int) -> int:
    """Return n squared; keep only the 2 most recent results."""
    return n * n


@singledispatch
def describe(obj) -> str:
    """Describe obj by its type; the default case."""
    return f"object {obj!r}"


@describe.register
def _(obj: int) -> str:
    return f"int with {obj.bit_length()} bits"


@describe.register
def _(obj: list) -> str:
    return f"list of {len(obj)} items"


@describe.register
def _(obj: Path) -> str:
    return f"path named {obj.name}"

```

```python
def main() -> None:
    """Tour the module and time fib(30) both ways."""
    int16 = partial(int, base=16)
    print(int16("ff"), int16.func, int16.args, int16.keywords)

    for n in (1, 2, 1, 3, 1):
        square(n)
    print(square.cache_info())
    square.cache_clear()
    print(square.cache_info())

    print(reduce(lambda a, b: a * b, range(1, 6)))
    print(reduce(lambda a, b: a + b, [[1], [2, 3], [4]], []))
    print(reduce(max, [3, 9, 2], 0))

    for value in (7, [1, 2], Path("a/b.md"), 3.5):
        print(describe(value))
    print(sorted(t.__name__ for t in describe.registry))

    start = time.perf_counter()
    naive = fib_naive(30)
    t_naive = time.perf_counter() - start
    start = time.perf_counter()
    cached = fib_cached(30)
    t_cached = time.perf_counter() - start
    assert naive == cached
    print(f"fib(30) = {naive}")
    print(f"naive:  {t_naive * 1000:10.3f} ms")
    print(f"cached: {t_cached * 1000:10.3f} ms")
    print(f"speedup: {t_naive / t_cached:.0f}x")
    print(fib_cached.cache_info())
    print(functools.cache.__name__)
```

```text
$ python3 lab/ch04/functools_tour.py
255 <class 'int'> () {'base': 16}
CacheInfo(hits=2, misses=3, maxsize=2, currsize=2)
CacheInfo(hits=0, misses=0, maxsize=2, currsize=0)
120
[1, 2, 3, 4]
9
int with 3 bits
list of 2 items
path named b.md
object 3.5
['Path', 'int', 'list', 'object']
fib(30) = 832040
naive:     261.390 ms
cached:      0.067 ms
speedup: 3902x
CacheInfo(hits=28, misses=31, maxsize=None, currsize=31)
cache
```

- `partial(int, base=16)` 固定一部分参数，得到新的可调用对象；`.func`、`.args`、`.keywords` 都能直接读。
- `lru_cache(maxsize=2)` 只留最近的 2 个结果：`for n in (1, 2, 1, 3, 1)` 之后 `CacheInfo(hits=2, misses=3, maxsize=2, currsize=2)`，`cache_clear()` 清空。`@cache` 等价于 `lru_cache(maxsize=None)`，不限大小。
- `reduce` 把二元函数折叠一个序列：`reduce(lambda a, b: a * b, range(1, 6))` 是 120；第三个参数是初值。
- `singledispatch` 按第一个参数的类型分派：`int`、`list`、`Path` 各有自己的实现，`3.5` 落到默认的 `object` 上。`describe.registry` 保存分派表。
- `fib(30)`：朴素递归 261.390 ms，缓存版 0.067 ms，快了 3,902 倍。`CacheInfo(hits=28, misses=31, ...)`：计算 `fib(30)` 只需要算 `fib(0)` 到 `fib(30)` 这 31 个值各一次，其余 28 次调用都命中。朴素版调用了约 269 万次 `fib_naive`，缓存版一共 59 次。

缓存不能消除递归深度。前面 `recursion_depth.py` 的后半段（`total` 是带 `@cache` 的递归求和）：

```python
    sys.setrecursionlimit(1000)
    try:
        total(2000)
    except RecursionError as exc:
        print("RecursionError:", exc)
    for n in range(0, 2000, 100):
        total(n)
    print(total(2000))
```

`total(2000)` 在默认限制 1000 下抛 `RecursionError: maximum recursion depth exceeded`（输出第三行），缓存根本没用上，因为第一次计算要一路递归下去。`for n in range(0, 2000, 100): total(n)` 先每隔 100 暖一次缓存，每次递归深度不超过 100，最后 `total(2000)` 只需要往下走 100 层就命中缓存，得到 2001000。

## 注解

`tf_idf(tf: int, df: int, n_docs: int) -> float` 里的 `: int` 和 `-> float` 是注解，解释器不检查它们，只把它们存在 `__annotations__` 里（前面 `fn_object.py` 的输出里有）。检查是类型检查器的事，后面讲类型的时候再说。这一篇只谈一件和函数有关、3.14 里才变的事：注解什么时候求值。

`annotations_314.py` 让一个注解引用一个还不存在的名字：

```python
class Node:
    """A tree node; the annotation names a class not yet defined."""

    def __init__(self, parent: Node | None, kids: list[Node]) -> None:
        self.parent = parent
        self.kids = kids


def link(a: Node, b: Missing) -> Missing:  # noqa: F821
    """Annotate with a name that never exists."""
    return b


def main() -> None:
    """Read annotations in each format."""
    # 3.14 起注解延迟求值：Node 在方法定义时还不存在，也不需要引号
    print(Node.__init__.__annotations__)
    print(annotationlib.get_annotations(Node.__init__))

    # Missing 从未定义；VALUE 格式求值会失败，另外两种不会
    try:
        print(link.__annotations__)
    except NameError as exc:
        print(f"NameError: {exc}")
    fwd = annotationlib.get_annotations(link, format=Format.FORWARDREF)
    print(fwd)
    print(type(fwd["b"]).__name__)
    print(annotationlib.get_annotations(link, format=Format.STRING))

    print(Node.__init__.__annotate__ is not None)
    print(annotationlib.get_annotations(Node.__init__, format=Format.STRING))
```

```text
$ python3 lab/ch04/annotations_314.py
{'parent': __main__.Node | None, 'kids': list[__main__.Node], 'return': None}
{'parent': __main__.Node | None, 'kids': list[__main__.Node], 'return': None}
NameError: name 'Missing' is not defined
{'a': <class '__main__.Node'>, 'b': ForwardRef('Missing', owner=<function link at 0x7ffff6e7a820>), 'return': ForwardRef('Missing', owner=<function link at 0x7ffff6e7a820>)}
ForwardRef
{'a': 'Node', 'b': 'Missing', 'return': 'Missing'}
True
{'parent': 'Node | None', 'kids': 'list[Node]', 'return': 'None'}
```

同样的写法在 3.13 上是什么样，可以直接跑（`python3.13`，不是 `nix develop` 里默认的 3.14.7；这个探针故意写在模块级，因为错误就发生在类定义时）：

```python
"""Before 3.14, annotations run when def runs (expected failure)."""


class Node:
    """A method annotation that names Node before Node exists."""

    # error: NameError: name 'Node' is not defined
    def __init__(self, parent: Node | None) -> None:  # noqa: F821
        self.parent = parent
```

```text
$ python3.13 -VV
Python 3.13.15 (main, Aug  5 2026, 12:25:43) [GCC 15.3.0]
$ python3.13 /tmp/p04/scratch/ann313.py
Traceback (most recent call last):
  File "/tmp/p04/scratch/ann313.py", line 4, in <module>
    class Node:
    ...<4 lines>...
            self.parent = parent
  File "/tmp/p04/scratch/ann313.py", line 8, in Node
    def __init__(self, parent: Node | None) -> None:  # noqa: F821
                               ^^^^
NameError: name 'Node' is not defined. Did you mean: 'None'?
```

3.13 在 `def` 执行的那一刻就对注解求值，`Node` 还没绑定，直接 `NameError`；我没有在 3.13 上逐个验证常见的绕法，据我所知是把注解写成字符串，或者加 `from __future__ import annotations`。3.14 起注解延迟求值：`def` 不再计算它们，而是生成一个 `__annotate__` 函数，第一次有人读 `__annotations__` 时才调用（输出第 7 行的 `True` 就是 `__annotate__ is not None`）。上面的输出里：

- `Node.__init__.__annotations__` 读出了 `Node | None`，没写引号，没有 `NameError`。
- `link.__annotations__` 要求一个从未定义的 `Missing`，读的那一刻抛 `NameError: name 'Missing' is not defined`，这是 `Format.VALUE`（默认格式）。
- `Format.FORWARDREF` 对读不出的名字返回 `ForwardRef('Missing', ...)`，读得出的（`Node`）仍然是真正的类。
- `Format.STRING` 把所有注解都还原成源码字符串，`'Node | None'`、`'list[Node]'`，不求值。

`annotationlib` 是 3.14 新加的标准库模块，专门用来读注解。

## 递归与没有尾调用消除

CPython 不做尾调用消除。`recursion_limit_fail.py` 写的是尾调用形式的倒数：

```python
def count_down(n):
    """Count down to zero in tail-call form."""
    if n == 0:
        return 0
    return count_down(n - 1)


def main() -> None:
    """Recurse past the limit on purpose."""
    print(sys.getrecursionlimit())
    print(count_down(500))
    # error: RecursionError: maximum recursion depth exceeded
    print(count_down(10**6))
```

```text
$ python3 lab/ch04/recursion_limit_fail.py
1000
0
Traceback (most recent call last):
  File "/home/bfmhno3/Projects/sift/lab/ch04/recursion_limit_fail.py", line 22, in <module>
    main()
    ~~~~^^
  File "/home/bfmhno3/Projects/sift/lab/ch04/recursion_limit_fail.py", line 18, in main
    print(count_down(10**6))
          ~~~~~~~~~~^^^^^^^
  File "/home/bfmhno3/Projects/sift/lab/ch04/recursion_limit_fail.py", line 10, in count_down
    return count_down(n - 1)
  File "/home/bfmhno3/Projects/sift/lab/ch04/recursion_limit_fail.py", line 10, in count_down
    return count_down(n - 1)
  File "/home/bfmhno3/Projects/sift/lab/ch04/recursion_limit_fail.py", line 10, in count_down
    return count_down(n - 1)
  [Previous line repeated 995 more times]
RecursionError: maximum recursion depth exceeded
$ echo $?
1
```

`count_down(500)` 正常，`count_down(10**6)` 在默认限制下抛 `RecursionError`。回溯里的 `[Previous line repeated 995 more times]` 是解释器把重复的帧折叠起来了。即使写成 `return count_down(n - 1)` 这样严格的尾调用，每次调用仍然要 `_PUSH_FRAME` 一个新帧。我的猜测是，CPython 保留每一帧是为了给回溯留下完整的调用链，但这是我的猜测，没有去查设计文档。

默认的 1000 层限制是个保险丝，不是物理极限。前面那个把限制调到一百万、递归 30 万层的实验说明了这一点：至少在 30 万层的深度上，C 栈没有先爆。要写深递归，老老实实改成循环，或者用显式的栈。

## 跑一遍

整章一个 `make` 目标全跑一遍，再加 `make lint`：

```text
$ make ch04
python3 scripts/chapter.py ch04
ok   lab/ch04/annotations_314.py
ok   lab/ch04/closures.py
ok   lab/ch04/decorators.py
ok   lab/ch04/first_class.py
ok   lab/ch04/functools_tour.py
ok   lab/ch04/keyword_only_fail.py
ok   lab/ch04/mutable_default.py
ok   lab/ch04/operator_module.py
ok   lab/ch04/params.py
ok   lab/ch04/recursion_limit_fail.py
ok   lab/ch04/scopes.py
ok   lab/ch04/tfidf_vs_tf.py
ok   lab/ch04/unbound_local_fail.py
$ make lint
ruff format --check --line-length 79 .
59 files already formatted
ruff check .
All checks passed!
```

`keyword_only_fail.py`、`unbound_local_fail.py`、`recursion_limit_fail.py` 这三行也是 `ok`，因为运行器知道 `_fail.py` 结尾的文件应该非零退出。

## 本篇文件

[`lab/ch04`](https://github.com/bfmhno3/sift/tree/ch04/lab/ch04) 下的 13 个文件和这一章改过的四个 `src/sift` 文件。结果列是我在本篇的环境里重新跑出来的。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`src/sift/util.py`](https://github.com/bfmhno3/sift/blob/ch04/src/sift/util.py) | `python3 -c 'from sift.util import compose; print(compose(str.strip, str.upper)(" a "))'` | 退出码 0，输出 `A`；37 行 |
| [`src/sift/scoring.py`](https://github.com/bfmhno3/sift/blob/ch04/src/sift/scoring.py) | `python3 -c 'from sift.scoring import tf_idf; print(round(tf_idf(7, 8, 123), 3))'` | 退出码 0，输出 `19.57`；20 行 |
| [`src/sift/analysis/tokenize.py`](https://github.com/bfmhno3/sift/blob/ch04/src/sift/analysis/tokenize.py) | `python3 -c 'from sift.analysis.tokenize import tokenize; print(tokenize("Rust 所有权 C++"))'` | 退出码 0，输出 `['rust', '所有', '有权', 'c++']`；59 行 |
| [`src/sift/__main__.py`](https://github.com/bfmhno3/sift/blob/ch04/src/sift/__main__.py) | `python3 -m sift search kalman` | 退出码 0，stdout 第一行 `  19.570  corpus/posts/kalman-filter-02-multivariate.md`，stderr 一行 `load_index took ... ms`；107 行 |
| [`lab/ch04/params.py`](https://github.com/bfmhno3/sift/blob/ch04/lab/ch04/params.py) | `python3 lab/ch04/params.py` | 退出码 0，第一行 `(1, 2, 3) (1, 2, 3)` |
| [`lab/ch04/mutable_default.py`](https://github.com/bfmhno3/sift/blob/ch04/lab/ch04/mutable_default.py) | `python3 lab/ch04/mutable_default.py` | 退出码 0，第一行 `['a', 'b'] ['a', 'b']` |
| [`lab/ch04/keyword_only_fail.py`](https://github.com/bfmhno3/sift/blob/ch04/lab/ch04/keyword_only_fail.py) | `python3 lab/ch04/keyword_only_fail.py` | 退出码 1：`TypeError: search() takes 1 positional argument but 2 were given` |
| [`lab/ch04/scopes.py`](https://github.com/bfmhno3/sift/blob/ch04/lab/ch04/scopes.py) | `python3 lab/ch04/scopes.py` | 退出码 0，第一行 `L: local` |
| [`lab/ch04/unbound_local_fail.py`](https://github.com/bfmhno3/sift/blob/ch04/lab/ch04/unbound_local_fail.py) | `python3 lab/ch04/unbound_local_fail.py` | 退出码 1：`UnboundLocalError: cannot access local variable 'total' where it is not associated with a value` |
| [`lab/ch04/closures.py`](https://github.com/bfmhno3/sift/blob/ch04/lab/ch04/closures.py) | `python3 lab/ch04/closures.py` | 退出码 0，第五行 `[2, 2, 2]`（第一行里的 cell 地址每次不同） |
| [`lab/ch04/first_class.py`](https://github.com/bfmhno3/sift/blob/ch04/lab/ch04/first_class.py) | `python3 lab/ch04/first_class.py` | 退出码 0，第一行 `shout SIFT!` |
| [`lab/ch04/decorators.py`](https://github.com/bfmhno3/sift/blob/ch04/lab/ch04/decorators.py) | `python3 lab/ch04/decorators.py` | 退出码 0，第一行 `plain: calling f_plain` |
| [`lab/ch04/functools_tour.py`](https://github.com/bfmhno3/sift/blob/ch04/lab/ch04/functools_tour.py) | `python3 lab/ch04/functools_tour.py` | 退出码 0，第一行 `255 <class 'int'> () {'base': 16}`（`fib(30)` 的计时每次不同） |
| [`lab/ch04/operator_module.py`](https://github.com/bfmhno3/sift/blob/ch04/lab/ch04/operator_module.py) | `python3 lab/ch04/operator_module.py` | 退出码 0，第一行 `5 20 True` |
| [`lab/ch04/annotations_314.py`](https://github.com/bfmhno3/sift/blob/ch04/lab/ch04/annotations_314.py) | `python3 lab/ch04/annotations_314.py` | 退出码 0，第一行 `{'parent': __main__.Node \| None, 'kids': list[__main__.Node], 'return': None}` |
| [`lab/ch04/recursion_limit_fail.py`](https://github.com/bfmhno3/sift/blob/ch04/lab/ch04/recursion_limit_fail.py) | `python3 lab/ch04/recursion_limit_fail.py` | 退出码 1：先打印 `1000` 和 `0`，随后 `RecursionError: maximum recursion depth exceeded` |
| [`lab/ch04/tfidf_vs_tf.py`](https://github.com/bfmhno3/sift/blob/ch04/lab/ch04/tfidf_vs_tf.py) | `python3 lab/ch04/tfidf_vs_tf.py` | 退出码 0，stdout 第一行 `query: 'linux device': 6 hits`，最后一行 `idf calls 72, hit rate 91.6667%` |

`tfidf_vs_tf.py` 是这一章额外的一个实验，上面 TF-IDF 一节里三个查询的对比就是它的输出。

## 练习

**1.** 预测下面这段代码的输出，再运行。然后用两种办法让它输出 `[0, 1, 2]`：一种用默认参数，一种用 `functools.partial`。

```python
fns = [lambda: i for i in range(3)]
print([f() for f in fns])
```

**2.** 给 `timed` 加一个可选的参数，写成 `@timed(unit="s")` 和 `@timed` 都能用的装饰器。提示：参数的类型决定了你拿到的是函数还是字符串；想一想 `functools.wraps` 要装在哪一层。用 `wraps_check.py` 的办法确认 `__name__` 和 `__wrapped__` 还在。

**3.** 用 `functools.reduce` 重写 `compose`，再用 `per_token.py` 的办法量一下它每次调用的成本。我猜差别不大，但我没有量过：先预测，再验证。再写一个“从右往左”的 `compose_right`，用它重写 `analyze_file`，想一想哪个顺序读起来更贴近数据流。

**4.** 在 `tfidf_vs_tf.py` 的基础上，把 `bench/queries.txt` 里能当作“空格分隔词”的查询挑出来（比如 `kalman filter`、`linux kernel module`、`cmake vcpkg`），统计 TF-IDF 排序和词频排序下第一名不同的有几个。多个词、每个词 idf 差得越大，两种排序越容易不同，这个猜想对不对？

## 下一篇

下一篇是《[迭代器与生成器：惰性的建索引流水线](/posts/python-by-sift-05-iterators-generators/)》。这一篇里的 `map(len, words)` 打印出 `<map object ...>`，`load_index` 把 123 个文档的词元列表全部放进内存才开始建索引，`compose` 一次只处理一个完整的值：它们都在等一个“一次只给一个、用到才算”的办法。我猜把流水线改成惰性的之后，内存会下降得比时间多，但这只是猜测，到时候要先量一量。
