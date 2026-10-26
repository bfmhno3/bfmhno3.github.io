---
title: "数据分析：numpy、pandas、matplotlib 与齐夫定律"
commentId: "post:python-by-sift-22-numpy-pandas-matplotlib"
published: "2026-10-27 00:00:00 +08:00"
description: "用 Sift 重学 Python 第 22 篇：我用 numpy 2.5.1、pandas 3.0.4 和 matplotlib 3.11.1 把 123 篇文章变成 123×81167 的 TF-IDF 矩阵，做出 sift similar 和 sift report。最像的一对是扩展卡尔曼滤波和误差状态卡尔曼滤波（余弦 0.470）；齐夫指数在排名 1 到 1000 上是 -0.743，换三个范围是 -0.639、-0.988 和 -1.152，我把它拆开量了；希普斯指数 0.621。numpy 比纯 Python 快 74 到 375 倍，慢档出在 OpenBLAS 的 16 线程上，限成 1 或 2 个线程后 200 个进程里没再见到；float32 把矩阵从 76.2 MiB 压到 38.1 MiB，123 篇的前 10 名一个都没变。中途碰到 pandas 3 的写时复制、一个运行时不能下标的 pd.Series[int] 注解、一个没关的 sqlite3 连接，和一个默认字重是 Thin 的 CJK 可变字体。"
category: Tutorial
tags:
  - numpy
  - pandas
  - matplotlib
  - 数据分析
series: "用 Sift 重学 Python"
seriesOrder: 22
draft: false
comment: true
slug: python-by-sift-22-numpy-pandas-matplotlib
---

我想知道这 123 篇文章里哪两篇最像。办法是把每篇文章变成一个长 81167 的向量，再算两两之间的余弦。矩阵有 123×81167 个 float32，38.1 MiB；用纯 Python 拿一篇文章对全部 123 篇做点积，要做近一千万次乘加，我量到 425 到 445 毫秒。换成 numpy 的 `matrix @ vector`，同一件事是 1.25 毫秒，快 344 倍。我把脚本又跑了两遍，第二遍是 5.99 毫秒，只快 74 倍，第三遍又回到 1.32 毫秒。三遍之间我夹了 `cpu_state.py`，读数全在 112 到 118 之间，CPU 没有掉进慢状态，所以这次不是第 11 篇里那个 2.5 倍。这一篇讲数据分析的三件套 numpy、pandas 和 matplotlib，用它们回答三个问题：哪两篇文章最像，语料的词频服不服从齐夫定律，词表怎么随文章数增长；也回头把这个 74 到 344 倍的差弄清楚。

```text
$ python3 /tmp/sift-scratch/cpu_state.py; for i in 1 2 3; do python3 lab/ch22/vectorize_speedup.py 2>&1 | grep -v took; python3 /tmp/sift-scratch/cpu_state.py; done
112 113 112 112 112 ms
123 documents x 81167 terms
pure Python:    430.92 ms (median of 5)
numpy @:          1.25 ms (median of 5)
speedup: 344x
112 113 113 113 113 ms
123 documents x 81167 terms
pure Python:    445.03 ms (median of 5)
numpy @:          5.99 ms (median of 5)
speedup: 74x
114 118 114 115 115 ms
123 documents x 81167 terms
pure Python:    425.49 ms (median of 5)
numpy @:          1.32 ms (median of 5)
speedup: 323x
114 114 117 113 112 ms
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch22`（提交 `4628975`）。改动共 24 个文件，`git diff --shortstat ch21 ch22` 给出 `24 files changed, 1477 insertions(+), 19 deletions(-)`。新增的有 `src/sift/analytics/` 下的 5 个文件（`vectors.py` 是 TF-IDF 矩阵和余弦相似度，`stats.py` 是 pandas 表和齐夫、希普斯的拟合，`plots.py` 是四张图，`report.py` 是 `sift report`，外加一个 `__init__.py`）、`tests/test_analytics.py`，以及 `lab/ch22/` 下的 12 个脚本加 `extra.sh`。改写的有 `src/sift/cli.py`（多了 `sift similar` 和 `sift report`；`sift bench search` 现在也把查询写进日志；`log_or_warn` 把 `sift search` 里“写日志，失败只警告”那一段抽了出来）、`pyproject.toml`（多了 `data` 可选依赖）、`flake.nix`（开发环境多了 `pandas-stubs`）、`README.md` 和 `tests/test_cli.py`。
> 后面的章节里，下一篇做性能剖析和优化；这一篇量到的 `tfidf_matrix` 构建时间（冷启动第一次 1036 毫秒，之后每次约 152 毫秒，而 `matrix @ vector` 只要 1.2 毫秒左右）是个现成的候选，我这一篇没有动它。
> 涉及的 Python 与库的特性：ndarray 的内存模型（dtype、shape、strides、视图与副本）、NumPy 2 的类型提升、广播、通用函数、`@`、`np.random.default_rng`、`np.polyfit`、pandas 的 `.loc` 与 `.iloc`、`groupby`、`merge`、`pivot_table`、`resample`、`read_sql`、pandas 3 的写时复制、matplotlib 的 `Figure` 与 `Axes`、对数坐标、CJK 字体、`Agg` 后端、pandas-stubs 与 pyright 指令、Python 3.14 的延迟注解。
> 前置：[第 21 篇](/posts/python-by-sift-21-pyside6/)。分词（[第 2 篇](/posts/python-by-sift-02-text-and-unicode/)）、索引和查询日志（[第 13 篇](/posts/python-by-sift-13-sqlite-sqlalchemy/)）都不动，这一篇只在它们外面加一层分析。

## 环境

和前几篇同一台机器，仓库在标签 `ch22`，命令都在 `nix develop` 里、仓库根目录下跑。三个库是开发环境里现成的，装到普通环境用 `pip install 'sift[data]'`，`pyproject.toml` 的 `data` 额外依赖是这样写的：

```toml
data = [
  "numpy>=2.5",
  "pandas>=3.0",
  "matplotlib>=3.11",
]
```

版本、BLAS 和字体我都查了一遍：

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ git describe --tags; git rev-parse --short HEAD
ch22
4628975
$ lscpu | sed -n '/Model name/p;/^CPU(s):/p'
CPU(s):                                  16
Model name:                              AMD Ryzen 7 PRO 6850U with Radeon Graphics
$ python3 -c "import importlib.metadata as m; [print(n, m.version(n)) for n in ('numpy', 'pandas', 'matplotlib', 'pandas-stubs', 'fonttools')]"
numpy 2.5.1
pandas 3.0.4
matplotlib 3.11.1
pandas-stubs 3.0.3.260530
fonttools 4.63.0
$ python3 -c "import ctypes; f = ctypes.CDLL('/nix/store/bw1pyf3q5xagajh247fla11gv80ggarr-blas-3/lib/libblas.so.3').openblas_get_config; f.restype = ctypes.c_char_p; print(f().decode())"
OpenBLAS 0.3.33 DYNAMIC_ARCH NO_AFFINITY USE_OPENMP Zen MAX_THREADS=64
$ echo $SIFT_CJK_FONT | sed 's#.*/nix/store/[a-z0-9]*-##'
noto-fonts-cjk-sans-2.004/share/fonts/opentype/noto-cjk/NotoSansCJK-VF.otf.ttc
```

`fonttools` 不是 Sift 的依赖，是开发环境里带的，后面读字体的轴用。BLAS 那一行是 numpy 实际加载的 `libblas.so.3` 自己报的：OpenBLAS 0.3.33，OpenMP 版，这台 16 线程的机器上默认开 16 个线程，后面解释 74 倍和 344 倍的差时要用。

这台机器的 CPU 有快慢两个状态（第 11 篇测到过约 2.5 倍），以 CPU 为主的计时前后我各夹一次 `cpu_state.py`（第 12 篇贴过的固定忙循环，快状态下 5 个数在 110 到 120 毫秒）。这一篇夹过的读数都在 112 到 118 之间。但开头的 74 倍说明：`cpu_state.py` 只测解释器的单线程速度，量不出 BLAS 线程池的状态，这是两件事。

实验脚本在仓库的 `lab/ch22/`；我为了追问题写的草稿放在 `/tmp/sift-scratch/ch22/final/`，不进仓库：短的我贴全文，只做几次 `print` 的只写它算什么、贴输出。`lab/ch22` 的脚本不读 `SIFT_INDEX`，它们调 `cli.py` 里的 `load_index`，从 `corpus/posts` 重新读文件、分词、建内存索引（被 `@timed` 装饰，每次往 stderr 打一行 `load_index took ... ms`，约 2 秒，文中滤掉）。`sift similar`、`sift report` 和 `sift bench search` 读磁盘上的索引：先建一份，再跑 5 遍 `sift bench search`，让查询日志里有 60 条（12 条查询乘 5 次）：

```text
$ SIFT_INDEX=/tmp/sift-scratch/ch22/idx sift index --corpus corpus/posts
documents: 123
vocabulary: 81167
full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took 3102.7 ms
$ export SIFT_INDEX=/tmp/sift-scratch/ch22/idx
$ for i in 1 2 3 4 5; do sift bench search > /dev/null; done
```

## ndarray：一块内存和一套读法

先把 numpy 的核心说清楚，因为后面每一步都靠它。我从一个量得出来的数说起：一行 TF-IDF 向量有 81167 个分量，存成 float32 的 ndarray 是 324,668 字节，同样的数存成 Python 的 `list`，是多少？草稿 `mem.py` 造一个这样的数组，`tolist()` 转成列表，用 `sys.getsizeof` 加上每个元素对象的大小，再取一个步长为 2 的切片看它的 `base`：

```text
$ python3 /tmp/sift-scratch/ch22/final/mem.py
ndarray: 324668 bytes of data, 324780 in all
list: 649392 bytes of pointers, 1948008 bytes of floats
ratio 8.0x
row.base is None: True
view.base is row: True, owndata False
view strides (8,), contiguous False
```

`list` 存的是指针，一个 8 字节，每个指针后面还有一个 24 字节的 Python `float` 对象（`1948008 / 81167` 正好是 24）。ndarray 存的就是数本身，一个 4 字节，紧挨着放。所以同样的数据，列表是 ndarray 的 8.0 倍，而且 `sum` 之类的循环要一个对象一个对象地解引用。`sys.getsizeof(row)` 比数据多出的 112 字节是 ndarray 对象自己的头：数据指针、dtype、形状、步长、标志位。

这个头就是 ndarray 的全部秘密：**一块连续的内存，加上一套读它的办法**。读法由四样东西给出：`dtype`（每个元素几个字节、怎么解释）、`shape`（每一维多长）、`strides`（沿每一维走一步，在内存里跳几个字节）和一个起始地址。任何元素的位置是 $\text{base} + \sum_k i_k \cdot \text{strides}_k$。这像一栋楼的门牌：楼没变，换一套编号规则，同一间屋子就有了另一个号码。我用 `ndarray_basics.py` 把这件事跑了一遍：

```text
$ python3 lab/ch22/ndarray_basics.py
a = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]]
dtype int32, itemsize 4, shape (3, 4)
strides (16, 4) (bytes to the next row, next column)
nbytes 48 = size 12 * itemsize 4
a.T is a view: shares_memory True
a.T strides (4, 16), C-contiguous False
a[1] strides (4,), a[:, 1] strides (16,)
row[0] = 100 wrote through: a[1, 0] is 100
a[[0, 2]] shares memory: False
a[a > 5] shares memory: False
changing the copy leaves a[0, 0] at 0
a.copy() shares memory: False
a.ravel() on C order is a view: True
t.ravel() has to copy: True
uint8 wraps: 200 + 100 -> [44]
astype(float32) copies: [100.0, 200.0]
norm(u) = 5.0, m @ u = [-4.0, 3.0]
u @ u = 25.0 (the dot product), u * u = [9.0, 16.0]
```

一行一行读。`a` 是 3×4 的 int32，`itemsize` 4，所以步长是 `(16, 4)`：沿列走一步跳 4 字节，沿行走一步跳 4 列即 16 字节。`a.T`（转置）没有搬一个字节，只是把步长换成 `(4, 16)`，`shares_memory` 是 `True`，同时它不再是 C 连续的了：沿内存顺序读它，要在行之间跳。`a[1]`（一行）的步长是 `(4,)`，`a[:, 1]`（一列）是 `(16,)`，同一块内存，两种读法。

切片得到的是视图，所以 `row[0] = 100` 直接写穿到了 `a`。而用整数列表（`a[[0, 2]]`）或布尔掩码（`a[a > 5]`）取元素，结果没法用一套步长描述，numpy 只能复制：`shares_memory` 都是 `False`，改副本不影响 `a`。`ravel()` 在 C 连续的 `a` 上返回视图，在转置的 `t` 上只能复制（输出里 `t.ravel() has to copy` 是 `True`）。判断一个操作是视图还是副本，不要靠猜，`np.shares_memory` 或者 `.base` 和 `.flags.owndata` 一查便知，上面 `mem.py` 里的 `row[::2]` 就是这样：`base` 是 `row`，不拥有数据，步长 `(8,)` 即跳着读，所以不是连续的。

这也是后面 `similar` 里 `matrix[row]` 不复制 81167 个数的原因：取一行是视图，`matrix @ matrix[row]` 读的是原来那块 38.1 MiB 的内存。

### dtype：整数会回绕，NumPy 2 对标量更严

输出里有一行容易被略过：`uint8 wraps: 200 + 100 -> [44]`。8 位无符号整数装不下 300，numpy 默默回绕成 `300 - 256 = 44`。这是数组运算的行为，为了速度不检查溢出。标量运算在 NumPy 2 里要啰嗦一点，我写了一个草稿看：

```python
import warnings

import numpy as np

with warnings.catch_warnings(record=True) as caught:
    warnings.simplefilter("always")
    print(repr(np.uint8(200) + np.uint8(100)))
print([w.category.__name__ for w in caught])
try:
    np.uint8(200) + 300
except OverflowError as error:
    print("np.uint8(200) + 300 ->", error)
for left, right in [(np.float32(1), 1.0), (np.float32(1), np.float64(1))]:
    total = left + right
    print(f"{type(left).__name__} + {type(right).__name__} -> {total.dtype}")
