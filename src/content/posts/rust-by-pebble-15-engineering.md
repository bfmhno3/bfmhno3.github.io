---
title: "收尾：Cargo features、测试、lint 与 CI"
commentId: "post:rust-by-pebble-15-engineering"
published: "2026-10-13 22:00:00 +08:00"
description: "最后一篇没有新语法。我们把 pebble repl 做成可选的 Cargo feature，看清单元、集成和文档测试的分工，让 rustdoc、clippy、rustfmt 把风格交给机器，读完 CI 配置，再把整个工作区与 tag 做最后一次逐字节对比。"
category: Note
tags:
  - Rust
  - Pebble
  - Cargo
  - 测试
  - 工程化
series: "用 Pebble 从零学 Rust"
seriesOrder: 15
draft: false
comment: true
slug: rust-by-pebble-15-engineering
---

Pebble 现在有 16 个 crate、10515 行 Rust、214 行 C，`Cargo.lock` 里锁了 143 个包，`cargo test --workspace --all-features` 跑 168 个测试。这一篇没有新语法，我想讲的是另一件事：怎样让这堆东西在我不看它的时候也保持正确。打 tag 之前，我在一个干净的工作树里把 CI 里的 rustdoc 命令跑了一遍，它在三个 crate 上报错，原因是我在文档注释里写了三个指向不存在或私有条目的链接。也就是说，如果我当时直接推送，这个仓库的 docs 任务会是红的，而我写了十四篇文章讲"Rust 编译器会替你检查"。这一篇就是讲怎么把"检查"从编译器扩展到整个仓库。

> [!NOTE] 本篇检查点
> 做完这一篇，你的 `pebble-cli` 会是最终版：`repl` 成了一个默认开启的 Cargo feature，`cargo build -p pebble-cli --no-default-features` 得到一个没有 `pebble repl` 的、小 24% 的二进制。整个工作区（除了 `.github/`、文档和许可证文件，它们直接从 tag 复制）与 tag `tutorial-v1` 逐字节一致，`cargo test --workspace --all-features` 通过 168 个测试。会用到的东西：Cargo features、`cfg`、单元/集成/文档测试、rustdoc 和 intra-doc 链接、工作区 lint、clippy、rustfmt、`rust-toolchain.toml`、发布 profile、CI。上一篇在 [并发与 async](/posts/rust-by-pebble-14-concurrency-async/)，命令行第五版就是从那里来的。

这一篇的结构：先用五小步把命令行从第五版升到 tag 的最终版（每一步都让编译器说一句话）；然后过一遍测试、文档、lint 和配置文件，每样东西都用仓库里真实的文件说话；然后读 CI；然后做最后的对比；最后是一张"Rust 特性对应哪一篇"的索引表。

## 命令行终版：让 `repl` 变成可选的

第 9 篇我们给命令行加了 `pebble repl`，它靠 `rustyline` 这个第三方库提供行编辑、历史和方向键。这是命令行里唯一一个纯粹为交互而存在的依赖。如果有人只想要 `run` 和 `check`（比如在 CI 里、在容器里、在一个没有终端的地方），他仍然要下载和编译 `rustyline` 以及它的依赖。C 里的做法是 `#ifdef WITH_READLINE`，用 CMake 的 `option()` 开关。Cargo 的对应物叫 **feature**。

我们从第 14 篇结束时的第五版出发。如果你一路跟下来，你的 `crates/pebble-cli` 就是它；如果你是跳着来的，第五版的文件在第 14 篇里有完整内容。

### 先问一句：现在有没有办法不要 `repl`？

第一反应：Cargo 有 `--no-default-features`，试试。

```text
$ cargo build -p pebble-cli --no-default-features
   Compiling pebble-cli v0.1.0 (/tmp/pebble-rebuild-15/crates/pebble-cli)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 9.33s
```

编译通过，听上去成功了。看看依赖：

```text
$ cargo tree -p pebble-cli --no-default-features -e normal | grep rustyline
└── rustyline v18.0.1
$ ./target/debug/pebble repl </dev/null
Pebble REPL. Type :help for commands, :quit to exit.
pebble> 
```

`rustyline` 还在，`repl` 也还在。原因很朴素：`--no-default-features` 的意思是"不要开启 `default` 这个 feature 里列的东西"，而我们的 `Cargo.toml` 里根本没有写任何 `[features]`，所以没有什么可关的。Cargo 不会因此报错，这个开关在这里是空操作。

### 第一步：把依赖标成 `optional`

在 `crates/pebble-cli/Cargo.toml` 里，把 `rustyline.workspace = true` 改成：

```toml
rustyline = { workspace = true, optional = true }
```

`optional = true` 的意思是"这个依赖默认不编译，除非某个 feature 点名要它"。现在不加任何 feature，直接构建：

```text
$ cargo build -p pebble-cli
   Compiling pebble-cli v0.1.0 (/tmp/pebble-rebuild-15/crates/pebble-cli)
error[E0433]: cannot find module or crate `rustyline` in this scope
  --> crates/pebble-cli/src/repl.rs:15:5
   |
15 | use rustyline::error::ReadlineError;
   |     ^^^^^^^^^ use of unresolved module or unlinked crate `rustyline`
   |
   = help: if you wanted to use a crate named `rustyline`, use `cargo add rustyline` to add it to your `Cargo.toml`

error[E0432]: unresolved import `rustyline`
...
error: could not compile `pebble-cli` (bin "pebble") due to 2 previous errors
```

这个错误是对的：我们声明了一个"默认不编译"的依赖，却没有说什么时候该编译它，`repl.rs` 里的 `use rustyline::...` 就悬空了。

### 第二步：写 `[features]`

在同一个文件的 `[dev-dependencies]` 前面加：

```toml
[features]
default = ["repl"]
# The interactive `pebble repl` subcommand (pulls in the line editor).
repl = ["dep:rustyline"]
```

读法：`repl` 是一个 feature 的名字，它开启时会启用 `rustyline` 这个可选依赖（`dep:` 前缀的意思是"我指的是依赖本身，不是另一个同名 feature"）；`default` 是一个特殊的 feature 名，列在里面的东西在没人指定时自动开启。所以普通的 `cargo build` 仍然带 `repl`，行为不变：

```text
$ cargo build -p pebble-cli
   Compiling pebble-cli v0.1.0 (/tmp/pebble-rebuild-15/crates/pebble-cli)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.45s
```

而 `--no-default-features` 这次真的有东西可以关了，于是 `rustyline` 不再被编译，`repl.rs` 又找不到它：

```text
$ cargo build -p pebble-cli --no-default-features
   Compiling pebble-cli v0.1.0 (/tmp/pebble-rebuild-15/crates/pebble-cli)
error[E0433]: cannot find module or crate `rustyline` in this scope
  --> crates/pebble-cli/src/repl.rs:15:5
...
```

同一个错误。现在轮到源代码：不开 `repl` 的时候，`repl.rs` 整个文件都不应该参与编译。

