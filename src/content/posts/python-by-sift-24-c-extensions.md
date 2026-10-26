---
title: "原生扩展（上）：C、ctypes、cffi、Cython 与 C API"
commentId: "post:python-by-sift-24-c-extensions"
published: "2026-10-27 05:00:00 +08:00"
description: "用 Sift 重学 Python 第 24 篇：我在 Python 3.14.7、gcc 15.3.0、Cython 3.2.5 和 cffi 2.1.0 上，把 Sift 分词的扫描循环用 C 重写一遍，再分别用 ctypes、cffi、Cython 和手写的 C API 模块接回 Python。我本以为 C 会快一个数量级，结果在 4.6 MB 的语料上（859485 个词元，3 轮交替测量取中位数），纯 Python 664.2 毫秒，ctypes 727.6 毫秒（0.91 倍），cffi 688.0 毫秒（0.97 倍），只有 Cython 到了 342.0 毫秒（1.94 倍）：C 函数本身只要 15.3 毫秒，时间都花在为 859485 个词元造 Python 对象上。数 CJK 字符这种几乎不造对象的活，C API 模块 1.0 毫秒，比 Python 的 38.2 毫秒快约 38 倍。一次调用的固定开销从 34 纳秒（空函数）到 702 纳秒（ctypes），决定了多短的字符串不值得过边界。中途我还让 ctypes 段错误一次，看 faulthandler 怎么说，用 hypothesis 重现了一类偏移映射的 bug，并确认四种实现建出的 segment.sft 逐字节相同。"
category: Tutorial
tags:
  - C 语言
  - ctypes
  - Cython
  - C 扩展
series: "用 Sift 重学 Python"
seriesOrder: 24
draft: false
comment: true
slug: python-by-sift-24-c-extensions
---

上一篇优化完，剖析表里剩下的前几名都是对字符的紧凑循环，`iter_tokens` 是其中之一：它在 4.6 MB 的语料上逐字符扫描，产出 859485 个词元。我的直觉很朴素：这种循环是 C 的本行，把它换成 C，应该快一个数量级。于是我用 C 写了一遍，再分别用 ctypes、cffi、Cython 和一个手写的 C API 模块接回 Python，然后量。结果是 ctypes 和 cffi 的版本都比纯 Python 慢，只有 Cython 赢了，1.94 倍。C 函数本身只花 15 毫秒，剩下的时间花在把它的结果变回 859485 个 Python 对象上。这一篇讲那个 C 函数怎么写、四条路各自怎么接、每条路上会摔在哪里，以及为什么“把热点换成 C”这句话需要加一个前提：每次过边界要带多少活过去。

```text
$ python3 /tmp/sift-scratch/cpu_state.py
115 116 118 119 118 ms
$ python3 lab/ch24/tokenizer_bench.py | sed -n '1,11p'
source: corpus/posts
corpus: 123 files, 4614185 bytes, 7 runs, median

== tokenize the corpus (fold included)
                     ms    ratio  result
python            664.2    1.00x  859485
ctypes            727.6    0.91x  859485
cffi              688.0    0.97x  859485
cython            345.5    1.92x  859485

fold alone (Python, in every row): 99.2 ms
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch24`（提交 `f3ce50e`）。改动共 29 个文件，`git diff --shortstat ch23 ch24` 给出 `29 files changed, 1886 insertions(+), 9 deletions(-)`。新增的有 C 代码 `c/sift_tok.h`、`c/sift_tok.c`、`c/sift_capi.c` 和 `c/Makefile`，Python 一侧的 `src/sift/ext/` 包（`ctok.py` 用 ctypes，`cffitok.py` 用 cffi，`_cytok.pyx` 是 Cython，另有两个类型存根），`tests/test_ext.py`（127 个用例），以及 `lab/ch24/` 下的 7 个 Python 脚本、一个 C 模糊测试程序和 `extra.sh`。改写的有 `src/sift/cli.py` (`sift index --tokenizer python|c|cffi|cython`)、`src/sift/analysis/tokenizers.py`（三个新的分析器 `mixed-c`、`mixed-cffi`、`mixed-cython`）和顶层 `Makefile`（新目标 `make ext`，`make ci` 在测试之前先跑它）。整个测试套件是 `1209 passed, 1 xfailed`。
> 下一篇用 PyO3 写 Rust 扩展，把同一个问题再做一遍；这一篇留下的基准表是那一篇的对照。
> 涉及的 Python 与工具的特性：C ABI 与共享库、`ctypes`（`CDLL`、`Structure`、`argtypes` 与 `restype`、`byref`、`from_buffer`）、`cffi` 的 ABI 模式与 API 模式、Cython（`cdef`、类型化 memoryview、`cython -a` 注释报告）、CPython C API（`PyObject *`、`Py_INCREF` 与 `Py_DECREF`、multi-phase 模块初始化 (PEP 489)、`METH_O`、`Py_BEGIN_ALLOW_THREADS`）、缓冲区协议 (PEP 3118)、`faulthandler`、自由线程构建上的 `Py_mod_gil` (PEP 703)。
> 前置：[第 23 篇](/posts/python-by-sift-23-profiling-performance/)。分词与 NFKC（[第 2 篇](/posts/python-by-sift-02-text-and-unicode/)）、hypothesis（[第 10 篇](/posts/python-by-sift-10-testing/)）、段文件（[第 12 篇](/posts/python-by-sift-12-files-binary-format/)）、GIL 与进程池（[第 16 篇](/posts/python-by-sift-16-threads-processes-gil/)）这一篇都会碰到。行为一律不变：换了实现，建出来的索引必须逐字节相同。

## 环境

和前几篇同一台机器，仓库在标签 `ch24`，命令都在 `nix develop` 里、仓库根目录下跑。

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ gcc --version | head -1
gcc (GCC) 15.3.0
$ cython --version
Cython version 3.2.5
$ python3 -c "import importlib.metadata as m
> for n in ('cffi', 'Cython', 'hypothesis'): print(n, m.version(n))"
cffi 2.1.0
Cython 3.2.5
hypothesis 6.156.1
$ hyperfine --version
hyperfine 1.20.0
$ lscpu | sed -n '/Model name/p;/^CPU(s):/p'
CPU(s):                                  16
Model name:                              AMD Ryzen 7 PRO 6850U with Radeon Graphics
$ git describe --tags; git rev-parse --short HEAD
ch24
f3ce50e
```

C 一侧用 `gcc` 15.3.0，Python 的头文件来自开发环境里的 3.14.7。`make ext` 一次建出三个原生产物，这是它的真实输出（为了排版，我把长命令折了行，把 Python 头文件目录记成 `$INC`，把扩展模块的文件名后缀记成 `$SUF`）：

```text
$ make clean && make ext
make -C c
make[1]: Entering directory '/home/bfmhno3/Projects/sift/c'
mkdir -p build
gcc -O2 -fPIC -shared -Wall -Wextra -o build/libsifttok.so sift_tok.c
gcc -O2 -fPIC -shared -Wall -Wextra -I$INC -I$INC \
    -o ../src/sift/ext/_capi$SUF sift_capi.c
cython -3 ../src/sift/ext/_cytok.pyx
gcc -O2 -fPIC -shared -Wall -Wextra -I$INC -I$INC \
    -o ../src/sift/ext/_cytok$SUF ../src/sift/ext/_cytok.c
make[1]: Leaving directory '/home/bfmhno3/Projects/sift/c'
```

三条 `gcc` 命令的差别只有两处。`libsifttok.so` 是纯 C，不认识 Python，不要头文件；`_capi` 和 `_cytok` 是 Python 扩展模块，需要 `-I` 指向 Python 的头文件，文件名后缀 `cpython-314-x86_64-linux-gnu.so` 是解释器自己报出来的 (`sysconfig.get_config_var("EXT_SUFFIX")`)，导入系统靠它挑文件。`_cytok.c` 是 Cython 从 `.pyx` 生成的，不进版本库：`.gitignore` 里有 `*.so`、`/c/build/` 和 `/src/sift/ext/_cytok.c` 三行，三个产物和中间的 C 文件都在其中。

这台 CPU 有快慢两个状态，所以凡是计时，前后我都夹一次 `cpu_state.py`（第 12 篇贴过的固定忙循环，快状态下 5 个数在 110 到 120 毫秒）。下面贴出来的基准，紧挨着它们的读数都在这个范围内。引用 CPython 与 cffi 源码时，CPython 是标签 `v3.14.7`（提交 `823f032`）的源码树，cffi 是开发环境里装的 2.1.0；行号都是我在这两份源码里实际查过的。

另外，我的草稿脚本（把 ctypes 一行行拆开计时的、造对象下限的、不带类型的 Cython 对照等）放在 `/tmp/sift-scratch/ch24/`，不进仓库。文中凡是出现 `/tmp/sift-scratch` 路径的命令，都是这类脚本。

## 换掉的是什么

先把要换的东西钉清楚。`iter_tokens` 是这样的（第 23 篇改过的版本，`src/sift/analysis/tokenize.py` 第 45 行起，文档字符串省略）：

```python
def iter_tokens(text: str) -> Iterator[Token]:
    # ...
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

它做三件事：先 `fold`（NFKC 加 `casefold`，靠 `unicodedata`，纯 C 但要查 Unicode 数据库），再用一个正则把文本切成 Latin 串和 CJK 串，最后给每个串造一个或多个 `Token`。Latin 串（`[0-9a-z_]+`，后面可以跟 `+`、`++` 或 `#`，所以 `c++` 和 `c#` 是一个词）一个串一个词元；CJK 串长度为 1 时是一个单字词元，否则是相邻两字重叠的二元组。

我把边界划在 `fold` 之后：NFKC 和 `casefold` 留在 Python，C 只负责“扫描并切分”。理由有两个。一是 Unicode 规范化需要整张数据库，我不想在 C 里重写，也不想链接 ICU；二是这样 C 的输入输出都很干净，输入是已经折叠过的 UTF-8 字节，输出是一串 `[start, end)` 的字节区间。这个边界是后面所有讨论的前提，所以先记下它的代价：每个词元的文本、位置和偏移，最后仍得由 Python 一侧造出来，因为 C 造不了 `str`，更造不了 `Token`。

## C ABI 与共享库

“C 函数怎么被别的语言调用”这件事，有一个名字：ABI (application binary interface)。API 是源码层面的约定（函数名、参数类型），ABI 是二进制层面的约定：参数放在哪个寄存器或栈位置，返回值从哪取，结构体每个字段在内存里偏移多少，名字在符号表里叫什么。ctypes 和 cffi 的 ABI 模式本质上都是在运行时按这份约定“手写汇编调用”，它们读不到头文件，不知道你的函数长什么样，所以必须由你来告诉它们。

在这台机器 (x86-64 Linux) 上用的是 System V AMD64 ABI。我不想只靠记忆讲它，所以写了两个小函数，让编译器自己说：

```c
#include "sift_tok.h"

size_t span_len(const struct sift_span *s)
{
	return s->end - s->start;
}

int add_two(int a, size_t b)
{
	return a + (int)b;
}
```

```text
$ gcc -O2 -S -fno-asynchronous-unwind-tables -fcf-protection=none \
      -fzero-call-used-regs=skip -I$SIFT/c -o abi.s abi.c
$ sed -n "/^span_len:/,/ret/p;/^add_two:/,/ret/p" abi.s
span_len:
	movq	8(%rdi), %rax
	subq	(%rdi), %rax
	ret
add_two:
	leal	(%rdi,%rsi), %eax
	ret
```

除了 `-O2`，后面三个 `-f` 选项只是去掉加固代码和展开表，让输出里只剩函数本体。

读汇编：`span_len` 的唯一参数是个指针，它在 `%rdi` 里；`s->end` 在 `8(%rdi)`，`s->start` 在 `(%rdi)`，结果放进 `%rax` 返回。这就是 `struct sift_span` 的布局：两个 `size_t`，各 8 字节，偏移 0 和 8，共 16 字节，和上面 `ctypes.sizeof(Span)` 报的 16 一致（后面的 ctypes 一节会看到）。`add_two` 里第一个 `int` 参数在 `%edi`（`%rdi` 的低 32 位），第二个 `size_t` 在 `%rsi`，`int` 结果从 `%eax` 出去。整型和指针参数依次占用 `%rdi`、`%rsi`、`%rdx`、`%rcx`、`%r8`、`%r9`，这是 ABI 文档规定的，上面的汇编只验证了前两个；`sift_tokenize` 有 5 个参数，正好都在寄存器里。

有两件事 ABI 不管：C 不知道调用者传的指针指向多大的内存，也不知道你声明的参数类型对不对。调用约定只管“放在哪”，不管“该放什么”。把一个 `int` 当 `size_t` 传，位置没错，高 32 位里是什么就看运气。这是后面所有 ctypes 陷阱的根。

共享库 (shared library) 就是一个带符号表的 ELF 文件，运行时被映射进进程，符号按名字解析。`libsifttok.so` 的导出符号和依赖是这样的：

```text
$ readelf -d c/build/libsifttok.so | grep NEEDED
 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]
$ nm -D --defined-only c/build/libsifttok.so | grep " T "
0000000000001710 T sift_count_cjk
00000000000013a0 T sift_tokenize
```

`nm -D` 的 `T` 表示代码段里导出的全局符号，只有两个函数，是 `sift_tok.c` 里没有 `static` 的那两个；`utf8_decode`、`cjk_run` 这些 `static` 函数不在符号表里，Python 看不到，也不该看到。`NEEDED` 是 libc。

编译用 `gcc -O2 -fPIC -shared -Wall -Wextra`。`-shared` 让链接器产出共享库而不是可执行文件；`-fPIC` 要求生成位置无关代码，因为共享库被映射到哪个地址由加载器决定。我试过去掉 `-fPIC` 单独编这个文件，`gcc -O2 -shared` 照样成功了，我没有深究为什么（我猜是这个 gcc 默认就生成位置无关的代码），所以这里的 `-fPIC` 是习惯，不是我验证出来的必需。库文件加载时，ctypes 用的是 `dlopen`，我传的是绝对路径，不依赖 `LD_LIBRARY_PATH`。

## 用 C 写分词器

头文件先定契约（`c/sift_tok.h`，内核风格：`/* ... */` 注释、tab 缩进、`struct` 不 `typedef`、动作函数返回 0 或 `-errno`）：

```c
/* The half-open byte range [start, end) of one token in the input. */
struct sift_span {
	size_t start;
	size_t end;
};

/*
 * sift_tokenize - split UTF-8 text into token spans
 * @utf8:  the text; need not be NUL-terminated or valid UTF-8
 * @len:   the number of bytes at @utf8
 * @out:   room for @cap spans; may be NULL when @cap is 0
 * @cap:   the number of spans that fit in @out
 * @n_out: set to the number of spans the text has
 *
 * At most @cap spans are written, in input order. *@n_out is always
 * the full count, so a caller that gets -ENOSPC allocates *@n_out
 * spans and calls again. Bytes that are not valid UTF-8 are skipped
 * and never end up inside a token.
 *
 * Return 0 on success, -ENOSPC if @cap was too small, -EINVAL for a
 * NULL @n_out, a NULL @utf8 with @len > 0, or a NULL @out with @cap > 0.
 */
int sift_tokenize(const char *utf8, size_t len, struct sift_span *out,
		  size_t cap, size_t *n_out);
```

