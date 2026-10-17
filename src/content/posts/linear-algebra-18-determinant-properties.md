---
title: "18.06 第 18 讲：行列式的性质"
commentId: "post:linear-algebra-18-determinant-properties"
published: "2026-10-18 13:40:00 +08:00"
description: "MIT 18.06 第 18 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 逐条验证了 Strang 的十条行列式性质，又手写消元求主元乘积，算 100 × 100 随机矩阵的行列式，和 np.linalg.det 的相对差只有 9.99e-13。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 行列式
  - 主元乘积
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 18
draft: false
comment: true
slug: linear-algebra-18-determinant-properties
---

Strang 这一讲没有先给行列式的公式，而是只给三条性质：单位矩阵的行列式是 1，换行变号，对每一行单独线性。其余七条都从这三条推出来，包括最实用的一条：三角矩阵的行列式是对角线乘积，所以行列式等于主元乘积。我手写了一个只做消元的行列式函数，对一个 100 × 100 的随机矩阵，它算出 3.449180e+77，和 `np.linalg.det` 的相对差是 9.99e-13。三条性质，连同 $\det A \ne 0$ 等价于 $A$ 可逆，就把行列式立住了。

> [!NOTE] 本讲速览
> 视频：[Lecture 18: Properties of determinants](https://www.youtube.com/watch?v=srxexLishgY)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-18-properties-of-determinants/)）
> 教材：《Introduction to Linear Algebra》第 6 版 §5.1 3 by 3 Determinants and Cofactors；§5.2 Computing and Using Determinants
> 前置：[第 17 讲：正交矩阵与 Gram-Schmidt](/posts/linear-algebra-17-orthogonal-matrices-gram-schmidt/)
> 一句话：行列式由“$\det I = 1$、换行变号、对每一行线性”这三条性质唯一确定，由此得到 $\det A$ 等于主元乘积（带上换行的符号），$\det A \ne 0$ 当且仅当 $A$ 可逆。

> [!TIP] 配合视频
> - 开头他先说这一讲是后半门课的开始：行列式是为特征值服务的。这几句值得听，后面几讲为什么要学行列式，这里交代得最清楚。
> - 他推导性质 4（两行相等则行列式为 0）、性质 5（消元不改变行列式）、性质 7（三角矩阵是对角线乘积）的那几段要认真看。每一条都只用前面的性质，是“从三条公理往外长”的范例。本篇的代码只做验证，不替代推导。
> - 性质 9 以后（乘积、逆、转置）讲得快，本篇有对应的数值验证，可以倍速。最后他用 $A = LU$ 证明 $\det A^\mathsf{T} = \det A$，没有讲完，留了一个“排列的奇偶性”的尾巴，下一讲接上。
> - 字幕是自动转写的，有几处断句错位（比如性质 5 和性质 9 的位置夹进了别的句子），读不通时以我这里列出的性质为准。

## 先给三条性质，不给公式

他开场说得很直白：行列式是每个方阵对应的一个数，写作 $\det A$ 或 $|A|$。一个数装不下整个矩阵，但它想把尽可能多的信息塞进这一个数里，其中最重要的一条是：$A$ 可逆当且仅当 $\det A \ne 0$。

然后他问：先给一个大公式，一口气塞给你？他说不。公式里装了太多东西，他宁愿先给三条性质。

- 性质 1：$\det I = 1$。
- 性质 2：交换两行，行列式变号。
- 性质 3：行列式对每一行单独线性。3A：某一行乘 $t$，行列式乘 $t$。3B：某一行是两个向量的和，行列式等于两个行列式的和，其余各行不动。

这三条一给，置换矩阵的行列式就定了：单位矩阵是 1，每换一次行变一次号，所以结果是 $+1$ 或 $-1$，取决于换行次数是偶数还是奇数。他顺手写了 2 × 2 的情形：单位矩阵是 1，换了行的是 $-1$。

**“线性”到底是什么意思？** 他特意强调了两遍，我也在这里停一下，因为这是最容易误会的一条。线性是对一行而言的：保持其余各行不动，只拆第一行。它不是说 $\det(A + B) = \det A + \det B$，那个不成立。他甚至说“怎么才能让录像里留下我没说那句话”。

下面的脚本把性质 1 到 3 逐条验证一遍，矩阵 $A$ 是我随手选的一个 3 阶整数矩阵（挑它只因为行列式恰好是 10，好认）。脚本里还枚举了 3 阶的六个置换矩阵，对照“逆序数”的奇偶性：

```python
import itertools

import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    det = np.linalg.det

    # 性质 1：det(I) = 1
    print("性质 1：det(I) =", det(np.eye(4)))

    # 性质 2：交换两行，符号反转；置换矩阵的行列式是 +1 或 -1
    A = np.array([[1.0, 2.0, 1.0], [3.0, 8.0, 1.0], [0.0, 4.0, 1.0]])
    swapped = A[[1, 0, 2]]
    print(
        "性质 2：det(A) =",
        round(det(A), 4),
        "，换行后",
        round(det(swapped), 4),
    )
    for perm in itertools.permutations(range(3)):
        P = np.eye(3)[list(perm)]
        # 数交换次数：逆序对的个数的奇偶性等于交换次数的奇偶性
        inversions = sum(
            perm[i] > perm[j] for i in range(3) for j in range(i + 1, 3)
        )
        print(f"  {perm}  逆序数 {inversions}  det(P) = {det(P):+.0f}")

    # 性质 3A：一行乘 t，行列式乘 t
    t = 5.0
    scaled = A.copy()
    scaled[0] *= t
    print("性质 3A：", round(det(scaled), 4), "=", t, "*", round(det(A), 4))

    # 性质 3B：只对第一行线性，其余行不动
    u = np.array([1.0, 0.0, 2.0])
    v = np.array([0.0, 3.0, -1.0])
    rest = A[1:]
    first_u = np.vstack([u, rest])
    first_v = np.vstack([v, rest])
    first_sum = np.vstack([u + v, rest])
    print(
        "性质 3B：",
        round(det(first_sum), 4),
        "=",
        round(det(first_u), 4),
        "+",
        round(det(first_v), 4),
    )

    # 但 det(A + B) 不等于 det(A) + det(B)
    B = np.array([[2.0, 0.0, 1.0], [1.0, 1.0, 0.0], [0.0, 3.0, 1.0]])
    print("det(A + B) =", round(det(A + B), 4))
    print("det(A) + det(B) =", round(det(A) + det(B), 4))


if __name__ == "__main__":
    main()
```

```text
性质 1：det(I) = 1.0
性质 2：det(A) = 10.0 ，换行后 -10.0
  (0, 1, 2)  逆序数 0  det(P) = +1
  (0, 2, 1)  逆序数 1  det(P) = -1
  (1, 0, 2)  逆序数 1  det(P) = -1
  (1, 2, 0)  逆序数 2  det(P) = +1
  (2, 0, 1)  逆序数 2  det(P) = +1
  (2, 1, 0)  逆序数 3  det(P) = -1
性质 3A： 50.0 = 5.0 * 10.0
性质 3B： 7.0 = 28.0 + -21.0
det(A + B) = 73.0
det(A) + det(B) = 15.0
```

性质 2 的两行 $\det A = 10$、换行后 $-10$。六个置换矩阵的行列式里三个 $+1$、三个 $-1$，符号正好是逆序数的奇偶性（逆序数就是把 $0, 1, 2$ 排成这个顺序需要的相邻交换次数的奇偶）。性质 3A：第一行乘 5，行列式从 10 变成 50。性质 3B：我把第一行拆成 $u + v$，其余两行不动，$7 = 28 + (-21)$。

最后两行是反例：$\det(A + B) = 73$，而 $\det A + \det B = 10 + 5 = 15$。差了将近五倍，“线性”确实只是对单独一行成立。

## 其余的性质都是这三条推出来的

他接下来的推导是这一讲最漂亮的部分：只用性质 1 到 3，往外长出性质 4 到 7。

**性质 4：两行相等，行列式为 0。** 交换这两行，矩阵没变，所以行列式没变；可是性质 2 说行列式要变号。一个数等于它的相反数，只能是 0。他说“性质 2 就是为这个准备的”。这和“两行相等则秩小于 $n$，不可逆”吻合。

**性质 5：从一行里减去另一行的倍数，行列式不变。** 这是消元里一直在做的那一步，所以这一条最要紧：它说整个消元过程不改变行列式。证明用 2 × 2 就够：第二行变成 $(c - la,\ d - lb)$，按 3B 拆成 $(c, d)$ 和 $(-la, -lb)$ 两个行列式，后一个用 3A 提出 $-l$，剩下两行相等，按性质 4 是 0。所以消元前后的行列式一样，后面他反复用这一条说明 $\det A = \det U$（没有换行的话）。

**性质 6：有一行全是 0，行列式为 0。** 他一开始想用 3A 乘 5，后来换成同学的办法：在 3A 里取 $t = 0$。这对应“消元消出一行 0，说明矩阵奇异”。

**性质 7：三角矩阵的行列式是对角线元素的乘积。** 设对角线是 $d_1, d_2, \dots, d_n$，对角线上方是任意数。若所有 $d_i \ne 0$，用性质 5 往上消去所有非对角元，只剩对角矩阵；用 3A 把 $d_1, \dots, d_n$ 逐行提出来，剩下单位矩阵，轮到性质 1，等于 1。所以结果是 $d_1 d_2 \cdots d_n$。若有某个 $d_i = 0$，消元会得到一行零，性质 6 给出 0，公式依然成立。

下面验证性质 4 到 7，再看他最后检查的 2 × 2 情形：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    det = np.linalg.det
    A = np.array([[1.0, 2.0, 1.0], [3.0, 8.0, 1.0], [0.0, 4.0, 1.0]])

    # 性质 4：两行相等，行列式为 0
    equal_rows = A.copy()
    equal_rows[2] = equal_rows[0]
    print("性质 4：两行相等 det =", round(det(equal_rows), 4))

    # 性质 5：从一行里减去另一行的倍数，行列式不变
    step = A.copy()
    step[1] -= 3.0 * step[0]
    print("性质 5：消元前", round(det(A), 4), "，消元后", round(det(step), 4))

    # 性质 6：有一行全是 0，行列式为 0
    zero_row = A.copy()
    zero_row[1] = 0.0
    print("性质 6：零行 det =", round(det(zero_row), 4))

    # 性质 7：三角矩阵的行列式是对角线上元素的乘积
    U = np.triu(A)
    print(
        "性质 7：det(U) =",
        round(det(U), 4),
        "，对角线乘积 =",
        np.prod(np.diag(U)),
    )

    # 2 x 2：主元乘积就是 ad - bc
    a, b, c, d = 3.0, 5.0, 2.0, 4.0
    second_pivot = d - (c / a) * b
    print("2 x 2：a * (d - c/a * b) =", round(a * second_pivot, 4))
    print("2 x 2：ad - bc =", a * d - b * c)


if __name__ == "__main__":
    main()
```

```text
性质 4：两行相等 det = 0.0
性质 5：消元前 10.0 ，消元后 10.0
性质 6：零行 det = 0.0
性质 7：det(U) = 8.0 ，对角线乘积 = 8.0
2 x 2：a * (d - c/a * b) = 2.0
2 x 2：ad - bc = 2.0
```

性质 4、5、6 的数字都和预期一致：把第三行抄成第一行，行列式是 0；第二行减去 3 倍第一行，行列式仍是 10；零行，行列式是 0。性质 7 里我取的 $U$ 是 $A$ 的上三角部分（`np.triu`），不是消元的结果，只想看 $\det U = 1 \times 8 \times 1 = 8$。

最后两行是他的 2 × 2 检查：用主元乘积算行列式。第一个主元是 $a$，第二个主元是 $d - (c/a)\,b$，两者相乘得 $a \cdot (d - cb/a) = ad - bc$。我取 $a, b, c, d = 3, 5, 2, 4$，第二个主元是 $4 - \tfrac{10}{3} = \tfrac23$，乘出来是 2，和 $ad - bc = 12 - 10 = 2$ 一致。他自己打趣说，所有数学教授都在等他承认：$a = 0$ 时这一步不被允许，要先换行。如果换不成，是因为矩阵奇异。

## 行列式就是主元乘积

性质 7 加上性质 5，就得到他说的“MATLAB 以及任何像样的软件”是怎么算行列式的：

> $\det A = \pm\, d_1 d_2 \cdots d_n$，$d_i$ 是消元得到的主元，符号由换行的次数决定。

没有换行时 $\det A = \det U$，就是主元乘积（对照第 4 讲的 $A = LU$：$\det L = 1$，所以 $\det A = \det U$）。有换行时，每换一次乘一次 $-1$。他的说法是“要特别留意加号还是减号”。

我手写了这个算法：消元到上三角，只在主元为 0 时才换行并记录符号，最后把主元乘起来。三个 3 阶矩阵（不换行、需要换行、奇异）加一个 100 × 100 随机矩阵，都和 `np.linalg.det` 对照：

```python
import numpy as np


def det_by_elimination(A: np.ndarray) -> float:
    """消元到上三角，返回（主元乘积 * 换行的符号）。"""
    U = A.astype(float).copy()
    n = U.shape[0]
    sign = 1.0
    for k in range(n):
        # 主元为 0 时才换行：性质 2 每换一次行，符号反转
        if U[k, k] == 0.0:
            rows = np.nonzero(U[k + 1 :, k])[0]
            if len(rows) == 0:
                return 0.0  # 该列下方全是 0，奇异，性质 6
            swap = k + 1 + rows[0]
            U[[k, swap]] = U[[swap, k]]
            sign = -sign
        for i in range(k + 1, n):
            U[i] -= (U[i, k] / U[k, k]) * U[k]  # 性质 5，行列式不变
    return sign * float(np.prod(np.diag(U)))


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    cases = {
        "无需换行": np.array(
            [[1.0, 2.0, 1.0], [3.0, 8.0, 1.0], [0.0, 4.0, 1.0]]
        ),
        "需要换行": np.array(
            [[0.0, 2.0, 1.0], [3.0, 8.0, 1.0], [0.0, 4.0, 1.0]]
        ),
        "奇异": np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0]]),
    }
    for name, M in cases.items():
        mine = det_by_elimination(M)
        print(f"{name}：消元 {mine:.4f}，np.linalg.det {np.linalg.det(M):.4f}")

    # 100 x 100 的随机矩阵
    rng = np.random.default_rng(1806)
    M = rng.standard_normal((100, 100))
    mine = det_by_elimination(M)
    ref = np.linalg.det(M)
    print(f"100 x 100：消元 {mine:.6e}，np.linalg.det {ref:.6e}")
    print("相对差：", f"{abs(mine - ref) / abs(ref):.2e}")


