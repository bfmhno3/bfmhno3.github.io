---
title: "18.06 第 34 讲：期末复习"
commentId: "post:linear-algebra-34-final-review"
published: "2026-10-18 19:20:00 +08:00"
description: "MIT 18.06 第 34 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 把 Strang 期末复习课上的每道题都算了一遍，Markov 矩阵从 (0, 10, 0) 出发迭代 10 步，离稳态 (3, 3, 4) 只剩 7.24e-07。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 期末复习
  - 四个基本子空间
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 35
draft: false
comment: true
slug: linear-algebra-34-final-review
---

最后一讲没有新内容，Strang 的做法是翻出老试卷，把题一道一道念出来，让全班一起想。我把每道题都交给 NumPy 过了一遍：一个 3 × 2 矩阵同时满足“一个右端项无解、另一个恰好一个解”，$\det(A^\mathsf{T}A) = 1$ 而 $\det(AA^\mathsf{T}) = 0$；Markov 矩阵从 $(0, 10, 0)$ 出发迭代 10 步，离稳态 $(3, 3, 4)$ 只剩 $7.24 \times 10^{-7}$。

> [!NOTE] 本讲速览
> 视频：[Lecture 34: Final course review](https://www.youtube.com/watch?v=RWvi4Vx4CDc)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-34-final-course-review/)）
> 教材：《Introduction to Linear Algebra》第 6 版 全书第 1 到 8 章
> 前置：[第 33 讲：左逆、右逆与伪逆](/posts/linear-algebra-33-pseudoinverse/)
> 一句话：期末题考的几乎都是同一件事：看到 $m$、$n$、$r$ 就想到四个子空间，看到解的个数就想到零空间。

> [!TIP] 配合视频
> - 开头几句是考试安排，可以跳过。第一道题（3 × $n$ 矩阵，一个右端项无解、一个有唯一解）值得认真看，他一步步把 $m$、$n$、$r$ 的关系推出来。
> - 求 Markov 矩阵稳态向量的那一段，他在黑板上猜 $(3, 3, 4)$，猜之前冷了一会儿场，可以倍速。“总人数不变所以 $c_2 = 1$”这一句要听。
> - 2 × 2 矩阵的快问快答和最后的最小二乘，本篇都已经算过，倍速即可。
> - 结尾他向全班道谢。这是整门课的最后几句话，我觉得值得原速看完。

## 一个矩阵，三个数

**他的第一道题：** 一个 $3 \times n$ 矩阵 $A$，已知 $A\mathbf{x} = (1, 0, 0)$ 无解，$A\mathbf{x} = (0, 1, 0)$ 恰好有一个解。$m$、$n$、$r$ 能说什么？

推理只有两步。有的右端项无解，说明不是每一行都有主元，所以 $r < m$，而 $m$ 本来就是 3。有解时只有一个解，说明零空间里只有零向量，所以 $r = n$，列无关。合起来是 $r = n < m = 3$。

他要一个例子。我猜他心里想的是最省事的那个：只有一列 $(0, 1, 0)$。他也允许加第二列，我取 $(0, 0, 1)$，这样 $A^\mathsf{T}A$ 恰好是单位阵，后面的判断题好查：

$$
A = \begin{bmatrix} 0 & 0 \\ 1 & 0 \\ 0 & 1 \end{bmatrix}
$$

接着是三道判断题：$\det(A^\mathsf{T}A) = \det(AA^\mathsf{T})$；$A^\mathsf{T}A$ 可逆；$AA^\mathsf{T}$ 正定。最后他还要求证明 $A^\mathsf{T}\mathbf{y} = \mathbf{c}$ 对每个 $\mathbf{c}$ 都有解，而且有无穷多个解。下面一次全算：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # 3 x 2 的例子：列空间里有 (0, 1, 0) 和 (0, 0, 1)，没有 (1, 0, 0)
    A = np.array([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]])
    e1 = np.array([1.0, 0.0, 0.0])
    e2 = np.array([0.0, 1.0, 0.0])

    m, n = A.shape
    r = np.linalg.matrix_rank(A)
    print("m, n, r =", m, n, r)

    # Ax = (1, 0, 0) 没有解：最小二乘的残差不为 0
    for name, rhs in [("(1, 0, 0)", e1), ("(0, 1, 0)", e2)]:
        x, *_ = np.linalg.lstsq(A, rhs, rcond=None)
        print(
            f"Ax = {name}：x = {x}，残差 = {np.linalg.norm(A @ x - rhs):.4f}"
        )

    # 三个判断题
    AtA = A.T @ A
    AAt = A @ A.T
    print("AtA =")
    print(AtA)
    print("det(AtA) =", np.linalg.det(AtA), "，det(AAt) =", np.linalg.det(AAt))
    print("AAt 的特征值：", np.linalg.eigvalsh(AAt))
    print("AAt 的秩：", np.linalg.matrix_rank(AAt))

    # A^T y = c 对每个 c 有解，而且解不唯一：左零空间的维数是 m - r
    c = np.array([2.0, -5.0])
    y, *_ = np.linalg.lstsq(A.T, c, rcond=None)
    print("A^T y = c 的一个解 y =", y, "，残差 =", np.linalg.norm(A.T @ y - c))
    print("左零空间的维数 m - r =", m - r)
    y_other = y + 7.0 * e1
    print(
        "加上左零空间里的 7 * (1, 0, 0) 之后仍然是解：",
        np.allclose(A.T @ y_other, c),
    )