这个接口的形状是被 ctypes 和 cffi 倒逼出来的。C 里没法返回“可变长度数组”而不涉及内存所有权，所以让调用者给缓冲区（`out` 和 `cap`），函数把词元数写进 `*n_out`。关键的一条规则是 `*n_out` 永远是完整的词元数，哪怕 `cap` 不够：缓冲区不够时，函数写到 `cap` 个就停，但继续数，最后返回 `-ENOSPC` 并告诉你要多大。调用者据此分配 `*n_out` 个再调一次。这和 `snprintf` 是同一个思路：先问要多大，再给够大的地方，第一趟丈量，第二趟填。我选的第一次猜测是 `len(data) // 4 + 1` 个词元；这个猜测在整个语料的 123 个文件上一次都没有落空：

```text
$ python3 /tmp/sift-scratch/ch24/retries.py | grep files:
files: 123 needing a second call: 0
```

语料上 `-ENOSPC` 的重试路径一次都没有被走到；这条路径靠测试覆盖，后面讲。

实现里最值得讲的是 UTF-8 解码。输入不保证是合法 UTF-8（C 接口不该假设这个），所以解码函数的契约是“永远不越界，遇到坏字节就前进一个字节”（`c/sift_tok.c` 第 46 到 77 行）：

```c
static size_t utf8_decode(const unsigned char *s, size_t rem, uint32_t *cp)
{
	uint32_t c = s[0];

	*cp = BAD_CP;
	if (c < 0x80) {
		*cp = c;
		return 1;
	}
	if (c >= 0xc2 && c <= 0xdf && rem >= 2 && is_cont(s[1])) {
		*cp = (c & 0x1f) << 6 | (s[1] & 0x3f);
		return 2;
	}
	if (c >= 0xe0 && c <= 0xef && rem >= 3 && is_cont(s[1]) &&
	    is_cont(s[2])) {
		c = (c & 0x0f) << 12 | (s[1] & 0x3f) << 6 | (s[2] & 0x3f);
		if (c < 0x800 || (c >= 0xd800 && c <= 0xdfff))
			return 1;
		*cp = c;
		return 3;
	}
	if (c >= 0xf0 && c <= 0xf4 && rem >= 4 && is_cont(s[1]) &&
	    is_cont(s[2]) && is_cont(s[3])) {
		c = (c & 0x07) << 18 | (s[1] & 0x3f) << 12 |
		    (s[2] & 0x3f) << 6 | (s[3] & 0x3f);
		if (c < 0x10000 || c > 0x10ffff)
			return 1;
		*cp = c;
		return 4;
	}
	return 1;
}
```

规则分四档：ASCII 一个字节；`0xc2` 到 `0xdf` 开头，后面跟一个续字节，两个字节（`0xc0` 和 `0xc1` 只能编出过长序列，所以不收）；`0xe0` 到 `0xef` 三个字节，要排除过长（小于 `0x800`）和代理对（`0xd800` 到 `0xdfff`）；`0xf0` 到 `0xf4` 四个字节，要排除过长和超过 `U+10FFFF` 的值。凡是不合格的，返回长度 1 和 `BAD_CP`，调用者向前挪一个字节再试。每个分支先查 `rem`（剩余字节数）再读 `s[1]`、`s[2]`，所以读不到缓冲区之外。

这和 Python 对待坏数据的方式是对得上的：`str` 里可以有孤立的代理字符 (`"\ud800"`)，Python 的正则把它当作一个不属于任何词元的普通字符跳过；这里的 C 版本在字节层面看到的是 `ed a0 80`，三个字节都不合法，一个一个跳过。两者对词元流的影响相同，但对字符计数的影响不同，这正是下一节的 bug 的来源。

`put_span` 加主循环（第 102 到 161 行）：

```c
/* Store a span if there is room; the count goes on either way. */
static void put_span(struct sift_span *out, size_t cap, size_t n,
		     size_t start, size_t end)
{
	if (n < cap) {
		out[n].start = start;
		out[n].end = end;
	}
}

int sift_tokenize(const char *utf8, size_t len, struct sift_span *out,
		  size_t cap, size_t *n_out)
{
	const unsigned char *s = (const unsigned char *)utf8;
	size_t i = 0;
	size_t n = 0;

	if (!n_out)
		return -EINVAL;
	*n_out = 0;
	if ((!utf8 && len) || (!out && cap))
		return -EINVAL;

	while (i < len) {
		size_t start = i;
		size_t chars;
		size_t k;
		uint32_t cp;

		if (is_latin(s[i])) {
			while (i < len && is_latin(s[i]))
				i++;
			if (i < len && s[i] == '+') {
				i++;
				if (i < len && s[i] == '+')
					i++;
			} else if (i < len && s[i] == '#') {
				i++;
			}
			put_span(out, cap, n++, start, i);
			continue;
		}

		i += cjk_run(s + i, len - i, &chars);
		if (chars == 1) {
			put_span(out, cap, n++, start, i);
		} else if (chars > 1) {
			for (k = 0; k + 1 < chars; k++)
				put_span(out, cap, n++,
					 start + k * CJK_BYTES,
					 start + (k + 2) * CJK_BYTES);
		} else {
			/* Not a token: step over one whole character. */
			i += utf8_decode(s + i, len - i, &cp);
		}
	}

	*n_out = n;
	return n > cap ? -ENOSPC : 0;
}
```

读它的时候注意三点。第一，`put_span` 无论有没有位置都让计数前进（`n++` 在调用处），只有 `n < cap` 时才真的写，这就是“`*n_out` 永远完整”的实现。第二，CJK 二元组的区间直接用算术算：`start + k * CJK_BYTES` 到 `start + (k + 2) * CJK_BYTES`，前提是所有 CJK 字符（`U+3400` 到 `U+4DBF`、`U+4E00` 到 `U+9FFF`、`U+F900` 到 `U+FAFF`）都在 BMP 里，UTF-8 里正好 3 个字节，源码第 13 到 17 行的注释就是在写这个假设。第三，“不是词元”的字符整字符跳过（第 155 行），而不是只跳一个字节，省掉对续字节的重复解码；这一点对输出没有影响，我没有量过它对速度的影响。

### 编译警告与 sanitizer

内核风格要求 `-Wall -Wextra` 干净，我加了 `-Werror` 再编一次，并用 AddressSanitizer 加 UBSan 跑一个随机字节模糊测试。模糊测试程序是 `lab/ch24/sanitize_fuzz.c`：每一轮造一个刚好 `len` 字节的堆缓冲区和一个刚好 `cap` 个元素的 span 数组（所以越界一个字节就是一次 ASan 报告），字节从一张“有意义”的字母表里抽（ASCII 词元字符、`0xe0` 到 `0xef` 的前导字节、`0x80` 到 `0xbf` 的续字节、`0xf5` 以上的非法字节、`0x00`），再检查返回码与 `*n_out` 的关系，以及每个 span 是否满足 `start < end <= len` 且按起点单调不降（`lab/ch24/sanitize_fuzz.c` 的 `check` 函数）。

`extra.sh` 把这三件事串起来，下面是它前半段的输出（`nm` 那一段上面已经贴过，我省掉了）：

```text
$ bash lab/ch24/extra.sh   # the first part of its output
$ gcc -O2 -Wall -Wextra -Werror -fPIC -c sift_tok.c
$ gcc -O2 -Wall -Wextra -Werror -fPIC -c sift_capi.c
no warnings
$ gcc -fsanitize=address,undefined sanitize_fuzz.c sift_tok.c
200000 rounds, no violation
```

`-Wall -Wextra -Werror` 下 `sift_tok.c` 和 `sift_capi.c` 都编译通过，随机字节模糊测试 200000 轮没有违反契约，ASan 与 UBSan 没有任何报告。这不等于“没有 bug”：字母表是我挑的，64 字节的上限也是我挑的，它能证明的只是“在这类输入上不越界”。内存安全这件事，C 一侧要靠工具和纪律，换到下一篇的 Rust，是类型系统在做同一件事。

## ctypes：不用编译器的那条路

`ctypes` 是标准库里的一个外部函数接口。它做三件事：用 `dlopen` 把共享库载入进程；把 Python 对象按你声明的 C 类型转换成寄存器和内存里的值；用 libffi 按 ABI 发起调用，再把返回值转回 Python 对象。不需要编译器、不需要头文件、不需要胶水代码。这也是它最大的风险：它一件事都不检查。

`src/sift/ext/ctok.py` 是这样接 `sift_tokenize` 的（第 26 到 50 行）：

```python
class Span(ctypes.Structure):
    """struct sift_span: the byte range of one token."""

    _fields_ = [("start", ctypes.c_size_t), ("end", ctypes.c_size_t)]


def load(path: Path) -> ctypes.CDLL:
    """Load the library at path and declare its functions."""
    lib = ctypes.CDLL(str(path))
    lib.sift_tokenize.argtypes = [
        ctypes.c_char_p,
        ctypes.c_size_t,
        ctypes.POINTER(Span),
        ctypes.c_size_t,
        ctypes.POINTER(ctypes.c_size_t),
    ]
    lib.sift_tokenize.restype = ctypes.c_int
    lib.sift_count_cjk.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    lib.sift_count_cjk.restype = ctypes.c_size_t
    return lib


_lib = load(Path(os.environ.get("SIFT_LIBTOK", LIBRARY)))
_tokenize = _lib.sift_tokenize
_count_cjk = _lib.sift_count_cjk
```

`Span` 是对 `struct sift_span` 的镜像：`_fields_` 里两个 `c_size_t`，顺序和类型必须与 C 里的一样，没有任何东西替你核对。`load` 里设 `argtypes` 和 `restype`，这是 ctypes 唯一的防线：声明了，ctypes 才会按 `c_char_p`、`c_size_t`、`POINTER(Span)` 去转换你传的 Python 对象；没声明，它就套一套默认规则（下面会看到这套规则有多危险）。

调用本身在 `spans` 里（第 53 到 76 行）：

```python
def spans(data: bytes) -> list[int]:
    """Return the token spans of UTF-8 data: start, end, start, ...

    Raise OSError if the C code reports an error.
    """
    cap = len(data) // FIRST_GUESS + 1
    n = ctypes.c_size_t()
    while True:
        buf = (Span * cap)()
        rc = _tokenize(data, len(data), buf, cap, ctypes.byref(n))
        if rc == 0:
            break
        if rc != -errno.ENOSPC:
            raise OSError(-rc, os.strerror(-rc))
        cap = n.value
    # The array is a buffer of size_t pairs; view it as plain numbers.
    numbers = ctypes.cast(buf, ctypes.POINTER(ctypes.c_size_t))
    return numbers[: 2 * n.value]


def tokens(folded: str) -> list[Token]:
    """Return the tokens of folded, which is NFKC and casefolded."""
    data = encode(folded)
    return tokens_from_spans(folded, data, spans(data))
```

几个值得停一下的点。`(Span * cap)()` 是 ctypes 的数组类型：`Span * cap` 造出一个元素类型为 `Span`、长度为 `cap` 的新类，再调用它得到一个零初始化的实例，内存就是一块连续的 `cap * 16` 字节，可以直接交给 C。`ctypes.byref(n)` 传一个 `size_t` 变量的地址（`n_out` 是输出参数）。返回码负数时循环：`-ENOSPC` 就按 `n.value` 重新分配再调一次，别的负数当作 `errno` 抛 `OSError`。最后那个 `ctypes.cast(buf, POINTER(c_size_t))` 把“Span 数组”重新解释为“size_t 数组”，再用切片 `numbers[:2 * n.value]` 一次性拿出一个 Python 整数列表，这比逐个读 `buf[i].start` 快得多，也是我在这个接口里唯一做的优化。

实验一下这套声明本身，用 `lab/ch24/ctypes_struct.py`，它把 `ctok` 里的声明一行行手写了一遍，并造了一个有填充的结构体对照：

```text
$ python3 lab/ch24/ctypes_struct.py
sizeof(Span): 16
sizeof(Padded): 16
sizeof(Packed): 9
Padded.value offset: 8
Packed.value offset: 1
cap 2: rc -28 (-ENOSPC), n_out 4
written: [(0, 3), (4, 10)]
cap 4: rc 0, n_out 4
0 3 c++
4 10 搜索
7 13 索引
10 16 引擎
as size_t: [0, 3, 4, 10, 7, 13, 10, 16]
```

`sizeof(Span)` 是 16，和前面汇编里看到的两个 8 字节字段吻合。`Padded`（一个 `char` 后面跟一个 `double`）的 `value` 偏移是 8 而不是 1，因为 `double` 要按 8 字节对齐，编译器在 `char` 后面塞了 7 个字节的填充，整个结构体因此是 16 字节；`_pack_ = 1` 去掉填充，变成 9 字节、偏移 1，这也是读网络协议或磁盘格式时要用的写法。`cap 2` 那一次，C 代码按约定只写了 2 个 span，返回 `-28`（也就是 `-ENOSPC`，Linux 上 `ENOSPC` 是 28），但 `n_out` 是完整的 4；第二次给足 4 个，返回 0。最后一行是缓冲区协议的一个小演示：数组本身就是一块内存，把它看成 `size_t` 序列，就是 `[0, 3, 4, 10, ...]`，没有任何拷贝（缓冲区协议后面单独一节讲）。

### 五个坑

这一节的每个坑我都跑了。先是默认类型规则。`ctypes_libc.py` 调 libc 的 `strlen` 和 `getenv`：

```text
$ python3 lab/ch24/ctypes_libc.py
bytes: 11
strlen, defaults : 11
strlen, declared : 11
default restype cut the address: True
address fits 32 bits: False
getenv as c_char_p: b'0'
```

`strlen` 在默认规则下也答对了，因为一个 11 字节的 `bytes` 被传成 `char *`，返回值被当 `int` 读，11 装得下。`getenv` 才暴露问题：它返回的是 `char *`，一个 64 位地址，而 ctypes 默认把返回值当 C 的 `int`（32 位）读，地址被截断。`cut != address` 为 `True` 说明截断后的值和真实地址不同，`address fits 32 bits: False` 说明真实地址确实超过了 32 位。这个 bug 在地址碰巧小于 4 GB 的机器上不会发作，换一台机器就崩，所以“跑得通”不是证据。

ctypes 对 Python 值的默认转换在 `Modules/_ctypes/callproc.c` 的 `ConvParam`（第 667 行起）。`None` 变空指针；Python `int` 变 C 的 `int`（第 708 到 712 行用 `ffi_type_sint`，所以只有 32 位）；`bytes` 变 `char *`（第 723 行）；`str` 变 `wchar_t *`（第 730 行，在 Linux 上是 UTF-32）；其他对象会去找 `_as_parameter_` 属性，找不到就是第 760 行的 `Don't know how to convert parameter`。注意这张表里没有 `float`。我写了一个脚本来看这套规则在 `sift_count_cjk` 上的后果，它不设 `argtypes`：

```python
"""ctypes without argtypes: what C actually receives."""

import ctypes

from sift.ext import ctok

lib = ctypes.CDLL(str(ctok.LIBRARY))
lib.sift_count_cjk.restype = ctypes.c_size_t

text = "搜索引擎"
data = text.encode()
print("characters:", len(text), "bytes:", len(data))
print("bytes, no argtypes:", lib.sift_count_cjk(data, len(data)))
print("str, no argtypes  :", lib.sift_count_cjk(text, len(data)))
print("len = 2**32 + 12  :", lib.sift_count_cjk(data, 2**32 + 12))
print("len = 2**32 + 4   :", lib.sift_count_cjk(data, 2**32 + 4))
```

