---
title: "树遍历解释器：闭包、控制流与一个内存泄漏"
commentId: "post:rust-by-pebble-09-interpreter-closures"
published: "2026-10-13 16:00:00 +08:00"
description: "让 AST 真正跑起来：用 Flow 枚举把 return、break、continue 变成返回值，用 Rc<RefCell<Env>> 实现闭包，用 FnOnce 守住递归深度，再写两个测试证明 fn fact 会让全局环境永远不被释放，并看清 Weak 为什么救不了它。"
category: Note
tags:
  - Rust
  - Pebble
  - 闭包
  - 解释器
  - 内存泄漏
series: "用 Pebble 从零学 Rust"
seriesOrder: 9
draft: false
comment: true
slug: rust-by-pebble-09-interpreter-closures
---

这一篇里有两个测试，断言的是相反的事。一个说：跑完 `let x = 1 + 2;` 之后，解释器的全局环境被释放了。另一个说：跑完 `fn fact(n) { ... } fact(5);` 之后，全局环境**没有**被释放，而且这是我们故意写下来的预期。第二个测试的名字叫 `top_level_functions_keep_globals_alive`，它是我给 `Rc` 写过的最不光彩的测试：我花了两篇的时间让所有权系统保证内存安全，然后用它证明我的解释器会泄漏。

在那之前我们得先让 Pebble 跑起来。第 7 篇我们把源码变成了 AST，第 8 篇把运行时的值、环境和内建函数备好了。这一篇把它们接在一起：一个几百行的树遍历解释器，加上命令行里的 `run` 和 `repl`。

> [!NOTE] 本篇检查点
> 这一篇我们写出 `pebble-interp`（Pebble 的第一个执行后端），并把命令行升级到第二版：新增 `pebble run` 和 `pebble repl`。用到的 Rust 特性：用枚举把控制流当数据返回、闭包的三种捕获方式和 `Fn`/`FnMut`/`FnOnce`、`move`、`Weak`、`std::thread::Builder`、`collect::<Result<Vec<_>, _>>()`、泛型辅助函数，以及为自己的类型实现标准库的 `FromStr`。结束时 `cargo test -p pebble-interp` 是 16 个测试全部通过（包括两个 `Weak` 泄漏测试），命令行是 3 个单元测试加 7 个集成测试，`crates/pebble-interp/` 下的两个文件与 tag 逐字节相同。上一篇是 [共享与可变：Rc、RefCell 和运行时的值](/posts/rust-by-pebble-08-rc-refcell-values/)，`Value`、`Env`、`Function`、`RuntimeError` 都是在那里写的。

## 要执行的东西和它的形状

先说清楚解释器要干什么。输入是一个 `Program`，也就是 `Vec<Stmt>`；输出是一个 `Value`，或者一个 `RuntimeError`。两种东西要处理：

- **表达式**（`Expr`）：求值，得到一个 `Value`。`1 + 2` 得到 `Int(3)`。
- **语句**（`Stmt`）：执行。`let` 往环境里加一个名字，`if` 选一个分支，`while` 反复执行一个块。语句本身不产生值（`Expr` 语句除外），但它们有"怎么结束的"这件事。

"怎么结束的"是整个解释器最有意思的地方。看这个 Pebble 程序，真实运行一遍：

```pebble
fn find_first_even(xs) {
    for x in xs {
        if x % 2 == 0 {
            return x;
        }
    }
    return nil;
}
print(find_first_even([1, 3, 6, 8]));
print(find_first_even([1, 3]));
```

```text
$ pebble run flow.pebble
6
nil
```

`return x;` 写在 `if` 里面，`if` 在 `for` 里面，`for` 在函数体里面。执行到 `return` 的那一刻，要一口气跳出三层。C 程序员遇到这种事有三个选择：`goto`、`longjmp`，或者在每一层都检查一个"是否该退出"的标志。C++ 程序员可能想到异常，但用异常实现 `return` 是个臭名昭著的坏主意：慢，而且让读代码的人以为程序出错了。

Rust 的答案是第四个：**把"怎么结束的"做成返回值**。

## Flow：控制流是数据

`execute_stmt` 执行一条语句，返回 `Result<Flow, RuntimeError>`。外层 `Result` 是第 7 篇学的那一层：`Err` 表示运行时出错了，用 `?` 一路往上传。内层 `Flow` 是新东西，描述语句正常执行时是**怎么结束的**：

```rust
/// How a statement finished.
///
/// Most statements produce a value and fall through (`Value`); the other three
/// variants unwind the walker.
#[derive(Debug)]
pub enum Flow {
    /// Completed normally, producing this value.
    Value(Value),
    /// A `return` escaped.
    Return(Value),
    /// A `break` escaped.
    Break,
    /// A `continue` escaped.
    Continue,
}

impl Flow {
    fn is_normal(&self) -> bool {
        matches!(self, Flow::Value(_))
    }
}
```

四种结束方式：

- `Value(v)`：顺顺当当执行完，产生值 `v`（绝大多数语句产生 `nil`，`Expr` 语句产生表达式的值）。
- `Return(v)`：撞上了 `return v;`。
- `Break` 和 `Continue`：撞上了同名语句。

每个会包含其它语句的节点（块、`if`、`while`、`for`、函数体）在执行完子语句后只做一件事：看 `Flow` 是不是 `Value`。是，继续往下；不是，原样往上递，直到有人认领。`while` 认领 `Break` 和 `Continue`，函数调用认领 `Return`，其余全部放行。

`is_normal` 里的 `matches!` 是第 7 篇见过的宏：`matches!(self, Flow::Value(_))` 展开成一个返回 `bool` 的 `match`。注意 `Flow` 的 `Value` 变体和 `pebble_value::Value` 类型同名，这在 Rust 里没问题：变体总是通过 `Flow::Value` 这样带前缀的路径访问。

这和 C++ 里 `std::variant<Value, Return, Break, Continue>` 的做法很像，区别是 Rust 的枚举是语言的一部分，`match` 会检查你有没有处理所有情况。第 3 篇我们看过漏掉一个分支时的 E0004，这一篇里它每天都会救我一次。

## 新建 pebble-interp

```bash
cargo new --lib crates/pebble-interp
```

先在根 `Cargo.toml` 的 `[workspace.dependencies]` 里，`pebble-value` 那一行后面加上它自己：

```toml
pebble-interp = { path = "crates/pebble-interp", version = "0.1.0" }
```

`crates/pebble-interp/Cargo.toml` 的完整内容如下，和 [tag 里的文件](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-interp/Cargo.toml) 一致：

```toml
[package]
name = "pebble-interp"
description = "A tree-walking interpreter for Pebble."
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
pebble-value.workspace = true

[dev-dependencies]
pebble-parser.workspace = true

[lints]
workspace = true
```

`pebble-parser` 只放在 `[dev-dependencies]`：解释器本身不需要解析器，只有测试要把字符串变成 AST。`cargo` 会把 dev 依赖只用在 `cargo test` 里，不会泄漏到使用 `pebble-interp` 的其他 crate。

## 第一版：表达式、变量和块

接下来我们分四步写 `crates/pebble-interp/src/lib.rs`。每一步结束都有一个可以跑的检查，不会让你写几百行才知道对不对。

第一步只做算术、变量、赋值和语句序列。把文件写成下面这样，我分几块给出，按顺序拼起来就是一个文件。先是文件头：

```rust
#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::rc::Rc;

use pebble_ast::{BinaryOp, Expr, LogicalOp, Program, Spanned, Stmt, UnaryOp};
use pebble_span::Span;
use pebble_value::{Env, RuntimeError, Value, compare, div, mul, negate, rem, sub};
```

`#![forbid(unsafe_code)]` 是第 2 篇写过的 crate 属性：这整个 crate 里一行 `unsafe` 都不允许。`use` 列表里的东西我们一路走一路用上；现在列出来的都是第一步用得到的。

然后是上一节的 `Flow`，原样写进去（包括 `is_normal`）：

```rust
/// How a statement finished.
///
/// Most statements produce a value and fall through (`Value`); the other three
/// variants unwind the walker.
#[derive(Debug)]
pub enum Flow {
    /// Completed normally, producing this value.
    Value(Value),
    /// A `return` escaped.
    Return(Value),
    /// A `break` escaped.
    Break,
    /// A `continue` escaped.
    Continue,
}

impl Flow {
    fn is_normal(&self) -> bool {
        matches!(self, Flow::Value(_))
    }
}
```

接着是解释器本身。第一版只有一个字段，全局环境：

```rust
/// The tree-walking interpreter.
pub struct Interpreter {
    globals: Rc<RefCell<Env>>,
}

impl Default for Interpreter {
    fn default() -> Self {
        Self::new()
    }
}

impl Interpreter {
    /// Creates an interpreter whose global scope holds the builtins.
    #[must_use]
    pub fn new() -> Self {
        let globals = Rc::new(RefCell::new(Env::new()));
        {
            let mut scope = globals.borrow_mut();
            for function in pebble_value::BUILTINS {
                scope.define(function.name, Value::Native(function));
            }
        }
        Self { globals }
    }

    /// The global scope.
    #[must_use]
    pub fn globals(&self) -> Rc<RefCell<Env>> {
        Rc::clone(&self.globals)
    }
```

`Rc<RefCell<Env>>` 是第 8 篇的主角：`Rc` 让多个所有者共享，`RefCell` 让共享的东西还能改。`new` 里先建一个空的 `Env`，然后把 `BUILTINS` 表里的 11 个内建函数全部 `define` 进去。`for function in pebble_value::BUILTINS` 里的 `function` 是 `&'static NativeFunction`，直接放进 `Value::Native` 就行（第 8 篇的 `static` 表）。

`globals()` 返回 `Rc::clone(&self.globals)`：克隆的是指针，引用计数加一，不是整个环境。这个方法在后面的泄漏测试里会发挥主要作用。

`interpret` 是入口（从这里起，缩进四格的代码都写在同一个 `impl Interpreter` 块里，直到我说它结束）。程序本身就是一个顶层块：

```rust
    /// Evaluates a whole program, returning the value of the last statement.
    pub fn interpret(&mut self, program: &Program) -> Result<Value, RuntimeError> {
        let globals = Rc::clone(&self.globals);
        match self.execute_block(&program.stmts, globals)? {
            Flow::Value(value) | Flow::Return(value) => Ok(value),
            Flow::Break | Flow::Continue => Err(RuntimeError::new(
                Span::DUMMY,
                "`break` or `continue` used outside a loop",
            )),
        }
    }
```

顶层的 `Break` 或 `Continue` 没有任何循环可以认领，这是用户的程序错误，所以变成一个 `RuntimeError`（`Span::DUMMY` 是第 1 篇的占位 span）。`Flow::Value(value) | Flow::Return(value)` 是一个或模式：顶层的 `return` 也当成程序的结果。

`execute_block` 就是上面说的"检查 `Flow`"：

```rust
    // --- statements -------------------------------------------------------

    fn execute_block(
        &mut self,
        stmts: &[Stmt],
        env: Rc<RefCell<Env>>,
    ) -> Result<Flow, RuntimeError> {
        let mut last = Flow::Value(Value::Nil);
        for stmt in stmts {
            last = self.execute_stmt(stmt, &env)?;
            if !last.is_normal() {
                return Ok(last);
            }
        }
        Ok(last)
    }
```

每条语句执行完，如果不是正常结束就立刻返回，整个块的值是最后一条语句的值。`self.execute_stmt(stmt, &env)?` 这个 `?` 处理的是 `Err` 那一层。

然后是 `execute_stmt`。第一步只有 `let` 和表达式语句，其余分支先用 `todo!()`：

```rust
    fn execute_stmt(&mut self, stmt: &Stmt, env: &Rc<RefCell<Env>>) -> Result<Flow, RuntimeError> {
        match stmt {
            Stmt::Let { name, value, .. } => {
                let value = self.eval(value, env)?;
                env.borrow_mut().define(name.name.clone(), value);
                Ok(Flow::Value(Value::Nil))
            }
            Stmt::Expr { expr, .. } => Ok(Flow::Value(self.eval(expr, env)?)),
            _ => todo!("the other statements come in the next sections"),
        }
    }
```

`Stmt::Let { name, value, .. }` 里的 `..` 表示"其他字段我不关心"。`match stmt` 的 `stmt` 是 `&Stmt`，所以模式里绑定出来的 `name`、`value` 都是引用；这就是 Rust 的"默认绑定模式"，你不用写 `ref`。`env.borrow_mut().define(...)` 是 `RefCell` 的运行时借用：临时拿一个可变引用，用完（这一行结束）就还。

求值是 `eval`，它是整个文件里最长的函数，但每个分支都很短。先是字面量和变量：

```rust
    // --- expressions ------------------------------------------------------

    fn eval(&mut self, expr: &Expr, env: &Rc<RefCell<Env>>) -> Result<Value, RuntimeError> {
        match expr {
            Expr::Nil { .. } => Ok(Value::Nil),
            Expr::Bool { value, .. } => Ok(Value::Bool(*value)),
            Expr::Int { value, .. } => Ok(Value::Int(*value)),
            Expr::Float { value, .. } => Ok(Value::Float(*value)),
            Expr::Str { value, .. } => Ok(Value::string(value.clone())),
            Expr::Var { name, span } => env.borrow().get(&name.name).ok_or_else(|| {
                RuntimeError::new(*span, format!("undefined variable `{}`", name.name))
                    .with_note("declare it first with `let`")
            }),
```

`Expr::Var` 分支值得看一眼：`env.borrow().get(&name.name)` 返回 `Option<Value>`，`ok_or_else` 把 `None` 变成 `Err(RuntimeError)`。用 `ok_or_else` 而不是 `ok_or` 是因为错误信息要 `format!`，不到出错那一刻不应该白白分配一个 `String`；闭包只在 `None` 时才会执行。`.with_note(...)` 是第 8 篇的构建器写法，给错误挂一条提示。

