---
title: "收尾：CLI、工程化，和一次 `clippy -- -D warnings` 的教训"
commentId: "post:pebble-11-cli-and-engineering"
published: "2026-10-05 18:00:00 +08:00"
description: "最后一篇。CLI 和 REPL 把所有 crate 缝在一起；工作区级的 lint、fmt、CI 和 Criterion 决定这个项目能不能长期维护。这一篇还包括一次真实的 clippy 踩坑、150 个测试的分层策略，以及回头看，写一门语言里什么比我想的难、什么比我想的容易。"
category: Note
tags:
  - Rust
  - 工程化
  - CLI
  - 测试
series: "从零写一门语言：Pebble"
seriesOrder: 11
draft: false
comment: true
slug: pebble-11-cli-and-engineering
---

前十个 crate 都是"零件"。把它们拼成一个能用的工具，是 `pebble-cli` 的事，也是这一篇要讲的工程部分。

## CLI 是唯一知道所有零件的地方

`pebble` 有六个子命令：

```text
run     编译并运行一个文件（--vm 切到字节码后端，--ast / --dump-bytecode 看中间产物）
repl    交互式求值
tokens  打印 token 流
parse   打印语法树
check   只做词法 / 语法 / 编译检查，不运行
bench   在同一文件上计时两个后端
```

这个 CLI 的依赖列表几乎就是整个工作区：`span`、`diag`、`lexer`、`ast`、`parser`、`value`、`interp`、`bytecode`、`vm` 全在里面。它是唯一的"集成商"。

两条设计规则贯穿它：

- **诊断走 stderr**，程序的正常输出走 stdout。所以 `pebble check` 在正确文件上可以完全静默，`pebble run` 的错误不会污染管道。
- **退出码有意义**：成功 0，有诊断或运行时错误 1，用法错误 2（clap 处理）。CI 里可以直接判断。

还有个小细节：`run` 默认会打印程序的最终值，但如果那个值是 `nil`（脚本几乎都以语句结尾），就不打印，免得每次运行都多出一行 `nil`。

REPL 用一个持久化的解释器，每一行先试着当**表达式**解析，成功就直接求值，失败再当完整程序解析：

```rust
match parse_expression(source.id, line) {
    (Some(expr), diags) if diags.is_empty() => { /* 求值并打印 */ }
    _ => { /* 当成程序解析并执行 */ }
}
```

于是 `1 + 2` 立刻得到 `3`，而 `let x = 10;` 也能正常工作。

## 工程化：把标准钉进 CI

仓库根部的 `Cargo.toml` 定义了 workspace 级 lint，每个 crate 用 `[lints] workspace = true` 继承：

```toml
[workspace.lints.rust]
rust_2018_idioms = "warn"
unsafe_op_in_unsafe_fn = "warn"

[workspace.lints.clippy]
all = "warn"
```

CI 上跑四件事：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace`、`cargo build --release`，测试矩阵覆盖 Linux 和 macOS。本地想要一模一样的环境就 `nix develop`。

## 一次真实的 clippy 踩坑

`cargo clippy -p pebble-vm -- -D warnings` 看起来只检查 `pebble-vm`。但在这个工作区里，它会把 `-- -D warnings` 也传给**路径依赖**一起编译，于是别的 crate 里的 lint 也会变成编译错误。

我是在 CI 里撞上这个的：`pebble-vm` 自己干净，却因为 `pebble-value` 里 22 处 `clippy::result_large_err` 而失败。原因是 `RuntimeError` 里塞了一个很大的 `Diagnostic`，而返回 `Result<T, E>` 时 `E` 超过阈值就会被提醒。修法有两种：到处 `#[allow]`，或者把 `Diagnostic` 装进 `Box`。我选了后者，错误类型从一百多字节缩到 32 字节：

```rust
pub struct RuntimeError {
    pub diagnostic: Box<Diagnostic>,
    pub trace: Vec<TraceFrame>,
}
```

同一轮还修掉了 `pebble-bytecode` 的两处 `collapsible_if`（用 Rust 2024 的 let-chain 合并）和 `pebble-value` / `pebble-interp` 的 `mutable_key_type`。后者我没有盲目 `allow`，而是先确认"映射的键虽然含内部可变性，但哈希是稳定的"（可变值按指针身份哈希），才写下一行带解释的 `allow`。

