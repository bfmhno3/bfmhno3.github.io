---
title: "secrets：为什么不能进 store，以及 sops-nix"
commentId: "post:nix-by-firn-17-secrets"
published: "2026-11-07 21:00:00 +08:00"
description: "用 Firn 从零学 Nix 第 17 篇：我用 Nix 2.34.9、sops 3.13.3 和锁在 a8627b2 的 sops-nix 起了两个 NixOS 虚拟机节点，同一个口令直接写进配置的那个，系统闭包里有 1 个 store 路径含明文，用 sops-nix 在激活时解到 /run/secrets 的那个是 0；整条 env -u CI make ch17 花了 109.618 秒，其中 VM 测试 102 秒。"
category: Tutorial
tags:
  - Nix
  - NixOS
  - Firn
  - secrets
  - sops-nix
  - age
series: "用 Firn 从零学 Nix"
seriesOrder: 17
draft: false
comment: true
slug: nix-by-firn-17-secrets
---

第 16 篇的“让我意外的事”里，我去查了 lab 主机的 `initialPassword = "firn"` 到底去了哪里：明文，在 store 里，权限 `-r--r--r--`。那个口令是我故意写成演示用的，无所谓，这一篇把问题倒过来问：如果它是真口令呢？我起了两台 NixOS 虚拟机，同一个令牌 `correct-horse-battery-staple`，一台把它直接写进 `environment.etc`，另一台用 sops-nix 从加密文件里在激活时解出来，然后在两台机器的系统闭包里数含这串明文的 store 路径：`sops` 节点 0 个，`naive` 节点 1 个（权限 `444`），而解密出来的文件权限是 `400`，落在 ramfs 上，服务只把 sha256 指纹打进日志。

```text
$ cat out/ch17/secrets_vm_host.stdout
== result already in the store: building with --rebuild
volatile: /dev/kvm: present
== lines printed by the test script
firn: sops_secret_mode 400
firn: sops_secret_fs ramfs
firn: sops_journal sha256=87cbebfeebc05f7c54ac9336c4b4bbec831227a641951a4bde7edd56020f8590
firn: sops_plaintext_store_paths 0
firn: naive_plaintext_store_paths 1
firn: naive_store_file_mode 444
volatile: wall time: 102 s
```

> [!NOTE] 本篇检查点
> 这一篇结束时，Firn 仓库的标签 `ch17` 里：`nixos/modules/secret-demo.nix`（33 行，`services.firn-secret-demo`）、`nixos/tests/secrets.nix`（81 行，两个节点的虚拟机测试）和 `nixos/tests/secrets/` 下三个文件（`age-key.txt` 4 行、`.sops.yaml` 4 行、`secrets.yaml` 17 行，一把只给测试用的公开 age 密钥和它加密的文件）；`flake.nix` 多了 18 行、少了 1 行，多出一个 `sops-nix` 输入和 `checks.x86_64-linux.secrets-vm`，x86\_64-linux 上的检查是 17 个（`ch16` 标签上是 16 个），`flake.lock` 从 2 个节点变成 3 个；`lab/ch17/` 下 8 个 `.sh` 实验和 `fixtures/` 里 2 个文件（其中 `secrets_vm_host.sh` 是 `_host` 实验，`CI=true` 时被跳过），`env -u CI make ch17` 通过（8 个 `ok`）。`git diff --name-only ch16 ch17` 列出 17 个文件，文件清单里一个不少。
> 涉及的概念：store 的可读性（`444` 的文件、`.drv` 里的环境变量、`builtins.readFile`、二进制缓存），解决方案的几个家族（激活时解密、systemd credentials、外部密钥管理），age 的格式与开销，sops 的文件格式与创建规则，age 与 GPG 的取舍，用 ssh-to-age 把主机密钥变成 age 密钥，sops-nix 的激活顺序、`/run/secrets` 与 ramfs，`LoadCredential` 与 `DynamicUser`，测试专用密钥，以及 agenix 的对照。
> 前置：[第 16 篇：NixOS：services.cairn、VM 测试与一次 switch](/posts/nix-by-firn-16-nixos-module-and-vm-test/)。NixOS 测试框架和 `switch-to-configuration` 怎样执行 `activate` 在那里讲过，这一篇直接用；store 路径的哈希在[第 6 篇](/posts/nix-by-firn-06-derivations-and-store/)讲过，store 文件的 `444` 权限在[第 2 篇](/posts/nix-by-firn-02-values-and-types/)里看到过，flake 的输入和锁文件在[第 8 篇](/posts/nix-by-firn-08-flakes/)讲过，模块的选项和 `mkIf` 在[第 15 篇](/posts/nix-by-firn-15-module-system/)讲过。
> 终稿与否：`nixos/modules/secret-demo.nix`、`nixos/tests/secrets.nix`、`nixos/tests/secrets/` 和 `lab/ch17/` 在这里就是终稿；`flake.nix` 和 `flake.lock` 之后的章节还会改（还会加输入）。

整篇的中心思想只有一句：**store 是公开的，所以密文可以进 store，密钥和明文不可以。** 其余所有东西，包括 sops 的文件格式、age、ssh-to-age、激活顺序、为什么 `/run/secrets` 不是 store 路径，都是这句话的推论。

## 环境

这一篇所有输出来自这台机器：NixOS 26.05 (Yarara)，Linux 6.18.60，`x86_64`，上游 Nix 2.34.9，`/dev/kvm` 存在。`nix develop` 里的工具是 sops 3.13.3、age 1.3.1（`age` 和 `age-keygen` 都打印 `v1.3.1`）、ssh-to-age 1.3.0（版本取自 store 路径名，它的 `-version` 打印的是 `dev`）和 OpenSSH_10.6p1。Firn 钉的 nixpkgs 是 `56c02bc00adcf003215cc4bd996d6efaf4cff188`；sops-nix 钉在 `a8627b21b9107c5711c96b84f32a9a4b3d45295f`，2026-08-13 的一个合并提交，我用 GitHub 的提交列表核对过，到 2026-08-23 为止（也就是 nixpkgs 那个锁的日期）它是 master 上的最后一个。文中引用的 nixpkgs 行号是 `56c02bc` 上的行号，sops-nix 的行号是 `a8627b2` 上的，我在本地那两份源码上逐条核对过，链接指向同一个 rev。

我的 shell 里设了 `CI=true`，Firn 的运行器会据此跳过名字以 `_host` 结尾的实验。`lab/ch17/` 里只有一个，`secrets_vm_host.sh`，所以我按惯例跑 `env -u CI make ch17`，在 `nix develop` 里，整条命令（含 `nix develop` 的启动）花了 109.618 秒，8 个实验全部 `ok`。虚拟机测试的结果在这之前已经在 store 里，所以 `secrets_vm_host.sh` 走的是 `--rebuild` 分支，开头那个块里的 `volatile: wall time: 102 s` 是这个分支的墙钟时间，不是第一次构建的时间；每次跑都不同，只当作一个样本。

实验分两类。一类在 `lab/ch17/` 里，我给出文件路径、摘录和 `out/ch17/` 里的真实输出。另一类是我为了回答某个问题当场敲的，每一条都标着“（手敲，不在 `lab/ch17/` 里）”，输出同样是真跑出来的，命令都假设你在 `~/firn` 里。其中三个 Nix 文件放在 `/tmp/scratch17/` 下：`probe_vm.nix` 和 `probe_tmpfs.nix` 是两个借 `secrets-vm` 改测试脚本的虚拟机探针，`keyfile_in_store.nix` 是一个只求值的小配置；三个都过了 `nixfmt --check`，内容贴在用到它们的小节里。两个探针靠 `builtins.getFlake` 把 Firn 当 flake 读进来，所以要加 `--impure`，路径用 `--argstr firnPath "$PWD"` 传，不用环境变量。

还有一条规矩，因为这一篇的主题是密钥：仓库里唯一的私钥是 `nixos/tests/secrets/age-key.txt`，它是我为这个测试生成的、故意公开的那一把，第一行注释就写着 `TEST ONLY`。实验里的其他密钥全是 `age-keygen` 或 `ssh-keygen` 在临时目录里现生成的一次性密钥，用完随目录删掉。我没有读我自己的 `~/.ssh` 和 `~/.config/sops`；需要“没有任何密钥可用”的场景时，我把 `HOME` 指到一个不存在的目录。这一篇也不会贴任何私钥的内容。

## 这一篇停在哪里

先看 flake 对外多了什么。输入是 `sops-nix`，让它的 `nixpkgs` 跟随我们自己的那一份，这样整个系统只有一个 nixpkgs：

```nix
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  # 第 17 章：sops-nix，锁在 2026-08-23 之前 master 的最后一个提交。
  inputs.sops-nix = {
    url = "github:Mic92/sops-nix";
    inputs.nixpkgs.follows = "nixpkgs";
  };
```

输出是 `checks.x86_64-linux.secrets-vm`，把 sops-nix 的 NixOS 模块递给测试：

```nix
          # 第 17 章：sops-nix 与直接写进 store 的两个节点对比。
          secrets-vm = import ./nixos/tests/secrets.nix {
            inherit pkgs;
            sopsModule = sops-nix.nixosModules.sops;
          };
```

锁文件的变化可以直接数。第 8 篇里我数过“`nodes` 一共 2 个：`root` 和 `nixpkgs`”，那是 `ch08` 标签上的状态；到了 `ch17` 它是 3 个，多出来的这个把 `nixpkgs` 输入指回我们自己的节点：

```text
$ jq -c ".nodes | keys" flake.lock
["nixpkgs","root","sops-nix"]
$ jq -c ".nodes[\"sops-nix\"] | {rev: .locked.rev, follows: .inputs.nixpkgs}" flake.lock
{"rev":"a8627b21b9107c5711c96b84f32a9a4b3d45295f","follows":["nixpkgs"]}
$ date -u -d @"$(jq .nodes[\"sops-nix\"].locked.lastModified flake.lock)" +%F
2026-08-13
$ git diff --numstat ch16 ch17 -- flake.nix flake.lock
22	1	flake.lock
18	1	flake.nix
$ nix eval .#checks.x86_64-linux --apply builtins.attrNames --json | jq length
17
```

（手敲，不在 `lab/ch17/` 里）

`"follows":["nixpkgs"]` 就是 `inputs.nixpkgs.follows = "nixpkgs"` 在锁文件里的样子：sops-nix 自己没有锁 nixpkgs，它用根节点的那一个。17 个检查，比 `ch16` 多 `secrets-vm`。

这一篇的顺序是：先把“为什么不能进 store”做成五个实验（威胁模型），再看有哪几类解法，然后分开讲 age 和 sops 这两层加密，再把它们接到 NixOS 上（sops-nix 在激活时做了什么），最后用一个虚拟机测试证明 0 比 1。

## 威胁模型：store 里的东西谁都读得到

[第 6 篇](/posts/nix-by-firn-06-derivations-and-store/)讲过路径名是内容的哈希，[第 2 篇](/posts/nix-by-firn-02-values-and-types/)里我量过 store 文件的权限是 `444`：同一个路径任何用户、任何构建都能直接拿去用，这是 Nix 能共享构建结果的前提。翻译成安全的语言只有一句：**store 没有访问控制。** 这是设计，不是漏洞。我只用这一次比喻：store 像小区门口的公告栏，谁路过都能读，所以能往上贴的只有锁好的信，不能是信本身。

接下来五个实验，每一个砍掉我自己曾经有过的一种“这样应该没事”的想法。

### 想法一：写进 store 的文件，别人读不到

`lab/ch17/store_world_readable.sh` 用 `writeText` 把一个“口令”写成 store 文件，然后看权限：

```bash
#!/usr/bin/env bash
#
# A "secret" written with writeText lands in the Nix store as a file with mode
# 444: every local user can read it, and it stays there until garbage
# collection. The store path itself depends on the content only (no secret
# is needed to find it), so it is not worth hiding either.

set -o errexit
set -o nounset
set -o pipefail

main() {
  local out
  # BAD: a secret passed through the store.
  out="$(nix build --impure --no-link --print-out-paths --expr "
    let pkgs = import ${FIRN_ROOT}/nix/pkgs.nix { };
    in pkgs.writeText \"firn-secret\" \"hunter2-firn-lab\"
  ")"
  echo "mode:  $(stat -c %a "${out}")"
  echo "owner: $(stat -c %U:%G "${out}")"
  echo "read as another user would: $(cat "${out}")"
  [[ "$(stat -c %a "${out}")" == 444 ]] || {
    echo "expected mode 444" >&2
    return 1
  }
}

main "$@"
```

```text
$ cat out/ch17/store_world_readable.stdout
mode:  444
owner: root:root
read as another user would: hunter2-firn-lab
```

权限 `444`，属主是 `root:root`（写进 store 的是守护进程）。`444` 的意思是三类用户都有读位：本机上任何一个账号、任何一个服务，只要能跑 `cat`，就能读到 `hunter2-firn-lab`。脚本里那行 `read as another user would` 是我在自己的 shell 里 `cat` 的，并没有切换用户（所以严格说，它只证明了我能读自己的文件，hah）；真的换成 `nobody` 去读，我放在“`/run/secrets`：符号链接，加一个 ramfs”那一节做。这个文件会一直待到垃圾回收把它清走为止（垃圾回收在[第 9 篇](/posts/nix-by-firn-09-cli-generations/)量过），也就是说，写进去之后再删掉配置，口令并不会跟着消失。

### 想法二：只要输出里不出现，就没事

很多人（包括我）会想：口令只是构建时用一下，不写进输出就行。`lab/ch17/secret_in_drv.sh` 把口令放在 derivation 的属性里，也就是环境变量：