接着是一元、二元和逻辑运算：

```rust
            Expr::Unary { op, operand, span } => {
                let value = self.eval(operand, env)?;
                match op {
                    UnaryOp::Neg => negate(&value, *span),
                    UnaryOp::Not => Ok(Value::Bool(!value.is_truthy())),
                }
            }
            Expr::Binary { op, lhs, rhs, span } => {
                let lhs = self.eval(lhs, env)?;
                let rhs = self.eval(rhs, env)?;
                eval_binary(*op, &lhs, &rhs, *span)
            }
            Expr::Logical { op, lhs, rhs, .. } => {
                let lhs = self.eval(lhs, env)?;
                match op {
                    LogicalOp::And => {
                        if lhs.is_truthy() {
                            self.eval(rhs, env)
                        } else {
                            Ok(lhs)
                        }
                    }
                    LogicalOp::Or => {
                        if lhs.is_truthy() {
                            Ok(lhs)
                        } else {
                            self.eval(rhs, env)
                        }
                    }
                }
            }
```

`Unary` 里 `negate(&value, *span)`：`negate` 是第 8 篇写的函数，要 `&Value` 和一个 `Span`，出错时用这个 span 报错位置。`Binary` 先求左再求右，然后交给 `eval_binary`（下面）。`Logical` 不能这么做：`and`/`or` 要**短路**，右边只有在需要时才求值，所以它是自己的分支。注意它返回的是**操作数本身**（`Ok(lhs)` 或 `self.eval(rhs, env)`），而不是 `bool`。`nil or 3` 是 `3`，这和 Python、JavaScript 一样。

最后是赋值，还有一个 `_ => todo!()` 暂时兜住后面要写的所有分支：

```rust
            Expr::Assign { target, value, .. } => {
                let new_value = self.eval(value, env)?;
                match target.as_ref() {
                    Expr::Var { name, span } => {
                        if env.borrow_mut().assign(&name.name, new_value.clone()) {
                            Ok(new_value)
                        } else {
                            Err(RuntimeError::new(
                                *span,
                                format!("cannot assign to undefined variable `{}`", name.name),
                            ))
                        }
                    }
                    other => Err(RuntimeError::new(other.span(), "invalid assignment target")),
                }
            }
            _ => todo!("calls, closures and collections come later"),
        }
    }
```

赋值分支先求右边，再看左边是什么。第一步只支持变量；列表下标的赋值留到第四步，现在碰到它会落进 `other` 分支，报一个"invalid assignment target"。`env.borrow_mut().assign(...)` 返回 `bool`：找得到名字就是 `true`。

`impl Interpreter { ... }` 到这里结束，所以紧接着在文件里写一个 `}` 收尾，然后写 `eval_binary`。它是个独立函数，不需要 `self`：

```rust
fn eval_binary(op: BinaryOp, lhs: &Value, rhs: &Value, span: Span) -> Result<Value, RuntimeError> {
    use std::cmp::Ordering;
    Ok(match op {
        BinaryOp::Add => pebble_value::add(lhs, rhs, span)?,
        BinaryOp::Sub => sub(lhs, rhs, span)?,
        BinaryOp::Mul => mul(lhs, rhs, span)?,
        BinaryOp::Div => div(lhs, rhs, span)?,
        BinaryOp::Rem => rem(lhs, rhs, span)?,
        BinaryOp::Eq => Value::Bool(lhs.equals(rhs)),
        BinaryOp::NotEq => Value::Bool(!lhs.equals(rhs)),
        BinaryOp::Lt => Value::Bool(compare(lhs, rhs, span)? == Ordering::Less),
        BinaryOp::LtEq => Value::Bool(compare(lhs, rhs, span)? != Ordering::Greater),
        BinaryOp::Gt => Value::Bool(compare(lhs, rhs, span)? == Ordering::Greater),
        BinaryOp::GtEq => Value::Bool(compare(lhs, rhs, span)? != Ordering::Less),
    })
}
```

`Ok(match op { ... })` 是个小技巧：每个分支都产生一个 `Value`，其中一些带 `?`，最后统一包进 `Ok`，比每个分支各写一个 `Ok(...)` 干净。`use std::cmp::Ordering;` 写在函数内部：这个名字只有这里用，不污染文件顶部。比较用的是第 8 篇的 `compare`（它返回 `Ordering`，而不是实现 `PartialOrd`）。

最后给这一步写一个小测试模块，放在文件末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use pebble_parser::parse;
    use pebble_span::SourceId;

    fn run(src: &str) -> Result<Value, RuntimeError> {
        let mut interpreter = Interpreter::new();
        let result = parse(SourceId(0), src);
        assert!(result.is_ok(), "parse errors: {:?}", result.diagnostics);
        interpreter.interpret(&result.program)
    }

    #[test]
    fn evaluates_arithmetic_with_precedence() {
        assert_eq!(run("1 + 2 * 3;").unwrap(), Value::Int(7));
        assert_eq!(run("(1 + 2) * 3;").unwrap(), Value::Int(9));
        assert_eq!(run("7 % 3;").unwrap(), Value::Int(1));
    }

    #[test]
    fn variables_and_assignment() {
        assert_eq!(run("let x = 1; x = x + 41; x;").unwrap(), Value::Int(42));
    }
}
```

`use super::*;` 把父模块的东西都带进来（第 1 篇）。`run` 辅助函数做三件事：把字符串解析成 AST、断言没有解析错误、交给解释器。注意 `pebble_parser` 是 dev 依赖，只有测试里才能用。

```bash
cargo test -p pebble-interp
```

```text
running 2 tests
test tests::variables_and_assignment ... ok
test tests::evaluates_arithmetic_with_precedence ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

两个测试通过。这时候 `1 + 2 * 3;` 已经能得到 `7` 了：优先级是第 7 篇的解析器管的，解释器只是走树。

## 第二步：块、`if`、`while`、`for`

现在给 `execute_stmt` 加上控制流。先写一个辅助函数 `run_scoped_block`，放在 `execute_block` 后面：

```rust
    /// Runs a nested block in a fresh child scope, normalising its value to
    /// `nil`.
    ///
    /// Only expression statements carry a value; a control-flow statement such
    /// as `if` produces `nil`. The bytecode compiler makes the same choice, so
    /// the two backends agree on what a program evaluates to.
    fn run_scoped_block(
        &mut self,
        stmts: &[Stmt],
        env: &Rc<RefCell<Env>>,
    ) -> Result<Flow, RuntimeError> {
        let scope = Env::child(Rc::clone(env));
        match self.execute_block(stmts, scope)? {
            Flow::Value(_) => Ok(Flow::Value(Value::Nil)),
            other => Ok(other),
        }
    }
```

它做两件事。第一，**开一个子作用域**：`Env::child(Rc::clone(env))` 创建一个新的 `Env`，它的父指针指向当前环境，所以块里 `let` 的名字在块外不可见，但块里能读到外面的名字。第二，**把值归一成 `nil`**：`if` 这样的控制流语句不产生值，只有表达式语句有值，所以一个块里的最后一条语句哪怕是 `x;`，整个 `if` 也要得到 `nil`。后面字节码编译器做同样的选择，这样两个后端对"程序的值是什么"的回答一致。

这个子作用域有一个后果，我现在先说明，[第 12 篇](/posts/rust-by-pebble-12-vm-backends/)才会回头：

```pebble
let x = 1;
if true {
    let x = 2;
}
print(x);
```

```text
$ pebble run blk.pebble
1
```

树遍历解释器给每个块一个子 `Env`，里面的 `let x = 2;` 只改了子作用域里的 `x`，外面的还是 `1`。第 12 篇的 VM 每次函数调用只有一个环境，同一个程序会打印 `2`。**两个后端并不处处一致**，我们会在那里把这个差异摆出来。

现在补齐 `execute_stmt` 里的控制流分支。下面四段都加在 `Stmt::Expr` 分支之后、兜底的 `_ => todo!(...)` 之前（`Fn` 分支要到第三步才写，所以兜底先留着）。`if`：

```rust
            Stmt::If {
                cond,
                then_branch,
                else_branch,
                ..
            } => {
                if self.eval(cond, env)?.is_truthy() {
                    self.run_scoped_block(then_branch, env)
                } else if else_branch.is_empty() {
                    Ok(Flow::Value(Value::Nil))
                } else {
                    self.run_scoped_block(else_branch, env)
                }
            }
```

`while`：

```rust
            Stmt::While { cond, body, .. } => {
                while self.eval(cond, env)?.is_truthy() {
                    let scope = Env::child(Rc::clone(env));
                    match self.execute_block(body, scope)? {
                        Flow::Return(value) => return Ok(Flow::Return(value)),
                        Flow::Break => break,
                        Flow::Value(_) | Flow::Continue => {}
                    }
                }
                Ok(Flow::Value(Value::Nil))
            }
```

每次循环迭代都开一个新的子作用域。`match self.execute_block(body, scope)?` 对 `Flow` 做分类：`Return` 原样往上传，`Break` 退出这个 `while` 然后正常结束，其余两种（`Value` 和 `Continue`）什么也不做，进入下一次迭代。`Flow::Value(_) | Flow::Continue => {}` 里的 `{}` 是空块，也就是"什么都不做"。

`for`：

```rust
            Stmt::For {
                var, iter, body, ..
            } => {
                let iterable = self.eval(iter, env)?;
                let Value::List(items) = &iterable else {
                    return Err(RuntimeError::new(
                        iterable_span(iter),
                        format!("`for` needs a list, got {}", iterable.type_name()),
                    ));
                };
                let snapshot = items.borrow().clone();
                for item in snapshot {
                    let scope = Env::child(Rc::clone(env));
                    scope.borrow_mut().define(var.name.clone(), item);
                    match self.execute_block(body, scope)? {
                        Flow::Return(value) => return Ok(Flow::Return(value)),
                        Flow::Break => break,
                        Flow::Value(_) | Flow::Continue => {}
                    }
                }
                Ok(Flow::Value(Value::Nil))
            }
```

这里有三件事要说。第一，`let Value::List(items) = &iterable else { ... };` 是第 3 篇的 `let ... else`：只要不是列表就走 `else` 里的 `return Err(...)`。第二，`iterable_span(iter)` 是个只有一行的辅助函数，写在文件后面：

```rust
fn iterable_span(expr: &Expr) -> Span {
    expr.span()
}
```

它的作用就是让错误位置指向 `for` 后面那个表达式。`span()` 方法来自 `pebble_ast::Spanned`，这个 trait 是第 6 篇用 derive 宏生成的。第三，也是最重要的：`let snapshot = items.borrow().clone();`。这一行为什么要先复制一份，我们到第四步再看，到时候有真实的 panic 可看。

最后是 `return`、`break`、`continue`：

```rust
            Stmt::Return { value, .. } => {
                let value = match value {
                    Some(expr) => self.eval(expr, env)?,
                    None => Value::Nil,
                };
                Ok(Flow::Return(value))
            }
            Stmt::Break { .. } => Ok(Flow::Break),
            Stmt::Continue { .. } => Ok(Flow::Continue),
```

它们都很短：`return` 求值（没有表达式就是 `nil`），然后包进 `Flow::Return`。`break` 和 `continue` 不携带数据。

此时 `execute_stmt` 里只剩 `Stmt::Fn` 还没有分支。兜底的消息可以顺手改成 "functions come in the next section"，这只是给自己看的提示。

加一个测试，放在 `tests` 模块里 `variables_and_assignment` 后面。它用的是 `while`，不需要函数调用：

```rust
    #[test]
    fn while_loop_accumulates() {
        let src = "let i = 0; let s = 0; while i < 5 { s = s + i; i = i + 1; } s;";
        assert_eq!(run(src).unwrap(), Value::Int(10));
    }
```

```text
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

还没有函数的时候，我们得到了循环、条件和块。三个测试通过。

## 第三步：函数和闭包

解释器里最难的一个词其实是"闭包"，但我想先绕开它，先看 Rust 自己的闭包是怎么回事，因为我们马上要写一个会接收闭包的函数。

### Rust 的闭包

C++ 程序员已经认识了 lambda：`[=]`、`[&]`、`[x = std::move(x)]`，以及 `std::function` 这个类型擦除的容器。Rust 的闭包是同一个东西的另一种设计：

- **捕获方式不是你写的，是编译器从函数体里读出来的。** 闭包里只读一个变量，就按共享引用 `&T` 捕获；修改它，就按可变引用 `&mut T` 捕获；把它移走（比如返回它），就按值捕获，也就是移动。
- 每个闭包有自己**独一无二的匿名类型**，所以闭包通常通过泛型传递（`impl Fn(..)`），编译时单态化，没有 `std::function` 的虚调用开销。
- 闭包按它**怎么使用捕获的东西**实现三个 trait 之一或几个：`Fn`（只读，可以调用任意多次）、`FnMut`（会修改，需要 `&mut` 才能调用，可以调用多次）、`FnOnce`（会消耗捕获物，最多调用一次）。它们是包含关系：每个 `Fn` 都是 `FnMut`，每个 `FnMut` 都是 `FnOnce`。所以如果你的函数只调用传入的闭包**一次**，参数就该声明为 `FnOnce`，这是对调用者要求最少的一个。

在实验室里把四种情况都跑一遍。文件是 `~/rust-lab/src/bin/ch09_closures.rs`：

```rust
// ~/rust-lab/src/bin/ch09_closures.rs
fn make_counter() -> impl FnMut() -> i32 {
    let mut n = 0;
    move || {
        n += 1;
        n
    }
}

