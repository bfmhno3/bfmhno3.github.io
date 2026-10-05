---
title: "手写标记清除垃圾回收器：把第六篇的泄漏收掉"
commentId: "post:pebble-08-garbage-collector"
published: "2026-10-05 15:00:00 +08:00"
description: "树遍历后端会因为递归闭包而泄漏。真正的解法不是修补 Rc，而是换一套内存管理：一个能识别环的标记清除回收器。这一篇讲泛型 Heap<O>、用 Cell 做内部可变性的标记阶段、用显式工作栈避免递归爆栈，以及一个用 MaybeUninit 和裸指针写的 bump 分配器。"
category: Note
tags:
  - Rust
  - 垃圾回收
  - unsafe
  - 内存管理
series: "从零写一门语言：Pebble"
seriesOrder: 8
draft: false
comment: true
slug: pebble-08-garbage-collector
---

第六篇结尾留了一个洞：树遍历解释器里，递归函数会在"存储自己的环境"和"自己捕获的环境"之间形成 `Rc` 环，引用计数永远归不了零。这不是实现 bug，是 `Rc` 的语义。要收掉它，运行时对象就不能由引用计数来管。

> [!TIP] 先读基础篇
> 本篇是全系列里 `unsafe` 最多的，用到 `Cell`、`MaybeUninit`、裸指针。先把基础篇 2（智能指针）读稳，再来看这一篇。

## 回收器的接口

我想让这个回收器能复用，所以把它写成泛型：它不关心对象是什么，只要求对象会**报告自己引用了哪些其他对象**。

```rust
pub trait GcObject {
    /// 报告每个子引用，回收器据此标记。
    fn trace(&self, mark: &mut dyn FnMut(GcRef));
}

pub struct Heap<O: GcObject> {
    slots: Vec<Option<O>>,
    free: Vec<u32>,
    marked: Vec<Cell<bool>>,
    allocations_since_gc: usize,
}
```

句柄是一个下标，而不是裸指针：

```rust
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct GcRef(u32);
```

这个选择是刻意的。用下标就没有悬垂指针这一类 `unsafe`：`get` 越界会 panic 并给出清晰的信息，而不是读一块已经还给系统内存。代价是句柄和对象之间没有类型信息，而且空闲槽被复用后，一个过期的 `GcRef` 会指向新对象。

## 标记阶段：`&self` 加内部可变性

标记要给对象打上"活着"的标记，这听起来需要 `&mut self`。但回收器同时还要遍历对象、调用它们的 `trace`。如果标记要 `&mut`，就没法一边拿着对象的不可变引用一边改标记。

解法是把标记放进 `Cell<bool>`：

```rust
marked: Vec<Cell<bool>>,
```

于是 `mark` 只需要 `&self`，并且用一个**显式的工作栈**代替递归：

```rust
pub fn mark(&self, root: GcRef) {
    let mut stack = vec![root];
    while let Some(reference) = stack.pop() {
        let index = reference.index() as usize;
        if self.marked[index].replace(true) {
            continue; // 已经标记过，防环
        }
        if let Some(object) = &self.slots[index] {
            object.trace(&mut |child| stack.push(child));
        }
    }
}
```

两个细节：

- `Cell::replace(true)` 返回旧值。旧值是真说明"标记过了"，直接跳过。这既去重，也**天然防住环**：`a -> b -> a` 在第二次遇到 `a` 时停住。
- 用显式 `Vec` 当栈，而不是递归调用。原因和解释器的递归上限一样：链一深，递归就会爆宿主栈。我写了一个一万层嵌套列表的测试，要求它标记完成而不炸。

`trace` 的参数是一个闭包，对象把子引用推给回收器：

```rust
impl GcObject for VmObject {
    fn trace(&self, mark: &mut dyn FnMut(GcRef)) {
        match self {
            VmObject::List(items) => {
                for item in items {
                    if let VmValue::Ref(reference) = item {
                        mark(*reference);
                    }
                }
            }
            VmObject::Env { parent, slots } => {
                if let Some(parent) = parent { mark(*parent); }
                for (_, value) in slots {
                    if let VmValue::Ref(reference) = value { mark(*reference); }
                }
            }
            // ...
        }
    }
}
```

## 清扫：回收没被标记的

```rust
pub fn collect(&mut self) {
    for index in 0..self.slots.len() {
        let empty = self.slots[index].is_none();
        if empty || !self.marked[index].get() {
            if !empty {
                self.slots[index] = None;
                self.free.push(index as u32);
            }
            // ...
        }
        self.marked[index].set(false); // 清空标记，准备下一轮
    }
    self.allocations_since_gc = 0;
}
```

空闲槽进入 `free` 列表，下一次 `alloc` 优先复用，所以长期运行不会无限膨胀。

## 验证：随机可达性 vs 广度优先

回收器最容易写错的地方是"谁该活"。我给它的核心测试是：随机建一张图，随机挑一组根，标记、清除，然后断言**存活集合逐元素等于从根出发的 BFS 可达集合**。跑两百轮不同的随机图。

```rust
// 200 轮随机图：mark + collect 之后的存活集合，
// 必须和从根集出发做 BFS 得到的集合完全一致。
```

这样的随机测试比手写的三五个用例更能抓住边界，因为图的形状是它自己长出来的，我只负责比对两个集合。

## 另一块 `unsafe`：bump 分配器

索引句柄的回收器其实不太需要 `unsafe`。但"没有 `unsafe` 的 GC"讲不了 Rust 的底层那一面，所以我在同一个 crate 里放了第二个东西：一个 bump 分配器。

bump 分配就是"从一块内存的一头开始往后发，发到哪算哪，整块一起释放"。它的核心是裸指针运算：

```rust
pub fn alloc_bytes(&mut self, bytes: &[u8]) -> &mut [u8] {
    let start = self.offset;
    let end = start + bytes.len();
    // SAFETY: start..end 落在 capacity 之内（上面已检查），
    // 且两次分配的区域不重叠（offset 单调递增）。
    unsafe {
        let base = self.buffer.as_mut_ptr().cast::<u8>();
        ptr::copy_nonoverlapping(bytes.as_ptr(), base.add(start), bytes.len());
        core::slice::from_raw_parts_mut(base.add(start), bytes.len())
    }
}
```

几个要点：

- 底层用 `Vec<MaybeUninit<u8>>`，表示"这块内存还没初始化"，而不是用一个假初值去糊弄类型系统。
- `copy_nonoverlapping` 而不是 `copy`，因为源和目标保证不重叠。这既是给编译器的信息，也是对不变量的一次声明。
- 返回的 `&mut [u8]` 借用 `&mut self`，于是 Rust 保证同一时刻只有一块活跃切片，非重叠性是**被类型系统强制**的，不靠我口头承诺。
- 每个 `unsafe` 块上面都写 `// SAFETY:` 注释，说明它依赖的不变量。这是 `unsafe` 代码能长期维护的关键：把"为什么安全"写下来，而不是留给下一个人猜。

`alloc_str` 里还用了 `from_utf8_unchecked_mut`。用它是安全的，因为输入本身就是合法的 UTF-8，我按字节复制之后仍然是合法 UTF-8。如果这里偷懒用 `unsafe` 而不清楚为什么，那才是真的危险。

## 下一篇

回收器就绪，但它现在只是一台"会回收"的机器，还没有根。下一篇是栈式 VM：用值栈和调用帧跑指令，把栈上的每个值、每个帧的环境、全局环境都登记成 GC 的根，然后让 fib(20) 在两个后端上都算出 6765，再对比它们的速度。
