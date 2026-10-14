---
title: "越过边界：FFI 调 C 与 no_std"
commentId: "post:rust-by-pebble-13-ffi-nostd"
published: "2026-10-13 20:00:00 +08:00"
description: "Pebble 的最后两条边界：向下调用一个手写的 C 库，再向下脱掉操作系统。写 pebble-sys（build.rs、unsafe extern、Drop、catch_unwind）和 pebble-nostd（no_std、原子操作、GlobalAlloc、const 泛型），再用实验补上 repr、union、cdylib。"
category: Note
tags:
  - Rust
  - Pebble
  - FFI
  - unsafe
  - no_std
series: "用 Pebble 从零学 Rust"
seriesOrder: 13
draft: false
comment: true
slug: rust-by-pebble-13-ffi-nostd
---

到上一篇为止，Pebble 里每一个字节都归 Rust 管：`String` 归 `Rc`，`Rc` 归编译器，编译器说了算。这一篇我们把边界从两头戳穿。向下，调用一个用 C 写的库（一个 FNV-1a 哈希、一个 arena 分配器、一个接收回调的 `fold`，总共两百来行的 C99）；再向下，连操作系统也不要了，让词法分析器和一个整数求值器跑在我们自己写的分配器上，对 `(1 + 2) * 3 - 4 / 2` 求值总共只向这个分配器要了 2000 字节。边界上的一切都是 `unsafe` 的，所以这篇的主题其实只有一个：怎么把 `unsafe` 关进一个小笼子里，让笼子外面的人不需要知道它存在。

> [!NOTE] 本篇检查点
> 做完这一篇，你会有 `pebble-sys`（`build.rs`、C 源码、`fnv1a`、`Arena`、`fold`）和 `pebble-nostd`（`no_std` 的求值器加一个 const 泛型的 bump 分配器），两个 crate 都和 tag `tutorial-v1` 逐字节一致，`cargo test -p pebble-sys -p pebble-nostd` 通过。会用到的 Rust 特性：`unsafe extern`、`repr(C)`、`NonNull`、`Drop`、`Send`/`Sync` 与 `PhantomData`、`catch_unwind`、`UnsafeCell`、原子操作、`GlobalAlloc`、const 泛型。上一篇在 [栈式虚拟机](/posts/rust-by-pebble-12-vm-backends/)，VM 自己是 `forbid(unsafe_code)` 的，`unsafe` 上一次出现是第 11 篇的 GC；这一篇的 `unsafe` 全是跨边界的。

## 先把工作区补齐

这两个 crate 依赖前面几篇的成果：`pebble-nostd` 用的是第 4 篇写的词法分析器，词法分析器又依赖第 3 篇的 `pebble-diag` 和第 1、2 篇的 `pebble-span`。如果你是一路跟下来的，这三个 crate 已经在 `crates/` 下了；如果你是直接跳到这一篇，把它们从 [tag](https://github.com/bfmhno3/pebble/tree/tutorial-v1) 的 `crates/pebble-span`、`crates/pebble-diag`、`crates/pebble-lexer` 整个目录复制过来即可。

根 `Cargo.toml` 需要认识两个新 crate 和一个新的外部依赖。在 `[workspace.dependencies]` 里加三行（路径依赖的写法第 1 篇讲过）：

```toml
pebble-sys = { path = "crates/pebble-sys", version = "0.1.0" }
pebble-nostd = { path = "crates/pebble-nostd", version = "0.1.0" }

cc = "1"
```

`cc` 是调用 C 编译器的库，一会儿 `build.rs` 要用它。然后建目录：

```bash
cargo new --lib crates/pebble-sys
cargo new --lib crates/pebble-nostd
mkdir -p crates/pebble-sys/csrc/include crates/pebble-nostd/examples
```

## C 这一半

FFI 的第一课和 Rust 无关：你得先有一份 C 代码。我们不依赖系统里已有的库（它们在每台机器上长得不一样），而是自己写一个小的，随 crate 一起发布。先写头文件 `crates/pebble-sys/csrc/include/pebble_shim.h`：

```c
/* pebble_shim.h - hand-written C99 shims linked into the Pebble runtime.
 *
 * Everything in this header has a safe Rust wrapper in `pebble-sys`'s lib.rs.
 * The ABI is plain C: integers by value, pointers by address.
 */
#ifndef PEBBLE_SHIM_H
#define PEBBLE_SHIM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* FNV-1a, 64-bit variant (offset basis 0xcbf29ce484222325, prime 0x100000001b3).
 *
 * Reads `len` bytes through `data` and returns the resulting digest. `data` may
 * be NULL when `len` is 0. The function keeps no reference to `data`.
 */
uint64_t pebble_fnv1a(const uint8_t *data, size_t len);

/* A bump (arena) allocator over a single upfront allocation.
 *
 * The struct is opaque: callers only ever hold a `PebbleArena *`. Every
 * function tolerates a NULL arena. Arenas are not thread-safe.
 */
typedef struct PebbleArena PebbleArena;

/* Creates an arena with room for `capacity` bytes.
 *
 * Returns NULL if memory cannot be obtained. A capacity of 0 is allowed: the
 * arena exists, `pebble_arena_used` stays 0 and every `pebble_arena_alloc`
 * fails. Release the result with `pebble_arena_destroy`.
 */
PebbleArena *pebble_arena_create(size_t capacity);

/* Bump-allocates `len` uninitialised bytes.
 *
 * The returned region is aligned to the widest scalar alignment the platform
 * requires (16 bytes on x86-64) and
 * never overlaps a region handed out by a previous call that has not been
 * invalidated by `pebble_arena_reset`. Contents are unspecified.
 *
 * Returns NULL when the arena is NULL, when the arena has no backing storage
 * (capacity 0) or when `len` bytes plus alignment padding do not fit in the
 * remaining capacity.
 */
void *pebble_arena_alloc(PebbleArena *arena, size_t len);

/* Bytes handed out so far, including alignment padding between allocations.
 * Returns 0 for a NULL arena. */
size_t pebble_arena_used(const PebbleArena *arena);

/* Total number of bytes the arena can hand out. Returns 0 for a NULL arena. */
size_t pebble_arena_capacity(const PebbleArena *arena);

/* Rewinds the arena so all of its capacity becomes available again.
 *
 * Every pointer previously returned by `pebble_arena_alloc` is invalidated by
 * this call: using one afterwards is undefined behaviour. No-op for NULL.
 */
void pebble_arena_reset(PebbleArena *arena);

/* Releases the arena and its backing storage. No-op for NULL. Afterwards the
 * arena pointer and every pointer it handed out are dangling. */
void pebble_arena_destroy(PebbleArena *arena);

/* Callback signature used by `pebble_fold`. `ctx` is the opaque pointer the
 * caller passed to `pebble_fold`; it may be NULL. */
typedef int64_t (*pebble_fold_fn)(int64_t acc, int64_t value, void *ctx);

/* Folds the integers in the inclusive range [lo, hi].
 *
 * Calls `cb(acc, value, ctx)` once per integer, in ascending order, threading
 * `init` as the initial accumulator and the callback's result as the next
 * accumulator. Returns the final accumulator, or `init` when `lo > hi`.
 *
 * `cb` must not be NULL. `pebble_fold` does not catch anything: how a callback
 * failure is handled is up to the callback.
 */
int64_t pebble_fold(int64_t init, int64_t lo, int64_t hi, pebble_fold_fn cb, void *ctx);

#ifdef __cplusplus
}
#endif

#endif /* PEBBLE_SHIM_H */
```

这个头文件里有三件事值得看。

第一，`#ifdef __cplusplus` 那一对 `extern "C"`：C++ 会对函数名做修饰（name mangling），不加这个，C++ 调用方找不到我们的符号。这是 C 世界里最古老的 FFI 约定：函数名就是符号名，参数按 System V ABI 放进寄存器，没有重载，没有异常。Rust 的 `extern "C"` 选的就是这个 ABI，所以它能和 C 对话，也能和任何会说 C ABI 的语言对话。

第二，`typedef struct PebbleArena PebbleArena;` 只声明不定义：这是 C 的不透明类型（opaque type）惯用法，调用者只能持有指针，不知道里面有什么。后面你会看到 Rust 怎么对应这件事。

第三，`pebble_fold_fn` 的最后一个参数 `void *ctx`：C 没有闭包，所以每个接受回调的 C API 都会让你顺便传一个 `void *`，回调时原样还给你。`qsort_r`、`pthread_create`、`sigaction` 都是这个套路。第 9 篇我们说 Rust 的闭包是"函数加捕获的环境"，这里 C 的做法是把这两样分开传。

再写实现 `crates/pebble-sys/csrc/pebble_shim.c`：

```c
/* pebble_shim.c - implementation of the C half of `pebble-sys`. Portable C99. */

#include "pebble_shim.h"

#include <stdlib.h>

/* --- FNV-1a ----------------------------------------------------------------- */

#define PEBBLE_FNV_OFFSET_BASIS UINT64_C(0xcbf29ce484222325)
#define PEBBLE_FNV_PRIME UINT64_C(0x100000001b3)

uint64_t pebble_fnv1a(const uint8_t *data, size_t len) {
    uint64_t hash = PEBBLE_FNV_OFFSET_BASIS;
    size_t i;

    for (i = 0; i < len; i++) {
        hash ^= (uint64_t)data[i];
        hash *= PEBBLE_FNV_PRIME;
    }
    return hash;
}

/* --- Arena ------------------------------------------------------------------ */

/* C99 has no max_align_t, so probe the platform's widest scalar alignment with
 * a union instead. Its size is a multiple of that alignment (16 on x86-64). */
typedef union pebble_align_probe {
    long double ld;
    void *ptr;
    int64_t i64;
    size_t sz;
} pebble_align_probe;

#define PEBBLE_ALIGNMENT ((size_t)sizeof(pebble_align_probe))

struct PebbleArena {
    unsigned char *base;
    size_t capacity;
    size_t used;
};

/* Rounds `n` up to the next multiple of PEBBLE_ALIGNMENT. Overflow is handled
 * by the capacity check in pebble_arena_alloc. */
static size_t pebble_align_up(size_t n) {
    size_t rem = n % PEBBLE_ALIGNMENT;
    return rem == 0 ? n : n + (PEBBLE_ALIGNMENT - rem);
}

PebbleArena *pebble_arena_create(size_t capacity) {
    PebbleArena *arena = (PebbleArena *)malloc(sizeof(PebbleArena));

    if (arena == NULL) {
        return NULL;
    }
    arena->base = NULL;
    arena->capacity = capacity;
    arena->used = 0;

    if (capacity > 0) {
        arena->base = (unsigned char *)malloc(capacity);
        if (arena->base == NULL) {
            free(arena);
            return NULL;
        }
    }
    return arena;
}

void *pebble_arena_alloc(PebbleArena *arena, size_t len) {
    size_t start;

    if (arena == NULL || arena->base == NULL) {
        return NULL;
    }
    start = pebble_align_up(arena->used);
    /* Both comparisons are overflow-safe: `start <= capacity` is established
     * before `capacity - start` is computed. */
    if (start > arena->capacity || len > arena->capacity - start) {
        return NULL;
    }
    arena->used = start + len;
    return arena->base + start;
}

size_t pebble_arena_used(const PebbleArena *arena) {
    return arena == NULL ? 0 : arena->used;
}

size_t pebble_arena_capacity(const PebbleArena *arena) {
    return arena == NULL ? 0 : arena->capacity;
}

void pebble_arena_reset(PebbleArena *arena) {
    if (arena != NULL) {
        arena->used = 0;
    }
}

void pebble_arena_destroy(PebbleArena *arena) {
    if (arena != NULL) {
        free(arena->base);
        free(arena);
    }
}

/* --- Fold ------------------------------------------------------------------- */

int64_t pebble_fold(int64_t init, int64_t lo, int64_t hi, pebble_fold_fn cb, void *ctx) {
    int64_t acc = init;
    int64_t value;

    /* Walking hi upwards would be pointless: the range is inclusive and `lo >
     * hi` means "empty". */
    if (lo > hi) {
        return acc;
    }
    /* Structured so that the loop variable never overflows, even for hi ==
     * INT64_MAX: the increment is skipped on the final iteration. */
    for (value = lo;; value++) {
        acc = cb(acc, value, ctx);
        if (value == hi) {
            break;
        }
    }
    return acc;
}
```

几个细节。`PebbleArena` 的真实布局只在这个 `.c` 文件里（`base`、`capacity`、`used`），Rust 永远看不到。对齐用的是一个 `union` 探针：C99 没有 `max_align_t`，所以拿几个标量类型塞进一个 union，取它的 `sizeof` 当作最大对齐（x86-64 上是 16，因为有 `long double`）。`pebble_arena_alloc` 里的两个比较都小心地避免了加法溢出：先确认 `start <= capacity`，再算 `capacity - start`。`pebble_fold` 的循环写成"先调用，再判断是否到头，最后才自增"，这样 `hi == INT64_MAX` 时 `value++` 永远不会溢出。这些全是 C 的功课，不是这一篇的重点；我把它们写出来只是为了让这个 crate 完整，也让你看清楚 Rust 那一侧到底在给什么承诺。

> [!TIP] C 代码也要照抄
> 这两个文件是 C，不是 Rust，所以没有"先写个简化版再演化"这回事：照抄即可。它们在 tag 里的位置是 [`pebble_shim.h`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-sys/csrc/include/pebble_shim.h) 和 [`pebble_shim.c`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-sys/csrc/pebble_shim.c)。

## build.rs：让 Cargo 替你调 C 编译器

C++ 项目里，这一步是 CMake 的 `add_library(pebble_shim STATIC csrc/pebble_shim.c)` 加 `target_link_libraries`。Cargo 没有 CMake 那样的第二门语言，它的做法是：在 crate 根目录放一个叫 `build.rs` 的普通 Rust 程序，Cargo 在编译这个 crate 之前先编译并运行它，它往标准输出打印以 `cargo:` 开头的指令，Cargo 照着办。写 `crates/pebble-sys/build.rs`：

```rust
//! Compiles the C shim in `csrc/` into a static library linked into this crate.

/// Source files that make up the C shim, relative to this crate's root.
const C_SOURCES: &[&str] = &["csrc/pebble_shim.c", "csrc/include/pebble_shim.h"];

fn main() {
    for source in C_SOURCES {
        println!("cargo:rerun-if-changed={source}");
    }

    cc::Build::new()
        .file("csrc/pebble_shim.c")
        .include("csrc/include")
        .flag_if_supported("-std=c99")
        .warnings(true)
        .compile("pebble_shim");
}
```

`cc::Build` 找到系统的 C 编译器（读 `CC` 环境变量，没有就用 `cc`），把 `pebble_shim.c` 编译成静态库 `libpebble_shim.a`，放到 Cargo 给的 `OUT_DIR`，并且替你打印 `cargo:rustc-link-lib=static=pebble_shim` 和 `cargo:rustc-link-search=...`，也就是 CMake 里 `target_link_libraries` 那两件事。`println!("cargo:rerun-if-changed=...")` 告诉 Cargo：只有这些文件变了才需要重跑 `build.rs`；不写的话，包里任何文件变了都会重跑。`C_SOURCES` 里故意把头文件也列上了，因为头文件变了 `.c` 也得重编。

`crates/pebble-sys/Cargo.toml`：

```toml
[package]
name = "pebble-sys"
description = "FFI shims: a small C library linked into the Pebble runtime."
version.workspace = true
edition.workspace = true
rust-version.workspace = true
authors.workspace = true
license.workspace = true
repository.workspace = true

[build-dependencies]
cc.workspace = true

[lints]
workspace = true
```

`[build-dependencies]` 是只给 `build.rs` 用的依赖，不会链接进最终的库。这是 Cargo 把"构建期的工具链"和"运行期的依赖"分开的方式：`cc` 不会出现在你的二进制里。

来看一次干净构建的真实输出：

```bash
cargo build -p pebble-sys
```

```text
   Compiling find-msvc-tools v0.1.14
   Compiling shlex v2.0.1
   Compiling cc v1.6.0
   Compiling pebble-sys v0.1.0 (/tmp/pebble-rebuild-13/crates/pebble-sys)
warning: pebble-sys@0.1.0: In file included from /nix/store/nl1lkxkfx6466dlbv0v1azh2dqa7j1k6-glibc-2.42-84-dev/include/bits/libc-header-start.h:33,
warning: pebble-sys@0.1.0:                  from /nix/store/nl1lkxkfx6466dlbv0v1azh2dqa7j1k6-glibc-2.42-84-dev/include/stdint.h:26,
warning: pebble-sys@0.1.0:                  from /nix/store/w4910jj1pb63k12d3gbnl03n1ixcf1js-gcc-15.3.0/lib/gcc/x86_64-unknown-linux-gnu/15.3.0/include/stdint.h:11,
warning: pebble-sys@0.1.0:                  from csrc/include/pebble_shim.h:10,
warning: pebble-sys@0.1.0:                  from csrc/pebble_shim.c:3:
warning: pebble-sys@0.1.0: /nix/store/nl1lkxkfx6466dlbv0v1azh2dqa7j1k6-glibc-2.42-84-dev/include/features.h:435:4: warning: #warning _FORTIFY_SOURCE requires compiling with optimization (-O) [-Wcpp]
warning: pebble-sys@0.1.0:   435 | #  warning _FORTIFY_SOURCE requires compiling with optimization (-O)
warning: pebble-sys@0.1.0:       |    ^~~~~~~
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.77s
```

编译 C 的那些 `warning: pebble-sys@0.1.0:` 行是 `build.rs` 里 `.warnings(true)`（相当于 `-Wall -Wextra`）把 gcc 的输出原样转发了。这一条是我这台 nix 环境特有的：nix 的 gcc 包装器默认打开 `_FORTIFY_SOURCE`，而 debug 构建是 `-O0`，两者冲突，gcc 就抱怨。换一台普通机器，我猜你什么都看不到。顺便看看 `build.rs` 的产物：

```bash
ls target/debug/build/pebble-sys-*/out/
nm target/debug/build/pebble-sys-*/out/libpebble_shim.a | grep " T "
```

```text
faea18488176a15d-pebble_shim.o
flag_check
flag_check.c
libpebble_shim.a
0000000000000000 T pebble_arena_alloc
0000000000000000 T pebble_arena_capacity
0000000000000000 T pebble_arena_create
0000000000000000 T pebble_arena_destroy
0000000000000000 T pebble_arena_reset
0000000000000000 T pebble_arena_used
0000000000000000 T pebble_fnv1a
0000000000000000 T pebble_fold
```

`libpebble_shim.a` 就是那个静态库，`nm` 里 `T` 表示"在 text 段里定义的全局符号"，八个函数一个不少。`flag_check` 那两个文件是 `cc` 探测 `-std=c99` 是否被支持（`flag_if_supported`）时留下的。

## 第一次调用 C：从 strlen 开始

在写正式代码之前，先在第 1 篇建的实验室里（`~/rust-lab`）试一次最小的 FFI，看看编译器怎么拦我们。文件 `src/bin/ch13_extern_plain.rs`，用 C 标准库里现成的 `strlen`：

```rust
use std::ffi::{CString, c_char};

extern "C" {
    fn strlen(s: *const c_char) -> usize;
}

fn main() {
    let s = CString::new("pebble").unwrap();
    let n = unsafe { strlen(s.as_ptr()) };
    println!("strlen = {n}");
}
```

```bash
cargo run --quiet --bin ch13_extern_plain
```

```text
error: extern blocks must be unsafe
 --> src/bin/ch13_extern_plain.rs:3:1
  |
3 | / extern "C" {
4 | |     fn strlen(s: *const c_char) -> usize;
5 | | }
  | |_^

error: could not compile `rust-lab` (bin "ch13_extern_plain") due to 1 previous error
```

edition 2024 起，`extern` 块必须写成 `unsafe extern`。道理是：这个块里的每一个声明都是你对编译器的一个"断言"，说"链接器会找到一个叫 `strlen`、签名是这样的符号"。编译器看不到 C 的函数体，没法验证你的断言，写错了（比如把 `usize` 写成 `i32`）就是未定义行为。所以这个块本身要标成 `unsafe`，表示"这里是我在担保"。改成 `unsafe extern "C"`，再故意不加 `unsafe` 去调用（`ch13_call_unsafe.rs`）：

```text
error[E0133]: call to unsafe function `strlen` is unsafe and requires unsafe block
 --> src/bin/ch13_call_unsafe.rs:9:13
  |
9 |     let n = strlen(s.as_ptr());
  |             ^^^^^^^^^^^^^^^^^^ call to unsafe function
  |
  = note: consult the function's documentation for information on how to avoid undefined behavior

For more information about this error, try `rustc --explain E0133`.
error: could not compile `rust-lab` (bin "ch13_call_unsafe") due to 1 previous error
```

两层 `unsafe` 各管各的：块上的 `unsafe` 是"声明是否正确"的责任，调用点的 `unsafe` 是"这次调用的前置条件是否满足"的责任。`strlen` 要求参数是以 NUL 结尾的有效字符串，`CString` 保证这一点，所以我们补上 `unsafe { }` 并写一句 `SAFETY` 注释（`ch13_strlen.rs`）：

```rust
// SAFETY: `s` is a valid NUL-terminated string that outlives the call.
let n = unsafe { strlen(s.as_ptr()) };
```

```text
strlen = 6
```

类型对应表也在这里：`*const c_char` 是 `const char *`，`usize` 是 `size_t`，`i64` 是 `int64_t`，`std::ffi::c_void` 是 `void`。这些都在 `std::ffi` 里（`c_int`、`c_long` 等同理），不要手写 `i32` 代替 `c_int`，虽然在你的机器上它们碰巧一样。

> [!TIP] safe fn
> 如果一个 C 函数真的没有任何前置条件，edition 2024 允许在 `unsafe extern` 块里把它标成 `safe fn`，调用方就不用写 `unsafe` 了。实验 `ch13_safe_fn.rs`：
>
> ```rust
> unsafe extern "C" {
>     // getpid takes no arguments and has no preconditions: nothing to get wrong.
>     safe fn getpid() -> c_int;
> }
> ```
>
> 运行输出：`getpid() > 0: true`。Pebble 里一个 `safe fn` 都没有：我们的 C 函数全都收指针，都有前置条件。

## fnv1a：值进、值出

`pebble-sys` 里最简单的一个包装。文件 `crates/pebble-sys/src/lib.rs`，先只写这一个函数和它的测试：

```rust
//! FFI shims: a small hand-written C library linked into the Pebble runtime.

unsafe extern "C" {
    /// Reads `len` bytes at `data`; `data` may be null when `len` is 0.
    fn pebble_fnv1a(data: *const u8, len: usize) -> u64;
}
```

然后是包装函数：

```rust
/// Computes the 64-bit FNV-1a hash of `data` using the C implementation.
///
/// ```
/// # use pebble_sys::fnv1a;
/// let digest = fnv1a(b"hello");
/// assert_eq!(digest, 0xa430_d846_80aa_bd0b);
/// ```
#[must_use]
pub fn fnv1a(data: &[u8]) -> u64 {
    // SAFETY: `data.as_ptr()` is valid for `data.len()` reads for the duration
    // of the call and the C function only reads through it. A shared slice
    // never yields a null pointer, and `len == 0` is explicitly allowed.
    unsafe { pebble_fnv1a(data.as_ptr(), data.len()) }
}
```

`data.as_ptr()` 对一个切片给出首元素的指针，`data.len()` 是元素个数，这正是 C 的 `(const uint8_t *data, size_t len)`。`#[must_use]` 第 1 篇见过。Rust 的切片永远不会给出空指针（空切片给的是一个对齐的悬空指针），而 C 头文件里写了"`len == 0` 时 `data` 可以为 NULL"，所以两边的约定是兼容的，这就是 `SAFETY` 注释要逐条核对的东西。

测试怎么写？FNV-1a 有公开的参考值，空串的哈希就是起始常数 `0xcbf29ce484222325`，`"hello"` 是 `0xa430d84680aabd0b`。我们再加一个对拍：用纯 Rust 实现一遍（几行），喂给两边 1000 个字节，要求结果相同。把测试写到同一个文件末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a_empty_is_offset_basis() {
        assert_eq!(fnv1a(b""), 0xcbf2_9ce4_8422_2325);
    }

    #[test]
    fn fnv1a_hello_matches_reference() {
        assert_eq!(fnv1a(b"hello"), 0xa430_d846_80aa_bd0b);
    }

    #[test]
    fn fnv1a_foobar_matches_reference() {
        assert_eq!(fnv1a(b"foobar"), 0x8594_4171_f739_67e8);
    }

    #[test]
    fn fnv1a_long_input_matches_rust_reference() {
        fn reference(data: &[u8]) -> u64 {
            data.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
                (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
            })
        }

        let data: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
        assert_eq!(fnv1a(&data), reference(&data));
    }
}
```

```bash
cargo test -p pebble-sys
```

```text
test tests::fnv1a_foobar_matches_reference ... ok
test tests::fnv1a_hello_matches_reference ... ok
test tests::fnv1a_empty_is_offset_basis ... ok
test tests::fnv1a_long_input_matches_rust_reference ... ok
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
   Doc-tests pebble_sys