fn main() {
    // 1. A closure that only reads what it captured: Fn.
    let greeting = String::from("hello");
    let shout = || greeting.to_uppercase();
    println!("{} {}", shout(), shout());
    println!("greeting is still ours: {greeting}");

    // 2. A closure that mutates what it captured: FnMut.
    let mut count = 0;
    let mut bump = || {
        count += 1;
        count
    };
    bump();
    bump();
    println!("count after two bumps: {count}");

    // 3. `move` copies the captured value into the closure.
    let mut n = 10;
    let mut owned = move || {
        n += 1;
        n
    };
    let first = owned();
    let second = owned();
    println!("owned() = {first}, then {second}");
    println!("the outer n is untouched: {n}");

    // 4. A function can hand out a closure if the closure owns its state.
    let mut counter = make_counter();
    println!("counter: {} {} {}", counter(), counter(), counter());
}
```

```bash
cargo run --quiet --bin ch09_closures
```

```text
HELLO HELLO
greeting is still ours: hello
count after two bumps: 2
owned() = 11, then 12
the outer n is untouched: 10
counter: 1 2 3
```

第一种是 `Fn`：闭包只读 `greeting`，调用两次都没问题，调用完 `greeting` 还是我们的。第二种是 `FnMut`：闭包里 `count += 1`，所以 `bump` 必须声明成 `let mut`，调用完外面的 `count` 变成 2，因为闭包拿的是 `&mut count`。第三种是 `move`：`move ||` 强迫闭包拿走（对 `i32` 来说是复制）所有它用到的变量，所以闭包里加了两次，外面的 `n` 还是 10。第四种是返回闭包：`make_counter` 里的 `n` 是局部变量，函数一返回就没了，所以闭包必须 `move` 把它带走。

不 `move` 会怎样？去掉 `move`（文件 `~/rust-lab/src/bin/ch09_closure_escape.rs`）：

```rust
// ~/rust-lab/src/bin/ch09_closure_escape.rs
fn make_counter() -> impl FnMut() -> i32 {
    let mut n = 0;
    || {
        n += 1;
        n
    }
}

fn main() {
    let mut counter = make_counter();
    println!("{} {}", counter(), counter());
}
```

```text
$ cargo build --bin ch09_closure_escape
   Compiling rust-lab v0.1.0 (/tmp/rust-lab)
error[E0373]: closure may outlive the current function, but it borrows `n`, which is owned by the current function
 --> src/bin/ch09_closure_escape.rs:4:5
  |
