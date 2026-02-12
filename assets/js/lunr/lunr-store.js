var store = [{
        "title": "学习 fgets 函数和 strcspn 函数",
        "excerpt":"0. 为什么要专门发布一篇文章来说明这两个函数？ 原因是今晚上在做牛客网的题目的时候，遇到了这么一个问题。 虽然这道题对大多数人来说都算是比较简单的题目，但是对于我这么一个小白还是比较难写的。最开始我是这么写的代码： #include &lt;stdio.h&gt; void reverse(char* arr) { char* left = arr; char* right = &amp;arr[strlen(arr) - 1]; while(left &lt; right) { char mid = *left; *left = *right; *right = mid; left++; right--; } for(int i = 0; i &lt; strlen(arr); i++) { printf(\"%c\", arr[i]); } }...","categories": ["Note"],
        "tags": ["C"],
        "url": "/note/learning-fgets-and-strcspn/",
        "teaser": "/assets/images/logo-teaser.png"
      },{
        "title": "VMware Workstation 17.x 中的虚拟机按键反应迟钝解决办法",
        "excerpt":"问题描述 在 VMware Workstation 17.x 中的虚拟机按键反映迟钝，具体而言即是屏幕显示的字符速度跟不上手打字的速度，你能很明显得感觉到迟钝。 特别是长按方向键选择时，长按一两秒，光标会移动好几秒，跟手性非常差，非常难受。 笔者这里所说的“跟手性”是指：当用户开始输入时，屏幕就开始刷新字符，刷新字符的速度与用户打字的速度不能差太多，并且当用户停止输入时，屏幕能立即停止刷新字符。 笔者环境 VMware Workstatio 17 Pro：17.6.3 build-24583834 虚拟机：Ubuntu 16.04 操作系统：Windows 11 专业版 26100.4061 解决方法 请按照以下步骤操作，修改虚拟机的配置文件： 关闭虚拟机：确保虚拟机处于完全关闭状态（Power Off），而非挂起（Suspend）。 找到配置文件：进入虚拟机所在的文件夹，找到后缀为 .vmx 的配置文件（通常与虚拟机同名）。 编辑文件：右键点击该文件，选择使用记事本（Notepad）或 VS Code 打开。 添加配置：在文件的末尾添加以下代码： keyboard.vusb.enable = \"TRUE\" 保存并重启：保存文件后，重新启动虚拟机即可生效。 原理说明：该配置强制启用了虚拟 USB 键盘设备，绕过了某些导致延迟的输入仿真层。 测试环境 Ubuntu 16.04 Ubuntu 18.04 Ubuntu 22.04 ElementaryOS 7 Horus 在以上虚拟机中，笔者对此方法进行了测试，都取得了很好的效果。...","categories": ["Tutorial"],
        "tags": ["VMware Workstation"],
        "url": "/tutorial/vmware-keyboard-lag-fix/",
        "teaser": "/assets/images/logo-teaser.png"
      },{
        "title": "Visual Studio C++ 工程实践指南",
        "excerpt":"解决方案（Solution）与项目（Project） 一个解决方案是用于组织和管理一个或多个相关联项目的容器。这套结构旨在将一个复杂的实际问题，分解成多个功能独立的模块（项目）来开发和管理。 解决方案（.sln 文件）：这是最高层级的组织单位，它定义了所包含的项目以及它们之间的依赖关系和构建配置。当你打开一个 .sln 文件时，Visual Studio 会加载整个工作区。 项目（.vcxproj、csproj 等文件）：每个项目对应一个独立的模块，最终会生成一个可执行文件（.exe）、一个静态库（.lib）或一个动态链接库（.dll）。 需要注意的地方： 单一启动项目：在一个解决方案中，通常只有一个项目被设置为启动项目。启动项目是点击 “开始调试”（F5）时，Visual Studio 将会编译和运行的项目。可以在解决方案资源管理器中右键点击不同的项目，选择 “设为启动项目“。 “将解决方案和项目放在同一目录中”： 勾选：解决方案文件（.sln）和项目文件（例如 .vcxproj）会存放在同一个文件夹中。这对于只有一个或少数几个项目的简单解决方案来说，目录结构更扁平、更清晰。 不勾选（默认）：Visual Studio 会创建一个顶层文件夹来存放解决方案文件（.sln），然后在该文件夹下为每一个项目再创建一个独立的子文件夹。当解决方案包含多个项目时，这种结构更加有条理，是更推荐的做法。 过滤器（Filter） 过滤器（Filter）是 Visual Studio 解决方案资源管理器中的一个虚拟文件夹结构。它的主要作用是帮助开发者组织和分类源文件、头文件等，使项目看起来更整洁，所有的代码文件（源文件和头文件）都应该加入过滤器中。开发者可以自由地创建、重命名或删除过滤器，这不会影响磁盘上文件的实际位置。 而对于编译器（例如 MSVC、GCC 等）在编译代码时，只关心真实的目录结构，而非过滤器中的配置。所以当编译器报错 “无法打开源文件” 或 “找不到头文件” 之类的错误时，问题几乎总是出在项目属性的路径配置上，而不是解决方案资源管理器的过滤器结构。 如何正确配置包含目录？ 当项目需要引入外部头文件（例如来自另一个项目货第三方库）时，必须明确告知编译器去哪里查找这些文件。 在解决方案资源管理器中右键点击项目，选择属性。 确保顶部的配置和平台设置正确。 导航到 C/C++ $\\rightarrow$ 常规。 在附加包含目录字段中，添加所需头文件所在的真实目录路径。 在 Visual Studio 中选择的目录会被设置为绝对路径，当解决方案发生移动，或者发送给合作者时，就会导致错误。这可以通过 Visual Studio 中提供的宏来解决。...","categories": ["Note"],
        "tags": ["Visual Studio"],
        "url": "/note/visual-studio-project-management/",
        "teaser": "/assets/images/logo-teaser.png"
      },{
        "title": "Notes of Effective CMake",
        "excerpt":"1. The Philosophy of Modern CMake Why “Effective CMake”? Just like with C++, the way you write CMake code significantly impacts your project’s maintainability, ease of use for others, and scalability. Adopting modern practices is key. CMake is Code Treat your CMakeLists.txt files with the same care as your source...","categories": ["Note"],
        "tags": ["CMake"],
        "url": "/note/notes-of-effective-cmake/",
        "teaser": "/assets/images/logo-teaser.png"
      },{
        "title": "在 Windows 上使用 Docker、Git Bash 和 overleaf-toolkit 部署 Overleaf 社区版",
        "excerpt":"0. 前言 Overleaf 是一个广受欢迎的在线 LaTeX 编辑器，它极大地简化了 LaTeX 的使用门槛。虽然官方提供了在线服务，但是处于数据隐私、网络稳定或自定义需求，我们常常希望搭建一个私有的 Overleaf 实例。Overleaf 官方提供了基于 Docker 的 toolkit 工具来简化社区版的部署流程。 然而，官方的 toolkit 主要面向 Linux/macOS 环境，在 Windows 上通过 Git Bash 执行时会遇到一个棘手的路径问题。本教程将详细记录如何在 Windows 11/10 环境下，借助 Docker Desktop 和 Git Bash，成功部署 Overleaf 社区版，并提供关键的脚本修复方案。 1. 环境准备 在开始之前，请确保你的系统已安装并正确配置了以下软件： Windows 10/11：需开启 Hyper-V 或 WSL 2 功能 Docker Desktop for Windows：建议使用 WSL...","categories": ["Tutorial"],
        "tags": ["Docker","Overleaf","Git Bash","Windows"],
        "url": "/tutorial/deploy-overleaf-community-on-windows-with-docker-and-git-bash/",
        "teaser": "/assets/images/logo-teaser.png"
      },{
        "title": "小米手机 (HyperOS/MIUI) 深度优化指南：移除 AI 组件与去广告",
        "excerpt":"随着 HyperOS 和 MIUI 的更新，系统集成了越来越多的 AI 功能和后台服务。虽然部分功能很实用，但对于追求极致流畅、隐私保护或老机型用户来说，这些组件可能意味着额外的耗电和卡顿。 本文将介绍如何通过 ADB (Android Debug Bridge) 安全地移除这些组件，并进行系统级优化。 通过 ADB 卸载 AI 及冗余组件 此操作不需要 ROOT 权限，但需要一台电脑（Windows/Mac/Linux 均可）。 1. 准备工作 开启开发者模式： 进入设置 $\\rightarrow$ 我的设备 $\\rightarrow$ 全部参数。 连续点击“OS 版本号”约 5-7 次，直到提示“您已处于开发者模式”。 开启 USB 调试： 进入设置 $\\rightarrow$ 更多设置 $\\rightarrow$ 开发者选项。 开启“USB 调试”。 开启 “USB 调试（安全设置）”（重要：如果不开启此项，部分系统应用无法被卸载，提示 Permission denied）。 连接电脑：...","categories": ["Tutorial"],
        "tags": ["XiaoMi","RedMi","HyperOS","MIUI","Android","ADB"],
        "url": "/tutorial/xiaomi-debloat-guide/",
        "teaser": "/assets/images/logo-teaser.png"
      },{
        "title": "CS2 游戏设置优化",
        "excerpt":"CS2（Counter-Strike 2）是 Valve 推出的经典第一人称射击游戏，继承了 CS:GO 的核心玩法并全面升级了 Source 2 引擎。 游戏的默认设置通常并不适合竞技，我们需要做出一些更改。本文设置的核心逻辑是：流畅度（FPS） &gt; 画面清晰度（能看清敌人） &gt; 画面特效。 启动项设置（Launch Options） 在 Steam 库中右键 CS2 $\\rightarrow$ 属性 $\\rightarrow$ 通用 $\\rightarrow$ 启动选项，输入以下代码： -novid -nojoy -consold -high +fps_max 0 novid：跳过开场动画，启动更快。 nojoy：禁用手柄支持，释放少量系统资源。 -console：开启控制台。 -high：将 CS2 进程设置为高优先级，理论上能提升性能稳定性。 +fps_max 0：解除游戏内帧率上限，让显卡全力运行。 视频设置（Video Settings） 按 Esc $\\rightarrow$ 设置 $\\rightarrow$ 视频 $\\rightarrow$ 高级视频...","categories": ["Tutorial"],
        "tags": ["Windows","NVIDIA","CS2","Steam"],
        "url": "/tutorial/cs2-optimization-guide/",
        "teaser": "/assets/images/logo-teaser.png"
      },{
        "title": "深入理解逻辑与英语中的 “让步” (Concession)",
        "excerpt":"什么是 “让步” 的逻辑内核？ 在正常的线性逻辑中，我们通常认为： 原因 A $\\rightarrow$ 导致结果 B 例如：因为下雨了（A），所以我没出门（B）。$\\leftarrow$ 顺理成章。 但是，世界是复杂的。有时候，原因 A 发生了，它预期的结果 B 缺没有发生，反而发生了相反的结果 C。 事实 A（本来应该阻碍 C）$\\rightarrow$ 依然发生了结果 C。 例如：虽然下雨了（A），但我还是出门了（C）。 这就是 “让步” 的本质： 承认一个不利于你结论的事实（这就是 “让”，退一步），然后转折，通过强调你的结论依旧成立，来反衬结论的强大（这就是 “步”，进两步）。 想象一个弹簧：你把它压下去（让步），是为了让它弹得更高（主句）。 为什么英语中如此强调 “让步”？ 在英语学习中经常看到 “让步状语从句”（Adverbial Clause of Concession），是因为英语非常注重逻辑连接词（Connectives）。 在中文里，我们往往靠语境来表达：“下雨了，我还是去了。”（没有关联词，你也懂）。但在英语里，必须用逻辑连接词把这个逻辑关系标出来。 常见的表达 “让步” 的逻辑连接词 英语里的 Although, Though, Even if, Despite, In spite of...","categories": ["Note"],
        "tags": ["English"],
        "url": "/note/understanding-logic-of-concession/",
        "teaser": "/assets/images/logo-teaser.png"
      },{
        "title": "英语翻译技巧",
        "excerpt":"在备考 CET-6 或雅思写作时，许多同学面临的最大障碍不是词汇量，而是思维模式（Mindset）。中英文在底层逻辑上存在巨大的鸿沟：中文重意合、动态、叙事；英文重形合、静态、结构。 本文将拆解中英翻译的核心差异，并提供一套可操作的翻译三步法。 一、 核心思维差异（Core Divergences） 1. 动态 vs. 静态（Nominalization） 法则： 汉语多用动词（Verb-heavy）；学术英语多用名词（Noun-heavy）。 在翻译时，要学会名词化（Nominalization）：将中文的动作或性质抽象为英语的名词短语。这能显著提升句子的“信息密度”。 原文：这就解释了为什么我们需要从不同角度看问题。 ❌ Chinglish: This explains why we need to see the problem from different angles. (动词堆砌) ✅ Academic: This is an illustration of the need for a different perspective on the issue. (名词主导) 2. 主动 vs....","categories": ["Note"],
        "tags": ["English"],
        "url": "/note/english-translation-techniques/",
        "teaser": "/assets/images/logo-teaser.png"
      },{
        "title": "Windows 包管理神器 Scoop：从入门到自定义安装配置",
        "excerpt":"如果你习惯了 Linux 下 apt、pacman 或 macOS 下 brew 的爽快体验，那么回到 Windows 面对满屏的安装包和 “下一步” 肯定会感到繁琐。 Scoop 是 Windows 下的一款轻量级包管理工具。与 Chocolatey 或 Winget 不同，Scoop 的设计哲学是 “非侵入式”： 权限洁癖：默认安装在用户目录，无需 UAC 提权（除非安装全局软件）。 绿色环保：自动处理环境变量（Shim 机制），卸载时瞬间清除，不残留注册表垃圾。 版本控制：利用 Git 管理软件仓库（Bucket），方便版本回退。 本文将带你从零开始配置一个完美的 Scoop 环境。 1. 调整 Scoop 安装位置 Scoop 默认将软件安装在 C 盘。作为开发者，我们通常希望将工具链与系统盘分离。在运行安装脚本前，我们需要先设置环境变量。 还没有安装 Scoop（推荐） 打开 PowerShell（无需管理员权限），依次执行以下命令。假设我们要安装到 D:\\Users\\abc\\scoop（请根据你的实际情况修改路径）。 第一步：设置用户安装目录 这是普通软件（Chrome, VSCode...","categories": ["Tutorial"],
        "tags": ["Windows","Scoop","Efficiency"],
        "url": "/tutorial/windows-scoop-package-manager-guide/",
        "teaser": "/assets/images/logo-teaser.png"
      },{
        "title": "C++ 中的 string",
        "excerpt":"std::string 是 C++ Standard Library 提供的标准类之一，这也是 C++ 开发中最常用的类之一，它本质上是对 C 风格字符串（char*）的封装，提供了自动内存管理和丰富的操作接口。 核心概念 std::string 位于 &lt;string&gt; 头文件中，本质上是对 std::basic_string&lt;char&gt; 的特化版本。 头文件：#include &lt;string&gt; 命名空间：std 特点：动态管理内存，自动处理扩容，兼容 C 风格字符串。 初始化与构造 #include &lt;string&gt; #include &lt;vector&gt; std::string s1; // 默认构造，空字符串 \"\" std::string s2 = \"Hello, World\"; // 拷贝初始化 std::string s3(\"Hello, World\"); // 直接初始化 std::string s4(5, 'A'); // 生成...","categories": ["Note"],
        "tags": ["C++"],
        "url": "/note/string-in-cpp/",
        "teaser": "/assets/images/logo-teaser.png"
      },{
        "title": "C++ 中的 vector",
        "excerpt":"std::vector 是 C++ 中最重要、最常用的容器，没有之一。它的本质是动态数组（Dynamic Array）。 std::vector 是在堆（Heap）上管理一块连续的内存，可以存放任意类型的对象。 核心特性与底层原理 头文件：#include &lt;vector&gt; 内存模型：连续内存。这意味着它和 C 数组一样，支持通过指针偏移量快速访问，并且对 CPU 缓存（Cache）非常友好。 自动扩容：当存入数据量超过当前容量时，std::vector 就会申请一块更大的内存（通常是原来的 1.5 倍或 2 倍），将旧数据移动/拷贝过去，然后释放旧内存。 初始化与构造 #include &lt;vector&gt; // 1. 默认构造（空 vector） std::vector&lt;int&gt; v1; // 2. 指定大小和默认值 std::vector&lt;int&gt; v2(10); // 10 个元素，默认初始化 0 std::vector&lt;int&gt; v3(10, 5); // 10 个元素，每个都是 5 // 3. 列表初始化（C++11） std::vector&lt;int&gt;...","categories": ["Note"],
        "tags": ["C++"],
        "url": "/note/vector-in-cpp/",
        "teaser": "/assets/images/logo-teaser.png"
      },{
        "title": "C++ 中的构造函数",
        "excerpt":"对于 C++ 对象而言，我们认为：对象 = 内存 + 语义（不变量）。 内存：仅仅是电子与硅晶体中状态未知的比特位。 语义：这段内存代表什么含义（是 int、是 char 还是 float），以及它必须满足的条件（“不变量”，Invariant）。 构造函数（Constructor）的本质就是将 “原始、混沌” 的内存强制转换为 “持有特定语义的、合法的对象” 的原子操作过程。 核心逻辑 在 C 语言中，创建一个 struct 通常分为两步： 分配内存（malloc 或栈上声明） 赋值（init 函数或手动赋值） 问题在于：如果在第 1 步和第 2 步之间使用该对象，就会导致灾难（未定义行为）。或者，如果使用者忘记了第 2 步，系统就会处于 “非法状态”。 C++ 引入构造函数就是为了保证： 如果一个对象存在，那么它一定是合法的。 构造函数保证了初始化（Initialization）与定义（Defination）的不可分割性。 构造函数的执行流 当你写下 T object(args); 时，编译器实际执行了以下步骤： 分配内存：在栈或堆上找到一块足够容纳 sizeof(T) 的空间。此时，内存里的数据是随机的（Garbage）。 执行初始化列表（Initialization List）：这是真正的初始化时刻。...","categories": ["Note"],
        "tags": ["C++"],
        "url": "/note/constructor-in-cpp/",
        "teaser": "/assets/images/logo-teaser.png"
      },{
        "title": "C++ 中的 list",
        "excerpt":"在现代 C++ 开发中，虽然 std::vector 足以应付绝大多数的场景，但是在某些特定场景下，std::list 依旧是不可替代的神器。 核心概念与底层原理 头文件：#include &lt;list&gt; 本质：双向链表（Doubly Linked List） 内存模型：非连续内存。每个元素（节点）都是独立分配在堆上的，节点之间通过指针（prev 和 next）连接 特点： 不支持随机访问：不能使用下标 l[5] 访问元素，必须从头一个一个遍历过去 插入 / 删除极快：只要持有了某个位置的迭代器，在该位置插入或删除元素的操作是 $O(1)$ 的，且不需要移动其他元素 初始化与构造 用法与 std::vector 非常相似： #include &lt;list&gt; std::list&lt;int&gt; l1; // 空链表 std::list&lt;int&gt; l2 = {1, 2, 3}; // 列表初始化 std::list&lt;int&gt; l3(l2); // 拷贝构造 std::list&lt;int&gt; l4(5, 100); //...","categories": ["Note"],
        "tags": ["C++"],
        "url": "/note/list-in-cpp/",
        "teaser": "/assets/images/logo-teaser.png"
      },{
        "title": "C++ 中的初始化列表和列表初始化",
        "excerpt":"很多初学者容易混淆初始化列表（Member Initializer List）和列表初始化（List Initialization），因为它们的名字很像，但它们实际上解决的是完全不同的问题： 初始化列表：解决的是对象生命周期与内存模型的问题（“什么时候赋初值”） 列表初始化：解决的是类型系统的统一性与安全性的问题（“用什么语法赋初值”） 初始化列表（Member Initializer List） 它的形式出现在构造函数参数列表之后，函数体大括号之前，以 : 开头。 class A { int x; public: A(int val) : x(val) {} // 初始化列表 }; 初始化 vs. 赋值 在 C++ 的对象模型中，“初始化”（Initialization）和 “赋值”（Assignment）是两个截然不同的物理过程。 内存分配（Allocation）：在栈上或堆上划出一块内存 初始化（Initialization）：在这块内存上构建对象，使其成为一个合法的实例 赋值（Assignment）：对象已经存在了，擦出旧值，填入新值。 构造函数的执行时间线： 进入构造函数之前：编译器必须确保所有成员变量都已经 “出生”（初始化完成） 进入构造函数体（{...}）：这已经是 “出生后” 的世界了，这里面写的代码都是 “赋值” 操作。 为什么要用初始化列表？ 如果你不用初始化列表，而是写在函数体内： class Person { std::string...","categories": ["Note"],
        "tags": ["C++"],
        "url": "/note/initialization-in-cpp/",
        "teaser": "/assets/images/logo-teaser.png"
      },{
        "title": "操作系统中的进程",
        "excerpt":"在计算机科学的教科书中，关于进程（Process）的定义往往只有冷冰冰的一句话： 进程是程序的一次执行过程。 这句话虽然准确，但它掩盖了太多细节。对于初学者而言，这更像是一个黑盒。为什么要有进程？为什么不能直接操作物理地址？所谓的上下文切换到底切换了什么？ 要真正理解进程，我们不能只看定义，而必须回到计算机发展的历史，从本质出发，看看是怎样的资源瓶颈和物理限制，逼迫工程师们发明了进程这个概念。 0. 起点：硬件即程序 时间背景 代表 1940s - 1950s 初 ENIAC 在进程这个概念诞生之前，计算机的世界是纯粹且静止的。如果非要为这个 “史前时代” 选一个代表，那非 ENIAC（Electroinc Numeric Numerical Integrator and Computer，电子数值计算机）莫属。在这个阶段，软件和硬件之间并没有明显界限，甚至可以说，根本没有现代意义上的“软件”。 想象一下，你面对的是一个占地 167 平方米、重达 27 吨的庞然大物。这就是 ENIAC，它是那个时代算力的巅峰，但对于 “任务管理” 而言，它确实最原始的形态：它没有任何中间层来管理资源；同一时间，这台巨兽只能为解决一个问题而存在。 早期的编程：Glen Beck 与 Betty Snyder 正在对 ENIAC 进行硬连线 在 ENIAC 上 “切换任务” 并不是像今天一样双击一个图标一样简单。那是一场体力劳动。当时的 “编程”，实际上就是 “接线”。 程序员（通常是女性数学家）需要拿着粗大的连接线（Patch Cables），在巨大的配线板上进行物理连接。每一个插孔的连接，每一排开关的拨动，都代表着指令的逻辑流向。当你把线插好，这台机器就变成了解决那个特定方程的专用电路。 操作员正在手动更改 ENIAC 的线路配置...","categories": ["Note"],
        "tags": ["OS"],
        "url": "/note/process-in-os/",
        "teaser": "/assets/images/logo-teaser.png"
      },{
    "title": "Page Not Found",
    "excerpt":"Sorry, but the page you were trying to view does not exist.  ","url": "https://bfmhno3.github.io/404.html"
  },{
    "title": "About",
    "excerpt":"Tempor velit sint sunt ipsum tempor enim ad qui ullamco. Est dolore anim ad velit duis dolore minim sunt aliquip amet commodo labore. Ut eu pariatur aute ea aute excepteur laborum. Esse ea esse excepteur minim mollit qui cillum excepteur ex dolore magna. Labore deserunt fugiat incididunt incididunt sint ea....","url": "https://bfmhno3.github.io/about/"
  },{
    "title": "Posts by Category",
    "excerpt":" ","url": "https://bfmhno3.github.io/categories/"
  },{
    "title": "Musings: Echoes of the Heart",
    "excerpt":" ","url": "https://bfmhno3.github.io/categories/musings/"
  },{
    "title": "Notes: Fragments of Knowing",
    "excerpt":" ","url": "https://bfmhno3.github.io/categories/notes/"
  },{
    "title": "Tutorials: The Path Unfolded",
    "excerpt":" ","url": "https://bfmhno3.github.io/categories/tutorials/"
  },{
    "title": "Posts by Tag",
    "excerpt":" ","url": "https://bfmhno3.github.io/tags/"
  },{
    "title": "Posts by Year",
    "excerpt":" ","url": "https://bfmhno3.github.io/posts/"
  },{
    "title": "C",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/c/"
  },{
    "title": "VMware Workstation",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/vmware-workstation/"
  },{
    "title": "Visual Studio",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/visual-studio/"
  },{
    "title": "CMake",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/cmake/"
  },{
    "title": "Docker",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/docker/"
  },{
    "title": "Overleaf",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/overleaf/"
  },{
    "title": "Git Bash",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/git-bash/"
  },{
    "title": "Windows",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/windows/"
  },{
    "title": "XiaoMi",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/xiaomi/"
  },{
    "title": "RedMi",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/redmi/"
  },{
    "title": "HyperOS",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/hyperos/"
  },{
    "title": "MIUI",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/miui/"
  },{
    "title": "Android",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/android/"
  },{
    "title": "ADB",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/adb/"
  },{
    "title": "NVIDIA",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/nvidia/"
  },{
    "title": "CS2",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/cs2/"
  },{
    "title": "Steam",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/steam/"
  },{
    "title": "English",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/english/"
  },{
    "title": "Scoop",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/scoop/"
  },{
    "title": "Efficiency",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/efficiency/"
  },{
    "title": "C++",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/c/"
  },{
    "title": "OS",
    "excerpt":"","url": "https://bfmhno3.github.io/tag/os/"
  },{
    "title": "Note",
    "excerpt":"","url": "https://bfmhno3.github.io/category/note/"
  },{
    "title": "Tutorial",
    "excerpt":"","url": "https://bfmhno3.github.io/category/tutorial/"
  },{
    "title": "Better Mistakes",
    "excerpt":"","url": "https://bfmhno3.github.io/index.html"
  },{
    "title": "Better Mistakes - page 2",
    "excerpt":"","url": "https://bfmhno3.github.io/page/2/index.html"
  },{
    "title": "Better Mistakes - page 3",
    "excerpt":"","url": "https://bfmhno3.github.io/page/3/index.html"
  },{
    "title": "Better Mistakes - page 4",
    "excerpt":"","url": "https://bfmhno3.github.io/page/4/index.html"
  }]