### 第三步：`#[cfg(feature = "repl")]`

Cargo 把开启的 feature 作为 `--cfg 'feature="repl"'` 传给 rustc。源码里用 `#[cfg(...)]` 属性按它来取舍：条件不成立，被标注的那个条目就好像从来没有写过。这有点像 `#ifdef`，区别有两个：它作用在**语法树的条目**上（一个模块、一个函数、一个枚举变体、一条 `match` 分支），不是按行的文本替换；而且条目被取舍之前，rustc 仍然把它解析成合法的语法，所以你没法用 `#[cfg]` 藏一段根本不是 Rust 的东西。

先只给 `main.rs` 里的 `mod repl;` 加上：

```rust
#[cfg(feature = "repl")]
mod repl;
```

```text
$ cargo build -p pebble-cli --no-default-features
   Compiling pebble-cli v0.1.0 (/tmp/pebble-rebuild-15/crates/pebble-cli)
error[E0433]: cannot find module or crate `repl` in this scope
  --> crates/pebble-cli/src/main.rs:30:26
   |
30 |         Command::Repl => repl::run(),
   |                          ^^^^ use of unresolved module or unlinked crate `repl`
   |
note: found an item that was configured out
  --> crates/pebble-cli/src/main.rs:17:5
   |
16 | #[cfg(feature = "repl")]
   |       ---------------- the item is gated behind the `repl` feature
17 | mod repl;
   |     ^^^^
...
```

编译器很客气：它不仅指出 `repl` 找不到，还告诉你"有一个被 configured out 的条目叫这个名字，被 `repl` feature 守着"。这是 `cfg` 比 `#ifdef` 友好的地方：C 里你只会得到 `undeclared identifier`，然后自己去找是哪个宏把它藏起来了。

下一处是 `main` 里的 `match` 分支。给它加上同样的属性：

```rust
        #[cfg(feature = "repl")]
        Command::Repl => repl::run(),
```

```text
$ cargo build -p pebble-cli --no-default-features
error[E0004]: non-exhaustive patterns: `cli::Command::Repl` not covered
  --> crates/pebble-cli/src/main.rs:28:24
   |
28 |     let result = match cli.command {
   |                        ^^^^^^^^^^^ pattern `cli::Command::Repl` not covered
...
```

`match` 是穷尽性检查的（第 3 篇），分支没了，变体还在，于是编译器拒绝。最后一处是 `cli.rs` 里的枚举变体本身，把属性放在 `Repl,` 上面（文档注释前后都行，tag 里它在文档注释后面）：

```rust
    /// Start an interactive read-eval-print loop.
    #[cfg(feature = "repl")]
    Repl,
```

```text
$ cargo build -p pebble-cli --no-default-features
   Compiling pebble-cli v0.1.0 (/tmp/pebble-rebuild-15/crates/pebble-cli)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.09s
```

三个 `#[cfg(feature = "repl")]`，一个在 `mod repl;` 上，一个在 `match` 分支上，一个在枚举变体上，加上 `Cargo.toml` 的两处改动，就是整个"可选 `repl`"。这三处不是我随便选的：你可以把它们理解成"一个功能在程序里有三个落脚点：代码、入口、命令行的声明"，每一个都被编译器逼着你处理，漏掉哪个，哪个就报错。我在 `/tmp/pebble-rebuild-15` 里验证过，现在 `crates/pebble-cli` 下的 `Cargo.toml`、`cli.rs`、`main.rs` 与 tag 逐字节相同。

### 看看效果

没有 `repl` 的二进制，子命令列表里就没有它：

```text
$ ./target/debug/pebble --help
Pebble: a small scripting language and toolchain

Usage: pebble <COMMAND>

Commands:
  run     Execute a source file on the tree-walker or the bytecode VM
  tokens  Print the token stream of a source file
  parse   Print the parsed abstract syntax tree of a source file
  check   Lex, parse, and compile source files without running them
  bench   Time both backends on a source file
  help    Print this message or the help of the given subcommand(s)
```

这是 clap 的派生宏读到的东西：派生宏拿到的枚举定义里，被 `cfg` 去掉的变体已经不在了，所以不需要任何额外代码。直接运行它：

```text
$ cargo run -q -p pebble-cli --no-default-features -- repl
error: unrecognized subcommand 'repl'

  tip: a similar subcommand exists: 'help'

Usage: pebble <COMMAND>

For more information, try '--help'.
$ echo $?
2
```

退出码 2 是 clap 的"用法错误"，和第 7 篇的 `unknown_subcommands_are_usage_errors` 同一类。两个版本的体积和依赖，用发布 profile 各编一次：

```text
$ cargo build -q -p pebble-cli --release && ls -l target/release/pebble
1915528 ... target/release/pebble
$ cargo build -q -p pebble-cli --release --no-default-features && ls -l target/release/pebble
1452928 ... target/release/pebble
```

$(1915528 - 1452928) / 1915528 \approx 24\%$。依赖方面，`cargo tree -p pebble-cli -e normal --prefix none | sort -u | wc -l` 是 56，加上 `--no-default-features` 是 43，少了 13 个包：`cfg-if`、`endian-type`、`home`、`libc`、`log`、`memchr`、`nibble_vec`、`nix`、`radix_trie`、`rustyline`、`smallvec`、`unicode-segmentation`、`unicode-width`（两份清单 `sort -u` 之后 `diff` 的结果）。

测试也跟着变了：

```text
$ cargo test -p pebble-cli --no-default-features
     Running unittests src/main.rs (target/debug/deps/pebble-88f4cb96ddecbc63)
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running tests/cli.rs (target/debug/deps/cli-c82fb2694cfbd503)
test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.09s
```

默认配置下是"3 个单元测试加 12 个集成测试"（第 14 篇的数字），没有 `repl` 时单元测试变成 0 个：那 3 个测试是 `repl.rs` 里 `MetaCommand` 的测试，文件整个不存在了，它们也就不存在了。12 个集成测试一个不少，因为它们只通过二进制的公开行为说话。

### 为什么 CI 要单独跑一遍 `--no-default-features`

这就是 CI 里那两行的作用。`cargo test --workspace --all-features` 只测"全开"这一种组合；"全关"这一种组合是另一个程序，它能因为一个忘了写的 `#[cfg]` 编不过去，而全开的组合永远发现不了。上面我们按顺序踩过的三个错误，每一个都是"全开通过、全关失败"的典型。所以 CI 的 `clippy` 任务多一行 `cargo clippy -p pebble-cli --no-default-features --all-targets -- -D warnings`（连死代码警告也算失败），`build` 任务多一行 `cargo build -p pebble-cli --no-default-features`。

关于这两行里的 `-p pebble-cli`，我顺手试了 `--workspace --no-default-features`：`cargo tree --workspace --no-default-features -e normal | grep -c rustyline` 输出 0，`cargo clippy --workspace --no-default-features --all-targets -- -D warnings` 也通过。在 resolver 3 下，`--no-default-features` 对选中的每个包都生效，所以 `-p pebble-cli` 只是更窄的写法，不是必要的写法。

