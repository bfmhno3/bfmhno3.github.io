---
title: "18.06 第 7 讲：解 Ax = 0，主变量与特解"
commentId: "post:linear-algebra-07-solving-ax-0"
published: "2026-10-18 10:00:00 +08:00"
description: "MIT 18.06 第 7 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 手写了带容差的 rref，把 Strang 的 3 × 4 矩阵化成 R 并读出特解矩阵 N，A @ N 为 0；容差设成 0 时，一个按构造秩为 3 的 6 × 8 矩阵被判成秩 6，零空间只剩 2 维，而不是 5 维。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 零空间
  - 行最简形
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 7
draft: false
comment: true
slug: linear-algebra-07-solving-ax-0
---

上一讲 Strang 问的是零空间“是什么”，这一讲他回答“怎么算”：对任意形状的矩阵做消元，遇到 0 主元不要停，数出主元的个数就是秩，剩下的列是自由列，给自由变量依次赋 1 和 0，回代出来的向量叫特解，零空间就是特解的所有组合。我把他黑板上的 3 × 4 矩阵交给一个手写的 `rref`：秩是 2，两个特解拼成的 $N$ 满足 $AN = 0$。然后我把容差改成 0，一个按构造秩为 3 的 6 × 8 矩阵立刻被判成秩 6，零空间只剩 2 维，而真实答案是 5 维。

