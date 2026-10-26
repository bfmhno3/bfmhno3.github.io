---
title: "性能：剖析、字节码特化与优化"
commentId: "post:python-by-sift-23-profiling-performance"
published: "2026-10-27 02:00:00 +08:00"
description: "用 Sift 重学 Python 第 23 篇：我在 Python 3.14.7 上用 timeit、cProfile、pyinstrument、py-spy、memray、tracemalloc 和 sys.monitoring 把 sift index --full 与 sift bench search 量了一遍，再动手改。原先我猜慢在 BM25 循环，剖析器说不是：12 个查询在 cProfile 下共 1.862 秒，其中 1.834 秒是生成片段，打分加排序只有约 28 毫秒。改了六处热点，先用一个钉住 12 个查询前 10 名的测试，再优化；5 轮交替测量，12 个查询从 1005.7 毫秒降到 525.1 毫秒（1.92 倍），索引构建内部计时从 3070.1 毫秒降到 2621.0 毫秒（1.17 倍），segment.sft 与 ch22 逐字节相同。中途量到：str.translate 在 ASCII 文本上比 21 次 replace 快 4 倍，在含 emoji 的语料上反而慢 1.5 倍；3.14 的 BINARY_OP 在第二次执行时特化，换成另一种类型后第 53 次才重新特化；这台机器的 Python 没有 JIT，也不是尾调用解释器；kernprof 不在开发环境里，我用 sys.monitoring 的 LINE 事件自己做了一个逐行计数器。"
category: Tutorial
tags:
  - 性能优化
  - 剖析
  - CPython
series: "用 Sift 重学 Python"
seriesOrder: 23
draft: false
comment: true
slug: python-by-sift-23-profiling-performance
---

我原本以为 Sift 的搜索慢在 BM25 的打分循环：对每个查询词遍历倒排表，给每个文档算一遍 `tf`、`idf`、长度归一化，听上去就是热点。没量之前我已经在想怎么把它改成预先算好的表了。然后我把 12 条基准查询放进 cProfile，结果是 12 个查询一共 1.862 秒，`make_snippet` 一项就占 1.834 秒；`bm25` 被调用了 189 次，累计时间显示为 0.000。搜索里除了生成片段，别的部分加起来约 28 毫秒。我的猜测错了，这一篇讲怎么发现它错了，以及发现之后怎么改：先量，再钉住行为，再动手，最后确认字节没变。

```text
$ SIFT_INDEX=/tmp/sift-scratch/ch23/idx-old PYTHONPATH=/tmp/sift-scratch/ch23/old/src python3 /tmp/sift-scratch/ch23/profile_search.py | grep -E 'function calls|search.py:152|snippet.py:101|bm25|top_k' | uniq
         5540485 function calls (5540390 primitive calls) in 1.862 seconds
       12    0.016    0.001    1.862    0.155 search.py:152(search)
       77    0.017    0.000    1.834    0.024 snippet.py:101(make_snippet)
       12    0.000    0.000    0.000    0.000 scoring.py:62(top_k)
      189    0.000    0.000    0.000    0.000 scoring.py:34(bm25)
$ python3 /tmp/sift-scratch/cpu_state.py
112 111 112 113 112 ms
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch23`（提交 `b88f446`）。改动共 21 个文件，`git diff --shortstat ch22 ch23` 给出 `21 files changed, 903 insertions(+), 48 deletions(-)`。新增的有 `tests/test_search_stable.py`（钉住 12 条基准查询的前 10 名，语料目录不在时跳过）和 `lab/ch23/` 下的 7 个脚本加 `extra.sh`。改写的有 6 处热点代码：`src/sift/analysis/tokenize.py`（`iter_tokens` 用 `lastgroup`、一次 `span()` 和 `tuple.__new__`，新增 `iter_hit_spans`）、`src/sift/analysis/filters.py`（NFKC 过滤器对 ASCII 词元跳过 Unicode 表）、`src/sift/index.py`（只为没见过的词建 `PostingList`）、`src/sift/storage/varint.py` 与 `src/sift/storage/segment.py`（单字节变长整数直接 `append`，新增 `append_deltas`）、`src/sift/snippet.py`（`_origin` 每个不同的字符只折叠一次，命中区间改用 `iter_hit_spans`）；`src/sift/cli.py` 多了 `sift bench search --profile`，把 cProfile 的结果写到 `out/profile.pstats`。
> 后面的章节里，下一篇开始写原生扩展；这一篇优化过的几个函数，是那一篇“值不值得换成 C”的对照基线。
> 涉及的 Python 与工具的特性：`timeit`、`cProfile` 与 `pstats`、采样与确定性剖析器的区别、火焰图、逐行剖析、`tracemalloc` 与 memray、PEP 659 自适应特化解释器、`dis` 的 `adaptive=True`、3.14 的尾调用解释器与实验性 JIT 的状态、局部名与全局名、`str.translate`、预编译正则、列表推导、`__slots__`、PEP 669 的 `sys.monitoring`。
> 前置：[第 22 篇](/posts/python-by-sift-22-numpy-pandas-matplotlib/)。分词（[第 2 篇](/posts/python-by-sift-02-text-and-unicode/)）、BM25（[第 8 篇](/posts/python-by-sift-08-bm25-query-language/)）、段文件与变长整数（[第 12 篇](/posts/python-by-sift-12-files-binary-format/)）、测试里的 hypothesis（[第 10 篇](/posts/python-by-sift-10-testing/)）这一篇都会碰到，行为一律不变，变的只是它们花的时间。

## 环境

和前几篇同一台机器，仓库在标签 `ch23`，命令都在 `nix develop` 里、仓库根目录下跑。工具的版本我先查了一遍：

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ git describe --tags; git rev-parse --short HEAD
ch23
b88f446
$ lscpu | sed -n '/Model name/p;/^CPU(s):/p'
CPU(s):                                  16
Model name:                              AMD Ryzen 7 PRO 6850U with Radeon Graphics
$ hyperfine --version; py-spy --version
hyperfine 1.20.0
py-spy 0.4.2
$ python3 -c "import importlib.metadata as m; [print(n, m.version(n)) for n in ('pyinstrument', 'memray', 'hypothesis')]"
pyinstrument 5.1.3
memray 1.19.3
hypothesis 6.156.1
$ command -v kernprof || echo "kernprof: not found"
kernprof: not found
```

`cProfile`、`pstats`、`timeit`、`tracemalloc`、`sys.monitoring` 和 `dis` 都是标准库，不用装。`pyinstrument`、`py-spy`、memray 和 hyperfine 是开发环境里现成的；`kernprof`（`line-profiler` 包带的命令）不在 `flake.nix` 里，所以 `extra.sh` 里调它的那一支我没法跑，只能照实说：那一支没有测过，后面“逐行”一节我用 `sys.monitoring` 自己做了一个替代，那个是跑过的。

这台机器的 CPU 有快慢两个状态（第 11 篇测到过约 2.5 倍），所以凡是计时，前后我都夹一次 `cpu_state.py`（第 12 篇贴过的固定忙循环，快状态下 5 个数在 110 到 120 毫秒）。这个脚本这次还让我看到一件之前没注意的事：机器空闲一会儿之后跑的第一条命令，前四个读数常常是 160 多毫秒，第五个才掉到 110 左右；紧接着再跑一次就全是快状态。我猜是空闲后的时钟还没升上来，但没有去验证。不管原因是什么，结论是一条命令的第一次读数不能信。下面是空闲 20 秒之后连着跑两次的真实读数：

```text
$ sleep 20; python3 /tmp/sift-scratch/cpu_state.py; python3 /tmp/sift-scratch/cpu_state.py
190 164 165 159 110 ms
111 112 112 113 113 ms
```

所以我所有的计时，要么前面先夹一次 `cpu_state.py` 把 CPU 叫醒，要么是多轮里取中位数。后文贴出来的计时，紧挨着它的 `cpu_state.py` 读数都在 110 到 120 毫秒之间；只有开头那几个“叫醒用”的读数是 160 多。

另外，我写的草稿脚本（对 ch22 与当前树的对照、`cProfile` 下的查询、逐行计数器等）放在 `/tmp/sift-scratch/ch23/`，不进仓库。比较的“前”是 `git archive ch22` 解出来的一份干净副本，用 `PYTHONPATH` 把它的 `src` 放到最前面；两份代码都在仓库根目录下跑，共用 `sift.toml`、`corpus/` 和 `bench/queries.txt`。语料是 123 篇文章，建出来的索引有 81167 个词。

## 先量，再动手

优化之前我要两样东西：一个能反复跑、结果可比的基准，和一个说明“改完行为没变”的办法。基准已经有了：`sift index --full` 重建整个索引，`sift bench search` 跑 `bench/queries.txt` 里的 12 条查询（第 8 篇写的）。后者每条查询单独计时，最后打一行总和，所以我既能看进程整体花了多少，也能只看 12 个查询本身。

标签 `ch22` 上的基线，用 `extra.sh` 里的 `before_after` 一支量，它在一个临时目录里把 `ch22` 检出来，和当前树各跑 5 次，再用 `cmp` 比两份 `segment.sft`。我跑了整个 `extra.sh`，贴出来的是这一支的输出（前后各夹了一次 `cpu_state.py`，读数是 `169 170 180 157 113` 和 `113 114 114 114 118`，前者是叫醒用的）：

```text
$ grep -E '^###|Benchmark|Time|Range|HEAD ran|times faster|speedup|identical' out/ch23/before_after.txt
### sift index --full: ch22 against HEAD
Benchmark 1: ch22
  Time (mean ± σ):      3.462 s ±  0.042 s    [User: 3.261 s, System: 0.142 s]
  Range (min … max):    3.419 s …  3.528 s    5 runs
Benchmark 2: HEAD
  Time (mean ± σ):      3.003 s ±  0.035 s    [User: 2.813 s, System: 0.144 s]
  Range (min … max):    2.964 s …  3.058 s    5 runs
  HEAD ran
    1.15 ± 0.02 times faster than ch22
### sift bench search: ch22 against HEAD
Benchmark 1: ch22
  Time (mean ± σ):      1.605 s ±  0.010 s    [User: 1.467 s, System: 0.077 s]
  Range (min … max):    1.594 s …  1.621 s    5 runs
Benchmark 2: HEAD
  Time (mean ± σ):      1.135 s ±  0.004 s    [User: 0.994 s, System: 0.080 s]
  Range (min … max):    1.130 s …  1.141 s    5 runs
  HEAD ran
    1.41 ± 0.01 times faster than ch22
index --full: ch22 3.462 s, HEAD 3.003 s, speedup 1.15x
bench search: ch22 1.605 s, HEAD 1.135 s, speedup 1.41x
### segment.sft of ch22 against HEAD
byte-identical
```

这里 `sift index --full` 是 3.462 秒到 3.003 秒（1.15 倍），整个 `sift bench search` 进程是 1.605 秒到 1.135 秒（1.41 倍），两份 `segment.sft` 逐字节相同。进程整体的数字里有解释器启动、导入 typer 和 SQLAlchemy、打开索引，这些我没动，我猜这就是它比“12 个查询本身”的倍数小的原因（我没有单独量启动成本）。12 个查询本身要看 `sift bench search` 自己打出来的那一行总和，下面“总账”一节再给。hyperfine 的 `-N` 不经过 shell，`--warmup 1` 先热一次；`bench search` 那一支它警告了第一次运行偏慢，我没有管，因为 5 次的标准差只有 10 毫秒。

我要强调的是顺序：基准、钉住行为、剖析、改一处、再量。下面按这个顺序走。

## timeit 的五条规矩

小段代码的计时用 `timeit`。`lab/ch23/timeit_rules.py` 拿语料里最长的一篇（120,749 个字符、26,228 个词元）跑 `iter_tokens`，把五条规矩各演示一遍：

```text
$ python3 lab/ch23/timeit_rules.py
text: 120749 characters, 26228 tokens
rule 1, run the generator: 0.0000 of the real cost
  (iter_tokens(text) alone builds a generator and stops)
rule 2, one run is one sample:
  7 single runs: min 17.79 ms, max 18.06 ms
rule 3, repeat, then take the minimum:
  best 17.91 ms, median 17.99 ms (20 calls x 7 repeats)
