---
title: "18.06 第 2 讲：用矩阵做消元"
commentId: "post:linear-algebra-02-elimination-with-matrices"
published: "2026-10-18 08:20:00 +08:00"
description: "MIT 18.06 第 2 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 手写消元，把每一步写成初等矩阵并验证 E32 @ E21 @ A 恰好等于 U；在 10000 个随机整数 3 × 3 矩阵里，19.30% 需要换行，6.91% 彻底失败。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 消元法
  - 初等矩阵
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 2
draft: false
comment: true
slug: linear-algebra-02-elimination-with-matrices
---

消元是所有数值软件解方程组的办法，Strang 这一讲要你看到的是：消元的每一步，都是在 $A$ 的左边再乘一个矩阵。他黑板上的 3 × 3 例子经过两步，$E_{32} E_{21} A$ 变成了上三角的 $U$，主元是 1、2、5，乘起来就是行列式 10。我还让程序在 10000 个随机的小整数 3 × 3 矩阵上跑了一遍消元：73.79% 一路畅通，19.30% 需要换行，6.91% 在某一步彻底卡死。

> [!NOTE] 本讲速览
> 视频：[Lecture 2: Elimination with matrices](https://www.youtube.com/watch?v=QVKj3LADCnA)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-2-elimination-with-matrices/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §2.1 Elimination and Back Substitution；§2.2 Elimination Matrices and Inverse Matrices
> 前置：[第 1 讲：方程组的行图与列图](/posts/linear-algebra-01-geometry-of-linear-equations/)
> 一句话：消元的一步等于左乘一个把单位矩阵改了一个位置的矩阵；整个消元 $A \to U$ 就是把这些矩阵按顺序乘在 $A$ 左边。

> [!TIP] 配合视频
> - 开头到回代结束是他手算消元的那一段，本篇用代码算过同一个矩阵，可以倍速。他中途把一个数写错又自己发现的地方，值得看一眼。
> - “怎么会失败”那一段要认真看：什么数让主元变成 0 还能用换行救回来，什么数让它彻底没救。我在第二节用同一组数做了实验。
> - 他讲“左乘做行操作，右乘做列操作”和“结合律”的几分钟是全讲的核心，不要倍速。
> - 最后几分钟他开始讲逆矩阵，只举了一个例子，下一篇会系统展开。

## 手算一遍：从 A 到 U，再回代

这一讲只有一个方程组，三个方程三个未知数：

$$
\begin{aligned}
x + 2y + z &= 2 \\
3x + 8y + z &= 12 \\
4y + z &= 2
\end{aligned}
\qquad
A = \begin{bmatrix} 1 & 2 & 1 \\ 3 & 8 & 1 \\ 0 & 4 & 1 \end{bmatrix},\
\mathbf{b} = \begin{bmatrix} 2 \\ 12 \\ 2 \end{bmatrix}
$$

他一开始就说了两件事：方法不是行列式（那是后面的内容），是消元；而且“每个软件包解方程组用的都是它”。我猜这句话并不夸张，LAPACK 里的 LU 分解说到底就是这里的消元加上一点数值上的小心思。

**消元做的是什么？** 拿第一个方程当“主元行”，乘上合适的倍数，从下面的方程里减掉，目的是消去下面方程里的 $x$。第一行里的 1 是第一个主元（pivot）。第二行的 3 要被消去，所以乘数是 3：第二行减去 3 倍的第一行，$3 - 3 \times 1 = 0$，$8 - 3 \times 2 = 2$，$1 - 3 \times 1 = -2$。第三行的第一个数本来就是 0，乘数是 0，什么也不用做（他特意提了一句，MATLAB 不知道它是 0，也会老老实实走这一步）。

现在左下角的第一列已经清干净，剩下两个方程、两个未知数 $y$ 和 $z$。第二个主元是刚刚出现的 2。第三行的 4 要被消去，乘数是 2：$4 - 2 \times 2 = 0$，$1 - 2 \times (-2) = 5$。第三个主元是 5。

他还顺口立了一条规矩：永远说“减去”，不说“加上负的”。这是为了让乘数永远是正数的样子（这里是 3 和 2），而它在矩阵里出现时会带上负号，$E_{21}$ 里的 $-3$ 就是这么来的。这个约定后面会反复用到：$L$ 里放的是乘数本身，$E$ 里放的是乘数的相反数。（我承认这是个纯属口味的约定，换成“加上负的”数学上毫无区别。）

右端项要同步更新。做法是把 $\mathbf{b}$ 当作第四列粘到 $A$ 旁边，这叫增广矩阵（augmented matrix）。“对两边做同样的事”，所以每一步对整行操作，包括最后那一列。我把这个过程原样写成代码，每一步都打印出来：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[1.0, 2.0, 1.0], [3.0, 8.0, 1.0], [0.0, 4.0, 1.0]])
    b = np.array([2.0, 12.0, 2.0])

    # 增广矩阵 [A | b]：对左边做的每一步，右端项同时被带着走
    M = np.hstack([A, b[:, None]])
    n = 3
    for j in range(n):  # 第 j 列的主元
        for i in range(j + 1, n):  # 消去主元下面的每一行
            multiplier = M[i, j] / M[j, j]
            M[i] -= multiplier * M[j]
            print(f"第 {i + 1},{j + 1} 步：乘数 {multiplier:g}")
            print(M)

    U, c = M[:, :n], M[:, n]
    print("主元：", np.diag(U))
    print("主元之积：", np.prod(np.diag(U)), "，det(A) =", np.linalg.det(A))

    # 回代：从最后一个方程往上解
    x = np.zeros(n)
    for i in range(n - 1, -1, -1):
        x[i] = (c[i] - U[i, i + 1 :] @ x[i + 1 :]) / U[i, i]
    print("回代得到 x =", x)
    print("与 np.linalg.solve 一致：", np.allclose(x, np.linalg.solve(A, b)))


