---
title: "原生扩展（下）：用 PyO3 写 Rust 扩展"
commentId: "post:python-by-sift-25-pyo3-rust"
published: "2026-10-27 06:00:00 +08:00"
description: "用 Sift 重学 Python 第 25 篇：我在 Python 3.14.7、rustc 1.97.1 (2024 edition)、PyO3 0.30.1 和 maturin 1.14.1 上，把上一篇的分词扫描循环用 Rust 重写一遍，经 PyO3 变成 Python 模块 sift._rs，再接进 sift index --tokenizer rust。在 4.6 MB 的语料上（859485 个词元，3 轮交替测量取中位数），纯 Python（第 22 篇的版本）1435.6 毫秒，Rust 879.9 毫秒（1.62 倍），Cython 589.5 毫秒（2.43 倍），ctypes 和 cffi 是 1.28 倍和 1.32 倍；释放 GIL 并开线程的 Rust 版本是 1.51 倍，比串行版本还慢。Rust 的扫描本身只要约 28 毫秒，把结果变成 859485 个 Python 对象要花 280 到 550 毫秒，这个账 Rust 也还不掉。文中还有 Rust 错误与 panic 到 Python 异常的映射、Python::detach 的实测伸缩曲线、类型存根与 mypy.stubtest，以及全系列 25 篇的特性索引。"
category: Tutorial
tags:
  - Rust
  - PyO3
  - maturin
  - 性能
series: "用 Sift 重学 Python"
seriesOrder: 25
draft: false
comment: true
slug: python-by-sift-25-pyo3-rust
---

上一篇的结论有点扫兴：把分词的扫描循环换成 C，ctypes 和 cffi 的版本比纯 Python 还慢，只有 Cython 赢了，因为 C 函数本身只花 15 毫秒，剩下的时间都在为 859485 个词元造 Python 对象。这一篇我把同一个循环原样再做一遍，换成 Rust，经 PyO3 和 maturin 变成一个 Python 模块。我想知道两件事：类型系统替我守住内存安全，能不能让这条路比手写 C API 轻松；账本会不会变。第二件事的答案是不会。Rust 版本比第 22 篇的纯 Python 快 1.62 倍，不是 100 倍，让它开线程还变慢了一点，原因和上一篇一样，只是这次我把每一段的毫秒数都拆开量了。

```text
$ python3 /tmp/sift-scratch/cpu_state.py
110 113 112 115 116 ms
$ python3 lab/ch25/final_bench.py | sed -n '1,19p'
source: corpus/posts, 123 files, 4614185 bytes
7 runs, median; every row folds in Python

token streams equal: 859485 tokens

== tokenize the corpus (fold included)
                      ms    ratio
python ch22       1410.5    1.00x
python ch23       1121.6    1.26x
ctypes            1098.5    1.28x
cffi              1058.1    1.33x
cython             589.5    2.39x
rust               877.0    1.61x
rust parallel      936.9    1.51x

fold alone (Python, inside every row): 96.8 ms
without fold:  rust 724.1 ms, rust parallel 916.3 ms, rust raw tuples 274.5 ms
```

> [!NOTE] 本篇检查点
> 这一篇结束时仓库处于标签 `ch25`（提交 `1155b5f`），同一个提交也带着标签 `tutorial-v1`，整个系列到此结束。改动共 19 个文件，`git diff --shortstat ch24 ch25` 给出 `19 files changed, 1181 insertions(+), 23 deletions(-)`。新增的有 Rust crate `rust/sift-rs/`（`Cargo.toml`、`Cargo.lock`、`pyproject.toml` 和 235 行的 `src/lib.rs`），Python 一侧的包装 `src/sift/ext/rs.py` 和类型存根 `src/sift/_rs.pyi`，`lab/ch25/` 下的 4 个 Python 脚本和 `extra.sh`。改写的有 `src/sift/cli.py` (`sift index --tokenizer rust`)、`src/sift/analysis/tokenizers.py`（新的分析器 `mixed-rust`）、顶层 `Makefile`（`make ext-rs`，`make lint` 加上 `cargo fmt` 和 `cargo clippy`，`make test` 加上 `cargo test`）和测试。整个测试套件是 `1244 passed, 1 skipped, 1 xfailed`，另有 2 个 `cargo test` 单元测试。
> 这是系列的最后一篇。末尾有一张索引表，把前 24 篇讲过的每个 Python 特性对应到它所在的那一篇。
> 涉及的 Python 与工具的特性：PyO3 的 `#[pyfunction]`、`#[pymodule]`、`Bound<'py, T>`、`Python<'py>` 与 `FromPyObject`、`maturin develop` 与 `maturin build`、`PYO3_BUILD_EXTENSION_MODULE`、`Python::detach` 与 `std::thread::scope`、`PyResult` 与 `PanicException`、`.pyi` 存根与 `mypy.stubtest`、自由线程构建上的模块声明。
> 前置：[第 24 篇](/posts/python-by-sift-24-c-extensions/)。分词与 NFKC（[第 2 篇](/posts/python-by-sift-02-text-and-unicode/)）、GIL 与线程（[第 16 篇](/posts/python-by-sift-16-threads-processes-gil/)）、类型存根（[第 14 篇](/posts/python-by-sift-14-type-system/)）、性能剖析（[第 23 篇](/posts/python-by-sift-23-profiling-performance/)）这一篇都会碰到。行为一律不变：换了实现，建出来的索引必须逐字节相同。Rust 一侧的所有权、`unsafe` 与线程另见 Pebble 系列的 [FFI 与 no_std](/posts/rust-by-pebble-13-ffi-nostd/) 和 [并发与 async](/posts/rust-by-pebble-14-concurrency-async/)。

## 环境

和前几篇同一台机器（16 个 CPU），仓库在标签 `ch25`，命令都在 `nix develop` 里、仓库根目录下跑。

```text
$ uname -r
6.18.57
$ python3 -VV
Python 3.14.7 (main, Aug  5 2026, 10:29:49) [GCC 15.3.0]
$ rustc --version && cargo --version && maturin --version
rustc 1.97.1 (8bab26f4f 2026-07-14) (built from a source tarball)
cargo 1.97.0 (c980f4866 2026-06-30)
maturin 1.14.1
$ grep -A1 'name = "pyo3"' rust/sift-rs/Cargo.lock | head -2
name = "pyo3"
version = "0.30.1"
$ mypy --version && pyright --version && hyperfine --version
mypy 2.1.0 (compiled: yes)
pyright 1.1.412
hyperfine 1.20.0
```

Rust 的依赖在 `Cargo.lock` 里固定，这个文件进了仓库，和第 1 篇的 `flake.lock` 是同一个想法。PyO3 的源码读的是 `~/.cargo/registry/src/` 里 0.30.1 的那份，文中的“`src/marker.rs` 第 562 行”这类引用指的都是它。

这台机器有快慢两个状态，所以每个计时的实验前后我都夹一次 `cpu_state.py`（第 23 篇的那个循环，快的时候 110 到 120 毫秒）。下文每一处读数都会写明夹的结果。

## 换掉的是什么

先把上一篇的结构摆回来，因为这一篇的每个数字都要放进它。`iter_tokens(text)` 做四件事：`fold`（NFKC 加 `casefold`，留在 Python）、扫描字符、把扫出来的串切成词元、为每个词元造一个 `Token` 对象。C 的三个版本只替换了第二、第三件事，返回的是字节偏移，Python 一侧的 `tokens_from_spans` 还要把字节偏移翻译成 `str` 偏移，第四件事始终在 Python 里。

Rust 版本的接口选得和 C 不一样，这是我动手前就想试的：

```text
tokenize(text: &str) -> Vec<(String, u32, u32, u32)>
                         文本   位置  起   止
```

Rust 的 `char` 就是一个 Unicode 码点，数 `char` 的个数就是 Python 的 `str` 偏移。扫描的时候我一边走一边数，所以出来的就是字符偏移，不需要“字节偏移与 `str` 偏移”那一整节的翻译，也不需要 `surrogatepass` 的编码小把戏（孤立代理项的问题换了个形状回来，见下文“接进 Sift”）。词元的文本也由 Rust 切好，返回时直接是一个 `str`。代价是 Rust 要为每个词元分配一个 `String`，之后 PyO3 再把它拷成 Python 的 `str`。这两处分配是不是账本的大头，后面会量。

## 最小的 PyO3 模块

在碰 Sift 的 crate 之前，`lab/ch25/extra.sh` 里的 `pyo3_hello` 先造了一个最小的模块：一个 `#[pyfunction]`，一个 `#[pymodule]`，放在临时目录里的一个全新虚拟环境中，用 `maturin develop` 构建、安装、导入、调用。输出在 `out/ch25/pyo3_hello.txt`，我删掉了脚本里 `sed` 抹掉路径的那部分，其余原样：

```text
$ cat src/lib.rs
use pyo3::prelude::*;

/// Greet `name` from Rust.
#[pyfunction]
fn greet(name: &str) -> String {
    format!("hello, {name}, from Rust")
}

#[pymodule]
fn hello(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(greet, m)?)
}
$ maturin develop   # in a new virtual environment
    Updating crates.io index
     Locking 14 packages to latest Rust 1.97.1 compatible versions
🐍 Found CPython 3.14 at /tmp/.../python
🔗 Found pyo3 bindings
   Compiling pyo3-ffi v0.30.1
   Compiling pyo3 v0.30.1
   Compiling hello v0.1.0 (/tmp/.../hello)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 4.82s
📦 Built wheel for CPython 3.14 to /tmp/.../hello-0.1.0-cp314-cp314-linux_x86_64.whl
✏️ Setting installed package as editable
🛠 Installed hello-0.1.0
$ python -c "import hello; ..."
__init__.py
hello, Sift, from Rust
Greet `name` from Rust.
(name)
```

输出里 `hello.__file__` 是 `__init__.py`：纯 Rust 项目的 `maturin develop` 会在 `site-packages/hello/` 里放一个只有 `from .hello import *` 的小包，真正的 `.so` 在它旁边（我在另一次构建里 `ls` 过）。Sift 用的是下面的混合布局，`.so` 直接落在 `src/sift/`，没有这层小包。

这十几行里有四个概念，PyO3 的整个模型就是它们。

**`#[pyfunction]`** 是一个过程宏。它把 `fn greet(name: &str) -> String` 原样留着，另外生成一个符合 CPython 调用约定的包装函数：从参数元组里取出每个参数，对每个参数调用 `FromPyObject::extract`，转换失败就立刻带着异常返回；调用 Rust 函数；再把返回值用 `IntoPyObject` 变成 Python 对象。`///` 文档注释成了 `greet.__doc__`，参数名成了 `__text_signature__`，上面输出的最后两行就是它们。函数返回 `PyResult<T>` 的时候，`Err(PyErr)` 会变成 Python 里抛出的异常，下文“错误与 panic”一节用到。

**`#[pymodule]`** 生成模块的初始化函数。`nm -D --defined-only src/sift/_rs.cpython-314-x86_64-linux-gnu.so | grep PyInit` 在 Sift 的库里只看到一个导出符号：`T PyInit__rs`，这是 CPython 导入 `_rs` 时 `dlopen` 之后去找的名字，所以 `Cargo.toml` 里的库名 `[lib] name = "_rs"` 必须和 `fn _rs` 一致。函数形式 `fn hello(m: &Bound<'_, PyModule>) -> PyResult<()>` 在 0.30.1 里编译通过，上面的输出就是证据；不过这版指南（`guide/src/module.md` 第 1 到 30 行）里的例子已经以 `#[pymodule] mod my_extension { ... }` 的内联形式开头，我在 Sift 里用的是函数形式，因为它把“往模块里加什么”写成了可以一行一行读的代码。

**`Bound<'py, T>`** 是 PyO3 里最重要的类型。它的定义在 `src/instance.rs` 第 74 行：

```rust
pub struct Bound<'py, T>(Python<'py>, ManuallyDrop<Py<T>>);
```

一个 `Python<'py>` 令牌加上一个拥有一份引用计数的 `Py<T>`。`Python<'py>`（`src/marker.rs` 第 358 行）是个零大小的类型，它的存在就是“当前线程持有 GIL”的证明，`'py` 是这个证明有效的时间段；`Bound<'py, T>` 不能活得比 `'py` 长，所以你不可能在释放了 GIL 的地方拿着它。`Drop` 时它会减引用计数。这两件事，也就是上一篇在 `sift_capi.c` 里用 `Py_INCREF` 和 `Py_DECREF` 手动维护的东西，和“没有 GIL 就不许碰对象”，在这里都变成了编译期的类型检查。`Py<T>` 是不带令牌的版本，可以跨线程存放，用的时候要先拿到 `Python<'py>` 才能变回 `Bound`。还有一个 `Borrowed<'a, 'py, T>`，指向别人持有的引用，不增减计数，参数提取就用它。

**转换**是 `FromPyObject` 和 `IntoPyObject` 两个 trait。Sift 的 crate 用到下面这些，我对着 0.30.1 的源码核对过：

| Python | Rust | 做了什么 | 源码 |
| --- | --- | --- | --- |
| `str` | `&str` | 借用，不拷贝，调用 `PyUnicode_AsUTF8AndSize` | `src/types/string.rs` 第 382 到 395 行；`src/conversions/std/string.rs` 第 125 到 133 行 |
| `str` | `String` | 拷贝成自己的 | `src/conversions/std/string.rs` 第 149 到 157 行 |
| `list[str]` | `Vec<String>` | 逐个元素提取，每个拷一份；`str` 本身不接受 | `src/conversions/std/vec.rs` 第 70 到 80 行 |
| `int` | `usize`、`u32` | 范围检查，超出就是 `OverflowError` | `src/conversions/std/num.rs` 第 62 到 65 行 |
| 返回 `Vec<(String, u32, u32, u32)>` | `list[tuple[str, int, int, int]]` | 每个词元一个元组、一个 `str`、三个 `int` | 同上各自的 `IntoPyObject` |

`&str` 那一行有一个我读源码才知道的细节：CPython 的 `str` 在内存里是 Latin-1、UCS-2 或 UCS-4（第 2 篇），不是 UTF-8。按我对 CPython 的了解（没有去读它的源码核对），`PyUnicode_AsUTF8AndSize` 对纯 ASCII 的串可以直接返回内部缓冲区，对其他串在第一次调用时生成一份 UTF-8 并缓存在 `str` 对象里。如果是这样，`tokenize(text: &str)` 对 ASCII 文本零拷贝，对含中文的文本是“第一次拷一份，之后免费”。如果文本里有孤立代理项，UTF-8 编码失败，这个函数就返回 `PyErr`，Rust 函数根本不会被调用。

