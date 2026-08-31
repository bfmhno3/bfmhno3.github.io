---
title: "从零学习 vcpkg: 用现代 CMake 做一个 HTTP CLI"
commentId: "post:vcpkg-modern-cmake-http-client"
published: "2026-08-30 20:00:00 +08:00"
description: "我用 vcpkg、现代 CMake、CPR、CLI11 和 spdlog 做了一个可运行的命令行 HTTP 客户端，并沿着清单、baseline、triplet、toolchain 和 imported target 把 C/C++ 依赖管理串起来。"
category: Tutorial
tags:
  - C++
  - vcpkg
  - CMake
  - CLI
draft: false
comment: true
slug: vcpkg-modern-cmake-http-client
---

我过去写的嵌入式项目主要使用 C，依赖通常是芯片厂商 SDK、几份直接放进仓库的源码，以及一些自己维护的驱动，所以我很少认真面对 C/C++ 包管理。Python 有 pip，JavaScript/TypeScript 有 npm 和 pnpm，Rust 有 Cargo；C++ 则把编译器、构建系统和包管理器拆成了三件事。于是我决定不再只背 `vcpkg install`，而是用 vcpkg、现代 CMake 和 3 个第三方库做一个真的能发出请求的 HTTP CLI，然后看看每一层到底负责什么。

这个小程序叫 `vhttp`。它支持 GET、POST、自定义 Header、超时和详细日志。CLI11 解析命令行，CPR 发送 HTTP 请求，spdlog 记录状态。3 个直接依赖最后展开成 10 个需要安装的 port，刚好足以看到包管理器开始工作，又没有膨胀成另一个 curl（我只是来学 vcpkg，不是来重写互联网的）。

## 先把 3 个角色分开

C/C++ 依赖管理容易混乱，通常不是因为命令太多，而是因为几种工具同时出现在终端里：

- **编译器**：GCC、Clang 或 MSVC，把源文件变成目标文件，并参与链接。
- **CMake**：构建系统生成器，描述 target、源文件、编译选项和链接关系，再生成 Ninja、Makefile 或 Visual Studio 工程。
- **vcpkg**：包管理器，解析依赖图，取得源码和 port 配方，按目标平台构建并安装库，再把它们交给 CMake 查找。

我把 vcpkg 想成仓库管理员，把 CMake 想成装配清单。仓库管理员负责把零件放到正确货架，装配清单负责说明 `vhttp` 需要哪些零件以及如何连接。二者会合作，但不是同一个东西。

vcpkg 也不等于一个只下载预编译二进制的商店。它的 registry 主要保存 port 的版本信息、补丁和构建配方，很多库会在本机按 triplet 编译。第一次安装 OpenSSL 或 Boost 时看到编译器忙起来，不是 vcpkg 突然兼职写代码，而是它正在按配方生产当前平台需要的产物。

## 安装 vcpkg

官方的通用安装方式是克隆仓库并运行 bootstrap 脚本：

```bash
git clone https://github.com/microsoft/vcpkg.git
cd vcpkg
./bootstrap-vcpkg.sh -disableMetrics
```

Windows PowerShell 对应：

```powershell
git clone https://github.com/microsoft/vcpkg.git
cd vcpkg
.\bootstrap-vcpkg.bat -disableMetrics
```

bootstrap 会准备 `vcpkg` 可执行文件。然后设置 `VCPKG_ROOT`，并把可执行文件加入 `PATH`。Linux 或 macOS 可以写入自己的 shell 配置：

```bash
export VCPKG_ROOT="$HOME/tools/vcpkg"
export PATH="$VCPKG_ROOT:$PATH"
```

PowerShell 当前会话可以这样设置：

```powershell
$env:VCPKG_ROOT = "C:\tools\vcpkg"
$env:PATH = "$env:VCPKG_ROOT;$env:PATH"
```

最后检查实际入口，而不是假设 bootstrap 已经替我们处理了所有环境变量：

```console
$ vcpkg version
vcpkg package management program version 2026-07-27-98d7cb0cf1f4686a3e43aa5672b6230c1d56bce8
```

版本会变化。这里真正重要的是命令可以运行，并且 `VCPKG_ROOT` 指向包含 `scripts/buildsystems/vcpkg.cmake` 的那份 vcpkg。

## Classic mode 和 Manifest mode

vcpkg 有两种工作模式：

