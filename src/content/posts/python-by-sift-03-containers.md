---
title: "容器：list、dict、set 的实现与代价"
commentId: "post:python-by-sift-03-containers"
published: "2026-10-22 03:00:00 +08:00"
description: "用 Sift 重学 Python 第 3 篇：我在 Python 3.14.7 里把分词结果存进字典套字典的倒排索引，81,192 个词、290,820 条倒排记录占 24.1 MiB，一次查询 0.076 ms，可是每次运行都要先花 721.4 ms 重建索引；我把 list、dict、set 的实现和代价一项一项量了出来。"
category: Tutorial
tags:
  - Python
  - Sift
  - 数据结构
  - collections
  - 哈希表
series: "用 Sift 重学 Python"
seriesOrder: 3
draft: false
comment: true
slug: python-by-sift-03-containers
---

上一篇结尾我下了一个注：分词只要在建索引时做一次，那 575.7 ms 应该能降到比第 1 篇的 17.4 ms 还低。这一篇我把词元存进了字典，一次查询确实只要 0.076 ms，可是整条命令的耗时一点都没有降：

```text
$ python3 -m sift search kalman
     7  corpus/posts/kalman-filter-02-multivariate.md
     6  corpus/posts/kalman-filter-01-one-dimension.md
     6  corpus/posts/kalman-filter-07-ukf.md
     5  corpus/posts/kalman-filter-06-eskf.md
     5  corpus/posts/kalman-filter-08-porting.md
     1  corpus/posts/pid-control-09-lqr.md
     1  corpus/posts/pid-control-10-embedded.md
     1  corpus/posts/typst-by-xuan-15-wasm-plugin.md
8 hits in 123 files: index built in 721.4 ms, query took 0.076 ms
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch03`：新增 `src/sift/index.py`（倒排索引第一版，字典套字典，第 6 篇会换成带位置信息的 `Posting`），`src/sift/__main__.py` 改成 `search` 和 `stats` 两个子命令（到第 11 篇之前每章还会再改）；`lab/ch01/extra.sh` 里的命令随之改成 `search kalman`。`make ch03` 通过，`lab/ch03` 下 12 个文件（11 个 Python 实验加一个 `extra.sh`）按预期退出。
> 涉及的 Python 特性：`list` 的动态数组实现与过度分配、`deque`、`tuple` 与 `array`、`dict` 的紧凑哈希表（开放寻址、插入顺序）、`hash`/`==` 契约与 `PYTHONHASHSEED`、`set` 与 `frozenset`、别名与浅拷贝深拷贝、推导式及其作用域、解包与切片赋值、`sorted` 与 Timsort、`collections` 一圈、`array` 模块。
> 前置：[第 2 篇](/posts/python-by-sift-02-text-and-unicode/)，需要会进 `nix develop`、知道 `tokenize` 返回词元列表。

命中和上一篇一字不差，多的只是最后一行账单：建索引 721.4 ms，查询 0.076 ms，差了大约 9,500 倍。每次运行都把索引从头建一遍，查一次，然后扔掉，这是故意的朴素写法，第 12 篇才会把它存到磁盘上。这一篇要弄清楚的是这两个数分别是 list、dict、set 的哪些性质换来的。

## 环境

和前两篇一样的机器，仓库在标签 `ch03`：

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ git describe --tags
ch03
```

CPU 是 AMD Ryzen 7 PRO 6850U，内存 30 GiB。计时用 `timeit`（取 5 次里的最小值）、`time.perf_counter` 和 `hyperfine` 1.20.0。这台机器上的计时抖动不小，同一段代码前后两次跑差一倍的情况我见过，所以凡是表格里的数字，我只信它的数量级和形状，不信个位数。

两件事先交代。第一，第 1、2 篇的 `python3 -m sift kalman` 这种写法在 `ch03` 里没有了，现在必须写 `search` 或 `stats`，旧写法只会得到一行用法说明；那两篇里的命令在各自的标签 `ch01`、`ch02` 里照常可以跑：

```text
$ python3 -m sift kalman; echo "exit $?"
usage: python -m sift search <word>... | python -m sift stats
exit 1
```

第二，`nix develop` 的环境里有一行 `PYTHONHASHSEED=0`，是 `flake.nix` 导出的，实验运行器也会设成 `0`。后面讲哈希时你会看到它为什么要紧：

```text
$ echo $PYTHONHASHSEED
0
```

一次性的小脚本我放在 `/tmp/scratch/final/`，不进仓库。正文里的脚本除了下面几个节选之外都是完整源码，照抄就能复现；节选的是 `formula.py`（只贴了 `grow`）、`bad_hash.py`（只贴了 `Bad` 和 `fill`）、`eq_calls.py`（只贴了 `Bad` 类）、`setdefault_vs_dd.py`（只贴了 `with_defaultdict`）和 `stage_min.py`（只贴了计时循环的开头），每处都标了 `# ...` 或在正文里说明。CPython 的源码引用来自 `v3.14.0` 标签（我跑的是 3.14.7，两者的差别我没有逐行比过，所以下面凡是讲行为的地方，我都用输出验证了，不只靠读源码）。

## 倒排索引：字典套字典

上一篇结尾的搜索是“对每个文档数一遍查询词”，查询时间正比于语料大小。倒排索引反过来：先建一张从词到文档的表，查询时直接查表。`src/sift/index.py` 一共 12 行：

```python
"""Inverted index, version 1: plain dicts of dicts."""

from collections import Counter


def build_index(docs: dict[int, list[str]]) -> dict[str, dict[int, int]]:
    """Return term -> {doc_id: term frequency} for tokenized documents."""
    index: dict[str, dict[int, int]] = {}
    for doc_id, tokens in docs.items():
        for term, tf in Counter(tokens).items():
            index.setdefault(term, {})[doc_id] = tf
    return index
```

输入是 `{doc_id: 词元列表}`，输出是 `{词: {doc_id: 出现次数}}`，里层的字典叫倒排记录（posting）。拿三个小文档试一下（脚本只有几行，`PYTHONPATH` 已经指向 `src`）：

```python
from sift.index import build_index

docs = {0: ["tea", "tea", "brew"], 1: ["tea", "rust"], 2: ["rust", "rust"]}
index = build_index(docs)
print(index)
print(index["tea"].keys() & index["rust"].keys())
```

```text
$ python3 /tmp/scratch/final/toy_index.py
{'tea': {0: 2, 1: 1}, 'brew': {0: 1}, 'rust': {1: 1, 2: 2}}
{1}
```

“同时含有 `tea` 和 `rust` 的文档”就是两个字典的键取交集，答案是文档 1。整个搜索引擎的核心算法就这一行，剩下的都是让它更快、更准、更方便。

接下来的内容按这张图里用到的容器展开：`list` 装词元，`dict` 装索引，`set` 做交集，`Counter` 做统计，`sorted` 排名。每一节我先讲 CPython 里它是怎么放在内存里的，再用实验量出代价，最后回到 Sift 里看它在哪里付账。

## list：一排指针

### 过度分配

`list` 在 CPython 里是一个动态数组，数组里装的是对象的指针，不是对象本身。`append` 要是每次都申请“刚好够用”的内存，`n` 次追加就要搬 $O(n^2)$ 个指针；CPython 的做法是多要一点。看 `lab/ch03/list_growth.py` 的前半部分：

```python
def growth_steps(n: int) -> list[tuple[int, int]]:
    """Return (length, bytes) each time append grows the buffer."""
    items: list[int] = []
    steps = [(0, sys.getsizeof(items))]
    for i in range(n):
        items.append(i)
        size = sys.getsizeof(items)
        if size != steps[-1][1]:
            steps.append((len(items), size))
    return steps
```

它追加 1000 个元素，每当 `sys.getsizeof` 变了就记一笔：

```text
$ python3 lab/ch03/list_growth.py
  len   bytes  slots
    0      56      0
    1      88      4
    5     120      8
    9     184     16
   17     248     24
   25     312     32
   33     376     40
   41     472     52
   53     568     64
   65     664     76
...
lengths at each resize: [1, 5, 9, 17, 25, 33, 41, 53, 65, 77, 93, 109, 129,
    149, 173, 201, 233, 269, 309, 353, 401, 457, 521, 593, 673, 761, 861,
    973]
```

（中间 19 行我省掉了，`...` 是我加的；最后一行原本是一整行，为了不横向滚动我在 79 列处手动折成了三行；`slots` 一列是 `(bytes - 56) / 8`，也就是已分配的指针槽数。）1000 次追加，只重新分配了 28 次。第一次追加就一口气要了 4 个槽，之后是 8、16、24、32、40、52……每次多出来的比例大约是当前长度的八分之一。`listobject.c` 里这一行就是全部的秘密：

```c
    new_allocated = ((size_t)newsize + (newsize >> 3) + 6) & ~(size_t)3;
```

新长度加上它的 $1/8$，再加 6，然后向下对齐到 4 的倍数。我不想只相信这行 C 代码，于是把它翻成 Python，用公式预测什么时候重新分配，再和上面实测的列表比较：

```python
def grow(newsize: int) -> int:
    return (newsize + (newsize >> 3) + 6) & ~3
```

```text
$ python3 /tmp/scratch/final/formula.py
True 28
(4, 8, 16, 24, 32)
```

（脚本余下的部分在每次 `append` 时用 `grow` 预测，再和 `sys.getsizeof` 的实测比较；`True 28` 是“28 个重新分配点全部吻合”。第二行是 `grow(1)`、`grow(5)`、`grow(9)`、`grow(17)`、`grow(25)`，正好是实测的 4、8、16、24、32。）

增长系数大约是 1.125，比 2 保守得多。Rust 的 `Vec` 就是翻倍的：我拿 `rustc 1.97.1 -O` 把一个 `Vec<u64>` 推 1000 个元素，每次容量变化记下来：