if __name__ == "__main__":
    main()
```

```text
m, n, r = 3 2 2
Ax = (1, 0, 0)：x = [0. 0.]，残差 = 1.0000
Ax = (0, 1, 0)：x = [1. 0.]，残差 = 0.0000
AtA =
[[1. 0.]
 [0. 1.]]
det(AtA) = 1.0 ，det(AAt) = 0.0
AAt 的特征值： [0. 1. 1.]
AAt 的秩： 2
A^T y = c 的一个解 y = [ 0.  2. -5.] ，残差 = 0.0
左零空间的维数 m - r = 1
加上左零空间里的 7 * (1, 0, 0) 之后仍然是解： True
```

输出对着题目一条条读。

- $r = n = 2 < m = 3$，和推理一致；$(1, 0, 0)$ 的最小二乘残差是 1.0000，没有精确解，$(0, 1, 0)$ 的残差是 0.0000。
- $A^\mathsf{T}A$ 是单位阵，可逆（列无关），为真。
- $\det(A^\mathsf{T}A) = 1.0$，$\det(AA^\mathsf{T}) = 0.0$，所以第一条为假。陷阱在于 $\det(AB) = \det(BA)$ 只对两个方阵成立：$A$ 是 3 × 2 时，$AA^\mathsf{T}$ 是 3 × 3、秩只有 2。
- $AA^\mathsf{T}$ 的特征值是 $0, 1, 1$，有 0，所以不是正定，只是半正定。他说的“第一行一定全是 0”在这个例子里就是特征值 0 的来源。
- $A^\mathsf{T}$ 是 $n \times m$，行无关（$r = n$），所以 $A^\mathsf{T}\mathbf{y} = \mathbf{c}$ 总有解；左零空间的维数是 $m - r = 1 > 0$，所以解有无穷多个。代码里给解加上 $7(1, 0, 0)$，仍然满足方程。

整道题没有一步用到消元，全靠 $r$、$m$、$n$ 和四个子空间的维数（这套账 $r$、$n - r$、$r$、$m - r$ 在[第 10 讲](/posts/linear-algebra-10-four-fundamental-subspaces/)里算过）。

## 三个列向量能说明什么

**第二道题：** $A$ 有三列 $\mathbf{v}_1, \mathbf{v}_2, \mathbf{v}_3$。(a) 解 $A\mathbf{x} = \mathbf{v}_1 - \mathbf{v}_2 + \mathbf{v}_3$；(b) 如果这个组合等于零，解唯一吗；(c) 如果三个向量标准正交，$\mathbf{v}_1$ 与 $\mathbf{v}_2$ 的哪个组合最接近 $\mathbf{v}_3$。

(a) 是第一讲的“按列乘”，$\mathbf{x} = (1, -1, 1)$。(b) 组合为零，说明这个 $\mathbf{x}$ 在零空间里，解永远不唯一，因为总能把它加到任何解上。(c) 想象 $\mathbf{v}_1, \mathbf{v}_2, \mathbf{v}_3$ 是 $x$、$y$、$z$ 轴，$z$ 轴到 $xy$ 平面的最近点就是原点，答案是 0 份和 0 份。

我用固定种子的随机向量验证三问，(c) 用 `np.linalg.qr` 造一组标准正交的列：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # (a) A x = v1 - v2 + v3，按列乘
    V = rng.standard_normal((4, 3))
    x = np.array([1.0, -1.0, 1.0])
    print(
        "(a) A @ x 等于 v1 - v2 + v3：",
        np.allclose(V @ x, V[:, 0] - V[:, 1] + V[:, 2]),
    )

    # (b) 如果 v1 - v2 + v3 = 0，则 (1, -1, 1) 在零空间里，解不唯一
    W = V.copy()
    W[:, 2] = W[:, 1] - W[:, 0]
    print("(b) W @ x =", W @ x)
    print("    W 的秩：", np.linalg.matrix_rank(W), "< 3，零空间不只有 0")

    # (c) 如果 v1, v2, v3 标准正交，v3 在 v1, v2 平面上的最近点是 0
    Q, _ = np.linalg.qr(rng.standard_normal((5, 3)))
    coef, *_ = np.linalg.lstsq(Q[:, :2], Q[:, 2], rcond=None)
    print(
        "(c) Q^T Q 与单位阵的距离：",
        f"{np.linalg.norm(Q.T @ Q - np.eye(3)):.1e}",
    )
    print(
        "    最近组合的系数 =",
        np.round(coef, 6) + 0.0,
        "，误差 =",
        f"{np.linalg.norm(Q[:, :2] @ coef - Q[:, 2]):.4f}",
    )


if __name__ == "__main__":
    main()
```