| 模式 | 依赖声明 | 安装位置 | 适合场景 |
| --- | --- | --- | --- |
| Classic mode | 主要靠命令安装 | `$VCPKG_ROOT/installed` | 临时试用、旧项目 |
| Manifest mode | 项目提交 `vcpkg.json` | 每个项目自己的安装树 | 正式项目、版本控制、CI |

Classic mode 的体验接近系统级仓库：

```bash
vcpkg install fmt
vcpkg install fmt:x64-windows
```

这很适合快速试一个库，但依赖关系存在于开发者的机器里。换一台机器后，项目本身没有完整声明告诉我们该装什么。

Manifest mode 把直接依赖写进 `vcpkg.json`，并为每个项目维护独立安装树。它也支持 baseline、版本约束、override 和自定义 registry。对新项目，我会直接使用 Manifest mode。把依赖写进仓库，比把它们记在脑内某个没有备份的 YAML 文件里可靠得多。

## 建立 `vhttp`

先创建目录并初始化应用清单：

```bash
mkdir vhttp
cd vhttp
vcpkg new --application
vcpkg add port cli11
vcpkg add port cpr
vcpkg add port spdlog
```

`vcpkg new --application` 会创建项目清单和 registry 配置，`vcpkg add port` 则把直接依赖写进清单。项目最终结构如下：

```text
vhttp/
├── CMakeLists.txt
├── CMakePresets.json
├── src/
│   └── main.cpp
├── vcpkg-configuration.json
└── vcpkg.json
```

我还会忽略本机构建产物：

```text
/build/
/vcpkg_installed/
CMakeUserPresets.json
```

`vcpkg.json` 很短：

```json
{
  "name": "vhttp",
  "version-semver": "0.1.0",
  "dependencies": [
    "cli11",
    "cpr",
    "spdlog"
  ]
}
```

它只声明**直接依赖**。CPR 需要 curl，curl 的 HTTPS 支持需要 OpenSSL 和 zlib，spdlog 默认又需要 fmt；这些传递依赖由 vcpkg 解图，不应该为了复制一次安装输出就全部手写进 `dependencies`。

`vcpkg-configuration.json` 保存 registry 和 baseline：

```json
{
  "default-registry": {
    "kind": "git",
    "baseline": "1390a3d90e08a7901a7781d31332a662102cd5cc",
    "repository": "https://github.com/microsoft/vcpkg"
  }
}
```

baseline 是 vcpkg registry 的一个 Git commit。它给整张依赖图一个确定的版本地板，让两台机器不要因为各自恰好在不同日期安装，就悄悄选到不同 port 版本。上面的 commit 是我这次实验实际使用的快照；新项目应该保留 `vcpkg new` 为自己生成的值，而不是机械复制它。

需要主动更新依赖视野时，可以运行：

```bash
vcpkg x-update-baseline
```

更新 baseline 是一个明确的依赖升级动作，应该连同构建结果一起审查和提交。它不是每次构建前都要念一遍的咒语。

> [!NOTE]
> baseline 并不等于传统意义上的 lockfile。它确定 registry 快照；`version>=` 表达最低版本，`overrides` 可以强制精确版本。大多数应用先固定 baseline，只在确有需要时增加版本约束或 override，会比给每个传递依赖手工钉死版本更容易维护。

## 用 CMake Presets 接上 vcpkg

vcpkg 通过一个 CMake toolchain 文件接入配置过程。关键点是：CMake 在执行第一次 `project()` 时就会确定工具链，所以 `CMAKE_TOOLCHAIN_FILE` 必须在那之前可见。

我不把本机的绝对路径写进 `CMakeLists.txt`，而是提交一份 `CMakePresets.json`：

```json
{
  "version": 6,
  "configurePresets": [
    {
      "name": "dev",
      "displayName": "Development build with vcpkg",
      "generator": "Ninja",
      "binaryDir": "${sourceDir}/build/${presetName}",
      "cacheVariables": {
        "CMAKE_BUILD_TYPE": "Debug",
        "CMAKE_EXPORT_COMPILE_COMMANDS": true,
        "CMAKE_TOOLCHAIN_FILE": "$env{VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake"
      }
    }
  ],
  "buildPresets": [
    {
      "name": "dev",
      "configurePreset": "dev"
    }
  ]
}
```

Preset 固定了生成器、构建目录和共享配置，但通过环境变量取得每台机器自己的 vcpkg 路径。团队可以提交这份文件；如果某人不想全局设置 `VCPKG_ROOT`，也可以在不提交的 `CMakeUserPresets.json` 中继承 `dev` 并设置本机环境。

配置时，vcpkg toolchain 会发现项目根目录中的 manifest，并自动执行安装：

