---
title: "学习 fgets 函数和 strcspn 函数"
date: 2023-08-20 23:44:31 +08:00
excerpt: "本文记录了在 C 语言刷题过程中遇到的字符串输入问题。详细介绍了 fgets 函数和 strcspn 函数的用法，用于解决 scanf 无法读取带空格字符串以及换行符处理的问题，并补充了 scanf(\"%[^\\n]\") 这一更简洁的替代方案。"
categories:
  - Note
tags:
  - C
---

## 0. 为什么要专门发布一篇文章来说明这两个函数？

原因是今晚上在做牛客网的题目的时候，遇到了这么一个[问题](https://www.nowcoder.com/questionTerminal/cc57022cb4194697ac30bcb566aeb47b?f=discussion&toCommentId=16721626)。

虽然这道题对大多数人来说都算是比较简单的题目，但是对于我这么一个小白还是比较难写的。最开始我是这么写的代码：

```c
#include <stdio.h>

void reverse(char* arr) {
    char* left = arr;
    char* right = &arr[strlen(arr) - 1];
    while(left < right) {
        char mid = *left;
        *left = *right;
        *right = mid;
        left++;
        right--;
    }
    for(int i = 0; i < strlen(arr); i++) {
        printf("%c", arr[i]);
    }
}

int main(void) {
    char arr[10000];//之所以创建这么大一个数组是因为题目中的示例10非常长
    scanf("%s", arr);
    reverse(arr);
    return 0;
}
```

但是这样写代码连题目中的示例 1：输入：`I am a student`；输出：`tneduts a ma I` 都没有通过，最终只输出了一个 `I`。

这是为什么呢？我思索了半天才明白是我的这一行代码 `scanf("%s", arr);` 有问题，就是因为 `scanf("%s", arr)` 会读取一个字符串，但会在遇到空格、制表符或换行符时停止。换句话说，**它只会读取输入字符串中的第一个单词，然后停止**。

例如，如果你输入 "Hello World"，`scanf("%s", str)` 会将 "Hello" 作为一个字符串读取，而 "World" 则会留在输入流中等待后续读取。

所以示例输入的 `I am a student` 只有 `I` 进入了 `arr[10000]` 中，剩下的字符串仍然留在输入流中等待下一次读取。所以最终自然而然也就只会输出 `I`。

知道了问题的原因自然就要想办法解决问题，但是说实话，对于小编这种很笨的学生来说，几乎是不可能的。所以，我就去求助了 ChatGPT。ChatGPT 给出的解决办法是使用 `fgets` 函数，但是我真就第一次听这个函数，也完全不懂这个函数该如何使用，于是我就准备写下这篇文章来记录我的欠缺。

那么下面就开始正题：

## 1. `fgets`函数

### 1.1 函数介绍

`fgets` 是 C 语言标准库 `stdio` 中的一个函数，用于从文件流（通常是标准输入流 `stdin` 或其他文件流）中读取一行字符串。它的主要作用是读取指定长度的字符，并且**会保留换行符（如果存在的话）**。

函数原型：

```c
char *fgets(char *str, int n, FILE *stream);
```

### 1.2 参数说明

+ `str`：一个指向字符数组的指针，用于存储读取的字符串。
+ `n`：要读取的最大字符数（包括字符串结尾的空字符 \0），通常为字符数组的长度。
+ `stream`：文件流指针，通常是 `stdin`（标准输入流）或其他文件指针。
+ `fgets` 会读取指定长度的字符，直到遇到换行符（**包括换行符在内**），或者读取了 `n-1` 个字符（包括字符串结尾的空字符 `\0` ），或者到达文件末尾为止。它会将读取的字符串存储到 `str` 指向的字符数组中，并在字符串的末尾添加一个空字符 `\0`，以表示字符串的结束。

### 1.3 注意事项

+ `fgets` 会保留字符串中的换行符，所以如果不需要换行符，可以使用字符串处理函数（如 `strcspn`）将其替换为空字符 `\0`。
+ 如果输入的字符串的长度超过了指定的 `n-1`，`fgets` 只会读取 `n-1` 个字符，其余字符会留在输入流中，可能影响后续的输入。
+ `fgets` 在成功读取字符串时返回 `str`，在到达文件末尾或发生错误时返回 `NULL`。

### 1.4 使用示例

```c
#include <stdio.h>
#include <string.h>

int main() {
    char str[100]; // 最多读取 99 个字符（包括结尾的空字符）
    
    printf("请输入一个字符串：");
    fgets(str, sizeof(str), stdin); // 从标准输入读取一行字符串
    
    str[strcspn(str, "\n")] = '\0'; // 去掉换行符（如果有）
    
    printf("你输入的字符串是：%s\n", str);
    
    return 0;
}
```

### 1.5 题目代码修改

所以我原本写的代码中的 `scanf("%s", arr)` 应该改成 `fgets(arr, sizeof(arr), stdin)`。

### 是否这么写代码我就能通过测试了呢？

当然不是，事实上代码最终的输出结果是：

```c

tneduts a ma I
```

所以最后的输出还是错误了，多输出了一个换行符 `\n`。

事实上这里有很多种方法可以去除原来字符串末尾的换行符，但我最终选择了使用 `strcspn` 函数来处理,所以下面我会介绍 `strcspn` 函数。

## 2. `strcspn`函数

### 2.1 函数介绍

`strcspn` 是 C 语言标准库 `string` 中的一个函数，用于查找一个字符串中第一次出现指定字符集合中的任何字符的位置。**它返回的是第一个匹配字符的索引位置**。

```c
size_t strcspn(const char *str1, const char *str2);
```

### 2.2 参数说明

+ `str1`：要查找的字符串。
+ `str2`：一个包含字符集合的字符串，`strcspn` 会查找这个字符集合中的字符在 `str1` 中的第一次出现。
+ strcspn 会从 `str1` 的起始位置开始查找，直到遇到 `str2` 中的任何字符，或者到达字符串末尾。**它返回第一个匹配字符的索引位置，如果未找到匹配字符，则返回 `str1` 的长度**。

### 2.3 注意事项

+ `strcspn` 返回的是 `size_t` 类型，它是无符号整数类型。如果未找到匹配字符，返回值会等于字符串的长度。因此，在使用返回值时，应该**注意数据类型和范围**。

### 2.4 使用示例

```c
#include <stdio.h>
#include <string.h>

int main() {
    char str[] = "Hello, World!";
    char chars[] = " ,"; // 字符集合包含空格和逗号

    size_t index = strcspn(str, chars);

    if (index < strlen(str)) {
        printf("第一个匹配字符在位置：%zu\n", index);
        printf("匹配字符是：%c\n", str[index]);
    } else {
        printf("未找到匹配字符\n");
    }

    return 0;
}
```

## 3. 最终代码

```c
#include <stdio.h>

void reverse(char* arr) {
    char* left = arr;
    char* right = &arr[strlen(arr) - 1];
    while(left < right) {
        char mid = *left;
        *left = *right;
        *right = mid;
        left++;
        right--;
    }
    for(int i = 0; i < strlen(arr); i++) {
        printf("%c", arr[i]);
    }
}

int main(void) {
    char arr[100000];
    fgets(arr, sizeof(arr), stdin);
    arr[strcspn(arr, "\n")] = '\0';
    reverse(arr);
    return 0;
}
```

## 4. 题后反思

最终的代码运行成功后，我总有一种大材小用的感觉，我就思考能不能用 `scanf` 函数来实现呢？经过与 ChatGPT 的一番讨论后，我最终找到了另一种更为简单的代码：那就是使用 `%[^\n]` 来格式化输入。

## 5. `%[^\n]`

### 5.1 介绍与解释

`%[^\n]` 是 C 语言中用于格式化输入的格式字符串之一。它用于 `scanf` 函数中，用于读取一行字符串，直到遇到换行符为止。

让我解释一下 `%[^\n]` 的含义：

+ `%[`：这部分表示开始读取一个自定义字符集。在方括号内放置你想要读取的字符的集合。
+ `^`：在方括号内的开头，`^` 表示反转字符集。即，`%[^\n]` 表示读取除换行符外的所有字符。
+ `\n`：这是一个转义序列，表示换行符。

所以，`%[^\n]` 的意思是，**读取除换行符之外的所有字符，直到遇到换行符为止**，并且**不会读取换行符**！！！

## 5.2 再次修改代码

所以，我们最终可以将代码从 `fgets(arr, sizeof(arr), stdin); arr[strcspn(arr, "\n")];` 修改成 `scanf("%[^\n]");`。

## 6. 感悟

通过这到题目，我深刻的感受到了什么叫做“条条大路通罗马”。作为小白的我，还有很多的知识去学习、去探索、去使用。
