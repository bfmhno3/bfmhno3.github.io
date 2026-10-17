---
title: "18.06 第 22 讲：对角化与矩阵的幂"
commentId: "post:linear-algebra-22-diagonalization-powers"
published: "2026-10-18 15:00:00 +08:00"
description: "MIT 18.06 第 22 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 把 A = SΛS⁻¹ 用在 Fibonacci 的 2 × 2 矩阵上，靠两个特征值直接算出第 100 项，和 Python 整数精确值的相对误差只有 3.33e-15。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 对角化
  - 矩阵的幂
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 22
draft: false
comment: true
slug: linear-algebra-22-diagonalization-powers
---

上一讲找到了 $A\mathbf{x} = \lambda\mathbf{x}$，这一讲回答“找到之后拿它干什么”：把特征向量排成矩阵 $S$，$A$ 就被拆成 $S\Lambda S^{-1}$，乘一百次 $A$ 变成只对对角线上的几个数做一百次方。我拿 Fibonacci 的 2 × 2 矩阵试了一下，两个特征值算出的 $F_{100}$ 是 $3.542248 \times 10^{20}$，和 Python 整数迭代的精确值只差 $3.33 \times 10^{-15}$（相对误差），而这个精确值有 21 位。

> [!NOTE] 本讲速览
> 视频：[Lecture 22: Diagonalization and powers of A](https://www.youtube.com/watch?v=13r9QY6cmjc)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-22-diagonalization-and-powers-of-a/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §6.2 Diagonalizing a Matrix
> 前置：[第 21 讲：特征值与特征向量](/posts/linear-algebra-21-eigenvalues-eigenvectors/)
> 一句话：有 $n$ 个线性无关的特征向量时 $A = S\Lambda S^{-1}$，于是 $A^k = S\Lambda^k S^{-1}$，$A$ 的幂是增长还是衰减，只看特征值的绝对值是否小于 1。

> [!TIP] 配合视频
> - 开头 $AS = S\Lambda$ 的那段推导要认真看：他逐列算 $AS$，再把 $\lambda$ 从各列里“剥”到右边，是矩阵乘法“按列算”这个看法最漂亮的一次应用。
> - $A^2$、$A^k$ 的特征值那一段很短，本篇第一个代码块已经算过，倍速即可。
> - 讲“哪些矩阵不能对角化”的那段值得听完：他用 $\begin{bmatrix} 2 & 1 \\ 0 & 2 \end{bmatrix}$ 区分代数重数和几何重数，下面第三节用代码重现了。
> - Fibonacci 例子是全讲的重点，从“把二阶问题变成一阶方程组”的小技巧到特征值估计增长率都在里面。他最后没有把公式算完，只留下一句“思想最重要”，我在第四节替他算完。

## 从 $AS = S\Lambda$ 到 $A = S\Lambda S^{-1}$

假设 $A$ 有 $n$ 个线性无关的特征向量 $\mathbf{x}_1, \dots, \mathbf{x}_n$，把它们放进 $S$ 的各列。**$AS$ 等于什么？** 按列算：$A$ 乘第 $j$ 列得到 $A\mathbf{x}_j = \lambda_j\mathbf{x}_j$，所以

$$
AS = A\begin{bmatrix} \mathbf{x}_1 & \cdots & \mathbf{x}_n \end{bmatrix}
= \begin{bmatrix} \lambda_1\mathbf{x}_1 & \cdots & \lambda_n\mathbf{x}_n \end{bmatrix}
= \begin{bmatrix} \mathbf{x}_1 & \cdots & \mathbf{x}_n \end{bmatrix}
\begin{bmatrix} \lambda_1 & & \\ & \ddots & \\ & & \lambda_n \end{bmatrix}
= S\Lambda
$$

倒数第二步是第 3 讲的“按列乘”：想让数 $\lambda_j$ 去乘第 $j$ 列，就把它放在右边那个矩阵的第 $j$ 列的第 $j$ 个位置上。$\Lambda$ 是大写的 lambda，对角线上放特征值。

因为有 $n$ 个线性无关的特征向量，$S$ 可逆，两边可以乘 $S^{-1}$：

$$
S^{-1}AS = \Lambda, \qquad A = S\Lambda S^{-1}
$$

Strang 说这是继消元的 $A = LU$、Gram-Schmidt 的 $A = QR$ 之后的第三种分解，整章都会看到“一个 $S$ 夹着一个 $S^{-1}$”的形状。他还教了一个记法：$A$ 乘的是 $S$（特征向量），所以 $A$ 写在 $S$ 的左边；$S^{-1}$ 放在右边把整件事变对角。

**好处在哪？** 平方一下就看到了：

$$
A^2 = S\Lambda S^{-1}\,S\Lambda S^{-1} = S\Lambda^2 S^{-1}
$$

中间的 $S^{-1}S$ 抵消成单位矩阵。$A^2$ 的特征向量还是 $S$ 的列，特征值是 $\lambda^2$（他用另一个更短的推导也得到这个结论：$A\mathbf{x} = \lambda\mathbf{x}$ 两边再乘一次 $A$，得到 $A^2\mathbf{x} = \lambda^2\mathbf{x}$）。推广到 $k$ 次：

$$
A^k = S\Lambda^k S^{-1}
$$

他对比了 $LU$：$A = LU$ 自乘一百次，是一百个 $LU$ 排成一排，什么也化简不了；而 $S\Lambda S^{-1}$ 自乘一百次，中间九十九对 $S^{-1}S$ 全部抵消。这是 $LU$ 不具备的能力。

下面用一个我自己挑的 2 × 2 矩阵 $A = \begin{bmatrix} 4 & 1 \\ 2 & 3 \end{bmatrix}$ 验证（字幕里这一段没有具体数字。我挑它的理由很不浪漫：特征值是整数 5 和 2，手算也能核对）：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[4.0, 1.0], [2.0, 3.0]])

    # 特征向量放进 S 的列，特征值放进对角阵 Lam
    eigenvalues, S = np.linalg.eig(A)
    Lam = np.diag(eigenvalues)
    print("特征值：", eigenvalues)
    print("S =\n", S)
    print("A @ S 等于 S @ Lam：", np.allclose(A @ S, S @ Lam))
    print("inv(S) @ A @ S =\n", np.linalg.inv(S) @ A @ S)

    # A^k = S Lam^k S^{-1}：只有对角线上的数在做 k 次方
    k = 10
    Ak = S @ np.diag(eigenvalues**k) @ np.linalg.inv(S)
    print("A^10 =\n", Ak)
    print(
        "和 matrix_power 一致：", np.allclose(Ak, np.linalg.matrix_power(A, k))
    )

    # A^2 的特征值是平方，特征向量不变
    values_sq, _ = np.linalg.eig(A @ A)
    print("A^2 的特征值：", np.sort(values_sq))
    print("A 的特征值平方：", np.sort(eigenvalues**2))


