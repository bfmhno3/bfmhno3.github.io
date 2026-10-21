---
title: "文本：str、bytes、Unicode 与正则"
commentId: "post:python-by-sift-02-text-and-unicode"
published: "2026-10-22 02:00:00 +08:00"
description: "用 Sift 重学 Python 第 2 篇：我在 Python 3.14.7 里把朴素搜索的子串计数换成了 NFKC、casefold 加正则的分词器，123 篇文章（3,320,875 个字符，4,614,185 字节）被切成 812,338 个词元，代价是一次搜索从 17.4 ms（第 1 篇报的是 20.0 ms，我今天并排重量）涨到 575.7 ms，我把这 575.7 ms 一段一段量了出来。"
category: Tutorial
tags:
  - Python
  - Sift
  - Unicode
  - 正则表达式
  - 字符串
series: "用 Sift 重学 Python"
seriesOrder: 2
draft: false
comment: true
slug: python-by-sift-02-text-and-unicode
---

同一条命令 `python3 -m sift kalman`，上一篇报的是 20.0 ms，我今天把 `ch01` 导出来并排重量是 17.4 ms，这一篇 575.7 ms，慢了 33 倍；命中数也变了，第一名从 23 掉到了 7。我只改了一件事：不再数子串，而是先把每篇文章切成词，再比较词：

```text
$ python3 -m sift kalman
     7  corpus/posts/kalman-filter-02-multivariate.md
     6  corpus/posts/kalman-filter-01-one-dimension.md
     6  corpus/posts/kalman-filter-07-ukf.md
     5  corpus/posts/kalman-filter-06-eskf.md
     5  corpus/posts/kalman-filter-08-porting.md
     1  corpus/posts/pid-control-09-lqr.md
     1  corpus/posts/pid-control-10-embedded.md
     1  corpus/posts/typst-by-xuan-15-wasm-plugin.md
searched 123 files in 575.7 ms
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch02`：新增 `src/sift/markdown.py`（去掉 Markdown 标记，之后基本不再变）和 `src/sift/analysis/tokenize.py`（分词器：西文按词，中文按二元组，分词规则之后不变，但函数本身会被重新组织成迭代器和可插拔的分析器），`src/sift/__main__.py` 改成按词元精确匹配（之后会拆出索引，继续变）。`make ch02` 通过，`lab/ch02` 下 12 个 Python 实验按预期退出。
> 涉及的 Python 特性：`str` 与码点、`bytes`/`bytearray`/`memoryview`、编码与错误处理器、`unicodedata`、NFC/NFD/NFKC/NFKD 与 `casefold`、切片、常用字符串方法、格式化迷你语言、t-string（PEP 750）、`str.join` 与 `+=`、`re` 全套、`textwrap` 与 `string`。
> 前置：[第 1 篇](/posts/python-by-sift-01-first-search/)，需要会进 `nix develop`、会跑 `python3 -m sift`。

## 两个数字，一个原因

第 1 篇结尾我留了一个没解释的数字：语料 4,614,185 字节，却只有 3,320,875 个字符。现在可以让程序自己说了：

```text
$ python3 lab/ch02/tokenize_corpus.py | sed -n 1,3p
files: 123
characters: 3320875, bytes: 4614185, bytes/char: 1.389
tokens: 812338, distinct: 81192
```

平均每个字符 1.389 个字节。差出来的 1,293,310 字节是中文：UTF-8 里一个汉字占 3 字节，一个英文字母占 1 字节。搜索引擎要在这堆字节里找到“所有权”，就得先回答一个问题，这个问题听起来很蠢：一个字符到底是什么？

上面 575.7 ms 和 7 这两个数字，都是从这个问题里长出来的：要知道“所有权”是 3 个字符还是 9 个字节，要让 `Rust` 和 `rust` 匹配，要让全角的 `Ｒｕｓｔ` 也匹配。每一件都有代价，575.7 ms 就是账单。

先说环境，后面所有输出都在这套环境里跑出来：

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ git describe --tags
ch02
```

CPU 是 AMD Ryzen 7 PRO 6850U，内存 30 GiB，和第 1 篇一样。命令都在 `nix develop` 里，仓库在标签 `ch02`。计时用 `time.perf_counter`、`timeit` 和 `hyperfine`；用了最小值或平均值的地方，我会说明。

一次性的小脚本我放在 `/tmp/scratch/`，不进仓库，正文里会把源码贴全，你照抄就能复现。

## `str` 是码点的序列

### 码点、UTF-8、UTF-16

`lab/ch02/code_points.py` 从最小的问题开始：

```python
    # ...
    s = "所有权"
    print(f"{s!r}: len(s) = {len(s)}, bytes = {len(s.encode())}")
    for ch in s:
        print(f"  {ch} U+{ord(ch):04X} {unicodedata.name(ch)}")
    print(chr(0x6240) + chr(0x6709) + chr(0x6743))
    print("\N{CJK UNIFIED IDEOGRAPH-6240}", "\N{GREEK SMALL LETTER ALPHA}")
    print("\N{SNOWMAN}", "\u2603", "\U0001f600")
    # ...
```

```text
$ python3 lab/ch02/code_points.py
'所有权': len(s) = 3, bytes = 9
  所 U+6240 CJK UNIFIED IDEOGRAPH-6240
  有 U+6709 CJK UNIFIED IDEOGRAPH-6709
  权 U+6743 CJK UNIFIED IDEOGRAPH-6743
所有权
所 α
☃ ☃ 😀
'a': len=1 utf-8=1 utf-16=2
'é': len=1 utf-8=2 utf-16=2
'所': len=1 utf-8=3 utf-16=2
'😀': len=1 utf-8=4 utf-16=4
1 2 False
Ll Lo
Nd Po
```

`len("所有权")` 是 3，`len("所有权".encode())` 是 9。`str` 的长度数的是**码点**（code point）：Unicode 给每个字符分配的一个整数，写成 `U+6240` 这样。`ord` 把字符变成码点，`chr` 反过来，`"\N{...}"` 按 Unicode 官方名字写字符，`unicodedata.name` 反查名字。三个汉字是三个连续的码点，名字里没有“所”“有”“权”，只有码点十六进制：CJK 统一表意文字没有逐个起名。

码点不是字节。码点要变成字节才能存盘和传输，这一步叫编码，同一个码点在不同编码里字节数不同。后四行把 4 个字符各编成 UTF-8 和 UTF-16：

| 字符 | `len` | UTF-8 字节数 | UTF-16 字节数 |
| --- | --- | --- | --- |
| `a` | 1 | 1 | 2 |
| `é` | 1 | 2 | 2 |
| `所` | 1 | 3 | 2 |
| `😀` | 1 | 4 | 4 |

UTF-8 是变长的：ASCII 一个字节，越“远”的字符越长，所以我们的语料里英文占 1 字节、汉字占 3 字节，平均下来才是 1.389。UTF-16 对汉字更省（2 字节），但 `😀` 超出了 16 位，要用两个 16 位单元拼出来（代理对）。上表 UTF-16 一列是用 `utf-16-le` 量的（不带 `utf-16` 会加的 2 字节 BOM，后面会看到），`😀` 的 4 字节 = 2 个 16 位单元。

顺带一个别的语言的对照。同样三个汉字，我用 Rust（`rustc 1.97.1`，edition 2024）量了一次，源码在 `/tmp/scratch/utf8.rs`，就这几行：

```rust
fn main() {
    let s = "所有权";
    println!("{} {}", s.len(), s.chars().count());
    println!("{}", &s[0..3]);
    println!("{}", &s[0..2]);
}
```

```text
$ rustc --edition 2024 -o /tmp/scratch/utf8 /tmp/scratch/utf8.rs && /tmp/scratch/utf8
9 3
所

thread 'main' (23983) panicked at /tmp/scratch/utf8.rs:5:22:
end byte index 2 is not a char boundary; it is inside '所' (bytes 0..3 of string)
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
```

Rust 的 `String` 存的就是 UTF-8 字节，`len()` 给字节数 9，按字节下标切到汉字中间会 panic（这个故事在 [Pebble 第 2 篇](/posts/rust-by-pebble-02-ownership/)里讲过）。Python 的 `len` 数码点，`😀` 是 1，三个汉字是 3，`s[0:2]` 永远是整数个码点，不会切坏。代价在下一节。

### 码点还不是“用户看到的字符”

`é` 有两种写法：一个码点 U+00E9，或者 `e` 加一个组合重音符 U+0301。屏幕上长得一样，Python 看到的是两个不同的字符串：

```python
    # ...
    composed = "é"
    decomposed = "e\u0301"
    print(len(composed), len(decomposed), composed == decomposed)
    # ...
```

```text
1 2 False
```

长度 1 和 2，`==` 为 `False`。更极端的是国旗，`slicing.py` 末尾的 `🇨🇳` 是两个“区域指示符”码点拼出来的：

```python
    # ...
    flag = "\U0001f1e8\U0001f1f3"
    print(len(flag), flag)
    # ...
```

```text
2 🇨🇳
```

一个人眼里的字符，两个码点。Unicode 把“人眼里的一个字符”叫字素簇（grapheme cluster），标准库里没有按字素簇切分的工具，连正则里的 `\X` 都不认：

```text
$ python3 -c 'import re; re.compile(r"\X")' 2>&1 | tail -1
re.PatternError: bad escape \X at position 0
```

所以“字符数”在 Python 里永远是“码点数”。对搜索引擎这够了，因为我们不展示字符，只比较；但你以后要在终端里对齐表格或者截断显示文本，就会撞上这个坑，本篇后面的 `textwrap` 一节会演示一次。

`unicodedata.category` 给每个码点一个两字母的类别，`L` 开头是字母，`N` 数字，`P` 标点。`code_points.py` 的最后两行：

```python
    # ...
    print(unicodedata.category("a"), unicodedata.category("所"))
    print(unicodedata.category("１"), unicodedata.category("，"))
    # ...
```

```text
Ll Lo
Nd Po
```

`a` 是 `Ll`（小写字母），`所` 是 `Lo`（其他字母，汉字都在这类），全角的 `１` 是 `Nd`（十进制数字），`，` 是 `Po`（其他标点）。后面写分词器要决定“什么算词的一部分”，这个类别表是备选的依据之一；我最后没有用它，原因到分词器那一节说。

### `str` 在内存里长什么样

既然 `str` 是码点序列，`s[i]` 就应该是 $O(1)$ 的：直接按下标取第 `i` 个码点。要做到这一点，每个码点必须占一样宽。CPython 的做法（PEP 393）是**按字符串里最宽的那个码点选宽度**：全是 Latin-1 以内的占 1 字节一个，最大码点不超过 U+FFFF 的占 2 字节，更大的占 4 字节。我量一下：

```python
"""How big is a str in memory? PEP 393 picks 1, 2 or 4 bytes per char."""

import sys
from pathlib import Path

for label, ch in (("a", "a"), ("e-acute", "é"), ("所", "所"), ("emoji", "😀")):
    print(
        f"{label:<8} x100 {sys.getsizeof(ch * 100):>4}  "
        f"x1000 {sys.getsizeof(ch * 1000):>5}"
    )

texts = [
    p.read_text(encoding="utf-8")
    for p in sorted(Path("corpus/posts").glob("*.md"))
]
chars = sum(map(len, texts))
nbytes = sum(len(t.encode("utf-8")) for t in texts)
in_mem = sum(sys.getsizeof(t) for t in texts)
print(f"chars {chars}, utf-8 bytes {nbytes}, in-memory str bytes {in_mem}")
widths = {1: 0, 2: 0, 4: 0}
for t in texts:
    widest = ord(max(t))
    widths[1 if widest < 256 else 2 if widest < 65536 else 4] += 1
print("files by storage width (bytes/char):", widths)
```

```text
a        x100  141  x1000  1041
e-acute  x100  157  x1000  1057
所        x100  258  x1000  2058
emoji    x100  460  x1000  4060
```

整理成公式，头部 40 字节（纯 ASCII）或 56 字节（其他），加上 $(n+1) \times$ 宽度（`+1` 是末尾的 NUL）：`"a" * 100` 是 $40 + 101 = 141$，`"é" * 100` 是 $56 + 101 = 157$，`"所" * 100` 是 $56 + 202 = 258$，`"😀" * 100` 是 $56 + 404 = 460$，四行都对得上。

最有意思的是“最宽的那个码点”决定整串。往 1000 个 `a` 里塞一个码点：

```text
$ python3 -c 'import sys; a = "a" * 1000; print(sys.getsizeof(a), sys.getsizeof(a + "所"), sys.getsizeof(a + "😀"))'
1041 2060 4064
```

1041 字节变成 2060（加一个 `所`）和 4064（加一个 `😀`）。一个字符，让整个字符串膨胀到 2 倍或 4 倍。

这在我们的语料上不是假想。123 篇文章里：

```text
chars 3320875, utf-8 bytes 4614185, in-memory str bytes 7071249
files by storage width (bytes/char): {1: 1, 2: 112, 4: 10}
```

3,320,875 个字符，UTF-8 文件 4,614,185 字节，读进内存变成 `str` 却是 7,071,249 字节，是文件的 1.53 倍。123 篇里 1 篇存成 1 字节宽，112 篇是 2 字节宽，还有 10 篇是 4 字节宽。为什么有 10 篇是 4 字节宽？我数了一下超出 U+FFFF 的字符：

```text
$ python3 -c 'from collections import Counter; from pathlib import Path; c = Counter(ch for p in Path("corpus/posts").glob("*.md") for ch in p.read_text("utf-8") if ord(ch) > 0xFFFF); print(c.total(), c.most_common(6))'
62 [('🦀', 7), ('𝑖', 6), ('𝑛', 6), ('🔧', 5), ('🖼', 4), ('📑', 3)]
```

整个语料只有 62 个这样的字符：Rust 吉祥物 `🦀`、数学斜体的 `𝑖` 和 `𝑛`（我猜是写公式时从别处粘来的），再加几个 emoji 字符。62 个字符让 10 篇文章的内存大约翻了一倍。UTF-8 版本的 Rust `String` 不会有这个现象，但它也不能 $O(1)$ 地按码点下标。我觉得这是个公平的交换，只是第一次知道的时候有点好笑。

### 不可变与驻留

`str` 不可变。`slicing.py` 试了一次赋值：

```python
    # ...
    try:
        s[0] = "J"  # type: ignore[index]
    except TypeError as exc:
        print("TypeError:", exc)
    t = "J" + s[1:]
    print(t, s)
    # ...
```

```text
TypeError: 'str' object does not support item assignment
Jython 与 Unicode Python 与 Unicode
```

`TypeError: 'str' object does not support item assignment`，要“改”只能造一个新的：`"J" + s[1:]`，原来的 `s` 不动。不可变换来三样东西：可以做字典的键（第 3 篇），可以在多处共享而不用担心被改，哈希值可以缓存在对象里。第三样后面会救我们一命，也会坑我们一次，先记着。

共享的一个极端形式是**驻留**（interning）：解释器保证某些内容相同的字符串只存一份。`str_methods.py` 里：

```python
    # ...
    a = "".join(["sif", "t"])
    b = "".join(["sif", "t"])
    print(a == b, a is b, sys.intern(a) is sys.intern(b))
    c, d = "sift", "sift"  # 同一个编译单元里的字面量被驻留
    print(c is d)
    # ...
```

```text
True False True
True
```

运行时拼出来的两个 `"sift"`，`==` 为真，`is` 为假，是两个对象；`sys.intern` 把它们归并成同一个。同一段代码里的两个字面量 `"sift"`，`is` 是真，因为这种只含字母数字下划线的字符串在编译时就被驻留了，我用 `sys._is_interned`（带下划线，调试用）验证：

```text
$ python3 -c 'import sys; print(sys._is_interned("sift"), sys._is_interned("".join(["sif", "t"])))'
True False
```

驻留是实现细节，不能当作语言保证。判断字符串相等永远用 `==`，`is` 留给 `None`。第 1 篇讲过，两个整数相同也不保证是同一个对象，字符串同理。

## 字节与编码

`str` 是意思，`bytes` 是纸面。同一份稿子可以排成宋体，也可以排成楷体，纸面不同，稿子没变；拿到一叠纸却不知道字体，就只能猜。编码（encode）是排版，解码（decode）是认字，Python 3 把这两个动作分开成了两个类型，所以 `str` 和 `bytes` 之间不会悄悄地互相转换。

### `encode` 与 `decode`

`lab/ch02/encode_decode.py` 把同一个 `"所有权"` 编成五种编码，每一种都解回去断言相等：

```python
    # ...
    s = "所有权"
    for codec in ("utf-8", "utf-16", "utf-16-le", "gbk", "utf-32-le"):
        data = s.encode(codec)
        print(f"{codec:<10} {len(data):>2} {data.hex(' ')}")
        assert data.decode(codec) == s
    # ...
