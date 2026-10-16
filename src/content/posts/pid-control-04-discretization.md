---
title: "离散化：位置式、增量式与采样率"
commentId: "post:pid-control-04-discretization"
published: "2026-10-16 11:00:00 +08:00"
description: "PID 控制系列第 4 篇：我用 Python 3.13、gcc 15.3、g++ 15.3 和 rustc 1.95 把位置式、增量式和三种 s 到 z 映射写了四遍，把采样周期从 1 ms 拉到 20 ms，相位裕度从 59.0° 掉到 -21.7°，回路在 20 ms 上失稳；限幅后的位置式积分器让超调到 29.2%、回到零要 5.07 s，增量式累加器限幅后只有 0.4% 和 0.53 s；Tustin 微分让输出的 rms 电流从 0.86 A 涨到 2.83 A。"
category: Tutorial
tags:
  - PID
  - 控制理论
  - 离散化
  - 数字控制
series: "PID 控制：从一个电机到 LQR"
seriesOrder: 4
draft: false
comment: true
slug: pid-control-04-discretization
---

上一篇我手算了一个“半拍”：ZOH 让相位多滞后半个采样周期，这半拍恰好决定了延迟裕度的整数拍答案。那时采样周期是 1 ms，半拍小到几乎可以忽略。这一篇我把采样周期拉长，看它到底有多小：同一个 PI 速度环（$\omega_n = 30$、$\zeta = 0.7$，加一拍传输延迟），采样周期取 1、5、10、20 ms，相位裕度依次是 59.0°、44.0°、24.0° 和 $-21.7$°，超调从 23.4% 一路涨到 70.8%，到 20 ms 回路干脆失稳。**采样周期不是一个“无关紧要的实现细节”，它是回路里一个真实的延迟。** 除了这条线，我还把位置式和增量式 PID 放在一起比：不限幅时两者的输出差 $4\times 10^{-15}$，限幅时一个积分器卷绕到 1328 A，另一个只有 0.4% 的超调。最后是微分项的两种离散化：后向差分和 Tustin，同一份噪声下，Tustin 的电流 rms 是后向的 3.3 倍。

> [!NOTE] 本篇检查点
> 这一篇结束时你会有：`make ch04` 通过，`out/ch04/` 下 44 个 CSV（`ts_{1,5,10,20}ms`、`form_{pos,inc}`、`sat_{pos,inc,inc_raw}`、`d_{backward,tustin}` 共 11 个算例，每个 Python、C、C++、Rust 各一份），`figures/ch04/` 下 4 张图；以及 ZOH、三种 s 到 z 映射、滤波微分的离散化、位置式和增量式的等价与抗饱和的完整推导。
> 新增模块：Python 是 `pidlab/pid_discrete.py`；C 是 `pl/pid_discrete.h` 和 `pid_discrete.c`；C++ 是 `pidlab/pid_discrete.h`；Rust 是 `pid_discrete.rs`。
> 前置：[第 3 篇](/posts/pid-control-03-frequency-domain/)。需要的数学：复指数、第 3 篇的相位裕度和延迟裕度；z 变换这一篇现推。

## 数学

### 采样、零阶保持和那个半拍

数字控制器每隔 $T_s$ 读一次传感器，算出 $u_k$，然后在下一个采样点之前让它保持不变：零阶保持（ZOH）。保持器的传递函数是

$$
H(s) = \frac{1 - e^{-sT_s}}{s}
$$

代入 $s = j\omega$，把分子拆成 $e^{-j\omega T_s/2}$ 乘一个正弦：

$$
H(j\omega) = \frac{e^{-j\omega T_s/2}\left(e^{j\omega T_s/2} - e^{-j\omega T_s/2}\right)}{j\omega} = T_s\,\frac{\sin(\omega T_s/2)}{\omega T_s/2}\,e^{-j\omega T_s/2}
$$

**相位是精确的 $-\omega T_s/2$，幅值是 $T_s$ 乘一个 sinc。** 所以保持器在相位上就是一个半拍的纯延迟，没有近似。幅值那一项在回路的穿越频率 $\omega_c \approx 46$ rad/s、$T_s = 1$ ms 处是 $\text{sinc}(0.023) \approx 0.9999$，可以忽略。我的仿真里命令从算出来到进入电机还要多过一拍（`DelayLine(1)`，第 3 篇的 `TRANSPORT`），所以回路的有效延迟是

$$
\theta = 1.5\,T_s, \qquad \Delta\text{PM} \approx -\omega_c \cdot 1.5\,T_s \cdot \frac{180}{\pi}\ \text{度}
$$

这是我要检验的第一个预测：用无延迟回路的 $\omega_c$ 和 $1.5T_s$ 估计相位裕度的损失，再和精确的采样模型对一对。

### $z = e^{sT_s}$ 和三种近似

连续系统的极点 $s = p$，采样后变成离散系统的极点 $z = e^{pT_s}$。这是精确的对应，但控制器里的 $1/s$（积分）和 $s$（微分）要用 $z$ 的有理函数实现，而 $s = \ln z / T_s$ 不是有理函数。所以要近似。三种常见的近似，对应 $e^{sT_s}$ 的三种展开：

- **前向欧拉：** $z = e^{sT_s} \approx 1 + sT_s$，即 $s \approx \dfrac{z - 1}{T_s}$。
- **后向欧拉：** $z^{-1} = e^{-sT_s} \approx 1 - sT_s$，即 $s \approx \dfrac{z - 1}{T_s z}$。
- **Tustin（双线性）：** $e^{sT_s} = \dfrac{e^{sT_s/2}}{e^{-sT_s/2}} \approx \dfrac{1 + sT_s/2}{1 - sT_s/2}$，即 $s \approx \dfrac{2}{T_s}\dfrac{z - 1}{z + 1}$。

用它们离散积分器 $I(s) = k_i/s$，得到三条递推：

| 方法 | $I(z)$ | 递推 |
| --- | --- | --- |
| 前向 | $k_i T_s/(z - 1)$ | $I_k = I_{k-1} + k_i T_s e_{k-1}$ |
| 后向 | $k_i T_s z/(z - 1)$ | $I_k = I_{k-1} + k_i T_s e_k$ |
| Tustin | $\dfrac{k_i T_s}{2}\dfrac{z + 1}{z - 1}$ | $I_k = I_{k-1} + \dfrac{k_i T_s}{2}(e_k + e_{k-1})$ |

我在第 1 篇写的 `PidBasic`（先 `integral += e * ts` 再输出）就是后向那一行。区别只在于 $I_k$ 里有没有包含当前这一拍的误差。

**三种近似在频率响应上的差别。** 取 $z = e^{j\theta}$，$\theta = \omega T_s$，把三个积分器的 $1/(j\omega)$ 提出来：

$$
\begin{aligned}
\text{前向：}&\quad \frac{T_s}{z - 1} = \frac{1}{j\omega}\cdot\frac{\theta/2}{\sin(\theta/2)}\,e^{-j\theta/2}\\[2pt]
\text{后向：}&\quad \frac{T_s z}{z - 1} = \frac{1}{j\omega}\cdot\frac{\theta/2}{\sin(\theta/2)}\,e^{+j\theta/2}\\[2pt]
\text{Tustin：}&\quad \frac{T_s}{2}\frac{z + 1}{z - 1} = \frac{1}{j\omega}\cdot\frac{\theta/2}{\tan(\theta/2)}
\end{aligned}
$$

前向多出半拍滞后，后向多出半拍超前，Tustin 的相位是精确的 $-90°$，只有幅值有一点偏差。这半拍和 ZOH 的半拍符号相反：后向的积分器刚好抵消一部分保持器的滞后，前向则叠加上去。我猜这就是 `PidBasic` 那种写法在 1 kHz 下“怎么都能用”的一半原因，另一半是 1 ms 本来就很小。

**稳定区域。** $z = e^{sT_s}$ 把左半平面映到单位圆内。三种近似各自的“映到单位圆内的 $s$ 区域”是：