4 |     || {
  |     ^^ may outlive borrowed value `n`
5 |         n += 1;
  |         - `n` is borrowed here
  |
note: closure is returned here
 --> src/bin/ch09_closure_escape.rs:4:5
  |
4 | /     || {
5 | |         n += 1;
6 | |         n
7 | |     }
  | |_____^
help: to force the closure to take ownership of `n` (and any other referenced variables), use the `move` keyword
  |
4 |     move || {
  |     ++++

For more information about this error, try `rustc --explain E0373`.
error: could not compile `rust-lab` (bin "ch09_closure_escape") due to 1 previous error
```

编译器连修法都给了。这就是 C++ 里 `[&]` 捕获了局部变量然后把 lambda 返回出去的情形：在 C++ 里是悬垂引用，运行时才爆炸（或者悄悄给你错误的数）；在 Rust 里是编译错误。

`FnOnce` 的"最多一次"是编译器强制的。`~/rust-lab/src/bin/ch09_fnonce_twice.rs`：

```rust
// ~/rust-lab/src/bin/ch09_fnonce_twice.rs
fn main() {
    let name = String::from("pebble");
    let consume = move || name; // returns the captured String: it can only run once
    let first = consume();
    let second = consume();
    println!("{first} {second}");
}
```

```text
$ cargo build --bin ch09_fnonce_twice
   Compiling rust-lab v0.1.0 (/tmp/rust-lab)
error[E0382]: use of moved value: `consume`
 --> src/bin/ch09_fnonce_twice.rs:6:18
  |
5 |     let first = consume();
  |                 --------- `consume` moved due to this call
6 |     let second = consume();
  |                  ^^^^^^^ value used here after move
  |
note: closure cannot be invoked more than once because it moves the variable `name` out of its environment
 --> src/bin/ch09_fnonce_twice.rs:4:27
  |
4 |     let consume = move || name; // returns the captured String: it can only run once
  |                           ^^^^
note: this value implements `FnOnce`, which causes it to be moved when called
 --> src/bin/ch09_fnonce_twice.rs:5:17
  |
5 |     let first = consume();
  |                 ^^^^^^^

For more information about this error, try `rustc --explain E0382`.
error: could not compile `rust-lab` (bin "ch09_fnonce_twice") due to 1 previous error
```

`consume` 把捕获的 `name` 当作返回值移出去了，所以它只能是 `FnOnce`；调用它会**消耗这个闭包本身**。这和 C++ 里"moved-from 的东西能不能再用，要靠你自己记住"完全不同。

### Pebble 的闭包

现在说 Pebble 自己的闭包。Pebble 的函数值在第 8 篇已经定义好了：

```rust
pub struct Function {
    pub name: Option<String>,
    pub params: Vec<String>,
    pub body: Vec<Stmt>,
    pub env: Rc<RefCell<Env>>,
}
```

这就是一个**手工做出来的闭包对象**：参数名、函数体（代码），加上一个 `env`（捕获物）。编译器为 Rust 闭包生成的结构体本质上也是这个形状，不同之处在于捕获的方式。Rust 闭包按变量一个个捕获，`move` 之后每个闭包有自己的一份拷贝；Pebble 闭包捕获的是**整条环境链的一个共享指针**。所以 Pebble 的 `make_counter` 里 `count = count + 1` 修改的是所有闭包共享的同一个 `Env`，外面能看到，这和 Rust lab 里第三种情况（外面的 `n` 纹丝不动）正好相反。

### 写出来

先把解释器的结构改成最终形态。`Interpreter` 需要三个新字段：输出槽 `out`（`print` 往哪写，第 8 篇的 `dyn Output`）、当前调用深度 `depth`、最大深度 `max_depth`。把 `use` 块更新为：

```rust
#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::rc::Rc;

use pebble_ast::{BinaryOp, Expr, LogicalOp, Program, Spanned, Stmt, UnaryOp};
use pebble_span::Span;
use pebble_value::{
    Env, Function, Output, RuntimeError, Stdout, Value, call_native, compare, div, mul, negate,
    rem, sub,
};
```

结构体和构造函数换成下面这样（`new` 变成一行，真正的工作移到 `with_output`；这个拆分是为了测试能注入一个 `Buffer` 来捕获输出）：

```rust
/// The tree-walking interpreter.
pub struct Interpreter {
    globals: Rc<RefCell<Env>>,
    out: Box<dyn Output>,
    depth: usize,
    max_depth: usize,
}

impl Default for Interpreter {
    fn default() -> Self {
        Self::new()
    }
}

impl Interpreter {
    /// Creates an interpreter that prints to standard output.
    #[must_use]
    pub fn new() -> Self {
        Self::with_output(Box::new(Stdout))
    }

    /// Creates an interpreter with a custom output sink.
    #[must_use]
    pub fn with_output(out: Box<dyn Output>) -> Self {
        let globals = Rc::new(RefCell::new(Env::new()));
        {
            let mut scope = globals.borrow_mut();
            for function in pebble_value::BUILTINS {
                scope.define(function.name, Value::Native(function));
            }
        }
        Self {
            globals,
            out,
            depth: 0,
            // Kept well below what the host stack can take, so a runaway
            // recursion produces a clean Pebble error instead of a SIGSEGV.
            // Bump it with `set_max_depth` if you need deeper recursion.
            max_depth: 128,
        }
    }
```

`max_depth: 128` 的来历在后面"递归深度"一节有一个实验。接下来是 getter 和一个让 Rust 代码往全局环境里塞值的 `define_global`（这一块包含第一步已经写过的 `globals()`，整块替换就行）：

```rust
    /// The global scope.
    #[must_use]
    pub fn globals(&self) -> Rc<RefCell<Env>> {
        Rc::clone(&self.globals)
    }

    /// The current recursion limit.
    #[must_use]
    pub fn max_depth(&self) -> usize {
        self.max_depth
    }

    /// Sets the recursion limit.
    pub fn set_max_depth(&mut self, depth: usize) {
        self.max_depth = depth;
    }

    /// Defines a value in the global scope from Rust.
    pub fn define_global(&mut self, name: impl Into<String>, value: Value) {
        self.globals.borrow_mut().define(name, value);
    }
```

`define_global(&mut self, name: impl Into<String>, value: Value)` 用的是第 2 篇的 `impl Into<String>`：调用者传 `&str` 或 `String` 都行。

`interpret` 多一行 `self.depth = 0;`（每次从头开始），后面再写一个对外暴露的 `call`，让 Rust 调用者能调用 Pebble 函数：

```rust
    /// Evaluates a whole program, returning the value of the last statement.
    pub fn interpret(&mut self, program: &Program) -> Result<Value, RuntimeError> {
        self.depth = 0;
        let globals = Rc::clone(&self.globals);
        match self.execute_block(&program.stmts, globals)? {
            Flow::Value(value) | Flow::Return(value) => Ok(value),
            Flow::Break | Flow::Continue => Err(RuntimeError::new(
                Span::DUMMY,
                "`break` or `continue` used outside a loop",
            )),
        }
    }

    /// Calls a function value with the given arguments.
    pub fn call(
        &mut self,
        callee: Value,
        args: Vec<Value>,
        span: Span,
    ) -> Result<Value, RuntimeError> {
        self.call_value(callee, args, span)
    }
```

**函数声明**是 `execute_stmt` 里的新分支。现在所有语句都有分支了，把兜底的 `_ => todo!(...)` 删掉，把它放在 `Stmt::Let` 和 `Stmt::Expr` 之间（顺序和 tag 一致）：

```rust
            Stmt::Fn {
                name, params, body, ..
            } => {
                let function = Function::new(
                    Some(name.name.clone()),
                    params.iter().map(|p| p.name.clone()).collect(),
                    body.clone(),
                    Rc::clone(env),
                );
                env.borrow_mut()
                    .define(name.name.clone(), Value::Function(Rc::new(function)));
                Ok(Flow::Value(Value::Nil))
            }
```

这里有两个值得讲的细节。第一，`Function::new(...)` 的第四个参数是 `Rc::clone(env)`：**函数在声明的那一刻把当时的环境指针记下来**，这就是闭包的"闭"。第二，`body.clone()` 是整个函数体的深拷贝（`Vec<Stmt>`）：每次执行到一个 `fn` 语句，都会复制一遍它的 AST。我没有改这件事，因为它不影响正确性，只影响性能；要是想改，把 `body` 换成 `Rc<[Stmt]>` 是最自然的做法，这留给你。

匿名函数 `fn(x) { ... }` 是表达式，没有名字，其余完全一样。下面这个分支和后面的 `Call` 分支都加在 `eval` 里 `Assign` 之后、`_ => todo!(...)` 之前，`Call` 在前，`Fn` 在后：

```rust
            Expr::Fn { params, body, .. } => {
                let function = Function::new(
                    None,
                    params.iter().map(|p| p.name.clone()).collect(),
                    body.clone(),
                    Rc::clone(env),
                );
                Ok(Value::Function(Rc::new(function)))
            }
```

**调用**：

```rust
            Expr::Call { callee, args, span } => {
                let callee = self.eval(callee, env)?;
                let args = args
                    .iter()
                    .map(|arg| self.eval(arg, env))
                    .collect::<Result<Vec<_>, _>>()?;
                self.call_value(callee, args, *span)
            }
```

`args.iter().map(|arg| self.eval(arg, env)).collect::<Result<Vec<_>, _>>()?` 是这个文件里最值得停下来看的一行 Rust。`map` 对每个实参调用 `eval`，得到的是一串 `Result<Value, RuntimeError>`；`collect` 要把它们收成一个 `Vec`。标准库为 `Result` 实现了"收集"：如果每个元素都是 `Ok`，就得到 `Ok(Vec<Value>)`；只要有一个是 `Err`，收集在遇到它的那一刻停下来，整个结果是那个 `Err`。turbofish `::<Result<Vec<_>, _>>` 告诉 `collect` 目标类型，`_` 让编译器自己推出元素类型。结尾的 `?` 把 `Err` 往上传。用 C++ 写，你会写一个循环，每次 `if (!r) return r.error()`。

我们还要写三个方法：`call_value` 处理调用，`run_function` 执行函数体，`with_call_depth` 守住递归深度。它们放在 `eval` 之后，用一行 `// --- calls ---` 注释隔开，仍然在同一个 `impl` 块里（`with_call_depth` 之后才是收尾的 `}`）。调用：

```rust
    // --- calls ------------------------------------------------------------

    fn call_value(
        &mut self,
        callee: Value,
        args: Vec<Value>,
        span: Span,
    ) -> Result<Value, RuntimeError> {
        match callee {
            Value::Native(function) => {
                let out = &mut *self.out;
                call_native(function, out, span, &args)
            }
            Value::Function(function) => {
                if args.len() != function.params.len() {
                    return Err(RuntimeError::new(
                        span,
                        format!(
                            "{} expects {} argument(s), got {}",
                            function.display_name(),
                            function.params.len(),
                            args.len()
                        ),
                    ));
                }
                let result = self.with_call_depth(span, |this| this.run_function(&function, args));
                result.map_err(|error| error.with_frame(function.display_name(), span))
            }
            other => Err(RuntimeError::new(
                span,
                format!("{} is not callable", other.type_name()),
            )),
        }
    }
```

`match callee` 直接按值匹配，`callee` 在这里被消耗。两条主要路径：

- `Value::Native(function)`：内建函数。`&mut *self.out` 先解引用 `Box<dyn Output>` 得到 `dyn Output`，再取可变借用，变成 `&mut dyn Output`，交给 `call_native`（第 8 篇）。
- `Value::Function(function)`：用户函数。先检查参数个数（报错信息里 `display_name()` 对匿名函数给 `<anonymous>`），然后把真正的调用交给 `with_call_depth`，出错时用 `map_err` 追加一层调用栈（`with_frame`），所以报错信息能列出整条 `in outer ... in inner ...`。

最后一个分支 `other => Err(...)` 处理"调用一个不是函数的东西"，比如 `let x = 1; x();`。

函数体由 `run_function` 执行：

```rust
    fn run_function(
        &mut self,
        function: &Rc<Function>,
        args: Vec<Value>,
    ) -> Result<Value, RuntimeError> {
        let env = Env::child(Rc::clone(&function.env));
        {
            let mut scope = env.borrow_mut();
            for (param, arg) in function.params.iter().zip(args) {
                scope.define(param.clone(), arg);
            }
        }
        match self.execute_block(&function.body, env)? {
            Flow::Return(value) | Flow::Value(value) => Ok(value),
            Flow::Break | Flow::Continue => Err(RuntimeError::new(
                function.body.first().map_or(Span::DUMMY, Spanned::span),
                "`break` or `continue` escaped a function body",
            )),
        }
    }
```

三步。**第一，建一个新环境，它的父是函数捕获的环境**（`function.env`，不是调用者的环境，这是词法作用域和动态作用域的区别）。**第二，把形参和实参配对定义进去。** `function.params.iter().zip(args)` 把两个迭代器拉成一串二元组；`args` 是 `Vec<Value>`，所以 `zip(args)` 消耗它，每个 `arg` 是 `Value`（不是引用）。**第三，执行函数体**，`Flow::Return(value) | Flow::Value(value)` 把两种正常结束都当作返回值，`Break` 或 `Continue` 溢出到函数边界是用户程序的错误。`function.body.first().map_or(Span::DUMMY, Spanned::span)` 里 `Spanned::span` 是把一个 trait 方法当作普通函数值传给 `map_or`：空函数体没有第一条语句，就用占位 span。

### with_call_depth：为什么是 FnOnce

现在是 `with_call_depth`，最后一块：

```rust
    /// Runs `body` one call level deeper, failing first if that would exceed the limit.
    fn with_call_depth<T>(
        &mut self,
        span: Span,
        body: impl FnOnce(&mut Self) -> Result<T, RuntimeError>,
    ) -> Result<T, RuntimeError> {
        if self.depth >= self.max_depth {
            return Err(RuntimeError::new(
                span,
                format!("call stack overflow (recursion limit {})", self.max_depth),
            ));
        }
        self.depth += 1;
        let result = body(self);
        self.depth -= 1;
        result
    }
```

它做的事是一个"括号"：先检查深度，加一，运行 `body`，减一。这种"前置、中间、后置"在 C++ 里通常用 RAII 守卫对象，一个构造时加一、析构时减一的小类。这里我选了闭包：调用者传一段代码，它在加一减一之间运行。好处是**不可能忘了减一**，也不可能在中间插入一个 `?` 提前返回而漏掉后置。

参数写的是 `impl FnOnce(&mut Self) -> Result<T, RuntimeError>`。为什么是 `FnOnce`？回头看调用点：`|this| this.run_function(&function, args)`。闭包体里 `args` 被**移动**进了 `run_function`，所以这个闭包只能被调用一次，它实现的是 `FnOnce`，不是 `Fn`，也不是 `FnMut`。如果我把参数的 trait 写成 `Fn`，编译器就会反对（这是真实输出，来自我们当前这个文件）：

```text
error[E0507]: cannot move out of `args`, a captured variable in an `Fn` closure
   --> crates/pebble-interp/src/lib.rs:343:93
    |
323 |         args: Vec<Value>,
    |         ----  ---------- move occurs because `args` has type `Vec<Value>`, which does not implement the `Copy` trait
    |         |
    |         captured outer variable
...
343 |                 let result = self.with_call_depth(span, |this| this.run_function(&function, args));
    |                                                         ------                              ^^^^ `args` is moved here
    |                                                         |
    |                                                         captured by this `Fn` closure
    |
help: `Fn` and `FnMut` closures require captured values to be able to be consumed multiple times, but `FnOnce` closures may consume them only once
   --> crates/pebble-interp/src/lib.rs:378:20
    |
378 |         body: impl Fn(&mut Self) -> Result<T, RuntimeError>,
    |                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
help: consider cloning the value if the performance cost is acceptable
    |
343 |                 let result = self.with_call_depth(span, |this| this.run_function(&function, args.clone()));
    |                                                                                                 ++++++++

For more information about this error, try `rustc --explain E0507`.
error: could not compile `pebble-interp` (lib) due to 1 previous error
```

（行号是我当前这个文件里的，你的可能不同。）

编译器连"该用 `FnOnce`"都告诉了你。

另一个问题：闭包为什么要接收 `this: &mut Self`，而不是直接用外面的 `self`？试试把 `|this| this.run_function(...)` 改成 `|_this| self.run_function(...)`：

```text
error[E0501]: cannot borrow `*self` as mutable because previous closure requires unique access
   --> crates/pebble-interp/src/lib.rs:343:30
    |
343 |                 let result = self.with_call_depth(span, |_this| self.run_function(&function, args));
    |                              ^^^^^---------------^^^^^^^-------^----^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |                              |    |                     |       |
    |                              |    |                     |       first borrow occurs due to use of `*self` in closure
    |                              |    |                     closure construction occurs here
    |                              |    first borrow later used by call
    |                              second borrow occurs here

error[E0500]: closure requires unique access to `*self` but it is already borrowed
   --> crates/pebble-interp/src/lib.rs:343:57
    |
343 |                 let result = self.with_call_depth(span, |_this| self.run_function(&function, args));
    |                              ---- ---------------       ^^^^^^^ ---- second borrow occurs due to use of `*self` in closure
    |                              |    |                     |
    |                              |    |                     closure construction occurs here
    |                              |    first borrow later used by call
    |                              borrow occurs here

Some errors have detailed explanations: E0500, E0501.
For more information about an error, try `rustc --explain E0500`.
error: could not compile `pebble-interp` (lib) due to 2 previous errors
```

`self.with_call_depth(...)` 已经可变借用了 `*self`，闭包里再用 `self` 就是第二个可变借用，违反第 2 篇的"可变引用独占"。解决办法是 `with_call_depth` 自己把 `self` 借给闭包：调用它的时候，它拿着 `&mut self`，在 `body(self)` 里把它**转交**给闭包，这样同一时刻只有一个人持有。这个签名里的 `&mut Self` 参数就是这么来的。

我在实验室里把同一个问题缩成十行，文件是 `~/rust-lab/src/bin/ch09_fn_bound.rs`：

```rust
// ~/rust-lab/src/bin/ch09_fn_bound.rs
// A cut-down `with_call_depth`: `body` is declared `Fn`, but we move `args` into it.
fn with_depth<T>(body: impl Fn() -> T) -> T {
    body()
}

fn main() {
    let args: Vec<i64> = vec![1, 2, 3];
    let total = with_depth(move || {
        let consumed = args; // moves `args` out of the closure's captured state
        consumed.len()
    });
    println!("{total}");
}
```

```text
$ cargo build --bin ch09_fn_bound
   Compiling rust-lab v0.1.0 (/tmp/rust-lab)
error[E0507]: cannot move out of `args`, a captured variable in an `Fn` closure
  --> src/bin/ch09_fn_bound.rs:10:24
   |
 8 |     let args: Vec<i64> = vec![1, 2, 3];
   |         ---- captured outer variable
 9 |     let total = with_depth(move || {
   |                            ------- captured by this `Fn` closure
10 |         let consumed = args; // moves `args` out of the closure's captured state
   |                        ^^^^ move occurs because `args` has type `Vec<i64>`, which does not implement the `Copy` trait
   |
help: `Fn` and `FnMut` closures require captured values to be able to be consumed multiple times, but `FnOnce` closures may consume them only once
  --> src/bin/ch09_fn_bound.rs:3:29
   |
 3 | fn with_depth<T>(body: impl Fn() -> T) -> T {
   |                             ^^^^^^^^^
help: consider borrowing here
   |
10 |         let consumed = &args; // moves `args` out of the closure's captured state
   |                        +

For more information about this error, try `rustc --explain E0507`.
error: could not compile `rust-lab` (bin "ch09_fn_bound") due to 1 previous error
```

### 两个测试

先把 `tests` 模块的头换成最终形态，它多了一个 `run_with_output`，用来观察 `print` 写出了什么（`Shared` 是一个临时定义在函数里的类型，包着一个 `Rc<RefCell<Buffer>>`；你已经在第 8 篇见过 `Buffer`）：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use pebble_parser::parse;
    use pebble_span::SourceId;
    use pebble_value::Buffer;

    fn run(src: &str) -> Result<Value, RuntimeError> {
        let mut interpreter = Interpreter::with_output(Box::new(Buffer::new()));
        let result = parse(SourceId(0), src);
        assert!(result.is_ok(), "parse errors: {:?}", result.diagnostics);
        interpreter.interpret(&result.program)
    }

    fn run_with_output(src: &str) -> (Result<Value, RuntimeError>, Vec<String>) {
        struct Shared(Rc<RefCell<Buffer>>);
        impl Output for Shared {
            fn write_line(&mut self, line: &str) {
                self.0.borrow_mut().write_line(line);
            }
        }
        let shared = Rc::new(RefCell::new(Buffer::new()));
        let mut interpreter = Interpreter::with_output(Box::new(Shared(Rc::clone(&shared))));
        let result = parse(SourceId(0), src);
        let value = interpreter.interpret(&result.program);
        let lines = shared.borrow().lines().to_vec();
        (value, lines)
    }
```

然后写两个测试。闭包：

```rust
    #[test]
    fn closures_capture_their_environment() {
        let src = "
            fn make_counter() {
                let n = 0;
                return fn() { n = n + 1; return n; };
            }
            let c = make_counter();
            c(); c(); c();
        ";
        assert_eq!(run(src).unwrap(), Value::Int(3));
    }
```

`make_counter` 返回一个匿名函数，匿名函数的 `env` 就是 `make_counter` 这次调用的环境，`n` 住在里面。`let c = make_counter();` 之后三次调用 `c()`，每次都改那个共享的 `n`，最后一次得到 `3`。这就是 `examples/closures.pebble` 的核心。

递归：

```rust
    #[test]
    fn recursion_works() {
        let src = "
            fn fact(n) {
                if n < 2 { return 1; }
                return n * fact(n - 1);
            }
            fact(10);
        ";
        assert_eq!(run(src).unwrap(), Value::Int(3_628_800));
    }
```

你手里现在有 5 个测试。tag 的测试模块里还有 7 个同一类的测试：`control_flow_loops`、`print_reaches_the_output_sink`、`runtime_errors_are_reported_with_a_trace`、`recursive_overflow_is_caught`、`arity_errors_are_reported`、`calling_a_non_function_is_an_error`、`type_errors_propagate_from_operators`。它们没有新的 Rust 概念（`recursive_overflow_is_caught` 下一节单独讲），你可以现在就从 [tag](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-interp/src/lib.rs#L533-L726) 复制进来，也可以留到最后一次性换成 tag 的版本。我是现在就复制了，得到的是：

```bash
cargo test -p pebble-interp
```

```text
running 12 tests
...
test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

### 递归深度：一个实验

解释器里每一层 Pebble 调用都对应好几层 Rust 调用：`eval` → `call_value` → `with_call_depth` → 闭包 → `run_function` → `execute_block` → `execute_stmt` → `eval` ……，所有这些都在**真正的 C 栈**上。Pebble 程序写一个无限递归，不拦着它，Rust 会把整个进程的栈耗光，然后进程被信号杀死。`max_depth` 就是在那之前自己报错。

我最初把限制设成 512，因为听上去合理。做了一个实验：在仓库的一个临时 worktree 里把 `max_depth` 改成 512，在**默认大小的测试线程**上运行同样的无限递归：

```rust
#[test]
fn overflow_on_the_default_test_stack() {
    let error = run("fn loop() { return loop(); } loop();").unwrap_err();
    assert!(error.message().contains("stack overflow"), "{error}");
}
```

```text
$ cargo test -p pebble-interp overflow_on_the_default
running 1 test

thread 'tests::overflow_on_the_default_test_stack' (118017) has overflowed its stack
fatal runtime error: stack overflow, aborting
error: test failed, to rerun pass `-p pebble-interp --lib`

Caused by:
  process didn't exit successfully: `/tmp/target-repro-09/debug/deps/pebble_interp-73b1f9eb2ef807c8 overflow_on_the_default` (signal: 6, SIGABRT: process abort signal)
```

整个测试进程被 `SIGABRT` 带走了，我们没有看到 Pebble 的任何错误信息，连断言都没来得及跑。同样的测试把限制换回 128：

```text
test tests::overflow_on_the_default_test_stack ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 16 filtered out; finished in 0.00s
```

我又试了 192、256、320、384、448，全部栈溢出。所以在这台机器上、debug 构建下，测试线程默认的 2 MiB 栈能撑过 128 层、撑不过 192 层，换算下来每层 Pebble 调用大约吃 11 到 16 KiB 栈（这是我用两端界限估的，不是测出来的精确值）。命令行的主线程是 8 MiB，所以同样的 512 在 `pebble run` 里没问题，这也是限制值可以按平台调整的原因，`set_max_depth` 就是给它留的。

仓库里的测试 `recursive_overflow_is_caught` 没有用默认线程，而是自己开了一个 64 MiB 的线程：

```rust
    #[test]
    fn recursive_overflow_is_caught() {
        // Reaching the recursion limit needs far more host stack than a default
        // test thread has, and `Value` is not `Send`, so the assertion runs
        // inside a dedicated large-stack thread.
        std::thread::Builder::new()
            .stack_size(64 * 1024 * 1024)
            .spawn(|| {
                let src = "fn loop() { return loop(); } loop();";
                let mut interpreter = Interpreter::with_output(Box::new(Buffer::new()));
                let result = parse(SourceId(0), src);
                let error = interpreter.interpret(&result.program).unwrap_err();
                assert!(error.message().contains("stack overflow"), "{error}");
            })
            .expect("spawn overflow thread")
            .join()
            .expect("overflow test panicked");
    }
```

`std::thread::Builder` 是 `thread::spawn` 的"可配置版"，能设置栈大小和线程名。`.spawn(closure)` 返回 `io::Result<JoinHandle<T>>`（线程创建可能失败，所以是 `Result`），`.expect(...)` 解包，`.join()` 等线程结束并取回返回值，`.expect(...)` 再解一次。**整个测试在线程里面**，因为 `Value` 是 `!Send`（里面有 `Rc`，第 14 篇细讲 `Send`）：不能在外面建好解释器再送进线程，所以解释器是在闭包里面创建的。至于为什么给 64 MiB：测试里的注释说"需要远多于默认测试线程的栈"，但按上面的实验，在这台机器的 debug 构建下，限制是 128 的时候默认栈就够了，所以这 64 MiB 是留的余量，不是必需；以后谁把限制调高，这个测试不会因为栈不够而误报。

至此：

在第二版命令行里（马上就写），这个无限递归程序 `forever.pebble`：

```pebble
fn forever(n) {
    return forever(n + 1);
}
forever(0);
```

给出的是一条干净的 Pebble 错误：

```text
$ pebble run forever.pebble
error[E2001]: call stack overflow (recursion limit 128)
 --> forever.pebble:2:12
  |
2 |     return forever(n + 1);
  |            ^^^^^^^^^^^^^^
  |
  in `forever` at forever.pebble:2:12
  in `forever` at forever.pebble:2:12
  in `forever` at forever.pebble:2:12
  ...
  in `forever` at forever.pebble:2:12
  in `forever` at forever.pebble:4:1
```

调用栈一共 129 帧（文件是 135 行），我截掉了中间：128 帧是 `forever` 自己在第 2 行的递归调用，最后一帧（`at ...:4:1`）是顶层的 `forever(0);`。

## 第四步：列表、映射和下标

最后补上集合。先更新文件头：多了 `HashMap` 和 `MapKey`，再加一行 `#![allow(...)]`。后者的来历：map 字面量建的是 `HashMap<MapKey, Value>`，而 `MapKey` 里有 `Rc<RefCell<..>>`，clippy 会抗议（第 8 篇见过同一条）。不加它，`cargo clippy` 给出：

```text
warning: mutable key type
   --> crates/pebble-interp/src/lib.rs:259:17
    |
259 |                 let mut map = HashMap::with_capacity(entries.len());
    |                 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: ... because it contains `MapKey`, which has interior mutability
    = note: ... because it contains `Value`, which has interior mutability
    = note: ... because it contains `Rc<RefCell<Vec<Value>>>`, which has interior mutability
...
    = note: `-W clippy::mutable-key-type` implied by `-W clippy::all`
    = help: to override `-W clippy::all` add `#[allow(clippy::mutable_key_type)]`
```

理由和第 8 篇的一样：`MapKey` 的 `Hash` 看的是值本身，而列表、map 这类带内部可变性的键按指针身份哈希，所以不会在键被插入之后悄悄改变哈希值。新的文件头是：

```rust
#![forbid(unsafe_code)]
#![allow(clippy::mutable_key_type)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use pebble_ast::{BinaryOp, Expr, LogicalOp, Program, Spanned, Stmt, UnaryOp};
use pebble_span::Span;
use pebble_value::{
    Env, Function, MapKey, Output, RuntimeError, Stdout, Value, call_native, compare, div, mul,
    negate, rem, sub,
};
```

然后给 `eval` 补四个分支。字面量，放在 `Var` 之后：

```rust
            Expr::List { items, .. } => {
                let values = items
                    .iter()
                    .map(|item| self.eval(item, env))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(Value::list(values))
            }
            Expr::Map { entries, .. } => {
                let mut map = HashMap::with_capacity(entries.len());
                for (key, value) in entries {
                    let key = self.eval(key, env)?;
                    let value = self.eval(value, env)?;
                    map.insert(MapKey(key), value);
                }
                Ok(Value::Map(Rc::new(RefCell::new(map))))
            }
```

这里又出现了 `collect::<Result<Vec<_>, _>>()?`。Map 字面量用的是 `HashMap::with_capacity` 预分配，`MapKey(key)` 是第 8 篇的包装类型。注意 `Value::Map(Rc::new(RefCell::new(map)))`：新建的 map 从一开始就是共享的。

赋值的下标分支，放在 `Expr::Var` 目标分支后面、`other` 兜底前面：

```rust
                    Expr::Index {
                        object,
                        index,
                        span,
                    } => {
                        let container = self.eval(object, env)?;
                        let key = self.eval(index, env)?;
                        assign_index(&container, &key, new_value.clone(), *span)?;
                        Ok(new_value)
                    }
```

读下标，放在 `Call` 和 `Fn` 分支之间：

```rust
            Expr::Index {
                object,
                index,
                span,
            } => {
                let container = self.eval(object, env)?;
                let key = self.eval(index, env)?;
                index_value(&container, &key, *span)
            }
```

现在 `eval` 里不再需要 `_ => todo!()` 了，把它删掉。需要三个辅助函数，放在 `eval_binary` 后面、`iterable_span` 前面，都是普通函数，不需要 `self`。读和写的实现：

- `index_value`：[tag 的第 458 到 479 行](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-interp/src/lib.rs#L458-L479)，按 `Value` 的种类分三路：列表、字符串、映射。字符串下标要先 `chars().collect()`，因为第 2 篇说过 UTF-8 字符串不能按字节偏移当下标。
- `assign_index`：[第 481 到 502 行](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-interp/src/lib.rs#L481-L502)，列表和映射可以写，字符串不行（报"cannot assign into string"）。

这两个函数没有新的 Rust 概念，复制过去就行，这里省得你读。第三个辅助函数 `resolve_index` 值得写，因为它是个泛型函数：

```rust
/// Turns an index value into a `usize`, supporting negative indices.
fn resolve_index<T>(items: &[T], key: &Value, span: Span) -> Result<usize, RuntimeError> {
    let Value::Int(raw) = key else {
        return Err(RuntimeError::new(
            span,
            format!("list index must be an int, got {}", key.type_name()),
        ));
    };
    let len = items.len() as i64;
    let index = if *raw < 0 { len + raw } else { *raw };
    if index < 0 || index >= len {
        return Err(RuntimeError::new(
            span,
            format!("index {raw} is out of range for length {len}"),
        ));
    }
    Ok(index as usize)
}
```

列表的元素是 `Value`，字符串的"元素"是 `char`，但把一个 Pebble 整数变成合法的 `usize` 下标，规则完全一样：必须是整数，负数从末尾数，越界报错。所以我们不关心元素是什么，只需要长度，签名写成 `items: &[T]`，对任何 `T` 都成立。调用点：`resolve_index(&items.borrow(), key, span)`（`&Vec<Value>` 自动转成 `&[Value]`，第 2 篇说的切片）和 `resolve_index(&chars, key, span)`（`&Vec<char>`）。编译器会为 `Value` 和 `char` 各生成一份专门的代码，也就是第 5 篇的单态化。

这里的 `len as i64` 和 `index as usize` 是 `as` 强转：长度几乎不可能超过 `i64::MAX`，而 `index` 在前面已经检查过落在 `0..len` 之间，所以转成 `usize` 一定不会丢信息。

补上测试，放在 `recursion_works` 后面：

```rust
    #[test]
    fn lists_maps_and_indexing() {
        assert_eq!(
            run("let xs = [10, 20, 30]; xs[1];").unwrap(),
            Value::Int(20)
        );
        // Negative indices count from the end.
        assert_eq!(
            run("let xs = [10, 20, 30]; xs[-1];").unwrap(),
            Value::Int(30)
        );
        assert_eq!(
            run("let m = #{ \"a\": 1 }; m[\"a\"];").unwrap(),
            Value::Int(1)
        );
        assert_eq!(
            run("let xs = [1]; xs[0] = 5; xs[0];").unwrap(),
            Value::Int(5)
        );
    }
```

```text
test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

### for 为什么先克隆

现在可以回答之前留下的问题：`for` 为什么先 `items.borrow().clone()` 一份快照。看这个 Pebble 程序，一边遍历列表，一边往同一个列表里推新元素：

```pebble
let xs = [1, 2, 3];
for x in xs {
    push(xs, x * 10);
}
print(xs);
```

```text
$ pebble run grow.pebble
[1, 2, 3, 10, 20, 30]
```

遍历用的是快照 `[1, 2, 3]`，所以只会跑三次，`push` 往真正的列表里加了三个，最后是 6 个元素，不会死循环。如果不拷贝呢？我在 worktree 里把这两行改成"拿着借用守卫直接遍历"（`let guard = items.borrow(); for item in guard.iter().cloned() { ... }`）。它能通过编译，Rust 不会拦你，因为 `RefCell` 把借用检查推迟到了运行时：

```text
$ pebble run grow.pebble

thread 'main' (118031) panicked at crates/pebble-value/src/lib.rs:912:11:
RefCell already borrowed
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
```

`guard` 是 `Ref<'_, Vec<Value>>`，活到循环结束；循环体里 `push` 想要 `borrow_mut()`，此时有一个 `Ref` 还活着，`RefCell` 发现了冲突，当场 panic。这是第 8 篇 `ch08_refcell_panic` 那个实验的真实版本。

我在实验室里把它缩成最小的复现，文件是 `~/rust-lab/src/bin/ch09_iter_mutate.rs`：

```rust
// ~/rust-lab/src/bin/ch09_iter_mutate.rs
use std::cell::RefCell;
use std::rc::Rc;

fn main() {
    let list = Rc::new(RefCell::new(vec![1, 2, 3]));

    // The snapshot way: clone the Vec, loop over the copy, mutate the original.
    let snapshot = list.borrow().clone();
    for x in snapshot {
        list.borrow_mut().push(x * 10);
    }
    println!("with a snapshot: {:?}", list.borrow());

    // The tempting way: loop over the live borrow while the body mutates.
    let list = Rc::new(RefCell::new(vec![1, 2, 3]));
    for x in list.borrow().iter() {
        list.borrow_mut().push(x * 10);
    }
    println!("unreachable: {:?}", list.borrow());
}
```

```bash
cargo run --quiet --bin ch09_iter_mutate
```

```text
with a snapshot: [1, 2, 3, 10, 20, 30]

thread 'main' (117827) panicked at src/bin/ch09_iter_mutate.rs:18:14:
RefCell already borrowed
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
```

第一部分是快照：克隆一份 `Vec`，在副本上遍历，原件随便改。第二部分是"活借用"：编译通过，运行时 panic，位置在 `borrow_mut()`。C++ 里这就是"一边遍历 `std::vector` 一边 `push_back`"，迭代器失效，是未定义行为，可能崩溃，也可能悄悄给你错误的数据。Rust + `RefCell` 把它变成一个确定的、可复现的 panic；而我们的解释器再往前走一步，用快照让这类程序**有定义**。克隆一个 `Vec<Value>` 每个元素只是把 `Rc` 的计数加一，不是深拷贝，所以快照的代价是一次 `Vec` 分配加 N 次计数递增。

## 那个泄漏

终于到这里了。看这个程序：

```pebble
fn fact(n) {
    if n < 2 { return 1; }
    return n * fact(n - 1);
}
fact(5);
```

跑完之后，解释器里那个全局 `Env` 会发生什么？

`fact` 被定义在全局环境里：全局的 `values` 哈希表里有一项 `"fact" -> Value::Function(Rc<Function>)`。而这个 `Function` 的 `env` 字段，是它声明那一刻捕获的环境，也就是全局环境本身（`Rc::clone(env)`）。所以：

```mermaid
flowchart LR
    G["全局 Env"] -->|"values[fact]"| F["Function fact"]
    F -->|"env"| G
```

全局环境拥有 `fact`，`fact` 拥有全局环境。`Rc` 的引用计数是一个简单的整数：全局 `Env` 的计数至少是 2（解释器的 `globals` 字段一个，`fact.env` 一个）。解释器被丢弃时，`globals` 字段释放，计数从 2 降到 1，**不是 0**，`Env` 永远不会被释放。

**不止递归函数：任何存放在它自己捕获的环境里的函数都会造成这个环。** `fn f() {}` 也行，`let f = fn() { return 1; };` 也行。回忆第 8 篇里 `Rc` 和 C++ `shared_ptr` 的对照：`shared_ptr` 也有一模一样的问题，所以 C++ 里有 `weak_ptr`。Rust 的对应物是 `Weak<T>`：它指向 `Rc` 管理的数据，但**不增加强引用计数**；想用的时候调用 `upgrade()`，数据还在就得到 `Some(Rc<T>)`，已经被释放就得到 `None`。

先在实验室里把这个环的整个故事演一遍，用最小的结构体表示"作用域"和"函数"。文件是 `~/rust-lab/src/bin/ch09_cycle.rs`：

```rust
// ~/rust-lab/src/bin/ch09_cycle.rs
use std::cell::RefCell;
use std::rc::{Rc, Weak};

struct Scope {
    name: &'static str,
    // A "function" stored in the scope that it captured.
    function: Option<Rc<Function>>,
}

struct Function {
    // Never read: the field exists only to keep the scope alive.
    #[allow(dead_code)]
    env: Rc<RefCell<Scope>>,
}

impl Drop for Scope {
    fn drop(&mut self) {
        println!("  dropping scope `{}`", self.name);
    }
}

fn main() {
    println!("-- a scope without functions");
    let plain = Rc::new(RefCell::new(Scope { name: "plain", function: None }));
    let weak_plain: Weak<RefCell<Scope>> = Rc::downgrade(&plain);
    drop(plain);
    println!("  alive after drop: {}", weak_plain.upgrade().is_some());

    println!("-- a scope that stores a function capturing itself");
    let globals = Rc::new(RefCell::new(Scope { name: "globals", function: None }));
    let function = Rc::new(Function { env: Rc::clone(&globals) });
    globals.borrow_mut().function = Some(function);
    println!("  strong count: {}", Rc::strong_count(&globals));
    let weak_globals = Rc::downgrade(&globals);
    drop(globals);
    println!("  alive after drop: {}", weak_globals.upgrade().is_some());
}
```

```bash
cargo run --quiet --bin ch09_cycle
```

```text
-- a scope without functions
  dropping scope `plain`
  alive after drop: false
-- a scope that stores a function capturing itself
  strong count: 2
  alive after drop: true
```

对比一目了然：没有函数的作用域在 `drop(plain)` 后马上执行了 `Drop`（打印了 `dropping scope plain`），`Weak::upgrade` 得到 `None`；存了一个捕获自己的函数的作用域，`strong count` 是 2，`drop(globals)` 之后，`Weak::upgrade` 还是 `Some`，而且 `Drop` 根本没被调用，没有那行 `dropping scope globals`。

我们要把这个事实写进测试。Pebble 的测试用 `Weak` 作"看门狗"：

```rust
    /// Any function value stored in the environment it captured forms an `Rc`
    /// cycle (not only recursive ones): the globals own `fact`, and `fact`
    /// owns the globals it closed over.
    #[test]
    fn top_level_functions_keep_globals_alive() {
        let src = "fn fact(n) { if n < 2 { return 1; } return n * fact(n - 1); } fact(5);";
        let mut interpreter = Interpreter::with_output(Box::new(Buffer::new()));
        let result = parse(SourceId(0), src);
        interpreter.interpret(&result.program).unwrap();
        let globals: Weak<RefCell<Env>> = Rc::downgrade(&interpreter.globals());
        drop(interpreter);
        assert!(
            globals.upgrade().is_some(),
            "globals hold `fact`, `fact` holds globals: the cycle leaks"
        );
    }
```

`Rc::downgrade(&interpreter.globals())` 对 `globals()` 返回的临时 `Rc` 做了降级，得到一个不计数的 `Weak`；这个临时 `Rc` 在这一行结束时被释放，计数回到原来的值。`drop(interpreter)` 释放解释器。断言在这之后：`globals.upgrade().is_some()`，环境**还活着**。这个测试的断言信息（"the cycle leaks"）是它存在的意义：它不是在测一个 bug 的修复，是在**记录一个已知的限制**。

它的反面：

```rust
    #[test]
    fn globals_without_functions_are_freed() {
        let mut interpreter = Interpreter::with_output(Box::new(Buffer::new()));
        let result = parse(SourceId(0), "let x = 1 + 2; x;");
        interpreter.interpret(&result.program).unwrap();
        let globals: Weak<RefCell<Env>> = Rc::downgrade(&interpreter.globals());
        drop(interpreter);
        assert!(globals.upgrade().is_none());
    }
```

没有函数时，`globals` 的计数只有一个，`drop(interpreter)` 后降到 0，`upgrade()` 得到 `None`。这个测试保证第一个测试不是因为别的原因通过的：同样的测试夹具，换一个程序，结果相反。

### 为什么不用 Weak 修掉它

很自然的想法是：把 `Function.env` 改成 `Weak<RefCell<Env>>`，环就断了。我在实验室里把这个想法最小地做了一遍，文件是 `~/rust-lab/src/bin/ch09_weak_env.rs`：

```rust
// ~/rust-lab/src/bin/ch09_weak_env.rs
use std::cell::RefCell;
use std::rc::{Rc, Weak};

struct Scope {
    count: i64,
}

// A closure that only holds a Weak pointer to the scope it captured.
struct WeakClosure {
    env: Weak<RefCell<Scope>>,
}

impl WeakClosure {
    fn call(&self) -> Option<i64> {
        let env = self.env.upgrade()?;
        let mut scope = env.borrow_mut();
        scope.count += 1;
        Some(scope.count)
    }
}

// Like `make_counter()` in Pebble: the call's scope is a local that nobody else owns.
fn make_counter() -> WeakClosure {
    let scope = Rc::new(RefCell::new(Scope { count: 0 }));
    WeakClosure { env: Rc::downgrade(&scope) }
} // `scope` is dropped here, the only strong pointer is gone

fn main() {
    let next = make_counter();
    println!("first call:  {:?}", next.call());
    println!("second call: {:?}", next.call());
}
```

```bash
cargo run --quiet --bin ch09_weak_env
```

```text
first call:  None
second call: None
```

`make_counter` 里的 `scope` 是调用时创建的环境，它**只有这个局部变量一个强引用**。闭包只拿 `Weak`，所以函数一返回，`scope` 被释放，闭包再调用时 `upgrade()` 总是 `None`：这个计数器永远数不到 1。闭包必须是环境的**所有者**之一，闭包才能把 `count` 带出去活着。这就是 `examples/closures.pebble` 的意义，也是 Pebble 闭包的本质。

所以问题没有局部解法：环是**真的**有，因为全局函数确实需要全局环境，全局环境确实需要找到全局函数。引用计数天生无法回收环；`Weak` 只适合"那条边本来就是反向的"的场合，比如父指针（子拥有，父不拥有）。Pebble 的另一个后端不再借用 `Rc`，而是自己写一个**追踪式垃圾回收器**，从根出发标记可达对象，剩下的清扫，环不再是问题。那是[第 11 篇](/posts/rust-by-pebble-11-gc-unsafe/)和[第 12 篇](/posts/rust-by-pebble-12-vm-backends/)。第 12 篇里有个测试会真的造出一个不可达的闭包环，再证明回收器把它释放。

在这之前我选择接受。短命的 CLI 进程退出时操作系统收回所有内存；真正持续运行的使用场景是 REPL，那里每个函数定义泄漏一点点，对一个学习项目来说可以容忍。**把限制写成一个会失败的测试**，比把它写进注释好：哪天有人修好了它，这个测试会红，提醒他更新断言和文档。

## 补全文件

四步都写完了。现在做最后一件事：让文件和 tag 逐字节一致。需要补的东西有三块。

**文件头**：把文件开头到第一行 `use` 之前的部分换成 tag 里的 [第 1 到 15 行](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-interp/src/lib.rs#L1-L15)：`#![forbid(unsafe_code)]`，那行 `#![allow(clippy::mutable_key_type)]` 加上两行说明理由的注释，以及 crate 级文档注释。这段文档里有一个英文破折号，我的博客不用这个符号，所以不在文章里贴它，请直接从链接复制。`use` 列表就是上一步写的那个，不用动。

**`builtin_value`**：一个给嵌入使用者的小函数，放在 `iterable_span` 之后、`mod tests` 之前：

```rust
/// Convenience: looks up a builtin by name, for embedding tests and tools.
#[must_use]
pub fn builtin_value(name: &str) -> Option<Value> {
    builtin(name).map(Value::Native)
}
```

**测试**：把整个 `#[cfg(test)] mod tests { ... }` 换成 tag 里的 [第 533 到 726 行](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-interp/src/lib.rs#L533-L726)。里面是按固定次序排的 16 个测试，次序是：`evaluates_arithmetic_with_precedence`、`variables_and_assignment`、`closures_capture_their_environment`、`recursion_works`、`lists_maps_and_indexing`、`string_concatenation_and_indexing`、`control_flow_loops`、`while_loop_accumulates`、`print_reaches_the_output_sink`、`runtime_errors_are_reported_with_a_trace`、`recursive_overflow_is_caught`、`arity_errors_are_reported`、`calling_a_non_function_is_an_error`、`type_errors_propagate_from_operators`，最后是我们写的两个泄漏测试。测试头里多了 `use std::rc::Weak;`。

```bash
cargo test -p pebble-interp
```

```text
running 16 tests
test tests::calling_a_non_function_is_an_error ... ok
test tests::arity_errors_are_reported ... ok
test tests::closures_capture_their_environment ... ok
test tests::control_flow_loops ... ok
test tests::evaluates_arithmetic_with_precedence ... ok
test tests::globals_without_functions_are_freed ... ok
test tests::print_reaches_the_output_sink ... ok
test tests::lists_maps_and_indexing ... ok
test tests::runtime_errors_are_reported_with_a_trace ... ok
test tests::recursion_works ... ok
test tests::string_concatenation_and_indexing ... ok
test tests::type_errors_propagate_from_operators ... ok
test tests::variables_and_assignment ... ok
test tests::top_level_functions_keep_globals_alive ... ok
test tests::while_loop_accumulates ... ok
test tests::recursive_overflow_is_caught ... ok
test result: ok. 16 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

16 个，两个 `Weak` 测试在列。

## 命令行第二版：run 和 repl

现在把解释器接到 `pebble` 命令行上。第 7 篇的版本有 `tokens`、`parse`、`check`；这一版加上 `run`（执行文件）和 `repl`（交互）。改动涉及全部六个文件外加一个新文件 `repl.rs`，我把每一个都完整列出来。

先在根 `Cargo.toml` 的外部依赖里加一行 `rustyline`，它是一个行编辑库，REPL 用它读输入（上下箭头、历史记录）：

```toml
rustyline = "18"
```

放在 `quote` 之后、`syn` 之前，保持字母序。

`crates/pebble-cli/Cargo.toml`：新增三个依赖，`pebble-value`、`pebble-interp`、`rustyline`。

```toml
[package]
name = "pebble-cli"
description = "The pebble command-line driver: run, compile, disassemble, repl."
version.workspace = true
edition.workspace = true
rust-version.workspace = true
authors.workspace = true
license.workspace = true
repository.workspace = true

[[bin]]
name = "pebble"
path = "src/main.rs"

[dependencies]
pebble-span.workspace = true
pebble-diag.workspace = true
pebble-lexer.workspace = true
pebble-ast.workspace = true
pebble-parser.workspace = true
pebble-value.workspace = true
pebble-interp.workspace = true
anyhow.workspace = true
clap.workspace = true
rustyline.workspace = true

[dev-dependencies]
assert_cmd = "2"
predicates = "3"

[lints]
workspace = true
```

`src/cli.rs` 多了两个子命令和一组参数。`Run(RunArgs)` 里的 `quiet` 是为了让脚本能只看 `print` 的输出，不看最后那个值：

```rust
//! The command-line surface, declared with clap's derive API.
//!
//! Everything here is data: the actual work lives in [`crate::commands`] and
//! [`crate::repl`]. Keeping the shape of the interface in one small file makes
//! it easy to see at a glance what the driver can do.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

/// Pebble: a small scripting language and toolchain.
#[derive(Debug, Parser)]
#[command(name = "pebble", version)]
pub(crate) struct Cli {
    /// The action to perform.
    #[command(subcommand)]
    pub(crate) command: Command,
}

/// Every top-level action the driver understands.
#[derive(Debug, Subcommand)]
pub(crate) enum Command {
    /// Execute a source file with the tree-walking interpreter.
    Run(RunArgs),
    /// Start an interactive read-eval-print loop.
    Repl,
    /// Print the token stream of a source file.
    Tokens(FileArgs),
    /// Print the parsed abstract syntax tree of a source file.
    Parse(FileArgs),
    /// Lex and parse a source file without running it.
    Check(FileArgs),
}

/// A subcommand whose only input is one source file.
#[derive(Debug, Args)]
pub(crate) struct FileArgs {
    /// The source file to read.
    pub(crate) file: PathBuf,
}

/// Arguments to `pebble run`.
#[derive(Debug, Args)]
pub(crate) struct RunArgs {
    /// The source file to execute.
    pub(crate) file: PathBuf,
    /// Print the parsed syntax tree before running.
    #[arg(long)]
    pub(crate) ast: bool,
    /// Do not print the program's final value.
    #[arg(long)]
    pub(crate) quiet: bool,
}
```

`src/sources.rs`：这个文件多了三样东西：`Source::from_text`（REPL 要把一行文本当成一个"文件"）、`render_runtime`、`emit_runtime`。运行时错误除了自己的诊断，还带着调用栈，所以这里要给每一帧补上"在哪个文件第几行第几列"：

```rust
//! Loading source text and turning diagnostics into printable text.
//!
//! Every subcommand works the same way: read a file into a [`SourceMap`], hand
//! the text and its id to the lexer and parser, then render whatever came
//! back against that same map so the carets land on the right characters.

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use pebble_diag::{Diagnostic, Severity};
use pebble_span::{SourceId, SourceMap};
use pebble_value::RuntimeError;

/// One registered source file plus the map that owns it.
pub(crate) struct Source {
    /// Maps spans back to the text they came from.
    pub(crate) map: SourceMap,
    /// The id the text was registered under.
    pub(crate) id: SourceId,
}

impl Source {
    /// Reads `path` and registers its text in a fresh map.
    ///
    /// # Errors
    /// Returns an error if the file cannot be read as UTF-8 text.
    pub(crate) fn load(path: &Path) -> Result<Self> {
        let text =
            fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
        Ok(Self::from_text(path.display().to_string(), text))
    }

    /// Registers `text` under `name` in a fresh map.
    pub(crate) fn from_text(name: impl Into<String>, text: impl Into<String>) -> Self {
        let mut map = SourceMap::new();
        let id = map.add(name, text);
        Self { map, id }
    }

    /// The registered text.
    #[must_use]
    pub(crate) fn text(&self) -> &str {
        self.map[self.id].text()
    }
}

/// Whether any diagnostic is an error (as opposed to a warning).
#[must_use]
pub(crate) fn has_errors(diagnostics: &[Diagnostic]) -> bool {
    diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error)
}

/// Renders every diagnostic, one block after another.
#[must_use]
pub(crate) fn render(diagnostics: &[Diagnostic], sources: &SourceMap) -> String {
    let mut out = String::new();
    for diagnostic in diagnostics {
        out.push_str(&diagnostic.render(sources));
    }
    out
}

/// Renders a runtime error, followed by its stack trace.
#[must_use]
pub(crate) fn render_runtime(error: &RuntimeError, sources: &SourceMap) -> String {
    let mut out = error.diagnostic.render(sources);
    for frame in &error.trace {
        match sources.get(frame.span.source) {
            Some(file) => {
                let position = file.position(frame.span.start);
                out.push_str(&format!(
                    "  in `{}` at {}:{}:{}\n",
                    frame.function,
                    file.name(),
                    position.line,
                    position.column
                ));
            }
            None => out.push_str(&format!("  in `{}`\n", frame.function)),
        }
    }
    out
}

/// Prints every diagnostic to stderr; returns `true` if any of them is an error.
pub(crate) fn emit(diagnostics: &[Diagnostic], sources: &SourceMap) -> bool {
    eprint!("{}", render(diagnostics, sources));
    has_errors(diagnostics)
}

/// Prints a runtime error and its stack trace to stderr.
pub(crate) fn emit_runtime(error: &RuntimeError, sources: &SourceMap) {
    eprint!("{}", render_runtime(error, sources));
}
```

`render_runtime` 里 `sources.get(frame.span.source)` 返回 `Option`（第 2 篇的 `get` 对比 `[]`）：有就打印位置，没有就只打印函数名。`format!` 的格式里 `{}` 的数量要和参数个数对得上，编译器会检查。

`src/commands.rs`：多了 `run`。它先解析，有语法错误就打印并退出（不会运行半个程序）；`--ast` 时打印语法树；然后建解释器，执行，成功时如果不是 `--quiet` 并且值不是 `nil` 就打印：

```rust
//! The work behind each subcommand.
//!
//! Every function returns the process exit code it wants: `0` on success and
//! `1` when the input produced diagnostics or failed at runtime. Only host
//! problems (an unreadable file, say) escape as an [`anyhow::Error`].

use anyhow::Result;
use pebble_ast::pretty;
use pebble_interp::Interpreter;
use pebble_lexer::tokenize;
use pebble_parser::parse as parse_program;
use pebble_value::Value;

use crate::cli::{FileArgs, RunArgs};
use crate::sources::{self, Source};

/// `pebble run`: parse a file, then execute it with the tree-walking interpreter.
///
/// # Errors
/// Returns an error only for host-level failures such as an unreadable file.
pub(crate) fn run(args: &RunArgs) -> Result<u8> {
    let source = Source::load(&args.file)?;
    let parsed = parse_program(source.id, source.text());
    if sources::emit(&parsed.diagnostics, &source.map) {
        return Ok(1);
    }

    if args.ast {
        print!("{}", pretty(&parsed.program));
    }

    let mut interpreter = Interpreter::new();
    match interpreter.interpret(&parsed.program) {
        Ok(value) => {
            if !args.quiet && !matches!(value, Value::Nil) {
                println!("{value}");
            }
            Ok(0)
        }
        Err(error) => {
            sources::emit_runtime(&error, &source.map);
            Ok(1)
        }
    }
}

/// `pebble tokens`: one `line:col kind` line per token.
///
/// # Errors
/// Returns an error only for host-level failures such as an unreadable file.
pub(crate) fn tokens(args: &FileArgs) -> Result<u8> {
    let source = Source::load(&args.file)?;
    let (tokens, diagnostics) = tokenize(source.id, source.text());
    let failed = sources::emit(&diagnostics, &source.map);

    let file = &source.map[source.id];
    for token in &tokens {
        let position = file.position(token.span.start);
        println!("{}:{} {}", position.line, position.column, token.kind);
    }
    Ok(if failed { 1 } else { 0 })
}

/// `pebble parse`: print the recovered syntax tree.
///
/// # Errors
/// Returns an error only for host-level failures such as an unreadable file.
pub(crate) fn parse(args: &FileArgs) -> Result<u8> {
    let source = Source::load(&args.file)?;
    let parsed = parse_program(source.id, source.text());
    let failed = sources::emit(&parsed.diagnostics, &source.map);
    print!("{}", pretty(&parsed.program));
    Ok(if failed { 1 } else { 0 })
}

/// `pebble check`: lex and parse a file, reporting diagnostics and nothing else.
///
/// # Errors
/// Returns an error only for host-level failures such as an unreadable file.
pub(crate) fn check(args: &FileArgs) -> Result<u8> {
    let source = Source::load(&args.file)?;
    let parsed = parse_program(source.id, source.text());
    let failed = sources::emit(&parsed.diagnostics, &source.map);
    Ok(if failed { 1 } else { 0 })
}
```

`src/main.rs`：

```rust
//! The `pebble` command-line driver.
//!
//! This binary is the front door to the toolchain: it wires the lexer, the
//! parser, the interpreter, and the diagnostics renderer together behind a
//! handful of subcommands.
//!
//! Exit codes follow the usual convention: `0` for success, `1` when the input
//! produced diagnostics or failed at runtime, and `2` (clap's default) for a
//! usage error.

#![forbid(unsafe_code)]

mod cli;
mod commands;
mod repl;
mod sources;

use std::process::ExitCode;

use clap::Parser;

use crate::cli::{Cli, Command};

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Run(args) => commands::run(&args),
        Command::Repl => repl::run(),
        Command::Tokens(args) => commands::tokens(&args),
        Command::Parse(args) => commands::parse(&args),
        Command::Check(args) => commands::check(&args),
    };
    match result {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("pebble: {error:#}");
            ExitCode::from(1)
        }
    }
}
```

### repl.rs 和 FromStr

REPL 是一个循环：读一行，判断是命令还是代码，执行，打印。**以 `:` 开头的是元命令**（`:help`、`:quit`、`:tokens <代码>`、`:ast <代码>`）。

处理元命令，最粗暴的写法是在循环里写一串 `if line == ":quit"`。我们换一种：把元命令做成一个枚举，再为它实现标准库的 `FromStr`。`FromStr` 是 `str::parse` 背后的 trait：当你写 `"42".parse::<i32>()`，其实调用的是 `i32::from_str("42")`。第 8 篇我们是**用**它，这里是第一次**实现**它：

```rust
trait FromStr: Sized {
    type Err;
    fn from_str(s: &str) -> Result<Self, Self::Err>;
}
```

`type Err` 是一个**关联类型**（第 4 篇的 `Iterator::Item` 是同一类东西）：每个实现者自己决定解析失败时返回什么错误类型。我们用 `String`，因为只需要一段给用户看的话。

```rust
//! The interactive read-eval-print loop.
//!
//! The interpreter is created once, so definitions persist from line to line,
//! but every line gets its own [`pebble_span::SourceMap`]: a line is parsed and
//! rendered in isolation, which keeps offsets small and diagnostics exact.

use std::str::FromStr;

use anyhow::{Result, anyhow};
use pebble_ast::{Program, Spanned as _, Stmt, pretty};
use pebble_interp::Interpreter;
use pebble_lexer::tokenize;
use pebble_parser::{parse, parse_expression};
use rustyline::DefaultEditor;
use rustyline::error::ReadlineError;

use crate::sources::{self, Source};

/// The text shown before every input line.
const PROMPT: &str = "pebble> ";

/// Runs the REPL until the user quits or sends end-of-file.
///
/// # Errors
/// Returns an error if the line editor cannot be initialised.
pub(crate) fn run() -> Result<u8> {
    let mut editor =
        DefaultEditor::new().map_err(|error| anyhow!("cannot start the line editor: {error}"))?;
    let mut interpreter = Interpreter::new();

    println!("Pebble REPL. Type :help for commands, :quit to exit.");
    loop {
        match editor.readline(PROMPT) {
            Ok(line) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let _ = editor.add_history_entry(line.as_str());
                if trimmed.starts_with(':') {
                    match trimmed.parse::<MetaCommand>() {
                        Ok(MetaCommand::Quit) => break,
                        Ok(MetaCommand::Help) => print_help(),
                        Ok(MetaCommand::Tokens(code)) => show_tokens(&code),
                        Ok(MetaCommand::Ast(code)) => show_ast(&code),
                        Err(message) => eprintln!("pebble: {message}"),
                    }
                } else {
                    eval_line(trimmed, &mut interpreter);
                }
            }
            // Ctrl-C and Ctrl-D both leave the session cleanly.
            Err(ReadlineError::Interrupted | ReadlineError::Eof) => break,
            Err(error) => {
                eprintln!("pebble: input error: {error}");
                break;
            }
        }
    }
    println!();
    Ok(0)
}

