---
title: "18.06 第 3 讲：矩阵乘法的四种看法与逆矩阵"
commentId: "post:linear-algebra-03-multiplication-and-inverse"
published: "2026-10-18 08:40:00 +08:00"
description: "MIT 18.06 第 3 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 把矩阵乘法的五种算法逐一对照 A @ B，再手写 Gauss-Jordan 求逆，把奇异矩阵的 6 改成 6 + 1e-8 之后，逆里最大的元素涨到了 6e+08。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 矩阵乘法
  - 逆矩阵
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 3
draft: false
comment: true
slug: linear-algebra-03-multiplication-and-inverse
---

这一讲有两个想法。第一，$AB$ 怎么算都行：按元素、按列、按行、按“列乘行再相加”、按分块，结果相同，但每一种看法回答的问题不一样。第二，求 $A^{-1}$ 就是同时解 $n$ 个方程组，Gauss-Jordan 把它们并排放在一起消元。我把五种乘法算法各写了一遍，和 `A @ B` 的差都在 $1.4 \times 10^{-15}$ 以内；再把奇异矩阵 $\begin{bmatrix} 1 & 3 \\ 2 & 6 \end{bmatrix}$ 的 6 改成 $6 + 10^{-8}$，逆矩阵里最大的元素就从“不存在”变成了 $6 \times 10^{8}$。

