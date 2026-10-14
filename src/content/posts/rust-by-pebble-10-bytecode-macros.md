---
title: "字节码编译器：macro_rules!、回填和常量池"
commentId: "post:rust-by-pebble-10-bytecode-macros"
published: "2026-10-13 17:00:00 +08:00"
description: "把 AST 压扁成一串线性指令：用函数式过程宏 opcode_set! 生成指令枚举，用 macro_rules! 写 chunk!，用 HashMap 的 entry API 给名字去重，用回填补全跳转目标，再亲手弄坏 for 循环的压栈顺序看测试漏掉了什么。"
category: Note
tags:
  - Rust
  - Pebble
  - 字节码
  - 宏
  - 编译器
series: "用 Pebble 从零学 Rust"
seriesOrder: 10
draft: false
comment: true
slug: rust-by-pebble-10-bytecode-macros
---

`1 + 2 * 3;` 在 AST 里是五个节点，三层嵌套。下面是我们这一篇写出来的编译器对它的看法（`1.pebble` 里只有这一行），真实输出：

```text
$ pebble run --dump-bytecode 1.pebble
== constants ==
     0 1
     1 2
     2 3
== code ==
     0 Const 0
     1 Const 1
     2 Const 2
     3 Mul
     4 Add
7
```

树不见了。剩下一张常量表，和五条按顺序排好的指令。最后那个 `7` 是第 9 篇的树遍历解释器跑出来的（`run` 在打印完指令清单之后照旧用它执行），这一篇的编译器本身还不会执行任何东西，那是第 12 篇虚拟机的活。我们这一篇只做一件事：把"一棵要递归下去的树"变成"一张从头读到尾的清单"，并且写一个能把这张清单打印出来的反汇编器，让你亲眼看到它。

> [!NOTE] 本篇检查点
> 这一篇我们新建 `pebble-bytecode`（字节码编译器），在 `pebble-macros` 里加上第二个宏 `opcode_set!`，并把命令行升级到第三版：`pebble run --dump-bytecode`，`pebble check` 顺带编译。用到的 Rust 特性：函数式过程宏、`macro_rules!`（片段、重复、`$crate`、卫生性）、带载荷的 `Copy` 枚举、`HashMap` 的 `entry` API 与闭包的分字段捕获、`ref` 绑定、let 链（edition 2024）、`split_last` 加 `let else`、`Rc<FunctionProto>`，以及 doc test。结束时 `cargo test -p pebble-bytecode` 是 14 个测试加 1 个 doc test 全部通过，命令行是 3 个单元测试加 9 个集成测试，`crates/pebble-bytecode/` 下的两个文件与 tag 逐字节相同。上一篇是 [树遍历解释器：闭包、控制流与一个内存泄漏](/posts/rust-by-pebble-09-interpreter-closures/)。

## 为什么要把树压扁

第 9 篇的结尾我列了三个"一眼看出会贵"的地方：变量查找沿着环境链走、每次调用分配一个 `Env`、每次执行 `fn` 语句复制一遍函数体。字节码本身不会魔法般地解决前两个（这一篇的变量依旧按名字查，每次调用依旧要一个环境，第 12 篇会老老实实量出来），但它至少改变三件事：

- 执行变成**一个循环**：取一条指令，执行，取下一条。树遍历解释器每走一层嵌套就多一层 Rust 的函数调用栈，所以第 9 篇才需要 `with_call_depth` 和 `thread::Builder::stack_size`；循环不吃调用栈。
- 函数体只编译一次。编译产物用 `Rc` 共享，运行 `fn` 语句不再复制 AST。
- 程序变成**一张可以打印出来的表**。调试一个编译器时，能看到它吐了什么，比什么都值钱（上面那段输出就是证据）。

我选的是**栈机**：每条指令从一个操作数栈上取参数，把结果压回栈上。另一个流派是寄存器机（Lua 5 用的），指令里写明参数在哪个寄存器，指令更少、更快，编译器更难写。栈机的编译器几乎是 AST 的后序遍历，写起来直白。（我没有拿 Pebble 的两种设计做对比，这个取舍是照着教科书做的，不是量出来的。）

后序遍历是什么意思？先编译左边，再编译右边，最后输出运算符。`1 + 2 * 3` 变成 `1 2 3 * +`，这是逆波兰表达式，HP 的老计算器就是这么用的。我手工推演一遍栈的变化（第 12 篇的虚拟机会让机器替我做这件事）：

| 指令 | 栈（左边是栈底） |
|---|---|
| `Const 0` | `[1]` |
| `Const 1` | `[1, 2]` |
| `Const 2` | `[1, 2, 3]` |
| `Mul` | `[1, 6]` |
| `Add` | `[7]` |

每条运算指令弹出自己的参数、压回结果。整个程序跑完，栈上留下的就是它的值。

## 第一步：给指令写个名字表

先定义指令集。一条 Pebble 指令是一个枚举：大多数指令不带参数，少数带一个 `u32`（常量表的下标，或者一个跳转目标）。我先试着手写一个只有六条指令的：

```rust
#[derive(Clone, Copy)]
enum Opcode {
    Const(u32),
    Nil,
    Pop,
    Add,
    Mul,
    Return,
}

impl Opcode {
    fn name(self) -> &'static str {
        match self {
            Opcode::Const(_) => "Const",
            Opcode::Nil => "Nil",
            Opcode::Pop => "Pop",
            Opcode::Add => "Add",
            Opcode::Mul => "Mul",
        }
    }
}
```

`name()` 是给反汇编器用的：打印 `Mul` 而不是 `Opcode::Mul`（`Debug` 派生出来的格式会连载荷一起打印，`Const(0)` 而不是我们想要的 `Const 0`）。我故意漏了 `Return`，这是实验室里的 `ch10_name_table.rs`：

```text
$ cargo build --bin ch10_name_table
error[E0004]: non-exhaustive patterns: `Opcode::Return` not covered
  --> src/bin/ch10_name_table.rs:13:15
   |
13 |         match self {
   |               ^^^^ pattern `Opcode::Return` not covered
   |
...
 8 |     Return,
   |     ------ not covered
...
For more information about this error, try `rustc --explain E0004`.
```

编译器抓住了遗漏，这是第 3 篇学过的穷尽匹配。所以问题**不是**安全，是重复：每条指令要写在枚举里、写在 `name()` 里，完整版有 32 条，还要加上 `derive` 列表和文档。每次加一条指令（本篇的练习就要你加一条）得改两个地方，而且这两个地方的内容 90% 是同一个标识符。

这是一个"从一份声明生成两份代码"的活，宏的本职工作。第 6 篇我们用 derive 宏给 AST 生成 `impl Spanned`，那是**派生宏**：它挂在一个类型上，生成的代码**附加**在类型后面。这一次我们要写一个**函数式过程宏**：调用起来像 `opcode_set! { ... }`，它吃掉大括号里的所有 token，输出**替换**掉整个调用。区别在于输出：派生宏的输出是"追加"，枚举本身还在；函数式宏什么都不保留，所以我们得自己把枚举重新输出一遍。

> [!NOTE] 其实 macro_rules! 也行
> 这个任务用 `macro_rules!` 也写得出来。我没有真的写那个版本，所以只能说我的判断：要处理文档注释（它们是 `#[doc = "..."]` 属性）、可选的元组载荷，规则会很绕。这里我把它当作函数式过程宏的练习，下面 `chunk!` 才是 `macro_rules!` 的主场。

### 写 opcode_set

在 `crates/pebble-macros/src/lib.rs` 里先把 `use syn::...` 那一行改成多引入一个 `ItemEnum`：

```rust
use syn::{Data, DeriveInput, Fields, ItemEnum, parse_macro_input};
```

`ItemEnum` 是 `syn` 对"一个 `enum` 定义"的解析结果，第 6 篇的 `DeriveInput` 的近亲。然后在文件末尾加入入口函数：

```rust
#[proc_macro]
pub fn opcode_set(input: TokenStream) -> TokenStream {
    let item = parse_macro_input!(input as ItemEnum);
    match expand_opcodes(&item) {
        Ok(tokens) => tokens.into(),
        Err(error) => error.to_compile_error().into(),
    }
}
```

和第 6 篇的 `derive_spanned` 比，差别只有属性：`#[proc_macro]` 而不是 `#[proc_macro_derive(Spanned)]`。函数名就是宏名，调用时写 `opcode_set!`。`parse_macro_input!(input as ItemEnum)` 把 token 流解析成 `ItemEnum`，解析失败时它自己 `return` 一个编译错误，所以后面不用处理那种情况。真实的失败长这样：我写了个 `pub struct Tiny { pc: u32 }` 塞给它（实验 `ch10_opcode_set_struct.rs`）：

```text
error: expected `enum`
 --> src/bin/ch10_opcode_set_struct.rs:4:9
  |
4 |     pub struct Tiny {
  |         ^^^^^^
...
```

错误指向用户写的那个 `struct`，没有任何宏内部的东西漏出来。

现在是 `expand_opcodes`，分三小段。第一段取出 `ItemEnum` 的各个部分：

```rust
fn expand_opcodes(item: &ItemEnum) -> syn::Result<TokenStream2> {
    let attrs = &item.attrs;
    let vis = &item.vis;
    let name = &item.ident;
    let variants = &item.variants;
```

`attrs` 是枚举上的属性。注意文档注释 `/// One Pebble instruction.` 在编译器眼里就是属性 `#[doc = " One Pebble instruction."]`，它会出现在这里。`vis` 是可见性（`pub`），`ident` 是名字，`variants` 是变体列表（一个带逗号的 `Punctuated` 序列）。

第二段为每个变体生成 `name()` 里的一个 `match` 分支：

```rust
    let arms = variants.iter().map(|variant| {
        let variant_name = &variant.ident;
        if variant.fields.is_empty() {
            quote!(#name::#variant_name => stringify!(#variant_name))
        } else {
            quote!(#name::#variant_name(..) => stringify!(#variant_name))
        }
    });
```

无载荷的变体生成 `Opcode::Nil => "Nil"`，带载荷的生成 `Opcode::Const(..) => "Const"`（`(..)` 是"不管里面有什么"的模式）。`stringify!` 是标准库的宏：把传给它的 token 原样变成字符串字面量，`stringify!(Nil)` 就是 `"Nil"`。这是整个宏里唯一需要"把标识符变成字符串"的地方，也是手写 `name()` 时我最容易拼错的地方。`arms` 是一个惰性的迭代器，这里还没有产生任何东西，下一段会把它交给 `quote!`。

第三段拼出最终输出：

```rust
    Ok(quote! {
        #[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
        #(#attrs)*
        #vis enum #name {
            #variants
        }

        impl #name {
            /// The opcode's name, for disassembly and tracing.
            #[must_use]
            pub const fn name(self) -> &'static str {
                match self {
                    #(#arms),*
                }
            }
        }
    })
}
```

`#(#attrs)*` 把每个属性原样重放一遍，用户的文档注释因此保留。`#variants` 直接把整个 `Punctuated` 列表（连逗号一起）插进去。`#(#arms),*` 是 `quote!` 的重复语法：对 `arms` 迭代，每个元素之间用逗号分隔。整个宏做的事比 derive 还少：没有泛型要处理，没有字段要查。

宏自己加了一份 `#[derive(...)]`。`Clone, Copy` 因为指令要在 `match self.code[at]` 里直接复制出来（下面会遇到），`PartialEq, Debug` 因为测试要 `assert_eq!` 它们。`const fn` 是第 1 篇的老朋友：`name()` 能在编译期求值。

整个宏文件末尾现在多了 `opcode_set` 和 `expand_opcodes` 两个函数。顶部的模块文档也要更新，把"目前一种宏"改成两种：

```rust
//! compile time, in the compiler's process, and speak in tokens. So far two
//! flavours live here:
//!
//! * [`macro@Spanned`] - a **derive** macro that writes the boring
//!   `impl pebble_span::Spanned` for AST nodes.
//! * [`opcode_set`] - a **function-like** macro that turns a declarative list of
//!   opcodes into an enum plus a `name()` table.
//!
//! (A third, **declarative** kind, `macro_rules!`, lives next to the code
//! that uses it in `pebble-bytecode`.)
```

用实验室验证它：新建 `/tmp/lab-ch10-opcode`（一个依赖 `pebble-macros` 的小 crate，路径依赖），写 `src/bin/ch10_opcode_set.rs`：

```rust
use pebble_macros::opcode_set;

opcode_set! {
    pub enum Tiny {
        Const(u32),
        Nil,
        Jump(u32),
    }
}

fn main() {
    for op in [Tiny::Const(7), Tiny::Nil, Tiny::Jump(3)] {
        println!("{:?} is called {}", op, op.name());
    }
}
```

```text
$ cargo run --quiet --bin ch10_opcode_set
Const(7) is called Const
Nil is called Nil
Jump(3) is called Jump
```

`{:?}` 来自宏加的 `Debug` 派生，`name()` 来自宏生成的 `impl`。

## 第二步：pebble-bytecode，最小的一版

```bash
cargo new --lib crates/pebble-bytecode
```

先在根 `Cargo.toml` 的 `[workspace.dependencies]` 里，`pebble-interp` 那一行后面加上它自己：

```toml
pebble-bytecode = { path = "crates/pebble-bytecode", version = "0.1.0" }
```

`crates/pebble-bytecode/Cargo.toml` 的完整内容如下，和 [tag 里的文件](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-bytecode/Cargo.toml) 一致：

```toml
[package]
name = "pebble-bytecode"
description = "Bytecode chunks, opcodes, and the Pebble compiler front-to-back end."
version.workspace = true
edition.workspace = true
rust-version.workspace = true
authors.workspace = true
license.workspace = true
repository.workspace = true

[dependencies]
pebble-span.workspace = true
pebble-diag.workspace = true
pebble-ast.workspace = true
pebble-macros.workspace = true

[dev-dependencies]
pebble-parser.workspace = true

[lints]
workspace = true
```

四个正常依赖：`span`（每条指令记下它来自源码的哪一段）、`diag`（编译期的错误，比如 `break` 在循环外面）、`ast`（输入）、`macros`（刚写的 `opcode_set!`）。`pebble-parser` 和上一篇的 `pebble-interp` 一样，只在测试里把字符串变成 AST，放在 `[dev-dependencies]`。

下面是 `crates/pebble-bytecode/src/lib.rs` 的第一版。我要的最小东西：六条指令，一种常量，一个 `Chunk`，一个只会编译整数加乘的 `Compiler`。先是文件头和指令集：