/// A `:`-prefixed REPL command.
#[derive(Debug, PartialEq, Eq)]
enum MetaCommand {
    /// Leave the REPL.
    Quit,
    /// Show the command list.
    Help,
    /// Print the token stream of the argument.
    Tokens(String),
    /// Print the syntax tree of the argument.
    Ast(String),
}

impl FromStr for MetaCommand {
    type Err = String;

    fn from_str(line: &str) -> Result<Self, Self::Err> {
        let Some(rest) = line.strip_prefix(':') else {
            return Err(format!("`{line}` is not a command"));
        };
        let (name, argument) = match rest.split_once(char::is_whitespace) {
            Some((name, argument)) => (name, argument.trim()),
            None => (rest, ""),
        };
        match name {
            "quit" | "q" => Ok(Self::Quit),
            "help" | "h" => Ok(Self::Help),
            "tokens" => Ok(Self::Tokens(argument.to_owned())),
            "ast" => Ok(Self::Ast(argument.to_owned())),
            other => Err(format!("unknown command `:{other}`; try :help")),
        }
    }
}

/// Prints the list of meta commands.
fn print_help() {
    println!("commands:");
    println!("  :help, :h        show this help");
    println!("  :quit, :q        leave the REPL");
    println!("  :tokens <code>   print the token stream for <code>");
    println!("  :ast <code>      print the parsed syntax tree for <code>");
}

