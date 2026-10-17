---
title: "18.06 第 33 讲：左逆、右逆与伪逆"
commentId: "post:linear-algebra-33-pseudoinverse"
published: "2026-10-18 19:00:00 +08:00"
description: "MIT 18.06 第 33 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 手写了左逆、右逆和基于 SVD 的伪逆，在一个秩 2 的 4 × 3 矩阵上加了 1e-12 的噪声后，朴素的 (AᵀA)⁻¹Aᵀ 与 A⁺ 差了 9.23e+02，截断小奇异值的伪逆只差 7.10e-13。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 伪逆
  - 最小范数解
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 34
draft: false
comment: true
slug: linear-algebra-33-pseudoinverse
---

矩阵一般没有逆，但几乎每个矩阵都有“最接近逆”的东西：满列秩的有左逆，满行秩的有右逆，什么秩都没有的还有伪逆。Strang 这一讲把它们放进同一幅四个子空间的图里讲清楚。我在一个秩 2 的 4 × 3 矩阵上试了一下，给它加 1e-12 的噪声，朴素的 $(A^\mathsf{T}A)^{-1}A^\mathsf{T}$ 算出来和真正的 $A^+$ 差 9.23e+02，而截掉小奇异值的伪逆只差 7.10e-13。差了十五个数量级，原因就藏在这一讲里。