if __name__ == "__main__":
    main()
```

```text
无需换行：消元 10.0000，np.linalg.det 10.0000
需要换行：消元 6.0000，np.linalg.det 6.0000
奇异：消元 0.0000，np.linalg.det 0.0000
100 x 100：消元 3.449180e+77，np.linalg.det 3.449180e+77
相对差： 9.99e-13
```

三个 3 阶矩阵里，第一个的主元是 $1, 2, 5$，乘积是 10。第二个矩阵第一列的第一个元素是 0，要换行，换一次行之后三个主元是 $3, 2, -1$，乘积 $-6$，再乘换行的符号 $-1$ 得 6。第三个是 $1, 2, \dots, 9$ 排成的奇异矩阵，消元之后最后一个主元是 0，行列式是 0.0000，`np.linalg.det` 也一样。三者都和库函数吻合。

100 × 100 那一行我最在意：我的函数没有选主元，只在 $U_{kk} = 0$ 时才换行，数值上不算好的实现，但结果仍是 3.449180e+77，和 `np.linalg.det` 的相对差只有 9.99e-13（这个量级下 $10^{-13}$ 到 $10^{-12}$ 的差别，就是舍入误差的底噪）。顺便看一眼：一个 100 阶随机矩阵的行列式有 77 位数，教材里的“大公式”要加的项有 $100! \approx 10^{158}$ 个，没人会这样算。下一讲会回到那个公式。

## 乘积、逆、转置

性质 7 之后，他把剩下的两条一口气讲完。

**性质 9：$\det(AB) = \det A \cdot \det B$。** 他说这条有点“从天上掉下来”：之前一直没讲过矩阵相乘，行列式突然有了乘法性质。记住行列式没有加法性质（上面 $73 \ne 15$），但有乘法性质。

由它立刻得到三个推论，他在黑板上一个一个写：

- $\det A^{-1} = 1/\det A$：把 $A^{-1}A = I$ 两边取行列式，$\det A^{-1} \cdot \det A = \det I = 1$。他用 $A = \mathrm{diag}(2, 3)$ 检查：$\det A = 6$，$A^{-1} = \mathrm{diag}(\tfrac12, \tfrac13)$，行列式 $\tfrac16$。$\det A = 0$ 的时候 $A^{-1}$ 不存在，$1/0$ 也没有意义，两边“同时荒谬”。
- $\det A^2 = (\det A)^2$。
- $\det(2A) = 2^n \det A$，不是 $2 \det A$。他的理由：每一行都提出一个 2，一共 $n$ 行，所以是 $2^n$。他把它和体积联系起来：一个盒子每条边都乘 2，体积乘 $2^n$，三维是 8。（这也是他在这一讲唯一提到行列式和体积关系的地方，第 20 讲会专门讲。）

**性质 10：$\det A^\mathsf{T} = \det A$。** 2 × 2 的 $ad - bc$ 一眼就看出来。重要的是推论：之前所有关于“行”的性质，对“列”也成立。零列的行列式是 0，换两列变号。理由很简单：转置，把列变成行，用行的性质，再转置回去。

他的证明用到 $A = LU$：$\det A = \det L \cdot \det U$，$\det A^\mathsf{T} = \det U^\mathsf{T} \cdot \det L^\mathsf{T}$。$L$ 是对角线全为 1 的下三角，性质 7 说它的行列式是 1，$L^\mathsf{T}$ 也是；$U$ 和 $U^\mathsf{T}$ 的对角线相同，行列式都是主元乘积。所以两边相等。他说这只证明了“几乎所有”能 $A = LU$ 的矩阵，有换行的情形留给读者。

验证一下，用固定种子的 5 × 5 随机矩阵：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    det = np.linalg.det
    rng = np.random.default_rng(1806)
    A = rng.standard_normal((5, 5))
    B = rng.standard_normal((5, 5))
    n = A.shape[0]

    # 性质 9：det(AB) = det(A) det(B)
    print("det(AB) =", f"{det(A @ B):.6f}")
    print("det(A) det(B) =", f"{det(A) * det(B):.6f}")

    # 推论：逆、平方、数乘
    print("det(A) =", f"{det(A):.6f}", "，1/det(A) =", f"{1 / det(A):.6f}")
    print("det(inv(A)) =", f"{det(np.linalg.inv(A)):.6f}")
    print(
        "det(A @ A) =",
        f"{det(A @ A):.6f}",
        "，det(A)^2 =",
        f"{det(A) ** 2:.6f}",
    )
    print("det(2A) / det(A) =", f"{det(2 * A) / det(A):.4f}", "，2^n =", 2**n)

    # Strang 的对角例子：A = diag(2, 3)
    D = np.diag([2.0, 3.0])
    print(
        "diag(2, 3)：",
        round(det(D), 4),
        "，逆：",
        round(det(np.linalg.inv(D)), 4),
    )

    # 性质 10：det(A^T) = det(A)，所以列也有同样的性质
    print("性质 10：", np.isclose(det(A.T), det(A)))
    swapped_cols = A[:, [1, 0, 2, 3, 4]]
    print("换两列：", np.isclose(det(swapped_cols), -det(A)))
    zero_col = A.copy()
    zero_col[:, 2] = 0.0
    print("零列 det =", round(det(zero_col), 4))

    # 性质 10 的证明思路：A = LU，det(L) = 1，U 与 U^T 对角线相同
    L = np.tril(rng.standard_normal((n, n)), -1) + np.eye(n)
    U = np.triu(rng.standard_normal((n, n)))
    M = L @ U
    print("det(L) =", det(L), "，det(L^T) =", det(L.T))
    print("det(M) =", f"{det(M):.6f}", "，det(U) =", f"{det(U):.6f}")
    print("det(M^T) =", f"{det(M.T):.6f}", "，det(U^T) =", f"{det(U.T):.6f}")


if __name__ == "__main__":
    main()
```