if __name__ == "__main__":
    main()
```

```text
第 2,1 步：乘数 3
[[ 1.  2.  1.  2.]
 [ 0.  2. -2.  6.]
 [ 0.  4.  1.  2.]]
第 3,1 步：乘数 0
[[ 1.  2.  1.  2.]
 [ 0.  2. -2.  6.]
 [ 0.  4.  1.  2.]]
第 3,2 步：乘数 2
[[  1.   2.   1.   2.]
 [  0.   2.  -2.   6.]
 [  0.   0.   5. -10.]]
主元： [1. 2. 5.]
主元之积： 10.0 ，det(A) = 9.999999999999998
回代得到 x = [ 2.  1. -2.]
与 np.linalg.solve 一致： True
```

三步的乘数是 3、0、2，和他黑板上的一样。最后的 $U$ 是上三角矩阵，右端项变成了 $\mathbf{c} = (2, 6, -10)$（他说 $U$ 是 $A$ 的归宿，$\mathbf{c}$ 是 $\mathbf{b}$ 的归宿）。

**回代是什么？** $U\mathbf{x} = \mathbf{c}$ 写开就是

$$
\begin{aligned}
x + 2y + z &= 2 \\
2y - 2z &= 6 \\
5z &= -10
\end{aligned}
$$

从最后一个方程开始：$z = -2$。往上一步：$2y + 4 = 6$，$y = 1$。再往上：$x + 2 - 2 = 2$，$x = 2$。解是 $(2, 1, -2)$，和 `np.linalg.solve` 一致。

输出里有个小细节：主元之积是 10.0，而 `np.linalg.det(A)` 打印出 9.999999999999998。两者差约 $2 \times 10^{-15}$，因为 NumPy 的 `det` 也是做一次 LU 分解再把对角线乘起来，只是中间会选主元、顺序不同，舍入误差就不同。Strang 顺便提了一句：如果你想知道行列式，把主元乘起来就是，虽然“我从来不想知道行列式”。行列式是第 18 讲的内容，这里先记下：三个主元 1、2、5，乘积 10。

## 怎么会失败

他说看一个算法，最好问它怎么才会失败。这里的“失败”是指凑不够三个主元。

**情形一：主元位置上是 0，下面有非零数。** 他把第二行的 8 换成 6：第一步之后，第二行是 $(0, 0, -2)$，第二个主元位置是 0。他强调不会说“零主元”，换行就行：第三行是 $(0, 4, 1)$，把第二、三行交换，4 就成了新的主元。这是暂时的失败，可以救。

**情形二：主元位置上是 0，下面全是 0。** 他问把右下角的 1 改成多少会彻底没救。答案是 $-4$：第三行变成 $(0, 4, -4)$，减去 2 倍的第二行 $(0, 2, -2)$ 得到 $(0, 0, 0)$。没有第三个主元，没有行可换，矩阵不可逆。

我把这三个矩阵交给一个手写的 `eliminate`：主元位置是 0 就往下找第一个非零的行交换，找不到就报失败。（真正的软件会选绝对值最大的数当主元，数值上更稳，这里只按 Strang 的规矩，不是 0 就不换。）

```python
import numpy as np