print(np.iinfo(np.int32).max, np.finfo(np.float32).max)
```

```text
$ python3 /tmp/sift-scratch/ch22/final/nep50.py
np.uint8(44)
['RuntimeWarning']
np.uint8(200) + 300 -> Python integer 300 out of bounds for uint8
float32 + float -> float32
float32 + float64 -> float64
2147483647 3.4028235e+38
```

两个 `uint8` 标量相加仍然回绕成 44，但多了一个 `RuntimeWarning`。更有意思的是第二行：`np.uint8(200) + 300`，300 是个 Python `int`，装不进 `uint8`，直接 `OverflowError`。这是 NumPy 2 的类型提升规则（NEP 50）：Python 的 `int` 和 `float` 是“弱”类型，它们去适应 numpy 标量的 dtype，而不是反过来把结果提升到更宽的类型。所以 `np.float32(1) + 1.0` 仍是 `float32`，只有两个 numpy 类型才按宽度提升（`float32 + float64` 得 `float64`）。这条规则让 float32 的程序不会因为写了个 `1.0` 字面量就悄悄变成 float64，对 `tfidf_matrix` 全程保持 float32 很要紧，后面会看到它的写法。

## 广播、通用函数、`@` 与随机数

ndarray 的运算有一条总规则：**不写循环**。`a + b`、`np.log(a)`、`a @ b` 都是对整块内存做一遍的 C 循环。这一节是几件工具，后面的 `tfidf_matrix` 一行一行都用得上。

### 广播

两个形状不同的数组相加，numpy 把它们的形状右对齐，每一维要么相等，要么有一个是 1（或者缺这一维），为 1 的那一维被“拉长”到另一个的长度，拉长不复制数据（步长设成 0）。`broadcasting.py` 前半是这样：

```text
$ python3 lab/ch22/broadcasting.py
column shape (3, 1), row shape (4,)
column * 10 + row -> shape (3, 4)
[[0, 1, 2, 3], [10, 11, 12, 13], [20, 21, 22, 23]]
(3, 1) with (4,) -> (3, 4)
(2, 3, 4) with (3, 1) -> (2, 3, 4)
(5,) with (1,) -> (5,)
column means after centering: [-0. -0. -0.]
column std after scaling: [1. 1. 1.]
sqrt where x >= 0: [1.0, 2.0, 3.0, 0.0]
np.add.reduce(x) = 13.0, x.sum() = 13.0
np.maximum.accumulate: [1.0, 4.0, 9.0, 9.0]
```

`column` 是 `(3, 1)`，`row` 是 `(4,)`，右对齐后是 `(3, 1)` 对 `(1, 4)`，两边各自拉长，得到一张 `(3, 4)` 的表：行号乘 10 加列号。不用 `for`，不造 `(3, 4)` 的中间数组。`np.broadcast_shapes` 可以直接问形状，不用真的建数组。

真正有用的是“去均值”：`data - data.mean(axis=0)`，`data` 是 `(5, 3)`，均值是 `(3,)`，右对齐后每一行都减去同一个均值向量。输出里 `column means after centering` 是 `[-0. -0. -0.]`：不是精确的 0，而是舍入后的极小负数，打印时 `round(12)` 把它抹成了 `-0.`。这提醒我：浮点数的结果永远不要用 `==` 去比，后面验证 TF-IDF 时我用的都是差的最大值。

形状对不上，numpy 直接报错，而不是猜：

```text
$ python3 lab/ch22/broadcast_fail.py; echo "exit $?"
left (3,), right (4,)
Traceback (most recent call last):
  File "/home/bfmhno3/Projects/sift/lab/ch22/broadcast_fail.py", line 16, in <module>
    main()
    ~~~~^^
  File "/home/bfmhno3/Projects/sift/lab/ch22/broadcast_fail.py", line 12, in main
    print(left + right)
          ~~~~~^~~~~~
ValueError: operands could not be broadcast together with shapes (3,) (4,)
exit 1
```

这个脚本故意失败，退出码 1。`(3,)` 对 `(4,)`，3 和 4 既不相等也没有 1，没有合理的拉法。这个报错是你的朋友：广播最危险的不是报错，而是形状恰好能广播、含义却不对，比如本想逐元素相减，结果 `(n,)` 减 `(n, 1)` 悄悄变成了 `(n, n)` 的外差。写 `keepdims=True`、写明 `axis=`，是我自己防这件事的办法。

### 通用函数

`np.sqrt`、`np.log`、`np.add` 这些叫通用函数（ufunc），对数组逐元素算。它们有几个别的函数没有的参数：`out=` 把结果写进已有的数组，`where=` 只算条件为真的位置，`dtype=` 指定内部计算的类型。输出里 `sqrt where x >= 0` 一行：`x` 里有个 `-1.0`，`np.sqrt(x, out=out, where=x >= 0)` 跳过它，`out` 在那个位置保持原来的 0.0。必须给 `out=`：numpy 文档写明，不给 `out=` 时，`where` 为假的位置是未初始化的，里面是什么都有可能。

ufunc 还是一个对象，有方法。`np.add.reduce(x)` 和 `x.sum()` 是同一件事（求和就是用加法归约），`np.maximum.accumulate(x)` 给出“到目前为止的最大值” `[1.0, 4.0, 9.0, 9.0]`，`np.add.accumulate` 就是 `cumsum`。后面算词汇增长时，`np.cumsum` 就是这样一条累加。

### `@`、范数与余弦

`@` 是矩阵乘法。两个一维数组的 `@` 是点积，二维对一维是矩阵乘向量，二维对二维是矩阵乘矩阵。`ndarray_basics.py` 的最后一行把它和逐元素的 `*` 摆在一起：`u @ u = 25.0` 是点积，`u * u = [9.0, 16.0]` 是逐元素乘，差一个 `sum`。`m @ u = [-4.0, 3.0]` 里的 `m = [[0, -1], [1, 0]]` 是转 90 度的矩阵，`u = (3, 4)` 变成了 `(-4, 3)`，长度 `np.linalg.norm(u) = 5.0` 不变。

两个向量的夹角余弦是 $\cos\theta = \dfrac{a \cdot b}{\lVert a \rVert \, \lVert b \rVert}$。如果每个向量事先除过自己的范数（长度变成 1），余弦就等于点积，于是“一篇文章对全部文章的余弦”就是一次 `matrix @ vector`，“全部对全部”是一次 `matrix @ matrix.T`。后面的 `similar` 和 `top_pairs` 就是这两句话。

### 随机数：`default_rng`

`broadcasting.py` 用 `rng = np.random.default_rng(1234)` 造数据。`default_rng` 返回一个 `Generator`，里面的比特流是 `PCG64`。同一个种子给出同一串数，`spawn` 可以从一个种子派生出彼此独立的流，不用自己去想“给第二个流用种子几”。草稿 `rng.py` 用 `default_rng(1234)` 抽两次 5 个整数，再 `default_rng(7).spawn(2)` 各抽 2 个浮点数：

```text
$ python3 /tmp/sift-scratch/ch22/final/rng.py
[97, 97, 98, 38, 17]
[97, 97, 98, 38, 17]
[0.798, 0.053] [0.481, 0.06]
Generator PCG64
```

前两行相同，这是可复现实验的底线。我在 `lab/ch22` 里每次造随机数据都带固定种子，没有用 `np.random.seed` 那个全局接口：全局状态让两个脚本互相影响，`Generator` 对象是自己的状态，传给谁谁用。

## 把语料变成矩阵：`tfidf_matrix`

现在回到 Sift。每个文档变成一个向量，一个词（词项）占一维，分量是这个词对这篇文章的权重。权重用 TF-IDF：

$$w_{t,d} = \bigl(1 + \ln \mathrm{tf}_{t,d}\bigr) \cdot \Bigl(\ln\frac{1 + N}{1 + \mathrm{df}_t} + 1\Bigr)$$

$\mathrm{tf}_{t,d}$ 是词 $t$ 在文章 $d$ 里出现的次数，取对数是为了让出现 100 次不比出现 10 次重要 10 倍；$\mathrm{df}_t$ 是含这个词的文章数，$N$ 是文章总数，常见词的第二项小，罕见词的第二项大。每一行最后除以自己的 L2 范数。这里的词项就是第 2 篇的分词器出的词项：西文按词，中文按相邻两字（二元组），所以“行图”“列图”会各自是一个维度。

`TermIndex` 是矩阵函数对索引的要求。它在 `IndexView`（第 14 篇的 Protocol）上加了“能遍历词项、能按词项取倒排表”，内存里的 `InvertedIndex` 和磁盘上的 `SegmentIndex` 都满足：

```python
class TermIndex(IndexView, Protocol):
    """An IndexView that also lists its terms and their postings.

    InvertedIndex and SegmentIndex both conform.
    """

    def __iter__(self) -> Iterator[str]:
        """Iterate over the terms."""
        ...

    def __getitem__(self, term: str, /) -> PostingList:
        """Return the postings of term."""
        ...
```

函数本体 32 行，是这一篇最该一行一行读的代码：

```python
def tfidf_matrix(index: TermIndex) -> tuple[NDArray[np.float32], list[str]]:
    """Return ``(matrix, vocab)`` for the live documents of index.

    Row i belongs to ``sorted(index.documents)[i]`` and column j to
    ``vocab[j]``. Rows are L2-normalized; the row of a document
    without terms stays all zero.
    """
    doc_ids = sorted(index.documents)
    row_of = {doc_id: row for row, doc_id in enumerate(doc_ids)}
    vocab: list[str] = []
    rows: list[int] = []
    cols: list[int] = []
    freqs: list[int] = []
    for term in sorted(index):
        before = len(rows)
        for posting in index[term]:
            row = row_of.get(posting.doc_id)
            if row is not None:
                rows.append(row)
                cols.append(len(vocab))
                freqs.append(posting.tf)
        if len(rows) > before:
            vocab.append(term)
    col = np.asarray(cols, dtype=np.intp)
    tf = np.asarray(freqs, dtype=np.float32)
    df = np.bincount(col, minlength=len(vocab)).astype(np.float32)
    idf = np.log((1 + len(doc_ids)) / (1 + df), dtype=np.float32) + 1
    matrix = np.zeros((len(doc_ids), len(vocab)), dtype=np.float32)
    matrix[np.asarray(rows, dtype=np.intp), col] = (1 + np.log(tf)) * idf[col]
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    np.divide(matrix, norms, out=matrix, where=norms > 0)
    return matrix, vocab
```

分三段。**第一段**是纯 Python：`sorted(index.documents)` 给出活着的文档（被删除的文档倒排表里可能还有残留，`row_of.get(...)` 返回 `None` 就跳过），然后对每个词项、每条倒排记录，往三个列表里各追加一个数：行号、列号、词频。这是稀疏矩阵的“坐标格式”（COO）：三个等长的数组，第 $k$ 个非零元素在 `(rows[k], cols[k])`，值是 `freqs[k]`。`if len(rows) > before` 保证只有真有活文档的词才占一列。

**第二段**是 numpy，没有一个 Python 循环。`np.asarray(cols, dtype=np.intp)` 把列表一次转成整数数组（`intp` 是指针宽度的整数，做下标最合适）。`np.bincount(col, minlength=len(vocab))` 数每个列号出现几次，也就是每个词项的文档频率 $\mathrm{df}$；`astype(np.float32)` 转成浮点。`idf` 那一行把标量 `(1 + len(doc_ids))` 对数组 `(1 + df)` 广播，`dtype=np.float32` 在这里没有改变结果，`(1 + df)` 已经是 float32，`np.log` 默认也给 float32；它把“必须是 float32”写进了代码，因为 `np.log` 对整数数组会给 float64（我查过 `np.log(np.arange(3) + 1).dtype` 是 `float64`），将来有人把 `df` 改成整数就会悄悄变宽。

**第三段**是整个函数的核心一句：`matrix[rows, col] = (1 + np.log(tf)) * idf[col]`。左边是“花式下标赋值”（给定两个整数数组，同时写入这些 `(行, 列)` 位置），右边 `idf[col]` 是花式下标取值，给每条倒排记录取到它的词项的 idf，再乘上这条记录的 $1 + \ln \mathrm{tf}$。整个矩阵 `np.zeros((123, 81167), dtype=np.float32)` 先铺好，非零的位置一次写入。

最后两行归一化。`np.linalg.norm(matrix, axis=1, keepdims=True)` 对每一行求范数，`keepdims=True` 让结果是 `(123, 1)` 而不是 `(123,)`，这样它才能和 `(123, 81167)` 的矩阵广播。`np.divide(matrix, norms, out=matrix, where=norms > 0)` 原地相除，`out=matrix` 不再分配 38.1 MiB 的新数组，`where=norms > 0` 跳过没有任何词的空文档（那一行保持全零，而不是除以零得到一排 `nan`）。这一行把上一节的广播、`out=` 和 `where=` 同时用上了。

### 手算一行核对

我不愿意光信函数。写了一个草稿，用 `math.log` 对文档 24 的每个词项各算一遍权重，自己归一化，再和矩阵的那一行比：

```python
"""Recompute one TF-IDF row with math.log and compare with the matrix."""

import math

import numpy as np

from sift.analysis import build_pipeline
from sift.analytics.vectors import tfidf_matrix
from sift.cli import load_index
from sift.config import load_config

config = load_config()
_, index = load_index(config.corpus, build_pipeline(config.pipeline))
matrix, vocab = tfidf_matrix(index)
doc_ids = sorted(index.documents)
n = len(doc_ids)
DOC = 24
weights: dict[str, float] = {}
for term in vocab:
    postings = index[term]
    for posting in postings:
        if posting.doc_id == DOC:
            idf = math.log((1 + n) / (1 + len(postings))) + 1
            weights[term] = (1 + math.log(posting.tf)) * idf
length = math.sqrt(sum(w * w for w in weights.values()))
expected = np.zeros(len(vocab))
for term, w in weights.items():
    expected[vocab.index(term)] = w / length