/// `:tokens`: lex a snippet and print one `line:col kind` line per token.
fn show_tokens(code: &str) {
    if code.is_empty() {
        eprintln!("usage: :tokens <code>");
        return;
    }
    let source = Source::from_text("<repl>", code);
    let (tokens, diagnostics) = tokenize(source.id, source.text());
    sources::emit(&diagnostics, &source.map);

    let file = &source.map[source.id];
    for token in &tokens {
        let position = file.position(token.span.start);
        println!("{}:{} {}", position.line, position.column, token.kind);
    }
}

/// `:ast`: parse a snippet and print its syntax tree.
fn show_ast(code: &str) {
    if code.is_empty() {
        eprintln!("usage: :ast <code>");
        return;
    }
    let source = Source::from_text("<repl>", code);
    let parsed = parse(source.id, source.text());
    sources::emit(&parsed.diagnostics, &source.map);
    print!("{}", pretty(&parsed.program));
}

/// Evaluates one input line: an expression if it parses as one, a program
/// otherwise.
fn eval_line(line: &str, interpreter: &mut Interpreter) {
    let source = Source::from_text("<repl>", line);

    let (expression, diagnostics) = parse_expression(source.id, source.text());
    if let Some(expression) = expression {
        sources::emit(&diagnostics, &source.map);
        let span = expression.span();
        let program = Program::new(vec![Stmt::Expr {
            expr: expression,
            span,
        }]);
        match interpreter.interpret(&program) {
            Ok(value) => println!("{value}"),
            Err(error) => sources::emit_runtime(&error, &source.map),
        }
        return;
    }

    // Not an expression: treat the line as a small program and execute it.
    let parsed = parse(source.id, source.text());
    if sources::emit(&parsed.diagnostics, &source.map) {
        return;
    }
    if let Err(error) = interpreter.interpret(&parsed.program) {
        sources::emit_runtime(&error, &source.map);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_has_a_short_form() {
        assert_eq!(":q".parse(), Ok(MetaCommand::Quit));
    }

    #[test]
    fn arguments_are_kept_whole() {
        assert_eq!(
            ":tokens 1 + 2".parse(),
            Ok(MetaCommand::Tokens("1 + 2".to_owned()))
        );
    }

    #[test]
    fn unknown_commands_are_rejected() {
        assert_eq!(
            ":nope".parse::<MetaCommand>(),
            Err("unknown command `:nope`; try :help".to_owned())
        );
    }
}
```

（这个文件里有两行文档注释，tag 里用了英文破折号，我这里换成了冒号；它们只是注释，你写成什么标点都行。）

几个值得看的地方：

- `line.strip_prefix(':')` 返回 `Option<&str>`，有前缀就去掉前缀返回剩下的，没有就是 `None`。配合 `let Some(rest) = ... else { return Err(...) };`，"不是命令"的情况一行搞定。
- `rest.split_once(char::is_whitespace)` 在第一个空白处把字符串切成两半。`char::is_whitespace` 是一个函数项，作为**模式**传给 `split_once`：标准库里凡是接受"模式"的方法，都能接受字符、字符串、字符切片或者 `FnMut(char) -> bool`。
- `match name { "quit" | "q" => ... }` 字符串上的或模式。`other => Err(...)` 捕获所有剩下的名字，并在错误信息里用上它。
- 在主循环里，`trimmed.parse::<MetaCommand>()` 返回 `Result<MetaCommand, String>`，一个 `match` 就分发完了：`Ok(MetaCommand::Quit) => break`，`Err(message) => eprintln!("pebble: {message}")`。
- `Err(ReadlineError::Interrupted | ReadlineError::Eof) => break` 是嵌套的或模式：Ctrl-C 和 Ctrl-D 都安静地退出。
- `let _ = editor.add_history_entry(line.as_str());` 里 `let _ =` 明确丢弃一个 `Result`，因为历史记录失败不值得中断会话。（`Result` 是 `#[must_use]` 的，直接丢弃编译器会警告。）
- `eval_line` 先试着把输入当**表达式**解析（`parse_expression`），成功就把它包进一个只含一条 `Stmt::Expr` 的 `Program`，求值并打印结果；否则当作一整个程序解析执行。所以你输入 `1 + 2` 直接得到 `3`，输入 `let x = 5;` 什么也不打印。
- 解释器在 `run` 里**只建一次**：`let mut interpreter = Interpreter::new();`，所以 `let x = 5;` 之后下一行还能用 `x`。

三个单元测试是为 `FromStr` 写的：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_has_a_short_form() {
        assert_eq!(":q".parse(), Ok(MetaCommand::Quit));
    }
    // ... arguments_are_kept_whole, unknown_commands_are_rejected
}
```

`assert_eq!(":q".parse(), Ok(MetaCommand::Quit))` 里不用写 turbofish：右边的类型让编译器推出 `parse::<MetaCommand>`。能这样比较是因为 `MetaCommand` 和 `String` 都实现了 `PartialEq`，所以 `Result<MetaCommand, String>` 也是。完整测试在上面那个文件里。

### 集成测试

`tests/cli.rs` 在第 7 篇的四个测试之外多了三个：`run_evaluates_fibonacci`、`run_reports_parse_errors_on_stderr`、`quiet_suppresses_the_final_value`。完整文件：

```rust
//! End-to-end tests for the `pebble` binary.
//!
//! The tests drive the real executable against the example programs in the
//! workspace's `examples/` directory, which is why every command runs with the
//! workspace root as its working directory.

