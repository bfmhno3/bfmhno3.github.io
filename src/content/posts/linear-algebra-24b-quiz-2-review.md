---
title: "18.06 第 24b 讲：第二次测验复习"
commentId: "post:linear-algebra-24b-quiz-2-review"
published: "2026-10-18 16:00:00 +08:00"
description: "MIT 18.06 第 24b 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 把 Strang 在复习课上讲的 1984 年期中题与 1992 年期末题逐题重算了一遍，三对角行列式的递推矩阵 M 的六次幂恰好是单位矩阵，4 阶那个矩阵的行列式是 9。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 测验复习
  - 投影与特征值
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 25
draft: false
comment: true
slug: linear-algebra-24b-quiz-2-review
---

这一讲没有新东西，Strang 拿两份旧试卷（1984 年的期中，1992 年的期末）把第四到六章串了一遍：投影、最小二乘、Gram-Schmidt、行列式、特征值。我把他黑板上的每道题都交给 NumPy 重算，最有意思的两个结果是：一个投影矩阵作用一次之后，迭代 $\mathbf{u}_{k+1} = P\mathbf{u}_k$ 就再也不动了，停在 $(6, 3, 6)$；一个看起来像 Fibonacci 的递推，递推矩阵的六次幂恰好是单位矩阵，周期是 6。

