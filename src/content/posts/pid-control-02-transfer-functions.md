---
title: "传递函数、极点与根轨迹"
commentId: "post:pid-control-02-transfer-functions"
published: "2026-10-16 09:00:00 +08:00"
description: "PID 控制系列第 2 篇：我用 Python 3.13、gcc 15.3、g++ 15.3 和 rustc 1.95 把多项式求根、阶跃响应指标和两个新对象写了四遍，用拉普拉斯变换推出二阶原型和极点配置公式，再跑 14 组仿真验证：同样的极点配置下 PI 超调 20.29%、I-P 只有 4.70%，Routh 判据给出的临界增益在 1 kHz 采样下少了 20%。"
category: Tutorial
tags:
  - PID
  - 控制理论
  - 传递函数
  - 根轨迹
series: "PID 控制：从一个电机到 LQR"
seriesOrder: 2
draft: false
comment: true
slug: pid-control-02-transfer-functions
---

上一篇留下了两笔债。第一笔：PI 速度环的超调实测 28.02%，二阶公式预测 15.0%，我当时只能说“大概是零点”。第二笔：$K_p$、$K_i$、$K_d$ 全是靠手感试出来的。这一篇还这两笔债，工具是拉普拉斯变换。同一组 $K_p = 1$、$K_i = 10$，把比例项改成只作用在 $-y$ 上之后，超调从 28.29% 降到 15.30%，而二阶公式预测的是 15.02%；反过来把闭环零点算进公式，预测是 27.94%。债还清之后，$K_p$ 和 $K_i$ 就不用试了，给定 $\omega_n$ 和 $\zeta$ 直接算。

> [!NOTE] 本篇检查点
> 这一篇结束时你会有：`make ch02` 通过，`out/ch02/` 下 68 个 CSV（14 组仿真、一份 `metrics`、两条根轨迹，每组 Python、C、C++、Rust 各一份），`figures/ch02/` 下 4 张图；以及拉普拉斯变换、二阶原型、极点配置、Routh 判据、根轨迹的完整推导。
> 新增模块：Python 是 `pidlab/poly.py`（多项式与求根）、`pidlab/metrics.py`（阶跃指标），`pidlab/plants.py` 里多了 `MotorSpeedLag` 和 `DialPosition`；C 是 `pl/poly.h`、`pl/metrics.h` 及对应的 `.c`，`pl/plants.h` 里多了两个对象，`pl/real.h` 多了复数类型 `pl_cplx`；C++ 是 `pidlab/poly.h`、`pidlab/metrics.h`，`pidlab/plants.h` 里多了两个对象；Rust 是 `complex.rs`、`poly.rs`、`metrics.rs`，`plants.rs` 里多了两个对象。
> 前置：[第 1 篇](/posts/pid-control-01-p-i-d/)。需要的数学：复数、一元多项式、一阶和二阶常微分方程，会解一元二次方程。

## 数学

### 拉普拉斯变换：把微分方程变成代数方程

函数 $f(t)$（$t \ge 0$）的拉普拉斯变换定义为

$$
F(s) = \mathcal{L}\{f\}(s) = \int_0^\infty f(t)\,e^{-st}\,dt
$$

$s$ 是复数。我在这里只需要三条性质，每一条都值得自己推一遍。

**微分变成乘以 $s$。** 分部积分：

$$
\mathcal{L}\{\dot f\} = \int_0^\infty \dot f(t)\,e^{-st}\,dt = \Big[f(t)e^{-st}\Big]_0^\infty + s\int_0^\infty f(t)\,e^{-st}\,dt = sF(s) - f(0)
$$

初值为零时，时域里的 $d/dt$ 就是 $s$ 域里的乘以 $s$。这一条的用处是把 $J\dot\omega + b\omega = K_t i$ 这种常微分方程变成 $(Js + b)\,\Omega(s) = K_t I(s)$，求解变成除法。

**两个基本变换。** 单位阶跃 $1(t)$ 的变换是 $\int_0^\infty e^{-st}dt = 1/s$；指数 $e^{-at}$ 的变换是 $1/(s + a)$。有了它们和线性性质，反变换基本靠部分分式，把 $F(s)$ 拆成这两种形式的和。

**终值定理。** 如果 $sF(s)$ 的极点全在左半平面（$f$ 真的收敛），那么 $f(\infty) = \lim_{s \to 0} sF(s)$。推导：对 $\dot f$ 的变换令 $s \to 0$，左边是 $\int_0^\infty \dot f\,dt = f(\infty) - f(0)$，右边是 $\lim sF(s) - f(0)$，两边消掉 $f(0)$。条件不能省：对不稳定的系统这个公式仍然会给你一个漂亮的有限数，只是和真实响应毫无关系。后面的 Routh 判据就是用来先回答“它到底收敛吗”。

用终值定理把第 1 篇的静差重算一遍，当作对工具的检验。纯 P 控制的速度环，开环是 $G(s) = K_t/(Js + b)$，闭环 $T = K_tK_p/(Js + b + K_tK_p)$，阶跃 $R = r/s$，所以

$$
\omega(\infty) = \lim_{s\to 0} s\cdot\frac{K_tK_p}{Js + b + K_tK_p}\cdot\frac{r}{s} = \frac{K_tK_p}{b + K_tK_p}\,r
$$

$e_{ss} = r - \omega(\infty) = b\,r/(b + K_tK_p)$，和第 1 篇令导数为零得到的结果一致（没有负载的情形）。

### 传递函数：每个对象写成一个分式

初值为零时，输出的变换除以输入的变换叫传递函数。这一篇和后面几篇用到的对象是（参数沿用第 1 篇，新增的两个我标明）：

| 对象 | 传递函数 | 参数 |
| --- | --- | --- |
| `MotorSpeed` | $\dfrac{\Omega}{I} = \dfrac{K_t}{Js + b}$ | $K_t = 0.3$，$J = 0.03$，$b = 0.01$ |
| `MotorSpeedLag`（新） | $\dfrac{\Omega}{I_{cmd}} = \dfrac{K_t}{(Js + b)(\tau_c s + 1)}$ | 同上，电流环时间常数 $\tau_c = 0.001$ s（我取的） |
| `GimbalAxis`（$\omega_c = 0$） | $\dfrac{\Psi}{T} = \dfrac{1}{s\,(Js + b + b_f)}$ | $J = 0.02$，$b = 0.002$，$b_f = 0.02$ |
| `DialPosition`（新） | $\dfrac{\Theta}{I_{cmd}} = \dfrac{K_t}{s\,(Js + b)(\tau_c s + 1)}$ | $K_t = 0.3$，$J = 0.005$，$b = 0.01$，$\tau_c = 0.002$ s |

`MotorSpeedLag` 多出来的一阶因子是电流环：电调不会瞬间把电流拉到指令值，我把它建成 $\tau_c\,di/dt = i_{cmd} - i$。`DialPosition` 是拨弹盘上的 M3508，状态是角度、角速度和电流，输出是角度。它的 $J = 0.005$ 和 $\tau_c = 0.002$ s 都是我取的数（量级合理，没有实测），所以下面所有关于它的数字都应该读成“这个形状”，不是“你车上的数”。

PID 控制器是 $C(s) = K_p + K_i/s + K_ds$。把控制器和对象首尾相连，开环 $L(s) = C(s)G(s)$，闭环有两个值得命名的函数：

$$
T(s) = \frac{L}{1 + L},\qquad S(s) = \frac{1}{1 + L},\qquad T + S = 1
$$

$T$ 管设定值到输出，$S$ 管误差。第 1 篇的负载 $\tau_d$ 从对象输入端进来，等价于电流扰动 $\tau_d/K_t$，所以 $Y = T\,R - S\,G\,\tau_d/K_t$。两个函数的分母都是 $1 + L$ 的分子，也就是**特征多项式**，它的根叫闭环极点。系统的所有自由运动都是极点的组合：每个极点 $p$ 贡献一项 $e^{pt}$。（类比一下琴弦：拨的位置和力度只决定每个音的音量，响的永远是弦自己的音高，极点就是系统的音高。）这一篇所有的事归结为一句话：**极点在哪，响应就长什么样；$K_p$、$K_i$、$K_d$ 的作用是把极点搬到我要的地方。**

### 二阶原型：阶跃响应的完整推导

很多闭环最后都化成同一个形状，我把它叫原型：

$$
T_0(s) = \frac{\omega_n^2}{s^2 + 2\zeta\omega_n s + \omega_n^2}
$$

$\omega_n$ 是固有频率，$\zeta$ 是阻尼比。$0 < \zeta < 1$ 时极点是一对共轭复数 $-\sigma \pm j\omega_d$，$\sigma = \zeta\omega_n$，$\omega_d = \omega_n\sqrt{1 - \zeta^2}$。单位阶跃响应的变换是 $Y_0 = T_0/s$，拆成部分分式：

$$
Y_0(s) = \frac{1}{s} - \frac{s + 2\sigma}{(s + \sigma)^2 + \omega_d^2} = \frac{1}{s} - \frac{s + \sigma}{(s + \sigma)^2 + \omega_d^2} - \frac{\sigma}{\omega_d}\cdot\frac{\omega_d}{(s + \sigma)^2 + \omega_d^2}
$$

后两项是 $e^{-\sigma t}\cos\omega_d t$ 和 $e^{-\sigma t}\sin\omega_d t$ 的变换，所以

$$
y_0(t) = 1 - e^{-\sigma t}\left(\cos\omega_d t + \frac{\sigma}{\omega_d}\sin\omega_d t\right)
$$

对 $t$ 求导，$\dot y_0(t) = \dfrac{\omega_n}{\sqrt{1-\zeta^2}}\,e^{-\sigma t}\sin\omega_d t$（这也是原型的脉冲响应）。令它为零，第一个解是 $\omega_d t = \pi$：

$$
t_p = \frac{\pi}{\omega_d},\qquad y_0(t_p) = 1 + e^{-\sigma\pi/\omega_d} \;\Rightarrow\; M_p = e^{-\pi\zeta/\sqrt{1 - \zeta^2}}
$$

这就是第 1 篇一直在用的超调公式。调节时间看包络线：$e^{-\sigma t}/\sqrt{1-\zeta^2}$ 降到 0.02 以下的时间大约是 $4/\sigma$，所以 $t_s \approx 4/(\zeta\omega_n)$（一条经验公式，$\zeta$ 很小或接近 1 时会偏）。$\zeta = 1$ 是临界阻尼，$y_0 = 1 - (1 + \omega_n t)e^{-\omega_n t}$，没有超调；$\zeta > 1$ 是两个实极点，也没有超调，只是更慢。上升时间没有这么干净的闭式，我让仿真去量。

### 极点配置：把 $K_p$、$K_d$ 变成算出来的数

**云台。** 力矩指令的云台，$J\ddot\psi = \tau - (b + b_f)\dot\psi$。我这次不用第 1 篇的误差微分，而是用角速度反馈：$\tau = K_p(r - \psi) - K_d\dot\psi_{meas}$（这样设定值的跳变不会被微分成脉冲，第 5 篇会专门处理这件事）。代入：

$$
J\ddot\psi + (b + b_f + K_d)\dot\psi + K_p\psi = K_p r \;\Rightarrow\; T(s) = \frac{K_p/J}{s^2 + \dfrac{b + b_f + K_d}{J}s + \dfrac{K_p}{J}}
$$

