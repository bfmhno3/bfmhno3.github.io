---
title: "C++ 中的 stack"
date: 2026-02-19 10:45:00 +08:00
excerpt: "本文从本质需求出发解释栈（LIFO）为何存在，串联函数调用、递归、撤销与括号匹配等典型场景，并结合 C++ STL 的 std::stack 用法、异常安全设计与底层容器选择，最后配合多道题目示例完成从概念到实战的闭环。"
categories:
  - Note
tags:
  - C++
---

要真正理解**栈**这种结构，意味着我们要剥离事物表象，追究其最本质的问题，即**我们到底面临什么样的数据处理需求，才导致了 “栈” 这种结构的诞生？**

我们不需要把栈仅仅看作是教科书上的定义，而是把它看作是**为了解决特定时序问题而设计的一种 “受限” 模型**。

## 1. 什么是栈？

从本质上来说，计算机处理任务通常有两种模式：

1. **并行/随机**：所有任务都在桌面上铺开，想拿哪个拿哪个（类似数组或哈希表）。
2. **嵌套/依赖**：任务 B 必须依赖任务 A 的环境，任务 C 又依赖 B。要完成 A，必须先挂起 A 去做 B；要做 B，必须先挂起 B 去做 C。

**栈**（Stack）就是为了解决第二种模式而诞生的。

### 1.1 核心定义：LIFO

栈是一种**线性表**，但它是一种受限的线性表。它的核心逻辑是**后进先出**（Last In, First Out - LIFO）。

你可以把它想象成**叠盘子**：

- 压入（Push）：你只能把新盘子放在最上面。
- 弹出（Pop）：你只能取走最上面的盘子。
- 查看（Top/Peek）：你只能看到最上面盘子的花纹，无法直接看到底部的盘子。

{% include figure popup=true image_path="/assets/images/a_stack_of_plates.jpg" alt="餐厅里的一摞盘子，展示了后进先出的物理结构" caption="生活中的栈模型：想要拿到底部的盘子，必须先移走顶部的盘子" %}

### 1.2 为什么它是 “受限” 的？

数组（Array）允许你访问 `index[0]` 也可以访问 `index[100]`。栈为什么要把这种能力 “阉割” 掉？

答案就是**为了强制秩序**。

通过限制 “只能操作顶部”，栈强制程序员必须按照严格的 “原路返回” 逻辑来处理数据，从而消除了随机访问带来的复杂性和潜在错误。

## 2. 为什么需要栈？

如果计算机世界没有栈，很多基础逻辑就会崩塌。我们需要栈，是因为它是**保存上下文**（Context）和**实现回朔**（Backtacking）最自然的模型。

### 2.1 函数调用（The Call Stack）

这是栈存在最底层、也最不可或缺的原因。

从本质上来说，CPU 在执行代码时是个高度专注的执行机器，它完全依赖程序计数器（PC, Program Counter）来决定下一步跑哪条指令。当代码从 `main()` 跳转到 `func_a()` 时，本质上是强行修改了 PC 寄存器的值。随之而来的致命问题是：当 `func_a()` 跑完，CPU 怎么知道该跳回 `main()` 里的哪一行继续执行？

你可能会想，用一个专门的寄存器（比如链接寄存器 LR）把返回地址保存起来不就行了？

在只有单层调用的情况下，这确实可行。但现实是，代码中充满了**嵌套调用**：`main()` 调用了 `func_a()`，而 `func_a()` 中又调用了 `func_b()`。如果只依赖单一寄存器，当调起 `func_b()` 时，新的返回地址回无情地覆盖掉之前 `func_a()` 的返回地址。等到 `func_b()` 执行结束，程序就再也找不到回 `main()` 的路了。

此外，函数不仅需要记住 “从哪儿来”，还要保护好自己的 “现场”。每个函数都有自己的局部变量，执行时还会征用各种通用寄存器。在跳入下一个函数前，当前的这些状态（Context）必须被原封不动地保存下来。

