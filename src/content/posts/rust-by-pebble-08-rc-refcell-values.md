---
title: "共享与可变：Rc、RefCell 和运行时的值"
commentId: "post:rust-by-pebble-08-rc-refcell-values"
published: "2026-10-13 15:00:00 +08:00"
description: "let b = a; push(b, 1); a 必须显示 [1]。我们依次撞上移动、独占借用和 Rc 的墙，最后用 Rc<RefCell<..>> 搭出 pebble-value：值、可哈希的 Map 键、运行时错误、环境链和内建函数表，顺带学会 trait 对象、函数指针、Hash/Eq 契约。"
category: Note
tags:
  - Rust
  - Pebble
  - 智能指针
  - Rc
  - trait 对象
series: "用 Pebble 从零学 Rust"
seriesOrder: 8
draft: false
comment: true
slug: rust-by-pebble-08-rc-refcell-values
---

Pebble 里有一个我最先想写成测试的程序，只有四行：

```pebble
let a = [];
let b = a;
push(b, 1);
a;
```

最后一行必须得到 `[1]`。`a` 和 `b` 是同一个列表的两个名字，通过 `b` 改，`a` 就能看到。这在 Python 和 JavaScript 里是常识，没人会为此停下来想。在 Rust 里，这四行里的每一步都会撞上编译器：`let b = a` 是移动，`push` 要独占借用，两个名字想同时拥有一块数据，所有权模型直接说不。这一篇我们就是要绕过这堵墙，并且在绕的过程中把 `Rc`、`RefCell`、`HashMap`、trait 对象和函数指针一次学完。

> [!NOTE] 本篇检查点
> 这一篇我们从零写出 `pebble-value`，也就是 Pebble 运行时的对象模型：`Value` 枚举、可以做 Map 键的 `MapKey`、带调用栈的 `RuntimeError`、嵌套作用域 `Env`、内建函数表。你会用到的 Rust 特性：`Rc`、`Rc<str>`、`RefCell`、`HashMap` 与 `Hash`/`Eq` 契约、手写 `PartialEq`、`From`、函数指针、trait 对象 `dyn Output`、`static` 表、切片模式、`-> impl Iterator`。结束时 `cargo test -p pebble-value` 必须是 11 个测试全部通过，并且 `crates/pebble-value/` 下的两个文件与 tag 逐字节相同。上一篇是 [Result、? 与递归下降：解析器和第一个命令行](/posts/rust-by-pebble-07-parser-errors-cli/)，这一篇不依赖命令行，只依赖前面写好的 `pebble-span`、`pebble-diag`、`pebble-ast`。

## 先撞三面墙

我们把 Pebble 的列表先翻译成 Rust 里最自然的东西：`Vec<i64>`。第一次尝试，直接照字面写（`~/rust-lab/src/bin/ch08_shared_list_move.rs`）：

```rust
fn main() {
    let a: Vec<i64> = Vec::new();
    let b = a;
    let mut b = b;
    b.push(1);
    println!("{:?}", a);
}
```

`let b = a;` 在 Rust 里不是"让 b 也指向同一个列表"，而是把 `Vec` 的所有权搬给 `b`。第 2 篇讲过，这叫移动。编译器的反馈：

```text
$ cargo build --bin ch08_shared_list_move
   Compiling rust-lab v0.1.0 (/tmp/rust-lab)
error[E0382]: borrow of moved value: `a`
 --> src/bin/ch08_shared_list_move.rs:6:22
  |
2 |     let a: Vec<i64> = Vec::new();
  |         - move occurs because `a` has type `Vec<i64>`, which does not implement the `Copy` trait
3 |     let b = a;
  |             - value moved here
...
6 |     println!("{:?}", a);
  |                      ^ value borrowed here after move
  |
help: consider cloning the value if the performance cost is acceptable
  |
3 |     let b = a.clone();
  |              ++++++++

For more information about this error, try `rustc --explain E0382`.
error: could not compile `rust-lab` (bin "ch08_shared_list_move") due to 1 previous error
```

C++ 程序员在这里的第一反应是"那我用引用"。好，第二次尝试，用两个可变引用（`~/rust-lab/src/bin/ch08_shared_list_mut.rs`）：

```rust
fn main() {
    let mut a: Vec<i64> = Vec::new();
    let b = &mut a;
    let c = &mut a;
    b.push(1);
    c.push(2);
    println!("{:?}", a);
}
```

```text
$ cargo build --bin ch08_shared_list_mut
   Compiling rust-lab v0.1.0 (/tmp/rust-lab)
error[E0499]: cannot borrow `a` as mutable more than once at a time
 --> src/bin/ch08_shared_list_mut.rs:4:13
  |
3 |     let b = &mut a;
  |             ------ first mutable borrow occurs here
4 |     let c = &mut a;
  |             ^^^^^^ second mutable borrow occurs here
5 |     b.push(1);
  |     - first borrow later used here

For more information about this error, try `rustc --explain E0499`.
error: could not compile `rust-lab` (bin "ch08_shared_list_mut") due to 1 previous error
```

这是第 2 篇的"别名与可变不能同时存在"，原样撞上。借用解决不了问题，因为借用有生命周期：`b` 和 `c` 都得在某个作用域里结束。而 Pebble 的两个变量可以活得一样久，谁先死谁后死由程序决定。我们需要的是**共同所有权**：两个所有者，最后一个离开时才释放。

C++ 里这个东西叫 `std::shared_ptr`。Rust 标准库里对应的是 `Rc<T>`（reference counted）。第三次尝试（`~/rust-lab/src/bin/ch08_shared_list_rc.rs`）：

```rust
use std::rc::Rc;

fn main() {
    let a: Rc<Vec<i64>> = Rc::new(Vec::new());
    let b = Rc::clone(&a);
    b.push(1);
    println!("{:?}", a);
}
```

```text
$ cargo build --bin ch08_shared_list_rc
   Compiling rust-lab v0.1.0 (/tmp/rust-lab)
error[E0596]: cannot borrow data in an `Rc` as mutable
 --> src/bin/ch08_shared_list_rc.rs:6:5
  |
6 |     b.push(1);
  |     ^ cannot borrow as mutable
  |
  = help: trait `DerefMut` is required to modify through a dereference, but it is not implemented for `Rc<Vec<i64>>`

For more information about this error, try `rustc --explain E0596`.
error: could not compile `rust-lab` (bin "ch08_shared_list_rc") due to 1 previous error
```

`Rc::clone(&a)` 不复制列表，只把引用计数加一，然后返回一个新的 `Rc`，指向同一块堆内存。这一步成功了。失败的是 `b.push(1)`：`Rc<T>` 只给你 `&T`，从不给 `&mut T`。原因很直接：如果两个所有者都能拿到 `&mut T`，那就把刚才的 E0499 从编译期搬到了运行期，并且没人检查。

`shared_ptr<vector<int>>` 在 C++ 里允许你随便写，迭代到一半被另一个别名 `push_back` 导致迭代器失效，那是你自己的事（UB）。Rust 的选择更保守：共享的所有权默认只读，要想写，你得显式地走一个"带检查的后门"。这个后门叫 `RefCell<T>`。

`~/rust-lab/src/bin/ch08_shared_list.rs`：

```rust
use std::cell::RefCell;
use std::rc::Rc;

fn main() {
    let a: Rc<RefCell<Vec<i64>>> = Rc::new(RefCell::new(Vec::new()));
    let b = Rc::clone(&a);
    println!("strong count: {}", Rc::strong_count(&a));
    b.borrow_mut().push(1);
    a.borrow_mut().push(2);
    println!("a = {:?}", a.borrow());
    println!("b = {:?}", b.borrow());
    println!("same allocation: {}", Rc::ptr_eq(&a, &b));
    drop(b);
    println!("strong count after drop(b): {}", Rc::strong_count(&a));
}
```

```text
$ cargo run --quiet --bin ch08_shared_list
strong count: 2
a = [1, 2]
b = [1, 2]
same allocation: true
strong count after drop(b): 1
```

类型 `Rc<RefCell<Vec<i64>>>` 读起来像俄罗斯套娃，但每一层只做一件事：

- `Vec<i64>`：数据本身。
- `RefCell<..>`：在数据旁边放一个借用计数，`borrow()` 返回只读守卫 `Ref`，`borrow_mut()` 返回独占守卫 `RefMut`。
- `Rc<..>`：在外面再加一个引用计数，让多个所有者共享。

`RefCell` 的规则和第 2 篇的编译期规则完全一样：多个只读，或者一个独占，二选一。区别只是检查的时间。编译器没法知道运行时谁会来，所以它在"进门时"翻一下牌子（那个计数）：牌子显示有人在读，你想写，就当场 panic。

`~/rust-lab/src/bin/ch08_refcell_panic.rs`：

```rust
use std::cell::RefCell;

fn main() {
    let cell = RefCell::new(vec![1, 2, 3]);
    let reader = cell.borrow();
    println!("try_borrow_mut while reading: {:?}", cell.try_borrow_mut().is_err());
    println!("first = {}", reader[0]);
    cell.borrow_mut().push(4);
    println!("unreachable");
}
```

```text
$ cargo run --quiet --bin ch08_refcell_panic
try_borrow_mut while reading: true
first = 1

thread 'main' (89899) panicked at src/bin/ch08_refcell_panic.rs:8:10:
RefCell already borrowed
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
```

第一行 `true` 是 `try_borrow_mut()`：它不 panic，而是返回 `Result`，让你自己决定怎么办。第二次 `borrow_mut()` 没有这个礼貌，直接 panic，`reader` 这个 `Ref` 守卫还活着，所以计数没归零。这个 panic 不是内存不安全，是 Rust 在说"你的程序逻辑违反了别名规则"。第 9 篇里解释器在遍历列表的同时修改它时，会再撞上它一次。

还有两点要提前交代，免得你在后面的代码里被吓到：

- `Rc` 的计数是**非原子**的，所以它不能跨线程（C++ 的 `shared_ptr` 计数永远是原子的，哪怕你用不上）。Rust 会在类型层面禁止你把 `Rc` 送到另一个线程，这是第 14 篇的内容。
- `RefCell` 里的计数在 clippy 的报错里会露面一次（`Cell<isize>`）。`Cell` 是第 11 篇的主角，这里先当成"能在 `&self` 下修改的整数"。

## 新建 pebble-value

我们已经有了 `pebble-span`、`pebble-diag`、`pebble-lexer`、`pebble-ast`、`pebble-macros`、`pebble-parser` 六个 crate。按第 1 篇的步骤新建第七个：

```bash
cargo new --lib crates/pebble-value
```

把它登记到根 `Cargo.toml` 的 `[workspace.dependencies]` 里，放在 `pebble-parser` 那一行后面（这一行必须和 tag 里的一样，因为到了第 9 篇，解释器要通过 `workspace = true` 引用它）：

```toml
pebble-value = { path = "crates/pebble-value", version = "0.1.0" }
```

`crates/pebble-value/Cargo.toml` 的完整内容如下，和 [tag 里的文件](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-value/Cargo.toml) 一致：

```toml
[package]
name = "pebble-value"
description = "Runtime values for the Pebble tree-walking interpreter."
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

[lints]
workspace = true
```

它依赖三个我们自己写的 crate：`pebble-span` 提供 `Span`，`pebble-diag` 提供 `Diagnostic`，`pebble-ast` 提供 `Stmt`（函数值要保存它的函数体，而函数体就是一串语句）。注意依赖方向：`value` 依赖 `ast`，所以 `ast` 永远不知道运行时是什么。

## Value：第一版

`Value` 是 Pebble 里每个变量、每个表达式结果的类型。我们按文件顺序写，但分五轮（Value、Map、运算符、Env、内建函数，各占一节）：先写能编译的最小版本，每一轮加一类东西，每一轮都跑测试。第一轮只有不需要哈希、不需要环境、不需要函数的六种值。

`crates/pebble-value/src/lib.rs` 的第一版开头如下。先把 `cargo new --lib` 生成的 `src/lib.rs`（一个示例函数加一个测试）整个清空，再写属性和 `use`。文件头的完整注释放到最后一步再补；下面这组 `use` 是 tag 里的完整版本，一次写全，省得后面每一轮回来补。`HashMap`、`Hash`/`Hasher`、`Span`、`Diagnostic` 要到后面的轮次才会用到，那之前编译器会报 "unused import" 警告，不用管：

```rust
#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::rc::Rc;

use pebble_diag::Diagnostic;
use pebble_span::Span;
```

然后是枚举本身：

```rust
/// A Pebble runtime value.
///
/// Heap-allocated variants share through [`Rc`]; the mutable ones wrap their
/// contents in [`RefCell`] so mutation is checked at run time rather than at
/// compile time.
#[derive(Clone)]
pub enum Value {
    /// `nil`
    Nil,
    /// `true` / `false`
    Bool(bool),
    /// A 64-bit signed integer.
    Int(i64),
    /// A 64-bit float.
    Float(f64),
    /// An immutable, shared string.
    Str(Rc<str>),
    /// A mutable, shared list.
    List(Rc<RefCell<Vec<Value>>>),
}
```