> [!NOTE] 本讲速览
> 视频：[Lecture 3: Multiplication and inverse matrices](https://www.youtube.com/watch?v=FX4C-JpTFgY)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-3-multiplication-and-inverse-matrices/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §1.4 Matrix Multiplication AB and CR；§2.2 Elimination Matrices and Inverse Matrices
> 前置：[第 2 讲：用矩阵做消元](/posts/linear-algebra-02-elimination-with-matrices/)
> 一句话：$AB$ 的每一列是 $A$ 的列的组合，每一行是 $B$ 的行的组合；方阵 $A$ 没有逆，当且仅当存在非零的 $\mathbf{x}$ 使 $A\mathbf{x} = \mathbf{0}$；对 $[A\ I]$ 消元到左边变成 $I$，右边就是 $A^{-1}$。

> [!TIP] 配合视频
> - 开头他把 $c_{34}$ 的下标公式写了一遍，又讲了形状规则（$m \times n$ 乘 $n \times p$ 得 $m \times p$）。这一段熟悉的人可以倍速，但“按列、按行”两个看法请认真听，后面整门课都在用。
> - “列乘行”那一段要看：他拿 $(2, 3, 4)$ 乘 $(1, 6)$ 做例子，顺便说了“所有行落在同一条直线上”，这是第 11 讲秩 1 矩阵的伏笔。
> - 分块乘法很短，本篇用代码验证过了，倍速即可。
> - 讲逆矩阵时，他给奇异矩阵找了三个理由，其中“有非零向量被送到零”是他最喜欢的。这一段要一字不漏地听。Gauss-Jordan 的消元步骤本篇会重算，看他怎么解释“为什么右边会变成逆”就够了。

## 元素、列、行：三种看法

先是最熟悉的那种。$C = AB$ 的第 $i$ 行第 $j$ 列，是 $A$ 的第 $i$ 行与 $B$ 的第 $j$ 列的点积。他取了 $c_{34}$ 做例子，把它写成求和：

$$
c_{34} = a_{31}b_{14} + a_{32}b_{24} + \cdots + a_{3n}b_{n4}
= \sum_{k=1}^{n} a_{3k}b_{k4}
$$

求和指标 $k$ 沿着 $A$ 的行走，同时沿着 $B$ 的列走，所以 $A$ 的列数必须等于 $B$ 的行数。设 $A$ 是 $m \times n$，$B$ 是 $n \times p$，那么 $C$ 是 $m \times p$，一共 $mp$ 个元素，每个元素 $n$ 次乘法。这是“大家都这么算”的方式。他自己也这么算，不过他说整门课他几乎不下到元素这一层，因为整列整行的看法更有用。

**按列看是什么样的？** 把 $B$ 看成 $p$ 列并排放着。$A$ 乘第一列，得到 $C$ 的第一列；$A$ 乘第二列，得到 $C$ 的第二列，以此类推。矩阵乘向量我们在第 1 讲已经会了，它就是 $A$ 的列的线性组合，所以 $C$ 的每一列都是 $A$ 的列的组合，组合系数就是 $B$ 对应那一列里的数。他还留意了一个形状上的事实：$A$ 的列有 $m$ 个分量，$C$ 的列也有 $m$ 个分量，对得上。

**按行看呢？** 完全对称。$A$ 的第 $i$ 行乘整个 $B$，得到 $C$ 的第 $i$ 行，它是 $B$ 的各行的组合，系数是 $A$ 的第 $i$ 行里的数。他的说法是：$A$ 在左边乘，是在“混合”$B$ 的行。

这两句话可以记成：左乘动的是行，右乘动的是列。上一讲的消元矩阵 $E$ 从左边乘上去，“第二行减去 3 倍第一行”就是行操作，正是因为这个。

## 列乘行与分块

**第四种看法：列乘行。** 如果 $A$ 的一列（$m \times 1$）乘 $B$ 的一行（$1 \times p$），得到的是一个 $m \times p$ 的整块矩阵，和行乘列得到一个数完全不同。他的例子是列 $(2, 3, 4)$ 乘行 $(1, 6)$：

$$
\begin{bmatrix} 2 \\ 3 \\ 4 \end{bmatrix}
\begin{bmatrix} 1 & 6 \end{bmatrix}
= \begin{bmatrix} 2 & 12 \\ 3 & 18 \\ 4 & 24 \end{bmatrix}
$$

这个矩阵的每一列都是 $(2, 3, 4)$ 的倍数，每一行都是 $(1, 6)$ 的倍数。所有的行落在同一条直线上，所有的列也落在同一条直线上，他说这是“很极简的矩阵”。第四种看法是：$AB$ 等于 $A$ 的第 $k$ 列乘 $B$ 的第 $k$ 行，$k$ 从 1 加到 $n$。他的例子取 $A = \begin{bmatrix} 2 & 7 \\ 3 & 8 \\ 4 & 9 \end{bmatrix}$，$B = \begin{bmatrix} 1 & 6 \\ 0 & 0 \end{bmatrix}$，第二项因为 $B$ 的第二行是零，整个变成零矩阵，乘积就是第一项。我把这两个例子交给 NumPy：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 一列乘一行：Strang 的例子，列 (2, 3, 4)，行 (1, 6)
    u = np.array([2.0, 3.0, 4.0])
    v = np.array([1.0, 6.0])
    M = np.outer(u, v)
    print("列 (2, 3, 4) 乘行 (1, 6)：")
    print(M)
    print("秩：", np.linalg.matrix_rank(M))
    print("每一列是 u 的倍数，倍数就是 v：", np.allclose(M, u[:, None] * v))
    print("第 i 行除以 u[i] 都得到 v：", np.allclose(M / u[:, None], v))

    # 两列乘两行：第二项是零矩阵，和为第一项
    A = np.array([[2.0, 7.0], [3.0, 8.0], [4.0, 9.0]])
    B = np.array([[1.0, 6.0], [0.0, 0.0]])
    first = np.outer(A[:, 0], B[0, :])
    second = np.outer(A[:, 1], B[1, :])
    print("第一列乘第一行：")
    print(first)
    print("第二列乘第二行：")
    print(second)
    print("两项之和等于 A @ B：", np.allclose(first + second, A @ B))
    print("A @ B 的秩：", np.linalg.matrix_rank(A @ B))


if __name__ == "__main__":
    main()
```

```text
列 (2, 3, 4) 乘行 (1, 6)：
[[ 2. 12.]
 [ 3. 18.]
 [ 4. 24.]]
秩： 1
每一列是 u 的倍数，倍数就是 v： True
第 i 行除以 u[i] 都得到 v： True
第一列乘第一行：
[[ 2. 12.]
 [ 3. 18.]
 [ 4. 24.]]
第二列乘第二行：
[[0. 0.]
 [0. 0.]
 [0. 0.]]
两项之和等于 A @ B： True
A @ B 的秩： 1
```

两件事。$M$ 的秩是 1，每一列、每一行都是同一个向量的倍数，和他说的一样。而 $AB$ 的秩也是 1，虽然 $A$ 的两列并不平行：右边的 $B$ 把“第二列”的贡献清零了，乘积的列空间就退化成了一条线。“乘积的秩不超过因子的秩”这件事，后面讲秩的时候还会回来。

**分块乘法。** 最后一种看法是把矩阵切成块，块与块之间按“行乘列”的规则乘，只要切法能对上。他取两个 $20 \times 20$ 的方阵，各切成四个 $10 \times 10$ 的块，左上角的块是 $A_1B_1 + A_2B_3$。他的原话大意是：连 Gauss 也不可能一眼看出这是对的，但检查一遍，五种方法做的其实是同样的乘法，只是记账顺序不同。

标题写“四种”，是因为他自己数到“第四种”就收住了，分块算顺带的；我把它也算上，一共五种。这个“同样的乘法”可以数出来：$m \times n$ 乘 $n \times p$ 总共 $mnp$ 次标量乘法，按元素、按列、按行、按列乘行、分块，一次不多一次不少。区别只在于你把它们分成了什么形状的包。下面我把五种算法各写成一个函数，用一个固定种子的随机 $4 \times 6$ 乘 $6 \times 4$ 矩阵，和 `A @ B` 对比：

```python
import numpy as np


def by_entries(A: np.ndarray, B: np.ndarray) -> np.ndarray:
    """第一种：C[i, j] 是 A 的第 i 行点乘 B 的第 j 列。"""
    m, n = A.shape
    p = B.shape[1]
    C = np.zeros((m, p))
    for i in range(m):
        for j in range(p):
            for k in range(n):
                C[i, j] += A[i, k] * B[k, j]
    return C


def by_columns(A: np.ndarray, B: np.ndarray) -> np.ndarray:
    """第二种：A 乘 B 的每一列，得到 C 的对应列。"""
    return np.column_stack([A @ B[:, j] for j in range(B.shape[1])])


def by_rows(A: np.ndarray, B: np.ndarray) -> np.ndarray:
    """第三种：A 的每一行乘 B，得到 C 的对应行。"""
    return np.vstack([A[i, :] @ B for i in range(A.shape[0])])


def by_outer(A: np.ndarray, B: np.ndarray) -> np.ndarray:
    """第四种：A 的第 k 列乘 B 的第 k 行，再把 n 个矩阵加起来。"""
    return sum(np.outer(A[:, k], B[k, :]) for k in range(A.shape[1]))


def by_blocks(A: np.ndarray, B: np.ndarray) -> np.ndarray:
    """第五种：切成 2 x 2 个块，块和块按行乘列的规则相乘。"""
    A1, A2 = A[:2, :3], A[:2, 3:]
    A3, A4 = A[2:, :3], A[2:, 3:]
    B1, B2 = B[:3, :2], B[:3, 2:]
    B3, B4 = B[3:, :2], B[3:, 2:]
    return np.block(
        [
            [A1 @ B1 + A2 @ B3, A1 @ B2 + A2 @ B4],
            [A3 @ B1 + A4 @ B3, A3 @ B2 + A4 @ B4],
        ]
    )


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)
    m, n, p = 4, 6, 4
    A = rng.standard_normal((m, n))
    B = rng.standard_normal((n, p))
    C = A @ B

    methods = [
        ("元素", by_entries),
        ("列", by_columns),
        ("行", by_rows),
        ("列乘行之和", by_outer),
        ("分块", by_blocks),
    ]
    for name, method in methods:
        err = np.linalg.norm(method(A, B) - C)
        print(f"{name:6s} 与 A @ B 的差：{err:.2e}")

    # 每一种算法做的标量乘法一样多：m * n * p
    print("标量乘法次数 m * n * p =", m * n * p)
    print("按列算：C 的第 0 列是 A 的各列的组合，系数是 B 的第 0 列")
    combo = sum(B[k, 0] * A[:, k] for k in range(n))
    print("  吻合：", np.allclose(combo, C[:, 0]))
    print("按行算：C 的第 0 行是 B 的各行的组合，系数是 A 的第 0 行")
    combo = sum(A[0, k] * B[k, :] for k in range(n))
    print("  吻合：", np.allclose(combo, C[0, :]))