if __name__ == "__main__":
    main()
```

```text
特征值： [5. 2.]
S =
 [[ 0.7071 -0.4472]
 [ 0.7071  0.8944]]
A @ S 等于 S @ Lam： True
inv(S) @ A @ S =
 [[ 5. -0.]
 [ 0.  2.]]
A^10 =
 [[6510758. 3254867.]
 [6509734. 3255891.]]
和 matrix_power 一致： True
A^2 的特征值： [ 4. 25.]
A 的特征值平方： [ 4. 25.]
```

四件事都对上了。`A @ S` 等于 `S @ Lam`，`inv(S) @ A @ S` 是对角阵（$-0.$ 是浮点数里的负零，不是错误）。$A^{10}$ 用 $S\Lambda^{10}S^{-1}$ 算出来，和 `np.linalg.matrix_power` 一致，而前者只对两个数 $5$ 和 $2$ 做了十次方。最后两行是 $A^2$ 的特征值 $[4, 25]$，正好是 $A$ 的特征值 $[5, 2]$ 的平方。

`np.linalg.eig` 返回的特征向量已经单位化（第一列 $(0.7071, 0.7071)$ 就是 $(1, 1)/\sqrt{2}$），所以 $S$ 的列长度都是 1。特征向量可以随意缩放，$S\Lambda S^{-1}$ 不受影响。

## 稳定：幂什么时候趋于零

**$A^k$ 会不会趋于零？** 这个信息不在主元里（$LU$ 的主元对此无话可说），而在特征值里。$A^k = S\Lambda^kS^{-1}$ 中 $S$ 和 $S^{-1}$ 不动，只有 $\Lambda^k$ 在变，对角线上是 $\lambda_1^k, \dots, \lambda_n^k$。所以

$$
A^k \to 0 \iff \text{所有 } |\lambda_i| < 1
$$

他特意写了绝对值：特征值可以是负数，也可以是复数，取的是模。他同时提醒，这个推导用了 $S$ 可逆的前提，没有 $n$ 个特征向量的矩阵这里没有证。（据我所知，结论对那些矩阵依然成立，要靠后面的 Jordan 形式，第 28 讲再说。）

我想试试“看特征值，不看矩阵的元素”到底有多可靠，于是造了一个元素很大但特征值很小的矩阵，和一个元素温和但有一个特征值超过 1 的矩阵：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 两个矩阵，一个特征值都小于 1，一个有 1.1
    stable = np.array([[0.9, 5.0], [0.0, 0.5]])
    unstable = np.array([[1.1, 0.0], [0.0, 0.1]])
    for name, A in [("stable", stable), ("unstable", unstable)]:
        values = np.linalg.eigvals(A)
        print(name, "特征值：", values, "，最大模：", np.abs(values).max())
        for k in [1, 10, 50, 100, 200]:
            norm = np.linalg.norm(np.linalg.matrix_power(A, k), 2)
            print(f"  k = {k:3d}，||A^k|| = {norm:.4e}")

    # 稳定的那个先涨后落：看过程中范数的峰值
    norms = [
        np.linalg.norm(np.linalg.matrix_power(stable, k), 2)
        for k in range(1, 201)
    ]
    peak = int(np.argmax(norms)) + 1
    print("stable 的范数峰值：", f"{max(norms):.4f}", "，出现在 k =", peak)


if __name__ == "__main__":
    main()
```

