---
title: "打包真项目：Cairn、Sift 与 Pebble"
commentId: "post:nix-by-firn-11-packaging-real-projects"
published: "2026-11-06 01:00:00 +08:00"
description: "用 Firn 从零学 Nix 第 11 篇：我用 Nix 2.34.9 把自己写的三个项目，Bash 的 Cairn、Python 的 Sift、Rust 的 Pebble，打成 nixpkgs 风格的包，用 10 个实验拆开 patchShebangs、makeWrapper、buildPythonApplication 和 buildRustPackage：同样是一个命令行工具，闭包从 firn-hello 的 36.1 MiB 涨到 Sift 的 268.2 MiB，相差 7.4 倍，而一个 Bash 写的备份工具就有 129.7 MiB。"
category: Tutorial
tags:
  - Nix
  - NixOS
  - Firn
  - 打包
  - Rust
  - Python
  - Shell
series: "用 Firn 从零学 Nix"
seriesOrder: 11
draft: false
comment: true
slug: nix-by-firn-11-packaging-real-projects
---

我手上有三个自己写的小项目：Bash 写的备份工具 Cairn，一个本地 Markdown 全文搜索 Sift (Python)，一个从零写的脚本语言 Pebble (Rust)。在我的 NixOS 上，它们现在都是 `~/src` 里的目录，要用的时候我 `cd` 进去跑。上一篇我把一个 47 行的 C 程序打成了包，包很乖：源码在本地，依赖只有一个 zlib。这一篇我把三个真项目打成包，然后问同一个问题：这三个东西的闭包有多大？

```text
$ cat out/ch11/closures.stdout
package           closure  paths
firn-hello        36.1MiB      6
cairn            129.7MiB     46
sift             268.2MiB     39
pebble            47.8MiB      7
```

一个 Bash 工具，闭包是 C 程序的 3.6 倍。Python 应用 268.2 MiB，是 `firn-hello` 的 7.4 倍。Rust 的 Pebble 反而最老实：47.8 MiB，7 个路径，比 Cairn 小一大半。我原本以为顺序会反过来（Rust 重，Bash 轻），所以这一篇的主线很简单：每个数字背后是哪个构建器、哪一行 `package.nix` 决定的。

> [!NOTE] 本篇检查点
> 这一篇结束时，Firn 仓库的标签 `ch11` 里：新增 `pkgs/cairn/package.nix`（102 行）、`pkgs/sift/package.nix`（55 行）、`pkgs/pebble/package.nix`（41 行）、`pkgs/firn-tools/package.nix`（17 行）、`pkgs/cairn-report/package.nix`（13 行）；`overlays/default.nix` 从 3 行变成 8 行，现在有 6 个属性；`default.nix` 的导出和 `flake.nix` 的 `packages` 各多了 5 个包，`checks.<system>.pkg-<name>` 因此从 2 个变成 7 个；`README.md` 的目录说明多了 `pkgs/` 和 `overlays/` 两行，输出表多了 `packages` 和 `overlays.default` 两行，`checks` 一行加上了 `pkg-*`；`lab/ch11/` 下有 10 个实验（9 个 `.sh` 和 1 个 `.nix`），没有 fixture 文件。`make ch11` 全部 `ok`。
> 涉及的 Nix 特性：`stdenvNoCC`、`fetchFromGitHub` 的 `tag`、`patchShebangs`、`makeWrapper` 与 `wrapProgram`、`checkPhase` 与 `installCheckPhase`、`nativeCheckInputs`、`buildPythonApplication`（`pyproject`、`build-system`、`dependencies`、`pythonImportsCheck`）、`buildRustPackage`（`cargoHash`、`cargoBuildFlags`、`cargoTestFlags`）、`symlinkJoin`、`writeShellApplication`、`writeText`、`writeTextFile`、`runCommand`、`linkFarm`、`nurl`、`nix-init`。
> 前置：[第 10 篇：nixpkgs：callPackage、override、overlay 与 fetcher](/posts/nix-by-firn-10-callpackage-overrides-overlays/)。这一篇的每个 `package.nix` 都靠那一篇的 `callPackage`、overlay 和 `fetchFromGitHub` 才能写出来。
> 终稿与否：`pkgs/*/package.nix` 和 `lab/ch11/*` 在这里就是终稿；`README.md`、`default.nix`、`flake.nix`、`overlays/default.nix` 之后每次加包还会改。

## 环境

这一篇所有输出来自这台机器：NixOS 26.05，上游 Nix 2.34.9，nixpkgs 钉在 `56c02bc00adcf003215cc4bd996d6efaf4cff188`，`x86_64-linux`。在这个 rev 上：bash 5.3p15，Python 3.14.7，hatchling 1.31.0，bats 1.14.0，rustc 和 cargo 1.97.1，gcc 15.3.0。文中引用的 nixpkgs 源码都链接到这个 rev，行号我都在本地的那份源码上核对过。

另外两个工具的版本：`nurl` 0.4.0，`nix-init` 0.3.6（后文关于 `nix-init --builder` 选项的说法只对这个版本成立）。

我的 shell 里设了 `CI=true`，Firn 的运行器会据此跳过 `_host` 实验。第 11 章没有 `_host` 实验，所以我跑的是 `env -u CI make ch11`，和前几篇一致。这条命令（含 `nix develop` 的启动）花了 5 分 14.6 秒。这一篇所有的耗时都是这一台机器上的单次或少数几次测量，只能当量级看。

三个项目，三种语言，打包时要回答的问题是同一组：

| 项目 | 语言 | 源码 | 构建 | 测试 | 运行时要什么 |
| --- | --- | --- | --- | --- | --- |
| Cairn | Bash | `bfmhno3/cairn` 的标签 `ch10` | 没有，`install.sh` 复制文件 | bats，6 个文件，81 个测试 | bash 和 7 个命令行工具 |
| Sift | Python | `bfmhno3/sift` 的标签 `ch25` | hatchling 打 wheel | 没有（需要 dev 额外依赖和语料库） | Python 3.14 和 4 个依赖库 |
| Pebble | Rust | `bfmhno3/pebble` 的标签 `tutorial-v1` | cargo，16 个 crate 的 workspace | `cargo test`，3 加 12 个测试 | glibc 和 libgcc_s |

右边两列是这一篇真正的内容。左边的 `src` 在上一篇已经解决了，三个都是 `fetchFromGitHub` 加一个 `tag`。

## Cairn：不用编译的项目，为什么要三个构建器钩子

Cairn 的 `package.nix` 一共 102 行。头 35 行决定了“Cairn 是什么样的包”：

```nix
{
  lib,
  stdenvNoCC,
  fetchFromGitHub,
  makeWrapper,
  bash,
  bats,
  coreutils,
  findutils,
  gawk,
  gnugrep,
  gnused,
  rsync,
  util-linux,
}:

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "cairn";
  version = "0.1.0";

  src = fetchFromGitHub {
    owner = "bfmhno3";
    repo = "cairn";
    tag = "ch10";
    hash = "sha256-y+6fZYN1bMicL+IzPC1Wr4mrol+VEVkiDFWuxtsiSxg=";
  };

  nativeBuildInputs = [ makeWrapper ];

  # patchShebangs 在 PATH 上找解释器：buildInputs 里的 bash 排在 stdenv 自带的
  # bash 之前，所以 #!/usr/bin/env bash 会指向 pkgs.bash (bash-interactive)。
  # 去掉这一行也会被改写，只是改成 stdenv 的 bash，闭包小约 7.6 MiB。
  buildInputs = [ bash ];

  dontBuild = true;
  # ...
```