三个没见过的写法：

- `Rc<str>` 是不可变的共享字符串。`str` 是第 2 篇的"字符串切片"本体（没有长度信息的动态大小类型），`Rc<str>` 把字符数据和引用计数放在同一块堆内存里。对比 `Rc<String>`：那会有两层间接（先到 `String` 的三个字，再到它的缓冲区）。
- `Rc<RefCell<Vec<Value>>>` 就是我们上面实验里的套娃，元素类型换成了 `Value` 自己。`Value` 里面有 `Vec<Value>`，没有无限大小问题，因为 `Vec` 把元素放在堆上，自身只占三个字（指针、容量、长度）。第 5 篇讲过，递归类型需要一层间接，`Vec` 和 `Rc` 都算。
- `#[derive(Clone)]` 但没有 `Copy`。克隆一个 `Value::List` 只是把引用计数加一，不会复制列表。对 C++ 程序员来说，这等于 `shared_ptr` 的拷贝构造，而不是 `vector` 的。

我在实验里量过这几个类型的大小（`~/rust-lab/src/bin/ch08_rc_str.rs`）：

```rust
use std::mem::size_of;
use std::rc::Rc;

fn main() {
    let owned: String = String::from("pebble");
    let shared: Rc<str> = Rc::from(owned.as_str());
    let other = Rc::clone(&shared);
    println!("size_of::<String>():   {}", size_of::<String>());
    println!("size_of::<Rc<str>>():  {}", size_of::<Rc<str>>());
    println!("size_of::<Rc<String>>(): {}", size_of::<Rc<String>>());
    println!("len = {}, same = {}, count = {}", shared.len(), Rc::ptr_eq(&shared, &other), Rc::strong_count(&shared));
    let upper: &str = &shared;
    println!("{}", upper.to_uppercase());
}
```

```text
$ cargo run --quiet --bin ch08_rc_str
size_of::<String>():   24
size_of::<Rc<str>>():  16
size_of::<Rc<String>>(): 8
len = 6, same = true, count = 2
PEBBLE
```

`Rc<str>` 是 16 字节（指针加长度，叫胖指针），`Rc<String>` 是 8 字节但要多跳一次。Pebble 的字符串是创建后不再修改的，所以我们选了前者：`Value::Str` 克隆起来是 O(1)，`len` 不需要跳转。在 tag 的 worktree 里加一个临时测试，量出整个 `Value` 是 24 字节：16 字节给最大的成员 `Rc<str>`，剩下 8 字节是判别标记（连同对齐填充）。第 2 篇说过 `enum` 在 Rust 里是带标签的联合体，这就是账单。

接下来是 `impl Value`。每个方法都很短：

```rust
impl Value {
    /// Builds a string value.
    #[must_use]
    pub fn string(text: impl Into<Rc<str>>) -> Self {
        Value::Str(text.into())
    }

    /// Builds a list value.
    #[must_use]
    pub fn list(items: Vec<Value>) -> Self {
        Value::List(Rc::new(RefCell::new(items)))
    }

    /// The value's type name, as `type()` reports it.
    #[must_use]
    pub const fn type_name(&self) -> &'static str {
        match self {
            Value::Nil => "nil",
            Value::Bool(_) => "bool",
            Value::Int(_) => "int",
            Value::Float(_) => "float",
            Value::Str(_) => "string",
            Value::List(_) => "list",
        }
    }

    /// Truthiness: only `nil` and `false` are falsy.
    #[must_use]
    pub const fn is_truthy(&self) -> bool {
        !matches!(self, Value::Nil | Value::Bool(false))
    }

    /// The language `==` operator.
    ///
    /// Numbers compare across `int`/`float`; strings compare by contents;
    /// everything else (lists, maps, functions) compares by identity, so two
    /// equal-looking lists are *not* `==` unless they are the same list.
    #[must_use]
    pub fn equals(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Nil, Value::Nil) => true,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            (Value::Int(a), Value::Int(b)) => a == b,
            (Value::Int(a), Value::Float(b)) | (Value::Float(b), Value::Int(a)) => {
                (*a as f64) == *b
            }
            (Value::Float(a), Value::Float(b)) => a == b,
            (Value::Str(a), Value::Str(b)) => a == b,
            (Value::List(a), Value::List(b)) => Rc::ptr_eq(a, b),
            _ => false,
        }
    }
}
```

逐个看：

- `string(text: impl Into<Rc<str>>)` 和第 2 篇的 `SourceMap::add` 是同一个写法：参数可以是任何能转成 `Rc<str>` 的东西，`&str`、`String`、已经有的 `Rc<str>` 都行。
- `type_name` 和 `is_truthy` 是 `const fn`，因为它们只是读判别标记。`matches!` 是第 7 篇见过的宏，`!matches!(self, Value::Nil | Value::Bool(false))` 读作"既不是 nil，也不是 false"。
- `equals` 是 Pebble 语言里的 `==`。它的 `(Value::Int(a), Value::Float(b)) | (Value::Float(b), Value::Int(a))` 是一个或模式：两个分支绑定相同名字、相同类型，所以右边的表达式可以共用。`*a as f64` 的 `*` 是因为 `a` 是 `&i64`（模式匹配 `&self` 时按引用绑定），`as` 是第 1 篇的显式转换。
- 列表用 `Rc::ptr_eq` 比较，也就是比地址。如果这里写成 `a == b`，`Rc<T>` 的 `==` 会去比较 `T` 的**内容**，那样两个内容相同的列表就相等了。Pebble 的语义是"同一个列表才相等"，所以必须显式要求身份比较。字符串那行 `a == b` 比的是内容，这正是我们要的。

标准库的 `==` 是 `PartialEq` trait。我们让它转发给 `equals`：

```rust
impl PartialEq for Value {
    fn eq(&self, other: &Self) -> bool {
        self.equals(other)
    }
}
```

为什么不 `#[derive(PartialEq)]`？因为派生会逐字段递归，列表就按内容比较了，和 `equals` 的语义对不上。为什么只是 `PartialEq` 而不是 `Eq`？因为 `Value::Float(f64::NAN) == Value::Float(f64::NAN)` 是 `false`，`Eq` 要求自反（`a == a` 永远成立），NaN 不满足。这个区别马上会在 Map 的键上咬我们。

再加几个 `From`，让 `1.into()` 和 `"x".into()` 都能变成 `Value`：

```rust
impl From<i64> for Value {
    fn from(value: i64) -> Self {
        Value::Int(value)
    }
}

impl From<f64> for Value {
    fn from(value: f64) -> Self {
        Value::Float(value)
    }
}

impl From<bool> for Value {
    fn from(value: bool) -> Self {
        Value::Bool(value)
    }
}

impl From<&str> for Value {
    fn from(value: &str) -> Self {
        Value::Str(Rc::from(value))
    }
}

impl From<String> for Value {
    fn from(value: String) -> Self {
        Value::Str(Rc::from(value.as_str()))
    }
}
```

`From<String>` 里 `Rc::from(value.as_str())` 会把字符复制一遍：`Rc<str>` 的引用计数和字符数据必须在同一块内存里，`String` 的缓冲区没法原地改造。这是 O(n)，但每个字符串字面量只付一次。

最后是打印。Pebble 里 `print([1, "a"])` 应该显示 `[1, "a"]`：顶层字符串不带引号，嵌套在列表里的带引号。所以一个递归函数需要知道自己是不是在"嵌套里"，还要防止自己包含自己的列表把栈打爆：

```rust
/// Renders a value, guarding against cycles in self-referential lists.
fn write_value(
    f: &mut fmt::Formatter<'_>,
    value: &Value,
    depth: usize,
    quoted: bool,
) -> fmt::Result {
    const MAX_DEPTH: usize = 4;
    match value {
        Value::Nil => f.write_str("nil"),
        Value::Bool(inner) => write!(f, "{inner}"),
        Value::Int(inner) => write!(f, "{inner}"),
        Value::Float(inner) => {
            if inner.is_finite() && inner.fract() == 0.0 {
                write!(f, "{inner:.1}")
            } else {
                write!(f, "{inner}")
            }
        }
        Value::Str(inner) => {
            if quoted {
                write!(f, "{inner:?}")
            } else {
                f.write_str(inner)
            }
        }
        Value::List(items) => {
            if depth >= MAX_DEPTH {
                return f.write_str("[...]");
            }
            f.write_str("[")?;
            for (index, item) in items.borrow().iter().enumerate() {
                if index > 0 {
                    f.write_str(", ")?;
                }
                write_value(f, item, depth + 1, true)?;
            }
            f.write_str("]")
        }
    }
}
```

```rust
impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write_value(f, self, 0, false)
    }
}

impl fmt::Debug for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write_value(f, self, 0, true)
    }
}
```

`write_value` 里有几个格式化小技巧，第 3 篇的格式语法都在：`{inner:?}` 是 `Debug` 格式，对 `Rc<str>` 会带引号并转义；`{inner:.1}` 是一位小数，所以整数值的浮点数会显示成 `2.0` 而不是 `2`。`Display` 和 `Debug` 共用一个函数，只有 `quoted` 不同，这样 `print` 和 `{:?}` 的行为不会走样。

注意 `items.borrow()` 在整个 `for` 循环期间都持有守卫。这没问题，因为递归里全是只读的 `borrow()`，多个读者可以共存。但它引出一个问题：如果列表包含它自己呢？我们先来写那四行的 Rust 版本，再顺便试一下。

在 `lib.rs` 末尾加一个**临时**测试（跑完就删掉，后面不再出现）：

```rust

#[cfg(test)]
mod scratch {
    use super::*;

    #[test]
    fn clones_share_one_list() {
        let a = Value::list(vec![]);
        let b = a.clone();
        if let Value::List(items) = &b {
            items.borrow_mut().push(Value::Int(1));
        }
        println!("a = {a}");
        println!("b = {b}");
        println!("a == b: {}", a.equals(&b));
        if let Value::List(items) = &a {
            items.borrow_mut().push(a.clone());
        }
        println!("cyclic = {a}");
    }
}
```

```text
$ cargo test -p pebble-value clones_share -- --nocapture
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.01s
     Running unittests src/lib.rs (target/debug/deps/pebble_value-8a12146cf753ccc2)

running 1 test
a = [1]
b = [1]
a == b: true
cyclic = [1, [1, [1, [1, [...]]]]]
test scratch::clones_share_one_list ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s
```

`a` 和 `b` 是同一个列表，`b` 里 push 的 1，在 `a` 里看得见，开头那个四行程序的核心行为我们已经有了。`a == b` 是 `true`，因为它们是同一个 `Rc`。最后一行 `cyclic` 是把 `a` 放进它自己：列表里套着列表，一路套下去，`write_value` 在深度 4 处停下，打印 `[...]`。如果没有 `MAX_DEPTH`，这就是一个栈溢出。

> [!NOTE] 这里藏着一个内存泄漏
> `a` 里放了一个指向 `a` 自己的 `Rc`，引用计数永远不会归零。这个列表会一直活到进程结束。Rc 的引用计数没有办法回收环，这是它和垃圾回收器（第 11 篇）最本质的区别。这个问题会在第 9 篇再次出现，而且那次不是故意的。

删掉临时测试，换上第一轮真正的测试，它是前面那个断言的正式版：

```rust
// 在 lib.rs 末尾
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_identity_not_structure_for_equality() {
        let a = Value::list(vec![Value::Int(1)]);
        let b = Value::list(vec![Value::Int(1)]);
        assert!(!a.equals(&b));
        assert!(a.equals(&a.clone()));
    }
}
```

```text
$ cargo test -p pebble-value
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.02s
     Running unittests src/lib.rs (target/debug/deps/pebble_value-8a12146cf753ccc2)

running 1 test
test tests::list_identity_not_structure_for_equality ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests pebble_value

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

一个测试通过。两个不同列表即使内容相同也不 `equals`，同一个列表的克隆 `equals`，这是 `Rc::ptr_eq` 的行为。

## Map，和 Hash/Eq 的契约

Pebble 有映射 `#{"a": 1}`，键可以是任何值。Rust 里对应的类型是 `HashMap<K, V>`，要求 `K: Eq + Hash`。C++ 的 `unordered_map` 同样需要 `operator==` 和 `std::hash`，只是 C++ 在你忘了的时候给你一屏模板错误，而且契约本身（相等的值必须有相同的哈希）从来不被检查。

最省事的做法是在 `Value` 上 `#[derive(Hash, Eq)]`。我们先试一下，一个更小的例子（`~/rust-lab/src/bin/ch08_derive_hash.rs`）：

```rust
#[derive(Hash, PartialEq, Eq)]
enum Key {
    Int(i64),
    Float(f64),
}

fn main() {
    let _ = Key::Int(1);
    let _ = Key::Float(1.0);
}
```