rule 4, autorange picks the loop count: 20 calls took 353 ms
rule 5, keep setup out of the statement: lower() alone is 1.1% of one tokenizer run
```

这一次前后读数是 `111 116 115 114 114` 和 `111 112 113 112 113`。逐条说：

- 规则 1，生成器要跑到底。`iter_tokens(text)` 只造出一个生成器对象就返回，函数体一行没执行，所以量到的是“造一个生成器”的成本，约为真实成本的 0.0000 倍。第 5 篇讲过生成器是惰性的，这里是它在计时上的后果：初学者写 `timeit.timeit(lambda: iter_tokens(text))`，得到一个快得离谱的数字，然后得意。
- 规则 2，一次运行只是一个样本。这 7 次单次运行的最小和最大差 0.27 毫秒，约 1.5%，在快状态下相当稳。但我在第 11 篇见过慢状态下 2.5 倍的差别，所以只有一个样本的时候，我分不出差别来自代码还是来自机器。
- 规则 3，重复几次取最小值。最小值最接近“没有被别的东西打扰”的那一次。中位数 17.99 毫秒和最小值 17.91 毫秒只差 0.08 毫秒，说明这台机器此刻很安静。
- 规则 4，让 `autorange` 选循环次数。它按 1、2、5、10、20、50……试，直到总时间不少于 0.2 秒，这里选了 20 次，共 353 毫秒。
- 规则 5，准备工作不要放进被计时的语句。`text.lower()` 单独只占一次分词的 1.1%，这个量级的准备工作放进去还可以忍，但如果准备工作是读文件，量到的就是磁盘。

`timeit` 自己的实现里有两处值得看。`Lib/timeit.py` 第 173 到 181 行，`timeit()` 在计时前 `gc.disable()`，计时后按原状态恢复；第 59 行的 `default_timer = time.perf_counter`。也就是说，`timeit` 默认关掉垃圾回收，量到的是“不受回收打断”的速度；而真实程序里回收是开的。如果被计时的代码会分配大量容器对象，要想知道真实成本，得用 `setup="import gc; gc.enable()"` 一类的办法把它打开再量一遍。`repeat` 的文档字符串（第 183 到 207 行）说得很直白：别算均值和标准差，取最小值，因为高出来的部分多半是别的进程在打扰，不是 Python 变慢了。

命令行里也能直接用：

```text
$ python3 -m timeit -s "text = 'x' * 1000" "text.upper()"
1000000 loops, best of 5: 300 nsec per loop
```

`-m timeit` 自动 `autorange`，再重复 5 次取最小。小片段的快速核对用它，比写脚本省事。

## cProfile 与 pstats：确定性剖析

`timeit` 告诉我一段代码多快，不告诉我时间在哪。要回答“在哪”，先用 `cProfile`。`lab/ch23/cprofile_index.py` 对 `update_index(full=True)` 开 cProfile，打印两张 `pstats` 表：按累计时间排的前 15 行，和按自身时间排的前 5 行。核心部分是这几行：

```python
# ... imports, OUT = Path("out/ch23/index.pstats") ...
def main() -> None:
    """Profile update_index(full=True) over the corpus."""
    config = load_config()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        profiler = cProfile.Profile()
        profiler.enable()
        report = update_index(
            config.corpus,
            Path(tmp) / "idx",
            config.pipeline,
            full=True,
        )
        profiler.disable()
    print(f"indexed {report.documents} documents, {report.terms} terms")
    profiler.dump_stats(OUT)
    stats = pstats.Stats(profiler).strip_dirs()
    print("== sorted by cumulative time, top 15")
    stats.sort_stats(pstats.SortKey.CUMULATIVE).print_stats(15)
    print("== sorted by own time, top 5")
    stats.sort_stats(pstats.SortKey.TIME).print_stats(5)
```

我先在 `ch22` 的副本上跑，这是优化前的样子（脚本是 `lab/ch23` 里的，`PYTHONPATH` 指向 `ch22` 的 `src`；前后读数 `165 166 166 162 114` 和 `113 114 112 114 113`）：

```text
$ PYTHONPATH=/tmp/sift-scratch/ch23/old/src python3 /tmp/sift-scratch/ch23/cprofile_old.py
indexed 123 documents, 81167 terms
== sorted by cumulative time, top 15
         18522273 function calls (18439837 primitive calls) in 6.310 seconds

   Ordered by: cumulative time
   List reduced from 1582 to 15 due to restriction <15>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
        1    0.073    0.073    6.557    6.557 store.py:301(update_index)
        1    0.000    0.000    4.214    4.214 parallel.py:260(index_items)
        2    0.000    0.000    4.214    2.107 parallel.py:162(_run_ordered)
        1    0.000    0.000    4.214    4.214 parallel.py:216(index_chunk)
        1    0.001    0.001    4.214    4.214 parallel.py:222(_index_chunk)
      123    0.020    0.000    3.845    0.031 index.py:434(add)
      123    0.337    0.003    3.824    0.031 index.py:295(add)
      246    0.357    0.001    2.691    0.011 index.py:196(_positions)
   794519    0.161    0.000    2.145    0.000 filters.py:55(__call__)
        1    0.184    0.184    2.032    2.032 segment.py:123(write_segment)
   813941    0.288    0.000    1.984    0.000 filters.py:35(__call__)
    81167    0.309    0.000    1.559    0.000 segment.py:111(_encode_postings)
   813941    0.779    0.000    1.283    0.000 tokenize.py:38(iter_tokens)
  1696302    0.739    0.000    0.953    0.000 varint.py:20(encode)
   289357    0.370    0.000    0.862    0.000 varint.py:58(encode_deltas)


== sorted by own time, top 5
         18522273 function calls (18439837 primitive calls) in 6.310 seconds

   Ordered by: internal time
   List reduced from 1582 to 5 due to restriction <5>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
   813941    0.779    0.000    1.283    0.000 tokenize.py:38(iter_tokens)
  1696302    0.739    0.000    0.953    0.000 varint.py:20(encode)
   289357    0.370    0.000    0.862    0.000 varint.py:58(encode_deltas)
      246    0.357    0.001    2.691    0.011 index.py:196(_positions)
      123    0.337    0.003    3.824    0.031 index.py:295(add)
```

`cprofile_old.py` 就是 `cprofile_index.py` 把 `OUT` 换成 `/tmp` 下的路径，免得盖掉当前树的 `out/ch23/index.pstats`。这张表要读的列：

- `ncalls` 是调用次数。生成器每次被恢复都算一次调用，所以 `iter_tokens` 的 813,941 次其实是“恢复了 813,941 次”：约等于词元数加上标题的词元，再加每个生成器收尾的那一次。
- `tottime` 是函数自己花的时间，不含它调用的函数。`cumtime` 是含子调用的累计时间。按 `tottime` 排，看到的是“时间真的消耗在哪个函数体里”；按 `cumtime` 排，看到的是“哪一整棵调用子树贵”。
- 两个 `percall` 是各自除以调用次数。

按累计时间看，最大的子树是索引文档的 `add`（3.845 秒，占 6.310 秒的 61%），里面 `_positions`（2.691 秒）又占了大头；其次是 `write_segment`（2.032 秒）。按自身时间看，前五名是：

- `iter_tokens` 0.779 秒，813,941 次。
- `varint.encode` 0.739 秒，1,696,302 次。
- `encode_deltas` 0.370 秒，289,357 次。
- `_positions` 0.357 秒。
- `InvertedIndex.add`（`index.py:295`）0.337 秒。

没有一个是 BM25，因为索引构建里根本没有打分。分词、变长整数编码、给每个词建倒排表，这三件事占了前五名。调用次数更值得看：一次建索引调了 `varint.encode` 169 万次，`_encode_postings` 处理了 289,357 个 posting，平均每个 posting 约 5.9 次。优化之后 `encode` 还剩 831,248 次，少掉的 865,054 次（51%）都是值小于 128、编码出来只有一个字节的情形，它们现在不经过函数调用。这个数字在后面直接变成了一处改动。

优化之后同一个脚本（当前树，前后读数 `167 164 164 132 111` 和 `111 112 112 129 112`）：

```text
$ python3 lab/ch23/cprofile_index.py | sed -n '1p;/own time/,$p'
indexed 123 documents, 81167 terms
== sorted by own time, top 5
         15211986 function calls (15129550 primitive calls) in 5.116 seconds

   Ordered by: internal time
   List reduced from 1582 to 5 due to restriction <5>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
   813941    0.535    0.000    0.822    0.000 tokenize.py:45(iter_tokens)
   831248    0.424    0.000    0.560    0.000 varint.py:20(encode)
   813941    0.373    0.000    1.542    0.000 filters.py:35(__call__)
      246    0.331    0.001    2.173    0.009 index.py:196(_positions)
    81167    0.297    0.000    1.066    0.000 segment.py:111(_encode_postings)
```

前五名换了人：`iter_tokens` 从 0.779 降到 0.535 秒；`varint.encode` 的调用从 1,696,302 次降到 831,248 次，自身时间从 0.739 降到 0.424 秒；`encode_deltas` 掉出了前五，因为它的活儿现在由 `append_deltas` 干，而 `append_deltas` 对一个字节的值根本不调 `encode`；`InvertedIndex.add` 也掉出去了；NFKC 过滤器（`filters.py:35`）升到第三（0.373 秒），`_encode_postings` 升到第五（0.297 秒）。总时间从 6.310 秒降到 5.116 秒，函数调用从 18,522,273 次降到 15,211,986 次。

这里有个读法上的陷阱：`cProfile` 的开销是每次调用都要付的，所以它高估调用多的代码。真实的 `sift index --full` 在这台机器上约 2.6 秒，开着 `cProfile` 是 5.5 秒，慢了 2.1 倍（详见下一节的开销表）；`cProfile` 看到的改进是 6.310 到 5.116 秒（1.23 倍），而不开剖析器时是 1.17 倍。方向对，倍数不能直接搬。拿 `cProfile` 找“哪里”，用 `hyperfine` 或 `timeit` 量“多少”。

`cProfile` 在 3.14 里是怎么钩住每次调用的？`Lib/cProfile.py` 第 28 行 `class Profile(_lsprof.Profiler)`，真正干活的是 C 扩展 `Modules/_lsprof.c`。从 3.12 起它建在 `sys.monitoring`（PEP 669）上：第 771 到 783 行的 `callback_table` 把 `PY_START`、`PY_RESUME`、`PY_RETURN`、`PY_YIELD`、`CALL`、`C_RETURN` 等事件接到几个回调上，第 1013 行 `self->tool_id = PY_MONITORING_PROFILER_ID`。这意味着 `cProfile` 占着 `sys.monitoring` 的 `PROFILER_ID` 这个工具位。我验证了一下：先用 `use_tool_id(PROFILER_ID, ...)` 占住它，再启用 `cProfile`：

```text
$ python3 /tmp/sift-scratch/ch23/tool_conflict.py
cProfile.enable: ValueError: tool 2 is already in use
after free_tool_id: cProfile enabled
None
```

所以 `cProfile` 和自己写的 `sys.monitoring` 工具不能共用 `PROFILER_ID`；后面的 `sys_monitoring.py` 脚本先释放它，再去测 `cProfile` 的开销，就是因为这个。

`sift bench search --profile`（这一章新加的选项）把同样的东西接到了命令行上。它只在查询循环里开 `cProfile`，打开索引和写查询日志都在外面：

```python
        # ... inside run_bench_search, in the "with open_index" block ...
        profiler = cProfile.Profile()
        if profile:
            profiler.enable()
        for query in filter(None, queries):
            start = time.perf_counter()
            result = searcher.search(query, config.limit)
            elapsed = time.perf_counter() - start
            timings.append((query, result.total, elapsed))
            logged.append((query, result.total, result.took_ms))
        if profile:
            profiler.disable()
```

结果写到 `out/profile.pstats`，用 `python3 -m pstats` 打开，它是个交互式的浏览器，可以用管道喂命令：

```text
$ printf "sort tottime\nstats 4\nquit\n" | python3 -m pstats out/profile.pstats
Welcome to the profile statistics browser.
out/profile.pstats% out/profile.pstats% Mon Oct 26 11:44:06 2026    out/profile.pstats

         529462 function calls (529367 primitive calls) in 0.646 seconds

   Ordered by: internal time
   List reduced from 126 to 4 due to restriction <4>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
     3256    0.298    0.000    0.422    0.000 /home/bfmhno3/Projects/sift/src/sift/analysis/tokenize.py:74(iter_hit_spans)
     2099    0.154    0.000    0.154    0.000 {built-in method unicodedata.normalize}
       77    0.102    0.001    0.190    0.002 /home/bfmhno3/Projects/sift/src/sift/snippet.py:24(_origin)
   412927    0.042    0.000    0.042    0.000 {method 'span' of 're.Match' objects}


out/profile.pstats% Goodbye.
```

浏览器里 `callers` 和 `callees` 命令能看某个函数被谁调、调了谁，`sort cumtime` 换排序。这张表是优化之后的搜索，它的“之前”在后面“搜索的热点其实是片段”一节。

## 采样与确定性：同一次建索引，四种工具

`cProfile` 在每次调用和返回时记一笔，所以调用次数是精确的，代价是慢。另一类剖析器每隔一小段时间看一眼“现在在执行哪个函数”，叫采样剖析器：它不关心调用了几次，只统计“时间落在哪”。两类各有盲区。确定性的会放大小函数的成本（每次调用都付钩子的钱）；采样的会漏掉比采样间隔短得多的事，样本少的时候排名靠后的项只是噪声。

`sift index --full` 自己会打印“took N ms”，所以我拿它当尺子：同一条命令，不同的工具包着跑，看工具本身拖慢多少。脚本 `overhead.sh` 依次跑，前后夹了 `cpu_state.py`（`113 114 114 114 113` 和 `112 117 114 115 114`）：

```text
$ bash /tmp/sift-scratch/ch23/overhead.sh
plain:       2605.9 ms
pyinstrument: 4906.4 ms
memray:      4415.0 ms
plain:       2603.7 ms
cProfile:    5533.7 ms
py-spy exit 0
py-spy:      2652.4 ms
plain:       2630.2 ms
```

三次不带工具的基线是 2605.9、2603.7、2630.2 毫秒，取平均 2613 毫秒：

| 工具 | 类型 | 毫秒 | 相对基线 |
| --- | --- | --- | --- |
| `cProfile`（`python3 -m cProfile`） | 确定性，钩每次调用 | 5533.7 | 2.12 倍 |
| `pyinstrument` 5.1.3 | 采样（见下） | 4906.4 | 1.88 倍 |
| memray 1.19.3 | 追踪每次分配 | 4415.0 | 1.69 倍 |
| `py-spy` 0.4.2，20 Hz | 外部采样 | 2652.4 | 1.02 倍 |

`py-spy` 几乎没有开销，因为它在被测进程外面，隔一段时间读一次被测进程的内存，被测进程自己不用付任何钱。`pyinstrument` 叫采样剖析器，却比我想的贵：1.88 倍。我没有去读它的实现来解释，我猜是它在每次调用事件上都要检查时钟，这个负载又恰好是“调用多而细”（前面看到 1,696,302 次 `encode`），所以它在这儿不便宜。结论不是“pyinstrument 慢”，而是“在你的负载上量一下”。

### pyinstrument：看调用树

`pyinstrument` 打印的是一棵带时间的调用树，把每个节点的子节点合在一起，这比 `pstats` 的平铺表更接近人想问的问题：“`add` 里面的时间是怎么分给子调用的”。命令是：

```text
$ python3 -m pyinstrument -r text --no-color -o out/ch23/pyinstrument-tree.txt -m sift index --full
```

注意 `python3 -m pyinstrument`，而不是直接敲 `pyinstrument`。开发环境里 `pyinstrument` 的启动脚本是 Nix 包装过的，它忽略仓库的虚拟环境，直接敲会报 `ImportError: No module named sift`；`-m` 用的是当前 `python3`，所以能找到 `sift`。下面是输出的开头和中间我关心的那一段（树很长，我省略了不相关的分支，保持原有缩进）：

```text
  _     ._   __/__   _ _  _  _ _/_   Recorded: 11:43:48  Samples:  4750
 /_//_/// /_\ / //_// / //_'/ //     Duration: 5.146     CPU time: 5.089
