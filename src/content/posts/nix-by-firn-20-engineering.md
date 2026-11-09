---
title: "工程化：CI、Cachix、lint 与可复现性"
commentId: "post:nix-by-firn-20-engineering"
published: "2026-11-09 02:00:00 +08:00"
description: "用 Firn 从零学 Nix 第 20 篇：我用 Nix 2.34.9 给 Firn 写了一条在 upstream 和 Determinate 两种安装器上各跑一遍 make ci 的 GitHub Actions workflow、一个 Cachix 缓存和两个新的 flake check（lint 与 14 个 nix-unit 用例），并量到：一个很小的包在空 store 里构建要 32 到 230 秒，从签过名的本地缓存里取只要 0.35 秒。"
category: Tutorial
tags:
  - Nix
  - NixOS
  - Firn
  - CI
  - 二进制缓存
  - 可复现性
series: "用 Firn 从零学 Nix"
seriesOrder: 20
draft: false
comment: true
slug: nix-by-firn-20-engineering
---

第 6 篇我写过：store 路径里的哈希是输入的指纹，只要输入一样，路径就一样。这条规则留下了两个我一直没量过的问题。第一，“输入一样”不等于“输出一样”：第二次构建得到的是不是同样的字节，Nix 自己并不保证。第二，同一个路径在任何一台机器上都指向同一个东西，那我在一个空 store 里构建 `firn-hello`（一个很小的 C 程序）为什么有时要等将近四分钟？这一篇把这两个问题都量一遍，然后把 Firn 的全部检查搬到 GitHub Actions 上，最后给这个系列做一张索引。

```text
$ S=/tmp/s20/cold
$ /usr/bin/env time -f 'cold build in empty store: %e s' nix build --store "$S" --no-link .#firn-hello 2>&1 | tail -1
cold build in empty store: 32.01 s
$ D=/tmp/s20/cmp
$ nix copy --to "file://$D/cache" "$H"
$ /usr/bin/env time -f 'copy from file:// cache into empty store: %e s' nix copy --from "file://$D/cache" --to "$D/hit" --option trusted-public-keys "$K" "$H" 2>&1 | tail -1
copy from file:// cache into empty store: 0.35 s
$ /usr/bin/env time -f 'nix build --rebuild of firn-hello: %e s' nix build --no-link --rebuild .#firn-hello 2>&1 | tail -1
nix build --rebuild of firn-hello: 0.36 s
```

（手敲，不在 `lab/ch20/` 里；`H` 是 `firn-hello` 的 store 路径，`K` 是本地缓存的公钥，造缓存和签名的几步在“Cachix：推、令牌和公钥”一节展示）

同一条冷构建的命令我跑了三次：第一次 230.42 秒，第二次 32.01 秒，第三次停在一个下载上，5 分钟没有动静，我把它杀掉了。三次之间代码、仓库、命令都没变，变的是网络：这 896 MiB 的 store 里几乎全是 gcc 和 glibc。重新构建那个 C 程序本身只要 0.36 秒，从缓存里取它只要 0.35 秒。这一篇的主题就是这几个数字之间的距离。

> [!NOTE] 本篇检查点
> 这一篇结束时，Firn 仓库的标签 `ch20` 里新增：`.github/workflows/ci.yml`（46 行）、`.github/workflows/update-flake-lock.yml`（18 行）、`tests/lib-unit.nix`（84 行）、`mini/pkgs/nondeterministic.nix`（10 行），以及 `lab/ch20/` 下 11 个实验和 2 个夹具文件；改动的文件有 `flake.nix`（429 行，多了 `nixConfig`、`lib-unit` 和 `lint` 两个检查）、`Makefile`（多一个 `repro` 目标）、`README.md`、`mini/default.nix`、`lab/ch07/mini_build.sh` 和 `lab/ch19/flakehub_resolve_host.sh`。`env -u CI make ch20` 通过。
> 涉及的概念：GitHub Actions 里的 Nix（矩阵、两种安装器、KVM），二进制缓存（narinfo、NAR、签名、`substituters`、`trusted-substituters`、`trusted-public-keys`、`trusted-users`），Cachix 与它的替代品，`nixConfig` 与 `accept-flake-config`，`nixfmt` 与 RFC 166，statix 与 deadnix，nixd 与 nil，测试的四层（`runTests`、nix-unit、flake checks、虚拟机测试），可复现性（`--rebuild`、diffoscope、公开的报告），以及锁文件的更新策略。
> 前置：[第 19 篇：Determinate、FlakeHub 与 Nix 的分叉们](/posts/nix-by-firn-19-determinate-and-forks/)。这一篇用到第 6 篇的 NAR 和 store 路径、第 8 篇的 flake 检查、第 16 到 18 篇的虚拟机测试，其余是新东西。
> 终稿与中间版本：这是系列的最后一篇，`ch20` 是最后一个标签，上述文件在这里都是终稿。

## 环境

这一篇的输出来自这台机器：NixOS 26.05 (Yarara)，Linux 6.18.60，`x86_64`，16 个核，上游 Nix 2.34.9。开发 shell 的横幅是 `nixfmt 1.4.0, statix 0.5.8-unstable-2026-07-17, deadnix 1.3.2`。Firn 钉的 nixpkgs 还是 `56c02bc00adcf003215cc4bd996d6efaf4cff188`，它里面的其他工具版本我是直接问出来的：

```text
$ for p in nix-unit nil nixd diffoscope cachix; do printf "%s %s\n" "$p" "$(nix eval --raw --file nix/pkgs.nix "$p.version")"; done
nix-unit 2.35.1
nil 2026-07-23
nixd 2.9.2
diffoscope 329
cachix 1.12.0
```

（手敲，不在 `lab/ch20/` 里；今天是 2026-11-08，凡是标了日期的远程查询都是这一天查的）

需要联网的实验（镜像延迟、`cache.nixos.org` 的 narinfo、GitHub 的 API）结果取决于这一天的网络，我在每处标了出来。另外，Firn 仓库里每一条针对 `.#…` 的 `nix` 命令，stderr 的开头都会有 4 行 `nixConfig` 警告（原因在“nixConfig 与 accept-flake-config”一节）；这一篇的输出块里我把它们省掉了，只有那一节专门展示。

## 一条 workflow：每次推送都跑一遍 make ci

