---
title: "递归类型、泛型与 trait：搭一棵 AST"
commentId: "post:rust-by-pebble-05-ast-generics"
published: "2026-10-13 12:00:00 +08:00"
description: "把 token 流变成一棵树：用 Box 打破递归枚举的无限大小，用泛型和 trait bound 写出能处理任何访问者的遍历函数，再亲手撞上 ?Sized、IntoIterator 与手写 Spanned 的重复劳动。"
category: Note
tags:
  - Rust
  - Pebble
  - 泛型
  - trait
  - AST
series: "用 Pebble 从零学 Rust"
seriesOrder: 5
draft: false
comment: true
slug: rust-by-pebble-05-ast-generics
---

词法分析器吐出来的是一串平铺的 token，`let x = 1 + 2 * 3;` 在它眼里和一串字母没有区别。要让解释器知道 `2 * 3` 先算，数据结构本身必须带着"谁是谁的孩子"这件事。这就是 AST（抽象语法树）：同一个程序，从一维的 token 变成二维的树。这一篇我们把这棵树的类型定义写出来，顺路把 Rust 最有名也最让 C++ 程序员别扭的两个特性一次讲透：递归类型必须显式画出堆的边界，泛型的约束写在定义处而不是实例化处。

> [!NOTE] 本篇检查点
> 你将写完 `pebble-ast` 的**中间版本**：`Program`、`Ident`、`Stmt`、`Expr` 三种节点，三个运算符枚举，`Visit` 访问者 trait 加三个 `walk_*` 函数，`AstPrinter`，以及三个**手写**的 `impl Spanned`。用到的 Rust 特性：递归枚举与 `Box`、泛型、trait bound、`where`（概念）、`?Sized`、`impl Trait` 参数、`IntoIterator`、`pub use`。
> 上一篇是 [生命周期与词法分析器](/posts/rust-by-pebble-04-lifetimes-lexer/)。这一篇的 AST 不借用源码，所有字符串都是自己拥有的 `String`，所以这里没有生命周期标注。下一篇会用过程宏把三个手写的 `impl Spanned` 全部删掉。

## 一棵树要装什么

先想清楚 Pebble 需要表达什么。程序是一串语句；语句里有表达式；表达式里又有表达式。`1 + 2 * 3` 是一个"加法"节点，左孩子是 `1`，右孩子是一个"乘法"节点。每个节点还要记住自己来自源码的哪一段（`Span`，第 1、2 篇的主角），因为后面的所有错误信息都靠它画脱字符。

我们先用最小的例子试试直觉。进入第 1 篇建好的实验室 `~/rust-lab`，新建 `src/bin/ch05_recursive.rs`：

```rust
enum Expr {
    Int(i64),
    Add(Expr, Expr),
}

fn main() {}
```

这是 C++ 程序员的第一反应：一个 `Add` 里面放两个 `Expr`。运行 `cargo build --bin ch05_recursive`：

```text
error[E0072]: recursive type `Expr` has infinite size
 --> src/bin/ch05_recursive.rs:1:1
  |
1 | enum Expr {
  | ^^^^^^^^^
2 |     Int(i64),
3 |     Add(Expr, Expr),
  |         ---- recursive without indirection
  |
help: insert some indirection (e.g., a `Box`, `Rc`, or `&`) to break the cycle
  |
3 |     Add(Box<Expr>, Expr),
  |         ++++    +

For more information about this error, try `rustc --explain E0072`.
error: could not compile `rust-lab` (bin "ch05_recursive") due to 1 previous error
```

C++ 里同样的代码也过不了：

```c
struct Expr;
struct Add { Expr lhs; Expr rhs; };   // 错误：Expr 是不完整类型
struct Expr { Add add; long value; }; // 一个 Expr 里装两个 Expr，大小无穷
```

问题不是语法，是算术：`sizeof(Expr)` 要包含两个 `Expr`，而两个 `Expr` 又各自包含两个 `Expr`。编译器必须在编译期知道每个类型占多少字节，因为栈帧、字段偏移、数组步长全靠它。C++ 的解法是 `std::unique_ptr<Expr>`：指针的大小是固定的 8 字节，不管它指向什么。Rust 的解法完全一样，名字叫 `Box<T>`。

### `Box<T>`：堆上的独占所有权

编译器的提示已经把答案写在脸上了。把 `Add` 改成两个 `Box<Expr>`，再给枚举加一个装 `Vec<Expr>` 的变体，顺手量一下大小。新建 `src/bin/ch05_box.rs`：

```rust
use std::mem::size_of;

enum Expr {
    Int(i64),
    Add(Box<Expr>, Box<Expr>),
    List(Vec<Expr>),
}

fn eval(e: &Expr) -> i64 {
    match e {
        Expr::Int(n) => *n,
        Expr::Add(a, b) => eval(a) + eval(b),
        Expr::List(items) => items.iter().map(eval).sum(),
    }
}

fn main() {
    let tree = Expr::Add(
        Box::new(Expr::Int(1)),
        Box::new(Expr::Add(Box::new(Expr::Int(2)), Box::new(Expr::Int(3)))),
    );
    println!("eval = {}", eval(&tree));
    println!("Box<Expr>      = {} bytes", size_of::<Box<Expr>>());
    println!("Vec<Expr>      = {} bytes", size_of::<Vec<Expr>>());
    println!("Expr           = {} bytes", size_of::<Expr>());
    println!("Option<Box<Expr>> = {} bytes", size_of::<Option<Box<Expr>>>());
    println!("Option<i64>    = {} bytes", size_of::<Option<i64>>());
    let list = Expr::List(vec![Expr::Int(10), Expr::Int(20)]);
    println!("list = {}", eval(&list));
}
```

`cargo run --quiet --bin ch05_box`：

```text
eval = 6
Box<Expr>      = 8 bytes
Vec<Expr>      = 24 bytes
Expr           = 24 bytes
Option<Box<Expr>> = 8 bytes
Option<i64>    = 16 bytes
list = 30
```

几件事一次看清：

- `Box<Expr>` 8 字节，就是一个指针。它是 `unique_ptr`：独占所有权，离开作用域时释放堆内存，而且 `Drop` 是递归的，丢掉根节点会沿着树把所有节点释放干净。你不需要写析构函数，也不会忘记写。
- `Vec<Expr>` 24 字节：指针、容量、长度三个字，和元素数量无关。所以**`Vec<Expr>` 本身就是间接层**，`List(Vec<Expr>)` 不需要再套 `Box`。第三个练习会让你自己确认这一点。
- `Expr` 整个枚举 24 字节：一个标签加上最大变体（`Vec` 的 24 字节），编译器把标签塞进了某处的空位（我猜是 `Vec` 容量字段里不可能出现的值，这叫 niche 优化，不过我没有去验证具体位置）。
- `Option<Box<Expr>>` 还是 8 字节：`Box` 永远非空，所以 `None` 直接用空指针表示。`Option<i64>` 就没这个好运气，要 16 字节。这是 C 里"用 NULL 表示没有"那个老技巧，被编译器保证成了类型系统的一部分。

> [!TIP] 和 `unique_ptr` 的区别
> `Box<T>` 不会为空，不像 `unique_ptr` 可以是 `nullptr`，所以不存在对着空盒子解引用的问题。想表达"可能没有"，写 `Option<Box<T>>`，上面的数字说明它不花额外的钱。

好，类型层面的问题解决了。现在开始写真正的 AST。

## 搭 `pebble-ast`

