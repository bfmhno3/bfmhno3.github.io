---
title: "18.06 第 25 讲：对称矩阵与正定性"
commentId: "post:linear-algebra-25-symmetric-positive-definite"
published: "2026-10-18 16:20:00 +08:00"
description: "MIT 18.06 第 25 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 在一个 50 阶随机对称矩阵上只做消元数主元的正负，得到 24 正 26 负，和 24 个正特征值、26 个负特征值完全对得上。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 对称矩阵
  - 正定矩阵
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 26
draft: false
comment: true
slug: linear-algebra-25-symmetric-positive-definite
---

这一讲 Strang 只想让你记住一句话：实对称矩阵的特征值是实数，特征向量可以选成互相垂直，所以 $A = Q\Lambda Q^\mathsf{T}$。顺着这句话他还给了一个很实用的推论：不用解特征值，只做消元，主元的正负个数就等于特征值的正负个数。我在一个 50 阶的随机对称矩阵上试了一下，24 个正主元、26 个负主元，和 24 个正特征值、26 个负特征值一个不差；而用特征多项式求根去算一个 20 阶矩阵的特征值，误差是 `eigvalsh` 的 $4.3 \times 10^{12}$ 倍。

> [!NOTE] 本讲速览
> 视频：[Lecture 25: Symmetric matrices and positive definiteness](https://www.youtube.com/watch?v=UCc9q_cAhho)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-25-symmetric-matrices-and-positive-definiteness/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §6.3 Symmetric Positive Definite Matrices
> 前置：[第 24b 讲：第二次测验复习](/posts/linear-algebra-24b-quiz-2-review/)
> 一句话：对称矩阵 $A = A^\mathsf{T}$ 有实特征值和一组标准正交的特征向量，$A = Q\Lambda Q^\mathsf{T}$ 就是一堆互相垂直的投影矩阵的加权和；主元与特征值的正负个数相同，正定矩阵就是两者全为正的那一类。

> [!TIP] 配合视频
> - 开头几分钟他直接把结论摆出来：特征值是实数，特征向量垂直。接着他在“可以选成垂直”那里停了一下，讲重特征值的情形，值得听。
> - 中间一大段是证明特征值为什么是实数，要在黑板上做复共轭。字幕里这一段很碎（他自己也在中途改口），本篇用文字重述了一遍，建议看视频时只抓住最关键的一步：$\bar{\mathbf{x}}^\mathsf{T}\mathbf{x}$ 一定是正数，所以可以约掉。
> - 他把 $Q\Lambda Q^\mathsf{T}$ 按“列乘行”拆开、说每一项是投影矩阵的那几句，和第 15、16 讲连起来了，值得认真听。
> - 主元的正负等于特征值的正负，那一段最实用，也是本篇做得最多的实验。快到结尾时他才给出第一个具体数字例子，$\begin{bmatrix}5&2\\2&3\end{bmatrix}$，之后是“子行列式全为正”的判据，最后一句说的是整门课在这里汇合。

## 先看事实：实特征值，垂直的特征向量

Strang 开场就先说结论，再回头证明。对称矩阵（real symmetric matrix，$A = A^\mathsf{T}$）有两条性质：

- 特征值全是实数。前面几讲里旋转矩阵给出过复特征值，对称矩阵不会这样。
- 特征向量互相垂直。准确地说是“可以选成互相垂直”：特征值互不相同时，每个特征值对应一条直线，这些直线自然垂直；特征值有重复时，对应的是一整个平面，他的意思是你可以在这个平面里选出垂直的一组。

他举的例子是单位矩阵：它当然对称，特征值全是 1，但每一个向量都是特征向量，所以“垂直”只能是“可以选成垂直”。

先拿一个随机对称矩阵试一下，看看 NumPy 给出的是什么。`np.linalg.eigh` 是专为对称矩阵写的：它只读一半矩阵，返回升序排列的实特征值和标准正交的特征向量。我把它和通用的 `np.linalg.eig` 并排放，再拿一个不对称矩阵当反例：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # 实对称矩阵：B + B^T 一定对称
    B = rng.standard_normal((4, 4))
    A = B + B.T
    print("A 对称：", np.allclose(A, A.T))

    # 一般的 eig：不知道对称，也不保证特征向量正交
    lam_gen, S = np.linalg.eig(A)
    print("eig 的特征值：", lam_gen)
    print("特征值全是实数：", np.isrealobj(lam_gen))
    print("||S^T S - I|| =", f"{np.linalg.norm(S.T @ S - np.eye(4)):.2e}")

    # eigh：专为对称矩阵写的，返回升序的实特征值和标准正交的 Q
    lam, Q = np.linalg.eigh(A)
    print("eigh 的特征值：", lam)
    print("||Q^T Q - I|| =", f"{np.linalg.norm(Q.T @ Q - np.eye(4)):.2e}")
    print("A = Q Lambda Q^T：", np.allclose(Q @ np.diag(lam) @ Q.T, A))

    # 对照：不对称的矩阵，特征向量一般不正交，特征值还可能是复数
    N = B
    lam_n, S_n = np.linalg.eig(N)
    print("不对称矩阵的特征值：", lam_n)
    gram = S_n.conj().T @ S_n
    off = gram - np.diag(np.diag(gram))
    print(
        "不对称矩阵的特征向量，最大的非对角内积：", f"{np.abs(off).max():.4f}"
    )

    # 重特征值：单位矩阵的每个向量都是特征向量，eigh 替我们选了一组正交的
    lam_i, Q_i = np.linalg.eigh(np.eye(3))
    print("单位矩阵的特征值：", lam_i)
    print("单位矩阵 eigh 给出的 Q：")
    print(Q_i)


if __name__ == "__main__":
    main()
```

```text
A 对称： True
eig 的特征值： [ 2.9951  0.2263 -1.9557 -3.5211]
特征值全是实数： True
||S^T S - I|| = 6.67e-16
eigh 的特征值： [-3.5211 -1.9557  0.2263  2.9951]
||Q^T Q - I|| = 9.19e-16
A = Q Lambda Q^T： True
不对称矩阵的特征值： [ 1.3502 -0.1065 -0.8154 -1.5559]
不对称矩阵的特征向量，最大的非对角内积： 0.4836
单位矩阵的特征值： [1. 1. 1.]
单位矩阵 eigh 给出的 Q：
[[1. 0. 0.]
 [0. 1. 0.]
 [0. 0. 1.]]
```

`eig` 和 `eigh` 给出同样的四个特征值，只是顺序不同。两者的特征向量都满足 $\lVert Q^\mathsf{T}Q - I \rVert \approx 10^{-16}$，也就是列向量两两正交、长度为 1。这里 `eig` 恰好也给出了正交的特征向量，是因为四个特征值互不相同，理论上本来就垂直；`eigh` 的好处是不管有没有重复特征值，它都保证返回正交的一组。

反例是最后一组：同一个 $B$ 不加 $B^\mathsf{T}$，不再对称，特征向量之间最大的非对角内积是 0.4836，离 0 差得很远（这次它的特征值碰巧也是实数，只是没有垂直的保证）。重特征值也验证了他的说法：单位矩阵三个特征值都是 1，`eigh` 返回的 $Q$ 就是单位矩阵本身，也就是坐标轴。这只是无穷多种标准正交选法里的一种，任何一组标准正交基对单位矩阵都同样成立，所以他才一定要写“可以选成”。

## 为什么特征值是实数

他花了相当长的时间证明这一点，字幕里他中途多次改口，看得出是边写边想。我把那条线捋成四步。

1. 从 $A\mathbf{x} = \lambda\mathbf{x}$ 出发。此刻 $\lambda$ 和 $\mathbf{x}$ 都可能是复数。两边取复共轭，$A$ 是实矩阵所以没变：$A\bar{\mathbf{x}} = \bar\lambda\bar{\mathbf{x}}$。
2. 对这个式子两边转置，用上 $A^\mathsf{T} = A$（对称性只用了这一次）：$\bar{\mathbf{x}}^\mathsf{T}A = \bar\lambda\bar{\mathbf{x}}^\mathsf{T}$。
3. 把这行右乘 $\mathbf{x}$，得到 $\bar{\mathbf{x}}^\mathsf{T}A\mathbf{x} = \bar\lambda\,\bar{\mathbf{x}}^\mathsf{T}\mathbf{x}$。另一边，把 $A\mathbf{x} = \lambda\mathbf{x}$ 左乘 $\bar{\mathbf{x}}^\mathsf{T}$，得到 $\bar{\mathbf{x}}^\mathsf{T}A\mathbf{x} = \lambda\,\bar{\mathbf{x}}^\mathsf{T}\mathbf{x}$。两个式子左边相同，所以 $\lambda\,\bar{\mathbf{x}}^\mathsf{T}\mathbf{x} = \bar\lambda\,\bar{\mathbf{x}}^\mathsf{T}\mathbf{x}$。
4. $\bar{\mathbf{x}}^\mathsf{T}\mathbf{x} = \sum \bar{x}_i x_i = \sum (a_i^2 + b_i^2)$：每个 $x_i = a_i + b_i\mathrm{i}$ 乘上自己的共轭，虚部抵消，剩下 $a_i^2 + b_i^2$。只要 $\mathbf{x} \ne \mathbf{0}$，这个数就严格大于 0，可以放心约掉，得到 $\lambda = \bar\lambda$，所以 $\lambda$ 是实数。

**对复向量，正确的“长度平方”是什么？** 是 $\bar{\mathbf{x}}^\mathsf{T}\mathbf{x}$，而不是 $\mathbf{x}^\mathsf{T}\mathbf{x}$。用后者的话，$(1, \mathrm{i})$ 的“长度平方”是 $1 + \mathrm{i}^2 = 0$，一个非零向量长度为 0，显然不对。这是下一讲（复矩阵）的预告，他在这里顺带点了一句。

他还顺手把条件推广了一下：如果 $A$ 是复矩阵，第二步转置时就应该同时取共轭，对称性要换成 $\bar A^\mathsf{T} = A$（Hermitian 矩阵），证明照样成立。实矩阵的情形下共轭不起作用，这就退回了 $A = A^\mathsf{T}$。他说 99% 的应用里矩阵都是实的，所以“对称”是关键词。

## A = QΛQᵀ 与谱分解

特征向量垂直，还可以把长度缩放成 1，于是特征向量矩阵的列是标准正交的。这时 Strang 说，字母 $S$ 该换成 $Q$。一般情形的 $A = S\Lambda S^{-1}$ 就变成

$$
A = Q\Lambda Q^{-1} = Q\Lambda Q^\mathsf{T}
$$

因为标准正交列的矩阵满足 $Q^{-1} = Q^\mathsf{T}$。他说这是线性代数里最著名的定理之一，叫谱定理（spectral theorem；力学里叫主轴定理，principal axis theorem）。反方向也很显然：任何形如 $Q\Lambda Q^\mathsf{T}$ 的矩阵，转置之后还是它自己，所以一定对称。这个式子同时把特征值（$\Lambda$ 里的实数）和对称性都摆出来了。

接下来他用“列乘行”把它拆开，这就是第 3 讲里矩阵乘法的第四种看法：

$$
A = \lambda_1\mathbf{q}_1\mathbf{q}_1^\mathsf{T} + \lambda_2\mathbf{q}_2\mathbf{q}_2^\mathsf{T} + \cdots + \lambda_n\mathbf{q}_n\mathbf{q}_n^\mathsf{T}
$$

每一项里的 $\mathbf{q}_k\mathbf{q}_k^\mathsf{T}$ 是单位向量乘它自己的转置，也就是第 15 讲里投影到直线的矩阵 $\dfrac{\mathbf{a}\mathbf{a}^\mathsf{T}}{\mathbf{a}^\mathsf{T}\mathbf{a}}$ 在 $\mathbf{a}^\mathsf{T}\mathbf{a} = 1$ 时的样子。所以每个对称矩阵都是若干个互相垂直的投影矩阵，按特征值加权求和。我就用他后面要用的 $\begin{bmatrix}5&2\\2&3\end{bmatrix}$ 把这件事数值地做一遍。随后再用一个 4 阶随机对称矩阵，按特征值绝对值从大到小一项一项累加，看每加一项误差降多少：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # Strang 后面用的 2 x 2 例子
    A = np.array([[5.0, 2.0], [2.0, 3.0]])
    lam, Q = np.linalg.eigh(A)
    print("特征值：", lam, "，理论值 4 -+ sqrt(5)：", 4 - 5**0.5, 4 + 5**0.5)
    print("Q =")
    print(Q)

    # 谱分解：A = lambda_1 q1 q1^T + lambda_2 q2 q2^T
    total = np.zeros_like(A)
    for k in range(2):
        q = Q[:, k]
        P = np.outer(q, q)
        total += lam[k] * P
        print(f"P{k + 1} = q{k + 1} q{k + 1}^T =")
        print(P)
        print(
            "  对称：",
            np.allclose(P, P.T),
            "，P @ P = P：",
            np.allclose(P @ P, P),
        )
        print("  迹（也就是秩）：", f"{np.trace(P):.4f}")
    print("两项加起来等于 A：", np.allclose(total, A))
    print("P1 + P2 = 单位矩阵：", end=" ")
    print(
        np.allclose(
            np.outer(Q[:, 0], Q[:, 0]) + np.outer(Q[:, 1], Q[:, 1]), np.eye(2)
        )
    )

    # 4 x 4 随机对称矩阵，按特征值绝对值从大到小累加各项，看误差
    rng = np.random.default_rng(1806)
    B = rng.standard_normal((4, 4))
    M = B + B.T
    lam4, Q4 = np.linalg.eigh(M)
    order = np.argsort(-np.abs(lam4))
    print("按绝对值排序的特征值：", lam4[order])
    for r in range(1, 5):
        approx = sum(lam4[k] * np.outer(Q4[:, k], Q4[:, k]) for k in order[:r])
        err = np.linalg.norm(M - approx)
        print(f"只留 {r} 项，||M - 近似|| = {err:.4f}")


if __name__ == "__main__":
    main()
```

```text
特征值： [1.7639 6.2361] ，理论值 4 -+ sqrt(5)： 1.7639320225002102 6.23606797749979
Q =
[[ 0.5257 -0.8507]
 [-0.8507 -0.5257]]
P1 = q1 q1^T =
[[ 0.2764 -0.4472]
 [-0.4472  0.7236]]
  对称： True ，P @ P = P： True
  迹（也就是秩）： 1.0000
P2 = q2 q2^T =
[[0.7236 0.4472]
 [0.4472 0.2764]]
  对称： True ，P @ P = P： True
  迹（也就是秩）： 1.0000
两项加起来等于 A： True
P1 + P2 = 单位矩阵： True
按绝对值排序的特征值： [-3.5211  2.9951 -1.9557  0.2263]
只留 1 项，||M - 近似|| = 3.5842
只留 2 项，||M - 近似|| = 1.9688
只留 3 项，||M - 近似|| = 0.2263
只留 4 项，||M - 近似|| = 0.0000
```

特征值 $4 \mp \sqrt5 = 1.7639, 6.2361$ 与解析值吻合（等一下会看到这是怎么来的）。两个 $P_k = \mathbf{q}_k\mathbf{q}_k^\mathsf{T}$ 都对称，且 $P^2 = P$，迹都是 1，所以都是秩 1 的投影矩阵；两个加起来是单位矩阵，因为 $Q Q^\mathsf{T} = I$。

后半段的数很有意思：4 项加完误差是 0；只留 3 项，误差是 0.2263，恰好等于被丢掉的那个特征值的绝对值（最小的特征值 0.2263）。这里的 $\lVert\cdot\rVert$ 是 Frobenius 范数，丢掉一项后剩下的就是 $\lambda\,\mathbf{q}\mathbf{q}^\mathsf{T}$，它的范数就是 $\lvert\lambda\rvert$。再往前看，留 2 项误差 1.9688，留 1 项 3.5842，每一项都在“拆掉”一个方向。这是低秩近似的最朴素版本，等到第 29 讲 SVD 会再碰到它。

## 主元的正负就是特征值的正负

接下来他提了一个很具体的问题：知道特征值是实数之后，下一步就是问它们是正还是负。比如微分方程里，正负决定了稳定还是发散。

**怎么知道正负，又不必真的把特征值算出来？** 他先把“算特征值”这件事说得很不客气：一个 50 阶的矩阵，手算要花一辈子；让 MATLAB 去算 $\det(A - \lambda I)$ 这个 50 次多项式再求根，它虽然会算，但会抱怨，因为这办法数值上很不稳定。他还承认，这正是他教过的做法，其实只适合二阶和三阶。他说的不稳定，我真的想看看到底有多糟，所以做了一个实验：构造一个特征值恰好是 $1, 2, \dots, 20$ 的 20 阶对称矩阵，一种做法是先算特征多项式的系数再求根，另一种是直接 `eigvalsh`：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 20 阶对称矩阵，特征值取 1, 2, ..., 20，特征向量是一个固定的正交矩阵
    rng = np.random.default_rng(1806)
    Q, _ = np.linalg.qr(rng.standard_normal((20, 20)))
    true = np.arange(1.0, 21.0)
    A = Q @ np.diag(true) @ Q.T
    A = (A + A.T) / 2

    # 老办法：先算 det(A - lambda I) 的系数，再解多项式的根
    coeffs = np.poly(A)
    roots = np.sort(np.roots(coeffs))
    err_roots = np.max(np.abs(roots - true))

    # 新办法：直接做对称特征值分解
    err_eigh = np.max(np.abs(np.linalg.eigvalsh(A) - true))

    print("多项式系数的量级：", f"{np.abs(coeffs).max():.2e}")
    print("求根得到的特征值，最大误差：", f"{err_roots:.2e}")
    print("eigvalsh 得到的特征值，最大误差：", f"{err_eigh:.2e}")
    print("两者误差之比：", f"{err_roots / err_eigh:.1e}")


if __name__ == "__main__":
    main()
```

```text
多项式系数的量级： 1.38e+19
求根得到的特征值，最大误差： 5.40e-02
eigvalsh 得到的特征值，最大误差： 1.24e-14
两者误差之比： 4.3e+12
```

多项式系数最大有 $1.38 \times 10^{19}$，已经大到双精度的 16 位有效数字不够用了；求根得到的特征值最大误差是 0.054，而 `eigvalsh` 的误差是 $1.24 \times 10^{-14}$，相差 $4.3 \times 10^{12}$ 倍。这还是 20 阶，不是他说的 50 阶，我猜 50 阶的结果会更夸张，但我没有跑，所以不下结论。（教材里很少见作者当面承认自己教过的方法不能用，我挺喜欢这一句。）

那“稳定又快”的办法是什么？他说是消元。**对称矩阵的主元的正负个数，等于特征值的正负个数。** 主元不是特征值，数值也完全不一样，但符号数一致。他在这里还补了一个很自然的连接：主元之积等于行列式（没有换行的话），特征值之积也等于行列式，所以两者的乘积相等，但这对 50 个数各自的正负没有告诉你什么，上面那条才是真正有信息的。

他还想到了一个办法利用这点：想知道有多少特征值大于 7，就把矩阵平移，$A - 7I$，特征值整体减 7，再数正主元（数负主元得到的是小于 7 的个数）。我写了一个不换行的消元函数，在一个 50 阶随机对称矩阵上，对 $A$、$A - 7I$、$A - 10I$ 分别数负主元，对比 `eigvalsh` 算出的特征值：

```python
import numpy as np


def pivots(A: np.ndarray) -> np.ndarray:
    """不换行的消元，返回主元。遇到 0 主元就报错。"""
    U = A.astype(float).copy()
    n = U.shape[0]
    out = np.zeros(n)
    for k in range(n):
        if abs(U[k, k]) < 1e-12:
            raise ValueError(f"第 {k} 个主元是 0，需要换行")
        out[k] = U[k, k]
        for i in range(k + 1, n):
            U[i, k:] -= U[i, k] / U[k, k] * U[k, k:]
    return out


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # Strang 说的 50 阶：随机对称矩阵，数主元的正负和特征值的正负
    B = rng.standard_normal((50, 50))
    A = B + B.T
    d = pivots(A)
    lam = np.linalg.eigvalsh(A)
    print("正主元个数：", np.sum(d > 0), "，负主元个数：", np.sum(d < 0))
    print(
        "正特征值个数：", np.sum(lam > 0), "，负特征值个数：", np.sum(lam < 0)
    )

    # 主元之积 = 特征值之积 = 行列式（用对数避免溢出）
    sign, logdet = np.linalg.slogdet(A)
    print(
        "主元之积的符号和 log|.|：",
        np.prod(np.sign(d)),
        np.sum(np.log(np.abs(d))),
    )
    print(
        "特征值之积的符号和 log|.|：",
        np.prod(np.sign(lam)),
        np.sum(np.log(np.abs(lam))),
    )
    print("slogdet：", sign, logdet)

    # 平移：A - 7I 的负主元个数 = A 的小于 7 的特征值个数
    for shift in [0.0, 7.0, 10.0]:
        d_s = pivots(A - shift * np.eye(50))
        print(
            f"平移 {shift}：负主元 {np.sum(d_s < 0)} 个，",
            f"小于 {shift} 的特征值 {np.sum(lam < shift)} 个",
        )


if __name__ == "__main__":
    main()
```

```text
正主元个数： 24 ，负主元个数： 26
正特征值个数： 24 ，负特征值个数： 26
主元之积的符号和 log|.|： 1.0 91.5130695575681
特征值之积的符号和 log|.|： 1.0 91.51306955756814
slogdet： 1.0 91.51306955756817
平移 0.0：负主元 26 个， 小于 0.0 的特征值 26 个
平移 7.0：负主元 35 个， 小于 7.0 的特征值 35 个
平移 10.0：负主元 40 个， 小于 10.0 的特征值 40 个
```

24 个正主元、26 个负主元对 24 个正特征值、26 个负特征值；平移 7 以后负主元 35 个，小于 7 的特征值也是 35 个；平移 10 以后是 40 对 40。三个平移全都对得上。主元之积的对数是 91.5131，与特征值之积和 `slogdet` 在小数点后 13 位以内一致（用对数是因为乘 50 个数会溢出到很大的量级）。

注意这个函数遇到 0 主元就直接报错，没有处理换行。随机矩阵碰到 0 主元的概率是 0，所以这里没事。严格说，主元的正负个数等于特征值的正负个数这个结论，需要消元过程不需要换行，我没有去验证需要换行时它会怎样。

## 正定矩阵

最后几分钟他开始讲正定（positive definite）。定义很自然：对称矩阵里，特征值全为正的那一类。对称矩阵好，正定矩阵“excellent”（字幕原话），他还说下一节的教材就是讲这个。

测试办法有两个：

- 看主元：因为主元的符号和特征值的符号个数一致，所以所有特征值为正等价于所有主元为正。
- 看左上角的子行列式：$1 \times 1$、$2 \times 2$、$\dots$、$n \times n$ 的左上角行列式全为正。只看整个矩阵的行列式不够，因为两个负特征值乘起来也是正的。

他的例子是 $A = \begin{bmatrix}5&2\\2&3\end{bmatrix}$：第一个主元 5，行列式 11，所以第二个主元是 $11/5$，都是正的，所以特征值也都是正的。特征值是 $\lambda^2 - 8\lambda + 11 = 0$ 的根（8 是迹，11 是行列式），也就是 $4 \pm \sqrt5$，他说二阶的根不算太糟，但也谈不上漂亮，主元就简单多了。

他又给了一个反例，字幕里只读出了数字“minus one minus three”，没有写出整个矩阵。我按“整个矩阵的行列式是 3”“主元和特征值也都是负的”这两句话，猜是 $\mathrm{diag}(-1, -3)$。如果猜错了，只影响这一个反例，不影响结论。它的行列式 $= 3 > 0$，但第一个子行列式 $-1 < 0$，所以通不过测试，而这就是“只看总行列式不够”的原因：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    A = np.array([[5.0, 2.0], [2.0, 3.0]])
    # 字幕里读出来的是 “-1 -3”，我猜是对角矩阵 diag(-1, -3)
    D = np.array([[-1.0, 0.0], [0.0, -3.0]])

    for name, M in [("A", A), ("D", D)]:
        piv = [M[0, 0], np.linalg.det(M) / M[0, 0]]
        print(f"{name} 的主元：", np.array(piv))
        print(
            f"  左上角子行列式：{M[0, 0]:.1f}，{np.linalg.det(M):.1f}",
            "；特征值：",
            np.linalg.eigvalsh(M),
        )
        ok = M[0, 0] > 0 and np.linalg.det(M) > 0
        print("  所有子行列式为正：", ok)

    # A 的特征值公式：4 加减 sqrt(5)，来自 lambda^2 - 8 lambda + 11 = 0
    print("A 的迹和行列式：", np.trace(A), round(np.linalg.det(A), 6))
    print("第二个主元 11/5 =", 11 / 5)
    print("lambda^2 - 8 lambda + 11 的根：", np.roots([1.0, -8.0, 11.0]))

    # 对称，且所有特征值为正时，x^T A x 对任意非零 x 都为正
    rng = np.random.default_rng(1806)
    X = rng.standard_normal((2, 100000))
    q_A = np.einsum("ij,ij->j", X, A @ X)
    q_D = np.einsum("ij,ij->j", X, D @ X)
    print("A：10 万个随机 x 里 x^T A x > 0 的个数：", np.sum(q_A > 0))
    print("D：10 万个随机 x 里 x^T D x > 0 的个数：", np.sum(q_D > 0))


if __name__ == "__main__":
    main()
```

```text
A 的主元： [5.  2.2]
  左上角子行列式：5.0，11.0 ；特征值： [1.7639 6.2361]
  所有子行列式为正： True
D 的主元： [-1. -3.]
  左上角子行列式：-1.0，3.0 ；特征值： [-3. -1.]
  所有子行列式为正： False
A 的迹和行列式： 8.0 11.0
第二个主元 11/5 = 2.2
lambda^2 - 8 lambda + 11 的根： [6.2361 1.7639]
A：10 万个随机 x 里 x^T A x > 0 的个数： 100000
D：10 万个随机 x 里 x^T D x > 0 的个数： 0
```

$A$ 的主元是 5 和 2.2，两个子行列式 5.0 和 11.0，特征值 1.7639 和 6.2361，三种判据一致。$D$ 的行列式是 3.0，是个正数，但主元 $-1, -3$ 和特征值 $-3, -1$ 都是负的，子行列式 $-1.0$ 没过关。

最后两行是后面几讲才系统讲的：正定矩阵 $x^\mathsf{T}Ax$ 对任意非零 $x$ 都是正的。我随手取 10 万个随机向量：对 $A$ 全是正的（100000 个），对 $D$ 一个都不是（0 个）。（$D$ 是个负定矩阵，所以结果是 0 而不是“一半一半”，这个反例选得有点极端，我猜他只是想要一个行列式为正的坏例子。）这个二次型的几何意义，要等到第 27 讲才有，这里先放着。

整门课到这里，三条线汇合了：第一周的主元、中间的行列式、最近的特征值，对于对称矩阵来说，它们在正定这件事上给出的是同一个答案。他说这是整门课开始汇合的地方，下一讲和下下一讲会继续，最后的高潮是对一般的 $n \times n$ 矩阵把这些东西合起来。

## 在控制里

协方差矩阵是这一讲里最常碰到的对称矩阵，也恰好是“半正定”的最自然来源。卡尔曼滤波里的状态协方差 $P$（见 [升到高维：多变量卡尔曼滤波的推导与实现](/posts/kalman-filter-02-multivariate/)）就是一个对称半正定矩阵：沿着任意方向 $\mathbf{x}$ 的方差是 $\mathbf{x}^\mathsf{T}P\mathbf{x}$，方差不会是负数，所以特征值不会是负数。

我用一组相关的二维样本把它数值地看一遍：协方差矩阵是对称的，特征值是沿主轴的方差，$Q$ 的列是主轴方向，换到主轴坐标之后协方差变成对角阵，两个分量不再相关。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # 两个强相关的测量量：第一个的标准差约 2，第二个与它正相关
    mix = np.array([[2.0, 0.0], [1.2, 0.5]])
    samples = (mix @ rng.standard_normal((2, 5000))).T
    C = np.cov(samples, rowvar=False)
    print("样本协方差 C =")
    print(C)
    print("C 对称：", np.allclose(C, C.T))

    lam, Q = np.linalg.eigh(C)
    print("特征值（沿主轴的方差）：", lam)
    print("最小特征值非负：", lam.min() >= 0)
    print("主轴方向（Q 的列）：")
    print(Q)

    # 换到主轴坐标：协方差变成对角阵，两个分量不再相关
    rotated = samples @ Q
    C_rot = np.cov(rotated, rowvar=False)
    print("主轴坐标下的协方差：")
    print(C_rot)
    print("对角阵 Lambda：", np.allclose(C_rot, np.diag(lam)))

    # 任意方向 x 上的方差 x^T C x 等于投影后样本的方差，所以不会是负的
    x = np.array([1.0, -1.0]) / np.sqrt(2.0)
    print("x^T C x =", f"{x @ C @ x:.4f}")
    print("投影后样本的方差 =", f"{np.var(samples @ x, ddof=1):.4f}")


if __name__ == "__main__":
    main()
```

```text
样本协方差 C =
[[4.0089 2.3967]
 [2.3967 1.6811]]
C 对称： True
特征值（沿主轴的方差）： [0.1807 5.5094]
最小特征值非负： True
主轴方向（Q 的列）：
[[ 0.5306 -0.8476]
 [-0.8476 -0.5306]]
主轴坐标下的协方差：
[[ 0.1807 -0.    ]
 [-0.      5.5094]]
对角阵 Lambda： True
x^T C x = 0.4483
投影后样本的方差 = 0.4483
```

两个特征值 0.1807 和 5.5094 都非负；换到主轴坐标后，非对角元素显示成 `-0.`（舍入后的零），协方差成了 $\Lambda$。最后两行验证了“沿任意方向的方差就是 $\mathbf{x}^\mathsf{T}C\mathbf{x}$”：沿 $(1, -1)/\sqrt2$ 方向投影的样本方差和二次型都是 0.4483。这个方向离长轴很远，所以方差远小于最大特征值 5.5094。滤波里的 $P$ 画成椭圆，椭圆的主轴就是 $Q$ 的列，半轴长和 $\sqrt{\lambda}$ 成正比。

我猜，实现卡尔曼滤波时，$P$ 在多次更新后因为舍入误差失去严格对称，或者出现一个很小的负特征值，是很常见的问题，这也是为什么很多实现要显式写 $P \leftarrow (P + P^\mathsf{T})/2$ 或者用 Joseph 形式。我没有在这一篇里验证这一点，细节留给那一篇。

下一讲 Strang 要把这一讲里露了一下头的复数讲透：复向量的内积、Hermitian 矩阵、Fourier 矩阵，以及把 $n^2$ 次乘法砍到 $\frac{n}{2}\log_2 n$ 的快速 Fourier 变换。见 [18.06 第 26 讲：复矩阵与快速 Fourier 变换](/posts/linear-algebra-26-complex-matrices-fft/)。