/   _/                      v5.1.3

Program: sift index --full

5.146 <module>  sift/__main__.py:1
└─ 5.121 main  sift/cli.py:953
   └─ 5.121 Typer.__call__  typer/main.py:1131
         [2 frames hidden]  click, typer
            5.116 SiftGroup._main  typer/core.py:156
            └─ 5.116 SiftGroup.invoke  sift/cli.py:90
               └─ 5.116 SiftGroup.invoke  click/core.py:1868
                     [2 frames hidden]  click
                        5.116 wrapper  typer/main.py:1505
                        └─ 5.116 run_index  sift/cli.py:343
                           ├─ 4.657 update_index  sift/storage/store.py:301
                           │  ├─ 2.941 index_items  sift/parallel.py:260
                           │  │  └─ 2.940 _run_ordered  sift/parallel.py:162
                           │  │     └─ 2.940 index_chunk  sift/parallel.py:216
                           │  │        └─ 2.940 _index_chunk  sift/parallel.py:222
                           │  │           ├─ 2.599 IndexWriter.add  sift/index.py:456
                           │  │           │  └─ 2.587 InvertedIndex.add  sift/index.py:319
                           │  │           │     ├─ 1.820 _positions  sift/index.py:196
                           │  │           │     │  ├─ 1.472 StopwordFilter.__call__  sift/analysis/filters.py:60
                           │  │           │     │  │  ├─ 1.341 NfkcCasefold.__call__  sift/analysis/filters.py:35
                           │  │           │     │  │  │  ├─ 0.741 iter_tokens  sift/analysis/tokenize.py:45
                           │  │           │     │  │  │  │  ├─ 0.439 [self]  sift/analysis/tokenize.py
                           │  │           │     │  │  │  │  ├─ 0.123 fold  sift/analysis/tokenize.py:20
                           │  │           │     │  │  │  │  │  └─ 0.115 normalize  <built-in>
                           │  │           │     │  │  │  │  ├─ 0.117 tuple.__new__  <built-in>
                           │  │           │     │  │  │  │  └─ 0.061 Match.span  <built-in>
                           │  │           │     │  │  │  ├─ 0.318 [self]  sift/analysis/filters.py
                           │  │           │     │  │  │  ├─ 0.192 fold  sift/analysis/tokenize.py:20
                           │  │           │     │  │  │  │  ├─ 0.080 [self]  sift/analysis/tokenize.py
                           │  │           │     │  │  │  │  └─ 0.065 str.casefold  <built-in>
                           │  │           │     │  │  │  └─ 0.057 str.isascii  <built-in>
                           │  │           │     │  │  └─ 0.131 [self]  sift/analysis/filters.py
                           │  │           │     │  ├─ 0.234 [self]  sift/index.py
                           │  │           │     │  └─ 0.069 dict.get  <built-in>
                           │  │           │     └─ 0.698 _append_postings  sift/index.py:209
                           │  │           └─ 0.322 Document.from_markdown  sift/document.py:78
                           │  │              └─ 0.282 strip_markdown  sift/markdown.py:48
                           │  ├─ 1.406 write_segment  sift/storage/segment.py:133
                           │  │  ├─ 0.975 _encode_postings  sift/storage/segment.py:111
                           │  │  │  ├─ 0.626 append_deltas  sift/storage/varint.py:58
                           │  │  │  │  ├─ 0.323 encode  sift/storage/varint.py:20
                           │  └─ ...
                           ├─ 0.262 <module>  sift/storage/store.py:1
                           │  ├─ 0.165 <module>  sqlalchemy/__init__.py:1
                           └─ 0.193 [self]  sift/cli.py
```

这棵树给了 `cProfile` 表给不了的东西：

- 导入的成本是看得见的。`sift/storage/store.py` 的导入（里面是 `sqlalchemy`）0.262 秒，占 5.1 秒的 5%。这是 `sift --help` 也要付的启动成本，第 22 篇讲过惰性导入。
- 文档解析（`Document.from_markdown`）0.322 秒，比建倒排表小得多。
- `[self]` 一行是函数自己的时间，不含子节点。`iter_tokens` 自己的 `[self]` 是 0.439 秒，`tuple.__new__` 0.117 秒，`Match.span` 0.061 秒；NFKC 过滤器的 `[self]` 0.318 秒，`fold` 0.192 秒，`str.isascii` 0.057 秒。也就是说，优化之后 NFKC 过滤器里仍有一笔钱花在 `fold` 上，那是非 ASCII（中文）词元的折叠。

这一次是在当前树上量的（`update_index` 4.657 秒，整个命令里 `took` 4849 毫秒，是开着 `pyinstrument` 的）。树里已经出现了 `append_deltas` 和 `_append_postings`，是这一章新加的。

### py-spy：从外面看，画火焰图

`py-spy` 是用 Rust 写的，从外面读 Python 解释器的内存，推出当前的栈。`extra.sh` 里的那一行是：

```text
$ py-spy record --rate 20 -o out/figures/ch23-flame.svg -- python3 -m sift index --full
py-spy> Sampling process 20 times a second for 30 seconds. Press Control-C to exit.

documents: 123
vocabulary: 81167
full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took 2592.4 ms

py-spy> Stopped sampling because process exited
py-spy> Wrote flamegraph data to 'out/figures/ch23-flame.svg'. Samples: 44 Errors: 0
```

三个细节。第一，`py-spy` 读别的进程的内存要用 `ptrace`。这台机器上 `/proc/sys/kernel/yama/ptrace_scope` 是 1，意思是只能跟踪自己的子孙进程。`py-spy record -- python3 -m sift ...` 是 `py-spy` 自己拉起被测进程，所以可行；对一个已经在跑的进程我试了一下：

```text
$ python3 -c "import time; time.sleep(8)" & py-spy dump --pid $!
Permission Denied: Try running again with elevated permissions by going 'sudo env "PATH=$PATH" !!'
```

附到已有进程上要 `sudo`，或者把 `ptrace_scope` 调成 0，我没有试后者。`extra.sh` 的约定是：如果 `ptrace` 被拒，把错误存进 `out/ch23/py_spy.txt`，跳过这一步，不让整个脚本失败。

第二，采样率。仓库里最后一个提交 `b88f446` 的说明写着：在 `make` 下，50 Hz 以上 `py-spy` 会落后，看不到子进程退出，永远不结束；20 Hz 能得到完整的图。我没有复现那个“永远不结束”，只跑了 20 Hz 的，两次都正常结束，第二次（`--format raw`，下面用到）退出码是 0。0.4.2 偶尔在结尾报 `Error: No child processes (os error 10)`，是它最后一次 `waitpid` 遇到了 `ECHILD`，图已经写好了，我这两次都没碰到。20 Hz、3 秒左右的运行只有几十个样本：上面这次是 44 个，一个样本就是 2.3%，所以它的排名只能看大的，不能看小的。

第三，也是我没想到的：这张 SVG 没法当图片放进文章里。我用图片方式打开了仓库里生成的 `out/figures/ch23-flame.svg`（51,220 字节，1200×954，`inferno` 画的）。眼前是一叠彩色横条：顶上 14 条横贯全宽的色条，往下分成几支，最左边一支约 7% 宽，一路往下很深；中间一支约 43% 宽；右边一支约 39% 宽；其余是几块窄条。但**每条色条上都没有字**，标题也没有。原因在文件里：SVG 的根元素带 `onload="init(evt)"`，里面有一个 `<script>`，函数名是由这段脚本在浏览器里填进空的 `<text>` 元素的；用 `<img>` 加载 SVG 时浏览器不执行脚本，所以只剩色条。一张没有函数名的火焰图只是一张色块，我没有把它放进文章，也不想把带脚本的 SVG 内联进页面。想看的话，直接用浏览器打开那个 `.svg` 文件，可以点开缩放、搜索函数名。

名字其实都在文件里，每个 `<rect>` 前面跟着一个 `<title>`。我把宽度不小于 5% 的框读出来，对上了刚才那几支：最左一支（3 个样本，6.8%）是 `_find_and_load` 一路到 `exec_module`，也就是导入；中间一支（19 个样本，43.2%）是 `update_index`（`store.py:341`）→ `index_items` → `_index_chunk` → `InvertedIndex.add` → `_positions` → 过滤器；右边一支（17 个样本，38.6%）是 `update_index`（`store.py:363`）→ `write_segment` → `_encode_postings` → `append_deltas`。图里找不到的是我没看出来的那 11% 的碎条。这和 `pyinstrument` 的树对得上：建倒排表约占 57%，写段文件约占 27%。

没有图，我再用 `py-spy` 的原始格式（`--format raw`，每行是一条栈加样本数）汇总叶子函数。这一次的运行共 67 个样本，汇总脚本 `leaf_counts.py` 十几行，按每条栈的最后一帧累加：

```text
$ py-spy record --rate 20 --format raw -o over.raw -- python3 -m sift index --full
$ python3 /tmp/sift-scratch/ch23/leaf_counts.py over.raw
samples 67
self   8 11.9% fold (sift/analysis/tokenize.py:22)
self   8 11.9% iter_tokens (sift/analysis/tokenize.py:70)
self   4  6.0% 
self   3  4.5% _append_postings (sift/index.py:222)
self   3  4.5% do_executemany (sqlalchemy/engine/default.py:949)
self   3  4.5% append_deltas (sift/storage/varint.py:66)
self   2  3.0% stale_ids (sift/storage/manifest.py:60)
self   2  3.0% _merged (sift/storage/store.py:298)
```

名字为空的 4 个样本是 `py-spy` 没解析出名字的帧，我没去追。要点是：`fold` 和 `iter_tokens` 并列第一，各 8 个样本，约 12%，这和 `cProfile` 与 `pyinstrument` 的结论一致，而 `py-spy` 几乎没有拖慢进程（1.02 倍）。但 67 个样本支撑不了“第四名比第五名重要”这种话。`do_executemany`（SQLAlchemy 的批量写）出现在叶子里也有意思：采样看得见数据库那一段，而它在 `cProfile` 的前 15 里排不上。

## 逐行：kernprof 不在，用 sys.monitoring 自己做一个

函数级的表告诉我 `iter_tokens` 是热点，不告诉我是函数里哪一行。这是 `line_profiler`（命令 `kernprof -l -v`）的位置：给函数加 `@profile`，它按行记时间。`extra.sh` 里有一支调它，但开发环境里没有：

```text
$ cat out/ch23/line_profiler.txt
kernprof unavailable: line-profiler is not in the flake, skipped
$ python3 -c "import line_profiler"
ModuleNotFoundError: No module named 'line_profiler'
```

所以那一支的 `kernprof -l -v line_tokenize.py` 命令我没有跑过，它是否能正确运行是**未验证**的。装 `line-profiler` 需要改 `flake.nix`，这一章我不动环境。

不过 `sys.monitoring` 有 `LINE` 事件，每执行一行触发一次，可以自己做一个计数器。思路：每次收到 `LINE`，把“距上一次事件过了多久”记到上一行头上。回调本身也要花时间，每行一样，所以命中次数是准的，时间占比只能当参考。下面是脚本的核心（`line_times.py`，完整的有一个导入的小修正：`sift.analysis` 把名字 `tokenize` 换成了函数，所以我用 `importlib` 取模块）：

```python
# ... imports; TOOL = sys.monitoring.PROFILER_ID; hits, spent: Counters
def on_line(code, line: int) -> None:
    now = time.perf_counter_ns()
    if last[1]:
        spent[last[0]] += now - last[1]
    hits[line] += 1
    last[0] = line
    last[1] = time.perf_counter_ns()


# ... in main(): register on_line for events.LINE, enable it only
# for iter_tokens.__code__ with set_local_events, run the longest post
```

先在 `ch22` 上跑，再在当前树上跑（最长的一篇，26,228 个词元）：

```text
$ PYTHONPATH=/tmp/sift-scratch/ch23/old/src python3 /tmp/sift-scratch/ch23/line_times.py
26228 tokens; 120749 characters
   hits   time  line
      1   8.7%  51: folded = fold(text)
      1   0.0%  52: position = 0
  15211  17.0%  53: for match in _TOKEN.finditer(folded):
  15210   7.9%  54: if match["latin"] is not None:
  12386  18.1%  55: yield Token(match["latin"], position, match.start(), match.end())
  12386   4.6%  56: position += 1
  12386   3.8%  57: continue
   2824   1.4%  58: run = match["cjk"]
   2824   1.3%  59: if len(run) == 1:
    338   0.5%  60: yield Token(run, position, match.start(), match.end())
    338   0.1%  61: position += 1
    338   0.1%  62: continue
  15990   6.3%  63: for i in range(len(run) - 1):
  13504   5.7%  64: start = match.start() + i
  13504  19.5%  65: yield Token(run[i : i + 2], position, start, start + 2)
  13504   5.0%  66: position += 1