```rust
fn main() {
    let mut v: Vec<u64> = Vec::new();
    let mut last = v.capacity();
    let mut caps = vec![last];
    for i in 0..1000 {
        v.push(i);
        if v.capacity() != last {
            last = v.capacity();
            caps.push(last);
        }
    }
    println!("{:?}", caps);
}
```

```text
$ rustc -O -o /tmp/scratch/final/vec_growth /tmp/scratch/final/vec_growth.rs
$ /tmp/scratch/final/vec_growth
[0, 4, 8, 16, 32, 64, 128, 256, 512, 1024]
```

翻倍的好处是重新分配次数少（容量列表里除去开头的 0 是 9 次，CPython 是 28 次），代价是最坏时浪费一半内存；CPython 选了更省内存的一边，原因我只能猜：`list` 在 Python 程序里到处都是，大多数很短。几何级数增长保证了均摊 $O(1)$：不管系数是 1.125 还是 2，总搬运量都是 $n$ 的常数倍。

`list` 对象自己占 56 字节（`sys.getsizeof([])` 就是 56），每个槽 8 字节。`tuple` 不需要过度分配，元素就内联在对象后面：

```text
$ python3 lab/ch03/tuple_vs_list.py | sed -n 1,4p
n= 0: tuple  48 B, list  56 B
n= 1: tuple  56 B, list  72 B
n= 4: tuple  80 B, list  88 B
n=10: tuple 128 B, list 136 B
```

`tuple` 是 $48 + 8n$。`list` 在 `n` 为 0、4、10 的三行上是 $56 + 8n$，每一行都比 `tuple` 多 8 字节。两种对象的头部布局不同，我没有逐个字段核对，所以不在这里解释这 8 字节。`n=1` 那一行的 `list` 是 72 字节，比这个公式多 8，我也没有追究原因。

### 指针数组的代价：对象不在数组里

`list` 存的是指针，所以 100,000 个整数的 `list` 要付两份钱：一份给指针数组，一份给每个 `int` 对象。`list_growth.py` 的后半部分拿 `array` 模块对比，`array('i')` 把整数按 4 字节 C `int` 紧凑存放：

```python
    n = 100_000
    as_list = list(range(n))
    as_array = array("i", range(n))
    list_total = sys.getsizeof(as_list) + sum(map(sys.getsizeof, as_list))
    print(f"list of {n} ints: {list_total} bytes (pointers + int objects)")
    print(f"array('i') of {n}: {sys.getsizeof(as_array)} bytes")
    print(f"ratio: {list_total / sys.getsizeof(as_array):.1f}x")
```

```text
$ python3 lab/ch03/list_growth.py | tail -3
list of 100000 ints: 3600056 bytes (pointers + int objects)
array('i') of 100000: 408360 bytes
ratio: 8.8x
```

8.8 倍。（`sum(map(sys.getsizeof, as_list))` 把 -5 到 256 的小整数也按一个对象一个对象地算了，而它们其实是共享的单例，所以 `list` 一侧高估了不到 0.2%，不影响数量级。）代价是 `array` 只能装同一种 C 数值类型，取出来的时候每次都要新建一个 `int` 对象。这个差别在后面的数值计算章节会变成真正的论据，现在只记住一件事：`list` 的元素访问是一次指针解引用，而不是一次内存读取。

### 前面插入，和 deque

`list` 末尾追加是 $O(1)$，头部插入是 $O(n)$，因为所有指针都得往后挪一格。`collections.deque` 是分块的双向链表，每块 64 个槽（`_collectionsmodule.c` 里的 `#define BLOCKLEN 64`），两头进出都是 $O(1)$。`list_ops_cost.py` 把三者放一起量：

```python
def per_op_ns(stmt: str, setup: str, number: int) -> float:
    """Return the best-of-5 nanoseconds per execution of stmt."""
    runs = timeit.repeat(stmt, setup, repeat=5, number=number)
    return min(runs) / number * 1e9
```

```python
        append = per_op_ns("xs.append(0); xs.pop()", setup, 2000)
        insert = per_op_ns("xs.insert(0, 0); xs.pop(0)", setup, 200)
        left = per_op_ns("dq.appendleft(0); dq.popleft()", setup, 2000)
```

测的是“放进去再拿出来”这一对操作，这样容器长度不变：

```text
$ python3 lab/ch03/list_ops_cost.py | sed -n 1,5p
push 1 item, container already holds n items (ns per op)
        n    append  insert(0)  appendleft
     1000        95        877          93
    10000        97       8540          92
   100000       141      96689          92
```

`insert(0)` 每多 10 倍的元素就慢 10 倍：877、8,540、96,689 ns，十万个元素时比 `append` 慢 686 倍，比 `appendleft` 慢 1,000 倍以上。`append` 和 `appendleft` 基本不随规模变化（十万那一行的 141 ns 我猜是缓存放不下了，没有验证）。绝对值我信不过：写这一节时我把同一个脚本又跑了一遍，`append` 掉到 29 到 54 ns，`insert(0)` 十万行掉到 31,026 ns，整体快了 3 倍左右，但十万个元素时 `insert(0)` 对 `append` 仍然是几百倍。能信的是量级和倍数。

`deque` 不是白给的。它在中间的随机访问是 $O(n)$：

```python
import timeit

setup = (
    "from collections import deque; xs = list(range(100_000)); dq = deque(xs)"
)
for stmt in ("xs[50_000]", "dq[50_000]", "xs[0]", "dq[0]"):
    t = min(timeit.repeat(stmt, setup, number=2000, repeat=5)) / 2000
    print(f"{stmt:<12}{t * 1e9:9.0f} ns")
```

```text
$ python3 /tmp/scratch/final/deque_mid.py
xs[50_000]         13 ns
dq[50_000]        761 ns
xs[0]              14 ns
dq[0]              24 ns
```

十万个元素的正中间，`list` 13 ns，`deque` 761 ns，大约 58 倍。（`deque` 要从某一头沿着块链走过去；两头附近的访问都很快，`dq[0]` 只要 24 ns。）所以队列、滑动窗口用 `deque`，需要下标访问就用 `list`，这不是风格问题，是一个能量出来的数。

### `in` 的代价

最后一个 `list` 的实验是整篇最值钱的一个。`x in xs` 对 `list` 是从头一个一个比较，对 `set` 是算哈希再查表：

```python
    for n in (10**3, 10**4, 10**5, 10**6):
        setup = f"xs = list(range({n})); ss = set(xs); x = -1"
        number = max(1, 2_000_000 // n)
        in_list = per_op_ns("x in xs", setup, number)
        in_set = per_op_ns("x in ss", setup, 100_000)
```

探测的值 `-1` 不在容器里，这是 `list` 的最坏情况（要扫完整个列表才能说“没有”）：

```text
$ python3 lab/ch03/list_ops_cost.py | sed -n 7,12p
x in container, x absent (ns per op)
        n         list       set    speedup
     1000        22196        59       374x
    10000       224650        59      3782x
   100000      2218716        60     37242x
  1000000     22227629        51    438404x
```

列表那一列每多 10 倍的规模就慢 10 倍，一百万个元素里找一个不存在的数要 22 ms；`set` 那一列纹丝不动，51 到 60 ns。十万个元素时，`set` 快 37,242 倍。这就是下一节的问题：为什么哈希表的查找和规模无关？

## dict：紧凑的哈希表

### 布局

先说比喻，只用这一次。哈希表像小区门口的快递柜：快递员（哈希函数）根据收件人的信息直接算出柜号，柜子里有东西，就核对取件码（`==`）；柜子被别人占了，就按一条固定的规则找下一个柜子。查找不用把所有柜子翻一遍，用的是同一套算柜号的规则。

CPython 的 `dict` 不是把键值对直接放在柜子里，而是分成两块。`Objects/dictobject.c` 文件开头的大段注释画得很清楚（节选，原样引用）：

```text
+---------------------+
| dk_refcnt           |
| dk_log2_size        |
| dk_log2_index_bytes |
| dk_kind             |
| dk_version          |
| dk_usable           |
| dk_nentries         |
+---------------------+
| dk_indices[]        |
|                     |
+---------------------+
| dk_entries[]        |
|                     |
+---------------------+
```

`dk_indices` 才是真正的哈希表：一个很小的整数数组，每个槽里存的是“键值对在 `dk_entries` 里的下标”，或者表示空的 `-1`，表示已删除的 `-2`。`dk_entries` 是一个紧挨着排列的数组，按插入顺序存 `(hash, key, value)`。槽的类型随表的大小变：不超过 128 个槽用 `int8`，到 256 个槽用 `int16`，再往上是 `int32`、`int64`。

这个设计有两个后果。第一，哈希表本身极小（8 个槽只要 8 字节），稀疏的部分是便宜的索引，贵的条目是紧凑排列的。第二，**插入顺序是白送的**：条目数组只追加，遍历一个 `dict` 就是顺着条目数组走。`dict_order_and_hash.py` 的头几行验证这一点，还加了删除再重新插入：

```python
    d = {"b": 1, "a": 2}
    d["c"] = 3
    del d["b"]
    d["b"] = 4
    print("insertion order:", list(d))
    print("equal dicts, other order:", {"x": 1, "y": 2} == {"y": 2, "x": 1})
```

```text
$ python3 lab/ch03/dict_order_and_hash.py | sed -n 1,4p
PYTHONHASHSEED = 0
insertion order: ['a', 'c', 'b']
equal dicts, other order: True
set order of small ints: [8, 1, 3, 5]
```

删掉 `b` 再插入 `b`，`b` 排到了最后：旧条目被标成已删除，新条目追加在末尾。（顺序从 3.7 起是语言保证，不是 CPython 的实现细节。）但比较两个字典是否相等，顺序不算，所以 `{"x": 1, "y": 2} == {"y": 2, "x": 1}` 是 `True`；`OrderedDict` 的 `==` 才在乎顺序。

