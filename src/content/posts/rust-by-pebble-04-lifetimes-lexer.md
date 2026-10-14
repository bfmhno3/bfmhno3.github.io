---
title: "生命周期：让 token 借用源码"
commentId: "post:rust-by-pebble-04-lifetimes-lexer"
published: "2026-10-13 11:00:00 +08:00"
description: "写 pebble-lexer：token 不复制源码而是借用它。从 C++ string_view 的悬垂说起，亲手撞上 E0106 和 E0597，再学生命周期标注、省略规则、'static、Cow、Iterator 和模式匹配，最后让词法分析器在报错之后继续往下走。"
category: Note
tags:
  - Rust
  - Pebble
  - 生命周期
  - 迭代器
  - 词法分析
series: "用 Pebble 从零学 Rust"
seriesOrder: 4
draft: false
comment: true
slug: rust-by-pebble-04-lifetimes-lexer
---

下面这段 C++ 我用 `g++ -std=c++17 -Wall -Wextra` 编译，一条警告都没有，运行打印出 `let`，看起来一切正常。其实它读的是一块已经死掉的栈内存：`token.text` 指向 `source` 里面，而 `source` 在内层花括号结束时就析构了。

```cpp
#include <iostream>
#include <string>
#include <string_view>

struct Token {
    std::string_view text;
};

Token first_word(const std::string& src) {
    return Token{std::string_view(src).substr(0, src.find(' '))};
}

int main() {
    Token token;
    {
        std::string source = "let answer = 42";
        token = first_word(source);
    }
    std::cout << token.text << "\n";
}
```

```bash
g++ -std=c++17 -Wall -Wextra -o view view.cpp && ./view
```

```text
let
```

换成 `-fsanitize=address` 再跑一遍，AddressSanitizer 才把它抓出来（输出很长，我只留下关键的三行）：

```text
==102059==ERROR: AddressSanitizer: stack-use-after-scope on address 0x7531c2700090 at pc 0x7931c4e8835f bp 0x7ffe99eb73e0 sp 0x7ffe99eb6bb0
READ of size 3 at 0x7531c2700090 thread T0
...
    #3 0x5a16aacc43c2 in main /tmp/cpp-lab-ch04/view.cpp:19
...
```

词法分析器恰好是这类 bug 的重灾区。我们想让每个 token 只是源码的一个"视图"，不复制任何字节，这正是 `std::string_view` 的用法，也正是上面这个 bug 的来源。Rust 的回答是：视图可以有，但编译器必须能证明它不会比源码活得更久。这一篇我们写 `pebble-lexer`，711 行，其中 134 行是 12 个测试，学会这套"证明"的语法：生命周期。

> [!NOTE] 本篇检查点
> 我们将写完 `pebble-lexer`：`TokenKind<'src>`、`Token<'src>`、`Lexer<'src>`、`tokenize`，以及一个在遇到坏字符后继续往下走的错误恢复机制。用到的 Rust 特性：生命周期参数与省略规则、`'static`、`Cow`、`Clone` 与 `Copy` 的区别、`f64` 为什么不能 `Eq`、`char`、match 守卫 / 范围模式 / 或模式、`while let`、`Iterator` trait 与关联类型、`by_ref`、turbofish。
> 本篇结束时 `crates/pebble-lexer/` 的两个文件与 tag `tutorial-v1` 逐字节相同。上一篇：[enum、trait 与第一份错误报告](/posts/rust-by-pebble-03-enums-traits-diagnostics/)，`pebble-diag` 已经完成，词法分析器会用它报告错误。

## 起步：第三个 crate

在工作区根目录运行（路径写法和前两篇一样，`~/pebble-tag` 是 tag 的本地克隆）：

```bash
cargo new --lib crates/pebble-lexer
```

在根 `Cargo.toml` 的 `[workspace.dependencies]` 里，`pebble-diag` 那行下面加一行：

```toml
pebble-lexer = { path = "crates/pebble-lexer", version = "0.1.0" }
```

`crates/pebble-lexer/Cargo.toml` 写成这样（和 tag 一致）。它依赖前两个 crate：

```toml
[package]
name = "pebble-lexer"
description = "A zero-copy lexer for the Pebble language."
version.workspace = true
edition.workspace = true
rust-version.workspace = true
authors.workspace = true
license.workspace = true
repository.workspace = true

[dependencies]
pebble-span.workspace = true
pebble-diag.workspace = true

[lints]
workspace = true
```

## token 应该长什么样

词法分析器把 `let total = 1 + 2;` 这样的字符数组切成 token：`let`、`total`、`=`、`1`、`+`、`2`、`;`。标识符 token 要带着名字，所以最直觉的写法是让它自己拥有一份：

```rust
enum TokenKind {
    Ident(String),
    // ...
}
```

每个标识符一次堆分配，一次拷贝，对一个只要读一遍就丢掉的 token 流来说很浪费：名字本来就躺在源码里，token 只要记住"从第几个字节到第几个字节"就够了。C++ 程序员的反应是 `std::string_view`，Rust 里对应的是 `&str`：一个指针加一个长度，不拥有任何东西。第 2 篇已经见过它在函数参数里的样子，现在我们要把它**放进结构体**。

试一下（实验文件 `src/bin/ch04_struct_lifetime.rs`，还在第 1 篇建的 `~/rust-lab` 里）：

```rust
struct Token {
    text: &str,
}

fn main() {
    let t = Token { text: "let" };
    println!("{}", t.text);
}
```

```bash
cargo build --bin ch04_struct_lifetime
```

```text
error[E0106]: missing lifetime specifier
 --> src/bin/ch04_struct_lifetime.rs:2:11
  |
2 |     text: &str,
  |           ^ expected named lifetime parameter
  |
help: consider introducing a named lifetime parameter
  |
1 ~ struct Token<'a> {
2 ~     text: &'a str,
  |

For more information about this error, try `rustc --explain E0106`.
error: could not compile `rust-lab` (bin "ch04_struct_lifetime") due to 1 previous error
```

编译器说：结构体里的引用必须有名字。这个名字叫**生命周期参数**，写成 `'a` 或者 `'src` 这样以单引号开头的标识符，和泛型参数一样写在尖括号里。编译器连修法都给了，我们按它的做：

```rust
struct Token<'src> {
    text: &'src str,
}
```

读法：`Token<'src>` 是"一个借用了某段 `'src` 内有效的文本的 token"。`'src` 不是一个具体的时间，更像一个**区域**的名字：这段文本在哪个区域里有效，这个 token 就只能活在那个区域里。名字随便起，我起 `'src` 是因为它借的就是源码。

有了名字，编译器就能做 C++ 做不到的事：检查每一处使用。实验文件 `src/bin/ch04_outlives.rs` 把前面那段 C++ 原样翻译成 Rust：

```rust
struct Token<'src> {
    text: &'src str,
}

fn first_word(src: &str) -> Token<'_> {
    Token { text: src.split(' ').next().unwrap_or("") }
}

fn main() {
    let token;
    {
        let source = String::from("let answer = 42");
        token = first_word(&source);
    }
    println!("{}", token.text);
}
```

```bash
cargo build --bin ch04_outlives
```

```text
error[E0597]: `source` does not live long enough
  --> src/bin/ch04_outlives.rs:13:28
   |
12 |         let source = String::from("let answer = 42");
   |             ------ binding `source` declared here
13 |         token = first_word(&source);
   |                            ^^^^^^^ borrowed value does not live long enough
14 |     }
   |     - `source` dropped here while still borrowed
15 |     println!("{}", token.text);
   |                    ---------- borrow later used here

For more information about this error, try `rustc --explain E0597`.
error: could not compile `rust-lab` (bin "ch04_outlives") due to 1 previous error
```

这份报告几乎就是 AddressSanitizer 那三行的编译期版本，区别是它在你按下回车之前就出现了，而且不需要任何测试恰好踩到那条路径。它的读法是一个故事：`source` 在第 12 行出生，`token` 在第 13 行借了它，`source` 在第 14 行的 `}` 处死亡，`token` 在第 15 行还被使用。借用的区域（从 13 行到 15 行）超出了被借用者的生命（到 14 行）。

`fn first_word(src: &str) -> Token<'_>` 里那个 `'_` 的意思是"这里有一个生命周期，请编译器按规则填"，规则一会儿讲。先看这个概念在词法分析器里怎么落地。

## 最小的词法分析器

我们先写一个最小版本，只认标识符、整数、`(`、`)`、`+`，让生命周期在一个小得可以一眼看完的程序里出现。把下面这些写进 `crates/pebble-lexer/src/lib.rs`（先清空）：

```rust
use pebble_diag::Diagnostic;
use pebble_span::{SourceId, Span};

#[derive(Clone, Debug, PartialEq)]
pub enum TokenKind<'src> {
    Ident(&'src str),
    Int(i64),
    LParen,
    RParen,
    Plus,
    Eof,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Token<'src> {
    pub kind: TokenKind<'src>,
    pub span: Span,
}

pub struct Lexer<'src> {
    source: SourceId,
    src: &'src str,
    pos: usize,
}

impl<'src> Lexer<'src> {
    pub const fn new(source: SourceId, src: &'src str) -> Self {
        Self { source, src, pos: 0 }
    }

    fn rest(&self) -> &'src str {
        &self.src[self.pos..]
    }

    fn peek(&self) -> Option<char> {
        self.rest().chars().next()
    }

    fn bump(&mut self) -> Option<char> {
        let ch = self.peek()?;
        self.pos += ch.len_utf8();
        Some(ch)
    }

    fn span_from(&self, start: usize) -> Span {
        Span::new(self.source, start as u32, self.pos as u32)
    }

    pub fn next_token(&mut self) -> Option<Result<Token<'src>, Diagnostic>> {
        while self.peek().is_some_and(char::is_whitespace) {
            self.bump();
        }
        let start = self.pos;
        let ch = self.bump()?;
        let kind = match ch {
            '(' => TokenKind::LParen,
            ')' => TokenKind::RParen,
            '+' => TokenKind::Plus,
            '0'..='9' => {
                while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                    self.bump();
                }
                TokenKind::Int(self.src[start..self.pos].parse().unwrap())
            }
            ch if ch == '_' || ch.is_alphabetic() => {
                while self.peek().is_some_and(|c| c == '_' || c.is_alphanumeric()) {
                    self.bump();
                }
                TokenKind::Ident(&self.src[start..self.pos])
            }
            other => {
                return Some(Err(Diagnostic::error(format!("unexpected character `{other}`"))
                    .with_span(self.span_from(start))));
            }
        };
        Some(Ok(Token { kind, span: self.span_from(start) }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_borrow_the_source() {
        let source = String::from("hello");
        let mut lexer = Lexer::new(SourceId(0), &source);
        let token = lexer.next_token().unwrap().unwrap();
        match token.kind {
            TokenKind::Ident(name) => {
                let base = source.as_ptr() as usize;
                let borrowed = name.as_ptr() as usize;
                assert!((base..base + source.len()).contains(&borrowed));
            }
            other => panic!("expected identifier, got {other:?}"),
        }
    }

    #[test]
    fn a_token_outlives_its_lexer() {
        let source = String::from("answer + 42");
        let first = {
            let mut lexer = Lexer::new(SourceId(0), &source);
            lexer.next_token().unwrap().unwrap()
        };
        assert_eq!(first.kind, TokenKind::Ident("answer"));
    }
}
```

