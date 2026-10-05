---
title: "我决定用写一门语言来学 Rust：Pebble 从零开始"
commentId: "post:pebble-01-why-build-a-language"
published: "2026-10-05 08:00:00 +08:00"
description: "官方教程写得很好，但我看不进去。于是我用 Rust 从零写了一个小型脚本语言 Pebble：手写词法器、解析器、树遍历解释器、字节码 VM 和垃圾回收器，拆成 16 个 crate。这是这个系列的第一篇，先交代为什么这么做、做成了什么、以及后面会怎么写。"
category: Note
tags:
  - Rust
  - 编译器
  - 解释器
  - 学习
series: "从零写一门语言：Pebble"
seriesOrder: 1
draft: false
comment: true
slug: pebble-01-why-build-a-language
---

> "What I cannot create, I do not understand." - Richard Feynman

Rust 的官方资料质量很高：The Book、Rust by Example、各种文档都写得清楚。但对我来说，最有效的学习方式从来不是读，而是"造一个东西，然后写下来"。所以这次我不看教程，直接给自己定了一个足够大的目标：**从零写一门能跑的小型语言**。

我给自己的规则只有八个字：先做出来，再讲清楚。这篇文章讲的不是语言本身，而是这个项目怎么搭起来的。

## 怎么读这个系列

整套东西分成两个系列。**实现篇**（你正在读的这个）假设你已经能读懂 Rust 代码。如果你还不能，先读**基础篇**：

| 篇 | 内容 |
| --- | --- |
| 基础 1 | Rust 语法速览：从 Span 的十行代码开始 |
| 基础 2 | Rust 标准库速览：容器、智能指针、迭代器 |
| 基础 3 | 所有权、借用与生命周期 |
| 基础 4 | Cargo 与项目组织：16 个 crate 是怎么摆的 |

基础篇里的每一段代码都取自这个项目，读完能直接接着读实现篇。如果你已经会 Rust，可以跳过它们，从下一篇（位置与诊断）开始。

## 为什么是"语言"

如果只是学 Rust 语法，写个命令行小工具就够了。但"写语言"这件事有个别的题目没有的好处：它几乎逼着你把 Rust 的每个角落都用一遍，而且是**不得不**用，不是"顺便用"。

举几个具体的：

- 词法分析要**零拷贝**地扫 `&str`，这就逼你认真对待生命周期，而不是绕开借用检查器。
- AST 是**递归枚举**，加 `Box`，加模式匹配，这是 Rust 最舒服的部分。
- 解析器要一路返回 `Result`，用 `?` 传播错误，还得**错误恢复**，不然第一个错就中断了。
- 解释器用 `Rc<RefCell<..>>` 组作用域链，你会亲手遇到**循环引用泄漏**。
- 想让它更快，就得写**字节码编译 + 栈式 VM**，于是你要手写**垃圾回收器**和 `unsafe`。
- 想让它可部署，就得碰 **FFI** 和 **no_std**；想让它能被远程调用，就得碰 **async**。

没有哪个单独的题目能同时要求这些。语言可以。

## 做出来的东西

工件叫 Pebble，一门动态类型的脚本语言。它能跑这样的程序：

```pebble
fn fib(n) {
    if n < 2 {
        return n;
    }
    return fib(n - 1) + fib(n - 2);
}

let total = 0;
for i in range(10) {
    if i % 2 == 0 { continue; }
    total = total + i;
}
print("odd sum:", total);
print("fib(20) =", fib(20));
```

跑出来的结果是我真正关心的证据，不是"看起来能跑"：

```text
$ pebble run examples/fib.pebble
6765
$ pebble run --vm examples/fib.pebble
6765
```

同一门语言有**两个后端**：一个树遍历解释器，一个字节码虚拟机。它们必须给出一样的结果，这一点由测试保证（`the_vm_and_the_interpreter_agree` 比较两者的 stdout，逐字节相等）。

规模上，它不是单文件玩具：

- **16 个 crate**，**26 个 Rust 文件**，约 **9900 行 Rust**，外加 **214 行 C**（FFI 那一章）。
- 前端一套：词法器、解析器、AST、诊断。
- 后端两套：`pebble-interp` 与 `pebble-bytecode` + `pebble-vm`。
- 一块手写的**标记清除垃圾回收器**，一个 **no_std** 求值器，一个 **Tokio** 异步远程求值服务。

## 工作区蓝图

这是整个系列的骨架，后面每一篇对应其中一块。

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
| `pebble-gc` | `unsafe`、裸指针、`MaybeUninit`、泛型标记清除 |
| `pebble-vm` | 栈式虚拟机、opcode 派发、GC 根 |
| `pebble-sys` | `build.rs`、`cc`、`extern "C"`、`repr(C)`、FFI 回调 |
| `pebble-nostd` | `no_std` + `alloc`、自定义 `GlobalAlloc` |
| `pebble-net` | `async`/`await`、Tokio、`spawn_blocking`、`Send` 约束 |
| `pebble-cli` | `clap`、`io`、交互式 REPL |
| `pebble-bench` | Criterion 基准，对比两个后端 |

## 环境

我不想在"工具链没配好"上浪费任何时间，所以用 Nix 把环境钉死：

```bash
nix develop          # 得到 rustc 1.95 / cargo / clippy / rustfmt
cargo build --workspace
```

工作区用 `edition = "2024"`、`resolver = "3"`，最低 Rust 版本 1.88（`alloc`、let-chain 都需要）。`Cargo.toml` 里打开了一组 workspace 级 lint，CI 上跑 `cargo clippy -- -D warnings`。这些工程配置本身也是要讲的内容，放到最后一篇。

## 一个真实的性能数字

系列进行到一半时，我给两个后端加了同一组 benchmark（Criterion）。在 fib(20)、十万次循环求和、一千个列表元素这三组负载上，字节码 VM 分别快了：

- fib(20)：**1.31 倍**
- 循环求和：**2.03 倍**
- 列表构建 + 索引：**1.23 倍**

这些数字会在对应那篇里拆开讲，包括"为什么不是 10 倍"这种更诚实的部分。

## 实现篇的路线

按依赖顺序走，每一篇都基于真实代码和真实输出：

1. 开篇（本篇）：为什么、做什么、怎么组织。
2. 位置与诊断：`pebble-span` 与 `pebble-diag`。
3. 零拷贝词法器。
4. AST 与过程宏。
5. 解析器：递归下降 + Pratt + 错误恢复。
6. 树遍历解释器，以及 `Rc<RefCell<..>>` 的循环引用。
7. 字节码编译器：跳转回填与反汇编。
8. 手写垃圾回收器：`unsafe`、`MaybeUninit`、泛型标记清除。
9. 栈式 VM：GC 根与性能对比。
10. 边界：async、FFI、no_std。
11. CLI、工程化与收尾反思。

代码在 [github.com/bfmhno3/pebble](https://github.com/bfmhno3/pebble)。下一篇从最不起眼、但贯穿全项目的 `pebble-span` 开始：把"第几行第几列"这件事做对。