```text
stable 特征值： [0.9 0.5] ，最大模： 0.9
  k =   1，||A^k|| = 5.1041e+00
  k =  10，||A^k|| = 4.3602e+00
  k =  50，||A^k|| = 6.4628e-02
  k = 100，||A^k|| = 3.3308e-04
  k = 200，||A^k|| = 8.8470e-09
unstable 特征值： [1.1 0.1] ，最大模： 1.1
  k =   1，||A^k|| = 1.1000e+00
  k =  10，||A^k|| = 2.5937e+00
  k =  50，||A^k|| = 1.1739e+02
  k = 100，||A^k|| = 1.3781e+04
  k = 200，||A^k|| = 1.8991e+08
stable 的范数峰值： 7.5861 ，出现在 k = 3
```

`stable` 的两个特征值是 $0.9$ 和 $0.5$，都小于 1，所以 $\|A^k\|$ 最终掉到 $200$ 步后的 $8.8 \times 10^{-9}$。但注意它不是单调下降的：$k = 1$ 时范数是 5.10，$k = 3$ 时涨到峰值 7.59，才开始掉。右上角那个 5 让矩阵先把向量拉长，然后特征值才接管。这是我觉得“稳定”这个词有点误导人的地方：特征值保证最终衰减，不保证每一步都衰减。