```bash
cmake --preset dev
```

我第一次配置时声明了 3 个直接依赖，vcpkg 实际列出了 10 个 port：

```text
cli11
cpr
curl
fmt
openssl
spdlog
vcpkg-cmake
vcpkg-cmake-config
vcpkg-cmake-get-vars
zlib
```

从 3 个名字展开到 10 个构建节点，这就是手工下载压缩包、复制 include 路径和寻找 `.a`/`.lib` 文件开始变得不太可爱的地方。Manifest mode 会把这棵安装树放进当前构建目录的 `vcpkg_installed`，不会污染另一个项目。

## 现代 CMake 只围绕 target 工作

根目录的 `CMakeLists.txt` 如下：

```cmake
cmake_minimum_required(VERSION 3.25)

project(vhttp VERSION 0.1.0 LANGUAGES CXX)

find_package(CLI11 CONFIG REQUIRED)
find_package(cpr CONFIG REQUIRED)
find_package(spdlog CONFIG REQUIRED)

add_executable(vhttp)
target_sources(vhttp PRIVATE src/main.cpp)
target_compile_features(vhttp PRIVATE cxx_std_20)
target_link_libraries(vhttp
    PRIVATE
        CLI11::CLI11
        cpr::cpr
        spdlog::spdlog
)

target_compile_options(vhttp
    PRIVATE
        $<$<CXX_COMPILER_ID:MSVC>:/W4>
        $<$<CXX_COMPILER_ID:MSVC>:/permissive->
        $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-Wall>
        $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-Wextra>
        $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-Wpedantic>
)
```

这里没有全局 `include_directories()`，没有硬编码 `lib` 路径，也没有 `link_directories()`。`find_package(... CONFIG REQUIRED)` 找到库导出的 CMake package config，`CLI11::CLI11`、`cpr::cpr` 和 `spdlog::spdlog` 则是 imported target。

这些 target 自带 include 目录、编译定义和传递链接要求。`vhttp` 只需要声明"我以 `PRIVATE` 方式链接它们"。这就是现代 CMake 最重要的习惯：让 target 携带 usage requirements，而不是把一堆全局状态泼到整个目录上。

`target_compile_features(vhttp PRIVATE cxx_std_20)` 也比手工拼 `-std=c++20` 更可移植。警告选项确实因编译器而不同，所以我用 generator expression 在生成阶段选择 MSVC 或 GCC/Clang 的参数。

## 写一个真的 HTTP 客户端

`src/main.cpp` 的完整实现如下：

```cpp
#include <algorithm>
#include <cctype>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include <CLI/CLI.hpp>
#include <cpr/cpr.h>
#include <spdlog/spdlog.h>

namespace {

cpr::Header ParseHeaders(const std::vector<std::string>& raw_headers) {
  cpr::Header headers;
  for (const auto& raw : raw_headers) {
    const auto colon = raw.find(':');
    if (colon == std::string::npos || colon == 0) {
      throw std::runtime_error("invalid header, expected 'Name: Value': " +
                               raw);
    }

    auto value_start = colon + 1;
    while (value_start < raw.size() && raw[value_start] == ' ') {
      ++value_start;
    }
    headers.emplace(raw.substr(0, colon), raw.substr(value_start));
  }
  return headers;
}

std::string ToUpper(std::string value) {
  std::ranges::transform(value, value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::toupper(ch));
  });
  return value;
}

}  // namespace

int main(int argc, char* argv[]) {
  CLI::App app{"A tiny HTTP client built with vcpkg"};

  std::string url;
  std::string method{"GET"};
  std::string body;
  std::vector<std::string> raw_headers;
  int timeout_ms{5000};
  bool verbose{false};

  app.add_option("url", url, "Request URL")->required();
  app.add_option("-X,--request", method, "HTTP method: GET or POST");
  app.add_option("-H,--header", raw_headers, "Request header, repeatable");
  app.add_option("-d,--data", body, "POST request body");
  app.add_option("--timeout", timeout_ms, "Timeout in milliseconds")
      ->check(CLI::PositiveNumber);
  app.add_flag("-v,--verbose", verbose, "Enable debug logs");

  CLI11_PARSE(app, argc, argv);

  method = ToUpper(method);
  if (method != "GET" && method != "POST") {
    spdlog::error("unsupported method: {}", method);
    return 1;
  }

  try {
    spdlog::set_level(verbose ? spdlog::level::debug : spdlog::level::info);
    spdlog::debug("{} {} (timeout={} ms)", method, url, timeout_ms);

    cpr::Session session;
    session.SetUrl(cpr::Url{url});
    session.SetHeader(ParseHeaders(raw_headers));
    session.SetTimeout(cpr::Timeout{timeout_ms});

    cpr::Response response;
    if (method == "POST") {
      session.SetBody(cpr::Body{body});
      response = session.Post();
    } else {
      response = session.Get();
    }

    if (response.error.code != cpr::ErrorCode::OK) {
      spdlog::error("request failed: {}", response.error.message);
      return 2;
    }

    spdlog::info("HTTP {} in {:.0f} ms, {} bytes", response.status_code,
                 response.elapsed * 1000.0, response.text.size());
    std::cout << response.text;
    if (!response.text.ends_with('\n')) {
      std::cout << '\n';
    }

    return response.status_code >= 400 ? 3 : 0;
  } catch (const std::exception& error) {
    spdlog::error("{}", error.what());
    return 1;
  }
}
```