> [!NOTE] 本讲速览
> 视频：[Lecture 24b: Quiz 2 review](https://www.youtube.com/watch?v=QuZL5IKpO_U)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-24b-quiz-2-review/)）
> 教材：《Introduction to Linear Algebra》第 6 版 第 4 到 6 章
> 前置：[第 24 讲：Markov 矩阵与 Fourier 级数](/posts/linear-algebra-24-markov-fourier/)
> 一句话：投影矩阵、特征值、行列式和差分方程不是四个话题，而是同一个矩阵的四种问法，一道题常常把它们连着问。

> [!TIP] 配合视频
> - 开头几分钟他把第二部分的内容列了一遍（$Q^TQ = I$、投影、最小二乘、Gram-Schmidt，行列式的十条性质，特征值与矩阵的幂）。这一段值得听，它是一份考点清单，也是本篇小节顺序的依据。
> - 投影、拟合直线和 Gram-Schmidt 三题他讲得很快，本篇都用代码算过，可以倍速。但“最小二乘有两幅图”的那一段要认真听：一幅在 $t$-$y$ 平面里，一幅在 $\mathbf{b}$ 所在的空间里。
> - 行列式递推那一题（从余子式到一阶系统，再到复特征值）是整堂课的重头戏，值得完整看一遍。
> - 结尾他猜“奇数阶的奇异，偶数阶的可逆”，本篇最后一节用代码验证了。

## 先看清考什么

开头他把范围列得很清楚。第四章是正交：$Q$ 的列是标准正交向量，写成矩阵语言就是 $Q^TQ = I$；然后是投影到直线和子空间，用投影解无解的 $A\mathbf{x} = \mathbf{b}$（最小二乘），最后是 Gram-Schmidt，把一组无关向量变成标准正交基。第五章是行列式：性质 1 到 3 定义了行列式，性质 4 到 10 是推论，再加上有 $n!$ 项的大公式、余子式公式，以及由此得到的逆矩阵公式。第六章只考到 6.1 和 6.2，也就是特征值、$A\mathbf{x} = \lambda\mathbf{x}$ 的机械步骤、对角化与矩阵的幂。微分方程（教材第 6 版 §6.5，对应视频里说的 6.3）留给第三次测验。

他说他复习的办法一般是拿一份旧试卷，挑出有代表性的题，边写边讲。这份试卷是 1984 年 11 月的，“那时候连 Web 都没有”。我就按他黑板上的顺序走。（这篇没有新定理，我的贡献是把他心算的几十个数交给 NumPy 再核对一遍，相当于给黑板配了一台计算器。）

## 投影矩阵、特征值和差分方程

第一题给了 $\mathbf{a} = (2, 1, 2)$，求投影到过 $\mathbf{a}$ 的直线上的矩阵 $P$。直线情形下一般公式 $A(A^TA)^{-1}A^T$ 里的 $A$ 只有一列，$A^TA$ 是一个数 $\mathbf{a}^T\mathbf{a} = 9$，所以

$$
P = \frac{\mathbf{a}\mathbf{a}^T}{\mathbf{a}^T\mathbf{a}}
= \frac{1}{9}
\begin{bmatrix} 4 & 2 & 4 \\ 2 & 1 & 2 \\ 4 & 2 & 4 \end{bmatrix}
$$

接着他一路追问：秩是多少？列空间是什么？特征值是什么？答案分别是 1、这条直线、$0, 0, 1$。秩 1 意味着零空间是二维的，所以特征值 0 重复两次；第三个特征值从迹得到，$\operatorname{tr} P = 9/9 = 1$；特征值 1 对应的特征向量是 $\mathbf{a}$ 本身，因为 $P\mathbf{a} = \mathbf{a}$（不动的向量）。

最后一问是解 $\mathbf{u}_{k+1} = P\mathbf{u}_k$，$\mathbf{u}_0 = (9, 9, 0)$。他直接算 $\mathbf{u}_1 = P\mathbf{u}_0$：$\mathbf{a}^T\mathbf{u}_0 = 27$，除以 $\mathbf{a}^T\mathbf{a} = 9$ 得 3，所以 $\mathbf{u}_1 = 3\mathbf{a} = (6, 3, 6)$。已经在直线上的点再投影一次不会动，所以 $\mathbf{u}_k$ 全是 $(6, 3, 6)$。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    a = np.array([2.0, 1.0, 2.0])
    P = np.outer(a, a) / (a @ a)
    print("9 P =")
    print(9 * P)
    print("P @ P == P：", np.allclose(P @ P, P))
    print("P.T == P：", np.allclose(P.T, P))
    print("秩：", np.linalg.matrix_rank(P), "，迹：", np.trace(P))

    # 特征值：两个 0 和一个 1，特征值 1 的特征向量是 a 本身
    print("特征值：", np.sort(np.linalg.eigvalsh(P)).round(8) + 0.0)
    print("P @ a =", P @ a)

    # 差分方程 u(k+1) = P u(k)，u0 = (9, 9, 0)
    u0 = np.array([9.0, 9.0, 0.0])
    u = u0
    for k in range(1, 4):
        u = P @ u
        print(f"u{k} =", u)

    # 对照：直接算 P^10 @ u0
    print("P^10 @ u0 =", np.linalg.matrix_power(P, 10) @ u0)


if __name__ == "__main__":
    main()
```

```text
9 P =
[[4. 2. 4.]
 [2. 1. 2.]
 [4. 2. 4.]]
P @ P == P： True
P.T == P： True
秩： 1 ，迹： 1.0
特征值： [0. 0. 1.]
P @ a = [2. 1. 2.]
u1 = [6. 3. 6.]
u2 = [6. 3. 6.]
u3 = [6. 3. 6.]
P^10 @ u0 = [6. 3. 6.]
```

输出里最要紧的是 $\mathbf{u}_1$ 到 $\mathbf{u}_3$ 完全一样，和直接算 $P^{10}\mathbf{u}_0$ 的结果也一样。对投影矩阵来说 $P^2 = P$，所以不用做特征分解。他特意提醒：考试里这道题很可能换成一个不是投影的矩阵，那时就老老实实走三步，找特征值、找特征向量、解出 $\mathbf{u}_0 = c_1\mathbf{x}_1 + c_2\mathbf{x}_2 + c_3\mathbf{x}_3$ 里的系数 $c_i$，然后 $\mathbf{u}_k = c_1\lambda_1^k\mathbf{x}_1 + \cdots$。投影矩阵的两个 0 特征值把另外两项直接扔掉，只剩 $c_3\mathbf{x}_3$。

## 过原点的直线与 Gram-Schmidt

第二题拟合经过原点的直线 $y = Dt$，三个点是 $(1, 4)$、$(2, 5)$、$(3, 8)$。只有一个未知数 $D$，所以 $A$ 只有一列：

$$
\begin{bmatrix} 1 \\ 2 \\ 3 \end{bmatrix} D
= \begin{bmatrix} 4 \\ 5 \\ 8 \end{bmatrix}
$$

正规方程 $A^TA\hat{D} = A^T\mathbf{b}$ 是 $14\hat{D} = 38$，所以 $\hat{D} = 38/14 \approx 2.7143$。他接着问了一个我觉得最像考试陷阱的问题：刚才到底把什么向量投影到了什么上面？答案是，在 $t$-$y$ 平面的那张图里什么都没有被投影；投影发生在 $\mathbf{b}$ 所在的三维空间里，把 $\mathbf{b}$ 投到 $A$ 的列空间（这里是一条线）上。

同一道大题的最后一问是 Gram-Schmidt：$\mathbf{a}_1 = (1, 2, 3)$，$\mathbf{a}_2 = (1, 1, 1)$，找这个平面里两个正交的向量。保留 $\mathbf{a}_1$，把 $\mathbf{a}_2$ 里沿 $\mathbf{a}_1$ 的部分减掉：$\mathbf{B} = \mathbf{a}_2 - \frac{6}{14}\mathbf{a}_1$。题目只要正交，不要单位化，所以不用开方。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 过原点的直线 y = D t，三个点 (1, 4)、(2, 5)、(3, 8)
    A = np.array([[1.0], [2.0], [3.0]])
    b = np.array([4.0, 5.0, 8.0])
    AtA = (A.T @ A)[0, 0]
    Atb = (A.T @ b)[0]
    D = Atb / AtA
    print("AᵀA =", AtA, "，Aᵀb =", Atb)
    print(f"D = 38/14 = {D:.4f}，{np.isclose(D, 38 / 14)}")

    x, *_ = np.linalg.lstsq(A, b, rcond=None)
    print(f"lstsq 的 D = {x[0]:.4f}，一致：{np.allclose(x[0], D)}")

    # 投影图：b 投影到 A 的列空间，误差与列空间正交
    p = A[:, 0] * D
    e = b - p
    print("p =", p)
    print("e =", e)
    print("Aᵀe 为零：", np.allclose(A.T @ e, 0.0))

    # Gram-Schmidt：a1 = (1, 2, 3)，a2 = (1, 1, 1)
    a1 = np.array([1.0, 2.0, 3.0])
    a2 = np.array([1.0, 1.0, 1.0])
    B = a2 - (a1 @ a2) / (a1 @ a1) * a1
    print("a1ᵀa2 =", a1 @ a2, "，a1ᵀa1 =", a1 @ a1)
    print("14 B =", 14 * B)
    print("a1 与 B 正交：", np.isclose(a1 @ B, 0.0))

    # 对照 np.linalg.qr：单位化之后，两组向量最多差一个符号
    Q, _ = np.linalg.qr(np.column_stack([a1, a2]))
    mine = np.column_stack([a1 / np.linalg.norm(a1), B / np.linalg.norm(B)])
    print("与 qr 一致：", np.allclose(np.abs(Q), np.abs(mine)))


if __name__ == "__main__":
    main()
```

```text
AᵀA = 14.0 ，Aᵀb = 38.0
D = 38/14 = 2.7143，True
lstsq 的 D = 2.7143，一致：True
p = [2.7143 5.4286 8.1429]
e = [ 1.2857 -0.4286 -0.1429]
Aᵀe 为零： True
a1ᵀa2 = 6.0 ，a1ᵀa1 = 14.0
14 B = [ 8.  2. -4.]
a1 与 B 正交： True
与 qr 一致： True
```

$14\mathbf{B} = (8, 2, -4)$，也就是 $\mathbf{B} = (4, 1, -2)/7$。$\mathbf{B}$ 与 $\mathbf{a}_1$ 正交，单位化之后和 `np.linalg.qr` 给出的两列在符号之外一致（QR 的符号取决于实现，所以我比较的是绝对值）。顺带验证了拟合的误差 $\mathbf{e} = \mathbf{b} - \mathbf{p}$ 与列空间垂直。

## 特征值的几条“白送”的性质

第三题是一个 $4 \times 4$ 矩阵 $A$，特征值是 $\lambda_1, \ldots, \lambda_4$，问三件事：

- $A$ 可逆的条件？没有零特征值（零特征值就是零空间里有非零向量）。
- $\det A^{-1}$？$A^{-1}$ 的特征值是 $1/\lambda_i$，行列式是它们的积，即 $1/(\lambda_1\lambda_2\lambda_3\lambda_4)$。
- $\operatorname{tr}(A + I)$？$A + I$ 的特征值是 $\lambda_i + 1$，迹是它们的和，即 $\lambda_1 + \lambda_2 + \lambda_3 + \lambda_4 + 4$。

他没有给矩阵，所以我自己造一个：取特征值 $2, -1, 0.5, 3$，用 $A = S\Lambda S^{-1}$（$S$ 是随机矩阵）造出来，再逐条核对。

```python
import numpy as np


def main() -> None:
    rng = np.random.default_rng(1806)

    # 构造一个特征值已知的 4 x 4 矩阵 A = S diag(lam) S^-1
    lam = np.array([2.0, -1.0, 0.5, 3.0])
    S = rng.standard_normal((4, 4))
    A = S @ np.diag(lam) @ np.linalg.inv(S)
    eigs = np.sort(np.linalg.eigvals(A).real)
    print("特征值：", np.round(eigs, 4))

    # 可逆当且仅当没有零特征值；det A 是特征值之积
    print(f"det A = {np.linalg.det(A):.4f}，积 = {np.prod(lam):.4f}")
    # A 的逆的行列式是 1 / (λ1 λ2 λ3 λ4)
    det_inv = np.linalg.det(np.linalg.inv(A))
    print(f"det A⁻¹ = {det_inv:.4f}，1/积 = {1 / np.prod(lam):.4f}")
    # A + I 的迹等于特征值之和再加 4
    tr = np.trace(A + np.eye(4))
    print(f"tr(A + I) = {tr:.4f}，和 + 4 = {lam.sum() + 4:.4f}")

    # 反过来：有一个特征值是 0 的矩阵不可逆
    lam0 = np.array([2.0, -1.0, 0.0, 3.0])
    B = S @ np.diag(lam0) @ np.linalg.inv(S)
    print("含 0 特征值的矩阵：秩 =", np.linalg.matrix_rank(B))
    print(f"det = {np.linalg.det(B):.1e}")


if __name__ == "__main__":
    main()
```

```text
特征值： [-1.   0.5  2.   3. ]
det A = -3.0000，积 = -3.0000
det A⁻¹ = -0.3333，1/积 = -0.3333
tr(A + I) = 8.5000，和 + 4 = 8.5000
含 0 特征值的矩阵：秩 = 3
det = -1.9e-15
```

$\det A = -3$，正是 $2 \times (-1) \times 0.5 \times 3$；$A^{-1}$ 的行列式是 $-1/3$；$\operatorname{tr}(A + I) = 8.5 = (2 - 1 + 0.5 + 3) + 4$。最后两行是反例：把一个特征值换成 0，行列式从 $-3$ 掉到 $-1.9 \times 10^{-15}$，数值上就是 0（它的秩是 3，不是 4，因为这个矩阵可对角化，秩等于非零特征值的个数）。

## 行列式递推：从余子式到周期 6

这是我觉得整堂课最漂亮的一题。$A_n$ 是对角线、上下副对角线全是 1 的三对角矩阵，$D_n = \det A_n$。第一问：用余子式证明 $D_n = a D_{n-1} + b D_{n-2}$，求 $a$、$b$。

他沿第一行展开。第一项是 $1 \cdot D_{n-1}$。第二项是位置 $(1, 2)$ 上的 1，它的余子式要带一个负号；这个子矩阵的第一列只有一个非零元，再按第一列展开，得到 $D_{n-2}$。所以符号叠起来是 $-D_{n-2}$：

$$
D_n = D_{n-1} - D_{n-2},\qquad D_1 = 1,\ D_2 = 0
$$

他提醒这不是 Fibonacci，因为有一个负号。第二问是把二阶递推写成一阶系统，这是第 22 讲里对付 Fibonacci 的老办法：

$$
\begin{bmatrix} D_n \\ D_{n-1} \end{bmatrix}
= \underbrace{\begin{bmatrix} 1 & -1 \\ 1 & 0 \end{bmatrix}}_{M}
\begin{bmatrix} D_{n-1} \\ D_{n-2} \end{bmatrix}
$$

$M$ 的特征方程是 $\lambda^2 - \lambda + 1 = 0$，解是 $\lambda = \frac{1 \pm \sqrt{3}\,i}{2}$。模长：实部平方 $1/4$ 加虚部平方 $3/4$，等于 1，所以它们在单位圆上，$\lambda = e^{\pm i\pi/3}$。稳定吗？既不衰减也不爆炸，绕着圈转。题目还告诉你 $\lambda^6 = 1$，所以 $M^6$ 的特征值都是 1，对角化之后就是单位矩阵：转六步回到出发点。

```python
import numpy as np


def tridiagonal_det(n: int) -> float:
    """对角线、上下副对角线全是 1 的 n 阶矩阵的行列式。"""
    A = np.eye(n) + np.eye(n, k=1) + np.eye(n, k=-1)
    return np.linalg.det(A)


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 递推 D(n) = D(n-1) - D(n-2)，D1 = 1，D2 = 0
    D = [1.0, 0.0]
    for _ in range(10):
        D.append(D[-1] - D[-2])
    print("递推：", np.array(D))
    direct = [tridiagonal_det(n) for n in range(1, 13)]
    print("直接算：", np.array(direct))
    print("一致：", np.allclose(D, direct))

    # 写成一阶系统 (D(n), D(n-1)) = M (D(n-1), D(n-2))
    M = np.array([[1.0, -1.0], [1.0, 0.0]])
    lam = np.linalg.eigvals(M)
    print("特征值：", lam)
    print("模长：", np.abs(lam))
    print("辐角（度）：", np.degrees(np.angle(lam)))
    print("λ^6 全为 1：", np.allclose(lam**6, 1.0))
    M6 = np.linalg.matrix_power(M, 6)
    print("M^6 =")
    print(M6)
    print("M^6 是单位矩阵：", np.allclose(M6, np.eye(2)))


if __name__ == "__main__":
    main()
```

```text
递推： [ 1.  0. -1. -1.  0.  1.  1.  0. -1. -1.  0.  1.]
直接算： [ 1.  0. -1. -1.  0.  1.  1.  0. -1. -1.  0.  1.]
一致： True
特征值： [0.5+0.866j 0.5-0.866j]
模长： [1. 1.]
辐角（度）： [ 60. -60.]
λ^6 全为 1： True
M^6 =
[[1. 0.]
 [0. 1.]]
M^6 是单位矩阵： True
```

递推给出的 $D_1, \ldots, D_{12}$ 是 $1, 0, -1, -1, 0, 1$ 重复两遍，和 `np.linalg.det` 直接算十二个三对角矩阵的结果完全一致。特征值的模长是 1，辐角是 $\pm 60$ 度，$M^6 = I$，全都对得上。（他顺口说出“六次幂是单位矩阵”之后又自嘲，这本来是一道很好的测验题，不该脱口而出。）

## 1992 年期末：一族对称矩阵

后半堂课他换了一份 1992 年的期末卷，很多题围绕同一族矩阵：对角线全是 0，副对角线依次是 $1, 2, 3, \ldots$ 的对称矩阵。$A_3$ 是

$$
A_3 = \begin{bmatrix} 0 & 1 & 0 \\ 1 & 0 & 2 \\ 0 & 2 & 0 \end{bmatrix}
$$

他问的几件事：$A_3$ 奇异还是可逆？第三列是第一列的两倍，所以奇异，列空间是一个平面。求投影到这个平面的矩阵：取前两列做基，套 $B(B^TB)^{-1}B^T$。再求特征值：$\det(A_3 - \lambda I) = -\lambda^3 + 5\lambda$，所以 $\lambda = 0, \pm\sqrt{5}$。他说他不敢不查迹就写下这三个数：迹是 0，三个特征值加起来也是 0。（他也承认，行列式是 0，帮不上忙：如果那个 5 写成了 4，迹和行列式都抓不出来。）

最后是 $A_4$ 的列空间上的投影矩阵，题目旁边写着“不难”。如果 $A_4$ 可逆，列空间就是 $\mathbb{R}^4$，投影矩阵就是 $4 \times 4$ 的单位矩阵，确实不难。可逆吗？沿第一行再沿第一列做两次余子式展开，$\det A_4 = 9$。他于是猜：奇数阶的奇异，偶数阶的可逆。

```python
import numpy as np


def family(n: int) -> np.ndarray:
    """对称矩阵，零对角线，副对角线是 1, 2, ..., n-1。"""
    v = np.arange(1.0, n)
    return np.diag(v, k=1) + np.diag(v, k=-1)


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    A3 = family(3)
    print("A3 =")
    print(A3)
    print("秩：", np.linalg.matrix_rank(A3), "，det =", np.linalg.det(A3))

    # A3 奇异，列空间是平面：取前两列作基，P = B (BᵀB)⁻¹ Bᵀ
    B = A3[:, :2]
    P = B @ np.linalg.inv(B.T @ B) @ B.T
    print("P =")
    print(P)
    print("P @ A3 == A3：", np.allclose(P @ A3, A3))
    print("与 A3 @ pinv(A3) 一致：", np.allclose(P, A3 @ np.linalg.pinv(A3)))

    # 特征值：0 和 ±√5，迹为 0
    print("A3 的特征值：", np.linalg.eigvalsh(A3))
    print("±√5 =", np.sqrt(5.0), "，迹 =", np.trace(A3))

    # A4 的行列式是 9，列空间是 R^4，投影矩阵是单位矩阵。逐阶看行列式
    for n in range(1, 9):
        print(f"det A{n} =", round(np.linalg.det(family(n)), 6))


if __name__ == "__main__":
    main()
```

```text
A3 =
[[0. 1. 0.]
 [1. 0. 2.]
 [0. 2. 0.]]
秩： 2 ，det = 0.0
P =
[[0.2 0.  0.4]
 [0.  1.  0. ]
 [0.4 0.  0.8]]
P @ A3 == A3： True
与 A3 @ pinv(A3) 一致： True
A3 的特征值： [-2.2361  0.      2.2361]
±√5 = 2.23606797749979 ，迹 = 0.0
det A1 = 0.0
det A2 = -1.0
det A3 = 0.0
det A4 = 9.0
det A5 = 0.0
det A6 = -225.0
det A7 = 0.0
det A8 = 11025.0
```

$P$ 的列确实落在平面里（$PA_3 = A_3$），也和 `A3 @ pinv(A3)` 一致；$A_3$ 的特征值 $-2.2361, 0, 2.2361$ 就是 $0$ 和 $\pm\sqrt{5}$；$\det A_4 = 9$。我多算到 $n = 8$：奇数阶行列式全是 0，偶数阶是 $-1, 9, -225, 11025$，绝对值分别是 $1^2, 3^2, 15^2, 105^2$，也就是 $1, 1 \cdot 3, 1 \cdot 3 \cdot 5, 1 \cdot 3 \cdot 5 \cdot 7$ 的平方。他说他押这些行列式有漂亮的公式，至少到 8 阶，他押对了。

奇数阶为什么奇异，倒是可以一句话说清：令 $\mathbf{x}$ 的偶数位分量为 0，奇数阶矩阵里偶数行的方程只含奇数位分量，个数比未知数少一个，所以必有非零解 $A_n\mathbf{x} = \mathbf{0}$。偶数阶的公式我只验证了数值，没有证明。

下一讲回到新内容：[对称矩阵与正定性](/posts/linear-algebra-25-symmetric-positive-definite/)。刚才反复出现的 $A_3$、$A_4$ 都是对称的，这不是巧合：对称矩阵的特征值一定是实数，特征向量可以取成互相正交的，下一讲就从这里开始。