由于函数调用的逻辑是绝对的 “嵌套与回溯”——最后被调用的 `func_b()` 必须最先执行完毕并交出控制权，`func_a()` 才能继续，做后才轮到最外层的 `main()`。这种 “**后出发的先结束，先出发的最后兜底**” 的生命周期，与 LIFO (Last-In, First-Out) 结构严丝合缝。

所有，系统在内存中专门开辟了**调用栈**（Call Stack）。每次进入新函数，就把它的返回地址、局部变量和寄存器状态打包成一个**栈帧**（Stack Frame）压入栈顶；函数一结束，就将栈顶**弹出**，完美恢复上一层函数的现场。没有栈，现代编程语言的函数嵌套和递归机制就根本无法实现。

{% include figure popup=true image_path="/assets/images/call_stack_layout.svg" alt="调用栈内存布局示意图：展示了DrawLine子程序位于栈顶，DrawSquare位于下方" caption="调用栈示例：如果子程序 `DrawSquare` 调用了 `DrawLine`，`DrawLine` 的栈帧就会被压入栈顶（如图中绿色部分所示）。栈指针（Stack Pointer）始终指向最新的栈顶位置" %}

### 2.2 递归（Recursion）

既然函数调用依赖栈来保存上下文，那么**递归**可以说是把栈的这种特性压榨到了机制。

{% include figure popup=true image_path="/assets/images/recursive_drawing_of_a_sierpinski_triangle_through_turtle_graphics.gif" alt="使用海龟绘图递归绘制谢尔宾斯基三角形的动画" caption="使用海龟绘图（Turtle Graphics）递归绘制谢尔宾斯基三角形（Sierpinski triangle）的过程" %}

从人类的思维来看，递归是**自己调用自己**，但在 CPU 和内存眼里，根本没有 “同一个函数” 的概念。对于计算机而言，不管是 `func_a()` 调用 `func)b()`，还是 `func_a()` 调用 `func_a()`，动作是完全一样的——仅仅是 PC（程序计数器）指针跳转，并在内存中开辟一个新的栈帧。

假设我们在写一个计算阶乘的递归函数（`fact(n)`）。当 `func(3)` 内部调用 `fact(2)` 时，此时的局部变量 `n=3` 必须被冻结并保护起来。如果没有栈 `fact(2)` 内部的变量就会直接覆盖掉原来 `n=3` 的内存空间。等到递归触底反弹时，程序根本想不起最初传入的参数是什么。

得益于栈的 LIFO 机制，每一次自我调用，系统都会把当前的参数、局部变量和返回地址像叠盘子一样**压入**（Push）栈中。不管向下深挖了多少层，每一层的数据都被独立且安全地封存在自己的栈帧里。当遇到终止条件（Base Case）开始回归时，栈再一层层**弹出**（Pop），精准地恢复每一层的现场。可以说，**栈时递归能够成立的物理载体**。

当然，如果嵌套层数过深导致栈空间耗尽，就会引发经典的 Stack Overflow 栈溢出。

### 2.3 状态撤销（Undo）与历史回溯

你在编辑器里敲击键盘，后者在设计软件中画图，想要按下 <kbd>Ctrl</kbd> + <kbd>Z</kbd> 撤销刚刚的失误。

人类的时间是线性向前的，但 “撤销” 操作要求我们能够**逆转时间**。这种逆转不是随机的，而是必须严格遵守 “最近发生的事情，最先被抹去” 的自然法则。你最后敲下的那一个字符，必须是第一个被删除的。

所以，这里的历史记录被抽象成了一个栈：

- **入栈**（Push）：每当你执行一个操作（比如输入字符、改变颜色、移动光标），系统就会把这个动作的 “状态快照” 或 “增量数据” 打包，压入历史记录栈的栈顶。
- **出栈**（Pop）：当年你触发撤销（Undo）时，系统直接从栈顶取回最后一次保存的状态，并将其弹出，界面随之恢复到上一个时刻。

