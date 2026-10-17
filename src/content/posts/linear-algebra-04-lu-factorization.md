---
title: "18.06 第 4 讲：分解成 A = LU"
commentId: "post:linear-algebra-04-lu-factorization"
published: "2026-10-18 09:00:00 +08:00"
description: "MIT 18.06 第 4 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 手写了不换行的 LU 分解，数出 n = 160 时共 1365280 次乘除，是 n³/3 的 1.000 倍，而每多一个右端项只多 n² 次。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - LU 分解
  - 消元
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 4
draft: false
comment: true
slug: linear-algebra-04-lu-factorization
---

消元的每一步都是一次左乘 $E$，把它们连乘起来是 $EA = U$，但 Strang 这一讲要你把 $E$ 搬到等号的另一边：$A = LU$。搬过去以后有一件很舒服的事：消元时用过的乘数，原样坐进 $L$ 里，一个都不会被搅乱，我手写的分解不需要求任何一个逆。他还顺手数了一遍消元要花多少次运算，我在 $n = 160$ 的随机矩阵上实测是 1365280 次乘除，是 $n^3/3 = 1365333$ 的 1.000 倍。

> [!NOTE] 本讲速览
> 视频：[Lecture 4: Factorization into A = LU](https://www.youtube.com/watch?v=MsIvs_6vC38)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-4-factorization-into-a-lu/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §2.3 Matrix Computations and A = LU
> 前置：[第 3 讲：矩阵乘法的四种看法与逆矩阵](/posts/linear-algebra-03-multiplication-and-inverse/)
> 一句话：$A = LU$ 里 $L$ 就是消元乘数的记录本，分解一次的代价是 $n^3/3$，之后每个右端项只要 $n^2$。

> [!TIP] 配合视频
> - 开头他先补了上一讲欠的“乘积的逆”和“转置的逆”，各只有几分钟，本篇第一节用代码验过，可以倍速。
> - 三阶的那段要认真看：他故意取 $E_{21}$ 里是 $-2$、$E_{32}$ 里是 $-5$，让你亲眼看到 $E$ 的乘积里冒出一个 10，而 $L$ 里没有。这是整讲的要点。
> - 数运算次数那一段，他一边说一边把 $n^2 + (n-1)^2 + \cdots + 1^2$ 写出来，再请出微积分。值得听，本篇用计数器重算了一遍。
> - 最后列六个 $3 \times 3$ 置换矩阵的那段是课堂互动，节奏较慢，本篇最后一节已经枚举过，可以快进。

## 先还一笔债：乘积的逆与转置的逆

他的第一件事，是补上一讲留下的问题：知道 $A^{-1}$ 和 $B^{-1}$，$AB$ 的逆是什么？答案是 $B^{-1}A^{-1}$，顺序反过来。验证只要把括号挪一挪：

$$
(AB)(B^{-1}A^{-1}) = A(BB^{-1})A^{-1} = AA^{-1} = I
$$

他说教材里的例子是穿鞋穿袜（先脱鞋再脱袜，所以复原的时候先穿袜再穿鞋），然后为这个“愚蠢的例子”道了歉，还说很遗憾被录进了磁带。我留着它，毕竟这个顺序错了真的会出错。

转置的逆同样简单：从 $AA^{-1} = I$ 两边取转置，单位矩阵转置还是单位矩阵，左边顺序又要反过来，得到 $(A^{-1})^T A^T = I$。所以 $(A^T)^{-1} = (A^{-1})^T$：先转置再求逆，和先求逆再转置，是一回事。下面用两个随机的 $3 \times 3$ 矩阵验证这两句话，顺便看看“忘了反过来”会怎样：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    A = rng.standard_normal((3, 3))
    B = rng.standard_normal((3, 3))
    inv_AB = np.linalg.inv(A @ B)
    inv_A = np.linalg.inv(A)
    inv_B = np.linalg.inv(B)

    # 乘积的逆：顺序要反过来
    print("inv(AB) = inv(B) inv(A)：", np.allclose(inv_AB, inv_B @ inv_A))
    print("inv(AB) = inv(A) inv(B)：", np.allclose(inv_AB, inv_A @ inv_B))

    # 转置的逆：先转置还是先求逆都一样
    print("inv(A.T) = inv(A).T：", np.allclose(np.linalg.inv(A.T), inv_A.T))


if __name__ == "__main__":
    main()
```

```text
inv(AB) = inv(B) inv(A)： True
inv(AB) = inv(A) inv(B)： False
inv(A.T) = inv(A).T： True
```

`inv(A) @ inv(B)` 的那一行是 `False`。随机矩阵一般不交换，$A^{-1}B^{-1}$ 不是 $AB$ 的逆，顺序是认真的。

## 2 × 2：把 E 的逆放到另一边

接下来是整讲的核心。设 $A$ 可逆，消元不需要换行，主元位置上也没有 0，那么从 $A$ 一路消元到上三角的 $U$，两者之间必然有一个矩阵 $L$ 把它们连起来。他先拿 $2 \times 2$ 练手：

$$
A = \begin{bmatrix} 2 & 1 \\ 8 & 7 \end{bmatrix}
$$

第一个主元是 2，乘数是 4。他特意解释了为什么右下角取 7：如果取 4，第二个主元就没有了，矩阵是奇异的（他的原话是“general screw-up”）。第二行减去 4 倍的第一行，右下角变成 3：

$$
E_{21}A = \begin{bmatrix} 1 & 0 \\ -4 & 1 \end{bmatrix}
\begin{bmatrix} 2 & 1 \\ 8 & 7 \end{bmatrix}
= \begin{bmatrix} 2 & 1 \\ 0 & 3 \end{bmatrix} = U
$$

现在两边同时左乘 $E_{21}^{-1}$，$A$ 单独留在一边：$A = E_{21}^{-1}U$，这个 $E_{21}^{-1}$ 就是 $L$。消元矩阵的逆很好求：把负号换成正号，“减掉的又加回去”。所以 $L = \begin{bmatrix} 1 & 0 \\ 4 & 1 \end{bmatrix}$，$A = LU$ 写出来是

$$
\begin{bmatrix} 2 & 1 \\ 8 & 7 \end{bmatrix}
= \begin{bmatrix} 1 & 0 \\ 4 & 1 \end{bmatrix}
\begin{bmatrix} 2 & 1 \\ 0 & 3 \end{bmatrix}
$$

他提到 $L$ 的字母来自 lower triangular，对角线上是 1，而 $U$ 的对角线上是主元。有时候想让两边“平衡”一点，可以把主元单独提出来，写成 $A = LDU'$：$D$ 是主元组成的对角矩阵，$U'$ 的对角线也是 1。他说 MATLAB 两种都能给，他自己以后主要用 $LU$：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # Strang 的 2 x 2 例子：A = [[2, 1], [8, 7]]
    A = np.array([[2.0, 1.0], [8.0, 7.0]])
    E21 = np.array([[1.0, 0.0], [-4.0, 1.0]])
    U = E21 @ A
    L = np.linalg.inv(E21) + 0.0  # 加 0.0 是为了不打印 -0.
    print("U =")
    print(U)
    print("L =")
    print(L)
    print("L @ U 等于 A：", np.allclose(L @ U, A))

    # 把主元从 U 里提出来：A = L D U'
    D = np.diag(np.diag(U))
    U1 = np.linalg.inv(D) @ U
    print("D =")
    print(D)
    print("U' =")
    print(U1)
    print("L @ D @ U' 等于 A：", np.allclose(L @ D @ U1, A))


if __name__ == "__main__":
    main()
```

```text
U =
[[2. 1.]
 [0. 3.]]
L =
[[1. 0.]
 [4. 1.]]
L @ U 等于 A： True
D =
[[2. 0.]
 [0. 3.]]
U' =
[[1.  0.5]
 [0.  1. ]]
L @ D @ U' 等于 A： True
```

$U'$ 右上角的 0.5，是把 $U$ 第一行除以主元 2 得到的 $1/2$。第二行除以 3，右上角没有东西可除，所以只剩一个 1。

## 3 × 3：乘数为什么直接落进 L

二阶看不出什么门道，他自己也说这只是练习，差别只在一个是减号、一个是加号。三阶才开始有意思。三步消元依次是：$E_{21}$ 清掉 $(2,1)$ 位置，$E_{31}$ 清掉 $(3,1)$，$E_{32}$ 清掉 $(3,2)$，合起来 $E_{32}E_{31}E_{21}A = U$。要把这些放到另一边，每一个都取逆，**而且顺序要反过来**（这就是开头那条规则的用处）：

$$
A = E_{21}^{-1}E_{31}^{-1}E_{32}^{-1}\,U = LU
$$

为什么要这么麻烦？他取了一个很小的例子来说明。设 $E_{21}$ 里是 $-2$，$E_{31}$ 是单位矩阵（$(3,1)$ 位置本来就是 0，不用消），$E_{32}$ 里是 $-5$。先看 $E = E_{32}E_{21}$：

$$
E = \begin{bmatrix} 1 & 0 & 0 \\ 0 & 1 & 0 \\ 0 & -5 & 1 \end{bmatrix}
\begin{bmatrix} 1 & 0 & 0 \\ -2 & 1 & 0 \\ 0 & 0 & 1 \end{bmatrix}
= \begin{bmatrix} 1 & 0 & 0 \\ -2 & 1 & 0 \\ 10 & -5 & 1 \end{bmatrix}
$$

左下角冒出了一个 10。他说他不喜欢这个 10（当然它是对的，他只是不想看到它）：第二行减了 2 倍的第一行，第三行再减 5 倍的新第二行，那么第一行实际上有 $2 \times 5 = 10$ 份被“扔”进了第三行。$E_{31}$ 本来是单位矩阵，但这个 10 就在 $(3,1)$ 位置上，和它毫无关系。

反过来，按逆矩阵的顺序乘：$L = E_{21}^{-1}E_{32}^{-1}$，每个逆里是 $+2$ 和 $+5$，乘出来是 $\begin{bmatrix} 1 & 0 & 0 \\ 2 & 1 & 0 \\ 0 & 5 & 1 \end{bmatrix}$：2 和 5 各在自己的位置上，没有 10。用他的话说，“按正确的顺序，乘数就直接坐在 $L$ 里”。

所以要得到 $L$，没有任何额外的工作：消元时每用一个乘数 $\ell_{ij}$，就把它记在 $L$ 的 $(i,j)$ 位置，再没有别的。他还补了一句我觉得很实用的话：消元做完第二行以后，你已经造出了 $U$ 的第二行和对应的乘数，这两样都要留下，而 $A$ 自己可以扔了。据我所知，实际的库就是这么存的：$L$ 和 $U$ 合起来恰好塞进 $A$ 原来的那块内存（$L$ 的对角线是 1，不用存）。

我造了一个 $A$，让三个乘数恰好是 2、0、5。下面的脚本先照黑板的写法把 $E$ 乘出来，再手写一个不选主元的 LU：它不求逆，乘数直接记进 $L$，最后用求逆得到的 $L$ 来对照：

```python
import numpy as np


def lu_nopivot(A: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """不换行的消元：乘数直接记进 L，消元结果留在 U。"""
    n = A.shape[0]
    L = np.eye(n)
    U = A.astype(float).copy()
    for k in range(n - 1):
        if np.isclose(U[k, k], 0.0):
            raise ZeroDivisionError(f"第 {k} 个主元是 0，需要换行")
        for i in range(k + 1, n):
            L[i, k] = U[i, k] / U[k, k]  # 乘数
            U[i, k:] -= L[i, k] * U[k, k:]
    return L, U


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 构造一个乘数恰好是 2、0、5 的 A（对应 E21 = -2，E31 = 0，E32 = -5）
    A = np.array([[1.0, 2.0, 1.0], [2.0, 5.0, 4.0], [0.0, 5.0, 11.0]])

    # 先按黑板上的写法，把三步消元写成三个矩阵
    E21 = np.array([[1.0, 0.0, 0.0], [-2.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
    E32 = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -5.0, 1.0]])
    E = E32 @ E21
    print("E32 @ E21 =")
    print(E)
    print("E @ A =")
    print(E @ A)

    # 把它们的逆按相反的顺序乘起来
    L_from_inverses = np.linalg.inv(E21) @ np.linalg.inv(E32)
    print("inv(E21) @ inv(E32) =")
    print(L_from_inverses)

    # 手写 LU：不求逆，乘数直接落进 L
    L, U = lu_nopivot(A)
    print("手写 L =")
    print(L)
    print("手写 U =")
    print(U)
    print("L 与逆矩阵乘出来的一致：", np.allclose(L, L_from_inverses))
    print("U 与 E @ A 一致：", np.allclose(U, E @ A))
    print("L @ U 等于 A：", np.allclose(L @ U, A))

    # 同一个 L、U 反复使用：先 L c = b，再 U x = c
    rng = np.random.default_rng(1806)
    B = rng.standard_normal((3, 4))  # 四个右端项
    X = np.linalg.solve(U, np.linalg.solve(L, B))
    print("四个右端项都解对了：", np.allclose(A @ X, B))
    print(
        "和 np.linalg.solve(A, B) 一致：",
        np.allclose(X, np.linalg.solve(A, B)),
    )


if __name__ == "__main__":
    main()
```

```text
E32 @ E21 =
[[ 1.  0.  0.]
 [-2.  1.  0.]
 [10. -5.  1.]]
E @ A =
[[1. 2. 1.]
 [0. 1. 2.]
 [0. 0. 1.]]
inv(E21) @ inv(E32) =
[[1. 0. 0.]
 [2. 1. 0.]
 [0. 5. 1.]]
手写 L =
[[1. 0. 0.]
 [2. 1. 0.]
 [0. 5. 1.]]
手写 U =
[[1. 2. 1.]
 [0. 1. 2.]
 [0. 0. 1.]]
L 与逆矩阵乘出来的一致： True
U 与 E @ A 一致： True
L @ U 等于 A： True
四个右端项都解对了： True
和 np.linalg.solve(A, B) 一致： True
```

`E32 @ E21` 的左下角确实是 10，而手写分解得到的 $L$ 里是 2、0、5，和 `inv(E21) @ inv(E32)` 一致。`U` 与 `E @ A` 一致，`L @ U` 还原 $A$。最后两行演示了分解的用处：$A$ 只分解一次，之后每个右端项只要解 $L\mathbf{c} = \mathbf{b}$ 和 $U\mathbf{x} = \mathbf{c}$ 两个三角方程。（这里我偷懒用了 `np.linalg.solve`，它并不知道矩阵是三角的，所以没有省运算。真正省了多少，下一节数给你看。）

## 消元要花多少次运算

他说今天是“实用的一天”，然后问了一个很朴素的问题：$n \times n$ 的矩阵，消元要多少步？$n = 1000$ 能不能在一秒、一分钟还是一周内解完？更大的 $n$ 呢？他列了几个候选：正比于 $n$，$n^2$，$n^3$，或者像行列式那样 $n!$（他顺手给行列式记了一笔坏账）。

他的算法是这样想的：把一次“乘一个乘数再减”算作一次运算。第一步，除了第一行以外的所有行都要改，大约 $n^2$ 个数。第二步，问题缩小成 $(n-1) \times (n-1)$，大约 $(n-1)^2$。以此类推，总数大约是

$$
n^2 + (n-1)^2 + \cdots + 2^2 + 1^2 \approx \frac{1}{3}n^3
$$

有 $n$ 项，最大的一项是 $n^2$，所以上界是 $n^3$，但因为后面的项越来越小，实际上只有三分之一。他说这时可以“允许提一下微积分”：求和和积分差不多，$\int_0^n x^2\,dx = n^3/3$（他还补了一句：他不是不喜欢 18.01，不过 18.06 更好）。

右端项 $\mathbf{b}$ 是一个单独的列，所以便宜得多：一次前代和一次回代合起来是 $n^2$。他的结论是：如果同一个 $A$ 有很多个右端项，那就一次性付高价 $n^3/3$ 做 $A = LU$，之后每个右端项只付 $n^2$。

我用计数器验证。为了让每次运算都被算到，我写了一个会数数的 LU：每步消元，除法的次数是剩下的行数，乘法的次数是剩下的子矩阵里元素的个数。再写一个前代加回代，也数运算。随机矩阵加上 $nI$ 保证对角占优，不选主元也不会遇到 0：

```python
import numpy as np


def lu_count(A: np.ndarray) -> tuple[np.ndarray, np.ndarray, int]:
    """不换行的 LU，同时数乘法和除法的次数。"""
    n = A.shape[0]
    L = np.eye(n)
    U = A.astype(float).copy()
    count = 0
    for k in range(n - 1):
        L[k + 1 :, k] = U[k + 1 :, k] / U[k, k]
        count += n - k - 1  # 这一步的除法
        update = np.outer(L[k + 1 :, k], U[k, k + 1 :])
        U[k + 1 :, k + 1 :] -= update
        U[k + 1 :, k] = 0.0
        count += update.size  # 这一步的乘法
    return L, U, count


def solve_count(L: np.ndarray, U: np.ndarray, b: np.ndarray) -> int:
    """前代加回代解 LU x = b，返回乘法和除法的次数。"""
    n = L.shape[0]
    count = 0
    c = np.zeros(n)
    for i in range(n):  # L 的对角线是 1，不用除
        c[i] = b[i] - L[i, :i] @ c[:i]
        count += i
    x = np.zeros(n)
    for i in range(n - 1, -1, -1):
        x[i] = (c[i] - U[i, i + 1 :] @ x[i + 1 :]) / U[i, i]
        count += n - i  # n - 1 - i 次乘法，加一次除法
    assert np.allclose(L @ U @ x, b)
    return count


def main() -> None:
    rng = np.random.default_rng(1806)
    print("n, LU 乘除次数, n^3/3, 比值, 每个右端项, 除以 n^2, 相对上一行")
    previous = 0
    for n in [10, 20, 40, 80, 160]:
        A = rng.standard_normal((n, n)) + n * np.eye(n)  # 不选主元也安全
        L, U, count = lu_count(A)
        assert np.allclose(L @ U, A)
        solve = solve_count(L, U, rng.standard_normal(n))
        growth = f"{count / previous:.2f}" if previous else "-"
        print(
            f"{n}, {count}, {n**3 / 3:.0f}, {count / (n**3 / 3):.3f}, "
            f"{solve}, {solve / n**2:.3f}, {growth}"
        )
        previous = count


if __name__ == "__main__":
    main()
```

```text
n, LU 乘除次数, n^3/3, 比值, 每个右端项, 除以 n^2, 相对上一行
10, 330, 333, 0.990, 100, 1.000, -
20, 2660, 2667, 0.998, 400, 1.000, 8.06
40, 21320, 21333, 0.999, 1600, 1.000, 8.02
80, 170640, 170667, 1.000, 6400, 1.000, 8.00
160, 1365280, 1365333, 1.000, 25600, 1.000, 8.00
```

几个数字：

- $n = 10$ 时 330 次，$n^3/3 \approx 333$。我算过，$n$ 阶的精确值是 $(n^3 - n)/3$，$n = 10$ 时正好是 $(1000 - 10)/3 = 330$，所以 $n^3/3$ 是首项，丢掉的 $-n/3$ 随着 $n$ 变大越来越不重要。到 $n = 160$ 时，实测与 $n^3/3$ 的比值已经是 1.000。
- 每次把 $n$ 加倍，次数乘以 8.00（$n=10$ 到 $20$ 是 8.06，之后是 8.02、8.00、8.00），正是他问“把一百变成两百，是 2 倍、4 倍还是 8 倍”的答案：8 倍。
- 每个右端项的代价恰好是 $n^2$：$n = 160$ 时是 25600。分解一次是 1365280，是它的 53.3 倍（也就是 $n/3$）。所以只要右端项超过 53 个，分解的“高价”就已经不重要了。

他问的 1000 阶，我用这条公式估一下：$1000^3/3 \approx 3.3 \times 10^8$ 次乘除，我猜现在的机器一眨眼就算完了，但 1999 年他在教室里问这个问题的时候，大概是真的要想一想。（他没有给确切的时间，这是我的猜测。）

另外他说明了一个前提：这个计数针对稠密矩阵，也就是假设没有 0。如果矩阵里 0 摆在好的位置上，那些运算可以直接跳过，会快得多。我上面的实验用的是满的随机矩阵，所以数出来的是最坏的情形，$n^3/3$ 要当成稠密矩阵的价目表来读。

## 要换行的时候：置换矩阵

他在这一讲的最后一段，转向了换行：什么时候要换行？主元位置出现 0 的时候。执行换行的矩阵叫置换矩阵，它们是单位矩阵的行重新排列。他让同学一个一个报出所有 $3 \times 3$ 的置换矩阵：单位矩阵，换第 1、2 行，换第 1、3 行，换第 2、3 行，再加两个把三行轮换的，共 6 个。如果问 $4 \times 4$ 呢？他让大家猜，答案是 24。

他还指出几个事实：两个置换矩阵相乘，还是置换矩阵（做完一些换行再做一些换行，总的来说还是换行）；逆也还在这个集合里，所以它们构成一个“群”；换两行的矩阵，逆是它自己；而且 $P^{-1} = P^T$，他说这是一个“奇怪的事实”，这一讲里只指出，没有证明。下面用 `itertools.permutations` 数一遍，并验证这几件事；最后用一个主元为 0 的矩阵，演示不换行的分解会停在第一步，而先乘一个 $P$ 就能做下去：

```python
import itertools
import math

import numpy as np


def lu_nopivot(A: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    n = A.shape[0]
    L = np.eye(n)
    U = A.astype(float).copy()
    for k in range(n - 1):
        if np.isclose(U[k, k], 0.0):
            raise ZeroDivisionError(f"第 {k} 个主元是 0，需要换行")
        for i in range(k + 1, n):
            L[i, k] = U[i, k] / U[k, k]
            U[i, k:] -= L[i, k] * U[k, k:]
    return L, U


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    identity = np.eye(3)

    # 3 x 3 的置换矩阵：把单位矩阵的行重新排一遍
    perms = [identity[list(p)] for p in itertools.permutations(range(3))]
    print("3 x 3 置换矩阵的个数：", len(perms))
    for n in [4, 5, 6]:
        count = len(list(itertools.permutations(range(n))))
        print(f"{n} x {n}：{count} 个，n! = {math.factorial(n)}")

    # 乘起来还在这个集合里，逆就是转置
    def in_list(M: np.ndarray) -> bool:
        return any(np.array_equal(M, P) for P in perms)

    closed = all(in_list(P @ Q) for P in perms for Q in perms)
    inverse_is_transpose = all(
        np.array_equal(np.linalg.inv(P), P.T) for P in perms
    )
    print("任意两个相乘仍是置换矩阵：", closed)
    print("P 的逆等于 P 的转置：", inverse_is_transpose)

    # 主元位置出现 0：不换行的消元走不下去，先换行就行
    A = np.array([[0.0, 2.0, 1.0], [1.0, 1.0, 1.0], [2.0, 1.0, 3.0]])
    try:
        lu_nopivot(A)
    except ZeroDivisionError as error:
        print("直接分解：", error)
    P = np.array([[0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
    L, U = lu_nopivot(P @ A)
    print("L =")
    print(L)
    print("U =")
    print(U)
    print("P A = L U：", np.allclose(P @ A, L @ U))


if __name__ == "__main__":
    main()
```

```text
3 x 3 置换矩阵的个数： 6
4 x 4：24 个，n! = 24
5 x 5：120 个，n! = 120
6 x 6：720 个，n! = 720
任意两个相乘仍是置换矩阵： True
P 的逆等于 P 的转置： True
直接分解： 第 0 个主元是 0，需要换行
L =
[[ 1.   0.   0. ]
 [ 0.   1.   0. ]
 [ 2.  -0.5  1. ]]
U =
[[1.  1.  1. ]
 [0.  2.  1. ]
 [0.  0.  1.5]]
P A = L U： True
```

输出的第一行是 6，往下 24、120、720 就是 $n!$。他在讲“怎么数运算次数”的时候顺手说过，行列式的代价才是 $n!$。这里的 $n!$ 只是置换矩阵的个数，我们并不会逐个去试它们，消元每一步只选一行。最后一段里 $PA = LU$ 的乘数是 0、2、$-0.5$，和上一节是同一个记账法，只是 $A$ 的行先被 $P$ 换了位置。据我所知，下一讲会把这个形式正式写成 $PA = LU$。

下一讲他说会结束第二章，转到第三章，也就是向量空间。转置和置换的部分在第 5 讲里收尾，同时引入子空间，见 [18.06 第 5 讲：转置、置换与向量空间](/posts/linear-algebra-05-transposes-permutations-spaces/)。（他在这一讲开头就说过，他担心大家以为这门课全是消元。）