$ python3 /tmp/sift-scratch/ch23/line_times.py
26228 tokens; 120749 characters
   hits   time  line
      1   9.4%  58: folded = fold(text)
      1   0.0%  59: position = 0
      1   0.0%  60: new = _new_token
  15211  17.5%  61: for match in _TOKEN.finditer(folded):
  15210   7.5%  62: run = match[0]
  15210   7.2%  63: start, end = match.span()
  15210   6.7%  64: if match.lastgroup == "latin" or end - start == 1:
  12724  11.6%  65: yield new(Token, (run, position, start, end))
  12724   4.7%  66: position += 1
  12724   4.2%  67: continue
  15990   6.4%  68: for i in range(end - start - 1):
  13504   4.7%  69: at = start + i
  13504  15.1%  70: yield new(Token, (run[i : i + 2], position, at, at + 2))
  13504   5.0%  71: position += 1
```

读法：

- 命中次数是确定的。15,211 个正则匹配（第一行 `for` 多一次是循环结束），其中拉丁词 12,386 个、单个汉字 338 个、汉字串 2,486 个，汉字串展开成 13,504 个二元组。当前树把“单个汉字”（338 次）和“拉丁词”合成同一个分支，所以 12,386 + 338 = 12,724。
- 在 `ch22` 里，两条 `yield Token(...)`（第 55、65 行）合计 37.6% 的时间；`Token(...)` 要调用 `NamedTuple` 生成的 `__new__`，这在前面 `sys.monitoring` 一节会看到是 125 次 `<lambda>` 调用。当前树里，两条 `yield new(Token, (...))` 合计 26.7%。
- 每次循环里，`ch22` 要做 `match["latin"]` 两次（第 54、55 行）、`match.start()` 和 `match.end()` 各一次；当前树做 `match[0]`、`match.span()`、`match.lastgroup` 各一次。

这张表有两个陷阱，我要说明白。第一，`yield` 那一行的时间包含了消费者（`sum(1 for _ in ...)`）在恢复生成器之前做的事，所以这几行偏高。第二，回调本身开销不小，所有行都被拉长了，只有占比有参考意义。它不能代替 `line_profiler`，但命中次数这一列是准的，而且不用装任何东西。

## 内存：tracemalloc 与 memray

慢和占内存是两回事。`lab/ch23/tracemalloc_top.py` 用标准库的 `tracemalloc` 建内存索引，按源码行汇总存活的内存：

```text
$ python3 lab/ch23/tracemalloc_top.py
load_index took 5217.7 ms
81167 terms
live 83.9 MiB, peak 84.0 MiB
top 10 lines by live memory:
  32.67 MiB   581380 blocks  index.py:221
  12.62 MiB   413538 blocks  tokenize.py:71
  10.62 MiB   348069 blocks  tokenize.py:66
   8.13 MiB    82129 blocks  index.py:224
   6.04 MiB      123 blocks  markdown.py:74
   4.39 MiB    82128 blocks  index.py:50
   3.93 MiB    66490 blocks  tokenize.py:70
   3.86 MiB    82127 blocks  index.py:70
   0.73 MiB    15584 blocks  tokenize.py:62
   0.41 MiB     3951 blocks  <frozen importlib._bootstrap_external>:511
```

最后一个索引占 83.9 MiB。第一名 `index.py:221` 是 `_append_postings` 里的 `posting = Posting(doc_id, tuple(found))`：32.67 MiB、581,380 块，正好是 289,357 个 posting 的两倍多一点，每个 posting 一个 `Posting` 元组加一个位置元组。第二、第三名 `tokenize.py:71` 和 `66` 都是 `position += 1`：每个词元的 `position` 是个整数，超过 256 之后每个都是新的 `int` 对象，被位置元组留住了，合起来 23.2 MiB。也就是说，索引的内存主要是“很多很小的 Python 对象”，而不是文本本身（语料原文 `markdown.py:74` 那一行才 6.04 MiB）。

`tracemalloc` 不是免费的：同一个 `load_index`，不带它是 1.87 秒（我跑了两次，1.882 和 1.873），带着它是 5.2 秒，慢 2.8 倍。memray 从外面追踪分配，`extra.sh` 里是 `memray run` 加 `memray stats`：

```text
$ python3 -m memray run -f -o index.bin -m sift index --full
$ python3 -m memray stats index.bin

📏 Total allocations:
	883989

📦 Total memory allocated:
	1.327GB

📈 Peak memory usage:
	132.308MB

🥇 Top 5 largest allocating locations (by size):
	- iter_tokens:/home/bfmhno3/Projects/sift/src/sift/analysis/tokenize.py:61 -> 506.329MB
	- strip_markdown:/home/bfmhno3/Projects/sift/src/sift/markdown.py:58 -> 102.909MB
	- fold:/home/bfmhno3/Projects/sift/src/sift/analysis/tokenize.py:22 -> 83.483MB
	- get_data:<frozen importlib._bootstrap_external>:950 -> 56.113MB
	- _strip_inline:/home/bfmhno3/Projects/sift/src/sift/markdown.py:41 -> 49.690MB
```

（我只摘了 `stats` 输出里要用的几段，直方图和分配器分布省略。）两个数字摆在一起：一共分配了 1.327 GB，峰值只有 132.308 MB。差了 10 倍，说明大部分分配很快就释放了。最大的一项 `tokenize.py:61` 是 `for match in _TOKEN.finditer(folded)`，我猜每次迭代分配的是那个 `re.Match` 对象，共 461,866 次，加起来 506 MB，用完就丢。这就是“分配多”和“占用多”的区别：前者拖慢速度（每次分配和释放都要时间），后者决定会不会 OOM。memray 的峰值（132 MB）比 `tracemalloc` 的（84 MB）高，多半是因为 memray 看的是整个 `sift index --full`（包括解释器、SQLAlchemy 和写段文件），`tracemalloc` 只看 `load_index` 这一段；我没有把两边的范围对齐再量。

这一章我没有动内存，只量了。这些短命的 `Match` 对象能不能省，我没有试；`finditer` 的循环就是分词本身，要换写法会让代码明显更难读，我宁可先看别处的账。

## 先把行为钉住

剖析之前我先做的一件事，是写一个测试，把“12 条基准查询各自的前 10 名”钉死。优化改的是实现，不是结果；如果某次“加速”悄悄挪动了一个文档的名次，我要它立刻变红，而不是三个月后有人发现搜索结果不对。这个测试在 `ch22` 的代码上写成，提交 `93c4094`，在任何热点被改动之前（那个提交里没有源码改动，只有这个测试）。

```python
TOP10: dict[str, list[int]] = {
    "rust 所有权": [78, 79, 85, 84, 82, 80, 89, 91, 86, 90],
    "kalman filter": [15, 20, 19, 14, 21],
    '"device tree"': [7, 115, 113, 112],
    "pid AND 积分": [69, 74, 65, 71, 68, 73, 72, 70, 67, 66],
    "tag:Rust lifetime": [81, 79, 89, 91],
    "矩阵 OR matrix": [73, 40, 26, 104, 18, 25, 34, 52, 51, 109],
    "typst -latex": [110, 96, 108, 99, 98, 105, 109, 107, 103, 106],
    "cmake vcpkg": [116, 77, 78],
    "gdb 断点": [10, 115, 0],
    "linux kernel module": [112, 115],
    "奇异值": [109, 57, 32, 53, 56, 29, 30, 36, 33, 52],
    "owner*": [115, 94, 79, 81, 86, 91],
}

pytestmark = [
    pytest.mark.slow,
    pytest.mark.skipif(not CORPUS.is_dir(), reason="run `make corpus` first"),
]


# ... the pipeline and searcher fixtures: an in-memory index of the
# full corpus, built once per module ...


def test_every_bench_query_is_pinned() -> None:
    queries = QUERIES.read_text(encoding="utf-8").splitlines()
    assert [q for q in queries if q] == list(TOP10)


@pytest.mark.parametrize("query", list(TOP10))
def test_top10_doc_ids(searcher: Searcher, query: str) -> None:
    result = searcher.search(query, 10)
    assert [hit.doc_id for hit in result.hits] == TOP10[query]
```

几个选择值得说。固定的是 `doc_id` 的列表，不是分数：浮点分数在不同的求和顺序下会有最后一位的差别，名次不会，而用户看到的是名次。基准查询文件改了，`test_every_bench_query_is_pinned` 会提醒我同步更新这张表，免得“12 条”变成“13 条里 12 条被钉住”。整个测试用 `slow` 标记，语料目录 `corpus/` 不在就跳过（CI 之外没有语料的机器上不会因此变红）。

它有没有真的钉在 `ch22` 的行为上？我把这个测试放进 `ch22` 的干净副本里跑，再在当前树上跑：

```text
$ cd /tmp/sift-scratch/ch23/pin   # git archive ch22 + tests/test_search_stable.py
$ PYTHONPATH=$PWD/src python3 -m pytest tests/test_search_stable.py -p no:cacheprovider -o addopts=''
============================== 13 passed in 3.69s ==============================
$ cd ~/Projects/sift
$ python3 -m pytest tests/test_search_stable.py -p no:cacheprovider -o addopts=''
============================== 13 passed in 3.07s ==============================
```

两边都是 13 个通过（12 条查询加 1 个检查查询文件的）。这证明表里的名次是 `ch22` 的行为，当前树没有改变它。

一个钉子好不好，要看它能不能被打红。我在当前树的副本里故意造了四个“优化出错”的版本，让这个测试和别的测试各跑一遍：

| 故意引入的错误 | `test_search_stable.py` | 其余测试（`-x`，遇到第一个失败就停） |
| --- | --- | --- |
| BM25 的长度归一化 `doc_len / avg_len` 换成 `1.0` | 9 个失败，4 个通过 | 未跑 |
| NFKC 过滤器对 ASCII 词元不做 `lower()` | 13 个通过 | 未跑 |
| 双字分词里漏掉 `position += 1` | 13 个通过 | 1 个失败，10 个通过（2.35 秒） |
| 单个汉字不再产生词元（去掉 `or end - start == 1`） | 13 个通过 | 1 个失败，4 个通过（4.68 秒） |

第一行是它该抓的：名次变了，9 条查询变红，输出里能直接看出差异，比如 `"device tree"` 的 `[115, 7, 112, 113]` 对不上 `[7, 115, 113, 112]`。

第二行我事先没想到。去掉 ASCII 词元的 `lower()` 之后，12 条查询的名次一个都没变，因为 `iter_tokens` 在切分之前就把整段文本 `fold` 过了（`folded = fold(text)`，第 58 行），过滤器拿到的拉丁词元早已是小写。换句话说，在默认的管线里，ASCII 词元的这一步折叠是冗余的；这个过滤器还保留着 `lower()`，是因为管线可以换成别的分词器，过滤器不该假设上游已经折叠。这个“错误”测试不到，不是测试的错，是它根本不是一个会改变结果的错误。

第三、四行说明另一件事：钉住名次不等于钉住行为。双字分词的位置错了，只有短语查询才会受影响，12 条基准查询里短语查询只有 `"device tree"`，而它是拉丁词；单个汉字不产生词元，12 条查询的前 10 名也恰好不变。这两个错误是被已有的单元测试和 hypothesis 属性测试抓住的（`-x` 让 pytest 停在第一个失败上，我没有逐个去看是哪一个）。所以这个钉子只是三层保护中的一层：名次钉子、单元与属性测试，再加我每改一步都做的 `cmp`：`segment.sft` 在每一步都和 `ch22` 逐字节相同，那是对索引内容最严的一道检查。

## 搜索的热点其实是片段

回到开头那个猜测。同一个脚本再跑一次，这次把两张表都贴出来（`ch22` 副本，前后读数 `112 112 112 112 112`；数字和开头那次差几毫秒，是又跑了一次）：

```text
$ SIFT_INDEX=/tmp/sift-scratch/ch23/idx-old PYTHONPATH=/tmp/sift-scratch/ch23/old/src python3 /tmp/sift-scratch/ch23/profile_search.py | sed -n 1,10p
         5540485 function calls (5540390 primitive calls) in 1.857 seconds

   Ordered by: internal time
   List reduced from 125 to 5 due to restriction <5>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
   702294    0.618    0.000    1.009    0.000 tokenize.py:38(iter_tokens)
       77    0.461    0.006    0.648    0.008 snippet.py:25(_origin)
       77    0.152    0.002    1.162    0.015 snippet.py:54(_hit_spans)
     2148    0.146    0.000    0.146    0.000 unicodedata.normalize