> [!NOTE] feature 是"加法"
> 按 Cargo 的约定，feature 只能加不能减：一个 feature 打开时，它只应该增加功能，不应该让别的代码编译失败。原因是同一个依赖被工作区里的好几个 crate 引用时，Cargo 会取它们要求的 feature 的**并集**，只编译一份。如果 feature 能"减"，某个 crate 开了它，另一个 crate 就会莫名其妙地崩。`repl` 符合这条约定：开了只是多一个子命令。

### `cfg` 还能干什么

`cfg` 的条件不只有 feature。`target_os`、`target_pointer_width`、`debug_assertions`、`test` 都是。`#[cfg(test)] mod tests` 是第 1 篇就写过的。在 `/tmp/rust-lab` 里的 `src/bin/ch15_cfg.rs`：

```rust
#[cfg(target_os = "linux")]
fn platform() -> &'static str {
    "linux"
}

#[cfg(target_os = "windows")]
fn platform() -> &'static str {
    "windows"
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn platform() -> &'static str {
    "something else"
}

fn main() {
    println!("compiled for {}", platform());
    println!("cfg! is an ordinary bool: {}", cfg!(target_os = "linux"));
    println!("debug assertions: {}", cfg!(debug_assertions));
    println!("pointer width: {}", if cfg!(target_pointer_width = "64") { 64 } else { 32 });
}
```

```text
$ cargo run --quiet --bin ch15_cfg
compiled for linux
cfg! is an ordinary bool: true
debug assertions: true
pointer width: 64
```

同一个名字有三个定义，每次编译只留一个。`#[cfg(...)]` 是"这个条目存不存在"；`cfg!(...)` 是一个宏，展开成 `true` 或 `false`，两个分支的代码都要通过类型检查，所以它不能用来藏平台相关的 API。`ch15_cfg_missing.rs` 调用一个只在 Windows 上存在的函数：

```text
$ cargo build --bin ch15_cfg_missing
error[E0425]: cannot find function `only_on_windows` in this scope
 --> src/bin/ch15_cfg_missing.rs:7:20
  |
7 |     println!("{}", only_on_windows());
  |                    ^^^^^^^^^^^^^^^ not found in this scope
  |
note: found an item that was configured out
 --> src/bin/ch15_cfg_missing.rs:2:4
  |
1 | #[cfg(target_os = "windows")]
  |       --------------------- the item is gated behind the `windows` feature
2 | fn only_on_windows() -> &'static str {
  |    ^^^^^^^^^^^^^^^
```

(注意倒数第三行说 "`windows` feature"，其实是 `target_os`，这是 rustc 1.95.0 这一条提示的措辞不精确，不影响你读懂它。) Pebble 自己没有平台相关的代码，`pebble-sys` 里的 C 用 `cc` 编，在 Linux 和 macOS 上都通过（CI 的 `test` 任务在这两个系统上各跑一遍，下面会读到）。所以这一节是一个"T"：实验里编过，仓库里没用。

## 测试：三种，各管一摊

整个系列写了这么多测试，我一直没有正式区分过它们。Cargo 认三种，位置不同，能力不同。在 `/tmp/lab-ch15-tests` 里放一个最小的 crate：`src/lib.rs` 有一个公开函数 `bump`、一个私有函数 `secret`、一个单元测试模块，`bump` 的文档注释里有一个示例；`tests/api.rs` 是一个集成测试。

```rust
/// Adds one.
///
/// ```
/// assert_eq!(lab_ch15_tests::bump(1), 2);
/// ```
pub fn bump(x: u32) -> u32 {
    secret(x) + 1
}

fn secret(x: u32) -> u32 {
    x
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_tests_see_private_items() {
        assert_eq!(secret(5), 5);
    }
}
```

```text
$ cargo test
     Running unittests src/lib.rs (target/debug/deps/lab_ch15_tests-70139acc84a05109)
test tests::unit_tests_see_private_items ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running tests/api.rs (target/debug/deps/api-1b9b8190a9ce54a6)
test integration_tests_use_the_public_api ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
   Doc-tests lab_ch15_tests
test src/lib.rs - bump (line 3) ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

三个"Running"，三个不同的程序：

- **单元测试**：写在被测代码同一个文件的 `#[cfg(test)] mod tests` 里，用 `use super::*` 进入同一个模块，所以能看见私有函数。它们被编进 crate 自己的测试二进制。Pebble 里的绝大多数测试（span、lexer、parser、value、interp、vm……）是这种。
- **集成测试**：`tests/` 目录下每个文件是一个独立的 crate，它像外部用户一样只能用公开 API。`tests/api.rs` 里写 `use lab_ch15_tests::secret;`：

```text
$ cargo test --test private
error[E0603]: function `secret` is private
  --> tests/private.rs:1:21
   |
 1 | use lab_ch15_tests::secret;
   |                     ^^^^^^ private function
   |
note: the function `secret` is defined here
  --> src/lib.rs:10:1
   |
10 | fn secret(x: u32) -> u32 {
   | ^^^^^^^^^^^^^^^^^^^^^^^^
```

  Pebble 的集成测试是 `pebble-cli/tests/cli.rs`（用 `assert_cmd` 运行真的二进制）和 `pebble-bench/tests/differential.rs`（用 `#[differential]` 对比两个后端）。
- **文档测试**：文档注释里围栏代码块是一个会被编译和运行的程序，它同样只能用公开 API，而且每个示例是单独编译的一个 crate。它保证的是"文档里写的例子是真的能跑的"。

文档测试坏掉时是这样的（我把 `2` 改成了 `3`）：

```text
$ cargo test --doc
---- src/lib.rs - bump (line 3) stdout ----
Test executable failed (exit status: 101).

stderr:

thread 'main' (398174) panicked at /tmp/rustdoctestSdCLK2/doctest_bundle_2024.rs:6:1:
assertion `left == right` failed
  left: 2
 right: 3
...
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

Pebble 里有 4 个 crate 带文档测试：`pebble-bytecode`（第 10 篇的 `chunk!`，真实输出 `test crates/pebble-bytecode/src/lib.rs - chunk (line 353) ... ok`）、`pebble-gc`、`pebble-nostd` 各 1 个，`pebble-sys` 2 个。`pebble-macros` 里有 3 个示例，标成了 ` ```ignore `，因为过程宏 crate 没法在自己的文档测试里用自己：它们的真正测试是 `pebble-ast`、`pebble-bytecode` 和 `pebble-bench` 的用法。

### 全部加起来

在 `/tmp/pebble-rebuild-15` 里，`cargo test --workspace --all-features` 的真实结果（单元测试加集成测试，文档测试单列）：