### 什么时候扩容

条目数组的长度是 `USABLE_FRACTION(n) = (n << 1) / 3`，也就是槽数的三分之二；插满了就要扩容，新的槽数是“已用条目数乘 3”向上取到 2 的幂（`dictobject.c` 里的 `GROWTH_RATE(d) ((d)->ma_used*3)`）。我用一个小脚本看 `getsizeof` 在哪几个长度上跳变：

```python
import sys

d: dict[str, int] = {}
print(f"{'len':>4} {'bytes':>6}")
print(f"{0:>4} {sys.getsizeof(d):>6}")
last = sys.getsizeof(d)
for i in range(100):
    d[f"k{i}"] = i
    size = sys.getsizeof(d)
    if size != last:
        print(f"{len(d):>4} {size:>6}")
        last = size
```

```text
$ python3 /tmp/scratch/final/dict_resize.py
 len  bytes
   0     64
   1    184
   6    272
  11    464
  22    832
  43   1584
  86   3328
```

空字典 64 字节；第一次插入分配 8 个槽的表（184 字节）；之后在第 6、11、22、43、86 个元素处扩容。拿公式验算：8 个槽可用 $\lfloor 8 \times 2 / 3 \rfloor = 5$ 个，所以第 6 个元素触发扩容，新大小是 $5 \times 3 = 15$ 取 2 的幂 = 16 个槽，可用 10 个，所以第 11 个元素触发；$10 \times 3 = 30 \to 32$ 个槽，可用 21，第 22 个元素；$21 \times 3 = 63 \to 64$，可用 42，第 43 个；$42 \times 3 = 126 \to 128$，可用 85，第 86 个。五个跳变点全部对上了。

键是 `int` 还是 `str` 也有差别。`str` 键的条目只存 `(key, value)` 两个指针，其他类型的键要多存一个缓存的 `hash`，所以条目是 24 字节而不是 16 字节（`pycore_dict.h` 里的 `PyDictKeyEntry` 和 `PyDictUnicodeEntry`）。这能直接在数字上看到：只有一个元素、键是 `str` 的字典 184 字节（上面那张表），键是 `int` 的 `{0: 1}` 要 224 字节。差的 40 字节正好是 5 个可用条目乘每个多出的 8 字节。这个数一会儿还会回来：Sift 的索引里有 4.7 万个这样的字典。

### 探测：冲突了怎么办

两个键算出同一个槽叫冲突。CPython 用开放寻址：在表里按某个规则找下一个槽，不用链表。这个规则不是线性的 `i + 1`，因为连续的整数哈希恰好会按线性顺序到来，线性探测会让它们互相撞。`dictobject.c` 里的做法（引用 `v3.14.0`）：

```c
        perturb >>= PERTURB_SHIFT;
        i = mask & (i*5 + perturb + 1);
```

`PERTURB_SHIFT` 是 5，`perturb` 一开始是整个哈希值，每探一步右移 5 位。`i*5 + 1` 在 2 的幂大小的表里会遍历所有槽，`perturb` 则把哈希值的高位逐步混进来，这样两个只有高位不同、低位相同的哈希值，探测路径很快就岔开。我把这个递推抄成一个三行的脚本，给 8 个槽的表喂三个低三位都是 5 的哈希值：

```python
mask = 7
for h in (5, 8005, 987653):
    i, perturb, order = h & mask, h, [h & mask]
    for _ in range(4):
        perturb >>= 5
        i = (i * 5 + perturb + 1) & mask
        order.append(i)
    print(f"hash {h:>6}: {order}")
```

```text
$ python3 /tmp/scratch/final/probe_order.py
hash      5: [5, 2, 3, 0, 1]
hash   8005: [5, 4, 4, 5, 2]
hash 987653: [5, 2, 7, 2, 3]
```

三个哈希都先落在槽 5，但 8005 的第二步去了 4，987653 的第三步去了 7，路径已经分开。（探测序列里会重复访问同一个槽，比如 8005 的 `4, 4`；这没关系，因为表永远不会满到找不到空槽，负载上限是三分之二。）

### 哈希和相等的契约

放进哈希表的键要满足一条契约：**相等的对象必须有相等的哈希**。查找时先用哈希定位，再用 `==` 确认，哈希不同就根本不会去比较。`dict_order_and_hash.py` 打印了几个典型值：

```python
    for n in (0, 1, 42, -1, -2, 2**61 - 1, 2**61):
        print(f"hash({n}) = {hash(n)}")
    print("hash(1.0) == hash(1):", hash(1.0) == hash(1))
    print("hash(True) == hash(1):", hash(True) == hash(1))
    print("hash('sift') =", hash("sift"))
```

```text
$ python3 lab/ch03/dict_order_and_hash.py | sed -n 5,18p
hash(0) = 0
hash(1) = 1
hash(42) = 42
hash(-1) = -2
hash(-2) = -2
hash(2305843009213693951) = 0
hash(2305843009213693952) = 1
hash(1.0) == hash(1): True
hash(True) == hash(1): True
hash('sift') = 6290588815026152665
hash('') = 0
hash((1, 2)) = -3550055125485641917
hash(('a', 1)) = 6955645834154447545
hash(frozenset({1, 2})) = -1826646154956904602
```

几个值得停一下的地方：

- 小整数的哈希就是它自己。`hash(-1)` 却是 `-2`：C 层的哈希函数用 `-1` 表示出错，所以真正算出来是 `-1` 的哈希会被改成 `-2`（`pyhash.c` 里的 `_Py_HashDouble` 和 `Py_HashPointer` 都有这一行；`int` 的实现在 `longobject.c`，我没读，这里只有输出作证）。结果就是 `hash(-1) == hash(-2)`，它们是一对必然冲突的键。
- `2**61 - 1` 的哈希是 0，`2**61` 的哈希是 1：数值的哈希是对素数 $P = 2^{61} - 1$ 取模，`sys.hash_info.modulus` 就是这个数。
- `1.0`、`True`、`1` 的哈希一样，而且 `1.0 == 1 == True`，所以它们在同一个字典里是同一个键。这是这些内置类型各自的实现保证的：解释器自己并不检查你的类有没有守这条契约。
- `str` 的哈希看着是随机的。它是 SipHash-1-3，而且每个进程启动时会混入一个随机种子，这样攻击者没法构造一批哈希值全相同的字符串来拖垮服务器。

不信的话可以自己违约：让 `==` 永远为真，哈希每次都不同，那么一个和自己“相等”的键也查不到。

```python
from itertools import count


class Key:
    ids = count()

    def __eq__(self, other: object) -> bool:
        return True

    def __hash__(self) -> int:
        return next(Key.ids)


print(Key() == Key(), Key() in {Key()})
```

```text
$ python3 /tmp/scratch/final/key_eq.py
True False
```

两个 `Key()` 明明相等，`in` 却是 `False`：哈希先对不上，`==` 根本没有机会被调用。

`sys.hash_info` 把这些都说清楚了：

```python
import sys

print(sys.hash_info.algorithm, sys.hash_info.modulus)
print("list.__hash__ is None:", list.__hash__ is None)
print("tuple.__hash__ is None:", tuple.__hash__ is None)
```

```text
$ python3 /tmp/scratch/final/hash_facts.py
siphash13 2305843009213693951
list.__hash__ is None: True
tuple.__hash__ is None: False
```

`list` 的 `__hash__` 被显式设成了 `None`（`tuple` 没有）。理由是可变：内容一变，哈希就该跟着变，字典里的条目就找不到了，所以干脆不让它有哈希。这就是 `lab/ch03/unhashable_fail.py`：

```python
def main() -> None:
    """Trigger the TypeError on purpose."""
    # error: TypeError: cannot use 'list' as a dict key
    table = {[1]: 2}
    print(table)
```

```text
$ python3 lab/ch03/unhashable_fail.py; echo "exit $?"
Traceback (most recent call last):
  File "/home/bfmhno3/Projects/sift/lab/ch03/unhashable_fail.py", line 12, in <module>
    main()
    ~~~~^^
  File "/home/bfmhno3/Projects/sift/lab/ch03/unhashable_fail.py", line 7, in main
    table = {[1]: 2}
            ^^^^^^^^
TypeError: cannot use 'list' as a dict key (unhashable type: 'list')
exit 1
```

### 种子：str 的哈希每次不一样

`PYTHONHASHSEED` 控制那个随机种子。环境变量设成 `0` 就是关掉随机化，这是 `flake.nix` 里加上它的原因：不然每次实验输出都不一样。`lab/ch03/extra.sh` 用两个不同的种子把同一个脚本跑两遍，对比输出：

```bash
mkdir -p out/ch03
for seed in 1 2; do
    PYTHONHASHSEED=$seed python3 lab/ch03/dict_order_and_hash.py \
        > "out/ch03/dict_order_and_hash.seed$seed.txt"
done
diff out/ch03/dict_order_and_hash.seed1.txt \
    out/ch03/dict_order_and_hash.seed2.txt || true
```

```text
$ bash lab/ch03/extra.sh
1c1
< PYTHONHASHSEED = 1
---
> PYTHONHASHSEED = 2
14c14
< hash('sift') = 8016220882311150993
---
> hash('sift') = -2446061125029894297
17c17
< hash(('a', 1)) = 6049478860450035402
---
> hash(('a', 1)) = -449070663260204739
19c19
< set of str: ['tea', 'gdb', 'bike', 'kalman', 'pid', 'rust']
---
> set of str: ['kalman', 'rust', 'tea', 'gdb', 'pid', 'bike']
```