第 19 篇的 `flakehub.yml` 只发布，不测试。这一篇的 [`.github/workflows/ci.yml`](https://github.com/bfmhno3/firn/blob/ch20/.github/workflows/ci.yml) 才是 Firn 的 CI，46 行。先看骨架（L4 到 L23，加最后一行 L46，中间的三段各有一节）：

```yaml
name: CI

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  check:
    name: check (${{ matrix.installer }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        installer: [upstream, determinate]
    steps:
      - uses: actions/checkout@v7
      # ...
      - run: nix develop --command make ci
```

几个选择要交代。触发只有推送 `main` 和手动 (`workflow_dispatch`)，没有 `pull_request`：cachix-action 的 README 写得很直白，分叉仓库的 PR 读不到 secrets，所以只能读公开缓存，而这个仓库只有我一个人提交，我没有为一个不存在的贡献者写额外的分支。`permissions: contents: read` 把 `GITHUB_TOKEN` 压到只读；Determinate 的 action README 说用 FlakeHub 时要加 `id-token: write`，否则 Determinate Nix 无法向 FlakeHub 认证，Firn 的 CI 不碰 FlakeHub，所以我没加（第 19 篇的 `flakehub.yml` 才需要）。`fail-fast: false` 让一条矩阵线失败时另一条继续跑完，因为这篇要的正是两条线各自的结果和时间。矩阵线的名字由 `name:` 那一行决定，是 `check (upstream)` 和 `check (determinate)`，`ci_times_host.sh` 打印的就是这个字符串。

最后一行是整个 workflow 的实质：`nix develop --command make ci`。[`Makefile`](https://github.com/bfmhno3/firn/blob/ch20/Makefile) 的第 1 到 3 行规定 `make` 必须在 `nix develop` 里跑（否则 `$(error run inside nix develop)`），第 31 行定义 `ci: lint chapters check`。也就是说 CI 跑的和我在本地敲的是同一条命令，没有第二套脚本。

有一件事必须先说清：GitHub 的默认环境变量里 `CI` “Always set to `true`”（[文档](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)），而 [`scripts/chapter.sh`](https://github.com/bfmhno3/firn/blob/ch20/scripts/chapter.sh) 的第 12 行规定 `*_host.*` 在 `CI=true` 时跳过。所以 runner 上的 `make ci` 不跑任何 `_host` 实验（这一篇的 `mirrors_host.sh`、`cachix_hit_host.sh`、`ci_times_host.sh` 和 `diffoscope_host.sh` 也一样），虚拟机测试走的是 `nix flake check` 里的 `cairn-vm`、`secrets-vm`、`home-vm`。我自己的 shell 里也是 `CI=true`，这就是整个系列里 `env -u CI make chNN` 的由来。

### KVM：给 /dev/kvm 放权限

三个虚拟机测试需要 `/dev/kvm`。workflow 的 L27 到 L31：

```yaml
      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm
```

这三行不是我发明的，它们和 GitHub 在 2024-04-02 的更新日志里给 Android 模拟器写的那一段一模一样（[GitHub Changelog](https://github.blog/changelog/2024-04-02-github-actions-hardware-accelerated-android-virtualization-now-available/)，当时的说明是 2 vCPU 的 Linux runner 也能用硬件加速了）。意思是：写一条 udev 规则，让内核设备 `kvm` 的组是 `kvm`、权限是 `0666`；按 udev(7) 的说法，`static_node=kvm` 是把规则里的权限应用到 systemd-tmpfiles 在 udevd 启动之前创建的静态节点上，规则本身不创建节点；然后重载规则并对 `kvm` 设备触发一次。`0666` 的代价是任何用户都能打开 `/dev/kvm`，在一台只存活几十分钟、只有我的代码的虚拟机上这没关系，在共享的自托管 runner 上就是另一回事了。

GitHub 的文档表格（2026-11-08 查）里，公开仓库的标准 `ubuntu-latest` 是 4 个 vCPU、16 GB 内存、14 GB SSD，文字里写着 Linux 的 GitHub-hosted runner 支持 Android SDK 工具的硬件加速。文档没说 Nix 的虚拟机测试；两条矩阵线的 `make ci` 最后都跑绿了（见“推上去之后 CI 红了四次”一节），其中包括 `nix flake check` 里的三个虚拟机检查，所以这条规则至少没有挡住它们，不过有些检查的结果可能是从 Cachix 取的，没有在 runner 上重跑，我没有区分。另外两个安装器的 README 都写着自己默认会配置 KVM（install-nix-action 的 `enable_kvm` 默认 `true`，determinate-nix-action 的 `kvm` 默认 `true`），那这一步可能是多余的；我没有试过拿掉它，把它显式地留着，是不想让 workflow 的成败取决于某个安装器的默认值。

### 两个安装器

L33 到 L39：

```yaml
      - name: Install Nix (upstream)
        if: matrix.installer == 'upstream'
        uses: cachix/install-nix-action@v31

      - name: Install Nix (Determinate)
        if: matrix.installer == 'determinate'
        uses: DeterminateSystems/determinate-nix-action@v3
```

同一个 job 里两个互斥的步骤，用 `if:` 选一个。前者是 Cachix 维护的 [`install-nix-action`](https://github.com/cachix/install-nix-action)，README (2026-11-08 查) 的卖点是安装快（“~4s on Linux”）、在 Linux 上默认多用户安装并开沙箱；后者是第 19 篇见过的 Determinate 一家：[`determinate-nix-action`](https://github.com/DeterminateSystems/determinate-nix-action) 基于 Determinate Nix Installer，README 里默认装的版本是 `v3.24.2` (2026-11-08 查)，和我在第 19 篇的虚拟机里量的是同一个。

它们有一处相同，而这一处恰好是“substituters、trusted-substituters 和 trusted-users”一节的实际场景：install-nix-action 默认 `set_as_trusted_user: true`，determinate-nix-action 默认 `trust-runner-user: true`，都会把 runner 用户放进 `trusted-users`。没有这一步，下一步的 cachix-action 就没有权限往 Nix 里加一个新的 substituter：这是我从手册的 `trusted-users` 条目推出来的，我没有在 runner 上验证。

### Cachix：先拉，后推

L41 到 L46：

```yaml
      - uses: cachix/cachix-action@v17
        with:
          name: bfmhno3-firn
          authToken: ${{ secrets.CACHIX_AUTH_TOKEN }}

      - run: nix develop --command make ci
```

[`cachix-action`](https://github.com/cachix/cachix-action) 的 README (2026-11-08 查) 一句话说完了它的工作：“After each job, newly built packages are pushed to your binary cache.” README 里在它之前还有一句：“Before each job, packages to be built are first downloaded (if they exist) from your binary cache.” 推送默认走守护进程模式：它给 Nix 注册一个 `post-build-hook`，每个新构建出来的路径立刻被推走；README 同时写了限制，“Nix does not trigger the hook for substituted paths”，也就是说从 `cache.nixos.org` 拿来的路径不会被推。我猜这意味着 `bfmhno3-firn` 里装的主要是 Firn 自己构建的东西；`pebble` 确实在里面（见本节 `cachix_hit_host.sh` 的输出），别的包我没有逐个查。

`authToken` 来自仓库 secret `CACHIX_AUTH_TOKEN`。`gh secret list -R bfmhno3/firn` 只列名字，它在列表里；令牌本身我没碰过，也不会出现在任何一篇文章里。README 的安全一节有三句我觉得应该原样记住：“Cachix tokens and signing keys provide full read and/or write access to your caches.” “GitHub Actions allows anyone who can edit workflow files to read secrets.” “Forked pull requests cannot access secrets, so they can only read from public caches.” 一个能改 workflow 的人能读到令牌，这就是为什么写权限只该给你信任的人。

## CI 耗时：两个安装器，冷和热

这一篇的问题清单里排第一的是第 19 篇留下的那个：`determinate-nix-action` 和上游安装方式，在一次完整的 `make ci` 里各花多少时间；热缓存又能省多少。[`lab/ch20/ci_times_host.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/ci_times_host.sh) 就是为这个写的，50 行，只读，不改 GitHub 上的任何东西：

```bash
  gh run view "${id}" -R "${REPO}" --json jobs \
    | jq --raw-output --arg label "${label}" '.jobs[]
      | "volatile: \($label) \(.name): \(
          (.completedAt | fromdate) - (.startedAt | fromdate)) s (\(.conclusion))"'
```

这是 `print_jobs` 函数的主体（L25 到 L28）：对一次运行，列出它的每个 job，用 `completedAt` 减 `startedAt` 得到秒数。`main` 先用 `gh run list --workflow ci.yml --status success --limit 100` 取最近 100 次成功的运行，按 `createdAt` 排序，其中最早的一次叫 `first`，最近的一次叫 `latest`，各打印一遍。注意 `first` 是“最近 100 次成功运行里最早的一次”，不一定是仓库里的第一次运行。脚本有三种输出，由 GitHub 上的状态决定：

- `ci.yml` 还不在默认分支上，`gh` 回 HTTP 404，脚本把 `gh` 的话原样带上，打印 `no ci.yml run to read: ...`，退出码 0。
- `ci.yml` 在，但没有成功的运行：打印 `no successful ci.yml run yet`，退出码 0。
- 有成功的运行：对 `first` 和 `latest` 各打印两行，形如 `volatile: first check (upstream): <秒数> s (success)`，共 4 行。

第一种我只在 `ci.yml` 推到 GitHub 之前见过，这里不再展示它的输出。2026-11-09 我再跑这个脚本（`bash lab/ch20/ci_times_host.sh`，脚本不是可执行文件，`scripts/chapter.sh` 也是这样用 `bash` 运行它的），stdout 是：

（输出里的 `first` 对应运行 42518905677，`latest` 对应运行 42552279806；以后有更新的成功运行，这几行就会变。）

```text
volatile: first check (determinate): 994 s (success)
volatile: first check (upstream): 984 s (success)
volatile: latest check (upstream): 792 s (success)
volatile: latest check (determinate): 648 s (success)
```

这四个数字都是单次样本。`first` 是运行 42518905677（那时 Cachix 的推送是关着的，原因在“推上去之后 CI 红了四次”一节），可以当作冷缓存：upstream 984 秒（16 分 24 秒），determinate 994 秒（16 分 34 秒），determinate 慢 10 秒。`latest` 是运行 42552279806，那时 Cachix 已经有内容：upstream 792 秒，determinate 648 秒，determinate 快 144 秒；两条线都比各自的冷缓存短，upstream 短 192 秒，determinate 短 346 秒。装 Nix 的那一步本身只有 3 到 7 秒（我读到的两次运行里 upstream 3 秒和 4 秒，determinate 6 秒和 7 秒），所以两条线的差距在 `nix develop --command make ci` 这一步里：绿色运行 42551121824 里是 12 分 03 秒对 9 分 32 秒，42552279806 里是 12 分 57 秒对 10 分 25 秒。为什么 determinate 在热缓存下快 2 分半钟，我不知道；runner 上两条线用的 Nix 版本不同（upstream 那条是 2.35.4，determinate 那条是 3.24.2），我也没有拆开看每个检查各花多少，所以我不把它写成“Determinate 更快”。

读这 4 行数字要小心两件事。`first` 是“最近 100 次成功运行里最早的一次”，不一定是仓库里的第一次运行：这里它碰巧是没有推送的那一次，所以接近冷缓存。第二，`latest` 里的“热”指的是缓存命中，不等于什么都没做：虚拟机测试这类 derivation 的输出一旦在缓存里就不会重跑，但 `lab/` 下的每个实验仍然要重新跑一遍，它们不是 derivation。热缓存只把运行从 16 分多钟缩到 10 到 13 分钟，说明时间的大头不在“要不要构建”。

## 二进制缓存：一个目录加几个文件

Nix 的二进制缓存没有任何魔法，它是一个 HTTP 服务器（或者一个目录）上的三类文件：`nix-cache-info` 描述这个缓存本身，每个 store 路径一个 `<32 位哈希>.narinfo` 描述这个路径，`nar/` 目录里是路径内容的归档 (NAR)，通常压缩过。Nix 要找一个路径，就拿它的哈希部分去请求 `<hash>.narinfo`，有就读，没有 (404) 就问下一个缓存。我把它比作图书馆之间的馆际互借：narinfo 是馆藏卡片，写着书名、页数和它引用了哪些别的书；NAR 是书本身；签名是馆长在卡片上盖的章，我只借我认得章的馆里的书。这个比喻我就用这一次，接着回到文件。

### narinfo 的每一行

[`lab/ch20/narinfo_anatomy.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/narinfo_anatomy.sh) 取锁定的 nixpkgs 里 `hello` 的 store 路径，把它的哈希部分拼成 URL，向 `cache.nixos.org` 要它的 narinfo（核心是 L14 到 L18）：

```bash
  out="$(nix eval --raw --file "${FIRN_ROOT}/nix/pkgs.nix" hello.outPath)"
  hash="$(basename "${out}" | cut -c1-32)"
  echo "GET https://cache.nixos.org/${hash}.narinfo"
  curl --silent --show-error --fail "https://cache.nixos.org/${hash}.narinfo" \
    | sed -e 's|^Sig: .*|Sig: <base64 ed25519 signature by cache.nixos.org-1>|'
```

`sed` 把每次都一样但很长的签名换成了说明文字，其余原样：

```text
GET https://cache.nixos.org/lcxc2z1h2g8wq8dxfpizy1di85kyxnqx.narinfo
StorePath: /nix/store/lcxc2z1h2g8wq8dxfpizy1di85kyxnqx-hello-2.12.3
URL: nar/1n71v0lypd23hmqq1zbhzcd9v49r8g6n2f0hsyfv99pkgmajraw2.nar.zst
Compression: zstd
FileHash: sha256:12w6fp8y5haw9w1wznyfrk884ldm85ccf6b40psiih0yzg8a4l58
FileSize: 75355
NarHash: sha256:1n71v0lypd23hmqq1zbhzcd9v49r8g6n2f0hsyfv99pkgmajraw2
NarSize: 279624
References: 0d8g8n0a11v6f5m2h416ajyxmnkwc3md-glibc-2.42-67 lcxc2z1h2g8wq8dxfpizy1di85kyxnqx-hello-2.12.3
Deriver: a41gq8gxdhd2haqk5ij6ak4ybwmignrp-hello-2.12.3.drv
Sig: <base64 ed25519 signature by cache.nixos.org-1>
```

逐行读：`StorePath` 是完整路径，文件名里的 32 位哈希就是请求用的那一段。`URL`、`Compression`、`FileHash`、`FileSize` 说的是缓存里那个文件：`nar/…nar.zst`，zstd 压缩，75,355 字节。`NarHash` 和 `NarSize` 说的是解压之后的 NAR：279,624 字节，所以 zstd 把它压到了原来的 26.9%（压缩比 3.71）。`References` 是这个路径引用的其他 store 路径，`hello` 引用 glibc，也引用它自己（自引用也算）。`Deriver` 是产生它的 `.drv`，只是提示，不参与信任。最后一行 `Sig` 是签名。

有一处我没想到：`URL` 里那个 52 个字符的名字和 `NarHash` 的值是同一个，不是 `FileHash`。也就是说 `cache.nixos.org` 是用未压缩 NAR 的哈希给压缩文件起名的。在“自己做一个缓存”一节里，`nix copy` 用的是另一种命名，这个差别没有任何功能上的影响，因为 `URL` 是 narinfo 自己写明的，不是客户端推出来的。

### 自己做一个缓存

[`lab/ch20/local_cache.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/local_cache.sh) 用 `file://` 做了一个完整的缓存，没有任何服务器。它借用 [`lab/ch20/fixtures/make_cache.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/fixtures/make_cache.sh) 里的 `make_cache`（L19 到 L31）：

```bash
make_cache() {
  local query="${1:-}"
  FIRN_HELLO="$(nix build --no-link --print-out-paths "${FIRN_ROOT}#firn-hello")"
  CACHE_URL="file://${LAB_TMP}/cache${query:+?${query}}"

  nix key generate-secret --key-name firn-lab-1 >"${LAB_TMP}/secret.key"
  # shellcheck disable=SC2034 # read by the scripts that source this file
  PUBLIC_KEY="$(nix key convert-secret-to-public <"${LAB_TMP}/secret.key")"

  nix copy --to "${CACHE_URL}" "${FIRN_HELLO}"
  nix store sign --store "${CACHE_URL}" --key-file "${LAB_TMP}/secret.key" \
    --recursive "${FIRN_HELLO}"
}
```

几步：造一对密钥（名字 `firn-lab-1`，名字会写进签名里，让客户端知道该用哪把公钥验证），把 `firn-hello` 连同它的闭包复制进缓存目录，再用私钥给缓存里每个路径签名。`local_cache.sh` 接着打印 `firn-hello` 的 narinfo，数缓存里有几个文件，最后从这个缓存把路径复制进一个空 store，并且只信任这把实验用的公钥。输出（`volatile:` 开头的两行每次运行都会变）：

```text
key name: firn-lab-1
volatile: public key firn-lab-1:Rf5PUhT0nlES35fpuWrPguApYWyYYzRvlPkchhBgr1w=
== w1z9af0553h913s05hwkvd8k2klzwas4.narinfo
StorePath: /nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0
URL: nar/140w6sh87kb2k4hjln7rriw2xy9mjxnv6v9mzgb78w574nn7kbj2.nar.xz
Compression: xz
FileHash: sha256:140w6sh87kb2k4hjln7rriw2xy9mjxnv6v9mzgb78w574nn7kbj2
FileSize: 2588
NarHash: sha256:1qkzwynk63zvy4i4xx541mygpsm3z42lfc48jzprf6hb8hqj7hnz
NarSize: 16488
References: 0d8g8n0a11v6f5m2h416ajyxmnkwc3md-glibc-2.42-67 zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb-zlib-1.3.2
Deriver: w6jvcgdyiw4y3s5qy1js0s9badz66x36-firn-hello-0.1.0.drv
volatile: Sig: firn-lab-1:g5KpsJbooD/Qxr+535D1BKWIuwkNIR86SEWw1xgz6zTl9G4YAZbk8LESuGyn6bFMYPNwZIxh/VQPG96DZF5hDQ==
== files in the cache
narinfo files: 6
nar files: 6
0d8g8n0a11v6f5m2h416ajyxmnkwc3md.narinfo
h5yzhyi8j6iq4r26giryd0rh9ynsayan.narinfo
kpcd405yxfc3pfv8x4mv5j3fj54v946p.narinfo
log
nar
nix-cache-info
realisations
v4zcvckzr9hqpg1f6bmkbf2q7fmszzvk.narinfo
w1z9af0553h913s05hwkvd8k2klzwas4.narinfo
zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb.narinfo
/nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0
copy with the lab key trusted: ok
```

和 `hello` 那份对一下：这里 xz 把 16,488 字节的 NAR 压到了 2,588 字节，6.37 倍；`URL` 的名字这次是 `FileHash`（`140w6sh8…`），不是 `NarHash`，这就是刚才说的命名差别。`firn-hello` 的闭包是 6 个路径（第 10 篇数过），缓存里就有 6 个 narinfo 和 6 个 NAR；`log`、`realisations` 在我这里是空目录，`nix-cache-info` 是缓存自己的描述。一个“缓存服务器”最少就是这些，把这个目录放到任何能提供静态文件的地方（比如 `python3 -m http.server`，我没有试）它就是一个 HTTP 缓存，这也是“缓存的替代品”一节里最便宜的那一格。

### 签名签的是什么

同一个缓存，同一个签名，换一条命令：不信任实验用的公钥。[`lab/ch20/unsigned_copy_fail.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/unsigned_copy_fail.sh) 只比上一个脚本少了 `--option trusted-public-keys`：

```bash
  make_cache
  # The failing command: its exit status is the lab's.
  nix copy --from "${CACHE_URL}" --to "${LAB_TMP}/store" "${FIRN_HELLO}"
```

按 `*_fail` 的约定，它必须以非零状态结束，`make ch20` 才算它通过。它的 stderr 末尾是（临时目录名 `firn-lab.cMeSI6` 每次运行都不同）：

```text
copying path '/nix/store/zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb-zlib-1.3.2' from 'file:///tmp/nix-shell.md9oEg/firn-lab.cMeSI6/cache'...
error: cannot add path '/nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0' because it lacks a signature by a trusted key
```

注意失败的是 `firn-hello` 本身，同一次复制里排在它之前的五个依赖都成功了。原因不在 `unsigned_copy_fail.stderr` 里，是我另外用 `nix path-info --sigs` 看出来的：`firn-hello` 是我在本地构建的，它在本机 store 里的签名栏是 `ultimate`，进缓存之后唯一的签名是 `firn-lab-1`，不在信任列表里；`zlib` 这样的依赖来自 `cache.nixos.org`，身上带着 `cache.nixos.org-1` 的签名，那把公钥在默认的 `trusted-public-keys` 里。同一个缓存里，一部分路径被接受，一部分被拒绝，规则是逐个路径看的。

```text
$ nix path-info --sigs /nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0
/nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0	ultimate
$ nix path-info --sigs /nix/store/zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb-zlib-1.3.2 | cut -c1-120
/nix/store/zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb-zlib-1.3.2	cache.nixos.org-1:Hzqvms5imfhmm2eDXI3A6W5H7xTIVs6Ve1wGmhcEuvBul5FM2VwC9LSFAp+nH3Kl3qk
```

（手敲，不在 `lab/ch20/` 里）

Nix 2.34 手册对 `require-sigs` 的说法是：默认 `true` 时，“any non-content-addressed path added or copied to the Nix store (e.g. when substituting from a binary cache) must have a signature by a trusted key.” 对 `trusted-public-keys`，手册列了四个条件，满足任何一个，Nix 就接受从另一个 store 复制来的对象：它用信任列表里的某把密钥签过名；`require-sigs` 设成了 `false`；该 store 的 URL 带 `trusted=true`；或者它是内容寻址的（[手册：`trusted-public-keys`](https://nix.dev/manual/nix/2.34/command-ref/conf-file#conf-trusted-public-keys)）。

签名到底覆盖什么，读 Nix 2.34.9 的源码就知道。[`ValidPathInfo::fingerprint`](https://github.com/NixOS/nix/blob/2.34.9/src/libstore/path-info.cc#L43-L50) 的返回值是：

```cpp
    return "1;" + store.printStorePath(path) + ";" + narHash.to_string(HashFormat::Nix32, true) + ";"
           + std::to_string(narSize) + ";" + concatStringsSep(",", store.printStorePathSet(references));
```

签名签的就是这个字符串：版本号 `1`、完整的 store 路径、NAR 的哈希、NAR 的大小、引用的路径。它不含 `URL`、`Compression`、`FileHash`，也不含 `Deriver`。检查发生在 [`LocalStore::addToStore`](https://github.com/NixOS/nix/blob/2.34.9/src/libstore/local-store.cc#L987-L988)：`if (checkSigs && pathInfoIsUntrusted(info)) throw Error("cannot add path '%s' because it lacks a signature by a trusted key", ...)`，这就是那行错误的出处。

这个设计的后果是缓存服务器不需要被信任：它能换压缩算法，能换文件名，但换不了内容，因为内容的哈希在签名里。[`lab/ch20/ex_bad_signature.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/ex_bad_signature.sh) 把它做成了实验（练习 1 的答案，细节在“练习”一节）：把缓存里一个 NAR 的一个字节改掉，签名依然有效，复制照样失败，只是错误变成了：

```text
error: hash mismatch importing path '/nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0';
         specified: sha256:1qkzwynk63zvy4i4xx541mygpsm3z42lfc48jzprf6hb8hqj7hnz
         got:       sha256:04ab7wl0lvqd0j3z4lkqcs20xm9x2fsj0wj2nfhhsqw11dxspxv6
```

`specified` 是 narinfo 里签过名的 `NarHash`，`got` 是客户端读到的字节算出来的哈希。

### substituters、trusted-substituters 和 trusted-users

信任有两层，容易混。一层是“这个缓存的东西我信不信”，由 `trusted-public-keys` 决定，“签名签的是什么”一节已经演示了。另一层是“谁有权让守护进程去问这个缓存”，由 `substituters`、`trusted-substituters` 和 `trusted-users` 决定。手册对 `substituters` 的说法是，要使用一个缓存，至少满足两个条件之一：它在 `trusted-substituters` 里，或者调用 Nix 的用户在 `trusted-users` 里；除此之外每个 store 路径还要按 `trusted-public-keys` 受信任。`trusted-substituters` 是给普通用户的白名单：只在 `allowed-users` 里、不在 `trusted-users` 里的用户，只能在 `substituters` 里放它列出的那些地址。

`trusted-users` 的手册条目自带一个警告，我原样抄在这里，因为它决定了这一节剩下的所有东西：“Adding a user to `trusted-users` is essentially equivalent to giving that user root access to the system. For example, the user can access or replace store path contents that are critical for system security.” 这台机器的配置是：

```text
$ nix config show | grep -E '^(substituters|trusted-substituters|trusted-users|require-sigs|accept-flake-config) '
accept-flake-config = false
require-sigs = true
substituters = https://mirror.sjtu.edu.cn/nix-channels/store https://mirrors.tuna.tsinghua.edu.cn/nix-channels/store https://mirrors.ustc.edu.cn/nix-channels/store https://cache.nixos.org https://cache.nixos.org/ https://nix-community.cachix.org https://cache.flakehub.com/
trusted-substituters = 
trusted-users = root bfmhno3
$ nix config show trusted-public-keys | wc -w
10
```

（手敲，不在 `lab/ch20/` 里）

`trusted-users` 里有我自己，按手册，我可以在命令行上自己指定 `substituters`；`trusted-substituters` 是空的，意味着一个普通用户什么缓存也不能自己加。`require-sigs` 没动过。`accept-flake-config = false` 是“nixConfig 与 accept-flake-config”一节要讲的。`substituters` 里除了 `cache.nixos.org` 还有三个国内镜像、`nix-community.cachix.org` 和第 19 篇见过的 `cache.flakehub.com`；`cache.nixos.org` 出现了两次（有和没有结尾的斜杠），这是我这台机器配置的一个小瑕疵，我没有去动它。

顺序由优先级决定。每个缓存在自己的 `nix-cache-info` 里写着 `Priority`，手册说数值小的优先。我查了官方缓存、SJTU 镜像和 Firn 的 Cachix (2026-11-08)：

```text
$ for u in https://cache.nixos.org https://mirror.sjtu.edu.cn/nix-channels/store https://bfmhno3-firn.cachix.org; do echo "== $u"; curl -sS --max-time 20 "$u/nix-cache-info"; done
== https://cache.nixos.org
StoreDir: /nix/store
WantMassQuery: 1
Priority: 40
== https://mirror.sjtu.edu.cn/nix-channels/store
StoreDir: /nix/store
WantMassQuery: 1
Priority: 40
== https://bfmhno3-firn.cachix.org
StoreDir: /nix/store
WantMassQuery: 1
Priority: 41
```

（手敲，不在 `lab/ch20/` 里；TUNA 和 USTC 同样是 `Priority: 40`，我这里为了短省略了）

镜像和官方缓存同为 40，Cachix 是 41，所以它排在最后。这一点我用 `-vvv` 在一个空 store 里查 `firn-hello` 验证了一遍，对比有没有 `--accept-flake-config`（`S` 是 `mktemp -d` 出来的空 store）：

```text
$ nix build --store "$S" --dry-run -vvv .#firn-hello 2>&1 | grep -E "checking substituter .* for path '[^']*-firn-hello-0.1.0'" | sed 's|/nix/store/[a-z0-9]\{32\}-|…-|'
checking substituter 'https://cache.flakehub.com' for path '…-firn-hello-0.1.0'
checking substituter 'https://mirror.sjtu.edu.cn/nix-channels/store' for path '…-firn-hello-0.1.0'
checking substituter 'https://mirrors.tuna.tsinghua.edu.cn/nix-channels/store' for path '…-firn-hello-0.1.0'
checking substituter 'https://mirrors.ustc.edu.cn/nix-channels/store' for path '…-firn-hello-0.1.0'
checking substituter 'https://cache.nixos.org' for path '…-firn-hello-0.1.0'
checking substituter 'https://cache.nixos.org' for path '…-firn-hello-0.1.0'
checking substituter 'https://nix-community.cachix.org' for path '…-firn-hello-0.1.0'
$ nix build --store "$S" --accept-flake-config --dry-run -vvv .#firn-hello 2>&1 | grep -E "checking substituter .* for path '[^']*-firn-hello-0.1.0'" | sed 's|/nix/store/[a-z0-9]\{32\}-|…-|'
checking substituter 'https://cache.flakehub.com' for path '…-firn-hello-0.1.0'
checking substituter 'https://mirror.sjtu.edu.cn/nix-channels/store' for path '…-firn-hello-0.1.0'
checking substituter 'https://mirrors.tuna.tsinghua.edu.cn/nix-channels/store' for path '…-firn-hello-0.1.0'
checking substituter 'https://mirrors.ustc.edu.cn/nix-channels/store' for path '…-firn-hello-0.1.0'
checking substituter 'https://cache.nixos.org' for path '…-firn-hello-0.1.0'
checking substituter 'https://cache.nixos.org' for path '…-firn-hello-0.1.0'
checking substituter 'https://nix-community.cachix.org' for path '…-firn-hello-0.1.0'
checking substituter 'https://bfmhno3-firn.cachix.org' for path '…-firn-hello-0.1.0'
```

（手敲，不在 `lab/ch20/` 里）

第二组比第一组多了最后一行，`bfmhno3-firn.cachix.org`，排在所有优先级为 40 的缓存之后。（`cache.flakehub.com` 排在第一位，我没弄明白为什么：它在配置里是最后一个，而它的 `nix-cache-info` 我读不了，请求回的是一句 `Unauthorized.`，所以不知道它声明的优先级。这是我没有追下去的一个疑问。）

镜像的延迟在“镜像”一节里量。

## 镜像：这台机器上的三个，加官方的

第 1 篇读 `nix.conf` 的时候我答应过，三个国内镜像放到第 20 篇再量。[`lab/ch20/mirrors_host.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/mirrors_host.sh) 对 SJTU、TUNA、USTC 和 `cache.nixos.org` 各发两个只读的 GET：缓存的 `nix-cache-info`，和锁定 nixpkgs 里 `hello` 的 narinfo。每个 URL 先发一次不计时的请求（把 TLS 握手排除），再发 5 次，用 `curl -w '%{time_total}'` 计时，取中位数。它不下载任何 store 路径。一次运行的输出（`make ch20`，2026-11-08）：

```text
volatile: sjtu nix-cache-info median of 5: 431 ms (HTTP 200)
volatile: sjtu hello.narinfo median of 5: 144 ms (HTTP 200)
volatile: tuna nix-cache-info median of 5: 79 ms (HTTP 200)
volatile: tuna hello.narinfo median of 5: 84 ms (HTTP 404)
volatile: ustc nix-cache-info median of 5: 264 ms (HTTP 200)
volatile: ustc hello.narinfo median of 5: 153 ms (HTTP 200)
volatile: cache.nixos.org nix-cache-info median of 5: 1386 ms (HTTP 200)
volatile: cache.nixos.org hello.narinfo median of 5: 1379 ms (HTTP 200)
```

这是一台机器、一个时间点、各 5 个样本的结果，我不会拿它排名。几件事值得记：

- 取 `hello` 的 narinfo，`cache.nixos.org` 的中位数是 1379 ms，SJTU 是 144 ms，USTC 是 153 ms，差了 9.6 倍。这大概就是这台机器把三个镜像排在官方缓存之前的原因。
- TUNA 对 `hello` 的 narinfo 回的是 404，用了 84 ms。404 的意思是这个缓存里没有这个路径，Nix 会当作“没有”，转去问列表里的下一个缓存。TUNA 的帮助页 (2026-11-08) 只讲了 Nix 的安装，没有提到 `nix-channels/store`，所以我不知道它打算覆盖哪些路径，也不知道别的路径在它那里是不是同样 404。USTC 的帮助页写着“Binary cache 为动态缓存”，还特地说明：下载新文件时可能出现 `file '…nar.xz' does not exist in binary cache` 之类的错误，“忽略即可，Nix 会自动回退”。我没有读 SJTU 的帮助页，不对它的机制下判断。
- 同一个镜像上，`nix-cache-info` 不一定比 narinfo 快：SJTU 是 431 ms 对 144 ms，反过来的。我没有深究，猜测是不同路径落在不同的缓存层上，这只是猜测。
- 这些镜像的 `Priority` 都是 40，和官方缓存一样（“substituters、trusted-substituters 和 trusted-users”一节查过），所以实际的尝试顺序就是 `substituters` 里写的顺序。`repro_fail.sh` 的 stderr 里有一个旁证：它构建 `mini.nondeterministic` 需要的 `busybox-static`，是从 SJTU 取的：`copying path '/nix/store/8mid8wh1kxb0gl4g6s9l3bwawd9xzfkj-busybox-static-x86_64-unknown-linux-musl-1.37.0' from 'https://mirror.sjtu.edu.cn/nix-channels/store'...`。
- 快不等于稳。写这一篇的这一天，我有几次让 `nix build --store` 对一个空 store 取东西，构建停在一个下载上不动；有一次我用 `ss -tnp` 看了，那条停住的连接通向 SJTU 的 `111.186.58.212`。`nix config show stalled-download-timeout` 是 300，也就是 Nix 要等 5 分钟才会放弃一个停滞的下载。同样的命令重跑又好了，这和开头那组 230.42 秒对 32.01 秒的差距是一致的。我猜是线路或镜像的抖动，没有证据。

## Cachix：推、令牌和公钥

镜像只能拉官方缓存里已经有的东西。Firn 自己构建出来的东西（`pebble` 在第 11 篇冷构建要 253.4 秒），想让 CI 和读者都不重新构建，就得有一个自己的缓存。我用的是 [Cachix](https://docs.cachix.org/getting-started)。它的文档把流程讲成三步。第一步，登录 Cachix 网站，创建一个缓存（名字会出现在 Nix 配置里，“visible to anyone using it”）；第二步，认证，令牌有两种：个人的（“full access to your account”）和 per-cache 的（只对某一个缓存有读或写权限），可以用 `cachix authtoken` 或环境变量 `CACHIX_AUTH_TOKEN` 设置；第三步，推，`nix-build | cachix push mycache`，或者在 CI 里用 cachix-action。读的一边是 `cachix use mycache`，它会改 Nix 的配置。

签名那一步文档默认替你做：“By default, Cachix will manage the entire signing process for you.” 想自己持有私钥要用 `cachix generate-keypair`，文档明确把这归为 “Signing key (advanced)”。`bfmhno3-firn` 用的是默认，所以私钥在 Cachix 那边，我这里只有公钥。公钥不是秘密，Cachix 的 API 直接给出 (2026-11-08)：

```text
$ curl -s https://bfmhno3-firn.cachix.org/api/v1/cache/bfmhno3-firn | jq -c '{name,isPublic,publicSigningKeys}'
{"name":"bfmhno3-firn","isPublic":true,"publicSigningKeys":["bfmhno3-firn.cachix.org-1:LqoBOb9Jvs/LrrTa/CxBwJG14boQsOkdBEABj+M3GBI="]}
```

（手敲，不在 `lab/ch20/` 里）

这个字符串就是 `flake.nix` L9 里的那个，以及 `cachix_hit_host.sh` 里的 `CACHE_KEY`。

要把“信任这把公钥”想清楚。第 6 篇说过，store 路径的哈希来自输入，不来自内容，所以 Nix 无法在拿到一个输入寻址的路径之后，凭内容去验证“这真的是那个 derivation 的输出”。能验证的只有签名。这意味着你把某把公钥加进 `trusted-public-keys`，就是在说：持有对应私钥的人，替我保证他给我的那个路径的内容是对的。对 Cachix 来说，那个人是 Cachix（加上有写权限令牌的人，令牌能让别人往缓存里推东西，推上去的东西会被它签名）。这是我读“签名签的是什么”一节引的手册条件得出来的推论，不是手册里的一句话。

[`lab/ch20/cachix_hit_host.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/cachix_hit_host.sh) 检验的是缓存有没有真的被 CI 填上：

```bash
  out="$(nix eval --raw "${FIRN_ROOT}#pebble.outPath")"
  echo "pebble: ${out}"
  if ! nix path-info --store "${CACHE}" "${out}"; then
    echo "cachix: MISS (CI has not pushed this path yet)"
    return 0
  fi
  echo "cachix: HIT"
```

（L21 到 L27）`nix path-info --store https://bfmhno3-firn.cachix.org <路径>` 只读，成功时会把路径本身打印出来。命中的话脚本接着在 `${LAB_TMP}/s` 这个空 store 里，只给 `substituters` 配 Cachix 和 `cache.nixos.org`、只信任这两把公钥，构建 `pebble` 并计时（L29 到 L38）。未命中时输出是 2 行，第二行是 `cachix: MISS (CI has not pushed this path yet)`；命中时是 6 行，依次是 `pebble: <路径>`、`path-info` 打印的路径、`cachix: HIT`、`volatile: substituted into a fresh store in <N> ms`、`volatile: cold build recorded in chapter 11: 253.4 s`，最后又是路径。

CI 往 Cachix 推过之后，我在这台机器上跑它（同样是 `bash lab/ch20/cachix_hit_host.sh`），stdout 是：

```text
pebble: /nix/store/psn4fsd8a5nsm1ki35bwy8q39w5br1b7-pebble-0.1.0
/nix/store/psn4fsd8a5nsm1ki35bwy8q39w5br1b7-pebble-0.1.0
cachix: HIT
volatile: substituted into a fresh store in 20389 ms
volatile: cold build recorded in chapter 11: 253.4 s
/nix/store/psn4fsd8a5nsm1ki35bwy8q39w5br1b7-pebble-0.1.0
```

（取的是 `cachix_hit_host.sh` 的 stdout，不是 stderr。）

“用缓存值多少”我在这台机器上自己量了一组，和 CI 无关，但能说明数量级。我用 `file://` 缓存代替 Cachix（缓存的结构一样，只是在网络的另一头），同一个 `firn-hello`，本篇开头那几行计时是这样得来的：

```text
$ D=/tmp/s20/cmp
$ H="$(nix build --no-link --print-out-paths .#firn-hello 2>/dev/null)"
$ nix key generate-secret --key-name firn-lab-2 >"$D/sec"
$ K="$(nix key convert-secret-to-public <"$D/sec")"
$ nix copy --to "file://$D/cache" "$H" 2>/dev/null
$ nix store sign --store "file://$D/cache" --key-file "$D/sec" --recursive "$H" 2>/dev/null
$ du -sh "$D/cache" | cut -f1
7.7M
$ S=/tmp/s20/cold
$ du -sh "$S/nix/store" | cut -f1
896M
$ nix path-info --store "$S" -r .#firn-hello 2>/dev/null | wc -l
6
```

（手敲，不在 `lab/ch20/` 里；`$S` 是开头那次冷构建用的空 store，`$K` 是 `firn-lab-2` 的公钥）

把结果摆成一张表，每个数字都是单次样本，不是均值：

| 做法 | 墙钟 |
| --- | --- |
| 空 store 里构建 `firn-hello`（`nix build --store "$S"`） | 32.01 s；同一条命令的另外两次：230.42 s，和一次停住后被我杀掉（5 分钟以上） |
| 空 store 里从签过名的 `file://` 缓存复制 | 0.35 s |
| 已经构建过的 store 里 `nix build --rebuild` | 0.36 s |

要读懂的是那个 896M：空 store 里的构建，要先把 gcc、glibc 这些工具链取来，而 `firn-hello` 的运行时闭包只有 6 个路径，压成缓存只有 7.7M。对这样的小包，缓存省下的主要是工具链的下载，不是编译；编译时间占主导的是 `pebble` 这一类，`cachix_hit_host.sh` 要量的是后者。

## 缓存的替代品

Cachix 是我选的，不是唯一的选择。这张表是我读各家 README 和文档整理的，右边“我碰过吗”那一列说的是在这个系列里：

| 方案 | 它是什么 | 谁签名、怎么推 | 我碰过吗 |
| --- | --- | --- | --- |
| 本地目录或静态文件服务器 (`file://`、`http://`) | “自己做一个缓存”一节的那个目录；放到任何静态文件服务器之后就是 HTTP 缓存 | 自己用 `nix key` 造密钥，`nix store sign` 签，`nix copy --to` 推 | 是，`local_cache.sh` 全程 |
| S3 或兼容的对象存储 (`s3://`) | Nix 内置的 store 类型，[手册](https://nix.dev/manual/nix/2.34/store/types/s3-binary-cache-store)里有认证和 `secret-key` 等设置 | 自己的密钥，`nix copy --to 's3://bucket?…'` | 没有，只读了手册 |
| [nix-serve-ng](https://github.com/aristanetworks/nix-serve-ng) | 把一台机器的本地 store 作为 HTTP 缓存暴露出来，README 自称 `nix-serve` 的 “faster, more reliable, drop-in replacement” | 服务这台机器 store 里已有的路径；签名怎么配 README 没写，我没有查 | 没有 |
| [Attic](https://github.com/zhaofengli/attic) | 自托管、可挂 S3 兼容存储的多租户缓存服务器，有全局去重和 LRU 垃圾回收 | 服务器在取路径时即时签名，推送的人不接触私钥 | 没有 |
| [Cachix](https://docs.cachix.org/) | 托管服务，公开和私有缓存 | 默认由 Cachix 签名，用令牌推，`cachix use` 读 | 是，这一篇的 CI |
| [FlakeHub Cache](https://docs.determinate.systems/flakehub/cache/) | Determinate 的缓存，只在[付费方案](https://flakehub.com/pricing)里提供 | 只允许受信任的构建者（GitHub Actions、GitLab CI/CD、Semaphore、Buildkite）推，用 JWT 认证，不用公钥，读权限按 flake 控制 | 没有，第 19 篇只描述 |

表里的话我逐条核对了来源 (2026-11-08 查)。有几处要补：Attic 的 README 第一段说它是 “a self-hostable Nix Binary Cache server backed by an S3-compatible storage provider”，同一段里还写着 “Attic is an early prototype”，选它要把这句话读进去。nix-serve-ng 的 README 里有一组基准，在一台 24 核的服务器上，取 10 个已存在的 narinfo，`nix-serve` 是 2.09 ms，nix-serve-ng 是 1.32 ms，传 10 次 10 MB 的 NAR 是 291 ms 对 86.9 ms，那是它们的机器和它们的测试，不是我的，我没有量。FlakeHub Cache 的文档强调的区别是：基于 nix-serve 的方案把整个 store 当成一个缓存、“make all store paths in that cache available to anyone with a public key”，而它能按 flake 授予或拒绝读权限；代价是“forbids pushing to the cache in an ad-hoc way”，不能从笔记本上推。这一行里的价格我没有查。

## nixConfig 与 accept-flake-config

Firn 的 `flake.nix` 开头新加了一段，L4 到 L11：

```nix
  # 第 20 章：CI 推送到的公开 Cachix 缓存。nixConfig 里的设置要经过
  # accept-flake-config（或交互确认）才生效，见第 20 章。
  nixConfig = {
    extra-substituters = [ "https://bfmhno3-firn.cachix.org" ];
    extra-trusted-public-keys = [
      "bfmhno3-firn.cachix.org-1:LqoBOb9Jvs/LrrTa/CxBwJG14boQsOkdBEABj+M3GBI="
    ];
  };
```

意图很简单：读者 clone 仓库，`nix build .#pebble`，Nix 自动去 Cachix 找。但 Nix 对一个 flake 要改自己的配置非常谨慎。读者看到的是这个：

```text
$ nix eval --raw .#packages.x86_64-linux.firn-hello.name
warning: ignoring untrusted flake configuration setting 'extra-substituters'.
Pass '--accept-flake-config' to trust it
warning: ignoring untrusted flake configuration setting 'extra-trusted-public-keys'.
Pass '--accept-flake-config' to trust it
firn-hello-0.1.0
```

（手敲，不在 `lab/ch20/` 里；输出里的前 4 行在 stderr，最后一行在 stdout）

这两条警告会在这个仓库里每一条 `nix` 命令上出现，`make ch20` 的每个实验的 stderr 里都有它们，我在第 20 篇之前的输出里没有见过。手册对 `accept-flake-config` 的描述只有一句：“Whether to accept Nix configuration settings from a flake without prompting.” 默认 `false`。

逻辑在 Nix 2.34.9 的 [`src/libflake/config.cc`](https://github.com/NixOS/nix/blob/2.34.9/src/libflake/config.cc#L55-L123) 里，`ConfigFile::apply`。它先有一个白名单（L57 到 L63）：

```cpp
    StringSet whitelist{
        "bash-prompt",
        "bash-prompt-prefix",
        "bash-prompt-suffix",
        "flake-registry",
        "commit-lock-file-summary",
        "commit-lockfile-summary"};
```

名字（去掉 `extra-` 前缀之后）在白名单里的设置，直接应用；不在白名单里、`accept-flake-config` 又是 `false` 的设置，要么读 `~/.local/share/nix/trusted-settings.json` 里以前存下的答案，要么交互地问 “do you want to allow configuration setting '%s' to be set to '%s' (y/N)?”，再问要不要永久记住；非交互时答案是 `n`，于是就是本节开头那条 `ignoring untrusted flake configuration setting`。我写了一个一次性的 flake，三个设置，一个在白名单里，两个不在：

```text
$ cat /tmp/s20/nc/flake.nix
{
  nixConfig = {
    bash-prompt = "[nc] ";
    extra-substituters = [ "https://example.invalid" ];
    sandbox = false;
  };
  outputs = _: { x = 1; };
}
$ nix eval path:/tmp/s20/nc#x
warning: ignoring untrusted flake configuration setting 'extra-substituters'.
Pass '--accept-flake-config' to trust it
warning: ignoring untrusted flake configuration setting 'sandbox'.
Pass '--accept-flake-config' to trust it
1
```

（手敲，不在 `lab/ch20/` 里）

`bash-prompt` 没有警告，另外两个有，包括 `sandbox = false`：一个 flake 想要关掉构建沙箱，Nix 没有顺从它。这就是 `accept-flake-config` 要保护的东西。设想一个陌生仓库的 `flake.nix` 写着 `extra-substituters` 加上它自己的 `extra-trusted-public-keys`：只要你加了 `--accept-flake-config`（或者在提示里按了 `y`，并且选了“永久记住”），你的 Nix 从此就信任一把由陌生人持有的密钥，而“Cachix：推、令牌和公钥”一节说过，这等于让他保证你的 store 里路径的内容。如果你还是 `trusted-users` 里的人，按手册，守护进程会接受你指定的 `substituters`。所以我自己的做法是：对不熟悉的 flake 永远不用 `--accept-flake-config`，也不在提示里选永久记住。

对 Firn 自己，它的作用是给读者一个选项：想用我的缓存，加 `--accept-flake-config`；不想，就当没看见那两行警告，Nix 会用你自己的 `substituters`。CI 里不需要它，因为 cachix-action 直接配置了缓存和密钥。至于 CI 日志里是否同样会有这两条警告，我没有观察到，推测是会有的，因为两个安装器都没有设置 `accept-flake-config`。

## 格式化：nixfmt 和 RFC 166 的来历

第 1 篇起，每个 Nix 块我都说“`nixfmt --check` 不打印任何东西”，却没有说过 `nixfmt` 从哪里来。来历有出处可查。`NixOS/rfcs` 的 [RFC 166 “Nix formatting, take two”](https://github.com/NixOS/rfcs/pull/166) 由 piegames 在 2023-11-15 开出，PR 的描述说它是 RFC 101 的继任者，要做五件事：定义最初的“标准 Nix 格式”，成立 Nix formatter 小组，创建官方格式化工具，用它重排 Nixpkgs，并要求 Nix CLI 里任何默认的格式化都必须用官方的这个。RFC 的动机一节写得很实在：“People should not be bothered with formatting.” “We want to prevent future debate around how things should be formatted.” 它在设计上的取舍也坦白：“Bad code does not deserve good formatting.” PR 带着 `status: accepted` 的标签，最后一轮 FCP 的号召写着收尾会议在 2024-03-04，2024-03-05 的评论里已经有人在祝贺。

落地花了更久：Nixpkgs 在 2025-04-01 被整个重排，Discourse 上的公告写的是 “everything went according to plan, Nixpkgs is fully formatted”（[公告](https://discourse.nixos.org/t/nix-formatting-team-full-nixpkgs-reformat/61867)；PR 是 [NixOS/nixpkgs#380990](https://github.com/NixOS/nixpkgs/pull/380990)）；`nixfmt` 的 [v1.0.0](https://github.com/NixOS/nixfmt/releases/tag/v1.0.0) 在 2025-07-14 发布，发布说明称它是 “the first stable release of the official Nix formatter”，基础就是 RFC 166，并说格式变得“unrecognisable from previous versions”。这台机器上的 `nixfmt` 是 1.4.0，已经是那条线上的后来版本。

在 Firn 里它出现在三处：`Makefile` 的 `lint` 目标第一行 `nixfmt --check $(NIX_FILES)` (L19)；`nix fmt`，第 8 篇给 flake 配的 `formatter` 是 `nixfmt-tree`；以及“两个入口：make lint 和 flake check”一节的 `lint` 检查。`nixfmt-tree` 是 nixpkgs 里的包，nixfmt 的 README 说它是预先配好 `nixfmt` 的 `treefmt`，因为 `nixfmt` 本身一次只处理一个文件。

## lint：statix 和 deadnix

格式化解决的是“长得一样”，不解决“写得对不对”。Firn 用两个 linter：[statix](https://github.com/oppiliappan/statix)，“Lints and suggestions for the Nix programming language”，找反模式；[deadnix](https://github.com/astro/deadnix)，“Scan `.nix` files for dead code (unused variable bindings)”，找没用的绑定。[`lab/ch20/fixtures/smelly.nix`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/fixtures/smelly.nix) 是一个故意写坏的文件，33 行，格式没问题、能解析，每个坏味道的前一行注释写着对应的 statix 规则名：

```nix
# BAD: deliberately smelly Nix, input for lint_tools.sh. It parses and is
# formatted; statix and deadnix each find problems in it. The comment above
# each attribute names the statix lint that reports it.
{
  pkgs,
  unusedArg,
}:
let
  unusedBinding = 1;
  greeting = "hello";
in
{
  # manual_inherit
  greeting = greeting;
  # repeated_keys
  a.b = 1;
  a.c = 2;
  a.d = 3;
  # ...
  # empty_let_in
  emptyLet =
    let
    in
    1;
  # empty_list_concat
  concat = [ ] ++ [ 1 ];
  inherit (pkgs) hello;
}
```

[`lab/ch20/lint_tools.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/lint_tools.sh) 对它跑两个工具，并数它们各报了多少（L18 到 L30 做的事：先打印 `statix check` 和 `deadnix` 的人类可读输出，再用各自的 JSON 输出数条数，数不到就失败）。`make ch20` 留下的输出（`stdout`，我把每个 `╭─[` 到 `────╯` 的框保留原样）：

```text
== statix check
[03] Warning: Assignment instead of inherit
    ╭─[ lab/ch20/fixtures/smelly.nix:14:3 ]
    │
 14 │   greeting = greeting;
    │   ──────────┬─────────  
    │             ╰─────────── This assignment is better written with inherit
────╯
[20] Warning: Avoid repeated keys in attribute sets
    ╭─[ lab/ch20/fixtures/smelly.nix:16:3 ]
    │
 16 │   a.b = 1;
    │   ─┬─  
    │    ╰─── The key a is first assigned here ...
 17 │   a.c = 2;
    │   ─┬─  
    │    ╰─── ... repeated here ...
 18 │   a.d = 3;
    │   ─┬─  
    │    ╰─── ... and here. Try a = { b=...; c=...; d=...; } instead.
────╯
[07] Warning: This function expression is eta reducible
    ╭─[ lab/ch20/fixtures/smelly.nix:20:10 ]
    │
 20 │   show = x: toString x;
    │          ──────┬──────  
    │                ╰──────── Found eta-reduction: toString
────╯
[08] Warning: These parentheses can be omitted
    ╭─[ lab/ch20/fixtures/smelly.nix:22:12 ]
    │
 22 │   parens = (1 + 2);
    │            ───┬───  
    │               ╰───── Useless parentheses around value in binding
────╯
[10] Warning: Found empty pattern in function argument
    ╭─[ lab/ch20/fixtures/smelly.nix:24:12 ]
    │
 24 │   noArgs = { ... }: 1;
    │            ───┬───  
    │               ╰───── This pattern is empty, use _ instead
────╯
[02] Warning: Useless let-in expression
    ╭─[ lab/ch20/fixtures/smelly.nix:27:5 ]
    │
 27 │ ╭─▶     let
    ┆ ┆   
 29 │ ├─▶     1;
    │ │            
    │ ╰──────────── This let-in expression has no entries
────╯
[23] Warning: Unnecessary concatenation with empty list
    ╭─[ lab/ch20/fixtures/smelly.nix:31:12 ]
    │
 31 │   concat = [ ] ++ [ 1 ];
    │            ──────┬─────  
    │                  ╰─────── Concatenation with the empty list, [], is a no-op
────╯
== deadnix
Warning: Unused declarations were found.
   ╭─[lab/ch20/fixtures/smelly.nix:6:3]
 6 │  unusedArg,
   │      ╰───── Unused lambda pattern: unusedArg
 9 │  unusedBinding = 1;
   │        ╰─────── Unused let binding: unusedBinding
statix warnings: 7
deadnix findings: 2
```

（`out/ch20/lint_tools.stdout` 里带 ANSI 颜色转义，这个块是去掉转义之后的文本）

数目是 statix 7 条警告、deadnix 2 条发现。7 不是 9：`a.b`、`a.c`、`a.d` 三行重复的键只报一次 (`repeated_keys`)，脚本的头注释里特意写了这一点，`inherit (pkgs) hello` 是对的写法，不报。`deadnix` 找出的两个是未使用的函数参数 `unusedArg` (L6) 和未使用的 `let` 绑定 `unusedBinding` (L9)；`greeting` 被用了，所以不报。我想知道别的工具看这个文件会得到什么，于是跑了 `nil` 的 `diagnostics` 子命令（它是 nixd 之外的另一个 Nix 语言服务器，“nixd 和 nil：编辑器里的同一批检查”一节会说）：

```text
$ nix shell --file nix/pkgs.nix nil -c nil diagnostics lab/ch20/fixtures/smelly.nix
warning[empty_let_in]: Empty let-in
   ┌─ lab/ch20/fixtures/smelly.nix:27:5
   │  
27 │ ╭     let
28 │ │     in
   │ ╰──────^

warning[unused_binding]: Unused binding
  ┌─ lab/ch20/fixtures/smelly.nix:9:3
  │
9 │   unusedBinding = 1;
  │   ^^^^^^^^^^^^^
```

（手敲，不在 `lab/ch20/` 里）

`nil` 报了 2 条，`empty_let_in` 和 `unused_binding`；`unusedArg` 它没报。三个工具对同一个文件的计数是 7、2、2，各自覆盖的集合并不相同，这也是我同时用 statix 和 deadnix 的原因。

两个工具的退出状态也不同：`statix check` 找到任何东西就退出 1，所以 `Makefile` 的 `lint` 用 `set -e` 的循环一个文件一个文件地跑它 (L20)；`deadnix` 要加 `--fail` 才在发现死代码时退出 1（L21，也是 deadnix README 的帮助输出里 `-f, --fail` 的含义；README 只写了 `--fail`，默认退出 0 是 `lint_tools.sh` 头注释的说法和我的实测）。`deadnix` 还有一个坑，README 的 “Behavior” 一节专门提了：`callPackage` 靠函数参数的名字注入依赖，如果一个包文件里的参数名只是被转手传给另一个 `import`，deadnix 会把它们当成没用的，报出来，改掉它们就会让 `callPackage` 失灵，这时要加 `-L` (`--no-lambda-pattern-names`)。Firn 没加，`make lint` 是通过的，因为 `pkgs/*/package.nix` 里的每个参数都真的用到了。

statix 的状态我要如实说。它 README 顶部的警告 (2026-11-08 查) 写着：项目已经[搬到 tangled](https://tangled.org/oppi.li/statix)，存在一个 Molybdenum Software 的重要分叉，nixpkgs 里的 `statix` 包的源码是那个分叉，分叉的维护者“is eager to merge back”。我装的 `0.5.8-unstable-2026-07-17` 是 nixpkgs 的包，所以本节的输出来自哪一份，我没有去核实；README 里的例子诊断编号是 `[W04]` 的形式，我这里是 `[03]`，所以我不假设它们的行为完全一致。

### 两个入口：make lint 和 flake check

lint 现在有两个入口。`make lint` 是我敲的（`Makefile` L18 到 L23，还包括 `shellcheck` 和 `shfmt`）；`checks.<sys>.lint` 是同一件事的沙箱版，`nix flake check` 会跑它。[`flake.nix`](https://github.com/bfmhno3/firn/blob/ch20/flake.nix) 的 L207 到 L232：

```nix
          # 第 20 章：Makefile lint 目标的沙箱版。文件选择与 Makefile 一致：
          # nixfmt 看所有 .nix，statix 和 deadnix 跳过 lab/ 和 templates/。
          # 只覆盖 Nix 文件：shellcheck 和 shfmt 只在 make lint 里跑。
          lint =
            pkgs.runCommand "firn-lint"
              {
                src = pkgs.lib.cleanSource ./.;
                nativeBuildInputs = with pkgs; [
                  nixfmt
                  statix
                  deadnix
                  findutils
                ];
              }
              ''
                cd "$src"
                mapfile -t all < <(find . -name '*.nix' -type f | sort)
                mapfile -t strict < <(find . -name '*.nix' -type f \
                  -not -path './lab/*' -not -path './templates/*' | sort)
                nixfmt --check "''${all[@]}"
                for f in "''${strict[@]}"; do
                  statix check "$f"
                done
                deadnix --fail "''${strict[@]}"
                echo ok > $out
              '';
```

文件选择和 `Makefile` 一致：`nixfmt` 看所有 `.nix`（包括 `lab/` 下的，所以 `smelly.nix` 必须是格式正确的），`statix` 和 `deadnix` 跳过 `lab/` 和 `templates/`（实验文件里有故意写坏的 `# BAD`）。两处不同：沙箱版没有 `shellcheck` 和 `shfmt`，Shell 的 lint 只在 `make lint` 里；沙箱版用 `find` 而 `Makefile` 用 `git ls-files`，不过 `cleanSource ./.` 在 flake 里本来就只含被 git 跟踪的文件。

我故意弄坏它，看它挡在哪里：在 `ch20` 的一份拷贝里加一个 `scratch/bad.nix`，里面既有 statix 的问题（`(1 + 2)` 的无用括号），也有 deadnix 的问题 (`unusedArg`)：

```text
$ cat scratch/bad.nix
{ pkgs, unusedArg }:
{
  x = (1 + 2);
}
$ nix build --no-link -L "path:/tmp/s20/fc#checks.x86_64-linux.lint" 2>&1 | grep -E '^(firn-lint>|error:)'
firn-lint> [08] Warning: These parentheses can be omitted
firn-lint>    ╭─[ ./scratch/bad.nix:3:7 ]
firn-lint>    │
firn-lint>  3 │   x = (1 + 2);
firn-lint>    │       ───┬───
firn-lint>    │          ╰───── Useless parentheses around value in binding
firn-lint> ───╯
error: Cannot build '/nix/store/v7ny85xpn7jc8gclcfbpc9wqm6zcmmzs-firn-lint.drv'.
```

（手敲，不在 `lab/ch20/` 里；`/tmp/s20/fc` 是 `git archive ch20` 解出来的一份拷贝，加了 `scratch/bad.nix`，用 `path:` 引用）

只有 statix 的报告。`deadnix` 没有机会说话，因为构建脚本在 statix 退出 1 的那一刻就结束了（`runCommand` 的构建器默认遇错即停），所以 `unusedArg` 要等你修好括号、再跑一次才会出现。这是我对“一个门禁，三个工具”的第一个意外：每次失败只暴露一个工具的问题。

### nixd 和 nil：编辑器里的同一批检查

格式化和 lint 最好在敲代码的时候就发生，而不是等到 CI。这是 Nix 的语言服务器的事。锁定的 nixpkgs 里有两个：`nil`（版本 `2026-07-23`）和 `nixd` (`2.9.2`)。`nil` 的 README 称自己是 “An incremental analysis assistant for writing in Nix”；`nixd` 的 README 说它是 “a feature-rich nix language server interoperating with C++ nix”，链接了 Nix 的库，所以能做 NixOS、home-manager、flake-parts 的选项补全，惰性求值的包补全，和系统的 Nix 共用求值缓存，以及跨文件跳转到 nixpkgs 里的定义。`nil` 的 README 给出了把 `nixfmt` 配成格式化命令的设置；`nixd` 的 README 没有，我没有去读它的 `nixd/docs/configuration.md`。

我在这里只验证了两件事：`nil diagnostics` 能在命令行上跑（“lint”一节里的输出），`nixd --version` 打印 `nixd, version: 2.9.2`；我没有在编辑器里把它们接起来，所以补全、跳转这些功能我没有试过，这一节里的功能描述全部来自 README。

## 测试的四层

Firn 的测试现在有四层，从便宜到贵。

**第一层：`runTests`。** 第 5 篇的 `tests/lib.nix`，顶层 75 个形如 `{ expr; expected; }` 的用例（计数方法是该块里的那条 `grep`；第 6 到 17 篇一直说 77 个，是把第 5 篇里测 `runTests` 自身的 `testBad`、`testGood` 两个嵌套用例也算进去了），交给 `lib.runTests`，它返回失败列表，`[ ]` 表示全过：

```text
$ nix eval --file tests/lib.nix
[ ]
$ grep -cE '^    test[A-Za-z0-9]+ = ' tests/lib.nix
75
```

（手敲，不在 `lab/ch20/` 里）

它有一个限制：不能测“应该报错”。我把 `tests/lib-unit.nix`（下一层的文件，格式是兼容的）直接交给 `runTests`，它的最后一个用例 `expr = throw "boom"` 没有 `expected`：

```text
$ nix eval --impure --expr 'let pkgs = import ./nix/pkgs.nix { }; in pkgs.lib.debug.runTests (import ./tests/lib-unit.nix)' 2>&1 | grep -E '^\s+error:'
       error: boom
```

（手敲，不在 `lab/ch20/` 里）

一个用例的求值错误不是一个失败的用例，而是整个 `runTests` 的求值错误，所有别的用例的结果也就拿不到了。

**第二层：nix-unit。** [nix-unit](https://github.com/nix-community/nix-unit) 吃同样形状的属性集，但它用 Nix 求值器的 C++ API 逐个求值，所以一个用例的求值错误只是这个用例的失败；它的 README 的对比表也把 “Can test eval failures” 这一栏列成 `runTests` 的 `no`、nix-unit 的 `yes`。多出来的用例形式是 `expectedError`，[`tests/lib-unit.nix`](https://github.com/bfmhno3/firn/blob/ch20/tests/lib-unit.nix) 的最后一个（L79 到 L83）：

```nix
  testThrowIsExpected = {
    expr = throw "boom";
    expectedError.type = "ThrownError";
    expectedError.msg = "boom";
  };
```

这个文件是 `tests/lib.nix` 的一个子集，14 个用例：13 个是从 `lib.nix` 搬来的（其中 `testConstIsLazy` 在 `lib.nix` 里叫 `testConstIgnoresSecond`），加上这个 `expectedError`。它同时是 flake 检查 `checks.<sys>.lib-unit`，[`flake.nix`](https://github.com/bfmhno3/firn/blob/ch20/flake.nix) L194 到 L205：

```nix
          lib-unit =
            pkgs.runCommand "firn-lib-unit"
              {
                src = pkgs.lib.cleanSource ./.;
                nativeBuildInputs = [ pkgs.nix-unit ];
              }
              ''
                HOME="$(realpath .)"
                export HOME
                nix-unit --eval-store "$HOME" "$src/tests/lib-unit.nix"
                echo ok > $out
              '';
```

`HOME` 指到构建目录，这是 nix-unit 文档里的 flake 检查示例的做法；`--eval-store "$HOME"` 也是文档的写法。仓库里的注释说 `HOME` 必须设，不设时报 `creating directory "/nix/var/nix/profiles": Permission denied`，设了 `HOME` 之后去掉 `--eval-store` 照样通过，所以它不是必需的（flag 保留）。我在 `ch20` 的一份拷贝里各拆掉一样独立试过，结论一致：两样都不要，构建以 `error: creating directory "/nix/var/nix/profiles": Permission denied` 失败；只留 `HOME`、去掉 `--eval-store`，14 个用例照样通过，Nix 只多打印一行 `"/nix/var/nix" does not exist, so Nix will use "/build/.local/share/nix/root" as a chroot store`。`--rebuild` 能让这个检查再跑一遍（它的结果在我的 store 里已经有了）；nix-unit 的输出带表情符号，我用 `sed` 换成了文字：

```text
$ nix build --no-link --rebuild -L .#checks.x86_64-linux.lib-unit 2>&1 | grep -E '^firn-lib-unit>' | sed -E 's/✅/ok/;s/❌/FAIL/;s/🎉/ok/;s/😢/FAIL/'
firn-lib-unit> ok testAttrByPathHit
firn-lib-unit> ok testConstIsLazy
firn-lib-unit> ok testEscapeShellArgPlain
firn-lib-unit> ok testFixSelfReference
firn-lib-unit> ok testFlip
firn-lib-unit> ok testGenAttrs
firn-lib-unit> ok testHasAttrByPathNonSet
firn-lib-unit> ok testHasPrefixLonger
firn-lib-unit> ok testId
firn-lib-unit> ok testRangeEmpty
firn-lib-unit> ok testRecursiveUpdateNonSetWins
firn-lib-unit> ok testSetAttrByPathDeep
firn-lib-unit> ok testSplitStringBasic
firn-lib-unit> ok testThrowIsExpected
firn-lib-unit> 
firn-lib-unit> ok 14/14 successful
```

（手敲，不在 `lab/ch20/` 里）

同一份 `ch20` 拷贝里，把 `testHasPrefixLonger` 的 `expected` 从 `false` 改成 `true`，同一个检查给出的是：

```text
$ diff <(git -C ~/Projects/firn show ch20:tests/lib-unit.nix) tests/lib-unit.nix
49c49
<     expected = false;
---
>     expected = true;
$ nix build --no-link -L "path:/tmp/s20/fc#checks.x86_64-linux.lib-unit" 2>&1 | grep -E '^(firn-lib-unit>|error:)' | sed -E 's/✅/ok/;s/❌/FAIL/;s/🎉/ok/;s/😢/FAIL/'
firn-lib-unit> ok testAttrByPathHit
firn-lib-unit> ok testConstIsLazy
firn-lib-unit> ok testEscapeShellArgPlain
firn-lib-unit> ok testFixSelfReference
firn-lib-unit> ok testFlip
firn-lib-unit> ok testGenAttrs
firn-lib-unit> ok testHasAttrByPathNonSet
firn-lib-unit> FAIL testHasPrefixLonger
firn-lib-unit> /build/nix-6-732662652/expected.nix --- Nix
firn-lib-unit> 1 false                      1 true
firn-lib-unit> 
firn-lib-unit> 
firn-lib-unit> ok testId
firn-lib-unit> ok testRangeEmpty
firn-lib-unit> ok testRecursiveUpdateNonSetWins
firn-lib-unit> ok testSetAttrByPathDeep
firn-lib-unit> ok testSplitStringBasic
firn-lib-unit> ok testThrowIsExpected
firn-lib-unit> 
firn-lib-unit> FAIL 13/14 successful
firn-lib-unit> error: Tests failed
error: Cannot build '/nix/store/qgslmgb673ndf2nh0lpjjji1y11mg346-firn-lib-unit.drv'.
```

（手敲，不在 `lab/ch20/` 里）

nix-unit 把失败的用例连同期望值和实际值（`1 false` 对 `1 true`，临时目录名每次不同）并排打印出来，别的用例照常报告，整个构建以 `Tests failed` 失败。这条命令里 `sed` 的四个模式，匹配的是 nix-unit 在这台机器上输出的状态符号（我在正文里不使用它们），换成通用的 `[^[:print:]]+` 会改变输出里的空格，所以我保留了原样。

**第三层：flake checks。** `nix flake check` 对每个系统求值 `checks.<sys>` 里的所有属性并构建它们，`make check` 就是 `nix flake check -L`（`Makefile` L25 到 L26）。在 `x86_64-linux` 上现在有 21 个：

```text
$ nix eval --json .#checks.x86_64-linux --apply builtins.attrNames | jq -c '.'
["cairn-settings","cairn-vm","dev-shell","home-files","home-vm","lib-tests","lib-unit","lint","mini-site","pkg-cairn","pkg-cairn-report","pkg-firn-hello","pkg-firn-hello-aarch64","pkg-firn-hello-hallo","pkg-firn-hello-musl","pkg-firn-hello-static","pkg-firn-tools","pkg-pebble","pkg-sift","readme-table","secrets-vm"]
```

（手敲，不在 `lab/ch20/` 里）

比 `ch19` 的 19 个多了 `lib-unit` 和 `lint`。其中 `pkg-*` 是“这个包能构建”，`lib-tests`、`lib-unit`、`cairn-settings`、`home-files`、`readme-table`、`mini-site` 是求值或小构建，`lint` 是格式和静态检查，`dev-shell` 是开发 shell 能构建，三个 `*-vm` 是最后一层。

**第四层：虚拟机测试。** `cairn-vm`（第 16 篇）、`secrets-vm`（第 17 篇）、`home-vm`（第 18 篇）用 `testers.runNixOSTest` 在沙箱里起一台 QEMU 虚拟机，在里面真的运行 systemd 服务、sops-nix 激活、Home Manager 激活。它们要 `/dev/kvm`，所以 CI 才要先放开 KVM 权限。我对三个检查各跑了一遍 `--rebuild`（强制重新跑测试，不用 store 里已有的结果）：

```text
$ for c in cairn-vm secrets-vm home-vm; do /usr/bin/env time -f "$c --rebuild: %e s" nix build --no-link --rebuild ".#checks.x86_64-linux.$c" 2>&1 | tail -1; done
cairn-vm --rebuild: 21.95 s
secrets-vm --rebuild: 100.28 s
home-vm --rebuild: 19.89 s
```

（手敲，不在 `lab/ch20/` 里；单次样本）

四层放在一起：

| 层 | 工具 | 失败的样子 | 代价 | 在 Firn 里 |
| --- | --- | --- | --- | --- |
| 1 | `lib.runTests` | 返回的失败列表非空；一个用例抛错则整个求值失败 | 一次 `nix eval` | `tests/lib.nix`，75 个顶层用例 |
| 2 | nix-unit | 逐个用例的 `ok`/`FAIL`，期望值和实际值并排；支持 `expectedError` | 0.29 s（14 个用例，`--rebuild`） | `tests/lib-unit.nix`，14 个用例 |
| 3 | flake checks | 构建失败，`nix flake check` 退出非零 | 取决于检查：`lint` 0.54 s，`lib-unit` 0.29 s (`--rebuild`)，虚拟机更久 | 21 个 |
| 4 | `runNixOSTest` | 测试脚本里的断言失败，或者虚拟机起不来 | 21.95 s、100.28 s、19.89 s（各一次 `--rebuild`） | `cairn-vm`、`secrets-vm`、`home-vm` |

## 可复现性：同一个 derivation，构建两次

回到开头的第一个推论：输入一样，输出一样吗？NixOS 的 [Reproducible Builds 页面](https://reproducible.nixos.org/)对这个问题的回答很克制：因为 Nix 的 derivation 对依赖有确定的引用，构建又在沙箱里，所以 Nix 是达成可复现构建的“excellent starting point”，“However, this alone is not sufficient: builds may still leak timestamps or have other nondeterminisms.” 怎么查？页面给了两条等价的命令：`nix-build '<nixpkgs>' -A hello --check --keep-failed`，或者 `nix build nixpkgs#hello --rebuild --keep-failed`，同时先打一针预防：“Building a package twice can't prove it is reproducible: you might simply have gotten lucky. However, it is a useful first step.”

### --rebuild：把同一个 derivation 再构建一次

[`lab/ch20/repro_ok.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/repro_ok.sh) 对 `firn-hello` 做这件事（L14 到 L17）：

```bash
  out="$(nix build --no-link --print-out-paths "${FIRN_ROOT}#firn-hello")"
  echo "first build:  ${out}"
  nix build --no-link --print-out-paths --rebuild "${FIRN_ROOT}#firn-hello"
  echo "rebuild: identical output"
```

```text
first build:  /nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0
/nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0
rebuild: identical output
```

`--rebuild` 让 Nix 在沙箱里重新执行一遍 builder，把得到的输出和 store 里已经登记的那个比较，一样才成功，退出码 0；`Makefile` 里 `make repro`（L28 到 L29）就是这条命令。比较的是什么，源码里写得很清楚。[`derivation-builder.cc`](https://github.com/NixOS/nix/blob/2.34.9/src/libstore/unix/build/derivation-builder.cc#L1874-L1908) 在 `bmCheck` 模式下，如果新输出的 `narHash` 和已登记的 `oldInfo.narHash` 不同，就抛 `NotDeterministic`，消息是 `derivation '%s' may not be deterministic: output %s differs`。比较的就是 NAR 的哈希，和“签名签的是什么”一节里签名覆盖的那个哈希是同一个。同一段代码在比较通过之后还有一件事（L1910 到 L1915）：如果登记的路径还不是 `ultimate`，就把它标成 `ultimate` 并重新签名，源码注释的理由是 “Since we verified the build, it's now ultimately trusted.” 我只是读了这段代码，没有去测它的副作用。

`firn-hello` 过了，大概率是因为它简单：一个 C 文件、一个 `Makefile`、没有时间戳、没有随机数。要看失败，得有一个故意写坏的包。

### 一个故意不可复现的包

[`mini/pkgs/nondeterministic.nix`](https://github.com/bfmhno3/firn/blob/ch20/mini/pkgs/nondeterministic.nix)，10 行，整份：

```nix
# 故意不可复现的包：输出里写进内核每次随机生成的 UUID。
# 只给第 20 章的 `nix build --rebuild` 演示用，不进任何 checks。
{ mkDerivation }:
mkDerivation {
  name = "nondeterministic";
  installPhase = ''
    mkdir -p "$out/share"
    cat /proc/sys/kernel/random/uuid > "$out/share/stamp.txt"
  '';
}
```

`mkDerivation` 是第 7 篇从零写的那个 mini stdenv 的，`mini/default.nix` 多了一行把它挂进包集合 (L25)。`/proc/sys/kernel/random/uuid` 每次读都是新的，写进输出，两次构建就必然不同。它不在任何 flake 检查里，否则 `make check` 永远是红的。两处旁边的改动跟着它：`mini/default.nix` 现在有 26 行；第 7 篇引用的 `setAttrNames` 那一行是 `ch07` 时的输出，列出 10 个名字，现在是 11 个（多了 `nondeterministic`），那一篇的引文在 `ch07` 标签上仍然是对的，在 `ch20` 上要多一个名字。另外 [`lab/ch07/mini_build.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch07/mini_build.sh) 要构建 `mini` 里的每一个包并检查闭包，它现在把 `nondeterministic` 排除掉了 (L19)：

```bash
  'm: builtins.filter (n: n != "busybox" && n != "nondeterministic" && (m.${n}.type or "") == "derivation") (builtins.attrNames m)' \
```

[`lab/ch20/repro_fail.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/repro_fail.sh) 对它做 `--rebuild`，在 `${LAB_TMP}/store` 这个一次性的本地 store 里，宿主机的 store 里不会留下这个包（核心是 L14 到 L18）：

```bash
  local attr="${FIRN_ROOT}#legacyPackages.x86_64-linux.mini.nondeterministic"
  local store="${LAB_TMP}/store"
  nix build --store "${store}" --no-link --print-out-paths "${attr}"
  # This is the command that fails: its exit status is the lab's.
  nix build --store "${store}" --no-link --rebuild "${attr}"
```

它是 `_fail` 实验，退出码必须非零。stdout 是第一次构建打印的路径，stderr 的最后两行是：

```text
checking outputs of '/nix/store/lcfmdwqha00n36mxbazi8qmb72ccq7a5-nondeterministic.drv'...
error: derivation '/nix/store/lcfmdwqha00n36mxbazi8qmb72ccq7a5-nondeterministic.drv' may not be deterministic: output "/tmp/nix-shell.md9oEg/firn-lab.qdHsZr/store/nix/store/1z7gfvw7bfcmys9d2xpxx4wml3xf5avj-nondeterministic" differs
```

注意这条消息只有 `differs`，没有 “from …check”。那是 `derivation-builder.cc` 那段源码里的另一个分支：只有当配置了 `diff-hook`，或者带了 `--keep-failed` 的时候，Nix 才把第二次的输出挪到 `<路径>.check` 留下来，消息才多一段 `from`。

### diffoscope：差在哪里

“不一样”不是答案，“哪里不一样”才是。（旧命令里与 `nix build --rebuild` 对应的是 `nix-build --check`，NixOS 的页面把两条并列写出；我没有在这里运行 `nix-build --check`。）NixOS 的页面建议在失败时用 [diffoscope](https://diffoscope.org) 分析两次输出的差异。nixpkgs 里有它（版本 329），[`lab/ch20/diffoscope_host.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/diffoscope_host.sh) 不安装它，只是 `nix build -f nix/pkgs.nix diffoscope.out` 拿到一个路径来用。它先正常构建，再 `--rebuild --keep-failed`（重建失败，但第二次的输出留在 `<路径>.check`），然后让 diffoscope 比较两个目录（L19 到 L27 和 L38 到 L40）：

```bash
  "${diffoscope}/bin/diffoscope" "${a}" "${b}" | sed "s|${store}||g" \
    | sed -E 's/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/<uuid>/' \
    || status=$?
```

diffoscope 发现差异时退出 1，所以脚本把退出码 1 当作期望的结果，其它退出码是错误。UUID 被替换成 `<uuid>`，不然每次运行的输出都不同。输出：

```text
derivation '/nix/store/lcfmdwqha00n36mxbazi8qmb72ccq7a5-nondeterministic.drv' may not be deterministic: output "/nix/store/1z7gfvw7bfcmys9d2xpxx4wml3xf5avj-nondeterministic" differs from "/nix/store/1z7gfvw7bfcmys9d2xpxx4wml3xf5avj-nondeterministic.check"
--- /nix/store/1z7gfvw7bfcmys9d2xpxx4wml3xf5avj-nondeterministic
+++ /nix/store/1z7gfvw7bfcmys9d2xpxx4wml3xf5avj-nondeterministic.check
│   --- /nix/store/1z7gfvw7bfcmys9d2xpxx4wml3xf5avj-nondeterministic/share
├── +++ /nix/store/1z7gfvw7bfcmys9d2xpxx4wml3xf5avj-nondeterministic.check/share
│ │   --- /nix/store/1z7gfvw7bfcmys9d2xpxx4wml3xf5avj-nondeterministic/share/stamp.txt
│ ├── +++ /nix/store/1z7gfvw7bfcmys9d2xpxx4wml3xf5avj-nondeterministic.check/share/stamp.txt
│ │ @@ -1 +1 @@
│ │ +<uuid>
│ │ -<uuid>
```

第一行带着 `from …check`，因为这次加了 `--keep-failed`；其余是 diffoscope 的树形输出：整个输出里只有 `share/stamp.txt` 不同，差在唯一的一行。在一个真的有问题的包里，这就是把“它不可复现”变成“`strip` 之前的这个 `.o` 里有一个时间戳”的那一步。

### 一份进度报告

“NixOS 整体上可复现到什么程度”有公开的数字。reproducible.nixos.org 页面列出四份报告，分别对应最小 ISO 和图形 ISO 的运行时依赖与构建时依赖。我读了最小 ISO 运行时依赖那一份（[jobset 1](https://reproducibility.nixos.social/jobsets/1)，2026-11-08 查）：最早的一次评估是 2024-09-26，640 个输出路径里 553 个可复现、2 个不可复现、85 个待定；最近一次是 2026-09-24，781 个里 776 个可复现、1 个不可复现、4 个待定（[评估 #28](https://reproducibility.nixos.social/evaluations/1/4975466d3247)）。我没有去核对这个站点怎么定义“可复现”和“待定”，这三个数字是它的页面上的 `Reproducible`、`Not Reproducible`、`Pending` 三栏；它是一个 ISO 的闭包，不是整个 nixpkgs，我也不会把它读成别的。

## 更新策略：为什么 Firn 的 pin 不动

Firn 的 `flake.lock` 里，`nixpkgs` 锁在 `56c02bc00adcf003215cc4bd996d6efaf4cff188`，是 2026-08-23 的，今天 (2026-11-08) 它已经 77 天了。如果我运行 `nix flake update nixpkgs`（我在 `ch20` 的一份拷贝里运行的，不是在仓库里），它想把它推到：

```text
$ nix flake update --flake path:/tmp/s20/fcu nixpkgs 2>&1 | grep -v 'untrusted\|accept-flake'
warning: updating lock file "/tmp/s20/fcu/flake.lock":
• Updated input 'nixpkgs':
    'github:NixOS/nixpkgs/56c02bc00adcf003215cc4bd996d6efaf4cff188?narHash=sha256-9i/VTdusq/%2BNM/tz%2BJ1Re%2BojkMB8MBf0QshnYfzHz30%3D' (2026-08-23)
  → 'github:NixOS/nixpkgs/f4a03c008967841f2a0b3cb7c436fc6fc31671f6?narHash=sha256-ziZn2PvCJE5JEEpqTdxXwJpPB%2BL3YqoCpTAMCzyaP3U%3D' (2026-11-07)
```

（手敲，不在 `lab/ch20/` 里；`/tmp/s20/fcu` 是 `git archive ch20` 解出来的一份拷贝，用 `path:` 引用）

我拿这两份锁各量了两样东西：

```text
$ for d in ~/Projects/firn /tmp/s20/fcu; do nix eval --impure --expr "let n = (builtins.getFlake \"path:$d\").inputs.nixpkgs; in builtins.length (builtins.attrNames (import n { system = \"x86_64-linux\"; }))" 2>/dev/null; done
27959
28643
$ for d in ~/Projects/firn /tmp/s20/fcu; do nix eval --raw --impure --expr "let n = (builtins.getFlake \"path:$d\").inputs.nixpkgs; pkgs = import n { system = \"x86_64-linux\"; }; in pkgs.hello.outPath" 2>/dev/null; echo; done
/nix/store/lcxc2z1h2g8wq8dxfpizy1di85kyxnqx-hello-2.12.3
/nix/store/sd779x86bjaqxj2lzh2jsir4h0zjz6d1-hello-2.12.3
```

（手敲，不在 `lab/ch20/` 里）

这 77 天里，nixpkgs 顶层的属性数从 27959 变成了 28643，多了 684 个，2.4%；`hello` 还是 2.12.3，但它的 store 路径从 `lcxc2z1h…` 变成了 `sd779x86…`，所以 `narinfo_anatomy.sh` 会去取另一份 narinfo。我还在更新后的锁上构建过 `firn-lint` 检查，它照样通过，日志里 `nixfmt` 从 1.4.0 变成了 1.5.0，`statix` 的版本没变；那一次构建的墙钟是 9 分 15 秒，几乎全是从镜像下载新 nixpkgs 的包，所以这个数字只说明“能通过”，不说明快（我只记了退出码和墙钟，没有留下完整输出）。我也试着在更新后的锁上构建 `lib-unit`，几分钟没有结束，我取消了；其余的检查我没有跑，所以“更新之后一切正常”这句话我没有资格说。

所以问题不在于更新会不会弄坏 Firn 的检查（至少 `lint` 这一项没有），而在于这个系列在每一篇里引用的输出：第 1 篇的 `27959`，这一篇的 `hello` narinfo (`lcxc2z1h2g8wq8dxfpizy1di85kyxnqx-hello-2.12.3`)，第 6 篇的闭包大小，第 7 篇的 `572` 个 `.drv`，都是从那一个 pin 量出来的。pin 一动，读者自己跑 `make chNN` 得到的数字就会和文章不一样。`flake.lock` 在这里不是一份依赖清单，是这篇文章的“实验条件”。所以 [`update-flake-lock.yml`](https://github.com/bfmhno3/firn/blob/ch20/.github/workflows/update-flake-lock.yml) 是这样的（整份，18 行）：

```yaml
# 手动更新 flake.lock 并开一个 PR。故意不设定时触发：
# 系列文章引用的是锁定的 nixpkgs，pin 不能在文章下面自己移动。
name: Update flake.lock

on:
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v7
      - uses: DeterminateSystems/determinate-nix-action@v3
      - uses: DeterminateSystems/update-flake-lock@v29
```

只有 `workflow_dispatch`，没有 `schedule`；`update-flake-lock` 的 README 里的每一个例子都带着 `schedule`（每周一次的 cron），Firn 故意没有。我也没有运行过这条 workflow，它是否能成功我不知道。两处细节：README 说从 v3 起这个 action 不再自动安装 Determinate Nix，必须在它之前自己安装一个支持 flakes 的 Nix，所以才有中间那一步；它也说，GitHub Actions “doesn't run workflows when a branch is pushed by or a PR is opened by a GitHub Action”，所以这个 workflow 开出来的 PR 不会触发 `ci.yml` 里的检查，要么关闭再打开那个 PR，要么给它一个个人访问令牌。

这个策略只适用于一个教程。一个真的在跑的系统应该经常更新，旧的 pin 会积累没有修的安全问题，它的价值反过来：`flake.lock` 让每一次更新都可以被审查、被测试、被回滚（第 9 篇的 generations，第 16 篇的 `switch`）。教程的 pin 不动，是因为教程自己就是它的实验条件。

## 推上去之后 CI 红了四次

这一篇的 workflow 和实验，我是在本机写完、在本机跑绿的。把 `main` 和标签 `ch20` 推到 GitHub 之后，第一次运行（运行 42516766065，`push`）两条矩阵线都红了。表里是四个根因，它们和我在本机看到的行为都不一样：

| 实验 | 哪条线 | 根因 | 修复 |
| --- | --- | --- | --- |
| `lab/ch08/copy_to_store.sh` | upstream（runner 上是 Nix 2.35.4） | Nix 2.35 的 `nix flake metadata` 让源码路径保持“虚拟”，不把它复制进 store；宿主机的 2.34.9 会复制。我用 2.35.2 和 2.34.9 各复现了一次 | [`50abf5b`](https://github.com/bfmhno3/firn/commit/50abf5b)：改用 `nix flake prefetch --json`，读 `.storePath` |
| `lab/ch08/flakeref_forms.sh` | 两条线 | runner 的 checkout 是浅克隆：`'/home/runner/work/firn/firn' is a shallow Git repository, so 'revCount' is not available` | [`50abf5b`](https://github.com/bfmhno3/firn/commit/50abf5b)：`ci.yml` 的 checkout 加 `fetch-depth: 0` |
| `lab/ch04/builtins_groups.nix` | determinate (3.24.2) | Determinate 多了 `builtins.filterAttrs`，不在实验的目录里 | [`50abf5b`](https://github.com/bfmhno3/firn/commit/50abf5b)：把它当作已知的分叉独有名字排除 |
| `lab/ch08/self_attrs.sh` | determinate | git 树是脏的时候，Determinate 不定义 `self.lastModified` | [`e3d6268`](https://github.com/bfmhno3/firn/commit/e3d6268)：用 `or null` |

这四处修完之后，运行 42518905677 (`e3d6268`) 两条线都绿了，它就是“CI 耗时”一节里的 `first`。

**标签 `ch20` 是不可变的。** 这些修复都在标签之后，只在 `main` 上，所以这一篇里指向 `blob/ch20` 的链接、以及我展示的实验，都是修复之前的版本。你 `git checkout ch20` 跑 `make ci`，在 Nix 2.35 的机器上会撞上第一行，在 Determinate 上会撞上第三、四行。这一篇说“`make ci` 是 251 个 `ok`”，指的是我这台 Nix 2.34.9 的机器；runner 上第一次并不是绿的。

**空令牌。** 前几次运行的日志里有一行 `Pushing is disabled`：`cachix-action` 的 `authToken` 到了 runner 上是空的，尽管 `gh secret list` 把 `CACHIX_AUTH_TOKEN` 列了出来。存进去的那份 secret 是错的或者空的（`gh secret list` 只列名字，看不出内容；令牌本身我没有见过）。2026-11-09 02:04Z 那份 secret 被重新设置，推送才开始工作。教训是：secret 在列表里，不等于它有值。

**又红了两次。** 缓存开始有内容之后，手动触发的运行 42548922796 (`e3d6268`) 里 determinate 绿，upstream 红在 `lab/ch20/unsigned_copy_fail.sh (exit 0)`：那个本该失败的不受信任复制，在 runner 上成功了。原因我没有确认。runner 的 `NIX_USER_CONF_FILES` 里有一份 cachix-action 写的 `nix.conf`，我没看到它的内容；我怀疑 `firn-hello` 身上带着一个被信任的 Cachix 签名，但日志里没有证据。[`3e9171d`](https://github.com/bfmhno3/firn/commit/3e9171d) 让这个实验不再依赖环境：它现在构建一个带随机数的 `runCommand "firn-lab-unsigned"`，任何缓存都不可能签过它，并显式传 `--option require-sigs true --option trusted-public-keys <cache.nixos.org 的公钥>`，还把环境里的 `require-sigs` 和 `trusted-users` 以 `volatile:` 行打印出来；`make_cache.sh` 多了可选的 `FIRN_LAB_SUBJECT`，`local_cache.sh` 和 `ex_bad_signature.sh` 也传了 `require-sigs true`。之后的运行都过了，但它们在这几种环境原因下都会过，所以这不能证明我猜对了哪一个。

`3e9171d` 的运行又在 `lab/ch07/phases_log.sh` 红了，两条线都是 `build log of '…mini.hello' is not available`：Cachix 这时已经有了 `mini.hello`，CI 直接取了它，本地没有构建过，也就没有构建日志。[`483b4eb`](https://github.com/bfmhno3/firn/commit/483b4eb) 让实验在构建之后再跑一次 `nix build --rebuild`。

`483b4eb` 上的两次绿色运行是 42551121824（`push`，upstream 12 分 19 秒，determinate 9 分 52 秒）和 42552279806（`workflow_dispatch`，upstream 13 分 12 秒，determinate 10 分 48 秒）。Cachix 里有没有 `pebble`，我在这台机器上这样查：

```text
$ nix path-info --store https://bfmhno3-firn.cachix.org "$(nix eval --raw .#pebble.outPath)"
/nix/store/psn4fsd8a5nsm1ki35bwy8q39w5br1b7-pebble-0.1.0
```

（手敲，不在 `lab/ch20/` 里；`nix eval` 的 stderr 里有 `nixConfig` 的两条警告）

## 让我意外的事

**空 store 里的 32 到 230 秒几乎全花在工具链上，不是花在我的代码上。** 我原来以为“有缓存”和“没缓存”的差别主要是编译 `firn-hello` 那几秒。数字不是这样：重新构建它只要 0.36 秒，从本地签过名的缓存里取它只要 0.35 秒，而在一个空 store 里从头做它要 32.01 秒（另一次是 230.42 秒），因为 gcc、glibc 和 stdenv 的其余部分要先取到，那是 896 MiB 的东西（`du -sh` 量的 store 目录，输出 `896M`）。所以缓存对 Firn 自己的包有多大用，取决于包的大小：`firn-hello` 几乎没有可缓存的东西，`pebble` 在第 11 篇的冷构建是 253.4 秒，才是值得缓存的那一类。

**同一份缓存里，一部分路径过了签名，一部分没有。** 我以为 `unsigned_copy_fail.sh` 会在第一个路径上就停下，结果它先复制成功了 5 个，然后才在第 6 个上失败。信任是逐个路径判断的，签名在 `cache.nixos.org-1` 下的五个依赖被接受，只有我本地构建、只有 `firn-lab-1` 签名的那一个被拒绝。

**`runTests` 遇到一个会抛错的用例，整个测试集就没有结果了。** 我早知道 `runTests` 只返回失败列表，没想到“求值错误”不被它当作一种失败：`expr = throw "boom"` 让整个 `nix eval` 退出，别的 13 个用例的结果也一起丢了。这是我多装一个 nix-unit 的理由，我觉得已经足够。

**一个门禁的三个工具，一次只说一个。** `checks.lint` 里的 statix 先失败，deadnix 就没有机会说话，所以一次修一个、跑一次、再修下一个。我现在对“CI 红了”的第一反应是：修完这一个，大概还有下一个。

## 检查点

在 `~/firn` 里，`nix develop` 之内：

```bash
env -u CI make ch20
make lint
make check
while read -r f; do
  diff <(git -C ~/firn-ref show ch20:"${f}") "${f}" && echo "same ${f}"
done < <(git -C ~/firn-ref diff --name-only ch19 ch20)
```

`make ch20` 在我这里打印这 12 行（命令回显加 11 行 `ok`），整条命令含 `nix develop` 的启动花了 2 分 18 秒：

```text
$ env -u CI make ch20
bash scripts/chapter.sh ch20
ok   lab/ch20/cachix_hit_host.sh
ok   lab/ch20/ci_times_host.sh
ok   lab/ch20/diffoscope_host.sh
ok   lab/ch20/ex_bad_signature.sh
ok   lab/ch20/lint_tools.sh
ok   lab/ch20/local_cache.sh
ok   lab/ch20/mirrors_host.sh
ok   lab/ch20/narinfo_anatomy.sh
ok   lab/ch20/repro_fail.sh
ok   lab/ch20/repro_ok.sh
ok   lab/ch20/unsigned_copy_fail.sh
```

`lab/ch20/` 里有 11 个实验（外加 `fixtures/` 里的两个文件，不单独运行），其中 4 个是 `_host`：`cachix_hit_host.sh`、`ci_times_host.sh`、`diffoscope_host.sh`、`mirrors_host.sh`，`CI=true` 时 `scripts/chapter.sh` 会对它们打印 `skip ... (host only)`。`repro_fail.sh` 和 `unsigned_copy_fail.sh` 是 `_fail` 实验，退出码必须是非零，所以 `out/ch20/*.status` 里它们是 `1`，别的是 `0`：

```text
$ cat out/ch20/*.status | tr '\n' ' '
0 0 0 0 0 0 0 0 1 0 1 
```

`make lint` 没有任何诊断，退出码 0；`make check` 以 `all checks passed!` 结束，退出码 0。`make lint` 会回显每一条命令，输出很长，所以我只留退出码；`make check` 里那行 `running 0 flake checks...` 说明 21 个检查的结果都已经在 store 里，这次没有重跑虚拟机测试，所以它的耗时（含 `nix develop` 的启动，18.9 秒）不能用来衡量检查本身：

```text
$ make lint >/dev/null 2>&1; echo "lint rc=$?"
lint rc=0
$ make check 2>&1 | tail -n 5; echo "rc=${PIPESTATUS[0]}"
derivation evaluated to /nix/store/sxj15y2pgk96v1kv2si52j1i2dqbbd5q-nixfmt-tree-2.5.0.drv
running 0 flake checks...
all checks passed!
warning: The check omitted these incompatible systems: aarch64-linux
Use '--all-systems' to check all.
rc=0
```

（手敲，不在 `lab/ch20/` 里）

整条 `make ci`（`make lint`、所有章节的实验、`make check`）我在 `ch20` 上用 `env -u CI` 在 `nix develop` 里跑了一遍：251 行 `ok`，0 行 `FAIL`，以 `all checks passed!` 结束，墙钟 36 分 30.9 秒（单次样本，含网络）。

**必须和标签一致的文件。** 命令清单里最后那个循环对 `git diff --name-only ch19 ch20` 列出的每个文件做 `diff`，全部应该打印 `same`，一共 23 行。我这台机器上没有 `~/firn-ref`，我在 Firn 仓库里把 `git -C ~/firn-ref show ch20:"${f}"` 换成 `git show ch20:"${f}"` 跑（拿标签里的内容和工作区比）：

```text
same .github/workflows/ci.yml
same .github/workflows/update-flake-lock.yml
same Makefile
same README.md
same flake.nix
same lab/ch07/mini_build.sh
same lab/ch19/flakehub_resolve_host.sh
same lab/ch20/cachix_hit_host.sh
same lab/ch20/ci_times_host.sh
same lab/ch20/diffoscope_host.sh
same lab/ch20/ex_bad_signature.sh
same lab/ch20/fixtures/make_cache.sh
same lab/ch20/fixtures/smelly.nix
same lab/ch20/lint_tools.sh
same lab/ch20/local_cache.sh
same lab/ch20/mirrors_host.sh
same lab/ch20/narinfo_anatomy.sh
same lab/ch20/repro_fail.sh
same lab/ch20/repro_ok.sh
same lab/ch20/unsigned_copy_fail.sh
same mini/default.nix
same mini/pkgs/nondeterministic.nix
same tests/lib-unit.nix
```

**中间版本。** 这是最后一篇，这些文件在 `ch20` 就是终稿。`ci.yml` 里的 `@v7`、`@v31`、`@v3`、`@v17`、`@v29` 是我写下它们那天 (2026-11-08) 用 `git ls-remote --tags` 查到的各个 action 的最新大版本号，你读到的时候可能已经有新的了。你自己的 `~/firn` 里，`mirrors_host.sh` 的数字每次都不同，`narinfo_anatomy.sh` 要联网，`cachix_hit_host.sh` 和 `ci_times_host.sh` 的输出取决于 GitHub 和 Cachix 那一天的状态；它们只要退出 0 就算通过。

### 文件清单

链接指向标签 `ch20` 上的那一份；`git diff --name-only ch19 ch20` 的 23 个文件一个不少，其中 `lab/ch20/` 下 13 个（11 个实验加 2 个夹具文件）。实验的命令都是 `env -u CI make ch20`，输出在 `out/ch20/`。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`.github/workflows/ci.yml`](https://github.com/bfmhno3/firn/blob/ch20/.github/workflows/ci.yml) | `grep -c 'uses:' .github/workflows/ci.yml` | 46 行；`4`，分别是 `actions/checkout@v7`、`install-nix-action@v31`、`determinate-nix-action@v3`、`cachix-action@v17`；触发是推送 `main` 和 `workflow_dispatch`；矩阵 `installer: [upstream, determinate]`，`fail-fast: false` |
| [`.github/workflows/update-flake-lock.yml`](https://github.com/bfmhno3/firn/blob/ch20/.github/workflows/update-flake-lock.yml) | `grep -c 'uses:' .github/workflows/update-flake-lock.yml` | 18 行；`3`；只有 `workflow_dispatch`，没有 `schedule` |
| [`Makefile`](https://github.com/bfmhno3/firn/blob/ch20/Makefile) | `git diff --stat ch19 ch20 -- Makefile` | 34 行；`1 file changed, 4 insertions(+), 1 deletion(-)`：多一个 `repro` 目标（`nix build .#firn-hello --rebuild`） |
| [`README.md`](https://github.com/bfmhno3/firn/blob/ch20/README.md) | `git diff --stat ch19 ch20 -- README.md` | 130 行；`1 file changed, 11 insertions(+), 2 deletions(-)`：目录多 3 行（`lib-unit.nix`、`ci.yml`、`update-flake-lock.yml`），`checks` 行多 `lib-unit` 和 `lint`，多一段 `nixConfig` 的说明，并注明 `lint` 检查只覆盖 Nix 文件 |
| [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch20/flake.nix) | `git diff --stat ch19 ch20 -- flake.nix` | 429 行；`1 file changed, 53 insertions(+)`：`nixConfig`（L6 到 L11）、`lib-unit`（L194 到 L205）、`lint`（L210 到 L232）；`x86_64-linux` 上 21 个检查 |
| [`lab/ch07/mini_build.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch07/mini_build.sh) | `git diff --stat ch19 ch20 -- lab/ch07/mini_build.sh` | 39 行；`1 file changed, 3 insertions(+), 2 deletions(-)`：构建 `mini` 的每个包时排除 `nondeterministic` |
| [`lab/ch19/flakehub_resolve_host.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch19/flakehub_resolve_host.sh) | `git diff --stat ch19 ch20 -- lab/ch19/flakehub_resolve_host.sh` | 54 行；`1 file changed, 5 insertions(+), 2 deletions(-)`：`nix flake metadata --json` 的 stderr 单独写到 `${LAB_TMP}/metadata.stderr`，不再用 `2>&1` 并进 JSON；我猜这个改动的原因是 `nixConfig` 的警告会出现在 stderr 里，这是推测 |
| [`lab/ch20/cachix_hit_host.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/cachix_hit_host.sh) | `env -u CI make ch20` | 退出码 0（`_host`，`CI=true` 时跳过）；41 行；Cachix 上有没有 `pebble` 决定输出是 2 行 (`MISS`) 还是 6 行 (`HIT`)，见“Cachix：推、令牌和公钥”一节 |
| [`lab/ch20/ci_times_host.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/ci_times_host.sh) | `env -u CI make ch20` | 退出码 0（`_host`，`CI=true` 时跳过）；50 行；三种输出，见“CI 耗时”一节；`volatile` |
| [`lab/ch20/diffoscope_host.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/diffoscope_host.sh) | `env -u CI make ch20` | 退出码 0 (`_host`)；48 行；diffoscope 退出 1 被脚本当作期望结果；差异只在 `share/stamp.txt` 一行 |
| [`lab/ch20/ex_bad_signature.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/ex_bad_signature.sh) | `env -u CI make ch20` | 退出码 0；41 行；练习 1 的答案：`flipping byte at offset 1814`，`tampered NAR rejected` |
| [`lab/ch20/fixtures/make_cache.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/fixtures/make_cache.sh) | `grep -l 'fixtures/make_cache.sh' lab/ch20/*.sh \| wc -l` | 31 行；被 3 个实验 `source`（`local_cache.sh`、`unsigned_copy_fail.sh`、`ex_bad_signature.sh`），本身不单独运行，所以命令的输出是 `3` |
| [`lab/ch20/fixtures/smelly.nix`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/fixtures/smelly.nix) | `nixfmt --check lab/ch20/fixtures/smelly.nix` | 33 行；不打印任何东西，退出码 0（格式是对的，写坏的是内容）；statix 7 条、deadnix 2 条 |
| [`lab/ch20/lint_tools.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/lint_tools.sh) | `env -u CI make ch20` | 退出码 0；34 行；`statix warnings: 7`、`deadnix findings: 2` |
| [`lab/ch20/local_cache.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/local_cache.sh) | `env -u CI make ch20` | 退出码 0；37 行；`narinfo files: 6`、`nar files: 6`；`copy with the lab key trusted: ok`；密钥和签名每次不同，`volatile` |
| [`lab/ch20/mirrors_host.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/mirrors_host.sh) | `env -u CI make ch20` | 退出码 0 (`_host`)；67 行；`hello` 的 narinfo：SJTU 144 ms、TUNA 84 ms (HTTP 404)、USTC 153 ms、`cache.nixos.org` 1379 ms；`volatile` |
| [`lab/ch20/narinfo_anatomy.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/narinfo_anatomy.sh) | `env -u CI make ch20` | 退出码 0；21 行；`FileSize: 75355`、`NarSize: 279624`、`Compression: zstd` |
| [`lab/ch20/repro_fail.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/repro_fail.sh) | `env -u CI make ch20` | 退出码 1（`_fail`，预期的）；21 行；stderr 里是 `may not be deterministic` |
| [`lab/ch20/repro_ok.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/repro_ok.sh) | `env -u CI make ch20` | 退出码 0；20 行；`rebuild: identical output` |
| [`lab/ch20/unsigned_copy_fail.sh`](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/unsigned_copy_fail.sh) | `env -u CI make ch20` | 退出码 1（`_fail`，预期的）；21 行；`lacks a signature by a trusted key` |
| [`mini/default.nix`](https://github.com/bfmhno3/firn/blob/ch20/mini/default.nix) | `git diff --stat ch19 ch20 -- mini/default.nix` | 26 行；`1 file changed, 1 insertion(+)`：`nondeterministic` |
| [`mini/pkgs/nondeterministic.nix`](https://github.com/bfmhno3/firn/blob/ch20/mini/pkgs/nondeterministic.nix) | `nix eval --raw .#legacyPackages.x86_64-linux.mini.nondeterministic.name` | 10 行；`nondeterministic`；不在任何检查里 |
| [`tests/lib-unit.nix`](https://github.com/bfmhno3/firn/blob/ch20/tests/lib-unit.nix) | `nix build --no-link --rebuild -L .#checks.x86_64-linux.lib-unit` | 84 行；14 个用例，`14/14 successful`；最后一个是 `expectedError` |

## 练习

**1.** 把本地缓存里一个 NAR 的一个字节改掉。签名还有效吗？复制会怎么失败？

<details>
<summary>参考答案</summary>

答案是 `lab/ch20/ex_bad_signature.sh`（[链接](https://github.com/bfmhno3/firn/blob/ch20/lab/ch20/ex_bad_signature.sh)）。它用 `make_cache "compression=none"` 造缓存（不压缩，`nar/` 里的文件就是 NAR 本身，改一个字节不会破坏压缩流），然后改 `firn-hello` 二进制里字符串 `crc32` 的第一个字节（L24 到 L31）：

```bash
  # Flip the first byte of the string "crc32" in firn-hello's binary: a byte
  # of file contents, not of the NAR framing (the framing has its own errors).
  local offset
  offset="$(grep --text --byte-offset --only-matching crc32 "${nar}" \
    | head -n 1 | cut -d: -f1)"
  echo "flipping byte at offset ${offset}"
  chmod u+w "${nar}"
  printf '\xff' | dd of="${nar}" bs=1 seek="${offset}" conv=notrunc status=none
```

stdout 是：

```text
NAR: nar/1qkzwynk63zvy4i4xx541mygpsm3z42lfc48jzprf6hb8hqj7hnz.nar (16488 bytes)
flipping byte at offset 1814
tampered NAR rejected
```

签名依然有效，因为它签的是 narinfo 里的 `NarHash`，不是 NAR 文件；复制失败在导入时重新计算哈希的那一步，错误是“签名一节”里的 `hash mismatch importing path`，`specified` 是 narinfo 里的哈希，`got` 是改过的 NAR 算出来的。脚本在复制失败时退出 0，在被篡改的 NAR 居然复制成功时退出 1。

</details>

**2.** 写一个最小的 `.nix` 文件，让 `checks.<sys>.lint` 只被 deadnix 拦住，不被 nixfmt 和 statix 拦住。

<details>
<summary>参考答案</summary>

一个只有未使用参数的文件：

```nix
{ unusedArg }:
{
  x = 1;
}
```

放到 `ch20` 拷贝的 `scratch/dead.nix`（`/tmp/s20/fc` 是 `git archive ch20` 解出来的一份拷贝），用 `path:` 构建 `lint` 检查：

```text
$ cd /tmp/s20/fc && nix build --no-link -L "path:/tmp/s20/fc#checks.x86_64-linux.lint" 2>&1 | grep -E '^(firn-lint>|error:)'
firn-lint> Warning: Unused declarations were found.
firn-lint>    ╭─[./scratch/dead.nix:1:3]
firn-lint>  1 │{ unusedArg }:
firn-lint>    │      ╰───── Unused lambda pattern: unusedArg
error: Cannot build '/nix/store/rwiwy8lsnjyyz7jckgi96l8jshsl78yy-firn-lint.drv'.
```

（手敲，不在 `lab/ch20/` 里；`/tmp/s20/fc` 是 `git archive ch20` 解出来的一份拷贝，加了 `scratch/dead.nix`）

`nixfmt --check` 通过（文件已经是它的格式），`statix` 没有意见，轮到 `deadnix --fail` 才失败。

</details>

**3.** 改 `mini/pkgs/nondeterministic.nix`，让它的 `--rebuild` 通过。

<details>
<summary>参考答案</summary>

只要输出不再依赖随机数：把 `cat /proc/sys/kernel/random/uuid > "$out/share/stamp.txt"` 换成固定内容。改过之后在一次性 store 里先构建、再 `--rebuild`：

```text
$ diff <(git -C ~/Projects/firn show ch20:mini/pkgs/nondeterministic.nix) mini/pkgs/nondeterministic.nix
8c8
<     cat /proc/sys/kernel/random/uuid > "$out/share/stamp.txt"
---
>     echo fixed > "$out/share/stamp.txt"
$ A='path:/tmp/s20/fc2#legacyPackages.x86_64-linux.mini.nondeterministic'
$ nix build --store "$S" --no-link --print-out-paths "$A" 2>/dev/null
/nix/store/jbg0m4z4gx19pndqck69l9gjrhk2q87b-nondeterministic
$ nix build --store "$S" --no-link --print-out-paths --rebuild "$A" 2>&1 | grep -v 'untrusted\|accept-flake'; echo "rc=${PIPESTATUS[0]}"
checking outputs of '/nix/store/rl3jlwvjhhjfmjajc2js3fgxch8im54c-nondeterministic.drv'...
/nix/store/jbg0m4z4gx19pndqck69l9gjrhk2q87b-nondeterministic
rc=0
```

（手敲，不在 `lab/ch20/` 里；`S` 是一个一次性的本地 store）

`--rebuild` 退出 0，打印同一个输出路径。

</details>

**4.** 不动 `trusted-public-keys`，让 `unsigned_copy_fail.sh` 里那个被拒绝的复制成功，找出至少两种办法，并说出每一种放松了什么。

<details>
<summary>参考答案</summary>

手册对 `trusted-public-keys` 列的四个条件里，除了“签名在信任列表里”，还有 `require-sigs = false`、store URL 的 `trusted=true`，和内容寻址。前两种我试了，另外再加 `nix copy` 自己的 `--no-check-sigs`。准备：`D` 是“Cachix：推、令牌和公钥”一节那个带签名的 `file://` 缓存的目录（签名用的是 `firn-lab-2`），`H` 是 `firn-hello` 的路径。

```text
$ D=/tmp/s20/cmp; H=/nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0
$ nix copy --from "file://$D/cache" --to "$D/ex4a" "$H" 2>&1 | tail -1
error: cannot add path '/nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0' because it lacks a signature by a trusted key
$ nix copy --from "file://$D/cache" --to "$D/ex4b" --option require-sigs false "$H" 2>&1 | tail -1
copying path '/nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0' from 'file:///tmp/s20/cmp/cache'...
$ nix copy --no-check-sigs --from "file://$D/cache" --to "$D/ex4d" "$H" 2>&1 | tail -1
copying path '/nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0' from 'file:///tmp/s20/cmp/cache'...
$ nix build --store "$D/ex4c" --no-link --option substituters "file://$D/cache?trusted=true" "$H" 2>&1 | tail -2
copying path '/nix/store/zks9mfsn4rqr6z9g6pcj2xqzcsplj0nb-zlib-1.3.2' from 'file:///tmp/s20/cmp/cache'...
copying path '/nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0' from 'file:///tmp/s20/cmp/cache'...
$ nix build --store "$D/ex4e" --no-link --option substituters "file://$D/cache" "$H" 2>&1 | tail -2
warning: ignoring substitute for '/nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0' from 'file:///tmp/s20/cmp/cache', as it's not signed by any of the keys in 'trusted-public-keys'
error: path '/nix/store/w1z9af0553h913s05hwkvd8k2klzwas4-firn-hello-0.1.0' is required, but there is no substituter that can build it
```

（手敲，不在 `lab/ch20/` 里）

第一条是失败的基线。`--option require-sigs false` 关掉所有路径的签名检查，范围最大，一次拿错就是全局的；`nix copy --no-check-sigs` 只关这一次复制；给 substituter 的 URL 加 `?trusted=true` 只信任这一个缓存，最后一条是不加时的对照，错误变成了 `ignoring substitute … not signed by any of the keys`。一个我没想到的细节：把 `?trusted=true` 加在 `nix copy --from` 的 URL 上不起作用，我也试了，结果仍然是 `lacks a signature by a trusted key`；它要放在 `substituters` 里。这是我试出来的，没有去读它为什么。

</details>

## 20 篇的索引

这张表按篇列出 Firn 仓库的标签、文章和那一篇的主要内容，链接都指向各自标签上的快照和对应的文章：

| 篇 | 标签 | 标题 | 主要的 Nix 内容 |
| --- | --- | --- | --- |
| 1 | [`ch01`](https://github.com/bfmhno3/firn/tree/ch01) | [第一次求值：nix repl、三副面孔与一段历史](/posts/nix-by-firn-01-first-eval/) | `nix repl`、`nix eval`、Nix 的三层结构、`nix.conf`、历史 |
| 2 | [`ch02`](https://github.com/bfmhno3/firn/tree/ch02) | [值与类型：attrset、list、字符串与路径](/posts/nix-by-firn-02-values-and-types/) | 值类型、attrset、字符串插值、路径、`//`、`with` |
| 3 | [`ch03`](https://github.com/bfmhno3/firn/tree/ch03) | [函数与惰性求值：thunk、seq 与不动点](/posts/nix-by-firn-03-functions-and-laziness/) | 函数、pattern 参数、thunk、`seq`、`fix`、`extends` |
| 4 | [`ch04`](https://github.com/bfmhno3/firn/tree/ch04) | [builtins 深挖：import、文件、JSON、正则与字符串上下文](/posts/nix-by-firn-04-builtins/) | `import`、文件与 JSON/TOML、正则、字符串上下文、IFD |
| 5 | [`ch05`](https://github.com/bfmhno3/firn/tree/ch05) | [自己写一个 lib：递归、错误处理与测试](/posts/nix-by-firn-05-own-lib/) | 递归与栈、`foldl'`、`runTests`、`--show-trace`、`--debugger` |
| 6 | [`ch06`](https://github.com/bfmhno3/firn/tree/ch06) | [derivation 与 /nix/store：.drv、哈希与沙箱](/posts/nix-by-firn-06-derivations-and-store/) | `.drv`、store 路径、固定输出、沙箱、闭包、GC 根 |
| 7 | [`ch07`](https://github.com/bfmhno3/firn/tree/ch07) | [从零写 stdenv，再拆开 nixpkgs 的 stdenv](/posts/nix-by-firn-07-stdenv-from-scratch/) | builder、phases、`callPackage`、setup hook、bootstrap |
| 8 | [`ch08`](https://github.com/bfmhno3/firn/tree/ch08) | [flake：inputs、outputs、flake.lock 与纯求值](/posts/nix-by-firn-08-flakes/) | flake 结构、锁文件、`follows`、纯求值、registry |
| 9 | [`ch09`](https://github.com/bfmhno3/firn/tree/ch09) | [两代 CLI：nix-env、nix-build、nix-shell 与 nix profile](/posts/nix-by-firn-09-cli-generations/) | 新旧命令对照、channel、profile、GC |
| 10 | [`ch10`](https://github.com/bfmhno3/firn/tree/ch10) | [nixpkgs：callPackage、override、overlay 与 fetcher](/posts/nix-by-firn-10-callpackage-overrides-overlays/) | `callPackage`、`override`、overlay、fetcher、`lib.fileset` |
| 11 | [`ch11`](https://github.com/bfmhno3/firn/tree/ch11) | [打包真项目：Cairn、Sift 与 Pebble](/posts/nix-by-firn-11-packaging-real-projects/) | `makeWrapper`、`buildPythonApplication`、`buildRustPackage` |
| 12 | [`ch12`](https://github.com/bfmhno3/firn/tree/ch12) | [交叉编译与静态链接：pkgsCross、pkgsStatic 与 splicing](/posts/nix-by-firn-12-cross-and-static/) | build/host/target、`pkgsCross`、`pkgsStatic` |
| 13 | [`ch13`](https://github.com/bfmhno3/firn/tree/ch13) | [开发环境：devShell、direnv 与 templates](/posts/nix-by-firn-13-devshells-direnv-templates/) | `mkShell`、direnv、flake 模板 |
| 14 | [`ch14`](https://github.com/bfmhno3/firn/tree/ch14) | [给 nixpkgs 提 PR：by-name、nixpkgs-review 与 channel](/posts/nix-by-firn-14-contributing-to-nixpkgs/) | `pkgs/by-name`、review 工具、channel 的生命周期 |
| 15 | [`ch15`](https://github.com/bfmhno3/firn/tree/ch15) | [模块系统：从零写一个，再读懂 lib.evalModules](/posts/nix-by-firn-15-module-system/) | `options`/`config`、类型、优先级、`mkIf` |
| 16 | [`ch16`](https://github.com/bfmhno3/firn/tree/ch16) | [NixOS：services.cairn、VM 测试与一次 switch](/posts/nix-by-firn-16-nixos-module-and-vm-test/) | NixOS 服务模块、systemd、VM 测试 |
| 17 | [`ch17`](https://github.com/bfmhno3/firn/tree/ch17) | [secrets：为什么不能进 store，以及 sops-nix](/posts/nix-by-firn-17-secrets/) | store 的可读性、sops-nix、age |
| 18 | [`ch18`](https://github.com/bfmhno3/firn/tree/ch18) | [Home Manager：programs.cairn 与用户级配置](/posts/nix-by-firn-18-home-manager/) | `programs.*`、activation、DAG |
| 19 | [`ch19`](https://github.com/bfmhno3/firn/tree/ch19) | [Determinate、FlakeHub 与 Nix 的分叉们](/posts/nix-by-firn-19-determinate-and-forks/) | 安装器、Determinate Nix、FlakeHub、分叉 |
| 20 | [`ch20`](https://github.com/bfmhno3/firn/tree/ch20) | [工程化：CI、Cachix、lint 与可复现性](/posts/nix-by-firn-20-engineering/) | CI、二进制缓存与签名、Cachix、lint、测试的四层、可复现性、更新策略 |

### 接下来读什么

我不想再写一遍总结，所以只留几个具体的去处，都是这个系列里我自己反复回去查的：

- [Nix 2.34 参考手册](https://nix.dev/manual/nix/2.34/)：每一个 `nix` 子命令和每一项设置的出处。这一篇引用的 `trusted-users`、`require-sigs`、`accept-flake-config` 都在它的 `nix.conf` 一页里。
- [Nixpkgs 手册](https://nixos.org/manual/nixpkgs/unstable/)和 [NixOS 手册](https://nixos.org/manual/nixos/unstable/)：第 10 到 14 篇是 Nixpkgs 手册的入口，第 15 到 17 篇是 NixOS 手册的入口。
- [nix.dev](https://nix.dev/)：官方的教程和概念文章，按主题而不是按命令组织。
- 读 Nix 的源码：这一篇我读了 `path-info.cc`、`local-store.cc`、`derivation-builder.cc` 和 `libflake/config.cc` 四处，办法是从一条错误消息 grep 回去。挑一条你经常看到的错误试试。
- [NixOS/rfcs](https://github.com/NixOS/rfcs)：RFC 166 的来龙去脉是这样读到的；要知道一个东西为什么长成现在这样，通常有一个 RFC 或一个很长的 PR 讨论。
- 把 Firn 的 [`ci.yml`](https://github.com/bfmhno3/firn/blob/ch20/.github/workflows/ci.yml) 抄进你自己的仓库，把 `make ci` 换成你自己的检查，然后看第一次冷缓存和第二次热缓存差多少。