```rust
#![forbid(unsafe_code)]
//! The Pebble bytecode compiler: AST in, an instruction stream out.

use pebble_ast::{BinaryOp, Expr, Program, Spanned, Stmt};
use pebble_macros::opcode_set;
use pebble_span::Span;

opcode_set! {
    /// One Pebble instruction.
    pub enum Opcode {
        /// Push `constants[operand]`.
        Const(u32),
        /// Push `nil`.
        Nil,
        /// Discard the top of the stack.
        Pop,
        /// `a + b`
        Add,
        /// `a * b`
        Mul,
        /// Return the top of the stack.
        Return,
    }
}
```

`#![forbid(unsafe_code)]` 是第 2 篇的老规矩。这个 crate 里没有一行 `unsafe`，以后也不会有。

那个宏调用展开成什么样？稳定版编译器不接受 `-Zunpretty`，第 6 篇说过 `RUSTC_BOOTSTRAP=1` 可以让它接受，**只用来观察**：

```bash
RUSTC_BOOTSTRAP=1 cargo rustc -p pebble-bytecode --lib -- -Zunpretty=expanded
```

```text
#[doc = " One Pebble instruction."]
pub enum Opcode {

    #[doc = " Push `constants[operand]`."]
    Const(u32),

    #[doc = " Push `nil`."]
    Nil,
...
}
...
impl Opcode {
    #[doc = r" The opcode's name, for disassembly and tracing."]
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Opcode::Const(..) => "Const",
            Opcode::Nil => "Nil",
            Opcode::Pop => "Pop",
            Opcode::Add => "Add",
            Opcode::Mul => "Mul",
            Opcode::Return => "Return",
        }
    }
}
```

（中间省略的是 `Clone`、`Copy`、`PartialEq`、`Eq`、`Hash`、`Debug` 这些派生出来的 `impl`，加起来六十来行，一行都不用我们自己写。）`name()` 和上面手写的版本一模一样，这次一个都不会漏。

### 带载荷的 Copy 枚举有多大

`Opcode` 是 `Copy` 的，里面还装着一个 `u32`。它占多少字节？实验室里 `ch10_sizes.rs`，同样形状的小枚举，对照一个 C 程序员会写的结构体：

```text
$ cargo run --quiet --bin ch10_sizes
enum Op        = 8 bytes
Option<Op>     = 8 bytes
repr(C) struct = 8 bytes
```

8 字节：一个字节的判别式（"现在是哪一条指令"），三个字节的填充，四个字节的 `u32`。C 里写 `struct { uint8_t op; uint32_t arg; }` 得到的也是 8。`std::variant` 做的是同一件事，只是 Rust 的枚举是语言内置的，`match` 能检查穷尽性。（`Option<Op>` 同样是 8 字节：判别式有没用到的取值，`None` 借用其中一个，这叫 niche 优化。）

一个真正的字节码格式会把操作数紧紧压在指令后面：1 字节操作码加 4 字节操作数 = 5 字节。Pebble 没这么做：用枚举换来了 `match` 的便利和 100% 安全的代码，代价是每条指令 8 字节。本篇稍后的 `operand_bytes()` 会把"压缩后应该是多少"算出来，让这个代价看得见。

### 常量、Chunk 和编译器

接下来是常量、`Chunk` 和一个编译器。常量先只支持整数：

```rust
/// A compile-time constant.
#[derive(Debug)]
pub enum Constant {
    Int(i64),
}
```

`Chunk` 是编译的产物：一串指令，一张常量表，和一个与指令一一对应的 `Vec<Span>`（出错时能指回源码）：

```rust
/// A linear sequence of instructions plus its constant pool.
#[derive(Default)]
pub struct Chunk {
    code: Vec<Opcode>,
    constants: Vec<Constant>,
    spans: Vec<Span>,
}

impl Chunk {
    /// Appends an instruction and returns its index.
    pub fn emit(&mut self, op: Opcode, span: Span) -> usize {
        self.code.push(op);
        self.spans.push(span);
        self.code.len() - 1
    }

    /// Adds a constant and returns its index.
    pub fn add_constant(&mut self, constant: Constant) -> u32 {
        self.constants.push(constant);
        (self.constants.len() - 1) as u32
    }
```

`emit` 返回新指令的下标，下面的"回填"一节要靠这个返回值。字段是私有的，外面只能通过方法看：

```rust
    /// The instructions.
    #[must_use]
    pub fn code(&self) -> &[Opcode] {
        &self.code
    }

    /// The constant pool.
    #[must_use]
    pub fn constants(&self) -> &[Constant] {
        &self.constants
    }
}
```

返回 `&[Opcode]` 而不是 `&Vec<Opcode>`：调用方只需要读，不需要知道背后是不是 `Vec`（第 2 篇的切片）。

编译器的入口：

```rust
/// Compiles a parsed program into one chunk.
#[must_use]
pub fn compile(program: &Program) -> Chunk {
    let mut compiler = Compiler::default();
    compiler.compile_body(&program.stmts, false);
    compiler.chunk
}

#[derive(Default)]
struct Compiler {
    chunk: Chunk,
}
```

`Compiler` 现在只有一个字段，`#[derive(Default)]` 给它一个"全空"的构造。后面它会长出更多字段，到时候我们会把 `Default` 换成手写的 `new()`。

`compile_body` 编译一串语句。这里有两个约定要记住：程序**最后一条表达式语句的值就是整个程序的值**，所以它的结果不弹出，留在栈上；函数体里这个值还要用 `Return` 返回出去。

```rust
impl Compiler {
    fn emit(&mut self, op: Opcode, span: Span) -> usize {
        self.chunk.emit(op, span)
    }

    fn compile_body(&mut self, stmts: &[Stmt], in_function: bool) {
        let span = stmts.first().map_or(Span::DUMMY, Spanned::span);
        let Some((last, init)) = stmts.split_last() else {
            self.emit(Opcode::Nil, span);
            if in_function {
                self.emit(Opcode::Return, span);
            }
            return;
        };
```

`split_last` 把切片拆成"最后一个"加"前面所有"，返回 `Option<(&T, &[T])>`：空切片返回 `None`。`let ... else`（第 3 篇）处理空程序：压一个 `nil` 当作它的值。`map_or(Span::DUMMY, Spanned::span)` 里的 `Spanned::span` 是把 trait 方法当函数传：`first()` 给出 `Option<&Stmt>`，`map_or` 对里面的值调用 `Spanned::span`，没有语句时用 `Span::DUMMY`。

```rust
        for stmt in init {
            self.compile_stmt(stmt);
        }
        if let Stmt::Expr { expr, .. } = last {
            self.compile_expr(expr);
        } else {
            self.compile_stmt(last);
            self.emit(Opcode::Nil, span);
        }
        if in_function {
            self.emit(Opcode::Return, span);
        }
    }
```

前面的语句各自编译。最后一条：如果是表达式语句，直接编译表达式，值留在栈上；否则（比如 `let`）正常编译，然后压一个 `nil` 当作值。

```rust
    fn compile_stmt(&mut self, stmt: &Stmt) {
        let span = stmt.span();
        match stmt {
            Stmt::Expr { expr, .. } => {
                self.compile_expr(expr);
                self.emit(Opcode::Pop, span);
            }
            _ => todo!("statement"),
        }
    }
```

表达式语句的值没人要，所以后面跟一条 `Pop`。其余语句暂时 `todo!()`：和第 7 篇写解析器时一样，先让一条路径跑通，别的以后补。最后是表达式：

```rust
    fn compile_expr(&mut self, expr: &Expr) {
        let span = expr.span();
        match expr {
            Expr::Int { value, .. } => {
                let index = self.chunk.add_constant(Constant::Int(*value));
                self.emit(Opcode::Const(index), span);
            }
            Expr::Binary { op, lhs, rhs, .. } => {
                self.compile_expr(lhs);
                self.compile_expr(rhs);
                self.emit(
                    match op {
                        BinaryOp::Add => Opcode::Add,
                        BinaryOp::Mul => Opcode::Mul,
                        _ => todo!("operator"),
                    },
                    span,
                );
            }
            _ => todo!("expression"),
        }
    }
}
```

整个编译器的精髓就在 `Binary` 这个分支里：**先编译左边，再编译右边，最后输出运算符。** 左右两边各自会产生"把自己的值留在栈顶"的指令序列，运算符指令从栈顶取两个值。这个递归的后序遍历，就是我们写了五篇文章的树变成清单的全过程。

测试放在文件末尾。它是整个 crate 里最严格的一种：不是在文本清单里找子串，而是直接比较指令序列：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use pebble_parser::parse;
    use pebble_span::SourceId;

    fn compile_src(src: &str) -> Chunk {
        let result = parse(SourceId(0), src);
        assert!(result.is_ok(), "parse errors: {:?}", result.diagnostics);
        compile(&result.program)
    }

    #[test]
    fn compiles_arithmetic() {
        let chunk = compile_src("1 + 2 * 3;");
        assert_eq!(
            chunk.code(),
            [
                Opcode::Const(0),
                Opcode::Const(1),
                Opcode::Const(2),
                Opcode::Mul,
                Opcode::Add,
            ]
        );
    }
}
```

`chunk.code()` 是 `&[Opcode]`，右边是 `[Opcode; 5]`，标准库给"切片引用和数组"实现了 `PartialEq`，所以直接 `assert_eq!`。这一行能写，是因为 `opcode_set!` 加了 `PartialEq` 和 `Debug`。

```text
$ cargo test -p pebble-bytecode
running 1 test
test tests::compiles_arithmetic ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

第一版就跑通了：五条指令正是开头那一段输出里的那五条。

## 第三步：包装成 Compiled，让命令行能看见它

`compile` 现在返回一个裸 `Chunk`。但真正的程序有函数：每个函数体是它自己的 `Chunk`，所以顶层的程序也该是"一个叫 `<main>` 的函数"。另外编译期可能出错（`break` 写在循环外面），不能 `panic`，要和解析器一样返回诊断。我们把返回类型改成这样：

```rust
/// A compiled function body.
pub struct FunctionProto {
    /// `Some` for named declarations, `None` for anonymous closures.
    pub name: Option<String>,
    /// Parameter names, in order.
    pub params: Vec<String>,
    /// The function's instruction stream.
    pub chunk: Chunk,
}

impl FunctionProto {
    /// A display name for diagnostics.
    #[must_use]
    pub fn display_name(&self) -> &str {
        self.name.as_deref().unwrap_or("<anonymous>")
    }
}
```

`proto` 是 prototype 的缩写：函数的"原型"，编译产物里不变的那一部分（名字、参数名、指令）。第 12 篇的运行期闭包会是"一个 `proto` 加上它捕获的环境"，和第 9 篇树遍历解释器里的闭包一模一样。`name.as_deref()` 把 `Option<String>` 借成 `Option<&str>`，`unwrap_or` 给匿名函数一个默认名字。

```rust
/// The result of compiling a program.
pub struct Compiled {
    /// The top-level function. Its `chunk` is the program.
    pub main: Rc<FunctionProto>,
}

impl Compiled {
    /// The top-level instruction stream.
    #[must_use]
    pub fn chunk(&self) -> &Chunk {
        &self.main.chunk
    }
}
```

为什么是 `Rc<FunctionProto>`？第 8 篇学过 `Rc`：多个所有者共享同一份数据，引用计数。以后 VM 里每个由这个函数创建的闭包都要指着同一份原型，复制整个 `Chunk` 既慢又没意义。需要 `use std::rc::Rc;`，下面的 `CompileResult` 还要 `use pebble_diag::Diagnostic;`。

```rust
/// Compilation output: the program plus any diagnostics.
pub struct CompileResult {
    pub compiled: Compiled,
    pub diagnostics: Vec<Diagnostic>,
}

impl CompileResult {
    /// Whether compilation produced no diagnostics.
    #[must_use]
    pub fn is_ok(&self) -> bool {
        self.diagnostics.is_empty()
    }
}
```

和第 7 篇解析器的 `ParseResult` 同一个设计：不论有没有错，都交出一个结果，加上诊断列表。`compile` 本身变成：

```rust
#[must_use]
pub fn compile(program: &Program) -> CompileResult {
    let mut compiler = Compiler::new();
    compiler.compile_body(&program.stmts, false);
    CompileResult {
        compiled: Compiled {
            main: Rc::new(FunctionProto {
                name: Some("<main>".to_string()),
                params: Vec::new(),
                chunk: compiler.chunk,
            }),
        },
        diagnostics: compiler.diagnostics,
    }
}
```

`Compiler` 多一个字段，`Default` 派生换成手写的 `new()`：

```rust
struct Compiler {
    chunk: Chunk,
    diagnostics: Vec<Diagnostic>,
}

impl Compiler {
    fn new() -> Self {
        Self {
            chunk: Chunk::new(),
            diagnostics: Vec::new(),
        }
    }
```

`Chunk` 也要有一个 `new()`，它只是 `Self::default()` 的包装：

```rust
    /// An empty chunk.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
```

`#[must_use]` 的理由和第 1 篇一样：忘记接收返回值一定是个 bug。再补上 `Chunk` 的另外几个读取器，它们是整个 crate 对外的只读接口：

```rust
    /// The source span associated with instruction `index`.
    #[must_use]
    pub fn span_at(&self, index: usize) -> Span {
        self.spans.get(index).copied().unwrap_or(Span::DUMMY)
    }

    /// Number of instructions.
    #[must_use]
    pub fn len(&self) -> usize {
        self.code.len()
    }

    /// Whether the chunk is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.code.is_empty()
    }
```

`get(index)` 返回 `Option<&Span>`，`copied()` 把里面的引用变成值（`Span` 是 `Copy`，第 1 篇），`unwrap_or` 给越界的情况一个 `DUMMY`。`is_empty` 是 clippy 的要求：有 `len` 就得有 `is_empty`。

### 反汇编器

现在写让一切可见的函数。它放在 `impl Chunk` 里：

```rust
    /// A human-readable listing, `rustc`-style.
    #[must_use]
    pub fn disassemble(&self) -> String {
        let mut out = String::new();
        out.push_str("== constants ==\n");
        for (index, constant) in self.constants.iter().enumerate() {
            out.push_str(&format!("  {index:>4} {constant:?}\n"));
        }
        out.push_str("== code ==\n");
        for (index, op) in self.code.iter().enumerate() {
            let operand = match op {
                Opcode::Const(index) => format!(" {index}"),
                _ => String::new(),
            };
            out.push_str(&format!("  {index:>4} {}{operand}\n", op.name()));
        }
        out
    }
```

`{index:>4}` 是第 3 篇的格式迷你语言：右对齐、宽度 4。`op.name()` 来自宏，`operand` 是带载荷指令后面的数字。这个函数后面会长大（跳转、嵌套函数），但骨架就是这样。

### 测试跟着改

`compile` 返回的类型变了，第一版的测试要重写。辅助函数现在返回 `Compiled`，并且要求诊断列表为空：