| crate | 测试数 | crate | 测试数 |
| --- | --- | --- | --- |
| `pebble-span` | 6 | `pebble-gc` | 13 |
| `pebble-diag` | 4 | `pebble-vm` | 14 |
| `pebble-lexer` | 12 | `pebble-sys` | 15 |
| `pebble-ast` | 4 | `pebble-nostd` | 10 |
| `pebble-macros` | 0 | `pebble-net` | 9 |
| `pebble-parser` | 13 | `pebble-cli` | 3 单元 + 12 集成 |
| `pebble-value` | 11 | `pebble-bench` | 2 单元 + 5 差分 |
| `pebble-interp` | 16 | `pebble-bytecode` | 14 |

加起来 163 个；文档测试 5 个通过、3 个 `ignore`。我没有手算，是把 33 行 `test result` 的 `passed` 列用 `awk` 加了一遍：

```text
$ cargo test --workspace --all-features 2>&1 | grep "test result" | awk '{p+=$4; i+=$8} END{print p, i}'
168 3
```

168 个通过，3 个被忽略，0 个失败。几个值得一提的细节：

- 带 `#[should_panic]` 的测试有四个（`pebble-span`、`pebble-gc` 两个、`pebble-sys`）。它们证明的是"这个调用必须 panic，而且消息里含有这个字符串"。
- 带 `#[tokio::test]` 的是 `pebble-net` 里的四个（第 14 篇）。
- `pebble-bench` 的 Criterion 基准（第 12 篇）不在这次 `cargo test` 里：`cargo test` 的 `Running` 列表里没有 `backends`，要用 `cargo bench -p pebble-bench` 另外跑。
- 差分测试（五个）在 `Running tests/differential.rs` 下，名字都是 `*_backends_agree`：

```text
$ cargo test -p pebble-bench --test differential
test closures_keep_private_state_backends_agree ... ok
test lists_are_shared_by_reference_backends_agree ... ok
test strings_and_negative_indexing_backends_agree ... ok
test loops_with_break_and_continue_backends_agree ... ok
test recursion_and_arithmetic_backends_agree ... ok
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
```

第六个差分程序是被删掉的那个，原因在第 12 篇里。

最后一个需要说清的：这些数字都只是"代码被执行过且断言没有失败"。168 个测试不是正确性的证明，是一道下限。第 10 篇里我故意弄坏编译器，看测试漏掉了什么，这个习惯值得留下来。

## 文档：`///`、`//!` 和 rustdoc

`///` 给后面那一项写文档，`//!` 给包含它的那一项写文档（文件开头的 `//!` 是整个 crate 的）。内容是 Markdown。仓库的规则（`CONTRIBUTING.md`）是每个公开条目都有 `///`。在 Markdown 里用 `[`Type`]` 这种写法的叫 **intra-doc link**：rustdoc 会按 Rust 的名字解析规则找 `Type`，生成指向它的链接。这个机制带来一个好处，也带来一个麻烦：它会检查。

`cargo doc --workspace --no-deps` 生成 HTML，`--no-deps` 表示不为依赖生成。`RUSTDOCFLAGS="-D warnings"` 让 rustdoc 的警告变成错误，CI 里正是这么写的。我在 tag 之前那个提交（`ab20d9f` 的父提交）的工作树里跑了它，加上 `--keep-going` 让它把所有失败的 crate 报全：

```text
$ RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps --all-features --keep-going
error: unresolved link to `cc`
 --> crates/pebble-sys/src/lib.rs:3:74
error: could not document `pebble-sys`
error: unresolved link to `pebble_vm`
  --> crates/pebble-value/src/lib.rs:17:51
error: public documentation for `pebble_parser` links to private item `Parser::synchronize`
  --> crates/pebble-parser/src/lib.rs:11:50
error: could not document `pebble-value`
error: could not document `pebble-parser`
```

(这里我只保留了 `error` 和位置行。) 三个 crate，三个错误，三种原因。逐个看完整的：

```text
error: unresolved link to `pebble_vm`
  --> crates/pebble-value/src/lib.rs:17:51
   |
17 | //!   exactly the problem the garbage-collected [`pebble_vm`] backend solves.
   |                                                   ^^^^^^^^^ no item named `pebble_vm` in scope
   |
   = help: to escape `[` and `]` characters, add '\' before them like `\[` or `\]`
   = note: `-D rustdoc::broken-intra-doc-links` implied by `-D warnings`
```

`pebble-value` 不依赖 `pebble-vm`（依赖方向反过来，第 12 篇），所以在 `pebble-value` 里没有叫 `pebble_vm` 的东西可以链接。`cc` 那一个同理：它是 `pebble-sys/build.rs` 的构建依赖，不在 crate 本身的作用域里。第三个更微妙：

```text
error: public documentation for `pebble_parser` links to private item `Parser::synchronize`
  --> crates/pebble-parser/src/lib.rs:11:50
   |
11 | //! * It **recovers**. When a statement fails, [`Parser::synchronize`] skips to
   |                                                  ^^^^^^^^^^^^^^^^^^^ this item is private
   |
   = note: this link will resolve properly if you pass `--document-private-items`
   = note: `-D rustdoc::private-intra-doc-links` implied by `-D warnings`
```

`synchronize` 是 `Parser` 的私有方法：公开文档里不该链接到一个读者点不进去的页面。三个都被我改成了普通反引号（`` `Parser::synchronize` ``）。这三处修改就是 tag 前一个提交 `docs: describe the tutorial additions` 里的三行改动，`CHANGELOG.md` 的 `Fixed` 一栏写着它："Intra-doc links that made `cargo doc` fail with `-D warnings`"。tag 上的结果：

```text
$ RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps --all-features
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.22s
   Generated /tmp/pebble-rebuild-15/target/doc/pebble_ast/index.html and 15 other files
```

教训很普通：**一条没有被跑过的检查，等于不存在**。CI 里写着这一条命令，但在我动手验证之前，我自己没有在本地跑过它。

## Lint 与风格：把争论交给机器

### 工作区里的 lint 配置

根 `Cargo.toml` 里的三段：

```toml
[workspace.lints.rust]
rust_2018_idioms = "warn"
unsafe_op_in_unsafe_fn = "warn"

[workspace.lints.clippy]
all = "warn"
```

每个 crate 的 `Cargo.toml` 底部有 `[lints] workspace = true`（第 1 篇里的写法），继承它们。`rust_2018_idioms` 是一组"别用旧习惯"的 lint；`unsafe_op_in_unsafe_fn` 要求 `unsafe fn` 里面的不安全操作也要用 `unsafe {}` 框起来（第 11、13 篇）；`clippy::all` 是 clippy 的默认一大组。它们只是**警告**，是 CI 里的 `-D warnings` 把警告变成错误：

```text
$ cargo clippy --workspace --all-targets --all-features -- -D warnings
    Checking pebble-net v0.1.0 (/tmp/pebble-rebuild-15/crates/pebble-net)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 8.00s
```

警告在本地开发时不阻碍你运行代码，CI 里不允许任何一条留下来，这是一种分工：本地可以带着警告试验，合并不行。

