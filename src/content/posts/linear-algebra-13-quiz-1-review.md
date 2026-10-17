---
title: "18.06 第 13 讲：第一次测验复习"
commentId: "post:linear-algebra-13-quiz-1-review"
published: "2026-10-18 12:00:00 +08:00"
description: "MIT 18.06 第 13 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 把 Strang 在课上带着做的旧测验题逐题跑了一遍，其中 10 × 6 的矩阵 C 秩为 6，所以 C 转置的零空间维数是 10 - 6 = 4。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 复习
  - 四个子空间
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 13
draft: false
comment: true
slug: linear-algebra-13-quiz-1-review
---

这一讲没有新定理：Strang 翻出几份旧测验，一道一道读题，现场做。我把他做的每道题都交给 NumPy 重算了一遍，发现这些题几乎都靠同一个动作解决：先数形状和秩，再用 $r$、$n - r$、$m - r$ 把四个子空间的维数写出来。比如那个 10 × 6 的矩阵 $C$，秩是 6，$C^\mathsf{T}$ 的零空间维数就是 $10 - 6 = 4$，全程不需要消元。

> [!NOTE] 本讲速览
> 视频：[Lecture 13: Quiz 1 review](https://www.youtube.com/watch?v=l88D4r74gtM)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-13-quiz-1-review/)）
> 教材：《Introduction to Linear Algebra》第 6 版 第 1 到 3 章
> 前置：[第 12 讲：图、网络与关联矩阵](/posts/linear-algebra-12-graphs-and-incidence-matrices/)
> 一句话：测验题的套路是“先看形状和秩，再用四个子空间的维数公式回答”，能不做乘法就不做乘法。

> [!TIP] 配合视频
> - 这一讲是纯做题，本篇按他的出题顺序重算，每一题都有代码。想自己先想一遍，就先暂停视频，想完再对答案。
> - 他做 $B = CD$ 那道题时，“左乘可逆矩阵不改变零空间”这句话值得认真听，后面很多地方会用到。
> - 最后几道判断题（交换两行、$(1, 2, 3)$ 为什么不能同时是一行和零空间里的向量）很短，但它们直接通向下一讲，别倍速。
> - 字幕是自动转写的，题目里的矩阵在黑板上，转写里经常缺数字。下面凡是我根据字幕上下文还原的矩阵，我都会说明。

## 三个向量张成几维

第一题：$\mathbf{u}$、$\mathbf{v}$、$\mathbf{w}$ 是 $\mathbb{R}^7$ 里的非零向量，它们张成的子空间可能是几维？

答案是 1、2 或 3。不会是 0，因为向量非零（全是零向量才会得到零维子空间）；不会超过 3，因为只有三个向量。三种维数各举一个例子：三个都是 $\mathbf{u}$ 的倍数得 1 维，$\mathbf{w} = \mathbf{u} + \mathbf{v}$ 得 2 维，三个随机向量得 3 维。这个检验放在下一节的代码块开头。

## 5 × 3 的阶梯形与它的两个拼接

**第二题是整场复习的主菜。** $U$ 是 5 × 3 的阶梯形矩阵，有三个主元（$r = 3$）。他连着问了几个小问题：

1. $U$ 的零空间是什么？三列无关，所以只有零向量。
2. $B = \begin{bmatrix} U \\ 2U \end{bmatrix}$ 是 10 × 3，它的阶梯形是什么，秩是多少？
3. $C = \begin{bmatrix} U & U \\ U & 0 \end{bmatrix}$ 是 10 × 6，秩是多少？
4. $C^\mathsf{T}$ 的零空间维数是多少？

对 $B$，他的想法是把消元看成块操作：第一块乘 $-2$ 加到第二块，得到 $\begin{bmatrix} U \\ 0 \end{bmatrix}$，所以秩还是 3。对 $C$，第一行块减去第二行块得到 $\begin{bmatrix} 0 & U \end{bmatrix}$，整理成 $\begin{bmatrix} U & 0 \\ 0 & U \end{bmatrix}$ 的样子，每一块有 3 个主元，一共 6 个，秩是 6。最后一问：$C^\mathsf{T}$ 是 6 × 10，零空间在 $\mathbb{R}^{10}$ 里，维数是 $m - r = 10 - 6 = 4$。

字幕里没有 $U$ 的具体数字，我自己选了一个上三角的例子，下面的脚本同时验证了第一题的三种维数，以及这一题的每一问：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # R^7 里三个非零向量张成的子空间，维数只能是 1、2、3
    u = rng.standard_normal(7)
    v = rng.standard_normal(7)
    cases = {
        "三个都是 u 的倍数": np.column_stack([u, 2 * u, -3 * u]),
        "w = u + v": np.column_stack([u, v, u + v]),
        "三个随机向量": rng.standard_normal((7, 3)),
    }
    for name, M in cases.items():
        print(f"{name}：维数 = {np.linalg.matrix_rank(M)}")

    # 5 x 3 的阶梯形 U，三个主元
    U = np.array(
        [
            [1.0, 2.0, 3.0],
            [0.0, 4.0, 5.0],
            [0.0, 0.0, 6.0],
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 0.0],
        ]
    )
    print("U 的秩：", np.linalg.matrix_rank(U))
    # 零空间只有零向量：U @ x = 0 的最小二乘解就是 0，且 U 的最小奇异值 > 0
    print("U 的奇异值：", np.linalg.svd(U, compute_uv=False))

    # B = [U; 2U]：把第一块乘 -2 加到第二块，消元一步就得到 [U; 0]
    B = np.vstack([U, 2 * U])
    E = np.block([[np.eye(5), np.zeros((5, 5))], [-2 * np.eye(5), np.eye(5)]])
    print("B 的秩：", np.linalg.matrix_rank(B))
    print("E @ B 等于 [U; 0]：", np.allclose(E @ B, np.vstack([U, 0 * U])))

    # C = [[U, U], [U, 0]]，10 x 6
    C = np.block([[U, U], [U, np.zeros((5, 3))]])
    r = np.linalg.matrix_rank(C)
    print("C 的形状：", C.shape, "，秩：", r)
    print("N(C^T) 的维数 = m - r =", C.shape[0] - r)

    # 用奇异值分解直接取出 N(C^T) 的一组基并验证
    left, s, _ = np.linalg.svd(C)
    Y = left[:, r:]
    print(
        "N(C^T) 基的列数：",
        Y.shape[1],
        "，C^T @ Y = 0：",
        np.allclose(C.T @ Y, 0),
    )


