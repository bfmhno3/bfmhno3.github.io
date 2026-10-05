---
title: "Rust 标准库速览：我在这门语言里用到的每一个容器和指针"
commentId: "post:pebble-rust-02-stdlib"
published: "2026-10-05 06:40:00 +08:00"
description: "语法会读之后，真正每天打交道的是标准库。这篇按「什么时候用哪个」过一遍我能用到的全部：&str 和 String 怎么选、Vec 和 HashMap、Box/Rc/RefCell/Cell 各管什么、Option 和 Result 的常用方法、迭代器那一串 .map().collect()、fmt、错误类型、时间、文件和线程。每个都指向 Pebble 里真实用到它的那段代码。"
category: Note
tags:
  - Rust
  - 标准库
  - 入门
  - 基础
series: "从零学 Rust：Pebble 基础篇"
seriesOrder: 2
draft: false
comment: true
slug: pebble-rust-02-stdlib
---

上一篇讲了语法，但语法只占 Rust 的一小半。你很快就会遇到 `Rc<RefCell<Vec<Value>>>` 这种签名，而它里面没有任何一个词出现在语法书里。这篇按"什么时候用哪个"把 Pebble 真正用到的标准库过一遍。

我把整棵依赖树里所有 `use std::...` / `use core::...` / `use alloc::...` 扫了一遍，就是下面这些。没有花架子。

## 字符串：`&str`、`String`、`Rc<str>`、`Cow`

四个字符串相关类型，选哪个取决于"谁拥有这块内存"。

- `&str`：借来的、只读的一段文字。**默认选它**，除非你需要自己拥有。
- `String`：自己拥有的、可增长的字符串。`pebble-span` 存文件名和源码用它。
- `Rc<str>`：多个地方共享同一段**不可变**字符串。`pebble-value` 的字符串值就是 `Rc<str>`，clone 只加引用计数，不复制内容。
- `Cow<'a, str>`：**能借就借**，非改不可才拥有。词法器用它处理字符串字面量：没有转义的 `"plain"` 直接借用源码，有转义的 `"a\nb"` 才分配一个 `String`。

```rust
pub enum TokenKind<'src> {
    Str(Cow<'src, str>),
    Ident(&'src str),
    // ...
}
```

转换的写法要熟：

```rust
let owned: String = "hi".to_string();   // 复制一份，自己拥有
let owned: String = "hi".to_owned();    // 同上，语义一样
let borrowed: &str = &owned;            // String -> &str，零成本
let shared: Rc<str> = Rc::from("hi");   // 共享
let shared: Rc<str> = "hi".into();      // 同上，.into() 让编译器挑
```

`.into()` 是 `Into` trait 的方法，意思是"转成目标类型"，目标由上下文推断。`Value::string` 的签名就用了它：

```rust
pub fn string(text: impl Into<Rc<str>>) -> Self {
    Value::Str(text.into())
}
```

`impl Into<Rc<str>>` 的意思是"任何能转成 `Rc<str>` 的东西都行"，于是 `&str`、`String`、`Rc<str>` 都能直接传进去。

## 序列：`Vec`、切片、数组

- `Vec<T>`：可增长的动态数组。
- `&[T]`：切片，一个"指向某段连续元素"的视图，不拥有数据。函数参数优先用切片，因为它同时接受 `Vec` 和数组。
- `[T; N]`：数组，长度写在类型里，固定在栈上。

真实的用法，跨度很大：

```rust
line_starts: Vec<u32>,                    // 每一行的起始字节，只增长
free: Vec<u32>,                           // GC 的空闲槽列表
slots: Vec<Option<O>>,                    // GC 的槽位，空槽是 None
buffer: Vec<MaybeUninit<u8>>,             // bump 分配器的底层内存
heap: UnsafeCell<[u8; HEAP_SIZE]>,        // no_std 里固定 4096 字节的堆
```

`Vec<Option<O>>` 这个组合值得看一眼：它同时表达"这个下标有没有对象"和"对象是什么"。GC 的空闲槽就是 `None`，不需要另开一个布尔数组。

常用的方法：`.push(x)`、`.pop()`、`.len()`、`.is_empty()`、`.get(i) -> Option<&T>`、`.iter()`、`.contains(&x)`、`.extend(other)`。注意 `.get()` 返回 `Option`，越界是 `None`；而下标 `v[i]` 越界会直接 panic。想"越界就报错"用下标，想"越界就返回 None"用 `.get()`。