```text
det(AB) = 0.334636
det(A) det(B) = 0.334636
det(A) = 0.157837 ，1/det(A) = 6.335633
det(inv(A)) = 6.335633
det(A @ A) = 0.024913 ，det(A)^2 = 0.024913
det(2A) / det(A) = 32.0000 ，2^n = 32
diag(2, 3)： 6.0 ，逆： 0.1667
性质 10： True
换两列： True
零列 det = 0.0
det(L) = 1.0 ，det(L^T) = 1.0
det(M) = 0.007649 ，det(U) = 0.007649
det(M^T) = 0.007649 ，det(U^T) = 0.007649
```

逐条读：

- $\det(AB)$ 和 $\det A \cdot \det B$ 都是 0.334636。
- $\det A = 0.157837$，倒数是 6.335633，和 `np.linalg.inv(A)` 的行列式一致。$\det A^2 = 0.024913 = 0.157837^2$。
- $\det(2A) / \det A = 32.0000 = 2^5$，$n = 5$。数乘一个 5 阶矩阵，行列式涨到 32 倍，而不是 2 倍。
- 对角的例子 $\mathrm{diag}(2, 3)$：行列式 6.0，逆的行列式 0.1667，也就是 $\tfrac16$。
- 转置、换两列、零列，三条列性质都成立。
- 最后两行：我取了随机的单位下三角 $L$ 和上三角 $U$，$M = LU$，$\det L = 1.0$，$\det M = \det U = 0.007649$，转置之后 $\det M^\mathsf{T} = \det U^\mathsf{T} = 0.007649$。