if __name__ == "__main__":
    main()
```

```text
三个都是 u 的倍数：维数 = 1
w = u + v：维数 = 2
三个随机向量：维数 = 3
U 的秩： 3
U 的奇异值： [9.0125 2.9975 0.8884]
B 的秩： 3
E @ B 等于 [U; 0]： True
C 的形状： (10, 6) ，秩： 6
N(C^T) 的维数 = m - r = 4
N(C^T) 基的列数： 4 ，C^T @ Y = 0： True
```

$B$ 的秩没有因为多了一块 $2U$ 而增加：$E \mathbin{@} B = \begin{bmatrix} U \\ 0 \end{bmatrix}$，多出来的五行全被消成了零。$C$ 的秩却从 3 涨到 6：消元之后左右两块各自带来三个新的主元，没有谁重复谁。最后用 SVD 取出 $N(C^\mathsf{T})$ 的四个基向量，$C^\mathsf{T} Y$ 确实是零。（换成任何有三个主元的 $U$，这些答案都不变，它们只依赖形状和秩。）

## 只给完全解，倒推矩阵

**这类题的出法有点反着来：** 不给矩阵，只给 $A\mathbf{x} = (2, 4, 2)$ 的完全解，让你回答行空间的维数、矩阵本身、有解的条件。据我对字幕上下文的还原，完全解是

$$
\mathbf{x} =
\begin{bmatrix} 2 \\ 0 \\ 0 \end{bmatrix} +
c_1 \begin{bmatrix} 1 \\ 1 \\ 0 \end{bmatrix} +
c_2 \begin{bmatrix} 0 \\ 0 \\ 1 \end{bmatrix}
$$

字幕里这几个向量的数字没有完整转写出来，我是靠他后面的推理反推的：他说第一列是 $(1, 2, 1)$，第二列是 $(-1, -2, -1)$，最后一列全零。这三句话和上面的向量是自洽的。

推理很直接。完全解里有两个无关的零空间向量，所以零空间是 2 维，$n = 3$，秩 $r = 3 - 2 = 1$。矩阵怎么找：$A \mathbf{x}_p = \mathbf{b}$ 而 $\mathbf{x}_p$ 只有第一个分量非零，所以第一列是 $\mathbf{b} / 2 = (1, 2, 1)$；$(0, 0, 1)$ 在零空间里，说明第三列是零；$(1, 1, 0)$ 在零空间里，说明第二列是第一列的相反数。结果

$$
A = \begin{bmatrix} 1 & -1 & 0 \\ 2 & -2 & 0 \\ 1 & -1 & 0 \end{bmatrix}
$$

列空间就是 $(1, 2, 1)$ 的所有倍数，所以 $A\mathbf{x} = \mathbf{b}$ 有解，当且仅当 $\mathbf{b}$ 是 $(1, 2, 1)$ 的倍数（他回答“能不能对每个 $\mathbf{b}$ 都有解”时说的是“不能”）。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # 题目只给了完全解 x = x_p + c1 * n1 + c2 * n2，右端项是 b，没给矩阵
    b = np.array([2.0, 4.0, 2.0])
    x_p = np.array([2.0, 0.0, 0.0])
    n1 = np.array([1.0, 1.0, 0.0])
    n2 = np.array([0.0, 0.0, 1.0])

    # A @ x_p = b：x_p 只取第一列，所以第一列 = b / 2
    col1 = b / x_p[0]
    # A @ n2 = 0：最后一列是零；A @ n1 = 0：第二列 = -第一列
    A = np.column_stack([col1, -col1, np.zeros(3)])
    print("A =")
    print(A)

    print("A @ x_p = b：", np.allclose(A @ x_p, b))
    print("A @ n1 = 0：", np.allclose(A @ n1, 0))
    print("A @ n2 = 0：", np.allclose(A @ n2, 0))

    r = np.linalg.matrix_rank(A)
    print("行空间维数 = 秩 =", r, "，零空间维数 =", 3 - r)

    # 任意 c1、c2 都给出解
    c1, c2 = rng.standard_normal(2)
    x = x_p + c1 * n1 + c2 * n2
    print("随机取 c1、c2，A @ x = b：", np.allclose(A @ x, b))

    # 什么样的 b 有解：b 必须在列空间里，也就是 (1, 2, 1) 的倍数
    for rhs in (np.array([3.0, 6.0, 3.0]), np.array([1.0, 0.0, 0.0])):
        solvable = np.linalg.matrix_rank(np.column_stack([A, rhs])) == r
        print(f"b = {rhs}，有解：", solvable)


if __name__ == "__main__":
    main()
```

