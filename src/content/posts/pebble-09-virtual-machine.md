---
title: "栈式 VM：跑指令、登记 GC 根、然后看它到底快多少"
commentId: "post:pebble-09-virtual-machine"
published: "2026-10-05 16:00:00 +08:00"
description: "把字节码接上值栈、调用帧和垃圾回收器，就得到一个完整的第二后端。这一篇讲 VM 的主循环、调用约定、GC 根怎么登记、以及怎么让两个后端在可观测语义上严格一致。最后放上真实的 Criterion 数字：VM 比树遍历快 1.2 到 2 倍，以及为什么不是十倍。"
category: Note
tags:
  - Rust
  - 虚拟机
  - 垃圾回收
  - 性能
series: "从零写一门语言：Pebble"
seriesOrder: 9
draft: false
comment: true
slug: pebble-09-virtual-machine
---

字节码有了，回收器有了。把它们接起来，就是 Pebble 的第二后端。这一篇讲这台机器怎么跑，以及它配不配得上"更快"这个名头。

## 值栈 + 调用帧

VM 的核心状态就三样：一块值栈、一摞调用帧、一个堆。

```rust
pub struct Vm {
    heap: Heap<VmObject>,
    stack: Vec<VmValue>,
    frames: Vec<Frame>,
    globals: GcRef,
    out: Box<dyn Output>,
    max_frames: usize,
    gc_threshold: usize,
}
```

值本身是 `Copy` 的小枚举，堆对象一概用下标引用：

```rust
#[derive(Copy, Clone, PartialEq, Debug)]
pub enum VmValue {
    Nil,
    Bool(bool),
    Int(i64),
    Float(f64),
    Ref(GcRef),
}
```

标量内联，堆对象走 `Ref`。这带来一个额外好处：`Value` 不含 `Rc`，`push` 和 `pop` 都不会碰引用计数。

主循环就是"取指、译指、执行"：

```rust
loop {
    let frame_index = self.frames.len() - 1;
    let proto = Rc::clone(&self.frames[frame_index].proto);
    let ip = self.frames[frame_index].ip;
    // ...越界检查（函数帧末尾一定会有 Return，只有主 chunk 会自然结束）
    let instruction = proto.chunk.code()[ip];
    self.frames[frame_index].ip = ip + 1;
    let span = proto.chunk.span_at(ip);

    match instruction {
        Opcode::Const(index) => self.push_constant(&proto.chunk, index, span)?,
        Opcode::Add => self.binary_add(span)?,
        Opcode::Call(count) => self.call(count, span)?,
        Opcode::Return => {
            let value = self.stack.pop().unwrap_or(VmValue::Nil);
            self.frames.pop();
            if self.frames.is_empty() { return Ok(value); }
            self.stack.push(value);
        }
        // ...
    }
}
```

## 调用约定：被调用者在参数下面

`Call(n)` 的约定在第七篇里已经坑过我一次，这里定死：栈上是 `[callee, arg1, ..., argn]`，`callee` 在参数**下面**。

```rust
fn call(&mut self, count: u32, span: Span) -> Result<(), RuntimeError> {
    let args = self.stack.split_off(self.stack.len() - count as usize);
    let callee = self.pop(span)?;   // callee 现在已经回到栈顶
    // ...
}
```

拿到 `callee` 之后分两种：

- **内建函数**：按名字分派到一段 Rust 代码，结果直接压栈。所以 `print`、`len`、`range` 这些是 Rust 写的。
- **闭包**：新建一个环境帧，父环境是闭包捕获的那个，把参数绑进去，然后压一个调用帧。执行流会自然地切到新帧的指令上。

闭包捕获在 `MakeClosure` 里发生：

```rust
Opcode::MakeClosure(index) => {
    let Constant::Function(proto_of_closure) = &proto.chunk.constants()[index as usize] else {
        return Err(RuntimeError::new(span, "malformed closure constant"));
    };
    let env = self.frames[frame_index].env;   // 捕获当前帧
    let reference = self.heap.alloc(VmObject::Closure {
        proto: Rc::clone(proto_of_closure),
        env,
    });
    self.stack.push(VmValue::Ref(reference));
}
```

`env` 现在是堆上的一个 `GcRef`，而不是 `Rc`。于是第六篇那个环变成了堆里普通的一个环：能被标记、也能被清除。函数原型本身是不可变的、不参与垃圾回收，所以仍然用 `Rc` 共享，clone 一下就行。