`PyResult<T>` 就是 `Result<T, PyErr>`，所以 Rust 的 `?` 直接适用。整个模型就这些，其余（`#[pyclass]`、`#[pymethods]`、异步、泛型）Sift 用不上。

## 构建：maturin

`maturin develop` 做三件事：用 `cargo rustc` 构建 `cdylib`，把结果打成一个临时 wheel，再以“可编辑”的方式装进当前虚拟环境。上面输出的最后两行就是后两件。它默认走 `dev` profile（未优化，带调试信息），所以 `Makefile` 里写的是 `--release`：

```text
$ make ext-rs
cd rust/sift-rs && maturin develop --release
🍹 Building a mixed python/rust project
🐍 Found CPython 3.14 at /home/bfmhno3/Projects/sift/.venv/bin/python
🔗 Found pyo3 bindings
   Compiling pyo3-ffi v0.30.1
   Compiling pyo3 v0.30.1
   Compiling sift-rs v0.1.0 (/home/bfmhno3/Projects/sift/rust/sift-rs)
    Finished `release` profile [optimized] target(s) in 6.06s
📦 Built wheel for CPython 3.14 to /tmp/nix-shell.rTFe4r/.tmpBacsL6/sift_rs-0.1.0-cp314-cp314-linux_x86_64.whl
✏️ Setting installed package as editable
🛠 Installed sift-rs-0.1.0
```

这是依赖已经缓存、`pyo3` 重编译（因为我先改过 `lib.rs` 的时间戳）的一次，6.06 秒；只重编 `sift-rs` 自己时是 0.74 秒。第一行 `Building a mixed python/rust project` 来自 `rust/sift-rs/pyproject.toml` 里的两行：

```toml
[tool.maturin]
module-name = "sift._rs"
python-source = "../../src"
```

`module-name = "sift._rs"` 让模块进入 `sift` 包，所以可以 `import sift._rs`，文件落在 `src/sift/_rs.cpython-314-x86_64-linux-gnu.so`，紧挨着上一篇的 `src/sift/ext/` 里的那些 `.so`。`python-source` 指向 Python 源码的位置，这样 `maturin develop` 和第 11 篇的 `pip install -e` 对“`sift` 包在哪”的看法一致。`Cargo.toml` 的依赖只有一行：

```toml
[dependencies]
pyo3 = "0.30.1"
```

### 没有 `extension-module`

我最初写的依赖是 `pyo3 = { version = "0.30.1", features = ["extension-module"] }`，这是几年来每个 PyO3 教程的第一行。0.30.1 里这个特性还在，`Cargo.toml` 第 116 行：`extension-module = ["pyo3-ffi/extension-module"]`；但它已经过时了。`pyo3-build-config` 里判断是不是扩展模块的函数（`src/impl_.rs` 第 1653 到 1660 行，节选）：

```rust
/// - The `extension-module` Cargo feature (deprecated)
/// - Setting the `PYO3_BUILD_EXTENSION_MODULE` environment variable
pub fn is_extension_module() -> bool {
    cargo_env_var("CARGO_FEATURE_EXTENSION_MODULE").is_some()
        || env_var("PYO3_BUILD_EXTENSION_MODULE").is_some()
}
```

指南（`guide/src/building-and-distribution.md` 第 224 到 241 行）说得更直白：`maturin >= 1.9.4` 会自己设这个环境变量，用特性的老办法会让 `cargo test` 也不链接 `libpython`，所以建议迁移。我让 maturin 打印它实际执行的命令（`maturin develop --release -vv`，输出里有一行 `Running env -u CARGO PYO3_BUILD_EXTENSION_MODULE="1" PYO3_PYTHON=... "cargo" "rustc" "--profile" "release" ...`），确认是它设的。

这个变量到底改变了什么？我用同一份源码、两个独立的 `CARGO_TARGET_DIR` 各编了一遍，看动态库依赖了谁：

```text
$ cargo build --release            # CARGO_TARGET_DIR=t-plain
$ readelf -d t-plain/release/lib_rs.so | grep NEEDED
libpython3.14.so.1.0 libgcc_s.so.1 libc.so.6 ld-linux-x86-64.so.2
$ PYO3_BUILD_EXTENSION_MODULE=1 cargo build --release   # t-ext
$ readelf -d t-ext/release/lib_rs.so | grep NEEDED
libgcc_s.so.1 libc.so.6 ld-linux-x86-64.so.2
```

不设变量的库会把 `libpython3.14.so` 记成依赖。扩展模块应该用宿主解释器已经加载的那份 Python 符号，不能自己再链接一份（Linux 的 manylinux 规则也禁止），所以发布用的构建必须设变量。同时，`cargo test` 需要把 Python 链接进去，因为单元测试是一个会嵌入解释器的普通可执行文件。`Makefile` 的 `test` 目标因此能照常跑 `cargo test`，而 `rust_panic_fail.py` 里手动 `cargo build` 时要自己设 `PYO3_BUILD_EXTENSION_MODULE=1`（看文件第 31 行）。

### `maturin build`

`develop` 是给开发用的，发布用 `build`。同一个 crate：

```text
$ cd rust/sift-rs && maturin build --release -o /tmp/sift-scratch/ch25/wheels
🍹 Building a mixed python/rust project
🐍 Found CPython 3.14 at /home/bfmhno3/Projects/sift/.venv/bin/python
🔗 Found pyo3 bindings
    Finished `release` profile [optimized] target(s) in 0.02s
📦 Built wheel for CPython 3.14 to /tmp/sift-scratch/ch25/wheels/sift_rs-0.1.0-cp314-cp314-manylinux_2_34_x86_64.whl
$ python3 -m zipfile -l sift_rs-0.1.0-cp314-cp314-manylinux_2_34_x86_64.whl
File Name                                             Modified             Size
sift/_rs.cpython-314-x86_64-linux-gnu.so       ...     703008
sift_rs-0.1.0.dist-info/METADATA               ...        177
sift_rs-0.1.0.dist-info/WHEEL                  ...        109
sift_rs-0.1.0.dist-info/sboms/sift-rs.cyclonedx.json ... 17047
sift_rs-0.1.0.dist-info/RECORD                 ...        415
```

我把 `zipfile -l` 的时间列省略了。要点有三个。第一，wheel 的标签是 `manylinux_2_34`，不是 `develop` 临时 wheel 的 `linux_x86_64`：`build` 会检查库用到的 glibc 符号，给出能装的最低 glibc 版本（我没有读 maturin 的源码确认它怎么算的，这里只是观察）。第二，wheel 里只有 `.so` 和元数据，没有 `sift` 的 Python 文件：这个 wheel 要装在已经有 `sift` 包的环境里，把一个文件放进 `sift/` 目录，两个发行包共用一个包目录。这在开发环境里没问题，作为分发方式并不健康，我把它写进了文末的缺口。第三，wheel 280,639 字节，其中 `.so` 是 703,008 字节解压后的大小，和 `make ext-rs` 装进 `src/sift/` 的那个文件字节数相同。

## 谁来做 casefold

我给自己定的条件是：如果 Rust 里做不到和 `str.casefold` 完全一致，Rust 的函数就和 C 版本一样收下已经归一化的文本。`lib.rs` 开头的文档注释说：“没有任何 Rust crate 实现了与解释器的 Unicode 版本一致的 `str.casefold`，所以 Python 一侧来做”。动手前我不信这句话，因为 crates.io 上有 `caseless` 和 `unicode-normalization`。我写了一个临时的 crate（`/tmp/sift-scratch/ch25/foldlab`，不进仓库），函数就一个：

```rust
use pyo3::prelude::*;
use unicode_normalization::UnicodeNormalization;

/// NFKC, then full case folding, with the tables of two crates.
#[pyfunction]
fn fold(text: &str) -> String {
    caseless::default_case_fold_str(&text.nfkc().collect::<String>())
}
```

两个依赖固定在 `caseless = "=0.2.2"` 和 `unicode-normalization = "=0.1.26"`，对 Python 里的 `fold` 做穷举比较：每一个非代理项的码点各比一次，再比整个语料。

```text
$ python3 /tmp/sift-scratch/ch25/fold_parity.py
python unidata: 16.0.0
caseless tables: (16, 0, 0)
unicode-normalization tables: (18, 0, 0)
1112064 code points, 69 differ
first: ['U+0558', 'U+058B', 'U+058C', 'U+209D', 'U+209E', 'U+209F', 'U+A7F1', 'U+107BB']
unassigned in Python: 69
123 corpus files, 0 differ
```

所以那句注释不准确，我该改的是措辞，而不是 Sift：`caseless` 0.2.2 的表是 Unicode 16.0.0，和这台机器上 Python 3.14.7 的 `unicodedata.unidata_version` 一样；问题出在另一个 crate。`unicode-normalization` 0.1.26 的表是 Unicode 18.0.0，Python 的是 16.0.0。69 个码点不同，全部是在 Python 的数据库里还没有分配的码点（类别 `Cn`），Rust 一侧已经知道它们。语料上一个文件都不差。换句话说，对 Unicode 16 里有的字符这两边一致，这是 Unicode 的稳定性承诺，但只要解释器升级、或者 crate 的小版本升级，边界就会动，而 `sift index` 的承诺是“逐字节相同的索引”，这个承诺不应该依赖两个独立发布的表恰好同步。

值多少钱？我用同一个临时模块量了 Rust 的 `fold`（两个实现都对 123 个文件各调用一次，中位数，前后 `cpu_state` 是 `113 115 114 116 113` 和 `112 113 113 113 113`）：

```text
python fold 99.5 ms
rust fold   74.3 ms
```

省 25 毫秒，占下面要量的 880 毫秒的 3%。所以 Sift 的选择是：`fold` 留在 Python，Rust 的函数文档说明“收下已经归一化和 casefold 的文本”，原因写成“Rust 的表与解释器的 Unicode 版本不一定同步”才对。我没有改仓库里的那句注释（标签已经固定），在文末的缺口里记了一笔。

## 把循环写成 Rust

`rust/sift-rs/src/lib.rs` 的前 104 行是扫描本身，我一次贴完。它必须和 `iter_tokens` 的正则给出一模一样的词元，所以每一段都对应 Python 版本里的一个正则分支：拉丁词（`[0-9a-z_]+`，后面可以跟 `+`、`++` 或 `#`，为了 `c++` 和 `c#`），CJK 连续段（单个字符一个词元，两个以上变成二元组）。

```rust
/// A token: text, position, start and end in characters (end exclusive).
type Token = (String, u32, u32, u32);

fn is_latin(c: char) -> bool {
    matches!(c, '0'..='9' | 'a'..='z' | '_')
}

/// The CJK ranges of `src/sift/analysis/tokenize.py`.
fn is_cjk(c: char) -> bool {
    matches!(c, '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{f900}'..='\u{faff}')
}

/// The tokens of `text`, which is NFKC and casefolded already.
fn tokens(text: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut chars = text.char_indices().peekable();
    // Byte offsets of the characters of the CJK run being read, then
    // the offset just past the run.
    let mut run: Vec<usize> = Vec::new();
    let mut at: u32 = 0;
    let mut position: u32 = 0;

    while let Some((start, c)) = chars.next() {
        let first = at;
        at += 1;
        if is_latin(c) {
            let mut end = start + c.len_utf8();
            while let Some(&(i, next)) = chars.peek() {
                if !is_latin(next) {
                    break;
                }
                end = i + next.len_utf8();
                at += 1;
                chars.next();
            }
            // A suffix: `+`, `++` or `#`, as in c++ and c#.
            if let Some(&(i, '+')) = chars.peek() {
                end = i + 1;
                at += 1;
                chars.next();
                if let Some(&(j, '+')) = chars.peek() {
                    end = j + 1;
                    at += 1;
                    chars.next();
                }
            } else if let Some(&(i, '#')) = chars.peek() {
                end = i + 1;
                at += 1;
                chars.next();
            }
            out.push((text[start..end].to_owned(), position, first, at));
            position += 1;
        } else if is_cjk(c) {
            // ... collect the run into `run`, as the Latin branch does
            run.push(end);
            if run.len() == 2 {
                out.push((text[start..end].to_owned(), position, first, at));
                position += 1;
                continue;
            }
            // `run` holds the starts of the n characters and then the
            // end of the run: n - 1 bigrams, the last one ends at run[n].
            for i in 0..run.len() - 2 {
                let bigram = &text[run[i]..run[i + 2]];
                let from = first + i as u32;
                out.push((bigram.to_owned(), position, from, from + 2));
                position += 1;
            }
        }
    }
    out
}
```

我在 CJK 分支里省略了十二行（`run.clear()`、记下起点，以及把连续段收进 `run` 的 `while let` 循环，写法和拉丁分支的一样），用 `// ...` 标出了；其余是 `lib.rs` 里的原文。读 Rust 的人会注意到三件事。`text[start..end]` 是字符串切片，Rust 在运行时检查切点在字符边界上，切坏了会 panic（`char_indices` 给出的偏移保证是边界）。`out.push((... .to_owned(), ...))` 里的 `to_owned()` 就是上面说的每个词元一次分配。整个函数没有一个 `unsafe`：`grep -c unsafe rust/sift-rs/src/lib.rs` 打印 `0`。

模式匹配在这里干了 Python 里 `re` 干的活：`Some(&(i, '+'))` 一次完成“下一个字符存在、且是 `+`、并取出它的偏移”。我对着第 8 篇的 `match` 想了一会儿，两者做的是同一类事：把数据的形状直接写在判断里。

两个单元测试 (`cargo test`) 放在文件末尾，钉住后缀和二元组的边界：

```text
$ cd rust/sift-rs && cargo test 2>&1 | grep -E '^test |test result'
test tests::cjk_runs_become_bigrams ... ok
test tests::latin_keeps_its_suffix ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

真正的验证在 Python 一侧：`tests/test_ext.py` 把 `sift.ext.rs` 加进了和 C 版本共用的参数列表，所以第 24 篇的 127 个用例里和分词有关的那些现在也对 Rust 跑一遍；再加上新的专用测试，下面会看到。

## 接进 Sift

`#[pyfunction] fn tokenize` 只有三行，真正的契约在文档注释里：

```rust
#[pyfunction]
fn tokenize(text: &str) -> PyResult<Vec<Token>> {
    check_len(text)?;
    Ok(tokens(text))
}
```

`check_len` 在文本超过 `u32::MAX` 字节时返回 `ValueError`，因为偏移用的是 `u32`；这是为了让偏移不会静默回绕（4 GiB 的文本在我的机器上也建不出来，所以这条路径是靠读代码和 `check_len` 的结构保证的，没有跑过）。