use std::path::{Path, PathBuf};
use std::process::Output;

use assert_cmd::Command;
use predicates::prelude::*;

/// The workspace root, two levels above this crate.
fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// A `pebble` invocation rooted at the workspace, so `examples/...` resolves.
fn pebble() -> Command {
    let mut command = Command::cargo_bin("pebble").expect("the pebble binary is built");
    command.current_dir(workspace_root());
    command
}

/// Runs the binary with `args` and captures its output.
fn pebble_output(args: &[&str]) -> Output {
    pebble().args(args).output().expect("pebble runs")
}

#[test]
fn run_evaluates_fibonacci() {
    pebble()
        .args(["run", "examples/fib.pebble"])
        .assert()
        .success()
        .stdout(predicate::str::contains("6765"));
}

#[test]
fn run_reports_parse_errors_on_stderr() {
    pebble()
        .args(["run", "examples/errors.pebble"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("error"));
}

#[test]
fn parse_prints_the_syntax_tree() {
    pebble()
        .args(["parse", "examples/closures.pebble"])
        .assert()
        .success()
        .stdout(predicate::str::contains("fn"));
}

#[test]
fn tokens_prints_one_line_per_token() {
    let output = pebble_output(&["tokens", "examples/hello.pebble"]);
    assert!(output.status.success(), "tokens failed: {output:?}");

    let stdout = String::from_utf8(output.stdout).expect("stdout is UTF-8");
    let lines: Vec<&str> = stdout.lines().collect();
    assert!(!lines.is_empty(), "expected at least one token line");
    assert!(
        lines[0].contains(':') && lines[0].contains(' '),
        "expected `line:col kind`, got {first:?}",
        first = lines[0]
    );
}

#[test]
fn quiet_suppresses_the_final_value() {
    pebble()
        .args(["run", "--quiet", "examples/hello.pebble"])
        .assert()
        .success()
        .stdout(
            predicate::str::contains("hello, pebble!").and(predicate::str::contains("nil").not()),
        );
}

#[test]
fn check_is_silent_on_a_valid_file() {
    pebble()
        .args(["check", "examples/fib.pebble"])
        .assert()
        .success()
        .stdout(predicate::str::is_empty())
        .stderr(predicate::str::is_empty());
}

#[test]
fn unknown_subcommands_are_usage_errors() {
    pebble().arg("frobnicate").assert().code(2);
}
```

### 真实运行

```bash
cargo build -p pebble-cli
./target/debug/pebble run examples/closures.pebble
```

```text
$ pebble run examples/closures.pebble
1
2
3
$ pebble run examples/collections.pebble
[1, 4, 9, 16, 25]
fr -> Paris
jp -> Tokyo
de -> Berlin
3
$ pebble run examples/fib.pebble
6765
```

`closures.pebble` 的三行 `1 2 3` 就是 `make_counter` 那个闭包在三次调用里记住了状态。`collections.pebble` 里 map 遍历写成固定顺序的 `["fr", "jp", "de"]`，因为 `HashMap` 的内部顺序不保证，这是示例文件里一个故意的设计。

语法错误在运行之前就被拦下，退出码是 1：

```text
$ pebble run examples/errors.pebble
error[E1001]: expected an expression, found `;`
 --> examples/errors.pebble:5:17
  |
5 | let total = 1 + ;
  |                 ^
  |
```

运行时错误会带着调用栈。一个有两层调用的程序，文件是 `trace.pebble`：

```pebble
fn inner(x) {
    return x + missing;
}
fn outer(x) {
    return inner(x) * 2;
}
outer(1);
```

```text
$ pebble run trace.pebble
error[E2001]: undefined variable `missing`
 --> trace.pebble:2:16
  |
2 |     return x + missing;
  |                ^^^^^^^
  |
  = note: declare it first with `let`
  in `inner` at trace.pebble:5:12
  in `outer` at trace.pebble:7:1
```

每个 `in ... at` 是调用发生的位置，从最里面往外：`inner` 是在 `5:12` 被调用的（`outer` 的函数体里），`outer` 是在 `7:1` 被调用的（顶层）。这就是 `with_frame` 一层一层往上加的结果。

`pebble repl` 的一次会话（我把它输入重定向进去，所以提示符和输出交织在一起）：

```text
Pebble REPL. Type :help for commands, :quit to exit.
pebble> pebble> 10
pebble> expr
  binary +
    int 1
    int 2
pebble> pebble> 7
pebble> 1:1 1
1:3 `+`
1:5 2
1:6 end of file
pebble> pebble: unknown command `:nope`; try :help
pebble> 
```

`let x = 5;` 没有输出，`x * 2` 得到 `10`，`:ast 1 + 2;` 打印语法树，`fn f() { return 7; }` 没有输出，`f()` 得到 `7`，`:tokens 1 + 2` 逐个打印 token，`:nope` 报我们在 `FromStr` 里写的那句"unknown command"。

## 检查点

在 `/tmp/pebble-rebuild-09`（你的是 `~/pebble`）里运行：

```bash
cargo test -p pebble-interp
cargo test -p pebble-cli
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

```text
$ cargo test -p pebble-interp
test result: ok. 16 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
$ cargo test -p pebble-cli
running 3 tests
test repl::tests::arguments_are_kept_whole ... ok
test repl::tests::quit_has_a_short_form ... ok
test repl::tests::unknown_commands_are_rejected ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
running 7 tests
test unknown_subcommands_are_usage_errors ... ok
test run_reports_parse_errors_on_stderr ... ok
test check_is_silent_on_a_valid_file ... ok
test quiet_suppresses_the_final_value ... ok
test parse_prints_the_syntax_tree ... ok
test tokens_prints_one_line_per_token ... ok
test run_evaluates_fibonacci ... ok
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.06s
$ cargo clippy --workspace --all-targets -- -D warnings
    Checking pebble-cli v0.1.0 (/tmp/pebble-rebuild-09/crates/pebble-cli)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.41s
$ cargo fmt --all --check; echo "exit: $?"
exit: 0
```

`pebble-interp` 的 16 个测试，`pebble-cli` 的 3 个单元测试加 7 个集成测试，clippy 和 rustfmt 都干净。

下面这两个文件现在必须和 tag 逐字节相同：

- [`crates/pebble-interp/Cargo.toml`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-interp/Cargo.toml)
- [`crates/pebble-interp/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-interp/src/lib.rs)

```bash
for f in crates/pebble-interp/Cargo.toml crates/pebble-interp/src/lib.rs; do
  diff <(git -C /path/to/pebble show tutorial-v1:$f) $f && echo "same  $f"
done
```

```text
same  crates/pebble-interp/Cargo.toml
same  crates/pebble-interp/src/lib.rs
```

`examples/` 下的五个 `.pebble` 文件也和 tag 相同，它们在第 7 篇已经创建。

**中间文件**（还不是最终版，后面的篇章会继续改）：

- `crates/pebble-cli/` 下的全部七个文件：`Cargo.toml`、`src/main.rs`、`src/cli.rs`、`src/commands.rs`、`src/sources.rs`、`src/repl.rs`、`tests/cli.rs`。最终版本多出来的东西：字节码和反汇编（第 10 篇）、两个后端的 `Backend` trait、`--vm` 和 `bench`（第 12 篇）、并行的 `check`（第 14 篇）、可选的 `repl` 特性（第 15 篇）。其中 `src/repl.rs` 已经和 tag 一致（除了上面说的两行注释的标点），第 15 篇它只多出一个特性开关。
- 根 `Cargo.toml` 的 `[workspace.dependencies]`：现在列了 8 个内部 crate 加 `anyhow`、`clap`、`proc-macro2`、`quote`、`rustyline`、`syn`。

## 练习

**1. 加一个 `:env` 元命令。** 它应该列出全局环境里用户定义的名字。需要改哪些地方，会遇到什么障碍？（讨论题）

<details>
<summary>参考答案</summary>

`MetaCommand` 加一个 `Env` 变体，`from_str` 里加 `"env" => Ok(Self::Env)`，循环里加一个 `Ok(MetaCommand::Env) => show_env(&interpreter)` 分支。障碍在 `pebble-value`：`Env` 的 `values` 字段是私有的，只有 `get`、`contains_local`、`local_len` 这些方法，没有办法**枚举名字**。你要给 `Env` 加一个方法，比如 `pub fn names(&self) -> impl Iterator<Item = &str>`（第 8 篇的 `-> impl Iterator`），然后 REPL 里 `interpreter.globals().borrow().names()`。第二个障碍是内建函数也在全局环境里，不过滤的话 11 个 `print`、`len` 会淹没用户定义的名字，可以对每个名字 `get` 出来，跳过 `Value::Native`。由于 `HashMap` 的迭代顺序不确定，`:env` 的输出最好先排序。

</details>

**2. `fn f() {}` 单独一行会泄漏吗？** 先预测，再解释。顺便猜一下下面几个程序里哪些让全局环境泄漏。

<details>
<summary>参考答案</summary>

会泄漏：函数声明本身就把 `f` 放进了全局环境，`f` 的 `env` 又是全局环境，环和有没有调用、函数体里写什么无关。我用一个临时测试验证过，每个程序跑完、丢掉解释器之后，检查全局环境是否还活着（`Weak::upgrade().is_some()`）：

```text
fn f() {}                                                    leaks: true
let f = fn() { return 1; }; f();                             leaks: true
(fn() { return 1; })();                                      leaks: false
let x = [1, 2]; for i in x { print(i); }                     leaks: false
fn make() { return fn() { return 1; }; } let g = make();     leaks: true
let a = []; push(a, a);                                      leaks: false
```

第三行没有泄漏：匿名函数立刻被调用，调用完这个临时的函数值就被丢掉了，它从来没有放进任何环境里，所以没有环。第六行也显示 `false`，但别被骗了：`push(a, a)` 让列表包含它自己，这是另一个 `Rc` 环（`Rc<RefCell<Vec<Value>>>` 里装着指向自己的 `Rc`），泄漏的是那个列表，而全局环境本身没泄漏，我的检查只看全局环境。

</details>

**3. 让 `while` 支持 `break 值;`，整个 `while` 就变成一个有值的表达式。** 需要改哪些层？Rust 自己为什么只允许 `loop` 这么做？（讨论题）

<details>
<summary>参考答案</summary>

改动是纵向的：解析器要接受 `break` 后面跟一个可选表达式；AST 的 `Stmt::Break` 要带一个 `Option<Expr>`；`Flow::Break` 要带一个 `Option<Value>`（它现在是一个没有数据的变体）；解释器里 `Stmt::While` 分支遇到 `Break(v)` 要返回 `Flow::Value(v)` 而不是 `nil`；字节码编译器和 VM 也要跟上（第 10、12 篇）。最麻烦的是语法：`while` 是语句，不是表达式，要让它"有值"，要么把 `while` 提升成表达式，要么只让它的值出现在 `let x = while ... ;` 这样的位置。

Rust 把 `break 值` 限制在 `loop` 上，原因是 `loop` 只能通过 `break` 退出，每条出口都带着值，类型是确定的；`while cond { ... }` 还能因为条件变成 `false` 而自然结束，那条路径没有值可给，只能是 `()`，于是 `break 5` 的类型和"自然结束"的类型对不上。第 1 篇的 `loop { break value }` 就是这个设计。

</details>

解释器能跑了，闭包、递归、列表、映射都在，它也泄漏。还有几处我一眼就看出会贵的地方，只是现在还没量过：每次变量查找都要沿着 `HashMap<String, Value>` 的链走，每次函数调用分配一个 `Env`，每次执行 `fn` 语句复制一遍函数体。[下一篇](/posts/rust-by-pebble-10-bytecode-macros/)我们换一种做法：先把 AST 编译成一串线性的字节码指令，然后用一个循环去跑它。那时候你会看到 `macro_rules!`、回填，以及 `HashMap` 的 `entry` API 怎么让编译器给我们的标识符做去重。
