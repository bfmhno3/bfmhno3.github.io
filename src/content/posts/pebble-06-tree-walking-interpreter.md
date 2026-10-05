---
title: "树遍历解释器：Rc、RefCell，和一个我自己制造的内存泄漏"
commentId: "post:pebble-06-tree-walking-interpreter"
published: "2026-10-05 13:00:00 +08:00"
description: "第二个前端做完了，该让它跑起来。这一篇讲 Pebble 的运行时对象模型：用 Rc<RefCell<..>> 表达可变且共享的列表，用环境链实现闭包，把控制流做成一个返回值。最后我会告诉你，为什么递归闭包会让这个后端泄漏内存，以及这如何逼出了后面的垃圾回收器。"
category: Note
tags:
  - Rust
  - 解释器
  - Rc
  - 闭包
series: "从零写一门语言：Pebble"
seriesOrder: 6
draft: false
comment: true
slug: pebble-06-tree-walking-interpreter
---

前端负责"看懂"，后端负责"执行"。Pebble 有两个后端，这一篇讲简单那个：直接走 AST 的树遍历解释器。

在这之前得先有"值"。因为一门动态语言的值天然是共享且可变的，`pebble-value` 这一层是分配器和借用检查器打架最激烈的地方。

## 值：该共享的共享，该可变的可变

Pebble 的值长这样：

```rust
pub enum Value {
    Nil,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(Rc<str>),
    List(Rc<RefCell<Vec<Value>>>),
    Map(Rc<RefCell<HashMap<MapKey, Value>>>),
    Function(Rc<Function>),
    Native(&'static NativeFunction),
}
```

三种指针各有各的理由：

- `Rc<str>` 表示字符串是不可变的、可以廉价共享的，clone 只加引用计数。
- `Rc<RefCell<Vec<Value>>>` 表示列表是**既共享又可变**的。两个变量可以指向同一个列表，`push` 会同时被它们看到。这正是 `RefCell` 的存在意义：在共享的 `Rc` 后面做编译期借不到的可变操作，把借用检查挪到运行时。
- `Rc<Function>` 表示函数也是值，可以传来传去。

`Function` 里最关键的一个字段是它捕获的环境：

```rust
pub struct Function {
    pub name: Option<String>,
    pub params: Vec<String>,
    pub body: Vec<Stmt>,
    pub env: Rc<RefCell<Env>>,   // 创建时捕获的环境
}
```

## 映射的键：一个绕不开的 Eq

`HashMap<MapKey, Value>` 里的 `MapKey` 是个包装：

```rust
pub struct MapKey(pub Value);

impl PartialEq for MapKey { fn eq(&self, other: &Self) -> bool { self.0.key_eq(&other.0) } }
impl Eq for MapKey {}
impl Hash for MapKey { fn hash<H: Hasher>(&self, state: &mut H) { self.0.key_hash(state) } }
```

为什么要包装？因为 `HashMap` 要求键是 `Eq + Hash`，而 `f64` 不是 `Eq`（`NaN != NaN`）。我的处理是：**键比较时浮点数按位比较**，于是 `NaN` 也能当一个稳定的键；可变的值（列表、映射、函数）则按**指针身份**比较，因为内容会变、但地址不会。

```rust
fn key_eq(&self, other: &Value) -> bool {
    match (self, other) {
        (Value::Float(a), Value::Float(b)) => a.to_bits() == b.to_bits(),
        _ => self.equals(other),
    }
}
```

而语言层面的 `==` 又是另一套语义：浮点按 IEEE（`NaN != NaN`），列表按身份（两个内容相同的列表不相等）。测试专门钉住这一点：

```rust
#[test]
fn list_identity_not_structure_for_equality() {
    let a = Value::list(vec![Value::Int(1)]);
    let b = Value::list(vec![Value::Int(1)]);
    assert!(!a.equals(&b));
    assert!(a.equals(&a.clone()));
}
```

## 运算符：宁可写函数，也不重载 std::ops

Rust 允许给 `Value` 实现 `std::ops::Add`，让 `a + b` 直接可用。我没这么做，原因是**溢出和除零是错误**：

```rust
pub fn div(lhs: &Value, rhs: &Value, span: Span) -> Result<Value, RuntimeError> {
    if let (Value::Int(a), Value::Int(b)) = (lhs, rhs) {
        if *b == 0 {
            return Err(RuntimeError::new(span, "division by zero"));
        }
        return a.checked_div(*b).map(Value::Int).ok_or_else(|| overflow(span));
    }
    // ...
}
```