这恰好是原型，没有任何零点。对照 $2\zeta\omega_n = (b + b_f + K_d)/J$ 和 $\omega_n^2 = K_p/J$：

$$
K_p = J\omega_n^2,\qquad K_d = 2\zeta\omega_n J - (b + b_f)
$$

注意括号里是 $b + b_f$：底盘不动时，轴承耦合 $b_f$ 对云台就是一个额外的阻尼。只减 $b$ 的话，得到的 $\zeta$ 会比目标少一点点。$\omega_n = 20$ rad/s、$J = 0.02$ 时 $K_p = 8$，$\zeta = 0.2,\ 0.4,\ 0.7,\ 1$ 对应 $K_d = 0.1380,\ 0.2980,\ 0.5380,\ 0.7780$。

**速度环 PI。** $u = K_p e + K_i\int e\,dt$，对象 $K_t/(Js + b)$。特征多项式是 $s(Js + b) + K_t(K_ps + K_i)$：

$$
Js^2 + (b + K_tK_p)\,s + K_tK_i = J\left(s^2 + 2\zeta\omega_n s + \omega_n^2\right)
$$

$$
K_p = \frac{2\zeta\omega_n J - b}{K_t},\qquad K_i = \frac{\omega_n^2 J}{K_t}
$$

$\zeta = 0.7$、$\omega_n = 10$ rad/s 给出 $K_p = 1.367$、$K_i = 10$；$\omega_n = 30$ rad/s 给出 $K_p = 4.167$、$K_i = 90$。

### 闭环零点：PI 为什么超调

极点对了不代表响应是原型，因为分子还没看。PI 的闭环传递函数是

$$
T_{PI}(s) = \frac{K_t(K_ps + K_i)}{Js^2 + (b + K_tK_p)s + K_tK_i} = \omega_n^2\,\frac{1 + s/z}{s^2 + 2\zeta\omega_n s + \omega_n^2},\qquad z = \frac{K_i}{K_p}
$$

分子 $K_ps + K_i$ 在 $s = -z$ 处为零，这是闭环零点。它的效果很容易算：$T_{PI} = (1 + s/z)\,T_0$，所以 $Y_{PI} = Y_0 + sY_0/z$，而 $sY_0$ 正好是 $\dot y_0$ 的变换（$y_0(0) = 0$），时域里就是

$$
y_{PI}(t) = y_0(t) + \frac{1}{z}\,\dot y_0(t)
$$

原型的 $\dot y_0$ 在到达峰值之前一直是正的，所以零点把一份“速度”加到了位置上，让输出更早、更猛地冲向设定值，超调自然变大。$z$ 越靠近 $\omega_n$ 影响越大。

如果我只想要积分器给的极点、不想要零点，办法是让比例项只作用在测量值上：$u = -K_p y + K_i\int(r - y)\,dt$，我叫它 I-P。这时 $U = -K_pY + K_i(R - Y)/s$，代进对象得 $T_{IP} = K_tK_i/(Js^2 + (b + K_tK_p)s + K_tK_i)$，分子是常数，**正好是原型**，超调只由 $\zeta$ 决定。代价是设定值进来的路径少了 $K_p$ 那一份，响应会慢。第 5 篇会把这个做成一个参数 $b$（设定值权重，$b = 1$ 是 PI，$b = 0$ 是 I-P）。

先把第 1 篇的账算清楚：$K_p = 1$、$K_i = 10$ 时 $\omega_n = 10$、$\zeta = 0.517$、$z = 10$。原型公式给 15.02%，带上这个零点是 27.94%，第 1 篇实测 28.02%。三个数对得上，**那 13 个百分点就是零点。**

### Routh–Hurwitz：三阶系统稳定的条件

拨弹盘用 P 控制 $u = K e$，$e = r - \theta$，特征多项式是 $s(Js + b)(\tau_cs + 1) + KK_t$：

$$
J\tau_c\,s^3 + (J + b\tau_c)\,s^2 + b\,s + KK_t = 0
$$

一般的三阶 $a_3s^3 + a_2s^2 + a_1s + a_0$（系数全正），它在稳定与不稳定之间的边界上有一对极点正好落在虚轴上。令 $s = j\omega$：

$$
(a_0 - a_2\omega^2) + j\,(a_1\omega - a_3\omega^3) = 0 \;\Rightarrow\; \omega^2 = \frac{a_1}{a_3},\quad a_0 = a_2\omega^2 = \frac{a_2a_1}{a_3}
$$

所以边界是 $a_2a_1 = a_3a_0$，稳定条件是 $a_2a_1 > a_3a_0$。这就是 Routh 阵列第一列第三项 $(a_2a_1 - a_3a_0)/a_2$ 为正的条件（阵列的前两行是 $a_3, a_1$ 和 $a_2, a_0$，第三行 $(a_2a_1 - a_3a_0)/a_2$，第四行 $a_0$，第一列不变号就稳定）。代入拨弹盘：

$$
K_{crit} = \frac{(J + b\tau_c)\,b}{J\tau_c K_t},\qquad \omega_c = \sqrt{\frac{b}{J\tau_c}}
$$

数值是 $K_{crit} = 16.7333$ A/rad，穿越频率 $\omega_c = 31.623$ rad/s。K 超过它，一对极点跑到右半平面，响应是一个越来越大的振荡。

但这个结论有一个前提：连续时间。我的控制器是 1 kHz 的采样系统，输出要保持一个周期。第 1 篇说过零阶保持平均相当于 $t_s/2$ 的延迟，这个延迟对稳定边界的影响，我这次用精确的离散模型算出来，不用近似。拨弹盘的状态方程 $\dot x = Ax + Bu$，保持 $u$ 一个周期后 $x_{k+1} = A_dx_k + B_du_k$，其中

$$
\begin{bmatrix} A_d & B_d \\ 0 & 1 \end{bmatrix} = \exp\left(\begin{bmatrix} A & B \\ 0 & 0 \end{bmatrix} t_s\right)
$$

$u_k = K(r - \theta_k)$ 时，$A_d - B_dK\,[1\ 0\ 0]$ 的特征值模长是 1 的地方就是真正的边界，等效的增长率是 $\ln|\lambda|_{max}/t_s$。这一步我用 `scipy.linalg.expm`（第 9 篇会手写）和 `numpy` 求特征值，不用手写的参考，因为它只是用来解释仿真，不是四种语言要对齐的东西。

### 根轨迹：极点作为 $K$ 的函数

画根轨迹的传统是用一套规则手画。我不画，我直接算：对 400 个对数间隔的 $K$（0.01 到 1000），每个求一次特征多项式的根。定义很简单：控制器是 $K$ 乘一个固定的 $N_c(s)$ 时，特征多项式是 $D(s) + K\,N(s)$（$D$ 是对象分母，$N$ 是对象分子乘 $N_c$ 的分子），根随 $K$ 连续移动，画出来就是根轨迹。$K \to 0$ 时根趋向 $D$ 的根（开环极点），$K \to \infty$ 时趋向 $N$ 的根（开环零点）或无穷远。

两条要算的轨迹，都是拨弹盘：

- **P：** $D + KK_t$，开环极点在 $0$、$-b/J = -2$ 和 $-1/\tau_c = -500$。
- **PD：** 控制器 $K(1 + s/20)$，多了一个零点 $-20$，特征多项式是 $J\tau_cs^3 + (J + b\tau_c)s^2 + (b + KK_t/20)s + KK_t$。

PD 的 Routh 条件可以直接写出来：$(J + b\tau_c)(b + KK_t/20) > J\tau_c KK_t$，整理成

$$
(J + b\tau_c)\,b + KK_t\left[\frac{J + b\tau_c}{20} - J\tau_c\right] > 0
$$

方括号里是 $0.00502/20 - 0.00001 = 2.41\times 10^{-4} > 0$，所以对任何 $K > 0$ 都成立：**这个 PD 对任何增益都稳定。** 一个零点就把边界拆掉了，这是后面反复出现的主题：D 项给相位超前，系统才敢用高增益。

### 数值求根：Durand–Kerner

三阶多项式有求根公式，但我不想写它：公式在有重根时数值很差，也不好推广到后面的四阶和五阶。我用 Durand–Kerner 迭代：把多项式化成首一，同时维护 $n$ 个根的猜测 $z_1, \dots, z_n$，每个按

$$
z_i \leftarrow z_i - \frac{p(z_i)}{\prod_{j \ne i}(z_i - z_j)}
$$

更新（用最新的 $z_j$，也就是原地更新）。初值是 $R\,(0.4 + 0.9j)^k$，$k = 0, \dots, n-1$，$R = 1 + \max|c_i|$ 是 Cauchy 界（所有根的模长都小于它）；这些点落在一条螺线上，互不相同，不会出现分母为零。收敛判据是所有更新量都小于 $10^{-14}(1 + |z|)$，最多 1000 轮。

之后做 3 步 Newton 抛光。重根附近 $p'$ 接近零，Newton 一步可能飞出去，所以我加了保护：只在 $|p|$ 变小时才接受这一步。最后做两件事保证四种语言的输出可以逐列对比：虚部小于 $10^{-9}\max(1, |z|)$ 的根强制成实数；然后按实部从小到大排序，实部相差小于 $10^{-9}(1 + \max|\mathrm{Re}|)$ 的当作并列，并列的按虚部从小到大。共轭对因此永远是“负虚部在前”。

我原先担心重根附近 Durand–Kerner 的精度只有 $\sqrt\epsilon \approx 10^{-8}$ 量级，四种语言在根轨迹的分叉点附近会差出一点，所以给这两个文件预留了 $10^{-6}$ 的容差。结果下面会看到：我没用上。

### 阶跃响应指标

仿真的响应是一串采样值，不是公式，所以指标要有离散的定义。阶跃在第 $k_0$ 个采样点施加，起始值取 $y[k_0]$，目标值 $r$，归一化 $z_i = (y_i - y[k_0])/(r - y[k_0])$，时间从 $k_0$ 起算：

- **上升时间：** $z$ 第一次达到 0.1 和 0.9 的时刻（相邻两个采样点之间线性插值）之差。
- **超调：** $\max(0, \max z - 1)\times 100\%$。
- **峰值时间：** 第一个满足 $z \ge \max z - 10^{-9}$ 的采样点。直接取 argmax 的话，没有超调的响应在末尾会因为最后一位舍入而挑出不同的“峰”，四种语言可能挑得不一样；加一个 $10^{-9}$ 的容差，有超调的响应不受影响（峰顶是平的，差 $10^{-9}$ 对应不到一个采样点），单调的响应也有了确定的答案。
- **2% 调节时间：** 最后一次 $|z - 1| > 0.02$ 的采样点之后的第一个时刻。
- **IAE：** $\sum|r - y_i|\,t_s$，矩形积分。

## Python 实现

### 多项式与求根

多项式就是系数列表，最高次在前，和 `numpy.roots` 同一个约定。完整文件：

