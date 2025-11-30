---
title: "在 Windows 上使用 Docker、Git Bash 和 overleaf-toolkit 部署 Overleaf 社区版"
date: 2025-10-18 22:30:00 +08:00
excerpt: >-
  本教程提供了一份详尽的指南，旨在帮助用户在 Windows 10/11 系统上，通过 Docker Desktop 和 Git Bash 成功部署 Overleaf 社区版。文章重点解决了官方 overleaf-toolkit 脚本在 Windows 环境下因路径不兼容而导致的部署失败问题，并提供了简单有效的脚本修复方案。跟随本教程，您可以轻松搭建一个属于自己的私有 Overleaf 实例，确保数据安全与访问稳定。
categories:
  - Tutorial
tags:
  - Docker
  - Overleaf
  - Git Bash
  - Windows
toc: true
---

## 0. 前言

[Overleaf](https://www.overleaf.com/) 是一个广受欢迎的在线 LaTeX 编辑器，它极大地简化了 LaTeX 的使用门槛。虽然官方提供了在线服务，但是处于数据隐私、网络稳定或自定义需求，我们常常希望搭建一个私有的 Overleaf 实例。Overleaf 官方提供了基于 Docker 的 `toolkit` 工具来简化社区版的部署流程。

然而，官方的 `toolkit` 主要面向 Linux/macOS 环境，在 Windows 上通过 Git Bash 执行时会遇到一个棘手的路径问题。本教程将详细记录如何在 Windows 11/10 环境下，借助 Docker Desktop 和 Git Bash，成功部署 Overleaf 社区版，并提供关键的脚本修复方案。

## 1. 环境准备

在开始之前，请确保你的系统已安装并正确配置了以下软件：

- Windows 10/11：需开启 Hyper-V 或 WSL 2 功能
- [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/)：建议使用 WSL 2 后端，性能更佳。安装后请确保 Docker 服务已正常启动。
- [Git for Windows](https://git-scm.com/downloads/win): 安装时请务必勾选 `Git Bash Here` 选项，我们将使用它来执行 shell 脚本。

**笔者环境参考**：

- OS: Windows 11 Professional 24H2
- Docker: 28.5.1
- Git: 2.51.0.windows.2

## 2. 部署步骤

### 第一步：克隆 Overleaf Toolkit 仓库

首先，打开 Git Bash，选择一个你喜欢的工作目录（例如 `D:\`），然后执行以下命令克隆官方的 `toolkit` 仓库：

```bash
# 进入 D:\
cd /d

# 克隆官方仓库
git clone https://github.com/overleaf/toolkit.git ./overleaf-toolkit
cd ./overleaf-toolkit
```

### 第二步：修复 Windows 路径兼容性问题

这是整个教程最核心的一步。官方的 `docker-compose` 脚本在生成容器挂载路径时，没有正确处理 Git Bash 在 Windows 上的路径格式，导致 Docker 无法找到数据卷。

我已就此问题向官方提交了 [Issue #379](https://github.com/overleaf/toolkit/issues/379)，并提交了修复方案 [PR #380](https://github.com/overleaf/toolkit/pull/380)。

鉴于此 PR 还并未被合并到主分支，需要用户自行进行修改。

解决方案如下：

使用你喜欢的代码编辑器（如 VS Code 或者记事本）打开 `bin/docker-compose` 文件。

找到 `set_base_vars()` 函数，其中有两次对 `OVERLEAF_IN_CONTAINER_DATA_PATH` 变量的赋值。我们需要在路径的开头额外添加一个斜杠 `/`。

修改前：

```bash
OVERLEAF_IN_CONTAINER_DATA_PATH=/var/lib/overleaf
```

修改后：

```bash
OVERLEAF_IN_CONTAINER_DATA_PATH=//var/lib/overleaf
```

注意：此函数有**两处** `OVERLEAF_IN_CONTAINER_DATA_PATH=/var/lib/overleaf`，请务必全部修改。这个修改的本质是帮助 Git Bash/MSYS2 正确地将 POSIX 风格的路径 `/var/lib/overleaf` 转换为 Docker 能理解的 Windows 路径。

### 第三步：初始化并启动 Overleaf 服务

修改脚本后，我们回到 Git Bash 终端，继续在 `overleaf-toolkit` 目录下执行命令。

#### 初始化 Overleaf 配置

执行 `init` 命令，该命令会生成初始化配置文件，例如 `config/overleaf.rc`、`config/variables.env`、`config/version` 等。

```bash
./bin/init
```

#### 启动 Overleaf 容器服务

初始化完成后，执行 `up` 命令来启动所有服务。

```bash
./bin/up
```

提示：首次执行时，由于需要下载多个 Docker 镜像，此过程可能会持续较长时间，具体取决于你的网络速度。请耐心等待，确保所有镜像都成功拉取。

执行成功后，你将看到大量的服务日志输出。

### 第四步：首次访问与管理员配置

服务启动后，打开你的浏览器，访问 `http://127.0.0.1`。

首次访问时，你会被引导至管理员账户创建页面。请根据提示设置你的第一个管理员用户的邮箱和密码。创建成功后，你就可以使用这个账户登录并开始使用你的私有 Overleaf 实例了！

## 3. 日常管理

在日常使用中，你可能会需要启动或停止 Overleaf 服务。

- 停止服务：在 `overleaf-toolkit` 目录下打开 Git Bash，执行：

```bash
./bin/stop
```

- 重新启动服务：同样，在 `overleaf-toolkit` 目录下执行：

```bash
./bin/up
```

## 总结

通过对 `bin/docker-compose` 脚本进行一个小小的修改，我们成功解决了 `overleaf-toolkit` 在 Windows + Git Bash 环境下的路径兼容性问题，顺利地部署了 Overleaf 社区版。自托管 Overleaf 不仅保障了数据安全，还提供了更自由的定制空间。

希望这篇教程能帮助到同样遇到此问题的同学。