```

```text
utf-8       9 e6 89 80 e6 9c 89 e6 9d 83
utf-16      8 ff fe 40 62 09 67 43 67
utf-16-le   6 40 62 09 67 43 67
gbk         6 cb f9 d3 d0 c8 a8
utf-32-le  12 40 62 00 00 09 67 00 00 43 67 00 00
```

- UTF-8 是 9 字节。`所` 的码点 U+6240 是二进制 `0110 0010 0100 0000`，UTF-8 把它切成 4 位、6 位、6 位，前面分别垫上 `1110`、`10`、`10`，得到 `1110 0110`、`1000 1001`、`1000 0000`，也就是 `e6 89 80`。第一个字节的高位 `1110` 说“我后面还跟两个字节”，后面的字节高位都是 `10`。这个设计让你从任意一个字节开始，最多往回看三个字节就能找到字符的起点（续字节永远是 `10xxxxxx`，一个字符最多 3 个续字节）。
- `utf-16` 是 8 字节：开头 `ff fe` 是字节序标记（BOM），告诉读的人后面是小端序（低字节在前）；`utf-16-le` 明说小端，就没有 BOM，6 字节。
- GBK 是 6 字节，每个汉字 2 个，比 UTF-8 省，但它的字节和 UTF-8 完全对不上，下面马上会因此出事。
- `utf-32-le` 12 字节，每个码点固定 4 字节，和 Python 内部 4 字节宽的 `str` 是同一个思路。

### 错误处理器

编码失败，或者解码遇到非法字节怎么办，由 `errors` 参数决定，默认是 `"strict"`，也就是抛异常。其余的处理器各有用途，`encode_decode.py` 把它们都跑了一遍：

```python
    # ...
    text = "café 所"
    for errors in ("ignore", "replace", "backslashreplace"):
        print(errors, text.encode("ascii", errors))
    print("xmlcharrefreplace", text.encode("ascii", "xmlcharrefreplace"))
    print("namereplace", text.encode("ascii", "namereplace"))
    bad = b"abc\xff\xfedef"
    print("replace", bad.decode("utf-8", errors="replace"))
    print("ignore", bad.decode("utf-8", errors="ignore"))
    escaped = bad.decode("utf-8", errors="surrogateescape")
    print("surrogateescape", ascii(escaped))
    print(escaped.encode("utf-8", errors="surrogateescape") == bad)
    print("bom", "x".encode("utf-8-sig"), b"\xef\xbb\xbfx".decode("utf-8-sig"))
    # ...
```

```text
ignore b'caf '
replace b'caf? ?'
backslashreplace b'caf\\xe9 \\u6240'
xmlcharrefreplace b'caf&#233; &#25152;'
namereplace b'caf\\N{LATIN SMALL LETTER E WITH ACUTE} \\N{CJK UNIFIED IDEOGRAPH-6240}'
replace abc��def
ignore abcdef
surrogateescape 'abc\udcff\udcfedef'
True
bom b'\xef\xbb\xbfx' x
```

前五行是把 `"café 所"` 编成 ASCII，ASCII 装不下 `é` 和 `所`：`ignore` 直接丢掉，`replace` 换成 `?`，`backslashreplace` 写成 Python 转义，`xmlcharrefreplace` 写成 HTML 数字实体，`namereplace` 写成 `\N{...}` 官方名字。后四行是解码：`replace` 把非法字节换成 U+FFFD（那个黑色菱形里的问号），`ignore` 直接跳过。

最后一个 `surrogateescape` 值得单独说。它把每个解不出来的字节 `0xNN` 映射成一个落在 U+DC80 到 U+DCFF 的“孤立代理码点”，解码永远不报错，再用同一个处理器编码，字节**原样**还原（上面倒数第二行的 `True`）。Python 拿它处理文件名：Linux 的文件名是任意字节，不保证是合法的 UTF-8，我造一个名字里带 `0xff` 的文件看看：

```text
$ python3 -c 'import os, tempfile; d = tempfile.mkdtemp(); open(os.path.join(os.fsencode(d), b"a\xffb.txt"), "w").close(); name = os.listdir(d)[0]; print(ascii(name), os.fsencode(name))'
'a\udcffb.txt' b'a\xffb.txt'
```

`os.listdir` 返回的名字里，`0xff` 变成了 `\udcff`，`os.fsencode` 又把它还原成 `\xff`，所以你读到的每一个文件名都能原样传回给系统。`bom` 一行是 `utf-8-sig`：写的时候在前面加 `ef bb bf`，读的时候把它去掉。如果你用普通的 `utf-8` 去读带 BOM 的文件，开头会多一个看不见的 U+FEFF：

```text
$ python3 -c 'print(repr(b"\xef\xbb\xbfx".decode("utf-8")))'
'\ufeffx'
```


### 解错了会怎样

`decode_fail.py` 用一个最常见的事故：中文 Windows 上的 GBK 文件，被当成 UTF-8 读：

```python
    # ...
    data = "所有权".encode("gbk")
    print(data.hex(" "))
    # error: UnicodeDecodeError, the GBK bytes are not valid UTF-8
    print(data.decode("utf-8"))
    # ...
```

```text
$ python3 lab/ch02/decode_fail.py 2>&1; echo "exit $?"
cb f9 d3 d0 c8 a8
Traceback (most recent call last):
  File "/home/bfmhno3/Projects/sift/lab/ch02/decode_fail.py", line 13, in <module>
    main()
    ~~~~^^
  File "/home/bfmhno3/Projects/sift/lab/ch02/decode_fail.py", line 9, in main
    print(data.decode("utf-8"))
          ~~~~~~~~~~~^^^^^^^^^
UnicodeDecodeError: 'utf-8' codec can't decode byte 0xcb in position 0: invalid continuation byte
exit 1
```

报错说“字节 `0xcb` 在位置 0，无效的续字节”。这句话有一个小陷阱：`0xcb` 本身是合法的 UTF-8 起始字节（`110xxxxx`，后面应该跟一个续字节），真正不合法的是它**后面**的 `0xf9`，不是 `10xxxxxx`。报告的位置是这个字符的开头，不是出错的那个字节。

报错还算好的结局。更糟的是**不报错**的解码，以及不同的错法报不同的原因。我写了一个一次性脚本把这几种都试一遍：

```python
"""Wrong codec, no error: mojibake, and how to undo it."""

s = "所有权"
utf8 = s.encode("utf-8")
gbk = s.encode("gbk")

wrong = utf8.decode("gbk", errors="replace")
print(wrong, len(wrong))
print(ascii(utf8.decode("latin-1")))
print(utf8.decode("latin-1").encode("latin-1").decode("utf-8"))
print(gbk.decode("gbk"), gbk.decode("gb18030"))
for data in (b"\xe6\x89", b"\xe6\x89\x80\xe6", b"\xe6\x41\x80"):
    try:
        data.decode("utf-8")
    except UnicodeDecodeError as exc:
        print(exc.reason, exc.start, exc.end)
```

```text
$ python3 /tmp/scratch/mojibake.py
鎵�鏈夋潈 5
'\xe6\x89\x80\xe6\x9c\x89\xe6\x9d\x83'
所有权
所有权 所有权
unexpected end of data 0 2
unexpected end of data 3 4
invalid continuation byte 0 1
```

前三行：把 UTF-8 的 `所有权` 当 GBK 读，得到 5 个乱码字符（这个现象有个日语名字，mojibake），第 2 个字符 `�` 是因为 `0x80` 在 GBK 里不是合法字节，被 `replace` 换成了 U+FFFD，这个信息已经永久丢了。反过来 `latin-1` 是个特例：它把 256 个字节值一一映射到 256 个码点，所以**永远解得出来**（第 2 行，九个字节变成九个码点），解出来的东西再用 `latin-1` 编回去，字节完全还原，最后一步 `.decode("utf-8")` 就得到正确的文字（第 3 行）。很多“修乱码”的技巧都是这么回事：先找到当初错误解码用的是哪个编码，再倒着做一遍。

后三行是同一个异常对象上的 `reason`、`start`、`end`：`e6 89` 是被截断的三字节序列，`e6 89 80 e6` 是第二个字符被截断，`e6 41 80` 的起始字节后面跟了个 `0x41`（`A`），不是续字节。文件被截断时报的是 `unexpected end of data`，和乱码的 `invalid continuation byte` 不是一回事。

第 4 行是 `gbk` 和 `gb18030` 解同一串字节，结果相同。`gb18030` 是 GBK 的超集，覆盖全部 Unicode；GBK 没有 emoji，编码 `😀` 会失败，`gb18030` 可以：

```text
$ python3 -c 'print("😀".encode("gbk"))' 2>&1 | tail -2
UnicodeEncodeError: 'gbk' codec can't encode character '\U0001f600' in position 0: illegal multibyte sequence
encoding with 'gbk' codec failed
$ python3 -c 'print("😀".encode("gb18030").hex())'
9439fc36
```

两条经验：永远显式写 `encoding="utf-8"`（第 1 篇的 `read_text(encoding="utf-8")` 就是这个原因）；碰到未知来源的字节，不要先用 `latin-1` 读一遍来“检查”，它什么都不会告诉你。

### `bytes`、`bytearray` 与 `memoryview`

`bytes` 和 `str` 长得像，区别在于：下标取出来的是**整数**（0 到 255），不是长度为 1 的 `bytes`；字面量要加 `b` 前缀，里面只能是 ASCII。`bytes_views.py` 把这些都过一遍：

```python
    # ...
    b = "所有权".encode()
    print(b, b[0], b[:3], b[:3].decode(), list(b[:3]))
    print(bytes([104, 105]), bytes(3), b"ab" * 2, b.hex())
    ba = bytearray(b"hello")
    ba[0] = ord("j")
    ba.extend(b"!!")
    print(ba, bytes(ba))
    try:
        b[0] = 1  # type: ignore[index]
    except TypeError as exc:
        print("TypeError:", exc)
    # ...
```

```text
b'\xe6\x89\x80\xe6\x9c\x89\xe6\x9d\x83' 230 b'\xe6\x89\x80' 所 [230, 137, 128]
b'hi' b'\x00\x00\x00' b'abab' e68980e69c89e69d83
bytearray(b'jello!!') b'jello!!'
TypeError: 'bytes' object does not support item assignment
```

`b[0]` 是 230（`0xe6`）。`b[:3]` 是 `bytes`，`.decode()` 才变回 `所`。`bytes(3)` 是三个零字节，`bytes([104, 105])` 是 `b'hi'`。`bytearray` 是可变版本：改一个字节，`extend` 追加，`bytes(ba)` 冻结成不可变的拷贝。试图给 `bytes` 赋值，和 `str` 一样是 `TypeError`。

`bytes` 一个关键的代价：切片是**拷贝**。切 1 MiB 的 `bytes` 的前 `n - 1` 个字节，要复制 1 MiB。`memoryview` 是零拷贝的视图，切片只是调整了起点和长度：

```python
    # ...
    data = bytes(range(256)) * 4096
    view = memoryview(data)
    part = view[1000:2000]
    print(len(data), part.nbytes, part.obj is data, part[0], part[-1])
    copy = data[1000:2000]
    print(copy is data, type(copy).__name__, type(part).__name__)
    buf = bytearray(b"abcdef")
    mv = memoryview(buf)
    mv[1:3] = b"XY"
    print(buf)
    mv.release()
    # ...
```

```text
1048576 1000 True 232 207
False bytes memoryview
bytearray(b'aXYdef')
```

`part.obj is data` 为真：视图背后还是同一块内存。`data[1000:2000]` 是一个新的 `bytes`（`copy is data` 为假），`part` 的类型是 `memoryview`。通过 `memoryview` 给 `bytearray` 赋值会直接改底层缓冲区，所以 `buf` 变成了 `aXYdef`。计时放在最后：

```python
    # ...
    n = 2000
    start = time.perf_counter_ns()
    for _ in range(n):
        _ = data[:-1]
    t_copy = time.perf_counter_ns() - start
    start = time.perf_counter_ns()
    for _ in range(n):
        _ = view[:-1]
    t_view = time.perf_counter_ns() - start
    print(f"slice {len(data)} bytes x{n}: copy {t_copy / 1e6:.2f} ms,")
    print(f"  memoryview {t_view / 1e6:.2f} ms, ratio {t_copy / t_view:.0f}")
    # ...
```

```text
slice 1048576 bytes x2000: copy 41.02 ms,
  memoryview 0.15 ms, ratio 266
```

对 1 MiB 的数据切 2000 次，拷贝 41.02 ms，视图 0.15 ms，差了 266 倍；换算一下是每次 20.5 µs 对 75 ns。读大文件、处理网络包、解析二进制格式时，切来切去却不想复制，这是标准解法。后面做二进制索引文件（第 12 篇）的时候会再回到 `memoryview`。

## 归一化与大小写折叠

### 同一个字符的多种写法

回到 `é`。Unicode 允许“预组合”和“分解”两种写法，所以字符串比较前需要把它们变成同一种形式，这叫归一化（normalization）。`unicodedata.normalize` 支持四种形式，`normalize.py` 在几个典型输入上各跑一遍：

```python
def show(label: str, text: str) -> None:
    """Print text with its code points."""
    points = " ".join(f"U+{ord(c):04X}" for c in text)
    print(f"{label:<6} {text!r:<8} {points}")


def main() -> None:
    """Compare NFC, NFD, NFKC and NFKD on tricky inputs."""
    nfc = "\u00e9"
    nfd = "e\u0301"
    print(nfc == nfd, unicodedata.normalize("NFC", nfd) == nfc)
    for form in ("NFC", "NFD", "NFKC", "NFKD"):
        show(form, unicodedata.normalize(form, "\ufb01"))
    for form in ("NFC", "NFKC"):
        show(form, unicodedata.normalize(form, "\uff21\uff22\uff11"))
    show("NFKC", unicodedata.normalize("NFKC", "\u2460 \u00bd \u33a1"))
    show("NFKC", unicodedata.normalize("NFKC", "\u2160 \u2122"))
    # ...
```

```text
False True
NFC    'ﬁ'      U+FB01
NFD    'ﬁ'      U+FB01
NFKC   'fi'     U+0066 U+0069
NFKD   'fi'     U+0066 U+0069
NFC    'ＡＢ１'    U+FF21 U+FF22 U+FF11
NFKC   'AB1'    U+0041 U+0042 U+0031
NFKC   '1 1⁄2 m2' U+0031 U+0020 U+0031 U+2044 U+0032 U+0020 U+006D U+0032
NFKC   'I TM'   U+0049 U+0020 U+0054 U+004D
```

- **NFC / NFD**：只处理“规范等价”。NFC 把分解形式合成预组合（`e` + U+0301 变成 U+00E9），NFD 反过来拆开。第一行的 `False True` 说的就是：`é` 的两种写法 `==` 为 `False`，把分解形式做一次 NFC 之后就等于预组合形式了。
- **NFKC / NFKD**：多一个 K（compatibility，兼容）。它们还处理“兼容等价”：长得像、意思差不多但 Unicode 单独编了码的字符。`ﬁ`（U+FB01，连字）在 NFC/NFD 下纹丝不动，在 NFKC/NFKD 下变成 `fi` 两个字符。全角的 `ＡＢ１` 在 NFC 下不变，NFKC 下变成 `AB1`。`①` 变成 `1`，`½` 变成 `1⁄2`（注意中间是 U+2044 分数线，不是斜杠），`㎡` 变成 `m2`，`Ⅰ` 变成 `I`，`™` 变成 `TM`。

对搜索引擎，用户搜 `Rust`，文章里写的是全角的 `Ｒｕｓｔ`（中文输入法下很常见），应该匹配上。所以 Sift 选 NFKC。代价是它会把 `①` 和 `1` 看成同一个东西，对搜索来说这几乎总是想要的，对一个做文档编辑的程序就未必（你不想把用户写的 `™` 变成 `TM`）。

### `casefold` 不是 `lower`

不区分大小写的比较，第一反应是 `lower()`。`normalize.py` 的后半：

```python
    # ...
    print("ß".lower(), "ß".casefold(), "ß".upper())
    print("STRASSE".lower() == "straße".lower())
    print("STRASSE".casefold() == "straße".casefold())
    print("İ".lower().encode("unicode_escape"))
    word = "Ａｐｐｌｅ"
    print(word.casefold(), unicodedata.normalize("NFKC", word).casefold())
    # ...