row = matrix[doc_ids.index(DOC)]
print(
    f"doc {DOC}: {len(weights)} terms, row length before scaling {length:.2f}"
)
print(f"largest difference: {np.abs(row - expected).max():.2e}")
top = np.argsort(-row)[:5]
print([(vocab[j], round(float(row[j]), 4)) for j in top])
```

```text
$ python3 /tmp/sift-scratch/ch22/final/tfidf_check.py 2>&1 | grep -v '^load_index took'
doc 24: 1583 terms, row length before scaling 180.14
largest difference: 8.75e-09
[('行图', 0.0896), ('列图', 0.0867), ('ax2', 0.077), ('kw', 0.0743), ('m_dup', 0.0743)]
```

文档 24 是《18.06 第 1 讲：方程组的行图与列图》，权重最高的两个维度正是标题里的“行图”和“列图”，后面是代码里的变量名 `ax2`、`kw`、`m_dup`。float64 手算和 float32 的矩阵最大差 $8.75 \times 10^{-9}$，在 float32 的精度之内（单个分量 0.09，机器精度约 $1.2 \times 10^{-7}$）。这一行有 1583 个非零分量，整个矩阵呢？

### 这个矩阵 97% 是零

草稿 `density.py` 用 `np.count_nonzero` 数矩阵里的非零元素，并估计只存非零（4 字节的值加 4 字节的列号）要多少内存：

```text
$ python3 /tmp/sift-scratch/ch22/final/density.py 2>&1 | grep -v '^load_index took'
(123, 81167), 289357 nonzero of 9983541 (2.90%)
dense 38.1 MiB, value + column index per nonzero 2.2 MiB
```

九百九十八万个格子里只有 28.9 万个非零，占 2.90%。稠密存 38.1 MiB；只存非零（每个一个 4 字节的值加一个 4 字节的列号）大约 2.2 MiB，这是我算的估计，不是真的稀疏矩阵的大小。这个规模下稠密矩阵撑得住，一次 `matrix @ vector` 只要 1 毫秒多；真要上万篇文章，`scipy.sparse` 才是正确的数据结构。它不在这个项目的工具集里，我没装，留作练习 2。

### 构建矩阵比乘它贵得多

```text
$ python3 /tmp/sift-scratch/ch22/final/cold_warm.py
call 1:  1036.3 ms
call 2:   152.2 ms
call 3:   153.9 ms
$ python3 /tmp/sift-scratch/ch22/final/build_cost.py
open_index     127.7 ms
tfidf_matrix   152.6 ms
matrix @ row     1.17 ms
similar(0)     162.9 ms
top_pairs      178.8 ms
$ time sift similar 0 > /dev/null
real 1.648s
```

这几个数一起读才有意思。`cold_warm.py` 打开磁盘上的索引（`SegmentIndex`），连续调三次 `tfidf_matrix`：第一次 1036 毫秒，之后 152 毫秒上下。差的 0.9 秒是第一次要把 81167 条倒排表从段文件里解出来（`SegmentIndex.__getitem__` 有缓存，所以第二次不用了）；我拿 `cProfile` 看过一次 `sift similar 0`，`store.py` 的 `__getitem__` 占了大头。热了以后，`tfidf_matrix` 是 152.6 毫秒，而乘一次只要 1.17 毫秒，`similar(0)` 162.9 毫秒其实几乎全是构建。`top_pairs` 比构建多出的 26 毫秒是那个 123×123 的 `matrix @ matrix.T` 和排序。命令行里 `sift similar 0` 总共 1.648 秒：解码倒排表、构建、打开索引、加载 numpy，每次进程都重来一遍。

所以“numpy 比纯 Python 快几百倍”只对乘法这一步成立；整条命令的瓶颈在乘法之前，在 Python 的循环里，这是下一篇才轮到的话题。

## `similar` 与 `top_pairs`

乘法本身只有几行：

```python
def similar(
    index: TermIndex, doc_id: int, k: int = 5
) -> list[tuple[int, float]]:
    """Return the k documents closest to doc_id as ``(doc_id, score)``.

    The score is the cosine of the TF-IDF vectors, from 1.0 down to 0.0.
    The document itself comes first (score 1.0); ties keep doc_id
    order. Raise ValueError if k < 1 and SiftError if doc_id is not
    a live document.
    """
    if k < 1:
        raise ValueError(f"k must be at least 1, not {k}")
    doc_ids = sorted(index.documents)
    try:
        row = doc_ids.index(doc_id)
    except ValueError:
        raise SiftError(f"no document with id {doc_id}") from None
    matrix, _ = tfidf_matrix(index)
    scores = np.clip(matrix @ matrix[row], 0.0, 1.0)
    best = np.argsort(-scores, kind="stable")[:k]
    return [(doc_ids[i], float(scores[i])) for i in best]


def top_pairs(index: TermIndex, n: int = 5) -> list[tuple[int, int, float]]:
    """Return the n most similar pairs ``(doc_a, doc_b, score)``.

    Each pair appears once, with doc_a < doc_b, best first.
    """
    doc_ids = sorted(index.documents)
    matrix, _ = tfidf_matrix(index)
    cosines = np.clip(matrix @ matrix.T, 0.0, 1.0)
    first, second = np.triu_indices(len(doc_ids), k=1)
    best = np.argsort(-cosines[first, second], kind="stable")[:n]
    return [
        (
            doc_ids[first[i]],
            doc_ids[second[i]],
            float(cosines[first[i], second[i]]),
        )
        for i in best
    ]
```

`matrix @ matrix[row]` 一句话给出这篇文章对全部 123 篇的余弦。`np.clip(..., 0.0, 1.0)` 保证返回值落在文档承诺的 $[0, 1]$ 里：TF-IDF 的分量非负，点积不会是负的，所以下界其实用不上，上界是为 float32 归一化的舍入留的，一篇文章对自己的余弦未必恰好是 1.0。`np.argsort(-scores, kind="stable")[:k]` 取分数最高的 k 个：对负分数升序排就是对分数降序，`stable` 保证并列时保持 doc_id 顺序，所以输出可复现。最后 `float(scores[i])` 把 `np.float32` 转成 Python 的 `float`，调用方（命令行、JSON、类型检查器）看到的是普通类型。

`top_pairs` 要“全部对全部”：`matrix @ matrix.T` 是 123×123 的余弦表；它对称，对角线全是 1，我只要对角线上方的三角，`np.triu_indices(len(doc_ids), k=1)` 给出这 $123 \times 122 / 2 = 7503$ 对的行号数组和列号数组，`cosines[first, second]` 一次取出，再 `argsort`。

命令行里的 `sift similar`（`cli.py` 871 到 898 行）只是把结果一行一行打出来：

```text
$ sift similar 0
1.0000     0  ARMv7-A 指令体系全解：数据处理、访存、分支与同步
0.1905    11  GNU 汇编（GAS）通用语法与伪指令指南
0.1172    10  从暂停到理解：GDB 调试完整实践
0.1116    93  C++ 中的 stack
0.1014   115  一台不存在的计算机：QEMU 工作原理与实践
$ sift similar 18 -k 3
1.0000    18  扩展卡尔曼滤波：把四元数塞进 EKF
0.4701    19  误差状态卡尔曼滤波：四元数的正确打开方式
0.3710    20  无迹卡尔曼滤波，以及四个滤波器同台
```

第一行永远是文章自己，分数 1.0000（`tests/test_analytics.py` 里 `test_a_document_is_most_similar_to_itself` 钉的就是这一条）。文章 0 的近邻是汇编、GDB、C++ 和 QEMU，都是底层系统的文章，合理。文章 18 的近邻是它的卡尔曼系列里的邻居。我另外写了 `similar_demo.py`，看一篇文章的前 4 个近邻（脚本里还有 Rust 和 Typst 各一篇，我这里略去），和语料里最近的五对：

```text
$ python3 lab/ch22/similar_demo.py 2>&1 | grep -v '^load_index took'

扩展卡尔曼滤波：把四元数塞进 EKF (id 18)
  0.470  误差状态卡尔曼滤波：四元数的正确打开方式
  0.371  无迹卡尔曼滤波，以及四个滤波器同台
  0.347  移植之前：float32、定长内存与每步耗时
  0.338  姿态的数学：旋转、四元数与 IMU 仿真器

closest pairs in the corpus
  0.470  扩展卡尔曼滤波：把四元数塞进 EKF  <->  误差状态卡尔曼滤波：四元数的正确打开方式
  0.428  误差状态卡尔曼滤波：四元数的正确打开方式  <->  无迹卡尔曼滤波，以及四个滤波器同台
  0.398  Result、? 与递归下降：解析器和第一个命令行  <->  树遍历解释器：闭包、控制流与一个内存泄漏
  0.383  误差状态卡尔曼滤波：四元数的正确打开方式  <->  移植之前：float32、定长内存与每步耗时
  0.382  树遍历解释器：闭包、控制流与一个内存泄漏  <->  栈式虚拟机：GC 根、两个后端与 Criterion
```

这些近邻我看了觉得合理（略去的 Rust 那篇，近邻也全是同一个 Rust 系列）。我用 `top_pairs` 加 `corpus_frame` 的 `series` 列（草稿 `pair_series.py`，每一对比较两篇的 `series` 是否相等）把最近的五对查了一遍：

```text
$ python3 /tmp/sift-scratch/ch22/final/pair_series.py 2>&1 | grep -v '^load_index took'
0.470  18  19 same series: True
0.428  19  20 same series: True
0.398  84  86 same series: True
0.383  19  21 same series: True
0.382  86  89 same series: True
doc_id
18       卡尔曼滤波：从一维到三维姿态
84    用 Pebble 从零学 Rust
```

五对全在同一个系列里（18 到 21 是卡尔曼系列，84、86、89 是 Pebble 的 Rust 系列）。

要小心的是分数本身。最高只有 0.470，文章 0 的第二名只有 0.19：余弦“大”在这个语料上不是 0.9，而是 0.3 到 0.5。原因我猜有两个，都跟词项有关：中文按二元组切，一篇文章有一千多个维度非零，其中大半是偶然的二字组合（“律描”这样的），它们几乎只在一篇文章里出现，对余弦只贡献分母；而同一个系列共享的词项（“卡尔曼”“四元数”）只占一小部分。所以我把这些分数当成排序用，不当成“相似程度”的绝对值。换一个分词器（第 24、25 篇的 `--tokenizer`）会不会拉开差距，是个可以实验的问题。

## 向量化到底省了多少

开头那个 74 到 344 倍，现在可以认真看了。`vectorize_speedup.py` 用同一个矩阵比两种写法：纯 Python 对每一行做 `sum(a * b for a, b in zip(row, target))`，和 numpy 的 `matrix @ matrix[0]`。

```python
def main() -> None:
    """Cosine of one document against all, in Python and in numpy."""
    config = load_config()
    _, index = load_index(config.corpus, build_pipeline(config.pipeline))
    matrix, vocab = tfidf_matrix(index)
    rows = matrix.tolist()
    target = rows[QUERY_ROW]
    print(f"{len(rows)} documents x {len(vocab)} terms")

    def python_loop() -> list[float]:
        return [
            sum(a * b for a, b in zip(row, target, strict=True))
            for row in rows
        ]

    def numpy_matvec() -> np.ndarray:
        return matrix @ matrix[QUERY_ROW]

    slow = python_loop()
    fast = numpy_matvec()
    assert np.allclose(slow, fast, atol=1e-5)
    python_ms = median_ms(python_loop)
    numpy_ms = median_ms(numpy_matvec)
    print(f"pure Python: {python_ms:9.2f} ms (median of {ROUNDS})")
    print(f"numpy @:     {numpy_ms:9.2f} ms (median of {ROUNDS})")
    print(f"speedup: {python_ms / numpy_ms:.0f}x")
```

先对账。123 行乘 81167 列是 9,983,541 次乘加，纯 Python 430.92 毫秒，每次 43 纳秒：一个生成器每步取两个元素、乘、交给 `sum` 加，每一步都是对象，都经过解释器。`matrix.tolist()` 在计时之外，它把 float32 都拆成了 Python 的 `float`，所以这个比较对纯 Python 已经够宽松了：它不用付把数据装进列表的代价。

numpy 这一边，38.1 MiB 在 1.25 毫秒里被读完，约 30 GiB/s。这是内存带宽的量级了，这一步已经不在“算”，而在“读”。我另量了一个基线：`matrix.sum()`（numpy 单线程把同样的 38.1 MiB 读一遍加起来）是 2.3 毫秒。`@` 比它快，我猜是因为 BLAS 把行分给了多个线程，后面限线程的实验支持这一点。

### 74 倍是怎么来的

第二遍的 5.99 毫秒不是 `@` 变慢了一点点，而是慢了 4 到 5 倍。我先怀疑是 CPU 掉进了慢状态，但夹着的 `cpu_state.py` 一直是 112 到 118；再怀疑是缓存或内存带宽，所以写了一个小探针，同时量 `matrix @ vector` 和 `matrix.sum()`：

```python
"""Median ms of matrix @ vector and of matrix.sum() (a bandwidth probe)."""

import statistics
import time

import numpy as np

rng = np.random.default_rng(1)
matrix = rng.random((123, 81167), dtype=np.float32)
vector = matrix[0].copy()


def median_ms(run) -> float:
    times = []
    for _ in range(40):
        start = time.perf_counter_ns()
        run()
        times.append((time.perf_counter_ns() - start) / 1e6)
    return statistics.median(times)


mv = median_ms(lambda: matrix @ vector)
sm = median_ms(lambda: matrix.sum())
gib = matrix.nbytes / 2**30
print(f"matvec {mv:5.2f} ms ({gib / mv * 1000:5.1f} GiB/s)  sum {sm:5.2f} ms")
```

不钉核心、连跑 6 次，第二次就中了：

```text
$ for i in 1 2 3 4 5 6; do python3 /tmp/sift-scratch/ch22/final/matvec_probe.py; done
matvec  1.24 ms ( 30.0 GiB/s)  sum  2.39 ms
matvec  6.00 ms (  6.2 GiB/s)  sum  2.33 ms
matvec  1.12 ms ( 33.3 GiB/s)  sum  2.41 ms
matvec  1.30 ms ( 28.5 GiB/s)  sum  2.41 ms
matvec  1.18 ms ( 31.5 GiB/s)  sum  2.32 ms
matvec  1.45 ms ( 25.7 GiB/s)  sum  2.54 ms
```

同一个进程里 `sum` 是 2.33 毫秒，没有变，`matvec` 是 6.00 毫秒。慢的不是内存，是 BLAS 那一次调用。探针报的是 40 次调用的中位数，中位数是 6.00 毫秒，说明这个进程里大多数调用都慢，是整个进程的状态，不是偶尔抖一下。再看它出现的频率和跟线程数的关系。OpenBLAS 是 OpenMP 版，默认 16 个线程，`OMP_NUM_THREADS` 可以限制。每个设置各起 100 个进程，数 `matvec` 中位数超过 3 毫秒的有几个：

```text
$ run() { for i in $(seq 100); do env "$@" python3 /tmp/sift-scratch/ch22/final/matvec_probe.py | awk '{print $2}'; done | sort -n | awk '{a[NR]=$1} END {slow=0; for (i=1;i<=NR;i++) if (a[i]>3) slow++; print "runs", NR, "slow(>3ms)", slow, "fastest", a[1], "median", a[int((NR+1)/2)], "max", a[NR]}'; }
$ run A=1
runs 100 slow(>3ms) 6 fastest 1.15 median 1.34 max 6.00
$ run OMP_NUM_THREADS=1
runs 100 slow(>3ms) 0 fastest 1.34 median 1.48 max 2.05
$ run A=1
runs 100 slow(>3ms) 3 fastest 1.09 median 1.32 max 5.99
$ run OMP_NUM_THREADS=2
runs 100 slow(>3ms) 0 fastest 0.87 median 1.06 max 1.34
```

默认设置下 200 个进程里 9 个是慢档（4.5%），限成 1 个线程或 2 个线程的各 100 个进程里一个都没有。限成 1 个线程中位数是 1.48 毫秒，比 16 线程的 1.32 到 1.34 慢一点，而 2 个线程的中位数 1.06 毫秒反而是最快的，最快一次 0.87。我另外把进程钉在 16 个核心上各跑了一次（`taskset -c N`），1.34 到 1.56 毫秒，没有一个慢档。钉住以后 `openblas_get_num_threads()` 仍然报 16，也就是 16 个线程挤在一个核心上跑：

```text
$ for c in $(seq 0 15); do echo -n "cpu $c: "; taskset -c $c python3 /tmp/sift-scratch/ch22/final/matvec_probe.py; done | sort -k4 -n | sed -n '1p;$p'
cpu 7: matvec  1.34 ms ( 27.7 GiB/s)  sum  2.32 ms
cpu 8: matvec  1.56 ms ( 23.9 GiB/s)  sum  2.31 ms
```

没有哪个核心是“坏核”（每个核心只有一个样本，我也没有多次重复，所以这只能排除“某个核永远慢”）。我对这件事的判断是：这是 OpenMP 线程团队的调度问题，我猜是团队里有一个线程落在了忙核或超线程兄弟上，别的线程在栅栏处等它，一次 `sgemv` 的时间被最慢的线程决定；一旦这个进程的线程摆成了那个样子，之后每次调用都一样。这只是和数据相容的解释，我没有用 `perf` 或调度跟踪去证实。能说的是三件事：慢档只在 BLAS 用满线程池时出现，限到 1 或 2 个线程我在 200 个进程里没再见到，`cpu_state.py` 量不出它。

最后用 `vectorize_speedup.py` 本身，每组设置各跑 6 次交替着来，这才是开头那个“74 到 344 倍”的完整样子：

```text
$ python3 /tmp/sift-scratch/cpu_state.py
113 113 113 117 114 ms
        default threads            OMP_NUM_THREADS=1          OMP_NUM_THREADS=2
