---
title: "所有权、借用与生命周期：我把编译器惹毛了三次"
commentId: "post:pebble-rust-03-ownership"
published: "2026-10-05 07:10:00 +08:00"
description: "所有权是 Rust 里唯一一个别的语言没有的东西，也是新手最先撞墙的地方。这篇不背规则，而是直接写错三段代码，把 rustc 的原话抄下来，再解释它在说什么：移动之后为什么不能再用、共享借用和可变借用为什么不能同时存在、'src 那个尖括号里的东西到底标什么。全部用 Span 和 Lexer 的真实代码收尾。"
category: Note
tags:
  - Rust
  - 所有权
  - 借用
  - 生命周期
  - 基础
series: "从零学 Rust：Pebble 基础篇"
seriesOrder: 3
draft: false
comment: true
slug: pebble-rust-03-ownership
---

标准库会用之后，就剩最后一个、也是唯一的"Rust 独有"门槛：所有权。别的语言要么手动 `free`，要么靠 GC；Rust 选了第三条路，让**编译器证明**内存安全。

我不想背规则，所以直接写了三段会报错的代码，把 `rustc` 的原话抄下来，一条条看。

## 第一次：移动之后还想用

```rust
fn main() {
    let a = String::from("hi");
    let b = a;
    println!("b is {b}, a is {a}");
}
```

编译：

```text
error[E0382]: borrow of moved value: `a`
 --> pebble_move.rs:4:31
  |
2 |     let a = String::from("hi");
  |         - move occurs because `a` has type `String`, which does not implement the `Copy` trait
3 |     let b = a;
  |             - value moved here
4 |     println!("b is {b}, a is {a}");
  |                               ^ value borrowed here after move
  |
help: consider cloning the value if the performance cost is acceptable
  |
3 |     let b = a.clone();
  |              ++++++++
```

`let b = a;` 不是复制，是**移动**：`a` 这个小标签（指向堆上 `"hi"` 的指针加长度）被搬到了 `b`，`a` 从此失效。所以第 4 行再用 `a` 就是"用了已移动的值"。

为什么 Rust 要这样？因为 `String` 拥有堆上那块内存。如果 `a` 和 `b` 都"拥有"它，作用域结束时就会 `free` 两次。编译器干脆不允许两个所有者。

编译器还顺手给了建议：`a.clone()`。`.clone()` 是**显式**复制：`a` 仍然有效，`b` 是独立的一份。Rust 里所有可能花大钱的复制都要求你写出来，不允许"悄悄的深拷贝"。

## 为什么 `Span` 没报这个错

同样的写法，换成 Pebble 的 `Span` 就没事：

```rust
#[derive(Copy, Clone, PartialEq, Eq, Hash)]
pub struct Span {
    pub source: SourceId,
    pub start: u32,
    pub end: u32,
}
```

秘密在 `#[derive(Copy)]`。**`Copy` 的类型按位复制，赋值不是移动**，原变量继续可用。`Span` 是四个小整数，复制它和复制一个 `u32` 一样便宜，所以让它 `Copy` 是对的。

规则变成一句话：**能用 `Copy` 就用（整数、布尔、字符、`Span` 这种小结构），不能猜、明确拥有资源的用移动（`String`、`Vec`、`HashMap`）。** 编译器自己会告诉你哪个是哪个：错误信息里那句 "which does not implement the `Copy` trait" 就是在说"这个类型是移动的"。

`Rc<T>` 是个特例：它也是移动语义，但移动的是"引用计数"那份小结构，堆上的数据还在原地。想多一个所有者，用 `Rc::clone(&x)`，它只把计数加一，不复制数据（这就是为什么它比 `.clone()` 便宜），只是名字里也带 clone，容易让人误会。

## 第二次：共享借用和可变借用撞车

```rust
fn main() {
    let mut counts = vec![1, 2, 3];
    let first = &counts[0];
    counts.push(4);
    println!("first is {first}");
}
```

编译：

