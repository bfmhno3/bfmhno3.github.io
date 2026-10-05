---
title: "编译器第一课：把「第几行第几列」做对"
commentId: "post:pebble-02-span-and-diagnostics"
published: "2026-10-05 09:00:00 +08:00"
description: "写编译器最容易被忽视、却贯穿全部代码的东西不是求值，而是位置。我用一个 no_std 的 pebble-span 保存字节偏移与源码映射，用二分查找把偏移换算成行列，再用 pebble-diag 把它渲染成带插入符的错误。这一篇还包括一个我自己写出来、测试却没能发现的渲染 bug。"
category: Note
tags:
  - Rust
  - 编译器
  - 错误处理
  - 诊断
series: "从零写一门语言：Pebble"
seriesOrder: 2
draft: false
comment: true
slug: pebble-02-span-and-diagnostics
---

编译器的产品，一半是"能跑"，另一半其实是**报错**。用户看到的绝大多数时间不是程序跑通的那一刻，而是编译器告诉他哪里写错了的那一刻。所以在 Pebble 里，我第一批写的 crate 不是求值器，而是 `pebble-span` 和 `pebble-diag`。

先说一个反直觉的点：这两块看起来是"边角料"，但它们是**全项目耦合最广**的。词法器、解析器、解释器、VM 全都拿着 `Span` 到处传。所以它必须足够便宜。

## 位置其实只是四个整数

一个 `Span` 是文件编号加上一段字节区间：

```rust
#[derive(Copy, Clone, PartialEq, Eq, Hash)]
pub struct Span {
    pub source: SourceId,
    pub start: u32,
    pub end: u32,
}
```

`Copy` 是刻意的：四个小整数，按值传递永远不会移动任何源码文本。这一点在解析器里很关键，因为解析函数动不动就返回一个带 `Span` 的 `Result`，如果每次都要 clone 一段字符串，性能和心智负担都会上去。

注意 `end` 是**开区间**。`[start, end)` 的好处是"相邻两个 span 首尾相接"，合并和遍历都更省心：

```rust
pub fn merge(self, other: Span) -> Span {
    debug_assert_eq!(self.source, other.source, "tried to merge spans from different files");
    Span {
        source: self.source,
        start: self.start.min(other.start),
        end: self.end.max(other.end),
    }
}
```

跨文件合并是编译器自身的 bug，不是用户的问题，所以这里用 `debug_assert!`：debug 构建里直接炸，release 里不付代价。

## 把偏移换成行列：一次二分查找

`SourceFile` 保存文本，外加一个 `line_starts: Vec<u32>`，记录每一行起始的字节偏移。第一个元素永远是 `0`。

```rust
fn compute_line_starts(text: &str) -> Vec<u32> {
    let mut starts = Vec::with_capacity(text.len() / 24 + 1);
    starts.push(0);
    for (index, byte) in text.bytes().enumerate() {
        if byte == b'\n' {
            starts.push(index as u32 + 1);
        }
    }
    starts
}
```

于是"某个字节偏移在第几行"就变成在 `line_starts` 上做一次二分：

```rust
pub fn line_index(&self, offset: u32) -> u32 {
    // line_starts[0] == 0 <= offset 恒成立，所以结果至少是 1。
    let count = self.line_starts.partition_point(|&start| start <= offset);
    (count - 1) as u32
}
```

`partition_point` 是"第一个不满足谓词的位置"，也就是"有多少个行首小于等于 offset"。减一就是行号。这是我在整个项目里最喜欢的一小段代码：没有循环，没有边界特判，全靠一个标准库方法。

不过行列换算里有个坑，尤其是写中文的人特别容易踩：

```rust
pub fn position(&self, offset: u32) -> Position {
    let index = self.line_index(offset);
    let line_start = self.line_starts[index as usize];
    let head = &self.text[line_start as usize..(offset as usize).min(self.text.len())];
    Position {
        line: index + 1,
        // +1 是因为列号从 1 开始。
        column: head.chars().count() as u32 + 1,
    }
}
```