```text
A =
[[ 1. -1.  0.]
 [ 2. -2.  0.]
 [ 1. -1.  0.]]
A @ x_p = b： True
A @ n1 = 0： True
A @ n2 = 0： True
行空间维数 = 秩 = 1 ，零空间维数 = 2
随机取 c1、c2，A @ x = b： True
b = [3. 6. 3.]，有解： True
b = [1. 0. 0.]，有解： False
```

行空间维数是 1，零空间维数是 2，加起来是 $n = 3$。$\mathbf{b} = (3, 6, 3)$ 有解，$(1, 0, 0)$ 没有。他在这里提醒了一句：别忘了秩等于 $m$ 或等于 $n$ 的那些好情形，上一章讲过，这道题只是“秩很小、零空间很大”的那一头。

## 四道判断题

**判断题没有一道需要计算，但每一道都值得举反例。** 他说真正的测验里不会有判断题，这几道只是拿来快速复习。

- 若方阵的零空间只有零向量，则 $A^\mathsf{T}$ 的零空间也只有零向量。对：已知 $n - r = 0$，而 $m = n$，所以 $m - r = 0$。他强调这是个非常重要的事实。
- 5 × 5 矩阵构成一个 25 维的向量空间，其中可逆的矩阵构成子空间吗？不：零矩阵不在里面，而且两个可逆矩阵的和可能奇异（$I$ 加 $-I$ 就是零矩阵）。奇异矩阵也不行，因为两个奇异矩阵的和可能可逆。
- 若 $B^2 = 0$，则 $B = 0$？错，经典反例是 $\begin{bmatrix} 0 & 1 \\ 0 & 0 \end{bmatrix}$。他管它叫“危险的矩阵”，说后面会反复出现，我猜是讲到特征值和 Jordan 形的时候。
- $m \times m$ 的矩阵，列线性无关，则每个右端项都有解？对：秩是 $m$，矩阵可逆，什么都不会出错。他在这里拿观众投票开玩笑，结果五五开（第十三讲了，台下还有一半人举手说不一定，我替他们捏一把汗）。

