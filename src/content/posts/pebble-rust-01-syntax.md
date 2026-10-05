---
title: "Rust 语法速览：从 Span 的十行代码开始"
commentId: "post:pebble-rust-01-syntax"
published: "2026-10-05 06:00:00 +08:00"
description: "如果你还没写过 Rust，直接读实现篇会被语法绊住。这篇是基础篇的第一篇：变量为什么默认不可变、标量和复合类型、函数里最后一个表达式就是返回值、struct 与 impl、enum 与穷尽 match、Option 和 Result 入门。每个语法点都用 Pebble 里真实存在的 pebble-span 代码来讲。"
category: Note
tags:
  - Rust
  - 语法
  - 入门
  - 基础
series: "从零学 Rust：Pebble 基础篇"
seriesOrder: 1
draft: false
comment: true
slug: pebble-rust-01-syntax
---

实现篇默认你会 Rust，这对刚开始学的人是个断层。所以我补了这个基础篇：**先把语法、标准库、所有权、项目组织讲清楚，再去看那门语言是怎么被造出来的**。第一篇只讲语法，例子全部来自 Pebble 里最底层、也最干净的 crate：`pebble-span`。

它总共 360 行，干的事只有一件：记住"某段源码从头到哪个字节"。小到可以在一次阅读里看完，正适合拿来学语法。

## 先让它跑起来

先把仓库拉下来，跑通最小的那条命令：

```bash
git clone https://github.com/bfmhno3/pebble
cd pebble
nix develop        # 或者系统里装 Rust >= 1.88
cargo test -p pebble-span
```

输出是：

```text
running 6 tests
......
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

`-p pebble-span` 的意思是"只测这一个包"。一个 Cargo 工作区里有很多包，`-p` 用来点名。这 6 个测试全在 `crates/pebble-span/src/lib.rs` 文件末尾，等下我们会回头逐个看。

`src/lib.rs` 是一个**库 crate** 的入口，对应"一个包"。库就是给别人 `use` 的代码；与之对应的是**二进制 crate**，入口是 `src/main.rs`，编译出可执行文件，有自己的 `fn main()`。Pebble 的 CLI 就是后者。

## 变量默认不可变

这是 Rust 最容易让新手踩坑、也最值得先记住的一条：`let` 声明出来的变量**不可变**。

```rust
let x = 5;
// x = 6;   // 编译不过：cannot assign twice to immutable variable
```

要改就得显式写 `mut`（mutable 的缩写）：

```rust
let mut count = 0;
count = count + 1;
```

为什么默认不可变？因为大多数变量从赋值那一刻起就不该再变，编译器帮你把"手滑改了"变成编译错误。等你写过大一点的程序就会感谢它。

还有一个和 `mut` 不一样、但很有用的写法叫 **shadowing（遮蔽）**：用新的 `let` 覆盖旧名字，类型甚至可以变。

```rust
let size = "42";        // &str
let size = size.len();  // 现在 size 是 usize
```

这不是"改"，是"用一个新变量挡住旧的"。Pebble 的 lexer 里就这么用过：先把原始文本读进来，再重新绑定成去掉下划线之后的版本。

类型大多数时候不用写，编译器能推断出来；想写也可以：

```rust
let start: u32 = 0;
let ratio: f64 = 0.25;
```

## 类型：标量与复合

Rust 的标量类型主要有：

| 类型 | 含义 | Pebble 里在哪 |
| --- | --- | --- |
| `i32` / `i64` | 有符号整数 | 整数运算用 `i64` |
| `u32` | 无符号整数 | 字节偏移、行号用 `u32` |
| `usize` | 指针宽度无符号整数 | 所有下标、长度 |
| `f64` | 双精度浮点 | 浮点数 |
| `bool` | 布尔 | 到处 |
| `char` | 一个 Unicode 字符 | lexer 逐个读字符 |

整数类型默认是 `i32`，但 Rust **不会**在不同宽度之间自动转换。`u32` 想当 `usize` 用，得显式写 `as usize`。Pebble 里到处能看到这种转换：字节偏移存成 `u32`，但拿去索引数组时变成 `usize`。

复合类型常用的有两种：

```rust
let point = (3u32, 7u32);      // 元组：不同类型也能装一起
let bytes = [0u8; 3];          // 数组：长度写在类型里，固定
let slice: &[u8] = &bytes;     // 切片：数组的一段视图
```

字符串有两种，这个必须早点分清楚：

- `&str` 是**借来的**字符串，不能改，通常指向别人拥有的那块内存里的一个片段。
- `String` 是**自己拥有的**、可以增长和修改的字符串。

Pebble 的词法器整个建立在 `&str` 上：token 不复制源码，只是指向它。这正是"零拷贝"。`pebble-span` 里存文件名和源码用的是 `String`，因为它得自己拥有。

## 函数：最后一个表达式就是返回值

```rust
fn add(a: i64, b: i64) -> i64 {
    a + b
}
```

注意 `a + b` 后面**没有分号**。在 Rust 里，"没有分号的那一行"是一个**表达式**，它的值就是函数的返回值。加上分号就变成一条**语句**，值被丢掉，函数返回 `()`（读作 unit，空元组）。

这条规则看着小，但它解释了 Rust 里一大堆写法。看 `pebble-span` 里真实的函数：

```rust
impl Span {
    /// Number of bytes covered by the span.
    #[must_use]
    pub const fn len(self) -> u32 {
        self.end.saturating_sub(self.start)
    }
}
```

逐行读：

- `impl Span { ... }` 是给 `Span` 这个类型加方法。
- `pub` 表示这个方法对其他 crate 可见；不写就是私有的。
- `const fn` 表示它能在编译期被调用，所以可以拿它初始化常量。
- `self` 是方法的第一个参数，代表"调用这个方法的那一个 `Span`"。它是按值传的，也就是把 `Span` 复制进来。
- `saturating_sub` 是 `u32` 自带的方法："饱和减法"，减到 0 就不往下减，不会负数溢出。Pebble 用它，是因为 `end` 理论上不该小于 `start`，但真出了 bug 也不该 panic，返回 0 就好。

`#[must_use]` 是个**属性**，告诉编译器："谁调用了这个函数却不用返回值，就给个警告"。对这种纯计算函数很有用。

