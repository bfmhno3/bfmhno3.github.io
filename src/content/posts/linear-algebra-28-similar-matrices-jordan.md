---
title: "18.06 第 28 讲：相似矩阵与 Jordan 标准形"
commentId: "post:linear-algebra-28-similar-matrices-jordan"
published: "2026-10-18 17:20:00 +08:00"
description: "MIT 18.06 第 28 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 验证了相似矩阵的特征值相同，再给 4 阶 Jordan 块加了 1e-10 的扰动，特征值就跑到了模长 3.16e-03 的位置。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 相似矩阵
  - Jordan 标准形
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 29
draft: false
comment: true
slug: linear-algebra-28-similar-matrices-jordan
---

这一讲的主角是 $B = M^{-1}AM$：同一个线性变换换一套基写下来，矩阵就变成了 $B$，但特征值一个都没变。Strang 把所有这样连起来的矩阵叫作一个“家族”，每个家族里挑一个最规整的代表，这个代表就是 Jordan 标准形。可是我把一个 4 阶 Jordan 块的左下角改了 $10^{-10}$，特征值立刻从 0 跑到了模长 $3.16 \times 10^{-3}$，放大了 3000 多万倍。他在课上说 Jordan 形在数值上不是好东西，我一开始以为是客气话。

> [!NOTE] 本讲速览
> 视频：[Lecture 28: Similar matrices and Jordan form](https://www.youtube.com/watch?v=TSdXJw83kyA)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-28-similar-matrices-and-jordan-form/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §6.2 Diagonalizing a Matrix；Appendix 5 The Jordan Form of a Square Matrix
> 前置：[第 27 讲：正定矩阵与极小值](/posts/linear-algebra-27-positive-definite-minima/)
> 一句话：相似矩阵有相同的特征值；每个方阵都相似于一个 Jordan 矩阵，对角化只是它不缺特征向量时的特例。

> [!TIP] 配合视频
> - 前十分钟还在讲正定矩阵：逆矩阵、$A + B$、$A^\mathsf{T}A$ 是不是正定。这段很短，我在第一节用代码过了一遍，可以倍速。
> - 他证明“相似矩阵特征值相同”的那几行（在 $A\mathbf{x} = \lambda\mathbf{x}$ 中间塞一个 $MM^{-1}$）值得认真看，整讲只有这一处是证明。
> - 他当场“编”一个 $M$ 去算 $M^{-1}AM$，一路算一路惊呼怎么会是 $-15$，随后用迹和行列式验算。这一段有人味，不必倍速。
> - 后半段讲 $4 \times 4$ 的 Jordan 块那几分钟信息密度最高：两个矩阵特征值相同、特征向量个数也相同，却不相似。暂停看一遍黑板上的两个矩阵。

## 开头十分钟：正定矩阵从哪里来

这是上一讲的尾巴。他想补一句：正定矩阵不是凭空冒出来的，最常见的出处是最小二乘里那个 $A^\mathsf{T}A$。他顺手问了三个问题，我用 NumPy 各验证一次。

**对称正定矩阵的逆还正定吗？** 还正定，因为逆矩阵的特征值是原来的倒数，正数的倒数还是正数。（他的原话大意是：逆矩阵的主元我们知道得不多，特征值我们什么都知道。）

**两个正定矩阵相加呢？** 主元和特征值都帮不上忙，但二次型可以：$\mathbf{x}^\mathsf{T}(A + B)\mathbf{x} = \mathbf{x}^\mathsf{T}A\mathbf{x} + \mathbf{x}^\mathsf{T}B\mathbf{x}$，两项都大于 0，和当然大于 0。

**长方形的 $A$ 呢？** $A$ 本身不对称，甚至不是方阵，无从谈起正定。但 $\mathbf{x}^\mathsf{T}A^\mathsf{T}A\mathbf{x} = (A\mathbf{x})^\mathsf{T}(A\mathbf{x}) = \|A\mathbf{x}\|^2 \ge 0$。想让它严格大于 0，只需要 $A\mathbf{x}$ 除了 $\mathbf{x} = \mathbf{0}$ 之外都不为 0，也就是 $A$ 的零空间里只有零向量，也就是 $A$ 的列线性无关。他的例子是 11 × 5 的矩阵，秩要等于 5。

下面的脚本里，$G$ 是随机的 11 × 5 矩阵，$H$ 是把第五列抄成第四列的版本：

```python
import numpy as np


def is_pd(M: np.ndarray) -> bool:
    return bool(np.all(np.linalg.eigvalsh(M) > 1e-12))


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # 对称正定矩阵的逆：特征值取倒数
    A = np.array([[2.0, 1.0], [1.0, 2.0]])
    print("A 的特征值：", np.linalg.eigvalsh(A))
    print("A^-1 的特征值：", np.linalg.eigvalsh(np.linalg.inv(A)))

    # 两个正定矩阵之和：x^T (A + B) x = x^T A x + x^T B x
    B = np.array([[3.0, -2.0], [-2.0, 3.0]])
    print("A、B、A + B 都正定：", is_pd(A), is_pd(B), is_pd(A + B))
    x = rng.standard_normal(2)
    print(
        "二次型可加：",
        np.isclose(x @ (A + B) @ x, x @ A @ x + x @ B @ x),
    )

    # 11 x 5 的长方形矩阵：G^T G 是方阵、对称，而且正定
    G = rng.standard_normal((11, 5))
    K = G.T @ G
    x = rng.standard_normal(5)
    print(
        f"x^T K x = {x @ K @ x:.6f}，|Gx|^2 = {np.linalg.norm(G @ x) ** 2:.6f}"
    )
    print(f"K 的最小特征值：{np.linalg.eigvalsh(K).min():.4f}")

    # 第五列抄第四列：零空间不再只有零向量，只剩半正定
    H = G.copy()
    H[:, 4] = H[:, 3]
    K2 = H.T @ H
    n = np.array([0.0, 0.0, 0.0, 1.0, -1.0])
    print("H 的秩：", np.linalg.matrix_rank(H))
    print(f"n^T K2 n = {n @ K2 @ n:.1e}")
    print(f"K2 的最小特征值：{np.linalg.eigvalsh(K2).min():.1e}")


if __name__ == "__main__":
    main()
```

```text
A 的特征值： [1. 3.]
A^-1 的特征值： [0.3333 1.    ]
A、B、A + B 都正定： True True True
二次型可加： True
x^T K x = 16.278015，|Gx|^2 = 16.278015
K 的最小特征值：2.7552
H 的秩： 4
n^T K2 n = 0.0e+00
K2 的最小特征值：4.4e-16
```

$A + B$ 的三个“正定”都是 `True`。$G$ 的 $K = G^\mathsf{T}G$ 最小特征值是 2.7552，完全正定；$\mathbf{x}^\mathsf{T}K\mathbf{x}$ 和 $\|G\mathbf{x}\|^2$ 在六位小数内相同，因为它们本来就是同一个数。$H$ 的秩掉到 4，零空间里多了 $(0, 0, 0, 1, -1)$：沿着这个方向二次型是 0，最小特征值只剩 $4.4 \times 10^{-16}$，也就是舍入误差，正定退化成半正定。

## 相似矩阵：同一个家族，同一组特征值

**“相似”是什么意思？** 两个 $n \times n$ 矩阵 $A$ 和 $B$ 相似，指的是存在可逆矩阵 $M$，使得

$$
B = M^{-1}AM
$$

上一章的对角化是它的特例：$A$ 有一整套特征向量时，取 $M = S$（特征向量矩阵），$S^{-1}AS = \Lambda$。所以 $A$ 相似于 $\Lambda$。换一个别的 $M$，得到的 $B$ 不是对角的，但仍然和 $A$ 相似。Strang 把相似的矩阵看成一个“家族”，对角的 $\Lambda$ 是家族里最体面的成员。

他在黑板上的例子是 $A = \begin{bmatrix} 2 & 1 \\ 1 & 2 \end{bmatrix}$，特征值 3 和 1。他随手编了 $M = \begin{bmatrix} 1 & 4 \\ 0 & 1 \end{bmatrix}$（上三角，逆矩阵好写），算出

$$
B = M^{-1}AM = \begin{bmatrix} -2 & -15 \\ 1 & 6 \end{bmatrix}
$$

这个矩阵看上去什么特点也没有，但迹是 $-2 + 6 = 4$，行列式是 $-12 + 15 = 3$，和 $A$ 的迹 4、行列式 3 一样，所以特征值也是 3 和 1。（他自己心算 $M^{-1}AM$ 的时候也算得磕磕绊绊，我这里让 NumPy 来。）

**为什么特征值不变？** 从 $A\mathbf{x} = \lambda\mathbf{x}$ 出发，在 $A$ 和 $\mathbf{x}$ 之间塞一个 $MM^{-1}$，两边左乘 $M^{-1}$：

$$
M^{-1}AMM^{-1}\mathbf{x} = \lambda M^{-1}\mathbf{x}
\quad\Longrightarrow\quad
B\,(M^{-1}\mathbf{x}) = \lambda\,(M^{-1}\mathbf{x})
$$

$\lambda$ 也是 $B$ 的特征值，对应的特征向量是 $M^{-1}\mathbf{x}$。特征值留下了，特征向量被 $M^{-1}$ 挪了个位置。（要是连特征向量也不动，$B$ 大概就等于 $A$ 了。）我把这几句都跑了一遍，同时在家族里另找两个三角矩阵：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    A = np.array([[2.0, 1.0], [1.0, 2.0]])
    M = np.array([[1.0, 4.0], [0.0, 1.0]])
    B = np.linalg.inv(M) @ A @ M
    print("B = M^-1 A M =")
    print(B)
    print("A 的特征值：", np.sort(np.linalg.eigvals(A)))
    print("B 的特征值：", np.sort(np.linalg.eigvals(B)))
    print("迹：", np.trace(A), np.trace(B))
    print(f"行列式：{np.linalg.det(A):.4f} {np.linalg.det(B):.4f}")

    # 特征向量被 M^-1 挪了个位置
    lam, V = np.linalg.eig(A)
    W = np.linalg.inv(M) @ V
    print("M^-1 x 是 B 的特征向量：", np.allclose(B @ W, W * lam))

    # 对角化是最特殊的一次相似：M 取特征向量矩阵 S
    S = V
    print("S^-1 A S =")
    print(np.linalg.inv(S) @ A @ S)

    # 家族里再取几个成员：迹是 4，行列式是 3
    C = np.array([[1.0, 5.0], [0.0, 3.0]])
    D = np.array([[3.0, 1.0], [0.0, 1.0]])
    for name, X in [("三角 C", C), ("三角 D", D)]:
        print(name, "的特征值：", np.sort(np.linalg.eigvals(X)))
    print("A 和 B 的特征向量相同吗：", np.allclose(np.abs(V), np.abs(W)))


if __name__ == "__main__":
    main()
```

```text
B = M^-1 A M =
[[ -2. -15.]
 [  1.   6.]]
A 的特征值： [1. 3.]
B 的特征值： [1. 3.]
迹： 4.0 4.0
行列式：3.0000 3.0000
M^-1 x 是 B 的特征向量： True
S^-1 A S =
[[ 3.  0.]
 [-0.  1.]]
三角 C 的特征值： [1. 3.]
三角 D 的特征值： [1. 3.]
A 和 B 的特征向量相同吗： False
```

`B` 和 `A` 的特征值都是 $[1, 3]$，迹都是 4，行列式都是 3.0000。`M^-1 x 是 B 的特征向量` 为 `True`，而 `A 和 B 的特征向量相同吗` 为 `False`，对应他说的“特征向量被挪了位置”。最后两个三角矩阵 $\begin{bmatrix} 1 & 5 \\ 0 & 3 \end{bmatrix}$ 和 $\begin{bmatrix} 3 & 1 \\ 0 & 1 \end{bmatrix}$ 的特征值也是 1 和 3：迹为 4、行列式为 3 的 2 × 2 矩阵，特征多项式都是 $\lambda^2 - 4\lambda + 3$，特征值都是 3 和 1，互不相同，所以它们都和 $\Lambda$ 相似，也就彼此相似。

如果硬要找个类比，我觉得它像同一座城市用不同的坐标系画地图：街道的连通方式（特征值）是地图的内在性质，地图怎么摆（特征向量）取决于你选哪个原点和朝向。这个类比到这里就收。

## 孤家寡人 4I 和只有一个特征向量的 Jordan 块

**特征值重复了会怎样？** 刚才的家族之所以好，是因为两个特征值 3 和 1 不同。如果两个特征值相等，就可能缺特征向量，对角化不再保证。Strang 取了特征值 4 和 4：

- $4I$ 自己一个家族。（他说到这里承认，学到 18.06 的这个阶段，他已经把矩阵当人看了。）
- 任何 $M$ 都有 $M^{-1}(4I)M = 4M^{-1}M = 4I$，挪不出第二个成员。
- 其余所有迹为 8、行列式为 16 的矩阵（他举了 $\begin{bmatrix} 5 & 1 \\ -1 & 3 \end{bmatrix}$ 和 $\begin{bmatrix} 4 & 17 \\ 0 & 4 \end{bmatrix}$）都在另一个家族里。这个家族里不可能有对角矩阵，因为对角的只能是 $4I$，而 $4I$ 不相似于其中任何一个。

这个大家族里最规整的是 Jordan 块 $J = \begin{bmatrix} 4 & 1 \\ 0 & 4 \end{bmatrix}$。他说他把 1 改成 10 或者 100 万，也能找到 $M$ 连回来，所以都是亲戚，Jordan 挑的是最简洁的那个，对角线上方保留一个 1。

下面用特征向量个数（$2 - \operatorname{rank}(X - 4I)$）当“指纹”：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # 4I 是孤家寡人：任何 M 都挪不动它
    four = 4.0 * np.eye(2)
    M = rng.standard_normal((2, 2))
    moved = np.linalg.inv(M) @ four @ M
    print("M^-1 (4I) M = 4I：", np.allclose(moved, four))

    # 特征值 4、4 的另一族：迹 8、行列式 16，只有一个特征向量
    J = np.array([[4.0, 1.0], [0.0, 4.0]])
    family = {
        "J": J,
        "[[5, 1], [-1, 3]]": np.array([[5.0, 1.0], [-1.0, 3.0]]),
        "[[4, 17], [0, 4]]": np.array([[4.0, 17.0], [0.0, 4.0]]),
        "M^-1 J M": np.linalg.inv(M) @ J @ M,
    }
    for name, X in family.items():
        rank = np.linalg.matrix_rank(X - 4.0 * np.eye(2), tol=1e-8)
        print(
            f"{name:>18}：迹 {np.trace(X):.1f}，det {np.linalg.det(X):.1f}，"
            f"特征向量个数 {2 - rank}"
        )

    # 4I 有两个特征向量，J 只有一个：所以不可能相似
    rank = np.linalg.matrix_rank(four - 4.0 * np.eye(2))
    print("4I 的特征向量个数：", 2 - rank)

    # 对 J 求特征向量矩阵：两列平行，S 奇异（容差内），凑不出对角化
    _, S = np.linalg.eig(J)
    print("eig(J) 的特征向量矩阵：")
    print(S)
    print("S 的秩（容差 1e-8）：", np.linalg.matrix_rank(S, tol=1e-8))


if __name__ == "__main__":
    main()
```

```text
M^-1 (4I) M = 4I： True
                 J：迹 8.0，det 16.0，特征向量个数 1
 [[5, 1], [-1, 3]]：迹 8.0，det 16.0，特征向量个数 1
 [[4, 17], [0, 4]]：迹 8.0，det 16.0，特征向量个数 1
          M^-1 J M：迹 8.0，det 16.0，特征向量个数 1
4I 的特征向量个数： 2
eig(J) 的特征向量矩阵：
[[ 1. -1.]
 [ 0.  0.]]
S 的秩（容差 1e-8）： 1
```

四个成员的特征向量个数都是 1，而 $4I$ 是 2，所以 $4I$ 不可能和它们相似，和 Strang 说的一致。`np.linalg.eig(J)` 给出的特征向量矩阵是 $\begin{bmatrix} 1 & -1 \\ 0 & 0 \end{bmatrix}$，两列平行，秩（容差 $10^{-8}$）是 1，没法当 $S$ 用：Jordan 块只有一个特征向量，就是对角化失败的原因。（`M^-1 J M` 那一行我最初没加 `tol`，默认容差把噪声当成了秩，算出 0 个特征向量，我才发现应该显式给容差。）

## 光数特征向量还不够

**特征值相同、特征向量个数也相同，就相似了吗？** 他接着给了一对 4 × 4 矩阵，让人做噩梦：特征值都是 4 个 0。

- 第一个：$J_1$ 的 $(1, 2)$ 和 $(3, 4)$ 位置是 1，其余是 0。它是两个 2 × 2 的 Jordan 块。
- 第二个：$(1, 2)$ 和 $(2, 3)$ 位置是 1，其余是 0。它是一个 3 × 3 块加一个 1 × 1 块。

两个矩阵的秩都是 2，所以零空间维数都是 $4 - 2 = 2$，各有两个特征向量，缺两个。他说光数特征向量，它们看上去像是相似的，其实不相似。区别在块的大小：每个 Jordan 块贡献一个特征向量，块数就是特征向量个数，但块大小不同，家族就不同。这里的判别方法他没讲，我用的是 $N^k$ 的秩：

```python
import numpy as np


def nilpotent(blocks: list[int]) -> np.ndarray:
    """按块大小构造特征值全为 0 的 Jordan 矩阵。"""
    n = sum(blocks)
    N = np.zeros((n, n))
    start = 0
    for size in blocks:
        for i in range(start, start + size - 1):
            N[i, i + 1] = 1.0
        start += size
    return N


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rank = np.linalg.matrix_rank

    two_two = nilpotent([2, 2])
    three_one = nilpotent([3, 1])
    print("2 + 2 块：")
    print(two_two)
    print("3 + 1 块：")
    print(three_one)
    for name, N in [("2 + 2", two_two), ("3 + 1", three_one)]:
        ranks = [int(rank(np.linalg.matrix_power(N, k))) for k in range(4)]
        print(f"{name}：特征值 {np.linalg.eigvals(N)}，N^k 的秩 {ranks}")

    # 把 2 + 2 里的一个 0 换成 7：Strang 没说是哪个 0，两种选法差别很大
    for pos in [(0, 3), (1, 2)]:
        X = two_two.copy()
        X[pos] = 7.0
        ranks = [int(rank(np.linalg.matrix_power(X, k))) for k in range(4)]
        print(f"位置 {pos} 换成 7：N^k 的秩 {ranks}")

    # 用 M^-1 X M 随便挪一下，N^k 的秩序列不变
    rng = np.random.default_rng(1806)
    M = rng.standard_normal((4, 4))
    Y = np.linalg.inv(M) @ two_two @ M
    ranks = [
        int(rank(np.linalg.matrix_power(Y, k), tol=1e-8)) for k in range(4)
    ]
    print("相似挪动后的 2 + 2：N^k 的秩", ranks)


if __name__ == "__main__":
    main()
```

```text
2 + 2 块：
[[0. 1. 0. 0.]
 [0. 0. 0. 0.]
 [0. 0. 0. 1.]
 [0. 0. 0. 0.]]
3 + 1 块：
[[0. 1. 0. 0.]
 [0. 0. 1. 0.]
 [0. 0. 0. 0.]
 [0. 0. 0. 0.]]
2 + 2：特征值 [0. 0. 0. 0.]，N^k 的秩 [4, 2, 0, 0]
3 + 1：特征值 [0. 0. 0. 0.]，N^k 的秩 [4, 2, 1, 0]
位置 (0, 3) 换成 7：N^k 的秩 [4, 2, 0, 0]
位置 (1, 2) 换成 7：N^k 的秩 [4, 3, 2, 1]
相似挪动后的 2 + 2：N^k 的秩 [4, 2, 0, 0]
```

$N$ 的秩两个矩阵都是 2，$N^2$ 的秩才分出高下：2 + 2 是 0，3 + 1 是 1。这是 Jordan 结构的指纹，经过相似变换不变（最后一行，用随机的 $M$ 挪过以后还是 $[4, 2, 0, 0]$）。

他还说，把 2 + 2 里的“一个 0”改成 7，秩仍然是 2，还是同一个家族，只是不如原来那个好看。转写里没说清是哪个 0，所以我两种都试了：改 $(1, 4)$ 位置，秩序列还是 $[4, 2, 0, 0]$，确实同族；改 $(2, 3)$ 位置（两个块之间那一格），秩变成 $[4, 3, 2, 1]$，已经变成一个 4 阶块了。我猜他指的是前者，毕竟他是在强调“秩没变”。

于是 Jordan 定理的完整表述就清楚了：每个方阵相似于一个 Jordan 矩阵 $J$，由若干 Jordan 块拼成，对角线上是特征值，块内对角线上方是 1。块数等于特征向量个数。特征值互不相同时，每块是 1 × 1，$J = \Lambda$，这是“好情形”，整门课主要讲这个。

## Jordan 形为什么在数值上不好用

**他自己对 Jordan 形是什么态度？** 他说得很直白：二十年前上 18.06，这是课程的高潮；现在不是了，因为它“依赖特征值恰好相同”，你得精确知道特征值，还得精确知道秩，数字稍微变一点，特征值变了、秩变了，整个结构就变了。他最后说，期末考试大概不会让你算一个四重特征值的 Jordan 形，他自己不太喜欢 Jordan 形，对正定矩阵和下一讲的 SVD 倒是很积极。

我想把他这个说法量化。取扰动 $\varepsilon = 10^{-10}$：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=6, suppress=False)
    eps = 1e-10

    # 2 x 2：4I 加扰动，对比 Jordan 块加扰动
    diag = 4.0 * np.eye(2)
    J = np.array([[4.0, 1.0], [0.0, 4.0]])
    bump = eps * np.array([[0.0, 1.0], [1.0, 0.0]])
    for name, X in [("4I", diag), ("J", J)]:
        lam = np.linalg.eigvals(X + bump)
        print(f"{name} + 1e-10：特征值 {lam}，偏离 {abs(lam - 4).max():.2e}")

    # 4 x 4：一个 4 阶 Jordan 块，扰动落在左下角
    N = np.diag(np.ones(3), k=1)
    N[3, 0] = eps
    lam = np.linalg.eigvals(N)
    print(f"4 阶块 + 1e-10：|lambda| = {abs(lam).max():.2e}")
    print(f"理论值 eps^(1/4) = {eps**0.25:.2e}")

    # 秩：Jordan 结构靠“恰好为零”，扰动之后秩立刻变了
    two_two = np.diag([1.0, 0.0, 1.0], k=1)
    noisy = two_two + eps * np.diag(np.ones(3), k=-1)
    print("N^2 的秩（精确）：", np.linalg.matrix_rank(two_two @ two_two))
    print(
        "N^2 的秩（加 1e-10 后，默认容差）：",
        np.linalg.matrix_rank(noisy @ noisy),
    )

    # 对 J 加 1e-10 的扰动，特征向量矩阵有多病态
    _, S = np.linalg.eig(J + bump)
    print("特征向量矩阵的条件数：", f"{np.linalg.cond(S):.2e}")