```rust
    fn compile_src(src: &str) -> Compiled {
        let result = parse(SourceId(0), src);
        assert!(result.is_ok(), "parse errors: {:?}", result.diagnostics);
        let compiled = compile(&result.program);
        assert!(
            compiled.is_ok(),
            "compile errors: {:?}",
            compiled.diagnostics
        );
        compiled.compiled
    }
```

测试本身我换了一种写法：不再比较整个指令序列，而是在反汇编出来的清单里找子串。三个基础测试：

```rust
    #[test]
    fn compiles_arithmetic() {
        let compiled = compile_src("1 + 2 * 3;");
        let listing = compiled.chunk().disassemble();
        assert!(listing.contains("Const"), "{listing}");
        assert!(listing.contains("Mul"), "{listing}");
        assert!(listing.contains("Add"), "{listing}");
    }

    #[test]
    fn non_trailing_expression_statements_are_popped() {
        let compiled = compile_src("1 + 2; 3;");
        let listing = compiled.chunk().disassemble();
        assert!(listing.contains("Pop"), "{listing}");
    }

    #[test]
    fn trailing_expression_is_the_program_value() {
        let compiled = compile_src("1; 2;");
        // The last expression is not popped, so the VM can return it.
        let code = compiled.chunk().code();
        assert_eq!(code.last(), Some(&Opcode::Const(1)));
    }
```

第三个守着前面讲的那个约定：最后一条表达式的值不弹出，所以最后一条指令是 `Const 1`，不是 `Pop`。子串测试对"不相干的指令变了"很耐受（我加一条新指令，不会让 `compiles_arithmetic` 红），代价是它们看不见**顺序**。这个代价会在 for 循环那一节兑现：我会故意弄坏一行，看这些测试漏掉了什么。

### 命令行第三版，第一半：`--dump-bytecode`

让命令行能调用它。三处小改动。`crates/pebble-cli/Cargo.toml` 的依赖里，`pebble-interp` 后面加一行：

```toml
pebble-bytecode.workspace = true
```

`crates/pebble-cli/src/cli.rs` 的 `RunArgs`，在 `ast` 字段后面加一个开关：

```rust
    /// Print the compiled bytecode disassembly before running.
    #[arg(long)]
    pub(crate) dump_bytecode: bool,
```

clap 的魔法和第 7 篇一样：字段名 `dump_bytecode` 变成 `--dump-bytecode`，文档注释变成帮助文字。`crates/pebble-cli/src/commands.rs` 的 `run`，在 `args.ast` 那个 `if` 后面加：

```rust
    if args.dump_bytecode {
        let compiled = compile(&parsed.program);
        if sources::emit(&compiled.diagnostics, &source.map) {
            return Ok(1);
        }
        print!("{}", compiled.compiled.chunk().disassemble());
    }
```

别忘了文件头的 `use pebble_bytecode::compile;`。这是命令行的第一次编译：解析之后、解释之前，插一段"编译并打印清单"。编译出错就停下，和解析出错的处理方式一样。解释器仍然是 `Interpreter`，这一版命令行还没有第二个后端。

```text
$ pebble run --dump-bytecode 1.pebble
== constants ==
     0 Int(1)
     1 Int(2)
     2 Int(3)
== code ==
     0 Const 0
     1 Const 1
     2 Const 2
     3 Mul
     4 Add
7
```

能用。但 `Int(1)` 太吵了：我想看到的是常量的值，不是它的类型标签。这个等一下改，先试一下我们还不支持的东西：

```text
$ pebble run --dump-bytecode examples/fib.pebble

thread 'main' (123062) panicked at crates/pebble-bytecode/src/lib.rs:225:18:
not yet implemented: statement
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
```

这就是第 7 篇那个"先写 `todo!()`，让它自己告诉你下一步写什么"。`fib.pebble` 的第一条语句是 `fn`，我们的编译器对它说"没实现"。接下来一节一节把洞补上。每补一节，测试都会通过，我们也可以用 `--dump-bytecode` 随时看结果。

## 第四步：常量池

`Const 0` 里的 `0` 是什么？是**常量池**的下标。字面量 `3` 不直接写在指令里，而是放进 `Chunk` 的一张表，指令里只写它的位置。C 程序员见过这个设计：ELF 文件的 `.rodata` 段和字符串表就是同一个想法，代码里只放地址，数据放在另一个地方。好处有两个：每条指令保持固定大小（字符串字面量可以任意长），同一个字面量在整张表里只存一份。

我们先把 `Constant` 补全。它要能放 `nil`、布尔、整数、浮点、字符串，以及一个"嵌套的函数体"（下面写函数的时候用）：

```rust
/// A compile-time constant.
pub enum Constant {
    Nil,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    /// A nested function or closure body.
    Function(Rc<FunctionProto>),
}
```

注意**这次没有 `#[derive(Debug)]`**，我要手写。理由刚才你看到了：派生版本打印 `Int(1)`，我想要 `1`；字符串应该带引号打印，这样整数 `1` 和字符串 `"1"` 在清单里是两个不同的东西；函数常量不该把整个 `Chunk` 打印出来，一个 `<function fib>` 就够了。手写 `Debug` 是第 3 篇学过的 `fmt::Formatter`：

```rust
impl fmt::Debug for Constant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Constant::Nil => f.write_str("nil"),
            Constant::Bool(value) => write!(f, "{value}"),
            Constant::Int(value) => write!(f, "{value}"),
            Constant::Float(value) => write!(f, "{value}"),
            Constant::Str(value) => write!(f, "{value:?}"),
            Constant::Function(proto) => write!(f, "<function {}>", proto.display_name()),
        }
    }
}
```

`{value:?}` 对 `String` 用的是 `String` 自己的 `Debug`，它会加引号并转义。需要 `use std::fmt;`。

### 去重：为什么 Constant 没有 PartialEq

常量池的卖点是去重：编译 `1 + 1 + 1` 时，`1` 只该存一份。判断"这两个常量是同一个吗"最顺手的做法是给 `Constant` 派生 `PartialEq`。我没有这么做，因为浮点数。实验室里 `ch10_float_bits.rs`：

```text
$ cargo run --quiet --bin ch10_float_bits
0.0 == -0.0        -> true
NaN == NaN         -> false
bits equal 0/-0    -> false
bits equal NaN/NaN -> true
```

`f64` 的 `==` 遵循 IEEE 754：`0.0 == -0.0` 是真，`NaN == NaN` 是假。作为数学相等这没问题，作为"这两个常量能不能共用一格"就错了：把 `-0.0` 折叠进 `0.0` 会让 `1.0 / -0.0` 悄悄变成 `+inf`；而 `NaN` 永远不等于自己，意味着永远不去重，白占位置（现在的解析器不会产生这样的字面量，这是为以后常量折叠留的保险）。我们要的是**逐比特相同**，所以手写一个自己的比较，不叫 `==`，叫 `same`：

```rust
impl Constant {
    fn same(&self, other: &Constant) -> bool {
        match (self, other) {
            (Constant::Nil, Constant::Nil) => true,
            (Constant::Bool(a), Constant::Bool(b)) => a == b,
            (Constant::Int(a), Constant::Int(b)) => a == b,
            (Constant::Float(a), Constant::Float(b)) => a.to_bits() == b.to_bits(),
            (Constant::Str(a), Constant::Str(b)) => a == b,
            // Function prototypes are never deduplicated.
            _ => false,
        }
    }
}
```

`(self, other)` 是个元组，`match` 同时拆开两边（第 3 篇）。最后的 `_ => false` 同时管着两件事：不同种类的常量当然不相同，函数原型永远不去重（两个函数即使字节一模一样，运行起来也是两个不同的闭包）。`to_bits()` 把 `f64` 看成它的 64 个比特，整数比较。

接着往 `impl Chunk` 里加 `intern`：

```rust
    /// Adds a scalar constant, reusing an identical one already in the pool.
    ///
    /// Function prototypes are never deduplicated.
    pub(crate) fn intern(&mut self, constant: Constant) -> u32 {
        if !matches!(constant, Constant::Function(_))
            && let Some(position) = self
                .constants
                .iter()
                .position(|existing| existing.same(&constant))
        {
            return position as u32;
        }
        self.add_constant(constant)
    }
```

这里有一个新语法：`if A && let Some(x) = B { ... }`，**let 链**（let chains）。条件里可以把布尔表达式和模式匹配用 `&&` 串起来，任何一环失败就整体失败，成功时 `position` 在块里可用。这是 2024 版的特性（Rust 1.88 起稳定，所以第 1 篇的工作区 `rust-version` 是 `1.88`）。没有它，你得写嵌套的 `if` 加 `if let`，或者先算出 `Option` 再拿去 `match`。`position` 返回第一个满足闭包的元素的下标。

`pub(crate)` 是第 7 篇的可见性：只有这个 crate 里的代码能调它。外面的人想往常量池塞东西，走 `add_constant`（不去重），以免外部代码误以为 `intern` 对函数原型也去重。

### 补上字面量

现在补上 `Nil`、`True`、`False` 两条指令和字面量的编译。在 `opcode_set!` 里，`Nil` 后面加：

```rust
        /// Push `true`.
        True,
        /// Push `false`.
        False,
```

`compile_expr` 的 `match` 里，`Expr::Int` 那个分支换成用 `intern`，并补上其他字面量：

```rust
            Expr::Nil { .. } => {
                self.emit(Opcode::Nil, span);
            }
            Expr::Bool { value, .. } => {
                self.emit(if *value { Opcode::True } else { Opcode::False }, span);
            }
            Expr::Int { value, .. } => {
                let index = self.chunk.intern(Constant::Int(*value));
                self.emit(Opcode::Const(index), span);
            }
```

`Float` 和 `Str` 的写法和 `Int` 一模一样，只换 `Constant::Float(*value)` 和 `Constant::Str(value.clone())`。`value.clone()` 是因为 AST 拥有这个 `String`，我们只借着 AST，常量池要自己的一份。

布尔和 `nil` 没有进常量池：它们各自只有一两个取值，一条无操作数的指令就够了，不值得绕一个下标。

测试：

```rust
    #[test]
    fn constants_are_deduplicated() {
        let compiled = compile_src("1 + 1 + 1; \"x\"; \"x\";");
        let ints = compiled
            .chunk()
            .constants()
            .iter()
            .filter(|c| matches!(c, Constant::Int(1)))
            .count();
        let strings = compiled
            .chunk()
            .constants()
            .iter()
            .filter(|c| matches!(c, Constant::Str(s) if s == "x"))
            .count();
        assert_eq!(ints, 1);
        assert_eq!(strings, 1);
    }
```

`matches!(c, Constant::Str(s) if s == "x")` 是第 7 篇学的 `matches!`，这次带了守卫：只有字符串内容是 `"x"` 才算数。

## 第五步：名字

变量怎么编译？`let x = 1;` 要"把名字 `x` 绑定到值 `1`"，`x` 要"找到这个名字的值"，`x = 2` 要"改已有的绑定"。我们引入三条指令，操作数都是**名字在常量池里的下标**（名字是字符串常量）：

```rust
        /// Define `constants[operand]` in the current frame.
        DefineName(u32),
        /// Push the value of `constants[operand]`.
        GetName(u32),
        /// Assign to the existing binding `constants[operand]`, leaving the
        /// value on the stack.
        SetName(u32),
```

把它们加到 `opcode_set!` 里 `Pop` 的后面。注意是**按名字**：指令里没有"第几个局部变量"，运行时靠名字去环境里找，和第 9 篇的树遍历解释器一样。这让闭包简单到极点（闭包捕获整个环境，找名字沿着环境链往上），代价是速度：每次读变量都是一次哈希查找。生产级的编译器会在编译期把名字解析成槽位下标，再为闭包单独处理"上值"，Lua 就是这么做的。这是第 12 篇里要量一量的东西，现在先接受它。

三个新指令要用名字的常量下标，所以需要一个辅助函数：`name_const(name)`，给我一个名字的常量下标，没有就加进去。第一版很自然：我已经有 `intern`，名字不过是字符串常量，对吧？但每次变量引用都要线性扫描一遍常量池，我想加一张哈希表缓存"名字到下标"。这就是 `HashMap` 的 `entry` API 登场的地方：

```rust
use std::collections::HashMap;

struct Compiler {
    chunk: Chunk,
    names: HashMap<String, u32>,
    diagnostics: Vec<Diagnostic>,
}
```

`new()` 里也要加 `names: HashMap::new()`。那么 `name_const`，我的第一稿是这么写的：`intern` 放在 `Compiler` 上（因为 `compile_expr` 到处都要用它），`name_const` 调用它（你不用真的敲这个版本，下面的输出是我敲出来抓的）：

```rust
    /// The constant-pool index of `name`, interned on first use.
    fn name_const(&mut self, name: &str) -> u32 {
        *self
            .names
            .entry(name.to_owned())
            .or_insert_with(|| self.intern(Constant::Str(name.to_owned())))
    }
```

`entry(key)` 返回一个 `Entry`，表示"这个键对应的槽位，可能有值，可能没有"；`or_insert_with(f)` 说"有就用现成的，没有就调 `f()` 生成一个放进去"，两种情况都返回指向槽位里值的 `&mut u32`，开头那个 `*` 把它读成 `u32`。C++ 里最接近的是 `unordered_map::try_emplace`，或者 `m[key]` 的默认构造再赋值，都是只哈希一次完成"查找或插入"。如果不用 `entry`，你得先 `get` 一次、没有再 `insert` 一次，哈希两次。

那一版编译不过。真实输出：

```text
error[E0500]: closure requires unique access to `*self` but it is already borrowed
   --> crates/pebble-bytecode/src/lib.rs:262:29
    |
259 |           *self
    |  __________-
260 | |             .names
    | |__________________- borrow occurs here
261 |               .entry(name.to_owned())
262 |               .or_insert_with(|| self.intern(Constant::Str(name.to_owned())))
    |                -------------- ^^ ---- second borrow occurs due to use of `*self` in closure
    |                |              |
    |                |              closure construction occurs here
    |                first borrow later used by call
...
```

读法是：`self.names.entry(..)` 对 `self.names` 做了一次可变借用，这个借用在 `or_insert_with` 返回之前一直活着。而闭包 `|| self.intern(..)` 要对整个 `*self` 做可变借用，因为 `intern` 是个 `&mut self` 方法，它**可能**改任何字段，包括正被借用的 `names`。两个可变借用重叠，第 2 篇的"别名和可变不能同时存在"。换成 C++，没有任何东西拦你写出结构相同的代码，要是换成 `vector` 或开放寻址的哈希表，`intern` 恰好触发了扩容，手里那个指向槽位的引用就悬空了，未定义行为；Rust 在编译期就说不。

实验室里 `ch10_capture.rs` 把这个问题缩到最小（一个 `Vec<String>` 做池子，一个 `HashMap` 做名字表），编译器给出同样的 E0500：