这里有一个刻意的接口设计：spdlog 把诊断信息写到标准错误，响应 body 写到标准输出。因此可以把 body 继续交给其他程序，而日志不会混进数据流：

```bash
vhttp https://example.com/api | jq .
```

`jq` 是一个处理 JSON 的命令行工具；管道符 `|` 会把 `vhttp` 写到标准输出的响应 body 交给 `jq`，最后的 `.` 表示读取并格式化整个 JSON 值。例如服务返回一行紧凑 JSON 时，`jq .` 会把它缩进为更容易阅读的多行结构。`jq` 不是 `vhttp` 的依赖，需要按操作系统单独安装；如果不需要格式化 JSON，直接运行 `vhttp https://example.com/api` 即可。

返回码也区分了几类失败：参数或 Header 错误返回 1，传输错误返回 2，HTTP 4xx/5xx 返回 3。HTTP 404 和 TCP 连接失败不是一回事，CLI 最好不要把它们都压成一个含糊的 `false`。

## 配置、构建和运行

有了 configure preset 和 build preset，基本循环只有两条命令：

```bash
cmake --preset dev
cmake --build --preset dev
```

我的实际构建只有 2 个 Ninja step：编译 `main.cpp`，然后链接 `vhttp`。

```bash
[1/2] Building CXX object CMakeFiles/vhttp.dir/src/main.cpp.o
[2/2] Linking CXX executable vhttp
```

为了避免把外部网络状态混进验证，我使用 Python 3 标准库自带的 `http.server` 在本机启动了一个静态文件服务器。它不需要额外安装 Web 框架，只要系统中的 `python3` 命令可用即可。

我先在项目根目录创建测试目录和响应文件。`printf` 不会额外改写内容，因此这个文件恰好是 17 bytes：

```bash
mkdir -p http-fixture
printf 'hello from vhttp\n' > http-fixture/hello.txt
```

然后打开第一个终端，在项目根目录启动服务器：

```bash
$ python3 -m http.server 18080 \
    --bind 127.0.0.1 \
    --directory http-fixture
Serving HTTP on 127.0.0.1 port 18080 (http://127.0.0.1:18080/) ...
```

- `-m http.server` 让 Python 运行标准库中的静态 HTTP server 模块。
- `18080` 是监听端口。
- `--bind 127.0.0.1` 只允许本机访问，避免把临时测试服务暴露到局域网。
- `--directory http-fixture` 把刚才创建的目录作为网站根目录。

这条命令会占用当前终端并持续运行。验证结束后按 <kbd>Ctrl</kbd> + <kbd>C</kbd> 停止服务。Windows 如果安装了 Python Launcher，也可以把命令开头的 `python3` 换成 `py`。

接着打开第二个终端，仍然进入 `vhttp` 项目根目录，再运行客户端。URL 中的 `/hello.txt` 对应 `http-fixture/hello.txt`：

```bash
$ ./build/dev/vhttp -v http://127.0.0.1:18080/hello.txt
[debug] GET http://127.0.0.1:18080/hello.txt (timeout=5000 ms)
[info] HTTP 200 in 76 ms, 17 bytes
hello from vhttp
```

POST 和重复 Header 使用相同的可执行文件：

```bash
./build/dev/vhttp \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"message":"hello"}' \
  https://httpbin.org/post
```

这个外部 URL 只用于演示命令形式，服务可用性和响应时间不属于程序的确定性保证。

## 日常需要哪些 vcpkg 操作

我最后留下的是一组很短的操作表：