```text
$ python3 /tmp/sift-scratch/ch24/pitfalls.py
characters: 4 bytes: 12
bytes, no argtypes: 4
str, no argtypes  : 0
len = 2**32 + 12  : 4
len = 2**32 + 4   : 1
```

四个答案里只有第一个是对的。`bytes` 走 `char *`，结果 4。`str` 被 ctypes 转成 `wchar_t *`，C 看到的是 UTF-32 字节，`搜` 的码点 `0x641c` 被存成 `1c 64 00 00`，在 UTF-8 解码规则里根本不是 CJK，所以结果是 0，而且没有任何报错。长度传 `2**32 + 12` 这个整数，被截成 32 位的 `12`，答案 4 碰巧对；传 `2**32 + 4`，被截成 4，C 只读了 4 个字节（一个完整的 `搜` 加半个字），答案是 1。长度被悄悄截断而不报错，是整数默认规则的直接后果。

第三个坑是可变参数函数。C 的 `printf` 的原型是 `int printf(const char *fmt, ...)`，省略号后面的参数，编译器按“默认实参提升”规则传（`float` 提升成 `double`），而 ctypes 看不到原型，只能看你给的 Python 对象：

```text
$ python3 lab/ch24/ctypes_libc.py
printf with a float: argument 2: TypeError: Don't know how to convert parameter 2
printf with c_double: 1.50
printf with ints: 42 ok
after fflush
```

给 `printf` 传一个 Python `float` 直接报 `ArgumentError`（上面 `ConvParam` 里没有 `float` 的分支）；包成 `ctypes.c_double(1.5)` 才行。整数和 `bytes` 能直接传，但它们被当成 `int` 和 `char *`，如果格式串写的是 `%ld` 而你传了 Python `int`，只会在 32 位里读到一个值。`callproc.c` 第 880 行有一句专门判断：当调用时给的参数个数多于 `argtypes` 声明的个数，就认为这是一次可变参数调用，随后（第 894 行起）改用 libffi 的 `ffi_prep_cif_var` 准备调用描述。Apple 的 arm64 平台上，可变参数用另一套调用约定，这一步在那里是必需的；在我的 x86-64 上没有区别，我只能确认代码路径存在，没有在 arm64 上验证。

第四个坑藏在最后一行输出里。C 的 `stdout` 有自己的缓冲区，和 Python 的 `sys.stdout` 是两个东西。开发环境设了 `PYTHONUNBUFFERED=1`，所以上面一切都按调用顺序出现。取消它再把输出接到管道上，就是另一幅图景：

```text
$ env -u PYTHONUNBUFFERED python3 lab/ch24/ctypes_libc.py | cat
printf with c_double: 1.50
printf with ints: 42 ok
bytes: 11
strlen, defaults : 11
strlen, declared : 11
default restype cut the address: True
address fits 32 bits: False
getenv as c_char_p: b'0'
printf with a float: argument 2: TypeError: Don't know how to convert parameter 2
after fflush
```

两行 `printf` 的输出跑到最前面，是因为脚本里调用了 `fflush(None)`：C 的缓冲区在那一刻被刷出；而 Python 自己的输出还在 Python 的缓冲区里，到进程结束才出来。如果脚本里没有 `fflush`，则 C 的输出在进程退出时才被刷，反而排到最后。两个缓冲区、两套刷新时机，所以脚本里的 `libc.fflush(None)` 是必需的，而不是装饰。

第五个坑留到后面的“崩溃”一节。

### 每次调用付了什么

还有两件事会影响后面的基准，先记下。

第一，ctypes 每次调用都要重新准备调用描述。`callproc.c` 的 `_call_function_pointer`（第 831 行起）里，准备调用描述的代码（第 894 到 928 行，可变参数调用走 `ffi_prep_cif_var`，其余走 `ffi_prep_cif`）在每一次调用里都会执行，之后才是 `ffi_call`（第 954 行）。我拆开计时，用的还是 10 字节的 `'ab中cdefg'`，每项 200000 次调用取中位数：

```text
$ python3 /tmp/sift-scratch/ch24/percall.py
python no-op                     41.3 ns
str.encode                      103.8 ns
ctypes raw call (bytes in)      456.4 ns
ctypes ctok.count_cjk           715.3 ns
cffi raw call (bytes in)        169.0 ns
cffi cffitok.count_cjk          447.7 ns
cython count_cjk                 41.7 ns
capi count_cjk                   34.0 ns
```

`str.encode` 约 104 纳秒（含我自己的 `encode` 包装函数的一层调用），ctypes 的原始调用（`bytes` 已经备好，直接传）约 456 纳秒，`ctok.count_cjk` 总共约 715 纳秒：多出来的约 155 纳秒是包装函数、`len` 和 `int()`。最上面的 Python 空函数在这个脚本里是 41 纳秒，比后面基准表里的 34 高一点，因为这里用 `func(*args)` 调用，多了一次解包。同样的原始调用，cffi 是约 169 纳秒。ctypes 这一边的开销有一部分是上面那段每次都跑的准备代码加 `ConvParam` 的逐参数判断；cffi 为什么更快，我没有去读它的 C 后端，只能说从数字上看它没有在每次调用时重做同样的事（我猜它把调用描述缓存了）。

第二，ctypes 默认会释放 GIL。`callproc.c` 第 937 行和第 974 行：`if ((flags & FUNCFLAG_PYTHONAPI) == 0)` 就在调用前后做 `Py_UNBLOCK_THREADS` 与 `Py_BLOCK_THREADS`。`CDLL` 加载的函数不带 `FUNCFLAG_PYTHONAPI`，所以调用 C 时 GIL 是放开的，别的线程可以继续跑 Python；`PyDLL`（`Lib/ctypes/__init__.py` 第 496 行）加载的函数带这个标志，用于调用 Python C API 本身，调用时 GIL 保持持有。在后面 C API 一节我会用线程把这一点量出来。

## 字节偏移与 str 偏移

C 报的是 UTF-8 字节偏移，`Token.start` 和 `Token.end` 是 str 字符偏移。两者只在纯 ASCII 文本里相同。整个语料 123 个文件里，只有 1 个的 `len(data) == len(folded)`（后面基准一节里 `stages.py` 的输出会给出这个数）：中文文章里几乎每个文件都有 CJK 字符，每个占 3 个字节。所以映射不能省。`src/sift/ext/__init__.py` 的 `tokens_from_spans`（第 42 到 82 行）：

```python
def tokens_from_spans(
    folded: str, data: bytes, flat: Sequence[int]
) -> list[Token]:
    """Build the Token list from byte spans.

    data is encode(folded) and flat holds the spans as start0, end0,
    start1, end1, ... byte offsets, ordered by start as the C code
    emits them. Positions count the spans from 0.

    When data is as long as folded every character took one byte, so
    byte and str offsets are the same. Otherwise the str offset of a
    span is the str offset of the one before plus the characters in
    the bytes between the two starts; a gap of one three-byte
    character, as between two bigrams of a run, is not decoded. A
    token is either ASCII or CJK, and a CJK character takes three
    bytes, which gives its length in characters without decoding it.
    """
    new = _new_token
    out: list[Token] = []
    it = iter(flat)
    if len(data) == len(folded):
        for position, (start, end) in enumerate(zip(it, it, strict=True)):
            out.append(new(Token, (folded[start:end], position, start, end)))
        return out
    byte_at = 0
    char_at = 0
    for position, (start, end) in enumerate(zip(it, it, strict=True)):
        gap = start - byte_at
        if gap:
            if gap == 3 and 0xE0 <= data[byte_at] < 0xF0:
                char_at += 1
            else:
                skipped = data[byte_at:start].decode(ENCODING, ERRORS)
                char_at += len(skipped)
            byte_at = start
        size = end - start
        if data[start] >= 0x80:
            size //= 3
        stop = char_at + size
        out.append(new(Token, (folded[char_at:stop], position, char_at, stop)))
    return out
```

思路是增量的：不是对每个词元从头数，而是记住上一个词元起点的位置 `(byte_at, char_at)`，只数两个起点之间的字节有多少个字符。CJK 二元组之间的间隔恰好是一个三字节字符（`0xE0` 到 `0xEF` 开头），直接加 1，不解码；其余间隔才真的 `decode`。词元自己的长度也不解码：一个词元要么全是 ASCII（字节数等于字符数），要么全是 CJK（字节数除以 3）。

有一个细节埋在第 30 到 34 行的两个常量里：

```python
ENCODING = "utf-8"
# A str may hold lone surrogates; encoding them with the default
# handler raises. surrogatepass writes them as three bytes, which the
# C code treats as invalid UTF-8 and skips, like Python skips them.
ERRORS = "surrogatepass"
```

`str` 可以含孤立的代理字符 (`"\ud800"`)，比如从损坏的文件名或 `surrogateescape` 读来的文本。默认的 `encode` 遇到它会抛 `UnicodeEncodeError`。`surrogatepass` 把它编成三个字节 `ed a0 80`，C 一侧把它当三个非法字节逐个跳过，Python 一侧则把它当作一个不属于任何词元的字符跳过。解码间隔时必须用同一个错误处理器（第 74 行 `data[byte_at:start].decode(ENCODING, ERRORS)`），否则字符计数对不上。

### hypothesis 找到的那类 bug

这个函数现在的样子是修过的。`tests/test_ext.py` 用 hypothesis 比较三种原生实现和 Python 实现的词元流（第 96 到 109 行），我跑 20000 例的那一次抓到过一个真实的偏移映射 bug。修复和代码在同一个提交里，没有单独留下旧版本，所以我没法指着历史说“就是这一个”。能做的是重现这一类 bug：用一个看上去很合理的朴素映射去替换 `tokens_from_spans`，让同一个测试策略去撞它。

```python
def naive_tokens(folded: str) -> list[Token]:
    data = encode(folded)
    flat = ctok.spans(data)
    out = []
    for position in range(len(flat) // 2):
        start, end = flat[2 * position], flat[2 * position + 1]
        char_start = len(data[:start].decode("utf-8", "replace"))
        char_end = char_start + len(data[start:end].decode("utf-8"))
        out.append(
            Token(folded[char_start:char_end], position, char_start, char_end)
        )
    return out
```

朴素版对每个词元把 `data[:start]` 整段解码，数字符数：O(n²)，但它对 ASCII 和 CJK 都是对的。再用 hypothesis（`max_examples=20000`，策略与仓库里的 `test_any_text_gives_the_python_tokens` 一样，`st.characters(exclude_categories=())` 允许代理字符）跑它：

```text
$ python3 -m pytest naive_bug.py | grep -E "^E +(At index|Falsifying|text=)" | fold -s -w 76
At index 0 diff: Token(text='', position=0, start=3, end=4) != 
Token(text='0', position=0, start=1, end=2)
Falsifying example: test_any_text(
text='\ud8000',
```

最小反例是两个字符：一个孤立的 `\ud800` 加一个 `0`。期望的词元是 `('0', start=1, end=2)`，朴素版给出的是 `start=3, end=4`，文本也成了空串。原因就是上面那条：`\ud800` 用 `surrogatepass` 编成三个字节，`decode("utf-8", "replace")` 把这三个非法字节各替换成一个 `U+FFFD`，数出 3 个字符而不是 1 个，偏移漂移了 2。这个 bug 的恶劣之处在于它沉默：不抛异常，不崩溃，只是词元的位置错了；它只会影响用到偏移的地方，比如片段和高亮。我的 `EDGE_TEXTS` 里手写过孤立代理的用例，但手写用例只会覆盖你想到的形状，随机生成的才会找到“代理字符加一个 ASCII 数字”这种组合。现在的实现在同一个输入上给出正确答案：

```text
$ python3 /tmp/sift-scratch/ch24/retries.py | grep fixed
fixed: True [Token(text='0', position=0, start=1, end=2)]
```

这类 bug 值得一句总结：跨语言边界时，“长度”和“偏移”的单位是最容易悄悄变的东西。C 说的是字节，Python 说的是码点，JavaScript 说的是 UTF-16 码元，每个边界都要问一遍“单位是什么”。

## 崩溃：ctypes 不检查指针

ctypes 的第五个坑是最干脆的一个：给它一个坏指针，进程就没了。`lab/ch24/ctypes_segfault_fail.py` 只有二十几行，文件名里的 `_fail` 是实验室的约定：这个脚本预期失败，跑它的人看退出码。

```python
import ctypes
import faulthandler


def read_address(address: int) -> bytes:
    """Return the C string at address."""
    return ctypes.string_at(address)


def main() -> None:
    faulthandler.enable()
    print("reading address 0 ...", flush=True)
    print(read_address(0))
    print("not reached")


if __name__ == "__main__":
    main()
```

`ctypes.string_at(address)` 读从 `address` 开始的 C 字符串，直到遇到 `\0`。给它地址 0，也就是空指针，内核发来 `SIGSEGV`。没有异常，`try/except` 抓不到，`finally` 不会跑，`atexit` 不会跑，因为解释器根本没有机会返回。唯一在进程死之前说话的是 `faulthandler`，脚本里 `faulthandler.enable()` 那一行装上了它。下面是 `extra.sh` 里 `segfault_exit` 一段的输出，我把环境路径折成了 `$PYENV`，把仓库根目录前缀去掉了：

```text
$ bash lab/ch24/extra.sh   # the segfault_exit part of its output
shell exit code: 139 (128 + SIGSEGV 11)
subprocess.run sees: -11
--- stdout
reading address 0 ...
--- stderr, the faulthandler part
Fatal Python error: Segmentation fault

Current thread 0x00007ffff7f83780 [python3.14] (most recent call first):
  File "$PYENV/lib/python3.14/ctypes/__init__.py", line 621 in string_at
  File "lab/ch24/ctypes_segfault_fail.py", line 15 in read_address
  File "lab/ch24/ctypes_segfault_fail.py", line 21 in main
  File "lab/ch24/ctypes_segfault_fail.py", line 26 in <module>
```

两个退出码值得对照。在 shell 里，进程被信号杀死时退出码是 128 加信号编号，`SIGSEGV` 是 11，所以是 139。在 Python 的 `subprocess.run` 里，被信号杀死的子进程的 `returncode` 是负的信号编号，所以是 -11。实验室运行器 (`scripts/chapter.py`) 对名字以 `_fail` 结尾的脚本只要求退出码非零（第 27 到 29 行和第 52 行），这里它拿到的是 -11。

输出里的 Python 栈来自 `faulthandler`，从最内层开始：`ctypes/__init__.py` 第 621 行的 `string_at`，我的 `read_address`（第 15 行）、`main`（第 21 行）、模块顶层（第 26 行）。第 621 行在 CPython 源码里正是 `string_at` 的最后一行，调用一个由 `PYFUNCTYPE(py_object, c_void_p, c_int)` 包装的函数指针（`Lib/ctypes/__init__.py` 第 616 到 621 行）。

`faulthandler` 怎么做到“进程快死了还能说话”的？它在 `SIGSEGV`、`SIGFPE`、`SIGABRT`、`SIGBUS`、`SIGILL` 上装了自己的信号处理函数（`Modules/faulthandler.c` 第 515 到 555 行的 `faulthandler_enable`）。处理函数 `faulthandler_fatal_error`（第 359 行起）先恢复原来的处理方式，再往 stderr 写 `Fatal Python error: ` 和信号名，打印 Python 栈（第 398 行），打印 C 栈（第 400 行），最后 `raise(signum)`（第 414 行）再发一次同一个信号，让原来的默认处理杀掉进程。源码里那段注释强调了一件事：这个函数必须是信号安全的，只能调用信号安全的函数，所以输出走的是 `PUTS` 宏（第 40 行），它直接对文件描述符调 `_Py_write_noraise`，不经过 Python 的 `print`。

