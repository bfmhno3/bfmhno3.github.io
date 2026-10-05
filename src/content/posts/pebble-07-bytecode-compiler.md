---
title: "字节码编译器：跳转回填与一个顺序写反的 bug"
commentId: "post:pebble-07-bytecode-compiler"
published: "2026-10-05 14:00:00 +08:00"
description: "为了让程序变成线性的、能被一个循环驱动，我写了字节码编译器。这一篇讲指令流与常量池、用占位再回填处理前向跳转、把 for 脱糖成隐藏计数器循环，以及一次「callee 和参数压栈顺序写反」让我盯着列表报错「不是函数」看了半天的经历。"
category: Note
tags:
  - Rust
  - 字节码
  - 编译器
  - 虚拟机
series: "从零写一门语言：Pebble"
seriesOrder: 7
draft: false
comment: true
slug: pebble-07-bytecode-compiler
---

树遍历解释器是"边走树边求值"。它的直接问题是慢：每执行一个节点都要重新匹配一遍枚举，而且要递归下去。想控制住执行流，标准做法是把它**编译成一串线性指令**，然后用一个循环去驱动。

> [!TIP] 先读基础篇
> 本篇用 `enum` + `match` 表达指令，用 `Vec` 存指令流。基础篇 1（enum 与 match）和 2（Vec）够了。

## 一条指令流加一个常量池

Pebble 的指令是枚举，带 `u32` 操作数：

```rust
opcode_set! {
    pub enum Opcode {
        Const(u32),       // 压入常量池第 operand 项
        Nil, True, False, Pop,
        DefineName(u32),  // 在当前帧定义常量池里的名字
        GetName(u32),     // 读取名字
        SetName(u32),     // 赋值
        MakeClosure(u32), // 用常量池里的函数原型造一个闭包，捕获当前帧
        Add, Sub, Mul, Div, Rem, Neg, Not,
        Equal, NotEqual, Less, LessEqual, Greater, GreaterEqual,
        Jump(u32), JumpIfFalse(u32), JumpIfFalseKeep(u32), JumpIfTrueKeep(u32),
        Call(u32), Return,
        BuildList(u32), BuildMap(u32), Index, SetIndex,
    }
}
```

`Chunk` 装指令、常量池，还有和指令一一对应的源码位置（出运行时错误时能画出正确的插入符）：

```rust
pub struct Chunk {
    code: Vec<Opcode>,
    constants: Vec<Constant>,
    spans: Vec<Span>,
}
```

注意操作数存进枚举里，而不是像真实字节码那样把字节平铺进指令流。这是教学上的简化，但我留了一个 `operand_bytes()` 把差异量化出来：

```rust
pub fn operand_bytes(self) -> usize {
    match self {
        Opcode::Const(_) | Opcode::Add(..) /* ... */ => 4,
        _ => 0,
    }
}
```

真实格式里 `Const` 会占用 1 字节 opcode 加 4 字节操作数；这里它只占一个枚举空间。反过来说，Pebble 的"字节码"其实更接近"带内联操作数的指令数组"，但驱动方式和真正的字节码 VM 完全一样。

## 变量按名字解析

一个关键决定：**变量在运行时按名字查找**。编译器不分析作用域，只是发射 `GetName` / `SetName` / `DefineName`，名字以字符串常量的形式进池子：

```rust
Stmt::Let { name, value, .. } => {
    self.compile_expr(value);
    let index = self.name_const(&name.name);
    self.emit(Opcode::DefineName(index), span);
}
```

这样闭包实现起来只要"捕获当前帧"，不需要做 upvalue 分析。代价是每个变量访问都要在环境链上做一次哈希查找，慢。真编译器会把它降低成栈槽下标加 upvalue 捕获，这正是留给读者的优化。

## 前向跳转：先占位，再回填

`if` 要跳过 then 分支，但编译 then 的时候还不知道 else 在哪。经典解法是先发一条占位的 `Jump`，记下它的位置，等目标确定再改：

```rust
fn patch_jump(&mut self, at: usize, target: usize) {
    let target = target as u32;
    self.code[at] = match self.code[at] {
        Opcode::Jump(_) => Opcode::Jump(target),
        Opcode::JumpIfFalse(_) => Opcode::JumpIfFalse(target),
        // ...
        ref other => panic!("cannot patch {other:?} as a jump"),
    };
}
```

`if` 的编译就是"占位、编译两段、回填"：

