---
title: "AST 与三种宏：用枚举表达语法树"
commentId: "post:pebble-04-ast-and-macros"
published: "2026-10-05 11:00:00 +08:00"
description: "AST 是 Rust 枚举真正发光的地方：递归枚举 + Box + 模式匹配。这一篇还写了三种宏：用 #[derive(Spanned)] 让每个节点自动知道自己的位置，用函数式宏 opcode_set! 生成字节码指令表，用声明式宏 chunk! 拼一段指令流。"
category: Note
tags:
  - Rust
  - 宏
  - 过程宏
  - AST
series: "从零写一门语言：Pebble"
seriesOrder: 4
draft: false
comment: true
slug: pebble-04-ast-and-macros
---

如果让我选一个"最能体现 Rust 为什么适合写编译器"的特性，我会选 `enum`。Pebble 的整个语法树就是两个递归枚举。

> [!TIP] 先读基础篇
> 本篇用到递归 `enum`、`Box`、trait 与泛型。过程宏是进阶内容，读不懂可以只关注 AST 那一部分。基础不牢先看基础篇 1 和 3。

## 递归枚举 + Box

一个表达式是这样表达的：

```rust
pub enum Expr {
    Nil { span: Span },
    Int { value: i64, span: Span },
    Str { value: String, span: Span },
    Var { name: Ident, span: Span },
    List { items: Vec<Expr>, span: Span },
    Map { entries: Vec<(Expr, Expr)>, span: Span },
    Unary { op: UnaryOp, operand: Box<Expr>, span: Span },
    Binary { op: BinaryOp, lhs: Box<Expr>, rhs: Box<Expr>, span: Span },
    Logical { op: LogicalOp, lhs: Box<Expr>, rhs: Box<Expr>, span: Span },
    Assign { target: Box<Expr>, value: Box<Expr>, span: Span },
    Call { callee: Box<Expr>, args: Vec<Expr>, span: Span },
    Index { object: Box<Expr>, index: Box<Expr>, span: Span },
    Fn { params: Vec<Ident>, body: Vec<Stmt>, span: Span },
}
```

两个刻意的设计：

第一，**递归成员用 `Box`**。`Expr` 里不能再直接放一个 `Expr`，否则大小无限。`Box` 把它挪到堆上，大小就确定了。

第二，**每个变体都带一个名叫 `span` 的字段，而且是命名字段而不是元组变体**。这看起来啰嗦，`Expr::Int { value: 1, span }` 比 `Expr::Int(1, span)` 长，但它让下面这个宏成为可能。

## 让每个节点自动知道位置

我定义了一个极小的 trait：

```rust
pub trait Spanned {
    fn span(&self) -> Span;
}
```

然后写一个 derive 宏，让 AST 节点自动实现它。用法就一行：

```rust
#[derive(Clone, Debug, PartialEq, Spanned)]
pub enum Expr { /* ... */ }
```

宏内部做两件事。对结构体，找 `span` 字段直接返回；对枚举，对每个变体生成一条 match 分支：

```rust
Data::Enum(data) => {
    let arms = data.variants.iter().map(|variant| {
        let variant_name = &variant.ident;
        let member = span_member(&variant.fields)?;
        Ok(quote!(Self::#variant_name { #member, .. } => * #member))
    }).collect::<syn::Result<Vec<_>>>()?;
    quote! { match self { #(#arms),* } }
}
```

`quote!` 里 `#(...)*` 是重复展开，把每条分支缝进 `match`。生成出来的就是：

```rust
fn span(&self) -> Span {
    match self {
        Self::Nil { span, .. } => *span,
        Self::Int { span, .. } => *span,
        // ...
    }
}
```

这就是为什么每个变体都得有 `span`：宏没法凭空知道你打算把位置放在哪。如果哪个变体漏了，`span_member` 会返回一个带位置的编译错误，而不是让人一脸茫然。

## Visitor：带默认实现的 trait

遍历 AST 的经典写法是 visitor。Pebble 的 `Visit` trait 给每个方法一个默认实现：

