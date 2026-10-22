---
title: "BM25 与查询语言：match/case 和递归下降"
commentId: "post:python-by-sift-08-bm25-query-language"
published: "2026-10-22 21:00:00 +08:00"
description: "用 Sift 重学 Python 第 8 篇：我在 Python 3.14.7 里给 Sift 写了 BM25 排序、递归下降的查询解析器、冻结数据类组成的语法树、用 match/case 写的求值器、带位置的短语查询和用 t-string 渲染的片段，沿途把 heapq、bisect、浮点误差和结构化模式匹配各跑一遍；12 条基准查询的延迟合计 856 ms，其中 99.6% 花在生成片段上，解析、求值和评分加起来只有 3.4 ms。"
category: Tutorial
tags:
  - Python
  - Sift
  - 搜索引擎
  - BM25
  - 模式匹配
  - 解析器
series: "用 Sift 重学 Python"
seriesOrder: 8
draft: false
comment: true
slug: python-by-sift-08-bm25-query-language
---

上一篇结束时，Sift 还只会把空格分隔的词当成 AND，再按 TF-IDF 排序。这一篇给它加上查询语言、BM25 和片段高亮，于是带引号的短语终于能搜了：`"device tree"` 的第一名是 `devicetree-study-notes.md`，命中的词在片段里用方括号标了出来（输出里超过 96 列的行我用 `fold -s -w 96` 折过，所以续行没有缩进）：

```text
$ python3 -m sift search '"device tree"' 2>/dev/null \
  | fold -s -w 96 | head -5
 1    6.246  corpus/posts/devicetree-study-notes.md
    设备树入门：从第一份 DTS 到 Linux 驱动匹配
    …安装工具，而不是编造一段"成功输出"。在 Debian/Ubuntu 上通常由 [device]-[tree]-compiler
包提供，其他发行版请查自己的包管理器。 [!CAUTION] 工具检查。 如果 dtc 不在 PATH 中，请先安装
[Device] [Tree] Compiler。后续编译、反编译和 magic 检查…
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch08`：新增 `src/sift/query/` 包，里面有 `lexer.py`、`parser.py`、`ast.py`、`evaluate.py`、`errors.py` 和 `__init__.py`；还新增 `src/sift/search.py` 和 `src/sift/snippet.py`；`scoring.py` 多了 `bm25` 和 `top_k`；`index.py` 多了 `title_index` 和 `terms_with_prefix`；`__main__.py` 的 `search` 改成用 `Searcher`，还多了 `bench` 子命令，原来的 `search_index` 搬进了 `lab/ch04/tfidf_vs_tf.py`。这些文件都不是终稿：`errors.py` 是临时的，第 9 篇把 `QuerySyntaxError` 搬进 `sift/errors.py`；`index.py` 和 `__main__.py` 之后的章节还会动；`search.py` 和 `snippet.py` 里被我量出来的毛病，这一篇只量不修。`make ch08` 通过，`lab/ch08` 下 13 个文件按预期退出（12 个正常，1 个按预期失败）。
> 涉及的 Python 特性：`math.log`、`math.fsum` 与 `sum()` 的补偿求和、`decimal` 与 `fractions`、`heapq`、`bisect`、生成器、递归下降、`@dataclass(frozen=True, slots=True)`、PEP 695 的 `type` 语句、结构化模式匹配（字面量、捕获、通配、类、序列、映射、OR、守卫、`as`）、`__match_args__`、`typing.assert_never`、`itertools.accumulate`、PEP 750 的 t-string。
> 前置：[第 7 篇](/posts/python-by-sift-07-inheritance-protocols/)，需要读得懂 `InvertedIndex`、`PostingList` 和 `Pipeline`。

这一篇的账不全是好看的。BM25 本身没有毛病，毛病在它周围：12 条基准查询加起来 856 ms，解析、求值和评分只占 3.4 ms，其余全花在给每个命中文档生成片段上；索引还是要 2 秒；高亮会标出每一个命中的词，而不是整条短语；标题不计入文档长度，也不给分；`-词` 是不带全集的集合差；嵌套 250 层括号会让解析器抛 `RecursionError`；`match` 的类模式比 `isinstance` 链慢一倍多。每一笔都放在它出现的地方，量过才说。

## 环境

和前几篇同一台机器，仓库在标签 `ch08`，命令都在 `nix develop` 里、仓库根目录 `~/Projects/sift` 下跑：

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ git describe --tags
ch08
```

CPU 是 AMD Ryzen 7 PRO 6850U，内存 30 GiB。每组对比，各个候选轮流跑（A、B、A、B……，轮数在每个脚本里写明），离群值不剔除，看最小值和中位数。不同会话之间同一个量能差 5% 左右，所以我只拿同一次会话里的数互相比。`ch07` 和 `ch08` 要放在同一个会话里比索引构建，做法和上一篇一样：用 `git archive` 各导出一份到 `/tmp/p08`，语料用符号链接共享，函数 `at` 把 `PYTHONPATH` 里仓库的 `src` 换成导出目录：

```bash
mkdir -p /tmp/p08/ch07 /tmp/p08/ch08 /tmp/p08/scratch /tmp/p08/cpython
for c in ch07 ch08; do
  git -C ~/Projects/sift archive $c | tar -x -C /tmp/p08/$c
  ln -s ~/Projects/sift/corpus /tmp/p08/$c/corpus
