---
title: "交叉编译与静态链接：pkgsCross、pkgsStatic 与 splicing"
commentId: "post:nix-by-firn-12-cross-and-static"
published: "2026-11-06 04:00:00 +08:00"
description: "用 Firn 从零学 Nix 第 12 篇：我用 Nix 2.34.9 和 nixpkgs 56c02bc 把同一个 47 行 C 程序 firn-hello 编成 glibc、musl、musl 静态和 aarch64 四个版本，用 9 个实验拆开 build/host/target 与 splicing：glibc 版的闭包是 37,866,984 字节，musl 静态版只有 346,416 字节，相差 109 倍。"
category: Tutorial
tags:
  - Nix
  - NixOS
  - Firn
  - 交叉编译
  - 静态链接
  - musl
series: "用 Firn 从零学 Nix"
seriesOrder: 12
draft: false
comment: true
slug: nix-by-firn-12-cross-and-static
---

第 11 篇结尾我留了一个问题：`firn-hello` 换成 musl 静态链接，闭包会不会比 Pebble 那个 1.8 MiB 的二进制还小。我现在有答案了，而且答案比问题怪：静态版的二进制反而更大。

```text
$ head -n 4 out/ch12/static_size.stdout
package                binary      closure  paths
firn-hello              16000     37866984      6
firn-hello-musl         15672      4126656      3
firn-hello-static       61400       346416      3
```

glibc 版的闭包是 37,866,984 字节 (36.1 MiB)，静态版是 346,416 字节 (338.3 KiB)，相差 109 倍。Pebble 的二进制本身是 1,883,160 字节，整个静态闭包只有它的 18.4%。但静态版的二进制是 61,400 字节，比动态版的 16,000 字节大 3.8 倍：二进制胖了，闭包却瘦了两个数量级。这一篇我要把这个反差拆开，顺手把 Nix 里最容易被当成魔法的一套东西学明白：build、host、target 三个平台，`pkgsCross` 和 `pkgsStatic`，以及让 `nativeBuildInputs` 和 `buildInputs` 在同一个包里指向不同架构的 splicing。

> [!NOTE] 本篇检查点
> 这一篇结束时，Firn 仓库的标签 `ch12` 里：`flake.nix` 的 `packagesFor` 多了三个只在 `x86_64-linux` 上存在的包 `firn-hello-static`、`firn-hello-musl` 和 `firn-hello-aarch64`（`git diff --numstat` 显示 24 行新增、12 行删除，删除的大多是原有几行因为接上了 `//` 而改过的缩进）；`README.md` 的输出表多了一行（1 行新增）；`checks.x86_64-linux` 因此从 11 个变成 14 个（每个包一个 `pkg-<name>`）；`lab/ch12/` 下有 9 个实验（7 个 `.sh` 和 2 个 `.nix`）和 1 个 fixture 文件。`pkgs/firn-hello/package.nix`、`overlays/default.nix` 和 `default.nix` 没有变：三个交叉和静态构建没有暴露出这个包里的任何 bug。`make ch12` 全部 `ok`。
> 涉及的 Nix 特性：`stdenv.buildPlatform`、`hostPlatform`、`targetPlatform`，`lib.systems.elaborate` 与 `lib.systems.examples`，`pkgsCross`、`pkgsStatic`、`pkgsMusl`，splicing (`__spliced`, `buildHost`, `hostTarget`)，`strictDeps`，`doInstallCheck` 与 `canExecute`，`stdenvAdapters.makeStatic`，`propagatedBuildInputs`，`nix develop --file`，`nix log`，`nix path-info`，qemu-user。
> 前置：[第 11 篇：打包真项目：Cairn、Sift 与 Pebble](/posts/nix-by-firn-11-packaging-real-projects/)。这一篇用的包是第 10 篇的 `firn-hello`，依赖分类是第 7 篇讲过的偏移量，只是这次真的有两个平台了。
> 终稿与否：`lab/ch12/*` 在这里就是终稿；`README.md` 和 `flake.nix` 之后每次加包还会改。

## 环境

这一篇所有输出来自这台机器：NixOS 26.05，Linux 6.18.59，`x86_64`，上游 Nix 2.34.9，nixpkgs 钉在 `56c02bc00adcf003215cc4bd996d6efaf4cff188`。文中引用的 nixpkgs 源码都链接到这个 rev，行号我都在本地那份源码上核对过。这个 rev 上几个相关的版本：

```text
$ nix eval --impure --json --expr '
  let
    p = import ./nix/pkgs.nix { };
  in
  {
    gcc = p.gcc.version;
    glibc = p.glibc.version;
    musl = p.musl.version;
    qemu = p.qemu.version;
  }
' | jq -c .
{"gcc":"15.3.0","glibc":"2.42","musl":"1.2.6","qemu":"11.1.0"}
```

我的 shell 里设了 `CI=true`，Firn 的运行器会据此跳过 `_host` 实验。这一章有一个 `_host` 实验 (`riscv64_host.sh`)，所以我跑的是 `env -u CI make ch12`。这条命令（含 `nix develop` 的启动）在这台机器上花了 15.6 秒，我在写之前已经把三个交叉包和它们的工具链都放进了 store。冷启动大概慢得多（`riscv64_host.sh` 头注释记着冷 store 要下载 130.6 MiB），但我没有量过。

## 三个平台字段：build、host、target