Python 一侧的包装 `src/sift/ext/rs.py` 一共 52 行，整个贴在这里：

```python
"""The Rust tokenizer through PyO3: ``sift._rs`` from rust/sift-rs.

``make ext-rs`` builds it with maturin into the virtual environment.
Like the C twins it takes text that ``sift.analysis.tokenize.fold``
has already normalized: no Rust crate does ``str.casefold`` for the
Unicode version of this interpreter.

The Rust side returns plain tuples; this module turns them into Token.
A lone surrogate cannot become a Rust ``&str``, so PyO3 raises
UnicodeEncodeError; each surrogate is then replaced by U+FFFD, which
is no token and keeps every offset, and the call is repeated.
"""

import re
from collections.abc import Sequence

import sift._rs as _rs
from sift.analysis.tokenize import Token
from sift.ext import new_token

_SURROGATE = re.compile("[\ud800-\udfff]")


def _clean(text: str) -> str:
    """Return text with each lone surrogate replaced by U+FFFD."""
    return _SURROGATE.sub("\ufffd", text)


def tokens(folded: str) -> list[Token]:
    """Return the tokens of folded, which is NFKC and casefolded."""
    try:
        raw = _rs.tokenize(folded)
    except UnicodeEncodeError:
        raw = _rs.tokenize(_clean(folded))
    new = new_token
    return [new(Token, item) for item in raw]


def tokens_many(folded: Sequence[str], threads: int = 0) -> list[list[Token]]:
    """Return tokens(text) for each text, tokenized in parallel.

    The GIL is released while the Rust threads work. threads is the
    number of Rust threads; 0 means one per CPU. ValueError if it is
    more than 256.
    """
    texts = list(folded)
    try:
        raw = _rs.tokenize_many(texts, threads)
    except UnicodeEncodeError:
        raw = _rs.tokenize_many([_clean(text) for text in texts], threads)
    new = new_token
    return [[new(Token, item) for item in found] for found in raw]
```

两处值得停一下。孤立代理项在 Python 的 `str` 里合法（第 2 篇），在 Rust 的 `&str` 里不可能，因为 `&str` 必须是合法的 UTF-8。PyO3 在 `PyUnicode_AsUTF8AndSize` 失败时返回 `UnicodeEncodeError`，包装捕获它，把每个孤立代理项换成 U+FFFD（它既不是拉丁字符也不是 CJK，所以不产生词元，但占一个字符的位置，后面所有偏移不变），再调用一次。这是“出错再重试”，正常文本不付任何代价。第二，`new_token` 是第 24 篇 `ext/__init__.py` 里的 `tuple.__new__`，这一篇把它从私有的 `_new_token` 改成了公开的名字，因为 `rs.py` 也要用；`new(Token, item)` 把 Rust 给的普通元组包成 `Token` 这个具名元组，不进入生成出来的 `__new__`。

`tokenizers.py` 里新加的是 `RustMixedTokenizer`（名字 `mixed-rust`），`cli.py` 的 `TOKENIZERS` 字典多了一项 `"rust": "mixed-rust"`。它们都只有几行，在文末的表里。结果：

```text
$ SIFT_INDEX=idx-python sift index --full --tokenizer python
documents: 123
vocabulary: 81167
full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took N ms
$ SIFT_INDEX=idx-rust sift index --full --tokenizer rust
documents: 123
vocabulary: 81167
full rebuild: parsed 123, unchanged 0, removed 0; segment 2880196 bytes; took N ms
segment.sft python == rust: byte-identical
### sift index --full per tokenizer
Benchmark 1: python
  Time (mean ± σ):      2.996 s ±  0.030 s    [User: 2.798 s, System: 0.131 s]
  Range (min … max):    2.956 s …  3.036 s    5 runs
 
Benchmark 2: rust
  Time (mean ± σ):      2.784 s ±  0.025 s    [User: 2.609 s, System: 0.130 s]
  Range (min … max):    2.763 s …  2.823 s    5 runs
 
Summary
  rust ran
    1.08 ± 0.01 times faster than python
```

这是 `extra.sh` 里的 `index_tokenizers`（我把脚本里抹掉耗时的 `sed` 保留了，所以 `took N ms`）。两个 `segment.sft` 用 `cmp` 比较，逐字节相同；整条流水线只快了 8%，因为分词只占 `sift index --full` 的一小部分，这个比例和第 24 篇的 Cython（1.09 倍）差不多。运行前后 `cpu_state` 是 `113 115 116 116 116` 和 `118 115 116 117 116`。

## 错误怎么过边界

Rust 没有异常，函数用 `Result` 报告失败；Python 有，C 扩展要靠“返回 `NULL` 并设置异常状态”的约定（第 24 篇的 `sift_capi.c` 里每个出口都要想一遍）。PyO3 把这件事放进返回类型里：`#[pyfunction]` 返回 `PyResult<T>`，`Err(PyErr)` 就是 Python 里抛出的异常，宏生成的包装函数负责设置状态和返回 `NULL`。

`tokenize_many` 对线程数做了范围检查：

```rust
#[pyfunction]
#[pyo3(signature = (texts, threads = 0))]
fn tokenize_many(py: Python<'_>, texts: Vec<String>, threads: usize) -> PyResult<Vec<Vec<Token>>> {
    if threads > MAX_THREADS {
        return Err(PyValueError::new_err(format!(
            "threads must be between 0 and {MAX_THREADS}, got {threads}"
        )));
    }
    // ... check_len for each text, pick the thread count
    Ok(py.detach(move || tokens_many(&texts, threads)))
}
```

`PyValueError::new_err(...)` 构造的是一个 `PyErr`，类型是 `ValueError`，消息是格式化出来的串。`lab/ch25/rust_errors.py` 把几种失败各触发一次，错误有两个来源：Rust 代码自己返回的，和参数转换 (`FromPyObject`) 替它返回的。

```text
$ python3 lab/ch25/rust_errors.py
== PyResult::Err from Rust
tokenize_many(['a'], 257)          ValueError: threads must be between 0 and 256, got 257
tokenize_many(['a'], 256)          -> [[('a', 0, 0, 1)]]
isinstance ValueError: ValueError('threads must be between 0 and 256, got 1000')

== errors of the argument conversion
tokenize(b'abc')                   TypeError: 'bytes' object is not an instance of 'str'
tokenize_many('abc')               TypeError: Can't extract `str` to `Vec`
tokenize_many(['a'], -1)           OverflowError: can't convert negative int to unsigned
tokenize('a\ud800b')               UnicodeEncodeError: 'utf-8' codec can't encode character '\ud800' in position 1: surrogates not allowed

== the wrapper repairs the surrogate and the offsets stay
tokens('a\ud800中文') = [Token(text='a', position=0, start=0, end=1), Token(text='中文', position=1, start=2, end=4)]
```

对照表：

| 触发 | 来自 | Python 里看到 |
| --- | --- | --- |
| `threads` 大于 256 | Rust 代码里的 `PyValueError::new_err` | `ValueError`，消息是我写的 |
| 传了 `bytes` 给 `&str` | `&str` 的 `FromPyObject` | `TypeError` |
| 传 `str` 给 `Vec<String>` | `Vec<T>` 的提取（`vec.rs` 里特意拒绝 `str`） | `TypeError`（消息见上） |
| 线程数是 -1 | `usize` 的提取 | `OverflowError` |
| 孤立代理项 | `PyUnicode_AsUTF8AndSize` 失败 | `UnicodeEncodeError`，包装 `rs.py` 捕获并重试 |

第三行值得多想一秒：`str` 本身是一个字符序列，如果 `Vec<String>` 接受它，`tokenize_many('abc')` 会得到三个单字符的文本，悄悄地“能用”。PyO3 在 `vec.rs` 里写了专门的一行拒绝它，这类顾虑 Python 自己的 API 里也有（`str` 不该被当成字符串的序列）。

`rs.tokens_many(['a'], 1000)` 经过包装也还是 `ValueError`，因为包装只捕获 `UnicodeEncodeError`，其他异常原样穿过。

## panic：边界上的另一种失败

Rust 的 `panic!`（越界下标、`unwrap` 一个 `None`、`text[a..b]` 切在字符中间）如果沿着调用栈穿过 Python 的 C 帧展开，是未定义行为。PyO3 在每个 `#[pyfunction]` 的入口用 `std::panic::catch_unwind` 兜住（`src/impl_/trampoline.rs` 第 315 行），再把负载变成 Python 异常（同文件第 336 行的 `PanicException::from_panic_payload`）。这个异常的基类选得很有意思，`src/panic.rs` 第 7 到 17 行：

```rust
pyo3_exception!(
    "
The exception raised when Rust code called from Python panics.

Like SystemExit, this exception is derived from BaseException so that
it will typically propagate all the way through the stack and cause the
Python interpreter to exit.
",
    PanicException,
    PyBaseException
);
```

它继承 `BaseException`，不是 `Exception`。第 9 篇讲过两者的分界：`KeyboardInterrupt` 和 `SystemExit` 不该被 `except Exception` 吞掉，panic 也是，因为它说明 Rust 一侧的不变量已经被破坏，继续跑的程序状态不可信。

要看实际现象，需要一个会 panic 的函数。发布构建里不能有，所以 `lib.rs` 里的 `panic_for_lab` 只在 `#[cfg(debug_assertions)]` 下编译：

```rust
/// Panic on purpose, to see how PyO3 maps a Rust panic. Debug builds only.
#[cfg(debug_assertions)]
#[pyfunction]
fn panic_for_lab(message: &str) {
    panic!("{message}");
}
```

`lab/ch25/rust_panic_fail.py` 把 crate 以调试模式编进 `rust/sift-rs/target/lab`，拷成临时目录里的 `_rs.so` 再导入，不碰仓库里的发布版本。脚本以未捕获的异常结尾，所以按约定它的名字带 `_fail`，退出码必须非零：

```text
$ python3 lab/ch25/rust_panic_fail.py; echo "== exit $?"
debug build: ['panic_for_lab', 'tokenize', 'tokenize_many']
tokenize still works: [('c++', 0, 0, 3), ('中文', 1, 4, 6)]

thread '<unnamed>' (1377741) panicked at src/lib.rs:193:5:
boom from Rust
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
caught by `except BaseException`: pyo3_runtime.PanicException: boom from Rust
is an Exception: False
mro: ['PanicException', 'BaseException', 'object']
now the same panic, uncaught:

thread '<unnamed>' (1377741) panicked at src/lib.rs:193:5:
boom again, nobody catches it
Traceback (most recent call last):
  File "/home/bfmhno3/Projects/sift/lab/ch25/rust_panic_fail.py", line 71, in <module>
    main()
    ~~~~^^
  File "/home/bfmhno3/Projects/sift/lab/ch25/rust_panic_fail.py", line 67, in main
    debug.panic_for_lab("boom again, nobody catches it")
    ~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
pyo3_runtime.PanicException: boom again, nobody catches it
== exit 1
```


两行 `panicked at src/lib.rs:193:5` 是 Rust 的 panic 钩子写到 stderr 的，它先于 Python 的异常出现；`PanicException` 的消息是同一句话。捕获的那一行证明了 `except Exception` 接不住它 (`is an Exception: False`)，`mro` 是 `['PanicException', 'BaseException', 'object']`。另外，`rust_panic_fail.py` 最后那一次没人捕获，进程以退出码 1 结束，回溯指向调用 Rust 的那一行。

这对服务器意味着什么？任何 `except Exception` 的兜底（第 9 篇的错误层次就是为这个设计的）都不会拦住它。我觉得这是对的：我宁愿一个 Rust 的越界访问杀死请求线程，也不愿它被一个宽泛的 `except` 吞掉后继续服务。但这是取舍，不是定律，如果你的服务要求“任何一个请求崩溃都不影响其他请求”，就要在最外层显式写 `except BaseException`。

发布版本里没有 `panic_for_lab`，`dir(sift._rs)` 是 `['tokenize', 'tokenize_many']`；`tests/test_ext.py` 的 `test_rust_panic_is_a_base_exception` 在发布构建下 `pytest.skip`，这就是测试套件结果里那一个 skipped。

## 释放 GIL，开 Rust 线程

第 16 篇的结论是：CPU 密集的 Python 代码，线程帮不上忙，因为 GIL。C 扩展可以在不碰 Python 对象的区间里放掉 GIL（第 24 篇的 `Py_BEGIN_ALLOW_THREADS`）。PyO3 的对应物是 `Python::detach`，`tokenize_many` 的最后一行用的就是它。名字是新的：0.26.0 之前叫 `allow_threads`，`CHANGELOG.md` 第 581 行（`## [0.26.0] - 2025-08-29` 一节）写着 `Rename Python::allow_threads to Python::detach`，同一节里 `with_gil` 改名叫 `attach`。0.30.1 里它的签名在 `src/marker.rs` 第 562 行：

```rust
pub fn detach<T, F>(self, f: F) -> T
where
    F: Ungil + FnOnce() -> T,
    T: Ungil,
```

`Ungil` 的意思是“可以在没有 GIL 的地方存在”，在标准构建里它就是 `Send`（`src/marker.rs` 第 188 到 192 行：`unsafe impl<T: Send> Ungil for T {}`；第 99 到 110 行说明在 nightly 编译器上它会换成更严格的自动 trait）。这就是类型系统替我守的东西。我写了一个故意出错的函数，把一个 `Bound<'py, PyString>` 带进 `detach` 的闭包（在临时的 `foldlab` crate 里，不进仓库）：

```rust
// BAD: a Python object used where the GIL is released.
#[pyfunction]
fn bad<'py>(py: Python<'py>, text: Bound<'py, pyo3::types::PyString>) -> usize {
    py.detach(|| text.len().unwrap_or(0))
}
```

```text
error[E0277]: `*mut pyo3::Python<'static>` cannot be shared between threads safely
   --> src/lib.rs:36:15
    |
 36 |     py.detach(|| text.len().unwrap_or(0))
    |        ------ ^^^^^^^^^^^^^^^^^^^^^^^^^^ `*mut pyo3::Python<'static>` cannot be shared between threads safely
    |        |
    |        required by a bound introduced by this call
    |
    = help: within `pyo3::Bound<'_, PyString>`, the trait `Sync` is not implemented for `*mut pyo3::Python<'static>`