```python
import numpy as np


def nullity(M: np.ndarray) -> int:
    return M.shape[1] - np.linalg.matrix_rank(M)


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # 1. 方阵 A 的零空间只有零向量，A^T 的零空间也只有零向量
    A = rng.standard_normal((5, 5))
    print("dim N(A) =", nullity(A), "，dim N(A^T) =", nullity(A.T))

    # 2. 5 x 5 的可逆矩阵不构成子空间：没有零矩阵，和也可能奇异
    P = np.eye(5)
    Q = -np.eye(5)
    print("det(P) =", np.linalg.det(P), "，det(Q) =", np.linalg.det(Q))
    print("P + Q 的秩：", np.linalg.matrix_rank(P + Q), "（零矩阵，不可逆）")

    # 3. B^2 = 0 推不出 B = 0
    B = np.array([[0.0, 1.0], [0.0, 0.0]])
    print("B @ B =")
    print(B @ B)

    # 4. m x m 且列无关，则对每个右端项 Ax = b 有解
    M = rng.standard_normal((6, 6))
    worst = 0.0
    for _ in range(1000):
        b = rng.standard_normal(6)
        x = np.linalg.solve(M, b)
        worst = max(worst, np.linalg.norm(M @ x - b))
    rk = np.linalg.matrix_rank(M)
    print("秩 =", rk, "，1000 个随机 b 的最大残差 =", f"{worst:.1e}")


if __name__ == "__main__":
    main()
```

```text
dim N(A) = 0 ，dim N(A^T) = 0
det(P) = 1.0 ，det(Q) = -1.0
P + Q 的秩： 0 （零矩阵，不可逆）
B @ B =
[[0. 0.]
 [0. 0.]]
秩 = 6 ，1000 个随机 b 的最大残差 = 1.3e-14
```

第一题对一个随机 5 × 5 矩阵，两个零空间的维数都是 0。第二题的 $I + (-I)$ 秩是 0。第四题我对 1000 个随机右端项求解，最大残差 1.3e-14，是舍入误差的量级，而不是“有时有解”。

## 分解乘积 B = CD：左乘可逆矩阵不改变零空间

下一题给的是一个以乘积形式出现的矩阵，$B = CD$：$C$ 是 3 × 3 的，$D$ 是 3 × 4 的阶梯形。我根据字幕还原出的两个因子是

$$
C = \begin{bmatrix} 1 & 1 & 0 \\ 0 & 1 & 0 \\ 1 & 0 & 1 \end{bmatrix},\quad
D = \begin{bmatrix} 1 & 0 & -1 & 2 \\ 0 & 1 & 1 & -1 \\ 0 & 0 & 0 & 0 \end{bmatrix}
$$

字幕里数字是连着念出来的，我是按行断开的。我用来核对的是：他说 $B$ 的第一列是 $(1, 0, 1)$，我还原出的 $C$ 和 $D$ 相乘确实给出这一列；他读出的特解里的 $-1$、$1$、$-2$ 也都对得上。

**这一题的关键是：** $C$ 可逆，所以 $CD$ 和 $D$ 有相同的零空间。若 $D\mathbf{x} = 0$ 则 $CD\mathbf{x} = 0$；反过来 $CD\mathbf{x} = 0$ 时左乘 $C^{-1}$ 就得到 $D\mathbf{x} = 0$。因此 $B$ 的零空间不用乘出来看，直接读 $D$：主元在前两列，自由变量是第 3、4 个，特解是 $\begin{bmatrix} -F \\ I \end{bmatrix}$ 的两列，其中 $F$ 是 $D$ 右上角的 2 × 2 块。