test crates/pebble-sys/src/lib.rs - fnv1a (line 10) ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

4 个单元测试加 1 个文档测试（`fnv1a` 上方 `///` 里的那段代码，`cargo test` 会把它当成独立程序编译运行，第 10 篇讲过）。注意最后一个对拍测试里 `wrapping_mul`：C 的无符号乘法本来就是回绕的，Rust 里普通的 `*` 在 debug 构建下溢出会 panic（第 1 篇的实验），所以必须明说"我要回绕"。

## 不透明类型和 repr(C)

下一个要包装的是 arena。C 函数签名里出现了 `PebbleArena *`，Rust 的 `extern` 块里也得有一个类型来写这个指针。直觉做法是把 C 的结构体照抄一遍：`base`、`capacity`、`used`。别抄。头文件说了这个结构是不透明的，它的布局随时可能变，抄一份等于把一个 C 内部细节焊死在 Rust 里。

在讲怎么不抄之前，先搞清楚 `repr(C)` 是什么，因为它是 FFI 里最常见的属性。实验 `ch13_repr_c.rs`：

```rust
struct Rusty { a: u8, b: u32, c: u8 }

#[repr(C)]
struct CLike { a: u8, b: u32, c: u8 }
```

（实验里还加了 `#[allow(dead_code)]` 和打印 `size_of`/`align_of` 的 `main`，完整文件在实验室里。）

```text
Rusty: size 8 align 4
CLike: size 12 align 4
```

同样三个字段，Rust 默认布局 8 字节，`repr(C)` 12 字节。Rust 的默认布局没有承诺任何顺序：编译器可以重排字段来省 padding（这里把两个 `u8` 并排放了）。C 的布局按声明顺序，`a` 后面补 3 字节对齐到 `b`，`c` 后面补 3 字节凑够 4 的倍数。所以凡是要和 C 共享内存布局的结构体，都必须写 `#[repr(C)]`。反过来说，只要你不打算让 C 读写这块内存，默认布局更省空间。

Pebble 用的是另一种办法，Rustonomicon 里推荐的写法：只声明一个"放不下任何东西"的类型，并且只通过指针使用它。文件 `lib.rs` 里在 `fnv1a` 之前加上：

```rust
/// Opaque handle for the C arena type.
///
/// The layout is deliberately unknown: Rust only ever names this type inside a
/// pointer, and the C side of the header is the single source of truth for what
/// it actually contains.
///
/// The marker follows the Rustonomicon's pattern for opaque FFI types: the raw
/// pointer makes the type `!Send` and `!Sync`, and `PhantomPinned` makes it
/// `!Unpin`, so safe code can never move or share it by accident.
#[repr(C)]
struct PebbleArena {
    /// Makes the type impossible to construct in Rust.
    _data: [u8; 0],
    _marker: PhantomData<(*mut u8, PhantomPinned)>,
}
```

`[u8; 0]` 是零长度数组，不占空间，只是让这个结构体"不是空的"（`#[repr(C)]` 的空结构体在 C 里是不合法的）。更重要的是，它的字段是私有的，所以别的代码没办法在 Rust 里构造一个 `PebbleArena`，只能拿到 C 给的指针。`PhantomData<(*mut u8, PhantomPinned)>` 是一个零大小的"幽灵字段"：它不存放任何数据，只是让编译器认为这个结构体"里面有一个 `*mut u8` 和一个 `PhantomPinned`"。这有什么用？先看三个 trait。

### Send、Sync 与"自动 trait"

`Send` 的意思是"这个值可以被移动到另一个线程"，`Sync` 的意思是"`&T` 可以同时被多个线程拿着"。第 14 篇会好好讲线程；这里先要知道它们的特别之处：它们是自动 trait（auto trait）。你不用写 `impl Send for Foo`，编译器看字段：所有字段都是 `Send`，结构体就是 `Send`；有一个不是，整个结构体就不是。裸指针 `*const T` 和 `*mut T` 是故意不实现 `Send` 和 `Sync` 的：编译器不知道指针背后的东西能不能跨线程，宁可拒绝。C++ 里没有这种东西，任何类型你想往 `std::thread` 里塞都可以，出了数据竞争是你的事。

`Unpin` 是第三个自动 trait，意思是"移动这个值是安全的"。绝大多数类型都是 `Unpin`，`PhantomPinned` 是专门用来取消这一点的标记（第 14 篇的 `Pin` 会用到）。对一个 C 管着的结构体来说，Rust 把它按值挪来挪去显然是错的，因为 C 的指针可能指着它的地址。

实验 `ch13_opaque.rs` 把同样的结构体抄过来，让编译器证明三件事：

```rust
fn assert_send<T: Send>() {}
fn assert_sync<T: Sync>() {}
fn assert_unpin<T: Unpin>() {}

fn main() {
    assert_send::<Opaque>();
    assert_sync::<Opaque>();
    assert_unpin::<Opaque>();
}
```

```text
error[E0277]: `*mut u8` cannot be sent between threads safely
  --> src/bin/ch13_opaque.rs:14:19
   |
14 |     assert_send::<Opaque>();
   |                   ^^^^^^ `*mut u8` cannot be sent between threads safely
   |
   = help: within `Opaque`, the trait `Send` is not implemented for `*mut u8`
   = note: required because it appears within the type `(*mut u8, PhantomPinned)`
note: required because it appears within the type `PhantomData<(*mut u8, PhantomPinned)>`
  --> /rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/core/src/marker.rs:814:11
note: required because it appears within the type `Opaque`
  --> src/bin/ch13_opaque.rs:4:8
   |
 4 | struct Opaque {
   |        ^^^^^^
note: required by a bound in `assert_send`
  --> src/bin/ch13_opaque.rs:9:19
   |
 9 | fn assert_send<T: Send>() {}
   |                   ^^^^ required by this bound in `assert_send`

error[E0277]: `*mut u8` cannot be shared between threads safely
  --> src/bin/ch13_opaque.rs:15:19
   |
15 |     assert_sync::<Opaque>();
   |                   ^^^^^^ `*mut u8` cannot be shared between threads safely
   |
   = help: within `Opaque`, the trait `Sync` is not implemented for `*mut u8`
   = note: required because it appears within the type `(*mut u8, PhantomPinned)`
note: required because it appears within the type `PhantomData<(*mut u8, PhantomPinned)>`
  --> /rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/core/src/marker.rs:814:11
note: required because it appears within the type `Opaque`
  --> src/bin/ch13_opaque.rs:4:8
   |
 4 | struct Opaque {
   |        ^^^^^^
note: required by a bound in `assert_sync`
  --> src/bin/ch13_opaque.rs:10:19
   |
10 | fn assert_sync<T: Sync>() {}
   |                   ^^^^ required by this bound in `assert_sync`

error[E0277]: `PhantomPinned` cannot be unpinned
  --> src/bin/ch13_opaque.rs:16:20
   |
16 |     assert_unpin::<Opaque>();
   |                    ^^^^^^ within `Opaque`, the trait `Unpin` is not implemented for `PhantomPinned`
   |
   = note: consider using the `pin!` macro
           consider using `Box::pin` if you need to access the pinned value outside of the current scope
   = note: required because it appears within the type `(*mut u8, PhantomPinned)`
note: required because it appears within the type `PhantomData<(*mut u8, PhantomPinned)>`
  --> /rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/core/src/marker.rs:814:11
note: required because it appears within the type `Opaque`
  --> src/bin/ch13_opaque.rs:4:8
   |
 4 | struct Opaque {
   |        ^^^^^^
note: required by a bound in `assert_unpin`
  --> src/bin/ch13_opaque.rs:11:20
   |
11 | fn assert_unpin<T: Unpin>() {}
   |                    ^^^^^ required by this bound in `assert_unpin`

For more information about this error, try `rustc --explain E0277`.
error: could not compile `rust-lab` (bin "ch13_opaque") due to 3 previous errors
```