```

编译器的话不太直白（它在说 `Bound` 里装着的 `Python<'py>` 令牌含一个原始指针，所以不是 `Sync`），但意思是对的：在没有 GIL 的闭包里碰 `text`，是编译错误，不是上一篇那种“漏一次 `Py_DECREF`、一百万次调用之后才发现”。`tokenize_many` 能过编译，是因为 `texts: Vec<String>` 已经是 Rust 自己的数据，被 `move` 进了闭包。

`tokens_many` 是线程部分：

```rust
fn tokens_many(texts: &[String], threads: usize) -> Vec<Vec<Token>> {
    let next = AtomicUsize::new(0);
    let worker = || {
        let mut done: Vec<(usize, Vec<Token>)> = Vec::new();
        loop {
            let i = next.fetch_add(1, Ordering::Relaxed);
            let Some(text) = texts.get(i) else {
                break done;
            };
            done.push((i, tokens(text)));
        }
    };
    let parts: Vec<Vec<(usize, Vec<Token>)>> = if threads <= 1 {
        vec![worker()]
    } else {
        thread::scope(|scope| {
            let handles: Vec<_> = (0..threads).map(|_| scope.spawn(worker)).collect();
            handles
                .into_iter()
                .map(|handle| {
                    handle
                        .join()
                        .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
                })
                .collect()
        })
    };
    let mut out = vec![Vec::new(); texts.len()];
    for (i, found) in parts.into_iter().flatten() {
        out[i] = found;
    }
    out
}
```

`std::thread::scope` 是标准库自 1.63 就有的：作用域内 `spawn` 出来的线程可以借用外面的栈数据（这里的 `texts` 和 `next`），因为作用域保证在返回之前它们全部结束。不需要 `Arc`，不需要克隆文本。每个线程循环地从一个共享的原子计数器领下一个文本的下标，所以几篇很长的文章不会让别的线程闲着。结果带着下标收回来，按原顺序放回去，所以输出顺序不依赖线程调度。`resume_unwind` 把工作线程里的 panic 在调用线程上重新抛出，进而被 PyO3 兜住成 `PanicException`；我没有触发过这条路径，在练习里留着。Rust 的 `Send`、`Sync` 和作用域线程在 Pebble 系列的[并发与 async](/posts/rust-by-pebble-14-concurrency-async/)里有完整讲解，这里不重复。

放掉 GIL 要花多少？我在临时模块里写了两个函数，同样数 CJK 字符，一个直接数，一个包在 `py.detach` 里，`timeit` 取 5 次最小值（前后 `cpu_state` 是 `111 112 111 111 112` 和 `110 114 116 115 115`）：

```text
7 bytes       count_held                 60 ns
7 bytes       count_detached            100 ns
1800000 bytes count_held            1185981 ns
1800000 bytes count_detached        1176728 ns
```

`detach` 的固定开销约 40 纳秒（100 减 60），在 7 字节的文本上它使调用慢了三分之二；在 1.8 MB 的文本上，1.18 毫秒里的 40 纳秒看不见。这就是 `tokenize`（单个文本）保持持有 GIL、`tokenize_many` 才释放的原因，也是第 24 篇“先问每次过边界带多少活”的又一个例子。

### 它真的伸缩吗

`lab/ch25/gil_release.py` 把同一份活（语料的词元）用三种方式做，线程数 1、2、4、8，每个数取 5 次中位数，加速比是 1 个线程的时间除以 N 个线程的时间。第一种是 Python 线程跑 `iter_tokens`，第二种是 Python 线程各自调用 `tokenize_many(part, 1)`（每个调用只有一个 Rust 线程，GIL 在扫描时释放），第三种是一个 Python 线程调用 `tokenize_many(all, N)` 让 Rust 开 N 个线程。运行前后 `cpu_state` 是 `112 113 114 114 114` 和 `114 115 122 115 115`（有一个 122）。

```text
##### corpus: 123 texts, 4504242 bytes

== Python threads, iter_tokens (the GIL)
 threads        ms  speedup  tokens
       1     552.2    1.00x  859485
       2     638.5    0.86x  859485
       4     658.8    0.84x  859485
       8     682.5    0.81x  859485

== Python threads, tokenize_many(part, 1) (GIL released)
 threads        ms  speedup  tokens
       1     310.4    1.00x  859485
       2     290.8    1.07x  859485
       4     244.2    1.27x  859485
       8     242.1    1.28x  859485

== one Python thread, tokenize_many(all, N) (Rust threads)
 threads        ms  speedup  tokens
       1     274.7    1.00x  859485
       2     260.3    1.06x  859485
       4     246.8    1.11x  859485
       8     241.6    1.14x  859485
```

纯 Python 线程是倒退的，8 个线程 0.81 倍，这是第 16 篇的老结论（多半还有线程切换的开销，我没有拆开量）。Rust 的版本是向前的，但弯得厉害：8 个线程 1.28 倍。我花了点时间才弄明白为什么，数字在手：

- Rust 的扫描本身有多快？我把 `lib.rs` 拷到临时目录，加了一个读语料文件的 `#[ignore]` 测试，只计时 `tokens`，不碰 Python（`cargo test --release -- --ignored`，前后 `cpu_state` 是 `113 114 116 111 113` 和 `114 113 113 113 113`）：串行 28 到 36 毫秒（是否保留每个文本的结果，两次读数），16 个线程 7.8 毫秒。

```text
tokens 859485
serial, drop each: 35.6 ms
serial, keep all:  28.1 ms
16 threads, keep:  7.8 ms
```

- 所以 Rust 单独做这件事，4 到 4.5 倍的并行加速是有的。但是从 Python 调用，一次 `tokenize_many(all, 1)` 要 275 到 320 毫秒。扫描只占其中的十分之一左右，剩下的是把 `list[str]` 拷成 `Vec<String>`，和把 859485 个元组、字符串、整数造出来，这些都要持有 GIL，不可能并行。阿姆达尔定律：这时即使扫描变成零，也只能把 319 毫秒降到约 292 毫秒。

- 我观察到的 8 线程 1.28 倍比这个上限（约 1.1）还高，这个差我没有解释清楚。猜测是多个 Python 线程让对象创建和 GC 的开销摊开了，但我没有验证。

换一个相反的活：长的拉丁文本，几乎不产生词元。同样的三种方式，64 个文本、每个 2 MB 的 `xxxx...` 加空格，一共 128 MB，只有 25600 个词元。

```text
##### long runs: 64 texts, 128000000 bytes

== Python threads, iter_tokens (the GIL)
       1     184.4    1.00x  25600
       2     210.6    0.88x  25600
       4     218.4    0.84x  25600
       8     217.8    0.85x  25600

== Python threads, tokenize_many(part, 1) (GIL released)
       1     269.5    1.00x  25600
       2     162.2    1.66x  25600
       4     100.0    2.70x  25600
       8      79.0    3.41x  25600

== one Python thread, tokenize_many(all, N) (Rust threads)
       1     220.8    1.00x  25600
       2     203.2    1.09x  25600
       4     169.1    1.31x  25600
       8     148.5    1.49x  25600
```

这里扫描占了绝大部分，Python 线程各自调用的 Rust 版本伸缩到了 3.41 倍。但看第一列的 1 个线程：纯 Python 的 `iter_tokens` 是 184 毫秒，Rust 是 270 毫秒。它在这个活上更慢，我推测是因为 Python 的 `re` 本来就是 C 写的，而我的 Rust 是逐字符的 `char_indices` 加 `peekable`，外加先把 128 MB 拷成 `Vec<String>`（拷贝的账见下面）；我没有拆开验证前一半。最后一项我量了：把这 64 个 2 MB 的 `str` 逐个 `encode()` 一遍（同样是每个文本一次完整拷贝），中位数 55.1 毫秒。所以第三种方式（一个 Python 线程把全部文本一次交给 Rust）8 个线程只有 1.49 倍：这 55 毫秒的拷贝发生在 GIL 里、放掉 GIL 之前，占了 148.5 毫秒的三分之一以上。第二种方式里每个线程也要拷自己的那份，也在持有 GIL 的时候，但拷贝和别的线程已经放掉 GIL 的扫描重叠了。

一句话总结这一节：放掉 GIL 的前提是活多、对象少；`tokenize_many` 对分词这个活，只有“几乎不造对象”的输入才值得。

### 自由线程构建

第 16 篇讲过自由线程构建。PyO3 0.30 对模块的默认态度已经变了：`guide/src/free-threading.md` 第 39 行写着，0.23 到 0.27 的默认是 `gil_used = true`，现在反过来，模块默认声明自己不需要 GIL；`pyo3-macros-backend/src/module.rs` 第 421 行 `let gil_used = options.gil_used.is_some_and(|op| op.value.value);` 在没写选项时就是 `false`，也就是 `Py_mod_gil` 槽填“不使用 GIL”（第 24 篇的 `Py_mod_gil`）。我在 `nix develop` 里的 `python3.14t` 上验证了一遍：用临时的 `foldlab` crate 为它构建，导入前后看 `sys._is_gil_enabled()`。

```text
$ foldlab/venv-ft/bin/python -c "
> import sys
> print(sys.version.split()[0], 'gil enabled before:', sys._is_gil_enabled())
> import foldlab
> print('gil enabled after import:', sys._is_gil_enabled(), foldlab.fold('Straße'))"
3.14.7 gil enabled before: False
gil enabled after import: False strasse
$ foldlab/venv/bin/python -c 'import sys; print(sys._is_gil_enabled())'
True
```

导入没有让 GIL 重新打开（一个没声明的 C 扩展会触发这个，第 24 篇试过）。最后一行是普通构建，GIL 本来就开着。我没有在自由线程构建上跑 `sift._rs` 本身，也没有审计 `tokens` 以外的状态，不过 `lib.rs` 里没有全局可变状态，也没有 `unsafe`，这是它容易审计的原因。

## 类型存根

PyO3 编出来的 `.so` 里没有类型信息。mypy 和 pyright 看到 `import sift._rs` 会报“找不到存根”或者把所有东西当 `Any`（第 14 篇）。PyO3 有自动生成 `.pyi` 的功能，指南（`guide/src/type-stub.md` 第 1 到 4 行）写着“仍在积极开发”，需要 `experimental-inspect` 特性和构建工具的配合，所以我手写了 `src/sift/_rs.pyi`，12 行：

```python
"""Types of the PyO3 module built from rust/sift-rs (make ext-rs)."""

# (text, position, start, end): what sift.analysis.tokenize.Token holds.
type _RawToken = tuple[str, int, int, int]

def tokenize(text: str) -> list[_RawToken]: ...
def tokenize_many(
    texts: list[str], threads: int = 0
) -> list[list[_RawToken]]: ...

# Debug builds only: raises pyo3_runtime.PanicException.
def panic_for_lab(message: str) -> None: ...
```

`type _RawToken = ...` 是第 14 篇的 PEP 695 别名语法。存根手写的风险是它和 `.so` 对不上，所以 `lab/ch25/extra.sh` 里有 `stubs_check`：两个用 `sift._rs` 的文件，一个正确，一个故意写错，再加上 `mypy.stubtest`，它导入真实的模块，把存根里的每个名字和运行时对照。

```text
$ mypy --strict uses_rs_ok.py
Success: no issues found in 1 source file
$ mypy --strict uses_rs_bad.py   # five errors expected
uses_rs_bad.py:3: error: Argument 1 to "tokenize" has incompatible type "bytes"; expected "str"  [arg-type]
uses_rs_bad.py:4: error: Argument 1 to "tokenize_many" has incompatible type "str"; expected "list[str]"  [arg-type]
uses_rs_bad.py:5: error: Argument "threads" to "tokenize_many" has incompatible type "str"; expected "int"  [arg-type]
uses_rs_bad.py:6: error: Incompatible types in assignment (expression has type "list[tuple[str, int, int, int]]", variable has type "int")  [assignment]
uses_rs_bad.py:7: error: Module has no attribute "no_such_function"  [attr-defined]
Found 5 errors in 1 file (checked 1 source file)
mypy exit code: 1
$ pyright uses_rs_ok.py
0 errors, 0 warnings, 0 informations
$ pyright uses_rs_bad.py
  ... (six errors, same five and one more: reportUnknownMemberType for no_such_function)
6 errors, 0 warnings, 0 informations
$ python -m mypy.stubtest sift._rs
Success: no issues found in 1 module
```

pyright 的输出我缩成了一行说明，原文在 `out/ch25/stubs_check.txt`。多出来的第六条是 pyright 对 `no_such_function` 的 `reportUnknownMemberType`，同一行代码 mypy 只报一条。`stubtest` 带了一个白名单，里面只有两项：`sift._rs.panic_for_lab` 和 `sift._rs.__all__`。前者因为发布构建里没有这个函数，存根写了它（调试构建里有），stubtest 说它在运行时缺失；后者是编译出来的模块没有 `__all__`。其余名字、参数名和默认值（`threads: int = 0` 对 `(texts, threads=0)`）都对得上。为什么要 stubtest：我可以故意把存根里的 `threads` 改成 `workers` 来验证它会不会报，但这里我没有做，留作练习 2。

## 测试怎么钉住“一样”

上一篇的做法原样延续：同一个参数化列表，现在是四个原生模块。新加的用例有这些（`tests/test_ext.py`，`pytest -k rust` 能挑出全部）：

- `test_rust_many_gives_the_python_tokens_in_order`：线程数 0、1、2、7，对边界文本加 mini 语料，`tokens_many` 必须等于逐篇的 `iter_tokens`。
- `test_rust_many_gives_the_python_tokens_of_the_corpus`：标 `slow`，对完整的 123 篇再比一次。
- `test_rust_many_is_many_times_one`：hypothesis 生成文本列表（字母表里有 `+`、`#`、CJK、emoji 和一个孤立代理项）和线程数，`tokens_many` 必须等于对每个文本调用 `tokens`。
- 空列表、线程数 257 与 256、孤立代理项的 `UnicodeEncodeError`、错误类型的 `TypeError` 和 `OverflowError`，以及上面的 panic 测试。

整个套件现在是 `1244 passed, 1 skipped, 1 xfailed`，从 `ch24` 的 `1209 passed, 1 xfailed` 来，多了 35 个通过和那个只在调试构建里才跑的 skipped。`ruff format --line-length 79 --check .` 说 `405 files already formatted`，`ruff check .` 说 `All checks passed!`，`mypy` 是 `Success: no issues found in 64 source files`，`pyright` 是 `0 errors, 0 warnings, 0 informations`。Rust 一侧：`cargo fmt --check` 通过，`cargo clippy --all-targets -- -D warnings` 无警告，`cargo test` 两个测试通过。这些都进了 `make lint`、`make test` 和 `make ci`。

## 量：Rust 到底快了多少