```python
"""Polynomials as coefficient lists, highest degree first, and roots.

Roots come from Durand-Kerner with a few Newton polish steps, so the C,
C++ and Rust versions can repeat the exact same algorithm.
"""

from collections.abc import Sequence

MAX_ITER = 1000
DK_TOL = 1e-14
NEWTON_STEPS = 3
REAL_TOL = 1e-9


def poly_mul(a: Sequence[float], b: Sequence[float]) -> list[float]:
    """Product of two polynomials."""
    out = [0.0] * (len(a) + len(b) - 1)
    for i, ai in enumerate(a):
        for j, bj in enumerate(b):
            out[i + j] += ai * bj
    return out


def poly_add(a: Sequence[float], b: Sequence[float]) -> list[float]:
    """Sum of two polynomials; the constant terms line up."""
    n = max(len(a), len(b))
    out = [0.0] * n
    for i, ai in enumerate(a):
        out[n - len(a) + i] += ai
    for i, bi in enumerate(b):
        out[n - len(b) + i] += bi
    return out


def poly_scale(a: Sequence[float], s: float) -> list[float]:
    """Multiply every coefficient by s."""
    return [s * ai for ai in a]


def poly_eval(a: Sequence[float], z: complex) -> complex:
    """Horner evaluation at a complex point."""
    acc = complex(0.0, 0.0)
    for ai in a:
        acc = acc * z + ai
    return acc


def _deriv(a: Sequence[float]) -> list[float]:
    n = len(a) - 1
    return [a[i] * (n - i) for i in range(n)]


def _newton(a: Sequence[float], da: Sequence[float], z: complex) -> complex:
    """One safeguarded Newton step: keep it only if |p| shrinks."""
    p = poly_eval(a, z)
    dp = poly_eval(da, z)
    if dp == 0:
        return z
    z_new = z - p / dp
    return z_new if abs(poly_eval(a, z_new)) < abs(p) else z


def _after(a: complex, b: complex, tie: float) -> bool:
    """True when a must come after b."""
    if abs(a.real - b.real) <= tie:
        return a.imag > b.imag
    return a.real > b.real


def canonical_sort(z: Sequence[complex]) -> list[complex]:
    """Order by real part, near ties by imaginary part (insertion sort)."""
    tie = REAL_TOL * (1.0 + max((abs(w.real) for w in z), default=0.0))
    out = list(z)
    for i in range(1, len(out)):
        cur = out[i]
        j = i - 1
        while j >= 0 and _after(out[j], cur, tie):
            out[j + 1] = out[j]
            j -= 1
        out[j + 1] = cur
    return out


def poly_roots(a: Sequence[float]) -> list[complex]:
    """Roots of a[0] x^n + ... + a[n], canonically ordered.

    Raises ValueError for a zero leading coefficient or degree < 1.
    """
    n = len(a) - 1
    if n < 1 or a[0] == 0.0:
        raise ValueError("need degree >= 1 and a nonzero leading term")
    c = [ai / a[0] for ai in a]
    radius = 1.0 + max(abs(ci) for ci in c[1:])
    seed = complex(0.4, 0.9)
    z = [radius * seed**k for k in range(n)]
    for _ in range(MAX_ITER):
        done = True
        for i in range(n):
            den = complex(1.0, 0.0)
            for j in range(n):
                if j != i:
                    den *= z[i] - z[j]
            if den == 0:
                continue
            step = poly_eval(c, z[i]) / den
            z[i] -= step
            if abs(step) > DK_TOL * (1.0 + abs(z[i])):
                done = False
        if done:
            break
    dc = _deriv(c)
    for i in range(n):
        for _ in range(NEWTON_STEPS):
            z[i] = _newton(c, dc, z[i])
        if abs(z[i].imag) < REAL_TOL * max(1.0, abs(z[i])):
            z[i] = complex(z[i].real, 0.0)
    return canonical_sort(z)
```

`poly_add` 把常数项对齐，所以 `[...三阶, 0] + [K*Kt]` 这样的写法能直接用。Python 的 `complex` 内置，`seed**k` 就是螺线上的第 $k$ 个点。`_newton` 里那个 `abs(poly_eval(a, z_new)) < abs(p)` 就是上面说的保护。

### 阶跃指标

```python
"""Step-response metrics from sampled data."""

import math
from collections.abc import Sequence
from dataclasses import dataclass

PEAK_TOL = 1e-9  # a sample within this of the maximum counts as the peak
BAND = 0.02  # settling band


@dataclass
class StepMetrics:
    """All times in seconds, overshoot in percent, iae in unit*s."""

    rise: float  # 10 % to 90 %
    overshoot: float
    peak: float
    settle: float  # 2 % band
    iae: float


def step_metrics(
    y: Sequence[float], ts: float, k0: int, r: float
) -> StepMetrics:
    """Metrics of a step applied at sample k0, from y[k0:].

    The start value is y[k0]; r is the final target. Times count from k0.
    Raises ValueError if k0 is out of range or the step has zero size.
    """
    n = len(y)
    if not 0 <= k0 < n or r == y[k0]:
        raise ValueError("no step at k0")
    y0 = y[k0]
    amp = r - y0
    z = [(y[i] - y0) / amp for i in range(k0, n)]
    t10 = _cross(z, 0.1, ts)
    t90 = _cross(z, 0.9, ts)
    zmax = max(z)
    k_peak = next(i for i, zi in enumerate(z) if zi >= zmax - PEAK_TOL)
    last_out = -1
    for i, zi in enumerate(z):
        if abs(zi - 1.0) > BAND:
            last_out = i
    iae = 0.0
    for yi in y[k0:]:
        iae += abs(r - yi) * ts
    return StepMetrics(
        rise=t90 - t10,
        overshoot=max(0.0, zmax - 1.0) * 100.0,
        peak=k_peak * ts,
        settle=(last_out + 1) * ts,
        iae=iae,
    )


def _cross(z: Sequence[float], level: float, ts: float) -> float:
    """First time z reaches level, linearly interpolated; NaN if never."""
    for i in range(1, len(z)):
        if z[i] >= level:
            frac = (level - z[i - 1]) / (z[i] - z[i - 1])
            return (i - 1 + frac) * ts
    return math.nan
```

`step_metrics` 直接把上面五条定义翻成代码。`_cross` 返回 NaN 而不是抛异常，是为了让“没有穿过 0.9”这种情形也能写进 CSV，四种语言的 NaN 在对比时算相等。

### 两个新对象

```python
@dataclass
class MotorSpeedLag:
    """MotorSpeed with a first-order current loop: tau_c di/dt = i_cmd - i.

    State x = [w, i]; input u = [i_cmd, tau_d]; output w.
    """

    kt: float = 0.3
    j: float = 0.03
    b: float = 0.01
    tau_c: float = 0.001
    u_max: float = 20.0

    n = 2
    m = 2

    def deriv(self, x, u):
        return [
            (self.kt * x[1] - self.b * x[0] - u[1]) / self.j,
            (u[0] - x[1]) / self.tau_c,
        ]

    def output(self, x):
        return x[0]


@dataclass
class DialPosition:
    """M3508 on the 拨弹盘: angle, speed and current lag.

    J w' = Kt i - b w - tau_d, tau_c i' = i_cmd - i.
    State x = [theta, w, i]; input u = [i_cmd, tau_d]; output theta.
    """

    kt: float = 0.3
    j: float = 0.005
    b: float = 0.01
    tau_c: float = 0.002
    u_max: float = 20.0

    n = 3
    m = 2

    def deriv(self, x, u):
        return [
            x[1],
            (self.kt * x[2] - self.b * x[1] - u[1]) / self.j,
            (u[0] - x[2]) / self.tau_c,
        ]

    def output(self, x):
        return x[0]
```

接口和第 1 篇的对象完全一样：`deriv(x, u)`、`output(x)`，输入是 `[指令, 负载]`。`MotorSpeedLag` 和 `MotorSpeed` 是两个类而不是一个带开关的类：状态维数在 C、C++、Rust 里是编译期常数，一个对象不能有时是 1 维有时是 2 维。

### 驱动：实验表、设计公式和回路

驱动 `python/ch02_transfer_functions.py` 还是 `ref` 和 `report` 两个子命令。每个实验是一个 `Case`，`kind` 说明这是哪种控制器，`p1`、`p2` 的含义随 `kind` 变：

```python
PD, PI_PLACE, PI_GAINS, ROUTH = range(4)


class Case(NamedTuple):
    """One closed-loop run; p1 and p2 depend on the kind.

    PD: zeta, wn. PI_PLACE: zeta, wn. PI_GAINS: kp, ki.
    ROUTH: multiple of the critical gain (p2 unused).
    bw weights the setpoint in the proportional term, tau_c is the
    current lag of the speed plant, r is the step size.
    """

    kind: int
    p1: float
    p2: float
    bw: float
    tau_c: float
    r: float


CASES = {
    "pd_z0.2": Case(PD, 0.2, PD_WN, 1.0, 0.0, 0.05),
    "pd_z0.4": Case(PD, 0.4, PD_WN, 1.0, 0.0, 0.05),
    "pd_z0.7": Case(PD, 0.7, PD_WN, 1.0, 0.0, 0.05),
    "pd_z1": Case(PD, 1.0, PD_WN, 1.0, 0.0, 0.05),
    "pi_place_w10": Case(PI_PLACE, 0.7, 10.0, 1.0, 0.0, 5.0),
    "pi_place_w10_ip": Case(PI_PLACE, 0.7, 10.0, 0.0, 0.0, 5.0),
    "pi_place_w30": Case(PI_PLACE, 0.7, 30.0, 1.0, 0.0, 5.0),
    "pi_place_w30_ip": Case(PI_PLACE, 0.7, 30.0, 0.0, 0.0, 5.0),
    "pi_place_w30_lag": Case(PI_PLACE, 0.7, 30.0, 1.0, 0.001, 5.0),
    "pi_ch01": Case(PI_GAINS, 1.0, 10.0, 1.0, 0.0, 10.0),
    "pi_ch01_ip": Case(PI_GAINS, 1.0, 10.0, 0.0, 0.0, 10.0),
    "routh_0.7": Case(ROUTH, 0.7, 0.0, 1.0, 0.0, 0.05),
    "routh_0.9": Case(ROUTH, 0.9, 0.0, 1.0, 0.0, 0.05),
    "routh_1.1": Case(ROUTH, 1.1, 0.0, 1.0, 0.0, 0.05),
}
STEP_CASES = [n for n, c in CASES.items() if c.kind != ROUTH]
COLUMNS = ("t", "r", "y", "u")
METRIC_COLUMNS = ("id", "zeta", "rise", "overshoot", "tpeak", "tsettle", "iae")
```

下面是极点配置公式、Routh 临界增益和仿真回路。`design` 就是上一节推出的公式，`run_case` 的循环顺序和第 1 篇完全一样（测量、控制、限幅、延迟线、保持、记录）：

```python
def design(c: Case):
    """Plant and the two controller numbers (k1, k2) of a case."""
    if c.kind == PD:
        g = GimbalAxis()
        kp = g.j * c.p2 * c.p2
        kd = 2.0 * c.p1 * c.p2 * g.j - (g.b + g.bf)
        return g, kp, kd
    if c.kind == ROUTH:
        d = DialPosition()
        return d, c.p1 * critical_gain(d), 0.0
    m = MotorSpeedLag(tau_c=c.tau_c) if c.tau_c > 0.0 else MotorSpeed()
    if c.kind == PI_PLACE:
        kp = (2.0 * c.p1 * c.p2 * m.j - m.b) / m.kt
        ki = c.p2 * c.p2 * m.j / m.kt
        return m, kp, ki
    return m, c.p1, c.p2


def critical_gain(d: DialPosition) -> float:
    """Routh limit of P control on the dial: (J + b tc) b / (J tc Kt)."""
    return (d.j + d.b * d.tau_c) * d.b / (d.j * d.tau_c * d.kt)


def run_case(name: str) -> dict[str, np.ndarray]:
    """Simulate one case following the loop order of the series."""
    c = CASES[name]
    plant, k1, k2 = design(c)
    delay = DelayLine(0)
    data = read_csv(DATA / f"ch02_{name}.csv")
    x = [0.0] * plant.n
    integ = 0.0
    rows = []
    for k in range(STEPS):
        r, load = data["r"][k], data["d"][k]
        y = plant.output(x) + data["n"][k]
        e = r - y
        if c.kind == PD:
            u = k1 * e - k2 * x[1]  # rate feedback from the gyro
        elif c.kind == ROUTH:
            u = k1 * e
        else:
            u = k1 * (c.bw * r - y) + integ
        u = min(max(u, -plant.u_max), plant.u_max)
        rows.append([data["t"][k], r, y, u])
        if c.kind in (PI_PLACE, PI_GAINS):
            integ += k2 * TS * e
        u_in = delay.push(u)
        inputs = [u_in, load, 0.0] if c.kind == PD else [u_in, load]
        x = advance(plant.deriv, x, inputs, TS, SUBSTEPS)
    return dict(zip(COLUMNS, np.array(rows).T))
```