```rust
self.compile_expr(cond);
let jump_else = self.chunk.placeholder(Opcode::JumpIfFalse(0), span);
for stmt in then_branch { self.compile_stmt(stmt); }
let jump_end = self.chunk.placeholder(Opcode::Jump(0), span);
let else_target = self.here();
self.chunk.patch_jump(jump_else, else_target);
for stmt in else_branch { self.compile_stmt(stmt); }
let end = self.here();
self.chunk.patch_jump(jump_end, end);
```

`while` 多一步：循环体结束后要发一条**向后**的跳转回到循环开头。`break` / `continue` 则各自占一个位，等循环结束时统一回填到 "退出点" / "循环头"。

## `for` 是脱糖出来的

Pebble 没有专门的迭代指令。`for x in e { body }` 被脱糖成一个隐藏计数器的 `while` 循环，用的是两个不可能和用户变量重名的名字（带空格）：

```rust
let iter_name = self.name_const(" #iter");
let index_name = self.name_const(" #idx");
// #iter = e; #idx = 0;
// while #idx < len(#iter) { let x = #iter[#idx]; body; #idx = #idx + 1; }
```

`len` 本身是个内建函数，所以条件那行要发射一次函数调用：

```rust
self.emit(Opcode::GetName(index_name), span);
self.emit(Opcode::GetName(len_name), span);   // callee 先压栈
self.emit(Opcode::GetName(iter_name), span);  // 参数后压栈
self.emit(Opcode::Call(1), span);
self.emit(Opcode::Less, span);
```

## 那次写反顺序

上面这段注释里的"callee 先压栈"是我补上的，因为第一版我写反了：

```rust
// 错误的第一版：先压 iter，再压 len
self.emit(Opcode::GetName(iter_name), span);
self.emit(Opcode::GetName(len_name), span);
self.emit(Opcode::Call(1), span);
```

`Call(1)` 的约定是"栈顶是一个参数，它下面是被调用者"。写反之后，`len` 成了参数，`#iter`（一个列表）成了被调用者。于是运行 `for` 循环会报：

```text
error[E2001]: list is not callable
 --> <test>:3:13
  |
3 |             for i in range(10) {
  |             ^^^^^^^^^^^^^^^^^^^^
  |
```

"列表不可调用"这句话本身没错，只是它没告诉我真正的原因。把两行 `GetName` 对调就好了。这个 bug 让我养成一个习惯：给**压栈顺序**写一行注释，因为它是那种"看代码看不出来、跑起来才暴露"的错误。

## 反汇编一段真程序

编译器自带反汇编器。拿 `examples/fib.pebble` 来跑 `--dump-bytecode`，主 chunk 长这样：

```text
== constants ==
     0 <function fib>
     1 "fib"
     2 "print"
     3 20
== code ==
     0 MakeClosure 0
     1 DefineName 1
     2 GetName 2       # print
     3 GetName 1       # fib
     4 Const 3         # 20
     5 Call 1          # fib(20)
     6 Call 1          # print(...)
```

嵌套的 `fib` 函数还带着自己的常量池和代码，被缩进打印出来：

```text
      -- function fib --
      == constants ==
           0 "n"
           1 2
           2 "fib"
           3 1
      == code ==
           0 GetName 0        # n
           1 Const 1          # 2
           2 Less             # n < 2
           3 JumpIfFalse -> 7 # 不满足就跳到递归体
           4 GetName 0
           5 Return
           6 Jump -> 7
           7 GetName 2        # fib
           8 GetName 0        # n
           9 Const 3          # 1
          10 Sub              # n - 1
          11 Call 1
          12 GetName 2        # fib
          13 GetName 0        # n
          14 Const 1          # 2
          15 Sub              # n - 2
          16 Call 1
          17 Add
          18 Return
          19 Nil
          20 Return
```

对着这段可以逐句验证：`if n < 2` 编译成了 `Less` + `JumpIfFalse`；`fib(n-1) + fib(n-2)` 是两次 `Call 1` 加一个 `Add`；函数体末尾自动补了 `Nil; Return`，保证每条路径都有一个返回值。

## 下一篇

指令有了，但还没有驱动它的机器，也没有能回收内存的东西。下一篇是整条路线里最难也最有意思的一环：手写一个标记清除垃圾回收器，用 `unsafe`、`MaybeUninit` 和内部可变性，把第六篇里那个泄漏的环真正收掉。