三个都被拒绝，原因行都指向 `*mut u8` 或 `PhantomPinned`。一个诚实的说明：在 `pebble-sys` 里，这个标记其实是"腰带加背带"。我实测过，删掉 `_marker` 之后 `Arena` 照样不是 `Send`（下面会看到），因为 `Arena` 里装的是 `NonNull<PebbleArena>`，而 `NonNull` 本身就不是 `Send`。标记保护的是另一种情况：以后有人把 `&PebbleArena` 或者 `PebbleArena` 的别的指针包装放进一个新的结构体里，没有 `NonNull` 兜底，这个类型照样会被判成不能跨线程、不能移动。成本是零（`PhantomData` 不占空间），收益是类型自己把话说清楚。

## 把 C 的堆内存变成 Rust 的值：Arena

现在把 C 的函数声明搬进 Rust。`lib.rs` 里 `PebbleArena` 之后加上这个 `extern` 块（同时把 `fnv1a` 的那一条并进来，一个块里放所有 C 函数就行）：

```rust
unsafe extern "C" {
    /// Reads `len` bytes at `data`; `data` may be null when `len` is 0.
    fn pebble_fnv1a(data: *const u8, len: usize) -> u64;

    /// Returns null on allocation failure.
    fn pebble_arena_create(capacity: usize) -> *mut PebbleArena;
    /// Returns null when the request does not fit.
    fn pebble_arena_alloc(arena: *mut PebbleArena, len: usize) -> *mut c_void;
    fn pebble_arena_used(arena: *const PebbleArena) -> usize;
    fn pebble_arena_capacity(arena: *const PebbleArena) -> usize;
    /// Invalidates every pointer the arena has handed out.
    fn pebble_arena_reset(arena: *mut PebbleArena);
    /// Frees the arena and its backing storage.
    fn pebble_arena_destroy(arena: *mut PebbleArena);
}
```

注意文档注释写在 `extern` 声明上，这是要给将来读这个文件的人看的：每个 C 函数的"返回 NULL 的条件"和"哪些指针会失效"。这里没有 `fold` 那一条，我们最后再加。

接着写包装。要解决三个问题：谁负责释放，`alloc` 返回什么，`Arena` 能不能跨线程。

### 谁来 free：Drop

C++ 里 `Arena` 会是一个类，构造函数调用 `pebble_arena_create`，析构函数调用 `pebble_arena_destroy`，再写好拷贝构造或者把它删掉，否则默认的按位拷贝会造成双重释放，这就是"五法则"。Rust 里的对应物是 `Drop` trait，而且移动是按位复制且不会调用被移动对象的析构（第 2 篇的"没有 moved-from 对象"），所以不存在"忘了写移动构造"或者"用了被移走的对象"的问题：整个值要么还在原处，要么已经整个换了主人，`drop` 恰好执行一次。

先是结构体，它里面只有一个字段，就是 C 给的那个指针：

```rust
/// An owned C bump allocator.
///
/// Created by [`Arena::with_capacity`] and destroyed (C `free`) when the value
/// is dropped. The arena is `!Send + !Sync`; the C struct has no locking.
///
/// At most one slice returned by [`Arena::alloc`] may be alive at a time,
/// because it borrows the arena exclusively. Call [`Arena::reset`] to make all
/// of the capacity available again, which invalidates previously handed out
/// slices.
#[derive(Debug)]
pub struct Arena {
    ptr: NonNull<PebbleArena>,
}
```

然后是 `Drop`：

```rust
impl Drop for Arena {
    fn drop(&mut self) {
        // SAFETY: `self.ptr` came from `pebble_arena_create` and has not been
        // destroyed yet (this is the only place that destroys it), so the C
        // function receives a valid, uniquely owned arena.
        unsafe { pebble_arena_destroy(self.ptr.as_ptr()) };
    }
}
```

字段 `ptr` 是私有的，所以只有这个模块能构造一个 `Arena`，而构造只有 `with_capacity` 一个入口。这就是"笼子"的第一根栏杆：`Arena` 里的指针一定来自 `pebble_arena_create`，而且一定没被销毁过，所以 `Drop` 里的 `SAFETY` 注释能写得出来。

### Option 和空指针

`with_capacity` 要处理 C 返回 `NULL` 的情况（`malloc` 失败）。C 里你会 `if (p == NULL)`，Rust 里我们用 `NonNull::new(ptr)`：它接收一个裸指针，空就返回 `None`，否则返回 `Some(NonNull)`。下面的方法都放在 `impl Arena { ... }` 块里。结合第 2 篇的 `?`：

```rust
    /// Creates an arena with room for `bytes` bytes of allocations.
    ///
    /// Returns `None` if the C side cannot obtain memory. A capacity of zero is
    /// valid: the returned arena exists and every [`Arena::alloc`] fails.
    #[must_use]
    pub fn with_capacity(bytes: usize) -> Option<Arena> {
        // SAFETY: `pebble_arena_create` has no preconditions and returns either
        // a live arena owned by the caller or null.
        let ptr = unsafe { pebble_arena_create(bytes) };
        Some(Arena {
            ptr: NonNull::new(ptr)?,
        })
    }
```

`NonNull<T>` 是"保证非空的 `*mut T`"，这个保证让编译器可以把 `Option<NonNull<T>>` 压成和裸指针一样大：用全零的位模式表示 `None`。实验 `ch13_niche.rs`：

```text
*mut u8             8
NonNull<u8>         8
Option<NonNull<u8>> 8
Option<*mut u8>     16
Option<&u8>         8
Option<u32>         8
```

`Option<NonNull<u8>>` 是 8 字节，和 `NonNull<u8>` 一样，而 `Option<*mut u8>` 要 16 字节（裸指针本身可以是 0，所以没有空位留给 `None`，只好多加一个标签）。这个技巧在 Rust 里叫"niche 优化"，`Option<&T>` 和 `Option<Box<T>>` 也享受它。所以 `Option<NonNull<T>>` 和 C 的可空指针 `T *` 在 ABI 上等价，这也是为什么你可以在 FFI 签名里直接写 `Option<NonNull<T>>` 或 `Option<&T>`。

### 一个带依赖的实验 crate

接下来的几个实验需要用到我们自己的 `pebble-sys`，所以不能放进 `~/rust-lab`（那里只依赖标准库）。另开一个实验 crate：

```bash
cargo new ~/lab-ch13-sys
```

把 `~/lab-ch13-sys/Cargo.toml` 改成（路径换成你的 pebble 目录）：

```toml
[package]
name = "lab-ch13-sys"
version = "0.1.0"
edition = "2024"

[dependencies]
pebble-sys = { path = "/path/to/pebble/crates/pebble-sys" }

[workspace]
```

末尾那个空的 `[workspace]` 是告诉 Cargo：这个 crate 自己是一个独立的工作区，不要往上找父目录里的工作区（否则实验放在 pebble 目录里会被当成成员，报错）。每个实验是 `src/bin/<名字>.rs`，用 `cargo run --quiet --bin <名字>` 运行。输出里的路径是我机器上的，你的会不同。

### alloc：返回 &mut [u8]，借谁的

`pebble_arena_alloc` 返回一个裸指针，长度是我们自己传进去的那个 `len`，我们想把这对东西变成 Rust 的切片 `&mut [u8]`。关键问题是这个切片的生命周期绑在谁身上。最顺手的写法，C 程序员的直觉：反正 C 函数通过指针修改 arena，我又没改 Rust 里的任何字段，`&self` 就够了。我把签名改成 `pub fn alloc(&self, len: usize) -> Option<&mut [u8]>` 看看：

```bash
cargo clippy -p pebble-sys --lib
```

```text
   Compiling shlex v2.0.1
   Compiling find-msvc-tools v0.1.14
   Compiling cc v1.6.0
   Compiling pebble-sys v0.1.0 (/tmp/lab-ch13-scratch/crates/pebble-sys)
warning: mutable borrow from immutable input(s)
   --> crates/pebble-sys/src/lib.rs:136:47
    |
136 |     pub fn alloc(&self, len: usize) -> Option<&mut [u8]> {
    |                                               ^^^^^^^^^
    |
note: immutable borrow here
   --> crates/pebble-sys/src/lib.rs:136:18
    |
136 |     pub fn alloc(&self, len: usize) -> Option<&mut [u8]> {
    |                  ^^^^^
    = help: for further information visit https://rust-lang.github.io/rust-clippy/master/index.html#mut_from_ref
    = note: `-W clippy::mut-from-ref` implied by `-W clippy::all`
    = help: to override `-W clippy::all` add `#[allow(clippy::mut_from_ref)]`

warning: `pebble-sys` (lib) generated 1 warning
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.10s
```

编译器本身一声没吭，是 clippy 的 `mut_from_ref` 拦下来的：从 `&self` 变出 `&mut` 几乎一定是错的，因为共享引用可以有很多个，每个都能变出一个独占引用。到底会错在哪里？只要 `reset` 也写成 `&self`（它只是改一下 C 里的偏移，看起来无害），就有这个程序（`examples/overlap.rs`，放在这个"错误版本"里）：

```rust
let arena = Arena::with_capacity(64).expect("no memory");
let a = arena.alloc(8).expect("full");
arena.reset();
let b = arena.alloc(8).expect("full");
a[0] = 1;
b[0] = 2;
```

```text
a and b start at the same address: true
a[0] = 2
```

编译通过，运行也不崩，但 `a` 和 `b` 是两个同时活着的 `&mut [u8]`，指向同一块内存。`a[0]` 明明写的是 1，读出来是 2。这就是 Rust 的核心规则"独占引用不能别名"被我们自己亲手破坏了。更糟的是，编译器会按"独占引用不会别名"这个假设去优化，这样的程序在 release 构建下会出什么行为，没有人保证。这是 `unsafe` 里最典型的错：不是某个操作本身不行，而是你对外承诺的安全接口留了个洞。

修法是让 `alloc` 要 `&mut self`，返回的切片借用着整个 `Arena`，这样在这个切片活着的时候，没有人能再调用 `alloc` 或 `reset`。这是要付代价的，实验 `arena_two_slices.rs`（在 `~/lab-ch13-sys` 里，用真的 `pebble-sys` 作依赖）试图同时拿两个切片：

```text
error[E0499]: cannot borrow `arena` as mutable more than once at a time
 --> src/bin/arena_two_slices.rs:6:13
  |
5 |     let a = arena.alloc(8).expect("full");
  |             ----- first mutable borrow occurs here
6 |     let b = arena.alloc(8).expect("full");
  |             ^^^^^ second mutable borrow occurs here
7 |     a[0] = 1;
  |     ---- first borrow later used here

For more information about this error, try `rustc --explain E0499`.
error: could not compile `lab-ch13-sys` (bin "arena_two_slices") due to 1 previous error
```

同一时刻只能手里拿一个切片。对 bump 分配器来说这个限制偏紧：真正的 arena 库（据我所知，比如 `bumpalo`）走的是另一条路，`alloc` 取 `&self`，靠"每次给出的区域互不重叠"来保证健全，而 `reset` 取 `&mut self`。我们选了更保守的一边：正确优先，且不需要读者去证明区域不重叠。写出来：

```rust
    /// Bump-allocates `len` uninitialised bytes and returns them as a slice.
    ///
    /// The returned slice borrows the arena exclusively, so no other allocation
    /// (and no other method of this arena) can be used while it is alive. This
    /// is what makes the returned `&mut [u8]` sound even though the C allocator
    /// hands out raw pointers: Rust cannot observe two live regions at once.
    ///
    /// Returns `None` when the remaining capacity cannot satisfy the request
    /// (including any request on a zero-capacity arena).
    #[must_use]
    pub fn alloc(&mut self, len: usize) -> Option<&mut [u8]> {
        // SAFETY: `self.ptr` is a live arena owned by `self`, and the C function
        // neither retains the arena nor frees it.
        let raw = unsafe { pebble_arena_alloc(self.ptr.as_ptr(), len) };
        let raw = NonNull::new(raw)?.cast::<u8>();
        // SAFETY: `raw` points into the arena's storage and the C allocator
        // guarantees at least `len` bytes there, aligned for any scalar. The
        // region is not aliased: any other borrow of `self` would have to go
        // through this `&mut self` borrow. The pointer is never null.
        Some(unsafe { slice::from_raw_parts_mut(raw.as_ptr(), len) })
    }
```

两处 `unsafe` 各有一句 `SAFETY`。第一处调用 C，前置条件是"arena 是活的"，`self.ptr` 保证了。第二处 `slice::from_raw_parts_mut`（第 11 篇的老朋友，把"指针加长度"变成切片）要求指针非空、对齐、指向 `len` 个已初始化的字节且没有别名。"已初始化"这一条值得多想：C 的 `malloc` 给出的是没初始化的内存，用 `&mut [u8]` 去表示它严格来说是个灰色地带（Rust 把读取未初始化字节算作未定义行为）。我们的 `alloc` 文档写了"contents are unspecified"，调用者应该先写后读，这也是我把它标成"uninitialised bytes"的原因。这里有个我没有解决的小问题：更严格的写法应该返回 `&mut [MaybeUninit<u8>]`（第 11 篇的 `MaybeUninit`），而不是 `&mut [u8]`，代价是调用方每次都得面对 `MaybeUninit`。

### 对齐：看一眼 C 在做什么

`used()` 为什么说"包括对齐的 padding"？实验 `arena_bytes.rs`（同一个 lab 里，依赖 `pebble-sys`）建一个容量 64 字节的 `Arena`，连续分配 1、1、24 个字节，再要 8 个：

```rust
use pebble_sys::Arena;

fn main() {
    let mut arena = Arena::with_capacity(64).expect("no memory");
    for len in [1, 1, 24] {
        let slice = arena.alloc(len).expect("full");
        println!("len {len:>2} at address ...{:02x}", slice.as_ptr() as usize & 0xff);
        println!("   used = {}", arena.used());
    }
    println!("a fourth, 8-byte request: {:?}", arena.alloc(8));
}
```

输出：

```text
len  1 at address ...f0
   used = 1
len  1 at address ...00
   used = 17
len 24 at address ...10
   used = 56