- 前向：$|1 + sT_s| < 1$，是以 $-1/T_s$ 为圆心、$1/T_s$ 为半径的圆盘。**一个稳定的连续极点落在圆外，离散化之后会变成不稳定。**
- 后向：$|1 - sT_s| > 1$，是以 $+1/T_s$ 为圆心的圆的外部。**一个不稳定的连续极点落在圆内，离散化之后反而稳定。**
- Tustin：恰好是左半平面，稳定性一一对应。代价是频率轴被压缩，模拟频率 $\omega_a$ 和数字频率 $\Omega$ 的关系是 $\omega_a = \dfrac{2}{T_s}\tan\dfrac{\Omega T_s}{2}$，模拟的无穷远被折到 Nyquist 频率。

![三种映射在 z 平面上的像和各自映到单位圆内的 s 区域：前向是一条竖线和左边的圆盘，后向是小圆和右边圆的外部，Tustin 精确对应左半平面](/assets/images/pid-control/ch04-s-to-z.svg)

左图是虚轴 $s = j\omega$ 在三种映射下的像：前向是 $\text{Re}\,z = 1$ 这条竖线，永远在单位圆外；后向是以 0.5 为圆心的小圆，完全在单位圆内；Tustin 精确地落在单位圆上。右图是反过来看，哪些 $s$ 被映进了单位圆。最后这个区别后面会直接用到：Tustin 把 $s \to -\infty$ 映到 $z = -1$。

### 滤波微分的离散化

纯微分 $K_d s$ 在高频增益无穷大，实际一定要接一个一阶滤波，$D(s) = K_d s/(t_f s + 1)$。分别代入后向和 Tustin。

**后向：** $s = \dfrac{z - 1}{T_s z}$，

$$
D(z) = \frac{K_d (z - 1)}{t_f (z - 1) + T_s z} = \frac{K_d (z - 1)}{(t_f + T_s) z - t_f}
$$

分子分母同除以 $z$，交叉相乘，得到递推

$$
d_k = \frac{t_f}{t_f + T_s}\,d_{k-1} + \frac{K_d}{t_f + T_s}\,(e_k - e_{k-1})
$$

**Tustin：** $s = \dfrac{2}{T_s}\dfrac{z - 1}{z + 1}$，分子分母同乘 $T_s(z + 1)$：

$$
D(z) = \frac{2K_d (z - 1)}{(2t_f + T_s) z - (2t_f - T_s)}
$$

$$
d_k = \frac{2t_f - T_s}{2t_f + T_s}\,d_{k-1} + \frac{2K_d}{2t_f + T_s}\,(e_k - e_{k-1})
$$

两条递推的形状一样，$d_k = a\,d_{k-1} + b\,(e_k - e_{k-1})$，区别只在极点 $a$ 和增益 $b$。连续滤波器的极点在 $s = -1/t_f$，精确的离散极点是 $e^{-T_s/t_f}$；两种近似给出的是

$$
a_{\text{后向}} = \frac{t_f}{t_f + T_s}, \qquad a_{\text{Tustin}} = \frac{2t_f - T_s}{2t_f + T_s}
$$

取 $t_f = 0.1\,T_s$（滤波器比采样还快，我选它是因为这是“只想去掉一点点毛刺”时最容易写出来的设置），精确值是 $e^{-10} = 4.5\times 10^{-5}$，后向给 $0.091$，Tustin 给 $-0.667$。**后向的极点是正的，误差落在“还是一个平滑的衰减”那一侧；Tustin 的极点是负的，每一拍符号翻转。** 前向欧拉在这里是 $z = 1 - T_s/t_f = -9$，在单位圆外，所以我的实现直接拒绝 `FORWARD` 作为微分方法。

Tustin 为什么会这样：它把 $s \to -\infty$（滤波器的高频极限）映到 $z = -1$，正好是 Nyquist 点。采样把快速旋转的车轮拍成倒转，这是同一类现象（电影里的 wagon-wheel 错觉）：映射把一个“快得没法表示”的模式折叠到 Nyquist 频率。在 $z = -1$ 处两个滤波器的增益是

$$
|D_{\text{后向}}(-1)| = \frac{2K_d}{2t_f + T_s}, \qquad |D_{\text{Tustin}}(-1)| = \frac{K_d}{t_f}
$$

比值是 $(2t_f + T_s)/(2t_f) = 6$。这是第二个预测：同样的噪声，Tustin 的 D 项应该在 Nyquist 附近放大得更多，并且符号交替。

### 位置式和增量式

**位置式**保存积分，每拍直接算出输出：

$$
u_k = k_p e_k + I_k + d_k, \qquad I_k = I_{k-1} + \Delta I_k
$$

其中 $\Delta I_k$ 是上一节表里右边的增量（前向、后向或 Tustin）。**增量式**保存的是上一拍的输出，每拍只算变化量：

$$
u_k = u_{k-1} + k_p (e_k - e_{k-1}) + \Delta I_k + (d_k - d_{k-1})
$$

两者在没有限幅时等价：把位置式写成 $u_k - u_{k-1}$，$k_p e_k$ 的差分是 $k_p(e_k - e_{k-1})$，$I_k - I_{k-1} = \Delta I_k$，$d_k - d_{k-1}$ 原样保留，就是增量式的右边。起点也要一致：我让 $e_{-1} = 0$、$d_{-1} = 0$、$u_{-1} = 0$，所以没有“第一拍不算微分”的特殊处理（第 5 篇的最终 PID 才会加上）。

**限幅时它们就不等价了，原因是各自的状态不同。** 位置式有两个量：积分 $I$ 和被限幅的输出 $u$。限幅只动 $u$，$I$ 照样累加，账本和钱包就对不上了：执行器只能给 5 A，账上却记着 1300 A。增量式只有一个量，上一拍的输出 $u_{k-1}$，限幅作用在它身上，状态本身就被夹住了。

**但这个好处依赖一个条件：限幅要加在累加器上。** 如果增量式只把“要发给电机的值”限幅，累加器仍然是无限制地累加，那它在数学上就是位置式，一样卷绕。我会跑这个算例来验证（`sat_inc_raw`）。

**限幅后的增量式到底是什么？** 令 $I_k := u_k - k_p e_k - d_k$（把输出里不属于积分的部分减掉）。不限幅时代入增量式，$I_k = I_{k-1} + \Delta I_k$，就是位置式的积分。限幅时 $u_k$ 被夹在边界上，$I_k$ 被重新定义成“让输出刚好等于边界的那个值”。设位置式的未限幅输出是 $v_k = k_p e_k + I_{k-1} + \Delta I_k + d_k$，那么

$$
I_k = u_k - k_p e_k - d_k = I_{k-1} + \Delta I_k + (u_k - v_k)
$$

这正是**反算抗饱和（back-calculation）**，跟踪时间常数取 $T_t = T_s$，也就是一个采样周期就把积分拉回去。第 5 篇会把 $T_t$ 做成可调参数；这里我先在 `report` 里验证这个等价（下面“限幅”一节）。

### ts 为什么必须显式出现

连续的 $k_i$ 的量纲是 $k_p$ 除以时间，$k_d$ 是 $k_p$ 乘时间。离散化之后每拍加的是 $k_i T_s e_k$，微分是 $k_d (e_k - e_{k-1})/T_s$。据我所知，不少 RM 开源代码把 $T_s$ 直接折进增益里：`ki_code = ki * ts`、`kd_code = kd / ts`，循环里只写 `integral += ki_code * e`。这在固定采样率下完全正确，但这样做之后，**$T_s$ 变了代码里的增益不会跟着变**。比如 $k_i = 90$，从 1 ms 改到 5 ms，如果 `ki_code` 还是 $90 \times 0.001$，等效积分增益就是 $0.09/0.005 = 18$，只剩 1/5。我没有逐个翻那些仓库，这一条是从常见写法推的，不是审计结论。我自己的做法是把 `ts` 放进配置、让 `update` 每拍用 `ts` 乘，这样改采样率只改一个数。

## Python 实现

模块 `pidlab/pid_discrete.py`，完整代码：