`unstable` 的一个特征值是 $1.1$，范数 $k = 10$ 时 2.59，$k = 100$ 时 $1.38 \times 10^4$，$k = 200$ 时 $1.90 \times 10^8$。注意 $1.1^{100} \approx 1.38 \times 10^4$，和输出里的范数吻合：$\|A^k\|$ 几乎就是 $|\lambda_{\max}|^k$。

## 哪些矩阵不能对角化

Strang 在这里讲了三件事，我用三种矩阵对应着做：

1. **特征值互不相同，一定能对角化。** 每个特征值至少带一个特征向量，不同特征值的特征向量自动线性无关（证明在教材里）。他提到用 MATLAB 的 `eig(rand(10))` 取随机矩阵，会得到十个互不相同的特征值。
2. **特征值重复，可能能也可能不能。** 单位矩阵的特征值 $1$ 重复十次，但每个向量都是特征向量，随便挑十个线性无关的就行，$S^{-1}IS = I$ 已经是对角阵。
3. **三角矩阵 $\begin{bmatrix} 2 & 1 \\ 0 & 2 \end{bmatrix}$ 是坏例子。** 特征值是 $2$ 和 $2$（$\det(A - \lambda I) = (2 - \lambda)^2$），但 $A - 2I = \begin{bmatrix} 0 & 1 \\ 0 & 0 \end{bmatrix}$ 的零空间只有一维，特征向量只有 $(1, 0)$ 这一个方向。特征值作为根的重数叫代数重数（这里是 2），特征向量空间的维数叫几何重数（这里是 1），几何重数小于代数重数就不能对角化。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 随机 10 x 10：特征值两两不同，S 可逆
    rng = np.random.default_rng(1806)
    M = rng.standard_normal((10, 10))
    values, V = np.linalg.eig(M)
    gaps = np.abs(values[:, None] - values[None, :]) + np.eye(10)
    print("随机矩阵的最小特征值间距：", f"{gaps.min():.4f}")
    print("S 的秩：", np.linalg.matrix_rank(V))
    print("cond(S) =", f"{np.linalg.cond(V):.1f}")
    rebuilt = V @ np.diag(values) @ np.linalg.inv(V)
    print("重构误差：", f"{np.linalg.norm(rebuilt - M):.2e}")

    # 单位矩阵：特征值 1 重复 10 次，但每个向量都是特征向量
    values, S = np.linalg.eig(np.eye(10))
    print("单位矩阵的特征值：", values[:3], "...")
    print("单位矩阵的 S 的秩：", np.linalg.matrix_rank(S))

    # 三角矩阵 [[2, 1], [0, 2]]：特征值 2 和 2，但只有一个方向
    A = np.array([[2.0, 1.0], [0.0, 2.0]])
    values, S = np.linalg.eig(A)
    print("特征值：", values)
    print("S =\n", S)
    geometric = 2 - np.linalg.matrix_rank(A - 2.0 * np.eye(2))
    print("A - 2I 的零空间维数（几何重数）：", geometric)
    print("S 的秩：", np.linalg.matrix_rank(S))
    print("cond(S) =", f"{np.linalg.cond(S):.2e}")

    # 硬把 S 求逆再重构：得到的是 2I，不是 A
    rebuilt = S @ np.diag(values) @ np.linalg.inv(S)
    print("重构结果：\n", rebuilt)
    print("重构误差：", f"{np.linalg.norm(rebuilt - A):.2e}")


if __name__ == "__main__":
    main()
```

```text
随机矩阵的最小特征值间距： 0.6635
S 的秩： 10
cond(S) = 21.9
重构误差： 1.77e-14
单位矩阵的特征值： [1. 1. 1.] ...
单位矩阵的 S 的秩： 10
特征值： [2. 2.]
S =
 [[ 1. -1.]
 [ 0.  0.]]