在工作区根目录（上一篇你已经有 `pebble-span`、`pebble-diag`、`pebble-lexer` 三个 crate）：

```bash
cargo new --lib crates/pebble-ast
```

打开根 `Cargo.toml`，在 `[workspace.dependencies]` 里加一行：

```toml
pebble-ast = { path = "crates/pebble-ast", version = "0.1.0" }
```

`members = ["crates/*"]` 会自动把新目录纳入工作区。然后把 `crates/pebble-ast/Cargo.toml` 整个替换成：

```toml
[package]
name = "pebble-ast"
description = "The Pebble abstract syntax tree and its visitor traits."
version.workspace = true
edition.workspace = true
rust-version.workspace = true
authors.workspace = true
license.workspace = true
repository.workspace = true

[dependencies]
pebble-span.workspace = true

[dev-dependencies]
pebble-lexer.workspace = true

[lints]
workspace = true
```

`pebble-span` 提供 `Span` 和 `Spanned`。`[dev-dependencies]` 里的 `pebble-lexer` 只在测试和示例里可见，不会进入下游的依赖树；说实话，这一篇的四个测试没有用到它，我保留它是为了让这个文件和仓库只差一行（下一篇会加上的那一行）。Cargo 不会为没用到的依赖报警。

> [!NOTE] 仓库里还有一行
> 仓库里的 `pebble-ast/Cargo.toml` 在 `[dependencies]` 下面多一行 `pebble-macros.workspace = true`。那是第 6 篇才加的依赖，现在不要写。

### 文件头与 `Program`

`crates/pebble-ast/src/lib.rs` 从头写。这一篇的版本头部文档比仓库短一句（仓库的那句"`Spanned` 由 `pebble-macros` 派生"要等第 6 篇才成立）：

```rust
#![forbid(unsafe_code)]
//! The Pebble abstract syntax tree.
//!
//! The AST is where the language stops being text and starts being *structure*.
//! Three Rust ideas do most of the work here:
//!
//! * **Algebraic data types.** [`Expr`] and [`Stmt`] are recursive enums; a
//!   program is a `Vec<Stmt>` and an expression is a tree. Rust's `enum` is the
//!   single feature that makes writing a compiler pleasant.
//! * **`Box`.** Recursive enums need indirection, so child expressions are
//!   `Box<Expr>`.
//! * **Traits + a visitor.** [`Visit`] is a trait with default methods, and
//!   [`AstPrinter`] is one implementation.

use core::fmt;
use std::string::String;
use std::vec::Vec;

pub use pebble_span::{Span, Spanned};
```

`#![forbid(unsafe_code)]` 是 crate 级属性（第 2 篇见过）：这个 crate 里写 `unsafe` 就是编译错误。`String` 和 `Vec` 的两行 `use` 其实多余，它们本来就在 prelude 里；我保留它们只是为了和仓库逐字节一致。

最后一行 `pub use` 值得停一下。`use` 把名字引入**当前**作用域；`pub use` 还把它**重新导出**，下游的 crate 可以写 `pebble_ast::Span`，不必再单独依赖 `pebble-span`。C++ 里最接近的是在头文件里 `using lib::Span;`。我们这样做是因为 AST 的使用者几乎总要同时碰到节点和它们的 `Span`，让他们只 `use pebble_ast::{...}` 一行就够。

接着是程序本身：

```rust
/// A whole parsed program.
#[derive(Clone, Debug, PartialEq)]
pub struct Program {
    /// Top-level statements, in source order.
    pub stmts: Vec<Stmt>,
}

impl Program {
    /// Wraps a statement list.
    #[must_use]
    pub fn new(stmts: Vec<Stmt>) -> Self {
        Self { stmts }
    }
}
```

derive 三件套你熟了：`Clone`（深拷贝，整棵树复制一份）、`Debug`（`{:?}` 打印）、`PartialEq`（逐字段比较，测试里直接 `assert_eq!` 两棵树）。注意这里**没有** `Eq`：`Expr::Float` 里装着 `f64`，而 `f64` 的 `NaN != NaN` 违反了 `Eq` 要求的自反性。这一点第 4 篇的 `TokenKind` 已经让你撞过一次墙。

### 标识符

```rust
/// An identifier: its name plus where it appeared.
#[derive(Clone, Debug, PartialEq)]
pub struct Ident {
    pub name: String,
    pub span: Span,
}

impl Ident {
    /// Builds an identifier.
    #[must_use]
    pub fn new(name: impl Into<String>, span: Span) -> Self {
        Self {
            name: name.into(),
            span,
        }
    }
}

impl fmt::Display for Ident {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.name)
    }
}
```

`name` 是拥有的 `String`，不是 `&'src str`。第 4 篇的 token 借用源码，因为 token 流是用完即弃的；AST 要活得久，解释器和编译器都会拿着它，还要能被克隆、跨线程传递（第 14 篇的并行 `check` 就会这样做），所以让每个节点自己拥有数据，生命周期标注就不会像传染病一样爬满整个编译器。这是一个典型的取舍：多一次 `String` 分配，换来所有类型签名里没有 `'src`。

`new` 的参数 `name: impl Into<String>` 你在第 2 篇见过：任何能转成 `String` 的东西（`&str`、`String`）都收。`#[must_use]` 同样来自第 1 篇：忘了用返回值，编译器会警告。

### 语句

语句是"发生一件事、可能改变状态"的东西。按 Pebble 的语法，一共九种：

```rust
/// A statement: something that happens, and may change state.
#[derive(Clone, Debug, PartialEq)]
pub enum Stmt {
    /// `let name = value;`
    Let {
        name: Ident,
        value: Expr,
        span: Span,
    },
    /// `fn name(params) { body }`
    Fn {
        name: Ident,
        params: Vec<Ident>,
        body: Vec<Stmt>,
        span: Span,
    },
    /// An expression evaluated for its side effects.
    Expr { expr: Expr, span: Span },
    /// `if cond { .. } else { .. }`
    If {
        cond: Expr,
        then_branch: Vec<Stmt>,
        else_branch: Vec<Stmt>,
        span: Span,
    },
    /// `while cond { .. }`
    While {
        cond: Expr,
        body: Vec<Stmt>,
        span: Span,
    },
    /// `for var in iter { .. }`
    For {
        var: Ident,
        iter: Expr,
        body: Vec<Stmt>,
        span: Span,
    },
    /// `return value?;`
    Return { value: Option<Expr>, span: Span },
    /// `break;`
    Break { span: Span },
    /// `continue;`
    Continue { span: Span },
}
```

这里的变体不是 C 枚举那种光秃秃的整数，也不是 `Let(Ident, Expr, Span)` 那种按位置记字段的元组变体，而是**结构体式变体**：每个变体像一个匿名 struct，字段有名字。`Stmt::Let { name, value, span }` 比 `Stmt::Let(a, b, c)` 好读得多，模式匹配时还能用 `..` 忽略不关心的字段。这相当于 C++ `std::variant<LetStmt, FnStmt, ...>` 加上每个类型的定义，只不过写在一个地方，并且 `match` 必须穷尽所有变体（第 3 篇的 E0004）。

几个细节：

- `Stmt::Fn` 的 `body` 是 `Vec<Stmt>`：`Stmt` 里直接包含 `Vec<Stmt>`，没有 `Box`，原因前面解释过：`Vec` 自己就是堆指针。
- `Return { value: Option<Expr>, .. }`：这里 `Option<Expr>` 也没有 `Box`。`Expr` 的大小有限（我们等会儿量），`Option<Expr>` 就是"`Expr` 加一个标签"，不是递归。`Expr` 里面递归的地方才需要间接层。
- 每个变体都带一个 `span`。`If` 的 `else_branch` 没有 `Option`：没有 `else` 就是空的 `Vec`，少一层分支。