### 什么时候可以说"我知道，闭嘴"

`#[allow(...)]` 是对一条 lint 的豁免，它能放在三个粒度上，Pebble 三个都用了：

- 整个 crate：`pebble-value` 和 `pebble-interp` 的开头都有 `#![allow(clippy::mutable_key_type)]`，旁边附四行注释解释为什么键的哈希是稳定的（第 8 篇里 clippy 抗议的故事：对着一个 `RefCell` 里有计数器的键类型，规则本身是对的，只是这里的哈希按指针地址算）。
- 一个测试函数：`pebble-sys` 里的 `fold_empty_range_returns_init` 上有 `#[allow(clippy::reversed_empty_ranges)]`，因为 `5..=4` 在那里是故意写的空区间。
- 没有放在更宽的地方：我在第 8 篇试过，把 `allow` 删掉后，库代码没有意见，只有 `--all-targets` 时测试里的 `HashMap::new()` 触发它，所以更窄的写法是把它只放在测试函数上；tag 选择的是 crate 级一次关掉，我觉得两种都说得过去。

规矩只有一条：**每一个 `allow` 旁边必须有一句话说明为什么。** 没有注释的 `allow` 是在把噪音藏进地毯下面。

### 把"不安全"限制在能看见的地方

`#![forbid(unsafe_code)]` 比 `deny` 更强：不能被内层的 `#[allow]` 覆盖。`grep -rn "forbid(unsafe_code)" crates` 在 tag 里命中 `pebble-span`、`diag`、`lexer`、`ast`、`parser`、`value`、`interp`、`bytecode`、`vm`、`bench`、`net` 和 `cli`；没有它的是 `pebble-gc`（有 `bump.rs` 里的 `unsafe`，第 11 篇）、`pebble-sys` 和 `pebble-nostd`（第 13 篇），还有 `pebble-macros`（它里面没有 `unsafe` 这个词，只是没写这一行）。也就是说，在 16 个 crate 里，需要人来为内存安全签字的代码只可能出现在三个 crate 里，而且 `grep unsafe` 就能把它们全部找出来。我觉得这是 Rust 里最被低估的一条工程性质：安全性的"审计范围"是机器可计算的。

### `#[must_use]`

```text
$ grep -rn "must_use" crates --include=*.rs | wc -l
111
```

111 行。`#[must_use]` 放在一个函数或类型上，调用者丢掉返回值会得到警告。`Span::merge` 返回新的 `Span`，如果你写了 `a.merge(b);` 然后什么都不用，这几乎一定是个 bug（它不修改 `a`），编译器会告诉你。`Result` 本身就是 `#[must_use]` 的，这是为什么忘了处理错误会被警告。

### 配置文件一览

这些全是仓库根目录下的小文件。我把它们按读到的内容列出来：

```toml
# rust-toolchain.toml
[toolchain]
channel = "stable"
components = ["rustfmt", "clippy"]
profile = "minimal"
```

`rustup` 进入这个目录时会自动选 `stable` 通道并保证装了 `rustfmt` 和 `clippy`；`profile = "minimal"` 不装文档和其他组件。注意它**没有**钉死一个具体版本：版本由别的东西钉。

```toml
# rustfmt.toml
edition = "2024"
max_width = 100
use_field_init_shorthand = true
use_try_shorthand = true
```

```toml
# clippy.toml
msrv = "1.88"
```

`msrv` 告诉 clippy "这个项目声称最低支持 1.88"，它就不会推荐只在更新的版本才有的写法。根 `Cargo.toml` 里的 `rust-version = "1.88"` 是同一个声明，Cargo 用它拒绝在更旧的编译器上构建；第 10 篇的 let 链就是 1.88 才稳定的。（诚实说明：我没有装 1.88 去验证这个声明，我手里只有 1.95.0。）

`flake.nix` 是 Nix 用户的开发环境，也就是我在第 1 篇里让你 `nix develop` 的那个。tag 里的内容是：

```nix
inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
...
packages = with pkgs; [ rustc cargo rust-analyzer clippy rustfmt gdb hyperfine pkg-config zlib ];
```

`flake.lock` 把 `nixpkgs` 钉在一个具体的提交上，所以所有人的 `rustc` 是同一个。这就是上面说的"版本由别的东西钉"：`rust-toolchain.toml` 管通道，Nix 的锁文件管版本。`.envrc` 里只有一行 `use flake`，配合 `direnv` 进入目录自动进环境，目录里还有 `.editorconfig`（缩进、行尾，所有编辑器通用）。

`Cargo.lock` 提交在仓库里，里面 143 个包的精确版本和校验和（`grep -c '^name = ' Cargo.lock` 是 143，包括我们自己的 16 个 crate）。Cargo 对"库"和"应用"的建议不同：库不提交锁文件，因为使用者会自己解析；有二进制的工作区应该提交，让每次构建拿到一样的依赖。Pebble 有一个二进制，所以提交。`dependabot.yml` 每周自己提一个 PR 来更新它。

### 发布 profile

```toml
[profile.release]
lto = "thin"
codegen-units = 1

[profile.bench]
inherits = "release"
```

`lto = "thin"` 是链接期优化，允许跨 crate 内联（Pebble 有 16 个 crate，解释器的热点在 `pebble-value` 和 `pebble-vm` 之间）；`codegen-units = 1` 让编译器把整个 crate 当成一个编译单元，牺牲编译速度换一点运行速度；`bench` profile 继承 `release`，保证 Criterion 测的是发布构建。我没有单独测过这两个设置各自的收益，所以不给数字。

### 两个小债

**`#[inline]`。** Pebble 里没有写 `#[inline]`，我也没有测过它对 Pebble 有没有帮助。它是一个"建议"：对一个小函数，提示编译器可以内联。在同一个 crate 里，编译器自己会决定；跨 crate 时，一个非泛型函数默认**只有机器码，没有可内联的函数体**，`#[inline]` 让函数体也被导出，使别的 crate 可以内联它（泛型函数天生就导出函数体，因为要单态化，第 5 篇）。`src/bin/ch15_inline.rs` 里有三种写法，它们能编译、能运行，我只能保证这么多：

```text
$ cargo run --quiet --bin ch15_inline
38 2654435768 608876246
```

`#[inline(always)]` 和 `#[inline(never)]` 是更强的版本。这一类属性我的原则是：不测量就不加。

**解引用强制转换。** 第 7 篇里 `Source::load(&args.file)` 把一个 `&PathBuf` 传给了一个要 `&Path` 的参数，我当时只讲了"`PathBuf` 对应 `&Path`，像 `String` 对应 `&str`"，没有解释这个调用凭什么通过类型检查。答案是 **deref coercion**：当 `T: Deref<Target = U>`，编译器会在需要 `&U` 的地方自动把 `&T` 转成 `&U`，而且可以连续转几步。`src/bin/ch15_deref.rs`：