`std::ops::Add` 的签名是 `fn add(self, rhs) -> Output`，**返回不了 `Result`**。硬要重载就得把错误塞进 `Value` 里，然后让每次加法都去检查一遍，代价更大。所以我选了显式函数：`add(lhs, rhs, span)`，把位置也带进去，出错时能画出正确的插入符。这是一次很典型的"语言的表达力更强，但选择更啰嗦"的权衡。

## 环境链：一个 `HashMap` 加一个父指针

作用域就是一个哈希表加一条指向外层的边：

```rust
pub struct Env {
    values: HashMap<String, Value>,
    parent: Option<Rc<RefCell<Env>>>,
}

impl Env {
    pub fn get(&self, name: &str) -> Option<Value> {
        if let Some(value) = self.values.get(name) {
            return Some(value.clone());
        }
        self.parent.as_ref()?.borrow().get(name)
    }

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
}
```

`assign` 沿着链往外找，找到就改，找不到返回 `false`（调用方报"不能给未定义变量赋值"）。这十几行就是对"词法作用域"最直白的实现。

## 控制流是数据

`return`/`break`/`continue` 会打断正常的求值流。在 C 里这是 `goto` 或 `setjmp`，在带异常的语言里是异常。在 Rust 里我把它做成一个**返回值**：

```rust
pub enum Flow {
    Value(Value),
    Return(Value),
    Break,
    Continue,
}
```

`execute_block` 顺序执行语句，一旦某个语句返回非 `Value` 的 `Flow`，就立刻向上传播：

```rust
fn execute_block(&mut self, stmts: &[Stmt], env: Rc<RefCell<Env>>) -> Result<Flow, RuntimeError> {
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

`while` 循环里遇到 `Flow::Break` 就 `break`，遇到 `Flow::Return` 就继续往上抛。没有异常，没有跳转，全是普通的函数返回。这是我在这部分学到的最舒服的一个模式。

## 递归上限，以及一次真实的栈溢出

解释器递归深度等于 Pebble 程序的调用深度乘以每层用的 Rust 栈帧。不设上限的话，一段 `fn loop() { return loop(); }` 会先撑爆宿主线程的栈，然后进程直接 `SIGSEGV`，用户看到的是一句冷冰冰的 "stack overflow"，而不是 Pebble 的错误。

我一开始把上限设成了 512，结果测试线程（默认 2 MB 栈）先炸了：

```text
thread 'tests::recursive_overflow_is_caught' has overflowed its stack
fatal runtime error: stack overflow, aborting
```

把默认上限降到 128 之后，宿主栈能扛住，Pebble 能干净地报出自己的错误。对应的测试思路也值得记：这个测试需要递归到上限，普通测试线程的栈不够，而 `Value` 含 `Rc`、不是 `Send`，没法把它搬到别的线程再`join` 回来。所以我把**断言整个放进**一个大栈线程里：

```rust
std::thread::Builder::new()
    .stack_size(64 * 1024 * 1024)
    .spawn(|| {
        let error = run("fn loop() { return loop(); } loop();").unwrap_err();
        assert!(error.message().contains("stack overflow"));
    })
    .unwrap()
    .join()
    .unwrap();
```

## 然后，我制造了一个内存泄漏

这是这一篇真正的重点。

闭包捕获的是它定义时的环境：`env` 字段的 `Rc<RefCell<Env>>`。一个**具名函数**会被定义进它自己捕获的那个环境里。于是：

```pebble
fn fact(n) {
    if n < 2 { return 1; }
    return n * fact(n - 1);   // fact 这个名字就存在于它自己捕获的环境里
}
```

`fact` 这个 `Function` 值存在 environment 里，而这个 environment 又被 `Function.env` 用 `Rc` 指着。**引用计数永远不会归零**，整条环境链连同里面的所有值都泄漏了。`Rc` 处理不了循环引用，这不是 bug，是 `Rc` 的定义。

当时我盯着这一点看了很久。修法有几种：把父指针换成 `Weak`，或者让具名函数捕获一个 `Weak`。但真正干净的答案是**换一种内存模型**：不要让运行时对象由引用计数管理，而是交给一个能识别环的垃圾回收器。

这恰好是 Pebble 第二个后端存在的理由。

## 让它先跑起来

在解决泄漏之前，树遍历后端已经能正确地跑出结果。两个例子：

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
```

第一个例子里的 `make_counter` 返回一个闭包，每次调用 `count` 加一并返回，说明闭包**确实捕获并保持**了它的环境（这正是泄漏的来源，也是功能正确的来源）。第二个例子把列表、映射、`for` 都用了一遍。

## 下一篇

泄漏的解法不是去修补 `Rc`，而是换一套内存管理。要做到那一步，先得让程序"变成线性的"。下一篇进入字节码编译器：把 AST 编译成一串指令，用常量池存字面量，用**跳转回填**处理前向跳转，最后给一段真实程序的完整反汇编。