一共四处不同，除了第一行的种子本身：`'sift'` 的哈希变了，含有 `str` 的元组的哈希变了（不含的 `(1, 2)` 没变，这一行不在 diff 里），同一批字符串放进 `set` 之后的遍历顺序变了。**`set` 的顺序不是稳定的**，别拿它当有序的东西用；`dict` 的顺序是插入顺序，和哈希无关。

Rust 的 `HashMap` 也要求键满足 `Hash` 和 `Eq` 的契约，pebble 系列第 8 篇的 [Map，和 Hash/Eq 的契约](/posts/rust-by-pebble-08-rc-refcell-values/) 一节讲过；区别是 Rust 在类型系统里检查（没实现 `Hash` 就编译不过），Python 在运行时检查（调用 `hash()` 的时候才抛 `TypeError`）。

### 坏哈希：一个量出来的二次方

契约没规定哈希要好，只规定要相等。把所有对象的哈希都写成 42，契约仍然成立，只是字典退化了。`Good` 用 `hash(self.n)`，`Bad` 返回常数 42：

```python
class Bad(Good):
    def __hash__(self) -> int:
        return 42


def fill(cls: type[Good], n: int) -> float:
    start = time.perf_counter()
    d = {cls(i): i for i in range(n)}
    assert len(d) == n
    return time.perf_counter() - start
```

（`Good` 的 `__eq__` 比较 `self.n`，`__hash__` 返回 `hash(self.n)`，脚本里还有一个 `Good` 的定义，这里没贴。）取三次里的最小值：

```text
$ python3 /tmp/scratch/final/bad_hash.py
     n   good ms    bad ms   ratio
   500      0.16     18.54    115x
  1000      0.28     76.91    275x
  2000      0.58    145.97    252x
  4000      0.69    583.37    843x
  8000      1.50   2463.09   1647x
```

`Good` 在 8,000 个元素时 1.50 ms，`Bad` 要 2.46 s，慢 1,647 倍。`Bad` 一列从 2,000 到 4,000、从 4,000 到 8,000 都是接近 4 倍：规模翻倍，时间翻四倍，二次方。（1,000 那一行比预期低，我猜是这台机器上的计时抖动。）要证明它为什么是二次方，不必靠计时，数一下 `__eq__` 被调用了多少次就行：

```python
class Bad:
    def __init__(self, n: int) -> None:
        self.n = n

    def __hash__(self) -> int:
        return 42

    def __eq__(self, other: object) -> bool:
        global calls
        calls += 1
        return isinstance(other, Bad) and self.n == other.n
```

```text
$ python3 /tmp/scratch/final/eq_calls.py
n=   10  __eq__ calls=     52  n*(n-1)/2=45
n=  100  __eq__ calls=   5039  n*(n-1)/2=4950
n= 1000  __eq__ calls= 500300  n*(n-1)/2=499500
```

（脚本把 `calls` 清零后，用 `{Bad(i): i for i in range(n)}` 造字典，再打印计数。）每插入一个新键，都要和之前已经插进去的所有键比较一遍（它们的哈希相同，哈希相同就必须用 `==` 判断是不是同一个键），总共 $n(n-1)/2$ 次，实测略多一点，我没有追究多出来的那 800 次。这就是哈希表“均摊 $O(1)$”背后的前提：哈希值要分散。`str`、`int` 这些内置类型的哈希都做过这件事；你自己写 `__hash__` 的时候，把各个字段的哈希 `hash((self.a, self.b))` 组合起来是最稳妥的写法。

### 遍历时修改

`dict` 的条目数组是顺着走的，遍历到一半插入或删除会让迭代器的位置失去意义。CPython 的做法是迭代器记下开始时的大小，每走一步检查一下（`dictobject.c` 里有 `"dictionary changed size during iteration"` 这条消息）：

```python
    counts = {"a": 1, "b": 0, "c": 2}
    # error: RuntimeError: dictionary changed size during iteration
    for key, value in counts.items():
        if value == 0:
            del counts[key]
    print(counts)
```

```text
$ python3 lab/ch03/mutate_while_iter_fail.py; echo "exit $?"
Traceback (most recent call last):
  File "/home/bfmhno3/Projects/sift/lab/ch03/mutate_while_iter_fail.py", line 15, in <module>
    main()
    ~~~~^^
  File "/home/bfmhno3/Projects/sift/lab/ch03/mutate_while_iter_fail.py", line 8, in main
    for key, value in counts.items():
                      ~~~~~~~~~~~~^^
RuntimeError: dictionary changed size during iteration
exit 1
```

正确的写法是造一个新字典，而不是原地改：

```python
counts = {"a": 1, "b": 0, "c": 2}
counts = {key: value for key, value in counts.items() if value}
print(counts)
```

```text
$ python3 /tmp/scratch/final/mutate_fix.py
{'a': 1, 'c': 2}
```

（要原地删，先 `list(counts.items())` 拷一份再遍历。`list` 遍历时删元素不会报错，但会悄悄跳过元素，这件事我放进了练习 3。）

## set 与 frozenset

`set` 是没有值的 `dict`，同样的开放寻址，只是条目里没有 `value`，探测略有不同：`setobject.c` 里 `#define LINEAR_PROBES 9`，先在槽的后面线性探 9 个，再按 `perturb` 跳走，因为连续的槽在缓存里是邻居。扩容的条件是 `fill*5 >= mask*3`，也就是装到五分之三就要扩，比 `dict` 的三分之二更早。

上一节 `set of small ints` 那一行可以直接解释了：

```python
    print("set order of small ints:", list({5, 3, 8, 1}))
```

```text
$ python3 lab/ch03/dict_order_and_hash.py | sed -n 4p
set order of small ints: [8, 1, 3, 5]
```

`set` 有 8 个槽，`hash(n)` 对小整数就是 `n` 自己，槽号是 `n & 7`：8 落在槽 0，1 在槽 1，3 在槽 3，5 在槽 5。遍历按槽的顺序走，所以输出是 `[8, 1, 3, 5]`，不是插入顺序，也不是排序。这个“顺序”是哈希表的内部布局偶然泄漏出来的，没有任何保证。

`set` 的集合运算是 Sift 查询的核心，`tuple_vs_list.py` 的最后一行把它们都列了出来：

```text
$ python3 lab/ch03/tuple_vs_list.py | tail -4
tuple as dict key: a
hash((1, 2)) == hash((1, 2)): True
frozenset as key: 1
set ops: {2, 3} {1, 2, 3} {1}
```

三个运算依次是交集 `&`、并集 `|`、差集 `-`。`frozenset` 是不可变的 `set`，因此有哈希，可以当字典的键（上面的 `{frozenset({"rust", "python"}): 1}[frozenset({"python", "rust"})]` 就是这么用的，顺序不同也找得到），普通的 `set` 不行。`tuple` 也一样：只有所有元素都可哈希，`tuple` 才可哈希。这就是为什么二维网格的坐标要用 `(x, y)` 而不是 `[x, y]` 当键。

可哈希和不可变不是一回事：

```text
$ python3 lab/ch03/tuple_vs_list.py | sed -n 5,7p
TypeError: 'tuple' object does not support item assignment
tuple holding a list can still change: ([1, 99], 2)
TypeError: unhashable type: 'list'
```

`tuple` 里装了一个 `list`，`list` 照样能改，对这个 `tuple` 调 `hash` 会抛出 `TypeError`，因为哈希要用到每个元素。`tuple` 的不可变是“不能换元素”，不是“元素内部不能变”。

还有一个我刚好试出来的细节：`set` 的原地交集 `&=`，右边如果是 `dict` 的键视图（`dict.keys()`），它不是原地改：

```python
m = {1, 2, 3}
before = id(m)
m &= {2: "x", 3: "y"}.keys()
print(type(m).__name__, m, id(m) == before)
```

```text
$ python3 /tmp/scratch/final/inplace_and.py
set {2, 3} False
```

结果是 `{2, 3}`，但 `id` 变了，`m` 被重新绑定到了一个新的 `set`。原因是 `set.__iand__` 只接受另一个 `set`，对键视图返回 `NotImplemented`，Python 回退到 `m = m & keys`，最后调用的是键视图的反向方法 `__rand__`。结果不变，只是多了一次分配；Sift 里的 `matching &= posting.keys()` 就是这么写的，记住这一点，下面会用到。

## 查询：交集与排序

现在可以读 `__main__.py` 里的 `search_index` 了。省略文档字符串之后的主体是：

```python
def search_index(
    index: dict[str, dict[int, int]], words: list[str]
) -> list[tuple[int, int]]:
    # ...
    terms = list(dict.fromkeys(token for w in words for token in tokenize(w)))
    if not terms:
        return []
    postings = [index.get(term, {}) for term in terms]
    matching = set(postings[0])
    for posting in postings[1:]:
        matching &= posting.keys()
    hits = [(sum(p[doc_id] for p in postings), doc_id) for doc_id in matching]
    hits.sort(key=lambda hit: (-hit[0], hit[1]))
    return hits
```

逐行看每个容器在干什么：

- `dict.fromkeys(...)` 把词元去重并**保持第一次出现的顺序**（`dict` 保序）。如果不去重，重复的查询词会在后面的求和里被重复计数。我用大小写不同的三个 `kalman` 验证：

  ```text
  $ python3 -m sift search kalman Kalman KALMAN | sed -n "1p;\$p"
       7  corpus/posts/kalman-filter-02-multivariate.md
  8 hits in 123 files: index built in 720.3 ms, query took 0.089 ms
  ```

  和单个 `kalman` 一样，第一名仍是 7，仍是 8 个命中。（分词时 NFKC 加 `casefold` 已经把三个词变成了同一个词元，`fromkeys` 再把它们合成一个。）