if __name__ == "__main__":
    main()
```

```text
元素     与 A @ B 的差：1.39e-15
列      与 A @ B 的差：1.37e-15
行      与 A @ B 的差：1.13e-15
列乘行之和  与 A @ B 的差：1.39e-15
分块     与 A @ B 的差：1.29e-15
标量乘法次数 m * n * p = 96
按列算：C 的第 0 列是 A 的各列的组合，系数是 B 的第 0 列
  吻合： True
按行算：C 的第 0 行是 B 的各行的组合，系数是 A 的第 0 行
  吻合： True
```

五个差都在 $10^{-15}$ 量级，就是双精度浮点的舍入噪声：加法顺序不一样，末位当然不会完全一样。所以我没有用 `==`，而是看差的范数（这几个数字谁小谁大没有意义，别盯着看）。标量乘法的次数是 $4 \times 6 \times 4 = 96$，五种算法都是这个数。最后两行把按列、按行两种看法直接写成“组合”的形式：$C$ 的第 0 列是 $A$ 的各列按 $B$ 第 0 列的系数加权，第 0 行是 $B$ 的各行按 $A$ 第 0 行的系数加权，都是 `True`。

我猜 Strang 在第 3 讲就把五种看法摆出来，是因为后面几乎每个定理都挑其中一种来证：证“$AB$ 的列空间包含在 $A$ 的列空间里”用列，证 $A = LU$ 是消元的记录用行，列乘行则要到 SVD 才大放异彩。

## 没有逆的矩阵

接下来是逆矩阵。方阵 $A$ 如果有逆，$A^{-1}A = I$，也有 $AA^{-1} = I$。他特意说了一句：对方阵，左逆一定也是右逆，这件事不容易证明，但是成立；对长方形矩阵，形状就不允许左逆等于右逆，后面（第 33 讲）会看到有左逆没有右逆的情形。

最重要的问题是：什么时候没有逆？他先给了一个反例，$A = \begin{bmatrix} 1 & 3 \\ 2 & 6 \end{bmatrix}$，并要大家给出理由。他一共给了三个，我按他的顺序写下来：

1. 行列式是 $1 \times 6 - 3 \times 2 = 0$。他说这是“如果你知道行列式的话”，言下之意是他现在还不想用它。
2. 如果 $AB = I$，$AB$ 的每一列都是 $A$ 的列的组合；而 $A$ 的两列 $(1, 2)$、$(3, 6)$ 在同一条直线上，$I$ 的第一列 $(1, 0)$ 不在这条线上，组合不出来。
3. 存在非零向量 $\mathbf{x} = (3, -1)$，使 $A\mathbf{x} = \mathbf{0}$，也就是 3 份列一减 1 份列二恰好是零。如果 $A^{-1}$ 存在，两边左乘它，$\mathbf{x} = A^{-1}A\mathbf{x} = A^{-1}\mathbf{0} = \mathbf{0}$，和 $\mathbf{x} \ne \mathbf{0}$ 矛盾。

他说第三个理由是自己最喜欢的：“数学里所有关键的方程，右边都是零。”$A\mathbf{x} = \mathbf{0}$ 的非零解，是奇异矩阵最直接的证据：$A$ 把 $\mathbf{x}$ 压成了零，没有任何 $A^{-1}$ 能把零再变回非零的 $\mathbf{x}$。三个理由我都让 NumPy 过了一遍：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[1.0, 3.0], [2.0, 6.0]])
    x = np.array([3.0, -1.0])

    print("行列式：", np.linalg.det(A))
    print("秩：", np.linalg.matrix_rank(A))
    print("A @ x =", A @ x, "，而 x 不是零向量")
    print("3 * 列一 - 1 * 列二 =", 3 * A[:, 0] - A[:, 1])

    # 列图：单位矩阵的第一列 (1, 0) 能不能由 A 的列组合出来
    e1 = np.array([1.0, 0.0])
    coef, *_ = np.linalg.lstsq(A, e1, rcond=None)
    print("最接近 (1, 0) 的列组合：", A @ coef)
    print(f"差了：{np.linalg.norm(A @ coef - e1):.4f}")

    try:
        np.linalg.inv(A)
    except np.linalg.LinAlgError as err:
        print("np.linalg.inv 报错：", err)

    # 如果 A 有逆，x 会被 A 的逆拉回零：A 的逆 @ (A @ x) = x
    # 但 A @ x 是零向量，零向量乘任何矩阵还是零向量，x 回不来
    print("零向量乘以任何矩阵：", np.zeros((2, 2)) @ (A @ x))


if __name__ == "__main__":
    main()
```