C 栈的前几帧是这样的（我再跑了一次，把路径折成了 `$PY`、`$GLIBC`、`$LIBFFI`、`$PYENV`、`$LIBDYN`）：

```text
$ python3 lab/ch24/ctypes_segfault_fail.py 2>&1 >/dev/null | sed -n '/C stack/,+6p'
Current thread's C stack trace (most recent call first):
  "$PY/lib/libpython3.14.so.1.0", at _Py_DumpStack+0x46 [0x7ffff7b7dec6]
  "$PY/lib/libpython3.14.so.1.0", at +0x3a31dc [0x7ffff7ba31dc]
  "$GLIBC/lib/libc.so.6", at +0x422a0 [0x7ffff74422a0]
  "$GLIBC/lib/libc.so.6", at +0x181c1d [0x7ffff7581c1d]
  "$LIBDYN/_ctypes.cpython-314-x86_64-linux-gnu.so", at +0xa328 [0x7ffff76ea328]
  "$LIBFFI/lib/libffi.so.8", at +0xe052 [0x7ffff7f37052]
```

最上面两帧是 `faulthandler` 自己；第三帧是 libc 里的一帧（信号返回的跳板，我没有核对符号，只是从位置推断）；第四帧同样在 libc 里，偏移 `0x181c1d`，没有符号名，我猜是 `strlen` 一类的函数，那是读空指针的那条指令所在；之后是 `_ctypes` 和 libffi，也就是上一节说的那条调用链。没有 Python 一侧的信息，光看这些十六进制偏移，几乎没法知道是哪一行 Python 代码触发的，Python 栈才是破案的关键。生产环境想要这个，不需要改代码：`python3 -X faulthandler` 或环境变量 `PYTHONFAULTHANDLER=1` 就够。

## cffi：用 C 的语法声明 C

`cffi` 是第三方包。ctypes 有两处让人不舒服：用 Python 对象描述 C 类型很啰嗦，而且 ABI 对不上时没人提醒。cffi 在第一点上换了写法，第二点上多给了一条路。它有两种用法，名字很容易记混。

ABI 模式（`ffi.cdef` 加 `ffi.dlopen`）和 ctypes 一样：不编译任何东西，运行时把库载入，按声明去调。区别是声明写成 C 的语法，不是 Python 对象。`src/sift/ext/cffitok.py` 的声明（第 30 到 41 行）：

```python
ffi = FFI()
ffi.cdef(
    """
    struct sift_span {
        size_t start;
        size_t end;
    };
    int sift_tokenize(const char *utf8, size_t len,
                      struct sift_span *out, size_t cap, size_t *n_out);
    size_t sift_count_cjk(const char *utf8, size_t len);
    """
)
```

那是一段 C 代码的字符串，cffi 自己的 C 声明解析器读它，所以 `struct sift_span`、`size_t`、`const char *` 都不用翻译成 `c_size_t` 和 `c_char_p`。调用处在 `spans`（第 65 到 81 行），形状和 ctypes 那一版一样：`ffi.new("size_t *")` 分配一个 C 变量（相当于 ctypes 的 `c_size_t()`），`ffi.new("struct sift_span[]", cap)` 分配一个数组，`n[0]` 读那个变量。`ffi.unpack(numbers, 2 * n[0])` 一次把 C 数组变成 Python 整数列表，和 ctypes 那边的切片对应。传 `bytes` 给 `const char *` 参数，cffi 自己转换；传错类型，它会在调用前抛 `TypeError`，不会把垃圾塞进寄存器。

`ffi.dlopen` 的文档字符串（cffi 2.1.0 的 `api.py` 第 130 到 136 行）把 ABI 模式的前提写得很直白：`ffi.cdef()` 声明的函数和类型“不和任何特定的库绑定，就像 C 头文件一样；在库里我们只找真正的（无类型的）符号”。也就是说，库里有一个叫 `sift_count_cjk` 的符号，cffi 就信你的声明。`lab/ch24/cffi_demo.py` 里我故意写错一次，把 `size_t len` 写成 `int len`：

```text
$ python3 lab/ch24/cffi_demo.py
== ABI mode: cdef + dlopen
count_cjk: 4
wrong cdef, same answer: 4
== API mode: set_source + compile
built: .so
count_cjk: 4
```

`wrong cdef, same answer: 4`。没报错，答案也对，不是因为 cffi 帮了忙：在 x86-64 上，一个 `int` 参数和一个 `size_t` 参数都经由同一个 64 位寄存器传递，这里的值又小，低 32 位就是全部。长度一旦超过 $2^{31}$，或者换到别的 ABI，结果就可能不同，我只在这一台机器上验证了前一半。ABI 模式给你的是“写起来方便”，不是“检查过”。

API 模式（`ffi.set_source` 加 `ffi.compile`，cffi 2.1.0 `api.py` 第 630 行和第 705 行）是另一回事：它生成一个小的 C 扩展模块，里面 `#include` 真正的头文件，再用 C 编译器编译。于是你的 `cdef` 要过一遍 C 编译器的检查，调用也不再经过 libffi，而是编译好的 C 调用。这个检查有多严，我试了两种写错的 `cdef`：

```text
$ python3 api_mismatch.py 2>&1 | grep -E '^(wrong|_api.*error)' \
      | sed 's/^_api_wrong_pointer.c:[0-9:]* //' | cut -c1-80
wrong int width: compiled and imported
error: passing argument 1 of ‘sift_count_cjk’ from incompatible pointer type [-W
error: passing argument 1 of ‘sift_count_cjk’ from incompatible pointer type [-W
wrong pointer: VerificationError
```

指针类型写错（`const int *` 对 `const char *`），gcc 15.3 把 `incompatible-pointer-types` 当作错误，cffi 的 `compile` 抛 `VerificationError`。整数宽度写错（`char len` 对 `size_t len`）则一路通过：C 本来就允许整数之间的隐式转换，编译器没有理由抱怨。所以 API 模式比 ABI 模式强，但它能抓住的只是 C 编译器本来就能抓住的那一类错。`cffi_demo.py` 的后半段把 `sift_tok.c` 作为源文件，临时编出 `_sift_api_demo` 扩展（输出里的 `built: .so`），再调一次，得到同样的 `count_cjk: 4`。用同一个 10 字节的输入，把 ABI 模式和 API 模式的“原始调用”（不含 `encode`）各计时 200000 次：

```text
$ python3 /tmp/sift-scratch/ch24/api_mode.py
built: _api_demo.cpython-314-x86_64-linux-gnu.so
ABI mode raw call    168.6 ns
API mode raw call     99.5 ns
```

ABI 模式 168.6 纳秒，API 模式 99.5 纳秒，省下的约 69 纳秒，大概就是 libffi 那一层（我没有单独量它）。API 模式的代价是要有 C 编译器，要有构建步骤，而且产物和 Python 版本绑定（文件名里有 `cpython-314`）；ABI 模式什么都不要。Sift 里我选的是 ABI 模式，因为 `libsifttok.so` 已经由 Makefile 编好了，再套一层 `ffi.compile` 对这个例子没有意义；API 模式留给练习。

## Cython：写成带类型的 Python

Cython 的做法是第三种：你写一个 `.pyx` 文件（Python 的超集），Cython 把它翻译成 C 源码，再由 C 编译器编成扩展模块。关键在于，你可以在需要速度的地方给变量加 C 类型，这样 Cython 生成的就是真正的 C 循环，而不是对 Python 对象的一连串 C API 调用。`src/sift/ext/_cytok.pyx` 的开头（Cython 没有 Shiki 的语法高亮，下面的块按 Python 着色）：

```python
# cython: language_level=3, boundscheck=False, wraparound=False
"""The tokenizer of Sift in Cython: a typed loop over a str.

tokens() takes text that is already NFKC-normalized and casefolded
(sift.analysis.tokenize.fold) and returns what iter_tokens would yield
for it, as a list. The offsets are str offsets; no byte is encoded.
"""

from sift.analysis.tokenize import Token

cdef object _new = tuple.__new__


cdef inline bint is_latin(Py_UCS4 c) noexcept:
    return (u"0" <= c <= u"9") or (u"a" <= c <= u"z") or c == u"_"


cdef inline bint is_cjk(Py_UCS4 c) noexcept:
    return (
        0x3400 <= c <= 0x4DBF
        or 0x4E00 <= c <= 0x9FFF
        or 0xF900 <= c <= 0xFAFF
    )
```

第 1 行的魔法注释把 `boundscheck` 和 `wraparound` 关掉：下标不再检查越界、不再处理负下标。`cdef inline bint is_cjk(Py_UCS4 c) noexcept` 声明的是一个纯 C 函数 (`cdef`)，参数是 `Py_UCS4`（CPython 里 Unicode 码点的 C 类型，32 位），返回 C 的 `bint`；`noexcept` 的意思是它不会抛 Python 异常，调用点因此不需要检查。我在 Cython 3.2.5 上验证了这个差别：同样的函数，不带 `noexcept` 的版本，生成的调用点是下面这样（原来是一行，排版时我拆成了三行）：

```c
__pyx_t_5 = __pyx_f_5noexc_checked(__pyx_t_4);
if (unlikely(__pyx_t_5 == ((int)-1) && PyErr_Occurred()))
	__PYX_ERR(0, 12, __pyx_L1_error)
```

带 `noexcept` 的版本调用后面没有这一句检查。每个字符一次，对一个 3.3 兆字符的语料不是小数目。（这是我编译的一个几行的草稿 `noexc.pyx` 的生成代码，不在仓库里。）

主循环 `tokens`（第 26 到 71 行）：

```python
def tokens(str folded):
    """Return the tokens of folded, a list of Token."""
    cdef Py_ssize_t n = len(folded)
    cdef Py_ssize_t i = 0
    cdef Py_ssize_t start, k, size
    cdef Py_ssize_t position = 0
    cdef Py_UCS4 c
    cdef list out = []

    while i < n:
        c = folded[i]
        start = i
        if is_latin(c):
            # ...
        elif is_cjk(c):
            while i < n and is_cjk(folded[i]):
                i += 1
            size = i - start
            if size == 1:
                out.append(
                    _new(Token, (folded[start:i], position, start, i))
                )
                position += 1
            else:
                for k in range(start, i - 1):
                    out.append(
                        _new(
                            Token,
                            (folded[k:k + 2], position, k, k + 2),
                        )
                    )
                    position += 1
        else:
            i += 1
    return out
```

它是 `iter_tokens` 的逐行翻译，但变量有类型：`Py_ssize_t` 的下标，`Py_UCS4` 的当前字符，`list` 的结果。`folded[i]` 因为 `folded` 声明成了 `str`，Cython 把它编成直接读 `str` 内部缓冲区的 C 代码，不创建单字符 `str` 对象。`for k in range(start, i - 1)` 因为 `k` 是 `Py_ssize_t`，被编成 C 的 `for` 循环。注意这里没有 `fold`，因为 NFKC 和 `casefold` 留在 Python 一侧：函数收到的是已经折叠过的文本，偏移也直接是 `str` 偏移，所以不需要 `tokens_from_spans` 里那套字节到字符的映射。

### cython -a：黄线告诉你哪里还在和 Python 打交道

`cython -a` 会为 `.pyx` 生成一个 HTML 报告，每一行按“和 Python C API 交互的程度”涂成不同深浅的黄色，白色的行完全是 C。我没有把页面截图放进来（这里不放图），而是用 `extra.sh` 里的脚本把 HTML 里 `score` 大于零的行数出来：

```text
$ bash lab/ch24/extra.sh   # the cython_annotate part of its output
$ cython -3 -a src/sift/ext/_cytok.pyx
lines in the .pyx: 112
yellow lines in total: 27
yellow lines in tokens(): 18
yellow lines in count_cjk(): 4
yellow lines in count_cjk_utf8(): 2
yellow lines of tokens(), with their scores:
   26 score  50  def tokens(str folded):
   28 score   7  cdef Py_ssize_t n = len(folded)
   33 score   5  cdef list out = []
   36 score   2  c = folded[i]
   39 score   2  while i < n and is_latin(folded[i]):
   41 score   2  if i < n and folded[i] == u"+":
   43 score   2  if i < n and folded[i] == u"+":
   45 score   2  elif i < n and folded[i] == u"#":
   47 score   3  out.append(
   48 score  54  _new(Token, (folded[start:i], position, start, i))
   52 score   2  while i < n and is_cjk(folded[i]):
   56 score   3  out.append(
   57 score  54  _new(Token, (folded[start:i], position, start, i))
   62 score   3  out.append(
   63 score   1  _new(
   64 score   2  Token,
   65 score  51  (folded[k:k + 2], position, k, k + 2),
   71 score   2  return out
```

整个文件 112 行里有 27 行是黄的，其中 `tokens()` 占 18 行、`count_cjk` 4 行、`count_cjk_utf8` 2 行。看分数的分布：最深的几行是 `def tokens(str folded)`（50，函数入口的参数处理）和三处 `_new(Token, (...))`（54、54、51），这正是造 `Token` 对象的三个位置：构造 4 元素元组，要为 `position`、`start`、`end` 各造一个 Python `int`，再切出 `folded[start:i]` 的 `str`。`cdef Py_ssize_t n = len(folded)` (7) 和 `cdef list out = []` (5) 是函数开头的一次性开销。分数为 2 的几行，比如 `c = folded[i]`、`while i < n and is_latin(folded[i])`，是被标黄的，但它们的黄不是 Python 对象：生成代码是 `__Pyx_GetItemInt_Unicode(...)` 加一次 `== (Py_UCS4)-1` 的错误检查（`_cytok.c` 里 `c = folded[i]` 那一行生成的就是这样），热循环里它们几乎是 C 的速度。

读这张图的办法是：把注意力放在分数高的行，而不是行数。27 行黄听上去不少，但 859485 次调用都集中在造 `Token` 的那三行上，它们不可能再快了：对象必须存在，因为下游代码要用。所以 Cython 版的上限就是“造 859485 个 `Token` 要多久”，后面的基准会量这个下限。

### 没有类型的 Cython 比正则还慢

Cython 的价值来自类型。我做了一个对照：把 `count_cjk` 改成完全没有声明的版本（`def is_cjk(c)` 是 Python 函数，`ord(text[i])` 在每个字符上造一个 `str` 再取码点），同样用 Cython 编译：

```python
# cython: language_level=3, boundscheck=False, wraparound=False


def is_cjk(c):
    return (
        0x3400 <= c <= 0x4DBF or 0x4E00 <= c <= 0x9FFF or 0xF900 <= c <= 0xFAFF
    )


def count_cjk(text):
    count = 0
    for i in range(len(text)):
        if is_cjk(ord(text[i])):
            count += 1
    return count
```

```text
$ cython -3 -a untyped.pyx && python3 count_yellow.py
yellow lines: 10 of 15
$ python3 /tmp/sift-scratch/cpu_state.py
113 113 113 113 113 ms
$ PYTHONPATH=. python3 run.py
no declarations :  211.4 ms
typed (_cytok)  :    5.1 ms
$ python3 /tmp/sift-scratch/cpu_state.py
113 114 115 115 116 ms
```

