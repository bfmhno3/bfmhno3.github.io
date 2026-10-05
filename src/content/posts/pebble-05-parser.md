---
title: "解析器：递归下降、Pratt 与「错了也要继续」"
commentId: "post:pebble-05-parser"
published: "2026-10-05 12:00:00 +08:00"
description: "解析器是整条前端里我最怕写错的一环。Pebble 用递归下降处理语句，用 Pratt（优先级爬升）处理表达式，所有函数都返回 Result<T, Diagnostic>。更重要的是错误恢复：一个文件里写错三处，就要一次性报三处，而不是第一个就撂挑子。"
category: Note
tags:
  - Rust
  - 解析器
  - 错误恢复
  - 编译器
series: "从零写一门语言：Pebble"
seriesOrder: 5
draft: false
comment: true
slug: pebble-05-parser
---

解析器的接口很朴素：一串 token 进去，一棵 AST 出来。难的是出错的时候。

> [!TIP] 先读基础篇
> 本篇用到 `Result`/`?`、`match`、迭代器（`collect`）。这些都归在基础篇 1 和 2。

## 每个语句一个函数

递归下降读起来几乎就是语法本身。`declaration` 决定这是函数、变量还是普通语句：

```rust
fn declaration(&mut self) -> Result<Stmt, Diagnostic> {
    if self.check(&TokenKind::Fn) {
        self.fn_declaration()
    } else if self.check(&TokenKind::Let) {
        self.let_declaration()
    } else {
        self.statement()
    }
}
```

这里没有异常，没有错误码，只有 `Result`。`?` 把失败往上抛，读起来和写起来都干净：

```rust
fn let_declaration(&mut self) -> Result<Stmt, Diagnostic> {
    let start = self.advance().span; // `let`
    let name_token = self.expect(&TokenKind::Ident(""), "`let` needs a name")?;
    let name = self.ident_from(&name_token)?;
    self.expect(&TokenKind::Assign, "`let` needs an initialiser: `let x = ...;`")?;
    let value = self.expression()?;
    let end = self.expect(&TokenKind::Semicolon, "statements end with `;`")?.span;
    Ok(Stmt::Let { name, value, span: start.merge(end) })
}
```

`expect` 里带一句人话说明，它会被塞进诊断的 note 里，这就是报错时那句"`let` needs a name"的来源。

## 表达式：Pratt 优先级爬升

`1 + 2 * 3` 必须解析成 `1 + (2 * 3)`。处理优先级有两类写法：给每个运算符写一个函数（`term` 调 `factor` 调 `unary`……），或者用 Pratt / 优先级爬升。我选了后者，因为它把优先级集中在一张表里：

```rust
fn infix_op(kind: &TokenKind<'_>) -> Option<(u8, Infix)> {
    Some(match kind {
        TokenKind::Or => (1, Infix::Logic(LogicalOp::Or)),
        TokenKind::And => (2, Infix::Logic(LogicalOp::And)),
        TokenKind::Eq => (3, Infix::Arithmetic(BinaryOp::Eq)),
        TokenKind::NotEq => (3, Infix::Arithmetic(BinaryOp::NotEq)),
        TokenKind::Lt => (4, Infix::Arithmetic(BinaryOp::Lt)),
        TokenKind::Plus => (5, Infix::Arithmetic(BinaryOp::Add)),
        TokenKind::Star => (6, Infix::Arithmetic(BinaryOp::Mul)),
        // ...
        _ => return None,
    })
}
```

主循环只有十几行，`min_prec` 表示"我允许吃掉的最高优先级"：

```rust
fn binary(&mut self, min_prec: u8) -> Result<Expr, Diagnostic> {
    let mut left = self.unary()?;
    while let Some((prec, infix)) = infix_op(&self.peek().kind) {
        if prec < min_prec {
            break;
        }
        self.advance();
        // 左结合：递归时要求更高一级优先级。
        let right = self.binary(prec + 1)?;
        let span = left.span().merge(right.span());
        left = match infix {
            Infix::Arithmetic(op) => Expr::Binary { op, lhs: Box::new(left), rhs: Box::new(right), span },
            Infix::Logic(op) => Expr::Logical { op, lhs: Box::new(left), rhs: Box::new(right), span },
        };
    }
    Ok(left)
}
```