```

```text
ß ss SS
False
True
b'i\\u0307'
ａｐｐｌｅ apple
```

德语的 `ß` 小写还是 `ß`，大写是 `SS`，`casefold` 把它折叠成 `ss`。所以 `"STRASSE".lower() == "straße".lower()` 是 `False`，换成 `casefold()` 才是 `True`。`casefold` 就是为“忽略大小写比较”设计的，比 `lower` 更激进；`lower` 是为“显示成小写”设计的。再看土耳其语带点的大写 `İ`，`lower()` 得到的是 `i` 加一个组合点（U+0307），两个码点，`b'i\u0307'`，这也是为什么不能假设 `len(s.lower()) == len(s)`。

最后一行是两步的顺序：`casefold` 不处理全角，`"Ａｐｐｌｅ".casefold()` 只是变成全角的小写 `ａｐｐｌｅ`；先 NFKC 再 `casefold` 才是 `apple`。Sift 的分词器就是这两步，顺序也是这个顺序，代价到后面“为什么慢了 33 倍”一节再算。

## 切片、方法与格式化

### 切片

`slicing.py` 的前半把切片语法每个角落都戳了一遍：

```python
    # ...
    s = "Python 与 Unicode"
    print(s[0], s[-1], s[7], s[:6], s[7:], s[::2], s[::-1])
    print(s[2:100], repr(s[100:]), s[-7:-3])
    cut = slice(0, 6)
    print(s[cut], cut.indices(len(s)))
    # ...
```

```text
P e 与 Python 与 Unicode Pto  ncd edocinU 与 nohtyP
thon 与 Unicode '' Unic
Python (0, 6, 1)
```

`s[a:b:c]` 取从 `a` 开始、到 `b` 之前、步长 `c` 的码点。`a`、`b` 可以省略，可以是负数（从末尾数起），越界也不报错，只是取到头为止：`s[2:100]` 给出 `thon 与 Unicode`，`s[100:]` 是空串 `''`。

`s[::2]` 隔一个取一个，`s[::-1]` 反过来。切片语法背后是一个 `slice` 对象：实验里的 `cut = slice(0, 6)`，`s[cut]` 和 `s[0:6]` 一样都得到 `Python`；`cut.indices(len(s))` 把省略的部分补全成 `(0, 6, 1)`。第 6 篇做自己的容器类型时，`__getitem__` 收到的就是这个 `slice` 对象。

反例在最后：

```python
    # ...
    emoji = "a😀b"
    print(len(emoji), emoji[1], emoji.encode()[1:2])
    # ...
```

```text
3 😀 b'\xf0'
```

`"a😀b"` 的长度是 3，`emoji[1]` 是整个 `😀`，因为 `str` 的下标是码点；但对**编码之后**的字节切片，`emoji.encode()[1:2]` 是 `b'\xf0'`，一个 4 字节字符的第一个字节，切坏了。凡是下标，先问自己是在对 `str` 还是对 `bytes` 做。

### 常用方法

`str_methods.py` 是一页“每天都用到的方法”，我把输出对着贴：

```python
    # ...
    line = "  key = value = more  "
    print(line.strip().split(" = "))
    print(line.strip().split(" = ", 1), line.split())
    print("key=value".partition("="), "a.b.c".rpartition("."))
    print(",".join(["a", "b", "c"]), "ab".center(6, "*"))
    print("Index.md".startswith(("Index", "README")))
    print("a.md".endswith((".md", ".txt")), "x".zfill(4))
    print("a-b_c".translate(str.maketrans("-_", "  ")))
    print("hello".translate(str.maketrans("", "", "l")))
    print("a b a".replace("a", "x", 1), "a\tb\n".expandtabs(4))
    print("Straße".title(), "éa".isalpha(), "١٢٣".isdigit())
    csv, spaced = "a,b,,c", "a b  c"
    print(csv.split(","), spaced.split(" "), spaced.split())
    print("line1\nline2\r\nline3".splitlines())
    # ...
```

```text
['key', 'value', 'more']
['key', 'value = more'] ['key', '=', 'value', '=', 'more']
('key', '=', 'value') ('a.b', '.', 'c')
a,b,c **ab**
True
True 000x
a b c
heo
x b a a   b

Straße True True
['a', 'b', '', 'c'] ['a', 'b', '', 'c'] ['a', 'b', 'c']
['line1', 'line2', 'line3']
```

- `split()` 不带参数按**任意连续空白**切并丢掉空串，`split(" ")` 按单个空格切，`"a b  c"` 两个空格会切出一个空串。输出里 `['a', 'b', '', 'c'] ['a', 'b', '', 'c'] ['a', 'b', 'c']` 那一行，前两个分别是 `"a,b,,c".split(",")` 和 `"a b  c".split(" ")`，都带着空串，第三个是 `"a b  c".split()`，没有。
- `split(sep, 1)` 只切第一刀；`partition` 总是返回 3 元组 `(前, 分隔符, 后)`，找不到分隔符也返回 3 元组，写解析代码比 `split` 省判断。
- `startswith`/`endswith` 接受元组：`"Index.md".startswith(("Index", "README"))` 一次问多个。
- `translate` 配 `str.maketrans`：映射表是码点到码点（或 `None` 表示删除），一次扫描替换所有字符，不会出现链式 `replace` 里前一次的结果被后一次再替换的问题。`"a-b_c".translate(str.maketrans("-_", "  "))` 同时把 `-` 和 `_` 换成空格，`"hello".translate(str.maketrans("", "", "l"))` 删掉所有的 `l`，得到 `heo`。
- `replace("a", "x", 1)` 只换第一个。`expandtabs(4)` 把制表符展开成对齐到 4 的空格；那行输出后面的空行，是字符串末尾的 `\n` 加上 `print` 自己的换行。
- `"éa".isalpha()` 和 `"١٢٣".isdigit()` 都是 `True`：这些判断是 Unicode 感知的，不能拿来判断“是不是 ASCII”。
- `splitlines()` 认 `\n` 和 `\r\n`（实验里两种都有），不会把 `\r` 留在行尾，比 `split("\n")` 稳；`markdown.py` 里全程用它。

- `join` 是**分隔符的方法**：`",".join(["a", "b", "c"])`，不是列表的方法，所以任何元素是 `str` 的可迭代对象都能用。

### `textwrap` 与 `string`

标准库里和 `str` 配套的两个小模块，我也各跑了一遍：

```python
"""textwrap, string constants and display width."""

import string
import textwrap
import unicodedata

print(repr(string.ascii_lowercase), repr(string.digits))
print(repr(string.punctuation), repr(string.whitespace))
print("é" in string.ascii_letters, "é".isalpha(), "é".isascii())

text = "Sift reads every Markdown file and counts the tokens it finds."
print(textwrap.wrap(text, 24))
print(textwrap.shorten(text, 30, placeholder="..."))
print(repr(textwrap.dedent("    a\n      b\n    c")))