## struct 与方法

`pebble-span` 里两种 struct 都出现了。第一种是**命名字段结构体**：

```rust
pub struct Span {
    pub source: SourceId,
    pub start: u32,
    pub end: u32,
}
```

第二种是**元组结构体**，也叫 newtype，只有一个字段：

```rust
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SourceId(pub u32);
```

`SourceId` 里面就是一个 `u32`，但给它单独起个名字，就不至于把"文件编号"和"字节偏移"两个 `u32` 搞混。这叫 newtype 模式，用类型把语义钉住，是 Rust 里很常见的习惯。

那一行 `#[derive(...)]` 是让编译器**自动生成**一堆实现：

- `Copy`：复制它就像复制一个整数一样廉价，赋值不会"移动"。
- `Clone`：可以显式 `.clone()`。
- `PartialEq` / `Eq`：可以用 `==` 比较。
- `PartialOrd` / `Ord`：可以排序、比较大小。
- `Hash`：可以当哈希表的键。

这些在别的语言里往往是语言自动带的，Rust 让你显式列出来，代价是写一行，好处是你能一眼看出"这个类型支持哪些能力"。

## enum 与穷尽的 match

Rust 的 `enum` 不是"C 那种一组整数常量"，而是"**若干种可能之一，每种可以带自己的数据**"。Pebble 的词法 token 就是一个典型：

```rust
pub enum TokenKind<'src> {
    Int(i64),
    Float(f64),
    Str(Cow<'src, str>),
    Ident(&'src str),
    Let,
    Fn,
    If,
    // ...
    Eof,
}
```

`Int(i64)` 表示"一个整数 token，里面带着它的值"；`Let` 表示"一个 `let` 关键字 token，不带数据"。一个 `TokenKind` 在任意时刻只可能是其中**一种**。

配套的是 `match`，它把这个枚举拆开，而且**必须覆盖所有情况**：

```rust
pub const fn describe(&self) -> &'static str {
    match self {
        TokenKind::Int(_) => "integer",
        TokenKind::Float(_) => "float",
        TokenKind::Str(_) => "string",
        TokenKind::Ident(_) => "identifier",
        TokenKind::Let => "`let`",
        // ...
        TokenKind::Eof => "end of file",
    }
}
```

两个语法点：

- 下划线 `_` 是通配："这里有个值，但我不关心它是什么"。
- `match` 的每个分支叫 arm，用 `=>` 连接。**如果漏掉一个变体，编译直接失败**，还会告诉你漏了哪个。这条"穷尽性检查"是 Rust 写编译器时最爽的地方之一：以后你给 `TokenKind` 加一个变体，`describe` 没跟上，编译器立刻报错。

## Option：没有 null 的语言怎么表达"可能没有"

Rust 没有 `null`。要表达"可能有一个值，也可能没有"，用标准库里的 `Option`：

```rust
pub enum Option<T> {
    Some(T),
    None,
}
```

`Option` 本身就是一个普通的枚举，`Some` 带值，`None` 表示没有。`pebble-span` 用它来表达"第 N 行在不在"：

```rust
pub fn line_start(&self, line: u32) -> Option<u32> {
    let index = line.checked_sub(1)? as usize;
    self.line_starts.get(index).copied()
}
```

这里有两个新东西：

- `self.line_starts.get(index)` 返回 `Option<&u32>`：索引超范围就是 `None`，而不是 panic。`.copied()` 把它变成 `Option<u32>`。
- 那一句 `line.checked_sub(1)?`：`checked_sub` 是"安全减法"，减出负数就返回 `None`。而 `?` 的意思是"**如果是 None，函数立刻返回 None**；如果是 Some，就把里面的值取出来继续"。