```rust
fn load(path: &Path) -> usize { path.as_os_str().len() }
fn shout(text: &str) -> String { text.to_uppercase() }
fn total(numbers: &[i64]) -> i64 { numbers.iter().sum() }

fn main() {
    let owned = PathBuf::from("examples/fib.pebble");
    println!("{}", load(&owned));      // &PathBuf where &Path is expected
    let name = String::from("pebble");
    println!("{}", shout(&name));      // &String where &str is expected
    let list = vec![1, 2, 3];
    println!("{}", total(&list));      // &Vec<i64> where &[i64] is expected
    let boxed = Box::new(String::from("boxed"));
    println!("{}", shout(&boxed));     // &Box<String> -> &String -> &str: two steps
}
```

```text
$ cargo run --quiet --bin ch15_deref
19
PEBBLE
6
BOXED
```

(清单里省略了 `use std::path::{Path, PathBuf};` 这一行。) 这就是为什么 Pebble 的函数参数写 `&str`、`&[T]`、`&Path` 而不是 `&String`、`&Vec<T>`、`&PathBuf`：借用版本更通用，调用者拥有的任何一种形态都能传进来。第 5 篇的 `visitor.visit_expr(operand)`，`operand` 是 `&Box<Expr>` 而参数要 `&Expr`，也是同一个机制。它与 C++ 的隐式转换不同：它只做 `Deref` 这一种，不会把一个 `i32` 悄悄变成 `i64`。

## CI：把上面所有东西在每次提交时跑一遍