```text
$ cargo build --bin ch08_derive_hash
   Compiling rust-lab v0.1.0 (/tmp/rust-lab)
error[E0277]: the trait bound `f64: Hash` is not satisfied
 --> src/bin/ch08_derive_hash.rs:4:11
  |
1 | #[derive(Hash, PartialEq, Eq)]
  |          ---- in this derive macro expansion
...
4 |     Float(f64),
  |           ^^^ the trait `Hash` is not implemented for `f64`
  |
  = help: the following other types implement trait `Hash`:
            i128
            i16
            i32
            i64
            i8
            isize
            u128
            u16
          and 4 others

error[E0277]: the trait bound `f64: Eq` is not satisfied
 --> src/bin/ch08_derive_hash.rs:4:11
  |
1 | #[derive(Hash, PartialEq, Eq)]
  |                           -- in this derive macro expansion
...
```

`f64` 既不是 `Hash` 也不是 `Eq`。这不是标准库偷懒，是浮点数真的不满足契约：`NaN != NaN`，`Eq` 要求自反；`0.0 == -0.0` 但位模式不同，哈希要么违反"相等则哈希相同"，要么违反"位模式不同则哈希不同"，二选一。

我们的解法有两步。

**第一步：用一个新类型包住 `Value`。** 为什么不直接给 `Value` 实现 `Eq` 和 `Hash`？因为 `Value` 已经是 `PartialEq` 了，它的 `==` 是语言里的 `==`（`NaN != NaN`）。键需要的是另一种相等：自反的、`NaN` 等于 `NaN` 的。一个类型不能有两种 `==`，所以做两个类型。这个模式叫 newtype（第 1 篇的元组结构体 `SourceId` 同款）。

**第二步：两个私有方法定义"键相等"和"键哈希"，让它们互相一致。** 先加 Map 变体（放在 `List` 后面）和构造函数：

```rust
    /// A mutable, shared map.
    Map(Rc<RefCell<HashMap<MapKey, Value>>>),
```

```rust
    /// Builds an empty map value.
    #[must_use]
    pub fn map() -> Self {
        Value::Map(Rc::new(RefCell::new(HashMap::new())))
    }
```

`type_name` 加一行 `Value::Map(_) => "map",`，`equals` 里加一行 `(Value::Map(a), Value::Map(b)) => Rc::ptr_eq(a, b),`，`write_value` 在 `List` 分支后加 `Map` 分支：

```rust
        Value::Map(entries) => {
            if depth >= MAX_DEPTH {
                return f.write_str("#{...}");
            }
            f.write_str("#{")?;
            for (index, (key, item)) in entries.borrow().iter().enumerate() {
                if index > 0 {
                    f.write_str(", ")?;
                }
                write_value(f, &key.0, depth + 1, true)?;
                f.write_str(": ")?;
                write_value(f, item, depth + 1, true)?;
            }
            f.write_str("}")
        }
```

`key_eq` 和 `key_hash` 放在 `impl Value` 里，紧接在 `equals` 的后面：

```rust
    /// Equality used for map keys.
    ///
    /// Differs from [`Value::equals`] in one place: floats compare by bits, so
    /// `NaN` is a usable, reflexive key. That is what `Eq` requires and what a
    /// `HashMap` needs.
    fn key_eq(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Float(a), Value::Float(b)) => a.to_bits() == b.to_bits(),
            _ => self.equals(other),
        }
    }
```

```rust
    /// Hashing consistent with [`Value::key_eq`].
    fn key_hash<H: Hasher>(&self, state: &mut H) {
        match self {
            Value::Nil => 0u8.hash(state),
            Value::Bool(value) => {
                1u8.hash(state);
                value.hash(state);
            }
            Value::Int(value) => {
                2u8.hash(state);
                value.hash(state);
            }
            Value::Float(value) => {
                3u8.hash(state);
                value.to_bits().hash(state);
            }
            Value::Str(value) => {
                4u8.hash(state);
                value.hash(state);
            }
            Value::List(value) => {
                5u8.hash(state);
                Rc::as_ptr(value).hash(state);
            }
            Value::Map(value) => {
                6u8.hash(state);
                Rc::as_ptr(value).hash(state);
            }
        }
    }
```

几个值得停下来看的地方（有一处例外这里先不说，练习 2 会让你找到它）：

- 浮点数按位比较、按位哈希：`a.to_bits() == b.to_bits()`。`NaN` 的位模式是确定的，所以 `NaN` 现在是个自反的键。`0.0` 和 `-0.0` 位模式不同，所以是两个不同的键，这和 `==` 不一致，但对键而言是可以接受的。
- 每个变体先哈希一个小整数（`0u8`、`1u8`……）作为判别标记，再哈希内容。不加的话，`Int(1)` 和 `Bool(true)` 可能哈希相同。冲突不违反契约，但会让桶变得拥挤。
- 列表、Map 用 `Rc::as_ptr(value).hash(state)`：哈希**地址**，不是内容。原因和 `equals` 一致：键相等是"同一个对象"，哈希必须和它对齐。如果哈希内容，那么往作为键的列表里 `push` 一个元素，它的哈希就变了，`HashMap` 再也找不到它。这不是推理，我写了一个实验验证（`~/rust-lab/src/bin/ch08_mutable_key.rs`）：

```rust
use std::cell::RefCell;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::rc::Rc;

struct ByContents(Rc<RefCell<Vec<i64>>>);

impl PartialEq for ByContents {
    fn eq(&self, other: &Self) -> bool {
        *self.0.borrow() == *other.0.borrow()
    }
}

impl Eq for ByContents {}

impl Hash for ByContents {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.0.borrow().hash(state);
    }
}

fn main() {
    let list = Rc::new(RefCell::new(vec![1]));
    let mut map = HashMap::new();
    map.insert(ByContents(Rc::clone(&list)), "one");
    println!("before push: {:?}", map.get(&ByContents(Rc::clone(&list))));
    list.borrow_mut().push(2);
    println!("after push:  {:?}", map.get(&ByContents(Rc::clone(&list))));
    println!("entries: {}", map.len());
}
```

```text
$ cargo run --quiet --bin ch08_mutable_key
before push: Some("one")
after push:  None
entries: 1
```

`push` 之后同一个列表对象查不到自己了，而且那个条目留在表里无法删除，`len` 还是 1。这是"可变键"的经典事故。C++ 里 `unordered_set<vector<int>*>` 之类的写法不会出这个事，因为你哈希的是指针本身。我们的 `Rc::as_ptr` 做的就是同样的事。

然后是包装类型本身：

```rust
/// A map key: a [`Value`] with a reflexive `Eq`/`Hash` implementation.
#[derive(Clone)]
pub struct MapKey(pub Value);

impl MapKey {
    /// Borrows the underlying value.
    #[must_use]
    pub fn value(&self) -> &Value {
        &self.0
    }
}

impl PartialEq for MapKey {
    fn eq(&self, other: &Self) -> bool {
        self.0.key_eq(&other.0)
    }
}

impl Eq for MapKey {}

impl Hash for MapKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.0.key_hash(state);
    }
}

impl From<Value> for MapKey {
    fn from(value: Value) -> Self {
        MapKey(value)
    }
}
```

`pub struct MapKey(pub Value)` 是元组结构体。`impl Eq for MapKey {}` 是一个空的"标记 trait"实现：`Eq` 没有方法，它只是向编译器声明"我保证 `PartialEq` 是自反的"。这是个承诺而不是代码，编译器无法验证它，但因为 `key_eq` 里浮点数按位比较，我们能自己验证。

如果漏掉这一行，错误来得很直接：

```text
$ cargo test -p pebble-value
   Compiling pebble-value v0.1.0 (/tmp/pebble-rebuild-08/crates/pebble-value)
error[E0277]: the trait bound `MapKey: Eq` is not satisfied
   --> crates/pebble-value/src/lib.rs:293:13
    |
293 |         map.insert(MapKey(Value::Float(f64::NAN)), Value::Int(1));
    |             ^^^^^^ unsatisfied trait bound
    |
help: the trait `Eq` is not implemented for `MapKey`
   --> crates/pebble-value/src/lib.rs:248:1
    |
248 | pub struct MapKey(pub Value);
    | ^^^^^^^^^^^^^^^^^
note: required by a bound in `std::collections::HashMap::<K, V, S, A>::insert`
...
```

测试放在 `list_identity_not_structure_for_equality` 后面（第一轮写的那个）：

```rust
    #[test]
    fn map_keys_survive_nan_and_lists() {
        let mut map = HashMap::new();
        map.insert(MapKey(Value::Float(f64::NAN)), Value::Int(1));
        map.insert(MapKey(Value::list(vec![])), Value::Int(2));
        // A fresh NaN key must find the stored entry thanks to bitwise hashing.
        assert_eq!(
            map.get(&MapKey(Value::Float(f64::NAN))),
            Some(&Value::Int(1))
        );
        assert_eq!(map.len(), 2);
    }
```

这个测试一口气验证三件事：`NaN` 作键能找回自己，空列表作键没问题，两个键共存。

```text
$ cargo test -p pebble-value
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.01s
     Running unittests src/lib.rs (target/debug/deps/pebble_value-8a12146cf753ccc2)

running 2 tests
test tests::list_identity_not_structure_for_equality ... ok
test tests::map_keys_survive_nan_and_lists ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests pebble_value

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

### clippy 的一次抗议

仓库的 CI 对所有 target 跑 `cargo clippy -- -D warnings`，我们的 workspace 把 `clippy::all` 设成 warn。在这个阶段跑一下：

```text
$ cargo clippy -p pebble-value --all-targets -- -D warnings
    Checking pebble-value v0.1.0 (/tmp/pebble-rebuild-08/crates/pebble-value)
error: mutable key type
   --> crates/pebble-value/src/lib.rs:293:9
    |
293 |         let mut map = HashMap::new();
    |         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |
    = note: ... because it contains `MapKey`, which has interior mutability
    = note: ... because it contains `Value`, which has interior mutability
    = note: ... because it contains `Rc<RefCell<Vec<Value>>>`, which has interior mutability
    = note: ... because it contains `RefCell<Vec<Value>>`, which has interior mutability
    = note: ... because it contains `Cell<isize>`, which has interior mutability
    = note: ... because it contains `UnsafeCell<isize>`, which has interior mutability
    = help: for further information visit https://rust-lang.github.io/rust-clippy/master/index.html#mutable_key_type
    = note: `-D clippy::mutable-key-type` implied by `-D warnings`
    = help: to override `-D warnings` add `#[allow(clippy::mutable_key_type)]`

error: could not compile `pebble-value` (lib test) due to 1 previous error
```

clippy 的 `mutable_key_type` 检查认为：键的类型里有内部可变性（那一串 `because it contains` 一路追到了 `RefCell` 里的计数器 `Cell<isize>`），所以键的哈希可能会在表里悄悄变化。这个规则在一般情况下完全正确，上面的实验就是活生生的例子。但我们的 `MapKey` 偏偏做对了：可变的东西哈希地址，其余的变体本身不可变。所以这条 lint 在这里是误报，应该关掉，并且写清楚为什么。

我在 tag 的 worktree 里把这行 `allow` 删掉试过：`cargo clippy -p pebble-value` 对库代码没有意见，只有 `--all-targets` 时测试里的 `HashMap::new()` 触发它。所以更窄的做法是把 `#[allow]` 只放在那个测试函数上。tag 选择的是整个 crate 一次关掉，我们照抄，好让文件逐字节一致。无论哪种，规则是：`#[allow]` 必须带一句"为什么"。tag 里的这段在文件最顶部，等一下补文件头时会一起写进去：

```rust
// Maps are keyed by `MapKey`, which wraps a `Value`. Clippy warns about
// interior-mutable key types, but our hashing is stable by construction:
// mutable values (lists, maps, closures) hash by pointer identity, and the
// scalar variants are immutable. See `Value::key_hash`.
#![allow(clippy::mutable_key_type)]
```

## 运算符：add、numeric 和 compare

Pebble 的 `+` 有三种含义：数字相加、字符串拼接、列表拼接。其他运算符只处理数字。我们先写 `add`，因为它包含所有套路：

```rust
/// `lhs + rhs` with number/string/list overloading.
pub fn add(lhs: &Value, rhs: &Value, span: Span) -> Result<Value, RuntimeError> {
    match (lhs, rhs) {
        (Value::Int(a), Value::Int(b)) => a
            .checked_add(*b)
            .map(Value::Int)
            .ok_or_else(|| overflow(span)),
        (Value::Int(a), Value::Float(b)) => Ok(Value::Float(*a as f64 + b)),
        (Value::Float(a), Value::Int(b)) => Ok(Value::Float(a + *b as f64)),
        (Value::Float(a), Value::Float(b)) => Ok(Value::Float(a + b)),
        (Value::Str(a), Value::Str(b)) => {
            let mut text = String::with_capacity(a.len() + b.len());
            text.push_str(a);
            text.push_str(b);
            Ok(Value::string(text))
        }
        (Value::List(a), Value::List(b)) => {
            let mut items = a.borrow().clone();
            items.extend(b.borrow().iter().cloned());
            Ok(Value::list(items))
        }
        _ => Err(TypeError::binary("+", lhs, rhs).into_error(span)),
    }
}
```

读这个函数你会碰到几个 Rust 惯用写法：