这是节选，省略的是 `installPhase` 到 `meta`，它们各有自己的小节。头一个选择是 `stdenvNoCC` 而不是 `stdenv`。`stdenvNoCC` 是 `stdenv.override { cc = null; hasCC = false; ... }`（[`pkgs/top-level/stage.nix` 第 57 到 60 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/stage.nix#L57-L60)），构建环境里没有 C 编译器。Cairn 没有东西可编译，`dontBuild = true` 跳过 `buildPhase`，安装靠 `install.sh --prefix "$out"` 复制文件。我手敲验证了一下，两个包的 `stdenv.hasCC` 不同（手敲，不在 `lab/ch11/` 里）：

```text
$ nix eval .#cairn.stdenv.hasCC
false
$ nix eval .#firn-hello.stdenv.hasCC
true
```

用 `stdenvNoCC` 的好处只是构建环境里没有 `cc`，我没有量过它省了多少：Cairn 的 `.drv` 闭包里照样有 gcc-wrapper，所以别指望它大幅减少构建依赖。

## patchShebangs：`#!/usr/bin/env bash` 在沙箱里不存在

Cairn 的 `bin/cairn` 第一行是 `#!/usr/bin/env bash`，在任何普通 Linux 上都对。在 Nix 的构建沙箱里，这个路径不存在。我写了一个只有一条命令的 derivation 去看沙箱里到底有什么（手敲，不在 `lab/ch11/` 里）：

```text
$ nix build --no-link --impure --print-out-paths --expr 'let p = import ./nix/pkgs.nix { }; in p.runCommand "probe" { } "{ ls -l /usr/bin/env /bin; echo; ls /usr 2>&1; } > $out 2>&1 || true"' | xargs cat
ls: cannot access '/usr/bin/env': No such file or directory
/bin:
total 228
-r-xr-xr-x 2 nobody nogroup 232728 Jan  1  1970 sh

ls: cannot access '/usr': No such file or directory
```

沙箱里只有一个 `/bin/sh`。所以脚本的解释器必须在构建时被改成 store 里的绝对路径，否则装出来的 `cairn` 离开沙箱，在没有 `/usr/bin/env` 的机器上就跑不起来。我的 NixOS 上 `/usr/bin` 里只有一个 `env`，是指向 coreutils 的软链接（`ls -l /usr/bin` 只列出这一项），这是 NixOS 的一个特例，不是 Nix 的保证。做这件事的是 stdenv 的 `patchShebangs` ([`patch-shebangs.sh`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/setup-hooks/patch-shebangs.sh))。它有两个入口：

- 第 10 行 `fixupOutputHooks+=(patchShebangsAuto)` 把它挂到 fixup 阶段，对每个输出目录自动跑一遍；
- 第 25 行的函数 `patchShebangs` 可以在任何阶段手动调用。

查找解释器的办法写在第 81 到 87 行：调用时没有写 `--host` 或 `--build`，函数就对每个文件判断一次，`strictDeps` 打开并且文件在 store 里就用 `HOST_PATH`，否则用 `PATH`，然后用 `type -P` 在这个搜索路径里找解释器的名字。`patchShebangsAuto`（第 156 到 168 行）对普通输出显式传 `--host`，也就是用 `HOST_PATH`。

`HOST_PATH` 里有什么？[`setup.sh` 第 863 到 865 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L863-L865)：`hostOffset` 是 0 的依赖，也就是 `buildInputs`，把自己的 `bin/` 加进 `_HOST_PATH`。到第 977 和 978 行，最终的 `PATH` 与 `HOST_PATH` 都是 `_PATH` 或 `_HOST_PATH`（依赖的 `bin/`）排在 stdenv 自带的 `initialPath` 之前拼出来的。所以 `buildInputs` 里的解释器先被 `type -P` 找到。注意这只在 `strictDeps` 没打开时成立：`buildInputs` 进 `_PATH` 的条件是 `strictDeps` 为空（[`setup.sh` 第 855 到 857 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L855-L857)），`strictDeps = true` 时它们只出现在 `HOST_PATH` 里。`preCheck` 里的 `patchShebangs bin` 没有写 `--host`，所以用的是 `PATH`（`patch-shebangs.sh` 第 81 到 86 行）；Cairn 没有打开 `strictDeps`，所以 `buildInputs` 里的 `bash` 在 `PATH` 里。

`lab/ch11/patch_shebangs.sh` 对比源码和产物的第一行：

```bash
src="$(nix build --no-link --print-out-paths "${FIRN_ROOT}#cairn.src")"
out="$(nix build --no-link --print-out-paths "${FIRN_ROOT}#cairn")"

echo "src:  $(head -n 1 "${src}/bin/cairn")"
echo "out:  $(head -n 1 "${out}/bin/.cairn-wrapped")"
echo "bash: $(nix eval --raw "${FIRN_ROOT}#cairn.buildInputs" --apply 'bs: (builtins.head bs).name')"
```

输出：

```text
$ head -n 3 out/ch11/patch_shebangs.stdout
src:  #!/usr/bin/env bash
out:  #!/nix/store/90nk33c4fkyg4x4dfk5cykqiryf2nlqq-bash-interactive-5.3p15/bin/bash
bash: bash-interactive-5.3p15
```

最后一行让我愣了一下：`buildInputs` 里的 `bash` 叫 `bash-interactive-5.3p15`。

## 意外的 bash-interactive

我以为 `pkgs.bash` 是最小的那个 bash。不是。在这个 rev 上，`bash` 是带 readline 的交互式 bash，最小的那个叫 `bashNonInteractive`，stdenv 的 `runtimeShell` 用的是它（[`all-packages.nix` 第 3062 到 3072 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/all-packages.nix#L3062-L3072)）：

```nix
  runtimeShell = "${runtimeShellPackage}${runtimeShellPackage.shellPath}";
  runtimeShellPackage = bashNonInteractive;

  bash = callPackage ../shells/bash/5.nix { };
  bashNonInteractive = lowPrio (
    callPackage ../shells/bash/5.nix {
      interactive = false;
    }
  );
  # WARNING: this attribute is used by nix-shell so it shouldn't be removed/renamed
  bashInteractive = bash;
```

于是 Cairn 的闭包里有两个 bash（手敲，不在 `lab/ch11/` 里）：

```text
$ nix path-info -r $(nix build --no-link --print-out-paths .#cairn) | sed 's|/nix/store/[a-z0-9]*-||' | grep -E '^(bash|readline)'
bash-5.3p15
readline-8.3p3
bash-interactive-5.3p15
```

`bash-interactive` 是 `buildInputs` 里的那个，`.cairn-wrapped` 的 shebang 指向它；`bash-5.3p15` 是 `makeWrapper` 生成的包装脚本用的。两个 bash，47.2 MiB 和 37.7 MiB（这是各自的闭包大小，共享 glibc）。

我第一版 `package.nix` 里的注释写的是：`patchShebangs` 只改写 `buildInputs` 里有的解释器，所以要放一个 `bash`。我把 `buildInputs` 清空试了一次（手敲，不在 `lab/ch11/` 里）：

```text
$ nix build --no-link --print-out-paths --impure --expr '(import ./nix/pkgs.nix { }).cairn.overrideAttrs { buildInputs = [ ]; }'
/nix/store/ngwji371i9zc2zvj8y96a1666jvldj1q-cairn-0.1.0
$ head -n 1 /nix/store/ngwji371i9zc2zvj8y96a1666jvldj1q-cairn-0.1.0/bin/.cairn-wrapped
#!/nix/store/byi2zpy2bgcf3dr6y0l8m50rmjj8z7q1-bash-5.3p15/bin/bash
$ nix path-info -Sh /nix/store/ngwji371i9zc2zvj8y96a1666jvldj1q-cairn-0.1.0
/nix/store/ngwji371i9zc2zvj8y96a1666jvldj1q-cairn-0.1.0	 122.1 MiB
```

脚本照样被改写了，只是改成了 stdenv 自带的 `bash-5.3p15`，闭包从 129.7 MiB 掉到 122.1 MiB（44 个路径，少了 `bash-interactive` 和 `readline`）。所以那条注释说得太绝对：`buildInputs` 里的 `bash` 不是改写的前提，它的作用是**选哪个 bash**。写 `buildInputs = [ bash ]` 的人（我）以为在启用一个功能，实际上是在选一个比默认更大的版本。现在 `package.nix` 里的注释已经改成了这个意思。

## patchShebangs 在哪个阶段动手

`lab/ch11/patch_shebangs.sh` 的最后一部分，是我在这一篇写到一半时发现我对“哪个阶段”的理解是错的之后加的。我原来以为：`patchShebangs` 是 fixup 阶段做的事，对源码什么也没动。看构建日志（手敲，不在 `lab/ch11/` 里）：

```text
$ nix log .#cairn | grep -E 'patching script|interpreter directive|Running phase' | sed 's|/nix/store/[a-z0-9]*-||g'
Running phase: unpackPhase
Running phase: patchPhase
Running phase: updateAutotoolsGnuConfigScriptsPhase
Running phase: configurePhase
Running phase: checkPhase
patching script interpreter paths in bin
bin/cairn: interpreter directive changed from "#!/usr/bin/env bash" to "bash-interactive-5.3p15/bin/bash"
Running phase: installPhase
Running phase: fixupPhase
patching script interpreter paths in cairn-0.1.0
Running phase: installCheckPhase
```

改写发生在 `checkPhase` 里（准确地说，是 `preCheck` 钩子里 `patchShebangs bin` 那一行），fixup 阶段的 `patching script interpreter paths in cairn-0.1.0` 之后没有 `changed` 行：脚本在安装之前就已经被改好了，`install.sh` 把改好的文件复制进了 `$out`，fixup 看到解释器已经在 store 里，就不再动它。把测试关掉，改写就回到 fixup 阶段（手敲，不在 `lab/ch11/` 里）：

```text
$ nix build --no-link -L --impure --expr '(import ./nix/pkgs.nix { }).cairn.overrideAttrs { doCheck = false; }' 2>&1 | grep -E 'interpreter|Running phase' | sed 's|/nix/store/[a-z0-9]*-||g'
cairn> Running phase: unpackPhase
cairn> Running phase: patchPhase
cairn> Running phase: updateAutotoolsGnuConfigScriptsPhase
cairn> Running phase: configurePhase
cairn> Running phase: installPhase
cairn> Running phase: fixupPhase
cairn> patching script interpreter paths in cairn-0.1.0
cairn> cairn-0.1.0/bin/cairn: interpreter directive changed from "#!/usr/bin/env bash" to "bash-interactive-5.3p15/bin/bash"
cairn> Running phase: installCheckPhase
```

`lab/ch11/patch_shebangs.sh` 在 `src`、`out`、`bash` 这三行之后，把这两种情况都跑一遍：`rewrite_phase` 函数用 `awk` 从 `nix log` 里取“改写发生在哪个阶段”。它的后半段输出是：

```text
$ tail -n +5 out/ch11/patch_shebangs.stdout
== doCheck = true (package.nix)
  checkPhase: bin/cairn rewritten

== doCheck = false (overrideAttrs)
  fixupPhase: bin/cairn rewritten
```

为什么 Cairn 要在 `preCheck` 里手动 `patchShebangs bin`？因为测试直接运行 `bin/cairn`（在源码树里，不在 `$out` 里），而沙箱里没有 `/usr/bin/env`。我把 `preCheck` 去掉，手敲跑一遍（手敲，不在 `lab/ch11/` 里）：

```text
$ nix build --no-link -L --impure --expr '(import ./nix/pkgs.nix { }).cairn.overrideAttrs { preCheck = ""; }' 2>&1 | tail -n 12 | sed 's|/nix/store/[a-z0-9]*-||g'
       >      `common_setup' failed with status 126
       >    /build/source/tests/test_helper.bash: /build/source/bin/cairn: /usr/bin/env: bad interpreter: No such file or directory
       >  ✗ report rows are sorted by day, oldest first
       >    (from function `common_setup' in file tests/test_helper.bash, line 57,
       >     from function `setup' in test file tests/test_helper.bash, line 62)
       >      `common_setup' failed with status 126
       >    /build/source/tests/test_helper.bash: /build/source/bin/cairn: /usr/bin/env: bad interpreter: No such file or directory
       > 
       > 81 tests, 81 failures
       > 
       For full logs, run:
         nix log cairn-0.1.0.drv
```

81 个测试，81 个失败，每个都是同一句 `/usr/bin/env: bad interpreter`。这也解释了 `package.nix` 里 `preCheck` 的第二行：`snapshot.bats` 里有一个假的 `rsync`，它自己的第一行也是 `#!/usr/bin/env bash`，要用 `substituteInPlace` 一起改掉。`package.nix` 里的这一段：

```nix
  # 构建沙箱里没有 /usr/bin/env，测试直接运行 bin/cairn，先改写它的 shebang。
  # snapshot.bats 里的假 rsync 也是 #!/usr/bin/env bash，一并改掉。
  preCheck = ''
    patchShebangs bin
    substituteInPlace tests/snapshot.bats \
      --replace-fail '#!/usr/bin/env bash' '#!${bash}/bin/bash'
  '';
```

## wrapProgram：给脚本口袋里缝一张便条

改写完 shebang，Cairn 还有第二个问题：它调用 `rsync`、`flock`、`sha256sum`、`awk`、`find`……这些命令靠调用者的 `PATH` 找。在我的 NixOS 上碰巧都有，在一个最小的容器里就未必；更糟的是，今天碰巧有，明天 `PATH` 里的 `awk` 换成了 busybox 的，行为就变了。`package.nix` 的 `postFixup` 是这样解决的：

```nix
  # wrapProgram 把 PATH 固定到运行时依赖，包不再依赖调用者的环境。
  postFixup = ''
    wrapProgram "$out/bin/cairn" --prefix PATH : ${
      lib.makeBinPath [
        coreutils
        findutils
        gawk
        gnugrep
        gnused
        rsync
        util-linux
      ]
    }
  '';
```

`wrapProgram` 是 `makeWrapper` 这个 setup hook 提供的 shell 函数。`makeWrapper` 在 nixpkgs 里就是 `makeShellWrapper`（[`all-packages.nix` 第 716 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/top-level/all-packages.nix#L716)），所以它的包装器是一个 shell 脚本，用 `runtimeShell` 当解释器（同一文件第 718 到 727 行的 `substitutions.shell`）。`wrapProgramShell` 做三件事（[`make-wrapper.sh` 第 225 到 237 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/setup-hooks/make-wrapper.sh#L225-L237)）：

1. 取 `bin/cairn` 同目录下的 `.cairn-wrapped` 作为隐藏名字（已存在就在名字末尾加 `_`）；
2. `mv` 把原脚本改名成 `.cairn-wrapped`；
3. 在原来的名字上用 `makeShellWrapper` 写一个新脚本，带 `--inherit-argv0`，再接你传的参数（这里是 `--prefix PATH : ...`）。

`lab/ch11/cairn_wrapped.sh` 让我看到这个结果。它先看包装器的头 12 行和被包的脚本的 shebang，再用打好的包做一次快照并校验，不碰宿主机的任何东西：

```bash
out="$(nix build --no-link --print-out-paths "${FIRN_ROOT}#cairn")"

echo "== head of bin/cairn (the wrapper)"
head -n 12 "${out}/bin/cairn"

echo
echo "== shebang of .cairn-wrapped"
head -n 1 "${out}/bin/.cairn-wrapped"
```

后半段是造一个两个文件的目录、写 `cairn.conf`、`init`、固定 `CAIRN_NOW=20261102T000000Z` 打快照、`verify`。输出：

```text
$ cat out/ch11/cairn_wrapped.stdout
== head of bin/cairn (the wrapper)
#! /nix/store/byi2zpy2bgcf3dr6y0l8m50rmjj8z7q1-bash-5.3p15/bin/bash -e
PATH=${PATH:+':'$PATH':'}
PATH=${PATH/':''/nix/store/156fzvaz2nsq2hk0fkzn9jwk90bnzyn9-util-linux-2.42.2-bin/bin'':'/':'}
PATH='/nix/store/156fzvaz2nsq2hk0fkzn9jwk90bnzyn9-util-linux-2.42.2-bin/bin'$PATH
PATH=${PATH#':'}
PATH=${PATH%':'}
export PATH
PATH=${PATH:+':'$PATH':'}
PATH=${PATH/':''/nix/store/5zdskjaigxmdzjnsmws8cc9dp6ldf7ax-rsync-3.4.4/bin'':'/':'}
PATH='/nix/store/5zdskjaigxmdzjnsmws8cc9dp6ldf7ax-rsync-3.4.4/bin'$PATH
PATH=${PATH#':'}
PATH=${PATH%':'}

== shebang of .cairn-wrapped
#!/nix/store/90nk33c4fkyg4x4dfk5cykqiryf2nlqq-bash-interactive-5.3p15/bin/bash

== snapshot and verify with CAIRN_NOW=20261102T000000Z
20261102T000000Z
ok 20261102T000000Z (2 files)
```

包装器第一行是 `bash-5.3p15`（`runtimeShell`，非交互版），`.cairn-wrapped` 的 shebang 是 `bash-interactive-5.3p15`：两个 bash 的来源现在对上了。`cairn_wrapped.stderr` 里还有一行 `cairn: snapshot 20261102T000000Z: 2 files, 12 bytes transferred in 0 s`，那是 Cairn 自己的日志，写在 stderr。

包装器一共 44 行，其中 `--prefix` 每个目录占 6 行（7 个目录是 42 行），再加 `#!` 和最后的 `exec`。最后一行是：

（手敲，不在 `lab/ch11/` 里）

```text
$ C=$(nix build --no-link --print-out-paths .#cairn)
$ tail -n 1 $C/bin/cairn | sed 's|/nix/store/[a-z0-9]*-||g'
exec -a "$0" "cairn-0.1.0/bin/.cairn-wrapped"  "$@" 
```

被包的脚本看到的 `$0` 还是 `bin/cairn`（这就是 `exec -a "$0"`，即 `--inherit-argv0`），但 Cairn 不靠 `$0`：它用 `readlink -f -- "${BASH_SOURCE[0]}"` 找 `lib/cairn/`，`BASH_SOURCE[0]` 是 `.cairn-wrapped` 自己的路径，所以只要 `.cairn-wrapped` 和包装器在同一个 `bin/` 里，`../lib/cairn` 就成立（`--inherit-argv0` 对 Cairn 没有影响；`installPhase` 漏装 `lib/` 的实验断的就是这条路径）。

七个 `--prefix` 的最终顺序，我手敲去量（把包装器最后的 `exec` 行去掉，在末尾打印 `PATH`，从空环境里跑；手敲，不在 `lab/ch11/` 里）：

```text
$ env -i $(command -v bash) <(sed '/^exec/d' $C/bin/cairn; echo 'echo "$PATH"') | tr ':' '\n' | sed 's|/nix/store/[a-z0-9]*-||'
coreutils-9.11/bin
findutils-4.11.0/bin
gawk-5.4.1/bin
gnugrep-3.12/bin
gnused-4.10/bin
rsync-3.4.4/bin
util-linux-2.42.2-bin/bin
/no-such-path
```

和 `makeBinPath` 的列表顺序一致：每个 `--prefix` 块把自己放到 `PATH` 的最前，所以包装器文件里排在头部的 `util-linux` 块最先执行，最后一个块 `coreutils` 最后执行，结果排在 `PATH` 的第一位。末尾的 `/no-such-path` 是我用 `env -i` 清掉环境之后，这个 bash 自己带的默认值，不是包装器加的。

注意是 `--prefix`，不是 `--set`：调用者的 `PATH` 还留在这 7 个目录之后。包装器只保证它们排在最前，不保证隔离，所以脚本里要是调用了一个没列出来的命令，它在我的机器上能跑、在别人那里不能，这种 bug `installCheckPhase` 和测试也未必查得出来。这个取舍我是知道的，我在 Cairn 里的做法是把用到的命令所在的包都列出来。

我用一个比喻把这件事记下来：`wrapProgram` 像给一个不认路的旅行者在口袋里缝一张写着地址的便条。人（脚本）本身一个字没改，只是不管谁把他扔在哪，口袋里总有张纸告诉他去哪找 `rsync`。

`makeWrapper` 还有一个兄弟 `makeBinaryWrapper`，它用 `cc` 编译出一个二进制包装器（[`makeBinaryWrapper/package.nix`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/ma/makeBinaryWrapper/package.nix) 的 `substitutions.cc`）。Cairn 是 `stdenvNoCC`，没有编译器，我没有试过在这个设置里用它。

## resholve：另一条路

nixpkgs 里还有一条处理“脚本依赖哪些命令”的路，叫 resholve：它读 shell 脚本，把对外部命令的裸引用换成绝对路径，这样脚本的依赖在构建时就被声明、被检查，不再靠 `PATH`（[README 第 1 到 4 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/development/misc/resholve/README.md#L1-L4)）。它的解析器是 OSH/Oil，README 第 17 到 19 行自己写明“只追求大约 90% 的覆盖”。Firn 的 Cairn 用 `wrapProgram` 而不是 resholve，原因我只有推测，没有测过：Cairn 入口脚本里有 7 行 `source "${CAIRN_LIB}/xxx.sh"`（路径是变量），库里有 `xargs -0 -r -P "${jobs}" -n 64 sha256sum` 这种把命令交给另一个命令的写法，按 README 第 254 到 256 行的例子，变量路径的 `source` 要用 `keep` 指令逐个声明，我猜这些都得写出来；而 `wrapProgram` 一行就够。我没有在 Cairn 上跑过 resholve，所以不知道它实际会报多少处。

## checkPhase：81 个测试，和 stdenv 的顺序

Cairn 的 `doCheck = true`，测试用 bats。`lab/ch11/cairn_checkphase.sh` 取 `nix log`（本机没有构建日志就 `--rebuild` 一次），挑出阶段标题和 bats 的汇总行：

```bash
grep -E 'Running phase: (checkPhase|installPhase|installCheckPhase)' "${log}"
grep -E '^(cairn> )?[0-9]+ tests, [0-9]+ failures' "${log}" | sed 's/^cairn> //'
```

输出：

```text
$ cat out/ch11/cairn_checkphase.stdout
Running phase: checkPhase
Running phase: installPhase
Running phase: installCheckPhase
81 tests, 0 failures
```

三个阶段的顺序是 `checkPhase`、`installPhase`、`installCheckPhase`，不是我们直觉里的“先装、再测”。顺序写在 [`setup.sh` 的 `definePhases`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L1777-L1784)：

```text
unpackPhase patchPhase configurePhase buildPhase checkPhase installPhase fixupPhase installCheckPhase distPhase
```

（这是我把第 1780 到 1783 行里那几个 `pre*Phases` 的插槽去掉之后的主干。）两个检查阶段的差别：

- `checkPhase` 在 `buildPhase` 之后、`installPhase` 之前，跑在**构建树**里。能不能跑由 `doCheck` 决定（[`setup.sh` 第 1749 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L1749)）；它需要的工具放进 `nativeCheckInputs`，并且只有 `doCheck` 为真时才会进依赖（[`make-derivation.nix` 第 541 到 548 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/make-derivation.nix#L541-L548)）。
- `installCheckPhase` 在 `fixupPhase` 之后，跑在**装好的产物** `$out` 里（[`setup.sh` 第 1752 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/setup.sh#L1752)），由 `doInstallCheck` 控制，依赖放进 `nativeInstallCheckInputs`。

最后一句我量了一下：Cairn 的 `.drv` 引用 15 个路径，其中 1 个是 `bats`；`overrideAttrs { doCheck = false; }` 之后是 14 个，0 个 `bats`（手敲，不在 `lab/ch11/` 里）：

```text
$ D1=$(nix eval --raw .#cairn.drvPath)
$ D2=$(nix eval --impure --raw --expr '((import ./nix/pkgs.nix { }).cairn.overrideAttrs { doCheck = false; }).drvPath')
$ for D in $D1 $D2; do echo "$(nix-store -q --references $D | grep -c bats) bats, $(nix-store -q --references $D | wc -l) references"; done
1 bats, 15 references
0 bats, 14 references
```

也就是说，`checkPhase` 回答“源码是对的吗”，`installCheckPhase` 回答“装出来的东西是对的吗”，包装器、shebang、漏装的文件都是后者才看得到的。我做一个实验，让 `installPhase` 漏装 `lib/`（手敲，不在 `lab/ch11/` 里）：

```nix
let
  pkgs = import /home/bfmhno3/Projects/firn/nix/pkgs.nix { };
in
pkgs.cairn.overrideAttrs {
  installPhase = ''
    install -D bin/cairn "$out/bin/cairn"
  '';
}
```

（手敲，不在 `lab/ch11/` 里）

```text
$ nix build --no-link -L --impure --file /tmp/ch11-scratch/no_lib.nix 2>&1 | grep -E 'tests, |Running phase: (checkPhase|installPhase|installCheckPhase)|No such file|error: ' | sed 's|/nix/store/[a-z0-9]*-||g'
cairn> Running phase: checkPhase
cairn> 81 tests, 0 failures
cairn> Running phase: installPhase
cairn> Running phase: installCheckPhase
cairn> cairn-0.1.0/bin/.cairn-wrapped: line 27: cairn-0.1.0/bin/../lib/cairn/log.sh: No such file or directory
error: Cannot build 'cairn-0.1.0.drv'.
       > 81 tests, 0 failures
       > Running phase: installPhase
       > Running phase: installCheckPhase
       > cairn-0.1.0/bin/.cairn-wrapped: line 27: cairn-0.1.0/bin/../lib/cairn/log.sh: No such file or directory
```

81 个测试全过，构建照样失败，失败发生在 `installCheckPhase` 里那一行 `"$out/bin/cairn" --version`：测试跑的是源码树里的 `bin/cairn`，旁边有 `lib/`，所以过；装出来的 `bin/` 旁边没有，所以挂。这个 `installCheckPhase` 只有一行断言，却正好是 81 个测试都看不到的那类错误。

### 六个文件，81 个测试，三个没列的

`package.nix` 里的 `nativeCheckInputs`、`preCheck` 和 `checkPhase` 连在一起是这样：

```nix
  doCheck = true;
  nativeCheckInputs = [
    (bats.withLibraries (l: [
      l.bats-support
      l.bats-assert
      l.bats-file
    ]))
    rsync
    util-linux
    gawk
  ];
  # ...
  # 这里只跑 cli、config、prune、snapshot、verify_diff、report 六个文件（81 个测试）；
  # install.bats 在沙箱里不能通过（34/35），completion 和 lock_signal 实测能通过，但没有列入。
  checkPhase = ''
    runHook preCheck
    bats --formatter pretty tests/cli.bats tests/config.bats tests/prune.bats \
      tests/snapshot.bats tests/verify_diff.bats tests/report.bats
    runHook postCheck
  '';
```

`package.nix` 的 `checkPhase` 只跑 6 个 bats 文件。`tests/` 里一共有 9 个，我数过每个文件里的 `@test`：

| 文件 | 测试数 | 在 `checkPhase` 里 |
| --- | --- | --- |
| `cli.bats` | 16 | 是 |
| `config.bats` | 14 | 是 |
| `prune.bats` | 14 | 是 |
| `snapshot.bats` | 20 | 是 |
| `verify_diff.bats` | 12 | 是 |
| `report.bats` | 5 | 是 |
| `completion.bats` | 22 | 否 |
| `install.bats` | 35 | 否 |
| `lock_signal.bats` | 12 | 否 |

前六行加起来 16 加 14 加 14 加 20 加 12 加 5，是 81，和日志里的 `81 tests` 对得上。没列的三个为什么不跑，我最初的假设是“都需要沙箱之外的东西”，所以我去量。把九个文件逐个放进沙箱里跑（手敲，不在 `lab/ch11/` 里）：

```nix
let
  pkgs = import /home/bfmhno3/Projects/firn/nix/pkgs.nix { };
in
pkgs.cairn.overrideAttrs {
  doInstallCheck = false;
  checkPhase = ''
    runHook preCheck
    for f in cli config prune snapshot verify_diff report completion install lock_signal; do
      bats --formatter tap "tests/$f.bats" > "$f.tap" || true
      echo "RESULT $f ok=$(grep -c '^ok' "$f.tap") not_ok=$(grep -c '^not ok' "$f.tap")"
    done
    runHook postCheck
  '';
}
```

（手敲，不在 `lab/ch11/` 里）

```text
$ nix build --no-link -L --impure --file /tmp/ch11-scratch/all_bats.nix 2>&1 | grep RESULT | sed 's/^cairn> //'
RESULT cli ok=16 not_ok=0
RESULT config ok=14 not_ok=0
RESULT prune ok=14 not_ok=0
RESULT snapshot ok=20 not_ok=0
RESULT verify_diff ok=12 not_ok=0
RESULT report ok=5 not_ok=0
RESULT completion ok=22 not_ok=0
RESULT install ok=1 not_ok=34
RESULT lock_signal ok=12 not_ok=0
```

结果和我的假设不一样：只有 `install.bats` 在沙箱里过不了（35 个里 34 个失败），`completion.bats` 和 `lock_signal.bats` 在这台机器上全过。`install.bats` 把 `install.sh` 放到 dash、busybox sh、yash、mksh 等几种 shell 下各跑一遍，还要 `checkbashisms` 和 `shellcheck`，失败信息里的 status 127 就是命令找不到。我把 `dash`、`yash`、`mksh` 加进 `nativeCheckInputs`、busybox 加进 `PATH` 末尾再跑，34 个失败降到 5 个：busybox 和 yash 的安装测试（还是 127）、一个换 shell 的卸载测试 (128)、`checkbashisms` 与 `shellcheck -s sh` 两个检查（前者的原因是 `checkbashisms: command not found`）。我没有继续追。

两个能过的文件我没有放进 `checkPhase`。`lock_signal.bats` 靠信号和 sleep 的时序，我猜在被别的构建挤满 CPU 的机器上可能抖，这一点我没有测；`completion.bats` 在这台机器上全过，我也没有测过它在高负载下稳不稳。要加的话，把 `tests/completion.bats tests/lock_signal.bats` 接到 `checkPhase` 的 `bats` 命令末尾，测试数会是 81 加 22 加 12，也就是 115。

## Sift：`buildPythonApplication`，pyproject 与 Python 包集

Sift 的 `package.nix` 比 Cairn 短得多，因为 Python 的构建器替你做了大半：

```nix
{
  lib,
  python3Packages,
  fetchFromGitHub,
}:

python3Packages.buildPythonApplication (finalAttrs: {
  pname = "sift";
  version = "0.1.0";
  pyproject = true;

  src = fetchFromGitHub {
    owner = "bfmhno3";
    repo = "sift";
    tag = "ch25";
    hash = "sha256-+PhuZvOxeSTZOCqTc+RvfM17aocOInGeJzZLB+gbWLY=";
  };

  build-system = [ python3Packages.hatchling ];

  dependencies = with python3Packages; [
    sqlalchemy
    typer
    click
    rich
  ];

  pythonImportsCheck = [
    "sift"
    "sift.cli"
  ];

  # ...
```

`python3Packages` 是 `python3.pkgs`，也就是“用 nixpkgs 默认的 Python（这里是 3.14.7）构建出来的全部 Python 包”。所有库都在这个集合里，名字带解释器的版本前缀：闭包里的 `python3.14-click-8.3.3`、`python3.14-rich-15.0.0`。一个应用和它的库必须来自同一个集合，混用不同版本的 Python 会得到一个 import 不到的包；这是 Python 打包里最常见的错，也是为什么 `package.nix` 的参数里只有 `python3Packages`，没有 `sqlalchemy`、`typer` 这些单个的名字。

`buildPythonApplication` 和 `buildPythonPackage` 是同一个函数 `mkPythonDerivation` 的两种用法（[`python-packages-base.nix` 第 111 到 129 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/development/interpreters/python/python-packages-base.nix#L111-L129)）：应用的 `namePrefix` 是空串，`toPythonModule = x: x`，意思是它不当库用，名字里没有 `python3.14-` 前缀，也不会出现在别的包的 `PYTHONPATH` 里。所以闭包里是 `sift-0.1.0` 而不是 `python3.14-sift-0.1.0`。

四个关键字，各自管一段：

- `pyproject = true` 告诉构建器源码里有 `pyproject.toml`，按 PEP 517 构建一个 wheel（[`mk-python-derivation.nix` 第 193 到 196 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/development/interpreters/python/mk-python-derivation.nix#L193-L196)）。它取代了老的 `format = "pyproject"`；两个都不写，会得到 `does not configure a format` 的报错（同一文件第 235 行的 `throw`）。
- `build-system` 是构建 wheel 需要的工具，Sift 的 `pyproject.toml` 写的是 `requires = ["hatchling>=1.31"]`，nixpkgs 里的 hatchling 是 1.31.0，刚好满足。它进 `nativeBuildInputs`，不会出现在运行时闭包里：闭包里没有 hatchling。
- `dependencies` 是运行时的库，对应 `pyproject.toml` 的 `[project] dependencies`。这些元数据在装好的 wheel 里能读出来（手敲，不在 `lab/ch11/` 里）：

```text
$ grep -E '^Requires-Dist' $(nix build --no-link --print-out-paths .#sift)/lib/python3.14/site-packages/sift-0.1.0.dist-info/METADATA
Requires-Dist: click>=8.2.1
Requires-Dist: rich>=15
Requires-Dist: sqlalchemy>=2.0.51
Requires-Dist: typer>=0.25
Requires-Dist: matplotlib>=3.11; extra == 'data'
Requires-Dist: numpy>=2.5; extra == 'data'
Requires-Dist: pandas>=3.0; extra == 'data'
Requires-Dist: darkdetect>=0.8; extra == 'gui'
Requires-Dist: pyside6>=6.11; extra == 'gui'
Requires-Dist: qtawesome>=1.4; extra == 'gui'
Requires-Dist: sv-ttk>=2.6; extra == 'gui'
Requires-Dist: fastapi>=0.139; extra == 'web'
Requires-Dist: httpx>=0.28; extra == 'web'
Requires-Dist: pydantic>=2.13; extra == 'web'
Requires-Dist: uvicorn>=0.51; extra == 'web'
```

四个依赖是无条件的，带 `extra ==` 的 11 行是三组可选依赖（`web`、`gui`、`data`）。`package.nix` 只写了前者，所以闭包里没有 `pyside6`、`pandas`；想要 `gui`，在 `optional-dependencies` 里声明，这一篇不需要。第四个关键字 `pythonImportsCheck` 是一个 `import` 冒烟测试：构建的最后，用打好的包去 `import sift` 和 `import sift.cli`。

nixpkgs 对 Python 包的构建全靠 setup hook 串起来。我从 `nix log` 里取出阶段标题（手敲，不在 `lab/ch11/` 里）：

```text
$ nix log .#sift | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^(Running phase|Executing|Checking runtime|Check whether|Successfully built)' | sed 's|/nix/store/[a-z0-9]*-||g'
Running phase: unpackPhase
Running phase: patchPhase
Running phase: updateAutotoolsGnuConfigScriptsPhase
Running phase: configurePhase
Running phase: buildPhase
Executing pypaBuildPhase
Successfully built sift-0.1.0-py3-none-any.whl
Running phase: pythonRuntimeDepsCheckHook
Executing pythonRuntimeDepsCheck
Checking runtime dependencies for sift-0.1.0-py3-none-any.whl
Running phase: installPhase
Executing pypaInstallPhase
Running phase: pythonOutputDistPhase
Executing pythonOutputDistPhase
Running phase: fixupPhase
Executing pythonRemoveTestsDir
Running phase: installCheckPhase
Running phase: pythonCatchConflictsPhase
Running phase: pythonRemoveBinBytecodePhase
Running phase: pythonImportsCheckPhase
Executing pythonImportsCheckPhase
Check whether the following modules can be imported: sift sift.cli
```

`py3-none-any.whl` 说明它是纯 Python 的 wheel（没有 C 扩展）。`pythonRuntimeDepsCheckHook`（[`mk-python-derivation.nix` 第 295 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/development/interpreters/python/mk-python-derivation.nix#L295) 选出的 hook）拿 wheel 的元数据去核对：每个必需的依赖，装进来了吗？我把 `sqlalchemy` 从 `dependencies` 里拿掉（手敲，不在 `lab/ch11/` 里）：

```text
$ nix build --no-link -L --impure --expr 'let p = import ./nix/pkgs.nix { }; in p.sift.overridePythonAttrs { dependencies = with p.python3Packages; [ typer click rich ]; }' 2>&1 | tail -n 8 | sed 's|/nix/store/[a-z0-9]*-||g'
       > Finished creating a wheel...
       > Finished executing pypaBuildPhase
       > Running phase: pythonRuntimeDepsCheckHook
       > Executing pythonRuntimeDepsCheck
       > Checking runtime dependencies for sift-0.1.0-py3-none-any.whl
       >   - sqlalchemy not installed
       For full logs, run:
         nix log sift-0.1.0.drv
```

构建在安装之前就失败了，一行 `sqlalchemy not installed`。再试把 `rich` 拿掉：

（手敲，不在 `lab/ch11/` 里）

```text
$ nix build --no-link --impure --expr 'let p = import ./nix/pkgs.nix { }; in p.sift.overridePythonAttrs { dependencies = with p.python3Packages; [ sqlalchemy typer click ]; }'; echo "rc=$?"
rc=0
```

照样成功。`rich` 没有被检查出缺失，因为 `typer` 自己依赖 `rich`，`python3Packages.typer` 把它传递进来了（闭包里的 `python3.14-rich-15.0.0` 本来就来自 `typer` 的依赖链）。所以 `pythonRuntimeDepsCheck` 检查的是“元数据里的要求都满足”，不检查“你写的 `dependencies` 列表是最小的或者完整的”。写不全，只要碰巧被传递依赖补上，就不会报错；这是一个我不会再依赖的巧合。

### wrapPythonPrograms：Python 的 `wrapProgram`

`fixupPhase` 里还有一件事：`postFixup` 里 `wrapPythonPrograms`（[`mk-python-derivation.nix` 第 404 到 410 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/development/interpreters/python/mk-python-derivation.nix#L404-L410)），它对 `$out/bin` 里每个 Python 脚本调用 `wrapProgram`（[`wrap.sh`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/development/interpreters/python/wrap.sh) 里的注释写明：“The script will set PYTHONPATH and PATH variables”）。结果和 Cairn 一样，是一个包装器加一个被隐藏的原脚本：

（手敲，不在 `lab/ch11/` 里）

```text
$ ls -a $(nix build --no-link --print-out-paths .#sift)/bin
.  ..  sift  .sift-wrapped
$ head -n 1 $(nix build --no-link --print-out-paths .#sift)/bin/sift | sed 's|/nix/store/[a-z0-9]*-||g'
#! bash-5.3p15/bin/bash -e
$ tail -n 2 $(nix build --no-link --print-out-paths .#sift)/bin/sift | sed 's|/nix/store/[a-z0-9]*-||g'
export PYTHONNOUSERSITE='true'
exec -a "$0" "sift-0.1.0/bin/.sift-wrapped"  "$@" 
```

`.sift-wrapped` 只有 9 行：第一行是 `#!python3-3.14.7/bin/python3.14`，第三行是一个 `site.addsitedir`，把 `sift`、`sqlalchemy`、`greenlet` 等每个依赖的 `site-packages` 一个一个加进 `sys.path`。（`PYTHONNOUSERSITE` 是 [`wrap.sh` 第 79 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/development/interpreters/python/wrap.sh#L79) 设的：除非你写 `permitUserSite`，否则 `~/.local` 里的包不会漏进来。）这样 `sift` 不靠宿主机的 `PYTHONPATH`，也不需要 `nix-shell -p python3Packages.sqlalchemy` 这类环境。

`lab/ch11/sift_runs.sh` 跑一遍打好的包：

```bash
out="$(nix build --no-link --print-out-paths "${FIRN_ROOT}#sift")"

echo "== sift --help (first lines)"
"${out}/bin/sift" --help | head -n 8

echo
echo "== python in the closure"
nix path-info -r "${out}" | sed 's|^/nix/store/[a-z0-9]*-||' | grep -E '^python3-3\.14' || {
  echo "no python3 3.14 in closure" >&2
  exit 1
}
```

输出：

```text
$ cat out/ch11/sift_runs.stdout
== sift --help (first lines)
Usage: sift [OPTIONS] COMMAND [ARGS]...

  Search the Markdown posts of a blog.

Options:
  --version             Show the version and exit.
  --debug               Log at DEBUG level and print tracebacks with rich.
  --install-completion  Install completion for the current shell.

== python in the closure
python3-3.14.7
```

### 268.2 MiB 里有什么

这是我这一篇最想知道的数字。我把闭包里每个路径的 NAR 大小排了个序（手敲，不在 `lab/ch11/` 里；`--json-format 1` 让 Nix 2.34 输出旧的 JSON 形状，`narSize` 在顶层）：

```text
$ nix path-info -r --json --json-format 1 $(nix build --no-link --print-out-paths .#sift) | jq -r 'to_entries|sort_by(-.value.narSize)|.[:8][]|"\(.value.narSize) \(.key)"' | sed 's|/nix/store/[a-z0-9]*-||'
142028848 python3-3.14.7
35073096 glibc-2.42-67
29175232 python3.14-sqlalchemy-2.0.51
13450712 python3.14-pygments-2.20.0
10317392 gcc-15.3.0-lib
9308816 openssl-3.6.3
6027056 sqlite-3.53.3
4778984 python3.14-rich-15.0.0
```

整个闭包是 281,247,760 字节。解释器 `python3-3.14.7` 一个路径就是 142,028,848 字节，占 50.5%。`python3.14-*` 的所有库加起来是 52,708,328 字节 (18.7%)，glibc 是 35,073,096 字节 (12.5%)。再往里看，`python3` 里最大的一块是 `lib/python3.14/config-3.14-x86_64-linux-gnu/libpython3.14.a`，66,480,986 字节，也就是 63.4 MiB 的静态库，占这个路径的将近一半 (46.8%)。我没有试过换成不带静态库的 Python，所以不知道有没有这样的变体能直接用；我只知道 `python3Minimal` 的闭包是 74.4 MiB（手敲 `nix path-info -Sh` 的结果），但它缺的东西我没有逐个核对，不能直接拿来替换。

Python 闭包大的原因有三个，每个都能从这些数字里指出来：

1. **解释器本身就是一个小系统。** `python3` 引用 18 个别的路径（`openssl`、`sqlite`、`ncurses`、`readline`、`bzip2`、`xz`、`zlib`、`libffi`、`expat`、`gdbm`、`tzdata`……），不管 Sift 用不用到 `bz2` 模块，它们都在闭包里。
2. **每个库是一个完整的 store 路径。** `sqlalchemy` 单独 27.8 MiB，我猜 Sift 只用到它的一小部分；Nix 不会替你摇树。`pythonRemoveTestsDir` 会删掉各包里的 `tests` 目录（日志里有这个阶段），但删的只是测试。
3. **没有编译期丢弃。** Rust 在编译期把用到的代码编进一个二进制，`pebble-0.1.0` 这个路径只有 1,883,640 字节 (1.8 MiB)；Python 在运行时按名字 `import`，所以每个依赖的文件都得整个在场。

### installCheckPhase 那一行为什么曾经没有运行

我第一版 `package.nix` 里有一行 `doCheck = false;`，旁边有一条注释说测试套件需要 dev 额外依赖和语料库，所以不跑。同一个文件里还有一个我以为在运行的 `installCheckPhase`，断言 `sift --help` 里有 `Usage`。我是在写这一节时，想知道“`installCheckPhase` 挂了会怎样”，才发现它根本没有运行。我把 `installCheckPhase` 换成一条必定失败的命令，同时保留 `doCheck = false`（手敲，不在 `lab/ch11/` 里）：

```text
$ nix build --no-link -L --impure --expr '(import ./nix/pkgs.nix { }).sift.overridePythonAttrs { doCheck = false; installCheckPhase = "echo INSTALLCHECK-RAN; false"; }' 2>&1 | grep -E 'INSTALLCHECK|Running phase: installCheck|error' | sed 's/^sift> //'; echo "rc=${PIPESTATUS[0]}"
rc=0
```

构建成功，没有任何输出，`INSTALLCHECK-RAN` 没有出现。去掉 `doCheck = false`：

（手敲，不在 `lab/ch11/` 里）

```text
$ nix build --no-link -L --impure --expr '(import ./nix/pkgs.nix { }).sift.overridePythonAttrs { installCheckPhase = "echo INSTALLCHECK-RAN; false"; }' 2>&1 | grep -E 'INSTALLCHECK|Running phase: installCheck|error' | sed 's/^sift> //'; echo "rc=${PIPESTATUS[0]}"
Running phase: installCheckPhase
INSTALLCHECK-RAN
error: Cannot build '/nix/store/dgidwb5hand1b42xhaglf5b78nj4js86-sift-0.1.0.drv'.
       > Running phase: installCheckPhase
       > INSTALLCHECK-RAN
rc=1
```

原因在 `mkPythonDerivation` 里（[`mk-python-derivation.nix` 第 398 到 400 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/development/interpreters/python/mk-python-derivation.nix#L398-L400)）：

```nix
      # Python packages don't have a checkPhase, only an installCheckPhase
      doCheck = false;
      doInstallCheck = attrs.doCheck or true;
```

Python 的构建器把你传的 `doCheck` 搬到 `doInstallCheck` 上，自己的 `doCheck` 永远是 `false`。所以我写 `doInstallCheck = true;` 没用：它被 `attrs.doCheck or true` 覆盖了，`doCheck = false` 就等于关掉了 `installCheckPhase`。我用 `drvAttrs.doInstallCheck` 确认（手敲，不在 `lab/ch11/` 里）：

```text
$ nix eval --impure --raw --expr 'let p = import ./nix/pkgs.nix { }; in builtins.toJSON (p.sift.overridePythonAttrs { doCheck = false; }).drvAttrs.doInstallCheck'
false
$ nix eval --impure --raw --expr 'let p = import ./nix/pkgs.nix { }; in builtins.toJSON p.sift.drvAttrs.doInstallCheck'
true
```

现在 `package.nix` 里没有 `doCheck = false;` 了，只留一条注释解释为什么不写，`installCheckPhase` 在 `fixupPhase` 之后真的会运行：

```nix
  # 测试套件需要 dev 额外依赖和语料库，所以没有 pytestCheckHook。
  # 不要写 doCheck = false：mk-python-derivation 用 doInstallCheck = attrs.doCheck or true，
  # 关掉 doCheck 会连带关掉下面的 installCheckPhase。

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    "$out/bin/sift" --help | grep -q Usage
    "$out/bin/sift" --version | grep -qF '${finalAttrs.version}'
    runHook postInstallCheck
  '';
```

这个节选里的 `doInstallCheck = true;` 是个空操作：`mk-python-derivation.nix` 的 `excludeDrvArgNames` 把 `doInstallCheck` 排除在外（第 108 到 118 行），它只是写明意图；真正让 `installCheckPhase` 运行的是没有 `doCheck = false;`。

这一课比 Sift 本身大：**在 nixpkgs 里，“有一个检查”和“这个检查在运行”是两件事，唯一的确认办法是看日志里有没有这个阶段的标题，或者把检查改成必定失败的命令看构建会不会挂。** 我不会再相信自己写过一个 `installCheckPhase`。

## Pebble：`buildRustPackage`，和一个不在 `package.nix` 里的网络访问

Pebble 是三个里最短的 `package.nix`，因为 `buildRustPackage` 把 cargo 的一整套都包好了：

```nix
{
  lib,
  rustPlatform,
  fetchFromGitHub,
}:

rustPlatform.buildRustPackage (finalAttrs: {
  pname = "pebble";
  version = "0.1.0";

  src = fetchFromGitHub {
    owner = "bfmhno3";
    repo = "pebble";
    tag = "tutorial-v1";
    hash = "sha256-m6RjSuHICOLMobZcDn/oMMBwmZvrnAegpUU9rAc/MkY=";
  };

  # 供应商目录（vendored crates）是一个固定输出推导，cargoHash 是它的哈希。
  cargoHash = "sha256-N6epgex2dseqHh+eiezB7KS7ude18+L2KgpwMTVAaj4=";

  cargoBuildFlags = [
    "--package"
    "pebble-cli"
  ];
  cargoTestFlags = [
    "--package"
    "pebble-cli"
  ];

  # ...
```

`version` 是 Pebble 的 `Cargo.toml` 里 `[workspace.package]` 的 `version = "0.1.0"`（我 `cat` 了打好的源码确认的）。`src` 的 `tag = "tutorial-v1"` 是 Pebble 仓库里一个固定的标签；`hash` 和上一篇一样来自 `fetchFromGitHub` 的 `fakeHash` 流程，或者来自 `nurl`（这一篇的最后一个实验）。真正新的只有两行：`cargoHash` 和 `cargoBuildFlags`。

### cargoHash：为什么 Rust 要多一个哈希

Nix 的沙箱里没有网络，而 `cargo build` 第一件事是去 crates.io 下载依赖。`buildRustPackage` 的办法是先在一个**固定输出 derivation** 里把所有依赖下载下来，哈希锁死，再让真正的构建从这个目录里离线读取。这个“下载依赖”的 derivation 就是 `cargoDeps`，`cargoHash` 是它的哈希（[`build-rust-package/default.nix` 第 104 到 132 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/rust/build-rust-package/default.nix#L104-L132) 里，`args.cargoHash` 被传给 `fetchCargoVendor` 当 `hash`）。

说“固定输出”其实还差一点：它是两步。[`fetch-cargo-vendor.nix`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/rust/fetch-cargo-vendor.nix) 里，`vendorStaging` 是固定输出（第 105 行 `outputHash = hash;`，第 107 行 `outputHashMode = "recursive";`），它读 `Cargo.lock` 下载每个 crate；第 112 行 `runCommand "${name}-vendor"` 才是 `cargoDeps`，一个普通 derivation，把 staging 整理成 cargo 要的 `vendor` 目录布局。我手敲验证：

```text
$ nix derivation show $(nix-store -q --references $(nix eval --raw .#pebble.cargoDeps.drvPath) | grep staging) | jq -c '(.derivations // .) | to_entries[0].value | .outputs.out'
{"hash":"sha256-N6epgex2dseqHh+eiezB7KS7ude18+L2KgpwMTVAaj4=","method":"nar"}
```

这个 `hash` 和 `package.nix` 里的 `cargoHash` 逐字一样。整理后的 `cargoDeps` (`-vendor`)`du -sh` 是 233M (MiB)，127 个 crate；它只是构建时用，`pebble` 的闭包里没有它（闭包只有 7 个路径，列在 `nix path-info -r` 的输出里）。`Cargo.lock` 变了，`cargoHash` 就要重新算。

怎么拿到这个哈希？和 `fetchFromGitHub` 一样，写成 `lib.fakeHash` 让它失败。`lab/ch11/cargo_hash.sh` 把这个过程自动化：复制 `package.nix`，用 `sed` 把 `cargoHash` 换成 `lib.fakeHash`，构建，从错误信息里捞 `got:`，再和仓库里提交的值比较：

```bash
sed -E 's|cargoHash = "[^"]*";|cargoHash = lib.fakeHash;|' "${pkg}" >"${tmp}"
grep -n 'cargoHash' "${tmp}"

log="${LAB_TMP}/build.log"
if nix build --no-link --impure --expr "
  let
    pkgs = import ${FIRN_ROOT}/nix/pkgs.nix { };
  in
  pkgs.callPackage ${tmp} { }
" 2>"${log}"; then
  echo "build with fakeHash succeeded, that must not happen" >&2
  exit 1
fi
grep -E 'specified:|got:' "${log}"
```

输出：

```text
$ cat out/ch11/cargo_hash.stdout
18:  # 供应商目录（vendored crates）是一个固定输出推导，cargoHash 是它的哈希。
19:  cargoHash = lib.fakeHash;
         specified: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
            got:    sha256-N6epgex2dseqHh+eiezB7KS7ude18+L2KgpwMTVAaj4=
committed: sha256-N6epgex2dseqHh+eiezB7KS7ude18+L2KgpwMTVAaj4=
```

最后一行 `committed:` 和 `got:` 相等，脚本以 0 退出；不相等它以 1 退出。

### cargoBuildFlags：只编译 `pebble-cli`

Pebble 是一个 16 个 crate 的 workspace，`crates/` 下有 `pebble-lexer`、`pebble-parser`、`pebble-vm`，也有 `pebble-bench`、`pebble-net`、`pebble-nostd`、`pebble-sys`。`cargoBuildFlags = [ "--package" "pebble-cli" ]` 让 cargo 只构建 `pebble-cli` 和它依赖的 crate。我把这两个 flag 去掉再构建（`doCheck = false`，只量构建），数日志里的 `Compiling` 行（手敲，不在 `lab/ch11/` 里）：

```text
$ nix log .#pebble | sed 's/\x1b\[[0-9;]*m//g' | awk '/Running phase: checkPhase/{exit} /Compiling/{n++} END{print n " compiled before checkPhase"}'
48 compiled before checkPhase
$ nix log .#pebble | sed 's/\x1b\[[0-9;]*m//g' | grep -o 'Compiling pebble-[a-z]*' | sort -u | wc -l
12
$ nix log --impure --expr '(import ./nix/pkgs.nix { }).pebble.overrideAttrs { cargoBuildFlags = [ ]; cargoTestFlags = [ ]; doCheck = false; }' | sed 's/\x1b\[[0-9;]*m//g' | awk '/Running phase: checkPhase/{exit} /Compiling/{n++} END{print n " compiled before checkPhase"}'
63 compiled before checkPhase
$ nix log --impure --expr '(import ./nix/pkgs.nix { }).pebble.overrideAttrs { cargoBuildFlags = [ ]; cargoTestFlags = [ ]; doCheck = false; }' | sed 's/\x1b\[[0-9;]*m//g' | grep -o 'Compiling pebble-[a-z]*' | sort -u | wc -l
16
```

带 flag 是 48 个编译单元（12 个是 Pebble 自己的 crate，其余 36 个是依赖），不带 flag 是 63 个（16 个自己的）：多出来的 15 个是 `pebble-bench`、`pebble-net`、`pebble-nostd`、`pebble-sys` 这 4 个 crate，加上 `tokio`、`mio`、`socket2`、`bytes`、`cc` 等 11 个外部依赖（我用两份日志里的 `Compiling` 行做了集合差）。产物一样（两个变体的 `bin/` 里都只有一个 `pebble`，闭包都是 47.8 MiB），所以这两个 flag 在 Pebble 上只是省编译时间：构建阶段我量到 22.6 秒对 26.1 秒，两次测量不在同一时刻，我不敢把它当结论。对一个 workspace 里有多个二进制的项目，它们决定的是你要哪一个。

### checkPhase：Rust 默认就跑测试

`buildRustPackage` 的 `doCheck` 默认是 `true`（[第 174 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/rust/build-rust-package/default.nix#L174) `doCheck = args.doCheck or true;`），所以 `package.nix` 里没有 `doCheck`，测试也在跑：

（手敲，不在 `lab/ch11/` 里）

```text
$ nix log .#pebble | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'Running phase: (buildPhase|checkPhase|installPhase)|Finished .release|Running (unittests|tests)|^running [0-9]+ tests|^test result'
Running phase: buildPhase
    Finished `release` profile [optimized] target(s) in 22.62s
Running phase: checkPhase
    Finished `release` profile [optimized] target(s) in 20.85s
     Running unittests src/main.rs (target/x86_64-unknown-linux-gnu/release/deps/pebble-0e780be4fb25adc6)
running 3 tests
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running tests/cli.rs (target/x86_64-unknown-linux-gnu/release/deps/cli-93b0bd44cbdeb920)
running 12 tests
test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
Running phase: installPhase
```

两个 `Finished release` 是同一个原因：`checkType` 默认等于 `buildType`，也就是 `release`（[第 57 行和第 63 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/rust/build-rust-package/default.nix#L55-L63)），测试在 release 配置下编译，`pebble-cli` 要再编译一次带测试 harness 的版本。这就是为什么 `checkPhase` 花了 20.85 秒，比 3 加 12 个测试本身（0.00 秒和 0.02 秒）长了三个数量级。`cargoTestFlags` 的 `--package pebble-cli` 保证只跑这个 crate 的 15 个测试：单元测试 3 个，集成测试 12 个。

### 冷构建、重建，和“没有缓存可用”

Pebble 不在 cache.nixos.org 里（手敲，`nix path-info --store https://cache.nixos.org` 对它的输出路径报 `is not valid`，Cairn 同样），所以没有“从缓存取”的数字可比，只有冷构建。我把 `pebble`、它的源码、`cargoDeps`、`vendorStaging` 和依赖它的两个 `firn-tools` 输出从 store 里删掉，再构建（手敲，不在 `lab/ch11/` 里）：

```text
$ P=$(nix build --no-link --print-out-paths .#pebble)
$ S=$(nix build --no-link --print-out-paths .#pebble.src)
$ V=$(nix build --no-link --print-out-paths .#pebble.cargoDeps)
$ ST=$(nix-store -q --references $(nix eval --raw .#pebble.cargoDeps.drvPath) | grep staging)
$ nix store delete $(nix-store --query --referrers $P) $P $S $V $(nix-store -q --outputs $ST)
note: hard linking is currently saving 61.8 GiB
6 store paths deleted, 226.2 MiB freed
$ time nix build --no-link .#pebble
  /nix/store/0i8m2n8av8920nv92fkp8h438mf0q0wf-pebble-0.1.0-vendor.drv
  /nix/store/5vby4hi5gv3ycxbdfx1r5w77p4v1lxmh-pebble-0.1.0.drv
building '/nix/store/jdbz547z4yza0kgh3vfdx8j69c8mkc8v-source.drv'...
building '/nix/store/hhp0hmk6gvjfcbks6ni1xlrrr2a2c3dn-pebble-0.1.0-vendor-staging.drv'...
building '/nix/store/0i8m2n8av8920nv92fkp8h438mf0q0wf-pebble-0.1.0-vendor.drv'...
building '/nix/store/5vby4hi5gv3ycxbdfx1r5w77p4v1lxmh-pebble-0.1.0.drv'...

real	4m13.400s
```

冷构建 4 分 13.4 秒，四个 derivation 依次是：下载源码（`source`，固定输出）、下载 127 个 crate（`vendor-staging`，固定输出）、整理成 vendor 目录 (`vendor`)、编译加测试 (`pebble-0.1.0`)。全部在 store 里时，`nix build --rebuild`（只重新跑构建，并检查结果和已有输出逐位相同）我跑了 6 次：44.7、45.0、45.0、45.7、45.8、48.9 秒，中位数 45.4 秒。差的 208 秒左右，主要发生在 `vendor-staging` 这一步（下载 127 个 crate 加整理），我没有把网络和 CPU 分开量。还有一次中间状态：第一次我漏删了 `vendor-staging`，那次冷构建是 57.3 秒。实际删掉的 6 个路径是 2 个 `firn-tools` 输出、`pebble`、源码、`-vendor` 和 `vendor-staging`。

### 跑一次

`lab/ch11/pebble_runs.sh` 跑一个 Pebble 自带的例子：

```bash
out="$(nix build --no-link --print-out-paths "${FIRN_ROOT}#pebble")"
src="$(nix build --no-link --print-out-paths "${FIRN_ROOT}#pebble.src")"

result="$("${out}/bin/pebble" run "${src}/examples/fib.pebble")"
echo "pebble run examples/fib.pebble -> ${result}"
[[ "${result}" == 6765 ]] || exit 1
```

```text
$ cat out/ch11/pebble_runs.stdout
pebble run examples/fib.pebble -> 6765
```

`pebble.src` 是打好的包的源码属性，不用再 `fetchFromGitHub` 一遍。输出 `6765` 是 fib(20)，和 Rust 系列第 1 篇里 `cargo run -q -p pebble-cli -- run examples/fib.pebble` 打印的一样（那一篇在[用 Pebble 从零学 Rust 第 1 篇](/posts/rust-by-pebble-01-first-crate/)）。

## buildGoModule、buildNpmPackage、buildDotnetModule：同一个思路的三个版本

我只打了 Rust、Python 和 Bash 三种，但“把依赖锁进一个有哈希的东西”是 nixpkgs 里所有语言构建器的共同形状。我从源码里把另外三个的入口各查了一遍：

| 语言 | 构建器 | 依赖的锁 | 在哪里声明 | nixpkgs 里一个例子 |
| --- | --- | --- | --- | --- |
| Go | `buildGoModule`（指向 `buildGo126Module`） | `vendorHash`（也可以是 `null`，意思是源码已带 `vendor/`） | [`go/module.nix` 第 29 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/go/module.nix#L29) | [`gh`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/gh/gh/package.nix#L24)（`vendorHash` 第 24 行）、[`lazygit`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/la/lazygit/package.nix#L20)（`vendorHash = null`，第 20 行） |
| Node.js | `buildNpmPackage` | `npmDepsHash`，交给 `fetchNpmDeps` 当 `hash`；可以用 `prefetch-npm-deps` 事先算 | [`build-npm-package/default.nix` 第 28 行和第 71 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/node/build-npm-package/default.nix#L28) | [`aasvg`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/aa/aasvg/package.nix#L25)（第 25 行） |
| .NET | `buildDotnetModule` | `nugetDeps = ./deps.json`：一个 JSON 文件，每个 NuGet 包一条 `pname`、`version`、`hash`；由 `passthru.fetch-deps` 脚本生成，没有一个整体哈希 | [`build-dotnet-module/default.nix` 第 46 到 48 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/dotnet/build-dotnet-module/default.nix#L46-L48) | [`alttpr-opentracker`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/by-name/al/alttpr-opentracker/package.nix#L34)（第 34 行，同目录有 `deps.json`） |

前两个和 `cargoHash` 是一个套路：写成 `lib.fakeHash`，让构建失败，抄走 `got:`。第三个不一样：NuGet 的锁是一个文件而不是一个哈希，你要运行 `passthru.fetch-deps` 去生成或刷新它。我没有拿这三个构建器打过自己的项目，这张表是我读源码得到的，不是我跑出来的，具体行为请以各自的文档为准。

## 闭包里到底有什么：运行时依赖和构建时依赖

回到这一篇开头的表。`lab/ch11/closures.sh` 对四个包各算一次闭包大小和路径数：

```bash
printf '%-12s %12s %6s\n' package closure paths
for name in firn-hello cairn sift pebble; do
  out="$(nix build --no-link --print-out-paths "${FIRN_ROOT}#${name}")"
  size="$(nix path-info -Sh "${out}" | awk '{ print $2 $3 }')"
  count="$(nix path-info -r "${out}" | wc -l)"
  printf '%-12s %12s %6d\n' "${name}" "${size}" "${count}"
done
```

```text
$ cat out/ch11/closures.stdout
package           closure  paths
firn-hello        36.1MiB      6
cairn            129.7MiB     46
sift             268.2MiB     39
pebble            47.8MiB      7
```

`nix path-info -S` 的 `-S` 是闭包的 NAR 总大小（`-h` 换成 MiB），`-r` 列出闭包里的全部路径。关键是闭包里**有什么**。Nix 不是读 `buildInputs` 决定运行时依赖，而是在构建完成后**扫描输出文件**，找里面有没有出现某个 store 路径的哈希部分，出现了就算一条引用。引用的传递闭包就是闭包。我用 Cairn 看这件事：

（手敲，不在 `lab/ch11/` 里）

```text
$ nix-store -q --references $(nix build --no-link --print-out-paths .#cairn) | sed 's|/nix/store/[a-z0-9]*-||'
util-linux-2.42.2-bin
gnugrep-3.12
bash-5.3p15
rsync-3.4.4
bash-interactive-5.3p15
coreutils-9.11
findutils-4.11.0
gawk-5.4.1
gnused-4.10
cairn-0.1.0
```

十条引用：自己一条，两个 bash，七个命令所在的包。它们没有一个在 `buildInputs` 里（`buildInputs` 只有 `bash`），七个命令的路径出现在输出里，是因为 `postFixup` 里的 `${lib.makeBinPath [ ... ]}` 把它们写进了包装器。`nix why-depends --precise` 能指出是哪个文件的哪一段：

（手敲，不在 `lab/ch11/` 里）

```text
$ nix why-depends --precise .#cairn $(nix-store -q --references $(nix build --no-link --print-out-paths .#cairn) | grep gnused) | sed 's/\x1b\[[0-9;]*m//g'
/nix/store/08miknl7zqxj4xrcvp27jjcpf9grfaj8-cairn-0.1.0
└───bin/cairn: …':'}.PATH=${PATH/':''/nix/store/rxd8p6g4k4s0sx4q1szmzvp9rsmhmfys-gnused-4.10/bin'':'/':'}.PATH='…
    → /nix/store/rxd8p6g4k4s0sx4q1szmzvp9rsmhmfys-gnused-4.10
```

（输出里的 `…` 是 `why-depends` 自己截掉的上下文，中间那一段就是被扫描到的字符串：包装器里一行 `PATH=${PATH/...}` 把 `gnused` 的路径写进了脚本。）反过来，`makeWrapper` 在 `nativeBuildInputs` 里，`bats` 在 `nativeCheckInputs` 里，两者的路径都没有写进输出，所以都不在闭包里：

（手敲，不在 `lab/ch11/` 里）

```text
$ nix path-info -r $(nix build --no-link --print-out-paths .#cairn) | grep -c bats
0
$ nix path-info -r $(nix build --no-link --print-out-paths .#cairn) | grep -c make-shell-wrapper
0
```

于是有了一张可以背下来的表：

| 属性 | 什么时候在构建环境里 | 进不进闭包 |
| --- | --- | --- |
| `nativeBuildInputs` | 总是（构建平台上跑的工具） | 不进，除非输出里写进了它的路径 |
| `buildInputs` | 总是（库、解释器） | 输出里出现它的路径才进 |
| `nativeCheckInputs` | 只有 `doCheck` 为真 | 同上，通常不进 |
| `nativeInstallCheckInputs` | 只有 `doInstallCheck` 为真 | 同上，通常不进 |
| 字符串里插值的 `${pkg}` | 在 derivation 的输入里 | 写进输出文件才进（`wrapProgram`、shebang、`rpath` 都是这样写进去的） |

最后一行是最重要的：**运行时依赖不是“声明”出来的，是“引用”出来的。** `buildInputs = [ bash ]` 让 `bash-interactive` 进了 Cairn 的闭包，是因为 `patchShebangs` 把它的路径写进了 `.cairn-wrapped` 的第一行。同样地，Pebble 的 233 MB vendor 目录是构建输入，它的路径没有写进二进制，所以 `pebble` 的闭包里没有它。`pebble` 的闭包是这 7 个：

（手敲，不在 `lab/ch11/` 里）

```text
$ nix path-info -r $(nix build --no-link --print-out-paths .#pebble) | sed 's|/nix/store/[a-z0-9]*-||'
libunistring-1.4.2
libidn2-2.3.8
xgcc-15.3.0-libgcc
glibc-2.42-67
gcc-15.3.0-libgcc
gcc-15.3.0-lib
pebble-0.1.0
```

六个都是 glibc 和 `libgcc_s` 这一圈，Pebble 自己的二进制是 1.8 MiB。Cairn 的 129.7 MiB 来自哪？我把每条引用的闭包大小量了一遍（手敲，不在 `lab/ch11/` 里）：

```text
$ for r in $(nix-store -q --references $C | grep -v cairn-0.1.0); do echo "$(nix path-info -S $r | awk '{print $2}') $(echo $r | sed 's|/nix/store/[a-z0-9]*-||')"; done | sort -n | awk '{printf "%-24s %8.1f MiB\n", $2, $1/1048576}'
gnused-4.10                  36.7 MiB
bash-5.3p15                  37.7 MiB
gnugrep-3.12                 38.9 MiB
gawk-5.4.1                   39.4 MiB
bash-interactive-5.3p15      47.2 MiB
coreutils-9.11               48.7 MiB
findutils-4.11.0             50.6 MiB
rsync-3.4.4                  59.6 MiB
util-linux-2.42.2-bin        99.8 MiB
```

这些是各自的闭包，互相重叠（都含 glibc），所以不能相加。看最大的一项：`util-linux` 的闭包 99.8 MiB，占 Cairn 总闭包 129.7 MiB 的 77%。`nix why-depends` 告诉我 `shadow` 是被 `util-linux-bin` 拉进来的，`openssl` 是被 `rsync` 拉进来的：

（手敲，不在 `lab/ch11/` 里）

```text
$ nix why-depends .#cairn $(nix-store -q -R $(nix build --no-link --print-out-paths .#cairn) | grep 'shadow-') 2>&1 | sed 's|/nix/store/[a-z0-9]*-||g'
cairn-0.1.0
└───util-linux-2.42.2-bin
    └───shadow-4.20.0
$ nix why-depends .#cairn $(nix-store -q -R $(nix build --no-link --print-out-paths .#cairn) | grep openssl) 2>&1 | sed 's|/nix/store/[a-z0-9]*-||g'
cairn-0.1.0
└───rsync-3.4.4
    └───openssl-3.6.3
```

Cairn 用 `util-linux` 的哪个命令？我对 `bin/` 和 `lib/` 里几个常见的 util-linux 命令名做了 grep，只找到 `flock`（一处）。没找全的话，就是我没 grep 到；但这至少说明，为一个 `flock` 带进 99.8 MiB 的闭包，值得想一想。怎么缩小，留给练习。

一个对称的数据：Python 的闭包大，是因为 `python3` 本身 135.4 MiB；Rust 的小，是因为 Rust 编译出来的二进制带着自己用到的代码，运行时只引用 glibc；Bash 的大，是因为它的运行时是别的程序（七个命令加两个 bash），而每个命令各自带着一棵依赖树。

## 小构建器：不打包源码的包

`firn-tools` 和 `cairn-report` 都不是“项目”，它们是用 nixpkgs 的小构建器拼出来的。`lab/ch11/trivial_builders.nix` 把五个最常用的各做一个：`writeText`、`writeTextFile`、`runCommand`、`symlinkJoin`、`linkFarm`。它们都定义在 [`trivial-builders/default.nix`](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/trivial-builders/default.nix)：`runCommand` 在第 29 行，`writeTextFile` 在第 102 行，`writeText` 在第 191 行，`symlinkJoin` 在第 531 行，`linkFarm` 在第 634 行。

```nix
# Out paths and contents of the trivial builders: writeText, writeTextFile,
# runCommand, symlinkJoin and linkFarm. Contents are read back with
# builtins.readFile, so the files are built during evaluation (IFD).
let
  pkgs = import ../../nix/pkgs.nix { };
  text = pkgs.writeText "greeting.txt" "hello\n";
  file = pkgs.writeTextFile {
    name = "tool";
    text = "#!/bin/sh\necho tool\n";
    destination = "/bin/tool";
    executable = true;
  };
  run = pkgs.runCommand "upper" { } ''
    echo hello | tr a-z A-Z > $out
  '';
  docs = pkgs.writeTextDir "share/doc/readme.txt" "docs\n";
  join = pkgs.symlinkJoin {
    name = "joined";
    paths = [
      file
      docs
    ];
  };
  # ...
```

实验里用 `builtins.readFile` 把构建出的文件读回来，所以求值时就会构建它们（第 4 篇讲过的 IFD，这里是故意的）。输出一共 578 个字符，是一行，我用 `nixfmt -` 排一下版（手敲，不在 `lab/ch11/` 里）：

```text
$ nix eval --impure --file lab/ch11/trivial_builders.nix | nixfmt -
{
  linkFarm = {
    entries = [
      "a.txt"
      "bin"
    ];
    outPath = "/nix/store/sbvgvdyihxicax0g94qs5zbfzflpd9fd-farm";
  };
  runCommand = {
    content = "HELLO\n";
    outPath = "/nix/store/dvr9jhhph0lxqxjv8ajawi8588a4bc8c-upper";
  };
  symlinkJoin = {
    binEntries = [ "tool" ];
    outPath = "/nix/store/qnx5sh7zz8dmq0xz3zf0qf4xsg2xbdxy-joined";
    topLevel = [
      "bin"
      "share"
    ];
  };
  writeText = {
    content = "hello\n";
    outPath = "/nix/store/m89ajsff3wd61qwgjiy305ksdjrr4p8s-greeting.txt";
  };
  writeTextFile = {
    content = "#!/bin/sh\necho tool\n";
    outPath = "/nix/store/5accbmq759vba10bgdyqd1hapxhwjf4m-tool";
  };
}
```

- `writeText "greeting.txt" "hello\n"`：一个 store 里的文本文件，路径本身就是 `/nix/store/...-greeting.txt`；
- `writeTextFile`：同样写文本，但可以指定 `destination` (`/bin/tool`)和 `executable`，所以能写一个单文件的“包”；
- `runCommand "upper" { } "..."`：最小的 `mkDerivation`，跑一段脚本，产物是 `$out`；这里是 `echo hello | tr a-z A-Z > $out`，内容 `HELLO\n`；
- `symlinkJoin`：把几个包的目录树合并成一棵符号链接树，`topLevel` 是 `bin` 和 `share`；
- `linkFarm`：显式指定“名字到路径”的映射，`entries` 里有 `a.txt` 和 `bin`。

### firn-tools：symlinkJoin

`pkgs/firn-tools/package.nix` 把四个包并成一个：

```nix
{
  symlinkJoin,
  firn-hello,
  cairn,
  sift,
  pebble,
}:

symlinkJoin {
  name = "firn-tools";
  paths = [
    firn-hello
    cairn
    sift
    pebble
  ];
}
```

我看一下这棵树和它的闭包（手敲，不在 `lab/ch11/` 里）：

```text
$ T=$(nix build --no-link --print-out-paths .#firn-tools)
$ ls -a $T $T/bin
/nix/store/a414yxbsanjvckxsw51wbwbmwpa98wb4-firn-tools:
.
..
bin
lib
nix-support
share

/nix/store/a414yxbsanjvckxsw51wbwbmwpa98wb4-firn-tools/bin:
.
..
cairn
.cairn-wrapped
firn-hello
pebble
sift
.sift-wrapped
$ nix path-info -Sh $T
/nix/store/a414yxbsanjvckxsw51wbwbmwpa98wb4-firn-tools	 327.4 MiB
$ nix path-info -r $T | wc -l
72
```

四个程序各一个符号链接，外加 `.cairn-wrapped` 和 `.sift-wrapped`：`symlinkJoin` 会链接包里的每个文件，这两个是顺带的，包装器 `exec` 的是 `cairn-0.1.0` 里的绝对路径，不是这里的副本。闭包是 327.4 MiB，72 个路径；四个包各自的闭包加起来是 129.7 加 268.2 加 47.8 加 36.1，也就是 481.8 MiB，差了 154.4 MiB，我猜主要是共享的 glibc 之类只存一份。`symlinkJoin` 里的包不会被复制，所以 `firn-tools` 本身只有符号链接，所有的字节都在被指向的路径里。

### cairn-report：writeShellApplication

`pkgs/cairn-report/package.nix`：

```nix
{ writeShellApplication, cairn }:

writeShellApplication {
  name = "cairn-report";
  runtimeInputs = [ cairn ];
  text = ''
    if (($# != 1)); then
      echo 'usage: cairn-report CONFIG' >&2
      exit 2
    fi
    cairn -c "$1" report
  '';
}
```

`writeShellApplication` 比 `writeShellScriptBin` 多做三件事（[`trivial-builders/default.nix` 第 268 行起](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/trivial-builders/default.nix#L268-L348)）：脚本开头加上 `set -o errexit`、`set -o nounset`、`set -o pipefail`；把 `runtimeInputs` 的 `bin/` 加到 `PATH`；构建时跑 ShellCheck。我看生成出来的脚本（手敲，不在 `lab/ch11/` 里）：

```text
$ cat $(nix build --no-link --print-out-paths .#cairn-report)/bin/cairn-report | sed 's|/nix/store/[a-z0-9]*-||g'
#!bash-5.3p15/bin/bash
set -o errexit
set -o nounset
set -o pipefail

export PATH="cairn-0.1.0/bin:$PATH"

if (($# != 1)); then
  echo 'usage: cairn-report CONFIG' >&2
  exit 2
fi
cairn -c "$1" report
```

注意 `export PATH="cairn-0.1.0/bin:$PATH"`：`runtimeInputs` 只是加在 `PATH` 的开头，没有替换，原来的 `PATH` 还在它之后。`writeShellApplication` 有个 `inheritPath ? true` 的参数（同一文件里的参数列表），要隔离的话得传 `inheritPath = false`，我没有试。直接运行：先造一个两次快照的仓库，再跑 `cairn-report`（手敲，不在 `lab/ch11/` 里）：

```text
$ C=$(nix build --no-link --print-out-paths .#cairn); W=/tmp/cairn-demo; export HOME=$W
$ mkdir -p $W/src; echo hello > $W/src/a.txt; echo world > $W/src/b.txt
$ printf 'repo = %s/repo\nsource = %s/src\n' $W $W > $W/cairn.conf
$ $C/bin/cairn -c $W/cairn.conf init $W/repo
$ CAIRN_NOW=20261102T000000Z $C/bin/cairn -c $W/cairn.conf snapshot
cairn: snapshot 20261102T000000Z: 2 files, 12 bytes transferred in 0 s
20261102T000000Z
$ echo more > $W/src/c.txt
$ CAIRN_NOW=20261103T000000Z $C/bin/cairn -c $W/cairn.conf snapshot
cairn: snapshot 20261103T000000Z: 3 files, 5 bytes transferred in 0 s
20261103T000000Z
$ nix run .#cairn-report; echo "rc=$?"
usage: cairn-report CONFIG
rc=2
$ nix run .#cairn-report -- $W/cairn.conf
snapshots    2
ok           2
failed       0
interrupted  0
bytes        17
seconds      avg 0.0 max 0

DAY         SNAPSHOTS  BYTES
2026-11-02  1          12
2026-11-03  1          5
```

最有意思的是第三件事。`lab/ch11/write_shell_application_fail.sh` 写一个带未加引号变量的脚本，让构建失败：

```bash
cat >"${LAB_TMP}/bad.nix" <<NIX
let
  pkgs = import ${FIRN_ROOT}/nix/pkgs.nix { };
in
pkgs.writeShellApplication {
  name = "bad-quote";
  # BAD: \$1 is not quoted, ShellCheck SC2086
  text = "echo \$1";
}
NIX

log="${LAB_TMP}/build.log"
nix build --no-link --impure --file "${LAB_TMP}/bad.nix" 2>"${log}"
status=$?
grep -E 'SC[0-9]+|error: Cannot build' "${log}" | sed -E 's|/nix/store/[a-z0-9]{32}-||g'
exit "${status}"
```

```text
$ cat out/ch11/write_shell_application_fail.stdout
error: Cannot build 'bad-quote.drv'.
       >      ^-- SC2086 (info): Double quote to prevent globbing and word splitting.
       >   https://www.shellcheck.net/wiki/SC2086 -- Double quote to prevent globbing ...
```

这个实验以退出码 1 结束（运行器见到 `_fail` 后缀，期待非零）。ShellCheck 的 SC2086 是“未加引号的变量会被分词和展开”，是 `writeShellApplication` 在构建时挡住的。对比 `writeShellScriptBin`：它的 `checkPhase` 只有 `${stdenv.shellDryRun} "$target"`（[第 261 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/build-support/trivial-builders/default.nix#L261)），而 `stdenv.shellDryRun` 是 `bash -n -O extglob`（[`stdenv/generic/default.nix` 第 251 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/pkgs/stdenv/generic/default.nix#L251)），只检查语法。同一个 `echo $1` 在 `writeShellScriptBin` 里毫无阻碍地通过，一个真正的语法错误才会挂（手敲，不在 `lab/ch11/` 里）：

```text
$ nix build --no-link --print-out-paths --impure --expr '(import ./nix/pkgs.nix { }).writeShellScriptBin "bad-quote" "echo $1"' | xargs -I{} cat {}/bin/bad-quote | sed 's|/nix/store/[a-z0-9]*-||'
#!bash-5.3p15/bin/bash
echo $1
$ nix build --no-link --impure --expr '(import ./nix/pkgs.nix { }).writeShellScriptBin "bad-syntax" "if true; then"' 2>&1 | tail -n 5 | sed 's|/nix/store/[a-z0-9]*-||g'
         bad-syntax
       Last 1 log lines:
       > bad-syntax/bin/bad-syntax: line 3: syntax error: unexpected end of file from `if' command on line 2
       For full logs, run:
         nix log bad-syntax.drv
```

所以我的规矩是：写给人用的脚本包用 `writeShellApplication`，ShellCheck 和 `runtimeInputs` 都有；只想要一个一次性的入口，才用 `writeShellScriptBin`。

## nix-init 和 nurl：让工具写 `src`

我的三个 `package.nix` 里，`src` 的 `hash` 是靠 `fakeHash` 流程算出来的。有两个工具能代劳。`nurl`（上一篇用过）读一个 URL 和一个 rev，打印对应的 fetcher 调用和哈希。`nix-init` 在它之上更进一步：给一个 URL，生成整个 `package.nix`，包括选构建器、探测许可证。`nix-init --help` 里 `--builder` 的可选值是（手敲，不在 `lab/ch11/` 里）：

```text
$ nix-init --help | grep -A 4 -e '--builder'
      --builder <BUILDER>
          Specify the builder
          
          [possible values: buildGoModule, buildPythonApplication, buildPythonPackage,
          buildRustPackage, stdenv.mkDerivation, stdenvNoCC.mkDerivation]
```

版本 0.3.6 的列表是六个，没有 `buildNpmPackage`，没有 `buildDotnetModule`。按这个列表，它大概能替你写出 Pebble 和 Sift 的骨架，写不出 Cairn 那样需要 `wrapProgram` 的东西；我没有真的让它生成过一个 `package.nix`，这是从选项推的。

我本来想直接用 `nix-init --headless --url https://github.com/bfmhno3/pebble --rev tutorial-v1`。它没有跑完：

（手敲，不在 `lab/ch11/` 里）

```text
$ time timeout 90 nix-init --headless --url https://github.com/bfmhno3/pebble --rev tutorial-v1 out.nix; echo "rc=$?"
real	1m30.016s
rc=124
```

90 秒超时，退出码 124，没有输出文件。`lab/ch11/ex_nix_init.sh` 的头注释记了另一次更长的尝试：四分钟以上的重试，最后以一个网络错误告终，注释里的猜测是它在 Rust 项目上要更新 crates.io 的 git 索引（我没有验证）。所以那个实验用的是 `nurl`，`nix-init` 本来就是调它来取 fetcher 的。实验把 `nurl` 的输出和 `pkgs/pebble/package.nix` 里的 `src` 块逐字比较：

```bash
pkg="${FIRN_ROOT}/pkgs/pebble/package.nix"

expected="$(nurl https://github.com/bfmhno3/pebble tutorial-v1 2>/dev/null)"
echo "== nurl https://github.com/bfmhno3/pebble tutorial-v1"
echo "${expected}"

# package.nix 里 src 的缩进是两格，去掉缩进、拿掉 "src = " 前缀再比较。
actual="$(sed -n '/^  src = fetchFromGitHub {/,/^  };/p' "${pkg}" \
  | sed -e 's/^  src = //' -e 's/^  //' -e 's/^};$/}/')"
echo
echo "== src block of pkgs/pebble/package.nix"
echo "${actual}"

if [[ "${actual}" == "${expected}" ]]; then
  echo
  echo "same fetcher and hash"
else
  echo "differs from nurl" >&2
  exit 1
fi
```

输出：

```text
$ cat out/ch11/ex_nix_init.stdout
== nurl https://github.com/bfmhno3/pebble tutorial-v1
fetchFromGitHub {
  owner = "bfmhno3";
  repo = "pebble";
  tag = "tutorial-v1";
  hash = "sha256-m6RjSuHICOLMobZcDn/oMMBwmZvrnAegpUU9rAc/MkY=";
}

== src block of pkgs/pebble/package.nix
fetchFromGitHub {
  owner = "bfmhno3";
  repo = "pebble";
  tag = "tutorial-v1";
  hash = "sha256-m6RjSuHICOLMobZcDn/oMMBwmZvrnAegpUU9rAc/MkY=";
}

same fetcher and hash
```

`same fetcher and hash`：工具给出的 `src` 和我手写的 `src` 是同一个，逐字相同，包括 `tag = "tutorial-v1"` 和 `hash`。这是练习 4 的答案文件。

## 接线：overlay、flake 和 default.nix

五个包定义好之后，要让它们出现在三个入口里。`overlays/default.nix` 是上一篇那一行的六倍：

```nix
final: _prev: {
  firn-hello = final.callPackage ../pkgs/firn-hello/package.nix { };
  cairn = final.callPackage ../pkgs/cairn/package.nix { };
  sift = final.callPackage ../pkgs/sift/package.nix { };
  pebble = final.callPackage ../pkgs/pebble/package.nix { };
  firn-tools = final.callPackage ../pkgs/firn-tools/package.nix { };
  cairn-report = final.callPackage ../pkgs/cairn-report/package.nix { };
}
```

`flake.nix` 和 `default.nix` 里的改动，直接用 `git diff` 看（手敲，不在 `lab/ch11/` 里）：

```text
$ git diff ch10 ch11 -- default.nix flake.nix
diff --git a/default.nix b/default.nix
index 148bbfb..1cca0a1 100644
--- a/default.nix
+++ b/default.nix
@@ -7,7 +7,14 @@ let
   pkgs = import ./nix/pkgs.nix { inherit system; };
 in
 {
-  inherit (pkgs) firn-hello;
+  inherit (pkgs)
+    firn-hello
+    cairn
+    sift
+    pebble
+    firn-tools
+    cairn-report
+    ;
   mini = import ./mini {
     busybox = pkgs.pkgsStatic.busybox;
     inherit system;
diff --git a/flake.nix b/flake.nix
index 48a91d7..1a2fd37 100644
--- a/flake.nix
+++ b/flake.nix
@@ -19,7 +19,14 @@
           overlays = [ self.overlays.default ];
         };
       packagesFor = system: {
-        inherit (pkgsFor system) firn-hello;
+        inherit (pkgsFor system)
+          firn-hello
+          cairn
+          sift
+          pebble
+          firn-tools
+          cairn-report
+          ;
         firn-hello-hallo = (pkgsFor system).firn-hello.override { greeting = "Hallo"; };
         default = (pkgsFor system).firn-hello;
       };
```

`checks` 不用手写：`flake.nix` 第 133 到 136 行用 `mapAttrs'` 给 `packagesFor` 里每个包（除了 `default`）自动生成一个 `pkg-<name>`，所以 5 个新包自动多了 5 个检查：

（手敲，不在 `lab/ch11/` 里）

```text
$ nix eval .#checks.x86_64-linux --apply builtins.attrNames
[ "dev-shell" "lib-tests" "mini-site" "pkg-cairn" "pkg-cairn-report" "pkg-firn-hello" "pkg-firn-hello-hallo" "pkg-firn-tools" "pkg-pebble" "pkg-sift" "readme-table" ]
$ nix eval .#packages.x86_64-linux --apply builtins.attrNames
[ "cairn" "cairn-report" "default" "firn-hello" "firn-hello-hallo" "firn-tools" "pebble" "sift" ]
```

11 个检查，8 个包。上一篇是 6 个检查和 3 个包。

### 两个名字被我顶掉了

在 overlay 里加 `sift` 和 `pebble` 之后，`nixpkgs` 里已有的同名包被替换了。我用不带 overlay 的 `pkgs` 看原来的是什么（手敲，不在 `lab/ch11/` 里）：

```text
$ nix eval --impure --raw --expr 'let p = import ./nix/pkgs.nix { overlays = [ ]; }; in p.sift.name + " | " + p.sift.meta.description + " | " + p.pebble.name + " | " + p.pebble.meta.description'
sift-0.9.0 | Fast and powerful alternative to grep | pebble-2.6.0 | Small RFC 8555 ACME test server
$ nix eval --impure --raw --expr 'let p = import ./nix/pkgs.nix { }; in p.sift.name + " | " + p.pebble.name + " | " + p.cairn.name'
sift-0.1.0 | pebble-0.1.0 | cairn-0.1.0
```

nixpkgs 里原来的 `sift` 是一个 grep 的替代品，`pebble` 是一个 ACME 测试服务器（它们的 `meta.description` 分别是 “Fast and powerful alternative to grep” 和 “Small RFC 8555 ACME test server”）。nixpkgs 自己的 NixOS 测试用着 `pkgs.pebble`，比如 [`acme/dns01.nix` 第 65 行](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/tests/acme/dns01.nix#L65)、`nixos/tests/common/acme/server/default.nix` 第 124 行和 `pangolin.nix` 第 62 行。只有拿带这个 overlay 的 `pkgs` 去跑 `nixosTests.acme` 时才会被替换，那时 `pebble-challtestsrv` 在我的 Pebble 里并不存在；我没有跑那个测试，只验证了名字被换成了 0.1.0。这也是 nixpkgs 属性数从 27960 变成 27963 而不是 27965 的原因：5 个新名字里有 2 个是替换，只有 3 个是新增（上一篇的 27960 是 27959 加 `firn-hello`；`cairn`、`firn-tools`、`cairn-report` 是新名字）。Firn 里的包名只在这个教学项目里用，所以我没有改名；真要往 nixpkgs 提交 Sift 或 Pebble，名字冲突得先解决，而 Cairn 没有这个问题：不带 overlay 的 nixpkgs 里没有 `cairn`。

## 让我意外的事

这一篇写完，我对“打一个包”的印象从“把命令抄进 `package.nix`”变成了“逐个确认每一行真的在起作用”。四件事：

**`buildInputs = [ bash ]` 不是在启用一个功能，是在选一个更大的 bash。** 我第一版的注释以为没有它，`patchShebangs` 就找不到 `bash`。清空 `buildInputs` 之后脚本照样被改写，只是改写成 stdenv 自带的 `bash-5.3p15`，闭包从 129.7 MiB 降到 122.1 MiB。原因是 `pkgs.bash` 在这个 rev 上是带 readline 的 `bash-interactive`（`all-packages.nix` 第 3065 行），最小的叫 `bashNonInteractive`。闭包里同时有两个 bash，一个给 `.cairn-wrapped` 的 shebang，一个给包装器。

**Sift 的 `installCheckPhase` 曾经从来没运行过。** `mkPythonDerivation` 用 `doInstallCheck = attrs.doCheck or true`，我为了跳过不存在的测试写的 `doCheck = false;` 把它连带关掉了。我把检查改成必定失败的命令，构建照样通过 (`rc=0`)，去掉那一行才失败 (`rc=1`)。教训是在 nixpkgs 里“写了一个检查”和“它在运行”是两件事，唯一可靠的确认办法是看日志里有没有阶段标题。

**冷构建 4 分 13.4 秒，重建只要 45.4 秒。** Pebble 重建（所有输入都在 store 里）的中位数是 45.4 秒，冷构建是 253.4 秒，差的约 208 秒花在固定输出的下载和 vendor 上，占 82%，我没有把网络和 CPU 分开量。编译 48 个编译单元加测试只是其中的一小部分。如果这是 CI，我猜缓存 `vendor-staging` 和 `source` 两个固定输出比缓存编译结果更值钱，这一点我没有测。

**我的 overlay 把 nixpkgs 里的 `sift` 和 `pebble` 顶掉了。** nixpkgs 里原来有 `sift-0.9.0`（grep 的替代品）和 `pebble-2.6.0`（ACME 测试服务器），而 NixOS 自己的测试 `acme/dns01.nix` 第 65 行引用 `pkgs.pebble`。名字冲突在 overlay 里不会报错，只会悄悄替换。我是靠数属性数（27963 而不是 27965）才发现的。

## 检查点

在 `~/firn` 里，`nix develop` 之内：

```bash
make ch11
make lint
make check
while read -r f; do
  diff <(git -C ~/firn-ref show ch11:"${f}") "${f}" && echo "same ${f}"
done < <(git -C ~/firn-ref diff --name-only ch10 ch11 \
  | grep -v -e '^README.md$' -e '^default.nix$' -e '^flake.nix$' -e '^overlays/')
```

我的环境里设了 `CI=true`，我跑的是 `env -u CI make ch11`。第 11 章没有 `_host` 实验，`CI=true` 不会让任何一个被跳过。`make ch11` 应当打印这 11 行（命令回显加 10 行 `ok`），整条命令（含 `nix develop` 的启动）在这台机器上花了 5 分 14.6 秒：

```text
bash scripts/chapter.sh ch11
ok   lab/ch11/cairn_checkphase.sh
ok   lab/ch11/cairn_wrapped.sh
ok   lab/ch11/cargo_hash.sh
ok   lab/ch11/closures.sh
ok   lab/ch11/ex_nix_init.sh
ok   lab/ch11/patch_shebangs.sh
ok   lab/ch11/pebble_runs.sh
ok   lab/ch11/sift_runs.sh
ok   lab/ch11/trivial_builders.nix
ok   lab/ch11/write_shell_application_fail.sh
```

10 个实验全部是 `ok`。其中 `write_shell_application_fail.sh` 的 `ok` 是“按设计失败”：运行器见到 `_fail` 后缀，期待非零退出码，它的退出码是 1 (`out/ch11/write_shell_application_fail.status`)。

`make lint` 回显它跑的几条命令（`nixfmt --check`、`deadnix --fail`、`shellcheck`、`shfmt`；`statix` 那一行以 `@` 开头，`make` 不回显），没有任何诊断，退出码 0。`make check` 以 `all checks passed!` 结束，退出码 0，x86_64-linux 上有 11 个检查（上一篇是 6 个）：

```text
$ make check 2>&1 | tail -n 5
derivation evaluated to /nix/store/sxj15y2pgk96v1kv2si52j1i2dqbbd5q-nixfmt-tree-2.5.0.drv
running 0 flake checks...
all checks passed!
warning: The check omitted these incompatible systems: aarch64-linux
Use '--all-systems' to check all.
rc=0
```

`diff` 循环应当打印 15 行 `same ...`，不打印 diff (15 = 19 - 4)。

**必须和标签一致的文件：** `pkgs/` 下 5 个 `package.nix`，以及 `lab/ch11/` 下全部 10 个实验文件。

**中间版本（之后的章节会继续改）：**

- [`README.md`](https://github.com/bfmhno3/firn/blob/ch11/README.md)：每一章都会往目录说明和输出表里加行。
- [`default.nix`](https://github.com/bfmhno3/firn/blob/ch11/default.nix)：现在是 6 个包加 `mini`，之后有新包才会再加。
- [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch11/flake.nix)：`packagesFor` 现在是 8 个包，之后每章都会往 `packages`、`checks` 里加东西。
- [`overlays/default.nix`](https://github.com/bfmhno3/firn/blob/ch11/overlays/default.nix)：现在有 6 个属性；之后有新包才会再加。

### 文件清单

这一篇的所有文件都在仓库里，链接指向标签 `ch11` 上的那一份。`git diff --name-only ch10 ch11` 列出 19 个文件，这里一个不少；`lab/ch11/` 下有 10 个文件（9 个 `.sh` 和 1 个 `.nix`），没有 fixture，它们都已经在那 19 个里。`LICENSE-MIT` 和 `LICENSE-APACHE` 没有变，不在表里。实验需要沙箱目录，所以它们的命令都是 `make ch11`；命令列里不是 `make ch11` 的，都是我手敲的，不在 `lab/ch11/` 里。结果列是我在 Nix 2.34.9 下实际跑出来的，标 `volatile` 的数字取决于缓存和机器的状态。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`README.md`](https://github.com/bfmhno3/firn/blob/ch11/README.md) | `git diff --numstat ch10 ch11 -- README.md` | 输出 `5 1 README.md`：新增 5 行、删除 1 行；目录说明多了 `pkgs/` 和 `overlays/` 两行，输出表多了 `packages` 和 `overlays.default` 两行，`checks` 一行加上了 `pkg-*` |
| [`default.nix`](https://github.com/bfmhno3/firn/blob/ch11/default.nix) | `nix-build -A cairn --no-out-link` | 退出码 0，输出 `/nix/store/08miknl7zqxj4xrcvp27jjcpf9grfaj8-cairn-0.1.0`，和 `nix build .#cairn` 是同一个路径；导出 `firn-hello`、`cairn`、`sift`、`pebble`、`firn-tools`、`cairn-report` 和 `mini` |
| [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch11/flake.nix) | `make check` | 退出码 0，`all checks passed!`；x86_64-linux 的 `checks` 有 11 个，`packages` 有 8 个 |
| [`lab/ch11/cairn_checkphase.sh`](https://github.com/bfmhno3/firn/blob/ch11/lab/ch11/cairn_checkphase.sh) | `make ch11` | 退出码 0；`checkPhase`、`installPhase`、`installCheckPhase` 三行标题和 `81 tests, 0 failures` |
| [`lab/ch11/cairn_wrapped.sh`](https://github.com/bfmhno3/firn/blob/ch11/lab/ch11/cairn_wrapped.sh) | `make ch11` | 退出码 0；包装器 `#!` 是 `bash-5.3p15`，`.cairn-wrapped` 的 shebang 是 `bash-interactive-5.3p15`；`ok 20261102T000000Z (2 files)`；stderr 里是 Cairn 自己的一行快照日志 |
| [`lab/ch11/cargo_hash.sh`](https://github.com/bfmhno3/firn/blob/ch11/lab/ch11/cargo_hash.sh) | `make ch11` | 退出码 0；`got:` 和 `committed:` 都是 `sha256-N6epgex2dseqHh+eiezB7KS7ude18+L2KgpwMTVAaj4=` |
| [`lab/ch11/closures.sh`](https://github.com/bfmhno3/firn/blob/ch11/lab/ch11/closures.sh) | `make ch11` | 退出码 0；`firn-hello` 36.1MiB/6，`cairn` 129.7MiB/46，`sift` 268.2MiB/39，`pebble` 47.8MiB/7 |
| [`lab/ch11/ex_nix_init.sh`](https://github.com/bfmhno3/firn/blob/ch11/lab/ch11/ex_nix_init.sh) | `make ch11` | 退出码 0；`same fetcher and hash`；练习 4 的答案 |
| [`lab/ch11/patch_shebangs.sh`](https://github.com/bfmhno3/firn/blob/ch11/lab/ch11/patch_shebangs.sh) | `make ch11` | 退出码 0；`doCheck = true` 时 `checkPhase: bin/cairn rewritten`，`doCheck = false` 时 `fixupPhase: bin/cairn rewritten` |
| [`lab/ch11/pebble_runs.sh`](https://github.com/bfmhno3/firn/blob/ch11/lab/ch11/pebble_runs.sh) | `make ch11` | 退出码 0；`pebble run examples/fib.pebble -> 6765` |
| [`lab/ch11/sift_runs.sh`](https://github.com/bfmhno3/firn/blob/ch11/lab/ch11/sift_runs.sh) | `make ch11` | 退出码 0；`Usage: sift [OPTIONS] COMMAND [ARGS]...`，闭包里有 `python3-3.14.7` |
| [`lab/ch11/trivial_builders.nix`](https://github.com/bfmhno3/firn/blob/ch11/lab/ch11/trivial_builders.nix) | `make ch11` | 退出码 0；五个构建器各一个路径，`writeText` 的内容是 `hello\n`，`runCommand` 的内容是 `HELLO\n`，`symlinkJoin` 的 `topLevel` 是 `bin` 和 `share` |
| [`lab/ch11/write_shell_application_fail.sh`](https://github.com/bfmhno3/firn/blob/ch11/lab/ch11/write_shell_application_fail.sh) | `make ch11` | 退出码 1（按设计失败），stdout 里是 `SC2086` 那一行 |
| [`overlays/default.nix`](https://github.com/bfmhno3/firn/blob/ch11/overlays/default.nix) | `nix eval --impure --expr 'let a = import ./nix/pkgs.nix { overlays = [ ]; }; b = import ./nix/pkgs.nix { }; in [ (builtins.length (builtins.attrNames a)) (builtins.length (builtins.attrNames b)) ]'` | 退出码 0，输出 `[ 27959 27963 ]`：6 个属性，4 个新名字，`sift` 和 `pebble` 顶掉了 nixpkgs 里已有的两个 |
| [`pkgs/cairn-report/package.nix`](https://github.com/bfmhno3/firn/blob/ch11/pkgs/cairn-report/package.nix) | `nix run .#cairn-report; echo "rc=$?"` | 输出 `usage: cairn-report CONFIG`，`rc=2`；给它一个配置文件时打印 `cairn report` 的结果，`rc=0` |
| [`pkgs/cairn/package.nix`](https://github.com/bfmhno3/firn/blob/ch11/pkgs/cairn/package.nix) | `nix build .#cairn --no-link --print-out-paths` | 退出码 0，输出 `/nix/store/08miknl7zqxj4xrcvp27jjcpf9grfaj8-cairn-0.1.0`；`81 tests, 0 failures`；闭包 129.7 MiB，46 个路径 |
| [`pkgs/firn-tools/package.nix`](https://github.com/bfmhno3/firn/blob/ch11/pkgs/firn-tools/package.nix) | `nix path-info -Sh $(nix build --no-link --print-out-paths .#firn-tools)` | 输出 `/nix/store/a414yxbsanjvckxsw51wbwbmwpa98wb4-firn-tools` 和 `327.4 MiB`；闭包 72 个路径 |
| [`pkgs/pebble/package.nix`](https://github.com/bfmhno3/firn/blob/ch11/pkgs/pebble/package.nix) | `nix build .#pebble --no-link --print-out-paths` | 退出码 0，输出 `/nix/store/psn4fsd8a5nsm1ki35bwy8q39w5br1b7-pebble-0.1.0`；`volatile:` 冷构建 4 分 13.4 秒，重建中位数 45.4 秒；3 加 12 个测试通过 |
| [`pkgs/sift/package.nix`](https://github.com/bfmhno3/firn/blob/ch11/pkgs/sift/package.nix) | `nix build .#sift --no-link --print-out-paths` | 退出码 0，输出 `/nix/store/gid3y81b54nq3rn9axj3r7n05x0zsfxp-sift-0.1.0`；`sift --version` 打印 `sift 0.1.0`；日志里有 `Running phase: installCheckPhase` |

## 练习

**1.** Cairn 的闭包是 129.7 MiB，其中 `util-linux` 一项的闭包是 99.8 MiB，而我只在源码里找到 `flock` 一处用到它。不改 `package.nix`，写一个 `override`，把闭包缩下来，并且确认 81 个测试和 `installCheckPhase` 仍然通过。

<details>
<summary>参考答案</summary>

`util-linux` 有一个最小的变体 `util-linuxMinimal`，bash 有 `bashNonInteractive`。三个变体（手敲，不在 `lab/ch11/` 里）：

```text
$ nix build --no-link --print-out-paths --impure --expr 'let p = import ./nix/pkgs.nix { }; in p.cairn.override { bash = p.bashNonInteractive; }' | xargs nix path-info -Sh
/nix/store/pkibwqzb1yzg1ggga03hjgzww2yyir7j-cairn-0.1.0	 122.1 MiB
$ nix build --no-link --print-out-paths --impure --expr 'let p = import ./nix/pkgs.nix { }; in p.cairn.override { util-linux = p.util-linuxMinimal; }' | xargs nix path-info -Sh
/nix/store/6lbcgl1ggsfqajhjy1xpfbrnym3n13lk-cairn-0.1.0	 93.6 MiB
$ nix build --no-link --print-out-paths --impure --expr 'let p = import ./nix/pkgs.nix { }; in p.cairn.override { bash = p.bashNonInteractive; util-linux = p.util-linuxMinimal; }' | xargs nix path-info -Sh
/nix/store/msrz896m5cf20hd1ji21pjik916mykbx-cairn-0.1.0	 82.3 MiB
```

| 变体 | 闭包 | 路径数 |
| --- | --- | --- |
| 原版 | 129.7 MiB | 46 |
| `bash = bashNonInteractive` | 122.1 MiB | 44 |
| `util-linux = util-linuxMinimal` | 93.6 MiB | 34 |
| 两个一起 | 82.3 MiB | 31 |

两个一起，闭包缩小了 36.6% (47.4 MiB)。这些构建都成功了，说明新依赖下 `checkPhase` 的 81 个测试和 `installCheckPhase` 都过了，因为 `override` 重新跑了整个 `package.nix`。我没有逐项核对 `util-linuxMinimal` 少了哪些命令；对 Cairn 来说，只要 `flock` 还在，测试就能过。

</details>

**2.** 把 `completion.bats` 和 `lock_signal.bats` 也放进 Cairn 的 `checkPhase`，构建会通过吗？测试数会是多少？

<details>
<summary>参考答案</summary>

会通过，是 115 个（81 加 22 加 12）。写一个 `overrideAttrs`（手敲，不在 `lab/ch11/` 里）：

```nix
let
  pkgs = import /home/bfmhno3/Projects/firn/nix/pkgs.nix { };
in
pkgs.cairn.overrideAttrs {
  checkPhase = ''
    runHook preCheck
    bats --formatter pretty tests/cli.bats tests/config.bats tests/prune.bats \
      tests/snapshot.bats tests/verify_diff.bats tests/report.bats \
      tests/completion.bats tests/lock_signal.bats
    runHook postCheck
  '';
}
```

（手敲，不在 `lab/ch11/` 里）

```text
$ nix build --no-link -L --impure --file /tmp/ch11-scratch/more_tests.nix 2>&1 | grep -E 'tests, [0-9]+ failures|error:' | sed 's/^cairn> //'; echo "rc=${PIPESTATUS[0]}"
115 tests, 0 failures
rc=0
```

这是一次测量，不是“稳定通过”的证明：`lock_signal.bats` 靠信号和时序，我只在这台机器上跑过几次。

</details>

**3.** `firn-tools` 的闭包是 327.4 MiB，而 `sift` 单独是 268.2 MiB。多出来的 59.2 MiB 是哪些路径？`sift` 的闭包是 `firn-tools` 闭包的子集吗？

<details>
<summary>参考答案</summary>

用 `comm` 做集合差（手敲，不在 `lab/ch11/` 里）：

```text
$ S=$(nix build --no-link --print-out-paths .#sift); T=$(nix build --no-link --print-out-paths .#firn-tools)
$ comm -13 <(nix path-info -r $S | sort) <(nix path-info -r $T | sort) | wc -l
33
$ comm -23 <(nix path-info -r $S | sort) <(nix path-info -r $T | sort) | wc -l
0
$ nix path-info --json --json-format 1 $(comm -13 <(nix path-info -r $S | sort) <(nix path-info -r $T | sort)) | jq -r 'to_entries|sort_by(-.value.narSize)|.[:5][]|"\(.value.narSize) \(.key)"' | sed 's|/nix/store/[a-z0-9]*-||'
14575560 util-linux-2.42.2-lib
9827104 util-linux-2.42.2-bin
7411712 bash-interactive-5.3p15
4547240 shadow-4.20.0
3702312 db-4.8.30
```

`firn-tools` 比 `sift` 多 33 个路径，`sift` 有而 `firn-tools` 没有的是 0 个，所以是子集。多出来的 33 个路径加起来 59.2 MiB（327.4 减 268.2），最大的几个是 Cairn 带来的：`util-linux` 的 `lib` 和 `bin`、`bash-interactive`、`shadow`。`symlinkJoin` 的闭包是各个成员闭包的并集，并集的大小不是它们各自大小的和。

</details>

**4.** 让 `nurl` 给出 Pebble 的 `src`，并和 `pkgs/pebble/package.nix` 里的 `src` 块比较。

<details>
<summary>参考答案</summary>

这是 [`lab/ch11/ex_nix_init.sh`](https://github.com/bfmhno3/firn/blob/ch11/lab/ch11/ex_nix_init.sh)，核心是把 `nurl` 的输出存进变量，再用 `sed` 把 `package.nix` 里的 `src` 块去掉缩进和 `src = ` 前缀，逐字比较：

```bash
expected="$(nurl https://github.com/bfmhno3/pebble tutorial-v1 2>/dev/null)"
# ...
if [[ "${actual}" == "${expected}" ]]; then
  echo
  echo "same fetcher and hash"
else
  echo "differs from nurl" >&2
  exit 1
fi
```

输出（一致，所以以 0 退出）：

```text
$ cat out/ch11/ex_nix_init.stdout
== nurl https://github.com/bfmhno3/pebble tutorial-v1
fetchFromGitHub {
  owner = "bfmhno3";
  repo = "pebble";
  tag = "tutorial-v1";
  hash = "sha256-m6RjSuHICOLMobZcDn/oMMBwmZvrnAegpUU9rAc/MkY=";
}

== src block of pkgs/pebble/package.nix
fetchFromGitHub {
  owner = "bfmhno3";
  repo = "pebble";
  tag = "tutorial-v1";
  hash = "sha256-m6RjSuHICOLMobZcDn/oMMBwmZvrnAegpUU9rAc/MkY=";
}

same fetcher and hash
```

要用 `nix-init` 就把 `nurl` 换成 `nix-init --headless --url ... --rev tutorial-v1`，但在这台机器上它 90 秒内没有跑完（`nix-init` 一节里有那次 `timeout` 的记录）。

</details>

## 下一篇

这一篇的三个包都在 x86_64-linux 上，用的是同一个 glibc 和同一个 gcc。第 12 篇《交叉编译与静态链接：pkgsCross、pkgsStatic 与 splicing》要问的是：`firn-hello` 能不能在 x86_64 上编出 aarch64 的二进制，能不能静态链接，`pkgsStatic` 里的 `firn-hello` 有多大。我最想知道的是，一个只依赖 glibc 和 zlib 的 36.1 MiB 闭包，换成 musl 静态链接之后，会不会比 Pebble 的 1.8 MiB 二进制还小，我还不知道。