这三个词不是 Nix 发明的，是 autoconf 留下来的。Nixpkgs 手册的[交叉编译一章](https://nixos.org/manual/nixpkgs/unstable/#chap-cross)开头就写着 Nixpkgs 遵循 GNU autoconf 的惯例。[Autoconf 手册](https://www.gnu.org/software/autoconf/manual/autoconf-2.72/html_node/Specifying-Target-Triplets.html)里，`./configure` 有三个选项：`--build` 是配置和编译这个包的那台机器的系统类型，`--host` 是这个包运行的那台机器，`--target` 是包里任何编译器类工具产出的代码要运行的机器，手册给它的标注是 rarely needed。`--host` 和 `--build` 不同，就进入交叉编译模式；手册还说，这时构建工具默认带 `host-type-` 前缀，比如 `host-type-gcc`。

Nixpkgs 把这三个词做成了 `stdenv` 的三个字段。`lab/ch12/platforms.nix` 只求值，不构建任何东西，把原生、`pkgsStatic` 和 `pkgsCross.aarch64-multiplatform` 各取一份，最后再列出 `lib.systems.elaborate "aarch64-linux"` 的几个字段：

```nix
let
  pkgs = import ../../nix/pkgs.nix { };
  inherit (pkgs) lib;
  triple = set: {
    build = set.stdenv.buildPlatform.config;
    host = set.stdenv.hostPlatform.config;
    target = set.stdenv.targetPlatform.config;
  };
  aarch64 = lib.systems.elaborate "aarch64-linux";
in
{
  native = triple pkgs;
  pkgsStatic = triple pkgs.pkgsStatic;
  pkgsCrossAarch64 = triple pkgs.pkgsCross.aarch64-multiplatform;
  elaborateAarch64Linux = {
    inherit (aarch64)
      config
      system
      libc
      linuxArch
      isAarch64
      isLinux
      isStatic
      ;
    cpu = aarch64.parsed.cpu.name;
    kernel = aarch64.parsed.kernel.name;
    abi = aarch64.parsed.abi.name;
    sharedLibrary = aarch64.extensions.sharedLibrary;
    nativeCanExecute = pkgs.stdenv.buildPlatform.canExecute aarch64;
  };
}
```

`make ch12` 对这个文件的输出 (`out/ch12/platforms.stdout`) 是 `nix eval --file` 的原样打印，一行，长得没法读。同一个文件，`--json` 再交给 `jq` 排版（手敲，不在 `lab/ch12/` 里）：

```text
$ nix eval --json --file lab/ch12/platforms.nix | jq .
{
  "elaborateAarch64Linux": {
    "abi": "gnu",
    "config": "aarch64-unknown-linux-gnu",
    "cpu": "aarch64",
    "isAarch64": true,
    "isLinux": true,
    "isStatic": false,
    "kernel": "linux",
    "libc": "glibc",
    "linuxArch": "arm64",
    "nativeCanExecute": false,
    "sharedLibrary": ".so",
    "system": "aarch64-linux"
  },
  "native": {
    "build": "x86_64-unknown-linux-gnu",
    "host": "x86_64-unknown-linux-gnu",
    "target": "x86_64-unknown-linux-gnu"
  },
  "pkgsCrossAarch64": {
    "build": "x86_64-unknown-linux-gnu",
    "host": "aarch64-unknown-linux-gnu",
    "target": "aarch64-unknown-linux-gnu"
  },
  "pkgsStatic": {
    "build": "x86_64-unknown-linux-gnu",
    "host": "x86_64-unknown-linux-musl",
    "target": "x86_64-unknown-linux-musl"
  }
}
```

三组 `build`、`host`、`target` 里，有两个是我想看的结果。

原生的三个字段是同一个字符串 `x86_64-unknown-linux-gnu`，没有什么可说的。`pkgsCrossAarch64` 里 `build` 是 `x86_64-unknown-linux-gnu`，`host` 和 `target` 都是 `aarch64-unknown-linux-gnu`：我这台 x86 机器负责编，产物在 ARM 上跑。

`pkgsStatic` 才是让我多看了两眼的：`build` 是 glibc，`host` 和 `target` 是 musl。一个“静态链接”的包集，从 Nix 的角度居然是一次交叉编译，目标平台是 `x86_64-unknown-linux-musl`。

为什么 `host` 和 `target` 在普通包里总是同一个值？因为 `pkgs/stdenv/cross/default.nix` 在构造“要运行的那一层” stdenv 的时候，把两个字段都设成 `crossSystem`：

```nix
# pkgs/stdenv/cross/default.nix:43-46
        buildPackages.stdenv.override (old: rec {
          buildPlatform = localSystem;
          hostPlatform = crossSystem;
          targetPlatform = crossSystem;
```

[43 到 46 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/cross/default.nix#L43-L46)就是这件事的全部。`targetPlatform` 要和 `hostPlatform` 不同，只有打包编译器的时候：一个跑在 x86 上、产出 aarch64 代码的 gcc，`host` 是 x86，`target` 是 aarch64。`splicing.nix` 的输出里就有这样一个包：`aarch64-unknown-linux-gnu-pkg-config-wrapper`，它的 `hostPlatform` 是 x86_64，`targetPlatform` 是 aarch64，名字前缀是 `target` 的三元组，和 autoconf 手册那句话一致。

### 一个字符串怎么变成一个平台

`lib.systems.elaborate` 把一个只有 `config` 或 `system` 的最小描述展开成 `platforms.nix` 输出里的那些字段。`elaborateAarch64Linux` 那一组有三个值得停一下的地方：

- `linuxArch = "arm64"`：Nix 管这个 CPU 叫 `aarch64`，内核源码树里的目录叫 `arm64`。`elaborate` 的工作之一就是记住这种别名，[`lib/systems/default.nix` 的 334 到 345 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/systems/default.nix#L334-L345)是 `linuxArch` 的映射，`elaborate` 本身从 [88 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/systems/default.nix#L88)开始。
- `isStatic = false`：这个字段对 `aarch64-linux` 是 `false`，[318 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/systems/default.nix#L318)的定义是 `final.isWasi || final.isRedox`，也就是说它默认只对没有动态库的平台为真，`pkgsStatic` 是通过 `crossSystem` 显式把它设成 `true` 的。
- `nativeCanExecute = false`：我这台 x86_64 的 `buildPlatform` 能不能直接执行 aarch64 的二进制。这个值来自 `canExecute`：

```nix
# lib/systems/default.nix:137-151
        canExecute =
          platform:
          final.isAndroid == platform.isAndroid
          && parse.isCompatible final.parsed.cpu platform.parsed.cpu
          && final.parsed.kernel == platform.parsed.kernel
          && (
            # Only perform this check when cpus have the same type;
            # assume compatible cpu have all the instructions included
            final.parsed.cpu == platform.parsed.cpu
            ->
              # if platform has gcc.arch, final must also have and can execute the gcc.arch of platform
              (
                platform ? gcc.arch -> final ? gcc.arch && architectures.canExecute final.gcc.arch platform.gcc.arch
              )
          );
```

[137 到 151 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/systems/default.nix#L137-L151)按顺序检查：Android 与否一致、CPU 兼容、**内核相同**、同 CPU 时指令集够不够。里面没有 libc。所以 x86_64 的 glibc 机器 `canExecute` x86_64 的 musl 平台是 `true`（内核都是 Linux，CPU 一样），而 aarch64 是 `false`。`doInstallCheck` 的取值就来自这个函数。

最后是 `pkgsCross` 的来历。`lib.systems.examples` 是一张“名字到最小平台描述”的表，`pkgsCross` 是它的 `mapAttrs`，[`stage.nix` 的 209 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/stage.nix#L209)：

```nix
# pkgs/top-level/stage.nix:209-209
    pkgsCross = lib.mapAttrs (n: crossSystem: nixpkgsFun { inherit crossSystem; }) lib.systems.examples;
```

我用的 `aarch64-multiplatform`，在这张表里[只有三行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/systems/examples.nix#L71-L73)：

```nix
# lib/systems/examples.nix:71-73
  aarch64-multiplatform = {
    config = "aarch64-unknown-linux-gnu";
  };
```

整个“64 位 ARM Linux”的定义就是一个三元组字符串，其余字段 (`cpu`, `kernel`, `abi`, `libc = glibc`) 都是 `elaborate` 从三元组里推出来的。这张表有多少项，`pkgsCross` 里就有多少个完整的 nixpkgs。

## 接线：三个包，和为什么 overlay 到处都在

任务很短：在 `flake.nix` 里给三个新包起名字。我只改了 `packagesFor`，其余的 `package.nix` 一个字没动（`git diff --name-only ch11 ch12` 里没有它）：

```nix
      packagesFor =
        system:
        {
          inherit (pkgsFor system)
            firn-hello
            cairn
            sift
            pebble
            firn-tools
            cairn-report
            ;
          firn-hello-hallo = (pkgsFor system).firn-hello.override { greeting = "Hallo"; };
          default = (pkgsFor system).firn-hello;
        }
# ...
        // nixpkgs.lib.optionalAttrs (system == "x86_64-linux") {
          firn-hello-static = (pkgsFor system).pkgsStatic.firn-hello;
          firn-hello-musl = (pkgsFor system).pkgsMusl.firn-hello;
          firn-hello-aarch64 = (pkgsFor system).pkgsCross.aarch64-multiplatform.firn-hello;
        };
```

有两件事需要讲。第一，三个包都放在 `optionalAttrs (system == "x86_64-linux")` 里：`aarch64-linux` 机器上的 `pkgsCross.aarch64-multiplatform` 是原生编译，没有意义；而 `checks` 是用 `mapAttrs'` 从 `packagesFor` 里生成的（`pkg-<name>` 每个包一份），所以三个新包自动就是三个新检查：

```nix
        # 每个包一个 pkg-<name> 检查；default 只是别名，不重复。
        // pkgs.lib.mapAttrs' (name: pkg: pkgs.lib.nameValuePair "pkg-${name}" pkg) (
          removeAttrs (packagesFor system) [ "default" ]
        );
```

`checks.x86_64-linux` 现在有 14 个：

```text
$ nix eval --json .#checks.x86_64-linux --apply builtins.attrNames | jq -c .
["dev-shell","lib-tests","mini-site","pkg-cairn","pkg-cairn-report","pkg-firn-hello","pkg-firn-hello-aarch64","pkg-firn-hello-hallo","pkg-firn-hello-musl","pkg-firn-hello-static","pkg-firn-tools","pkg-pebble","pkg-sift","readme-table"]
```

第二，也是我最想弄明白的：`(pkgsFor system).pkgsStatic.firn-hello` 里的 `firn-hello` 哪来的？nixpkgs 里没有叫 `firn-hello` 的包，它是我的 overlay 加的。`pkgsStatic`、`pkgsMusl` 和 `pkgsCross.*` 都是另外构造出来的 nixpkgs，overlay 怎么会跟进去？先量，再查源码（手敲，不在 `lab/ch12/` 里）：

```text
$ nix eval --impure --json --expr '
  let
    a = import ./nix/pkgs.nix { };
    b = import ./nix/pkgs.nix { overlays = [ ]; };
    has = p: map (s: s ? firn-hello) [
      p
      p.pkgsStatic
      p.pkgsMusl
      p.pkgsCross.aarch64-multiplatform
    ];
  in
  {
    with_overlay = has a;
    without_overlay = has b;
    cross_sets = builtins.length (builtins.attrNames a.pkgsCross);
  }
' | jq -c .
{"cross_sets":87,"with_overlay":[true,true,true,true],"without_overlay":[false,false,false,false]}
```

四个包集（原生、`pkgsStatic`、`pkgsMusl`、`pkgsCross.aarch64-multiplatform`）带 overlay 的时候都有 `firn-hello`，不带的时候一个都没有；`cross_sets` 是 `pkgsCross` 里包集的数量，87 个，每个都是一整个 nixpkgs。机制在 `pkgs/top-level/default.nix` 里，[195 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/default.nix#L195)：

```nix
# pkgs/top-level/default.nix:195-195
  nixpkgsFun = newArgs: import ./. (args // newArgs);
```

`args` 是调用 `import nixpkgs { ... }` 时的整个参数，包括 `overlays` 和 `config`。`nixpkgsFun` 拿同一份 `args` 再 `import` 一次 nixpkgs，只换 `newArgs`。`pkgsCross` 的 `nixpkgsFun { inherit crossSystem; }`（`stage.nix` 的 209 行）没有碰 `overlays`，所以 overlay 原样继承。

而 `pkgsStatic` 和 `pkgsMusl` 自己要往 `overlays` 里塞一个标记 (`pkgsStatic = super';`)，所以它们**替换**了 `overlays`，再把原来的接回去。[`stage.nix` 的 285 到 310 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/stage.nix#L285-L310)：

```nix
# pkgs/top-level/stage.nix:285-310
    pkgsStatic = nixpkgsFun {
      overlays = [
        (
          self': super':
          {
            pkgsStatic = super';
          }
          // lib.optionalAttrs super'.stdenv.hostPlatform.isMusl {
            pkgsMusl = super';
          }
        )
      ]
      ++ overlays;
      crossSystem = {
        isStatic = true;
        config = lib.systems.parse.tripleFromSystem (
          if stdenv.hostPlatform.isLinux then
            lib.systems.parse.mkMuslSystem stdenv.hostPlatform.parsed
          else
            stdenv.hostPlatform.parsed
        );
        gcc =
          lib.optionalAttrs (stdenv.hostPlatform.system == "powerpc64-linux") { abi = "elfv2"; }
          // stdenv.hostPlatform.gcc or { };
      };
    };
```

重点是第 297 行的 `++ overlays`。`flake.nix` 的 `packagesFor` 里，`// nixpkgs.lib.optionalAttrs` 前有一条注释（接线一节的摘录用 `# ...` 省掉了它），写的就是这个区别：`pkgsCross` 不动 `overlays`，原样沿用 `args` 里的；`pkgsStatic` 和 `pkgsMusl` 先替换再追加回去。没有那个 `++ overlays`，`pkgsStatic` 里就看不到我的 `firn-hello` 了。

overlay 到了哪一层，也值得看一眼。`stage.nix` 里整个包集是一串层叠加出来的，[335 到 356 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/stage.nix#L335-L356)：

```nix
# pkgs/top-level/stage.nix:335-356
  # The complete chain of package set builders, applied from top to bottom.
  # stdenvOverlays must be last as it brings package forward from the
  # previous bootstrapping phases which have already been overlaid.
  toFix = lib.foldl' (lib.flip lib.extends) (self: { }) (
    [
      stdenvBootstappingAndPlatforms
      stdenvAdapters
      trivialBuilders
      splice
      autoCalledPackages
      allPackages
      otherPackageSets
      aliases
      variants
      configOverrides
      internallyDisallowedAttrPathsOverlay
    ]
    ++ overlays
    ++ [
      stdenvOverrides
    ]
  );
```

用户的 `overlays` 排在 `splice`、`allPackages`、`otherPackageSets` 之后，只比 `stdenvOverrides` 早一层。所以我的 overlay 里的 `final` 是**这一个**包集的最终结果：在 `pkgsCross.aarch64-multiplatform` 里，`final.callPackage ../pkgs/firn-hello/package.nix { }` 的 `final` 就是 aarch64 那个包集，它的 `callPackage` 是 splicing 版本的（`splice` 是更早叠上去的一层）。`package.nix` 一个字不改就能交叉编译，靠的是这一点。

### pkgsMusl 不是交叉编译，pkgsStatic 是

名字很像，两个包集的构造方式不一样。看 `pkgsMusl`，[`variants.nix` 的 66 到 82 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/variants.nix#L66-L82)：

```nix
# pkgs/top-level/variants.nix:66-82
  pkgsMusl =
    if stdenv.hostPlatform.isLinux && (stdenv.buildPlatform.is64bit || stdenv.buildPlatform.isx86) then
      nixpkgsFun {
        overlays = [
          (self': super': {
            pkgsMusl = super';
          })
        ]
        ++ overlays;
        ${if stdenv.hostPlatform == stdenv.buildPlatform then "localSystem" else "crossSystem"} = {
          config = lib.systems.parse.tripleFromSystem (
            lib.systems.parse.mkMuslSystem stdenv.hostPlatform.parsed
          );
        };
      }
    else
      throw "Musl libc only supports 64-bit Linux systems, and i686-linux.";
```

第 75 行是关键：`${if stdenv.hostPlatform == stdenv.buildPlatform then "localSystem" else "crossSystem"}`。我在 x86_64-linux 上，当前 `hostPlatform` 等于 `buildPlatform`，于是 `pkgsMusl` 走 `localSystem`：整个包集（包括 gcc、binutils、bash）都是用 musl **原生**构建的，没有交叉。`pkgsStatic` 则无论如何走 `crossSystem`（`stage.nix` 的 298 行），所以它是从 glibc 的 x86_64 到 musl 的 x86_64 的一次“交叉”。这个区别可以直接量出来（手敲，不在 `lab/ch12/` 里）：

```text
$ nix eval --impure --json --expr '
  let
    p = import ./nix/pkgs.nix { };
    t = s: {
      build = s.stdenv.buildPlatform.config;
      host = s.stdenv.hostPlatform.config;
      spliced = s.zlib ? __spliced;
      name = s.firn-hello.name;
    };
  in
  {
    native = t p;
    pkgsMusl = t p.pkgsMusl;
    pkgsStatic = t p.pkgsStatic;
  }
' | jq .
{
  "native": {
    "build": "x86_64-unknown-linux-gnu",
    "host": "x86_64-unknown-linux-gnu",
    "name": "firn-hello-0.1.0",
    "spliced": false
  },
  "pkgsMusl": {
    "build": "x86_64-unknown-linux-musl",
    "host": "x86_64-unknown-linux-musl",
    "name": "firn-hello-0.1.0",
    "spliced": false
  },
  "pkgsStatic": {
    "build": "x86_64-unknown-linux-gnu",
    "host": "x86_64-unknown-linux-musl",
    "name": "firn-hello-static-x86_64-unknown-linux-musl-0.1.0",
    "spliced": true
  }
}
```

`pkgsMusl` 的 `build` 也是 musl，`spliced = false`，包名里没有主机后缀：`firn-hello-0.1.0`。`pkgsStatic` 的 `build` 是 glibc，`spliced = true`，包名带上了 `static` 标记和主机三元组：`firn-hello-static-x86_64-unknown-linux-musl-0.1.0`。后缀是 `make-derivation.nix` 在 `hostPlatform != buildPlatform` 的时候加的，[359 到 361 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L359-L361)：

```nix
# pkgs/stdenv/generic/make-derivation.nix:359-361
  hostSuffixNecessary = hostPlatform != buildPlatform && stdenvHasCC;
  stdenvHostSuffix = "-${hostPlatform.config}";
  stdenvStaticMarker = optionalString isStatic "-static";
```

nixpkgs 自己的 Hydra 配置里也有一句注释，说的是同一回事：[`release-haskell.nix` 的 369 到 371 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/release-haskell.nix#L369-L371)写着“pkgsMusl is compiled natively with musl. It is not cross-compiled (unlike pkgsStatic).”

还有一个反过来的例子。`pkgsCross.gnu64` 听起来是交叉，实际上 `crossSystem` 展开后和 `localSystem` 相等，nixpkgs 就把它当原生（[`default.nix` 的 133 到 137 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/default.nix#L133-L137)）。`drvPath` 能证明这一点（手敲，不在 `lab/ch12/` 里）：

```text
$ nix eval --impure --json --expr '
  let
    p = import ./nix/pkgs.nix { };
    c = p.pkgsCross;
  in
  {
    gnu64_is_native = c.gnu64.firn-hello.drvPath == p.firn-hello.drvPath;
    musl64_is_static = c.musl64.firn-hello.drvPath == p.pkgsStatic.firn-hello.drvPath;
    musl64_is_musl = c.musl64.firn-hello.drvPath == p.pkgsMusl.firn-hello.drvPath;
    musl64_name = c.musl64.firn-hello.name;
    sets = builtins.length (builtins.attrNames c);
  }
' | jq .
{
  "gnu64_is_native": true,
  "musl64_is_musl": false,
  "musl64_is_static": false,
  "musl64_name": "firn-hello-x86_64-unknown-linux-musl-0.1.0",
  "sets": 87
}
```

`gnu64_is_native` 是 `true`：`pkgsCross.gnu64.firn-hello` 和原生的 `firn-hello` 是同一个 derivation，包名里也没有主机后缀。`pkgsCross.musl64` 才是一个真正不同的东西：它既不等于 `pkgsStatic` 的，也不等于 `pkgsMusl` 的，名字是 `firn-hello-x86_64-unknown-linux-musl-0.1.0`，从 glibc 到 musl 的交叉，动态链接，没有 `-static` 标记。

这四个包的二进制是什么样的，`file` 能直接回答。

## file：四个二进制

`lab/ch12/file_types.sh` 对四个包各跑一次 `file`。输出里的 store 哈希和 `BuildID` 太长，脚本里用 `sed` 去掉了：

```bash
for name in firn-hello firn-hello-static firn-hello-musl firn-hello-aarch64; do
  out="$(nix build --no-link --print-out-paths "${FIRN_ROOT}#${name}")"
  printf '== %s\n' "${name}"
  file --brief "${out}/bin/firn-hello" \
    | sed -E 's|/nix/store/[a-z0-9]{32}-||g; s/, BuildID\[sha1\]=[0-9a-f]+//'
done
```

```text
$ cat out/ch12/file_types.stdout
== firn-hello
ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter glibc-2.42-67/lib/ld-linux-x86-64.so.2, for GNU/Linux 3.10.0, not stripped
== firn-hello-static
ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked, not stripped
== firn-hello-musl
ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter musl-1.2.6/lib/ld-musl-x86_64.so.1, not stripped
== firn-hello-aarch64
ELF 64-bit LSB pie executable, ARM aarch64, version 1 (SYSV), dynamically linked, interpreter glibc-aarch64-unknown-linux-gnu-2.42-67/lib/ld-linux-aarch64.so.1, for GNU/Linux 3.10.0, not stripped
```

四行里能读出来的东西：

- `firn-hello`：`x86-64`，动态链接，解释器是 `glibc-2.42-67/lib/ld-linux-x86-64.so.2`。这是第 10 篇的老朋友。
- `firn-hello-static`：`statically linked`，没有 `interpreter` 字段，也没有 `pie`，是普通的 `executable`。我没查为什么这里不是 `pie`（cc-wrapper 的 `pie` 加固在 `-static` 下没起作用，还是别的原因），所以不在这里下结论。
- `firn-hello-musl`：动态链接，但解释器是 `musl-1.2.6/lib/ld-musl-x86_64.so.1`：musl 自己的动态加载器。
- `firn-hello-aarch64`：`ARM aarch64`，解释器是 `glibc-aarch64-unknown-linux-gnu-2.42-67/lib/ld-linux-aarch64.so.1`。这个 glibc 的名字里有 `aarch64-unknown-linux-gnu`：它是 `hostPlatform` 的三元组，和第 10 篇里 `firn-hello` 的原生 glibc 名字不一样。

同样是 `-lz`，同样一份 C，四个二进制的头部（解释器）完全不一样。头部之外，大小也不一样：`firn-hello-aarch64` 是 70,552 字节，比 x86_64 的 16,000 字节大 4.4 倍，两个都没有 strip。我用 `readelf` 看了每个 `LOAD` 段的对齐（手敲，不在 `lab/ch12/` 里）：

```text
$ for a in firn-hello firn-hello-aarch64; do
  b="$(nix build --no-link --print-out-paths ".#${a}")/bin/firn-hello"
  echo "${a}: $(stat --format=%s "${b}") bytes, LOAD align" \
    "$(readelf -lW "${b}" | awk '/LOAD/ { print $NF }' | sort -u | tr '\n' ' ')"
done
firn-hello: 16000 bytes, LOAD align 0x1000 
firn-hello-aarch64: 70552 bytes, LOAD align 0x10000 
```

x86_64 的段按 `0x1000`(4 KiB) 对齐，aarch64 的按 `0x10000`(64 KiB) 对齐。我猜多出来的 54,552 字节主要是为这个对齐在文件里留的空洞，没有逐段核对。

闭包也不一样：aarch64 版是 4 个路径、47,639,304 字节 (45.4 MiB)，原生版是 6 个路径、37,866,984 字节 (36.1 MiB)。aarch64 版的路径（手敲，不在 `lab/ch12/` 里；第二列是每个路径自己的闭包大小）：

```text
$ out="$(nix build --no-link --print-out-paths .#firn-hello-aarch64)"
nix path-info -rS "${out}" | sed -E 's|/nix/store/[a-z0-9]{32}-||'
libgcc-aarch64-unknown-linux-gnu-15.3.0   	     714128
glibc-aarch64-unknown-linux-gnu-2.42-67   	   47420352
zlib-aarch64-unknown-linux-gnu-1.3.2      	   47568264
firn-hello-aarch64-unknown-linux-gnu-0.1.0	   47639304
```

## 在 x86_64 上跑 aarch64：qemu，和没有运行过的 installCheckPhase

`firn-hello-aarch64` 编出来了，`file` 说它是 ARM 的 ELF。它到底对不对，我这台 x86_64 机器自己没法执行它。办法是 qemu 的用户态模拟：`qemu-aarch64` 把一个 aarch64 的 Linux 程序当成普通进程解释执行，系统调用转给宿主内核（[QEMU 手册](https://www.qemu.org/docs/master/user/main.html)）。`lab/ch12/run_aarch64.sh` 用 `nix build --file nix/pkgs.nix qemu` 拿到 `qemu-aarch64`，让它跑交叉版，再和原生版逐字节对比：

```bash
qemu="$(nix build --no-link --print-out-paths --file "${FIRN_ROOT}/nix/pkgs.nix" qemu)"
readonly qemu
cross="$(nix build --no-link --print-out-paths "${FIRN_ROOT}#firn-hello-aarch64")"
readonly cross
native="$(nix build --no-link --print-out-paths "${FIRN_ROOT}#firn-hello")"
readonly native

echo "== qemu-aarch64 firn-hello nix"
"${qemu}/bin/qemu-aarch64" "${cross}/bin/firn-hello" nix | tee "${LAB_TMP}/cross.txt"

echo
echo "== native firn-hello nix"
"${native}/bin/firn-hello" nix | tee "${LAB_TMP}/native.txt"
# ...
echo
echo "== direct execution without qemu"
bash -c "\"\$1\" nix" bash "${cross}/bin/firn-hello" 2>&1 \
  | sed -E 's|/nix/store/[a-z0-9]{32}-||g; s|^bash: line [0-9]+: |bash: |' || true

echo
echo "== doInstallCheck in the derivation"
for attr in firn-hello firn-hello-aarch64; do
  echo "${attr}: $(nix eval --json "${FIRN_ROOT}#packages.x86_64-linux.${attr}.doInstallCheck" 2>/dev/null)"
done
```

```text
$ cat out/ch12/run_aarch64.stdout
== qemu-aarch64 firn-hello nix
Hello, nix, from firn-hello 0.1.0
crc32: 8bb8f4d3

== native firn-hello nix
Hello, nix, from firn-hello 0.1.0
crc32: 8bb8f4d3

outputs are identical

== direct execution without qemu
bash: firn-hello-aarch64-unknown-linux-gnu-0.1.0/bin/firn-hello: cannot execute binary file: Exec format error

== doInstallCheck in the derivation
firn-hello: true
firn-hello-aarch64: false
```

三段输出，三件事。

**交叉版和原生版的输出逐字节相同。** `crc32: 8bb8f4d3` 是 zlib 对 `Hello, nix, from firn-hello 0.1.0` 这一行算的校验和，和架构没有关系，所以必须一样，而它一样。这是我能给“这个 aarch64 二进制是对的”最强的证据：它在另一个指令集上，链接了另一份 zlib(`zlib-aarch64-unknown-linux-gnu-1.3.2`)，得到同一个答案。

**不借 qemu 直接执行，内核说 `Exec format error`。** 这台机器的 `binfmt_misc` 里没有注册任何东西，内核不认识 aarch64 的 ELF 头。这个状态可以量（手敲，不在 `lab/ch12/` 里）：

```text
$ ls /proc/sys/fs/binfmt_misc | wc -l; nix config show extra-platforms
0
i686-linux x86_64-v1-linux x86_64-v2-linux x86_64-v3-linux
```

第一行是 `/proc/sys/fs/binfmt_misc` 里的条目数，0。第二行是 `extra-platforms`：这些是这台机器上 Nix 额外愿意构建的平台，里面是 `i686-linux` 和几个 `x86_64-v*-linux`，没有 `aarch64-linux`。让 Nix 直接构建一个 `system = "aarch64-linux"` 的 derivation，它会拒绝（手敲，不在 `lab/ch12/` 里；`grep` 只留原因那三行）：

```text
$ nix build --no-link --impure --expr '
  derivation {
    name = "x";
    system = "aarch64-linux";
    builder = "/bin/sh";
    args = [ "-c" "echo > $out" ];
  }
' 2>&1 | grep -E 'Reason|Required|Current'
       Reason: platform mismatch
       Required system: 'aarch64-linux'
       Current system: 'x86_64-linux'
```

所以我既不能直接运行 aarch64 二进制，也不能让 Nix 在这台机器上构建 `aarch64-linux` 的 derivation，交叉编译是唯一的路。

**`doInstallCheck` 在交叉版里是 `false`。** `run_aarch64.sh` 末尾把 `package.nix` 里写的 `doInstallCheck = true` 在两个 derivation 里读出来：原生 `true`，aarch64 `false`。`package.nix` 一个字没变，值却变了。原因在 `make-derivation.nix`：

```nix
# pkgs/stdenv/generic/make-derivation.nix:464-465
      doCheck' = doCheck && canExecuteHostOnBuild;
      doInstallCheck' = doInstallCheck && canExecuteHostOnBuild;
```

[464 和 465 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L464-L465)把你写的 `doCheck` 和 `doInstallCheck` 都和 `canExecuteHostOnBuild` 取交集，后者在 [357 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L357)定义为 `buildPlatform.canExecute hostPlatform`，也就是 `canExecute`。交叉到一个 `buildPlatform` 执行不了的 `hostPlatform`，所有检查阶段都被悄悄关掉，不报警，不失败。

构建日志可以证实它真的没运行。原生版和交叉版的阶段列表，一行一个，`diff` 一下（手敲，不在 `lab/ch12/` 里）：

```text
$ diff \
  <(nix log .#firn-hello 2>&1 | grep 'Running phase') \
  <(nix log .#firn-hello-aarch64 2>&1 | grep 'Running phase')
3a4
> Running phase: updateAutotoolsGnuConfigScriptsPhase
8d8
< Running phase: installCheckPhase
```

`<` 是原生版独有的：`installCheckPhase`。`>` 是交叉版独有的：多了一个 `updateAutotoolsGnuConfigScriptsPhase`。我没有追它：`pkgs/stdenv/cross/default.nix` 的 [57 到 74 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/cross/default.nix#L57-L74)给部分交叉目标额外塞了 `updateAutotoolsGnuConfigScriptsHook`，我猜是它，没有验证。

`pkgsStatic` 和 `pkgsMusl` 的 `canExecute` 是 `true`（内核和 CPU 相同，libc 不参与比较），它们的检查照常运行（手敲，不在 `lab/ch12/` 里）：

```text
$ for a in firn-hello-static firn-hello-musl; do
  echo "${a}: $(nix eval --json .#packages.x86_64-linux.${a}.doInstallCheck)"
done
firn-hello-static: true
firn-hello-musl: true
```

所以 `pkg-firn-hello-aarch64` 这个 flake 检查证明的只是“能编、能链接”，`package.nix` 里那条 `test "$first" = ...` 对它从来没有执行过。要让它运行，要么像 `run_aarch64.sh` 这样手动借 qemu，要么让内核自动借：`boot.binfmt.emulatedSystems`。

## splicing：同一个名字，两份包

第 7 篇我把依赖分成了六类，每类一个偏移量对：`nativeBuildInputs` 是 build → host（偏移 -1 → 0），`buildInputs` 是 host → target(0 → 1)。那一篇也说了，在原生构建里这张表只是标签，什么都不改变，因为 build、host、target 是同一台机器。当时我欠了一句：怎么从同一个包集里取出两份不同平台的依赖，留给这一篇。

交叉编译让标签第一次有了后果。`firn-hello` 要两样东西：

- `pkg-config`：构建时在 Makefile 里被调用，必须能在**构建机**上跑。
- `zlib`：链接进产物，必须是**目标机**的版本。

我手边有一个类比，只用这一次：给一本外文书做翻译，词典放在译者的桌上，是为了翻译时查，书印出来以后读者不需要它；书里引用的原文片段则必须随书出厂，读者要读。`nativeBuildInputs` 是桌上的词典，`buildInputs` 是随书印出的引文。词典换成读者所在国的版本，译者就查不了了；引文用了译者国家的版本，读者就读不懂了。

问题是 `package.nix` 的头一行是 `{ lib, stdenv, pkg-config, zlib, greeting ? "Hello" }:`，每个名字只有一个参数位。`callPackage` 只能给 `pkg-config` 一个值。这一个值怎么既是 x86_64 的又是 aarch64 的？

答案是：它给的是一个**带着另一份的值**。`pkgs/top-level/splice.nix` 开头的注释把设计讲得很直白：

```nix
# pkgs/top-level/splice.nix:8-17
# The solution is to splice the package sets together as we do below, so every
# `callPackage`d expression in fact gets both versions. Each derivation (and
# each derivation's outputs) consists of the run-time version, augmented with
# a `__spliced.buildHost` field for the build-time version, and
# `__spliced.hostTarget` field for the run-time version.
#
# For performance reasons, rather than uniformally splice in all cases, we only
# do so when `pkgs` and `buildPackages` are distinct. The `actuallySplice`
# parameter there the boolean value of that equality check.
lib: pkgs: actuallySplice:
```

[8 到 17 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/splice.nix#L8-L17)：每个 derivation 是它的运行时版本，外加一个 `__spliced.buildHost` 字段（构建时版本）和 `__spliced.hostTarget` 字段（运行时版本）。真正拼起来的是 `spliceReal`，[23 到 34 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/splice.nix#L23-L34)先把六个相邻包集合并成一个 `mash`：

```nix
# pkgs/top-level/splice.nix:23-34
  spliceReal =
    inputs:
    let
      mash =
        # Other pkgs sets
        inputs.buildBuild
        // inputs.buildTarget
        // inputs.hostHost
        // inputs.targetTarget
        # The same pkgs sets one probably intends
        // inputs.buildHost
        // inputs.hostTarget;
```

`//` 右边的覆盖左边的，`buildHost` 和 `hostTarget` 写在最后，所以没有任何 `__spliced` 的时候，一个名字的默认值是 `hostTarget` 那一份：运行时版本。每个名字的 `__spliced` 字段则[记着每个包集里有没有它](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/splice.nix#L41-L42)：

```nix
# pkgs/top-level/splice.nix:41-42
          augmentedValue = defaultValue // {
            __spliced = lib.filterAttrs (k: v: inputs.${k} ? ${name}) value';
```

六个包集 `pkgsBuildBuild`、`pkgsBuildHost`、`pkgsBuildTarget`、`pkgsHostHost`、`pkgsHostTarget`、`pkgsTargetTarget` 是从哪来的，要回到 `stage.nix` 和 `booter.nix`。交叉的那一层 stdenv 在 `pkgs/stdenv/cross/default.nix` 里写了 `selfBuild = false`（[84 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/cross/default.nix#L84)），`booter.nix` 看到它，就给这一层配上 `adjacentPackages`：

```nix
# pkgs/stdenv/booter.nix:113-133
              adjacentPackages =
                if args.selfBuild or true then
                  null
                else
                  rec {
                    pkgsBuildBuild = prevStage.buildPackages;
                    pkgsBuildHost = prevStage;
                    pkgsBuildTarget =
                      if args.stdenv.targetPlatform == args.stdenv.hostPlatform then
                        pkgsBuildHost
                      else
                        assert args.stdenv.hostPlatform == args.stdenv.buildPlatform;
                        thisStage;
                    pkgsHostHost =
                      if args.stdenv.hostPlatform == args.stdenv.targetPlatform then
                        thisStage
                      else
                        assert args.stdenv.buildPlatform == args.stdenv.hostPlatform;
                        pkgsBuildHost;
                    pkgsTargetTarget = nextStage;
                  };
```

[113 到 133 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/booter.nix#L113-L133)：`pkgsBuildHost = prevStage`，也就是这一层自举时依赖的那个原生包集，它的 host 是我这台 x86_64，所以 `pkgsBuildHost.pkg-config` 就是能在构建机上跑的那份。而 `selfBuild` 默认是 `true`（114 行的 `args.selfBuild or true`），原生包集的 `adjacentPackages` 是 `null`。`stage.nix` 的 [144 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/stage.nix#L144)用这个 `null` 当开关：

```nix
# pkgs/top-level/stage.nix:144-144
  splice = self: super: import ./splice.nix lib self (adjacentPackages != null);
```

`splice.nix` 的 17 行有一个参数叫 `actuallySplice`，就是这个比较的结果；110 行用它挑 `callPackage` 看到的包集：

```nix
# pkgs/top-level/splice.nix:110-110
  pkgsForCall = if actuallySplice then splicedPackages else pkgs;
```

原生的包集没有 splicing，`callPackage` 直接用裸的 `pkgs`。这个开关可以直接量，同时量一下交叉包集里 `pkg-config` 的三份是什么平台（手敲，不在 `lab/ch12/` 里）：

```text
$ nix eval --impure --json --expr '
  let
    p = import ./nix/pkgs.nix { };
    c = p.pkgsCross.aarch64-multiplatform;
    h = d: d.stdenv.hostPlatform.config;
  in
  {
    nativeHasSpliced = p.zlib ? __spliced;
    crossHasSpliced = c.zlib ? __spliced;
    pkgConfig = {
      plain = h c.pkg-config;
      buildHost = h c.pkg-config.__spliced.buildHost;
      hostTarget = h c.pkg-config.__spliced.hostTarget;
    };
  }
' | jq .
{
  "crossHasSpliced": true,
  "nativeHasSpliced": false,
  "pkgConfig": {
    "buildHost": "x86_64-unknown-linux-gnu",
    "hostTarget": "aarch64-unknown-linux-gnu",
    "plain": "aarch64-unknown-linux-gnu"
  }
}
```

`nativeHasSpliced = false`：原生包集的 `zlib` 没有 `__spliced`；`crossHasSpliced = true`。`pkgConfig` 里，平常直接取的 `c.pkg-config`(`plain`) 的 `hostPlatform` 是 aarch64，和 `hostTarget` 是同一份，而 `buildHost` 那份是 `x86_64-unknown-linux-gnu`。同一个名字，两份包，`package.nix` 里只出现一个 `pkg-config`。

那么由谁来挑？不是 `callPackage`，是 `mkDerivation`。`make-derivation.nix` 在把依赖列表交给 builder 的时候，对每个列表里的每个元素取对应的 `__spliced` 字段，没有就退回元素本身 (`or drv`)：

```nix
# pkgs/stdenv/generic/make-derivation.nix:559-582
        buildHostOutputs =
          if nativeBuildInputs' == [ ] then
            [ ]
          else
            map (drv: getDev drv.__spliced.buildHost or drv) (
              checkDependencyList "nativeBuildInputs" nativeBuildInputs'
            );
        buildTargetOutputs =
          if depsBuildTarget == [ ] then
            [ ]
          else
            map (drv: getDev drv.__spliced.buildTarget or drv) (
              checkDependencyList "depsBuildTarget" depsBuildTarget
            );
        hostHostOutputs =
          if depsHostHost == [ ] then
            [ ]
          else
            map (drv: getDev drv.__spliced.hostHost or drv) (checkDependencyList "depsHostHost" depsHostHost);
        hostTargetOutputs =
          if buildInputs' == [ ] then
            [ ]
          else
            map (drv: getDev drv.__spliced.hostTarget or drv) (checkDependencyList "buildInputs" buildInputs');
```

[559 到 582 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L559-L582)：`nativeBuildInputs'` 里的每个依赖取 `__spliced.buildHost`，`buildInputs'` 里的每个依赖取 `__spliced.hostTarget`，并且都过一遍 `getDev`，选依赖的 `dev` 输出。最后它们成为 derivation 的真正属性，[718 到 723 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L718-L723)：

```nix
# pkgs/stdenv/generic/make-derivation.nix:718-723
          depsBuildBuild = buildBuildOutputs;
          nativeBuildInputs = buildHostOutputs;
          depsBuildTarget = buildTargetOutputs;
          depsHostHost = hostHostOutputs;
          buildInputs = hostTargetOutputs;
          depsTargetTarget = targetTargetOutputs;
```

注意这个顺序。分类（放进哪个列表）由我在 `package.nix` 里写，选版本（用哪一份）由 `mkDerivation` 按分类做。我写 `nativeBuildInputs = [ pkg-config ]`，是在对 `mkDerivation` 说“我要这个工具的构建机版本”。放错了列表，就等于要错了那一份。

`lab/ch12/splicing.nix` 把这一切对着 `firn-hello-aarch64` 核对一遍：

```nix
let
  pkgs = import ../../nix/pkgs.nix { };
  cross = pkgs.pkgsCross.aarch64-multiplatform;
  inherit (cross) firn-hello;
  describe = dep: {
    inherit (dep) name;
    hostPlatform = dep.stdenv.hostPlatform.config;
    targetPlatform = dep.stdenv.targetPlatform.config;
  };
in
{
  package = firn-hello.name;
  packageHostPlatform = firn-hello.stdenv.hostPlatform.config;
  nativeBuildInputs = map describe firn-hello.nativeBuildInputs;
  buildInputs = map describe firn-hello.buildInputs;
  spliced = {
    pkgConfigSpliceKeys = builtins.attrNames cross.pkg-config.__spliced;
    nativeBuildInputIsBuildHost =
      firn-hello.nativeBuildInputs == [ cross.pkg-config.__spliced.buildHost ];
    zlibBuildInputIsHostTargetDev =
      map (dep: dep.outPath) firn-hello.buildInputs
      == [ (pkgs.lib.getDev cross.zlib.__spliced.hostTarget).outPath ];
  };
}
```

```text
$ nix eval --json --file lab/ch12/splicing.nix | jq .
{
  "buildInputs": [
    {
      "hostPlatform": "aarch64-unknown-linux-gnu",
      "name": "zlib-aarch64-unknown-linux-gnu-1.3.2",
      "targetPlatform": "aarch64-unknown-linux-gnu"
    }
  ],
  "nativeBuildInputs": [
    {
      "hostPlatform": "x86_64-unknown-linux-gnu",
      "name": "aarch64-unknown-linux-gnu-pkg-config-wrapper-0.29.2",
      "targetPlatform": "aarch64-unknown-linux-gnu"
    }
  ],
  "package": "firn-hello-aarch64-unknown-linux-gnu-0.1.0",
  "packageHostPlatform": "aarch64-unknown-linux-gnu",
  "spliced": {
    "nativeBuildInputIsBuildHost": true,
    "pkgConfigSpliceKeys": [
      "buildBuild",
      "buildHost",
      "buildTarget",
      "hostHost",
      "hostTarget"
    ],
    "zlibBuildInputIsHostTargetDev": true
  }
}
```

输出里：

- `nativeBuildInputs` 里的 `pkg-config`：`hostPlatform` 是 `x86_64-unknown-linux-gnu`，`targetPlatform` 是 `aarch64-unknown-linux-gnu`。它在我的机器上跑，产出针对 aarch64 的查询结果，所以名字带 `aarch64-unknown-linux-gnu-` 前缀。这就是 autoconf 手册那句 `host-type-` 前缀。
- `buildInputs` 里的 `zlib`：`hostPlatform` 和 `targetPlatform` 都是 aarch64，名字里有 `aarch64-unknown-linux-gnu`。
- `spliced` 三项：`pkgConfigSpliceKeys` 是 `buildBuild`、`buildHost`、`buildTarget`、`hostHost`、`hostTarget` 五个，少一个 `targetTarget`；`nativeBuildInputIsBuildHost` 为 `true`：`firn-hello.nativeBuildInputs` 就等于 `[ cross.pkg-config.__spliced.buildHost ]`；`zlibBuildInputIsHostTargetDev` 为 `true`：`buildInputs` 里的 `zlib` 的 `outPath` 就等于 `getDev cross.zlib.__spliced.hostTarget` 的。

`pkg-config` 的 `__spliced` 是 5 个键，而 `splice.nix` 的 `mash` 合并的是 6 个包集。差的那个 `targetTarget` 对应 `pkgsTargetTarget`。在交叉包集里它只有 3 个属性，没有 `pkg-config`（手敲，不在 `lab/ch12/` 里）：

```text
$ nix eval --impure --json --expr '
  let
    c = (import ./nix/pkgs.nix { }).pkgsCross.aarch64-multiplatform;
  in
  {
    targetTargetAttrs = builtins.length (builtins.attrNames c.pkgsTargetTarget);
    targetTargetHasPkgConfig = c.pkgsTargetTarget ? pkg-config;
    buildTargetHasPkgConfig = c.pkgsBuildTarget ? pkg-config;
  }
' | jq -c .
{"buildTargetHasPkgConfig":true,"targetTargetAttrs":3,"targetTargetHasPkgConfig":false}
```

`buildTarget` 那一份有，`targetTarget` 那一份没有，所以 `inputs.${k} ? ${name}` 对 `targetTarget` 为假，这个键就没有出现。

splicing 的开销，用 `nix-instantiate` 对四个包各求值一次（手敲，不在 `lab/ch12/` 里；热缓存，`hyperfine` 每个 5 次取平均）：

```text
$ hyperfine -N -w 1 -r 5 \
  'nix-instantiate nix/pkgs.nix -A firn-hello' \
  'nix-instantiate nix/pkgs.nix -A pkgsStatic.firn-hello' \
  'nix-instantiate nix/pkgs.nix -A pkgsMusl.firn-hello' \
  'nix-instantiate nix/pkgs.nix -A pkgsCross.aarch64-multiplatform.firn-hello' \
  2>&1 | grep -E 'Benchmark|Time \(mean'
Benchmark 1: nix-instantiate nix/pkgs.nix -A firn-hello
  Time (mean ± σ):     377.4 ms ±   6.9 ms    [User: 229.0 ms, System: 97.3 ms]
Benchmark 2: nix-instantiate nix/pkgs.nix -A pkgsStatic.firn-hello
  Time (mean ± σ):     470.0 ms ±  26.0 ms    [User: 277.6 ms, System: 131.7 ms]
Benchmark 3: nix-instantiate nix/pkgs.nix -A pkgsMusl.firn-hello
  Time (mean ± σ):     433.6 ms ±  16.7 ms    [User: 266.2 ms, System: 115.3 ms]
Benchmark 4: nix-instantiate nix/pkgs.nix -A pkgsCross.aarch64-multiplatform.firn-hello
  Time (mean ± σ):     466.5 ms ±  11.8 ms    [User: 276.9 ms, System: 132.3 ms]
```

原生 377.4 ms，`pkgsStatic` 470.0 ms，`pkgsMusl` 433.6 ms，`pkgsCross.aarch64-multiplatform` 466.5 ms。交叉的比原生慢 1.24 倍，纯求值，没有构建，多一个包集多约 90 ms。我有点意外它这么小：`pkgsCross` 有 87 个，我猜是惰性省掉了几乎全部，没有验证。

## 放错类别：wrong_category_fail.sh

分类是我写的，所以分类可以写错。`lab/ch12/fixtures/firn_hello_wrong_category.nix` 是 `firn-hello` 的一份拷贝，只改了一处：`pkg-config` 从 `nativeBuildInputs` 挪进了 `buildInputs`，并且直接在 `pkgsCross.aarch64-multiplatform` 里构建。其余（源码、`strictDeps = true`、`PREFIX`）和 `package.nix` 一样：

```nix
stdenv.mkDerivation {
  pname = "firn-hello-wrong-category";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../../../src/firn-hello;
    fileset = lib.fileset.unions [
      ../../../src/firn-hello/firn-hello.c
      ../../../src/firn-hello/Makefile
    ];
  };

  # BAD: pkg-config is a build-time tool, it belongs in nativeBuildInputs
  buildInputs = [
    pkg-config
    zlib
  ];

  makeFlags = [
    "PREFIX=${placeholder "out"}"
  ]
  ++ lib.optional keepZlibLibs "ZLIB_LIBS=-lz";

  strictDeps = true;
}
```

`keepZlibLibs` 控制要不要保留 `package.nix` 里的 `"ZLIB_LIBS=-lz"`（第 10 篇讲过的那个后门）。`wrong_category_fail.sh` 把两种情况各构建一次，只打印构建日志里有意义的几行：

```bash
run_variant() {
  local status
  nix build --no-link --arg keepZlibLibs "$1" --file "${fixture}" 2>/dev/null
  status=$?
  nix log --arg keepZlibLibs "$1" --file "${fixture}" 2>/dev/null \
    | grep -E 'command not found|^aarch64-unknown-linux-gnu-gcc|undefined reference|ld returned' \
    | sed -E 's|/nix/store/[a-z0-9]{32}-||g'
  echo "exit status: ${status}"
  return "${status}"
}

echo "== variant 1: keeps ZLIB_LIBS=-lz"
run_variant true

echo
echo "== variant 2: without ZLIB_LIBS=-lz"
run_variant false
```

```text
$ cat out/ch12/wrong_category_fail.stdout
== variant 1: keeps ZLIB_LIBS=-lz
bash-5.3p15/bin/bash: line 1: pkg-config: command not found
aarch64-unknown-linux-gnu-gcc -O2 -Wall -Wextra  -o firn-hello firn-hello.c -lz
exit status: 0

== variant 2: without ZLIB_LIBS=-lz
bash-5.3p15/bin/bash: line 1: pkg-config: command not found
bash-5.3p15/bin/bash: line 1: pkg-config: command not found
aarch64-unknown-linux-gnu-gcc -O2 -Wall -Wextra  -o firn-hello firn-hello.c 
firn-hello.c:(.text.startup+0x94): undefined reference to `crc32'
aarch64-unknown-linux-gnu-binutils-2.46/bin/aarch64-unknown-linux-gnu-ld.bfd: firn-hello.c:(.text.startup+0x13c): undefined reference to `zlibVersion'
collect2: error: ld returned 1 exit status
exit status: 1
```

脚本以变体 2 的退出码退出 (1)，所以运行器按 `_fail` 的约定把它记为 `ok`。

你大概会预期“放错类别，构建失败”，变体 1 不是这样：它的 `exit status` 是 0，构建**成功**了，日志里只有一行 `pkg-config: command not found`，埋在 `make` 的输出里。要让构建失败，得同时拿掉 `ZLIB_LIBS=-lz`（变体 2），这时 `pkg-config` 出现了两次 `command not found`，链接命令里没有 `-lz`，`ld` 报 `undefined reference to 'crc32'` 和 `'zlibVersion'`。

变体 1 为什么能活下来？`Makefile` 里 `ZLIB_CFLAGS` 默认是 `$(shell $(PKG_CONFIG) --cflags zlib)`，`pkg-config` 找不到，`$(shell ...)` 展开成空串，`-I` 这一项丢了。但 `gcc` 照样找得到 `zlib.h`，因为 cc-wrapper 在 `NIX_CFLAGS_COMPILE` 里给每个依赖的 `include` 目录加了 `-isystem`，和 `pkg-config` 无关（手敲，不在 `lab/ch12/` 里）：

```text
$ nix develop --file lab/ch12/fixtures/firn_hello_wrong_category.nix --command \
  bash -c 'echo "${NIX_CFLAGS_COMPILE}"' 2>/dev/null \
  | sed -E 's|/nix/store/[a-z0-9]{32}-||g'
 -frandom-seed=vh3ckxai40 -isystem zlib-aarch64-unknown-linux-gnu-1.3.2-dev/include
```

链接那一半由 `ZLIB_LIBS=-lz` 接管，`-L` 也是 cc-wrapper 给的。也就是说，`package.nix` 里那个“让 `-lz` 选中动态库”的后门，在这里顺带掩盖了这个错误。第 10 篇我把它当成一个关于 `libz.a` 和 `libz.so` 顺序的补丁，现在看，它还能挡住一整类“`pkg-config` 没有跑起来”的错误。

### PATH 里到底少了什么

`pkg-config: command not found` 是 shell 说的，意思是 `PATH` 上没有叫 `pkg-config` 的程序。可正确分类的版本里，`PATH` 上其实也没有叫 `pkg-config` 的程序。我在两个构建环境里各问一次（手敲，不在 `lab/ch12/` 里；`command -v` 找不到的名字什么也不打印）：

```text
$ nix develop --file lab/ch12/fixtures/firn_hello_wrong_category.nix --command \
  bash -c 'echo "PKG_CONFIG=${PKG_CONFIG-unset}"; command -v pkg-config aarch64-unknown-linux-gnu-pkg-config' 2>/dev/null \
  | sed -E 's|/nix/store/[a-z0-9]{32}-||g'
PKG_CONFIG=unset
```

```text
$ nix develop --file nix/pkgs.nix pkgsCross.aarch64-multiplatform.firn-hello --command \
  bash -c 'echo "PKG_CONFIG=${PKG_CONFIG-unset}"; command -v pkg-config aarch64-unknown-linux-gnu-pkg-config' 2>/dev/null \
  | sed -E 's|/nix/store/[a-z0-9]{32}-||g'
PKG_CONFIG=aarch64-unknown-linux-gnu-pkg-config
aarch64-unknown-linux-gnu-pkg-config-wrapper-0.29.2/bin/aarch64-unknown-linux-gnu-pkg-config
```

放错类别的环境里，`PKG_CONFIG` 没有设置，`pkg-config` 和带前缀的 `aarch64-unknown-linux-gnu-pkg-config` 都不在 `PATH` 上。正确分类的环境里，`PKG_CONFIG` 是 `aarch64-unknown-linux-gnu-pkg-config`，`PATH` 上只有带前缀的这一个：不带前缀的 `pkg-config` 从来不在。`Makefile` 里是 `PKG_CONFIG ?= pkg-config`，`?=` 在环境变量已经有值的时候不动它，所以正确的构建用的是带前缀的名字，错的构建落到了默认值 `pkg-config`，而这个名字哪里都没有。

这两件事是两个机制叠起来的。第一个是 `setup.sh` 的 `activatePackage`，第 7 篇引过的那三行：

```bash
# pkgs/stdenv/generic/setup.sh:855-857
    if [[ -z "${strictDeps-}" || "$hostOffset" -le -1 ]]; then
        addToSearchPath _PATH "$pkg/bin"
    fi
```

[855 到 857 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L855-L857)：`strictDeps` 设了，只有 `hostOffset <= -1` 的依赖（`nativeBuildInputs` 一类）的 `bin` 才进 `PATH`。`buildInputs` 里的 `pkg-config` 偏移是 0，它的 `bin` 不进。第二个是 `pkg-config` 包装器自己的 setup hook：

```bash
# pkgs/build-support/pkg-config-wrapper/setup-hook.sh:9-9
[[ -z ${strictDeps-} ]] || (( "$hostOffset" < 0 )) || return 0
```

[第 9 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/pkg-config-wrapper/setup-hook.sh#L9)的意思是：`strictDeps` 设了而且偏移不是负数，就整个 hook 提前返回。导出环境变量的那几行永远跑不到：

```bash
# pkgs/build-support/pkg-config-wrapper/setup-hook.sh:24-26
addEnvHooks "$targetOffset" pkgConfigWrapper_addPkgConfigPath

export PKG_CONFIG${role_post}=@targetPrefix@@baseBinName@
```

[24 到 26 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/pkg-config-wrapper/setup-hook.sh#L24-L26)：`addEnvHooks` 把每个依赖的 `lib/pkgconfig` 加进 `PKG_CONFIG_PATH`，`export PKG_CONFIG=...` 则是 `@targetPrefix@@baseBinName@`，也就是带目标前缀的名字。名字里的 `@targetPrefix@` 是包装器自己的 `targetPlatform`，`aarch64-unknown-linux-gnu-` 就是这么来的。

### 原生也会失败，宽松的交叉更糟

放错类别到底是“交叉编译才有的问题”，还是“交叉编译才暴露的问题”？我在原生包集里重复这个实验。`wrong.nix` 不在仓库里，放在仓库根目录（手敲，不在 `lab/ch12/` 里）：

```nix
{
  cross ? true,
  strict ? true,
}:
let
  pkgs = import ./nix/pkgs.nix { };
  set = if cross then pkgs.pkgsCross.aarch64-multiplatform else pkgs;
in
set.firn-hello.overrideAttrs {
  # BAD: pkg-config is a build-time tool, it belongs in nativeBuildInputs
  nativeBuildInputs = [ ];
  buildInputs = [
    set.pkg-config
    set.zlib
  ];
  makeFlags = [ "PREFIX=${placeholder "out"}" ];
  strictDeps = strict;
  doInstallCheck = false;
}
```

`cross` 选包集，`strict` 控制 `strictDeps`；它没有 `ZLIB_LIBS=-lz`，所以对应变体 2。三种组合，`grep` 和 `sort` 都写在命令里（手敲，不在 `lab/ch12/` 里）：

```text
$ nix build --no-link --file wrong.nix --arg cross false --arg strict true 2>&1 \
  | grep -E 'command not found|undefined reference|Exec format error' \
  | sed -E 's|/nix/store/[a-z0-9]{32}-||g; s/^ +> //' | sort -u
echo "exit: ${PIPESTATUS[0]}"
bash-5.3p15/bin/bash: line 1: pkg-config: command not found
binutils-2.46/bin/ld.bfd: firn-hello.c:(.text.startup+0x12e): undefined reference to `zlibVersion'
firn-hello.c:(.text.startup+0x9c): undefined reference to `crc32'
exit: 1
```

```text
$ nix build --no-link --file wrong.nix --arg cross false --arg strict false 2>&1 \
  | grep -E 'command not found|undefined reference|Exec format error' \
  | sed -E 's|/nix/store/[a-z0-9]{32}-||g; s/^ +> //' | sort -u
echo "exit: ${PIPESTATUS[0]}"
exit: 0
```

```text
$ nix build --no-link --file wrong.nix --arg cross true --arg strict false 2>&1 \
  | grep -E 'command not found|undefined reference|Exec format error' \
  | sed -E 's|/nix/store/[a-z0-9]{32}-||g; s/^ +> //' | sort -u
echo "exit: ${PIPESTATUS[0]}"
aarch64-unknown-linux-gnu-binutils-2.46/bin/aarch64-unknown-linux-gnu-ld.bfd: firn-hello.c:(.text.startup+0x13c): undefined reference to `zlibVersion'
firn-hello.c:(.text.startup+0x94): undefined reference to `crc32'
pkg-config-wrapper-0.29.2/bin/pkg-config: line 19: pkg-config-aarch64-unknown-linux-gnu-0.29.2/bin/pkg-config: cannot execute binary file: Exec format error
exit: 1
```

第一个：**原生构建、`strictDeps = true`，一样失败**，同样的 `command not found`，同样的 `undefined reference`。第 7 篇说“原生默认宽容”，宽容的开关是 `strictDeps`，不是原生；`package.nix` 里我显式写了 `strictDeps = true`，所以这个包在原生机器上就能发现这类错误，不必等到交叉。

第二个：**原生、`strictDeps = false`，构建成功，什么错也没有**，`pkg-config` 在 `buildInputs` 里照样进了 `PATH`。这就是第 7 篇讲的宽容的代价：写错了，你永远不知道。

第三个：**交叉、`strictDeps = false`，换了一种失败的方式**。这一次 `pkg-config` 在 `PATH` 上（宽松模式，所有依赖都进），但它是 aarch64 版：`pkg-config-wrapper-0.29.2/bin/pkg-config` 这个包装脚本去 `exec` 一个 aarch64 的 ELF，bash 回 `Exec format error`。这才是交叉编译真正在防的东西：构建机上跑了一个目标机的程序。`strictDeps` 的作用是让这个程序根本不在 `PATH` 里，错误就提前变成一句 `command not found`。

交叉构建的 `strictDeps` 默认是 `true`（`make-derivation.nix` 的 [355 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L355)，第 7 篇引过），所以第三种情况在 nixpkgs 里默认不会碰到，要自己把它关掉才行。

## $CC 是什么：cross_cc_name.sh

交叉构建环境里的 `$CC` 到底是谁？`lab/ch12/cross_cc_name.sh` 用 `nix develop --file` 进入 `pkgsCross.aarch64-multiplatform.firn-hello` 的构建环境（[`nix develop` 的手册](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-develop.html)），打印几个常见变量，再用 `-dumpmachine` 问各个编译器它是为哪个平台编的：

```bash
# shellcheck disable=SC2016  # the script runs inside the build environment
nix develop --file "${FIRN_ROOT}/nix/pkgs.nix" pkgsCross.aarch64-multiplatform.firn-hello \
  --command bash -c '
    for v in CC CXX LD AR STRIP PKG_CONFIG; do
      echo "${v}=${!v}"
    done
    echo "$CC -dumpmachine: $("${CC}" -dumpmachine)"
    echo "gcc -dumpmachine: $(gcc -dumpmachine)"
    echo "cc -dumpmachine: $(cc -dumpmachine)"
    echo "NIX_CC=${NIX_CC}"
  ' 2>/dev/null | sed -E 's|/nix/store/[a-z0-9]{32}-||g'
```

```text
$ cat out/ch12/cross_cc_name.stdout
CC=aarch64-unknown-linux-gnu-gcc
CXX=aarch64-unknown-linux-gnu-g++
LD=aarch64-unknown-linux-gnu-ld
AR=aarch64-unknown-linux-gnu-ar
STRIP=aarch64-unknown-linux-gnu-strip
PKG_CONFIG=aarch64-unknown-linux-gnu-pkg-config
aarch64-unknown-linux-gnu-gcc -dumpmachine: aarch64-unknown-linux-gnu
gcc -dumpmachine: x86_64-unknown-linux-gnu
cc -dumpmachine: x86_64-unknown-linux-gnu
NIX_CC=aarch64-unknown-linux-gnu-gcc-wrapper-15.3.0
```

`CC`、`CXX`、`LD`、`AR`、`STRIP`、`PKG_CONFIG` 全部带 `aarch64-unknown-linux-gnu-` 前缀，这就是 autoconf 手册那句 `host-type-gcc`。`$CC -dumpmachine` 说 `aarch64-unknown-linux-gnu`，没有悬念。`NIX_CC` 是 `aarch64-unknown-linux-gnu-gcc-wrapper-15.3.0`：gcc 15.3.0 的 cc-wrapper，第 10 篇讲过的那个包装器，只是这一份的前缀是目标。

输出里有两行要解释：`gcc -dumpmachine: x86_64-unknown-linux-gnu` 和 `cc -dumpmachine: x86_64-unknown-linux-gnu`。它们不是交叉构建环境的一部分：`make ch12` 是在 Firn 的开发 shell 里跑的，开发 shell 自己带一个 x86_64 的 gcc，`nix develop` 保留了外层的 `PATH`，所以外层的 `gcc` 留在了构建环境里（脚本的头注释也是这么说的）。把外层环境清空，只留 NixOS 的 `/run/current-system/sw/bin`（手敲，不在 `lab/ch12/` 里；非 NixOS 机器上换成能找到 `nix` 的最小 `PATH`）：

```text
$ env -i HOME="$HOME" PATH=/run/current-system/sw/bin \
  nix develop --file nix/pkgs.nix pkgsCross.aarch64-multiplatform.firn-hello \
  --command bash -c 'for c in gcc cc "$CC"; do echo "${c##*/}: $(command -v "$c" || echo none)"; done' 2>&1 \
  | sed -E 's|/nix/store/[a-z0-9]{32}-||g'
gcc: none
cc: none
aarch64-unknown-linux-gnu-gcc: aarch64-unknown-linux-gnu-gcc-wrapper-15.3.0/bin/aarch64-unknown-linux-gnu-gcc
```

交叉构建环境里**没有**无前缀的 `gcc`，也没有 `cc`，只有带前缀的 `aarch64-unknown-linux-gnu-gcc`。所以交叉编译里一个写死 `gcc` 的 Makefile 会直接 `command not found`，而不是悄悄用构建机的编译器编出一个 x86 的目标文件。`firn-hello` 的 Makefile 写的是 `CC ?= cc`，`CC` 在环境里已经有值，所以不踩这个坑。

## 静态：pkgsStatic 的三个路径

回到开头那张表。`lab/ch12/static_size.sh` 对 glibc 动态、musl 动态和 musl 静态三个版本量二进制大小、闭包大小和路径数，然后对静态版问三个问题：`ldd` 怎么说，它的引用有谁，它的 `nix-support/propagated-build-inputs` 里有什么：

```bash
printf '%-18s %10s %12s %6s\n' package binary closure paths
for name in firn-hello firn-hello-musl firn-hello-static; do
  out="$(nix build --no-link --print-out-paths "${FIRN_ROOT}#${name}" 2>/dev/null)"
  bin="${out}/bin/firn-hello"
  size="$(stat --format=%s "${bin}")"
  closure="$(nix path-info --closure-size "${out}" | awk '{ print $2 }')"
  count="$(nix path-info --recursive "${out}" | wc -l)"
  printf '%-18s %10d %12d %6d\n' "${name}" "${size}" "${closure}" "${count}"
done
# ...
out="$(nix build --no-link --print-out-paths "${FIRN_ROOT}#firn-hello-static" 2>/dev/null)"
echo
echo "== ldd of the static build"
ldd "${out}/bin/firn-hello" 2>&1 || true
echo "== references of the static build"
nix-store --query --references "${out}" | strip_hash
echo "== nix-support/propagated-build-inputs of the static build"
strip_hash <"${out}/nix-support/propagated-build-inputs"
```

```text
$ cat out/ch12/static_size.stdout
package                binary      closure  paths
firn-hello              16000     37866984      6
firn-hello-musl         15672      4126656      3
firn-hello-static       61400       346416      3

== ldd of the static build
	not a dynamic executable
== references of the static build
zlib-static-x86_64-unknown-linux-musl-1.3.2-dev
== nix-support/propagated-build-inputs of the static build
zlib-static-x86_64-unknown-linux-musl-1.3.2-dev 
```

表里的数字：

- 二进制：glibc 动态 16,000 字节，musl 动态 15,672 字节（小 328 字节，2.1%），musl 静态 61,400 字节（比动态大 3.8 倍）。静态版把用到的那部分 libc 和 zlib 抄进了自己，胖是应该的。
- 闭包：glibc 动态 37,866,984 字节，musl 动态 4,126,656 字节（小 9.2 倍），musl 静态 346,416 字节（比 glibc 版小 109 倍，比 musl 动态版小 11.9 倍）。
- 路径数：6、3、3。

先看 glibc 和 musl 的差别。同一个 47 行 C 程序，同一份 `package.nix`，动态版换了 libc，闭包就从 6 个路径、36.1 MiB 变成 3 个路径、3.9 MiB。路径是（手敲，不在 `lab/ch12/` 里；第二列是每个路径自己的闭包大小）：

```text
$ out="$(nix build --no-link --print-out-paths .#firn-hello)"
nix path-info -rS "${out}" | sed -E 's|/nix/store/[a-z0-9]{32}-||'
libunistring-1.4.2	    2078944
libidn2-2.3.8     	    2447120
xgcc-15.3.0-libgcc	     197672
glibc-2.42-67     	   37717888
zlib-1.3.2        	   37850496
firn-hello-0.1.0  	   37866984
```

```text
$ out="$(nix build --no-link --print-out-paths .#firn-hello-musl)"
nix path-info -rS "${out}" | sed -E 's|/nix/store/[a-z0-9]{32}-||'
musl-1.2.6      	    3973272
zlib-1.3.2      	    4110496
firn-hello-0.1.0	    4126656
```

glibc 自己的闭包是 37,717,888 字节，占整个闭包的 99.6%；闭包里还有 `libidn2` 和 `libunistring`，我没有去查为什么。musl 的闭包是 3,973,272 字节，一个 libc 就是 3.8 MiB。36.1 MiB 的闭包里，`firn-hello` 自己只占 16,488 字节（37,866,984 减去 zlib 的闭包 37,850,496），其余是它背后的 libc 和 zlib。

再看静态。`ldd` 说 `not a dynamic executable`，没有运行时库。可是 `nix-store --query --references` 说它引用了一个路径：`zlib-static-x86_64-unknown-linux-musl-1.3.2-dev`。一个静态链接的程序，二进制里已经没有任何 `/nix/store` 路径了（手敲，不在 `lab/ch12/` 里；`grep -c` 数的是匹配行数）：

```text
$ strings "$(nix build --no-link --print-out-paths .#firn-hello-static)/bin/firn-hello" \
  | grep -c /nix/store
0
```

0。引用不是二进制里扫出来的，是 `nix-support/propagated-build-inputs` 这个文件扫出来的：这个文件的内容和 `--references` 打印的那个路径是同一个。Nix 的引用扫描器扫的是 `$out` 里所有文件的字节，它在这个文件里看到一个 store 路径，就把它记为引用，闭包就多了东西。这个文件是怎么来的，要看 `pkgsStatic` 的 stdenv。

`pkgs/stdenv/cross/default.nix` 的 [41 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/cross/default.nix#L41)：

```nix
# pkgs/stdenv/cross/default.nix:41-41
      adaptStdenv = if crossSystem.isStatic then buildPackages.stdenvAdapters.makeStatic else lib.id;
```

`crossSystem.isStatic` 为真（`pkgsStatic` 在 `crossSystem` 里写了 `isStatic = true;`，在 `stage.nix` 的 298 到 299 行），就给 stdenv 套一层 `makeStatic`。`makeStatic` 在 [`adapters.nix` 的 179 到 192 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/adapters.nix#L179-L192)：

```nix
# pkgs/stdenv/adapters.nix:179-192
  makeStatic =
    stdenv:
    lib.foldl' (lib.flip lib.id) stdenv (
      lib.optional stdenv.hostPlatform.isDarwin makeStaticDarwin

      ++ [
        makeStaticLibraries
        propagateBuildInputs
      ]

      # Apple does not provide a static version of libSystem or crt0.o
      # So we can’t build static binaries without extensive hacks.
      ++ lib.optional (!stdenv.hostPlatform.isDarwin) makeStaticBinaries
    );
```

三个适配器依次套上去（Darwin 除外）：`makeStaticLibraries` 只加 `dontDisableStatic`、`--enable-static`、`--disable-shared`、`-DBUILD_SHARED_LIBS=OFF` 和 meson 的 `default_library=static`，让依赖库构建出静态版；`zlib-static-...` 这个名字里的 `static` 不是它加的，是 `stdenvStaticMarker` 加的，见 `make-derivation.nix` 的 361 行。然后是 `propagateBuildInputs`，最后是 `makeStaticBinaries`（链接参数加 `-static`，[110 到 112 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/adapters.nix#L110-L112)）。中间那个就是答案，[198 到 201 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/adapters.nix#L198-L201)：

```nix
# pkgs/stdenv/adapters.nix:198-201
  propagateBuildInputs = overrideMkDerivationArgs (args: {
    propagatedBuildInputs = (args.propagatedBuildInputs or [ ]) ++ (args.buildInputs or [ ]);
    buildInputs = [ ];
  });
```

它把每个包的 `buildInputs` 改成 `propagatedBuildInputs`，`buildInputs` 清空。`propagatedBuildInputs` 的意思是“依赖我的包也需要这些”，stdenv 的做法是在 fixup 阶段把它们的路径写进开发输出的 `nix-support/propagated-build-inputs`，下游的 setup 脚本读这个文件把依赖接上。`setup.sh` 的 [1627 到 1628 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L1627-L1628)：

```bash
# pkgs/stdenv/generic/setup.sh:1627-1628
    # record propagated dependencies & setup hook into the development output.
    recordPropagatedDependencies
```

`firn-hello-static` 只有一个输出，开发输出就是 `$out`，所以文件落在 `$out/nix-support/propagated-build-inputs`，也就是 `static_size.sh` 读的那个文件。对一个静态库来说这个传递合理：谁链接了 `libz.a`，也许还要它的头文件。对 `firn-hello-static` 这个**最终产物**来说，它没有下游，这个文件没有用处，却被引用扫描器当成了依赖。

后果是闭包里有三个路径：`firn-hello-static` 自己，加上 `zlib-static-...-dev`，再加上 `-dev` 引用的 `zlib-static-...`（`-dev` 输出为什么引用 `out`，我没有查）。三个路径的闭包大小（手敲，不在 `lab/ch12/` 里）：

```text
$ out="$(nix build --no-link --print-out-paths .#firn-hello-static)"
nix path-info -rS "${out}" | sed -E 's|/nix/store/[a-z0-9]{32}-||'
zlib-static-x86_64-unknown-linux-musl-1.3.2      	     161064
zlib-static-x86_64-unknown-linux-musl-1.3.2-dev  	     284056
firn-hello-static-x86_64-unknown-linux-musl-0.1.0	     346416
```

`zlib-static` 的 `dev` 加 `out` 是 284,056 字节，占闭包 346,416 字节的 82.0%；二进制自己的 61,400 字节加上一点目录开销，是剩下的 62,360 字节。所以“静态链接的闭包很小”这句话要说准确：**静态链接的二进制不需要闭包，但 nixpkgs 的静态 stdenv 仍然给它记了一份构建时依赖**。

和第 11 篇的 Pebble 比：它的二进制是（手敲，不在 `lab/ch12/` 里）：

```text
$ stat --format=%s "$(nix build --no-link --print-out-paths .#pebble)/bin/pebble"
1883160
```

1,883,160 字节，是整个 `firn-hello-static` 闭包（346,416 字节）的 5.4 倍。第 11 篇我问“会不会比 Pebble 的二进制还小”，答案是会。当然，这是一个 47 行的 C 程序和一个 16 个 crate 的 Rust 工作区在比大小，我自己都觉得这个比较没什么公平可言。

`stage.nix` 在 `pkgsStatic` 的定义前留了一句注释，我引在这里，因为它说明了为什么在 Linux 上 `pkgsStatic` 偏偏是 musl（[283 到 284 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/stage.nix#L283-L284)）：

```nix
# pkgs/top-level/stage.nix:283-284
    # Fully static packages.
    # Currently uses Musl on Linux (couldn’t get static glibc to work).
```

“couldn’t get static glibc to work”。我没有试过静态 glibc，这一句只能转述注释本身。

## 工具链从哪来：riscv64_host.sh

`pkgsCross.riscv64.firn-hello` 是第二个交叉目标，包一个字没改。这个实验标了 `_host`：它的第一次运行要下载一整套 riscv64 的工具链，所以 `CI=true` 时跳过。

```bash
attr=pkgsCross.riscv64.firn-hello
readonly attr

echo "== build plan (derivations to build, paths to fetch)"
nix build --dry-run --no-link --file "${FIRN_ROOT}/nix/pkgs.nix" "${attr}" 2>&1 \
  | { grep -E '^this|^these' || true; } | sed -E 's/ \(.*\)//; s/^/volatile: /'

start="$(date +%s%N)"
out="$(nix build --no-link --print-out-paths --file "${FIRN_ROOT}/nix/pkgs.nix" "${attr}" 2>/dev/null)"
end="$(date +%s%N)"
echo "volatile: build wall time $(((end - start) / 1000000)) ms"

echo
echo "== file"
file --brief "${out}/bin/firn-hello" | sed -E 's|/nix/store/[a-z0-9]{32}-||g; s/, BuildID\[sha1\]=[0-9a-f]+//'

echo
echo "== qemu-riscv64 firn-hello nix"
qemu="$(nix build --no-link --print-out-paths --file "${FIRN_ROOT}/nix/pkgs.nix" qemu)"
"${qemu}/bin/qemu-riscv64" "${out}/bin/firn-hello" nix
```

```text
$ cat out/ch12/riscv64_host.stdout
== build plan (derivations to build, paths to fetch)
volatile: build wall time 495 ms

== file
ELF 64-bit LSB pie executable, UCB RISC-V, RVC, double-float ABI, version 1 (SYSV), dynamically linked, interpreter glibc-riscv64-unknown-linux-gnu-2.42-67/lib/ld-linux-riscv64-lp64d.so.1, for GNU/Linux 4.15.0, not stripped

== qemu-riscv64 firn-hello nix
Hello, nix, from firn-hello 0.1.0
crc32: 8bb8f4d3
```

先看实验在热缓存上的样子：第一段 `== build plan` 是空的。脚本用 `nix build --dry-run` 打印“将构建多少个 derivation、将下载多少个路径”，但我跑它的时候所有东西已经在 store 里，`--dry-run` 什么也不打印，`grep` 没有匹配，只剩下一个空段。`volatile: build wall time 495 ms` 是同一个原因：所有输入都在 store 里，495 毫秒是 `nix build` 查一遍 store 的时间。脚本头注释记着冷 store 上的结果：下载 130.6 MiB（15 个路径），只构建 `firn-hello` 自己；这是脚本头注释里的记录，我没有在冷 store 上复现。

我换一个办法来回答。构建 `pkgsCross.riscv64.firn-hello` 需要的，是 `.drv` 里写的那几个直接输入。对每个输入的输出路径，问 cache.nixos.org 有没有。这个脚本不在仓库里（手敲，不在 `lab/ch12/` 里），放在仓库根目录：

```bash
#!/usr/bin/env bash
#
# For every input derivation of one nix/pkgs.nix attribute, say whether the
# output is available from cache.nixos.org. Run it from the repository root:
#   bash cached_inputs.sh pkgsCross.riscv64.firn-hello

set -o errexit
set -o nounset
set -o pipefail

#######################################
# Print "<cached|MISSING> <name>" for each input output of one attribute.
# Arguments:
#   Attribute path inside nix/pkgs.nix.
# Outputs:
#   One line per input output, store hashes removed.
#######################################
main() {
  local drv input output path state
  drv="$(nix eval --raw --file nix/pkgs.nix "$1.drvPath")"
  while read -r input output; do
    path="$(nix derivation show "/nix/store/${input}" \
      | jq -r --arg o "${output}" \
        '.derivations | to_entries[0].value.outputs[$o].path')"
    state=MISSING
    if nix path-info --store https://cache.nixos.org "/nix/store/${path}" &>/dev/null; then
      state=cached
    fi
    echo "${state} ${path#*-}"
  done < <(nix derivation show "${drv}" \
    | jq -r '.derivations | to_entries[0].value.inputs.drvs | to_entries[]
      | .key as $k | .value.outputs[] | "\($k) \(.)"')
}

main "$@"
```

```text
$ bash cached_inputs.sh pkgsCross.riscv64.firn-hello
cached stdenv-linux
cached zlib-riscv64-unknown-linux-gnu-1.3.2-dev
cached riscv64-unknown-linux-gnu-pkg-config-wrapper-0.29.2
cached bash-5.3p15
```

```text
$ bash cached_inputs.sh pkgsCross.aarch64-multiplatform.firn-hello
cached stdenv-linux
cached zlib-aarch64-unknown-linux-gnu-1.3.2-dev
cached aarch64-unknown-linux-gnu-pkg-config-wrapper-0.29.2
cached bash-5.3p15
```

两个交叉目标的四个直接输入（`stdenv-linux`、目标平台的 `zlib` 的 `dev` 输出、`pkg-config` 包装器、`bash`）全部在 cache.nixos.org 上，不需要从源码编译。交叉的 `gcc`、`binutils` 和 libc 是 `stdenv-linux` 的依赖，我只检查了直接输入，没有逐个检查它们的传递依赖，所以这里的结论是“直接输入都在缓存里”，“整条链都在缓存里”是我的推测。

工具链有多大，是另一个量得出来的数字：每个目标的 `stdenv.cc.out` 的闭包（解压后，不是下载大小；手敲，不在 `lab/ch12/` 里）：

```text
$ for a in stdenv.cc \
  pkgsCross.aarch64-multiplatform.stdenv.cc \
  pkgsCross.riscv64.stdenv.cc \
  pkgsCross.mingwW64.stdenv.cc; do
  nix path-info -Sh --file nix/pkgs.nix "${a}.out" | sed -E 's|/nix/store/[a-z0-9]{32}-||'
done
gcc-wrapper-15.3.0	 370.0 MiB
aarch64-unknown-linux-gnu-gcc-wrapper-15.3.0	 427.5 MiB
riscv64-unknown-linux-gnu-gcc-wrapper-15.3.0	 523.9 MiB
x86_64-w64-mingw32-gcc-wrapper-15.3.0	 662.7 MiB
```

原生 gcc 的 cc-wrapper 闭包 370.0 MiB；aarch64 的 427.5 MiB（1.16 倍）；riscv64 的 523.9 MiB（1.42 倍）；mingwW64 的 662.7 MiB（1.79 倍）。我没有拆开这些闭包，不知道差别来自哪里。它们只说明一件事：要交叉编译一个包，先要有一个比原生 gcc 大 16% 到 79% 的编译器。

nixpkgs 的 Hydra 为什么有这些路径？Nixpkgs 手册[交叉编译一章](https://nixos.org/manual/nixpkgs/unstable/#chap-cross)说，Nixpkgs 在 Hydra 上维护一个有限的 cross 相关 jobset(`cross-trunk`)，从 `x86_64-linux`、`aarch64-linux` 和 `aarch64-darwin` 出发测试到各种目标平台的交叉编译，完整的目标和包列表在 `pkgs/top-level/release-cross.nix`。该文件开头的 `supportedSystems` 默认就是这三个（[18 到 22 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/release-cross.nix#L18-L22)），每个 job 是“一个交叉目标加一组包”：

`aarch64` 和 `riscv64` 在 [243 和 247 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/release-cross.nix#L243-L247)，用的包集合是 `linuxCommon`，列在 [96 到 105 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/release-cross.nix#L96-L105)的 `buildPackages.gdb`、`bison`、`busybox`、`dropbear`、`ed`、`ncurses`、`patch`，加上 `gnuCommon` 里的 `gcc`、`coreutils`，`common` 里的 `gmp`、`nix`、`rustc` 等。列表里没有 `zlib` 也没有 `pkg-config`。可它们都在缓存里，我猜是因为 `nix`、`rustc` 这些 job 的依赖里有它们，但我没有去验证。`pkgsStatic` 和 `pkgsMusl` 在 `release.nix` 里是另一组 job，只列了 `stdenv`，对 `x86_64-linux` 和 `aarch64-linux` 各一份（[317 到 324 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/release.nix#L317-L324)）。

组合起来的包集，缓存可能就没有了。同样的检查，对 `pkgsCross.aarch64-multiplatform.pkgsStatic.firn-hello`（交叉到 aarch64 的 musl 静态）（手敲，不在 `lab/ch12/` 里）：

```text
$ bash cached_inputs.sh pkgsCross.aarch64-multiplatform.pkgsStatic.firn-hello
MISSING aarch64-unknown-linux-musl-pkg-config-wrapper-0.29.2
cached stdenv-linux
MISSING zlib-static-aarch64-unknown-linux-musl-1.3.2-dev
cached bash-5.3p15
```

`pkg-config` 包装器和静态 zlib 的 `dev` 输出这两个直接输入没有在缓存里，要自己编。这个包我没有构建，所以我只知道直接输入缺了两个，不知道它们背后还有多少。我估计一个冷门的交叉组合会引出一整条自己编的工具链，这是推测。

## binfmt：让 qemu 自动出场

`run_aarch64.sh` 里我显式写 `qemu-aarch64 ./firn-hello`。NixOS 有一个选项把这一步交给内核：`boot.binfmt.emulatedSystems = [ "aarch64-linux" ];`（[NixOS 选项](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/system/boot/binfmt.nix#L189-L200)）。它向内核的 `binfmt_misc` 注册一条规则：看到 aarch64 的 ELF 魔数，就用 qemu 解释器启动它。启用之后 `./firn-hello` 直接就能跑，`run_aarch64.sh` 里那个 `Exec format error` 就不会出现。

同一个选项还会把这些平台写进 `nix.settings.extra-platforms`（[274 到 276 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/system/boot/binfmt.nix#L274-L276)，由 `addEmulatedSystemsToNixSandbox` 控制，默认 `true`），于是 Nix 愿意在本机“原生”构建 `system = "aarch64-linux"` 的 derivation，放在 qemu 里跑。那条选项的说明里有一句警告，我原样引：“the builder can execute all emulated systems within the same build, which introduces impurities in the case of cross compilation”：交叉编译时，构建过程可以直接执行目标平台的程序，这是 `strictDeps` 想防住的那类事情（`pkg-config` 偏偏能跑了）又被放回来。

nixpkgs 自己也用这个思路：`lib.systems` 里的 `emulator`（[`lib/systems/default.nix` 的 104 到 125 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/systems/default.nix#L104-L125)）按平台挑一个模拟器，Linux 到 Linux 就是 `qemu-user`（手敲，不在 `lab/ch12/` 里）：

```text
$ nix eval --impure --raw --expr '
  let
    c = (import ./nix/pkgs.nix { }).pkgsCross.aarch64-multiplatform;
  in
  c.stdenv.hostPlatform.emulator c.buildPackages
' | sed -E 's|/nix/store/[a-z0-9]{32}-||'; echo
qemu-user-11.1.0/bin/qemu-aarch64
```

我这台机器没有启用 `binfmt`（`binfmt_misc` 里的条目数是 0），所以这一段只是读源码得来的，没有在这台机器上运行 `emulatedSystems`。

## 裸机：pkgsCross.arm-embedded

`pkgsCross` 的 87 个目标里，有一类和这一篇的 Linux 目标完全不同：没有操作系统的裸机目标，`arm-embedded`、`avr`、`riscv32-embedded` 这样的名字。`arm-embedded` 的 `config`、编译器名和 libc 是（只求值，没有构建；手敲，不在 `lab/ch12/` 里）：

```text
$ nix eval --impure --json --expr '
  let
    c = (import ./nix/pkgs.nix { }).pkgsCross.arm-embedded;
  in
  {
    config = c.stdenv.hostPlatform.config;
    cc = c.stdenv.cc.name;
    libc = c.stdenv.hostPlatform.libc;
  }
' | jq -c .
{"cc":"arm-none-eabi-gcc-wrapper-15.3.0","config":"arm-none-eabi","libc":"newlib"}
```

`config` 里的 `none` 占的是操作系统的位置，`abi` 是 `eabi`，[`examples.nix` 的 244 到 246 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/systems/examples.nix#L244-L246)定义了它；编译器是 `arm-none-eabi-gcc-wrapper-15.3.0`，libc 是 `newlib`，一个给嵌入式用的小 libc，不是 glibc 也不是 musl。`release-cross.nix` 对这类目标的 job 只有 `buildPackages.binutils`、`buildPackages.gcc` 和 `libc` 三项（71 到 75 行的 `embedded`）。这一篇的 `firn-hello` 需要 Linux 系统调用和 zlib，在裸机上没有意义，所以我没有构建任何裸机目标，这里只是一个指向：要为微控制器打包工具链，从 `pkgsCross.arm-embedded.buildPackages.gcc` 开始读。

## 让我意外的事

我原来以为这一篇讲的是“怎么让 Nix 编出别的架构的程序”，写完发现真正的内容是“你以为的那几个词，在 nixpkgs 里各指什么”。四件事：

**名字里带 `cross` 或 `static` 的包集，不一定在交叉编译，名字里带 `musl` 的，也不一定不在。** `pkgsMusl` 是用 musl 原生构建的整个包集，`spliced = false`；`pkgsStatic` 是从 glibc 到 musl 的交叉，`spliced = true`；`pkgsCross.gnu64.firn-hello` 的 `drvPath` 和原生 `firn-hello` 的**相等**，因为 `crossSystem` 展开后等于 `localSystem`，nixpkgs 就当它是原生。我是靠 `drvPath` 才发现这一点的，包名里没有任何提示。

**静态链接的闭包不是 0。** `firn-hello-static` 的二进制里没有任何 `/nix/store` 路径（`strings | grep -c` 是 0），闭包却有三个路径、346,416 字节。其中 82.0% 是 `zlib-static` 的 `dev` 和 `out`，原因是静态 stdenv 的 `propagateBuildInputs` 把每个 `buildInputs` 改成了 `propagatedBuildInputs`，`nix-support/propagated-build-inputs` 里的那一行被引用扫描器当成了依赖。我用 `overrideAttrs` 把它拿掉过，闭包就是 1 个路径，二进制不变，输出不变。

**放错依赖类别，原生和交叉都会失败，只是“要不要同时拿掉 `ZLIB_LIBS=-lz`”决定了你看不看得见。** `package.nix` 里有 `strictDeps = true`，有了它，原生的 `buildInputs` 里的 `pkg-config` 也进不了 `PATH`。变体 1（保留 `ZLIB_LIBS=-lz`）退出码是 0，只在日志里留一行 `pkg-config: command not found`：这类错误会被一个无关的补丁静静盖住，而这个补丁在第 10 篇里是我自己加的。

**交叉构建环境里没有 `gcc`。** `cross_cc_name.sh` 输出里的 `gcc -dumpmachine` 打印 `x86_64-unknown-linux-gnu`，容易让人以为 `PATH` 上还有构建机的编译器。清空外层 `PATH` 之后，交叉构建环境里根本没有无前缀的 `gcc`：那两行是 Firn 开发 shell 里的 x86_64 gcc 漏进来的。

## 检查点

在 `~/firn` 里，`nix develop` 之内：

```bash
make ch12
make lint
make check
while read -r f; do
  diff <(git -C ~/firn-ref show ch12:"${f}") "${f}" && echo "same ${f}"
done < <(git -C ~/firn-ref diff --name-only ch11 ch12 \
  | grep -v -e '^README.md$' -e '^flake.nix$')
```

我的环境里设了 `CI=true`，我跑的是 `env -u CI make ch12`。这一章有一个 `_host` 实验 (`riscv64_host.sh`)，`CI=true` 时会被跳过，所以读者在 CI 里会看到 `skip lab/ch12/riscv64_host.sh (host only)` 而不是 `ok`。`make ch12` 应当打印这 10 行（命令回显加 9 行 `ok`），整条命令（含 `nix develop` 的启动）在这台机器上花了 15.6 秒，热缓存：

```text
$ env -u CI make ch12
bash scripts/chapter.sh ch12
ok   lab/ch12/cross_cc_name.sh
ok   lab/ch12/ex_mingw.sh
ok   lab/ch12/file_types.sh
ok   lab/ch12/platforms.nix
ok   lab/ch12/riscv64_host.sh
ok   lab/ch12/run_aarch64.sh
ok   lab/ch12/splicing.nix
ok   lab/ch12/static_size.sh
ok   lab/ch12/wrong_category_fail.sh
```

9 个实验全部是 `ok`。其中 `wrong_category_fail.sh` 的 `ok` 是“按设计失败”：运行器见到 `_fail` 后缀，期待非零退出码，它的退出码是 1(`out/ch12/wrong_category_fail.status`)。

`make lint` 回显它跑的几条命令（`nixfmt --check`、`deadnix --fail`、`shellcheck`、`shfmt`；`statix` 那一行以 `@` 开头，`make` 不回显），没有任何诊断，退出码 0。`make check` 以 `all checks passed!` 结束，退出码 0，x86_64-linux 上有 14 个检查（第 11 篇是 11 个）：

```text
$ make check 2>&1 | tail -n 5; echo "rc=${PIPESTATUS[0]}"
derivation evaluated to /nix/store/sxj15y2pgk96v1kv2si52j1i2dqbbd5q-nixfmt-tree-2.5.0.drv
running 0 flake checks...
all checks passed!
warning: The check omitted these incompatible systems: aarch64-linux
Use '--all-systems' to check all.
rc=0
```

`make check` 很快，是因为这些包都已经在 store 里。`running 0 flake checks...` 这一行我读成“没有需要构建的检查”，但没有去查 Nix 的源码确认它的含义。冷启动的时候，`pkg-firn-hello-aarch64` 要先拿到 aarch64 的工具链。

`diff` 循环应当打印 10 行 `same ...`，不打印 diff(10 = 12 - 2)。

**必须和标签一致的文件：** `lab/ch12/` 下全部 10 个文件（9 个实验加 1 个 fixture）。

**中间版本（之后的章节会继续改）：**

- [`README.md`](https://github.com/bfmhno3/firn/blob/ch12/README.md)：每一章都会往目录说明和输出表里加行。
- [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch12/flake.nix)：`packagesFor` 现在导出 8 个包（含 `default`），再加三个只在 `x86_64-linux` 上的交叉与静态包，共 11 个；之后每章都会往 `packages`、`checks` 里加东西。
- [`default.nix`](https://github.com/bfmhno3/firn/blob/ch12/default.nix)：这一章没有改，它仍然只导出 6 个包和 `mini`，所以不用 flake 的人拿不到这三个交叉和静态包。

### 文件清单

这一篇的所有文件都在仓库里，链接指向标签 `ch12` 上的那一份。`git diff --name-only ch11 ch12` 列出 12 个文件，这里一个不少；`lab/ch12/` 下有 10 个文件（7 个 `.sh`、2 个 `.nix` 和 1 个 fixture），它们都已经在那 12 个里。`LICENSE-MIT`、`LICENSE-APACHE` 和 `pkgs/firn-hello/package.nix` 没有变，不在表里。实验需要沙箱目录，所以它们的命令都是 `make ch12`（`riscv64_host.sh` 是 `env -u CI make ch12`）；命令列里不是 `make ch12` 的，都是我手敲的，不在 `lab/ch12/` 里。结果列是我在 Nix 2.34.9 下实际跑出来的，标 `volatile` 的数字取决于缓存和机器的状态。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`README.md`](https://github.com/bfmhno3/firn/blob/ch12/README.md) | `git diff --numstat ch11 ch12 -- README.md` | 前两列是 1 和 0：新增 1 行、删除 0 行；输出表多了 `packages.x86_64-linux.{firn-hello-static,firn-hello-musl,firn-hello-aarch64}` 一行 |
| [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch12/flake.nix) | `make check` | 退出码 0，`all checks passed!`；x86_64-linux 的 `checks` 有 14 个，`packages` 有 11 个（含 `default`）；`git diff --numstat ch11 ch12 -- flake.nix` 的前两列是 24 和 12 |
| [`lab/ch12/cross_cc_name.sh`](https://github.com/bfmhno3/firn/blob/ch12/lab/ch12/cross_cc_name.sh) | `make ch12` | 退出码 0；`CC=aarch64-unknown-linux-gnu-gcc`，`NIX_CC=aarch64-unknown-linux-gnu-gcc-wrapper-15.3.0`；`gcc` 和 `cc` 那两行是开发 shell 漏进来的 |
| [`lab/ch12/ex_mingw.sh`](https://github.com/bfmhno3/firn/blob/ch12/lab/ch12/ex_mingw.sh) | `make ch12` | 退出码 0；练习 1 的答案；三步：`Refusing to evaluate package`，`install: cannot stat 'firn-hello'`，`PE32+ executable for MS Windows 5.02 (console)` |
| [`lab/ch12/file_types.sh`](https://github.com/bfmhno3/firn/blob/ch12/lab/ch12/file_types.sh) | `make ch12` | 退出码 0；四个二进制各一行，`firn-hello-static` 是 `statically linked`，`firn-hello-musl` 的解释器是 `ld-musl-x86_64.so.1`，`firn-hello-aarch64` 是 `ARM aarch64` |
| [`lab/ch12/fixtures/firn_hello_wrong_category.nix`](https://github.com/bfmhno3/firn/blob/ch12/lab/ch12/fixtures/firn_hello_wrong_category.nix) | `make ch12`（由 `wrong_category_fail.sh` 构建） | 变体 1（保留 `ZLIB_LIBS=-lz`）`exit status: 0`，变体 2 `exit status: 1`；它自己不被运行器直接执行 |
| [`lab/ch12/platforms.nix`](https://github.com/bfmhno3/firn/blob/ch12/lab/ch12/platforms.nix) | `make ch12` | 退出码 0；`pkgsStatic` 的 `build` 是 `x86_64-unknown-linux-gnu`，`host` 和 `target` 是 `x86_64-unknown-linux-musl`；`pkgsCrossAarch64` 的 `host` 是 `aarch64-unknown-linux-gnu`；`nativeCanExecute = false` |
| [`lab/ch12/riscv64_host.sh`](https://github.com/bfmhno3/firn/blob/ch12/lab/ch12/riscv64_host.sh) | `env -u CI make ch12` | 退出码 0（`CI=true` 时跳过）；`build plan` 一段为空；`volatile: build wall time 495 ms`；`file` 打印 `UCB RISC-V`；`qemu-riscv64` 输出 `crc32: 8bb8f4d3` |
| [`lab/ch12/run_aarch64.sh`](https://github.com/bfmhno3/firn/blob/ch12/lab/ch12/run_aarch64.sh) | `make ch12` | 退出码 0；`outputs are identical`；直接执行 `Exec format error`；`firn-hello: true`，`firn-hello-aarch64: false` |
| [`lab/ch12/splicing.nix`](https://github.com/bfmhno3/firn/blob/ch12/lab/ch12/splicing.nix) | `make ch12` | 退出码 0；`nativeBuildInputIsBuildHost = true`，`zlibBuildInputIsHostTargetDev = true`，`pkgConfigSpliceKeys` 有 5 个 |
| [`lab/ch12/static_size.sh`](https://github.com/bfmhno3/firn/blob/ch12/lab/ch12/static_size.sh) | `make ch12` | 退出码 0；`firn-hello` 16000 字节、闭包 37866984、6 个路径；`firn-hello-musl` 15672、4126656、3；`firn-hello-static` 61400、346416、3；`ldd` 说 `not a dynamic executable` |
| [`lab/ch12/wrong_category_fail.sh`](https://github.com/bfmhno3/firn/blob/ch12/lab/ch12/wrong_category_fail.sh) | `make ch12` | 退出码 1（按设计失败），stdout 里两段：变体 1 `exit status: 0`，变体 2 有 `undefined reference to 'crc32'` 和 `exit status: 1` |

## 练习

**1.** `pkgsCross.mingwW64.firn-hello` 能不能编？编出来的 `.exe` 用 `file` 看是什么？不改 `package.nix`。

<details>
<summary>参考答案</summary>

答案是 `lab/ch12/ex_mingw.sh`（[链接](https://github.com/bfmhno3/firn/blob/ch12/lab/ch12/ex_mingw.sh)）。它失败两次，原因不同，都是这个 rev 上的真实错误：

```bash
echo "== 1. as packaged"
nix build --no-link --file "${LAB_TMP}/plain.nix" 2>&1 \
  | grep -E 'Refusing to evaluate|hostPlatform.system' | strip_hash \
  | sed -E "s|${FIRN_ROOT}|<firn>|; s/^ +//"
echo

echo "== 2. meta.platforms widened"
nix build --no-link --file "${LAB_TMP}/platforms.nix" 2>&1 \
  | grep -E 'x86_64-w64-mingw32-gcc|cannot stat|^ *> make' | strip_hash \
  | sed -E 's/^ *> //; s|-I[^ ]*/include ||' | sort -u
echo

echo "== 3. install the .exe by hand"
if out="$(nix build --no-link --print-out-paths --file "${LAB_TMP}/exe.nix" 2>/dev/null)"; then
  ls "${out}/bin"
  file --brief "${out}/bin/firn-hello.exe"
else
  echo "build failed"
  exit 1
fi
```

```text
$ cat out/ch12/ex_mingw.stdout
== 1. as packaged
error: Refusing to evaluate package 'firn-hello-0.1.0' in <firn>/pkgs/firn-hello/package.nix:44 because it is not available on the requested hostPlatform:
hostPlatform.system = "x86_64-windows"

== 2. meta.platforms widened
install: cannot stat 'firn-hello': No such file or directory
make: *** [Makefile:17: install] Error 1
x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -o firn-hello firn-hello.c -lz

== 3. install the .exe by hand
firn-hello.exe
zlib1.dll
PE32+ executable for MS Windows 5.02 (console), x86-64 (stripped to external PDB), 10 sections
```

第一步，求值阶段就拒绝了：`package.nix` 的 `meta.platforms = lib.platforms.unix`，`x86_64-windows` 不在列表里，什么都没开始构建。第二步，我用 `overrideAttrs` 把 `meta.platforms` 放宽到 `lib.platforms.all`，这一次 `gcc` 跑起来了，但失败在 `install`：`install: cannot stat 'firn-hello'`。命令行里 `-o firn-hello`，mingw 的 gcc 实际写出来的是 `firn-hello.exe`，而 `Makefile` 的 `install` 规则装的是 `firn-hello`。这是 `src/firn-hello/Makefile` 的假设（可执行文件没有扩展名），不是 `package.nix` 的：它们之间的缝在 Windows 上才第一次露出来。第三步，我再改 `installPhase`，直接装 `firn-hello.exe`，才得到一个 `PE32+` 可执行文件。我没有运行它（运行需要 wine，这台机器上没有试）。

第三步的输出里还有一个我没要的 `zlib1.dll`。它是 `make-derivation.nix` 在 Windows 上自动加进来的：[546 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L546)：

```nix
# pkgs/stdenv/generic/make-derivation.nix:546-546
          ++ optional isWindows ../../build-support/setup-hooks/win-dll-link.sh
```

`win-dll-link.sh` 是一个 fixup hook，把 `.exe` 的 DLL 依赖找出来，链接进 `$out/bin`，因为 Windows 加载 DLL 时先搜索 `.exe` 所在的目录。第 3 步用到的表达式不在仓库里，放在仓库根目录（手敲，不在 `lab/ch12/` 里；它和 `ex_mingw.sh` 里写进临时目录的那份是同一个内容）：

```nix
let
  pkgs = import ./nix/pkgs.nix { };
in
pkgs.pkgsCross.mingwW64.firn-hello.overrideAttrs (old: {
  meta = old.meta // {
    platforms = pkgs.lib.platforms.all;
  };
  installPhase = ''
    runHook preInstall
    install -D -m 755 firn-hello.exe "$out/bin/firn-hello.exe"
    runHook postInstall
  '';
})
```

```text
$ o="$(nix build --no-link --print-out-paths --file exe.nix 2>/dev/null)"
ls -l "${o}/bin" | sed -E 's|/nix/store/[a-z0-9]{32}-||g'
total 84
-r-xr-xr-x 1 root root 80013 Dec 31  1969 firn-hello.exe
lrwxrwxrwx 1 root root    82 Dec 31  1969 zlib1.dll -> ../../8bj0hc2jalx9blab0n5liqhpdrizarfg-zlib-x86_64-w64-mingw32-1.3.2/bin/zlib1.dll
```

```text
$ nix log --file exe.nix 2>/dev/null | grep -E '^linking' | sed -E 's|/nix/store/[a-z0-9]{32}-||g'
linking zlib-x86_64-w64-mingw32-1.3.2/bin/zlib1.dll
```

`zlib1.dll` 是一个相对符号链接，指向 `zlib-x86_64-w64-mingw32-1.3.2` 的 `bin/zlib1.dll`，构建日志里 `linking .../zlib1.dll` 是这个 hook 打印的。

</details>

**2.** `firn-hello-static` 的闭包有 3 个路径，其中 82.0% 是静态 zlib 的 `propagated-build-inputs` 带进来的。不改 `src/`，用 `overrideAttrs` 把闭包压到 1 个路径，并确认它还能运行。

<details>
<summary>参考答案</summary>

`propagateBuildInputs` 适配器把 `buildInputs` 搬进了 `propagatedBuildInputs`。构建时仍然需要静态的 zlib，所以不能直接把后者清空：先把它们还给 `buildInputs`，再清空 `propagatedBuildInputs`。`old.propagatedBuildInputs` 已经是 splicing 之后的列表，直接用。这个文件不在仓库里，放在仓库根目录（手敲，不在 `lab/ch12/` 里）：

```nix
let
  pkgs = import ./nix/pkgs.nix { };
in
pkgs.pkgsStatic.firn-hello.overrideAttrs (old: {
  buildInputs = old.propagatedBuildInputs;
  propagatedBuildInputs = [ ];
})
```

```text
$ o="$(nix build --no-link --print-out-paths --file single.nix)"
nix path-info -r "${o}" | wc -l
stat --format=%s "${o}/bin/firn-hello"
"${o}/bin/firn-hello" nix
1
61400
Hello, nix, from firn-hello 0.1.0
crc32: 8bb8f4d3
```

三行输出：闭包 1 个路径，二进制 61,400 字节（和原来一模一样），输出和原生版逐字节相同。`nix-support/propagated-build-inputs` 没有了，引用扫描器没东西可扫。这个包是最终程序，没有下游，我没有找到这样改的代价。

</details>

**3.** `firn-hello-aarch64` 的 `doInstallCheck` 是 `false`，所以 `pkg-firn-hello-aarch64` 只证明能编。写一个 derivation，在构建里真的用 qemu 把它跑一遍，输出就是它的 stdout。不要手写 qemu 的路径。

<details>
<summary>参考答案</summary>

`hostPlatform.emulator` 就是为此存在的：给它一个包集（构建平台的），它返回一个能执行目标平台程序的路径，这里是 `qemu-aarch64`。Nix 的沙箱允许 qemu 的用户态模拟，所以不需要 `binfmt`。这个文件不在仓库里，放在仓库根目录（手敲，不在 `lab/ch12/` 里）：

```nix
let
  pkgs = import ./nix/pkgs.nix { };
  cross = pkgs.pkgsCross.aarch64-multiplatform;
in
pkgs.runCommand "firn-hello-aarch64-check" { } ''
  ${cross.stdenv.hostPlatform.emulator pkgs} ${cross.firn-hello}/bin/firn-hello nix > "$out"
''
```

```text
$ cat "$(nix build --no-link --print-out-paths --file qemu_check.nix)"
Hello, nix, from firn-hello 0.1.0
crc32: 8bb8f4d3
```

输出和原生版、`run_aarch64.sh` 里的一样：`crc32: 8bb8f4d3`。把它放进 `flake.nix` 的 `checks`，就是一个不依赖 `binfmt`、会真的运行交叉二进制的检查；仓库里我没有这样做。

</details>

## 下一篇

第 13 篇《开发环境：devShell、direnv 与 templates》要回到我每次 `make ch12` 都得先敲的那句 `nix develop`：这个 shell 里到底有什么，怎么让进入目录就自动进入它。这一篇的 `nix develop --file ... --command` 已经把它当工具用了好几次，包括那个让 `gcc` 漏进来的坑。我猜，等我把它写成模板，同样的坑还会换个名字再来一次。