这是脚手架，不是最终文件：最终文件我们会在后面一块一块地换掉它。先把几个新语法看清楚。

**`impl<'src> Lexer<'src>`。** 泛型参数要先声明再使用：`impl<'src>` 声明"接下来有一个生命周期参数叫 `'src`"，`Lexer<'src>` 是在使用它。和 C++ 的 `template<typename T> class Foo` 对应：`impl<'src>` 像 `template<...>`，只是生命周期参数在运行时根本不存在，编译完就擦掉了，不产生任何代码。

**`src: &'src str`。** `Lexer` 持有对源码的借用，借用区域叫 `'src`。`new` 接收的 `&'src str` 和结构体里的 `'src` 是同一个，所以"词法分析器活多久"被"源码活多久"限制住了。

**`fn rest(&self) -> &'src str`。** 这是整个文件里最值得停下来看的签名。`&self` 本身也是一个借用（借的是 `Lexer`），但返回值写的是 `'src`，不是 `&self` 的区域。意思是：返回的这段文本借自**源码**，不是借自词法分析器。这个区别马上要用到，它决定了 token 能不能比词法分析器活得久。

**`Option<Result<Token<'src>, Diagnostic>>`。** 三层含义：外层 `Option` 的 `None` 表示"没有更多 token 了"；`Some(Ok(token))` 是一个正常 token；`Some(Err(diagnostic))` 是"这个位置有个错误，但后面可能还有 token"。注意 `Diagnostic` 没有生命周期参数，它拥有自己的 `String`，所以和源码无关。

**`self.bump()?`。** 第 2 篇见过 `?` 用在 `Option` 上：`None` 就整个函数直接返回 `None`。这里 `bump` 在输入结束时返回 `None`，`next_token` 也就跟着返回 `None`。

**`'0'..='9'`。** 一个范围模式，匹配这个闭区间里的任何字符。后面细讲。

写两个测试。第一个是这篇的核心证明：标识符 token 里的 `&str` 确实指向源码内部，而不是副本。`as_ptr()` 返回指向第一个字节的裸指针，`as usize` 把它当整数比较（这是一个纯整数运算，没有任何 `unsafe`）：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_borrow_the_source() {
        let source = String::from("hello");
        let mut lexer = Lexer::new(SourceId(0), &source);
        let token = lexer.next_token().unwrap().unwrap();
        match token.kind {
            TokenKind::Ident(name) => {
                let base = source.as_ptr() as usize;
                let borrowed = name.as_ptr() as usize;
                assert!((base..base + source.len()).contains(&borrowed));
            }
            other => panic!("expected identifier, got {other:?}"),
        }
    }
}
```

`(base..base + source.len())` 是一个半开区间值（第 1 篇 `for` 里见过它），`.contains(&x)` 问 x 在不在里面。`unwrap()` 在 `None` 或 `Err` 时 panic，`.unwrap().unwrap()` 剥掉两层；在测试里这没问题，第 7 篇会专门讨论什么时候可以这么做。

第二个测试证明刚才说的那个区别：token 可以比词法分析器活得久，只要源码还在。

```rust
    #[test]
    fn a_token_outlives_its_lexer() {
        let source = String::from("answer + 42");
        let first = {
            let mut lexer = Lexer::new(SourceId(0), &source);
            lexer.next_token().unwrap().unwrap()
        };
        assert_eq!(first.kind, TokenKind::Ident("answer"));
    }
```

内层块结束时 `lexer` 被销毁，`first` 还在用，而且编译通过。因为 `first` 的类型是 `Token<'src>`，`'src` 是源码的区域，和 `lexer` 变量本身的死活无关。

```bash
cargo test -p pebble-lexer
```

```text
running 2 tests
test tests::a_token_outlives_its_lexer ... ok
test tests::identifiers_borrow_the_source ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

再让它跑起来看看。临时建一个 `crates/pebble-lexer/src/bin/stage1.rs`（跑完删掉）：

```rust
use pebble_lexer::Lexer;
use pebble_span::SourceId;

fn main() {
    let mut lexer = Lexer::new(SourceId(0), "total + (x1 + 42)");
    while let Some(item) = lexer.next_token() {
        println!("{item:?}");
    }
    let mut lexer = Lexer::new(SourceId(0), "a @ b");
    while let Some(item) = lexer.next_token() {
        match item {
            Ok(token) => println!("ok  {:?}", token.kind),
            Err(diagnostic) => println!("err {}", diagnostic.message),
        }
    }
}
```

```bash
cargo run --quiet -p pebble-lexer --bin stage1
```

```text
Ok(Token { kind: Ident("total"), span: 0..5 })
Ok(Token { kind: Plus, span: 6..7 })
Ok(Token { kind: LParen, span: 8..9 })
Ok(Token { kind: Ident("x1"), span: 9..11 })
Ok(Token { kind: Plus, span: 12..13 })
Ok(Token { kind: Int(42), span: 14..16 })
Ok(Token { kind: RParen, span: 16..17 })
ok  Ident("a")
err unexpected character `@`
ok  Ident("b")
```

输出的后三行是 `a @ b`：`@` 产出了一个错误，但 `b` 照样出来了。这就是"错误恢复"的雏形，后面的完整版本只是在它上面加细节。

## 省略规则：编译器替你写了什么

`rest(&self) -> &'src str` 里我手写了 `'src`。如果写成 `-> &str` 会怎样？第 2 篇说过，有 `&self` 的方法，返回的引用默认借自 `self`。这条规则的完整版本是 Rust 的**生命周期省略规则**，一共三条：

1. 函数参数里每个被省略的生命周期，各自变成一个独立的生命周期参数。
2. 如果输入位置**恰好有一个**生命周期（不管省不省略），它被赋给所有省略的输出生命周期。
3. 如果输入里有 `&self` 或 `&mut self`，`self` 的生命周期被赋给所有省略的输出生命周期。

三条都不适用，就必须手写，否则 E0106（我们已经见过一次）。

规则 3 看起来很方便，对我们的词法分析器却是个陷阱。实验文件 `src/bin/ch04_elision_trap.rs` 是一个玩具版：

```rust
struct Lexer<'src> {
    src: &'src str,
    pos: usize,
}

impl<'src> Lexer<'src> {
    // Elided: the returned &str is tied to the &mut self borrow, not to 'src.
    fn next_word(&mut self) -> &str {
        let rest = &self.src[self.pos..];
        let end = rest.find(' ').unwrap_or(rest.len());
        self.pos += (end + 1).min(rest.len());
        &rest[..end]
    }
}

fn main() {
    let mut lexer = Lexer { src: "let answer", pos: 0 };
    let a = lexer.next_word();
    let b = lexer.next_word();
    println!("{a} {b}");
}
```

`next_word` 的返回类型 `&str` 被省略了，按规则 3 它借自 `&mut self`，也就是**词法分析器本身**。结果：

```text
error[E0499]: cannot borrow `lexer` as mutable more than once at a time
  --> src/bin/ch04_elision_trap.rs:19:13
   |
18 |     let a = lexer.next_word();
   |             ----- first mutable borrow occurs here
19 |     let b = lexer.next_word();
   |             ^^^^^ second mutable borrow occurs here
20 |     println!("{a} {b}");
   |                - first borrow later used here

For more information about this error, try `rustc --explain E0499`.
error: could not compile `rust-lab` (bin "ch04_elision_trap") due to 1 previous error
```

第一次调用返回的 `a` 借着整个 `lexer`（而且是可变借用），`a` 还没用完，就不能再次借用 `lexer` 去取 `b`。可是 `a` 明明只是源码里的一段文本，和 `lexer` 的游标状态毫无关系。这就是我在上一节强调那个区别的原因：把返回类型写成 `&'src str`，就是告诉编译器"这个结果借自源码，不借自我"。`src/bin/ch04_elision_fixed.rs` 里只改了一处：

```rust
struct Lexer<'src> {
    src: &'src str,
    pos: usize,
}

impl<'src> Lexer<'src> {
    // Named: the result borrows the source, not the lexer.
    fn next_word(&mut self) -> &'src str {
        let rest = &self.src[self.pos..];
        let end = rest.find(' ').unwrap_or(rest.len());
        self.pos += (end + 1).min(rest.len());
        &rest[..end]
    }
}

fn main() {
    let mut lexer = Lexer { src: "let answer", pos: 0 };
    let a = lexer.next_word();
    let b = lexer.next_word();
    println!("{a} {b}");
}
```

```text
let answer
```

我不想只用玩具说话，所以在真的词法分析器上也做了同样的实验：把最终版 `next_token` 的返回类型从 `Option<Result<Token<'src>, Diagnostic>>` 改成 `Option<Result<Token<'_>, Diagnostic>>`（让规则 3 去填），编译 `pebble-lexer`：

```text
error: lifetime may not live long enough
   --> crates/pebble-lexer/src/lib.rs:504:9
    |
500 | impl<'src> Iterator for Lexer<'src> {
    |      ---- lifetime `'src` defined here
