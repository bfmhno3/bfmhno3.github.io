---
title: "过程宏：让编译器替我写 impl Spanned"
commentId: "post:rust-by-pebble-06-proc-macros"
published: "2026-10-13 13:00:00 +08:00"
description: "上一篇我们手写了三个一模一样的 impl Spanned。这一篇写一个 derive 过程宏，让编译器在编译时替我们生成它：从 TokenStream、syn 与 quote 讲起，撞上泛型、引用绑定、卫生性和自定义编译错误，最后删掉三段手写代码，测试一个字不改。"
category: Note
tags:
  - Rust
  - Pebble
  - 宏
  - 过程宏
series: "用 Pebble 从零学 Rust"
seriesOrder: 6
draft: false
comment: true
slug: rust-by-pebble-06-proc-macros
---

上一篇结尾我们手写了三个 `impl Spanned`，一共 44 行，每个分支都在做同一件事：把叫 `span` 的字段取出来。我给 `Stmt` 加一个变体，编译器老老实实指出三处要改，其中一处纯属体力活。C++ 程序员遇到这种事有两条路：写一个宏，或者让代码生成器生成。Rust 给了第三条路：写一个**在编译器内部运行的 Rust 函数**，输入是你的类型定义，输出是要补进程序里的代码。这一篇我们写出这个函数，然后把那 44 行删掉。

> [!NOTE] 本篇检查点
> 你将写出 `pebble-macros` 的**中间版本**（只有 `#[derive(Spanned)]` 这一个宏，约 100 行），然后回到 `pebble-ast`：加一行依赖、一行 `pub use`、三处 `#[derive(.., Spanned)]`，删掉三个手写的 `impl`。做完以后 `pebble-ast` 与仓库逐字节相同，`cargo test -p pebble-ast` 的 4 个测试一个字不改。用到的 Rust 特性：`proc-macro = true` 的 crate、`TokenStream`、`syn`、`quote!`、泛型的 `split_for_impl`、绝对路径与卫生性、`syn::Error`、`collect` 成 `Result`。
> 上一篇是 [递归类型、泛型与 trait：搭一棵 AST](/posts/rust-by-pebble-05-ast-generics/)，这一篇从它的中间版本继续。下一篇是 [Result、? 与递归下降](/posts/rust-by-pebble-07-parser-errors-cli/)。

## 先把痛点原样复现一遍

上一篇的实验我再做一次，这回是在做完本篇之后的 `pebble-ast` 里。往 `Stmt` 末尾加一个带 `span` 的变体：

```rust
    /// `{ .. }`
    Block { body: Vec<Stmt>, span: Span },
```

`cargo build -p pebble-ast`（这是我在工作区的一份拷贝里做的，不是你的主目录）：

```text
   Compiling pebble-ast v0.1.0 (/tmp/scratch-ast06/crates/pebble-ast)
error[E0004]: non-exhaustive patterns: `&Stmt::Block { .. }` not covered
   --> crates/pebble-ast/src/lib.rs:271:11
    |
271 |     match stmt {
    |           ^^^^ pattern `&Stmt::Block { .. }` not covered
...
error[E0004]: non-exhaustive patterns: `&Stmt::Block { .. }` not covered
   --> crates/pebble-ast/src/lib.rs:394:27
    |
...
error: could not compile `pebble-ast` (lib) due to 2 previous errors
```

两处，不是上一篇的三处。`Spanned` 那个 `match` 已经不存在了：剩下的两处是 `walk_stmt` 和打印器，它们需要人来决定"怎样遍历、怎样显示"。上一篇的三处里最没有信息量的那一处，被我们这一篇写的东西接管了。下面从头讲这是怎么做到的。

## 宏有几种

我先给 C 程序员一个参照。C 的 `#define` 是**文本替换**：

```c
#define SPAN_OF(x) ((x).span)
```

预处理器不知道 `x` 是什么，括号加得不对就产生奇怪的结果，也永远不知道 `span` 是不是真的存在。Rust 的宏不一样：它们工作在 **token 树**上，括号永远配对，替换的单位是"一个表达式"而不是"几个字符"。而且 Rust 有四种宏：

| 种类 | 写法 | 谁写、在哪里 | 本系列在哪讲 |
|---|---|---|---|
| 声明宏 | `macro_rules! name { ... }` | 模式匹配 token，同一个 crate 里就能写 | 第 10 篇（`chunk!`） |
| derive 宏 | `#[derive(Name)]` | 过程宏：给一个类型生成额外的 `impl` | 这一篇 |
| 函数式过程宏 | `name!(...)` | 过程宏：输入 token，输出任意 item | 第 10 篇（`opcode_set!`） |
| 属性宏 | `#[name]` | 过程宏：整个 item 进、整个 item 出 | 第 12 篇（`#[differential]`） |

你已经天天在用其中三种了：`println!` 是（声明）宏，`#[derive(Debug)]` 是 derive 宏，`#[test]` 是属性宏。它们没什么神秘的，只是别人写好的 Rust 函数。**过程宏**就是这样一个函数，签名大概是"一串 token 进，一串 token 出"，编译器在展开时调用它。

打个比方：过程宏像 C 工程里的 `protoc` 或 `flex`/`bison`：构建过程中先跑一个程序，它读你的声明，吐出一些源文件，再被编译。区别在于，它不是一个外部命令加一个 Makefile 规则，而是 `cargo build` 自动在编译器**进程内**调用的一个动态库，输入输出是 token，不是文本。

### 为什么必须是单独的 crate

过程宏必须放在一个 `proc-macro = true` 的 crate 里。为什么不能直接写在 `pebble-ast` 里？因为编译 `pebble-ast` 的时候，编译器要**运行**宏：宏得先被编译成可以加载的库。同一个 crate 不可能先于自己编译完成，所以必须拆成两个 crate，先编译宏的那个。

这种 crate 还有一条硬规则。我建了一个 `proc-macro = true` 的 crate（仓库里是 [`lab/lab-ch06-export`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/lab/lab-ch06-export)），里面放了一个普通的 `pub fn helper()`，再加一个 derive：

```rust
use proc_macro::TokenStream;

/// Not a macro: just a helper.
pub fn helper() -> u32 {
    42
}

#[proc_macro_derive(Nothing)]
pub fn derive_nothing(_input: TokenStream) -> TokenStream {
    TokenStream::new()
}
```

```text
   Compiling lab-macros-export v0.1.0 (/tmp/lab-ch06-export)
error: `proc-macro` crate types currently cannot export any items other than functions tagged with `#[proc_macro]`, `#[proc_macro_derive]`, or `#[proc_macro_attribute]`
 --> src/lib.rs:4:1
  |
