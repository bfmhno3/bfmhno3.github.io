---
title: "迭代器与生成器：惰性的建索引流水线"
commentId: "post:python-by-sift-05-iterators-generators"
published: "2026-10-22 05:00:00 +08:00"
description: "用 Sift 重学 Python 第 5 篇：我在 Python 3.14.7 里把建索引的数据流改成惰性的，文档读取、分词和 build_index 之间一次只传一个文档；同样数 812338 个词元，先收进列表的峰值内存是 45950 KiB，边流边数是 2447 KiB（18.8 倍），时间几乎一样，而换成 Token 之后整个 load_index 反而慢了约 1.6 倍。"
category: Tutorial
tags:
  - Python
  - Sift
  - 迭代器
  - 生成器
  - itertools
series: "用 Sift 重学 Python"
seriesOrder: 5
draft: false
comment: true
slug: python-by-sift-05-iterators-generators
---

上一篇结束时，`load_index` 把 123 篇文章的词元全部放进列表，才开始建索引。我这一篇把这条流水线改成每次只放一个文档过去，然后用同一份语料、同样的 812338 个词元，把“先收进列表再数”和“边流边数、数完就扔”各跑了一遍：

```text
$ python3 lab/ch05/genexp_vs_list.py | head -n 6
tokens via list:   812338
tokens via stream: 812338
same count: True
peak memory, list:        45950 KiB
peak memory, stream:       2447 KiB
peak ratio list/stream: 18.8x
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch05`：新增 `src/sift/corpus.py`（`RawDoc` 和惰性的 `iter_documents`）；`src/sift/analysis/tokenize.py` 加上 `Token` 和 `iter_tokens`，`tokenize` 退化成一个薄封装；`src/sift/index.py` 的 `build_index` 改成消费 `(doc_id, terms)` 流；`src/sift/__main__.py` 的 `load_index` 接上这条流。这四个文件之后的章节都还会改，没有哪个是终稿。`make ch05` 通过，`lab/ch05` 下 10 个文件按预期退出（8 个正常，2 个按预期失败）。
> 涉及的 Python 特性：可迭代对象与迭代器的区别、`iter()`/`next()` 与 `StopIteration`、`for` 的脱糖、生成器作为可恢复的帧、生成器表达式、`yield from`、`send`/`throw`/`close`、惰性与内存、`itertools`、`enumerate`/`zip`/`reversed`/`range`、`pathlib.Path.rglob` 初探、PEP 479。
> 前置：[第 4 篇](/posts/python-by-sift-04-functions/)，需要会进 `nix develop`、读懂 `compose` 和 `build_index`。

18.8 倍是个不错的数字，但它只回答了一半的问题：时间没有省，而且这条惰性的流水线在整个 `load_index` 上其实比上一篇慢（后面会量）。这一篇我从 `for` 循环背后的两个方法开始，把迭代器、生成器、`itertools` 一个一个拆开，再回到 Sift：文件读取、分词、建索引三段接成一条流，每一段都只在下一段伸手要的时候才干活。

## 环境