- `match (lhs, rhs)`：把两个值打包成元组再匹配，C++ 里要写两层 `switch` 或者 `std::visit` 配 `overloaded`。
- `a.checked_add(*b)` 返回 `Option<i64>`：溢出时是 `None`。第 1 篇说过 debug 构建里溢出会 panic、release 里回绕，两种都不是我们想要的，`checked_*` 让溢出成为普通的错误值。`.map(Value::Int)` 里 `Value::Int` 本身就是一个函数 `fn(i64) -> Value`，可以直接传给 `map`。`.ok_or_else(|| overflow(span))` 把 `None` 变成 `Err`，闭包只在需要时才执行。
- 字符串拼接先 `String::with_capacity(a.len() + b.len())`，一次分配，然后 `push_str`；`a` 是 `&Rc<str>`，`push_str` 期望 `&str`，编译器自动解引用（`Rc<str>` → `str`）。
- 列表拼接 `a.borrow().clone()`：`borrow()` 返回只读守卫，守卫在这条语句结束时释放；`clone()` 克隆的是 `Vec<Value>`，每个元素只是 `Rc` 计数加一。

下面是它依赖的几个辅助项。先是 `overflow`、`is_number`、`as_f64`，三个小函数：

```rust
fn is_number(value: &Value) -> bool {
    matches!(value, Value::Int(_) | Value::Float(_))
}

fn as_f64(value: &Value) -> f64 {
    match value {
        Value::Int(inner) => *inner as f64,
        Value::Float(inner) => *inner,
        _ => f64::NAN,
    }
}
```

```rust
fn overflow(span: Span) -> RuntimeError {
    RuntimeError::new(span, "integer overflow")
}
```

再是错误类型。`add` 的最后一行 `TypeError::binary("+", lhs, rhs).into_error(span)` 用到了一个小结构体，它存下两个操作数的类型名，再一次性生成带注释的错误：

```rust
/// Describes a type mismatch, with a note suggesting a conversion.
struct TypeError {
    op: String,
    lhs: String,
    rhs: String,
}

impl TypeError {
    fn binary(op: &str, lhs: &Value, rhs: &Value) -> Self {
        Self {
            op: op.to_string(),
            lhs: lhs.type_name().to_string(),
            rhs: rhs.type_name().to_string(),
        }
    }

    fn into_error(self, span: Span) -> RuntimeError {
        RuntimeError::new(
            span,
            format!(
                "cannot apply `{}` to {} and {}",
                self.op, self.lhs, self.rhs
            ),
        )
        .with_note("operands of arithmetic operators must both be numbers")
    }
}
```

`into_error(self, ...)` 取走 `self`：生成错误之后 `TypeError` 就没用了，所有权转移让这件事在类型上明确。`.with_note(..)` 是第 3 篇 `Diagnostic` 的构建器风格，我们马上在 `RuntimeError` 里实现它。

### RuntimeError 里的 Box

运行时错误是一份 `Diagnostic`（第 3 篇）加一条调用栈。前者是我们已经写好的东西，后者是一个小结构体：

```rust
/// One frame of a runtime stack trace.
#[derive(Clone, Debug)]
pub struct TraceFrame {
    pub function: String,
    pub span: Span,
}
```

```rust
/// A runtime error: a diagnostic plus the call stack that produced it.
#[derive(Clone, Debug)]
pub struct RuntimeError {
    pub diagnostic: Box<Diagnostic>,
    pub trace: Vec<TraceFrame>,
}

impl RuntimeError {
    /// Creates an error at `span`.
    #[must_use]
    pub fn new(span: Span, message: impl Into<String>) -> Self {
        Self {
            diagnostic: Box::new(
                Diagnostic::error(message)
                    .with_code("E2001")
                    .with_span(span),
            ),
            trace: Vec::new(),
        }
    }

    /// Attaches a note to the diagnostic.
    #[must_use]
    pub fn with_note(mut self, note: impl Into<String>) -> Self {
        let diagnostic = *self.diagnostic;
        self.diagnostic = Box::new(diagnostic.with_note(note));
        self
    }

    /// Pushes a stack frame.
    #[must_use]
    pub fn with_frame(mut self, function: impl Into<String>, span: Span) -> Self {
        self.trace.push(TraceFrame {
            function: function.into(),
            span,
        });
        self
    }

    /// The message text.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.diagnostic.message
    }
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", &*self.diagnostic)
    }
}

impl std::error::Error for RuntimeError {}
```

字段 `diagnostic: Box<Diagnostic>` 值得解释，因为它是我实际踩到的一个 clippy 报警。`Box<T>` 是堆上的独占指针，C++ 对应 `unique_ptr<T>`（第 5 篇）。为什么要把一个 `Diagnostic` 装进盒子？

`Result<Value, RuntimeError>` 是几乎每个运算函数的返回类型。Rust 会把 `Result` 的大小定为两个变体里较大者，也就是说每一次成功的 `Ok(Value)` 也得为最大的 `Err` 腾出空间。我在 tag 的 worktree 里做了这个实验：加一个临时测试量大小，然后把 `Box<Diagnostic>` 改成 `Diagnostic`（只改字段类型和三处构造点，没有别的变化），再跑 clippy。

先是装盒子的真实版本，在最终代码上量出的大小。量大小的临时测试放在文件末尾，量完就删：

```rust
#[cfg(test)]
mod scratch {
    use super::*;

    #[test]
    fn sizes() {
        println!("size_of::<Value>() = {}", std::mem::size_of::<Value>());
        println!("size_of::<RuntimeError>() = {}", std::mem::size_of::<RuntimeError>());
    }
}
```

```text
$ cargo test -p pebble-value sizes -- --nocapture
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.01s
     Running unittests src/lib.rs (target/debug/deps/pebble_value-8a12146cf753ccc2)

running 1 test
size_of::<Value>() = 24
size_of::<RuntimeError>() = 32
test scratch::sizes ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 11 filtered out; finished in 0.00s
```

`Diagnostic` 本身在我的 worktree 里量是 104 字节（严重程度、错误码、消息、标签、注记，一堆 `String` 和 `Vec`）；装进盒子后 `RuntimeError` 只有 32 字节：8 字节指针加 `Vec<TraceFrame>` 的 24 字节。去掉盒子以后：

```text
size_of::<Diagnostic>() = 104
size_of::<RuntimeError>() = 128
size_of::<Result<Value, RuntimeError>>() = 128
```

`Result<Value, RuntimeError>` 从 32 字节涨到 128 字节，是 4 倍，而 `Value` 本身只有 24 字节。每个返回 `Ok(Value::Int(3))` 的 `add` 都要返回一个 128 字节的 `Result`。clippy 立刻抗议了：

```text
error: the `Err`-variant returned from this function is very large
   --> crates/pebble-value/src/lib.rs:329:53
    |
329 | pub fn add(lhs: &Value, rhs: &Value, span: Span) -> Result<Value, RuntimeError> {
    |                                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^ the `Err`-variant is at least 128 bytes
    |
    = help: try reducing the size of `RuntimeError`, for example by boxing large elements or replacing it with `Box<RuntimeError>`
    = help: for further information visit https://rust-lang.github.io/rust-clippy/master/index.html#result_large_err
    = note: `-D clippy::result-large-err` implied by `-D warnings`
    = help: to override `-D warnings` add `#[allow(clippy::result_large_err)]`
```

整个 `pebble-value` 里一共 22 处函数报这个错（`add`、`sub`、每个 `builtin_*`……），一个字段的改动，22 个警报。这就是"罕见路径付出常见路径的代价"：错误很少发生，而 Rust 没有异常，返回值得为它留位置。C++ 的 `std::expected<Value, Error>` 有完全相同的问题。解决办法是让错误路径多一次堆分配（出错时才付），常见路径只付 8 字节指针。这个故事的数字来自两次真实运行，两个版本我都保留了输出。

`with_note` 里还有一个只有 `Box` 才有的写法：`let diagnostic = *self.diagnostic;`。对 `Box<T>` 的解引用是**移动出来**（`*` 取走盒子里的值并释放盒子），这是普通引用做不到的。然后重新 `Box::new` 包回去。

`impl std::error::Error for RuntimeError {}` 又是一个空 impl。它的超 trait 要求（`Debug` + `Display`）我们都满足了（第 3 篇），所以这行本身没有方法，却让 `RuntimeError` 可以放进 `anyhow::Error`，或者用 `?` 转换。

### 其余运算符

`sub`、`mul`、`div`、`rem`、`negate` 都是 `add` 的变种，从 tag 复制：[crates/pebble-value/src/lib.rs 第 353 到 404 行](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-value/src/lib.rs#L353-L404)，放在 `add` 和 `compare` 之间。可以跳过细读的理由：`sub`/`mul` 就是调用 `numeric`；`div`/`rem` 比它们多一步，对整数零除数返回错误而不是 panic；`negate` 用 `checked_neg`，因为 `i64::MIN` 取负会溢出。你会在练习里用到 `compare`，所以我们写它：

```rust
/// `<`, `<=`, `>`, `>=` for numbers and strings.
pub fn compare(lhs: &Value, rhs: &Value, span: Span) -> Result<core::cmp::Ordering, RuntimeError> {
    match (lhs, rhs) {
        (Value::Int(a), Value::Int(b)) => Ok(a.cmp(b)),
        (Value::Str(a), Value::Str(b)) => Ok(a.cmp(b)),
        (a, b) if is_number(a) && is_number(b) => {
            let a = as_f64(a);
            let b = as_f64(b);
            a.partial_cmp(&b)
                .ok_or_else(|| RuntimeError::new(span, "cannot compare with NaN"))
        }
        _ => Err(RuntimeError::new(
            span,
            format!("cannot compare {} and {}", lhs.type_name(), rhs.type_name()),
        )),
    }
}
```

`core::cmp::Ordering` 是 `Less`/`Equal`/`Greater` 三值枚举。`(a, b) if is_number(a) && is_number(b)` 是**带守卫的分支**（第 4 篇）。`a.partial_cmp(&b)` 对 `f64` 返回 `Option<Ordering>`：碰到 NaN 是 `None`，`.ok_or_else(..)` 把它变成"cannot compare with NaN"的错误。

`numeric` 是所有数字运算共用的骨架，它的最后两个参数是**函数指针**：

```rust
fn numeric(
    lhs: &Value,
    rhs: &Value,
    span: Span,
    op: &str,
    int_op: fn(i64, i64) -> Option<i64>,
    float_op: fn(f64, f64) -> f64,
) -> Result<Value, RuntimeError> {
    match (lhs, rhs) {
        (Value::Int(a), Value::Int(b)) => {
            int_op(*a, *b).map(Value::Int).ok_or_else(|| overflow(span))
        }
        (a, b) if is_number(a) && is_number(b) => Ok(Value::Float(float_op(as_f64(a), as_f64(b)))),
        _ => Err(TypeError::binary(op, lhs, rhs).into_error(span)),
    }
}
```

`int_op: fn(i64, i64) -> Option<i64>` 的 `fn` 是小写的，不是 `Fn`。它是**函数指针类型**，就是 C 的 `int (*)(int, int)`。`sub` 里传的 `i64::checked_sub` 是一个函数路径，`|a, b| a - b` 是一个不捕获任何变量的闭包，两者都能自动转成函数指针。这是个实验（`~/rust-lab/src/bin/ch08_fn_ptr.rs`）：

```rust
fn double(x: i64) -> i64 {
    x * 2
}

fn main() {
    let table: [(&str, fn(i64) -> i64); 2] = [("double", double), ("negate", |x| -x)];
    for (name, f) in table {
        println!("{name}(21) = {}", f(21));
    }
    println!("size_of fn pointer: {}", std::mem::size_of::<fn(i64) -> i64>());
    let offset = 10;
    let add_offset = move |x: i64| x + offset;
    println!("size_of capturing closure: {}", std::mem::size_of_val(&add_offset));
    println!("add_offset(1) = {}", add_offset(1));
}
```

```text
$ cargo run --quiet --bin ch08_fn_ptr
double(21) = 42
negate(21) = -21
size_of fn pointer: 8
size_of capturing closure: 8
add_offset(1) = 11
```

函数指针是 8 字节，只存地址。那个捕获了 `offset` 的闭包也是 8 字节，但原因完全不同：闭包是一个匿名结构体，里面装着它捕获的值（这里一个 `i64`），它没有"地址"这个概念，调用路径由类型决定（静态分派）。如果我们想把它当函数指针用（`~/rust-lab/src/bin/ch08_fn_ptr_capture.rs`）：

```rust
fn main() {
    let offset = 10;
    let add_offset = move |x: i64| x + offset;
    let pointer: fn(i64) -> i64 = add_offset;
    println!("{}", pointer(1));
}
```

```text
$ cargo build --bin ch08_fn_ptr_capture
   Compiling rust-lab v0.1.0 (/tmp/rust-lab)
error[E0308]: mismatched types
 --> src/bin/ch08_fn_ptr_capture.rs:4:35
  |
3 |     let add_offset = move |x: i64| x + offset;
  |                      ------------- the found closure