run 1   py 435.19  np 2.06  212x   py 446.83  np 2.14  209x   py 450.19  np 1.26  359x
run 2   py 441.75  np 5.98   74x   py 465.13  np 1.65  281x   py 446.53  np 1.48  301x
run 3   py 440.98  np 1.37  321x   py 438.75  np 1.73  253x   py 458.53  np 1.22  375x
run 4   py 443.15  np 1.27  349x   py 435.80  np 1.93  226x   py 435.77  np 1.30  335x
run 5   py 451.50  np 1.44  313x   py 443.40  np 1.50  296x   py 434.21  np 1.25  347x
run 6   py 459.32  np 1.58  291x   py 455.24  np 1.68  272x   py 440.14  np 1.31  336x
$ python3 /tmp/sift-scratch/cpu_state.py
114 114 114 114 114 ms
```

（表是我把 18 次运行的输出重排成三列的，数没有改。）纯 Python 一列很稳，434 到 465 毫秒，这是解释器的单线程速度，`cpu_state.py` 量的就是它。numpy 一列的变化来自 BLAS：默认 1.27 到 2.06 毫秒，外加一次 5.98 毫秒；1 个线程 1.50 到 2.14；2 个线程 1.22 到 1.48，没有离群值。折成倍数，除了那一次慢档的 74 倍，其余 17 次在 209 到 375 倍之间。我以后引用这个数会写“200 到 375 倍，偶尔 74 倍”，而不写某一个数。

这件事教我的是：**一个比值有两个分母**。分子（纯 Python）是稳的，分母（numpy）是一个藏着线程池的黑盒。报告一个“加速比”之前，要多跑几个进程看分母分不分档，也要问 `cpu_state.py` 能量到的是哪一部分。

## float32 还是 float64

矩阵用 float32 存，是个我当面做过的选择，这里有账。`float32_vs_64.py` 把同一个矩阵转成 float64（在 float64 里重新归一化），比内存、比精度、比排序：

```text
$ python3 lab/ch22/float32_vs_64.py 2>&1 | grep -v '^load_index took'
matrix (123, 81167): 81167 terms
float32 38.1 MiB
float64 76.2 MiB
eps float32 1.192e-07, float64 2.220e-16
0.1 + 0.2 in float32: 0.30000001192092896
0.1 + 0.2 in float64: 0.30000000000000004
largest cosine difference: 7.15e-07
documents whose top-10 differs: 0 of 123
sum of 1e7 float32: 5000560.0
same, summed in float64: 5000560.4
```

内存减半，38.1 对 76.2 MiB。float32 的机器精度是 $1.19 \times 10^{-7}$，所以 `0.1 + 0.2` 在 float32 里是 `0.30000001192092896`（离 0.3 差约 $1.2 \times 10^{-8}$），在 float64 里是熟悉的 `0.30000000000000004`。两个矩阵算出来的全部 $123 \times 123$ 个余弦，最大差 $7.15 \times 10^{-7}$，约 6 个机器精度，我猜这是一行里一千多个非零分量累加的舍入。123 篇文章每一篇的前 10 名，float32 和 float64 的顺序完全一致，0 篇不同。所以对“排序”这个用途，float32 够用。

最后两行是个对照：一千万个 [0, 1) 的 float32 随机数，用 float32 累加得到 5000560.0，用 float64 累加得到 5000560.4，差 0.4，相对误差 $8 \times 10^{-8}$，比我预期的小得多。我又写了个草稿 `pairwise.py`，把“一个一个往后加”也跑出来（`np.cumsum` 是按顺序累加的，不做分组），和 `sum` 的两种宽度对比：

```text
$ python3 /tmp/sift-scratch/ch22/final/pairwise.py
float64 sum        5000560.4
float32 pairwise   5000560.0  (error -0.4)
float32 one by one 5000470.0  (error -90.4)
```

一个一个加的 float32 差了 90.4，是成对求和的 200 多倍。numpy 的 `sum` 把数组分成小块，先块内求和再合并（成对求和），误差只随 $\log n$ 增长，所以“float32 求和会不准”在 `ndarray.sum` 上要打折扣，在手写的累加循环上才全额成立。

速度也跟着内存走。草稿 `dtype_speed.py` 在同样形状（123×81167）的随机矩阵上，各取 40 次 `matrix @ vector` 的中位数，比两种宽度，起 5 个进程：

```text
$ for i in 1 2 3 4 5; do python3 /tmp/sift-scratch/ch22/final/dtype_speed.py | tr '\n' ' '; echo; done
float32:  38.1 MiB, median 1.32 ms float64:  76.2 MiB, median 2.83 ms
float32:  38.1 MiB, median 1.34 ms float64:  76.2 MiB, median 2.94 ms
float32:  38.1 MiB, median 1.18 ms float64:  76.2 MiB, median 2.88 ms
float32:  38.1 MiB, median 1.37 ms float64:  76.2 MiB, median 2.86 ms
float32:  38.1 MiB, median 1.21 ms float64:  76.2 MiB, median 2.86 ms
```

float64 慢 2.1 到 2.4 倍，接近读的字节数之比。读的字节减半，时间差不多减半，这是内存受限计算的特征。

float32 有个不能省的纪律：整条链路都不能不小心变成 float64。`tfidf_matrix` 里 `tf` 和 `idf` 是 `np.float32`，`+ 1` 是 Python 的 int（NEP 50 的“弱类型”，不提升），`matrix` 是 `np.zeros(..., dtype=np.float32)`，所以结果仍是 float32；中间任何一处换成 float64，赋值进 `matrix` 时又会被截断回 float32，白白多出一份 float64 的临时数组。`tests/test_analytics.py` 的 `test_matrix_is_float32_with_unit_rows` 钉死了 `matrix.dtype == np.float32`。

## pandas：给语料一张表

numpy 把数据当成同质的数字块，pandas 在它上面加了“带名字的列”和“带标签的行”，适合像“123 篇文章，每篇有标题、日期、分类、系列、词数”这样的表。`corpus_frame` 是 Sift 里造这张表的函数：

```python
def corpus_frame(index: TermIndex) -> pd.DataFrame:
    """Return one row per live document, in doc_id order.

    Columns: ``doc_id``, ``title``, ``published`` (datetime64 in
    Asia/Shanghai), ``category``, ``series`` (missing values are
    ``None``), ``n_tags``, ``tokens`` (indexed tokens of the body)
    and ``chars`` (characters of the body).
    """
    docs = [index.documents[doc_id] for doc_id in sorted(index.documents)]
    return pd.DataFrame(
        {
            "doc_id": [doc.doc_id for doc in docs],
            "title": [doc.title for doc in docs],
            "published": pd.to_datetime([doc.published for doc in docs]),
            "category": [doc.category for doc in docs],
            "series": [doc.series for doc in docs],
            "n_tags": [len(doc.tags) for doc in docs],
            "tokens": [index.doc_len(doc.doc_id) for doc in docs],
            "chars": [len(doc.body) for doc in docs],
        },
        columns=list(CORPUS_COLUMNS),
    )
```

一个字典，每个键是列名，值是等长的列表，`pd.DataFrame` 把每一列变成一个 `Series`（一列带类型和索引的数组）。`pd.to_datetime` 把一串带偏移的日期字符串（`2026-10-19 23:00:00 +08:00`）变成带时区的时间列。`columns=list(CORPUS_COLUMNS)` 固定列的顺序；顺带一个好处：索引为空时仍然得到一个有这 8 列的空表，不会是 0 列的怪东西。

`pandas_tour.py` 是一趟 API 游览。每一段我都对着输出说一下：

```text
$ python3 lab/ch22/pandas_tour.py 2>&1 | grep -v '^load_index took'
shape (123, 8)
doc_id                               int64
title                                  str
published    datetime64[us, Asia/Shanghai]
category                               str
series                                 str
n_tags                               int64
tokens                               int64
chars                                int64

Series: Series, mean 6446.5
describe:
count      123.0
mean      6446.5
std       4419.1
min        787.0
25%       3857.5
50%       4858.0
75%       8256.5
max      25435.0
```

三个值得停一下的地方。`title` 的类型是 `str`，不是以前的 `object`：pandas 3 默认把文本列存成专门的字符串类型。按 pandas 的文档，它有两种后端，装了 `pyarrow` 就用 Arrow，没有就退回 Python 对象；这台机器上 `import pyarrow` 报 `ModuleNotFoundError`，`frame["title"].dtype.storage` 是 `'python'`，是后一种。`published` 是 `datetime64[us, Asia/Shanghai]`，微秒精度，带时区。最后 `describe()` 一次给出词数的分布：均值 6446.5，中位数 4858，最长 25435，均值明显大于中位数，是右偏的。

```text
.loc by label, .iloc by position
ARMv7-A 指令体系全解：数据处理、访存、分支与同步
ARMv7-A 指令体系全解：数据处理、访存、分支与同步
    doc_id  tokens
10      10   23004
89      89   25435
```

`.loc` 按标签取，`.iloc` 按位置取。这里它们给出同一篇，因为行标签恰好是 0 到 122，和位置重合。一旦过滤，这个巧合就没了：最后那个表是 `frame.loc[frame["tokens"] > 20_000, ["doc_id", "tokens"]]`，一个布尔掩码选行，一个列表选列，一次 `.loc` 调用完成，结果的行标签是 10 和 89，这时 `.iloc[10]` 取的就是另一行了。下面讲写时复制时会看到，这个“一次 `.loc` 调用同时选行和列”的形状也是写入时的正确写法。

```text
value_counts of category
category
Note        72
Tutorial    51

groupby category
          count    mean    max
category
Note         72  6095.0  25435
Tutorial     51  6942.0  23004

merge: posts in the same series
                        title  posts
12  我终于学会了 grep，然后换成了 ripgrep    1.0
14             一维卡尔曼滤波：两个高斯相乘    8.0
15        升到高维：多变量卡尔曼滤波的推导与实现    8.0

pivot_table: posts by category and year
year      2023  2025  2026
category
Note         1     4    67
Tutorial     0     5    46
```

`value_counts` 数每个值出现几次，`groupby` 按分类分组再聚合（`agg(["count", "mean", "max"])` 一次做三个统计），教程比笔记平均长 850 词。`merge` 是 SQL 的 join：先 `groupby("series").size()` 得到每个系列有几篇，改名为 `posts`，`reset_index` 把系列名从索引变回列，再按 `series` 左连接回原表。没有系列的文章在 `posts` 里是 `NaN`，整数列因此被迫变成浮点（所以是 `1.0`、`8.0`）。这是 pandas 里一个老坑，整数列一遇到缺失值就变成浮点。`pivot_table` 是一个交叉表，分类对年份数篇数。2024 一栏没有，因为那一年没有文章；2026 一栏加起来 113 篇，占了 123 篇的 92%。

### 写时复制：pandas 3 最大的变化

最后一段输出是这趟游览里最重要的：

```text
copy-on-write (pandas 3)
part.iloc[0] = -1 -> frame still 3760
chained assignment changed nothing: ['ChainedAssignmentError']
one .loc call did write: 123 rows
```

pandas 3 里，**任何从别的 DataFrame 或 Series 派生出来的对象，行为上都是一份副本**；改它不会改回原来的。以前，`part = frame["tokens"]` 得到的是视图还是副本取决于操作的细节，改 `part` 有时会改到 `frame`，有时不会，还有个 `SettingWithCopyWarning` 在两者之间含糊其辞（我这台机器上没有 pandas 2，旧行为我没有跑过，这一句来自 pandas 文档的叙述，不是我的实验）。pandas 3 把规则统一成了一条，代价是不能再依赖“改视图”这件事。

“行为上是副本”不等于真的复制了：复制是懒的。写了一个小草稿看内存：

```python
import warnings

import numpy as np
import pandas as pd

frame = pd.DataFrame({"tokens": [10, 20, 30], "chars": [1, 2, 3]})
part = frame["tokens"]


def shared() -> bool:
    return np.shares_memory(part.to_numpy(), frame["tokens"].to_numpy())


print("before the write, shares memory:", shared())
part.iloc[0] = -1
print("after the write, shares memory: ", shared())
print("frame:", frame["tokens"].tolist(), "part:", part.tolist())

values = frame["tokens"].to_numpy()
print("to_numpy() writeable:", values.flags.writeable)
with warnings.catch_warnings(record=True) as caught:
    warnings.simplefilter("always")
    print("copy_on_write option:", pd.options.mode.copy_on_write)