def eliminate(A: np.ndarray, tol: float = 1e-12):
    """消元到上三角；主元位置是 0 就往下找第一个非零的行交换。

    返回 (U, 行交换次数, 三个主元是否都找到)。
    """
    U = A.astype(float).copy()
    n = U.shape[0]
    swaps = 0
    for j in range(n):
        nonzero = np.flatnonzero(np.abs(U[j:, j]) > tol)
        if nonzero.size == 0:
            return U, swaps, False  # 下面全是 0，没有可换的行
        k = j + int(nonzero[0])
        if k != j:
            U[[j, k]] = U[[k, j]]
            swaps += 1
        for i in range(j + 1, n):
            U[i] -= U[i, j] / U[j, j] * U[j]
    return U, swaps, True


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    cases = {
        "原矩阵": [[1, 2, 1], [3, 8, 1], [0, 4, 1]],
        "8 改成 6": [[1, 2, 1], [3, 6, 1], [0, 4, 1]],
        "1 改成 -4": [[1, 2, 1], [3, 8, 1], [0, 4, -4]],
    }
    for name, rows in cases.items():
        A = np.array(rows, dtype=float)
        U, swaps, ok = eliminate(A)
        print(f"{name}：换行 {swaps} 次，三个主元都有：{ok}")
        print(U)
        print("  rank =", np.linalg.matrix_rank(A))


if __name__ == "__main__":
    main()
```

```text
原矩阵：换行 0 次，三个主元都有：True
[[ 1.  2.  1.]
 [ 0.  2. -2.]
 [ 0.  0.  5.]]
  rank = 3
8 改成 6：换行 1 次，三个主元都有：True
[[ 1.  2.  1.]
 [ 0.  4.  1.]
 [ 0.  0. -2.]]
  rank = 3
1 改成 -4：换行 0 次，三个主元都有：False
[[ 1.  2.  1.]
 [ 0.  2. -2.]
 [ 0.  0.  0.]]
  rank = 2
```

三个矩阵的结果和他的口头描述一样：原矩阵不换行，主元 1、2、5；改成 6 之后换一次行，主元变成 1、4、$-2$，仍然有三个；改成 $-4$ 之后第三行全零，只有两个主元，`np.linalg.matrix_rank` 也说秩是 2。

这两种失败各有多常见？Strang 没问，我自己好奇，就用固定种子随机生成 10000 个元素取自 $-3$ 到 $3$ 的整数 3 × 3 矩阵，分类统计：

```python
import numpy as np


def classify(A: np.ndarray, tol: float = 1e-12) -> str:
    """返回直通、换行、失败三者之一。"""
    U = A.astype(float).copy()
    n = U.shape[0]
    swapped = False
    for j in range(n):
        nonzero = np.flatnonzero(np.abs(U[j:, j]) > tol)
        if nonzero.size == 0:
            return "失败"
        k = j + int(nonzero[0])
        if k != j:
            U[[j, k]] = U[[k, j]]
            swapped = True
        for i in range(j + 1, n):
            U[i] -= U[i, j] / U[j, j] * U[j]
    return "换行" if swapped else "直通"


def main() -> None:
    rng = np.random.default_rng(1806)
    trials = 10000
    counts = {"直通": 0, "换行": 0, "失败": 0}
    mismatch = 0
    for _ in range(trials):
        A = rng.integers(-3, 4, size=(3, 3))
        result = classify(A)
        counts[result] += 1
        singular = np.linalg.matrix_rank(A) < 3
        mismatch += singular != (result == "失败")
    for name, count in counts.items():
        print(f"{name}：{count} / {trials} = {count / trials:.2%}")
    print("“失败”与 matrix_rank < 3 不一致的个数：", mismatch)


if __name__ == "__main__":
    main()
