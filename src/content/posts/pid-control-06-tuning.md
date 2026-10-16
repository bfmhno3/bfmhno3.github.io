---
title: "整定：Ziegler–Nichols、继电器自整定与 SIMC"
commentId: "post:pid-control-06-tuning"
published: "2026-10-16 13:00:00 +08:00"
description: "PID 控制系列第 6 篇：我用 Python 3.13、gcc 15.3、g++ 15.3 和 rustc 1.95 把两点阶跃拟合、继电器自整定、两套 Ziegler–Nichols 规则和 SIMC 各写了四遍，在摩擦轮和 1/(s+1)^4 上比较。两点法在摩擦轮上把 3.00 ms 的等效延迟拟合成 1.39 ms，Ziegler–Nichols 阶跃法因此给出相位裕度 -48.7° 的增益；带 2 rad/s 滞环的继电器读到的 Ku 是 4.81，真值是 12.87，因为它测的不是 -180° 那一点；四阶对象上继电器的 Ku 只比真值低 1.7%；SIMC 的超调 6.8%，Ziegler–Nichols 继电器法 36.2%，代价是负载 IAE 3.75 对 1.38。"
category: Tutorial
tags:
  - PID
  - 控制理论
  - 整定
  - 继电器
series: "PID 控制：从一个电机到 LQR"
seriesOrder: 6
draft: false
comment: true
slug: pid-control-06-tuning
---