a fourth, 8-byte request: None
```

第一个 1 字节从 `...f0` 开始，用掉 1；第二个也是 1 字节，但它的地址是 `...00`，比上一个多了 16，不是 1：C 的分配器把偏移对齐到 16 的倍数（`PEBBLE_ALIGNMENT`），所以 `used` 是 `16 + 1 = 17`。第三个从 32 开始，24 字节，`used = 56`。第四个要 8 字节，下一个对齐点是 64，`64 + 8 > 64`，放不下，返回 `None`。这四个数字和 C 里的 `pebble_align_up` 完全吻合。

### 其余的方法与 Send

`used`、`capacity`、`reset` 都是一行 `unsafe` 调用加一句 `SAFETY`：

```rust
    /// Bytes handed out so far, including alignment padding between allocations.
    #[must_use]
    pub fn used(&self) -> usize {
        // SAFETY: `self.ptr` is a live arena and the C function only reads it.
        unsafe { pebble_arena_used(self.ptr.as_ptr()) }
    }

    /// Total bytes this arena can hand out.
    #[must_use]
    pub fn capacity(&self) -> usize {
        // SAFETY: `self.ptr` is a live arena and the C function only reads it.
        unsafe { pebble_arena_capacity(self.ptr.as_ptr()) }
    }

    /// Rewinds the arena, making all of its capacity available again.
    ///
    /// Every slice previously returned by [`Arena::alloc`] is invalidated, which
    /// the exclusive `&mut self` borrow already enforces.
    pub fn reset(&mut self) {
        // SAFETY: `self.ptr` is a live arena. The C function only updates the
        // bump offset; `&mut self` guarantees no outstanding slice.
        unsafe { pebble_arena_reset(self.ptr.as_ptr()) };
    }
}
```

`reset` 要 `&mut self`，这样已经借出去的切片都必须先死掉，这一条在上面的 `overlap` 示例里就是缺的那个。

最后，`Arena` 能不能跨线程？C 的 arena 没有锁，所以不能。实验 `arena_send.rs`（同一个 lab）：

```text
error[E0277]: `NonNull<pebble_sys::PebbleArena>` cannot be sent between threads safely
   --> src/bin/arena_send.rs:6:32
    |
  6 |     let handle = thread::spawn(move || arena.used());
    |                  ------------- -------^^^^^^^^^^^^^
    |                  |             |
    |                  |             `NonNull<pebble_sys::PebbleArena>` cannot be sent between threads safely
    |                  |             within this `{closure@src/bin/arena_send.rs:6:32: 6:39}`
    |                  required by a bound introduced by this call
    |
    = help: within `{closure@src/bin/arena_send.rs:6:32: 6:39}`, the trait `Send` is not implemented for `NonNull<pebble_sys::PebbleArena>`
note: required because it appears within the type `Arena`
   --> /tmp/pebble-rebuild-13/crates/pebble-sys/src/lib.rs:107:12
    |