A - 2I 的零空间维数（几何重数）： 1
S 的秩： 1
cond(S) = 4.50e+15
重构结果：
 [[2. 0.]
 [0. 2.]]
重构误差： 1.00e+00
```

随机的 $10 \times 10$ 矩阵：最小的特征值间距是 0.6635，特征值确实互不相同；$S$ 的秩是 10，条件数 21.9，用 $S\Lambda S^{-1}$ 重构回原矩阵的误差是 $1.77 \times 10^{-14}$。（实矩阵的特征值可以是复数，这里 $S$ 是复矩阵，NumPy 自动处理了。）

单位矩阵的 `eig` 给出的 $S$ 秩为 10，没有任何问题。

问题出在 $\begin{bmatrix} 2 & 1 \\ 0 & 2 \end{bmatrix}$ 上。几何重数是 1，`eig` 还是交了两列：$(1, 0)$ 和 $(-1, 0)$，它们平行，$S$ 的秩是 1，条件数 $4.50 \times 10^{15}$（大约就是 $1/\varepsilon$，数值上和奇异没有区别）。硬着头皮把 $S$ 求逆再重构，得到的是 $2I$ 而不是 $A$，误差范数恰好是 1.00：$\Lambda = 2I$ 夹在任何可逆的 $S$ 之间都还是 $2I$，所以不可能还原出右上角那个 1。

这和第 21 讲的零空间是同一件事：特征向量是 $A - \lambda I$ 的零空间，零空间太小，特征向量就凑不够。

## Fibonacci：幂的一个实际用处

这是他在课上做的例子，也是全讲最值钱的地方。Fibonacci 数 $0, 1, 1, 2, 3, 5, 8, 13, \dots$ 满足 $F_{k+2} = F_{k+1} + F_k$。问题是：第 100 个是多少？它们增长得多快？

这不是 $\mathbf{u}_{k+1} = A\mathbf{u}_k$ 的形状，它是二阶的标量方程。他用一个小技巧把它变成一阶方程组：令 $\mathbf{u}_k = (F_{k+1}, F_k)$，补一个平凡的方程 $F_{k+1} = F_{k+1}$，

$$
\begin{bmatrix} F_{k+2} \\ F_{k+1} \end{bmatrix}
= \begin{bmatrix} 1 & 1 \\ 1 & 0 \end{bmatrix}
\begin{bmatrix} F_{k+1} \\ F_k \end{bmatrix},
\qquad \mathbf{u}_0 = \begin{bmatrix} F_1 \\ F_0 \end{bmatrix} = \begin{bmatrix} 1 \\ 0 \end{bmatrix}
$$

于是 $\mathbf{u}_k = A^k\mathbf{u}_0$，第二个分量就是 $F_k$。他说“这就是最紧凑的公式”，但要真的算出 $\mathbf{u}_{100}$ 就得靠特征值。

他手算 $\det(A - \lambda I) = \lambda^2 - \lambda - 1$（和递推式本身长得一模一样），再用求根公式：

$$
\lambda_1 = \frac{1 + \sqrt{5}}{2} \approx 1.618, \qquad
\lambda_2 = \frac{1 - \sqrt{5}}{2} \approx -0.618
$$

他先用迹和行列式核对：$\lambda_1 + \lambda_2 = 1$（迹），$\lambda_1\lambda_2 = -1$（行列式）。他还顺口说 $A$ 是对称矩阵，所以特征值是实数、特征向量正交，这个等第 25 讲。特征向量他用 $2 \times 2$ 的小技巧：$(A - \lambda I)\mathbf{x} = 0$ 的第二行是 $x_1 - \lambda x_2 = 0$，所以 $\mathbf{x} = (\lambda, 1)$。

然后是这一讲的思想：**把 $\mathbf{u}_0$ 写成特征向量的组合 $\mathbf{u}_0 = c_1\mathbf{x}_1 + c_2\mathbf{x}_2$**，每一块各走各的：

$$
\mathbf{u}_k = c_1\lambda_1^k\mathbf{x}_1 + c_2\lambda_2^k\mathbf{x}_2
= S\Lambda^k\mathbf{c}, \qquad \mathbf{c} = S^{-1}\mathbf{u}_0
$$

$|\lambda_1| > 1 > |\lambda_2|$，所以第一块越来越大，第二块越来越小，增长率由大特征值 $1.618$ 决定。下面我替他把这个算完，并和精确值对照：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[1.0, 1.0], [1.0, 0.0]])
    u0 = np.array([1.0, 0.0])  # (F1, F0)

    values, S = np.linalg.eig(A)
    print("特征值：", values)
    print("迹 =", np.trace(A), "，和 =", values.sum())
    print("行列式 =", np.linalg.det(A), "，积 =", values.prod())
    golden = (1 + np.sqrt(5)) / 2
    print("(1 + sqrt(5)) / 2 =", golden)

    # 把 u0 写成特征向量的组合：u0 = S c
    c = np.linalg.solve(S, u0)
    print("c =", c)

    # u_k = S Lam^k c，第二个分量就是 F_k
    k = 100
    u = S @ (values**k * c)
    print("用特征值算的 F100 =", f"{u[1]:.6e}")

    # 用 Python 整数精确迭代作对照
    a, b = 0, 1  # F0, F1
    for _ in range(k):
        a, b = b, a + b
    print("精确的 F100 =", a)
    print("相对误差：", f"{abs(u[1] - a) / a:.2e}")

    # 只留大特征值那一项，再四舍五入
    approx = golden**k / np.sqrt(5)
    print("只用 lambda1^100 / sqrt(5) =", f"{approx:.6e}")
    print("第二个特征值的 100 次方：", f"{values.min() ** k:.2e}")


if __name__ == "__main__":
    main()
```