```text
行列式： 0.0
秩： 1
A @ x = [0. 0.] ，而 x 不是零向量
3 * 列一 - 1 * 列二 = [0. 0.]
最接近 (1, 0) 的列组合： [0.2 0.4]
差了：0.8944
np.linalg.inv 报错： Singular matrix
零向量乘以任何矩阵： [0. 0.]
```

行列式 0.0，秩 1。$A\mathbf{x}$ 确实是零向量而 $\mathbf{x}$ 不是。最小二乘能找到的离 $(1, 0)$ 最近的列组合是 $(0.2, 0.4)$（也就是 $(1, 0)$ 在那条线上的投影），差了 0.8944，是 $2/\sqrt{5}$。`np.linalg.inv` 没有试图给出什么答案，直接报 `Singular matrix`。这里“差了 0.8944”和第 1 讲里的 0.4082 是同一类东西：右端项到列空间的距离。

## Gauss-Jordan：两个方程组一起解

换一个能求逆的矩阵。他把刚才的 6 换成了 7（他说 7 是幸运数字）：

$$
A = \begin{bmatrix} 1 & 3 \\ 2 & 7 \end{bmatrix}
$$

要找的 $A^{-1}$ 有四个未知数。他的做法是按列看：$A$ 乘 $A^{-1}$ 的第一列，得到 $I$ 的第一列 $(1, 0)$；$A$ 乘 $A^{-1}$ 的第二列，得到 $I$ 的第二列 $(0, 1)$。所以求逆就是解两个方程组，系数矩阵都是 $A$，只是右端项不同。$n \times n$ 矩阵就是 $n$ 个方程组。

