---
title: "并发与 async：线程、Send/Sync 和一个 Tokio 服务"
commentId: "post:rust-by-pebble-14-concurrency-async"
published: "2026-10-13 21:00:00 +08:00"
description: "让 pebble check 并行检查多个文件，再写一个能同时服务很多连接的 Tokio 求值服务器。从 thread::scope、Send/Sync 讲到手写 Future，最后写 pebble-net：成帧、FrameError、select!。"
category: Note
tags:
  - Rust
  - Pebble
  - 并发
  - async
  - Tokio
series: "用 Pebble 从零学 Rust"
seriesOrder: 14
draft: false
comment: true
slug: rust-by-pebble-14-concurrency-async
---

我写了一个八个线程各自对同一个全局 `int` 做一百万次 `counter++` 的 C 程序，跑三遍，得到 1353007、1318802、1344368，期望值是 8000000。不是偶尔错一点：每次都丢掉了大约 83% 的加法，而且每次丢得不一样。C 编译器对这个程序没有任何意见，`gcc` 连警告都没有给。这一篇的主题就是 Rust 怎样让这类程序根本编不过去。我们先用线程把 `pebble check` 变成并行的，然后进入 async：手写一个 `Future`，再用 Tokio 写一个能同时服务很多连接的 Pebble 求值服务器 `pebble-net`。

> [!NOTE] 本篇检查点
> 做完这一篇，你会有 `pebble-net`（一个 Tokio 写的远程求值服务器：长度前缀成帧、带 `source()` 链的 `FrameError`、`select!`、`spawn_blocking`、超时），和命令行的第五版（`pebble check` 一次接受多个文件，每个文件一个线程）。`pebble-net` 与 tag `tutorial-v1` 逐字节一致，`cargo test -p pebble-net` 是 9 个测试，命令行是 3 个单元测试加 12 个集成测试。会用到的 Rust 特性：`thread::spawn`、`thread::scope`、`Send`/`Sync`、`Arc`、`Mutex`、`RwLock`、`mpsc`、`Future`、`Pin`、`Waker`、`async`/`await`、Tokio、`Error::source`、`#[non_exhaustive]`。上一篇在 [FFI 与 no_std](/posts/rust-by-pebble-13-ffi-nostd/)，命令行第四版在 [栈式虚拟机](/posts/rust-by-pebble-12-vm-backends/)。

## 先把工作区补齐