```

（最后一行我把 `{built-in method unicodedata.normalize}` 缩短了，其余原样。）这张表里没有 `bm25`，没有 `top_k`，没有倒排表的遍历。12 个查询一共要生成 77 段带高亮的片段，每段对应一篇命中文档，于是：

- `make_snippet` 被调 77 次，累计 1.829 秒，占总时间 1.857 秒的 98.5%。`search` 自己加 `bm25`（189 次，0.000 秒）加 `top_k` 加查询解析，合起来约 28 毫秒。
- `_hit_spans` 把 `iter_tokens` 当成一个“分词器”用：对整篇命中文档的正文分词（702,294 次恢复生成器，累计 1.009 秒），为了从中挑出那几个在查询词里的词元，其余全部丢掉。
- `_origin` 为命中文档的每一个字符做一次 `_folded_len` 查询，再把结果扫一遍看是不是全是 1：`snippet.py` 第 49 行的生成器表达式迭代了 2,166,692 次（77 篇文档的字符总数），自身 0.105 秒；`_origin` 自己是 0.461 秒。

我猜 BM25 慢，是因为打分“看起来像计算”，而片段“看起来像字符串处理”。剖析器不知道这些。猜测的依据是名字的气味，不是数据，这是最常见的错误，也是最便宜的错误：改 BM25 要动正确性最敏感的代码，而且根本换不来时间。

优化之后同一份脚本（当前树，同样 12 条查询）：

```text
$ SIFT_INDEX=/tmp/sift-scratch/ch23/idx-new python3 /tmp/sift-scratch/ch23/profile_search.py | sed -n 1,10p
         529426 function calls (529331 primitive calls) in 0.631 seconds

   Ordered by: internal time
   List reduced from 127 to 5 due to restriction <5>

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
     3256    0.294    0.000    0.415    0.000 tokenize.py:74(iter_hit_spans)
     2099    0.148    0.000    0.148    0.000 unicodedata.normalize
       77    0.099    0.001    0.183    0.002 snippet.py:24(_origin)
   412927    0.041    0.000    0.041    0.000 {method 'span' of 're.Match' objects}
```

函数调用从 5,540,485 次降到 529,426 次（降了一个数量级），`cProfile` 下的总时间从 1.857 秒降到 0.631 秒。第一名换成了 `iter_hit_spans`（0.294 秒，被调 3256 次，对应每篇命中文档的正则扫描）；`unicodedata.normalize` 0.148 秒，其中 77 篇文档各折叠一次正文的那部分占大头；`_origin` 从 0.461 降到 0.099 秒。

`sift bench search --profile` 把同一件事接到了命令行，这一章的 `extra.sh` 用它写了 `out/profile.pstats`（上一节用 `python3 -m pstats` 看过它的前四行）。它的成本是：查询在 `cProfile` 下跑，所以它打印的各条耗时不是基准耗时（`--help` 里写了，文档字符串里也写了）：

```text
$ sift bench search --profile | tail -n 3
   74.94 ms     6 hits  owner*
  647.05 ms  total for 12 queries
profile written to out/profile.pstats
```

不开 `--profile` 的 12 个查询总和是 525 毫秒左右（后面“总账”一节），开着是 647 毫秒，慢了 23%。在查询已经改完的树上，`cProfile` 只多花了这么多，我想是因为现在调用次数少。同样一件事在 `ch22` 上，`cProfile` 下是 1.857 秒，不开是 1.006 秒。

## 六处改动

每一处我都按同一个流程做：看剖析表里的哪一行，写一个能证明“两个版本结果一样”的测试，改，量，`cmp`。顺序是提交顺序。每一步的端到端数字放在“总账”一节的表里；这里给每处改动的代码、原因和它自己的小测量。

### 1. iter_tokens：别经过 NamedTuple 的 Python 层

`Token` 是个 `NamedTuple`，`Token(text, position, start, end)` 会调用 `collections.namedtuple` 生成的 `__new__`。那是一个 Python 函数，所以每个词元要付一次 Python 调用。后面“sys.monitoring”一节里 `ch22` 的输出能看到：125 个词元对应 125 次 `<lambda>`。改法有两处：

```python
# Token(...) runs a generated Python __new__; this skips that frame.
_new_token = cast(
    "Callable[[type[Token], tuple[str, int, int, int]], Token]",
    tuple[object, ...].__new__,
)


def iter_tokens(text: str) -> Iterator[Token]:
    # ... docstring ...
    folded = fold(text)
    position = 0
    new = _new_token
    for match in _TOKEN.finditer(folded):
        run = match[0]
        start, end = match.span()
        if match.lastgroup == "latin" or end - start == 1:
            yield new(Token, (run, position, start, end))
            position += 1
            continue
        for i in range(end - start - 1):
            at = start + i
            yield new(Token, (run[i : i + 2], position, at, at + 2))
            position += 1
```

- `tuple.__new__(Token, (…))` 直接在 C 里造出一个 `Token` 实例，跳过那个 Python 函数。`cast` 是给类型检查器看的：`tuple[object, ...].__new__` 的静态类型是“造一个 tuple”，不是“造一个 `Token`”，不 `cast` 的话 mypy 和 pyright 都会抱怨。
- 一个匹配 `match` 原来要取 `match["latin"]`（两次）、`match.start()`、`match.end()`：每次取组都是一个方法调用加一次字符串键查找。现在 `match[0]` 取整个匹配，`match.span()` 一次拿到起止，`match.lastgroup` 告诉我这个匹配落在哪个命名组里。

这个技巧的收益我单独量了。造一百万个 `Token`：

```text
$ python3 /tmp/sift-scratch/ch23/micro_token.py
loop only                        13.0 ns per iteration
Token(...)                      256.7 ns per iteration
tuple.__new__(Token, (...))     116.3 ns per iteration
```

（扣掉循环本身的 13.0 纳秒，是 243.7 对 103.3，约 2.4 倍。）整个 `iter_tokens` 对 123 篇文章共 812,338 个词元的耗时，是下面这个脚本在 `ch22` 副本和当前树上交替各跑三次的结果：

```text
$ for i in 1 2 3; do PYTHONPATH=.../old/src python3 micro_hot.py; python3 micro_hot.py; done
```

| 函数（123 篇文章） | `ch22`（毫秒，3 次的中位数） | 当前树 | 倍数 |
| --- | --- | --- | --- |
| `iter_tokens`，812,338 个词元 | 675.3 | 545.7 | 1.24 |
| 整条管线 `pipeline.terms`，792,920 个词 | 908.2 | 745.2 | 1.22 |
| `make_snippet`，123 篇各一次，词集 `{rust, 所有, 有权}` | 1121.7 | 567.9 | 1.97 |

前后读数 `112 113 113 113 113` 和 `113 115 115 115 115`。第三行把改动 5 和 6 的收益合在一起，后面解释。

### 2. NFKC 过滤器：ASCII 不必查 Unicode 表

NFKC 规范化和 `casefold` 的核心是 Unicode 表，对 ASCII 字符这两步什么也不改（NFKC 不动 ASCII，ASCII 的 `casefold` 等于 `lower`）。而这一步对每个词元都做：

```python
class NfkcCasefold(TokenFilterBase, name="nfkc"):
    """NFKC-normalize and casefold the text of every token."""

    def __call__(self, tokens: Iterable[Token]) -> Iterator[Token]:
        """Yield each token with its text folded.

        For ASCII text NFKC changes nothing and casefold is lower,
        which skips the Unicode tables.
        """
        for token in tokens:
            text = token.text
            folded = text.lower() if text.isascii() else fold(text)
            if folded != text:
                token = token._replace(text=folded)
            yield token
```

`str.isascii()` 在 CPython 里不扫描字符串：`Objects/unicodeobject.c` 第 12055 到 12059 行，`unicode_isascii_impl` 只返回 `PyUnicode_IS_ASCII(self)`，读的是字符串对象头里的一个标志位。`sys.monitoring` 能直接看出效果：在同一篇测试文章上，`fold` 的调用从 126 次降到 93 次（1 次是 `iter_tokens` 开头整篇折叠，其余 92 次应该是非 ASCII 的词元，原来是 125 次逐词折叠），见后面“sys.monitoring”一节。这一步单独的端到端收益，在我的交替测量里看不出来（见“总账”：中位数 2977.6 毫秒到 2968.0 毫秒，在噪声里）；它的提交说明里写的是 3.434 秒到 3.298 秒，我这边没有复现出这个量级。我留着它，是因为它的逻辑是对的而且测试覆盖了，但我不会说它是一处有收益的优化。

### 3. 建索引：只给没见过的词创建 PostingList

`InvertedIndex.add` 原来对每个文档的每个词写 `self._postings.setdefault(term, PostingList()).append(posting)`。`setdefault` 的第二个参数在调用之前就求值了，所以不论词是不是新的，`PostingList()` 都建一个，而 `PostingList.__init__` 要排序、算 `doc_ids()`、建 `set` 检查重复（`index.py` 第 48 到 52 行）。数一下：

```text
$ PYTHONPATH=/tmp/sift-scratch/ch23/old/src python3 /tmp/sift-scratch/ch23/count_plist.py
/tmp/sift-scratch/ch23/old/src
PostingList() calls: 290694, terms in the index: 81167
$ python3 /tmp/sift-scratch/ch23/count_plist.py
/home/bfmhno3/Projects/sift/src
PostingList() calls: 82127, terms in the index: 81167
```

290,694 次构造，只有 82,127 个要留下（正文 81,167 个词加标题索引的 960 个）。改法是用 `get`，没找到再建：

```python
def _append_postings(
    index: dict[str, PostingList],
    doc_id: int,
    positions: Mapping[str, list[int]],
) -> None:
    """Append one posting of doc_id to the list of every term.

    A PostingList is created only for a term met for the first time:
    building one costs a sort and a set, too much to throw away.
    """
    get = index.get
    for term, found in positions.items():
        posting = Posting(doc_id, tuple(found))
        plist = get(term)
        if plist is None:
            index[term] = plist = PostingList()
        plist.append(posting)
```

`_positions` 里也是同样的毛病：`setdefault(token.text, []).append(...)` 每个词元建一个空列表再丢掉，改成 `get` 加判断。这是 Python 里一个很经典的坑：`d.setdefault(k, Expensive())` 看着简洁，但 `Expensive()` 总会被求值。便宜的默认值（`[]`、`0`）可以接受，贵的不行；`collections.defaultdict` 是另一个办法，它只在缺键时调工厂，不过这里的实际写法是 `get` 加判断，我没有试 `defaultdict`。

### 4. 段文件写入：单字节的变长整数直接 append

`_encode_postings` 对每个 posting 写三样东西：与上一个 `doc_id` 的差、词频、各位置的差。原来每样都是 `out += encode(...)`，`encode` 每次造一个 `bytearray`、循环、再 `bytes()`。上面的 `cProfile` 已经告诉我：1,696,302 次调用。大部分值小于 128，LEB128 编码就是它本身那一个字节，根本不需要走这个函数。

```python
def append_deltas(out: bytearray, seq: Iterable[int]) -> None:
    """Append the delta-coded varints of seq to out.

    Same bytes as ``out += encode_deltas(seq)``, without the
    intermediate bytes object. A delta below 0x80 is one byte and
    skips the call to encode.
    """
    previous = 0
    for n in seq:
        delta = n - previous
        if delta < 0:
            raise ValueError(f"sequence decreases: {previous} then {n}")
        if delta < 0x80:
            out.append(delta)
        else:
            out += encode(delta)
        previous = n
```

`encode_deltas` 保留了它的合同，里面只是 `out = bytearray(); append_deltas(out, seq); return bytes(out)`；`_encode_postings` 里 `doc_id` 的差和 `tf` 同样先看是不是小于 0x80。`encode` 的调用从 1,696,302 次降到 831,248 次。测试用 hypothesis：`test_append_deltas_matches_encode_deltas` 给随机的非降序整数列表，外加一段随机的前缀字节，断言 `append_deltas` 追加出来的字节，等于前缀加上逐个 `encode` 的结果。前缀是为了证明函数追加而不是覆盖。

这是六处里索引端到端收益最大的一步：中位数从 2832.5 毫秒到 2576.2 毫秒，省了 256 毫秒（9%）。

### 5. 片段：折叠偏移只对不同的字符做一次

`_origin` 要给命中文档建一张“折叠前偏移到折叠后偏移”的表，因为 NFKC 会改变某些字符的长度（`…` 变成三个点）。原来对文档的每个字符调一次 `_folded_len`（已经 `@cache` 了，命中也要进一次缓存包装器），再用 `all(length == 1 for length in lengths)` 扫一遍。改法利用了一个事实：一篇文档里不同的字符很少，而字符总数很多。123 篇的正文里，每篇不同字符数的中位数是 623，最多 973；每篇字符数的中位数是 16,248，最多 120,749：

```python
def _origin(text: str) -> tuple[str, list[int] | None]:
    # ... docstring ...
    if text.isascii():
        return text, None
    folded = fold(text)
    sizes = {ch: _folded_len(ch) for ch in set(text)}
    if all(size == 1 for size in sizes.values()):
        return (text if len(folded) == len(text) else folded), None
    table = list(accumulate(map(sizes.__getitem__, text), initial=0))
    if table[-1] != len(folded):
        return folded, None
    return text, table