### 表达式

表达式是"产生一个值"的东西，也是整棵树里真正递归的部分：

```rust
/// An expression: something that produces a value.
#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    /// `nil`
    Nil { span: Span },
    /// `true` / `false`
    Bool { value: bool, span: Span },
    /// `42`
    Int { value: i64, span: Span },
    /// `4.2`
    Float { value: f64, span: Span },
    /// `"hi"`
    Str { value: String, span: Span },
    /// A variable reference.
    Var { name: Ident, span: Span },
    /// `[a, b, c]`
    List { items: Vec<Expr>, span: Span },
    /// `#{ key: value, .. }`
    Map {
        entries: Vec<(Expr, Expr)>,
        span: Span,
    },
    /// `-x`, `not x`
    Unary {
        op: UnaryOp,
        operand: Box<Expr>,
        span: Span,
    },
    /// `a + b`, `a < b`
    Binary {
        op: BinaryOp,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
        span: Span,
    },
    /// `a and b`, short-circuiting
    Logical {
        op: LogicalOp,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
        span: Span,
    },
    /// `target = value`
    Assign {
        target: Box<Expr>,
        value: Box<Expr>,
        span: Span,
    },
    /// `callee(args)`
    Call {
        callee: Box<Expr>,
        args: Vec<Expr>,
        span: Span,
    },
    /// `object[index]`
    Index {
        object: Box<Expr>,
        index: Box<Expr>,
        span: Span,
    },
    /// An anonymous function / closure.
    Fn {
        params: Vec<Ident>,
        body: Vec<Stmt>,
        span: Span,
    },
}
```

对照上一节的实验：凡是"孩子是单个 `Expr`"的地方（`Unary`、`Binary`、`Logical`、`Assign`、`Call` 的被调用者、`Index`），都是 `Box<Expr>`；凡是孩子是一串的地方（`List`、`Call` 的参数、`Map` 的键值对），是 `Vec`。`Map` 的 `Vec<(Expr, Expr)>` 里的 `(Expr, Expr)` 是元组：C++ 的 `std::pair<Expr, Expr>`，匿名的、字段按位置取。

`Stmt` 里的 `Expr::Fn` 和 `Stmt::Fn` 同名但互不干扰，`Stmt::Fn` 是 `fn name() {}` 声明，`Expr::Fn` 是 `fn() {}` 匿名函数值。枚举变体的名字属于枚举自己的命名空间。

写完这两个枚举，把 `ch05_box` 里的数字换成真货。我在实验目录之外另建了一个小 crate 去依赖刚写好的 `pebble-ast`（步骤略，核心就是一个 `main` 里的几行 `size_of`），输出：

```text
Span         = 12 bytes
Ident        = 40 bytes
Stmt         = 144 bytes
Expr         = 64 bytes
Box<Expr>    = 8 bytes
Vec<Expr>    = 24 bytes
(Expr, Expr) = 128 bytes
```

...`Ident` 40 + `Expr` 64 + `Vec` 24 + `Span` 12 = 140，对齐到 144）；这两个结论是我拿字段大小加出来的，没有去让编译器报告布局。重点是：**枚举的大小等于最大变体加标签**，写 `Nil` 也要付 64 字节。如果你在乎，可以把大变体里的东西装箱，clippy 有一个 `large_enum_variant` 的 lint 专门提醒这件事。Pebble 没有做，因为程序的 AST 不大，没必要为它牺牲可读性。

### 运算符

三个小枚举。`Copy` 在第 1 篇里解释过："像 C 结构体一样按位拷贝"，运算符就是一个字节的标签，拷贝它比借用它还便宜：

```rust
/// Prefix operators.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum UnaryOp {
    /// `-`
    Neg,
    /// `not` / `!`
    Not,
}

/// Infix arithmetic and comparison operators.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Eq,
    NotEq,
    Lt,
    LtEq,
    Gt,
    GtEq,
}

impl fmt::Display for BinaryOp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            BinaryOp::Add => "+",
            BinaryOp::Sub => "-",
            BinaryOp::Mul => "*",
            BinaryOp::Div => "/",
            BinaryOp::Rem => "%",
            BinaryOp::Eq => "==",
            BinaryOp::NotEq => "!=",
            BinaryOp::Lt => "<",
            BinaryOp::LtEq => "<=",
            BinaryOp::Gt => ">",
            BinaryOp::GtEq => ">=",
        })
    }
}

/// Short-circuiting logical operators.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum LogicalOp {
    And,
    Or,
}
```

`and` 和 `or` 为什么不放进 `BinaryOp`？因为它们的求值规则不同：`a and b` 在 `a` 为假时**不求值 `b`**，所以在解释器和编译器里需要完全不同的处理（第 9、10 篇会看到）。把"语法上长得像"和"语义上要分开对待"的东西在类型里分开，是让 `match` 替你记住差别的办法。这里 `Eq` 能 derive：这些枚举里没有 `f64`。

## `Spanned`：三个手写的大 `match`

`Spanned` trait 来自第 2 篇，只有一个方法 `fn span(&self) -> Span`。解释器、编译器、错误报告都会问"这个节点在源码哪一段"。三个类型要实现它：`Ident`、`Stmt`、`Expr`。**这一篇我们手写**，把重复的痛苦体验一遍，下一篇你就会明白为什么值得为它专门写一个宏。

```rust
impl Spanned for Ident {
    fn span(&self) -> Span {
        self.span
    }
}
```

`Ident` 是 struct，直接返回字段。`Span` 是 `Copy`，`self.span` 从 `&self` 里拷出一份，不是移动。

`Stmt` 是枚举：

```rust
impl Spanned for Stmt {
    fn span(&self) -> Span {
        match self {
            Stmt::Let { span, .. }
            | Stmt::Fn { span, .. }
            | Stmt::Expr { span, .. }
            | Stmt::If { span, .. }
            | Stmt::While { span, .. }
            | Stmt::For { span, .. }
            | Stmt::Return { span, .. }
            | Stmt::Break { span }
            | Stmt::Continue { span } => *span,
        }
    }
}
```

两个第 3 篇没细讲的语法：

- **或模式** `A | B | C => ...`：多个模式共享一个分支体。**每个模式必须绑定同样名字、同样类型的变量**，这里每个都绑出一个 `span`，所以分支体里能统一使用。`{ span, .. }` 里的 `..` 表示"其他字段我不关心"；`Break` 和 `Continue` 只有 `span` 一个字段，不需要写 `..`（写了也可以，只是多余）。
- **`*span`**：`match self` 的 `self` 是 `&Stmt`，通过引用匹配出来的字段也是引用（编译器自动把绑定变成 `&Span`，这叫默认绑定模式，下一篇会碰到它的麻烦），所以要解引用一次才能得到 `Span`。`Span` 是 `Copy`，所以 `*span` 是按位拷贝，不是移动。

`Expr` 同理，十五个变体：

```rust
impl Spanned for Expr {
    fn span(&self) -> Span {
        match self {
            Expr::Nil { span }
            | Expr::Bool { span, .. }
            | Expr::Int { span, .. }
            | Expr::Float { span, .. }
            | Expr::Str { span, .. }
            | Expr::Var { span, .. }
            | Expr::List { span, .. }
            | Expr::Map { span, .. }
            | Expr::Unary { span, .. }
            | Expr::Binary { span, .. }
            | Expr::Logical { span, .. }
            | Expr::Assign { span, .. }
            | Expr::Call { span, .. }
            | Expr::Index { span, .. }
            | Expr::Fn { span, .. } => *span,
        }
    }
}
```

把这三段放进 `lib.rs`：`impl Spanned for Ident` 紧跟在 `Ident` 的 `Display` 之后，`impl Spanned for Stmt` 紧跟 `Stmt` 枚举，`impl Spanned for Expr` 紧跟 `Expr` 枚举。（顺序不影响编译，但这样和仓库的文件布局一致。）

### 我为什么说这是痛苦

不妨做个实验，感受一下。把 `Stmt` 的最后加一个变体：

```rust
    /// `{ .. }`
    Block { body: Vec<Stmt>, span: Span },