```

```text
直通：7379 / 10000 = 73.79%
换行：1930 / 10000 = 19.30%
失败：691 / 10000 = 6.91%
“失败”与 matrix_rank < 3 不一致的个数： 0
```

73.79% 的矩阵直通到底，19.30% 需要至少一次换行，6.91% 彻底失败。最后一行是自检：“彻底失败”的矩阵和 `matrix_rank < 3` 的矩阵逐个对上，一个不差。所以从这个意义上说，消元不只是求解的方法，也是判断矩阵可不可逆的方法：能不能凑齐 $n$ 个主元，就是答案。换行救得回来的情形在这批小整数矩阵里比失败的情形常见得多，我猜是因为小整数里零很多；如果换成连续的随机数，两种情形都会变成概率为零的事件。

## 把每一步写成矩阵

他在这里先停下来，讲了一个“全局视角”。上一讲讲的是：矩阵乘以列向量，结果是各列的线性组合。现在要的是它的镜像：**行向量乘以矩阵，结果是各行的线性组合。** 他的例子是用 $(1, 2, 7)$ 左乘 $A$，结果是 $1 \times$ 第一行 $+ 2 \times$ 第二行 $+ 7 \times$ 第三行。消元的所有操作都是行操作，所以消元矩阵一定放在左边。

那么“第二行减去 3 倍的第一行”是哪个矩阵？第一行和第三行不变，所以矩阵的第一行是 $(1, 0, 0)$，第三行是 $(0, 0, 1)$；第二行要取 $-3$ 份第一行加 1 份第二行：$(-3, 1, 0)$。也就是在单位矩阵的 $(2, 1)$ 位置填上 $-3$：

$$
E_{21} = \begin{bmatrix} 1 & 0 & 0 \\ -3 & 1 & 0 \\ 0 & 0 & 1 \end{bmatrix}, \quad
E_{32} = \begin{bmatrix} 1 & 0 & 0 \\ 0 & 1 & 0 \\ 0 & -2 & 1 \end{bmatrix}
$$

下标是它负责消去的位置。下面的脚本做了几件事：先验证行向量左乘确实是行的组合，然后构造 $E_{21}$、$E_{32}$，验证 $E_{32}(E_{21}A) = U$，再把两个矩阵先乘成一个 $E$，验证一次乘到位的结果相同，最后让 $E$ 作用在 $\mathbf{b}$ 上，看它是不是 $\mathbf{c}$：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[1.0, 2.0, 1.0], [3.0, 8.0, 1.0], [0.0, 4.0, 1.0]])
    b = np.array([2.0, 12.0, 2.0])
    U = np.array([[1.0, 2.0, 1.0], [0.0, 2.0, -2.0], [0.0, 0.0, 5.0]])

    # 左乘行向量：结果是各行的线性组合
    row = np.array([1.0, 2.0, 7.0])
    print("[1 2 7] @ A =", row @ A)
    print("1 * 行一 + 2 * 行二 + 7 * 行三 =", A[0] + 2 * A[1] + 7 * A[2])

    # 把消元的每一步写成矩阵：把单位矩阵改一个位置
    E21 = np.eye(3)
    E21[1, 0] = -3.0  # 第二行 减去 3 倍的第一行
    E32 = np.eye(3)
    E32[2, 1] = -2.0  # 第三行 减去 2 倍的第二行
    print("E21 =")
    print(E21)
    print("E32 =")
    print(E32)
    print("E21 @ A =")
    print(E21 @ A)

    # 先后左乘两次，等于一次左乘 E = E32 @ E21（结合律）
    step_by_step = E32 @ (E21 @ A)
    E = E32 @ E21
    print("E32 @ E21 @ A 等于 U：", np.allclose(step_by_step, U))
    print("E =")
    print(E)
    print(
        "(E32 @ E21) @ A 等于 E32 @ (E21 @ A)：",
        np.allclose(E @ A, step_by_step),
    )

    # 右端项经历的是同一串行操作，得到 c
    c = E @ b
    print("c = E @ b =", c)
    print("U x = c 的解：", np.linalg.solve(U, c))


if __name__ == "__main__":
    main()
```

```text
[1 2 7] @ A = [ 7. 46. 10.]
1 * 行一 + 2 * 行二 + 7 * 行三 = [ 7. 46. 10.]
E21 =
[[ 1.  0.  0.]
 [-3.  1.  0.]
 [ 0.  0.  1.]]
E32 =
[[ 1.  0.  0.]
 [ 0.  1.  0.]
 [ 0. -2.  1.]]
E21 @ A =
[[ 1.  2.  1.]
 [ 0.  2. -2.]
 [ 0.  4.  1.]]
E32 @ E21 @ A 等于 U： True
E =
[[ 1.  0.  0.]
 [-3.  1.  0.]
 [ 6. -2.  1.]]
(E32 @ E21) @ A 等于 E32 @ (E21 @ A)： True
c = E @ b = [  2.   6. -10.]
U x = c 的解： [ 2.  1. -2.]
```

这里有两个点。

第一，$E_{32} E_{21} A = U$。他说，一个小小的式子里装着整讲的内容。

第二，$(E_{32} E_{21}) A = E_{32} (E_{21} A)$。这就是结合律，括号可以移动，顺序不能变。他说你可以把“结合律”这个词忘了，但不要忘了这条规则，因为线性代数里很多证明就是把括号挪一挪。把 $E_{32} E_{21}$ 先乘出来就是矩阵 $E$，它一步完成整个消元。

再看 $E$ 本身：

$$
E = E_{32} E_{21} = \begin{bmatrix} 1 & 0 & 0 \\ -3 & 1 & 0 \\ 6 & -2 & 1 \end{bmatrix}
$$