没有声明的版本 211.4 毫秒，加了类型的仓库版本 5.1 毫秒，相差 41 倍。同一份算法、同一个编译器，差别只在有没有类型。无类型版本的 211.4 毫秒甚至比前面基准里纯 Python 正则的 38.2 毫秒还慢 5 倍多：Cython 把 Python 的每一步都原样翻成了 C API 调用，省下了字节码分派，但没有省下对象的创建和销毁。黄线报告里 15 行有 10 行是黄的，与之相比仓库版本的 `count_cjk` 只有 4 行。

### 类型化 memoryview

`_cytok.pyx` 里的 `count_cjk_utf8`（第 84 到 112 行）是为缓冲区协议准备的：

```python
def count_cjk_utf8(const unsigned char[::1] data):
    """Return the number of CJK characters in UTF-8 bytes.

    data is any contiguous buffer (bytes, bytearray, memoryview,
    array); it is read in place through a typed memoryview. Bytes
    that do not form a CJK character are skipped.
    """
    cdef Py_ssize_t i = 0
    cdef Py_ssize_t n = data.shape[0]
    cdef Py_ssize_t count = 0
    # ...
    return count
```

参数 `const unsigned char[::1] data` 是一个类型化 memoryview：`unsigned char` 是元素类型，`[::1]` 要求一维、C 连续，`const` 让它接受只读缓冲区 (`bytes`)。它不是 `memoryview` 对象，而是 Cython 在函数入口把任意支持缓冲区协议的对象解析一次，得到一个指向原内存的指针和形状，之后 `data[i]` 都编成 C 的指针取值，没有对象开销。测试 `test_cython_counts_utf8_in_any_buffer`（`tests/test_ext.py` 第 140 到 147 行）确认 `bytes`、`bytearray`、`memoryview` 的切片都能传进去，一个截断的 `b"\xe4\xb8"` 返回 0，不会读过末尾。这个函数是 Cython 对 UTF-8 的一次手工内联，没有 `sift_tok.c` 里 `utf8_decode` 的全部检查：它只认三字节的 `0xE0` 到 `0xEF` 序列，别的字节一律前进 1。对 CJK 计数这件事这已经够了，因为所有 CJK 字符都是三字节；但把它当作通用 UTF-8 解码器就是错的。

## 手写 C API 模块

前面三条路都是“Python 去调 C”。最后一条是“C 住进 Python 里”：写一个 CPython 扩展模块，它是一个共享库，导出一个叫 `PyInit_<模块名>` 的函数，解释器 `import` 它的时候 `dlopen` 进来，调这个函数拿到模块。模块里的函数直接拿到和接受 Python 对象的指针，所以它们能读 `str` 的内部存储，能造 `int`，能抛异常，不需要任何转换层。代价是你要自己管引用计数、异常状态、GIL，每一项出错都是崩溃或泄漏，不是异常。

`c/sift_capi.c` 只暴露一个函数 `count_cjk(text: str) -> int`，数文本里的 CJK 字符。它不产出词元（词元要造 Python 对象，那是另一个战场），所以只出现在基准的“计数”表和“每次调用”表里。完整的函数在第 49 到 86 行：

```c
/*
 * arg is a borrowed reference: the caller's frame keeps the str alive
 * for the whole call, even while the GIL is released, and a str never
 * changes. The result is a new reference, which the caller owns.
 */
static PyObject *capi_count_cjk(PyObject *module, PyObject *arg)
{
	Py_ssize_t len;
	Py_ssize_t count = 0;
	int kind;
	const void *data;

	(void)module;
	if (!PyUnicode_Check(arg)) {
		PyErr_Format(PyExc_TypeError,
			     "count_cjk() argument must be str, not %.100s",
			     Py_TYPE(arg)->tp_name);
		return NULL;
	}
	len = PyUnicode_GET_LENGTH(arg);
	kind = PyUnicode_KIND(arg);
	data = PyUnicode_DATA(arg);

	/* Latin-1 text has no CJK: its characters are below U+0100. */
	if (kind == PyUnicode_1BYTE_KIND)
		return PyLong_FromSsize_t(0);

	if (len >= NOGIL_MIN) {
		Py_BEGIN_ALLOW_THREADS
		count = kind == PyUnicode_2BYTE_KIND ?
			count_ucs2(data, len) : count_ucs4(data, len);
		Py_END_ALLOW_THREADS
	} else {
		count = kind == PyUnicode_2BYTE_KIND ?
			count_ucs2(data, len) : count_ucs4(data, len);
	}
	return PyLong_FromSsize_t(count);
}
```

### PyObject *、引用计数

CPython 里每个对象都是一个以 `PyObject` 开头的结构体，开头有引用计数和类型指针，C 里拿着的永远是 `PyObject *`。引用计数是 CPython 回收内存的主要手段：计数降到 0，对象就地释放。所以 C 代码里每一个 `PyObject *`，都要回答一个问题：这个指针，我拥有一份引用吗？

- 新引用 (new reference)：你拥有一份，用完要 `Py_DECREF`，或者把它交给别人。`PyLong_FromSsize_t(count)` 返回的就是新引用。
- 借用引用 (borrowed reference)：你没有，不能 `Py_DECREF`，也不能保证它活到你需要它的时候。`capi_count_cjk` 的参数 `arg` 是借用的：调用者的栈帧里还有一份，它在整个调用期间都不会走。
- 偷走引用 (stolen reference)：把引用交给一个函数，它负责 `DECREF`，如 `PyTuple_SetItem`。

这个函数里一次 `Py_INCREF` 和 `Py_DECREF` 都没有：参数是借来的，只读它；结果是新建的，直接交出去，所有权转给调用者。出错时（`PyErr_Format` 设好异常，返回 `NULL`）也一样干净，没有任何需要释放的东西。函数开头的注释把这个契约写出来了（第 49 到 53 行）。

`Py_INCREF` 与 `Py_DECREF` 在 3.14 里是 `static inline` 函数（`Include/refcount.h` 第 252 行起和第 411 行起）。非自由线程构建的 `Py_DECREF` 先检查对象是不是永生对象（immortal，3.12 引入，比如 `None` 和小整数），是就直接返回，否则 `--op->ob_refcnt`，减到 0 调 `_Py_Dealloc`。

怎么证明“我没有泄漏也没有多放”？`lab/ch24/capi_refcount.py` 用 `sys.getrefcount` 在调用一百万次前后各读一次同一个字符串的引用计数：

```text
$ python3 lab/ch24/capi_refcount.py
getrefcount before 2, after 1000000 calls 2
count_cjk of 100000 CJK characters: 100000
refcount unchanged after TypeError: True
```

读数是 2（`getrefcount` 自己的参数临时占一份，加上变量 `text`），调用后还是 2。第三行是错误路径：一千次 `TypeError` 之后，传进去的 `bytes` 的计数没变。如果函数泄漏一份，计数每次加 1；如果多放一份，计数降到 0，对象在调用者脚下被释放，轻则崩溃，重则静默损坏内存。

这个检查有没有牙，得看它能不能抓住真的错误。我把 `sift_capi.c` 拷到草稿目录，在函数开头加了一行 `Py_INCREF(arg)`，没有对应的 `Py_DECREF`，换了模块名编成 `_leaky`，用同样的方式检查：

```c
	(void)module;
	Py_INCREF(arg);	/* BAD: nobody ever calls Py_DECREF */
```

```text
getrefcount before 4 after 1000000 calls 1000004
```

一百万次调用，计数从 4 涨到 1000004，正好多出一百万。引用泄漏就是这样：每次一份，永不回收，函数本身的返回值全是对的，只有内存在涨。

### 模块初始化：multi-phase

文件末尾（第 88 到 113 行）是方法表、槽、模块定义和入口：

```c
static PyMethodDef capi_methods[] = {
	{"count_cjk", capi_count_cjk, METH_O,
	 PyDoc_STR("count_cjk(text, /)\n--\n\n"
		   "Return the number of CJK characters in text.")},
	{NULL, NULL, 0, NULL},
};

static PyModuleDef_Slot capi_slots[] = {
	{Py_mod_multiple_interpreters, Py_MOD_PER_INTERPRETER_GIL_SUPPORTED},
	{Py_mod_gil, Py_MOD_GIL_NOT_USED},
	{0, NULL},
};

static struct PyModuleDef capi_module = {
	.m_base = PyModuleDef_HEAD_INIT,
	.m_name = "_capi",
	.m_doc = PyDoc_STR("C API functions of Sift."),
	.m_size = 0,
	.m_methods = capi_methods,
	.m_slots = capi_slots,
};

PyMODINIT_FUNC PyInit__capi(void)
{
	return PyModuleDef_Init(&capi_module);
}
```

入口 `PyInit__capi` 返回的不是模块，而是 `PyModuleDef_Init(&capi_module)`：这是 multi-phase 初始化 (PEP 489)。入口函数只交出模块定义（`Include/moduleobject.h` 第 35 行声明了 `PyModuleDef_Init`），之后由解释器按槽的指示去创建模块、执行初始化，这样同一个共享库可以在多个子解释器里各创建一个互不相干的模块对象。老式的 single-phase 初始化在入口里就创建并填满模块，没法做到这一点。`m_size = 0` 表示模块没有每个实例的私有状态，我们没有状态。

槽表 `capi_slots` 里有两个声明（常量定义在 `moduleobject.h` 第 77 到 80 行和第 90 到 100 行）。`Py_mod_multiple_interpreters` 取 `Py_MOD_PER_INTERPRETER_GIL_SUPPORTED`：这个模块可以在拥有各自 GIL 的子解释器里使用（第 16 篇的 `--mode interp` 用的就是这种子解释器）。`Py_mod_gil` 取 `Py_MOD_GIL_NOT_USED`：这个模块不依赖 GIL 的保护，在自由线程构建 (PEP 703) 里可以不开 GIL。

最后一条我实际验证了。开发环境里有一个自由线程的 `python3.14t`。我把 `sift_capi.c` 用它的头文件重新编一次，再去掉含 `Py_mod_gil` 的那一行编一次，然后各自导入：

```text
$ python3.14t -c 'import sys; print(sys._is_gil_enabled())'
False
$ gcc -O2 -fPIC -shared -I$INC -o with/_capi$SUF sift_capi.c
$ gcc -O2 -fPIC -shared -I$INC -o without/_capi$SUF nogil_slot.c
# (nogil_slot.c: sift_capi.c without the Py_mod_gil line)
$ PYTHONPATH=with python3.14t probe.py
count_cjk: 2
GIL enabled after import: False
$ PYTHONPATH=without python3.14t probe.py
RuntimeWarning: The global interpreter lock (GIL) has been enabled to load 
module '_capi', which has not declared that it can run safely without the 
GIL. To override this behavior and keep the GIL disabled (at your own risk), 
run with PYTHON_GIL=0 or -Xgil=0.
count_cjk: 2
GIL enabled after import: True
```

声明了 `Py_MOD_GIL_NOT_USED` 的版本，导入之后 `sys._is_gil_enabled()` 仍然是 `False`；没有声明的版本，解释器在导入时打出警告，并且把 GIL 重新打开：整个进程都被拖回有锁状态。声明是一个承诺，不是一个开关：这个函数除了读参数就是造一个整数，没有可变的全局状态，所以我敢承诺。如果模块里有静态缓冲区，这个承诺就是假的，而没有任何东西检查它。

### 参数解析与 str 的内部布局

`PyMethodDef` 里的 `METH_O` 表示这个函数正好接受一个位置参数，直接把它作为 `PyObject *` 传来（`Doc/c-api/structures.rst` 对 `METH_O` 有说明）。除此之外还有 `METH_VARARGS`（参数打成元组，配合 `PyArg_ParseTuple` 解析）、`METH_FASTCALL`（参数是数组，省掉元组）和 Argument Clinic（从注释生成解析代码）。`METH_O` 最简单，代价是类型检查要自己做：第 62 行的 `PyUnicode_Check(arg)` 和随后的 `PyErr_Format(PyExc_TypeError, ...)`。函数的文档字符串开头 `count_cjk(text, /)\n--\n\n` 是 `inspect.signature` 认的格式。我试了正常和不正常的调用：

```text
signature: (text, /)
TypeError: count_cjk() argument must be str, not bytes
TypeError: sift.ext._capi.count_cjk() takes exactly one argument (0 given)
TypeError: sift.ext._capi.count_cjk() takes exactly one argument (2 given)
```

`inspect.signature` 读出了 `(text, /)`；传 `bytes` 得到我自己写的 `TypeError` 消息；参数个数不对，则是解释器根据 `METH_O` 抛的，我什么都没写。

`PyUnicode_GET_LENGTH`、`PyUnicode_KIND`、`PyUnicode_DATA` 这三个宏读的是 PEP 393 的 `str` 内部布局。一个 `str` 不是固定宽度：所有码点都小于 256，每个字符用 1 字节；最大码点小于 65536，用 2 字节；否则用 4 字节（`Include/cpython/unicodeobject.h` 第 247 到 250 行的 `PyUnicode_1BYTE_KIND`、`2BYTE`、`4BYTE`，第 260 行 `PyUnicode_KIND`，第 278 到 286 行 `PyUnicode_DATA`）。用 `sys.getsizeof` 可以看见：

```text
'a'   x 1000: 1041 bytes
'é'   x 1000: 1057 bytes
'中'   x 1000: 2058 bytes
'😀'   x 1000: 4060 bytes
```

一千个字符，ASCII 是 1041 字节，`é` 是 1057 字节，`中` 是 2058 字节，emoji 是 4060 字节：每多一档，宽度翻倍，开头那 41 到 60 字节是对象头。`capi_count_cjk` 利用这一点做了两件事：1 字节档（第 73 到 74 行）直接返回 0，因为 `U+0100` 以下不可能是 CJK；2 字节档和 4 字节档各有一个循环（第 29 到 47 行），按真实宽度读，不需要先编码成 UTF-8。ctypes 版本必须先 `encode` 成 `bytes`（把整个文本拷一份），cffi 版本同理；这个模块不拷贝，也不解码。

### C 里的 GIL

CPython 的 GIL 保护解释器的内部状态：持有它的线程可以安全地读写 Python 对象，别的线程等着。C 扩展里可以主动把它让出来：`Py_BEGIN_ALLOW_THREADS` 和 `Py_END_ALLOW_THREADS`（`Include/ceval.h` 第 119 到 125 行）展开成 `PyEval_SaveThread()` 和 `PyEval_RestoreThread(_save)`，中间的代码在没有 GIL 的情况下运行，别的线程这时可以继续跑 Python。规则很严格：中间不能碰任何 Python 对象，也不能调任何 Python API，因为没人保护它们。

`capi_count_cjk` 在文本长度达到 `NOGIL_MIN`，也就是 $2^{16}$ 个字符时才释放（第 76 到 80 行）。短字符串不值得，因为释放加重新获取 GIL 本身要花时间，比扫描一小段文本贵。在释放期间读 `data` 为什么安全？因为 `arg` 的引用由调用者的栈帧持有，在这次调用返回之前不会消失，而 `str` 是不可变的，内容不会被别的线程改动。如果参数是 `bytearray`，这个论证就不成立了，要先拿缓冲区再锁住长度。

这个设计是否真的有效，我用线程实验：一个 2000 万字符的 `str`，同一个任务分别开 1 个和 4 个线程，各自计数一次。如果 GIL 被释放，4 个线程应该几乎同时做完，总时间接近 1 个线程；如果 GIL 被持有，它们串行，总时间是 4 倍。三种实现各跑一次：