他接着解 $B\mathbf{x} = (1, 0, 1)$。$B$ 的第一列恰好就是右端项，所以特解取 $(1, 0, 0, 0)$，完全解是特解加上两个特解的任意组合。有学生问“特解是不是唯一的”，他的回答是不唯一，挑最方便的那个。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # B = C @ D：C 是 3 x 3，D 是 3 x 4 的阶梯形
    C = np.array([[1.0, 1.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 1.0]])
    D = np.array(
        [
            [1.0, 0.0, -1.0, 2.0],
            [0.0, 1.0, 1.0, -1.0],
            [0.0, 0.0, 0.0, 0.0],
        ]
    )
    B = C @ D
    print("B =")
    print(B)
    print(
        "det(C) =",
        round(np.linalg.det(C), 6),
        "，秩(B) =",
        np.linalg.matrix_rank(B),
    )

    # 零空间：D 的自由变量是第 3、4 个，特解 = [-F; I]
    F = D[:2, 2:]
    N = np.vstack([-F, np.eye(2)])
    print("特解矩阵 N（每列一个特解）：")
    print(N)
    print("D @ N = 0：", np.allclose(D @ N, 0))
    print("B @ N = 0：", np.allclose(B @ N, 0))

    # 解 B x = (1, 0, 1)：B 的第一列恰好是它
    b = np.array([1.0, 0.0, 1.0])
    x_p = np.array([1.0, 0.0, 0.0, 0.0])
    print("B 的第一列 =", B[:, 0], "，B @ x_p = b：", np.allclose(B @ x_p, b))
    rng = np.random.default_rng(1806)
    c = rng.standard_normal(2)
    x = x_p + N @ c
    print("x_p + N @ c 仍是解：", np.allclose(B @ x, b))


if __name__ == "__main__":
    main()
```

```text
B =
[[ 1.  1.  0.  1.]
 [ 0.  1.  1. -1.]
 [ 1.  0. -1.  2.]]
det(C) = 1.0 ，秩(B) = 2
特解矩阵 N（每列一个特解）：
[[ 1. -2.]
 [-1.  1.]
 [ 1.  0.]
 [ 0.  1.]]
D @ N = 0： True
B @ N = 0： True
B 的第一列 = [1. 0. 1.] ，B @ x_p = b： True
x_p + N @ c 仍是解： True
```

$B$ 的秩是 2，4 列减 2 个主元，零空间是 2 维，和 $N$ 的两列一致。`B @ N` 和 `D @ N` 都是零，验证了“左乘可逆的 $C$ 不改变零空间”。他还说，“特解加零空间”这个模式不只限于有限矩阵，它在整个线性系统的数学里都在用。

## 四个子空间的几道判断题

最后一批题，都是在问“哪个子空间变了，哪个没变”。

- 方阵的行空间等于列空间吗？不一定。$\begin{bmatrix} 0 & 1 \\ 0 & 0 \end{bmatrix}$ 的行空间是 $(0, 1)$ 的倍数，列空间是 $(1, 0)$ 的倍数，完全不同。对称矩阵能保证两者相等。
- $A$ 和 $-A$ 有相同的四个子空间吗？有。
- 两个矩阵有相同的四个子空间，一个就是另一个的倍数吗？错。反例：任意两个可逆的 6 × 6 矩阵，四个子空间都是 $\mathbb{R}^6$ 或 $\{0\}$。他顺便说，它们至少有相同的秩，但真正能说的更多，他没有展开。
- 交换 $A$ 的两行，哪些子空间不变？行空间和零空间不变，列空间会变。

```python
import numpy as np