```text
error[E0500]: closure requires unique access to `*self` but it is already borrowed
  --> src/bin/ch10_capture.rs:18:29
   |
15 |           *self
   |  __________-
16 | |             .names
   | |__________________- borrow occurs here
17 |               .entry(name.to_owned())
18 |               .or_insert_with(|| self.add(name))
   |                -------------- ^^ ---- second borrow occurs due to use of `*self` in closure
   |                |              |
   |                |              closure construction occurs here
   |                first borrow later used by call
...
```

出路：别让闭包碰整个 `self`，只碰它真正需要的**字段**。从 2021 版开始，闭包是**按字段捕获**的：如果闭包里只写了 `self.pool.push(..)`，它只借 `self.pool`，不借 `self.names`，两个借用互不重叠，编译器放行。实验室里 `ch10_capture_ok.rs` 把方法体直接内联进闭包：

```text
$ cargo run --quiet --bin ch10_capture_ok
0 1 0
pool = ["x", "y"]
```

`x` 第二次查询得到 `0`，没有再往池子里加一份。真实代码里不想把整个 `intern` 内联，于是把 `intern` 挪到 `Chunk` 上（我们上一节已经这么写了）：它只借 `self.chunk`，`name_const` 变成这样，和上面的失败版本只差 `self.chunk.intern`：

```rust
    /// The constant-pool index of `name`, interned on first use.
    fn name_const(&mut self, name: &str) -> u32 {
        *self
            .names
            .entry(name.to_owned())
            .or_insert_with(|| self.chunk.intern(Constant::Str(name.to_owned())))
    }
```

闭包只用 `self.chunk`，`entry` 只用 `self.names`，不同字段，编译通过。这也是为什么 `intern` 在 `Chunk` 上而不在 `Compiler` 上：不是美学，是借用检查器逼的。

这张哈希表值得吗？我在一个临时测试里量了一下（release 构建，这台机器）：20000 个互不相同的变量，每个 `let` 一次再引用一次。有 `names` 表的版本编译用 386 到 395 ms，去掉表、直接 `self.chunk.intern(..)` 的版本 731 到 753 ms，大约两倍。只有两倍的原因：每个**新**名字第一次出现时仍然要在池子里线性扫一遍，哈希表只省了重复引用的那一次。整个编译在"不同常量个数"上依旧是平方级的。真正的修法是让常量池自己用哈希去重，我没做。（这台机器上的数字，一次性的临时测试，不是基准，别太当真；要点是 `entry` 让"查或插"只哈希一次。）

### 编译 let、变量和赋值

`compile_stmt` 里加 `let`：

```rust
            Stmt::Let { name, value, .. } => {
                self.compile_expr(value);
                let index = self.name_const(&name.name);
                self.emit(Opcode::DefineName(index), span);
            }
```

先编译右边（值留在栈顶），再 `DefineName` 把栈顶弹出，绑定到名字。`compile_expr` 里加变量读取和赋值（对索引赋值留到后面）：

```rust
            Expr::Var { name, .. } => {
                let index = self.name_const(&name.name);
                self.emit(Opcode::GetName(index), span);
            }
```

赋值是 `Expr::Assign`，目标是个变量时的分支如下。下标赋值和非法目标先留一个 `todo!()`，第九步再补：

```rust
            Expr::Assign { target, value, .. } => match target.as_ref() {
                Expr::Var { name, .. } => {
                    self.compile_expr(value);
                    let index = self.name_const(&name.name);
                    self.emit(Opcode::SetName(index), span);
                }
                _ => todo!("assignment target"),
            },
```

赋值 `x = value` 也是先编译右边，然后 `SetName`。注意注释里的细节：`SetName` **把值留在栈上**，因为赋值在 Pebble 里是个表达式（`a = b = 3` 合法）。表达式语句会跟一条 `Pop` 把它扔掉。看 `names.pebble`（`let x = 1; x = x + 2; x;`）：

```text
$ pebble run --dump-bytecode names.pebble
== constants ==
     0 1
     1 "x"
     2 2
== code ==
     0 Const 0
     1 DefineName 1
     2 GetName 1
     3 Const 2
     4 Add
     5 SetName 1
     6 Pop
     7 GetName 1
3
```

三个常量：整数 `1`，字符串 `"x"`（引号告诉你它是名字，不是数字，这就是手写 `Debug` 的回报），整数 `2`。`x` 的下标 `1` 在 `DefineName`、`GetName`、`SetName` 里都是同一个，因为 `names` 缓存把它们折叠了。第 5 条是 `SetName`，第 6 条 `Pop` 把赋值表达式的值扔掉，因为这是一条语句。最后一条 `GetName 1` 没有 `Pop`：它是整个程序的值，解释器打印出 `3`。

## 第六步：补全运算符

`1 + 2 * 3` 里只有加和乘。其他运算符：减、除、取余、取负、逻辑非、六个比较。在 `opcode_set!` 里把 `Add`、`Mul` 的位置换成完整的一组：

```rust
        /// `a + b`
        Add,
        /// `a - b`
        Sub,
        /// `a * b`
        Mul,
        /// `a / b`
        Div,
        /// `a % b`
        Rem,
        /// `-a`
        Neg,
        /// `not a`
        Not,
        /// `a == b`
        Equal,
        /// `a != b`
        NotEqual,
        /// `a < b`
        Less,
        /// `a <= b`
        LessEqual,
        /// `a > b`
        Greater,
        /// `a >= b`
        GreaterEqual,
```

编译器侧：`BinaryOp` 到 `Opcode` 的映射是一个独立的 `const fn`，放在 `impl Compiler` 外面：

```rust
const fn arithmetic_opcode(op: BinaryOp) -> Opcode {
    match op {
        BinaryOp::Add => Opcode::Add,
        BinaryOp::Sub => Opcode::Sub,
        BinaryOp::Mul => Opcode::Mul,
        BinaryOp::Div => Opcode::Div,
        BinaryOp::Rem => Opcode::Rem,
        BinaryOp::Eq => Opcode::Equal,
        BinaryOp::NotEq => Opcode::NotEqual,
        BinaryOp::Lt => Opcode::Less,
        BinaryOp::LtEq => Opcode::LessEqual,
        BinaryOp::Gt => Opcode::Greater,
        BinaryOp::GtEq => Opcode::GreaterEqual,
    }
}
```

没有 `_` 通配分支。这是故意的：以后有人在 AST 的 `BinaryOp` 里加一个 `Pow`，这里会立刻 E0004 提醒他。`BinaryOp` 是 `Copy` 的（第 5 篇），所以按值传。`compile_expr` 里原来的 `Binary` 分支和新增的 `Unary` 分支变成：

```rust
            Expr::Unary { op, operand, .. } => {
                self.compile_expr(operand);
                self.emit(
                    match op {
                        UnaryOp::Neg => Opcode::Neg,
                        UnaryOp::Not => Opcode::Not,
                    },
                    span,
                );
            }
            Expr::Binary { op, lhs, rhs, .. } => {
                self.compile_expr(lhs);
                self.compile_expr(rhs);
                self.emit(arithmetic_opcode(*op), span);
            }
```

`use pebble_ast::{BinaryOp, Expr, LogicalOp, Program, Spanned, Stmt, UnaryOp};` 这一行同时把后面要用的 `LogicalOp` 也带上。

## 第七步：跳转和回填

`if cond { A } else { B }` 怎么变成一串线性指令？

```text
    <cond>
    JumpIfFalse -> ELSE
    <A>
    Jump -> END
ELSE:
    <B>
END:
```

`JumpIfFalse` 要写"目标是 `ELSE` 的下标"，但编译到这条指令时我们还没编译 `A`，不知道 `ELSE` 在哪。C 程序员熟悉这个问题：汇编器遇到向前的 `goto` 标签时，也不知道标签的地址。解法有两种：两遍扫描（第一遍记下所有标签，第二遍填）；或者**回填**（backpatching）：先发一条目标留空的跳转，记下它的位置，等目标确定了再回来改。像写一封信里"详见第 __ 页"，先空着，写到那一页的时候再翻回去补。

跳转指令加入 `opcode_set!`：

```rust
        /// Jump to an absolute instruction index.
        Jump(u32),
        /// Pop, then jump if the value was falsy.
        JumpIfFalse(u32),
        /// Peek: if falsy, jump keeping the value; otherwise pop and continue.
        JumpIfFalseKeep(u32),
        /// Peek: if truthy, jump keeping the value; otherwise pop and continue.
        JumpIfTrueKeep(u32),
```

后两条（`Keep` 版）是给 `and`/`or` 用的，下面讲。目标是**绝对的指令下标**。`impl Chunk` 里加两个方法：

```rust
    /// Appends a placeholder that will be patched once its target is known.
    fn placeholder(&mut self, op: Opcode, span: Span) -> usize {
        self.emit(op, span)
    }

    /// Points a previously emitted jump at `target`.
    ///
    /// # Panics
    /// Panics if `at` is not a jump instruction; that would be a compiler bug.
    pub fn patch_jump(&mut self, at: usize, target: usize) {
        let target = target as u32;
        self.code[at] = match self.code[at] {
            Opcode::Jump(_) => Opcode::Jump(target),
            Opcode::JumpIfFalse(_) => Opcode::JumpIfFalse(target),
            Opcode::JumpIfFalseKeep(_) => Opcode::JumpIfFalseKeep(target),
            Opcode::JumpIfTrueKeep(_) => Opcode::JumpIfTrueKeep(target),
            ref other => panic!("cannot patch {other:?} as a jump"),
        };
    }
```

`placeholder` 只是 `emit` 的别名，让调用处的意图更清楚（"这条的目标是空的，后面要补"）。典型的用法：`let at = chunk.placeholder(Opcode::Jump(0), span);`，操作数 `0` 是占位符，没有意义；返回的 `at` 是这条指令的下标，之后交给 `patch_jump(at, target)`。

`patch_jump` 里有两个值得停下来的东西。第一，`match self.code[at]` 匹配的是一个**位置**（`Vec` 的一个槽位）而不是一个值。第二，最后一个分支里的 `ref other`：第 9 篇只提过一句"默认绑定模式让你不用写 `ref`"，现在第一次真的写出来。通常 `other => ...` 会把被匹配的值**移动**进 `other`；加了 `ref` 就改成**借用**。看实验室 `ch10_ref_binding.rs`，它用一个不是 `Copy` 的枚举：

```text
error[E0507]: cannot move out of index of `Vec<Token>`
  --> src/bin/ch10_ref_binding.rs:11:22
   |
11 |     code[at] = match code[at] {
   |                      ^^^^^^^^
12 |         Token::Jump(_) => Token::Jump(7),
13 |         other => panic!("cannot patch {other:?} as a jump"),
   |         -----
   |         |
   |         data moved here
   |         move occurs because `other` has type `Token`, which does not implement the `Copy` trait
   |
help: consider borrowing here
   |
11 |     code[at] = match &code[at] {
   |                      +
...
```

你不能从 `Vec` 里把一个元素"拿走"，留下一个空洞（C++ 里这叫 moved-from，对象还在，状态不明；Rust 干脆不允许）。`ref other` 就是"我只想看一眼"。换成 `ref other` 之后（`ch10_ref_binding_ok.rs`）输出 `[Jump(7), Name("x")]`。

但对 `Opcode` 呢？它是 `Copy` 的，我试了：把 `ref` 去掉，`cargo build` 和 `cargo clippy -- -D warnings` 都照样通过，`other` 只是复制了一份。所以这里的 `ref` 不是必须的，是为了让读代码的人一眼看出"这个分支不消耗它"，以及万一哪天 `Opcode` 不再是 `Copy` 也不会突然炸。我保留了它。

`target as u32` 是第 1 篇的 `as`：如果程序超过 40 亿条指令会悄悄截断，我选择不理会，这个编译器的输入是人写的脚本。

### if

回到 `Compiler`。先加一个小工具 `here`，"下一条指令会放在哪个下标"：

```rust
    fn here(&self) -> usize {
        self.chunk.len()
    }
```

`compile_stmt` 里的 `if`：

```rust
            Stmt::If {
                cond,
                then_branch,
                else_branch,
                ..
            } => {
                self.compile_expr(cond);
                let jump_else = self.chunk.placeholder(Opcode::JumpIfFalse(0), span);
                for stmt in then_branch {
                    self.compile_stmt(stmt);
                }
                let jump_end = self.chunk.placeholder(Opcode::Jump(0), span);
                let else_target = self.here();
                self.chunk.patch_jump(jump_else, else_target);
                for stmt in else_branch {
                    self.compile_stmt(stmt);
                }
                let end = self.here();
                self.chunk.patch_jump(jump_end, end);
            }
```

对着前面的模板读一遍：发条件；发一条目标待定的 `JumpIfFalse`，记下它的下标；编译 `then`；发一条目标待定的 `Jump`（跳过 `else`）；**此刻**的 `here()` 就是 `ELSE` 的位置，回头补上第一条；编译 `else`；`here()` 又是 `END`，补上第二条。真实输出，`if true { 1; } else { 2; }`：

```text
$ pebble run --dump-bytecode ifelse.pebble
== constants ==
     0 1
     1 2
== code ==
     0 True
     1 JumpIfFalse -> 5
     2 Const 0
     3 Pop
     4 Jump -> 7
     5 Const 1
     6 Pop
     7 Nil
```

条件为假时第 1 条跳到 5（`else` 的 `Const 1`），为真时顺着走完 2、3，第 4 条 `Jump -> 7` 跳过 `else`。7 是整个程序的末尾：`if` 是语句，最后一条语句不是表达式，所以编译器按约定补了一条 `Nil` 当作程序的值。`->` 后面这些数字，没有一个是我写的，都是回填填的。disassemble 里要给跳转指令一个 `->` 的显示格式，把它加进上面 `match op` 的分支里：

```rust
                Opcode::Jump(target)
                | Opcode::JumpIfFalse(target)
                | Opcode::JumpIfFalseKeep(target)
                | Opcode::JumpIfTrueKeep(target) => format!(" -> {target}"),
```

这里用了**或模式**：四个变体共享同一个分支，它们都有一个叫 `target` 的 `u32` 载荷。

### while

循环不一样：回跳的目标（循环开头）在编译循环体之前就已经知道了，是**向后**跳，不需要回填；但循环**出口**的目标（循环结束处）是向前的，要回填。而且循环体里可能有 `break` 和 `continue`，它们也要跳到这两个位置，但它们可能嵌在 `if` 的深处，编译到它们的时候我们不在 `while` 的那段代码里。解决办法是一个小栈，记着"当前有哪些循环，每个循环里有哪些待补的 `break`/`continue`"：

```rust
/// Bookkeeping for one enclosing loop, so `break`/`continue` can be patched.
#[derive(Default)]
struct LoopCtx {
    continue_jumps: Vec<usize>,
    break_jumps: Vec<usize>,
}
```