Gauss 解一个方程组时，会把右端项作为增广列贴在矩阵旁边。Jordan 的想法是：既然右端项不止一个，把它们一起贴上去，得到 $[A\ I]$，只做一遍消元。他的步骤是：

1. 第二行减去 2 倍第一行，得到 $\begin{bmatrix} 1 & 3 & 1 & 0 \\ 0 & 1 & -2 & 1 \end{bmatrix}$。左半边已经是上三角了，他说 Gauss 到此就收工了。
2. “Jordan 说继续。”第一行减去 3 倍第二行，消掉上面的 3，得到 $\begin{bmatrix} 1 & 0 & 7 & -3 \\ 0 & 1 & -2 & 1 \end{bmatrix}$。

左半边变成了 $I$，所以右半边是 $A^{-1} = \begin{bmatrix} 7 & -3 \\ -2 & 1 \end{bmatrix}$。他当场验算了 $7 - 6 = 1$、$21 - 21 = 0$、$-2 + 2 = 0$、$-6 + 7 = 1$。

我在 NumPy 里做了三件事：逐列解两个方程组、用上一讲的方式把两步写成 $E_{21}$ 和 $E_{12}$ 并乘上去、和 `np.linalg.inv` 对比。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[1.0, 3.0], [2.0, 7.0]])
    identity = np.eye(2)

    # 求逆就是解两个方程组：A @ (逆的第 j 列) = 单位矩阵的第 j 列
    columns = [np.linalg.solve(A, identity[:, j]) for j in range(2)]
    stacked = np.column_stack(columns)
    print("逐列解出的 A 的逆：")
    print(stacked)

    # Gauss-Jordan：两个方程组并排放进 [A | I]，一起消元
    aug = np.hstack([A, identity])
    print("[A | I] =")
    print(aug)

    E21 = np.array([[1.0, 0.0], [-2.0, 1.0]])  # 第二行减去 2 倍第一行
    aug = E21 @ aug
    print("向下消元后（上三角，Gauss 到此为止）：")
    print(aug)

    E12 = np.array([[1.0, -3.0], [0.0, 1.0]])  # 第一行减去 3 倍第二行
    aug = E12 @ aug
    print("再向上消元后（Jordan 继续）：")
    print(aug)

    inverse = aug[:, 2:]
    E = E12 @ E21
    print("右半边就是 E = E12 @ E21：", np.allclose(inverse, E))
    print("E @ A 等于单位矩阵：", np.allclose(E @ A, identity))
    print("和 np.linalg.inv 一致：", np.allclose(inverse, np.linalg.inv(A)))
    print("和逐列解出的一致：", np.allclose(inverse, stacked))
    print("A @ 逆 的误差：", np.linalg.norm(A @ inverse - identity))