```bash
#!/usr/bin/env bash
#
# A secret in a derivation attribute becomes an environment variable of the
# builder, and the environment is stored in the .drv file. The .drv is a store
# file too (mode 444), so it leaks even if the build output never mentions the
# secret. `nix derivation show` makes it easy to see.

set -o errexit
set -o nounset
set -o pipefail

main() {
  local drv
  # BAD: the token is an attribute of the derivation.
  drv="$(nix-instantiate --expr "
    let pkgs = import ${FIRN_ROOT}/nix/pkgs.nix { };
    in pkgs.runCommand \"firn-drv-secret\" { API_TOKEN = \"hunter2-firn-lab\"; } \"touch \$out\"
  " 2>/dev/null)"
  echo "drv mode: $(stat -c %a "${drv}")"
  echo "== nix derivation show | grep"
  nix derivation show "${drv}" | grep -o '"API_TOKEN":"[^"]*"' || {
    echo "secret not found in the .drv" >&2
    return 1
  }
}

main "$@"
```

```text
$ cat out/ch17/secret_in_drv.stdout
drv mode: 444
== nix derivation show | grep
"API_TOKEN":"hunter2-firn-lab"
```

derivation 的每个属性都是构建器的环境变量（第 6 篇的 `env`），而环境变量原样存在 `.drv` 文件里；`.drv` 也是 store 里的文件，也是 `444`。所以构建出来的东西里没有口令，不等于口令没有泄漏：`nix derivation show` 一条命令就把 `"API_TOKEN":"hunter2-firn-lab"` 取出来了。沙箱挡得住构建器读宿主文件，挡不住别人读 `.drv`。

### 想法三：`readFile` 只是在求值器里读一下

最隐蔽的一种。我把口令放在 `./secret.txt` 里，不提交，只在配置里用 `builtins.readFile` 读进来。`lab/ch17/fixtures/readfile_config.nix` 是这个想法的最小形态：

```nix
# BAD: builtins.readFile 把文件内容读进求值器，再拼进配置文本，
# 文本整个写进 store，任何人都能读。
let
  pkgs = import ../../../nix/pkgs.nix { };
in
pkgs.writeText "app.conf" ''
  token = ${builtins.readFile ./secret.txt}
''
```

`lab/ch17/readfile_leak.sh` 构建它，把 store 里的文件打出来：

```bash
#!/usr/bin/env bash
#
# builtins.readFile ./secret.txt used inside a config text copies the secret
# into the store when the config is built. Builds fixtures/readfile_config.nix
# and prints the world-readable store file.

set -o errexit
set -o nounset
set -o pipefail

main() {
  local out
  out="$(nix build --no-link --print-out-paths \
    --file "${FIRN_ROOT}/lab/ch17/fixtures/readfile_config.nix")"
  echo "store path: /nix/store/<hash>-${out#/nix/store/*-}"
  echo "mode: $(stat -c %a "${out}")"
  echo "== content"
  cat "${out}"
  grep -q 'firn-lab-readfile-secret-4f2a' "${out}"
}

main "$@"
```

```text
$ cat out/ch17/readfile_leak.stdout
store path: /nix/store/<hash>-app.conf
mode: 444
== content
token = firn-lab-readfile-secret-4f2a
```

`${builtins.readFile ./secret.txt}` 是字符串插值，求值器把文件内容读成一个字符串，拼进 `writeText` 的参数，于是文本整个变成 store 文件的内容。它不止进输出，还进 `.drv`，我数了一下：

```text
$ nix derivation show "${drv}" | jq -c '[paths(type == "string" and contains("firn-lab-readfile-secret-4f2a"))]'
[["derivations","27w17j4j68f56g31zfvzg9djmjbh4sn7-app.conf.drv","env","text"]]
$ stat -c %a "${drv}"
444
```

（手敲，不在 `lab/ch17/` 里）

这里的 `drv` 是 `drv="$(nix-instantiate lab/ch17/fixtures/readfile_config.nix)"` 在同一个 shell 里设的变量；`env.text` 就是 `writeText` 的 `text` 参数。两份拷贝，一份在 `.drv`，一份在输出，都是 `444`。

这一条的危险在于它看起来像“配置没有提交，所以安全”。`.gitignore` 管得住 Git，管不住求值器。“sops-nix 在激活时做了什么”那一节会看到，sops-nix 给密钥路径选项挂了一个类型，专门拦住一种更直白的写法（把私钥文件放进 store），但 `readFile` 本身它拦不住，因为那是在任何模块之前发生的。

### 想法四：flake 里没有人引用它

flake 求值的第一步是把整个 Git 工作树里被跟踪的文件复制进 store（第 8 篇量过这份拷贝的大小）。所以一个被 `git add` 的明文文件，哪怕没有任何表达式读它，也已经在 store 里了：

```text
$ src="$(nix flake metadata --json | jq -r .path)"; grep -rl firn-lab-readfile-secret-4f2a "${src}"
/nix/store/67a826cqpv5xldk5m538lanh6y7zbpab-source/lab/ch17/fixtures/secret.txt
/nix/store/67a826cqpv5xldk5m538lanh6y7zbpab-source/lab/ch17/readfile_leak.sh
$ stat -c %a "${src}/lab/ch17/fixtures/secret.txt"
444
```

（手敲，不在 `lab/ch17/` 里）

`secret.txt` 是 `lab/ch17/fixtures/` 里被 Git 跟踪的那个夹具；第二个命中是 `readfile_leak.sh` 自己，它里面有用来 `grep` 的那个字符串。这个 flake 的源码路径对所有人可读，所以“被跟踪的文件”本身就是泄漏面。

### 想法五：只在我自己的机器上，缓存不会泄漏

store 路径一旦被 `nix copy` 或者 CI 推到二进制缓存，缓存的读者就是它的读者。我把同一个 `writeText` 口令 `nix copy` 到一个本地的文件缓存，先关掉压缩，再用默认压缩：

```text
$ P="$(nix build --impure --no-link --print-out-paths --expr "let pkgs = import ./nix/pkgs.nix { }; in pkgs.writeText \"firn-secret\" \"hunter2-firn-lab\"")"
$ nix copy --to "file:///tmp/scratch17/cache?compression=none" "${P}"
copying 1 paths...
copying path '/nix/store/0rza5ai7936cxjg6bbzav9hcvzsggrk1-firn-secret' to 'file:///tmp/scratch17/cache'...
$ ls /tmp/scratch17/cache/nar
169x4x18amnbycmw5g8sgz1zinsfhkli6p6azfmhiqqxvbg5vd4c.nar
$ grep -rl hunter2-firn-lab /tmp/scratch17/cache
/tmp/scratch17/cache/nar/169x4x18amnbycmw5g8sgz1zinsfhkli6p6azfmhiqqxvbg5vd4c.nar
$ rm -rf /tmp/scratch17/cache; nix copy --to "file:///tmp/scratch17/cache" "${P}"; ls /tmp/scratch17/cache/nar; grep -rl hunter2-firn-lab /tmp/scratch17/cache; echo "grep rc=$?"
copying 1 paths...
copying path '/nix/store/0rza5ai7936cxjg6bbzav9hcvzsggrk1-firn-secret' to 'file:///tmp/scratch17/cache'...
16rd85qkrp43njcvy70apac6j43d2wp729pj6w8db5girsqcvr8d.nar.xz
grep rc=1
$ xz -dc /tmp/scratch17/cache/nar/*.nar.xz | grep -c hunter2-firn-lab
1
```

（手敲，不在 `lab/ch17/` 里）

不压缩时，`grep` 直接在 `.nar` 里找到了明文；换成默认的 xz 压缩，`grep` 什么也没找到 (`rc=1`)，可 `xz -dc` 解开再数，是 1 处。压缩不是加密，这一点我嘴上知道，手上没试过，直到看到 `rc=1` 的时候心里还是松了一下。这个缓存只是 `/tmp` 下的一个目录，没有推到任何公共缓存，也没有签名；二进制缓存怎么搭、怎么签，留给第 20 篇。

## 解法的几个家族

五个实验之后，要求其实只剩一条：**明文只在运行时出现，而且不经过 store、不经过 Git、不经过缓存。** 我知道的做法分四类，每一类的取舍是“钥匙放在哪里、明文什么时候出现”：

| 家族 | 密文在哪 | 钥匙在哪 | 明文什么时候出现 | 代价 |
| --- | --- | --- | --- | --- |
| 带外文件 | 没有密文，文件本身 | 无 | 你手工 `scp` 的那一刻 | 没有 Nix 参与，配置里只有一个路径字符串；重装机器要自己记得补文件 |
| 激活时解密 (sops-nix, agenix) | Git 和 store 里 | 目标机器上的一把私钥 | 系统激活时，写进 `/run` | 要管理这把私钥怎么到达机器；密文 `444` 地躺在 store 里，安全完全取决于私钥 |
| systemd credentials | 单元文件里 (`SetCredentialEncrypted=`)，或磁盘上的加密文件 (`LoadCredentialEncrypted=`)，或根本没有（`LoadCredential=` 读一个已存在的文件） | 机器上的 `/var/lib/systemd/credential.secret`，或 TPM2 | 服务启动时，进服务私有的目录 | 密文绑定一台机器，在别处生成不了；明文文件从哪来还是要解决 |
| 外部密钥管理（Vault、OpenBao、云厂商的 KMS） | 不在仓库里 | 在服务端，凭身份访问 | 应用运行时去取 | 多一个要运维的服务；我这篇没有运行它 |