107 | pub struct Arena {
    |            ^^^^^
note: required because it's used within this closure
   --> src/bin/arena_send.rs:6:32
    |
  6 |     let handle = thread::spawn(move || arena.used());
    |                                ^^^^^^^
note: required by a bound in `spawn`
   --> /rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/std/src/thread/functions.rs:125:0

For more information about this error, try `rustc --explain E0277`.
error: could not compile `lab-ch13-sys` (bin "arena_send") due to 1 previous error
```

`NonNull<PebbleArena>` 不是 `Send`，所以包着它的 `Arena` 不是，编译器当场拒绝了。这个报错的理由前面已经讲完了，这里的价值是确认：不需要写一行代码，保护就在了。线程的事第 14 篇再细讲。

文件头的 `use` 现在是 `std::ffi::c_void`、`std::marker::{PhantomData, PhantomPinned}`、`std::ptr::NonNull`、`std::slice`，编译器会告诉你缺哪个。测试：写 `arena_alloc_used_and_reset`（分配、写入、读回、`reset`、再整块分配），写 `arena_exhaustion_returns_none`；另外三个（`arena_reports_capacity`、`arena_allocations_do_not_overlap`、`zero_capacity_arena_allocation_fails`）复制 tag 里的：

```rust
    #[test]
    fn arena_alloc_used_and_reset() {
        let mut arena = Arena::with_capacity(64).expect("arena creation failed");

        let region = arena.alloc(8).expect("first allocation failed");
        assert_eq!(region.len(), 8);
        region.copy_from_slice(&[7u8; 8]);
        assert_eq!(region, &[7u8; 8]);

        let used_after_first = arena.used();
        assert!(used_after_first >= 8, "used = {used_after_first}");

        let _second = arena.alloc(8).expect("second allocation failed");
        assert!(arena.used() > used_after_first);

        arena.reset();
        assert_eq!(arena.used(), 0);

        // After a reset the whole capacity is available again.
        let whole = arena.alloc(64).expect("allocation after reset failed");
        assert_eq!(whole.len(), 64);
        assert_eq!(arena.used(), 64);
    }

    #[test]
    fn arena_exhaustion_returns_none() {
        let mut arena = Arena::with_capacity(16).expect("arena creation failed");
        assert!(arena.alloc(16).is_some());
        assert!(arena.alloc(1).is_none());
    }
```

```bash
cargo test -p pebble-sys
```

```text
test tests::arena_alloc_used_and_reset ... ok
test tests::arena_exhaustion_returns_none ... ok
test tests::arena_allocations_do_not_overlap ... ok
test tests::arena_reports_capacity ... ok
test tests::fnv1a_hello_matches_reference ... ok
test tests::fnv1a_foobar_matches_reference ... ok
test tests::fnv1a_empty_is_offset_basis ... ok
test tests::zero_capacity_arena_allocation_fails ... ok
test tests::fnv1a_long_input_matches_rust_reference ... ok
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
   Doc-tests pebble_sys
test crates/pebble-sys/src/lib.rs - fnv1a (line 42) ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

9 个单元测试加 1 个文档测试。这是我在重建目录里真的跑过的"只含 `fnv1a` 和 `Arena`"的中间状态；`arena_alloc_used_and_reset` 里最后那句 `assert_eq!(arena.used(), 64)` 证明了 `reset` 之后整块容量都回来了。

## 回调：闭包怎么穿过一个 void*

最后一个包装是 `fold`：C 里 `pebble_fold(init, lo, hi, cb, ctx)` 对 `lo..=hi` 里的每个整数调用 `cb(acc, value, ctx)`。我们希望 Rust 这边的接口是 `fold(0, 1..=100, |acc, value| acc + value)`，传一个闭包。

直接传不行。试试把闭包赋给 C 回调的类型（`closure_cb.rs`）：

```rust
let scale = 3;
let cb: extern "C" fn(i64, i64, *mut c_void) -> i64 = |acc, value, _ctx| acc + value * scale;
```

```text
error[E0308]: mismatched types
 --> src/bin/closure_cb.rs:5:59
  |
5 |     let cb: extern "C" fn(i64, i64, *mut c_void) -> i64 = |acc, value, _ctx| acc + value * scale;
  |             -------------------------------------------   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ expected fn pointer, found closure
  |             |
  |             expected due to this
  |
  = note: expected fn pointer `extern "C" fn(i64, i64, *mut c_void) -> i64`
                found closure `{closure@src/bin/closure_cb.rs:5:59: 5:77}`
note: closures can only be coerced to `fn` types if they do not capture any variables
 --> src/bin/closure_cb.rs:5:92
  |
5 |     let cb: extern "C" fn(i64, i64, *mut c_void) -> i64 = |acc, value, _ctx| acc + value * scale;
  |                                                                                            ^^^^^ `scale` captured here

For more information about this error, try `rustc --explain E0308`.
error: could not compile `lab-ch13-sys` (bin "closure_cb") due to 1 previous error
```

"闭包只有在不捕获任何变量时才能转成 `fn` 类型"，原因第 8 篇讲过：闭包是一个带数据的结构体，函数指针只是一个地址，没地方放 `scale`。而且即使不捕获，闭包的调用约定是 Rust 的，也不是 C 的。所以我们需要两件东西：一个真正的 `extern "C" fn`（蹦床，trampoline），和一条把闭包传过去的通道。通道就是 C 给我们的 `void *ctx`：我们把"闭包加上别的状态"打成一个结构体，把它的地址当成 `void *` 交给 C，C 原样还回来，蹦床把它还原成引用，调用闭包。

在 `lib.rs` 里先加类型别名，再加到 `extern` 块里：

```rust
/// The callback signature `pebble_fold` calls for every value.
type FoldFn = unsafe extern "C" fn(i64, i64, *mut c_void) -> i64;
```

`extern` 块里再加一条：

```rust
    /// Calls `cb` once for every integer in `[lo, hi]`, in order.
    fn pebble_fold(init: i64, lo: i64, hi: i64, cb: FoldFn, ctx: *mut c_void) -> i64;
```

上下文结构体和蹦床：

```rust
/// State shared between [`fold`] and its C trampoline.
struct FoldCtx<'a> {
    /// The caller's closure.
    f: &'a mut dyn FnMut(i64, i64) -> i64,
    /// Set by the trampoline if the closure panicked.
    panic: Option<Box<dyn Any + Send + 'static>>,
}
```

`&'a mut dyn FnMut(i64, i64) -> i64` 是第 8、9 篇的老朋友：一个指向"任何可变闭包"的胖指针。`'a` 是生命周期参数（第 4 篇）：上下文借用着闭包，不能比它活得久。`panic` 字段先放着，一会儿讲。

```rust
/// The Rust function C calls once per value, cast to `pebble_fold_fn`.
///
/// A panic must not unwind into C, so the closure runs inside
/// [`catch_unwind`]; the payload is stashed in the context and the panic is
/// resumed in [`fold`] after C has returned.
extern "C" fn fold_trampoline(acc: i64, value: i64, ctx: *mut c_void) -> i64 {
    // SAFETY: `fold` passes a pointer to a `FoldCtx` that outlives the whole
    // `pebble_fold` call, passes the same pointer to every invocation, and the
    // trampoline is the only callback C is given for that call.
    let ctx: &mut FoldCtx<'_> = unsafe { &mut *ctx.cast() };
    if ctx.panic.is_some() {
        // The closure already panicked; do not call into possibly-broken state
        // again while C keeps walking the range.
        return acc;
    }
    match catch_unwind(AssertUnwindSafe(|| (ctx.f)(acc, value))) {
        Ok(next) => next,
        Err(payload) => {
            ctx.panic = Some(payload);
            acc
        }
    }
}
```

函数签名里的 `extern "C" fn` 表示"这个 Rust 函数使用 C 的调用约定"，所以它的地址可以当成 `pebble_fold_fn` 交给 C。（`FoldFn` 别名里写的是 `unsafe extern "C" fn`，一个安全的 `extern "C" fn` 可以自动转成它。）第一行 `unsafe { &mut *ctx.cast() }` 把 `void *` 转回 `&mut FoldCtx`：`cast()` 是裸指针之间的类型转换，类型由左边的标注 `&mut FoldCtx<'_>` 推出来。这里的 `SAFETY` 是整个模块里最重要的一句：我们声明"`fold` 传进来的就是一个活着的 `FoldCtx`，并且每次回调都是同一个"。编译器对此毫无办法验证，C 那边的 `void *` 不带类型也不带生命周期。

### 如果闭包 panic 了

蹦床的 `catch_unwind` 是干嘛的？先看看没有它会怎样。实验 `fold_nocatch.rs`（同一个 lab，开头加一行 `use pebble_sys as _;` 让链接器带上 C 库）直接声明 `pebble_fold`，传一个遇到 `value == 3` 就 panic 的 `extern "C"` 回调：

```rust
extern "C" fn exploding(acc: i64, value: i64, _ctx: *mut c_void) -> i64 {
    assert_ne!(value, 3, "callback exploded");
    acc + value
}
```

输出（原始输出里有一段二十多行的回溯，我保留了头尾，中间用 `...` 标出）：

```text
thread 'main' (64208) panicked at src/bin/fold_nocatch.rs:15:5:
assertion `left != right` failed: callback exploded
  left: 3
 right: 3
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace

thread 'main' (64208) panicked at /rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/core/src/panicking.rs:225:5:
panic in a function that cannot unwind
stack backtrace:
...
  12:     0x5c5c915621f6 - fold_nocatch::exploding::heb0ddd44d5d3d388
                               at /tmp/lab-ch13-sys/src/bin/fold_nocatch.rs:14:1
  13:     0x5c5c91562396 - pebble_fold
                               at /tmp/pebble-rebuild-13/crates/pebble-sys/csrc/pebble_shim.c:120:15
...
thread caused non-unwinding panic. aborting.
```

进程被 `abort` 了（退出码 134）。注意第 13 帧：回溯里同时有 Rust 的 `exploding` 和 C 的 `pebble_fold`（带着 `pebble_shim.c:120` 的行号），说明回调确实是从 C 栈帧里被调用的。

Rust 的 panic 默认通过"栈展开"（unwinding）实现：沿着调用栈往回走，逐帧运行析构函数。C 的栈帧不是为 Rust 的展开准备的：C 没有析构函数可调用，编译器也不保证它带着展开所需的信息（C++ 的异常穿过 C 帧同理）。所以语言规定，panic 一旦要穿过 `extern "C"` 边界，就是未定义行为，不能放行。我这台机器的 rustc 1.95.0 的做法是：在 `extern "C" fn` 的边界上把它变成 `abort`，也就是上面的 "panic in a function that cannot unwind"。我听说更老的编译器对此是未定义行为或者直接展开进 C 的栈帧，但我没装老版本去验证。

不想进程被杀，就必须在边界上把 panic 拦下来。这就是 `catch_unwind`：运行一个闭包，如果里面 panic 了，不展开出去，而是把 panic 变成一个 `Err(payload)` 返回。

### AssertUnwindSafe 和 Box<dyn Any + Send>

`catch_unwind` 有两个陌生的细节。第一，直接把我们的闭包放进去会被编译器拒绝，实验 `ch13_unwind_safe.rs`：

```rust
let mut total = 0;
let result = catch_unwind(|| {
    total += 1;
    panic!("boom");
});
```

```text
error[E0277]: the type `&mut i32` may not be safely transferred across an unwind boundary
 --> src/bin/ch13_unwind_safe.rs:5:31
  |
5 |       let result = catch_unwind(|| {
  |                    ------------ ^-
  |                    |            |
  |  __________________|____________within this `{closure@src/bin/ch13_unwind_safe.rs:5:31: 5:33}`
  | |                  |
  | |                  required by a bound introduced by this call
6 | |         total += 1;
7 | |         panic!("boom");
8 | |     });
  | |_____^ `&mut i32` may not be safely transferred across an unwind boundary
  |
  = help: within `{closure@src/bin/ch13_unwind_safe.rs:5:31: 5:33}`, the trait `UnwindSafe` is not implemented for `&mut i32`
  = note: `UnwindSafe` is implemented for `&i32`, but not for `&mut i32`
note: required because it's used within this closure
 --> src/bin/ch13_unwind_safe.rs:5:31
  |
5 |     let result = catch_unwind(|| {
  |                               ^^
note: required by a bound in `std::panic::catch_unwind`
 --> /rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/std/src/panic.rs:358:0

For more information about this error, try `rustc --explain E0277`.
error: could not compile `rust-lab` (bin "ch13_unwind_safe") due to 1 previous error
```

`UnwindSafe` 是另一个标记 trait，意思是"panic 之后你还能放心地观察这个值"。可变引用不满足它：闭包可能改了一半就 panic，改到一半的数据被外面看到，不变式就破了。这不是内存安全问题（所以这个 trait 不是 `unsafe`），而是逻辑安全。我们的蹦床里，panic 之后 `ctx.panic` 被设置，之后的调用全部跳过闭包，闭包的捕获状态不会再被读取；所以我们可以向编译器担保没问题，写 `AssertUnwindSafe(|| ...)`，这是一个什么也不做的包装，仅仅用来表态："我检查过了"。

第二，`catch_unwind` 返回的 `Err` 里装的是 `Box<dyn Any + Send + 'static>`：panic 可以携带任意类型的值。`Any` 是"可以在运行时问你是什么类型"的 trait（第 8 篇的 trait 对象再加一个 `downcast_ref`），实验 `ch13_any_payload.rs` 看三种 panic 带的是什么：

```rust
let literal = catch_unwind(|| panic!("a literal")).unwrap_err();
let n = 3;
let formatted = catch_unwind(|| panic!("formatted {n}")).unwrap_err();
let custom = catch_unwind(|| std::panic::panic_any(42_i32)).unwrap_err();
```

```text
&str: a literal
String: formatted 3
something else

thread 'main' (60807) panicked at src/bin/ch13_any_payload.rs:15:35:
a literal
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace

thread 'main' (60807) panicked at src/bin/ch13_any_payload.rs:17:37:
formatted 3

thread 'main' (60807) panicked at src/bin/ch13_any_payload.rs:18:34:
Box<dyn Any>
```

字面量消息的负载是 `&'static str`，格式化消息的负载是 `String`，`panic_any(42)` 的负载是 `i32`，所以第三个哪个 `downcast_ref` 都不中，只能打印"something else"。（输出里三条 `panicked at` 是默认的 panic 钩子在往 stderr 打印，不是我们的代码打的。）蹦床不关心负载是什么，把整个 `Box<dyn Any + Send>` 存进 `FoldCtx.panic`，等 C 返回之后原样交还给 Rust。

### resume_unwind：等 C 走完再重新抛

现在 `fold` 本体就好写了：

```rust
/// Folds `range` through `f` inside C, returning the final accumulator.
///
/// C calls `f(acc, value)` once per integer in `range`, in ascending order, with
/// `init` as the initial accumulator; each call receives the previous call's
/// result. An empty range (`start > end`) returns `init` without invoking `f`.
///
/// The closure is boxed and passed to C as an opaque context pointer, so it may
/// capture state mutably.
///
/// # Panics
///
/// A panic in `f` is caught at the FFI boundary and resumed on this side once C
/// has unwound its own frames: unwinding through C would be undefined
/// behaviour. The panic payload is preserved.
///
/// ```
/// # use pebble_sys::fold;
/// assert_eq!(fold(0, 1..=100, |acc, value| acc + value), 5050);
/// ```
pub fn fold(init: i64, range: RangeInclusive<i64>, f: impl FnMut(i64, i64) -> i64) -> i64 {
    let mut f: Box<dyn FnMut(i64, i64) -> i64> = Box::new(f);
    let mut ctx = FoldCtx {
        f: &mut *f,
        panic: None,
    };
    // SAFETY: `fold_trampoline` is a valid `pebble_fold_fn` and `ctx` outlives
    // the call. C invokes the callback only while `pebble_fold` runs, only with
    // `ctx` as given, and retains nothing after it returns. `ctx` is not shared:
    // C is single-threaded here and the range walk is sequential.
    let result = unsafe {
        pebble_fold(
            init,
            *range.start(),
            *range.end(),
            fold_trampoline,
            std::ptr::from_mut(&mut ctx).cast::<c_void>(),
        )
    };

    if let Some(payload) = ctx.panic.take() {
        // `ctx` is no longer borrowed by anything, and C has returned, so it is
        // safe to unwind now with the original payload.
        resume_unwind(payload);
    }
    result
}
```

逐段读：`Box::new(f)` 把闭包放到堆上再转成 `Box<dyn FnMut>`；`&mut *f` 取出里面的 `&mut dyn FnMut` 放进上下文。（坦白：这个 `Box` 是多余的。我在重建目录里把它换成 `let mut f = f;` 加 `f: &mut f`，15 个测试 2 个文档测试照样全过，因为 `&mut impl FnMut` 可以直接转成 `&mut dyn FnMut`。tag 里就是上面的写法，所以我也照抄；把它删掉可以当成一个练习。）`std::ptr::from_mut(&mut ctx).cast::<c_void>()` 把上下文的地址变成 `*mut c_void`，这是把"引用"变成"裸指针"的现代写法，比 `as *mut _` 更不容易手滑。`ctx` 活在 `fold` 的栈帧里，C 的调用结束前不会被移动或销毁，这就是 `SAFETY` 注释里"`ctx` outlives the call"的依据。

C 返回之后，如果 `ctx.panic` 里有负载，就用 `resume_unwind(payload)` 在 Rust 这一侧重新抛出。`resume_unwind` 和 `panic!` 的区别是它不会再调用 panic 钩子，不会再打印第二遍消息。实验 `fold_panic.rs` 从外面用 `catch_unwind` 包住 `fold`，验证负载原样保留：

```text
caught on the Rust side: assertion `left != right` failed: closure exploded
  left: 3
 right: 3

thread 'main' (62791) panicked at src/bin/fold_panic.rs:6:13:
assertion `left != right` failed: closure exploded
  left: 3
 right: 3
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
```

`panicked at` 只出现一次（来自原始的 `assert_ne!`），而外面收到的 `String` 负载正是 `assertion ... closure exploded`。

一个小细节，蹦床里 `if ctx.panic.is_some() { return acc; }`：C 的 `pebble_fold` 不知道出过事，会继续把剩下的整数一个个喂给回调。第一次 panic 之后我们不想再碰那个很可能处于半坏状态的闭包，所以后面的调用空转，直接把累加值还回去。

最后补 `lib.rs` 里 `fold` 需要的 `use`，然后写三个 `fold` 的测试：`fold_sums_inclusive_range`、`fold_closure_can_capture_mutable_state`（闭包里 `calls += 1`，证明蹦床能带着可变状态）、`fold_resumes_closure_panic`（`#[should_panic(expected = "closure exploded")]`），追加到 `mod tests` 里；其余三个（空区间、访问顺序、`i64::MAX` 边界）复制 tag：

```rust
    #[test]
    fn fold_sums_inclusive_range() {
        assert_eq!(fold(0, 1..=100, |acc, value| acc + value), 5050);
    }

    #[test]
    fn fold_closure_can_capture_mutable_state() {
        let mut calls = 0;
        let result = fold(1, 0..=5, |acc, value| {
            calls += 1;
            acc * (value + 1)
        });
        assert_eq!(calls, 6);
        assert_eq!(result, 720);
    }

    #[test]
    #[should_panic(expected = "closure exploded")]
    fn fold_resumes_closure_panic() {
        let _ = fold(0, 1..=10, |acc, value| {
            assert_ne!(value, 3, "closure exploded");
            acc + value
        });
    }
```

`fold_handles_int64_max_bound` 和 `fold_empty_range_returns_init` 这两个复制来的测试，正是测试 C 代码里"循环变量不溢出"和"`lo > hi` 返回 `init`"那两个细节。

到这里，`pebble-sys` 的所有代码都有了。`lib.rs` 的最后几件杂事：顶部那段 34 行的 `//!` 模块文档（描述这个 crate 的健全性论证，纯注释，不影响编译）照抄 tag，文件头的 `use` 一共七行，最终是这样：

```rust
use std::any::Any;
use std::ffi::c_void;
use std::marker::{PhantomData, PhantomPinned};
use std::ops::RangeInclusive;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::ptr::NonNull;
use std::slice;
```

整个文件的顺序是：`//!` 文档、`use`、`PebbleArena`、`FoldFn`、`extern` 块、`fnv1a`、`Arena` 与 `impl`、`impl Drop`、`FoldCtx`、`fold_trampoline`、`fold`、`mod tests`。检查点里会对着 tag 逐字节确认。

## 反过来：让 C 调用 Rust，以及五件 Pebble 没用到的东西

`pebble-sys` 只做了一个方向：Rust 调 C。反方向（C 或 Python 或 Go 调你的 Rust 库）和 FFI 的另外几个常见零件，Pebble 里没有地方自然地用到它们，我不想为了凑特性往仓库里硬塞，所以这一节用实验室里的小程序讲。每个例子都编译运行过，输出是真的。

### no_mangle 与 cdylib：做一个 C 能链接的共享库

C 要调用 Rust 函数，需要两样：一个符号名固定的函数，和一个 C 链接器认识的库格式。Rust 的函数名默认会被修饰（mangle，规则和 C++ 的类似），所以要用 `#[unsafe(no_mangle)]` 关掉；函数要用 `extern "C"` 声明调用约定；crate 要在 `Cargo.toml` 里声明 `crate-type = ["cdylib"]` 才会产出 `.so`。注意 `no_mangle` 在 edition 2024 里要包在 `unsafe(...)` 里写，因为"符号名撞车"是编译器看不见的风险。这个实验必须是独立的 crate（`~/lab-ch13-cdylib`）：

```toml
[package]
name = "pebble_ffi_demo"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib"]

[workspace]
```

```rust
/// Callable from C as `int64_t pebble_add(int64_t, int64_t)`.
#[unsafe(no_mangle)]
pub extern "C" fn pebble_add(a: i64, b: i64) -> i64 {
    a + b
}

/// Not exported under a stable name: Rust mangles it.
pub fn mangled(a: i64) -> i64 {
    a * 2
}
```

C 这一侧，`main.c`：

```c
#include <stdint.h>
#include <stdio.h>

int64_t pebble_add(int64_t a, int64_t b);

int main(void) {
    printf("pebble_add(40, 2) = %lld\n", (long long)pebble_add(40, 2));
    return 0;
}
```

```bash
cargo build
nm -D target/debug/libpebble_ffi_demo.so | grep pebble_add
nm target/debug/libpebble_ffi_demo.so | grep -c mangled
gcc main.c -L target/debug -lpebble_ffi_demo -o main
LD_LIBRARY_PATH=target/debug ./main
```

```text
0000000000007b30 T pebble_add
0
```

```text
pebble_add(40, 2) = 42
```

第一行是 `nm -D`（动态符号表）里的 `pebble_add`，`T` 表示导出的函数；第二行的 `0` 是我数了一下符号表里有几个名字带 `mangled` 的：没有被 `no_mangle` 标记的那个函数根本没有出现在 `.so` 里（我猜是因为它既没导出、也没人调用，所以被丢掉了）。最后一行是 C 程序真的调用了 Rust 写的函数。`cdylib` 和 `-shared` 编出来的 `.so` 在 C 的一侧没有区别，这是 Python 的 `ctypes`、Node 的 `ffi`、Go 的 cgo 都能直接调用 Rust 库的原因。

### repr(transparent)：包一层但不改 ABI

给 C 句柄起一个有类型的名字，是很常见的需求：`struct Handle(u64)`。默认布局下，编译器不承诺这个包装和裸的 `u64` 在函数调用里被同样传递。`#[repr(transparent)]` 承诺：只有一个"非零大小"字段的结构体，布局和 ABI 与那个字段完全相同。实验 `ch13_repr_transparent.rs`：

```rust
use std::mem::{align_of, size_of};

#[repr(transparent)]
struct Handle(u64);

#[allow(dead_code)]
struct Plain(u64, ());

unsafe extern "C" {
    fn abs(x: i32) -> i32;
}

fn main() {
    println!("Handle: size {} align {}", size_of::<Handle>(), align_of::<Handle>());
    println!("Plain:  size {} align {}", size_of::<Plain>(), align_of::<Plain>());
    let h = Handle(7);
    println!("inner = {}", h.0);
    // SAFETY: abs has no preconditions beyond i32::MIN overflow.
    println!("abs(-5) = {}", unsafe { abs(-5) });
}
```

```text
Handle: size 8 align 8
Plain:  size 8 align 8
inner = 7
abs(-5) = 5
```

这个输出看起来没什么：两者都是 8 字节（我没有骗你，实测 `Plain(u64, ())` 在这台机器上也是 8，布局碰巧一样）。区别在于承诺：`Handle` 可以放心地出现在 `extern "C"` 函数的签名里，当 `u64` 用；`Plain` 的布局和 ABI 则没有任何保证，哪天编译器改了也不算 bug。`repr(transparent)` 的 C++ 对应物大概是"标准布局的单成员包装类"，但 C++ 不替你承诺调用约定。

### repr(u8) 的 enum：和 C 的 enum 对表

第 3 篇说过，Rust 的 `enum` 默认是个带标签的联合，和 C 的 `enum`（就是个整数）不是一回事。要和 C 交换一个枚举值，用 `#[repr(u8)]`（或 `repr(i32)` 等）固定它的整数表示。实验 `ch13_repr_u8.rs`：

```rust
use std::mem::size_of;

#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(u8)]
enum Status {
    Ok = 0,
    Full = 1,
    Closed = 7,
}

impl TryFrom<u8> for Status {
    type Error = u8;

    fn try_from(raw: u8) -> Result<Self, u8> {
        match raw {
            0 => Ok(Status::Ok),
            1 => Ok(Status::Full),
            7 => Ok(Status::Closed),
            other => Err(other),
        }
    }
}

fn main() {
    println!("size_of::<Status>() = {}", size_of::<Status>());
    println!("Closed as u8 = {}", Status::Closed as u8);
    println!("{:?}", Status::try_from(1));
    println!("{:?}", Status::try_from(3));
}
```

```text
size_of::<Status>() = 1
Closed as u8 = 7
Ok(Full)
Err(3)
```

`size_of::<Status>()` 是 1，`Status::Closed as u8` 是 7，和 C 的 `enum : uint8_t`（C++ 的 `enum class Status : uint8_t`）一致。反方向才是陷阱：C 给你一个 `uint8_t`，值是 3，你想把它当作 `Status`。如果用 `std::mem::transmute`，Rust 会把一个不是任何变体的字节当成 `Status`，这是未定义行为，Rust 的 enum 不像 C 那样允许"范围外的值"。所以正确做法是像实验里这样写一个 `TryFrom<u8>`，对每个合法值逐个匹配，不认识的返回 `Err`，也就是输出里的 `Err(3)`。Pebble 的 `Arena` 没有枚举值要跨越边界，所以这一节没有出现在仓库里。

### union：和 C 一样，读它是 unsafe

Rust 的 `union` 就是 C 的 `union`：几个字段共享同一块内存。区别是 Rust 里读取联合体字段必须 `unsafe`，因为编译器不知道你上次写的是哪个字段。实验 `ch13_union.rs`：

```rust
#[repr(C)]
union Bits {
    float: f32,
    int: u32,
}

fn main() {
    let bits = Bits { float: 1.0 };
    // SAFETY: every bit pattern is a valid u32, and the union was initialised
    // through the f32 field, which fills all four bytes.
    let int = unsafe { bits.int };
    println!("1.0f32 as bits = {int:#010x}");
    println!("size_of::<Bits>() = {}", std::mem::size_of::<Bits>());
}
```

```text
1.0f32 as bits = 0x3f800000
size_of::<Bits>() = 4
```

`1.0f32` 的位模式是 `0x3f800000`，这是 IEEE 754 的老知识，用 union 来读位模式是 C 里常见的手法。Rust 里更常用的做法是 `f32::to_bits()`，它没有 `unsafe`；`union` 在 Rust 里主要用来给 FFI 描述 C 里的联合体。Pebble 的 `Value` 是个 `enum`（第 8 篇），这就是为什么没有 `union`。

### ManuallyDrop：关掉自动析构

Rust 在值离开作用域时自动调用 `drop`，这就是 RAII。有时你想自己决定什么时候（或者根本不）析构，比如把所有权通过 FFI 交给 C，由 C 来释放；`std::mem::ManuallyDrop<T>` 就是一个"不要自动 drop"的包装。实验 `ch13_manually_drop.rs`：

```rust
use std::mem::ManuallyDrop;

struct Noisy(&'static str);

impl Drop for Noisy {
    fn drop(&mut self) {
        println!("drop {}", self.0);
    }
}

fn main() {
    let _a = Noisy("a: ordinary");
    let _b = ManuallyDrop::new(Noisy("b: manually dropped"));
    let mut c = ManuallyDrop::new(Noisy("c: dropped by hand"));
    println!("before the explicit drop");
    // SAFETY: `c` is never used again after this call.
    unsafe { ManuallyDrop::drop(&mut c) };
    println!("end of main");
}
```

```text
before the explicit drop
drop c: dropped by hand
end of main
drop a: ordinary
```

三个值里，`a` 在 `main` 结尾按正常顺序析构；`b` 被 `ManuallyDrop` 包着，永远没有被析构（泄漏了，没有任何输出）；`c` 在我们明确调用 `ManuallyDrop::drop` 时析构，这个调用是 `unsafe` 的，因为你要保证之后再也不会使用 `c`，也不会再析构一次。它的 C++ 对应物是"显式调用析构函数加 placement new"这套老办法，只不过 Rust 把它放进了类型里。

### static mut：Pebble 为什么不用

C 里的全局变量，在 Rust 里最直接的对应物是 `static mut`。实验 `ch13_static_mut.rs`：

```rust
static mut COUNTER: u32 = 0;

fn bump() -> u32 {
    unsafe {
        COUNTER += 1;
        let r = &COUNTER;
        *r
    }
}

fn main() {
    println!("{}", bump());
}
```

```text
error: creating a shared reference to mutable static
 --> src/bin/ch13_static_mut.rs:6:17
  |
6 |         let r = &COUNTER;
  |                 ^^^^^^^^ shared reference to mutable static
  |
  = note: shared references to mutable statics are dangerous; it's undefined behavior if the static is mutated or if a mutable reference is created for it while the shared reference lives
  = note: for more information, see <https://doc.rust-lang.org/edition-guide/rust-2024/static-mut-references.html>
  = note: `#[deny(static_mut_refs)]` (part of `#[deny(rust_2024_compatibility)]`) on by default
help: use `&raw const` instead to create a raw pointer
  |
6 |         let r = &raw const COUNTER;
  |                  +++++++++

error: could not compile `rust-lab` (bin "ch13_static_mut") due to 1 previous error
```

edition 2024 里，对 `static mut` 取引用直接是编译错误（`static_mut_refs` 在这一版是 deny）。原因很实际：全局变量没有所有者，随便哪个线程都能同时拿到它，`&COUNTER` 和 `COUNTER += 1` 同时存在就违反了"共享引用和可变修改不能共存"。编译器建议的 `&raw const COUNTER` 绕过的是这条检查，不是这个问题。Pebble 一个 `static mut` 都没有，下一节你会看到它想要"全局的、可变的"东西时用的是什么：`UnsafeCell` 加原子操作。

## 往下：把操作系统也去掉

FFI 是往下一层（C 库），`no_std` 是再往下一层：没有操作系统，没有标准库。嵌入式固件、内核、引导程序、WebAssembly 的最小环境都是这样。第 2 篇我们提过 Rust 标准库其实是三层：`core`（不需要任何系统支持：`Option`、`Iterator`、切片、`fmt`……）、`alloc`（需要一个能分配内存的东西：`Vec`、`String`、`Box`、`Rc`……）和 `std`（需要操作系统：线程、文件、网络、`println!`）。`#![no_std]` 就是告诉编译器：别把 `std` 自动引进来，我只用前两层。C 里对应的是 `-ffreestanding -nostdlib`：没有 `printf`、没有 `malloc`，你得自己提供。

`pebble-nostd` 要证明一件事：Pebble 的前端并不是和操作系统焊死的。它复用第 4 篇的词法分析器（同一份代码、一个字节都没改），在 `no_std` 里对整数算术表达式求值，数据结构只有 `Vec`。

`crates/pebble-nostd/Cargo.toml`：

```toml
[package]
name = "pebble-nostd"
description = "Pebble on bare metal: a no_std evaluator with a bump allocator."
version.workspace = true
edition.workspace = true
rust-version.workspace = true
authors.workspace = true
license.workspace = true
repository.workspace = true

[dependencies]
pebble-span.workspace = true
pebble-lexer.workspace = true

[lints]
workspace = true
```

只依赖两个自己的 crate，没有任何外部依赖。再写 `crates/pebble-nostd/src/lib.rs`，整个文件：

```rust
#![cfg_attr(not(test), no_std)]
#![deny(unsafe_op_in_unsafe_fn)]
//! Pebble on bare metal.
//!
//! This crate demonstrates that the front end of the toolchain is not welded
//! to an operating system:
//!
//! 1. [`eval`] runs the *same* [`pebble_lexer`] used by the rest of the
//!    compiler, then evaluates integer arithmetic with nothing but `core` and
//!    `alloc`.
//! 2. [`bump`] provides a real [`core::alloc::GlobalAlloc`] backed by a static
//!    arena, so the evaluator's `Vec`s have somewhere to live on a target that
//!    has no `std` allocator.
//!
//! The crate is `#![no_std]` except while testing. Under `cargo test` the test
//! harness needs `std`, so the attribute is conditional; the library itself
//! never references `std`.
//!
//! Unlike the other front-end crates this one cannot `#![forbid(unsafe_code)]`:
//! implementing a [`GlobalAlloc`](core::alloc::GlobalAlloc) is inherently
//! unsafe. Instead we localize the unsafe code to [`bump`] and require every
//! unsafe operation to sit in an explicit `unsafe` block via
//! `#![deny(unsafe_op_in_unsafe_fn)]`.

extern crate alloc;

pub mod bump;
pub mod eval;
```

三处值得停一下。

`#![cfg_attr(not(test), no_std)]`：条件属性。"如果不是测试，就加 `#![no_std]`"。原因写在文档注释里：`cargo test` 的测试框架本身需要 `std`（它要线程、要打印），所以测试构建不能是 `no_std`；正式构建才是。注释里说"库本身从来不引用 `std`"，这句话是怎么保证的？实验：在重建目录的一份拷贝里，把 `eval.rs` 的 `use alloc::vec::Vec;` 改成 `use std::vec::Vec;`，然后 `cargo build -p pebble-nostd`：

```text
   Compiling pebble-span v0.1.0 (/tmp/lab-ch13-scratch/crates/pebble-span)
   Compiling pebble-diag v0.1.0 (/tmp/lab-ch13-scratch/crates/pebble-diag)
   Compiling pebble-lexer v0.1.0 (/tmp/lab-ch13-scratch/crates/pebble-lexer)
   Compiling pebble-nostd v0.1.0 (/tmp/lab-ch13-scratch/crates/pebble-nostd)
error[E0433]: cannot find module or crate `std` in this scope
  --> crates/pebble-nostd/src/eval.rs:21:5
   |
21 | use std::vec::Vec;
   |     ^^^ use of unresolved module or unlinked crate `std`
   |
   = help: if you wanted to use a crate named `std`, use `cargo add std` to add it to your `Cargo.toml`

warning: unused extern crate
  --> crates/pebble-nostd/src/lib.rs:25:1
   |
25 | extern crate alloc;
   | ^^^^^^^^^^^^^^^^^^^ unused
   |
   = note: `-W unused-extern-crates` implied by `-W rust-2018-idioms`
   = help: to override `-W rust-2018-idioms` add `#[allow(unused_extern_crates)]`
help: remove the unused `extern crate`
   |
25 - extern crate alloc;
   |

error[E0614]: type `Op` cannot be dereferenced
   --> crates/pebble-nostd/src/eval.rs:187:19
    |
187 |         let top = *top;
    |                   ^^^^ can't be dereferenced

Some errors have detailed explanations: E0433, E0614.
For more information about an error, try `rustc --explain E0433`.
warning: `pebble-nostd` (lib) generated 1 warning
error: could not compile `pebble-nostd` (lib) due to 2 previous errors; 1 warning emitted
```

"use of unresolved module or unlinked crate `std`"，`no_std` 之后根本没有 `std` 这个名字。最后那个 `E0614` 是前面错误引起的连带报错，可以忽略。另一个方向，干脆把 `use` 删掉，`Vec` 也不在了：

```text
   Compiling pebble-nostd v0.1.0 (/tmp/lab-ch13-scratch/crates/pebble-nostd)
error[E0425]: cannot find type `Vec` in this scope
   --> crates/pebble-nostd/src/eval.rs:100:44
    |
100 | fn compile(tokens: &[Token<'_>]) -> Result<Vec<Rpn>, EvalError> {
    |                                            ^^^ not found in this scope
    |
help: consider importing this struct
    |
 22 + use alloc::vec::Vec;
    |

error[E0425]: cannot find type `Vec` in this scope
   --> crates/pebble-nostd/src/eval.rs:101:21
    |
101 |     let mut output: Vec<Rpn> = Vec::new();
    |                     ^^^ not found in this scope
    |
help: consider importing this struct
    |
 22 + use alloc::vec::Vec;
    |

error[E0433]: cannot find type `Vec` in this scope
   --> crates/pebble-nostd/src/eval.rs:101:32
    |
101 |     let mut output: Vec<Rpn> = Vec::new();
    |                                ^^^ use of undeclared type `Vec`
    |
help: consider importing this struct
```

编译器很贴心地告诉你该导入 `alloc::vec::Vec`。这里的 `Vec` 和 `std::vec::Vec` 是同一个类型，`std` 只是把 `alloc` 的东西重新导出了一遍。（第二个输出是我用 `cargo build -p pebble-nostd 2>&1 | head -30` 截短的，这是命令的一部分，不是编辑。）

`extern crate alloc;`：`alloc` 不像 `core` 那样自动可用，需要显式声明（这是 edition 2018 之后仅剩的少数 `extern crate` 用途）。声明之后，`alloc::vec::Vec`、`alloc::string::String` 等就可以用了；但你必须自己提供一个全局分配器，否则最终链接会失败。这就是下一节的内容。

`#![deny(unsafe_op_in_unsafe_fn)]`：workspace 的 lint 里已经是 `warn`，这个 crate 把它升成 `deny`。`unsafe fn` 的函数体在老版本里整个都是 unsafe 上下文，现在要求在函数里每个不安全操作单独包一个 `unsafe { }` 块，让每处不安全的地方都有位置写 `SAFETY` 注释。

### 一个 bump 分配器

`#[global_allocator]` 要求你提供一个实现了 `GlobalAlloc` trait 的值。这个 trait 只有两个必须的方法：

```rust
unsafe fn alloc(&self, layout: Layout) -> *mut u8;
unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout);
```

`Layout` 是"大小加对齐"，`alloc` 返回的指针必须满足对齐，失败返回空指针。我们写最简单的分配器：bump（也叫 arena 或 linear allocator）：一块固定的内存，一个游标，每次分配把游标往前推一格，释放什么也不做。C++ 里它的近亲是 `std::pmr::monotonic_buffer_resource`。这看起来像偷懒，但在固件里完全是合理的设计：程序跑完就重启，中途回收内存换不来任何东西，反而要付出记账的成本。

`UnsafeCell<T>` 是 `Cell` 和 `RefCell` 底下的原语，也是 Rust 里唯一合法的"从共享引用改内容"的入口：`get()` 接受 `&self`，返回 `*mut T`，之后别名和并发访问是否安全，全由你自己负责。`Cell`、`RefCell`、`Mutex`、原子类型内部都是它加上各自的规则。C++ 里没有对应物，因为 C++ 没有"共享引用不能改"这条规则，也就不需要一个特殊的逃生口。

写 `crates/pebble-nostd/src/bump.rs`。先写一个朴素版本，让编译器告诉我们哪里不对。游标和内存都放进一个结构体，做成 `static`（`GlobalAlloc` 要求全局的）。最直接的写法：游标用 `Cell<usize>`（第 11 篇讲过的内部可变性），内存用 `UnsafeCell<[u8; N]>`。实验 `ch13_static_sync.rs`：

```rust
use std::cell::{Cell, UnsafeCell};

struct CursorOnly {
    used: Cell<usize>,
}

struct Arena {
    heap: UnsafeCell<[u8; 16]>,
}

static CURSOR: CursorOnly = CursorOnly { used: Cell::new(0) };
static ARENA: Arena = Arena { heap: UnsafeCell::new([0; 16]) };

fn main() {
    CURSOR.used.set(1);
    println!("{}", ARENA.heap.get() as usize != 0);
}
```

```text
error[E0277]: `Cell<usize>` cannot be shared between threads safely
  --> src/bin/ch13_static_sync.rs:11:16
   |
11 | static CURSOR: CursorOnly = CursorOnly { used: Cell::new(0) };
   |                ^^^^^^^^^^ `Cell<usize>` cannot be shared between threads safely
   |
   = help: within `CursorOnly`, the trait `Sync` is not implemented for `Cell<usize>`
   = note: if you want to do aliasing and mutation between multiple threads, use `std::sync::RwLock` or `std::sync::atomic::AtomicUsize` instead
note: required because it appears within the type `CursorOnly`
  --> src/bin/ch13_static_sync.rs:3:8
   |
 3 | struct CursorOnly {
   |        ^^^^^^^^^^
   = note: shared static variables must have a type that implements `Sync`

error[E0277]: `UnsafeCell<[u8; 16]>` cannot be shared between threads safely
  --> src/bin/ch13_static_sync.rs:12:15
   |
12 | static ARENA: Arena = Arena { heap: UnsafeCell::new([0; 16]) };
   |               ^^^^^ `UnsafeCell<[u8; 16]>` cannot be shared between threads safely
   |
   = help: within `Arena`, the trait `Sync` is not implemented for `UnsafeCell<[u8; 16]>`
note: required because it appears within the type `Arena`
  --> src/bin/ch13_static_sync.rs:7:8
   |
 7 | struct Arena {
   |        ^^^^^
   = note: shared static variables must have a type that implements `Sync`

For more information about this error, try `rustc --explain E0277`.
error: could not compile `rust-lab` (bin "ch13_static_sync") due to 2 previous errors
```

`static` 的值可以被所有线程同时访问，所以它的类型必须是 `Sync`（又是自动 trait：所有字段都 `Sync` 才行）。`Cell` 和 `UnsafeCell` 都故意不是 `Sync`：它们允许在共享引用下修改内容，却没有任何保护，两个线程同时改就是数据竞争。错误信息里已经给了提示："use `std::sync::RwLock` or `std::sync::atomic::AtomicUsize` instead"。游标我们用 `AtomicUsize`（原子整数，硬件保证读改写是不可分割的），这一个字段解决了。

内存那块 `UnsafeCell<[u8; N]>` 没有对应的安全替代品：我们本来就是要把它当作"别人可以随便写"的原始内存交出去。这时只能手写 `unsafe impl Sync`：

```rust
// SAFETY: the only shared state that is ever mutated is the atomic cursor, so
// racing `alloc` calls are well defined. Two successful allocations never
// overlap, because the atomic update reserves each slice before it is handed
// out; the caller of `alloc` receives a pointer it is free to write through.
unsafe impl<const N: usize> Sync for BumpAllocator<N> {}
```

这句话是我们对编译器的承诺，等价于 C++ 里"这个类是线程安全的，信我"，区别是 Rust 逼你把这句承诺写下来，并且放在一个 `unsafe` 后面，让 `grep unsafe` 能找到。承诺的依据写在注释里：被多线程共享并修改的只有原子游标，而游标保证每次成功的分配都拿到不重叠的区间，拿到区间的线程只写自己的那一段。

### 常量泛型：数组大小做参数

分配器的内存大小最直接的写法是写死一个 `pub const HEAP_SIZE: usize = 4096`（这个 crate 最初就是这样）。要让用户自己选大小，C++ 里你会写 `template <size_t N = 4096> class BumpAllocator`。Rust 的对应物是 const 泛型：泛型参数不是类型，而是一个值。语法是 `<const N: usize>`，还可以有默认值。实验 `ch13_const_generic.rs`：

```rust
use std::mem::size_of;

struct Buf<const N: usize = 4> {
    data: [u8; N],
}

impl<const N: usize> Buf<N> {
    const fn new() -> Self {
        Self { data: [0; N] }
    }

    const fn capacity(&self) -> usize {
        self.data.len()
    }
}

fn main() {
    let default: Buf = Buf::new();
    let big = Buf::<4096>::new();
    println!("default: capacity {} size_of {}", default.capacity(), size_of::<Buf>());
    println!("4096:    capacity {} size_of {}", big.capacity(), size_of::<Buf<4096>>());
}
```

```text
default: capacity 4 size_of 4
4096:    capacity 4096 size_of 4096
```

`Buf<4>` 和 `Buf<4096>` 是不同的类型，`size_of` 分别是 4 和 4096：`[u8; N]` 的 `N` 是类型的一部分，所以数组直接内联在结构体里，没有堆分配，这也是 `static` 能直接放下整块内存的前提。因为是不同的类型，互相赋值是编译错误（`ch13_const_generic_mismatch.rs`）：

```text
error[E0308]: mismatched types
 --> src/bin/ch13_const_generic_mismatch.rs:7:25
  |
7 |     let small: Buf<4> = big;
  |                ------   ^^^ expected `4`, found `4096`
  |                |
  |                expected due to this
  |
  = note: expected struct `Buf<4>`
             found struct `Buf<4096>`

For more information about this error, try `rustc --explain E0308`.
error: could not compile `rust-lab` (bin "ch13_const_generic_mismatch") due to 1 previous error
```

像第 5 篇的泛型一样，编译器对每个不同的 `N` 单独生成一份代码（单态化），所以没有运行时代价。

现在写 `bump.rs` 的主体。文件最前面那 13 行 `//!` 模块文档（"A bump allocator over a fixed, static arena..."）照抄 [tag](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-nostd/src/bump.rs)，下面从 `use` 开始。先是常量和游标：

```rust
use core::alloc::{GlobalAlloc, Layout};
use core::cell::UnsafeCell;
use core::ptr;
use core::sync::atomic::{AtomicUsize, Ordering};

/// The arena size, in bytes, of a [`BumpAllocator`] that does not name one.
pub const DEFAULT_HEAP_SIZE: usize = 4096;

/// The mutable cursor of a bump allocator.
///
/// Kept as one [`UnsafeCell`] so the allocator has interior mutability without
/// making the whole [`BumpAllocator`] `mut`.
struct BumpState {
    /// Bytes handed out so far, measured from the start of the arena.
    used: AtomicUsize,
}
```

`DEFAULT_HEAP_SIZE` 是不指定大小时的默认值。`BumpState` 里只有一个原子游标：从 arena 起点算起已经交出去多少字节。（一个我不太有把握的疑点：外面又包了一层 `UnsafeCell`，原子类型本身就有内部可变性，这层多半是多余的；`bytes_used` 也只是用共享引用读它。tag 里是这样写的，我照抄，不改。）

分配器本体：

```rust
/// A [`GlobalAlloc`] that bumps a cursor through a fixed-size static arena.
///
/// Each instance owns `N` bytes inline (4096 unless you say otherwise), which
/// is what makes it usable as a `static` without a separate `static mut` buffer:
///
/// ```
/// use pebble_nostd::bump::BumpAllocator;
///
/// static HEAP: BumpAllocator = BumpAllocator::new();
/// ```
///
/// Allocation is lock-free: concurrent callers race on the cursor with a
/// compare-exchange loop, and whoever wins reserves its slice exclusively.
/// Exhaustion is reported as a null pointer, as [`GlobalAlloc`] requires.
pub struct BumpAllocator<const N: usize = DEFAULT_HEAP_SIZE> {
    state: UnsafeCell<BumpState>,
    heap: UnsafeCell<[u8; N]>,
}
```

`BumpAllocator<const N: usize = DEFAULT_HEAP_SIZE>`：`N` 有默认值，所以写 `BumpAllocator` 就是 `BumpAllocator<4096>`，写 `BumpAllocator<{ 1024 * 1024 }>` 就是 1 MiB（表达式必须用花括号括起来）。`heap` 是 `UnsafeCell<[u8; N]>`，整块内存就在结构体里面。放进 `static` 里，链接器会把它放进 `.bss` 段（全零初始化的静态数据，不占可执行文件的体积）。

然后是 `impl<const N: usize> BumpAllocator<N>` 和 `Default`：

```rust
impl<const N: usize> BumpAllocator<N> {
    /// Creates an allocator whose entire arena is free.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            state: UnsafeCell::new(BumpState {
                used: AtomicUsize::new(0),
            }),
            heap: UnsafeCell::new([0; N]),
        }
    }

    /// Returns how many bytes have been handed out so far.
    ///
    /// This is the arena high-water mark since the allocator never reuses
    /// space; it is useful for asserting that a workload fits, or for sizing an
    /// arena on a device with a known memory budget.
    #[must_use]
    pub fn bytes_used(&self) -> usize {
        // SAFETY: `state` lives as long as `self`, and reading the atomic needs
        // no unique access.
        let state = unsafe { &*self.state.get() };
        state.used.load(Ordering::Relaxed)
    }

    /// The size in bytes of the arena: the const parameter `N`.
    #[must_use]
    pub const fn capacity(&self) -> usize {
        N
    }

    /// Address of the first byte of the arena.
    fn base(&self) -> usize {
        self.heap.get().cast::<u8>() as usize
    }
}