顺带一个坑：`cargo fmt --all` 会按 `rustfmt.toml` 里声明的 edition 重排 `use`，如果代码里混着旧风格，会在你没碰过的文件里报 diff。这类"工具链自身的漂移"只能在收尾时统一跑一次 `cargo fmt --all` 解决。

## 测试策略是分层的

| 层次 | 手段 | 例子 |
| --- | --- | --- |
| 单元测试 | `#[cfg(test)]` 挨着代码 | span 的 CJK 列号、lexer 的零拷贝指针检查 |
| 随机测试 | 用 `rand` 生成输入再对拍 | GC 的"存活集合 vs BFS 可达集合"，200 轮 |
| 集成测试 | `assert_cmd` 驱动真二进制 | 两个后端 stdout 逐字节相等 |
| 文档测试 | `///` 里的可运行示例 | `chunk!` 宏、`fnv1a` 的三个常量 |
| 性能测试 | Criterion，附带正确性断言 | 两个后端上跑同一程序，先对结果再比时间 |

当前状态：**32 个测试二进制，150 个测试，0 失败**；`cargo clippy --workspace -- -D warnings` 干净；`cargo fmt --all --check` 干净。

我特意写了几个"会失败得很明显"的测试，比如：

```rust
#[test]
#[should_panic(expected = "different files")]
fn merge_across_files_is_a_bug() {
    let a = Span::new(SourceId(0), 0, 1);
    let b = Span::new(SourceId(1), 0, 1);
    let _ = a.merge(b);
}
```

这条测试不是在验证功能，而是在**冻结一个不变量**：跨文件合并 span 永远是编译器自己的 bug。

## 回头看：难在哪，易在哪

**比预想难的：**

- **借用检查器最较真的地方是"同时要读和要写"。** VM 的索引赋值里，我一度写成"先 `get_mut` 拿到对象，再调 `self.resolve_index(&self,...)`"，编译器当然不让。最后改成"先只读地把长度取出来，算好下标，再 `get_mut`"。这类重构会逼你想清楚：到底哪一步需要独占。
- **GC 的根。** 回收器本身不难写，难的是"谁还活着"。把收集放在指令边界、明确三类根（值栈、帧、全局），这两条想清楚之后才稳。
- **两个后端的语义对齐。** 我花了一整个改动让"`if` 不产生值"这条规则在树遍历那侧也成立，就为了 `the_vm_and_the_interpreter_agree` 能逐字节通过。
- **压栈顺序。** 第七篇那个 `for` 循环的 bug，两行 `GetName` 写反，报错信息却是"列表不可调用"。

**比预想容易的：**

- **枚举加模式匹配。** 写编译器一半的时间都在"匹配一个枚举"，而 Rust 这块的手感好得离谱。重构 AST 时，漏掉某个变体编译器会直接指出来。
- **错误处理。** `Result` + `?` + `#[derive(Debug)]` 的错误类型，让"一路把错误往上抛"变成几乎不用动脑的事。
- **整个前端。** 词法、语法、AST 加起来大概两天，比我想象快。

## 如果继续做下去

按性价比排序，我下一步会做：

1. **把变量从"按名字查找"改成"栈槽 + upvalue"。** 这是 VM 最大的性能杠杆，第 9 篇那 2 倍很容易再翻一倍。
2. **加 `struct` 或 `class`，以及方法调用。** 语言表达力会立刻上一个台阶。
3. **把指令真正编码成字节**，用跳转表甚至计算跳转做派发。
4. **分代 GC**，把"大多数对象活不过一轮"这个现实利用起来。
5. **错误恢复做得更细**，让 IDE 场景（补全、跳转）可用。

## 最后

这个系列到这儿就完了。它从 `Span` 的四个整数开始，一路走到一个能联网、能调 C、能跑在裸机上的语言实现。中间我写坏过 GC 的根、写反过压栈顺序、写过测试抓不住的诊断格式，也都修好了。

如果你也在学 Rust，我的建议不是"去做一个 CLI"。去做一个**大到你必须同时用上所有权、枚举、宏、`unsafe`、`async` 和 FFI** 的东西。语言实现恰好就是这种题目。

代码全部在 [github.com/bfmhno3/pebble](https://github.com/bfmhno3/pebble)，MIT / Apache-2.0 双许可。`nix develop && cargo test --workspace` 就能跑起来。祝你造点东西。