cjk = "所有权" * 6
print(textwrap.wrap(cjk, 10))
print([unicodedata.east_asian_width(c) for c in "a所，Ａ"])
print(
    len(cjk),
    sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in cjk),
)
```

```text
$ python3 /tmp/scratch/small_tools.py
'abcdefghijklmnopqrstuvwxyz' '0123456789'
'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~' ' \t\n\r\x0b\x0c'
False True False
['Sift reads every', 'Markdown file and counts', 'the tokens it finds.']
Sift reads every Markdown...
'a\n  b\nc'
['所有权所有权所有权所', '有权所有权所有权']
['Na', 'W', 'F', 'F']
18 36
```

`string` 里的常量只管 ASCII：`"é" in string.ascii_letters` 是 `False`，而 `"é".isalpha()` 是 `True`。这和后面分词器里为什么要把字母写成 `[0-9a-z_]` 是同一个考虑。`textwrap.wrap` 按宽度折行，`shorten` 折成一行并加省略号，`dedent` 去掉每行共有的缩进，这三个我猜在展示搜索结果的片段时用得上。

它们有一个坑，输出的最后三行说得很清楚：`textwrap.wrap(cjk, 10)` 数的是**码点**，所以每行 10 个汉字，在终端里占 20 列。`unicodedata.east_asian_width` 给每个码点一个宽度类别：`Na` 是窄的（`a`），`W` 是宽的（`所`），`F` 是全角（`，` 和 `Ａ`）。把 `W` 和 `F` 算成 2 列，18 个码点就是 36 列。Python 标准库不替你做这个换算；终端里对齐中文表格的时候，这是个绕不过去的事。

### 格式化迷你语言

`format_spec.py` 是 f-string 冒号后面那一小块语言的集中演示。完整语法是 `[[fill]align][sign][#][0][width][grouping][.precision][type]`，每一段都可以省略：

```python
class Point:
    """A class that defines its own format spec."""

    def __init__(self, x: float, y: float) -> None:
        self.x = x
        self.y = y

    def __format__(self, spec: str) -> str:
        return f"({self.x:{spec}}, {self.y:{spec}})"

    def __repr__(self) -> str:
        return f"Point({self.x}, {self.y})"

# ...

def main() -> None:
    """Print values with several format specs."""
    x = math.pi
    print(f"[{x:>10.3f}] [{x:<10.3f}] [{x:^10.3f}] [{x:+.2e}]")
    print(f"[{42:08d}] [{42:#x}] [{42:#b}] [{1234567:,}] [{0.256:.1%}]")
    print(f"[{'所有权':*^9}] [{'ab':>5}] [{'abcdef':.3}]")
    print(f"{x=} {x=:.2f} {1 + 2=}")
    name = "tea\n"
    print(f"{name!r} {name!s:>6} {'é'!a}")
    width, prec = 12, 4
    print(f"[{x:{width}.{prec}f}]")
    print(f"{Point(1.5, 2.25):.1f}", f"{Point(1, 2)!r}")
    old = "{0} {1} {0}"  # str.format, kept for stored templates
    print(old.format("a", "b"), "%s is %d" % ("tea", 3))  # noqa: UP031
    print(format(255, "08b"), format(3.0, "g"), f"{1e-7:g}")
```

```text
[     3.142] [3.142     ] [  3.142   ] [+3.14e+00]
[00000042] [0x2a] [0b101010] [1,234,567] [25.6%]
[***所有权***] [   ab] [abc]
x=3.141592653589793 x=3.14 1 + 2=3
'tea\n'   tea
 '\xe9'
[      3.1416]
(1.5, 2.2) Point(1, 2)
a b a tea is 3
11111111 3 1e-07
```

- `{x:>10.3f}`：右对齐、宽 10、小数点后 3 位的定点数。`<` 左对齐，`^` 居中，`+.2e` 是带符号的科学计数法。
- `{42:08d}` 补零到 8 位，`{42:#x}` 带 `0x` 前缀的十六进制，`{1234567:,}` 千位分隔，`{0.256:.1%}` 乘 100 加百分号。
- `{'所有权':*^9}` 用 `*` 填充居中到宽度 9：宽度数的是码点，不是显示列，和上面 `textwrap` 是同一个坑。
- `{x=}` 是调试用的“自说明”写法，先打印表达式文字再打印值，`{1 + 2=}` 连表达式里的空格也原样保留；宽度和精度本身也可以是嵌套的表达式：`{x:{width}.{prec}f}`。
- `!r`、`!s`、`!a` 在格式化之前先调 `repr`、`str`、`ascii`：`{name!r}` 把 `"tea\n"` 显示成 `'tea\n'`，`{'é'!a}` 显示成 `'\xe9'`。输出里 `tea` 后面那个莫名其妙的换行不是排版错误：`{name!s:>6}` 把真正的换行符也打印出来了，`'\xe9'` 因此跑到了下一行。
- 你自己的类可以定义 `__format__(self, spec)` 接管冒号后面那一段：`Point` 把它转手交给两个坐标，`{Point(1.5, 2.25):.1f}` 得到 `(1.5, 2.2)`。注意是 2.2，不是 2.3：`2.25` 在二进制里正好表示得出来，恰好在中间，`format` 对这种数取偶数（和 IEEE 754 默认的舍入方式一致）。

`str.format`（`"{0} {1} {0}".format(...)`）和 `%` 格式化（`"%s is %d" % (...)`）仍然能用，输出在上面倒数第二行，`ruff` 的 `UP031` 会建议把 `%` 换成 f-string，所以实验里那一行带了 `noqa`。它们还有价值的一个场合是：模板和数据不在同一个地方，比如存在配置文件里的模板字符串，f-string 做不到延迟求值。下一节讲的东西正好是针对这个缺口的。

### t-string：模板，不是字符串

Python 3.14 加了一个新的字符串前缀：`t"..."`（PEP 750）。它长得像 f-string，但**不立刻拼成 `str`**，而是产出一个 `string.templatelib.Template` 对象，里面把静态文字和插值分开存着，让接收它的函数决定怎么拼。

```python
def main() -> None:
    """Show what a Template holds and why it is safer than an f-string."""
    name = "<b>Tom & Jerry</b>"
    count = 3.14159
    t = t"hello {name!r:>5} and {count:.2f}"
    print(type(t).__name__, t.strings)
    for item in t.interpolations:
        print(" ", item.expression, item.conversion, repr(item.format_spec))
    print(repr(t.values))
    print(f"<p>{name}</p>")
    print(render_html(t"<p>{name}</p>"))
    print(render_html(t"<td>{count:.2f}</td><td>{name!s}</td>"))
    print(isinstance(t, str), isinstance(t, Template))
    print(Template("a", Interpolation(1, "x"), "b").values)
```

```text
$ python3 lab/ch02/tstrings.py
Template ('hello ', ' and ', '')
  name r '>5'
  count None '.2f'
('<b>Tom & Jerry</b>', 3.14159)
<p><b>Tom & Jerry</b></p>
<p>&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;</p>
<td>3.14</td><td>&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;</td>
False True
(1,)
```

- `type(t).__name__` 是 `Template`，`isinstance(t, str)` 是 `False`：它不是字符串。
- `t.strings` 是静态文字的元组 `('hello ', ' and ', '')`，永远比插值多一个，首尾可以是空串。`t.interpolations` 是插值对象的元组，每个 `Interpolation` 有 `value`（求值之后的值）、`expression`（源码里写的表达式文字）、`conversion`（`!r` 里的 `r`）、`format_spec`（冒号后面的内容）。`{name!r:>5}` 的 `conversion` 是 `r`，`format_spec` 是 `>5`，**但解释器一个都没替你应用**：`!r` 和 `>5` 只是被记录下来，由渲染函数决定做不做。`t.values` 是所有插值的值 `('<b>Tom & Jerry</b>', 3.14159)`。
- 直接迭代 `Template`，按出现顺序得到非空的文字和 `Interpolation`，空字符串会被跳过：

```text
$ python3 -c 'a = 1; b = 2; print(list(t"{a}{b}"), list(t"x{a}"))'
[Interpolation(1, 'a', None, ''), Interpolation(2, 'b', None, '')] ['x', Interpolation(1, 'a', None, '')]
```

有了这个结构，渲染器就有了机会在**每个插值上**做事。`tstrings.py` 里的 `render_html` 是我写的一个十行的渲染器：

```python
import html
from string.templatelib import Interpolation, Template, convert


def render_html(template: Template) -> str:
    """Render a template, escaping every interpolated value."""
    parts: list[str] = []
    for item in template:
        if isinstance(item, Interpolation):
            value = convert(item.value, item.conversion)
            parts.append(html.escape(format(value, item.format_spec)))
        else:
            parts.append(item)
    return "".join(parts)
```

它遇到文字原样输出，遇到 `Interpolation` 就先 `convert`（应用 `!r`/`!s`/`!a`），再用 `format` 应用 `format_spec`，最后 `html.escape`。同一个 `name = "<b>Tom & Jerry</b>"`，f-string 是原样拼进去（`<p><b>Tom & Jerry</b></p>`，第 5 行输出），t-string 加 `render_html` 是 `<p>&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;</p>`；`{count:.2f}` 照样生效，`<td>3.14</td>`。

这就是 t-string 存在的理由：f-string 在你拿到结果的时候已经没法分辨哪一段是代码、哪一段是用户数据了，所以做 HTML、SQL、shell 命令的人都得手动转义，漏一处就是注入漏洞。t-string 把转义这件事放到唯一一个地方。搜索结果的片段迟早要把文章里的文字塞进 HTML，所以这个渲染器的形状我在这里先练一遍；最后一个例子 `Template("a", Interpolation(1, "x"), "b").values` 说明 `Template` 也可以直接构造出来，`values` 是 `(1,)`。

## 拼接字符串：`join` 还是 `+=`

我原本打算把这一节的标题写成“`+=` 是平方级的”。这是 Python 圈子里流传最广的一条建议：循环里 `s += piece` 每次都会复制整个 `s`，所以 $n$ 次拼接是 $O(n^2)$，要用 `"".join(...)`。`str_methods.py` 的最后一段想把这件事量出来：

```python
def concat(n: int) -> str:
    """Build a string with +=."""
    out = ""
    for i in range(n):
        out += str(i)
    return out


def joined(n: int) -> str:
    """Build the same string with join."""
    return "".join([str(i) for i in range(n)])
```

```text
+= : 9.54 ms for 100000 pieces
join: 9.61 ms for 100000 pieces
ratio += / join: 0.99
```

10 万个小片段，`+=` 9.54 ms，`join` 9.61 ms，比值 0.99。两种写法在 Python 3.14 里一样快。我没有改标题再编一个理由，而是把这条“常识”拆开，看它什么时候对，什么时候错。

### 七种拼法，三个规模

下面这个脚本把同一个活用七种方式各干一遍，规模从 2.5 万到 10 万片段，每个组合取三次里最快的：

```python
"""When does str += stay linear? Seven ways to build one string."""

import time
from collections.abc import Callable

SIZES = (25_000, 50_000, 100_000)


def local_iadd(n: int) -> str:
    """out += piece on a local variable."""
    out = ""
    for i in range(n):
        out += str(i)
    return out


def local_add(n: int) -> str:
    """out = out + piece on a local variable."""
    out = ""
    for i in range(n):
        out = out + str(i)
    return out


def join(n: int) -> str:
    """Collect pieces, join once."""
    return "".join([str(i) for i in range(n)])


class Box:
    """Holds the string in an attribute."""

    def __init__(self) -> None:
        self.out = ""


def attribute(n: int) -> str:
    """self.out += piece: the target is an attribute."""
    box = Box()
    for i in range(n):
        box.out += str(i)
    return box.out


def element(n: int) -> str:
    """cell[0] += piece: the target is a list element."""
    cell = [""]
    for i in range(n):
        cell[0] += str(i)
    return cell[0]


def aliased(n: int) -> str:
    """A second name keeps the old string alive during the +=."""
    out = ""
    for i in range(n):
        keep = out
        out += str(i)
    del keep
    return out


MODULE_LEVEL = """
out = ""
for i in range(n):
    out += str(i)
"""


def module_level(n: int) -> str:
    """The same loop, but out is a module global (STORE_NAME)."""
    scope = {"n": n}
    exec(compile(MODULE_LEVEL, "<module>", "exec"), scope)
    return scope["out"]


CASES = (
    local_iadd,
    local_add,
    join,
    module_level,
    attribute,
    element,
    aliased,
)


def timed(fn: Callable[[int], str], n: int) -> float:
    """Return the seconds one call of fn(n) takes."""
    start = time.perf_counter()
    fn(n)
    return time.perf_counter() - start


def main() -> None:
    """Time every case at every size, best of three."""
    print(f"{'case':<14}" + "".join(f"{n:>13,}" for n in SIZES))
    for fn in CASES:
        row = []
        for n in SIZES:
            best = min(timed(fn, n) for _ in range(3))
            row.append(f"{best * 1000:>10.1f} ms")
        print(f"{fn.__name__:<14}" + "".join(row))


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/scratch/concat_cases.py
case                 25,000       50,000      100,000
local_iadd           2.3 ms       4.8 ms       9.6 ms
local_add            2.4 ms       4.8 ms       9.5 ms
join                 1.9 ms       4.2 ms       9.5 ms
module_level        26.1 ms     108.7 ms     845.7 ms
attribute           23.1 ms     101.4 ms    1172.6 ms
element             23.2 ms     101.9 ms    1174.2 ms
aliased             23.3 ms     101.0 ms    1172.6 ms
```

读这张表（每格是三次里最快的一次）：

- 函数里的局部变量 `out += str(i)` 和 `out = out + str(i)` 都是线性的：规模翻倍，时间翻倍（2.3、4.8、9.6 ms），和 `join` 一个量级，10 万时 9.6 ms 对 9.5 ms。
- 另外四行是**平方级**的：2.5 万到 5 万，时间乘 4.2 到 4.4 倍（比如属性那一行 23.1 到 101.4 ms）；5 万到 10 万乘了 7.8 到 11.6 倍，比纯平方的 4 倍还多，我猜是字符串长到几百 KB 以后装不进二级缓存了（这一点我没验证）。10 万片段，属性、列表元素、被别名引用的这三种是 1172 ms 上下，比 `join` 慢 123 倍。
- `module_level` 那一行是同一个循环，但变量是模块级的全局变量（用 `exec` 在一个全新的模块作用域里跑），也是平方级：845.7 ms，慢 89 倍。

也就是说，**“`+=` 是平方级”这句话本身没错，只是在 CPython 3.14 里它只在某些情形下才成立，而最常见的那一种（函数里的局部变量）恰好是例外**。

### 为什么局部变量是例外

字节码给出线索。`dis` 默认显示的是编译器生成的原始指令；传 `adaptive=True` 可以看到解释器热身之后**特化**（specialize）过的指令，下面这个脚本先把两个循环各跑 100 次热身，再把 `BINARY_OP` 和 `STORE_*` 那几行挑出来：

```python
"""Is the string really resized in place? Look at the bytecode and at id."""

import dis
import io
from collections.abc import Callable

from concat_cases import Box, local_iadd


def ops(fn: Callable[..., object]) -> list[str]:
    """Return the BINARY_OP and STORE_* lines of fn's adaptive bytecode."""
    buf = io.StringIO()
    dis.dis(fn, adaptive=True, file=buf)
    return [
        line.strip()
        for line in buf.getvalue().splitlines()
        if "BINARY_OP" in line or "STORE_" in line
    ]


def attribute_loop() -> None:
    """The same += with an attribute target."""
    box = Box()
    for i in range(1000):
        box.out += str(i)


for _ in range(100):  # let the specializing interpreter warm up
    local_iadd(10)
    attribute_loop()
print("local:    ", *ops(local_iadd), sep="\n  ")
```

```text
local:
  STORE_FAST               1 (out)
  STORE_FAST               2 (i)
  BINARY_OP_INPLACE_ADD_UNICODE 13 (+=)
  STORE_FAST               1 (out)
attribute:
  STORE_FAST               0 (box)
  STORE_FAST               1 (i)
  BINARY_OP_ADD_UNICODE   13 (+=)
  STORE_ATTR_INSTANCE_VALUE 2 (out)
```

局部变量那个循环里，`+=` 被特化成了 `BINARY_OP_INPLACE_ADD_UNICODE`，后面紧跟着的 `STORE_FAST out` 是被它顺手吃掉的目标。属性那个循环里，是 `BINARY_OP_ADD_UNICODE`，后面是 `STORE_ATTR_INSTANCE_VALUE`：这一条只管拼接，生成一个新字符串。

特化的原因在 CPython 的字节码定义文件 `Python/bytecodes.c`（我对着 3.14.7 的标签读的）里有一段注释，说得很明白：

```c
/* Handle `left = left + right` or `left += right` for str.
 *
 * When possible, extend `left` in place rather than
 * allocating a new PyUnicodeObject. This attempts to avoid
 * quadratic behavior when one neglects to use str.join().
 *
 * If `left` has only two references remaining (one from
 * the stack, one in the locals), DECREFing `left` leaves
 * only the locals reference, so PyUnicode_Append knows
 * that the string is safe to mutate.
 */
```

意思是：解释器看到 `BINARY_OP` 后面紧跟一个 `STORE_FAST` 且目标就是左操作数本身，就把整个 `out += x` 当成一条超级指令，先把栈上那一份引用扔掉，让局部变量成为字符串**唯一**的持有者（引用计数 1），然后调 `PyUnicode_Append`。`PyUnicode_Append`（`Objects/unicodeobject.c`）自己再检查一遍，能不能原地修改：

```c
static int
unicode_modifiable(PyObject *unicode)
{
    assert(_PyUnicode_CHECK(unicode));
    if (!_PyObject_IsUniquelyReferenced(unicode))
        return 0;
    if (PyUnicode_HASH(unicode) != -1)
        return 0;
    if (PyUnicode_CHECK_INTERNED(unicode))
        return 0;
    if (!PyUnicode_CheckExact(unicode))
        return 0;
    /* ... */
    return 1;
}
```

`unicode_modifiable` 的四个条件：引用计数必须是 1；哈希还没被计算过（`-1` 表示没算过，哈希缓存在对象里，原地改了缓存就错了，这就是前面“不可变换来的第三样东西”）；不是驻留字符串；必须是真正的 `str` 而不是子类。四条都满足，`unicode_resize` 就直接对原来那块内存 `realloc`，把新片段拷到尾巴上，每次只拷新片段的长度，所以总共是线性的。但 `PyUnicode_Append` 进入原地分支的条件不止这一个函数。3.14.7 的 `unicodeobject.c` 里是：

```c
if (unicode_modifiable(left)
    && PyUnicode_CheckExact(right)
    && PyUnicode_KIND(right) <= PyUnicode_KIND(left)
    /* (an explanatory comment omitted here) */
    && !(PyUnicode_IS_ASCII(left) && !PyUnicode_IS_ASCII(right)))
```

右边也必须是真正的 `str`；右边的宽度不能比左边宽；左边是纯 ASCII 而右边不是，也不行（从 ASCII 换成更宽的布局，字符要整体搬家，源码注释说这和复制一份差不多）。所以往一个纯 ASCII 的 `out` 上接一个汉字，这一次不是原地的。我量了一次（5000 万个字符，单次 `+=`，取 5 次最小值）：

```python
"""Is one += slower when the piece is wider than the string?"""

import time


def one_append(char: str, piece: str) -> float:
    """Return the ms one out += piece takes on 50M chars of char."""
    out = char * 50_000_000
    start = time.perf_counter()
    out += piece
    return (time.perf_counter() - start) * 1000


for char, piece in (("a", "x"), ("a", "所"), ("所", "x"), ("所", "😀")):
    best = min(one_append(char, piece) for _ in range(5))
    print(f"{char!r} += {piece!r}: {best:9.3f} ms")
```

```text
$ python3 /tmp/scratch/kind_change.py
'a' += 'x':     0.005 ms
'a' += '所':    55.472 ms
'所' += 'x':     0.005 ms
'所' += '😀':   108.359 ms
```

同宽的接窄的是 0.005 ms；拓宽那一次是 55 到 108 ms，一次完整的复制。拓宽只发生一次：`out` 变宽以后，后面的汉字又是原地的了，所以代价是多复制一遍，不是平方级。

任何一条不满足，就走另一条分支：新分配一块 `new_len` 大的内存，把左右两边都拷进去，旧的丢掉，每次复制整个字符串，平方级。

对照上面的表，四种慢的情形各自踩了哪一条：

- **属性和列表元素**（`box.out += x`、`cell[0] += x`）：字节码里目标不是 `STORE_FAST`，上面看到了，没有特化成原地版本。`BINARY_OP_ADD_UNICODE` 在 `bytecodes.c` 里调的是 `PyUnicode_Concat`，它**永远**新建一个字符串，把两边拷进去。
- **别名**（`keep = out` 然后 `out += x`）：`keep` 多持有一份引用，计数是 2，`unicode_modifiable` 的第一条不满足。
- **模块级变量**：`exec` 出来的是模块作用域，变量用 `STORE_NAME` 而不是 `STORE_FAST`，超级指令的前提（后面紧跟 `STORE_FAST`）不成立。我用 `dis` 验证：

```text
$ python3 -c 'import dis; dis.dis(compile("out = str()\nfor i in range(3):\n    out += str(i)\n", "<m>", "exec"))' | grep -E 'BINARY_OP|STORE'
              STORE_NAME               1 (out)
              STORE_NAME               3 (i)
              BINARY_OP               13 (+=)
              STORE_NAME               1 (out)
```

`BINARY_OP` 后面跟的是 `STORE_NAME`，走的是普通的 `+=`，每次生成新字符串。

最后我想验证“原地修改”这件事真的发生了，而不是靠计时间接推断。脚本后半部分每次 `+=` 之后看一眼 `id(out)`，如果字符串是原地扩的，它的地址应该几乎不变：

```python

def moves(kind: str, steps: int = 2000) -> int:
    """Count how often the string's address changes over steps appends."""
    out, box, moved, last = "", Box(), 0, 0
    for _ in range(steps):
        if kind == "local":
            out += "x" * 10
            now = id(out)
        elif kind == "alias":
            keep = out
            out += "x" * 10
            assert keep is not out
            now = id(out)
        elif kind == "hash":
            hash(out)
            out += "x" * 10
            now = id(out)
        else:
            box.out += "x" * 10
            now = id(box.out)
        moved += now != last
        last = now
    return moved


for kind in ("local", "alias", "hash", "attribute"):
```

```text
local      address changed   35 times in 2000 appends
alias      address changed 2000 times in 2000 appends
hash       address changed 2000 times in 2000 appends
attribute  address changed 2000 times in 2000 appends
```

2000 次追加里，局部变量只换了 35 次地址，其余都是原地扩（那 35 次我猜是字符串还很短、住在小对象分配器里的时候，每长大一档就得搬一次家）；别名、调用过 `hash(out)` 的、属性，**每一次**都换地址，也就是每一次都是一次完整的复制。第三行 `hash` 是把前面的第二条规则单独拎出来试：只要在循环里碰了一下 `hash(out)`，缓存的哈希值就让下一次 `+=` 退回复制。

这个优化的启发式有点脆：它是 CPython 的实现细节，不是语言保证；换个解释器，或者哪天你把循环里的局部变量改成对象的属性，代价会突然从线性变成平方级，而代码看起来一个字都没变。我的建议还是老办法：要拼很多片段，就攒进列表，最后 `"".join(...)`，它在任何情形下都是线性的。我给自己的修正是：不要再说“`+=` 是平方级的”，要说“`+=` 是平方级的，除非恰好撞上那条局部变量的快路径”。

## 正则表达式

### `re` 的一圈

`regex_tour.py` 在一个小句子上把 `re` 的常用功能过一遍。句子是 `"Python 3.14 shipped on 2025-10-07; 3.13 on 2024-10-07."`，我会分几段贴：

```python
    # ...
    text = "Python 3.14 shipped on 2025-10-07; 3.13 on 2024-10-07."
    num = re.compile(r"\d+(?:\.\d+)?")
    print(num.findall(text))
    print(num.search(text), num.fullmatch("3.14") is not None)
    date = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
    m = date.search(text)
    assert m is not None
    print(m.groups(), m.group(0), m.span(1))
    named = re.compile(r"(?P<year>\d{4})-(?P<month>\d{2})-(?P<day>\d{2})")
    for m in named.finditer(text):
        print(m.groupdict(), m.start(), m.end())
    # ...
```

```text
['3.14', '2025', '10', '07', '3.13', '2024', '10', '07']
<re.Match object; span=(7, 11), match='3.14'> True
('2025', '10', '07') 2025-10-07 (23, 27)
{'year': '2025', 'month': '10', 'day': '07'} 23 33
{'year': '2024', 'month': '10', 'day': '07'} 43 53
```

- `re.compile` 把模式字符串编译成 `Pattern` 对象，之后反复用。模式前面的 `r` 是**原始字符串**（raw string）：反斜杠不被 Python 当转义符处理，`r"\d"` 和 `"\\d"` 是同一个字符串，`len(r"\n")` 是 2（反斜杠加 `n`），`len("\n")` 是 1，实验最后几行的 `True 2 1` 就是这个。写正则不用 `r` 前缀，迟早会被 `\b` 咬到：

```text
$ python3 -c 'print(ascii("\b"), r"\b" == "\\b")'
'\x08' True
```

在普通字符串里它是退格符 U+0008，不是词边界。

- `findall` 返回所有不重叠的匹配。模式里没有括号时返回匹配到的字符串；有括号时返回**括号里的内容**（一个括号是字符串，多个括号是元组），不是整个匹配，下一段的第一行就是例子。
- `search` 找第一个匹配，返回 `Match` 对象（或 `None`），`fullmatch` 要求整个字符串都匹配。`match` 要求从开头匹配，我自己几乎只用前两个，因为 `match` 的“只管开头”太容易被忘。
- `(\d{4})-(\d{2})-(\d{2})` 有三个**捕获组**，`m.groups()` 给元组，`m.group(0)` 是整个匹配，`m.span(1)` 是第一组的起止位置 `(23, 27)`。
- 组可以起名：`(?P<year>\d{4})`，`m.groupdict()` 给字典。`finditer` 返回 `Match` 对象的迭代器，不像 `findall` 一次全造出来，带着位置信息（`m.start()`、`m.end()`）；对大文本，这个惰性很重要（第 5 篇）。

```python
    # ...
    verbose = re.compile(
        r"""
        (?P<major>\d+) \.      # 主版本号
        (?P<minor>\d+)         # 次版本号
        """,
        re.VERBOSE,
    )
    print(verbose.findall(text))
    print(re.findall(r"\w+(?=;)", text), re.findall(r"\d+(?=;)", text))
    print(re.findall(r"(?<=on )\S+", text))
    print(date.sub(lambda m: f"{m[3]}/{m[2]}/{m[1]}", text))
    # ...
```

```text
[('3', '14'), ('3', '13')]
['07'] ['07']
['3.14', '2025-10-07;', '2024-10-07.']
Python 3.14 shipped on 07/10/2025; 3.13 on 07/10/2024.
```

- `re.VERBOSE`（简写 `re.X`）让模式里的空白和 `#` 注释被忽略，可以把长模式拆成多行、一行一个意思，写成了就读得懂。分词器的正则用的就是这个。
- **先行断言** `(?=;)` 要求后面跟着分号但不消耗它：`\w+(?=;)` 找到的是 `07`，不含分号；`\d+(?=;)` 同理。**后行断言** `(?<=on )` 要求前面是 `on `，同样不消耗：

  `(?<=on )\S+` 给出的三个结果里，第一个 `3.14` 是个意外：`Python 3.14` 里，`Python` 的结尾恰好是 `on`，后面跟着一个空格。断言匹配的是字符，不管词的边界。我写这个例子的时候就被它咬了一口。

- `re.sub` 的替换可以是函数：`lambda m: f"{m[3]}/{m[2]}/{m[1]}"` 接收 `Match` 对象，返回替换文本，所以把 `2025-10-07` 改成 `07/10/2025` 不需要手写循环。

```python
    # ...
    print(re.sub(r"\s+", " ", "a  b \n c"), re.split(r"[;,]\s*", "a; b,c"))
    html = "<b>one</b><b>two</b>"
    print(re.findall(r"<b>.*</b>", html), re.findall(r"<b>.*?</b>", html))
    print(re.findall(r"\bsift\b", "Sift sifted SIFT", re.IGNORECASE))
    print(re.findall(r"^\w+", "a b\nc d", re.MULTILINE))
    print(re.findall(r"\w+", "所有权 abc_1"), re.findall(r"\w+", "é", re.A))
    print(r"\d" == "\\d", len(r"\n"), len("\n"))
    # ...
```

```text
a b c ['a', 'b', 'c']
['<b>one</b><b>two</b>'] ['<b>one</b>', '<b>two</b>']
['Sift', 'SIFT']
['a', 'c']
['所有权', 'abc_1'] []
True 2 1
```

- `re.sub(r"\s+", " ", ...)` 把连续的空白压成一个空格，`re.split(r"[;,]\s*", ...)` 按模式切，比 `str.split` 能表达的多。
- **贪婪与懒惰**：`<b>.*</b>` 的 `.*` 贪婪，尽可能多吃，所以一口吞下 `<b>one</b><b>two</b>` 整串；`.*?` 在后面加 `?` 变懒惰，尽可能少吃，得到两个标签。同样的 `+?`、`??`、`{m,n}?`。
- 标志：`re.IGNORECASE` 让 `\bsift\b` 同时匹配 `Sift` 和 `SIFT`，但不匹配 `sifted`（`\b` 是词边界）；`re.MULTILINE` 让 `^` 匹配每一行的开头，而不只是整个字符串的开头。
- **`\w` 是 Unicode 感知的**：`re.findall(r"\w+", "所有权 abc_1")` 得到 `['所有权', 'abc_1']`，汉字也算“单词字符”；加 `re.A`（ASCII 模式）以后，`re.findall(r"\w+", "é", re.A)` 是空的。这一点决定了分词器不能偷懒用 `\w+`：我们想区别对待汉字和字母，所以字符集要自己写。

`re` 模块函数（`re.search(pattern, text)`）每次调用要先到模块内部的缓存里查一遍这个模式有没有编译过，`compile` 之后的对象省掉这一步。差多少，我用 `timeit` 量了一次：

```text
$ python3 -m timeit -s 'import re; p = re.compile(r"\d+")' 'p.search("abc 123")'
2000000 loops, best of 5: 180 nsec per loop
$ python3 -m timeit -s 'import re' 're.search(r"\d+", "abc 123")'
500000 loops, best of 5: 452 nsec per loop
```

180 ns 对 452 ns，2.5 倍。绝对值很小，但分词器每处理一行要调用十几次正则，所以 `markdown.py` 的 13 个模式都在模块顶层 `re.compile` 一次。

### 引擎里面是什么

`re` 是回溯型引擎：模式被编译成一小段字节码，由 C 写的虚拟机在文本上一格一格地试，试不过就退回上一个选择点，换一条路。给 `re.compile` 传 `re.DEBUG`，会打印解析树和编译出来的指令，你可以对着分词器那个正则看一遍：`MAX_REPEAT 1 MAXREPEAT` 是 `+`，`RANGE (97, 122)` 是 `a-z`，`SUBPATTERN` 是捕获组。

### 灾难性回溯

回溯的代价在最坏情形下是指数级的。`regex_catastrophic.py` 用最经典的例子 `(a+)+$` 去匹配 `"aaa...ab"`，从 10 个 `a` 开始逐个加长，直到一次搜索超过 1 秒就停：

```python
LIMIT_S = 1.0
BAD = re.compile(r"(a+)+$")
GOOD = re.compile(r"a+$")
```

```text
$ python3 lab/ch02/regex_catastrophic.py
  n    (a+)+$ [ms]   a+$ [ms]  ratio
 10          0.077      0.001      -
 11          0.143      0.001   1.85
...
 22        318.889      0.006   2.00
 23        634.329      0.009   1.99
 24       1251.445      0.006   1.97
stop: n=24 took 1.25 s >= 1.0 s
```

（中间几行省略，比值全是 2.0 上下，完整输出在 `out/ch02/regex_catastrophic.stdout`。）

最后一列是相邻两行耗时的比值，从第 11 行起一直是 2.0 上下：每多一个 `a`，时间翻倍。n = 24 时是 1.25 s。同一段文本用线性的 `a+$`，在 24 个 `a` 上只要几微秒。

为什么：`(a+)+` 要把一串 `a` 分成若干段，每段至少一个 `a`，$n$ 个 `a` 有 $2^{n-1}$ 种分法。`$` 要求后面必须是结尾，而末尾是个 `b`，每一种分法都失败，引擎老老实实把每一种都试完才肯认输。如果这个比值继续保持 2，n = 40 要 $1.25 \times 2^{16} \approx 82000$ 秒，将近 23 个小时（外推，我没有等）。

这类写法不只出现在教科书里。`^(\w+\s?)*$` 看起来完全正常，是一个想“匹配若干个单词”的人会写出来的东西，它同样是指数级的，练习 3 里你可以自己试。

补救有三种：

1. 把模式改写成不歧义的（`a+$`）。最好，不总是做得到。
2. 用**原子组** `(?>a+)` 或**占有量词** `a++`：一旦匹配成功，就不允许引擎回头重新分配。这是 Python 3.11 新增的语法。
3. 限制输入长度，因为 `re` 没有超时参数：

```text
$ python3 -c 'import inspect, re; print(inspect.signature(re.search))'
(pattern, string, flags=0)
```

下面是前两种补救的实测：

```python
"""Three ways out of catastrophic backtracking, timed."""

import re
import time

CASES = (
    (r"(a+)+$", 24),
    (r"(a++)+$", 24),
    (r"(?>a+)+$", 24),
    (r"a+$", 24),
)


def main() -> None:
    """Search each pattern in 'a' * n + 'b' and print the time."""
    for pattern, n in CASES:
        text = "a" * n + "b"
        start = time.perf_counter()
        found = re.search(pattern, text)
        ms = (time.perf_counter() - start) * 1000
        print(f"{pattern:<10} n={n:>9,} {ms:>10.3f} ms  match={found}")


if __name__ == "__main__":
    main()
```

```text
$ python3 /tmp/scratch/regex_fixes.py
(a+)+$     n=       24   1263.004 ms  match=None
(a++)+$    n=       24      0.230 ms  match=None
(?>a+)+$   n=       24      0.045 ms  match=None
a+$        n=       24      0.025 ms  match=None
```

同一个 n = 24，原来的 1263 ms，占有量词版本 0.230 ms，原子组版本 0.045 ms，改写成线性的 `a+$` 0.025 ms。大约 5500 倍和 28000 倍。如果正则的模式来自用户输入（后面我们要手写一个查询语言，不让用户的输入直接变成正则，这是原因之一），这个问题就是一个拒绝服务攻击面；如果模式是你自己写的，上线前拿最坏输入跑一遍计时，就可以放心。

## Sift 的分词器

### 先把 Markdown 剥掉

第 1 篇的搜索把整个文件当文本数，包括 front matter（`commentId: "post:kalman-filter-01-one-dimension"` 里也有 `kalman`）、链接的 URL、代码围栏。这些不是读者看到的文字，搜索它们会产生噪音。`src/sift/markdown.py` 做两件事，先把文件拆成 front matter 和正文：

```python
def split_front_matter(text: str) -> tuple[str, str]:
    """Split text into front matter and body.

    The front matter is returned without its two ``---`` lines. A text
    that does not start with a front matter block yields ``("", text)``.
    """
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip() != "---":
        return "", text
    for i in range(1, len(lines)):
        if lines[i].rstrip() == "---":
            return "".join(lines[1:i]), "".join(lines[i + 1 :])
    return "", text
```

`splitlines(keepends=True)` 保留每行的换行符，这样 `"".join(lines[i + 1 :])` 拼回去的正文和原文字节完全一致。第一行必须是 `---` 才算有 front matter，否则整个文本都是正文：`return "", text`。`for i in range(1, len(lines))` 找到第二个 `---` 就返回；找不到也当没有。注意 `lines[1:i]` 和 `lines[i + 1 :]` 里的 `:` 两边的空格：那是 `ruff format` 的风格：切片里的表达式一复杂，冒号就像一个优先级最低的运算符（PEP 8 也这么说），两边留空格，省略的那一侧不留。

然后是 `strip_markdown`，它是一个逐行的小状态机，状态只有一个 `in_fence`：

```python
def strip_markdown(body: str) -> str:
    """Return the plain text of a Markdown body.

    Fence markers are dropped but the code inside is kept. Link text is
    kept while URLs, images, HTML tags, table pipes, heading markers and
    emphasis markers are removed.
    """
    out: list[str] = []
    in_fence = False
    for line in body.splitlines():
        if _FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            out.append(line)
            continue
        if _TABLE_RULE.match(line) and "-" in line:
            continue
        line = _HEADING.sub("", line)
        line = _QUOTE.sub("", line)
        if line.lstrip().startswith("|"):
            line = line.replace("|", " ")
        line = _strip_inline(line)
        if "|" in line and line.count("|") >= 2:
            line = line.replace("|", " ")
        out.append(line.strip())
    return "\n".join(out)
```

围栏行（` ``` ` 或 `~~~`）翻转 `in_fence` 并丢掉自己；围栏里的行原样保留，不做任何剥离，因为代码里的标识符（`tokenize`、`Counter`）是用户会搜的词；表格的分隔行（`| --- | --- |`）整行丢掉；其余的行，先去掉行首的 `#` 和 `>`，表格行里的 `|` 换成空格，然后过 `_strip_inline`，剥完之后如果还有两个以上的 `|`，也当表格行处理。`and "-" in line` 其实是多余的：`_TABLE_RULE` 里已经要求至少两个连字符，我写的时候多加了一道保险，没有删。

`_strip_inline` 是 9 次 `sub` 的流水线，模式都在文件顶部：

```python
# ...
_FENCE = re.compile(r"^\s*(```|~~~).*$")
_TABLE_RULE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_AUTOLINK = re.compile(r"<(https?://[^>\s]+)>")
_HTML_TAG = re.compile(r"</?[A-Za-z][^>]*>|<!--.*?-->")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+")
_QUOTE = re.compile(r"^\s*>+\s?")
_BOLD = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1")
_ITALIC_STAR = re.compile(r"\*(?=\S)([^*]+?)(?<=\S)\*")
_ITALIC_UNDER = re.compile(r"(?<!\w)_(?=\S)([^_]+?)(?<=\S)_(?!\w)")
_STRIKE = re.compile(r"~~(?=\S)(.+?)(?<=\S)~~")
_CODE_SPAN = re.compile(r"`+([^`]*)`+")
# ...
```

```python
def _strip_inline(line: str) -> str:
    """Remove inline Markdown syntax from one line of prose."""
    line = _IMAGE.sub("", line)
    line = _LINK.sub(r"\1", line)
    line = _AUTOLINK.sub(r"\1", line)
    line = _HTML_TAG.sub("", line)
    line = _CODE_SPAN.sub(r"\1", line)
    line = _BOLD.sub(r"\2", line)
    line = _STRIKE.sub(r"\1", line)
    line = _ITALIC_STAR.sub(r"\1", line)
    return _ITALIC_UNDER.sub(r"\1", line)
