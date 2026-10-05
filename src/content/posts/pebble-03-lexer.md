---
title: "零拷贝词法器：让 token 借用源码"
commentId: "post:pebble-03-lexer"
published: "2026-10-05 10:00:00 +08:00"
description: "词法器是我第一个真正跟借用检查器较劲的地方。token 里的标识符直接借用 &str，字符串用 Cow 只在需要处理转义时才分配，扫到未知字符就记一条诊断然后继续。这一篇讲零拷贝怎么做到、关键字表怎么查、以及为什么未闭合的字符串应该在换行处停手。"
category: Note
tags:
  - Rust
  - 词法分析
  - 生命周期
  - 借用检查器
series: "从零写一门语言：Pebble"
seriesOrder: 3
draft: false
comment: true
slug: pebble-03-lexer
---

词法器要做的事听起来很土：把一坨字符切成一个个 token。但正是这里，我第一次被 Rust 逼着认真想"数据到底存在哪里"。

> [!TIP] 先读基础篇
> 本篇的核心是生命周期 `'src`、`&str` 与 `Cow`。如果还不清楚借用和生命周期为什么存在，先看基础篇 3（所有权）。

## 零拷贝：token 只是源码的视图

大多数语言实现的 token 长这样：一个枚举，标识符和字符串是 `String`。我没那么写。Pebble 的 token 直接**借用**源文本：

```rust
#[derive(Clone, Debug, PartialEq)]
pub enum TokenKind<'src> {
    Int(i64),
    Float(f64),
    Str(Cow<'src, str>),
    Ident(&'src str),
    // ...关键字与标点
}
```

`Ident(&'src str)` 意味着"这个词就是源码里的一段切片"。整个 token 流不复制一个字节的源码。

这不是纸上谈兵，我用一个测试把它钉死：拿标识符的指针，检查它确实落在原始字符串的内存范围里。

```rust
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

一旦你这么设计，`Lexer` 就必须一直持有 `&'src str`，而它产出的 token 也只能活到 `'src` 结束。类型系统帮你把"先释放源码再读 token"这种错误在编译期挡掉了。爽。

## 字符串：Cow 的正确用法

标识符借用没问题，字符串字面量就有个麻烦：`"a\nb"` 需要把 `\n` 变成一个真正的换行符，而 `"plain"` 不需要任何处理。

朴素做法是永远分配一个 `String`，但那样 `"plain"` 也白付一次分配。这里的标准答案是 `Cow<'src, str>`：

```rust
let raw = &self.src[body_start..self.pos];
self.bump(); // 收尾的双引号。

if has_escape {
    Ok(TokenKind::Str(Cow::Owned(unescape(raw))))
} else {
    Ok(TokenKind::Str(Cow::Borrowed(raw)))
}
```

`Cow` 是 "clone on write"：能借用就借用，非改不可才复制。扫一遍就知道有没有反斜杠，所以没有转义的字符串一个字都不多分配。这也顺带解释了为什么 `TokenKind` 是 `Clone` 而不是 `Copy`：`Cow` 可能拥有堆数据。

## 关键字只是查表

词法器不特殊处理关键字。它先按标识符规则读一整段 `[A-Za-z_][A-Za-z0-9_]*`，再去表里查是不是关键字：

```rust
pub fn keyword(word: &str) -> Option<Self> {
    Some(match word {
        "let" => TokenKind::Let,
        "fn" => TokenKind::Fn,
        "if" => TokenKind::If,
        "while" => TokenKind::While,
        "for" => TokenKind::For,
        "and" => TokenKind::And,
        "or" => TokenKind::Or,
        "not" => TokenKind::Not,
        "nil" => TokenKind::Nil,
        // ...
        _ => return None,
    })
}
```

聪明的读者会注意到一件小事：`and` 和 `&&` 都映射到 `TokenKind::And`，`not` 和 `!` 都映射到 `TokenKind::Not`。两种写法，一个 token，解析器完全不用关心用户写的是哪一种。我拿一个测试把这两种拼写绑在一起：