```bash
# 搜索 registry 中的 port
vcpkg search cpr

# 向 manifest 添加直接依赖
vcpkg add port cpr

# 按当前 manifest 手动安装
vcpkg install

# 更新 registry baseline
vcpkg x-update-baseline

# 查看 triplet 帮助
vcpkg help triplet
```

在 Manifest mode 中，移除依赖的干净做法是从 `vcpkg.json` 的 `dependencies` 删除它，再重新配置或运行 `vcpkg install`，让声明成为唯一事实来源。不要一边保留 manifest 声明，一边手工删除安装树里的文件，那会把"当前状态"和"期望状态"重新拆开。

triplet 描述目标架构、操作系统、运行库和链接方式。常见默认值包括 `x64-windows`、`x64-linux` 和 `x64-osx`。如果需要 Windows 静态链接，可以在 preset 的 `cacheVariables` 中明确设置：

```json
"VCPKG_TARGET_TRIPLET": "x64-windows-static"
```

改变 triplet、编译器或重要 vcpkg 配置后，我会使用新的 build 目录或删除旧 CMake cache 再配置。CMake cache 记住了第一次配置的工具链；试图在同一个目录里把整套 ABI 偷梁换柱，通常只会得到一段很有教育意义的错误日志。

vcpkg 默认还会使用 binary cache。第一次从源码构建后，它可以按 ABI hash 复用已构建包；CI 或团队也能通过 `VCPKG_BINARY_SOURCES` 配置共享文件、HTTP、NuGet 等后端。对这个小项目，本地默认 cache 已经够用。等构建 OpenSSL 的次数开始按团队人数相乘时，再配置共享 cache，收益会非常具体。

## 我实际踩到的坑

**`find_package()` 找不到库。** 最常见原因不是库名拼错，而是配置阶段根本没有加载 vcpkg toolchain。检查 `VCPKG_ROOT`、preset 展开结果和 build 目录，不要靠全局 `include_directories()` 把错误暂时盖住。

**下载失败不等于编译失败。** 我第一次拉取 CPR 和 fmt 源码时遇到 `curl error 56`。重新下载后，vcpkg 继续使用已经完成的 port 和 binary cache，不需要从 0 重建全部 10 个节点。网络、port 构建和项目编译是 3 个阶段，先看失败发生在哪一层。

**不要猜 CMake target 名。** port 安装完成后，vcpkg 会打印 usage，例如 `find_package(cpr CONFIG REQUIRED)` 和 `target_link_libraries(... cpr::cpr)`。包名、CMake package 名和 target 名不保证大小写或拼写完全一致，安装输出和 port 文档比直觉可靠。

**不要把 toolchain 路径硬编码进项目。** 本机的 `C:\tools\vcpkg` 对另一台机器没有意义。共享 preset 引用 `$env{VCPKG_ROOT}`，本机差异放环境变量或 `CMakeUserPresets.json`，边界会清楚很多。

## 再往前一步

这次实验最有价值的产物其实不是 100 多行 C++，而是一条可以重复的链路：`vcpkg.json` 声明依赖，baseline 固定 registry 视图，triplet 描述目标 ABI，vcpkg toolchain 把安装树暴露给 CMake，imported target 再把 usage requirements 传给 `vhttp`。

我以后写桌面工具、网络服务或需要第三方库的嵌入式上位机时，大概率会继续沿用这套结构。项目变大后，可以增加自定义 triplet、manifest feature、overlay port 和共享 binary cache，但核心仍然是这 5 个文件和两条 CMake 命令。C++ 仍然没有突然长出一个随语言发行的 Cargo，不过现在至少依赖不再散落在下载目录和项目属性对话框里。很好，我可以继续写 C++ 了。

## 参考资料

- [vcpkg 官方入门: Install and use packages with CMake](https://learn.microsoft.com/en-us/vcpkg/get_started/get-started)
- [vcpkg Manifest mode](https://learn.microsoft.com/en-us/vcpkg/concepts/manifest-mode)
- [vcpkg 与 CMake 集成](https://learn.microsoft.com/en-us/vcpkg/users/buildsystems/cmake-integration)
- [vcpkg Versioning reference](https://learn.microsoft.com/en-us/vcpkg/users/versioning)
- [vcpkg Triplets](https://learn.microsoft.com/en-us/vcpkg/concepts/triplets)
- [CPR](https://github.com/libcpr/cpr)
- [CLI11](https://github.com/CLIUtils/CLI11)
- [spdlog](https://github.com/gabime/spdlog)
