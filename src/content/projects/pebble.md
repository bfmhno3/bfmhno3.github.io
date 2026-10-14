---
title: "Pebble"
slug: pebble
published: 2026-10-05
draft: false
order: 90
description: "一个用 Rust 从零实现的小型脚本语言与工具链：手写词法器、递归下降解析器、树遍历解释器、字节码编译器与栈式 VM、手写标记清除 GC，外加过程宏、async、FFI 与 no_std。配套 15 篇「用 Pebble 从零学 Rust」教程，从空目录一章一个 crate 重建整个项目。"
image: ""
status: "published"
tags:
  - Rust
  - 编译器
  - 解释器
  - 虚拟机
  - 垃圾回收
  - 学习项目
link:
  - label: "GitHub"
    icon: "fa7-brands:github"
    value: "https://github.com/bfmhno3/pebble"
  - label: "系列文章"
    icon: "material-symbols:menu-book"
    value: "/series/"
lang: ""
---

## 这是什么

Pebble 是一门我用 Rust 从零写出来的小型脚本语言，也是一份 "用一个真实项目把 Rust 学完" 的教材底稿。它不是单文件 demo：整套东西拆成了一个 Cargo 工作区，每个 crate 都负责让 Rust 的某一个角落真正干活。

语言本身支持：`let` 绑定、`fn` 与闭包、`if`/`while`/`for`、`return`/`break`/`continue`、整数与浮点、字符串、列表 `[...]`、映射 `#{...}`、索引与赋值、以及一组内建函数（`print`、`len`、`range`、`push` 等）。

## 从零学 Rust 系列

我把这个项目拆成了 15 篇边写边学的教程：从一个空目录和 `cargo new` 开始，一章一个 crate，把 Pebble 重新搭一遍。每一章都有可以对照的检查点，读者不需要去别处查资料。

- 从第 1 篇开始：[第一个 crate：从 cargo new 到 Span](/posts/rust-by-pebble-01-first-crate/)
- 全部 15 篇：见 [系列页](/series/)

## 两个后端

同一个前端，两套执行引擎：

- **树遍历解释器**：直接走 AST，用 `Rc<RefCell<..>>` 组成作用域链。写起来最直观，也最能暴露引用计数的循环引用问题。
- **字节码 VM**：把 AST 编译成指令流，在栈式虚拟机上执行，运行时对象全部落在手写的**标记清除垃圾回收器**上。递归闭包形成的环因此可以被回收。

两个后端并不完全一致：块内的 `let` 在树遍历解释器里有自己的作用域，在 VM 里每次调用只有一个环境；嵌套的 `for` 在 VM 里还有已知的问题。第 10 篇和第 12 篇会把这些差异摆出来。仓库里的差分测试（`#[differential]`）只收录两边确实一致的程序。

## 工作区结构

| crate | 让它干活的 Rust 知识 |
| --- | --- |
| `pebble-span` | `#![no_std]`、`Copy` 类型、`Index` 运算符重载、源码映射 |
| `pebble-diag` | 错误类型、`Display`/`Error`、诊断渲染 |
| `pebble-lexer` | 零拷贝 `&str` 扫描、生命周期、`Cow`、`Iterator` |
| `pebble-ast` | 递归枚举、`Box`、泛型 visitor trait、`IntoIterator` |
| `pebble-macros` | `proc-macro`、`syn`/`quote`、derive、函数式宏与属性宏 `#[differential]` |
| `pebble-parser` | 递归下降、优先级爬升、`Result`/`?`、错误恢复 |
| `pebble-value` | `Rc`/`RefCell`、内部可变性、自定义 `Hash`/`Eq`、切片模式 |
| `pebble-interp` | 环境链、闭包、`FnOnce`、`Weak` 与引用环 |
| `pebble-bytecode` | 指令流、`macro_rules!`、跳转回填、常量池 |
| `pebble-gc` | `unsafe`、裸指针、`MaybeUninit`、`Cell`、泛型标记清除 |
| `pebble-vm` | 栈式虚拟机、opcode 派发、GC 根 |
| `pebble-sys` | `build.rs`、`cc`、`extern "C"`、`repr(C)`、`PhantomData`、FFI 回调 |
| `pebble-nostd` | `no_std` + `alloc`、const 泛型、`#[global_allocator]` |
| `pebble-net` | `async`/`await`、Tokio、`spawn_blocking`、带 `source()` 的错误类型 |
| `pebble-cli` | `clap`、`Backend` trait（泛型关联类型）、作用域线程、Cargo features |

## 怎么跑

```bash
nix develop          # 或系统 Rust >= 1.88
cargo build --workspace

cargo run -p pebble-cli -- run examples/fib.pebble
cargo run -p pebble-cli -- run --vm examples/fib.pebble
cargo run -p pebble-cli -- check examples/fib.pebble examples/hello.pebble
cargo run -p pebble-cli -- repl
```