print(caught[0].category.__name__, "-", str(caught[0].message)[:62])
```

```text
$ python3 /tmp/sift-scratch/ch22/final/cow.py
before the write, shares memory: True
after the write, shares memory:  False
frame: [10, 20, 30] part: [-1, 20, 30]
to_numpy() writeable: False
copy_on_write option: True
Pandas4Warning - The 'mode.copy_on_write' option is deprecated. Copy-on-Write c
```

`part = frame["tokens"]` 之后，两个对象共用同一块内存（`True`），一个字节也没复制；`part.iloc[0] = -1` 写入的一刻才复制，之后各是各的（`False`），`frame` 没变，`part` 变了。懒复制让“选几列”依然便宜，对象越大越重要。第四行：`.to_numpy()` 交出的数组是只读的，因为它和表共享内存，让你写进去就会改到原表。最后两行：`pd.options.mode.copy_on_write` 在 pandas 3 里只是个返回 `True` 的废弃选项（`Pandas4Warning`），不能再关。

链式赋值是旧习惯最容易踩的地方。`frame[frame["tokens"] > 0]["tokens"] = 0` 看起来像“把词数大于 0 的行的词数设成 0”，实际上第一个 `[...]` 先造出一个临时的新表，第二个 `["tokens"] = 0` 改的是这个临时表，随即被丢掉。写时复制下这个赋值**永远**不会改到 `frame`，pandas 发出 `ChainedAssignmentError` 提醒你。它是 `Warning` 的子类，不是异常（`ChainedAssignmentError.__mro__` 是 `(ChainedAssignmentError, Warning, Exception, ...)`），所以脚本不会崩，只是什么也没改。正确的写法是 `frame.loc[mask, "flag"] = True`，一次调用里同时说清行和列，输出最后一行 123 行被写入。

pandas 怎么知道这是链式赋值的？我读了安装的 pandas 3.0.4 的源码。`pandas/core/frame.py` 第 4643 到 4649 行：

```python
        if not CHAINED_WARNING_DISABLED:
            if sys.getrefcount(self) <= REF_COUNT and not com.is_local_in_caller_frame(
                self
            ):
                warnings.warn(
                    _chained_assignment_msg, ChainedAssignmentError, stacklevel=2
                )
```

靠引用计数。`DataFrame.__setitem__` 被调用时，如果 `self` 的引用计数不超过 `REF_COUNT`，说明除了这次调用之外，没有任何变量持有这个 DataFrame，它是个临时对象，调用者是链式写法。`REF_COUNT` 在 `pandas/compat/_constants.py` 第 21 到 24 行：`REF_COUNT = 2 if PY314 else 3`，3.14 里同样的调用，`getrefcount` 看到的数比以前少 1，阈值只好跟着版本变（我猜与 3.14 的解释器在栈上借用引用有关，没有去读 CPython 的相关改动）。同一个文件里的 `CHAINED_WARNING_DISABLED = PYPY` 说明在 PyPy（引用计数不是它的内存管理方式）上这套检测整个关掉。这是个启发式，不是证明：它只是个警告，也不影响“链式赋值不生效”这个事实，因为那是写时复制本身保证的。引用计数的细节我在第 1 篇和第 15 篇讲过，这里是它出现在一个意外的地方。

## 时间序列：`resample`

“每个月发了几篇”是一个时间序列问题。`posts_per_month` 只有两行：

```python
def posts_per_month(frame: pd.DataFrame) -> pd.Series[int]:
    """Count the posts of each calendar month, empty months included.

    The index holds the first day of each month, from the month of
    the first post to the month of the last one.
    """
    dated = frame.set_index("published")
    return dated["doc_id"].resample("MS").count()
```

`set_index("published")` 把时间列提成索引，这时 `frame` 有了一个 `DatetimeIndex`；`resample("MS")` 像 `groupby`，只是分组的依据是“落在哪个月”，`MS` 是 month start，每个桶用该月的第一天做标签；`count()` 数每个桶里有几行。空桶也出现，计数是 0。这一点是 `resample` 相对 `groupby` 的好处：中间没有文章的月份不会悄悄消失，折线和柱状图的横轴才是均匀的。

```text
$ python3 lab/ch22/posts_per_month.py 2>&1 | grep -v '^load_index took'
published dtype: datetime64[us, Asia/Shanghai]
39 months, from 2023-08
empty months: 23
peak: 2026-10 with 85 posts
published
2026-10-01 00:00:00+08:00    85
2026-09-01 00:00:00+08:00     7
2026-01-01 00:00:00+08:00     6
2026-04-01 00:00:00+08:00     5
2026-08-01 00:00:00+08:00     5
busiest 3 months in a row: 97 posts
```

从 2023-08 到 2026-10 是 39 个月，其中 23 个月一篇都没有；峰值是 2026-10，85 篇，占 123 篇的 69%；最忙的连续三个月是 97 篇（`rolling(3).sum()`）。我另外查了几件事，写成草稿 `resample_facts.py`（读 `corpus_frame`，试 `resample("M")`，把月份换到 UTC 重算，数 2026-10 每天的篇数）：

```text
$ python3 /tmp/sift-scratch/ch22/final/resample_facts.py 2>&1 | grep -v '^load_index took'
2023-08-20 23:44:31+08:00 to 2026-10-19 23:00:00+08:00
resample('M'): Invalid frequency: M. Failed to parse with error message: ValueError("'M' is no longer supported for offsets. Please use 'ME' instead.")
posts whose month changes in UTC: 0
10-05     1
10-13    15
10-14      8
10-16     10
10-18     35
10-19     16
```

三件事。pandas 3 不再接受 `resample("M")`，要明确写月初 `"MS"` 或月末 `"ME"`，旧写法直接 `ValueError`。时区方面，`published` 带 `Asia/Shanghai`，分月按北京时间；我把月份换到 UTC 重算，没有一篇文章换了月份（没有发在 1 号 8 点之前的），所以这份语料里时区不会影响图，但一般不能假设这一点。最后是 2026-10 的 85 篇：六天里 85 篇，一天（10-18）35 篇。这说明“每月发布的文章数”这张图反映的是文章的日期戳，博客那一个月集中放出了大批文章，多半不是写作的节奏；我没有去查是哪一种原因。图 3 要读成这个样子。

## `read_sql`：查询日志进 DataFrame

`sift search` 每次把查询记进 `sift.db` 的 `query_log` 表（第 13 篇）。这一篇起，`sift bench search` 也记：它先把 12 条查询计时，再统一写日志，写日志不进计时。`query_log_frame` 读它：

```python
def query_log_frame(db: Path) -> pd.DataFrame:
    """Return the query log of the database at db, oldest first.

    Columns: ``at`` (datetime64 in UTC), ``query``, ``total`` and
    ``took_ms``. A database without a log gives an empty frame.
    """
    sql = f"SELECT {', '.join(QUERY_COLUMNS)} FROM query_log ORDER BY id"
    with sqlite3.connect(db) as conn:
        frame = pd.read_sql(sql, conn)
    frame["at"] = pd.to_datetime(frame["at"], utc=True)
    return frame
```

`pd.read_sql(sql, conn)` 执行一条 SQL，把结果集变成 DataFrame，列名是结果集的列名，类型由驱动给的值推断。按 `read_sql` 的文档字符串（安装的 pandas 里 `pandas/io/sql.py` 第 566 到 569 行），`con` 可以是 ADBC 连接、SQLAlchemy 的连接、字符串或者 `sqlite3` 连接，DBAPI2 对象里只支持 `sqlite3`。我用 `sqlite3` 连接，因为这个函数只读一张表，不值得为它起一个引擎；上面的 SQL 字符串里 `QUERY_COLUMNS` 是模块里的常量，没有用户输入，所以我用 f-string 拼列名而没有用参数绑定，真有用户给的值的话，必须用 `read_sql(sql, conn, params=...)`。

`at` 这一列在 SQLite 里声明为 `DATETIME`，实际存的是文本：

```text
$ python3 -c "import sqlite3; print(sqlite3.connect('/tmp/sift-scratch/ch22/idx/sift.db').execute('select at, typeof(at) from query_log limit 1').fetchall())"
[('2026-10-26 16:46:47.224861', 'text')]
```

`at` 是不带偏移的字符串。`log_query` 写的是 `datetime.now(UTC)`，所以这些是 UTC，`pd.to_datetime(frame["at"], utc=True)` 明确告诉 pandas 这一点，得到 `datetime64[us, UTC]`。`pandas_query_log.py` 建一个临时索引，跑 5 次 `sift bench search`，再用 `query_log_frame` 读：

```text
$ python3 lab/ch22/pandas_query_log.py
60 rows after 5 runs
at         datetime64[us, UTC]
query                      str
total                    int64
took_ms                float64
                                at          query  total     took_ms
0 2026-10-26 16:17:14.544935+00:00       rust 所有权     10  229.168039
1 2026-10-26 16:17:14.554435+00:00  kalman filter      5   71.235274
2 2026-10-26 16:17:14.561681+00:00  "device tree"      4   30.519068

latency per query (ms), slowest median first
                     count  median     min     max
query
rust 所有权                 5  229.63  227.94  230.76
owner*                   5  116.29  115.40  117.17
pid AND 积分               5  112.58  111.96  113.75
tag:Rust lifetime        5  103.30  103.03  104.15
typst -latex             5   85.99   85.02   87.41
矩阵 OR matrix             5   82.45   81.75   83.90
kalman filter            5   71.24   70.85   71.76
奇异值                      5   60.53   59.80   60.95
gdb 断点                   5   51.17   50.77   52.26
"device tree"            5   30.52   30.31   31.43
cmake vcpkg              5   26.12   25.18   28.19
linux kernel module      5   19.42   19.22   19.90

cold run median 76.84 ms
warm runs median 76.76 ms
          ms
0.50   76.76
0.90  116.88
0.99  230.43
exit 0
```

12 条查询乘 5 次是 60 行，每条查询的 5 个读数很集中：最大除以最小，多数在 1.01 到 1.04 之间，最宽的 `cmake vcpkg` 是 1.12。所以耗时主要由查询决定，噪声小。`groupby("query")["took_ms"].agg([...])` 一行给出每条查询的次数、中位数、最小值、最大值，`sort_values("median", ascending=False)` 把最慢的排在前面。最慢的 `rust 所有权` 229.6 毫秒，最快的 `linux kernel module` 19.4 毫秒，差 11.8 倍。我另外查了查询里的几个词项在多少篇文章里出现（`所有` 在 123 篇里的 107 篇，`有权` 13 篇，`rust` 43 篇；`linux`、`kernel`、`module` 分别是 30、7、14 篇）。最慢的那条里有个几乎每篇都有的二元组，我猜这是它慢的原因，但没有拆开验证。

“冷”和“热”的比较是个对照：`log["run"] = log.groupby("query").cumcount()` 给每条查询的第几次运行编号，0 是第一次，我把它叫冷。冷的中位数 76.84 毫秒，其余 76.76 毫秒，没有差别。道理很直接：每次 `sift bench search` 是个新进程，缓存从零开始，第一次和第五次没有区别；如果我想看“热缓存”，要在同一个进程里重复查询。最后三行是分位数：中位数 76.76，p90 是 116.88，p99 是 230.43，p99 几乎就是最慢那条查询。这张表的直方图就是图 4，下面讲。

### 一个没关的连接

写 `query_log_frame` 时我顺手用了 `with sqlite3.connect(db) as conn:`，这是个常见的误解：`sqlite3.Connection` 的上下文管理器**不关闭连接**，只管事务。CPython 3.14.7 的 `Modules/_sqlite/connection.c` 里，[`pysqlite_connection_exit_impl`（第 2460 到 2490 行）](https://github.com/python/cpython/blob/v3.14.7/Modules/_sqlite/connection.c#L2460-L2490)的行为是：没有异常就 `commit`，有异常就 `rollback`，没有 `close`。而连接对象被回收时，[`connection_finalize`（第 484 到 505 行）](https://github.com/python/cpython/blob/v3.14.7/Modules/_sqlite/connection.c#L484-L505)发现 `con->db` 还开着，就发出 `ResourceWarning: unclosed database`。我写了个草稿 `resource_warn.py` 看它是不是真的发生：用 `warnings.catch_warnings(record=True)` 记下 `query_log_frame(db)` 加一次 `gc.collect()` 期间的警告类别，再对同一个库用 `with closing(sqlite3.connect(db)) as conn:` 包一次 `pd.read_sql`，对照：

```text
$ python3 /tmp/sift-scratch/ch22/final/resource_warn.py
query_log_frame: ['ResourceWarning']
closing(...):    []
```

`query_log_frame` 确实泄漏了一个连接，用 `contextlib.closing(sqlite3.connect(db))` 就没有警告。这是个真缺口：函数返回时 DataFrame 已经读完，连接没人用，几乎没有后果（`ResourceWarning` 默认不显示，pytest 也没有把它当错误，所以 `tests/test_analytics.py` 的 20 个测试都通过了），但它是个真泄漏：每调用一次，就等垃圾回收器来关一次。我没有改它，因为这个仓库已经打了 `ch22` 的标签，留作练习 1。

## 齐夫定律：词频和排名

Zipf 的观察是：把一个语料里的词按出现次数从高到低排队，第 $r$ 名的次数大致和 $r$ 成反比，$f(r) \approx c \cdot r^{s}$，指数 $s$ 在自然语言里接近 $-1$。取对数后是一条直线：$\ln f = \ln c + s \ln r$，斜率就是 $s$。所以“量齐夫指数”的做法是：数出每个词项的频率、排序、两边取对数、拟合一条直线。这一步在 `stats.py` 里是四个小函数：

```python
def term_counts(index: TermIndex) -> NDArray[np.int64]:
    """Return the corpus frequency of every term, largest first."""
    counts = [
        sum(posting.tf for posting in index[term]) for term in sorted(index)
    ]
    return np.sort(np.asarray(counts, dtype=np.int64))[::-1]


@dataclass(frozen=True, slots=True)
class PowerLaw:
    """A fitted ``scale * x ** exponent`` curve."""

    scale: float
    exponent: float

    def __call__(self, x: NDArray[np.float64]) -> NDArray[np.float64]:
        """Return the curve at x."""
        return self.scale * x**self.exponent


def fit_power_law(
    x: NDArray[np.float64] | NDArray[np.int64],
    y: NDArray[np.float64] | NDArray[np.int64],
) -> PowerLaw:
    """Fit ``y = scale * x ** exponent``: a line in log-log space."""
    slope, intercept = np.polyfit(np.log(x), np.log(y), 1)
    return PowerLaw(scale=float(np.exp(intercept)), exponent=float(slope))


def zipf_fit(counts: NDArray[np.int64], max_rank: int = 1000) -> PowerLaw:
    """Fit frequency against rank over the first max_rank ranks.

    counts must be sorted largest first. The exponent is negative
    (Zipf's law says about -1). The long tail of words seen once or
    twice is a staircase, not a line, so it stays out of the fit.
    """
    ranks = np.arange(1, min(len(counts), max_rank) + 1)
    return fit_power_law(ranks, counts[: len(ranks)])