```text
$ python3 /tmp/sift-scratch/ch24/gil.py
chars: 20000000 bytes: 36000000
capi    1 thread    7.3 ms  4 threads    7.6 ms  (1.04x)
ctypes  1 thread   74.7 ms  4 threads   86.1 ms  (1.15x)
cython  1 thread   26.7 ms  4 threads  108.5 ms  (4.07x)
```

C API 模块：1 个线程 7.3 毫秒，4 个线程 7.6 毫秒，四倍的活只花了 1.04 倍的时间。ctypes 的 `CDLL` 调用（`callproc.c` 第 937 行释放了 GIL）：74.7 毫秒对 86.1 毫秒，1.15 倍，也并行了；它的绝对时间是 C API 模块的 10 倍，因为它处理的是 36 MB 的 UTF-8 字节，还要逐字符解码（`DATA` 是在计时之外编好的，这里没有算编码的时间），而 C API 模块直接扫 2 字节宽的 `str`。Cython 的 `def count_cjk` 没有释放 GIL：26.7 毫秒对 108.5 毫秒，4.07 倍，就是线性串行。Cython 可以用 `with nogil:` 释放，我的 `.pyx` 里没有写，所以这个结果是“我没有写”，不是 Cython 的限制。这台机器是 16 个逻辑核，所以 4 个线程能真的并行。

构建就是 `make ext` 里的第二条命令。源码第 12 行的 `#define PY_SSIZE_T_CLEAN` 在 3.13 以后是多余的（`Include/pyport.h` 第 175 行：“Now PY_SSIZE_T_CLEAN is mandatory.”），我留着它，是为了让这个文件在更老的 Python 上也能编。

## 缓冲区协议：不拷贝地交出内存

有一个反复出现的问题：Python 对象的内存怎么交给 C，又不拷贝。`str` 有 PEP 393 的布局，但 `bytes`、`bytearray`、`array.array`、NumPy 数组、`mmap` 各有各的布局，如果每种对象都要 C 一侧专门认识，扩展就写不完了。缓冲区协议 (PEP 3118) 是一个通用的答案：对象实现 `bf_getbuffer`，C 代码调用 `PyObject_GetBuffer(obj, &view, flags)`，拿到一个 `Py_buffer`（`Include/pybuffer.h` 第 20 到 33 行的结构体）：`buf` 是内存首地址，`len` 是总字节数，`itemsize`、`format`、`shape`、`strides` 描述元素类型和多维布局，`readonly` 表示能不能写，`obj` 是对导出对象的一份引用，用完要 `PyBuffer_Release`（第 102 行）。拿着视图期间，导出对象承诺内存地址不变。

`lab/ch24/buffer_protocol.py` 把这一点从 Python 一侧做了一遍。它造一个 `bytearray`，再用 `memoryview`、ctypes 的 `from_buffer`、Cython 的类型化 memoryview 分别看它：

```text
$ python3 lab/ch24/buffer_protocol.py
bytearray, memoryview share memory: True
array sees the same bytes: True
count_cjk via C, no copy: 4
count_cjk via Cython memoryview: 4
view of 2 characters: 6 bytes, 搜索
count_cjk of the view: 2
after array[0] = b'A': Ab
resize with live exports: Existing exports of data: object cannot be re-sized
resize after release works: 19
```

`view.obj is data` 为 `True`：`memoryview` 没有拷贝，只是引用同一块内存。`(ctypes.c_char * len(data)).from_buffer(data)` 造出一个 ctypes 数组，它的内存就是 `bytearray` 的内存（`from_buffer` 要求可写的缓冲区，`bytes` 不行）；把它交给 `sift_count_cjk`，C 直接读那块内存，答案 4。`_cytok.count_cjk_utf8(view)` 也一样：类型化 memoryview 在函数入口调用一次 `PyObject_GetBuffer`，之后是指针访问。`view[start : start + 6]` 是 `memoryview` 的切片，还是同一块内存里的一个子区间，不拷贝；Cython 数它得 2。最后一组是写穿：`array[0] = b"A"` 之后，`bytearray` 的第一个字节变成了 `A`，因为它们是同一块内存。

缓冲区协议还有一个约束，是 `Objects/bytearrayobject.c` 的 `_canresize`（第 104 到 111 行）：只要 `ob_exports > 0`，也就是还有视图在外面，`bytearray` 就拒绝改变大小，抛 `BufferError`，消息是 “Existing exports of data: object cannot be re-sized”。原因很直接：`extend` 可能要 `realloc`，内存搬了家，外面那个 `buf` 指针就悬空了。输出的最后两行就是这个现象：有视图时 `data.extend(b"x")` 失败；`del array, part` 并且 `view.release()` 之后就成功了，长度从 18 变成 19。

回到 Sift 上：在 ctypes 版本里，Python 到 C 的那一次拷贝，也就是 `str.encode`，在整个语料上一共只花 3.0 毫秒（后面基准一节的 `stages.py` 输出），不是瓶颈。缓冲区协议在这里省下的是那 3.0 毫秒，不是那几百毫秒。我提这一点，是因为“零拷贝”听上去总是很值钱，而每次都应该先问：拷贝到底占多少？

## 接进 Sift：sift index --tokenizer

四种实现各自能工作之后，剩下的是怎么让用户选。选项是 `sift index --tokenizer python|c|cffi|cython`，`src/sift/cli.py` 里有一个名字到分析器名的字典，和一个替换流水线第一项的函数 `with_tokenizer`（第 321 到 333 行）：

```python
TOKENIZERS = {
    "python": "mixed",
    "c": "mixed-c",
    "cffi": "mixed-cffi",
    "cython": "mixed-cython",
}
```

Sift 的流水线是一串分析器的名字，默认是 `mixed`、`nfkc`、`stopwords`，分词器是第一项。`--tokenizer cython` 把第一项从 `mixed` 换成 `mixed-cython`，其余不动；如果配置里的流水线不是以某个 mixed 分词器开头的，就报 `ConfigError`，而不是悄悄改写。三个新分析器在 `src/sift/analysis/tokenizers.py` 里，用类关键字参数 `name=` 注册，和旧的 `MixedTokenizer` 并列（下面是 ctypes 的，第 64 到 74 行；cffi 和 Cython 的两个同形，在第 77 到 94 行）：

```python
class CMixedTokenizer(Analyzer, name="mixed-c"):
    """MixedTokenizer with the scan done in C, called by ctypes.

    Needs ``make ext``. Python still does NFKC and casefold.
    """

    def analyze(self, text: str) -> Iterator[Token]:
        """Yield the tokens of iter_tokens(text)."""
        from sift.ext import ctok

        return iter(ctok.tokens(fold(text)))
```

两点设计。第一，原生模块的导入放在 `analyze` 里面，而不是文件顶部：没跑过 `make ext` 的人用 `mixed`，不会碰到 `OSError`；只有要求原生分词器时才会导入，缺了才报错。第二，三个类的 `analyze` 都先调 `fold(text)`，也就是 NFKC 和 `casefold` 仍然是 Python 做，C 或 Cython 只接手扫描。

“选择”要怎么传进工作进程？`sift.parallel` 的 `index_items` 把工作切成块交给进程池，参数要能被 pickle。这里传的不是函数、不是模块，而是流水线的名字（`("mixed-cython", "nfkc", "stopwords")`，三个字符串），工作进程里用 `build_pipeline` 按名字重新建出来（`src/sift/parallel.py` 第 226 行）。名字走过管道，注册表在每个进程里各自填好，没有全局状态要同步，这是我选“名字进流水线”而不是“全局开关”的原因。

这个做法有一个代价，README 里也写了：流水线的名字会被记进 `sift.db`。

```text
$ SIFT_INDEX=idx sift index --full
documents: 123
vocabulary: 81167
full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took N ms
$ SIFT_INDEX=idx sift index
documents: 123
vocabulary: 81167
incremental: parsed 0, unchanged 123, removed 0; segment 2880196 bytes; took N ms
$ SIFT_INDEX=idx sift index --tokenizer c
documents: 123
vocabulary: 81167
full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took N ms
$ SIFT_INDEX=idx sift index --tokenizer c
documents: 123
vocabulary: 81167
incremental: parsed 0, unchanged 123, removed 0; segment 2880196 bytes; took N ms
$ python3 -c "..."   # select value from meta where key = 'pipeline' in sift.db
["mixed-c", "nfkc", "stopwords"]
$ sift index --tokenizer rust
Error: Invalid value for '--tokenizer': unknown tokenizer 'rust', use one of python, c, cffi, cython
```

索引建好后，`sift.db` 的 `meta` 表里存的流水线是 `["mixed-c", "nfkc", "stopwords"]`。因为第三条命令的流水线与第一条不同，`sift index` 把它当作“配置变了”，做了一次完整重建，尽管最后写出的 `segment.sft` 在字节上完全一样；重复同一条命令，则回到增量。名字写错，`typer` 在参数层就拒绝了，并列出可选的值。我的判断是这个代价可以接受：记名字让“这个索引是用哪个分词器建的”有据可查，代价是换分词器要重建，而换分词器本来就不是常见操作。如果行为真的相同，更干净的做法是把“实现”和“规则”分开记，这留给练习。

### 到底一样不一样

“字节相同”是这一篇所有实现的验收标准：

```text
$ bash lab/ch24/extra.sh   # the index_tokenizers part, 3 lines
segment.sft python == c: byte-identical
segment.sft python == cffi: byte-identical
segment.sft python == cython: byte-identical
```

四种分词器各建一个完整索引，三个原生版本的 `segment.sft`（2880196 字节）和 Python 版 `cmp` 无差别。这比词元流相等更强：词元流相等只说明分词没变，`segment.sft` 相同还说明词典顺序、倒排表、位置、偏移编码、变长整数全部没变。

分词器在工作进程里的行为，我也试了：`--jobs 4` 配合三种并行模式（第 16 篇的 `process`、`thread`、`interp`）和三个原生分词器，共 9 次完整构建，每次都和 Python 版的 `segment.sft` 做 `cmp`：

```text
$ bash modes.sh   # 9 index builds, --jobs 4, cmp with the python one
c process: byte-identical
c thread: byte-identical
c interp: byte-identical
cffi process: byte-identical
cffi thread: byte-identical
cffi interp: rc=1
    ImportError: module _cffi_backend does not support loading in 
    subinterpreters
cython process: byte-identical
cython thread: byte-identical
cython interp: rc=1
    ImportError: module sift.ext._cytok does not support loading in 
    subinterpreters
```

九个组合里七个字节相同。`interp` 模式（每个线程一个子解释器，各有自己的 GIL）下，cffi 和 Cython 都导入失败：解释器说 `_cffi_backend` 和 `sift.ext._cytok` 不支持在子解释器里加载。ctypes 的 `_ctypes` 可以（这是我从“它能跑”看出来的，没有去读它的源码）。为什么前两个不行，我没有查：按 CPython 文档（`Doc/c-api/module.rst` 第 354 到 383 行），multi-phase 初始化的模块不写 `Py_mod_multiple_interpreters` 槽时默认是 `SUPPORTED`，所以它们要么用的是 single-phase 初始化，要么显式写了 `NOT_SUPPORTED`，两种我都没有核对。对照一下前面手写的 `_capi`：它显式声明了 `Py_MOD_PER_INTERPRETER_GIL_SUPPORTED`，也就是连各有各的 GIL 的子解释器也支持。这个限制我没有在 Sift 里处理，只在这里记录：`--tokenizer cffi|cython` 与 `--mode interp` 同时用，会得到上面这个 `ImportError`，而不是错误的索引。

## 测试怎么钉住“一样”

`tests/test_ext.py` 有 127 个用例（`--collect-only` 数出来的），分成几组：

- 同一批文本，三个原生实现与 Python 实现比较词元流：12 个手写的边缘文本（空串、`c++` 与 `c#`、`ﬁ` 与 `㎏` 这类 NFKC 会改变长度的字符、emoji、孤立代理、NUL 字节、CJK 范围的边界码点（`U+3400`、`U+4DBF`、`U+4DC0`、`U+9FFF`、`U+A000` 等）、一个 70000 个 `x` 加 70000 个 `中` 的长文本），所有 mini 测试夹具，以及（语料存在时）全部 123 个语料文件。
- 两个 hypothesis 属性：任意 Unicode 文本（含代理字符），和只用 `ab_9+#中文 \n\u3400é😀\ud800` 这个小字母表的“长得像词元”的文本。
- 四个实现的 `count_cjk` 与一个正则的结果比较。
- C 契约本身：容量不足、`n_out` 完整、无缓冲区只计数、`EINVAL`、非法 UTF-8。

契约测试里有一个我喜欢的小招数，在 `call` 辅助函数里（第 162 到 174 行）：

```python
def call(
    ctok: ModuleType, data: bytes, cap: int
) -> tuple[int, int, list[tuple[int, int]]]:
    """Call sift_tokenize with cap spans; return rc, n_out, spans."""
    lib = ctok._lib
    buf = (ctok.Span * (cap + 1))()
    # The span after the cap must stay as the canary.
    buf[cap].start = buf[cap].end = 12345
    n = ctypes.c_size_t(99)
    rc = lib.sift_tokenize(data, len(data), buf, cap, ctypes.byref(n))
    assert (buf[cap].start, buf[cap].end) == (12345, 12345)
    got = [(buf[i].start, buf[i].end) for i in range(min(cap, n.value))]
    return rc, n.value, got
```

它分配 `cap + 1` 个 span，在第 `cap` 个位置放一个“金丝雀”值 12345，调用后检查它没被动过。C 函数的约定是最多写 `cap` 个；如果实现里有一个差一错误，多写了一个，写到的正好是金丝雀，断言就会炸。这不用 ASan 就能抓到越界一格的写。

任意字节的属性（第 218 到 232 行）更严格：对 `st.binary(max_size=200)` 产生的任意字节串，每个 span 都必须满足 `0 <= start < end <= len(data)`、起点不降，并且 `data[start:end]` 必须能被 `decode("utf-8")`，还要匹配词元的正则。这条性质对输入是否合法 UTF-8 完全不作假设。

没有原生产物时测试怎么办？`tests/conftest.py` 里的 `native` 夹具（第 57 到 76 行）按名字导入模块：`ModuleNotFoundError` 且缺的恰好是这个模块，或者 `OSError` 说找不到文件，就 `pytest.skip("... run `make ext`")`；其他导入错误一律让测试失败，不当作“没建”。这个区分很重要：一个坏掉的 `.so`（符号缺失、架构不对）如果也被跳过，测试就成了摆设。

整个套件的结果是 `1209 passed, 1 xfailed, 1 warning`（58.86 秒），`ruff format --line-length 79 --check .` 说 `399 files already formatted`，`ruff check .` 通过。

## 量：C 到底快了多少

`lab/ch24/tokenizer_bench.py` 做三个测量，每个都是 7 次取中位数。第一个是给整个语料分词（NFKC 和 `casefold` 算在内，因为它们留在 Python 里，每一行都要付）：Python、ctypes、cffi、Cython 四行（C API 模块不分词，不在这张表里）。第二个是数整个语料里的 CJK 字符：五行都有。第三个是对 10 字节字符串 `'ab中cdefg'` 调 20 万次 `count_cjk`，看一次调用的开销，另外加一个什么都不做的 Python 函数当地板，和一个正则当参照。每张表的结果列是“所有文件的词元总数”和“CJK 字符总数”，脚本在表出来之前断言四行相等（859485 个词元，559079 个 CJK 字符）：不同实现的结果不一样，就没有资格比速度。