```python
"""Discrete PID: positional and incremental forms, three s-to-z maps."""

import math
from dataclasses import dataclass
from enum import Enum


class Form(Enum):
    POSITIONAL = 0
    INCREMENTAL = 1


class Method(Enum):
    FORWARD = 0
    BACKWARD = 1
    TUSTIN = 2


@dataclass
class DiscreteConfig:
    """Parallel gains in physical units: u = kp e + ki int e + kd de/dt.

    The derivative is filtered, D(s) = kd s / (tf s + 1). u_min and u_max
    clamp the output (positional) or the accumulator (incremental).
    """

    kp: float
    ki: float
    kd: float
    ts: float
    tf: float = 0.0
    u_min: float = -math.inf
    u_max: float = math.inf
    form: Form = Form.POSITIONAL
    i_method: Method = Method.BACKWARD
    d_method: Method = Method.BACKWARD


def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else (hi if x > hi else x)


class PidDiscrete:
    """Discrete PID on the error e = r - y.

    No priming: e_prev starts at 0, so the first sample sees a step from
    zero. That keeps the two forms identical from sample 0.
    """

    def __init__(self, cfg: DiscreteConfig) -> None:
        if cfg.ts <= 0.0 or cfg.tf < 0.0 or cfg.u_min > cfg.u_max:
            raise ValueError("need ts > 0, tf >= 0, u_min <= u_max")
        if cfg.d_method is Method.FORWARD:
            raise ValueError("derivative has no forward method")
        if cfg.d_method is Method.TUSTIN and cfg.tf <= 0.0:
            raise ValueError("Tustin derivative needs tf > 0")
        self.cfg = cfg
        self.integral = 0.0  # positional form only
        self.u_prev = 0.0  # incremental accumulator
        self.d_state = 0.0
        self.e_prev = 0.0

    def update(self, r: float, y: float) -> float:
        c = self.cfg
        e = r - y
        de = e - self.e_prev
        d_old = self.d_state
        if c.d_method is Method.BACKWARD:
            a = c.tf / (c.tf + c.ts)
            self.d_state = a * d_old + c.kd / (c.tf + c.ts) * de
        else:
            a = (2.0 * c.tf - c.ts) / (2.0 * c.tf + c.ts)
            self.d_state = a * d_old + 2.0 * c.kd / (2.0 * c.tf + c.ts) * de
        if c.i_method is Method.FORWARD:
            di = c.ki * c.ts * self.e_prev
        elif c.i_method is Method.BACKWARD:
            di = c.ki * c.ts * e
        else:
            di = 0.5 * c.ki * c.ts * (e + self.e_prev)
        if c.form is Form.POSITIONAL:
            self.integral += di
            v = c.kp * e + self.integral + self.d_state
        else:
            v = self.u_prev + c.kp * de + di + (self.d_state - d_old)
        u = clamp(v, c.u_min, c.u_max)
        self.u_prev = u
        self.e_prev = e
        return u
```

**配置里 `form`、`i_method`、`d_method` 是三个独立的开关。** 三种积分、两种微分、两种形式，一共 12 个组合，每个组合是 `update` 里的一个分支，不是 12 个类。构造函数拒绝五种配置：`ts <= 0`、`tf < 0`、`u_min > u_max`，还有两条针对微分的：前向欧拉微分（上面说了它不稳定）和 `tf = 0` 的 Tustin 微分（极点在 $-1$，每拍翻符号永不衰减）。

**`u_min` 和 `u_max` 的含义随形式而变。** 位置式里它们夹的是输出 `v`，`integral` 不受影响；增量式里 `u_prev` 存的就是夹过的输出，所以夹的是累加器。`update` 末尾的 `self.u_prev = u` 在位置式里没有用到，但写上它让两种形式共用一个出口。

**没有“第一拍不算微分”。** 第 1 篇的 `PidBasic` 有 `primed` 标志，第一拍的微分为 0。这里 `e_prev` 从 0 开始，第一拍看到的是一个从 0 跳到 $e_0$ 的阶跃，微分会踢一脚（后面 Tustin 的算例里这一脚是 11.1 A）。我这么做是为了让位置式和增量式从第 0 拍起逐位一致；第 5 篇的 PID 会处理微分冲击。

驱动 `python/ch04_discretization.py` 里有这几个核心函数。算例表：

```python
def make_cases() -> list[Case]:
    kp, ki = speed_gains()
    cases = []
    for ms in TS_LIST_MS:
        cfg = DiscreteConfig(kp, ki, 0.0, ms * 1e-3)
        cases.append(Case(f"ts_{ms}ms", f"ch04_ts_{ms}ms", "speed", cfg, 20.0))
    for name, form in (
        ("form_pos", Form.POSITIONAL),
        ("form_inc", Form.INCREMENTAL),
    ):
        cfg = DiscreteConfig(kp, ki, 0.02, 1e-3, tf=0.005, form=form)
        cases.append(Case(name, "ch04_form", "speed", cfg, INF))
    for name, form, lim in (
        ("sat_pos", Form.POSITIONAL, SAT_LIMIT),
        ("sat_inc", Form.INCREMENTAL, SAT_LIMIT),
        ("sat_inc_raw", Form.INCREMENTAL, INF),
    ):
        cfg = DiscreteConfig(
            kp, ki, 0.0, 1e-3, u_min=-lim, u_max=lim, form=form
        )
        cases.append(Case(name, "ch04_sat", "speed", cfg, SAT_LIMIT))
    kpd, kdd = dial_gains()
    for name, method in (
        ("d_backward", Method.BACKWARD),
        ("d_tustin", Method.TUSTIN),
    ):
        cfg = DiscreteConfig(
            kpd, 0.0, kdd, 1e-3, D_TF_RATIO * 1e-3, d_method=method
        )
        cases.append(Case(name, "ch04_dnoise", "dial", cfg, 20.0))
    return cases
```

仿真循环和第 3 篇的差别只有两处：控制器换成 `PidDiscrete`，以及多了一个 `back_calc` 开关，只在 `report` 里验证“限幅增量式等价于反算”时使用：

```python
def run_case(case: Case, back_calc: bool = False) -> dict[str, np.ndarray]:
    """One closed loop. Columns t, r, y, u (controller), ua (applied), d.

    back_calc feeds the clamp error back into the positional integral
    (tracking time constant ts); the check in report_sat uses it.
    """
    plant = MotorSpeedLag() if case.plant == "speed" else DialPosition()
    data = read_csv(DATA / f"{case.data}.csv")
    ts = case.cfg.ts
    pid = PidDiscrete(case.cfg)
    delay = DelayLine(TRANSPORT)
    x = [0.0] * plant.n
    rows = []
    for k in range(len(data["t"])):
        r = data["r"][k]
        y = plant.output(x) + data["n"][k]
        u = pid.update(r, y)
        ua = min(max(u, -case.act_limit), case.act_limit)
        if back_calc:
            pid.integral += ua - u
        rows.append([data["t"][k], r, y, u, ua, pid.d_state])
        x = advance(
            plant.deriv, x, [delay.push(ua), data["d"][k]], ts, SUBSTEPS
        )
    names = ("t", "r", "y", "u", "ua", "d")
    return dict(zip(names, np.array(rows).T))
```

`u` 是控制器的输出，`ua` 是夹过执行器限幅后真正发给电机的命令，两列都写进 CSV，后面的图要同时用到。

**精确的采样模型。** 要回答“相位裕度到底掉了多少”，只用连续模型加延迟是近似。`sampled_pm` 把电机（连同电流环）用 `scipy.linalg.expm` 做精确的 ZOH 离散化，控制器用 $C(z) = k_p + k_i T_s z/(z-1)$（后向积分），再乘一拍延迟 $z^{-1}$，在 $[1, 0.999\pi/T_s]$ 上扫频率找穿越点：