```text
(a) A @ x 等于 v1 - v2 + v3： True
(b) W @ x = [0. 0. 0. 0.]
    W 的秩： 2 < 3，零空间不只有 0
(c) Q^T Q 与单位阵的距离： 3.3e-16
    最近组合的系数 = [0. 0.] ，误差 = 1.0000
```

(b) 里 $W\mathbf{x}$ 是零向量，秩是 2，小于 3。(c) 里 $Q^\mathsf{T}Q$ 离单位阵只差 $3.3 \times 10^{-16}$，最近组合的系数是两个 0，误差 1.0000，恰好是 $\mathbf{v}_3$ 自己的长度。标准正交的好处就在这里：投影时各个方向互不干扰，不用解正规方程。

## Markov 矩阵与稳态

**第三道题：** 给一个 Markov 矩阵，问特征值，再问从 $\mathbf{u}_0 = (0, 10, 0)$ 出发，$A^k\mathbf{u}_0$ 趋向哪里。

字幕是语音转写，矩阵的数字被听写得一团糟。我按他念的性质还原：每列和为 1、第一列加第二列等于两倍第三列、迹是 0.8、$(3, 3, 4)$ 是 $\lambda = 1$ 的特征向量，得到

$$
A = \begin{bmatrix} 0.2 & 0.4 & 0.3 \\ 0.4 & 0.2 & 0.3 \\ 0.4 & 0.4 & 0.4 \end{bmatrix}
$$

这个矩阵同时满足上面全部四条，我认为就是黑板上的那个，不过这是还原，不是抄录。他的推理顺序是：列有线性关系，所以奇异，有一个特征值 0；Markov 矩阵必有特征值 1；迹是 0.8，所以第三个是 $0.8 - 0 - 1 = -0.2$。稳态只剩 $c_2\mathbf{x}_2$，$\mathbf{x}_2$ 是 $\lambda = 1$ 的特征向量，$c_2$ 靠“总人数不变”：起点总共 10 人，所以 $c_2 = 1$，$\mathbf{u}_\infty = (3, 3, 4)$。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[0.2, 0.4, 0.3], [0.4, 0.2, 0.3], [0.4, 0.4, 0.4]])
    u0 = np.array([0.0, 10.0, 0.0])

    print("列和：", A.sum(axis=0))
    print(
        "第一列加第二列等于两倍第三列：",
        np.allclose(A[:, 0] + A[:, 1], 2 * A[:, 2]),
    )
    print("迹：", np.trace(A), "，det：", f"{np.linalg.det(A):.1e}")
    print("特征值：", np.sort(np.linalg.eigvals(A).real))

    # 稳态：lambda = 1 的特征向量，按总人数 10 缩放
    lam, S = np.linalg.eig(A)
    x = S[:, np.argmin(np.abs(lam - 1.0))].real
    steady = 10.0 * x / x.sum()
    print(
        "稳态 u_inf =",
        steady,
        "，A @ u_inf 不变：",
        np.allclose(A @ steady, steady),
    )

    # 误差按 (-0.2)^k 衰减
    u = u0.copy()
    for k in range(1, 11):
        u = A @ u
        if k in (1, 2, 5, 10):
            print(
                f"k = {k:2d}：u = {u}，到稳态的距离 =",
                f"{np.linalg.norm(u - steady):.2e}",
            )


if __name__ == "__main__":
    main()