这台机器有快慢两个状态，所以我把脚本交替跑三次，每次前后各夹一次 `cpu_state.py`。六次读数（每次五个数）是 `115 116 118 119 118`、`112 115 115 115 115`；`116 116 116 116 116`、`114 114 114 114 114`；`115 117 115 116 116`、`114 115 115 115 115`，都在 110 到 120 毫秒之间。开头那个代码块是第一次的前 11 行。三次的中位数，括号里是三次各自的值：

| 整个语料分词，毫秒（含 `fold`） | 中位数 | 相对 Python | 三次 |
| --- | --- | --- | --- |
| Python | 664.2 | 1.00 倍 | 664.2、678.7、658.2 |
| ctypes | 727.6 | 0.91 倍 | 727.6、737.8、719.2 |
| cffi | 688.0 | 0.97 倍 | 688.0、697.6、680.6 |
| Cython | 342.0 | 1.94 倍 | 345.5、342.0、339.4 |
| 单独 `fold` | 99.2 | | 99.2、100.1、99.1 |

| 数整个语料的 CJK 字符，毫秒 | 中位数 | 相对 Python |
| --- | --- | --- |
| Python（正则） | 38.2 | 1.00 倍 |
| ctypes | 17.7 | 2.16 倍 |
| cffi | 17.8 | 2.15 倍 |
| Cython | 5.1 | 7.49 倍 |
| C API 模块 | 1.0 | 约 38 倍 |

先说第一张表，因为它和我开头的直觉相反。用 C 重写扫描，ctypes 的版本反而多花了 10% 的时间，cffi 多花了 4%。只有 Cython 比 Python 快，差不多一倍。每一行都带着同样的 99.2 毫秒 `fold`，所以如果只看分词本身（减掉 `fold`），Python 是 565 毫秒，Cython 是 243 毫秒，ctypes 是 628 毫秒。

### 时间花到哪儿去了

C 函数本身有多快？我拆开计时。这个脚本 (`/tmp/sift-scratch/ch24/stages.py`) 对语料里每个文件依次做每一步，丢掉结果，只留 `len`，这样和基准里的做法一致（我第一次把 123 个结果列表全部留在内存里，慢了 40%，我猜是 GC 在扫描 859485 个元组，所以改用 `len` 丢掉）：

```text
$ python3 /tmp/sift-scratch/ch24/stages.py
tokens: 859485 bytes: 4504242 chars: 3321017
files with len(data) == len(folded): 1 of 123
fold                          95.9 ms
encode                         3.0 ms
sift_tokenize alone           15.3 ms
ctok.spans                    82.0 ms
tokens_from_spans            556.9 ms
python iter_tokens (no fold)  600.0 ms
cython tokens (no fold)      253.9 ms
```

`sift_tokenize alone`：给定预先分配好的缓冲区，C 函数扫描整个语料只要 15.3 毫秒。这是 Python 那 565 毫秒的 2.7%。如果这个函数就是全部工作，我们会得到 37 倍的加速。但它不是。

ctypes 这一行 727.6 毫秒大致等于四项相加：`fold` 95.9、`encode` 3.0、`ctok.spans` 82.0、`tokens_from_spans` 556.9，共 737.8 毫秒，和整行的 727.6 差 1.4%，是不同次计时的噪声。`ctok.spans` 的 82.0 毫秒里，C 函数是 15.3，另外 67 毫秒是分配 `(Span * cap)()`、`byref`、`cast` 和把 170 多万个 `size_t` 变成 Python 整数列表。最大的是 `tokens_from_spans` 的 556.9 毫秒：它要为 859485 个词元各造一个 `Token`，外加字节到字符的映射。

这个数字有个下限。我写了一个草稿脚本，假设偏移是白送的（直接用 Python 自己的 `Token` 里的 `start` 和 `end`），只统计“从已知的字符区间造出 859485 个 `Token`”要多久：

```python
def build():
    for f, sp in zip(folded, spans):
        len([new(Token, (f[s:e], i, s, e)) for i, (s, e) in enumerate(sp)])


def build_tuples_only():
    for f, sp in zip(folded, spans):
        len([(f[s:e], i, s, e) for i, (s, e) in enumerate(sp)])
```

```text
Token objects from known char spans (Python):  315.6 ms
plain 4-tuples instead of Token:               124.9 ms
_cytok.tokens (scan + build):                  266.8 ms
```

纯 Python 里造这 859485 个 `Token`，哪怕偏移全是白送的，也要 315.6 毫秒，比整个 Cython 行去掉 `fold` 之后的部分（243 到 254 毫秒）还多。对照 124.9 毫秒：造同样数量的普通 4 元组。多出来的 190 毫秒来自 `tuple.__new__(Token, (...))` 这次调用：`Token` 是 `NamedTuple`，我在第 23 篇为了绕开生成的 `__new__` 才改用 `tuple.__new__`，即便如此它也不便宜。

所以，把扫描换成 C，在 Python 一侧还要用 Python 循环造对象的前提下，最多只能省下 565 减 316 约 250 毫秒，那是 44%。而 ctypes 的版本还要付 85 毫秒的传输和约 240 毫秒的映射循环（556.9 对 315.6），多付的比省的多。这就是 0.91 倍的由来：C 把最容易的那 15 毫秒变成了 0，却让剩下的路径更长。

Cython 为什么能到 243 毫秒？因为它的循环在 C 里，造 `Token` 时是在 C 里调用 `tuple.__new__`，没有 Python 字节码的循环开销、没有 `zip`、`enumerate`、没有分支判断；它还省掉了字节到字符的映射，因为它直接读 `str` 而不是 UTF-8。它把“扫描”和“造对象”两部分都放进了 C 里，而不是只放第一部分。

教训比“C 比 Python 快”更具体：这个循环里，真正的成本是产出 859485 个 Python 对象，扫描只占零头。要快，要么把造对象的循环一起搬进 C（Cython 的做法），要么改变接口，让下游吃数组而不是对象（我没有做，下面“什么时候该换”会再说）。

### 计数：不造对象的时候

第二张表量的是一个几乎不造对象的任务：数 CJK 字符，每个文件只返回一个整数。这时 C 终于显出本事：ctypes 和 cffi 都是 17.7 到 17.8 毫秒，比 Python 正则的 38.2 快 2.2 倍，Cython 5.1 毫秒（7.5 倍），C API 模块 1.0 毫秒（约 38 倍）。四个原生实现做的是同样的数数；差别在边界上的开销。ctypes 和 cffi 要先把整个文件 `encode` 成 UTF-8（拷贝一份），C 再逐字节解码；Cython 直接读 `str`，不拷贝不解码，但每个字符一次循环；C API 模块读 `str` 的内部存储，2 字节档的文本按 2 字节宽度的数组扫，没有解码，循环简单到编译器大概能向量化。“大概”是因为我没有看这个循环的汇编。我能说的只有数字：3321017 个字符用了约 1 毫秒，约 0.3 纳秒一个。

### 一次调用的价格

第三张表量的是一次调用的固定成本，用一个 10 字节的字符串，这时 C 做的活几乎为零，量出来的几乎全是过边界的价格：

| 10 字节字符串 `count_cjk`，纳秒 | 中位数 | 相对空函数 | 三次 |
| --- | --- | --- | --- |
| Python 空函数 | 33.7 | 1.00 倍 | 34.0、33.7、32.5 |
| Python 正则 | 491.4 | 14.6 倍 | 499.8、490.2、491.4 |
| ctypes | 701.7 | 20.8 倍 | 713.9、701.7、696.3 |
| cffi | 439.3 | 13.0 倍 | 444.2、435.6、439.3 |
| Cython | 47.7 | 1.42 倍 | 47.4、47.7、47.7 |
| C API 模块 | 40.8 | 1.21 倍 | 40.0、40.9、40.8 |

对短字符串，ctypes 的 702 纳秒比正则的 491 纳秒还慢，cffi 的 439 纳秒比正则略快，Cython 和 C API 模块都在空函数的 1.2 到 1.4 倍之内。用前面拆开的数字解释：ctypes 一次调用是 `encode` 104 加原始调用 456 加包装 155；cffi 是 104 加 169 加包装 175 左右；Cython 和 C API 模块没有 `encode`，也没有 `argtypes` 转换，调用本身就是一次 C 函数调用，加上一个 `PyLong` 的创建。

固定成本不是全部。字符串变长以后，每个字符的成本才是主要的。我又量了一遍，字符串从 10 个字符增长到 10 万个字符：

```text
$ python3 /tmp/sift-scratch/ch24/cross.py
  chars     regex    ctypes      cffi    cython      capi   (ns per call)
     10       478       714       448        47        39
    100      1857      1119       850       169        62
   1000     14839      5103      4788      1457       312
  10000    142471     43890     43730     13056      2726
 100000   1412783    521550    520097    129025     31561
```

读这张表有两种方式。纵向看一列，是每次调用的总成本随长度怎么增长：正则大约每个字符 14 纳秒，ctypes 和 cffi 约 5 纳秒（主要是 `encode` 和 C 里的 UTF-8 解码），Cython 约 1.3 纳秒，C API 模块约 0.3 纳秒。横向看一行，是同一长度下各自的价格：10 个字符时，正则 478、ctypes 714、cffi 448，原生的路并不比正则好；到了 100 个字符，ctypes 的 1119 已经比正则的 1857 低；到 1000 个字符，正则 14839 对 ctypes 5103，3 倍。

这就是一个很简单的成本模型：每次调用的时间约是 $t = t_{\text{call}} + n \cdot c$，$t_{\text{call}}$ 是过边界的固定价格，$c$ 是每个字符的价格，$n$ 是一次带过去的工作量。一条路的 $c$ 再低，只有 $n$ 大到让 $n \cdot (c_{\text{py}} - c_{\text{native}})$ 超过固定价格的差，才值得。用表里的数估算，ctypes 对正则的盈亏点在 30 到 40 个字符之间（这是我把 10 和 100 两行线性内插出来的，没有逐个长度去量）。Sift 里正好踩在“每次带的工作量太少”这一侧的，就是我开头那个分词：C 函数把 859485 个词元全扫完才 15.3 毫秒，平均每个词元不到 20 纳秒，而过边界、造对象的成本却是按词元计的。

### 回到 sift index

最后是端到端。`sift index --full` 在四种分词器下，hyperfine 各跑 5 次 (`-N --warmup 1 --runs 5`)，这一次我前后夹了 `cpu_state.py`：

```text
$ python3 /tmp/sift-scratch/cpu_state.py
110 112 115 114 114 ms
$ hyperfine -N --warmup 1 --runs 5 -n python ... -n c ... -n cffi ... \
      -n cython ... | grep -E 'Benchmark|Time|ran|times'
Benchmark 1: python
  Time (mean ± σ):      2.943 s ±  0.043 s    [User: 2.775 s, System: 0.124 s]
Benchmark 2: c
  Time (mean ± σ):      3.095 s ±  0.013 s    [User: 2.926 s, System: 0.133 s]
Benchmark 3: cffi
  Time (mean ± σ):      3.099 s ±  0.031 s    [User: 2.912 s, System: 0.132 s]
Benchmark 4: cython
  Time (mean ± σ):      2.712 s ±  0.019 s    [User: 2.538 s, System: 0.139 s]
Summary
  cython ran
    1.09 ± 0.02 times faster than python
    1.14 ± 0.01 times faster than c
    1.14 ± 0.01 times faster than cffi
$ python3 /tmp/sift-scratch/cpu_state.py
118 117 118 122 121 ms
```

`python` 2.943 秒，`c` (ctypes) 3.095 秒，`cffi` 3.099 秒，`cython` 2.712 秒。Cython 比 Python 快 1.09 倍，ctypes 和 cffi 比 Python 慢约 5%。`extra.sh` 里同一段还跑过另外两次，三次合起来：Python 2.94 到 3.05 秒，ctypes 3.10 到 3.15 秒，cffi 3.08 到 3.14 秒，Cython 2.71 到 2.73 秒。Cython 最快、Python 其次、ctypes 与 cffi 最慢，这个顺序每次都一样；ctypes 和 cffi 之间谁慢一点，三次里换过位置。这一次结束时的读数是 118 到 122，略高于 120，我不认为它改变了排序，但要说一声。

这个数字和上一节吻合一半。分词本身（含 `fold`）在 Cython 下省了 322 毫秒（664.2 减 342.0），占 `sift index --full` 的 11%，所以我预期 1.12 倍，量到 1.09 倍，差得不多。ctypes 的预期不吻合：分词基准说它比 Python 慢 63 毫秒，端到端预期 3.006 秒，实际是 3.095 秒，多出一倍多。我没有追这个差，推测与索引进程里同时存在的大量对象有关（建索引时倒排表在涨，GC 和内存分配的压力和单独跑分词不同），但这只是猜测。结论不受影响：不论从基准还是从端到端，ctypes 和 cffi 版本都没有带来加速。

一个具体的数字：Cython 把 `sift index --full` 从 2.94 秒降到 2.71 秒，省 0.23 秒，代价是一个构建步骤、一个 Cython 依赖、一份和 Python 语法差不多但不是 Python 的 `.pyx`，以及一个在子解释器里导不进去的模块。0.23 秒值不值，是个要回答的问题，下一节回答。

## 什么时候该换成原生代码

回头看这一篇的数字，我对“热点换成 C”这句话的版本是：先问每次过边界带多少活，再问造不造对象，最后才轮到语言。

先算账。Cython 把 `sift index --full` 从 2.94 秒降到 2.71 秒，省 0.23 秒。为此多出来的东西：184 行 C（还不算头文件）加 113 行 C API 模块加 112 行 `.pyx`；一个 `c/Makefile`，一个新的 `make ext` 目标，`make ci` 里多了一步；243 行测试，其中一部分专门检查 C 契约；一套 ASan 和 UBSan 的模糊测试；一个只在特定平台编得出来的产物（`.so` 的文件名里有 `cpython-314-x86_64-linux-gnu`，换一个 Python 小版本或一个操作系统就要重建）；以及一条“`--mode interp` 下导入失败”的限制。123 篇文章的搜索引擎不需要这 0.23 秒，所以这些代价在产品上是净亏损。这一章的价值是教程的价值：它让每一条路的成本都变得可量。

如果真的要换，我会按这个顺序想，越靠前越便宜：

- 算法：能不能不做这件事。第 23 篇里最大的发现是搜索慢在片段生成而不是打分，改法里没有一行 C。
- 已有的 C：标准库里的 `re`、`unicodedata`、`str.translate`、`bytes.find` 本来就是 C。正则那一行（38.2 毫秒数 CJK 字符）已经是个 C 实现，我们打败它的办法是绕开对象，而不是换语言。
- NumPy 或类似库：把循环变成对数组的整体操作，对象创建的成本摊到数组上（第 22 篇）。
- Cython：保持 Python 的语法和语义，只在热点上加类型；`cython -a` 的黄线告诉你剩下的开销在哪儿；调用开销很小（47.7 纳秒），而且能直接读 `str`。代价是多一个构建步骤，以及（这一篇量到的）一个没有类型的 Cython 比正则还慢 5 倍，所以“用了 Cython”不等于“快了”。
- 手写 C API：全部控制，包括释放 GIL 和直接读 `str` 的内部布局，所以数字最好（1.0 毫秒，40.8 纳秒），代价是引用计数和异常状态要自己维护，漏一次就是一百万次调用后的一百万个泄漏（上面 `_leaky` 的实验）。
- ctypes 和 cffi：它们的正业是包装别人写好的 C 库（libc、SQLite、一个闭源的 `.so`），而不是改写你自己的 Python 循环。这一篇里我用它们包自己的 C 代码，是为了让四条路能放在一张表里比，不是推荐这样用。