```python
def sampled_pm(ts: float, kp: float, ki: float) -> tuple[float, float]:
    """(wc, PM in degrees) of the exact sampled loop at period ts.

    C(z) = kp + ki ts z / (z - 1) (backward I), the ZOH discretization of
    the plant with its current lag, and one sample of transport delay.
    Returns (nan, nan) if |L| never crosses 1 below the Nyquist frequency.
    """
    from scipy.linalg import expm

    m = MotorSpeedLag()
    a = np.array([[-m.b / m.j, m.kt / m.j], [0.0, -1.0 / m.tau_c]])
    bv = np.array([0.0, 1.0 / m.tau_c])
    em = np.zeros((3, 3))
    em[:2, :2] = a
    em[:2, 2] = bv
    e = expm(em * ts)
    ad, bd = e[:2, :2], e[:2, 2]
    w = np.linspace(1.0, math.pi / ts * 0.999, 20000)
    z = np.exp(1j * w * ts)
    g = np.empty_like(z)
    for i, zi in enumerate(z):
        g[i] = np.linalg.solve(zi * np.eye(2) - ad, bd)[0]
    lz = (kp + ki * ts * z / (z - 1.0)) * g / z**TRANSPORT
    mag = np.abs(lz)
    idx = np.flatnonzero((mag[:-1] >= 1.0) & (mag[1:] < 1.0))
    if idx.size == 0:
        return math.nan, math.nan
    i = int(idx[0])
    f = (mag[i] - 1.0) / (mag[i] - mag[i + 1])
    wc = w[i] + f * (w[i + 1] - w[i])
    ph = np.unwrap(np.angle(lz))
    pm = 180.0 + math.degrees(ph[i] + f * (ph[i + 1] - ph[i]))
    return float(wc), float(pm)
```

`sampled_radius` 是同一个回路的闭环特征值的谱半径，大于 1 就是不稳定：

```python
def sampled_radius(ts: float, kp: float, ki: float) -> float:
    """Spectral radius of the exact sampled loop (backward I, 1 delay)."""
    from scipy.linalg import expm

    m = MotorSpeedLag()
    a = np.array([[-m.b / m.j, m.kt / m.j], [0.0, -1.0 / m.tau_c]])
    em = np.zeros((3, 3))
    em[:2, :2] = a
    em[:2, 2] = [0.0, 1.0 / m.tau_c]
    e = expm(em * ts)
    # state: w, i, integral, command in flight
    f = np.zeros((4, 4))
    f[:2, :2] = e[:2, :2]
    f[:2, 3] = e[:2, 2]
    # u_k = kp e + I, I += ki ts e (backward): I_{k+1} = I_k + ki ts e_k
    f[2, 0] = -ki * ts
    f[2, 2] = 1.0
    f[3, 0] = -kp - ki * ts
    f[3, 2] = 1.0
    return float(np.abs(np.linalg.eigvals(f)).max())
```