- `index.get(term, {})` 取出每个词的倒排记录；词不在索引里，就得到一个空字典，后面的交集自然为空，不需要特判。
- `set(postings[0])` 是第一个词的文档集合，`matching &= posting.keys()` 依次与其余的词求交，这就是上面那个“`&=` 会重新绑定”的地方。
- 每个命中文档的分数是各个词在这个文档里 `tf` 之和，`sum(p[doc_id] for p in postings)`。
- 排序键是 `(-分数, doc_id)`：分数从高到低，分数相同按文档编号从小到大。这样结果是确定的，不依赖 `set` 的遍历顺序（上面说过它不稳定）。

中文查询也走同一条路。`所有权` 被分成 `所有`、`有权` 两个二元组，`借用` 一个，三个词全部命中的文档才出来：

```text
$ python3 -m sift search 所有权 借用 | sed -n "1,3p;\$p"
    57  corpus/posts/rust-by-pebble-02-ownership.md
    40  corpus/posts/rust-by-pebble-07-parser-errors-cli.md
    36  corpus/posts/rust-by-pebble-12-vm-backends.md
10 hits in 123 files: index built in 721.7 ms, query took 0.107 ms
```

（中间 6 行我省略了，命令里 `sed` 只留了头三行和最后一行。）

### 排序：稳定、Timsort

`sort` 的 `key` 对每个元素只调用一次，然后拿键来比较。`list.sort` 和 `sorted` 是**稳定**的：键相同的元素保持原来的相对顺序。`sorting.py` 的头几行验证这一点：

```python
    rows = [("tea", 3), ("bike", 1), ("rust", 3), ("pid", 2), ("gdb", 1)]
    print(sorted(rows, key=itemgetter(1)))
    print(sorted(rows, key=itemgetter(1), reverse=True))
    print(sorted(rows, key=lambda r: (-r[1], r[0])))
```

```text
$ python3 lab/ch03/sorting.py | sed -n 1,5p
[('bike', 1), ('gdb', 1), ('pid', 2), ('tea', 3), ('rust', 3)]
[('tea', 3), ('rust', 3), ('pid', 2), ('bike', 1), ('gdb', 1)]
[('rust', 3), ('tea', 3), ('pid', 2), ('bike', 1), ('gdb', 1)]
['A', 'b', 'B', 'c']
['tea', 'rust', 'pid', 'bike', 'gdb']
```

第一行：分数相同的 `bike` 和 `gdb` 保持输入里的先后。第二行加了 `reverse=True`，分数为 3 的 `tea` 仍然排在 `rust` 前面，也就是说 `reverse=True` 反转的是比较，不是结果，稳定性保持。第三行用 `(-r[1], r[0])` 做键，同分的再按名字排，`rust` 排到了 `tea` 前面。第四行 `str.casefold` 作键，`b` 和 `B` 比较时相等，所以保持原来的 `b`、`B` 顺序，这是上一篇 `casefold` 的另一个用处。`operator.itemgetter(1)` 是 C 实现的 `lambda r: r[1]`。

CPython 的排序是 Timsort：先扫描输入，找出已经升序（或严格降序，然后原地翻转）的连续片段，叫 run（`listobject.c` 里的 `count_run`），再把这些 run 归并。已经有序的输入只要扫一遍：

```python
    rng = random.Random(1234)
    n = 1_000_000
    shuffled = [rng.random() for _ in range(n)]
    presorted = sorted(shuffled)
    reverse = presorted[::-1]
```

```text
$ python3 lab/ch03/sorting.py | tail -3
sorted  shuffled, n=1000000:   336.7 ms
sorted presorted, n=1000000:    45.2 ms
sorted  reversed, n=1000000:    50.4 ms
```

一百万个浮点数，打乱的 336.7 ms，已经排好的 45.2 ms，倒序的 50.4 ms，前者比后者慢 7.4 倍和 6.7 倍。这个差别在 Sift 里是真的用得上的：倒排记录里的文档编号是按递增顺序插入的（`enumerate(paths)`），所以每个词的记录天然就是有序的，不用排序，以后做归并求交集正好需要这个性质。

### Counter 与 `most_common`

`stats` 子命令要的是“全语料出现次数最多的 20 个词”：

```python
def run_stats() -> None:
    # ...
    totals = Counter({term: sum(p.values()) for term, p in index.items()})
    print(f"documents: {len(paths)}")
    print(f"vocabulary: {len(index)}")
    for term, count in totals.most_common(20):
        print(f"{count:>7}  {term}")
```

`Counter` 是 `dict` 的子类，键是元素，值是次数，缺失的键返回 0 而不是抛 `KeyError`。`most_common(20)` 的实现我直接读了标准库：

```python
        # Emulate Bag.sortedByCount from Smalltalk
        if n is None:
            return sorted(self.items(), key=_itemgetter(1), reverse=True)
        # ...
        return heapq.nlargest(n, self.items(), key=_itemgetter(1))
```

（节选自 `inspect.getsource(collections.Counter.most_common)`，中间的惰性 `import heapq` 省略了。）给了 `n` 就用堆，只保留当前最大的 `n` 个，不排序全部。我给它造了一个和语料一样大（81,192 个键）的 `Counter` 比一下：

```python
import timeit
from collections import Counter

totals = Counter({f"t{i}": (i * 7919) % 5000 for i in range(81_192)})
stmts = {
    "most_common(20)": "totals.most_common(20)",
    "sorted()[:20]": "sorted(totals.items(), key=lambda kv: kv[1])[-20:]",
    "most_common()": "totals.most_common()",
}
for label, stmt in stmts.items():
    runs = timeit.repeat(stmt, globals={"totals": totals}, number=20, repeat=5)
    print(f"{label:<18}{min(runs) / 20 * 1000:8.2f} ms")
```

```text
$ python3 /tmp/scratch/final/mc_timing.py
most_common(20)       3.93 ms
sorted()[:20]        21.31 ms
most_common()        17.46 ms
```

取前 20 名，用堆比整个排序快 5.4 倍（3.93 ms 对 21.31 ms）。（`sorted()[:20]` 这一行里我用 `[-20:]` 取排序后的最后 20 个，等价于降序的前 20 个，只是不用 `reverse=True`。）完整的 `stats` 输出：

```text
$ python3 -m sift stats
documents: 123
vocabulary: 81192
  14594  0
  11405  1
   6620  2
   6317  a
   4740  一个
   4572  3
   4067  n
   3392  t
   3391  x
   3226  np
   2978  c
   2956  i
   2861  s
   2828  self
   2823  b
   2782  4
   2498  let
   2373  p
   2138  std
   2067  5
index built in 754.4 ms
```

81,192 个词，语料里出现最多的是 `0`，14,594 次；前 20 名里 15 个是数字或单个字母，另外 `np`、`self`、`let`、`std` 是代码标识符，我猜它们都来自代码块和公式；唯一的自然语言是二元组 `一个`，4,740 次。一个纯按词频排名的搜索引擎，会被 `0` 和 `a` 这类词淹没。这不是 bug，是后面要解决的问题：第 4 篇的 tf-idf 和第 8 篇的 BM25。（我没有在这里去掉停用词，所以 `stats` 的输出还是原始的。）

## collections 一圈

标准库的 `collections` 里有几个容器，Sift 后面几乎每一章都会用到，`collections_tour.py` 每个演示一下。先是 `Counter` 与 `defaultdict`：

```python
    counts = Counter("abracadabra")
    print(counts.most_common(3), counts["z"])
    counts.update("aaa")
    print(counts + Counter("bb"), counts - Counter("a" * 10))

    groups: defaultdict[int, list[str]] = defaultdict(list)
    for word in ["tea", "bike", "rust", "pid", "gdb"]:
        groups[len(word)].append(word)
    print(dict(groups))
```

```text
$ python3 lab/ch03/collections_tour.py | sed -n 1,3p
[('a', 5), ('b', 2), ('r', 2)] 0
Counter({'a': 8, 'b': 4, 'r': 2, 'c': 1, 'd': 1}) Counter({'b': 2, 'r': 2, 'c': 1, 'd': 1})
{3: ['tea', 'pid', 'gdb'], 4: ['bike', 'rust']}
```

`Counter` 之间可以做加减，减法丢掉零和负数（`counts - Counter("a" * 10)` 里 `a` 消失了，`r`、`b` 保留）；`defaultdict(list)` 在键不存在时用工厂函数造一个默认值，所以 `groups[len(word)].append(word)` 不用先检查键在不在。

`build_index` 为什么用 `index.setdefault(term, {})` 而不是 `defaultdict(dict)`？`setdefault` 每次调用都会先构造一个空字典 `{}` 当参数，即使键已经存在，它就被丢掉了。语料里 290,820 次插入有 81,192 次是新词，剩下的 209,628 次都白造了一个字典。这听起来是该优化的地方，所以我量了一下，把 `build_index` 改写成 `defaultdict` 的版本（只在草稿里，不进仓库）：

```python
def with_defaultdict(docs):
    index = defaultdict(dict)
    for doc_id, tokens in docs.items():
        for term, tf in Counter(tokens).items():
            index[term][doc_id] = tf
    return index
```

```text
$ python3 /tmp/scratch/final/setdefault_vs_dd.py
setdefault   144.0 ms
defaultdict  139.2 ms
setdefault   146.3 ms
defaultdict  139.2 ms
same index: True
```

（每一行是 7 次中的最小值；脚本最后用 `assert` 确认两种写法得到的索引完全相同。）两个版本差 3% 到 5%，也就是 5 到 7 ms，在这台机器的噪声边缘。我本来预期差更多：空字典的分配似乎很便宜，209,628 次白造的字典加起来也就这么点（这个解释我没有再验证）。结论是：我选 `setdefault` 是因为它的返回值最直观，不是因为它更快，而且 `defaultdict` 有个副作用：**读取不存在的键也会把键创建出来**，`index["missing"]` 会悄悄让索引多一项。`index.get` 不会。

剩下几个：

