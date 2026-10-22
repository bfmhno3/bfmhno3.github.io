---
title: "类与数据模型：让倒排表像内置类型"
commentId: "post:python-by-sift-06-classes-data-model"
published: "2026-10-22 12:00:00 +08:00"
description: "用 Sift 重学 Python 第 6 篇：我在 Python 3.14.7 里把倒排表写成 Posting、PostingList 和 InvertedIndex 三个类，让两个词的文档交集直接写成 `&`，沿途把 `__eq__`、`__hash__`、运算符重载、容器协议、`__slots__`、dataclass、enum 和 zoneinfo 各跑一遍；用 `__slots__` 后每个 Posting 从 128 字节降到 88 字节（1.46 倍），而整个 load_index 从 1209 ms 涨到了 1747 ms。"
category: Tutorial
tags:
  - Python
  - Sift
  - 面向对象
  - 数据模型
  - dataclasses
series: "用 Sift 重学 Python"
seriesOrder: 6
draft: false
comment: true
slug: python-by-sift-06-classes-data-model
---

上一篇结束的时候，倒排表还是 `dict[str, dict[int, int]]`，要找“同时含两个词的文档”，得自己写一段集合交集的循环。这一篇我把它换成三个自己的类，于是在真实语料上，同时含 `kalman` 和 `filter` 的文档就是一个 `&`：

```text
$ python3 -c '
from sift.__main__ import CORPUS, load_index

docs, index = load_index(CORPUS)
both = index["kalman"] & index["filter"]
print(len(index["kalman"]), len(index["filter"]), len(both))
print(docs[both[0].doc_id].path.name, both[0].tf)
' 2>/dev/null
8 18 5
kalman-filter-01-one-dimension.md 7
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch06`：新增 `src/sift/document.py`（`Document` 和 `parse_datetime`）和 `src/sift/frontmatter.py`（手写的 front matter 解析器）；`src/sift/index.py` 里的 `build_index` 换成了 `Posting`、`PostingList` 和 `InvertedIndex`；`src/sift/corpus.py` 改成产出 `Document`；`src/sift/__main__.py` 的 `load_index` 和 `search_index` 改用新类。除了 `document.py`（我不打算再改它），其余四个文件之后的章节还会动，没有哪个是终稿。`make ch06` 通过，`lab/ch06` 下 18 个文件按预期退出（15 个正常，3 个按预期失败）；`lab/ch04/tfidf_vs_tf.py` 和 `lab/ch05/genexp_vs_list.py` 也改成了新的接口。
> 涉及的 Python 特性：类是对象与绑定方法、`__new__` 与 `__init__`、`__repr__`/`__str__`/`__format__`、`__eq__` 与 `__hash__`、富比较与 `functools.total_ordering`、运算符重载与 `NotImplemented`、容器协议与 `__bool__`、`property`、`classmethod`/`staticmethod`、名字改写、`__slots__` 与 3.14 的对象布局、`dataclasses`、`enum`、`datetime` 与 `zoneinfo`。
> 前置：[第 5 篇](/posts/python-by-sift-05-iterators-generators/)，需要会进 `nix develop`，读得懂 `iter_documents` 和 `iter_tokens` 这条惰性流水线。

这个交集是对的，但这一篇没法只说好处。同一台机器、同一份语料，`load_index` 从上一篇的 1209 ms 涨到了 1747 ms（第 4 篇是 752 ms），索引占的内存从 28.8 MiB 涨到 84.5 MiB。时间账放在最后一节，其中有一项是我自己写的、白白浪费的 `PostingList()`。

在那之前，先把 Python 的数据模型走一遍，每一站一个 `lab/ch06` 里的小实验。

## 环境

和前几篇一样的机器，仓库在标签 `ch06`：

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ git describe --tags
ch06
```

CPU 是 AMD Ryzen 7 PRO 6850U，内存 30 GiB。计时有前几篇说过的那个毛病：隔一阵子再起的第一次运行，比连续运行慢得多。所以这一篇每一组对比，我都让各个版本轮流各跑几轮（7 轮，开关 GC 那组 5 轮），每轮一个新进程，离群值不剔除，看最小值和中位数；几十毫秒量级的微基准先热身再跑，贴的是热身之后的结果。我猜是 CPU 空闲后升频需要一小会儿，但没有去验证。

`ch04`、`ch05`、`ch06` 要放在同一个会话里比，做法和上一篇一样：用 `git archive` 各导出一份到 `/tmp/p06`，语料用符号链接共享。`PYTHONPATH` 在 `nix develop` 里是“仓库的 `src`，冒号，site-packages”，函数 `at` 把第一项换成导出目录：

```bash
mkdir -p /tmp/p06/ch04 /tmp/p06/ch05 /tmp/p06/ch06 /tmp/p06/scratch
for c in ch04 ch05 ch06; do
  git -C ~/Projects/sift archive $c | tar -x -C /tmp/p06/$c
  ln -s ~/Projects/sift/corpus /tmp/p06/$c/corpus