## 映射：`HashMap`，以及为什么键要满足 `Eq + Hash`

`HashMap<K, V>` 是无序的键值表。`pebble-interp` 和 `pebble-value` 用它当环境/映射的底层。

它有一个硬性要求：键必须实现 `Eq + Hash`。整数和字符串天生满足，但 `Value` 不满足，所以 Pebble 包了一层：

```rust
pub struct MapKey(pub Value);

impl PartialEq for MapKey {
    fn eq(&self, other: &Self) -> bool { self.0.key_eq(&other.0) }
}
impl Eq for MapKey {}
impl Hash for MapKey {
    fn hash<H: Hasher>(&self, state: &mut H) { self.0.key_hash(state) }
}
```

为什么不能直接用 `Value` 当键？因为 `Value` 里有 `f64`，而 `f64` 不是 `Eq`（`NaN != NaN`），所以 `Value` 无法自动满足 `HashMap` 的要求。我在 `MapKey` 里给浮点数定义了"按二进制位比较"，让 `NaN` 也能当一个稳定的键；容器类型则按**指针身份**哈希（内容会变，地址不会）。

顺带一个使用上的坑：`HashMap` **不保证遍历顺序**。所以 `examples/collections.pebble` 里的输出是显式按固定顺序打印的，不依赖映射内部顺序，测试才能稳定。

## 智能指针：`Box`、`Rc`、`RefCell`、`Cell`

这是新手最容易混的一组。一句话版本：

| 类型 | 一句话 | Pebble 里 |
| --- | --- | --- |
| `Box<T>` | 唯一所有权，只是把值放到堆上 | 递归 AST 节点、`Box<dyn Output>` |
| `Rc<T>` | 共享所有权，引用计数 | 共享的字符串、函数、原型 |
| `RefCell<T>` | 把借用检查挪到运行时，允许"共享但可变" | 列表、映射、环境 |
| `Cell<T>` | 给 `Copy` 小值用的、更便宜的内部可变性 | GC 的标记位 |

`Box<T>` 用得最多的是**打破递归**。AST 里一个表达式可以包含另一个表达式，如果直接内嵌，类型大小是无限的：

```rust
Binary { op: BinaryOp, lhs: Box<Expr>, rhs: Box<Expr>, span: Span },
```

`Box` 把子节点挪到堆上，`Expr` 的大小就固定了。`Box<dyn Output>` 则是**trait object**：在堆上放一个"实现了 `Output` 的某个具体类型"，具体是谁由运行时决定。

`Rc<RefCell<T>>` 是组合技，也是整门语言里最重要的一个模式。`Rc` 让多个变量指向同一份数据，但 `Rc` 本身只给只读访问；要改，就得把内容套进 `RefCell`：

```rust
pub enum Value {
    Str(Rc<str>),
    List(Rc<RefCell<Vec<Value>>>),
    Map(Rc<RefCell<HashMap<MapKey, Value>>>),
    Function(Rc<Function>),
    // ...
}
```

读的时候 `.borrow()`，写的时候 `.borrow_mut()`。如果同一时刻既有人读又有人写，`RefCell` 会在**运行时 panic**，而不是编译期报错。这就是它和普通引用的取舍：更灵活，代价是错误推迟到运行时。

`Cell<T>` 是 `RefCell` 的轻量版，只能放 `Copy` 的小值，读写都不需要 `.borrow()`。GC 的标记位用它，因为"标记"这个动作太频繁，不值得为它走 `RefCell` 的开销：

```rust
marked: Vec<Cell<bool>>,
// ...
if self.marked[index].replace(true) { continue; }
```

`replace(true)` 写入 `true` 并返回旧值，一行同时完成"读旧值"和"写新值"。

## `Option` 和 `Result` 的常用方法

这两个枚举本身简单，值钱的是它们的方法。下面这张表基本覆盖了 Pebble 里出现过的全部：

| 方法 | 作用 |
| --- | --- |
| `.map(\|x\| ...)` | 有值就变换，没有就还是没有 |
| `.and_then(\|x\| ...)` | 变换本身返回 `Option`/`Result` 时用 |
| `.ok_or_else(\|\| ...)` | `Option` 转 `Result`，没有值时现造一个错误 |
| `.map_err(\|e\| ...)` | 变换错误类型 |
| `.unwrap_or(default)` | 没有/失败就给个默认值 |
| `.unwrap_or_else(\|\| ...)` | 默认值要现算时用 |
| `.is_some_and(\|x\| ...)` | 有值且满足条件 |
| `.first()` / `.get(i)` | 拿第一个/第 i 个，返回 `Option<&T>` |
| `?` | 没值/失败就提前返回 |