4 |     let pointer: fn(i64) -> i64 = add_offset;
  |                  --------------   ^^^^^^^^^^ expected fn pointer, found closure
  |                  |
  |                  expected due to this
  |
  = note: expected fn pointer `fn(i64) -> i64`
                found closure `{closure@src/bin/ch08_fn_ptr_capture.rs:3:22: 3:35}`
note: closures can only be coerced to `fn` types if they do not capture any variables
 --> src/bin/ch08_fn_ptr_capture.rs:3:40
  |
3 |     let add_offset = move |x: i64| x + offset;
  |                                        ^^^^^^ `offset` captured here

For more information about this error, try `rustc --explain E0308`.
error: could not compile `rust-lab` (bin "ch08_fn_ptr_capture") due to 1 previous error
```

编译器说得很直白：只有**不捕获变量**的闭包才能转成 `fn`。这就是为什么 `numeric` 的参数是 `fn(..)` 而不是泛型 `impl Fn(..)`：这里我们不需要捕获，函数指针让 `numeric` 只编译一份，调用时间接跳转，对这种一次只做一个运算的函数来说，简单就够了。第 9 篇会看到相反的情形：解释器里的 Pebble 闭包需要捕获环境，那时才轮到 `Fn`、`FnMut`、`FnOnce`。

### 为什么不实现 Add 和 PartialOrd

你一定想问：标准库有 `std::ops::Add`，为什么 `add` 是个普通函数，而不是 `impl Add for Value`？第 2 篇我们用 `Index` 重载了 `map[id]`，这里为什么不同？我把它写出来试了一遍（`~/rust-lab/src/bin/ch08_add_value.rs`）：

```rust
use std::ops::Add;
use std::rc::Rc;

#[derive(Clone, Debug)]
enum Value {
    Int(i64),
    Str(Rc<str>),
}

impl Add for Value {
    type Output = Result<Value, String>;

    fn add(self, rhs: Value) -> Self::Output {
        match (self, rhs) {
            (Value::Int(a), Value::Int(b)) => Ok(Value::Int(a + b)),
            (Value::Str(a), Value::Str(b)) => Ok(Value::Str(format!("{a}{b}").into())),
            (a, b) => Err(format!("cannot add {a:?} and {b:?}")),
        }
    }
}

fn main() {
    let a = Value::Int(1);
    let b = Value::Int(2);
    println!("{:?}", a.clone() + b.clone());
    println!("{:?}", a.clone() + Value::Str("x".into()));
    let sum = a + b;
    println!("{:?}", sum);
}
```

```text
$ cargo run --quiet --bin ch08_add_value
Ok(Int(3))
Err("cannot add Int(1) and Str(\"x\")")
Ok(Int(3))
```

能跑，`Output = Result<Value, String>` 也合法（`Add` 的返回类型是一个关联类型，你想返回什么都行）。但有三个问题：

1. 错误里没有位置。`Add::add(self, rhs)` 的签名固定，没法多传一个 `Span`。我们的诊断（第 3 篇）靠它画出插入符。
2. `add` 按值取走两个操作数，`a + b` 之后 `a` 就没了。看这个最小例子的报错（`~/rust-lab/src/bin/ch08_add_value_moved.rs`）：

```rust
use std::ops::Add;

#[derive(Debug)]
struct Value(i64);

impl Add for Value {
    type Output = Value;

    fn add(self, rhs: Value) -> Value {
        Value(self.0 + rhs.0)
    }
}

fn main() {
    let a = Value(1);
    let b = Value(2);
    let sum = a + b;
    println!("{:?} {:?}", sum, a);
}
```

```text
$ cargo build --bin ch08_add_value_moved
   Compiling rust-lab v0.1.0 (/tmp/rust-lab)
error[E0382]: borrow of moved value: `a`
  --> src/bin/ch08_add_value_moved.rs:18:32
   |
15 |     let a = Value(1);
   |         - move occurs because `a` has type `Value`, which does not implement the `Copy` trait
16 |     let b = Value(2);
17 |     let sum = a + b;
   |               ----- `a` moved due to usage in operator
18 |     println!("{:?} {:?}", sum, a);
   |                                ^ value borrowed here after move
   |
note: if `Value` implemented `Clone`, you could clone the value
  --> src/bin/ch08_add_value_moved.rs:4:1
   |
 4 | struct Value(i64);
   | ^^^^^^^^^^^^ consider implementing `Clone` for this type
...
17 |     let sum = a + b;
   |               - you could clone this value
note: calling this operator moves the left-hand side
  --> /rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/core/src/ops/arith.rs:92:11

For more information about this error, try `rustc --explain E0382`.
error: could not compile `rust-lab` (bin "ch08_add_value_moved") due to 1 previous error
```

编译器甚至专门标出 `calling this operator moves the left-hand side`。`Value` 实现了 `Clone` 的话可以先 `clone()`，或者给 `&Value` 实现 `Add`，但这些都是为了迁就一个签名而做的绕路。

3. `a + b` 掩盖了"这可能失败"。在解释器里，每个运算符都可能报运行时错误，显式的 `add(&a, &b, span)?` 让问号写在眼前。

所以规则是：**运算符重载适合"结果总是有意义"的类型**（向量、矩阵、`Duration`、第 2 篇的 `Offset`），不适合会失败、需要额外上下文的语言运行时。

`PartialOrd` 同理，而且它的问题更微妙。`compare` 为什么不是 `impl PartialOrd for Value`？

`~/rust-lab/src/bin/ch08_partial_ord.rs`：

```rust
use std::rc::Rc;

#[derive(PartialEq, PartialOrd, Debug)]
enum Naive {
    Int(i64),
    Float(f64),
}

#[derive(Debug)]
struct List(Rc<Vec<i64>>);

impl PartialEq for List {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

impl PartialOrd for List {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        self.0.partial_cmp(&other.0)
    }
}

fn main() {
    println!("Int(2) < Float(0.5): {}", Naive::Int(2) < Naive::Float(0.5));
    println!("Float(NaN) < Float(1.0): {}", Naive::Float(f64::NAN) < Naive::Float(1.0));
    println!("Float(NaN) == Float(NaN): {}", Naive::Float(f64::NAN) == Naive::Float(f64::NAN));

    let a = List(Rc::new(vec![1]));
    let b = List(Rc::new(vec![1]));
    println!("a == b: {}", a == b);
    println!("a.partial_cmp(&b): {:?}", a.partial_cmp(&b));
    println!("a <= b && a >= b: {}", a <= b && a >= b);
}
```

```text
$ cargo run --quiet --bin ch08_partial_ord
Int(2) < Float(0.5): true
Float(NaN) < Float(1.0): false
Float(NaN) == Float(NaN): false
a == b: false
a.partial_cmp(&b): Some(Equal)
a <= b && a >= b: true
```

两个坑一起爆出来：

- `#[derive(PartialOrd)]` 对枚举先比变体顺序，再比内容。`Int(2) < Float(0.5)` 是 `true`，因为 `Int` 声明在 `Float` 前面。Pebble 里 `2 < 0.5` 当然是假的。
- 第二个类型模拟 `Value::List`：`==` 比较身份，`partial_cmp` 比较内容，于是两个内容相同的不同列表，`a == b` 是 `false`，`a.partial_cmp(&b)` 是 `Some(Equal)`，`a <= b && a >= b` 是 `true`。`PartialOrd` 的文档要求 `partial_cmp` 返回 `Some(Equal)` 当且仅当 `==` 成立。这个契约被打破以后，`sort`、`BTreeMap` 之类依赖它的标准库代码会得到不可预料的结果。

我们的做法是：把比较做成一个可以失败的函数，返回 `Result<Ordering, RuntimeError>`，让列表、Map、函数这些"没有顺序"的类型直接报错。

### 第三轮的测试

把 `span()` 辅助函数和下面这些测试放进 `tests` 模块，位置在 `list_identity_not_structure_for_equality` **前面**（`use super::*;` 的下面）：

```rust
    fn span() -> Span {
        Span::DUMMY
    }

    #[test]
    fn numbers_add_across_variants() {
        assert_eq!(
            add(&Value::Int(1), &Value::Int(2), span()).unwrap(),
            Value::Int(3)
        );
        assert_eq!(
            add(&Value::Int(1), &Value::Float(0.5), span()).unwrap(),
            Value::Float(1.5)
        );
    }

    #[test]
    fn integer_overflow_is_reported_not_wrapped() {
        let error = add(&Value::Int(i64::MAX), &Value::Int(1), span()).unwrap_err();
        assert_eq!(error.message(), "integer overflow");
    }

    #[test]
    fn strings_and_lists_overload_plus() {
        let hello = Value::string("he");
        let llo = Value::string("llo");
        assert_eq!(add(&hello, &llo, span()).unwrap().to_string(), "hello");

        let a = Value::list(vec![Value::Int(1)]);
        let b = Value::list(vec![Value::Int(2)]);
        assert_eq!(add(&a, &b, span()).unwrap().to_string(), "[1, 2]");
    }

    #[test]
    fn type_errors_are_clear() {
        let error = sub(&Value::string("a"), &Value::Int(1), span()).unwrap_err();
        assert!(
            error
                .message()
                .contains("cannot apply `-` to string and int")
        );
    }

    #[test]
    fn division_by_zero_is_an_error() {
        assert!(div(&Value::Int(1), &Value::Int(0), span()).is_err());
        // Floating point division by zero is IEEE, not an error.
        assert!(div(&Value::Float(1.0), &Value::Int(0), span()).is_ok());
    }
```

```text
$ cargo test -p pebble-value
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.01s
     Running unittests src/lib.rs (target/debug/deps/pebble_value-8a12146cf753ccc2)

running 7 tests
test tests::division_by_zero_is_an_error ... ok
test tests::list_identity_not_structure_for_equality ... ok
test tests::type_errors_are_clear ... ok
test tests::integer_overflow_is_reported_not_wrapped ... ok
test tests::numbers_add_across_variants ... ok
test tests::map_keys_survive_nan_and_lists ... ok
test tests::strings_and_lists_overload_plus ... ok

test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests pebble_value

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

七个测试。`integer_overflow_is_reported_not_wrapped` 是 `checked_add` 的账单：`i64::MAX + 1` 变成一条错误；`division_by_zero_is_an_error` 里整数除零是错误，浮点除零按 IEEE 给出无穷大，两者故意不同。

## Env：一串嵌套的作用域

变量名到值的映射在哪里？每个作用域一张表，作用域之间用链连起来：查找时先找当前表，找不到就找外层。闭包会捕获它定义时所在的作用域，所以作用域也必须被共享，同样是 `Rc<RefCell<..>>`，这次的套娃是 `Rc<RefCell<Env>>`。

先给 `Value` 加一个函数变体，因为 `Env` 之后马上要和它互相引用。把 `use pebble_ast::Stmt;` 加到文件头（放在 `use pebble_diag::Diagnostic;` 前面），然后在 `Map` 变体后加：

```rust
    /// A user-defined function or closure.
    Function(Rc<Function>),
```

`type_name` 加 `Value::Function(_) => "function",`；`equals` 加 `(Value::Function(a), Value::Function(b)) => Rc::ptr_eq(a, b),`；`key_hash` 加：

```rust
            Value::Function(value) => {
                7u8.hash(state);
                Rc::as_ptr(value).hash(state);
            }
```

`write_value` 加：

```rust
        Value::Function(function) => {
            write!(
                f,
                "<fn {}>",
                function.name.as_deref().unwrap_or("anonymous")
            )
        }
```

`Function` 结构体放在 `Env` 之后（文件里 `Environments` 一节之后是 `Functions` 一节）：

```rust
/// A user-defined function or closure.
pub struct Function {
    /// `Some` for `fn name(..)`, `None` for an anonymous closure.
    pub name: Option<String>,
    /// Parameter names, in order.
    pub params: Vec<String>,
    /// The body statements.
    pub body: Vec<Stmt>,
    /// The environment the function captured when it was created.
    pub env: Rc<RefCell<Env>>,
}
```

`env: Rc<RefCell<Env>>` 是函数"记住自己出生地"的方式：创建 `Function` 时把当时的作用域塞进去。`new`、`arity`、`display_name` 和手写的 `Debug` 是纯样板，从 tag 复制：[第 650 到 688 行](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-value/src/lib.rs#L650-L688)，紧跟在结构体后面。为什么 `Debug` 要手写：`Function` 里有 `env`，`env` 里的表又可能放着这个函数，`#[derive(Debug)]` 会无限递归下去。手写版只打印名字、参数和函数体的长度。

现在写 `Env`：