`PD` 用 `x[1]` 当“陀螺仪读数”，做角速度反馈；`PI` 分支里的 `c.bw * r - y` 就是 I-P 和 PI 的唯一区别（`bw = 0` 是 I-P）；积分在算完 `u` 之后才更新，这个顺序我会在结果里用到。根轨迹这边：

```python
def locus_poly(pd_zero: bool, k: float) -> list[float]:
    """Characteristic polynomial of the dial loop at gain k."""
    d = DialPosition()
    plant = poly_mul(poly_mul([1.0, 0.0], [d.j, d.b]), [d.tau_c, 1.0])
    ctrl = [1.0 / PD_ZONE, 1.0] if pd_zero else [1.0]
    return poly_add(plant, poly_scale(ctrl, k * d.kt))


def locus(pd_zero: bool) -> dict[str, np.ndarray]:
    ks = read_csv(DATA / "ch02_rlocus.csv")["k"]
    cols = {"k": ks}
    rows = [poly_roots(locus_poly(pd_zero, k)) for k in ks]
    for i in range(3):
        cols[f"re{i}"] = np.array([r[i].real for r in rows])
        cols[f"im{i}"] = np.array([r[i].imag for r in rows])
    return cols
```

特征多项式就是用 `poly_mul`、`poly_add`、`poly_scale` 拼出来的，和上面的数学一一对应。`report` 里的对比、指标表、断言和画图全文见 [`python/ch02_transfer_functions.py`](https://github.com/bfmhno3/pid-lab/tree/tutorial-v1/python/ch02_transfer_functions.py)。

## C、C++、Rust 实现

三个版本都是同一份结构：`poly`、`metrics`、两个新对象，加一个驱动。区别主要在这几处：

- **复数。** C 用 C99 的 `_Complex`，但 `pl_real complex` 这种写法不合法（`pl_real` 是 typedef，不能再和 `complex` 组合），所以 `real.h` 里和 `pl_real` 一起多了一个 `pl_cplx`，同样由 `-DPL_USE_FLOAT` 切换，还有配套的 `PL_CABS`、`PL_CREAL`、`PL_CIMAG`。C++ 用 `std::complex<T>`。Rust 的 `no_std` 里没有复数，我写了一个 84 行的 `complex.rs`，只实现 `+ - * /`、模长和乘实数。
- **多项式的存放。** C 用 `PL_MAX_POLY = 8` 的固定数组，调用者传长度；C++ 用 `std::array<T, N>`，`PolyMul` 的返回类型 `std::array<T, A + B - 1>` 让长度进入类型，不会越界；Rust 用切片加调用者给的输出缓冲区（稳定版 Rust 还不能写 `[T; N + M - 1]`）。三者都不分配内存。
- **出错。** 首项为零之类的错：C 返回 `-EINVAL`，C++ 返回 `std::optional`，Rust 返回 `Result`。
- **求模。** C 的 `cabs` 和 Python 的 `abs` 都是 `hypot`；Rust 里我也调 `libm::hypot`，没有写 $\sqrt{x^2 + y^2}$，免得和另外两个差一个舍入。

### C

求根函数是 Python 版的逐行翻译。`pl_cplx` 的乘除由编译器处理，我没有手写：

```c
int pl_poly_roots(const pl_real *a, int n, pl_cplx *roots)
{
	pl_real c[PL_MAX_POLY], dc[PL_MAX_POLY];
	pl_cplx seed = 0.4 + 0.9 * I;
	pl_cplx pw = 1.0;
	pl_real radius = 0.0;
	int deg = n - 1;
	int i, j, it, s;

	if (n < 2 || n > PL_MAX_POLY || a[0] == 0.0)
		return -EINVAL;
	for (i = 0; i < n; i++)
		c[i] = a[i] / a[0];
	for (i = 1; i < n; i++)
		if (PL_FABS(c[i]) > radius)
			radius = PL_FABS(c[i]);
	radius += 1.0;
	for (i = 0; i < deg; i++) {
		roots[i] = radius * pw;
		pw *= seed;
	}

	for (it = 0; it < MAX_ITER; it++) {
		bool done = true;

		for (i = 0; i < deg; i++) {
			pl_cplx den = 1.0;
			pl_cplx step;

			for (j = 0; j < deg; j++)
				if (j != i)
					den *= roots[i] - roots[j];
			if (den == 0.0)
				continue;
			step = pl_poly_eval(c, n, roots[i]) / den;
			roots[i] -= step;
			if (PL_CABS(step) > DK_TOL * (1.0 + PL_CABS(roots[i])))
				done = false;
		}
		if (done)
			break;
	}

	for (i = 0; i < deg; i++)
		dc[i] = c[i] * (deg - i);
	for (i = 0; i < deg; i++) {
		for (s = 0; s < NEWTON_STEPS; s++)
			roots[i] = newton(c, n, dc, roots[i]);
		if (PL_FABS(PL_CIMAG(roots[i])) <
		    REAL_TOL * (PL_CABS(roots[i]) > 1.0 ?
				PL_CABS(roots[i]) : 1.0))
			roots[i] = PL_CREAL(roots[i]);
	}
	canonical_sort(roots, deg);
	return 0;
}
```

C 里只有这一个地方用到复数，别处都是 `pl_real`。`PL_FABS(PL_CREAL(...))` 看着啰嗦，但它是 float 构建（`-DPL_USE_FLOAT`）下 `fabsf`、`crealf` 都匹配的最简单写法，我编译过 float 版确认没有警告（第 10 篇才会真的跑它）。

<details>
<summary>完整源码：c/include/pl/poly.h、c/src/poly.c、c/include/pl/metrics.h、c/src/metrics.c</summary>

```c
/* SPDX-License-Identifier: MIT OR Apache-2.0 */
/* Polynomials: coefficients highest degree first, fixed capacity. */
#ifndef PL_POLY_H
#define PL_POLY_H

#include "pl/real.h"

#define PL_MAX_POLY 8 /* coefficients, so degree <= 7 */

/* out = a * b, returns its length or -EINVAL if it exceeds PL_MAX_POLY. */
int pl_poly_mul(const pl_real *a, int na, const pl_real *b, int nb,
		pl_real *out);

/* out = a + b with the constant terms aligned, returns the longer length. */
int pl_poly_add(const pl_real *a, int na, const pl_real *b, int nb,
		pl_real *out);

/* a *= s */
void pl_poly_scale(pl_real *a, int n, pl_real s);

/* Horner evaluation at a complex point. */
pl_cplx pl_poly_eval(const pl_real *a, int n, pl_cplx z);

/* Roots of a[0] x^(n-1) + ... + a[n-1], written to roots[0..n-2] in the */
/* canonical order: real part ascending, near ties by imaginary part. */
/* Durand-Kerner plus three safeguarded Newton steps. */
/* Returns 0, or -EINVAL for a zero leading term, n < 2 or n > PL_MAX_POLY. */
int pl_poly_roots(const pl_real *a, int n, pl_cplx *roots);

#endif /* PL_POLY_H */
```

```c
// SPDX-License-Identifier: MIT OR Apache-2.0
#include "pl/poly.h"

#include <errno.h>
#include <stdbool.h>

#define MAX_ITER 1000
#define DK_TOL 1e-14
#define NEWTON_STEPS 3
#define REAL_TOL 1e-9

int pl_poly_mul(const pl_real *a, int na, const pl_real *b, int nb,
		pl_real *out)
{
	int n = na + nb - 1;
	int i, j;

	if (na < 1 || nb < 1 || n > PL_MAX_POLY)
		return -EINVAL;
	for (i = 0; i < n; i++)
		out[i] = 0.0;
	for (i = 0; i < na; i++)
		for (j = 0; j < nb; j++)
			out[i + j] += a[i] * b[j];
	return n;
}

int pl_poly_add(const pl_real *a, int na, const pl_real *b, int nb,
		pl_real *out)
{
	int n = na > nb ? na : nb;
	int i;

	if (n > PL_MAX_POLY)
		return -EINVAL;
	for (i = 0; i < n; i++)
		out[i] = 0.0;
	for (i = 0; i < na; i++)
		out[n - na + i] += a[i];
	for (i = 0; i < nb; i++)
		out[n - nb + i] += b[i];
	return n;
}

void pl_poly_scale(pl_real *a, int n, pl_real s)
{
	int i;

	for (i = 0; i < n; i++)
		a[i] = s * a[i];
}

pl_cplx pl_poly_eval(const pl_real *a, int n, pl_cplx z)
{
	pl_cplx acc = 0.0;
	int i;

	for (i = 0; i < n; i++)
		acc = acc * z + a[i];
	return acc;
}

/* Keep the Newton step only if |p| shrinks. */
static pl_cplx newton(const pl_real *a, int n, const pl_real *da,
			      pl_cplx z)
{
	pl_cplx p = pl_poly_eval(a, n, z);
	pl_cplx dp = pl_poly_eval(da, n - 1, z);
	pl_cplx z_new;

	if (dp == 0.0)
		return z;
	z_new = z - p / dp;
	return PL_CABS(pl_poly_eval(a, n, z_new)) < PL_CABS(p) ? z_new : z;
}

/* True when a must come after b. */
static bool after(pl_cplx a, pl_cplx b, pl_real tie)
{
	if (PL_FABS(PL_CREAL(a) - PL_CREAL(b)) <= tie)
		return PL_CIMAG(a) > PL_CIMAG(b);
	return PL_CREAL(a) > PL_CREAL(b);
}

static void canonical_sort(pl_cplx *z, int n)
{
	pl_real max_re = 0.0;
	pl_real tie;
	int i, j;

	for (i = 0; i < n; i++)
		if (PL_FABS(PL_CREAL(z[i])) > max_re)
			max_re = PL_FABS(PL_CREAL(z[i]));
	tie = REAL_TOL * (1.0 + max_re);
	for (i = 1; i < n; i++) {
		pl_cplx cur = z[i];

		for (j = i - 1; j >= 0 && after(z[j], cur, tie); j--)
			z[j + 1] = z[j];
		z[j + 1] = cur;
	}
}

int pl_poly_roots(const pl_real *a, int n, pl_cplx *roots)
{
	pl_real c[PL_MAX_POLY], dc[PL_MAX_POLY];
	pl_cplx seed = 0.4 + 0.9 * I;
	pl_cplx pw = 1.0;
	pl_real radius = 0.0;
	int deg = n - 1;
	int i, j, it, s;

	if (n < 2 || n > PL_MAX_POLY || a[0] == 0.0)
		return -EINVAL;
	for (i = 0; i < n; i++)
		c[i] = a[i] / a[0];
	for (i = 1; i < n; i++)
		if (PL_FABS(c[i]) > radius)
			radius = PL_FABS(c[i]);
	radius += 1.0;
	for (i = 0; i < deg; i++) {
		roots[i] = radius * pw;
		pw *= seed;
	}

	for (it = 0; it < MAX_ITER; it++) {
		bool done = true;

		for (i = 0; i < deg; i++) {
			pl_cplx den = 1.0;
			pl_cplx step;

			for (j = 0; j < deg; j++)
				if (j != i)
					den *= roots[i] - roots[j];
			if (den == 0.0)
				continue;
			step = pl_poly_eval(c, n, roots[i]) / den;
			roots[i] -= step;
			if (PL_CABS(step) > DK_TOL * (1.0 + PL_CABS(roots[i])))
				done = false;
		}
		if (done)
			break;
	}

	for (i = 0; i < deg; i++)
		dc[i] = c[i] * (deg - i);
	for (i = 0; i < deg; i++) {
		for (s = 0; s < NEWTON_STEPS; s++)
			roots[i] = newton(c, n, dc, roots[i]);
		if (PL_FABS(PL_CIMAG(roots[i])) <
		    REAL_TOL * (PL_CABS(roots[i]) > 1.0 ?
				PL_CABS(roots[i]) : 1.0))
			roots[i] = PL_CREAL(roots[i]);
	}
	canonical_sort(roots, deg);
	return 0;
}
```

```c
/* SPDX-License-Identifier: MIT OR Apache-2.0 */
/* Step-response metrics from sampled data. */
#ifndef PL_METRICS_H
#define PL_METRICS_H

#include "pl/real.h"

struct pl_step_metrics {
	pl_real rise; /* 10 % to 90 %, s */
	pl_real overshoot; /* percent */
	pl_real peak; /* s */
	pl_real settle; /* 2 % band, s */
	pl_real iae; /* unit * s */
};

/* Metrics of a step applied at sample k0, from y[k0..n-1]. The start */
/* value is y[k0], r is the final target, times count from k0. */
/* Returns 0, or -EINVAL if k0 is out of range or the step has zero size. */
int pl_step_metrics(const pl_real *y, long n, pl_real ts, long k0, pl_real r,
		    struct pl_step_metrics *out);

#endif /* PL_METRICS_H */
```

```c
// SPDX-License-Identifier: MIT OR Apache-2.0
#include "pl/metrics.h"

#include <errno.h>

#define PEAK_TOL 1e-9
#define BAND 0.02

/* First time the normalized response reaches level, interpolated. */
static pl_real cross(const pl_real *y, long n, long k0, pl_real y0,
		     pl_real amp, pl_real level, pl_real ts)
{
	long i;

	for (i = 1; i < n - k0; i++) {
		pl_real zi = (y[k0 + i] - y0) / amp;
		pl_real zp, frac;

		if (zi >= level) {
			zp = (y[k0 + i - 1] - y0) / amp;
			frac = (level - zp) / (zi - zp);
			return (i - 1 + frac) * ts;
		}
	}
	return NAN;
}

int pl_step_metrics(const pl_real *y, long n, pl_real ts, long k0, pl_real r,
		    struct pl_step_metrics *out)
{
	pl_real y0, amp, zmax, iae = 0.0;
	long i, k_peak = 0, last_out = -1;

	if (k0 < 0 || k0 >= n || r == y[k0])
		return -EINVAL;
	y0 = y[k0];
	amp = r - y0;
	zmax = (y[k0] - y0) / amp;
	for (i = 0; i < n - k0; i++) {
		pl_real zi = (y[k0 + i] - y0) / amp;

		if (zi > zmax)
			zmax = zi;
		if (PL_FABS(zi - 1) > BAND)
			last_out = i;
		iae += PL_FABS(r - y[k0 + i]) * ts;
	}
	for (i = 0; i < n - k0; i++) {
		if ((y[k0 + i] - y0) / amp >= zmax - PEAK_TOL) {
			k_peak = i;
			break;
		}
	}
	out->rise = cross(y, n, k0, y0, amp, 0.9, ts) -
		    cross(y, n, k0, y0, amp, 0.1, ts);
	out->overshoot = (zmax - 1.0 > 0.0 ? zmax - 1.0 : 0.0) * 100.0;
	out->peak = k_peak * ts;
	out->settle = (last_out + 1) * ts;
	out->iae = iae;
	return 0;
}
```

</details>

驱动：[`c/apps/ch02.c`](https://github.com/bfmhno3/pid-lab/tree/tutorial-v1/c/apps/ch02.c)。

### C++

`PolyRoots` 是一个函数模板，`N` 是系数个数，返回 `std::optional<std::array<std::complex<T>, N - 1>>`，根的个数在类型里：

```cpp

// Roots of a[0] x^(N-1) + ... + a[N-1] in the canonical order.
// Returns std::nullopt for a zero leading term.
template <class T, std::size_t N>
std::optional<std::array<std::complex<T>, N - 1>> PolyRoots(
    const std::array<T, N>& a) {
  static_assert(N >= 2, "need degree >= 1");
  constexpr std::size_t kDeg = N - 1;
  if (a[0] == T(0)) return std::nullopt;
  std::array<T, N> c;
  for (std::size_t i = 0; i < N; ++i) c[i] = a[i] / a[0];
  T radius = 0;
  for (std::size_t i = 1; i < N; ++i) radius = std::max(radius, std::abs(c[i]));
  radius += T(1);

  const std::complex<T> seed(T(0.4), T(0.9));
  std::complex<T> pw(1);
  std::array<std::complex<T>, kDeg> z;
  for (std::size_t i = 0; i < kDeg; ++i) {
    z[i] = radius * pw;
    pw *= seed;
  }

  for (int it = 0; it < internal::kMaxIter; ++it) {
    bool done = true;
    for (std::size_t i = 0; i < kDeg; ++i) {
      std::complex<T> den(1);
      for (std::size_t j = 0; j < kDeg; ++j) {
        if (j != i) den *= z[i] - z[j];
      }
      if (den == std::complex<T>(0)) continue;
      const std::complex<T> step = PolyEval(c, z[i]) / den;
      z[i] -= step;
      if (std::abs(step) > T(internal::kDkTol) * (T(1) + std::abs(z[i]))) {
        done = false;
      }
    }
    if (done) break;
  }

  std::array<T, kDeg> dc;
  for (std::size_t i = 0; i < kDeg; ++i) dc[i] = c[i] * T(kDeg - i);
  for (std::size_t i = 0; i < kDeg; ++i) {
    for (int s = 0; s < internal::kNewtonSteps; ++s) {
      z[i] = internal::Newton(c, dc, z[i]);
    }
    if (std::abs(z[i].imag()) <
        T(internal::kRealTol) * std::max(T(1), std::abs(z[i]))) {
      z[i] = std::complex<T>(z[i].real(), T(0));
    }
  }
  CanonicalSort(z);
  return z;
}
```

`std::complex` 的运算符和 C 的 `_Complex` 行为一样，所以循环体几乎是逐字相同。`internal` 命名空间放 Newton 和比较函数，不对外。

<details>
<summary>完整源码：cpp/include/pidlab/poly.h、cpp/include/pidlab/metrics.h</summary>

```cpp
// Polynomials as std::array, coefficients highest degree first, and roots
// by Durand-Kerner with a few safeguarded Newton steps.
#ifndef PIDLAB_POLY_H_
#define PIDLAB_POLY_H_

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstddef>
#include <optional>

namespace pidlab {

namespace internal {

inline constexpr int kMaxIter = 1000;
inline constexpr int kNewtonSteps = 3;
inline constexpr double kDkTol = 1e-14;
inline constexpr double kRealTol = 1e-9;

}  // namespace internal

// a * b
template <class T, std::size_t A, std::size_t B>
std::array<T, A + B - 1> PolyMul(const std::array<T, A>& a,
                                 const std::array<T, B>& b) {
  std::array<T, A + B - 1> out{};
  for (std::size_t i = 0; i < A; ++i) {
    for (std::size_t j = 0; j < B; ++j) out[i + j] += a[i] * b[j];
  }
  return out;
}

// a + b with the constant terms aligned.
template <class T, std::size_t A, std::size_t B>
std::array<T, (A > B ? A : B)> PolyAdd(const std::array<T, A>& a,
                                       const std::array<T, B>& b) {
  constexpr std::size_t kN = A > B ? A : B;
  std::array<T, kN> out{};
  for (std::size_t i = 0; i < A; ++i) out[kN - A + i] += a[i];
  for (std::size_t i = 0; i < B; ++i) out[kN - B + i] += b[i];
  return out;
}

template <class T, std::size_t N>
std::array<T, N> PolyScale(std::array<T, N> a, T s) {
  for (T& c : a) c = s * c;
  return a;
}

// Horner evaluation at a complex point.
template <class T, std::size_t N>
std::complex<T> PolyEval(const std::array<T, N>& a, std::complex<T> z) {
  std::complex<T> acc(0);
  for (const T& c : a) acc = acc * z + c;
  return acc;
}

namespace internal {

// Keep the Newton step only if |p| shrinks.
template <class T, std::size_t N>
std::complex<T> Newton(const std::array<T, N>& a,
                       const std::array<T, N - 1>& da, std::complex<T> z) {
  const std::complex<T> p = PolyEval(a, z);
  const std::complex<T> dp = PolyEval(da, z);
  if (dp == std::complex<T>(0)) return z;
  const std::complex<T> z_new = z - p / dp;
  return std::abs(PolyEval(a, z_new)) < std::abs(p) ? z_new : z;
}

// True when a must come after b.
template <class T>
bool After(std::complex<T> a, std::complex<T> b, T tie) {
  if (std::abs(a.real() - b.real()) <= tie) return a.imag() > b.imag();
  return a.real() > b.real();
}

}  // namespace internal

// Order by real part, near ties by imaginary part (insertion sort).
template <class T, std::size_t N>
void CanonicalSort(std::array<std::complex<T>, N>& z) {
  T max_re = 0;
  for (const auto& w : z) max_re = std::max(max_re, std::abs(w.real()));
  const T tie = T(internal::kRealTol) * (T(1) + max_re);
  for (std::size_t i = 1; i < N; ++i) {
    const std::complex<T> cur = z[i];
    std::size_t j = i;
    while (j > 0 && internal::After(z[j - 1], cur, tie)) {
      z[j] = z[j - 1];
      --j;
    }
    z[j] = cur;
  }
}

// Roots of a[0] x^(N-1) + ... + a[N-1] in the canonical order.
// Returns std::nullopt for a zero leading term.
template <class T, std::size_t N>
std::optional<std::array<std::complex<T>, N - 1>> PolyRoots(
    const std::array<T, N>& a) {
  static_assert(N >= 2, "need degree >= 1");
  constexpr std::size_t kDeg = N - 1;
  if (a[0] == T(0)) return std::nullopt;
  std::array<T, N> c;
  for (std::size_t i = 0; i < N; ++i) c[i] = a[i] / a[0];
  T radius = 0;
  for (std::size_t i = 1; i < N; ++i) radius = std::max(radius, std::abs(c[i]));
  radius += T(1);

  const std::complex<T> seed(T(0.4), T(0.9));
  std::complex<T> pw(1);
  std::array<std::complex<T>, kDeg> z;
  for (std::size_t i = 0; i < kDeg; ++i) {
    z[i] = radius * pw;
    pw *= seed;
  }

  for (int it = 0; it < internal::kMaxIter; ++it) {
    bool done = true;
    for (std::size_t i = 0; i < kDeg; ++i) {
      std::complex<T> den(1);
      for (std::size_t j = 0; j < kDeg; ++j) {
        if (j != i) den *= z[i] - z[j];
      }
      if (den == std::complex<T>(0)) continue;
      const std::complex<T> step = PolyEval(c, z[i]) / den;
      z[i] -= step;
      if (std::abs(step) > T(internal::kDkTol) * (T(1) + std::abs(z[i]))) {
        done = false;
      }
    }
    if (done) break;
  }

  std::array<T, kDeg> dc;
  for (std::size_t i = 0; i < kDeg; ++i) dc[i] = c[i] * T(kDeg - i);
  for (std::size_t i = 0; i < kDeg; ++i) {
    for (int s = 0; s < internal::kNewtonSteps; ++s) {
      z[i] = internal::Newton(c, dc, z[i]);
    }
    if (std::abs(z[i].imag()) <
        T(internal::kRealTol) * std::max(T(1), std::abs(z[i]))) {
      z[i] = std::complex<T>(z[i].real(), T(0));
    }
  }
  CanonicalSort(z);
  return z;
}

}  // namespace pidlab

#endif  // PIDLAB_POLY_H_
```

```cpp
// Step-response metrics from sampled data.
#ifndef PIDLAB_METRICS_H_
#define PIDLAB_METRICS_H_

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <optional>
#include <span>

namespace pidlab {

template <class T = double>
struct StepMetrics {
  T rise;       // 10 % to 90 %, s
  T overshoot;  // percent
  T peak;       // s
  T settle;     // 2 % band, s
  T iae;        // unit * s
};

namespace internal {

// First time the normalized response reaches `level`, interpolated.
template <class T>
T Cross(std::span<const T> y, std::size_t k0, T y0, T amp, T level, T ts) {
  for (std::size_t i = 1; i < y.size() - k0; ++i) {
    const T zi = (y[k0 + i] - y0) / amp;
    if (zi >= level) {
      const T zp = (y[k0 + i - 1] - y0) / amp;
      const T frac = (level - zp) / (zi - zp);
      return (T(i) - T(1) + frac) * ts;
    }
  }
  return std::numeric_limits<T>::quiet_NaN();
}

}  // namespace internal

// Metrics of a step applied at sample k0, from y[k0..]. The start value is
// y[k0], r is the final target, times count from k0. Returns std::nullopt
// if k0 is out of range or the step has zero size.
template <class T>
std::optional<StepMetrics<T>> ComputeStepMetrics(std::span<const T> y, T ts,
                                                 std::size_t k0, T r) {
  constexpr T kPeakTol = T(1e-9);
  constexpr T kBand = T(0.02);
  if (k0 >= y.size() || r == y[k0]) return std::nullopt;
  const std::size_t n = y.size() - k0;
  const T y0 = y[k0];
  const T amp = r - y0;
  T zmax = (y[k0] - y0) / amp;
  T iae = 0;
  long last_out = -1;
  for (std::size_t i = 0; i < n; ++i) {
    const T zi = (y[k0 + i] - y0) / amp;
    zmax = std::max(zmax, zi);
    if (std::abs(zi - T(1)) > kBand) last_out = static_cast<long>(i);
    iae += std::abs(r - y[k0 + i]) * ts;
  }
  std::size_t k_peak = 0;
  for (std::size_t i = 0; i < n; ++i) {
    if ((y[k0 + i] - y0) / amp >= zmax - kPeakTol) {
      k_peak = i;
      break;
    }
  }
  StepMetrics<T> m;
  m.rise = internal::Cross(y, k0, y0, amp, T(0.9), ts) -
           internal::Cross(y, k0, y0, amp, T(0.1), ts);
  m.overshoot = std::max(T(0), zmax - T(1)) * T(100);
  m.peak = static_cast<T>(k_peak) * ts;
  m.settle = static_cast<T>(last_out + 1) * ts;
  m.iae = iae;
  return m;
}

}  // namespace pidlab

#endif  // PIDLAB_METRICS_H_
```

</details>

驱动：[`cpp/apps/ch02.cc`](https://github.com/bfmhno3/pid-lab/tree/tutorial-v1/cpp/apps/ch02.cc)。

### Rust

没有现成的复数，所以先是 `complex.rs`。四则运算我用运算符重载，这样 `poly_roots` 的循环读起来和 Python 一样：

```rust
/// Roots of `a[0] x^n + ... + a[n]` written to `roots[..n]`, canonically
/// ordered. `a` has at most `MAX_POLY` coefficients.
pub fn poly_roots(a: &[Real], roots: &mut [Complex]) -> Result<(), PolyError> {
    let n = a.len();
    if n < 2 || a[0] == 0.0 {
        return Err(PolyError::Degenerate);
    }
    let deg = n - 1;
    if n > MAX_POLY || roots.len() < deg {
        return Err(PolyError::Size);
    }
    let mut c = [0.0; MAX_POLY];
    for i in 0..n {
        c[i] = a[i] / a[0];
    }
    let c = &c[..n];
    let radius = 1.0 + c[1..].iter().fold(0.0, |m: Real, v| m.max(real::fabs(*v)));
    let seed = Complex::new(0.4, 0.9);
    let mut pw = Complex::ONE;
    let z = &mut roots[..deg];
    for zi in z.iter_mut() {
        *zi = pw.scale(radius);
        pw *= seed;
    }

    for _ in 0..MAX_ITER {
        let mut done = true;
        for i in 0..deg {
            let mut den = Complex::ONE;
            for j in 0..deg {
                if j != i {
                    den *= z[i] - z[j];
                }
            }
            if den == Complex::ZERO {
                continue;
            }
            let step = poly_eval(c, z[i]) / den;
            z[i] -= step;
            if step.abs() > DK_TOL * (1.0 + z[i].abs()) {
                done = false;
            }
        }
        if done {
            break;
        }
    }

    let mut dc = [0.0; MAX_POLY];
    for i in 0..deg {
        dc[i] = c[i] * (deg - i) as Real;
    }
    for zi in z.iter_mut() {
        for _ in 0..NEWTON_STEPS {
            *zi = newton(c, &dc[..deg], *zi);
        }
        if real::fabs(zi.im) < REAL_TOL * zi.abs().max(1.0) {
            zi.im = 0.0;
        }
    }
    canonical_sort(z);
    Ok(())
}
```

<details>
<summary>完整源码：rust/src/complex.rs、rust/src/poly.rs、rust/src/metrics.rs</summary>

```rust
//! A minimal complex number: `no_std` has no `Complex`, and root finding
//! needs only a handful of operations.

use core::ops::{Add, AddAssign, Div, Mul, MulAssign, Sub, SubAssign};

use crate::real::{self, Real};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Complex {
    pub re: Real,
    pub im: Real,
}

impl Complex {
    pub const ZERO: Complex = Complex { re: 0.0, im: 0.0 };
    pub const ONE: Complex = Complex { re: 1.0, im: 0.0 };

    pub const fn new(re: Real, im: Real) -> Self {
        Self { re, im }
    }

    /// Modulus.
    pub fn abs(self) -> Real {
        real::hypot(self.re, self.im)
    }

    /// Scale by a real number.
    pub fn scale(self, s: Real) -> Self {
        Self::new(s * self.re, s * self.im)
    }
}

impl Add for Complex {
    type Output = Complex;
    fn add(self, o: Complex) -> Complex {
        Complex::new(self.re + o.re, self.im + o.im)
    }
}

impl Sub for Complex {
    type Output = Complex;
    fn sub(self, o: Complex) -> Complex {
        Complex::new(self.re - o.re, self.im - o.im)
    }
}

impl Mul for Complex {
    type Output = Complex;
    fn mul(self, o: Complex) -> Complex {
        Complex::new(
            self.re * o.re - self.im * o.im,
            self.re * o.im + self.im * o.re,
        )
    }
}

impl Div for Complex {
    type Output = Complex;
    fn div(self, o: Complex) -> Complex {
        let den = o.re * o.re + o.im * o.im;
        Complex::new(
            (self.re * o.re + self.im * o.im) / den,
            (self.im * o.re - self.re * o.im) / den,
        )
    }
}

impl AddAssign for Complex {
    fn add_assign(&mut self, o: Complex) {
        *self = *self + o;
    }
}

impl SubAssign for Complex {
    fn sub_assign(&mut self, o: Complex) {
        *self = *self - o;
    }
}

impl MulAssign for Complex {
    fn mul_assign(&mut self, o: Complex) {
        *self = *self * o;
    }
}
```

```rust
//! Polynomials as slices, coefficients highest degree first, and roots by
//! Durand-Kerner with a few safeguarded Newton steps. No allocation.

use crate::complex::Complex;
use crate::real::{self, Real};

/// Longest supported polynomial, in coefficients.
pub const MAX_POLY: usize = 8;

const MAX_ITER: usize = 1000;
const DK_TOL: Real = 1e-14;
const NEWTON_STEPS: usize = 3;
const REAL_TOL: Real = 1e-9;

#[derive(Debug, PartialEq, Eq)]
pub enum PolyError {
    /// The result does not fit `out`, or the input is empty.
    Size,
    /// Zero leading coefficient, or degree below 1.
    Degenerate,
}

/// `out = a * b`; returns the length of the product.
pub fn poly_mul(a: &[Real], b: &[Real], out: &mut [Real]) -> Result<usize, PolyError> {
    if a.is_empty() || b.is_empty() || a.len() + b.len() - 1 > out.len() {
        return Err(PolyError::Size);
    }
    let n = a.len() + b.len() - 1;
    out[..n].fill(0.0);
    for (i, ai) in a.iter().enumerate() {
        for (j, bj) in b.iter().enumerate() {
            out[i + j] += ai * bj;
        }
    }
    Ok(n)
}

/// `out = a + b` with the constant terms aligned; returns the length.
pub fn poly_add(a: &[Real], b: &[Real], out: &mut [Real]) -> Result<usize, PolyError> {
    let n = a.len().max(b.len());
    if n > out.len() {
        return Err(PolyError::Size);
    }
    out[..n].fill(0.0);
    for (i, ai) in a.iter().enumerate() {
        out[n - a.len() + i] += ai;
    }
    for (i, bi) in b.iter().enumerate() {
        out[n - b.len() + i] += bi;
    }
    Ok(n)
}

/// `a *= s`
pub fn poly_scale(a: &mut [Real], s: Real) {
    for c in a {
        *c *= s;
    }
}

/// Horner evaluation at a complex point.
pub fn poly_eval(a: &[Real], z: Complex) -> Complex {
    let mut acc = Complex::ZERO;
    for &c in a {
        acc = acc * z + Complex::new(c, 0.0);
    }
    acc
}

/// Keep the Newton step only if `|p|` shrinks.
fn newton(a: &[Real], da: &[Real], z: Complex) -> Complex {
    let p = poly_eval(a, z);
    let dp = poly_eval(da, z);
    if dp == Complex::ZERO {
        return z;
    }
    let z_new = z - p / dp;
    if poly_eval(a, z_new).abs() < p.abs() {
        z_new
    } else {
        z
    }
}

/// True when `a` must come after `b`.
fn after(a: Complex, b: Complex, tie: Real) -> bool {
    if real::fabs(a.re - b.re) <= tie {
        a.im > b.im
    } else {
        a.re > b.re
    }
}

/// Order by real part, near ties by imaginary part (insertion sort).
pub fn canonical_sort(z: &mut [Complex]) {
    let max_re = z.iter().fold(0.0, |m: Real, w| m.max(real::fabs(w.re)));
    let tie = REAL_TOL * (1.0 + max_re);
    for i in 1..z.len() {
        let cur = z[i];
        let mut j = i;
        while j > 0 && after(z[j - 1], cur, tie) {
            z[j] = z[j - 1];
            j -= 1;
        }
        z[j] = cur;
    }
}

/// Roots of `a[0] x^n + ... + a[n]` written to `roots[..n]`, canonically
/// ordered. `a` has at most `MAX_POLY` coefficients.
pub fn poly_roots(a: &[Real], roots: &mut [Complex]) -> Result<(), PolyError> {
    let n = a.len();
    if n < 2 || a[0] == 0.0 {
        return Err(PolyError::Degenerate);
    }
    let deg = n - 1;
    if n > MAX_POLY || roots.len() < deg {
        return Err(PolyError::Size);
    }
    let mut c = [0.0; MAX_POLY];
    for i in 0..n {
        c[i] = a[i] / a[0];
    }
    let c = &c[..n];
    let radius = 1.0 + c[1..].iter().fold(0.0, |m: Real, v| m.max(real::fabs(*v)));
    let seed = Complex::new(0.4, 0.9);
    let mut pw = Complex::ONE;
    let z = &mut roots[..deg];
    for zi in z.iter_mut() {
        *zi = pw.scale(radius);
        pw *= seed;
    }

    for _ in 0..MAX_ITER {
        let mut done = true;
        for i in 0..deg {
            let mut den = Complex::ONE;
            for j in 0..deg {
                if j != i {
                    den *= z[i] - z[j];
                }
            }
            if den == Complex::ZERO {
                continue;
            }
            let step = poly_eval(c, z[i]) / den;
            z[i] -= step;
            if step.abs() > DK_TOL * (1.0 + z[i].abs()) {
                done = false;
            }
        }
        if done {
            break;
        }
    }

    let mut dc = [0.0; MAX_POLY];
    for i in 0..deg {
        dc[i] = c[i] * (deg - i) as Real;
    }
    for zi in z.iter_mut() {
        for _ in 0..NEWTON_STEPS {
            *zi = newton(c, &dc[..deg], *zi);
        }
        if real::fabs(zi.im) < REAL_TOL * zi.abs().max(1.0) {
            zi.im = 0.0;
        }
    }
    canonical_sort(z);
    Ok(())
}
```

```rust
//! Step-response metrics from sampled data.

use crate::real::{self, Real};

const PEAK_TOL: Real = 1e-9;
const BAND: Real = 0.02;

/// Times in seconds, overshoot in percent, `iae` in unit * s.
#[derive(Debug, Clone, Copy)]
pub struct StepMetrics {
    /// 10 % to 90 %.
    pub rise: Real,
    pub overshoot: Real,
    pub peak: Real,
    /// 2 % band.
    pub settle: Real,
    pub iae: Real,
}

/// First time the normalized response reaches `level`, interpolated.
fn cross(y: &[Real], k0: usize, y0: Real, amp: Real, level: Real, ts: Real) -> Real {
    for i in 1..y.len() - k0 {
        let zi = (y[k0 + i] - y0) / amp;
        if zi >= level {
            let zp = (y[k0 + i - 1] - y0) / amp;
            let frac = (level - zp) / (zi - zp);
            return ((i - 1) as Real + frac) * ts;
        }
    }
    Real::NAN
}

/// Metrics of a step applied at sample `k0`, from `y[k0..]`. The start
/// value is `y[k0]`, `r` is the final target, times count from `k0`.
/// Returns `None` if `k0` is out of range or the step has zero size.
pub fn step_metrics(y: &[Real], ts: Real, k0: usize, r: Real) -> Option<StepMetrics> {
    if k0 >= y.len() || r == y[k0] {
        return None;
    }
    let n = y.len() - k0;
    let y0 = y[k0];
    let amp = r - y0;
    let mut zmax = (y[k0] - y0) / amp;
    let mut iae = 0.0;
    let mut last_out: isize = -1;
    for i in 0..n {
        let zi = (y[k0 + i] - y0) / amp;
        zmax = zmax.max(zi);
        if real::fabs(zi - 1.0) > BAND {
            last_out = i as isize;
        }
        iae += real::fabs(r - y[k0 + i]) * ts;
    }
    let k_peak = (0..n)
        .find(|&i| (y[k0 + i] - y0) / amp >= zmax - PEAK_TOL)
        .unwrap_or(0);
    Some(StepMetrics {
        rise: cross(y, k0, y0, amp, 0.9, ts) - cross(y, k0, y0, amp, 0.1, ts),
        overshoot: (zmax - 1.0).max(0.0) * 100.0,
        peak: k_peak as Real * ts,
        settle: (last_out + 1) as Real * ts,
        iae,
    })
}
```

</details>

驱动：[`rust/src/bin/ch02.rs`](https://github.com/bfmhno3/pid-lab/tree/tutorial-v1/rust/src/bin/ch02.rs)。`poly_roots` 要求调用者给一个足够长的 `&mut [Complex]`，这是在没有分配器的情况下把“返回一组根”表达出来的方式。

### 编译和风格检查

编译参数和第 1 篇一样：C 是 `gcc -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror`（15.3.0），C++ 是 `g++ -std=c++20`（15.3.0）加同样的警告，Rust 是 rustc 1.95.0、edition 2024，`cargo clippy --release -- -D warnings`（0.1.95）。风格检查：C 用内核的 `checkpatch.pl --no-tree --ignore SPDX_LICENSE_TAG,NEW_TYPEDEFS`，全部文件 0 errors、0 warnings；C++ 用 `clang-format --style=Google`（21.1.8）；Python 用 `ruff format --line-length 79` 和 `ruff check`（0.15.14）；Rust 用 `cargo fmt --check`。另外我手工用 `-DPL_USE_FLOAT` 把 `poly.c`、`metrics.c`、`plants.c` 编了一遍，用 `cargo build --lib --no-default-features --features f32` 编了 Rust 库，都没有警告。

## 结果

`make ch02` 一次跑完。`ok` 行比第 1 篇多，这里只贴头尾：

```text
$ make -s ch02
ch02: C wrote 14 cases, metrics and 2 loci to out/ch02
ch02: C++ wrote 14 cases, metrics and 2 loci to out/ch02
ch02: Rust wrote 14 cases, metrics and 2 loci to out/ch02
ok   metrics_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   metrics_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   metrics_rs.csv: max diff 0.000e+00 <= 1.0e-09
... (trimmed: 42 more ok lines)
ok   rlocus_p_c.csv: max diff 2.842e-14 <= 1.0e-09
ok   rlocus_p_cpp.csv: max diff 2.842e-14 <= 1.0e-09
ok   rlocus_p_rs.csv: max diff 2.842e-14 <= 1.0e-09
ok   rlocus_pd_c.csv: max diff 7.816e-14 <= 1.0e-09
ok   rlocus_pd_cpp.csv: max diff 7.816e-14 <= 1.0e-09
ok   rlocus_pd_rs.csv: max diff 1.386e-13 <= 1.0e-09
```

51 个对比文件（17 组乘 C、C++、Rust）里每一个，和 Python 的最大差值都小于 $10^{-9}$。仿真的 14 组和 `metrics` 是 `0.000e+00`，逐位一致，原因和第 1 篇一样（只有加减乘除，运算顺序写成了一样，x86-64 上 gcc 默认不生成 FMA）。真正有看头的是根轨迹：`rlocus_p` 最大差 $2.842\times 10^{-14}$，`rlocus_pd` 对 C 和 C++ 是 $7.816\times 10^{-14}$，对 Rust 是 $1.386\times 10^{-13}$。我预留的 $10^{-6}$ 一点没用到，差了七个数量级。这大概率是这两条轨迹的网格点没有正好落在重根上，不是 Durand–Kerner 在重根处突然变准了：重根附近它的精度仍然是 $\sqrt\epsilon$ 量级，我没有去构造一个正好重根的 $K$ 来逼它现原形。所以 `report` 里没有任何容差覆盖，两个根轨迹文件和别的文件一样用 $10^{-9}$。

Python 自己的求根还要对照 `numpy.roots`，对 800 个多项式（两条轨迹各 400 个 $K$）：

```text
$ make -s ch02
... (trimmed)
Durand-Kerner vs numpy.roots over 800 polys: max root distance 1.02e-12
```

最大距离 $1.02\times 10^{-12}$，断言阈值是 $10^{-6}$。

### 二阶原型：公式和仿真

云台 PD，$\omega_n = 20$ rad/s，$\zeta$ 取 0.2、0.4、0.7、1：

```text
$ make -s ch02
... (trimmed)
Gimbal PD, wn = 20 rad/s: simulation vs second-order formulas
 zeta     Kp      Kd    Mp %   sim %   tp (s)      sim  4/(z wn)   sim ts    rise
  0.2   8.00  0.1380   52.66   53.49   0.1603   0.1600     1.000    0.988  0.0598
  0.4   8.00  0.2980   25.38   25.75   0.1714   0.1700     0.500    0.419  0.0726
  0.7   8.00  0.5380    4.60    4.61   0.2200   0.2180     0.286    0.297  0.1056
  1.0   8.00  0.7780    0.00    0.00               n/a     0.200    0.292  0.1674
(Kd = 2 zeta wn J - (b + bf), b + bf = 0.022)
```

![ζ 从 0.2 增到 1，云台阶跃响应的超调从 53.49% 降到 0，仿真曲线与二阶公式几乎重合](/assets/images/pid-control/ch02-second-order-family.svg)

左图的实线是仿真，黑色虚线是上一节的闭式 $y_0(t)$，两者几乎叠在一起，右图是对应的极点：$\zeta$ 越小，极点越靠近虚轴，越往上（频率不变，所有极点都在半径为 20 的圆上）。数字上看：$\zeta = 0.2$ 时公式给 52.66%，仿真 53.49%，差 0.83 个百分点；峰值时间 0.1603 s 对 0.1600 s。$\zeta = 0.7$ 时公式 4.60%，仿真 4.61%。差距随 $\zeta$ 变小而变大，而且永远是仿真更大，我认为这是零阶保持的延迟（大约 $t_s/2$）在悄悄削掉一点相位，等效地减小了阻尼。我没有单独验证这个解释，但第 3 篇会把这个延迟变成相位裕度，到时候能直接算。

$\zeta = 1$ 的调节时间（0.292 s）比 $\zeta = 0.7$（0.297 s）还短，不是哪里算错了：$\zeta = 0.7$ 有 4.6% 的超调，要进 2% 的带子得先冲出去再绕回来，临界阻尼从下面单调爬进去，反而更早进带子。$4/(\zeta\omega_n)$ 对 $\zeta = 0.7$ 的预测是 0.286 s（实测 0.297 s），对 $\zeta = 1$ 是 0.200 s（实测 0.292 s），偏得很多：这个公式本来就只是包络线的粗略估计，$\zeta$ 接近 1 时没有振荡包络可言。

### 极点配置与闭环零点

速度环 PI 用公式 $K_p = (2\zeta\omega_n J - b)/K_t$、$K_i = \omega_n^2J/K_t$ 配到 $\zeta = 0.7$，每个 $\omega_n$ 各跑一次 PI 和一次 I-P（`_ip` 后缀）。`pi_ch01` 和 `pi_ch01_ip` 是第 1 篇的增益，最后两行是对它的核对：

```text
$ make -s ch02
... (trimmed)
Speed PI vs I-P: closed-loop zero at -Ki/Kp
             case      Kp      Ki     wn   zeta    zero  proto %  +zero %   sim %  sat u
     pi_place_w10   1.367   10.00  10.00  0.700   -7.32     4.60    20.06   20.29     no
  pi_place_w10_ip   1.367   10.00  10.00  0.700   -7.32     4.60    20.06    4.70     no
     pi_place_w30   4.167   90.00  30.00  0.700  -21.60     4.60    20.70   21.48    yes
  pi_place_w30_ip   4.167   90.00  30.00  0.700  -21.60     4.60    20.70    4.92     no
          pi_ch01   1.000   10.00  10.00  0.517  -10.00    15.02    27.94   28.29     no
       pi_ch01_ip   1.000   10.00  10.00  0.517  -10.00    15.02    27.94   15.30     no

             case  rise (s)  settle (s)      IAE   sim %
     pi_place_w10    0.0868       0.488   0.4784   20.29
  pi_place_w10_ip    0.2111       0.597   0.8070    4.70
     pi_place_w30    0.0280       0.161   0.1633   21.48
  pi_place_w30_ip    0.0694       0.199   0.2703    4.92
 pi_place_w30_lag    0.0267       0.158   0.1678   22.58
          pi_ch01    0.0953       0.745   1.2680   28.29
       pi_ch01_ip    0.1659       0.791   1.7011   15.30
ch01 gains (Kp=1, Ki=10): PI 28.29 %, I-P 15.30 %, prototype formula 15.02 %, with the zero 27.94 %
pi_ch01 with the integrator updated before u (ch01's order): 28.02 %
```

![同样的极点配置，PI 超调 20.29%，I-P 只有 4.70%；第三格是第 1 篇的增益，28.29% 对 15.30%](/assets/images/pid-control/ch02-pole-placement-zero.svg)

极点配置的 $\zeta$ 是 0.7，不带零点的原型应该给 4.60%。PI 的实测是 20.29%（$\omega_n = 10$）和 21.48%（$\omega_n = 30$），零点公式预测 20.06% 和 20.70%，仿真比公式高 0.23 和 0.78 个百分点，同样是采样保持的方向。**零点把 4.6% 变成了 20%，是 4.4 倍。** I-P 的实测是 4.70% 和 4.92%，和原型 4.60% 只差 0.10 和 0.32。第 1 篇的增益也是同一个故事：PI 28.29%，零点公式 27.94%，I-P 15.30%，原型 15.02%。

我把这件事看成一笔交易：I-P 把超调压到原型水平，上升时间从 0.0868 s 变成 0.2111 s（2.4 倍），IAE 从 0.4784 变成 0.8070（1.7 倍）。零点是在拿超调换速度。哪个对，取决于这个速度环后面接什么；如果它是串级里的内环（第 7 篇），超调往往不是问题，慢才是。

债还清了，但有三处要交代。第一，第 1 篇报告的是 28.02%，这里是 28.29%，差 0.27。不是实验不稳：这一篇的驱动在算完 $u$ 之后才更新积分，第 1 篇的 `PidBasic` 是先更新积分再算 $u$，积分项等于提前了一个采样点。我在 `report` 里把 `pi_ch01` 按第 1 篇的顺序重跑了一次，输出最后一行的 28.02% 就是它，和第 1 篇对上了。第二，`pi_place_w30` 的 $u$ 在第一个采样点就是 $K_p r = 4.167\times 5 = 20.83$ A，超过 20 A 的限幅，表里 `sat u` 标 yes。限幅只持续了几个采样点，所以 21.48% 里有一小部分不是线性公式能解释的，我没有把它拆出来。第三，`pi_place_w30_lag` 是同一个控制器接到带 1 ms 电流环的对象上：超调 22.58%，比没有电流环的 21.48% 多 1.1 个百分点，上升时间 0.0267 s。这就是电流环的代价，也是后面几篇都要带着 `MotorSpeedLag` 的原因。

### Routh：临界增益比算出来的低 20%

拨弹盘 P 控制，增益取 Routh 临界增益的 0.7、0.9、1.1 倍：

```text
$ make -s ch02
... (trimmed)
Routh: K_crit = 16.7333 A/rad, crossing at w = sqrt(b/(J tau_c)) = 31.623 rad/s
exact 1 kHz ZOH loop: critical gain 13.3776 A/rad = 0.7995 K_crit
      case       K   pole re  ZOH pred  sim slope  max|u|
 routh_0.7  11.713   -0.2983   -0.1236    -0.1236    0.59
 routh_0.9  15.060   -0.0993   +0.1247    +0.1247    0.95
 routh_1.1  18.407   +0.0991   +0.3721    +0.3721    1.86
```

![Routh 临界增益 16.73 与采样后的临界增益 13.38；0.9 倍的增益在 1 kHz 采样下已经不稳](/assets/images/pid-control/ch02-routh-boundary.svg)

这是这一篇里和我预期不符的地方。我原本打算只用 0.9 和 1.1 倍的 $K_{crit}$，预期 0.9 衰减、1.1 发散。实测不是这样：`routh_0.9` 和 `routh_1.1` 的响应都在增长，只有我后来加的 `routh_0.7` 是衰减的。

原因在表的 `ZOH pred` 一列：我用上面那个精确离散模型预测的增长率，和仿真里把偏差包络的峰值取对数、做线性回归得到的斜率，在 0.7、0.9、1.1 倍三个增益上分别是 $-0.1236$、$+0.1247$、$+0.3721$，**小数点后四位完全一致**。也就是说仿真没问题，我的“连续时间”预测错了：连续模型说 0.9 倍时最右的极点实部是 $-0.0993$（稳定），而带保持器的 1 kHz 系统里这个模式在以每秒 $e^{0.1247}$ 的速率增长。精确离散模型算出来的临界增益是 13.3776 A/rad，是连续 Routh 值的 0.7995 倍：**一个 1 ms 的采样周期，吃掉了 20% 的增益裕度。** 图下半部分的红线（16.73，连续）和绿线（13.38，采样后）就是这两个边界。

我很想说这是意外，但回头看是合理的。在 $\omega_c = 31.623$ rad/s 处，对象的相位是 $-90°$（积分器）$-\arctan(\omega_c J/b) = -86.4°$（$J$、$b$ 那一极点）$-\arctan(\omega_c\tau_c) = -3.6°$（电流环），加起来正好 $-180°$。也就是说它几乎是个双积分器，电流环只给了 3.6° 的滞后，边界附近的相位裕度就薄到这个量级。保持器和采样再加上 $\omega_c t_s/2 = 0.016$ rad，约 0.91°，相对 3.6° 不是小数，所以临界增益掉得很明显。这是我手算的估计，不是仿真输出，但方向和量级对得上。第 3 篇会用频域把“还剩多少相位和延迟”变成一个直接可算的数，不用每次靠重新离散化去试。

### 根轨迹

两条轨迹的关键位置，都来自 `rlocus_p` 和 `rlocus_pd` 的 CSV：

```text
$ make -s ch02
... (trimmed)
Root locus over 400 log-spaced K in [0.01, 1000]
breakaway estimate b^2 / (4 J Kt) = 0.0167 (lag ignored)
rlocus_p: a pair leaves the real axis between K = 0.0163 and 0.0168
rlocus_p: rightmost pole crosses the imaginary axis between K = 16.6170 and 17.1034 (Routh: 16.7333)
rlocus_p: largest real part over the grid +42.6398 at K = 1000.0000
rlocus_pd: a pair leaves the real axis between K = 0.0173 and 0.0178
rlocus_pd: a pair returns to the real axis between K = 22.8242 and 23.4924
rlocus_pd: a pair leaves the real axis between K = 44.3217 and 45.6192
rlocus_pd: largest real part over the grid -0.3594 at K = 0.0100
```

![P 对象的根轨迹穿过虚轴进入右半平面，加了 PD 零点后整条轨迹都留在左半平面](/assets/images/pid-control/ch02-root-locus.svg)

上排是整条轨迹的全貌，下排是原点附近的放大。左列（P）：一对极点在 $K = 0.0163$ 到 $0.0168$ 之间离开实轴，我用忽略电流环的二阶近似 $b^2 - 4JKK_t = 0$ 估计的是 0.0167，落在这个区间里。然后轨迹向上弯，在 $K = 16.62$ 到 $17.10$ 之间穿过虚轴（图里的红星是 $\pm 31.623j$），Routh 值 16.7333 在这个区间里，这是对 Routh 推导的一次独立检验。$K = 1000$ 时最右的极点实部是 $+42.64$，早就不稳了。

右列（PD）：开环零点在 $-20$（空心圆）。轨迹也先离开实轴（$K$ 在 0.0173 到 0.0178 之间），但随后绕了一个半圆，在 $K = 22.82$ 到 $23.49$ 之间回到实轴，一个根被零点吸住（最后贴着 $-20$），另一个往左，然后在 $K = 44.32$ 到 $45.62$ 之间和 $-500$ 那一支碰头，再次变成复数对，沿着实部约 $-240$ 的竖线往上跑（图里上排右）。**整个网格上最大的实部是 $-0.3594$，在 $K = 0.01$。** 上一节 Routh 推出的“PD 对所有 $K$ 稳定”在数据里没有被推翻。（我只试了 $K \le 1000$，这不是证明，证明是上面方括号那一行。）

PD 轨迹中间那一段几乎是个圆，圆心在零点。两个极点加一个零点的根轨迹有一个经典结论：复数段是以零点为圆心的圆，半径是零点到两个极点距离的几何平均，这里是 $\sqrt{20\times 18} = 18.97$，回到实轴的位置因此在 $-20 - 18.97 = -38.97$。我没有在这里推这个结论，只是拿图来对：下排右图里圆的左端在 $-40$ 附近，和 $-38.97$ 对得上，$-500$ 的电流环极点让它略微变形。

## 下一篇

这一篇我把极点从“调参的结果”变成了“可以直接放的东西”：$K_p$、$K_i$、$K_d$ 由 $\omega_n$ 和 $\zeta$ 算出来，Routh 判据和根轨迹给出稳定的增益范围，I-P 把零点带来的超调拿掉。同时我也发现，连续时间的稳定边界在 1 kHz 采样下少了 20%，这个损失来自保持器和电流环叠加出来的延迟，而我只能靠“重新算一遍离散模型”去量它。

[第 3 篇：频域：Bode、Nyquist 与稳定裕度](/posts/pid-control-03-frequency-domain/)会换一个视角：不再问极点在哪，而是问回路对不同频率的正弦信号放大多少、延迟多少相位。相位裕度和延迟裕度会把这一篇里的 20% 变成一个直接可算的数；同样的 PI（$\omega_n = 10$、$\zeta = 0.7$）加上 `MotorSpeedLag` 和一个采样周期的纯延迟，我会拿它做“把延迟加到裕度的 0.9 倍和 1.1 倍，看它衰减还是发散”的实验，这次的预测来自裕度，不来自重新离散化。