```

```text
列和： [1. 1. 1.]
第一列加第二列等于两倍第三列： True
迹： 0.8 ，det： -6.7e-18
特征值： [-0.2  0.   1. ]
稳态 u_inf = [3. 3. 4.] ，A @ u_inf 不变： True
k =  1：u = [4. 2. 4.]，到稳态的距离 = 1.41e+00
k =  2：u = [2.8 3.2 4. ]，到稳态的距离 = 2.83e-01
k =  5：u = [3.0016 2.9984 4.    ]，到稳态的距离 = 2.26e-03
k = 10：u = [3. 3. 4.]，到稳态的距离 = 7.24e-07
```

特征值是 $-0.2, 0, 1$，稳态正好是 $(3, 3, 4)$，每一步误差大约缩小到原来的 $0.2$ 倍：$k = 5$ 时离稳态 $2.26 \times 10^{-3}$，$k = 10$ 时 $7.24 \times 10^{-7}$，从第 1 步到第 10 步缩小了约 $2 \times 10^6$ 倍。行列式打印出 $-6.7 \times 10^{-18}$，那是浮点误差，真值是 0。

## 2 × 2 快问快答

**第四组：** 他念性质，全班给 2 × 2 的例子，没有就说没有。

- 投影到过 $\mathbf{a} = (4, -3)$ 的直线：$P = \mathbf{a}\mathbf{a}^\mathsf{T} / \mathbf{a}^\mathsf{T}\mathbf{a}$，分母是个数，直接除。
- 特征值 0 和 3，特征向量 $(1, 2)$ 和 $(2, 1)$：$A = S\Lambda S^{-1}$。
- 不能写成 $B^\mathsf{T}B$ 的实矩阵：$B^\mathsf{T}B$ 总是对称的，所以任意一个不对称矩阵都行。
- 特征向量正交但不对称：反对称矩阵或正交（旋转）矩阵，特征向量是复的，但在复内积下正交。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 1. 投影到过 a = (4, -3) 的直线
    a = np.array([[4.0], [-3.0]])
    P = a @ a.T / (a.T @ a)
    print("P =")
    print(P)
    print(
        "P @ P == P：",
        np.allclose(P @ P, P),
        "，P.T == P：",
        np.allclose(P.T, P),
    )

    # 2. 特征值 0 与 3，特征向量 (1, 2) 与 (2, 1)
    S = np.array([[1.0, 2.0], [2.0, 1.0]])
    Lam = np.diag([0.0, 3.0])
    A = S @ Lam @ np.linalg.inv(S)
    print("A = S Lam S^-1 =")
    print(A)
    print("特征值：", np.sort(np.linalg.eigvals(A).real))

    # 3. 不对称的矩阵不可能写成 B^T B
    N = np.array([[1.0, 2.0], [0.0, 1.0]])
    print("N 对称吗：", np.allclose(N, N.T))

    # 4. 反对称与正交矩阵：特征向量复正交，但矩阵不对称
    theta = 0.7
    K = np.array([[0.0, 1.0], [-1.0, 0.0]])
    Q = np.array(
        [[np.cos(theta), np.sin(theta)], [-np.sin(theta), np.cos(theta)]]
    )
    for name, M in [("反对称 K", K), ("旋转 Q", Q)]:
        lam, V = np.linalg.eig(M)
        inner = np.vdot(V[:, 0], V[:, 1])
        print(
            name,
            "：特征值",
            lam,
            "，复内积 =",
            f"{abs(inner):.1e}",
            "，对称：",
            np.allclose(M, M.T),
        )


if __name__ == "__main__":
    main()
```

```text
P =
[[ 0.64 -0.48]
 [-0.48  0.36]]
P @ P == P： True ，P.T == P： True
A = S Lam S^-1 =
[[ 4. -2.]
 [ 2. -1.]]
特征值： [0. 3.]
N 对称吗： False
反对称 K ：特征值 [0.+1.j 0.-1.j] ，复内积 = 0.0e+00 ，对称： False
旋转 Q ：特征值 [0.7648+0.6442j 0.7648-0.6442j] ，复内积 = 0.0e+00 ，对称： False
```

$P$ 满足 $P^2 = P$ 与 $P^\mathsf{T} = P$。$S\Lambda S^{-1}$ 给出 $\begin{bmatrix} 4 & -2 \\ 2 & -1 \end{bmatrix}$，特征值回到 0 和 3。最后一条里，反对称矩阵的特征值是 $\pm i$，旋转 0.7 弧度的矩阵是 $\cos 0.7 \pm i \sin 0.7$，两者的特征向量复内积都是 0，矩阵却都不对称。复内积我用 `np.vdot` 算，它会自动取共轭，这是[第 26 讲](/posts/linear-algebra-26-complex-matrices-fft/)的内容。