第一类是所有别的方案的底线：只要你愿意手工放文件，`LoadCredential = "token:/var/lib/firn/token"` 就够了，store 里只有一个路径字符串。它的毛病是不可重现，这正是我们用 Nix 想摆脱的状态。第二类是这一篇的主角，因为它是唯一一种能把密文放进配置仓库、让整个系统仍然是“一个表达式的结果”的做法。第三类和第二类不冲突，而是下游：sops-nix 把明文放在 `/run/secrets`，服务再用 `LoadCredential` 把它拿走，这正是 `secret-demo.nix` 做的事，“写一个用这个密文的服务”那一节会看到。第四类我没有运行过，只留一个和这一篇有关的事实：sops 自己可以用 AWS KMS、GCP KMS、Azure Key Vault 和 HashiCorp Vault 当“主密钥”（见 [sops 的 README](https://github.com/getsops/sops/blob/v3.13.3/README.rst) 和[文档](https://getsops.io/docs/)），也就是把“谁能解开数据密钥”这件事交给密钥管理服务的访问控制，这一点我读了文档，没有试。

`systemd-creds` 这一类，我在虚拟机里敲了一遍往返，输出放在“虚拟机里的 systemd-creds”那一节：一个 28 字节的令牌加密之后是 171 字节，解密回来是同一个令牌，systemd 还顺便警告它用来加密的 `credential.secret` 不在加密介质上。它解决的是另一个问题：怎么把一个已经在机器上的东西安全地交给某个服务，而不是怎么把它安全地送到机器上。

## age：先把最底下那层加密看清楚

sops 和 sops-nix 的所有加密，最后落到一把 age 密钥上。所以我先单独跑一遍 age，看它的文件长什么样。`lab/ch17/age_roundtrip.sh` 的主体：

```bash
main() {
  cd "${LAB_TMP}"
  age-keygen -o key.txt 2>/dev/null
  local pub
  pub="$(age-keygen -y key.txt)"
  echo "volatile: recipient: ${pub}"

  printf 'correct-horse-battery-staple\n' >plain.txt
  age -r "${pub}" -o plain.txt.age plain.txt
  echo "== header of plain.txt.age"
  head -c 21 plain.txt.age
  echo
  sed -n 2p plain.txt.age | cut -d' ' -f1-2
  echo "== sizes (bytes)"
  echo "plain.txt:     $(wc -c <plain.txt)"
  echo "plain.txt.age: $(wc -c <plain.txt.age)"
  echo "key.txt:       $(wc -c <key.txt)"

  age -d -i key.txt -o roundtrip.txt plain.txt.age
  cmp plain.txt roundtrip.txt
  echo "== decrypted"
  cat roundtrip.txt

  echo "== a second key cannot decrypt"
  age-keygen -o other.txt 2>/dev/null
  if age -d -i other.txt plain.txt.age 2>&1 | sed 's/^/volatile: /'; then
    echo "unexpected success" >&2
    return 1
  fi
}
```

```text
$ cat out/ch17/age_roundtrip.stdout
volatile: recipient: age1d9xn66jsx8l2yflu7j5q7ca45q6pyj97zjfqf4vx98jw65xenykqcphgk0
== header of plain.txt.age
age-encryption.org/v1
-> X25519
== sizes (bytes)
plain.txt:     29
plain.txt.age: 229
key.txt:       189
== decrypted
correct-horse-battery-staple
== a second key cannot decrypt
volatile: age: error: no identity matched any of the recipients
volatile: age: report unexpected or unhelpful errors at https://filippo.io/age/report
```

四条命令就是 age 的全部：`age-keygen` 生成密钥，`age -r` 加密给一个公钥 (recipient)，`age -d -i` 用私钥 (identity) 解密，`age-keygen -y` 从私钥算回公钥。头部是 `age-encryption.org/v1` 和一个 `-> X25519` 的 stanza；换一把密钥解密，报的是 `no identity matched any of the recipients`（标着 `volatile:` 的行，措辞是 age 的，不保证稳定）。

最让我想拆开看的是尺寸：29 字节明文（`correct-horse-battery-staple` 加换行），229 字节密文，密钥文件 189 字节。多出来的 200 字节是什么？[age 的规范](https://github.com/C2SP/C2SP/blob/main/age.md)把格式写得很清楚：文本头部把一个 128 位的“文件密钥”包给每一个 recipient，二进制的载荷是 16 字节随机数加上若干块 ChaCha20-Poly1305 密文，每块 64 KiB、带 16 字节的认证标签。我按这个算：头部是 4 行，载荷是 16 + 29 + 16。我用手敲命令验证这个算术，并加一个有两个 recipient 的文件：

```text
$ wc -c one.age two.age
229 one.age
327 two.age
556 total
$ head -n 4 one.age | wc -c; tail -c +$(( $(head -n 4 one.age | wc -c) + 1 )) one.age | wc -c
168
61
$ grep -c "^-> " one.age two.age
one.age:1
two.age:2
```

（手敲，不在 `lab/ch17/` 里）

`168 + 61 = 229`，和算出来的载荷 `16 + 29 + 16 = 61` 对得上。第二个 recipient 多一个 stanza，文件多 98 字节 (`327 - 229`)。所以密文大小是“明文，加 102 字节固定部分，加每个 recipient 98 字节”：固定部分是版本行 22、结尾的 MAC 行 48、随机数 16 和认证标签 16，一个 recipient 的 stanza 是 98。这是我拿规范和两个样本对出来的，只验证了一个明文长度和一到两个 recipient。有一个小细节值得记住：文件头是明文，有几个 recipient 一眼就能数出来，只有“解出来是什么”是秘密。

### 为什么是 age，不是 GPG

sops 同时支持 age 和 PGP。我不是 GPG 的专家，所以这一节的取舍主要引用别人的话，自己只量了一个尺寸。[sops 文档的 age 一页](https://getsops.io/docs/usage/identities/age/)说：“It's recommended to use age over PGP, if possible.” [它的安全页](https://getsops.io/docs/security/)把“PGP 密钥常常被误用，要么主人把它从一台机器拷到另一台，要么忘在一台没人用的机器上”列为一个威胁。[age 的 README](https://github.com/FiloSottile/age) 用一句话描述自己：small explicit keys, post-quantum support, no config options, and UNIX-style composability。我从这几句话里读出的取舍是：age 没有钥匙环、没有信任网、没有配置，一把密钥就是一个 189 字节的文本文件，所以把它放进一个激活脚本、一个测试夹具或者一个 ramfs 都很简单；代价是它没有 GPG 那套撤销和过期的机制（这一点是我从“没有配置”推出来的，没有查证）。要注意，安全页开头有一条维护者的说明：这一部分由 SOPS 的原作者在 Mozilla 工作时写成，保留是出于历史原因，“not necessarily representative of the views of the current maintainers”。所以那条 PGP 的理由我只当作历史背景，不当作现在的结论。

我手头有 GnuPG，所以补一个同样 29 字节明文的尺寸对比：在临时的 `GNUPGHOME` 里现生成一把一次性的 ed25519/cv25519 密钥，加密同一份 `correct-horse-battery-staple`。

```text
$ export GNUPGHOME="$(mktemp -d)"; chmod 700 "${GNUPGHOME}"; cd "$(mktemp -d)"
$ gpg --version | head -n 1
gpg (GnuPG) 2.4.9
$ gpg --batch --pinentry-mode loopback --passphrase "" --quick-generate-key firn-lab ed25519 cert,sign 1d 2>/dev/null; gpg --batch --pinentry-mode loopback --passphrase "" --quick-add-key "$(gpg --list-keys --with-colons | awk -F: "/^fpr/{print \$10; exit}")" cv25519 encr 1d 2>/dev/null; echo rc=$?
gpg: checking the trustdb
gpg: marginals needed: 3  completes needed: 1  trust model: pgp
gpg: depth: 0  valid:   1  signed:   0  trust: 0-, 0q, 0n, 0m, 0f, 1u
gpg: next trustdb check due at 2026-11-08
rc=0
$ printf 'correct-horse-battery-staple\n' > p.txt
$ gpg --batch --trust-model always -r firn-lab -o p.txt.gpg --encrypt p.txt && wc -c p.txt p.txt.gpg
 29 p.txt
191 p.txt.gpg
220 total
$ gpg --batch --pinentry-mode loopback --passphrase "" --decrypt p.txt.gpg 2>/dev/null
correct-horse-battery-staple
```

（手敲，不在 `lab/ch17/` 里）

同样的 29 字节，age 是 229 字节，GnuPG 是 191 字节：GnuPG 的二进制格式比 age 的文本头更短。这是一个样本，一种密钥类型，我没有拿它推论别的；age 的 229 字节里 168 字节是人眼能读的文本头，这是它换来“头部可读、带版本行”的价格，至于这笔交易值不值，一个样本说不了。

sops-nix 两种都支持：模块里既有 `sops.age.keyFile` 和 `sops.age.sshKeyPaths`（`modules/sops/default.nix` 的 [L337](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/modules/sops/default.nix#L337) 到 [L372](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/modules/sops/default.nix#L372)），也有 `sops.gnupg.home` 和 `sops.gnupg.sshKeyPaths`（L374 起）。这一篇只用 age，GPG 那一半我没有运行。

## sops：加密的是值，不是文件

age 加密一整个文件，得到一个不透明的 blob；放进 Git，每次改动你只看到一个整体变了。sops 的想法是反过来：保留文件的结构，只加密值。`lab/ch17/sops_roundtrip.sh` 在临时目录里做完整的一圈：

```bash
main() {
  cd "${LAB_TMP}"
  age-keygen -o key.txt 2>/dev/null
  local pub
  pub="$(age-keygen -y key.txt)"
  cat >.sops.yaml <<YAML
creation_rules:
  - path_regex: secrets\.yaml$
    age: ${pub}
YAML
  cat >secrets.yaml <<'YAML'
firn:
  token: correct-horse-battery-staple
  port: 8080
YAML
  cp secrets.yaml plain.yaml

  sops --encrypt --in-place secrets.yaml
  echo "== encrypted secrets.yaml (random parts elided)"
  sed -E \
    -e 's/ENC\[AES256_GCM,data:[^,]*,iv:[^,]*,tag:[^,]*,type:([a-z]+)\]/ENC[AES256_GCM,data:...,type:\1]/' \
    -e '/^            [A-Za-z0-9+\/=]+$/d' \
    -e 's/(recipient: ).*/\1<age public key>/' \
    -e 's/(lastmodified: ).*/\1<time>/' \
    -e 's/(mac: ).*/\1ENC[AES256_GCM,data:...]/' \
    secrets.yaml

  echo "== plaintext leaks?"
  if grep -q 'correct-horse-battery-staple' secrets.yaml; then
    echo "plaintext found in the encrypted file" >&2
    return 1
  fi
  echo none

  echo "== sops --decrypt"
  SOPS_AGE_KEY_FILE=key.txt sops --decrypt secrets.yaml | tee decrypted.yaml
  # sops 重新缩进了 YAML（2 格变 4 格），内容相同，所以忽略空白。
  diff -w plain.yaml decrypted.yaml
}
```

```text
$ cat out/ch17/sops_roundtrip.stdout
== encrypted secrets.yaml (random parts elided)
firn:
    token: ENC[AES256_GCM,data:...,type:str]
    port: ENC[AES256_GCM,data:...,type:int]
sops:
    age:
        - enc: |
            -----BEGIN AGE ENCRYPTED FILE-----
            -----END AGE ENCRYPTED FILE-----
          recipient: <age public key>
    lastmodified: <time>
    mac: ENC[AES256_GCM,data:...]
    unencrypted_suffix: _unencrypted
    version: 3.13.3
== plaintext leaks?
none
== sops --decrypt
firn:
    token: correct-horse-battery-staple
    port: 8080
```

脚本里的 `sed` 把每一处随机内容（密文、iv、tag、MAC、age 的 stanza、时间）换成了占位符，剩下的就是结构本身：

- `firn:` 和 `token:`、`port:` 这些键是明文，缩进被 sops 从我写的 2 格改成了 4 格（脚本里 `diff -w` 就是为了忽略这个）。
- 每个值变成 `ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]`。`type` 记住了原来的类型：`8080` 是 `int`，解密回来还是整数，不是字符串。
- `sops.age` 是一个列表，每个 recipient 一项，`enc` 里是一个 age 加密块，被加密的是同一个“数据密钥”（这个文件所有值共用一个对称密钥，每个值有自己的 iv 和 tag，见 [sops 参考文档](https://getsops.io/docs/reference/)）。谁的私钥能解开任何一项，就拿到数据密钥，就能解开整个文件。
- `mac` 是对所有值算的一个 MAC，用同一个数据密钥加密；`lastmodified` 是时间；`unencrypted_suffix: _unencrypted` 是默认值，意思是键名以 `_unencrypted` 结尾的值不加密；`version: 3.13.3` 是写这个文件的 sops 的版本。

仓库里的 `nixos/tests/secrets/secrets.yaml` 是同一个形状的文件。它有 17 行，其中有几行很长（`mac` 一行就有 288 个字符），所以我用 `cut` 截到 76 列看：

```text
$ cut -c1-76 nixos/tests/secrets/secrets.yaml
firn:
    token: ENC[AES256_GCM,data:o+qUEutnF+4oUfe+MHdBz6xVqSD/ctvCv36BuA==,iv:p
sops:
    age:
        - enc: |
            -----BEGIN AGE ENCRYPTED FILE-----
            YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBEUmlwdjZaSHp4T0N6R2dt
            TmNWV3NoS2w3L280a3o0SUlBdndjS01uY3pjClo5a1J2c05wVlF2bGI1dDdzMGpa
            VHNjZlpDRkpMMTQ0UkszalBJQlNqU28KLS0tIENhVEY2bjhqWVpRUTNaN3lhZ2Jz
            OWdUK0dCMnRMWnNSZy9MS0VtcGpuL0kKXkCwHMmNpqP8ycATe083mW+g7x7F60Xd
            jZ2KPPmKfis30jDf9a0J2V6DSQD4UvT0LMME/iYctKOUnP23YBALjA==
            -----END AGE ENCRYPTED FILE-----
          recipient: age1mc54q6uvuz9p3t6xtdrruuzy9twhtyqkay6tpvlaqzk3nmprzpj
    lastmodified: "2026-11-07T12:00:32Z"
    mac: ENC[AES256_GCM,data:4N8hj0U5SzvpkSD37D5kd4+koaeecfP8k868Jgltww6t0B8
    unencrypted_suffix: _unencrypted
    version: 3.13.3
```

（手敲，不在 `lab/ch17/` 里）

那个 `enc` 块里的 base64，解开第一行是 `age-encryption.org/v1`，也就是说 sops 把数据密钥交给了 age 去加密。整个文件进 Git 是安全的，进 store 也是（它就是以后会被 `444` 地放进 store 的东西）：安全的依据不是“没人看得到”，而是“没有私钥就解不开”。

### 创建规则：`.sops.yaml`

`sops --encrypt` 怎么知道该加密给谁？答案是 `.sops.yaml` 里的 `creation_rules`。仓库里这个文件一共 4 行，我把它整个贴出来：

```yaml
# 创建规则：文件名匹配 secrets.yaml 时，用这个测试专用的 age 公钥加密。
creation_rules:
  - path_regex: secrets\.yaml$
    age: age1mc54q6uvuz9p3t6xtdrruuzy9twhtyqkay6tpvlaqzk3nmprzpjq8euxe6
```

规则是一个列表，按顺序看，第一个 `path_regex` 匹配的规则生效（[sops 文档的配置文件一页](https://getsops.io/docs/usage/identities/config-file/)里的注释是 “creation rules are evaluated sequentially, the first match wins”）。`path_regex` 是对文件相对 `.sops.yaml` 的路径做匹配，所以 `secrets\.yaml$` 管的是名字以 `secrets.yaml` 结尾的文件，`age:` 是 recipient 的公钥。我手敲了几条命令，看这个机制失败时是什么样：

```text
$ age-keygen -o key.txt 2>/dev/null
$ printf 'firn:\n  token: correct-horse-battery-staple\n' > secrets.yaml
$ sops --encrypt secrets.yaml
config file not found, or has no creation rules, and no keys provided through command line options
$ printf 'creation_rules:\n  - path_regex: other\\.yaml$\n    age: %s\n' "$(age-keygen -y key.txt)" > .sops.yaml
$ cut -c1-24 .sops.yaml
creation_rules:
  - path_regex: other\.y
    age: age15ln4ue48e7k
$ sops --encrypt secrets.yaml
error loading config: no matching creation rules found
$ sops --encrypt --age "$(age-keygen -y key.txt)" secrets.yaml
error loading config: no matching creation rules found
```

（手敲，不在 `lab/ch17/` 里）

三种情形：没有 `.sops.yaml` 也没有 `--age`，报“没有创建规则”；有一个不匹配的 `.sops.yaml`，报“没有匹配的规则”；最后一条让我意外，我以为命令行上显式给的 `--age` 可以绕过规则，结果有一个存在但不匹配的 `.sops.yaml` 时，它照样报错。要用 `--age`，得先把 `.sops.yaml` 挪走（“键是明文，但改不得”一节的命令，第一行就是 `rm`）。

这套规则同样可以复现仓库里那个文件。我用仓库里的 `.sops.yaml` 加密一个同样内容的新文件，大小正好是 1137 字节，和仓库里的 `secrets.yaml` 一样（内容当然不同，每次的随机数都不同），再用测试私钥解开：

```text
$ FIRN="$PWD"
$ cd "$(mktemp -d)"
$ cp "${FIRN}/nixos/tests/secrets/.sops.yaml" . && printf "firn:\n  token: correct-horse-battery-staple\n" > secrets.yaml
$ sops --encrypt --in-place secrets.yaml && wc -c secrets.yaml
1137 secrets.yaml
$ SOPS_AGE_KEY_FILE="${FIRN}/nixos/tests/secrets/age-key.txt" sops --decrypt secrets.yaml
firn:
    token: correct-horse-battery-staple
```

（手敲，不在 `lab/ch17/` 里）

`FIRN` 是 `~/firn`，加密在一个临时目录里做。输出里的 `1137` 是这次复现的结果：内容当然不同（每次的随机数都不同），但长度和仓库里的 `secrets.yaml` 一样；这说明仓库里的文件和这套命令产出的是同一个形状，不说明它当初就是这么生成的，我不知道。加密只需要公钥，不需要私钥，这是 age 的性质，sops 沿用了它，所以 CI 或者同事可以替你创建新的加密文件而不碰你的私钥（改一个已有的文件要先解开校验 MAC，那就需要私钥了）。

### 键是明文，但改不得

键是明文的，那我能不能改键名？不能，而且失败的方式有点吓人：

```text
$ rm .sops.yaml
$ sops --encrypt --age "$(age-keygen -y key.txt)" secrets.yaml > a.yaml
$ sops --encrypt --age "$(age-keygen -y key.txt)" secrets.yaml > b.yaml
$ grep -h 'token:' a.yaml b.yaml | cut -c1-72
    token: ENC[AES256_GCM,data:mvxFDm2uLMXa+bvxEMHA2o4Pfji2+XBIoiPN5Q==,
    token: ENC[AES256_GCM,data:/cYnAffTjKEXZ0DqOAyzRW6wRKPAlseIkx9Aaw==,
$ export SOPS_AGE_KEY_FILE=key.txt
$ sops --decrypt a.yaml
firn:
    token: correct-horse-battery-staple
$ sed 's/^    token:/    tokem:/' a.yaml > renamed.yaml
$ sops --decrypt renamed.yaml; echo "rc=$?"
Error decrypting tree: Error walking tree: Could not decrypt value: Could not decrypt with AES_GCM: cipher: message authentication failed
rc=25
```

（手敲，不在 `lab/ch17/` 里）

`a.yaml` 和 `b.yaml` 是同一份明文、同一个 recipient、分两次加密的结果，两个 `token` 的密文不一样：每个值有自己的随机 iv。把 `token` 改成 `tokem` 之后，解密报 `message authentication failed`，退出码 25。我原来以为改一个明文的键名最多让 sops 找不到那个键，实际上它让整个解密失败。原因在 [sops 的参考文档](https://getsops.io/docs/reference/)里：加密一个值时，从根到它的键名串起来的路径被当作 AEAD 的附加认证数据 (aad)，所以键名参与了认证；此外还有一个 MAC 覆盖所有的值，防止有人悄悄加上或删掉一个值。键留在明文是为了 `git diff` 可读，改键名不是它允许的操作。

## 主机密钥：ssh-to-age

到这里还缺一环：解密用的私钥放在目标机器的哪里，怎么放进去。sops-nix 的第一个回答是：用机器已经有的东西。每台开了 sshd 的 NixOS 机器都有一把 ed25519 的主机密钥，`ssh-to-age` 能把它的公钥变成一个 age recipient，把私钥变成一个 age identity。`lab/ch17/ssh_to_age.sh` 在临时目录里造一把一次性的 ed25519 密钥来演示：

```bash
#!/usr/bin/env bash
#
# NixOS machines already have an ed25519 SSH host key. ssh-to-age turns the
# public half into an age recipient (what goes into .sops.yaml) and the
# private half into an age identity (what sops-nix does at activation when
# sops.age.sshKeyPaths is set). Uses a throwaway key in LAB_TMP, never
# /etc/ssh.

set -o errexit
set -o nounset
set -o pipefail

main() {
  cd "${LAB_TMP}"
  ssh-keygen -q -t ed25519 -N '' -C firn-lab -f host_key
  echo "volatile: ssh public key: $(cut -d' ' -f1-2 host_key.pub)"

  local recipient identity
  recipient="$(ssh-to-age -i host_key.pub)"
  echo "volatile: age recipient: ${recipient}"
  identity="$(ssh-to-age -private-key -i host_key)"
  echo "identity prefix: ${identity:0:15}"

  # 同一把密钥的两个视图必须对得上：用转换出的私钥算回公钥。
  printf '%s\n' "${identity}" >identity.txt
  [[ "$(age-keygen -y identity.txt)" == "${recipient}" ]] || {
    echo "recipient and identity do not match" >&2
    return 1
  }
  echo "age-keygen -y of the converted private key == converted public key"

  printf 'host secret\n' | age -r "${recipient}" -o host.age
  age -d -i identity.txt host.age
}

main "$@"
```

```text
$ cat out/ch17/ssh_to_age.stdout
volatile: ssh public key: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICt4q4ymNTkTEmOtFApSNingju03OKkDQnBGiupF76jO
volatile: age recipient: age1a58wqkp68cxdjmzhaya55ywxtpy7gs36hfrfymv7cpz9g7hgupyqnw3egr
identity prefix: AGE-SECRET-KEY-
age-keygen -y of the converted private key == converted public key
host secret
```

三个要点。一是公钥这半边是公开信息，所以 `ssh-keyscan` 一台远程机器就能拿到它的 recipient，不需要登录（[ssh-to-age 的 README](https://github.com/Mic92/ssh-to-age) 的例子就是这么用的，我这里没有扫任何机器）。二是私钥这半边，输出里只打印了 `AGE-SECRET-KEY-` 这个前缀，脚本没有把它打出来；它被写进临时文件，再用 `age-keygen -y` 算回公钥，和直接转换的公钥比对相等，才说明“两个视图是同一把密钥”。三是 age 真的拿它解开了东西：`host secret` 是用转换出来的 recipient 加密、转换出来的 identity 解密的往返。

顺带一提，sops 自己的文档说它现在也能把 `ssh-ed25519 AAAA...` 直接当 recipient、用 `~/.ssh/id_ed25519` 解密（见 [age 一页](https://getsops.io/docs/usage/identities/age/)），sops-nix 的源码里还有一条注释，说 sops 3.10 起会无条件去 `$HOME/.ssh/` 找 ssh 密钥（`modules/sops/default.nix` 的 [L33 到 L41](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/modules/sops/default.nix#L33-L41)，所以激活时它把 `HOME` 设成 `/var/empty`）。这一篇走 ssh-to-age 这条路，因为 sops-nix 的激活代码就是这样处理主机密钥的；直接用 ssh 公钥当 recipient 那条路我没有试。

sops-nix 里对应的是两个默认值。`sops.age.sshKeyPaths` 的默认值是“`services.openssh.hostKeys` 里类型为 ed25519 的那些”（`modules/sops/default.nix` 的 [L182 到 L191](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/modules/sops/default.nix#L182-L191) 是 `defaultImportKeys`，[L364 到 L371](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/modules/sops/default.nix#L364-L371) 把它接到这个选项），它同时排除了落在 `/run/secrets` 下的路径，以免“密钥本身要靠 sops 来部署”这个死循环。激活时，`sops-install-secrets` 对每一个这样的路径读私钥、转成 age 密钥，追加进一个文件：[`importAgeSSHKeys`](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/pkgs/sops-install-secrets/main.go#L886-L912) 里调的就是 `agessh.SSHPrivateKeyToAge`。这个文件放在 ramfs 挂载点里（`/run/secrets.d/age-keys.txt`，虚拟机里能看到它），不放在磁盘上。

我没有在真机上走一遍“新机器接入”的流程，以下是我读文档和源码得到的理解，不是我做过的实验：新机器第一次启动，sshd 生成主机密钥；你用 `ssh-keyscan host | ssh-to-age` 拿到它的 recipient，写进 `.sops.yaml`，对已有的文件跑 `sops updatekeys`，让每个文件的数据密钥多包一份给新机器；重新部署，机器激活时就能解开。这里有一个鸡生蛋的环节：在新机器第一次启动之前，没有主机密钥，就没有 recipient，也就不可能有“第一次启动就带着正确密文”的镜像（除非你预先把一把你控制的密钥放进镜像，这就回到了“密钥怎么到机器上”这个问题本身）。主机密钥丢了也是同样的问题：它是这台机器的信任根，重装系统时不保留 `/etc/ssh`，旧密文就解不开，得靠别的 recipient（比如你自己的密钥）来解开再换新的。

## sops-nix 在激活时做了什么

到这里，加密文件进了仓库，主机密钥或者别的密钥在机器上。剩下的是 sops-nix 这一半：一个 NixOS 模块加一个 Go 程序 `sops-install-secrets`。模块在求值时做的事很少，它把你声明的每个 `sops.secrets.<name>` 变成一个清单（manifest，一个 JSON 文件，放在 store 里），再注册一段激活脚本 `setupSecrets`；真正解密的是激活时运行的那个 Go 程序，它读清单，用 sops 的库解密，把明文写进 `/run`。

仓库里 `sops` 节点的配置是这样（`nixos/tests/secrets.nix` 的节点部分）：

```nix
{ pkgs, sopsModule }:
pkgs.testers.runNixOSTest {
  name = "secrets";

  nodes.sops = {
    imports = [
      sopsModule
      ../modules/secret-demo.nix
    ];

    sops = {
      defaultSopsFile = ./secrets/secrets.yaml;
      age.keyFile = "/run/age-key.txt";
      secrets."firn/token" = { };
    };

    # 照 sops-nix 自己的 NixOS 测试：私钥要在 sops 安装密文之前就位，
    # 所以挂一段早于 setupSecrets 的激活脚本。这把私钥是测试专用、公开的。
    system.activationScripts.firnAgeKey = {
      text = ''
        install -m 400 ${./secrets/age-key.txt} /run/age-key.txt
      '';
    };
    system.activationScripts.setupSecrets.deps = [ "firnAgeKey" ];

    services.firn-secret-demo.enable = true;
  };
  # ...
```

两个选项要对上。`sops.defaultSopsFile = ./secrets/secrets.yaml` 是加密文件在仓库里的位置，一个 Nix 路径，求值时会被复制进 store（它是密文，复制进去没问题）。`secrets."firn/token" = { }` 声明了一个密钥，名字里的斜杠有两个作用：在加密文件里，它是嵌套键 `firn` 下的 `token`（[`recurseSecretKey`](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/pkgs/sops-install-secrets/main.go#L291) 按 `/` 切开去找）；在文件系统里，它是 `/run/secrets/firn/token`。其余选项都取默认值，其中有两个值得先知道：`mode` 默认 `"0400"` ([`modules/sops/default.nix` L102](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/modules/sops/default.nix#L102))，属主默认是 root。

### 清单里有什么，没有什么

清单是 store 里的 `manifest.json`，所以先看它里面有没有明文。我借 `secrets-vm` 的两个节点起一次虚拟机，直接在 `sops` 节点里打印它的字段。这个探针是我手写的，把 `secrets-vm` 的测试脚本换成一串 `show(...)`，每条命令先打印 `$ 命令`，再打印输出；这一篇里其余的虚拟机输出都来自它，所以先把文件给出来（`testScript` 里每个 `show` 调用都会在输出里以 `$ ...` 回显，这里只贴开头，其余的 `show` 调用不重复，它们按文件里的顺序，在各节的输出里以 `$` 行逐条回显）：

```nix
{ firnPath }:
let
  firn = builtins.getFlake firnPath;
in
firn.checks.x86_64-linux.secrets-vm.extend {
  modules = [
    {
      testScript = firn.inputs.nixpkgs.lib.mkForce ''
        def show(node, cmd):
            print(f"$ {cmd}")
            print(node.succeed(cmd))


        start_all()
        sops.wait_for_unit("firn-secret-demo.service")
        naive.wait_for_unit("multi-user.target")

        show(sops, "ls -ld /run/secrets /run/secrets.d /run/secrets/firn")
        show(sops, "ls -l /run/secrets/firn")
        show(
            sops,
            "stat -c '%a %U:%G %n' /run/secrets/firn/token /run/age-key.txt",
        )
        show(sops, "stat -L -f -c '%T %n' /run/secrets /run/secrets.d /run")
        show(
            sops,
            "ls /run/secrets.d; stat -c '%a %n' /run/secrets.d/age-keys.txt",
        )
        # ...
      '';
    }
  ];
}
```

（手敲，不在 `lab/ch17/` 里）

它借 `checks.x86_64-linux.secrets-vm.extend` 复用整个测试的节点定义，只覆盖 `testScript`（`passthru.extend` 是 NixOS 测试框架的接口，nixpkgs 里在 [`nixos/lib/testing/call-test.nix` 的 L30](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/lib/testing/call-test.nix#L30)）。运行它，再用一条过滤管道把日志里的前缀、回显和内核行去掉；虚拟机里的 `su` 会在日志里留 PAM 的行，也被过滤掉：

```bash
nix build --impure -L --no-link --file /tmp/scratch17/probe_vm.nix --argstr firnPath "$PWD" 2>&1 \
  | grep -v -E 'must succeed|finished: must|(sops|naive) # \[' \
  | sed 's/^vm-test-run-secrets> //' \
  | awk '/^\$ ls -ld/,/^test script finished/'
```

（手敲，不在 `lab/ch17/` 里）

这一篇里其余的虚拟机输出都取自这条管道的同一次运行，我按主题切成几段，每段保持原样。先是清单里的字段：

```text
$ cat $(grep -o '/nix/store/[a-z0-9]*-manifest.json' /run/current-system/activate | head -n 1) | tr ',' '\n' | grep -E 'key|path|mode|secretsMount|symlink|Tmpfs|sopsFile'
{"ageKeyFile":"/run/age-key.txt"
"logging":{"keyImport":true
"key":"firn/token"
"mode":"0400"
"path":"/run/secrets/firn/token"
"sopsFile":"/nix/store/x56b6k3s2pan4vg0140n9ch04jmbfhsy-secrets.yaml"
"sopsFileHash":"c3df116116e3779197677bc3c3bed06e2fb0c0776abbc0ae9b43c686bcc34d1a"
"secretsMountPoint":"/run/secrets.d"
"symlinkPath":"/run/secrets"
"useTmpfs":false
```

（手敲，不在 `lab/ch17/` 里）

`sopsFile` 指向 store 里的 `…-secrets.yaml`，是密文；`path` 和 `key` 是字符串；清单里没有任何明文，也没有私钥，只有 `"ageKeyFile":"/run/age-key.txt"` 这一个“私钥在哪里”的路径。`useTmpfs` 是 `false`，这条留到“`/run/secrets`：符号链接，加一个 ramfs”那一节。`sopsFileHash` 是文件的 sha256，选项说明里写着它可以用在 `restartTriggers` 里；它是求值时用 `builtins.hashFile` 算出来的，见 `modules/sops/default.nix` 的 [L228 到 L235 的 `validateSopsFiles`](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/modules/sops/default.nix#L228-L235)，那个选项还有一个效果：加密文件必须在求值时就存在。

### 激活顺序

解密要在两件事之后发生：文件系统（`/run` 要挂好）和密钥（私钥文件要在位）。sops-nix 自己声明了第一件事。`setupSecrets` 是一个 `lib.stringAfter [ "specialfs" "users" "groups" ]` 的激活脚本片段（[`modules/sops/default.nix` L498 到 L515](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/modules/sops/default.nix#L498-L515)），`stringAfter` 就是 [`lib/strings-with-deps.nix` L181](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/lib/strings-with-deps.nix#L181) 里的一行：`stringAfter = deps: text: { inherit text deps; };`。`deps` 在 NixOS 里的语义是“这些脚本先跑”（[`activation-script.nix` L101 到 L105](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/system/activation/activation-script.nix#L101-L105)，描述是 “List of dependencies. The script will run after these.”），最后一份 `activate` 脚本是把所有片段按依赖排好序拼起来的（[L68 到 L72](https://github.com/NixOS/nixpkgs/blob/56c02bc00adcf003215cc4bd996d6efaf4cff188/nixos/modules/system/activation/activation-script.nix#L68-L72)）。

第二件事是我们自己的，测试里那两行：

```nix
    # 照 sops-nix 自己的 NixOS 测试：私钥要在 sops 安装密文之前就位，
    # 所以挂一段早于 setupSecrets 的激活脚本。这把私钥是测试专用、公开的。
    system.activationScripts.firnAgeKey = {
      text = ''
        install -m 400 ${./secrets/age-key.txt} /run/age-key.txt
      '';
    };
    system.activationScripts.setupSecrets.deps = [ "firnAgeKey" ];
```

`firnAgeKey` 是一段没有依赖的脚本，把测试私钥装到 `/run/age-key.txt`，权限 `400`；第二行把它加进 `setupSecrets` 的 `deps`，这样 `activate` 里 `firnAgeKey` 一定排在 `setupSecrets` 之前。这个做法不是我发明的：sops-nix 自己的 NixOS 测试就是这么给密钥“提前就位”的，名字叫 `earlySecrets`，见 [`checks/nixos-test.nix` L96 到 L100](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/checks/nixos-test.nix#L96-L100)。结果可以直接去虚拟机里的 `activate` 脚本看：

```text
$ grep -n -E '^#### Activation script snippet (users|specialfs|firnAgeKey|setupSecrets):' /run/current-system/activate
34:#### Activation script snippet users:
46:#### Activation script snippet specialfs:
78:#### Activation script snippet firnAgeKey:
98:#### Activation script snippet setupSecrets:

$ grep -A3 'snippet firnAgeKey:' /run/current-system/activate
#### Activation script snippet firnAgeKey:
_localstatus=0
install -m 400 /nix/store/4pzfw4m3a7y5jhdqic542k55fhxknhzg-age-key.txt /run/age-key.txt


$ stat -c '%a %n' $(grep -o '/nix/store/[a-z0-9]*-age-key.txt' /run/current-system/activate)
444 /nix/store/4pzfw4m3a7y5jhdqic542k55fhxknhzg-age-key.txt
```

（手敲，不在 `lab/ch17/` 里）

四个片段的行号是 34、46、78、98：`firnAgeKey` 在 `setupSecrets` 之前，和 `deps` 声明的一致，`users` 和 `specialfs` 也都在 `setupSecrets` 之前，和 `stringAfter` 声明的一致。`users` 排在 `specialfs` 之前这一点我没有深究，sops-nix 要求的只是它们都在 `setupSecrets` 之前。`firnAgeKey` 那一段里的 `/nix/store/4pzf…-age-key.txt` 是个提醒：**测试私钥本身被复制进了 store，权限 `444`**，这正是“威胁模型”那一节的五个实验要避免的事，“测试密钥为什么公开，以及为什么只能在测试里”那一节会回头说为什么这里可以。

如果顺序反了会怎样？按 sops-nix 的源码，`sops-install-secrets` 读不到 `ageKeyFile` 时会报 `cannot read keyfile` 然后返回错误（`main.go` 里读 `manifest.AgeKeyFile` 的那一步）。我没有故意把顺序弄反去试，所以这是读源码的结论，不是实验。

激活脚本也不是唯一的做法。`sops.useSystemdActivation`（[L319 起](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/modules/sops/default.nix#L319-L334)）改用一个 `sops-install-secrets.service` 单元来装密钥，默认值是“系统用 systemd-sysusers 或 userborn 管用户时才打开”。这个测试里它是关的，虚拟机里问一下就知道：

```text
$ systemctl is-active sops-install-secrets.service || true
inactive
```

（手敲，不在 `lab/ch17/` 里）

`inactive` 说明那个单元存在但没有运行，或者根本没有被启用，这里我只能确认它不是密钥装进来的方式，装进来的方式是“激活顺序”一节里那段激活脚本。（我没有在真机上执行过 `switch`。`switch-to-configuration` 会执行 `activate` 这一点是第 16 篇读源码得到的，所以密钥在真机 `switch` 时是否也会重新解密，我只能说按这个机制应当如此，没有试。）

### `/run/secrets`：符号链接，加一个 ramfs

解密完成之后，文件在哪里？我原来以为是“tmpfs 上的 `/run/secrets/`”。虚拟机里看到的是另一回事：

```text
$ ls -ld /run/secrets /run/secrets.d /run/secrets/firn
lrwxrwxrwx 1 root root 16 Nov  7 14:28 /run/secrets -> /run/secrets.d/1
drwxr-x--x 3 root keys  0 Nov  7 14:28 /run/secrets.d
drwxr-x--x 2 root keys  0 Nov  7 14:28 /run/secrets/firn

$ ls -l /run/secrets/firn
total 4
-r-------- 1 root root 28 Nov  7 14:28 token

$ stat -c '%a %U:%G %n' /run/secrets/firn/token /run/age-key.txt
400 root:root /run/secrets/firn/token
400 root:root /run/age-key.txt

$ stat -L -f -c '%T %n' /run/secrets /run/secrets.d /run
ramfs /run/secrets
ramfs /run/secrets.d
tmpfs /run

$ ls /run/secrets.d; stat -c '%a %n' /run/secrets.d/age-keys.txt
1
age-keys.txt
600 /run/secrets.d/age-keys.txt
```

（手敲，不在 `lab/ch17/` 里）

要读懂这几行，需要源码。`/run/secrets` 是一个符号链接，指向 `/run/secrets.d/1`；`/run/secrets.d` 才是被挂载的东西，类型是 `ramfs`；`/run` 本身是 `tmpfs`。把它们对回源码：清单里 `secretsMountPoint` 是 `/run/secrets.d`、`symlinkPath` 是 `/run/secrets`（[`manifest-for.nix` L37 和 L38](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/modules/sops/manifest-for.nix#L37-L38)）；`MountSecretFs` 在挂载点上 `mount -t ramfs`，除非 `useTmpfs` 为真才换成 `tmpfs`（[`linux.go` L22 到 L39](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/pkgs/sops-install-secrets/linux.go#L22-L39)）；`prepareSecretsDir` 每次激活建一个编号的新目录（`1`、`2` 这样递增，[`main.go` L404 到 L440](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/pkgs/sops-install-secrets/main.go#L404-L440)），解密写进去之后用 `atomicSymlink` 原子地把 `/run/secrets` 指过去，再按 `keepGenerations`（默认 1，[L237 到 L243](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/modules/sops/default.nix#L237-L243)）清理旧的编号。我读源码的理解是，这样服务在某一次激活的中途去读 `/run/secrets/...`，读到的要么是旧的一整套，要么是新的一整套；这一点我没有做并发实验去验证。

为什么默认是 ramfs 而不是 tmpfs？`useTmpfs` 选项的说明回答了这个问题（[L299 到 L317](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/modules/sops/default.nix#L299-L317)）：在 6.4 之前的内核上，tmpfs 的页可能被换出到交换区，于是明文写到磁盘上；ramfs 没有后备存储，页不会被换出，内核文档说它的页“never marked clean, so they can't be freed by the VM”（见 [内核文档 `ramfs-rootfs-initramfs`](https://github.com/torvalds/linux/blob/v6.18/Documentation/filesystems/ramfs-rootfs-initramfs.rst)）。代价是 ramfs 是“dynamically resizable”的（同一份内核文档的用词），我没有找到给它设上限的办法，所以写多少占多少内存（这是推断，没有试）；放几个口令文件没问题，放不得大文件。把 `useTmpfs = true` 打开会怎样，我留成练习 3，并且跑过了。

权限也能读出来。`/run/secrets.d` 和它的子目录是 `drwxr-x--x`，属组 `keys`：其他用户没有 `r`，只有 `x`，也就是能穿过目录，列不出里面有什么；文件本身是 `-r--------`，属主 root，所以只有 root 读得了。`/run/secrets.d/age-keys.txt` 是 `600`，这是 `sops-install-secrets` 把你给的私钥文件和 ssh 转换出的密钥合并成的一个文件，放在同一个 ramfs 里（源码里的 `0o600`）。我用 `nobody` 去读两个节点各自的口令，对比一下：

```text
$ su -s /bin/sh nobody -c 'cat /run/secrets/firn/token' 2>&1 || true
cat: /run/secrets/firn/token: Permission denied

$ su -s /bin/sh nobody -c 'cat /etc/firn-token' 2>&1 || true
correct-horse-battery-staple
```

（手敲，不在 `lab/ch17/` 里）

`sops` 节点的文件是 `Permission denied`，`naive` 节点的 `/etc/firn-token`（一个指向 store 里 `…-etc-firn-token` 的符号链接）读出来是明文。这是第 2 篇的结论在一台虚拟机里的样子：同一个口令，一个放在 store 里的普通文件，任何用户一条 `cat` 就读到；另一个在 ramfs 上，权限 `400`，只有 root。

## 写一个用这个密文的服务

明文落在 `/run/secrets/firn/token` 了，怎么交给服务？最直接的是让服务读这个路径，但要让服务的用户有权限，就得设 `sops.secrets."firn/token".owner`，而且这个用户必须在激活时已经存在。`LoadCredential` 绕开了这件事：路径由 systemd (root) 去读，再拷一份给服务。`nixos/modules/secret-demo.nix` 是一个整整 33 行的演示服务：

```nix
# services.firn-secret-demo：演示 sops-nix 解出来的密文怎么交给服务。
# 密文在激活时解密到 /run/secrets (内存文件系统，VM 里量到 ramfs)，服务用 LoadCredential 拿到一份
# 只有它自己能读的副本，只把 sha256 打到日志里，明文不出现在 store 或日志里。
# 需要同时导入 sops-nix 的模块，并声明 sops.secrets."firn/token"。
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.firn-secret-demo;
  show = pkgs.writeShellScript "firn-secret-demo" ''
    hash="$(${pkgs.coreutils}/bin/sha256sum < "$CREDENTIALS_DIRECTORY/token")"
    echo "firn-secret-demo: sha256=''${hash%% *}"
  '';
in
{
  options.services.firn-secret-demo.enable = lib.mkEnableOption "the secret demo service";

  config = lib.mkIf cfg.enable {
    systemd.services.firn-secret-demo = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        DynamicUser = true;
        LoadCredential = "token:${config.sops.secrets."firn/token".path}";
        ExecStart = show;
      };
    };
  };
}
```

几个要点。第 28 行 `LoadCredential = "token:${config.sops.secrets."firn/token".path}"` 里的 `.path` 是一个字符串，值是 `/run/secrets/firn/token`（[`modules/sops/default.nix` 里 `path` 的默认值](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/modules/sops/default.nix#L73-L84)是 `"/run/secrets/${config.name}"`）。它是个运行时路径，不是 store 路径，不引用任何文件内容，所以字符串插值在这里不会把密钥拉进 store：这和“想法三”里的 `${builtins.readFile ./secret.txt}` 看上去长得像，行为正相反。`DynamicUser = true` 让 systemd 在服务启动时临时分配一个用户，我们不用知道它的 uid，`LoadCredential` 负责把文件交给它。`show` 脚本从 `$CREDENTIALS_DIRECTORY/token` 读，算 sha256，只打印指纹。

第 2 行的注释已经写明：`/run/secrets` 是内存文件系统，虚拟机里量到的是 ramfs，细节在“`/run/secrets`：符号链接，加一个 ramfs”一节。

`RemainAfterExit = true` 和 `wantedBy = [ "multi-user.target" ]` 是为测试服务的：oneshot 服务默认执行完就变成 `inactive`，测试里的 `wait_for_unit` 要等它是 `active`（这是我的猜测，没有去掉 `RemainAfterExit` 试），`wantedBy` 让它在开机时就起来。服务单元里没有写任何“在密钥之后启动”的 `After=`：激活脚本发生在 systemd 单元启动之前，所以明文已经就位。（`useSystemdActivation` 打开的话，顺序就要靠单元的依赖来保证，那是另一条路径，这里没有走。）

`LoadCredential` 交给服务的东西长什么样？我在虚拟机里手工起一个临时单元，用同样的 `LoadCredential` 和 `DynamicUser`，看服务看到的凭据目录：

```text
$ systemd-run -q -P --wait -E PATH=/run/current-system/sw/bin -p DynamicUser=yes -p LoadCredential=token:/run/secrets/firn/token sh -c 'ls -l $CREDENTIALS_DIRECTORY; stat -f -c %T $CREDENTIALS_DIRECTORY'
total 4
-r--r-----+ 1 root root 28 Nov  7 14:30 token
tmpfs
```

（手敲，不在 `lab/ch17/` 里）

`token` 是 28 字节，权限 `-r--r-----`，权限串末尾的 `+` 是 `ls` 对“带扩展 ACL”的标记，我猜是 systemd 靠 ACL 把读权限授给了那个临时用户，没有用 `getfacl` 去确认。凭据目录所在的文件系统，`stat -f` 说是 `tmpfs`。[systemd 的凭据文档](https://github.com/systemd/systemd/blob/main/docs/CREDENTIALS.md)写的是“Service credentials are placed in non-swappable memory. (If permissions allow it, via `ramfs`.)”，我这次在这个虚拟机里看到的是 `tmpfs`，我不知道为什么，没有去查。

测试里没有断言服务本身读到了什么，它断言的是日志里有 `firn-secret-demo: sha256=<令牌的 sha256>`，那个 sha256 是测试脚本用 Python 的 `hashlib` 自己算的：服务读对了，哈希才对得上。

## 两个节点的测试

`sops` 节点的配置在“sops-nix 在激活时做了什么”那一节看过了。`naive` 节点只有一行，把令牌写成 `environment.etc` 的文本：

```nix
  nodes.naive = {
    environment.etc."firn-token".text = "correct-horse-battery-staple";
  };
```

测试脚本分三步。第一步是 `sops` 节点的功能性断言：文件存在、权限 `400`、日志里有正确的哈希。

```python
start_all()
sops.wait_for_unit("multi-user.target")
naive.wait_for_unit("multi-user.target")

sops.wait_for_unit("firn-secret-demo.service")
mode = sops.succeed("stat -c %a /run/secrets/firn/token").strip()
assert mode == "400", mode
report("sops_secret_mode", mode)
report("sops_secret_fs", sops.succeed("stat -L -f -c %T /run/secrets").strip())

expected = hashlib.sha256(token.encode()).hexdigest()
journal = sops.succeed("journalctl -u firn-secret-demo.service --no-pager")
assert f"firn-secret-demo: sha256={expected}" in journal, journal
report("sops_journal", f"sha256={expected}")
```

脚本被 Nix 的 `''…''` 包着，Nix 会去掉字符串里的公共缩进（4 格），摘录里的 Python 也去掉了这 4 格，这样它是能原样粘进 Python 文件的。`sops_secret_fs` 那一行就是开头那个块里 `ramfs` 的来源，它用的是 `stat -L -f -c %T /run/secrets`。`/run/secrets` 是符号链接，我担心不带 `-L` 会量到链接自己所在的 `/run`；我在宿主上拿 `/run/current-system` 试了，带不带 `-L` 打印的都是目标所在的文件系统 (`ext2/ext3`)，所以这里的 `-L` 大概是多余的，无害。

第二步是这一篇的核心：数含明文的 store 路径。这里有一个我差点写错的地方。

```python
def report(key, value):
    print(f"firn: {key} {value}")


def plaintext_paths(node):
    # 只看本节点的系统闭包：测试虚拟机里 /nix/store 是宿主 store 的只读视图，
    # 整个扫一遍会扫到宿主上无关的路径（包括这份测试脚本本身）。
    out = node.succeed(
        "nix-store -qR /run/current-system"
        f" | xargs grep -rlF {token} || true"
    )
    return out.split()
```

我最初的想法是 `grep -r correct-horse-battery-staple /nix/store`，数它有几个命中。但虚拟机里的 `/nix/store` 不是这台机器的 store：它是宿主 store 的一个只读视图（9p 共享加 overlay），里面有这次测试用到的所有东西，包括另一个节点和测试脚本本身。我在虚拟机里量了一下：

```text
$ grep -E ' /nix/(store|.ro-store) ' /proc/self/mountinfo | awk '{print $5, $9}'
/nix/.ro-store 9p
/nix/store overlay
/nix/store overlay

$ ls /nix/store | wc -l; nix-store -qR /run/current-system | wc -l
688
568

$ grep -rlF correct-horse-battery-staple /nix/store || true
/nix/store/kblnlm04vx0cj8gl04a9j4vsglvq4436-etc-firn-token
/nix/store/dycc51xyix7vgjynmzj0fdw1mbvf3aws-test-script
/nix/store/mz6ks8r628p79cw160a67s63ggcgx8xg-nixos-test-driver-secrets/test-script

$ nix-store -qR /run/current-system | xargs grep -rlF correct-horse-battery-staple || true
```

（手敲，不在 `lab/ch17/` 里）

三件事。第一，`/nix/store` 是 `9p` 加 `overlay`，对上了“宿主 store 的视图”这个说法。第二，这个视图有 688 个条目，而 `sops` 节点自己的系统闭包只有 568 个，多出来的 120 个不在这个节点的闭包里，至少包括下一条命中的那几个。第三，整个 store 扫一遍，在 `sops` 节点上也找到 3 个含明文的路径：`naive` 节点的 `etc-firn-token`，还有两份测试脚本 (`test-script`)。脚本含这串明文有两个原因：原版的测试脚本里有一行 `token = "correct-horse-battery-staple"`，而这里命中的是我的探针脚本，因为我把它写进了 `grep` 的命令行。这三个路径对这个节点的闭包来说都是外人：闭包里是 0。所以脚本只扫本节点 `nix-store -qR /run/current-system` 列出来的路径，这才是“这台机器的系统里有没有明文”这个问题的正确范围。

第三步是对 `naive` 节点同样数一遍，并要求至少有一个，再把那个文件的权限报出来：

```python
sops_paths = plaintext_paths(sops)
assert sops_paths == [], sops_paths
report("sops_plaintext_store_paths", len(sops_paths))

naive_paths = plaintext_paths(naive)
assert len(naive_paths) >= 1, naive_paths
report("naive_plaintext_store_paths", len(naive_paths))
store_mode = naive.succeed("stat -L -c %a /etc/firn-token").strip()
report("naive_store_file_mode", store_mode)
```

`naive` 的那一个路径就是 `/etc/firn-token` 指向的 `…-etc-firn-token`，权限 `444`。测试还用 `assert` 保证对照组真的有泄漏 (`len(naive_paths) >= 1`)，否则 `0` 这个数字就没有意义：一个什么都找不到的 `grep` 既可能是安全，也可能是 `grep` 写错了，有了对照组才知道 `grep` 在这个环境里是有效的。

实验的入口是 `lab/ch17/secrets_vm_host.sh`。它的主体：

```bash
readonly ATTR="${FIRN_ROOT}#checks.x86_64-linux.secrets-vm"
readonly LOG="${LAB_TMP}/vm-test.log"

main() {
  local out
  out="$(nix eval --raw "${ATTR}.outPath")"
  local -a flags=(-L --no-link)
  if [[ -e "${out}" ]]; then
    echo "== result already in the store: building with --rebuild"
    flags+=(--rebuild)
  fi
  echo "volatile: /dev/kvm: $([[ -c /dev/kvm ]] && echo present || echo missing)"

  local start end
  start="$(date +%s)"
  nix build "${flags[@]}" "${ATTR}" >"${LOG}" 2>&1 || {
    tail -n 40 "${LOG}" >&2
    return 1
  }
  end="$(date +%s)"

  echo "== lines printed by the test script"
  local lines
  lines="$(grep -o 'firn: .*' "${LOG}" | awk '!seen[$0]++')"
  if [[ -z "${lines}" ]]; then
    echo "no firn: lines in the build log" >&2
    return 1
  fi
  printf '%s\n' "${lines}"
  echo "volatile: wall time: $((end - start)) s"
}
```

测试结果已经在 store 里时，`nix build` 只会打印缓存的路径，不会重新跑，更看不到 `firn:` 那几行，所以脚本检查 `outPath` 是否存在，存在就加 `--rebuild` 强制重跑；`-L` 让构建日志打到标准错误，脚本把日志存下来，用 `grep -o 'firn: .*'` 取出测试脚本打印的那几行，再用 `awk '!seen[$0]++'` 去重（每一行在日志里会出现不止一次）。这就是开头那个块的来源，那里的 `volatile: wall time: 102 s` 是这次 `--rebuild` 的墙钟。

### 虚拟机里的 systemd-creds

“解法的几个家族”里提到的 `systemd-creds`，这是它在虚拟机里往返的输出：

```text
$ echo -n correct-horse-battery-staple | systemd-creds encrypt --name=token - /tmp/token.cred; wc -c < /tmp/token.cred; systemd-creds decrypt --name=token /tmp/token.cred -; echo
sops # Credential secret file '/var/lib/systemd/credential.secret' is not located on encrypted media, using anyway.
171
correct-horse-battery-staple
```

（手敲，不在 `lab/ch17/` 里）

28 字节的令牌，加密之后的凭据文件是 171 字节，解密回来和原文一致；`sops #` 那一行是 `systemd-creds` 自己的警告，它用的密钥文件 `/var/lib/systemd/credential.secret` 所在的盘不是加密介质，它还是用了。这是一个**机器本地的密钥**：按 systemd 的文档，凭据绑定在这台机器的密钥（或 TPM2）上，换一台机器应当解不开，我没有试；那它就不能放进仓库里让别的机器用，这是它和 sops-nix、agenix 最大的不同（`LoadCredentialEncrypted=` 和 `SetCredentialEncrypted=` 是把这种凭据交给服务的方式，见 systemd 的凭据文档）。

## 测试密钥为什么公开，以及为什么只能在测试里

`nixos/tests/secrets/age-key.txt` 是仓库里唯一的私钥，4 行，第一行是一句警告：

```text
$ head -n 3 nixos/tests/secrets/age-key.txt
# TEST ONLY: public on purpose, never use outside nixos/tests
# created: 2026-11-07T04:00:27-08:00
# public key: age1mc54q6uvuz9p3t6xtdrruuzy9twhtyqkay6tpvlaqzk3nmprzpjq8euxe6
```

（手敲，不在 `lab/ch17/` 里）

第 4 行是 `AGE-SECRET-KEY-1…` 开头的私钥，我只取前三行，不贴它。它公开是故意的，原因有三条，缺一条都不成立：

1. **测试必须走真的解密路径。** 如果测试用一个 `sops.secrets` 的替身，就测不出激活顺序、ramfs、权限和 `LoadCredential`，那一整串才是这一篇想验证的东西。所以需要一份真的密文，也需要能解开它的真的私钥。
2. **它保护的东西不是秘密。** 令牌是 `correct-horse-battery-staple`，是一个众所周知的玩笑口令，写在测试脚本里，也写在 `naive` 节点的配置里。密文和私钥一起公开，这份加密不提供任何保密性，它的作用是让流程是真的。
3. **它被限制在 `nixos/tests/` 下。** 注释写着 `never use outside nixos/tests`，任何把它放进真实配置的人都是在违反注释。

同时，这把私钥被 `install -m 400 ${./secrets/age-key.txt} /run/age-key.txt` 带进了 store，权限 `444`（“激活顺序”一节的输出里有）。对一个真的私钥，这一行就是“想法一”的翻版：私钥进了一个人人可读的文件，进了闭包，只要有人把闭包推到缓存，也就进了缓存。真实的做法有两条路。一是让私钥从一开始就不在 store 里：把 `sops.age.keyFile` 指向一个运行时路径，比如 `/var/lib/sops-nix/key.txt`，用 `sops.age.generateKey = true` 让激活脚本在文件不存在时用 `age-keygen -o` 在机器上生成它（[`modules/sops/default.nix` L354 到 L362 和 L517 到 L530](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/modules/sops/default.nix#L517-L530)），之后用 `age-keygen -y` 取出公钥，加进 `.sops.yaml`；二是用机器已有的 ssh 主机密钥，不需要另一把密钥。这两条我都只读了源码，没有在真机上走过。

sops-nix 自己也防了一手。`age.keyFile` 的类型是 `pathNotInStore`（[L19 到 L25](https://github.com/Mic92/sops-nix/blob/a8627b21b9107c5711c96b84f32a9a4b3d45295f/modules/sops/default.nix#L19-L25)），检查是 `!lib.path.hasStorePathPrefix (/. + x)`。我想试试把测试私钥写成最自然的样子：`age.keyFile = "${firn}/nixos/tests/secrets/age-key.txt"`，一个指向 store 的路径。`/tmp/scratch17/keyfile_in_store.nix`：

```nix
{ firnPath }:
let
  firn = builtins.getFlake firnPath;
  system = firn.inputs.nixpkgs.lib.nixosSystem {
    modules = [
      firn.inputs.sops-nix.nixosModules.sops
      {
        nixpkgs.hostPlatform = "x86_64-linux";
        sops = {
          defaultSopsFile = "${firn}/nixos/tests/secrets/secrets.yaml";
          age.keyFile = "${firn}/nixos/tests/secrets/age-key.txt";
        };
      }
    ];
  };
in
system.config.sops.age.keyFile
```

（手敲，不在 `lab/ch17/` 里）

```text
$ nixfmt --check /tmp/scratch17/keyfile_in_store.nix && echo fmt-ok
fmt-ok
$ nix-instantiate --eval --argstr firnPath "$PWD" /tmp/scratch17/keyfile_in_store.nix 2>&1 | tail -n 8
       (stack trace truncated; use '--show-trace' to show the full, detailed trace)

       error: a string that refers to a store path cannot be appended to a path
       at /nix/store/s154mmk8ahvc71gq8xfkbzlk240yvniv-source/modules/sops/default.nix:23:49:
           22|     descriptionClass = "noun";
           23|     check = x: !lib.path.hasStorePathPrefix (/. + x);
             |                                                 ^
           24|     merge = lib.mergeEqualOption;
```

（手敲，不在 `lab/ch17/` 里）

求值失败，停在 `check` 那一行。报错的话是“一个指向 store 路径的字符串不能拼到一个路径上”，不是“密钥文件不能在 store 里”，措辞不友好，但守卫确实拦住了它：这就是为什么测试要用激活脚本把私钥从 store 里的拷贝装到 `/run/age-key.txt`，再让 `sops.age.keyFile` 指向 `/run/age-key.txt` 这个运行时路径（那是一个没有 store 上下文的字符串，过得了检查）。这个守卫拦的是“把私钥文件 `${./key.txt}` 当 `keyFile`”这一种写法，它拦不住 `readFile`，也拦不住你手工把私钥拷进 store 再引用。

## agenix 对照：用 age 命令行把它的模型走一遍

sops-nix 不是唯一的做法。[agenix](https://github.com/ryantm/agenix) 是另一个同类方案：同样是 age，同样在激活时解密，同样把明文放在 `/run`。我没有把它加进 flake 的输入（这一篇只锁了一个新输入），也没有运行过它。我做的是读它的源码，再用 `age` 命令行把它的模型一步一步做出来。读的是 agenix 的 `5e5b88a0c8e56f291a108c2fe9934054d9745b2e`（我读的时候 main 的最新提交，2026-10-20），文中 agenix 的行号都是这个提交上的。

它的模型是四件事。第一，一个规则文件把“文件名”映射到“允许读它的公钥列表”：这个文件在 agenix 的命令行里先找 `agenix-rules.nix` 再找 `secrets.nix`（[`pkgs/agenix.sh` L128 到 L148](https://github.com/ryantm/agenix/blob/5e5b88a0c8e56f291a108c2fe9934054d9745b2e/pkgs/agenix.sh#L128-L148)），它的 README 用的是 `agenix-rules.nix` 这个名字，更早的文档里叫 `secrets.nix`，我这里沿用后一个。第二，加密就是对列表里的每个公钥各包一份文件密钥，这正是 age 的多 recipient。第三，每个密钥是一个单独的 `.age` 文件。第四，机器激活时用自己的 ssh 私钥解密：模块里循环 `age.identityPaths`，拼成一串 `-i` 参数，调一次 `age --decrypt`（[`modules/age.nix` L106 到 L123](https://github.com/ryantm/agenix/blob/5e5b88a0c8e56f291a108c2fe9934054d9745b2e/modules/age.nix#L106-L123)）。

这四件事用 `age` 本身就能演示，不需要 agenix 的一行代码。`lab/ch17/ex_agenix_shape.sh`（它同时是练习 1 的答案）在临时目录里造三把 ed25519 密钥：`alice`、`host1` 和 `mallory`，写一个 `secrets.nix` 只允许前两把，加密，再看谁能解：

```bash
  # agenix 的 secrets.nix：文件名 -> 允许读它的公钥。
  cat >secrets.nix <<NIX
let
  alice = "$(cut -d' ' -f1-2 alice.pub)";
  host1 = "$(cut -d' ' -f1-2 host1.pub)";
in
{
  "token.age".publicKeys = [
    alice
    host1
  ];
}
NIX
```

这是 agenix 的规则文件：文件名 `token.age` 映射到一个公钥列表。接着，用 Nix 把这个列表取出来，变成 `age -R` 要的“一行一个 recipient”的文件，加密：

```bash
  echo "== recipients of token.age"
  nix eval --file secrets.nix --apply 'x: builtins.length x."token.age".publicKeys'

  # nix eval 把公钥列表交给 age：一行一个，正是 age -R 要的文件。
  nix eval --raw --file secrets.nix --apply \
    'x: builtins.concatStringsSep "\n" x."token.age".publicKeys' >recipients.txt
  printf '\n' >>recipients.txt
  printf 'correct-horse-battery-staple\n' \
    | age -R recipients.txt -o token.age
```

最后，让三把密钥各自试着解密，并断言 `host1` 和 `alice` 能、`mallory` 不能：

```bash
  echo "== who can decrypt token.age"
  for k in alice host1 mallory; do
    if age -d -i "${k}" token.age >/dev/null 2>&1; then
      echo "${k}: yes"
    else
      echo "${k}: no"
    fi
  done
  age -d -i host1 token.age | cmp - <(printf 'correct-horse-battery-staple\n')
  [[ "$(age -d -i alice token.age)" == correct-horse-battery-staple ]]
  ! age -d -i mallory token.age >/dev/null 2>&1
```

```text
$ cat out/ch17/ex_agenix_shape.stdout
== recipients of token.age
2
== who can decrypt token.age
alice: yes
host1: yes
mallory: no
```

`age` 直接认 ssh 的公钥和私钥当 recipient 和 identity，这就是 agenix 能“用主机的 ssh 主机密钥解密”的全部秘密：模块只是把 `/etc/ssh/ssh_host_ed25519_key` 递给 `age -d -i`。输出里的 `2` 是规则文件里 `token.age` 的公钥个数，`alice: yes`、`host1: yes`、`mallory: no` 是谁能解的结果。这也说明 agenix 为什么不需要 ssh-to-age：age 本身就认 ssh 密钥，模块只是把主机密钥递给它。sops-nix 的激活代码走的是另一条路，先把 ssh 私钥转成 age 密钥（“主机密钥：ssh-to-age”一节里的 `importAgeSSHKeys`）。

两者放在一起：

| | sops-nix | agenix |
| --- | --- | --- |
| 一份密文是什么 | 一个结构化文件，里面很多个键；值加密，键明文 (YAML、JSON、ENV、INI、binary) | 每个密钥一个 `.age` 文件，整个是 age 的不透明密文 |
| “谁能解”写在哪 | `.sops.yaml` 的 `creation_rules`（文件名正则到 recipient），recipient 也记在每个文件的 `sops.age` 里 | 一个 Nix 规则文件：文件名到 `publicKeys` |
| 解密用的私钥 | age 密钥文件，或 ed25519 主机密钥转换出来的 age 密钥，或 GPG | ssh 私钥直接当 age identity（`age.identityPaths`，默认取 `services.openssh.hostKeys` 里的 rsa 和 ed25519） |
| 谁来解密 | Go 程序 `sops-install-secrets`，链接 sops 库（`go.mod` 里是 v3.12.2） | 激活脚本里的 shell，对每个密钥调一次 `age --decrypt` |
| 明文放哪 | `/run/secrets` 指向 `/run/secrets.d/N`，ramfs，可选 tmpfs | `/run/agenix` 指向 `/run/agenix.d/N`；内核至少 6.4 且不在容器里时用带 `noswap` 的 tmpfs，否则 ramfs（[`modules/age.nix` L35 到 L62](https://github.com/ryantm/agenix/blob/5e5b88a0c8e56f291a108c2fe9934054d9745b2e/modules/age.nix#L35-L62)） |
| 默认权限 | `0400`，属主 root | `0400`，属主 `0` ([L208](https://github.com/ryantm/agenix/blob/5e5b88a0c8e56f291a108c2fe9934054d9745b2e/modules/age.nix#L208)) |
| 加新 recipient | `sops updatekeys`，逐个文件 | `agenix -r`，重新加密所有密钥 |
| Git 里的 diff | 能看到哪个键变了，值是密文 | 整个文件变了 |
| 模板（把密钥填进一个配置文件的某一处） | 有 `sops.templates` | 模块里没有（我在 `modules/age.nix` 里搜 `template` 没有命中） |

表里 sops-nix 一列我自己跑过；agenix 一列是读源码和 README 得到的，用 `age` 命令行的那个实验验证了“规则文件到 recipient 到解密”这一条主线，其余没有运行过。我没有在这两者之间下结论：我看到的取舍是 sops-nix 的文件格式更丰富（局部可读的 diff、模板、多种格式），代价是多一个 sops 和一个 Go 程序；agenix 更薄，几乎就是 age 加一段脚本，代价是每个密钥一个文件、整个不透明。

## 让我意外的事

**`/run/secrets` 是个符号链接，真正挂载的是 `/run/secrets.d`，类型是 ramfs，不是 tmpfs。** 我原来凭印象以为解密出来的文件在 tmpfs 上，让测试把文件系统类型打出来，打出来的是 `ramfs`。回头读 `linux.go` 才知道 sops-nix 默认挂 ramfs，只有 `useTmpfs` 才换 tmpfs，原因是旧内核上 tmpfs 会被换出到交换区。`/run` 本身倒确实是 tmpfs，两句话各对一半。

**键名是明文，但改一个字母，整个文件就解不开了。** 我以为键是“不加密的部分”，应该可以随便改，结果 `token` 改成 `tokem`，退出码 25，报 `message authentication failed`。键名是 AEAD 的附加认证数据，不是装饰。为 `git diff` 可读而留的明文，不等于可以随手改。

**我的第一版断言，在虚拟机里会得出错的数字。** 我本来要写的是 `grep -rl 明文 /nix/store`，直觉上它就是“store 里有没有”。在虚拟机里它在 `sops` 节点上也找到 3 个路径，其中一个属于另一个节点，另外两个是测试脚本自己。把范围收到 `nix-store -qR /run/current-system` 之后，这个节点的 0 才是干净的 0：688 个条目里只有 568 个是这个节点的闭包。这是一个很典型的“测量工具本身造出了数字”的错误，在没有对照组（`naive` 节点非要找到 ≥ 1）的测试里，我多半会漏掉它。

**为了让私钥进到虚拟机里，这个测试自己犯了它要警告的错。** `install -m 400 ${./secrets/age-key.txt} /run/age-key.txt` 把私钥放进了 store，`444`。这是一把公开的测试私钥，所以无所谓，但它是仓库里唯一一处没有标 `# BAD` 的反例。真正的私钥一开始就不该在 store 里，`sops.age.keyFile` 要指向一个运行时路径，不能是 `${./...}`。

## 检查点

在 `~/firn` 里，`nix develop` 之内：

```bash
env -u CI make ch17
make lint
make check
while read -r f; do
  diff <(git -C ~/firn-ref show ch17:"${f}") "${f}" && echo "same ${f}"
done < <(git -C ~/firn-ref diff --name-only ch16 ch17)
```

`make ch17` 在我这里打印这 9 行（命令回显加 8 行 `ok`），整条命令（含 `nix develop` 的启动）花了 109.618 秒；`lab/ch17/` 里有 1 个 `_host` 实验，`CI=true` 时 `scripts/chapter.sh` 会对它打印 `skip lab/ch17/secrets_vm_host.sh (host only)` 并不运行它，我没有在 `CI=true` 下跑过这一条，这是读脚本得出的：

```text
$ env -u CI make ch17
bash scripts/chapter.sh ch17
ok   lab/ch17/age_roundtrip.sh
ok   lab/ch17/ex_agenix_shape.sh
ok   lab/ch17/readfile_leak.sh
ok   lab/ch17/secret_in_drv.sh
ok   lab/ch17/secrets_vm_host.sh
ok   lab/ch17/sops_roundtrip.sh
ok   lab/ch17/ssh_to_age.sh
ok   lab/ch17/store_world_readable.sh
```

`make lint` 没有任何诊断，退出码 0；`make check` 以 `all checks passed!` 结束，退出码 0，x86\_64-linux 上是 17 个检查：

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

`make check` 里的 `secrets-vm` 和第 16 篇的 `cairn-vm` 一样要用 `/dev/kvm`。`make lint` 加 `make check` 这两条一共只花了 17.966 秒，比一次虚拟机测试短得多，我猜是因为 `secrets-vm` 的结果已经在 store 里（没有单独验证），所以这个时间不能拿来衡量虚拟机测试；要看的是 `secrets_vm_host.sh` 里的 102 秒（`--rebuild` 分支）。

**必须和标签一致的文件。** 命令清单里最后那个循环对 `git diff --name-only ch16 ch17` 列出的每一个文件做 `diff`，全部应该打印 `same`，一共 17 行：

```text
same flake.lock
same flake.nix
same lab/ch17/age_roundtrip.sh
same lab/ch17/ex_agenix_shape.sh
same lab/ch17/fixtures/readfile_config.nix
same lab/ch17/fixtures/secret.txt
same lab/ch17/readfile_leak.sh
same lab/ch17/secret_in_drv.sh
same lab/ch17/secrets_vm_host.sh
same lab/ch17/sops_roundtrip.sh
same lab/ch17/ssh_to_age.sh
same lab/ch17/store_world_readable.sh
same nixos/modules/secret-demo.nix
same nixos/tests/secrets.nix
same nixos/tests/secrets/.sops.yaml
same nixos/tests/secrets/age-key.txt
same nixos/tests/secrets/secrets.yaml
```

**中间版本。** `nixos/modules/secret-demo.nix`、`nixos/tests/secrets.nix`、`nixos/tests/secrets/` 和 `lab/ch17/` 在这里就是终稿。`flake.nix` 和 `flake.lock` 还会变：第 18 篇再加一个输入 (`home-manager`)，`checks` 也会继续增加。你自己的 `~/firn` 里，这两个文件可以和标签不一致，只要 `make ch17` 仍然通过就行。

### 文件清单

链接指向标签 `ch17` 上的那一份；`git diff --name-only ch16 ch17` 的 17 个文件一个不少（其中 `lab/ch17/` 下 10 个，含 `fixtures/` 里 2 个夹具）。实验的命令都是 `env -u CI make ch17`，输出在 `out/ch17/`。

| 文件 | 命令 | 结果 |
| --- | --- | --- |
| [`flake.lock`](https://github.com/bfmhno3/firn/blob/ch17/flake.lock) | `jq -c '.nodes \| keys' flake.lock` | 48 行，比 `ch16` 多 22 行、少 1 行；`["nixpkgs","root","sops-nix"]`，3 个节点；`sops-nix` 锁在 `a8627b21b9107c5711c96b84f32a9a4b3d45295f` (2026-08-13)，`follows` 指回 `nixpkgs` |
| [`flake.nix`](https://github.com/bfmhno3/firn/blob/ch17/flake.nix) | `nix eval .#checks.x86_64-linux --apply builtins.attrNames --json \| jq length` | 315 行，比 `ch16` 多 18 行、少 1 行；`17`（`ch16` 上是 16），多了 `secrets-vm`；多了 `inputs.sops-nix` |
| [`lab/ch17/age_roundtrip.sh`](https://github.com/bfmhno3/firn/blob/ch17/lab/ch17/age_roundtrip.sh) | `env -u CI make ch17` | 退出码 0；42 行；明文 29 字节，密文 229 字节，密钥文件 189 字节；换一把密钥解密失败 |
| [`lab/ch17/ex_agenix_shape.sh`](https://github.com/bfmhno3/firn/blob/ch17/lab/ch17/ex_agenix_shape.sh) | `env -u CI make ch17` | 退出码 0；55 行；规则文件里 2 个公钥；`alice: yes`、`host1: yes`、`mallory: no`（练习 1 的答案） |
| [`lab/ch17/fixtures/readfile_config.nix`](https://github.com/bfmhno3/firn/blob/ch17/lab/ch17/fixtures/readfile_config.nix) | 由 `readfile_leak.sh` 通过 `nix build --file` 使用，本身不被运行器执行 | 8 行；用 `builtins.readFile ./secret.txt` 拼出 `app.conf`，是想法三的 `# BAD` 示例 |
| [`lab/ch17/fixtures/secret.txt`](https://github.com/bfmhno3/firn/blob/ch17/lab/ch17/fixtures/secret.txt) | 被 `readfile_config.nix` 读取，本身不被运行器执行 | 1 行，`firn-lab-readfile-secret-4f2a`，一个故意的假口令 |
| [`lab/ch17/readfile_leak.sh`](https://github.com/bfmhno3/firn/blob/ch17/lab/ch17/readfile_leak.sh) | `env -u CI make ch17` | 退出码 0；22 行；store 文件权限 `444`，内容 `token = firn-lab-readfile-secret-4f2a` |
| [`lab/ch17/secret_in_drv.sh`](https://github.com/bfmhno3/firn/blob/ch17/lab/ch17/secret_in_drv.sh) | `env -u CI make ch17` | 退出码 0；27 行；`.drv` 权限 `444`，`nix derivation show` 里有 `"API_TOKEN":"hunter2-firn-lab"` |
| [`lab/ch17/secrets_vm_host.sh`](https://github.com/bfmhno3/firn/blob/ch17/lab/ch17/secrets_vm_host.sh) | `env -u CI make ch17` | 退出码 0（`_host`，`CI=true` 时跳过）；45 行；6 行 `firn:`，其中 `sops_plaintext_store_paths 0`、`naive_plaintext_store_paths 1`、`naive_store_file_mode 444`；墙钟 102 秒，`volatile`，`--rebuild` 分支 |
| [`lab/ch17/sops_roundtrip.sh`](https://github.com/bfmhno3/firn/blob/ch17/lab/ch17/sops_roundtrip.sh) | `env -u CI make ch17` | 退出码 0；53 行；键明文、值是 `ENC[AES256_GCM,...,type:str]`，`port` 是 `type:int`；`version: 3.13.3`；密文里没有明文；解密后和原文一致 |
| [`lab/ch17/ssh_to_age.sh`](https://github.com/bfmhno3/firn/blob/ch17/lab/ch17/ssh_to_age.sh) | `env -u CI make ch17` | 退出码 0；36 行；转换出的私钥前缀 `AGE-SECRET-KEY-`；`age-keygen -y` 算回的公钥和转换的公钥相同；`host secret` 往返成功 |
| [`lab/ch17/store_world_readable.sh`](https://github.com/bfmhno3/firn/blob/ch17/lab/ch17/store_world_readable.sh) | `env -u CI make ch17` | 退出码 0；28 行；store 文件权限 `444`，`root:root`，内容 `hunter2-firn-lab` |
| [`nixos/modules/secret-demo.nix`](https://github.com/bfmhno3/firn/blob/ch17/nixos/modules/secret-demo.nix) | `env -u CI make ch17`，由 `secrets_vm_host.sh` 执行 | 33 行；第 2 行注释写明 `/run/secrets` 是内存文件系统、VM 里量到 ramfs；`firn-secret-demo: sha256=87cbebfeebc05f7c54ac9336c4b4bbec831227a641951a4bde7edd56020f8590`，明文不在日志里 |
| [`nixos/tests/secrets.nix`](https://github.com/bfmhno3/firn/blob/ch17/nixos/tests/secrets.nix) | `env -u CI make ch17`，由 `secrets_vm_host.sh` 执行 | 81 行；两个节点 `sops` 和 `naive`；含明文的 store 路径 0 对 1；`/run/secrets/firn/token` 权限 `400`，文件系统 `ramfs` |
| [`nixos/tests/secrets/.sops.yaml`](https://github.com/bfmhno3/firn/blob/ch17/nixos/tests/secrets/.sops.yaml) | `cat nixos/tests/secrets/.sops.yaml` | 4 行，216 字节，权限 `644`；一条 `creation_rules`，`secrets\.yaml$` 匹配，一个 age recipient |
| [`nixos/tests/secrets/age-key.txt`](https://github.com/bfmhno3/firn/blob/ch17/nixos/tests/secrets/age-key.txt) | `head -n 3 nixos/tests/secrets/age-key.txt` | 4 行，251 字节，权限 `644`；第一行 `# TEST ONLY: public on purpose, never use outside nixos/tests`；公钥以 `age1mc54q6uv` 开头；第 4 行是私钥，这里不打印 |
| [`nixos/tests/secrets/secrets.yaml`](https://github.com/bfmhno3/firn/blob/ch17/nixos/tests/secrets/secrets.yaml) | `SOPS_AGE_KEY_FILE=nixos/tests/secrets/age-key.txt sops --decrypt nixos/tests/secrets/secrets.yaml` | 17 行，1137 字节，权限 `644`；`version: 3.13.3`；解密得到 `firn: token: correct-horse-battery-staple` |

## 练习

**1\.** 不安装 agenix，只用 `age` 命令行，复现它的模型：一个规则文件把文件名映射到公钥列表，加密给列表里所有的公钥，然后检查哪些密钥能解密。

<details>
<summary>参考答案</summary>

答案是 `lab/ch17/ex_agenix_shape.sh`（[链接](https://github.com/bfmhno3/firn/blob/ch17/lab/ch17/ex_agenix_shape.sh)），摘录和输出在“agenix 对照”一节。关键是三件事：用 `ssh-keygen` 生成三把 ed25519 密钥；用 `nix eval --file secrets.nix --apply` 把规则文件里 `token.age` 的公钥列表取出来，写成每行一个 recipient 的文件；用 `age -R recipients.txt` 加密，然后用三把私钥各 `age -d -i` 一次。输出是 `alice: yes`、`host1: yes`、`mallory: no`。

</details>

**2\.** 给 `secrets.yaml` 再加一个 recipient，让第二把密钥也能解密。写出要敲的命令，并验证“加之前不能解、加之后能解”。

<details>
<summary>参考答案</summary>

在 `.sops.yaml` 的规则里把两个公钥都列出来，然后对已有的文件跑 `sops updatekeys`，它让文件的数据密钥多包一份给新的 recipient；这里用的是 sops 文档里 age 一页的写法（`age: >-` 加逗号分隔的列表）。我在一个临时目录里做了一遍，`a.yaml` 是只给第一把密钥加密的文件：

```text
$ printf 'creation_rules:\n  - path_regex: a\\.yaml$\n    age: >-\n      %s,\n      %s\n' "$(age-keygen -y key.txt)" "$(age-keygen -y second.txt)" > .sops.yaml
$ SOPS_AGE_KEY_FILE=second.txt sops --decrypt a.yaml 2>&1 | head -n 1
Failed to get the data key required to decrypt the SOPS file.
$ SOPS_AGE_KEY_FILE=key.txt sops updatekeys --yes a.yaml 2>&1 | grep -c "^+++"
1
$ SOPS_AGE_KEY_FILE=second.txt sops --decrypt a.yaml
firn:
    token: correct-horse-battery-staple
$ grep -c "recipient: age1" a.yaml
2
```

（手敲，不在 `lab/ch17/` 里）

`updatekeys` 必须用一把已有的私钥运行（这里是 `key.txt`），因为它要先解开数据密钥再包给新 recipient；`grep -c "^+++"` 数的是它打印的“将要加入”的 recipient，1 个；之后第二把密钥能解，文件里 `recipient: age1` 有 2 项。`age-keygen` 和 `printf` 生成两把密钥和 `a.yaml` 的几行我没有重复贴，和“创建规则”一节里的一样。

</details>

**3\.** `sops.useTmpfs = true` 之后，`/run/secrets.d` 的文件系统类型会变成什么？在 `secrets-vm` 测试里验证，不要改 Firn 仓库里的任何文件。

<details>
<summary>参考答案</summary>

借 `secrets-vm.extend` 给 `sops` 节点多加一个模块，把测试脚本换成只打印文件系统类型和挂载选项的版本。这是 `/tmp/scratch17/probe_tmpfs.nix`，过了 `nixfmt --check`：

```nix
{ firnPath }:
let
  firn = builtins.getFlake firnPath;
in
firn.checks.x86_64-linux.secrets-vm.extend {
  modules = [
    {
      nodes.sops.sops.useTmpfs = true;
      testScript = firn.inputs.nixpkgs.lib.mkForce ''
        start_all()
        sops.wait_for_unit("firn-secret-demo.service")
        print(sops.succeed("stat -L -f -c '%T %n' /run/secrets /run/secrets.d"))
        print(sops.succeed("grep ' /run/secrets.d ' /proc/self/mountinfo"))
      '';
    }
  ];
}
```

（手敲，不在 `lab/ch17/` 里）

```text
$ nix build --impure -L --no-link --rebuild --file /tmp/scratch17/probe_tmpfs.nix --argstr firnPath "$PWD" 2>&1 | grep -E "^vm-test-run-secrets> (tmpfs|[0-9]+ [0-9]+ )" | sed "s/^vm-test-run-secrets> //"
tmpfs /run/secrets
tmpfs /run/secrets.d
43 68 0:41 / /run/secrets.d rw,nosuid,nodev,noexec,relatime shared:6 - tmpfs none rw,mode=751,noswap
```

（手敲，不在 `lab/ch17/` 里）

文件系统变成 `tmpfs`，挂载选项里多了 `noswap`（输出最后一行开头的 `43 68` 是挂载编号，每次不同，`volatile`），这正是 `linux.go` 在 `useTmpfs` 时加的那个选项（L35 到 L39）。`--rebuild` 是因为这个探针的结果我已经在 store 里有一份，不加的话 `nix build` 只会打印缓存，不会重新跑；第一次跑不需要它。`noswap` 需要 6.4 以上的内核，虚拟机里的内核是 6.18.45，所以没有走源码里回退到不带 `noswap` 的那条路径。

</details>

**4\.** 在纯求值模式下，对 `/run/secrets/firn/token` 做 `builtins.readFile` 会怎样？这对“把解密后的路径读进配置”这种想法意味着什么？

<details>
<summary>参考答案</summary>

```text
$ nix eval --pure-eval --expr "builtins.readFile \"/run/secrets/firn/token\"" 2>&1 | tail -n 3
             | ^

       error: access to absolute path '/run/secrets/firn/token' is forbidden in pure evaluation mode (use '--impure' to override)
```

（手敲，不在 `lab/ch17/` 里）

纯求值（flake 的默认模式，第 8 篇讲过）直接拒绝读任意绝对路径，所以 flake 里不可能通过这条路把运行时的明文读进配置。反过来，一旦加了 `--impure`，在恰好存在这个文件的机器上（比如你部署用的那台），`readFile` 就读得到，读出来的字符串再插进 `writeText` 或者任何会进 store 的东西，就回到“想法三”。所以规矩是：永远只传路径字符串，不要读它的内容。这是我对机制的推断，只验证了纯求值那一半的报错，`--impure` 那一半沿用了“想法三”的实验。

</details>

## 下一篇

第 18 篇《Home Manager：programs.cairn 与用户级配置》要把同一套模块系统搬到 `$HOME` 上：`programs.cairn`，从模块里生成配置文件，再在一台虚拟机里看激活怎么发生。我猜密钥这个问题在那边会变得更别扭，我读 sops-nix 的 `linux.go` 时看到过一行注释，“We can't create a ramfs as user”：用户级的激活大概没有 root，也就没法挂载 ramfs，`MountSecretFs` 在用户模式下直接返回。sops-nix 仓库里确实有一个 `modules/home-manager` 目录，我这一篇没有用它，也没有读它。