```python
    window: deque[int] = deque(maxlen=3)
    for i in range(6):
        window.append(i)
    print("deque(maxlen=3):", window)
    window.rotate(1)
    print("rotate(1):", window)

    Hit = namedtuple("Hit", ["doc_id", "score"])
    hit = Hit(7, 1.5)
    print(hit, hit.doc_id, hit._replace(score=2.0), hit._asdict())
```

```text
$ python3 lab/ch03/collections_tour.py | sed -n 4,7p
deque(maxlen=3): deque([3, 4, 5], maxlen=3)
rotate(1): deque([5, 3, 4], maxlen=3)
Hit(doc_id=7, score=1.5) 7 Hit(doc_id=7, score=2.0) {'doc_id': 7, 'score': 1.5}
0.5 1.2 [{'b': 0.5}, {'k1': 1.2, 'b': 0.75}]
```

`deque(maxlen=3)` 追加到第 6 个元素时，最早的三个自动被挤出去，只剩最后三个，这是现成的滑动窗口。`namedtuple` 是有字段名的 `tuple`，`_replace` 返回新的（不改原来的），`_asdict` 转成字典。最后一行是 `ChainMap`：

```python
    defaults = {"k1": 1.2, "b": 0.75}
    overrides = {"b": 0.5}
    config = ChainMap(overrides, defaults)
    print(config["b"], config["k1"], list(config.maps))
```

`ChainMap` 把多个字典叠在一起查找，先查前面的：`config["b"]` 是 0.5（`overrides` 盖住了 `defaults`），`config["k1"]` 是 1.2。它不拷贝数据，适合“默认值加用户覆盖”这种分层。（`k1` 和 `b` 不是随便起的名字，它们是 BM25 的两个参数。）最后是 `OrderedDict`：

```text
$ python3 lab/ch03/collections_tour.py | tail -2
move_to_end: ['b', 'c', 'a']
popitem(last=False): ['c', 'a']
```

`OrderedDict` 和普通 `dict` 的区别是它有 `move_to_end` 和从头部 `popitem(last=False)`，所以它仍然适合做 LRU 缓存：每次命中把键挪到末尾，容量满了从头部弹出最久没用的。普通 `dict` 保序了，但没有这两个方法。

## 别名、拷贝与推导式

### 别名

`list` 是可变的，所以赋值只是多一个名字：

```python
    a = [1, 2, 3]
    b = a
    b.append(4)
    print("alias:", a, a is b)

    grid = [[0] * 3] * 3
    grid[0][0] = 1
    print("[[0]*3]*3 :", grid, [id(r) == id(grid[0]) for r in grid])
    grid = [[0] * 3 for _ in range(3)]
    grid[0][0] = 1
    print("comprehension:", grid)
```

```text
$ python3 lab/ch03/aliasing.py | sed -n 1,3p
alias: [1, 2, 3, 4] True
[[0]*3]*3 : [[1, 0, 0], [1, 0, 0], [1, 0, 0]] [True, True, True]
comprehension: [[1, 0, 0], [0, 0, 0], [0, 0, 0]]
```

`[[0] * 3] * 3` 的 `* 3` 复制的是外层列表里的指针：三个槽指向同一个内层列表，`id` 全部相同，改一行就是改三行。推导式每次迭代都新建一个 `[0] * 3`，所以三行互相独立。这和第 1 篇的“名字是便利贴”是同一件事，只是这一次它咬了人。

### 浅拷贝和深拷贝

```python
    inner = [1, 2]
    outer = [inner, "x"]
    shallow = copy.copy(outer)
    deep = copy.deepcopy(outer)
    inner.append(3)
    print("original:", outer)
    print("copy.copy:", shallow, shallow[0] is outer[0])
    print("deepcopy:", deep, deep[0] is outer[0])
    print("slice copy is shallow:", outer[:][0] is outer[0])
```

```text
$ python3 lab/ch03/aliasing.py | sed -n 4,7p
original: [[1, 2, 3], 'x']
copy.copy: [[1, 2, 3], 'x'] True
deepcopy: [[1, 2], 'x'] False
slice copy is shallow: True
```

`copy.copy` 造了一个新的外层列表，但里面的指针指向同样的内层对象，所以 `inner` 追加 `3` 之后，浅拷贝里也看到了；`deepcopy` 递归地复制，内层是新对象，不受影响。切片 `outer[:]` 是浅拷贝，是最常被忽略的一种。

别名最阴险的一种形态藏在默认参数里：

```python
    # BAD: 默认值只在 def 执行时创建一次
    def append_to(
        item: int,
        bucket: list[int] = [],  # noqa: B006
    ) -> list[int]:
        bucket.append(item)
        return bucket

    print("mutable default:", append_to(1), append_to(2))
```

```text
$ python3 lab/ch03/aliasing.py | tail -1
mutable default: [1, 2] [1, 2]
```

默认值 `[]` 在函数**定义**时只算一次，之后每次不传 `bucket` 的调用共用同一个列表。两次调用返回的是同一个对象，打印出来自然都是 `[1, 2]`。（`noqa: B006` 是 `ruff` 的一条规则，专门抓这个；第 4 篇讲函数的时候再回来。）

### 推导式

推导式是 Sift 里随处可见的写法，`comprehensions.py` 把形式列了一遍：

```python
    words = ["Tea", "bike", "rust", "Kalman", "pid", "tea"]
    print([w.lower() for w in words])
    print([w for w in words if len(w) > 3])
    print([w.upper() if w.islower() else w for w in words])
    print({w.lower(): len(w) for w in words})
    print({w.lower() for w in words})
```

```text
$ python3 lab/ch03/comprehensions.py | sed -n 1,5p
['tea', 'bike', 'rust', 'kalman', 'pid', 'tea']
['bike', 'rust', 'Kalman']
['Tea', 'BIKE', 'RUST', 'Kalman', 'PID', 'TEA']
{'tea': 3, 'bike': 4, 'rust': 4, 'kalman': 6, 'pid': 3}
{'bike', 'kalman', 'rust', 'tea', 'pid'}
```

第二行的 `if` 放在末尾，是过滤；第三行的 `if ... else` 放在表达式里，是条件表达式，两者位置不同、作用不同。字典推导式 `{w.lower(): len(w) ...}` 里 `Tea` 和 `tea` 有相同的键，后面的覆盖前面的，所以只有 5 个键。集合推导式直接去重。嵌套和多个 `for`：

```text
$ python3 lab/ch03/comprehensions.py | sed -n 6,10p
[1, 2, 3, 4, 5, 6]
[[1, 4], [2, 5], [3, 6]]
[(0, 1), (0, 2), (1, 2)]
generator expression: 30
n after comprehension: outer
```

`[x for row in matrix for x in row]` 里 `for` 的顺序和写成嵌套循环的顺序一样（外层在前），把矩阵压平；方括号里再套方括号是转置。把方括号换成圆括号是生成器表达式，不会一次性造出整个列表，`sum` 一边取一边加，所以内存是常数。最后一行：循环变量 `n` 不会泄漏出推导式，外面的 `n` 仍是 `"outer"`。

这个“有自己的作用域”在 3.12 之后是靠内联实现的（PEP 709），不再为每个推导式造一个函数对象。我用 `dis` 验证了这一点：

```python
import dis


def double(xs):
    return [x * 2 for x in xs]


ops = {i.opname for i in dis.get_instructions(double)}
print("MAKE_FUNCTION" in ops, "LOAD_FAST_AND_CLEAR" in ops)
```

```text
$ python3 /tmp/scratch/final/dis_comp.py
False True
```

没有 `MAKE_FUNCTION`，有 `LOAD_FAST_AND_CLEAR`：推导式的代码直接展开在外层函数里，用这条指令在进入时把同名的外层变量暂存、退出时恢复，所以看起来仍然有自己的作用域。（第 1 篇的 `dis` 用法，不重复。）最后一行 `walrus: [9, 16, 25]` 用 `:=` 在推导式的过滤条件里复用算出来的值，避免对 `x * x` 算两遍。

### 解包与切片赋值

`unpacking.py` 是这一章最杂的一个文件，一次看完：

```python
    first, *middle, last = [1, 2, 3, 4, 5]
    print(first, middle, last)
    head, *_ = "sift"
    print(head)
    a, b = 1, 2
    a, b = b, a
    print("swap:", a, b)
    (x, y), (z, *rest) = (1, 2), (3, 4, 5)
    print("nested:", x, y, z, rest)
```

```text
$ python3 lab/ch03/unpacking.py | sed -n 1,4p
1 [2, 3, 4] 5
s
swap: 2 1
nested: 1 2 3 [4, 5]
```

星号变量收集“剩下的”，结果总是 `list`，可以放在头、中、尾（每个解包只能有一个）。`a, b = b, a` 不需要临时变量，我用 `dis` 看了 3.14 的字节码：

```python
import dis


def swap(a, b):
    a, b = b, a


dis.dis(swap)
```

```text
$ python3 /tmp/scratch/final/dis_swap.py
  4           RESUME                   0

  5           LOAD_FAST_LOAD_FAST     16 (b, a)
              STORE_FAST_STORE_FAST   16 (b, a)
              LOAD_CONST               0 (None)
              RETURN_VALUE
```

没有构造元组：`b` 和 `a` 一次压栈，一次存回去。嵌套解包按结构拆开。

字面量里的星号和 `**` 把可迭代对象和字典摊开：

```text
$ python3 lab/ch03/unpacking.py | sed -n 5,8p
a 1 2
b 3 4
star in literal: [0, 1, 2, 'a', 'b']
dict merge: {'a': 3, 'b': 2}
```

`{**{"a": 1}, **{"b": 2, "a": 3}}` 里后面的覆盖前面的，`a` 最终是 3。切片赋值是最容易被忽略的 `list` 功能：