```

顺序有讲究，值得逐个看一眼，因为这是 `re` 那一节的实战：

- `_IMAGE` 必须在 `_LINK` 之前：`![alt](url)` 里面就含着一个 `[alt](url)`，先处理链接会留下一个孤零零的 `!`。图片整个丢掉，链接只留文字：`_LINK.sub(r"\1", line)`，替换串里的 `\1` 指的是第一个捕获组，也就是方括号里的链接文字。
- `_BOLD` 是 `(\*\*|__)(?=\S)(.+?)(?<=\S)\1`。开头 `(\*\*|__)` 捕获一个 `**` 或 `__`；`(?=\S)` 先行断言：后面紧跟的不能是空白；`(.+?)` **懒惰**匹配内容（不懒惰的话 `**a** and **b**` 会被吞成一整块）；`(?<=\S)` 后行断言：结尾标记前面不能是空白；最后的 `\1` 是**反向引用**，要求结尾的标记和开头那个一模一样，`**` 配 `**`，`__` 配 `__`。替换成 `\2`，只留内容。
- `_ITALIC_UNDER` 是 `(?<!\w)_(?=\S)([^_]+?)(?<=\S)_(?!\w)`，两头各有一个**否定**断言 `(?<!\w)` 和 `(?!\w)`，要求下划线两侧不是单词字符。它的目的是区分 `_强调_` 和 `snake_case_name`：后者的下划线两边是字母，不算强调。我对一句话验证了一下：

```text
$ python3 -c 'from sift.markdown import strip_markdown; print(strip_markdown("a snake_case_name, _em_ and **bold** and __b__ and `code` and [text](https://x.y/z)."))'
a snake_case_name, em and bold and b and code and text.
```

`snake_case_name` 原样保留，`_em_` 变成 `em`，`**bold**` 和 `__b__` 都剥掉了，行内代码留下 `code`，链接留下 `text`。这些模式有已知的缺口：URL 里带括号的链接会被 `[^)]*` 提前截断，嵌套强调、引用式链接（`[text][ref]`）、HTML 块都没处理。

还有一个我是写完才发现的缺口，而且比这些都严重：`_strip_inline` 先剥 `_HTML_TAG`，再剥 `_CODE_SPAN`，剥掉反引号之后，`_BOLD`、`_ITALIC_*` 接着在**代码片段的内容**上运行。于是行内代码里的 `<...>`、`*`、`__` 会被当成标记吃掉：

```python
"""Which inline code spans does strip_markdown change?"""

import re
from collections import Counter
from pathlib import Path

from sift.markdown import split_front_matter, strip_markdown

SPAN = re.compile(r"`([^`\n]+)`")
EXAMPLES = ("Vec<u8>", "std::expected<T, E>", "a*b*c", "__init__")

for code in EXAMPLES:
    print(f"{code!r:<24} -> {strip_markdown(f'`{code}`')!r}")

kinds: Counter[str] = Counter()
total = 0
for path in sorted(Path("corpus/posts").glob("*.md")):
    in_fence = False
    for line in split_front_matter(path.read_text("utf-8"))[1].splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
        elif not in_fence:
            for code in SPAN.findall(line):
                total += 1
                if strip_markdown(f"`{code}`") == code:
                    continue
                if re.fullmatch(r"__\w+__", code):
                    kinds["dunder"] += 1
                elif "<" in code:
                    kinds["angle"] += 1
                elif "*" in code:
                    kinds["star"] += 1
                else:
                    kinds["other"] += 1