done
SITE=${PYTHONPATH#*:}
at() { (cd /tmp/p08/$1 && PYTHONPATH=/tmp/p08/$1/src:$SITE python3 "${@:2}"); }
```

CPython 的源码我直接 `curl` `v3.14.7` 标签下的原文，下文引用的行号都是这个标签下的行号：

```bash
cd /tmp/p08/cpython
for f in Include/object.h Lib/heapq.py Lib/html/__init__.py \
         Lib/string/templatelib.py Modules/_bisectmodule.c \
         Objects/typevarobject.c Python/bltinmodule.c \
         Python/bytecodes.c Python/ceval.c; do
  mkdir -p $(dirname $f)
  curl -sSfL https://raw.githubusercontent.com/python/cpython/v3.14.7/$f -o $f
done
```

`lab/ch08` 里的是仓库文件，节选处标了行号，命令都在仓库根目录跑；放在 `/tmp/p08/scratch/` 的是只为这篇写的脚本，不进仓库，我贴全文，带 `main()` 和 `__main__` 守卫。仓库和 CPython 的节选都是按行号原样截出来的，省略的部分用 `# ...` 或 `/* ... */` 标出。命令末尾的 `2>/dev/null` 去掉的是第 4 篇 `@timed` 打到 stderr 的 `load_index took ... ms`。输出里的主目录路径换成了 `~`，行尾空格去掉了。

## 从 TF-IDF 到 BM25

第 4 篇的 TF-IDF 把一个词在一篇文档里的权重算成 $tf \cdot \ln(1 + N/df)$。它有两个毛病：词频线性增长，出现 200 次的文档比出现 20 次的高十倍；长文档词多，天然占便宜。BM25 把这两处各修一遍。设 $N$ 是文档数，$n_t$ 是含有词 $t$ 的文档数（代码里叫 `df`），$f_{t,d}$ 是 $t$ 在文档 $d$ 里出现的次数，$|d|$ 是文档长度（词元数），$\mathrm{avgdl}$ 是平均文档长度：

$$
\mathrm{score}(q, d) = \sum_{t \in q} \ln\left(1 + \frac{N - n_t + 0.5}{n_t + 0.5}\right) \cdot \frac{f_{t,d}\,(k_1 + 1)}{f_{t,d} + k_1\left(1 - b + b\,\frac{|d|}{\mathrm{avgdl}}\right)}
$$

对着 `src/sift/scoring.py` 第 25 到 43 行看，一行对一项。前面的对数是 IDF，分式是词频饱和，`norm` 是长度归一化：

```python
def bm25(
    tf: int,
    df: int,
    doc_len: int,
    avg_len: float,
    n_docs: int,
    k1: float = 1.2,
    b: float = 0.75,
) -> float:
    """Return the BM25 weight of a term in one document.

    ``idf = log(1 + (n_docs - df + 0.5) / (df + 0.5))`` is never
    negative. The tf part saturates: ``tf * (k1 + 1) / (tf + k1 *
    norm)`` with ``norm = 1 - b + b * doc_len / avg_len``. b = 0 turns
    length normalization off, b = 1 applies it fully.
    """
    idf_part = math.log(1 + (n_docs - df + 0.5) / (df + 0.5))
    norm = 1 - b + b * doc_len / avg_len
    return idf_part * tf * (k1 + 1) / (tf + k1 * norm)
```

我取 $k_1 = 1.2$、$b = 0.75$，这是我从别处沿用的取值，不是在这个语料上调出来的。`lab/ch08/bm25_by_hand.py` 对 `kalman filter` 的第一名手算一遍，把每个因子都打出来（第 30 到 33 行）：

```python
        idf = math.log(1 + (n_docs - df + 0.5) / (df + 0.5))
        sat = tf * (K1 + 1) / (tf + K1 * norm)
        score = idf * sat
        total += score
```

```text
$ python3 lab/ch08/bm25_by_hand.py 2>/dev/null
query 'kalman filter', document kalman-filter-02-multivariate.md
N = 123, avgdl = 6604.37, dl = 10945
k1 = 1.2, b = 0.75, norm = 1 - b + b * dl / avgdl = 1.4929
term 'kalman': tf = 7, df = 8
  idf = ln(1 + (N - df + 0.5) / (df + 0.5)) = 2.6802
  tf * (k1 + 1) / (tf + k1 * norm) = 1.7517
  idf * that = 4.6949
  bm25() says 4.6949
term 'filter': tf = 10, df = 18
  idf = ln(1 + (N - df + 0.5) / (df + 0.5)) = 1.9025
  tf * (k1 + 1) / (tf + k1 * norm) = 1.8657
  idf * that = 3.5496
  bm25() says 3.5496
sum = 8.244513, Searcher score = 8.244513
```

第一名 `kalman-filter-02-multivariate.md` 有 10,945 个词元，是平均长度 6,604 的 1.66 倍，所以 `norm` 是 1.4929，大于 1：长度在扣它的分。`kalman` 出现 7 次，`filter` 出现 10 次，但 `filter` 的权重 (3.5496) 反而低，因为它的 `df` 是 18，`kalman` 只有 8，IDF 是 1.9025 对 2.6802。两项相加是 8.244513，和 `Searcher` 给的分一致（脚本末尾的 `math.isclose` 断言过）。

### IDF 为什么要加 1

教科书里的 Robertson-Sparck Jones 形式是 $\ln\frac{N - n_t + 0.5}{n_t + 0.5}$，没有外面的 `1 +`。当 $n_t > N/2$，分式小于 1，对数变负：一个词出现在一半以上的文档里，包含它反而扣分。`bm25()` 的文档字符串说它“never negative”，我不想只信注释，写了 `/tmp/p08/scratch/idf_variants.py`，在真实的文档频率上把三种 IDF 摆在一起：

```python
"""Compare three IDF formulas on the real document frequencies."""

import math

from sift.__main__ import CORPUS, load_index
from sift.analysis import build_pipeline


def classic(df: int, n: int) -> float:
    """Robertson and Sparck Jones: negative once df > n / 2."""
    return math.log((n - df + 0.5) / (df + 0.5))


def lucene(df: int, n: int) -> float:
    """The variant in sift.scoring.bm25: add 1 inside the log."""
    return math.log(1 + (n - df + 0.5) / (df + 0.5))


def smooth(df: int, n: int) -> float:
    """The ch04 TF-IDF variant: log(1 + n / df)."""
    return math.log(1 + n / df)


def main() -> None:
    """Print the formulas at four df values and count the damage."""
    _, index = load_index(CORPUS, build_pipeline())
    n = index.n_docs
    print(f"N = {n}")
    print(f"{'df':>4} {'classic':>8} {'lucene':>8} {'ch04':>8}")
    for df in (1, 8, 61, 62, 100, 123):
        print(
            f"{df:>4} {classic(df, n):8.4f} {lucene(df, n):8.4f} "
            f"{smooth(df, n):8.4f}"
        )
    dfs = {term: len(plist) for term, plist in index.items()}
    negative = sorted(
        (t for t, df in dfs.items() if classic(df, n) < 0),
        key=lambda t: -dfs[t],
    )
    print(f"terms with classic idf < 0: {len(negative)} of {len(dfs)}")
    print("most common:", [(t, dfs[t]) for t in negative[:6]])
    print(
        "lucene min over vocabulary:", min(lucene(d, n) for d in dfs.values())
    )


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p08/scratch/idf_variants.py 2>/dev/null
N = 123
  df  classic   lucene     ch04
   1   4.4026   4.4148   4.8203
   8   2.6092   2.6802   2.7958
  61   0.0161   0.7012   1.1041
  62  -0.0161   0.6851   1.0932
 100  -1.4532   0.2101   0.8020
 123  -5.5094   0.0040   0.6931
terms with classic idf < 0: 374 of 81192
most common: [('1', 122), ('2', 122), ('一个', 120), ('3', 120), ('这个', 119), ('4', 118)]
lucene min over vocabulary: 0.012170535620255114
```

`df = 62` 刚过一半 ($N/2 = 61.5$)，经典公式就成了 $-0.0161$，到 `df = 123` 是 $-5.5094$。81,192 个词里有 374 个会得到负权重，最常见的是 `1`、`2`、`一个`、`3`、`这个`。加 1 之后整个词表里最小的 IDF 是 0.0122，仍然是正的，代价是低 `df` 处数值略有不同（`df = 1` 时 4.4148 对 4.4026）。第 4 篇的 `idf()` ($\ln(1 + N/df)$) 是第三种写法，还留在 `scoring.py` 里给 `tf_idf` 用；`bm25()` 没有调用它，而是每个 posting 重算一次 `math.log`，这一点留在练习里。

### 词频饱和和长度归一化

`/tmp/p08/scratch/bm25_shapes.py` 固定 `df = 8`，只让 `tf`、文档长度、$k_1$ 和 $b$ 变：

```python
"""Saturation and length normalization of the BM25 tf factor."""

from sift.scoring import bm25

N, DF, AVG = 123, 8, 6604.37


def main() -> None:
    """Print the weight of one term for growing tf and doc_len."""
    print("tf saturation (dl = avgdl, b = 0.75):")
    for k1 in (0.5, 1.2, 2.0):
        row = [
            bm25(tf, DF, AVG, AVG, N, k1, 0.75) for tf in (1, 2, 5, 20, 200)
        ]
        limit = bm25(10**9, DF, AVG, AVG, N, k1, 0.75)
        cells = " ".join(f"{w:6.3f}" for w in row)
        print(f"  k1 = {k1:<3} tf 1,2,5,20,200: {cells}   limit {limit:6.3f}")
    print("length normalization (tf = 5, k1 = 1.2):")
    for b in (0, 0.75, 1):
        row = [bm25(5, DF, AVG * f, AVG, N, 1.2, b) for f in (0.25, 1, 4)]
        cells = " ".join(f"{w:6.3f}" for w in row)
        print(f"  b = {b:<4} dl = 0.25, 1, 4 x avgdl: {cells}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p08/scratch/bm25_shapes.py
tf saturation (dl = avgdl, b = 0.75):
  k1 = 0.5 tf 1,2,5,20,200:  2.680  3.216  3.655  3.922  4.010   limit  4.020
  k1 = 1.2 tf 1,2,5,20,200:  2.680  3.685  4.755  5.563  5.861   limit  5.896
  k1 = 2.0 tf 1,2,5,20,200:  2.680  4.020  5.743  7.310  7.961   limit  8.041
length normalization (tf = 5, k1 = 1.2):
  b = 0    dl = 0.25, 1, 4 x avgdl:  4.755  4.755  4.755
  b = 0.75 dl = 0.25, 1, 4 x avgdl:  5.336  4.755  3.313
  b = 1    dl = 0.25, 1, 4 x avgdl:  5.563  4.755  3.008
```

第一块是饱和。$tf \to \infty$ 时词频因子趋向 $k_1 + 1$，所以权重的上限是 $\mathrm{idf} \cdot (k_1 + 1)$：$k_1 = 1.2$ 时 $2.6802 \times 2.2 = 5.896$，和 `limit` 一列对得上。`tf` 从 20 涨到 200，权重只从 5.563 涨到 5.861。第二块是长度归一化。批改作文时，“提到主题的次数”如果不按篇幅折算，十页的文章总比一页的占便宜；$b$ 就是这个折算的力度。$b = 0$ 不折算，三种长度都是 4.755；$b = 1$ 时，长度是平均值 4 倍的文档拿 3.008，0.25 倍的拿 5.563。无论 $b$ 取多少，$|d| = \mathrm{avgdl}$ 时 $\mathrm{norm}$ 恰好是 1。这个类比我只用这一次。

`lab/ch08/bm25_params.py` 把 $k_1 \in \{0.5, 1.2, 2.0\}$ 和 $b \in \{0, 0.75, 1\}$ 的九种组合各跑一遍 `kalman filter`，打印前三名（第 19 到 23 行）：

```python
    for k1, b in product(K1S, BS):
        searcher = Searcher(index, k1=k1, b=b, pipeline=pipeline)
        hits = searcher.search(QUERY, limit=3).hits
        names = ", ".join(f"{h.path.stem[:28]} {h.score:.2f}" for h in hits)
        print(f"k1={k1:<3} b={b:<4} {names}")
```

```text
$ python3 lab/ch08/bm25_params.py 2>/dev/null | fold -s -w 96
query 'kalman filter'
k1=0.5 b=0    kalman-filter-02-multivariat 6.47, kalman-filter-07-ukf 6.35,
kalman-filter-06-eskf 6.29
k1=0.5 b=0.75 kalman-filter-02-multivariat 6.29, kalman-filter-07-ukf 6.14,
kalman-filter-06-eskf 6.14
k1=0.5 b=1    kalman-filter-02-multivariat 6.23, kalman-filter-06-eskf 6.09,
kalman-filter-07-ukf 6.08
k1=1.2 b=0    kalman-filter-02-multivariat 8.77, kalman-filter-07-ukf 8.40,
kalman-filter-06-eskf 8.24
k1=1.2 b=0.75 kalman-filter-02-multivariat 8.24, kalman-filter-07-ukf 7.84,
kalman-filter-06-eskf 7.84
k1=1.2 b=1    kalman-filter-02-multivariat 8.08, kalman-filter-06-eskf 7.71,
kalman-filter-07-ukf 7.67
k1=2.0 b=0    kalman-filter-02-multivariat 11.01, kalman-filter-07-ukf 10.31,
kalman-filter-06-eskf 10.02
k1=2.0 b=0.75 kalman-filter-02-multivariat 10.03, kalman-filter-07-ukf 9.32,
kalman-filter-06-eskf 9.31
k1=2.0 b=1    kalman-filter-02-multivariat 9.74, kalman-filter-06-eskf 9.09,
kalman-filter-07-ukf 9.03
```

九组里前三名的集合都一样，分数大致随 $k_1 + 1$ 缩放（第一名 6.29、8.24、10.03），名次只在 $b = 1$ 时变了一次：长度完全折算后，较短的 `06-eskf`（9,120 个词元）越过了 `07-ukf`（10,361 个）；$b = 0.75$ 时两者只差 0.009。我没有相关性标注，没法说哪一组更好，只能说在这个 123 篇的语料上，这些参数对 `kalman filter` 的影响很小。（在 123 篇文档上调超参数，调出来的多半是我自己的偏见。）

## 浮点：分数是怎么加起来的

分数是一串 `float` 加出来的，所以把浮点的坑顺手过一遍。`lab/ch08/float_pitfalls.py` 的核心几行（第 22 到 29 行）：

```python
    tenth = [0.1] * 10
    print("loop  [0.1] * 10 =", naive_sum(tenth))
    print("sum   [0.1] * 10 =", sum(tenth), "(compensated since 3.12)")
    print("fsum  [0.1] * 10 =", math.fsum(tenth))
    big = [1e16, 1.0, -1e16]
    print("loop  [1e16, 1, -1e16] =", naive_sum(big), "(the 1 is lost)")
    print("sum   [1e16, 1, -1e16] =", sum(big))
    print("fsum  [1e16, 1, -1e16] =", math.fsum(big))
```

```text
$ python3 lab/ch08/float_pitfalls.py
0.1 + 0.2 = 0.30000000000000004 == 0.3 ? False
math.isclose(0.1 + 0.2, 0.3): True
loop  [0.1] * 10 = 0.9999999999999999
sum   [0.1] * 10 = 1.0 (compensated since 3.12)
fsum  [0.1] * 10 = 1.0
loop  [1e16, 1, -1e16] = 0.0 (the 1 is lost)
sum   [1e16, 1, -1e16] = 1.0
fsum  [1e16, 1, -1e16] = 1.0
100000 scores in two orders:
  loop forward  501545.19271576783
  loop backward 501545.19271576067
  sum           501545.19271576125
  fsum          501545.19271576125
Decimal('0.1') * 3 = 0.3
Decimal(0.1) = 0.1000000000000000055511151231257827021181583404541015625
Fraction(1, 10) * 3 = 3/10
Fraction(0.1) = 3602879701896397/36028797018963968
float.as_integer_ratio(0.1) = (3602879701896397, 36028797018963968)
math.log(1 + 1e-18) = 0.0
math.log1p(1e-18) = 1e-18
```

前三行是老故事：`0.1 + 0.2 != 0.3`，所以断言浮点结果用 `math.isclose`。接着有个新东西：把十个 `0.1` 加起来，手写循环得 `0.9999999999999999`，`sum()` 得 `1.0`。从 3.12 起 `sum()` 对浮点用的是 Neumaier 补偿求和，不再是朴素的从左到右加。`Python/bltinmodule.c` 里累加器是一对 `hi`、`lo`，`lo` 记着每一步丢掉的低位（第 2741 到 2744 行、2752 到 2763 行），浮点的快速路径用的就是它（第 2888 到 2900 行）：

```c
typedef struct {
    double hi;     /* high-order bits for a running sum */
    double lo;     /* a running compensation for lost low-order bits */
} CompensatedSum;
/* ... */
static inline CompensatedSum
cs_add(CompensatedSum total, double x)
{
    double t = total.hi + x;
    if (fabs(total.hi) >= fabs(x)) {
        total.lo += (total.hi - t) + x;
    }
    else {
        total.lo += (x - t) + total.hi;
    }
    return (CompensatedSum) {t, total.lo};
}
```

所以 `[1e16, 1.0, -1e16]` 用循环得 `0.0`（那个 1 在加到 `1e16` 时被吞了），`sum()` 和 `math.fsum` 都得 `1.0`。`fsum` 用的是另一套算法，记着一串部分和，这几个例子里它和 `sum()` 的结果一致；`sum()` 的补偿只是把误差压到很小，不保证精确。最后四行是 10 万个随机数：正着加和倒着加，循环结果从小数点后第 9 位起就不同了，`sum` 和 `fsum` 恰好一致。

补偿只有 `sum()` 能享受。`Searcher.search` 是这样加分的：`scores[posting.doc_id] += bm25(...)`，一个普通循环，按叶子的顺序一项一项加。叶子的顺序变了，和会变吗？`/tmp/p08/scratch/float_order.py` 把 `positive_leaves` 的结果倒过来再搜一遍，逐篇比较：

```python
"""Does the order of the leaves change a BM25 score or a ranking?"""

import sift.search as search_module
from sift.__main__ import CORPUS, load_index
from sift.analysis import build_pipeline
from sift.search import Searcher

QUERIES = [
    "kalman OR filter OR state OR estimate OR covariance OR matrix",
    "rust OR ownership OR borrow OR lifetime OR trait OR generic",
]


def scores_of(searcher: Searcher, query: str) -> dict[int, float]:
    """Return doc_id -> score for every matching document."""
    result = searcher.search(query, limit=200)
    return {hit.doc_id: hit.score for hit in result.hits}


def main() -> None:
    """Sum the leaves forward, then backward, and compare."""
    pipeline = build_pipeline()
    _, index = load_index(CORPUS, pipeline)
    searcher = Searcher(index, pipeline=pipeline)
    forward_leaves = search_module.positive_leaves
    for query in QUERIES:
        forward = scores_of(searcher, query)
        search_module.positive_leaves = lambda node: forward_leaves(node)[::-1]
        backward = scores_of(searcher, query)
        search_module.positive_leaves = forward_leaves
        differ = [d for d in forward if forward[d] != backward[d]]
        worst = max((abs(forward[d] - backward[d]) for d in differ), default=0)
        top = sorted(forward, key=lambda d: (-forward[d], d))[:10]
        top_back = sorted(backward, key=lambda d: (-backward[d], d))[:10]
        print(query)
        print(
            f"  {len(forward)} docs, {len(differ)} differ, "
            f"max diff {worst:.1e}, top 10 same: {top == top_back}"
        )


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p08/scratch/float_order.py 2>/dev/null
kalman OR filter OR state OR estimate OR covariance OR matrix
  57 docs, 1 differ, max diff 3.6e-15, top 10 same: True
rust OR ownership OR borrow OR lifetime OR trait OR generic
  44 docs, 3 differ, max diff 3.6e-15, top 10 same: True
```

两条各六个词的 OR 查询里，分别有 1 篇和 3 篇文档的分数在最后一两位上不同（最大差 $3.6 \times 10^{-15}$），前十名的顺序一次都没变。我猜它只在两篇文档的数学分数恰好相等时才会伤人：`top_k` 用 `(score, -doc_id)` 当键，两个数学上相等的分数可能因为舍入差一个 ulp，名次由舍入的运气决定，而不是由文档编号决定。我没有构造出这样的例子，所以这只是猜测。想消除它，可以把每个叶子的贡献收集起来再 `math.fsum`，放在练习里。

`Decimal(0.1)` 打出 0.1 的精确二进制值，`Fraction(0.1)` 是 `3602879701896397/36028797018963968`，和 `float.as_integer_ratio` 一致。它们是精确的，但 BM25 用不上：IDF 里有个对数，结果本来就不是有理数。最后两行说的是 `math.log1p`：`log(1 + 1e-18)` 得 `0.0`，`log1p(1e-18)` 得 `1e-18`。IDF 的自变量最小是 $0.5/(N + 0.5) \approx 0.004$，离 `1e-16` 很远，所以 `bm25()` 里我继续用 `math.log(1 + x)`。

## heapq：只要前 10 名

评分之后要取前 `limit` 个，`top_k` 只有一个表达式（`scoring.py` 第 46 到 54 行）：

```python
def top_k(scores: Mapping[int, float], k: int) -> list[tuple[int, float]]:
    """Return the k best (doc_id, score) pairs, best first.

    heapq.nlargest keeps a heap of k items instead of sorting every
    score. Equal scores are ordered by the smaller doc_id.
    """
    return heapq.nlargest(
        k, scores.items(), key=lambda item: (item[1], -item[0])
    )
```

文档说 `heapq.nlargest(k, iterable, key)` 等价于 `sorted(iterable, key=key, reverse=True)[:k]`，实现是不一样的。`Lib/heapq.py` 的一般路径（第 577 到 593 行）：

```python
    # General case, slowest method
    it = iter(iterable)
    result = [(key(elem), i, elem) for i, elem in zip(range(0, -n, -1), it)]
    if not result:
        return result
    heapify(result)
    top = result[0][0]
    order = -n
    _heapreplace = heapreplace
    for elem in it:
        k = key(elem)
        if top < k:
            _heapreplace(result, (k, order, elem))
            top, _order, _elem = result[0]
            order -= 1
    result.sort(reverse=True)
    return [elem for (k, order, elem) in result]
```

先拿前 `n` 个元素建一个堆，之后每看到一个元素，只有比堆顶大才替换堆顶，最后把这 `n` 个排一次序，代价是 $O(N \log k)$，而不是 $O(N \log N)$。元组里的 `order` 是个递减计数器，键相同时靠它定先后，保证不会去比较元素本身。第 543 到 557 行还有两条捷径：`n == 1` 走 `max()`，`n >= len(iterable)` 直接 `sorted`。我的键是 `(score, -doc_id)`：分数大的在前，同分时 `doc_id` 小的在前，结果是确定的。

`lab/ch08/heap_topk.py` 在 100 万个分数里取前 10，比较 `nlargest` 和全量 `sorted`，但它是各跑 5 次再换下一个，不是交替。为了符合我自己的规矩，我写了 `/tmp/p08/scratch/heap_alt.py`，一轮里先 `nlargest` 后 `sorted`，共 7 轮取最小值：

```python
"""nlargest against sorted, alternating in one process."""

import heapq
import random
import time

N, K, ROUNDS = 1_000_000, 10, 7


def key(item: tuple[int, float]) -> tuple[float, int]:
    """Order by score, then by smaller doc_id."""
    return (item[1], -item[0])


def main() -> None:
    """Run heap, sort, heap, sort, ... and print the minimums."""
    rng = random.Random(1234)
    scores = {doc_id: rng.random() for doc_id in range(N)}
    best = {"nlargest": float("inf"), "sorted": float("inf")}
    for _ in range(ROUNDS):
        for name in best:
            start = time.perf_counter()
            if name == "nlargest":
                heapq.nlargest(K, scores.items(), key=key)
            else:
                sorted(scores.items(), key=key, reverse=True)[:K]
            best[name] = min(best[name], time.perf_counter() - start)
    for name, seconds in best.items():
        print(f"{name:9} {seconds * 1000:8.1f} ms")
    print(f"sorted / nlargest = {best['sorted'] / best['nlargest']:.1f}x")


if __name__ == "__main__":
    main()
```

```text
$ python3 lab/ch08/heap_topk.py
1000000 scores, k = 10, median of 5 runs
heapq.nlargest     105.2 ms
sorted()[:k]      1810.0 ms
sorted / nlargest = 17.20x
$ python3 /tmp/p08/scratch/heap_alt.py
nlargest     106.2 ms
sorted      1747.5 ms
sorted / nlargest = 16.5x
```

两种测法都是 17 倍上下：`nlargest` 106 ms，`sorted` 1.75 s。这个数说的是形状，不是 Sift 的现状：Sift 一次查询最多匹配 123 篇文档（`矩阵 OR matrix` 是 56 篇），在这个规模上两者没有区别，我也没有量。

## bisect：有序列表上的二分

`bisect` 在两个地方用上：前缀查询 `owner*` 和片段窗口的选择。`lab/ch08/bisect_demo.py` 先把基本动作各做一遍（第 16 到 21 行）：

```python
    scores = [10, 20, 20, 20, 30]
    print("scores", scores)
    print("bisect_left(20) =", bisect_left(scores, 20))
    print("bisect_right(20) =", bisect_right(scores, 20))
    print("count of 20 =", bisect_right(scores, 20) - bisect_left(scores, 20))
    insort(scores, 25)
```

```text
$ python3 lab/ch08/bisect_demo.py
scores [10, 20, 20, 20, 30]
bisect_left(20) = 1
bisect_right(20) = 4
count of 20 = 3
after insort(25): [10, 20, 20, 20, 25, 30]
key=: 1
terms with prefix 'owner': ['owner', 'ownership']
mini corpus vocabulary: 613
terms_with_prefix('tea') = ['tea', 'team', 'teapot']
terms_with_prefix('bicycle') = ['bicycle']
terms_with_prefix('zzz') = []
```

`bisect_left(20)` 是第一个 20 的位置，`bisect_right(20)` 是最后一个 20 之后的位置，两者之差是 20 出现的次数。`insort` 在插入的同时保持有序，所以 25 落在 20 和 30 之间；`key=` 让比较作用在 `p[1]` 上，`bisect_left(people, 4, key=lambda p: p[1])` 给出的 1 是 4 在 3、5、8 里的插入位置。前缀查询用的是同一个想法：在排好序的词表里，所有以 `owner` 开头的词，排在 `"owner"` 和 `"owner" + "\U0010ffff"` 之间，`\U0010ffff` 是最大的码点。`InvertedIndex.terms_with_prefix`（`index.py` 第 192 到 204 行）：

```python
    def terms_with_prefix(self, prefix: str) -> list[str]:
        """Return the sorted body terms that start with prefix.

        The sorted vocabulary is built on the first call after an
        add and found by bisection: every term with the prefix lies
        between prefix and prefix followed by the largest code point.
        """
        if self._sorted_terms is None:
            self._sorted_terms = sorted(self._postings)
        terms = self._sorted_terms
        lo = bisect_left(terms, prefix)
        hi = bisect_left(terms, prefix + "\U0010ffff")
        return terms[lo:hi]
```

排好序的词表 `_sorted_terms` 是第一次需要时才建的，`add` 会把它置回 `None`。这是个惰性缓存，也是一笔账：

```text
$ python3 -c '
import time
from sift.__main__ import CORPUS, load_index

_, index = load_index(CORPUS)
for _ in range(2):
    start = time.perf_counter()
    found = index.terms_with_prefix("owner")
    print(f"{(time.perf_counter() - start) * 1e6:9.1f} us", found)
' 2>/dev/null
  24032.6 us ['owner', 'ownership']
      6.3 us ['owner', 'ownership']
```

第一次调用 24.0 ms，主要是给 81,192 个词排序；第二次 6.3 µs，相差约 3800 倍。`python3 -m sift bench` 是一次性跑，里面的 `owner*` 比五次取中位数的 `queries_bench.py` 慢了约 27 ms，和这 24 ms 大致吻合，后面的数会再出现。`bisect_left` 的 C 实现在 `Modules/_bisectmodule.c` 第 237 行起：第 262 到 267 行的循环取中点、读元素，第 281 到 294 行是同类型比较的快速路径，每一步少比一半。

## 查询语言

语法是这样的（`parser.py` 的模块文档字符串，第 5 到 13 行）：

```text
    query  := or EOF
    or     := and ("OR" and)*
    and    := unary (("AND")? unary)*
    unary  := "NOT" unary | "-" atom | atom
    atom   := "(" or ")" | PHRASE | FIELD ":" (WORD | PHRASE)
              | WORD "*"?

NOT binds tighter than AND, and AND tighter than OR. Both binary
operators are left-associative.
```

并列写的词是 AND；`AND`、`OR`、`NOT` 只认大写，小写的 `and`、`or` 是普通的词；`-词` 是 `NOT` 的简写；`词*` 是前缀；`title:`、`tag:`、`category:`、`series:` 限定字段。分析器把一个词切成多个词元时（`所有权` 切成 `所有` 和 `有权`），这个词按短语处理，后面会看到。

### 词法分析器是个生成器

`lexer.py` 的 `iter_tokens`（第 58 到 95 行）带 `yield`，调用它不会执行函数体，只会得到一个生成器：

```python
def iter_tokens(query: str) -> Iterator[QToken]:
# ...
    i = 0
    while i < len(query):
        ch = query[i]
        if ch.isspace():
            i += 1
        elif ch in _SINGLE:
            yield QToken(_SINGLE[ch], ch, i)
            i += 1
        elif ch == '"':
            close = query.find('"', i + 1)
            if close == -1:
                raise QuerySyntaxError("unterminated phrase", query, i)
            yield QToken(Kind.PHRASE, query[i + 1 : close], i)
            i = close + 1
        elif ch == "-":
            yield QToken(Kind.MINUS, ch, i)
            i += 1
        else:
            end = _word_end(query, i)
            word = query[i:end]
            if word in _OPERATORS:
                yield QToken(Kind[word], word, i)
            elif end < len(query) and query[end] == ":" and word in FIELDS:
                yield QToken(Kind.FIELD, word, i)
                end += 1
            else:
                yield QToken(Kind.WORD, word, i)
            i = end
    yield QToken(Kind.EOF, "", len(query))
```

`lab/ch08/lexer_demo.py` 打印三条查询的词元（第 14 到 19 行）：

```python
    for query in QUERIES:
        print(repr(query))
        for token in iter_tokens(query):
            print(f"  {token.pos:>2}  {token.kind.name:<6} {token.text!r}")
    stream = iter_tokens("a OR b")
    print(type(stream).__name__, next(stream), next(stream))
```

```text
$ python3 lab/ch08/lexer_demo.py | fold -s -w 96
'tag:Rust "device tree" -latex'
   0  FIELD  'tag'
   4  WORD   'Rust'
   9  PHRASE 'device tree'
  23  MINUS  '-'
  24  WORD   'latex'
  29  EOF    ''
'(pid OR kalman) AND filter*'
   0  LPAREN '('
   1  WORD   'pid'
   5  OR     'OR'
   8  WORD   'kalman'
  14  RPAREN ')'
  16  AND    'AND'
  20  WORD   'filter'
  26  STAR   '*'
  27  EOF    ''
'state-of-the-art and or NOT'
   0  WORD   'state-of-the-art'
  17  WORD   'and'
  21  WORD   'or'
  24  NOT    'NOT'
  27  EOF    ''
generator QToken(kind=<Kind.WORD: 1>, text='a', pos=0) QToken(kind=<Kind.OR: 7>, text='OR',
pos=2)
```

输出里能直接读出几件事。词首的 `-` 是 `MINUS`，词中间的 `-` 是词的一部分：`state-of-the-art` 是一个 `WORD`。`and`、`or` 是 `WORD`，只有大写的 `NOT` 才是 `NOT`。`tag:` 被拆成一个 `FIELD`（偏移 0）和一个 `WORD`（偏移 4），冒号被吃掉了，因为 `_word_end` 在遇到冒号且冒号前面是字段名时停下（第 52 行）。最后一行是 `type(stream).__name__`，即 `generator`，之后两次 `next` 各取一个词元。

不过解析器没有利用生成器的惰性：`_Parser.__init__` 里是 `self.tokens = list(iter_tokens(query))`，先把词元取完，因为它要随时 `peek` 当前词元，用下标比用迭代器方便。生成器在这里的好处，是词法分析器写成了一个顺序的循环，不用手写状态机。

### 递归下降：一条规则一个函数

递归下降是把文法里每条规则写成一个函数，规则里引用另一条规则就调用它。优先级不用单独存表，它就是调用的深度：`or` 调用 `and`，`and` 调用 `unary`，`unary` 调用 `atom`，调用得最深的最先结合。`parser.py` 第 59 到 87 行：

```python
    def parse_or(self) -> Node:
        """Parse ``and ("OR" and)*``."""
        node = self.parse_and()
        while self.peek.kind is Kind.OR:
            self.take()
            node = Or(node, self.parse_and())
        return node

    def parse_and(self) -> Node:
        """Parse ``unary (("AND")? unary)*``."""
        node = self.parse_unary()
        while True:
            if self.peek.kind is Kind.AND:
                self.take()
            elif self.peek.kind not in _STARTS_UNARY:
                return node
            node = And(node, self.parse_unary())

    def parse_unary(self) -> Node:
        """Parse ``"NOT" unary | "-" atom | atom``."""
        match self.peek.kind:
            case Kind.NOT:
                self.take()
                return Not(self.parse_unary())
            case Kind.MINUS:
                self.take()
                return Not(self.parse_atom())
            case _:
                return self.parse_atom()
```

二元运算符的左结合靠 `while` 循环，不靠递归：`a OR b OR c` 在循环里一次次把 `node` 包成 `Or(node, ...)`，得到 `Or(Or(a, b), c)`。并列的 AND 靠 `parse_and` 里的 `elif self.peek.kind not in _STARTS_UNARY`：下一个词元能开头一个 `unary`，就是隐含的 AND（`_STARTS_UNARY` 在第 20 到 22 行）。看几个例子：

```text
$ python3 -c '
from sift.query import parse

for query in ("a b OR c", "a OR b c", "a AND b AND c", "NOT a b", "-a b"):
    print(f"{query:<14}", parse(query))
'
a b OR c       Or(left=And(left=Term(text='a'), right=Term(text='b')), right=Term(text='c'))
a OR b c       Or(left=Term(text='a'), right=And(left=Term(text='b'), right=Term(text='c')))
a AND b AND c  And(left=And(left=Term(text='a'), right=Term(text='b')), right=Term(text='c'))
NOT a b        And(left=Not(operand=Term(text='a')), right=Term(text='b'))
-a b           And(left=Not(operand=Term(text='a')), right=Term(text='b'))
```

`a b OR c` 是 `(a AND b) OR c`，`a OR b c` 是 `a OR (b AND c)`：AND 比 OR 紧。三个 `AND` 左结合。`NOT a b` 和 `-a b` 都是 `(NOT a) AND b`，`NOT` 只管它后面那一个 `unary`。`lab/ch08/parser_demo.py` 把六条查询的树打出来（超过 96 列的几行折过）：

```text
$ python3 lab/ch08/parser_demo.py | fold -s -w 96
kalman filter
   And(left=Term(text='kalman'), right=Term(text='filter'))
pid AND 积分
   And(left=Term(text='pid'), right=Term(text='积分'))
矩阵 OR matrix
   Or(left=Term(text='矩阵'), right=Term(text='matrix'))
typst -latex
   And(left=Term(text='typst'), right=Not(operand=Term(text='latex')))
tag:Rust "device tree" OR title:parser
   Or(left=And(left=Field(name='tag', value=Term(text='Rust')), right=Phrase(words=('device',
'tree'))), right=Field(name='title', value=Term(text='parser')))
a OR b c NOT (d OR e*)
   Or(left=Term(text='a'), right=And(left=And(left=Term(text='b'), right=Term(text='c')),
right=Not(operand=Or(left=Term(text='d'), right=Prefix(text='e')))))
```

最后一条同时用到了并列、OR、NOT、括号和前缀。

### 语法错误

解析器在四个地方抛 `QuerySyntaxError`：词法分析器遇到未闭合的引号；`parse_query` 在查询读完后发现还剩词元（`a )` 里多出来的 `)`）；`parse_atom` 和 `parse_field_value` 遇到不该出现的词元；以及 `parse()` 在最后检查正项。错误类和它的 `render()` 在 `sift/query/errors.py`（第 4 到 21 行），这个位置只是暂时的，第 9 篇才会搬到 `sift/errors.py`：

```python
class QuerySyntaxError(Exception):
    """A query that does not follow the grammar.

    str(error) is the message alone. query is the text that failed
    and position an offset into it.
    """

    def __init__(self, message: str, query: str, position: int) -> None:
        """Keep the message, the query and the offset."""
        super().__init__(message)
        self.message = message
        self.query = query
        self.position = position

    def render(self) -> str:
        """Return the message, the query line and a caret line."""
        caret = " " * self.position + "^"
        return f"{self.message}\n  {self.query}\n  {caret}"
```

`__main__.py` 的 `run_search` 接住它，`sys.exit(error.render())`：把消息、查询和插入符那一行打出来，退出码是 1。几种错：

```text
$ for q in '(rust' '"device tree' '-latex' 'NOT NOT a'; do
  python3 -m sift search "$q" 2>&1 | grep -v '^load_index'
  echo "exit ${PIPESTATUS[0]}"
done
expected ')'
  (rust
       ^
exit 1
unterminated phrase
  "device tree
  ^
exit 1
query needs at least one positive term
  -latex
  ^
exit 1
query needs at least one positive term
  NOT NOT a
  ^
exit 1
```

`NOT NOT a` 在逻辑上等于 `a`，但被拒绝了：`has_positive` 把 `Not` 当成“没有正项”，只看结构，不化简。这是个小毛病，我不修。正项的规则其实比这更严：`or` 的每个分支都得有正项。`typst OR -latex` 和 `-latex OR typst` 都会被拒绝，而 `typst AND (NOT latex OR rust)` 能通过，因为 `And` 只要一侧有正项，`Or` 要两侧都有。

```text
$ python3 -m sift search 'typst OR -latex' 2>&1 | grep -v '^load_index'
query needs at least one positive term
  typst OR -latex
  ^
```

这是故意的：`typst OR -latex` 的意思是“含 typst 的，加上所有不含 latex 的”，求值要先造出整个语料的全集，而 `evaluate` 只在 OR 内部才付这笔钱。还有个更实在的毛病：`run_search` 是先建索引、后解析查询的（`__main__.py` 第 51 到 57 行），所以输错一个括号，要先等 2 秒索引建完才报错：

```text
$ python3 -m sift search '(rust' 2>&1 | head -2
load_index took 1849.2 ms
expected ')'
```

`lab/ch08/syntax_error_demo_fail.py` 反过来，不接这个异常，让它一路冒出来，退出码是 1。完整的回溯有 21 行，我只留 `File` 行和最后一行：

```text
$ python3 lab/ch08/syntax_error_demo_fail.py 2>&1 | grep -E '^  File|^sift'
  File "~/Projects/sift/lab/ch08/syntax_error_demo_fail.py", line 14, in <module>
  File "~/Projects/sift/lab/ch08/syntax_error_demo_fail.py", line 10, in main
  File "~/Projects/sift/src/sift/query/parser.py", line 148, in parse
  File "~/Projects/sift/src/sift/query/parser.py", line 54, in parse_query
  File "~/Projects/sift/src/sift/query/parser.py", line 61, in parse_or
  File "~/Projects/sift/src/sift/query/parser.py", line 69, in parse_and
  File "~/Projects/sift/src/sift/query/parser.py", line 87, in parse_unary
  File "~/Projects/sift/src/sift/query/parser.py", line 96, in parse_atom
sift.query.errors.QuerySyntaxError: expected ')'
```

`parse_query`、`parse_or`、`parse_and`、`parse_unary`、`parse_atom`，五帧就是五条规则的调用链，最后在 `parse_atom` 里发现括号没有闭合。这也引出递归下降的老毛病：嵌套越深，栈越深。每层括号要过 `parse_or`、`parse_and`、`parse_unary`、`parse_atom` 四帧，默认的递归上限是 1000，所以 240 到 250 层之间就到顶了。`/tmp/p08/scratch/deep_parens.py`：

```python
"""How deep can the recursive-descent parser nest parentheses?"""

import sys

from sift.query import QuerySyntaxError, parse


def main() -> None:
    """Parse "((...a...))" at growing depth until the stack runs out."""
    print("recursion limit:", sys.getrecursionlimit())
    for depth in (10, 100, 200, 240, 250, 300, 1000):
        query = "(" * depth + "a" + ")" * depth
        try:
            parse(query)
            outcome = "ok"
        except RecursionError as exc:
            outcome = f"RecursionError: {exc}"
        except QuerySyntaxError as exc:
            outcome = f"QuerySyntaxError: {exc}"
        print(f"depth {depth:>4}: {outcome}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p08/scratch/deep_parens.py
recursion limit: 1000
depth   10: ok
depth  100: ok
depth  200: ok
depth  240: ok
depth  250: RecursionError: maximum recursion depth exceeded
depth  300: RecursionError: maximum recursion depth exceeded
depth 1000: RecursionError: maximum recursion depth exceeded
```

240 层没事，250 层抛的是 `RecursionError`，不是 `QuerySyntaxError`。没人会手敲 250 层括号，但服务器收到的查询未必是人敲的。平铺的长链也一样：`a OR a OR ... OR a` 或者 `a a a ... a`（各 1000 个词）同样抛 `RecursionError`，因为解析出来的是向左倾斜、深度为 n 的树，`has_positive` 沿着它递归。所以给解析器加一个括号深度计数器管不到这一类。这一篇不修，练习里有。

## AST：冻结数据类和 type 语句

解析出来的树由七个类组成（`ast.py` 节选）：

```python
@dataclass(frozen=True, slots=True)
class Term:
    """A word, analyzed when the query is evaluated."""

    text: str
# ...
@dataclass(frozen=True, slots=True)
class Field:
    """A word or phrase restricted to one field."""

    name: str
    value: Node
# ...
type Node = Term | Prefix | Phrase | Field | And | Or | Not
```

`@dataclass(frozen=True, slots=True)` 一行做了好几件事，`/tmp/p08/scratch/ast_facts.py` 逐一验证：

```python
"""What the frozen dataclasses and the type alias give us."""

import dataclasses

from sift.query import Field, Node, Phrase, Term, parse


def main() -> None:
    """Show the alias, the generated methods and what frozen forbids."""
    print("type(Node)      :", type(Node).__name__)
    members = [cls.__name__ for cls in Node.__value__.__args__]
    print("Node.__value__  :", members)
    print("Term.__slots__  :", Term.__slots__)
    print("Term match_args :", Term.__match_args__)
    print("Field match_args:", Field.__match_args__)
    left, right = parse("kalman filter"), parse("kalman  filter")
    print("equal by value  :", left == right, left is right)
    print("as dict key     :", {left: "cached"}[right])
    term = Term("kalman")
    try:
        # error: dataclasses.FrozenInstanceError: cannot assign to field 'text'
        term.text = "pid"  # type: ignore[misc]
    except dataclasses.FrozenInstanceError as exc:
        print("assign          :", type(exc).__name__, exc)
    try:
        # error: TypeError: unhashable type: 'list'
        hash(Phrase(["device", "tree"]))  # type: ignore[arg-type]
    except TypeError as exc:
        print("list in Phrase  :", exc)
    print("replace         :", dataclasses.replace(term, text="pid"))


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p08/scratch/ast_facts.py
type(Node)      : TypeAliasType
Node.__value__  : ['Term', 'Prefix', 'Phrase', 'Field', 'And', 'Or', 'Not']
Term.__slots__  : ('text',)
Term match_args : ('text',)
Field match_args: ('name', 'value')
equal by value  : True False
as dict key     : cached
assign          : FrozenInstanceError cannot assign to field 'text'
list in Phrase  : unhashable type: 'list'
replace         : Term(text='pid')
```

- 不可变：给 `term.text` 赋值抛 `FrozenInstanceError`；要改只能 `dataclasses.replace` 造一个新的。
- 按值相等、可哈希：`frozen=True` 加默认的 `eq=True` 会生成 `__hash__`，所以两次解析出来的树 `==` 为真、`is` 为假，还能当字典键。这也是 `Phrase.words` 写成 `tuple[str, ...]` 的原因：换成列表，`hash` 就是 `unhashable type: 'list'`。
- `slots=True`：实例没有 `__dict__`，`__slots__` 是 `('text',)`。第 6 篇量过它的内存收益，这里不再量。
- `__match_args__` 自动生成：`Term` 是 `('text',)`，`Field` 是 `('name', 'value')`，下一节的类模式靠它。

`type Node = Term | Prefix | ...` 是 PEP 695 的 `type` 语句。它造出来的不是联合类型本身，而是一个 `TypeAliasType`，`Node.__value__` 才是联合。关键是它的惰性：第 32 行的 `Field.value: Node` 在 `Node` 定义之前就引用了它。这里有两层惰性：3.14 的注解本身是延迟求值的，`type` 语句的值也是第一次读 `__value__` 时才算。`/tmp/p08/scratch/lazy_alias.py` 先造出引用未定义名字的类和别名，再把名字补上：

```python
"""Annotations and type aliases are evaluated late in Python 3.14."""

from collections.abc import Callable


def attempt(label: str, fn: Callable[[], object]) -> None:
    """Print fn() or the NameError it raises."""
    try:
        print(f"{label:<28}", fn())
    except NameError as exc:
        print(f"{label:<28} NameError: {exc}")


def main() -> None:
    """Use a name before it exists, then define it."""
    ns: dict[str, object] = {}
    exec("class A:\n    v: B\ntype Alias = Later | None", ns)
    print("A and Alias created, B and Later do not exist yet")
    attempt("A.__annotations__", lambda: ns["A"].__annotations__)
    attempt("Alias.__value__", lambda: ns["Alias"].__value__)
    exec("class Later: pass\nB = int", ns)
    attempt("A.__annotations__", lambda: ns["A"].__annotations__)
    attempt("Alias.__value__", lambda: ns["Alias"].__value__)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p08/scratch/lazy_alias.py
A and Alias created, B and Later do not exist yet
A.__annotations__            NameError: name 'B' is not defined
Alias.__value__              NameError: name 'Later' is not defined
A.__annotations__            {'v': <class 'int'>}
Alias.__value__              Later | None
```

名字没有定义时，读 `__annotations__` 和 `__value__` 都是 `NameError`，补上之后都成功了。别名的值缓存在对象里：`Objects/typevarobject.c` 第 1866 到 1877 行的 `typealias_get_value`，第一次读时调 `compute_value` 并把结果存进 `ta->value`，之后直接返回。

为什么 `Node` 是联合，而不是第 7 篇那样的 ABC 基类？因为这七个类是个封闭的集合，也没有共同的行为要继承；封闭的联合让 `match` 加 `assert_never` 能检查穷尽性，而基类做不到。

## match/case：不只是 switch

PEP 634 的 `match` 不是 C 的 `switch`。`switch` 比较一个值，`match` 描述一个形状，匹配上的同时把形状里的部分绑到名字上。`lab/ch08/match_tour.py` 把每一种模式各用一遍。先是字面量、OR 和通配（第 17 到 25 行），再是序列（第 28 到 40 行）：

```python
def literal(command: str) -> str:
    """Match literals, an OR pattern and a wildcard."""
    match command:
        case "search":
            return "literal"
        case "stats" | "bench":
            return "or-pattern"
        case _:
            return "wildcard"
# ...
def sequence(items: list[int]) -> str:
    """Match sequences with captures and a star pattern."""
    match items:
        case []:
            return "empty"
        case [x]:
            return f"one item {x}"
        case [first, *rest] if first == 0:
            return f"starts with zero, {len(rest)} more"
        case [first, *_, last]:
            return f"first {first}, last {last}"
        case _:
            return "unreachable"
```

`case "stats" | "bench"` 是 OR 模式，`case _` 是通配。序列模式 `[x]` 匹配恰好一个元素，`[first, *rest]` 匹配至少一个，`*rest` 收集剩下的；`if first == 0` 是守卫，模式匹配上之后才检查。然后是映射（第 43 到 51 行）：

```python
def mapping(event: dict[str, object]) -> str:
    """Match mappings: keys must exist, extra keys are fine."""
    match event:
        case {"type": "click", "pos": (x, y)}:
            return f"click at {x},{y}"
        case {"type": "key", "key": str() as key, **rest}:
            return f"key {key!r}, other keys {sorted(rest)}"
        case _:
            return "unknown event"
```

映射模式只要求列出的键都在，多余的键不碍事，`**rest` 把它们收进字典。最后是类模式，也是 Sift 里用得最多的（第 8 到 14 行的 `Point` 和第 54 到 74 行的 `classes`）：

```python
@dataclass
class Point:
    """A class with an explicit __match_args__."""

    x: int
    y: int
    __match_args__ = ("y", "x")
# ...
def classes(node: object) -> str:
    """Match classes by position and by keyword."""
    match node:
        case Point(0, 0):
            return "origin (positional: y, x)"
        case Point(x=x) if x < 0:
            return f"left half, x = {x}"
        case Term(text="kalman"):
            return "the word kalman"
        case Phrase((first, *_)):
            return f"phrase starting with {first!r}"
        case Not(Term(text) | Prefix(text)):
            return f"negated word or prefix {text!r}"
        case Field("tag" | "series" as name, value):
            return f"metadata field {name}: {value}"
        case And(Or() as left, right):
            return f"AND with an OR on the left: {left} / {right}"
        case int() | float() as number:
            return f"number {number}"
        case _:
            return "something else"
```

`Point(0, 0)` 的位置参数靠 `__match_args__` 对应到属性，这里我故意把顺序写成 `("y", "x")`；`Point(x=x)` 是关键字形式，直接按属性名取。`Term(text="kalman")` 把字面量嵌进类模式；`Phrase((first, *_))` 把序列模式嵌进类模式；`Not(Term(text) | Prefix(text))` 的两个分支都绑定 `text`。`as` 的优先级最低：`"tag" | "series" as name` 是整个 OR 模式绑到 `name`。`int() | float() as number` 里的 `int()` 不带参数，只做类型检查。输出：

```text
$ python3 lab/ch08/match_tour.py | fold -s -w 96
literal search -> literal
literal bench -> or-pattern
literal x -> wildcard
sequence [] -> empty
sequence [7] -> one item 7
sequence [0, 1, 2] -> starts with zero, 2 more
sequence [1, 2, 3, 4] -> first 1, last 4
mapping {'type': 'click', 'pos': (3, 4)} -> click at 3,4
mapping {'type': 'key', 'key': 'q', 'mod': 'ctrl', 'repeat': 1} -> key 'q', other keys ['mod',
'repeat']
mapping {'type': 'click'} -> unknown event
classes Point(x=0, y=0) -> origin (positional: y, x)
classes Point(x=-2, y=5) -> left half, x = -2
classes Term(text='kalman') -> the word kalman
classes Phrase(words=('device', 'tree')) -> phrase starting with 'device'
classes Not(operand=Term(text='latex')) -> negated word or prefix 'latex'
classes Field(name='tag', value=Term(text='Rust')) -> metadata field tag: Term(text='Rust')
classes And(left=Or(left=Term(text='a'), right=Term(text='b')), right=Term(text='c')) -> AND
with an OR on the left: Or(left=Term(text='a'), right=Term(text='b')) / Term(text='c')
classes 3.5 -> number 3.5
classes text -> something else
```

### 五个会咬人的地方

`/tmp/p08/scratch/match_gotchas.py` 把我踩过或担心会踩的几个坑一起跑一遍，带 `# BAD` 的两段是故意写错的，用 `compile` 看编译器怎么说：

```python
"""Five ways a match statement surprises you, run for real."""

from sift.query import Kind

BAD_CAPTURE = """
def kind_name(kind):
    match kind:
        case NOT:  # BAD: a bare name is a capture, not Kind.NOT
            return "negation"
        case _:
            return "other"
"""

BAD_ALTERNATIVES = """
def first(node):
    match node:
        case [x] | (x, y):  # BAD: alternatives bind different names
            return x
"""


class Plain:
    """A class without __match_args__."""

    def __init__(self, x: int) -> None:
        """Keep x."""
        self.x = x


def main() -> None:
    """Run each surprise and print what Python says."""
    for source in (BAD_CAPTURE, BAD_ALTERNATIVES):
        try:
            compile(source, "<match>", "exec")
        except SyntaxError as exc:
            print("SyntaxError:", exc.msg)
    match "abc":
        case [_, *_]:
            print("a str is a sequence")
        case _:
            print("a str is not a sequence pattern target")
    match Kind.NOT:
        case Kind.NOT:
            print("dotted name compares with ==:", Kind.NOT)
    match 5:
        case x if x > 10:
            print("big")
        case _:
            print("guard failed, but x is still bound:", x)
    try:
        # error: TypeError: Plain() accepts 0 positional sub-patterns (1 given)
        match Plain(1):
            case Plain(1):
                print("matched")
    except TypeError as exc:
        print("TypeError:", exc)
    match Plain(1):
        case Plain(x=1):
            print("keyword pattern works without __match_args__")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p08/scratch/match_gotchas.py
SyntaxError: name capture 'NOT' makes remaining patterns unreachable
SyntaxError: alternative patterns bind different names
a str is not a sequence pattern target
dotted name compares with ==: Kind.NOT
guard failed, but x is still bound: 5
TypeError: Plain() accepts 0 positional sub-patterns (1 given)
keyword pattern works without __match_args__
```

1. 裸名字是捕获，不是比较。`case NOT:` 会匹配任何值并把它绑到 `NOT`，后面的 `case _` 永远到不了，编译器直接拒绝。想比较枚举成员要写带点的 `Kind.NOT`（值模式，用 `==` 比较），解析器里写的就是 `case Kind.NOT:`。
2. OR 模式的每个分支必须绑定同样的名字，否则是 `SyntaxError`。
3. `str` 不是序列模式的对象：`case [_, *_]` 对 `"abc"` 不匹配（`bytes` 同理）。
4. 守卫失败，名字仍然是绑定过的：`case x if x > 10` 失败后，`x` 还是 5。
5. 没有 `__match_args__` 的类，位置形式的类模式抛 `TypeError`；关键字形式没事。

### 映射模式和 InvertedIndex

第 7 篇最后说 `InvertedIndex` 继承了 `Mapping`，`match` 的映射模式已经认得它。在真实的索引上试：

```text
$ python3 -c '
from sift.__main__ import CORPUS, load_index
from sift.index import InvertedIndex, PostingList

_, index = load_index(CORPUS)
print(bool(InvertedIndex.__flags__ & (1 << 6)))
match index:
    case {"kalman": PostingList() as kalman, "filter": filt}:
        print(f"kalman in {len(kalman)} docs, filter in {len(filt)} docs")
match index:
    case {"zzzz": _}:
        print("matched a missing key?")
    case _:
        print("a missing key does not match")
' 2>/dev/null
True
kalman in 8 docs, filter in 18 docs
a missing key does not match
```

第一行 `True` 是 `Py_TPFLAGS_MAPPING`（`1 << 6`，`Include/object.h` 第 535 行）这一位在 `InvertedIndex` 的类型标志里是否置上。`MATCH_MAPPING` 字节码只检查它（`Python/bytecodes.c` 第 3061 到 3064 行）。取值时用的是 `map.get(key, dummy)`，不是下标：`Python/ceval.c` 第 741 到 744 行的注释说，这是为了不在 `defaultdict` 这样的子类上触发 `__missing__`，所以缺的键只是不匹配。

### match 编译成了什么

每个类模式编译成一条 `MATCH_CLASS`（`Python/bytecodes.c` 第 3042 行），成功时栈上是属性元组，失败时是 `None`；干活的是 `_PyEval_MatchClass`。它的开头（`Python/ceval.c` 第 850 到 859 行）：

```c
    // First, an isinstance check:
    if (PyObject_IsInstance(subject, type) <= 0) {
        return NULL;
    }
    // So far so good:
    PyObject *seen = PySet_New(NULL);
    if (seen == NULL) {
        return NULL;
    }
    PyObject *attrs = PyList_New(0);
```

先 `isinstance`，然后不管有没有子模式，先分配一个集合（防止同一个属性出现两次）和一个列表。有位置子模式时，第 869 行去类型上取 `__match_args__`，之后对每个名字取一次属性（第 907 到 925 行），最后第 942 行把列表转成元组。这些是 `isinstance` 链不需要付的钱。`/tmp/p08/scratch/match_bench.py` 把三种分派写法放在一起：带子模式的 `Term(_)`、不带子模式的 `Term()`、`isinstance` 链，四个节点类各一个节点，交替跑 5 轮、每轮 20 万次：

```python
"""match with class patterns against an isinstance chain."""

import timeit

from sift.query import And, Not, Phrase, Term
from sift.query.ast import Node

NODES: list[Node] = [
    Term("a"),
    Phrase(("a", "b")),
    And(Term("a"), Term("b")),
    Not(Term("a")),
]


def by_match(node: Node) -> int:
    """Return a number per node class, using class patterns."""
    match node:
        case Term(_):
            return 0
        case Phrase(_):
            return 1
        case And(_, _):
            return 2
        case Not(_):
            return 3
    raise TypeError(node)


def by_bare(node: Node) -> int:
    """Return the same numbers with class patterns that bind nothing."""
    match node:
        case Term():
            return 0
        case Phrase():
            return 1
        case And():
            return 2
        case Not():
            return 3
    raise TypeError(node)


def by_isinstance(node: Node) -> int:
    """Return the same numbers with an isinstance chain."""
    if isinstance(node, Term):
        return 0
    if isinstance(node, Phrase):
        return 1
    if isinstance(node, And):
        return 2
    if isinstance(node, Not):
        return 3
    raise TypeError(node)


def main() -> None:
    """Alternate the three dispatchers, five rounds of 200000 loops."""
    expected = [by_isinstance(n) for n in NODES]
    assert [by_match(n) for n in NODES] == expected
    assert [by_bare(n) for n in NODES] == expected
    results: dict[str, list[float]] = {
        "match Term(_)": [],
        "match Term()": [],
        "isinstance": [],
    }
    loops = 200_000
    for _ in range(5):
        for name, fn in (
            ("match Term(_)", by_match),
            ("match Term()", by_bare),
            ("isinstance", by_isinstance),
        ):
            total = timeit.timeit(
                "for n in nodes: fn(n)",
                globals={"nodes": NODES, "fn": fn},
                number=loops,
            )
            results[name].append(total / (loops * len(NODES)) * 1e9)
    for name, values in results.items():
        print(f"{name:<14} min {min(values):6.1f} ns per dispatch")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p08/scratch/match_bench.py
match Term(_)  min  225.1 ns per dispatch
match Term()   min  131.7 ns per dispatch
isinstance     min   92.8 ns per dispatch
```

带子模式的类模式比 `isinstance` 链慢 2.43 倍（225 ns 对 93 ns），不带子模式的也慢 1.42 倍。每次分派平均试 2.5 个 `case`（四个节点均匀出现），所以单个类模式大约 90 ns，`isinstance` 大约 37 ns（这里还含着循环和函数调用的开销，只能当个量级）。差的大头我猜是取 `__match_args__` 和属性、打包再解包，没有分别量。对 Sift 无所谓：求值一棵树，每个节点分派一次，几十次顶多几微秒，比后面的毫秒小三个数量级。选 `match`，是因为它读起来像文法，不是因为它快。

### 穷尽性

`lab/ch08/match_exhaustive.py` 的 `show` 把树还原成查询文本，默认分支用 `assert_never`（第 8 到 26 行）：

```python
def show(node: Node) -> str:
    """Return node as query text, fully parenthesized."""
    match node:
        case Term(text):
            return text
        case Prefix(text):
            return f"{text}*"
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
```

```text
$ python3 lab/ch08/match_exhaustive.py
((tag:Rust AND "device tree") OR (NOT latex AND owner*))
reparsed tree is equal
assert_never raised: Expected code to be unreachable, but got: 'not a node'
```

还原的文本再解析，得到逐值相等的树，断言通过了。最后一行是给 `show` 喂一个字符串，默认分支抛 `AssertionError`。`assert_never` 的真正用处在类型检查器那一边：加一个第八种节点而忘了在 `show` 里写分支，检查器会在 `assert_never(node)` 那一行报错。类型检查器第 14 篇才接进来，这里我只验证了运行时。Rust 的 `match` 是编译器强制穷尽的，Python 的不是：漏了分支只会落进 `case _`，所以我宁可让默认分支大声失败。

## 求值：把语法树变成文档集合

`evaluate` 是第二个大 `match`，把节点翻译成 `PostingList` 的集合运算（`evaluate.py` 第 116 到 152 行）：

```python
def evaluate(
    node: Node, index: InvertedIndex, pipeline: Pipeline | None = None
) -> PostingList:
    """Return the documents of index that match node.

    Words are analyzed with pipeline, which must be the one that
    built the index (default: build_pipeline()). A word that gives
    several tokens is a phrase of them; one that gives none matches
    nothing. A NOT is the universe minus its operand, but ``x AND
    NOT y`` is computed as ``x - y`` without building the universe.
    """
    pipeline = pipeline or build_pipeline()
    match node:
        case Term(text):
            return phrase_postings(index, pipeline.terms(text))
        case Prefix(text):
            return _prefix(text, index, pipeline)
        case Phrase(words):
            return phrase_postings(index, _analyzed(pipeline, words))
        case Field(name, value):
            return _field(name, value, index, pipeline)
        case And(left, Not(operand)) | And(Not(operand), left):
            return evaluate(left, index, pipeline) - evaluate(
                operand, index, pipeline
            )
        case And(left, right):
            return evaluate(left, index, pipeline) & evaluate(
                right, index, pipeline
            )
        case Or(left, right):
            return evaluate(left, index, pipeline) | evaluate(
                right, index, pipeline
            )
        case Not(operand):
            return _universe(index) - evaluate(operand, index, pipeline)
        case _:
            assert_never(node)
```

`PostingList` 的 `&`、`|`、`-` 是第 6 篇写的合并算法，这里直接用。`case` 的顺序是语义的一部分：`And(left, Not(operand)) | And(Not(operand), left)` 必须排在一般的 `And(left, right)` 前面，它把 `x AND NOT y` 算成 `x - y`，一个 OR 模式覆盖两种写法，两个分支绑定同样的名字。

这就是“不带全集的集合差”。`NOT y` 单独存在时意思是“全集减去 y”，要先造出全集；`x AND NOT y` 不需要。`/tmp/p08/scratch/negation_universe.py` 在 `_universe` 外面包一层计数器：

```python
"""Count how often evaluate() builds the universe for a NOT."""

import importlib

from sift.__main__ import CORPUS, load_index
from sift.analysis import build_pipeline
from sift.query import evaluate, parse

evaluate_module = importlib.import_module("sift.query.evaluate")

QUERIES = [
    "typst -latex",
    "typst NOT latex",
    "typst AND (NOT latex OR rust)",
]


def main() -> None:
    """Wrap _universe with a counter and run three queries."""
    pipeline = build_pipeline()
    _, index = load_index(CORPUS, pipeline)
    real = evaluate_module._universe
    calls = []

    def counting(index):
        """Record the call, then build the universe as usual."""
        calls.append(1)
        return real(index)

    evaluate_module._universe = counting
    for query in QUERIES:
        calls.clear()
        found = evaluate(parse(query), index, pipeline)
        print(
            f"{query!r}: {len(found)} documents, universe built "
            f"{len(calls)} time(s)"
        )
    evaluate_module._universe = real


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p08/scratch/negation_universe.py 2>/dev/null
'typst -latex': 14 documents, universe built 0 time(s)
'typst NOT latex': 14 documents, universe built 0 time(s)
'typst AND (NOT latex OR rust)': 15 documents, universe built 1 time(s)
```

前两种写法（`-latex` 和 `NOT latex`）一次全集也没造；第三条里的 `NOT latex` 在一个 OR 里，没法改写成差，造了一次。全集是 `_universe`（第 53 到 55 行），每次是 $N$ 个空位置的 `Posting`，123 篇文档不值一提，一百万篇就不是了。解析器已经保证单独一个 `NOT` 出不来（会触发 `at least one positive term`），所以只有埋在 OR 里的否定才会付这笔钱。

顺便一个小坑：包的 `__init__.py` 里 `from sift.query.evaluate import evaluate` 把函数绑到了包的属性 `evaluate` 上，盖住了同名的子模块，所以 `negation_universe.py` 开头只能用 `importlib.import_module` 取模块：

```text
$ python3 -c '
import sift.query.evaluate as m
print(type(m).__name__)
import sys
print(type(sys.modules["sift.query.evaluate"]).__name__)
'
function
module
```

### `tag:` 过滤和 `title:` 索引

`tag:`、`category:`、`series:` 在 `_metadata_match` 里是对所有文档的线性扫描（`evaluate.py` 第 58 到 80 行），而且不给分：`Searcher` 的 `positive_leaves` 只收集 `Term`、`Prefix` 和 `Phrase`，`Field` 落进 `case _: return []`（`search.py` 第 45 到 57 行）。同一条查询带不带 `tag:Rust`：

```text
$ for q in 'lifetime' 'tag:Rust lifetime'; do
  echo "== $q"
  python3 -m sift search "$q" 2>/dev/null | grep -E '^ ?[0-9]+  |hits in'
done
== lifetime
 1    6.674  corpus/posts/rust-by-pebble-04-lifetimes-lexer.md
 2    5.586  corpus/posts/rust-by-pebble-02-ownership.md
 3    4.696  corpus/posts/rust-by-pebble-12-vm-backends.md
 4    1.822  corpus/posts/rust-by-pebble-14-concurrency-async.md
4 hits in 123 files: index built in 1892.4 ms, query took 95.319 ms
== tag:Rust lifetime
 1    6.674  corpus/posts/rust-by-pebble-04-lifetimes-lexer.md
 2    5.586  corpus/posts/rust-by-pebble-02-ownership.md
 3    4.696  corpus/posts/rust-by-pebble-12-vm-backends.md
 4    1.822  corpus/posts/rust-by-pebble-14-concurrency-async.md
4 hits in 123 files: index built in 1903.8 ms, query took 96.356 ms
```

分数一分不差。要说清楚的是，这个例子里四篇 `lifetime` 的文档都带 `Rust` 标签，过滤什么也没筛掉，所以它只证明了一件事：过滤不影响分数。

`title:` 走另一条路。`InvertedIndex` 除了正文的映射，还有一个 `title_index`，布局一样（词到 `PostingList`，位置按标题里的词元数），所以 `title:` 查询和标题短语都能复用 `phrase_postings`。`add`（`index.py` 第 167 到 190 行）把正文词元记入 `_postings` 和 `_doc_lens`，标题词元只记入 `title_index`，不计入文档长度：

```python
    def add(
        self,
        doc: Document,
        tokens: Iterable[Token],
        title_tokens: Iterable[Token] = (),
    ) -> None:
        """Index the tokens of one document.

        Documents must be added in increasing doc_id order. tokens and
        title_tokens may be generators: each is consumed once. The
        title tokens go into title_index and do not count toward the
        document length.
        """
        positions = _positions(tokens)
        length = sum(len(found) for found in positions.values())
        self.documents[doc.doc_id] = doc
        self._doc_lens[doc.doc_id] = length
        self._sorted_terms = None
        for term, found in positions.items():
            posting = Posting(doc.doc_id, tuple(found))
            self._postings.setdefault(term, PostingList()).append(posting)
        for term, found in _positions(title_tokens).items():
            posting = Posting(doc.doc_id, tuple(found))
            self.title_index.setdefault(term, PostingList()).append(posting)
```

`/tmp/p08/scratch/title_facts.py` 看一下这个设计的账：

```python
"""The title index: what is in it, and what it leaves out of doc_len."""

from sift.__main__ import CORPUS, load_index
from sift.analysis import build_pipeline


def main() -> None:
    """Count title tokens and show they stay out of doc_len."""
    pipeline = build_pipeline()
    documents, index = load_index(CORPUS, pipeline)
    title_tokens = {
        doc.doc_id: len(list(pipeline.analyze(doc.title))) for doc in documents
    }
    body = sum(index.doc_len(doc.doc_id) for doc in documents)
    titles = sum(title_tokens.values())
    n = index.n_docs
    print(f"title terms {len(index.title_index)}, body terms {len(index)}")
    print(f"title tokens {titles}, body tokens {body}")
    print(
        f"avgdl without titles {body / n:.2f}, with {(body + titles) / n:.2f}"
    )
    doc = next(d for d in documents if d.path.name.startswith("devicetree"))
    print(doc.title)
    print(
        f"  doc_len {index.doc_len(doc.doc_id)}, title tokens "
        f"{title_tokens[doc.doc_id]}"
    )
    posting = next(
        p for p in index.title_index["linux"] if p.doc_id == doc.doc_id
    )
    print("  'linux' in title_index:", posting)


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p08/scratch/title_facts.py 2>/dev/null
title terms 963, body terms 81192
title tokens 1357, body tokens 812338
avgdl without titles 6604.37, with 6615.41
设备树入门：从第一份 DTS 到 Linux 驱动匹配
  doc_len 3965, title tokens 13
  'linux' in title_index: Posting(doc_id=7, positions=(9,))
```

标题词元一共 1,357 个，正文是 812,338 个，不到 0.2%。把它们算进文档长度，平均长度从 6604.37 变成 6615.41，对长度归一化几乎没有影响，所以我宁可让标题别碰文档长度，保证 `doc_len` 就是正文的长度。代价是标题永远不给分：

```text
$ for q in 'title:卡尔曼' 'title:token'; do
  echo "== $q"
  python3 -m sift search "$q" 2>/dev/null | grep -E '^ ?[0-9]+  |hits in'
done
== title:卡尔曼
 1    0.000  corpus/posts/kalman-filter-01-one-dimension.md
 2    0.000  corpus/posts/kalman-filter-02-multivariate.md
 3    0.000  corpus/posts/kalman-filter-05-ekf.md
 4    0.000  corpus/posts/kalman-filter-06-eskf.md
 5    0.000  corpus/posts/kalman-filter-07-ukf.md
5 hits in 123 files: index built in 1896.1 ms, query took 44.843 ms
== title:token
 1    0.000  corpus/posts/rust-by-pebble-04-lifetimes-lexer.md
1 hits in 123 files: index built in 1899.8 ms, query took 13.716 ms
```

`title:卡尔曼` 返回五篇，分数全是 `0.000`，顺序是 `doc_id` 的顺序，因为没有任何叶子给它们加分。标题里带了查询词的文档，在普通查询里得不到任何加成。想让标题加分，可以像 BM25F 那样给不同字段不同的权重，这里没有做。

## 短语查询：位置的交集

`Posting` 里记着每个词出现的位置（词元序号）。要判断 `"device tree"`，不能只看两个词是否出现在同一篇文档里，还要看它们是否紧挨着。`phrase_postings`（`evaluate.py` 第 11 到 45 行）：

```python
def phrase_postings(
    lookup: Mapping[str, PostingList], terms: Sequence[str]
) -> PostingList:
    """Return the documents where terms occur at consecutive positions.

    The posting of a match keeps the positions where the phrase
    starts, so its tf counts phrase occurrences. A single term is
    just its own posting list. Unlike ``&``, which merges the
    positions of both operands, this keeps each term's positions
    apart and shifts them: term k must sit at start + k.
    """
    if not terms:
        return PostingList()
    lists = [lookup.get(term, PostingList()) for term in terms]
    if len(lists) == 1:
        return lists[0]
    # Drive from the shortest list, probe the others by doc_id.
    driver = min(range(len(lists)), key=lambda k: len(lists[k]))
    others = [
        {p.doc_id: frozenset(p.positions) for p in plist} for plist in lists
    ]
    found: list[Posting] = []
    for posting in lists[driver]:
        doc_id = posting.doc_id
        if any(doc_id not in positions for positions in others):
            continue
        starts = [
            start
            for start in (pos - driver for pos in posting.positions)
            if start >= 0
            and all(start + k in others[k][doc_id] for k in range(len(lists)))
        ]
        if starts:
            found.append(Posting(doc_id, tuple(starts)))
    return PostingList(found)
```

做法是：第 $k$ 个词必须出现在 `start + k`。所以从位置最少的那个词 (`driver`) 出发，把它的每个位置 `pos` 换算成短语的起点 `pos - driver`，再检查所有词在 `start + k` 处是否都出现。命中的 `Posting` 记着短语的起点，所以它的 `tf` 就是短语出现的次数。`lab/ch08/phrase_search.py` 把这些位置印出来（第 21 到 36 行）：

```python
    doc_id = next(d.doc_id for d in documents if d.path.name == NAME)
    for word in ("device", "tree"):
        posting = next(p for p in index[word] if p.doc_id == doc_id)
        print(f"{word!r} in {NAME}: tf {posting.tf}")
        print("  positions", posting.positions[:12], "...")
    posting = next(p for p in phrase if p.doc_id == doc_id)
    print("phrase start positions", posting.positions[:12], "...")
    start = posting.positions[0]
    print(
        "tokens there:",
        [
            t.text
            for t in pipeline.analyze(documents[doc_id].body)
            if start - 2 <= t.position <= start + 3
        ],
    )
```

```text
$ python3 lab/ch08/phrase_search.py 2>/dev/null
device AND tree: 4 documents
"device tree": 4 documents
"tree device": 0 documents (order matters)
'device' in devicetree-study-notes.md: tf 8
  positions (610, 669, 699, 1310, 1423, 2492, 3104, 3952) ...
'tree' in devicetree-study-notes.md: tf 5
  positions (611, 670, 700, 3105, 3953) ...
phrase start positions (610, 669, 699, 3104, 3952) ...
tokens there: ['dtc', '是', 'device', 'tree', 'compiler', '它把']
"所有权" is the bigram phrase 所有 + 有权: 13 documents
```

`device` 在这篇文档里出现了 8 次，`tree` 出现了 5 次；短语的起点是 `(610, 669, 699, 3104, 3952)`，恰好是 `tree` 的位置各减 1：`tree` 在 611、670、700、3105、3953，而 `device` 在 1310、1423、2492 那三处后面跟的不是 `tree`。`tokens there` 那一行取出起点 610 附近的词元：`dtc 是 device tree compiler 它把`。`"tree device"` 是 0 篇，顺序是有意义的。最后一行是查询词 `所有权`：分析器把它切成 `所有` 和 `有权`，所以它在求值时是一个两词的短语，13 篇：

```text
$ python3 -c '
from sift.analysis import build_pipeline

print(build_pipeline().terms("所有权"))
'
['所有', '有权']
```

短语和 AND 差多少？

```text
$ python3 -c '
from sift.__main__ import CORPUS, load_index
from sift.analysis import build_pipeline
from sift.query import evaluate, parse

pipeline = build_pipeline()
_, index = load_index(CORPUS, pipeline)
for a, b in [("kalman", "filter"), ("memory", "safety"), ("in", "the")]:
    both = evaluate(parse(f"{a} {b}"), index, pipeline)
    phrase = evaluate(parse(f"\"{a} {b}\""), index, pipeline)
    tf = sum(p.tf for p in phrase)
    print(f"{a} {b}: AND {len(both)}, phrase {len(phrase)}, phrase tf {tf}")
' 2>/dev/null
kalman filter: AND 5, phrase 4, phrase tf 19
memory safety: AND 3, phrase 0, phrase tf 0
in the: AND 75, phrase 26, phrase tf 111
```

`in the` 最说明问题：AND 要 75 篇，短语只要 26 篇，`tf` 合计 111 次。`memory safety` 有三篇同时含有两个词，但没有一篇把它们紧挨着写，短语是 0 篇。短语的代价我读代码能看到，没有量：`others` 对每个词的每一个 posting 都建了 `frozenset`，不管这篇文档是不是候选，而只有 `driver` 的文档才需要；这在 `in the` 这种高频词上最贵。练习里让你量，再改。

短语在评分里怎么算？`Searcher` 把整个短语当成一个叶子：`tf` 是出现次数，`df` 是含有短语的文档数。`/tmp/p08/scratch/explain_hits.py` 把前三名的每个叶子的因子拆开：

```python
"""Break the top hits of a query into per-leaf BM25 contributions."""

import sys

from sift.__main__ import CORPUS, load_index
from sift.analysis import build_pipeline
from sift.query import Phrase, evaluate, parse
from sift.scoring import bm25
from sift.search import Searcher, positive_leaves


def main() -> None:
    """Print tf, df, dl and weight per leaf for the top 3 hits."""
    query = " ".join(sys.argv[1:])
    pipeline = build_pipeline()
    _, index = load_index(CORPUS, pipeline)
    result = Searcher(index, pipeline=pipeline).search(query, limit=3)
    leaves = positive_leaves(parse(query))
    plists = [evaluate(leaf, index, pipeline) for leaf in leaves]
    print(f"{query!r}: N = {index.n_docs}, avgdl = {index.avg_doc_len:.0f}")
    for hit in result.hits:
        dl = index.doc_len(hit.doc_id)
        print(f"{hit.path.name}  score {hit.score:.3f}  dl {dl}")
        for leaf, plist in zip(leaves, plists, strict=True):
            posting = next(p for p in plist if p.doc_id == hit.doc_id)
            weight = bm25(
                posting.tf, len(plist), dl, index.avg_doc_len, index.n_docs
            )
            label = (
                " ".join(leaf.words) if isinstance(leaf, Phrase) else leaf.text
            )
            print(
                f"  {label:<10} tf {posting.tf:>3}  df {len(plist):>3}  "
                f"weight {weight:.3f}"
            )


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p08/scratch/explain_hits.py '"device tree"' 2>/dev/null
'"device tree"': N = 123, avgdl = 6604
devicetree-study-notes.md  score 6.246  dl 3965
  device tree tf   5  df   4  weight 6.246
understanding-qemu.md  score 5.914  dl 8087
  device tree tf   6  df   4  weight 5.914
understanding-kconfig.md  score 4.839  dl 5251
  device tree tf   2  df   4  weight 4.839
```

开头那个 `"device tree"` 的第一名，`tf` 只有 5，`understanding-qemu.md` 有 6 次，却排第二：QEMU 那篇有 8,087 个词元，`devicetree-study-notes.md` 只有 3,965，BM25 的长度归一化让短文档里的 5 次比长文档里的 6 次更值钱（6.246 对 5.914）。

## Searcher：把它们串起来

`Searcher.search`（`search.py` 第 113 到 151 行）的步骤是：解析，求值得到匹配的文档集合，对每个正叶子算 BM25 并累加，取前 `limit` 个，最后给每个命中生成片段：

```python
        start = time.perf_counter()
        node = parse(query)
        matched = evaluate(node, self.index, self.pipeline)
        leaves = positive_leaves(node)
        index = self.index
        avg_len = index.avg_doc_len
        scores: dict[int, float] = defaultdict(float)
        for doc_id in matched.doc_ids():
            scores[doc_id] = 0.0
        for leaf in leaves:
            plist = self._leaf(leaf)
            df = len(plist)
            for posting in plist:
                if posting.doc_id not in matched:
                    continue
                scores[posting.doc_id] += bm25(
                    posting.tf,
                    df,
                    index.doc_len(posting.doc_id),
                    avg_len,
                    index.n_docs,
                    self.k1,
                    self.b,
                )
        terms = self._highlight_terms(leaves)
        hits = []
        for doc_id, score in top_k(scores, limit):
            doc = index.documents[doc_id]
            hits.append(
                Hit(
                    doc_id,
                    doc.title,
                    doc.path,
                    score,
                    make_snippet(doc.body, terms),
                )
            )
        took_ms = (time.perf_counter() - start) * 1000
        return SearchResult(query, len(matched), took_ms, hits)
```

`matched` 是布尔过滤：不在里面的文档不会出现。`scores[doc_id] = 0.0` 给每个匹配的文档先垫一个零，所以只有 `title:` 或 `tag:` 的查询也能返回命中，分数是 0。每个叶子会被求值两次，一次在 `evaluate` 整棵树时，一次在 `self._leaf` 里取 posting 算分，这点浪费我没有去掉。一篇文档的分数是它匹配的那些叶子的 BM25 之和，OR 里没匹配的叶子不扣分。

我最想看的两条查询的前三名：

```text
$ for q in 'kalman filter' 'rust 所有权'; do
  echo "== $q"
  python3 -m sift search "$q" 2>/dev/null | grep -E '^ ?[0-9]+  ' | head -3
done
== kalman filter
 1    8.245  corpus/posts/kalman-filter-02-multivariate.md
 2    7.844  corpus/posts/kalman-filter-07-ukf.md
 3    7.835  corpus/posts/kalman-filter-06-eskf.md
== rust 所有权
 1    5.802  corpus/posts/rust-by-pebble-01-first-crate.md
 2    5.761  corpus/posts/rust-by-pebble-02-ownership.md
 3    5.707  corpus/posts/rust-by-pebble-08-rc-refcell-values.md
```

`kalman filter` 的前三名在上面的九组参数里见过了，`07-ukf` 只比 `06-eskf` 高 0.009。`rust 所有权` 更有意思：我以为标题就是《所有权》的那一篇 (`rust-by-pebble-02-ownership.md`) 会赢，它排第二，第一是 `01-first-crate`，只差 0.041。拆开看：

```text
$ python3 /tmp/p08/scratch/explain_hits.py rust 所有权 2>/dev/null
'rust 所有权': N = 123, avgdl = 6604
rust-by-pebble-01-first-crate.md  score 5.802  dl 8807
  rust       tf  67  df  43  weight 2.254
  所有权        tf   4  df  13  weight 3.548
rust-by-pebble-02-ownership.md  score 5.761  dl 11277
  rust       tf  36  df  43  weight 2.193
  所有权        tf   5  df  13  weight 3.568
rust-by-pebble-08-rc-refcell-values.md  score 5.707  dl 15358
  rust       tf  62  df  43  weight 2.219
  所有权        tf   6  df  13  weight 3.488
```

`所有权` 这个词两篇都只出现 4 到 6 次，权重也相当（3.548 对 3.568）；分差来自 `rust`：第一篇出现 67 次，第二篇 36 次。词频饱和把 31 次的差距压成了权重上的 0.06（2.254 对 2.193），第二篇更长（11,277 对 8,807 个词元），又被扣了一点。标题里的“所有权”不计分，前面说过。BM25 说第一篇略好，我不会把这叫做错，也不会叫它对：我没有任何人工标注的相关性判断。

## 片段：围着命中的窗口

`make_snippet`（`snippet.py` 第 71 到 113 行）做三件事：找出文本里每个命中词的位置，选一个最密的窗口，切成 `(文本, 是否命中)` 的片段：

```python
def make_snippet(text: str, terms: Collection[str], width: int = 160) -> Parts:
# ...
        starts = [s for s, _ in spans]
        ends = [e for _, e in spans]
        best = -1
        lo = 0
        for s in starts:
            cand = max(0, s - width // 4)
            count = bisect_right(ends, cand + width) - bisect_left(
                starts, cand
            )
            if count > best:
                best, lo = count, cand
        hi = lo + width
    hi = min(hi, len(shown))
    parts: Parts = []
    if lo > 0:
        parts.append(("…", False))
    cursor = lo
    for start, end in spans:
        if end <= lo or start >= hi:
            continue
        start, end = max(start, lo), min(end, hi)
        if start > cursor:
            parts.append((_squeeze(shown[cursor:start]), False))
        parts.append((_squeeze(shown[start:end]), True))
        cursor = end
    if cursor < hi:
        parts.append((_squeeze(shown[cursor:hi]), False))
    if hi < len(shown):
        parts.append(("…", False))
    return parts
```

选窗口的方法是：对每个命中的起点，把窗口从 `s - width // 4` 开始（让命中前面留一点上下文），用两次二分数窗口里有几个命中，`bisect_right(ends, cand + width) - bisect_left(starts, cand)`，取最多的。命中的位置已经按先后排序，`starts` 和 `ends` 本身就是有序列表，二分是现成的。

找命中的位置是 `_hit_spans`，它用 `iter_tokens` 给正文重新分一次词，凡是词元在 `terms` 里的就算命中。问题在这里：`iter_tokens` 返回的偏移，是对 NFKC 加 casefold 之后的文本的偏移，不是对原文的。NFKC 会改变长度，省略号 `…` 会变成三个点。`_origin`（`snippet.py` 第 25 到 44 行）处理这个：

```python
def _origin(text: str) -> tuple[str, list[int] | None]:
    """Return the text to show and the offset table of its folding.

    iter_tokens reports offsets into fold(text), which is longer or
    shorter than text when NFKC rewrites a character (``…`` becomes
    three dots). The table lists, for every index i of text, the
    offset in fold(text) where character i starts, plus the final
    length, so a folded offset maps back with bisect. None means the
    two texts have the same length and offsets are the same. If the
    per-character folds do not add up to fold(text) (combining
    marks), the folded text itself is shown, with offsets as they are.
    """
    folded = fold(text)
    if len(folded) == len(text):
        return text, None
    lengths = [_folded_len(ch) for ch in text]
    table = list(accumulate(lengths, initial=0))
    if table[-1] != len(folded):
        return folded, None
    return text, table
```

两者长度不同时，它建一张表：对原文的每个字符 `i`，折叠后的文本里它从第几个字符开始（用 `itertools.accumulate` 累加每个字符折叠后的长度，`initial=0` 补上开头）。折叠后的偏移再用二分换回来：起点是 `bisect_right(table, start) - 1`，终点是 `bisect_left(table, end)`（`_hit_spans` 的第 57 到 58 行）。`/tmp/p08/scratch/offset_demo.py` 用一句带省略号的话看一遍：

```python
"""Token offsets live in folded text; snippets must map them back."""

from bisect import bisect_left, bisect_right

from sift.__main__ import CORPUS
from sift.analysis import iter_tokens
from sift.analysis.tokenize import fold
from sift.corpus import iter_documents
from sift.snippet import _origin


def main() -> None:
    """Show an offset shift, the table that undoes it, and its reach."""
    text = "Wait… the Kalman filter"
    folded = fold(text)
    print(f"text   {text!r} ({len(text)} chars)")
    print(f"folded {folded!r} ({len(folded)} chars)")
    _, table = _origin(text)
    print("table ", table)
    for token in iter_tokens(text):
        start = bisect_right(table, token.start) - 1
        end = bisect_left(table, token.end)
        print(
            f"  {token.text!r:9} folded {token.start:>2}-{token.end:<2} "
            f"text[same] {text[token.start : token.end]!r:9} "
            f"mapped {start:>2}-{end:<2} {text[start:end]!r}"
        )
    docs = list(iter_documents(CORPUS))
    shifted = sum(1 for doc in docs if _origin(doc.body)[1] is not None)
    print(f"bodies whose folded length differs: {shifted} of {len(docs)}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p08/scratch/offset_demo.py
text   'Wait… the Kalman filter' (23 chars)
folded 'wait... the kalman filter' (25 chars)
table  [0, 1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]
  'wait'    folded  0-4  text[same] 'Wait'    mapped  0-4  'Wait'
  'the'     folded  8-11 text[same] 'e K'     mapped  6-9  'the'
  'kalman'  folded 12-18 text[same] 'lman f'  mapped 10-16 'Kalman'
  'filter'  folded 19-25 text[same] 'lter'    mapped 17-23 'filter'
bodies whose folded length differs: 23 of 123
```

`the` 在折叠后的文本里是 8 到 11，直接拿去切原文得到 `'e K'`；经过表换算成 6 到 9，才是 `the`。语料里 123 篇正文有 23 篇折叠后长度不同，这 23 篇每次生成片段都多一趟逐字符的折叠。

高亮有个我必须说清楚的限制：它标出每一个命中的词元，而不是整条短语。开头的输出里 `[device]-[tree]-compiler` 和 `[Device] [Tree] Compiler` 都是短语的真实出现，但第二名 QEMU 那条的末尾是什么？

```text
$ python3 -m sift search '"device tree"' 2>/dev/null \
  | grep -F '[device]…' | fold -s -w 96
    … ARM virt 上增加一个小型 MMIO 设备模型，让 QEMU 生成对应 [Device] [Tree] 节点，再观察
Linux 从 compatible 匹配到 probe()、中断与 remove()。到那一步，Kconfig、Kbuild、[Device]
[Tree]、driver core 和 QEMU [device]…
```

最后的 `[device]…` 只是一个孤零零的 `device`，并不是 `device tree`，也被标了。`Searcher` 传给 `make_snippet` 的是一个词的集合 (`_highlight_terms`)，短语的顺序信息在这一步就丢了。想只标整条短语，要把位置也传进来，练习里有。

## t-string：转义不再靠自觉

片段要给网页用（我打算让第 17、18 篇的 HTTP 服务返回 `render_html` 的结果），所以正文里的 `<script>` 不能原样吐出去。3.14 的 PEP 750 给了一个新工具：t-string。`t"..."` 不是字符串，它的值是 `string.templatelib.Template`，把静态的部分和插值分开存着，由处理它的函数决定怎么拼。`/tmp/p08/scratch/template_facts.py` 把一个 t-string 拆开：

```python
"""What a t-string is, before anyone renders it."""

from string.templatelib import Interpolation, Template, convert

from sift.snippet import html

TEXT = "<script>alert(1)</script>"


def main() -> None:
    """Take a Template apart, then render it two ways."""
    template = t"<mark>{TEXT!r:>10}</mark>"
    print("type        :", type(template).__name__)
    print("strings     :", template.strings)
    item = template.interpolations[0]
    print("interp      :", item)
    print("match_args  :", Interpolation.__match_args__)
    print("iteration   :", [type(x).__name__ for x in template])
    print("convert     :", convert(TEXT, "r"))
    nested = t"<p>{t'<b>{TEXT}</b>'}</p>"
    print("nested      :", html(nested))
    print("isinstance  :", isinstance(nested.values[0], Template))
    print("f-string    :", f"<mark>{TEXT}</mark>")
    print("str(t)      :", str(template)[:34], "...")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p08/scratch/template_facts.py
type        : Template
strings     : ('<mark>', '</mark>')
interp      : Interpolation('<script>alert(1)</script>', 'TEXT', 'r', '>10')
match_args  : ('value', 'expression', 'conversion', 'format_spec')
iteration   : ['str', 'Interpolation', 'str']
convert     : '<script>alert(1)</script>'
nested      : <p><b>&lt;script&gt;alert(1)&lt;/script&gt;</b></p>
isinstance  : True
f-string    : <mark><script>alert(1)</script></mark>
str(t)      : Template(strings=('<mark>', '</mar ...
```

`Template` 有 `strings` 和 `interpolations`，遍历它得到 `str` 和 `Interpolation` 交替出现；`Interpolation` 有四个字段 `value`、`expression`、`conversion`、`format_spec`，`__match_args__` 就是这个顺序，所以可以直接用类模式拆。对没渲染的 `Template` 调 `str()` 得到的是它的 repr，不是 HTML，忘了渲染不会悄悄变成输出。`Lib/string/templatelib.py` 只有 33 行：第 3 到 6 行从一个字面量 `t"{0}"` 里取出 `Template` 和 `Interpolation` 两个类型，第 8 到 18 行的 `convert` 实现 `!r`、`!s`、`!a`。`snippet.py` 里的 `html` 把它们用上了（第 116 到 134 行）：

```python
def html(template: Template) -> str:
    """Render a t-string, escaping every interpolated value.

    Static text is the author's HTML and passes through. A value that
    is itself a Template is rendered recursively; any other value is
    converted, formatted, then escaped with ``html.escape``.
    """
    out: list[str] = []
    for item in template:
        match item:
            case str() as static:
                out.append(static)
            case Interpolation(Template() as inner, _, _, _):
                out.append(html(inner))
            case Interpolation(value, _, conversion, format_spec):
                if conversion is not None:
                    value = convert(value, conversion)
                out.append(escape(format(value, format_spec)))
    return "".join(out)
```

三个 `case` 对应三种情形：静态字符串原样放过；值本身也是 `Template` 的，递归渲染；其他的值先做转换、格式化，最后过 `html.escape`。`html.escape`（`Lib/html/__init__.py` 第 12 到 25 行）先换 `&`（顺序不能反），再换 `<`、`>`，`quote=True` 时再换两种引号。`render_html`（第 137 到 142 行）用它给命中的部分包上 `<mark>`：

```python
def render_html(parts: Parts) -> str:
    """Return parts as HTML: text escaped, hits wrapped in <mark>."""
    return "".join(
        html(t"<mark>{text}</mark>") if hit else html(t"{text}")
        for text, hit in parts
    )
```

`lab/ch08/snippets.py` 把同一段含 `<script>` 的文本分别用 t-string 和 f-string 渲染（第 21 到 28 行）：

```python
    danger = "<script>alert(1)</script>"
    template = t"<p>{danger}</p>"
    print("template strings:", template.strings)
    print("template values: ", template.values)
    print("html(t-string):  ", html(template))
    print("f-string:        ", f"<p>{danger}</p>")
    print("conversion:      ", html(t"<b>{danger!r}</b>"))
    print("no hits:", render_plain(make_snippet(TEXT, {"zzz"}, width=40)))
```

```text
$ python3 lab/ch08/snippets.py | fold -s -w 96
parts:
  False '…'
  False ')</script> & friends with the '
  True  'Kalman'
  False ' '
  True  'filter'
  False ': predict, then update the '
  True  'Kalman'
  False ' state. An unrelated closing sentence about '
  False '…'
plain: …)</script> & friends with the [Kalman] [filter]: predict, then update the [Kalman]
state. An unrelated closing sentence about …
html:  …)&lt;/script&gt; &amp; friends with the <mark>Kalman</mark> <mark>filter</mark>:
predict, then update the <mark>Kalman</mark> state. An unrelated closing sentence about …
template strings: ('<p>', '</p>')
template values:  ('<script>alert(1)</script>',)
html(t-string):   <p>&lt;script&gt;alert(1)&lt;/script&gt;</p>
f-string:         <p><script>alert(1)</script></p>
conversion:       <b>&#x27;&lt;script&gt;alert(1)&lt;/script&gt;&#x27;</b>
no hits: An unrelated opening sentence about tea.…
```

`plain` 一行是命令行用的 `render_plain`，命中词在方括号里；`html` 一行里 `<script>` 变成了 `&lt;/script&gt;`，`&` 变成 `&amp;`，只有我自己写的 `<mark>` 保留着。对照看：`html(t-string)` 把 `<script>alert(1)</script>` 转义了，`f-string` 原样放过，因为 f-string 在你拿到结果之前就把值拼进去了，t-string 把拼接留给了函数。`{danger!r}` 的转换先于转义执行，所以引号变成了 `&#x27;`。静态部分是被信任的：`html(t"<b>{x}</b>")` 里的 `<b>` 不会被转义，所以不要把用户输入放进静态部分。

## 慢在哪里：每个命中都把正文重新分一遍词

现在把延迟的账算清楚。`lab/ch08/queries_bench.py` 对 `bench/queries.txt` 的 12 条查询各跑 5 次取中位数（第 21 到 29 行）：

```python
    for query in filter(None, queries):
        runs = []
        for _ in range(REPEATS):
            start = time.perf_counter()
            result = searcher.search(query)
            runs.append((time.perf_counter() - start) * 1000)
        medians.append(statistics.median(runs))
        print(f"{medians[-1]:8.2f} ms  {result.total:>4} hits  {query}")
    print(f"{sum(medians):8.2f} ms  sum of medians, {len(medians)} queries")
```

```text
$ python3 lab/ch08/queries_bench.py 2>/dev/null
  216.10 ms    10 hits  rust 所有权
   50.87 ms     5 hits  kalman filter
   23.39 ms     4 hits  "device tree"
   86.58 ms    10 hits  pid AND 积分
   92.54 ms     4 hits  tag:Rust lifetime
   65.57 ms    56 hits  矩阵 OR matrix
   75.95 ms    14 hits  typst -latex
   19.18 ms     3 hits  cmake vcpkg
   52.04 ms     3 hits  gdb 断点
   15.47 ms     2 hits  linux kernel module
   49.25 ms    14 hits  奇异值
  108.75 ms     6 hits  owner*
  855.69 ms  sum of medians, 12 queries
```

合计 856 ms，平均每条 71 ms，最慢的 `rust 所有权` 要 216 ms。（`python3 -m sift bench` 是一次性跑，不取中位数，总共 899 ms，其中 `owner*` 135 ms，比这里的 109 ms 多出的 27 ms，和前面那次 24 ms 的词表排序大致吻合。）

这些时间花在哪？我的怀疑是片段：每个命中都要把整篇正文再分词一遍（`_hit_spans` 里的 `iter_tokens(shown)`），而 `Posting` 记的是词元序号，不是字符偏移，从序号没法直接得到原文里的位置。最直接的验证是把 `make_snippet` 换成一个什么都不做的函数，看延迟剩多少。`/tmp/p08/scratch/latency_split.py` 每条查询交替跑“带片段”和“不带片段”，各 7 轮取中位数：

```python
"""Per-query latency with and without snippets, alternating."""

import statistics
from pathlib import Path

import sift.search as search_module
from sift.__main__ import CORPUS, QUERIES, load_index
from sift.analysis import build_pipeline
from sift.search import Searcher

ROUNDS = 7


def no_snippet(text: str, terms: set[str]) -> list[tuple[str, bool]]:
    """Stand in for make_snippet and do nothing."""
    return []


def main() -> None:
    """Time every query in both modes, one after the other."""
    pipeline = build_pipeline()
    _, index = load_index(CORPUS, pipeline)
    searcher = Searcher(index, pipeline=pipeline)
    real = search_module.make_snippet
    queries = Path(QUERIES).read_text(encoding="utf-8").splitlines()
    full_total = bare_total = 0.0
    print(f"{'full':>8} {'no snip':>8} {'snip %':>6}  query")
    for query in filter(None, queries):
        full: list[float] = []
        bare: list[float] = []
        for _ in range(ROUNDS):
            search_module.make_snippet = real
            full.append(searcher.search(query).took_ms)
            search_module.make_snippet = no_snippet
            bare.append(searcher.search(query).took_ms)
        search_module.make_snippet = real
        f, b = statistics.median(full), statistics.median(bare)
        full_total += f
        bare_total += b
        print(f"{f:8.2f} {b:8.2f} {100 * (f - b) / f:6.0f}  {query}")
    share = 100 * (full_total - bare_total) / full_total
    print(f"{full_total:8.2f} {bare_total:8.2f} {share:6.0f}  total")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p08/scratch/latency_split.py 2>/dev/null
    full  no snip snip %  query
  216.84     0.59    100  rust 所有权
   50.61     0.15    100  kalman filter
   23.32     0.23     99  "device tree"
   86.73     0.26    100  pid AND 积分
   93.95     0.42    100  tag:Rust lifetime
   65.30     0.41     99  矩阵 OR matrix
   74.83     0.18    100  typst -latex
   19.15     0.16     99  cmake vcpkg
   52.38     0.27     99  gdb 断点
   14.53     0.20     99  linux kernel module
   48.42     0.35     99  奇异值
  107.77     0.17    100  owner*
  853.84     3.38    100  total
```

12 条查询合计 853.84 ms，去掉片段之后是 3.38 ms：片段占了 99.6%，其余所有工作（解析、求值、评分、取前十）平均每条 0.28 ms。`owner*` 带片段 107.77 ms，不带只要 0.17 ms，差了 600 多倍。

`/tmp/p08/scratch/snippet_cost.py` 再把一篇正文的成本拆成三步：折叠、把 `iter_tokens` 消耗完、整个 `make_snippet`，各轮流跑 5 轮取最小值：

```python
"""What one snippet costs: fold, tokenize, or everything else."""

import time
from collections.abc import Callable

from sift.__main__ import CORPUS
from sift.analysis import iter_tokens
from sift.analysis.tokenize import fold
from sift.corpus import iter_documents
from sift.snippet import make_snippet

ROUNDS = 5
TERMS = {"kalman", "filter"}


def sweep_ms(fn: Callable[[str], object], bodies: list[str]) -> float:
    """Return the time to run fn over every body, in milliseconds."""
    start = time.perf_counter()
    for body in bodies:
        fn(body)
    return (time.perf_counter() - start) * 1000


def main() -> None:
    """Time three steps over every body, alternating, keep the min."""
    bodies = [doc.body for doc in iter_documents(CORPUS)]
    steps: dict[str, Callable[[str], object]] = {
        "fold(body)": fold,
        "consume iter_tokens(body)": lambda body: sum(
            1 for _ in iter_tokens(body)
        ),
        "make_snippet(body)": lambda body: make_snippet(body, TERMS),
    }
    best = dict.fromkeys(steps, float("inf"))
    for _ in range(ROUNDS):
        for name, fn in steps.items():
            best[name] = min(best[name], sweep_ms(fn, bodies))
    chars = sum(len(body) for body in bodies)
    print(f"{len(bodies)} bodies, {chars} characters")
    for name, ms in best.items():
        print(f"{name:<27} {ms:7.1f} ms  {ms / len(bodies):6.2f} ms per body")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/p08/scratch/snippet_cost.py
123 bodies, 2984458 characters
fold(body)                     94.4 ms    0.77 ms per body
consume iter_tokens(body)     709.4 ms    5.77 ms per body
make_snippet(body)            937.7 ms    7.62 ms per body
```

每篇正文平均 7.62 ms 生成一个片段，其中把词元走一遍占 5.77 ms (76%)，折叠 0.77 ms 且要做两次。（123 篇正文各生成一次是 938 ms，但那是另一个总体，不能直接和 856 ms 比：12 条查询共生成 77 个片段，平均每个约 11 ms，比 7.62 ms 高，因为排在前面的命中文档往往更长。真正的证据是前面把 `make_snippet` 换掉的那次测量，853.84 ms 降到 3.38 ms。）这里的毛病是结构性的：索引存的是词元序号，而片段需要字符偏移。几种办法我都能想到（在 `Posting` 里存字符偏移，只对命中词元附近的窗口重新分词，缓存片段），每一种都要改索引的格式或这个函数的接口，这一篇我只量不改，放进练习。

## 索引还是要 2 秒

`ch08` 多了标题索引：每篇文档多分析一次标题，多建一个 `title_index`。它让第 7 篇那笔 1.85 s 的索引账又涨了吗？用第 7 篇的 `build_probe.py`（每个版本在新进程里跑一次 `load_index`），`ch07` 和 `ch08` 交替 7 轮：

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
  for c in ch07 ch08; do
    echo "$c $(at $c /tmp/p08/scratch/build_probe.py 2>/dev/null)"
  done
done | sort -k1,1 -k2,2n \
  | awk '{a[$1]=a[$1]" "$2} END{for(k in a)print k":"a[k]}' | sort
ch07: 2007 2016 2019 2027 2039 2058 2058
ch08: 2005 2007 2009 2015 2023 2047 2139
```

最小值 2007 ms 对 2005 ms，中位数 2027 对 2015 ms，没有可见的差别：多出来的是 1,357 个标题词元，对 812,338 个正文词元是 0.17%。这个会话的数比第 7 篇高：我早些时候在同一台机器上跑过同样的 7 轮，最小值是 1880 ms 对 1880 ms，两次差了约 7%，所以只拿同一次的数互相比。无论哪一次，索引都是 2 秒上下，每次 `python3 -m sift search` 都要付，前面那个括号输错的例子也要先付完这笔钱。第 12 篇才会把索引存下来，在那之前每次搜索都从零开始。

## 跑一遍

整章一个 `make` 目标，再加 `make lint`：

```text
$ make ch08
python3 scripts/chapter.py ch08
ok   lab/ch08/bisect_demo.py
ok   lab/ch08/bm25_by_hand.py
ok   lab/ch08/bm25_params.py
ok   lab/ch08/float_pitfalls.py
ok   lab/ch08/heap_topk.py
ok   lab/ch08/lexer_demo.py
ok   lab/ch08/match_exhaustive.py
ok   lab/ch08/match_tour.py
ok   lab/ch08/parser_demo.py
ok   lab/ch08/phrase_search.py
ok   lab/ch08/queries_bench.py
ok   lab/ch08/snippets.py
ok   lab/ch08/syntax_error_demo_fail.py
$ make lint
ruff format --check --line-length 79 .
128 files already formatted
ruff check .
All checks passed!
```

`syntax_error_demo_fail.py` 也显示 `ok`，因为运行器知道 `_fail.py` 结尾的文件应该非零退出，我另外确认了退出码：

```text
$ python3 lab/ch08/syntax_error_demo_fail.py >/dev/null 2>&1; echo $?
1
```

## 本篇文件

这一章改过的 `src/sift` 文件和新增的 `lab/ch08` 文件，另外还有 `lab/ch04/tfidf_vs_tf.py`，它自己带上了从 `__main__.py` 搬出来的 `search_index`：

```text
$ git diff --shortstat ch07 ch08 -- src lab
 25 files changed, 1494 insertions(+), 65 deletions(-)
```

[`lab/ch08`](https://github.com/bfmhno3/sift/tree/ch08/lab/ch08) 下的 13 个文件，加上这一章改过或新增的 `src/sift` 下的 11 个文件，再加 `lab/ch04/tfidf_vs_tf.py`，共 25 个。结果列是我在本篇的环境里重新跑出来的。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`src/sift/query/__init__.py`](https://github.com/bfmhno3/sift/blob/ch08/src/sift/query/__init__.py) | `python3 -c 'import sift.query as q; print(len(q.__all__), q.__all__[:3])'` | 退出码 0，输出 `14 ['And', 'Field', 'Kind']`；24 行 |
| [`src/sift/query/ast.py`](https://github.com/bfmhno3/sift/blob/ch08/src/sift/query/ast.py) | `python3 -c 'from sift.query import parse; print(parse("a OR b"))'` | 退出码 0，输出 `Or(left=Term(text='a'), right=Term(text='b'))`；58 行 |
| [`src/sift/query/errors.py`](https://github.com/bfmhno3/sift/blob/ch08/src/sift/query/errors.py) | `python3 -c 'from sift.query.errors import QuerySyntaxError as E; print(E("bad", "a )", 2).render())'` | 退出码 0，三行：`bad`、`  a )`、`    ^`；21 行 |
| [`src/sift/query/lexer.py`](https://github.com/bfmhno3/sift/blob/ch08/src/sift/query/lexer.py) | `python3 -c 'from sift.query import iter_tokens; print([t.kind.name for t in iter_tokens("a OR b")])'` | 退出码 0，输出 `['WORD', 'OR', 'WORD', 'EOF']`；95 行 |
| [`src/sift/query/parser.py`](https://github.com/bfmhno3/sift/blob/ch08/src/sift/query/parser.py) | `python3 -c 'from sift.query import parse; print(parse("(a OR b) c"))'` | 退出码 0，输出 `And(left=Or(left=Term(text='a'), right=Term(text='b')), right=Term(text='c'))`；153 行 |
| [`src/sift/query/evaluate.py`](https://github.com/bfmhno3/sift/blob/ch08/src/sift/query/evaluate.py) | `python3 -m sift search '"device tree"' 2>/dev/null` | 退出码 0，第一行 ` 1    6.246  corpus/posts/devicetree-study-notes.md`（短语命中 4 篇）；152 行 |
| [`src/sift/scoring.py`](https://github.com/bfmhno3/sift/blob/ch08/src/sift/scoring.py) | `python3 -c 'from sift.scoring import bm25; print(round(bm25(7, 8, 10945, 6604.37, 123), 4))'` | 退出码 0，输出 `4.6949`；54 行 |
| [`src/sift/search.py`](https://github.com/bfmhno3/sift/blob/ch08/src/sift/search.py) | `python3 -m sift search kalman filter 2>/dev/null` | 退出码 0，第一行 ` 1    8.245  corpus/posts/kalman-filter-02-multivariate.md`；151 行 |
| [`src/sift/snippet.py`](https://github.com/bfmhno3/sift/blob/ch08/src/sift/snippet.py) | `python3 -c 'from sift.snippet import make_snippet, render_plain; print(render_plain(make_snippet("a Kalman filter", {"kalman"}, 40)))'` | 退出码 0，输出 `a [Kalman] filter`；147 行 |
| [`src/sift/index.py`](https://github.com/bfmhno3/sift/blob/ch08/src/sift/index.py) | `python3 -c 'from sift.__main__ import CORPUS, load_index; idx = load_index(CORPUS)[1]; print(len(idx.title_index), idx.terms_with_prefix("owner"))' 2>/dev/null` | 退出码 0，输出 `963 ['owner', 'ownership']`（标题词表大小和前缀查询结果）；232 行 |
| [`src/sift/__main__.py`](https://github.com/bfmhno3/sift/blob/ch08/src/sift/__main__.py) | `python3 -m sift search '"device tree"' 2>/dev/null` | 退出码 0，第一行 ` 1    6.246  corpus/posts/devicetree-study-notes.md`，最后一行 `4 hits in 123 files: ...`（后面是两个耗时）；115 行 |
| [`lab/ch08/bm25_by_hand.py`](https://github.com/bfmhno3/sift/blob/ch08/lab/ch08/bm25_by_hand.py) | `python3 lab/ch08/bm25_by_hand.py 2>/dev/null` | 退出码 0，第一行 `query 'kalman filter', document kalman-filter-02-multivariate.md` |
| [`lab/ch08/bm25_params.py`](https://github.com/bfmhno3/sift/blob/ch08/lab/ch08/bm25_params.py) | `python3 lab/ch08/bm25_params.py 2>/dev/null` | 退出码 0，第一行 `query 'kalman filter'` |
| [`lab/ch08/float_pitfalls.py`](https://github.com/bfmhno3/sift/blob/ch08/lab/ch08/float_pitfalls.py) | `python3 lab/ch08/float_pitfalls.py` | 退出码 0，第一行 `0.1 + 0.2 = 0.30000000000000004 == 0.3 ? False` |
| [`lab/ch08/heap_topk.py`](https://github.com/bfmhno3/sift/blob/ch08/lab/ch08/heap_topk.py) | `python3 lab/ch08/heap_topk.py` | 退出码 0，第一行 `1000000 scores, k = 10, median of 5 runs` |
| [`lab/ch08/bisect_demo.py`](https://github.com/bfmhno3/sift/blob/ch08/lab/ch08/bisect_demo.py) | `python3 lab/ch08/bisect_demo.py` | 退出码 0，第一行 `scores [10, 20, 20, 20, 30]` |
| [`lab/ch08/lexer_demo.py`](https://github.com/bfmhno3/sift/blob/ch08/lab/ch08/lexer_demo.py) | `python3 lab/ch08/lexer_demo.py` | 退出码 0，第一行 `'tag:Rust "device tree" -latex'` |
| [`lab/ch08/parser_demo.py`](https://github.com/bfmhno3/sift/blob/ch08/lab/ch08/parser_demo.py) | `python3 lab/ch08/parser_demo.py` | 退出码 0，第一行 `kalman filter` |
| [`lab/ch08/match_tour.py`](https://github.com/bfmhno3/sift/blob/ch08/lab/ch08/match_tour.py) | `python3 lab/ch08/match_tour.py` | 退出码 0，第一行 `literal search -> literal` |
| [`lab/ch08/match_exhaustive.py`](https://github.com/bfmhno3/sift/blob/ch08/lab/ch08/match_exhaustive.py) | `python3 lab/ch08/match_exhaustive.py` | 退出码 0，第一行 `((tag:Rust AND "device tree") OR (NOT latex AND owner*))` |
| [`lab/ch08/syntax_error_demo_fail.py`](https://github.com/bfmhno3/sift/blob/ch08/lab/ch08/syntax_error_demo_fail.py) | `python3 lab/ch08/syntax_error_demo_fail.py` | 退出码 1：回溯的最后一行是 `sift.query.errors.QuerySyntaxError: expected ')'` |
| [`lab/ch08/phrase_search.py`](https://github.com/bfmhno3/sift/blob/ch08/lab/ch08/phrase_search.py) | `python3 lab/ch08/phrase_search.py 2>/dev/null` | 退出码 0，第一行 `device AND tree: 4 documents` |
| [`lab/ch08/snippets.py`](https://github.com/bfmhno3/sift/blob/ch08/lab/ch08/snippets.py) | `python3 lab/ch08/snippets.py` | 退出码 0，第一行 `parts:` |
| [`lab/ch08/queries_bench.py`](https://github.com/bfmhno3/sift/blob/ch08/lab/ch08/queries_bench.py) | `python3 lab/ch08/queries_bench.py 2>/dev/null` | 退出码 0，第一行 `  216.10 ms    10 hits  rust 所有权`（耗时每次略有不同） |
| [`lab/ch04/tfidf_vs_tf.py`](https://github.com/bfmhno3/sift/blob/ch08/lab/ch04/tfidf_vs_tf.py) | `python3 lab/ch04/tfidf_vs_tf.py 2>/dev/null` | 退出码 0，第一行 `query: 'linux device': 6 hits`；77 行 |

## 练习

**1.** 让片段不再重新分词整篇正文。比如在 `Posting` 里再存一份字符偏移，或者只对第一个命中附近的一个窗口分词。用 `latency_split.py` 和 `snippet_cost.py` 量改动前后，并且证明 12 条基准查询的前十名和片段没有变。想一想：偏移存进索引，索引大了多少？

**2.** 让评分与叶子的顺序无关：把每篇文档在各个叶子上的贡献收集起来，用 `math.fsum` 加，再用 `float_order.py` 确认倒序之后分数逐位相同。顺便把 `bm25()` 里的 `math.log` 提到叶子的层面，每个叶子只算一次。这两处改动各自省了多少、多花了多少？

**3.** 让 250 层括号得到 `QuerySyntaxError("nesting too deep", ...)`，而不是 `RecursionError`；再试试 1000 个词的平铺 OR 链。给 `_Parser` 加一个深度计数器，还是在 `parse()` 里接住 `RecursionError`，各有什么毛病？用 `deep_parens.py` 验证。

**4.** 让高亮只标整条短语：`Searcher` 现在传给 `make_snippet` 的是词的集合，你需要把什么传进去？再把 `phrase_postings` 里的 `frozenset` 改成只对 `driver` 的文档建，量 `in the` 前后的时间。

## 下一篇

下一篇是《异常、上下文管理器、日志与调试》。`QuerySyntaxError` 现在住在一个临时的位置，`syntax_error_demo_fail.py` 的回溯一路冒到顶。我想看看 Python 的异常层次、`raise from` 和 `ExceptionGroup`，能把这些零散的错误收成什么样子，以及当语料里有几个文件解析失败时，索引构建该怎么办。