`Compiler` 多一个字段 `loops: Vec<LoopCtx>`（`new()` 里 `loops: Vec::new()`）。`while` 的编译：

```rust
            Stmt::While { cond, body, .. } => {
                let loop_start = self.here();
                self.compile_expr(cond);
                let exit = self.chunk.placeholder(Opcode::JumpIfFalse(0), span);
                self.loops.push(LoopCtx::default());
                for stmt in body {
                    self.compile_stmt(stmt);
                }
                let ctx = self.loops.pop().expect("loop context");
                self.emit(Opcode::Jump(loop_start as u32), span);
                let end = self.here();
                self.chunk.patch_jump(exit, end);
                for jump in ctx.break_jumps {
                    self.chunk.patch_jump(jump, end);
                }
                for jump in ctx.continue_jumps {
                    self.chunk.patch_jump(jump, loop_start);
                }
            }
```

进入循环体前往栈里压一个 `LoopCtx`；编译体的时候，遇到 `break`/`continue` 的代码会把它们的占位跳转记在栈顶那个 `LoopCtx` 里；体编译完，弹出这个 `LoopCtx`，循环尾发回跳 `Jump(loop_start)`，然后把所有记下来的 `break` 补到 `end`、`continue` 补回 `loop_start`。`expect("loop context")` 是第 7 篇讲的"这里 `None` 就是我的 bug"：刚刚才 `push` 过，必然非空。真实输出，`let i = 0; while i < 3 { i = i + 1; }`：

```text
$ pebble run --dump-bytecode loop.pebble
== constants ==
     0 0
     1 "i"
     2 3
     3 1
== code ==
     0 Const 0
     1 DefineName 1
     2 GetName 1
     3 Const 2
     4 Less
     5 JumpIfFalse -> 12
     6 GetName 1
     7 Const 3
     8 Add
     9 SetName 1
    10 Pop
    11 Jump -> 2
    12 Nil
```

第 11 条 `Jump -> 2` 就是回边：向后，直接指向循环开头的条件检查。第 5 条 `JumpIfFalse -> 12` 是回填的出口。

`break` 和 `continue` 本身：

```rust
            Stmt::Break { .. } => {
                let jump = self.chunk.placeholder(Opcode::Jump(0), span);
                if let Some(ctx) = self.loops.last_mut() {
                    ctx.break_jumps.push(jump);
                } else {
                    self.diagnostics.push(
                        Diagnostic::error("`break` outside a loop")
                            .with_code("E3001")
                            .with_span(span),
                    );
                }
            }
```

发一条占位 `Jump`，然后看栈顶有没有循环：有，记下来；没有，就是用户写错了，往 `self.diagnostics` 里推一条错误。`last_mut()` 返回 `Option<&mut LoopCtx>`，和第 3 篇的 `Diagnostic` 构建器（`error`、`with_code`、`with_span`）接上了。`Stmt::Continue` 完全对称：改成 `continue_jumps`，消息 `` `continue` outside a loop``，错误码 `E3002`。

看一个把两者都用上的程序，`while true { if true { break; } continue; }`：

```text
$ pebble run --dump-bytecode brk.pebble
== constants ==
== code ==
     0 True
     1 JumpIfFalse -> 8
     2 True
     3 JumpIfFalse -> 6
     4 Jump -> 8
     5 Jump -> 6
     6 Jump -> 0
     7 Jump -> 0
     8 Nil
```

逐条读：0、1 是 `while true` 的条件和出口（出口是 8）；2、3 是内层 `if true` 的条件和"不进 then 就跳到 6"；4 是 `break`（目标 8，循环出口）；5 是 `if` 的 then 分支末尾"跳过 else"，没有 `else`，所以目标 6，下一条；6 是 `continue`（目标 0，循环开头）；7 是循环尾的回边。

### and 和 or：短路，但保留值

`a or 5` 在 Pebble 里（和 Lua、Python 一样）返回**操作数**，不是布尔：`nil or 5` 是 `5`，`3 or 5` 是 `3`。这要求跳转指令在跳的时候**不弹出**栈顶的值，所以才有了 `JumpIfTrueKeep` 和 `JumpIfFalseKeep`：

```rust
            Expr::Logical { op, lhs, rhs, .. } => {
                self.compile_expr(lhs);
                let keep = match op {
                    LogicalOp::And => self.chunk.placeholder(Opcode::JumpIfFalseKeep(0), span),
                    LogicalOp::Or => self.chunk.placeholder(Opcode::JumpIfTrueKeep(0), span),
                };
                self.compile_expr(rhs);
                let end = self.here();
                self.chunk.patch_jump(keep, end);
            }
```

规则：`Keep` 版的跳转**看一眼**栈顶（不弹出）。`or`：真值就跳走，值留着当整个表达式的结果；假值就弹掉继续算右边。`and` 反过来。右边算完，栈顶就是结果。`let a = nil; a or 5;`：

```text
$ pebble run --dump-bytecode logic.pebble
== constants ==
     0 "a"
     1 5
== code ==
     0 Nil
     1 DefineName 0
     2 GetName 0
     3 JumpIfTrueKeep -> 5
     4 Const 1
5
```

`a` 是 `nil`，是假值，第 3 条不跳，弹掉它，第 4 条压 `5`，程序的值是 `5`。（跳转目标 5 恰好等于指令总数：一个"跳到末尾之后"的下标，意思是"执行完了"。第 12 篇的 VM 主循环在指令下标走到末尾时结束，所以这是合法的。）

加上这些测试，覆盖 `if`、`while`、`break`、逻辑运算：

```rust
    #[test]
    fn if_compiles_to_a_patched_forward_jump() {
        let compiled = compile_src("if true { 1; } else { 2; }");
        let listing = compiled.chunk().disassemble();
        assert!(listing.contains("JumpIfFalse ->"), "{listing}");
        assert!(listing.contains("Jump ->"), "{listing}");
    }

    #[test]
    fn logical_operators_short_circuit_with_keeping_jumps() {
        let compiled = compile_src("a and b; a or b;");
        let listing = compiled.chunk().disassemble();
        assert!(listing.contains("JumpIfFalseKeep"), "{listing}");
        assert!(listing.contains("JumpIfTrueKeep"), "{listing}");
    }
```

还差三个测试。`break` 写在循环外面要得到诊断，这个我们自己写：

```rust
    #[test]
    fn break_outside_a_loop_is_a_diagnostic() {
        let result = parse(SourceId(0), "break;");
        let compiled = compile(&result.program);
        assert!(
            compiled
                .diagnostics
                .iter()
                .any(|d| d.code.as_deref() == Some("E3001"))
        );
    }
```

这里故意只 `parse` 不断言解析成功：`break;` 在语法上合法，错在语义，是编译器的活。`d.code` 是 `Option<String>`，`as_deref()` 借成 `Option<&str>`，才能和 `Some("E3001")` 比较。

另外两个，`while_back_edge_points_backwards`（回边的目标比自己小）和 `break_and_continue_are_patched`（直接比较指令序列里的下标），和上面的清单是同一个思路，直接从 [tag 里的测试](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-bytecode/src/lib.rs) 复制，从 `fn while_back_edge_points_backwards` 到 `fn break_and_continue_are_patched`。到这里的第一次完整检查：

```text
$ cargo test -p pebble-bytecode
running 9 tests
test tests::constants_are_deduplicated ... ok
test tests::break_and_continue_are_patched ... ok
test tests::break_outside_a_loop_is_a_diagnostic ... ok
test tests::if_compiles_to_a_patched_forward_jump ... ok
test tests::logical_operators_short_circuit_with_keeping_jumps ... ok
test tests::compiles_arithmetic ... ok
test tests::non_trailing_expression_statements_are_popped ... ok
test tests::trailing_expression_is_the_program_value ... ok
test tests::while_back_edge_points_backwards ... ok

test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```


## 第八步：函数

函数是编译器里最有意思的一块，因为它让"一个程序"变成"一组程序"。每个函数体是它自己的指令序列，有自己的常量池，外层函数的常量池里放着它。运行时有两件事要发生：把这个函数变成一个**值**（闭包，捕获当前环境），以及**调用**它。对应三条指令，其中 `Return` 我们早就加过了：

```rust
        /// Build a closure from the function prototype `constants[operand]`,
        /// capturing the current frame.
        MakeClosure(u32),
        /// Call the callee sitting below `operand` arguments.
        Call(u32),
```

`MakeClosure` 的操作数指向常量池里一个 `Constant::Function`；`Call(n)` 的约定是：栈上依次是被调用的东西和它的 n 个参数，**被调用者在参数下面**：

```text
   栈：[ ..., callee, arg1, arg2 ]      Call 2
   之后：[ ..., result ]
```

先看怎么编译一个函数体：

```rust
    fn compile_function(
        &mut self,
        name: Option<String>,
        params: &[pebble_ast::Ident],
        body: &[Stmt],
    ) -> u32 {
        let mut sub = Compiler::new();
        sub.compile_body(body, true);
        self.diagnostics.extend(sub.diagnostics);
        let proto = FunctionProto {
            name,
            params: params.iter().map(|param| param.name.clone()).collect(),
            chunk: sub.chunk,
        };
        self.chunk.add_constant(Constant::Function(Rc::new(proto)))
    }
```

这个函数值得逐行读。`Compiler::new()` 造一个**全新的**子编译器：新的 `Chunk`、新的 `loops`、新的 `names` 缓存。`names` 必须是新的，因为它缓存的是"名字在**当前** `Chunk` 的常量池里的下标"，换了一个 `Chunk` 下标就全不对了。这也是名字缓存放在 `Compiler` 里、而不是做成全局的原因。

`compile_body(body, true)` 里的 `true` 就是前面那个 `in_function` 参数：函数体最后一条表达式的值要用 `Return` 返回出去；最后一条不是表达式（或者函数体是空的）时，补一个 `Nil` 再 `Return`。

然后是 Rust 里一个小而重要的东西：`self.diagnostics.extend(sub.diagnostics)` 把 `sub.diagnostics` 这个字段**移出**了 `sub`，下一行又用 `sub.chunk` 把另一个字段也移走。只移走结构体的一部分，叫**部分移动**，只要这个结构体没有实现 `Drop`（没有自定义析构函数）就是允许的：编译器清楚地知道哪些字段还在，哪些已经走了。C++ 里你得小心地对每个成员 `std::move`，而且移动后的成员仍然是个"有效但未指定"的对象，Rust 里被移走的字段**根本不能再碰**。

最后，函数原型进常量池用的是 `add_constant`，不是 `intern`：函数永远不去重（前面讲过）。返回值是它的常量下标，调用者拿去发 `MakeClosure`。`Rc::new(proto)` 把原型装进 `Rc`，以后 VM 里每个闭包持有的都是同一份。

函数声明、匿名函数和调用：

```rust
            Stmt::Fn {
                name, params, body, ..
            } => {
                let index = self.compile_function(Some(name.name.clone()), params, body);
                self.emit(Opcode::MakeClosure(index), span);
                let name_index = self.name_const(&name.name);
                self.emit(Opcode::DefineName(name_index), span);
            }
```

`fn fib(n) {...}` 就是"做一个闭包，再给它起个名字"，和 `let fib = fn(n) {...};` 几乎一样，区别只是原型里多记了一个名字 `fib`（`display_name` 会用它）。这一段放进 `compile_stmt`。`return` 语句也放进去：

```rust
            Stmt::Return { value, .. } => {
                match value {
                    Some(expr) => self.compile_expr(expr),
                    None => {
                        self.emit(Opcode::Nil, span);
                    }
                }
                self.emit(Opcode::Return, span);
            }
```

`compile_expr` 里的两个分支：

```rust
            Expr::Call { callee, args, .. } => {
                self.compile_expr(callee);
                for arg in args {
                    self.compile_expr(arg);
                }
                self.emit(Opcode::Call(args.len() as u32), span);
            }
            Expr::Fn { params, body, .. } => {
                let index = self.compile_function(None, params, body);
                self.emit(Opcode::MakeClosure(index), span);
            }
```

先编译被调用者，再依次编译每个参数，然后 `Call(参数个数)`。记住这个顺序，下一节 `for` 循环里它会咬人。

### 反汇编器学会递归

函数的指令在它自己的 `Chunk` 里，反汇编器要能钻进去。`disassemble` 变成对一个带缩进参数的私有函数的调用：

```rust
    pub fn disassemble(&self) -> String {
        let mut out = String::new();
        self.disassemble_into(&mut out, 0);
        out
    }
```

`disassemble_into` 就是之前的循环，加上缩进，加上三组新的操作数格式（`MakeClosure` 和 `Const` 一样是常量下标；`Call` 的操作数是个数，`BuildList`、`BuildMap` 要到第九步才有，到时再把它们并进这一支），以及遇到 `MakeClosure` 时递归：

```rust
    fn disassemble_into(&self, out: &mut String, indent: usize) {
        let pad = "  ".repeat(indent);
        out.push_str(&format!("{pad}== constants ==\n"));
        for (index, constant) in self.constants.iter().enumerate() {
            out.push_str(&format!("{pad}  {index:>4} {constant:?}\n"));
        }
        out.push_str(&format!("{pad}== code ==\n"));
        for (index, op) in self.code.iter().enumerate() {
            let operand = match op {
                Opcode::Const(index)
                | Opcode::DefineName(index)
                | Opcode::GetName(index)
                | Opcode::SetName(index)
                | Opcode::MakeClosure(index) => format!(" {index}"),
                Opcode::Jump(target)
                | Opcode::JumpIfFalse(target)
                | Opcode::JumpIfFalseKeep(target)
                | Opcode::JumpIfTrueKeep(target) => format!(" -> {target}"),
                Opcode::Call(count) => {
                    format!(" {count}")
                }
                _ => String::new(),
            };
            out.push_str(&format!("{pad}  {index:>4} {}{operand}\n", op.name()));
```

（上面是一个超过 15 行的块，主题会把它折叠，没关系，整段就是"之前的循环加三组分支"。）循环体最后一段是递归：

```rust
            if let Opcode::MakeClosure(constant) = op
                && let Some(Constant::Function(proto)) = self.constants.get(*constant as usize)
            {
                out.push_str(&format!(
                    "{pad}      -- function {} --\n",
                    proto.display_name()
                ));
                proto.chunk.disassemble_into(out, indent + 3);
            }
        }
    }
}
```

又一个 let 链：`op` 是 `MakeClosure` **并且**它指向的常量确实是个函数，才进去递归。`out` 是一个 `&mut String`，一路传下去，每一层往同一个 `String` 里追加，没有任何拷贝。`indent + 3` 让子清单缩进三级。

用它看 `examples/fib.pebble`。这是整篇文章里最长的一份真实输出：