```

我在一份拷贝里做了这件事，`cargo build -p pebble-ast` 立刻给出：

```text
error[E0004]: non-exhaustive patterns: `&Stmt::Block { .. }` not covered
   --> crates/pebble-ast/src/lib.rs:125:15
    |
125 |         match self {
    |               ^^^^ pattern `&Stmt::Block { .. }` not covered
...
error[E0004]: non-exhaustive patterns: `&Stmt::Block { .. }` not covered
   --> crates/pebble-ast/src/lib.rs:309:11
...
error[E0004]: non-exhaustive patterns: `&Stmt::Block { .. }` not covered
   --> crates/pebble-ast/src/lib.rs:432:27
...
error: could not compile `pebble-ast` (lib) due to 3 previous errors
```

好消息是编译器一处不漏地指出所有要改的地方（C++ 里往 `std::variant` 加一个类型，漏掉一个 `std::visit` 分支，要等到运行时才知道）。坏消息是三处里有一处纯粹是机械劳动：`Spanned` 那个 `match` 里的每个分支都在做完全相同的事，"把叫 `span` 的字段取出来"。其余两处（`walk_stmt` 和打印器）是真有信息量的工作，每个变体怎样遍历、怎样显示，只有人知道。

这就是第 6 篇的动机：让编译器自己去生成那个机械的 `match`。现在先把实验撤回，继续往下。

## 访问者：让遍历和节点分家

AST 建好了，接下来谁来用它？打印器用，解释器用，字节码编译器用，将来任何分析工具都要用。它们各自要"走遍整棵树"，但对每种节点要做的事不同。如果每个工具都自己写一遍递归 `match`，十五个表达式变体和九个语句变体的"孩子在哪"信息就会被复制到每个工具里。

标准的解决办法是**访问者模式**。C++ 的经典写法（我把它写成了一个可运行的小程序，用 `g++ -std=c++20` 编译通过，输出 `add`、`int 1`、`int 2` 三行）：

```c
struct Visitor {
    virtual void visit(const Int&) = 0;
    virtual void visit(const Add&) = 0;
    virtual ~Visitor() = default;
};

struct Expr {
    virtual void accept(Visitor&) const = 0;
    virtual ~Expr() = default;
};

struct Int : Expr {
    long value;
    void accept(Visitor& v) const override { v.visit(*this); }
};
```

每个节点类要写 `accept`，通过它把自己的具体类型"弹回"给 `Visitor` 的对应重载，这叫双重分派：一次虚调用确定节点类型，一次重载解析确定访问者的方法。每加一个节点类，每个访问者基类要加一个纯虚函数，每个子类要实现它，哪怕是个空操作。

Rust 的版本利用的是枚举：节点类型已经是一个封闭的 `enum`，`match` 就是分派，不需要 `accept`。我们只需要一个 trait 来表示"访问者"，并且给它的方法**默认实现**：

```rust
/// A read-only AST visitor with sensible defaults.
///
/// Override only the methods you care about; the rest fall back to a full
/// recursive walk, so a visitor that does nothing visits every node.
pub trait Visit {
    /// Visits a whole program.
    fn visit_program(&mut self, program: &Program) {
        walk_program(self, program);
    }

    /// Visits a statement.
    fn visit_stmt(&mut self, stmt: &Stmt) {
        walk_stmt(self, stmt);
    }

    /// Visits an expression.
    fn visit_expr(&mut self, expr: &Expr) {
        walk_expr(self, expr);
    }
}
```

默认方法在第 3 篇的 `DiagnosticSink` 里已经出现过。这里每个默认实现都转手交给一个自由函数 `walk_*`，由它负责"遍历孩子"。关键的设计：**`walk_*` 只管"孩子在哪"，`visit_*` 只管"到了这个节点做什么"**。覆盖 `visit_expr` 的访问者可以在自己的逻辑里选择是否调用 `walk_expr` 继续往下走。

### 写 `walk_*`：泛型函数第一次出场

现在写 `walk_*`。先用一个直觉的版本。在 `Visit` 之后：

```rust
pub fn walk_program<V: Visit>(visitor: &mut V, program: &Program) {
    for stmt in program {
        visitor.visit_stmt(stmt);
    }
}
```

先别管 `for stmt in program`（下一节解释），盯着签名：

```rust
fn walk_program<V: Visit>(visitor: &mut V, program: &Program)
```

`<V: Visit>` 声明一个类型参数 `V`，并且约束 `V` 必须实现 `Visit`。调用时 `V` 由实参推断：传入 `&mut AstPrinter` 就是 `V = AstPrinter`。这就是 C++ 的 `template <typename V> void walk_program(V& visitor, ...)`，两者实现方式也一样：**单态化**。编译器为每个实际用到的 `V` 生成一份专门的机器码，没有虚调用、没有装箱，`visitor.visit_stmt(stmt)` 可以被内联。

### 约束写在定义处：Rust 泛型和 C++ 模板最大的不同

看一个对比。C++ 里，你可以写一个对类型毫无要求的模板：

```c
template <typename T>
T largest(T a, T b) {
    return a > b ? a : b;
}
```

它对 `T` 的要求（要有 `operator>`）是**隐藏在函数体里**的，直到有人用不支持的类型实例化它才报错。我写了个空结构体 `Pebble` 试了一下（`g++ -std=c++20`）：

```text
largest.cpp: In instantiation of 'T largest(T, T) [with T = Pebble]':
largest.cpp:9:12:   required from here
    9 |     largest(Pebble{}, Pebble{});
      |     ~~~~~~~^~~~~~~~~~~~~~~~~~~~
largest.cpp:5:14: error: no match for 'operator>' (operand types are 'Pebble' and 'Pebble')
    5 |     return a > b ? a : b;
      |            ~~^~~
```

错误出现在**调用处**要求的实例化里，你得顺着 "required from here" 一路往上读。（C++20 的 concepts 可以把约束写在签名里，但它是可选的。另外 g++ 输出里的弯引号我换成了直引号，别的字符没动。）

Rust 做不到这种偷懒。在实验室新建 `src/bin/ch05_bound.rs`：

```rust
fn largest<T>(a: T, b: T) -> T {
    if a > b { a } else { b }
}

fn main() {
    println!("{}", largest(3, 9));
}
```

`cargo build --bin ch05_bound`：

```text
error[E0369]: binary operation `>` cannot be applied to type `T`
 --> src/bin/ch05_bound.rs:2:10
  |
2 |     if a > b { a } else { b }
  |        - ^ - T
  |        |
  |        T
  |
help: consider restricting type parameter `T` with trait `PartialOrd`
  |
1 | fn largest<T: std::cmp::PartialOrd>(a: T, b: T) -> T {
  |             ++++++++++++++++++++++

For more information about this error, try `rustc --explain E0369`.
error: could not compile `rust-lab` (bin "ch05_bound") due to 1 previous error
```

注意：错误出现在**定义处**，而且 `main` 里调用 `largest(3, 9)` 完全合法，但函数本身就不合格：泛型函数体只能使用约束里声明过的能力。这样做的好处是，库的作者在写这个函数的时候就知道它对不对；调用者只看签名就知道要提供什么，不用读函数体。代价是你必须把"我需要什么"写出来。照提示把签名改成 `fn largest<T: PartialOrd>(a: T, b: T) -> T`（文件另存为 `ch05_mono.rs`，`main` 里分别用 `i32`、`f64`、`&str` 调用三次）：

```rust
fn largest<T: PartialOrd>(a: T, b: T) -> T {
    if a > b { a } else { b }
}

fn main() {
    println!("{}", largest(3_i32, 9));
    println!("{}", largest(2.5_f64, 1.5));
    println!("{}", largest("pebble", "stone"));
}
```

```text
9
2.5
stone
```

我想亲眼确认"单态化"不是个比喻，所以构建调试版并列出符号表：

```text
$ cargo build --quiet --bin ch05_mono
$ nm -C target/debug/ch05_mono | grep largest
000000000000a2d0 t ch05_mono::largest
000000000000a3a0 t ch05_mono::largest
000000000000a430 t ch05_mono::largest
```

三种类型，三份机器码，同一个名字（符号里编码的类型参数没有被 `-C` 显示出来，但地址是三个）。这和 C++ 模板实例化是一回事，也是 Rust 泛型"零成本"的来源：运行时没有任何泛型的痕迹。代价同样一样：二进制体积变大、编译变慢。

当约束多起来，签名会变得很挤，这时可以把约束挪到 `where` 子句里：`fn f<T, U>(t: T, u: U) where T: Display + Clone, U: Into<T> { ... }`。两种写法完全等价，`where` 只是排版工具；Pebble 的代码里目前用的都是行内约束，所以我不为它单独做实验。

### 第二面墙：默认方法里的 `?Sized`

如果你把三个 `walk_*` 都按 `<V: Visit>` 写完（函数体见下面的小节，此刻先别管它们），再编译，会失败吗？

```rust
pub fn walk_program<V: Visit>(visitor: &mut V, program: &Program) { ... }
pub fn walk_stmt<V: Visit>(visitor: &mut V, stmt: &Stmt) { ... }
pub fn walk_expr<V: Visit>(visitor: &mut V, expr: &Expr) { ... }
```

它们自己能编译，问题出在 `Visit` 的默认方法里：`walk_program(self, program)` 把 `self` 传了出去。实验室里用最小的例子重现。新建 `src/bin/ch05_sized.rs`：

```rust
struct Expr;

fn walk_expr<V: Visit>(visitor: &mut V, expr: &Expr) {
    let _ = (visitor, expr);
}

trait Visit {
    fn visit_expr(&mut self, expr: &Expr) {
        walk_expr(self, expr);
    }
}

fn main() {}
```

`cargo build --bin ch05_sized`：

```text
error[E0277]: the size for values of type `Self` cannot be known at compilation time
 --> src/bin/ch05_sized.rs:9:19
  |
9 |         walk_expr(self, expr);
  |         --------- ^^^^ doesn't have a size known at compile-time
  |         |
  |         required by a bound introduced by this call
  |
note: required by an implicit `Sized` bound in `walk_expr`
 --> src/bin/ch05_sized.rs:3:14
  |
3 | fn walk_expr<V: Visit>(visitor: &mut V, expr: &Expr) {
  |              ^ required by the implicit `Sized` requirement on this type parameter in `walk_expr`
help: consider further restricting `Self`
  |
8 |     fn visit_expr(&mut self, expr: &Expr) where Self: Sized {
  |                                           +++++++++++++++++
help: consider relaxing the implicit `Sized` restriction
  |
3 | fn walk_expr<V: Visit + ?Sized>(visitor: &mut V, expr: &Expr) {
  |                       ++++++++

For more information about this error, try `rustc --explain E0277`.
error: could not compile `rust-lab` (bin "ch05_sized") due to 1 previous error
```

真实的 `pebble-ast` 里，同样的操作（把三个签名里的 `+ ?Sized` 去掉）得到三个一模一样的错误，每个默认方法一个。

怎么理解？Rust 里**泛型参数默认带一个隐含约束 `Sized`**：类型大小必须在编译期已知。绝大多数时候这正是你想要的。但 trait 本身（`Self`）不隐含 `Sized`，因为 Rust 想让 `dyn Visit` 这种"动态大小类型"（编译期不知道具体是谁）也能成为 `Self`。于是默认方法里的 `Self` 不一定有大小，不能传给要求 `V: Sized` 的 `walk_expr`。

C++ 里没有对应物，因为 C++ 的所有类型都是"定长"的：虚基类的对象你只能通过指针或引用持有，对象本身不会出现在模板参数里被按值传递，所以不会碰到这个问题。Rust 把这条界线显式化了。（第 3 篇你在 `impl<T: Display + ?Sized> ToString for T` 里已经见过这个 `?Sized`，它读作"`T` **可能**没有固定大小"。那里它是为了让 `str` 也能 `to_string()`。）

解决办法就是编译器提示的第二条：放宽约束。三个函数的签名全部改成：

```rust
pub fn walk_program<V: Visit + ?Sized>(visitor: &mut V, program: &Program) {
    for stmt in program {
        visitor.visit_stmt(stmt);
    }
}
```

`?Sized` 是 Rust 里仅有的"放宽"约束的写法（别的约束都是在加条件）。放宽之后，`V` 可以是 `AstPrinter` 这样的具体类型，也可以是 `dyn Visit`。第二种用法在实验室验证一下，新建 `src/bin/ch05_sized_ok.rs`：

```rust
struct Expr;

fn walk_expr<V: Visit + ?Sized>(visitor: &mut V, expr: &Expr) {
    visitor.visit_expr(expr);
}

trait Visit {
    fn visit_expr(&mut self, _expr: &Expr) {}
}

struct Counter(usize);
impl Visit for Counter {
    fn visit_expr(&mut self, _expr: &Expr) {
        self.0 += 1;
    }
}

fn main() {
    let mut counter = Counter(0);
    walk_expr(&mut counter, &Expr);
    println!("static dispatch: {}", counter.0);

    let dynamic: &mut dyn Visit = &mut counter;
    walk_expr(dynamic, &Expr);
    println!("dynamic dispatch: {}", counter.0);
}
```

```text
static dispatch: 1
dynamic dispatch: 2
```

同一个 `walk_expr`，第一次 `V = Counter`（静态分派，单态化出一份专门的代码），第二次 `V = dyn Visit`（动态分派，通过虚表调用 `visit_expr`）。`&mut dyn Visit` 就是 C++ 里 `Visitor&` 指向一个虚基类。你现在可以把它当作"带虚表的引用"；`dyn Trait` 的内部结构（胖指针、虚表布局、对象安全）留给 [第 8 篇](/posts/rust-by-pebble-08-rc-refcell-values/)，那里的 `&mut dyn Output` 会用到。

### 把三个 `walk_*` 写完

遍历的内容就是"每个变体的孩子在哪"。这是编译器逼你想清楚的部分：

```rust
/// Recursively visits every statement of a program.
pub fn walk_program<V: Visit + ?Sized>(visitor: &mut V, program: &Program) {
    for stmt in program {
        visitor.visit_stmt(stmt);
    }
}

/// Recursively visits a statement and its children.
pub fn walk_stmt<V: Visit + ?Sized>(visitor: &mut V, stmt: &Stmt) {
    match stmt {
        Stmt::Let { value, .. } => visitor.visit_expr(value),
        Stmt::Fn { body, .. } => {
            for stmt in body {
                visitor.visit_stmt(stmt);
            }
        }
        Stmt::Expr { expr, .. } => visitor.visit_expr(expr),
        Stmt::If {
            cond,
            then_branch,
            else_branch,
            ..
        } => {
            visitor.visit_expr(cond);
            for stmt in then_branch {
                visitor.visit_stmt(stmt);
            }
            for stmt in else_branch {
                visitor.visit_stmt(stmt);
            }
        }
        Stmt::While { cond, body, .. } => {
            visitor.visit_expr(cond);
            for stmt in body {
                visitor.visit_stmt(stmt);
            }
        }
        Stmt::For { iter, body, .. } => {
            visitor.visit_expr(iter);
            for stmt in body {
                visitor.visit_stmt(stmt);
            }
        }
        Stmt::Return { value, .. } => {
            if let Some(value) = value {
                visitor.visit_expr(value);
            }
        }
        Stmt::Break { .. } | Stmt::Continue { .. } => {}
    }
}
```

注意两处细节：`Stmt::Let` 只访问 `value`，不访问 `name`：`Ident` 不是表达式，也不是语句，这个访问者接口里没有它的位置（如果以后要处理变量声明，在覆盖的 `visit_stmt` 里读 `name` 即可）。`Break` 和 `Continue` 没有孩子，分支体是空块。

`walk_expr`：

```rust
/// Recursively visits an expression and its children.
pub fn walk_expr<V: Visit + ?Sized>(visitor: &mut V, expr: &Expr) {
    match expr {
        Expr::Nil { .. }
        | Expr::Bool { .. }
        | Expr::Int { .. }
        | Expr::Float { .. }
        | Expr::Str { .. }
        | Expr::Var { .. } => {}
        Expr::List { items, .. } => {
            for item in items {
                visitor.visit_expr(item);
            }
        }
        Expr::Map { entries, .. } => {
            for (key, value) in entries {
                visitor.visit_expr(key);
                visitor.visit_expr(value);
            }
        }
        Expr::Unary { operand, .. } => visitor.visit_expr(operand),
        Expr::Binary { lhs, rhs, .. } | Expr::Logical { lhs, rhs, .. } => {
            visitor.visit_expr(lhs);
            visitor.visit_expr(rhs);
        }
        Expr::Assign { target, value, .. } => {
            visitor.visit_expr(target);
            visitor.visit_expr(value);
        }
        Expr::Call { callee, args, .. } => {
            visitor.visit_expr(callee);
            for arg in args {
                visitor.visit_expr(arg);
            }
        }
        Expr::Index { object, index, .. } => {
            visitor.visit_expr(object);
            visitor.visit_expr(index);
        }
        Expr::Fn { body, .. } => {
            for stmt in body {
                visitor.visit_stmt(stmt);
            }
        }
    }
}
```

两个值得细看的 Rust 点：

- **或模式里绑定同一个名字**：`Expr::Binary { lhs, rhs, .. } | Expr::Logical { lhs, rhs, .. }`。两个变体都有 `lhs` 和 `rhs`，类型都是 `Box<Expr>`，所以一个分支体处理两者。
- **`visitor.visit_expr(operand)`：`operand` 是 `&Box<Expr>`，参数要的是 `&Expr`。** 这能编译是因为**解引用强制转换**（deref coercion）：`Box<T>` 实现了 `Deref<Target = T>`，编译器在需要 `&Expr` 的地方看到 `&Box<Expr>`，自动插入 `&**operand`。这相当于 C++ `unique_ptr::operator*` 隐式地被调用；你不必手写解引用。第 7 篇的 `&PathBuf` 变 `&Path` 是同一个机制。

## `for stmt in program`：`IntoIterator` 和 `for` 的真面目

回头看 `walk_program` 里那句 `for stmt in program`。`program` 的类型是 `&Program`，不是 `Vec`。能这样写，是因为我们给 `&Program` 实现了 `IntoIterator`。把这段加在 `impl Program` 之后：

```rust
impl<'a> IntoIterator for &'a Program {
    type Item = &'a Stmt;
    type IntoIter = std::slice::Iter<'a, Stmt>;

    fn into_iter(self) -> Self::IntoIter {
        self.stmts.iter()
    }
}
```

先回忆第 4 篇的 `Iterator`：一个有关联类型 `Item` 和一个 `next` 方法的 trait。`IntoIterator` 是它的"入口"：**任何可以变成迭代器的东西**。它有两个关联类型（`Item` 是元素类型，`IntoIter` 是具体的迭代器类型）和一个 `into_iter(self)` 方法。

`for x in expr { body }` 并不是语言内置的魔法，它是对下面这段的**语法糖**。为了让你看到，我写了一个独立的小程序 `src/bin/ch05_into_iter.rs`：

```rust
struct Program {
    stmts: Vec<String>,
}

impl<'a> IntoIterator for &'a Program {
    type Item = &'a String;
    type IntoIter = std::slice::Iter<'a, String>;

    fn into_iter(self) -> Self::IntoIter {
        self.stmts.iter()
    }
}

fn main() {
    let program = Program {
        stmts: vec!["let x = 1;".to_string(), "print(x);".to_string()],
    };

    for stmt in &program {
        println!("for:      {stmt}");
    }

    // what the compiler rewrites that loop into
    let mut iter = IntoIterator::into_iter(&program);
    while let Some(stmt) = iter.next() {
        println!("desugared: {stmt}");
    }
}
```

```text
for:      let x = 1;
for:      print(x);
desugared: let x = 1;
desugared: print(x);
```

C++ 的 range-for 也是语法糖（展开成 `begin()`/`end()` 与迭代器），区别在于 Rust 的入口是 trait，所以你可以为**自己的类型**以及它们的**不同借用形式**分别实现。标准库里 `Vec<T>` 就有三个实现：`for x in vec` 吃掉 `Vec`（`Item = T`），`for x in &vec` 借出（`Item = &T`），`for x in &mut vec` 可变借出（`Item = &mut T`）。

为什么我们为 `&Program` 而不是 `Program` 实现？实验：把 `main` 里的 `for stmt in &program` 改成 `for stmt in program`（文件另存为 `src/bin/ch05_into_iter_fail.rs`，`program` 里 `stmts` 留空）：

```text
error[E0277]: `Program` is not an iterator
  --> src/bin/ch05_into_iter_fail.rs:16:17
   |
16 |     for stmt in program {
   |                 ^^^^^^^ the trait `IntoIterator` is not implemented for `Program`
   |
   = note: the trait bound `Program: IntoIterator` is not satisfied
   = note: required for `Program` to implement `IntoIterator`
help: consider borrowing here
   |
16 |     for stmt in &program {
   |                 +
```

`Program` 值本身没实现，只有 `&Program` 实现了。这正是我们要的：AST 遍历全是借用，没有任何人需要"吃掉"一棵树。如果将来需要，再加一个 `impl IntoIterator for Program` 即可，它们互不冲突。

`impl<'a>` 里的 `'a` 是第 4 篇的生命周期：返回的迭代器和元素借用自 `&'a Program`，所以它们不能比被借用的 `Program` 活得久。

## `AstPrinter`：第一个访问者

一个能真正跑起来的访问者，同时给我们一个肉眼可见的测试。打印器把树按缩进打印出来：

```rust
/// Pretty-prints a program as an indented tree.
///
/// This is one concrete [`Visit`] implementation; the interpreter is another.
#[derive(Default)]
pub struct AstPrinter {
    out: String,
    indent: usize,
}

impl AstPrinter {
    /// A fresh printer.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Consumes the printer, returning the rendered tree.
    #[must_use]
    pub fn finish(self) -> String {
        self.out
    }

    fn line(&mut self, text: impl fmt::Display) {
        for _ in 0..self.indent {
            self.out.push_str("  ");
        }
        self.out.push_str(&text.to_string());
        self.out.push('\n');
    }
}
```

三点：

- `#[derive(Default)]` 给出"全零值"：`String::new()` 和 `0`。第 2 篇的 `SourceMap` 也这样。
- `finish(self)` 按值接收 `self`：打印器被**消耗**，调用者拿到里面的 `String`，不用拷贝。这是 C++ 里 `std::move(out_)` 再返回的写法，只是 Rust 的移动由编译器保证之后没人能再碰旧值。
- `fn line(&mut self, text: impl fmt::Display)`：参数位置的 `impl Trait`。它等价于 `fn line<T: fmt::Display>(&mut self, text: T)`，一个**匿名**的泛型参数。我在实验里并排写了两种形式（`src/bin/ch05_impl_trait.rs`），输出一致：

  ```rust
  fn shout_generic<T: Display>(value: T) -> String { format!("{value}!") }
  fn shout_impl(value: impl Display) -> String { format!("{value}!") }
  ```

  ```text
  42!
  pebble!
  1.5!
  ```

  最后一行来自 `shout_generic::<f64>(1.5)`，用到了**涡轮鱼**语法 `::<T>` 显式指定类型参数（第 4 篇的 `parse::<i64>` 同款）。`impl Trait` 的好处是不用起名字，缺点是调用者不方便手动指定类型，所以它适合"我只关心它能 Display"的小函数。

现在实现 `Visit`，只覆盖两个方法：

```rust
impl Visit for AstPrinter {
    fn visit_stmt(&mut self, stmt: &Stmt) {
        let label = match stmt {
            Stmt::Let { name, .. } => format!("let {name}"),
            Stmt::Fn { name, params, .. } => {
                format!("fn {name}({})", join_params(params))
            }
            Stmt::Expr { .. } => "expr".to_string(),
            Stmt::If { .. } => "if".to_string(),
            Stmt::While { .. } => "while".to_string(),
            Stmt::For { var, .. } => format!("for {var}"),
            Stmt::Return { .. } => "return".to_string(),
            Stmt::Break { .. } => "break".to_string(),
            Stmt::Continue { .. } => "continue".to_string(),
        };
        self.line(label);
        self.indent += 1;
        walk_stmt(self, stmt);
        self.indent -= 1;
    }
```

这就是访问者的使用方式：先打印自己，缩进加一，**调用 `walk_stmt` 让默认逻辑去走孩子**（孩子又回到我们覆盖的 `visit_stmt`/`visit_expr`），再缩进减一。`walk_stmt(self, stmt)` 在这里 `self` 是 `&mut AstPrinter`，是一个有大小的具体类型，没有 `?Sized` 的问题。

`visit_expr` 同理，标签的内容是我们对每个节点想看到的信息：

```rust
    fn visit_expr(&mut self, expr: &Expr) {
        let label = match expr {
            Expr::Nil { .. } => "nil".to_string(),
            Expr::Bool { value, .. } => format!("bool {value}"),
            Expr::Int { value, .. } => format!("int {value}"),
            Expr::Float { value, .. } => format!("float {value}"),
            Expr::Str { value, .. } => format!("str {value:?}"),
            Expr::Var { name, .. } => format!("var {name}"),
            Expr::List { items, .. } => format!("list[{}]", items.len()),
            Expr::Map { entries, .. } => format!("map{{{} entries}}", entries.len()),
            Expr::Unary { op, .. } => {
                format!("unary {}", if *op == UnaryOp::Neg { "-" } else { "not" })
            }
            Expr::Binary { op, .. } => format!("binary {op}"),
            Expr::Logical { op, .. } => {
                format!(
                    "logical {}",
                    if *op == LogicalOp::And { "and" } else { "or" }
                )
            }
            Expr::Assign { .. } => "assign".to_string(),
            Expr::Call { args, .. } => format!("call({} args)", args.len()),
            Expr::Index { .. } => "index".to_string(),
            Expr::Fn { params, .. } => format!("fn({})", join_params(params)),
        };
        self.line(label);
        self.indent += 1;
        walk_expr(self, expr);
        self.indent -= 1;
    }
}
```

`{value:?}` 用 `Debug` 格式，字符串会带上引号并转义；`map{{{} entries}}` 里 `{{` 和 `}}` 是格式字符串里的字面花括号。`*op == UnaryOp::Neg`：`op` 是 `&UnaryOp`，先解引用再比较；这样写要求 `UnaryOp: PartialEq`，我们 derive 了。

还差一个小辅助和一个入口函数：

```rust
fn join_params(params: &[Ident]) -> String {
    params
        .iter()
        .map(|param| param.name.clone())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Convenience wrapper around [`AstPrinter`].
#[must_use]
pub fn pretty(program: &Program) -> String {
    let mut printer = AstPrinter::new();
    printer.visit_program(program);
    printer.finish()
}
```

`join_params` 接收 `&[Ident]`（切片），而调用处传的是 `&Vec<Ident>`，又是一次解引用强制转换（`Vec<T>` 解引用成 `[T]`）。`.map(|param| ...)` 是第 2 篇的闭包，`.collect::<Vec<_>>()` 里的 `_` 让编译器自己推元素类型。`pretty` 里 `printer.visit_program(program)` 没有覆盖 `visit_program`，用的就是 trait 的默认实现，它会调用 `walk_program`，也就是我们前面写的，里面用 `for stmt in program`（`IntoIterator`）逐个交给 `visit_stmt`，正好把前面所有零件串起来。

## 测试

最后是测试，放在文件末尾。四个测试，两个看 `Spanned`，一个看打印，一个看默认访问者：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn dummy() -> Span {
        Span::DUMMY
    }

    #[test]
    fn derive_spanned_reads_the_span_field() {
        let ident = Ident::new("x", Span::new(pebble_span::SourceId(3), 5, 6));
        assert_eq!(ident.span(), Span::new(pebble_span::SourceId(3), 5, 6));
    }

    #[test]
    fn derive_spanned_works_on_enum_variants() {
        let expr = Expr::Int {
            value: 7,
            span: Span::new(pebble_span::SourceId(0), 10, 11),
        };
        assert_eq!(expr.span(), Span::new(pebble_span::SourceId(0), 10, 11));

        let stmt = Stmt::Break { span: dummy() };
        assert_eq!(stmt.span(), dummy());
    }
```

测试名里有 `derive_`，这是仓库的名字：下一篇我们删掉手写 `impl`、换成派生宏之后，这两个测试一字不改继续通过，它们验证的是行为，不是实现。这就是测试存在的理由。

```rust
    #[test]
    fn printer_walks_the_whole_tree() {
        let program = Program::new(vec![Stmt::Fn {
            name: Ident::new("add", dummy()),
            params: vec![Ident::new("a", dummy()), Ident::new("b", dummy())],
            body: vec![Stmt::Return {
                value: Some(Expr::Binary {
                    op: BinaryOp::Add,
                    lhs: Box::new(Expr::Var {
                        name: Ident::new("a", dummy()),
                        span: dummy(),
                    }),
                    rhs: Box::new(Expr::Var {
                        name: Ident::new("b", dummy()),
                        span: dummy(),
                    }),
                    span: dummy(),
                }),
                span: dummy(),
            }],
            span: dummy(),
        }]);

        let rendered = pretty(&program);
        let expected = "\
fn add(a, b)
  return
    binary +
      var a
      var b
";
        assert_eq!(rendered, expected);
    }
```

那个 `"\` 开头的字符串：行尾的反斜杠吞掉紧随其后的换行，让 `fn add(a, b)` 紧贴开头的引号，这样期望值的每一行从第一列开始，读起来就是输出本身。我在一个独立的小程序里把同一棵树直接 `print!("{}", pretty(&program))`，得到的就是上面的五行。（那个"手搓一棵树"的程序之所以这么啰嗦，是因为解析器要到第 7 篇才有。）

```rust
    #[test]
    fn default_visit_reaches_every_expression() {
        struct Counter(usize);
        impl Visit for Counter {
            fn visit_expr(&mut self, expr: &Expr) {
                self.0 += 1;
                walk_expr(self, expr);
            }
        }

        let program = Program::new(vec![Stmt::Let {
            name: Ident::new("x", dummy()),
            value: Expr::List {
                items: vec![
                    Expr::Int {
                        value: 1,
                        span: dummy(),
                    },
                    Expr::Int {
                        value: 2,
                        span: dummy(),
                    },
                ],
                span: dummy(),
            },
            span: dummy(),
        }]);

        let mut counter = Counter(0);
        counter.visit_program(&program);
        // list, 1, 2
        assert_eq!(counter.0, 3);
    }
}
```

最后一个测试在**函数里定义了一个类型和它的 trait 实现**：Rust 允许在任何块里声明 `struct` 和 `impl`，它们只在这个块内可见，不污染外面。它只覆盖 `visit_expr` 一个方法，数一下表达式节点个数，就足以证明"默认遍历到达每个节点"。

## 检查点

在工作区根目录运行：

```bash
cargo test -p pebble-ast
```

我的输出（真实运行，Rust 1.95.0）：

```text
running 4 tests
test tests::default_visit_reaches_every_expression ... ok
test tests::derive_spanned_reads_the_span_field ... ok
test tests::derive_spanned_works_on_enum_variants ... ok
test tests::printer_walks_the_whole_tree ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

整个工作区也应该是绿的（`cargo test --workspace`）：`pebble-span` 6 个、`pebble-diag` 4 个、`pebble-lexer` 12 个、`pebble-ast` 4 个测试。顺手跑一遍 `cargo clippy --workspace --all-targets -- -D warnings` 和 `cargo fmt --all --check`，两个都应该没有输出。

**已经等于仓库（tag `tutorial-v1`）的文件：**

- [`crates/pebble-span/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-span/src/lib.rs)
- [`crates/pebble-diag/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-diag/src/lib.rs)
- [`crates/pebble-lexer/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-lexer/src/lib.rs)

**中间状态的文件（第 6 篇会改成仓库版本）：**

- [`crates/pebble-ast/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-ast/src/lib.rs)：我用 `diff` 对照过，和仓库的区别只有这些：头部文档少了最后一句；少了 `pub use pebble_macros::Spanned;` 那一段；`Ident`、`Stmt`、`Expr` 上的 `#[derive(...)]` 里没有 `Spanned`；多了你手写的三个 `impl Spanned`。其余每一行，包括四个测试，逐字节相同。
- [`crates/pebble-ast/Cargo.toml`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-ast/Cargo.toml)：少一行 `pebble-macros.workspace = true`。

## 练习

**1. 给 AST 加一种语句。** 按上文的实验，在 `Stmt` 里加一个 `Block { body: Vec<Stmt>, span: Span }` 变体，让 `cargo test -p pebble-ast` 重新变绿。具体要改哪几处？打印器里 `Block` 该显示成什么？

<details>
<summary>参考答案</summary>

编译器会列出三处 `E0004`，每处补一个分支：

1. `impl Spanned for Stmt`：在或模式里加一个分支 `| Stmt::Block { span, .. }`，让 `=> *span,` 跟在这个新分支后面。
2. `walk_stmt`：加
   ```rust
   Stmt::Block { body, .. } => {
       for stmt in body {
           visitor.visit_stmt(stmt);
       }
   }
   ```
3. `AstPrinter::visit_stmt`：加 `Stmt::Block { .. } => "block".to_string(),`。

我在一份拷贝上按这三处改完，`cargo test -p pebble-ast` 依然 4 个测试全过。第 1 处是纯机械劳动，这正是下一篇要消灭的东西。

</details>

**2. 写一个访问者，数变量引用和 `let` 语句各有多少。** 构造 `let y = x + x;` 这棵树，期望输出 `lets = 1, reads = 2`。再通过 `&mut dyn Visit` 调用一遍，数字应该是多少？

<details>
<summary>参考答案</summary>

```rust
#[derive(Default)]
struct VarCounter {
    reads: usize,
    lets: usize,
}

impl Visit for VarCounter {
    fn visit_stmt(&mut self, stmt: &Stmt) {
        if matches!(stmt, Stmt::Let { .. }) {
            self.lets += 1;
        }
        walk_stmt(self, stmt);
    }

    fn visit_expr(&mut self, expr: &Expr) {
        if matches!(expr, Expr::Var { .. }) {
            self.reads += 1;
        }
        walk_expr(self, expr);
    }
}
```

`matches!(value, pattern)` 是标准库宏，展开成一个返回 `bool` 的 `match`（第 7 篇的解析器里会大量使用）。我构造了那棵树，运行结果：

```text
lets = 1, reads = 2
through dyn Visit: lets = 2, reads = 4
```

第二行是第二次遍历累加的结果（计数器没有被清零），关键是 `let dynamic: &mut dyn Visit = &mut counter; dynamic.visit_program(&program);` 能编译，这就是 `?Sized` 放开的那条路。

</details>

**3. 为什么 `Expr::List { items: Vec<Expr> }` 不需要 `Box`，而 `Expr::Unary { operand: Box<Expr> }` 需要？**

<details>
<summary>参考答案</summary>

编译器要求每个类型有固定大小。`Vec<T>` 不管 `T` 是什么，自己永远是三个字（指针、容量、长度），共 24 字节，元素存在堆上。所以 `Expr` 包含一个 `Vec<Expr>` 时，大小里只算这 24 字节，没有无穷递归。`operand: Expr`（不装箱）则会让 `Expr` 直接包含 `Expr`，得到 E0072。实验 `ch05_box` 的输出就是证据：带 `List(Vec<Expr>)` 变体的 `Expr` 编译通过，`Vec<Expr>` 是 24 字节，`Box<Expr>` 是 8 字节。

附带一个推论：`Vec` 和 `Box` 在这里是等价的"间接层"，选哪个看你是要一个还是一串。

</details>

AST 现在立起来了，而且你也有了第一份值得怀疑的代码：三段 `| ... { span, .. }` 几乎一模一样的 `match`。下一篇我们走进 Rust 最容易被说成"黑魔法"的部分：写一个**过程宏**，让编译器在每次编译时替我们生成这些代码，删掉它们，并且让测试一个字不改继续通过。