和前几篇一样的机器，仓库在标签 `ch05`：

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ git describe --tags
ch05
```

CPU 是 AMD Ryzen 7 PRO 6850U，内存 30 GiB。这一篇的计时有上一篇说过的那个毛病：隔一阵子再起的单次运行，比连续运行慢得多，今天 `python3 -m sift` 报告的建索引时间我见过 1286 ms 到 3491 ms。我猜是 CPU 在空闲后要一小会儿才升频，但没有去验证。所以 `ch04` 和 `ch05` 之间的对比，以及 `token_cost.py`、`strings_probe.py`，我都把两边交替运行，取最小值和中位数，并把原始输出贴出来。`genexp_vs_list.py` 先跑 3 次列表版再跑 3 次流式版，`pipeline.py` 每个版本只跑一次、惰性版在前，它们的时间比值只能当量级看。贴出来的是某一次运行的原样输出，重跑时内存数会差几 KiB，时间数会差几 ms 到几十 ms。lab 文件里嵌套定义的小函数和类（比如 `Squares`、`peek`）不逐个标注类型，这一点我只在这里说一次。

`ch04` 和 `ch05` 要放在同一个会话里比，做法和上一篇一样：用 `git archive` 各导出一份到 `/tmp/p05`，语料用符号链接共享。`PYTHONPATH` 在 `nix develop` 里是“仓库的 `src`，冒号，site-packages”，函数 `at` 把第一项换成导出目录：

```bash
mkdir -p /tmp/p05/ch04 /tmp/p05/ch05 /tmp/p05/scratch
git -C ~/Projects/sift archive ch04 | tar -x -C /tmp/p05/ch04
git -C ~/Projects/sift archive ch05 | tar -x -C /tmp/p05/ch05
ln -s ~/Projects/sift/corpus /tmp/p05/ch04/corpus
ln -s ~/Projects/sift/corpus /tmp/p05/ch05/corpus
SITE=${PYTHONPATH#*:}
at() { (cd /tmp/p05/$1 && PYTHONPATH=/tmp/p05/$1/src:$SITE python3 "${@:2}"); }
```

正文里的脚本分两类：`lab/ch05` 里的是仓库文件，节选处用行号标明；放在 `/tmp/p05/scratch/` 的是只为这篇写的小脚本，不进仓库，我都贴全文，带 `main()` 和 `__main__` 守卫。除非另说，命令都在仓库根目录 `~/Projects/sift` 里运行。需要看 CPython 源码的地方，我直接 `curl` `v3.14.7` 标签下的原文，保留上游格式。

## for 循环背后的两个方法

`for x in obj` 在字节码里是两件事：先对 `obj` 调一次 `iter()` 拿到迭代器，然后反复对迭代器调 `next()`，直到它抛 `StopIteration`。可迭代对象（iterable）是“能给我一个迭代器”的东西，有 `__iter__`；迭代器（iterator）是“能一个一个给我值”的东西，有 `__next__`，而且它自己的 `__iter__` 返回它自己。

`lab/ch05/iter_protocol.py` 先手写一个迭代器类（第 6 到 20 行）：

```python
class Countdown:
    """An iterator that counts down from start to 1."""

    def __init__(self, start: int) -> None:
        self.current = start

    def __iter__(self) -> Self:
        return self

    def __next__(self) -> int:
        if self.current <= 0:
            raise StopIteration
        value = self.current
        self.current -= 1
        return value
```

`main` 里先问列表和它的迭代器各自有什么（第 26 到 30 行），再手动驱动 `Countdown`，最后把 `for` 展开成 `while True` 加 `try`（第 43 到 50 行）：

```python
    numbers = [10, 20, 30]
    print("list is iterable:", hasattr(numbers, "__iter__"))
    print("list is an iterator:", hasattr(numbers, "__next__"))
    it = iter(numbers)
    print("iter(list):", type(it).__name__, it is iter(it))
    print("two iter() calls differ:", iter(numbers) is not iter(numbers))
    # ...
    # for item in Countdown(3): body, written out by hand
    iterator = iter(Countdown(3))
    while True:
        try:
            item = next(iterator)
        except StopIteration:
            break
        print("desugared:", item)
```

```text
$ python3 lab/ch05/iter_protocol.py
list is iterable: True
list is an iterator: False
iter(list): list_iterator True
two iter() calls differ: True
iter(c) is c: True
3 2 1
fourth next(): StopIteration
next with default: done
for loop: [3, 2, 1]
desugared: 3
desugared: 2
desugared: 1
old protocol: [0, 1, 4, 9]
```

列表是可迭代的，不是迭代器；每次 `iter(列表)` 给一个新的 `list_iterator`，它们互相独立；迭代器的 `iter()` 返回自己。最后一行是最老的协议：一个类只要有 `__getitem__`（第 52 到 59 行的 `Squares`），没有 `__iter__`，`list()` 照样能迭代它，办法是从 0 开始喂下标，直到 `IndexError`：

```python
    # Without __iter__ an object with __getitem__ still works.
    class Squares:
        def __getitem__(self, i: int) -> int:
            if i >= 4:
                raise IndexError
            return i * i

    print("old protocol:", list(Squares()))
```

`iter()` 的真身是 C 函数 `PyObject_GetIter`。它做的正是上面这几件事，下面是 `v3.14.7` 的原文：

```text
$ curl -sL https://raw.githubusercontent.com/python/cpython/v3.14.7/Objects/abstract.c \
    | sed -n '2805,2828p'
PyObject *
PyObject_GetIter(PyObject *o)
{
    PyTypeObject *t = Py_TYPE(o);
    getiterfunc f;

    f = t->tp_iter;
    if (f == NULL) {
        if (PySequence_Check(o))
            return PySeqIter_New(o);
        return type_error("'%.200s' object is not iterable", o);
    }
    else {
        PyObject *res = (*f)(o);
        if (res != NULL && !PyIter_Check(res)) {
            PyErr_Format(PyExc_TypeError,
                         "iter() returned non-iterator "
                         "of type '%.100s'",
                         Py_TYPE(res)->tp_name);
            Py_SETREF(res, NULL);
        }
        return res;
    }
}
```

读法：类型的 `tp_iter` 槽（对应 `__iter__`）不为空就调它，并检查返回的东西确实是迭代器（有 `tp_iternext`），否则报 `iter() returned non-iterator`；槽为空但对象是序列（有 `__getitem__`），就包一个 `PySeqIter`，这就是 `old protocol` 那一行的来源；两样都没有才是 `object is not iterable`。`for` 的字节码是 `GET_ITER` 加 `FOR_ITER`，我反汇编了一个空循环（后面 `gen_dis.py` 的第二半，全文在下一节）：

```text
 14           RESUME                   0

 16           LOAD_FAST_BORROW         0 (items)
              GET_ITER
      L1:     FOR_ITER                 3 (to L2)
              STORE_FAST               1 (_)

 17           JUMP_BACKWARD            5 (to L1)

 16   L2:     END_FOR
              POP_ITER
              LOAD_CONST               1 (None)
              RETURN_VALUE
```

`GET_ITER` 在 `Python/bytecodes.c` 里就是调用 `PyObject_GetIter`，`FOR_ITER` 在迭代器耗尽时跳到 `L2`。对 `list_iterator`，解释器还有一个特化版本 `FOR_ITER_LIST`（同一个文件里），直接读迭代器里的 `it_seq` 和 `it_index`，连 `tp_iternext` 都不走。（Rust 的 `for` 是同一个形状：`IntoIterator::into_iter` 加反复 `next()`，只是用 `Option` 代替异常来表示结束，见 [Pebble 第 5 篇](/posts/rust-by-pebble-05-ast-generics/)里 `for stmt in program` 一节。）

## 用完就没了

迭代器是一次性的。`lab/ch05/iterator_exhausted.py` 把这件事在列表迭代器、生成器表达式和几个内置函数上各演示一遍。节选（第 6 到 10 行，第 16 到 24 行）：

```python
    words = ["alpha", "beta", "gamma"]
    it = iter(words)
    print("first pass: ", list(it))
    print("second pass:", list(it))
    print("list again: ", list(words), list(words))
    # ...
    # map, zip, enumerate and reversed are iterators: one pass only.
    pairs = zip("abc", range(3), strict=True)
    print("zip is iterator:", iter(pairs) is pairs)
    print("zip 1:", list(pairs))
    print("zip 2:", list(pairs))
    numbered = enumerate(words, start=1)
    print("enumerate:", next(numbered), next(numbered))
    backwards = reversed(words)
    print("reversed:", type(backwards).__name__, list(backwards))
```

再加上第 12 到 14 行的生成器表达式和第 26 到 35 行的 `range`、`len`、`sorted`：

```text
$ python3 lab/ch05/iterator_exhausted.py
first pass:  ['alpha', 'beta', 'gamma']
second pass: []
list again:  ['alpha', 'beta', 'gamma'] ['alpha', 'beta', 'gamma']
genexp 1: [0, 1, 4, 9]
genexp 2: []
zip is iterator: True
zip 1: [('a', 0), ('b', 1), ('c', 2)]
zip 2: []
enumerate: (1, 'alpha') (2, 'beta')
reversed: list_reverseiterator ['gamma', 'beta', 'alpha']
range: range(0, 1000000000000) 1000000000000 999999999999 True
range is iterator: False
range twice: [0, 1, 2] [0, 1, 2]
has len: False
sorted: ['gamma', 'beta', 'alpha'] then []
```

`zip`、`enumerate`、`reversed`、`map`、生成器表达式都是迭代器：第二遍什么都没有，也不报错。这是迭代器最容易咬人的地方：没有异常，只有一个悄悄变空的结果。上一篇结尾那个 `map(len, words)` 打印 `<map object ...>` 的谜底也在这里：

```text
$ python3 -c 'm = map(len, ["alpha", "beta"]); print(m, iter(m) is m, list(m), list(m))'
<map object at 0x7cbeeedb8900> True [5, 4] []
```

地址每次不同。`range` 是个例外，它不是迭代器而是一个惰性的序列：`range(10**12)` 有长度、能取下标、能做 `in` 判断，而且不占一万亿个整数的内存，`iter(big) is big` 是 `False`，意思是每次 `iter()` 都给一个新的迭代器，所以能反复用。`999 in big` 对整数是算出来的（CPython 里是 `Objects/rangeobject.c` 的 `range_contains_long`：先比较起点和终点，再检查 `(ob - start) % step == 0`），不是从头扫一遍。`reversed(words)` 返回的 `list_reverseiterator` 同样不复制列表，一百万个元素的列表和它的反向迭代器：

```text
$ python3 -c 'import sys; xs = list(range(10**6)); print(sys.getsizeof(xs), sys.getsizeof(reversed(xs)))'
8000056 48
```

“用完”到底是什么意思？一个自然的猜测是迭代器只是把下标停在末尾，往列表里再 `append` 一个元素它还会接着走。`lab` 里没有这个实验，我写了个小脚本 `forgotten_list.py` 来测：

```python
"""A finished list iterator lets go of its list."""


def main() -> None:
    """Exhaust an iterator, grow the list, iterate again."""
    items = [1, 2]
    it = iter(items)
    print("pass 1:", list(it), it.__reduce__())
    items.append(3)
    print("pass 2:", list(it), it.__reduce__())
    print("fresh: ", list(iter(items)))


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p05/scratch/forgotten_list.py
pass 1: [1, 2] (<built-in function iter>, ([],))
pass 2: [] (<built-in function iter>, ([],))
fresh:  [1, 2, 3]
```

第一遍结束之后，`__reduce__` 给出的重建方式已经是 `iter([])`：迭代器连列表本身都忘了。原因在 `v3.14.7` 的 `listiter_next` 里，走到末尾的那个分支：

```text
$ curl -sL https://raw.githubusercontent.com/python/cpython/v3.14.7/Objects/listobject.c \
    | sed -n '4018,4040p'
static PyObject *
listiter_next(PyObject *self)
{
    _PyListIterObject *it = (_PyListIterObject *)self;
    Py_ssize_t index = FT_ATOMIC_LOAD_SSIZE_RELAXED(it->it_index);
    if (index < 0) {
        return NULL;
    }

    PyObject *item = list_get_item_ref(it->it_seq, index);
    if (item == NULL) {
        // out-of-bounds
        FT_ATOMIC_STORE_SSIZE_RELAXED(it->it_index, -1);
#ifndef Py_GIL_DISABLED
        PyListObject *seq = it->it_seq;
        it->it_seq = NULL;
        Py_DECREF(seq);
#endif
        return NULL;
    }
    FT_ATOMIC_STORE_SSIZE_RELAXED(it->it_index, index + 1);
    return item;
}
```

越界时 `it_index` 设成 -1，`it_seq` 置空并释放对列表的引用。`#ifndef Py_GIL_DISABLED` 那一段只在有 GIL 的构建里编译，我这里用的就是：

```text
$ python3 -c 'import sys; print(repr(sys.abiflags), sys._is_gil_enabled())'
'' True
```

此后每次 `next()` 都在开头的 `index < 0` 处返回 `NULL`。耗尽之后的迭代器是个永远空的壳，也就是文档里对迭代器的要求：一旦抛过 `StopIteration`，之后就应该一直抛，`list_iterator` 是这么做的。

## 生成器是一个挂起的帧

手写 `Countdown` 要十几行，因为状态（`current`）得放在对象的属性里。生成器的想法是反过来：状态就放在函数自己的局部变量里，函数在 `yield` 处暂停，下次 `next()` 从那里接着跑。一个生成器像一本夹着书签的书：书是函数的代码，书签是“读到哪一行，局部变量各是什么”。`lab/ch05/generator_state.py` 把这个书签摆出来。生成器函数（第 6 到 11 行）：

```python
def counter(limit: int):
    """Yield 0 .. limit - 1."""
    i = 0
    while i < limit:
        yield i
        i += 1
```

`main` 在每个状态打印帧的信息，节选（第 16 到 23 行，第 25 到 30 行）：

```python
    gen = counter(2)
    print("type:", type(gen).__name__)
    print("created:", inspect.getgeneratorstate(gen))
    print("  gi_frame is None:", gen.gi_frame is None)
    print("  gi_running:", gen.gi_running)
    print("  gi_suspended:", gen.gi_suspended)
    print("  locals:", gen.gi_frame.f_locals)
    print("  f_lineno:", gen.gi_frame.f_lineno)
    # ...
    print("next:", next(gen))
    print("suspended:", inspect.getgeneratorstate(gen))
    print("  gi_suspended:", gen.gi_suspended)
    print("  locals:", gen.gi_frame.f_locals)
    print("  f_lineno:", gen.gi_frame.f_lineno)
    print("  gi_code:", gen.gi_code.co_name, gen.gi_code.co_varnames)
```

```text
$ python3 lab/ch05/generator_state.py
type: generator
created: GEN_CREATED
  gi_frame is None: False
  gi_running: False
  gi_suspended: False
  locals: {'limit': 2}
  f_lineno: 6
next: 0
suspended: GEN_SUSPENDED
  gi_suspended: True
  locals: {'limit': 2, 'i': 0}
  f_lineno: 10
  gi_code: counter ('limit', 'i')
next: 1
next: exhausted
finished: GEN_CLOSED
  gi_frame is None: True
  gi_suspended: False
inside: GEN_RUNNING
```

调用 `counter(2)` 没有执行函数体里的任何一行：状态是 `GEN_CREATED`，`i` 还不存在，`f_lineno` 指着 `def` 那一行（第 6 行）。第一次 `next()` 之后停在第 10 行的 `yield`，`i` 已经是 0。耗尽之后帧被清掉，`gi_frame` 变成 `None`。最后一行 `GEN_RUNNING` 是生成器在自己运行的时候问自己的状态（lab 第 39 到 43 行）。

这个“生成器函数一调用什么都不跑”的性质有个很实际的后果：错误会晚到第一次 `next()` 才出现。我给 `iter_tokens` 传一个 `None`（这个函数本章稍后登场）：

```python
"""A generator function runs nothing until the first next()."""

from sift.analysis.tokenize import iter_tokens, tokenize


def main() -> None:
    """Pass a bad argument and see when the error shows up."""
    it = iter_tokens(None)
    print("created:", type(it).__name__)
    try:
        next(it)
    except TypeError as exc:
        print("first next():", exc)
    try:
        tokenize(None)
    except TypeError as exc:
        print("tokenize(None):", exc)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p05/scratch/lazy_start.py
created: generator
first next(): normalize() argument 2 must be str, not None
tokenize(None): normalize() argument 2 must be str, not None
```

调用 `iter_tokens(None)` 平安无事，错误在第一次 `next()` 里冒出来；而 `tokenize(None)` 里的列表推导式立刻就把它拉出来了。惰性的流水线里，输入不合法的位置和报错的位置可能隔着很多层栈。

### 帧存在哪里

“挂起的帧”是字面意思。我反汇编了 `counter`，和上一节的空循环放在一个脚本里，叫 `gen_dis.py`：

```python
"""Disassemble a generator function next to a plain for loop."""

import dis


def counter(limit: int):
    """Yield 0 .. limit - 1."""
    i = 0
    while i < limit:
        yield i
        i += 1


def loop(items: list[int]) -> None:
    """Run an empty for loop."""
    for _ in items:
        pass


def main() -> None:
    """Print both disassemblies."""
    dis.dis(counter)
    print("-" * 40)
    dis.dis(loop)


if __name__ == "__main__":
    main()
```

前半部分（`counter`）的输出：

```text
$ python3 /tmp/p05/scratch/gen_dis.py | sed -n 1,30p
   6           RETURN_GENERATOR
               POP_TOP
       L1:     RESUME                   0

   8           LOAD_SMALL_INT           0
               STORE_FAST               1 (i)

   9   L2:     LOAD_FAST_BORROW_LOAD_FAST_BORROW 16 (i, limit)
               COMPARE_OP              18 (bool(<))
               POP_JUMP_IF_FALSE       16 (to L3)
               NOT_TAKEN

  10           LOAD_FAST_BORROW         1 (i)
               YIELD_VALUE              0
               RESUME                   5
               POP_TOP

  11           LOAD_FAST_BORROW         1 (i)
               LOAD_SMALL_INT           1
               BINARY_OP               13 (+=)
               STORE_FAST               1 (i)
               JUMP_BACKWARD           21 (to L2)

   9   L3:     LOAD_CONST               1 (None)
               RETURN_VALUE

  --   L4:     CALL_INTRINSIC_1         3 (INTRINSIC_STOPITERATION_ERROR)
               RERAISE                  1
ExceptionTable:
  L1 to L4 -> L4 [0] lasti
```

函数的第一条指令是 `RETURN_GENERATOR`：调用 `counter(2)` 时，解释器按普通函数那样建好了帧，执行到这条指令，就把帧搬进一个新的生成器对象，然后把这个对象当作返回值交给调用者。`v3.14.7` 的 `Python/bytecodes.c` 里：

```text
$ curl -sL https://raw.githubusercontent.com/python/cpython/v3.14.7/Python/bytecodes.c \
    | sed -n '4984,4994p'
            PyGenObject *gen = (PyGenObject *)_Py_MakeCoro(func);
            ERROR_IF(gen == NULL);
            assert(STACK_LEVEL() == 0);
            SAVE_STACK();
            _PyInterpreterFrame *gen_frame = &gen->gi_iframe;
            frame->instr_ptr++;
            _PyFrame_Copy(frame, gen_frame);
            assert(frame->frame_obj == NULL);
            gen->gi_frame_state = FRAME_CREATED;
            gen_frame->owner = FRAME_OWNED_BY_GENERATOR;
            _Py_LeaveRecursiveCallPy(tstate);
```

`gen->gi_iframe` 是生成器对象里面内嵌的一个帧（结构体 `_PyGenObject_HEAD` 里的成员，在 `Include/internal/pycore_interpframe_structs.h`），`_PyFrame_Copy` 把刚建好的帧拷进去，状态记为 `FRAME_CREATED`。`YIELD_VALUE` 则做相反的事：

```text
$ curl -sL https://raw.githubusercontent.com/python/cpython/v3.14.7/Python/bytecodes.c \
    | sed -n '1375,1388p'
            frame->instr_ptr++;
            PyGenObject *gen = _PyGen_GetGeneratorFromFrame(frame);
            assert(FRAME_SUSPENDED_YIELD_FROM == FRAME_SUSPENDED + 1);
            assert(oparg == 0 || oparg == 1);
            gen->gi_frame_state = FRAME_SUSPENDED + oparg;
            _PyStackRef temp = retval;
            DEAD(retval);
            SAVE_STACK();
            tstate->exc_info = gen->gi_exc_state.previous_item;
            gen->gi_exc_state.previous_item = NULL;
            _Py_LeaveRecursiveCallPy(tstate);
            _PyInterpreterFrame *gen_frame = frame;
            frame = tstate->current_frame = frame->previous;
            gen_frame->previous = NULL;
```

它不销毁帧：记下下一条指令的位置（`instr_ptr++`），把状态改成 `FRAME_SUSPENDED`，然后让线程的“当前帧”回到调用者，生成器的帧原地不动，带着栈和局部变量。`oparg` 为 1 的时候状态是 `FRAME_SUSPENDED + 1`，下一节的 `yield from` 用得上。状态枚举在 `Include/internal/pycore_frame.h`：

```text
$ curl -sL https://raw.githubusercontent.com/python/cpython/v3.14.7/Include/internal/pycore_frame.h \
    | sed -n '46,53p'
typedef enum _framestate {
    FRAME_CREATED = -3,
    FRAME_SUSPENDED = -2,
    FRAME_SUSPENDED_YIELD_FROM = -1,
    FRAME_EXECUTING = 0,
    FRAME_COMPLETED = 1,
    FRAME_CLEARED = 4
} PyFrameState;
```

它和上面 `inspect.getgeneratorstate` 的四个名字大致对应：`CREATED`、`SUSPENDED`、`RUNNING`（`EXECUTING`），以及 `CLOSED`。我猜 `CLOSED` 对应 `COMPLETED` 和 `CLEARED`，没有去读 `inspect.py` 确认。

最后那段 `L4` 是个异常处理入口：整个函数体被 `ExceptionTable` 包住，任何异常经过这里都要先过一道 `INTRINSIC_STOPITERATION_ERROR`。这是 PEP 479 的实现，下面会回来。

## 生成器表达式和内存

生成器函数的语法糖是生成器表达式：把 `[...]` 换成 `(...)`。`lab/ch05/genexp_vs_list.py` 比较两种统计词元数的办法。语料的正文先过 `strip_markdown`，一个文档一个文档地产出（第 17 到 33 行）：

```python
def bodies() -> Iterator[str]:
    """Yield the stripped body of every post, one at a time."""
    for doc in iter_documents(ROOT):
        yield strip_markdown(split_front_matter(doc.text)[1])


def count_with_list() -> int:
    """Hold every token of the corpus in one list, then count it."""
    tokens: list[str] = []
    for body in bodies():
        tokens.extend(tokenize(body))
    return len(tokens)


def count_with_stream() -> int:
    """Count the tokens as they pass, never holding more than one."""
    return sum(1 for body in bodies() for _ in iter_tokens(body))
```

两边都是同样的 `bodies()` 流，区别只在“收进列表”还是“数完就扔”。`peak_kib` 用 `tracemalloc` 量峰值（第 36 到 42 行）：

```python
def peak_kib(work: Callable[[], int]) -> tuple[int, float]:
    """Return the result of work and its tracemalloc peak in KiB."""
    tracemalloc.start()
    result = work()
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return result, peak / 1024
```

`median_ms` 对每个版本跑 3 次取中位数。完整输出：

```text
$ python3 lab/ch05/genexp_vs_list.py
tokens via list:   812338
tokens via stream: 812338
same count: True
peak memory, list:        45950 KiB
peak memory, stream:       2447 KiB
peak ratio list/stream: 18.8x
time, list:     1012.3 ms (median of 3)
time, stream:   1011.6 ms (median of 3)
time ratio stream/list: 1.00
list of 100000: 800968 bytes
genexp of 100000: 192 bytes
```

两个版本数出同样的 812338 个词元，峰值内存差 18.8 倍，时间比值是 1.00。时间不变并不奇怪：两边做的是同样的事（`tokenize` 本身就是 `iter_tokens` 加一个列表推导式），列表版多出来的只是 `extend`，在 81 万次正则匹配和切片旁边几乎看不见。流式版的 2447 KiB 里装的是什么，我没有拆开量，我猜是当时在手里的那一篇文档（最大的那篇）的正文，加上它的词元；这也解释了为什么这个数字和语料总大小无关，只和单个文档有关。

最后两行是同一个想法的玩具版：十万个平方数，列表是 800968 字节，生成器表达式是 192 字节。注意列表那一个数只算指针数组，不算十万个整数对象本身（`__sizeof__` 是浅的）；生成器那个数和“它将产出多少个值”无关，`v3.14.7` 的 `gen_sizeof` 就是对象头加帧的槽位：

```text
$ curl -sL https://raw.githubusercontent.com/python/cpython/v3.14.7/Objects/genobject.c \
    | sed -n '831,839p'
gen_sizeof(PyObject *op, PyObject *Py_UNUSED(ignored))
{
    PyGenObject *gen = _PyGen_CAST(op);
    Py_ssize_t res;
    res = offsetof(PyGenObject, gi_iframe) + offsetof(_PyInterpreterFrame, localsplus);
    PyCodeObject *code = _PyGen_GetCode(gen);
    res += _PyFrame_NumSlotsForCodeObject(code) * sizeof(PyObject *);
    return PyLong_FromSsize_t(res);
}
```

所以惰性换来的是内存，不是速度。“省时间”是惰性最常被误传的好处：它省的是你根本不会用到的那部分工作（比如只取前 10 个命中），如果每个元素都要处理，工作量一点没少，还要加上暂停和恢复的开销。

## yield from：把一部分工作转包出去

生成器里想把另一个迭代器的值原样转发出去，朴素的写法是内层一个 `for`。`yield from` 是这个循环的正式版，它还多做一件事：拿到子生成器的返回值。（它也会把 `send`/`throw` 转交给子生成器，这一点我没有做实验。）`lab/ch05/yield_from.py`（第 6 到 25 行）：

```python
def chars(text: str) -> Iterator[str]:
    """Yield the characters of text, then return their count."""
    yield from text
    return len(text)


def flat_manual(parts: list[str]) -> Iterator[str]:
    """Delegate by hand with an inner for loop."""
    for part in parts:
        # the loop that yield from replaces
        for ch in chars(part):  # noqa: UP028
            yield ch


def flat_delegating(parts: list[str]) -> Iterator[str]:
    """Delegate with yield from, collecting each return value."""
    total = 0
    for part in parts:
        total += yield from chars(part)
    print("  total returned by sub-generators:", total)
```

`main` 里还有一个递归的 `walk`（第 28 到 34 行，用 `yield from walk(child)` 拍平嵌套列表），以及手动取 `StopIteration.value`（第 44 到 49 行）：

```python
    gen = chars("xy")
    print(next(gen), next(gen))
    try:
        next(gen)
    except StopIteration as stop:
        print("StopIteration.value:", stop.value)
```

```text
$ python3 lab/ch05/yield_from.py
manual:     abcdef
  total returned by sub-generators: 6
delegating: abcdef
walk: [1, 2, 3, 4, 5, 6]
x y
StopIteration.value: 2
```

两种写法的字符流相同，但只有 `yield from` 能拿到 `chars` 的返回值：`total` 是 `2 + 3 + 1 = 6`。生成器的 `return 值` 不是一个普通的返回，它是藏在 `StopIteration` 里的 `value`，`for` 循环看到 `StopIteration` 只当作结束，不理会这个值。`gen_iternext` 做的就是这件事，在 `v3.14.7`：

```text
$ curl -sL https://raw.githubusercontent.com/python/cpython/v3.14.7/Objects/genobject.c \
    | sed -n '629,643p'
static PyObject *
gen_iternext(PyObject *self)
{
    assert(PyGen_CheckExact(self) || PyCoro_CheckExact(self));
    PyGenObject *gen = _PyGen_CAST(self);

    PyObject *result;
    if (gen_send_ex2(gen, NULL, &result, 0, 0) == PYGEN_RETURN) {
        if (result != Py_None) {
            _PyGen_SetStopIterationValue(result);
        }
        Py_CLEAR(result);
    }
    return result;
}
```

帧跑完返回（`PYGEN_RETURN`）时，如果返回值不是 `None`，就把它塞进一个新建的 `StopIteration`；返回 `None`（没有写 `return` 的生成器）则不带值。`yield from` 在字节码里是一个 `SEND` 循环：

```text
$ python3 -c 'import dis, sys; sys.path.insert(0, "lab/ch05"); from yield_from import chars; dis.dis(chars)' | sed -n 1,16p
   6           RETURN_GENERATOR
               POP_TOP
       L1:     RESUME                   0

   8           LOAD_FAST                0 (text)
               GET_YIELD_FROM_ITER
               LOAD_CONST               1 (None)
       L2:     SEND                     3 (to L5)
       L3:     YIELD_VALUE              1
       L4:     RESUME                   2
               JUMP_BACKWARD_NO_INTERRUPT 5 (to L2)
       L5:     END_SEND
               POP_TOP

   9           LOAD_GLOBAL              1 (len + NULL)
               LOAD_FAST_BORROW         0 (text)
```

`SEND` 把外面传进来的值转给内层迭代器，内层产出值就走 `YIELD_VALUE 1`，也就是 `FRAME_SUSPENDED_YIELD_FROM`（上一节枚举里的 -1，说明“我挂起的时候正在委托给别人”）；内层结束，`SEND` 跳到 `L5`，`END_SEND` 把内层的返回值留在栈上，成为 `yield from` 这个表达式的值。我只看到了这个框架，`throw` 在委托链里怎么转交，我没有再往下读。

## send、throw 与 close：把生成器当协程用

`yield` 其实是个表达式，`value = yield mean` 的意思是“把 `mean` 交出去，同时等人从外面送一个值进来”。`lab/ch05/send_throw_close.py` 里的 `averager` 是个经典的例子（第 6 到 28 行）：

```python
def averager() -> Generator[float | None, float | None, str]:
    """Receive numbers with send() and yield the running mean."""
    total = 0.0
    count = 0
    mean: float | None = None
    try:
        while True:
            try:
                value = yield mean
            except ValueError as exc:
                print("  generator caught ValueError:", exc)
                total, count, mean = 0.0, 0, None
                continue
            if value is None:
                continue
            total += value
            count += 1
            mean = total / count
    except GeneratorExit:
        print("  generator got GeneratorExit, cleaning up")
        raise
    finally:
        print("  finally: saw", count, "values")
```

`main`（第 33 到 60 行，节选）从外面驱动它：

```python
    gen = averager()
    print("prime with next:", next(gen))
    print("send 10:", gen.send(10))
    print("send 20:", gen.send(20))
    print("send 60:", gen.send(60))
    print("throw ValueError:")
    print("  returned:", gen.throw(ValueError("reset")))
    print("send 5:", gen.send(5))
    print("close:")
    print("  returned:", gen.close())
    # ...
    fresh = averager()
    try:
        fresh.send(1)
    except TypeError as exc:
        print("send to unstarted generator:", exc)
```

```text
$ python3 lab/ch05/send_throw_close.py
prime with next: None
send 10: 10.0
send 20: 15.0
send 60: 30.0
throw ValueError:
  generator caught ValueError: reset
  returned: None
send 5: 5.0
close:
  generator got GeneratorExit, cleaning up
  finally: saw 1 values
  returned: None
send after close: StopIteration
send to unstarted generator: can't send non-None value to a just-started generator
  finally: saw 0 values
throw KeyError escapes: 'boom'
```

三个方法各自在生成器暂停的那个 `yield` 处“注入”一件东西：`send(x)` 让那个 `yield` 表达式的值变成 `x`；`throw(exc)` 让它抛出 `exc`；`close()` 让它抛出 `GeneratorExit`。第一次调用必须用 `next()`（或 `send(None)`）“预激”，把生成器推到第一个 `yield`，不然就是输出里倒数第三行那个 `TypeError`，措辞在 `gen_send_ex2`，`v3.14.7`：

```text
$ curl -sL https://raw.githubusercontent.com/python/cpython/v3.14.7/Objects/genobject.c \
    | sed -n '192,208p'
gen_send_ex2(PyGenObject *gen, PyObject *arg, PyObject **presult,
             int exc, int closing)
{
    PyThreadState *tstate = _PyThreadState_GET();
    _PyInterpreterFrame *frame = &gen->gi_iframe;

    *presult = NULL;
    if (gen->gi_frame_state == FRAME_CREATED && arg && arg != Py_None) {
        const char *msg = "can't send non-None value to a "
                            "just-started generator";
        if (PyCoro_CheckExact(gen)) {
            msg = NON_INIT_CORO_MSG;
        }
        else if (PyAsyncGen_CheckExact(gen)) {
            msg = "can't send non-None value to a "
                    "just-started async generator";
        }
```

这里能看到状态机的另一半：只要状态是 `FRAME_CREATED`，非 `None` 的值就不让送。同一个函数还要分辨 `PyCoro_CheckExact` 和 `PyAsyncGen_CheckExact`，也就是说 `async def` 的协程和异步生成器和普通生成器共用这一套发送逻辑。我没有读更多，但这至少说明 `await` 和 `yield` 在解释器底下是近亲。

两个细节在输出里：`close()` 之后 `finally` 一定会执行，所以放在生成器里的清理代码会在 `close()` 时运行（本章末尾用 `with` 打开的文件也靠这一点）；`except GeneratorExit` 里我选择 `raise` 回去，吞掉它会怎样，我没有试。`throw(KeyError("boom"))` 没有被生成器接住，就原样从 `throw()` 调用处冒出来，同时 `finally` 照样跑了一遍（倒数第二行 `saw 0 values`，它属于最后那个新建的 `averager`）。

## 把 StopIteration 漏出去：PEP 479

生成器里调用 `next()` 很自然，也很危险。`lab/ch05/stopiteration_in_gen_fail.py`（第 6 到 17 行）：

```python
def first_words(lines: list[list[str]]) -> Iterator[str]:
    """Yield the first word of each line; a bug on empty lines."""
    for words in lines:
        # BAD: next() on an empty iterator raises StopIteration here
        yield next(iter(words))


def main() -> None:
    """Run the buggy generator on input with an empty line."""
    lines = [["alpha", "beta"], [], ["gamma"]]
    # error: RuntimeError: generator raised StopIteration
    print(list(first_words(lines)))
```

运行（`2>&1` 把 stderr 并进来，`sed` 把我的主目录替换成 `~`，其余原样）：

```text
$ python3 lab/ch05/stopiteration_in_gen_fail.py 2>&1 | sed "s|$HOME|~|"
Traceback (most recent call last):
  File "~/Projects/sift/lab/ch05/stopiteration_in_gen_fail.py", line 10, in first_words
    yield next(iter(words))
          ~~~~^^^^^^^^^^^^^
StopIteration

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File "~/Projects/sift/lab/ch05/stopiteration_in_gen_fail.py", line 21, in <module>
    main()
    ~~~~^^
  File "~/Projects/sift/lab/ch05/stopiteration_in_gen_fail.py", line 17, in main
    print(list(first_words(lines)))
          ~~~~^^^^^^^^^^^^^^^^^^^^
RuntimeError: generator raised StopIteration
```

空行里 `next(iter([]))` 抛出 `StopIteration`，它从生成器里冒出来。如果这个异常原样传出去，调用者的 `for` 或 `list()` 会把它当成“迭代结束”，静静地少掉后面的 `gamma`，没有任何报错。PEP 479 的规则是：生成器体里漏出来的 `StopIteration` 一律改写成 `RuntimeError`，原来的异常作为 `__cause__` 保留（输出里 `direct cause` 那一行）。我写了个对照脚本 `silent_stop.py`，同一个 bug 放在迭代器类和生成器里：

```python
"""Without PEP 479 a leaked StopIteration would end a loop quietly."""

from collections.abc import Iterable, Iterator
from typing import Self


class FirstWords:
    """An iterator with the bug of first_words in the lab file."""

    def __init__(self, lines: Iterable[list[str]]) -> None:
        self.lines = iter(lines)

    def __iter__(self) -> Self:
        return self

    def __next__(self) -> str:
        words = next(self.lines)
        # BAD: next() on an empty iterator leaks StopIteration
        return next(iter(words))


def first_words(lines: Iterable[list[str]]) -> Iterator[str]:
    """Yield the first word of each line, with the same bug."""
    for words in lines:
        # BAD: the generator turns the leak into RuntimeError
        yield next(iter(words))


def main() -> None:
    """Run the class and the generator on input with an empty line."""
    lines = [["alpha", "beta"], [], ["gamma"]]
    print("class:    ", list(FirstWords(lines)))
    try:
        print("generator:", list(first_words(lines)))
    except RuntimeError as exc:
        print("generator:", type(exc).__name__, exc)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p05/scratch/silent_stop.py
class:     ['alpha']
generator: RuntimeError generator raised StopIteration
```

类的版本不会被 PEP 479 保护（`__next__` 里抛 `StopIteration` 正是协议），悄悄返回 `['alpha']`；生成器版本被大声拦下。拦截发生在前面反汇编里那个 `L4` 入口，调用的是 `Python/intrinsics.c` 的 `stopiteration_error`：

```text
$ curl -sL https://raw.githubusercontent.com/python/cpython/v3.14.7/Python/intrinsics.c \
    | sed -n '143,157p'
stopiteration_error(PyThreadState* tstate, PyObject *exc)
{
    _PyInterpreterFrame *frame = tstate->current_frame;
    assert(frame->owner == FRAME_OWNED_BY_GENERATOR);
    assert(PyExceptionInstance_Check(exc));
    const char *msg = NULL;
    if (PyErr_GivenExceptionMatches(exc, PyExc_StopIteration)) {
        msg = "generator raised StopIteration";
        if (_PyFrame_GetCode(frame)->co_flags & CO_ASYNC_GENERATOR) {
            msg = "async generator raised StopIteration";
        }
        else if (_PyFrame_GetCode(frame)->co_flags & CO_COROUTINE) {
            msg = "coroutine raised StopIteration";
        }
    }
```

修法不止一种。最直接的是给 `next()` 一个默认值，把“空行”这个情况显式处理掉，我留在练习里。

## itertools：迭代器的积木

标准库的 `itertools` 就是一堆迭代器的积木：它们都是惰性的，彼此接得上。`lab/ch05/itertools_tour.py` 每个工具一个小例子：

```text
$ python3 lab/ch05/itertools_tour.py
chain.from_iterable: ['a', 'b', 'c', 'd', 'e']
chain: ['a', 'b', 0, 1]
count: [10, 15, 20, 25]
islice: ['c', 'e', 'g']
cycle: ['x', 'y', 'x', 'y', 'x']
repeat: ['z', 'z', 'z']
accumulate: [1, 3, 6, 10]
accumulate max: [3, 3, 4, 4, 5]
batched: [(0, 1, 2), (3, 4, 5), (6,)]
pairwise: [('a', 'b'), ('b', 'c'), ('c', 'd')]
product: [('a', 0), ('a', 1), ('b', 0), ('b', 1)]
permutations: [('a', 'b'), ('a', 'c'), ('b', 'a'), ('b', 'c'), ('c', 'a'), ('c', 'b')]
combinations: [('a', 'b'), ('a', 'c'), ('b', 'c')]
takewhile: [0, 1, 2, 3]
dropwhile: [4, 5, 6]
zip_longest: [('a', 'x'), ('b', 'y'), ('-', 'z')]
groupby unsorted:
   tea [('tea', 1)]
   bike [('bike', 2)]
   tea [('tea', 3)]
   bike [('bike', 4)]
   tea [('tea', 5)]
groupby sorted:
   bike [('bike', 2), ('bike', 4)]
   tea [('tea', 1), ('tea', 3), ('tea', 5)]
groups kept past the loop: [[], []]
tee: [0, 1, 2, 3] [0, 1, 2, 3]
tee, source also consumed: [0, 1, 2, 3] []
zip strict ok: [('a', 1), ('b', 2)]
```

这些调用都在 `lab/ch05/itertools_tour.py` 的 `main` 里（第 13 到 26 行）：

```python
    print("count:", list(itertools.islice(itertools.count(10, 5), 4)))
    print("islice:", list(itertools.islice("abcdefgh", 2, 7, 2)))
    print("cycle:", list(itertools.islice(itertools.cycle("xy"), 5)))
    print("repeat:", list(itertools.repeat("z", 3)))

    print("accumulate:", list(itertools.accumulate([1, 2, 3, 4])))
    print("accumulate max:", list(itertools.accumulate([3, 1, 4, 1, 5], max)))
    print("batched:", list(itertools.batched(range(7), 3, strict=False)))
    print("pairwise:", list(itertools.pairwise("abcd")))
    print("product:", list(itertools.product("ab", range(2))))
    print("permutations:", list(itertools.permutations("abc", 2)))
    print("combinations:", list(itertools.combinations("abc", 2)))
    print("takewhile:", list(itertools.takewhile(lambda n: n < 4, range(9))))
    print("dropwhile:", list(itertools.dropwhile(lambda n: n < 4, range(7))))
```

对 Sift 最有用的是这几个。`chain.from_iterable` 把“一串迭代器”拉平成一个，本章末尾的流水线用它把每个文件的行接起来；`count` 配 `islice` 能从无限流里切一段；`batched(range(7), 3, strict=False)` 在末尾留下 `(6,)`；`pairwise` 取相邻对，求相邻词元的 bigram 一行就够。`islice` 的负数下标和 `batched` 的 `strict=True` 各有一条报错，我也跑了一遍：

```text
$ python3 -c 'import itertools; print(list(itertools.batched(range(7), 3, strict=True)))' 2>&1 | tail -n 1
ValueError: batched(): incomplete batch
$ python3 -c 'import itertools; print(list(itertools.islice(iter("abc"), -1)))' 2>&1 | tail -n 1
ValueError: Stop argument for islice() must be None or an integer: 0 <= x <= sys.maxsize.
```

两个坑值得放大。第一个是 `groupby`，它只合并**相邻**的相同键（第 31 到 44 行）：

```python
    # groupby only groups ADJACENT equal keys.
    rows = [("tea", 1), ("bike", 2), ("tea", 3), ("bike", 4), ("tea", 5)]
    print("groupby unsorted:")
    for key, group in itertools.groupby(rows, key=itemgetter(0)):
        print("  ", key, list(group))
    print("groupby sorted:")
    for key, group in itertools.groupby(
        sorted(rows, key=itemgetter(0)), key=itemgetter(0)
    ):
        print("  ", key, list(group))

    # A group is a view of the shared iterator: keep it and it is gone.
    kept = [group for _, group in itertools.groupby("aabbb")]
    print("groups kept past the loop:", [list(g) for g in kept])
```

没排序时 `tea` 出现了三组，和 SQL 的 `GROUP BY` 不一样；排序之后才对。后面那个更隐蔽：每个 `group` 本身是共享底层迭代器的视图，外层循环往前走一步，上一个 `group` 就作废了，所以“把各组存起来以后再用”得到两个空列表。需要留着，就在循环里 `list(group)`。第二个是 `tee`（第 46 到 51 行）：

```python
    # tee: two independent iterators over one source.
    left, right = itertools.tee(iter(range(4)))
    print("tee:", list(left), list(right))
    source = iter(range(4))
    left, right = itertools.tee(source)
    print("tee, source also consumed:", list(source), list(left))
```

`tee` 给你两个互相独立的迭代器，但它们共用同一个源；`tee` 之后还去动原来的 `source`，副本就拿不到东西了，输出里的 `[]`。另外，`tee` 要为跑得快的那个副本缓存所有落后副本还没取走的值，两个副本走得越不齐，缓存越大，我猜这是“用 `tee` 复制大流”最常见的内存陷阱，但我没有量。

最后一行 `zip strict ok` 是 `zip(..., strict=True)` 在长度一致时的样子。长度不一致呢？默认的 `zip` 会悄悄截断到最短的那个（`lab/ch05/zip_strict_fail.py`，第 6 到 10 行）：

```python
    names = ["a", "b", "c"]
    scores = [1, 2]
    print("default zip drops data:", list(zip(names, scores, strict=False)))
    # error: ValueError: zip() argument 2 is shorter than argument 1
    print(list(zip(names, scores, strict=True)))
```

```text
$ python3 lab/ch05/zip_strict_fail.py 2>&1 | sed "s|$HOME|~|"
default zip drops data: [('a', 1), ('b', 2)]
Traceback (most recent call last):
  File "~/Projects/sift/lab/ch05/zip_strict_fail.py", line 14, in <module>
    main()
    ~~~~^^
  File "~/Projects/sift/lab/ch05/zip_strict_fail.py", line 10, in main
    print(list(zip(names, scores, strict=True)))
          ~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
ValueError: zip() argument 2 is shorter than argument 1
```

`strict=False` 丢了 `c` 却没吭一声，和前面“第二遍变空”是同一类沉默。以后要把两个本该等长的序列配对，我会默认写 `strict=True`。

## Sift 的第一段：惰性的文档流

回到仓库。`src/sift/corpus.py` 是这一章新增的整个文件（23 行）：

```python
"""Reading the corpus: a lazy stream of raw Markdown documents."""

from collections.abc import Iterator
from pathlib import Path
from typing import NamedTuple


class RawDoc(NamedTuple):
    """A Markdown file as read from disk, before any parsing."""

    path: Path
    text: str


def iter_documents(root: Path) -> Iterator[RawDoc]:
    """Yield every ``*.md`` file under root, one file at a time.

    Files come in sorted path order, so the position of a document in
    the stream is a stable doc_id. Each file is read when the consumer
    asks for it, never earlier.
    """
    for path in sorted(root.rglob("*.md")):
        yield RawDoc(path, path.read_text(encoding="utf-8"))
```

`RawDoc` 是个 `NamedTuple`：一个带字段名的元组，可以像元组一样解包。`iter_documents` 是个生成器函数，文件内容在消费者要的时候才读。我用审计钩子数它到底打开了几个文件，脚本叫 `lazy_reads.py`：

```python
"""Count file opens: iter_documents reads only when asked."""

import itertools
import sys
from pathlib import Path

from sift.corpus import iter_documents

ROOT = Path("corpus/posts")
opened: list[str] = []


def hook(event: str, args: tuple) -> None:
    """Record the path of every open() of a Markdown file."""
    if event == "open" and str(args[0]).endswith(".md"):
        opened.append(str(args[0]))


def main() -> None:
    """Pull documents from the stream and watch the open count."""
    sys.addaudithook(hook)
    docs = iter_documents(ROOT)
    print("stream created:    ", len(opened), "files opened")
    first = next(docs)
    print("after next():      ", len(opened), "files opened")
    print("  first doc:", first.path, len(first.text), "chars")
    list(itertools.islice(docs, 3))
    print("after 3 more:      ", len(opened), "files opened")
    list(docs)
    print("after the rest:    ", len(opened), "files opened")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p05/scratch/lazy_reads.py
stream created:     0 files opened
after next():       1 files opened
  first doc: corpus/posts/armv7-a-isa.md 19448 chars
after 3 more:       4 files opened
after the rest:     123 files opened
```

“惰性”的老实一点的说法是：文件内容是惰性的，路径列表不是。`sorted(root.rglob("*.md"))` 要先把 123 个路径全部收齐才能排序。`rglob` 本身是惰性的，3.14 里它返回一个 `map` 对象，`Lib/pathlib/__init__.py` 里 `glob` 的末尾是：

```text
$ curl -sL https://raw.githubusercontent.com/python/cpython/v3.14.7/Lib/pathlib/__init__.py \
    | sed -n '866,870p'
        if parts[-1] == '':
            paths = map(self._remove_trailing_slash, paths)
        elif parts[-1] == '**':
            paths = self._filter_trailing_slash(paths)
        paths = map(self._from_parsed_string, paths)
```

`rglob` 是 `glob` 加上一个 `**` 前缀的薄封装。我用一个小脚本确认类型、顺序和个数，脚本叫 `rglob_probe.py`：

```python
"""What Path.rglob returns, and in which order."""

import time
from pathlib import Path

ROOT = Path("corpus/posts")


def main() -> None:
    """Print the type, the first hit and the hit counts."""
    hits = ROOT.rglob("*.md")
    print("type:", type(hits).__name__)
    start = time.perf_counter()
    first = next(hits)
    ms = (time.perf_counter() - start) * 1e3
    print(f"first hit: {first} after {ms:.3f} ms")
    print("first in sorted order:", min(ROOT.rglob("*.md")))
    print("rglob:", 1 + len(list(hits)), "glob:", len(list(ROOT.glob("*.md"))))


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p05/scratch/rglob_probe.py
type: map
first hit: corpus/posts/linear-algebra-34-final-review.md after 0.228 ms
first in sorted order: corpus/posts/armv7-a-isa.md
rglob: 123 glob: 123
```

`rglob` 吐出来的顺序不是字典序：第一个命中是 `linear-algebra-34-final-review.md`，而字典序最小的是 `armv7-a-isa.md`。所以 `iter_documents` 要先 `sorted`：文档在流里的位置就是它的 `doc_id`，每次运行都得一样。代价是上面说的，123 个 `Path` 要先收齐，这点对象不值得为它再写一层惰性。`rglob` 和上一篇的 `glob("*.md")` 的区别是会钻进子目录，这份语料里两边都是 123，没有差别。

## iter_tokens：一次吐一个词元

分词是流水线的第二段。上一篇它是三个返回列表的小函数用 `compose` 接起来的，每一级都要把整份结果收齐才能交给下一级。这一章它变成一个生成器，每次只吐一个词元，而且吐出来的不再是裸字符串，是一个 `Token`。`src/sift/analysis/tokenize.py`（第 25 到 35 行）：

```python
class Token(NamedTuple):
    """One index term and where it came from.

    position counts tokens from 0. start and end are str offsets into
    the folded text (see iter_tokens), with end exclusive.
    """

    text: str
    position: int
    start: int
    end: int
```

`iter_tokens`（第 38 到 66 行，原文，包括文档字符串）：

```python
def iter_tokens(text: str) -> Iterator[Token]:
    """Yield the tokens of text one at a time.

    The text is NFKC-normalized and casefolded first. Latin and digit
    runs become one token each (``c++`` and ``c#`` keep their suffix).
    A CJK run becomes overlapping bigrams, or one unigram when the run
    has a single character.

    start and end are offsets into the normalized, casefolded text,
    not into the argument: NFKC can change the length of the text
    (``"ﬁ"`` becomes ``"fi"``, ``"㎏"`` becomes ``"kg"``), and the
    two coincide only when the folding keeps every length.
    """
    folded = fold(text)
    position = 0
    for match in _TOKEN.finditer(folded):
        if match["latin"] is not None:
            yield Token(match["latin"], position, match.start(), match.end())
            position += 1
            continue
        run = match["cjk"]
        if len(run) == 1:
            yield Token(run, position, match.start(), match.end())
            position += 1
            continue
        for i in range(len(run) - 1):
            start = match.start() + i
            yield Token(run[i : i + 2], position, start, start + 2)
            position += 1
```

分词的规则和第 2 篇一样，没有变；变的是形状：函数里有 `yield`，所以调用它得到的是生成器，`finditer` 本身也是个迭代器，匹配一个就吐一个，CJK 的 bigram 靠内层循环一个一个吐。`position` 是个跨循环的局部变量，生成器的帧替它保管，这正是“状态放在局部变量里”的好处。`tokenize` 还在，退化成两行（第 69 到 71 行），查询词的分词和第 2 篇的实验还要用它：

```python
def tokenize(text: str) -> list[str]:
    """Return the terms of text: the token texts of iter_tokens."""
    return [token.text for token in iter_tokens(text)]
```

第 4 篇里的 `find_runs`、`split_runs` 和用 `compose` 拼出来的 `_PIPELINE` 在这一章被删掉了（第 4 篇描述的是 `ch04` 标签下的样子）：它们每一级都返回完整的列表，没法逐个吐词元。`util.compose` 本身还在，`analyze_file` 仍然用它拼文档级的处理链。

### 偏移量是 NFKC 之后的偏移量

`Token` 的 `start` 和 `end` 有一个我必须老实交代的限制：它们是**折叠之后**文本里的偏移，不是你传进来的那个字符串里的偏移。`fold` 先做 NFKC 再 `casefold`，这一步可以改变文本的长度。我用一个小脚本看它，`token_offsets.py`：

```python
"""iter_tokens offsets index the folded text, not the input."""

from sift.analysis.tokenize import fold, iter_tokens


def main() -> None:
    """Slice both the input and the folded text with each token."""
    text = "ﬁne ㎏ 所有权"
    folded = fold(text)
    print(len(text), len(folded), repr(folded))
    for token in iter_tokens(text):
        print(token)
        print("  folded[start:end]:", repr(folded[token.start : token.end]))
        print("  text[start:end]:  ", repr(text[token.start : token.end]))


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p05/scratch/token_offsets.py
9 11 'fine kg 所有权'
Token(text='fine', position=0, start=0, end=4)
  folded[start:end]: 'fine'
  text[start:end]:   'ﬁne '
Token(text='kg', position=1, start=5, end=7)
  folded[start:end]: 'kg'
  text[start:end]:   ' 所'
Token(text='所有', position=2, start=8, end=10)
  folded[start:end]: '所有'
  text[start:end]:   '权'
Token(text='有权', position=3, start=9, end=11)
  folded[start:end]: '有权'
  text[start:end]:   ''
```

输入 9 个字符，折叠后 11 个：连字 `ﬁ` 变成 `fi`，`㎏` 变成 `kg`，各多一个字符。用折叠后的文本切，每个词元都对得上；用原文切，从第二个词元起就错位了，最后一个甚至切出空串。这在真实语料里不是个理论问题。我数了一下语料里有多少文档的正文在折叠后长度变了（`offset_drift.py`，和上面一样的 `main()` 结构）：

```python
"""How many corpus documents change length under NFKC + casefold."""

from pathlib import Path

from sift.analysis.tokenize import fold
from sift.corpus import iter_documents
from sift.markdown import split_front_matter, strip_markdown

ROOT = Path("corpus/posts")


def main() -> None:
    """Compare the length of each body with the length of its fold."""
    drifted = 0
    total = 0
    delta = 0
    for doc in iter_documents(ROOT):
        body = strip_markdown(split_front_matter(doc.text)[1])
        total += 1
        diff = len(fold(body)) - len(body)
        if diff:
            drifted += 1
            delta += diff
    print(f"{drifted} of {total} documents change length")
    print(f"net change over the corpus: {delta:+d} characters")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p05/scratch/offset_drift.py
23 of 123 documents change length
net change over the corpus: +142 characters
```

123 篇里有 23 篇变了长度。所以要把词元位置映射回原文（比如高亮命中），不能直接拿 `start` 和 `end` 去切原文，得先 `fold` 同一份文本，或者另想办法。这一章建索引只用 `text`，`position`、`start`、`end` 先留着，我在这里把限制写明白，免得以后有人当成原文偏移来用。

## 建索引吃一条流

流水线的第三段是 `build_index`。它的签名从“一个字典”变成“一个可迭代对象”，每一项是 `(doc_id, terms)`，`terms` 可以是生成器。`src/sift/index.py`（第 7 到 19 行）：

```python
def build_index(
    docs: Iterable[tuple[int, Iterable[str]]],
) -> dict[str, dict[int, int]]:
    """Return term -> {doc_id: term frequency}.

    docs is consumed once, a document at a time: each item is a
    ``(doc_id, terms)`` pair and the terms may be a generator.
    """
    index: dict[str, dict[int, int]] = {}
    for doc_id, tokens in docs:
        for term, tf in Counter(tokens).items():
            index.setdefault(term, {})[doc_id] = tf
    return index
```

和上一篇相比只改了循环头：`for doc_id, tokens in docs`，不再是 `docs.items()`。`Counter(tokens)` 吃一个生成器，边数边丢。把三段接起来的是 `src/sift/__main__.py`（第 21 到 45 行）：

```python
def iter_terms(text: str) -> Iterator[str]:
    """Yield the term of each token of text."""
    return (token.text for token in iter_tokens(text))


# 文件文本 -> 去掉 front matter -> 去掉 Markdown 标记 -> 词项流
analyze_file = compose(
    split_front_matter, itemgetter(1), strip_markdown, iter_terms
)


@timed
def load_index(root: Path) -> tuple[list[Path], dict[str, dict[int, int]]]:
    """Read, tokenize and index every Markdown file under root.

    The doc_id of a file is its position in the sorted path list.
    """
    paths: list[Path] = []

    def analyzed() -> Iterator[tuple[int, Iterator[str]]]:
        for doc_id, doc in enumerate(iter_documents(root)):
            paths.append(doc.path)
            yield doc_id, analyze_file(doc.text)

    return paths, build_index(analyzed())
```

读法：`build_index` 向 `analyzed()` 要下一项，`analyzed()` 向 `iter_documents` 要下一个文件，读进来，交给 `analyze_file`（去掉 front matter、去掉 Markdown 标记，最后一级 `iter_terms` 返回一个生成器表达式，此时分词还没有开始），再回到 `build_index`，`Counter` 逐个拉词元。每一段都是别人伸手才动，没有哪一级有“全部结果”。同一时刻在内存里的只有当前文档的原文、去掉标记之后的正文、一个 `Counter`，外加一直在长的索引。

`analyzed()` 里有一处我不太喜欢但没有更好办法的地方：它一边产出，一边往外层的 `paths` 里追加路径。这行得通，是因为 `build_index` 把流吃完才返回，`return paths, ...` 时 `paths` 已经是满的；但这是靠约定，不是靠类型。`doc_id` 用 `enumerate` 给，和上一篇的“排序后路径的下标”是同一个数。（`@timed` 是第 4 篇的装饰器，它量的是整个函数，包括把流吃完。）

### 结果变了吗

输出不应该变。我对三条查询在两个标签上各跑一次，把最后一行（计时那行）去掉，比较剩下内容的哈希：

```bash
for q in kalman "linux kernel module" "device tree"; do
  echo "$q"
  for t in ch04 ch05; do
    at $t -m sift search $q 2>/dev/null | head -n -1 | md5sum
  done
done
```

```text
kalman
5a5012e4c361954d527c85f65cf4ccdb  -
5a5012e4c361954d527c85f65cf4ccdb  -
linux kernel module
86629813f4ad088475a1d63c35036283  -
86629813f4ad088475a1d63c35036283  -
device tree
6560e3cd67295c1816a0ba0693d813b9  -
6560e3cd67295c1816a0ba0693d813b9  -
```

每对哈希相同，排名没有变化。`python3 -m sift search kalman` 在 `ch05` 的输出，除了计时，和上一篇的一样（这一次是隔了一阵子的单次运行，3422 ms 比后面连续运行的数慢得多，我猜和上面说的升频有关，没有验证，下面的对比不用它）：

```text
$ python3 -m sift search kalman
load_index took 3422.0 ms
  19.570  corpus/posts/kalman-filter-02-multivariate.md
  16.775  corpus/posts/kalman-filter-01-one-dimension.md
  16.775  corpus/posts/kalman-filter-07-ukf.md
  13.979  corpus/posts/kalman-filter-06-eskf.md
  13.979  corpus/posts/kalman-filter-08-porting.md
   2.796  corpus/posts/pid-control-09-lqr.md
   2.796  corpus/posts/pid-control-10-embedded.md
   2.796  corpus/posts/typst-by-xuan-15-wasm-plugin.md
8 hits in 123 files: index built in 3422.0 ms, query took 0.129 ms
```

### 内存省了，时间没省，反而多花了

整个 `load_index` 在两个标签上花多少内存和时间，我写了个探针 `build_probe.py`，它跑 5 次取时间，再单独用 `tracemalloc` 跑一次量峰值：

```python
"""Time and memory of load_index in the tree that sift comes from."""

import statistics
import time
import tracemalloc
from pathlib import Path

import sift
from sift.__main__ import load_index

ROOT = Path("corpus/posts")
RUNS = 5


def main() -> None:
    """Print the median build time and the tracemalloc numbers."""
    tree = Path(sift.__file__).resolve().parents[2].name
    times = []
    for _ in range(RUNS):
        start = time.perf_counter()
        load_index(ROOT)
        times.append((time.perf_counter() - start) * 1000)
    tracemalloc.start()
    paths, index = load_index(ROOT)
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    print(f"{tree}: {len(paths)} files, {len(index)} terms")
    print(
        f"  time   min {min(times):7.0f} ms, "
        f"median {statistics.median(times):7.0f} ms"
    )
    print(
        f"  memory peak {peak / 2**20:6.1f} MiB, "
        f"kept {current / 2**20:6.1f} MiB"
    )


if __name__ == "__main__":
    main()
```

两边交替运行三轮（`load_index` 的 stderr 被丢掉）：

```bash
for i in 1 2 3; do
  at ch04 /tmp/p05/scratch/build_probe.py 2>/dev/null
  at ch05 /tmp/p05/scratch/build_probe.py 2>/dev/null
done
```

```text
ch04: 123 files, 81192 terms
  time   min    1281 ms, median    2130 ms
  memory peak   69.0 MiB, kept   28.8 MiB
ch05: 123 files, 81192 terms
  time   min    1302 ms, median    1307 ms
  memory peak   28.9 MiB, kept   28.8 MiB
ch04: 123 files, 81192 terms
  time   min     815 ms, median     830 ms
  memory peak   69.0 MiB, kept   28.8 MiB
ch05: 123 files, 81192 terms
  time   min    1295 ms, median    1318 ms
  memory peak   28.9 MiB, kept   28.8 MiB
ch04: 123 files, 81192 terms
  time   min     818 ms, median     827 ms
  memory peak   69.0 MiB, kept   28.8 MiB
ch05: 123 files, 81192 terms
  time   min    1297 ms, median    1308 ms
  memory peak   28.9 MiB, kept   28.8 MiB
```

第一轮 `ch04` 的中位数 2130 ms 比最小值 1281 ms 高出一大截，我猜又是冷启动，没有验证，后两轮稳定：`ch04` 在 820 ms 上下，`ch05` 在 1300 ms 上下。内存峰值是稳的，`tracemalloc` 每轮都一样：

- 峰值从 69.0 MiB 降到 28.9 MiB，约 2.4 倍。`kept` 是函数返回时还活着的内存，两边都是 28.8 MiB：那就是索引本身（81192 个词项的字典套字典）。`ch05` 的峰值只比最后留下的索引多 0.1 MiB，也就是说词元不再是内存问题，剩下的全是索引。
- 时间从约 820 ms 变成约 1300 ms，慢了约 1.6 倍（818 对 1297，差 479 ms）。

开头那个 18.8 倍是只数词元的实验，没有建索引；建索引之后这部分被 28.8 MiB 的索引盖住，所以整条链上只剩 2.4 倍。我把内存省了一半以上，时间多花了六成，这和我预期的方向不一样：我原以为生成器只是“省内存、不省时间”，没想到会更慢。

慢在哪儿？嫌疑人是 `Token`：`load_index` 只用 `.text`，却为 81 万个词元每个都造了一个四字段的 `NamedTuple`。我写了个脚本只量分词这一步，在同一份预先读好的正文上比三种写法：产出 `Token` 的 `iter_tokens`、产出裸字符串的同样的生成器 `iter_strings`、以及第 4 篇那种每个文档收成一个列表的写法 `list_strings`（`token_cost.py`）：

```python
"""Where the time goes: Token objects, generators or the regex."""

import time
from collections.abc import Callable, Iterator
from pathlib import Path

from sift.analysis.tokenize import _TOKEN, fold, iter_tokens
from sift.corpus import iter_documents
from sift.markdown import split_front_matter, strip_markdown

ROOT = Path("corpus/posts")
RUNS = 5


def iter_strings(text: str) -> Iterator[str]:
    """Yield the same terms as iter_tokens, as plain strings."""
    for match in _TOKEN.finditer(fold(text)):
        latin = match["latin"]
        if latin is not None:
            yield latin
            continue
        run = match["cjk"]
        if len(run) == 1:
            yield run
        else:
            yield from (run[i : i + 2] for i in range(len(run) - 1))


def list_strings(text: str) -> list[str]:
    """Return the same terms as one list, built the ch04 way."""
    terms: list[str] = []
    for match in _TOKEN.finditer(fold(text)):
        latin = match["latin"]
        if latin is not None:
            terms.append(latin)
            continue
        run = match["cjk"]
        if len(run) == 1:
            terms.append(run)
        else:
            terms.extend(run[i : i + 2] for i in range(len(run) - 1))
    return terms


def best_ms(work: Callable[[], int]) -> tuple[int, float]:
    """Return the result of work and its best wall time in ms."""
    best = float("inf")
    result = 0
    for _ in range(RUNS):
        start = time.perf_counter()
        result = work()
        best = min(best, (time.perf_counter() - start) * 1000)
    return result, best


def main() -> None:
    """Time three ways to count the tokens of all corpus bodies."""
    bodies = [
        strip_markdown(split_front_matter(doc.text)[1])
        for doc in iter_documents(ROOT)
    ]
    variants: dict[str, Callable[[], int]] = {
        "iter_tokens (Token tuples)": lambda: sum(
            1 for body in bodies for _ in iter_tokens(body)
        ),
        "iter_strings (str only)": lambda: sum(
            1 for body in bodies for _ in iter_strings(body)
        ),
        "list_strings (one list per doc)": lambda: sum(
            len(list_strings(body)) for body in bodies
        ),
    }
    for name, work in variants.items():
        count, ms = best_ms(work)
        print(f"{name:32} {count} tokens {ms:7.1f} ms")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p05/scratch/token_cost.py
iter_tokens (Token tuples)       812338 tokens   770.8 ms
iter_strings (str only)          812338 tokens   394.6 ms
list_strings (one list per doc)  812338 tokens   378.9 ms
```

三种写法数出同样的词元。产出裸字符串的生成器（394.6 ms）和第 4 篇那种列表写法（378.9 ms）几乎一样快，生成器的暂停和恢复在这个粒度上不算贵；多出来的时间几乎全在 `Token`：差 376 ms，摊到 812338 个词元上每个 0.46 μs。`namedtuple` 生成的 `__new__` 是一个 Python 函数，每造一个 `Token` 就是一次 Python 层的函数调用，反汇编能看到：

```text
$ python3 -c 'import dis; from sift.analysis.tokenize import Token; dis.dis(Token.__new__)'
  1           RESUME                   0
              LOAD_GLOBAL              1 (_tuple_new + NULL)
              LOAD_FAST_BORROW_LOAD_FAST_BORROW 1 (_cls, text)
              LOAD_FAST_BORROW_LOAD_FAST_BORROW 35 (position, start)
              LOAD_FAST_BORROW         4 (end)
              BUILD_TUPLE              4
              CALL                     2
              RETURN_VALUE
```

这 376 ms 和 `load_index` 多出来的 479 ms 还差一截。剩下的是不是 `iter_terms` 多套的那一层生成器表达式，是不是 `Counter` 一个一个往外拉的开销？这次我不猜了，写了个 `strings_probe.py`：同一条 `ch05` 流水线（`iter_documents`、`analyze_file`、`build_index`），只把最后一级换掉，三种末级交错跑 5 轮：

```python
"""load_index with the Token stage swapped for plain strings."""

import statistics
import time
from collections.abc import Callable, Iterator
from operator import itemgetter
from pathlib import Path

from sift.analysis.tokenize import _TOKEN, fold, iter_tokens
from sift.corpus import iter_documents
from sift.index import build_index
from sift.markdown import split_front_matter, strip_markdown
from sift.util import compose

ROOT = Path("corpus/posts")
RUNS = 5


def iter_strings(text: str) -> Iterator[str]:
    """Yield the same terms as iter_tokens, as plain strings."""
    for match in _TOKEN.finditer(fold(text)):
        latin = match["latin"]
        if latin is not None:
            yield latin
            continue
        run = match["cjk"]
        if len(run) == 1:
            yield run
        else:
            yield from (run[i : i + 2] for i in range(len(run) - 1))


def iter_terms(text: str) -> Iterator[str]:
    """Yield the term of each token of text (the ch05 stage)."""
    return (token.text for token in iter_tokens(text))


def wrapped_strings(text: str) -> Iterator[str]:
    """Wrap iter_strings in one more generator expression."""
    return (term for term in iter_strings(text))


def build(stage: Callable[[str], Iterator[str]]) -> int:
    """Run the ch05 pipeline with stage as the last step."""
    analyze = compose(split_front_matter, itemgetter(1), strip_markdown, stage)
    docs = (
        (doc_id, analyze(doc.text))
        for doc_id, doc in enumerate(iter_documents(ROOT))
    )
    return len(build_index(docs))


def main() -> None:
    """Time build() for each last stage, interleaved."""
    stages = {
        "Token via iter_terms": iter_terms,
        "iter_strings": iter_strings,
        "iter_strings + genexp": wrapped_strings,
    }
    times: dict[str, list[float]] = {name: [] for name in stages}
    for _ in range(RUNS):
        for name, stage in stages.items():
            start = time.perf_counter()
            build(stage)
            times[name].append((time.perf_counter() - start) * 1000)
    for name, values in times.items():
        print(
            f"{name:24} min {min(values):6.0f} ms, "
            f"median {statistics.median(values):6.0f} ms"
        )


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p05/scratch/strings_probe.py
Token via iter_terms     min   1301 ms, median   1314 ms
iter_strings             min    820 ms, median    838 ms
iter_strings + genexp    min    840 ms, median    848 ms
```

去掉 `Token` 之后 `load_index` 回到 820 ms 上下，和 `ch04` 的 815 到 818 ms 相当：整个差距就是 `Token`，在整条流水线里它花了约 481 ms（1301 减 820），比孤立量出来的 376 ms 还多，我猜是这些元组在 `Counter` 手里活得更久、给垃圾回收添了负担，这一点没有验证。多套一层没有意义的生成器表达式只多约 20 ms（820 对 840），可见生成器的暂停和恢复在这里不是主角。所以这一章的诚实结论是：流水线变惰性换来了内存，没有换来时间；而为“以后可能用得上”的位置信息，每个词元付 0.46 μs 的账，建索引现在其实用不上。我没有为此改仓库里的代码，留作练习。

## 一条完整的惰性流水线

`lab/ch05/pipeline.py` 把这个想法从头到尾走一遍：文件、行、词元、计数，每一级都是迭代器，只有最后的 `Counter` 在拉。前三级（第 15 到 31 行）：

```python
def paths() -> Iterator[Path]:
    """Yield the corpus files in sorted order (rglob is lazy)."""
    return iter(sorted(ROOT.rglob("*.md")))


def lines(path: Path) -> Iterator[str]:
    """Yield the lines of one file; the file object is the iterator."""
    with path.open(encoding="utf-8") as handle:
        yield from handle


def terms() -> Iterator[str]:
    """Yield the term of every token of every line of every file."""
    all_lines = itertools.chain.from_iterable(map(lines, paths()))
    for line in all_lines:
        for token in iter_tokens(line):
            yield token.text
```

文件对象本身就是按行的迭代器，所以 `yield from handle` 一行就够。`map(lines, paths())` 是惰性的“每个路径一个行生成器”，`chain.from_iterable` 把它们接成一条行流，就是上一节的两个积木。对照的急切版本（第 34 到 43 行）：

```python
def count_lazy() -> Counter[str]:
    """Count terms through the lazy pipeline."""
    return Counter(terms())


def count_eager() -> Counter[str]:
    """Read every file whole and build the full token list first."""
    texts = [path.read_text(encoding="utf-8") for path in paths()]
    all_tokens = [t for text in texts for t in tokenize(text)]
    return Counter(all_tokens)
```

`measure`（第 46 到 56 行）用 `tracemalloc` 量峰值，再跑一遍量时间。运行：

```text
$ python3 lab/ch05/pipeline.py
first 5 lines of the first file:
   ---
   title: "ARMv7-A 指令体系全解：数据处理、访存、分支与同步"
   commentId: "post:armv7-a-isa"
   published: "2026-04-05 16:20:00 +08:00"
   description: "以 I.MX6ULL（ARM Cortex-A7）为背景，从物理本质出发，系统梳理 ARMv7-A 指令集的核心要点：定长 32 位指令结构与条件执行机制、16 个核心寄存器的 AAPCS 调用规范，以及数据处理、内存访问、分支控制、系统状态和原子同步五大类指令的功能与应用场景。"
lazy   peak      6956 KiB,    1062 ms
eager  peak     58334 KiB,     970 ms
same counts: True
tokens: 859485 distinct: 82594
top 5: [('0', 14801), ('1', 11678), ('2', 6787), ('a', 6376), ('一个', 4822)]
```

两个版本数出完全相同的计数（`same counts: True`）。这里的词元总数 859485 比前面的 812338 多，因为这个脚本没有去掉 front matter 和 Markdown 标记，整个文件逐行分词。惰性版峰值 6956 KiB，急切版 58334 KiB，约 8.4 倍；时间反过来，惰性版 1062 ms 比急切版 970 ms 慢约一成。我猜多出来的是三层嵌套生成器加 `map` 加 `chain` 让每个元素一路传下去的开销，没有拆开量。和前面的结论一致：省的是内存。

这条流水线最让我满意的一点不在内存，在资源管理上。`lines` 里的 `with` 在生成器暂停的时候是开着的，那么中途放弃这个生成器，文件会不会关？我写了一个脚本来看，`lazy_close.py`，读两行，然后用两种方式结束：

```python
"""A generator that owns a file: close() runs its with block."""

from collections.abc import Iterator
from pathlib import Path

PATH = Path("corpus/posts/kalman-filter-02-multivariate.md")


def lines(path: Path) -> Iterator[str]:
    """Yield the lines of path; the file closes when we are done."""
    with path.open(encoding="utf-8") as handle:
        yield from handle


def main() -> None:
    """Read two lines, then end the generator early in two ways."""
    gen = lines(PATH)
    next(gen)
    next(gen)
    handle = gen.gi_frame.f_locals["handle"]
    print("after 2 lines, closed:", handle.closed)
    gen.close()
    print("after close(),  closed:", handle.closed)

    gen = lines(PATH)
    next(gen)
    handle = gen.gi_frame.f_locals["handle"]
    print("new generator,  closed:", handle.closed)
    del gen
    print("after del gen,  closed:", handle.closed)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p05/scratch/lazy_close.py
after 2 lines, closed: False
after close(),  closed: True
new generator,  closed: False
after del gen,  closed: True
```

通过 `gi_frame.f_locals` 能直接摸到暂停中的 `handle`。`close()` 在暂停处抛 `GeneratorExit`，`with` 的退出逻辑照常运行，文件关了。第二种是直接丢掉生成器：`del gen` 之后文件也关了，我猜这是 CPython 的引用计数在回收生成器时替它调用了 `close()`，换一个不用引用计数的实现，这一行我不敢保证，所以重要的资源还是显式 `close()`，或者用 `contextlib.closing`。

## 跑一遍

整章一个 `make` 目标，再加 `make lint`：

```text
$ make ch05
python3 scripts/chapter.py ch05
ok   lab/ch05/generator_state.py
ok   lab/ch05/genexp_vs_list.py
ok   lab/ch05/iter_protocol.py
ok   lab/ch05/iterator_exhausted.py
ok   lab/ch05/itertools_tour.py
ok   lab/ch05/pipeline.py
ok   lab/ch05/send_throw_close.py
ok   lab/ch05/stopiteration_in_gen_fail.py
ok   lab/ch05/yield_from.py
ok   lab/ch05/zip_strict_fail.py
$ make lint
ruff format --check --line-length 79 .
70 files already formatted
ruff check .
All checks passed!
```

`stopiteration_in_gen_fail.py` 和 `zip_strict_fail.py` 也显示 `ok`，因为运行器知道 `_fail.py` 结尾的文件应该非零退出。

## 本篇文件

[`lab/ch05`](https://github.com/bfmhno3/sift/tree/ch05/lab/ch05) 下的 10 个文件和这一章改过或新增的四个 `src/sift` 文件。结果列是我在本篇的环境里重新跑出来的。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`src/sift/corpus.py`](https://github.com/bfmhno3/sift/blob/ch05/src/sift/corpus.py) | `python3 -c 'from pathlib import Path; from sift.corpus import iter_documents; print(next(iter_documents(Path("corpus/posts"))).path)'` | 退出码 0，输出 `corpus/posts/armv7-a-isa.md`；23 行 |
| [`src/sift/analysis/tokenize.py`](https://github.com/bfmhno3/sift/blob/ch05/src/sift/analysis/tokenize.py) | `python3 -c 'from sift.analysis.tokenize import tokenize; print(tokenize("Rust 所有权 C++"))'` | 退出码 0，输出 `['rust', '所有', '有权', 'c++']`；71 行 |
| [`src/sift/index.py`](https://github.com/bfmhno3/sift/blob/ch05/src/sift/index.py) | `python3 -c 'from sift.index import build_index; print(build_index([(0, iter(["a", "b", "a"]))]))'` | 退出码 0，输出 `{'a': {0: 2}, 'b': {0: 1}}`；19 行 |
| [`src/sift/__main__.py`](https://github.com/bfmhno3/sift/blob/ch05/src/sift/__main__.py) | `python3 -m sift search kalman` | 退出码 0，stdout 第一行 `  19.570  corpus/posts/kalman-filter-02-multivariate.md`，stderr 一行 `load_index took ... ms`；116 行 |
| [`lab/ch05/iter_protocol.py`](https://github.com/bfmhno3/sift/blob/ch05/lab/ch05/iter_protocol.py) | `python3 lab/ch05/iter_protocol.py` | 退出码 0，第一行 `list is iterable: True` |
| [`lab/ch05/iterator_exhausted.py`](https://github.com/bfmhno3/sift/blob/ch05/lab/ch05/iterator_exhausted.py) | `python3 lab/ch05/iterator_exhausted.py` | 退出码 0，第一行 `first pass:  ['alpha', 'beta', 'gamma']` |
| [`lab/ch05/generator_state.py`](https://github.com/bfmhno3/sift/blob/ch05/lab/ch05/generator_state.py) | `python3 lab/ch05/generator_state.py` | 退出码 0，第一行 `type: generator` |
| [`lab/ch05/yield_from.py`](https://github.com/bfmhno3/sift/blob/ch05/lab/ch05/yield_from.py) | `python3 lab/ch05/yield_from.py` | 退出码 0，第一行 `manual:     abcdef` |
| [`lab/ch05/send_throw_close.py`](https://github.com/bfmhno3/sift/blob/ch05/lab/ch05/send_throw_close.py) | `python3 lab/ch05/send_throw_close.py` | 退出码 0，第一行 `prime with next: None` |
| [`lab/ch05/genexp_vs_list.py`](https://github.com/bfmhno3/sift/blob/ch05/lab/ch05/genexp_vs_list.py) | `python3 lab/ch05/genexp_vs_list.py` | 退出码 0，第一行 `tokens via list:   812338`（峰值和计时每次略有不同） |
| [`lab/ch05/itertools_tour.py`](https://github.com/bfmhno3/sift/blob/ch05/lab/ch05/itertools_tour.py) | `python3 lab/ch05/itertools_tour.py` | 退出码 0，第一行 `chain.from_iterable: ['a', 'b', 'c', 'd', 'e']` |
| [`lab/ch05/zip_strict_fail.py`](https://github.com/bfmhno3/sift/blob/ch05/lab/ch05/zip_strict_fail.py) | `python3 lab/ch05/zip_strict_fail.py` | 退出码 1：先打印 `default zip drops data: [('a', 1), ('b', 2)]`，随后 `ValueError: zip() argument 2 is shorter than argument 1` |
| [`lab/ch05/pipeline.py`](https://github.com/bfmhno3/sift/blob/ch05/lab/ch05/pipeline.py) | `python3 lab/ch05/pipeline.py` | 退出码 0，第一行 `first 5 lines of the first file:`（峰值和计时每次略有不同） |
| [`lab/ch05/stopiteration_in_gen_fail.py`](https://github.com/bfmhno3/sift/blob/ch05/lab/ch05/stopiteration_in_gen_fail.py) | `python3 lab/ch05/stopiteration_in_gen_fail.py` | 退出码 1：`RuntimeError: generator raised StopIteration`（原始 `StopIteration` 作为直接原因出现在它上面） |

除了上面这些，这一章还有一处没有行为变化的改动：`scripts/chapter.py` 只改了模块文档字符串。

## 练习

**1.** 预测下面这段代码的输出，再运行。哪个元素丢了，为什么？提示：`zip` 向它的各个参数轮流要值，要到哪个参数先耗尽为止。

```python
it = iter([1, 2, 3])
print(list(zip(it, it)), list(it))
```

**2.** `load_index` 只用 `Token.text`。在不改 `iter_tokens` 对外行为的前提下，给 `iter_terms` 换一条不造 `Token` 的路（比如从 `iter_tokens` 里拆出一个只产出字符串的内部生成器，让 `iter_tokens` 在它之上包一层）。用 `build_probe.py` 的办法比较改动前后的 `load_index`：上面 `strings_probe.py` 说明几乎能全部拿回来，但你得自己量一遍再信。再想一想：`position`、`start`、`end` 这三个字段，什么时候值得付 0.46 μs？

**3.** 只用 `itertools.islice` 和 `iter()` 写一个 `batched(iterable, n)`，让它和 `itertools.batched` 在 `range(7)` 配 3、空输入、长度正好整除这三种输入上给出相同的结果。注意：你的实现应该是个生成器，不要先把整个输入变成列表。

**4.** 用两种办法修好 `stopiteration_in_gen_fail.py` 里的 `first_words`，让它在空行上跳过而不是崩：一种用 `next(iter(words), None)`，一种用内层 `for` 加 `break`。再用本篇 `silent_stop.py` 的办法确认：把同一个 bug 放在迭代器类里和放在生成器里，行为各是什么。

## 下一篇

下一篇是《[类与数据模型：让倒排表像内置类型](/posts/python-by-sift-06-classes-data-model/)》。这一篇里 `RawDoc` 和 `Token` 都是 `NamedTuple`，一个带字段名的元组，而 `build_index` 返回的是字典套字典，`dict[str, dict[int, int]]`，谁也没法给它加上自己的行为。我猜把倒排表写成一个自己的类，再让它支持 `len()`、`in`、`for`，用的正是这一篇的迭代器协议，只是这回要自己写 `__iter__`，而且要想清楚返回的是新迭代器还是它自己。