```

`set(text)` 是 C 里的一遍扫描，`sizes` 字典只有几百项，`map(sizes.__getitem__, text)` 把逐字符的 Python 层调用换成了 C 层的映射。如果所有不同字符折叠后都是一个字符，就不用建表：这是最常见的情形，直接返回。这一步的细节要小心，因为 `_origin` 的文档字符串花了很长篇幅解释它的边界情形（组合记号、ß 加重音符等）。所以有一个属性测试，`test_origin_matches_the_per_character_fold`，在一组故意挑出来的“麻烦字符”（`aAbß`、组合重音符、`ﬁ` 连字、`…`、`㍏`、`中`、全角 `Ａ`、空格）上随机组合文本，要求新旧两个实现返回完全一样的结果；旧实现被原样搬进了测试里，叫 `origin_per_character`。

12 个查询的总和：888.66 毫秒到 709.48 毫秒（中位数），省 179 毫秒。

### 6. 片段：只产出查询词的区间

`_hit_spans` 原来 `for token in iter_tokens(text)`，为整篇正文构造每一个 `Token`，只保留文本在 `terms` 里的那几个。702,294 个词元，77 篇文档。新增的 `iter_hit_spans(text, terms)` 用同一个正则、同一套规则（拉丁词、单个汉字、汉字二元组）扫描，但只对属于 `terms` 的词元产出 `(start, end)`，其余的一个对象都不造：

```python
def iter_hit_spans(
    text: str, terms: Collection[str]
) -> Iterator[tuple[int, int]]:
    """Yield (start, end) of the tokens of text whose text is in terms.

    The same tokens and offsets as the ones of iter_tokens that pass
    ``token.text in terms``, in the same order, but the other tokens
    are never built: a snippet keeps a handful out of thousands.

    >>> list(iter_hit_spans("The Fox ran. 搜索引擎", {"fox", "索引"}))
    [(4, 7), (14, 16)]
    """
    folded = fold(text)
    for match in _TOKEN.finditer(folded):
        run = match[0]
        start, end = match.span()
        if match.lastgroup == "latin" or end - start == 1:
            if run in terms:
                yield start, end
            continue
        for i in range(end - start - 1):
            if run[i : i + 2] in terms:
                at = start + i
                yield at, at + 2
```

代价是规则在两个函数里各写了一遍：改了 `iter_tokens` 的切分，必须同步改 `iter_hit_spans`，不然片段里的高亮会错位。我用测试守着这一点：`test_hit_spans_are_the_spans_of_the_tokens_in_terms`（前面贴过），随机文本和随机词集，要求 `iter_hit_spans` 等于“`iter_tokens` 过滤一遍”。

12 个查询的总和：709.48 毫秒到 536.15 毫秒，省 173 毫秒。`make_snippet` 对 123 篇文章的单独计时是 1121.7 毫秒到 567.9 毫秒（改动 5 和 6 一起，见上表）。

这六处的共同点是：都不改算法，都没有换数据结构，只是**少做**。少造一个对象，少调一次函数，少扫一遍文本。这也是为什么 `cmp` 能保持逐字节相同。

## 总账

每一步的收益，我对提交链上的 7 棵树（`ch22` 加六个提交）各做了 3 轮：每轮把 7 棵树依次跑一遍 `sift index --full`（取它自己打印的 `took`）和 `sift bench search`（取 12 个查询的总和），每一步结束都拿 `segment.sft` 和 `ch22` 的 `cmp`。每轮之间夹一次 `cpu_state.py`，读数是 `112 112 112 112 112`、`113 115 116 116 115`、`119 118 117 118 118`。表里是 3 轮的中位数：

| 提交 | 改动 | `index --full`（毫秒） | 12 个查询（毫秒） | `segment.sft` |
| --- | --- | --- | --- | --- |
| `ch22` | 基线 | 3082.7 | 1006.7 | 参照 |
| `4e50980` | `iter_tokens` 少一层 | 2977.6 | 899.1 | 相同 |
| `d3d218f` | NFKC 对 ASCII 跳过 | 2968.0 | 889.0 | 相同 |
| `c7c6d0d` | 只为新词建 `PostingList` | 2832.5 | 887.6 | 相同 |
| `8523ee7` | 单字节变长整数直接 append | 2576.2 | 888.7 | 相同 |
| `030fc57` | `_origin` 只折叠不同的字符 | 2570.4 | 709.5 | 相同 |
| `e2bb907` | `iter_hit_spans` | 2603.6 | 536.2 | 相同 |

读这张表我注意到三件事。一，每一步的收益都落在它该落的地方：索引的三步（`c7c6d0d`、`8523ee7`，以及 `4e50980` 的一部分）只让 `index` 一列变小，查询的两步（`030fc57`、`e2bb907`）只让查询一列变小，两列交叉的地方几乎没动（`8523ee7` 的查询列 887.6 到 888.7，`030fc57` 的索引列 2576.2 到 2570.4），这和提交说明里写的“not on its path”一致。二，`4e50980` 是例外：它同时让索引快了约 105 毫秒、查询快了约 107 毫秒，因为 `iter_tokens` 两条路径上都用。三，`e2bb907` 的索引列比上一行多了 33 毫秒（2570.4 到 2603.6），但这一步没有碰索引路径，3 轮的原始值是 2603.6、2623.5、2584.1，上一行是 2570.4、2566.3、2613.3，范围有重叠，我把它算作噪声。

再用另一个办法把头尾比一遍：5 轮交替，每轮 `ch22` 和当前树各一次，两棵树都是同一台机器、同一个 `corpus/`：

```text
$ bash /tmp/sift-scratch/ch23/alternate.sh
old index 3051.8 ms, 12 queries 993.43 ms
new index 2621.0 ms, 12 queries 524.15 ms
old index 3079.8 ms, 12 queries 1003.41 ms
new index 2665.6 ms, 12 queries 524.24 ms
old index 3135.7 ms, 12 queries 1012.51 ms
new index 2606.0 ms, 12 queries 525.08 ms
old index 3070.1 ms, 12 queries 1006.52 ms
new index 2554.2 ms, 12 queries 530.89 ms
old index 3061.9 ms, 12 queries 1005.66 ms
new index 2667.9 ms, 12 queries 530.62 ms
```

每轮之间的 `cpu_state.py` 读数都在 111 到 120 之间（开头叫醒用的那一次最大到 128）。中位数：

| | `ch22` | 当前树 | 倍数 |
| --- | --- | --- | --- |
| `sift index --full`（进程内的 `took`） | 3070.1 毫秒 | 2621.0 毫秒 | 1.17 |
| 12 个查询（`bench search` 打印的总和） | 1005.7 毫秒 | 525.1 毫秒 | 1.92 |
| `sift index --full` 整个进程（hyperfine，5 次均值） | 3.462 秒 | 3.003 秒 | 1.15 |
| `sift bench search` 整个进程（hyperfine，5 次均值） | 1.605 秒 | 1.135 秒 | 1.41 |

四个倍数各自回答不同的问题。`took` 只量建索引这一段；hyperfine 量整个进程，含启动和导入；12 个查询的总和排除了启动，所以它最能反映片段这条路径上的收益，1.92 倍。`sift bench search` 整个进程 1.41 倍比 1.92 倍小，差的那部分是解释器启动、导入和打开索引，它们没变（1.605 减 1.006 约 0.6 秒，1.135 减 0.525 约 0.6 秒，两边都剩下 0.6 秒左右，这个粗算支持“没变”的说法）。

`segment.sft` 在每一步都和 `ch22` 逐字节相同（`cmp` 无输出），测试套件在最终的树上是：

```text
$ python3 -m pytest -p no:cacheprovider -o addopts='--doctest-modules' | tail -1
================= 1076 passed, 1 xfailed, 1 warning in 50.47s ==================
```

那个 `xfailed` 和那条警告在 `ch22` 就有：第 22 篇结尾的整套测试是 `1057 passed, 1 xfailed, 1 warning`，警告是 `fastapi` 的 `starlette.testclient` 对 `httpx` 的弃用提示，与这一章无关。多出来的 19 个通过的测试是这一章新加的。

最后说没动的东西。BM25 的循环一行没改，因为它不是热点。第 22 篇留下的 `tfidf_matrix` 构建（约 152 毫秒）这一篇也没动：它在 `sift similar` 和 `sift report` 的路径上，不在 `index` 和 `search` 的路径上，而我这一章的基准只有这两条。优化之后，剖析表里剩下的第一名仍是 `iter_tokens`（索引）和 `iter_hit_spans`（片段），我没有再往下挖：`unicodedata.normalize` 对每篇非 ASCII 的命中文档的正文折叠了两次（`_origin` 一次，`iter_hit_spans` 一次），这是个明显的候选，放进了练习；再往下就得换算法或者换语言，那是下一篇的事。

## 自适应解释器：字节码在运行时被改写

到这里的优化都是“少做事”。接下来看另一半：解释器自己怎么让同样的事做得更快。Python 3.11 起，CPython 的字节码解释器是“自适应、可特化”的（PEP 659）：一条指令第一次出现时是通用形式，比如 `BINARY_OP`，它要在运行时看操作数的类型，再分派到整数加、浮点加或者字符串拼接。执行几次之后，解释器发现这条指令总是遇到同样的类型，就把它原地改写成特化形式，比如 `BINARY_OP_ADD_INT`，只检查“两边是不是整数”，是就直接加，不是就退回通用形式。

`dis.dis(f, adaptive=True)` 能看到解释器内存里当下的指令，而不是编译器最初生成的那份。`lab/ch23/specialization.py` 对一个小函数做热身前后各反汇编一次：

```python
def sum_to(n: int) -> int:
    """Add the integers below n in a loop."""
    total = 0
    for i in range(n):
        total = total + i
    return total
```

```text
$ python3 lab/ch23/specialization.py | sed -n '1,/^opcodes that appeared/p'
--- sum_to before any call
 23           RESUME                   0

 25           LOAD_SMALL_INT           0
              STORE_FAST               1 (total)

 26           LOAD_GLOBAL              1 (range + NULL)
              LOAD_FAST_BORROW         0 (n)
              CALL                     1
              GET_ITER
      L1:     FOR_ITER                11 (to L2)
              STORE_FAST               2 (i)

 27           LOAD_FAST_BORROW_LOAD_FAST_BORROW 18 (total, i)
              BINARY_OP                0 (+)
              STORE_FAST               1 (total)
              JUMP_BACKWARD           13 (to L1)

 26   L2:     END_FOR
              POP_ITER

 28           LOAD_FAST_BORROW         1 (total)
              RETURN_VALUE
--- sum_to after 2000 calls with ints
 23           RESUME_CHECK             0

 25           LOAD_SMALL_INT           0
              STORE_FAST               1 (total)

 26           LOAD_GLOBAL_BUILTIN      1 (range + NULL)
              LOAD_FAST_BORROW         0 (n)
              CALL_BUILTIN_CLASS       1
              GET_ITER
      L1:     FOR_ITER_RANGE          11 (to L2)
              STORE_FAST               2 (i)

 27           LOAD_FAST_BORROW_LOAD_FAST_BORROW 18 (total, i)
              BINARY_OP_ADD_INT        0 (+)
              STORE_FAST               1 (total)
              JUMP_BACKWARD_NO_JIT    13 (to L1)

 26   L2:     END_FOR
              POP_ITER

 28           LOAD_FAST_BORROW         1 (total)
              RETURN_VALUE
opcodes that appeared: BINARY_OP_ADD_INT, CALL_BUILTIN_CLASS, FOR_ITER_RANGE, JUMP_BACKWARD_NO_JIT, LOAD_GLOBAL_BUILTIN, RESUME_CHECK
```

对比两份，每一条变化各自的意思（`RESUME_CHECK` 和 `LOAD_GLOBAL_BUILTIN` 我对照了 `Python/bytecodes.c` 里的定义，其余几条按指令名和它们对应的类型理解）：

- `RESUME` 变成 `RESUME_CHECK`：`bytecodes.c` 第 230 到 243 行，它只把线程的 `eval_breaker` 和代码对象的插桩版本号比较一下，相等就继续，不等就退回通用路径。
- `LOAD_GLOBAL` 变成 `LOAD_GLOBAL_BUILTIN`：`range` 在内建命名空间里，这条指令先检查全局字典的键版本（`_GUARD_GLOBALS_VERSION`，第 1789 到 1795 行），再检查内建字典的键版本，版本对得上就按缓存的下标直接取值（`_LOAD_GLOBAL_BUILTINS`，第 1817 到 1834 行），不做字典查找。
- `CALL` 变成 `CALL_BUILTIN_CLASS`：被调的是 `range` 这个内建类，调用的分派不用再走通用路径。
- `FOR_ITER` 变成 `FOR_ITER_RANGE`：迭代器是 `range` 的迭代器，直接推进计数器，不经过 `__next__` 的通用协议。
- `BINARY_OP` 变成 `BINARY_OP_ADD_INT`：两个操作数都是 `int`，直接加。
- `JUMP_BACKWARD` 变成 `JUMP_BACKWARD_NO_JIT`：后面讲 JIT 时会再看到它。

`LOAD_FAST_BORROW`、`LOAD_SMALL_INT` 这些是 3.14 的编译器本来就生成的指令，不属于运行时特化（热身前后都在）。

特化的触发条件我想验证，而不是照抄。同一个函数 `add(a, b)`，`a + b` 在函数里只出现一次：

```python
def add(a, b):
    return a + b