4 | pub fn helper() -> u32 {
  | ^^^^^^^^^^^^^^^^^^^^^^

error: could not compile `lab-macros-export` (lib) due to 1 previous error
```

一个过程宏 crate 只能导出宏。要共享的辅助函数、类型，必须另起一个普通 crate。（`pebble-macros` 里的辅助函数 `expand_spanned`、`span_member` 没有 `pub`，所以没事。）

第二件事：过程宏 crate 里能用一个特殊的内置 crate，叫 `proc_macro`，里面有 `TokenStream`。这个 crate 只有在编译器里才存在。在普通二进制里用它：

```rust
fn main() {
    let tokens = proc_macro::TokenStream::new();
    println!("{}", tokens.is_empty());
}
```

实验文件 `ch06_proc_macro_outside.rs`：

```text
error[E0433]: cannot find module or crate `proc_macro` in this scope
 --> src/bin/ch06_proc_macro_outside.rs:2:18
  |
2 |     let tokens = proc_macro::TokenStream::new();
  |                  ^^^^^^^^^^ use of unresolved module or unlinked crate `proc_macro`
  |
help: there is a crate or module with a similar name
  |
2 |     let tokens = proc_macro2::TokenStream::new();
  |                            +
```

编译器自己建议的 `proc_macro2` 正是下面要讲的第二种 `TokenStream`。

## 第一个 derive：Hello

我们先不碰 Pebble，在实验室里写一个最小的 derive，只为看清机器怎么转。新建一个实验 crate（你的可以放在 `~/lab-ch06-derive`；完整版在 [`lab/lab-ch06-derive`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/lab/lab-ch06-derive)，不想手敲就 `cd ~/pebble-tag/lab/lab-ch06-derive` 直接用），它自己的 `Cargo.toml`：

```toml
[package]
name = "lab-ch06-derive"
version = "0.1.0"
edition = "2024"

[dependencies]
pebble-span = { path = "../pebble/crates/pebble-span" }
lab-macros-step = { path = "lab-macros-step" }
```

（`pebble-span` 那一行指向你在 `~/pebble` 里的 `pebble-span`；仓库里的版本写的是 `../../crates/pebble-span`，指向 tag 里的 `pebble-span`，别的没区别。）再建 `lab-macros-step/Cargo.toml`：

```toml
[package]
name = "lab-macros-step"
version = "0.1.0"
edition = "2024"

[lib]
proc-macro = true

[dependencies]
proc-macro2 = "1"
quote = "1"
syn = { version = "3", features = ["full"] }
```

`[lib] proc-macro = true` 就是上面说的那个开关。三个依赖：`syn` 把 token 解析成语法树，`quote` 把语法树片段变回 token，`proc-macro2` 稍后解释。然后是 `lab-macros-step/src/lib.rs`：

```rust
use proc_macro::TokenStream;
use quote::quote;
use syn::{DeriveInput, parse_macro_input};

#[proc_macro_derive(Hello)]
pub fn derive_hello(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    let name = &input.ident;
    eprintln!("deriving Hello for {name}");
    quote! {
        impl #name {
            pub fn hello() -> &'static str {
                concat!("hello from ", stringify!(#name))
            }
        }
    }
    .into()
}
```

逐行看：

- `#[proc_macro_derive(Hello)]`：把函数登记为 `#[derive(Hello)]` 背后的宏。函数名随意，括号里的名字才是用户写的名字。
- 参数 `input: TokenStream`：用户给的类型定义，原样的 token。返回值是**要追加**的 item，不是替换（derive 不会改掉原类型）。
- `parse_macro_input!(input as DeriveInput)`：用 `syn` 把 token 解析成 `DeriveInput`，也就是"一个 struct/enum/union 的定义"这个语法树。解析失败的话，它会直接 `return` 一个编译错误，所以宏里不用手写错误处理。
- `quote! { ... }`：写一段 Rust 代码，其中 `#name` 被替换成变量 `name` 里的 token。`#` 是 `quote!` 的插值记号，和 C 的 `#define` 没有关系。
- `.into()`：`quote!` 返回的是 `proc_macro2::TokenStream`，而宏函数要返回 `proc_macro::TokenStream`，`.into()` 在两者之间转换。

使用它，实验文件 `src/bin/ch06_hello.rs`：

```rust
use lab_macros_step::Hello;

#[derive(Hello)]
struct Anything;

fn main() {
    println!("{}", Anything::hello());
}
```

构建，然后**直接运行二进制**：

```text
$ cargo build --bin ch06_hello
   Compiling lab-macros-step v0.1.0 (/tmp/lab-ch06-derive/lab-macros-step)
   Compiling lab-ch06-derive v0.1.0 (/tmp/lab-ch06-derive)
deriving Hello for Anything
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.64s
$ ./target/debug/ch06_hello
hello from Anything
```

注意 `deriving Hello for Anything` 出现在**构建**输出里，运行二进制时没有。那一句 `eprintln!` 是宏函数里的，它在 `rustc` 编译 `ch06_hello.rs` 的时候执行，不在你的程序里。（顺带一个坑：`cargo run` 会把缓存的编译器输出重放一遍，所以用 `cargo run` 时你会在程序输出前再看到这行，像是运行期打印的。我第一次看到的时候就上当了。）这就是过程宏最重要的事实：**宏是在编译时运行的普通 Rust 程序，`eprintln!` 可以用，死循环会卡住编译，`panic!` 会变成编译错误。**

## 宏看到的是什么：只有 token

我们让宏把输入的 token 原样打印出来，看它到底拿到了什么。`lab-macros-step/src/lib.rs` 末尾追加：

```rust
#[proc_macro_derive(Show)]
pub fn derive_show(input: TokenStream) -> TokenStream {
    eprintln!("input tokens: {input}");
    TokenStream::new()
}
```

实验文件 `src/bin/ch06_tokens.rs`：

```rust
use lab_macros_step::Show;
use pebble_span::Span;

#[derive(Show)]
struct Ident {
    name: String,
    span: Span,
}

fn main() {}
```

```text
   Compiling lab-macros-step v0.1.0 (/tmp/lab-ch06-derive/lab-macros-step)
   Compiling lab-ch06-derive v0.1.0 (/tmp/lab-ch06-derive)
input tokens: struct Ident { name: String, span: Span, }
```

这就是宏看到的一切：`struct`、`Ident`、一对大括号和里面的 token。`Span` 对宏而言只是一个叫 `Span` 的标识符，宏**不知道**它是 `pebble_span::Span`，也不知道它是不是 `Copy`。过程宏运行在类型检查**之前**，它看得到语法，看不到语义。这一点后面会咬我们一口，也会成为第三道练习题。

### 为什么有两种 `TokenStream`

刚才的 `.into()` 要回答一个问题：为什么有 `proc_macro::TokenStream` 和 `proc_macro2::TokenStream` 两种？

`proc_macro` 是编译器内置的，只有宏被编译器调用的时候才能用（刚才的 E0433 实验只是最直观的一面：普通 crate 里根本找不到它）。我的理解是，这让依赖它的代码很难测试，也很难在宏之外复用；`syn` 和 `quote` 如果直接依赖它，它们自己就没法写测试了。`proc-macro2` 是一个普通 crate，提供一个同样形状的 `TokenStream`，在宏里和 `proc_macro` 的那个来回转换（`.into()`），在宏外面也能跑。我的实验文件 `ch06_proc_macro2_outside.rs`：

```rust
fn main() {
    let tokens = proc_macro2::TokenStream::new();
    println!("empty = {}", tokens.is_empty());
}
```

```text
empty = true
```

所以约定很简单：入口函数的签名用 `proc_macro::TokenStream`，里面的所有函数都用 `proc_macro2::TokenStream`。你在后面的代码里会看到 `use proc_macro2::TokenStream as TokenStream2;`，`2` 就是这个意思。

## 从 `Hello` 到 `Spanned`：一步一步长大

目标是对这样的类型生成 `impl Spanned`：

```rust
struct Ident { name: String, span: Span }
```

第一版：写死 `self.span`，像 `Hello` 一样。往 `lab-macros-step` 里加：

```rust
#[proc_macro_derive(SpannedStruct)]
pub fn derive_spanned_struct(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    let name = &input.ident;
    quote! {
        impl ::pebble_span::Spanned for #name {
            fn span(&self) -> ::pebble_span::Span {
                self.span
            }
        }
    }
    .into()
}
```

实验文件 `src/bin/ch06_step.rs`：

```rust
use lab_macros_step::{Hello, SpannedStruct};
use pebble_span::{SourceId, Span, Spanned};

#[derive(Hello)]
struct Anything;

#[derive(SpannedStruct)]
struct Ident {
    name: String,
    span: Span,
}

fn main() {
    println!("{}", Anything::hello());
    let ident = Ident { name: "x".to_string(), span: Span::new(SourceId(0), 4, 5) };
    println!("{} at {:?}", ident.name, ident.span());
}
```

```text
hello from Anything
x at 4..5
```

第一版可以工作。（`Span` 的 `Debug` 是手写的，打印成 `起点..终点`，所以是 `4..5`。）

### 第一堵墙：泛型

加一个泛型结构体，再用第一版：

```rust
use lab_macros_step::SpannedStruct;
use pebble_span::Span;

#[derive(SpannedStruct)]
struct Tagged<T> {
    inner: T,
    span: Span,
}

fn main() {}
```

实验文件 `ch06_naive_generic.rs`：

```text
error[E0107]: missing generics for struct `Tagged`
 --> src/bin/ch06_naive_generic.rs:5:8
  |
5 | struct Tagged<T> {
  |        ^^^^^^ expected 1 generic argument
  |
note: struct defined here, with 1 generic parameter: `T`
 --> src/bin/ch06_naive_generic.rs:5:8
  |
5 | struct Tagged<T> {
  |        ^^^^^^ -
help: add missing generic argument
  |
5 | struct Tagged<T><T> {
  |              +++

For more information about this error, try `rustc --explain E0107`.
error: could not compile `lab-ch06-derive` (bin "ch06_naive_generic") due to 1 previous error
```

（编译器的 `help` 在这里是错的，别照做。）宏生成的是 `impl Spanned for Tagged`，而 `Tagged` 不是类型，`Tagged<T>` 才是。一个泛型类型的 `impl` 要把参数一起带上：`impl<T> Spanned for Tagged<T> where ...`。这三段（`impl` 后面的参数列表、类型名后面的参数列表、`where` 子句）`syn` 帮你切好了：

```rust
let (impl_generics, ty_generics, where_clause) = input.generics.split_for_impl();
```

名字很直白："为 impl 切开泛型"。三个值都能直接放进 `quote!`：

```rust
impl #impl_generics ::pebble_span::Spanned for #name #ty_generics #where_clause {
```

我把这个版本写成了 `lab-macros-v2`（只有一个 derive `Spanned`，其余同上），然后跑一个带约束和 `where` 的泛型结构体（`ch06_generic_v2.rs`）。顺带说明：本篇里这类 `lab-macros-*` 变体（`-rel`、`-debug`、`-attr`、`-panic` 等）都是可选的对照实验：把 `lab-macros-step` 复制成同名的新目录，改 `Cargo.toml` 里的包名，把 `lib.rs` 换成该处描述的版本，让实验文件依赖它就行；不照做也不影响后面的内容。它们的完整版都在 [`lab/lab-ch06-derive/`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/lab/lab-ch06-derive) 下（目录清单见检查点末尾的实验清单）：

```rust
#[derive(Spanned)]
struct Tagged<T: Clone>
where
    T: std::fmt::Debug,
{
    inner: T,
    span: Span,
}
```

```text
4..9 at 5 (inner = hello)
```

`T: Clone` 和 `where T: Debug` 都被原样搬进了生成的 `impl`。这是 C++ 模板里需要手写 `template <typename T> requires ...` 的地方，宏帮我们照抄。

### 第二堵墙：enum

`Stmt` 和 `Expr` 是枚举。第二版只认识 `self.span`，用在枚举上：

```rust
#[derive(Spanned)]
enum Expr {
    Int { value: i64, span: Span },
    Nil { span: Span },
}
```

```text
error[E0615]: attempted to take value of method `span` on type `&Expr`
 --> src/bin/ch06_enum_v2.rs:4:10
  |
4 | #[derive(Spanned)]
  |          ^^^^^^^ method, not a field
  |
  = note: this error originates in the derive macro `Spanned` (in Nightly builds, run with -Z macro-backtrace for more info)
```

注意错误指向的是 `#[derive(Spanned)]`：生成的代码里出错，编译器没有别的地方可指。枚举没有 `self.span`，需要一个 `match`，每个变体一个分支，每个分支取出自己的 `span` 字段。这就是手写的那个 `match`，只不过现在由宏循环生成：

```rust
let arms = data.variants.iter().map(|variant| {
    let variant_name = &variant.ident;
    quote!(Self::#variant_name { span, .. } => *span)
});
quote! { match self { #(#arms),* } }
```

新东西是 `#(#arms),*`：`quote!` 的**重复**语法，意思是"对 `arms` 里每个元素展开一次，中间用逗号隔开"，和 `macro_rules!` 的 `$(...),*` 是同一个设计。外面的 `#` 提示"这里是插值"，里面再 `#arms` 取每一项。`arms` 是一个迭代器，`quote!` 直接吃。

仓库的版本多两个细节，我故意各弄坏一次，看错误是什么样。

**为什么是 `* #member`？** 因为 `match self` 的 `self` 是 `&Expr`，分支里绑定出来的 `span` 是 `&Span`（第 5 篇说过的默认绑定模式）。去掉 `*`（实验 `ch06_no_star.rs`）：

```text
error[E0308]: mismatched types
 --> src/bin/ch06_no_star.rs:6:23
  |
4 | #[derive(Spanned)]
  |          ------- expected `Span` because of return type
5 | enum Expr {
6 |     Int { value: i64, span: Span },
  |                       ^^^^ expected `Span`, found `&Span`
  |
help: consider dereferencing the borrow
  |
6 |     Int { value: i64, *span: Span },
  |                       +
```

注意这个错误的位置：它指向用户源码里的 `span: Span`，因为生成的 `span` 标识符继承了字段的位置。宏生成的代码出错时，错误位置像是在用户代码里，这是 `quote!` 用 `#member` 插值时保留 token 位置的结果。`help` 同样是错的（`*span: Span` 不是合法语法），别信它。`Span` 是 `Copy`，`*span` 就是一次按位拷贝。

**为什么分隔符是 `,`？** 去掉 `#(#arms),*` 里的逗号，写成 `#(#arms)*`（实验 `ch06_no_comma.rs`）：

```text
error: expected `,` following `match` arm
 --> src/bin/ch06_no_comma.rs:4:17
  |
4 | #[derive(Spanned)]
  |                 ^
  |
  = note: this error originates in the derive macro `Spanned` (in Nightly builds, run with -Z macro-backtrace for more info)

error: proc-macro derive produced unparsable tokens
 --> src/bin/ch06_no_comma.rs:4:10
  |
4 | #[derive(Spanned)]
  |          ^^^^^^^

error: could not compile `lab-ch06-derive` (bin "ch06_no_comma") due to 2 previous errors
```

`proc-macro derive produced unparsable tokens`：宏吐出来的 token 不是合法 Rust。这类错误在 `macro_rules!` 里也常见，调试办法是把宏的输出打印出来看（下面"看一次展开"一节）。

### 绝对路径：`::pebble_span::Spanned`

生成的代码里我一直写 `::pebble_span::Spanned`，开头有两个冒号。为什么不写 `pebble_span::Spanned` 甚至 `Spanned`？

因为宏生成的 token 会被放进**用户的**源文件，名字在用户的作用域里解析。如果用户的文件里恰好有一个叫 `pebble_span` 的模块呢？我做了这个实验。先看写成相对路径的宏（`lab-macros-rel`，唯一区别是去掉了开头的 `::`），用户代码（`ch06_relative.rs`）是这样：

```rust
use lab_macros_rel::Spanned;

// A local module with the same name as the real crate.
#[allow(dead_code)]
mod pebble_span {
    pub struct Span;
}

#[derive(Spanned)]
struct Ident {
    span: ::pebble_span::Span,
}
```

```text
error[E0405]: cannot find trait `Spanned` in module `pebble_span`
 --> src/bin/ch06_relative.rs:9:10
  |
9 | #[derive(Spanned)]
  |          ^^^^^^^ not found in `pebble_span`
  |
  = note: this error originates in the derive macro `Spanned` (in Nightly builds, run with -Z macro-backtrace for more info)
```

宏生成的 `pebble_span::Spanned` 找到了用户本地的那个模块，而不是外部 crate。把同样的用户代码对着带 `::` 的版本（`lab-macros`，也就是后面要写的最终版）运行（`ch06_shadow.rs`，`main` 里取一次 `span()`）：

```text
1..4
```

开头的 `::` 意思是"从 crate 根（外部 crate 列表）开始找"，不受用户本地名字影响。这是过程宏的基本礼仪：**生成的代码里，所有路径都写绝对路径。** 过程宏默认没有 `macro_rules!` 那种对局部变量的卫生保护（第 10 篇讲），名字全靠这条纪律保护。这不是 Pebble 的发明，标准库的 `#[derive(Debug)]` 展开出来的也是 `::core::fmt::Debug`。

代价是：用 `#[derive(Spanned)]` 的 crate 必须自己依赖 `pebble-span`，宏没法替它引入。我做了一个不依赖 `pebble-span` 的 crate（[`lab/lab-ch06-nodep`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/lab/lab-ch06-nodep)）：

```text
error[E0433]: cannot find `pebble_span` in the crate root
 --> src/main.rs:5:10
  |
5 | #[derive(Spanned)]
  |          ^^^^^^^ could not find `pebble_span` in the list of imported crates
  |
  = note: this error originates in the derive macro `Spanned` (in Nightly builds, run with -Z macro-backtrace for more info)
```

`pebble-ast` 已经依赖 `pebble-span`（它本来就要 `pub use pebble_span::{Span, Spanned}`），所以没有问题。

## 正式写 `pebble-macros`

现在回到你的工作区 `~/pebble`。先建 crate：

```bash
cargo new --lib crates/pebble-macros
```

打开根 `Cargo.toml`，在 `[workspace.dependencies]` 里加四行（`pebble-macros` 放在 `pebble-ast` 下面，另外三个是外部依赖，第一次出现）：

```toml
pebble-macros = { path = "crates/pebble-macros", version = "0.1.0" }

proc-macro2 = "1"
quote = "1"
syn = { version = "3", features = ["full"] }
```

`"1"` 和 `"3"` 是 Cargo 的版本要求：兼容 1.x.y、兼容 3.x.y 的最新版本。具体解析到哪个版本由 `Cargo.lock` 记录。（我这次解析出来的是 `syn v3.0.9`、`proc-macro2 v1.0.107`、`quote v1.0.47`。）`syn` 打开 `full` 特性：解析 `DeriveInput` 用不着它，但第 10、12 篇要解析 `enum` 项和函数项，工作区里干脆一次打开。

然后把 `crates/pebble-macros/Cargo.toml` 整个替换成：

```toml
[package]
name = "pebble-macros"
description = "Procedural macros (derive only, so far) used across the Pebble crates."
version.workspace = true
edition.workspace = true
rust-version.workspace = true
authors.workspace = true
license.workspace = true
repository.workspace = true

[lib]
proc-macro = true

[dependencies]
proc-macro2.workspace = true
quote.workspace = true
syn.workspace = true

[lints]
workspace = true
```

`description` 里的 "so far" 是这个中间版本的特征，仓库版本写的是 "(derive + attribute)"，后面的章节会改。仓库版本还多一个 `[dev-dependencies]`，也是后面才加。

接下来是 `crates/pebble-macros/src/lib.rs`。我一块一块写，最后给出完整文件对照。

### 文件头与入口

```rust
//! Procedural macros for the Pebble toolchain.
//!
//! This crate must be a `proc-macro = true` crate: procedural macros run at
//! compile time, in the compiler's process, and speak in tokens. So far it has
//! one flavour:
//!
//! * [`macro@Spanned`] - a **derive** macro that writes the boring
//!   `impl pebble_span::Spanned` for AST nodes.

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::quote;
use syn::{Data, DeriveInput, Fields, parse_macro_input};
```

`[`macro@Spanned`]` 是文档链接的消歧义写法：这个名字既可能指 trait 也可能指宏，`macro@` 前缀说是宏。（这个名字冲突的问题稍后专门讲。）

入口函数薄薄一层，真正的逻辑放进一个普通函数，签名里用 `TokenStream2`：

```rust
#[proc_macro_derive(Spanned)]
pub fn derive_spanned(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    match expand_spanned(&input) {
        Ok(tokens) => tokens.into(),
        Err(error) => error.to_compile_error().into(),
    }
}
```

这里没有直接 `quote!` 返回，因为生成过程**可能失败**：用户可能把 derive 用在没有 `span` 字段的类型上。`expand_spanned` 返回 `syn::Result<TokenStream2>`，也就是 `Result<TokenStream2, syn::Error>`。出错时调用 `error.to_compile_error()`：它生成的 token 是一个 `compile_error!("...")` 调用，位置落在你指定的 token 上。编译器展开后看到它就报错。这个设计让宏**永远不 panic**：错误是返回值，位置是精确的。`Result` 和 `?` 到第 7 篇才系统讲，这里先当成"可能是 `Ok(值)` 也可能是 `Err(错误)`，用 `match` 分开处理"。

### `expand_spanned`：结构体

```rust
fn expand_spanned(input: &DeriveInput) -> syn::Result<TokenStream2> {
    let name = &input.ident;
    let (impl_generics, ty_generics, where_clause) = input.generics.split_for_impl();

    let body = match &input.data {
        Data::Struct(data) => {
            let member = span_member(&data.fields)?;
            // `Span` is `Copy`, so reading the field does not move anything.
            quote!(self.#member)
        }
        // ... enum and union arms below
    };

    Ok(quote! {
        impl #impl_generics ::pebble_span::Spanned for #name #ty_generics #where_clause {
            fn span(&self) -> ::pebble_span::Span {
                #body
            }
        }
    })
}
```

`input.data` 是 `Data` 枚举：`Struct`、`Enum`、`Union` 三种，对应 Rust 的三种自定义类型。`match &input.data` 对它做穷尽匹配（第 3 篇的老朋友），所以 union 也得处理。结构体分支把字段名取出来，生成 `self.span`。`body` 是一小段 `TokenStream2`，最后被插进 `impl` 里。

### `span_member`：找到叫 `span` 的字段

```rust
fn span_member(fields: &Fields) -> syn::Result<syn::Ident> {
    match fields {
        Fields::Named(named) => named
            .named
            .iter()
            .find(|field| field.ident.as_ref().is_some_and(|id| id == "span"))
            .and_then(|field| field.ident.clone())
            .ok_or_else(|| {
                syn::Error::new_spanned(
                    fields,
                    "expected a field named `span` for `#[derive(Spanned)]`",
                )
            }),
        _ => Err(syn::Error::new_spanned(
            fields,
            "`#[derive(Spanned)]` requires named fields with a `span` field",
        )),
    }
}
```

这是整个宏里 Rust 味最浓的一段，我一层层剥：

- `Fields` 也是枚举：`Named`（`{ a: T }`）、`Unnamed`（`(T, U)`）、`Unit`（没有字段）。Pebble 的所有 AST 节点用具名字段，所以只接受 `Named`，其余用 `_ =>` 兜底并返回错误。
- `named.named` 是字段的有序列表：外层的 `named` 是 `Fields::Named` 里装的那个结构（`FieldsNamed`），里面的 `named` 才是字段的集合，名字撞了，不是笔误。`.iter().find(...)` 找第一个满足条件的字段，返回 `Option<&Field>`。
- `field.ident` 是 `Option<Ident>`（具名字段一定是 `Some`，但类型对元组字段也通用）。`.as_ref()` 把 `&Option<Ident>` 变成 `Option<&Ident>`，`.is_some_and(|id| id == "span")` 在有名字时比较它是否等于 `"span"`。`syn::Ident` 可以直接和字符串比较，这是它实现的 `PartialEq`。
- `.and_then(|field| field.ident.clone())`：找到了字段，就把它的名字克隆出来；没找到（`None`）还是 `None`。
- `.ok_or_else(|| ...)`：`Option` 到 `Result` 的桥：`Some(x)` 变 `Ok(x)`，`None` 变 `Err(闭包的返回值)`。闭包只在 `None` 时才被调用，所以不会白白构造错误。
- `syn::Error::new_spanned(fields, "...")`：创建一个错误，位置取自第一个参数的 token。这是自定义编译错误的关键：位置**指向用户的代码**，而不是宏的代码。

### `expand_spanned`：枚举和 union

回到 `expand_spanned` 里的 `match`，补上另外两个分支：

```rust
        Data::Enum(data) => {
            let arms = data
                .variants
                .iter()
                .map(|variant| {
                    let variant_name = &variant.ident;
                    let member = span_member(&variant.fields)?;
                    Ok(quote!(Self::#variant_name { #member, .. } => * #member))
                })
                .collect::<syn::Result<Vec<_>>>()?;
            quote! {
                match self {
                    #(#arms),*
                }
            }
        }
        Data::Union(data) => {
            return Err(syn::Error::new_spanned(
                data.union_token,
                "`Spanned` cannot be derived for unions",
            ));
        }
```

这段有一个值得停下来的类型技巧：`.map(|variant| { ... Ok(...) })` 里的闭包返回 `syn::Result<TokenStream2>`（里面有 `?`，而 `?` 要求闭包返回 `Result`）。对一个迭代器做 `.map` 得到的是**一串 `Result`**。我要的是"要么全部成功，得到一个 `Vec`；要么有任何一个失败，就得到那个错误"。标准库的 `collect` 能做这件事：

```rust
.collect::<syn::Result<Vec<_>>>()?
```

`::<...>` 是 turbofish，第 4 篇见过：告诉 `collect` 目标类型是 `Result<Vec<_>, syn::Error>`。遇到第一个 `Err` 它立即停下并返回那个 `Err`；全部是 `Ok` 就收集成 `Vec`。末尾的 `?` 再把外层的 `Result` 拆开：成功拿到 `Vec`，失败就让 `expand_spanned` 返回那个错误。（一个 `Vec<Result<..>>` 变成一个 `Result<Vec<..>>`，函数式编程里叫 `sequence`，这里不用名字。）`Data::Union` 分支的 `return Err(...)` 直接从函数返回，所以那个分支的类型是"永不返回"，不会和另外两个分支冲突。

### 完整文件

全部拼起来，`crates/pebble-macros/src/lib.rs` 是这样（102 行，含文档；去掉注释和空行是 70 行）：

```rust
//! Procedural macros for the Pebble toolchain.
//!
//! This crate must be a `proc-macro = true` crate: procedural macros run at
//! compile time, in the compiler's process, and speak in tokens. So far it has
//! one flavour:
//!
//! * [`macro@Spanned`] - a **derive** macro that writes the boring
//!   `impl pebble_span::Spanned` for AST nodes.

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::quote;
use syn::{Data, DeriveInput, Fields, parse_macro_input};

/// Derives [`pebble_span::Spanned`](https://docs.rs/pebble-span).
///
/// Works on structs and enums that carry a field literally named `span`:
///
/// ```ignore
/// #[derive(Spanned)]
/// struct Ident { name: String, span: Span }
///
/// #[derive(Spanned)]
/// enum Expr {
///     Int { value: i64, span: Span },
///     Var { name: Ident, span: Span },
/// }
/// ```
///
/// For an enum, *every* variant must have the `span` field, because the derived
/// `span()` matches on the variant and returns its span.
#[proc_macro_derive(Spanned)]
pub fn derive_spanned(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    match expand_spanned(&input) {
        Ok(tokens) => tokens.into(),
        Err(error) => error.to_compile_error().into(),
    }
}

fn expand_spanned(input: &DeriveInput) -> syn::Result<TokenStream2> {
    let name = &input.ident;
    let (impl_generics, ty_generics, where_clause) = input.generics.split_for_impl();

    let body = match &input.data {
        Data::Struct(data) => {
            let member = span_member(&data.fields)?;
            // `Span` is `Copy`, so reading the field does not move anything.
            quote!(self.#member)
        }
        Data::Enum(data) => {
            let arms = data
                .variants
                .iter()
                .map(|variant| {
                    let variant_name = &variant.ident;
                    let member = span_member(&variant.fields)?;
                    Ok(quote!(Self::#variant_name { #member, .. } => * #member))
                })
                .collect::<syn::Result<Vec<_>>>()?;
            quote! {
                match self {
                    #(#arms),*
                }
            }
        }
        Data::Union(data) => {
            return Err(syn::Error::new_spanned(
                data.union_token,
                "`Spanned` cannot be derived for unions",
            ));
        }
    };

    Ok(quote! {
        impl #impl_generics ::pebble_span::Spanned for #name #ty_generics #where_clause {
            fn span(&self) -> ::pebble_span::Span {
                #body
            }
        }
    })
}

fn span_member(fields: &Fields) -> syn::Result<syn::Ident> {
    match fields {
        Fields::Named(named) => named
            .named
            .iter()
            .find(|field| field.ident.as_ref().is_some_and(|id| id == "span"))
            .and_then(|field| field.ident.clone())
            .ok_or_else(|| {
                syn::Error::new_spanned(
                    fields,
                    "expected a field named `span` for `#[derive(Spanned)]`",
                )
            }),
        _ => Err(syn::Error::new_spanned(
            fields,
            "`#[derive(Spanned)]` requires named fields with a `span` field",
        )),
    }
}
```

文档注释里的 ` ```ignore ` 代码块告诉 `cargo test` 不要把它当 doctest 编译：它需要 `pebble_span` 在作用域里，而宏 crate 不依赖它。所以 `cargo test -p pebble-macros` 的结果是 0 个测试加 1 个被忽略的 doctest：

```text
running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
   Doc-tests pebble_macros
running 1 test
test crates/pebble-macros/src/lib.rs - derive_spanned (line 19) ... ignored
test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

宏本身没有单元测试，**测试它的是用它的 crate**：`pebble-ast` 里的 `derive_spanned_*` 两个测试。这是过程宏的常态，因为要测宏就得编译一个用它的 crate；`trybuild` 这类库可以做"这段代码应该报这个错"的快照测试，Pebble 没有用。

### 看一次展开

宏写好了，它到底吐出了什么？在实验室里，我把 `expand_spanned` 的结果用 `eprintln!("expansion for `{name}`:\n{expanded}\n")` 打印出来（`lab-macros-debug`，实验 `ch06_expand.rs`），对 `Ident` 和一个两变体的 `Expr` 用宏：

```text
expansion for `Ident`:
impl :: pebble_span :: Spanned for Ident
{ fn span(& self) -> :: pebble_span :: Span { self.span } }

expansion for `Expr`:
impl :: pebble_span :: Spanned for Expr
{
    fn span(& self) -> :: pebble_span :: Span
    {
        match self
        {
            Self :: Int { span, .. } => * span, Self :: Var { span, .. } => *
            span
        }
    }
}
```

`TokenStream` 的 `Display` 在每个 token 之间放空格，所以 `::` 显示成 `:: `。这提醒了我们：token 流没有"格式"这回事，空格只是打印时的装饰。

真实的展开可以在装配好之后，对整个 `pebble-ast` 看。稳定版编译器不接受 `-Zunpretty`，但 `RUSTC_BOOTSTRAP=1` 可以让它接受（**只用来观察**，不要放进任何构建脚本）：

```bash
RUSTC_BOOTSTRAP=1 cargo rustc -p pebble-ast --lib -- -Zunpretty=expanded
```

整个 crate 展开后 1135 行，我挑出和 `Spanned` 有关的两段。`Ident`：

```text
impl ::pebble_span::Spanned for Ident {
    fn span(&self) -> ::pebble_span::Span { self.span }
}
```

`Stmt`：

```text
impl ::pebble_span::Spanned for Stmt {
    fn span(&self) -> ::pebble_span::Span {
        match self {
            Self::Let { span, .. } => *span,
            Self::Fn { span, .. } => *span,
            Self::Expr { span, .. } => *span,
            Self::If { span, .. } => *span,
            Self::While { span, .. } => *span,
            Self::For { span, .. } => *span,
            Self::Return { span, .. } => *span,
            Self::Break { span, .. } => *span,
            Self::Continue { span, .. } => *span,
        }
    }
}
```

和上一篇手写的比，是同一个意思，唯一的区别是每个变体一个分支而不是 `|` 合并。`Self::Break { span, .. }` 里的 `..` 对只有一个字段的变体是多余的，宏不在乎。生成的代码不必漂亮，只需正确。

## 错误信息：宏的"用户界面"

宏的用户是写 `#[derive(Spanned)]` 的人（比如半年后的我）。给他们看的东西只有编译错误，所以错误的位置和措辞就是宏的 UI。下面是 `pebble-macros` 最终版（`lab-macros`，实验里用的是同一份代码）对几种误用的回应。

**元组结构体**（`ch06_derive_error.rs`：`struct Pair(Span, u32);`）：

```text
error: `#[derive(Spanned)]` requires named fields with a `span` field
 --> src/bin/ch06_derive_error.rs:5:12
  |
5 | struct Pair(Span, u32);
  |            ^^^^^^^^^^^
```

下划线正好落在字段列表上，这是 `new_spanned(fields, ..)` 的功劳。

**枚举里有一个变体没有 `span` 字段**（`ch06_derive_error_variant.rs`）：

```rust
#[derive(Spanned)]
enum Node {
    Leaf { span: Span },
    Branch { children: u32 },
}
```

```text
error: expected a field named `span` for `#[derive(Spanned)]`
 --> src/bin/ch06_derive_error_variant.rs:7:12
  |
7 |     Branch { children: u32 },
  |            ^^^^^^^^^^^^^^^^^
```

**枚举里有一个单元变体**（`ch06_derive_error_unit.rs`：`Leaf { span: Span }, Empty`）：

```text
error: `#[derive(Spanned)]` requires named fields with a `span` field
 --> src/bin/ch06_derive_error_unit.rs:4:10
  |
4 | #[derive(Spanned)]
  |          ^^^^^^^
  |
  = note: this error originates in the derive macro `Spanned` (in Nightly builds, run with -Z macro-backtrace for more info)
```

同一条消息，位置却不一样：下划线落在了 `#[derive(Spanned)]` 上。原因是 `Empty` 没有字段，`Fields::Unit` 里没有任何 token 可以指，`new_spanned` 只好退回"宏的调用位置"。这是 `new_spanned` 的一个局限。要改进的话可以改用变体自己的 `ident` 作位置，我把这个留作一个小改进，没有放进仓库版本。

**union**（`ch06_derive_union.rs`）：

```text
error: `Spanned` cannot be derived for unions
 --> src/bin/ch06_derive_union.rs:5:1
  |
5 | union Raw {
  | ^^^^^
```

**字段叫 `span`，但类型不对**（`ch06_wrong_type.rs`：`struct Oops { span: u32 }`）：

```text
error[E0308]: mismatched types
 --> src/bin/ch06_wrong_type.rs:3:10
  |
3 | #[derive(Spanned)]
  |          ^^^^^^^
  |          |
  |          expected `Span`, found `u32`
  |          expected `Span` because of return type
  |
  = note: this error originates in the derive macro `Spanned` (in Nightly builds, run with -Z macro-backtrace for more info)
```

这条最有意思：宏**没有**拒绝它。宏只看到标识符 `u32`，不知道 `Span` 是什么，也不知道 `u32` 不是它。它照样生成 `self.span`，直到类型检查阶段编译器才发现类型不符。回想上面的 `Show` 实验：宏看到的只有 token。**过程宏运行在类型检查之前**，它能做的检查只有语法级别的。不过这里的下场还不错：编译器的错误在这个例子里仍然足够清楚。

> [!NOTE] 宏里 panic 会怎样
> 你可以在宏函数里 `panic!`。我试了一下（`lab-macros-panic`，`ch06_panic.rs`），编译器把它显示成这样：
>
> ```text
> error: proc-macro derive panicked
>  --> src/bin/ch06_panic.rs:3:10
>   |
> 3 | #[derive(Boom)]
>   |          ^^^^
>   |
>   = help: message: this macro does not like its input
> ```
>
> 位置只有 `#[derive(..)]` 一处，没法指到用户出问题的那个 token。`syn::Error` 能给出精确位置，所以仓库的宏里一个 `panic!`、`unwrap` 也没有。

## 接入 `pebble-ast`

宏的 crate 完成了，回到 `pebble-ast`。五处改动。

**一，** `crates/pebble-ast/Cargo.toml` 的 `[dependencies]` 里 `pebble-span` 下面加一行：

```toml
pebble-macros.workspace = true
```

**二，** `crates/pebble-ast/src/lib.rs` 头部文档的最后一行改成两行：

```rust
//!   [`AstPrinter`] is one implementation. Deriving [`Spanned`] comes from the
//!   `pebble-macros` crate.
```

**三，** `pub use pebble_span::{Span, Spanned};` 下面加：

```rust
/// Parses `#[derive(Spanned)]` into scope as a *macro*; the trait of the same
/// name comes from `pebble-span`. The two live in different namespaces, which
/// is why `Spanned` can mean both.
pub use pebble_macros::Spanned;
```

这里有一件让人疑惑的事：同一个文件里有两行 `pub use ...::Spanned`，名字一样，不冲突吗？Rust 的名字分属三个**命名空间**：类型（包括 trait）、值（函数、常量）、宏。`pebble_span::Spanned` 是 trait，在类型命名空间里；`pebble_macros::Spanned` 是 derive 宏，在宏命名空间里。两个 `use` 各占一个，互不干扰。`#[derive(Spanned)]` 在宏的命名空间里找，`impl Spanned for X` 在类型的命名空间里找。标准库的 `#[derive(Debug)]` 和 `trait Debug` 也是这样同名的。

**四，** `Ident`、`Stmt`、`Expr` 三个类型上方的 `#[derive(Clone, Debug, PartialEq)]` 各加一个 `Spanned`：

```rust
#[derive(Clone, Debug, PartialEq, Spanned)]
```

**五，** 删掉三个手写的 `impl Spanned for ...`（`Ident` 的 6 行，`Stmt` 的 16 行，`Expr` 的 22 行，各含后面的一个空行）。

在 `~/pebble` 下，把 `pebble-ast` 和仓库对一下：

```bash
diff ~/pebble-tag/crates/pebble-ast/src/lib.rs crates/pebble-ast/src/lib.rs && echo identical
diff ~/pebble-tag/crates/pebble-ast/Cargo.toml crates/pebble-ast/Cargo.toml && echo identical
```

```text
identical
identical
```

然后是要紧的那一步，测试一个字不改：

```bash
cargo test -p pebble-ast
```

```text
running 4 tests
test tests::default_visit_reaches_every_expression ... ok
test tests::derive_spanned_works_on_enum_variants ... ok
test tests::derive_spanned_reads_the_span_field ... ok
test tests::printer_walks_the_whole_tree ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

还是上一篇那 4 个测试（顺序略有变化，是并行执行的顺序），这就是重构的标准：行为不变，测试不动。

## 值不值

诚实地算一笔账。

- **代码行数**：删掉 44 行手写代码，新增一个 70 行（不含注释和空行）的宏 crate。就这个项目的规模，**光看行数是亏的**。
- **编译时间**：我在一个全新的 `target` 目录里各编译一次 `pebble-ast`。没有宏的版本，0.45 秒；有宏的版本，4.56 秒（`proc-macro2`、`quote`、`unicode-ident`、`syn` 和 `pebble-macros` 都要先编译一遍）。大约 10 倍，单次测量，机器有 16 核，只能当个量级。不过它们是外部依赖，只在干净构建时付一次，增量编译里不会重复。
- **收益**：加变体的时候，`Spanned` 那一处不再需要你记得改。上一篇的实验是 3 个错误，现在是 2 个；而且更重要的是，另一种漏改（给新变体忘了加 `span` 字段）会得到一条专门的、指向那个变体的错误：

```text
error: expected a field named `span` for `#[derive(Spanned)]`
   --> crates/pebble-ast/src/lib.rs:120:11
    |
120 |     Block { body: Vec<Stmt> },
    |           ^^^^^^^^^^^^^^^^^^^
```

我的判断是：对 Pebble 这个体量，宏是为了学它而加的，不是为了省事。但同样的思路在 `serde` 的 derive 里省下的是几千行。想想成熟的项目：你手上有 40 个 AST 节点，每个都要 `Spanned`、`Visit`、`Clone`、`Debug`，derive 就是让这些**一行**搞定的东西。

## 检查点

在 `~/pebble` 下：

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

测试：`pebble-span` 6 个、`pebble-diag` 4 个、`pebble-lexer` 12 个、`pebble-ast` 4 个，`pebble-macros` 0 个（加 1 个被忽略的 doctest）。clippy 和 fmt 没有输出。

**此时与 tag `tutorial-v1` 逐字节相同的文件（已完成）：**

- [`crates/pebble-ast/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-ast/src/lib.rs) 与 [`crates/pebble-ast/Cargo.toml`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-ast/Cargo.toml)（我用 `diff` 对照过）
- [`crates/pebble-span/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-span/src/lib.rs)、[`crates/pebble-diag/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-diag/src/lib.rs)、[`crates/pebble-lexer/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-lexer/src/lib.rs)（之前的章节）

**中间状态的文件（后面的章节会补成仓库版本）：**

- [`crates/pebble-macros/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-macros/src/lib.rs)：现在只有 `#[derive(Spanned)]` 这一个宏；头部文档说 "So far it has one flavour"，只有一个宏的描述。仓库版本里还有 `opcode_set!`（第 10 篇）和 `#[differential]`（第 12 篇）两个宏，以及相应的文档。**derive 的那部分（`derive_spanned`、`expand_spanned`、`span_member`）和仓库逐字相同。**
- [`crates/pebble-macros/Cargo.toml`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-macros/Cargo.toml)：`description` 是 "derive only, so far"，没有 `[dev-dependencies]`。
- 根 `Cargo.toml`：`[workspace.dependencies]` 现在有 `pebble-span`、`pebble-diag`、`pebble-lexer`、`pebble-ast`、`pebble-macros`，以及 `proc-macro2`、`quote`、`syn` 三个外部依赖。tag 里的版本还有解析器、解释器等其他 crate 的条目、几个外部依赖和注释分隔线，随后续章节加入。

### 实验清单

这一篇的实验文件都在仓库的 `lab/` 目录里，宏实验都是侧边 crate，各自是一个独立的 Cargo 包，依赖 tag 里的最终版 `pebble-span`（主实验室 [`lab/rust-lab`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/lab/rust-lab) 在这一篇没有新文件）。如果你把 tag 克隆在 `~/pebble-tag`，它们就在 `~/pebble-tag/lab/` 下，命令都从那里的对应目录运行。

下表的 `ch06_*.rs` 全在 [`lab/lab-ch06-derive/src/bin/`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/lab/lab-ch06-derive/src/bin)，命令都在 `lab/lab-ch06-derive` 里运行；结果列括号里是该实验依赖的 `lab-macros-*` 变体：

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`ch06_proc_macro_outside.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_proc_macro_outside.rs) | `cargo build --bin ch06_proc_macro_outside` | E0433 |
| [`ch06_proc_macro2_outside.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_proc_macro2_outside.rs) | `cargo run --quiet --bin ch06_proc_macro2_outside` | 运行，输出 `empty = true` |
| [`ch06_hello.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_hello.rs) | `cargo run --quiet --bin ch06_hello` | 运行，输出 `hello from Anything`（`lab-macros-step`） |
| [`ch06_tokens.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_tokens.rs) | `cargo run --quiet --bin ch06_tokens` | 运行，标准输出为空，输入 token 在构建时的 stderr 里（`lab-macros-step`） |
| [`ch06_step.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_step.rs) | `cargo run --quiet --bin ch06_step` | 运行，输出 `hello from Anything`（`lab-macros-step`） |
| [`ch06_naive_generic.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_naive_generic.rs) | `cargo build --bin ch06_naive_generic` | E0107（`lab-macros-step`） |
| [`ch06_generic_v2.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_generic_v2.rs) | `cargo run --quiet --bin ch06_generic_v2` | 运行，输出 `4..9 at 5 (inner = hello)`（`lab-macros-v2`） |
| [`ch06_enum_v2.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_enum_v2.rs) | `cargo build --bin ch06_enum_v2` | E0615（`lab-macros-v2`） |
| [`ch06_no_star.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_no_star.rs) | `cargo build --bin ch06_no_star` | E0308（`lab-macros-nostar`） |
| [`ch06_no_comma.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_no_comma.rs) | `cargo build --bin ch06_no_comma` | 无 E 码：``error: expected `,` following `match` arm``（`lab-macros-nocomma`） |
| [`ch06_relative.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_relative.rs) | `cargo build --bin ch06_relative` | E0405（`lab-macros-rel`） |
| [`ch06_shadow.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_shadow.rs) | `cargo run --quiet --bin ch06_shadow` | 运行，输出 `1..4`（`lab-macros`） |
| [`ch06_expand.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_expand.rs) | `cargo run --quiet --bin ch06_expand` | 运行，标准输出为空，展开结果在构建时的 stderr 里（`lab-macros-debug`） |
| [`ch06_derive_error.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_derive_error.rs) | `cargo build --bin ch06_derive_error` | 无 E 码：``error: `#[derive(Spanned)]` requires named fields with a `span` field``（`lab-macros`） |
| [`ch06_derive_error_variant.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_derive_error_variant.rs) | `cargo build --bin ch06_derive_error_variant` | 无 E 码：`` error: expected a field named `span` for `#[derive(Spanned)]` ``（`lab-macros`） |
| [`ch06_derive_error_unit.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_derive_error_unit.rs) | `cargo build --bin ch06_derive_error_unit` | 无 E 码：``error: `#[derive(Spanned)]` requires named fields with a `span` field``（`lab-macros`） |
| [`ch06_derive_union.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_derive_union.rs) | `cargo build --bin ch06_derive_union` | 无 E 码：``error: `Spanned` cannot be derived for unions``（`lab-macros`） |
| [`ch06_wrong_type.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_wrong_type.rs) | `cargo build --bin ch06_wrong_type` | E0308（`lab-macros`） |
| [`ch06_panic.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_panic.rs) | `cargo build --bin ch06_panic` | 无 E 码：`error: proc-macro derive panicked`（`lab-macros-panic`） |
| [`ch06_attr.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_attr.rs) | `cargo run --quiet --bin ch06_attr` | 运行，输出 `let -> 0..3`（`lab-macros-attr`，练习 1 的答案） |

另外两个独立的侧边 crate，各自在自己的目录里：

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`lab/lab-ch06-export/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-export/src/lib.rs) | `cd lab/lab-ch06-export && cargo build` | 无 E 码：``error: `proc-macro` crate types currently cannot export any items other than functions tagged with ...`` |
| [`lab/lab-ch06-nodep/src/main.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-nodep/src/main.rs) | `cd lab/lab-ch06-nodep && cargo build --bin lab-ch06-nodep` | E0433 |

实验用到的宏 crate 都在 `lab/lab-ch06-derive/` 里，每个都是一个只含 `Cargo.toml` 和 `src/lib.rs` 的 `proc-macro = true` 包：[`lab-macros`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/lab/lab-ch06-derive/lab-macros)（最终版 `Spanned`）、[`lab-macros-step`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/lab/lab-ch06-derive/lab-macros-step)、[`lab-macros-v2`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/lab/lab-ch06-derive/lab-macros-v2)、[`lab-macros-nostar`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/lab/lab-ch06-derive/lab-macros-nostar)、[`lab-macros-nocomma`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/lab/lab-ch06-derive/lab-macros-nocomma)、[`lab-macros-rel`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/lab/lab-ch06-derive/lab-macros-rel)、[`lab-macros-debug`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/lab/lab-ch06-derive/lab-macros-debug)、[`lab-macros-panic`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/lab/lab-ch06-derive/lab-macros-panic)、[`lab-macros-attr`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/lab/lab-ch06-derive/lab-macros-attr)。仓库里还有 [`ch06_generic.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/lab-ch06-derive/src/bin/ch06_generic.rs)（对 `lab-macros` 跑一个泛型结构体，输出 `4..9 at 5 (inner = hello)`），文章没有用到。

## 练习

**1. 让 derive 支持别的字段名。** 现在宏只认叫 `span` 的字段。设计一个让 `struct Token { text: String, range: Span }` 也能 derive 的方法，不要改成"任何类型是 `Span` 的字段"（理由见练习 2）。

<details>
<summary>参考答案</summary>

用一个**辅助属性**（helper attribute）：让用户在字段上标一个 `#[spanned]`，宏认这个标记。改两处。第一，宏的登记要声明这个属性存在，否则编译器会因为 `#[spanned]` 是未知属性而报错：

```rust
#[proc_macro_derive(Spanned, attributes(spanned))]
```

第二，`span_member` 里找字段的条件，从"名字是 `span`"改成"带 `#[spanned]` 属性，或者名字是 `span`"：

```rust
.find(|field| {
    field.attrs.iter().any(|attr| attr.path().is_ident("spanned"))
        || field.ident.as_ref().is_some_and(|id| id == "span")
})
```

我在 `lab-macros-attr` 里这样改了，对下面的类型实验（`ch06_attr.rs`）：

```rust
#[derive(Spanned)]
struct Token {
    text: String,
    #[spanned]
    range: Span,
}
```

打印 `token.span()` 得到：

```text
let -> 0..3
```

不要用"类型是 `Span` 的字段"，原因见下一题。

</details>

**2. 为什么过程宏不能"找类型是 `Span` 的字段"？** 你写一个宏，想让它在字段 `range: Span` 上也工作，办法是比较字段的类型。这为什么靠不住？

<details>
<summary>参考答案</summary>

宏拿到的只是 token：字段类型在它眼里是一个标识符 `Span`。它不知道那个 `Span` 是 `pebble_span::Span`、`std::ops::Range` 的别名，还是用户自己定义的另一个类型。用户也可以写 `use pebble_span::Span as Loc;`，那时类型的 token 是 `Loc`；或者写成 `pebble_span::Span`，token 是三段路径。宏要做的比较在名字解析（以及类型别名展开）之前，没有可靠的办法。

上面 `ch06_wrong_type.rs` 是对称的证据：字段名叫 `span` 但类型是 `u32`，宏毫无察觉，一直到类型检查阶段才被拒绝。要让宏看见类型信息，必须由用户在宏参数里明确说出来，所以辅助属性（练习 1）是惯用做法。

</details>

**3. 故意弄坏。** 给 `Stmt` 加一个变体 `Block { body: Vec<Stmt> }`（不带 `span`），运行 `cargo build -p pebble-ast`，读错误。再想想：为什么这个错误里**只有一条**来自 derive 的，而不是三个类型各一条？

<details>
<summary>参考答案</summary>

我在一份拷贝里做了，错误开头是：

```text
error: expected a field named `span` for `#[derive(Spanned)]`
   --> crates/pebble-ast/src/lib.rs:120:11
    |
120 |     Block { body: Vec<Stmt> },
    |           ^^^^^^^^^^^^^^^^^^^
```

后面还跟着 `walk_stmt` 和打印器里的两条 `E0004`（`Stmt::Block` 没有被覆盖），因为这两个 `match` 还没有处理新变体。derive 错误只有一条，因为只有 `Stmt` 被弄坏了：`Ident` 和 `Expr` 各自独立展开，互不影响。同一个类型里如果有两个变体都缺 `span`，也只会报第一个：`collect::<syn::Result<Vec<_>>>()` 遇到第一个 `Err` 就停了。想一次报全的话，`syn::Error` 有 `combine` 方法可以把多个错误合成一个，那是另一个练习。

</details>

写宏的头一个小时，你会觉得自己在和编译器玩一种怪游戏：输入是 token，输出是 token，出错信息指向别人的代码。一旦习惯了，它就像一把电锯：很少需要，需要时没有替代品。下一篇回到更朴素的 Rust：我们要把 token 变成这一篇装好的那棵 AST。这意味着要写一个真正的递归下降解析器，也意味着要认真对待 `Result`、`?`，和那个所有 C++ 程序员都想知道答案的问题：Rust 里的错误，到底去哪儿了。