done
SITE=${PYTHONPATH#*:}
at() { (cd /tmp/p06/$1 && PYTHONPATH=/tmp/p06/$1/src:$SITE python3 "${@:2}"); }
```

正文里的脚本分两类：`lab/ch06` 里的是仓库文件，节选处用行号标明；放在 `/tmp/p06/scratch/` 的是只为这篇写的小脚本，不进仓库，我都贴全文，带 `main()` 和 `__main__` 守卫。除非另说，命令都在仓库根目录 `~/Projects/sift` 里运行。CPython 源码我直接 `curl` `v3.14.7` 标签下的原文，保留上游格式；贴出来的行号是那个标签下的行号。

## 类是对象，方法是函数

`class` 语句在运行时执行：跑一遍类体，把得到的名字收进一个字典，然后造出一个类对象绑到类名上。所以类是普通的值，可以赋给别的名字，可以传给函数，也可以直接用 `type` 现造。`lab/ch06/class_basics.py` 先放一个小类（第 4 到 17 行），再做几件事（主函数第 20 到 35 行和第 45 到 54 行）：

```python
class Counter:
    """Count how often a term was seen."""

    kind = "counter"  # class attribute, shared by every instance

    def __init__(self, term: str) -> None:
        """Start a counter at zero for term."""
        self.term = term  # instance attribute
        self.count = 0

    def hit(self) -> int:
        """Count one more occurrence and return the new count."""
        self.count += 1
        return self.count


def main() -> None:
    """Walk through attribute lookup and bound methods."""
    a, b = Counter("rust"), Counter("python")
    a.hit()
    a.hit()
    print("a.__dict__:", a.__dict__)
    print("b.__dict__:", b.__dict__)
    print("Counter.__dict__ has 'kind':", "kind" in Counter.__dict__)
    print("a.kind, b.kind:", a.kind, b.kind)

    # Assigning through the instance shadows; it never edits the class.
    a.kind = "mine"
    print("after a.kind = 'mine':", a.kind, b.kind, Counter.kind)
    print("a.__dict__:", a.__dict__)
    del a.kind
    print("after del a.kind:", a.kind)
    # ...
    # A method is a function stored on the class. Looking it up on an
    # instance wraps it in a bound method that carries self.
    bound = a.hit
    print("bound:", type(bound).__name__, bound.__qualname__)
    print("bound.__self__ is a:", bound.__self__ is a)
    print("bound.__func__ is Counter.hit:", bound.__func__ is Counter.hit)
    print("bound():", bound())
    print("Counter.hit(a):", Counter.hit(a))
    print("type(Counter.hit):", type(Counter.hit).__name__)
    print("type(a.hit):", type(a.hit).__name__)
```

```text
$ python3 lab/ch06/class_basics.py
a.__dict__: {'term': 'rust', 'count': 2}
b.__dict__: {'term': 'python', 'count': 0}
Counter.__dict__ has 'kind': True
a.kind, b.kind: counter counter
after a.kind = 'mine': mine counter counter
a.__dict__: {'term': 'rust', 'count': 2, 'kind': 'mine'}
after del a.kind: counter
type(Counter): <class 'type'>
alias is Counter: True
alias('c').term: c
type(...) made: <class '__main__.Dynamic'> 1
bound: method Counter.hit
bound.__self__ is a: True
bound.__func__ is Counter.hit: True
bound(): 3
Counter.hit(a): 4
type(Counter.hit): function
type(a.hit): method
```

属性查找可以想成先翻自己的口袋（实例的 `__dict__`），翻不到再去看墙上的公告栏（类的 `__dict__`）。这个比喻我只用这一次，真实的规则还有继承链和描述符，留到第 15 篇。从输出能直接读出三件事：

- `kind` 只在 `Counter.__dict__` 里，`a.__dict__` 里只有 `term` 和 `count`。
- `a.kind = "mine"` 在 `a.__dict__` 里新建了一项，没有改类；`del a.kind` 之后，类上的那一份又露出来。赋值总是写进实例，读才会往类上找。
- `type(Counter)` 是 `type`，`alias is Counter` 说明类名只是个标签，`type("Dynamic", (), {"x": 1})` 不写 `class` 也造得出类。

方法呢？`Counter.hit` 从类上取出来是普通函数（`type(Counter.hit)` 是 `function`），从实例上取出来才是 `method`，它带着 `__self__` 和 `__func__`。`Counter.hit(a)` 和 `a.hit()` 做的是同一件事，`self` 不是关键字，只是第一个参数的名字。这一步发生在函数类型的 `__get__` 里：

```c
static PyObject *
func_descr_get(PyObject *func, PyObject *obj, PyObject *type)
{
    if (obj == Py_None || obj == NULL) {
        return Py_NewRef(func);
    }
    return PyMethod_New(func, obj);
}
```

这是 `Objects/funcobject.c` 第 1278 行的原文。从类上取（`obj` 是 `NULL` 或 `None`）原样返回函数，从实例上取就 `PyMethod_New(func, obj)`（`Objects/classobject.c` 第 64 行），新建一个 `PyMethodObject`。它的结构体在 `Include/cpython/classobject.h` 第 12 到 18 行：除了对象头，只有 `im_func`、`im_self`、一个弱引用链表指针和一个调用用的 `vectorcall`。

`a.hit` 的值是一个小对象，核心是 `im_func` 和 `im_self` 两个指针，其余两个字段是弱引用链表和调用入口。Rust 里同一件事写成 `&self`、`&mut self`，是签名里看得见的参数，Python 里只靠命名约定。

## `__new__` 造对象，`__init__` 填对象

`Loud("x")` 这个调用看起来只有一步，其实是两步。`lab/ch06/init_vs_new.py`（第 4 到 37 行）把它们都打印出来：

```python
class Loud:
    """Print each step of the construction protocol."""

    def __new__(cls, name: str) -> Loud:
        """Allocate the instance; runs before __init__."""
        print(f"__new__({cls.__name__}, {name!r})")
        return super().__new__(cls)

    def __init__(self, name: str) -> None:
        """Initialize the instance that __new__ returned."""
        print(f"__init__({name!r})")
        self.name = name


class Interned:
    """Return one shared instance per name, decided in __new__."""

    _cache: dict[str, Interned] = {}

    def __new__(cls, name: str) -> Interned:
        """Return the cached instance for name, creating it once."""
        if name not in cls._cache:
            obj = super().__new__(cls)
            obj.name = name
            cls._cache[name] = obj
        return cls._cache[name]


def main() -> None:
    """Show the order of calls and a __new__ that returns a cache."""
    obj = Loud("x")
    print("result:", type(obj).__name__, obj.name)
    print("Interned('a') is Interned('a'):", Interned("a") is Interned("a"))
    print("Interned('a') is Interned('b'):", Interned("a") is Interned("b"))
```

```text
$ python3 lab/ch06/init_vs_new.py
__new__(Loud, 'x')
__init__('x')
result: Loud x
Interned('a') is Interned('a'): True
Interned('a') is Interned('b'): False
```

调用类，就是调用 `type.__call__`，对应 C 里的 `type_call`（`Objects/typeobject.c` 第 2372 到 2393 行）：

```c
    obj = type->tp_new(type, args, kwds);
    obj = _Py_CheckFunctionResult(tstate, (PyObject*)type, obj, NULL);
    if (obj == NULL)
        return NULL;

    /* If the returned object is not an instance of type,
       it won't be initialized. */
    if (!PyObject_TypeCheck(obj, type))
        return obj;

    type = Py_TYPE(obj);
    if (type->tp_init != NULL) {
        int res = type->tp_init(obj, args, kwds);
        if (res < 0) {
            assert(_PyErr_Occurred(tstate));
            Py_SETREF(obj, NULL);
        }
        else {
            assert(!_PyErr_Occurred(tstate));
        }
    }
    return obj;
```

先 `tp_new` 分配，然后检查：如果返回的东西不是这个类的实例（第 2379 行），就原样返回，不调 `__init__`。`Interned` 就利用了前半句：`__new__` 里查缓存，同一个名字永远返回同一个对象（输出里 `Interned('a') is Interned('a')` 是 `True`）。

Sift 里我一次 `__new__` 都没写：`Token` 是 `NamedTuple`，`Posting` 和 `Document` 是 dataclass，它们的构造器都是生成的。`__new__` 真正不可替代的场合是不可变类型（子类化 `tuple` 或 `str`，对象一旦造出来就改不了，只能在 `__new__` 里定值）和实例缓存。

## 三种文字形式：`repr`、`str` 和 `format`

一个对象有三个“变成文字”的入口，`lab/ch06/repr_str_format.py` 里的 `Hit` 把三个都写了一遍（第 8 到 53 行）：

```python
class Hit:
    """A scored document with three different textual forms."""

    def __init__(self, doc_id: int, score: float) -> None:
        """Remember the document and its score."""
        self.doc_id = doc_id
        self.score = score

    def __repr__(self) -> str:
        """Return an unambiguous form that looks like the call."""
        return f"Hit(doc_id={self.doc_id}, score={self.score})"

    def __str__(self) -> str:
        """Return the form meant for a person."""
        return f"doc {self.doc_id} ({self.score:.2f})"

    def __format__(self, spec: str) -> str:
        """Format the score with spec, e.g. ``{hit:8.1f}``."""
        if not spec:
            return str(self)
        return f"doc {self.doc_id} {format(self.score, spec)}"


class Bare:
    """No __repr__ at all: the inherited object.__repr__ is used."""


def main() -> None:
    """Show where each of the three hooks is called."""
    hit = Hit(7, 3.14159)
    print("print(hit):     ", hit)
    print("repr(hit):      ", repr(hit))
    print("str(hit):       ", str(hit))
    print("f'{hit}':       ", f"{hit}")
    print("f'{hit:8.1f}':  ", f"{hit:8.1f}")
    print("f'{hit!r}':     ", f"{hit!r}")
    print("in a list:      ", [hit, hit])
    # The default repr holds a memory address; mask it for a stable run.
    print("Bare():         ", re.sub(r"0x[0-9a-f]+", "0x...", repr(Bare())))
    print("Posting:        ", Posting(3, (0, 5, 9)))
    print("PostingList:    ", PostingList([Posting(3, (0,))]))
    # str() falls back to repr() when only __repr__ is defined.
    print("str(Posting):   ", str(Posting(3, (0,))))
    # The repr round-trips: eval rebuilds an equal object.
    p = Posting(3, (0, 5, 9))
    print("eval(repr(p)) == p:", eval(repr(p)) == p)
```

```text
$ python3 lab/ch06/repr_str_format.py
print(hit):      doc 7 (3.14)
repr(hit):       Hit(doc_id=7, score=3.14159)
str(hit):        doc 7 (3.14)
f'{hit}':        doc 7 (3.14)
f'{hit:8.1f}':   doc 7      3.1
f'{hit!r}':      Hit(doc_id=7, score=3.14159)
in a list:       [Hit(doc_id=7, score=3.14159), Hit(doc_id=7, score=3.14159)]
Bare():          <__main__.Bare object at 0x...>
Posting:         Posting(doc_id=3, positions=(0, 5, 9))
PostingList:     PostingList([Posting(doc_id=3, positions=(0,))])
str(Posting):    Posting(doc_id=3, positions=(0,))
eval(repr(p)) == p: True
```

`repr` 是给程序员看的，惯例是写成能原样粘回去的构造调用（最后一行 `eval(repr(p)) == p` 是 `True`）。`str` 是给人看的，只定义了 `__repr__` 的类，`str()` 和 `print` 会退而用它（`str(Posting)` 一行）。`f"{hit:8.1f}"` 里冒号后面的 `8.1f` 原样交给 `__format__`，所以 `Hit` 可以自己决定这段格式说明怎么解释。容器里的元素总是用 `repr`（`in a list` 一行）。

`Bare()` 的输出里有一个内存地址（我在脚本里把它抹成了 `0x...`，不然每次运行都不同），那是 `object.__repr__` 的默认样子。Rust 的 `Debug` 和 `Display` 是同一对分工，见[第 3 篇](/posts/rust-by-pebble-03-enums-traits-diagnostics/)。

## 相等和哈希是一对

`__eq__` 说两个对象“是不是一回事”，`__hash__` 说它们“放在哪个桶里”。规则只有一条：相等的对象必须有相等的哈希。Python 不会替你检查这条，但它会在你只改了一半的时候先把另一半拿走。`lab/ch06/eq_hash.py` 第 12 到 47 行：

```python
class ByValue:
    """__eq__ without __hash__: instances become unhashable."""

    def __init__(self, doc_id: int) -> None:
        """Store the id."""
        self.doc_id = doc_id

    def __eq__(self, other: object) -> bool:
        """Compare by doc_id."""
        if not isinstance(other, ByValue):
            return NotImplemented
        return self.doc_id == other.doc_id


class Hashable(ByValue):
    """Restore hashing explicitly, consistent with __eq__."""

    def __hash__(self) -> int:
        """Hash the same field __eq__ compares."""
        return hash(self.doc_id)


def main() -> None:
    """Show the effect of __eq__ on __hash__."""
    print("Plain(1) == Plain(1):", Plain(1) == Plain(1))
    print("hash works on Plain:", isinstance(hash(Plain(1)), int))
    print("ByValue(1) == ByValue(1):", ByValue(1) == ByValue(1))
    print("'__hash__' in vars(ByValue):", "__hash__" in vars(ByValue))
    print("ByValue.__hash__:", ByValue.__hash__)
    print("Plain.__hash__:", Plain.__hash__)
    print("ByValue.__hash__ is None:", ByValue.__hash__ is None)
    print("Hashable.__hash__ is None:", Hashable.__hash__ is None)
    seen = {Hashable(1), Hashable(1), Hashable(2)}
    print("set of Hashable(1), (1), (2):", len(seen))
    print("ByValue(1) == 1:", ByValue(1) == 1)
    print("ByValue(1) != ByValue(2):", ByValue(1) != ByValue(2))
```

```text
$ python3 lab/ch06/eq_hash.py
Plain(1) == Plain(1): False
hash works on Plain: True
ByValue(1) == ByValue(1): True
'__hash__' in vars(ByValue): True
ByValue.__hash__: None
Plain.__hash__: <slot wrapper '__hash__' of 'object' objects>
ByValue.__hash__ is None: True
Hashable.__hash__ is None: False
set of Hashable(1), (1), (2): 2
ByValue(1) == 1: False
ByValue(1) != ByValue(2): True
```

`ByValue` 定义了 `__eq__`，没有定义 `__hash__`，于是 `ByValue.__hash__` 是 `None`，而 `'__hash__' in vars(ByValue)` 是 `True`：Python 悄悄在类字典里放了一个 `None`。`Hashable` 是子类，显式写了 `__hash__`，才恢复。最终的结果是这样（`lab/ch06/unhashable_eq_fail.py`，第 4 到 22 行，第 20 到 21 行的注释标明了预期的错误）：

```python
class Doc:
    """Equal by doc_id, but with no __hash__."""

    def __init__(self, doc_id: int) -> None:
        """Store the id."""
        self.doc_id = doc_id

    def __eq__(self, other: object) -> bool:
        """Compare by doc_id."""
        if not isinstance(other, Doc):
            return NotImplemented
        return self.doc_id == other.doc_id


def main() -> None:
    """Put a Doc in a set."""
    # error: TypeError: cannot use 'Doc' as a set element (unhashable
    # type: 'Doc')
    print({Doc(1)})
```

```text
$ python3 lab/ch06/unhashable_eq_fail.py 2>&1 | sed "s|$HOME|~|"
Traceback (most recent call last):
  File "~/Projects/sift/lab/ch06/unhashable_eq_fail.py", line 26, in <module>
    main()
    ~~~~^^
  File "~/Projects/sift/lab/ch06/unhashable_eq_fail.py", line 22, in main
    print({Doc(1)})
          ^^^^^^^^
TypeError: cannot use 'Doc' as a set element (unhashable type: 'Doc')
```

“悄悄放一个 `None`”在 C 里是 `type_ready_set_hash`：

```c
static int
type_ready_set_hash(PyTypeObject *type)
{
    if (type->tp_hash != NULL) {
        return 0;
    }

    PyObject *dict = lookup_tp_dict(type);
    int r = PyDict_Contains(dict, &_Py_ID(__hash__));
    if (r < 0) {
        return -1;
    }
    if (r > 0) {
        return 0;
    }

    if (PyDict_SetItem(dict, &_Py_ID(__hash__), Py_None) < 0) {
        return -1;
    }
    type->tp_hash = PyObject_HashNotImplemented;
    return 0;
}
```

`type_new_impl` 先调 `PyType_Ready`（第 4659 行），后调 `fixup_slot_dispatchers`（第 4664 行），所以 `inherit_slots` 运行时，`tp_richcompare` 和 `tp_hash` 都还是空的。要不要从基类继承这一对，由 `overrides_hash`（第 8231 行）决定：类字典里有 `__eq__` 或 `__hash__` 就返回真，第 8386 行起的继承就被跳过。接着第 8780 行的函数看到 `tp_hash` 还是空的、类字典里也没有 `__hash__`，就放进 `None`。这就是 `ByValue.__hash__ is None` 的来历。

这条规则在 Sift 里到处出现。`Posting` 是 frozen dataclass，所以可哈希（`hash(Posting(5, (1, 3)))` 两次相等，见下面“容器协议”一节末尾的输出）；`PostingList` 要 `append`，是可变的，它定义了 `__eq__`，也就没有 `__hash__`。普通的 `@dataclass`（默认 `eq=True`、不 frozen）也走同一条路：

```text
$ python3 -c '
from dataclasses import dataclass


@dataclass
class P:
    x: int


@dataclass(frozen=True)
class F:
    x: int


print(P.__hash__, F.__hash__ is not None)
'
None True
```

`P.__hash__` 是 `None`，`frozen=True` 的 `F` 有生成的 `__hash__`。dataclass 决定这件事的表从 `Lib/dataclasses.py` 第 965 行开始，四个键依次是 `unsafe_hash`、`eq`、`frozen` 和“类里是否已经显式写了 `__hash__`”，下面摘出表头两行和 `eq=True` 的三行（第 969 到 971 行）：

```python
_hash_action = {(False, False, False, False): None,
                (False, False, False, True ): None,
                # ...
                (False, True,  False, False): _hash_set_none,
                (False, True,  False, True ): None,
                (False, True,  True,  False): _hash_add,
```

Rust 里同一件事在编译期：`HashSet` 要求元素是 `Hash + Eq`，只 `#[derive(PartialEq, Eq)]` 就往里放，编译器直接拒绝（`derive` 见[第 1 篇](/posts/rust-by-pebble-01-first-crate/)）。`/tmp/p06/rs/no_hash.rs` 全文：

```rust
use std::collections::HashSet;

#[derive(PartialEq, Eq)]
struct Doc {
    doc_id: u32,
}

fn main() {
    let mut seen = HashSet::new();
    // error[E0277]: the trait bound `Doc: Hash` is not satisfied
    seen.insert(Doc { doc_id: 1 });
}
```

```text
$ cd /tmp/p06/rs && rustc --edition 2024 no_hash.rs 2>&1 | sed -n '1,2p'
error[E0277]: the trait bound `Doc: Hash` is not satisfied
  --> no_hash.rs:11:10
```

`rustc` 是 `nix develop` 里的 1.97.1。Python 的 `TypeError` 要等到那一行真的跑到才出现。

## 比较运算和 `total_ordering`

排序要 `<`，`sorted()` 只用 `<`。但 `a <= b` 是另一个方法 `__le__`，Python 不会替你把它拼出来。`lab/ch06/total_ordering.py`（第 6 到 36 行，第 43 到 60 行）：

```python
class Manual:
    """Defines only __lt__: the other operators are missing."""

    def __init__(self, n: int) -> None:
        """Store the number."""
        self.n = n

    def __lt__(self, other: Manual) -> bool:
        """Return True if self.n < other.n."""
        return self.n < other.n


@total_ordering
class Score:
    """Defines __eq__ and __lt__; total_ordering derives the rest."""

    def __init__(self, value: float) -> None:
        """Store the score."""
        self.value = value

    def __eq__(self, other: object) -> bool:
        """Compare scores for equality."""
        if not isinstance(other, Score):
            return NotImplemented
        return self.value == other.value

    def __lt__(self, other: object) -> bool:
        """Return True if self scores lower than other."""
        if not isinstance(other, Score):
            return NotImplemented
        return self.value < other.value
# ...
def main() -> None:
    """Show sorting, derived operators and reflected comparison."""
    print("Manual < :", Manual(1) < Manual(2))
    print("Manual > works by reflection:", Manual(2) > Manual(1))
    try:
        print(Manual(1) <= Manual(2))
    except TypeError as exc:
        print("Manual <= ->", exc)

    a, b = Score(1.5), Score(2.5)
    print("<, <=, >, >=:", a < b, a <= b, a > b, a >= b)
    print("sorted:", sorted([b, a, Score(0.5)]))
    print("max:", max(a, b))
    print(
        "derived by total_ordering:",
        sorted(n for n in ("__le__", "__gt__", "__ge__") if n in vars(Score)),
    )
    print("compare with int:", a.__lt__(3))
```

```text
$ python3 lab/ch06/total_ordering.py
Manual < : True
Manual > works by reflection: True
Manual <= -> '<=' not supported between instances of 'Manual' and 'Manual'
<, <=, >, >=: True True False False
sorted: [Score(0.5), Score(1.5), Score(2.5)]
max: Score(2.5)
derived by total_ordering: ['__ge__', '__gt__', '__le__']
compare with int: NotImplemented
tuples compare field by field: True
```

`Manual` 只有 `__lt__`。`Manual(2) > Manual(1)` 居然能算：`>` 的左边没有定义 `__gt__`，Python 就反过来问右边的 `__lt__`（反射），`Manual(1) < Manual(2)` 为真，答案就出来了。`<=` 没有这样的退路（`__le__` 的反射是 `__ge__`，也没有定义），得到 `TypeError`。

`@total_ordering` 补上其余的。它的源码很短，`Lib/functools.py` 第 188 到 199 行：

```python
def total_ordering(cls):
    """Class decorator that fills in missing ordering methods"""
    # Find user-defined comparisons (not those inherited from object).
    roots = {op for op in _convert if getattr(cls, op, None) is not getattr(object, op, None)}
    if not roots:
        raise ValueError('must define at least one ordering operation: < > <= >=')
    root = max(roots)       # prefer __lt__ to __le__ to __gt__ to __ge__
    for opname, opfunc in _convert[root]:
        if opname not in roots:
            opfunc.__name__ = opname
            setattr(cls, opname, opfunc)
    return cls
```

`roots` 是类里自己写了的比较方法，`max(roots)` 按字符串比较挑出一个“根”（`__lt__` 排在最前，所以只写 `__lt__` 的类用它，注释里的优先顺序是这么来的），再用 `_convert` 表里的转换函数把缺的补上。`a.__lt__(3)` 返回 `NotImplemented`（输出的倒数第二行），而不是抛错：比较自己不懂的类型，要让对方有机会接话。`dataclass(order=True)` 干的是同一件事，只是按字段元组去比，后面会看到。

## 运算符重载：`&`、`|`、`-` 和反射

`a & b` 是 `type(a).__and__(a, b)` 的语法糖。`lab/ch06/operators.py` 里 `PostingList` 的三个运算和一个会反射的 `Money`（第 11 到 46 行，第 52 到 64 行）：

```python
class Money:
    """An amount that adds to ints, so that sum() works."""

    def __init__(self, cents: int) -> None:
        """Store the amount in cents."""
        self.cents = cents

    def __repr__(self) -> str:
        """Return the constructor-style form."""
        return f"Money({self.cents})"

    def __add__(self, other: object) -> Money:
        """Add a Money or an int number of cents."""
        if isinstance(other, Money):
            return Money(self.cents + other.cents)
        if isinstance(other, int):
            return Money(self.cents + other)
        return NotImplemented

    def __radd__(self, other: object) -> Money:
        """Handle ``int + Money``, tried after int.__add__ gives up."""
        return self.__add__(other)


def main() -> None:
    """Combine posting lists with &, | and -, then reflected ops."""
    rust = plist({1: (0, 4), 3: (2,), 5: (1,), 8: (9,)})
    safe = plist({3: (3,), 4: (0,), 5: (7,), 9: (1,)})
    print("rust:", rust.doc_ids())
    print("safe:", safe.doc_ids())
    print("rust & safe:", (rust & safe).doc_ids())
    print("rust | safe:", (rust | safe).doc_ids())
    print("rust - safe:", (rust - safe).doc_ids())
    print("safe - rust:", (safe - rust).doc_ids())
    print("positions in doc 5 of rust & safe:", (rust & safe)[1].positions)
    print("(rust & safe) == (safe & rust):", (rust & safe) == (safe & rust))
    # ...
    # NotImplemented tells Python to try the other operand's reflected
    # method; if nobody handles it, the result is a TypeError.
    print("rust.__and__(3):", rust.__and__(3))
    try:
        rust & 3
    except TypeError as exc:
        print("rust & 3 ->", exc)

    print("Money(5) + Money(7):", Money(5) + Money(7))
    print("Money(5) + 1:", Money(5) + 1)
    print("1 + Money(5):", 1 + Money(5))
    print("sum of 3 Money:", sum([Money(1), Money(2), Money(3)]))
    print("Money(1).__add__('x'):", Money(1).__add__("x"))
```

```text
$ python3 lab/ch06/operators.py
rust: [1, 3, 5, 8]
safe: [3, 4, 5, 9]
rust & safe: [3, 5]
rust | safe: [1, 3, 4, 5, 8, 9]
rust - safe: [1, 8]
safe - rust: [4, 9]
positions in doc 5 of rust & safe: (1, 7)
(rust & safe) == (safe & rust): True
rust.__and__(safe) == rust & safe: True
rust.__and__(3): NotImplemented
rust & 3 -> unsupported operand type(s) for &: 'PostingList' and 'int'
Money(5) + Money(7): Money(12)
Money(5) + 1: Money(6)
1 + Money(5): Money(6)
sum of 3 Money: Money(6)
Money(1).__add__('x'): NotImplemented
```

`PostingList.__and__` 按 `doc_id` 归并，下面是 `src/sift/index.py` 第 90 到 106 行：

```python
    def __and__(self, other: PostingList) -> PostingList:
        """Return the documents found in both lists."""
        if not isinstance(other, PostingList):
            return NotImplemented
        out = PostingList()
        a, b = self._postings, other._postings
        i = j = 0
        while i < len(a) and j < len(b):
            if a[i].doc_id < b[j].doc_id:
                i += 1
            elif a[i].doc_id > b[j].doc_id:
                j += 1
            else:
                out._postings.append(_union(a[i], b[j]))
                i += 1
                j += 1
        return out
```

两个指针各走各的，都是升序，所以只扫一遍，$O(n+m)$。相等的 `doc_id` 把两边的位置合并成一个新的 `Posting`（`_union`，第 31 到 34 行）。第 92 行的 `isinstance` 检查，对方不是 `PostingList` 就 `return NotImplemented`，不是 `raise TypeError`。这样 Python 才有机会接着试对方的反射方法 (`__rand__`)，都不行才由解释器统一报错：`rust & 3 -> unsupported operand type(s) for &: 'PostingList' and 'int'`。

“接着试对方”的规则写在 `Objects/abstract.c` 的 `binary_op1`，第 955 到 979 行：

```c
    if (slotv) {
        PyObject *x;
        if (slotw && PyType_IsSubtype(Py_TYPE(w), Py_TYPE(v))) {
            x = slotw(v, w);
            if (x != Py_NotImplemented)
                return x;
            Py_DECREF(x); /* can't do it */
            slotw = NULL;
        }
        x = slotv(v, w);
        assert(_Py_CheckSlotResult(v, op_name, x != NULL));
        if (x != Py_NotImplemented) {
            return x;
        }
        Py_DECREF(x); /* can't do it */
    }
    if (slotw) {
        PyObject *x = slotw(v, w);
        assert(_Py_CheckSlotResult(w, op_name, x != NULL));
        if (x != Py_NotImplemented) {
            return x;
        }
        Py_DECREF(x); /* can't do it */
    }
    Py_RETURN_NOTIMPLEMENTED;
```

先试左边的 `slotv`；返回 `NotImplemented` 再试右边的 `slotw`；两个都放弃，还是 `NotImplemented`，上层据此抛 `TypeError`。第 957 行有一条例外：右边的类型是左边类型的子类、且槽不同时，右边先来（这是子类能覆盖父类运算的原因）。`Money` 的反射走的不是这条例外，而是第 971 行的普通回退：`1 + Money(5)` 里 `int.__add__` 对 `Money` 返回 `NotImplemented`，才轮到 `Money.__radd__`；`sum([...])` 从整数 `0` 开始加，所以 `sum` 能用也靠 `__radd__`。Rust 把右操作数的每一种类型各实现一次 `impl Add<Rhs>`，没有“先试后退”（见[第 2 篇](/posts/rust-by-pebble-02-ownership/)里的 `Offset`）。

交集的 `|` 和差 `-` 同理，`-` 偷懒用了 `__contains__`（第 130 到 136 行）：对左边每个 `Posting` 问一句“它的 `doc_id` 在不在右边”，下一节就看 `in` 是怎么实现的。

## 容器协议：`len`、`[]`、`in`、`for`

`for x in obj`、`x in obj`、`reversed(obj)`、`bool(obj)` 都不是靠继承某个容器基类实现的，是靠几个特殊方法。`lab/ch06/containers_protocol.py` 先造一个最小的类，只有 `__len__` 和 `__getitem__`（第 6 到 64 行）：

```python
class Countdown:
    """Only __len__ and __getitem__: no __iter__, no __contains__."""

    def __len__(self) -> int:
        """Return the number of items."""
        return 3

    def __getitem__(self, i: int) -> int:
        """Return 3 - i, raising IndexError past the end."""
        if not 0 <= i < 3:
            raise IndexError(i)
        return 3 - i


class Basket:
    """Empty baskets are falsy through __len__ ... or __bool__."""

    def __init__(self, items: list[str]) -> None:
        """Keep the items."""
        self.items = items

    def __len__(self) -> int:
        """Return the number of items."""
        return len(self.items)


class Switch:
    """__bool__ wins over __len__ when both exist."""

    def __len__(self) -> int:
        """Pretend to be empty."""
        return 0

    def __bool__(self) -> bool:
        """Always true."""
        return True


def main() -> None:
    """Show the protocols on Countdown and on PostingList."""
    c = Countdown()
    print("len:", len(c))
    print("for:", [x for x in c])
    print("in:", 2 in c, 7 in c)
    print("reversed:", list(reversed(c)))
    print("list(c):", list(c))
    print("hasattr __iter__:", hasattr(c, "__iter__"))
    print("iter(c):", type(iter(c)).__name__)

    pl = PostingList([Posting(2, (0,)), Posting(5, (1, 3))])
    print("PostingList len:", len(pl))
    print("pl[1]:", pl[1])
    print("5 in pl, 3 in pl:", 5 in pl, 3 in pl)
    print("for doc ids:", [p.doc_id for p in pl])
    print("bool(pl), bool(PostingList()):", bool(pl), bool(PostingList()))

    print("bool(Basket([])), bool(Basket(['a'])):")
    print("  ", bool(Basket([])), bool(Basket(["a"])))
    print("len(Switch()), bool(Switch()):", len(Switch()), bool(Switch()))
```

```text
$ python3 lab/ch06/containers_protocol.py
len: 3
for: [3, 2, 1]
in: True False
reversed: [1, 2, 3]
list(c): [3, 2, 1]
hasattr __iter__: False
iter(c): iterator
PostingList len: 2
pl[1]: Posting(doc_id=5, positions=(1, 3))
5 in pl, 3 in pl: True False
for doc ids: [2, 5]
bool(pl), bool(PostingList()): True False
bool(Basket([])), bool(Basket(['a'])):
   False True
len(Switch()), bool(Switch()): 0 True
```

`Countdown` 没有 `__iter__`(`hasattr __iter__: False`)，`for`、`in`、`reversed`、`list()` 却都能用。`iter()` 的规则在 `Objects/abstract.c` 第 2806 到 2816 行：没有 `tp_iter` 但有序列协议，就包一个序列迭代器 `PySeqIter_New`：

```c
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
```

它的 `next` 在 `Objects/iterobject.c` 第 70 到 82 行：从 0 开始一个一个 `__getitem__`，直到抛 `IndexError`（或 `StopIteration`），碰到就当作结束：

```c
    result = PySequence_GetItem(seq, it->it_index);
    if (result != NULL) {
        it->it_index++;
        return result;
    }
    if (PyErr_ExceptionMatches(PyExc_IndexError) ||
        PyErr_ExceptionMatches(PyExc_StopIteration))
    {
        PyErr_Clear();
        it->it_seq = NULL;
        Py_DECREF(seq);
    }
    return NULL;
```

`in` 的退路类似：`PySequence_Contains`（`Objects/abstract.c` 第 2231 行）先找 `sq_contains`，找不到就退回到迭代去搜。

所以 `7 in c` 为假是遍历了三个元素才知道的。`bool` 的规则最后一个说：没有 `__bool__` 就看 `__len__`，`Basket([])` 因此是假；两个都有，`__bool__` 优先（`Switch`：长度是 0，布尔是 `True`）。`bool(PostingList())` 为假也是这样来的：一个空的倒排表没有任何文档。

`PostingList` 的四个方法在 `src/sift/index.py` 第 63 到 78 行（注意 `__getitem__` 文档字符串里括号的那半句）：

```python
    def __len__(self) -> int:
        """Return the number of documents in the list."""
        return len(self._postings)

    def __iter__(self) -> Iterator[Posting]:
        """Iterate over the postings in doc_id order."""
        return iter(self._postings)

    def __getitem__(self, i: int) -> Posting:
        """Return the i-th posting (not the posting of doc_id i)."""
        return self._postings[i]

    def __contains__(self, doc_id: object) -> bool:
        """Return True if some posting has this doc_id."""
        i = bisect_left(self._postings, doc_id, key=_DOC_ID)
        return i < len(self._postings) and self._postings[i].doc_id == doc_id
```

`__contains__` 用 `bisect_left(..., key=_DOC_ID)` 在有序列表里二分，$O(\log n)$，比线性扫 `__iter__` 快得多。但它有个我自己也不喜欢的地方：`pl[1]` 是“第 1 个 `Posting`”，`5 in pl` 却是“有没有 `doc_id` 是 5 的文档”，两个方法对同一个对象说着不同的语言。可以直接验证：

```text
$ python3 -c '
from sift.index import Posting, PostingList

pl = PostingList([Posting(2, (0,)), Posting(5, (1, 3))])
print(5 in pl, Posting(5, (1, 3)) in list(pl))
print(hash(Posting(5, (1, 3))) == hash(Posting(5, (1, 3))))
try:
    Posting(5, (1, 3)) in pl
except TypeError as exc:
    print("TypeError:", exc)
try:
    hash(pl)
except TypeError as exc:
    print("TypeError:", exc)
'
True True
True
TypeError: '<' not supported between instances of 'int' and 'Posting'
TypeError: unhashable type: 'PostingList'
```

第一行的两个 `True` 是 `5 in pl` 和 `Posting(5, (1, 3)) in list(pl)`；可是 `Posting(5, (1, 3)) in pl` 抛 `TypeError`（拿 `int` 和 `Posting` 比大小）。Python 的惯例是 `x in obj` 应该和 `x in list(obj)` 一致，这里不一致。我保留它是因为搜索路径只用 `doc_id` 问“在不在”，但这是个值得在练习 1 里修的毛病。第二行的 `True` 说明两个相等的 `Posting` 哈希也相等；最后一行兑现了前面说的：`hash(pl)` 是 `TypeError: unhashable type: 'PostingList'`。

## `property`、`classmethod`、`staticmethod`

`property` 把“看起来是属性”的东西换成方法调用。`lab/ch06/properties.py`（第 4 到 53 行）：

```python
class Query:
    """A search query whose words are validated on assignment."""

    def __init__(self, text: str) -> None:
        """Set the text through the property so it is validated."""
        self.text = text

    @property
    def text(self) -> str:
        """Return the query text."""
        return self._text

    @text.setter
    def text(self, value: str) -> None:
        """Store value stripped; reject an empty query."""
        value = value.strip()
        if not value:
            raise ValueError("query must not be empty")
        self._text = value

    @property
    def words(self) -> list[str]:
        """Return the words; computed on every access, never stored."""
        return self._text.split()

    @property
    def size(self) -> int:
        """Return the number of words (read-only)."""
        return len(self.words)


def main() -> None:
    """Exercise getter, setter, deleter-less and read-only access."""
    q = Query("  rust ownership ")
    print("text:", repr(q.text))
    print("words:", q.words, "size:", q.size)
    q.text = "kalman filter smoother"
    print("after assignment:", q.words, q.size)
    try:
        q.text = "   "
    except ValueError as exc:
        print("empty text ->", exc)
    try:
        q.size = 5  # type: ignore[misc]
    except AttributeError as exc:
        print("size = 5 ->", exc)
    print("vars(q):", vars(q))
    print("type(Query.text):", type(Query.text).__name__)
    print("Query.text.fget:", Query.text.fget.__name__)
    print("Query.size.fset:", Query.size.fset)
```

```text
$ python3 lab/ch06/properties.py
text: 'rust ownership'
words: ['rust', 'ownership'] size: 2
after assignment: ['kalman', 'filter', 'smoother'] 3
empty text -> query must not be empty
size = 5 -> property 'size' of 'Query' object has no setter
vars(q): {'_text': 'kalman filter smoother'}
type(Query.text): property
Query.text.fget: text
Query.size.fset: None
```

读 `q.text` 调的是 getter，`q.text = ...` 调 setter（这里的 setter 顺便做了校验，空查询抛 `ValueError`）。`size` 只有 getter，赋值就是 `AttributeError`。看 `vars(q)`：里面只有 `_text`，`text` 不在实例字典里，因为 `property` 是类上的数据描述符，赋值和读取在查实例字典之前就被它截住了；`type(Query.text)` 是 `property`，`Query.text.fget` 就是被装饰的函数。描述符的完整规则是第 15 篇的内容，这里先记住：`property` 活在类上。

`Posting.tf` 是同一个模式，`src/sift/index.py` 第 14 到 28 行：

```python
@dataclass(frozen=True, slots=True)
class Posting:
    """One document in the posting list of a term.

    positions are the token positions of the term in the document,
    in increasing order.
    """

    doc_id: int
    positions: tuple[int, ...]

    @property
    def tf(self) -> int:
        """Return the term frequency: how often the term occurs."""
        return len(self.positions)
```

`tf` 不存，现算 `len(self.positions)`：事实只存一份（位置），词频由它推出来，两者永远不会不一致。

`classmethod` 收到的是类本身，`staticmethod` 什么也不收。`lab/ch06/class_static_methods.py`（第 8 到 51 行）：

```python
class Version:
    """A version number with alternate constructors."""

    def __init__(self, major: int, minor: int) -> None:
        """Store the two numbers."""
        self.major = major
        self.minor = minor

    @classmethod
    def parse(cls, text: str) -> Version:
        """Build a Version from ``"3.14"``; cls follows subclasses."""
        major, minor = text.split(".")
        return cls(int(major), int(minor))

    @staticmethod
    def is_valid(text: str) -> bool:
        """Return True for ``digits.digits``; needs no instance."""
        major, dot, minor = text.partition(".")
        return bool(dot) and major.isdigit() and minor.isdigit()

    def __repr__(self) -> str:
        """Return the constructor-style form."""
        return f"{type(self).__name__}({self.major}, {self.minor})"


class Python(Version):
    """A subclass: parse() builds a Python, not a Version."""


def main() -> None:
    """Show both decorators, then Document.from_markdown."""
    print("Version.parse('3.14'):", Version.parse("3.14"))
    print("Python.parse('3.14'):", Python.parse("3.14"))
    print("is_valid:", Version.is_valid("3.14"), Version.is_valid("3."))
    print("Version.parse:", Version.parse)
    print("Version.is_valid:", Version.is_valid)
    print("same function via an instance:", Version(1, 0).is_valid("1.0"))

    path = Path("tests/fixtures/mini/tea-brewing.md")
    doc = Document.from_markdown(0, path, path.read_text(encoding="utf-8"))
    print("title:", doc.title)
    print("published:", doc.published.isoformat())
    print("tags:", doc.tags, "category:", doc.category)
    print("body starts:", repr(doc.body[:30]))
```

```text
$ python3 lab/ch06/class_static_methods.py
Version.parse('3.14'): Version(3, 14)
Python.parse('3.14'): Python(3, 14)
is_valid: True False
Version.parse: <bound method Version.parse of <class '__main__.Version'>>
Version.is_valid: <function Version.is_valid at 0x7ffff6c7cb40>
same function via an instance: True
title: 泡茶的温度与时间
published: 2026-01-01T08:00:00+08:00
tags: ('茶', '生活') category: Notes
body starts: '\n泡茶的温度与时间\n\n绿茶适合用 80 度左右的水，红茶可以'
```

`Python.parse("3.14")` 造出的是 `Python`，不是 `Version`：`cls` 跟着调用它的类走，所以替代构造器应该写成 `classmethod`，不要在里面写死类名。`staticmethod` 在 `Version.is_valid` 里只是放进命名空间的普通函数，输出里 `Version.is_valid` 是 `function`，`Version.parse` 是 `bound method ... of <class '__main__.Version'>`。

## 单下划线和双下划线

`_internal` 只是约定，Python 不拦你。`__secret` 才有机制，叫名字改写 (name mangling)。`lab/ch06/name_mangling.py`（第 4 到 45 行）：

```python
class Base:
    """Holds a private-ish helper and a mangled attribute."""

    def __init__(self) -> None:
        """Set one attribute of each flavor."""
        self.public = 1
        self._internal = 2  # convention only: "please do not touch"
        self.__secret = 3  # stored as _Base__secret

    def reveal(self) -> int:
        """Read the mangled attribute from inside the class."""
        return self.__secret


class Child(Base):
    """Defines its own __secret without clobbering Base's."""

    def __init__(self) -> None:
        """Set a __secret that lives under a different mangled name."""
        super().__init__()
        self.__secret = 99  # stored as _Child__secret

    def child_secret(self) -> int:
        """Read Child's own mangled attribute."""
        return self.__secret


def main() -> None:
    """Show where the names really live."""
    b = Base()
    print("vars(Base()):", vars(b))
    print("b._internal:", b._internal)
    try:
        print(b.__secret)
    except AttributeError as exc:
        print("b.__secret ->", exc)
    print("b._Base__secret:", b._Base__secret)

    c = Child()
    print("vars(Child()):", vars(c))
    print("reveal() still sees Base's:", c.reveal())
    print("child_secret():", c.child_secret())
```

```text
$ python3 lab/ch06/name_mangling.py
vars(Base()): {'public': 1, '_internal': 2, '_Base__secret': 3}
b._internal: 2
b.__secret -> 'Base' object has no attribute '__secret'
b._Base__secret: 3
vars(Child()): {'public': 1, '_internal': 2, '_Base__secret': 3, '_Child__secret': 99}
reveal() still sees Base's: 3
child_secret(): 99
dunder names are not mangled: __init__ in vars: True
```

类体里的 `self.__secret` 被编译成 `self._Base__secret`，`Child` 的 `__secret` 是 `_Child__secret`，两个互不踩。目的是子类不小心和父类重名，不是隐私：`b._Base__secret` 照样读得到。双下划线加双下划线结尾的名字 (`__init__`) 不改写。`PostingList` 里我只用了单下划线的 `_postings`。

## `__slots__` 和 3.14 的对象布局

默认的实例有 `__dict__`，可以随时加属性；`__slots__` 把属性名固定下来，不给实例字典。`lab/ch06/slots_attr_fail.py` 第 4 到 21 行，故意写错：

```python
class Point:
    """Two slots and nothing else."""

    __slots__ = ("x", "y")

    def __init__(self, x: int, y: int) -> None:
        """Fill both slots."""
        self.x = x
        self.y = y


def main() -> None:
    """Add a third attribute to a Point."""
    p = Point(1, 2)
    print("slots:", Point.__slots__, "has __dict__:", hasattr(p, "__dict__"))
    # error: AttributeError: 'Point' object has no attribute 'z' and no
    # __dict__ for setting new attributes
    p.z = 3
```

```text
$ python3 lab/ch06/slots_attr_fail.py 2>&1 | sed "s|$HOME|~|"
slots: ('x', 'y') has __dict__: False
Traceback (most recent call last):
  File "~/Projects/sift/lab/ch06/slots_attr_fail.py", line 25, in <module>
    main()
    ~~~~^^
  File "~/Projects/sift/lab/ch06/slots_attr_fail.py", line 21, in main
    p.z = 3
    ^^^
AttributeError: 'Point' object has no attribute 'z' and no __dict__ for setting new attributes
```

换来的是内存。`lab/ch06/slots_memory.py` 对同样两个字段的 `DictPosting` 和 `SlotPosting` 各造 10 万个，用 `tracemalloc` 数（第 10 到 57 行）：

```python
@dataclass(frozen=True)
class DictPosting:
    """Posting with the default per-instance __dict__."""

    doc_id: int
    positions: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class SlotPosting:
    """The same fields stored in slots."""

    doc_id: int
    positions: tuple[int, ...]


def traced(cls: type, touch_dict: bool = False) -> float:
    """Return KiB held by N instances sharing one positions tuple.

    The figure includes the list slot (8 bytes) and one int object per
    doc_id. With touch_dict, read ``__dict__`` of every instance,
    which makes Python build the real dict object.
    """
    positions = (1, 2, 3)
    tracemalloc.start()
    held = [cls(i, positions) for i in range(N)]
    if touch_dict:
        for obj in held:
            _ = obj.__dict__
    current, _ = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert len(held) == N
    return current / 1024


def main() -> None:
    """Print per-object and per-100,000 memory for both layouts."""
    d = DictPosting(1, (1, 2, 3))
    s = SlotPosting(1, (1, 2, 3))
    print("has __dict__:", hasattr(d, "__dict__"), hasattr(s, "__dict__"))
    # Since 3.13 the values of a plain instance live inline in the
    # object and the dict is built on demand, so getsizeof says little.
    print("getsizeof(DictPosting):", sys.getsizeof(d))
    print("getsizeof(SlotPosting):", sys.getsizeof(s))
    print("getsizeof(d.__dict__):", sys.getsizeof(d.__dict__))
    dict_kib = traced(DictPosting)
    slot_kib = traced(SlotPosting)
    wide_kib = traced(DictPosting, touch_dict=True)
```

```text
$ python3 lab/ch06/slots_memory.py
has __dict__: True False
getsizeof(DictPosting): 48
getsizeof(SlotPosting): 48
getsizeof(d.__dict__): 296
tracemalloc, 100000 DictPosting:         12495 KiB
tracemalloc, 100000 DictPosting+dict:    18740 KiB
tracemalloc, 100000 SlotPosting:          8584 KiB
per DictPosting: 128 bytes
per DictPosting+dict: 192 bytes
per SlotPosting: 88 bytes
ratio dict/slots: 1.46
ratio dict+dict/slots: 2.18
```

每个 `SlotPosting` 88 字节，每个 `DictPosting` 128 字节；10 万个是 8584 KiB 对 12495 KiB，1.46 倍。把每个实例的 `__dict__` 都真的取出来（`touch_dict`，输出里的 `+dict` 行），每个实例涨到 192 字节，2.18 倍。（每个实例的字节数里包括列表里的一个 8 字节槽和 `doc_id` 的 `int` 对象的 32 字节，扣掉它们，`SlotPosting` 对象本身是 48 字节，`DictPosting` 是 88 字节。）

但前面几行输出里有个矛盾：`sys.getsizeof` 对两种布局都说 48，`tracemalloc` 却数出每个 `DictPosting` 比 `SlotPosting` 多 40 字节（128 对 88，其中列表里的 8 字节槽和 `doc_id` 的 `int` 对象的 32 字节两边相同）。在 3.14.7 里，没有 `__slots__` 的实例把属性值直接放在对象后面 (inline values)，`__dict__` 要用的时候才造；`getsizeof` 不算这些值。`/tmp/p06/scratch/layout_probe.py` 全文：

```python
"""Where the bytes of a Posting go: dict layout vs slots layout."""

import sys
import tracemalloc
from dataclasses import dataclass

INLINE_VALUES = 1 << 2  # Py_TPFLAGS_INLINE_VALUES, Include/object.h
MANAGED_DICT = 1 << 4  # Py_TPFLAGS_MANAGED_DICT
N = 10_000


@dataclass(frozen=True)
class DictPosting:
    """Two fields, default layout (values inline in the object)."""

    doc_id: int
    positions: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class SlotPosting:
    """The same two fields in slots."""

    doc_id: int
    positions: tuple[int, ...]


def allocated(cls: type) -> float:
    """Return the bytes tracemalloc sees per instance of cls.

    The instances share one tuple and the cached int 1, and the list
    that holds them is allocated first, so only the objects count.
    """
    positions = (1, 2, 3)
    held: list[object] = [None] * N
    tracemalloc.start()
    before = tracemalloc.get_traced_memory()[0]
    for i in range(N):
        held[i] = cls(1, positions)
    after = tracemalloc.get_traced_memory()[0]
    tracemalloc.stop()
    return (after - before) / N


def main() -> None:
    """Print basicsize, flags, getsizeof and the real allocation."""
    for cls in (DictPosting, SlotPosting):
        obj = cls(1, (1, 2, 3))
        print(
            f"{cls.__name__:12} basicsize={cls.__basicsize__:3}"
            f"  inline_values={bool(cls.__flags__ & INLINE_VALUES)!s:5}"
            f"  managed_dict={bool(cls.__flags__ & MANAGED_DICT)!s:5}"
            f"  getsizeof={sys.getsizeof(obj)}"
            f"  allocated={allocated(cls):.0f}"
        )


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p06/scratch/layout_probe.py
DictPosting  basicsize= 16  inline_values=True   managed_dict=True   getsizeof=48  allocated=88
SlotPosting  basicsize= 32  inline_values=False  managed_dict=False  getsizeof=48  allocated=48
```

两种布局的 `getsizeof` 都是 48，`tracemalloc` 数到的是 88 和 48。差的 40 字节哪来的，在源码里能对上。`sys.getsizeof` 是 `__sizeof__` 的返回值加上“前置头”的大小（`Python/sysmodule.c` 第 1970 行和第 1973 行）：

```c
        presize = _PyType_PreHeaderSize(Py_TYPE(o));
    /* ... */
    return (size_t)size + presize;
```

`object.__sizeof__` 只返回 `tp_basicsize`（外加变长部分，这里没有），`Objects/typeobject.c` 第 7908 行：

```c
    res += Py_TYPE(self)->tp_basicsize;

    return PyLong_FromSsize_t(res);
```

前置头由 `_PyType_PreHeaderSize` 给出（`Include/internal/pycore_object.h` 第 854 到 863 行）：

```c
static inline size_t
_PyType_PreHeaderSize(PyTypeObject *tp)
{
    return (
#ifndef Py_GIL_DISABLED
        (size_t)_PyType_IS_GC(tp) * sizeof(PyGC_Head) +
#endif
        (size_t)_PyType_HasFeature(tp, Py_TPFLAGS_PREHEADER) * 2 * sizeof(PyObject *)
    );
}
```

GC 头（`PyGC_Head`，16 字节）加上，如果类带 `MANAGED_DICT` 或 `MANAGED_WEAKREF` 标志，再加两个指针（16 字节）。`DictPosting` 带 `MANAGED_DICT`（探针里的 `managed_dict=True`），前置头是 32；`SlotPosting` 只有 GC 头，是 16。所以：

- `DictPosting`：`tp_basicsize` 16（只有 `PyObject` 头）加前置头 32，是 `getsizeof` 的 48。
- `SlotPosting`：`tp_basicsize` 32（头加两个槽）加前置头 16，也是 48。

两个 48 是巧合。真正分配时（`Objects/typeobject.c` 的 `_PyType_AllocNoTrack`），带 inline values 的类型还要多要一块：

```c
    size_t size = _PyObject_VAR_SIZE(type, nitems+1);

    const size_t presize = _PyType_PreHeaderSize(type);
    if (type->tp_flags & Py_TPFLAGS_INLINE_VALUES) {
        assert(type->tp_itemsize == 0);
        size += _PyInlineValuesSize(type);
    }
    char *alloc = _PyObject_MallocWithType(type, size + presize);
```

这块的大小是 `_PyInlineValuesSize`（`Include/internal/pycore_dict.h` 第 336 到 345 行）：

```c
static inline size_t
_PyInlineValuesSize(PyTypeObject *tp)
{
    PyDictKeysObject *keys = ((PyHeapTypeObject*)tp)->ht_cached_keys;
    assert(keys != NULL);
    size_t size = shared_keys_usable_size(keys);
    size_t prefix_size = _Py_SIZE_ROUND_UP(size, sizeof(PyObject *));
    assert(prefix_size < 256);
    return prefix_size + (size + 1) * sizeof(PyObject *);
}
```

`size` 来自共享键表的 `dk_nentries + dk_usable`。`dk_usable` 起点是 30，每造一个新实例就减 1，减到 1 为止（`Objects/dictobject.c` 第 6839 到 6841 行，非自由线程的构建里）：

```c
    if (keys->dk_usable > 1) {
        keys->dk_usable--;
    }
```

我的 `Posting` 有两个字段，所以大概是 `size = 2 + 1 = 3`，`prefix_size` 是 8，加上 `(3 + 1) * 8 = 32`，一共 40 字节（这一步是我按源码推的，`size` 本身没有从解释器里读出来）。合起来 `32 + 16 + 40 = 88`，和 `tracemalloc` 的 88 一致，`getsizeof` 因此少报了 40 字节。第三行里 `getsizeof(d.__dict__)` 是 296，实际每个实例取出 `__dict__` 后多出来的只有 64 字节（192 减 128，大概就是一个 `dict` 对象本身，值仍在原处），这又是一个不能拿 `getsizeof` 当账本的理由。

所以结论是：`__slots__` 是真的省，而且省得有据可查；但要看它省多少，用 `tracemalloc`，不要用 `getsizeof`。`Posting` 在 Sift 里有 290820 个，如果每个是 88 字节而不是 48 字节，光对象本身就多出 11.1 MiB（按 $290820 \times 40 / 2^{20}$ 算）。

## `dataclass`：把样板代码交出去

上面每个类我都手写了 `__init__`、`__repr__` 和 `__eq__`，`Posting` 和 `Document` 一个也没有手写，因为它们是 dataclass。`lab/ch06/dataclasses_tour.py` 把选项挨个试了一遍（第 12 到 80 行）：

```python
@dataclass
class Bag:
    """Mutable defaults need default_factory, not ``= []``."""

    name: str
    terms: list[str] = field(default_factory=list)
    seen: int = field(default=0, repr=False, compare=False)


@dataclass(frozen=True, order=True)
class Version:
    """Frozen, hashable, and ordered field by field."""

    major: int
    minor: int = 0


@dataclass(slots=True, kw_only=True)
class Config:
    """Every argument must be passed by keyword."""

    k1: float = 1.2
    b: float = 0.75
    limit: int = 10


@dataclass
class Span:
    """Derived data and validation in __post_init__."""

    start: int
    end: int
    length: int = field(init=False)

    def __post_init__(self) -> None:
        """Validate the bounds and compute length."""
        if self.end < self.start:
            raise ValueError(f"end {self.end} < start {self.start}")
        self.length = self.end - self.start


def main() -> None:
    """Show what each option generates."""
    a, b = Bag("a"), Bag("b")
    a.terms.append("x")
    print("separate lists:", a.terms, b.terms)
    print("generated repr:", a)
    print("eq ignores 'seen':", Bag("a", ["x"], 5) == Bag("a", ["x"], 9))
    print("fields:", [f.name for f in fields(Bag)])

    v = Version(3, 14)
    print("order:", Version(3, 9) < v < Version(4), sorted([v, Version(2)]))
    print("hashable:", hash(v) == hash(Version(3, 14)), {v, Version(3, 14)})
    print("replace:", replace(v, minor=15), "original:", v)
    print("asdict:", asdict(Bag("c", ["t"])))

    cfg = Config(limit=5)
    print("kw_only:", cfg)
    try:
        Config(1.5)  # type: ignore[misc]
    except TypeError as exc:
        print("positional ->", exc)
    print("slots, no __dict__:", not hasattr(cfg, "__dict__"))

    print("post_init:", Span(2, 9))
    try:
        Span(9, 2)
    except ValueError as exc:
        print("bad span ->", exc)
```

```text
$ python3 lab/ch06/dataclasses_tour.py
separate lists: ['x'] []
generated repr: Bag(name='a', terms=['x'])
eq ignores 'seen': True
fields: ['name', 'terms', 'seen']
order: True [Version(major=2, minor=0), Version(major=3, minor=14)]
hashable: True {Version(major=3, minor=14)}
replace: Version(major=3, minor=15) original: Version(major=3, minor=14)
asdict: {'name': 'c', 'terms': ['t'], 'seen': 0}
kw_only: Config(k1=1.2, b=0.75, limit=5)
positional -> Config.__init__() takes 1 positional argument but 2 were given
slots, no __dict__: True
post_init: Span(start=2, end=9, length=7)
bad span -> end 2 < start 9
generated methods: ['__eq__', '__hash__', '__init__', '__lt__', '__repr__']
```

每一项选项在输出里都有对应：

- `field(default_factory=list)`：每个实例各一个新列表 (`separate lists`)。写成 `= []` 会在类定义时就报错，不是悄悄共享：

  ```text
  $ python3 -c '
  from dataclasses import dataclass


  @dataclass
  class Bag:
      terms: list[str] = []  # BAD: mutable default
  ' 2>&1 | tail -n 1
  ValueError: mutable default <class 'list'> for field terms is not allowed: use default_factory
  ```

- `field(repr=False, compare=False)`：`seen` 不进 `repr`，也不影响 `==`。
- `frozen=True, order=True`：不可变、可哈希，`<` 按字段元组比较，和上一节 `total_ordering` 要手写的是同一件事；`replace(v, minor=15)` 复制出一个改了字段的新对象，因为原对象改不了。
- `slots=True, kw_only=True`：不要 `__dict__`、所有参数必须写名字（`Config(1.5)` 的 `TypeError`）。
- `__post_init__`：在生成的 `__init__` 末尾被调用，做校验和派生字段 (`length`)。

`frozen=True` 的错误长这样 (`lab/ch06/frozen_fail.py`)：

```text
$ python3 lab/ch06/frozen_fail.py 2>&1 | sed "s|$HOME|~|"
before: Posting(doc_id=1, positions=(0, 3))
Traceback (most recent call last):
  File "~/Projects/sift/lab/ch06/frozen_fail.py", line 24, in <module>
    main()
    ~~~~^^
  File "~/Projects/sift/lab/ch06/frozen_fail.py", line 20, in main
    p.doc_id = 2
    ^^^^^^^^
  File "<string>", line 16, in __setattr__
dataclasses.FrozenInstanceError: cannot assign to field 'doc_id'
```

最后一帧是 `File "<string>", line 16, in __setattr__`：`dataclass` 是在运行时把这些方法拼成源码、`exec` 出来的，所以没有真实的文件可指。拼 `__init__` 的那部分，对 frozen 类和不 frozen 的类写法不同（`Lib/dataclasses.py` 第 586 到 588 行）：

```python
    if frozen:
        return f'  __dataclass_builtins_object__.__setattr__({self_name},{name!r},{value})'
    return f'  {self_name}.{name}={value}'
```

frozen 的类不能直接 `self.x = ...`（它自己的 `__setattr__` 会抛 `FrozenInstanceError`），只好对每个字段调一次 `object.__setattr__`。这不是免费的。`/tmp/p06/scratch/posting_cost.py` 全文，数量取 Sift 里 `Posting` 的实际个数 290820：

```python
"""Cost of making 290,820 postings: frozen or not."""

import timeit
from dataclasses import dataclass
from functools import partial

N = 290_820
REPEAT = 5
POS = (1, 2, 3)


@dataclass(frozen=True, slots=True)
class Frozen:
    """What sift.index.Posting is."""

    doc_id: int
    positions: tuple[int, ...]


@dataclass(slots=True)
class Mutable:
    """The same fields without frozen=True."""

    doc_id: int
    positions: tuple[int, ...]


def make(cls: type) -> list[object]:
    """Build N instances of cls."""
    return [cls(i, POS) for i in range(N)]


def main() -> None:
    """Print the best of REPEAT timings, in milliseconds."""
    for name, cls in [("frozen", Frozen), ("not frozen", Mutable)]:
        best = min(timeit.repeat(partial(make, cls), number=1, repeat=REPEAT))
        print(f"{name:12} {best * 1000:7.1f} ms")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p06/scratch/posting_cost.py
frozen         101.6 ms
not frozen      42.3 ms
```

290820 个 frozen 的 `Posting` 要 101.6 ms，同样的字段不 frozen 是 42.3 ms，2.4 倍。我选了 frozen，是因为 `Posting` 被放进 `PostingList` 之后就不该再变，这个代价后面会在时间账本里再出现一次。Rust 里 `#[derive(PartialEq, Eq, Hash)]` 和 dataclass 的 `eq`、`frozen` 是同一类工具，只是 Rust 的“不可变”是默认。

## 枚举

`enum` 把一组有名字的常量变成类型。`lab/ch06/enums.py`（第 6 到 38 行）：

```python
class Field(StrEnum):
    """Searchable fields; members are str and compare to str."""

    TITLE = auto()
    TAG = auto()
    CATEGORY = auto()
    SERIES = auto()


class Kind(Enum):
    """A plain enum: members are singletons, not ints or strs."""

    WORD = auto()
    PHRASE = auto()
    PREFIX = auto()


class Perm(IntFlag):
    """Bit flags: members combine with | and test with &."""

    READ = auto()
    WRITE = auto()
    EXEC = auto()


def main() -> None:
    """Show names, values, lookup, iteration and combination."""
    print("Kind.WORD:", Kind.WORD, repr(Kind.WORD))
    print("name, value:", Kind.WORD.name, Kind.WORD.value)
    print("by value:", Kind(2), "by name:", Kind["PREFIX"])
    print("iteration:", list(Kind))
    print("identity:", Kind(1) is Kind.WORD)
    print("Kind.WORD == 1:", Kind.WORD == 1)
```

```text
$ python3 lab/ch06/enums.py
Kind.WORD: Kind.WORD <Kind.WORD: 1>
name, value: WORD 1
by value: Kind.PHRASE by name: Kind.PREFIX
iteration: [<Kind.WORD: 1>, <Kind.PHRASE: 2>, <Kind.PREFIX: 3>]
identity: True
Kind.WORD == 1: False
Kind(9) -> 9 is not a valid Kind
StrEnum: tag <Field.TAG: 'tag'> True
lookup from text: category
f-string: title:rust
IntFlag: 3 3 <Perm.READ|WRITE: 3>
has WRITE: True has EXEC: False
all flags: 7
rw & ~WRITE: 1
rw == 3: True
```

`Kind` 是普通枚举：成员是单例 (`Kind(1) is Kind.WORD`)，`Kind.WORD == 1` 是 `False`，整数和枚举成员不混；按值查找不存在的成员，`Kind(9)` 抛 `ValueError`。`Field` 是 `StrEnum`，成员本身就是 `str`，`Field.TAG == "tag"`，可以直接放进 f-string。`Perm` 是 `IntFlag`，`|` 和 `&` 可以组合，`rw == 3` 为真。`auto()` 让值自己长出来，不用手写。

Sift 目前还没有用到枚举，`Field` 是我给后面查询里 `title:rust` 这类字段限定准备的，我猜到时候会用它。

## 时间：`datetime` 和 `zoneinfo`

front matter 里的 `published` 是 `"2026-04-05 16:20:00 +08:00"` 这种字符串。要比较、排序、做差，得有带时区的 `datetime`。`lab/ch06/datetimes.py`（第 14 到 30 行）：

```python
def main() -> None:
    """Parse the dates of the corpus and compare datetimes."""
    print("tz:", SHANGHAI, "key:", SHANGHAI.key)
    for text in [
        "2026-04-05 16:20:00 +08:00",
        "2025-10-18 22:30 +08:00",
        "2026-09-01",
    ]:
        dt = parse_datetime(text)
        print(f"{text!r:32} -> {dt.isoformat()} {dt.tzname()}")

    naive = datetime(2026, 1, 1, 8, 0)
    aware = datetime(2026, 1, 1, 8, 0, tzinfo=SHANGHAI)
    print(
        "naive.tzinfo:", naive.tzinfo, "aware.utcoffset():", aware.utcoffset()
    )
    print("aware in UTC:", aware.astimezone(UTC).isoformat())
```

```text
$ python3 lab/ch06/datetimes.py
tz: Asia/Shanghai key: Asia/Shanghai
'2026-04-05 16:20:00 +08:00'     -> 2026-04-05T16:20:00+08:00 CST
'2025-10-18 22:30 +08:00'        -> 2025-10-18T22:30:00+08:00 CST
'2026-09-01'                     -> 2026-09-01T00:00:00+08:00 CST
naive.tzinfo: None aware.utcoffset(): 8:00:00
aware in UTC: 2026-01-01T00:00:00+00:00
same instant in New York: 2025-12-31T19:00:00-05:00
naive == aware: False
naive < aware -> can't compare offset-naive and offset-aware datetimes
aware - naive -> can't subtract offset-naive and offset-aware datetimes
timedelta: 6 days, 16:00:00 days: 6 seconds: 57600
aware + 36h: 2026-01-02T20:00:00+08:00
posts: 123
oldest: 2023-08-20 learning-fgets-and-strcspn.md
newest: 2026-10-19 typst-by-xuan-16-export-and-tooling.md
span: 1155 days, 23:15:29
```

有时区的 (aware) 和没时区的 (naive)`datetime` 是两种东西：`naive == aware` 是 `False`，`naive < aware` 和 `aware - naive` 都抛 `TypeError`，Python 宁可不让你比，也不猜一个时区。`ZoneInfo("Asia/Shanghai")` 读的是时区数据库，不是固定的 `+08:00` 偏移；`astimezone` 换算同一个时刻（`2026-01-01T08:00+08:00` 在纽约是前一天的 19:00）。`datetime` 之间的差是 `timedelta`，`6 days, 16:00:00` 就是 `days: 6, seconds: 57600`。

脚本最后顺手把语料里 123 篇的 `published` 全部解析了，最早是 `2023-08-20` 的 `learning-fgets-and-strcspn.md`，最新是 `2026-10-19`，跨度 1155 天。`parse_datetime` 在 `src/sift/document.py` 第 12 到 31 行：

```python
SHANGHAI = ZoneInfo("Asia/Shanghai")
_DATETIME_FORMATS = ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%d %H:%M %z")


def parse_datetime(value: str) -> datetime:
    """Return value as an aware datetime in Asia/Shanghai.

    Accepts ``"YYYY-MM-DD HH:MM:SS +08:00"``, the same without the
    seconds, and a bare ``YYYY-MM-DD`` (midnight in Asia/Shanghai).
    Other formats raise ValueError.
    """
    for fmt in _DATETIME_FORMATS:
        try:
            return datetime.strptime(value, fmt).astimezone(SHANGHAI)
        except ValueError:
            continue
    try:
        return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=SHANGHAI)
    except ValueError:
        raise ValueError(f"unrecognized date: {value!r}") from None
```

先试带秒的，再试不带秒的，最后试纯日期（午夜，按上海时区）。三个都不是才抛 `ValueError`。这三种我都需要，下一节解释为什么。

## front matter 解析器

标准库里没有 YAML 解析器（这个环境里连 `yaml` 也没有）：

```text
$ python3 -c 'import yaml' 2>&1 | tail -n 1
ModuleNotFoundError: No module named 'yaml'
```

Sift 的语料是我自己的博客文章，每篇开头有一段 `---` 包起来的 front matter，所以我写了一个够用的。我列的最小清单是：双引号和单引号字符串、`true`/`false`、整数、块列表和行内列表。语料说这不够，用 `/tmp/p06/scratch/value_shapes.py` 数一下每个值的形状：

```python
"""Count the syntactic shapes of front matter values in the corpus."""

import re
from collections import Counter
from pathlib import Path

from sift.markdown import split_front_matter

ROOT = Path("corpus/posts")
KEY = re.compile(r"([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?")
INT = re.compile(r"[+-]?[0-9]+")
SECONDS = re.compile(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d")


def shape(raw: str | None) -> str:
    """Classify the text after ``key:``."""
    if raw is None:
        return "block list opener"
    if raw in ("true", "false"):
        return "bool"
    if INT.fullmatch(raw):
        return "int"
    if raw[0] in "\"'[":
        return {'"': "double-quoted", "'": "single-quoted"}.get(raw[0], "list")
    if raw[0] in ">|":
        return f"block scalar {raw}"
    return "plain"


def main() -> None:
    """Print how many values and files use each shape."""
    values: Counter[str] = Counter()
    files: dict[str, set[str]] = {}
    plain_keys: Counter[str] = Counter()
    no_seconds = []
    for path in sorted(ROOT.glob("*.md")):
        front = split_front_matter(path.read_text(encoding="utf-8"))[0]
        for line in front.splitlines():
            if not (m := KEY.fullmatch(line)):
                continue
            kind = shape(m[2])
            values[kind] += 1
            files.setdefault(kind, set()).add(path.name)
            if kind == "plain":
                plain_keys[m[1]] += 1
            if m[1] == "published" and not SECONDS.fullmatch(m[2].strip('"')):
                no_seconds.append(path.name)
    for kind, n in values.most_common():
        print(f"{n:5} values in {len(files[kind]):3} files  {kind}")
    print("plain values by key:", dict(plain_keys))
    print("published without seconds:", no_seconds)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p06/scratch/value_shapes.py
  576 values in 123 files  double-quoted
  249 values in 123 files  bool
  226 values in 123 files  plain
  123 values in 123 files  block list opener
   86 values in  86 files  int
    2 values in   2 files  block scalar >-
plain values by key: {'category': 123, 'slug': 95, 'updated': 7, 'image': 1}
published without seconds: ['visual-studio-project-management.md']
```

三件事不在我的最小清单里：

- 不加引号的字符串，226 个值，分布在每一篇里：`category: Note` 每篇都有，`slug` 有 95 篇，`updated: 2026-09-01` 有 7 篇，`image` 有 1 篇。
- `description: >-` 块标量，2 篇。
- `published` 没有秒，1 篇 (`visual-studio-project-management.md`)；`updated` 只有日期，所以 `parse_datetime` 还要认纯日期。

那两个 `>-` 还有一个意外：后面没有任何缩进的文字，块是空的。

```text
$ sed -n '4,6p' corpus/posts/notes-of-effective-cmake.md
published: "2025-08-08 23:17:00 +08:00"
description: >-
category: Note
$ python3 -c '
from pathlib import Path

from sift.frontmatter import parse_front_matter
from sift.markdown import split_front_matter

text = Path("corpus/posts/notes-of-effective-cmake.md").read_text("utf-8")
meta = parse_front_matter(split_front_matter(text)[0])
print(repr(meta["description"]), meta["category"])
'
'' Note
```

`description: >-` 后面紧接着就是 `category: Note`，所以解析出来是空字符串 `''`。我没有“修”这个，因为空块在 YAML 里本来就是合法的，它读出来就是空串。

于是 `parse_front_matter` 比最小清单多了不加引号的字符串，以及 `>`、`>-`、`|`、`|-` 四种块标量。完整的函数在 `src/sift/frontmatter.py` 第 92 到 138 行，它是个按行走的状态机：

```python
def parse_front_matter(text: str) -> dict[str, Value]:
    """Parse the front matter text of a post into a dict.

    The input is the text between the two ``---`` lines. Supported:
    ``key: value`` with double-quoted, single-quoted or plain strings,
    ``true``/``false``, integers, inline lists ``[a, b]``, block lists
    of ``  - item`` lines and the block scalars ``>``, ``>-``, ``|``
    and ``|-`` with indented text lines. Anything else, such as
    nesting, anchors or a repeated key, raises ValueError with the
    line number.
    """
    result: dict[str, Value] = {}
    lines = text.splitlines()
    open_list: list[str] | None = None
    open_key = ""
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if not line.strip():
            continue
        try:
            if m := _ITEM.fullmatch(line.rstrip()):
                if open_list is None:
                    raise ValueError("list item without a key")
                open_list.append(_parse_string(m[1].strip()))
                continue
            if open_list is not None and not open_list:
                raise ValueError(f"key {open_key!r} has no value")
            open_list = None
            if (m := _KEY.fullmatch(line.rstrip())) is None:
                raise ValueError(f"cannot parse line: {line!r}")
            key, raw = m[1], m[2]
            if key in result:
                raise ValueError(f"duplicate key {key!r}")
            if raw is None:
                open_list = result[key] = []
                open_key = key
            elif raw[0] in ">|":
                result[key], i = _block_scalar(lines, i, raw.strip())
            else:
                result[key] = _parse_scalar(raw.strip())
        except ValueError as exc:
            raise ValueError(f"line {i}: {exc}") from None
    if open_list is not None and not open_list:
        raise ValueError(f"key {open_key!r} has no value")
    return result
```

`open_list` 是它全部的状态：遇到 `key:` 后面什么也没有，就开一个列表，后面的 `- item` 行都进这个列表（第 127 到 129 行）；遇到别的行就关掉它。块标量要一次吃掉后面好几行，所以 `_block_scalar` 返回字符串和“下一行从哪开始”，`i` 随之跳过去（第 131 行）。第 114 行和第 122 行用了海象运算符，`fullmatch` 成功就顺手拿到匹配对象。

“字符串”的规则最容易写错，第 39 到 43 行是不加引号的那一支：

```python
    if raw[0] in _FLOW_START:
        raise ValueError(f"unsupported syntax: {raw}")
    if ": " in raw or raw.endswith(":") or " #" in raw:
        raise ValueError(f"ambiguous plain string: {raw}")
    return raw
```

引号里的字符串按 YAML 转义规则解码（第 31 到 38 行）；不加引号的字符串遇到 `: `、结尾的 `:` 或者 ` #` 就拒绝 (`ambiguous plain string`)，因为在真正的 YAML 里这些意味着别的东西，我不想悄悄读错。块标量（`_block_scalar`，第 74 到 89 行）按行读缩进的文字：

`>` 把缩进行用空格连起来，`|` 用换行连起来，末尾的 `-` 表示去掉结尾换行。我只实现了这四种头；`>2` 之类的缩进指示符会抛 `ValueError`。

`lab/ch06/frontmatter_corpus.py` 把 123 篇文章的 front matter 全解析一遍，统计键、分类和标签，再用 7 个故意写坏的输入看错误信息：

```text
$ python3 lab/ch06/frontmatter_corpus.py | sed -n '1,16p' | fold -s -w 79
front matter parsed: 123
keys: {'category': 123, 'comment': 123, 'commentId': 123, 'description': 123, 
'draft': 123, 'image': 1, 'published': 123, 'series': 86, 'seriesOrder': 86, 
'slug': 95, 'tags': 123, 'title': 123, 'toc': 3, 'updated': 7}
documents: 123
with series: 86
with updated: 7
posts per category:
    72  Note
    51  Tutorial
distinct tags: 239 uses: 498
top 15 tags:
    36  线性代数
    35  MIT 18.06
    35  NumPy
    17  Rust
    16  Typst
    16  Xuan
$ python3 lab/ch06/frontmatter_corpus.py | sed -n '/^bad inputs/,$p' | fold -s -w 79
bad inputs:
  'title: ok\ntitle: again'            -> ValueError: line 2: duplicate key 
'title'
  'title: "unterminated'               -> ValueError: line 1: bad 
double-quoted string: "unterminated
  'tags:\n  - a\nkey'                  -> ValueError: line 3: cannot parse 
line: 'key'
  '  - orphan item'                    -> ValueError: line 1: list item 
without a key
  'nested:\n    key: value'            -> ValueError: line 2: key 'nested' has 
no value
  'empty:'                             -> ValueError: key 'empty' has no value
  'note: >> folded'                    -> ValueError: line 1: unsupported 
block scalar header '>> folded'
```

123 篇都解析成功（输出里过长的行是我用 `fold -s -w 79` 折开的，折断处不是原输出的换行）。`keys` 一行统计每个键出现在多少篇里：`category`、`comment`、`commentId`、`description`、`draft`、`published`、`tags`、`title` 每篇都有，`series` 86 篇，`slug` 95 篇，`updated` 7 篇。分类是 `Note` 72 篇、`Tutorial` 51 篇，239 个不同的标签一共用了 498 次，最常见的是 `线性代数`（36 次），紧跟着是 `MIT 18.06` 和 `NumPy`（各 35 次），三者几乎并列。故意写坏的 7 个输入各报出行号和原因（有一个报 `key 'empty' has no value`，没有行号，因为错误在输入结束时才发现，没有“当前行”）。

脚本后半段还会解析 `tests/fixtures/mini` 里 8 篇玩具文章（分类写的是 `Notes`），上面的 `sed` 没有显示那一段。

## `Document` 和 `corpus`

有了解析器，`Document` 就是一个 frozen、slots 的 dataclass，加一个替代构造器（`src/sift/document.py` 第 39 到 83 行）：

```python
@dataclass(frozen=True, slots=True)
class Document:
    """A post: its metadata and its text with Markdown stripped."""

    doc_id: int
    path: Path
    title: str
    published: datetime
    updated: datetime | None
    tags: tuple[str, ...]
    category: str | None
    series: str | None
    body: str

    @classmethod
    def from_markdown(cls, doc_id: int, path: Path, text: str) -> Self:
        """Build a Document from the raw text of a Markdown file.

        Raises ValueError if the front matter is malformed or lacks a
        title or a publication date.
        """
        front, body = split_front_matter(text)
        try:
            meta = parse_front_matter(front)
            title = str(meta["title"])
            published = parse_datetime(str(meta["published"]))
            updated = _optional_str(meta, "updated")
            tags = meta.get("tags", [])
            if not isinstance(tags, list):
                tags = [tags]
            return cls(
                doc_id=doc_id,
                path=path,
                title=title,
                published=published,
                updated=None if updated is None else parse_datetime(updated),
                tags=tuple(map(str, tags)),
                category=_optional_str(meta, "category"),
                series=_optional_str(meta, "series"),
                body=strip_markdown(body),
            )
        except KeyError as exc:
            raise ValueError(f"{path}: missing {exc}") from None
        except ValueError as exc:
            raise ValueError(f"{path}: {exc}") from exc
```

`from_markdown` 做三件事：把文本拆成 front matter 和正文（`split_front_matter`，第 2 篇写的），解析 front matter，把正文的 Markdown 去掉 (`strip_markdown`)。失败的情形统一成一个异常，信息里带文件路径：缺了 `title` 或 `published` 是 `KeyError`，转成 `ValueError(f"{path}: missing ...")`，`from None` 不让内部的 `KeyError` 污染报错；解析器和日期自己抛的 `ValueError`，包上路径再抛，`from exc` 保留原因链。

`Self` 是 `typing` 里的类型，表示“调用这个方法的那个类”，配合 `classmethod` 让子类也能得到对的返回类型。

`corpus.py` 因此变得更短（第 9 到 19 行）：

```python
def iter_documents(root: Path) -> Iterator[Document]:
    """Yield every ``*.md`` file under root as a Document.

    Files come in sorted path order and the doc_id of a document is
    its position in that order. Each file is read and parsed when the
    consumer asks for it, never earlier. A malformed front matter
    raises ValueError naming the file.
    """
    for doc_id, path in enumerate(sorted(root.rglob("*.md"))):
        text = path.read_text(encoding="utf-8")
        yield Document.from_markdown(doc_id, path, text)
```

`enumerate` 给 `doc_id`，`Document.from_markdown` 是解析的唯一入口，文件仍然是“消费者要一个才读一个”，所以第 5 篇的惰性没有丢。第 5 篇的 `lab/ch05/genexp_vs_list.py` 受影响了：`iter_documents` 不再产出 `RawDoc`，没有了 `doc.text`，`bodies()` 里原来的 `strip_markdown(split_front_matter(doc.text)[1])` 换成了 `doc.body`，不再用的 `split_front_matter` 和 `strip_markdown` 导入也删掉了（最后“本篇文件”一节的 `git diff --stat` 给这个文件记了 3 行改动：1 行加，2 行减）。

重跑它，峰值内存的比值是 18.9 倍（第 5 篇是 18.8 倍），惰性还在：

```text
$ python3 lab/ch05/genexp_vs_list.py 2>/dev/null | sed -n '1,7p'
tokens via list:   812338
tokens via stream: 812338
same count: True
peak memory, list:        46364 KiB
peak memory, stream:       2455 KiB
peak ratio list/stream: 18.9x
time, list:     1034.6 ms (median of 3)
```

`lab/ch04/tfidf_vs_tf.py` 也是同一类改动：`load_index` 现在返回 `Document` 的列表，原来的 `paths[doc_id].name` 变成 `documents[doc_id].path.name`。

## Posting、PostingList 和 InvertedIndex

现在可以把倒排表写成类了。三个类，各管一层：`Posting` 是“一个词在一篇文档里的出现”，`PostingList` 是“一个词出现过的所有文档”，`InvertedIndex` 是“词到 `PostingList`”。`Posting` 前面已经看过了（第 14 到 28 行）。`PostingList` 的构造器和 `append`（第 46 到 57 行）：

```python
    def __init__(self, postings: Iterable[Posting] = ()) -> None:
        """Create a list from postings in any order."""
        self._postings = sorted(postings, key=_DOC_ID)
        ids = self.doc_ids()
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate doc_id in postings")

    def append(self, posting: Posting) -> None:
        """Add posting, whose doc_id must exceed every doc_id so far."""
        if self._postings and posting.doc_id <= self._postings[-1].doc_id:
            raise ValueError(f"doc_id {posting.doc_id} is not increasing")
        self._postings.append(posting)
```

构造时可以乱序，排好序再检查有没有重复的 `doc_id`；`append` 只允许 `doc_id` 严格增大，这样建索引时一路追加，不需要再排序。`InvertedIndex` 的类头和 `add` 在第 139 到 157 行：

```python
class InvertedIndex:
    """Map each term to the PostingList of the documents holding it."""

    def __init__(self) -> None:
        """Create an empty index."""
        self._postings: dict[str, PostingList] = {}

    def add(self, doc: Document, tokens: Iterable[Token]) -> None:
        """Index the tokens of one document.

        Documents must be added in increasing doc_id order. tokens may
        be a generator: it is consumed once.
        """
        positions: dict[str, list[int]] = {}
        for token in tokens:
            positions.setdefault(token.text, []).append(token.position)
        for term, found in positions.items():
            posting = Posting(doc.doc_id, tuple(found))
            self._postings.setdefault(term, PostingList()).append(posting)
```

一篇文档的词元流先按词收集位置，再对每个词造一个 `Posting`，放进这个词的 `PostingList`。`tokens` 可以是生成器，只消费一次，所以第 5 篇的 `iter_tokens` 直接接得上。其余四个方法（`__getitem__`、`__contains__`、`__len__`、`__iter__`）都是一行的转发。

搜索改成了先用 `&` 求出有哪些文档，再各自算分（`src/sift/__main__.py` 第 52 到 54 行，其余是第 4 篇就有的打分和排序）：

```python
    lists = [index[t] if t in index else PostingList() for t in terms]
    matching = reduce(and_, lists)
    tfs = [{p.doc_id: p.tf for p in plist} for plist in lists]
```

`reduce(and_, lists)` 把所有词的 `PostingList` 依次 `&` 起来，`matching.doc_ids()` 就是“每个词都有”的文档。分数还是第 4 篇的 `scoring(tf, df, n_docs)`，`tf` 取自原来那些列表，不取自交集。原因是 `_union` 会把两边的位置合在一起，交集上 `Posting.tf` 是“两个词一共出现几次”，不是任何一个词的词频，所以评分不能直接用它。这是 `&` 上的一个语义上的选择，我在这里写出来，免得以后有人以为交集里的 `tf` 能直接拿来打分。

改了这么多，搜索结果变了吗？我拿第 5 篇和这一篇各跑 5 个查询（包括一个查不到的），比较除最后一行（含时间）之外的全部输出，再比较 `stats`：

```text
$ for q in "kalman" "kalman filter" "rust 所有权" "device tree" "nosuchword"; do
  if diff <(at ch05 -m sift search $q 2>/dev/null | sed '$d') \
          <(at ch06 -m sift search $q 2>/dev/null | sed '$d') > /dev/null; then
    echo "same: $q"
  else
    echo "DIFFERENT: $q"
  fi
done
same: kalman
same: kalman filter
same: rust 所有权
same: device tree
same: nosuchword
$ diff <(at ch05 -m sift stats 2>/dev/null | sed '$d') \
     <(at ch06 -m sift stats 2>/dev/null | sed '$d') && echo "same: stats"
same: stats
```

全部一致。新的搜索输出长这样，`kalman filter` 要求两个词都在，5 篇：

```text
$ python3 -m sift search kalman filter
load_index took 1890.9 ms
  40.154  corpus/posts/kalman-filter-02-multivariate.md
  29.125  corpus/posts/kalman-filter-07-ukf.md
  26.329  corpus/posts/kalman-filter-06-eskf.md
  24.271  corpus/posts/kalman-filter-08-porting.md
  18.833  corpus/posts/kalman-filter-01-one-dimension.md
5 hits in 123 files: index built in 1890.9 ms, query took 0.130 ms
$ python3 -m sift stats 2>/dev/null | sed -n '1,8p'
documents: 123
vocabulary: 81192
  14594  0
  11405  1
   6620  2
   6317  a
   4740  一个
   4572  3
```

## 索引又变慢了

最后一节兑现开头的话。先量总时间。第 4、5、6 篇各导出一份，再加两个我自己改出来的变体 `ch06fix` 和 `ch06fix2`（一会儿解释），每个变体各跑 7 个新进程，轮流跑，计时的是 `/tmp/p06/scratch/build_probe.py` 里的一次 `load_index`（它还有两个模式，后面会用到）：

```python
"""Time or measure one load_index call, in a fresh process."""

import gc
import sys
import time
import tracemalloc

from sift.__main__ import CORPUS, load_index


def main() -> None:
    """Print ms; "nogc" turns the GC off, "mem" prints MiB instead."""
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "nogc":
        gc.disable()
    if mode == "mem":
        tracemalloc.start()
    start = time.perf_counter()
    result = load_index(CORPUS)
    if mode == "mem":
        held, peak = tracemalloc.get_traced_memory()
        print(f"held: {held / 2**20:.1f} MiB, peak: {peak / 2**20:.1f} MiB")
    else:
        print(f"{(time.perf_counter() - start) * 1000:.0f}")
    assert result is not None


if __name__ == "__main__":
    main()
```

变体的建立方法是复制 `ch06` 再改 `index.py`，这一步我手工做：

```bash
cp -r /tmp/p06/ch06 /tmp/p06/ch06fix
cp -r /tmp/p06/ch06fix /tmp/p06/ch06fix2
```

下面是 7 轮的全部结果（每行是一个变体的 7 次，毫秒，已排序）。每个变体都有一个明显偏高的值（`ch04` 的 1631，`ch05` 的 3096，`ch06` 的 2866），多半是头一轮，我没有剔除：

```text
$ for i in 1 2 3 4 5 6 7; do
  for c in ch04 ch05 ch06 ch06fix ch06fix2; do
    echo "$c $(at $c /tmp/p06/scratch/build_probe.py 2>/dev/null)"
  done
done | sort -k1,1 -k2,2n \
  | awk '{a[$1]=a[$1]" "$2} END{for(k in a)print k":"a[k]}' | sort
ch04: 752 754 782 786 795 814 1631
ch05: 1209 1225 1225 1250 1318 1368 3096
ch06: 1747 1758 1765 1801 1972 2069 2866
ch06fix: 1666 1679 1681 1729 1833 1881 1974
ch06fix2: 1577 1581 1667 1684 1722 1876 1908
```

最小值：`ch04` 752 ms，`ch05` 1209 ms，`ch06` 1747 ms。第 4 篇到第 5 篇慢了 1.61 倍（每个词元造一个 `Token`，上一篇已经讲过），第 5 篇到第 6 篇又慢了 1.44 倍，累计从 752 到 1747，2.32 倍。结果一样、功能更多，但这是真金白银的 1 秒。

时间去哪了。先怀疑这一章新写的 front matter 解析器。`/tmp/p06/scratch/stage_costs.py` 把读文件到变成 `Document` 的各步分开量：

```python
"""Time the stages that turn a file into a Document, best of 5."""

import time
from collections.abc import Callable
from pathlib import Path

from sift.corpus import iter_documents
from sift.document import parse_datetime
from sift.frontmatter import parse_front_matter
from sift.markdown import split_front_matter, strip_markdown

ROOT = Path("corpus/posts")
REPEAT = 5


def best_ms(fn: Callable[[], object]) -> float:
    """Return the fastest of REPEAT calls of fn, in milliseconds."""
    times = []
    for _ in range(REPEAT):
        start = time.perf_counter()
        fn()
        times.append(time.perf_counter() - start)
    return min(times) * 1000


def main() -> None:
    """Print the cost of each stage over the 123 posts."""
    texts = [p.read_text("utf-8") for p in sorted(ROOT.glob("*.md"))]
    splits = [split_front_matter(t) for t in texts]

    def front_matter() -> None:
        for front, _ in splits:
            meta = parse_front_matter(front)
            parse_datetime(str(meta["published"]))

    rows = [
        ("parse front matter + date", front_matter),
        ("strip_markdown", lambda: [strip_markdown(b) for _, b in splits]),
        ("iter_documents, all of it", lambda: list(iter_documents(ROOT))),
    ]
    for name, fn in rows:
        print(f"{name:28} {best_ms(fn):7.1f} ms")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p06/scratch/stage_costs.py
parse front matter + date        5.0 ms
strip_markdown                 178.9 ms
iter_documents, all of it      215.0 ms
```

解析 123 篇的 front matter 加日期一共 5.0 ms，占 1747 ms 的 0.3%，它不是嫌疑人。`strip_markdown` 的 178.9 ms 是大头，但它在第 4、5 篇里就有，不在这将近 600 ms 的增量里。

接下来用 `cProfile` 看整个 `search kalman`（cProfile 自己有开销，总时间会虚高，所以只看哪个函数的调用次数不对劲，不看绝对值）：

```text
$ python3 -m cProfile -s tottime -m sift search kalman 2>&1 | sed -n '10p;14,24p'
8 hits in 123 files: index built in 3853.0 ms, query took 0.139 ms

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
      123    0.865    0.007    3.416    0.028 index.py:146(add)
   812463    0.856    0.000    1.414    0.000 tokenize.py:38(iter_tokens)
   290820    0.311    0.000    0.446    0.000 index.py:46(__init__)
  1103179    0.299    0.000    0.299    0.000 {method 'setdefault' of 'dict' objects}
        1    0.182    0.182    4.035    4.035 __main__.py:98(main)
   363117    0.177    0.000    0.177    0.000 {method 'sub' of 're.Pattern' objects}
   812339    0.161    0.000    0.296    0.000 <string>:1(<lambda>)
   290820    0.147    0.000    0.184    0.000 index.py:53(append)
  1193911    0.136    0.000    0.136    0.000 {method 'append' of 'list' objects}
```

第一行是 `search` 自己打印的那一行（被 cProfile 拖慢到了 3853 ms），空行之后是表头，接着是按自身耗时排序的前 9 行。其中 `index.py:46(__init__)` 是 `PostingList.__init__`，被调用了 290820 次。这个数字不对：词表里只有 81192 个词，一共该造 81192 个 `PostingList`。多出来的 209628 个去哪了？看 `add` 的最后几行（`src/sift/index.py` 第 155 到 157 行）：

```python
        for term, found in positions.items():
            posting = Posting(doc.doc_id, tuple(found))
            self._postings.setdefault(term, PostingList()).append(posting)
```

Python 先求值参数再调用函数。`setdefault(term, PostingList())` 里的 `PostingList()` 在每一次调用时都会构造，不管 `term` 在不在字典里。结果是 290820 个 `Posting` 里的每一个，都白造一个 `PostingList`（构造器里还要 `sorted()` 一个空列表、造一个空集合），其中 209628 个造完就扔。（这一行的形状和第 5 篇 `build_index` 里的 `index.setdefault(term, {})` 一样；那里的 `{}` 便宜得不值得省，这里的 `PostingList()` 不是。`make ch06` 一路绿灯，这种错误不会让任何一个实验变红，它只会让你多等一会儿。）

变体 `ch06fix` 只改这一处：

```text
$ diff -U0 /tmp/p06/ch06/src/sift/index.py /tmp/p06/ch06fix/src/sift/index.py
--- /tmp/p06/ch06/src/sift/index.py	2026-10-21 15:05:08.000000000 -0700
+++ /tmp/p06/ch06fix/src/sift/index.py	2026-10-21 15:12:17.514636869 -0700
@@ -157 +157,4 @@
-            self._postings.setdefault(term, PostingList()).append(posting)
+            plist = self._postings.get(term)
+            if plist is None:
+                plist = self._postings[term] = PostingList()
+            plist.append(posting)
```

交替跑出来的 7 次，`ch06fix` 的最小值是 1666 ms，比 `ch06` 快 81 ms（中位数 1729 对 1801，快 72 ms）。

第二个嫌疑是垃圾回收。290820 个 `Posting`、同样多的元组和列表都是容器对象，我猜它们会让循环垃圾回收器忙起来。`build_probe.py` 加参数 `nogc` 就在启动时关掉它，`ch05` 和 `ch06` 开和关各跑 5 轮，也是轮流跑：

```text
$ for i in 1 2 3 4 5; do
  for c in ch05 ch06; do
    echo "$c gc-on $(at $c /tmp/p06/scratch/build_probe.py 2>/dev/null)"
    echo "$c gc-off $(at $c /tmp/p06/scratch/build_probe.py nogc 2>/dev/null)"
  done
done | sort -k1,1 -k2,2 -k3,3n \
  | awk '{k=$1" "$2; a[k]=a[k]" "$3} END{for(k in a)print k":"a[k]}' | sort
ch05 gc-off: 1262 1274 1355 1381 1449
ch05 gc-on: 1319 1323 1338 1504 1564
ch06 gc-off: 1707 1772 1779 1963 2871
ch06 gc-on: 1865 1955 1981 2066 2633
```

第 5 篇的 `load_index` 开不开 GC 几乎一样（中位数 1338 对 1355 ms），第 6 篇关掉之后从 1981 掉到 1779 ms，202 ms。这一项和上面的 `PostingList()` 有重叠（造出来再扔掉的对象本身也在喂 GC），所以不能直接把两个数相加。我没有去拆开重叠的部分。

第三个是 `frozen=True`。上一节量过：290820 个实例，frozen 比不 frozen 多约 59 ms。`ch06fix2` 在 `ch06fix` 的基础上把 `Posting` 的装饰器换成 `@dataclass(slots=True)`：

```text
$ diff -U0 /tmp/p06/ch06fix/src/sift/index.py /tmp/p06/ch06fix2/src/sift/index.py
--- /tmp/p06/ch06fix/src/sift/index.py	2026-10-21 15:12:17.514636869 -0700
+++ /tmp/p06/ch06fix2/src/sift/index.py	2026-10-21 15:13:47.455634282 -0700
@@ -14 +14 @@
-@dataclass(frozen=True, slots=True)
+@dataclass(slots=True)
```

第四个是位置的收集方式。第 5 篇 `build_index` 用 `Counter(tokens)`，它的计数循环在 C 里；这一章对每个词元做 `positions.setdefault(token.text, []).append(token.position)`，是 Python 层的循环。`/tmp/p06/scratch/positions_vs_counter.py` 在同一批词元上只比较这两个循环：

```python
"""Counting terms (ch05) vs collecting positions (ch06)."""

import time
from collections import Counter
from collections.abc import Callable
from pathlib import Path

from sift.analysis.tokenize import Token, iter_tokens
from sift.corpus import iter_documents

ROOT = Path("corpus/posts")
REPEAT = 5


def best_ms(fn: Callable[[], object]) -> float:
    """Return the fastest of REPEAT calls of fn, in milliseconds."""
    times = []
    for _ in range(REPEAT):
        start = time.perf_counter()
        fn()
        times.append(time.perf_counter() - start)
    return min(times) * 1000


def count_terms(streams: list[list[Token]]) -> None:
    """Count term frequencies, as build_index did at ch05."""
    for tokens in streams:
        Counter(token.text for token in tokens)


def collect_positions(streams: list[list[Token]]) -> None:
    """Collect positions per term, as InvertedIndex.add does."""
    for tokens in streams:
        positions: dict[str, list[int]] = {}
        for token in tokens:
            positions.setdefault(token.text, []).append(token.position)


def main() -> None:
    """Tokenize once, then time the two bookkeeping loops."""
    streams = [list(iter_tokens(d.body)) for d in iter_documents(ROOT)]
    print("tokens:", sum(map(len, streams)))
    print(f"Counter:    {best_ms(lambda: count_terms(streams)):7.1f} ms")
    print(f"positions:  {best_ms(lambda: collect_positions(streams)):7.1f} ms")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p06/scratch/positions_vs_counter.py
tokens: 812338
Counter:       75.4 ms
positions:    126.3 ms
```

多 50.9 ms。

把能量出来的项目放在一起：

- 白造的 `PostingList()`：约 72 到 81 ms（`ch06` 对 `ch06fix`，中位数和最小值之差）。
- `frozen=True`：约 45 到 89 ms（`ch06fix` 对 `ch06fix2`，最小值 1666 对 1577，中位数 1729 对 1684），微基准是 59 ms。
- 位置收集的 Python 循环：约 51 ms（微基准）。
- front matter 解析：5.0 ms。
- 垃圾回收：约 202 ms，和前面几项有重叠。

`ch05` 到 `ch06` 一共慢了 538 ms（最小值之差）。上面几项里不重叠的（白造的 `PostingList()`、`frozen=True`、位置循环、front matter）加起来大约 170 到 230 ms。剩下 300 多毫秒我没有逐项量出来：上面的 profile 里，`add` 自己的循环 (0.865 s) 和 `iter_tokens`(0.856 s) 最靠前，再往后是白造的 `PostingList.__init__`、110 万次 `setdefault` 和 29 万次 `PostingList.append`；但 cProfile 的数字被它自己的开销放大了，所以我没有把这几项拆开去量。这个近 2 秒的建索引过程也不会一直存在：第 12 篇要把整个索引存到磁盘上，到那时每次搜索不用再重建，建索引只在显式的 `sift index` 里发生一次。

内存也涨了。`build_probe.py` 加参数 `mem` 就用 `tracemalloc` 数 `load_index` 返回的东西：

```text
$ for c in ch05 ch06; do
  echo "$c $(at $c /tmp/p06/scratch/build_probe.py mem 2>/dev/null)"
done
ch05 held: 28.8 MiB, peak: 28.9 MiB
ch06 held: 84.5 MiB, peak: 84.6 MiB
```

28.8 MiB 涨到 84.5 MiB，2.9 倍。多出来的 56 MiB 是什么，用 `sys.getsizeof` 加一遍（`PostingList` 的 inline values 它不算，所以这个和不会正好等于 84.5）：

```python
"""Where the memory of the ch06 index goes, by sys.getsizeof."""

import sys

from sift.__main__ import CORPUS, load_index


def mib(n: int) -> str:
    """Format a byte count as MiB."""
    return f"{n / 2**20:6.1f} MiB"


def main() -> None:
    """Add up the pieces of (documents, index)."""
    documents, index = load_index(CORPUS)
    lists = [index[term] for term in index]
    postings = [p for plist in lists for p in plist]
    ints = {id(i): sys.getsizeof(i) for p in postings for i in p.positions}
    rows = [
        ("document bodies", sum(sys.getsizeof(d.body) for d in documents)),
        ("term strings", sum(sys.getsizeof(t) for t in index)),
        (
            "PostingList._postings lists",
            sum(sys.getsizeof(pl._postings) for pl in lists),
        ),
        ("Posting objects", sum(sys.getsizeof(p) for p in postings)),
        (
            "positions tuples",
            sum(sys.getsizeof(p.positions) for p in postings),
        ),
        ("position ints (distinct)", sum(ints.values())),
    ]
    print(
        f"{len(lists)} posting lists, {len(postings)} postings, "
        f"{len(ints)} distinct int objects"
    )
    for name, size in rows:
        print(f"{name:30} {mib(size)}")
    print(f"{'sum':30} {mib(sum(size for _, size in rows))}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p06/scratch/index_breakdown.py 2>/dev/null
81192 posting lists, 290820 postings, 780984 distinct int objects
document bodies                   6.0 MiB
term strings                      4.6 MiB
PostingList._postings lists       8.2 MiB
Posting objects                  13.3 MiB
positions tuples                 19.5 MiB
position ints (distinct)         20.9 MiB
sum                              72.5 MiB
```

最大的两项是位置：780984 个不同的 `int` 对象（位置大于 256 的整数每个都是单独的对象）占 20.9 MiB，装着它们的元组 19.5 MiB。后者的原因是元组存的是指向 `int` 的指针，不是整数本身。加起来 72.5 MiB，剩下的 12 MiB 是我没有加进去的 81192 个 `PostingList` 对象、词表字典和 `Document` 对象。（`Posting` 对象本身 13.3 MiB，正好是 290820 个 48 字节；这是 `__slots__` 省下来的那一部分。）

位置大概是为短语查询准备的（我猜第 8 篇才会用到），现在的 `search` 完全用不上，所以 84.5 MiB 里大约一半在为一个还没有出现的功能付钱。第 6 篇给了倒排表更好的接口，代价是更慢更胖，而且现在换不来更快的搜索。

## 跑一遍

整章一个 `make` 目标，再加 `make lint`：

```text
$ make ch06
python3 scripts/chapter.py ch06
ok   lab/ch06/class_basics.py
ok   lab/ch06/class_static_methods.py
ok   lab/ch06/containers_protocol.py
ok   lab/ch06/dataclasses_tour.py
ok   lab/ch06/datetimes.py
ok   lab/ch06/enums.py
ok   lab/ch06/eq_hash.py
ok   lab/ch06/frontmatter_corpus.py
ok   lab/ch06/frozen_fail.py
ok   lab/ch06/init_vs_new.py
ok   lab/ch06/name_mangling.py
ok   lab/ch06/operators.py
ok   lab/ch06/properties.py
ok   lab/ch06/repr_str_format.py
ok   lab/ch06/slots_attr_fail.py
ok   lab/ch06/slots_memory.py
ok   lab/ch06/total_ordering.py
ok   lab/ch06/unhashable_eq_fail.py
```

```text
$ make lint
ruff format --check --line-length 79 .
90 files already formatted
ruff check .
All checks passed!
```

`unhashable_eq_fail.py`、`slots_attr_fail.py` 和 `frozen_fail.py` 也显示 `ok`，因为运行器知道 `_fail.py` 结尾的文件应该非零退出。

## 本篇文件

这一章改过的 `src/sift` 文件和 `lab` 文件：

```text
$ git diff --stat ch05 ch06 -- src lab/ch04 lab/ch05 | cat
 lab/ch04/tfidf_vs_tf.py    |   8 +-
 lab/ch05/genexp_vs_list.py |   3 +-
 src/sift/__main__.py       |  74 +++++++++---------
 src/sift/corpus.py         |  26 +++----
 src/sift/document.py       |  83 +++++++++++++++++++++
 src/sift/frontmatter.py    | 138 ++++++++++++++++++++++++++++++++++
 src/sift/index.py          | 182 +++++++++++++++++++++++++++++++++++++++++----
 7 files changed, 439 insertions(+), 75 deletions(-)
```

[`lab/ch06`](https://github.com/bfmhno3/sift/tree/ch06/lab/ch06) 下的 18 个文件，加上这一章改过或新增的五个 `src/sift` 文件，和两个改成新接口的旧实验。结果列是我在本篇的环境里重新跑出来的。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`src/sift/document.py`](https://github.com/bfmhno3/sift/blob/ch06/src/sift/document.py) | `python3 -c 'from sift.document import parse_datetime; print(parse_datetime("2026-09-01"))'` | 退出码 0，输出 `2026-09-01 00:00:00+08:00`；83 行 |
| [`src/sift/frontmatter.py`](https://github.com/bfmhno3/sift/blob/ch06/src/sift/frontmatter.py) | `python3 -c 'from sift.frontmatter import parse_front_matter; print(parse_front_matter("title: a\ntags: [x, y]"))'` | 退出码 0，输出 `{'title': 'a', 'tags': ['x', 'y']}`；138 行 |
| [`src/sift/index.py`](https://github.com/bfmhno3/sift/blob/ch06/src/sift/index.py) | `python3 -c 'from sift.index import Posting, PostingList; print(PostingList([Posting(1, (0,))]) & PostingList([Posting(1, (3,))]))'` | 退出码 0，输出 `PostingList([Posting(doc_id=1, positions=(0, 3))])`；173 行 |
| [`src/sift/corpus.py`](https://github.com/bfmhno3/sift/blob/ch06/src/sift/corpus.py) | `python3 -c 'from pathlib import Path; from sift.corpus import iter_documents; d = next(iter_documents(Path("corpus/posts"))); print(d.doc_id, d.title)'` | 退出码 0，输出 `0 ARMv7-A 指令体系全解：数据处理、访存、分支与同步`；19 行 |
| [`src/sift/__main__.py`](https://github.com/bfmhno3/sift/blob/ch06/src/sift/__main__.py) | `python3 -m sift search kalman` | 退出码 0，stdout 第一行 `  19.570  corpus/posts/kalman-filter-02-multivariate.md`，stderr 一行 `load_index took ... ms`；110 行 |
| [`lab/ch06/class_basics.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/class_basics.py) | `python3 lab/ch06/class_basics.py` | 退出码 0，第一行 `a.__dict__: {'term': 'rust', 'count': 2}` |
| [`lab/ch06/init_vs_new.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/init_vs_new.py) | `python3 lab/ch06/init_vs_new.py` | 退出码 0，第一行 `__new__(Loud, 'x')` |
| [`lab/ch06/repr_str_format.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/repr_str_format.py) | `python3 lab/ch06/repr_str_format.py` | 退出码 0，第一行 `print(hit):      doc 7 (3.14)` |
| [`lab/ch06/eq_hash.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/eq_hash.py) | `python3 lab/ch06/eq_hash.py` | 退出码 0，第一行 `Plain(1) == Plain(1): False` |
| [`lab/ch06/unhashable_eq_fail.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/unhashable_eq_fail.py) | `python3 lab/ch06/unhashable_eq_fail.py` | 退出码 1：`TypeError: cannot use 'Doc' as a set element (unhashable type: 'Doc')` |
| [`lab/ch06/total_ordering.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/total_ordering.py) | `python3 lab/ch06/total_ordering.py` | 退出码 0，第一行 `Manual < : True` |
| [`lab/ch06/operators.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/operators.py) | `python3 lab/ch06/operators.py` | 退出码 0，第一行 `rust: [1, 3, 5, 8]` |
| [`lab/ch06/containers_protocol.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/containers_protocol.py) | `python3 lab/ch06/containers_protocol.py` | 退出码 0，第一行 `len: 3` |
| [`lab/ch06/properties.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/properties.py) | `python3 lab/ch06/properties.py` | 退出码 0，第一行 `text: 'rust ownership'` |
| [`lab/ch06/class_static_methods.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/class_static_methods.py) | `python3 lab/ch06/class_static_methods.py` | 退出码 0，第一行 `Version.parse('3.14'): Version(3, 14)` |
| [`lab/ch06/name_mangling.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/name_mangling.py) | `python3 lab/ch06/name_mangling.py` | 退出码 0，第一行 `vars(Base()): {'public': 1, '_internal': 2, '_Base__secret': 3}` |
| [`lab/ch06/slots_attr_fail.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/slots_attr_fail.py) | `python3 lab/ch06/slots_attr_fail.py` | 退出码 1：先打印 `slots: ('x', 'y') has __dict__: False`，随后 `AttributeError: 'Point' object has no attribute 'z' and no __dict__ for setting new attributes` |
| [`lab/ch06/slots_memory.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/slots_memory.py) | `python3 lab/ch06/slots_memory.py` | 退出码 0，第一行 `has __dict__: True False`（`tracemalloc` 的 KiB 数每次差几 KiB） |
| [`lab/ch06/dataclasses_tour.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/dataclasses_tour.py) | `python3 lab/ch06/dataclasses_tour.py` | 退出码 0，第一行 `separate lists: ['x'] []` |
| [`lab/ch06/frozen_fail.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/frozen_fail.py) | `python3 lab/ch06/frozen_fail.py` | 退出码 1：先打印 `before: Posting(doc_id=1, positions=(0, 3))`，随后 `dataclasses.FrozenInstanceError: cannot assign to field 'doc_id'` |
| [`lab/ch06/enums.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/enums.py) | `python3 lab/ch06/enums.py` | 退出码 0，第一行 `Kind.WORD: Kind.WORD <Kind.WORD: 1>` |
| [`lab/ch06/datetimes.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/datetimes.py) | `python3 lab/ch06/datetimes.py` | 退出码 0，第一行 `tz: Asia/Shanghai key: Asia/Shanghai` |
| [`lab/ch06/frontmatter_corpus.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch06/frontmatter_corpus.py) | `python3 lab/ch06/frontmatter_corpus.py` | 退出码 0，第一行 `front matter parsed: 123` |
| [`lab/ch04/tfidf_vs_tf.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch04/tfidf_vs_tf.py) | `python3 lab/ch04/tfidf_vs_tf.py` | 退出码 0，stderr 一行 `load_index took ... ms`，stdout 第一行 `query: 'linux device': 6 hits` |
| [`lab/ch05/genexp_vs_list.py`](https://github.com/bfmhno3/sift/blob/ch06/lab/ch05/genexp_vs_list.py) | `python3 lab/ch05/genexp_vs_list.py` | 退出码 0，第一行 `tokens via list:   812338`（峰值和计时每次略有不同） |

## 练习

**1.** `PostingList` 的 `__getitem__` 按位置取，`__contains__` 按 `doc_id` 问，两者不一致。先决定哪一边该变：让 `Posting(5, (1, 3)) in pl` 也能工作（比较的是整个 `Posting`），还是把 `__contains__` 的参数明确成 `doc_id`，把“按 `doc_id` 问”挪到另一个名字（比如 `has_doc(doc_id)`）。改完后 `__sub__` 要不要跟着改？用上面那段 `python3 -c` 验证。

**2.** 把 `InvertedIndex.add` 里的那一行 `setdefault(term, PostingList())` 改成不白造对象，量改动前后的 `load_index`，用本篇的办法（轮流各跑 7 个新进程，看最小值和中位数）。然后做更大的改动：把每个 `Posting` 的 `positions` 从元组换成 `array.array("I", found)`，再量一次时间和 `build_probe.py mem` 报告的内存。想一想：哪一个数字变好了，哪一个变坏了，为什么？

**3.** 给 `lab/ch06/operators.py` 里的 `Money` 加 `__mul__` 和 `__rmul__`，使 `Money(5) * 3` 和 `3 * Money(5)` 都返回 `Money(15)`，而 `Money(5) * Money(5)` 抛 `TypeError`。注意：你的 `__mul__` 对不认识的类型应该怎么返回，才能让 Python 去试 `__rmul__`？

**4.** 预测下面三个类的 `hash(X(1))` 和 `{X(1), X(1)}` 各是什么，再运行验证；用 `__hash__ is None` 和上面 `P.__hash__` 那段的办法解释：

```python
from dataclasses import dataclass


@dataclass
class A:
    x: int


@dataclass(eq=False)
class B:
    x: int


@dataclass(unsafe_hash=True)
class C:
    x: int
```

## 下一篇

下一篇是《继承、ABC 与 Protocol：分析器插件》。现在 `InvertedIndex` 手写了 `__getitem__`、`__contains__`、`__len__` 和 `__iter__` 四个方法，每一个都只是把调用转给内部字典；我猜让它继承 `collections.abc.Mapping`，只留 `__getitem__`、`__iter__` 和 `__len__` 三个抽象方法，`keys`、`items`、`get` 和 `__eq__` 就会免费送上门。同样的思路也适合分词器：它现在是一个固定的函数，换一种分析方式要改源码，我想看看把它做成可替换的类，需要 ABC 还是 `Protocol`，MRO 又会在哪里出来咬我一口。