```rust
pub trait Visit {
    fn visit_program(&mut self, program: &Program) { walk_program(self, program); }
    fn visit_stmt(&mut self, stmt: &Stmt) { walk_stmt(self, stmt); }
    fn visit_expr(&mut self, expr: &Expr) { walk_expr(self, expr); }
}
```

真正干活的是 `walk_*` 这些自由函数，它们负责递归地走到子节点。这里我踩过一个 borrow checker 的坑，值得记一下。一开始签名是：

```rust
pub fn walk_expr(visitor: &mut impl Visit, expr: &Expr) { /* ... */ }
```

结果默认方法里 `self.visit_expr(...)` 直接编译不过，报的是 "the size for values of type `Self` cannot be known at compilation time"。原因：trait 方法里的 `self: &mut Self`，而 `Self` 默认不保证 `Sized`；但 `impl Visit` 这个参数要求 `Sized`。修法很简单，把 `walk_*` 放宽到 `?Sized`：

```rust
pub fn walk_expr<V: Visit + ?Sized>(visitor: &mut V, expr: &Expr) { /* ... */ }
```

这样默认方法里 `walk_expr(self, expr)` 就对上了。`rustc` 自己的 visitor 也是类似的处理方式。

有了它，写一个"只数表达式节点"的 visitor 只要覆盖一个方法：

```rust
struct Counter(usize);
impl Visit for Counter {
    fn visit_expr(&mut self, expr: &Expr) {
        self.0 += 1;
        walk_expr(self, expr);   // 继续往下走
    }
}
```

## 真的把树打出来

`AstPrinter` 是 `Visit` 的一个实现，把 AST 渲染成缩进树。`pebble parse` 用的就是它：

```text
$ pebble parse examples/closures.pebble
fn make_counter()
  let count
    int 0
  return
    fn()
      expr
        assign
          var count
          binary +
            var count
            int 1
      return
        var count
let next
  call(0 args)
    var make_counter
expr
  call(1 args)
    var print
    call(0 args)
      var next
```

这段输出同时验证了三件事：闭包被解析成了 `Expr::Fn`，赋值 `count = count + 1` 被解析成了 `Expr::Assign`，而 `+` 的左右两边分别是 `var count` 和 `int 1`。

## 函数式宏：生成指令表

Pebble 的字节码有几十个指令。手写"一个枚举 + 一个 `name()` 方法"是纯样板。我写了个函数式宏：

```rust
opcode_set! {
    pub enum Opcode {
        Const(u32),
        Add,
        Jump(u32),
        Call(u32),
        Return,
        // ...
    }
}
```

实现上，它把这坨 token 当成一个 `syn::ItemEnum` 解析，然后重新发射成"原样枚举 + 一个 name 表"：

```rust
let arms = variants.iter().map(|variant| {
    let variant_name = &variant.ident;
    if variant.fields.is_empty() {
        quote!(#name::#variant_name => stringify!(#variant_name))
    } else {
        quote!(#name::#variant_name(..) => stringify!(#variant_name))
    }
});
quote! {
    #[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
    #vis enum #name { #variants }
    impl #name {
        #[must_use]
        pub const fn name(self) -> &'static str {
            match self { #(#arms),* }
        }
    }
}
```

`stringify!` 在编译期把标识符变成字符串字面量，所以 `name()` 可以是 `const fn`。反汇编器里每一行指令名都是这么来的。

## 声明式宏：拼一段指令流

第三种宏是最朴素的 `macro_rules!`。写测试的时候经常要手搓一段字节码，我就在 `pebble-bytecode` 里放了一个 `chunk!`：

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

用起来是 `chunk![Opcode::Nil, Opcode::Return]`，末尾还允许一个逗号。它和过程宏的区别值得说清楚：`macro_rules!` 是**模式匹配 token**，够用就好、零依赖；过程宏能跑真正的 Rust 代码、看见类型信息，但要多一个 crate 和一堆 `syn`/`quote` 样板。Pebble 里三种都用到了，各司其职。

## 下一篇

有了词法器和 AST，中间那根线就是解析器。下一篇是递归下降加 Pratt 表达式解析，重点是怎么在出错之后**继续解析**，把一份文件里的多个错误一次性报出来。