## GC 根：一次收集要在安全点发生

回收器和 VM 的接口只有一句话：**收集只能在指令边界发生**，因为那时所有活着的值都能从三个地方到达：值栈、每个活跃帧的环境、以及全局环境。

```rust
pub fn collect_garbage(&mut self) {
    for value in &self.stack {
        if let VmValue::Ref(reference) = value {
            self.heap.mark(*reference);
        }
    }
    for frame in &self.frames {
        self.heap.mark(frame.env);
    }
    self.heap.mark(self.globals);
    self.heap.collect();
}
```

主循环每次取指前看一眼分配计数，超过阈值就收一次：

```rust
if self.heap.allocations_since_gc() > self.gc_threshold {
    self.collect_garbage();
}
```

这个"只在安全点收集"的约束其实正是 GC 最容易被忽略的难点：如果在求值某个中缀表达式的半途收集，栈上可能有一个临时值既是活的、又没有任何根指向它，就会被误回收。把它放在指令边界，这个类问题就不存在了。

## 两个后端必须给一样的答案

有两个后端就有一个新风险：它们对同一个程序给出不同结果。我定了一条规则，并在两边都实现：

> 只有**表达式语句**有值；控制流语句（`if`、`while`、`let`）产生 `nil`。程序的返回值是最后一条表达式语句的值，或者显式 `return` 的值。

这条规则让 VM 的编译变简单，但要求树遍历那侧也改一下：它的 `if` 原本会把分支的值当成自己的值传上去。我给它加了一个规范化：

```rust
fn run_scoped_block(&mut self, stmts: &[Stmt], env: &Rc<RefCell<Env>>) -> Result<Flow, RuntimeError> {
    let scope = Env::child(Rc::clone(env));
    match self.execute_block(stmts, scope)? {
        Flow::Value(_) => Ok(Flow::Value(Value::Nil)),  // if 不产生值
        other => Ok(other),                              // 但 return/break/continue 照常传播
    }
}
```

一致性不是靠嘴保证的，是靠测试和逐字节比较：

```rust
#[test]
fn the_vm_and_the_interpreter_agree() {
    let interpreted = pebble_output(&["run", "examples/fib.pebble"]);
    let compiled = pebble_output(&["run", "--vm", "examples/fib.pebble"]);
    assert_eq!(interpreted.stdout, compiled.stdout);
}
```

## 到底快多少

我在 `pebble-bench` 里用 Criterion 对比两个后端，三组负载：

- **fib**：递归版 `fib(20)`，压调用栈。
- **loop_sum**：`while` 循环累加 0 到 100000，压解释循环。
- **collections**：建一个一千元素列表再逐项索引，压堆分配和 GC。

在这台机器上（Rust 1.95，release，`lto = "thin"`），中位数是：

| 负载 | 树遍历 | 字节码 VM | VM 快多少 |
| --- | --- | --- | --- |
| fib(20) | 7.93 ms | 6.04 ms | **1.31x** |
| loop_sum | 37.54 ms | 18.54 ms | **2.03x** |
| collections | 789.09 us | 641.49 us | **1.23x** |

结论：VM 在三个负载上都更快，循环最明显，堆操作最不明显。

## 为什么不是十倍

如果对比的是"用 Rust 写的 `fib`"和"Pebble 的 `fib`"，差距会是几十上百倍。但这里是"自己两种实现互相比"，所以合理的加速本来就在个位数。原因也很具体：

- 变量仍然**按名字查找**，每次访问都要在环境链上做哈希。这是最大的开销，也是 upvalue + 栈槽优化能吃掉的部分。
- `fib` 主要成本是**函数调用**，而每次调用都要新建一个环境对象、分配一个堆对象，GC 压力大。1.31x 很诚实。
- `collections` 里 VM 的优势最弱，因为两边都在分配堆对象，瓶颈在分配而不是派发。
- VM 用的是**安全的枚举派发**，没有把指令编码成裸字节做跳转表。真 VM 会用计算跳转之类的技巧再榨一层。

一句话：先有正确性和可维护性，再去挤性能。Pebble 的 VM 赢在"把解释循环从树的递归改成了线性遍历"，这就足够拿下循环那个 2 倍了。

## 下一篇

至此，一门语言的两个后端都能跑了。但一个真实项目不止于此，它还要能联网、能调用 C、能跑在没有操作系统的设备上。下一篇讲 Pebble 的三个边界：`async` 远程求值、FFI，以及 `no_std`。