## 最小二乘：给答案，找问题

**最后一道：** 他说像 Jeopardy 节目，先给答案再问问题。系统是

$$
\begin{bmatrix} 1 & 0 \\ 1 & 1 \\ 1 & 2 \end{bmatrix}
\begin{bmatrix} C \\ D \end{bmatrix}
= \begin{bmatrix} 3 \\ 4 \\ 1 \end{bmatrix}
$$

最小二乘解是 $(\hat{C}, \hat{D}) = (11/3, -1)$。问题有三个：$\mathbf{b}$ 在列空间上的投影 $\mathbf{p}$ 是什么；对应的直线拟合问题画出来是什么样；再找一个不全为零的 $\mathbf{b}$，让最小二乘解变成零。

答案依次是：$\mathbf{p} = \frac{11}{3}\,\text{列一} - \text{列二}$，最小二乘找的就是“列的最近组合”；直线在 $t = 0, 1, 2$ 处拟合高度 $3, 4, 1$，截距 $11/3$、斜率 $-1$；最后，$\mathbf{b}$ 要和两列都正交，比如 $(1, -2, 1)$。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[1.0, 0.0], [1.0, 1.0], [1.0, 2.0]])
    b = np.array([3.0, 4.0, 1.0])

    # 正规方程与 lstsq
    x_hat = np.linalg.solve(A.T @ A, A.T @ b)
    x_lstsq, *_ = np.linalg.lstsq(A, b, rcond=None)
    print("x_hat =", x_hat, "，11/3 =", 11 / 3)
    print("两种解法一致：", np.allclose(x_hat, x_lstsq))

    # 投影 p = A x_hat：11/3 倍列一，减一倍列二
    p = A @ x_hat
    print("p =", p)
    print(
        "p = 11/3 * 列一 - 列二：", np.allclose(p, 11 / 3 * A[:, 0] - A[:, 1])
    )
    print("误差 b - p 与两列正交：", np.allclose(A.T @ (b - p), 0))
    print(
        "||b|| =",
        f"{np.linalg.norm(b):.4f}",
        "，||p|| =",
        f"{np.linalg.norm(p):.4f}",
        "，||b - p|| =",
        f"{np.linalg.norm(b - p):.4f}",
    )

    # 最小二乘解是 0 的 b：与两列都正交，比如 (1, -2, 1)
    b0 = np.array([1.0, -2.0, 1.0])
    print("A^T b0 =", A.T @ b0)
    x0, *_ = np.linalg.lstsq(A, b0, rcond=None)
    print("b0 的最小二乘解 =", x0 + 0.0)


if __name__ == "__main__":
    main()
```

```text
x_hat = [ 3.6667 -1.    ] ，11/3 = 3.6666666666666665
两种解法一致： True
p = [3.6667 2.6667 1.6667]
p = 11/3 * 列一 - 列二： True
误差 b - p 与两列正交： True
||b|| = 5.0990 ，||p|| = 4.8305 ，||b - p|| = 1.6330
A^T b0 = [0. 0.]
b0 的最小二乘解 = [0. 0.]
```

$\mathbf{p} = (3.6667, 2.6667, 1.6667)$。勾股定理在这里看得很清楚：$\|\mathbf{b}\| = 5.0990$，投影 $\|\mathbf{p}\| = 4.8305$，误差 $\|\mathbf{b} - \mathbf{p}\| = 1.6330$，$4.8305^2 + 1.6330^2 = 26.00 = 5.0990^2$。$A^\mathsf{T}\mathbf{b}_0 = (0, 0)$，所以 $\mathbf{b}_0 = (1, -2, 1)$ 的最小二乘解是零。

他念完这道题就收了，说一个小时只能做这么多，考试有三个小时。

如果你是从第 1 讲一路跟下来的，到这里 35 篇就结束了。接下来可以去看 Strang 的另一门课 [18.065](https://www.youtube.com/playlist?list=PLUl4u3cNGP63oMNUHXqIUcrkS2PivhN3k)（Matrix Methods in Data Analysis, Signal Processing, and Machine Learning），它默认你已经学过 18.06，SVD、低秩近似和优化会用得更多。以前我看到 $A\mathbf{x} = \mathbf{b}$ 只会想到“解”，现在想到的是“列的组合”，这个变化，大概是这个系列最大的收获。