impl<const N: usize> Default for BumpAllocator<N> {
    fn default() -> Self {
        Self::new()
    }
}
```

`new` 是 `const fn`（第 1 篇）：`static` 的初始值必须在编译期算出来，所以构造函数得是 `const`；`[0; N]` 在 `const fn` 里随便写。`capacity` 直接返回 `N`，它是 `const fn` 因为 `N` 是编译期常量。

最后是整个文件的核心，`GlobalAlloc`：

```rust
// SAFETY: the implementation upholds the `GlobalAlloc` contract.
//
// - `alloc` returns null on exhaustion and otherwise a pointer aligned to
//   `layout.align()` that is not aliased by any other live allocation.
// - The returned pointer is valid for writes of `layout.size()` bytes, since the
//   arena is an owned `[u8; N]` and the cursor stays within it.
// - `dealloc` is a no-op, which is permitted: freeing is optional.
unsafe impl<const N: usize> GlobalAlloc for BumpAllocator<N> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let base = self.base();
        let align = layout.align();
        let size = layout.size();
        // SAFETY: `state` outlives `self` and the closure only touches the
        // atomic cursor, so it needs no exclusive access.
        let state = unsafe { &*self.state.get() };

        // Reserve our slice by atomically advancing the cursor. `fetch_update`
        // retries until either the update succeeds or the cursor cannot grow
        // enough for this request, in which case it yields `Err` and we report
        // exhaustion.
        let reserved = state
            .used
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
                let cursor = base.checked_add(used)?;
                let aligned = cursor.checked_add(align - 1)? & !(align - 1);
                let offset = aligned - base;
                let end = offset.checked_add(size)?;
                (end <= N).then_some(end)
            });

        match reserved {
            // `Err` carries the (unchanged) current cursor: no room left.
            Err(_) => ptr::null_mut(),
            // `Ok(previous)` is the cursor we reserved from. Recomputing the
            // aligned address is infallible here because the reservation above
            // already succeeded with these same values.
            Ok(previous) => {
                let aligned = (base + previous + align - 1) & !(align - 1);
                aligned as *mut u8
            }
        }
    }

    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {
        // A bump allocator cannot free an individual allocation: the cursor
        // only moves forward, and there is no free list to recover a hole. The
        // whole arena is reclaimed at once when the allocator is dropped or the
        // program is reset. This is intentional, not an oversight.
    }
}
```

先看 `fetch_update`：它是一个"读-改-写"的循环（compare-and-swap 重试）。读当前游标 `used`，调用闭包算出新值，如果算出 `Some(新值)` 就尝试把游标换成新值；如果别的线程在这中间改了游标，换失败，重新读、重新算。闭包返回 `None` 表示"放不下"，`fetch_update` 就以 `Err` 返回，游标不变。C++ 里等价的是 `std::atomic<size_t>` 加一个 `compare_exchange_weak` 循环。

闭包里做的事：游标加上 arena 的基地址得到当前地址，向上取整到 `align` 的倍数（`(addr + align - 1) & !(align - 1)`，对齐必须是 2 的幂，`Layout` 保证），再换回偏移，加上 `size` 得到 `end`，只有 `end <= N` 才算放得下。每一步加法都是 `checked_add`，溢出就当作放不下，不会绕回去踩到别处。

**为什么用 `Ordering::Relaxed`**：原子操作的内存顺序（`std::memory_order` 在 Rust 里叫 `Ordering`）控制的是"这个原子操作周围的其他内存读写，对别的线程来说怎么排序"。`Relaxed` 是最弱的：只保证这一个原子变量自己的修改是原子的，不对其他内存建立任何先后关系。这里够用，理由是：被保护的数据只有游标本身，没有"线程 A 写了某些数据，再通过游标告诉线程 B 去读"的发布-订阅关系；线程拿到自己的区间之后，写的是只属于自己的内存，别的线程不会读它（如果之后需要读，需要通过别的同步手段传递这块内存，那一次传递会自带顺序保证）。这是我的推理，不是测出来的；下面的多线程实验是个旁证。

`dealloc` 是空函数，注释里写明这是故意的，不是漏写。

最后看测试：

```rust
#[cfg(test)]
mod tests {
    use super::{BumpAllocator, DEFAULT_HEAP_SIZE};
    use core::alloc::{GlobalAlloc, Layout};