```rust
/// A lexical scope: a set of names plus a link to the enclosing scope.
pub struct Env {
    values: HashMap<String, Value>,
    parent: Option<Rc<RefCell<Env>>>,
}

impl Env {
    /// An empty global scope.
    #[must_use]
    pub fn new() -> Self {
        Self {
            values: HashMap::new(),
            parent: None,
        }
    }

    /// A scope nested inside `parent`.
    #[must_use]
    pub fn child(parent: Rc<RefCell<Env>>) -> Rc<RefCell<Env>> {
        Rc::new(RefCell::new(Self {
            values: HashMap::new(),
            parent: Some(parent),
        }))
    }

    /// Binds `name` in this scope, shadowing any outer binding.
    pub fn define(&mut self, name: impl Into<String>, value: Value) {
        self.values.insert(name.into(), value);
    }

    /// Looks up `name`, walking outward through parents.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<Value> {
        if let Some(value) = self.values.get(name) {
            return Some(value.clone());
        }
        self.parent.as_ref()?.borrow().get(name)
    }

    /// Assigns to an existing binding, walking outward. Returns whether it was
    /// found; [`false`] means the name is undefined.
    pub fn assign(&mut self, name: &str, value: Value) -> bool {
        if let Some(slot) = self.values.get_mut(name) {
            *slot = value;
            return true;
        }
        match &self.parent {
            Some(parent) => parent.borrow_mut().assign(name, value),
            None => false,
        }
    }

    /// Whether this exact scope (not its parents) defines `name`.
    #[must_use]
    pub fn contains_local(&self, name: &str) -> bool {
        self.values.contains_key(name)
    }

    /// Number of names defined in this scope.
    #[must_use]
    pub fn local_len(&self) -> usize {
        self.values.len()
    }
}
```

读这段代码，你至少要注意下面这些点：

- `values: HashMap<String, Value>` 的键是 `String`，但 `get(&self, name: &str)` 接受 `&str`。`HashMap<K, V>::get<Q>(&self, k: &Q)` 要求 `K: Borrow<Q>`：`String` 实现了 `Borrow<str>`，所以拿 `&str` 就能查。这不是魔法，只是标准库里的一个 trait。C++ 的异构查找（`unordered_map::find` 接受 `string_view`）花了很多年才在 C++20 里进来，还要你自己给容器配透明哈希。实验（`~/rust-lab/src/bin/ch08_borrow.rs`）：

```rust
use std::collections::HashMap;

fn main() {
    let mut env: HashMap<String, i64> = HashMap::new();
    env.insert("x".to_string(), 1);
    let name: &str = "x";
    println!("{:?}", env.get(name));
    println!("{:?}", env.get(&"y".to_string()));
}
```

```text
$ cargo run --quiet --bin ch08_borrow
Some(1)
None
```

- 类似地，`define(&mut self, name: impl Into<String>, ..)` 里用 `Into`，是因为调用者有时给 `&str`，有时给 `String`。与它相对的另一个转换 trait 是 `AsRef`：`fn shout(text: impl AsRef<str>)` 表示"我只想借用它的字符串视图"，不需要拥有。`Into` 消耗，`AsRef` 借用（`~/rust-lab/src/bin/ch08_asref.rs`）：

```rust
fn shout(text: impl AsRef<str>) -> String {
    text.as_ref().to_uppercase()
}

fn main() {
    println!("{}", shout("pebble"));
    println!("{}", shout(String::from("pebble")));
    println!("{}", shout(std::rc::Rc::<str>::from("pebble")));
}
```

```text
$ cargo run --quiet --bin ch08_asref
PEBBLE
PEBBLE
PEBBLE
```

- `get` 返回 `Option<Value>`（克隆出来的），而不是引用。因为要穿过 `RefCell` 的守卫：`Ref` 守卫在函数返回时就释放了，返回指向里面的引用会悬空，编译器不会让你这么写。克隆一个 `Value` 只是计数加一，便宜。
- `self.parent.as_ref()?.borrow().get(name)`：`as_ref()` 把 `&Option<Rc<..>>` 变成 `Option<&Rc<..>>`，问号在 `None` 时让整个函数返回 `None`（第 2 篇的 `?` on `Option`），`borrow()` 取父作用域的只读守卫，递归地 `get`。
- `assign` 里用 `borrow_mut()` 沿链往上改。每个作用域是一个**独立的** `RefCell`，所以子作用域持有 `&mut self` 的时候，再去 `borrow_mut` 父作用域不会冲突。如果有人把作用域链做成环，这里就是 `already borrowed` 的 panic 现场。
- `child` 是关联函数，不是方法，参数 `parent` 是一个 `Rc`（所有权转入）；调用者想继续用，先 `Rc::clone`。

`contains_local`、`local_len` 是两个只读小方法，`Default`（直接 `new()`）和手写的 `Debug`（理由和 `Function` 一样）一并写上，完整代码就是上面的 `impl Env` 加这一段：

```rust
impl Default for Env {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for Env {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Env")
            .field("locals", &self.values.len())
            .field("has_parent", &self.parent.is_some())
            .finish()
    }
}
```

测试放在 `map_keys_survive_nan_and_lists` 后面：

```rust
    #[test]
    fn environments_shadow_and_assign_outward() {
        let global = Rc::new(RefCell::new(Env::new()));
        global.borrow_mut().define("x", Value::Int(1));
        let inner = Env::child(Rc::clone(&global));
        inner.borrow_mut().define("x", Value::Int(2));
        assert_eq!(inner.borrow().get("x").unwrap(), Value::Int(2));
        assert!(inner.borrow_mut().assign("x", Value::Int(3)));
        // Assignment inside the child updates the child's own binding.
        assert_eq!(inner.borrow().get("x").unwrap(), Value::Int(3));

        let other = Env::child(Rc::clone(&global));
        assert!(other.borrow_mut().assign("x", Value::Int(9)));
        assert_eq!(global.borrow().get("x").unwrap(), Value::Int(9));
    }
```

两个作用域都定义了 `x` 时，子作用域的是 2（遮蔽），赋值只改自己最近的那个绑定；另一个子作用域给 `x` 赋值时，沿链找到全局的 `x`，全局变成 9。

```text
$ cargo test -p pebble-value
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.01s
     Running unittests src/lib.rs (target/debug/deps/pebble_value-8a12146cf753ccc2)

running 8 tests
test tests::division_by_zero_is_an_error ... ok
test tests::environments_shadow_and_assign_outward ... ok
test tests::integer_overflow_is_reported_not_wrapped ... ok
test tests::numbers_add_across_variants ... ok
test tests::list_identity_not_structure_for_equality ... ok
test tests::map_keys_survive_nan_and_lists ... ok
test tests::type_errors_are_clear ... ok
test tests::strings_and_lists_overload_plus ... ok

test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests pebble_value

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

## 内建函数：Output、函数指针表和 dyn

最后一块是 `print`、`len`、`range` 这些内建函数。它们要解决三个问题：

1. 怎么放进一张表，让解释器和 VM 都能按名字查？
2. `print` 要写输出，但测试里我们想捕获输出而不是真的打印。
3. 参数个数怎么检查？

### Output：trait 对象

第二个问题的答案是让 `print` 不直接调用 `println!`，而是通过一个抽象的"输出"：

```rust
/// Where a native function writes its output.
///
/// Making this a trait means tests can capture output instead of printing to
/// the terminal, and it is the reason the interpreter never calls `println!`.
pub trait Output {
    /// Writes one line.
    fn write_line(&mut self, line: &str);
}

/// Writes to standard output.
#[derive(Debug, Default)]
pub struct Stdout;

impl Output for Stdout {
    fn write_line(&mut self, line: &str) {
        println!("{line}");
    }
}

/// Collects output in memory; convenient for tests.
#[derive(Debug, Default)]
pub struct Buffer {
    lines: Vec<String>,
}

impl Buffer {
    /// A fresh buffer.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The captured lines.
    #[must_use]
    pub fn lines(&self) -> &[String] {
        &self.lines
    }

    /// The captured output as a single newline-joined string.
    #[must_use]
    pub fn text(&self) -> String {
        self.lines.join("\n")
    }
}

impl Output for Buffer {
    fn write_line(&mut self, line: &str) {
        self.lines.push(line.to_string());
    }
}
```

`pub trait Output` 里只有一个方法。`Stdout` 把一行写到标准输出，`Buffer` 把一行存在内存里。`#[derive(Debug, Default)]` 里的 `Default` 对 `Stdout`（单元结构体）和 `Buffer`（`Vec` 默认为空）都能自动生成。`lines(&self) -> &[String]` 返回的是切片借用，不是 `Vec`；`self.lines.join("\n")` 是切片的方法。

重点是 `print` 怎么拿到"某个 `Output`"。两种办法：

- **泛型**：`fn print<O: Output>(out: &mut O, ..)`。每种 `O` 编译一份，静态分派，没有间接调用，和 C++ 模板一样。代价是 `print` 要放进一张表，而表里的每一项必须有相同的类型，泛型函数没法统一。
- **trait 对象**：`&mut dyn Output`。一个运行时的"胖指针"：数据指针加一张函数表（vtable）指针，调用 `write_line` 是一次间接调用，和 C++ 的 virtual 函数调用是同样的机制，只是 vtable 指针不放在对象里，而是放在引用里。

`~/rust-lab/src/bin/ch08_dyn_output.rs`：

```rust
trait Output {
    fn write_line(&mut self, line: &str);
}

struct Stdout;
struct Buffer(Vec<String>);

impl Output for Stdout {
    fn write_line(&mut self, line: &str) {
        println!("{line}");
    }
}

impl Output for Buffer {
    fn write_line(&mut self, line: &str) {
        self.0.push(line.to_string());
    }
}

fn greet(out: &mut dyn Output) {
    out.write_line("hello");
}

fn main() {
    let mut buffer = Buffer(Vec::new());
    greet(&mut Stdout);
    greet(&mut buffer);
    println!("captured: {:?}", buffer.0);
    println!("size_of &Buffer:     {}", std::mem::size_of::<&Buffer>());
    println!("size_of &dyn Output: {}", std::mem::size_of::<&dyn Output>());
    println!("size_of Box<dyn Output>: {}", std::mem::size_of::<Box<dyn Output>>());
}
```

```text
$ cargo run --quiet --bin ch08_dyn_output
hello
captured: ["hello"]
size_of &Buffer:     8
size_of &dyn Output: 16
size_of Box<dyn Output>: 16
```

`&Buffer` 是 8 字节（普通指针），`&dyn Output` 是 16 字节（数据指针加 vtable 指针）。`Box<dyn Output>` 也是 16 字节，所以 Rust 里不需要在每个对象里藏一个 vptr，代价是引用变成了胖指针。`dyn Trait` 只能用于"对象安全"的 trait（没有泛型方法、不返回 `Self` 之类），`Output` 满足，不满足的情形第 3 篇的 `DiagnosticSink` 已经撞过（E0038），第 12 篇会再撞一次。

回到我们的目标：内建函数的签名统一成 `fn(&mut dyn Output, Span, &[Value]) -> Result<Value, RuntimeError>`，于是 `print` 可以和 `len` 放在同一张表里，而测试可以传 `&mut Buffer`。这也是为什么解释器从不直接调用 `println!`。

### NativeFunction：函数指针放进表

```rust
/// How many arguments a native function accepts.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Arity {
    /// Exactly this many.
    Exact(usize),
    /// At least this many.
    AtLeast(usize),
    /// Any number.
    Any,
}

impl Arity {
    /// Whether `count` arguments are acceptable.
    #[must_use]
    pub const fn accepts(self, count: usize) -> bool {
        match self {
            Arity::Exact(n) => count == n,
            Arity::AtLeast(n) => count >= n,
            Arity::Any => true,
        }
    }

    /// A human description used in arity errors.
    #[must_use]
    pub fn describe(self) -> String {
        match self {
            Arity::Exact(n) => format!("exactly {n}"),
            Arity::AtLeast(n) => format!("at least {n}"),
            Arity::Any => "any number of".to_string(),
        }
    }
}
```

`Arity` 是个小枚举，`accepts` 是 `const fn`（第 1 篇），`describe` 生成错误消息文字。`#[derive(Copy, Clone, Debug, PartialEq, Eq)]` 里 `Copy` 成立，因为所有变体只有一个 `usize`。

```rust
/// The signature every builtin shares.
pub type NativeImpl = fn(&mut dyn Output, Span, &[Value]) -> Result<Value, RuntimeError>;

/// A builtin function.
pub struct NativeFunction {
    /// Name as seen from Pebble.
    pub name: &'static str,
    /// Accepted argument count.
    pub arity: Arity,
    /// The implementation.
    pub func: NativeImpl,
}

impl fmt::Debug for NativeFunction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "<native {}>", self.name)
    }
}
```

`type NativeImpl = fn(...)` 是一个类型别名。读它的参数：`&mut dyn Output`、`&[Value]` 都带着引用，但你没看到任何生命周期。第 4 篇讲过省略规则：在函数指针类型里，每个省略的生命周期都是**独立的、对所有生命周期成立**的参数，也就是说它其实是这个东西（`~/rust-lab/src/bin/ch08_hrtb.rs`）：

```rust
#[allow(dead_code)]
struct Span(u32);

type Native = fn(&mut Vec<String>, Span, &[i64]) -> i64;
type Spelled = for<'a, 'b> fn(&'a mut Vec<String>, Span, &'b [i64]) -> i64;

fn count(_: &mut Vec<String>, _: Span, args: &[i64]) -> i64 {
    args.len() as i64
}

fn main() {
    let a: Native = count;
    let b: Spelled = a;
    let mut log = Vec::new();
    println!("{}", b(&mut log, Span(0), &[1, 2, 3]));
}
```

```text
$ cargo run --quiet --bin ch08_hrtb
3
```