if __name__ == "__main__":
    main()
```

```text
4I + 1e-10：特征值 [4. 4.]，偏离 1.00e-10
J + 1e-10：特征值 [4.00001 3.99999]，偏离 1.00e-05
4 阶块 + 1e-10：|lambda| = 3.16e-03
理论值 eps^(1/4) = 3.16e-03
N^2 的秩（精确）： 0
N^2 的秩（加 1e-10 后，默认容差）： 4
特征向量矩阵的条件数： 1.00e+05
```

四个数字：

- 对角化的 $4I$ 加一个 $10^{-10}$ 的对称扰动，特征值偏离 $1.00 \times 10^{-10}$，和扰动同量级。
- 2 × 2 的 Jordan 块加同样的扰动，偏离 $1.00 \times 10^{-5}$，放大 $10^5$ 倍。理由是特征多项式变成 $(4 - \lambda)^2 = \varepsilon(1 + \varepsilon)$，特征值跑去 $4 \pm \sqrt{\varepsilon}$。
- 4 阶 Jordan 块的左下角放 $10^{-10}$，特征值模长是 $3.16 \times 10^{-3}$，正好是 $\varepsilon^{1/4}$：放大 3000 多万倍。
- 2 + 2 那个矩阵的次对角线加上 $10^{-10}$ 以后，$N^2$ 的秩从精确的 0 变成 4（默认容差）。而他强调的正是“靠秩来区分 Jordan 结构”。

另外加了扰动的 $J$ 其实有两个不同的特征值，可以对角化，但特征向量矩阵的条件数是 $1.00 \times 10^5$：用它去做相似变换会放大误差，没什么好处。据我所知，实际的数值软件不去算 Jordan 形，而是用 Schur 分解这类稳定的三角化，不过这一点我没有在本讲里验证。

## 在控制里

重极点正是 Jordan 块的用武之地。状态矩阵 $A$ 有一个二重极点 $\lambda$ 又缺一个特征向量时，$\dot{\mathbf{x}} = A\mathbf{x}$ 的解里不只有 $e^{\lambda t}$，还有 $t\,e^{\lambda t}$：对 $J = \begin{bmatrix} \lambda & 1 \\ 0 & \lambda \end{bmatrix}$，有 $e^{Jt} = e^{\lambda t}\begin{bmatrix} 1 & t \\ 0 & 1 \end{bmatrix}$。我用 Taylor 级数验证了 $\lambda = -1$ 的情形：$t = 1$ 时右上角是 0.3679（即 $1/e$，也是 $te^{-t}$ 的峰值），$t = 10$ 时降到 $4.5 \times 10^{-4}$。这个响应先升后降，稳定，但不是单纯的指数衰减。据我所知，临界阻尼系统的响应里就有这样的 $t\,e^{-t}$ 项。

模态坐标是一个相似变换：取 $\mathbf{z} = S^{-1}\mathbf{x}$，$\dot{\mathbf{z}} = \Lambda\mathbf{z}$，每个模态各走各的，$z_i(t) = e^{\lambda_i t}z_i(0)$。脚本里 $A = \begin{bmatrix} -1 & 2 \\ 0 & -3 \end{bmatrix}$ 的两个极点是 $-1$ 和 $-3$，模态初值是 $(2, 1.4142)$，用模态坐标算出的 $\mathbf{x}(2)$ 与直接用级数算出的一致。但是 Jordan 块的 `eig` 给出的特征向量矩阵秩为 1，没有 $S^{-1}$，模态坐标这条路走不通，只能退到 Jordan 形，保留那个 1 带来的 $t\,e^{\lambda t}$ 项。

```python
import numpy as np