if __name__ == "__main__":
    main()
```

```text
逐列解出的 A 的逆：
[[ 7. -3.]
 [-2.  1.]]
[A | I] =
[[1. 3. 1. 0.]
 [2. 7. 0. 1.]]
向下消元后（上三角，Gauss 到此为止）：
[[ 1.  3.  1.  0.]
 [ 0.  1. -2.  1.]]
再向上消元后（Jordan 继续）：
[[ 1.  0.  7. -3.]
 [ 0.  1. -2.  1.]]
右半边就是 E = E12 @ E21： True
E @ A 等于单位矩阵： True
和 np.linalg.inv 一致： True
和逐列解出的一致： True
A @ 逆 的误差： 0.0
```

四个对比全是 `True`，$A$ 乘逆与 $I$ 的误差恰好是 0.0（这几个整数运算没有舍入误差）。有意思的是前两种得到的东西一模一样：逐列解方程组得到的逆，和 $[A\ I]$ 消元得到的逆是同一个矩阵，因为它们根本是同一件事的两种写法。

## 为什么右边会变成逆

**为什么右半边恰好是 $A^{-1}$？** 他在最后几分钟回答了这个问题，我觉得这是这一讲最漂亮的地方。每一步消元都是左乘一个初等矩阵。把所有步骤的乘积记成 $E$，对 $[A\ I]$ 做完消元就是

$$
E\,[A\ I] = [EA\ \ EI] = [I\ \ E]
$$

左半边 $EA = I$，所以 $E$ 就是 $A^{-1}$（他问学生，学生答对了）。右半边本来是 $I$，被同一串操作作用之后变成 $EI = E = A^{-1}$。我们前面的代码里，$E = E_{12}E_{21}$ 与右半边相等，这就是这句话的具体数值。

我喜欢把 $[A\ I]$ 想成一本分左右两栏的账：左栏每改一笔，右栏同步记一笔。等左栏平成 $I$，右栏记下的整本流水，就是 $A^{-1}$。

前面写的是 $2 \times 2$ 手算。它没有换行，主元也都是 1。我把这个想法写成能处理 $n \times n$ 的函数，加上选主元换行，并在同一个脚本里，用 NumPy 做三件事：和 `np.linalg.inv` 对照；喂给它奇异矩阵，看它在哪里停下；把 6 改成 $6 + \varepsilon$，看逆里的数怎么长。（$2 \times 2$ 的手算比写这个函数快得多，但手算不会告诉你 $\varepsilon$ 缩小时会发生什么。）

```python
import numpy as np