```text
特征值： [ 1.618 -0.618]
迹 = 1.0 ，和 = 1.0
行列式 = -1.0 ，积 = -0.9999999999999999
(1 + sqrt(5)) / 2 = 1.618033988749895
c = [ 0.8507 -0.5257]
用特征值算的 F100 = 3.542248e+20
精确的 F100 = 354224848179261915075
相对误差： 3.33e-15
只用 lambda1^100 / sqrt(5) = 3.542248e+20
第二个特征值的 100 次方： 1.26e-21
```

特征值是 $1.618$ 和 $-0.618$，和为 1、积为 $-1$（浮点里是 $-0.9999999999999999$）。系数 $\mathbf{c} = (0.8507, -0.5257)$ 是因为 `eig` 把特征向量单位化了，不是教材里常见的 $1/\sqrt{5}$（对应未单位化的 $(\lambda, 1)$）。

$F_{100}$ 用 $S\Lambda^{100}\mathbf{c}$ 算出来是 $3.542248 \times 10^{20}$，精确值是 $354224848179261915075$，相对误差 $3.33 \times 10^{-15}$。双精度大约只有 16 位有效数字，$F_{100}$ 有 21 位，所以最后几位是对不上的，但前 15 位全对。只留 $\lambda_1^{100}/\sqrt{5}$ 这一项的结果也是 $3.542248 \times 10^{20}$。第二项 $\lambda_2^{100}$ 只有 $1.26 \times 10^{-21}$，比第一项小 41 个数量级，在这个尺度上等于没有。