真实的一行，把这几个串起来：

```rust
self.stack
    .pop()
    .ok_or_else(|| RuntimeError::new(span, "internal error: value stack underflow"))
```

栈空是 `None`，`.ok_or_else` 把它变成一个带位置的 `RuntimeError`，`?` 再把它抛出去。

迭代器转 `Result` 的那一行，值得单独看一眼：

```rust
let values = items
    .iter()
    .map(|item| self.eval(item, env))
    .collect::<Result<Vec<_>, _>>()?;
```

`items` 里每个元素求值都返回 `Result`。如果一个个 `?` 会很啰嗦；`collect::<Result<Vec<_>, _>>()` 的意思是"收集成一个 `Result<Vec<值>, 错误>`"：全成功就得到 `Ok(Vec)`，任何一个是 `Err` 就短路成那个 `Err`。再配一个外层 `?`。这是 Rust 里很漂亮的一个惯例。

`panic!` / `assert!` / `unreachable!` 也存在，但那是"程序写错了"才用的，不该拿来处理用户输入。

## 迭代器：`.map().filter().collect()` 到底在干嘛

`Iterator` 是 Rust 里最重要的 trait 之一。`for x in xs` 背后就是 `IntoIterator` 转成一个迭代器，然后反复 `.next()`。`.next()` 返回 `Option<T>`：`Some` 还有，`None` 结束。

一旦有了迭代器，就能串**适配器**。Pebble 里常见的：

```rust
.iter().map(|item| self.eval(item, env))       // 逐个变换
.filter(|&start| start <= offset)              // 逐个筛选
.find(|(k, _)| *k == name)                     // 找第一个
.position(|(k, _)| *k == name)                 // 找第一个的下标
.map(|param| param.name.clone()).collect::<Vec<_>>().join(", ")  // 收集再连接
```

还有一个"二分"的小神器，`pebble-span` 用它把字节偏移换算成行号：

```rust
let count = self.line_starts.partition_point(|&start| start <= offset);
```

`partition_point` 返回"第一个不满足条件的下标"，也就是"有多少行首小于等于 offset"。一次二分，`O(log n)`，没有手写循环。

关于性能：迭代器链在 release 下会被内联成和手写循环一样的机器码，不用因为"可读"而担心它慢。真要看证据，`cargo bench` 就在仓库里。

## 格式化：`Display`、`Debug`、`write!`

`{}` 用的是 `Display`，`{:?}` 用的是 `Debug`，`{:#?}` 是 `Debug` 的缩进版。

- `Display` 是"给人看的样子"：`Value::Str` 打印成不带引号的 `hello`。
- `Debug` 是"给程序员看的样子"：字符串带引号，结构体带字段名。用 `#[derive(Debug)]` 自动生成。

`pebble-value` 里两个都手写了，因为它需要在字符串上加引号、在递归结构上加深度保护：

```rust
impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write_value(f, self, 0, false)   // quoted = false
    }
}
```

往字符串里写东西，用 `write!` / `writeln!`（需要 `use core::fmt::Write`）。`pebble-diag` 渲染诊断就是一路 `writeln!`：

```rust
let _ = writeln!(out, "{pad}--> {}:{}:{}", file.name(), line_no, pos.column);
```

`format!` 和它们同源，区别是它**生成一个 `String`**。能用 `write!` 往已有缓冲里写，就不要用 `format!` 造临时字符串，前者少一次分配。

## 错误类型：`Error` trait 和 `anyhow`

自定义错误一般 `impl Display + Error`。Rust 1.81 之后 `core::error::Error` 也可用，所以 `no_std` 代码同样能实现标准错误 trait。`Diagnostic` 就是这么做的：

```rust
impl core::error::Error for Diagnostic {}
```

二进制程序（比如 CLI）里，我用了 `anyhow`：它把"任何错误"装进一个统一的 `anyhow::Error`，省掉为一个只在一处使用的错误写类型。规则很简单：

- **库**：定义明确的错误类型，调用方需要区分不同的失败。
- **二进制**：`anyhow` 足够，反正最后都是打印出来退出。