```rust
#[test]
fn keyword_and_symbol_spellings_agree() {
    assert_eq!(kinds("a and b or c not d"), kinds("a && b || c ! d"));
}
```

## 多字符运算符：多看一眼

`=` 和 `==`、`<` 和 `<=` 需要往前看一个字符。我给 lexer 配了一个 `peek_second`：

```rust
fn peek_second(&self) -> Option<char> {
    let mut chars = self.rest().chars();
    chars.next();
    chars.next()
}
```

于是最长匹配就是一层 `if`：

```rust
'=' if self.peek() == Some('=') => { self.bump(); TokenKind::Eq }
'=' => TokenKind::Assign,
'<' if self.peek() == Some('=') => { self.bump(); TokenKind::LtEq }
'<' => TokenKind::Lt,
```

注意 `bump` 按 `char::len_utf8()` 前进，所以遇到多字节字符不会切在半个汉字中间。

## 错误恢复：扫坏了也要往下走

词法器最重要的工程决定是**不因为一个错误就放弃**。扫到不认识的字符，记一条诊断，跳过它，继续扫：

```rust
other => {
    return Some(Err(Diagnostic::error(format!("unexpected character `{other}`"))
        .with_code("E0001")
        .with_span(self.span_from(start))));
}
```

调用方 `tokenize` 把 `Err` 收进诊断列表，把 `Ok` 收进 token 列表，两者都能拿到：

```rust
pub fn tokenize(source: SourceId, src: &str) -> (Vec<Token<'_>>, Vec<Diagnostic>) {
    // ...循环 next_token()，Ok 进 tokens，Err 进 diagnostics
}
```

未闭合的字符串是个更有意思的案例。如果它一路吃到文件末尾，后面的代码就全丢了。所以我让它在**换行处**停手：

```rust
Some('\n') => {
    return Err(Diagnostic::error("unterminated string literal")
        .with_code("E0003")
        .with_span(self.span_from(start)));
}
```

这样 `"oops\n42` 会报一个未闭合字符串，然后**下一行的 `42` 依然被正常扫出来**。测试专门盯这个行为：

```rust
#[test]
fn reports_unterminated_string_but_keeps_going() {
    let (tokens, diagnostics) = tokenize(SourceId(0), "\"oops\n42");
    assert_eq!(diagnostics.len(), 1);
    assert!(tokens.iter().any(|t| t.kind == TokenKind::Int(42)));
}
```

## 让 Iterator 真能结束

`Lexer` 实现了 `Iterator<Item = Result<Token, Diagnostic>>`，用起来很顺。但有个坑：文件末尾要恰好发一次 `Eof`，之后再 `next()` 必须返回 `None`，否则 `for` 循环永不结束。我加了一个 `done` 标志：

```rust
pub fn next_token(&mut self) -> Option<Result<Token<'src>, Diagnostic>> {
    if self.done {
        return None;
    }
    // ...
    if self.is_at_end() {
        self.done = true;
        return Some(Ok(Token { kind: TokenKind::Eof, span: self.span_from(self.pos) }));
    }
    // ...
}
```

对应的测试直接验证"拿完所有 token 之后 `next()` 是 `None`"。

## 看看它真的吐出了什么

`pebble tokens` 把 token 流打印出来，位置是 `行:列`：

```text
$ pebble tokens examples/hello.pebble
2:1 print
2:6 `(`
2:7 "hello, pebble!"
2:23 `)`
2:24 `;`
3:1 end of file
```

注意字符串 token 打印出来带引号（`Display` 对字符串用了 `{:?}`），标识符则原样输出。这个命令在调试解析器时救过我很多次。

## 下一篇

token 有了，接下来要给它一个"形状"。下一篇是 AST 和过程宏：用递归枚举表达语法树，用 `#[derive(Spanned)]` 自动实现"每个节点都知道自己的位置"，再用一个函数式宏把字节码指令表的样板代码干掉。
