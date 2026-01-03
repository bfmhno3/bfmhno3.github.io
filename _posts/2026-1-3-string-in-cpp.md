---
title: "C++ 中的 string"
date: 2026-01-03 16:28:00 +08:00
excerpt: "深入理解 C++ 标准库中的 std::string 类：从基本用法到底层原理，涵盖初始化、容量管理、元素访问、修改操作、类型转换等核心知识点，以及 SSO 优化、string_view 等现代特性和最佳实践。"
categories:
  - Note
tags:
  - C++
---

`std::string` 是 C++ Standard Library 提供的标准类之一，这也是 C++ 开发中最常用的类之一，它本质上是对 C 风格字符串（`char*`）的封装，提供了自动内存管理和丰富的操作接口。

## 核心概念

`std::string` 位于 `<string>` 头文件中，本质上是对 `std::basic_string<char>` 的特化版本。

- 头文件：`#include <string>`
- 命名空间：`std`
- 特点：动态管理内存，自动处理扩容，兼容 C 风格字符串。

## 初始化与构造

```cpp
#include <string>
#include <vector>

std::string s1;                     // 默认构造，空字符串 ""
std::string s2 = "Hello, World";    // 拷贝初始化
std::string s3("Hello, World");     // 直接初始化
std::string s4(5, 'A');             // 生成 "AAAAA"
std::string s5(s2);                 // 拷贝构造
std::string s6(s2, 1, 3);           // 子串构造：从索引 1 开始取 3 个字符 -> "ell"

// C++11 及以后
std::string s7 = {'H', 'i'};        // 列表初始化
```

## 容量与属性

了解容量对于优化性能至关重要，特别是避免不必要的内存重分配。

|函数|说明|备注|
|`size()` / `length()`|返回字符数量|两者完全等价，一般用 `size()`|
|`empty()`|判断是否为空|推荐使用，比 `size() == 0` 语义更清晰|
|`capacity()`|当前分配的内存容量|通常 `>=size()`|
|`reserve(n)`|预分配 `n` 字节内存|避免 `append` 时的多次内存重分配|
|`shrink_to_fit()`|释放多余内存（C++11）|让 `capacity` 接近 `size`|

## 元素访问与遍历

### 访问单个字符

- `operator[]`：`s[i]`。**不检查越界**，效率高，但越界为导致未定义行为。
- `at()`：`s.at[i]`。**检查越界**，越界会抛出 `std::out_of_range` 异常。
- `front()` / `back()`：访问首尾字符。

### C 风格字符串

- `c_str()`：返回 `const char*`，以 `NULL` 结尾。主要用于兼容旧式 C 接口（如 `printf`）。
- `data()`：C++11 前不保证 `NULL` 结尾，C++11 后与 `c_str()` 基本一致。

### 遍历

```cpp
std::string s = "Hello, World";

// 1. 基于下标
for (size_t i = 0; i < s.size(); ++i) { /* ... */ }

// 2. 基于迭代器
for (auto it = s.begin(); it != s.end(); ++i) { /* ... */}

// 3. 基于范围 for 循环（C++11，推荐）
for (char c: s) { /* ... */ }       // 值拷贝
for (char& c: s) { c = toupper(c) } // 引用修改
```

## 修改与操作

|操作|函数|示例|
|追加|`+=`、`append()`、`push_back()`|`s += " World"`|
|插入|`insert(pos, str)`|`s.insert(0, "Hi ")`|
|删除|`erase(pos, len), pop_back()`|`s.erase(0, 3)`|
|替换|`replace(pos, len, str)`|`s.replace(6, 5, "C++")`|
|清空|`clear()`|把 `size` 设置为 0，`capacity` 通常不变|
|截断/扩充|`resize(n)`|改变 `size`，多出的补默认值|

## 查找与子串

所有查找函数如果未找到，都会返回常量 `std::string::npos`（通常是 `-1` 的无符号形式，即最大的 `size_t()`）。

```cpp
std::string = "filename.txt";

// 1. 查找 find
size_t pos = s.find(".");
if (pos != std::string::npos) {
    // 找到了
}

// 2. 反向查找 rfind（找最后一个出现的位置）
size_t last_dot = s.rfind(".");

// 3. 查找集合 find_first_of / find_first_not_of
// 查找第一个出现的元音字母
size_t v_pos = s.find_first_of("aeiou");

// 4. 获取子串 substr
// 参数：substr(开始位置, 长度)
std::string name = s.substr(0, pos); // "filename"
std::string ext = s.substr(pos + 1); // "txt"（省略长度则取到末尾）
```

## 类型转换

需要包含头文件 `<string>`。

### 数值转字符串 `std::to_string(value)`

```cpp
std::string s = std::to_string(3.14); // "3.140000"
```

### 字符串转数值

- `std::stoi(s)`：`int`
- `std::stol(s)`：`long`
- `std::stod(s)`：`double`
- 注意：这些函数会处理前导空格，但遇到非法字符会抛异常

## 现代化特性

### C++17：`std::string_view`

`std::string` 是 “拥有者”，其拷贝开销大。`std::string_view` 只是一个 “观察者”（包含指针和长度），零拷贝。

函数参数尽量使用 `std::string_view` 代替 `const std::string&`，特别是当你只需要读取字符串内容时。

```cpp
// 避免了临时 std::string 对象的构造和内存分配
void print_prefix(std::string_view sv) {
    i f(sv.substr(0, 3) == "Pre") { // substr 也是 O(1) 操作
        // ...
    }
}
```

### C++20

填补了长期以来 C++ `std::string` 缺少高频接口的遗憾：

- `s.starts_with("prefix")`：判断前缀
- `s.ends_with("suffix")`：判断后缀
- `s.contains("sub")`：判断包含

## 底层原理

### SSO（Small String Optimization）

**原理**：为了避免短字符串频繁的堆内存分配（Heap Allocation），`std::string` 内部通常有一个小的栈缓冲区（通常 15 或 22 字节，取决于编译器实现）。

**效果**：

- 如果字符串很短（例如：`"Hello"`），直接存放在栈上对象内部，无 `malloc`，速度极快。
- 如果字符串变长，才会在堆上分配内存，指针指向堆。

### COW（Copy-On-Write）

在 C++11 之后已被废弃。现在的标准规定 `std::string` 不允许使用 COW。这意味着 `std::string a = b;` 一定会发生深拷贝（除非使用 `std::move`）。

## 最佳实践

### 参数传递

- 只读不拥有：C++17 前用 `const std::string&`，C++17 后优先用 `std::string_view`。
- 需要修改：用 `std::string&`。
- 需要拥有权（Sink）：可以直接传值 `std::string` 并配合 `std::move`。

### 性能优化

- 在循环中追加字符串前，先用 `reserve()` 预留空间（写在循环之前）。
- 尽量避免在循环内部频繁构造 `std::string`。
- 换行符优先用 `\n` 而不是 `std::endl`（除非你需要立即刷新缓冲区）。

### 安全性

- 永远不要对 `c_str()` 返回的指针进行 `delete` 操作。
- 当 `string` 对象被修改或销毁后，之前获取的 iterators、references 和 pointers（如 `c_str()` 的结果）可能会失效。