print(f"spans {total}, changed {sum(kinds.values())}, by kind {dict(kinds)}")
```

```text
$ python3 /tmp/scratch/code_span_damage.py
'Vec<u8>'                -> 'Vec'
'std::expected<T, E>'    -> 'std::expected'
'a*b*c'                  -> 'abc'
'__init__'               -> 'init'
spans 27639, changed 1007, by kind {'other': 164, 'angle': 819, 'star': 24}
```

`Vec<u8>` 变成 `Vec`，`std::expected<T, E>` 变成 `std::expected`，`a*b*c` 变成 `abc`，`__init__` 变成 `init`，所以搜 `__init__` 永远找不到这些文章。整个语料 27,639 个行内代码片段里，819 个丢了 `<...>` 的部分，24 个丢了 `*`；剩下 164 个“变了”的，我只抽查了出现次数最多的几个，主要是首尾空格被 `strip` 掉或者含 `|`，不算损坏。所以受损的大约 840 个，约 3%。第 1 篇的子串计数没有这个问题。这是本章这个版本的已知限制，我没有改仓库里的代码。对这份语料够用；我没有再追，因为再精确就是在重写一个 Markdown 解析器，而那不是这个系列的主题。

用 `tests/fixtures/mini/` 里的一篇小文章把整条流水线走一遍。这是第 1 篇说过“第 2 篇起会用”的那几篇之一：

```python
"""Run one fixture through split, strip and tokenize."""

from pathlib import Path

from sift.analysis.tokenize import tokenize
from sift.markdown import split_front_matter, strip_markdown

text = Path("tests/fixtures/mini/bicycle-gears.md").read_text("utf-8")
front, body = split_front_matter(text)
print(repr(front[:40]))
plain = strip_markdown(body)
print(plain)
print("---")
tokens = tokenize(plain)
print(len(tokens), tokens[:12])
```

```text
$ python3 /tmp/scratch/pipeline_demo.py
'title: 自行车变速：齿比的算法\npublished: "2026-01-0'

自行车变速：齿比的算法

齿比等于前齿盘齿数除以飞轮齿数。

一个例子

前齿盘 50 齿，飞轮 25 齿，齿比是 2。
踏频 90 转时，车轮转速是 180 转每分钟。

前盘   飞轮   齿比
34   28   1.21
50   25   2.00
50   11   4.55

def ratio(front: int, rear: int) -> float:
    return front / rear


print(ratio(50, 25))

参考资料：Sheldon Brown。

爬坡时选小齿比，下坡时选大齿比。
链条越斜，磨损越快，所以尽量避免大盘配大飞轮。
这是自行车保养里最容易被忽略的一条。
---
125 ['自行', '行车', '车变', '变速', '齿比', '比的', '的算', '算法', '齿比', '比等', '等于', '于前']
```

第一行是 front matter 的前 40 个字符（我只打印开头）。正文里的 `#` 都没了；表格从 `| 前盘 | 飞轮 | 齿比 |` 变成了空格分隔；Python 代码块的围栏没了，代码本身还在；链接 `[Sheldon Brown](https://example.com/sheldon)` 变成了 `Sheldon Brown`。

### 切成词元

下面是整个 `src/sift/analysis/tokenize.py`，只有 37 行：

```python
"""The chapter 2 tokenizer: Latin words and CJK bigrams."""

import re
import unicodedata

CJK = "\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"

# Latin/digit run with an optional c++ / c# style suffix, or a CJK run.
_TOKEN = re.compile(
    rf"""
    (?P<latin> [0-9a-z_]+ (?: \+{{1,2}} | \# )? )
    | (?P<cjk> [{CJK}]+ )
    """,
    re.VERBOSE,
)


def tokenize(text: str) -> list[str]:
    """Split text into index terms.

    The text is NFKC-normalized and casefolded first. Latin and digit
    runs become one token each (``c++`` and ``c#`` keep their suffix).
    A CJK run becomes overlapping bigrams, or one unigram when the run
    has a single character.
    """
    folded = unicodedata.normalize("NFKC", text).casefold()
    tokens: list[str] = []
    for match in _TOKEN.finditer(folded):
        if match["latin"] is not None:
            tokens.append(match["latin"])
            continue
        run = match["cjk"]
        if len(run) == 1:
            tokens.append(run)
        else:
            tokens.extend(run[i : i + 2] for i in range(len(run) - 1))
    return tokens
```

我分开讲。`CJK` 是三段汉字区间：U+3400 到 U+4DBF（扩展 A）、U+4E00 到 U+9FFF（基本区）、U+F900 到 U+FAFF（兼容汉字）。它是一个普通字符串，里面的 `-` 是正则字符类里的范围符号，所以它能直接拼进字符类。

**regex101 式的拆解。** 如果你把 `_TOKEN` 贴进 regex101，它会这样逐段解释，我手工写一遍：

| 片段 | 含义 |
| --- | --- |
| `rf"""..."""` | 原始 f-string：`r` 让反斜杠保持原样，`f` 让 `{CJK}` 被替换。所以模式里真要出现的花括号要写成 `{{` 和 `}}` |
| `re.VERBOSE` | 模式里的空白和 `#` 注释被忽略，所以能一段一行地排版；副作用是模式里**真要匹配**空白或 `#` 时必须转义 |
| `(?P<latin> ... )` | 命名捕获组 `latin`，匹配成功后 `match["latin"]` 取内容 |
| `[0-9a-z_]+` | 字符类：数字、小写字母、下划线，至少一个，尽可能多 |
| `(?: \+{{1,2}} \| \# )?` | `(?: ... )` 是**非捕获组**，只分组不记录；里面是 `\+{1,2}`（一到两个加号）或 `\#`（井号，要转义，否则 VERBOSE 会把它当注释的开头）；整个组后面的 `?` 表示可有可无。这样 `c++` 和 `c#` 才能作为整词保留下来 |
| `\|` | 顶层的“或”：先试 `latin` 分支，不行再试 `cjk` 分支 |
| `(?P<cjk> [{CJK}]+ )` | 命名捕获组 `cjk`，一个或多个汉字，连续的一整段 |

两个分支的字符集不相交（拉丁字母和数字的码点都小于 U+0080，汉字区间都在 U+3400 以上），所以分支的先后顺序不影响结果。

`regex_tour.py` 最后用这个正则切一小串 `"c++ 所有权 rust2"`，`lastgroup` 告诉你是哪一组匹配上的：

```text
    (?P<latin> [0-9a-z_]+ (?: \+{1,2} | \# )? )
    | (?P<cjk> [㐀-䶿一-鿿豈-﫿]+ )

latin c++ (0, 3)
cjk 所有权 (4, 7)
latin rust2 (8, 13)
```

输出的前两行是 `_TOKEN.pattern` 本身：花括号区间已经被替换成了真正的汉字范围 `㐀-䶿一-鿿豈-﫿`（这三个字符是各段的起点和终点，终端里看着像乱码，其实就是 U+3400、U+4DBF 等等）。后三行是三个匹配：`latin` 的 `c++`，位置 (0, 3)；`cjk` 的 `所有权`，(4, 7)；`latin` 的 `rust2`，(8, 13)，数字也属于 `[0-9a-z_]`。

为什么 `latin` 分支只写小写 `a-z`？因为 `tokenize` 在跑正则之前已经先做了 NFKC 和 `casefold`，大写字母和全角字母已经被折叠成了小写 ASCII。如果顺序反过来，我们得写 `[0-9A-Za-z_]` 再配 `re.IGNORECASE`，而且全角字母还是漏网。这是“归一化与大小写折叠”一节的结论落地的地方。

`tokenize` 的循环做的事：

- `match["latin"] is not None`：`Match` 对象支持下标取组，命中的那一组返回字符串，另一组返回 `None`。拉丁词直接 `append`，用 `continue` 跳过后面。
- 汉字段 `run`：长度为 1 就保留单字；否则 `run[i : i + 2] for i in range(len(run) - 1)` 产生所有相邻两字，也就是二元组（bigram），`"所有权"` 变成 `所有` 和 `有权`。`tokens.extend(...)` 里那个括号是生成器表达式，`extend` 一边迭代一边追加，不先造一个中间列表。

跑几个例子，顺便把它的毛病也看一遍。脚本的后半段数被丢掉的字符，下面马上用到：

```python
"""Which letters does the Sift tokenizer silently drop?"""

import unicodedata
from collections import Counter
from pathlib import Path

from sift.analysis.tokenize import _TOKEN, tokenize
from sift.markdown import split_front_matter, strip_markdown

for text in ("café", "Straße", "Ｒｕｓｔ", "C++ 与 C#", "所", "Rust所有权"):
    print(f"{text!r:<14} {tokenize(text)}")
print(tokenize("こんにちは 한국어 𠮷野家 αβγ"))

dropped: Counter[str] = Counter()
kept = 0
for path in sorted(Path("corpus/posts").glob("*.md")):
    body = strip_markdown(split_front_matter(path.read_text("utf-8"))[1])
    for ch in unicodedata.normalize("NFKC", body).casefold():
        if unicodedata.category(ch)[0] in "LN":
            if _TOKEN.fullmatch(ch):
                kept += 1
            else:
                dropped[ch] += 1
print(f"letters and digits kept: {kept}, dropped: {dropped.total()}")
for ch, n in dropped.most_common(12):
    print(f"{n:>6}  {ch}  U+{ord(ch):04X}  {unicodedata.name(ch)}")
```

```text
'café'         ['caf']
'Straße'       ['strasse']
'Ｒｕｓｔ'         ['rust']
'C++ 与 C#'     ['c++', '与', 'c#']
'所'            ['所']
'Rust所有权'      ['rust', '所有', '有权']
['野家']
```

`Straße` 变成 `strasse`（`casefold` 的功劳）；`Ｒｕｓｔ` 变成 `rust`（NFKC 的功劳）；`C++ 与 C#` 保住了 `c++` 和 `c#`，单字 `与` 也保住了；`Rust所有权` 里英文和汉字在没有空格的地方被正确地切开了。

毛病是两个。`café` 变成了 `caf`：`é` 不在 `[0-9a-z_]` 里，NFKC 又不会把它拆开（它是预组合字符），于是被当成分隔符。第二个更隐蔽，最后一行 `こんにちは 한국어 𠮷野家 αβγ` 只出来一个 `野家`：日文假名、韩文、希腊字母都没在字符集里，直接消失；`𠮷`（U+20BB7，扩展 B 区）也不在三段区间里，没有任何报错。

这在我们的语料里影响多大？我数了一下被丢掉的字母和数字：

```text
letters and digits kept: 1887467, dropped: 102
    34  μ  U+03BC  GREEK SMALL LETTER MU
    15  λ  U+03BB  GREEK SMALL LETTER LAMDA
    13  σ  U+03C3  GREEK SMALL LETTER SIGMA
    10  π  U+03C0  GREEK SMALL LETTER PI
     6  ψ  U+03C8  GREEK SMALL LETTER PSI
     4  τ  U+03C4  GREEK SMALL LETTER TAU
     4  ω  U+03C9  GREEK SMALL LETTER OMEGA
     4  é  U+00E9  LATIN SMALL LETTER E WITH ACUTE
     3  à  U+00E0  LATIN SMALL LETTER A WITH GRAVE
     3  φ  U+03C6  GREEK SMALL LETTER PHI
     1  å  U+00E5  LATIN SMALL LETTER A WITH RING ABOVE
     1  ö  U+00F6  LATIN SMALL LETTER O WITH DIAERESIS
```

1,887,467 个字母和数字被保留，只有 102 个被丢掉（大约 0.005%），主要是写公式的希腊字母：`μ` 34 个、`λ` 15 个、`σ` 13 个，`é` 4 个。对这份语料，不是问题；换一个有日文的语料就是了。练习 2 让你把它修好。

### 为什么中文用二元组

英文有空格，词边界免费；中文没有。要让搜索“所有权”找到文章，有三条路：

1. **词典分词**（比如 jieba）：准，但要带一份词典，遇到词典里没有的词（新词、术语、人名）就切错，而且切分本身有歧义。
2. **单字**：每个汉字一个词元。不需要词典，但高频字到处都是，比如“的”，123 篇里有 122 篇含有它（下面这行数出来的），搜“所有权”变成了搜“所”“有”“权”三个高频字的并集，噪音大得不能用。

```text
$ python3 -c 'from pathlib import Path; fs = list(Path("corpus/posts").glob("*.md")); print(sum("的" in p.read_text("utf-8") for p in fs), len(fs))'
122 123
```

3. **二元组**：每两个相邻的汉字一个词元。不需要词典，常见的双字词（`所有`、`权利`、`函数`）恰好就是一个词元，更长的词（`所有权`）变成几个相邻二元组，查询时同样切开，就能对上。

二元组的账单是索引变大、会产生跨词的垃圾：`齿比的算法` 切出 `齿比`、`比的`、`的算`、`算法`，其中只有两个是真词。垃圾二元组无伤大雅，只是占地方，它们几乎没人搜；但它们也意味着 `所有` 会同时匹配“所有权”和“所有的人”，没法区分。下面数一数这笔账：

```text
$ python3 lab/ch02/tokenize_corpus.py
files: 123
characters: 3320875, bytes: 4614185, bytes/char: 1.389
tokens: 812338, distinct: 81192
kalman-filter-01-one-dimension.md: 5312 raw, 4959 stripped
gdb-debugging-guide.md: 24422 raw, 23691 stripped
grep-ripgrep-search-guide.md: 3494 raw, 3293 stripped
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
```

123 个文件，812,338 个词元，其中不同的有 81,192 个。往下是前 15 个最常见的词元：`0`、`1`、`2` 是代码和表格里的数字，`a`、`n`、`t`、`x`、`s`、`b`、`c`、`i` 是公式和示例里的单字母变量，`np` 是 numpy 的惯用别名，`self` 来自 Python 代码；唯一一个中文词元是 `一个`，4,740 次，我猜是因为这个词在汉语里到处都是。最后三个文件的“raw”和“stripped”两列是同一篇文章对整个文件和对剥离后的正文分词的词元数：`kalman-filter-01` 从 5,312 个降到 4,959 个，少了 6.6%；`gdb-debugging-guide` 24,422 到 23,691，少了 3.0%；`grep-ripgrep-search-guide` 3,494 到 3,293，少了 5.8%：这几个百分点就是 front matter 和 URL 里的词。

### 搜索结果变了什么

回到开头那条命令，先把 `ch01` 导出来，才能并排比较。`git archive` 只读仓库，不会改动工作区：

```text
$ rm -rf /tmp/sift-ch01 && mkdir -p /tmp/sift-ch01 && git archive ch01 | tar -x -C /tmp/sift-ch01 && ls /tmp/sift-ch01
bench
flake.lock
flake.nix
lab
LICENSE-APACHE
LICENSE-MIT
Makefile
README.md
ruff.toml
scripts
src
tests
```

`kalman` 的命中数从 23 降到了 6（`kalman-filter-01-one-dimension.md` 那一篇）。是丢了什么吗？我把这 23 次拆开：

```python
"""Why did kalman drop from 23 to 6 in one file?"""

import re
from pathlib import Path

from sift.analysis.tokenize import tokenize
from sift.markdown import split_front_matter, strip_markdown

path = Path("corpus/posts/kalman-filter-01-one-dimension.md")
text = path.read_text(encoding="utf-8")
front, body = split_front_matter(text)
plain = strip_markdown(body)
urls = re.findall(r"\]\(([^)]*)\)", body)
print("whole file, lower().count:", text.lower().count("kalman"))
print("front matter only:        ", front.lower().count("kalman"))
print("body, before stripping:   ", body.lower().count("kalman"))
print(
    "  of which in link URLs:  ", sum(u.lower().count("kalman") for u in urls)
)
print("body, after stripping:    ", plain.lower().count("kalman"))
print("token == 'kalman':        ", tokenize(plain).count("kalman"))
for line in front.splitlines():
    if "kalman" in line.lower():
        print("  front:", line[:70])
```

```text
$ python3 /tmp/scratch/kalman_count.py
whole file, lower().count: 23
front matter only:         2
body, before stripping:    21
  of which in link URLs:   15
body, after stripping:     6
token == 'kalman':         6
  front: commentId: "post:kalman-filter-01-one-dimension"
  front: slug: kalman-filter-01-one-dimension
```

整份文件里 `kalman` 出现 23 次。front matter 里 2 次（`commentId` 和 `slug`，是文件名的一部分）；正文剥离之前 21 次，其中 15 次在链接的 URL 里：这篇文章链到系列的其他文章，每个 URL 都含 `kalman-filter-...`；剥离之后 6 次。

第 1 篇里的“23”是 2 + 15 + 6，其中只有 6 次是读者能看到的文字。这是第 1 篇留下的一个小误差：我当时把 `lower().count` 的 23 当成了“出现次数”，它其实是“出现在文件里任何地方的次数”。同一个道理在 `rust` 上更明显：