这两个函数是分析用的，不是被检验的对象：它们只用 scipy 的 `expm` 和 numpy 的特征值，C、C++、Rust 不需要重写。`report` 里的对比表、抗饱和等价性验证、D 项统计和 4 张图见 [`python/ch04_discretization.py`](https://github.com/bfmhno3/pid-lab/tree/tutorial-v1/python/ch04_discretization.py)。

## C、C++、Rust 实现

三个版本都是 Python 版的逐行翻译，`update` 里的算术顺序也和 Python 一致。区别在这几处：

- **枚举和配置。** C 是 `enum pl_form`、`enum pl_method` 加 `struct pl_pid_discrete_config`，没有 `typedef`；C++ 是 `enum class Form`、`enum class Method` 和模板结构体 `PidDiscreteConfig<T>`；Rust 是 `enum Form`、`enum Method` 和 `PidDiscreteConfig`，另外给了一个 `PidDiscreteConfig::new(kp, ki, kd, ts)` 填上默认值（不限幅、后向积分、后向微分），算例里只改需要改的字段。
- **构造的失败方式。** C 的 `pl_pid_discrete_init` 返回 0 或 `-EINVAL`；C++ 的 `PidDiscrete<T>::Create` 返回 `std::optional`，失败是 `std::nullopt`，没有异常；Rust 的 `PidDiscrete::new` 返回 `Result<Self, PidDiscreteError>`。
- **无穷。** 不限幅的 `u_min`、`u_max` 在 C 里是 `-INFINITY` 和 `INFINITY`（`<math.h>`），C++ 是 `std::numeric_limits<T>::infinity()`，Rust 是 `Real::INFINITY`；Python 是 `math.inf`。`clamp` 对无穷边界没有特殊处理，`x < -inf` 永远为假。
- **内存。** 三种语言里控制器都是栈上的值：C 的 `struct pl_pid_discrete` 把配置拷贝进来，C++ 和 Rust 的对象也是值语义。没有堆分配。

### C

`pl_pid_discrete_update` 是 Python `update` 的逐行翻译。函数开头一次取出 `c = &pid->cfg`，后面都走它：

```c
pl_real pl_pid_discrete_update(struct pl_pid_discrete *pid, pl_real r,
			       pl_real y)
{
	const struct pl_pid_discrete_config *c = &pid->cfg;
	pl_real e = r - y;
	pl_real de = e - pid->e_prev;
	pl_real d_old = pid->d_state;
	pl_real a, di, v, u;

	if (c->d_method == PL_METHOD_BACKWARD) {
		a = c->tf / (c->tf + c->ts);
		pid->d_state = a * d_old + c->kd / (c->tf + c->ts) * de;
	} else {
		a = (2.0 * c->tf - c->ts) / (2.0 * c->tf + c->ts);
		pid->d_state =
			a * d_old + 2.0 * c->kd / (2.0 * c->tf + c->ts) * de;
	}
	if (c->i_method == PL_METHOD_FORWARD)
		di = c->ki * c->ts * pid->e_prev;
	else if (c->i_method == PL_METHOD_BACKWARD)
		di = c->ki * c->ts * e;
	else
		di = 0.5 * c->ki * c->ts * (e + pid->e_prev);
	if (c->form == PL_FORM_POSITIONAL) {
		pid->integral += di;
		v = c->kp * e + pid->integral + pid->d_state;
	} else {
		v = pid->u_prev + c->kp * de + di + (pid->d_state - d_old);
	}
	u = pl_clamp(v, c->u_min, c->u_max);
	pid->u_prev = u;
	pid->e_prev = e;
	return u;
}
```

状态是四个 `pl_real`（`integral`、`u_prev`、`d_state`、`e_prev`），`struct pl_pid_discrete` 里还嵌着一份配置，所以复制一个控制器就是一次结构体赋值。

<details>
<summary>完整源码：c/include/pl/pid_discrete.h、c/src/pid_discrete.c</summary>

```c
/* SPDX-License-Identifier: MIT OR Apache-2.0 */
/* Discrete PID: positional and incremental forms, three s-to-z maps. */
#ifndef PL_PID_DISCRETE_H
#define PL_PID_DISCRETE_H

#include "pl/real.h"

enum pl_form {
	PL_FORM_POSITIONAL,
	PL_FORM_INCREMENTAL,
};

enum pl_method {
	PL_METHOD_FORWARD,
	PL_METHOD_BACKWARD,
	PL_METHOD_TUSTIN,
};

/* Parallel gains in physical units: u = kp e + ki int e + kd de/dt. */
/* The derivative is filtered, D(s) = kd s / (tf s + 1). u_min and u_max */
/* clamp the output (positional) or the accumulator (incremental). */
struct pl_pid_discrete_config {
	pl_real kp, ki, kd, ts, tf;
	pl_real u_min, u_max;
	enum pl_form form;
	enum pl_method i_method, d_method;
};

/* No priming: e_prev starts at 0, so the first sample sees a step from */
/* zero. That keeps the two forms identical from sample 0. */
struct pl_pid_discrete {
	struct pl_pid_discrete_config cfg;
	pl_real integral; /* positional form only */
	pl_real u_prev; /* incremental accumulator */
	pl_real d_state;
	pl_real e_prev;
};

/* Returns 0, or -EINVAL unless ts > 0, tf >= 0, u_min <= u_max, the */
/* derivative method is not FORWARD, and a TUSTIN derivative has tf > 0. */
int pl_pid_discrete_init(struct pl_pid_discrete *pid,
			 const struct pl_pid_discrete_config *cfg);

/* One sample on the error e = r - y. */
pl_real pl_pid_discrete_update(struct pl_pid_discrete *pid, pl_real r,
			       pl_real y);

#endif /* PL_PID_DISCRETE_H */
```

```c
// SPDX-License-Identifier: MIT OR Apache-2.0
#include <errno.h>

#include "pl/pid_discrete.h"

int pl_pid_discrete_init(struct pl_pid_discrete *pid,
			 const struct pl_pid_discrete_config *cfg)
{
	if (cfg->ts <= 0.0 || cfg->tf < 0.0 || cfg->u_min > cfg->u_max)
		return -EINVAL;
	if (cfg->d_method == PL_METHOD_FORWARD)
		return -EINVAL;
	if (cfg->d_method == PL_METHOD_TUSTIN && cfg->tf <= 0.0)
		return -EINVAL;
	pid->cfg = *cfg;
	pid->integral = 0.0;
	pid->u_prev = 0.0;
	pid->d_state = 0.0;
	pid->e_prev = 0.0;
	return 0;
}

pl_real pl_pid_discrete_update(struct pl_pid_discrete *pid, pl_real r,
			       pl_real y)
{
	const struct pl_pid_discrete_config *c = &pid->cfg;
	pl_real e = r - y;
	pl_real de = e - pid->e_prev;
	pl_real d_old = pid->d_state;
	pl_real a, di, v, u;

	if (c->d_method == PL_METHOD_BACKWARD) {
		a = c->tf / (c->tf + c->ts);
		pid->d_state = a * d_old + c->kd / (c->tf + c->ts) * de;
	} else {
		a = (2.0 * c->tf - c->ts) / (2.0 * c->tf + c->ts);
		pid->d_state =
			a * d_old + 2.0 * c->kd / (2.0 * c->tf + c->ts) * de;
	}
	if (c->i_method == PL_METHOD_FORWARD)
		di = c->ki * c->ts * pid->e_prev;
	else if (c->i_method == PL_METHOD_BACKWARD)
		di = c->ki * c->ts * e;
	else
		di = 0.5 * c->ki * c->ts * (e + pid->e_prev);
	if (c->form == PL_FORM_POSITIONAL) {
		pid->integral += di;
		v = c->kp * e + pid->integral + pid->d_state;
	} else {
		v = pid->u_prev + c->kp * de + di + (pid->d_state - d_old);
	}
	u = pl_clamp(v, c->u_min, c->u_max);
	pid->u_prev = u;
	pid->e_prev = e;
	return u;
}
```

</details>

驱动：[`c/apps/ch04.c`](https://github.com/bfmhno3/pid-lab/tree/tutorial-v1/c/apps/ch04.c)。11 个算例放在一个 `struct sim_case` 数组里，`run_case` 读对应的数据文件，按 `dial` 标志选 `MotorSpeedLag` 还是 `DialPosition`，写 `out/ch04/<case>_c.csv`。

### C++

构造用 `Create`，失败返回 `std::nullopt`；`Update` 里的常数写成 `T(2)`、`T(0.5)`，让它们跟着标量类型走：

```cpp
  // Returns std::nullopt unless ts > 0, tf >= 0, u_min <= u_max, the
  // derivative method is not kForward, and a kTustin derivative has tf > 0.
  static std::optional<PidDiscrete> Create(const PidDiscreteConfig<T>& cfg) {
    if (cfg.ts <= T(0) || cfg.tf < T(0) || cfg.u_min > cfg.u_max) {
      return std::nullopt;
    }
    if (cfg.d_method == Method::kForward) return std::nullopt;
    if (cfg.d_method == Method::kTustin && cfg.tf <= T(0)) {
      return std::nullopt;
    }
    return PidDiscrete(cfg);
  }
```

```cpp
  // One sample on the error e = r - y.
  T Update(T r, T y) {
    const T e = r - y;
    const T de = e - e_prev_;
    const T d_old = d_state_;
    if (cfg_.d_method == Method::kBackward) {
      const T a = cfg_.tf / (cfg_.tf + cfg_.ts);
      d_state_ = a * d_old + cfg_.kd / (cfg_.tf + cfg_.ts) * de;
    } else {
      const T a = (T(2) * cfg_.tf - cfg_.ts) / (T(2) * cfg_.tf + cfg_.ts);
      d_state_ = a * d_old + T(2) * cfg_.kd / (T(2) * cfg_.tf + cfg_.ts) * de;
    }
    T di;
    if (cfg_.i_method == Method::kForward) {
      di = cfg_.ki * cfg_.ts * e_prev_;
    } else if (cfg_.i_method == Method::kBackward) {
      di = cfg_.ki * cfg_.ts * e;
    } else {
      di = T(0.5) * cfg_.ki * cfg_.ts * (e + e_prev_);
    }
    T v;
    if (cfg_.form == Form::kPositional) {
      integral_ += di;
      v = cfg_.kp * e + integral_ + d_state_;
    } else {
      v = u_prev_ + cfg_.kp * de + di + (d_state_ - d_old);
    }
    const T u = std::clamp(v, cfg_.u_min, cfg_.u_max);
    u_prev_ = u;
    e_prev_ = e;
    return u;
  }
```

构造函数是私有的，`Create` 是唯一的入口，所以拿到一个 `PidDiscrete` 就意味着它通过了校验。代价是对象只能通过 `std::optional` 取出来，驱动里用 `pid->Update(...)`。

<details>
<summary>完整源码：cpp/include/pidlab/pid_discrete.h</summary>

```cpp
// Discrete PID: positional and incremental forms, three s-to-z maps.
#ifndef PIDLAB_PID_DISCRETE_H_
#define PIDLAB_PID_DISCRETE_H_

#include <algorithm>
#include <limits>
#include <optional>

namespace pidlab {

enum class Form { kPositional, kIncremental };
enum class Method { kForward, kBackward, kTustin };

// Parallel gains in physical units: u = kp e + ki int e + kd de/dt. The
// derivative is filtered, D(s) = kd s / (tf s + 1). u_min and u_max clamp
// the output (positional) or the accumulator (incremental).
template <class T = double>
struct PidDiscreteConfig {
  T kp, ki, kd, ts;
  T tf = T(0);
  T u_min = -std::numeric_limits<T>::infinity();
  T u_max = std::numeric_limits<T>::infinity();
  Form form = Form::kPositional;
  Method i_method = Method::kBackward;
  Method d_method = Method::kBackward;
};

// No priming: e_prev starts at 0, so the first sample sees a step from
// zero. That keeps the two forms identical from sample 0.
template <class T = double>
class PidDiscrete {
 public:
  // Returns std::nullopt unless ts > 0, tf >= 0, u_min <= u_max, the
  // derivative method is not kForward, and a kTustin derivative has tf > 0.
  static std::optional<PidDiscrete> Create(const PidDiscreteConfig<T>& cfg) {
    if (cfg.ts <= T(0) || cfg.tf < T(0) || cfg.u_min > cfg.u_max) {
      return std::nullopt;
    }
    if (cfg.d_method == Method::kForward) return std::nullopt;
    if (cfg.d_method == Method::kTustin && cfg.tf <= T(0)) {
      return std::nullopt;
    }
    return PidDiscrete(cfg);
  }

  // One sample on the error e = r - y.
  T Update(T r, T y) {
    const T e = r - y;
    const T de = e - e_prev_;
    const T d_old = d_state_;
    if (cfg_.d_method == Method::kBackward) {
      const T a = cfg_.tf / (cfg_.tf + cfg_.ts);
      d_state_ = a * d_old + cfg_.kd / (cfg_.tf + cfg_.ts) * de;
    } else {
      const T a = (T(2) * cfg_.tf - cfg_.ts) / (T(2) * cfg_.tf + cfg_.ts);
      d_state_ = a * d_old + T(2) * cfg_.kd / (T(2) * cfg_.tf + cfg_.ts) * de;
    }
    T di;
    if (cfg_.i_method == Method::kForward) {
      di = cfg_.ki * cfg_.ts * e_prev_;
    } else if (cfg_.i_method == Method::kBackward) {
      di = cfg_.ki * cfg_.ts * e;
    } else {
      di = T(0.5) * cfg_.ki * cfg_.ts * (e + e_prev_);
    }
    T v;
    if (cfg_.form == Form::kPositional) {
      integral_ += di;
      v = cfg_.kp * e + integral_ + d_state_;
    } else {
      v = u_prev_ + cfg_.kp * de + di + (d_state_ - d_old);
    }
    const T u = std::clamp(v, cfg_.u_min, cfg_.u_max);
    u_prev_ = u;
    e_prev_ = e;
    return u;
  }

  T d_state() const { return d_state_; }

 private:
  explicit PidDiscrete(const PidDiscreteConfig<T>& cfg) : cfg_(cfg) {}

  PidDiscreteConfig<T> cfg_;
  T integral_ = T(0);  // positional form only
  T u_prev_ = T(0);    // incremental accumulator
  T d_state_ = T(0);
  T e_prev_ = T(0);
};

}  // namespace pidlab

#endif  // PIDLAB_PID_DISCRETE_H_
```

</details>

驱动：[`cpp/apps/ch04.cc`](https://github.com/bfmhno3/pid-lab/tree/tutorial-v1/cpp/apps/ch04.cc)。`RunLoop<P>` 是以植物类型为模板参数的一个函数，`DialPosition` 和 `MotorSpeedLag` 各实例化一份。

### Rust

Rust 的 `match` 把三种积分方法写成一个表达式，并且编译器检查是否穷尽：

```rust
    /// Fails unless `ts > 0`, `tf >= 0`, `u_min <= u_max`, the derivative
    /// method is not `Forward`, and a `Tustin` derivative has `tf > 0`.
    pub fn new(cfg: PidDiscreteConfig) -> Result<Self, PidDiscreteError> {
        if cfg.ts <= 0.0 || cfg.tf < 0.0 || cfg.u_min > cfg.u_max {
            return Err(PidDiscreteError::InvalidConfig(
                "need ts > 0, tf >= 0, u_min <= u_max",
            ));
        }
        if cfg.d_method == Method::Forward {
            return Err(PidDiscreteError::InvalidConfig(
                "derivative has no forward method",
            ));
        }
        if cfg.d_method == Method::Tustin && cfg.tf <= 0.0 {
            return Err(PidDiscreteError::InvalidConfig(
                "Tustin derivative needs tf > 0",
            ));
        }
        Ok(Self {
            cfg,
            integral: 0.0,
            u_prev: 0.0,
            d_state: 0.0,
            e_prev: 0.0,
        })
    }
```

```rust
    /// One sample on the error `e = r - y`.
    pub fn update(&mut self, r: Real, y: Real) -> Real {
        let c = &self.cfg;
        let e = r - y;
        let de = e - self.e_prev;
        let d_old = self.d_state;
        self.d_state = if c.d_method == Method::Backward {
            let a = c.tf / (c.tf + c.ts);
            a * d_old + c.kd / (c.tf + c.ts) * de
        } else {
            let a = (2.0 * c.tf - c.ts) / (2.0 * c.tf + c.ts);
            a * d_old + 2.0 * c.kd / (2.0 * c.tf + c.ts) * de
        };
        let di = match c.i_method {
            Method::Forward => c.ki * c.ts * self.e_prev,
            Method::Backward => c.ki * c.ts * e,
            Method::Tustin => 0.5 * c.ki * c.ts * (e + self.e_prev),
        };
        let v = if c.form == Form::Positional {
            self.integral += di;
            c.kp * e + self.integral + self.d_state
        } else {
            self.u_prev + c.kp * de + di + (self.d_state - d_old)
        };
        let u = v.clamp(c.u_min, c.u_max);
        self.u_prev = u;
        self.e_prev = e;
        u
    }
```

`update` 里 `let c = &self.cfg;` 之后又修改 `self.d_state`，借用检查没有抱怨：`c` 只借了 `self.cfg` 这一个字段，Rust 认为字段之间是不相交的借用。

<details>
<summary>完整源码：rust/src/pid_discrete.rs</summary>

```rust
//! Discrete PID: positional and incremental forms, three s-to-z maps.

use crate::real::Real;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Form {
    Positional,
    Incremental,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Method {
    Forward,
    Backward,
    Tustin,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PidDiscreteError {
    InvalidConfig(&'static str),
}

/// Parallel gains in physical units: `u = kp e + ki int e + kd de/dt`.
/// The derivative is filtered, `D(s) = kd s / (tf s + 1)`. `u_min` and
/// `u_max` clamp the output (positional) or the accumulator (incremental).
#[derive(Clone, Copy, Debug)]
pub struct PidDiscreteConfig {
    pub kp: Real,
    pub ki: Real,
    pub kd: Real,
    pub ts: Real,
    pub tf: Real,
    pub u_min: Real,
    pub u_max: Real,
    pub form: Form,
    pub i_method: Method,
    pub d_method: Method,
}

impl PidDiscreteConfig {
    /// Unclamped positional PID with backward integral and derivative.
    pub fn new(kp: Real, ki: Real, kd: Real, ts: Real) -> Self {
        Self {
            kp,
            ki,
            kd,
            ts,
            tf: 0.0,
            u_min: Real::NEG_INFINITY,
            u_max: Real::INFINITY,
            form: Form::Positional,
            i_method: Method::Backward,
            d_method: Method::Backward,
        }
    }
}

/// No priming: `e_prev` starts at 0, so the first sample sees a step from
/// zero. That keeps the two forms identical from sample 0.
pub struct PidDiscrete {
    cfg: PidDiscreteConfig,
    integral: Real, // positional form only
    u_prev: Real,   // incremental accumulator
    d_state: Real,
    e_prev: Real,
}

impl PidDiscrete {
    /// Fails unless `ts > 0`, `tf >= 0`, `u_min <= u_max`, the derivative
    /// method is not `Forward`, and a `Tustin` derivative has `tf > 0`.
    pub fn new(cfg: PidDiscreteConfig) -> Result<Self, PidDiscreteError> {
        if cfg.ts <= 0.0 || cfg.tf < 0.0 || cfg.u_min > cfg.u_max {
            return Err(PidDiscreteError::InvalidConfig(
                "need ts > 0, tf >= 0, u_min <= u_max",
            ));
        }
        if cfg.d_method == Method::Forward {
            return Err(PidDiscreteError::InvalidConfig(
                "derivative has no forward method",
            ));
        }
        if cfg.d_method == Method::Tustin && cfg.tf <= 0.0 {
            return Err(PidDiscreteError::InvalidConfig(
                "Tustin derivative needs tf > 0",
            ));
        }
        Ok(Self {
            cfg,
            integral: 0.0,
            u_prev: 0.0,
            d_state: 0.0,
            e_prev: 0.0,
        })
    }

    /// One sample on the error `e = r - y`.
    pub fn update(&mut self, r: Real, y: Real) -> Real {
        let c = &self.cfg;
        let e = r - y;
        let de = e - self.e_prev;
        let d_old = self.d_state;
        self.d_state = if c.d_method == Method::Backward {
            let a = c.tf / (c.tf + c.ts);
            a * d_old + c.kd / (c.tf + c.ts) * de
        } else {
            let a = (2.0 * c.tf - c.ts) / (2.0 * c.tf + c.ts);
            a * d_old + 2.0 * c.kd / (2.0 * c.tf + c.ts) * de
        };
        let di = match c.i_method {
            Method::Forward => c.ki * c.ts * self.e_prev,
            Method::Backward => c.ki * c.ts * e,
            Method::Tustin => 0.5 * c.ki * c.ts * (e + self.e_prev),
        };
        let v = if c.form == Form::Positional {
            self.integral += di;
            c.kp * e + self.integral + self.d_state
        } else {
            self.u_prev + c.kp * de + di + (self.d_state - d_old)
        };
        let u = v.clamp(c.u_min, c.u_max);
        self.u_prev = u;
        self.e_prev = e;
        u
    }

    pub fn d_state(&self) -> Real {
        self.d_state
    }
}
```

</details>

驱动：[`rust/src/bin/ch04.rs`](https://github.com/bfmhno3/pid-lab/tree/tutorial-v1/rust/src/bin/ch04.rs)。`run_loop<const N: usize>` 接受两个闭包，一个取输出、一个取导数，两个植物的状态维数不同（2 和 3）正好用常量泛型表示。

### 编译和风格检查

编译参数和前几篇一样：C 是 `gcc -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror`（15.3.0），C++ 是 `g++ -std=c++20` 加同样的警告（15.3.0），Rust 是 rustc 1.95.0、edition 2024，`cargo clippy --release -- -D warnings`（0.1.95）。风格检查：C 用内核的 `checkpatch.pl --no-tree --ignore SPDX_LICENSE_TAG,NEW_TYPEDEFS`，全部文件 0 errors、0 warnings；C++ 用 `clang-format --style=Google`（21.1.8）；Python 用 `ruff format --line-length 79` 和 `ruff check`（0.15.14）；Rust 用 `cargo fmt --check`。

## 结果

`make ch04` 一次跑完。11 个算例乘三种语言，33 个对比文件，下面是完整输出：

```text
$ make -s ch04
ch04: C wrote 11 cases to out/ch04
ch04: C++ wrote 11 cases to out/ch04
ch04: Rust wrote 11 cases to out/ch04
ok   d_backward_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   d_backward_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   d_backward_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   d_tustin_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   d_tustin_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   d_tustin_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   form_inc_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   form_inc_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   form_inc_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   form_pos_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   form_pos_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   form_pos_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   sat_inc_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   sat_inc_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   sat_inc_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   sat_inc_raw_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   sat_inc_raw_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   sat_inc_raw_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   sat_pos_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   sat_pos_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   sat_pos_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   ts_10ms_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   ts_10ms_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   ts_10ms_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   ts_1ms_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   ts_1ms_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   ts_1ms_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   ts_20ms_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   ts_20ms_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   ts_20ms_rs.csv: max diff 0.000e+00 <= 1.0e-09
ok   ts_5ms_c.csv: max diff 0.000e+00 <= 1.0e-09
ok   ts_5ms_cpp.csv: max diff 0.000e+00 <= 1.0e-09
ok   ts_5ms_rs.csv: max diff 0.000e+00 <= 1.0e-09
speed PI at zeta 0.7, wn 30.0: kp = 4.1667, ki = 90.0000
dial PD: kp = 15.0000, kd = 0.6667
continuous loop (current lag, no delay): wc = 45.98 rad/s, PM = 62.62 deg
   ts  est loss true loss  PM cont  PM exact  wc exact     rho  overshoot  max|u|  n>20A
  1ms     3.95°     3.60°   58.67°    59.02°     46.33  0.9778     23.41%   21.87      7
  5ms    19.76°    18.59°   42.86°    44.03°     47.66  0.8608     36.40%   25.33      4
 10ms    39.52°    38.61°   23.10°    24.02°     49.45  0.8123     70.81%   29.83      3
 20ms    79.04°    84.34°  -16.42°   -21.72°     54.09  1.1555    150.42%   42.10     30

form_pos vs form_inc (no saturation): max|dy| = 4.44e-16, max|du| = 4.00e-15, max|u| = 15.18 A

        case  peak y  overshoot   max|u|  settle after drop
     sat_pos   38.77      29.2%      5.0             5.067s
     sat_inc   30.12       0.4%      5.0             0.532s
 sat_inc_raw   38.77      29.2%   1328.4             5.067s
max|y_pos - y_inc_raw| = 1.146e-13 (same arithmetic)
max|y_inc - y_positional_backcalc(tt = ts)| = 3.553e-15 (clamped accumulator is back-calculation)

       case    pole    rms u    rms d  lag-1 of d  hf share
 d_backward  +0.091    0.8597    0.8482   -0.4790    0.8079
   d_tustin  -0.667    2.8303    2.8239   -0.8261    0.9647

       case              D step response, samples 0..4  |D| at Nyquist  max|u|  rms y err
 d_backward    606.1     55.1      5.0      0.5      0.0          1111.1    6.29   1.04e-03
   d_tustin   1111.1   -740.7    493.8   -329.2    219.5          6666.7   11.10   1.04e-03
figure: figures/ch04/s-to-z.svg
figure: figures/ch04/sample-rate.svg
figure: figures/ch04/positional-vs-incremental.svg
figure: figures/ch04/tustin-ringing.svg

ch04 OK
```

33 个文件和 Python 的最大差值全部是 `0.000e+00`，逐位一致。这一章只有加减乘除和比较，没有 `atan2`、没有复数、没有 `exp`，三种语言的 `double` 运算顺序又完全一致，这个结果在意料之中。唯一值得提一句的是积分器卷绕到 1328 A 的两个算例：数值大不代表舍入误差大，位置式和 `sat_inc_raw` 之间的差只有 $1.1\times 10^{-13}$。

### 采样率：预测对了一半

连续回路（电流环加 $\omega_n = 30$ 的 PI，没有延迟）的穿越频率是 45.98 rad/s，相位裕度 62.62°。表里“est loss”列是前面的预测 $\omega_c \cdot 1.5T_s$，“true loss”列是 62.62° 减去精确采样模型（`sampled_pm`）的相位裕度，“PM cont”是用第 3 篇的 `freq` 模块给连续模型加 $1.5T_s$ 延迟算的：

| $T_s$ | est loss | true loss | PM cont | PM exact | $\omega_c$ exact | $\rho$ | 超调 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 ms | 3.95° | 3.60° | 58.67° | 59.02° | 46.33 | 0.9778 | 23.41% |
| 5 ms | 19.76° | 18.59° | 42.86° | 44.03° | 47.66 | 0.8608 | 36.40% |
| 10 ms | 39.52° | 38.61° | 23.10° | 24.02° | 49.45 | 0.8123 | 70.81% |
| 20 ms | 79.04° | 84.34° | -16.42° | -21.72° | 54.09 | 1.1555 | 150.42% |

表里 $\omega_c$ exact 的单位是 rad/s，$\rho$ 是精确采样闭环的谱半径。

![采样周期取 1、5、10、20 ms 的阶跃响应，和相位裕度随采样周期下降的曲线：20 ms 的响应是一个发散的振荡，相位裕度已经为负](/assets/images/pid-control/ch04-sample-rate.svg)

**1、5、10 ms 上，预测在 1.2° 以内。** 估计值（3.95°、19.76°、39.52°）和真实损失（3.60°、18.59°、38.61°）每一档都略大一点，差 0.35°、1.17°、0.91°。我猜这个同号的偏差来自上面推的后向欧拉积分器的半拍超前，加上 sinc 幅值的微小下降，它们都没进 $\omega_c \cdot 1.5T_s$ 的估计；“PM exact”总比“PM cont”高 0.35 到 1.17°，方向对得上，但我没有逐项把这两个修正量分离出来，所以这只是一个符号上吻合的解释。

**20 ms 上预测失效。** 估计损失 79.04°，真实损失 84.34°，差了 5.3°，更重要的是相位裕度已经是 $-21.72$°，闭环特征值的谱半径 $\rho = 1.1555$，每拍增长 15.5%。估计公式用的是无延迟回路的 $\omega_c = 45.98$ rad/s，而采样模型里真实的穿越点随 $T_s$ 在往上走：46.33、47.66、49.45，到 20 ms 是 54.09 rad/s，延迟拉长又推高穿越频率，滞后就比估计的多。这一步我只是从表上看出的趋势，没有单独验证。

**超调和相位裕度同向变化：23.4%、36.4%、70.8%。** 最后一行的 150.42% 不是超调：电流命令碰到 ±20 A 限幅（30 拍超过 20 A，控制器输出最大 42.10 A），响应变成一个幅值固定的极限环，图里的峰值在 12 rad/s 左右。（别被那个百分比骗了，它只是 $y$ 峰值除以 5 再减 1。）

**1 ms 那一行也不是完全线性的。** 阶跃一来比例项就是 $k_p \times 5 = 20.83$ A，超过 20 A 限幅，最大控制器输出 21.87 A，有 7 拍被夹住（表里最后一列）。这对 23.41% 的超调贡献很小，但表面上看起来“纯线性”的数字里混进了一点限幅，我写出来是为了你复现的时候不要奇怪。

### 位置式、增量式：不限幅时相等

`form_pos` 和 `form_inc` 是同一个 PID（$k_p = 4.17$、$k_i = 90$、$k_d = 0.02$、$t_f = 5$ ms），1 ms，设定值 2 rad/s，0.5 s 加 0.3 N·m 负载，控制器输出最大 15.18 A，没有触及任何限幅。输出的最大差：

```text
form_pos vs form_inc (no saturation): max|dy| = 4.44e-16, max|du| = 4.00e-15, max|u| = 15.18 A
```

差值是浮点舍入的量级。这是两条递推在数学上相等的最直接的证据，也是阈值 $10^{-12}$ 的来源：我没有给它留余量，因为真实差值比阈值小三个数量级。

### 限幅：增量式只有在累加器限幅时才抗饱和

三个算例，同一个 PI（1 ms），执行器限幅 ±5 A，设定值 0.1 s 起跳到 30 rad/s，1.0 s 回到 0，一共跑 8 s：

- `sat_pos`：位置式，输出夹在 ±5 A，积分不限。
- `sat_inc`：增量式，累加器夹在 ±5 A。
- `sat_inc_raw`：增量式，累加器不限（`u_min = -inf`、`u_max = inf`），只有执行器（仿真循环里的 `ua`）限幅。

```text
        case  peak y  overshoot   max|u|  settle after drop
     sat_pos   38.77      29.2%      5.0             5.067s
     sat_inc   30.12       0.4%      5.0             0.532s
 sat_inc_raw   38.77      29.2%   1328.4             5.067s
```

![位置式和不限幅的增量式曲线完全重合：轮速冲到 38.8 rad/s，再反向冲到约 -33 rad/s，来回摆动；限幅累加器的增量式在 30 rad/s 附近平稳停住，下降后 0.53 s 归零](/assets/images/pid-control/ch04-positional-vs-incremental.svg)

上图是轮速，中图是送到电机的电流，下图是增量式累加器的值（对数刻度，$\pm 5$ A 以内是线性的）。**`sat_pos` 和 `sat_inc_raw` 的轮速曲线重合：两者的最大差是 $1.146\times 10^{-13}$。** 它们的区别只是名字：把增量式的累加器放开，它就变成了位置式。蓝线和绿色虚线在图上是同一条线，我在图例里特意画了一条虚线才看得出有两条。

对位置式，轮速冲到 38.77 rad/s（超调 29.2%），因为从 0.1 s 到 1.0 s 电流一直被夹在 5 A，积分器却在一直累加：`sat_inc_raw` 里的累加器（等于位置式未限幅的和）绝对值最大到 1328.4 A，是执行器 5 A 限幅的 266 倍。设定值回到 0 之后，积分要先花时间“倒空”，期间执行器一直饱和在反方向，轮速反向冲到约 $-33$ rad/s，再来回摆，直到设定值回零之后 5.067 s 才稳定在 $\pm 1$ rad/s 以内。

对限幅累加器的增量式，轮速到 30.12 rad/s（超调 0.4%）就停住了，下降后 0.532 s 就进入 $\pm 1$ rad/s：**超调 29.2% 对 0.4%，回稳时间 5.067 s 对 0.532 s，差 9.5 倍。**

**限幅累加器就是反算抗饱和，$T_t = T_s$。** 我在数学一节推了这个等价，这里验证：驱动里 `run_case(..., back_calc=True)` 让位置式 PID 每拍执行 `pid.integral += ua - u`（把夹掉的部分加回积分），这是教科书的反算，$T_t = T_s$。它和 `sat_inc` 的轮速最大差：

```text
max|y_inc - y_positional_backcalc(tt = ts)| = 3.553e-15 (clamped accumulator is back-calculation)
```

浮点舍入的量级。所以“增量式不会卷绕”这句话，更准确的说法是：**限幅的增量式是跟踪时间常数最短的反算。** 这也有代价：$T_t$ 取一拍，意味着控制器一退出饱和，积分立刻被重置到“刚好让输出等于边界”，比 $T_t$ 取几个采样周期更激进，我猜在有测量噪声的回路里会让输出在边界附近抖。我没有测这一点，第 5 篇的 `BACK_CALC` 会把 $T_t$ 做成参数。

### Tustin 微分的振铃

`d_backward` 和 `d_tustin`：`DialPosition`（拨弹盘）上的 PD，$k_p = 15$、$k_d = 0.667$，$t_f = 0.1T_s = 0.1$ ms，测量噪声 $\sigma = 10^{-3}$ rad（`numpy` 种子 4，来自数据文件），设定值 0.01 rad。0.3 s 之后的统计：

```text
       case    pole    rms u    rms d  lag-1 of d  hf share
 d_backward  +0.091    0.8597    0.8482   -0.4790    0.8079
   d_tustin  -0.667    2.8303    2.8239   -0.8261    0.9647

       case              D step response, samples 0..4  |D| at Nyquist  max|u|  rms y err
 d_backward    606.1     55.1      5.0      0.5      0.0          1111.1    6.29   1.04e-03
   d_tustin   1111.1   -740.7    493.8   -329.2    219.5          6666.7   11.10   1.04e-03
```

![D 项对单位误差阶跃的响应：后向是单调衰减，Tustin 每拍符号翻转、衰减得很慢；中图是同一份噪声下两种 D 项的时间序列，右图是它们的幅度谱](/assets/images/pid-control/ch04-tustin-ringing.svg)

左图是 D 项对单位误差阶跃的响应（对数刻度，保留符号）：后向是 606.1、55.1、5.0、0.5，每拍乘 0.091，两拍之内就衰减了两个数量级；Tustin 是 1111.1、$-740.7$、493.8、$-329.2$、219.5，每拍乘 $-0.667$，符号翻转，衰减缓慢，**第 4 拍（从 0 数起）还有 219.5**。

第二行表里的 $|D|$ at Nyquist 是 1111.1 和 6666.7，比值 6.0：这就是前面推导的 $(2t_f + T_s)/(2t_f)$。同一份噪声下，Tustin 的 D 项 rms 是后向的 $2.8239/0.8482 = 3.33$ 倍，lag-1 自相关从 $-0.479$ 到 $-0.826$（纯白噪声的差分是 $-0.5$，所以后向这一项基本就是“噪声的差分”；Tustin 是它加上负极点带来的翻转），功率落在上半频段（高于 $f_s/4$）的比例从 80.8% 涨到 96.5%。中图和右图是同样的结论，频谱上 Tustin 的曲线整体高一截，尤其在 400 Hz 以上。

**设定值阶跃的那一脚也不一样：** 最大的控制器输出出现在阶跃那一拍，后向是 6.29 A，Tustin 是 11.10 A，对应表里的 `max|u|`。

**但我没能从输出里看到它对轮子的影响。** 两行最后一列的 rms 跟踪误差都是 $1.04\times 10^{-3}$ rad，和噪声 $\sigma = 10^{-3}$ 几乎一样，因为记录的 $y$ 是含测量噪声的读数，不是真实角度。这个指标被噪声底限住了，区分不出两者。D 项振铃的代价是在 $u$ 上：电流指令的 rms 高 3.3 倍，在每拍 $\pm$ 几安培的翻转里；M3508 的电流环带宽比 1 kHz 低得多，所以我猜电机本身不会跟着抖，但发热和 CAN 上的指令噪声是真实的代价。这是推测，我没有在真电机上测。

### 对不上的地方

- 估计公式 $\omega_c \cdot 1.5T_s$ 在 20 ms 上差了 5.3°，因为穿越频率本身被改变了。
- 表里 20 ms 的“超调”是极限环，不是线性超调。
- 1 ms 的算例有 7 拍碰到限幅，不是纯线性。
- D 项的区别只在 $u$ 上看得见，输出被噪声底盖住了。

## 下一篇

这一篇我把采样周期这个“实现细节”变成了几个数：1 ms 到 20 ms，相位裕度从 59.0° 降到 $-21.7$°，20 ms 上回路失稳，估计公式 $\omega_c \cdot 1.5T_s$ 在 10 ms 以内误差不超过 1.2°。位置式和增量式在不限幅时差 $4\times 10^{-15}$，限幅累加器的增量式等价于 $T_t = T_s$ 的反算抗饱和（轮速差 $3.6\times 10^{-15}$），不限幅的增量式则完全是位置式（差 $1.1\times 10^{-13}$）。Tustin 的微分在 $t_f \ll T_s$ 时每拍翻转符号，换来 3.3 倍的电流 rms。

[第 5 篇：工程上的坑：积分饱和、微分冲击与前馈](/posts/pid-control-05-practical/)会把这些零散的写法收成一个 PID 库：位置式，四种抗饱和（无、限幅、条件积分、反算，这一篇的“一拍反算”变成可调的 $T_t$），设定值权重和微分只看测量值来去掉微分冲击，重力前馈，以及切换增益时的无扰动处理。这一篇留下的那一脚（第一拍微分看到一个从 0 的阶跃）会在那里被处理掉。