`prec + 1` 就是"左结合"的全部秘密：递归时只允许吃比当前优先级**更高**的运算符，于是 `1 - 2 - 3` 变成 `(1 - 2) - 3`。我把这个性质写成了测试：

```rust
#[test]
fn subtraction_is_left_associative() {
    let rendered = pretty(&parse_ok("1 - 2 - 3;").program);
    assert_eq!(rendered, "expr\n  binary -\n    binary -\n      int 1\n      int 2\n    int 3\n");
}
```

赋值是右结合的，而且只允许"可赋值的"目标（变量或下标）。`assignment` 先解析左边，看到 `=` 再检查左边能不能被赋值：

```rust
fn assignment(&mut self) -> Result<Expr, Diagnostic> {
    let expr = self.binary(0)?;
    if self.matches(&TokenKind::Assign) {
        let value = self.assignment()?; // 右结合
        if !is_assignable(&expr) {
            return self.error(expr.span(), "invalid assignment target");
        }
        // ...
    }
    Ok(expr)
}
```

所以 `1 = 2;` 会报 "invalid assignment target"，而不是悄悄接受。

## 错误恢复才是重点

一个称职的解析器不能"见错就停"。Pebble 的做法是：出错时记一条诊断，然后**跳到下一个像语句开头的地方**再继续。

```rust
fn synchronize(&mut self) {
    while !self.is_at_end() {
        if self.previous().kind == TokenKind::Semicolon {
            return;
        }
        match self.peek().kind {
            TokenKind::Fn | TokenKind::Let | TokenKind::If | TokenKind::While
            | TokenKind::For | TokenKind::Return | TokenKind::Break
            | TokenKind::Continue | TokenKind::RBrace => return,
            _ => { self.advance(); }
        }
    }
}
```

语句列表和代码块都用同一套"边解析边恢复"的循环：

```rust
while !self.is_at_end() {
    match self.declaration() {
        Ok(stmt) => stmts.push(stmt),
        Err(diagnostic) => {
            self.errors.push(diagnostic);
            self.synchronize();
        }
    }
}
```

## 它真的报出了多个错

拿一个三行都写坏的文件试：

```pebble
let = ;
let y = 2
let z = 3;
```

`pebble check` 的输出是两条诊断，而不是第一条就崩：

```text
error[E1001]: expected identifier, found `=`
 --> /tmp/pebble_multi.pebble:1:5
  |
1 | let = ;
  |     ^
  |
  = note: `let` needs a name
error[E1001]: expected `;`, found `let`
 --> /tmp/pebble_multi.pebble:3:1
  |
3 | let z = 3;
  | ^^^
  |
  = note: statements end with `;`
```

第一条说第一行 `let` 后面没跟名字；第二条说 `let y = 2` 少了分号（错误落在第三行那个 `let` 上，因为解析器是在那里期待分号时扑空的）。

更有意思的是，**恢复之后 AST 里还留着合法的部分**。`pebble parse` 除了诊断，还打印出了 `let z`：

```text
$ pebble parse /tmp/pebble_multi.pebble
（同上两条诊断）
let z
  int 3
```

这一点对 IDE 场景很重要：报错的同时还能给出后续代码的语法树，补全和跳转才不至于整段失效。

## REPL 也要用它

REPL 的一个表达式输入不需要完整程序。所以我额外暴露了一个入口：

```rust
pub fn parse_expression(source: SourceId, src: &str) -> (Option<Expr>, Vec<Diagnostic>)
```

REPL 先试着当表达式解析，成功就直接求值打印（比如输入 `1 + 2` 得到 `3`）；失败再当完整程序解析。这让 REPL 既能算表达式，也能写 `let x = 10;` 这样的语句。

## 下一篇

到这里前端就齐了：源码变成了一棵带位置的 AST。接下来是后端之一，树遍历解释器。那一篇会讲 `Rc<RefCell<..>>` 怎么组成作用域链、闭包怎么捕获环境、把控制流当成数据是什么感觉，以及我亲手制造的一个**引用计数循环泄漏**。
