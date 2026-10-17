---
title: "18.06 第 10 讲：四个基本子空间"
commentId: "post:linear-algebra-10-four-fundamental-subspaces"
published: "2026-10-18 11:00:00 +08:00"
description: "MIT 18.06 第 10 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 对 Strang 的 3 × 4 矩阵分别用消元和 SVD 求出四个子空间的基，维数是 2、2、2、1，再用 5 个随机造的不同形状矩阵验证 r、n - r、r、m - r 全部成立。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 四个基本子空间
  - 左零空间
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 10
draft: false
comment: true
slug: linear-algebra-10-four-fundamental-subspaces
---

一个 $m \times n$、秩为 $r$ 的矩阵带着四个子空间：列空间、行空间、零空间、左零空间，维数依次是 $r$、$r$、$n - r$、$m - r$。Strang 在这一讲里把它们的基和维数全部交代清楚，我用他黑板上的 3 × 4 矩阵从消元和 SVD 两条路各求了一遍，得到的维数都是 2、2、2、1。然后我随手造了 5 个形状和秩各不相同的矩阵，$r + (n - r) = n$ 与 $r + (m - r) = m$ 一共 10 次检查，10 次都成立。

> [!NOTE] 本讲速览
> 视频：[Lecture 10: The four fundamental subspaces](https://www.youtube.com/watch?v=nHlE7EgJFds)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-10-the-four-fundamental-subspaces/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §3.5 Dimensions of the Four Subspaces
> 前置：[第 9 讲：线性无关、基与维数](/posts/linear-algebra-09-independence-basis-dimension/)
> 一句话：$\mathbb{R}^n$ 里的行空间（$r$ 维）与零空间（$n - r$ 维）加起来是 $n$ 维，$\mathbb{R}^m$ 里的列空间（$r$ 维）与左零空间（$m - r$ 维）加起来是 $m$ 维。

> [!TIP] 配合视频
> - 开头几分钟他在纠正上一讲的一个错误，本篇第一节用代码把它重算了一遍，想看他怎么自嘲可以看，想赶进度可以倍速。
> - 他从 $[A \; I]$ 消元出 $E$，再从 $E$ 的最后一行读出左零空间的那一段要认真看，这是本讲唯一不能从 $R$ 直接读出来的东西。
> - 他讲维数的那一段只给了结论，行空间的维数是 $r$ 要靠后面用 $R$ 的前 $r$ 行来论证，听的时候留意这一步。
> - 最后几分钟他开始讲“矩阵本身也是向量”，只是引子，具体的维数他说留到下一讲。我在最后一节先数了一遍。

## 先改一个错：三列相关，因为有两行相同

上一讲末尾，他为了说明“基不唯一”，取了三个向量 $(1, 1, 2)$、$(2, 2, 5)$、$(3, 3, 8)$，以为第三个会稍微伸出前两个张成的平面。下课后有学生告诉他：不对，这三个向量线性相关。她并没有去解 $\mathbf{x}$ 的系数，她只是把这三个向量排成矩阵的三列，然后看了一眼：

$$
A = \begin{bmatrix} 1 & 2 & 3 \\ 1 & 2 & 3 \\ 2 & 5 & 8 \end{bmatrix}
$$

前两行一模一样，所以 $A$ 不可逆，三列不可能无关。**为什么看行能知道列的事？** 因为行空间和列空间的维数相同，都等于秩。两行相同，行空间最多 2 维，所以秩最多是 2，三列里最多有两列是独立的。这就是他说的“行告诉了我列的事情”，也是这一讲真正想说的话的预告。

我把这件事算一遍，包括那个他当时懒得去找的组合：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 第 9 讲的错误：三列 (1,1,2)、(2,2,5)、(3,3,8)
    A = np.array([[1.0, 2.0, 3.0], [1.0, 2.0, 3.0], [2.0, 5.0, 8.0]])
    print("A 的秩：", np.linalg.matrix_rank(A), "，det =", np.linalg.det(A))
    print("A 的转置的秩：", np.linalg.matrix_rank(A.T))

    # 学生没有去找组合，而是看到了两行相同；组合其实是 -1 份列一加 2 份列二
    coef, *_ = np.linalg.lstsq(A[:, :2], A[:, 2], rcond=None)
    print("第三列 = 列一和列二的组合，系数：", coef)
    print("验证：", np.allclose(A[:, :2] @ coef, A[:, 2]))

    # 对照：(3, 3, 7) 本来就是列一加列二，(3, 3, 8) 以为能伸出平面
    for last in (7.0, 8.0):
        B = A.copy()
        B[:, 2] = [3.0, 3.0, last]
        print(f"第三列 (3, 3, {last:.0f})：秩 =", np.linalg.matrix_rank(B))


if __name__ == "__main__":
    main()
```

```text
A 的秩： 2 ，det = 0.0
A 的转置的秩： 2
第三列 = 列一和列二的组合，系数： [-1.  2.]
验证： True
第三列 (3, 3, 7)：秩 = 2
第三列 (3, 3, 8)：秩 = 2
```

$A$ 和 $A^\mathsf{T}$ 的秩都是 2。第三列等于 $-1$ 份第一列加 $2$ 份第二列：$-(1, 1, 2) + 2(2, 2, 5) = (3, 3, 8)$，系数 $(-1, 2)$ 是最小二乘返回的，验证为 `True`。最后两行对比他的两个版本：$(3, 3, 7)$ 和 $(3, 3, 8)$ 的秩都是 2，因为只要前两行相同，第三列无论怎么改都不会让秩升到 3。他当时的直觉是对的（$(3, 3, 7)$ 确实是前两列之和），错在以为改个 8 就能伸出平面，却没看那两行。

## 四个子空间，两个大空间

$m \times n$ 的矩阵 $A$ 对应四个子空间：

| 子空间 | 记号 | 是什么 | 住在 | 维数 |
| --- | --- | --- | --- | --- |
| 列空间 | $C(A)$ | 列的所有组合 | $\mathbb{R}^m$ | $r$ |
| 零空间 | $N(A)$ | $A\mathbf{x} = \mathbf{0}$ 的所有解 | $\mathbb{R}^n$ | $n - r$ |
| 行空间 | $C(A^\mathsf{T})$ | 行的所有组合 | $\mathbb{R}^n$ | $r$ |
| 左零空间 | $N(A^\mathsf{T})$ | $A^\mathsf{T}\mathbf{y} = \mathbf{0}$ 的所有解 | $\mathbb{R}^m$ | $m - r$ |

**“行空间”为什么写成 $C(A^\mathsf{T})$？** 行是横着躺的，他偏好所有向量都站着，于是把 $A$ 转置，行就变成了列：行空间就是 $A^\mathsf{T}$ 的列空间，数学上什么也没发生，只是让躺着的向量站起来。

归属的规则很好记：看向量有几个分量。$A\mathbf{x}$ 里的 $\mathbf{x}$ 有 $n$ 个分量，所以零空间在 $\mathbb{R}^n$；$A$ 的每一行有 $n$ 个分量，行空间也在 $\mathbb{R}^n$；$A$ 的每一列有 $m$ 个分量，列空间在 $\mathbb{R}^m$；$A^\mathsf{T}\mathbf{y} = \mathbf{0}$ 里的 $\mathbf{y}$ 有 $m$ 个分量，左零空间也在 $\mathbb{R}^m$。（他说第四个子空间一直受着“二等公民”的待遇，不应该被挤到一边。我读到这里替它觉得有点委屈。）

他先给了维数的“短答案”：

- 列空间：基是 $A$ 的主列，维数是秩 $r$。
- 零空间：基是特解，每个自由变量一个，所以维数是 $n - r$。
- 行空间：维数也是 $r$。
- 左零空间：$A^\mathsf{T}$ 是 $n \times m$ 的矩阵，有 $m$ 列，同一条规则“主变量加自由变量等于列数”，所以维数是 $m - r$。

我觉得最好记的方式是把它看成预算：$n$ 个变量的预算里，$r$ 个被方程占用（主变量），剩下的 $n - r$ 个自由支配（自由变量），总数不变。$A^\mathsf{T}$ 有 $m$ 个变量，同样的预算表再用一遍。

## 一次消元，四个基

“短答案”只给了数字，接下来他要拿基来证明它们。他用的矩阵是上一讲末尾的 $3 \times 4$ 例子：

$$
A = \begin{bmatrix} 1 & 2 & 3 & 1 \\ 1 & 1 & 2 & 1 \\ 1 & 2 & 3 & 1 \end{bmatrix}
$$

他做的消元是：第二行减第一行，第三行减第一行，第二行乘 $-1$，再从第一行里减去两份第二行，得到

$$
R = \begin{bmatrix} 1 & 0 & 1 & 1 \\ 0 & 1 & 1 & 0 \\ 0 & 0 & 0 & 0 \end{bmatrix}
$$

主列是第 1、2 列，$r = 2$。前三个子空间的基就在这里：

- **列空间**：$A$ 的主列，也就是 $A$ 的第 1、2 列。注意是 $A$ 的，不是 $R$ 的。
- **行空间**：$R$ 的前 $r$ 行，$(1, 0, 1, 1)$ 和 $(0, 1, 1, 0)$。
- **零空间**：特解，第三、第四列是自由列，各给一个特解。

第四个，左零空间，在 $R$ 里看不出来。他想到的办法是回忆 Gauss-Jordan：在 $A$ 右边接一个单位矩阵，消元一路做下去，$[A \; I]$ 变成 $[R \; E]$。$E$ 是一个 $m \times m$ 矩阵，记着从 $A$ 到 $R$ 的全部行操作，所以 $EA = R$。方阵可逆时 $R = I$，$E$ 就是 $A^{-1}$；现在 $A$ 是长方形，$E$ 不再是逆，但它仍然是那个把 $A$ 变成 $R$ 的矩阵。

下面的脚本自己写了一个 `rref`（只在前 $n$ 列里找主元，不然接在后面的单位矩阵会被一起“约化”，得到的就不是 Strang 的 $E$ 了），然后一次性读出四个基，并逐个验证：

```python
import numpy as np


def rref(
    M: np.ndarray, ncols: int, tol: float = 1e-10
) -> tuple[np.ndarray, list[int]]:
    """对 M 做 Gauss-Jordan 消元，只在前 ncols 列里找主元。"""
    R = M.astype(float).copy()
    m = R.shape[0]
    pivots: list[int] = []
    row = 0
    for col in range(ncols):
        if row == m:
            break
        found = np.nonzero(np.abs(R[row:, col]) > tol)[0]
        if found.size == 0:
            continue
        p = row + found[0]
        R[[row, p]] = R[[p, row]]
        R[row] /= R[row, col]
        for i in range(m):
            if i != row:
                R[i] -= R[i, col] * R[row]
        pivots.append(col)
        row += 1
    return R, pivots


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array(
        [[1.0, 2.0, 3.0, 1.0], [1.0, 1.0, 2.0, 1.0], [1.0, 2.0, 3.0, 1.0]]
    )
    m, n = A.shape

    # [A I] 消元成 [R E]，E 记录了从 A 到 R 的全部行操作
    RE, pivots = rref(np.hstack([A, np.eye(m)]), n)
    R, E = RE[:, :n], RE[:, n:]
    r = len(pivots)
    print("R =\n", R + 0.0)
    print("E =\n", E + 0.0)
    print(
        "主列：", pivots, "，r =", r, "，E @ A == R：", np.allclose(E @ A, R)
    )

    # 列空间：A 的主列（是 A 的，不是 R 的）
    col_basis = A[:, pivots]
    # 行空间：R 的前 r 行
    row_basis = R[:r]
    # 零空间：每个自由变量一个特解
    free = [j for j in range(n) if j not in pivots]
    N = np.zeros((n, len(free)))
    for k, j in enumerate(free):
        N[j, k] = 1.0
        N[pivots, k] = -R[:r, j]
    # 左零空间：E 的后 m - r 行
    left_basis = E[r:].T

    print("列空间的基（列）：\n", col_basis)
    print("行空间的基（行）：\n", row_basis + 0.0)
    print("零空间的基（列）：\n", N)
    print("左零空间的基（列）：\n", left_basis)

    print("A @ N == 0：", np.allclose(A @ N, 0))
    print("A.T @ y == 0：", np.allclose(A.T @ left_basis, 0))
    dims = [col_basis.shape[1], row_basis.shape[0], N.shape[1]]
    dims.append(left_basis.shape[1])
    print("四个维数：", dims, "，期望：", [r, r, n - r, m - r])

    # 行操作不改变行空间，但改变了列空间
    same_rows = np.linalg.matrix_rank(np.vstack([A, R]))
    print("A 与 R 的行叠在一起的秩（等于 r 就是同一个行空间）：", same_rows)
    probe = np.column_stack([R[:, pivots], A[:, 0]])
    print(
        "A 的第一列放进 R 的列空间后的秩（大于 r 就是跑出去了）：",
        np.linalg.matrix_rank(probe),
    )


if __name__ == "__main__":
    main()
```

```text
R =
 [[1. 0. 1. 1.]
 [0. 1. 1. 0.]
 [0. 0. 0. 0.]]
E =
 [[-1.  2.  0.]
 [ 1. -1.  0.]
 [-1.  0.  1.]]
主列： [0, 1] ，r = 2 ，E @ A == R： True
列空间的基（列）：
 [[1. 2.]
 [1. 1.]
 [1. 2.]]
行空间的基（行）：
 [[1. 0. 1. 1.]
 [0. 1. 1. 0.]]
零空间的基（列）：
 [[-1. -1.]
 [-1.  0.]
 [ 1.  0.]
 [ 0.  1.]]
左零空间的基（列）：
 [[-1.]
 [ 0.]
 [ 1.]]
A @ N == 0： True
A.T @ y == 0： True
四个维数： [2, 2, 2, 1] ，期望： [2, 2, 2, 1]
A 与 R 的行叠在一起的秩（等于 r 就是同一个行空间）： 2
A 的第一列放进 R 的列空间后的秩（大于 r 就是跑出去了）： 3
```

$R$ 与他在黑板上得到的完全一样，$E$ 也是他写的 $\begin{bmatrix} -1 & 2 & 0 \\ 1 & -1 & 0 \\ -1 & 0 & 1 \end{bmatrix}$。`E @ A == R` 为真，所以 $E$ 确实记录了所有行操作。

**左零空间在哪里？** 它是 $E$ 的最后 $m - r = 1$ 行：$(-1, 0, 1)$。含义是“$-1$ 份第一行加 $1$ 份第三行等于零行”，第一行和第三行相同，当然如此。脚本里 `A.T @ left_basis` 全是零，验证了 $A^\mathsf{T}\mathbf{y} = \mathbf{0}$。

**为什么叫“左”零空间？** 把 $A^\mathsf{T}\mathbf{y} = \mathbf{0}$ 两边转置，得到 $\mathbf{y}^\mathsf{T}A = \mathbf{0}^\mathsf{T}$：$\mathbf{y}^\mathsf{T}$ 是一个行向量，从左边乘在 $A$ 上。零空间是“列的哪些组合给出零列”，左零空间是“行的哪些组合给出零行”。他的约定是不写成行向量，仍然写 $A^\mathsf{T}\mathbf{y} = \mathbf{0}$，让向量都站着。

输出的最后四个维数是 $[2, 2, 2, 1]$，和 $[r, r, n - r, m - r] = [2, 2, 2, 1]$ 吻合。（这个例子有点不够区分，因为 $r = n - r = 2$，下面的随机矩阵会补上这个漏洞。）

## 行操作保住的是行空间，不是列空间

他还特意问了一个问题：$A$ 和 $R$ 的行空间、列空间各自一样吗？

- **行空间一样。** 每一步行操作都是“把一行减去另一行的倍数”，结果仍然是原来那些行的组合，所以每一行始终留在行空间里；反过来，每一步可逆，倒着做回去，$A$ 的行也都是 $R$ 的行的组合。两组行张成同一个空间。所以 $R$ 的前 $r$ 行是 $A$ 的行空间的基：它们属于这个空间，彼此独立，个数恰好是 $r$。这也就解释了为什么“行空间的维数是 $r$”：主元有 $r$ 个，非零行就有 $r$ 个。
- **列空间不一样。** $(1, 1, 1)$ 是 $A$ 的第一列，但 $R$ 的列空间只有前两个分量非零的向量，它够不着 $(1, 1, 1)$。

脚本最后两行用秩验证了这两句话：把 $A$ 和 $R$ 的行叠在一起，秩仍是 2，没有长出新方向，说明行空间相同；把 $A$ 的第一列放进 $R$ 的列空间，秩从 2 升到 3，说明它跑出去了。所以“列空间的基用 $A$ 的主列，行空间的基用 $R$ 的行”这个分工不能搞混：前者必须回到原矩阵，后者必须用化简后的。

## 用 SVD 再算一遍

消元是手算时代的做法，数值上有更稳的一条路。奇异值分解 $A = U \Sigma V^\mathsf{T}$（第 29 讲才会正式讲，这里只拿来用）把四个子空间的标准正交基一次给出来：$U$ 的前 $r$ 列是列空间，后 $m - r$ 列是左零空间；$V$ 的前 $r$ 列是行空间，后 $n - r$ 列是零空间。$r$ 就是大于容差的奇异值个数。

我拿它检验两件事：SVD 的基和消元给出的基是不是张成同一个空间（把两组基并排，秩不增加就说明是），以及维数公式在不同形状、不同秩的矩阵上是不是都成立。后者我用 `default_rng(1806)` 造了 5 个矩阵，每个都是 $m \times r$ 乘 $r \times n$ 的随机矩阵，所以秩是已知的 $r$：

```python
import numpy as np


def four_subspaces(A: np.ndarray, tol: float = 1e-10):
    """用 SVD 给出四个子空间的标准正交基，各以列的形式返回。"""
    U, s, Vt = np.linalg.svd(A)
    r = int(np.sum(s > tol))
    V = Vt.T
    return U[:, :r], V[:, :r], V[:, r:], U[:, r:]


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array(
        [[1.0, 2.0, 3.0, 1.0], [1.0, 1.0, 2.0, 1.0], [1.0, 2.0, 3.0, 1.0]]
    )
    col, row, null, left = four_subspaces(A)
    print(
        "SVD 的四个维数：",
        col.shape[1],
        row.shape[1],
        null.shape[1],
        left.shape[1],
    )

    # 和消元法给出的基张成同一个空间吗？把两组基并排，秩不涨就是同一个
    col_rref = A[:, [0, 1]]
    row_rref = np.array([[1.0, 0.0, 1.0, 1.0], [0.0, 1.0, 1.0, 0.0]])
    null_rref = np.array([[-1.0, -1.0, 1.0, 0.0], [-1.0, 0.0, 0.0, 1.0]]).T
    left_rref = np.array([[-1.0, 0.0, 1.0]]).T
    pairs = [
        ("列空间", col, col_rref),
        ("行空间", row, row_rref.T),
        ("零空间", null, null_rref),
        ("左零空间", left, left_rref),
    ]
    for name, svd_basis, rref_basis in pairs:
        stacked = np.hstack([svd_basis, rref_basis])
        print(
            name,
            "并排后的秩：",
            np.linalg.matrix_rank(stacked),
            "，SVD 的基是标准正交的：",
            np.allclose(svd_basis.T @ svd_basis, np.eye(svd_basis.shape[1])),
        )

    # 随机造不同形状、不同秩的矩阵，验证 r、n - r、r、m - r
    rng = np.random.default_rng(1806)
    print("  m   n   r | 列  行  零  左 | 行+零=n  列+左=m")
    for m, n, r in [(3, 6, 2), (5, 3, 3), (4, 4, 4), (6, 5, 1), (7, 9, 4)]:
        B = rng.standard_normal((m, r)) @ rng.standard_normal((r, n))
        c, w, z, lf = four_subspaces(B)
        dims = (c.shape[1], w.shape[1], z.shape[1], lf.shape[1])
        print(
            f"{m:3d} {n:3d} {r:3d} | {dims[0]:2d}  {dims[1]:2d}  "
            f"{dims[2]:2d}  {dims[3]:2d} | "
            f"{dims[1] + dims[2] == n}  {dims[0] + dims[3] == m}"
        )


if __name__ == "__main__":
    main()
```

```text
SVD 的四个维数： 2 2 2 1
列空间 并排后的秩： 2 ，SVD 的基是标准正交的： True
行空间 并排后的秩： 2 ，SVD 的基是标准正交的： True
零空间 并排后的秩： 2 ，SVD 的基是标准正交的： True
左零空间 并排后的秩： 1 ，SVD 的基是标准正交的： True
  m   n   r | 列  行  零  左 | 行+零=n  列+左=m
  3   6   2 |  2   2   4   1 | True  True
  5   3   3 |  3   3   0   2 | True  True
  4   4   4 |  4   4   0   0 | True  True
  6   5   1 |  1   1   4   5 | True  True
  7   9   4 |  4   4   5   3 | True  True
```

前半段，四个子空间的 SVD 基都和消元的基张成同一个空间：列空间并排后的秩 2，行空间 2，零空间 2，左零空间 1，都恰好等于各自的维数。此外 SVD 给的基还是标准正交的，`True` 就是这个意思。（消元给的基没有这个性质，这是第 14 讲以后才有用的东西，先记下。）

后半段是维数的验证，$(m, n, r)$ 各不相同。$3 \times 6$、秩 2 的矩阵，零空间有 4 维；$6 \times 5$、秩 1 的矩阵，左零空间有 5 维；$4 \times 4$ 的满秩方阵，零空间和左零空间都是 0 维。五行里“行 + 零 = $n$”与“列 + 左 = $m$”全是 `True`。我觉得有意思的是 $6 \times 5$ 这一行：矩阵看着不小，列空间却只有 1 维，一条直线，剩下 5 个维度全归了左零空间。

## 矩阵也是向量

最后几分钟，他把“向量”的意思推广了一步：所有 $3 \times 3$ 矩阵组成一个向量空间 $M$。能做的运算只有两个，矩阵相加、矩阵乘以数，用不上矩阵乘法。零矩阵是零向量，那八条向量空间公理自然满足。$M$ 里有子空间：上三角矩阵、对称矩阵，它们的交集是对角矩阵。

他当场给了对角子空间的基：三个矩阵，比如 $\operatorname{diag}(3, 0, 0)$、$\operatorname{diag}(0, 2, 0)$、$\operatorname{diag}(0, 0, 7)$（他自己说这个 7 选得不怎么样），所以维数是 3。上三角和对称的维数他留到了下一讲。我先数了一遍，办法是把 $3 \times 3$ 矩阵拉直成 9 维向量，用秩来数张成的维数：

```python
import numpy as np


def unit(i: int, j: int) -> np.ndarray:
    """只有 (i, j) 位置为 1 的 3 x 3 矩阵。"""
    E = np.zeros((3, 3))
    E[i, j] = 1.0
    return E


def dim_span(mats: list[np.ndarray]) -> int:
    """把矩阵拉直成 9 维向量，张成的空间的维数。"""
    return int(np.linalg.matrix_rank(np.array([M.ravel() for M in mats])))


def main() -> None:
    # 3 x 3 矩阵本身就是向量，整个空间 M 是 9 维的
    pairs = [(i, j) for i in range(3) for j in range(3)]
    everything = [unit(i, j) for i, j in pairs]
    print("M 的维数：", dim_span(everything))

    # Strang 给的三个对角矩阵（其中有他随手写的 7）
    diagonal = [np.diag(d) for d in ([3.0, 0, 0], [0, 2.0, 0], [0, 0, 7.0])]
    print("对角子空间 D 的维数：", dim_span(diagonal))
    target = np.diag([5.0, -4.0, 1.0])
    flat = np.array([D.ravel() for D in diagonal]).T
    coef, *_ = np.linalg.lstsq(flat, target.ravel(), rcond=None)
    combo = sum(c * D for c, D in zip(coef, diagonal))
    print("对角矩阵的组合系数：", np.round(coef, 4))
    print("还原出 diag(5, -4, 1)：", np.allclose(combo, target))

    # 他留到下一讲的问题：上三角与对称各是几维？交集呢？
    upper = [unit(i, j) for i, j in pairs if i <= j]
    sym = [unit(i, j) + unit(j, i) for i, j in pairs if i <= j]
    both = dim_span(upper + sym)
    print("上三角：", dim_span(upper), "，对称：", dim_span(sym))
    print("二者之和：", both, "，交集的维数：", 6 + 6 - both)


if __name__ == "__main__":
    main()
```

```text
M 的维数： 9
对角子空间 D 的维数： 3
对角矩阵的组合系数： [ 1.6667 -2.      0.1429]
还原出 diag(5, -4, 1)： True
上三角： 6 ，对称： 6
二者之和： 9 ，交集的维数： 3
```

整个 $M$ 是 9 维，对角子空间是 3 维。上三角和对称各 6 维，两个子空间合起来张满整个 9 维的 $M$，所以交集的维数是 $6 + 6 - 9 = 3$，恰好等于对角子空间的维数，和他说的“交集是对角矩阵”一致。这里用到了子空间维数公式 $\dim(U \cap S) = \dim U + \dim S - \dim(U + S)$，我是从两个子空间的基并排后看秩得到它的（这个公式是我自己加的，Strang 这一讲没有写），在这个例子里它自洽。

## 在控制里

状态方程 $\mathbf{x}_{k+1} = A\mathbf{x}_k + B\mathbf{u}_k$ 里“系统能不能被控制”，可以直接翻译成这一讲的语言。从零状态出发，$n$ 步之内能到达的所有状态，是能控性矩阵 $\mathcal{C} = [B \;\; AB \;\; A^2B \;\; \cdots \;\; A^{n-1}B]$ 的列的所有组合，也就是 $\mathcal{C}$ 的列空间。所以“能控”就是“列空间是整个 $\mathbb{R}^n$”，也就是 $\mathcal{C}$ 的秩等于 $n$，这和第 1 讲“列的组合能不能填满空间”是同一个问题，只是列换成了 $B$、$AB$、$A^2B$……。

秩不够的时候，$n - r$ 维的“够不着的方向”不在列空间里，而是由左零空间描述：存在 $\mathbf{y} \ne \mathbf{0}$ 使得 $\mathbf{y}^\mathsf{T}\mathcal{C} = \mathbf{0}^\mathsf{T}$，意思是状态沿 $\mathbf{y}$ 的分量 $\mathbf{y}^\mathsf{T}\mathbf{x}$，无论输入怎么给都推不动。四个子空间里，列空间告诉你够得着哪里，左零空间告诉你够不着哪里，两者的维数加起来是 $n$。

这一节只讲概念，没有跑代码。

四个子空间到这里讲完了，但它们之间还有一层关系没碰：行空间和零空间都在 $\mathbb{R}^n$ 里，维数加起来是 $n$，它们到底是怎么摆放的？答案是互相垂直，这是第 14 讲的内容。在那之前，下一讲先把矩阵当成向量继续往下数维数，再看秩为 1 的矩阵长什么样，见 [18.06 第 11 讲：矩阵空间、秩 1 矩阵与小世界图](/posts/linear-algebra-11-matrix-spaces-rank-one/)。