```text
error[E0502]: cannot borrow `counts` as mutable because it is also borrowed as immutable
 --> pebble_borrow.rs:4:5
  |
3 |     let first = &counts[0];
  |                  ------ immutable borrow occurs here
4 |     counts.push(4);
  |     ^^^^^^^^^^^^^^ mutable borrow occurs here
5 |     println!("first is {first}");
  |                         ----- immutable borrow later used here
```

翻译成人话：`first` 借了 `counts` 的**只读**视图（第 3 行），你却在第 4 行要改它（`push` 可能要重新分配内存，让 `first` 变成悬垂指针），而 `first` 在第 5 行还要用，所以这段借用还没结束。

修法是把 `first` 用完再改，或者干脆先拷贝一份值：

```rust
let first = counts[0];   // i32 是 Copy，复制出来，不再是借用
counts.push(4);
println!("first is {first}");
```

这条规则合起来就是借用检查器的核心：**同一时刻，要么任意多个只读借用 `&T`，要么唯一一个可变借用 `&mut T`，两者不能重叠。** 这条限制在单线程里看着多余，但它恰好就是"不会有两个线程同时读写同一块内存"的静态保证。Rust 用同一条规则同时挡住了悬垂指针和数据竞争。

顺带说一个容易吓到新手的现象：错误信息里说"借用在这里被使用"，可能只是因为你**后来**打印了它。这叫非词法生命周期（NLL）：借用的有效期到**最后一次使用**为止，而不是到作用域结束。所以把 `println!` 删掉，这段代码反而能编译过。

## 第三次：同事要读、我要写

这次不是玩具例子，是 `pebble-vm` 里真实写过的一段。索引赋值时我一开始这么写：

```rust
match self.heap.get_mut(reference) {
    VmObject::List(items) => {
        let position = self.resolve_index(items.len(), index, span)?;  // 调 &self
        items[position] = value;
    }
    // ...
}
```

`get_mut` 拿的是 `self.heap` 的**可变**借用，而 `self.resolve_index(...)` 又要 `&self`（只读借用），两者重叠，编译器不让。

修法不是加 `mut` 硬顶，而是**调整顺序**：先用只读借用把长度取出来，算好下标，再单独拿可变借用去改。

```rust
let length = match self.heap.get(reference) {
    VmObject::List(items) => Some(items.len()),
    VmObject::Map(_) => None,
    _ => return Err(/* ... */),
};
match length {
    Some(len) => {
        let position = self.resolve_index(len, index, span)?;   // 此时没有借用了
        if let VmObject::List(items) = self.heap.get_mut(reference) {
            items[position] = value;
        }
        Ok(())
    }
    // ...
}
```

这段重构看着比原来啰嗦，但它逼我想清楚一件正事："到底哪一步需要独占？" 顺带一提，所谓 `RefCell` 就是用来在**运行时**跳过这层分析的，代价是把错误从编译期推迟到运行期。图的环、闭包捕获环境这类结构，静态分析常常给不出答案，那时才请出 `Rc<RefCell<..>>`。

## 借用长什么样

`&T` 是只读借用，`&mut T` 是可写借用，用起来和普通引用一样：

```rust
pub fn position(&self, offset: u32) -> Position { /* ... */ }   // &self 是只读借用
pub fn add(&mut self, name: impl Into<String>, value: Value)     // &mut self 允许改
```

函数参数里，**接收借用而不是接收所有权**是默认习惯。这样调用者还能继续用原来的值。Pebble 的 `visit_expr(&mut self, expr: &Expr)` 就是"我借用表达式看一眼，不把它吃掉"。

切片也是一种借用：`&[u8]` 是"借来的一段字节"，`&str` 是"借来的一段文字"。它们不拥有数据，所以传入传出都很便宜。

## 生命周期：`'src` 到底是什么

新手看到 `<'src>` 会紧张，其实它只是**给一个借用起个名字**，好让编译器知道"这个返回值活多久"。

看词法器的 token：

```rust
pub enum TokenKind<'src> {
    Str(Cow<'src, str>),
    Ident(&'src str),
    // ...
}
```