## 行列式不是数值上的奇异检验

这一节是我自己加的，不是视频里的内容。Strang 说行列式是“可逆性的检验”，数学上完全对。但是写代码的人要小心：这个检验在浮点数里不太可靠。

最简单的例子：$A = 0.1 I_{400}$，也就是对角线全是 0.1 的 400 阶对角矩阵。它显然可逆，秩 400，条件数 1，和单位矩阵一样好。可它的行列式是 $10^{-400}$，比双精度能表示的最小正数（约 $5 \times 10^{-324}$）还小，会下溢：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)

    # 可逆的矩阵，行列式在浮点数里却可能是 0.0：400 阶的 0.1 * I
    n = 400
    A = 0.1 * np.eye(n)
    sign, logdet = np.linalg.slogdet(A)
    print("det(0.1 I) =", np.linalg.det(A))
    print("slogdet：符号", sign, "，log|det| =", round(logdet, 4))
    print("log10|det| =", round(logdet / np.log(10.0), 1))
    print("秩 =", np.linalg.matrix_rank(A), "，条件数 =", np.linalg.cond(A))
    x = np.linalg.solve(A, np.ones(n))
    print("solve 没问题：x[0] =", round(x[0], 4))


if __name__ == "__main__":
    main()
```

```text
det(0.1 I) = 0.0
slogdet：符号 1.0 ，log|det| = -921.034
log10|det| = -400.0
秩 = 400 ，条件数 = 1.0
solve 没问题：x[0] = 10.0
```

`np.linalg.det` 返回 0.0。如果拿 `det == 0` 判断奇异，这个矩阵会被判成奇异。但 `np.linalg.slogdet` 分开算符号和 $\log|\det|$：符号是 $+1$，$\log|\det A| = -921.034$，除以 $\ln 10$ 就是 $-400.0$，恰好是 $10^{-400}$。秩是 400，条件数是 1.0，`np.linalg.solve` 解出 $x_0 = 10.0$，一点问题没有。

所以我的习惯是：理论里 $\det A \ne 0$，代码里看秩、条件数，或者用 `slogdet`。（`det` 是为了写证明，不是为了写 `if`。）反过来，上面 $\det(2A) = 2^n \det A$ 也提醒我们：行列式对整体缩放极其敏感，它的大小本来就不代表矩阵“离奇异有多远”。

最后一件事。他在视频末尾留了一个尾巴：每个置换要么是奇数次换行，要么是偶数次，不能两者兼有，否则性质 2 自相矛盾，“整个讲座就完了”。这个事实只需要再多一点代数技巧，他说，而一旦成立，行列式就由性质 1、2、3 唯一确定。这一点正好连到下一讲：他会从这三条性质直接写出 $n!$ 项的大公式，再按行展开出代数余子式，见 [18.06 第 19 讲：行列式公式与代数余子式](/posts/linear-algebra-19-determinant-formulas-cofactors/)。
