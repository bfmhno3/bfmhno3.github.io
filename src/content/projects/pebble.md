---
title: "Pebble"
slug: pebble
published: 2026-10-05
draft: false
order: 90
description: "一个用 Rust 从零实现的小型脚本语言与工具链：手写词法器、递归下降 + Pratt 解析器、树遍历解释器、字节码编译器与栈式 VM、手写标记清除 GC，外加过程宏、async、FFI 与 no_std。整套代码是一个用来系统学习 Rust 的多 crate 工作区。"
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

Pebble 是一门我用 Rust 从零写出来的小型脚本语言，也是一次 "把 Rust 的知识点逐个落到真实代码里" 的实验。它不是玩具式的单文件 demo：整套东西拆成了一个 Cargo 工作区，每个 crate 都负责让 Rust 的某一个角落真正干活。

语言本身支持：`let` 绑定、`fn` 与闭包、`if`/`while`/`for`、`return`/`break`/`continue`、整数与浮点、字符串、列表 `[...]`、映射 `#{...}`、索引与赋值、以及一组内建函数（`print`、`len`、`range`、`push` 等）。

## 两个后端

同一个前端，两套执行引擎：

- **树遍历解释器**：直接走 AST，用 `Rc<RefCell<..>>` 组成作用域链。写起来最直观，也最能暴露引用计数的循环引用问题。
- **字节码 VM**：把 AST 编译成指令流，在栈式虚拟机上执行，运行时对象全部落在手写的**标记清除垃圾回收器**上。递归闭包形成的环因此可以被回收。

两个后端在可观测语义上保持一致，benchmark 里可以直接对比它们的差距。

## 工作区结构

| crate | 让它干活的 Rust 知识 |
| --- | --- |
| `pebble-span` | `#![no_std]`、`Copy` 类型、字节偏移、源码映射 |
| `pebble-diag` | 错误类型、`Display`/`Error`、诊断渲染 |
| `pebble-lexer` | 零拷贝 `&str` 扫描、生命周期、`Cow`、`Iterator` |
| `pebble-ast` | 递归枚举、`Box`、带默认实现的 visitor trait |
| `pebble-macros` | `proc-macro`、`syn`/`quote`、derive 与函数式宏 |
| `pebble-parser` | 递归下降、Pratt 解析、`Result`/`?`、错误恢复 |
| `pebble-value` | `Rc`/`RefCell`、内部可变性、自定义 `Hash`/`Eq` |
| `pebble-interp` | 环境链、闭包、把控制流当作数据、递归上限 |
| `pebble-bytecode` | 指令流、跳转回填、常量池、反汇编 |
| `pebble-gc` | `unsafe`、裸指针、`MaybeUninit`、`Cell`、泛型标记清除 |
| `pebble-vm` | 栈式虚拟机、opcode 派发、GC 根 |
| `pebble-sys` | `build.rs`、`cc`、`extern \"C\"`、`repr(C)`、FFI 回调 |
| `pebble-nostd` | `no_std` + `alloc`、自定义 `GlobalAlloc` |
| `pebble-net` | `async`/`await`、Tokio、`spawn_blocking`、`Send` 约束 |
| `pebble-cli` | `clap`、`io`、交互式 REPL |

## 怎么跑

```bash
nix develop          # 或系统 Rust >= 1.88
cargo build --workspace

cargo run -p pebble-cli -- run examples/fib.pebble
cargo run -p pebble-cli -- run --vm examples/fib.pebble
cargo run -p pebble-cli -- repl
```

整套实现的来龙去脉写成了一个系列文章，见站内的 Pebble 系列。