```

`term_counts` 把每个词项的所有倒排记录的 `tf` 加起来，用 `np.sort(...)[::-1]` 从大到小排（`[::-1]` 又是一个视图，没有复制）。`PowerLaw` 是 `frozen=True, slots=True` 的数据类（第 6 篇），带一个 `__call__`，所以拟合结果既是两个数 `scale` 和 `exponent`，又是一个可以直接调用的函数 `fit(x)`。`fit_power_law` 里 `np.polyfit(np.log(x), np.log(y), 1)` 返回 `[斜率, 截距]`。`polyfit` 在底层做的是最小二乘：安装的 numpy 2.5.1 里，`numpy/lib/_polynomial_impl.py` 第 657 到 677 行先用 `vander(x, order)` 造出设计矩阵，把每一列缩放到同一量级，然后交给 `lstsq`。

`zipf_fit` 只取前 `max_rank = 1000` 个排名，docstring 里写了原因：尾部那一长串只出现 1 次、2 次的词是阶梯，不是直线，不纳入拟合。这是个选择，选择会改变答案，所以我把答案随选择怎么变也量了：

```text
$ python3 lab/ch22/zipf.py 2>&1 | grep -v '^load_index took'
81167 terms, 792920 tokens
top 5 counts: [14594, 11405, 6620, 4740, 4572]
seen once: 39676 terms (49%)
all ranks:  exponent -1.152
ranks 1-100: exponent -0.639
ranks 1-1000: exponent -0.743
ranks 1-10000: exponent -0.988
count(rank) ~ 20464 * rank^-0.743
rank    1: real  14594, model   20464.1
rank   10: real   2978, model    3700.5
rank  100: real    686, model     669.2
rank 1000: real    113, model     121.0
```

语料共 792,920 个词元、81,167 个不同的词项。词项里 49%（39,676 个）全语料只出现一次。指数是 $-0.743$，但同一份数据，取前 100 名是 $-0.639$，取前 10000 名是 $-0.988$，全部排名是 $-1.152$。**这不是一个数，是一个随范围变化的数**。表的下半部分也说明了模型在两头的偏差：第 1 名实际 14594，模型 20464，高了 40%；第 100 名和第 1000 名几乎对上。图 1 把这个画了出来：

![齐夫定律图：双对数坐标，横轴是排名 rank，纵轴是词频 frequency。蓝点是每个词项，橙色直线是排名 1 到 1000 的拟合，图例写着“拟合 fit: 频率 ∝ 排名^-0.74”。第 1 名的点（约 1.4 万）和前十几名落在直线下面；排名 20 到 1000 的点贴着直线；超过 1000 之后点向下弯；排名 1 万以后变成一级一级的阶梯，最底下是频率 1 的一长条横线，从排名约 4 万延伸到约 8 万，往上依次是频率 2、3、4、5 的短横线](/assets/images/python-by-sift/ch22-zipf.png)

我看到的：前面说的三段都在图上。直线从排名 1 画到 1000，排名 20 到 1000 贴得很紧；第 1 名和头十几名在线下；1000 之后点往下掉；排名 10⁴ 以后是阶梯，频率 1 那一条横线最长，大约从 4 万名铺到 8 万名，就是那 49% 只出现一次的词项。这个阶梯是整数造成的：一万名以后，几万个词项只能挤在 1、2、3 这几个整数频率上。

### 指数为什么随范围变

我把排名切成按数量级的五段，每段单独拟合：

```python
import numpy as np

from sift.analysis import build_pipeline
from sift.analytics.stats import (
    fit_power_law,
    heaps_fit,
    term_counts,
    vocabulary_growth,
)
from sift.cli import load_index
from sift.config import load_config

config = load_config()
_, index = load_index(config.corpus, build_pipeline(config.pipeline))
counts = term_counts(index)
ranks = np.arange(1, len(counts) + 1)
print("window of ranks        points  exponent")
for lo, hi in [
    (1, 10),
    (10, 100),
    (100, 1000),
    (1000, 10_000),
    (10_000, len(counts)),
]:
    sel = slice(lo - 1, hi)
    fit = fit_power_law(ranks[sel], counts[sel])
    print(f"{lo:>6} .. {hi:<6} {hi - lo + 1:>9}  {fit.exponent:8.3f}")
print("counts at rank 10^k:", [int(counts[10**k - 1]) for k in range(5)])
print("distinct frequencies in the tail: ", len(np.unique(counts[1000:])))
tokens, vocab = vocabulary_growth(index)
print("window of docs   exponent")
for lo, hi in [(0, 10), (10, 40), (40, 123)]:
    fit = fit_power_law(tokens[lo:hi], vocab[lo:hi])
    print(f"{lo + 1:>4} .. {hi:<4} {fit.exponent:8.3f}")
print("new terms in doc 1, 2, 3:", np.diff(vocab[:3], prepend=0).tolist())
last = np.diff(vocab)[-10:]
print("new terms in the last 10 docs:", last.tolist())
```

```text
$ python3 /tmp/sift-scratch/ch22/final/local_slopes.py 2>&1 | grep -v '^load_index took'
window of ranks        points  exponent
     1 .. 10            10    -0.738
    10 .. 100           91    -0.659
   100 .. 1000         901    -0.775
  1000 .. 10000       9001    -1.132
 10000 .. 81167       71168    -1.145
counts at rank 10^k: [14594, 2978, 686, 113, 9]
distinct frequencies in the tail:  113
window of docs   exponent
   1 .. 10      0.889
  11 .. 40      0.479
  41 .. 123     0.663
new terms in doc 1, 2, 3: [1874, 623, 3796]
new terms in the last 10 docs: [664, 156, 972, 366, 379, 199, 127, 622, 187, 252]
```

（后半截是下一节希普斯定律要用的。）前三段的局部指数是 $-0.74$、$-0.66$、$-0.78$，差不多是同一个数；1000 名以后变成 $-1.13$ 和 $-1.15$。曲线在双对数图上不是直线，是一条有拐点的折线，拐点在排名 1000 前后，那里词频约 113。再看“全部排名”的 $-1.152$ 是怎么来的：最小二乘里**每个排名的权重相同**，最后那一段有 71,168 个点，占全部 81,167 个点的 88%，所以全部排名的拟合基本等于最后一段的斜率。排名 1000 以后的 80,167 个词项只用了 113 个不同的频率值，是阶梯的平台，再对阶梯做直线拟合，既不稳，也不太有意义（对幂律的参数估计，最小二乘拟合双对数直线是一种常见但有偏的做法；更严格的是最大似然，我没有实现，也没有实验过）。

那么前面一千名为什么比 $-1$ 平？我先猜是停用词：`["mixed", "nfkc", "stopwords"]` 这条流水线去掉了最高频的几个功能词，头部被削平。这个猜想可以直接检验，草稿 `zipf_stop.py` 用两条流水线（带停用词和不带）各建一份内存索引，量同样的指数，列出榜首的词项：

```text
$ python3 /tmp/sift-scratch/ch22/final/zipf_stop.py 2>&1 | grep -v '^load_index took'
('mixed', 'nfkc', 'stopwords') 792920 tokens, 81167 terms
  exponents ['-0.639', '-0.743', '-0.988']
  top counts [14594, 11405, 6620, 4740, 4572, 4067]
  top terms  ['0', '1', '2', '一个', '3', 'n', 't', 'x', 'np', 'c']
('mixed', 'nfkc') 812338 tokens, 81192 terms
  exponents ['-0.642', '-0.754', '-0.997']
  top counts [14594, 11405, 6620, 6317, 4740, 4572]
  top terms  ['0', '1', '2', 'a', '一个', '3', 'n', 't', 'x', 'np']
```

我的猜想错了。停用词表去掉的只有 19,418 个词元（`812338 - 792920`），多出来的一个高频词是 `a`；三个范围的指数几乎没动：$-0.639$ 对 $-0.642$，$-0.743$ 对 $-0.754$，$-0.988$ 对 $-0.997$。最该看的是榜首：这个语料的前三名是 `0`、`1`、`2`，第五名 `3`，再后面是 `n`、`t`、`x`、`np`、`c`：多半是代码块和公式里的数字和变量名，不是自然语言的功能词。这是一个混着教程代码、公式和中文散文的语料。

所以我换了个角度，按“有没有汉字”把词项分成两堆，各自量：

```python
import re

import numpy as np

from sift.analysis import build_pipeline
from sift.analytics.stats import zipf_fit
from sift.cli import load_index
from sift.config import load_config

config = load_config()
_, index = load_index(config.corpus, build_pipeline(config.pipeline))
han = re.compile(r"[\u4e00-\u9fff]")
groups: dict[str, list[int]] = {"CJK": [], "other": []}
for term in index:
    total = sum(p.tf for p in index[term])
    groups["CJK" if han.search(term) else "other"].append(total)
for name, values in groups.items():
    counts = np.sort(np.asarray(values, dtype=np.int64))[::-1]
    once = int((counts == 1).sum())
    exps = [round(zipf_fit(counts, m).exponent, 3) for m in (100, 1000)]
    print(
        f"{name:<6} terms {len(counts):>6} tokens {int(counts.sum()):>7} "
        f"seen once {once / len(counts):4.0%} top {counts[:4].tolist()} "
        f"exp(100, 1000) {exps}"
    )
```

```text
$ python3 /tmp/sift-scratch/ch22/final/zipf_split.py 2>&1 | grep -v '^load_index took'
CJK    terms  66938 tokens  452028 seen once  53% top [4740, 1989, 1580, 1538] exp(100, 1000) [-0.488, -0.661]
other  terms  14229 tokens  340892 seen once  31% top [14594, 11405, 6620, 4572] exp(100, 1000) [-0.769, -0.941]
```

含汉字的词项（基本就是二元组）有 66,938 个，占词表的 82%，但只占 452,028 个词元（57%）；它们 53% 只出现一次，指数很平，$-0.49$（前 100 名）和 $-0.66$（前 1000 名）。其余的（西文词、数字、变量名）只有 14,229 个词项，指数 $-0.77$ 和 $-0.94$，接近 1。把两堆放在同一张图里排队，就得到上面那条折线。这个解释和数据相容：整张图是两个分布的混合，中文二元组那一堆又多又平，西文那一堆更像经典的齐夫分布。我没有再往下证明，比如“二元组的指数本来就比词的低”这类说法，需要用一个已知的中文分词语料来验证，这一篇没做。

## 希普斯定律：词表怎么长

另一条经验规律：读得越多，遇到新词的速度越慢，词表大小 $V$ 和词元总数 $n$ 的关系是 $V(n) = K\,n^{\beta}$，$\beta$ 通常小于 1。`vocabulary_growth` 的做法是：对每个词项，找出它第一次出现在第几篇文章，数每篇文章带来多少个新词项，再累加。

```python
def vocabulary_growth(
    index: TermIndex,
) -> tuple[NDArray[np.int64], NDArray[np.int64]]:
    """Return ``(tokens, vocabulary)`` after each document.

    The documents are read in doc_id order: after document i, the
    corpus holds ``tokens[i]`` tokens and ``vocabulary[i]`` distinct
    terms.
    """
    doc_ids = sorted(index.documents)
    row_of = {doc_id: row for row, doc_id in enumerate(doc_ids)}
    first_seen: list[int] = []
    for term in index:
        rows = [row_of[p.doc_id] for p in index[term] if p.doc_id in row_of]
        if rows:
            first_seen.append(min(rows))
    new_terms = np.bincount(first_seen, minlength=len(doc_ids))
    lengths = [index.doc_len(doc_id) for doc_id in doc_ids]
    return np.cumsum(lengths, dtype=np.int64), np.cumsum(new_terms)


def heaps_fit(
    tokens: NDArray[np.int64], vocabulary: NDArray[np.int64]
) -> PowerLaw:
    """Fit ``V(n) = K * n ** beta``; ``scale`` is K, ``exponent`` beta."""
    return fit_power_law(tokens, vocabulary)
```

`first_seen` 里放每个词项的“最早出现的行号”；`np.bincount(first_seen, minlength=len(doc_ids))` 一步数出每篇文章贡献了几个新词项；`np.cumsum` 把它累加成词表大小；词元数同理。文章按 `doc_id` 顺序读，所以曲线是“按文件名顺序读语料”的结果，换个顺序曲线的细节会变（我没有试），但端点不变。

```text
$ python3 lab/ch22/heaps.py 2>&1 | grep -v '^load_index took'
792920 tokens, 81167 distinct terms
V(n) = 17.13 * n^0.621
after   1 docs: n   3760, V   1874, model      2841
after  10 docs: n  34214, V  13518, model     11191
after  30 docs: n 169302, V  30271, model     30201
after  60 docs: n 302401, V  40955, model     43294
after 123 docs: n 792920, V  81167, model     78766
```

$K = 17.13$，$\beta = 0.621$。表里几行显示了拟合的质量：读完第 30 篇，模型 30201，实际 30271，几乎相同；读完第 1 篇和第 10 篇，模型在第 1 篇偏高、第 10 篇偏低；读完 123 篇，模型偏低 3%。

![希普斯定律图：双对数坐标，横轴是词元数 tokens n，纵轴是词汇量 vocabulary V。蓝色实线是语料的实际曲线，橙色虚线是拟合“V = 17.1 · n^0.62”。蓝线起点比虚线低，约 1.7 万词元处与虚线相交，2 万到 13 万之间高于虚线并有几处小台阶，约 14 万词元以后与虚线几乎重合，终点约 8 万词汇量](/assets/images/python-by-sift/ch22-heaps.png)

蓝线不是一条直线：开头比虚线低，2 万到 13 万词元之间鼓出去，之后贴上虚线。我另外把前 10 篇、中间 30 篇、后 83 篇分开拟合，局部指数是 0.889、0.479 和 0.663（上面输出的后半截），第 1、2、3 篇各带来 1874、623 和 3796 个新词项，第 3 篇一篇就比前两篇加起来还多。曲线上的台阶就是这样来的：词表增长取决于新文章离已读过的有多远，文章是有话题的，不是从同一个罐子里随机抽的词。

## matplotlib：对象接口、对数坐标和中文字体

数据有了，该画图了。matplotlib 有两套接口。`pyplot` 是状态机：`plt.figure()` 建一张图并记在全局里，之后 `plt.plot` 画在“当前的坐标轴”上。对象接口是自己拿着 `Figure` 和 `Axes` 调方法。`matplotlib_oo.py` 用两种方式画同一条曲线，再看全局里剩了什么：

```text
$ python3 lab/ch22/matplotlib_oo.py
backend: Agg
open pyplot figures after plt.close(): []
plt.figure() without close: [1]
open pyplot figures after Figure(): []
PNG sizes: 15979, 16419
Axes belongs to Figure, not to pyplot
rcParams font.family: ['sans-serif']
```

`plt.close()` 之后全局干净；不 `close`，`plt.figure()` 留在全局里（`[1]`）。用 `Figure()` 直接造的，`plt.get_fignums()` 里始终没有它，没人替你管，也没人替你忘。全局留着的图是会累积的，我另外起了 21 张：

```text
$ python3 /tmp/sift-scratch/ch22/final/mpl_pyplot_leak.py
21 figures open
RuntimeWarning More than 20 figures have been opened. Figures created through the pyplot inte
```

所以 `plots.py` 的开头写明“不用 pyplot”：每个函数 `Figure(figsize=(8.0, 5.0), dpi=150, layout="constrained")`，`fig.subplots()` 拿到一个 `Axes`，画完 `fig.savefig`，函数返回，`Figure` 随局部变量被回收。后端用 `Agg`（只往内存和文件里光栅化，不开窗口）；这台机器上不指定的话，`matplotlib.get_backend()` 在开发环境里返回 `qtagg`（PySide6 装着），脚本里该想的是“我不要窗口”，所以 `configure_matplotlib` 第一句就是 `matplotlib.use("Agg")`。

### 中文字体

输出最后一行 `font.family: ['sans-serif']` 暗示了一件事：默认字体里没有汉字。我把标题 `齐夫定律 Zipf` 画出来，数一数警告：

```text
$ python3 /tmp/sift-scratch/ch22/final/mpl_tofu.py
default font: 4 warnings, PNG 10769 bytes
   UserWarning Glyph 40784 (\N{CJK UNIFIED IDEOGRAPH-9F50}) missing from font(s) DejaVu Sans.