`for<'a, 'b> fn(&'a mut Vec<String>, Span, &'b [i64]) -> i64` 读作"对于**任何**生命周期 `'a` 和 `'b`，一个接受 `&'a` 和 `&'b` 的函数"，这叫高阶生命周期约束（higher-ranked trait bound，HRTB），写 `for<..>` 的语法是它。省略写法和展开写法是同一个类型，上面 `let b: Spelled = a;` 能编译就是证据。现在知道这个名字就够了，你不需要自己写它。

`NativeFunction` 的手写 `Debug` 只打印名字，因为函数指针没有有用的 `Debug` 输出。下面是它的调用方法：

```rust
impl NativeFunction {
    /// The builtin's name.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        self.name
    }

    fn call(
        &self,
        out: &mut dyn Output,
        span: Span,
        args: &[Value],
    ) -> Result<Value, RuntimeError> {
        if !self.arity.accepts(args.len()) {
            return Err(RuntimeError::new(
                span,
                format!(
                    "{} expects {} arguments, got {}",
                    self.name,
                    self.arity.describe(),
                    args.len()
                ),
            ));
        }
        (self.func)(out, span, args)
    }
}
```

`fn call(&self, ..)` 没有 `pub`，它是模块私有的；外部通过后面的 `call_native` 调用。`(self.func)(out, span, args)` 的括号是必需的，不然编译器会以为你在调用一个叫 `func` 的方法，C++ 里也有相似的语法 `(obj.*pmf)(args)`。`self.arity.describe()` 在这里和 `accepts` 一样用到 `Copy`：`Arity` 是 `Copy`，所以 `self.arity.accepts(..)` 不会移走字段。

### range：切片模式

```rust
fn builtin_range(_: &mut dyn Output, span: Span, args: &[Value]) -> Result<Value, RuntimeError> {
    let (start, end) = match args {
        [end] => (0, int_arg(end, span)?),
        [start, end] => (int_arg(start, span)?, int_arg(end, span)?),
        _ => unreachable!("arity checked by caller"),
    };
    let items: Vec<Value> = (start..end).map(Value::Int).collect();
    Ok(Value::list(items))
}
```

`range(5)` 给 `[0, 1, 2, 3, 4]`，`range(2, 5)` 给 `[2, 3, 4]`。`args` 是 `&[Value]`，`match args { [end] => .., [start, end] => .. }` 是**切片模式**：按长度和内容同时匹配，`[end]` 只匹配长度为 1 的切片并绑定唯一的元素。C 里这要写 `if (argc == 1) {..} else if (argc == 2) {..}`，一旦漏了边界就是越界读；这里漏了就是编译错误（穷尽性检查）。

兜底分支 `_ => unreachable!("arity checked by caller")` 的措辞说"调用者已经检查过个数"，但 `range` 在表里的声明是 `Arity::AtLeast(1)`，"至少一个"包含三个。我在 tag 的 worktree 里加了个临时测试，用三个参数调用它：

```text
thread 'scratch::range_three_args' (85959) panicked at crates/pebble-value/src/lib.rs:899:14:
internal error: entered unreachable code: arity checked by caller
```

所以 `range(1, 2, 3)` 会 panic，而不是报一条漂亮的 arity 错误。这是 tag 里一个真实的小毛刺：声明（`AtLeast(1)`）比实现（只处理 1 个或 2 个）宽。我没有改它，因为这一篇的目标是让你的文件和 tag 一致，但现在你知道 `unreachable!` 是一个承诺，写下它就要保证没有路径能抵达。给 `Arity` 加一个 `Between(usize, usize)` 变体是自然的修法。

`(start..end).map(Value::Int).collect()` 里，`start..end` 本身就是一个迭代器（半开区间 `Range<i64>`），`.map(Value::Int)` 再次把变体当函数用，`.collect()` 把它们收集成 `Vec<Value>`（类型由左边 `let items: Vec<Value>` 标注推断）。

### builtin_names：-> impl Iterator

表里的名字要供给 VM 使用，我们暴露一个函数：

```rust
/// The names of every builtin, in table order.
pub fn builtin_names() -> impl Iterator<Item = &'static str> {
    BUILTINS.iter().map(|function| function.name)
}
```

`-> impl Iterator<Item = &'static str>` 的意思是"返回某个迭代器，我不告诉你它的具体类型，只保证它产出 `&'static str`"。具体类型是 `Map<slice::Iter<NativeFunction>, 一个闭包类型>`，这种类型是写不出来的（闭包类型没有名字），所以 `impl Trait` 是唯一的出路。C++ 里这就是 `auto` 返回类型，但 Rust 的 `impl Trait` 在签名里就承诺了接口，调用者看得到约束。

`static BUILTINS: &[NativeFunction]` 是整张表。`static` 是整个程序生命期的全局，地址固定，所以我们才能把 `&'static NativeFunction` 放进 `Value::Native`，不需要 `Rc`。表里 11 项长得完全一样：

```rust
/// The builtin functions, in one place.
pub static BUILTINS: &[NativeFunction] = &[
    NativeFunction {
        name: "print",
        arity: Arity::Any,
        func: builtin_print,
    },
    NativeFunction {
        name: "len",
        arity: Arity::Exact(1),
        func: builtin_len,
    },
```