```

```text
$ python3 /tmp/sift-scratch/ch23/warmup_counts.py
before any call              BINARY_OP
1 call with ints             BINARY_OP
2nd call with ints           BINARY_OP_ADD_INT
float calls until it changed 53: BINARY_OP_ADD_FLOAT
```

第一次调用之后还是通用的 `BINARY_OP`，第二次调用之后就已经是 `BINARY_OP_ADD_INT` 了：指令第二次被执行时特化。再换成浮点：第一次浮点调用之后它仍然是 `BINARY_OP_ADD_INT`（守卫失败，走通用路径，指令没换），直到第 53 次浮点调用才变成 `BINARY_OP_ADD_FLOAT`。`lab` 脚本里的 `add` 一节也能看到同一件事，热身 2000 次整数、2000 次浮点、2000 次字符串之后，指令依次是：

```text
add after 2000 calls with ints: ['RESUME_CHECK', 'LOAD_FAST_BORROW_LOAD_FAST_BORROW', 'BINARY_OP_ADD_INT', 'RETURN_VALUE']
add after 2000 calls with floats: ['RESUME_CHECK', 'LOAD_FAST_BORROW_LOAD_FAST_BORROW', 'BINARY_OP_ADD_FLOAT', 'RETURN_VALUE']
add after 2000 calls with str: ['RESUME_CHECK', 'LOAD_FAST_BORROW_LOAD_FAST_BORROW', 'BINARY_OP_ADD_UNICODE', 'RETURN_VALUE']
```

这两个数字，2 和 53，在 CPython 3.14.7 的源码里都能找到。`Include/internal/pycore_code.h` 第 444 到 449 行：`ADAPTIVE_WARMUP_VALUE` 是 1，注释写着“1 表示在每条指令第二次执行时尝试特化”；第 451 到 458 行：`ADAPTIVE_COOLDOWN_VALUE` 是 52，注释写着“52 表示在 53 次未命中之后尝试重新特化（质数，避免每第 n 次类型都不同时出现的假象）”。特化本身在 `Python/specialize.c`：`_Py_Specialize_BinaryOp` 从第 2578 行开始，`NB_ADD` 的分支在第 2592 到 2615 行，先要求两个操作数类型相同（`Py_IS_TYPE(lhs, Py_TYPE(rhs))`），再按 `PyUnicode_CheckExact`、`PyLong_CheckExact`、`PyFloat_CheckExact` 选出特化后的指令；`specialize()`（第 739 到 750 行）改写操作码，同时把计数器设成冷却值；失败的情形走 `unspecialize()`（第 753 到 766 行）。指令的执行体在 `Python/bytecodes.c` 第 5052 到 5079 行：`_SPECIALIZE_BINARY_OP` 在计数器到点时调用 `_Py_Specialize_BinaryOp`，否则把计数器往前推一格，然后才是通用的 `_BINARY_OP`。

这对写代码意味着什么？一，同一行代码里的类型最好稳定：函数里一个 `a + b`，一会儿加整数一会儿加字符串，特化的指令不断失败、重新特化。二，这些机制对你是透明的，源码不需要任何注释或标注，你写的是普通的 Python。三，收益有多大？我用最粗的办法量了一下：三个列表各 100 万个元素，一个全是整数，一个全是浮点，一个是整数和浮点交替，循环里只做 `a + b`：

```text
$ python3 /tmp/sift-scratch/ch23/type_stable.py
all int         31.1 ns per add
all float       30.5 ns per add
int and float   33.1 ns per add
```

交替类型比单一类型慢 6.5%，前后读数 `116 115 115 115 115` 和 `116 115 114 114 114`。差别不大，因为这个循环的大部分时间花在 `zip`、解包和取列表元素上，加法本身只是一小块。我没有找到一个能把“类型不稳”放大到几倍的真实例子，也不打算为了写文章造一个；这个数字的意思是，在 Sift 这样的代码里，类型稳不稳不是我该优先担心的事。

局部变量与全局变量、属性查找也是同一类话题。`lab/ch23/local_vs_global.py` 对 20 万个数求平方根，用四种写法：`math.sqrt` 通过模块属性、`sqrt` 是模块的全局名、把 `math.sqrt` 绑定到局部、把它做成默认参数。结果和循环里的加载指令：

```text
$ python3 lab/ch23/local_vs_global.py
attribute_in_loop    11.44 ms   1.07x of local
global_in_loop       10.88 ms   1.02x of local
local_in_loop        10.71 ms   1.00x of local
default_in_loop      10.68 ms   1.00x of local
attribute_in_loop loop loads: LOAD_FAST_BORROW, LOAD_GLOBAL_MODULE, LOAD_ATTR_MODULE, LOAD_FAST_BORROW
global_in_loop loop loads: LOAD_FAST_BORROW, LOAD_GLOBAL_MODULE, LOAD_FAST_BORROW
local_in_loop loop loads: LOAD_FAST_BORROW_LOAD_FAST_BORROW, LOAD_FAST_BORROW
```

前后读数 `113 113 113 113 113` 和 `112 113 113 112 113`。`LOAD_GLOBAL_MODULE` 和 `LOAD_ATTR_MODULE` 都是特化形式，靠键版本号缓存，所以全局名只比局部名慢 2%，通过模块属性取 `math.sqrt` 慢 7%。在 3.14 上这点差别不值得改写可读性，只有剖析表指明这是一个千万次的内层循环时才值得。

### 3.14 的尾调用解释器和 JIT：这台机器上都没有

3.14 的 What's New 里有两个与速度有关的条目。一个是新的解释器类型，用小的 C 函数之间的尾调用实现每个操作码，而不是一个巨大的 `switch`；`Doc/whatsnew/3.14.rst` 第 438 到 459 行写着：它目前只在 Clang 19 及以上、x86-64 和 AArch64 上可用，在 `pyperformance` 上的几何平均提升估计是 3% 到 5%（基线是同一个 Clang 19 编译、没有这个解释器的 3.14），并且是可选的，需要 `--with-tail-call-interp` 配置。另一个是实验性的 JIT（第 3238 到 3256 行）：官方 macOS 和 Windows 的二进制带它，用环境变量 `PYTHON_JIT=1` 打开，源码构建用 `--enable-experimental-jit`，典型影响“从慢 10% 到快 20%，取决于负载”。

我这个解释器是 nixpkgs 的 3.14.7，用 GCC 15.3.0 编译。`lab/ch23/jit_check.py` 查它到底有没有：

```text
$ python3 lab/ch23/jit_check.py
3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
sys._jit.is_available(): False
sys._jit.is_enabled():   False
JIT unavailable: this build has no experimental JIT
tail-call interpreter option: False
lto option: ['--with-lto']
GIL enabled: True
```

JIT 不可用，构建选项里没有尾调用解释器，只有 `--with-lto`（链接时优化）；用的是 GCC，而尾调用解释器目前要求 Clang。`JUMP_BACKWARD_NO_JIT` 这个指令名也是这个意思：`Python/bytecodes.c` 第 2888 到 2896 行，`_SPECIALIZE_JUMP_BACKWARD` 按 `tstate->interp->jit` 是否为真，把 `JUMP_BACKWARD` 改写成 `JUMP_BACKWARD_JIT` 或者 `JUMP_BACKWARD_NO_JIT`；我这里是后者。

所以这一篇关于“JIT 能提速多少”我没有任何数字，也不打算引用别人的数字当成我的。官方文档给的范围是“慢 10% 到快 20%”，要在自己的负载上知道，得拿一个带 `--enable-experimental-jit` 的构建，用 `PYTHON_JIT=1` 对比。我没有这样的构建。`sys._is_gil_enabled()` 在这个解释器上是 `True`（`nix develop` 的提示行里还列了一个自由线程的 Python，我没有用它）。

## 常用的优化手法，各量一遍

“常用手法”最容易变成迷信，所以我把五条各量一遍，数据用的是 123 篇文章的全文（2,984,580 个字符，其中含 emoji，最大码点是 `0x1f980`）。脚本是 `/tmp/sift-scratch/ch23/common_opts.py`，用 `timeit.repeat` 取最小，前后读数 `112 113 114 114 115` 和 `113 114 114 114 114`：

```text
$ python3 /tmp/sift-scratch/ch23/common_opts.py
corpus text: 2984580 characters
1. remove 21 punctuation characters
   replace x 21      42.22 ms
   re.sub            43.66 ms
   str.translate     64.56 ms
2. 200000 matches, 67917 hits
   re.match(str)     77.99 ms
   compiled.match    26.59 ms
3. upper() of 75980 strings
   for + append       5.11 ms
   comprehension      4.70 ms
   list(map(...))     4.43 ms
4. 300000 lookups in a 200-word stop list
   list             480.09 ms
   frozenset          6.60 ms
```

### 算法先于一切：list 换 frozenset

第 4 条是整张表里最大的：在一个 200 个词的停用词表里查 30 万次，列表要 480.09 毫秒，`frozenset` 6.60 毫秒，73 倍。差别不是 Python 的细节，是 O(n) 对 O(1)。同样大小的修改，其他几条都比不上：先看数据结构和算法对不对，再去抠指令。Sift 里的停用词过滤用的是集合，所以这一章不用改它。前面的改动也都是这一类：`_origin` 从“每个字符”变成“每个不同的字符”，`PostingList` 从“每个词元”变成“每个新词”，都是把工作量的量级降下来。

### 预编译正则

第 2 条：同一个模式匹配 20 万个词，`re.match("[a-z]+", w)` 要 77.99 毫秒，`compiled.match(w)` 26.59 毫秒，2.9 倍。`re.match` 每次都要在 `re` 模块的缓存里按（模式字符串，标志）查一次编译好的对象，有开销；预编译一次，循环里直接调方法。Sift 的分词器 `_TOKEN` 是模块级的 `re.compile`，正是这么做的。

### str.translate：看字符串的种类

第 1 条出乎我的意料：`str.translate` 比 21 次 `replace` 还慢。“删字符用 translate”是流传很广的说法，我追了一下是怎么回事。把语料里只剩 ASCII 字符的部分单独拿出来，再和整个语料比：

```text
$ python3 /tmp/sift-scratch/ch23/translate_kinds.py
ASCII only: 2359035 characters, max ord 0x7e
  replace x 21    12.77 ms
  re.sub          38.84 ms
  str.translate    3.18 ms
whole corpus: 2984580 characters, max ord 0x1f980
  replace x 21    41.85 ms
  re.sub          45.07 ms
  str.translate   64.31 ms
```

前后读数 `111 112 113 112 112` 和 `114 115 115 115 114`。在纯 ASCII 文本上，`translate` 是 3.18 毫秒，比 21 次 `replace` 快 4.0 倍，比 `re.sub` 快 12 倍；换到含 emoji 的整个语料（每个字符 4 字节存储），`translate` 变成 64.31 毫秒，比 `replace` 慢 1.5 倍。我没有去读 CPython 里 `str.translate` 的实现来确认原因，我猜是它对 ASCII 字符串有一条专用的快路径，对其他的就按字符走通用的映射查找；`replace` 在每次替换里用的是内存扫描，字符宽度对它的影响没那么大。不管原因，教训不变：“translate 更快”是一个有前提的说法，前提是字符串种类，前提不成立的时候要量。

### 推导式、循环与 map

第 3 条：7.6 万个字符串各做一次 `upper()`，`for` 加 `append` 5.11 毫秒，列表推导 4.70 毫秒，`list(map(str.upper, ...))` 4.43 毫秒。推导式比显式循环快 8%，`map` 再快 6%。这是真的，但差别在 10% 的量级，值得在热循环里用，不值得为它改写别处。推导式的主要好处其实是可读：它说的是“我要一个新列表”，不是“我要一个空列表然后往里加”。

### `__slots__`

`__slots__` 省的是内存，不是时间。`micro_token.py` 量 10 万个对象的存活内存，每个对象带 3 个互不相同的整数：

```text
live memory per object, 100000 objects with 3 distinct ints:
  NamedTuple             191.8 bytes
  plain class            207.8 bytes
  class with __slots__   167.7 bytes
```

普通类每个对象 207.8 字节，`__slots__` 167.7 字节，省 19%；`NamedTuple` 191.8 字节（它本来就没有 `__dict__`）。这 40 字节差别，换成一个有 10 万个小对象的程序，是 4 MB；对 Sift 的索引，它的 83.9 MiB 里 `Token` 并不存活（`tracemalloc` 的表里存活的是位置整数和 `Posting`），所以改 `__slots__` 对它没有用。值得用的场景是“几十万个同种小对象长期存活”。

### 小结

五条里，真正能改变量级的只有一条（算法）。其余的在 8% 到 3 倍之间，而且 `translate` 那一条在我手上方向是反的。这和前面的局部名一节是同一个结论：没量过的“常识”，要么差别很小，要么有前提，不能直接搬。

## sys.monitoring：不开剖析器也能数调用

PEP 669 的 `sys.monitoring` 是 3.12 加的一套低开销的事件接口：工具向解释器登记自己关心的事件（`PY_START` 函数开始、`PY_RETURN`、`LINE` 每行、`CALL`、`BRANCH` 等），解释器只为被订阅的事件付钱。它同时是 `cProfile`（前面已经看过）、覆盖率工具和调试器的底层。前面我用它的 `LINE` 事件做过逐行计数器；`lab/ch23/sys_monitoring.py` 用 `PY_START` 数一次分词管线调用了哪些 Python 函数，再量三种开销。核心部分：

```python
def main() -> None:
    # ... docs, pipeline, text and analyze() are set up here ...
    counts: Counter[str] = Counter()

    def on_start(code: CodeType, offset: int) -> None:
        counts[code.co_qualname] += 1

    monitoring = sys.monitoring
    monitoring.use_tool_id(TOOL, "sift-count")
    monitoring.register_callback(TOOL, monitoring.events.PY_START, on_start)
    monitoring.set_events(TOOL, monitoring.events.PY_START)
    terms = analyze()
    monitoring.set_events(TOOL, 0)
```

每个工具要先 `use_tool_id` 占一个编号（0 到 5，其中 `PROFILER_ID` 是 2；前面 `cProfile` 占的就是它），再登记回调，再 `set_events`。我在 `ch22` 的副本和当前树上各跑一遍，对象是一篇测试文章（125 个词）：

```text
$ PYTHONPATH=/tmp/sift-scratch/ch23/old/src python3 lab/ch23/sys_monitoring.py
125 terms; Python functions started, by name:
   126  fold
   125  <lambda>
     1  MixedTokenizer.analyze
     1  NfkcCasefold.__call__
     1  Pipeline.analyze
     1  Pipeline.terms
     1  StopwordFilter.__call__
     1  iter_tokens
     1  main.<locals>.analyze