> [!NOTE] 本讲速览
> 视频：[Lecture 7: Solving Ax = 0: pivot variables, special solutions](https://www.youtube.com/watch?v=VqP2tREMvt0)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-7-solving-ax-0-pivot-variables-special-solutions/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §3.2 Computing the Nullspace by Elimination: A = CR
> 前置：[第 6 讲：列空间与零空间](/posts/linear-algebra-06-column-space-and-nullspace/)
> 一句话：把 $A$ 消元到行最简形 $R = \begin{bmatrix} I & F \\ 0 & 0 \end{bmatrix}$，零空间的特解矩阵就是 $N = \begin{bmatrix} -F \\ I \end{bmatrix}$，$n - r$ 个自由变量对应 $n - r$ 个特解。

> [!TIP] 配合视频
> - 开头他拿出 3 × 4 矩阵，先口头指出“第二列是第一列的倍数、第三行是前两行之和”，再开始消元。这一段值得看：他先猜答案，再让消元去验证。
> - 消元的算术很短，本篇第一节已经用代码算过，可以倍速。他在第二列发现主元位置是 0、下面也全是 0，当场不停下来分析、直接往下一列走，这个处理是这一讲的关键，别快进。
> - “自由变量取 1 和 0、回代求主变量”那一段要认真听，他给了名字：主变量、自由变量、特解。
> - 他写出 $R$ 之后用分块矩阵推导“特解里为什么出现 $-F$”，是后半段最重要的一段。之后的第二个例子（原矩阵的转置）他自己说是“再练一遍”，本篇第四节已经跑过，可以倍速。

## 消元不停：遇到 0 就往右走

Strang 的矩阵是 3 × 4 的：

$$
A = \begin{bmatrix}
1 & 2 & 2 & 2 \\
2 & 4 & 6 & 8 \\
3 & 6 & 8 & 10
\end{bmatrix}
$$

字幕里他念了第二行和第三行（“two four six eight and three six eight ten”），第一行是我根据他的两句观察和后面的消元结果反推的 $(1, 2, 2, 2)$：第二列确实是第一列的 2 倍，第三行确实等于前两行之和，消元出来的数也和他念的一致。

**怎么对一个长方形矩阵做消元？** 和以前一样，只是多了一条规则：某一列在主元位置是 0、下面也全是 0，就跳过这一列，在下一列继续。第一步，第二行减去 2 倍第一行，第三行减去 3 倍第一行，两行都变成 $(0, 0, 2, 4)$。第二列没有主元可用，跳过。第三列的主元是 2，第三行减去第二行，整行变成 0。结果叫 $U$：

$$
U = \begin{bmatrix}
1 & 2 & 2 & 2 \\
0 & 0 & 2 & 4 \\
0 & 0 & 0 & 0
\end{bmatrix}
$$

他称它为阶梯形（echelon form，echelon 就是“楼梯”的意思）：非零元沿着楼梯往右下走，每级台阶的高度是一行。主元的个数是 2，这个数就是矩阵的**秩**。

下面是我的 `echelon`。它只做向下消元，在当前列从当前行往下找第一个非零元，找不到就跳到下一列。“非零”在浮点数里要靠容差判断，容差的事留到后面再说：

```python
import numpy as np


def echelon(A: np.ndarray, tol: float = 1e-10) -> tuple[np.ndarray, list[int]]:
    """只做向下消元：遇到没有主元的列就跳过，继续往右。"""
    U = A.astype(float).copy()
    m, n = U.shape
    pivots: list[int] = []
    row = 0
    for col in range(n):
        if row == m:
            break
        # 在 row 行及以下找第一个非零元，必要时换行
        candidates = np.nonzero(np.abs(U[row:, col]) > tol)[0]
        if candidates.size == 0:
            U[row:, col] = 0.0
            continue
        k = row + candidates[0]
        U[[row, k]] = U[[k, row]]
        for i in range(row + 1, m):
            U[i] -= U[i, col] / U[row, col] * U[row]
            U[i, col] = 0.0
        pivots.append(col)
        row += 1
    return U + 0.0, pivots


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array(
        [[1.0, 2.0, 2.0, 2.0], [2.0, 4.0, 6.0, 8.0], [3.0, 6.0, 8.0, 10.0]]
    )
    U, pivots = echelon(A)
    print("U =")
    print(U)
    print("主列（从 0 数起）：", pivots, "，秩 =", len(pivots))
    print("np.linalg.matrix_rank(A) =", np.linalg.matrix_rank(A))
    print("第三行等于前两行之和：", np.allclose(A[2], A[0] + A[1]))

    # 消元不改变零空间，但会改变列空间
    xs = [np.array([-2.0, 1.0, 0.0, 0.0]), np.array([2.0, 0.0, -2.0, 1.0])]
    for x in xs:
        print(x, "A @ x =", A @ x, "U @ x =", U @ x)
    print("rank([A U]) =", np.linalg.matrix_rank(np.hstack([A, U])))


if __name__ == "__main__":
    main()
```

```text
U =
[[1. 2. 2. 2.]
 [0. 0. 2. 4.]
 [0. 0. 0. 0.]]
主列（从 0 数起）： [0, 2] ，秩 = 2
np.linalg.matrix_rank(A) = 2
第三行等于前两行之和： True
[-2.  1.  0.  0.] A @ x = [0. 0. 0.] U @ x = [0. 0. 0.]
[ 2.  0. -2.  1.] A @ x = [0. 0. 0.] U @ x = [0. 0. 0.]
rank([A U]) = 3
```

这里有两件事要看。第一，秩是 2，和 `np.linalg.matrix_rank` 一致；`U` 的最后一行全零，说明第三行被前两行“吃掉了”，这也印证了 `A[2] == A[0] + A[1]`。第二，消元**不改变零空间**：他取的两个向量 $(-2, 1, 0, 0)$ 和 $(2, 0, -2, 1)$ 被 $A$ 和 $U$ 都乘成零。但它**改变了列空间**：$A$ 的列空间里有 $(1, 2, 3)$，$U$ 的列空间里没有，把两者的列并排放在一起，秩是 3，大于各自的 2。他在视频里特意提醒要留意消元什么不变，我觉得这个提醒在后面几讲反复用得上：解不变，列空间会变。

## 主变量、自由变量与特解

**哪些变量是自由的？** 有主元的列叫主列，对应的变量叫主变量，这里是 $x_1$ 和 $x_3$；没有主元的列叫自由列，对应的变量是自由变量，这里是 $x_2$ 和 $x_4$。自由变量可以随便取值，主变量再由方程回代求出来（有点像做账：自由变量是随便花的零花钱，主变量是被迫补上的差额）。

$U\mathbf{x} = \mathbf{0}$ 的两个方程是 $x_1 + 2x_2 + 2x_3 + 2x_4 = 0$ 和 $2x_3 + 4x_4 = 0$。他的取法是系统的：

- 取 $x_2 = 1$、$x_4 = 0$：第二个方程给出 $x_3 = 0$，第一个给出 $x_1 = -2$，得到 $(-2, 1, 0, 0)$。意思是“$-2$ 份第一列加 1 份第二列是零向量”，正是他一开始肉眼看出来的那个关系。
- 取 $x_2 = 0$、$x_4 = 1$：$x_3 = -2$，$x_1 = 2$，得到 $(2, 0, -2, 1)$。

这两个向量叫**特解**。特别之处只在于自由变量取的是“一个 1、其余 0”：任何一个解的自由变量取值，都是这些“一个 1、其余 0”的组合，所以每个解都是特解的组合。零空间就是特解的所有组合，$c_1 \mathbf{s}_1 + c_2 \mathbf{s}_2$。他强调了考试时的写法：如果让你“描述零空间”，要写出这个带 $c$ 的组合，因为你说的是整个空间；如果只要“一组基”，写特解就够了。

数量也一眼能算：$m = 3$ 行、$n = 4$ 列、秩 $r = 2$，有 $r$ 个主变量，$n - r = 2$ 个自由变量，所以有 2 个特解。这也解释了“三个方程四个未知数”为什么有非零解：看起来是 3 个方程，实际上只有 $r = 2$ 个独立的。

我把回代写成代码，对每个自由变量各做一次，再随机取一组系数，确认组合出来的向量也在零空间里：

```python
import numpy as np


def echelon(A: np.ndarray, tol: float = 1e-10) -> tuple[np.ndarray, list[int]]:
    U = A.astype(float).copy()
    m, n = U.shape
    pivots: list[int] = []
    row = 0
    for col in range(n):
        if row == m:
            break
        candidates = np.nonzero(np.abs(U[row:, col]) > tol)[0]
        if candidates.size == 0:
            U[row:, col] = 0.0
            continue
        k = row + candidates[0]
        U[[row, k]] = U[[k, row]]
        for i in range(row + 1, m):
            U[i] -= U[i, col] / U[row, col] * U[row]
            U[i, col] = 0.0
        pivots.append(col)
        row += 1
    return U + 0.0, pivots


def special_solutions(U: np.ndarray, pivots: list[int]) -> np.ndarray:
    """每个自由变量取 1、其余自由变量取 0，回代求主变量。"""
    n = U.shape[1]
    free = [j for j in range(n) if j not in pivots]
    N = np.zeros((n, len(free)))
    for k, f in enumerate(free):
        x = np.zeros(n)
        x[f] = 1.0
        for r in reversed(range(len(pivots))):
            c = pivots[r]
            x[c] = (0.0 - U[r, c + 1 :] @ x[c + 1 :]) / U[r, c]
        N[:, k] = x
    return N


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array(
        [[1.0, 2.0, 2.0, 2.0], [2.0, 4.0, 6.0, 8.0], [3.0, 6.0, 8.0, 10.0]]
    )
    U, pivots = echelon(A)
    free = [j for j in range(A.shape[1]) if j not in pivots]
    print("主变量下标：", pivots, "，自由变量下标：", free)

    N = special_solutions(U, pivots)
    print("特解矩阵 N（每列一个特解）：")
    print(N)
    print("A @ N =")
    print(A @ N)
    print("U @ N 全为 0：", np.allclose(U @ N, 0.0))

    # 零空间 = 特解的所有组合：随便取系数，结果仍被 A 消成 0
    rng = np.random.default_rng(1806)
    c = rng.standard_normal(2)
    x = N @ c
    print("c =", c, "，x = N @ c =", x)
    print(f"‖A @ x‖ = {np.linalg.norm(A @ x):.2e}")


if __name__ == "__main__":
    main()
```

```text
主变量下标： [0, 2] ，自由变量下标： [1, 3]
特解矩阵 N（每列一个特解）：
[[-2.  2.]
 [ 1.  0.]
 [ 0. -2.]
 [ 0.  1.]]
A @ N =
[[0. 0.]
 [0. 0.]
 [0. 0.]]
U @ N 全为 0： True
c = [ 0.6679 -0.2323] ，x = N @ c = [-1.8005  0.6679  0.4646 -0.2323]
‖A @ x‖ = 9.99e-16
```

$N$ 的两列和他算的完全一致。随机系数 $c = (0.6679, -0.2323)$ 组合出来的 $\mathbf{x}$ 被 $A$ 乘出来的范数是 $10^{-15}$ 量级，就是浮点舍入，不是别的。顺带一提，回代那一行 `x[c] = (0.0 - ...) / U[r, c]` 里的 `0.0 -` 是为了不打印出难看的 `-0.`，没有数学意义。

## 进一步清理：行最简形 $R$

**$U$ 还能再化简吗？** 能。他往上消元，把主元上面的元素也清零，再把每个主元除成 1。第二行除以 2 得到 $(0, 0, 1, 2)$，第一行减去 2 倍第二行，$(1, 2, 2, 2)$ 变成 $(1, 2, 0, -2)$：

$$
R = \begin{bmatrix}
1 & 2 & 0 & -2 \\
0 & 0 & 1 & 2 \\
0 & 0 & 0 & 0
\end{bmatrix}
$$

这叫**行最简形**（reduced row echelon form，MATLAB 里是 `rref`）。他指出里面的几处结构：主行、主列交叉处是一个单位矩阵 $I$（这里是 2 × 2）；自由列里剩下的部分叫 $F$；底下是零行。把列重新排一下，$R$ 就是

$$
R = \begin{bmatrix} I & F \\ 0 & 0 \end{bmatrix}
$$

然后是这一讲最漂亮的一步：**特解为什么能直接读出来？** 解 $R\mathbf{x} = \mathbf{0}$，把 $\mathbf{x}$ 拆成主变量部分 $\mathbf{x}_p$ 和自由变量部分 $\mathbf{x}_f$：$\mathbf{x}_p + F\mathbf{x}_f = \mathbf{0}$，所以 $\mathbf{x}_p = -F\mathbf{x}_f$。自由变量取单位矩阵的每一列，所有特解就能一次写出来：

$$
N = \begin{bmatrix} -F \\ I \end{bmatrix}, \qquad RN = -F + F = 0
$$

不用回代。上面算出的 $(-2, 1, 0, 0)$：自由列里 $F$ 的第一列是 $(2, 0)$，取负就是 $(-2, 0)$，放在主变量的位置，$x_2$ 位置放 1，完全吻合。他在视频里说这不是魔法，必然如此，我同意。

我把它写成两个函数：`rref` 把主元化成 1 并双向清零，`null_basis` 按下标把 $-F$ 和 $I$ 放回各自的位置。写完用 SVD 给的零空间对照（基不一样，但张成的应该是同一个子空间）：

```python
import numpy as np


def rref(A: np.ndarray, tol: float = 1e-10) -> tuple[np.ndarray, list[int]]:
    R = A.astype(float).copy()
    m, n = R.shape
    pivots: list[int] = []
    row = 0
    for col in range(n):
        if row == m:
            break
        candidates = np.nonzero(np.abs(R[row:, col]) > tol)[0]
        if candidates.size == 0:
            R[row:, col] = 0.0
            continue
        k = row + candidates[0]
        R[[row, k]] = R[[k, row]]
        R[row] /= R[row, col]
        for i in range(m):
            if i != row:
                R[i] -= R[i, col] * R[row]
        pivots.append(col)
        row += 1
    return R + 0.0, pivots


def null_basis(R: np.ndarray, pivots: list[int]) -> np.ndarray:
    n = R.shape[1]
    free = [j for j in range(n) if j not in pivots]
    N = np.zeros((n, len(free)))
    N[free, :] = np.eye(len(free))
    N[pivots, :] = 0.0 - R[: len(pivots), free]
    return N


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array(
        [[1.0, 2.0, 2.0, 2.0], [2.0, 4.0, 6.0, 8.0], [3.0, 6.0, 8.0, 10.0]]
    )
    R, pivots = rref(A)
    r = len(pivots)
    free = [j for j in range(A.shape[1]) if j not in pivots]
    print("R =")
    print(R)
    print("主列：", pivots, "，自由列：", free)
    print("I 块（主行、主列）：")
    print(R[:r, pivots])
    F = R[:r, free]
    print("F 块（主行、自由列）：")
    print(F)

    # N = [-F; I]：自由行放单位矩阵，主行放 -F
    N = null_basis(R, pivots)
    print("N =")
    print(N)
    print("A @ N 全为 0：", np.allclose(A @ N, 0.0))
    print("R @ N 全为 0：", np.allclose(R @ N, 0.0))

    # 和 SVD 给的零空间对照：基不同，但张成同一个子空间
    _, _, Vt = np.linalg.svd(A)
    V_null = Vt[r:].T
    print("SVD 的零空间基维数：", V_null.shape[1])
    print(
        "N 与 SVD 基合在一起的秩：",
        np.linalg.matrix_rank(np.hstack([N, V_null])),
    )


if __name__ == "__main__":
    main()
```

```text
R =
[[ 1.  2.  0. -2.]
 [ 0.  0.  1.  2.]
 [ 0.  0.  0.  0.]]
主列： [0, 2] ，自由列： [1, 3]
I 块（主行、主列）：
[[1. 0.]
 [0. 1.]]
F 块（主行、自由列）：
[[ 2. -2.]
 [ 0.  2.]]
N =
[[-2.  2.]
 [ 1.  0.]
 [ 0. -2.]
 [ 0.  1.]]
A @ N 全为 0： True
R @ N 全为 0： True
SVD 的零空间基维数： 2
N 与 SVD 基合在一起的秩： 2
```

$R$、$F$、$N$ 都和上面的手算一致。SVD 给出的零空间基有 2 个向量，它和 $N$ 拼在一起，秩仍然是 2，说明两组基张成的是同一个二维子空间。这是“求零空间”的另一条路，后面会说为什么我更信任它。

两个小注：我的 `rref` 是一次做完向上、向下消元，而 Strang 先做到 $U$ 再往上清，结果是同一个 $R$（行最简形是唯一的）。另外，它用“第一个非零元”当主元，不选最大的，数值上很天真（我没打算让它活过一个病态矩阵），教学够用。

## 再来一个例子：转置

他的第二个例子是同一个矩阵的转置，$B = A^{T}$，一个 4 × 3 的矩阵：

$$
B = \begin{bmatrix}
1 & 2 & 3 \\
2 & 4 & 6 \\
2 & 6 & 8 \\
2 & 8 & 10
\end{bmatrix}
$$

开始之前他让大家预测：三列里第三列是前两列之和，所以前两列是主列、第三列是自由列，秩是 2。消元时这里会遇到一次行交换：第一列清零之后，第二行变成全零，第三行的第二个元素是 2，要和第二行换位置。我把 `rref` 直接用在 $B$ 上，同时验证他顺口说的一件事：$A$ 和 $A^{T}$ 的主列个数相同。

```python
import numpy as np


def rref(A: np.ndarray, tol: float = 1e-10) -> tuple[np.ndarray, list[int]]:
    R = A.astype(float).copy()
    m, n = R.shape
    pivots: list[int] = []
    row = 0
    for col in range(n):
        if row == m:
            break
        candidates = np.nonzero(np.abs(R[row:, col]) > tol)[0]
        if candidates.size == 0:
            R[row:, col] = 0.0
            continue
        k = row + candidates[0]
        R[[row, k]] = R[[k, row]]
        R[row] /= R[row, col]
        for i in range(m):
            if i != row:
                R[i] -= R[i, col] * R[row]
        pivots.append(col)
        row += 1
    return R + 0.0, pivots


def null_basis(R: np.ndarray, pivots: list[int]) -> np.ndarray:
    n = R.shape[1]
    free = [j for j in range(n) if j not in pivots]
    N = np.zeros((n, len(free)))
    N[free, :] = np.eye(len(free))
    N[pivots, :] = 0.0 - R[: len(pivots), free]
    return N


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array(
        [[1.0, 2.0, 2.0, 2.0], [2.0, 4.0, 6.0, 8.0], [3.0, 6.0, 8.0, 10.0]]
    )
    B = A.T  # 4 x 3，第三列是前两列之和
    R, pivots = rref(B)
    N = null_basis(R, pivots)
    print("R =")
    print(R)
    print("主列：", pivots, "，秩 =", len(pivots))
    print("N =", N[:, 0], "，B @ N 全为 0：", np.allclose(B @ N, 0.0))

    # A 与 A 转置的主列个数相同，但主列的位置不同
    _, piv_a = rref(A)
    print("A 的主列：", piv_a, "，A.T 的主列：", pivots)
    print("个数相同：", len(piv_a) == len(pivots))


if __name__ == "__main__":
    main()
```

```text
R =
[[1. 0. 1.]
 [0. 1. 1.]
 [0. 0. 0.]
 [0. 0. 0.]]
主列： [0, 1] ，秩 = 2
N = [-1. -1.  1.] ，B @ N 全为 0： True
A 的主列： [0, 2] ，A.T 的主列： [0, 1]
个数相同： True
```

自由列只有一个，所以零空间是一条直线，$N = (-1, -1, 1)$，就是“第三列减去前两列等于零”。他要求考试时写 $c\,(-1, -1, 1)$，不要忘了 $c$。$A$ 的主列在位置 0 和 2，$A^{T}$ 的在 0 和 1，个数都是 2，位置不同。个数一样的原因，他只说这是个了不起的事实，当场没有解释；我猜要等到讲四个基本子空间的那几讲，那时会说清行秩等于列秩。

## 浮点数里的“零”

**主元是不是零？** 纸上算 $2 - 2 = 0$ 是精确的，浮点数里不是。矩阵的秩是 3，但如果元素来自乘法，消元之后本该是 0 的位置会留下 $10^{-16}$ 量级的残渣。如果按“严格等于 0”来判断，算法会把这些残渣当成主元，除以它们，整个结果就被放大成垃圾。所以我的函数里每次找主元都带了容差 `tol`，小于它的当作 0。

我拿一个按构造秩为 3 的 6 × 8 矩阵（三个 6 维列向量的组合，固定种子），分别用 `tol = 0` 和 `tol = 1e-10` 求零空间。奇异值也一并打印出来，看真实的“秩”在哪里：

```python
import numpy as np


def rref(A: np.ndarray, tol: float = 1e-10) -> tuple[np.ndarray, list[int]]:
    R = A.astype(float).copy()
    m, n = R.shape
    pivots: list[int] = []
    row = 0
    for col in range(n):
        if row == m:
            break
        candidates = np.nonzero(np.abs(R[row:, col]) > tol)[0]
        if candidates.size == 0:
            R[row:, col] = 0.0
            continue
        k = row + candidates[0]
        R[[row, k]] = R[[k, row]]
        R[row] /= R[row, col]
        for i in range(m):
            if i != row:
                R[i] -= R[i, col] * R[row]
        pivots.append(col)
        row += 1
    return R + 0.0, pivots


def null_basis(R: np.ndarray, pivots: list[int]) -> np.ndarray:
    n = R.shape[1]
    free = [j for j in range(n) if j not in pivots]
    N = np.zeros((n, len(free)))
    N[free, :] = np.eye(len(free))
    N[pivots, :] = 0.0 - R[: len(pivots), free]
    return N


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)
    # 6 x 8 的矩阵，构造成秩 3：三个 6 维列向量的组合
    A = rng.standard_normal((6, 3)) @ rng.standard_normal((3, 8))
    s = np.linalg.svd(A, compute_uv=False)
    print("奇异值：", np.array2string(s, formatter={"float": "{:.2e}".format}))

    for tol in (0.0, 1e-10):
        R, pivots = rref(A, tol=tol)
        N = null_basis(R, pivots)
        residual = np.abs(A @ N).max()
        print(
            f"tol = {tol:g}：秩 = {len(pivots)}，N 有 {N.shape[1]} 列，"
            f"max|A @ N| = {residual:.2e}"
        )
    print("np.linalg.matrix_rank(A) =", np.linalg.matrix_rank(A))


if __name__ == "__main__":
    main()
```

```text
奇异值： [9.91e+00 3.60e+00 2.69e+00 3.91e-16 2.37e-16 1.15e-16]
tol = 0：秩 = 6，N 有 2 列，max|A @ N| = 8.66e-15
tol = 1e-10：秩 = 3，N 有 5 列，max|A @ N| = 3.55e-15
np.linalg.matrix_rank(A) = 3
```

三个奇异值在 $2.69$ 以上，后三个在 $10^{-16}$ 量级，界线分明，真实的秩是 3，零空间是 $8 - 3 = 5$ 维，`matrix_rank` 也这么说。`tol = 1e-10` 的结果对得上：秩 3、$N$ 有 5 列。`tol = 0` 的结果让我意外：秩被判成 6，$N$ 只有 2 列。更有意思的是 `max|A @ N|` 在两种情况下都是 $10^{-15}$ 量级，也就是说 `tol = 0` 得到的 2 个向量**没有错**，它们确实在零空间里，只是漏了 3 个。没有任何报错或警告提醒你“这个零空间不完整”，我觉得这比直接算错更危险。

容差取多少？我取 $10^{-10}$ 是因为它夹在 $10^{-16}$ 的残渣和 $O(1)$ 的真元之间，两边各留了很多个数量级的余量。据我所知，更严格的做法是让容差跟矩阵的尺度走，NumPy 的 `matrix_rank` 用的是“最大奇异值乘以矩阵尺寸乘以机器精度”。我猜这就是实际工程里大家更愿意直接调 SVD 的原因：它把“哪些是零”的判断放在一排有序的奇异值上，界线比消元里的某个主元清楚得多。手写 `rref` 是为了看明白算法在干什么，不是为了在病态矩阵上拿来用。

## 在控制里

麦轮底盘有四个轮子，只推三个自由度：纵向力、横向力和转矩。这样力和电流之间的关系就是一个 3 × 4 的矩阵 $A = H^{T}$（$H$ 是[多变量那一篇](/posts/pid-control-08-mimo/)里的 4 × 3 的轮子几何矩阵），$A\mathbf{i}$ 是四个轮子的电流 $\mathbf{i}$ 产生的合力和合力矩。3 × 4 的矩阵，秩 3，$n - r = 1$：一个自由变量，一个特解，零空间是一条直线。这个形状和今天 Strang 的黑板几乎是同一个题。我把它交给上面的 `rref`：

```python
import numpy as np


def rref(A: np.ndarray, tol: float = 1e-10) -> tuple[np.ndarray, list[int]]:
    R = A.astype(float).copy()
    m, n = R.shape
    pivots: list[int] = []
    row = 0
    for col in range(n):
        if row == m:
            break
        candidates = np.nonzero(np.abs(R[row:, col]) > tol)[0]
        if candidates.size == 0:
            R[row:, col] = 0.0
            continue
        k = row + candidates[0]
        R[[row, k]] = R[[k, row]]
        R[row] /= R[row, col]
        for i in range(m):
            if i != row:
                R[i] -= R[i, col] * R[row]
        pivots.append(col)
        row += 1
    return R + 0.0, pivots


def null_basis(R: np.ndarray, pivots: list[int]) -> np.ndarray:
    n = R.shape[1]
    free = [j for j in range(n) if j not in pivots]
    N = np.zeros((n, len(free)))
    N[free, :] = np.eye(len(free))
    N[pivots, :] = 0.0 - R[: len(pivots), free]
    return N


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # 麦轮底盘：行依次是左前、右前、左后、右后，L = 0.4
    H = np.array(
        [
            [1.0, -1.0, -0.4],
            [1.0, 1.0, 0.4],
            [1.0, 1.0, -0.4],
            [1.0, -1.0, 0.4],
        ]
    )
    A = H.T  # 3 x 4：四个电流映射成 (Fx, Fy, Mz)
    R, pivots = rref(A)
    N = null_basis(R, pivots)
    print("R =")
    print(R)
    print("秩 =", len(pivots), "，零空间维数 =", N.shape[1])
    n = N[:, 0] / np.linalg.norm(N[:, 0])
    print("单位化的零空间向量 n =", n)

    # 想要的合力与合力矩（取个无量纲的值），最小范数电流再加一份 n
    w = np.array([8.0, 2.0, 1.0])
    i_min = np.linalg.pinv(A) @ w
    i_shift = i_min + 10.0 * n
    print("最小范数电流：", i_min, f"，范数 = {np.linalg.norm(i_min):.4f}")
    print(
        "加上 10 * n 之后：",
        i_shift,
        f"，范数 = {np.linalg.norm(i_shift):.4f}",
    )
    print("两组电流产生同样的 (Fx, Fy, Mz)：", np.allclose(A @ i_shift, w))
    print(f"n @ i_min = {n @ i_min:.4f}，n @ i_shift = {n @ i_shift:.4f}")


if __name__ == "__main__":
    main()
```

```text
R =
[[ 1.  0.  0.  1.]
 [ 0.  1.  0.  1.]
 [ 0.  0.  1. -1.]]
秩 = 3 ，零空间维数 = 1
单位化的零空间向量 n = [-0.5 -0.5  0.5  0.5]
最小范数电流： [0.875 3.125 1.875 2.125] ，范数 = 4.3084
加上 10 * n 之后： [-4.125 -1.875  6.875  7.125] ，范数 = 10.8886
两组电流产生同样的 (Fx, Fy, Mz)： True
n @ i_min = 0.0000，n @ i_shift = 10.0000
```

$R$ 的第四列是 $(1, 1, -1)$，取负放进 $N$，自由变量位置放 1，得到 $(-1, -1, 1, 1)$；单位化后是 $\mathbf{n} = (-0.5, -0.5, 0.5, 0.5)$，和那一篇手算的 $(1, 1, -1, -1)/2$ 只差一个符号。这就是“一对轮子往一边拧、另一对往另一边拧，合力和合力矩都是零”的电流模式。我把最小范数电流 $\mathbf{i}_{\min}$（范数 4.3084）加上 $10\,\mathbf{n}$，合力和合力矩一点没变（`np.allclose` 为 `True`），电流向量的范数却涨到 10.8886，是原来的 2.5 倍。多出来的都是白白发热的电流，$\mathbf{n}^{T}\mathbf{i}$ 从 0 变成 10。

这就是“零空间电流”的全部数学：给定想要的合力，电流有一条直线的自由度，最小范数的那个解，是这条直线上与 $\mathbf{n}$ 垂直的那个点。多变量那一篇里，逐轮截断让这个分量的均方根达到 28.54 A，原因就是截断把电流推向了这条直线的方向。那一篇已经量过，这一篇只补上它的来历：这个方向就是 $N$ 的那一列。

这一讲只做了右端项为零的情况。右端项不为零时，$A\mathbf{x} = \mathbf{b}$ 什么时候有解、有几个解，他说留到下一讲。第 6 讲末尾的例子已经显示：解是一个特解加整个零空间。细节见 [18.06 第 8 讲：解 Ax = b，行最简形 R](/posts/linear-algebra-08-solving-ax-b/)。