列号数的是**字符**，不是字节。否则一行里出现一个汉字，后面所有插入符都会错位。对应的测试是这样的：

```rust
#[test]
fn position_counts_characters_not_bytes() {
    // 每个汉字占三个字节；第二行的 "c" 在字符上是第 2 列，
    // 但它的字节偏移是 6。
    let file = SourceFile::new(SourceId(0), "t".into(), "ab\n中c".into());
    let offset = file.text().find('c').unwrap() as u32;
    let pos = file.position(offset);
    assert_eq!(pos.line, 2);
    assert_eq!(pos.column, 2);
}
```

顺带一提，`pebble-span` 是 `#![no_std]` 的，只用 `core` 和 `alloc`。这不是为了炫技，是为了让它能在 `pebble-nostd` 里跑在裸机上。代价是到处写 `alloc::string::String` 而不是 `std::string::String`，习惯了就好。

## 诊断是数据，渲染是另一回事

`pebble-diag` 的核心决定是：**诊断是数据，不打印任何东西**。词法器和解析器只产出 `Diagnostic` 值，渲染留给 CLI。这样才可能"一次报出所有错误，而不是第一个就停"。

```rust
pub struct Diagnostic {
    pub severity: Severity,
    pub code: Option<String>,
    pub message: String,
    pub labels: Vec<Label>,
    pub notes: Vec<String>,
}
```

渲染需要一份 `SourceMap`，因为要回查那一行源码，把插入符画在正确的位置：

```rust
pub fn render(&self, sources: &SourceMap) -> String {
    // ...
    let file = sources.file(label.span.source);
    let pos = file.position(label.span.start);
    // ...
    let line_text = file.line(line_no).unwrap_or("");
    let (caret_col, caret_len) = caret_geometry(file, label.span, line_no, line_text);
    // ...
}
```

`Diagnostic` 还实现了 `core::error::Error`。这在 `no_std` 里曾经是做不到的，Rust 1.81 之后 `core::error::Error` 已经可用，所以 no_std 代码也能正常参与错误链。

## 一个测试没抓住的 bug

写完之后我跑了一下 `examples/errors.pebble`，输出是这样：

```text
error[E1001]: expected an expression, found `;` --> examples/errors.pebble:5:17
  |
5 | let total = 1 + ;
  |                 ^
  |
```

看到了吗？`-->` 和错误信息挤在同一行。原因很简单：写头部的时候我用了 `write!`，忘了换行。

```rust
// 改之前：头部最后一个 write! 不带换行，
// 于是下面的 "--> ..." 被拼到了同一行。
let _ = write!(out, ": {}", self.message);
```

改成一个 `writeln!` 就对了：

```rust
let _ = writeln!(out, ": {}", self.message);
```

更值得说的是：**我的单元测试没有发现这个 bug**。因为原来的断言是 `rendered.contains("error[E0001]: expected an expression")`，它不关心后面是不是紧跟了一个换行。我给它补了一条真正卡住格式的测试：

```rust
assert!(
    rendered.starts_with("error[E0001]: expected an expression\n"),
    "header must be on its own line:\n{rendered}"
);
```

修好之后，同一份输入渲染成：

```text
error[E1001]: expected an expression, found `;`
 --> examples/errors.pebble:5:17
  |
5 | let total = 1 + ;
  |                 ^
  |
```

进程退出码是 `1`，而且它是走 stderr 的，所以 `pebble check` 在正确文件上可以完全静默（CI 里很好用）。

## 一个类比

如果你熟悉 ELF 或任何可执行格式，`SourceMap` 干的事和 **DWARF 的 line table** 是一回事：把"地址"映射回"源文件、行、列"，只不过这里的"地址"是字节偏移。调试器用它告诉你崩溃在哪一行，我用它告诉作者错误在哪一列。

## 下一篇

位置和诊断就位后，就可以正式吃进源码了。下一篇是零拷贝词法器：让它借用 `&str`、用 `Cow` 处理带转义的字符串、并且把未知字符变成一条诊断后继续往右扫，而不是直接放弃。