no tool:          132.0 us per run
sys.monitoring    192.8 us per run (1.46x)
cProfile          330.8 us per run (2.51x)
$ python3 lab/ch23/sys_monitoring.py
125 terms; Python functions started, by name:
    93  fold
     1  MixedTokenizer.analyze
     1  NfkcCasefold.__call__
     1  Pipeline.analyze
     1  Pipeline.terms
     1  StopwordFilter.__call__
     1  iter_tokens
     1  main.<locals>.analyze
no tool:          111.1 us per run
sys.monitoring    134.7 us per run (1.21x)
cProfile          267.0 us per run (2.40x)
```

前后读数 `110 115 114 113 113` 和 `117 112 112 119 111`。几件事：

- 这是前面两处改动的直接证据。`ch22` 里 `<lambda>` 被启动了 125 次，就是 `NamedTuple` 生成的 `__new__`，每个词元一次；当前树里它整个消失了。`fold` 从 126 次降到 93 次：`ch22` 里每个词元都经过一次 `fold`（再加 `iter_tokens` 开头整篇折叠的那一次），现在只有 92 个词元走到 `fold`，从数字上看应该是含中文的那些。
- 开销：`ch22` 上 `sys.monitoring` 订阅 `PY_START` 是 1.46 倍，`cProfile` 是 2.51 倍；当前树上是 1.21 倍和 2.40 倍。`cProfile` 要钩进入和返回、还要记时间，订阅的事件比 `PY_START` 多，这个比较不是同类对同类，但它说明了 PEP 669 的设计目标：订阅什么付什么。
- 它不是 `line_profiler` 的替代品，也不是火焰图，但它是一块砖：想知道“这个函数到底被调了几次”，十几行代码就够，不用装任何东西。
- 工具编号是共享的。`cProfile` 占着 `PROFILER_ID`，所以脚本里先 `free_tool_id` 释放，再开 `cProfile` 量它的开销；同时开两个会得到前面看到的 `ValueError: tool 2 is already in use`。

## 什么时候不该优化

写到这里该说句泄气的话。这一章的六处改动，总共让 `sift index --full` 快了 1.17 倍，12 个查询快了 1.92 倍。对一个只有 123 篇文章的搜索引擎，12 个查询从 1006 毫秒到 525 毫秒，用户几乎感觉不到；每个查询平均从 84 毫秒到 44 毫秒。我做这个是因为教程需要，不是因为产品需要。真实的项目里，该问的是：

- 有没有用户抱怨？有没有一个具体的预算（响应时间、内存、成本）被超了？没有的话，这些改动的代价（两份分词规则要同步、`_origin` 的边界情形更难读）就是净亏损。
- 改动后的代码更难读，值不值？`iter_hit_spans` 把 `iter_tokens` 的规则复制了一份，我用一个属性测试守着它们一致，但这个维护成本是长期的。
- 你量过了吗？这一章的开头我就猜错了一次。

最便宜的优化是不做；其次是改算法；再其次是减少工作量；改解释器层面的细节排在最后。还有一点：优化的结果要有人守着。这一章留下的 `tests/test_search_stable.py`，是为了以后别人（或者我自己）再动分词和打分时，能立刻知道是不是把结果碰坏了。

## 留下的缺口

- `extra.sh` 里调 `kernprof -l -v` 的那一支，在这个环境里没有跑过：`line-profiler` 不在 `flake.nix` 里，脚本检测到没有就打印一行跳过。我用 `sys.monitoring` 做的逐行计数器顶替了它，但它只数次数，时间只能当参考。
- JIT 和尾调用解释器：这个解释器两者都没有，我没有任何它们的实测数字。
- 单步收益的噪声：NFKC 那一步在我的测量里看不出收益，3 轮的范围是 2925.0 到 2989.0 毫秒，而上一步是 2906.9 到 3003.1，完全重叠。提交说明里的 3.434 秒到 3.298 秒我没能复现。
- 火焰图：生成了，`py-spy` 的 SVG 是对的，但没法作为图片放进文章，只能用浏览器打开看；我用图里的 `<title>` 和 `--format raw` 的汇总代替了它。
- `iter_hit_spans` 和 `_origin` 各自对命中文档的正文调一次 `fold`，`unicodedata.normalize` 因此成了搜索剖析表里的第二名（0.148 秒）。我没有把它们合并，这是一个明确的候选，放进了练习。
- 所有计时都在同一台机器的快状态下量的。慢状态下 `cpu_state.py` 的读数是 160 多毫秒对快状态的 113 毫秒，约 1.5 倍；第 11 篇量到过 2.5 倍。慢状态下各项比例是否保持，我没有逐一验证。

## 本篇文件

这一章动了 21 个文件，`git diff --shortstat ch22 ch23` 给出 `21 files changed, 903 insertions(+), 48 deletions(-)`。表里的 `+N -M` 来自 `git diff --numstat ch22 ch23`，命令是跑它对应的测试或脚本，结果是我在标签 `ch23` 上最后一次实际跑出来的（退出码都是 0；计时类的脚本，表里挑的是不带计时的那一行）；`/tmp/sift-scratch/ch23/` 里的草稿脚本不进仓库，不在表里。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`README.md`](https://github.com/bfmhno3/sift/blob/ch23/README.md) | `grep -c "test_search_stable" README.md` | `1`；`+7 -0` |
| [`cprofile_index.py`](https://github.com/bfmhno3/sift/blob/ch23/lab/ch23/cprofile_index.py) | `python3 lab/ch23/cprofile_index.py \| sed -n 1p` | `indexed 123 documents, 81167 terms`；`+46 -0` |
| [`extra.sh`](https://github.com/bfmhno3/sift/blob/ch23/lab/ch23/extra.sh) | `bash lab/ch23/extra.sh`，然后 `tail -n 1 out/ch23/before_after.txt` | `byte-identical`；整个脚本约 74 秒；`+167 -0` |
| [`jit_check.py`](https://github.com/bfmhno3/sift/blob/ch23/lab/ch23/jit_check.py) | `python3 lab/ch23/jit_check.py \| sed -n 2p` | `sys._jit.is_available(): False`；`+33 -0` |
| [`local_vs_global.py`](https://github.com/bfmhno3/sift/blob/ch23/lab/ch23/local_vs_global.py) | `python3 lab/ch23/local_vs_global.py \| tail -1` | `local_in_loop loop loads: LOAD_FAST_BORROW_LOAD_FAST_BORROW, LOAD_FAST_BORROW`；`+91 -0` |
| [`specialization.py`](https://github.com/bfmhno3/sift/blob/ch23/lab/ch23/specialization.py) | `python3 lab/ch23/specialization.py \| tail -1` | `add after 2000 calls with str: [..., 'BINARY_OP_ADD_UNICODE', ...]`；`+67 -0` |
| [`sys_monitoring.py`](https://github.com/bfmhno3/sift/blob/ch23/lab/ch23/sys_monitoring.py) | `python3 lab/ch23/sys_monitoring.py \| sed -n 1p` | `125 terms; Python functions started, by name:`；`+72 -0` |
| [`timeit_rules.py`](https://github.com/bfmhno3/sift/blob/ch23/lab/ch23/timeit_rules.py) | `python3 lab/ch23/timeit_rules.py \| sed -n 1p` | `text: 120749 characters, 26228 tokens`；`+76 -0` |
| [`tracemalloc_top.py`](https://github.com/bfmhno3/sift/blob/ch23/lab/ch23/tracemalloc_top.py) | `python3 lab/ch23/tracemalloc_top.py 2>/dev/null \| sed -n 1p` | `81167 terms`；`+44 -0` |
| [`filters.py`](https://github.com/bfmhno3/sift/blob/ch23/src/sift/analysis/filters.py) | `python3 -m pytest tests/test_analysis.py src/sift/analysis/filters.py` | `31 passed in 0.61s`；`+9 -4` |
| [`tokenize.py`](https://github.com/bfmhno3/sift/blob/ch23/src/sift/analysis/tokenize.py) | `python3 -m pytest tests/test_properties.py src/sift/analysis/tokenize.py` | `15 passed in 3.97s`；`+42 -11` |
| [`cli.py`](https://github.com/bfmhno3/sift/blob/ch23/src/sift/cli.py) | `python3 -m pytest tests/test_cli.py -k bench_search` | `4 passed, 156 deselected in 1.24s`；`+27 -3` |
| [`index.py`](https://github.com/bfmhno3/sift/blob/ch23/src/sift/index.py) | `python3 -m pytest tests/test_index.py src/sift/index.py` | `34 passed in 0.68s`；`+29 -7` |
| [`snippet.py`](https://github.com/bfmhno3/sift/blob/ch23/src/sift/snippet.py) | `python3 -m pytest tests/test_snippet.py src/sift/snippet.py` | `28 passed in 0.86s`；`+6 -10` |
| [`segment.py`](https://github.com/bfmhno3/sift/blob/ch23/src/sift/storage/segment.py) | `python3 -m pytest tests/test_segment.py` | `25 passed in 2.20s`；`+15 -5` |
| [`varint.py`](https://github.com/bfmhno3/sift/blob/ch23/src/sift/storage/varint.py) | `python3 -m pytest tests/test_varint.py src/sift/storage/varint.py` | `17 passed in 1.14s`；`+20 -6` |
| [`test_cli.py`](https://github.com/bfmhno3/sift/blob/ch23/tests/test_cli.py) | `python3 -m pytest tests/test_cli.py -k bench_search_profile` | `1 passed, 159 deselected in 1.05s`；`+27 -0` |
| [`test_properties.py`](https://github.com/bfmhno3/sift/blob/ch23/tests/test_properties.py) | `python3 -m pytest tests/test_properties.py -k hit_spans` | `1 passed, 13 deselected in 1.00s`；`+13 -1` |
| [`test_search_stable.py`](https://github.com/bfmhno3/sift/blob/ch23/tests/test_search_stable.py) | `python3 -m pytest tests/test_search_stable.py` | `13 passed in 3.07s`；`+67 -0` |
| [`test_snippet.py`](https://github.com/bfmhno3/sift/blob/ch23/tests/test_snippet.py) | `python3 -m pytest tests/test_snippet.py -k origin` | `1 passed, 22 deselected in 0.84s`；`+23 -0` |
| [`test_varint.py`](https://github.com/bfmhno3/sift/blob/ch23/tests/test_varint.py) | `python3 -m pytest tests/test_varint.py -k append_deltas` | `1 passed, 15 deselected in 0.89s`；`+22 -1` |

测试命令都带着 `-p no:cacheprovider -o addopts=--doctest-modules`（`pyproject.toml` 里默认的 `-q` 会吞掉汇总行，我要看到数字）。整个测试套件是 `1076 passed, 1 xfailed, 1 warning in 50.47s`；`ruff format --line-length 79 --check lab/ch23 src tests` 说 `108 files already formatted`，`ruff check lab/ch23` 说 `All checks passed!`。

## 练习

**1.** 合并两次整篇折叠。`_origin` 和 `iter_hit_spans` 各自对命中文档的正文调一次 `fold`，`unicodedata.normalize` 因此是搜索剖析表里的第二名（0.148 秒）。设计一个让折叠只做一次的写法，注意 `_origin` 文档字符串里的警告：折叠两次不是幂等的，`ss` 加一个组合重音符，第二次折叠会再合成。先预测 `normalize` 的时间会降到多少，再动手；然后用 `test_search_stable.py`、`test_origin_matches_the_per_character_fold` 和 `cmp` 验证，最后用 `sift bench search` 的总和交替测量。

**2.** 把 `line-profiler` 加进开发环境（`flake.nix`），跑 `extra.sh` 里 `kernprof` 的那一支。先写下预测：`iter_tokens` 里哪一行的占比最高？把它和我用 `sys.monitoring` 的 `LINE` 事件得到的占比（`yield` 那两行 11.6% 和 15.1%）比较。如果两者排名不一样，想想为什么：我的回调开销是每行一样的，`line_profiler` 的呢？

**3.** 找一个带 `--enable-experimental-jit` 的 Python 3.14 构建（自己编译，或者官方 macOS 与 Windows 的二进制），用 `PYTHON_JIT=1` 和不开的两种方式，各交替跑 5 次 `sift index --full` 和 `sift bench search`。先写下预测：快还是慢？快多少？官方文档给的是“慢 10% 到快 20%”，你的结果落在范围的哪一端？用 `lab/ch23/jit_check.py` 先确认 `is_enabled()` 真的是 `True`。

**4.** 我的四个“故意引入的错误”里，名次钉子只抓住了第一个。给 `test_search_stable.py` 再加一层：把每条查询的分数四舍五入到 6 位小数一起钉住，或者钉住总命中数。预测这样能多抓住哪几个；再自己想一个“名次不变、结果却错了”的错误，让钉子漏过去，然后补上能抓住它的测试。

**5.** NFKC 那一步（改动 2）在我的交替测量里看不出端到端收益，但 `sys.monitoring` 显示 `fold` 的调用少了 33 次。设计一个只测过滤器的 `timeit`（把词元列表先造好，计时只含过滤器），量出它自己的收益；再算一下：它占整个 `index --full` 的几分之几，所以端到端应该是多少？这个数字能不能解释“看不出来”？

## 下一篇

下一篇是《原生扩展（上）：C、ctypes、cffi、Cython 与 C API》。这一篇优化完之后，剖析表剩下的前几名，`iter_tokens`、`varint.encode`、`unicodedata.normalize`，都是对字符或字节的紧凑循环，这类循环我在纯 Python 里已经没有明显的冗余可以再删。下一篇我想量一量：把其中一个最小的循环换成 C，要付出什么（构建、内存安全、调用开销），换回多少时间，再对比 `ctypes`、`cffi`、Cython 和直接用 C API 这几条路各自的成本。