def taylor_exp(A: np.ndarray, terms: int = 60) -> np.ndarray:
    """用 Taylor 级数求 exp(A)。"""
    result = np.eye(A.shape[0])
    term = np.eye(A.shape[0])
    for k in range(1, terms):
        term = term @ A / k
        result = result + term
    return result


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 重极点 -1：x' = J x，J 是 2 x 2 的 Jordan 块
    lam = -1.0
    J = np.array([[lam, 1.0], [0.0, lam]])
    for t in [1.0, 5.0, 10.0]:
        E = taylor_exp(J * t)
        closed = np.exp(lam * t) * np.array([[1.0, t], [0.0, 1.0]])
        print(
            f"t = {t:>4}：Taylor 与闭式一致 {np.allclose(E, closed)}，"
            f"x2 的响应 t e^(lt) = {E[0, 1]:.4e}"
        )

    # 模态坐标：对角化后 z' = Lambda z，每个模态各走各的
    A = np.array([[-1.0, 2.0], [0.0, -3.0]])
    eigvals, S = np.linalg.eig(A)
    x0 = np.array([1.0, 1.0])
    z0 = np.linalg.solve(S, x0)
    t = 2.0
    x_direct = taylor_exp(A * t) @ x0
    x_modal = S @ (np.exp(eigvals * t) * z0)
    print("极点：", eigvals, "，模态初值 z0 =", z0)
    print("直接算与模态坐标一致：", np.allclose(x_direct, x_modal))

    # Jordan 块没有足够的特征向量：S 不可逆，模态坐标这条路走不通
    _, SJ = np.linalg.eig(J)
    print("Jordan 块的特征向量矩阵秩：", np.linalg.matrix_rank(SJ))


if __name__ == "__main__":
    main()
```

```text
t =  1.0：Taylor 与闭式一致 True，x2 的响应 t e^(lt) = 3.6788e-01
t =  5.0：Taylor 与闭式一致 True，x2 的响应 t e^(lt) = 3.3690e-02
t = 10.0：Taylor 与闭式一致 True，x2 的响应 t e^(lt) = 4.5400e-04
极点： [-1. -3.] ，模态初值 z0 = [2.     1.4142]
直接算与模态坐标一致： True
Jordan 块的特征向量矩阵秩： 1
```

上一节的结论在这里换个说法：真实系统的极点不会恰好重合，参数一变，二重极点就裂成两个靠得很近的单极点，Jordan 块变成一个病态的对角化。工程上除非有意要临界阻尼，多半会避免把极点放到完全相同的位置（我猜的，这不是本讲的内容）。

下一讲是奇异值分解，Strang 说它十年前还不在课里，现在不讲不行了：任何矩阵（不必是方阵）都能写成 $A = U\Sigma V^\mathsf{T}$，而且数值上很稳。接着看 [18.06 第 29 讲：奇异值分解](/posts/linear-algebra-29-svd/)。