左下角出现了 6，而乘数里并没有 6：它是 $3 \times 2$，因为第三行减去的“2 倍第二行”里，第二行本身已经减过 3 倍第一行了。他在这里说了一句“有一个更好的办法”，办法是反过来想，从 $U$ 回到 $A$，那时乘数会原封不动地落进矩阵里。这是第 4 讲的 $A = LU$。

## 换行矩阵、顺序与逆

消元里还有一种基本矩阵：换行。他先举二阶的例子，用 $\begin{bmatrix} a & b \\ c & d \end{bmatrix}$：要交换两行，就取 0 份第一行加 1 份第二行当新的第一行，1 份第一行加 0 份第二行当新的第二行。得到

$$
P = \begin{bmatrix} 0 & 1 \\ 1 & 0 \end{bmatrix}
$$

这是置换矩阵（permutation matrix）。找它的捷径是把单位矩阵的两行交换。

然后是一个好问题：要交换两列怎么办？答案是同一个 $P$，但放在右边。**左乘做行操作，右乘做列操作。** 下面的脚本用 $\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}$ 代替字母，验证 $PM$ 换行、$MP$ 换列。同一块里还验证了他反复强调的另一条：矩阵乘法没有交换律，$E_{32} E_{21} \ne E_{21} E_{32}$。最后算他在最后几分钟举的逆矩阵例子：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    M = np.array([[1.0, 2.0], [3.0, 4.0]])  # 相当于他黑板上的 [a b; c d]

    # 把单位矩阵的两行交换，就得到交换两行的矩阵 P
    P = np.eye(2)[[1, 0]]
    print("P =")
    print(P)
    print("P @ M（左乘，换行）：")
    print(P @ M)
    print("M @ P（右乘，换列）：")
    print(M @ P)

    # 乘法不满足交换律
    E21 = np.eye(3)
    E21[1, 0] = -3.0
    E32 = np.eye(3)
    E32[2, 1] = -2.0
    print("E32 @ E21 =")
    print(E32 @ E21)
    print("E21 @ E32 =")
    print(E21 @ E32)
    print("两者相等：", np.allclose(E32 @ E21, E21 @ E32))

    # E21 的逆：把减掉的 3 倍第一行加回去
    E21_inv = np.eye(3)
    E21_inv[1, 0] = 3.0
    print("E21_inv @ E21 是单位矩阵：", np.allclose(E21_inv @ E21, np.eye(3)))
    print("与 np.linalg.inv 一致：", np.allclose(E21_inv, np.linalg.inv(E21)))


if __name__ == "__main__":
    main()
```

```text
P =
[[0. 1.]
 [1. 0.]]
P @ M（左乘，换行）：
[[3. 4.]
 [1. 2.]]
M @ P（右乘，换列）：
[[2. 1.]
 [4. 3.]]
E32 @ E21 =
[[ 1.  0.  0.]
 [-3.  1.  0.]
 [ 6. -2.  1.]]
E21 @ E32 =
[[ 1.  0.  0.]
 [-3.  1.  0.]
 [ 0. -2.  1.]]
两者相等： False
E21_inv @ E21 是单位矩阵： True
与 np.linalg.inv 一致： True
```

$PM$ 把 $(1, 2)$、$(3, 4)$ 两行对调，$MP$ 把 $(1, 3)$、$(2, 4)$ 两列对调。顺序也确实重要：$E_{32} E_{21}$ 的 $(3, 1)$ 位置是 6，而 $E_{21} E_{32}$ 的 $(3, 1)$ 位置是 0，两个乘积不相等。

直觉上也好理解：先“减掉 3 倍第一行”再“从第三行里减 2 倍的新第二行”，和先后颠倒的两步，做的是不同的事，第一种里第三行间接用到了第一行，第二种没有。他说要把矩阵保持在“Gauss 给的顺序”里（这句话我读了两遍才反应过来是在开玩笑）。

最后，逆。$E_{21}$ 做的是“第二行减去 3 倍第一行”，要撤销它就“把 3 倍第一行加回去”：把 $-3$ 改成 $+3$。脚本验证了 $E_{21}^{-1} E_{21}$ 是单位矩阵，也和 `np.linalg.inv` 的结果一致。如果要找一个类比，逆矩阵就是撤销键。他停在这里：“这是下周一内容的一个小预告。”

下一讲从这里继续：矩阵到底怎么乘，为什么有四种看法，哪些矩阵有逆，哪些没有。见 [18.06 第 3 讲：矩阵乘法的四种看法与逆矩阵](/posts/linear-algebra-03-multiplication-and-inverse/)。