每条路的取舍，把这一篇量到的、跑到的放在一起：

| | 需要编译器 | 声明检查 | 10 字节一次调用 | 每字符 | 释放 GIL | 子解释器 |
| --- | --- | --- | --- | --- | --- | --- |
| ctypes | 否 | 无，错了会崩 | 702 纳秒 | 约 5 纳秒（含 `encode`） | 是（实测） | 可以（`--mode interp` 跑通） |
| cffi ABI 模式 | 否 | 无 | 439 纳秒 | 约 5 纳秒（含 `encode`） | 未量 | 不行（导入失败） |
| cffi API 模式 | 是 | C 编译器能抓的那一类 | 约 100 纳秒（原始调用） | 未量 | 未量 | 未量 |
| Cython | 是 | 类型在编译期检查 | 48 纳秒 | 约 1.3 纳秒 | 默认不释放 | 不行（导入失败） |
| C API | 是 | C 编译器 | 41 纳秒 | 约 0.3 纳秒 | 手动，我的函数长度达到 $2^{16}$ 才释放 | 声明了支持 |

“未量”就是没量，不是估计。

最后一个教训在接口上。这一篇的瓶颈是 859485 个 `Token` 对象，原因是接口约定“分词返回对象的列表”。如果下游愿意收一个整数数组（词元的起止偏移），一次 `array('Q')` 加缓冲区协议就够了，不需要造任何对象，C 的 15 毫秒会占主导。这需要改 `IndexWriter` 和片段生成，让它们按偏移工作而不是按对象，是个比换语言大得多的改动；我没有做，也没有量，所以它在这里只是一个设计方向，不是结论。

## 留下的缺口

- `--mode interp` 与 `--tokenizer cffi|cython` 同时用会得到 `ImportError`。我只确认了现象，没有去查是 single-phase 初始化还是显式声明了不支持，也没有在 Sift 里加一个更友好的报错。
- cffi 的 API 模式我只在 `cffi_demo.py` 里编了一个临时模块并量了原始调用（约 99 纳秒），没有接进 `sift index --tokenizer`，所以没有它在语料上的数字，表里对应的几格是“未量”。
- ASan 和 UBSan 只跑了 `sift_tok.c`。`sift_capi.c` 的检查是引用计数的实验和类型错误测试；Cython 生成的 `_cytok.c` 没有用 sanitizer 跑过；Python 扩展模块在 ASan 下需要预加载运行时，我没有做。
- 全部测量在一台 x86-64 Linux 机器上：可变参数调用在 arm64 的 macOS 上走另一套约定，我只确认了 `callproc.c` 里有对应的代码，没有在那里运行；Windows 上 `CDLL` 的搜索路径和 `.dll` 后缀我也没有试。
- 自由线程构建：我只编译并导入了 `_capi`（有无 `Py_mod_gil` 槽的差别已验证），没有用自由线程的解释器跑过 ctypes、cffi 或 Cython 版本，也没有做线程安全审计。
- ctypes 版本端到端比分词基准预测的多慢了一倍多（3.095 秒对预测的 3.006 秒），原因是猜测，没有验证。
- 上面那次 hyperfine 结束时的 `cpu_state.py` 是 118 到 122，略高于我定的 110 到 120。
- 仓库历史没有保留 hypothesis 当时找到的那个 bug 的旧版本，所以“偏移映射”一节里的 bug 是同一类的重现，不是那个 bug 本身。
- 没有做打包：`libsifttok.so`、`_capi`、`_cytok` 都靠 `make ext` 建在源码树里，装一个 wheel 之后它们不会自动出现。
- 我没有单独看 `_capi` 里循环的汇编，所以“编译器大概向量化了”只是一个推测。

## 本篇文件

这一章动了 29 个文件，`git diff --shortstat ch23 ch24` 给出 `29 files changed, 1886 insertions(+), 9 deletions(-)`。表里的 `+N -M` 来自 `git diff --numstat ch23 ch24`，命令是跑它对应的测试或脚本，结果是我在标签 `ch24` 上最后一次实际跑出来的（退出码都是 0；计时类的脚本，表里挑的是不带计时的那一行）；`/tmp/sift-scratch/ch24/` 里的草稿脚本不进仓库，不在表里。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`.gitignore`](https://github.com/bfmhno3/sift/blob/ch24/.gitignore) | `git check-ignore -v c/build/libsifttok.so` | `.gitignore:20:/c/build/ c/build/libsifttok.so`；`+1 -0` |
| [`Makefile`](https://github.com/bfmhno3/sift/blob/ch24/Makefile) | `make -n ext \| sed -n 1p` | `make -C c`；`+10 -4` |
| [`README.md`](https://github.com/bfmhno3/sift/blob/ch24/README.md) | `grep -c "make ext" README.md` | `4`；`+14 -1` |
| [`c/Makefile`](https://github.com/bfmhno3/sift/blob/ch24/c/Makefile) | `make -s -C c -q --no-print-directory; echo $?` | `0`；`+40 -0` |
| [`sift_capi.c`](https://github.com/bfmhno3/sift/blob/ch24/c/sift_capi.c) | `python3 lab/ch24/capi_refcount.py \| sed -n 1p` | `getrefcount before 2, after 1000000 calls 2`；`+113 -0` |
| [`sift_tok.c`](https://github.com/bfmhno3/sift/blob/ch24/c/sift_tok.c) | `python3 -m pytest tests/test_ext.py -k "invalid_utf8 or capacity or arbitrary or bad_arguments or no_room" \| tail -n 1` | `5 passed, 122 deselected in 0.87s`；`+184 -0` |
| [`sift_tok.h`](https://github.com/bfmhno3/sift/blob/ch24/c/sift_tok.h) | `grep -c "^int sift_tokenize\\|^size_t sift_count_cjk" c/sift_tok.h` | `2`；`+49 -0` |
| [`buffer_protocol.py`](https://github.com/bfmhno3/sift/blob/ch24/lab/ch24/buffer_protocol.py) | `python3 lab/ch24/buffer_protocol.py \| sed -n 1p` | `bytearray, memoryview share memory: True`；`+52 -0` |
| [`capi_refcount.py`](https://github.com/bfmhno3/sift/blob/ch24/lab/ch24/capi_refcount.py) | `python3 lab/ch24/capi_refcount.py \| sed -n 3p` | `refcount unchanged after TypeError: True`；`+42 -0` |
| [`cffi_demo.py`](https://github.com/bfmhno3/sift/blob/ch24/lab/ch24/cffi_demo.py) | `python3 lab/ch24/cffi_demo.py \| sed -n 3p` | `wrong cdef, same answer: 4`；`+71 -0` |
| [`ctypes_libc.py`](https://github.com/bfmhno3/sift/blob/ch24/lab/ch24/ctypes_libc.py) | `python3 lab/ch24/ctypes_libc.py \| sed -n 5p` | `address fits 32 bits: False`；`+52 -0` |
| [`ctypes_segfault_fail.py`](https://github.com/bfmhno3/sift/blob/ch24/lab/ch24/ctypes_segfault_fail.py) | `sed -n 2p out/ch24/segfault_exit.txt` | `subprocess.run sees: -11`；`+26 -0`；shell 里同一次崩溃的退出码是 139 |
| [`ctypes_struct.py`](https://github.com/bfmhno3/sift/blob/ch24/lab/ch24/ctypes_struct.py) | `python3 lab/ch24/ctypes_struct.py \| sed -n 6p` | `cap 2: rc -28 (-ENOSPC), n_out 4`；`+55 -0` |
| [`extra.sh`](https://github.com/bfmhno3/sift/blob/ch24/lab/ch24/extra.sh) | `bash lab/ch24/extra.sh > /dev/null; grep -c byte-identical out/ch24/index_tokenizers.txt` | `3`；`+132 -0`；整个脚本约 90 秒 |
| [`sanitize_fuzz.c`](https://github.com/bfmhno3/sift/blob/ch24/lab/ch24/sanitize_fuzz.c) | `tail -n 1 out/ch24/sanitize_fuzz.txt` | `200000 rounds, no violation`；`+89 -0` |
| [`tokenizer_bench.py`](https://github.com/bfmhno3/sift/blob/ch24/lab/ch24/tokenizer_bench.py) | `python3 lab/ch24/tokenizer_bench.py \| sed -n 2p` | `corpus: 123 files, 4614185 bytes, 7 runs, median`；`+163 -0` |
| [`analysis/__init__.py`](https://github.com/bfmhno3/sift/blob/ch24/src/sift/analysis/__init__.py) | `python3 -c "from sift.analysis import __all__ as a; print([n for n in a if 'Mixed' in n])"` | `['CMixedTokenizer', 'CffiMixedTokenizer', 'CythonMixedTokenizer', 'MixedTokenizer']`；`+6 -0` |
| [`tokenizers.py`](https://github.com/bfmhno3/sift/blob/ch24/src/sift/analysis/tokenizers.py) | `python3 -m pytest tests/test_ext.py -k analyzers_match \| tail -n 1` | `3 passed, 124 deselected in 0.78s`；`+39 -2` |
| [`cli.py`](https://github.com/bfmhno3/sift/blob/ch24/src/sift/cli.py) | `python3 -m pytest tests/test_cli.py -k index_tokenizer \| tail -n 1` | `6 passed, 160 deselected in 1.34s`；`+50 -2` |
| [`ext/__init__.py`](https://github.com/bfmhno3/sift/blob/ch24/src/sift/ext/__init__.py) | `python3 -m pytest tests/test_ext.py -k edge_texts \| tail -n 1` | `36 passed, 91 deselected in 1.15s`；`+82 -0` |
| [`_capi.pyi`](https://github.com/bfmhno3/sift/blob/ch24/src/sift/ext/_capi.pyi) | `pyright src/sift/ext/_capi.pyi \| tail -n 1` | `0 errors, 0 warnings, 0 informations`；`+1 -0` |
| [`_cytok.pyi`](https://github.com/bfmhno3/sift/blob/ch24/src/sift/ext/_cytok.pyi) | `pyright src/sift/ext/_cytok.pyi \| tail -n 1` | `0 errors, 0 warnings, 0 informations`；`+5 -0` |
| [`_cytok.pyx`](https://github.com/bfmhno3/sift/blob/ch24/src/sift/ext/_cytok.pyx) | `python3 -c "from sift.ext import _cytok; print(_cytok.tokens('c++ 搜索')[0])"` | `Token(text='c++', position=0, start=0, end=3)`；`+112 -0` |
| [`cffitok.py`](https://github.com/bfmhno3/sift/blob/ch24/src/sift/ext/cffitok.py) | `python3 -c "from sift.ext import cffitok; print(cffitok.count_cjk('搜索引擎 sift'))"` | `4`；`+93 -0` |
| [`ctok.py`](https://github.com/bfmhno3/sift/blob/ch24/src/sift/ext/ctok.py) | `python3 -c "from sift.ext import ctok; print(ctok.count_cjk('搜索引擎 sift'))"` | `4`；`+82 -0` |
| [`conftest.py`](https://github.com/bfmhno3/sift/blob/ch24/tests/conftest.py) | `python3 -m pytest tests/test_ext.py -k rejects_other_types \| tail -n 1` | `1 passed, 126 deselected in 0.77s`；`+25 -0` |
| [`test_cli.py`](https://github.com/bfmhno3/sift/blob/ch24/tests/test_cli.py) | `python3 -m pytest tests/test_cli.py -k index_tokenizer_gives \| tail -n 1` | `3 passed, 163 deselected in 1.26s`；`+44 -0` |
| [`test_ext.py`](https://github.com/bfmhno3/sift/blob/ch24/tests/test_ext.py) | `python3 -m pytest tests/test_ext.py \| tail -n 1` | `127 passed in 6.20s`；`+243 -0` |
| [`typings/cffi/__init__.pyi`](https://github.com/bfmhno3/sift/blob/ch24/typings/cffi/__init__.pyi) | `pyright src/sift/ext/cffitok.py \| tail -n 1` | `0 errors, 0 warnings, 0 informations`；`+11 -0` |

表里的 `python3 -m pytest` 实际都带着 `-p no:cacheprovider -o addopts=--doctest-modules`（`pyproject.toml` 里默认的 `-q` 会吞掉汇总行，我要看到数字）。整个测试套件是 `1209 passed, 1 xfailed, 1 warning in 58.86s`；`ruff format --line-length 79 --check .` 说 `399 files already formatted`，`ruff check .` 说 `All checks passed!`。C 一侧：`gcc -O2 -Wall -Wextra -Werror` 编 `sift_tok.c` 与 `sift_capi.c` 无警告，ASan 与 UBSan 下 200000 轮随机字节无违例。

## 练习

**1.** 把 cffi 的 API 模式接进 Sift。仿照 `cffi_demo.py` 的后半段，写一个 `sift.ext.cffiapi`，在 `c/Makefile` 里加一个目标把它编出来，再加 `--tokenizer cffi-api`。先写下预测：每次调用的固定开销大约省 70 纳秒（我量到的 169 对 99），那整个语料的分词时间会比 ABI 模式快多少？用 `stages.py` 里的拆分估一估，再用 `tokenizer_bench.py` 验证。我的预测是几乎没有变化，原因是 859485 次调用并不在这个层面上。

**2.** 改接口，不造对象。让 C 返回起止偏移，Python 一侧用 `array.array("Q")` 通过缓冲区协议拿到，再写一个只用偏移的消费者（比如统计词频的函数，用 `memoryview` 切片取词）。先用 `floor.py` 的 315.6 毫秒估一个上限，再量。你会发现必须回答“下游到底要不要 `Token` 对象”这个问题，那是 `IndexWriter` 的接口，不是 C 的接口。

**3.** 让 `_cytok` 释放 GIL。`count_cjk_utf8` 吃的是类型化 memoryview，可以在 `with nogil:` 里跑（`str` 的下标读取需要 GIL，所以要对字节而不是对 `str` 做）。改完后用 `gil.py` 的方式测 1 个线程和 4 个线程。预测：4 个线程是 1 个线程时间的多少倍？再解释为什么 `_capi` 的 4 线程比值是 1.04 而 ctypes 是 1.15。

**4.** 变异测试。删掉 `utf8_decode` 里的某一个 `rem >= 3` 检查，重新 `make ext`。先预测哪一个会先发现它：ASan 模糊测试、`test_arbitrary_bytes_give_whole_valid_tokens`、`test_invalid_utf8_is_skipped`，还是 hypothesis 的任意文本测试（提示：Python 的 `bytes` 对象末尾恰好有一个 `\0`）。把预测写下来，再逐个跑。这个实验告诉你每一层防线各自看不见什么。

## 下一篇

下一篇是《原生扩展（下）：用 PyO3 写 Rust 扩展》。这一篇留下的问题我想原样再问一遍：同一个扫描循环，换成 Rust 来写，经 PyO3 和 `maturin` 变成 Python 模块，内存安全由类型系统而不是 ASan 来守，引用计数和 GIL 由 `Bound` 和 `Python<'py>` 这样的类型来表达，而不是 `Py_INCREF` 和宏。边界的价格会变吗？859485 个 `Token` 对象的账呢？我会像这一篇一样，先跑再量，不预设答案。