...
503 |     fn next(&mut self) -> Option<Self::Item> {
    |             - let's call the lifetime of this reference `'1`
504 |         self.next_token()
    |         ^^^^^^^^^^^^^^^^^ method was supposed to return data with lifetime `'src` but it is returning data with lifetime `'1`

error[E0499]: cannot borrow `lexer` as mutable more than once at a time
   --> crates/pebble-lexer/src/lib.rs:517:28
    |
513 | pub fn tokenize(source: SourceId, src: &str) -> (Vec<Token<'_>>, Vec<Diagnostic>) {
    |                                        - let's call the lifetime of this reference `'1`
...
517 |     while let Some(item) = lexer.next_token() {
    |                            ^^^^^ `lexer` was mutably borrowed here in the previous iteration of the loop
...
529 |     (tokens, diagnostics)
    |     --------------------- returning this value requires that `lexer` is borrowed for `'1`

For more information about this error, try `rustc --explain E0499`.
error: could not compile `pebble-lexer` (lib) due to 2 previous errors
```

两个错误，同一个病根。第一个来自 `Iterator` 的 `next`：它承诺返回 `'src` 的数据，`next_token` 却只给了 `&mut self` 的区域；第二个来自 `tokenize` 里的循环，第二圈要再次借用 `lexer`，而第一圈的 token 还借着它。把 `'_` 换回 `'src`，两个错误一起消失。

这个实验我觉得是理解生命周期标注最好的一个：标注不改变任何运行时行为，它只是让你**说清楚**一个返回值借自哪里，编译器才能放心地放行。

### `tokenize` 的签名

`tokenize` 没有 `&self`，规则 3 不适用；它只有一个输入生命周期（`src: &str`，`SourceId` 是个普通整数），所以规则 2 生效，返回类型里所有被省略的生命周期都等于它。我们写成 `Vec<Token<'_>>`。如果你偷懒写 `Vec<Token>`，工作区的 lint 会提醒你：

```text
warning: hidden lifetime parameters in types are deprecated
   --> crates/pebble-lexer/src/lib.rs:513:54
    |
513 | pub fn tokenize(source: SourceId, src: &str) -> (Vec<Token>, Vec<Diagnostic>) {
    |                                                      ^^^^^ expected lifetime parameter
    |
    = note: `-W elided-lifetimes-in-paths` implied by `-W rust-2018-idioms`
    = help: to override `-W rust-2018-idioms` add `#[allow(elided_lifetimes_in_paths)]`
help: indicate the anonymous lifetime
    |
513 | pub fn tokenize(source: SourceId, src: &str) -> (Vec<Token<'_>>, Vec<Diagnostic>) {
    |                                                           ++++

warning: hiding a lifetime that's elided elsewhere is confusing
   --> crates/pebble-lexer/src/lib.rs:513:40
    |
513 | pub fn tokenize(source: SourceId, src: &str) -> (Vec<Token>, Vec<Diagnostic>) {
    |                                        ^^^^          ^^^^^ the same lifetime is hidden here
    |                                        |
    |                                        the lifetime is elided here
    |
    = help: the same lifetime is referred to in inconsistent ways, making the signature confusing
    = note: `#[warn(mismatched_lifetime_syntaxes)]` on by default
help: use `'_` for type paths
    |
513 | pub fn tokenize(source: SourceId, src: &str) -> (Vec<Token<'_>>, Vec<Diagnostic>) {
    |                                                           ++++

warning: `pebble-lexer` (lib) generated 2 warnings (run `cargo fix --lib -p pebble-lexer` to apply 1 suggestion)
```

这条警告来自 `Cargo.toml` 里的 `rust_2018_idioms = "warn"`。它要求借用关系必须在类型里**写出来**（哪怕只写一个 `'_`），读签名的人才看得见这里藏着一个借用。你在第 1 篇的 `[workspace.lints]` 里写过这一行，它就是为这类情况准备的。

### `'static`：永远有效的那个区域

还有一个特殊的名字：`'static`，意思是"在整个程序运行期间都有效"。字符串字面量 `"let"` 的类型是 `&'static str`，因为它被编译进了可执行文件的只读数据段，永远在那里（第 2 篇的表里提过一次）。我们后面的 `TokenKind::describe` 返回 `&'static str`，每个描述都是字面量。实验文件 `src/bin/ch04_static.rs`：

```rust
fn keyword(word: &str) -> Option<&'static str> {
    match word {
        "let" => Some("Let"),
        "fn" => Some("Fn"),
        _ => None,
    }
}

fn main() {
    let result;
    {
        let owned = String::from("let");
        result = keyword(&owned);
    }
    println!("{result:?}");
}
```

```text
Some("Let")
```

`keyword` 的参数是一个会被销毁的局部 `String`，但它的返回值是 `'static`，和参数没有任何借用关系，所以 `owned` 死了之后 `result` 照样可用。这和上面的 `E0597` 形成对照：返回值借不借输入，由签名决定，不由函数体决定。

## `TokenKind`：完整的 token 词汇表

脚手架到此为止。我们现在开始写真的文件。先是文件头，前两行属性你在第 2、3 篇见过，接着是模块文档和导入：

```rust
#![cfg_attr(not(test), no_std)]
#![forbid(unsafe_code)]
//! A hand-written, zero-copy lexer for Pebble.
//!
//! Two design decisions shape this crate:
//!
//! 1. **Zero-copy.** An identifier token does not own a `String`; it borrows a
//!    slice of the original source (`&'src str`). The token stream is therefore
//!    a set of views into the input, and lexing allocates nothing except in the
//!    rare case of a string literal that contains escape sequences.
//! 2. **It keeps going.** A bad character produces a [`Diagnostic`] and the
//!    lexer resumes at the next character, so one run can report every typo in
//!    a file instead of just the first.

extern crate alloc;

use alloc::borrow::Cow;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use core::fmt;

use pebble_diag::Diagnostic;
use pebble_span::{SourceId, Span};
```

三个新东西。`use alloc::borrow::Cow` 我们马上讲。`use core::fmt;` 让下面能写 `fmt::Display`。`extern crate alloc;` 和 `alloc::` 前缀是第 2 篇说的 `no_std` 套路：这个 crate 在测试之外不链接标准库（原因第 13 篇揭晓：`pebble-nostd` 会直接复用这个词法分析器）。

接下来是 `TokenKind`，Pebble 的全部词汇。它有点长，但每个变体都是一行，没有任何新语法，你可以照着写：

```rust
/// The kind of a token, plus any payload it carries.
///
/// The `&'src str` payloads tie a token to the source string it came from: a
/// [`Token`] may outlive the [`Lexer`] but never the input, which is exactly
/// the guarantee we want. `Clone` (but not `Copy`) because [`Cow`] may own data.
#[derive(Clone, Debug, PartialEq)]
pub enum TokenKind<'src> {
    // --- literals -----------------------------------------------------------
    /// `123`
    Int(i64),
    /// `1.5`, `0.25`
    Float(f64),
    /// `"..."`, with escapes already resolved.
    Str(Cow<'src, str>),
    /// `true`
    True,
    /// `false`
    False,
    /// `nil`
    Nil,

    // --- identifiers and keywords ------------------------------------------
    /// `foo`, `_bar`
    Ident(&'src str),
    /// `let`
    Let,
    /// `fn`
    Fn,
    /// `if`
    If,
    /// `else`
    Else,
    /// `while`
    While,
    /// `for`
    For,
    /// `in`
    In,
    /// `return`
    Return,
    /// `break`
    Break,
    /// `continue`
    Continue,
    /// `and` or `&&`
    And,
    /// `or` or `||`
    Or,
    /// `not` or `!`
    Not,

    // --- punctuation --------------------------------------------------------
    /// `(`
    LParen,
    /// `)`
    RParen,
    /// `{`
    LBrace,
    /// `}`
    RBrace,
    /// `[`
    LBracket,
    /// `]`
    RBracket,
    /// `#{`, the start of a map literal
    HashBrace,
    /// `,`
    Comma,
    /// `:`
    Colon,
    /// `;`
    Semicolon,
    /// `+`
    Plus,
    /// `-`
    Minus,
    /// `*`
    Star,
    /// `/`
    Slash,
    /// `%`
    Percent,
    /// `=`
    Assign,
    /// `==`
    Eq,
    /// `!=`
    NotEq,
    /// `<`
    Lt,
    /// `<=`
    LtEq,
    /// `>`
    Gt,
    /// `>=`
    GtEq,

    /// Synthetic token emitted once at the end of input.
    Eof,
}
```

注意第一行的 `<'src>`。它让整个枚举参数化：`Ident(&'src str)` 和 `Str(Cow<'src, str>)` 这两个变体里的借用都叫 `'src`。其他变体（`Let`、`Plus` 等）根本不借用任何东西，但整个枚举仍然带着这个参数，因为类型是一个整体。你可以把 `TokenKind<'src>` 读成"一个 token 种类，如果它借用了东西，借的是 `'src`"。

### 为什么是 `Clone` 而不是 `Copy`，为什么没有 `Eq`

第 1 篇我们给 `Span` 派生了 `Copy`。这里只派生了 `Clone, Debug, PartialEq`。两个不同的原因，各自有一个实验。

先试着加上 `Copy`（`src/bin/ch04_copy_cow.rs`）：

```rust
use std::borrow::Cow;

#[derive(Clone, Copy, Debug)]
enum TokenKind<'src> {
    Ident(&'src str),
    Str(Cow<'src, str>),
}

fn main() {
    println!("{:?}", TokenKind::Ident("x"));
}
```

```text
error[E0204]: the trait `Copy` cannot be implemented for this type
 --> src/bin/ch04_copy_cow.rs:4:6
  |
3 | #[derive(Clone, Copy, Debug)]
  |                 ---- in this derive macro expansion
4 | enum TokenKind<'src> {
  |      ^^^^^^^^^
5 |     Ident(&'src str),
6 |     Str(Cow<'src, str>),
  |         -------------- this field does not implement `Copy`

For more information about this error, try `rustc --explain E0204`.
error: could not compile `rust-lab` (bin "ch04_copy_cow") due to 1 previous error
```

`Copy` 的意思是"按位复制就够了"，要求每个字段都是 `Copy`。`&str` 是（复制一个指针和长度），`Cow<'src, str>` 不是，因为它可能装着一个 `String`，复制一个 `String` 需要分配新内存。这条规则第 2 篇已经解释过：`String` 不能是 `Copy`。所以 `TokenKind` 只能 `Clone`，需要复制时显式写 `.clone()`。

`Cow` 是什么？"clone on write"，一个**要么借用、要么拥有**的枚举。实验文件 `src/bin/ch04_cow.rs`：

```rust
use std::borrow::Cow;

fn unescape_newlines(raw: &str) -> Cow<'_, str> {
    if raw.contains("\\n") {
        Cow::Owned(raw.replace("\\n", "\n"))
    } else {
        Cow::Borrowed(raw)
    }
}

fn main() {
    let plain = unescape_newlines("plain");
    let escaped = unescape_newlines("a\\nb");
    for (label, cow) in [("plain", &plain), ("escaped", &escaped)] {
        let kind = match cow {
            Cow::Borrowed(_) => "Borrowed",
            Cow::Owned(_) => "Owned",
        };
        println!("{label:8} {kind:9} {cow:?}");
    }
    println!("size_of::<&str>()       = {}", size_of::<&str>());
    println!("size_of::<String>()     = {}", size_of::<String>());
    println!("size_of::<Cow<str>>()   = {}", size_of::<Cow<'static, str>>());
}
```

```text
plain    Borrowed  "plain"
escaped  Owned     "a\nb"
size_of::<&str>()       = 16
size_of::<String>()     = 24
size_of::<Cow<str>>()   = 24
```

`unescape_newlines` 的返回类型 `Cow<'_, str>` 说：这是一段文本，可能借自输入（没有转义的时候，一个字节都不复制），也可能是新分配的 `String`（有转义，需要把 `\n` 两个字符换成一个换行符）。调用者用 `match` 区分，或者干脆当 `&str` 用（`Cow` 能自动当 `&str` 用，这背后的 deref 强制转换第 7 篇讲）。这对字符串字面量正合适：绝大多数 Pebble 字符串没有转义，借；偶尔有 `\n`，拥有。

最后一行输出里有个有意思的细节：`size_of::<Cow<str>>()` 是 24，和 `String` 一样大，比 `&str` 大 8 个字节。一个本该多出判别标签的枚举居然没有变大。我猜这是编译器利用了 `String` 内部某个不会出现的位模式来表示"借用"（Rust 里叫 niche 优化），但我没有去看布局，所以只算猜测。同样地，我们的 `TokenKind` 整体：

```text
size_of::<TokenKind>() = 24
size_of::<Token>()     = 40
```

（这是临时放在 `crates/pebble-lexer/examples/sizes.rs` 里跑的，内容就是两句 `size_of`，跑完删掉。）一个 token 40 字节：24 字节的 `TokenKind`，加上 12 字节的 `Span`（三个 `u32`），再补 4 字节对齐。

再试 `Eq`。`Float(f64)` 是 `TokenKind` 的一个变体，实验文件 `src/bin/ch04_float_eq.rs`：

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
enum TokenKind {
    Int(i64),
    Float(f64),
}

fn main() {
    println!("{:?}", TokenKind::Float(1.5));
}
```

```text
error[E0277]: the trait bound `f64: Eq` is not satisfied
 --> src/bin/ch04_float_eq.rs:4:11
  |
1 | #[derive(Clone, Debug, PartialEq, Eq)]
  |                                   -- in this derive macro expansion
...
4 |     Float(f64),
  |           ^^^ the trait `Eq` is not implemented for `f64`
  |
  = help: the following other types implement trait `Eq`:
            i128
            i16
            i32
            i64
            i8
            isize
            u128
            u16
          and 4 others
note: required by a bound in `std::cmp::AssertParamIsEq`
 --> /rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/core/src/cmp.rs:379:0

For more information about this error, try `rustc --explain E0277`.
error: could not compile `rust-lab` (bin "ch04_float_eq") due to 1 previous error
```

`Eq` 在 `PartialEq` 的基础上额外保证"自己等于自己"，而 IEEE 754 里 `NaN != NaN`，所以 `f64` 没有 `Eq`，含有 `f64` 的类型也不能有。第 5 篇的 `Expr::Float` 会再撞这一次墙。注意编译器指出的不是 `derive` 那一行，而是**字段**：`derive` 生成的代码要求每个字段都满足条件，哪个不满足就指哪个。

### `keyword` 和 `describe`

`TokenKind` 上有两个函数。`keyword` 把一个已经读出来的单词变成关键字 token，是我们要写的：

```rust
    /// Maps an identifier to its keyword token, if it is one.
    ///
    /// The classic keyword table: the lexer reads one generic `Ident` and
    /// decides afterwards whether it was really a keyword.
    #[must_use]
    pub fn keyword(word: &str) -> Option<Self> {
        Some(match word {
            "let" => TokenKind::Let,
            "fn" => TokenKind::Fn,
            "if" => TokenKind::If,
            "else" => TokenKind::Else,
            "while" => TokenKind::While,
            "for" => TokenKind::For,
            "in" => TokenKind::In,
            "return" => TokenKind::Return,
            "break" => TokenKind::Break,
            "continue" => TokenKind::Continue,
            "true" => TokenKind::True,
            "false" => TokenKind::False,
            "nil" => TokenKind::Nil,
            "and" => TokenKind::And,
            "or" => TokenKind::Or,
            "not" => TokenKind::Not,
            _ => return None,
        })
    }
```

`Option<Self>` 里的 `Self` 就是 `TokenKind<'_>`。`Some(match word { ... })` 是个小技巧：每个分支产出一个 `TokenKind`，最后一个分支 `_ => return None` 直接从函数返回，不产出值（`return` 的类型是 `!`，能放进任何类型的位置），其余分支被包进外面的 `Some`。

为什么先读一个通用的 `Ident` 再回头查表，而不是在字符层面区分关键字？因为 `iffy` 以 `if` 开头，`letter` 以 `let` 开头，在字符层面判断很容易出错。我们有个测试 `lexes_keywords_and_identifiers` 专门盯着 `iffy`。这是词法分析器的经典做法：先把整个单词读完，再整体查表。

`describe`（给每个变体一个简短描述，解析器报错时用）是几十行没有新语法的 `match`，`Display` 的实现是 11 行，它们不值得你敲，直接从 tag 里取：

```bash
git -C ~/pebble-tag show tutorial-v1:crates/pebble-lexer/src/lib.rs | sed -n 127,176p
```

这条命令输出的是 `impl TokenKind<'_> {` 开头到 `describe` 函数结束的那一段，末尾带一个空行。把它放在 `TokenKind` 枚举后面（中间空一行），接着是上面写的 `keyword`，再用一个 `}` 结束这个 `impl` 块，合起来就是 tag 文件的第 127 到 203 行。`Display` 同理：

```bash
git -C ~/pebble-tag show tutorial-v1:crates/pebble-lexer/src/lib.rs | sed -n 205,215p
```

不过 `describe` 里有两件事值得一看。`pub const fn describe(&self) -> &'static str`：`const fn` 第 1 篇讲过，返回值是 `'static`，刚刚讲过。`impl TokenKind<'_>` 里的 `'_` 是"这个 impl 对任何 `'src` 成立，我不需要用到这个名字"，比写 `impl<'src> TokenKind<'src>` 简洁。

## 游标：`Token` 与 `Lexer`

接着 `Token` 和 `Lexer` 的结构（文件第 217 到 233 行）：

```rust
/// A token: a kind plus where it came from.
#[derive(Clone, Debug, PartialEq)]
pub struct Token<'src> {
    pub kind: TokenKind<'src>,
    pub span: Span,
}

/// The zero-copy lexer.
///
/// It borrows the source for its whole lifetime, which is why the tokens it
/// produces can borrow from the same string.
pub struct Lexer<'src> {
    source: SourceId,
    src: &'src str,
    pos: usize,
    done: bool,
}
```

`Lexer` 比脚手架多了一个 `done` 字段，用于记录"已经吐出过 `Eof`"，下面解释 `Iterator` 的时候会用到。我们先写构造函数和两个查询（第 235 到 257 行）：

```rust
impl<'src> Lexer<'src> {
    /// Creates a lexer over `src`, tagging every span with `source`.
    #[must_use]
    pub const fn new(source: SourceId, src: &'src str) -> Self {
        Self {
            source,
            src,
            pos: 0,
            done: false,
        }
    }

    /// Byte offset the lexer has reached.
    #[must_use]
    pub const fn position(&self) -> usize {
        self.pos
    }

    /// Whether the underlying input has been exhausted.
    #[must_use]
    pub const fn is_at_end(&self) -> bool {
        self.pos >= self.src.len()
    }
```

`const fn new`：词法分析器可以在编译期构造，没有什么特别原因，只是能写 `const` 就写，`Span::new` 同理。两个 `#[must_use]` 防止调用者算了个值又忘了用。

然后是脚手架里那四个游标函数，加上一个 `peek_second`（偷看第二个字符），位置在文件的 259 到 281 行：

```rust
    fn rest(&self) -> &'src str {
        &self.src[self.pos..]
    }

    fn peek(&self) -> Option<char> {
        self.rest().chars().next()
    }

    fn peek_second(&self) -> Option<char> {
        let mut chars = self.rest().chars();
        chars.next();
        chars.next()
    }

    fn bump(&mut self) -> Option<char> {
        let ch = self.peek()?;
        self.pos += ch.len_utf8();
        Some(ch)
    }

    fn span_from(&self, start: usize) -> Span {
        Span::new(self.source, start as u32, self.pos as u32)
    }
```

### `char` 与 UTF-8

这里每一行都和 UTF-8 有关。`peek` 用 `chars().next()` 取第一个**字符**（`char`，一个 Unicode 标量值，4 字节）；`bump` 把 `pos` 前进 `ch.len_utf8()`，也就是这个字符编码成 UTF-8 占几个字节。实验文件 `src/bin/ch04_patterns.rs` 里我顺便打印了几个字符的长度：

```rust
fn classify(ch: char) -> &'static str {
    match ch {
        '0'..='9' => "digit",
        '_' | 'a'..='z' | 'A'..='Z' => "ident start",
        c if c.is_alphabetic() => "unicode letter (guard)",
        c if c.is_whitespace() => "space",
        _ => "other",
    }
}

fn main() {
    for ch in ['7', '_', 'x', '中', ' ', '@'] {
        println!("{ch:?} -> {}", classify(ch));
    }
    let mut stack = vec![1, 2, 3];
    while let Some(top) = stack.pop() {
        print!("{top} ");
    }
    println!();
    println!("{:?}", "123".parse::<i64>());
    println!("{:?}", "99999999999999999999".parse::<i64>());
    println!("{:?}", "99999999999999999999".parse::<f64>());
    println!("{:?}", "1.5".parse::<i64>());
    println!("'a'.len_utf8() = {}, '中'.len_utf8() = {}, '🦀'.len_utf8() = {}", 'a'.len_utf8(), '中'.len_utf8(), '🦀'.len_utf8());
}
```

```text
'7' -> digit
'_' -> ident start
'x' -> ident start
'中' -> unicode letter (guard)
' ' -> space
'@' -> other
3 2 1 
Ok(123)
Err(ParseIntError { kind: PosOverflow })
Ok(1e20)
Err(ParseIntError { kind: InvalidDigit })
'a'.len_utf8() = 1, '中'.len_utf8() = 3, '🦀'.len_utf8() = 4
```

最后一行：`'a'` 占 1 字节，`'中'` 占 3 字节，`'🦀'` 占 4 字节。如果 `bump` 总是 `+= 1`，遇到中文标识符之后 `pos` 就会落在一个字符的中间，下一次 `&self.src[self.pos..]` 切片会 panic（第 2 篇的 `ch02_utf8` 演示过）。用 `len_utf8()` 推进，`pos` 永远停在字符边界上，这就是为什么整个词法分析器里的切片都不会出事。

`span_from` 里的 `start as u32`：把 `usize` 截成 `u32`。`Span` 的字段是 `u32`（第 1 篇的选择），所以超过 4 GiB 的源文件会被截断。Pebble 的源文件不会那么大，我选择不为此加检查；如果你介意，这是一个有意义的练习。

### `skip_trivia`：嵌套注释

词法分析器要跳过空白和注释，统称 trivia。这是文件第 283 到 331 行：

```rust
    /// Skips whitespace and comments, returning at most one diagnostic.
    fn skip_trivia(&mut self) -> Option<Diagnostic> {
        loop {
            match self.peek() {
                Some(ch) if ch.is_whitespace() => {
                    self.bump();
                }
                Some('/') if self.peek_second() == Some('/') => {
                    while let Some(ch) = self.peek() {
                        if ch == '\n' {
                            break;
                        }
                        self.bump();
                    }
                }
                Some('/') if self.peek_second() == Some('*') => {
                    let start = self.pos;
                    self.bump();
                    self.bump();
                    let mut depth = 1usize;
                    while depth > 0 {
                        match self.peek() {
                            None => {
                                return Some(
                                    Diagnostic::error("unterminated block comment")
                                        .with_code("E0002")
                                        .with_span(self.span_from(start)),
                                );
                            }
                            Some('/') if self.peek_second() == Some('*') => {
                                self.bump();
                                self.bump();
                                depth += 1;
                            }
                            Some('*') if self.peek_second() == Some('/') => {
                                self.bump();
                                self.bump();
                                depth -= 1;
                            }
                            Some(_) => {
                                self.bump();
                            }
                        }
                    }
                }
                _ => return None,
            }
        }
    }
```

有三处值得看：

- `Some(ch) if ch.is_whitespace() => ...` 是**匹配守卫**：模式 `Some(ch)` 先匹配，再检查 `if` 后面的条件，不满足就尝试下一个分支。`Some('/') if self.peek_second() == Some('/')` 同理，它把"两个字符一起看"这件事写进了分支条件。
- `while let Some(ch) = self.peek() { ... }` 是"只要还能匹配就继续"：每圈重新求值右边，`Some` 就解构出 `ch` 进循环，`None` 就退出。它是 `loop { match x { Some(..) => ..., None => break } }` 的缩写。
- 嵌套块注释用一个 `depth` 计数：`/*` 加一，`*/` 减一，到 0 结束。输入结束时 `depth` 还大于 0 就返回一个"未终止的块注释"诊断，错误码是 `E0002`。

注意函数返回 `Option<Diagnostic>`，不是 `Result`：它的"成功"是什么都不返回，所以 `None` 代表一切正常。这看起来有点反直觉，我后来也没想到更好的表示。

## `next_token`：模式匹配的练习场

这是文件里最长的函数（第 333 到 420 行），也是模式匹配的各种形态一次出齐：

```rust
    /// Lexes the next token, or `None` once the stream is finished.
    ///
    /// A lexer that has already emitted [`TokenKind::Eof`] returns `None`
    /// forever after, so the [`Iterator`] impl terminates.
    pub fn next_token(&mut self) -> Option<Result<Token<'src>, Diagnostic>> {
        if self.done {
            return None;
        }
        if let Some(diagnostic) = self.skip_trivia() {
            return Some(Err(diagnostic));
        }
        if self.is_at_end() {
            self.done = true;
            return Some(Ok(Token {
                kind: TokenKind::Eof,
                span: self.span_from(self.pos),
            }));
        }

        let start = self.pos;
        let ch = self.bump()?;
        let kind = match ch {
            '(' => TokenKind::LParen,
            ')' => TokenKind::RParen,
            '{' => TokenKind::LBrace,
            '}' => TokenKind::RBrace,
            '[' => TokenKind::LBracket,
            ']' => TokenKind::RBracket,
            '#' if self.peek() == Some('{') => {
                self.bump();
                TokenKind::HashBrace
            }
            ',' => TokenKind::Comma,
            ':' => TokenKind::Colon,
            ';' => TokenKind::Semicolon,
            '+' => TokenKind::Plus,
            '-' => TokenKind::Minus,
            '*' => TokenKind::Star,
            '/' => TokenKind::Slash,
            '%' => TokenKind::Percent,
            '=' if self.peek() == Some('=') => {
                self.bump();
                TokenKind::Eq
            }
            '=' => TokenKind::Assign,
            '!' if self.peek() == Some('=') => {
                self.bump();
                TokenKind::NotEq
            }
            '!' => TokenKind::Not,
            '<' if self.peek() == Some('=') => {
                self.bump();
                TokenKind::LtEq
            }
            '<' => TokenKind::Lt,
            '>' if self.peek() == Some('=') => {
                self.bump();
                TokenKind::GtEq
            }
            '>' => TokenKind::Gt,
            '&' if self.peek() == Some('&') => {
                self.bump();
                TokenKind::And
            }
            '|' if self.peek() == Some('|') => {
                self.bump();
                TokenKind::Or
            }
            '"' => match self.lex_string(start) {
                Ok(kind) => kind,
                Err(diagnostic) => return Some(Err(diagnostic)),
            },
            '0'..='9' => self.lex_number(start),
            ch if ch == '_' || ch.is_alphabetic() => self.lex_identifier(start),
            other => {
                return Some(Err(Diagnostic::error(format!(
                    "unexpected character `{other}`"
                ))
                .with_code("E0001")
                .with_span(self.span_from(start))));
            }
        };

        Some(Ok(Token {
            kind,
            span: self.span_from(start),
        }))
    }
```

按模式的种类过一遍：

- **字面量模式**：`'(' => TokenKind::LParen`，一个字符对一个 token。
- **守卫**：`'=' if self.peek() == Some('=')` 先看下一个字符是不是 `=`，是的话再吃掉它，产出 `Eq`。顺序很重要：带守卫的 `'='` 在前，不带守卫的 `'=' => Assign` 在后，输入 `==` 时第一个先匹配。测试 `multi_char_operators_win_over_single_char` 就在盯这个顺序。
- **范围模式**：`'0'..='9' => self.lex_number(start)` 匹配这个闭区间里的任何字符。我最初写的是 `ch if ch.is_ascii_digit()`，守卫版本也对，但范围模式更短，也更直接。
- **带绑定的守卫**：`ch if ch == '_' || ch.is_alphabetic()`，把匹配到的字符起名为 `ch`，守卫里用。标识符不能用范围模式，因为 `is_alphabetic` 是 Unicode 意义上的"字母"，包括中文和希腊文。`src/bin/ch04_patterns.rs` 打印了 `'中' -> unicode letter (guard)`，也就是说 `let 变量 = 1;` 在 Pebble 里是合法的。
- **或模式** `|`：`next_token` 里没有，下一节的 `lex_number` 里有。
- **兜底**：`other => { return Some(Err(...)) }` 绑定剩下的所有字符并返回一个错误诊断，错误码 `E0001`。

`ch04_patterns` 里的 `classify` 是这些模式的一个独立小演示，上面的输出你已经看到了。

再看 `'"' => match self.lex_string(start) { Ok(kind) => kind, Err(diagnostic) => return Some(Err(diagnostic)) }`：一个 `match` 的某个分支本身是一个 `match`，错误分支用 `return` 提前退出，正常分支的值变成外层 `let kind = match ch { ... }` 的值。这个"在表达式里提前返回"的写法，第 7 篇会被 `?` 取代。这里不能用 `?`，因为 `next_token` 返回的是 `Option<Result<..>>`，而 `lex_string` 返回的 `Result` 要包进 `Some(Err(..))`，类型对不上。

## 数字、标识符、字符串

文件的下一段（第 422 到 459 行）是数字和标识符：

```rust
    fn lex_number(&mut self, start: usize) -> TokenKind<'src> {
        let mut is_float = false;
        while let Some(ch) = self.peek() {
            match ch {
                '0'..='9' | '_' => {
                    self.bump();
                }
                '.' if self.peek_second().is_some_and(|c| c.is_ascii_digit()) => {
                    is_float = true;
                    self.bump();
                }
                _ => break,
            }
        }
        let text = &self.src[start..self.pos];
        let cleaned: String = text.chars().filter(|&c| c != '_').collect();
        if is_float {
            TokenKind::Float(cleaned.parse().unwrap_or(f64::NAN))
        } else {
            match cleaned.parse::<i64>() {
                Ok(value) => TokenKind::Int(value),
                // Too big for i64: fall back to a float rather than failing.
                Err(_) => TokenKind::Float(cleaned.parse().unwrap_or(f64::NAN)),
            }
        }
    }

    fn lex_identifier(&mut self, start: usize) -> TokenKind<'src> {
        while let Some(ch) = self.peek() {
            if ch == '_' || ch.is_alphanumeric() {
                self.bump();
            } else {
                break;
            }
        }
        let word = &self.src[start..self.pos];
        TokenKind::keyword(word).unwrap_or(TokenKind::Ident(word))
    }
```

`lex_number` 是第 2 篇没教、但这里我们真的需要的东西。它的核心是 `while let` 里的一个 `match`。我最初写的是一条 `if / else if / else` 链：

```rust
if ch.is_ascii_digit() || ch == '_' {
    self.bump();
} else if ch == '.' && self.peek_second().is_some_and(|c| c.is_ascii_digit()) {
    is_float = true;
    self.bump();
} else {
    break;
}
```

后来改成上面 `match` 的形式。行为一模一样，但**或模式**（`'0'..='9' | '_'`）把"数字或下划线"写成了一个分支，`'.' if ...` 是一个守卫分支，`_ => break` 是兜底。`'.' if self.peek_second().is_some_and(...)` 的守卫要求小数点后面紧跟一个数字：`1.5` 是浮点数，`1.foo` 是整数 1 加一个点再加标识符（点在 Pebble 里什么也不是，会报 `E0001`），`1.` 也同样。

几个小语法：

- `text.chars().filter(|&c| c != '_').collect()`：`1_000` 允许下划线分隔，解析前先去掉。`|&c| ...` 是第 2 篇的"参数里的模式"：`filter` 给闭包的是 `&char`，写 `|&c|` 直接把引用拆掉。`.collect()` 的目标类型由左边的 `let cleaned: String` 决定，一串 `char` 可以收集成 `String`。
- `cleaned.parse::<i64>()`：`parse` 对任何实现了 `FromStr` 的类型都能用，要解析成哪个由类型决定。当类型没法从上下文推出来时，就用 `::<i64>` 显式指定，因为这个形状像一条鱼，所以叫 **turbofish**。`Float` 分支里的 `cleaned.parse().unwrap_or(f64::NAN)` 就没有写 turbofish：`TokenKind::Float(...)` 的参数类型是 `f64`，编译器自己推出来了。
- 太大放不进 `i64` 的整数怎么办？`ch04_patterns` 里我也试了：`"99999999999999999999".parse::<i64>()` 返回 `Err(ParseIntError { kind: PosOverflow })`，而同一个字符串 `parse::<f64>()` 返回 `Ok(1e20)`。所以我选择退化成浮点数，而不是报错。这是个设计选择，不是 Rust 的要求。`"1.5".parse::<i64>()` 是 `Err(.. InvalidDigit ..)`，所以必须先靠 `is_float` 区分。

`lex_identifier` 平淡无奇：继续吃字母数字下划线，然后 `&self.src[start..self.pos]` 取出整个单词，查关键字表，查不到就是 `Ident(word)`。重点在返回类型 `TokenKind<'src>`：切片 `&self.src[..]` 借自 `self.src`（那个 `&'src str`），不借自 `&mut self`，所以 `Ident(word)` 的区域是 `'src`。这正是前面那个实验里第二个错误想保护的东西。

### `lex_string`：`Cow` 真正派上用场

字符串字面量是这样处理的（文件第 461 到 498 行）：

```rust
    fn lex_string(&mut self, start: usize) -> Result<TokenKind<'src>, Diagnostic> {
        let body_start = self.pos;
        let mut has_escape = false;
        loop {
            match self.peek() {
                None => {
                    return Err(Diagnostic::error("unterminated string literal")
                        .with_code("E0003")
                        .with_span(self.span_from(start)));
                }
                // Recovery point: Pebble strings are single-line, so a newline
                // ends the (broken) literal without swallowing the next line.
                Some('\n') => {
                    return Err(Diagnostic::error("unterminated string literal")
                        .with_code("E0003")
                        .with_span(self.span_from(start)));
                }
                Some('"') => break,
                Some('\\') => {
                    has_escape = true;
                    self.bump();
                    self.bump();
                }
                Some(_) => {
                    self.bump();
                }
            }
        }
        let raw = &self.src[body_start..self.pos];
        self.bump(); // closing quote.

        if has_escape {
            Ok(TokenKind::Str(Cow::Owned(unescape(raw))))
        } else {
            Ok(TokenKind::Str(Cow::Borrowed(raw)))
        }
    }
}
```

两个出口返回 `Err`：输入结束，或者遇到换行。Pebble 的字符串是单行的，所以换行也算"没有闭合"。关键的是遇到换行**不吃掉它**：`Some('\n')` 分支只是 `return`，换行字符还在输入里，下一次 `next_token` 会把它当空白跳过，然后继续正常词法分析。这就是错误恢复：下面的例子会展示一整个流程。

循环里用一个 `has_escape` 记录有没有遇到反斜杠。扫描结束后用 `&self.src[body_start..self.pos]` 取出原始文本，没有转义就 `Cow::Borrowed(raw)`，**零拷贝**；有转义就 `Cow::Owned(unescape(raw))`，分配一个新 `String`。

`Cow<'src, str>` 的生命周期 `'src` 在两种情况下含义不同：`Borrowed` 时它是真正的借用；`Owned` 时没有借用，但类型一样，所以放进同一个 `TokenKind<'src>` 里互不干扰。这是"借用或拥有"类型的价值：调用者不必关心。

`unescape` 和 `read_unicode_escape` 是两个 45 行的纯字符串函数，处理 `\n`、`\t`、`\u{1F980}` 等转义，没有新概念，直接复制（文件的第 532 到 576 行）：

```bash
git -C ~/pebble-tag show tutorial-v1:crates/pebble-lexer/src/lib.rs | sed -n 532,576p
```

## `Iterator`：让词法分析器成为一个迭代器

`next_token` 已经足够用了，但我们想让 Rust 的标准工具，`for`、`collect`、`filter`，都能直接作用在词法分析器上。这需要实现 `Iterator` trait。先用一个最小的例子认识它，实验文件 `src/bin/ch04_iterator.rs`：

```rust
struct Countdown {
    n: u32,
}

impl Iterator for Countdown {
    type Item = u32;

    fn next(&mut self) -> Option<u32> {
        if self.n == 0 {
            return None;
        }
        self.n -= 1;
        Some(self.n + 1)
    }
}

fn main() {
    let mut countdown = Countdown { n: 5 };
    let first_two: Vec<u32> = countdown.by_ref().take(2).collect();
    println!("first_two = {first_two:?}");
    let rest: Vec<u32> = countdown.collect();
    println!("rest      = {rest:?}");

    let mut by_value = Countdown { n: 5 };
    let _ = (&mut by_value).take(2).count();
    println!("left over = {:?}", by_value.next());
}
```

`Iterator` 的定义里只有一个必须实现的方法：`fn next(&mut self) -> Option<Self::Item>`。`Item` 是一个**关联类型**：实现者声明"我产出什么类型"，`impl Iterator for Countdown { type Item = u32; ... }`。它和泛型参数很像，区别是一个类型只能对 `Iterator` 实现**一次**（`Countdown` 只有一个 `Item`），而泛型 trait 可以多次实现（`From<A>` 和 `From<B>` 可以同时存在）。`take`、`map`、`filter`、`collect` 这几十个方法都是 `Iterator` 的**默认方法**，`next` 一实现就免费得到。

```bash
cargo run --bin ch04_iterator
```

```text
first_two = [5, 4]
rest      = [3, 2, 1]
left over = Some(3)
```

输出最后一行的 `left over = Some(3)` 是第二段代码的结果：`(&mut by_value).take(2).count()` 吃掉两个元素，`by_value` 还剩 3。这就引出 `countdown.by_ref().take(2).collect()` 里的 `by_ref()`。`take` 会**拿走** `self`（它的签名是 `fn take(self, n: usize) -> Take<Self>`），所以直接写 `countdown.take(2)` 之后 `countdown` 就没了。实验文件 `src/bin/ch04_by_ref_moved.rs` 把这个错误做了出来：

```text
error[E0382]: use of moved value: `countdown`
  --> src/bin/ch04_by_ref_moved.rs:20:26
   |
18 |     let countdown = Countdown { n: 5 };
   |         --------- move occurs because `countdown` has type `Countdown`, which does not implement the `Copy` trait
19 |     let first_two: Vec<u32> = countdown.take(2).collect();
   |                                         ------- `countdown` moved due to this method call
20 |     let rest: Vec<u32> = countdown.collect();
   |                          ^^^^^^^^^ value used here after move
   |
note: `std::iter::Iterator::take` takes ownership of the receiver `self`, which moves `countdown`
  --> /rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/core/src/iter/traits/iterator.rs:1414:12

For more information about this error, try `rustc --explain E0382`.
error: could not compile `rust-lab` (bin "ch04_by_ref_moved") due to 1 previous error
```

`by_ref()` 返回 `&mut Self`，而 `&mut I` 对任何迭代器 `I` 自己也是迭代器，所以 `take` 拿走的只是一个临时的可变借用，原来的 `countdown` 还在，可以继续消耗剩下的元素。输出里的 `rest = [3, 2, 1]` 就是证明。我们的词法分析器测试 `iterator_terminates_after_eof` 里会用同一招。

现在为 `Lexer` 实现它（文件第 500 到 506 行）：

```rust
impl<'src> Iterator for Lexer<'src> {
    type Item = Result<Token<'src>, Diagnostic>;

    fn next(&mut self) -> Option<Self::Item> {
        self.next_token()
    }
}
```

`type Item = Result<Token<'src>, Diagnostic>`：迭代器的每一项是一个 `Result`，`next` 返回 `Option<Self::Item>`，也就是我们的 `Option<Result<..>>`，一一对应，所以 `next` 直接转发 `next_token`。`Self::Item` 是写法，等价于 `Result<Token<'src>, Diagnostic>`。

为什么还要有一个 `done` 字段？看 `next_token` 的开头：`if self.done { return None; }`，吐出 `Eof` 的同时把 `done` 设成 `true`。如果没有这个标志，`is_at_end()` 永远为真，每次调用都会产出一个新的 `Eof`，`for` 循环就永远不结束。标准库给这种"返回 `None` 之后永远返回 `None`"的迭代器起了个名字，叫 fused，`Iterator::fuse` 可以包装一个不守规矩的迭代器，我们这里是自己守规矩。

### `tokenize`

最后一个函数把一切串起来（文件第 508 到 530 行）：

```rust
/// Lexes an entire source into tokens plus diagnostics, always ending in `Eof`.
///
/// Never fails, so callers can render every diagnostic before deciding what to
/// do with the (possibly partial) token stream.
#[must_use]
pub fn tokenize(source: SourceId, src: &str) -> (Vec<Token<'_>>, Vec<Diagnostic>) {
    let mut tokens = Vec::new();
    let mut diagnostics = Vec::new();
    let mut lexer = Lexer::new(source, src);
    while let Some(item) = lexer.next_token() {
        match item {
            Ok(token) => {
                let is_eof = token.kind == TokenKind::Eof;
                tokens.push(token);
                if is_eof {
                    break;
                }
            }
            Err(diagnostic) => diagnostics.push(diagnostic),
        }
    }
    (tokens, diagnostics)
}
```

它在一个 `while let` 里反复调用 `next_token`，`Ok` 的 token 放进 `tokens`，`Err` 的诊断放进 `diagnostics`，遇到 `Eof` 就退出。**从不失败**：返回的是一个元组 `(Vec<Token>, Vec<Diagnostic>)`，调用者可以先把所有诊断打印出来再决定怎么办。`let is_eof = token.kind == TokenKind::Eof;` 用到了 `PartialEq`，这就是为什么要先算出这个布尔值：`tokens.push(token)` 会把 `token` 移走（第 2 篇），之后就不能再读它的字段了。

标准库的迭代器适配器本可以让它短很多，比如 `lexer.collect::<Result<Vec<_>, _>>()` 一行就能得到"全部成功或第一个错误"。但那样遇到第一个错误就停了，不符合"报告一切"。这是我故意不用它的原因，第 9 篇 `collect::<Result<..>>` 会出现在一个合适的位置。

## 它真的工作吗

把整个文件拼好之后（顺序见检查点），我在 `crates/pebble-lexer/examples/dump.rs` 里放了一个临时程序，用 `SourceMap` 登记一段有两处错误的源码，调用 `tokenize`，打印 token，再用第 3 篇的 `render` 打印诊断：

```rust
use pebble_lexer::tokenize;
use pebble_span::SourceMap;

fn main() {
    let mut sources = SourceMap::new();
    let text = "let total = 1_000 + 2.5;\nlet s = \"a\\n\\u{1F980}\";\nlet bad = @;\nlet t = \"oops\nprint(total);\n";
    let id = sources.add("demo.pebble", text);
    let (tokens, diagnostics) = tokenize(id, text);
    for token in &tokens {
        println!("{:>2}..{:<2} {:?}", token.span.start, token.span.end, token.kind);
    }
    for diagnostic in &diagnostics {
        print!("{}", diagnostic.render(&sources));
    }
}
```

```bash
cargo run --quiet -p pebble-lexer --example dump
```

```text
 0..3  Let
 4..9  Ident("total")
10..11 Assign
12..17 Int(1000)
18..19 Plus
20..23 Float(2.5)
23..24 Semicolon
25..28 Let
29..30 Ident("s")
31..32 Assign
33..47 Str("a\n🦀")
47..48 Semicolon
49..52 Let
53..56 Ident("bad")
57..58 Assign
60..61 Semicolon
62..65 Let
66..67 Ident("t")
68..69 Assign
76..81 Ident("print")
81..82 LParen
82..87 Ident("total")
87..88 RParen
88..89 Semicolon
90..90 Eof
error[E0001]: unexpected character `@`
 --> demo.pebble:3:11
  |
3 | let bad = @;
  |           ^
  |
error[E0003]: unterminated string literal
 --> demo.pebble:4:9
  |
4 | let t = "oops
  |         ^^^^^
  |
```

对照着读。第二行是 `let total = 1_000 + 2.5;`：`1_000` 变成 `Int(1000)`，`2.5` 变成 `Float(2.5)`，范围 `12..17` 是它在源码里的字节区间。第三行 `"a\n🦀"` 有转义，变成 `Str("a\n🦀")`，是 `Cow::Owned`。

注意第三行的 `let bad = @;`：`@` 产出一个 `E0001`，但 token 序列里 `Assign`（57..58）之后直接是 `Semicolon`（60..61），中间没有 `@` 的 token，其他 token 都在。第四行的 `"oops` 没有闭合，`E0003`，下面的 `print(total);` 完整地被词法分析了：`Ident("print")`、`LParen`、`Ident("total")`、`RParen`、`Semicolon`。一次运行，两个错误，一个也没漏掉，后面的代码一个也没丢。这是第 7 篇解析器恢复机制的基础：如果词法分析器遇到第一个错误就停下，解析器连"后面还有什么"都不知道。

（跑完把 `examples` 目录删掉，它不是 crate 的一部分。）

## 两个只用一小节讲的概念

我答应过只花一段讲这两个。

**高阶生命周期（HRTB）。** `fn(&str) -> &str` 是一个函数指针类型。它没有写任何生命周期，按省略规则 1 和 2，每个输入引用有自己的生命周期，输出借自它。但**这个生命周期是谁的？** 函数指针不绑定到某个具体的区域，而是"对任何区域都成立"，完整写法是 `for<'a> fn(&'a str) -> &'a str`，读作"对所有 `'a`"。实验文件 `src/bin/ch04_hrtb.rs`：

```rust
fn trim(s: &str) -> &str {
    s.trim()
}

fn apply(f: fn(&str) -> &str, input: &str) -> usize {
    f(input).len()
}

fn apply_explicit(f: for<'a> fn(&'a str) -> &'a str, input: &str) -> usize {
    f(input).len()
}

fn main() {
    let owned = String::from("  padded  ");
    println!("{}", apply(trim, &owned));
    println!("{}", apply_explicit(trim, "  other  "));
}
```

```text
6
5
```

两种写法等价，都能接受同一个 `trim`，并且第一次调用传的是局部 `String`，第二次传的是字面量，生命周期各不相同。你会在第 8 篇的函数指针里再见到它。

**型变。** `Token<'static>` 能不能用在要 `Token<'a>` 的地方？实验文件 `src/bin/ch04_variance.rs`：

```rust
#[derive(Debug)]
struct Tok<'src> {
    text: &'src str,
}

fn pick<'a>(a: Tok<'a>, b: Tok<'a>) -> Tok<'a> {
    if a.text.len() >= b.text.len() { a } else { b }
}

fn main() {
    let global: Tok<'static> = Tok { text: "global" };
    let local = String::from("local-and-longer");
    let borrowed = Tok { text: &local };
    println!("{:?}", pick(global, borrowed));
}
```

```text
Tok { text: "local-and-longer" }
```

`pick` 要求两个参数的生命周期**相同**，我们传了一个 `'static` 的和一个借自局部变量的，居然编译通过。原因是 `Tok<'a>` 在 `'a` 上是**协变**的：活得更久的可以当成活得更短的来用（`'static` 缩成 `'a`），就像一个人可以出现在一个比自己存在得更短的会议里。反过来就不行。可变引用 `&mut T` 在 `T` 上是不变的，这是一个更微妙的话题，Rustonomicon 有专门一章，我们这个系列不需要。

## 测试：写两个，复制其余

最后是测试。

我们已经写了第一个关键测试 `identifiers_borrow_the_source`（最终版用的是 `tokenize`，因为现在有了它）。第二个关键测试证明错误恢复：一个未闭合的字符串之后，词法分析器还能继续：

```rust
#[test]
fn reports_unterminated_string_but_keeps_going() {
    let (tokens, diagnostics) = tokenize(SourceId(0), "\"oops\n42");
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code.as_deref(), Some("E0003"));
    assert!(tokens.iter().any(|t| t.kind == TokenKind::Int(42)));
}
```

输入是 `"oops` 换行 `42`。断言三件事：恰好一个诊断；它的错误码是 `E0003`；`42` 那个 token 还在。`.code.as_deref()` 把 `Option<String>` 借成 `Option<&str>`，这样才能和 `Some("E0003")` 比较。`iter().any(|t| ...)` 是"有任何一个元素满足条件"，也是第 1 篇的闭包语法。

整个 `tests` 模块（文件第 578 到 711 行）的组装方法是：写模块头、辅助函数 `kinds` 和前两个测试；复制第 3 到 8 个测试；写 `reports_unterminated_string_but_keeps_going`；再复制最后三个。模块头、辅助函数和前两个测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(src: &str) -> Vec<TokenKind<'_>> {
        let (tokens, diagnostics) = tokenize(SourceId(0), src);
        assert!(
            diagnostics.is_empty(),
            "unexpected diagnostics: {diagnostics:?}"
        );
        tokens.into_iter().map(|token| token.kind).collect()
    }

    #[test]
    fn lexes_keywords_and_identifiers() {
        assert_eq!(
            kinds("let x = iffy;"),
            vec![
                TokenKind::Let,
                TokenKind::Ident("x"),
                TokenKind::Assign,
                TokenKind::Ident("iffy"),
                TokenKind::Semicolon,
                TokenKind::Eof,
            ]
        );
    }

    #[test]
    fn identifiers_borrow_the_source() {
        let source = String::from("hello");
        let (tokens, _) = tokenize(SourceId(0), &source);
        match &tokens[0].kind {
            TokenKind::Ident(name) => {
                let base = source.as_ptr() as usize;
                let borrowed = name.as_ptr() as usize;
                assert!((base..base + source.len()).contains(&borrowed));
            }
            other => panic!("expected identifier, got {other:?}"),
        }
    }
```

接着复制第 620 到 679 行（六个测试：没有转义的字符串是借用的、有转义的是拥有且已解码的、数字、多字符运算符优先、关键字和符号拼写一致、嵌套注释）：

```bash
git -C ~/pebble-tag show tutorial-v1:crates/pebble-lexer/src/lib.rs | sed -n 620,679p
```

然后是我们手写的那个测试（前后各空一行），最后复制第 688 到 711 行（空行、位置报告、span 覆盖字节、迭代器终止，以及模块的结束括号）：

```bash
git -C ~/pebble-tag show tutorial-v1:crates/pebble-lexer/src/lib.rs | sed -n 688,711p
```

最后一个测试 `iterator_terminates_after_eof` 就用到了 `by_ref`：

```rust
    #[test]
    fn iterator_terminates_after_eof() {
        let mut lexer = Lexer::new(SourceId(0), "1");
        let collected: Vec<_> = lexer.by_ref().collect();
        assert_eq!(collected.len(), 2); // Int(1), Eof
        assert_eq!(lexer.next(), None);
    }
```

`lexer.by_ref().collect()` 先把迭代器耗尽，`lexer` 还在，再调一次 `next()` 应该是 `None`，`assert_eq!(lexer.next(), None)` 能写，是因为 `Result<Token, Diagnostic>` 派生了 `PartialEq`，`Option` 也就有了。

## 检查点

先把 `examples` 目录（如果你还留着）删掉，然后：

```bash
cargo test --workspace
```

```text
     Running unittests src/lib.rs (target/debug/deps/pebble_diag-e12009e933f49099)
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running unittests src/lib.rs (target/debug/deps/pebble_lexer-e41783417c6bf9a0)
test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running unittests src/lib.rs (target/debug/deps/pebble_span-3b8ae416ebb198e2)
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

（过滤掉了编译提示和三个"0 passed"的 `Doc-tests` 汇总行。）`pebble-lexer` 12 个测试，`pebble-diag` 4 个，`pebble-span` 6 个。再检查和 tag 的差异：

```bash
diff ~/pebble-tag/crates/pebble-lexer/src/lib.rs crates/pebble-lexer/src/lib.rs && echo identical
diff ~/pebble-tag/crates/pebble-lexer/Cargo.toml crates/pebble-lexer/Cargo.toml && echo identical
```

```text
identical
identical
```

`lib.rs` 的组装顺序：文件头（1 到 24 行）、`TokenKind`、`impl TokenKind<'_>`（复制的 `describe` 加上写的 `keyword`）、`Display`（复制）、`Token`、`Lexer` 结构体、`impl<'src> Lexer<'src>`（`new`、`position`、`is_at_end`，游标函数，`skip_trivia`，`next_token`，`lex_number`，`lex_identifier`，`lex_string`，各方法之间空一行）、`Iterator`、`tokenize`、`unescape` 与 `read_unicode_escape`（复制）、`tests`。每一块之间空一行。

此时应当与 tag 逐字节相同的文件（已完成）：

- [`crates/pebble-lexer/Cargo.toml`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-lexer/Cargo.toml)
- [`crates/pebble-lexer/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-lexer/src/lib.rs)
- [`crates/pebble-diag/`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/crates/pebble-diag) 与 [`crates/pebble-span/`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/crates/pebble-span) 的两个文件（第 2、3 篇完成）

中间状态（现在这样就对，后面的章节会补全）：

- 根 `Cargo.toml`：`[workspace.dependencies]` 目前有 `pebble-span`、`pebble-diag`、`pebble-lexer` 三行，其余和 tag 的一样。

## 练习

**1. 支持 `0x` 十六进制字面量。** `0xff` 应该得到 `Int(255)`，`0x_1F`、`0X1_0` 同样合法，`0x` 后面什么也没有应该报错。（提示：`i64::from_str_radix`，错误码可以叫 `E0004`。）

<details>
<summary>参考答案</summary>

在 `next_token` 里，`'0'..='9'` 分支之前加一个带守卫的分支，让 `0` 后面跟着 `x` 或 `X` 时走新函数：

```rust
'0' if matches!(self.peek(), Some('x' | 'X')) => match self.lex_hex(start) {
    Ok(kind) => kind,
    Err(diagnostic) => return Some(Err(diagnostic)),
},
'0'..='9' => self.lex_number(start),
```

`matches!(expr, pattern)` 是一个小宏，求值后看是否匹配模式，返回 `bool`，这里也用上了**或模式**。`lex_hex` 放在 `lex_number` 前面：

```rust
fn lex_hex(&mut self, start: usize) -> Result<TokenKind<'src>, Diagnostic> {
    self.bump(); // the `x`
    let digits_start = self.pos;
    while let Some(ch) = self.peek() {
        if ch.is_ascii_hexdigit() || ch == '_' {
            self.bump();
        } else {
            break;
        }
    }
    let digits: String = self.src[digits_start..self.pos]
        .chars()
        .filter(|&c| c != '_')
        .collect();
    i64::from_str_radix(&digits, 16)
        .map(TokenKind::Int)
        .map_err(|error| {
            Diagnostic::error(format!("invalid hexadecimal literal: {error}"))
                .with_code("E0004")
                .with_span(self.span_from(start))
        })
}
```

`from_str_radix` 对空字符串返回 `Err`，所以 `0x;` 自动被拒绝，不用单独检查；太大放不进 `i64` 也是 `Err`。`.map(TokenKind::Int)` 把枚举变体当函数用（`Int` 是一个 `fn(i64) -> TokenKind`），`map_err` 把标准库的错误转成我们的 `Diagnostic`。

我在这个 crate 的一份临时拷贝里跑了它，加了两个测试：

```rust
#[test]
fn hex_literals() {
    assert_eq!(
        kinds("0xff 0X1_0 0"),
        vec![TokenKind::Int(255), TokenKind::Int(16), TokenKind::Int(0), TokenKind::Eof]
    );
}

#[test]
fn empty_hex_literal_is_an_error() {
    let (_, diagnostics) = tokenize(SourceId(0), "0x;");
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code.as_deref(), Some("E0004"));
}
```

结果 `14 passed`：原来的 12 个加这两个。注意 `0` 本身（后面不跟 `x`）走的还是原来的数字分支。

</details>

**2. 为什么 `fn longest(a: &str, b: &str) -> &str` 编译不过？** 说出省略规则里哪一条在这里失效，写出修法，并构造一个让修好的版本依然报错的调用。

<details>
<summary>参考答案</summary>

实验文件 `src/bin/ch04_longest.rs`：

```rust
fn longest(a: &str, b: &str) -> &str {
    if a.len() >= b.len() { a } else { b }
}

fn main() {
    println!("{}", longest("ab", "abc"));
}
```

```text
error[E0106]: missing lifetime specifier
 --> src/bin/ch04_longest.rs:1:33
  |
1 | fn longest(a: &str, b: &str) -> &str {
  |               ----     ----     ^ expected named lifetime parameter
  |
  = help: this function's return type contains a borrowed value, but the signature does not say whether it is borrowed from `a` or `b`
help: consider introducing a named lifetime parameter
  |
1 | fn longest<'a>(a: &'a str, b: &'a str) -> &'a str {
  |           ++++     ++          ++          ++

For more information about this error, try `rustc --explain E0106`.
error: could not compile `rust-lab` (bin "ch04_longest") due to 1 previous error
```

规则 1 给两个参数各一个独立的生命周期；规则 2 要求"恰好一个"输入生命周期，现在有两个，不适用；规则 3 要求有 `&self`，没有。三条都落空，所以返回值借自谁没有答案。编译器的提示一语中的："不知道是借自 `a` 还是 `b`"。

修法是显式地写：`fn longest<'a>(a: &'a str, b: &'a str) -> &'a str`，意思是"返回值借自两个参数里**较短**的那个区域"（`'a` 会被取成两者的交集）。`src/bin/ch04_longest_ok.rs` 就是修好后的版本，打印 `abc`。让它再次报错的调用是把结果用到某个参数已经死去的地方，`src/bin/ch04_longest_scope.rs`：

```text
error[E0597]: `inner` does not live long enough
  --> src/bin/ch04_longest_scope.rs:10:34
   |
 9 |         let inner = String::from("ab");
   |             ----- binding `inner` declared here
10 |         result = longest(&outer, &inner);
   |                                  ^^^^^^ borrowed value does not live long enough
11 |         println!("inside:  {result}");
12 |     }
   |     - `inner` dropped here while still borrowed
13 |     println!("outside: {result}");
   |                         ------ borrow later used here

For more information about this error, try `rustc --explain E0597`.
error: could not compile `rust-lab` (bin "ch04_longest_scope") due to 1 previous error
```

`inner` 在内层块结束时死了，而 `result` 因为 `longest` 的签名被绑定到了两个参数中较短的那个区域，在块外还被使用。这个错误很讲理：签名说"结果可能借自 `inner`"，函数体里也许根本没借，但编译器只信签名。

</details>

**3. `peek_second` 每次都要重新解码，能不能避免？** 看看 `skip_trivia` 和 `lex_number` 里的五处调用，想想它们都在比较什么。

<details>
<summary>参考答案</summary>

`peek_second` 调用 `chars()` 取两个字符，每次调用都要解码两个 UTF-8 字符。但五处调用有一个共同点：调用前，第一个字符都已经被匹配成了 ASCII（`'/'`、`'*'` 或 `'.'`），而且比较的第二个字符也都是 ASCII（`'/'`、`'*'`、数字）。ASCII 字符在 UTF-8 里恰好占一个字节，所以"第二个字符"就是原始字节的第二个字节，不需要解码：

```rust
fn peek_second_byte(&self) -> Option<u8> {
    self.rest().as_bytes().get(1).copied()
}
```

五处调用改成 `self.peek_second_byte() == Some(b'/')` 和 `self.peek_second_byte().is_some_and(|b| b.is_ascii_digit())`（`u8` 也有 `is_ascii_digit`，`b'/'` 是字节字面量）。就算第一个字符不是 ASCII，它的后续字节都 `>= 0x80`，也不可能和任何 ASCII 字节相等，所以不会误判。

我在一份临时拷贝里做了这个替换，`cargo test -p pebble-lexer` 仍然是 `12 passed`。我没有测量它快了多少：这个词法分析器的瓶颈几乎肯定不在这里，我也就没有把它放进 tag。这是个"能做，但你应该先量一量值不值得"的优化。

</details>

我们现在有了一个能把源码切成 token、在出错之后继续往下走的词法分析器，而且每个 token 都被编译器证明活得不比源码长。下一篇我们要把 token 流变成一棵树。你会看到 AST 里没有 `'src`：每个节点自己拥有 `String`，这是一个有意识的取舍，生命周期不会像传染病一样爬满整个编译器。而这一篇没有回答的问题，一个类型可以包含它自己，会让我们遇到下一堵墙：递归类型的大小。继续阅读：[递归类型、泛型与 trait：搭一棵 AST](/posts/rust-by-pebble-05-ast-generics/)。
