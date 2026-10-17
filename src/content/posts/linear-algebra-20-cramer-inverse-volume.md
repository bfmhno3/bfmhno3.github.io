---
title: "18.06 第 20 讲：Cramer 法则、逆矩阵与体积"
commentId: "post:linear-algebra-20-cramer-inverse-volume"
published: "2026-10-18 14:20:00 +08:00"
description: "MIT 18.06 第 20 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 验证了余子式求逆、Cramer 法则和 |det| 等于面积与体积，并数了一下：解 10 阶方程组，Cramer 法则（用余子式算行列式）要 68588300 次乘法，消元大约 333 次，差了 205971 倍。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - Cramer 法则
  - 行列式
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 20
draft: false
comment: true
slug: linear-algebra-20-cramer-inverse-volume
---

行列式把一个矩阵压缩成一个数，这一讲 Strang 要用这个数给我们已经会算的东西配上公式：逆矩阵是 $C^T / \det A$，解方程组是 $x_j = \det B_j / \det A$，平行四边形的面积是 $|ad - bc|$。公式漂亮，但他一边写一边说“我不想让你用它”。我把 Cramer 法则的乘法次数数了一遍：10 阶方程组要 68588300 次，消元大约 333 次，差了 205971 倍。

> [!NOTE] 本讲速览
> 视频：[Lecture 20: Cramer's rule, inverse matrix, and volume](https://www.youtube.com/watch?v=QNpj-gOXW9M)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-20-cramers-rule-inverse-matrix-and-volume/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §5.2；§5.3 Areas and Volumes by Determinants
> 前置：[第 19 讲：行列式公式与代数余子式](/posts/linear-algebra-19-determinant-formulas-cofactors/)
> 一句话：$A^{-1} = C^T / \det A$，$C$ 是代数余子式矩阵；由它推出 Cramer 法则，而 $|\det A|$ 就是以 $A$ 的行为边的平行四边形或平行六面体的面积或体积。

> [!TIP] 配合视频
> - 开头他从 2 × 2 逆矩阵公式猜出 $C^T$，再逐项验证 $AC^T = (\det A)I$。非对角线为什么是 0 那一段（他叫它“A screwed up”）值得认真听，本篇只用代码验了结论，没有重讲论证。
> - Cramer 法则的推导很短，他讲完就开始吐槽它的计算量，还提到小时候读过的一本书。这段可以放松地看。
> - 体积那一段是全讲的重头：他把行列式的性质一条条拿出来，说“如果体积也满足这几条，体积就是行列式”。最后他自己说时间到了，性质 3b 的证明没有做完，教材里有图。
> - 本篇已经用代码算过的内容：余子式求逆、Cramer 法则对照 `solve`、面积与体积的数值检查。想省时间的话，这几处可以倍速。

## 逆矩阵的公式：余子式矩阵的转置

Strang 开头先问：2 × 2 的逆矩阵我们早就会写了，

$$
\begin{bmatrix} a & b \\ c & d \end{bmatrix}^{-1}
= \frac{1}{ad - bc}
\begin{bmatrix} d & -b \\ -c & a \end{bmatrix}
$$

分母是行列式，这很合理：行列式不是 0 的时候才有逆，除以它刚好。那右边那个矩阵是什么？他的提示是“想想余子式”。

$d$ 是 $a$ 的余子式（划掉第 1 行第 1 列，剩下 $d$）。$-b$ 是 $c$ 的余子式：划掉 $c$ 所在的行和列，剩下 $b$，而 $c$ 在第 2 行第 1 列，$2 + 1$ 是奇数，所以带负号。所以右边的矩阵是余子式矩阵 $C$ 再转置：$C$ 的第 $(i, j)$ 项是 $a_{ij}$ 的余子式，$C^T$ 里的 $-b$ 出现在第 1 行第 2 列，位置换了，是转置的缘故。

他把它写成一般形式：

$$
A^{-1} = \frac{1}{\det A}\, C^T
$$

第一个问题是：2 × 2 碰巧成立，别的公式也可能碰巧成立，凭什么相信它对 $n \times n$ 都对？他的办法是直接验证 $AC^T = (\det A) I$。

乘积 $AC^T$ 的第 $(i, j)$ 项是 $A$ 的第 $i$ 行点乘 $C$ 的第 $j$ 行。

- 对角线上 $i = j$：这是“第 $i$ 行的每个元素乘它自己的余子式再相加”，正是上一讲的余子式展开，结果是 $\det A$。
- 非对角线上 $i \neq j$：是第 $i$ 行的元素乘第 $j$ 行的余子式。他的论证是：这等于把 $A$ 的第 $j$ 行换成第 $i$ 行，得到一个有两行相同的矩阵，再按第 $j$ 行做余子式展开。有两行相同的矩阵是奇异的，行列式是 0。而换掉第 $j$ 行并不改变第 $j$ 行的余子式（余子式是划掉第 $j$ 行之后算的），所以展开式里的数字就是我们要的那个乘积。

我用一个 3 × 3 矩阵把整条链都跑一遍：

```python
import numpy as np


def cofactor_matrix(A: np.ndarray) -> np.ndarray:
    """返回代数余子式矩阵 C，C[i, j] 是划掉第 i 行第 j 列后的带符号行列式。"""
    n = A.shape[0]
    C = np.zeros_like(A)
    for i in range(n):
        for j in range(n):
            minor = np.delete(np.delete(A, i, axis=0), j, axis=1)
            C[i, j] = (-1) ** (i + j) * np.linalg.det(minor)
    return C


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 2 x 2：d、-b、-c、a 就是余子式再转置
    a, b, c, d = 3.0, 1.0, 2.0, 4.0
    A2 = np.array([[a, b], [c, d]])
    C2 = cofactor_matrix(A2)
    print("2 x 2 的 C =", np.round(C2, 4).tolist())
    print(
        "C.T / det 等于 inv(A)：",
        np.allclose(C2.T / np.linalg.det(A2), np.linalg.inv(A2)),
    )

    # 3 x 3：A @ C.T 应当是 det(A) * 单位阵
    A = np.array([[1.0, 2.0, 3.0], [0.0, 4.0, 5.0], [1.0, 0.0, 6.0]])
    C = cofactor_matrix(A)
    detA = np.linalg.det(A)
    print("det(A) =", round(detA, 4))
    print("C =")
    print(C)
    print("A @ C.T =")
    print(np.round(A @ C.T, 4) + 0.0)
    A_inv = C.T / detA
    print(
        "C.T / det 等于 np.linalg.inv：", np.allclose(A_inv, np.linalg.inv(A))
    )

    # 对角线是“本行乘本行的余子式”，非对角线是“本行乘别的行的余子式”
    # 后者等于把 A 的第 1 行抄到第 2 行后再按第 2 行展开，所以是 0
    A_screwed = A.copy()
    A_screwed[1] = A[0]
    print("第 1 行乘第 2 行的余子式 =", round(A[0] @ C[1], 4))
    print("两行相同的矩阵的 det =", round(np.linalg.det(A_screwed), 4))

    # Strang 的问题：把 a11 加 1，逆矩阵怎么变
    E = np.zeros((3, 3))
    E[0, 0] = 1.0
    A_new = A + E
    C_new = cofactor_matrix(A_new)
    print(
        "det 的变化 =",
        round(np.linalg.det(A_new) - detA, 4),
        "，C11 =",
        round(C[0, 0], 4),
    )
    print(
        "第 1 行与第 1 列的余子式没变：",
        np.allclose(C_new[0], C[0]) and np.allclose(C_new[:, 0], C[:, 0]),
    )


if __name__ == "__main__":
    main()
```

```text
2 x 2 的 C = [[4.0, -2.0], [-1.0, 3.0]]
C.T / det 等于 inv(A)： True
det(A) = 22.0
C =
[[ 24.   5.  -4.]
 [-12.   3.   2.]
 [ -2.  -5.   4.]]
A @ C.T =
[[22.  0.  0.]
 [ 0. 22.  0.]
 [ 0.  0. 22.]]
C.T / det 等于 np.linalg.inv： True
第 1 行乘第 2 行的余子式 = 0.0
两行相同的矩阵的 det = 0.0
det 的变化 = 24.0 ，C11 = 24.0
第 1 行与第 1 列的余子式没变： True
```

先看 2 × 2：$\begin{bmatrix} 3 & 1 \\ 2 & 4 \end{bmatrix}$ 的 $C$ 是 $\begin{bmatrix} 4 & -2 \\ -1 & 3 \end{bmatrix}$，正好是 $d, -c, -b, a$（和他黑板上一样，$-b$ 落在 $c$ 的位置）。3 × 3 的 $AC^T$ 是 $22I$：对角线是 $\det A = 22$，所有非对角线都是 0。$C^T / \det A$ 和 `np.linalg.inv` 一致。

“第 1 行乘第 2 行的余子式 = 0”这一行就是他那段论证的数值版本：它等于“两行相同的矩阵的行列式”，后者也是 0。

顺便，他还留了一个问题：把 $a_{11}$ 加 1，逆矩阵会怎样？他说公式里什么都看得见，只要看行列式和余子式怎么变。我照做了：行列式的变化恰好是 24，等于 $C_{11}$，而 $C$ 的第 1 行和第 1 列一点没变。道理一眼就看得出来：余子式 $C_{ij}$ 是划掉第 $i$ 行第 $j$ 列之后算的，第 1 行和第 1 列的余子式都把 $a_{11}$ 划掉了，当然不含它。反过来，$\det A$ 按第 1 行展开是 $a_{11} C_{11} + \cdots$，$a_{11}$ 加 1，行列式就多一个 $C_{11}$。

有一个小观察，是他中途顺口说的，我觉得挺好：把 3 × 3 矩阵的元素按行写成 $a, b, c, d, e, f, g, h, i$，$\det A$ 的每一项是 3 个元素的乘积（比如 $aei$），而余子式的每一项只有 2 个元素的乘积（$a$ 的余子式是 $ei - fh$）。一般地，行列式的项有 $n$ 个因子，余子式的项有 $n - 1$ 个。我们用 Gauss-Jordan（$[A\ I] \to [I\ A^{-1}]$）求逆时从来没看见过这件事，因为那是算法，不是代数。有了公式，才能对着字母看清 $A^{-1}$ 的每一项由哪些元素构成。

## Cramer 法则：用公式解方程组

有了逆矩阵的公式，解 $A\mathbf{x} = \mathbf{b}$ 就是 $\mathbf{x} = A^{-1}\mathbf{b} = \frac{1}{\det A} C^T \mathbf{b}$。它给出的当然还是第 1 讲用消元得到的那个唯一的解，现在是用字母写出来的了。

看 $\mathbf{x}$ 的第一个分量：$C^T \mathbf{b}$ 的第一项是 $b_1 C_{11} + b_2 C_{21} + \cdots + b_n C_{n1}$，是一列余子式乘一列数。Strang 说：“每次你把余子式乘上数，就是在算某个东西的行列式。”是什么东西的？按第 1 列做余子式展开：一个第 1 列是 $b_1, \dots, b_n$ 的矩阵，它的余子式恰好是 $C_{11}, C_{21}, \dots$（余子式只依赖于划掉第 1 列之后剩下的部分，也就是 $A$ 的其余各列）。这个矩阵叫 $B_1$：把 $A$ 的第 1 列换成 $\mathbf{b}$。

一般地：

$$
x_j = \frac{\det B_j}{\det A},\qquad B_j = A \text{ 的第 } j \text{ 列换成 } \mathbf{b}
$$

这就是 Cramer 法则。他说教材里有另一个更巧的证明，不用这么多余子式，他讲的这个胜在顺手：上面的每一步都是刚学过的东西。

### 它好用吗？

这是他这讲里最有意思的一段。要算 $n + 1$ 个行列式（$A$ 一个，$B_1, \dots, B_n$ 各一个），“好”还是“不好”要看这些行列式怎么算。他小时候读过一本给爱好数学的孩子看的书，叫《Mathematics for the Million》，书里把消元讲得极其复杂，然后拿出 Cramer 法则说这才是正路。他现在的看法是：Cramer 法则是灾难性的，计算量“大约是永远”，所以那本书的名字应该是 Mathematics for the Millionaire（买得起这种计算量的人才用得上）。

我来数一下“永远”是多久。先验证 Cramer 法则对：用第 1 讲的 3 × 3 方程组和一个随机的 6 × 6 方程组对照 `np.linalg.solve`。然后数代价：行列式用余子式展开来算，乘法次数满足 $m(n) = n\,(m(n-1) + 1)$（$n$ 个元素各乘一个 $n-1$ 阶行列式，再多一次乘法），$m(1) = 0$。Cramer 法则要 $n + 1$ 个这样的行列式，消元大约 $n^3/3$ 次乘法。

```python
import numpy as np


def det_cofactor(A: np.ndarray) -> tuple[float, int]:
    """按第一行做余子式展开，返回行列式与乘法次数。"""
    n = A.shape[0]
    if n == 1:
        return float(A[0, 0]), 0
    total, mults = 0.0, 0
    for j in range(n):
        minor = np.delete(A[1:], j, axis=1)
        sub, m = det_cofactor(minor)
        total += (-1) ** j * A[0, j] * sub
        mults += m + 1
    return total, mults


def cramer(A: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Cramer 法则：x_j = det(B_j) / det(A)，B_j 是 A 的第 j 列换成 b。"""
    detA = np.linalg.det(A)
    x = np.zeros(A.shape[0])
    for j in range(A.shape[0]):
        B = A.copy()
        B[:, j] = b
        x[j] = np.linalg.det(B) / detA
    return x


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # Strang 第 1 讲的 3 x 3 方程组，Cramer 法则与 solve 对照
    A = np.array([[2.0, -1.0, 0.0], [-1.0, 2.0, -1.0], [0.0, -3.0, 4.0]])
    b = np.array([0.0, -1.0, 4.0])
    print("Cramer：", cramer(A, b))
    print("solve： ", np.linalg.solve(A, b) + 0.0)

    # 随机 6 x 6：两种方法的差
    M = rng.standard_normal((6, 6))
    r = rng.standard_normal(6)
    x_c, x_s = cramer(M, r), np.linalg.solve(M, r)
    print("6 x 6 两种解的最大差：", f"{np.abs(x_c - x_s).max():.1e}")

    # 代价：Cramer 要算 n + 1 个行列式，这里每个都用余子式展开
    # 余子式展开的乘法次数满足 m(n) = n * (m(n - 1) + 1)，m(1) = 0
    # 消元解一个方程组大约要 n^3 / 3 次乘法
    print("n  Cramer 乘法次数  消元 n^3/3  比值")
    m = 0
    for n in range(2, 11):
        m = n * (m + 1)
        if n in (3, 5, 8, 10):
            _, counted = det_cofactor(rng.standard_normal((n, n)))
            cramer_cost = (n + 1) * m
            elim_cost = n**3 // 3
            print(
                f"{n:<2d} {cramer_cost:>15d} {elim_cost:>11d} "
                f"{cramer_cost / elim_cost:>8.0f}  递推与计数一致：{m == counted}"
            )


if __name__ == "__main__":
    main()
```

```text
Cramer： [0. 0. 1.]
solve：  [0. 0. 1.]
6 x 6 两种解的最大差： 1.3e-15
n  Cramer 乘法次数  消元 n^3/3  比值
3               36           9        4  递推与计数一致：True
5             1230          41       30  递推与计数一致：True
8           623520         170     3668  递推与计数一致：True
10        68588300         333   205971  递推与计数一致：True
```

对不对：第 1 讲那个方程组的解是 $(0, 0, 1)$，两种方法都给出这个解；6 × 6 的随机方程组两种解最大差 $1.3 \times 10^{-15}$，是舍入误差。Cramer 法则没毛病，毛病在价格。

价格：3 阶时 Cramer 只贵 4 倍；5 阶是 30 倍；8 阶 3668 倍；10 阶 68588300 次乘法对 333 次，差了 205971 倍。最后一列“递推与计数一致”是我的 `det_cofactor` 真的数出来的乘法次数和递推式相等，所以这些数字不是凭公式推的。余子式展开的乘法次数增长得像 $n!$，我猜这就是他说的“大约是永远”。

必须说明一下公平性：上面的 `cramer` 函数里行列式是 `np.linalg.det` 算的，那用的是 LU 分解，不是余子式。Strang 说的灾难是指用定义（余子式或大公式）去算行列式。如果每个行列式也用消元算，$n + 1$ 个行列式就是 $n + 1$ 次消元，大约比直接消元一次贵 $n$ 倍，没有那么夸张，但还是白白多做了 $n$ 倍。这是我按复杂度推的，没测。无论怎样，他的结论成立：MATLAB（NumPy 也一样）绝不会这么干。

那它还有什么用？他的回答我很同意：用字母做代数。逆矩阵和解各个分量的显式公式，可以让你推“某个系数变化时解怎么变”，这是算法告诉不了你的。（我自己的取舍：定理要记，代码不写。）

## 行列式是体积

第三个应用最漂亮。他先说结论：

> $|\det A|$ 等于以 $A$ 的行为边的盒子的体积。

3 × 3 的情况：三行是三个向量，从原点画出去，当作盒子的三条边，补全成平行六面体（他说正式的名字是 parallelepiped，“为了显而易见的原因我写的是 box”）。体积就是 $|\det A|$。符号呢？他说符号告诉我们这个盒子是右手系还是左手系：交换两条边，体积不变，只有顺序的方向反过来。这和第 18 讲的“交换两行，行列式变号”是同一件事。

### 为什么

他的证法是：行列式由三条性质定义（单位阵的行列式是 1，交换两行变号，对每一行线性）。如果体积也满足这三条，它就必须是行列式（取绝对值）。

1. 单位阵：三条边是坐标轴上的单位向量，盒子是单位立方体，体积 1。
2. 正交矩阵 $Q$：$Q^TQ = I$。两边取行列式，$\det(Q^T)\det(Q) = 1$，而 $\det(Q^T) = \det(Q)$，所以 $(\det Q)^2 = 1$，$\det Q = \pm 1$。几何上：$Q$ 的行是互相垂直的单位向量，盒子还是单位立方体，只是转了一下，体积还是 1。
3. 性质 3a：把一条边加倍（保持直角），体积加倍；行列式的一行乘 2，行列式也乘 2。
4. 性质 3b：一行拆成两个向量的和，行列式等于两个行列式之和。这一步他没有证完（时间到了）；他在 2 × 2 里把它画成平行四边形，说教材里有一幅仔细的图。

我用代码检查了第 1 到第 3 点的数值，3b 用线性关系检查，并多加了一个剪切：第一行加上第二行的 0.7 倍，盒子被推歪了，体积没有变（第 18 讲的“一行加上另一行的倍数，行列式不变”）。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # 单位立方体与旋转后的立方体
    identity = np.eye(3)
    Q, _ = np.linalg.qr(rng.standard_normal((3, 3)))
    print("Q^T Q = 单位阵：", np.allclose(Q.T @ Q, identity))
    print("det(I) =", round(np.linalg.det(identity), 4))
    print(
        "det(Q) =",
        round(np.linalg.det(Q), 4),
        "，det(Q)^2 =",
        round(np.linalg.det(Q) ** 2, 4),
    )

    # 把第一条边加倍，体积加倍（性质 3a）
    D = Q.copy()
    D[0] *= 2.0
    print("加倍第一行：", round(abs(np.linalg.det(D)), 4))

    # 把一条边改成两条边的和（性质 3b 的线性）
    v = rng.standard_normal(3)
    w = rng.standard_normal(3)
    M_v, M_w, M_sum = Q.copy(), Q.copy(), Q.copy()
    M_v[0], M_w[0], M_sum[0] = v, w, v + w
    lhs = np.linalg.det(M_sum)
    rhs = np.linalg.det(M_v) + np.linalg.det(M_w)
    print("det(v + w 行) 等于两个 det 之和：", np.isclose(lhs, rhs))

    # 剪切：第一行加上第二行的 0.7 倍，盒子歪了，体积不变
    S = Q.copy()
    S[0] += 0.7 * S[1]
    print("剪切后体积：", round(abs(np.linalg.det(S)), 4))


if __name__ == "__main__":
    main()
```

```text
Q^T Q = 单位阵： True
det(I) = 1.0
det(Q) = 1.0 ，det(Q)^2 = 1.0
加倍第一行： 2.0
det(v + w 行) 等于两个 det 之和： True
剪切后体积： 1.0
```

随机生成的 $Q$（来自一个固定种子的 QR 分解）满足 $Q^TQ = I$，$\det Q = 1.0$（这次是 $+1$，换个种子也可能是 $-1$，平方一定是 1）。把一行加倍，体积从 1.0 变成 2.0；剪切后体积仍然是 1.0。拆行那一项两边相等。四条数值检验和他的论证是一一对应的。

### 面积：没有平方根的公式

他最想让我们记住的是 2 × 2 的情形：以 $(a, b)$ 和 $(c, d)$ 为边的平行四边形，面积是

$$
\left|\det\begin{bmatrix} a & b \\ c & d \end{bmatrix}\right| = |ad - bc|
$$

他说，如果去年问你平行四边形的面积，你会说底乘高：先算底边的长度 $\sqrt{a^2 + b^2}$，再算高，里面有更多的平方根和角度，“令人反胃”。现在只有一个 $ad - bc$，没有平方根，没有角度，没有高，只用到坐标。三角形是一半：$\tfrac12 |ad - bc|$。

如果三角形不在原点呢？他给出的是

$$
\text{面积} = \frac12 \left|\det\begin{bmatrix} x_1 & y_1 & 1 \\ x_2 & y_2 & 1 \\ x_3 & y_3 & 1 \end{bmatrix}\right|
$$

“只给六个数就能定面积”。他的解释是：第 2 行减第 1 行，第 3 行减第 1 行，最后一列就被消掉，剩下的是两条边向量的 2 × 2 行列式，相当于把三角形平移到了原点（这一步他讲得很快，教材有图）。

我分别用底乘高和行列式算平行四边形的面积，再用 3 × 3 行列式和平移后的 2 × 2 行列式算同一个三角形，最后算一个 3 维盒子的体积，并用标量三重积对照：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 平行四边形：两条边是 A 的两行
    A = np.array([[3.0, 1.0], [1.0, 2.0]])
    u, v = A[0], A[1]
    base = np.linalg.norm(u)
    # 底乘高：v 在 u 垂直方向上的分量长度就是高
    height = np.linalg.norm(v - (u @ v) / (u @ u) * u)
    print("det =", round(np.linalg.det(A), 4))
    print(
        "底 x 高 =",
        round(base * height, 4),
        "，底 =",
        round(base, 4),
        "，高 =",
        round(height, 4),
    )

    # 三角形：三个顶点任意放，面积 = |det [[x, y, 1], ...]| / 2
    P = np.array([[1.0, 1.0], [5.0, 2.0], [2.0, 4.0]])
    T = np.hstack([P, np.ones((3, 1))])
    area = abs(np.linalg.det(T)) / 2
    # 对照：平移到原点后取两条边，面积是 |det| / 2
    edges = np.array([P[1] - P[0], P[2] - P[0]])
    print("三角形面积（3 x 3 行列式）=", round(area, 4))
    print(
        "三角形面积（平移后 2 x 2）=", round(abs(np.linalg.det(edges)) / 2, 4)
    )

    # 三维：三行是盒子的三条边，体积是 |det|
    B = np.array([[1.0, 0.0, 0.0], [1.0, 2.0, 0.0], [1.0, 1.0, 3.0]])
    print("盒子体积 =", round(abs(np.linalg.det(B)), 4))
    # 对照：标量三重积 u . (v x w)
    print("三重积 =", round(B[0] @ np.cross(B[1], B[2]), 4))
    # 交换两条边，体积不变，符号反过来
    B_swap = B[[1, 0, 2]]
    print("交换两行后 det =", round(np.linalg.det(B_swap), 4))


if __name__ == "__main__":
    main()
```

```text
det = 5.0
底 x 高 = 5.0 ，底 = 3.1623 ，高 = 1.5811
三角形面积（3 x 3 行列式）= 5.5
三角形面积（平移后 2 x 2）= 5.5
盒子体积 = 6.0
三重积 = 6.0
交换两行后 det = -6.0
```

平行四边形的两条边是 $(3, 1)$ 和 $(1, 2)$：行列式是 5.0。底乘高这条路要先算底 $\sqrt{10} \approx 3.1623$，再用投影减掉平行分量求出高 1.5811，乘出来也是 5.0，只是多绕了一圈，还要投影（第 15 讲的东西）。三角形用 3 × 3 行列式和平移后的 2 × 2 都得到 5.5。盒子的体积 6.0 与三重积相同，交换两行之后行列式变成 $-6.0$，体积还是 6。

下面这幅图把前两个例子画了出来：

![左：以 A 的两行 (3, 1) 与 (1, 2) 为边的平行四边形，面积是 |det A| = 5。右：顶点为 (1, 1)、(5, 2)、(2, 4) 的三角形，面积是 5.5](/assets/images/linear-algebra/l20-area.svg)

上面这张图由下面这个脚本生成（需要 matplotlib，在当前目录写出 SVG；图中的数据与前面的代码块相同）：

```python
import matplotlib
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Polygon


def main() -> None:
    matplotlib.use("Agg")
    plt.rcParams["svg.hashsalt"] = "la1806"

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10, 4))

    # 左：平行四边形，两条边是 A 的两行，面积 = |det A|
    A = np.array([[3.0, 1.0], [1.0, 2.0]])
    u, v = A[0], A[1]
    area = abs(np.linalg.det(A))
    ax1.add_patch(
        Polygon(
            [[0, 0], u, u + v, v],
            closed=True,
            fc="#9ecae1",
            ec="#2171b5",
            alpha=0.7,
        )
    )
    for w, name, off in [
        (u, "row 1 = (3, 1)", (0.1, -0.35)),
        (v, "row 2 = (1, 2)", (-1.5, 0.1)),
    ]:
        ax1.annotate(
            "",
            xy=w,
            xytext=(0, 0),
            arrowprops=dict(arrowstyle="->", color="#08519c", lw=2),
        )
        ax1.text(w[0] + off[0], w[1] + off[1], name, color="#08519c")
    ax1.text(1.6, 1.6, f"area = |det A| = {area:.0f}", ha="center")
    ax1.set_xlim(-0.8, 5.2)
    ax1.set_ylim(-0.8, 3.8)
    ax1.set_aspect("equal")
    ax1.set_title("Parallelogram from the rows of A")
    ax1.grid(alpha=0.3)

    # 右：任意位置的三角形，面积 = |det [[x, y, 1], ...]| / 2
    P = np.array([[1.0, 1.0], [5.0, 2.0], [2.0, 4.0]])
    T = np.hstack([P, np.ones((3, 1))])
    tri = abs(np.linalg.det(T)) / 2
    ax2.add_patch(
        Polygon(P, closed=True, fc="#fdd0a2", ec="#d94801", alpha=0.7)
    )
    for x, y in P:
        ax2.plot(x, y, "o", color="#d94801")
        ax2.text(x + 0.1, y - 0.3, f"({x:.0f}, {y:.0f})")
    ax2.text(2.9, 2.4, f"area = {tri:.1f}", ha="center")
    ax2.set_xlim(-0.8, 6.2)
    ax2.set_ylim(-0.8, 5.2)
    ax2.set_aspect("equal")
    ax2.set_title("Triangle: |det [x y 1]| / 2")
    ax2.grid(alpha=0.3)

    fig.tight_layout()
    fig.savefig(
        "l20-area.svg",
        metadata={"Date": None},
    )


if __name__ == "__main__":
    main()
```

我觉得这一讲有个有趣的转折：他对 Cramer 法则不以为然，对面积公式却说“very impressed”。同一个行列式，一个是你知道有、但不会用的公式，另一个是以后你无数次会用到的几何。后者在下一讲会以特征值的形式继续出现：特征值的乘积是行列式，而行列式是体积缩放的倍数。

下一讲他说开始学特征值，“我们真正进入大课题了”。行列式这三讲到这里为止，接下来 $\det(A - \lambda I) = 0$ 会成为最常写的一个式子：[18.06 第 21 讲：特征值与特征向量](/posts/linear-algebra-21-eigenvalues-eigenvectors/)。