所以这一行的读法是：`line` 减 1，如果 `line` 是 0（减出负数）就直接返回 `None`；否则拿到下标，去查数组，查不到也返回 `None`。整个函数没有一句 `if`，全靠 `?` 和 `Option` 串起来。

## Result：错误也是一种返回值

`Result` 和 `Option` 长得很像，但多了"为什么失败"：

```rust
pub enum Result<T, E> {
    Ok(T),
    Err(E),
}
```

成功是 `Ok(值)`，失败是 `Err(错误)`。Rust 没有异常，错误就是普通的返回值，必须被处理，或者用 `?` 往上抛。解析器里几乎每个函数都返回 `Result`：

```rust
fn expect(&mut self, kind: &TokenKind<'src>, context: &str) -> Result<Token<'src>, Diagnostic> {
    if self.check(kind) {
        return Ok(self.advance());
    }
    let found = self.peek();
    Err(Diagnostic::error(format!("expected {}, found {}", kind.describe(), found.kind))
        .with_code("E1001")
        .with_span(found.span)
        .with_note(context.to_string()))
}
```

`?` 在 `Result` 上的语义和 `Option` 一样：`Err` 就提前返回，`Ok` 就取出里面的值。区别只是它把错误原样往上传。

`Option` 和 `Result` 的区别值得记牢：**`Option` 是"有没有"，`Result` 是"成没成，以及为什么没成"**。

## trait：接口

能"给别人实现"的能力，Rust 叫 trait。`pebble-span` 里有一个最小的：

```rust
pub trait Spanned {
    fn span(&self) -> Span;
}

impl Spanned for Span {
    fn span(&self) -> Span {
        *self
    }
}
```

`trait Spanned` 声明"任何实现它的东西，都必须提供一个 `span()` 方法"。`impl Trapped for Span` 是给 `Span` 补上这个实现。

注意 `*self`：`self` 是 `&Span`（引用），`*` 把它解引用成 `Span`，因为 `Span` 是 `Copy` 的，所以就复制一份返回。

这两个概念会贯穿整个项目：`pebble-ast` 里每个 AST 节点都实现 `Spanned`，于是任何节点都能回答"我在源码哪个位置"；`pebble-value` 里 `Value` 实现 `Display`，于是它知道怎么把自己打印成字符串。

## 模块与 use：代码怎么分堆

一个 crate 内部可以再分子模块。`pebble-span` 很小，只有一个文件，所以没有子模块；但你会看到 `use`：

```rust
use alloc::string::String;
use alloc::vec::Vec;
use core::fmt;
```

`use` 相当于"把别处的名字引进当前文件的命名空间"。这里的 `alloc` 和 `core` 是 Rust 的两个基础库：`core` 是最底层的、连操作系统都不依赖的部分；`alloc` 在 `core` 之上，提供 `Vec`、`String` 这些会分配内存的类型。为什么不用大家熟悉的 `std`？因为 `pebble-span` 是 `#![no_std]` 的，要能跑在裸机上。这一点在"项目组织"那一篇细讲。

`pub use` 则是"把名字**再导出**"：

```rust
pub use pebble_span::{Span, Spanned};
```

这行在 `pebble-ast` 里，意思是"从 `pebble_span` 拿这两个名字，并且让 `pebble_ast::Span` 也能用"。这样用的人不用关心 `Span` 到底定义在哪一层。

## 回头读那 6 个测试

语法大致够用了，现在就去看 `pebble-span` 的那 6 个测试。它们不只是"证明代码没错"，更是**用可执行的断言描述意图**。挑两个：

```rust
#[test]
fn handles_crlf() {
    let file = SourceFile::new(SourceId(0), "t".into(), "a\r\nb".into());
    assert_eq!(file.line(1), Some("a"));
    assert_eq!(file.line(2), Some("b"));
}
```

`#[test]` 标记一个测试函数；`assert_eq!` 断言两边相等。这条测试说的是："Windows 的 `\r\n` 行尾也要被正确切成两行。"简单直接。

```rust
#[test]
#[should_panic(expected = "different files")]
fn merge_across_files_is_a_bug() {
    let a = Span::new(SourceId(0), 0, 1);
    let b = Span::new(SourceId(1), 0, 1);
    let _ = a.merge(b);
}
```

这条更有意思：`#[should_panic]` 表示"这个测试**预期会 panic**，而且 panic 信息里要包含 `different files`"。它验证的不是功能，而是一条**不变量**：把两个不同文件的 span 合并，永远是编译器自己的 bug。测试在这里当"防退化的护栏"用。

## 下一步

语法能读了，但你大概已经发现一件事：`String` 和 `&str` 到底该用哪个、`Rc` 是什么、`HashMap` 怎么用、迭代器那一串 `.map().collect()` 是什么，这些都不在语法里。下一篇就是**标准库速览**：我在这门语言里用到过的每一种容器、智能指针和工具，按"什么时候用哪个"来讲。