family set: Noto Sans CJK JP
after configure_matplotlib: 0 warnings, PNG 9924 bytes
['Noto Sans CJK JP']
```

4 个汉字，4 条警告，每个字画成一个空框（俗称豆腐块）。`configure_matplotlib` 用环境变量 `SIFT_CJK_FONT` 指的字体文件修好它：

```python
def configure_matplotlib() -> str | None:
    """Select the Agg backend and a font with CJK glyphs.

    The font file is named by ``SIFT_CJK_FONT``. It is registered
    with ``font_manager.fontManager.addfont`` and set as
    ``rcParams["font.family"]``. Return the family name, or None
    (and log a warning) when the variable is unset or the file is
    missing: the figures then print boxes for Chinese characters.
    """
    matplotlib.use("Agg")
    path = os.environ.get(FONT_ENV)
    if not path or not Path(path).is_file():
        logger.warning("%s is not a font file, CJK text will break", FONT_ENV)
        return None
    font_manager.fontManager.addfont(path)
    family = font_manager.FontProperties(fname=path).get_name()
    # a variable font is listed with the weight of its first named
    # instance (Thin, 100); the lookup for "normal" would then warn
    fonts = font_manager.fontManager.ttflist
    for i, entry in enumerate(fonts):
        if entry.fname == path:
            fonts[i] = dataclasses.replace(entry, weight=400)
    matplotlib.rcParams["font.family"] = family
    return family
```

`font_manager.fontManager.addfont(path)` 把字体文件登记进 matplotlib。我读了安装的 matplotlib 3.11.1 的 `font_manager.py` 第 1293 到 1306 行：它按路径打开字体，把第 0 个字体面加进 `ttflist`，再对字体集合里的其余每一面（`for face_index in range(1, font.num_faces)`）各加一条。这个文件是 `NotoSansCJK-VF.otf.ttc`，一个集合，里面有 5 个面（JP、KR、SC、TC、HK），`FontProperties(fname=path).get_name()` 取到的是第 0 个，所以家族名是 `Noto Sans CJK JP`。汉字在日文字形和简体字形之间有少数字形差异，我没有逐字比对图里用的是哪套。

那个 `dataclasses.replace(entry, weight=400)` 是个补丁，注释里写了原因：可变字体登记时的字重是第一个命名实例的 100（Thin），查“普通字重”时会报警告，所以把登记项的字重改成 400。我用 `fontTools` 读了字体的轴：

```text
$ python3 /tmp/sift-scratch/ch22/final/font_axes.py
5 faces in NotoSansCJK-VF.otf.ttc
  Noto Sans CJK JP   [('wght', 100.0, 100.0, 900.0)]
  Noto Sans CJK KR   [('wght', 100.0, 100.0, 900.0)]
  Noto Sans CJK SC   [('wght', 100.0, 100.0, 900.0)]
  Noto Sans CJK TC   [('wght', 100.0, 100.0, 900.0)]
  Noto Sans CJK HK   [('wght', 100.0, 100.0, 900.0)]
```

字重轴 `wght` 从 100 到 900，**默认值是 100**。补丁改的只是 matplotlib 自己的登记信息，字形轮廓没变；我这台机器上只有这一份可变字体，我也没有找到让 matplotlib 选 `wght=400` 实例的办法，所以四张图里的汉字看起来偏细。这是个我没有解决的缺陷，不是风格选择，换一个静态的 Noto Sans CJK 字体文件（`SIFT_CJK_FONT` 指向它）应当能修好，我没有试。

### 一张图的写法

`plot_zipf` 是最典型的一张：

```python
def plot_zipf(
    counts: NDArray[np.int64], fit: PowerLaw, path: Path, max_rank: int = 1000
) -> Path:
    """Draw word frequency against rank on log-log axes, with the fit.

    counts is sorted largest first. The line is drawn over the ranks
    that went into the fit.
    """
    fig, ax = new_figure()
    ranks = np.arange(1, len(counts) + 1)
    ax.scatter(ranks, counts, s=4, color=BLUE, label="词项 term")
    fitted = ranks[:max_rank].astype(np.float64)
    ax.plot(
        fitted,
        fit(fitted),
        color=ORANGE,
        linewidth=2,
        label=f"拟合 fit: 频率 ∝ 排名^{fit.exponent:.2f}",
    )
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel("排名 rank (对数 log)")
    ax.set_ylabel("词频 frequency (对数 log)")
    ax.set_title("齐夫定律：词频与排名")
    ax.grid(True, which="major", alpha=0.3)
    ax.legend()
    return save(fig, path)