`lab/ch25/final_bench.py` 把整个系列的所有分词实现放在一张表里：第 22 篇的纯 Python、第 23 篇之后的纯 Python、ctypes、cffi、Cython、Rust，以及让 Rust 开线程的 `tokens_many`。它先把所有实现的词元流和纯 Python 比一遍 (`token streams equal: 859485 tokens`)，不相等就抛 `AssertionError`，所以“快但错”的行不会出现在表里。第 22 篇的版本是用 `git show ch22:src/sift/analysis/tokenize.py` 取出来、`exec` 进一个临时模块的，所以这一行是真的老代码。每个数是 7 次的中位数，每一行都含同一个 `fold`（NFKC 加 `casefold`，留在 Python）。

脚本我交替跑了三次，前后各夹一次 `cpu_state.py`。六次读数是 `110 113 112 115 116`、`113 114 117 116 116`；`111 112 112 114 115`、`114 119 120 120 119`；`116 117 115 113 114`、`117 117 117 117 117`，最大是 120，在我定的 110 到 120 的边界上。开头那个代码块是第一次的前 19 行。三次的中位数，和三次各自的读数：

| 整个语料分词，毫秒（含 `fold`） | 中位数 | 相对 ch22 | 三次 |
| --- | --- | --- | --- |
| python ch22 | 1435.6 | 1.00 倍 | 1410.5、1448.4、1435.6 |
| python ch23 | 1156.9 | 1.25 倍 | 1121.6、1157.9、1156.9 |
| ctypes | 1113.0 | 1.28 倍 | 1098.5、1113.0、1122.3 |
| cffi | 1090.7 | 1.32 倍 | 1058.1、1108.8、1090.7 |
| cython | 589.5 | 2.43 倍 | 589.5、584.9、590.0 |
| rust | 879.9 | 1.62 倍 | 877.0、894.5、879.9 |
| rust parallel | 936.9 | 1.51 倍 | 936.9、933.7、1005.3 |
| 单独 `fold` | 96.9 | | 96.8、96.9、98.5 |

“相对 ch22”是每一轮自己的比值取中位数，因为只有同一轮里的几行是在同一个机器状态下量的。

先回答开头的问题。Rust 比第 22 篇的纯 Python 快 1.62 倍，比第 23 篇之后的快 1.29 倍；它在 ctypes 和 cffi 之上、Cython 之下。ctypes 和 cffi 相对第 22 篇是 1.28 倍和 1.32 倍，但相对第 23 篇之后的纯 Python (1156.9) 只差 4% 和 6%，而且符号不稳定：第 24 篇里它们比纯 Python 慢，下面的第二次测量里 ctypes 也又慢了 2%。我的读法是，它们和纯 Python 没有拉开差距，赢的是 Cython 和 Rust。让 Rust 开线程的 `rust parallel` 是 1.51 倍，比串行的 1.62 倍慢。如果有人问我“Rust 并行能快多少”，我现在的回答是：在这个接口下，不会更快。

### 这张表和第 24 篇的表为什么差这么多

第 24 篇里纯 Python 是 664.2 毫秒，这里是 1156.9 毫秒，Cython 342 对 589.5。机器状态一样（`cpu_state` 都在 110 到 120 之间），所以是量法不同。第 24 篇的 `tokenizer_bench.py` 对每个文本只取 `len(...)`，结果马上丢掉；`final_bench.py` 像 `IndexWriter` 一样把所有文本的词元列表都留着（它要把 123 个列表返回出来），而且前面做相等性检查时用的 `expected` 在整个计时过程中一直活着，里面有 859485 个 `Token`。我写了一个小脚本（`/tmp/sift-scratch/ch25/retain.py`，不进仓库）只改这一点，对同一份折叠后的语料量三种持有方式（前后 `cpu_state` 是 `112 114 114 114 130`，有一个 130，和 `115 116 116 116 116`）：

```text
                     keep     drop  keep, gc off
python ch23         913.3    642.6         697.4
rust                673.4    419.8         424.3

with 859485 live tokens in another list:
python ch23        1149.1    719.7
rust                906.1    484.1
```

“drop”就是第 24 篇的量法，“keep”是留着结果，“keep, gc off”是留着结果但在计时区间里 `gc.disable()`。丢掉结果的 Python 是 642.6 毫秒，和第 24 篇的 664.2 对得上；留着是 913.3；再让另一个列表里活着 859485 个 `Token`，就是 1149.1，和 `final_bench` 的 1121 到 1158 对得上。Rust 的三个读数（`rust` 行包含 `fold`）同理：906.1 对表里的 877 到 895。所以差别是量法，不是机器，也不是代码改过。所有绝对数字只能在同一张表、同一个量法里比，我下面用的都是这样。

为了确认量法对排序的影响，我把五行都按两种方式量了一遍（同一个脚本 `retain2.py`，也不进仓库，另一个列表里始终活着 859485 个 `Token`；前后 `cpu_state` 是 `112 115 115 117 116` 和 `113 112 118 113 117`）：

```text
                 drop     keep
python ch23     719.3   1161.1
ctypes          763.7   1184.9
cffi            733.5   1077.2
cython          329.4    588.0
rust            497.7    801.3
```

每一行都含 `fold`。两栏里 Rust 都是 Python 的 1.45 倍，Cython 是 2.18 倍和 1.97 倍，ctypes 和 cffi 在 Python 上下 7% 以内：丢掉结果时 ctypes 慢 6%、cffi 慢 2%（第 24 篇的方向），留着结果时 ctypes 慢 2%、cffi 快 7%。排序（Cython、Rust，然后是三个差不多的）不依赖量法，绝对数字依赖。

为什么持有结果这么贵？循环 GC。`gc.collect()` 前后各看一次 `gc.is_tracked`：

```text
fresh tuple tracked: True  Token tracked: True
after gc.collect: tuple False  Token True
```

Rust 给的普通元组只含字符串和整数，一次回收之后 GC 就不再追踪它了；`Token` 是元组的子类，永远追踪。859485 个被追踪的对象，每次老一代回收都要全部走一遍。这就是 580.3 对 327.0（下一小节）的差，也是“第 24 篇里我猜是 GC”的实测版。

### 时间花到哪儿去了

下面这张表对折叠好的语料（`fold` 不计时）只量 Rust 这一路的各层，前后 `cpu_state` 是 `118 114 115 115 115` 和 `115 116 116 116 116`：

```text
                            drop    keep  keep, gc off
_rs.tokenize (tuples)      166.3   248.0         216.7
rs.tokens (Token)          304.0   580.3         327.0
tokenize_many(1) tuples            319.0
tokenize_many(16) tuples           275.5
```

再加上前面纯 Rust 里的数字：只扫描，不碰 Python，28 到 36 毫秒。把它们叠起来：

- 扫描：约 30 毫秒，每个词元约 35 纳秒。
- 变成 Python 的元组、`str`、`int` (`_rs.tokenize`)：再加 130 毫秒（丢弃结果时）到 220 毫秒（留着）。我数了数，每个词元是一个元组、一个 `str`、三个 `int`；`position`、`start`、`end` 在 859485 个词元里大多超过小整数缓存的范围，所以多半每个都是新分配（这是我的推断，没有逐个检查）。
- 再包成 `Token` (`rs.tokens`)：又加 138 毫秒（丢弃）到 330 毫秒（留着），因为 `tuple.__new__(Token, item)` 为每个词元再分配一个对象并拷贝一遍元组，原来的元组随即成为垃圾。
- 关掉 GC 的“keep”是 327.0，只比“drop”的 304.0 多 23 毫秒；开着 GC 是 580.3。多出来的 253 毫秒就是 GC。
- 16 个线程的 `tokenize_many` 是 275.5，一个线程是 319.0；扫描并行省下的只是 43 毫秒。

所以 Rust 的账是这样的：做真正的活 30 毫秒，为 859485 个对象付 270 到 550 毫秒。第 24 篇里 C 的 15 毫秒对 Cython 的 243 毫秒是同一个故事，只是这次我能把每一层各自的数写出来。`rust parallel` 比串行慢，也看得清：并行版本必须先把所有 123 个文本拷成 `Vec<String>`，等所有线程做完，再一次性建出所有 Python 对象，建对象的那一段不能与任何东西重叠，它的“without fold”读数 914.5 比串行的 718.5 多了近 200 毫秒（`final_bench` 的第三行，三次中位数）；多出来的这部分，我推测是一次性持有全部结果导致的 GC 压力，没有再拆开验证。

另一张表是只数 CJK 字符的任务，这是几乎不造对象的活，C API 模块 1.0 毫秒的那个，Rust 版本没有这个函数，所以表里没有 Rust 的行：

| 数整个语料的 CJK 字符，毫秒 | 中位数 | 相对正则 | 三次 |
| --- | --- | --- | --- |
| 正则 | 39.5 | 1.00 倍 | 39.5、38.5、39.7 |
| ctypes | 15.3 | 2.59 倍 | 15.3、15.0、15.3 |
| cffi | 15.1 | 2.61 倍 | 15.1、14.9、15.2 |
| Cython | 5.1 | 7.73 倍 | 5.1、5.3、5.1 |
| C API | 1.0 | 40.2 倍 | 1.0、1.0、1.0 |

和第 24 篇的 38.2、17.7、17.8、5.1、1.0 是同一个量级，C API 的 40 倍对应当时的约 38 倍。

### 一次调用的固定开销

最后是第 24 篇那张“每次调用要多少纳秒”的表的 Rust 版。同一个 7 字节的文本（`ab`、一个汉字、`cd`），`timeit` 取 5 次最小值（前后 `cpu_state` 是 `112 114 112 113 113` 和 `112 114 114 113 113`）：

```text
def f(t): return t           38 ns
list(iter_tokens)          2322 ns
ctypes tokens              6650 ns
cffi tokens                4393 ns
cython tokens               609 ns
_rs.tokenize                341 ns
rs.tokens                   808 ns
ctypes count_cjk            663 ns
capi count_cjk               39 ns
```

这个文本产生 3 个词元。`_rs.tokenize` 返回 3 个元组要 341 纳秒，`rs.tokens` 把它们包成 `Token` 再加 467 纳秒，每个词元约 150 纳秒，与语料上每个词元 160 纳秒（138 毫秒除以 859485）一致。ctypes 和 cffi 的 `tokens` 这么慢（6.6 和 4.4 微秒）是因为它们还要 `encode`、分配缓冲区、调用后把字节偏移翻译回字符偏移，Cython 是 609。`count_cjk` 一行的 `capi` 39 纳秒，与函数调用本身（38 纳秒）几乎一样，因为它返回一个整数，不造对象。PyO3 的固定开销我没有单独量，341 纳秒包括了 3 个元组和 3 个字符串的创建。

## 什么时候该用 Rust，什么时候是 numpy 或 C

在这个系列里，我对“要不要写原生代码”的答案一直是：先改算法，再用标准库已经有的 C，再用 numpy 这样的库把循环变成整体操作，最后才是自己写。最后一步里选哪个，我现在的想法如下，每一条都是这两篇里量到的：

- **同一个任务，numpy 能不能做？** 数 CJK 字符这个活，我用 numpy 写了一遍（`/tmp/sift-scratch/ch25/numpy_cjk.py`，不进仓库）：先 `encode("utf-32-le")` 再 `np.frombuffer` 成 `uint32` 数组，三个范围比较，`np.count_nonzero`。numpy 2.5.1，三个结果都是 559079：

```text
regex     35.8 ms    1.00x  559079
numpy     12.7 ms    2.81x  559079
capi       1.0 ms   36.45x  559079
```

前后 `cpu_state` 是 `113 116 114 115 116` 和 `113 119 115 128 113`（有一个 128，数字与上面的表一致）。numpy 比正则快 2.8 倍，不用编译器，不用构建步骤，代码 7 行；C API 比它又快 12 倍，因为它不拷贝文本。这是“能表达成对数组的整体操作”的情况：数据本来就是数组。但分词不是：它产出变长的、有状态的结果，没有一个自然的 `ndarray` 形状，所以 numpy 在这里不适用。

- **瓶颈是不是造对象？** 如果是，换语言不会救你，上面所有的数都在说这个。把接口换成“返回偏移数组”（第 24 篇的设计方向）才会。到那时，Rust、C 和 Cython 谁写这个循环才有区别。
- **需不需要线程？** 这是 Rust 真正比 C 好的地方：`thread::scope` 加 `Send` 检查，让“多线程扫描 123 个文本”的代码是 30 行安全的 Rust，没有一个锁，没有一次 `unsafe`，写错了编译器就拒绝。在 C 里这是 pthread、手动加锁和 ASan 之外再加 TSan。但是上面也看到了，从 Python 看，这个好处只有在每次调用做的活足够大、对象足够少时才兑现。
- **需不需要生态？** 这一点我没量，但在选型时我觉得它最重要：Rust 有 crates.io，像 `unicode-normalization`、`regex`、`serde` 这样的库可以直接拿来用，pydantic 的核心（第 18 篇）就是这样的 Rust 加 PyO3。C 有更古老的库，Python 绑定要靠 ctypes 或 cffi。
- **内存安全？** `lib.rs` 里 `unsafe` 的数量是 0；上一篇的 `sift_tok.c` 需要 ASan 和 UBSan 的 20 万轮模糊测试才敢说没有越界。我同意这是大优势，但不是免费的：越界在 Rust 里变成 `panic`，而 panic 到 Python 里是 `PanicException`，不是静默的错误。

如果让我给一个顺序：能写成对数组的整体操作，就用 numpy；已经有 C 库，就用 cffi（API 模式）包它；要写新的热点循环，数据是整数或字节，不造很多对象，Rust 和 C API 都行，我会选 Rust，因为我不想维护引用计数；循环不得不产出大量 Python 对象，先改接口。这是一个有倾向的排序，不是定理，我没有在别的项目上验证它。

## 留下的缺口