def gauss_jordan_inverse(A: np.ndarray) -> np.ndarray:
    """对 [A | I] 做 Gauss-Jordan 消元，左半边变成 I 时右半边就是逆。"""
    n = A.shape[0]
    aug = np.hstack([A.astype(float), np.eye(n)])
    for col in range(n):
        # 选列里绝对值最大的元素做主元，必要时换行
        pivot_row = col + np.argmax(np.abs(aug[col:, col]))
        if np.isclose(aug[pivot_row, col], 0.0, atol=1e-12):
            raise ValueError("矩阵奇异，找不到 n 个主元")
        aug[[col, pivot_row]] = aug[[pivot_row, col]]
        aug[col] /= aug[col, col]
        # Gauss 向下消，Jordan 向上消：把这一列的其他元素都消成 0
        for row in range(n):
            if row != col:
                aug[row] -= aug[row, col] * aug[col]
    return aug[:, n:]


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    A = rng.standard_normal((5, 5))
    inverse = gauss_jordan_inverse(A)
    reference = np.linalg.inv(A)
    print(
        "和 np.linalg.inv 的差：", f"{np.abs(inverse - reference).max():.1e}"
    )
    print(
        "A @ 逆 与单位矩阵的差：",
        f"{np.linalg.norm(A @ inverse - np.eye(5)):.1e}",
    )

    # 奇异矩阵：消不出 n 个主元
    S = np.array([[1.0, 3.0], [2.0, 6.0]])
    try:
        gauss_jordan_inverse(S)
    except ValueError as err:
        print("奇异矩阵：", err)

    # 把 6 换成 6 + eps：eps 越小，越接近奇异，逆里的数越大
    print("      eps    逆里最大的元素    条件数")
    for eps in [1e-2, 1e-4, 1e-6, 1e-8]:
        T = np.array([[1.0, 3.0], [2.0, 6.0 + eps]])
        big = np.abs(gauss_jordan_inverse(T)).max()
        print(f"{eps:9.0e} {big:16.3e} {np.linalg.cond(T):12.3e}")


if __name__ == "__main__":
    main()
```

```text
和 np.linalg.inv 的差： 4.3e-14
A @ 逆 与单位矩阵的差： 8.2e-15
奇异矩阵： 矩阵奇异，找不到 n 个主元
      eps    逆里最大的元素    条件数
    1e-02        6.010e+02    5.012e+03
    1e-04        6.000e+04    5.000e+05
    1e-06        6.000e+06    5.000e+07
    1e-08        6.000e+08    5.000e+09
```

随机 $5 \times 5$ 矩阵上，手写的 Gauss-Jordan 与 `np.linalg.inv` 的元素最大差是 $4.3 \times 10^{-14}$，$A$ 乘逆与 $I$ 的差是 $8.2 \times 10^{-15}$，这是舍入噪声的量级。奇异矩阵上，函数在第二列找不到非零主元，就停下了，这对应了“消元得不到 $n$ 个主元就没有逆”。

最后一张表是我最想让你看的。$\varepsilon$ 从 $10^{-2}$ 缩到 $10^{-8}$，逆里最大的元素从 601 涨到 $6 \times 10^{8}$，涨了一百万倍，刚好是 $\varepsilon$ 缩小的倍数，也就是逆里最大的元素约为 $6/\varepsilon$。条件数同步涨到 $5 \times 10^{9}$。所以奇异与否不是一个开关：矩阵离奇异越近，逆里的数越大，用它解方程时右端项里的一点点误差就被放大得越多。这件事我猜到第 17 讲比较 Gram-Schmidt 的稳定性时会再碰到。

据我所知，实际工程里几乎没有人真的先算 $A^{-1}$ 再乘 $\mathbf{b}$，求解 $A\mathbf{x} = \mathbf{b}$ 用的是消元（`np.linalg.solve`）。不过 $A^{-1}$ 这个概念本身是不可替代的，理论里到处都是它。

下一讲 Strang 要问一个很自然的问题：既然消元是一串 $E$ 的乘积，那 $A$ 本身能不能写成这些 $E$ 的逆的乘积？这就是 $A = LU$，下一讲见 [18.06 第 4 讲：分解成 A = LU](/posts/linear-algebra-04-lu-factorization/)。