    static ALLOC: BumpAllocator = BumpAllocator::new();

    #[test]
    fn distinct_layouts_do_not_overlap() {
        // SAFETY: the layouts are valid (`size` is a multiple of `align`, both
        // powers of two), and a null result is handled below.
        let a = unsafe { ALLOC.alloc(Layout::from_size_align(64, 8).unwrap()) };
        let b = unsafe { ALLOC.alloc(Layout::from_size_align(128, 16).unwrap()) };
        assert!(!a.is_null() && !b.is_null(), "allocations must succeed");
        assert_eq!(a as usize % 8, 0, "first block must honour alignment");
        assert_eq!(b as usize % 16, 0, "second block must honour alignment");
        // The ranges [a, a+64) and [b, b+128) must be disjoint.
        let (a, b) = (a as usize, b as usize);
        assert!(
            a + 64 <= b || b + 128 <= a,
            "allocations at {a:#x} and {b:#x} overlap"
        );
        assert!(ALLOC.bytes_used() >= 64 + 128);
    }

    #[test]
    fn exhaustion_returns_null() {
        // A fresh allocator so this test cannot be perturbed by the other one.
        static SMALL: BumpAllocator<64> = BumpAllocator::new();
        let mut handed_out = 0;
        loop {
            // SAFETY: `Layout::new::<u8>()` is valid; the returned pointer is
            // only inspected, never written.
            let p = unsafe { SMALL.alloc(Layout::new::<u8>()) };
            if p.is_null() {
                break;
            }
            handed_out += 1;
            assert!(handed_out <= 64, "allocator overran its arena");
        }
        assert_eq!(handed_out, 64, "one byte at a time fills the arena");
        assert_eq!(SMALL.bytes_used(), 64);
    }

    #[test]
    fn dealloc_is_a_no_op() {
        static HEAP: BumpAllocator = BumpAllocator::new();
        // SAFETY: `alloc` returns a pointer that `dealloc` may be called on;
        // deallocating a bump allocation is a documented no-op.
        let p = unsafe { HEAP.alloc(Layout::new::<u64>()) };
        assert!(!p.is_null());
        let used = HEAP.bytes_used();
        unsafe { HEAP.dealloc(p, Layout::new::<u64>()) };
        assert_eq!(HEAP.bytes_used(), used, "dealloc must not move the cursor");
    }

    #[test]
    fn capacity_is_the_const_parameter() {
        assert_eq!(BumpAllocator::<128>::new().capacity(), 128);
        let default: BumpAllocator = BumpAllocator::new();
        assert_eq!(default.capacity(), DEFAULT_HEAP_SIZE);
    }
}
```

四个测试：`distinct_layouts_do_not_overlap`（两个不同对齐的分配不重叠且对齐正确）、`exhaustion_returns_null`（用 `BumpAllocator<64>` 一字节一字节地分配，恰好 64 次之后返回空指针）、`dealloc_is_a_no_op`、`capacity_is_the_const_parameter`（`BumpAllocator::<128>::new().capacity() == 128`，不带参数的是 `DEFAULT_HEAP_SIZE`）。`exhaustion_returns_null` 里的 `static SMALL: BumpAllocator<64>` 只有 64 字节，所以这个测试不会被另一个测试里的 `ALLOC` 影响。

### 实验：它真的并发安全吗

"锁无关"不应该只靠读代码相信。实验 `threads.rs`（在 `~/lab-ch13-bump` 里，依赖 `pebble-nostd`，建法同 `lab-ch13-sys`）：四个线程各分配 1000 次，每次 16 字节，把拿到的 4000 个地址收集起来排序去重：

```text
4000 allocations, 4000 distinct addresses
closest pair is 16 bytes apart
bytes_used = 64000
```

4000 次分配得到 4000 个不同的地址，相邻地址最近也相距 16 字节（正好是请求的大小），`bytes_used` 是 `4000 × 16 = 64000`。一个跑了一次的实验不是证明（数据竞争是概率事件，一次没事说明不了多少），但它和代码推理指向同一个结论。真要认真验证，应该用 Miri 或者 loom 这类工具，我没有在这篇里跑它们。

### 它的代价是什么

bump 分配器永远不释放，代价要实际量一下。实验 `vec_growth.rs`：把一个 `Vec<u64>` 一个个元素推到 1000，每次容量变化时打印一次 arena 的用量：

```text
len    1: capacity    4, arena used     32
len    5: capacity    8, arena used   1120
len    9: capacity   16, arena used   1248
len   17: capacity   32, arena used   1504
len   33: capacity   64, arena used   2016
len   65: capacity  128, arena used   3040
len  129: capacity  256, arena used   5088
len  257: capacity  512, arena used   9184
len  513: capacity 1024, arena used  17376
live data: 8000 bytes
```

`Vec` 的容量按 2 倍增长（4、8、16……1024），每次增长都要分配一块新的更大的内存，把旧内容搬过去，旧块不释放，所以用量是等比数列的和：`32 + 64 + 128 + ... + 8192 = 16352` 字节，加上第一次 `println!` 时标准库给标准输出分配的 1024 字节缓冲区，正好是 `len 513` 那一行的 17376。最终存活的数据只有 8000 字节，arena 里累计花掉的接近它的 2.2 倍。这就是"设计上不释放"的真实价格。再看耗尽时发生什么，`exhaust.rs` 用一个只有 64 KiB 的 arena 要 100 KiB：

```text
arena already used by the runtime: 552 bytes
memory allocation of 102400 bytes failed
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
bash: line 1: 63140 Aborted                    (core dumped) cargo run --quiet --bin exhaust
```

`alloc` 返回空指针之后，标准库的 `Vec` 调用 `handle_alloc_error`，打印 "memory allocation of 102400 bytes failed" 并 `abort`。`GlobalAlloc` 的约定就是这样：分配器报告失败，由调用者决定怎么办，标准库的选择是死掉。（那行 `arena already used by the runtime: 552 bytes` 说明 Rust 运行时在 `main` 之前就已经向全局分配器要了 552 字节。）

### 把分配器装上：#[global_allocator]

写 `crates/pebble-nostd/examples/bump_global.rs`，让整个进程（包括标准库自己的所有 `Vec`、`String`、`Box`）都用这个分配器：

```rust
//! Runs the `no_std` evaluator on top of the bump allocator.
//!
//! The whole program, including the standard library's own allocations, is
//! served from one 1 MiB static arena: `#[global_allocator]` replaces the
//! system allocator for every `Vec`, `String`, and `Box` in the process.
//!
//! ```text
//! cargo run -p pebble-nostd --example bump_global
//! ```

use pebble_nostd::bump::BumpAllocator;

#[global_allocator]
static HEAP: BumpAllocator<{ 1024 * 1024 }> = BumpAllocator::new();

fn main() {
    let before = HEAP.bytes_used();
    let result = pebble_nostd::eval::eval_source("(1 + 2) * 3 - 4 / 2");
    let after = HEAP.bytes_used();

    println!("result = {result:?}");
    println!(
        "the evaluator allocated {} bytes from the bump arena",
        after - before
    );
}
```

`#[global_allocator]` 标在一个 `static` 上，要求它的类型实现了 `GlobalAlloc`，之后整个程序里所有堆分配都会走它的 `alloc`。C 里的对应物是用链接器 `--wrap=malloc` 或者自己定义一个 `malloc`/`free`，C++ 里是重载全局 `operator new`。`BumpAllocator<{ 1024 * 1024 }>` 是 1 MiB。注意这个例子里没有任何 `unsafe`：`unsafe` 都被关在 `bump.rs` 里了。那块 1 MiB 的内存到底放在哪？用 `nm` 看一眼编译出来的例子（在重建目录里跑 `cargo build -p pebble-nostd --example bump_global` 之后）：

```bash
nm -S --size-sort target/debug/examples/bump_global | tail -1
```

```text
000000000007b9c8 0000000000100008 b _ZN11bump_global4HEAP17hf608c719176c5af5E
```

符号 `HEAP`，类型 `b`（小写 `b` 是 `.bss` 段里的局部符号），大小 `0x100008` 字节，也就是 1 MiB 加上 8 字节的游标。零初始化的静态数据放进 `.bss`，只在可执行文件里记一个长度，不占文件体积。

## 求值器：真正在这个分配器上跑的东西

`crates/pebble-nostd/src/eval.rs` 是一个整数表达式求值器。它不是树遍历：词法分析器吐出的 token 流先被"调度场算法"（shunting-yard）翻译成逆波兰表达式（RPN），再用一个 `Vec<i64>` 当栈执行。对 `(1 + 2) * 3 - 4 / 2`，RPN 是 `1 2 + 3 * 4 2 / -`。