```text
$ pebble run --quiet --dump-bytecode examples/fib.pebble
== constants ==
     0 <function fib>
     1 "fib"
     2 "print"
     3 20
== code ==
     0 MakeClosure 0
      -- function fib --
      == constants ==
           0 "n"
           1 2
           2 "fib"
           3 1
      == code ==
           0 GetName 0
           1 Const 1
           2 Less
           3 JumpIfFalse -> 7
           4 GetName 0
           5 Return
           6 Jump -> 7
           7 GetName 2
           8 GetName 0
           9 Const 3
          10 Sub
          11 Call 1
          12 GetName 2
          13 GetName 0
          14 Const 1
          15 Sub
          16 Call 1
          17 Add
          18 Return
          19 Nil
          20 Return
     1 DefineName 1
     2 GetName 2
     3 GetName 1
     4 Const 3
     5 Call 1
     6 Call 1
6765
```

从外往里读。顶层只有七条指令：做出 `fib` 闭包（0），起名（1），然后 `print(fib(20))`：取 `print`（2），取 `fib`（3），常量 `20`（4），`Call 1` 调用 `fib`（5），栈上现在是 `[print, 6765]`，再 `Call 1` 调用 `print`（6）。这就是"被调用者在参数下面"：`print` 先压栈，后面整个 `fib(20)` 的结果充当它的参数。最后的 `6765` 是 `print` 打出来的，不是程序的值（`print` 返回 `nil`）。

里面那个函数体 21 条。`GetName 0` 是 `n`（`"n"` 是函数自己的常量 0）；`Const 1` 是 `2`；`Less`；`JumpIfFalse -> 7`；`n < 2` 成立就 `GetName 0; Return`；接着第 6 条 `Jump -> 7`，是 `if` 为真分支末尾那个"跳过 else"，但 `Return` 已经走了，**永远执行不到**，这是 `if` 的固定模板留下的死代码，编译器没有去优化它。7 到 18 是 `fib(n - 1) + fib(n - 2)`，注意这里的 `fib` 要用 `GetName 2` 去环境里按名字找，递归调用也是这样；最后 19、20 是 `compile_body` 在"最后一条语句不是表达式"时补的 `Nil; Return`，这里最后一条是 `return` 语句，所以这两条同样永远执行不到。

> [!NOTE] 常量池是每个函数一份
> 两层各有自己的常量池：外层池里有 `"fib"`、`"print"` 和整数 `20`，里层池里有 `"n"`、`2`、`"fib"` 和 `1`。`"fib"` 在两个池里各存了一份，下标还不一样（外层是 1，里层是 2）。这正是前面说的"`names` 缓存必须每个 `Compiler` 一份"。

## 第九步：列表、映射、下标，以及 for

四条指令，对应第 8 篇的列表和映射：

```rust
        /// Pop `operand` items into a list.
        BuildList(u32),
        /// Pop `operand` key/value pairs into a map.
        BuildMap(u32),
        /// `container[key]`
        Index,
        /// `container[key] = value`, leaving the value on the stack.
        SetIndex,
```

把它们加进 `opcode_set!` 之后，回到第八步的 `disassemble_into`，把 `Opcode::Call(count) => {` 一行改成三路或模式（`BuildList` 和 `BuildMap` 的操作数也是个数）：

```rust
                Opcode::Call(count) | Opcode::BuildList(count) | Opcode::BuildMap(count) => {
```

编译：

```rust
            Expr::List { items, .. } => {
                for item in items {
                    self.compile_expr(item);
                }
                self.emit(Opcode::BuildList(items.len() as u32), span);
            }
            Expr::Map { entries, .. } => {
                for (key, value) in entries {
                    self.compile_expr(key);
                    self.compile_expr(value);
                }
                self.emit(Opcode::BuildMap(entries.len() as u32), span);
            }
            Expr::Index { object, index, .. } => {
                self.compile_expr(object);
                self.compile_expr(index);
                self.emit(Opcode::Index, span);
            }
```

和 `Call` 一个套路：先把所有元素压栈，最后一条指令说"栈顶这 n 个东西做成一个列表"。赋值分支现在可以补完整了：把第五步那个带 `todo!("assignment target")` 的 `Expr::Assign` 分支整个换成下面的版本。对下标赋值多出一路，目标既不是变量也不是下标时给出一个诊断（`E3003`），把右边照样编译出来，让栈保持平衡：

```rust
            Expr::Assign { target, value, .. } => {
                match target.as_ref() {
                    Expr::Var { name, .. } => {
                        self.compile_expr(value);
                        let index = self.name_const(&name.name);
                        self.emit(Opcode::SetName(index), span);
                    }
                    Expr::Index { object, index, .. } => {
                        self.compile_expr(object);
                        self.compile_expr(index);
                        self.compile_expr(value);
                        self.emit(Opcode::SetIndex, span);
                    }
                    other => {
                        self.diagnostics.push(
                            Diagnostic::error("invalid assignment target")
                                .with_code("E3003")
                                .with_span(other.span()),
                        );
                        // Emit the value anyway so the stack stays balanced.
                        self.compile_expr(value);
                    }
                }
            }
```

`target.as_ref()` 是 `Box<Expr>` 到 `&Expr` 的转换（第 5 篇的 `Box`）。`let xs = [1, 2]; xs[0] = 9; xs;` 的清单：

```text
$ pebble run --dump-bytecode lists.pebble
== constants ==
     0 1
     1 2
     2 "xs"
     3 0
     4 9
== code ==
     0 Const 0
     1 Const 1
     2 BuildList 2
     3 DefineName 2
     4 GetName 2
     5 Const 3
     6 Const 4
     7 SetIndex
     8 Pop
     9 GetName 2
[9, 2]
```

注意 `SetIndex` 前面压了三样东西：容器、下标、值。它改的是**同一个列表**（第 8 篇，列表是 `Rc<RefCell<..>>`，共享引用），所以最后读 `xs` 看到 `[9, 2]`。

### for 循环：脱糖

AST 里有 `for x in iter { body }`，字节码里没有对应的指令。我选择在编译期把它**脱糖**（desugar）成已有的东西：一个计数器循环。Pebble 里等价的写法是：

```pebble
let #iter = <iter>;
let #idx = 0;
while #idx < len(#iter) {
    let x = #iter[#idx];
    <body>
    #idx = #idx + 1;
}
```

`#iter` 和 `#idx` 是我在这里写的伪名字，真实代码里它们是 `" #iter"` 和 `" #idx"`，**带一个前导空格**：Pebble 的标识符里不可能有空格，所以它们不会和用户的变量撞名。`continue` 要跳到"自增"那一段而不是循环顶（否则会死循环），所以 `compile_for` 要自己管 `LoopCtx`。下面是完整的 `compile_for`，分段放进 `impl Compiler`。准备工作：

```rust
    /// Desugars `for x in iter { body }` into a hidden counter loop.
    fn compile_for(&mut self, var: &pebble_ast::Ident, iter: &Expr, body: &[Stmt], span: Span) {
        // Names that cannot collide with user identifiers (they contain a
        // space), used for the hidden iterator and index.
        let iter_name = self.name_const(" #iter");
        let index_name = self.name_const(" #idx");
        let zero = self.chunk.intern(Constant::Int(0));
        let one = self.chunk.intern(Constant::Int(1));
        let len_name = self.name_const("len");

        self.compile_expr(iter);
        self.emit(Opcode::DefineName(iter_name), span);
        self.emit(Opcode::Const(zero), span);
        self.emit(Opcode::DefineName(index_name), span);
```

循环头：

```rust
        let loop_start = self.here();
        // `#idx < len(#iter)`: callee first, then its argument.
        self.emit(Opcode::GetName(index_name), span);
        self.emit(Opcode::GetName(len_name), span);
        self.emit(Opcode::GetName(iter_name), span);
        self.emit(Opcode::Call(1), span);
        self.emit(Opcode::Less, span);
        let exit = self.chunk.placeholder(Opcode::JumpIfFalse(0), span);
```

循环体：

```rust
        self.loops.push(LoopCtx::default());
        // `let x = #iter[#idx];`
        self.emit(Opcode::GetName(iter_name), span);
        self.emit(Opcode::GetName(index_name), span);
        self.emit(Opcode::Index, span);
        let var_name = self.name_const(&var.name);
        self.emit(Opcode::DefineName(var_name), span);
        for stmt in body {
            self.compile_stmt(stmt);
        }
```

自增、回边和回填：

```rust
        let increment = self.here();
        // `#idx = #idx + 1`
        self.emit(Opcode::GetName(index_name), span);
        self.emit(Opcode::Const(one), span);
        self.emit(Opcode::Add, span);
        self.emit(Opcode::SetName(index_name), span);
        self.emit(Opcode::Pop, span);
        self.emit(Opcode::Jump(loop_start as u32), span);

        let end = self.here();
        self.chunk.patch_jump(exit, end);
        let ctx = self.loops.pop().expect("loop context");
        for jump in ctx.break_jumps {
            self.chunk.patch_jump(jump, end);
        }
        for jump in ctx.continue_jumps {
            self.chunk.patch_jump(jump, increment);
        }
    }
```

最后在 `compile_stmt` 里加分支，把 `Stmt::For` 交给它：

```rust
            Stmt::For {
                var, iter, body, ..
            } => self.compile_for(var, iter, body, span),
```

现在 `compile_stmt` 和 `compile_expr` 的两个 `match` 都穷尽了 `Stmt` 和 `Expr` 的每个变体，把 `_ => todo!("statement")` 和 `_ => todo!("expression")` 两个兜底分支删掉（留着它们是不可达分支，会有警告，也和 tag 对不上）。

`range(3)` 上的真实清单（`for i in range(3) { print(i); }`）：

```text
$ pebble run --dump-bytecode for.pebble
== constants ==
     0 " #iter"
     1 " #idx"
     2 0
     3 1
     4 "len"
     5 "range"
     6 3
     7 "i"
     8 "print"
== code ==
     0 GetName 5
     1 Const 6
     2 Call 1
     3 DefineName 0
     4 Const 2
     5 DefineName 1
     6 GetName 1
     7 GetName 4
     8 GetName 0
     9 Call 1
    10 Less
    11 JumpIfFalse -> 26
    12 GetName 0
    13 GetName 1
    14 Index
    15 DefineName 7
    16 GetName 8
    17 GetName 7
    18 Call 1
    19 Pop
    20 GetName 1
    21 Const 3
    22 Add
    23 SetName 1
    24 Pop
    25 Jump -> 6
    26 Nil
0
1
2
```

读它：0 到 2 是 `range(3)`（被调用者 `range` 在先，参数 `3` 在后，`Call 1`），结果存进隐藏变量 `" #iter"`（3），计数器 `" #idx"` 置 0（4、5）。循环头从 6 开始：`#idx`、`len`、`#iter`，`Call 1` 算出 `len(#iter)`，`Less` 比较，不成立就跳到 26（11）。12 到 15 是 `let i = #iter[#idx];`，16 到 19 是 `print(i);`，20 到 24 是自增（`SetName` 之后那条 `Pop` 把赋值表达式的值扔掉），25 是回边，指向 6，也就是循环头。注意常量表里的 `" #iter"` 和 `" #idx"` 带着引号和前导空格，一眼就看得出它们是名字，而且是用户写不出来的名字。

头上那五条指令（6 到 10）有一个顺序，代码注释里用大白话写着："callee first, then its argument"。这个顺序是整个 `for` 里最脆弱的一处。

### 弄坏它，看测试漏掉什么

我想知道这个顺序要是写反了会怎样，于是在一个临时的 worktree 里（`git worktree add /tmp/pebble-repro-10 tutorial-v1 --detach`，和 tag 一模一样的代码，用完即删）把 `compile_for` 里这两行对调：

```diff
         self.emit(Opcode::GetName(index_name), span);
-        self.emit(Opcode::GetName(len_name), span);
         self.emit(Opcode::GetName(iter_name), span);
+        self.emit(Opcode::GetName(len_name), span);
         self.emit(Opcode::Call(1), span);
```

现在栈上是 `[#idx, #iter, len]`，`Call 1` 会把"参数下面的那个东西"当被调用者，也就是 `#iter`，一个列表。用第 12 篇才会正式介绍的 `--vm` 开关跑（tag 里已经有了，这里只借来一用），真实输出：

```text
$ pebble run --vm for.pebble
error[E2001]: list is not callable
 --> for.pebble:1:1
  |
1 | for i in range(3) {
  | ^^^^^^^^^^^^^^^^^^^
  |
```

"list is not callable"。信息是对的，一眼就能推出"它把列表当函数调用了"，而这只有在我知道前面讲的栈布局的前提下才有用。然后是重点：同一份被弄坏的代码，我把测试跑了一遍。

```text
$ cargo test -p pebble-bytecode
...
test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
...
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
$ cargo test -p pebble-vm
...
test tests::control_flow_matches_the_tree_walker ... FAILED
...
test result: FAILED. 13 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

**我们这个 crate 的 14 个测试一个都没红。** `for_loop_desugars_to_indexing` 只检查清单里有没有 `BuildList`、`Index`、`Less` 这三个子串，它们当然都在，只是顺序错了。抓到它的是还没写的 VM 里的一个测试 `control_flow_matches_the_tree_walker`，它的失败信息是（节选）：

```text
called `Result::unwrap()` on an `Err` value: "error[E2001]: list is not callable\n --> <test>:3:13\n  |\n3 |             for i in range(10) {\n  |             ^^^^^^^^^^^^^^^^^^^^\n  |\n"
```

这是前面"子串测试看不见顺序"的兑现。要堵这个洞，更严格的做法是像第一版 `compiles_arithmetic` 那样直接比较指令序列。我没有在仓库里这么做（练习里你可以试试），我留下的是现状：这个 crate 的单元测试只能证明"编译器吐出了这些种类的指令"，证明"这些指令顺序正确"要靠执行它们的测试。这也是为什么第 12 篇要写一套**差分测试**：同一个程序在两个后端跑，结果必须一致。

### 两个我自己撞上的毛病

写这一篇的时候，我又用 `--vm` 和树遍历解释器对着跑了几个 `for`，发现了两个真实的毛病。两个都在 tag 上，我没有去修，因为这篇文章的工作是解释这个编译器，不是改它。

第一个，嵌套的 `for`。隐藏变量名是固定的 `" #iter"` 和 `" #idx"`，两层循环用**同一对名字**，`DefineName` 又都定义在同一个环境里，里层循环会覆盖外层的：

```pebble
for i in [1, 2] {
    for j in [10, 20] {
        print(i * j);
    }
}
```

```text
$ pebble run --vm nested.pebble
10
20
$ pebble run nested.pebble
10
20
20
40
```

VM（吃的是我们这一篇的字节码）只打印了两行。里层循环跑完时，`" #iter"` 已经是里层的 `[10, 20]`，`" #idx"` 是 `2`，外层先自增（2 变成 3），回到循环头检查 `3 < len([10, 20])`，不成立，退出。树遍历解释器每个 `for` 有自己的作用域，没这个问题。

第二个：

```pebble
let len = 3;
for x in [10, 20] {
    print(x);
}
```

```text
$ pebble run --vm shadow.pebble
error[E2001]: int is not callable
 --> shadow.pebble:2:1
  |