```python
    items = [0, 1, 2, 3, 4, 5]
    items[1:3] = ["x", "y", "z"]
    print("slice assignment grows:", items)
    items[::2] = [10, 20, 30, 40]
    print("extended slice, same size:", items)
    del items[1:3]
    print("del slice:", items)
    items[2:2] = ["ins"]
    print("insert by empty slice:", items)
```

```text
$ python3 lab/ch03/unpacking.py | tail -4
slice assignment grows: [0, 'x', 'y', 'z', 3, 4, 5]
extended slice, same size: [10, 'x', 20, 'z', 30, 4, 40]
del slice: [10, 'z', 30, 4, 40]
insert by empty slice: [10, 'z', 'ins', 30, 4, 40]
```

连续切片 `items[1:3]` 赋值给长度不同的序列，列表会收缩或增长；带步长的扩展切片 `items[::2]` 要求两边长度相等（这里刚好 4 个对 4 个，不相等会抛 `ValueError`）；空切片 `items[2:2]` 就是在那个位置插入。每一种都是一次指针数组的整体搬动，代价是 $O(n)$，和 `insert(0)` 同一个级别。

## 这个索引有多重

回到开头那个 721.4 ms。我想知道 `build_index` 之外，另外三项各占多少。下面这个脚本复用仓库里的 `strip_markdown`、`tokenize` 和 `build_index`，把四步各自计时，重复 5 次取最小值：

```python
paths = sorted(CORPUS.glob("*.md"))
best = {}
for _ in range(5):
    t0 = time.perf_counter()
    texts = [p.read_text(encoding="utf-8") for p in paths]
    t1 = time.perf_counter()
    bodies = [strip_markdown(split_front_matter(t)[1]) for t in texts]
    # ...
```

```text
$ python3 /tmp/scratch/final/stage_min.py
read                8.5 ms
strip_markdown    168.1 ms
tokenize          365.0 ms
build_index       164.2 ms
sum               705.9 ms
```

四步加起来 705.9 ms，和命令行报的 721.4 ms 相差不到 3%（这里最小值，那里是单次运行）。`build_index` 占 23%：164.2 ms，用 290,820 次 `dict` 写入换来的就是后面的 0.076 ms。（前面 `setdefault_vs_dd.py` 里同一个函数是 144.0 ms，那是另一次独立运行，而且 `texts` 和 `bodies` 在这里还活在内存里，我猜垃圾回收要多扫一些对象，没有验证；这两个数我都不信到个位数。）真正贵的是 `tokenize`（365.0 ms）和 `strip_markdown`（168.1 ms），它们和容器无关，第 5 篇把流水线改成惰性的时候会再回头看。

### 它占多少内存

索引里有多少东西，占多少内存？

```python
import sys
import timeit

from sift.__main__ import CORPUS, load_index

paths, index = load_index(CORPUS)
outer = sys.getsizeof(index)
inner = sum(sys.getsizeof(p) for p in index.values())
terms = sum(sys.getsizeof(t) for t in index)
ints = sum(
    sys.getsizeof(tf) for p in index.values() for tf in p.values() if tf > 256
)
print(f"outer dict   {outer / 2**20:6.2f} MiB")
print(f"inner dicts  {inner / 2**20:6.2f} MiB")
print(f"term strings {terms / 2**20:6.2f} MiB")
print(f"big tf ints  {ints / 2**20:6.2f} MiB")
print(f"sum          {(outer + inner + terms + ints) / 2**20:6.2f} MiB")
print("getsizeof({0: 1}) =", sys.getsizeof({0: 1}))
print(
    "getsizeof({0: 1, 1: 1, 2: 1, 3: 1, 4: 1}) =",
    sys.getsizeof({0: 1, 1: 1, 2: 1, 3: 1, 4: 1}),
)
print("len(index['kalman']) =", len(index["kalman"]))
terms_list = list(index)
hit = timeit.timeit(
    "index['kalman']", globals={"index": index}, number=1_000_000
)
miss = timeit.timeit(
    "'zzzz' in index", globals={"index": index}, number=1_000_000
)
print(f"dict hit   {hit * 1000:6.0f} ns")
print(f"dict miss  {miss * 1000:6.0f} ns")
n = 200
scan = (
    timeit.timeit(
        "terms_list.index('kalman')",
        globals={"terms_list": terms_list},
        number=n,
    )
    / n
)
pos = terms_list.index("kalman")
print(f"list.index('kalman') at position {pos}: {scan * 1e6:8.1f} us")
scan2 = (
    timeit.timeit(
        "'zzzz' in terms_list", globals={"terms_list": terms_list}, number=n
    )
    / n
)
print(f"'zzzz' in list of {len(terms_list)}: {scan2 * 1e6:8.1f} us")
```

```text
$ python3 /tmp/scratch/final/index_mem.py
outer dict     1.83 MiB
inner dicts   22.31 MiB
term strings   4.61 MiB
big tf ints    0.00 MiB
sum           28.76 MiB
getsizeof({0: 1}) = 224
getsizeof({0: 1, 1: 1, 2: 1, 3: 1, 4: 1}) = 224
len(index['kalman']) = 8
dict hit       22 ns
dict miss      24 ns
list.index('kalman') at position 19618:    173.0 us
'zzzz' in list of 81192:   2800.3 us
```

`big tf ints` 统计的是大于 256 的 `tf` 整数，没有，所以是 0。外层字典 1.83 MiB，每个词对应的内层字典合计 22.31 MiB，词的字符串本身 4.61 MiB（它们和分词得到的词元是同一批对象，所以真正为索引新增的内存是前两项，约 24.1 MiB）。我另外用 `tracemalloc` 量了 `build_index` 单独保留的内存，顺便数了倒排记录：

```python
import tracemalloc

from sift.__main__ import CORPUS
from sift.analysis.tokenize import tokenize
from sift.index import build_index
from sift.markdown import split_front_matter, strip_markdown

paths = sorted(CORPUS.glob("*.md"))
docs = {}
for i, p in enumerate(paths):
    body = strip_markdown(split_front_matter(p.read_text("utf-8"))[1])
    docs[i] = tokenize(body)
tracemalloc.start()
index = build_index(docs)
kept = tracemalloc.get_traced_memory()[0]
postings = sum(len(p) for p in index.values())
single = sum(1 for p in index.values() if len(p) == 1)
print(f"terms {len(index)}, postings {postings}")
print(f"terms in exactly 1 doc: {single} ({single / len(index):.1%})")
print(f"build_index keeps {kept / 2**20:.1f} MiB")
```

```text
$ python3 /tmp/scratch/final/count_index.py
terms 81192, postings 290820
terms in exactly 1 doc: 47378 (58.4%)
build_index keeps 24.1 MiB
```

24.1 MiB 和上面前两项之和吻合。

24.1 MiB 对应 290,820 条倒排记录，平均每条 87 字节，每个内层字典平均 288 字节。大头是**很多只有一两个文档的词各自拥有一个完整的字典**：我数了一下，47,378 个词（占词表的 58.4%）只出现在一个文档里，每个都是一个 `{doc_id: tf}`，最小的字典就是 224 字节（前面说过，`int` 键的最小字典）：

$$
47{,}378 \times 224 \text{ B} = 10{,}612{,}672 \text{ B} \approx 10.1 \text{ MiB}
$$

占了总量的 42%，只为了存一个 `(doc_id, tf)` 对。这种代价在 Sift 的规模上没有问题，123 篇文章，24 MiB；换成一万篇文章会变成问题。第 6 篇的 `Posting` 和 `PostingList` 会把它换成更紧凑的结构。（我这里做的是“数出来”，没有把它重写一遍再量，所以“更紧凑”目前只是方向，不是数字。）

### 查找的代价，对比 list

最后一个数字回答开头的问题：一个词的查找为什么是 0.076 ms 以内？

```text
dict hit       22 ns
dict miss      24 ns
list.index('kalman') at position 19618:    173.0 us
'zzzz' in list of 81192:   2800.3 us
```

在 81,192 个词的 `dict` 里，查一个存在的词 22 ns，查一个不存在的词 24 ns，一样快（探测遇到空槽就能说“没有”）。如果把词表放成 `list`，`kalman` 排在第 19,618 位，扫到它要 173.0 µs，慢 7,864 倍；一个不存在的词要扫完整个列表，2,800.3 µs，慢 116,679 倍。和前面 `in` 那张表的趋势一模一样，只是这一次是在 Sift 自己的数据上。

### 单次运行，一个被推翻的猜测

上一篇我猜等词元存进字典，整条命令就会比 `ch01` 还快。现在可以算这笔账了：把上一篇的 `ch02` 导出到临时目录，和 `ch03` 并排跑 20 次：

```bash
mkdir -p /tmp/sift-ch02 && \
    git -C ~/Projects/sift archive ch02 | tar -x -C /tmp/sift-ch02
ln -s ~/Projects/sift/corpus /tmp/sift-ch02/corpus
hyperfine --warmup 2 --runs 20 -n ch02 \
    "cd /tmp/sift-ch02 && PYTHONPATH=src python3 -m sift kalman" \
    -n ch03 "python3 -m sift search kalman"
```

```text
Benchmark 1: ch02
  Time (mean ± σ):     617.4 ms ±   7.4 ms    [User: 602.6 ms, System: 11.3 ms]
  Range (min … max):   609.9 ms … 638.7 ms    20 runs
Benchmark 2: ch03
  Time (mean ± σ):     794.7 ms ±  10.2 ms    [User: 737.9 ms, System: 52.1 ms]
  Range (min … max):   783.0 ms … 826.5 ms    20 runs
Summary
  ch02 ran
    1.29 ± 0.02 times faster than ch03
```

