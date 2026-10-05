---
title: "三个边界：async、FFI 与 no_std"
commentId: "post:pebble-10-boundaries"
published: "2026-10-05 17:00:00 +08:00"
description: "一门语言写完求值器，只完成了一半。这一篇讲 Pebble 的三个边界：用 Tokio 做一个异步远程求值服务，用 build.rs 和 cc 调一段 C 代码，以及把一部分求值器降成 no_std 跑在没有标准库的地方。每一块都在教 Rust 的一条边界规则。"
category: Note
tags:
  - Rust
  - async
  - FFI
  - no_std
series: "从零写一门语言：Pebble"
seriesOrder: 10
draft: false
comment: true
slug: pebble-10-boundaries
---

如果只写"能算数的东西"，你会停在语言的核心。但真实项目总要碰到操作系统的边界：网络、C 库、裸机。这三样在 Pebble 里各有一个 crate。

> [!TIP] 先读基础篇
> 本篇分别用到 `async`/`Send`、FFI 的 `unsafe`、以及 `no_std`/`alloc`。基础篇 2 讲线程与智能指针，基础篇 4 讲 `build.rs`，可以先垫一层。

## async：远程求值服务

`pebble-net` 是一个 TCP 服务：客户端发一段 Pebble 程序，服务端求值，把结果或诊断发回去。协议极简，就是 4 字节大端长度前缀加 UTF-8 负载。

这里有一个需要在类型系统面前才能想清楚的问题：**解释器不是 `Send` 的**。它内部全是 `Rc`，而 `Rc` 不能跨线程。Tokio 的 `spawn` 要求任务 future 是 `Send`，所以不能把一个 `Interpreter` 抱着跨越 `.await`。

解法是把"求值"这段同步代码挪到一个专门的阻塞线程上：

```rust
let result = tokio::task::spawn_blocking(move || {
    evaluate(&program)   // 这里可以随便用 Rc
})
.await?;
```

`spawn_blocking` 把非 `Send` 的局部状态关在一个阻塞任务里，只把 `Send` 的结果（一段字符串）交还主线。这就是 `Send` 边界最实用的一个例子：不是你写不出，而是你要**主动设计**在哪一侧做那件脏活。

服务端还有一些典型的异步工程细节：

- 每个连接 `tokio::spawn` 一个任务，连接之间互不阻塞。
- 用 `tokio::time::timeout` 给每次请求加超时，防止一个死循环把连接占死。
- 用 `Arc<tokio::sync::Mutex<Stats>>` 统计连接数、请求数、错误数，多任务共享。
- 优雅关闭：`tokio::signal::ctrl_c()` 作为 `shutdown` future，收到信号就停止接受新连接。

`pebble-net` 的测试不是空转：它真的 bind 一个 `127.0.0.1:0`（随机端口），起一个服务端，用一个客户端连过去，验证正常程序和错误程序两条路径，再开两个并发客户端验证统计计数。七个测试全绿。

## FFI：让 Rust 调 C

`pebble-sys` 用 `build.rs` 和 `cc` 编译一小段 C，然后从 Rust 调它。三块内容：

第一块是 **FNV-1a 哈希**，纯函数，最容易验证。它的正确性有标准答案：

```rust
assert_eq!(fnv1a(b""), 0xcbf2_9ce4_8422_2325);        // 偏移基准
assert_eq!(fnv1a(b"hello"), 0xa430_d846_80aa_bd0b);   // 已知常量
assert_eq!(fnv1a(b"foobar"), 0x8594_4171_f739_67e8);
```

第二块是一个 **C 侧的 arena**：`pebble_arena_create` / `alloc` / `reset` / `destroy`。Rust 这边用 RAII 包了一层：

```rust
pub struct Arena { ptr: NonNull<PebbleArena> }

impl Drop for Arena {
    fn drop(&mut self) {
        // SAFETY: ptr 来自 pebble_arena_create，且只在这里销毁一次。
        unsafe { pebble_arena_destroy(self.ptr.as_ptr()); }
    }
}
```