`'src` 的意思是："这里面借的字符串，活得和**某个叫 src 的东西**一样久。" 于是 token 只能在源码还存在的时候使用。这不是限制，这是**保证**：编译器替你挡掉"先释放源码、再读 token"。

词法器本身也带着这个名字：

```rust
pub struct Lexer<'src> {
    source: SourceId,
    src: &'src str,
    pos: usize,
    done: bool,
}
```

注意这个返回类型：

```rust
fn rest(&self) -> &'src str {
    &self.src[self.pos..]
}
```

这里我**显式写了 `'src`**，而不是让它跟着 `&self`。意思是：切出来的那段文字，活得和**源头**一样久，而不是和"这次对 lexer 的借用"一样久。这个区别让调用方可以拿着切片，即使之后 lexer 又被借用了。如果我省略不写，Rust 会按默认规则把它绑到 `&self` 上，反而更难用。

那"默认规则"是什么？大多时候不用你写，编译器按**生命周期省略**规则补：

```rust
pub fn line(&self, line: u32) -> Option<&str>
```

这个签名能编译，是因为规则说："只有一个输入引用 `&self`，那返回值的引用就借自它"。也就是 `line(1)` 返回的 `&str` 只能在 `self`（那个 `SourceFile`）还活着的时候用。合理。

`'static` 是最长的那个：活到程序结束。字符串字面量自带 `'static`，Pebble 的内建函数也用：

```rust
Native(&'static NativeFunction),
```

因为内建函数是 `static` 常量，永远不会被释放，所以指向它们的引用可以活到程序结束。

## 一个更隐蔽的例子：`?Sized`

写 visitor 时我踩过一个不报错在逻辑上、但报错在类型上的坑。`Visit` trait 的默认方法长这样：

```rust
pub trait Visit {
    fn visit_expr(&mut self, expr: &Expr) { walk_expr(self, expr); }
}
```

而一开始 `walk_expr` 的签名是：

```rust
pub fn walk_expr(visitor: &mut impl Visit, expr: &Expr) { /* ... */ }
```

编译报："the size for values of type `Self` cannot be known at compilation time"。原因是 `impl Visit` 要求类型大小已知，而 trait 里的 `Self` 默认并不保证这一点。修法是把参数放宽：

```rust
pub fn walk_expr<V: Visit + ?Sized>(visitor: &mut V, expr: &Expr) { /* ... */ }
```

`?Sized` 的意思是"我不要求它大小已知"，于是 `self` 这种可能不满足 `Sized` 的东西也能传进来。这类错误看起来唬人，其实每次都是在提醒你："你描述的约束比实际需要的更严"。

## 动手：读两段真实代码

理论够了，去读 `pebble-lexer` 里两个函数，它们把上面所有东西都用了一遍：

```rust
fn peek(&self) -> Option<char> {
    self.rest().chars().next()
}

fn bump(&mut self) -> Option<char> {
    let ch = self.peek()?;
    self.pos += ch.len_utf8();
    Some(ch)
}
```

`peek` 只读（`&self`），返回一个 `char`（`Copy`，拿走没问题）。`bump` 要改（`&mut self`），先 `peek` 看一眼，再看这个字符占几个字节，把位置往前推。注意 `ch.len_utf8()`：Rust 的 `char` 是真正的 Unicode 标量，占 1 到 4 个字节，所以位置必须按字节推进，不能按字符个数。

这就是所有权在真实代码里的样子：不是一堆规则，是"谁在读、谁在写、谁活多久"三个问题的答案。编译器只是把答案对了一遍。

## 下一步

语法、标准库、所有权，三关过了，就还剩一个很实际的问题：**代码往哪放**。`use` 的那一串路径是从哪棵树上来的、一个 crate 和一个包有什么区别、16 个 crate 的 `Cargo.toml` 是怎么互相引用的、`dev-dependencies` 和 `build-dependencies` 又是什么。下一篇讲 Cargo 与项目组织。