## 时间、文件、进程

CLI 里用到的 std 面孔：

```rust
use std::time::{Duration, Instant};   // bench 子命令计时
use std::fs;                          // 读源文件
use std::path::{Path, PathBuf};       // 路径拼接
use std::process::ExitCode;           // main 的退出码
```

计时惯用法：`let start = Instant::now(); ...; start.elapsed()`。而"当前时间"来自 `SystemTime`，`clock()` 内建函数用它：

```rust
std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|elapsed| elapsed.as_secs_f64())
    .unwrap_or(0.0)
```

注意 `.duration_since` 返回 `Result`（时钟可能回拨），这里用 `.map().unwrap_or(0.0)` 兜底成 0。

## 并发：线程、`Arc<Mutex<_>>`、原子操作

`std::thread` 用来开线程。我在测试里开**大栈线程**，因为解释器递归太深：

```rust
std::thread::Builder::new()
    .stack_size(64 * 1024 * 1024)
    .spawn(|| { /* ... */ })
    .unwrap()
    .join()
    .unwrap();
```

需要跨线程共享可变的计数器，就 `Arc<Mutex<T>>`。`Arc` 是线程安全版 `Rc`，`Mutex` 是"同一时刻只有一个能改"。异步服务端用的是 Tokio 版的互斥锁：

```rust
let stats = Arc::new(Mutex::new(Stats::default()));   // tokio::sync::Mutex
// ...
stats.lock().await.connections += 1;
```

原子操作（`AtomicUsize`、`Ordering::Relaxed`）是更底层的无锁计数器，`pebble-nostd` 的 bump 分配器用 `fetch_update` 做"比较并预留"：

```rust
.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
    let cursor = base.checked_add(used)?;
    let aligned = cursor.checked_add(align - 1)? & !(align - 1);
    let end = offset.checked_add(size)?;
    (end <= HEAP_SIZE).then_some(end)
})
```

顺带一提，`Option` 配合 `?` 在闭包里也能用，这就是 `checked_add` 那几行 `?` 的来源：任何一步溢出，整个 `fetch_update` 就放弃这一轮。

## 数值方法：别用裸四则运算

整数溢出在 Rust 里：debug 会 panic，release 会回绕（wrap）。两种行为都不该发生在语言运行时里。所以我用 `checked_*` 系列，溢出就转成一条语言级错误：

```rust
(Value::Int(a), Value::Int(b)) => a
    .checked_add(*b)
    .map(Value::Int)
    .ok_or_else(|| overflow(span)),
```

相关的还有 `saturating_sub`（减到底就停）、`partial_cmp`（浮点比较，返回 `Option<Ordering>`，因为 `NaN` 不可比）、`to_bits`（把浮点看成位模式，用来做稳定的哈希）、`is_alphabetic` / `is_ascii_digit`（字符分类，词法器用）。

## 一张对照表

最后把"需求 -> 用哪个"整理成一张表，遇到不确定的时候来查：

| 我要... | 用 |
| --- | --- |
| 一段只读文字 | `&str` |
| 要能改的字符串 | `String` |
| 多处共享一段不可变字符串 | `Rc<str>` |
| 可增长的列表 | `Vec<T>` |
| 只读的一段列表 | `&[T]` |
| 键值表 | `HashMap<K, V>`（K 要 `Eq + Hash`） |
| 递归结构、trait object | `Box<T>` |
| 共享所有权 | `Rc<T>`（单线程）/ `Arc<T>`（多线程） |
| 共享且可变 | `Rc<RefCell<T>>` |
| 高频小标记位 | `Cell<T>` |
| 可能没有的值 | `Option<T>` |
| 可能失败的操作 | `Result<T, E>` |
| 想连锁处理上面两个 | `.map()` / `.and_then()` / `?` |
| 遍历并变换 | 迭代器适配器 |
| 格式化 | `Display` / `Debug` / `write!` |
| 计时 | `Instant` |
| 线程 | `std::thread` |

## 下一步

标准库能用之后，会立刻碰到 Rust 里**唯一一个别的语言没有的东西**：所有权和借用。为什么 `let a = b;` 之后 `b` 就不能用了、`&` 和 `&mut` 有什么区别、`<'src>` 那个尖括号里的东西是什么、为什么词法器的 token 能"指向"源码而不复制。这一篇会用 `Span` 和 `Lexer` 讲清楚。