- `lib.rs` 的文档注释说“没有 Rust crate 实现与解释器的 Unicode 版本一致的 `str.casefold`”，这和上面的实验不符：`caseless` 的表是 Unicode 16，与 Python 3.14.7 一致，问题在于 `unicode-normalization` 的表是 18。决定（`fold` 留在 Python）没变，措辞该改，标签已经固定，我没有动仓库。
- Rust 的 `fold` 我只在临时 crate 里量了（74.3 对 99.5 毫秒），没有接进 `sift index`。
- `tokenize` 单个文本不释放 GIL（7 字节上 `detach` 的开销是 40 纳秒，对一般文本不值得）。我没有量过多大的文本才值得。
- 8 个线程 1.28 倍超过阿姆达尔上限（约 1.1）的那个差，我没有解释清楚。
- 工作线程里的 panic 我只读了代码（`resume_unwind` 在调用线程上重抛），没有触发。
- 超过 4 GiB 的文本，`check_len` 的路径我没有跑过。
- 自由线程构建：只验证了一个临时模块导入后 GIL 保持关闭，没有在 `python3.14t` 上跑 `sift._rs` 本身，更没有测线程伸缩。
- 打包：`maturin build` 出的 wheel 只有一个 `.so`，装进一个已有 `sift` 包的环境，两个发行包共用 `sift/` 目录；没有做 `abi3`（这个 wheel 只适用于 CPython 3.14），没有在 macOS 和 Windows 上构建，也没有上传到 PyPI。CI 只是 `make corpus ci`，其中 `ci` 现在依赖 `ext-rs`。
- `Token` 对象被造了两遍（Rust 给的元组，再包成 `Token`）。让 Rust 直接构造 `Token`，或者返回偏移数组，是下一步的优化，我没有做，也没有量。
- 我没有读 maturin 的源码确认 wheel 标签 `manylinux_2_34` 是怎么算出来的，也没有核对 CPython 里 `PyUnicode_AsUTF8AndSize` 的缓存行为。
- Python 的 `re` 为什么在长串上比我的逐字符循环快，是推测。

## 本篇文件