```

`ax.scatter(ranks, counts, s=4, ...)` 画 81,167 个点，每点面积 4。拟合线只画前 `max_rank` 个点（它真正用到的那段）。`ax.set_xscale("log")` 和 `set_yscale("log")` 把两个轴变成对数轴，刻度落在 10 的幂上，次刻度（图 2 里的 $2 \times 10^3$ 这类）标在中间。对数轴把“一个数量级”变成相等的长度，所以幂律在上面是直线；代价是 0 画不出来，所以含零的数据（比如下面的“每月篇数”）不能用。标签、标题、图例都是中英对照（`"排名 rank (对数 log)"`），标签里写了“对数”，因为一张图的读者看不到我写的是 `set_yscale("log")`。`layout="constrained"` 让 matplotlib 自动留边，旋转的刻度标签和长标题都没被裁。`savefig` 出来的 PNG 是 1200×750 像素（`FIGSIZE` 8×5 英寸，`DPI` 150）。

### 每月篇数和耗时分布

图 3：

![每月发布文章数的柱状图：横轴是月份 month，每隔 4 个月标一次（2023-08、2023-12 一直到 2026-08），标签斜 45 度；纵轴是文章数 posts。2023-08 有一根 1 篇的矮柱，2023-09 到 2025-03 基本是空的，2025-04 以后零星出现 1 到 7 篇的矮柱；最右边 2026-10 的柱子高到 85 篇，左边有橙色文字“2026-10: 85 篇”和一支指向柱顶的短箭头](/assets/images/python-by-sift/ch22-posts-per-month.png)

这张图我拍了两次：第一版把标注文字放在图中间，箭头横穿了整个绘图区；现在 `plot_posts_per_month` 用 `xytext=(-40, -4)` 和 `textcoords="offset points"`，文字挂在柱顶左边 40 点的位置，箭头很短。横轴用整数位置画柱，刻度标签再换成 `YYYY-MM` 字符串，`step = -(-len(months) // 12)` 是向上取整的写法（39 个月 → 每 4 个月一个标签，和图上一致）。图上的事实是：39 个月里一根 85 篇的柱子把其余 38 根压成了地板，线性轴看不出 1 到 7 篇的差别；这是真实数据的样子，不是图错了：前面查过，85 篇里有 35 篇是同一天的日期戳。

图 4：

![查询耗时分布的直方图：横轴是耗时 latency（毫秒，对数坐标），纵轴是查询数 queries。蓝色柱子大多高 5，分布在约 20 到 70 毫秒之间，约 80 毫秒处一根高 9、紧挨着约 90 毫秒一根高 1，约 110 毫秒一根高 5，约 120 毫秒一根高 10，约 220 毫秒处还有一根孤立的高 5。橙色竖线在 78.6 毫秒，图例写着“中位数 78.6 ms”](/assets/images/python-by-sift/ch22-latency-hist.png)

直方图的桶是对数等宽的：`np.geomspace(low, high * 1.000001, 21)` 取 21 个边界，20 个桶，相邻边界的比值是 1.133。为什么不用默认桶？草稿 `hist_bins.py` 从查询日志读出同样的 60 个耗时，用两种桶各数一遍（`np.histogram`），再算每条查询 5 个读数的最大除以最小：

```text
$ python3 /tmp/sift-scratch/ch22/final/hist_bins.py
60 queries, min 19.1 max 230.6 median 77.1
log bins   : [5, 0, 5, 5, 0, 0, 0, 4, 1, 5, 5, 7, 3, 5, 10, 0, 0, 0, 0, 5]
ratio between edges: 1.133
linear bins: [10, 5, 0, 10, 1, 8, 6, 4, 6, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]
per query spread (max/min): 1.038
```

线性桶每个 10.6 毫秒宽，第一个桶就装了 10 条，左边 10 个桶装了 55 条，中间 9 个桶全空，最后一个桶是慢查询 `rust 所有权` 的 5 次读数；对数桶把它们摊开了。对数桶的高度大多是 5，对得上前面的发现：12 条查询乘 5 次运行，每条查询的 5 个读数相差不到 4%（最大除以最小 1.038），比一个桶的宽度（13%）窄，所以一条查询的 5 次几乎总落在同一个桶里。高 10 是两条查询同桶；相邻两桶里 4 和 1、7 和 3 这样的拆分，是某条查询的读数落在了桶边界两侧（这是我对图的解读，图上数不出来是哪一条）。图里的中位数 78.6 毫秒来自 `extra.sh` 那一次运行；我重跑几次得到 76.8 到 77.1。直方图每次运行都会变，另外三张图不会：我在 `git archive` 出来的副本里重跑了 `lab/ch22/extra.sh`，退出码 0，`cmp` 比较，`zipf`、`heaps`、`posts-per-month` 三张与我打开看过的文件逐字节相同，只有 `latency-hist` 不同（34,761 对 35,266 字节）。四张 PNG 都远小于 400 KB（最大的 76,626 字节），所以我没有转 WebP。

## `sift report`：一条命令

`report.py` 的 `write_report` 把前面所有东西串起来：配置 matplotlib，算 `corpus_frame`、`query_log_frame`、`term_counts`、两个拟合、每月计数，画四张图，再写 `report.md`：

```text
$ sift report --out /tmp/sift-scratch/ch22/report
/tmp/sift-scratch/ch22/report/zipf.png
/tmp/sift-scratch/ch22/report/heaps.png
/tmp/sift-scratch/ch22/report/posts-per-month.png
/tmp/sift-scratch/ch22/report/latency-hist.png
/tmp/sift-scratch/ch22/report/report.md
$ sed -n 1,12p /tmp/sift-scratch/ch22/report/report.md
# Sift report

| metric | value |
| --- | --- |
| documents | 123 |
| tokens | 792920 |
| distinct terms | 81167 |
| Zipf exponent (ranks 1-1000) | -0.743 |
| Heaps K | 17.13 |
| Heaps beta | 0.621 |
| busiest month | 2026-10 (85 posts) |
| logged queries | 60 |
```

表里的数和正文是同一批：792,920 个词元，81,167 个词项，$-0.743$，17.13，0.621，85 篇，60 条查询。`report.md` 后面还有最相似的五对文章（就是上一节那五对，`write_report` 把标题里的 `|` 转义成 `\|`，免得撕裂表格）和四张图的链接。整条命令约 4.0 秒（`time sift report` 是 3.997 秒），其中大半又是上面说的冷启动：解码倒排表。

## 导入的代价，和惰性导入

numpy、pandas、matplotlib 都不便宜。`sift --version` 不该为它们付钱，所以 `cli.py` 里的 `similar` 和 `report` 两条命令在函数体里才 `import sift.analytics...`。代价是多少？在 `cpu_state.py` 夹着的情况下，每个模块新开一个进程各量 5 次取最小：

```text
$ python3 /tmp/sift-scratch/cpu_state.py; python3 /tmp/sift-scratch/ch22/final/import_cost.py; python3 /tmp/sift-scratch/cpu_state.py
112 114 114 114 114 ms
import sys                   16.1 ms
import numpy                 83.4 ms
import pandas               325.5 ms
import matplotlib.pyplot    452.2 ms
import sift.cli              72.9 ms
112 113 113 113 113 ms
```

`import sys` 是 Python 启动本身的 16 毫秒。`sift.cli` 是 73 毫秒，加上 numpy 83、pandas 326（含 numpy）、pyplot 452（含 numpy）。如果 `cli.py` 顶部直接 `import pandas`，每次 `sift --version` 要多付 300 多毫秒。惰性导入的验证是 `tests/test_cli.py` 里扩展过的这一条：

```python
def test_help_and_bench_start_without_heavy_imports() -> None:
    code = (
        "import sys, sift.cli;"
        "sift.cli.main(['--version']);"
        "sift.cli.main(['similar', '--help']);"
        "sift.cli.main(['report', '--help']);"
        "sift.cli.main(['bench', 'index', '--help']);"
        "heavy = {'sqlalchemy', 'asyncio', 'numpy', 'pandas', 'matplotlib'}"
        " & set(sys.modules);"
        "assert not heavy, heavy"
    )
    done = subprocess.run([sys.executable, "-c", code], capture_output=True)
    assert done.returncode == 0, done.stderr
```

它起一个子进程，依次跑 `--version`、`similar --help`、`report --help`、`bench index --help`，再断言 `sys.modules` 里没有重模块。我自己再确认一遍，也看了缺依赖时的样子：

```text
$ python3 /tmp/sift-scratch/ch22/final/lazy_check.py 2>&1 | tail -1
heavy modules loaded: []
$ mkdir /tmp/sift-scratch/ch22/nonumpy; printf 'raise ModuleNotFoundError("No module named numpy", name="numpy")\n' > /tmp/sift-scratch/ch22/nonumpy/numpy.py
$ PYTHONPATH=/tmp/sift-scratch/ch22/nonumpy sift similar 0; echo "exit $?"
error: sift similar needs the data extra (numpy is missing): pip install 'sift[data]'
exit 1
$ PYTHONPATH=/tmp/sift-scratch/ch22/nonumpy sift search --no-log kalman > /dev/null; echo "search exit $?"
search exit 0
```

我造了一个会抛 `ModuleNotFoundError` 的假 `numpy.py` 放在 `PYTHONPATH` 前面，`sift similar` 干净地报出安装提示、退出码 1，而不碰 numpy 的命令（`search`）照常。`data_import_error` 靠的是 `error.name`，所以提示里写的是缺失的那个模块。

## polars

pandas 之外最常被提到的是 polars：Rust 写的 DataFrame 库，默认多线程，有惰性求值的查询优化器，内部是 Arrow 的列式内存。这一篇没有用它，它不在这个项目的工具集里，我没有安装，也没有跑过任何一行，所以没有数字，也不对比谁快。如果这个语料涨到 pandas 觉得吃力，`corpus_frame` 和 `posts_per_month` 这样的函数是最容易换的，因为它们的输出都是一张小表。

## 测试与类型

`tests/test_analytics.py` 有 20 个测试。有一类值得抄：**拿已知答案的数据去测拟合**。

```python
def test_zipf_fit_recovers_a_perfect_law() -> None:
    counts = np.round(100_000 / np.arange(1, 2001)).astype(np.int64)
    fit = stats.zipf_fit(counts)
    assert fit.exponent == pytest.approx(-1.0, abs=0.01)
    assert fit.scale == pytest.approx(100_000, rel=0.02)
```

```python
def test_power_law_fit_recovers_k_and_beta() -> None:
    n = np.arange(100, 5000, 100)
    v = (7.5 * n**0.6).astype(np.float64)
    fit = stats.fit_power_law(n, v)
    assert fit.scale == pytest.approx(7.5, rel=1e-6)
    assert fit.exponent == pytest.approx(0.6, rel=1e-6)
    assert fit(np.array([100.0]))[0] == pytest.approx(7.5 * 100**0.6)
```

第一个造出完美的齐夫分布（`100_000 / rank`）验证指数是 $-1$，第二个用 $7.5 \cdot n^{0.6}$ 造数据，验证拟合找回 $K=7.5$、$\beta=0.6$，相对误差 $10^{-6}$。数据是我造的，所以我知道答案；这是测数值代码比“跑一遍看着像”可靠的地方。

```text
$ python3 -m pytest tests/test_analytics.py
20 passed in 2.46s
$ python3 -m pytest
1057 passed, 1 xfailed, 1 warning in 46.74s
$ ruff format --check --line-length 79 . && ruff check . && mypy && pyright
377 files already formatted
All checks passed!
Success: no issues found in 57 source files
0 errors, 0 warnings, 0 informations
```

类型方面有三件事。**pandas 没有类型。**安装目录里没有 `pandas/py.typed`（numpy 和 matplotlib 都有），所以 `flake.nix` 里加了 `pandas-stubs`，mypy 和 pyright 靠它认识 `DataFrame`。**matplotlib 的 `**kwargs` 没有类型。**`plots.py` 开头有一行 `# pyright: reportUnknownMemberType=false`，这是 pyright 的文件级指令，不是 `# type: ignore`：它只关掉这一类报告，别的问题照常报。我把这行删掉再跑 pyright（在一个临时副本里）：`36 errors`，全是 `reportUnknownMemberType`，比如 `Type of "grid" is partially unknown`，原因是 `grid(..., **kwargs: Unknown)`。

第三件是我自己写的一个注解：`posts_per_month(frame) -> pd.Series[int]`。运行时 `pd.Series[int]` 根本不合法：

```text
$ python3 /tmp/sift-scratch/ch22/final/series_annotation.py
pd.Series[int]: type 'Series' is not subscriptable
__annotations__: type 'Series' is not subscriptable
{'frame': 'pd.DataFrame', 'return': 'pd.Series[int]'}
```

`pd.Series[int]` 在 pandas-stubs 里是个泛型，类型检查器认它，运行时的 `pd.Series` 类不支持下标。模块能导入，是因为 Python 3.14 不在定义时求值注解（[第 14 篇](/posts/python-by-sift-14-type-system/)讲过 PEP 649）：注解被编译成 `__annotate__` 函数，第一次读 `__annotations__` 才求值，而第一次读就是 `TypeError`；`annotationlib.get_annotations(..., format=Format.STRING)` 能拿到字符串。命令行入口不读这些函数的注解，所以没出事，但任何会读 `__annotations__` 的工具（比如 `typing.get_type_hints`，我没有逐个试）会炸。这是又一个我没改的缺口。

## 留下的缺口

这一章留下的几处，仓库里还没有改：

- `query_log_frame` 的 `with sqlite3.connect(db) as conn:` 不关连接（练习 1）。
- `corpus_frame` 的 docstring 说 `series` 缺失值是 `None`，实际是 `nan`（`float`）：`frame.loc[0, "series"]` 的 `repr` 是 `nan`，`is None` 为 `False`，而文档对象的 `series` 本身是 `None`。
- `posts_per_month` 的注解 `pd.Series[int]` 运行时读 `__annotations__` 会 `TypeError`。
- 图里的汉字是可变字体的 Thin 默认实例，偏细（练习 4）；家族名是 `Noto Sans CJK JP`，字形差异没有核对。
- 74 倍那一档的成因只证明了和线程数有关（练习 5）。
- 齐夫指数是双对数直线的最小二乘拟合，不是最大似然；“二元组的指数本来就低”没有用独立语料验证（练习 3）。
- 我只在 Linux 6.18.57 的 x86-64 和 Python 3.14.7 上跑过；pandas 对 `REF_COUNT` 的其他分支、polars 都没有测。

## 本篇文件

这一章动了 24 个文件，`git diff --shortstat ch21 ch22` 给出 `24 files changed, 1477 insertions(+), 19 deletions(-)`。表里的 `+N -M` 来自 `git diff --numstat ch21 ch22`，命令是跑它对应的测试或脚本，结果是我在标签 `ch22` 上最后一次实际跑出来的（除特别写明的，退出码都是 0；计时类的脚本，表里挑的是不带计时的那一行）；`/tmp/sift-scratch/ch22/` 里的草稿脚本不进仓库，不在表里。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`README.md`](https://github.com/bfmhno3/sift/blob/ch22/README.md) | `grep -n "sift similar" README.md` | 第 55 和 105 行；`+13 -1` |
| [`flake.nix`](https://github.com/bfmhno3/sift/blob/ch22/flake.nix) | `grep -n pandas-stubs flake.nix` | `33:  pandas-stubs`；`+1 -0` |
| [`broadcast_fail.py`](https://github.com/bfmhno3/sift/blob/ch22/lab/ch22/broadcast_fail.py) | `python3 lab/ch22/broadcast_fail.py` | 退出码 1（预期的失败），`ValueError: operands could not be broadcast together`；`+16 -0` |
| [`broadcasting.py`](https://github.com/bfmhno3/sift/blob/ch22/lab/ch22/broadcasting.py) | `python3 lab/ch22/broadcasting.py \| tail -1` | `np.maximum.accumulate: [1.0, 4.0, 9.0, 9.0]`；`+37 -0` |
| [`extra.sh`](https://github.com/bfmhno3/sift/blob/ch22/lab/ch22/extra.sh) | `bash lab/ch22/extra.sh`（在 `git archive` 出来的副本里） | 写出 4 张 PNG，`ch22-zipf.png` 61,921 字节；`+31 -0` |
| [`float32_vs_64.py`](https://github.com/bfmhno3/sift/blob/ch22/lab/ch22/float32_vs_64.py) | `python3 lab/ch22/float32_vs_64.py \| grep top-10` | `documents whose top-10 differs: 0 of 123`；`+49 -0` |
| [`heaps.py`](https://github.com/bfmhno3/sift/blob/ch22/lab/ch22/heaps.py) | `python3 lab/ch22/heaps.py \| sed -n 2p` | `V(n) = 17.13 * n^0.621`；`+29 -0` |
| [`matplotlib_oo.py`](https://github.com/bfmhno3/sift/blob/ch22/lab/ch22/matplotlib_oo.py) | `python3 lab/ch22/matplotlib_oo.py \| tail -1` | `rcParams font.family: ['sans-serif']`；`+59 -0` |
| [`ndarray_basics.py`](https://github.com/bfmhno3/sift/blob/ch22/lab/ch22/ndarray_basics.py) | `python3 lab/ch22/ndarray_basics.py \| tail -1` | `u @ u = 25.0 (the dot product), u * u = [9.0, 16.0]`；`+46 -0` |
| [`pandas_query_log.py`](https://github.com/bfmhno3/sift/blob/ch22/lab/ch22/pandas_query_log.py) | `python3 lab/ch22/pandas_query_log.py \| sed -n 1p` | `60 rows after 5 runs`；`+51 -0` |
| [`pandas_tour.py`](https://github.com/bfmhno3/sift/blob/ch22/lab/ch22/pandas_tour.py) | `python3 lab/ch22/pandas_tour.py \| tail -1` | `one .loc call did write: 123 rows`；`+83 -0` |
| [`posts_per_month.py`](https://github.com/bfmhno3/sift/blob/ch22/lab/ch22/posts_per_month.py) | `python3 lab/ch22/posts_per_month.py \| sed -n 4p` | `peak: 2026-10 with 85 posts`；`+26 -0` |
| [`similar_demo.py`](https://github.com/bfmhno3/sift/blob/ch22/lab/ch22/similar_demo.py) | `python3 lab/ch22/similar_demo.py \| tail -1` | 最后一行是 0.382 那一对（树遍历解释器和栈式虚拟机）；`+37 -0` |
| [`vectorize_speedup.py`](https://github.com/bfmhno3/sift/blob/ch22/lab/ch22/vectorize_speedup.py) | `python3 lab/ch22/vectorize_speedup.py \| sed -n 1p` | `123 documents x 81167 terms`；`+57 -0` |
| [`zipf.py`](https://github.com/bfmhno3/sift/blob/ch22/lab/ch22/zipf.py) | `python3 lab/ch22/zipf.py \| sed -n 1p` | `81167 terms, 792920 tokens`；`+36 -0` |
| [`pyproject.toml`](https://github.com/bfmhno3/sift/blob/ch22/pyproject.toml) | `python3 -c "import tomllib; ..."` 读 `data` 可选依赖 | `['numpy>=2.5', 'pandas>=3.0', 'matplotlib>=3.11']`；`+5 -0` |
| [`__init__.py`](https://github.com/bfmhno3/sift/blob/ch22/src/sift/analytics/__init__.py) | `python3 -c "import sys, sift.analytics; print('numpy' in sys.modules)"` | `False`；`+6 -0` |
| [`plots.py`](https://github.com/bfmhno3/sift/blob/ch22/src/sift/analytics/plots.py) | `python3 -m pytest tests/test_analytics.py -k "configure or write_report"` | `3 passed, 17 deselected in 2.23s`；`+203 -0` |
| [`report.py`](https://github.com/bfmhno3/sift/blob/ch22/src/sift/analytics/report.py) | `python3 -m pytest tests/test_analytics.py -k write_report` | `1 passed, 19 deselected in 2.35s`；`+61 -0` |
| [`stats.py`](https://github.com/bfmhno3/sift/blob/ch22/src/sift/analytics/stats.py) | `python3 -m pytest tests/test_analytics.py -k "zipf or power_law or vocabulary or corpus_frame or posts_per_month or query_log or term_counts"` | `10 passed, 10 deselected in 1.49s`；`+143 -0` |
| [`vectors.py`](https://github.com/bfmhno3/sift/blob/ch22/src/sift/analytics/vectors.py) | `python3 -m pytest tests/test_analytics.py -k "matrix or similar or top_pairs or itself"` | `7 passed, 13 deselected in 1.39s`；`+111 -0` |
| [`cli.py`](https://github.com/bfmhno3/sift/blob/ch22/src/sift/cli.py) | `python3 -m pytest tests/test_cli.py -k "similar or report or bench_search or heavy"` | `9 passed, 149 deselected in 3.00s`；`+99 -16` |
| [`test_analytics.py`](https://github.com/bfmhno3/sift/blob/ch22/tests/test_analytics.py) | `python3 -m pytest tests/test_analytics.py` | `20 passed in 2.48s`；`+211 -0` |
| [`test_cli.py`](https://github.com/bfmhno3/sift/blob/ch22/tests/test_cli.py) | `python3 -m pytest tests/test_cli.py` | `158 passed in 12.10s`；`+67 -2` |

整个测试套件是 `1057 passed, 1 xfailed, 1 warning in 46.74s`，格式、静态检查和两个类型检查器的结果在上面“测试与类型”一节。

## 练习

**1.** 修 `query_log_frame` 的连接泄漏：用 `contextlib.closing` 包住 `sqlite3.connect`。先写测试：`warnings.catch_warnings(record=True)` 加 `simplefilter("always")`，断言调用并 `gc.collect()` 之后没有 `ResourceWarning`，确认它先红后绿。再想想：`ResourceWarning` 是在垃圾回收时发出的，这对“测试里什么时候能看到它”意味着什么？

**2.** 把 `tfidf_matrix` 的结果改成 `scipy.sparse.csr_matrix`（需要自己把 `scipy` 加进开发环境）。先预测：289,357 个非零元素，内存会是前面估计的 2.2 MiB 吗？`matrix @ row` 会比稠密的 1.17 毫秒快还是慢？再量。如果慢，是为什么？

**3.** 把 `zipf_fit` 换成对数分箱：在 $\log r$ 上等距取 30 个点，每个点取该区间内词频的平均，再拟合。先写下预测：全部排名的指数还会是 $-1.152$ 吗？它会更接近 $-0.74$ 还是 $-1.13$？用 `local_slopes.py` 的分段结果对照。

**4.** 修字体：用 `fontTools.varLib.instancer` 从 `NotoSansCJK-VF.otf.ttc` 的 SC 面切出 `wght=400` 的静态实例，存成 `.otf`，把 `SIFT_CJK_FONT` 指过去，重画 `zipf.png`，打开比较笔画粗细。同时对比 JP 面和 SC 面画出的同一个标题里，有没有字形不同的汉字。

**5.** 找出 74 倍那一档的成因：我只证明了它和 OpenMP 线程数有关。用 `strace -f -c`、`perf sched` 或者 `OPENBLAS_VERBOSE=2` 去看慢档的进程里线程在干什么；先预测慢档和快档的线程在哪个系统调用上的时间不同。

## 下一篇

下一篇是《[性能：剖析、字节码特化与优化](/posts/python-by-sift-23-profiling-performance/)》。这一篇我反复撞到同一件事：数据分析里“快”集中在 `matrix @ vector` 这一行，而整条命令的时间，大半花在乘法之前的 Python 循环和解码上。下一篇我想把这种问题系统地量一遍：先用剖析器看时间到底花在哪，再看 Python 3.14 的解释器怎样把字节码特化得更快，最后说说什么时候该动手优化，什么时候不该。
