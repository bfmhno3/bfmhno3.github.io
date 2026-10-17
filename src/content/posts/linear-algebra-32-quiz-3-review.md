---
title: "18.06 第 32 讲：第三次测验复习"
commentId: "post:linear-algebra-32-quiz-3-review"
published: "2026-10-18 18:40:00 +08:00"
description: "MIT 18.06 第 32 讲的配套笔记：我用 Python 3.13 和 NumPy 2.4 把 Strang 复习课里的反对称矩阵、特征值判断题、SVD 的符号问题和“对称又正交”的真假题逐一验证，SVD 的 U 有 4 种符号选法，只有 1 种能还原 A。"
category: Note
tags:
  - 线性代数
  - NumPy
  - MIT 18.06
  - 测验复习
  - 特征值
series: "线性代数：跟着 Strang 重学 18.06"
seriesOrder: 33
draft: false
comment: true
slug: linear-algebra-32-quiz-3-review
---

这一讲没有新定理，Strang 拿几道旧考题把第六章的东西串了一遍：特征值、对称与正定、相似矩阵、SVD。我的做法是把每道题都交给 NumPy 验证。其中最有意思的一个数字出在 SVD：从 $A^TA$ 和 $AA^T$ 分别求出特征向量来拼 $U$，列的符号有 4 种选法，只有 1 种能还原 $A$，另外 3 种的误差分别是 8.4853、11.3137 和 14.1421。