没有栈这种 “后进先出” 的模型，系统就无法建立起具有时间顺序的后悔药机制。**任何需要 “原路” 返回的场景**（比如浏览器的 “后退” 按钮、迷宫算法的回溯路径），其背后的灵魂数据机构都是栈。

### 2.4 符号匹配与语法解析

编译器在编译代码时，或者解析器在处理一段复杂公式时，需要检查代码中的 `{ [ ( ) ] }` 括号是否成对闭合、合法嵌套。

编译器阅读代码的顺序是从左到右的单向扫描。但在代码的世界里，**最晚开启的作用于，必须最早被关闭**。这种一种典型的 LIFO 结构需求。

面对一长串括号，系统处理的算法极其优雅，完全依赖栈来实现：

1. **扫描与入栈**：逐个字符读取，只要遇到 “左括号”（如 `{`、`[`、`(`），不管三七二十一，直接压入栈中。这代表着进入了一个新的层级，正在等待它的结束。
2. **匹配与出栈**：一旦遇到 “右括号”（如 `)`、`]`、`}`），此时立刻去查看**栈顶**元素。如果栈顶正好是能与它匹配的左括号，说明当前最内层的逻辑闭环了，于是将栈顶弹出，继续往下走。

{% include figure popup=true image_path="/assets/images/parentheses_matching.webp" alt="栈用于括号匹配的流程图" caption="利用栈进行括号匹配的逻辑：左括号入栈，右括号消栈，最后栈空则合法" %}

如果遇到右括号时栈是空的（说明没有多余的左括号等待闭合），或者栈顶的左括号类型不匹配（比如 `{` 遇到了 `]`），那么编译器就可以立刻抛出 `Syntax Error`（语法错误）。当整个文件扫描完，如果栈里面还有残留的左括号，说明有作用域没关上。

利用栈，编译器不仅能判断对错，还能精准定位到哪一层的括号出了问题。

## 3. C++ STL 中的 `std::stack`

在 C++ 标准模板库（STL）中，`std::stack` 被设计得非常精妙。它不是一个从零开始写的容器，而是一个**容器适配器**（Container Adapter）。

### 3.1 什么是 “容器适配器”？

`std::stack` 本身不直接管理内存，它更像是一个外壳。它内部包裹着另一个真正的容器（比如 `std::vector`、`std::deque` 后 `std::list`）。

它屏蔽了底层容器的随机访问结构（如 `[]`），只暴露 `push`、`pop`、`top` 等接口，从而强制你遵守栈的规则。

### 3.2 核心语法与操作

在使用前需包含头文件：

```cpp
#include <stack>
```

基本操作（时间复杂度均为 $O(1)$）。

|操作|函数|描述|注意事项|
|:---:|:---|:---|:---|
|入栈|`push(val)`|将元素拷贝到栈顶|设计拷贝/移动构造|
|原地构造|`emplace(args)`|在栈顶直接构造元素|**推荐**，比 `push` 更高效，省去拷贝|
|出栈|`pop()`|移除栈顶元素|**返回值为 `void`**，不返回被移除的元素|
|查看|`top()`|返回栈顶元素的引用|如果栈为空调用此函数回导致未定义行为（通常崩溃）|
|判空|`empty()`|栈为空返回 `true`|操作前务必检查|
|大小|`size()`|返回元素数量|-|

{% include figure popup=true image_path="/assets/images/a_stack_runtime_with_push_and_pop_operations.svg" alt="栈的 Push 和 Pop 操作示意图" caption="Push 操作将元素压入栈顶，Pop 操作移除栈顶元素，两者都不能触及栈底" %}

### 3.3 为什么 C++ 的 `pop()` 不返回元素？

在很多其他语言（如 Java, Python）中，`pop()` 会移除并返回栈顶元素。但在 C++ STL 中，`pop()` 是 `void`，你需要先 `top()` 获取值，再 `pop()` 移除。