```text
$ env PYTHONPATH=/tmp/sift-ch01/src python3 -m sift rust | sed -n 1,3p
   201  corpus/posts/rust-by-pebble-13-ffi-nostd.md
   165  corpus/posts/rust-by-pebble-08-rc-refcell-values.md
   152  corpus/posts/rust-by-pebble-01-first-crate.md
$ python3 -m sift rust | sed -n 1,3p
    93  corpus/posts/rust-by-pebble-13-ffi-nostd.md
    67  corpus/posts/rust-by-pebble-01-first-crate.md
    62  corpus/posts/rust-by-pebble-08-rc-refcell-values.md
```

201 变成 93。这一次我没有逐项拆这 108 个差：子串匹配的 `rustc`、`rustup`、`trust` 会算，front matter 和 URL 会算，换成精确词元之后这些都不算了，具体各占多少我没量。

中文的结果不那么让人高兴：

```text
$ env PYTHONPATH=/tmp/sift-ch01/src python3 -m sift 所有权 | sed -n 1,3p
     7  corpus/posts/rust-by-pebble-02-ownership.md
     6  corpus/posts/rust-by-pebble-08-rc-refcell-values.md
     5  corpus/posts/rust-by-pebble-12-vm-backends.md
$ python3 -m sift 所有权 | sed -n 1,3p
    23  corpus/posts/rust-by-pebble-08-rc-refcell-values.md
    21  corpus/posts/rust-by-pebble-14-concurrency-async.md
    20  corpus/posts/rust-by-pebble-01-first-crate.md
```

第 1 篇里搜“所有权”，第一名是 `rust-by-pebble-02-ownership.md`，7 次。这一次，它掉到了第 4：

```text
$ python3 -m sift 所有权 | grep -n ownership
4:    20  corpus/posts/rust-by-pebble-02-ownership.md
```

原因在于 `count_words` 把查询 `所有权` 切成 `所有` 和 `有权` 两个词元，然后把文档里**这两个词元任何一个**出现的次数加起来。拿现在的第一名 `rust-by-pebble-08-rc-refcell-values.md` 拆开看：

```python
"""Where do the bigram hits for 所有权 come from?"""

from collections import Counter
from pathlib import Path

from sift.analysis.tokenize import tokenize
from sift.markdown import split_front_matter, strip_markdown

path = Path("corpus/posts/rust-by-pebble-08-rc-refcell-values.md")
body = split_front_matter(path.read_text(encoding="utf-8"))[1]
plain = strip_markdown(body)
tokens = Counter(tokenize(plain))
print("所有:", tokens["所有"], "有权:", tokens["有权"])
print("所有权 as a string:", plain.count("所有权"))
around = Counter(
    plain[i : i + 3] for i in range(len(plain)) if plain.startswith("所有", i)
)
print(around.most_common(5))
```

```text
$ python3 /tmp/scratch/suoyou_why.py
所有: 17 有权: 6
所有权 as a string: 6
[('所有权', 6), ('所有者', 3), ('所有 ', 3), ('所有套', 1), ('所有数', 1)]
```

`所有` 17 次，`有权` 6 次，加起来就是上面的 23。可整串 `所有权` 只出现了 6 次：每一次真正的命中被数了两遍（`所有` 和 `有权` 各一次），另外 11 个 `所有` 是 `所有者`、`所有套` 这样的别的词。所以别的文章靠这些无关的词也能排到前面。要求 `所有` 和 `有权` **相邻**出现才算命中（短语匹配），需要知道词元的位置，这个版本不记位置，做不到。

同样的问题在多个词的查询里：

```text
$ env PYTHONPATH=/tmp/sift-ch01/src python3 -m sift kalman filter | sed -n 1,6p
    42  corpus/posts/kalman-filter-02-multivariate.md
    39  corpus/posts/kalman-filter-01-one-dimension.md
    34  corpus/posts/kalman-filter-08-porting.md
    30  corpus/posts/kalman-filter-07-ukf.md
    28  corpus/posts/kalman-filter-06-eskf.md
    28  corpus/posts/rust-by-pebble-12-vm-backends.md
$ python3 -m sift kalman filter | sed -n 1,6p
    17  corpus/posts/kalman-filter-02-multivariate.md
    12  corpus/posts/kalman-filter-07-ukf.md
    11  corpus/posts/kalman-filter-06-eskf.md
    10  corpus/posts/kalman-filter-08-porting.md
     7  corpus/posts/kalman-filter-01-one-dimension.md
     6  corpus/posts/rust-by-pebble-04-lifetimes-lexer.md
```

第 1 篇里第 6 名是 `rust-by-pebble-12-vm-backends.md`，28 次。现在前 5 名还是 5 篇卡尔曼滤波文章，第 6 名换成了 `rust-by-pebble-04-lifetimes-lexer.md`，6 次。它是怎么上来的？

```python
"""Why is a Rust post sixth for the query "kalman filter"?"""

from collections import Counter
from pathlib import Path

from sift.analysis.tokenize import tokenize
from sift.markdown import split_front_matter, strip_markdown

path = Path("corpus/posts/rust-by-pebble-04-lifetimes-lexer.md")
body = split_front_matter(path.read_text(encoding="utf-8"))[1]
counts = Counter(tokenize(strip_markdown(body)))
print("kalman:", counts["kalman"], "filter:", counts["filter"])
```

```text
$ python3 /tmp/scratch/who_filter.py
kalman: 0 filter: 6
```

一次 `kalman` 都没有，6 次 `filter`（迭代器的 `filter`）：两个词元的计数简单相加，一篇文章靠一个词就能上榜。精确词元把分数从 28 压到了 6，没有消除这个问题。把“两个词必须同时出现”和“稀有的词更值钱”做出来，才是真正的修复。

## 为什么慢了 33 倍

先把对照做干净。第 1 篇报的是 20.0 ms，我没有直接引用，而是用前面导出到 `/tmp/sift-ch01` 的 `ch01`，在同一个会话里和 `ch02` 并排量：

```text
$ hyperfine -N --warmup 3 --runs 20 'python3 -m sift kalman' 'env PYTHONPATH=/tmp/sift-ch01/src python3 -m sift kalman' 'python3 -c pass'
Benchmark 1: python3 -m sift kalman
  Time (mean ± σ):     603.5 ms ±   5.5 ms    [User: 588.1 ms, System: 11.4 ms]
  Range (min … max):   597.6 ms … 622.5 ms    20 runs

Benchmark 2: env PYTHONPATH=/tmp/sift-ch01/src python3 -m sift kalman
  Time (mean ± σ):      44.2 ms ±   1.4 ms    [User: 34.4 ms, System: 9.2 ms]
  Range (min … max):    42.4 ms …  47.2 ms    20 runs

Benchmark 3: python3 -c pass
  Time (mean ± σ):      17.4 ms ±   1.1 ms    [User: 12.0 ms, System: 4.9 ms]
  Range (min … max):    15.7 ms …  19.8 ms    20 runs

Summary
  python3 -c pass ran
    2.54 ± 0.18 times faster than env PYTHONPATH=/tmp/sift-ch01/src python3 -m sift kalman
   34.71 ± 2.26 times faster than python3 -m sift kalman
```

`hyperfine -N` 量整个进程，`ch02` 603.5 ms ± 5.5 ms，`ch01` 44.2 ± 1.4 ms，空的 `python3 -c pass` 17.4 ms。外面量的比值是 13.7 倍。程序自己的计时器只包住 `search()`，不含解释器启动：

```text
$ env PYTHONPATH=/tmp/sift-ch01/src python3 -m sift kalman | tail -3
     2  corpus/posts/pid-control-10-embedded.md
     1  corpus/posts/linear-algebra-17-orthogonal-matrices-gram-schmidt.md
searched 123 files in 17.4 ms
$ python3 -m sift kalman
     7  corpus/posts/kalman-filter-02-multivariate.md
     6  corpus/posts/kalman-filter-01-one-dimension.md
     6  corpus/posts/kalman-filter-07-ukf.md
     5  corpus/posts/kalman-filter-06-eskf.md
     5  corpus/posts/kalman-filter-08-porting.md
     1  corpus/posts/pid-control-09-lqr.md
     1  corpus/posts/pid-control-10-embedded.md
     1  corpus/posts/typst-by-xuan-15-wasm-plugin.md
searched 123 files in 575.7 ms
```

17.4 ms 对 575.7 ms，33 倍。两种口径差得多，是因为进程外面那一块固定开销（启动、`import`、退出）两边都是大约 27 ms（44.2 减 17.4，603.5 减 575.7），`ch01` 的搜索本身小到被它淹没了。第 1 篇说的 20.0 ms，和今天重新量的 17.4 ms 是同一份代码，不同的两次运行；我没有去追这 2.6 ms。

### 时间花在哪

我写了一个脚本，把 `count_words` 里的每一步拆出来单独计时。每一步的输入是上一步在内存里的输出，每一步跑三次取最快，所以它量的是“热的、纯粹的”计算：

```python
"""Where do the 575 ms of ch02 go? Time each stage on all 123 files."""

import time
import unicodedata
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from typing import Any

from sift.analysis.tokenize import _TOKEN, tokenize
from sift.markdown import split_front_matter, strip_markdown

paths = sorted(Path("corpus/posts").glob("*.md"))


def best(fn: Callable[[], Any], repeat: int = 3) -> tuple[float, Any]:
    """Return the best wall time of fn in ms, and its last result."""
    times = []
    for _ in range(repeat):
        start = time.perf_counter()
        result = fn()
        times.append((time.perf_counter() - start) * 1000)
    return min(times), result


t, texts = best(lambda: [p.read_text(encoding="utf-8") for p in paths])
print(f"{'read + decode':<22}{t:8.1f} ms")
t, bodies = best(lambda: [split_front_matter(x)[1] for x in texts])
print(f"{'split_front_matter':<22}{t:8.1f} ms")
t, plains = best(lambda: [strip_markdown(x) for x in bodies])
print(f"{'strip_markdown':<22}{t:8.1f} ms")
t, normed = best(lambda: [unicodedata.normalize("NFKC", x) for x in plains])
print(f"{'NFKC normalize':<22}{t:8.1f} ms")
t, folded = best(lambda: [x.casefold() for x in normed])
print(f"{'casefold':<22}{t:8.1f} ms")


def scan_only() -> int:
    """Run the regex but touch nothing in Python."""
    n = 0
    for x in folded:
        for _ in _TOKEN.finditer(x):
            n += 1
    return n


t, n_matches = best(scan_only)
print(f"{'finditer, empty loop':<22}{t:8.1f} ms  ({n_matches} matches)")
t, token_lists = best(lambda: [tokenize(x) for x in plains])
print(f"{'tokenize (all of it)':<22}{t:8.1f} ms")
t, _ = best(lambda: [Counter(ts) for ts in token_lists])
print(f"{'Counter':<22}{t:8.1f} ms")

chars = sum(len(x) for x in plains)
lines = sum(x.count("\n") + 1 for x in bodies)
print(f"plain chars {chars}, body lines {lines}")
print(f"tokens {sum(len(ts) for ts in token_lists)}")
t, _ = best(lambda: [x.lower() for x in texts])
print(f"{'str.lower (ch01)':<22}{t:8.1f} ms")
```

```text
$ python3 /tmp/scratch/breakdown.py
read + decode              8.0 ms
split_front_matter         9.1 ms
strip_markdown           153.9 ms
NFKC normalize            84.2 ms
casefold                   5.4 ms
finditer, empty loop     121.8 ms  (461146 matches)
tokenize (all of it)     348.4 ms
Counter                   37.0 ms
plain chars 2984458, body lines 94189
tokens 812338
str.lower (ch01)           5.7 ms
```

整理成一张表（分母是各步相加的 556.4 ms，比程序自己报的 575.7 ms 小 3%，因为脚本是热的、取最小值，真实运行是冷的）：

| 步骤 | 耗时 | 占比 | 每个单位 |
| --- | --- | --- | --- |
| 读文件并解码 | 8.0 ms | 1.4% | 123 个文件 |
| `split_front_matter` | 9.1 ms | 1.6% | |
| `strip_markdown`（13 个正则，逐行） | 153.9 ms | 27.7% | 94,189 行 |
| NFKC | 84.2 ms | 15.1% | 2,984,458 个字符 |
| `casefold` | 5.4 ms | 1.0% | |
| `finditer` 本身（循环体为空） | 121.8 ms | 21.9% | 461,146 次匹配 |
| 循环体：取组、`append`、切二元组 | 137.0 ms | 24.6% | 812,338 个词元 |
| `Counter` | 37.0 ms | 6.7% | |

“循环体”一行是我用减法得出来的：`tokenize` 整个 348.4 ms，减去 NFKC、`casefold`、`finditer` 三项的 211.4 ms，剩下 137.0 ms 就是 Python 层面的循环体。

用 `cProfile` 交叉验证一下调用次数（它自己会让程序变慢，下面第一行是 915.0 ms，大约 1.6 倍，所以只看次数、不看绝对值）：

```text
$ python3 -m cProfile -s tottime -m sift kalman | sed -n 9,24p
searched 123 files in 921.9 ms
         1912712 function calls (1912290 primitive calls) in 0.931 seconds

   Ordered by: internal time

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
      246    0.290    0.001    0.541    0.002 tokenize.py:18(tokenize)
   362505    0.152    0.000    0.152    0.000 {method 'sub' of 're.Pattern' objects}
      246    0.085    0.000    0.085    0.000 {built-in method unicodedata.normalize}
   527536    0.061    0.000    0.061    0.000 tokenize.py:36(<genexpr>)
      123    0.058    0.000    0.300    0.002 markdown.py:48(strip_markdown)
    88211    0.055    0.000    0.116    0.000 {method 'extend' of 'list' objects}
      123    0.042    0.000    0.042    0.000 {built-in method _collections._count_elements}
   461024    0.038    0.000    0.038    0.000 {method 'append' of 'list' objects}
    32955    0.034    0.000    0.169    0.000 markdown.py:35(_strip_inline)
   127364    0.030    0.000    0.030    0.000 {method 'match' of 're.Pattern' objects}
```

`tokenize` 被调用 246 次：123 个文档，加上 `count_words` 每处理一个文档就重新给查询词分一次词，又是 123 次。后者几乎免费（查询只有一个词），但它说明 `count_words` 把“准备查询”和“扫描文档”搅在了一起。我没有改它：这一篇只换了比较的方式，没有动 `count_words` 的形状，这笔账留着，等后面真的要碰它的时候再算。`re.Pattern.sub` 被调用 362,505 次，`match` 127,364 次。这两个数都能对上源码：`_strip_inline` 被调了 32,955 次，每次 9 个 `sub`，再加上每个这样的行还要过一次标题和一次引用的 `sub`，$32955 \times 11 = 362505$；`match` 是 94,189 行每行一次 `_FENCE`，加上 32,955 行加 220 个表格分隔线各一次 `_TABLE_RULE`，$94189 + 32955 + 220 = 127364$。也就是说，`strip_markdown` 的 94,189 行里，只有 32,955 行（35%）真的走了行内剥离，其余的差不多都是围栏里的代码行和围栏行自己：这份语料有大约三分之二的行是代码。

### 账单里的每一项

**正则，逐行逐模式（154 ms）。** 每次 `pattern.sub(...)` 或 `pattern.match(...)` 是一次从 Python 到 C 的调用，参数打包、结果字符串分配，每次大约 0.3 µs（153.9 ms 除以大约 49 万次调用，含循环自己的开销）。单次不贵，贵在次数：94,189 行乘以每行一次围栏检查，加上 32,955 行乘以 11 次。这是“用一个 Python 层的 `for` 逐行调用正则”的天然代价；一个更聪明的写法是给整篇文章写一个巨大的正则一次扫完，但那样可读性会差得多，我没有试。

**NFKC（84 ms）。** 这一项最让我意外，因为 `str.lower` 这类操作整个语料只要 5.7 ms。我查了 CPython 的源码（`Modules/unicodedata.c`，3.14.7 的标签）：

```c
static QuickcheckResult
is_normalized_quickcheck(PyObject *self, PyObject *input, bool nfc, bool k,
                         bool yes_only)
{
    /* UCD 3.2.0 is requested, quickchecks must be disabled. */
    if (UCD_Check(self)) {
        return MAYBE;
    }

    if (PyUnicode_IS_ASCII(input)) {
        return YES;
    }
    /* ... */
```

`unicodedata.normalize` 先做一次 quickcheck：如果整个字符串是纯 ASCII，立刻回答“已经是归一化的”，原样返回；否则逐个码点查表，只要有一个码点是“不是”或“不确定”，就放弃 quickcheck，对**整个字符串**走完整的分解、重排、重组。纯 ASCII 的检查是 $O(1)$ 的，因为 `str` 对象里有一个标志位记着“是不是 ASCII”，不用扫描。我用一个脚本验证：