> [!NOTE] 本讲速览
> 视频：[Lecture 32: Quiz 3 review](https://www.youtube.com/watch?v=HgC1l_6ySkc)（[OCW 页面与字幕](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/resources/lecture-32-quiz-3-review/)）
> 教材：《Introduction to Linear Algebra》第 6 版第 6 到 8 章（录像里的测验只到特征值那一章，线性变换留给期末，所以这一讲实际用到的是第 6 章与第 7 章的 SVD）
> 前置：[第 31 讲：基变换与图像压缩](/posts/linear-algebra-31-change-of-basis-compression/)
> 一句话：做特征值的题先看矩阵属于哪个家族，对称、反对称、正交这三类都满足 $AA^T = A^TA$，特征向量正交，剩下的全看特征值。

> [!TIP] 配合视频
> - 开头他列了本章要记住的几条：对称矩阵的实特征值与 $Q\Lambda Q^T$、正定、相似矩阵特征值相同、SVD。这一段很短，值得完整听一遍当清单用。
> - 第一道微分方程题（反对称矩阵）和后面那道“$c$ 取哪些值”的题，我在下面都算过了，可以倍速。其中“$AA^T = A^TA$ 是特征向量正交的精确条件”这句他讲得很快，建议回放。
> - SVD 那一段他承认自己在上一次讲课时符号选错了。这是全篇最值得认真听的地方，本篇第三节用代码复现了这个错误。
> - 最后的“对称又正交”真假题短而密，每一句都是一个结论，暂停着听比较稳。

## 反对称矩阵：特征值在虚轴上

第一道题是一个 3 × 3 的微分方程 $\frac{d\mathbf{u}}{dt} = A\mathbf{u}$，矩阵对角线是 0，上面是 $-1$，下面是 $+1$：

$$
A = \begin{bmatrix} 0 & -1 & 0 \\ 1 & 0 & -1 \\ 0 & 1 & 0 \end{bmatrix}
$$

没有给初值，所以要的是通解 $c_1 e^{\lambda_1 t}\mathbf{x}_1 + c_2 e^{\lambda_2 t}\mathbf{x}_2 + c_3 e^{\lambda_3 t}\mathbf{x}_3$。他先问这个矩阵奇不奇异：第一行和第三行只差一个符号，所以奇异，$\lambda_1 = 0$。再看 $A^T = -A$，反对称矩阵的特征值是纯虚数，特征多项式 $\lambda^3 + 2\lambda = 0$ 给出 $\lambda = 0, \pm\sqrt{2}\,i$。

结论有三个。解既不衰减也不爆炸，因为 $e^{i\sqrt{2}t}$ 的模永远是 1。解是周期的，周期 $T$ 满足 $\sqrt{2}\,T = 2\pi$，即 $T = \pi\sqrt{2}$。特征向量两两正交。下面用 NumPy 一次验证：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # 黑板上的反对称矩阵：对角线为 0，上面是 -1，下面是 +1
    A = np.array([[0.0, -1.0, 0.0], [1.0, 0.0, -1.0], [0.0, 1.0, 0.0]])
    print("A.T == -A：", np.array_equal(A.T, -A))

    lam, S = np.linalg.eig(A)
    print("特征值的虚部：", np.sort(lam.imag))
    print("特征值实部的最大绝对值：", np.abs(lam.real).max())
    print("sqrt(2) =", np.sqrt(2.0))
    # 特征向量两两正交（复向量用共轭转置）
    print("S^H S 是单位矩阵：", np.allclose(S.conj().T @ S, np.eye(3)))
    # 反对称矩阵满足 A A^T = A^T A
    print("A A^T == A^T A：", np.allclose(A @ A.T, A.T @ A))

    # e^{At} = S diag(e^{lambda t}) S^{-1}
    def expm(t: float) -> np.ndarray:
        return (S @ np.diag(np.exp(lam * t)) @ np.linalg.inv(S)).real

    period = np.pi * np.sqrt(2.0)
    print("周期 T = pi * sqrt(2) =", period)
    for t in [0.5 * period, period]:
        err = np.linalg.norm(expm(t) - np.eye(3))
        print(f"t = {t:.4f}：||e^(At) - I|| = {err:.2e}")

    # 解既不增长也不衰减：每个时刻的长度都一样
    u0 = np.array([1.0, 2.0, 3.0])
    ts = np.linspace(0.0, period, 7)
    print("||u(t)||：", np.array([np.linalg.norm(expm(t) @ u0) for t in ts]))


if __name__ == "__main__":
    main()
```

```text
A.T == -A： True
特征值的虚部： [-1.4142  0.      1.4142]
特征值实部的最大绝对值： 5.4814816543375465e-17
sqrt(2) = 1.4142135623730951
S^H S 是单位矩阵： True
A A^T == A^T A： True
周期 T = pi * sqrt(2) = 4.442882938158366
t = 2.2214：||e^(At) - I|| = 2.83e+00
t = 4.4429：||e^(At) - I|| = 8.45e-15
||u(t)||： [3.7417 3.7417 3.7417 3.7417 3.7417 3.7417 3.7417]
```

这个脚本有三处值得看。特征值的实部最大是 $5.5 \times 10^{-17}$，也就是 0；虚部是 $0, \pm 1.4142$。$e^{AT}$ 在半个周期处离 $I$ 有 2.83，到整个周期 $T = 4.4429$ 处只剩 $8.45 \times 10^{-15}$，所以周期确实是 $\pi\sqrt{2}$。而 $\|\mathbf{u}(t)\|$ 在七个等间隔的时刻都是 3.7417（也就是 $\sqrt{14}$，$\mathbf{u}_0$ 的长度），解一直在一个球面上绕。

他顺带补了一句我觉得值得抄下来的话：特征向量正交的精确条件是 $AA^T = A^TA$。对称矩阵（两边都是 $A^2$）、反对称矩阵（两边都是 $-A^2$）、正交矩阵（两边都是 $I$）都满足，这就是第六章里三个最重要的家族。输出里的 `A A^T == A^T A： True` 是反对称这一项。（用复向量就要用共轭转置，所以脚本里写的是 `S.conj().T`。）

最后他提到 $e^{At}$：矩阵可对角化时它是 $Se^{\Lambda t}S^{-1}$，脚本里的 `expm` 就是这么写的，没有调用任何现成的矩阵指数函数。

## 只知道特征值和特征向量，能说什么

第二道题给了一个 3 × 3 矩阵的三个特征向量（两两正交）和特征值（一个是 0，另一个是 2，还有一个未知的 $c$），然后连续问：对哪些 $c$ 可对角化、对称、正定、是 Markov 矩阵、$A/2$ 是投影矩阵。字幕没有念出黑板上的向量，所以下面的向量是我自己选的一组正交基，不是原题的数字，结论只依赖“正交”这一点。

他的回答顺序是：可对角化只看特征向量够不够，三个正交向量一定无关，所以任何 $c$ 都行；特征向量正交加上特征值为实数就是对称，所以所有实数 $c$；正定不可能，因为有特征值 0，$c \ge 0$ 时是半正定（“安慰奖”）；Markov 不可能，因为特征值不能超过 1，而这里有 2；$A/2$ 是投影矩阵要求特征值只能是 0 或 1，所以 $c = 0$ 或 $c = 2$。

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    # 字幕没有念出板上的向量，我自己选了一组两两正交的特征向量
    S = np.array([[1.0, 1.0, 1.0], [1.0, -1.0, 1.0], [1.0, 0.0, -2.0]])
    Q = S / np.linalg.norm(S, axis=0)
    print("三个特征向量两两正交：", np.allclose(Q.T @ Q, np.eye(3)))

    for c in [-1.0, 0.0, 1.0, 2.0]:
        # 特征值 0、2、c，特征向量是 Q 的三列：A = Q diag(0, 2, c) Q^T
        A = Q @ np.diag([0.0, 2.0, c]) @ Q.T
        lam = np.linalg.eigvalsh(A)
        P = A / 2.0
        print(f"c = {c:4.1f}，特征值 {np.round(lam, 10) + 0.0}")
        print("  对称：", np.allclose(A, A.T))
        print("  半正定：", bool(lam.min() > -1e-12))
        print("  正定：", bool(lam.min() > 1e-12))
        print("  有特征值大于 1（Markov 不允许）：", bool(lam.max() > 1.0))
        print(
            "  A / 2 是投影矩阵：",
            np.allclose(P @ P, P) and np.allclose(P, P.T),
        )


if __name__ == "__main__":
    main()
```

```text
三个特征向量两两正交： True
c = -1.0，特征值 [-1.  0.  2.]
  对称： True
  半正定： False
  正定： False
  有特征值大于 1（Markov 不允许）： True
  A / 2 是投影矩阵： False
c =  0.0，特征值 [0. 0. 2.]
  对称： True
  半正定： True
  正定： False
  有特征值大于 1（Markov 不允许）： True
  A / 2 是投影矩阵： True
c =  1.0，特征值 [0. 1. 2.]
  对称： True
  半正定： True
  正定： False
  有特征值大于 1（Markov 不允许）： True
  A / 2 是投影矩阵： False
c =  2.0，特征值 [0. 2. 2.]
  对称： True
  半正定： True
  正定： False
  有特征值大于 1（Markov 不允许）： True
  A / 2 是投影矩阵： True
```

四个 $c$ 值的结果和他的口头回答一一对应：$c = -1$ 连半正定都不是，$c = 0, 1, 2$ 是半正定但没有一个正定，所有行的“有特征值大于 1”都是 `True`，只有 $c = 0$ 和 $c = 2$ 让 $A/2$ 通过了 $P^2 = P$ 与 $P^T = P$。我只试了四个点，并不能证明“只有这两个”，但 $P^2 = P$ 推出 $\lambda^2 = \lambda$，证明是他那一句话里的。

## SVD：符号是唯一会出错的地方

第三个话题是 SVD。$A = U\Sigma V^T$ 对任何矩阵成立，关键是 $A^TA = V\Sigma^T\Sigma V^T$：中间是对角，两边是同一个正交矩阵，所以 $V$ 是 $A^TA$ 的特征向量矩阵，$\sigma_i^2$ 是它的特征值。同样 $AA^T = U\Sigma\Sigma^T U^T$ 给出 $U$。

然后是他承认的那个错误。上次上课他用 $AA^T$ 的特征向量当 $U$，符号撞上了错的那一半：特征向量乘以 $-1$ 还是特征向量，光凭 $AA^T$ 决定不了符号。正确的做法是定了 $V$ 之后，用 $A\mathbf{v}_i = \sigma_i\mathbf{u}_i$ 反推 $\mathbf{u}_i$，这样符号被 $V$ 绑定。他说自己有 50% 的概率选对，结果没选对。

我用 $A = \begin{bmatrix} 4 & 4 \\ -3 & 3 \end{bmatrix}$ 复现（这是我挑的矩阵，不是黑板上的）。把 $U$ 的两列符号四种组合全试一遍：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    A = np.array([[4.0, 4.0], [-3.0, 3.0]])

    # 第一步：A^T A 的特征向量给出 V，特征值开方给出 sigma
    w, V = np.linalg.eigh(A.T @ A)
    order = np.argsort(w)[::-1]
    w, V = w[order], V[:, order]
    sigma = np.sqrt(w)
    print("sigma =", sigma)

    # 第二步（对的）：由 A v = sigma u 得到 u，符号随 V 定下来
    U_good = (A @ V) / sigma
    print(
        "A v = sigma u 得到的 U 满足 A = U Sigma V^T：",
        np.allclose(U_good @ np.diag(sigma) @ V.T, A),
    )

    # 第二步（Strang 当年出错的做法）：独立求 A A^T 的特征向量，
    # 但每一列的符号是任意的，一共 2 * 2 = 4 种选法
    w2, U_eig = np.linalg.eigh(A @ A.T)
    U_eig = U_eig[:, np.argsort(w2)[::-1]]
    good = 0
    for s1 in [1.0, -1.0]:
        for s2 in [1.0, -1.0]:
            U_try = U_eig * np.array([s1, s2])
            err = np.linalg.norm(U_try @ np.diag(sigma) @ V.T - A)
            good += int(err < 1e-10)
            print(f"符号 ({s1:4.1f}, {s2:4.1f})：误差 {err:.4f}")
    print("4 种符号里能还原 A 的有", good, "种")

    # 和 NumPy 对照
    U, s, Vt = np.linalg.svd(A)
    print("np.linalg.svd 的奇异值：", s)


if __name__ == "__main__":
    main()
```

```text
sigma = [5.6569 4.2426]
A v = sigma u 得到的 U 满足 A = U Sigma V^T： True
符号 ( 1.0,  1.0)：误差 0.0000
符号 ( 1.0, -1.0)：误差 8.4853
符号 (-1.0,  1.0)：误差 11.3137
符号 (-1.0, -1.0)：误差 14.1421
4 种符号里能还原 A 的有 1 种
np.linalg.svd 的奇异值： [5.6569 4.2426]
```

第一行的“对的”做法用 $A\mathbf{v} = \sigma\mathbf{u}$，通过了。独立求 $AA^T$ 的特征向量后，4 种符号只有 $(+, +)$ 这一种能还原 $A$（这次 `eigh` 恰好吐出了对的符号，但没有任何东西保证它会这样），另外三种的误差是 8.4853、11.3137 和 14.1421。表里是 4 选 1，也就是 25%；Strang 当时只有一个符号没定，所以他说 50% 的运气。最后一行用 `np.linalg.svd` 对照，两个奇异值 5.6569 与 4.2426 和手算的 $\sqrt{32}$、$\sqrt{18}$ 一致。

他接着出了几个问 SVD 的“读图”题。$\Sigma = \operatorname{diag}(3, 2)$ 是 2 × 2 的可逆矩阵；把 2 换成 $-5$ 就不是 SVD 了，因为奇异值不能为负；$\Sigma = \operatorname{diag}(3, 0)$ 的话秩为 1，零空间维数为 1，$\mathbf{v}_2$ 在零空间里，$\mathbf{u}_2$ 在 $A^T$ 的零空间里。他说得很直白：SVD 多花一点时间，但把所有基本子空间一次摆了出来。

## 对称又正交的矩阵

最后一道是真假题。$A$ 既对称又正交，问：

- 特征值是什么？实数（对称）且模为 1（正交：$|\lambda|\,\|\mathbf{x}\| = \|Q\mathbf{x}\| = \|\mathbf{x}\|$），所以只能是 $1$ 或 $-1$。
- 一定正定吗？不，可以有 $-1$。
- 没有重复特征值吗？假，只要够大，$\pm 1$ 里总有一个重复。
- 可对角化吗？可以，而且能用正交的 $Q$。
- 非奇异吗？是，正交矩阵都可逆。

最后一步：证明 $\frac12(A + I)$ 是投影矩阵。对称是显然的；平方得 $\frac14(A^2 + 2A + I)$，而 $A$ 对称正交意味着 $A^T = A = A^{-1}$，所以 $A^2 = I$，结果是 $\frac12(A + I)$ 自己。换个角度：特征值是 $\pm 1$，加 $I$ 后是 $0$ 和 $2$，除以 2 就是 $0$ 和 $1$。

“对称又正交”的最典型例子是 Householder 反射 $H = I - 2\mathbf{u}\mathbf{u}^T$。我用它验证上面的每一条，并且顺手验证他开头说的“相似矩阵特征值相同，幂也只差一个 $M^{-1}$ 和 $M$”：

```python
import numpy as np


def main() -> None:
    np.set_printoptions(precision=4, suppress=True)
    rng = np.random.default_rng(1806)

    # Sigma = diag(3, 2) 与 diag(3, 0)：U、V 用随机正交矩阵
    U, _ = np.linalg.qr(rng.standard_normal((2, 2)))
    V, _ = np.linalg.qr(rng.standard_normal((2, 2)))
    for s in [(3.0, 2.0), (3.0, 0.0)]:
        A = U @ np.diag(s) @ V.T
        print(
            f"Sigma = diag{s}：秩 {np.linalg.matrix_rank(A)}，",
            f"det = {np.linalg.det(A):.4f}",
        )
    # 第二个奇异值为 0 时，v2 在零空间里，u2 在 A^T 的零空间里
    print("A v2 =", np.round(A @ V[:, 1], 10) + 0.0)
    print("A^T u2 =", np.round(A.T @ U[:, 1], 10) + 0.0)

    # 对称又正交的矩阵：Householder 反射 A = I - 2 u u^T
    n = 5
    u = rng.standard_normal((n, 1))
    u /= np.linalg.norm(u)
    H = np.eye(n) - 2.0 * u @ u.T
    print(
        "H 对称且正交：", np.allclose(H, H.T), np.allclose(H @ H.T, np.eye(n))
    )
    print("特征值：", np.linalg.eigvalsh(H))
    print("H @ H == I：", np.allclose(H @ H, np.eye(n)))
    P = 0.5 * (H + np.eye(n))
    print(
        "(H + I) / 2 是投影矩阵：",
        np.allclose(P @ P, P) and np.allclose(P, P.T),
    )
    print("P 的特征值：", np.round(np.linalg.eigvalsh(P), 10) + 0.0)
    print("trace(P) =", np.trace(P))

    # 相似矩阵：B = M^{-1} A M 与 A 的特征值相同，B^k = M^{-1} A^k M
    M = rng.standard_normal((n, n))
    B = np.linalg.inv(M) @ H @ M
    print(
        "相似矩阵特征值相同：",
        np.allclose(np.sort(np.linalg.eigvals(B).real), np.linalg.eigvalsh(H)),
    )
    k = 7
    lhs = np.linalg.matrix_power(B, k)
    rhs = np.linalg.inv(M) @ np.linalg.matrix_power(H, k) @ M
    print(f"B^{k} == M^-1 H^{k} M：", np.allclose(lhs, rhs))


if __name__ == "__main__":
    main()
```

```text
Sigma = diag(3.0, 2.0)：秩 2， det = 6.0000
Sigma = diag(3.0, 0.0)：秩 1， det = 0.0000
A v2 = [0. 0.]
A^T u2 = [0. 0.]
H 对称且正交： True True
特征值： [-1.  1.  1.  1.  1.]
H @ H == I： True
(H + I) / 2 是投影矩阵： True
P 的特征值： [0. 1. 1. 1. 1.]
trace(P) = 4.0
相似矩阵特征值相同： True
B^7 == M^-1 H^7 M： True
```

$H$ 的特征值是一个 $-1$ 加四个 $1$（$\mathbf{u}$ 方向被翻转，其余方向不动），$H^2 = I$ 通过了，$\frac12(H + I)$ 的特征值是一个 0 加四个 1，迹为 4，正是投影到 4 维子空间。随机的 5 × 5 矩阵 $M$ 做出来的相似矩阵 $B = M^{-1}HM$ 与 $H$ 的特征值一致，$B^7 = M^{-1}H^7M$ 也成立。再强调一遍他的原话：$M$ 改变特征向量，但不改变特征值。（另外两行关于秩 1 的输出，`A v2` 与 `A^T u2` 都是零向量，是上一节“读图”题的验证。）

下一讲回到一个我觉得更有趣的话题（我对“有趣”的标准很低：只要某个误差能从 0 跳到 14）：矩阵不可逆、方程组无解或有无穷多解的时候，到底该用什么“逆”。Strang 管这个叫[左逆、右逆与伪逆](/posts/linear-algebra-33-pseudoinverse/)，而它恰好是 SVD 的又一个应用。