究其原因是**异常安全**（Exception Safety）。

如果 `pop()` 函数即移除元素又返回元素（按值返回），在返回过程中如果发生了**拷贝构造异常**（比如内存不足），那么这个元素即从栈里丢了，又没能成功交给调用者，导致数据永久丢失。

将 `top()` 和 `pop()` 分离是 C++ 追求安全的体现。

## 4. 算法题实战

点击题目即可跳转。

### 4.1 [洛谷：B3614【模板】栈](https://www.luogu.com.cn/problem/B3614)

```cpp
#include <iostream>
#include <cstdint>
#include <string>

using namespace std;

const uint64_t N = 10e6 + 1;
uint64_t stk[N] = {0};
uint64_t top_idx = 0; // 栈顶指针，指向栈顶元素的下一个位置

int main(void) {
    uint64_t t = 0;
    cin >> t; // 数据组数

    while (t--) {
        top_idx = 0; // 每组数据都清空栈
        uint64_t n = 0; // 操作的次数
        cin >> n;

        while (n--) {
            string operation;
            uint64_t x = 0;
            cin >> operation;

            if ("push" == operation) {
                cin >> x;
                stk[top_idx++] = x;
            } else if ("pop" == operation) {
                if (0 == top_idx) {
                    cout << "Empty" << endl;
                } else {
                    --top_idx;
                }
            } else if ("query" == operation) {
                if (0 == top_idx) {
                    cout << "Anguei!" << endl;
                } else {
                    cout << stk[top_idx - 1] << endl;
                }
            } else if ("size" == operation) {
                cout << top_idx << endl;
            } else {
                continue;
            }
        }
    }

    return 0;
}
```

### 4.2 [力扣：20. 有效的括号](https://leetcode.cn/problems/valid-parentheses/description/)

```cpp
class Solution {
public:
    bool isValid(string s) {
        std::stack<char> stk;
        
        for (const char& c : s) {
            if ('(' == c || '[' == c || '{' == c) {
                stk.push(c);
            } else {
                if (stk.empty()) {
                    return false;
                }

                char top = stk.top();

                if (')' == c && '(' != top) {
                    return false;
                }

                if (']' == c && '[' != top) {
                    return false;
                }

                if ('}' == c && '{' != top) {
                    return false;
                }

                stk.pop();
            }
        }

        return stk.empty();
    }
};
```

### 4.3 [洛谷：【深基15.习9】验证栈序列](https://www.luogu.com.cn/problem/P4387)

```cpp
#include <iostream>
#include <vector>
#include <stack>

constexpr int N = 1000000 + 1;

int main(void) {
    std::vector<int> pushed(N);
    std::vector<int> popped(N);

    int q = 0;
    std::cin >> q;

    while (q--) {
        int n = 0;
        std::cin >> n;

        // 读取入栈序列
        for (int i = 0; i < n; i++) {
            std::cin >> pushed[i];
        }

        // 读取出栈序列
        for (int i = 0; i < n; i++) {
            std::cin >> popped[i];
        }

        // 模拟验证
        std::stack<int> stk;
        int popped_idx = 0;

        // 依次入栈
        for (int i = 0; i < n; i++) {
            stk.push(pushed[i]);

            while (popped_idx < n && !stk.empty() && stk.top() == popped[popped_idx]) {
                stk.pop();
                popped_idx++;
            }
        }

        // 判断
        if (stk.empty()) {
            std::cout << "Yes" << std::endl;
        } else {
            std::cout << "No" << std::endl;
        }
    }


    return 0;
}
```

### 4.4 [洛谷：P1449 后缀表达式](https://www.luogu.com.cn/problem/P1449)