（`hyperfine` 的空行和一条关于离群值的警告我省掉了，保留了计时和汇总。`PYTHONPATH=src` 是因为 `nix develop` 默认把 `PYTHONPATH` 指向主仓库的 `src`，我要强制它用临时目录里的 `ch02`。）`ch03` 慢了 1.29 倍：多了 177.3 ms。前面单独量过 `build_index` 约 144 ms，大头应该在这里；剩下的差额我没有拆开，不想编一个听起来合理的解释。

所以上一篇的猜测要改成：索引只有活得比进程久才值钱。一次运行里，建索引的 721.4 ms 和查询的 0.076 ms 的比是大约 9,500 比 1，查询再快也被建索引吃掉了。`lab/ch01/extra.sh` 现在测的是 `search kalman` 对 `grep -rci kalman corpus/posts`：

```text
$ bash lab/ch01/extra.sh | tail -1
python/grep ratio: 159.7x
```

（第 1 篇同一个脚本测的是 6.5 倍，因为那时的搜索是朴素的子串计数。分子分母都变了：grep 5.1 ms，Python 821.0 ms。）这个数字什么时候能翻过来，不取决于我再怎么优化 `build_index`，而取决于索引能不能存下来；我猜存下来之后，一次搜索的耗时会回到几十毫秒的量级，但这还是猜，等第 12 篇有了持久化的索引再量。

## 本篇文件

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`src/sift/index.py`](https://github.com/bfmhno3/sift/blob/ch03/src/sift/index.py) | `python3 -c 'from sift.index import build_index; print(build_index({0: ["tea"]}))'` | 退出码 0，输出 `{'tea': {0: 1}}`；12 行；第 6 篇换成带位置信息的 `Posting` |
| [`src/sift/__main__.py`](https://github.com/bfmhno3/sift/blob/ch03/src/sift/__main__.py) | `python3 -m sift search kalman` | 退出码 0，8 行命中加最后一行 `8 hits in 123 files: index built in 721.4 ms, query took 0.076 ms`；90 行；之后每章继续改 |
| [`src/sift/__main__.py`](https://github.com/bfmhno3/sift/blob/ch03/src/sift/__main__.py) | `python3 -m sift stats` | 退出码 0，23 行，第二行 `vocabulary: 81192`，第三行 `  14594  0` |
| [`lab/ch01/extra.sh`](https://github.com/bfmhno3/sift/blob/ch03/lab/ch01/extra.sh) | `bash lab/ch01/extra.sh` | 退出码 0，最后一行 `python/grep ratio: 159.7x`（命令改成了 `search kalman`，倍数每次运行略有不同） |
| [`lab/ch03/list_growth.py`](https://github.com/bfmhno3/sift/blob/ch03/lab/ch03/list_growth.py) | `python3 lab/ch03/list_growth.py` | 退出码 0，最后一行 `ratio: 8.8x` |
| [`lab/ch03/list_ops_cost.py`](https://github.com/bfmhno3/sift/blob/ch03/lab/ch03/list_ops_cost.py) | `python3 lab/ch03/list_ops_cost.py` | 退出码 0，最后一行 `  1000000     22227629        51    438404x`（计时每次不同，形状不变） |
| [`lab/ch03/dict_order_and_hash.py`](https://github.com/bfmhno3/sift/blob/ch03/lab/ch03/dict_order_and_hash.py) | `python3 lab/ch03/dict_order_and_hash.py` | 退出码 0，第一行 `PYTHONHASHSEED = 0` |
| [`lab/ch03/unhashable_fail.py`](https://github.com/bfmhno3/sift/blob/ch03/lab/ch03/unhashable_fail.py) | `python3 lab/ch03/unhashable_fail.py` | 退出码 1：`TypeError: cannot use 'list' as a dict key (unhashable type: 'list')` |
| [`lab/ch03/aliasing.py`](https://github.com/bfmhno3/sift/blob/ch03/lab/ch03/aliasing.py) | `python3 lab/ch03/aliasing.py` | 退出码 0，第一行 `alias: [1, 2, 3, 4] True` |
| [`lab/ch03/comprehensions.py`](https://github.com/bfmhno3/sift/blob/ch03/lab/ch03/comprehensions.py) | `python3 lab/ch03/comprehensions.py` | 退出码 0，第一行 `['tea', 'bike', 'rust', 'kalman', 'pid', 'tea']` |
| [`lab/ch03/unpacking.py`](https://github.com/bfmhno3/sift/blob/ch03/lab/ch03/unpacking.py) | `python3 lab/ch03/unpacking.py` | 退出码 0，第一行 `1 [2, 3, 4] 5` |
| [`lab/ch03/sorting.py`](https://github.com/bfmhno3/sift/blob/ch03/lab/ch03/sorting.py) | `python3 lab/ch03/sorting.py` | 退出码 0，最后一行 `sorted  reversed, n=1000000:    50.4 ms` |
| [`lab/ch03/collections_tour.py`](https://github.com/bfmhno3/sift/blob/ch03/lab/ch03/collections_tour.py) | `python3 lab/ch03/collections_tour.py` | 退出码 0，第一行 `[('a', 5), ('b', 2), ('r', 2)] 0` |
| [`lab/ch03/tuple_vs_list.py`](https://github.com/bfmhno3/sift/blob/ch03/lab/ch03/tuple_vs_list.py) | `python3 lab/ch03/tuple_vs_list.py` | 退出码 0，第一行 `n= 0: tuple  48 B, list  56 B` |
| [`lab/ch03/mutate_while_iter_fail.py`](https://github.com/bfmhno3/sift/blob/ch03/lab/ch03/mutate_while_iter_fail.py) | `python3 lab/ch03/mutate_while_iter_fail.py` | 退出码 1：`RuntimeError: dictionary changed size during iteration` |
| [`lab/ch03/extra.sh`](https://github.com/bfmhno3/sift/blob/ch03/lab/ch03/extra.sh) | `bash lab/ch03/extra.sh` | 退出码 0，`diff` 打印 4 处差异：`hash('sift')`、`hash(('a', 1))`、`set of str` 的顺序和种子那一行 |

整章一个 `make` 目标全跑一遍，加上 `make lint`：

```text
$ make ch03
python3 scripts/chapter.py ch03
ok   lab/ch03/aliasing.py
ok   lab/ch03/collections_tour.py
ok   lab/ch03/comprehensions.py
ok   lab/ch03/dict_order_and_hash.py
ok   lab/ch03/list_growth.py
ok   lab/ch03/list_ops_cost.py
ok   lab/ch03/mutate_while_iter_fail.py
ok   lab/ch03/sorting.py
ok   lab/ch03/tuple_vs_list.py
ok   lab/ch03/unhashable_fail.py
ok   lab/ch03/unpacking.py
1c1
< PYTHONHASHSEED = 1
---
> PYTHONHASHSEED = 2
14c14
< hash('sift') = 8016220882311150993
---
> hash('sift') = -2446061125029894297
17c17
< hash(('a', 1)) = 6049478860450035402
---
> hash(('a', 1)) = -449070663260204739
19c19
< set of str: ['tea', 'gdb', 'bike', 'kalman', 'pid', 'rust']
---
> set of str: ['kalman', 'rust', 'tea', 'gdb', 'pid', 'bike']
ok   lab/ch03/extra.sh
$ make lint
ruff format --check --line-length 79 .
44 files already formatted
ruff check .
All checks passed!
```

`mutate_while_iter_fail.py` 和 `unhashable_fail.py` 这两行也是 `ok`，因为运行器知道 `_fail.py` 结尾的文件应该非零退出。`extra.sh` 的 `diff` 输出夹在中间，是脚本本身的 `stdout`，不是错误。

## 练习

**1.** `search_index` 里的交集从第一个词的倒排记录开始，再依次与后面的词求交。如果查询是 `0 kalman`（`0` 出现在很多文档里，`kalman` 只在 8 个），从哪一个开始更快？先预测，再把 `postings` 按 `len` 排一下（`sorted(postings, key=len)`），用 `bench/queries.txt` 里那 12 条查询、`timeit` 重复 1000 次量一量，看差距有多大，是不是超出了这台机器的噪声。

**2.** 把 `build_index` 的输入乘 10：把整个语料的 `docs` 复制 10 份（文档编号错开）再建索引，`setdefault` 和 `defaultdict` 的差距是不是随规模变大？用 `tracemalloc` 量一下内层字典的总内存，是不是还是接近 `{0: 1}` 的 224 字节乘以只出现一次的词数。

**3.** 预测下面这段代码的输出，然后运行：

```python
xs = [1, 2, 3, 4]
for x in xs:
    xs.remove(x)
print(xs)
```

再写一个 `defaultdict(list)`，对不存在的键只做 `in` 判断和 `d[key]` 读取各一次，看看哪一个会改变 `len(d)`。最后解释为什么 `list` 遍历时删元素不报错，而 `dict` 会。（提示：`list` 的迭代器只存一个下标。）

**4.** 在 `mc_timing.py` 的基础上，把 `most_common(k)` 的 `k` 从 20 调到 2,000、20,000、81,192，找出堆和全排序的交叉点。`heapq.nlargest(k, ...)` 的复杂度是 $O(n \log k)$，全排序是 $O(n \log n)$，交叉点在哪里，和 $k$ 与 $n$ 的比值有关吗？

## 下一篇

下一篇是《[函数：参数、作用域、闭包与装饰器](/posts/python-by-sift-04-functions/)》。这一篇里 `search_index` 用了一个 `lambda`，`aliasing.py` 里有一个带 `# noqa: B006` 的默认参数，`comprehensions.py` 讲了推导式的作用域，但这些都没有真的解释：函数对象是什么、默认值为什么是定义时算一次、闭包怎么抓住外面的变量。它们是下一篇的内容。

我猜只有等第 12 篇把索引存到磁盘，整条命令才会掉到几十毫秒的量级。这仍然是猜，到时候说不定又要把今天的话收回来。