`pebble-net` 依赖前面所有写过的 crate：`pebble-span`、`pebble-diag`、`pebble-ast`、`pebble-parser`、`pebble-value`、`pebble-interp`。如果你一路跟下来，它们都已经在 `crates/` 下了；如果你是跳着来的，把它们从 [tag](https://github.com/bfmhno3/pebble/tree/tutorial-v1) 整个目录复制过来（`pebble-cli` 要用第 12 篇结束时的第四版，下面会升级它）。

根 `Cargo.toml` 的 `[workspace.dependencies]` 需要多两项：`pebble-net` 自己，和 Tokio。把它们加进去（`tokio` 的写法是 TOML 里的"内联表"跨多行，就是这个样子）：

```toml
pebble-net = { path = "crates/pebble-net", version = "0.1.0" }

tokio = { version = "1", features = [
    "rt-multi-thread",
    "net",
    "io-util",
    "macros",
    "sync",
    "time",
    "signal",
] }
```

Tokio 把功能拆成了很多 feature，不开就不编译：`rt-multi-thread` 是多线程运行时，`net` 是 TCP，`io-util` 是 `read_exact` 这类读写辅助，`macros` 是 `#[tokio::main]`、`#[tokio::test]`、`select!`，`sync` 是 Tokio 自己的 `Mutex` 和 `oneshot`，`time` 是 `timeout` 和 `sleep`，`signal` 是 `Ctrl-C`。这一篇每一个我们都会用到。

第 1 篇说过，实验在 `~/rust-lab` 里做，每个实验一个 `src/bin/ch14_<主题>.rs`。这一篇有一半的实验要用 Tokio，我把它们放在另一个独立的 crate `~/lab-ch14-tokio` 里（`Cargo.toml` 在用到的时候给出），免得给 `rust-lab` 添一堆依赖。

## 线程

### 先看 C 里会发生什么

下面是那个丢加法的程序，存成 `ch14_race.c`：

```c
#include <pthread.h>
#include <stdio.h>

static int counter = 0;

static void *work(void *arg) {
    (void)arg;
    for (int i = 0; i < 1000000; i++) counter++;
    return NULL;
}

int main(void) {
    pthread_t t[8];
    for (int i = 0; i < 8; i++) pthread_create(&t[i], NULL, work, NULL);
    for (int i = 0; i < 8; i++) pthread_join(t[i], NULL);
    printf("counter = %d (expected 8000000)\n", counter);
    return 0;
}
```

```text
$ gcc -O0 -Wno-cpp -pthread -o ch14_race ch14_race.c && ./ch14_race
counter = 1353007 (expected 8000000)
$ ./ch14_race
counter = 1318802 (expected 8000000)
$ ./ch14_race
counter = 1344368 (expected 8000000)
```

`counter++` 是读、加、写三步，八个线程交错着做，互相覆盖。这是数据竞争（data race），在 C 和 C++ 里是未定义行为，不只是"结果不对"：编译器可以假设你的程序里没有它，然后基于这个假设优化。检测它要靠运行时工具（ThreadSanitizer），而且只能抓到跑到的那一次。

### Rust 的第一道关：spawn 要求闭包拥有它用到的东西

Rust 的标准线程是 `std::thread::spawn`，它接受一个闭包，在新线程里运行，返回一个 `JoinHandle`。我们先写一个看起来最自然的版本，实验 `ch14_spawn.rs`：

```rust
use std::thread;

fn main() {
    let files = vec!["fib.pebble".to_string(), "hello.pebble".to_string()];

    let handle = thread::spawn(|| {
        println!("checking {} files", files.len());
    });

    handle.join().unwrap();
}
```

```text
$ cargo build --bin ch14_spawn
error[E0373]: closure may outlive the current function, but it borrows `files`, which is owned by the current function
 --> src/bin/ch14_spawn.rs:6:32
  |
6 |     let handle = thread::spawn(|| {
  |                                ^^ may outlive borrowed value `files`
7 |         println!("checking {} files", files.len());
  |                                       ----- `files` is borrowed here
  |
note: function requires argument type to outlive `'static`
 --> src/bin/ch14_spawn.rs:6:18
  |
6 |       let handle = thread::spawn(|| {
  |  __________________^
7 | |         println!("checking {} files", files.len());
8 | |     });
  | |______^
help: to force the closure to take ownership of `files` (and any other referenced variables), use the `move` keyword
  |
6 |     let handle = thread::spawn(move || {
  |                                ++++

For more information about this error, try `rustc --explain E0373`.
error: could not compile `rust-lab` (bin "ch14_spawn") due to 1 previous error
```

在这个程序里 `handle.join()` 就在下面，`files` 其实活得足够久。但编译器看的是 `thread::spawn` 的签名，而不是你的意图。它要求闭包是 `'static`（第 4 篇讲过：不借用任何会消失的局部变量），因为 `spawn` 返回之后线程可以活得比当前函数更久，你甚至可以把 `JoinHandle` 丢掉，让线程自己飞。C 里的 `pthread_create(&t, NULL, work, &local)` 把指向栈变量的指针传给新线程，是同一类错误，编译器不会拦你，悬空指针要到运行时才爆。

提示已经给了答案：`move`。闭包把 `files` 整个搬进去，主线程再也不能用它：

```rust
let handle = thread::spawn(move || {
    println!("checking {} files", files.len());
    files.len()
});

let n = handle.join().unwrap();
println!("the thread returned {n}");
```

```text
$ cargo run --quiet --bin ch14_spawn_move
checking 2 files
the thread returned 2
```

（完整文件是 `ch14_spawn_move.rs`。）`join()` 返回 `Result<T, Box<dyn Any + Send>>`，`T` 是闭包的返回值，`Err` 是线程 panic 时带出来的 payload，第 13 篇的 `catch_unwind` 里见过同一个类型。所以 `.join().unwrap()` 的意思是"等线程结束，拿结果，如果它 panic 了我也 panic"。

### `thread::scope`：借用，但保证线程先结束

`move` 的代价是所有权被拿走。`pebble check` 要做的是让 N 个线程各自读取 `args.files` 里的一项，读完就结束，我们显然不想把整个 `Vec<PathBuf>` 克隆 N 份。这正是 `thread::scope`（Rust 1.63 稳定）的用处，实验 `ch14_scope.rs`：

```rust
use std::thread;

fn main() {
    let files = vec!["fib.pebble".to_string(), "hello.pebble".to_string()];

    let lengths: Vec<usize> = thread::scope(|scope| {
        let handles: Vec<_> = files
            .iter()
            .map(|name| scope.spawn(|| name.len()))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });

    println!("{lengths:?}");
    println!("still own {} files", files.len());
}
```

```text
$ cargo run --quiet --bin ch14_scope
[10, 12]
still own 2 files
```

`thread::scope` 接受一个闭包，闭包拿到一个 `scope`；通过 `scope.spawn` 创建的线程可以借用作用域外面的变量，因为 `thread::scope` 在返回之前一定会等所有这些线程结束。编译器因此可以放心地把 `'static` 的要求放宽成"至少活到这个 `scope` 结束"。这是 RAII 在线程上的应用：作用域结束 = `join`，没法忘记。如果你熟悉 C++20 的 `std::jthread`，它的析构函数会自动 `join`，思路接近；区别是 `jthread` 不阻止你把一个会悬空的引用传进去，`scope` 阻止。

注意最后一行：`files` 还在，而且我们同时让两个线程借用了它。共享的只读借用 `&T`，天然可以同时存在很多个。那共享的可变借用呢？实验 `ch14_race.rs` 用 Rust 复刻上面的 C 程序：

```rust
let mut counter = 0u32;

thread::scope(|scope| {
    for _ in 0..2 {
        scope.spawn(|| {
            for _ in 0..1000 {
                counter += 1;
            }
        });
    }
});
```

```text
$ cargo build --bin ch14_race
error[E0499]: cannot borrow `counter` as mutable more than once at a time
  --> src/bin/ch14_race.rs:8:25
   |
 6 |       thread::scope(|scope| {
   |                      ----- has type `&'1 Scope<'1, '_>`
 7 |           for _ in 0..2 {
 8 |               scope.spawn(|| {
   |               -           ^^ `counter` was mutably borrowed here in the previous iteration of the loop
   |  _____________|
   | |
 9 | |                 for _ in 0..1000 {
10 | |                     counter += 1;
   | |                     ------- borrows occur due to use of `counter` in closure
11 | |                 }
12 | |             });
   | |______________- argument requires that `counter` is borrowed for `'1`
   |
note: requirement that the value outlives `'1` introduced here
  --> /rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/std/src/thread/scoped.rs:203:34

For more information about this error, try `rustc --explain E0499`.
error: could not compile `rust-lab` (bin "ch14_race") due to 1 previous error
```

这就是第 2 篇的"别名与修改不能共存"规则，一个字没变。数据竞争的定义是"两个以上的线程同时访问同一块内存，其中至少一个在写，且没有同步"；"可变借用是独占的"这条规则恰好把前两个条件拆掉了。所以 Rust 里的数据竞争在安全代码里根本写不出来，不需要额外的线程规则。线程专属的规则只有两条，下面讲。

### Send 和 Sync

第 13 篇提过：`Send` 的意思是"这个值可以被移动到另一个线程"，`Sync` 的意思是"`&T` 可以同时被多个线程拿着"。两者都是自动 trait，编译器看字段推导。它们之间有一条恒等式：`T: Sync` 当且仅当 `&T: Send`。

`thread::spawn` 的签名里有 `F: Send + 'static`，`scope.spawn` 里有 `F: Send + 'scope`。所以任何一个被闭包捕获的东西如果不是 `Send`，就上不了线程。实验 `ch14_rc_send.rs`，把第 8 篇的 `Rc` 送进线程：

```rust
let shared = Rc::new(5);
let clone = Rc::clone(&shared);

let handle = thread::spawn(move || {
    println!("in the thread: {clone}");
});
```

```text
$ cargo build --bin ch14_rc_send
error[E0277]: `Rc<i32>` cannot be sent between threads safely
  --> src/bin/ch14_rc_send.rs:8:32
   |
 8 |       let handle = thread::spawn(move || {
   |                    ------------- ^------
   |                    |             |
   |  __________________|_____________within this `{closure@src/bin/ch14_rc_send.rs:8:32: 8:39}`
   | |                  |
   | |                  required by a bound introduced by this call
 9 | |         println!("in the thread: {clone}");
10 | |     });
   | |_____^ `Rc<i32>` cannot be sent between threads safely
   |
   = help: within `{closure@src/bin/ch14_rc_send.rs:8:32: 8:39}`, the trait `Send` is not implemented for `Rc<i32>`
note: required because it's used within this closure
  --> src/bin/ch14_rc_send.rs:8:32
   |
 8 |       let handle = thread::spawn(move || {
   |                                ^^^^^^^
note: required by a bound in `spawn`
  --> /rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/std/src/thread/functions.rs:125:0

For more information about this error, try `rustc --explain E0277`.
error: could not compile `rust-lab` (bin "ch14_rc_send") due to 1 previous error
```

第 8 篇说过 `Rc` 的计数是非原子的。两个线程各自 `clone` 或者 `drop`，计数器的读改写就会像上面那个 C 程序一样互相覆盖，最后要么泄漏，要么释放两次。`Rc` 没有实现 `Send` 这件事，正是为了阻止这种情况，编译器用 `Rc` 这个类型的名字就拒绝了，不需要分析任何数据流。C++ 的 `shared_ptr` 选了另一条路：计数永远是原子的，无论你用不用得上；Rust 选择在类型里让你为"用不用得上"付账：单线程用 `Rc`，便宜；跨线程用 `Arc`，贵一点。

`Sync` 的反例是 `Cell`。第 11 篇的 `Cell<bool>` 允许通过 `&self` 修改，单线程里完全安全，但两个线程各拿一个 `&Cell` 就是数据竞争了。实验 `ch14_cell_sync.rs`：

```rust
let hits = Cell::new(0u32);

thread::scope(|scope| {
    scope.spawn(|| hits.set(hits.get() + 1));
    scope.spawn(|| hits.set(hits.get() + 1));
});
```

```text
$ cargo build --bin ch14_cell_sync
error[E0277]: `Cell<u32>` cannot be shared between threads safely
 --> src/bin/ch14_cell_sync.rs:8:21
  |
8 |         scope.spawn(|| hits.set(hits.get() + 1));
  |               ----- ^^^^^^^^^^^^^^^^^^^^^^^^^^^ `Cell<u32>` cannot be shared between threads safely
  |               |
  |               required by a bound introduced by this call
  |
  = help: the trait `Sync` is not implemented for `Cell<u32>`
  = note: if you want to do aliasing and mutation between multiple threads, use `std::sync::RwLock` or `std::sync::atomic::AtomicU32` instead
  = note: required for `&Cell<u32>` to implement `Send`
note: required because it's used within this closure
 --> src/bin/ch14_cell_sync.rs:8:21
  |
8 |         scope.spawn(|| hits.set(hits.get() + 1));
  |                     ^^
note: required by a bound in `Scope::<'scope, 'env>::spawn`
 --> /rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/std/src/thread/scoped.rs:201:4

For more information about this error, try `rustc --explain E0277`.
error: could not compile `rust-lab` (bin "ch14_cell_sync") due to 1 previous error
```

注意 `required for &Cell<u32> to implement Send` 这一行，就是上面那条恒等式。编译器甚至推荐了两个替代品：`RwLock` 和原子类型。

我们已经见过的类型分成这么几类。实验 `ch14_send_sync_table.rs` 让编译器当裁判：

```rust
fn is_send<T: Send>() {}
fn is_sync<T: Sync>() {}

fn main() {
    is_send::<String>();
    is_sync::<String>();
    is_send::<Arc<Mutex<Vec<u32>>>>();
    is_sync::<Arc<Mutex<Vec<u32>>>>();
    is_send::<Cell<u32>>();
    is_send::<RefCell<u32>>();
    is_send::<Rc<u32>>();
    is_send::<MutexGuard<'static, u32>>();
}
```

```text
$ cargo build --bin ch14_send_sync_table
error[E0277]: `Rc<u32>` cannot be sent between threads safely
  --> src/bin/ch14_send_sync_table.rs:15:15
   |
15 |     is_send::<Rc<u32>>();
   |               ^^^^^^^ `Rc<u32>` cannot be sent between threads safely
   |
   = help: the trait `Send` is not implemented for `Rc<u32>`
note: required by a bound in `is_send`
  --> src/bin/ch14_send_sync_table.rs:5:15
   |
 5 | fn is_send<T: Send>() {}
   |               ^^^^ required by this bound in `is_send`

error[E0277]: `std::sync::MutexGuard<'static, u32>` cannot be sent between threads safely
  --> src/bin/ch14_send_sync_table.rs:16:15
   |
16 |     is_send::<MutexGuard<'static, u32>>();
   |               ^^^^^^^^^^^^^^^^^^^^^^^^ `std::sync::MutexGuard<'static, u32>` cannot be sent between threads safely
   |
   = help: the trait `Send` is not implemented for `std::sync::MutexGuard<'static, u32>`
note: required by a bound in `is_send`
  --> src/bin/ch14_send_sync_table.rs:5:15
   |
 5 | fn is_send<T: Send>() {}
   |               ^^^^ required by this bound in `is_send`

For more information about this error, try `rustc --explain E0277`.
error: could not compile `rust-lab` (bin "ch14_send_sync_table") due to 2 previous errors
```

八行里只有两行被拒绝：`Rc` 和 `MutexGuard`。其余的都过了，包括容易让人意外的两行：`Cell<u32>` 和 `RefCell<u32>` 是 `Send`（把它们整个搬到另一个线程没问题，搬走之后原来的线程再也碰不到它），只是不是 `Sync`（不能让两个线程同时借用）。`Arc<Mutex<Vec<u32>>>` 是 `Send` 加 `Sync`，我们马上就用它。

`MutexGuard` 不是 `Send` 是一个有趣的细节：POSIX 要求"谁加的锁谁解"，把加了锁的 guard 搬到另一个线程去释放，在 pthread 上是未定义行为。Rust 把这个平台约束写进了类型里。这个细节在讲 async 的时候还会再出现一次，而且是个大角色。

> [!NOTE] 编译器怎么知道？
> 这些自动 trait 不是魔法，是组合：一个类型是 `Send` 当且仅当所有字段是 `Send`。`Rc` 内部是一个裸指针（第 13 篇：裸指针故意不是 `Send`），所以传染到了所有包着 `Rc` 的类型。`Arc` 里也有裸指针，但标准库为它写了 `unsafe impl<T: Send + Sync> Send for Arc<T> {}`，一句话"我保证它没问题，原因是它的计数是原子的"。`unsafe impl` 是第 13 篇 `BumpAllocator` 用过的同一个东西。

### Arc 和 Mutex：真正的共享可变

要让多个线程都改同一个值，需要两个零件：一个能被多个线程拥有的指针（`Arc`，原子引用计数，`Rc` 的线程安全版），和一个保证同一时间只有一个线程在改它的锁（`Mutex`）。实验 `ch14_arc_mutex.rs`，Rust 版的计数器：

```rust
let counter = Arc::new(Mutex::new(0u32));

let handles: Vec<_> = (0..8)
    .map(|_| {
        let counter = Arc::clone(&counter);
        thread::spawn(move || {
            for _ in 0..1000 {
                *counter.lock().unwrap() += 1;
            }
        })
    })
    .collect();

for handle in handles {
    handle.join().unwrap();
}

println!("count = {}", *counter.lock().unwrap());
println!("strong count = {}", Arc::strong_count(&counter));
```

```text
$ cargo run --quiet --bin ch14_arc_mutex
count = 8000
strong count = 1
```

八个线程，每个加 1000，8000，正确，每次都一样。`strong count = 1` 说明八个线程结束、闭包被丢弃之后，那八个 `Arc` 克隆都已经释放了。

和 C++ 的 `std::mutex` 比较，`Mutex<T>` 有一个很大的设计差别：**数据在锁里面**。`std::mutex` 和它保护的变量是两个独立的对象，"哪个锁保护哪个变量"只存在于注释和程序员的脑子里，忘了加锁照样编译。`Mutex<u32>` 里装着那个 `u32`，唯一拿到它的办法是 `lock()`，返回一个 `MutexGuard`；guard 实现了 `Deref` 和 `DerefMut`，所以 `*guard += 1` 能用；guard 被丢弃的时候自动解锁（第 13 篇的 `Drop`，对应 C++ 的 `lock_guard`，只是 Rust 里它不是可选的）。实验 `ch14_mutex_forgot_lock.rs` 试着绕过：

```text
$ cargo build --bin ch14_mutex_forgot_lock
error[E0308]: mismatched types
 --> src/bin/ch14_mutex_forgot_lock.rs:5:22
  |
5 |     let guard: u32 = counter.lock().unwrap();
  |                ---   ^^^^^^^^^^^^^^^^^^^^^^^ expected `u32`, found `MutexGuard<'_, u32>`
  |                |
  |                expected due to this
  |
  = note: expected type `u32`
           found struct `std::sync::MutexGuard<'_, u32>`
help: consider dereferencing the type
  |
5 |     let guard: u32 = *counter.lock().unwrap();
  |                      +

For more information about this error, try `rustc --explain E0308`.
error: could not compile `rust-lab` (bin "ch14_mutex_forgot_lock") due to 1 previous error
```

为什么 `lock()` 后面要 `unwrap()`？因为 `lock()` 返回的是 `Result<MutexGuard<T>, PoisonError<...>>`。如果一个线程在持有锁的时候 panic，那个锁就被标记为"中毒"（poisoned）：被保护的数据可能停在一个只改了一半的状态里，标准库不会替你假装没事。实验 `ch14_poison.rs`：

```rust
let data = Arc::new(Mutex::new(vec![1, 2, 3]));

let worker = {
    let data = Arc::clone(&data);
    thread::spawn(move || {
        let mut guard = data.lock().unwrap();
        guard.push(4);
        panic!("worker died while holding the lock");
    })
};
let _ = worker.join();

println!("is_poisoned = {}", data.is_poisoned());
match data.lock() {
    Ok(guard) => println!("clean: {guard:?}"),
    Err(poisoned) => {
        let guard = poisoned.into_inner();
        println!("recovered: {guard:?}");
    }
}
```

```text
$ cargo run --quiet --bin ch14_poison

thread '<unnamed>' (167084) panicked at src/bin/ch14_poison.rs:12:13:
worker died while holding the lock
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
is_poisoned = true
recovered: [1, 2, 3, 4]
```

`PoisonError::into_inner` 把 guard 拿出来，由你决定数据还能不能用。在这个例子里，`push(4)` 已经完成，数据是完整的，所以恢复是合理的。`pebble-net` 里有一个 `SharedOutput`，它用的就是这个写法：`.lock().unwrap_or_else(|poisoned| poisoned.into_inner())`。理由是：它里面只有一个 `Vec<String>`，每次修改都是单独的一次 `push`，不会出现"改了一半"，所以不值得因为别的线程 panic 就让整个服务也跟着 panic。（C++ 的 `std::mutex` 没有中毒的概念：持有锁的线程如果异常展开，`lock_guard` 的析构函数会解锁，数据被改了一半，下一个线程什么也不知道。）

另外两个同类零件，不在 Pebble 里出现，我各用一个小实验确认过它们的行为。`RwLock` 是读写锁：很多读者或者一个写者，对应 C++ 的 `std::shared_mutex`。读多写少、读的时间长的时候才值得换（实验 `ch14_rwlock.rs`）：

```rust
let table = Arc::new(RwLock::new(vec![1, 2, 3]));

let readers: Vec<_> = (0..3)
    .map(|_| {
        let table = Arc::clone(&table);
        thread::spawn(move || table.read().unwrap().len())
    })
    .collect();

table.write().unwrap().push(4);

let lengths: Vec<usize> = readers.into_iter().map(|h| h.join().unwrap()).collect();
println!("every reader saw 3 or 4 elements: {}", lengths.iter().all(|n| (3..=4).contains(n)));
println!("final {:?}", table.read().unwrap());
```

```text
$ cargo run --quiet --bin ch14_rwlock
every reader saw 3 or 4 elements: true
final [1, 2, 3, 4]
```

读者看到的是写之前（3 个元素）还是写之后（4 个），取决于调度；我没有断言具体是哪个，因为那是不确定的。确定的是：没有任何读者看到过"半个 push"。

### 消息传递：mpsc

另一条路是不共享，用消息。`std::sync::mpsc` 是"多生产者、单消费者"的通道，Go 的 `chan` 的亲戚。实验 `ch14_channel.rs`：

```rust
let (sender, receiver) = mpsc::channel::<String>();

let workers: Vec<_> = ["fib", "hello", "errors"]
    .into_iter()
    .map(|name| {
        let sender = sender.clone();
        thread::spawn(move || {
            sender.send(format!("checked {name}.pebble")).unwrap();
        })
    })
    .collect();
drop(sender);

let mut reports: Vec<String> = receiver.iter().collect();
reports.sort();
for report in &reports {
    println!("{report}");
}

for worker in workers {
    worker.join().unwrap();
}
println!("{} reports, channel closed", reports.len());
```

```text
$ cargo run --quiet --bin ch14_channel
checked errors.pebble
checked fib.pebble
checked hello.pebble
3 reports, channel closed
```

`receiver.iter()` 会一直等到所有 `Sender` 都被丢弃才结束。这里的 `drop(sender)` 很关键：我们手里还留着一个原始的 `sender`，不丢掉的话 `receiver.iter()` 永远等不到结尾。（忘了这一行是 mpsc 最常见的死锁，现象是程序卡在 `collect()` 上。）三个线程完成的顺序是不确定的，所以我排了序再打印；通道里消息的到达顺序是真实的调度顺序，不是命令行顺序，下面你会看到 `pebble check` 为什么选择了另一条路：不用通道，而是按顺序 `join`。

最后一个零件上一篇已经见过：原子类型。实验 `ch14_atomic.rs` 把八个线程换成原子计数器，一个 `static REQUESTS: AtomicU64`：

```text
$ cargo run --quiet --bin ch14_atomic
requests = 8000
```

`fetch_add(1, Ordering::Relaxed)` 是一条不可分割的"读加写"指令，同时不需要给其他内存访问排序，所以用最弱的 `Relaxed`（第 13 篇解释过为什么 `BumpAllocator` 里这也够用）。一个独立的计数器，没有锁，没有 `Arc`，因为 `static` 本身就活得足够久。本篇后面的 `Stats` 就是这种东西的候选，这个替换放在练习 2。

## 命令行第五版：并行的 `check`

### 现在的 `check`

第 12 篇结束时，`pebble check` 只接受一个文件，一次读、词法分析加解析、编译、把两份诊断打印出来：

```rust
pub(crate) fn check(args: &FileArgs) -> Result<u8> {
    let source = Source::load(&args.file)?;
    let parsed = parse_program(source.id, source.text());
    let compiled = compile(&parsed.program);
    let mut failed = sources::emit(&parsed.diagnostics, &source.map);
    failed |= sources::emit(&compiled.diagnostics, &source.map);
    Ok(if failed { 1 } else { 0 })
}
```

我想让它接受任意多个文件，每个文件互不相干，是教科书上"天生可并行"的活。第一步是命令行的形状：`pebble check a.pebble b.pebble c.pebble`。在 `crates/pebble-cli/src/cli.rs` 里，`Check` 不再用 `FileArgs`（`tokens` 和 `parse` 还在用它），给它一个自己的参数结构：

```rust
/// Arguments to `pebble check`.
#[derive(Debug, Args)]
pub(crate) struct CheckArgs {
    /// The source files to check; each one is checked on its own thread.
    #[arg(required = true)]
    pub(crate) files: Vec<PathBuf>,
}
```

`Vec<PathBuf>` 让 clap 接受一个或多个位置参数；`required = true` 是说至少要一个（不加的话 `Vec` 的默认是零个或多个，`pebble check` 会静悄悄地什么也不做）。`Command` 枚举里对应的一行也改掉：

```rust
    /// Lex, parse, and compile source files without running them.
    Check(CheckArgs),
```

doc 注释就是帮助文本（第 7 篇），所以这一句话同时改了 `pebble --help` 的输出。

### 第一次尝试：照搬 `thread::spawn`

`commands.rs` 里的 `check` 要对每个文件开一个线程，等所有线程结束，按命令行里的顺序打印结果。我的第一版几乎是从上面的实验里抄的：

```rust
pub(crate) fn check(args: &CheckArgs) -> Result<u8> {
    let reports: Vec<Result<CheckReport>> = {
        let handles: Vec<_> = args
            .files
            .iter()
            .map(|path| thread::spawn(|| check_file(path)))
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().expect("a check thread panicked"))
            .collect()
    };
    // ... print the reports ...
}
```

其中 `check_file(path: &Path) -> Result<CheckReport>` 是我们马上要写的、检查一个文件的函数。编译：

```text
error[E0521]: borrowed data escapes outside of function
   --> crates/pebble-cli/src/commands.rs:106:25
    |
101 | pub(crate) fn check(args: &CheckArgs) -> Result<u8> {
    |                     ----  - let's call the lifetime of this reference `'1`
    |                     |
    |                     `args` is a reference that is only valid in the function body
...
106 |             .map(|path| thread::spawn(|| check_file(path)))
    |                         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    |                         |
    |                         `args` escapes the function body here
    |                         argument requires that `'1` must outlive `'static`
```

和上面的 `E0373` 同一个原因，只不过这次借用来自函数参数：`path` 指向 `args.files` 里面，`args` 是函数参数借来的引用，`thread::spawn` 要求 `'static`，所以不行。两条出路：要么把 `PathBuf` 克隆一份 `move` 进去，要么用 `thread::scope`。克隆在这里没毛病，但 `scope` 让这件事成了一个类型层面的保证（线程不会逃出函数），而且根本不用想"克隆谁"。

### 第二次尝试：把编译结果也带回来

用 `thread::scope`，`check_file` 在线程里跑，返回什么？我最先想到的是返回一个包含 `Compiled` 的结构（"以后别的子命令也许想用"）。我把它写出来试了，作为一次对照：

```rust
struct CheckReport {
    rendered: String,
    failed: bool,
    compiled: pebble_bytecode::Compiled,
}
```

```text
error[E0277]: `Rc<FunctionProto>` cannot be sent between threads safely
   --> crates/pebble-cli/src/commands.rs:107:31
    |
107 |             .map(|path| scope.spawn(|| check_file(path)))
    |                               ^^^^^ `Rc<FunctionProto>` cannot be sent between threads safely
    |
    = help: within `Result<CheckReport, anyhow::Error>`, the trait `Send` is not implemented for `Rc<FunctionProto>`
note: required because it appears within the type `Compiled`
   --> crates/pebble-bytecode/src/lib.rs:371:12
    |
371 | pub struct Compiled {
    |            ^^^^^^^^
note: required because it appears within the type `CheckReport`
   --> crates/pebble-cli/src/commands.rs:90:8
    |
 90 | struct CheckReport {
    |        ^^^^^^^^^^^
note: required because it appears within the type `Result<CheckReport, anyhow::Error>`
   --> /rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/core/src/result.rs:557:9
note: required by a bound in `Scope::<'scope, 'env>::spawn`
   --> /rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/std/src/thread/scoped.rs:201:4
```

第 12 篇我提过这件事：第 10 篇的 `Compiled` 里装着 `Rc<FunctionProto>`，所以它不是 `Send`。线程的返回值要从子线程交回主线程，所以必须是 `Send`。编译器的 `note: required because it appears within the type ...` 一路追到 `Rc`，和上面 `ch14_send_sync_table` 的逻辑一模一样。

那 Pebble 里别的东西谁能过这一关？我写了一个临时的测试文件，让编译器逐个裁决（这是一个探针，不进仓库）：

```rust
fn assert_send<T: Send>() {}

#[test]
fn probe() {
    assert_send::<pebble_span::SourceMap>();
    assert_send::<pebble_ast::Program>();
    assert_send::<Vec<pebble_diag::Diagnostic>>();
    assert_send::<pebble_bytecode::Compiled>();
    assert_send::<pebble_interp::Interpreter>();
    assert_send::<pebble_value::Value>();
}
```

编译器对前三行一声不吭，对后三行各给了一段错误。我把每个错误的第一行和关键的 `help` 行摘出来：

```text
error[E0277]: `Rc<FunctionProto>` cannot be sent between threads safely
  = help: within `Compiled`, the trait `Send` is not implemented for `Rc<FunctionProto>`
error[E0277]: `Rc<RefCell<Env>>` cannot be sent between threads safely
  = help: within `Interpreter`, the trait `Send` is not implemented for `Rc<RefCell<Env>>`
error[E0277]: `(dyn pebble_value::Output + 'static)` cannot be sent between threads safely
  = help: the trait `Send` is not implemented for `(dyn pebble_value::Output + 'static)`
error[E0277]: `Rc<str>` cannot be sent between threads safely
  = help: within `pebble_value::Value`, the trait `Send` is not implemented for `Rc<str>`
error[E0277]: `Rc<RefCell<Vec<pebble_value::Value>>>` cannot be sent between threads safely
  = help: within `pebble_value::Value`, the trait `Send` is not implemented for `Rc<RefCell<Vec<pebble_value::Value>>>`
error[E0277]: `Rc<RefCell<HashMap<MapKey, pebble_value::Value>>>` cannot be sent between threads safely
  = help: within `pebble_value::Value`, the trait `Send` is not implemented for `Rc<RefCell<HashMap<MapKey, pebble_value::Value>>>`
error[E0277]: `Rc<pebble_value::Function>` cannot be sent between threads safely
  = help: within `pebble_value::Value`, the trait `Send` is not implemented for `Rc<pebble_value::Function>`
error: could not compile `pebble-cli` (test "send_probe") due to 7 previous errors
```

（我省略了每个错误后面那几段 `note: required because ...` 和 `note: required by a bound in assert_send`，没有改动任何一行。）

结论很整齐：**前端是 `Send`，后端不是。** `SourceMap`、`Program`（整个 AST）、`Vec<Diagnostic>` 都是普通的拥有型数据：`String`、`Vec`、`Box`，没有 `Rc`。后端的东西，`Compiled`（`Rc<FunctionProto>`）、`Interpreter`（`Rc<RefCell<Env>>`，加一个 `Box<dyn Output>`，第 8 篇里没写 `+ Send`，所以连输出这个 trait 对象都不让过）、`Value`（第 8 篇的所有 `Rc`）全都被 `Rc` 污染了。

回头看第 5 篇的那个决定：AST 的节点拥有自己的 `String`，而不是借用源码。我当时说这能让 AST 活得久，还能跨线程。我并没有在那时验证，现在上面这三行 `assert_send` 就是验证。

### 解决办法：线程里造，线程里用，只送文本出来

既然 `Compiled` 过不了边界，那就别让它过：检查一个文件需要的东西全部在线程里创建，用完在线程里丢弃，只有一份纯文本的报告（一个 `String` 和一个 `bool`）穿过线程边界。写一个 `CheckReport`，再写 `check_file`，在 `crates/pebble-cli/src/commands.rs` 里，放在 `parse` 和 `bench` 之间：

```rust
/// The outcome of checking one file: its rendered diagnostics and whether any
/// of them is an error.
struct CheckReport {
    rendered: String,
    failed: bool,
}
```

```rust
/// Checks one file. Everything non-`Send` (the compiled chunk holds `Rc`s)
/// stays inside this function; only the rendered text leaves the thread.
fn check_file(path: &Path) -> Result<CheckReport> {
    let source = Source::load(path)?;
    let parsed = parse_program(source.id, source.text());
    let compiled = compile(&parsed.program);

    let mut rendered = sources::render(&parsed.diagnostics, &source.map);
    rendered.push_str(&sources::render(&compiled.diagnostics, &source.map));
    let failed =
        sources::has_errors(&parsed.diagnostics) || sources::has_errors(&compiled.diagnostics);
    Ok(CheckReport { rendered, failed })
}
```

`sources::render` 和 `sources::has_errors` 在第 7 篇的 `sources.rs` 里就有了，只是 `emit` 把它们粘在了一起，直接打印到 `stderr`；现在我们要先把文字留着，所以用的是拆开的那一半。`Compiled` 在函数末尾和 `compiled` 变量一起被丢弃，线程根本不知道它存在过。`Result<CheckReport>` 里的错误是 `anyhow::Error`，它是 `Send`（上面第二次尝试的报错里没有提它，说明它过了关）。

然后是 `check` 本身：

```rust
/// `pebble check`: lex, parse, and compile every file, each on its own thread,
/// then print the reports in command-line order.
///
/// # Errors
/// Returns the first host-level failure (such as an unreadable file), in
/// command-line order.
pub(crate) fn check(args: &CheckArgs) -> Result<u8> {
    let reports: Vec<Result<CheckReport>> = thread::scope(|scope| {
        let handles: Vec<_> = args
            .files
            .iter()
            .map(|path| scope.spawn(|| check_file(path)))
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().expect("a check thread panicked"))
            .collect()
    });

    let mut failed = false;
    for report in reports {
        let report = report?;
        eprint!("{}", report.rendered);
        failed |= report.failed;
    }
    Ok(u8::from(failed))
}
```

逐段看：

- 第一个 `collect` 把每个 `scope.spawn(...)` 返回的 `ScopedJoinHandle` 收进一个 `Vec`。这一步必须先 `collect` 再 `join`：迭代器是惰性的，如果写成一条链 `.map(spawn).map(join)`，每个元素都是"开一个线程，马上等它，再处理下一个"，等于顺序执行。实验 `ch14_lazy_join.rs` 让四个线程各睡 100 毫秒，链式写法 `~400 ms`，先 `collect` 再 `join` 是 `~100 ms`（输出的毫秒数我按 100 取了整，两种写法的结果列表都是 `[0, 1, 2, 3]`）。
- 第二个 `collect` 按文件在命令行里的顺序 `join`，每个 `join` 得到 `Result<CheckReport>`，所以 `reports` 是 `Vec<Result<CheckReport>>`。输出顺序因此和命令行一致，和哪个线程先完成无关。用上面的 `mpsc` 做的话，顺序会是完成顺序，每次不同。
- `expect("a check thread panicked")`：线程 panic 是 bug，不是用户的输入问题。我们不想把它翻译成漂亮的错误，让它继续 panic。
- 最后的 `for` 才打印。第一个遇到的主机错误（比如文件不存在）用 `?` 直接返回，和之前一样，`main` 会把它打印成 `pebble: ...` 并退出码 1。
- `u8::from(failed)`：`bool` 到 `u8` 的转换，`false` 是 0，`true` 是 1，不用写 `if failed { 1 } else { 0 }`。

模块顶部多了两个 `use`，`use std::path::Path;` 和 `use std::thread;`，`cli::{...}` 的导入列表里多一个 `CheckArgs`。`main.rs` 一个字都不用改：`Command::Check(args) => commands::check(&args)` 里的 `args` 类型是由 `Command::Check` 的载荷决定的，我们改了载荷，`check` 的参数类型也跟着改，两边自然对上。

### 两个新测试

在 `crates/pebble-cli/tests/cli.rs` 末尾追加两个集成测试（第 7 篇的 `pebble()` 和 `pebble_output()` 两个辅助函数已经在了）：

```rust
#[test]
fn check_reports_only_the_broken_file() {
    let output = pebble_output(&[
        "check",
        "examples/fib.pebble",
        "examples/errors.pebble",
        "examples/hello.pebble",
    ]);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty(), "check prints nothing to stdout");

    let stderr = String::from_utf8(output.stderr).expect("stderr is UTF-8");
    assert!(stderr.contains("examples/errors.pebble"), "{stderr}");
    assert!(!stderr.contains("examples/fib.pebble"), "{stderr}");
}

#[test]
fn check_requires_a_file() {
    pebble().arg("check").assert().code(2);
}
```

第一个测试检查三件事：退出码是 1（有一个文件坏了），`stdout` 为空（`check` 什么也不打印到标准输出），错误只提到坏文件。第二个测试检查 `required = true`：没有文件，clap 自己报用法错误，退出码 2。

### 真实运行

```text
$ pebble check examples/fib.pebble examples/errors.pebble examples/hello.pebble; echo "exit=$?"
error[E1001]: expected an expression, found `;`
 --> examples/errors.pebble:5:17
  |
5 | let total = 1 + ;
  |                 ^

exit=1
```

三个文件检查，只有 `errors.pebble` 有输出，退出码 1。（上面的命令我是用 `cargo run -q -p pebble-cli -- check ...` 跑的；`pebble` 是它构建出来的二进制。）

```text
$ pebble check examples/fib.pebble examples/hello.pebble examples/closures.pebble; echo "exit=$?"
exit=0
$ pebble check; echo "exit=$?"
error: the following required arguments were not provided:
  <FILES>...

Usage: pebble check <FILES>...

For more information, try '--help'.
exit=2
$ pebble check examples/fib.pebble nope.pebble examples/errors.pebble; echo "exit=$?"
pebble: cannot read nope.pebble: No such file or directory (os error 2)
exit=1
```

第三条命令的细节值得停一下：`nope.pebble` 排在中间，`errors.pebble` 在它后面也有错，但输出里只有"读不了文件"这一条。原因是 `for report in reports` 按顺序走，第一个 `?` 遇到 `Err` 就返回了，后面的诊断根本没打印。这是一个我选的行为，不是一个必然：也可以收集所有错误一起报，那是另一个设计，这里不做。

线程到底带来了多少好处？我用 `hyperfine` 量了一次，被检查的文件是一个脚本生成的 8000 行、630 KB 的 Pebble 文件（每行一个小函数），`release` 构建：

```text
$ hyperfine -N "pebble check big.pebble" "pebble check big.pebble big.pebble big.pebble big.pebble big.pebble big.pebble big.pebble big.pebble"
Time (mean ± σ):     259.9 ms ±   8.9 ms    [User: 226.5 ms, System: 32.3 ms]
Time (mean ± σ):     581.2 ms ±   9.0 ms    [User: 3878.7 ms, System: 462.7 ms]
$ hyperfine "for i in 1 2 3 4 5 6 7 8; do pebble check big.pebble; done"
Time (mean ± σ):      2.102 s ±  0.015 s    [User: 1.821 s, System: 0.273 s]
```

一个文件 260 ms；八个文件同一次调用并行：581 ms；八次顺序调用：2.102 s。快了 3.6 倍，在一台 16 个逻辑核的机器上，当时机器上还有别的编译任务在跑，所以这个数字不干净。更有意思的是 `User` 一栏：八份工作总共用了 3.9 s 的 CPU 时间，顺序跑只用 1.8 s。我没有去查原因，我怀疑是八个线程抢同一个内存分配器和缓存，但这是猜测。

还有一件我顺手量到的事：同样的文件放大到 60000 行（4.8 MB），单个文件的 `pebble check` 要 34.9 s。行数多了 7.5 倍，时间多了 134 倍，指数大约是 2.4，至少是平方级的增长。我没有去追它在哪里（词法、解析、编译三段里的某一段），这不是这一篇的主题；如果你想练习性能分析，这是一个现成的靶子。

## async：不开线程，也能同时等很多东西

### 一个线程一个连接，贵在哪

线程够用的话，为什么还要 async？先看 `pebble-net` 要面对的场景：一个服务器，同一时刻有很多客户端连着，其中绝大多数在等：等网络、等对方发下一个字节。如果一个连接占一个线程，大部分线程就是在睡觉。睡觉不是不花钱：每个线程要有自己的栈，内核要为它建调度结构。

我做了一个实验，不是为了证明"线程不行"（它比我预想的行得多），而是为了知道差距的量级：同时启动 10 万个"睡 500 毫秒然后返回编号"的单位，一边用线程，一边用 Tokio 的任务（`tokio::spawn`，马上就会讲），`release` 构建，用 GNU `time` 量最大内存。这两个程序是 `ch14_many_threads.rs` 和 `ch14_many_tasks.rs`，在 `~/lab-ch14-tokio` 里（完整的 `Cargo.toml` 在本章后面给出）：

```text
$ ch14_many_threads 100000
100000 threads, sum 4999950000, took ~3900 ms
874388 KB max RSS, 3.95 s wall
$ ch14_many_tasks
100000 tasks, sum 4999950000, took ~500 ms
size of one future: 120 bytes
41128 KB max RSS, 0.54 s wall
```

10 万个线程，3.95 s，近 874 MB；10 万个任务，0.54 s，41 MB。差了一个数量级，而且任务这一边的 0.5 s 里有 0.5 s 是睡眠本身。注意最后一行：一个"睡 500 毫秒再返回"的 `async` 块，整个状态只有 120 字节。线程的栈在虚拟地址上是 MB 级的。（作为对比：同样的线程程序启动 1 万个线程，在 debug 构建下用 `cargo run` 跑是 `~700 ms`，所以线程在几千个这个量级上完全没问题；C10k 问题是 10 万级的问题。）

C 世界对这个问题的标准回答是 `epoll` 加手写的状态机：每个连接一个结构体，记录"我读到哪了"，一个循环 `epoll_wait`，哪个套接字可读就调用对应状态机往前推一步。`async`/`await` 的本质是让编译器替你写这些状态机，而你写的是看上去顺序执行的代码。

### 并发不是并行

先看一眼它的效果。实验 `ch14_join.rs`（在 `~/lab-ch14-tokio/src/bin/`）模拟两个各要 200 毫秒的"检查"：

```rust
use std::time::{Duration, Instant};
use tokio::time::sleep;

async fn check(name: &str, millis: u64) -> String {
    sleep(Duration::from_millis(millis)).await;
    format!("checked {name}")
}

#[tokio::main]
async fn main() {
    let start = Instant::now();
    let a = check("fib", 200).await;
    let b = check("hello", 200).await;
    println!("{a}, {b}: sequential took {} ms", start.elapsed().as_millis() / 50 * 50);

    let start = Instant::now();
    let (a, b) = tokio::join!(check("fib", 200), check("hello", 200));
    println!("{a}, {b}: join! took {} ms", start.elapsed().as_millis() / 50 * 50);
}
```

```text
$ cargo run --quiet --bin ch14_join
checked fib, checked hello: sequential took 400 ms
checked fib, checked hello: join! took 200 ms
```

（毫秒数按 50 取整。）依次 `.await` 是 400 ms，`join!` 是 200 ms，而且不需要第二个线程：`join!` 在同一个任务里轮流 `poll` 两个 `Future`。两个 `sleep` 同时在等，这叫并发（concurrency）：多件事在重叠地"进行中"。并行（parallelism）是多件事在同一时刻真的被不同的核执行。`join!` 是并发，没有并行；上一节的 `thread::scope` 是并行。

要看懂 `join!` 为什么能做到这一点，得知道 `async fn` 背后的东西。我们不去读 Tokio 的源码，而是用标准库自己写一遍。

### 手写一个 `Future`

`Future` 是标准库里的 trait，简化后是这样：

```rust
pub trait Future {
    type Output;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output>;
}

pub enum Poll<T> {
    Ready(T),
    Pending,
}
```

一个 `Future` 就是一个"可以被问 `poll`"的状态机：被问到的时候，要么说"完成了，结果是 `T`"（`Ready`），要么说"还没好"（`Pending`）。`Pending` 的同时，它必须保证在将来能继续推进的时候通知执行者，通知的渠道是 `Context` 里的 `Waker`。**`Future` 自己什么都不会做**，必须有人反复 `poll` 它：这是 Rust 的 `async` 和 JavaScript 的 `Promise` 最大的区别，`Promise` 创建就开始跑，`Future` 不被 `poll` 就一动不动。

下面是实验 `ch14_manual_future.rs`，零依赖，从头写一个能跑起来的最小系统。文件开头是这些导入和一个计数器（`POLLS` 只用来数一共 `poll` 了几次，方便下面看输出）：

```rust
use std::future::Future;
use std::pin::{Pin, pin};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};
use std::thread::{self, Thread};
use std::time::{Duration, Instant};

static POLLS: AtomicUsize = AtomicUsize::new(0);
```

先来第一个 `Future`，一个倒数：

```rust
struct CountDown {
    remaining: u32,
}

impl Future for CountDown {
    type Output = &'static str;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<&'static str> {
        if self.remaining == 0 {
            Poll::Ready("liftoff")
        } else {
            println!("  CountDown::poll, {} left", self.remaining);
            self.remaining -= 1;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }
}
```

每次被 `poll`，它减一，说"还没好"，同时告诉 `Waker`"请马上再来问我"（`wake_by_ref`）。`self: Pin<&mut Self>` 这个奇怪的接收者类型先放一放，下面讲。

要运行它，需要一个执行者。最简单的执行者叫 `block_on`：在当前线程里循环 `poll`，`Pending` 就让线程睡觉，等 `Waker` 把它叫醒。需要一个会"叫醒线程"的 `Waker`，标准库提供了 `Wake` trait，实现一个方法就行：

```rust
struct ThreadWaker(Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}
```

`thread::park()` 让当前线程睡到别人 `unpark` 它为止，`unpark` 是别的线程（或者自己）发的"醒醒"。`Waker::from(Arc<W: Wake>)` 把它包装成 `Waker`。`block_on` 本身：

```rust
fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    let waker = Waker::from(Arc::new(ThreadWaker(thread::current())));
    let mut cx = Context::from_waker(&waker);
    loop {
        POLLS.fetch_add(1, Ordering::Relaxed);
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(value) => return value,
            Poll::Pending => thread::park(),
        }
    }
}
```

（`POLLS` 是一个 `static AtomicUsize`，只用来数一共 `poll` 了几次，方便下面看输出。）这里有 `pin!(future)`、`as_mut()`，也是 `Pin` 的事情，一会儿解释。先看结果：

```text
$ cargo run --quiet --bin ch14_manual_future
countdown:
  CountDown::poll, 3 left
  CountDown::poll, 2 left
  CountDown::poll, 1 left
liftoff after 4 polls
```

三次 `Pending`，第四次 `Ready`，`poll` 了 4 次。每一次 `Pending` 之后，`block_on` 调用了 `thread::park()`，但因为 `CountDown` 已经在 `poll` 里面调用了 `wake_by_ref`（先 `unpark` 了），`park` 立刻返回，所以这个例子里线程实际上没睡过。要看到真正的睡眠，需要一个真的会等的 `Future`：

```rust
struct Shared {
    done: bool,
    waker: Option<Waker>,
}

struct Delay {
    shared: Arc<Mutex<Shared>>,
}
```

`Delay::new(duration)` 起一个普通线程，睡 `duration`，然后设置 `done = true`，并且如果有人留下了 `Waker`，就调用它：

```rust
impl Delay {
    fn new(duration: Duration) -> Self {
        let shared = Arc::new(Mutex::new(Shared {
            done: false,
            waker: None,
        }));
        let thread_shared = Arc::clone(&shared);
        thread::spawn(move || {
            thread::sleep(duration);
            let mut state = thread_shared.lock().unwrap();
            state.done = true;
            if let Some(waker) = state.waker.take() {
                waker.wake();
            }
        });
        Delay { shared }
    }
}
```

`Delay` 的 `poll`（它同样 `impl Future for Delay`，`type Output = ();`）：

```rust
fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
    let mut state = self.shared.lock().unwrap();
    if state.done {
        Poll::Ready(())
    } else {
        state.waker = Some(cx.waker().clone());
        Poll::Pending
    }
}
```

每次没好的时候，把当前的 `Waker` 存起来（`clone` 一份，`Waker` 是个小的引用计数句柄）。这里线程、`Arc`、`Mutex` 都是本章前半部分的东西：`Delay` 的状态在两个线程之间共享，所以必须是 `Arc<Mutex<_>>`。（真正的 Tokio 不会为每个定时器起一个线程；它的定时器是挂在运行时的一个全局轮子上。但"没好就留下 Waker，好了就叫它"这个结构是一样的。）

最后用 `async fn` 把两个 `Delay` 串起来：

```rust
async fn two_delays() -> u32 {
    println!("  two_delays starts");
    Delay::new(Duration::from_millis(50)).await;
    println!("  first delay done");
    Delay::new(Duration::from_millis(50)).await;
    println!("  second delay done");
    42
}
```

`main` 里先跑上面的 `CountDown`，再 `block_on(two_delays())`，打印一共 `poll` 了几次，以及 `size_of_val` 一个没被运行过的 `two_delays()`：

```rust
fn main() {
    println!("countdown:");
    let message = block_on(CountDown { remaining: 3 });
    println!("{message} after {} polls", POLLS.swap(0, Ordering::Relaxed));

    println!("two delays:");
    let start = Instant::now();
    let answer = block_on(two_delays());
    let elapsed = start.elapsed();
    println!("answer {answer} after {} polls", POLLS.swap(0, Ordering::Relaxed));
    println!("took at least 100 ms: {}", elapsed >= Duration::from_millis(100));

    println!("size of the async fn future: {} bytes", std::mem::size_of_val(&two_delays()));
}
```

第二段的输出：

```text
two delays:
  two_delays starts
  first delay done
  second delay done
answer 42 after 3 polls
took at least 100 ms: true
size of the async fn future: 16 bytes
```

三次 `poll`：第一次开始运行，打印 `two_delays starts`，创建第一个 `Delay`，`poll` 它，`Pending`，整个 `two_delays` 也 `Pending`，`block_on` 睡眠；50 毫秒后 `Delay` 的线程叫醒它，第二次 `poll` 从第一个 `.await` 之后继续，打印 `first delay done`，创建第二个 `Delay`，又 `Pending`；第三次 `poll` 跑完，返回 42。总共至少 100 毫秒，`true`。

最后一行也有意思。`async fn` 的返回值是一个编译器生成的匿名类型，这里只有 16 字节，里面存的是"我停在第几个 `.await`"和跨 `.await` 活着的局部变量。这就是前面说的"编译器写的状态机"：没有被 `poll` 过的时候，它什么都没做（那个只用来量大小的 `two_delays()` 从未被 `poll`，所以输出里没有第二行 `two_delays starts`：调用 `two_delays()` 只是构造了状态机，没有运行）。

### `Pin`：为什么 `poll` 的 self 那么奇怪

`async fn` 里的局部变量可以互相引用。看实验 `ch14_pin_new.rs`：

```rust
use std::pin::Pin;

async fn answer() -> u32 {
    let local = [1u32, 2, 3];
    let reference = &local[0];
    std::future::ready(()).await;
    *reference
}

fn main() {
    let mut future = answer();
    let _pinned = Pin::new(&mut future);
}
```

`reference` 指向 `local`，两个都跨过了那个 `.await`，所以它们都要存在状态机里面：状态机里有一个字段指向它自己的另一个字段，一个自引用结构。如果这个状态机在两次 `poll` 之间被移动（`memcpy` 到别处），`reference` 还指着旧地址，就悬空了。C++ 的类似物是：一个对象里存着指向自己成员的指针，然后你又拷贝或者移动了这个对象。C++ 的对策是写拷贝/移动构造函数，或者 `= delete` 它们。Rust 的对策是 `Pin`：

```text
$ cargo build --bin ch14_pin_new
error[E0277]: `{async fn body of answer()}` cannot be unpinned
  --> src/bin/ch14_pin_new.rs:12:28
   |
 3 | async fn answer() -> u32 {
   |                      --- within this `impl Future<Output = u32>`
...
12 |     let _pinned = Pin::new(&mut future);
   |                   -------- ^^^^^^^^^^^ within `impl Future<Output = u32>`, the trait `Unpin` is not implemented for `{async fn body of answer()}`
   |                   |
   |                   required by a bound introduced by this call
   |
   = note: consider using the `pin!` macro
           consider using `Box::pin` if you need to access the pinned value outside of the current scope
note: required because it appears within the type `impl Future<Output = u32>`
  --> src/bin/ch14_pin_new.rs:3:22
   |
 3 | async fn answer() -> u32 {
   |                      ^^^
note: required by a bound in `Pin::<Ptr>::new`
  --> /rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/core/src/pin.rs:1181:4

For more information about this error, try `rustc --explain E0277`.
error: could not compile `rust-lab` (bin "ch14_pin_new") due to 1 previous error
```

`Pin<P>` 是一个包装，包着一个指针（`&mut T`、`Box<T>`）并承诺"指针指向的值不会再被移动"。第 13 篇里 `PhantomPinned` 是一个"我不是 `Unpin`"的标记，`Unpin` 是一个自动 trait，意思是"移动这个类型是安全的"，绝大多数类型都是 `Unpin`（`u32`、`String`、`Vec`……），所以对它们 `Pin` 是一个空操作。`async fn` 生成的状态机因为可能有自引用，所以编译器让它不是 `Unpin`。`Pin::new` 只接受 `Unpin` 的东西，所以上面这个报错。

编译器的提示给了两条正路：`pin!` 宏，把值钉在当前栈帧里（`block_on` 里用的就是这个）；`Box::pin`，钉在堆上。两者都保证你再也拿不到那个值的 `&mut`，只能拿到 `Pin<&mut T>`，于是就没法 `mem::swap` 或者移动它。`poll(self: Pin<&mut Self>, ...)` 正是这一份保证的收据：要调用 `poll`，你必须先钉住它。

`Pin` 是 Rust 里少数几个我觉得真的难的地方，我没有假装它简单。这一篇你需要的只有两条：自己写 `Future` 的时候，`self: Pin<&mut Self>` 照抄；调用 `poll` 的时候，用 `pin!` 或 `Box::pin` 先钉住。上面的 `CountDown`、`Delay` 都没有自引用字段，所以其实是 `Unpin` 的，写 `self.remaining -= 1` 不需要任何 `unsafe`。

### Tokio：别人写好的 `block_on`，加上整个世界

`block_on` 是一个单线程、一次只能跑一个 `Future` 的执行者。Tokio 提供的是一整套运行时（runtime）：一个线程池，每个线程跑一个调度循环，从队列里取任务来 `poll`；一个反应器（reactor），把"套接字可读了"这样的操作系统事件（据我所知在 Linux 上它通过 `epoll`）翻译成对应任务的 `Waker` 调用；定时器；以及一堆异步版本的 I/O、锁和通道。

你与它打交道的方式：

- `#[tokio::main]` 把 `async fn main` 变成普通的 `fn main`，里面创建运行时，`block_on` 你的 `async` 主体。`#[tokio::test]` 对测试做同样的事。这两个是属性宏，第 12 篇的 `#[differential]` 的同类。
- `tokio::spawn(future)` 把一个 `Future` 交给运行时，返回 `JoinHandle`，和 `thread::spawn` 的形状几乎一样：你 `.await` 它得到结果。任务是运行时调度的最小单位，比线程便宜得多（上面那 120 字节）。
- `.await` 一个 `Future` 的意思是"在这里让出，等它好了再回来"。让出的时候，运行时的线程去 `poll` 别的任务。

任务之间在哪些点上能切换？**只在 `.await` 上**。这一点非常重要，我用两个实验让它看得见。`ch14_block_the_runtime.rs` 把运行时设成单线程（`flavor = "current_thread"`），一个任务每 100 毫秒打印一个 tick，另一个任务调用 `std::thread::sleep` 睡 500 毫秒：

```rust
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let start = Instant::now();

    let ticker = tokio::spawn(async move {
        for _ in 0..3 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            println!("tick at ~{} ms", start.elapsed().as_millis() / 100 * 100);
        }
    });

    let blocker = tokio::spawn(async {
        println!("blocking the only worker thread for 500 ms");
        std::thread::sleep(Duration::from_millis(500));
        println!("blocker done");
    });

    let _ = tokio::join!(ticker, blocker);
}
```

```text
$ cargo run --quiet --bin ch14_block_the_runtime
blocking the only worker thread for 500 ms
blocker done
tick at ~500 ms
tick at ~600 ms
tick at ~700 ms
```

三个 tick 本来应该在大约 100、200、300 毫秒。它们在 500、600、700：运行时只有一个线程，那个线程被 `std::thread::sleep` 占着，`sleep` 里没有 `.await`，没有任何让出的机会，计时器没法被检查。这就是"阻塞运行时"，async 代码里最常见的性能 bug。C++ 里有同样的坑：在 `asio` 的事件循环里调用阻塞的 `read()`。

修复：把阻塞的活交给专门的线程池，`tokio::task::spawn_blocking`。`ch14_blocking_ok.rs` 只改了一处，`blocker` 从 `tokio::spawn(async { ... })` 改成 `tokio::task::spawn_blocking(|| { ... })`：

```text
$ cargo run --quiet --bin ch14_blocking_ok
blocking on a dedicated thread for 500 ms
tick at ~100 ms
tick at ~200 ms
tick at ~300 ms
blocker done
```

tick 准时了。`spawn_blocking` 的闭包在一个专门的、允许阻塞的线程上运行，运行时的主线程继续调度别的任务。这是本篇后面 `pebble-net` 里的核心技巧：Pebble 的求值是 CPU 密集的同步代码，必须用 `spawn_blocking`。

### 哪些东西不能跨 `.await`

`tokio::spawn` 要求 `F: Future + Send + 'static`。`Send` 是什么意思？运行时的线程池里，一个任务这次在线程 A 上 `poll`，下次可能被线程 B 拿去接着 `poll`。所以任务（这个状态机）必须能在线程之间移动，`Send` 的要求就是这个。而状态机里存的是所有"跨过 `.await` 还活着"的局部变量。如果一个局部变量不是 `Send`，并且它跨过了一个 `.await`，整个 `Future` 就不是 `Send`。实验 `ch14_rc_across_await.rs`：

```rust
let handle = tokio::spawn(async {
    let shared = Rc::new(5);
    tokio::task::yield_now().await;
    println!("{shared}");
});
```

```text
error: future cannot be sent between threads safely
   --> src/bin/ch14_rc_across_await.rs:5:18
    |
  5 |       let handle = tokio::spawn(async {
    |  __________________^
  6 | |         let shared = Rc::new(5);
  7 | |         tokio::task::yield_now().await;
  8 | |         println!("{shared}");
  9 | |     });
    | |______^ future created by async block is not `Send`
    |
    = help: within `{async block@src/bin/ch14_rc_across_await.rs:5:31: 5:36}`, the trait `Send` is not implemented for `Rc<i32>`
note: future is not `Send` as this value is used across an await
   --> src/bin/ch14_rc_across_await.rs:7:34
    |
  6 |         let shared = Rc::new(5);
    |             ------ has type `Rc<i32>` which is not `Send`
  7 |         tokio::task::yield_now().await;
    |                                  ^^^^^ await occurs here, with `shared` maybe used later
note: required by a bound in `tokio::spawn`
   --> /home/bfmhno3/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.2/src/task/spawn.rs:176:21
    |
174 |     pub fn spawn<F>(future: F) -> JoinHandle<F::Output>
    |            ----- required by a bound in this function
175 |     where
176 |         F: Future + Send + 'static,
    |                     ^^^^ required by this bound in `spawn`

error: could not compile `lab-ch14-tokio` (bin "ch14_rc_across_await") due to 1 previous error
```

同样的事情发生在 Pebble 自己的解释器上。实验 `ch14_interp_across_await.rs` 在 `~/lab-ch14-tokio` 里，用路径依赖直接引用你重建出来的 `pebble-interp`（它的 `Cargo.toml` 在本篇最后的"实验用的 crate"一节）：

```rust
let handle = tokio::spawn(async {
    let interpreter = Interpreter::new();
    tokio::task::yield_now().await;
    drop(interpreter);
});
```

```text
error: future cannot be sent between threads safely
   --> src/bin/ch14_interp_across_await.rs:5:18
    |
  5 |       let handle = tokio::spawn(async {
    |  __________________^
  6 | |         let interpreter = Interpreter::new();
  7 | |         tokio::task::yield_now().await;
  8 | |         drop(interpreter);
  9 | |     });
    | |______^ future created by async block is not `Send`
    |
    = help: within `{async block@src/bin/ch14_interp_across_await.rs:5:31: 5:36}`, the trait `Send` is not implemented for `Rc<RefCell<pebble_value::Env>>`
note: future is not `Send` as this value is used across an await
   --> src/bin/ch14_interp_across_await.rs:7:34
    |
  6 |         let interpreter = Interpreter::new();
    |             ----------- has type `Interpreter` which is not `Send`
  7 |         tokio::task::yield_now().await;
    |                                  ^^^^^ await occurs here, with `interpreter` maybe used later
note: required by a bound in `tokio::spawn`
   --> /home/bfmhno3/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.2/src/task/spawn.rs:176:21
    |
174 |     pub fn spawn<F>(future: F) -> JoinHandle<F::Output>
    |            ----- required by a bound in this function
175 |     where
176 |         F: Future + Send + 'static,
    |                     ^^^^ required by this bound in `spawn`
```

编译器还给了第二个几乎一样的错误，把原因换成了第 8 篇的 `Box<dyn Output>`（里面的 trait 对象没写 `+ Send`），这里不重复。这个实验是后面 `pebble-net` 的设计约束：**解释器不能活过一个 `.await`**。

最后一个常见的陷阱：标准库的 `Mutex`。实验 `ch14_std_mutex_await.rs`，在持有 `std::sync::Mutex` 的 guard 的时候 `.await`：

```rust
tokio::spawn(async move {
    let mut guard = counter.lock().unwrap();
    *guard += 1;
    tokio::time::sleep(Duration::from_millis(10)).await;
    *guard += 1;
})
```

```text
error: future cannot be sent between threads safely
   --> src/bin/ch14_std_mutex_await.rs:9:9
    |
  9 | /         tokio::spawn(async move {
 10 | |             let mut guard = counter.lock().unwrap();
 11 | |             *guard += 1;
 12 | |             tokio::time::sleep(Duration::from_millis(10)).await;
 13 | |             *guard += 1;
 14 | |         })
    | |__________^ future created by async block is not `Send`
    |
    = help: within `{async block@src/bin/ch14_std_mutex_await.rs:9:22: 9:32}`, the trait `Send` is not implemented for `std::sync::MutexGuard<'_, u32>`
note: future is not `Send` as this value is used across an await
   --> src/bin/ch14_std_mutex_await.rs:12:59
    |
 10 |             let mut guard = counter.lock().unwrap();
    |                 --------- has type `std::sync::MutexGuard<'_, u32>` which is not `Send`
 11 |             *guard += 1;
 12 |             tokio::time::sleep(Duration::from_millis(10)).await;
    |                                                           ^^^^^ await occurs here, with `mut guard` maybe used later
note: required by a bound in `tokio::spawn`
   --> /home/bfmhno3/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.2/src/task/spawn.rs:176:21
    |
174 |     pub fn spawn<F>(future: F) -> JoinHandle<F::Output>
    |            ----- required by a bound in this function
175 |     where
176 |         F: Future + Send + 'static,
    |                     ^^^^ required by this bound in `spawn`
```

这就是上面那张表里 `MutexGuard` 不是 `Send` 的后果。想象一下它为什么必须这样：任务在锁的持有期间让出了线程，然后别的任务在**同一个线程**上跑起来，也想拿同一把锁。这个线程已经"持有"了它（持有者是被挂起的那个任务），第二个任务拿锁就是死锁。更糟的是这个任务下次可能在另一个线程上被唤醒，`MutexGuard` 要在那里解锁。编译器两种情况一起拒绝了。

解决办法有两个，选哪个取决于你要不要在持锁时 `.await`：不需要的话，把 guard 的作用域缩小到 `.await` 之前（用 `{ ... }` 包起来，或者 `drop(guard)`），继续用 `std::sync::Mutex`，它更快；需要的话，用 `tokio::sync::Mutex`，它的 `lock()` 本身是 `async fn`，guard 是 `Send` 的。`pebble-net` 两种都用到了，后面会看到分界线在哪里。

## `pebble-net`：一个会同时服务很多客户端的求值器

### 协议

Pebble 的程序是文本，结果也是文本。TCP 是字节流，没有消息边界，客户端写两次可能被服务器一次读到，也可能一次写被拆成三次读到。所以我们需要自己划边界。最简单的办法是**长度前缀**：每一帧是一个 4 字节大端的 `u32` 长度，后面是恰好那么多字节的 UTF-8 文本。

```text
client                                            server
  |  <len:u32><program bytes>  ------------------>  read_frame
  |                                                 evaluate (spawn_blocking)
  |  <------- <len:u32><rendered text>             write_frame
```

我先用一个原始的 TCP 客户端把真实的线上字节打出来看一看（实验 `ch14_wire.rs`，它启动我们稍后要写的服务器，发送 `1 + 2 * 3;`，并把请求和响应用十六进制打印）：

```text
$ cargo run --quiet --bin ch14_wire
request  : 00 00 00 0a 31 20 2b 20 32 20 2a 20 33 3b
response : 00 00 00 01 37
as text  : "7"
```

请求是 4 字节长度（`0x0a` = 10，`1 + 2 * 3;` 正好 10 个字符）加 10 字节正文，响应是长度 1 加 `0x37`（ASCII `7`）。大端是网络字节序，C 里你会写 `htonl`；Rust 里是 `u32::to_be_bytes` 和 `u32::from_be_bytes`，不需要 `unsafe`，也不需要判断本机字节序。

### 写 `Cargo.toml`

`crates/pebble-net/Cargo.toml`：

```toml
[package]
name = "pebble-net"
description = "An asynchronous remote evaluator for Pebble, built on Tokio."
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
pebble-parser.workspace = true
pebble-value.workspace = true
pebble-interp.workspace = true
tokio.workspace = true

[lints]
workspace = true
```

### 文件头：复制

`crates/pebble-net/src/lib.rs` 的前 73 行是 `#![forbid(unsafe_code)]`、整个 crate 的文档（上面那张协议图就在里面）、`use` 列表、两个常量、`ServerConfig`（带 `Default`）和 `Stats`。这些都是你已经会的东西，从 [tag 里的 `lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-net/src/lib.rs) 把前 73 行复制过来，没有什么要读的。只有两处值得看一眼：

```rust
#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub max_frame: usize,
    pub request_timeout: Duration,
}

#[derive(Default, Debug)]
pub struct Stats {
    pub connections: u64,
    pub requests: u64,
    pub errors: u64,
}
```

（省略了文档注释。）`ServerConfig` 派生 `Clone`，因为每个连接任务要拥有一份自己的拷贝：`tokio::spawn` 要求 `'static`，借用不行。`Stats` 是三个计数器，被所有连接共享，所以它将被放进 `Arc<Mutex<_>>`。

接着是"纯求值"那一段，从 `// Pure evaluation` 那条横幅注释开始，到 `// Framing` 之前结束：`Evaluation`、`SharedOutput`（用 `Arc<std::sync::Mutex<Vec<String>>>` 收集 `print` 的输出，就是上面讲中毒时提到的那个）、`evaluate`、`eval_to_string`、`render_diagnostics`、`render_runtime_error`。同样复制过来，它们都是同步函数，不碰网络。`evaluate` 做的事情和 `pebble run` 一样：解析，有诊断就渲染诊断，否则解释，把 `print` 的输出和最终值拼在一起。关键的一行是

```rust
let mut interpreter = Interpreter::with_output(Box::new(output.clone()));
```

输出被写进一个克隆出来的 `SharedOutput`，解释器被丢弃之后，`output.text()` 还能读到内容。解释器从创建到丢弃都在这个同步函数里，**从不跨 `.await`**，这和上面实验的结论吻合。

这一段之后你的文件和 tag 的区别是：没有 `Framing`、`Server`、`Client` 三个部分，也没有 `tests` 模块。把它们一块一块写出来。

### 成帧：先写一个朴素版本

`read_frame` 要读一个 4 字节的头，判断长度合不合理，读那么多字节的正文。第一版我用的是 `io::Result`，很自然：所有 I/O 函数都返回它，长度太大就造一个 `io::Error`。实验 `ch14_naive_frame.rs`：

```rust
async fn read_frame<R>(reader: &mut R, max_frame: usize) -> io::Result<Option<Vec<u8>>>
where
    R: AsyncRead + Unpin,
{
    let mut header = [0u8; 4];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }

    let length = u32::from_be_bytes(header) as usize;
    if length > max_frame {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame length {length} exceeds maximum frame size {max_frame}"),
        ));
    }

    let mut payload = vec![0u8; length];
    reader.read_exact(&mut payload).await?;
    Ok(Some(payload))
}
```

主程序对一个声称有 1024 字节但上限是 16 的帧、和一个声称有 8 字节但实际只有 2 字节的帧各调一次，打印错误的 `kind()` 和消息：

```text
$ cargo run --quiet --bin ch14_naive_frame
kind    : InvalidData
message : frame length 1024 exceeds maximum frame size 16
kind    : UnexpectedEof
message : early eof
```

两种失败都能被区分，靠的是 `ErrorKind`。但"太大"这个失败带着两个有用的数字（声称的长度和上限），在 `io::Error` 里它们变成了字符串的一部分；调用者想知道上限是多少，只能解析字符串。另外，想想 `handle_connection` 要怎么处理这几种情况：连接被对端关了（正常结束，不是错误）、帧太大（要断开连接，记一次错误）、UTF-8 解码失败（记一次错误）、网络真的坏了。如果它们全是 `io::Error`，每个调用者都要靠 `kind()` 和字符串匹配来猜。

这是"错误应该是数据"的又一个场景（第 3 篇你写 `Diagnostic` 的时候同一个想法）：给它一个类型。

### `FrameError`：一个 `enum`、`Display`、`Error`、`From`

在文件里 `// Framing` 那条横幅之下写：

```rust
/// Why a frame could not be read or written.
#[derive(Debug)]
#[non_exhaustive]
pub enum FrameError {
    /// The underlying connection failed.
    Io(io::Error),
    /// A frame announced or carried more bytes than the configured maximum.
    TooLarge {
        /// The offending length in bytes.
        length: usize,
        /// The largest length that is allowed.
        max: usize,
    },
    /// A frame payload that should be text was not valid UTF-8.
    InvalidUtf8(std::string::FromUtf8Error),
    /// The peer closed the connection before sending a response.
    Closed,
}
```

`#[derive(Debug)]` 是必需的（`Error` 要求 `Debug`）。四个变体对应上面四种情况：`Io` 包着真正的网络错误，`TooLarge` 是带两个字段的结构体式变体（数字现在是数字了），`InvalidUtf8` 包着 `String::from_utf8` 的错误，`Closed` 没有载荷。`pub` 的 `enum` 上有一个陌生的属性 `#[non_exhaustive]`，稍后解释。

`Display`（第 3 篇的老朋友）给每个变体一句人话：

```rust
impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(_) => f.write_str("i/o error on the connection"),
            Self::TooLarge { length, max } => {
                write!(f, "frame length {length} exceeds maximum frame size {max}")
            }
            Self::InvalidUtf8(_) => f.write_str("frame payload is not valid UTF-8"),
            Self::Closed => f.write_str("peer closed the connection without a response"),
        }
    }
}
```

注意 `Io(_)` 和 `InvalidUtf8(_)` 的消息里没有写内层错误的内容。这是有意的，下面讲 `source()` 的时候你会看到为什么。

`std::error::Error` trait 的核心是 `source()`：返回这个错误的"原因"。

```rust
impl std::error::Error for FrameError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::InvalidUtf8(error) => Some(error),
            Self::TooLarge { .. } | Self::Closed => None,
        }
    }
}
```

`Option<&(dyn std::error::Error + 'static)>`：一个 trait 对象的借用（第 8 篇），说"我可能有一个底层原因，它是某种 `Error`"。`Io` 和 `InvalidUtf8` 返回内层，另外两个返回 `None`。`Error` 要求 `Debug + Display`（第 3 篇的超 trait），其余的方法都有默认实现。

为什么不把内层错误的消息拼在自己的消息里？因为这样的话，一个错误链（`FrameError` 引起自 `io::Error` 引起自操作系统的 errno）会在每一层重复同一句话。惯例是：每个错误只说自己这一层，用 `source()` 暴露下一层，由最后打印错误的人决定要不要把整条链走一遍。实验 `ch14_error_chain.rs` 用 `pebble-net` 的 `FrameError`（路径依赖在 lab 的 `Cargo.toml` 里）做了一次，包括 `anyhow`（第 7 篇的 CLI 就用它）怎么展示一条链：

```rust
let utf8 = String::from_utf8(vec![0x68, 0xff, 0xfe]).unwrap_err();
let error = FrameError::from(utf8);

println!("display : {error}");
println!("debug   : {error:?}");

let mut source = error.source();
let mut depth = 1;
while let Some(cause) = source {
    println!("cause {depth} : {cause}");
    source = cause.source();
    depth += 1;
}

let wrapped = anyhow::Error::new(error).context("while reading the response from 127.0.0.1:7878");
println!("anyhow {{}}  : {wrapped}");
println!("anyhow {{:#}}: {wrapped:#}");

let io = FrameError::from(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "connection reset by peer"));
println!("io      : {io}  <-  {}", io.source().unwrap());
```

```text
$ cargo run --quiet --bin ch14_error_chain
display : frame payload is not valid UTF-8
debug   : InvalidUtf8(FromUtf8Error { bytes: [104, 255, 254], error: Utf8Error { valid_up_to: 1, error_len: Some(1) } })
cause 1 : invalid utf-8 sequence of 1 bytes from index 1
anyhow {}  : while reading the response from 127.0.0.1:7878
anyhow {:#}: while reading the response from 127.0.0.1:7878: frame payload is not valid UTF-8: invalid utf-8 sequence of 1 bytes from index 1
io      : i/o error on the connection  <-  connection reset by peer
```

`{}` 只打印最外层，`{:#}`（第 7 篇的 `{error:#}`）把整条链用冒号连起来：`上下文: FrameError: 底层原因`。这就是 `pebble: {error:#}` 在 `main.rs` 里的工作方式。C 里的 `errno` 加 `strerror` 是单层的；多层的原因链要自己维护。

然后是 `From` 实现：

```rust
impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<std::string::FromUtf8Error> for FrameError {
    fn from(error: std::string::FromUtf8Error) -> Self {
        Self::InvalidUtf8(error)
    }
}
```

`impl From<io::Error> for FrameError` 的意义是 `?` 运算符：在一个返回 `Result<_, FrameError>` 的函数里，对一个 `Result<_, io::Error>` 写 `?`，如果出错，`?` 先调用 `FrameError::from(error)` 再返回。第 7 篇我说过 `?` 是"出错就提前返回"，真实的展开其实还多了这一步转换。这样 `reader.read_exact(&mut payload).await?` 里的 `io::Error` 自动变成了 `FrameError::Io`。

`#[non_exhaustive]` 是写给 crate 的**使用者**的：它们没法再对这个枚举写不带通配符的 `match`，所以作者以后加变体不是破坏性变更。为了验证，我在 lab crate 里（它是 `pebble-net` 的外部使用者）写了一个穷举的 `match`（实验 `ch14_non_exhaustive.rs`）：

```text
$ cargo build --bin ch14_non_exhaustive
error[E0004]: non-exhaustive patterns: `&_` not covered
   --> src/bin/ch14_non_exhaustive.rs:4:11
    |
  4 |     match error {
    |           ^^^^^ pattern `&_` not covered
    |
note: `FrameError` defined here
   --> /tmp/pebble-rebuild-14/crates/pebble-net/src/lib.rs:200:1
    |
200 | pub enum FrameError {
    | ^^^^^^^^^^^^^^^^^^^
    = note: the matched value is of type `&FrameError`
    = note: `FrameError` is marked as non-exhaustive, so a wildcard `_` is necessary to match exhaustively
help: ensure that all possible cases are being handled by adding a match arm with a wildcard pattern or an explicit pattern as shown
    |
  8 ~         FrameError::Closed => "closed",
  9 ~         &_ => todo!(),
    |

For more information about this error, try `rustc --explain E0004`.
error: could not compile `lab-ch14-tokio` (bin "ch14_non_exhaustive") due to 1 previous error
```

四个变体全列了，仍然被拒绝。注意它只对**别的 crate** 生效：在 `pebble-net` 内部（比如 `Display` 实现里）仍然可以不写通配符，因为同一个 crate 里作者自己知道变体表。这就是为什么我要用一个外部的 lab crate 做这个实验。

> [!NOTE] `thiserror`：把这一切缩成三行属性
> 上面那五十来行样板代码（`Display`、`Error`、两个 `From`）是 `thiserror` crate 的 `#[derive(Error)]` 要替你写的。我把同样的四个变体用它写了一遍（实验 `ch14_thiserror.rs`，`Cargo.toml` 里加了 `thiserror = "2"`），消息和 `pebble-net` 里的一样：
>
> ```rust
> #[derive(Debug, Error)]
> enum FrameError {
>     #[error("i/o error on the connection")]
>     Io(#[from] io::Error),
>     #[error("frame length {length} exceeds maximum frame size {max}")]
>     TooLarge { length: usize, max: usize },
>     #[error("frame payload is not valid UTF-8")]
>     InvalidUtf8(#[from] std::string::FromUtf8Error),
>     #[error("peer closed the connection without a response")]
>     Closed,
> }
> ```
>
> ```text
> $ cargo run --quiet --bin ch14_thiserror
> frame length 1024 exceeds maximum frame size 16
> frame payload is not valid UTF-8
> has a source: true
> peer closed the connection without a response
> ```
>
> `#[from]` 同时生成 `From` 实现和 `source()`。它本身也是一个派生宏，和第 6 篇我们写的 `#[derive(Spanned)]` 是一回事。Pebble 没有用它，是因为这个 crate 的依赖数量我想尽可能少，而且手写一遍对学习更有用。真实项目里我会用 `thiserror`。

最后是 `read_frame` 和 `write_frame`。`read_frame` 返回 `Result<Option<Vec<u8>>, FrameError>`：外层 `Result` 是失败，内层 `Option` 区分"收到一帧"（`Some`）和"对端在两帧之间干净地关闭了连接"（`None`）：

```rust
/// Reads one length-prefixed frame. Returns `Ok(None)` on a clean end of
/// stream before any header byte was read.
async fn read_frame<R>(reader: &mut R, max_frame: usize) -> Result<Option<Vec<u8>>, FrameError>
where
    R: AsyncRead + Unpin,
{
    let mut header = [0u8; 4];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    }

    let length = u32::from_be_bytes(header) as usize;
    if length > max_frame {
        return Err(FrameError::TooLarge {
            length,
            max: max_frame,
        });
    }

    let mut payload = vec![0u8; length];
    reader.read_exact(&mut payload).await?;
    Ok(Some(payload))
}
```

几点：

- `R: AsyncRead + Unpin`：`R` 是任何可异步读的东西（`TcpStream`、`OwnedReadHalf`、测试里的 `&[u8]`），`Unpin` 是上面讲的"可以被移动"；`read_exact` 需要 `&mut R` 能被重新借用，不需要钉住。这就是 `read_frame` 既能读 TCP 又能读字节切片的原因，测试里我们读的是 `&[u8]`。
- `read_exact(&mut header).await`：读满 4 个字节，读不满就 `UnexpectedEof`。对头部来说，在 0 字节处遇到 EOF 是正常的（对方关了），所以第一个 `match` 把 `UnexpectedEof` 映射成 `Ok(None)`；其他 I/O 错误用 `error.into()` 转成 `FrameError::Io`，这里不能用 `?`，因为这个分支要先看 `error.kind()`。一个细节：代码分不出"0 字节"和"读了 1 到 3 字节"，`read_exact` 两种情况都报 `UnexpectedEof`，所以头部被截断在中间也会被当成干净关闭返回 `Ok(None)`，文档注释里"before any header byte was read"说得比实际更强。
- 注意读 payload 的 `reader.read_exact(&mut payload).await?` **没有**对 `UnexpectedEof` 特殊处理：头部读完了而正文被截断，是真的出错，应该走 `FrameError::Io`。
- 先检查 `length > max_frame` 再分配：否则一个恶意的客户端发 `0xFFFFFFFF` 就能让服务器分配 4 GiB。

```rust
/// Writes one length-prefixed frame.
async fn write_frame<W>(writer: &mut W, payload: &[u8], max_frame: usize) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin,
{
    if payload.len() > max_frame {
        return Err(FrameError::TooLarge {
            length: payload.len(),
            max: max_frame,
        });
    }
    let length = u32::try_from(payload.len()).map_err(|_| FrameError::TooLarge {
        length: payload.len(),
        max: u32::MAX as usize,
    })?;
    writer.write_all(&length.to_be_bytes()).await?;
    writer.write_all(payload).await?;
    writer.flush().await?;
    Ok(())
}
```

`write_frame` 检查两次：一次是我们的上限，一次是 `u32::try_from`，因为长度前缀只有 32 位，`usize` 在 64 位机器上放得下更大的数（第 8 篇的 `TryFrom`）。`write_all` 保证写完整，`flush` 把缓冲区推出去（对 `TcpStream` 来说是空操作，但对带缓冲的写入者是必要的，所以协议层总是调用它）。

两个测试放进 `mod tests`，先把测试模块的头和前面四个 `eval_to_string_*` 测试复制过来（它们是不碰网络的纯函数测试，从 tag 复制即可）。这里有两个值得写出来的，它们都是 `FrameError` 的契约：

```rust
    #[tokio::test]
    async fn oversized_header_is_a_typed_error() {
        let mut reader: &[u8] = &1024u32.to_be_bytes();
        let error = read_frame(&mut reader, 16).await.unwrap_err();
        assert!(
            matches!(
                error,
                FrameError::TooLarge {
                    length: 1024,
                    max: 16
                }
            ),
            "got {error:?}"
        );
        assert_eq!(
            error.to_string(),
            "frame length 1024 exceeds maximum frame size 16"
        );
    }

    #[test]
    fn invalid_utf8_keeps_its_source() {
        let error = FrameError::from(String::from_utf8(vec![0xff]).unwrap_err());
        assert_eq!(error.to_string(), "frame payload is not valid UTF-8");
        assert!(std::error::Error::source(&error).is_some());
    }
```

`let mut reader: &[u8] = &1024u32.to_be_bytes();`：`&[u8]` 实现了 `AsyncRead`（读完就是 EOF），所以一个字节数组就是一个现成的假连接，不用开 socket。`matches!`（第 7 篇）在字段上做了模式匹配，`TooLarge { length: 1024, max: 16 }` 里的字面量是模式。`#[tokio::test]` 是上面讲过的 `#[tokio::main]` 的测试版，让一个 `async fn` 可以作为测试运行。

到这里，**暂时**把服务器和客户端两节、以及其余三个 TCP 测试都省掉（它们是 `oversized_frame_is_rejected`、`round_trip_over_tcp`、`concurrent_clients_both_succeed`，下面再加回来），只留下上面的内容，运行。输出里我用 `grep` 只留了每条警告的第一行和测试结果行：

```text
$ cargo test -p pebble-net
warning: unused imports: `TcpListener` and `TcpStream`
warning: unused import: `tokio::sync::Mutex`
warning: unused import: `std::future::Future`
warning: unused import: `ToSocketAddrs`
warning: field `is_error` is never read
warning: function `read_frame` is never used
warning: function `write_frame` is never used
warning: `pebble-net` (lib) generated 7 warnings (run `cargo fix --lib -p pebble-net` to apply 2 suggestions)
...
test tests::eval_to_string_reports_parse_errors ... ok
test tests::invalid_utf8_keeps_its_source ... ok
test tests::eval_to_string_includes_print_output ... ok
test tests::eval_to_string_reports_runtime_errors ... ok
test tests::eval_to_string_returns_the_value ... ok
test tests::oversized_header_is_a_typed_error ... ok
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

6 个测试，7 个"没用到"的警告：那些导入和函数是后面的服务器要用的，现在它们是死代码。警告是诚实的，它们在告诉你下面还有活。

### 服务器：`select!`、任务和 `Arc<Mutex<Stats>>`

服务器的主体是一个无限循环：等下一个连接，把它交给一个新任务，回到等待。但它还要能被叫停，不然测试里的服务器永远关不掉。所以每一圈要同时等两件事：有新连接，或者有人说停。这正是 `tokio::select!` 的用途。先把 `// Server` 横幅（三行注释）从 tag 复制进来，然后写最里层的 `serve_listener`：

```rust
/// Serves on an already-bound listener until `shutdown` resolves.
///
/// Each accepted connection is handled by a spawned task, so a slow or idle
/// client never blocks the accept loop.
///
/// # Errors
///
/// Returns an error if accepting a connection fails at the OS level.
pub async fn serve_listener(
    listener: TcpListener,
    config: ServerConfig,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    let stats = Arc::new(Mutex::new(Stats::default()));
    tokio::pin!(shutdown);

    loop {
        tokio::select! {
            () = &mut shutdown => return Ok(()),
            accepted = listener.accept() => {
                let (stream, _peer) = accepted?;
                let config = config.clone();
                let stats = Arc::clone(&stats);
                tokio::spawn(async move {
                    let _ = handle_connection(stream, config, stats).await;
                });
            }
        }
    }
}
```

逐行：

- `shutdown: impl Future<Output = ()> + Send + 'static`：停止信号是任何一个"完成时不产生值"的 `Future`：一个 `oneshot` 通道的接收端、`Ctrl-C` 信号、一个定时器，都可以。`Send + 'static` 因为整个 `serve_listener` 本身会被 `tokio::spawn`（测试里就是这样用的），它的状态机里存着 `shutdown`，所以 `shutdown` 必须满足 `spawn` 的要求。`impl Trait` 在参数位置是第 5 篇的匿名泛型。
- `tokio::pin!(shutdown)`：下面 `select!` 里要写 `&mut shutdown`（每一圈都 `poll` 同一个 `shutdown`，不能每圈移走它），而 `&mut F` 要是 `Future`，`F` 就得是 `Unpin`；`impl Future` 不保证 `Unpin`，所以先钉住。这是上面 `Pin` 一节在实战里的出现，`pin!` 宏就是那一行解决的。
- `tokio::select!`：同时 `poll` 几个 `Future`，哪个先完成就执行它的分支，**其余的被丢弃**。分支的语法是 `模式 = 表达式 => 代码`。`() = &mut shutdown` 的模式是单元值 `()`（`Output = ()`）。这里 `listener.accept()` 被丢弃时会怎样？Tokio 文档说 `accept` 是"取消安全"的：被丢弃的那一刻还没拿到连接的话，什么都不会丢。我用一个实验确认被丢弃的分支真的被销毁了（实验 `ch14_select_cancel.rs`，`quick` 50 毫秒完成，`slow` 要 500 毫秒，`slow` 里有一个会在 `Drop` 时打印的局部变量）：

```text
$ cargo run --quiet --bin ch14_select_cancel
slow's local dropped
winner: quick
main done; "slow finished" never printed
```

输掉的 `slow()` 在 `quick` 赢的那一刻就被丢弃了：它的局部变量被销毁（`Drop` 照常运行，打印在 `winner: quick` 之前），`slow finished` 永远不会出现。这就是 `async` 里的取消：丢弃 `Future` 就是取消它，下一个 `.await` 点之后的代码不会再运行。（C++ 里取消一个正在进行的异步操作要靠 token 或者 `cancel()` 方法，由库作者自己实现。）
- `accepted?`：`accept` 失败（比如进程的文件描述符用光了）就整个服务器返回错误。生产服务器大概会重试暂时性的错误，这里没有。
- `tokio::spawn(async move { ... })`：每个连接一个任务，`async move` 把 `stream`、`config`、`stats` 搬进去。`config.clone()` 和 `Arc::clone(&stats)` 是在搬之前做的：每个任务拥有自己的一份。任务里 `let _ = handle_connection(...).await;`：错误被丢弃，因为没有人可以汇报；`handle_connection` 返回前已经在 `Stats` 里记过一笔了。

这就是 C 里 `accept` + `fork`（或 `accept` + `pthread_create`）的位置，只是任务比进程和线程轻得多。

`Stats` 被所有任务共享，它的包装是 `Arc<Mutex<Stats>>`，这里的 `Mutex` 是 `tokio::sync::Mutex`（文件头里 `use tokio::sync::Mutex;`）。`Arc` 的作用和线程那一节一样：多个任务都拥有它，最后一个丢弃它的时候它才被释放。

外面两层是复制的：`serve`（等 `Ctrl-C`，调用下一层）和 `serve_with_shutdown`（绑定地址，调用 `serve_listener`）。把 tag 里从 `// Server` 横幅之后的 `serve`、`serve_with_shutdown` 两个函数复制到 `serve_listener` 的前面，顺序是 `serve`、`serve_with_shutdown`、`serve_listener`。`serve` 里值得注意的只有一处：

```rust
let shutdown = async {
    if let Err(error) = tokio::signal::ctrl_c().await {
        eprintln!("pebble-net: could not listen for Ctrl-C: {error}");
    }
};
```

一个 `async` 块本身就是一个 `Future` 值，没有名字，正适合当作 `shutdown` 参数。这也是 `signal` 这个 Tokio feature 的用处。

### `handle_connection`：成帧、求值、超时

最后一块是处理一个连接的循环。我分成四段读。第一段，签名和开头：

```rust
/// Handles a single client connection: reads request frames until the peer
/// disconnects, evaluating each one with a per-request timeout.
///
/// # Errors
///
/// Returns a [`FrameError`] when framing fails (including an oversized frame),
/// the payload is not UTF-8, or the connection breaks mid-frame.
pub async fn handle_connection(
    stream: TcpStream,
    config: ServerConfig,
    stats: Arc<Mutex<Stats>>,
) -> Result<(), FrameError> {
    stats.lock().await.connections += 1;
    let (mut reader, mut writer) = stream.into_split();

```

返回 `Result<(), FrameError>`：上面 `FrameError` 的 doc 里写的四种失败都从这里出来。`stats.lock().await`：Tokio 的 `Mutex` 的 `lock()` 是 `async fn`，要 `.await`，拿到的 guard 会在这条语句结束时被丢弃（临时值），所以 `connections += 1` 是一次性的。`stream.into_split()` 把 `TcpStream` 拆成独立的读半边和写半边（可以放到不同任务里），这里同一个任务里用，是为了让读写的借用互不干扰。

第二段，读帧并解码：

```rust
    loop {
        let payload = match read_frame(&mut reader, config.max_frame).await {
            Ok(Some(payload)) => payload,
            Ok(None) => return Ok(()),
            Err(error) => {
                stats.lock().await.errors += 1;
                return Err(error);
            }
        };

        let program = match String::from_utf8(payload) {
            Ok(program) => program,
            Err(error) => {
                stats.lock().await.errors += 1;
                return Err(error.into());
            }
        };
```

`read_frame` 的三种结果各有处理：`Some(payload)` 继续，`None`（对端正常关闭）返回 `Ok(())`，`Err` 记一次错误再返回。注意 `stats.lock().await.errors += 1;` 是在返回**之前**：每一条错误路径都要记账，所以这行出现了五次，有一点重复，我没有抽成函数，因为每次的上下文不同，抽出来还要传 `stats`。UTF-8 解码失败时：`return Err(error.into())`：`.into()` 就是上面那个 `From<FromUtf8Error> for FrameError`，这里没有 `?` 是因为同样要先记账。`String::from_utf8(payload)` 拿走 `payload` 的所有权并复用它的缓冲区，不会复制。

第三段是整个服务器里最关键的两行：

```rust
        stats.lock().await.requests += 1;

        let evaluated = tokio::task::spawn_blocking(move || evaluate(&program));
        let response = match tokio::time::timeout(config.request_timeout, evaluated).await {
            Ok(Ok(evaluation)) => {
                if evaluation.is_error {
                    stats.lock().await.errors += 1;
                }
                evaluation.text
            }
            Ok(Err(join_error)) => {
                stats.lock().await.errors += 1;
                format!("error: evaluator task failed: {join_error}")
            }
            Err(_elapsed) => {
                stats.lock().await.errors += 1;
                "error: request timed out".to_string()
            }
        };
```

`tokio::task::spawn_blocking(move || evaluate(&program))` 把"求值"这个同步的、CPU 密集的函数丢到 Tokio 的阻塞线程池，立刻返回一个 `JoinHandle`；`tokio::time::timeout(duration, future)` 把它包起来：到时间还没完成就返回 `Err(Elapsed)`。所以 `match` 有三个分支：

- `Ok(Ok(evaluation))`：按时完成了。如果 `evaluation.is_error`（解析失败或运行时错误），记一次错误；回应是 `evaluation.text`。
- `Ok(Err(join_error))`：`JoinHandle` 报错，意思是阻塞任务 panic 了（或者被取消了）。回一句 `error: evaluator task failed: ...`。一个求值器的 bug 不会拖垮整个服务器，只让这一个请求失败。
- `Err(_elapsed)`：超时了。回 `error: request timed out`。

我想知道"为什么一定要 `spawn_blocking`"，因为文件头的文档说"解释器不是 `Send`，所以放在 `spawn_blocking` 里"，而上面的实验显示解释器只要不跨 `.await` 就不是问题。那么直接在 `async fn` 里调用 `evaluate(&program)` 会怎么样？我把 `spawn_blocking` 那一行换成 `let evaluated = async move { Ok::<_, tokio::task::JoinError>(evaluate(&program)) };`（保持下面的 `match` 不变），它**可以编译**。然后我在实验副本里加了一个新测试（只跑了这一个，没有重跑其余 9 个）：把超时设成 50 毫秒，发一个要跑很久的程序（一个数到三百万的 `while` 循环），测 `run_client` 多久才拿到回复：

```text
## spawn_blocking
reply "error: request timed out" after 51 ms
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 9 filtered out; finished in 4.44s

## 直接在 async fn 里调用
reply "3000000" after 4417 ms
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 9 filtered out; finished in 4.42s
```

（debug 构建；那个循环在这台机器上要 4.4 秒。）这个结果很清楚：直接调用的版本在**能编译**的同时，**超时形同虚设**：回复等了 4417 毫秒，远超 50 毫秒的限制，因为 `evaluate` 里面没有任何 `.await`，`timeout` 的计时器永远没有机会被检查（和上面 `ch14_block_the_runtime` 里 tick 迟到是同一个原因）。而且在这 4.4 秒里，运行时的那个工作线程完全被占着，同一个线程上的别的连接全部卡住。`spawn_blocking` 的版本在 51 毫秒就拿到了回复。

所以更诚实的说法是：`!Send` 的解释器不能跨 `.await`，这是一个约束，`evaluate` 是同步函数、内部创建内部丢弃，天然满足；而使用 `spawn_blocking` 的**真正理由**是：求值是 CPU 密集的、不会让出的，不能放在异步任务里直接做，否则超时和公平都做不到。

还有一个坏消息，在上面第二行的 `finished in 4.44s`：即使 `spawn_blocking` 的版本在 51 毫秒就回复了客户端，那个测试要 4.44 秒才结束，因为测试的运行时在退出时要等阻塞线程跑完。**超时只是放弃等待，并没有取消计算。** 实验 `ch14_timeout_blocking.rs` 用一个会睡 2 秒的阻塞任务把这件事单独量了出来：

```text
$ cargo run --quiet --bin ch14_timeout_blocking
timeout fired: true (after ~200 ms)
block_on returned at ~200 ms
the blocking job finally finished
runtime dropped at ~2000 ms
```

`timeout` 200 毫秒时触发了，`block_on` 也在 200 毫秒时返回了，但 `drop(runtime)` 一直等到阻塞任务在第 2000 毫秒结束。线程没法被外面强行终止（Rust 标准库根本没有 `kill_thread`，因为强行终止会跳过 `Drop`，留下持着锁的状态），要想真的取消，被取消的代码必须自己配合，比如在循环里检查一个标志。Pebble 的解释器没有这样的钩子，这是练习 1。

第四段，写回响应：

```rust
        write_frame(&mut writer, response.as_bytes(), config.max_frame).await?;
    }
```

最后的 `}` 收尾 `loop`，函数没有结尾的返回值：循环只通过 `return` 离开。

整个服务器里 `std::sync::Mutex` 和 `tokio::sync::Mutex` 都出现了：`SharedOutput` 里是 `std` 的（只在同步的 `evaluate` 里用，从不跨 `.await`），`Stats` 是 `tokio` 的。我留了一个余地给自己诚实：`Stats` 在这里的每个 guard 都是临时值，从不跨 `.await`，所以换成 `std::sync::Mutex` 也行。我试了：把 `use tokio::sync::Mutex;` 换成 `use std::sync::Mutex;`，把所有 `.lock().await` 换成 `.lock().unwrap()`，9 个测试照样通过。Tokio 文档的建议是，锁持有时间很短、不跨 `.await` 的时候 `std` 的更快；持锁的时候要 `.await` 才用 `tokio` 的（上面 `ch14_std_mutex_await` 的编译错误就是原因）。仓库里选了 `tokio` 的，因为它不用处理中毒，写起来整齐一些；我尊重这个选择，没有改它。

### 客户端：复制

`run_client` 是客户端：连接，发一帧，读一帧，返回文本。从 tag 复制 `// Client` 横幅和 `run_client`：

```rust
pub async fn run_client(addr: impl ToSocketAddrs, program: &str) -> Result<String, FrameError> {
    let mut stream = TcpStream::connect(addr).await?;
    write_frame(&mut stream, program.as_bytes(), DEFAULT_MAX_FRAME).await?;

    let payload = read_frame(&mut stream, DEFAULT_MAX_FRAME)
        .await?
        .ok_or(FrameError::Closed)?;

    Ok(String::from_utf8(payload)?)
}
```

它返回 `Result<String, FrameError>`，所以 `?` 把 `connect` 的 `io::Error` 和 `String::from_utf8` 的错误都转成了 `FrameError`；`read_frame(...).await?.ok_or(FrameError::Closed)?` 里 `Option::ok_or` 把 `None`（对端没回就关了）变成 `Err(Closed)`，第四个变体终于有了用处。

### 三个 TCP 测试

把剩下的 `bound_listener` 辅助函数和三个测试（`round_trip_over_tcp`、`concurrent_clients_both_succeed`、`oversized_frame_is_rejected`）从 tag 复制过来放进 `mod tests`。它们都在 `127.0.0.1:0` 上绑定（端口 0 让操作系统挑一个空闲端口，`local_addr()` 再把它问出来），所以测试之间不会抢端口。`round_trip_over_tcp` 用一个 `oneshot` 通道当作停止信号；`concurrent_clients_both_succeed` 用 `tokio::join!` 同时发两个请求，并检查 `Stats` 里的 `requests == 2`；`oversized_frame_is_rejected` 手工写一个声称 1024 字节的头，期望服务器关闭连接而不是等那 1024 字节。

```text
$ cargo test -p pebble-net
...
test tests::eval_to_string_includes_print_output ... ok
test tests::eval_to_string_reports_parse_errors ... ok
test tests::eval_to_string_returns_the_value ... ok
test tests::invalid_utf8_keeps_its_source ... ok
test tests::eval_to_string_reports_runtime_errors ... ok
test tests::oversized_header_is_a_typed_error ... ok
test tests::oversized_frame_is_rejected ... ok
test tests::concurrent_clients_both_succeed ... ok
test tests::round_trip_over_tcp ... ok
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

最后看一次真实的并发运行。实验 `ch14_server_demo.rs` 在一个进程里起这个服务器，用 `tokio::join!` 同时发四个请求（一个 `fib(24)`、一个赋值、一个 `print`、一个有语法错误的），再打印 `Stats`：

```text
$ cargo run --quiet --bin ch14_server_demo
fib(24)  -> 46368
x        -> 42
print    -> "hello\n1"
syntax   -> error[E1001]: expected an expression, found `;`
Stats { connections: 4, requests: 4, errors: 1 }
```

四个连接、四个请求、一个错误（语法错误那个）。`print("hello"); 1;` 的响应是 `"hello\n1"`：`print` 的输出和最终值用换行拼在一起，这就是 `evaluate` 里的 `parts.join("\n")`。

### 实验用的 crate

这一篇后半的实验都在 `~/lab-ch14-tokio` 里，`Cargo.toml` 是：

```toml
[package]
name = "lab-ch14-tokio"
version = "0.1.0"
edition = "2024"

[dependencies]
tokio = { version = "1", features = ["rt-multi-thread", "net", "io-util", "macros", "sync", "time", "signal"] }
pebble-interp = { path = "/tmp/pebble-rebuild-14/crates/pebble-interp" }
pebble-net = { path = "/tmp/pebble-rebuild-14/crates/pebble-net" }
thiserror = "2"
anyhow = "1"
```

两个 `pebble-*` 依赖指向我的重建目录，换成你自己的路径。每个实验是 `src/bin/ch14_<主题>.rs`，用 `cargo run --quiet --bin ch14_<主题>` 运行（编译失败的演示用 `cargo build --bin`）。

## 检查点

在重建目录里：

```bash
cargo test -p pebble-cli -p pebble-net
cargo clippy -p pebble-cli -p pebble-net --all-targets -- -D warnings
cargo fmt --all --check
```


第一条命令的输出（我用 `grep` 只留了 `Running` 和结果行）：

```text
     Running unittests src/main.rs (target/debug/deps/pebble-f848d73f4f46c5f3)
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running tests/cli.rs (target/debug/deps/cli-8a92629c34332c03)
test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.13s
     Running unittests src/lib.rs (target/debug/deps/pebble_net-6babef61d7c70edc)
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
   Doc-tests pebble_net
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

命令行：3 个单元测试（`repl.rs` 里的，第 9 篇），12 个集成测试（比第 12 篇多了本篇的两个：`check_reports_only_the_broken_file` 和 `check_requires_a_file`）。`pebble-net`：9 个测试，没有文档测试。第二条命令（clippy，`-D warnings`）和第三条（`cargo fmt --all --check`，退出码 0）在我的重建目录里都通过，没有输出任何警告。

然后手动跑一遍这一篇的新行为：

```bash
cargo run --quiet -p pebble-cli -- check examples/fib.pebble examples/errors.pebble examples/hello.pebble; echo "exit=$?"
```

应该只看到 `examples/errors.pebble` 的诊断和 `exit=1`，上面的"真实运行"一节里有完整输出。

这些文件现在必须和 tag 逐字节一致。把 tag 克隆到 `~/pebble-tag`（第 1 篇做过就跳过：`git clone --branch tutorial-v1 https://github.com/bfmhno3/pebble ~/pebble-tag`），然后在你的工作区根目录里：

```bash
diff -r crates/pebble-net ~/pebble-tag/crates/pebble-net
```

没有任何输出。这两个文件是"完成品"：

- [`crates/pebble-net/Cargo.toml`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-net/Cargo.toml)
- [`crates/pebble-net/src/lib.rs`](https://github.com/bfmhno3/pebble/blob/tutorial-v1/crates/pebble-net/src/lib.rs)

根目录的 `Cargo.toml` 现在还不用和 tag 一致（它在第 15 篇才完成），只要有 `pebble-net` 和 `tokio` 这两项。

中间状态的文件（命令行第五版，编译、测试都通过，但还没到最终版）：

- `crates/pebble-cli/` 下的全部八个文件（`Cargo.toml`、`src/` 下六个、`tests/cli.rs`）：第五版。相对第四版只改了这几处：`cli.rs` 多一个 `CheckArgs`、`Check` 变体改用它；`commands.rs` 的 `check` 重写，多出 `CheckReport` 和 `check_file`，多两行 `use`；`tests/cli.rs` 多两个测试；`main.rs`、`backend.rs`、`repl.rs`、`sources.rs`、`Cargo.toml` 一个字都没动。最终版多出来的东西：可选的 `repl` 特性（第 15 篇）。
- `examples/*.pebble`：和第 12 篇相同，没有变。

## 练习

**练习 1：** 请求超时之后，服务器给客户端回了 `error: request timed out`，但那个阻塞线程还在继续跑。怎么才能真的让它停下来？

<details>
<summary>参考答案</summary>

没有办法从外面把线程停下来：标准库没有 `kill_thread`，因为强行终止会跳过 `Drop`，让持着锁的数据停在一个中间状态。唯一的办法是被取消的代码自己配合：它得时不时检查一个标志。实验 `ch14_cooperative_cancel.rs` 在上面 `ch14_timeout_blocking` 的基础上给阻塞任务一个 `Arc<AtomicBool>`，循环里每 10 毫秒检查一次；`timeout` 触发之后，主任务把它设成 `true`：

```text
$ cargo run --quiet --bin ch14_cooperative_cancel
timeout fired, flag set (~200 ms)
the job noticed the flag after 20 steps and stopped
runtime dropped at ~200 ms
```

对比 `ch14_timeout_blocking` 里 `runtime dropped at ~2000 ms`：这次运行时在 200 毫秒就能退出。对 Pebble 来说，这意味着解释器需要一个钩子：`execute_stmt` 和 `while` 的每一圈检查一次这个标志，类似第 9 篇的 `with_call_depth` 检查调用深度的做法。解释器现在没有这样的钩子，我没有加它。

</details>

**练习 2：** 用原子类型替换 `Stats` 外面的 `Arc<Mutex<Stats>>`，让 `handle_connection` 里不再有 `.lock().await`。

<details>
<summary>参考答案</summary>

字段换成 `AtomicU64`，外面只需要 `Arc<Stats>`（原子类型自己就能通过 `&` 修改）：

```rust
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default, Debug)]
pub struct Stats {
    pub connections: AtomicU64,
    pub requests: AtomicU64,
    pub errors: AtomicU64,
}
```

`use tokio::sync::Mutex;` 删掉；`serve_listener` 里 `Arc::new(Mutex::new(Stats::default()))` 变成 `Arc::new(Stats::default())`；`handle_connection` 的签名参数 `Arc<Mutex<Stats>>` 变成 `Arc<Stats>`；每一处 `stats.lock().await.errors += 1;` 变成 `stats.errors.fetch_add(1, Ordering::Relaxed);`，`connections` 和 `requests` 同理；测试里 `stats.lock().await.requests` 变成 `stats.requests.load(Ordering::Relaxed)`，`Arc::new(Mutex::new(Stats::default()))` 变成 `Arc::new(Stats::default())`。我在一份拷贝里这样改完，`cargo test -p pebble-net` 是 9 个测试全部通过。

用 `Relaxed` 够了，因为三个计数器彼此独立，没有哪个的值被用来保护别的数据（第 13 篇的解释）。代价是读三个计数器不再是一个原子的快照：你可能读到 `requests` 已经加了而 `errors` 还没加。`Stats` 是公开的字段，类型从 `u64` 变成 `AtomicU64`，对 crate 的使用者是一个破坏性变更，这也是仓库里没有这样改的原因之一。

</details>

**练习 3：** 为什么 `handle_connection` 返回的 `Future` 必须是 `Send`？如果我在里面写一个跨 `.await` 的 `Rc`，编译器会在哪里报错？

<details>
<summary>参考答案</summary>

因为 `serve_listener` 用 `tokio::spawn` 启动每个连接任务，而 `spawn` 要求 `Future + Send + 'static`：多线程运行时可以在两次 `poll` 之间把任务换到另一个线程上。我在一份拷贝里的 `handle_connection` 里加了一行 `let _unsend = std::rc::Rc::new(0);`，放在 `stats.requests` 那一行之前（也就是 `stats.lock().await.requests += 1;` 之前）：

```text
error: future cannot be sent between threads safely
   --> crates/pebble-net/src/lib.rs:354:17
    |
354 | /                 tokio::spawn(async move {
355 | |                     let _ = handle_connection(stream, config, stats).await;
356 | |                 });
    | |__________________^ future created by async block is not `Send`
    |
    = help: within `{async block@crates/pebble-net/src/lib.rs:354:30: 354:40}`, the trait `Send` is not implemented for `Rc<i32>`
note: future is not `Send` as this value is used across an await
   --> crates/pebble-net/src/lib.rs:396:22
    |
395 |         let _unsend = std::rc::Rc::new(0);
    |             ------- has type `Rc<i32>` which is not `Send`
396 |         stats.lock().await.requests += 1;
    |                      ^^^^^ await occurs here, with `_unsend` maybe used later
```

错误报在 `serve_listener` 里的 `tokio::spawn` 那一行，不是 `handle_connection` 里：`handle_connection` 本身是一个合法的 `async fn`，它不知道将来谁会 `spawn` 它。`Send` 的要求沿着调用链一路传到了 `spawn`。

如果真的需要在任务里放 `!Send` 的东西，有一个出口：`LocalSet` 加 `spawn_local`，它们把任务固定在创建它们的那一个线程上，所以不要求 `Send`。实验 `ch14_local_set.rs` 在 `current_thread` 运行时里让一个 `Rc` 跨了 `.await`：

```text
$ cargo run --quiet --bin ch14_local_set
an Rc across an await: 5
```

代价是这些任务没法在线程之间搬运，吞吐量上限就是一个线程。

</details>

## 为什么 Pebble 的解释器还是 `Rc`

写这一篇之前我有一个担心：把线程和 async 都学完，会不会觉得第 8 篇选 `Rc` 是个错误，应该一开始就用 `Arc<Mutex<_>>`？做完所有的实验之后我的结论正相反。`pebble check` 的并行没有要求解释器是 `Send`：前端是 `Send`，把所有后端的东西留在线程里面创建、线程里面丢弃就够了。`pebble-net` 的并发也没有要求：解释器只活在 `spawn_blocking` 的闭包里。`Rc` 的计数是普通的加减，`Arc` 的计数是原子指令，这个差别在一个频繁克隆 `Value` 的解释器里会被放大；我没有量过放大多少，所以不给数字。

不过这也是一条路的终点：如果有一天 Pebble 想让两个线程共享同一个全局环境，就必须把整个 `Value` 换成 `Arc<Mutex<_>>`（或者重新设计成消息传递），那会是一次系统性的重写，编译器会逐个指出每一处要改的地方（上面 `send_probe` 的七条错误只是开头）。我的看法是，现在不值得。

下一篇是最后一篇，也是最没有新语法的一篇：Cargo 特性怎么让 `pebble repl` 变成可选的，单元测试、集成测试、文档测试怎么分工，`clippy` 和 `rustfmt` 怎么把风格交给机器，CI 配置怎么把所有这些检查在每次提交时跑一遍。然后我们把 `/tmp/pebble-rebuild` 和 tag 做最后一次对比，列一张"Rust 特性，第几篇"的索引表，看看我们到底学了多少。