```cpp
#include <iostream>
#include <stack>
#include <string>

int main(void) {
    std::stack<int> stk;
    std::string expression;
    std::string num_str;
    int num = 0;
    int result = 0;

    std::cin >> expression;

    for (const char& ch : expression) {
        if (ch == '@') break;
    
        if (std::isdigit(static_cast<unsigned char>(ch))) {
            num_str += ch;
        } else if (ch == '.') {
            if (!num_str.empty()) {
                stk.push(std::stoi(num_str));
                num_str.clear();
            }
        } else {
            int a = stk.top(); stk.pop();
            int b = stk.top(); stk.pop();
            int result = 0;
            switch (ch) {
                case '+': result = b + a; break;
                case '-': result = b - a; break;
                case '*': result = b * a; break;
                case '/': result = b / a; break;
            }
            stk.push(result);
        }
    }

    result = stk.top();

    std::cout << result << std::endl;

    return 0;
}
```

### 4.5 [洛谷：P1241 括号序列](https://www.luogu.com.cn/problem/P1241)

```cpp
#include <iostream>
#include <string>
#include <stack>
#include <vector>

bool is_match(char left, char right) {
    return ('(' == left && ')' == right) || ('[' == left && ']' == right);
}

int main(void) {
    std::string expression;
    std::cin >> expression;

    std::stack<int> stk;
    std::vector<bool> matched(expression.size(), false);

    for (int i = 0; i < static_cast<int>(expression.size()); ++i) {
        char ch = expression[i];
        if ('(' == ch || '[' == ch) {
            stk.push(i);
            continue;
        }

        if (!stk.empty() && is_match(expression[stk.top()], ch)) {
            matched[stk.top()] = true;
            matched[i] = true;
            stk.pop();
        }
    }

    for (int i = 0; i < static_cast<int>(expression.size()); ++i) {
        if (matched[i]) {
            std::cout << expression[i];
            continue;
        }

        if ('(' == expression[i] || ')' == expression[i]) {
            std::cout << "()";
        } else {
            std::cout << "[]";
        }
    }
    std::cout << std::endl;
    
    return 0;
}
```

## 5. 进阶知识（底层容器的选择）

[`std::stack`](https://en.cppreference.com/w/cpp/container/stack.html) 是一个模板类（定义在头文件 `<stack>`），定义如下：

```cpp
template<class T, class Container = std::deque<T>>
class stack;
```

注意第二个参数 `Container`。默认情况下，C++ 使用 `std::deque`（双端队列）作为底层容器，而不是 `std::vector`。

### 5.1 为什么默认用 `std::deque` 而不是 `std::vector`？

1. **扩容代价**：`std::vector` 在内存不足扩容时，需要把所有元素搬运到新内存块，代价较大。`std::deque` 是分段内存，扩容时只需分配新段，不需要搬运旧数据。
2. **内存效率**：对于大量进出的栈操作，`std::deque` 的内存回收和分配策略通常比 `std::vector` 更平滑。

{% include figure popup=true image_path="/assets/images/double_ended_queue_in_stl.png" alt="STL 中双端队列 deque 的内部结构示意图" caption="std::deque 的内部结构：由中控器（Map）管理的一系列分段连续内存缓冲区，非常适合两端操作" %}

当然，如果你确定需要极致的连续内存性能，也可以手动指定：

```cpp
std::stack<int, std::vector<int>> stk;
```

## 参考资料

1. [Wikipedia: Stack (abstract data type)](https://en.wikipedia.org/wiki/Stack_(abstract_data_type))  
2. [Wikipedia: Call stack](https://en.wikipedia.org/wiki/Call_stack)
3. [Wikipedia: Recursion (computer science)](https://en.wikipedia.org/wiki/Recursion_(computer_science))
4. [Medium: Valid Parentheses in a String](https://medium.com/@goyalarchana17/scala-interview-series-valid-parentheses-in-a-string-ac7002c79642) 
5. [StackOverflow: Difference between deque and list](https://stackoverflow.com/questions/1436020/whats-the-difference-between-deque-and-list-stl-containers)
6. [cppreference.com: std::stack](https://cppreference.com/w/cpp/container/stack)