2 | for x in [10, 20] {
  | ^^^^^^^^^^^^^^^^^^^
  |
$ pebble run shadow.pebble
10
20
```

`for` 的脱糖调用的是名叫 `len` 的**全局变量**，用户把它盖掉了，循环就坏了。这两个毛病的修法都明摆着：加一条专门的迭代指令，或者给隐藏名字加上嵌套深度。但两者都是这类"脱糖在字节码层面生成了用户能碰到的东西"的问题，说明这个设计的代价：没有在语言层面引入新概念，换来的是编译器偷偷占用了名字空间。第 12 篇会拿它们当差分测试的素材。

## 补全：测试、Debug 和 operand_bytes

函数和闭包的两个测试放在一起，它们守着清单里的 `MakeClosure` 和嵌套函数的标题：

```rust
    #[test]
    fn functions_become_constants_and_closures() {
        let compiled = compile_src("fn add(a, b) { return a + b; } add(1, 2);");
        let listing = compiled.chunk().disassemble();
        assert!(listing.contains("MakeClosure"), "{listing}");
        assert!(listing.contains("-- function add --"), "{listing}");
        assert!(listing.contains("Return"), "{listing}");
    }

    #[test]
    fn closures_capture_implicitly_by_name() {
        let compiled = compile_src("let f = fn(x) { return x; };");
        let listing = compiled.chunk().disassemble();
        assert!(listing.contains("-- function <anonymous> --"), "{listing}");
    }
```

`for_loop_desugars_to_indexing` 前面讲过它只查三个子串，从 tag 里照抄。

`FunctionProto` 和 `Chunk` 的手写 `Debug` 也从 [tag 里](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-bytecode/src/lib.rs) 抄（`impl fmt::Debug for FunctionProto` 和 `impl fmt::Debug for Chunk`）。它们都用 `f.debug_struct("Name").field(..).finish()`，只打印"有几条指令、几个常量"，不把整个指令序列倒出来。派生版本会把每条指令和每个 `Span` 都打印出来，一个 `assert_eq!` 失败就是几屏输出。这两个也照抄，不然最后的 `diff` 不干净（没有它们代码照样能编译，它们只在你打印调试输出时才起作用）。

`Chunk::push` 也要抄，下面的 `chunk!` 要用它：

```rust
    /// Appends an instruction with no source span.
    ///
    /// Useful when building chunks programmatically; the VM only uses the span
    /// to attribute a runtime error, so a placeholder is fine.
    pub fn push(&mut self, op: Opcode) -> usize {
        self.emit(op, Span::DUMMY)
    }
```

这是给"手工拼一个 `Chunk`"用的：没有源码，所以 span 是 `Span::DUMMY`（第 1 篇）。下面的宏要用它。

### operand_bytes：把 8 字节的代价算出来

前面说过 `Opcode` 占 8 字节，一个紧凑的编码只要 5。仓库里有一个小函数把"带操作数的指令会占多少字节的操作数"算出来，让这笔账有地方可看：

```rust
impl Opcode {
    /// Number of bytes of inline operand this instruction would carry in a
    /// packed encoding. Pebble stores operands in the enum, but a real bytecode
    /// format flattens them into the instruction stream, so this is here to make
    /// that cost visible.
    #[must_use]
    pub const fn operand_bytes(self) -> usize {
        match self {
            Opcode::Const(_)
            | Opcode::DefineName(_)
            | Opcode::GetName(_)
            | Opcode::SetName(_)
            | Opcode::MakeClosure(_)
            | Opcode::Jump(_)
            | Opcode::JumpIfFalse(_)
            | Opcode::JumpIfFalseKeep(_)
            | Opcode::JumpIfTrueKeep(_)
            | Opcode::Call(_)
            | Opcode::BuildList(_)
            | Opcode::BuildMap(_) => 4,
            _ => 0,
        }
    }
}
```

十二个带载荷的变体用或模式合成一个分支，`_` 管剩下的二十个。这个 `_` 通配有代价：以后新加一个带操作数的变体，忘了把它写进来，编译器**不会**提醒你（前面 `arithmetic_opcode` 没有通配分支，刚好相反）。我没有一个干净的办法既保留"其余全是 0"又让编译器检查，这是个取舍：这个函数只是个说明，不是正确性的一部分，所以我选了短的写法。它也是 `const fn`，`self` 按值传（`Opcode` 是 `Copy` 的）。测试：

```rust
    #[test]
    fn operand_bytes_accounts_for_operands() {
        assert_eq!(Opcode::Const(0).operand_bytes(), 4);
        assert_eq!(Opcode::Add.operand_bytes(), 0);
        assert_eq!(Opcode::Add.name(), "Add");
    }
```

最后一行顺带用 `name()` 检查了宏生成的东西。

## macro_rules!：chunk!

测试里，我要手工拼一个 `Chunk`：`Nil`、`Const 0`、`Return`。不用宏的话是：

```rust
let mut chunk = Chunk::new();
chunk.push(Opcode::Nil);
chunk.push(Opcode::Const(0));
chunk.push(Opcode::Return);
```

重复的、模式固定的东西，又是宏的活。这次用 Rust 的第二套宏系统，**声明式宏** `macro_rules!`，不需要新 crate，不需要 `syn`，写在 `pebble-bytecode` 里：

```rust
#[macro_export]
macro_rules! chunk {
    ($($op:expr),* $(,)?) => {{
        let mut chunk = $crate::Chunk::new();
        $(
            $crate::Chunk::push(&mut chunk, $op);
        )*
        chunk
    }};
}
```

用它：`chunk![Opcode::Nil, Opcode::Const(0), Opcode::Return]` 就是上面那四行。

`macro_rules!` 的结构是一串"模式 => 模板"的规则，调用时编译器依次尝试，第一条匹配上的规则生效。这里只有一条规则，逐段读：

- `$op:expr` 是一个**捕获**：`$op` 是名字，`expr` 是**片段说明符**，意思是"这里要有一个完整的表达式"。常见的还有 `ident`（标识符）、`ty`（类型）、`tt`（单个 token 树，最灵活）、`pat`（模式）。
- `$( ... ),*` 是**重复**：括号里的模式重复零次或多次，用逗号分隔。
- `$(,)?` 是**可选的尾逗号**：`?` 表示零次或一次。

模板里 `$( ... )*` 的对应关系：每匹配到一个 `$op`，把括号里的内容展开一次，`$op` 换成那个表达式。所以三个操作码就展开三行 `push`。

外面为什么是双层大括号 `{{ ... }}`？第一层是宏规则本身的分隔符（外层的大括号你也可以写成圆括号或方括号，规则的语法要求有一对），第二层大括号是模板里的**块表达式**：`{ let mut chunk = ...; ...; chunk }` 求值为最后那个 `chunk`。要是只写一层，展开出来是一串语句，没法当表达式用，`let c = chunk![...]` 就不合法了。

### 为什么 `expr` 比 C 的宏强

C 程序员对宏的恐惧是有历史原因的。`#define CHUNK_PUSH(c, op) ...` 做的是**文本替换**：`MAX(a++, b)` 会把 `a++` 复制进展开结果两次，你得给每个参数加括号才能防止优先级出错。`macro_rules!` 不一样：`$op:expr` 先由编译器把调用处的 token 解析成一个完整的表达式，再原样放进模板，优先级和副作用都不会变：`chunk![Opcode::Const(1 + 2)]` 里，`$op` 绑定的是 `Opcode::Const(1 + 2)` 这一整个表达式，不会被拆开。

### 卫生性

另一件事：模板里的 `let mut chunk` 和调用者可能也有一个叫 `chunk` 的变量。不会冲突。实验室里 `ch10_hygiene.rs`，一个宏在内部定义 `x`，调用处想用：

```rust
macro_rules! make_x {
    () => {
        let x = 1;
    };
}

fn main() {
    make_x!();
    println!("{x}");
}
```

```text
error[E0425]: cannot find value `x` in this scope
 --> src/bin/ch10_hygiene.rs:9:16
  |
9 |     println!("{x}");
  |                ^ not found in this scope
  |
help: an identifier with the same name is defined here, but is not accessible due to macro hygiene
 --> src/bin/ch10_hygiene.rs:3:13
  |
3 |         let x = 1;
  |             ^
...
8 |     make_x!();
  |     --------- in this macro invocation
...
```

编译器甚至解释了原因：宏里的 `x` 和调用处的 `x` 是**两个不同的变量**，哪怕名字一样。这叫**卫生性**（hygiene）。反过来也成立：`ch10_hygiene_ok.rs` 里，宏内部有 `let x = $e; x + x`，调用者也有自己的 `x`：

```text
$ cargo run --quiet --bin ch10_hygiene_ok
22
10
```

`double!(x + 1)` 里调用者的 `x` 是 10，宏里的 `x` 是 11，结果 22；调用者的 `x` 还是 10。C 的 `#define` 做不到这点：展开后两个 `x` 就是同一个变量。过程宏没有这种卫生性：`quote!` 生成的 token 会原样落在调用处。所以第 6 篇里要写绝对路径 `::pebble_span::Spanned`，不依赖调用处有没有 `use`，也不怕调用处恰好有同名的东西，这是过程宏里避免名字冲突的办法。

### 尾逗号

`$(,)?` 看起来像装饰，其实不是。实验室里 `ch10_trailing_comma.rs` 把它去掉：

```rust
macro_rules! list {
    ($($item:expr),*) => {
        vec![$($item),*]
    };
}
```

调用 `list![1, 2, 3,]`：

```text
error: unexpected end of macro invocation
 --> src/bin/ch10_trailing_comma.rs:8:27
  |
1 | macro_rules! list {
  | ----------------- when calling this macro
...
8 |     let v = list![1, 2, 3,];
  |                           ^ missing tokens in macro arguments
  |
note: while trying to match meta-variable `$item:expr`
 --> src/bin/ch10_trailing_comma.rs:2:8
  |
2 |     ($($item:expr),*) => {
  |        ^^^^^^^^^^
...
```

最后一个逗号之后，模式期待下一个 `$item:expr`，没有了。加上 `$(,)?` 就行（`ch10_trailing_comma_ok.rs`，同时试了空列表）：

```text
$ cargo run --quiet --bin ch10_trailing_comma_ok
[1, 2, 3] []
```

`vec![1, 2, 3,]` 能写尾逗号，标准库的 `vec!` 就是这么做的。

### `$crate` 和 `#[macro_export]`

模板里写的是 `$crate::Chunk::new()`，不是 `Chunk::new()`。`$crate` 展开成"**定义这个宏的 crate**"的路径。如果写成 `Chunk::new()`，在另一个 crate 里调用 `chunk!`，调用处得恰好 `use` 了 `Chunk` 才行；用 `$crate` 就和调用处的 `use` 无关。（其实我用 `chunk.push($op)` 的方法调用写法也成立，用完全限定的 `$crate::Chunk::push(&mut chunk, $op)` 是我给"必须在任意作用域里都能工作的宏"养成的习惯，不是这里非用不可。）

`#[macro_export]` 让宏出现在 **crate 的根上**，调用者写 `use pebble_bytecode::chunk;` 或者 `pebble_bytecode::chunk![...]`，不管它在源文件的哪个模块里。没有它，宏只在**定义之后**的同一个模块（和子模块）里可见，`macro_rules!` 是按文本顺序生效的，这是它和普通函数最不一样的地方。

### 文档测试

宏上面那段 `///` 文档里有一个代码块，就是文档测试：

```rust
/// Builds a [`Chunk`] from a list of opcodes.
///
/// ```
/// use pebble_bytecode::{chunk, Opcode};
///
/// let chunk = chunk![Opcode::Nil, Opcode::True, Opcode::Return];
/// assert_eq!(chunk.len(), 3);
/// ```
#[macro_export]
macro_rules! chunk {
```

`cargo test` 会把文档里的 ```` ``` ```` 代码块提取出来，每个包进一个 `fn main`，作为**一个独立的、依赖这个 crate 的外部程序**编译并运行。所以它要写 `use pebble_bytecode::{chunk, Opcode};`：它和别的 crate 看到的世界一样。这有两层意义：文档里的示例永远不会过期（一旦 API 变了，测试就红），以及它是对公共 API 的一次真实检验，尤其对宏：宏在别的 crate 里能不能用，`$crate` 有没有写对，只有 doc test 能看见。输出：

```text
$ cargo test -p pebble-bytecode --doc
   Doc-tests pebble_bytecode

running 1 test
test crates/pebble-bytecode/src/lib.rs - chunk (line 353) ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

all doctests ran in 0.50s; merged doctests compilation took 0.50s
```

单元测试里也有一个：

```rust
    #[test]
    fn chunk_macro_builds_a_chunk() {
        let chunk = chunk![Opcode::Nil, Opcode::Const(0), Opcode::Return];
        assert_eq!(chunk.len(), 3);
        assert_eq!(chunk.code()[0], Opcode::Nil);
        assert_eq!(chunk.code()[1], Opcode::Const(0));
    }
```

有三处要和 tag 对齐，`diff` 才会干净。第一，`opcode_set!` 里指令的**顺序**，最终是这样（每条的文档注释就是前面各节里写的那一句）：

```text
Const, Nil, True, False, Pop, DefineName, GetName, SetName, MakeClosure,
Add, Sub, Mul, Div, Rem, Neg, Not, Equal, NotEqual, Less, LessEqual,
Greater, GreaterEqual, Jump, JumpIfFalse, JumpIfFalseKeep, JumpIfTrueKeep,
Call, Return, BuildList, BuildMap, Index, SetIndex
```

第二，文件里条目的**排列**。从上到下：`opcode_set!`、`impl Opcode`（`operand_bytes`）、`Constant` 和它的两个 `impl`（`same`、`Debug`）、`FunctionProto` 和它的两个 `impl`、`Chunk`、`impl Chunk`、`Chunk` 的 `Debug`、`chunk!` 宏、`Compiled`、`CompileResult`、`compile`、`LoopCtx`、`Compiler`、`arithmetic_opcode`，最后是测试。`impl Chunk` 里的方法：`new`、`emit`、`push`、`placeholder`、`patch_jump`、`add_constant`、`intern`、`code`、`constants`、`span_at`、`len`、`is_empty`、`disassemble`、`disassemble_into`。`impl Compiler` 里：`new`、`here`、`emit`、`name_const`、`compile_body`、`compile_stmt`、`compile_for`、`compile_expr`、`compile_function`。第三，注释：文件头的模块文档、`Opcode` 的文档注释、`compile_body` 的文档注释和 `// --- statements ---` 这样的分节线，我前面写得很简略，tag 里的更长一些。注释不影响行为，直接用 tag 里的文字。

照着上面补齐、排好以后，`crates/pebble-bytecode/src/lib.rs` 就是 tag 里那个文件。对一下：

```bash
for f in crates/pebble-bytecode/Cargo.toml crates/pebble-bytecode/src/lib.rs; do
  diff <(git -C ~/pebble-tag show tutorial-v1:$f) $f && echo "same  $f"
done
```

```text
same  crates/pebble-bytecode/Cargo.toml
same  crates/pebble-bytecode/src/lib.rs
```

```text
$ cargo test -p pebble-bytecode
running 14 tests
test tests::break_outside_a_loop_is_a_diagnostic ... ok
test tests::chunk_macro_builds_a_chunk ... ok
test tests::break_and_continue_are_patched ... ok
test tests::closures_capture_implicitly_by_name ... ok
test tests::constants_are_deduplicated ... ok
test tests::if_compiles_to_a_patched_forward_jump ... ok
test tests::for_loop_desugars_to_indexing ... ok
test tests::compiles_arithmetic ... ok
test tests::trailing_expression_is_the_program_value ... ok
test tests::functions_become_constants_and_closures ... ok
test tests::while_back_edge_points_backwards ... ok
test tests::operand_bytes_accounts_for_operands ... ok
test tests::non_trailing_expression_statements_are_popped ... ok
test tests::logical_operators_short_circuit_with_keeping_jumps ... ok

test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
...
running 1 test
test crates/pebble-bytecode/src/lib.rs - chunk (line 353) ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

## 命令行第三版，第二半：check 也编译

`pebble check` 的使命是"报告问题，别的什么也不做"。以前它只解析；现在编译器也能报诊断了（`break` 在循环外面，非法的赋值目标），所以让它也编译一遍。`crates/pebble-cli/src/commands.rs` 里的 `check` 变成：

```rust
/// `pebble check`: lex, parse, and compile a file, reporting diagnostics and
/// nothing else.
///
/// # Errors
/// Returns an error only for host-level failures such as an unreadable file.
pub(crate) fn check(args: &FileArgs) -> Result<u8> {
    let source = Source::load(&args.file)?;
    let parsed = parse_program(source.id, source.text());
    let compiled = compile(&parsed.program);
    let mut failed = sources::emit(&parsed.diagnostics, &source.map);
    failed |= sources::emit(&compiled.diagnostics, &source.map);
    Ok(if failed { 1 } else { 0 })
}
```

`failed |= ...` 是"或等于"，布尔值的复合赋值。注意两次 `emit` 都会执行：不能写 `a || b`，那会在 `a` 为真时短路，漏掉编译器的诊断。我不管解析有没有错都继续编译，这样一次 `check` 能把两个阶段的问题都报告出来；解析器已经做了错误恢复（第 7 篇），拿到的 AST 是可编译的。试一下：

```text
$ pebble check badbreak.pebble
error[E3001]: `break` outside a loop
 --> badbreak.pebble:2:1
  |
2 | break;
  | ^^^^^^
  |
$ pebble check examples/errors.pebble
error[E1001]: expected an expression, found `;`
 --> examples/errors.pebble:5:17
  |
5 | let total = 1 + ;
  |                 ^
  |
```

（`badbreak.pebble` 是 `let n = 3;` 加一行 `break;`。）`errors.pebble` 的输出里只有解析器那一条，编译器没有在它残缺的 AST 上凭空编出新的错误。`pebble run --dump-bytecode badbreak.pebble` 对同一个文件给同一条诊断，退出码是 1，不会往下执行。

`sources.rs` 的模块文档里那句话也改一个词：`the lexer and parser` 改成 `the lexer/parser/compiler`（和 tag 一致，这就是这个文件和 tag 完全相同的原因，它从这一版起不会再变了）。

两个新的集成测试，写进 `crates/pebble-cli/tests/cli.rs` 的末尾。第一个检查 `--dump-bytecode` 真的打印了清单（含嵌套的函数标题）：

```rust
#[test]
fn dump_bytecode_prints_the_listing() {
    pebble()
        .args(["run", "--quiet", "--dump-bytecode", "examples/fib.pebble"])
        .assert()
        .success()
        .stdout(
            predicate::str::contains("== code ==")
                .and(predicate::str::contains("-- function fib --"))
                .and(predicate::str::contains("MakeClosure")),
        );
}
```

第二个需要一个有编译错误的文件。我不想往仓库里再加一个示例文件，所以让测试自己在临时目录里造一个，用完删掉：

```rust
#[test]
fn check_reports_compile_errors() {
    let path = std::env::temp_dir().join(format!("pebble-break-{}.pebble", std::process::id()));
    std::fs::write(&path, "break;\n").expect("the temp file is writable");

    pebble()
        .arg("check")
        .arg(&path)
        .assert()
        .failure()
        .stderr(predicate::str::contains("`break` outside a loop"));

    std::fs::remove_file(&path).expect("the temp file is removable");
}
```

文件名里带进程号，免得两个并行的测试进程互相踩。`fs::write`、`fs::remove_file` 都返回 `Result`，在测试里直接 `expect`（第 7 篇：测试里 `panic` 是合适的）。`.arg(&path)`：`Path` 实现了 `AsRef<OsStr>`，所以能直接当命令行参数传。

## 检查点

在 `/tmp/pebble-rebuild-10`（你的是 `~/pebble`）里运行：

```bash
cargo test -p pebble-bytecode
cargo test -p pebble-cli
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

```text
$ cargo test -p pebble-bytecode
running 14 tests
...
test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
...
running 1 test
test crates/pebble-bytecode/src/lib.rs - chunk (line 353) ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
$ cargo test -p pebble-cli
running 3 tests
test repl::tests::arguments_are_kept_whole ... ok
test repl::tests::quit_has_a_short_form ... ok
test repl::tests::unknown_commands_are_rejected ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
running 9 tests
test parse_prints_the_syntax_tree ... ok
test quiet_suppresses_the_final_value ... ok
test check_reports_compile_errors ... ok
test tokens_prints_one_line_per_token ... ok
test check_is_silent_on_a_valid_file ... ok
test run_reports_parse_errors_on_stderr ... ok
test unknown_subcommands_are_usage_errors ... ok
test run_evaluates_fibonacci ... ok
test dump_bytecode_prints_the_listing ... ok
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s
$ cargo clippy --workspace --all-targets -- -D warnings
...
    Checking pebble-bytecode v0.1.0 (/tmp/pebble-rebuild-10/crates/pebble-bytecode)
    Checking pebble-cli v0.1.0 (/tmp/pebble-rebuild-10/crates/pebble-cli)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.35s
$ cargo fmt --all --check; echo "exit: $?"
exit: 0
```

`pebble-bytecode` 14 个测试加 1 个文档测试，`pebble-cli` 3 个单元测试加 9 个集成测试，`pebble-macros` 没有测试（`cargo test -p pebble-macros` 是 `running 0 tests`：过程宏 crate 没法在自己里面调用自己的宏，它的测试是 `pebble-ast` 里的 `derive_spanned_*` 和这个 crate 的编译本身）。clippy 和 rustfmt 干净。

下面这两个文件现在必须和 tag 逐字节相同：

- [`crates/pebble-bytecode/Cargo.toml`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-bytecode/Cargo.toml)
- [`crates/pebble-bytecode/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-bytecode/src/lib.rs)

`crates/pebble-cli/src/sources.rs` 也已经和 tag 相同（`repl.rs` 还有两处文档注释和 tag 不同，第 9 篇说过，行为一样），`examples/` 下的五个文件、更早的 `pebble-span`、`pebble-diag`、`pebble-lexer`、`pebble-ast`、`pebble-parser`、`pebble-value`、`pebble-interp` 也都是（我对着 tag 逐个 `diff` 过）。

**中间文件**（还不是最终版，后面的篇章会继续改）：

- `crates/pebble-macros/Cargo.toml` 和 `crates/pebble-macros/src/lib.rs`：现在有 `#[derive(Spanned)]` 和 `opcode_set!` 两个宏。tag 里的版本多了第 12 篇的 `#[differential]`，以及对应的文档、一个 `[dev-dependencies]`，`Cargo.toml` 的 `description` 也不同。`derive_spanned`、`expand_spanned`、`span_member`、`opcode_set`、`expand_opcodes` 与 tag 逐字相同。
- `crates/pebble-cli/` 下的全部七个文件：第三版。这一版相对第二版的改动只有这些：`Cargo.toml` 多一个依赖，`cli.rs` 多一个 `--dump-bytecode`，`commands.rs` 的 `run` 和 `check`，`sources.rs` 一个词，`tests/cli.rs` 多两个测试。最终版多出来的东西：`Backend` trait、`--vm` 和 `bench`（第 12 篇）、并行的 `check`（第 14 篇）、可选的 `repl` 特性（第 15 篇）。
- 根 `Cargo.toml` 的 `[workspace.dependencies]`：现在列了 9 个内部 crate 加 `anyhow`、`clap`、`proc-macro2`、`quote`、`rustyline`、`syn`。

## 练习

**1. 加一条 `Dup` 指令**（复制栈顶）。需要改哪些地方，编译器会在哪里提醒你？

<details>
<summary>参考答案</summary>

在 `opcode_set!` 里加两行：

```rust
        /// Duplicate the top of the stack.
        Dup,
```

只此而已。`name()`、`Debug`、`PartialEq`、`Copy` 都由宏重新生成；`operand_bytes` 的 `_ => 0` 和反汇编里的 `_ => String::new()` 恰好都不需要改。我在临时 worktree 里加了它和一个测试：

```rust
    #[test]
    fn dup_is_listed_without_an_operand() {
        let chunk = chunk![Opcode::Nil, Opcode::Dup, Opcode::Return];
        assert_eq!(Opcode::Dup.name(), "Dup");
        assert_eq!(Opcode::Dup.operand_bytes(), 0);
        assert!(chunk.disassemble().contains("   1 Dup\n"), "{}", chunk.disassemble());
    }
```

`cargo test -p pebble-bytecode` 是 14 个测试加 1 个 doc test 全部通过。但编译器的提醒在**别处**：这个 crate 里没有任何地方对 `Opcode` 做穷尽匹配，所以它不叫；第 12 篇的 VM 有，`cargo build -p pebble-vm`：

```text
error[E0004]: non-exhaustive patterns: `Opcode::Dup` not covered
   --> crates/pebble-vm/src/lib.rs:226:19
    |
226 |             match instruction {
    |                   ^^^^^^^^^^^ pattern `Opcode::Dup` not covered
    |
...
help: ensure that all possible cases are being handled by adding a match arm with a wildcard pattern or an explicit pattern as shown
    |
380 ~                 },
381 +                 Opcode::Dup => todo!()
    |
```

这就是穷尽匹配的价值：新指令加进来，没有一个执行它的地方能被悄悄漏掉。（我这里没有写编译器里**发射** `Dup` 的代码，因为目前的 Pebble 语法里没有哪个构造需要它；它是个为以后的优化预备的指令。）

</details>

**2. 用 `chunk!` 造一个三条指令的 chunk：`True`、一个目标为 0 的 `JumpIfFalse`、`Return`。** 把跳转指向最后一条并打印清单。然后让 `patch_jump` 去补第 0 条，看会发生什么。

<details>
<summary>参考答案</summary>

写成一个临时测试，用 `cargo test -p pebble-bytecode scratch -- --nocapture` 跑：

```rust
    #[test]
    fn scratch() {
        let mut chunk = chunk![Opcode::True, Opcode::JumpIfFalse(0), Opcode::Return];
        println!("{}", chunk.disassemble());
        chunk.patch_jump(1, 2);
        println!("{}", chunk.disassemble());
        chunk.patch_jump(0, 2);
    }
```

```text
running 1 test
== constants ==
== code ==
     0 True
     1 JumpIfFalse -> 0
     2 Return

== constants ==
== code ==
     0 True
     1 JumpIfFalse -> 2
     2 Return


thread 'tests::scratch' (135274) panicked at crates/pebble-bytecode/src/lib.rs:238:26:
cannot patch True as a jump
```

第一份清单里的 `-> 0` 是占位符；`patch_jump(1, 2)` 之后变成 `-> 2`。第 0 条是 `True`，不是跳转，`patch_jump` 的最后一个分支（带 `ref other` 的那个）触发 `panic!`，信息里用 `{other:?}` 打印出了那条指令，也就是宏给我们派生的 `Debug`。文档里的 `# Panics` 一节就是写给这个情况的：这是编译器自己的 bug，不是用户的错，所以 `panic` 而不是返回 `Result`。

</details>

**3. 为什么跳转目标要回填，而不是在发射指令时直接算出来？有没有不用回填的办法？**（讨论题）

<details>
<summary>参考答案</summary>

因为一条向前的跳转，它的目标取决于**还没发射的指令有多少条**：`if` 的 `then` 分支有几条指令，要编译完才知道。要在发射时算出来，你得在编译之前就知道每段代码的大小，这要求要么先做一遍"只数指令"的预扫描（代价是整个编译器要写两份，一份真的发射，一份只计数，两份必须永远一致），要么把代码先编译成一棵中间树、算好大小再展开。回填的代价是每条向前的跳转要记一个下标，回头改一次，非常便宜：`Vec` 里改一个槽位，O(1)。

之所以在 Pebble 里回填特别简单，是因为每条指令是固定大小的 8 字节枚举，把 `Jump(0)` 换成 `Jump(17)` 不会改变任何后面指令的位置。如果你换成变长编码（操作数按需用 1、2 或 4 字节），回填时目标可能放不进你预留的字节数，真正的汇编器要为此做"分支松弛"，反复调整直到所有跳转的宽度稳定。（这是我从汇编器那里知道的做法，Pebble 里没用到，也没有试过。）

另一个不用回填的办法是**用标签**：编译时把跳转目标记成一个符号 `Label(7)`，全部编译完再统一把标签换成下标。这本质上还是两步（发射，再解析），只是把"回头改"集中到了最后。

</details>

我们现在有一份清单，却没有人执行它。真正执行它的虚拟机，要在一个自己管理的堆上给列表、映射和闭包分配对象，还要知道哪些对象还活着：第 9 篇我们已经看到 `Rc` 在这里会让我们漏内存。所以在写那个虚拟机之前，[下一篇](/posts/rust-by-pebble-11-gc-unsafe/)我们先做它需要的零件：一个手写的垃圾回收器，用索引代替指针，用一个工作队列代替递归，在中途遇到我们的第一个 `unsafe`。字节码已经等在那里了，现在它只需要一个人来读它。