这个文件我们大部分直接复制：[`eval.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-nostd/src/eval.rs) 里除了 `eval_source` 和 `eval_rpn` 两个函数以外，数据类型（`EvalError`、`Op`、`Rpn`、`StackItem`）、`compile`（调度场）、`push_operator` 和 6 个测试都照抄。理由：调度场算法是教科书内容，和这一篇的主题（边界）没有关系；而那两个函数一个是和词法分析器、`SourceMap` 的接口，一个是用检查算术做栈机的执行，是这篇真正想让你读的部分。我在重建目录里按这个方案做了：复制整个文件，再逐字对照 tag。

### eval_source：复用同一个词法分析器

```rust
/// Lexes and evaluates `src`, returning its integer value.
///
/// A fresh [`SourceMap`] is created internally, so callers do not have to know
/// about source ids just to evaluate a snippet.
pub fn eval_source(src: &str) -> Result<i64, EvalError> {
    let mut sources = SourceMap::new();
    let id = sources.add("<nostd>", src);
    let (tokens, diagnostics) = tokenize(id, src);
    if !diagnostics.is_empty() {
        // The lexer keeps going after a bad character, so a non-empty
        // diagnostic list means the stream is not the expression we asked for.
        return Err(EvalError::UnexpectedToken);
    }
    eval_rpn(&compile(&tokens)?)
}
```

这里把前面几篇的零件接起来：`SourceMap::new()`（第 2 篇）建一个空的源文件表，`add` 登记一个叫 `<nostd>` 的"文件"得到 `SourceId`，`tokenize`（第 4 篇）吐出 token 和诊断信息，诊断非空说明有非法字符，直接拒绝。注意 `TokenKind` 里的字符串是借用自 `src` 的 `&str`（第 4 篇的 `'src` 生命周期），所以 `tokenize` 本身没有拷贝文本。

一个自然的疑问：2000 字节都用在哪了？实验 `stages.rs`（同一个 lab）量了前两步：

```text
SourceMap::add       352 bytes
tokenize            1160 bytes (12 tokens, 0 diagnostics)
size_of::<Token>() = 40
eval_source (all)   2000 bytes -> Ok(7)
```

`SourceMap::add` 花了 352 字节（它自己拥有文件名、源文本和行首表，再加上内部 `Vec` 的第一次分配，细账我没拆），`tokenize` 花了 1160 字节：12 个 token，每个 40 字节，`Vec` 增长时旧块不释放，所以是 `160 + 320 + 640 = 1120` 再加一点零头。这两步一共 1512，离 2000 还差 488，剩下的是 `compile` 里的两个 `Vec`（输出的 RPN 和运算符栈）加 `eval_rpn` 里的栈。我没有再往下细拆，这个数字是实测的，细账没做。

### eval_rpn：用 Vec 当栈，用检查算术当护栏

```rust
/// Runs the compiled program on a [`Vec`] used as the machine stack.
fn eval_rpn(rpn: &[Rpn]) -> Result<i64, EvalError> {
    let mut stack: Vec<i64> = Vec::new();
    for instruction in rpn {
        match *instruction {
            Rpn::Push(value) => stack.push(value),
            Rpn::Apply(Op::Neg) => {
                let value = stack.pop().ok_or(EvalError::UnexpectedEnd)?;
                stack.push(value.checked_neg().ok_or(EvalError::Overflow)?);
            }
            Rpn::Apply(op) => {
                let rhs = stack.pop().ok_or(EvalError::UnexpectedEnd)?;
                let lhs = stack.pop().ok_or(EvalError::UnexpectedEnd)?;
                let value = match op {
                    Op::Add => lhs.checked_add(rhs),
                    Op::Sub => lhs.checked_sub(rhs),
                    Op::Mul => lhs.checked_mul(rhs),
                    Op::Div => {
                        if rhs == 0 {
                            return Err(EvalError::DivisionByZero);
                        }
                        lhs.checked_div(rhs)
                    }
                    Op::Rem => {
                        if rhs == 0 {
                            return Err(EvalError::DivisionByZero);
                        }
                        lhs.checked_rem(rhs)
                    }
                    Op::Neg => unreachable!("handled by the arm above"),
                };
                stack.push(value.ok_or(EvalError::Overflow)?);
            }
        }
    }

    match stack.len() {
        1 => Ok(stack[0]),
        0 => Err(EvalError::UnexpectedEnd),
        // Leftover operands, e.g. `1 2`.
        _ => Err(EvalError::UnexpectedToken),
    }
}
```

读几个地方。`match *instruction` 里 `Rpn::Apply(Op::Neg)` 在 `Rpn::Apply(op)` 之前：`match` 从上往下找第一个匹配，特殊情形放前面，所以后面那个臂里的 `Op::Neg => unreachable!(...)` 真的不可达。`stack.pop().ok_or(EvalError::UnexpectedEnd)?`：`pop` 返回 `Option`，`ok_or` 把它变成 `Result`，`?` 提前返回（第 7 篇的老套路）：栈里没有操作数就是表达式写错了，比如 `1 +`。所有算术都是 `checked_*`：`checked_add` 溢出时返回 `None` 而不是回绕或者 panic，所以 `9223372036854775807 + 1` 变成 `Err(EvalError::Overflow)`。最后一个小例子，`i64::MIN` 取负也会溢出，所以 `Neg` 用 `checked_neg`。第 1 篇说过 C 里有符号溢出是未定义行为，Rust 里每一种处理（panic、回绕、`checked`、`saturating`）都是你明确选的。

`compile` 里还有一处新写法，复制代码的时候留意：

```rust
            kind @ (TokenKind::Plus
            | TokenKind::Minus
            | TokenKind::Star
            | TokenKind::Slash
            | TokenKind::Percent) => {
                let op = match kind {
                    TokenKind::Plus => Op::Add,
                    TokenKind::Minus => Op::Sub,
                    TokenKind::Star => Op::Mul,
                    TokenKind::Slash => Op::Div,
                    TokenKind::Percent => Op::Rem,
                    _ => unreachable!("guarded by the match arm above"),
                };
```

`kind @ (A | B | ...)` 是"绑定加模式"：先用括号里的或模式判断 token 是不是五个运算符之一，匹配的话再把整个匹配到的值绑定到名字 `kind` 上，下面的内层 `match` 就可以直接用它。内层最后一个 `_ => unreachable!(...)` 的存在，说明编译器没法从外层的模式推出内层已经穷尽，所以只能手写一个"不可能"，这是这种写法的小代价。

> [!NOTE] 跑一遍
> `cargo test -p pebble-nostd` 之前，确认 `eval.rs` 里的 `use alloc::vec::Vec;` 还在，而且整个文件没有任何 `std::` 导入：`pebble-nostd` 里的"正文"只有 `core` 和 `alloc`。

运行例子：

```bash
cargo run -p pebble-nostd --example bump_global
```

```text
result = Ok(7)
the evaluator allocated 2000 bytes from the bump arena
```

`result = Ok(7)`：`(1 + 2) * 3 - 4 / 2 = 9 - 2 = 7`。对一个 19 个字符的表达式，词法分析加求值向 1 MiB 的 arena 要了 2000 字节，不到 0.2%。把这个分配器换成一个 16 KiB 的、放在微控制器 RAM 里的，同样的代码照样跑。我没有验证这一点（我没有装任何裸机目标，也没有交叉编译过它），所以这只是推测；能验证的部分是：这个 crate 的库代码没有引用 `std`（上面那个编译失败的实验），而且它真的在一个自己写的全局分配器上跑出了正确答案。

## 检查点

在重建目录里：

```bash
cargo test -p pebble-sys -p pebble-nostd
cargo clippy -p pebble-sys -p pebble-nostd --all-targets -- -D warnings
```

第一条命令的输出（我用 `grep` 只留了关键行）：

```text
     Running unittests src/lib.rs (target/debug/deps/pebble_nostd-bfc6c2d04f19dc0b)
test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running unittests src/lib.rs (target/debug/deps/pebble_sys-9e3357754a97ae75)
test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
   Doc-tests pebble_nostd
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
   Doc-tests pebble_sys
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

`pebble-sys` 15 个单元测试加 2 个文档测试（`fnv1a` 和 `fold` 各一个），`pebble-nostd` 10 个单元测试（6 个求值器的，4 个分配器的）加 1 个文档测试（`BumpAllocator` 上的 `static HEAP: BumpAllocator = ...`）。第二条命令（clippy，`-D warnings` 把所有警告当作错误）在我的重建目录里通过，输出只有 `Checking`/`Finished` 几行，没有任何警告。

这些文件现在必须和 tag 逐字节一致。把 tag 克隆到 `~/pebble-tag`（第 1 篇做过就跳过：`git clone --branch tutorial-v1 https://github.com/bfmhno3/pebble ~/pebble-tag`），然后在你的工作区根目录里对每个目录跑 `diff -r`：

```bash
diff -r crates/pebble-sys ~/pebble-tag/crates/pebble-sys
diff -r crates/pebble-nostd ~/pebble-tag/crates/pebble-nostd
```

两条命令都没有任何输出。这十个文件是"完成品"：

- [`crates/pebble-sys/Cargo.toml`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-sys/Cargo.toml)
- [`crates/pebble-sys/build.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-sys/build.rs)
- [`crates/pebble-sys/csrc/include/pebble_shim.h`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-sys/csrc/include/pebble_shim.h)
- [`crates/pebble-sys/csrc/pebble_shim.c`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-sys/csrc/pebble_shim.c)
- [`crates/pebble-sys/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-sys/src/lib.rs)
- [`crates/pebble-nostd/Cargo.toml`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-nostd/Cargo.toml)
- [`crates/pebble-nostd/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-nostd/src/lib.rs)
- [`crates/pebble-nostd/src/bump.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-nostd/src/bump.rs)
- [`crates/pebble-nostd/src/eval.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-nostd/src/eval.rs)
- [`crates/pebble-nostd/examples/bump_global.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-nostd/examples/bump_global.rs)

根目录的 `Cargo.toml` 现在还不用和 tag 一致（它在第 15 篇才完成），只要有这两个 crate 和 `cc` 的三行。没有中间状态的文件：这一篇所有 crate 都是一次到位。

## 练习

**1. 为 C 的 arena 加一个新函数：`pebble_arena_remaining`，返回还没用掉的字节数（不算对齐）。** 要改哪几个文件？为什么 `build.rs` 里的 `rerun-if-changed` 列表里有头文件？

<details>
<summary>参考答案</summary>

要改四处：头文件里声明 `size_t pebble_arena_remaining(const PebbleArena *arena);`，`.c` 里实现，Rust 的 `extern` 块里加声明，再写一个 `Arena::remaining`。

```c
size_t pebble_arena_remaining(const PebbleArena *arena) {
    return arena == NULL ? 0 : arena->capacity - arena->used;
}
```

```rust
/// Bytes still unused, ignoring alignment padding.
#[must_use]
pub fn remaining(&self) -> usize {
    // SAFETY: `self.ptr` is a live arena and the C function only reads it.
    unsafe { pebble_arena_remaining(self.ptr.as_ptr()) }
}
```

加一个测试 `remaining_plus_used_is_capacity`：新建 64 字节的 arena，断言 `remaining() == 64`，分配 10 字节之后断言 `remaining() + used() == capacity()`。我在重建目录的一份拷贝里做了这些改动，`cargo test -p pebble-sys` 是 16 个单元测试加 2 个文档测试，全部通过。

`rerun-if-changed` 里列头文件，是因为 `build.rs` 只在列出的文件变化时才重跑；`.c` 文件 `#include` 了头文件，如果头文件改了而没有列出来，`.c` 不会被重新编译，C 和 Rust 对函数签名的理解就会不一致，而这种不一致编译器和链接器都发现不了。

</details>

**2. 如果 `fold_trampoline` 不用 `catch_unwind`，闭包 panic 时会发生什么？**

<details>
<summary>参考答案</summary>

进程被 `abort`。因为蹦床是一个 `extern "C" fn`，panic 要从它里面展开出去就必须穿过 C 的 `pebble_fold` 栈帧，rustc 1.95.0 会在 `extern "C"` 边界上插一个检查，直接中止，并打印 "panic in a function that cannot unwind"。实验 `fold_nocatch.rs` 的输出就是证据：退出码 134（`SIGABRT`），回溯里同时有 `fold_nocatch::exploding` 和 `pebble_fold`（带着 `pebble_shim.c:120` 的行号）。

这不是一个"更糟的错误信息"的问题：进程里别的线程、别的未写入的数据都被一起带走了。`catch_unwind` 的价值是把"进程中止"降级为"这次调用以 panic 失败"，而且保留原始的 panic 负载，这样调用者仍然可以决定要不要继续传播。

</details>

**3. 让 `BumpAllocator` 有一个 `reset`，把整块 arena 还原成空闲，并且是健全的（sound）。**

<details>
<summary>参考答案</summary>

`reset` 必须取 `&mut self`：

```rust
pub fn reset(&mut self) {
    *self.state.get_mut().used.get_mut() = 0;
}
```

`UnsafeCell::get_mut` 和 `AtomicUsize::get_mut` 都是安全函数：只要你持有 `&mut`，编译器就保证没有别人能同时访问，所以不用原子操作，直接写零即可。

为什么必须是 `&mut self`：`reset` 之后，之前交出去的所有指针所指的内存都会被再次分配，所以调用 `reset` 的时候不能有任何还在用的指针；`&mut self` 是 Rust 里表达"没有其他人在用它"的方式。代价是它没法用在 `#[global_allocator]` 上：`static` 只能以共享引用的方式访问。我写了一个测试，对 `static SHARED: BumpAllocator<64>` 调用 `SHARED.reset()`，编译器给出：

```text
   Compiling pebble-span v0.1.0 (/tmp/lab-ch13-s2/crates/pebble-span)
   Compiling pebble-diag v0.1.0 (/tmp/lab-ch13-s2/crates/pebble-diag)
   Compiling pebble-lexer v0.1.0 (/tmp/lab-ch13-s2/crates/pebble-lexer)
   Compiling pebble-nostd v0.1.0 (/tmp/lab-ch13-s2/crates/pebble-nostd)
error[E0596]: cannot borrow immutable static item `SHARED` as mutable
   --> crates/pebble-nostd/src/bump.rs:238:9
    |
237 |         static SHARED: BumpAllocator<64> = BumpAllocator::new();
    |         -------------------------------- this `static` cannot be borrowed as mutable
238 |         SHARED.reset();
    |         ^^^^^^ cannot borrow as mutable

For more information about this error, try `rustc --explain E0596`.
error: could not compile `pebble-nostd` (lib test) due to 1 previous error
```

在一份拷贝里，对一个局部的 `BumpAllocator<64>`（分配 8 字节，`reset`，`bytes_used()` 归零）的测试通过（`nostd` 变成 11 个测试）。如果真想要"全局分配器可 reset"，就需要调用者保证（自己写 `unsafe`）：此刻程序里没有任何仍然活着的分配。那个契约编译器检查不了，这是 `unsafe fn reset(&self)` 的领地，我不打算在 Pebble 里写它。

</details>

## 从 FFI 到下一步

写这一篇的时候，我数了数 `pebble-sys` 里 `unsafe` 的行数：`lib.rs` 里 10 处 `unsafe` 块，每一处都有一句 `SAFETY`，加起来不到总行数的十分之一。调用这个 crate 的人（仓库里别的 crate，包括你自己写的）不需要在任何地方写 `unsafe`；一个包装层做得好不好，就看它能不能把"这个函数是不是 unsafe"这个问题从调用者那里拿走。同样的结构出现在 `pebble-nostd`：`bump.rs` 里有 `unsafe impl` 和几处 `unsafe` 块，`eval.rs` 一处都没有，`bump_global.rs` 也一处都没有。

下一步其实是反过来的问题：我们已经有了一个会在多个线程上被调用的 `BumpAllocator`，但整个 Pebble 的解释器还是单线程、`Rc` 的世界。第 14 篇我们把线程、`Send` 与 `Sync`、`Arc` 和 `Mutex` 一次讲清楚，让 `pebble check` 能并行检查多个文件，然后再上一层：用 Tokio 写一个能同时服务很多连接的 Pebble 求值服务器，并看看为什么 `Rc` 做的解释器偏偏是 `!Send`，我们要靠 `spawn_blocking` 绕开它。