剩下 9 项，以及 `builtin_print`、`builtin_len`、`builtin_type`、`builtin_str`、`builtin_int`、`builtin_float`、`builtin_push`、`builtin_keys`、`builtin_clock`、`builtin_assert`、`int_arg` 都从 tag 复制：[第 825 到 1039 行](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-value/src/lib.rs#L825-L1039)（这一段里有几项你已经写过：`builtin_range`、`builtin_names`、`builtin`、`call_native`，复制时跳过它们；`BUILTINS` 表你只写了前两项，用 tag 里完整的 11 项表替换它）。可以放心不细读的理由：它们就是 `match args[0]` 加一个错误分支，没有新的语言特性。值得扫一眼的有三个：`builtin_push` 里的 `let Value::List(items) = &args[0] else { .. }` 是第 3 篇的 `let else`；`builtin_assert` 把消息写进 `out`，所以失败信息出现在被捕获的输出里；`builtin_int` 里的 `text.trim().parse::<i64>()` 是标准库的 `FromStr`，下面会讲它。

最后是 `builtin` 和 `call_native`：

```rust
/// Looks up a builtin by name.
#[must_use]
pub fn builtin(name: &str) -> Option<&'static NativeFunction> {
    BUILTINS.iter().find(|function| function.name == name)
}
```

```rust
/// Calls a native function with a runtime arity check.
pub fn call_native(
    function: &'static NativeFunction,
    out: &mut dyn Output,
    span: Span,
    args: &[Value],
) -> Result<Value, RuntimeError> {
    function.call(out, span, args)
}
```

`Option<&'static NativeFunction>`：查表的结果是"要么没有，要么一个永远有效的借用"。

### Native 变体

终于可以补上 `Value` 的最后一个变体了：

```rust
    /// A builtin implemented in Rust.
    Native(&'static NativeFunction),
```

`&'static NativeFunction` 是一个 `Copy` 的引用。把它加进来，需要四处同步：`type_name` 的函数分支改成或模式 `Value::Function(_) | Value::Native(_) => "function",`；`equals` 加 `(Value::Native(a), Value::Native(b)) => core::ptr::eq(*a, *b),`（指针相等，因为函数表是静态的，同一个内建函数只有一份）；`key_hash` 加：

```rust
            Value::Native(value) => {
                8u8.hash(state);
                (*value as *const NativeFunction).hash(state);
            }
```

`write_value` 加 `Value::Native(function) => write!(f, "<native fn {}>", function.name),`。`(*value as *const NativeFunction).hash(state)` 把引用转成裸指针再哈希，和 `Rc::as_ptr` 是同一个意图，我们会在第 11 篇正式讲裸指针。

### 转换 trait：TryFrom 和 FromStr

`builtin_int` 里有两种"可能失败的转换"，标准库为它们各留了一个 trait：

- `TryFrom<T>`：类型到类型，失败时返回 `Self::Error`。`u32::try_from(-1i64)` 是 `Err`。
- `FromStr`：字符串到类型，`str::parse::<T>()` 的实现基础，`"42".parse::<i64>()` 就是 `i64::from_str("42")`。

两种我们都没有给自己的类型实现过，所以做个实验（`~/rust-lab/src/bin/ch08_try_from.rs`）：

```rust
use std::convert::TryFrom;

#[allow(dead_code)]
#[derive(Debug)]
struct Index(u32);

impl TryFrom<i64> for Index {
    type Error = String;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        u32::try_from(value)
            .map(Index)
            .map_err(|_| format!("{value} is not a valid index"))
    }
}

fn main() {
    println!("{:?}", Index::try_from(7));
    println!("{:?}", Index::try_from(-1));
    let converted: Result<Index, _> = 5_000_000_000i64.try_into();
    println!("{:?}", converted);
    println!("{:?}", "42".parse::<i64>());
    println!("{:?}", "4x2".parse::<i64>());
    println!("{:?}", u8::try_from(300i32));
}
```

```text
$ cargo run --quiet --bin ch08_try_from
Ok(Index(7))
Err("-1 is not a valid index")
Err("5000000000 is not a valid index")
Ok(42)
Err(ParseIntError { kind: InvalidDigit })
Err(TryFromIntError(()))
```

`impl TryFrom<i64> for Index` 之后，`5_000_000_000i64.try_into()` 白送了：`TryInto` 是 `TryFrom` 的反向，标准库给所有 `TryFrom` 一个全覆盖实现（第 3 篇的 blanket impl）。`ParseIntError { kind: InvalidDigit }` 是 `parse` 的错误类型，`TryFromIntError(())` 是 `try_from` 的。到第 9 篇，我们会给自己的类型实现 `FromStr`，让 REPL 的元命令 `":quit"` 用 `.parse::<MetaCommand>()` 解析。

## 补上文件头

所有部分都就位了。现在把文件最顶部那几行换成 tag 里的版本：[第 1 到 31 行](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-value/src/lib.rs#L1-L31)，一共三块：`#![forbid(unsafe_code)]`，上面那段带理由的 `#![allow(clippy::mutable_key_type)]`，以及 crate 级文档注释和完整的 `use` 列表。这段文档里有个英文破折号，我的博客不用这个符号，所以不在文章里贴它，直接从链接里复制。

文档注释里有两处值得说明：`//!` 是 crate 级文档，写给 `cargo doc` 看；[`Rc`] 这种方括号是 rustdoc 的"内部链接"，文档构建会检查它们指向的东西存在。第 15 篇我们会让 `RUSTDOCFLAGS="-D warnings"` 把失效的链接变成构建失败。

> [!NOTE] 这段文档提前说了一个故事
> 文档里写着 `Weak` 在这里**故意没用**：闭包用强 `Rc` 捕获定义它的环境，所以一个存在它自己捕获的环境里的递归函数会形成引用环，进而泄漏。这就是第 9 篇要用 `Weak` 实验证明的内容，也是 VM 后端选择垃圾回收的原因。

最后补上剩下的测试。把它们放在 `tests` 模块里，次序必须和 tag 一致，这样文件才能逐字节相同：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn span() -> Span {
        Span::DUMMY
    }

    #[test]
    fn numbers_add_across_variants() {
        assert_eq!(
            add(&Value::Int(1), &Value::Int(2), span()).unwrap(),
            Value::Int(3)
        );
        assert_eq!(
            add(&Value::Int(1), &Value::Float(0.5), span()).unwrap(),
            Value::Float(1.5)
        );
    }

    #[test]
    fn integer_overflow_is_reported_not_wrapped() {
        let error = add(&Value::Int(i64::MAX), &Value::Int(1), span()).unwrap_err();
        assert_eq!(error.message(), "integer overflow");
    }

    #[test]
    fn strings_and_lists_overload_plus() {
        let hello = Value::string("he");
        let llo = Value::string("llo");
        assert_eq!(add(&hello, &llo, span()).unwrap().to_string(), "hello");

        let a = Value::list(vec![Value::Int(1)]);
        let b = Value::list(vec![Value::Int(2)]);
        assert_eq!(add(&a, &b, span()).unwrap().to_string(), "[1, 2]");
    }

    #[test]
    fn type_errors_are_clear() {
        let error = sub(&Value::string("a"), &Value::Int(1), span()).unwrap_err();
        assert!(
            error
                .message()
                .contains("cannot apply `-` to string and int")
        );
    }

    #[test]
    fn division_by_zero_is_an_error() {
        assert!(div(&Value::Int(1), &Value::Int(0), span()).is_err());
        // Floating point division by zero is IEEE, not an error.
        assert!(div(&Value::Float(1.0), &Value::Int(0), span()).is_ok());
    }

    #[test]
    fn list_identity_not_structure_for_equality() {
        let a = Value::list(vec![Value::Int(1)]);
        let b = Value::list(vec![Value::Int(1)]);
        assert!(!a.equals(&b));
        assert!(a.equals(&a.clone()));
    }

    #[test]
    fn map_keys_survive_nan_and_lists() {
        let mut map = HashMap::new();
        map.insert(MapKey(Value::Float(f64::NAN)), Value::Int(1));
        map.insert(MapKey(Value::list(vec![])), Value::Int(2));
        // A fresh NaN key must find the stored entry thanks to bitwise hashing.
        assert_eq!(
            map.get(&MapKey(Value::Float(f64::NAN))),
            Some(&Value::Int(1))
        );
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn environments_shadow_and_assign_outward() {
        let global = Rc::new(RefCell::new(Env::new()));
        global.borrow_mut().define("x", Value::Int(1));
        let inner = Env::child(Rc::clone(&global));
        inner.borrow_mut().define("x", Value::Int(2));
        assert_eq!(inner.borrow().get("x").unwrap(), Value::Int(2));
        assert!(inner.borrow_mut().assign("x", Value::Int(3)));
        // Assignment inside the child updates the child's own binding.
        assert_eq!(inner.borrow().get("x").unwrap(), Value::Int(3));

        let other = Env::child(Rc::clone(&global));
        assert!(other.borrow_mut().assign("x", Value::Int(9)));
        assert_eq!(global.borrow().get("x").unwrap(), Value::Int(9));
    }

    #[test]
    fn builtin_names_follow_the_table() {
        assert_eq!(
            builtin_names().collect::<Vec<_>>(),
            [
                "print", "len", "type", "str", "int", "float", "range", "push", "keys", "clock",
                "assert"
            ]
        );
    }

    #[test]
    fn builtins_are_looked_up_and_arity_checked() {
        let print = builtin("print").unwrap();
        let mut buffer = Buffer::new();
        call_native(print, &mut buffer, span(), &[Value::Int(1), Value::Int(2)]).unwrap();
        assert_eq!(buffer.text(), "1 2");

        let len = builtin("len").unwrap();
        let error = call_native(len, &mut buffer, span(), &[]).unwrap_err();
        assert!(error.message().contains("expects exactly 1"));
    }

    #[test]
    fn range_and_push_work() {
        let mut buffer = Buffer::new();
        let range = builtin("range").unwrap();
        let list = call_native(range, &mut buffer, span(), &[Value::Int(3)]).unwrap();
        assert_eq!(list.to_string(), "[0, 1, 2]");

        let push = builtin("push").unwrap();
        call_native(push, &mut buffer, span(), &[list.clone(), Value::Int(9)]).unwrap();
        assert_eq!(list.to_string(), "[0, 1, 2, 9]");
    }
}
```

```text
$ cargo test -p pebble-value
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.01s
     Running unittests src/lib.rs (target/debug/deps/pebble_value-8a12146cf753ccc2)

running 11 tests
test tests::builtin_names_follow_the_table ... ok
test tests::builtins_are_looked_up_and_arity_checked ... ok
test tests::division_by_zero_is_an_error ... ok
test tests::integer_overflow_is_reported_not_wrapped ... ok
test tests::list_identity_not_structure_for_equality ... ok
test tests::environments_shadow_and_assign_outward ... ok
test tests::map_keys_survive_nan_and_lists ... ok
test tests::numbers_add_across_variants ... ok
test tests::range_and_push_work ... ok
test tests::strings_and_lists_overload_plus ... ok
test tests::type_errors_are_clear ... ok

test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests pebble_value

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

十一个测试全部通过。`builtin_names_follow_the_table` 同时钉住了 `builtin_names` 的返回顺序和上面的 11 项表；`range_and_push_work` 通过 `call_native` 调用 `push`，再通过原来的 `list` 变量观察到改动，这是本篇开头那四行 Pebble 程序在 Rust 里的缩影。

## 检查点

在工作区根目录里运行：

```bash
cargo test -p pebble-value
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

```text
$ cargo clippy --workspace --all-targets -- -D warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.01s
$ cargo fmt --all --check; echo "exit: $?"
exit: 0
```

`cargo test -p pebble-value` 的预期输出就是上面最后一次：`11 passed`。

下面这两个文件现在必须和 tag 逐字节相同：

- [`crates/pebble-value/Cargo.toml`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-value/Cargo.toml)
- [`crates/pebble-value/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-value/src/lib.rs)

检查方法（在你的工作区根目录里，需要在有 tag 的仓库里取原文件）：

```bash
diff <(git -C ~/pebble-tag show tutorial-v1:crates/pebble-value/src/lib.rs) crates/pebble-value/src/lib.rs && echo same
```

章节之间用三行横线注释隔开，格式如下（六节的标题依次是 `Values`、`Operators`、`Errors`、`Environments`、`Functions`、`Native functions`）：

```rust
// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------
```

文件的顺序是：文件头；`Values`（`Value`、`impl Value`、`PartialEq`、`From`、`write_value`、`Display`、`Debug`、`MapKey` 及其 trait）；`Operators`（`add`、`sub`、`mul`、`div`、`rem`、`negate`、`compare`、`is_number`、`as_f64`、`numeric`、`overflow`、`TypeError`）；`Errors`（`TraceFrame`、`RuntimeError`）；`Environments`（`Env`）；`Functions`（`Function`）；`Native functions`（`Arity`、`Output`、`Stdout`、`Buffer`、`NativeImpl`、`NativeFunction`、各个 `builtin_*`、`BUILTINS`、`builtin`、`builtin_names`、`call_native`）；`tests`。章节之间那种 `// ----` 横线注释，从 tag 里抄。

没有需要列出的中间文件：这一篇的所有 crate 都是终稿，根 `Cargo.toml` 里新增的是 `pebble-value` 这一行（它要到第 15 篇才算最终版）。

### 实验清单

这一篇用到的实验文件都在仓库的 `lab/` 目录里（[`lab/rust-lab`](https://github.com/bfmhno3/pebble/tree/tutorial-v1/lab/rust-lab)）；如果你把仓库克隆到了 `~/pebble-tag`，它们就在 `~/pebble-tag/lab/rust-lab`，先 `cd ~/pebble-tag/lab/rust-lab` 再运行下表的命令（也可以把这个目录复制成 `~/rust-lab`）。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`ch08_shared_list_move.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_shared_list_move.rs) | `cargo build --bin ch08_shared_list_move` | 编译失败：E0382 |
| [`ch08_shared_list_mut.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_shared_list_mut.rs) | `cargo build --bin ch08_shared_list_mut` | 编译失败：E0499 |
| [`ch08_shared_list_rc.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_shared_list_rc.rs) | `cargo build --bin ch08_shared_list_rc` | 编译失败：E0596 |
| [`ch08_shared_list.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_shared_list.rs) | `cargo run --quiet --bin ch08_shared_list` | 运行，首行 `strong count: 2` |
| [`ch08_refcell_panic.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_refcell_panic.rs) | `cargo run --quiet --bin ch08_refcell_panic` | 先打印 `try_borrow_mut while reading: true`，随后 `RefCell already borrowed` panic，退出码 101 |
| [`ch08_rc_str.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_rc_str.rs) | `cargo run --quiet --bin ch08_rc_str` | 运行，首行 `size_of::<String>():   24` |
| [`ch08_derive_hash.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_derive_hash.rs) | `cargo build --bin ch08_derive_hash` | 编译失败：E0277 |
| [`ch08_mutable_key.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_mutable_key.rs) | `cargo run --quiet --bin ch08_mutable_key` | 运行，首行 `before push: Some("one")` |
| [`ch08_fn_ptr.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_fn_ptr.rs) | `cargo run --quiet --bin ch08_fn_ptr` | 运行，首行 `double(21) = 42` |
| [`ch08_fn_ptr_capture.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_fn_ptr_capture.rs) | `cargo build --bin ch08_fn_ptr_capture` | 编译失败：E0308 |
| [`ch08_add_value.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_add_value.rs) | `cargo run --quiet --bin ch08_add_value` | 运行，首行 `Ok(Int(3))` |
| [`ch08_add_value_moved.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_add_value_moved.rs) | `cargo build --bin ch08_add_value_moved` | 编译失败：E0382 |
| [`ch08_partial_ord.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_partial_ord.rs) | `cargo run --quiet --bin ch08_partial_ord` | 运行，首行 `Int(2) < Float(0.5): true` |
| [`ch08_borrow.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_borrow.rs) | `cargo run --quiet --bin ch08_borrow` | 运行，首行 `Some(1)` |
| [`ch08_asref.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_asref.rs) | `cargo run --quiet --bin ch08_asref` | 运行，首行 `PEBBLE` |
| [`ch08_dyn_output.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_dyn_output.rs) | `cargo run --quiet --bin ch08_dyn_output` | 运行，首行 `hello` |
| [`ch08_hrtb.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_hrtb.rs) | `cargo run --quiet --bin ch08_hrtb` | 运行，首行 `3` |
| [`ch08_try_from.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/lab/rust-lab/src/bin/ch08_try_from.rs) | `cargo run --quiet --bin ch08_try_from` | 运行，首行 `Ok(Index(7))` |

## 练习

**1. 加一个 `min` 内建函数。** 它接受至少一个参数，返回最小的那个；类型不可比较时报错。

<details>
<summary>参考答案</summary>

```rust
fn builtin_min(_: &mut dyn Output, span: Span, args: &[Value]) -> Result<Value, RuntimeError> {
    let mut best = &args[0];
    for candidate in &args[1..] {
        if compare(candidate, best, span)?.is_lt() {
            best = candidate;
        }
    }
    Ok(best.clone())
}
```

在 `BUILTINS` 末尾加一项 `NativeFunction { name: "min", arity: Arity::AtLeast(1), func: builtin_min }`。`compare` 已经处理了 int/float 混合和 NaN，`Ordering::is_lt()` 是 `== Less` 的简写。注意 `builtin_names_follow_the_table` 会失败，因为它钉死了名字表，要在期望数组末尾加上 `"min"`。我把它连同下面这个测试一起跑过：

```rust
#[test]
fn min_picks_the_smallest() {
    let mut buffer = Buffer::new();
    let min = builtin("min").unwrap();
    let args = [Value::Int(3), Value::Float(1.5), Value::Int(2)];
    assert_eq!(call_native(min, &mut buffer, span(), &args).unwrap(), Value::Float(1.5));
    let error = call_native(min, &mut buffer, span(), &[Value::Int(1), Value::string("x")]).unwrap_err();
    assert_eq!(error.message(), "cannot compare string and int");
}
```

在 tag 的 worktree 里 13 个测试通过（原来的 11 个加上它和练习 3 的测试）。

</details>

**2. 找出 `key_eq` 和 `key_hash` 违反契约的地方。** 提示：`Int(1)` 和 `Float(1.0)`。

<details>
<summary>参考答案</summary>

`key_eq` 对其他情形一律回落到 `self.equals(other)`，而 `equals` 认为 `Int(1)` 和 `Float(1.0)` 相等；`key_hash` 却给 `Int` 哈希标记 `2u8`、给 `Float` 哈希标记 `3u8`，所以哈希不同。契约要求"相等则哈希相同"，这里被打破了。我在 tag 的 worktree 里用临时测试证实：

```text
key_eq: true
len = 2
get(1) = Some(10)
get(1.0) = Some(20)
```

`MapKey(Int(1)) == MapKey(Float(1.0))` 说相等，但同一个 `HashMap` 里两个键共存。这个表现取决于哈希碰撞的运气：恰好落进同一个桶时，行为就取决于实现细节。修复是让键相等也区分这两个变体：

```rust
fn key_eq(&self, other: &Value) -> bool {
    match (self, other) {
        (Value::Float(a), Value::Float(b)) => a.to_bits() == b.to_bits(),
        (Value::Int(_), Value::Float(_)) | (Value::Float(_), Value::Int(_)) => false,
        _ => self.equals(other),
    }
}
```

加了这一行以后，11 个原有测试照样通过，`key_eq` 对这对键返回 `false`。这个毛刺在 tag 里是存在的，我选择在这里指出来、不去改 tag：本篇的目标是让你的文件和 tag 一致，而你现在已经知道该怎么读它。

</details>

**3. 写 `Env::depth()`：这个作用域和全局作用域之间隔着几层。**

<details>
<summary>参考答案</summary>

```rust
/// How many scopes lie between this one and the global scope.
#[must_use]
pub fn depth(&self) -> usize {
    match &self.parent {
        Some(parent) => 1 + parent.borrow().depth(),
        None => 0,
    }
}
```

递归地沿着 `parent` 走，每层加一。`parent.borrow()` 是只读守卫，递归里全是只读借用，不会冲突。我用这个测试验证过：

```rust
#[test]
fn env_depth_counts_parents() {
    let global = Rc::new(RefCell::new(Env::new()));
    let inner = Env::child(Rc::clone(&global));
    let innermost = Env::child(Rc::clone(&inner));
    assert_eq!(global.borrow().depth(), 0);
    assert_eq!(innermost.borrow().depth(), 2);
}
```

</details>

下一篇我们终于让这些值动起来：解释器会把 `Function` 和 `Env` 接在一起，用闭包实现控制流。而那条一直埋着的引用环，会在一个看起来人畜无害的 `fn fact` 上咬出第一个真正的内存泄漏。我们会用 `Weak` 把它抓个现行。