这一章动了 19 个文件，`git diff --shortstat ch24 ch25` 给出 `19 files changed, 1181 insertions(+), 23 deletions(-)`。表里的 `+N -M` 来自 `git diff --numstat ch24 ch25`，命令是跑它对应的测试或脚本，结果是我在标签 `ch25` 上最后一次实际跑出来的（计时类的脚本，表里挑的是不带计时的那一行）；`/tmp/sift-scratch/ch25/` 里的草稿脚本和临时 crate 不进仓库，不在表里。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`Makefile`](https://github.com/bfmhno3/sift/blob/ch25/Makefile) | `make -n ext-rs` | `cd rust/sift-rs && maturin develop --release`；`+15 -3` |
| [`README.md`](https://github.com/bfmhno3/sift/blob/ch25/README.md) | `grep -c "ext-rs" README.md` | `4`；`+16 -3` |
| [`extra.sh`](https://github.com/bfmhno3/sift/blob/ch25/lab/ch25/extra.sh) | `bash lab/ch25/extra.sh > /dev/null; grep -c byte-identical out/ch25/index_tokenizers.txt` | `1`；`+144 -0`；整个脚本约 56 秒 |
| [`final_bench.py`](https://github.com/bfmhno3/sift/blob/ch25/lab/ch25/final_bench.py) | `python3 lab/ch25/final_bench.py \| sed -n 4p` | `token streams equal: 859485 tokens`；`+141 -0`；一次约 75 秒 |
| [`gil_release.py`](https://github.com/bfmhno3/sift/blob/ch25/lab/ch25/gil_release.py) | `python3 lab/ch25/gil_release.py \| sed -n 2p` | `cpus: 16, runs: 5, median`；`+143 -0`；一次约 37 秒 |
| [`rust_errors.py`](https://github.com/bfmhno3/sift/blob/ch25/lab/ch25/rust_errors.py) | `python3 lab/ch25/rust_errors.py \| sed -n 2p` | `tokenize_many(['a'], 257)          ValueError: threads must be between 0 and 256, got 257`；`+55 -0` |
| [`rust_panic_fail.py`](https://github.com/bfmhno3/sift/blob/ch25/lab/ch25/rust_panic_fail.py) | `python3 lab/ch25/rust_panic_fail.py 2>&1 \| grep '^mro'` | `mro: ['PanicException', 'BaseException', 'object']`；`+71 -0`；脚本退出码是 1 |
| [`Cargo.lock`](https://github.com/bfmhno3/sift/blob/ch25/rust/sift-rs/Cargo.lock) | `grep -c '^name = ' rust/sift-rs/Cargo.lock` | `15`；`+132 -0` |
| [`Cargo.toml`](https://github.com/bfmhno3/sift/blob/ch25/rust/sift-rs/Cargo.toml) | `grep '^pyo3' rust/sift-rs/Cargo.toml` | `pyo3 = "0.30.1"`；`+14 -0` |
| [`pyproject.toml`](https://github.com/bfmhno3/sift/blob/ch25/rust/sift-rs/pyproject.toml) | `grep '^module-name' rust/sift-rs/pyproject.toml` | `module-name = "sift._rs"`；`+16 -0` |
| [`lib.rs`](https://github.com/bfmhno3/sift/blob/ch25/rust/sift-rs/src/lib.rs) | `cd rust/sift-rs && cargo test 2>&1 \| grep 'test result'` | `test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s`；`+235 -0` |
| [`_rs.pyi`](https://github.com/bfmhno3/sift/blob/ch25/src/sift/_rs.pyi) | `pyright src/sift/_rs.pyi \| tail -n 1` | `0 errors, 0 warnings, 0 informations`；`+12 -0` |
| [`analysis/tokenizers.py`](https://github.com/bfmhno3/sift/blob/ch25/src/sift/analysis/tokenizers.py) | `python3 -m pytest tests/test_ext.py -k analyzers_match \| tail -n 1` | `4 passed, 158 deselected in 0.80s`；`+15 -1` |
| [`cli.py`](https://github.com/bfmhno3/sift/blob/ch25/src/sift/cli.py) | `python3 -m pytest tests/test_cli.py -k index_tokenizer \| tail -n 1` | `7 passed, 160 deselected in 1.40s`；`+7 -4` |
| [`ext/__init__.py`](https://github.com/bfmhno3/sift/blob/ch25/src/sift/ext/__init__.py) | `python3 -m pytest tests/test_ext.py -k edge_texts \| tail -n 1` | `48 passed, 114 deselected in 1.22s`；`+6 -5` |
| [`ext/rs.py`](https://github.com/bfmhno3/sift/blob/ch25/src/sift/ext/rs.py) | `python3 -c "from sift.ext import rs; print(rs.tokens('c++ 搜索引擎')[0])"` | `Token(text='c++', position=0, start=0, end=3)`；`+52 -0` |
| [`conftest.py`](https://github.com/bfmhno3/sift/blob/ch25/tests/conftest.py) | `python3 -m pytest tests/test_ext.py -k rejects_other_types \| tail -n 1` | `1 passed, 161 deselected in 0.75s`；`+6 -3` |
| [`test_cli.py`](https://github.com/bfmhno3/sift/blob/ch25/tests/test_cli.py) | `python3 -m pytest tests/test_cli.py -k index_tokenizer_gives \| tail -n 1` | `4 passed, 163 deselected in 1.31s`；`+2 -1` |
| [`test_ext.py`](https://github.com/bfmhno3/sift/blob/ch25/tests/test_ext.py) | `python3 -m pytest tests/test_ext.py \| tail -n 1` | `161 passed, 1 skipped in 10.03s`；`+99 -3` |

表里的 `python3 -m pytest` 实际都带着 `-p no:cacheprovider -o addopts=--doctest-modules`（`pyproject.toml` 里默认的 `-q` 会吞掉汇总行）。整个测试套件是 `1244 passed, 1 skipped, 1 xfailed, 1 warning in 64.67s`；`ruff format --line-length 79 --check .` 说 `405 files already formatted`，`ruff check .` 说 `All checks passed!`；`cargo fmt --check` 和 `cargo clippy --all-targets -- -D warnings` 无输出和无警告，`cargo test` 两个测试通过。

## 练习

**1.** 让 Rust 直接造 `Token`。现在是 Rust 给元组、Python 再包一遍。写一个 `tokenize_tokens(text, token_class)`，在 Rust 里对每个词元调用 `token_class`（用 `Bound<'py, PyAny>` 的 `call1`），省掉 `rs.py` 里的 `new(Token, item)`。先写下预测：它省的是 `rs.tokens` 比 `_rs.tokenize` 多出来的 138 到 330 毫秒的多少？用上面 `stages.py` 的“drop、keep”两栏验证。我的预测是省得不多，因为每次从 Rust 调用 Python 类要走参数打包，而 `tuple.__new__` 已经是最短的路径。

**2.** 弄坏存根。把 `_rs.pyi` 里 `tokenize_many` 的 `threads` 改名成 `workers`。先预测：mypy、pyright、`mypy.stubtest` 哪个会报，各报几条？再分别跑。再试把返回类型改成 `list[tuple[str, int, int]]`。这个练习告诉你每个检查器看得见什么：一个检查你的调用，一个检查存根自己，一个把存根和真正的 `.so` 对照。

**3.** 让工作线程 panic。在 `tokens_many` 的 `worker` 里加一个 `#[cfg(debug_assertions)]` 的 `if i == 3 { panic!("worker") }`，用 `rust_panic_fail.py` 的办法编调试版并导入。预测：Python 看到什么异常？其他线程会不会做完？进程里还有没有悬着的线程？然后读 `resume_unwind` 那一行，解释你看到的。

**4.** 用自由线程构建跑一遍。用 `python3.14t` 建虚拟环境，在里面用 maturin 构建 `sift._rs`，再跑 `gil_release.py` 里“Python 线程跑 `iter_tokens`”那一栏。预测：在没有 GIL 的解释器上，纯 Python 线程会不会开始伸缩？Rust 那一栏的加速比会变大还是变小？把预测写下来，再对照第 16 篇里自由线程的单线程开销。

**5.** 把 Rust 的 `fold` 接进来。照着上面的 `foldlab` 写一个 `fold(text)`，用 `caseless` 和 `unicode-normalization`，再加一个 `--tokenizer rust-fold`。写一个测试，对所有非代理项的码点比较它和 Python 的 `fold`，但只在 `unicodedata.unidata_version` 等于 crate 的版本时才要求相等。然后回答一个问题：这个测试在 Python 升级之后失败了，该怎么办？这个问题没有对错，它是在问 Sift 愿意为 25 毫秒承担多少维护。

## 索引：Python 特性对应第几篇

下面这张表是整个系列的目录，按篇号排，每一行是一个特性或工具，右边是讲它的那一篇。想复习某个特性的时候，从这里跳过去。

| Python 特性 | 第几篇 |
| --- | --- |
| `nix develop` | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| `python3 --version` | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| REPL：语法高亮、多行编辑、`help()` | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| 运行文件与 `python -m` | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| `if __name__ == "__main__"` | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| 源码、字节码、解释器循环 | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| `__pycache__` 与 `.pyc` | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| 一切皆对象：`type`、`id`、引用计数 | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| 名字绑定到对象 | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| 动态类型与强类型 | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| `int` 任意精度 | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| `float` 与 IEEE 754 | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| `bool` 是 `int` 的子类 | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| `None` | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| `//`、`%`、`**`、`divmod` | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| 链式比较 | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| 海象运算符 `:=` | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| `if`/`elif`/`for`/`while`，循环的 `else` | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| `break`、`continue`、`pass` | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| 基本的 `def` | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| f-string 基础 | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| PEP 8、`ruff format`、`ruff check` | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| 实验场约定：`_fail.py`、`out/chNN` | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| 系列地图、标签 `chNN`、`git checkout chNN` | [第 1 篇](/posts/python-by-sift-01-first-search/) |
| `str` 不可变与驻留 | [第 2 篇](/posts/python-by-sift-02-text-and-unicode/) |
| 码点与 UTF-8 | [第 2 篇](/posts/python-by-sift-02-text-and-unicode/) |
| `encode`、`decode`、错误处理器 | [第 2 篇](/posts/python-by-sift-02-text-and-unicode/) |
| `unicodedata`：`name`、`category`、`normalize` | [第 2 篇](/posts/python-by-sift-02-text-and-unicode/) |
| `casefold` | [第 2 篇](/posts/python-by-sift-02-text-and-unicode/) |
| 切片与步长 | [第 2 篇](/posts/python-by-sift-02-text-and-unicode/) |
| `split`、`join`、`strip`、`partition`、`startswith`（传元组）、`replace`、`translate` | [第 2 篇](/posts/python-by-sift-02-text-and-unicode/) |
| `str.join` 与 `+=` 的代价 | [第 2 篇](/posts/python-by-sift-02-text-and-unicode/) |
| 格式化迷你语言 | [第 2 篇](/posts/python-by-sift-02-text-and-unicode/) |
| t-string (PEP 750) | [第 2 篇](/posts/python-by-sift-02-text-and-unicode/) |
| 原始字符串 | [第 2 篇](/posts/python-by-sift-02-text-and-unicode/) |
| `re` 全览与分词正则的逐段解释 | [第 2 篇](/posts/python-by-sift-02-text-and-unicode/) |
| `textwrap` | [第 2 篇](/posts/python-by-sift-02-text-and-unicode/) |
| `string` 模块的常量 | [第 2 篇](/posts/python-by-sift-02-text-and-unicode/) |
| `bytes`、`bytearray`、`memoryview` | [第 2 篇](/posts/python-by-sift-02-text-and-unicode/) |
| CJK 二元组的理由 | [第 2 篇](/posts/python-by-sift-02-text-and-unicode/) |
| `list` 是指针的动态数组 | [第 3 篇](/posts/python-by-sift-03-containers/) |
| `append` 摊还 O(1) | [第 3 篇](/posts/python-by-sift-03-containers/) |
| `dict` 是紧凑哈希表，保持插入顺序 | [第 3 篇](/posts/python-by-sift-03-containers/) |
| `hash` 与 `__eq__` 的契约 | [第 3 篇](/posts/python-by-sift-03-containers/) |
| `set`、`frozenset` | [第 3 篇](/posts/python-by-sift-03-containers/) |
| `tuple` | [第 3 篇](/posts/python-by-sift-03-containers/) |
| 别名与拷贝 | [第 3 篇](/posts/python-by-sift-03-containers/) |
| 推导式及其作用域 | [第 3 篇](/posts/python-by-sift-03-containers/) |
| 解包与切片赋值 | [第 3 篇](/posts/python-by-sift-03-containers/) |
| 排序 | [第 3 篇](/posts/python-by-sift-03-containers/) |
| `collections` | [第 3 篇](/posts/python-by-sift-03-containers/) |
| `array` 模块 | [第 3 篇](/posts/python-by-sift-03-containers/) |
| 大 O 的实测 | [第 3 篇](/posts/python-by-sift-03-containers/) |
| 函数对象：`__code__`、`__defaults__` | [第 4 篇](/posts/python-by-sift-04-functions/) |
| 全部参数种类 | [第 4 篇](/posts/python-by-sift-04-functions/) |
| 作用域与 LEGB | [第 4 篇](/posts/python-by-sift-04-functions/) |
| 闭包与 cell | [第 4 篇](/posts/python-by-sift-04-functions/) |
| `lambda` | [第 4 篇](/posts/python-by-sift-04-functions/) |
| 高阶函数 | [第 4 篇](/posts/python-by-sift-04-functions/) |
| 装饰器与类装饰器 `__call__` | [第 4 篇](/posts/python-by-sift-04-functions/) |
| `functools`、`operator` | [第 4 篇](/posts/python-by-sift-04-functions/) |
| 注解入门与 3.14 延迟求值 | [第 4 篇](/posts/python-by-sift-04-functions/) |
| 递归与没有尾调用优化 | [第 4 篇](/posts/python-by-sift-04-functions/) |
| 可迭代对象与迭代器，迭代协议 | [第 5 篇](/posts/python-by-sift-05-iterators-generators/) |
| 生成器：可恢复的帧 | [第 5 篇](/posts/python-by-sift-05-iterators-generators/) |
| 生成器表达式 | [第 5 篇](/posts/python-by-sift-05-iterators-generators/) |
| `yield from` 委托 | [第 5 篇](/posts/python-by-sift-05-iterators-generators/) |
| `send`、`throw`、`close` | [第 5 篇](/posts/python-by-sift-05-iterators-generators/) |
| 惰性与内存 | [第 5 篇](/posts/python-by-sift-05-iterators-generators/) |
| `itertools` | [第 5 篇](/posts/python-by-sift-05-iterators-generators/) |
| `enumerate`、`zip`、`reversed`、`range` | [第 5 篇](/posts/python-by-sift-05-iterators-generators/) |
| `pathlib.Path.rglob` | [第 5 篇](/posts/python-by-sift-05-iterators-generators/) |
| PEP 479 | [第 5 篇](/posts/python-by-sift-05-iterators-generators/) |
| 类是对象，`self` | [第 6 篇](/posts/python-by-sift-06-classes-data-model/) |
| 属性查找基础 | [第 6 篇](/posts/python-by-sift-06-classes-data-model/) |
| `__init__` 与 `__new__` | [第 6 篇](/posts/python-by-sift-06-classes-data-model/) |
| `__repr__`、`__str__`、`__format__` | [第 6 篇](/posts/python-by-sift-06-classes-data-model/) |
| 相等与哈希，富比较 | [第 6 篇](/posts/python-by-sift-06-classes-data-model/) |
| 运算符重载与反射运算 | [第 6 篇](/posts/python-by-sift-06-classes-data-model/) |
| 容器协议 | [第 6 篇](/posts/python-by-sift-06-classes-data-model/) |
| `__bool__` | [第 6 篇](/posts/python-by-sift-06-classes-data-model/) |
| `property` | [第 6 篇](/posts/python-by-sift-06-classes-data-model/) |
| `classmethod`、`staticmethod` | [第 6 篇](/posts/python-by-sift-06-classes-data-model/) |
| `__slots__` | [第 6 篇](/posts/python-by-sift-06-classes-data-model/) |
| `dataclasses` | [第 6 篇](/posts/python-by-sift-06-classes-data-model/) |
| `enum` | [第 6 篇](/posts/python-by-sift-06-classes-data-model/) |
| `datetime`、`zoneinfo` | [第 6 篇](/posts/python-by-sift-06-classes-data-model/) |
| 单继承与多继承 | [第 7 篇](/posts/python-by-sift-07-inheritance-protocols/) |
| `super()` 与 MRO | [第 7 篇](/posts/python-by-sift-07-inheritance-protocols/) |
| mixin | [第 7 篇](/posts/python-by-sift-07-inheritance-protocols/) |
| ABC | [第 7 篇](/posts/python-by-sift-07-inheritance-protocols/) |
| `isinstance`、`issubclass` 钩子、`__subclasshook__` | [第 7 篇](/posts/python-by-sift-07-inheritance-protocols/) |
| 鸭子类型 | [第 7 篇](/posts/python-by-sift-07-inheritance-protocols/) |
| `Protocol` | [第 7 篇](/posts/python-by-sift-07-inheritance-protocols/) |
| `__init_subclass__` | [第 7 篇](/posts/python-by-sift-07-inheritance-protocols/) |
| `collections.abc` | [第 7 篇](/posts/python-by-sift-07-inheritance-protocols/) |
| 组合优于继承 | [第 7 篇](/posts/python-by-sift-07-inheritance-protocols/) |
| `functools.singledispatchmethod` | [第 7 篇](/posts/python-by-sift-07-inheritance-protocols/) |
| BM25 的数学，`math.log`，IDF 变体 | [第 8 篇](/posts/python-by-sift-08-bm25-query-language/) |
| 长度归一化 | [第 8 篇](/posts/python-by-sift-08-bm25-query-language/) |
| 浮点精度 | [第 8 篇](/posts/python-by-sift-08-bm25-query-language/) |
| `heapq` | [第 8 篇](/posts/python-by-sift-08-bm25-query-language/) |
| `bisect` | [第 8 篇](/posts/python-by-sift-08-bm25-query-language/) |
| 词法分析器是生成器 | [第 8 篇](/posts/python-by-sift-08-bm25-query-language/) |
| 递归下降与优先级 | [第 8 篇](/posts/python-by-sift-08-bm25-query-language/) |
| AST：冻结的 dataclass 与 PEP 695 `type` | [第 8 篇](/posts/python-by-sift-08-bm25-query-language/) |
| 结构化模式匹配 | [第 8 篇](/posts/python-by-sift-08-bm25-query-language/) |
| 短语查询与词的位置 | [第 8 篇](/posts/python-by-sift-08-bm25-query-language/) |
| 片段 (snippet) | [第 8 篇](/posts/python-by-sift-08-bm25-query-language/) |
| t-string 的实际使用 | [第 8 篇](/posts/python-by-sift-08-bm25-query-language/) |
| 异常层次：`BaseException` 与 `Exception`、`KeyboardInterrupt` | [第 9 篇](/posts/python-by-sift-09-exceptions-context-logging/) |
| `try` 的全部子句 | [第 9 篇](/posts/python-by-sift-09-exceptions-context-logging/) |
| 异常链 | [第 9 篇](/posts/python-by-sift-09-exceptions-context-logging/) |
| 自定义异常层次 | [第 9 篇](/posts/python-by-sift-09-exceptions-context-logging/) |
| 异常组 | [第 9 篇](/posts/python-by-sift-09-exceptions-context-logging/) |
| 异常的 notes | [第 9 篇](/posts/python-by-sift-09-exceptions-context-logging/) |
| 3.14 的异常语法变化 | [第 9 篇](/posts/python-by-sift-09-exceptions-context-logging/) |
| EAFP | [第 9 篇](/posts/python-by-sift-09-exceptions-context-logging/) |
| with 协议 | [第 9 篇](/posts/python-by-sift-09-exceptions-context-logging/) |
| `contextlib` | [第 9 篇](/posts/python-by-sift-09-exceptions-context-logging/) |
| `warnings` | [第 9 篇](/posts/python-by-sift-09-exceptions-context-logging/) |
| `logging` | [第 9 篇](/posts/python-by-sift-09-exceptions-context-logging/) |
| `breakpoint()`、`pdb` | [第 9 篇](/posts/python-by-sift-09-exceptions-context-logging/) |
| 事后调试 `python -m pdb -c continue` | [第 9 篇](/posts/python-by-sift-09-exceptions-context-logging/) |
| 远程 attach `python -m pdb -p PID` (PEP 768) | [第 9 篇](/posts/python-by-sift-09-exceptions-context-logging/) |
| `assert` 重写 | [第 10 篇](/posts/python-by-sift-10-testing/) |
| fixture 与作用域，`conftest.py` | [第 10 篇](/posts/python-by-sift-10-testing/) |
| `parametrize` | [第 10 篇](/posts/python-by-sift-10-testing/) |
| 内置 fixture | [第 10 篇](/posts/python-by-sift-10-testing/) |
| `raises` | [第 10 篇](/posts/python-by-sift-10-testing/) |
| marks | [第 10 篇](/posts/python-by-sift-10-testing/) |
| `unittest`、`doctest` | [第 10 篇](/posts/python-by-sift-10-testing/) |
| `unittest.mock` | [第 10 篇](/posts/python-by-sift-10-testing/) |
| 属性测试与收缩 (hypothesis) | [第 10 篇](/posts/python-by-sift-10-testing/) |
| 覆盖率 | [第 10 篇](/posts/python-by-sift-10-testing/) |
| pytest-benchmark | [第 10 篇](/posts/python-by-sift-10-testing/) |
| GitHub Actions 与 Nix 的 CI | [第 10 篇](/posts/python-by-sift-10-testing/) |
| 模块是对象 | [第 11 篇](/posts/python-by-sift-11-modules-packaging-cli/) |
| 包与 `__init__.py` | [第 11 篇](/posts/python-by-sift-11-modules-packaging-cli/) |
| 绝对导入与相对导入 | [第 11 篇](/posts/python-by-sift-11-modules-packaging-cli/) |
| `__all__` | [第 11 篇](/posts/python-by-sift-11-modules-packaging-cli/) |
| 命名空间包 | [第 11 篇](/posts/python-by-sift-11-modules-packaging-cli/) |
| 导入系统：finder、loader、spec、`sys.meta_path`、`sys.path`、`sys.modules` | [第 11 篇](/posts/python-by-sift-11-modules-packaging-cli/) |
| 循环导入及修法 | [第 11 篇](/posts/python-by-sift-11-modules-packaging-cli/) |
| `python -m` 与 `__main__.py` | [第 11 篇](/posts/python-by-sift-11-modules-packaging-cli/) |
| src 布局 | [第 11 篇](/posts/python-by-sift-11-modules-packaging-cli/) |
| `pyproject.toml` (PEP 517/518/621) | [第 11 篇](/posts/python-by-sift-11-modules-packaging-cli/) |
| 可编辑安装 | [第 11 篇](/posts/python-by-sift-11-modules-packaging-cli/) |
| 入口点 | [第 11 篇](/posts/python-by-sift-11-modules-packaging-cli/) |
| `importlib.metadata`、`importlib.resources` | [第 11 篇](/posts/python-by-sift-11-modules-packaging-cli/) |
| Nix 上的 `--system-site-packages` venv | [第 11 篇](/posts/python-by-sift-11-modules-packaging-cli/) |
| `argparse`：子命令、类型、choices、互斥组 | [第 11 篇](/posts/python-by-sift-11-modules-packaging-cli/) |
| 进程环境，`subprocess`，`signal` | [第 11 篇](/posts/python-by-sift-11-modules-packaging-cli/) |
| 文件对象与 IO 栈 | [第 12 篇](/posts/python-by-sift-12-files-binary-format/) |
| 编码 | [第 12 篇](/posts/python-by-sift-12-files-binary-format/) |
| `pathlib` | [第 12 篇](/posts/python-by-sift-12-files-binary-format/) |
| `os`、`shutil`、`tempfile` | [第 12 篇](/posts/python-by-sift-12-files-binary-format/) |
| `struct` | [第 12 篇](/posts/python-by-sift-12-files-binary-format/) |
| 位运算 | [第 12 篇](/posts/python-by-sift-12-files-binary-format/) |
| varint 与 delta 编码 | [第 12 篇](/posts/python-by-sift-12-files-binary-format/) |
| `mmap` | [第 12 篇](/posts/python-by-sift-12-files-binary-format/) |
| `pickle` 与不要用在不可信数据上 | [第 12 篇](/posts/python-by-sift-12-files-binary-format/) |
| `json` | [第 12 篇](/posts/python-by-sift-12-files-binary-format/) |
| `marshal` | [第 12 篇](/posts/python-by-sift-12-files-binary-format/) |
| `tomllib`（只读） | [第 12 篇](/posts/python-by-sift-12-files-binary-format/) |
| `csv` | [第 12 篇](/posts/python-by-sift-12-files-binary-format/) |
| 压缩模块与 `compression.zstd` | [第 12 篇](/posts/python-by-sift-12-files-binary-format/) |
| `hashlib` | [第 12 篇](/posts/python-by-sift-12-files-binary-format/) |
| 原子写 | [第 12 篇](/posts/python-by-sift-12-files-binary-format/) |
| DB-API 2.0 | [第 13 篇](/posts/python-by-sift-13-sqlite-sqlalchemy/) |
| `sqlite3` | [第 13 篇](/posts/python-by-sift-13-sqlite-sqlalchemy/) |
| SQL 注入 | [第 13 篇](/posts/python-by-sift-13-sqlite-sqlalchemy/) |
| 事务 | [第 13 篇](/posts/python-by-sift-13-sqlite-sqlalchemy/) |
| FTS5 与 `bm25()` | [第 13 篇](/posts/python-by-sift-13-sqlite-sqlalchemy/) |
| SQLAlchemy 2.0 的 Core 与 ORM | [第 13 篇](/posts/python-by-sift-13-sqlite-sqlalchemy/) |
| Session | [第 13 篇](/posts/python-by-sift-13-sqlite-sqlalchemy/) |
| 加载策略 | [第 13 篇](/posts/python-by-sift-13-sqlite-sqlalchemy/) |
| 迁移 (Alembic) | [第 13 篇](/posts/python-by-sift-13-sqlite-sqlalchemy/) |
| 渐进类型 | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| 注解语法与 `typing` 要点 | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| 泛型：旧写法与 PEP 695 | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| 型变 | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| `Protocol` 的类型标注 | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| `TypedDict` | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| `Literal`、`Final` | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| `Callable`、`ParamSpec`、`Concatenate` | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| `TypeVarTuple` | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| `overload` | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| 类型收窄 | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| `NewType`、`Annotated` | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| `Self`、`Never` | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| `TYPE_CHECKING` | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| 存根文件 `.pyi` | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| mypy 与 pyright 的区别 | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| `strict` 模式在 Sift 里的发现 | [第 14 篇](/posts/python-by-sift-14-type-system/) |
| 属性访问的全过程 | [第 15 篇](/posts/python-by-sift-15-metaprogramming/) |
| 描述符与 `__set_name__` | [第 15 篇](/posts/python-by-sift-15-metaprogramming/) |
| `__getattr__`、`__setattr__` | [第 15 篇](/posts/python-by-sift-15-metaprogramming/) |
| 元类与类的创建步骤 | [第 15 篇](/posts/python-by-sift-15-metaprogramming/) |
| 类装饰器 | [第 15 篇](/posts/python-by-sift-15-metaprogramming/) |
| `inspect` | [第 15 篇](/posts/python-by-sift-15-metaprogramming/) |
| `dis` | [第 15 篇](/posts/python-by-sift-15-metaprogramming/) |
| `ast`、`compile`、`exec`、`eval` | [第 15 篇](/posts/python-by-sift-15-metaprogramming/) |
| 引用计数与循环 GC | [第 15 篇](/posts/python-by-sift-15-metaprogramming/) |
| `weakref` 与终结器 | [第 15 篇](/posts/python-by-sift-15-metaprogramming/) |
| 驻留 | [第 15 篇](/posts/python-by-sift-15-metaprogramming/) |
| `PyObject` 头：引用计数与类型指针 | [第 15 篇](/posts/python-by-sift-15-metaprogramming/) |
| OS 线程与 GIL，`sys.getswitchinterval` | [第 16 篇](/posts/python-by-sift-16-threads-processes-gil/) |
| 竞态与原子性 | [第 16 篇](/posts/python-by-sift-16-threads-processes-gil/) |
| 同步原语 | [第 16 篇](/posts/python-by-sift-16-threads-processes-gil/) |
| 队列 | [第 16 篇](/posts/python-by-sift-16-threads-processes-gil/) |
| 内置类型的线程安全 | [第 16 篇](/posts/python-by-sift-16-threads-processes-gil/) |
| 进程与 IPC | [第 16 篇](/posts/python-by-sift-16-threads-processes-gil/) |
| 进程启动方式 | [第 16 篇](/posts/python-by-sift-16-threads-processes-gil/) |
| 进程间的 pickle | [第 16 篇](/posts/python-by-sift-16-threads-processes-gil/) |
| 共享内存 | [第 16 篇](/posts/python-by-sift-16-threads-processes-gil/) |
| `concurrent.futures` | [第 16 篇](/posts/python-by-sift-16-threads-processes-gil/) |
| 子解释器 (PEP 734) | [第 16 篇](/posts/python-by-sift-16-threads-processes-gil/) |
| 自由线程构建 (PEP 779) 与单线程开销 | [第 16 篇](/posts/python-by-sift-16-threads-processes-gil/) |
| 如何选并发模型 | [第 16 篇](/posts/python-by-sift-16-threads-processes-gil/) |
| socket 与阻塞 IO | [第 17 篇](/posts/python-by-sift-17-asyncio/) |
| 就绪通知与 `selectors` | [第 17 篇](/posts/python-by-sift-17-asyncio/) |
| 事件循环 | [第 17 篇](/posts/python-by-sift-17-asyncio/) |
| 协程、awaitable、future、task | [第 17 篇](/posts/python-by-sift-17-asyncio/) |
| `TaskGroup` | [第 17 篇](/posts/python-by-sift-17-asyncio/) |
| 取消与超时 | [第 17 篇](/posts/python-by-sift-17-asyncio/) |
| 异步迭代器、生成器、上下文管理器 | [第 17 篇](/posts/python-by-sift-17-asyncio/) |
| 异步同步原语与队列 | [第 17 篇](/posts/python-by-sift-17-asyncio/) |
| streams | [第 17 篇](/posts/python-by-sift-17-asyncio/) |
| `to_thread` 与 executor | [第 17 篇](/posts/python-by-sift-17-asyncio/) |
| `contextvars` | [第 17 篇](/posts/python-by-sift-17-asyncio/) |
| 调试 asyncio | [第 17 篇](/posts/python-by-sift-17-asyncio/) |
| 3.14 的 asyncio 内省 | [第 17 篇](/posts/python-by-sift-17-asyncio/) |
| HTTP/1.1 报文格式 | [第 17 篇](/posts/python-by-sift-17-asyncio/) |
| WSGI 与 ASGI | [第 18 篇](/posts/python-by-sift-18-fastapi-pydantic-httpx/) |
| `httpx` | [第 18 篇](/posts/python-by-sift-18-fastapi-pydantic-httpx/) |
| pydantic v2 | [第 18 篇](/posts/python-by-sift-18-fastapi-pydantic-httpx/) |
| FastAPI 路由，路径与查询参数 | [第 18 篇](/posts/python-by-sift-18-fastapi-pydantic-httpx/) |
| 响应模型 | [第 18 篇](/posts/python-by-sift-18-fastapi-pydantic-httpx/) |
| 依赖注入 | [第 18 篇](/posts/python-by-sift-18-fastapi-pydantic-httpx/) |
| lifespan | [第 18 篇](/posts/python-by-sift-18-fastapi-pydantic-httpx/) |
| 异常处理器 | [第 18 篇](/posts/python-by-sift-18-fastapi-pydantic-httpx/) |
| OpenAPI | [第 18 篇](/posts/python-by-sift-18-fastapi-pydantic-httpx/) |
| `TestClient` | [第 18 篇](/posts/python-by-sift-18-fastapi-pydantic-httpx/) |
| uvicorn | [第 18 篇](/posts/python-by-sift-18-fastapi-pydantic-httpx/) |
| typer：类型注解到命令行 | [第 19 篇](/posts/python-by-sift-19-typer-rich-uv/) |
| click | [第 19 篇](/posts/python-by-sift-19-typer-rich-uv/) |
| rich | [第 19 篇](/posts/python-by-sift-19-typer-rich-uv/) |
| uv：项目、lock、`uv run`、`uv tool`、`uvx` | [第 19 篇](/posts/python-by-sift-19-typer-rich-uv/) |
| Nix 上禁用 Python 下载的原因 | [第 19 篇](/posts/python-by-sift-19-typer-rich-uv/) |
| pip/venv 与 uv 的对比 | [第 19 篇](/posts/python-by-sift-19-typer-rich-uv/) |
| wheel 与 sdist | [第 19 篇](/posts/python-by-sift-19-typer-rich-uv/) |
| PEP 517 构建后端 (hatchling) | [第 19 篇](/posts/python-by-sift-19-typer-rich-uv/) |
| 元数据与 extras | [第 19 篇](/posts/python-by-sift-19-typer-rich-uv/) |
| `uv tool install` | [第 19 篇](/posts/python-by-sift-19-typer-rich-uv/) |
| 发布到 PyPI | [第 19 篇](/posts/python-by-sift-19-typer-rich-uv/) |
| Tk 架构：Python 里的 Tcl 解释器 | [第 20 篇](/posts/python-by-sift-20-tkinter/) |
| 控件与几何管理器 | [第 20 篇](/posts/python-by-sift-20-tkinter/) |
| ttk 与主题 (sv-ttk) | [第 20 篇](/posts/python-by-sift-20-tkinter/) |
| 事件循环与回调 | [第 20 篇](/posts/python-by-sift-20-tkinter/) |
| 界面冻结的原因 | [第 20 篇](/posts/python-by-sift-20-tkinter/) |
| 线程加队列的模式 | [第 20 篇](/posts/python-by-sift-20-tkinter/) |
| `after` | [第 20 篇](/posts/python-by-sift-20-tkinter/) |
| Tk 变量 | [第 20 篇](/posts/python-by-sift-20-tkinter/) |
| 字体与 CJK | [第 20 篇](/posts/python-by-sift-20-tkinter/) |
| 深色模式检测 | [第 20 篇](/posts/python-by-sift-20-tkinter/) |
| Qt 对象模型：父子所有权与 Python GC | [第 21 篇](/posts/python-by-sift-21-pyside6/) |
| 信号与槽 | [第 21 篇](/posts/python-by-sift-21-pyside6/) |
| Qt 事件循环 | [第 21 篇](/posts/python-by-sift-21-pyside6/) |
| 布局 | [第 21 篇](/posts/python-by-sift-21-pyside6/) |
| Model/View/Delegate | [第 21 篇](/posts/python-by-sift-21-pyside6/) |
| `QPainter` 自绘 | [第 21 篇](/posts/python-by-sift-21-pyside6/) |
| QSS 与设计令牌 | [第 21 篇](/posts/python-by-sift-21-pyside6/) |
| Qt 的线程：`QThreadPool`、`QRunnable` | [第 21 篇](/posts/python-by-sift-21-pyside6/) |
| 定时器与防抖 | [第 21 篇](/posts/python-by-sift-21-pyside6/) |
| 快捷键 | [第 21 篇](/posts/python-by-sift-21-pyside6/) |
| 深色模式 | [第 21 篇](/posts/python-by-sift-21-pyside6/) |
| pytest-qt | [第 21 篇](/posts/python-by-sift-21-pyside6/) |
| 离屏渲染 | [第 21 篇](/posts/python-by-sift-21-pyside6/) |
| `pyside6-deploy` | [第 21 篇](/posts/python-by-sift-21-pyside6/) |
| `ndarray` 的内存模型 | [第 22 篇](/posts/python-by-sift-22-numpy-pandas-matplotlib/) |
| dtype | [第 22 篇](/posts/python-by-sift-22-numpy-pandas-matplotlib/) |
| 向量化 | [第 22 篇](/posts/python-by-sift-22-numpy-pandas-matplotlib/) |
| 广播 | [第 22 篇](/posts/python-by-sift-22-numpy-pandas-matplotlib/) |
| ufunc | [第 22 篇](/posts/python-by-sift-22-numpy-pandas-matplotlib/) |
| 线性代数：`@`、`np.linalg.norm` | [第 22 篇](/posts/python-by-sift-22-numpy-pandas-matplotlib/) |
| `np.random.default_rng` | [第 22 篇](/posts/python-by-sift-22-numpy-pandas-matplotlib/) |
| pandas 核心 API 与写时复制 | [第 22 篇](/posts/python-by-sift-22-numpy-pandas-matplotlib/) |
| `read_sql` | [第 22 篇](/posts/python-by-sift-22-numpy-pandas-matplotlib/) |
| 时间序列重采样 | [第 22 篇](/posts/python-by-sift-22-numpy-pandas-matplotlib/) |
| matplotlib 面向对象 API | [第 22 篇](/posts/python-by-sift-22-numpy-pandas-matplotlib/) |
| 对数坐标 | [第 22 篇](/posts/python-by-sift-22-numpy-pandas-matplotlib/) |
| 图里的 CJK 字体 | [第 22 篇](/posts/python-by-sift-22-numpy-pandas-matplotlib/) |
| polars | [第 22 篇](/posts/python-by-sift-22-numpy-pandas-matplotlib/) |
| 先测量，`timeit` | [第 23 篇](/posts/python-by-sift-23-profiling-performance/) |
| `cProfile`、`pstats` | [第 23 篇](/posts/python-by-sift-23-profiling-performance/) |
| 采样与确定性剖析器 | [第 23 篇](/posts/python-by-sift-23-profiling-performance/) |
| 火焰图 | [第 23 篇](/posts/python-by-sift-23-profiling-performance/) |
| 逐行剖析 | [第 23 篇](/posts/python-by-sift-23-profiling-performance/) |
| 内存剖析：`tracemalloc`、memray | [第 23 篇](/posts/python-by-sift-23-profiling-performance/) |
| 自适应特化解释器 (PEP 659) | [第 23 篇](/posts/python-by-sift-23-profiling-performance/) |
| 3.14 的尾调用解释器与 JIT | [第 23 篇](/posts/python-by-sift-23-profiling-performance/) |
| 常见优化：局部名字、属性查找、推导式、`str.translate`、预编译正则、`__slots__` | [第 23 篇](/posts/python-by-sift-23-profiling-performance/) |
| 先改算法 | [第 23 篇](/posts/python-by-sift-23-profiling-performance/) |
| `sys.monitoring` | [第 23 篇](/posts/python-by-sift-23-profiling-performance/) |
| C ABI | [第 24 篇](/posts/python-by-sift-24-c-extensions/) |
| 共享库 | [第 24 篇](/posts/python-by-sift-24-c-extensions/) |
| ctypes 的类型与陷阱 | [第 24 篇](/posts/python-by-sift-24-c-extensions/) |
| cffi 的 ABI 模式与 API 模式 | [第 24 篇](/posts/python-by-sift-24-c-extensions/) |
| Cython：类型化 memoryview、`cdef`、注解报告 | [第 24 篇](/posts/python-by-sift-24-c-extensions/) |
| C API 基础：`PyObject *`、`Py_INCREF`、`Py_DECREF` | [第 24 篇](/posts/python-by-sift-24-c-extensions/) |
| 模块初始化与参数解析 | [第 24 篇](/posts/python-by-sift-24-c-extensions/) |
| 从 C 释放 GIL | [第 24 篇](/posts/python-by-sift-24-c-extensions/) |
| 缓冲区协议 | [第 24 篇](/posts/python-by-sift-24-c-extensions/) |
| `faulthandler` | [第 24 篇](/posts/python-by-sift-24-c-extensions/) |
| 调用开销与每次调用的工作量 | [第 24 篇](/posts/python-by-sift-24-c-extensions/) |
| PyO3 模型：`#[pyfunction]`、`#[pymodule]`、`Bound<'py, T>`、类型转换 | [第 25 篇](/posts/python-by-sift-25-pyo3-rust/) |
| `maturin develop` 与 `maturin build` | [第 25 篇](/posts/python-by-sift-25-pyo3-rust/) |
| GIL 释放与 Rust 线程 | [第 25 篇](/posts/python-by-sift-25-pyo3-rust/) |
| 错误与 panic 的映射 | [第 25 篇](/posts/python-by-sift-25-pyo3-rust/) |
| 类型存根 | [第 25 篇](/posts/python-by-sift-25-pyo3-rust/) |
| 何时选 Rust、numpy 还是 C | [第 25 篇](/posts/python-by-sift-25-pyo3-rust/) |

## 接下来

系列到这里结束。`git checkout tutorial-v1` 是写完时的样子，和 `ch25` 是同一个提交；`ch01` 到 `ch25` 每个标签是一篇结束时的状态，`git diff ch12 ch13` 就是第 13 篇动过的所有行。

- 想把 Rust 这一半学扎实：PyO3 替我写掉的 `extern "C"` 函数和引用计数，在 Pebble 系列的 [FFI 与 no_std](/posts/rust-by-pebble-13-ffi-nostd/) 里是手写的；`thread::scope`、`Send` 和 `Ungil` 背后的规则，在[并发与 async](/posts/rust-by-pebble-14-concurrency-async/)里。
- 想接着做 Sift：先做练习 1，再改接口让 Rust 返回偏移数组，然后看 `IndexWriter` 能不能按偏移工作。这是这两篇里一直指着、但我没有量的那个方向。
- 想看每个数是怎么来的：`lab/ch25/` 下的脚本都能直接跑，`make ext-rs` 之后 `python3 lab/ch25/final_bench.py` 就是文章开头那张表。