`Drop` 调用 C 的 `destroy`，所以 Arena 一离开作用域内存就还了，调用方不用手动配对。`unsafe` 被压到很小的 `alloc` / `drop` 两处，外面全是安全接口。

第三块最有意思，是一个**反向回调**：Rust 把一个闭包通过 `void*` 上下文交给 C，C 在循环里回调它。

```c
int64_t pebble_fold(int64_t init, int64_t lo, int64_t hi,
                    int64_t (*cb)(int64_t, int64_t, void*), void* ctx);
```

`fold(0, 1..=100, |a, b| a + b)` 得到 5050。但这里有一条铁律：**Rust 的 panic 绝不能穿过 C 的栈帧**，那是未定义行为。所以回调的 trampoline 用 `catch_unwind` 把 panic 截住，等 C 返回之后再把它重新抛出：

```rust
// trampoline：catch_unwind 截住 panic，不让它穿过 C；
// pebble_fold 返回后，再 resume_unwind 还原成 Rust 的 panic。
```

对应的测试 `#[should_panic(expected = "closure exploded")]` 证明这条路径是通的。

## 连 C 都没有：no_std

`pebble-nostd` 的目标是"不依赖操作系统"，也就是 `no_std`。它做两件事：

第一，证明前端的公共部件真的能脱离 `std`。`pebble-span`、`pebble-diag`、`pebble-lexer` 都是 `#![no_std]`（外加 `alloc`），所以 `pebble-nostd` 能直接用**真正的词法器**去扫源码，而不是另写一个玩具扫描器。这里用到一个小技巧：

```rust
#![cfg_attr(not(test), no_std)]
```

正常构建是 `no_std`，但 `cargo test` 时会退回 `std`，因为测试框架本身要 `std`。这是很多真实 crate 的标准写法。

第二，实现一个 `GlobalAlloc`：

```rust
pub struct BumpAllocator { /* UnsafeCell 包着游标 */ }

unsafe impl GlobalAlloc for BumpAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // 按 layout.align() 对齐，用原子比较交换预留空间，不够就返回 null。
        // ...
    }
    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {
        // bump 分配不单独释放，整块一起回收。
    }
}
```

在裸机上，没有 `std::alloc`，`alloc` crate 需要一个全局分配器才能用 `Box` / `Vec` / `String`。bump 分配器就是最简单的实现：单调前进，不单独释放。它足够让词法器和一个小求值栈跑起来。

那个求值器本身也值得一提：它用**走车式（shunting-yard）**把算术表达式转成逆波兰式，再用一个 `Vec<i64>` 当栈求值，整数运算全部用带 `checked_*` 的版本，溢出会返回 `Overflow` 而不是悄悄回绕。

```rust
eval_source("1 + 2 * 3")   // => Ok(7)
eval_source("(1 + 2) * 3") // => Ok(9)
eval_source("1 / 0")       // => Err(DivisionByZero)
eval_source("9223372036854775807 + 1") // => Err(Overflow)
```

## 这一篇的小结

这三块看起来互不相干，其实都在教同一条东西：**边界**。

- `async` 的边界是 `Send`：什么能跨 `.await`，什么必须先关进 `spawn_blocking`。
- FFI 的边界是 `unsafe` 和 ABI：`repr(C)` 布局、`void*` 所有权、panic 不能越界。
- `no_std` 的边界是"有没有操作系统"：没有 `std`，但可以有 `alloc`，前提是自己提供分配器。

把这三条边界摸一遍，Rust 就不再只是"一个能写求值器的语言"，而是一个能覆盖从裸机到云端的语言。

## 下一篇

最后一篇回到工程和收尾：CLI 与 REPL 是怎么拼起来的，`clippy -- -D warnings` 在真实工作区里踩过什么坑，测试策略是怎么分层的，以及这个项目里什么比我想的难、什么比我想的容易。