```python
"""Does NFKC have a fast path? Compare is_normalized and normalize."""

import time
import unicodedata
from collections.abc import Callable
from pathlib import Path

from sift.markdown import split_front_matter, strip_markdown


def ms(fn: Callable[[], object]) -> float:
    """Return the best of 5 runs of fn in ms."""
    best = 1e9
    for _ in range(5):
        start = time.perf_counter()
        fn()
        best = min(best, time.perf_counter() - start)
    return best * 1000


plains = [
    strip_markdown(split_front_matter(p.read_text(encoding="utf-8"))[1])
    for p in sorted(Path("corpus/posts").glob("*.md"))
]
clean = [x for x in plains if unicodedata.is_normalized("NFKC", x)]
dirty = [x for x in plains if not unicodedata.is_normalized("NFKC", x)]
print(f"already NFKC: {len(clean)} files, {sum(map(len, clean))} chars")
print(f"not NFKC:     {len(dirty)} files, {sum(map(len, dirty))} chars")
norm = unicodedata.normalize
t_clean = ms(lambda: [norm("NFKC", x) for x in clean])
t_dirty = ms(lambda: [norm("NFKC", x) for x in dirty])
print(f"normalize on clean: {t_clean:.1f} ms")
print(f"normalize on dirty: {t_dirty:.1f} ms")
sample = dirty[0]
bad = {c for c in sample if norm("NFKC", c) != c}
print(sorted(bad)[:12])
ascii_text = "hello world " * 250_000
mixed = ascii_text + "，"
print(f"3M ascii:      {ms(lambda: norm('NFKC', ascii_text)):.2f} ms")
print(f"3M ascii + ，: {ms(lambda: norm('NFKC', mixed)):.2f} ms")
```

```text
$ python3 /tmp/scratch/nfkc_fast_path.py
already NFKC: 0 files, 0 chars
not NFKC:     123 files, 2984458 chars
normalize on clean: 0.0 ms
normalize on dirty: 87.2 ms
['（', '）', '，', '：', '；', '？']
3M ascii:      0.00 ms
3M ascii + ，: 30.63 ms
```

剥离之后的 123 篇正文，没有一篇“已经是 NFKC”。我只看了第一篇是为什么：里面被 NFKC 改动的字符是 `（`、`）`、`，`、`：`、`；`、`？`，全是全角标点。

```text
$ python3 -c 'import unicodedata; print(unicodedata.normalize("NFKC", "，（？"))'
,(?
```

NFKC 把它们换成了半角的对应字符。所以每篇都走完整路径，84 ms，每个字符大约 28 ns。最后两行是对照实验：300 万个字符的纯 ASCII 文本 0.00 ms；再加一个全角逗号，30.63 ms。**一个字符，让整段文本从零成本变成 10 ns 每字符。**

纯英文的博客会走快路径，几乎不花钱；一篇中文文章里只要出现一个 `，`，就得付全价。

**`casefold`（5.4 ms）。** 和 `lower` 几乎一样（5.7 ms）：对整块内存做一次 C 循环，每字符 1.8 ns（`lower` 是 1.7 ns）。同一个步骤，上面的 NFKC 是 28 ns，所以这一步没有任何值得优化的地方。

**`finditer` 和循环体（121.8 + 137.0 ms）。** 这是整张账单里最典型的 CPython 开销。`_TOKEN.finditer` 每找到一次匹配，就在堆上分配一个 `Match` 对象（它要记住原字符串、模式和每个组的起止位置），461,146 次，每次 264 ns。然后循环体里：`match["latin"]` 从原字符串里**切出一个新的 `str`**，`append` 把它放进列表；汉字段则是创建一个生成器，每个二元组 `run[i : i + 2]` 又是一次切片、一个新 `str`。我用 `tracemalloc` 量了 812,338 个词元占的内存：

```python
"""How much memory do 812k token objects take?"""

import tracemalloc
from pathlib import Path

from sift.analysis.tokenize import tokenize
from sift.markdown import split_front_matter, strip_markdown

texts = [
    p.read_text(encoding="utf-8")
    for p in sorted(Path("corpus/posts").glob("*.md"))
]
tracemalloc.start()
tokens: list[str] = []
for text in texts:
    tokens.extend(tokenize(strip_markdown(split_front_matter(text)[1])))
kept, peak = tracemalloc.get_traced_memory()
print(f"{len(tokens)} tokens, {len(set(map(id, tokens)))} distinct objects")
print(f"live after tokenizing: {kept / 1e6:.1f} MB, peak {peak / 1e6:.1f} MB")
print(f"per token: {kept / len(tokens):.0f} bytes (list slot included)")
shared = [t for t in tokens if len(t) == 1 and ord(t) < 256]
print(f"single-char latin-1 tokens: {len(shared)}, kinds: {len(set(shared))}")
```

```text
$ python3 /tmp/scratch/mem_tokens.py
812338 tokens, 712660 distinct objects
live after tokenizing: 46.8 MB, peak 46.9 MB
per token: 58 bytes (list slot included)
single-char latin-1 tokens: 99715, kinds: 37
```

46.8 MB，每个词元 58 字节（含列表里 8 字节的指针）；812,338 个词元里只有 712,660 个不同的 `str` 对象，差的 99,678 个是共享：Latin-1 范围内的单字符 `str` 在 CPython 里是缓存好的单例，脚本最后一行说有 99,715 个这样的单字符词元，一共 37 种，$99715 - 37 = 99678$，刚好对上。（这是我故意把整个语料的词元都留着才量出来的；`count_words` 实际上一篇一篇地处理，用完就丢。即便如此，每篇文章都要造一遍这些小对象。）整个语料读进内存是 7,071,249 字节，词元占的是它的 6.6 倍。

**`Counter`（37.0 ms）。** `Counter(list)` 内部调用 C 实现的 `_collections._count_elements`（上面 `cProfile` 里的那一行），对每个词元算哈希、查字典、加一。每个新造出来的 `str` 对象都没有缓存过哈希，所以要现算一遍，这是它占 6.7% 的主要原因，我猜，没有单独验证。

### 一个量级的比较

把 `ch01` 的两步和 `ch02` 的同类步骤放在一起：`ch01` 对 3,320,875 个字符调一次 `str.lower`（5.7 ms，每字符 1.7 ns），再对每个查询词调一次 `str.count`，两者都在 C 里扫内存。`ch02` 的 `tokenize` 对 2,984,458 个字符花 348.4 ms，每字符 116.7 ns，是前者的 68 倍。

分解开来，差异不是正则不好，也不是 Python 慢，而是**每个字符串操作的单位变了**：`lower` 和 `count` 的单位是“一整块文本”，一次调用扫几百万个字符；`tokenize` 的单位是“一个词元”，812,338 次，每次付一次 Python 层的调用开销、一个对象的分配、一次引用计数的增减。这个差距在 CPython 里随处可见，你以后读到“把循环搬进 C”（第 23 篇的性能优化、第 24 到 25 篇的原生扩展）的时候，说的就是这件事。

还有一件事值得记下来：账单里的 `strip_markdown`、`tokenize`、`Counter` 三项加起来是 539.3 ms，占各步总和的 97%，而它们都只取决于文档，跟查询词无关。换一个查询词，这 539 ms 一个字节都不会变，只是每次搜索都要重新付一遍。我猜把这些工作挪到查询之前，只做一次，一次搜索就能回到几毫秒的量级（还没量过，所以只是猜）。第 1 篇的基线（20 ms 左右，今天重量是 17.4 ms）现在更像一个对照：我们为了更准确的比较方式，付了 33 倍的价钱。

## 本篇文件

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`src/sift/markdown.py`](https://github.com/bfmhno3/sift/blob/ch02/src/sift/markdown.py) | `python3 -c 'from sift.markdown import strip_markdown'` | 退出码 0，没有输出；`wc -l` 为 74，13 个 `re.compile`；本篇之后基本不再变 |
| [`src/sift/analysis/tokenize.py`](https://github.com/bfmhno3/sift/blob/ch02/src/sift/analysis/tokenize.py) | `python3 -c 'from sift.analysis.tokenize import tokenize; print(tokenize("所有权 rust"))'` | 退出码 0，输出 `['所有', '有权', 'rust']`；37 行；之后会重组成迭代器和分析器，规则不变 |
| [`src/sift/analysis/__init__.py`](https://github.com/bfmhno3/sift/blob/ch02/src/sift/analysis/__init__.py) | `python3 -c 'import sift.analysis'` | 退出码 0，没有输出；1 行文档字符串，让 `analysis` 成为一个包 |
| [`src/sift/__main__.py`](https://github.com/bfmhno3/sift/blob/ch02/src/sift/__main__.py) | `python3 -m sift kalman` | 退出码 0，8 行命中加最后一行 `searched 123 files in 575.7 ms`；之后会拆出索引 |
| [`lab/ch02/code_points.py`](https://github.com/bfmhno3/sift/blob/ch02/lab/ch02/code_points.py) | `python3 lab/ch02/code_points.py` | 退出码 0，第一行 `'所有权': len(s) = 3, bytes = 9` |
| [`lab/ch02/encode_decode.py`](https://github.com/bfmhno3/sift/blob/ch02/lab/ch02/encode_decode.py) | `python3 lab/ch02/encode_decode.py` | 退出码 0，第一行 `utf-8       9 e6 89 80 e6 9c 89 e6 9d 83` |
| [`lab/ch02/decode_fail.py`](https://github.com/bfmhno3/sift/blob/ch02/lab/ch02/decode_fail.py) | `python3 lab/ch02/decode_fail.py` | 退出码 1：先打印 `cb f9 d3 d0 c8 a8`，再抛出 `UnicodeDecodeError: 'utf-8' codec can't decode byte 0xcb ...` |
| [`lab/ch02/normalize.py`](https://github.com/bfmhno3/sift/blob/ch02/lab/ch02/normalize.py) | `python3 lab/ch02/normalize.py` | 退出码 0，第一行 `False True` |
| [`lab/ch02/slicing.py`](https://github.com/bfmhno3/sift/blob/ch02/lab/ch02/slicing.py) | `python3 lab/ch02/slicing.py` | 退出码 0，第一行 `P e 与 Python 与 Unicode Pto  ncd edocinU 与 nohtyP` |
| [`lab/ch02/str_methods.py`](https://github.com/bfmhno3/sift/blob/ch02/lab/ch02/str_methods.py) | `python3 lab/ch02/str_methods.py` | 退出码 0，第一行 `['key', 'value', 'more']`，最后一行 `ratio += / join: 0.99` |
| [`lab/ch02/format_spec.py`](https://github.com/bfmhno3/sift/blob/ch02/lab/ch02/format_spec.py) | `python3 lab/ch02/format_spec.py` | 退出码 0，第一行 `[     3.142] [3.142     ] [  3.142   ] [+3.14e+00]` |
| [`lab/ch02/tstrings.py`](https://github.com/bfmhno3/sift/blob/ch02/lab/ch02/tstrings.py) | `python3 lab/ch02/tstrings.py` | 退出码 0，第一行 `Template ('hello ', ' and ', '')` |
| [`lab/ch02/regex_tour.py`](https://github.com/bfmhno3/sift/blob/ch02/lab/ch02/regex_tour.py) | `python3 lab/ch02/regex_tour.py` | 退出码 0，第一行 `['3.14', '2025', '10', '07', '3.13', '2024', '10', '07']` |
| [`lab/ch02/regex_catastrophic.py`](https://github.com/bfmhno3/sift/blob/ch02/lab/ch02/regex_catastrophic.py) | `python3 lab/ch02/regex_catastrophic.py` | 退出码 0，最后一行 `stop: n=24 took 1.25 s >= 1.0 s` |
| [`lab/ch02/bytes_views.py`](https://github.com/bfmhno3/sift/blob/ch02/lab/ch02/bytes_views.py) | `python3 lab/ch02/bytes_views.py` | 退出码 0，最后一行 `  memoryview 0.15 ms, ratio 266` |
| [`lab/ch02/tokenize_corpus.py`](https://github.com/bfmhno3/sift/blob/ch02/lab/ch02/tokenize_corpus.py) | `python3 lab/ch02/tokenize_corpus.py` | 退出码 0，第一行 `files: 123`，第三行 `tokens: 812338, distinct: 81192` |

`lab/ch02` 下一共 12 个实验，一个 `make` 目标全跑一遍，还有 `make lint`：

```text
$ make ch02
python3 scripts/chapter.py ch02
ok   lab/ch02/bytes_views.py
ok   lab/ch02/code_points.py
ok   lab/ch02/decode_fail.py
ok   lab/ch02/encode_decode.py
ok   lab/ch02/format_spec.py
ok   lab/ch02/normalize.py
ok   lab/ch02/regex_catastrophic.py
ok   lab/ch02/regex_tour.py
ok   lab/ch02/slicing.py
ok   lab/ch02/str_methods.py
ok   lab/ch02/tokenize_corpus.py
ok   lab/ch02/tstrings.py
$ make lint
ruff format --check --line-length 79 .
32 files already formatted
ruff check .
All checks passed!
```

`decode_fail.py` 这一行也是 `ok`，因为运行器知道 `_fail.py` 结尾的文件应该非零退出。计时类的实验（`str_methods.py`、`bytes_views.py`、`regex_catastrophic.py`）每次运行的数字会略有不同，形状不会变。`/tmp/scratch/` 里的一次性脚本不在仓库里，源码都贴在正文了。

## 练习

**1.** 先不要运行，预测下面三个函数哪几个是线性的，哪几个是平方级的，再把规模调到 10 万量一量，看和你的预测有多大差距：

```python
def a(s: str, n: int) -> str:
    for i in range(n):
        s += str(i)
    return s


def b(n: int) -> str:
    out = ""
    for i in range(n):
        out = str(i) + out
    return out


def c(n: int) -> str:
    out = ""

    def add(piece: str) -> None:
        nonlocal out
        out += piece

    for i in range(n):
        add(str(i))
    return out
```

`a` 里的 `s` 在调用方那里还有一个引用。`b` 把新片段拼在前面。`c` 里的 `out` 住在闭包里。把你的预测和上面 `unicode_modifiable` 的四个条件、`BINARY_OP_INPLACE_ADD_UNICODE` 要求的字节码形状对一对，再用 `dis` 看看 `c` 里的 `out += piece` 后面跟的是哪条存储指令。

**2.** 修好分词器的三个毛病，让下面的断言都成立，并且 `make lint` 仍然通过：`tokenize("café") == ["cafe"]`，`tokenize("こんにちは")` 不为空，`tokenize("𠮷野家")` 包含 `野家` 以外的东西。提示：`unicodedata.normalize("NFKD", ...)` 加 `unicodedata.combining`；假名、谚文的区间可以查 Unicode 的区块表；`\U00020000` 到 `\U0002a6df` 是扩展 B 区。然后数一下，改完之后词元数和 `python3 -m sift kalman` 的耗时各变了多少。

**3.** 在 `regex_catastrophic.py` 的基础上，把 `(a+)+$` 换成 `^(\w+\s?)*$`，输入换成 `"a" * n + "!"`，量出指数增长的底数（每多一个字符，时间乘几倍），然后用原子组或占有量词把它改成线性的，并拿 1000 个随机字符串对拍，证明改写前后匹配结果没有变。

**4.** 写一个 `read_text_guess(path: Path) -> str`：先试 `utf-8`，失败了试 `gb18030`，都失败了用 `errors="surrogateescape"` 的 `utf-8`，并且告诉调用方最后用了哪个编码。拿纯 UTF-8、GBK 中文、混着非法字节的三个文件测试。为什么不能把 `latin-1` 放在候选列表的最前面？把 `gb18030` 放在 `utf-8` 前面又会怎样：拿 UTF-8 编码的 `所有权` 试一试，再换几个别的汉字试一试，会一直报错，还是有时候悄悄成功？

## 下一篇

下一篇是《[容器：list、dict、set 的实现与代价](/posts/python-by-sift-03-containers/)》。这一篇里 `Counter` 和 `set` 悄悄出场了很多次：`Counter(tokens)` 在每个文档里数一遍词，`{token for word in words ...}` 造查询词的集合，`counts[token]` 查字典。它们在 37 ms 里数完了 812,338 个词元，字典是怎么做到的，是下一篇的内容；第 1 篇末尾我猜过，要把读文件这一步绕开，速度才会掉到个位数毫秒；绕开读文件之前，得先学会“把分词结果存下来”。

我猜等到系列结束，现在这 575.7 ms 会降到比 `ch01` 的 17.4 ms 还低，因为分词只在建索引时做一次。这只是猜，要等到下一篇把词元存进字典以后才有第一个数字（到时候我会假装没写过“慢了 33 倍”这几个字）。