CI 是 `.github/workflows/ci.yml`，[在 tag 里](https://github.com/bfmhno3/pebble/blob/tutorial-v1/.github/workflows/ci.yml)。我分段读。开头：

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

env:
  CARGO_TERM_COLOR: always
  RUST_BACKTRACE: 1

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

推到 `main`、对 `main` 开 PR、或者手动触发都会跑。`RUST_BACKTRACE: 1` 让 panic 带调用栈，CI 里没人能事后复现，这是少数几行不花钱的保险。`concurrency` 让同一个分支上的新提交取消还在跑的旧任务。

五个任务，互相独立地并行：

```yaml
  fmt:
    name: rustfmt
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt
      - run: cargo fmt --all --check
```

`fmt`：最便宜的检查，不编译。`--check` 不改文件，格式不对就失败。本地验证：`cargo fmt --all --check` 在 `/tmp/pebble-rebuild-15` 退出码 0。

```yaml
  clippy:
    name: clippy
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy
      - uses: Swatinem/rust-cache@v2
      - run: cargo clippy --workspace --all-targets --all-features -- -D warnings
      - run: cargo clippy -p pebble-cli --no-default-features --all-targets -- -D warnings
```

`clippy`：两行。第一行是"全开"，`--all-targets` 把测试、示例、基准也包括在内；第二行就是本篇前面加的"全关"。`Swatinem/rust-cache` 缓存 `target/` 和 `~/.cargo`，省掉每次从零编译 143 个包的时间（我没有量过省多少）。

```yaml
  test:
    name: test (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
    steps:
      - uses: actions/checkout@v5
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
      - run: cargo test --workspace --all-features
      - name: End-to-end smoke
        run: |
          cargo run --quiet -p pebble-cli -- run examples/fib.pebble
          cargo run --quiet -p pebble-cli -- run --vm examples/fib.pebble
```

`test`：一个 `matrix` 在 Linux 和 macOS 上各跑一遍（`fail-fast: false` 表示一个失败不取消另一个，这样你能看到两边的情况）。这也是 `pebble-sys` 的 C 代码在两个系统上都得编译的地方。最后的 "End-to-end smoke" 是真的运行二进制：在本地：

```text
$ cargo run -q -p pebble-cli -- run examples/fib.pebble
6765
$ cargo run -q -p pebble-cli -- run --vm examples/fib.pebble
6765
```

两个后端各一次，都是 `6765`。

```yaml
  build:
    name: build (release)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
      - run: cargo build --workspace --release
      - run: cargo build -p pebble-cli --no-default-features
```

`build`：发布构建（用的是上面那套 `lto = "thin"`），以及"全关"的构建。`cargo test` 编的是 `dev` profile，这个任务是 CI 里唯一编译发布 profile 的地方；我推测它是为了让链接期优化那一步也被检查，但这是我的推测，不是仓库里写明的。

```yaml
  docs:
    name: rustdoc
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
      - run: cargo doc --workspace --no-deps --all-features
        env:
          RUSTDOCFLAGS: -D warnings
```

`docs`：就是前面那个会红的任务。五个任务各管一类事：格式、静态检查、行为、发布构建、文档。

有一点要讲明：`dtolnay/rust-toolchain@stable` 装的是"当前的 stable"，不是 `flake.lock` 钉住的版本，也不看 `rust-toolchain.toml`。CI 和我的开发环境可以因此而用不同的 `rustc` 小版本。我觉得对一个学习项目这是合理的折中（CI 在新的 stable 上提前发现新的 clippy 警告），但你要知道有这个缝。

另外两个文件：`.github/dependabot.yml` 每周为 Cargo 依赖和 GitHub Actions 版本各开 PR（`chore(deps)`、`chore(ci)` 前缀）；`.github/PULL_REQUEST_TEMPLATE.md` 里有一份和 CI 对应的勾选清单，其中有"如果改了语言，两个后端必须一致并且有测试证明"，这一条正是第 12 篇的差分测试存在的原因。

## 检查点

最后一次对比。我在 `/tmp/pebble-rebuild-15` 里：先用 `git archive tutorial-v1` 解开整个 tag（这样 `.github/`、`docs/`、`README.md`、`CHANGELOG.md`、`LICENSE-*` 这些我们没写的东西就是复制来的），然后把 `crates/pebble-cli` 换成第 14 篇结束时的第五版，再按上一节的五步一路改回去。结束后，对着另一份干净解开的 tag 做递归对比：

```text
$ diff -rq /tmp/tagcmp /tmp/pebble-rebuild-15 --exclude=target
$ echo $?
0
```

没有任何输出，退出码 0：除了 `target/` 以外，没有一个文件有差别（包括 `Cargo.lock`：重新构建没有改它）。然后是行为：

```text
$ cargo fmt --all --check                                                     # exit 0
$ cargo clippy --workspace --all-targets --all-features -- -D warnings        # exit 0
$ cargo clippy -p pebble-cli --no-default-features --all-targets -- -D warnings   # exit 0
$ cargo build -p pebble-cli --no-default-features                             # Finished
$ RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps --all-features   # Finished
$ cargo test --workspace --all-features                                       # 168 passed, 3 ignored
```

另外验证一下第 14 篇加的 `check`：

```text
$ cargo run -q -p pebble-cli -- check examples/fib.pebble examples/errors.pebble examples/hello.pebble
error[E1001]: expected an expression, found `;`
 --> examples/errors.pebble:5:17
  |
5 | let total = 1 + ;
  |                 ^
  |
$ echo $?
1
```

只有坏文件出了声，退出码 1。（用 `--no-default-features` 的二进制跑同一个 `run examples/fib.pebble` 也是 `6765`。）

**这一篇之后，必须与 tag 相同的文件：**整个工作区。这里面列最后一批：

- [`crates/pebble-cli/Cargo.toml`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-cli/Cargo.toml)
- [`crates/pebble-cli/src/cli.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-cli/src/cli.rs)
- [`crates/pebble-cli/src/main.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-cli/src/main.rs)

其余的文件（`.github/`、`docs/`、`README.md`、`CHANGELOG.md`、两份许可证、`flake.nix` 等）是从 tag 复制的，没有中间版本。

## 练习

**1.** 给命令行加一对测试，让 feature 开关本身受到测试：开 `repl` 时 `pebble repl --help` 成功，关掉时 `pebble repl` 退出码是 2。（提示：`#[cfg(feature = "repl")]` 能不能用在集成测试文件里？）

<details>
<summary>参考答案</summary>

能。Cargo 对一个包的每个目标（库、二进制、测试）传同一组 `--cfg feature="..."`，所以 `tests/cli.rs` 里也能写：

```rust
#[cfg(feature = "repl")]
#[test]
fn the_repl_subcommand_exists_when_the_feature_is_on() {
    pebble().args(["repl", "--help"]).assert().success();
}

#[cfg(not(feature = "repl"))]
#[test]
fn the_repl_subcommand_is_gone_when_the_feature_is_off() {
    pebble().arg("repl").assert().code(2);
}
```

我在 tag 的一份临时副本里加了这两个测试：

```text
$ cargo test -p pebble-cli
test repl::tests::unknown_commands_are_rejected ... ok
test repl::tests::arguments_are_kept_whole ... ok
test repl::tests::quit_has_a_short_form ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test the_repl_subcommand_exists_when_the_feature_is_on ... ok
test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.09s
$ cargo test -p pebble-cli --no-default-features
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test the_repl_subcommand_is_gone_when_the_feature_is_off ... ok
test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.09s
```

两种配置各有一个测试被编译进来，总数都是 13。（副本在 `/tmp/ch15-ex`，没有改 `/tmp/pebble-rebuild-15`，所以上面的"逐字节一致"仍然成立。）

</details>

**2.** 在 `crates/pebble-value/src/lib.rs` 的文档里把 `` `pebble_vm` `` 改回 `` [`pebble_vm`] ``，不运行任何命令，预测 `cargo test -p pebble-value` 会不会失败，`cargo doc -p pebble-value --no-deps` 呢？加上 `RUSTDOCFLAGS="-D warnings"` 呢？

<details>
<summary>参考答案</summary>

`cargo test` 不会失败：文档测试只编译和运行围栏代码块，不解析 intra-doc 链接。`cargo doc` 不带 `-D warnings` 会成功，但打印一条警告（`unresolved link to pebble_vm`），生成的 HTML 里那个链接是死的。只有带 `-D warnings` 的 `cargo doc` 才失败，错误就是上一节里的那条，指向 `crates/pebble-value/src/lib.rs:17:51`。这个差别正是 CI 里 `docs` 任务单独存在、并且单独设置 `RUSTDOCFLAGS` 的原因：别的任务都不会碰它。

</details>

**3.** 讨论：CI 的 `build` 任务用 `cargo build -p pebble-cli --no-default-features`，如果换成 `cargo build --workspace --no-default-features`，会少检查什么、多检查什么？

<details>
<summary>参考答案</summary>

我在 `/tmp/pebble-rebuild-15` 里试了：`cargo tree --workspace --no-default-features -e normal | grep -c rustyline` 输出 0（对比 `cargo tree --workspace -e normal` 是 1），`cargo clippy --workspace --no-default-features --all-targets -- -D warnings` 也通过。所以在这个工作区里两个写法对 `pebble-cli` 的检查是一样的：resolver 3 下 `--no-default-features` 对每个选中的包生效。差别在于其他 crate：它们没有任何 `[features]`，所以对它们来说这个开关是空操作。要点是：现在 `-p pebble-cli` 和 `--workspace` 等价，只是因为其他 crate 还没有自己的 feature；等哪一天 `pebble-net` 也有了可选的 feature，`--workspace --no-default-features` 才会自动覆盖它，而 `-p pebble-cli` 不会。这是我的推断，没有试验过那种情况。

</details>

## Rust 特性索引

下面是整个系列涉及的 Rust 特性，每一行指向讲它的那一篇。"形式"一栏：**P** 是写进 Pebble 的真实代码，**L** 是实验室里编译、运行、有真实输出的实验，**T** 是带一小段编译过的代码的文字讲解。我在写这一张表之前，把前 14 篇里每一个被引用的名字都搜了一遍确认它们在文中确实出现（这是机械检查，不代表讲得够透；表里个别写了"只点到"的就是这种）。

| 特性 | 篇 | 形式 |
| --- | --- | --- |
| `cargo`、workspace、package / crate / module、`println!` | [第 1 篇](/posts/rust-by-pebble-01-first-crate/) | P/L |
| `let`、`mut`、遮蔽、整数类型与 `as`、溢出、表达式与语句、控制流、带标签的 `break`、`loop` 的值 | [第 1 篇](/posts/rust-by-pebble-01-first-crate/) | L |
| `struct`、元组结构体（newtype）、`impl`、方法、关联函数与常量、`const fn`、`derive`、`#[must_use]`、单元测试 | [第 1 篇](/posts/rust-by-pebble-01-first-crate/) | P |
| `String`/`&str`、移动、`Copy`/`Clone`、借用与 NLL、切片、`Vec`、`Option`、`?` 用在 `Option` 上、闭包初见、UTF-8 | [第 2 篇](/posts/rust-by-pebble-02-ownership/) | P/L |
| `mem::take`/`replace`/`swap` | [第 2 篇](/posts/rust-by-pebble-02-ownership/) | L |
| `Index` 运算符重载与其他 `std::ops` | [第 2 篇](/posts/rust-by-pebble-02-ownership/) | P/L |
| trait 初见、`Default`、`impl Into<_>` 参数、`no_std` / `alloc` / `core` | [第 2 篇](/posts/rust-by-pebble-02-ownership/) | P |
| 带数据的 `enum`、穷尽 `match`、`if let`、`let else`、builder、结构体更新语法 | [第 3 篇](/posts/rust-by-pebble-03-enums-traits-diagnostics/) | P/L |
| `Display`/`Debug`/`Error`、supertrait、默认方法、孤儿规则、单元结构体、类型别名、blanket impl | [第 3 篇](/posts/rust-by-pebble-03-enums-traits-diagnostics/) | P/L/T |
| 格式化小语言、`fmt::Write` 与 `io::Write` | [第 3 篇](/posts/rust-by-pebble-03-enums-traits-diagnostics/) | P/L |
| 生命周期、省略规则、`'static`、`Cow`、实现 `Iterator`（关联类型）、match 守卫、范围与或模式、`while let`、turbofish | [第 4 篇](/posts/rust-by-pebble-04-lifetimes-lexer/) | P/L |
| 高阶生命周期约束（HRTB）与型变 | [第 4 篇](/posts/rust-by-pebble-04-lifetimes-lexer/)、[第 8 篇](/posts/rust-by-pebble-08-rc-refcell-values/) | T |
| 递归 `enum` 与 `Box`、泛型、trait 约束、`where`、`?Sized`、单态化、`IntoIterator`、`pub use` | [第 5 篇](/posts/rust-by-pebble-05-ast-generics/) | P/L |
| 过程宏（derive）、`syn` / `quote`、卫生性 | [第 6 篇](/posts/rust-by-pebble-06-proc-macros/) | P/L |
| `Result`、`?`、`panic!` / `unwrap` / `expect`、`todo!`、`matches!`、`mem::discriminant`、两阶段借用 | [第 7 篇](/posts/rust-by-pebble-07-parser-errors-cli/) | P/L |
| `clap`、`anyhow`、`fs`、`ExitCode`、文件模块、`pub(crate)`、`use crate::`、集成测试 | [第 7 篇](/posts/rust-by-pebble-07-parser-errors-cli/) | P/T |
| 解引用强制转换（`&PathBuf` 变 `&Path`） | [第 15 篇](/posts/rust-by-pebble-15-engineering/)（第 7 篇只是用了它） | L |
| `Rc`、`Rc<str>`、`RefCell`、`HashMap`、`Hash`/`Eq` 契约、手写 `PartialEq`、`PartialOrd` 契约、`From` | [第 8 篇](/posts/rust-by-pebble-08-rc-refcell-values/) | P/L |
| 函数指针与闭包、trait 对象与 vtable、`static`、切片模式、`-> impl Trait`、`Borrow`/`AsRef`、`TryFrom`/`FromStr` | [第 8 篇](/posts/rust-by-pebble-08-rc-refcell-values/) | P/L/T |
| `Fn`/`FnMut`/`FnOnce`、`move` 闭包、`Weak`、`thread::Builder`、把 `collect` 收进 `Result`、实现 `FromStr` | [第 9 篇](/posts/rust-by-pebble-09-interpreter-closures/) | P/L |
| `macro_rules!`、函数式过程宏、`HashMap` 的 entry、闭包的分字段捕获、let 链、`ref` 模式、文档测试 | [第 10 篇](/posts/rust-by-pebble-10-bytecode-macros/) | P/L |
| 泛型结构体、`dyn FnMut`、`Cell`、`Option::take`、外部 crate、`BTreeSet`/`VecDeque`/`HashSet`、`unsafe`、`MaybeUninit`、裸指针 | [第 11 篇](/posts/rust-by-pebble-11-gc-unsafe/) | P/L/T |
| 关联常量、GAT、静态与动态分发、对象安全、属性过程宏、Criterion | [第 12 篇](/posts/rust-by-pebble-12-vm-backends/) | P/L |
| FFI、`build.rs`、`repr(C)`、`NonNull`、`Drop`、自动 trait、`PhantomData`、`catch_unwind`、`Any` | [第 13 篇](/posts/rust-by-pebble-13-ffi-nostd/) | P |
| `no_mangle` 与 `cdylib`、`repr(transparent)`、`repr(u8)`、`union`、`ManuallyDrop`、`static mut` | [第 13 篇](/posts/rust-by-pebble-13-ffi-nostd/) | T |
| `no_std`、`UnsafeCell`、原子操作、`unsafe impl Sync`、`GlobalAlloc`、常量泛型、`#[global_allocator]` | [第 13 篇](/posts/rust-by-pebble-13-ffi-nostd/) | P |
| 线程、`thread::scope`、`Send`/`Sync`、`Arc`、`Mutex`、`mpsc` | [第 14 篇](/posts/rust-by-pebble-14-concurrency-async/) | P/L |
| `RwLock`（只点到，一个小实验） | [第 14 篇](/posts/rust-by-pebble-14-concurrency-async/) | T |
| `Future`、`Pin`、`Waker`、`async`/`await`、Tokio、`select!`、`spawn_blocking`、`Error::source`、`#[non_exhaustive]`、`thiserror`（对比） | [第 14 篇](/posts/rust-by-pebble-14-concurrency-async/) | P/L/T |
| Cargo feature、`cfg`、测试的三种形态、rustdoc、lint、clippy、rustfmt、工具链文件、发布 profile、CI、`#[inline]` | [第 15 篇](/posts/rust-by-pebble-15-engineering/) | P/T |

## 系列之外

这个系列教的是"能读懂、能写出 Pebble 这个体量的 Rust"。下面这些东西我没有讲，不是因为它们不重要，是因为 Pebble 没有一个诚实的落点：

- `async fn` 在 trait 里、异步流（`Stream`），以及 `Pin` 的"投影"这类更深的 async 机制。
- 特化、`dyn Trait` 的向上转型、`GAT` 的高级用法（我们只用了 `Backend` 里的那一个）。
- Miri、`loom`、`cargo fuzz` 和 sanitizer：第 11 篇提到了 Miri，但我没有跑过它。
- 真的把 `no_std` 放到一块板子上跑，以及 `wasm32` 目标。
- 发布到 crates.io、语义化版本的实际管理。
- Stacked Borrows / Tree Borrows 这样的 unsafe 别名模型。

如果你要一个顺序，我会选 Rustonomicon 配着第 11、13 篇读，然后是 Tokio 的教程配着第 14 篇。

## 然后呢

我写这个系列的起点是一个很具体的不满：C++ 程序员读 Rust 的书，读完还是写不出东西，因为每一章的例子都是玩具。Pebble 不是玩具，也不算大：10515 行 Rust。但它有一个真实的形状：前端、两个后端、一个 GC、一个 FFI 边界、一个网络服务，以及让它们保持正确的那层工程外壳。每个"为什么"后面都能找到一个可运行的东西。

我最想知道的是，如果你从空目录做到了这里，第 17 个 crate 会长什么样。Pebble 现在是动态类型的；给它加一个类型检查器，大概需要一个新的 AST 标注和一个新的 `Visit`，我猜还需要一个比 `Value` 更严格的类型层。解释器和 VM 的差分测试已经是一个粗糙的"两个独立实现互相验证"的模型，同一个思路也许能抓住第 12 篇里那两个真实的分歧（块级 `let`、列表里字符串的引号）。字节码如果有一个验证器，GC 的根集合也许能比"指令边界"定义得更精细。我不知道哪个该先做。但有一件事我很确定：你会先写出一个编译不过的版本，然后编译器会指给你看是哪一行。这是我学 Rust 学到的最大的东西，比任何单个特性都大。

去给 Pebble 写第 17 个 crate 吧，别回来查这个系列。