> [!NOTE] 本讲速览
> 视频：[Lecture 33: Left and right inverses; pseudoinverse](https://www.youtube.com/watch?v=Go2aLo7ZOlU)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-33-left-and-right-inverses-pseudoinverse/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §4.5 The Pseudoinverse of a Matrix
> 前置：[第 32 讲：第三次测验复习](/posts/linear-algebra-32-quiz-3-review/)
> 一句话：一个 $m \times n$、秩为 $r$ 的矩阵，在行空间和列空间之间是一一对应的，把这个对应反过来、再把零空间的部分扔掉，就是伪逆 $A^+$；满列秩时它是左逆，满行秩时它是右逆。

> [!TIP] 配合视频
> - 开头几分钟聊测验成绩和他的生日会议，可以跳过。
> - 他在黑板上把 $r$、$m$、$n$ 的关系分四种情形过了一遍（两边可逆、只有左逆、只有右逆、什么都没有）。这是对整门课的复习，值得认真看，我在前三节里逐个用代码走了一遍。
> - 他证明“行空间里的两个不同向量被 $A$ 映成两个不同向量”的那几句话很短，用的是零空间与行空间只交于零向量。这一段建议跟着他的思路听一遍，本篇第四节只做数值验证。
> - 最后用 SVD 构造伪逆的部分，他讲得比教材还多。字幕里他说这个内容不会出现在期末考试里，但它是整门课的收束，别快进。

## 四种可逆性，一张图

他开场就说这是一堂他从没用这种方式讲过的课。内容是对第一章到第四章的复习：对一个 $m \times n$、秩为 $r$ 的矩阵，四个基本子空间的维数分别是 $r$、$n - r$、$r$、$m - r$。零空间要么不存在（只有零向量），要么存在，这决定了逆的样子。

- $r = m = n$：方阵，满秩，两边都有逆。四个子空间里两个零空间都只剩零向量。
- $r = n < m$：满列秩，零空间只有零向量。$A\mathbf{x} = \mathbf{b}$ 要么无解要么只有一个解。有左逆。
- $r = m < n$：满行秩，左零空间只有零向量。$A\mathbf{x} = \mathbf{b}$ 永远有解，但有 $n - m$ 个自由变量，所以有无穷多解。有右逆。
- $r < m$ 且 $r < n$：两个零空间都在，没有左逆也没有右逆，但有伪逆。

他还强调了一件事：矩形矩阵永远不会有两边都成立的逆。$m \neq n$ 时 $A$ 或者 $A^\mathsf{T}$ 必然有一个非零的零空间，被这个空间打成零的向量，没有任何矩阵能把它“复活”。

## 左逆：满列秩，$(A^\mathsf{T}A)^{-1}A^\mathsf{T}$

先看满列秩。他的论证只有一步：列无关，零空间只有零向量，所以 $A^\mathsf{T}A$（$n \times n$ 对称矩阵）的零空间也只有零向量，因此可逆。于是

$$
A^{-1}_\text{left} = (A^\mathsf{T}A)^{-1}A^\mathsf{T}, \qquad A^{-1}_\text{left}\, A = I_n
$$

这正是最小二乘的正规方程 $A^\mathsf{T}A\hat{\mathbf{x}} = A^\mathsf{T}\mathbf{b}$ 的解 $\hat{\mathbf{x}} = A^{-1}_\text{left}\mathbf{b}$。第 16 讲里我们已经见过这个矩阵，这一讲他把它换了一个名字。

顺序反过来会怎样？他停下来问了一个问题：$A\,A^{-1}_\text{left}$ 是什么？全班答“$P$”，投影矩阵：它想变成 $I_m$，可是 $A$ 只有 $n$ 列，能撑起的只有列空间，列空间之外它只能给出零。

我用一个 4 × 2 的矩阵验证（两列是常数列和 $0, 1, 2, 3$，也就是拟合直线的设计矩阵）：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # 满列秩的 4 x 2 矩阵：两列无关，行比列多
    A = np.array([[1.0, 0.0], [1.0, 1.0], [1.0, 2.0], [1.0, 3.0]])
    m, n = A.shape
    print("m, n, r =", m, n, np.linalg.matrix_rank(A))

    # 左逆 (A^T A)^{-1} A^T
    L = np.linalg.inv(A.T @ A) @ A.T
    print("L @ A =")
    print(L @ A)
    print("L @ A 等于单位阵：", np.allclose(L @ A, np.eye(n)))

    # 反过来乘：A @ L 不是单位阵，而是投影到列空间的 P
    P = A @ L
    print("A @ L 等于单位阵：", np.allclose(P, np.eye(m)))
    print("P @ P == P：", np.allclose(P @ P, P))
    print("P.T == P：", np.allclose(P.T, P))
    print("trace(P) =", round(float(np.trace(P)), 4), "（等于秩）")

    # 对 b 来说：在列空间里就恢复 x，不在就得到最小二乘解
    x_true = np.array([2.0, -1.0])
    b_in = A @ x_true
    b_out = b_in + np.array([1.0, -1.0, 1.0, -1.0])
    print("b 在列空间里，L @ b =", L @ b_in)
    print("b 在列空间外，L @ b =", L @ b_out)
    print("和 np.linalg.pinv 一致：", np.allclose(L, np.linalg.pinv(A)))


if __name__ == "__main__":
    main()
```

```text
m, n, r = 4 2 2
L @ A =
[[ 1. -0.]
 [ 0.  1.]]
L @ A 等于单位阵： True
A @ L 等于单位阵： False
P @ P == P： True
P.T == P： True
trace(P) = 2.0 （等于秩）
b 在列空间里，L @ b = [ 2. -1.]
b 在列空间外，L @ b = [ 2.6 -1.4]
和 np.linalg.pinv 一致： True
```

`L @ A` 是单位阵（那个 `-0.` 是浮点的负零，不用理它），`A @ L` 不是；后者是个对称的幂等矩阵，迹等于秩 2，正是投影矩阵的特征。$\mathbf{b}$ 在列空间里时左逆精确还原出 $\mathbf{x} = (2, -1)$；不在时（我加了一个不在列空间里的扰动 $(1, -1, 1, -1)$）它给出的是最小二乘解 $(2.6, -1.4)$。最后一行也说明，在满列秩的情形，`np.linalg.pinv` 给出的就是这个左逆，伪逆在这里没有多出任何新东西。

## 右逆：满行秩，$A^\mathsf{T}(AA^\mathsf{T})^{-1}$

镜像过来。满行秩时 $AA^\mathsf{T}$（$m \times m$）可逆，右逆是

$$
A^{-1}_\text{right} = A^\mathsf{T}(AA^\mathsf{T})^{-1}, \qquad A\,A^{-1}_\text{right} = I_m
$$

他说它和上面“完全平行”。顺序反过来，$A^{-1}_\text{right}A$ 是一个投影，这一次是投到行空间。

这里有个上面没有的现象：因为有自由变量，$A\mathbf{x} = \mathbf{b}$ 有无穷多个解。他说右逆是“我们最喜欢的那个”右逆，因为它给出的解 $\mathbf{x} = A^\mathsf{T}(AA^\mathsf{T})^{-1}\mathbf{b}$ 本身是 $A^\mathsf{T}$ 的列的组合，完全落在行空间里，没有零空间分量。零空间分量只会让解变长，所以这是所有解中最短的。字幕里他没有展开这一点，这个结论是教材和后面伪逆的内容，我用 2 × 4 的矩阵验证：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # 满行秩的 2 x 4 矩阵：两行无关，列比行多
    A = np.array([[1.0, 1.0, 1.0, 1.0], [0.0, 1.0, 2.0, 3.0]])
    m, n = A.shape
    print("m, n, r =", m, n, np.linalg.matrix_rank(A))

    # 右逆 A^T (A A^T)^{-1}
    R = A.T @ np.linalg.inv(A @ A.T)
    print("A @ R =")
    print(A @ R)
    print("A @ R 等于单位阵：", np.allclose(A @ R, np.eye(m)))

    # 反过来乘：R @ A 是投影到行空间的矩阵
    Q = R @ A
    print("R @ A 等于单位阵：", np.allclose(Q, np.eye(n)))
    print("Q @ Q == Q：", np.allclose(Q @ Q, Q))
    print("Q.T == Q：", np.allclose(Q.T, Q))

    # 任何 b 都有解，而且有无穷多个；R @ b 是其中最短的
    b = np.array([3.0, 5.0])
    x = R @ b
    print("x = R @ b =", x, "，A @ x == b：", np.allclose(A @ x, b))

    # 零空间里的两个基向量：加上它们，Ax 不变，x 变长
    N = np.array([[1.0, -2.0, 1.0, 0.0], [2.0, -3.0, 0.0, 1.0]]).T
    print("A @ N 等于零：", np.allclose(A @ N, 0.0))
    rng = np.random.default_rng(1806)
    norms = []
    for _ in range(1000):
        y = x + N @ rng.standard_normal(2)
        assert np.allclose(A @ y, b)
        norms.append(np.linalg.norm(y))
    print("‖x‖ =", round(float(np.linalg.norm(x)), 4))
    print("1000 个别的解里最短的 ‖y‖ =", round(min(norms), 4))
    print("x 和零空间正交：", np.allclose(N.T @ x, 0.0))


if __name__ == "__main__":
    main()
```

```text
m, n, r = 2 4 2
A @ R =
[[ 1.  0.]
 [-0.  1.]]
A @ R 等于单位阵： True
R @ A 等于单位阵： False
Q @ Q == Q： True
Q.T == Q： True
x = R @ b = [0.6 0.7 0.8 0.9] ，A @ x == b： True
A @ N 等于零： True
‖x‖ = 1.5166
1000 个别的解里最短的 ‖y‖ = 1.5182
x 和零空间正交： True
```

$A\mathbf{x} = \mathbf{b}$ 有无穷多个解，我在零空间里随机抽了 1000 个方向，把它们加到 $\mathbf{x}$ 上（每个都仍然满足方程，代码里用 `assert` 保证），最短的也有 1.5182，比 $\mathbf{x} = R\mathbf{b}$ 的 1.5166 长。当然抽样不是证明，证明很短：$\mathbf{x}$ 和零空间正交（最后一行），所以 $\|\mathbf{x} + \mathbf{n}\|^2 = \|\mathbf{x}\|^2 + \|\mathbf{n}\|^2$，加任何非零的 $\mathbf{n}$ 都变长。

## 一般情形：A 是行空间到列空间的一座桥

四种情形里最后一种才是他真正想讲的：$r < m$ 且 $r < n$，两个零空间都在，$A^\mathsf{T}A$ 和 $AA^\mathsf{T}$ 都不可逆，上面两个公式都失效。

他的图是这样的：行空间里的向量 $\mathbf{x}$，乘上 $A$ 以后落在列空间里。两个空间的维数都是 $r$。关键的事实是：**如果 $\mathbf{x}$ 和 $\mathbf{y}$ 是行空间里两个不同的向量，那么 $A\mathbf{x} \neq A\mathbf{y}$。** 他的证明很短：假设相等，则 $A(\mathbf{x} - \mathbf{y}) = \mathbf{0}$，所以 $\mathbf{x} - \mathbf{y}$ 在零空间里；但它同时是行空间里两个向量的差，也在行空间里。零空间和行空间只交于零向量，所以 $\mathbf{x} = \mathbf{y}$。

所以把定义域限制在行空间、值域限制在列空间，$A$ 是一座没有岔路的桥，两个方向都能走。往回走的那个方向就是伪逆 $A^+$。零空间是桥外的水域：$A$ 把水域里的东西都打成零，$A^+$ 对列空间之外的东西（左零空间）也同样不管，直接给零。

我用一个秩 2 的 4 × 3 矩阵走一遍：第三列等于前两列之和，第四行等于第一行。顺便按他最后讲的做法，手写一个基于 SVD 的伪逆，并和 `np.linalg.pinv` 对比。

SVD 的做法是：$A = U\Sigma V^\mathsf{T}$，$U$ 和 $V$ 是正交矩阵，它们的逆就是转置。$\Sigma$ 是一个 $m \times n$ 的“对角”矩阵，对角线上有 $r$ 个非零的奇异值，其余都是零。它的伪逆 $\Sigma^+$ 是 $n \times m$ 的：非零的对角元取倒数，其余仍然是零。于是

$$
A^+ = V\,\Sigma^+\,U^\mathsf{T}
$$

他说了一句我很喜欢的话：$\Sigma^+$ 是“最小的”那个，因为你当然可以在零的位置塞上别的数，它们乘出来的还是零，但那只是平白变大。

```python
import numpy as np


def pinv_svd(A: np.ndarray, tol: float = 1e-10) -> np.ndarray:
    """用 SVD 手写伪逆：把非零奇异值取倒数，零的留着零。"""
    U, s, Vt = np.linalg.svd(A)
    m, n = A.shape
    sigma_plus = np.zeros((n, m))
    for i, sigma in enumerate(s):
        if sigma > tol * s[0]:
            sigma_plus[i, i] = 1.0 / sigma
    return Vt.T @ sigma_plus @ U.T


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # 4 x 3，第三列等于前两列之和，第四行等于第一行：秩 2
    A = np.array(
        [
            [1.0, 0.0, 1.0],
            [1.0, 1.0, 2.0],
            [1.0, 2.0, 3.0],
            [1.0, 0.0, 1.0],
        ]
    )
    m, n = A.shape
    r = np.linalg.matrix_rank(A)
    print("m, n, r =", m, n, r)
    print("A^T A 的秩：", np.linalg.matrix_rank(A.T @ A), "，不可逆")
    print("A A^T 的秩：", np.linalg.matrix_rank(A @ A.T), "，也不可逆")

    U, s, Vt = np.linalg.svd(A)
    print("奇异值：", s)

    A_plus = pinv_svd(A)
    print("A^+ =")
    print(A_plus)
    print("和 np.linalg.pinv 一致：", np.allclose(A_plus, np.linalg.pinv(A)))

    # 两边都乘不出单位阵，得到的是投影
    P_col = A @ A_plus
    P_row = A_plus @ A
    print("A A^+ 是 4 x 4 投影，秩", np.linalg.matrix_rank(P_col))
    print("A^+ A 是 3 x 3 投影，秩", np.linalg.matrix_rank(P_row))
    print("A A^+ 是投影：", np.allclose(P_col @ P_col, P_col))
    print("A^+ A 是投影：", np.allclose(P_row @ P_row, P_row))
    print("A A^+ 对称：", np.allclose(P_col, P_col.T))
    print("A^+ A 对称：", np.allclose(P_row, P_row.T))

    # 行空间的基 V_r（Vt 的前 r 行）：A 在行空间上一对一
    V_r = Vt[:r].T
    rng = np.random.default_rng(1806)
    x = V_r @ rng.standard_normal(r)
    y = V_r @ rng.standard_normal(r)
    print("x、y 在行空间里，x != y：", not np.allclose(x, y))
    print("A @ x != A @ y：", not np.allclose(A @ x, A @ y))
    print("A^+ @ (A @ x) 把 x 找回来：", np.allclose(A_plus @ (A @ x), x))
    print("A @ V_r 的秩：", np.linalg.matrix_rank(A @ V_r))


if __name__ == "__main__":
    main()
```

```text
m, n, r = 4 3 2
A^T A 的秩： 2 ，不可逆
A A^T 的秩： 2 ，也不可逆
奇异值： [4.7472 1.2101 0.    ]
A^+ =
[[ 0.3939  0.0909 -0.2121  0.3939]
 [-0.3333 -0.      0.3333 -0.3333]
 [ 0.0606  0.0909  0.1212  0.0606]]
和 np.linalg.pinv 一致： True
A A^+ 是 4 x 4 投影，秩 2
A^+ A 是 3 x 3 投影，秩 2
A A^+ 是投影： True
A^+ A 是投影： True
A A^+ 对称： True
A^+ A 对称： True
x、y 在行空间里，x != y： True
A @ x != A @ y： True
A^+ @ (A @ x) 把 x 找回来： True
A @ V_r 的秩： 2
```

几处和他说的一一对应：

- 三个奇异值里只有两个非零，$\Sigma^+$ 只对它们取倒数。`pinv_svd` 里的容差 `tol * s[0]` 就是在判断“零”：奇异值小于最大奇异值的 $10^{-10}$ 倍就当作零。
- $A^\mathsf{T}A$ 和 $AA^\mathsf{T}$ 的秩都是 2，一个 3 × 3、一个 4 × 4，都不可逆，所以左逆右逆的公式在这里都不能用。
- $AA^+$（4 × 4）和 $A^+A$（3 × 3）都是对称的幂等矩阵，秩都是 2：前者是投影到列空间，后者是投影到行空间。他的说法是：左乘右乘都得不到单位阵，$A^+$ 能做的是把向量带进行空间和列空间这两个“好空间”，再把零空间抹掉。
- 在行空间里随便取两个不同的向量，$A$ 映出来的也不同，而且 $A^+$ 能把它们找回来。$A$ 作用在行空间的基 $V_r$ 上，结果仍然是秩 2，没有丢掉任何维度。

## 最小范数解：伪逆给出的那一个答案

有了 $A^+$，$A\mathbf{x} = \mathbf{b}$ 不管秩是多少、有没有解，都可以写一个统一的答案：$\mathbf{x}^+ = A^+\mathbf{b}$。$\mathbf{b}$ 在列空间里时它是方程组的解，不在时它是最小二乘解；解不唯一时（零空间非零）它是所有候选解里最短的那一个。

他在这一讲里特别提到了统计学家：做线性回归的人天天用最小二乘，但前提是 $A^\mathsf{T}A$ 可逆，也就是列无关。他开玩笑说，统计学家最怕的事就是“把同一个实验重复了几遍”，那样列就不无关了，$A^\mathsf{T}A$ 奇异，这时伪逆来得正是时候。

下面这个脚本用的是上一节同一个矩阵，第三列是前两列之和，相当于那个“重复的实验”，并故意给了一个不在列空间里的 $\mathbf{b}$。我看三件事：$A^+\mathbf{b}$ 和 `np.linalg.lstsq` 给的最小范数解是不是同一个；沿着零空间走，残差有没有变；再给 $A$ 加上 1e-12 量级的噪声，朴素左逆、`pinv` 的默认设置和带截断的 `pinv` 会怎么样：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # 同一个 4 x 3 的秩 2 矩阵：第三列等于前两列之和
    A = np.array(
        [
            [1.0, 0.0, 1.0],
            [1.0, 1.0, 2.0],
            [1.0, 2.0, 3.0],
            [1.0, 0.0, 1.0],
        ]
    )
    b = np.array([1.0, 2.0, 2.0, 3.0])
    A_plus = np.linalg.pinv(A)
    x_plus = A_plus @ b
    print("x^+ = A^+ b =", x_plus)

    # 正规方程 A^T A x = A^T b 有无穷多个解，x^+ 是其中最短的
    x_lstsq, _, rank, _ = np.linalg.lstsq(A, b, rcond=None)
    print("np.linalg.lstsq 的解：", x_lstsq, "，秩", rank)
    print("两者一致：", np.allclose(x_plus, x_lstsq))

    # 零空间：(1, 1, -1)；沿着它走，残差不变，长度变大
    z = np.array([1.0, 1.0, -1.0])
    print("A @ z 等于零：", np.allclose(A @ z, 0.0))
    print("x^+ 和 z 正交：", np.isclose(x_plus @ z, 0.0))
    for t in [0.0, 0.5, 1.0, 2.0]:
        x = x_plus + t * z
        print(
            f"t = {t}: 残差 {np.linalg.norm(A @ x - b):.4f}，"
            f"长度 {np.linalg.norm(x):.4f}"
        )

    # 数据里有 1e-12 量级的噪声时，“秩 2”就不是整数了
    rng = np.random.default_rng(1806)
    A_noisy = A + 1e-12 * rng.standard_normal(A.shape)
    naive = np.linalg.inv(A_noisy.T @ A_noisy) @ A_noisy.T
    default = np.linalg.pinv(A_noisy)
    cut = np.linalg.pinv(A_noisy, rcond=1e-8)
    for name, M in [
        ("朴素左逆", naive),
        ("pinv 默认", default),
        ("pinv 截断", cut),
    ]:
        print(f"{name}：和 A^+ 差 {np.linalg.norm(M - A_plus):.2e}")
    s = np.linalg.svd(A_noisy, compute_uv=False)
    print("加噪后最小的奇异值：", f"{s[-1]:.2e}")


if __name__ == "__main__":
    main()
```

```text
x^+ = A^+ b = [ 1.3333 -0.6667  0.6667]
np.linalg.lstsq 的解： [ 1.3333 -0.6667  0.6667] ，秩 2
两者一致： True
A @ z 等于零： True
x^+ 和 z 正交： True
t = 0.0: 残差 1.4142，长度 1.6330
t = 0.5: 残差 1.4142，长度 1.8484
t = 1.0: 残差 1.4142，长度 2.3805
t = 2.0: 残差 1.4142，长度 3.8297
朴素左逆：和 A^+ 差 9.23e+02
pinv 默认：和 A^+ 差 1.83e+12
pinv 截断：和 A^+ 差 7.10e-13
加噪后最小的奇异值： 5.47e-13
```

前半段是他讲的东西：$A^+\mathbf{b} = (1.3333, -0.6667, 0.6667)$，和 `np.linalg.lstsq` 一致（后者对秩亏的问题返回的就是最小范数解）。零空间是 $(1, 1, -1)$ 的倍数，沿着它走，残差一直是 $\sqrt{2} = 1.4142$，不变；长度从 1.6330 一路涨到 3.8297，$t = 2$ 时是原来的 2.35 倍。$\mathbf{x}^+$ 和零空间正交，所以它是最短的。

后半段是他没讲、但我觉得最值得知道的。加了 1e-12 的噪声之后，$A$ 在数值上其实已经是满秩的了：最小的奇异值是 5.47e-13，不是零。朴素的 $(A^\mathsf{T}A)^{-1}A^\mathsf{T}$ 要对 $A^\mathsf{T}A$ 求逆，而 $A^\mathsf{T}A$ 的最小特征值是这个奇异值的平方，量级在 $10^{-25}$，比双精度能分辨的下限小得多，结果和 $A^+$ 差了 9.23e+02。`np.linalg.pinv` 的默认截断很小（据我所知是 1e-15 乘最大奇异值），5.47e-13 比它大，所以它也认为这个方向是“有效”的，把它取倒数，差了 1.83e+12，比朴素左逆还糟。只有我自己把截断设成 `rcond=1e-8`，把小于最大奇异值 $10^{-8}$ 倍的都当作零，才得到 7.10e-13 的差：从 1.83e+12 降到 7.10e-13，差了约 24 个数量级。

这说明伪逆在数学上总是良定义的，在数值上却要你自己告诉它“多小算零”。这个阈值是一个判断，不是定理，SVD 只是把问题摆在了最容易判断的位置。（1e-8 是我随手挑的，它落在噪声 5e-13 和真正的奇异值 1.21 之间很宽的一段里，我没有试别的值。）

## 在控制里

麦轮底盘有 4 个轮子、3 个自由度（前后、左右、转动），所以从“四个电机电流”到“车体受到的合力和力矩”的映射是一个 3 × 4 的矩阵 $B$，满行秩：给定想要的合力合力矩 $\mathbf{w}$，$B\mathbf{i} = \mathbf{w}$ 永远有解，而且有一个维数 $4 - 3 = 1$ 的零空间。这正是这一讲的第三种情形，用右逆 $B^\mathsf{T}(BB^\mathsf{T})^{-1}$ 分配电流。

下面的 $B$ 是我编的示意矩阵，只借了形状，不是某一台真车的标定值；真正的矩阵和推导在 [多变量：耦合、RGA、解耦与麦轮底盘](/posts/pid-control-08-mimo/) 里，那一篇把最小范数电流和 `numpy.linalg.pinv` 的结果对比，差 5.6e-17。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # 示意用的 3 x 4 分配矩阵：四个电流 -> (Fx, Fy, 力矩)
    # 不是某一台真车的标定值，只借它的形状：3 个自由度，4 个轮子
    B = np.array(
        [
            [1.0, 1.0, 1.0, 1.0],
            [-1.0, 1.0, -1.0, 1.0],
            [-1.0, 1.0, 1.0, -1.0],
        ]
    )
    print("B 的形状：", B.shape, "，秩", np.linalg.matrix_rank(B))

    # 右逆：给一个想要的合力与力矩，分配出四个电流
    w = np.array([2.0, 1.0, 0.5])
    R = B.T @ np.linalg.inv(B @ B.T)
    i_min = R @ w
    print("最小范数电流：", i_min, "，B @ i == w：", np.allclose(B @ i_min, w))
    print("和 pinv 一致：", np.allclose(R, np.linalg.pinv(B)))

    # 零空间方向：四个轮子互相较劲，合力合力矩都不变
    n = np.array([1.0, 1.0, -1.0, -1.0])
    print("B @ n =", B @ n)
    for t in [0.0, 1.0, 2.0]:
        i = i_min + t * n
        print(
            f"加 {t} 倍零空间电流：B @ i 不变 {np.allclose(B @ i, w)}，"
            f"sum(i^2) = {i @ i:.4f}"
        )


if __name__ == "__main__":
    main()
```

```text
B 的形状： (3, 4) ，秩 3
最小范数电流： [0.125 0.875 0.375 0.625] ，B @ i == w： True
和 pinv 一致： True
B @ n = [0. 0. 0.]
加 0.0 倍零空间电流：B @ i 不变 True，sum(i^2) = 1.3125
加 1.0 倍零空间电流：B @ i 不变 True，sum(i^2) = 5.3125
加 2.0 倍零空间电流：B @ i 不变 True，sum(i^2) = 17.3125
```

零空间方向 $(1, 1, -1, -1)$ 是“两个轮子顺着推，另外两个逆着推”，合力和力矩互相抵消，只剩下发热。电机的发热正比于电流的平方，所以最小范数的分配（$\sum i^2 = 1.3125$）就是同样的合力下最省电的分配：叠一倍零空间电流，$\sum i^2$ 涨到 5.3125，叠两倍涨到 17.3125，是最小值的 13.2 倍，而合力和力矩一点没变。我猜实际的底盘有时会故意利用这个零空间，比如某个轮子饱和了就往零空间里借一点，那是另一回事，这里只说默认的伪逆分配不会白白浪费电流。

## 下一讲

他在这一讲结尾说，周三的最后一讲会尽可能把整门课过一遍。下一讲是期末复习：[18.06 第 34 讲：期末复习](/posts/linear-algebra-34-final-review/)。这一讲其实已经是预演了，四个子空间、投影、最小二乘、SVD 全都出现了一遍。