def rank(M: np.ndarray) -> int:
    return int(np.linalg.matrix_rank(M))


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # 1. 方阵的行空间不一定等于列空间
    N = np.array([[0.0, 1.0], [0.0, 0.0]])
    row_vec = np.array([[0.0, 1.0]])
    col_vec = np.array([[1.0], [0.0]])
    print("(0, 1) 在行空间里：", rank(np.vstack([N, row_vec])) == rank(N))
    print("(1, 0) 在行空间里：", rank(np.vstack([N, col_vec.T])) == rank(N))
    print("(1, 0) 在列空间里：", rank(np.hstack([N, col_vec])) == rank(N))

    # 2. A 和 -A 的四个子空间相同
    A = rng.standard_normal((4, 3)) @ rng.standard_normal((3, 5))
    print("A 的秩：", rank(A), "，A 是 4 x 5")
    print("列空间相同：", rank(np.hstack([A, -A])) == rank(A))
    print("行空间相同：", rank(np.vstack([A, -A])) == rank(A))

    # 3. 四个子空间相同，不代表差一个倍数：两个可逆的 6 x 6
    X = rng.standard_normal((6, 6))
    Y = rng.standard_normal((6, 6))
    print("秩：", rank(X), rank(Y), "，X / Y 的比值：")
    print((X / Y)[0, :3])

    # 4. 交换两行：行空间、零空间不变，列空间变
    S = np.array([[1.0, 0.0, 1.0], [0.0, 0.0, 0.0], [0.0, 1.0, 1.0]])
    T = S[[1, 0, 2]]
    n = np.array([1.0, 1.0, -1.0])
    print(
        "S @ n = 0，T @ n = 0：", np.allclose(S @ n, 0), np.allclose(T @ n, 0)
    )
    print("行空间不变：", rank(np.vstack([S, T])) == rank(S))
    print("列空间不变：", rank(np.hstack([S, T])) == rank(S))

    # 5. (1, 2, 3) 不能既是某一行，又在零空间里
    v = np.array([1.0, 2.0, 3.0])
    M = np.vstack([v, rng.standard_normal((2, 3))])
    print("M 的第一行乘 v =", (M @ v)[0], "，v 点乘 v =", v @ v)


if __name__ == "__main__":
    main()
```

```text
(0, 1) 在行空间里： True
(1, 0) 在行空间里： False
(1, 0) 在列空间里： True
A 的秩： 3 ，A 是 4 x 5
列空间相同： True
行空间相同： True
秩： 6 6 ，X / Y 的比值：
[-1.5896  2.3334 -0.5318]
S @ n = 0，T @ n = 0： True True
行空间不变： True
列空间不变： False
M 的第一行乘 v = 14.0 ，v 点乘 v = 14.0
```

四个小题各对一类：$\begin{bmatrix} 0 & 1 \\ 0 & 0 \end{bmatrix}$ 的 $(0, 1)$ 在行空间里，$(1, 0)$ 不在；$(1, 0)$ 在列空间里。两个随机的可逆矩阵逐元素相除，比值是 $-1.5896$、$2.3334$、$-0.5318$，不是常数，所以谁也不是谁的倍数。交换两行后，$\mathbf{n} = (1, 1, -1)$ 仍然在零空间里，行空间不变，列空间变了。

## 最后一题：为什么 (1, 2, 3) 不能同时是一行和零空间里的向量

他用这道题收尾，说它引向下一章。如果 $A$ 的第一行是 $(1, 2, 3)$，$\mathbf{v} = (1, 2, 3)$ 又在零空间里，那 $A\mathbf{v}$ 的第一个分量就是

$$
1 \cdot 1 + 2 \cdot 2 + 3 \cdot 3 = 14
$$

不是零，矛盾。代码块最后一行用随机矩阵确认了这个 14：不管另外两行是什么，第一个分量都是 $\mathbf{v} \cdot \mathbf{v} = 14$。

这说明行空间和零空间同在 $\mathbb{R}^n$ 里，却只共享零向量。更准确的说法是：零空间垂直于行空间。他说这是下一讲的内容，并祝大家考试顺利。

我读完这份复习有一个感受：每一道题我都是先看形状，再数秩，最后才碰数字。这像编程里先看函数签名再读函数体，能省下大把时间。（反过来说，我花在“还原字幕里被吞掉的数字”上的时间，大概是真正做题的三倍。）

下一讲是考试之后的第一讲，主题正是上面最后一题留下的：正交。见 [18.06 第 14 讲：正交向量与正交子空间](/posts/linear-algebra-14-orthogonal-subspaces/)。