手调 PID 最常见的一招是：Ki、Kd 先放着，把 Kp 一点点加大，直到电机开始啸叫，再退回去一半左右。这个手艺有名字，它是 [Ziegler 和 Nichols 1942 年发表的“临界增益法”](https://asmedigitalcollection.asme.org/fluidsengineering/article/64/8/759/1155342/Optimum-Settings-for-Automatic-Controllers)的手动版，“一半左右”大致对应他们的 $0.6K_u$。**这一篇我把“凭手感”拆成三个可以写成函数的步骤：测一条阶跃响应，拟合一个一阶加延迟模型；或者让继电器替我把回路推到临界振荡，读出 $K_u$ 和 $P_u$；再用 Ziegler–Nichols 或 [Skogestad 的 SIMC 规则](https://skoge.folk.ntnu.no/publications/2003/tuningPID/finalpaper.pdf)算增益。** 对象是第 5 篇的两个：一个带电流环和 2 拍指令延迟的摩擦轮，一个教科书里的 $1/(s+1)^4$。结果比我预想的难看：阶跃法在摩擦轮上给出了一组线性回路不稳定的增益，继电器法在摩擦轮上读出的 $K_u$ 比真值小 2.7 倍，而这个偏小的值恰好给出了最安全的一组增益。

> [!NOTE] 本篇检查点
> 这一篇结束时你会有：`make ch06` 通过，`out/ch06/` 下 56 个 CSV（两个对象各 7 个算例：`step`、`relay`、`ident`、`tuning`，以及 `eval_<plant>_{zn_step,zn_ultimate,simc}`，每个 Python、C、C++、Rust 各一份），`figures/ch06/` 下 5 张图；以及阶跃拟合、描述函数、Ziegler–Nichols 和 SIMC 的推导。
> 新增模块：Python 是 `pidlab/tuning.py`（`fopdt_fit`、`Relay`、`relay_analyse`、`zn_step`、`zn_ultimate`、`simc_pi`），另外在 `pidlab/plants.py` 里加了 `Flywheel` 和 `Benchmark4`；C 是 `pl/tuning.h` 和 `tuning.c`（`plants.h`、`plants.c` 里加了 `pl_flywheel`、`pl_benchmark4`）；C++ 是 `pidlab/tuning.h`（`plants.h` 里加了 `Flywheel<T>`、`Benchmark4<T>`）；Rust 是 `tuning.rs`（`plants.rs` 里加了 `Flywheel`、`Benchmark4`）。评估用的是第 5 篇的 `Pid`，没有新的控制器代码。
> 前置：[第 5 篇](/posts/pid-control-05-practical/)。需要的数学：一阶系统的阶跃响应，第 3 篇的 Bode 图和灵敏度峰值 $M_s$，一点点傅里叶级数。

## 数学

### 两个对象

**摩擦轮**是这一篇新加的第一个对象，装在转子侧：

$$
J\dot\omega = K_t\,(i - d) - b\,\omega,\qquad \tau_c\,\dot i = i_{cmd} - i
$$

$d$ 是折算成电流的负载（A），指令 $i_{cmd}$ 先过 2 拍（2 ms）的传输延迟，再进电流环。参数是 $J = 4\times10^{-4}$ kg·m²、$b = 2\times10^{-4}$、$\tau_c = 1$ ms，全是我取的。$K_t = 0.3/(3591/187) = 0.01562$ N·m/A：0.3 来自第 1 篇引用的 M3508 P19 手册，3591/187 是我记得的 P19 减速比，**这个比值我没有从手册里核实，当作假设**。所以直流增益 $K_t/b = 78.11$ rad/s 每安培，机械时间常数 $J/b = 2.0$ s，而电流环加延迟加起来只有 3 ms：一个典型的“滞后主导”对象，$\tau/\theta$ 大约 667。

**四阶对象** $G(s) = 1/(s+1)^4$ 是整定论文里常见的基准，它有 4 个重合的极点，没有延迟，但慢极点串起来的效果很像延迟。它的采样周期 $T_s = 10$ ms，无限幅。

### 一阶加延迟模型

整定规则几乎都吃同一种模型，FOPDT（first-order plus dead time）：

$$
G(s) \approx \frac{k\,e^{-\theta s}}{\tau s + 1}
$$

$k$ 是静态增益，$\tau$ 是时间常数，$\theta$ 是等效延迟。给输入一个阶跃 $\Delta u$，输出的归一化响应 $z(t) = (y(t) - y_0)/\Delta y$（$\Delta y$ 是最终变化量）在 $t > \theta$ 之后是

$$
z(t) = 1 - e^{-(t-\theta)/\tau}
$$

只有 $\tau$ 和 $\theta$ 两个未知数，读两个点就够了。我取 28.3% 和 63.2%：$z = 0.632$ 时 $(t-\theta)/\tau = -\ln(1-0.632) = 0.9997 \approx 1$；$z = 0.283$ 时 $-\ln(1-0.283) = 0.3327 \approx 1/3$。记这两个时刻为 $t_{63}$ 和 $t_{28}$，则

$$
t_{63} - t_{28} \approx \tfrac{2}{3}\tau,\qquad \tau = 1.5\,(t_{63} - t_{28}),\qquad \theta = t_{63} - \tau,\qquad k = \frac{\Delta y}{\Delta u}
$$

**这个拟合的便宜之处是它对噪声不敏感（只用了两个点），代价是它把“1.5”和“0.283、0.632”这些取整的常数都当成精确的。** 当 $\tau$ 比 $\theta$ 大几百倍的时候，取整误差会把 $\theta$ 吃掉：精确的常数是 0.9997 和 0.6670×1.5 = 1.0005，$\theta$ 的误差是 $(0.9997 - 1.0005)\tau = -0.0008\tau$，对 $\tau = 2$ s 就是 1.7 ms。我先写在这里，后面的摩擦轮会撞上它。

### Ziegler–Nichols 两套规则

两套规则都输出 PID 的参数，我统一换成并联形式 $u = k_pe + k_i\int e + k_d\dot e$，其中 $k_i = k_p/T_i$、$k_d = k_pT_d$。

**阶跃法（reaction curve）：** 用 FOPDT 的三个参数。

$$
k_p = \frac{1.2\,\tau}{k\,\theta},\qquad T_i = 2\theta,\qquad T_d = 0.5\,\theta
$$

据我所知原文是用“反应速率”$R = k/\tau$ 和延迟 $L = \theta$ 写的，$k_p = 1.2/(RL)$，两种写法相同。这条规则为什么长这样？拿一个滞后主导的对象，$\tau \gg \theta$，开环近似成积分器加延迟 $\frac{k}{\tau s}e^{-\theta s}$。$k_p k/\tau = 1.2/\theta$，所以回路增益在 $\omega_c \approx 1.2/\theta$ 处穿过 1。在这个频率上，延迟贡献 $-1.2$ rad $= -68.8°$，积分器 $-90°$，PID 的相位是 $\arctan(\omega_cT_d - 1/(\omega_cT_i)) = \arctan(0.6 - 0.4167) = +10.4°$，合计 $-148.4°$，**相位裕度大约 32°**。我另外跑了一个一次性的脚本核对（没有放进仓库）：$\tau/\theta = 50$ 时 32.3°，500 时 31.5°。32° 的相位裕度意味着阶跃响应很振荡，据我所知这是故意的：原文追求的是扰动响应每个周期衰减到四分之一，不是平滑。[Skogestad 的论文](https://skoge.folk.ntnu.no/publications/2003/tuningPID/finalpaper.pdf)也把 Ziegler–Nichols 的设定叫做 “rather aggressive”。

**临界法（ultimate cycle）：** 只用 P 控制把回路推到等幅振荡，读出此时的增益 $K_u$ 和周期 $P_u$：

$$
k_p = 0.6\,K_u,\qquad T_i = P_u/2,\qquad T_d = P_u/8
$$

$K_u$ 是奈奎斯特曲线穿过 $-180°$ 时 $|G|$ 的倒数，$P_u = 2\pi/\omega_u$。$k_p = 0.6K_u$ 意味着只用了 4.4 dB 的增益裕度，再扣掉 PI 加 D 在这一频率附近的相位影响，就是一个不太宽裕的回路。

### 继电器和描述函数

手动加 Kp 到振荡有两个毛病：要有人盯着，而且真的会把电机推到振荡的边缘。[Åström 和 Hägglund 1984 年的方案](https://www.sciencedirect.com/science/article/pii/0005109884900141)是用继电器代替手：控制器输出 $+d$ 或 $-d$，误差变号就翻转，回路自己会找到一个极限环，极限环的幅值和周期里带着 $K_u$ 和 $P_u$。**这跟推秋千一样：你不需要知道秋千的固有频率，只要每次在它过最低点的时候推一把，它自己会稳定在它的固有频率上。**

设继电器输入 $e(t) = a\sin\omega t$，输出是幅值 $\pm d$ 的方波（先令滞环 $\epsilon = 0$）。方波的基波分量用傅里叶系数算：

$$
b_1 = \frac{1}{\pi}\int_0^{2\pi} u(\vartheta)\sin\vartheta\,d\vartheta = \frac{2}{\pi}\int_0^{\pi} d\sin\vartheta\,d\vartheta = \frac{4d}{\pi}
$$

$\cos$ 项由对称性为 0。**描述函数**把继电器当成一个幅值相关的增益，只保留基波：

$$
N(a) = \frac{b_1}{a} = \frac{4d}{\pi a}
$$

回路是继电器 $N(a)$ 加线性对象 $G(s)$ 的负反馈。持续振荡要求基波绕回来后自洽（谐波平衡）：$1 + N(a)G(j\omega) = 0$，即

$$
G(j\omega) = -\frac{1}{N(a)} = -\frac{\pi a}{4d}
$$

右边是负实轴上的一点，所以 $\omega$ 就是 $G$ 穿过 $-180°$ 的频率 $\omega_u$，$P_u = 2\pi/\omega_u$；幅值条件 $|G(j\omega_u)| = \pi a/(4d) = 1/K_u$ 给出

$$
K_u = \frac{4d}{\pi a}
$$

**近似的前提是对象是低通的，$y$ 里的三次、五次谐波可以忽略。** 四阶对象有四个极点，这个假设成立得很好，后面的图里 $y$ 看起来是干净的正弦。

**现实里继电器有滞环 $\epsilon$（也是为了不被噪声反复触发）**：误差上升过 $+\epsilon$ 才翻到 $+d$，下降过 $-\epsilon$ 才翻到 $-d$。方波因此相对输入滞后一个角度 $\varphi = \arcsin(\epsilon/a)$，基波的幅值仍然是 $4d/\pi$，但在原来的相位上多了 $-\varphi$ 的滞后。展开：基波是 $\frac{4d}{\pi}\sin(\omega t - \varphi)$，所以

$$
N(a) = \frac{4d}{\pi a}\,e^{-j\arcsin(\epsilon/a)}
$$

（精确的复数形式里实部是 $\frac{4d}{\pi a}\sqrt{1-\epsilon^2/a^2}$，虚部是 $-\frac{4d}{\pi a}\cdot\frac{\epsilon}{a}$，模长是 $\frac{4d}{\pi a}$。）谐波平衡变成

$$
G(j\omega) = -\frac{1}{N(a)} = -\frac{\pi a}{4d}\,e^{+j\arcsin(\epsilon/a)}
$$

相位是 $-180° + \arcsin(\epsilon/a)$。**有滞环的继电器测的不是 $-180°$ 那一点，而是 $-180°$ 往回一点的位置**，这个位置比 $\omega_u$ 低，$|G|$ 更大，所以读出来的 $4d/(\pi a)$ 比真正的 $K_u$ 小。后面摩擦轮的实验会用上这个结论。

### SIMC

SIMC（Skogestad IMC）是从另一个方向想问题：先指定想要的闭环响应，再反推控制器。对 FOPDT 对象 $g(s) = ke^{-\theta s}/(\tau s+1)$，指定设定值到输出的闭环响应保留不可避免的延迟，其余是一阶：

$$
\frac{y}{y_s} = \frac{e^{-\theta s}}{\tau_c s + 1}
$$

$\tau_c$ 是唯一的整定参数。从 $T = gc/(1+gc)$ 解出控制器 $c = \frac{1}{g}\cdot\frac{T}{1-T}$，$1 - T = (\tau_cs + 1 - e^{-\theta s})/(\tau_cs+1)$，代入得

$$
c(s) = \frac{\tau s + 1}{k\,(\tau_c s + 1 - e^{-\theta s})}
$$

这是个史密斯预估器的形状，没法直接放进 PID。用一阶泰勒 $e^{-\theta s} \approx 1 - \theta s$，分母变成 $k(\tau_c + \theta)s$：

$$
c(s) \approx \frac{\tau s + 1}{k(\tau_c + \theta)s} = K_p\left(1 + \frac{1}{\tau s}\right),\qquad K_p = \frac{\tau}{k(\tau_c + \theta)},\quad T_i = \tau
$$

这是 PI，积分时间等于对象的时间常数：积分项把对象的极点消掉。对设定值很好，对负载扰动，如果 $\tau$ 很大（像摩擦轮的 2 s），$T_i = \tau$ 会让扰动恢复得很慢。Skogestad 的修正是限制 $T_i$：把对象近似成积分器 $k' / s$（$k' = k/\tau$），PI 的闭环特征式是

$$
s^2 + k'K_p\,s + \frac{k'K_p}{T_i} = 0
$$

临界阻尼要求判别式 $(k'K_p)^2 = 4k'K_p/T_i$，即 $T_i = 4/(k'K_p)$。把 $K_p = 1/(k'(\tau_c+\theta))$ 代入得 $T_i = 4(\tau_c + \theta)$。两个限制取小的：

$$
K_p = \frac{\tau}{k(\tau_c+\theta)},\qquad T_i = \min\big(\tau,\ 4(\tau_c + \theta)\big)
$$

这个推导我对照了 [Skogestad 2003](https://skoge.folk.ntnu.no/publications/2003/tuningPID/finalpaper.pdf) 的式（19）到式（24）。$\tau_c = \theta$ 是他推荐的“紧”整定，我默认就用它：$K_p = \tau/(2k\theta)$，$T_i = \min(\tau, 8\theta)$。**要更保守就加大 $\tau_c$，不用换公式**，这是 SIMC 比 Ziegler–Nichols 好用的地方。同一篇论文还说：数字实现时采样周期 $h$ 对等效延迟贡献约 $h/2$（ZOH 平均要等半个采样周期）；这一点我后面要用。

### 鲁棒性与性能

比较三套规则需要至少两个指标：

- **性能：** IAE $= \int|r - y|\,dt$，设定值阶跃之后算一次（`IAE_sp`），负载阶跃之后算一次（`IAE_ld`）；再加设定值阶跃的超调。
- **鲁棒性：** 第 3 篇的灵敏度峰值 $M_s = \max_\omega|1/(1+L(j\omega))|$，它是奈奎斯特曲线到 $-1$ 的最近距离的倒数。$M_s$ 在 1.4 到 2 之间通常算稳妥，更大就是离 $-1$ 太近。我用 `freq` 模块在真实对象（含延迟和第 4 篇的半拍 ZOH）上算。

**注意：$M_s$ 只在回路稳定时是个有意义的“距离”。** 不稳定的回路 $|1+L|$ 的最小值也可以很大；后面摩擦轮的阶跃法就是例子。

评估用第 5 篇的 `Pid`：`CLAMP` 抗饱和，微分滤波 $t_f = T_d/10$，输出夹在执行器范围内。设定值阶跃之后，在一半的时间点加一个负载阶跃。

## Python 实现

### 对象

两个新对象放在 `pidlab/plants.py`。摩擦轮把 2 拍延迟留给仿真的 `DelayLine`（和第 2 篇起的 `DialPosition` 一样，延迟属于回路不属于 ODE）：

```python
@dataclass
class Flywheel:
    """摩擦轮 on the motor rotor, with a current loop and a command delay.

    J w' = Kt (i - d) - b w, tau_c i' = i_cmd - i. The load d is a current
    equivalent (A) that opposes the command. The `delay` samples of command
    delay belong to the loop, not to the ODE, so the sim applies them with
    a DelayLine. State x = [w, i]; input u = [i_cmd, d]; output w.
    """

    kt: float = 0.3 / (3591.0 / 187.0)
    j: float = 4e-4
    b: float = 2e-4
    tau_c: float = 0.001
    u_max: float = 20.0

    n = 2
    m = 2
    delay = 2

    def deriv(self, x, u):
        return [
            (self.kt * (x[1] - u[1]) - self.b * x[0]) / self.j,
            (u[0] - x[1]) / self.tau_c,
        ]

    def output(self, x):
        return x[0]
```

四阶对象是四个串联的一阶滞后，负载 $d$ 从输入端减去：

```python
@dataclass
class Benchmark4:
    """The textbook 1 / (tau s + 1)^4: four equal first-order lags.

    State x = [x1..x4]; input u = [u, d] with the load d subtracted from
    the input; output x4.
    """

    tau: float = 1.0

    n = 4
    m = 2

    def deriv(self, x, u):
        return [
            (u[0] - u[1] - x[0]) / self.tau,
            (x[0] - x[1]) / self.tau,
            (x[1] - x[2]) / self.tau,
            (x[2] - x[3]) / self.tau,
        ]

    def output(self, x):
        return x[3]
```

### 整定模块

`pidlab/tuning.py` 是这一篇的主体，全文如下。它只做数组上的算术，没有 numpy 依赖，四种语言可以一步步照抄：

```python
"""Plant identification and PID tuning rules.

Everything here is plain arithmetic on recorded data, so the C, C++ and
Rust versions can repeat it step for step. Gains are parallel form:
u = kp e + ki int(e) + kd de/dt.
"""

import math
from collections.abc import Sequence
from typing import NamedTuple

T28 = 0.283  # the two points of the step-response fit
T63 = 0.632


class Fopdt(NamedTuple):
    """k exp(-theta s) / (tau s + 1)."""

    k: float
    tau: float
    theta: float


class Gains(NamedTuple):
    kp: float
    ki: float
    kd: float


class RelayResult(NamedTuple):
    """Ultimate gain and period, and the oscillation amplitude of y."""

    ku: float
    pu: float
    a: float


def _cross(z: Sequence[float], level: float, ts: float) -> float:
    """First time z reaches level, linearly interpolated; NaN if never."""
    for i in range(1, len(z)):
        if z[i] >= level:
            frac = (level - z[i - 1]) / (z[i] - z[i - 1])
            return (i - 1 + frac) * ts
    return math.nan


def fopdt_fit(u: Sequence[float], y: Sequence[float], ts: float) -> Fopdt:
    """Two-point fit of a recorded open-loop step.

    The step is the first sample where u differs from u[0]. The final
    value is the last sample, so the record must have settled. t28 and
    t63 are the times to 28.3 % and 63.2 % of the change; then
    tau = 1.5 (t63 - t28) and theta = t63 - tau.
    Raises ValueError if there is no step, no change, or no usable delay.
    """
    k0 = next((i for i, ui in enumerate(u) if ui != u[0]), -1)
    if k0 < 0:
        raise ValueError("no step in u")
    du = u[k0] - u[0]
    y0 = y[k0]
    dy = y[-1] - y0
    if dy == 0.0:
        raise ValueError("y did not move")
    z = [(y[i] - y0) / dy for i in range(k0, len(y))]
    t28 = _cross(z, T28, ts)
    t63 = _cross(z, T63, ts)
    tau = 1.5 * (t63 - t28)
    theta = t63 - tau
    if not (tau > 0.0 and theta > 0.0):
        raise ValueError("no usable first-order-plus-delay fit")
    return Fopdt(dy / du, tau, theta)


class Relay:
    """Two-level relay with hysteresis: output +-d, flips when |e| > eps."""

    def __init__(self, d: float, eps: float) -> None:
        self.d = d
        self.eps = eps
        self.state = 1

    def update(self, e: float) -> float:
        if self.state > 0 and e < -self.eps:
            self.state = -1
        elif self.state < 0 and e > self.eps:
            self.state = 1
        return self.state * self.d


def relay_analyse(
    r: Sequence[float],
    y: Sequence[float],
    u: Sequence[float],
    ts: float,
    eps: float,
    d: float,
) -> RelayResult:
    """Ku and Pu from a recorded relay experiment.

    An upward switch is a sample where u turns positive; its time is the
    linear interpolation of the crossing of e = r - y through +eps. Pu is
    the mean of the last three periods between upward switches, a the
    half peak-to-peak of y over the last period, Ku = 4 d / (pi a).
    Raises ValueError with fewer than four upward switches.
    """
    ups = []
    for k in range(1, len(u)):
        if u[k] > 0.0 and u[k - 1] <= 0.0:
            e0 = r[k - 1] - y[k - 1]
            e1 = r[k] - y[k]
            ups.append((k, (k - 1 + (eps - e0) / (e1 - e0)) * ts))
    if len(ups) < 4:
        raise ValueError("fewer than four upward switches")
    pu = (ups[-1][1] - ups[-4][1]) / 3.0
    seg = y[ups[-2][0] : ups[-1][0]]
    a = (max(seg) - min(seg)) / 2.0
    return RelayResult(4.0 * d / (math.pi * a), pu, a)


def zn_step(m: Fopdt) -> Gains:
    """Ziegler-Nichols reaction-curve PID: 1.2 tau / (k theta), 2 theta,
    theta / 2."""
    kp = 1.2 * m.tau / (m.k * m.theta)
    return Gains(kp, kp / (2.0 * m.theta), kp * (0.5 * m.theta))


def zn_ultimate(ku: float, pu: float) -> Gains:
    """Ziegler-Nichols ultimate-cycle PID: 0.6 Ku, Pu / 2, Pu / 8."""
    kp = 0.6 * ku
    return Gains(kp, kp / (pu / 2.0), kp * (pu / 8.0))


def simc_pi(
    k: float, tau: float, theta: float, tauc: float | None = None
) -> Gains:
    """Skogestad's SIMC PI: Kp = tau / (k (tauc + theta)),
    Ti = min(tau, 4 (tauc + theta)); tauc defaults to theta."""
    if tauc is None:
        tauc = theta
    kp = tau / (k * (tauc + theta))
    ti = min(tau, 4.0 * (tauc + theta))
    return Gains(kp, kp / ti, 0.0)
```

几处设计：

- **`_cross` 用线性插值找交叉时间。** 采样周期是 1 ms 和 10 ms，$t_{28}$、$t_{63}$ 不会正好落在采样点上，不插值会引入最多一个采样周期的误差，对摩擦轮的 $\theta$（1.39 ms）这个误差就是 70%。
- **`fopdt_fit` 要求记录已经稳定。** 终值直接取最后一个采样点，不外推。我的摩擦轮阶跃记录 20 s，$\tau = 2$ s，是 10 倍时间常数；四阶对象记录 40 s，足够。
- **`Relay` 只在 $|e| > \epsilon$ 时翻转，初始状态是 $+d$。** 状态保存在对象里，$d$ 和 $\epsilon$ 是构造参数。
- **`relay_analyse` 的周期用最后三个周期的平均。** “上升沿”定义成 `u` 从非正变成正的那一个采样点，时间用 $e = r - y$ 穿过 $+\epsilon$ 的线性插值。幅值 $a$ 取最后一个周期里 $y$ 峰峰值的一半。**这个函数事后分析一份记录，不进控制回路**，所以没有状态机也没有就地更新。
- **`simc_pi` 的 `tauc` 默认是 `theta`。** 返回 `Gains(kp, ki, 0.0)`，$k_i = k_p/T_i$；三个函数返回同一种 `Gains`，所以后面可以直接喂给 `PidConfig`。

### 驱动

驱动 `python/ch06_tuning.py` 里有三条线：开环阶跃、继电器、闭环评估，都走第 5 篇的仿真合同（测量、控制器、限幅、延迟线、保持 10 个 RK4 子步）。核心是这几个函数：

```python
def simulate(spec: Spec, data: dict, ctrl) -> dict[str, np.ndarray]:
    """Closed or open loop in the contract's order. ctrl(k, r, y) -> u."""
    plant = spec.plant()
    delay = DelayLine(spec.delay)
    x = [0.0] * plant.n
    rows = []
    for k in range(len(data["t"])):
        r = data["r"][k]
        y = plant.output(x) + data["n"][k]
        u = ctrl(k, r, y)
        u = min(max(u, -spec.u_lim), spec.u_lim)
        rows.append([data["t"][k], r, y, u])
        x = advance(
            plant.deriv, x, [delay.push(u), data["d"][k]], spec.ts, SUBSTEPS
        )
    return dict(zip(COLUMNS, np.array(rows).T))


def run_step(spec: Spec) -> dict[str, np.ndarray]:
    data = read_csv(DATA / f"ch06_step_{spec.name}.csv")
    return simulate(spec, data, lambda k, r, y: data["u"][k])


def run_relay(spec: Spec) -> dict[str, np.ndarray]:
    data = read_csv(DATA / f"ch06_relay_{spec.name}.csv")
    relay = Relay(spec.relay_d, spec.relay_eps)
    return simulate(spec, data, lambda k, r, y: relay.update(r - y))


def eval_config(spec: Spec, g: Gains) -> PidConfig:
    return PidConfig(
        g.kp,
        g.ki,
        g.kd,
        spec.ts,
        tf=g.kd / g.kp / 10.0,
        u_min=-spec.u_lim,
        u_max=spec.u_lim,
        windup=Windup.CLAMP,
    )


def run_eval(spec: Spec, g: Gains) -> dict[str, np.ndarray]:
    data = read_csv(DATA / f"ch06_eval_{spec.name}.csv")
    pid = Pid(eval_config(spec, g))
    return simulate(spec, data, lambda k, r, y: pid.update(r, y))


def identify(spec: Spec) -> tuple[Fopdt, RelayResult]:
    st = load("step", spec.name)
    rl = load("relay", spec.name)
    fit = fopdt_fit(st["u"], st["y"], spec.ts)
    res = relay_analyse(
        rl["r"], rl["y"], rl["u"], spec.ts, spec.relay_eps, spec.relay_d
    )
    return fit, res


def rule_gains(fit: Fopdt, res: RelayResult) -> list[Gains]:
    return [
        zn_step(fit),
        zn_ultimate(res.ku, res.pu),
        simc_pi(fit.k, fit.tau, fit.theta),
    ]


def sensitivity(spec: Spec, g: Gains, ws) -> Margins:
    num, den = loop_polys(spec, g)
    return margins(num, den, spec.theta_loop, ws)


def evaluate(spec: Spec, o: dict) -> tuple[float, float, float]:
    """IAE after the setpoint step, IAE after the load step, overshoot %."""
    y, ts = o["y"], spec.ts
    sm = step_metrics(y[: spec.eval_load], ts, spec.eval_sp, spec.eval_r)
    iae_ld = 0.0
    for yi in y[spec.eval_load :]:
        iae_ld += abs(spec.eval_r - yi) * ts
    return sm.iae, iae_ld, sm.overshoot
```

`simulate` 把三种“控制器”收成一个 `ctrl(k, r, y) -> u` 回调：开环的回调从数据文件读 $u$，继电器的回调是 `relay.update(r - y)`，闭环的回调是 `pid.update(r, y)`。数据文件由 Python 生成（`numpy` 种子 6），包含阶跃时刻、负载、继电器测试里 $\sigma = 0.5$ rad/s 的测量噪声。`evaluate` 里的 `IAE_sp` 用第 2 篇的 `step_metrics` 在负载阶跃之前截断，`IAE_ld` 是负载阶跃之后 $|r - y|$ 的矩形和。

`sensitivity` 用 `freq` 模块在真实的对象多项式上算 $M_s$，控制器是 $C(s) = k_p + k_i/s + k_ds/(t_fs + 1)$ 在第 5 篇定义下的有理形式（`loop_polys`），延迟用 `theta_loop = (delay + 0.5)·ts`：传输延迟加半拍 ZOH。

完整驱动（含 `report` 里的断言和画图）折在这里：

<details>
<summary>完整源码：python/ch06_tuning.py</summary>

```python
#!/usr/bin/env python3
"""Chapter 6 driver: `ch06_tuning.py ref` then `report`."""

import cmath
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compare import compare_dir  # noqa: E402
from pidlab.freq import Margins, loop_eval, margins  # noqa: E402
from pidlab.io import read_csv, write_csv  # noqa: E402
from pidlab.metrics import step_metrics  # noqa: E402
from pidlab.pid import Pid, PidConfig, Windup  # noqa: E402
from pidlab.plants import Benchmark4, Flywheel  # noqa: E402
from pidlab.plotting import ROOT  # noqa: E402
from pidlab.poly import poly_mul  # noqa: E402
from pidlab.sim import DelayLine, advance  # noqa: E402
from pidlab.tuning import (  # noqa: E402
    Fopdt,
    Gains,
    Relay,
    RelayResult,
    fopdt_fit,
    relay_analyse,
    simc_pi,
    zn_step,
    zn_ultimate,
)

SUBSTEPS = 10
SEED = 6
OUT = ROOT / "out" / "ch06"
DATA = ROOT / "data"
RULES = ("zn_step", "zn_ultimate", "simc")
COLUMNS = ("t", "r", "y", "u")
W_COUNT = 3000


@dataclass(frozen=True)
class Spec:
    """One plant with its test and evaluation protocol."""

    name: str
    ts: float
    delay: int  # samples of command delay in the loop
    u_lim: float  # actuator clamp, +-
    step_s: float  # open-loop step: duration, start, size
    step_at: int
    step_du: float
    relay_s: float  # relay test: duration, amplitude, hysteresis, noise
    relay_d: float
    relay_eps: float
    relay_sigma: float
    eval_s: float  # closed-loop evaluation: duration
    eval_r: float
    eval_sp: int  # sample of the setpoint step
    eval_load: int  # sample of the load step
    eval_d: float

    @property
    def theta_loop(self) -> float:
        """Delay the sampled loop adds: transport plus the ZOH half."""
        return (self.delay + 0.5) * self.ts

    def plant(self):
        return Flywheel() if self.name == "flywheel" else Benchmark4()


SPECS = (
    Spec(
        "flywheel", 1e-3, 2, 20.0, 20.0, 10, 2.0,
        1.0, 10.0, 2.0, 0.5, 1.0, 300.0, 50, 500, 3.0,
    ),
    Spec(
        "benchmark4", 1e-2, 0, math.inf, 40.0, 100, 1.0,
        60.0, 1.0, 0.0, 0.0, 80.0, 1.0, 100, 4000, 1.0,
    ),
)  # fmt: skip


def plant_tf(spec: Spec) -> tuple[list[float], list[float]]:
    """Numerator and denominator of the true plant, no delay."""
    p = spec.plant()
    if spec.name == "flywheel":
        return [p.kt], poly_mul([p.j, p.b], [p.tau_c, 1.0])
    lag = [p.tau, 1.0]
    return [1.0], poly_mul(poly_mul(lag, lag), poly_mul(lag, lag))


def loop_polys(spec: Spec, g: Gains):
    """L(s) = C(s) G(s), with the D filter tf = Td / 10 of the eval."""
    tf = g.kd / g.kp / 10.0
    cn = [g.kp * tf + g.kd, g.kp + g.ki * tf, g.ki]
    cd = [tf, 1.0, 0.0]
    gn, gd = plant_tf(spec)
    return poly_mul(cn, gn), poly_mul(cd, gd)


def write_data() -> None:
    rng = np.random.default_rng(SEED)
    for s in SPECS:

        def table(dur, r=None, d=None, n=None, u=None):
            steps = round(dur / s.ts)
            k = np.arange(steps)
            col = lambda f: f(k) if f else np.zeros(steps)  # noqa: E731
            return {
                "t": k * s.ts,
                "r": col(r),
                "d": col(d),
                "n": col(n),
                "u": col(u),
            }

        write_csv(
            DATA / f"ch06_step_{s.name}.csv",
            table(s.step_s, u=lambda k: s.step_du * (k >= s.step_at)),
        )
        noise = rng.standard_normal(round(s.relay_s / s.ts)) * s.relay_sigma
        write_csv(
            DATA / f"ch06_relay_{s.name}.csv",
            table(s.relay_s, n=lambda k: noise),
        )
        write_csv(
            DATA / f"ch06_eval_{s.name}.csv",
            table(
                s.eval_s,
                r=lambda k: s.eval_r * (k >= s.eval_sp),
                d=lambda k: s.eval_d * (k >= s.eval_load),
            ),
        )
    write_csv(DATA / "ch06_w.csv", {"w": np.logspace(-2.0, 4.0, W_COUNT)})


def simulate(spec: Spec, data: dict, ctrl) -> dict[str, np.ndarray]:
    """Closed or open loop in the contract's order. ctrl(k, r, y) -> u."""
    plant = spec.plant()
    delay = DelayLine(spec.delay)
    x = [0.0] * plant.n
    rows = []
    for k in range(len(data["t"])):
        r = data["r"][k]
        y = plant.output(x) + data["n"][k]
        u = ctrl(k, r, y)
        u = min(max(u, -spec.u_lim), spec.u_lim)
        rows.append([data["t"][k], r, y, u])
        x = advance(
            plant.deriv, x, [delay.push(u), data["d"][k]], spec.ts, SUBSTEPS
        )
    return dict(zip(COLUMNS, np.array(rows).T))


def run_step(spec: Spec) -> dict[str, np.ndarray]:
    data = read_csv(DATA / f"ch06_step_{spec.name}.csv")
    return simulate(spec, data, lambda k, r, y: data["u"][k])


def run_relay(spec: Spec) -> dict[str, np.ndarray]:
    data = read_csv(DATA / f"ch06_relay_{spec.name}.csv")
    relay = Relay(spec.relay_d, spec.relay_eps)
    return simulate(spec, data, lambda k, r, y: relay.update(r - y))


def eval_config(spec: Spec, g: Gains) -> PidConfig:
    return PidConfig(
        g.kp,
        g.ki,
        g.kd,
        spec.ts,
        tf=g.kd / g.kp / 10.0,
        u_min=-spec.u_lim,
        u_max=spec.u_lim,
        windup=Windup.CLAMP,
    )


def run_eval(spec: Spec, g: Gains) -> dict[str, np.ndarray]:
    data = read_csv(DATA / f"ch06_eval_{spec.name}.csv")
    pid = Pid(eval_config(spec, g))
    return simulate(spec, data, lambda k, r, y: pid.update(r, y))


def identify(spec: Spec) -> tuple[Fopdt, RelayResult]:
    st = load("step", spec.name)
    rl = load("relay", spec.name)
    fit = fopdt_fit(st["u"], st["y"], spec.ts)
    res = relay_analyse(
        rl["r"], rl["y"], rl["u"], spec.ts, spec.relay_eps, spec.relay_d
    )
    return fit, res


def rule_gains(fit: Fopdt, res: RelayResult) -> list[Gains]:
    return [
        zn_step(fit),
        zn_ultimate(res.ku, res.pu),
        simc_pi(fit.k, fit.tau, fit.theta),
    ]


def sensitivity(spec: Spec, g: Gains, ws) -> Margins:
    num, den = loop_polys(spec, g)
    return margins(num, den, spec.theta_loop, ws)


def evaluate(spec: Spec, o: dict) -> tuple[float, float, float]:
    """IAE after the setpoint step, IAE after the load step, overshoot %."""
    y, ts = o["y"], spec.ts
    sm = step_metrics(y[: spec.eval_load], ts, spec.eval_sp, spec.eval_r)
    iae_ld = 0.0
    for yi in y[spec.eval_load :]:
        iae_ld += abs(spec.eval_r - yi) * ts
    return sm.iae, iae_ld, sm.overshoot


def ref() -> None:
    write_data()
    ws = read_csv(DATA / "ch06_w.csv")["w"]
    for spec in SPECS:
        write_csv(OUT / f"step_{spec.name}_py.csv", run_step(spec))
        write_csv(OUT / f"relay_{spec.name}_py.csv", run_relay(spec))
        fit, res = identify(spec)
        write_csv(
            OUT / f"ident_{spec.name}_py.csv",
            {
                "k": [fit.k],
                "tau": [fit.tau],
                "theta": [fit.theta],
                "ku": [res.ku],
                "pu": [res.pu],
                "a": [res.a],
            },
        )
        table = {
            n: [] for n in "rule kp ki kd iae_sp iae_ld overshoot ms".split()
        }
        for i, g in enumerate(rule_gains(fit, res)):
            o = run_eval(spec, g)
            write_csv(OUT / f"eval_{spec.name}_{RULES[i]}_py.csv", o)
            iae_sp, iae_ld, os = evaluate(spec, o)
            ms = sensitivity(spec, g, ws).ms
            row = (i, g.kp, g.ki, g.kd, iae_sp, iae_ld, os, ms)
            for name, v in zip(table, row):
                table[name].append(v)
        write_csv(OUT / f"tuning_{spec.name}_py.csv", table)


def load(kind: str, name: str) -> dict[str, np.ndarray]:
    return read_csv(OUT / f"{kind}_{name}_py.csv")


# ---- report ------------------------------------------------------------


def load_eval(spec: Spec, rule: str) -> dict[str, np.ndarray]:
    return read_csv(OUT / f"eval_{spec.name}_{rule}_py.csv")


def true_ultimate(spec: Spec, ws) -> tuple[float, float]:
    """Ku and Pu of P control on the true sampled plant (freq module)."""
    gn, gd = plant_tf(spec)
    mg = margins(gn, gd, spec.theta_loop, ws)
    return 10.0 ** (mg.gm_db / 20.0), 2.0 * math.pi / mg.w180


def phase_deg(z: complex) -> float:
    ph = math.degrees(cmath.phase(z))
    return ph - 360.0 if ph > 0.0 else ph


def report_ident(spec: Spec, fit: Fopdt, res: RelayResult, ws) -> None:
    p = spec.plant()
    print(f"\n--- {spec.name} ---")
    if spec.name == "flywheel":
        k_true, tau_true = p.kt / p.b, p.j / p.b
        theta_true = spec.delay * spec.ts + p.tau_c
        print(
            f"step fit  k = {fit.k:.2f} (Kt/b = {k_true:.2f})  "
            f"tau = {fit.tau:.4f} s (J/b = {tau_true:.4f})  "
            f"theta = {fit.theta * 1e3:.2f} ms "
            f"(delay + current lag = {theta_true * 1e3:.2f} ms)"
        )
        assert abs(fit.k / k_true - 1.0) < 1e-3
        assert abs(fit.tau / tau_true - 1.0) < 1e-3
    else:
        print(
            f"step fit  k = {fit.k:.4f}  tau = {fit.tau:.3f} s  "
            f"theta = {fit.theta:.3f} s"
        )
        assert abs(fit.k - 1.0) < 1e-6
    ku_t, pu_t = true_ultimate(spec, ws)
    print(
        f"relay     Ku = {res.ku:.3f}  Pu = {res.pu * 1e3:.2f} ms  "
        f"a = {res.a:.3f}"
        if spec.name == "flywheel"
        else f"relay     Ku = {res.ku:.3f}  Pu = {res.pu:.3f} s  "
        f"a = {res.a:.4f}"
    )
    print(f"true      Ku = {ku_t:.3f}  Pu = {pu_t:.5f} s (freq module)")
    w_osc = 2.0 * math.pi / res.pu
    gn, gd = plant_tf(spec)
    gj = loop_eval(gn, gd, spec.theta_loop, w_osc)
    a_pred = abs(gj) * 4.0 * spec.relay_d / math.pi
    print(
        f"harmonic balance: a = |G(jw)| 4d/pi = {a_pred:.4f} "
        f"(measured {res.a:.4f}); arg G(jw) = {phase_deg(gj):.1f} deg; "
        f"-180 + asin(eps/a) = "
        f"{-180.0 + math.degrees(math.asin(spec.relay_eps / res.a)):.1f}"
    )
    if spec.name == "benchmark4":
        assert abs(res.ku / ku_t - 1.0) < 0.05
        assert abs(res.pu / pu_t - 1.0) < 0.02
        assert abs(a_pred / res.a - 1.0) < 0.02
    else:
        assert res.ku < ku_t, "hysteresis should make Ku read low"


def report_tuning(spec: Spec, ws) -> dict:
    t = load("tuning", spec.name)
    print(
        f"{'rule':>12s} {'Kp':>8s} {'Ti':>9s} {'Td':>9s} {'IAE_sp':>8s} "
        f"{'IAE_ld':>8s} {'over %':>7s} {'Ms':>7s} {'PM':>6s}"
    )
    out = {}
    for i, rule in enumerate(RULES):
        g = Gains(t["kp"][i], t["ki"][i], t["kd"][i])
        pm = sensitivity(spec, g, ws).pm_deg
        ti, td = g.kp / g.ki, g.kd / g.kp
        out[rule] = {
            "iae_sp": t["iae_sp"][i],
            "iae_ld": t["iae_ld"][i],
            "os": t["overshoot"][i],
            "ms": t["ms"][i],
            "pm": pm,
        }
        print(
            f"{rule:>12s} {g.kp:8.3f} {ti:9.5f} {td:9.5f} "
            f"{t['iae_sp'][i]:8.4f} {t['iae_ld'][i]:8.4f} "
            f"{t['overshoot'][i]:7.2f} {t['ms'][i]:7.3f} {pm:6.1f}"
        )
    return out


def report_flywheel_claims(spec: Spec, res: dict, fit: Fopdt, ws) -> None:
    sp = [v["iae_sp"] for v in res.values()]
    spread = (max(sp) - min(sp)) / min(sp)
    print(
        f"IAE_sp spread over the three rules: {spread * 100:.3f} % "
        "(a 20 A clamp sets the ramp, not the gains)"
    )
    assert spread < 0.01
    o = load_eval(spec, "zn_step")
    tail = o["u"][spec.eval_load :]
    frac = float(np.mean(np.abs(tail) >= spec.u_lim - 1e-12))
    print(
        f"zn_step: PM = {res['zn_step']['pm']:.1f} deg, |u| at the 20 A "
        f"clamp in {frac * 100:.0f} % of the samples after the load step"
    )
    assert res["zn_step"]["pm"] < 0.0 and frac > 0.3
    p = spec.plant()
    print("SIMC on the same fit, tuned with different thetas:")
    rows = (
        ("fitted", fit.theta),
        ("delay + lag", spec.delay * spec.ts + p.tau_c),
        ("+ half ZOH", spec.theta_loop + p.tau_c),
    )
    ms = {}
    for name, theta in rows:
        g = simc_pi(fit.k, fit.tau, theta)
        ms[name] = sensitivity(spec, g, ws).ms
        print(
            f"  theta = {theta * 1e3:5.2f} ms ({name:>11s}): "
            f"Kp = {g.kp:6.3f}  Ms = {ms[name]:.2f}"
        )
    assert ms["fitted"] > 5.0 and ms["+ half ZOH"] < 2.5


def report_bench_claims(spec: Spec, res: dict, fit: Fopdt, ws) -> None:
    by = lambda k: min(res, key=lambda r: res[r][k])  # noqa: E731
    print(
        f"lowest IAE_sp: {by('iae_sp')}; lowest IAE_ld: {by('iae_ld')}; "
        f"lowest overshoot: {by('os')}; lowest Ms: {by('ms')}"
    )
    assert by("iae_sp") == "zn_step" and by("iae_ld") == "zn_ultimate"
    assert by("os") == "simc"
    assert max(res, key=lambda r: res[r]["ms"]) == "zn_ultimate"
    g = simc_pi(fit.k, fit.tau, fit.theta, 2.0 * fit.theta)
    ms = sensitivity(spec, g, ws).ms
    print(
        f"SIMC detuned to tauc = 2 theta: Kp = {g.kp:.3f}, Ms = {ms:.3f} "
        f"(tauc = theta: {res['simc']['ms']:.3f})"
    )
    assert ms < res["simc"]["ms"]


def report() -> None:
    if not compare_dir(OUT, 1e-9):
        sys.exit(1)
    ws = read_csv(DATA / "ch06_w.csv")["w"]
    results = {}
    for spec in SPECS:
        fit, res = identify(spec)
        report_ident(spec, fit, res, ws)
        results[spec.name] = (fit, res, report_tuning(spec, ws))
    report_flywheel_claims(
        SPECS[0], results["flywheel"][2], results["flywheel"][0], ws
    )
    report_bench_claims(
        SPECS[1], results["benchmark4"][2], results["benchmark4"][0], ws
    )
    plot_relay(results)
    plot_fit(results)
    plot_compare(SPECS[0], "tuning-compare-flywheel")
    plot_compare(SPECS[1], "tuning-compare-benchmark4")
    plot_ms_iae(results)
    print("\nch06 OK")


def rule_label(rule: str) -> str:
    from pidlab.plotting import L

    return {
        "zn_step": L("ZN 阶跃法", "ZN step"),
        "zn_ultimate": L("ZN 继电器法", "ZN relay"),
        "simc": "SIMC PI",
    }[rule]


COLORS = {"zn_step": "C0", "zn_ultimate": "C3", "simc": "C2"}


def plant_title(spec: Spec) -> str:
    from pidlab.plotting import L

    return L("摩擦轮", "Flywheel") if spec.name == "flywheel" else "1/(s+1)^4"


def plot_relay(results: dict) -> None:
    from pidlab.plotting import L, save
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 2, figsize=(10, 6))
    for j, spec in enumerate(SPECS):
        _, res, _ = results[spec.name]
        o = load("relay", spec.name)
        m = o["t"] >= o["t"][-1] - 5.0 * res.pu
        t = o["t"][m]
        ax = axes[0][j]
        ax.plot(t, o["y"][m])
        for sgn in (-1.0, 1.0):
            ax.axhline(sgn * res.a, color="k", ls=":", lw=1)
        ax.set_title(
            f"{plant_title(spec)}: Pu = {res.pu:.4g} s, a = {res.a:.3g}, "
            f"Ku = {res.ku:.3g}"
        )
        ax.set_ylabel(L("测量输出 y", "measured y"))
        ax = axes[1][j]
        ax.step(t, o["u"][m], where="post", color="C1")
        ax.set_ylabel(L("继电器输出 u", "relay output u"))
        ax.set_xlabel(L("时间 (s)", "time (s)"))
    save(fig, "ch06", "relay-oscillation")


def plot_fit(results: dict) -> None:
    from pidlab.plotting import L, save
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 2, figsize=(10, 6))
    for j, spec in enumerate(SPECS):
        fit, _, _ = results[spec.name]
        o = load("step", spec.name)
        k0 = spec.step_at
        y = o["y"][k0:]
        z = (y - y[0]) / (y[-1] - y[0])
        t = np.arange(len(z)) * spec.ts
        zf = np.where(
            t > fit.theta, 1.0 - np.exp(-(t - fit.theta) / fit.tau), 0.0
        )
        t63 = fit.theta + fit.tau
        t28 = t63 - fit.tau / 1.5
        zoom = 0.02 if spec.name == "flywheel" else 8.0
        for i, ax in enumerate(axes[:, j]):
            ax.plot(t, z, label=L("仿真数据", "simulated"))
            ax.plot(t, zf, "--", label=L("FOPDT 拟合", "FOPDT fit"))
            ax.plot([t28, t63], [0.283, 0.632], "ko", ms=4)
            if i == 1:
                ax.set_xlim(0.0, zoom)
                top = 0.0095 if spec.name == "flywheel" else 1.0
                ax.set_ylim(-0.0005 * top / 0.0095, top)
            else:
                ax.set_title(
                    f"{plant_title(spec)}: k = {fit.k:.3g}, "
                    f"tau = {fit.tau:.4g} s, theta = {fit.theta:.4g} s"
                )
            ax.set_xlabel(L("阶跃后时间 (s)", "time after step (s)"))
            ax.set_ylabel(L("归一化输出", "normalized output"))
        axes[0][j].legend()
    save(fig, "ch06", "fopdt-fit")


def plot_compare(spec: Spec, name: str) -> None:
    from pidlab.plotting import L, save
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 2, figsize=(10, 6))
    t_load = spec.eval_load * spec.ts
    if spec.name == "flywheel":
        zoom = (t_load - 0.01, t_load + 0.15)
    else:
        zoom = (t_load - 1.0, t_load + 20.0)
    for rule in RULES:
        o = load_eval(spec, rule)
        for col, key in ((0, "y"), (1, "u")):
            for zi in (0, 1):
                ax = axes[col][zi]
                ax.plot(
                    o["t"],
                    o[key],
                    color=COLORS[rule],
                    lw=1.2,
                    label=rule_label(rule),
                )
    for col, key in ((0, "y"), (1, "u")):
        axes[col][0].axvline(t_load, color="k", ls=":", lw=1)
        axes[col][1].set_xlim(*zoom)
        axes[col][0].set_ylabel(
            L("输出 y", "output y") if key == "y" else L("控制量 u", "u")
        )
        axes[col][1].set_ylabel(axes[col][0].get_ylabel())
    o = load_eval(spec, "simc")
    axes[0][0].plot(o["t"], o["r"], "k--", lw=0.8)
    axes[0][1].plot(o["t"], o["r"], "k--", lw=0.8)
    if spec.name == "flywheel":
        axes[0][1].set_ylim(spec.eval_r - 5.0, spec.eval_r + 3.0)
        axes[1][1].set_ylim(-22.0, 22.0)
    else:
        axes[0][1].set_ylim(0.3, 1.1)
    axes[0][0].legend()
    for ax in axes[1]:
        ax.set_xlabel(L("时间 (s)", "time (s)"))
    axes[0][1].set_title(L("负载阶跃附近放大", "zoom on the load step"))
    save(fig, "ch06", name)


def plot_ms_iae(results: dict) -> None:
    from matplotlib.ticker import NullFormatter, ScalarFormatter
    from pidlab.plotting import L, save
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(1, 2, figsize=(10, 4))
    for ax, spec in zip(axes, SPECS):
        res = results[spec.name][2]
        for rule in RULES:
            v = res[rule]
            unstable = v["pm"] < 0.0
            ax.plot(
                v["ms"],
                v["iae_ld"],
                "o",
                color=COLORS[rule],
                mfc="white" if unstable else COLORS[rule],
                ms=9,
            )
            note = L("（线性环不稳定）", " (linear loop unstable)")
            ax.annotate(
                rule_label(rule) + (note if unstable else ""),
                (v["ms"], v["iae_ld"]),
                xytext=(8, 8),
                textcoords="offset points",
            )
        ax.margins(0.25)
        if spec.name == "flywheel":
            ax.set_xscale("log")
            ax.set_yscale("log")
            ax.set_xticks([1.5, 2, 3, 5, 8, 12])
            ax.set_yticks([0.03, 0.05, 0.1, 0.2, 0.5])
            for axis in (ax.xaxis, ax.yaxis):
                axis.set_major_formatter(ScalarFormatter())
                axis.set_minor_formatter(NullFormatter())
        ax.set_title(plant_title(spec))
        ax.set_xlabel(L("灵敏度峰值 Ms", "peak sensitivity Ms"))
        ax.set_ylabel(L("负载 IAE", "load IAE"))
    save(fig, "ch06", "ms-vs-iae")


if __name__ == "__main__":
    {"ref": ref, "report": report}[sys.argv[1]]()
```

</details>

## C、C++、Rust 实现

三个版本都是 `tuning.py` 的逐行翻译，算术顺序一样，所以第 6 篇没有新的数值问题。区别在这几处：

- **输出参数。** C 没有多返回值，`pl_fopdt_fit`、`pl_relay_analyse` 返回 0 或 `-EINVAL`，结果写进调用方的结构体（`struct pl_fopdt`、`struct pl_relay_result`）；三个规则函数返回 `void`，写进 `struct pl_gains`。C++ 用 `std::optional<Fopdt<T>>` 和 `std::optional<RelayResult<T>>` 返回，规则函数直接返回 `Gains<T>`；Rust 是 `Option<Fopdt>` 和 `Option<RelayResult>`。Python 抛 `ValueError`，三种原生语言都没有异常，失败条件一样：没有阶跃、$\Delta y = 0$、$\tau\theta \le 0$、不到四个上升沿、$a = 0$。
- **输入是切片。** C 传 `const pl_real *` 加长度 `long n`；C++ 用 `std::span<const T>`；Rust 是 `&[Real]`。三个函数都不拷贝数据，不分配内存。
- **“滑动四个上升沿”。** Python 把所有上升沿存进列表再取最后几个；C、C++、Rust 的 `relay_analyse` 只保留最后四个（`idx[4]`、`tm[4]`，每来一个就移位）。这是为了不需要容量未知的数组，结果相同。
- **`simc_pi` 的默认 `tauc`。** C 用负数表示“用 $\theta$”（`pl_simc_pi(k, tau, theta, -1.0, &g)`）；C++ 是 `std::optional<T> tauc = std::nullopt`；Rust 的 `tauc: Option<Real>`，传 `None`。
- **$\pi$ 的写法。** C 的 `-std=c11 -Wpedantic` 没有 `M_PI`，我写了 `PL_PI` 常量；Rust 用 `core::f64::consts::PI` 转 `Real`。
- **类型。** `pl_real`、`T`、`Real` 都是标量开关，第 10 篇会用到 float32；这里没有写死 `double`。

### C

`pl_relay_analyse` 是这一篇最长的函数，上升沿用一个移位的 4 元窗口收集：

```c
int pl_relay_analyse(const pl_real *r, const pl_real *y, const pl_real *u,
		     long n, pl_real ts, pl_real eps, pl_real d,
		     struct pl_relay_result *out)
{
	pl_real tm[4] = { 0 }, lo, hi, a;
	long idx[4] = { 0 }, k;
	int cnt = 0, j;

	for (k = 1; k < n; k++) {
		pl_real e0, e1;

		if (!(u[k] > 0.0 && u[k - 1] <= 0.0))
			continue;
		e0 = r[k - 1] - y[k - 1];
		e1 = r[k] - y[k];
		for (j = 0; j < 3; j++) {
			idx[j] = idx[j + 1];
			tm[j] = tm[j + 1];
		}
		idx[3] = k;
		tm[3] = (k - 1 + (eps - e0) / (e1 - e0)) * ts;
		cnt++;
	}
	if (cnt < 4)
		return -EINVAL;
	lo = y[idx[2]];
	hi = lo;
	for (k = idx[2]; k < idx[3]; k++) {
		lo = y[k] < lo ? y[k] : lo;
		hi = y[k] > hi ? y[k] : hi;
	}
	a = (hi - lo) / 2.0;
	if (!(a > 0.0))
		return -EINVAL;
	out->pu = (tm[3] - tm[0]) / 3.0;
	out->a = a;
	out->ku = 4.0 * d / (PL_PI * a);
	return 0;
}
```

SIMC 只有几行。注意 `tauc < 0.0` 是“默认”的标记，而 $\tau_c = 0$ 是合法值（对应 $T_i = \min(\tau, 4\theta)$）：

```c
void pl_simc_pi(pl_real k, pl_real tau, pl_real theta, pl_real tauc,
		struct pl_gains *g)
{
	pl_real ti, lim;

	if (tauc < 0.0)
		tauc = theta;
	lim = 4.0 * (tauc + theta);
	g->kp = tau / (k * (tauc + theta));
	ti = tau < lim ? tau : lim;
	g->ki = g->kp / ti;
	g->kd = 0.0;
}
```

驱动：[`c/apps/ch06.c`](https://github.com/bfmhno3/pid-lab/tree/tutorial-v1/c/apps/ch06.c)。`simulate` 里三种模式用一个 `enum mode` 和一个 `void *ctl` 分派，不用函数指针回调；闭环用的 `struct pl_pid` 和继电器 `struct pl_relay` 都放在调用方的栈上。

<details>
<summary>完整源码：c/include/pl/tuning.h</summary>

```c
/* SPDX-License-Identifier: MIT OR Apache-2.0 */
/* Plant identification and PID tuning rules. Gains are parallel form: */
/* u = kp e + ki int(e) + kd de/dt. */
#ifndef PL_TUNING_H
#define PL_TUNING_H

#include "pl/real.h"

/* k exp(-theta s) / (tau s + 1). */
struct pl_fopdt {
	pl_real k, tau, theta;
};

struct pl_gains {
	pl_real kp, ki, kd;
};

/* Ultimate gain and period, and the oscillation amplitude of y. */
struct pl_relay_result {
	pl_real ku, pu, a;
};

/* Two-level relay with hysteresis: output +-d, flips when |e| > eps. */
struct pl_relay {
	pl_real d, eps;
	int state;
};

/* Two-point fit of a recorded open-loop step. The step is the first */
/* sample where u differs from u[0]; the final value is y[n - 1], so the */
/* record must have settled. t28 and t63 are the times to 28.3 % and */
/* 63.2 % of the change, tau = 1.5 (t63 - t28), theta = t63 - tau. */
/* Returns 0, or -EINVAL for no step, no change or no usable delay. */
int pl_fopdt_fit(const pl_real *u, const pl_real *y, long n, pl_real ts,
		 struct pl_fopdt *out);

void pl_relay_init(struct pl_relay *rl, pl_real d, pl_real eps);

/* One sample of the relay on the error e = r - y. */
pl_real pl_relay_update(struct pl_relay *rl, pl_real e);

/* Ku and Pu from a recorded relay experiment. An upward switch is a */
/* sample where u turns positive, timed by interpolating e = r - y */
/* through +eps. Pu is the mean of the last three periods between */
/* upward switches, a the half peak-to-peak of y over the last period, */
/* Ku = 4 d / (pi a). Returns 0, or -EINVAL for fewer than four upward */
/* switches or a = 0. */
int pl_relay_analyse(const pl_real *r, const pl_real *y, const pl_real *u,
		     long n, pl_real ts, pl_real eps, pl_real d,
		     struct pl_relay_result *out);

/* Ziegler-Nichols reaction curve: 1.2 tau / (k theta), 2 theta, theta / 2. */
void pl_zn_step(const struct pl_fopdt *m, struct pl_gains *g);

/* Ziegler-Nichols ultimate cycle: 0.6 Ku, Pu / 2, Pu / 8. */
void pl_zn_ultimate(pl_real ku, pl_real pu, struct pl_gains *g);

/* Skogestad's SIMC PI: Kp = tau / (k (tauc + theta)), */
/* Ti = min(tau, 4 (tauc + theta)). A negative tauc means tauc = theta. */
void pl_simc_pi(pl_real k, pl_real tau, pl_real theta, pl_real tauc,
		struct pl_gains *g);

#endif /* PL_TUNING_H */
```

</details>

<details>
<summary>完整源码：c/src/tuning.c</summary>

```c
// SPDX-License-Identifier: MIT OR Apache-2.0
#include "pl/tuning.h"

#include <errno.h>

#define PL_PI 3.14159265358979323846
#define T28 0.283
#define T63 0.632

/* First time (y - y0) / dy reaches level, interpolated; NaN if never. */
static pl_real cross(const pl_real *y, long n, long k0, pl_real y0,
		     pl_real dy, pl_real level, pl_real ts)
{
	long i;

	for (i = 1; i < n - k0; i++) {
		pl_real zi = (y[k0 + i] - y0) / dy;
		pl_real zp, frac;

		if (zi >= level) {
			zp = (y[k0 + i - 1] - y0) / dy;
			frac = (level - zp) / (zi - zp);
			return (i - 1 + frac) * ts;
		}
	}
	return NAN;
}

int pl_fopdt_fit(const pl_real *u, const pl_real *y, long n, pl_real ts,
		 struct pl_fopdt *out)
{
	pl_real du, y0, dy, t28, t63, tau, theta;
	long k0 = 0;

	while (k0 < n && u[k0] == u[0])
		k0++;
	if (k0 >= n)
		return -EINVAL;
	du = u[k0] - u[0];
	y0 = y[k0];
	dy = y[n - 1] - y0;
	if (dy == 0.0)
		return -EINVAL;
	t28 = cross(y, n, k0, y0, dy, T28, ts);
	t63 = cross(y, n, k0, y0, dy, T63, ts);
	tau = 1.5 * (t63 - t28);
	theta = t63 - tau;
	if (!(tau > 0.0 && theta > 0.0))
		return -EINVAL;
	out->k = dy / du;
	out->tau = tau;
	out->theta = theta;
	return 0;
}

void pl_relay_init(struct pl_relay *rl, pl_real d, pl_real eps)
{
	rl->d = d;
	rl->eps = eps;
	rl->state = 1;
}

pl_real pl_relay_update(struct pl_relay *rl, pl_real e)
{
	if (rl->state > 0 && e < -rl->eps)
		rl->state = -1;
	else if (rl->state < 0 && e > rl->eps)
		rl->state = 1;
	return rl->state * rl->d;
}

int pl_relay_analyse(const pl_real *r, const pl_real *y, const pl_real *u,
		     long n, pl_real ts, pl_real eps, pl_real d,
		     struct pl_relay_result *out)
{
	pl_real tm[4] = { 0 }, lo, hi, a;
	long idx[4] = { 0 }, k;
	int cnt = 0, j;

	for (k = 1; k < n; k++) {
		pl_real e0, e1;

		if (!(u[k] > 0.0 && u[k - 1] <= 0.0))
			continue;
		e0 = r[k - 1] - y[k - 1];
		e1 = r[k] - y[k];
		for (j = 0; j < 3; j++) {
			idx[j] = idx[j + 1];
			tm[j] = tm[j + 1];
		}
		idx[3] = k;
		tm[3] = (k - 1 + (eps - e0) / (e1 - e0)) * ts;
		cnt++;
	}
	if (cnt < 4)
		return -EINVAL;
	lo = y[idx[2]];
	hi = lo;
	for (k = idx[2]; k < idx[3]; k++) {
		lo = y[k] < lo ? y[k] : lo;
		hi = y[k] > hi ? y[k] : hi;
	}
	a = (hi - lo) / 2.0;
	if (!(a > 0.0))
		return -EINVAL;
	out->pu = (tm[3] - tm[0]) / 3.0;
	out->a = a;
	out->ku = 4.0 * d / (PL_PI * a);
	return 0;
}

void pl_zn_step(const struct pl_fopdt *m, struct pl_gains *g)
{
	g->kp = 1.2 * m->tau / (m->k * m->theta);
	g->ki = g->kp / (2.0 * m->theta);
	g->kd = g->kp * (0.5 * m->theta);
}

void pl_zn_ultimate(pl_real ku, pl_real pu, struct pl_gains *g)
{
	g->kp = 0.6 * ku;
	g->ki = g->kp / (pu / 2.0);
	g->kd = g->kp * (pu / 8.0);
}

void pl_simc_pi(pl_real k, pl_real tau, pl_real theta, pl_real tauc,
		struct pl_gains *g)
{
	pl_real ti, lim;

	if (tauc < 0.0)
		tauc = theta;
	lim = 4.0 * (tauc + theta);
	g->kp = tau / (k * (tauc + theta));
	ti = tau < lim ? tau : lim;
	g->ki = g->kp / ti;
	g->kd = 0.0;
}
```

</details>

### C++

继电器是一个有状态的小类，`Update(e)` 一拍一次；`SimcPi` 的 `tauc` 用 `std::optional`。事后分析的函数是自由函数模板，输入是 `std::span`：

```cpp
template <class T = double>
class Relay {
 public:
  Relay(T d, T eps) : d_(d), eps_(eps) {}

  // One sample of the relay on the error e = r - y.
  T Update(T e) {
    if (state_ > 0 && e < -eps_) {
      state_ = -1;
    } else if (state_ < 0 && e > eps_) {
      state_ = 1;
    }
    return T(state_) * d_;
  }

 private:
  T d_, eps_;
  int state_ = 1;
};
```

```cpp
// Skogestad's SIMC PI: Kp = tau / (k (tauc + theta)),
// Ti = min(tau, 4 (tauc + theta)). tauc defaults to theta.
template <class T>
Gains<T> SimcPi(T k, T tau, T theta, std::optional<T> tauc = std::nullopt) {
  const T tc = tauc.value_or(theta);
  const T lim = T(4) * (tc + theta);
  const T kp = tau / (k * (tc + theta));
  const T ti = tau < lim ? tau : lim;
  return {kp, kp / ti, T(0)};
}
```

驱动：[`cpp/apps/ch06.cc`](https://github.com/bfmhno3/pid-lab/tree/tutorial-v1/cpp/apps/ch06.cc)。

<details>
<summary>完整源码：cpp/include/pidlab/tuning.h</summary>

```cpp
// Plant identification and PID tuning rules. Gains are parallel form:
// u = kp e + ki int(e) + kd de/dt.
#ifndef PIDLAB_TUNING_H_
#define PIDLAB_TUNING_H_

#include <array>
#include <cmath>
#include <cstddef>
#include <limits>
#include <optional>
#include <span>

namespace pidlab {

// k exp(-theta s) / (tau s + 1).
template <class T = double>
struct Fopdt {
  T k, tau, theta;
};

template <class T = double>
struct Gains {
  T kp, ki, kd;
};

// Ultimate gain and period, and the oscillation amplitude of y.
template <class T = double>
struct RelayResult {
  T ku, pu, a;
};

namespace internal {

inline constexpr double kT28 = 0.283;  // the two points of the step fit
inline constexpr double kT63 = 0.632;

// First time (y - y0) / dy reaches level, interpolated; NaN if never.
template <class T>
T CrossTime(std::span<const T> y, std::size_t k0, T y0, T dy, T level, T ts) {
  for (std::size_t i = 1; i < y.size() - k0; ++i) {
    const T zi = (y[k0 + i] - y0) / dy;
    if (zi >= level) {
      const T zp = (y[k0 + i - 1] - y0) / dy;
      const T frac = (level - zp) / (zi - zp);
      return (T(i) - T(1) + frac) * ts;
    }
  }
  return std::numeric_limits<T>::quiet_NaN();
}

}  // namespace internal

// Two-point fit of a recorded open-loop step. The step is the first sample
// where u differs from u[0]; the final value is y.back(), so the record
// must have settled. t28 and t63 are the times to 28.3 % and 63.2 % of the
// change, tau = 1.5 (t63 - t28), theta = t63 - tau. Returns std::nullopt
// for no step, no change or no usable delay.
template <class T>
std::optional<Fopdt<T>> FitFopdt(std::span<const T> u, std::span<const T> y,
                                 T ts) {
  std::size_t k0 = 0;
  while (k0 < u.size() && u[k0] == u[0]) ++k0;
  if (k0 >= u.size() || y.size() != u.size()) return std::nullopt;
  const T du = u[k0] - u[0];
  const T y0 = y[k0];
  const T dy = y.back() - y0;
  if (dy == T(0)) return std::nullopt;
  const T t28 = internal::CrossTime(y, k0, y0, dy, T(internal::kT28), ts);
  const T t63 = internal::CrossTime(y, k0, y0, dy, T(internal::kT63), ts);
  const T tau = T(1.5) * (t63 - t28);
  const T theta = t63 - tau;
  if (!(tau > T(0) && theta > T(0))) return std::nullopt;
  return Fopdt<T>{dy / du, tau, theta};
}

// Two-level relay with hysteresis: output +-d, flips when |e| > eps.
template <class T = double>
class Relay {
 public:
  Relay(T d, T eps) : d_(d), eps_(eps) {}

  // One sample of the relay on the error e = r - y.
  T Update(T e) {
    if (state_ > 0 && e < -eps_) {
      state_ = -1;
    } else if (state_ < 0 && e > eps_) {
      state_ = 1;
    }
    return T(state_) * d_;
  }

 private:
  T d_, eps_;
  int state_ = 1;
};

// Ku and Pu from a recorded relay experiment. An upward switch is a sample
// where u turns positive, timed by interpolating e = r - y through +eps. Pu
// is the mean of the last three periods between upward switches, a the half
// peak-to-peak of y over the last period, Ku = 4 d / (pi a). Returns
// std::nullopt for fewer than four upward switches or a = 0.
template <class T>
std::optional<RelayResult<T>> AnalyseRelay(std::span<const T> r,
                                           std::span<const T> y,
                                           std::span<const T> u, T ts, T eps,
                                           T d) {
  constexpr T kPi = T(3.14159265358979323846);
  std::array<std::size_t, 4> idx{};
  std::array<T, 4> tm{};
  int count = 0;
  for (std::size_t k = 1; k < u.size(); ++k) {
    if (!(u[k] > T(0) && u[k - 1] <= T(0))) continue;
    const T e0 = r[k - 1] - y[k - 1];
    const T e1 = r[k] - y[k];
    for (int j = 0; j < 3; ++j) {
      idx[j] = idx[j + 1];
      tm[j] = tm[j + 1];
    }
    idx[3] = k;
    tm[3] = (T(k) - T(1) + (eps - e0) / (e1 - e0)) * ts;
    ++count;
  }
  if (count < 4) return std::nullopt;
  T lo = y[idx[2]];
  T hi = lo;
  for (std::size_t k = idx[2]; k < idx[3]; ++k) {
    lo = y[k] < lo ? y[k] : lo;
    hi = y[k] > hi ? y[k] : hi;
  }
  const T a = (hi - lo) / T(2);
  if (!(a > T(0))) return std::nullopt;
  return RelayResult<T>{T(4) * d / (kPi * a), (tm[3] - tm[0]) / T(3), a};
}

// Ziegler-Nichols reaction curve: 1.2 tau / (k theta), 2 theta, theta / 2.
template <class T>
Gains<T> ZnStep(const Fopdt<T>& m) {
  const T kp = T(1.2) * m.tau / (m.k * m.theta);
  return {kp, kp / (T(2) * m.theta), kp * (T(0.5) * m.theta)};
}

// Ziegler-Nichols ultimate cycle: 0.6 Ku, Pu / 2, Pu / 8.
template <class T>
Gains<T> ZnUltimate(T ku, T pu) {
  const T kp = T(0.6) * ku;
  return {kp, kp / (pu / T(2)), kp * (pu / T(8))};
}

// Skogestad's SIMC PI: Kp = tau / (k (tauc + theta)),
// Ti = min(tau, 4 (tauc + theta)). tauc defaults to theta.
template <class T>
Gains<T> SimcPi(T k, T tau, T theta, std::optional<T> tauc = std::nullopt) {
  const T tc = tauc.value_or(theta);
  const T lim = T(4) * (tc + theta);
  const T kp = tau / (k * (tc + theta));
  const T ti = tau < lim ? tau : lim;
  return {kp, kp / ti, T(0)};
}

}  // namespace pidlab

#endif  // PIDLAB_TUNING_H_
```

</details>

### Rust

Rust 版的上升沿窗口用 `copy_within(1.., 0)` 移位；峰峰值用 `fold` 而不是 `iter().min()`，因为 `f64` 没有全序，不能直接 `min`：

```rust
/// `Ku` and `Pu` from a recorded relay experiment. An upward switch is a
/// sample where `u` turns positive, timed by interpolating `e = r - y`
/// through `+eps`. `Pu` is the mean of the last three periods between upward
/// switches, `a` the half peak-to-peak of `y` over the last period,
/// `Ku = 4 d / (pi a)`. Returns `None` for fewer than four upward switches
/// or `a = 0`.
pub fn relay_analyse(
    r: &[Real],
    y: &[Real],
    u: &[Real],
    ts: Real,
    eps: Real,
    d: Real,
) -> Option<RelayResult> {
    let mut idx = [0usize; 4];
    let mut tm = [0.0; 4];
    let mut count = 0;
    for k in 1..u.len() {
        if !(u[k] > 0.0 && u[k - 1] <= 0.0) {
            continue;
        }
        let e0 = r[k - 1] - y[k - 1];
        let e1 = r[k] - y[k];
        idx.copy_within(1.., 0);
        tm.copy_within(1.., 0);
        idx[3] = k;
        tm[3] = ((k - 1) as Real + (eps - e0) / (e1 - e0)) * ts;
        count += 1;
    }
    if count < 4 {
        return None;
    }
    let seg = &y[idx[2]..idx[3]];
    let lo = seg.iter().fold(seg[0], |m, &v| if v < m { v } else { m });
    let hi = seg.iter().fold(seg[0], |m, &v| if v > m { v } else { m });
    let a = (hi - lo) / 2.0;
    if a.is_nan() || a <= 0.0 {
        return None;
    }
    Some(RelayResult {
        ku: 4.0 * d / (PI * a),
        pu: (tm[3] - tm[0]) / 3.0,
        a,
    })
}
```

```rust
/// Skogestad's SIMC PI: `Kp = tau / (k (tauc + theta))`,
/// `Ti = min(tau, 4 (tauc + theta))`. `tauc = None` means `tauc = theta`.
pub fn simc_pi(k: Real, tau: Real, theta: Real, tauc: Option<Real>) -> Gains {
    let tc = tauc.unwrap_or(theta);
    let lim = 4.0 * (tc + theta);
    let kp = tau / (k * (tc + theta));
    let ti = if tau < lim { tau } else { lim };
    Gains {
        kp,
        ki: kp / ti,
        kd: 0.0,
    }
}
```

驱动：[`rust/src/bin/ch06.rs`](https://github.com/bfmhno3/pid-lab/tree/tutorial-v1/rust/src/bin/ch06.rs)。

<details>
<summary>完整源码：rust/src/tuning.rs</summary>

```rust
//! Plant identification and PID tuning rules. Gains are parallel form:
//! `u = kp e + ki int(e) + kd de/dt`.

use core::f64::consts::PI as PI64;

use crate::real::Real;

const PI: Real = PI64 as Real;
/// The two points of the step-response fit.
const T28: Real = 0.283;
const T63: Real = 0.632;

/// `k exp(-theta s) / (tau s + 1)`.
#[derive(Debug, Clone, Copy)]
pub struct Fopdt {
    pub k: Real,
    pub tau: Real,
    pub theta: Real,
}

#[derive(Debug, Clone, Copy)]
pub struct Gains {
    pub kp: Real,
    pub ki: Real,
    pub kd: Real,
}

/// Ultimate gain and period, and the oscillation amplitude of `y`.
#[derive(Debug, Clone, Copy)]
pub struct RelayResult {
    pub ku: Real,
    pub pu: Real,
    pub a: Real,
}

/// First time `(y - y0) / dy` reaches `level`, interpolated; NaN if never.
fn cross(y: &[Real], k0: usize, y0: Real, dy: Real, level: Real, ts: Real) -> Real {
    for i in 1..y.len() - k0 {
        let zi = (y[k0 + i] - y0) / dy;
        if zi >= level {
            let zp = (y[k0 + i - 1] - y0) / dy;
            let frac = (level - zp) / (zi - zp);
            return ((i - 1) as Real + frac) * ts;
        }
    }
    Real::NAN
}

/// Two-point fit of a recorded open-loop step. The step is the first sample
/// where `u` differs from `u[0]`; the final value is the last sample of
/// `y`, so the record must have settled. `t28` and `t63` are the times to
/// 28.3 % and 63.2 % of the change, `tau = 1.5 (t63 - t28)`,
/// `theta = t63 - tau`. Returns `None` for no step, no change or no usable
/// delay.
pub fn fopdt_fit(u: &[Real], y: &[Real], ts: Real) -> Option<Fopdt> {
    let k0 = u.iter().position(|&v| v != u[0])?;
    if y.len() != u.len() {
        return None;
    }
    let du = u[k0] - u[0];
    let y0 = y[k0];
    let dy = y[y.len() - 1] - y0;
    if dy == 0.0 {
        return None;
    }
    let t28 = cross(y, k0, y0, dy, T28, ts);
    let t63 = cross(y, k0, y0, dy, T63, ts);
    let tau = 1.5 * (t63 - t28);
    let theta = t63 - tau;
    if !(tau > 0.0 && theta > 0.0) {
        return None;
    }
    Some(Fopdt {
        k: dy / du,
        tau,
        theta,
    })
}

/// Two-level relay with hysteresis: output `+-d`, flips when `|e| > eps`.
pub struct Relay {
    d: Real,
    eps: Real,
    state: i32,
}

impl Relay {
    pub fn new(d: Real, eps: Real) -> Self {
        Self { d, eps, state: 1 }
    }

    /// One sample of the relay on the error `e = r - y`.
    pub fn update(&mut self, e: Real) -> Real {
        if self.state > 0 && e < -self.eps {
            self.state = -1;
        } else if self.state < 0 && e > self.eps {
            self.state = 1;
        }
        self.state as Real * self.d
    }
}

/// `Ku` and `Pu` from a recorded relay experiment. An upward switch is a
/// sample where `u` turns positive, timed by interpolating `e = r - y`
/// through `+eps`. `Pu` is the mean of the last three periods between upward
/// switches, `a` the half peak-to-peak of `y` over the last period,
/// `Ku = 4 d / (pi a)`. Returns `None` for fewer than four upward switches
/// or `a = 0`.
pub fn relay_analyse(
    r: &[Real],
    y: &[Real],
    u: &[Real],
    ts: Real,
    eps: Real,
    d: Real,
) -> Option<RelayResult> {
    let mut idx = [0usize; 4];
    let mut tm = [0.0; 4];
    let mut count = 0;
    for k in 1..u.len() {
        if !(u[k] > 0.0 && u[k - 1] <= 0.0) {
            continue;
        }
        let e0 = r[k - 1] - y[k - 1];
        let e1 = r[k] - y[k];
        idx.copy_within(1.., 0);
        tm.copy_within(1.., 0);
        idx[3] = k;
        tm[3] = ((k - 1) as Real + (eps - e0) / (e1 - e0)) * ts;
        count += 1;
    }
    if count < 4 {
        return None;
    }
    let seg = &y[idx[2]..idx[3]];
    let lo = seg.iter().fold(seg[0], |m, &v| if v < m { v } else { m });
    let hi = seg.iter().fold(seg[0], |m, &v| if v > m { v } else { m });
    let a = (hi - lo) / 2.0;
    if a.is_nan() || a <= 0.0 {
        return None;
    }
    Some(RelayResult {
        ku: 4.0 * d / (PI * a),
        pu: (tm[3] - tm[0]) / 3.0,
        a,
    })
}

/// Ziegler-Nichols reaction curve: `1.2 tau / (k theta)`, `2 theta`,
/// `theta / 2`.
pub fn zn_step(m: &Fopdt) -> Gains {
    let kp = 1.2 * m.tau / (m.k * m.theta);
    Gains {
        kp,
        ki: kp / (2.0 * m.theta),
        kd: kp * (0.5 * m.theta),
    }
}

/// Ziegler-Nichols ultimate cycle: `0.6 Ku`, `Pu / 2`, `Pu / 8`.
pub fn zn_ultimate(ku: Real, pu: Real) -> Gains {
    let kp = 0.6 * ku;
    Gains {
        kp,
        ki: kp / (pu / 2.0),
        kd: kp * (pu / 8.0),
    }
}

/// Skogestad's SIMC PI: `Kp = tau / (k (tauc + theta))`,
/// `Ti = min(tau, 4 (tauc + theta))`. `tauc = None` means `tauc = theta`.
pub fn simc_pi(k: Real, tau: Real, theta: Real, tauc: Option<Real>) -> Gains {
    let tc = tauc.unwrap_or(theta);
    let lim = 4.0 * (tc + theta);
    let kp = tau / (k * (tc + theta));
    let ti = if tau < lim { tau } else { lim };
    Gains {
        kp,
        ki: kp / ti,
        kd: 0.0,
    }
}
```

</details>

### 编译和风格检查

编译参数和前几篇一样：C 是 `gcc -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror`（15.3.0），C++ 是 `g++ -std=c++20` 加同样的警告，Rust 是 rustc 1.95.0、edition 2024，`cargo clippy --release -- -D warnings`（0.1.95）。风格检查：C 用内核的 `checkpatch.pl`（`--no-tree`，忽略 SPDX 和 typedef 两项），0 errors、0 warnings；C++ 用 clang-format 21.1.8 的 Google 风格；Python 用 `ruff format --check` 和 `ruff check`，行宽 79；Rust 用 `cargo fmt --check`。四项都在提交前过了。

## 结果

`make ch06` 一次跑完。每种语言 14 个文件，42 个对比文件；下面的输出把中间的 `ok` 行裁掉了，只留头尾，其余的 `max diff` 都是 0 或 $10^{-16}$ 量级（最大的一个是 `tuning_flywheel_rs.csv` 的 $2.2\times10^{-16}$）：

```text
$ make -s ch06
ch06: C wrote 2 plants to out/ch06
ch06: C++ wrote 2 plants to out/ch06
ch06: Rust wrote 2 plants to out/ch06
ok   eval_benchmark4_simc_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   eval_benchmark4_simc_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   eval_benchmark4_simc_rs.csv: max diff 0.000e+00 <= 1.0e-09
... （中间 33 行 ok 省略）
ok   tuning_benchmark4_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   tuning_benchmark4_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   tuning_benchmark4_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   tuning_flywheel_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   tuning_flywheel_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   tuning_flywheel_rs.csv: max diff 2.220e-16 <= 1.0e-09

--- flywheel ---
step fit  k = 78.11 (Kt/b = 78.11)  tau = 2.0008 s (J/b = 2.0000)  theta = 1.39 ms (delay + current lag = 3.00 ms)
relay     Ku = 4.805  Pu = 31.63 ms  a = 2.650
true      Ku = 12.872  Pu = 0.01374 s (freq module)
harmonic balance: a = |G(jw)| 4d/pi = 2.4552 (measured 2.6496); arg G(jw) = -129.5 deg; -180 + asin(eps/a) = -131.0
        rule       Kp        Ti        Td   IAE_sp   IAE_ld  over %      Ms     PM
     zn_step   22.104   0.00278   0.00070  62.7667   0.5093    0.46   1.304  -48.7
 zn_ultimate    2.883   0.01581   0.00395  62.7824   0.0376    0.78   1.633   61.7
        simc    9.210   0.01113   0.00000  62.7615   0.0307    0.30  12.405    6.2

--- benchmark4 ---
step fit  k = 1.0000  tau = 2.497 s  theta = 1.855 s
relay     Ku = 3.913  Pu = 6.340 s  a = 0.3254
true      Ku = 3.980  Pu = 6.29887 s (freq module)
harmonic balance: a = |G(jw)| 4d/pi = 0.3241 (measured 0.3254); arg G(jw) = -179.3 deg; -180 + asin(eps/a) = -180.0
        rule       Kp        Ti        Td   IAE_sp   IAE_ld  over %      Ms     PM
     zn_step    1.616   3.70909   0.92727   3.0187   2.2958   11.26   1.626   66.7
 zn_ultimate    2.348   3.17000   0.79250   3.3231   1.3772   36.16   2.166   41.3
        simc    0.673   2.49677   0.00000   4.1331   3.7464    6.80   1.628   62.0
IAE_sp spread over the three rules: 0.033 % (a 20 A clamp sets the ramp, not the gains)
zn_step: PM = -48.7 deg, |u| at the 20 A clamp in 41 % of the samples after the load step
SIMC on the same fit, tuned with different thetas:
  theta =  1.39 ms (     fitted): Kp =  9.210  Ms = 12.40
  theta =  3.00 ms (delay + lag): Kp =  4.269  Ms = 1.85
  theta =  3.50 ms ( + half ZOH): Kp =  3.659  Ms = 1.66
lowest IAE_sp: zn_step; lowest IAE_ld: zn_ultimate; lowest overshoot: simc; lowest Ms: zn_step
SIMC detuned to tauc = 2 theta: Kp = 0.449, Ms = 1.373 (tauc = theta: 1.628)
figure: figures/ch06/relay-oscillation.svg
figure: figures/ch06/fopdt-fit.svg
figure: figures/ch06/tuning-compare-flywheel.svg
figure: figures/ch06/tuning-compare-benchmark4.svg
figure: figures/ch06/ms-vs-iae.svg

ch06 OK
```

### 阶跃拟合

先看拟合。摩擦轮：

![两点法拟合：摩擦轮的整条阶跃响应几乎和一阶加延迟曲线重合，放大前 20 ms 能看到拟合的延迟比真实响应起步早；四阶对象的拟合在两个取样点之间贴合，两头不贴](/assets/images/pid-control/ch06-fopdt-fit.svg)

摩擦轮的 $k = 78.11$，和 $K_t/b = 78.11$ 一致；$\tau = 2.0008$ s，和 $J/b = 2.0000$ 一致（`report` 里断言相对误差小于 $10^{-3}$）。**延迟对不上：拟合给出 $\theta = 1.39$ ms，而 2 拍传输延迟加 1 ms 电流环是 3.00 ms。** 图下半是放大 20 ms 的视图：真实响应（蓝）在 2 ms 之前几乎不动，然后是缓慢的抛物线起步（电流环的二阶效应），而拟合（橙）在 1.39 ms 就开始直线上升。差的 1.61 ms 和前面手算的取整误差 1.7 ms 是同一个量级，所以我猜这就是主要原因，没有进一步分解（我没有试过用更精确的 0.2833 和 0.6321 重新算，看是不是整整消掉）。

四阶对象：$k = 1.0000$，$\tau = 2.497$ s，$\theta = 1.855$ s（图右）。真实响应是一条 S 形曲线，FOPDT 在 $t_{28}$ 和 $t_{63}$ 两个点之间贴得很好，但头部（拟合有一个硬的延迟，真实曲线是缓慢起步）和尾部（拟合比真实响应慢）都不贴。这是模型本身的限制，不是拟合方法的毛病：四个重合极点用一个极点加延迟代替，必然损失。

### 继电器

![继电器实验：上排是测量输出，下排是继电器输出；摩擦轮（左）的输出有噪声，幅值 2.65，周期 31.6 ms；四阶对象（右）的输出是干净的正弦，幅值 0.325，周期 6.34 s，继电器输出是方波](/assets/images/pid-control/ch06-relay-oscillation.svg)

四阶对象（右）：继电器 $d = 1$，没有滞环，没有噪声。输出是干净的正弦，$a = 0.3254$，$P_u = 6.340$ s，所以 $K_u = 4\cdot1/(\pi\cdot0.3254) = 3.913$。`freq` 模块在真实对象上算出的真值是 $K_u = 3.980$、$P_u = 6.29887$ s。**继电器读的 $K_u$ 比真值低 1.7%，$P_u$ 高 0.65%。** 谐波平衡自己也能检验：在测得的 $\omega = 2\pi/P_u$ 处算 $|G(j\omega)|\cdot4d/\pi = 0.3241$，实测 $a = 0.3254$，差 0.4%；$\arg G(j\omega) = -179.3°$，几乎正好在 $-180°$ 上。这点偏差来自描述函数只取基波，三次谐波还是有一点点。（`report` 里这三条都是断言：$K_u$ 差小于 5%，$P_u$ 小于 2%，$a$ 小于 2%。）

摩擦轮（左）：$d = 10$ A，$\epsilon = 2$ rad/s，测量噪声 $\sigma = 0.5$ rad/s。测到 $a = 2.650$，$P_u = 31.63$ ms，所以 $K_u = 4.805$。**真值是 $K_u = 12.872$，$P_u = 13.74$ ms：继电器读出的 $K_u$ 小了 2.7 倍，周期长了 2.3 倍。** 这不是噪声的错，是前面推出的滞环效应：在测得的 $\omega$ 处，$|G|\cdot4d/\pi = 2.4552$（实测 2.6496，噪声把峰峰值撑大了一点，这是猜测），$\arg G = -129.5°$，而公式 $-180° + \arcsin(\epsilon/a) = -131.0°$。差 1.5°。**继电器测的是 $-131°$ 那个点，不是 $-180°$ 那个点。** $\epsilon/a = 2/2.65$ 不小，这个效应就大。滞环是为了不被噪声反复触发才加的，2 rad/s 的滞环是 0.5 rad/s 噪声的 4 倍，是我选的，没有找最小可行值。

### 摩擦轮上的三套规则

`tuning_flywheel_*.csv` 的结果，$M_s$ 和 PM 是在真实对象上算的：

```text
        rule       Kp        Ti        Td   IAE_sp   IAE_ld  over %      Ms     PM
     zn_step   22.104   0.00278   0.00070  62.7667   0.5093    0.46   1.304  -48.7
 zn_ultimate    2.883   0.01581   0.00395  62.7824   0.0376    0.78   1.633   61.7
        simc    9.210   0.01113   0.00000  62.7615   0.0307    0.30  12.405    6.2
```

![摩擦轮的三套整定在设定值阶跃和负载阶跃后的响应：阶跃法的电流在 ±20 A 之间持续来回切换，输出围绕 300 持续振荡；继电器法的输出在负载阶跃后 0.1 s 内回稳；SIMC 衰减振荡约 0.15 s](/assets/images/pid-control/ch06-tuning-compare-flywheel.svg)

三件事。**第一，`IAE_sp` 完全没有区别：62.7667、62.7824、62.7615，三者相差 0.033%。** 设定值是 300 rad/s 的阶跃，电流上限 20 A，电机以固定的加速度爬坡，整条上升过程都被限幅占着，增益选什么对 IAE 没有影响（图左上三条线重合）。这个指标在这个对象上没有判别力，我把它留在表里是为了让你看到它。

**第二，阶跃法给的增益让线性回路不稳定。** PM = $-48.7°$。因为拟合的 $\theta = 1.39$ ms 比真实的等效延迟 3.00 ms 小一半多，$k_p = 1.2\tau/(k\theta)$ 里的 $\theta$ 小了，$k_p$ 大了：22.104。图里蓝线在负载阶跃之后一直在 $\pm 20$ A 之间切换（限幅限住了发散，变成极限环），`report` 数出来负载阶跃之后 41% 的采样点上 $|u|$ 贴着 20 A。它的 $M_s = 1.304$ 看起来很漂亮，但是前面说过，回路不稳定的时候 $M_s$ 不是距离，所以在 $M_s$ 对 IAE 的图里这个点我画成空心。`IAE_ld` 是 0.5093，比另两个大 13 到 17 倍。

**第三，SIMC 的负载 IAE 最低（0.0307），但 $M_s = 12.4$，PM 只有 $6.2°$。** 同一个 $\theta$ 的错误在这里表现成另一种形式：SIMC 的 $K_p = \tau/(2k\theta)$ 同样对 $\theta$ 很敏感。我用同一个拟合的 $\tau$、$k$，只换 $\theta$ 再算一遍：

```text
SIMC on the same fit, tuned with different thetas:
  theta =  1.39 ms (     fitted): Kp =  9.210  Ms = 12.40
  theta =  3.00 ms (delay + lag): Kp =  4.269  Ms = 1.85
  theta =  3.50 ms ( + half ZOH): Kp =  3.659  Ms = 1.66
```

用真实的 3.00 ms，$M_s$ 从 12.40 降到 1.85；再加上第 4 篇的半拍 ZOH（0.5 ms，正是 [Skogestad 的 $h/2$ 规则](https://skoge.folk.ntnu.no/publications/2003/tuningPID/finalpaper.pdf)），$M_s = 1.66$，落进这个规则设计的 1.6 到 1.7 的范围。SIMC 没有错，是我喂给它的 $\theta$ 错了。（`report` 断言了 $M_s$(1.39 ms) > 5 且 $M_s$(3.5 ms) < 2.5。）

**真正“胜出”的是继电器的临界法：$k_p = 2.883$，PM $61.7°$，$M_s = 1.633$，`IAE_ld` = 0.0376，比 SIMC 差 22%。** 但这有点讽刺：前面看到继电器读的 $K_u$ 小了 2.7 倍，所以 $0.6K_u$ 其实只是真值的 0.22 倍（2.883 / 12.872），一个意外地保守的增益，保守恰好救了它。我没有一个办法声称这是“继电器法更好”，它是“滞环给的误差碰巧落在安全的一边”。如果去掉 $\epsilon$ 让它读到 $-180°$ 的点，$k_p$ 会是 $0.6\times12.87 = 7.7$，而我没有跑那个实验。

### 四阶对象上的三套规则

```text
        rule       Kp        Ti        Td   IAE_sp   IAE_ld  over %      Ms     PM
     zn_step    1.616   3.70909   0.92727   3.0187   2.2958   11.26   1.626   66.7
 zn_ultimate    2.348   3.17000   0.79250   3.3231   1.3772   36.16   2.166   41.3
        simc    0.673   2.49677   0.00000   4.1331   3.7464    6.80   1.628   62.0
```

![四阶对象的三套整定：阶跃法超调 11%，继电器法超调 36% 但负载恢复最快，SIMC 超调最小但负载下沉最深（到 0.38）、恢复最慢](/assets/images/pid-control/ch06-tuning-compare-benchmark4.svg)

这个对象没有限幅，也没有拟合出错，所以三套规则分得开：

- **设定值：** 阶跃法最快（`IAE_sp` 3.0187），继电器法次之（3.3231），SIMC 最慢（4.1331）。超调反过来，SIMC 最小（6.80%），阶跃法 11.26%，继电器法 36.16%，是 SIMC 的 5.3 倍。
- **负载：** 继电器法最好（`IAE_ld` 1.3772），阶跃法 2.2958，SIMC 3.7464，是继电器法的 2.7 倍。图里 SIMC 在负载阶跃之后下沉到 0.38，最深。
- **鲁棒性：** 阶跃法和 SIMC 几乎一样（$M_s$ 1.626 和 1.628），继电器法最差（2.166）。

`report` 里这四句话是断言：`IAE_sp` 最低的是阶跃法，`IAE_ld` 最低的是继电器法，超调最小的是 SIMC，$M_s$ 最大的是继电器法。

**我没想到的一点：阶跃法在四阶对象上赢了 SIMC。** 同样的 $M_s$（1.626 对 1.628），阶跃法的两个 IAE 都更低（3.02 对 4.13，2.30 对 3.75），只是超调大了 4.5 个百分点。要说公平，阶跃法是 PID，SIMC 这里只是 PI：Td 是 0.927 对 0。我没有跑 SIMC-PID（Skogestad 的论文里对二阶模型有 PID 版本，我这一篇只实现了 PI）。所以这个“赢”只能说是“PID 对 PI”，不能说是规则的胜负。

SIMC 的可调之处：同一个拟合，$\tau_c = 2\theta$（只改了一个参数），$K_p$ 从 0.673 降到 0.449，$M_s$ 从 1.628 降到 1.373（`report` 断言它变小）。我没有评估它的 IAE，所以不知道这个更稳的版本贵多少。

### 鲁棒性和性能

![灵敏度峰值对负载 IAE：摩擦轮（左，纵轴对数）阶跃法是空心点（线性不稳定），继电器法在左下角，SIMC 在右下角 M_s = 12.4；四阶对象（右）继电器法 IAE 最低但 M_s 最大，阶跃法和 SIMC M_s 相同，阶跃法 IAE 更低](/assets/images/pid-control/ch06-ms-vs-iae.svg)

把每套规则画成一个点，横轴是 $M_s$，纵轴是负载 IAE，越靠左下越好。四阶对象（右图）呈现的是教科书里的权衡：继电器法在最下面（IAE 1.38），也在最右边（$M_s$ = 2.17）；另外两个点在 $M_s \approx 1.63$ 的同一列，阶跃法（2.30）在 SIMC（3.75）下面。所以继电器法拿性能换了鲁棒性，而阶跃法在同样的 $M_s$ 上压住了 SIMC。

摩擦轮（左图，纵轴是对数）呈现的则是另一回事：权衡被拟合误差盖住了。左下角的点（继电器法）是被滞环意外保护起来的，右下角的点（SIMC）是被错误的 $\theta$ 害的，空心点（阶跃法）是不稳定的。**这张图的信息不是哪条规则好，而是：在这个对象上，规则之间的差别小于模型误差带来的差别。**

### 对不上的地方

- 摩擦轮上的 FOPDT 拟合把 3.00 ms 的等效延迟拟成了 1.39 ms，一个手算的取整误差（1.7 ms）基本能解释，但我没有换精确常数重新拟合来证实。
- 继电器在摩擦轮上读到的 $K_u$ 小 2.7 倍。滞环的相位公式预测的 $-131.0°$ 和实测的 $-129.5°$ 差 1.5°，实测的 $a$ 比描述函数预测的大 8%，我猜是噪声，没有分解。
- 摩擦轮的 `IAE_sp` 没有判别力（三者差 0.033%），限幅主导了。
- 阶跃法对摩擦轮的 $M_s = 1.304$ 在回路不稳定时没有意义，它和不稳定同时出现，只是因为我用的函数不检查稳定性。
- 四阶对象上我把 PID（两套 Ziegler–Nichols）和 PI（SIMC）放在一起比。
- 我没有测 Ziegler–Nichols 说的“四分之一衰减比”，它是我凭记忆写的目标，不是这一篇的实验结果。
- 继电器的滞环和噪声是我选的，没有扫描。四阶对象上没有滞环，所以那里的 1.7% 误差是“理想”情形。

## 下一篇

这一篇我把整定拆成了函数：两点法在摩擦轮上拟合出 $k = 78.11$、$\tau = 2.0008$ s，但把 3.00 ms 的延迟拟成了 1.39 ms；继电器在四阶对象上读出 $K_u = 3.913$，比真值 3.980 低 1.7%，在带 2 rad/s 滞环的摩擦轮上读出 4.805，真值是 12.872；三套规则里，阶跃法在摩擦轮上线性不稳定（PM $-48.7°$），SIMC 在同一个拟合上 $M_s = 12.4$，换成 3.5 ms 的 $\theta$ 之后降到 1.66；四阶对象上 SIMC 的超调 6.80%，继电器法 36.16%，但负载 IAE 是 3.7464 对 1.3772。四种语言 42 个对比文件最大差异是 $2.2\times10^{-16}$。

[第 7 篇：串级 PID：云台的角度环和速度环](/posts/pid-control-07-cascade/)会把这些单回路 PID 接成两层：云台的速度环（内）和角度环（外），内环抗底盘转动带来的扰动。整定用的还是这一篇的 SIMC 和第 2 篇的极点配置，评估用第 5 篇的 `Pid`，外环怎么知道内环饱和了，要靠 `hold_integral`。