这解释了为什么他说“$F_{100}$ 大约是 $c_1\lambda_1^{100}$”。更具体地看增长率和四舍五入公式：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[1.0, 1.0], [1.0, 0.0]])
    u = np.array([1.0, 0.0])  # (F1, F0)
    golden = (1 + np.sqrt(5)) / 2

    # 一步一步乘 A：看增长率逼近 lambda1，以及何时四舍五入失效
    print(" k   F_k   F_{k+1}/F_k")
    exact = [0, 1]
    for k in range(1, 41):
        u = A @ u
        exact.append(exact[-1] + exact[-2])
        if k in (1, 2, 5, 10, 20, 40):
            print(f"{k:2d} {int(exact[k]):9d}   {u[0] / u[1]:.10f}")
    print("lambda1 =", f"{golden:.10f}")

    # F_k = round(lambda1^k / sqrt(5)) 能撑到多大的 k
    bad = 0
    for k in range(2, 80):
        guess = round(golden**k / np.sqrt(5))
        if k >= len(exact):
            exact.append(exact[-1] + exact[-2])
        if guess != exact[k]:
            bad = k
            break
    print("四舍五入公式第一次出错的 k：", bad)


if __name__ == "__main__":
    main()
```

```text
 k   F_k   F_{k+1}/F_k
 1         1   1.0000000000
 2         1   2.0000000000
 5         5   1.6000000000
10        55   1.6181818182
20      6765   1.6180339985
40 102334155   1.6180339887
lambda1 = 1.6180339887
四舍五入公式第一次出错的 k： 71
```

$F_{k+1}/F_k$ 从 $k = 2$ 的 2.0 开始，$k = 10$ 时 1.6181818182，$k = 20$ 时 1.6180339985，$k = 40$ 时 1.6180339887，已经和 $\lambda_1 = 1.6180339887$ 在十位小数上一致了。不到 40 步，增长率就被特征值锁定了。

因为 $\lambda_2^k/\sqrt{5}$ 小于 $1/2$，把 $\lambda_1^k/\sqrt{5}$ 四舍五入就是 $F_k$（课上没讲这句，教材里有）。这个公式在双精度下能撑到 $k = 70$，$k = 71$ 开始失败：$F_{71}$ 已经是 15 位数，我猜是 `golden**k` 的浮点误差已经接近 0.5 了，没有进一步验证。（顺便一提，这是个很好的例子：数学上严格成立的公式，在浮点里有保质期。）

他把整件事总结成一句话：当系统按一阶方程 $\mathbf{u}_{k+1} = A\mathbf{u}_k$ 演化，特征值已经告诉你解是爆炸还是衰减，要精确公式就把 $\mathbf{u}_0$ 展开成特征向量的组合，让每一块各走各的。下一讲就是它在连续时间的版本，$\mathrm{d}\mathbf{u}/\mathrm{d}t = A\mathbf{u}$。

## 在控制里

离散时间系统 $\mathbf{x}[k+1] = A\mathbf{x}[k]$ 就是这一讲的 $\mathbf{u}_{k+1} = A\mathbf{u}_k$，只是名字不同。第二节的结论原样搬过来：状态趋于零，当且仅当 $A$ 的所有特征值落在单位圆内，$|\lambda_i| < 1$。这个判据在控制里叫“极点在单位圆内”。

连续系统的 PID 离散化之后（见 [PID 控制 04：离散化](/posts/pid-control-04-discretization/)），闭环极点从 $s$ 平面的左半平面变成 $z$ 平面的单位圆内部，判断稳定性的方法就是算特征值的模。第二节 `stable` 矩阵的那个先涨后落的峰值也值得记住：极点都在圆内只保证最终收敛，过程里状态可以先冲到初值的好几倍（那个例子里范数峰值是 7.59，初值 1），实际系统里这是超调，不是错误。

## 下一步

这一讲处理的是 $\mathbf{u}_{k+1} = A\mathbf{u}_k$，一步一步走。如果时间是连续的，$\mathrm{d}\mathbf{u}/\mathrm{d}t = A\mathbf{u}$，每个特征向量的系数就不是 $\lambda^k$，而是 $e^{\lambda t}$，$A^k$ 也变成矩阵指数 $e^{At}$。同样的 $S\Lambda S^{-1}$，换一个函数。见 [18.06 第 23 讲：微分方程与 exp(At)](/posts/linear-algebra-23-differential-equations-exp-at/)。
