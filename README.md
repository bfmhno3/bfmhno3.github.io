# Better Mistakes

`Better Mistakes` 是 `bfmhno3` 的个人技术博客，基于 Astro 和 [CuteLeaf/Firefly](https://github.com/CuteLeaf/Firefly) 主题构建。站点副标题是 `Trial.Error.Iteration.`，访问地址为 <https://bfmhno3.github.io>。这里主要记录 Linux、C++、操作系统、计算机体系结构和数学相关的学习、实践与思考。

## 主要功能

- 文章归档、分类、标签、全文搜索（Pagefind）和 RSS。
- 动态、友链、留言板、相册（包括加密相册）、书签导航、Bilibili 追番和打赏页面。
- 使用 Giscus 提供基于 GitHub Discussions 的评论。
- 响应式布局、明暗模式切换和可选的布局设置。
- 增强的代码高亮、KaTeX 数学公式、Mermaid 和 PlantUML 图表、图片优化。
- 音乐播放器，以及可选的 Live2D/Spine 看板娘。

Bangumi、VNDB 和 MyAnimeList 页面当前均为关闭状态，不属于当前上线功能。

## 目录入口

```text
src/config/              # 站点和功能配置
src/content/posts/       # 27 篇文章
src/content/spec/        # About、友链、留言板等固定页面
src/components/          # Astro/Svelte 组件
src/pages/               # Astro 页面路由
public/                  # 原样发布的静态资源
scripts/                 # 内容、卡片、图片和构建辅助脚本
.github/workflows/       # CI 和 GitHub Pages 部署工作流
flake.nix                # Nix 开发环境
docker-compose.yaml      # Docker 开发服务
```

个人站点内容主要维护在 `src/config/` 和 `src/content/` 中。配置统一入口是 `src/config/index.ts`。

## 技术栈与运行要求

- Astro `7.2.3`
- Svelte `5.56.8`
- Tailwind CSS `4.3.3`
- Node.js `>=22.23.0`
- pnpm `11.22.0`

`flake.nix` 提供 Node.js 24 和 pnpm 开发环境，也可以使用 Docker。

## 本地开发

在仓库根目录执行。使用 Nix/direnv 时先运行 `direnv allow`：

```bash
direnv allow
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1
```

开发服务器地址：<http://127.0.0.1:4321>。

```bash
pnpm check       # Astro 检查
pnpm type-check  # TypeScript 类型检查
pnpm build       # 生成生产构建
pnpm preview     # 预览构建产物
```

内容维护脚本：

```bash
pnpm new-post <filename>
pnpm new-dynamic <content>
```

## Docker 开发

```bash
docker compose build
docker compose up -d
```

启动后访问 <http://127.0.0.1:4321>，停止服务：

```bash
docker compose down
```

Podman 用户必须使用 rootful mode。

## 部署到 GitHub Pages

`.github/workflows/deploy.yml` 在推送到 `main` 分支时自动运行，也可以在 GitHub Actions 中手动触发 `Deploy to Pages Branch` 工作流。工作流使用 Node.js 24 和 pnpm `11.22.0`，执行 `pnpm install --frozen-lockfile` 与 `pnpm run build`，生成 `dist/`，然后发布到 `pages` 分支。

`.github/workflows/build.yml` 会在 Pull Request 或推送到 `main` 时运行 Astro check/build 矩阵；其 Node.js 版本矩阵为 22 和 23，不将该矩阵理解为与 `package.json` 的 engines 完全一致。

## 更新 Firefly 主题

更新前先同步 upstream，再将主题代码与个人配置分开处理：

1. 配置更新前运行 `git fetch upstream --prune`，并对照 `upstream/master`。
2. 更新主题组件、布局、样式、工具、页面、插件、依赖和 schema。
3. 按当前 upstream 结构重新应用个人配置，不要整体覆盖 `src/config/`。
4. 保留 `src/content/`、`public/assets/` 以及部署、Nix、Docker 文件。
5. 更新后按仓库流程运行 `pnpm install --frozen-lockfile`、`pnpm check` 和 `pnpm build`。

README 只保留主题维护提示，不展开完整的 Firefly 配置字段手册。

## 许可证与联系

- 文章采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可证。
- 主题遵循 [Firefly 上游许可证](https://github.com/CuteLeaf/Firefly) 的规定。
- 作者主页：<https://github.com/bfmhno3>
- 本站源码：<https://github.com/bfmhno3/bfmhno3.github.io>
