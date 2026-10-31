# Agent Instructions: `bfmhno3.github.io`

Astro static site using the CuteLeaf/Firefly theme.

## Project Overview

- `.agents/skills/`: AI skill definitions. Not part of the site build.
- `.github/`: Issue templates and GitHub Actions workflows (checks, build, deploy).
- `docs/`: Documentation and the images README files reference.
- `public/`: Static assets copied to the site root without Astro processing: `assets/` (css, fonts, images, js, music), `favicon/`, `gallery/`, `pio/` (Live2D widget).
- `scripts/`: Build and content-maintenance scripts (card data, LQIPs, VNDB covers, font subsets, search index, new-post).
- `src/`: Site source.
  - `assets/images/`: Images imported by source code and processed by Vite.
  - `components/`: Astro and Svelte components, grouped as `analytics`, `comment`, `common`, `controls`, `features`, `layout`, `misc`, `pages`, `widget`.
  - `config/`: Site and theme configuration.
  - `constants/`: Runtime constants and build-generated data.
  - `content/`: Content Collections: `posts/` (blog), `dynamic/` (short-form), `spec/` (About, portfolio).
  - `i18n/`: Translation keys and loader; `languages/` holds the texts.
  - `layouts/`: Page layouts and HTML shells.
  - `pages/`: File-based routes; paths determine public URLs. Includes `api/`, `categories/`, `dynamic/`, `gallery/`, `og/`, `posts/`, `tags/`.
  - `plugins/`: Remark and Rehype plugins; `utils/` is shared by them.
  - `styles/`: Global and feature-specific CSS/Stylus.
  - `types/`: TypeScript types. Keep aligned with `src/config`.
  - `utils/`: Shared business logic (dates, URLs, navigation, images, layouts, content).
  - `workers/`: Web Worker sources.

## Build and Test Commands

Use the Nix environment by default. If Nix is unavailable, try Docker (Astro on port 4321), then Podman (rootful mode only).

```bash
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1
pnpm check && pnpm type-check && pnpm build

docker compose build && docker compose up -d
docker compose logs --tail=100 astro
docker compose down
```

Other scripts:

- `pnpm preview`: Preview the built site.
- `pnpm format`: Format `./src` and `./scripts` with Biome.
- `pnpm lint`: Run `biome check --write` on `./src` and `./scripts`.
- `pnpm lqips`, `pnpm github-cards`: Regenerate `src/constants/lqips.json` and GitHub card data.
- `pnpm new-post <filename>`, `pnpm new-d <content>` (alias `pnpm new-dynamic`): Create a post or a dynamic entry with correct Front Matter.
- `pnpm astro ...`: Run Astro CLI commands.

There is no unit-test framework. Before submitting rendering, content, or generated-asset changes, run `pnpm check`, `pnpm type-check`, and `pnpm build`. For visual or interactive changes, verify with `pnpm dev` or `pnpm preview` and include screenshots in the PR.

### Update the Firefly theme

```bash
git remote add upstream https://github.com/CuteLeaf/Firefly.git  # once
git fetch upstream
git merge upstream/master
```

Resolve conflicts manually (mostly in customized config files) and commit with `merge: update Firefly theme`. Limit site-specific changes to `src/config/` and `src/content/` to reduce future conflicts. After merging, run `pnpm install`, review upstream commits for new or changed config fields, then run `pnpm check`, `pnpm type-check`, `pnpm dev`, and `pnpm build`.

## Code Style Guidelines

### JS and TS

- Biome formats and lints. Tabs for indentation, double quotes for strings.
- Components (`.astro`, `.svelte`) are `PascalCase`. Config modules are `camelCase` ending in `Config.ts`. Utilities are kebab-case, for example `date-utils.ts`.
- Avoid unrelated formatting churn.

### Markdown

GitHub Flavored Markdown.

#### Front Matter

The schema is in `src/content.config.ts`.

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | `string` | Yes | Post title. |
| `commentId` | `string` | Yes | Permanent Giscus discussion ID, normally `post:<initial-slug>`. Generate at creation and never change it, even when renaming the file, slug, route, title, or theme. |
| `published` | `date` | Yes | `pnpm new-post` writes `YYYY-MM-DD`; existing posts use `"YYYY-MM-DD HH:mm:ss +08:00"`. |
| `updated` | `date` | No | Defaults to `published`. Write an unquoted YAML date (`updated: 2026-09-30`); quoted strings are not coerced. |
| `description` | `string` | No | Summary on the post card. |
| `image` | `string` | No | Cover image path. |
| `tags` | `string[]` | No | Post tags. |
| `category` | `string` | No | Existing values: `Note`, `Tutorial`. |
| `draft` | `boolean` | No | Drafts are hidden from readers. |
| `pinned` | `boolean` | No | Pin to the top of the post list. |
| `slug` | `string` | No | Custom URL path. |
| `lang` | `string` | No | Language code such as `zh-CN`. Set only when it differs from the site default. |
| `author`, `licenseName`, `licenseUrl`, `sourceLink` | `string` | No | Per-post overrides and source URL. |
| `comment` | `boolean` | No | Defaults to `true`. |
| `password`, `passwordHint` | `string` | No | Encrypts the post; the hint is shown above the password input. |
| `series`, `seriesOrder` | `string`, `number` | No | Series name (identical in every part) and position within it. |

`prevTitle`, `prevSlug`, `nextTitle`, and `nextSlug` are computed in `src/utils/content-utils.ts`. Do not set them.

#### Formatting Guardrails

- Unordered lists use `-` only. Never `*` or `+`.
- Insert one space between Chinese and English or numeric characters.
- Punctuation follows the language of the text it belongs to:
  - Chinese sentences use full-width punctuation: `，。：；？！、`, `……`, and `（）` when the parenthesized text contains Chinese.
  - English phrases, code, and number runs use half-width punctuation, for example `std::move(x)`, `(see RFC 2119)`, `3.14`. Use `...` for ellipses there.
  - Quotes in Chinese text use curly quotes `“”` (and `‘’` for nested quotes), including quoted English terms. Straight `"` and `'` are only for code and for whole English sentences.
  - Do not use em dashes (`—`) or Chinese dashes (`——`). Rewrite with a comma, colon, or parentheses.
  - Book and article titles may use `《》`.
  - Existing posts that still use straight quotes are migrated in a separate change. When editing a post, do not mix both styles inside one paragraph.
- Inline math: `$f(x)$`. Block math: `$$` on separate lines.
- Diagrams: fenced `mermaid` blocks.
- Admonitions: GitHub Alert syntax, for example `> [!NOTE] Note`. Types: `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`.
- GitHub repository card: `::github{repo="CuteLeaf/Firefly"}`.
- Spoiler: `:spoiler[hidden **text**]`.
- Videos: paste the platform's iframe embed code. Use `width="100%" height="468"`; for BiliBili use `//player.bilibili.com/player.html?bvid=BV_ID&p=1&autoplay=0`.
- File names: blog files and their images are English, words separated by `-`. Blog files use `.md`, never `.mdx`.

### Writing Technical Posts

- Follow the voice and structure in [`.agents/skills/andrej-karpathy/SKILL.md`](.agents/skills/andrej-karpathy/SKILL.md); read it before drafting. This file wins on conflict.
- When dispatching a subagent to write a post, make it read that SKILL in the task prompt.
- Start from a runnable experiment or a concrete problem. The `description` states what was done and with which versions (for example "我用 Linux 6.18 写了一个双文件外部模块"), not a topic overview.
- Record the environment: OS, tool and compiler versions, flags, hardware when relevant.
- Back every behavioral claim with a command and its real output. Remove or flag unverified claims.
- Write in the first person ("我"). Do not use "笔者" or "小编".
- Explain the mechanism and the reason, not only the API.
- For AI-assisted drafts, run every code block and re-check every version number and fact before publishing.

### Code in Posts

Every code block under `src/content/posts/` follows the rules in [`docs/code-style.md`](docs/code-style.md): C uses the Linux kernel style, C++ the Google C++ Style Guide, Python PEP 8, and Rust `rustfmt` defaults. Read it before writing or editing code in a post.

### Git Commits

- Atomic commits: one logical change each.
- Conventional Commits, for example `feat(posts): add new freeRTOS tutorial post`, `fix(styles): repair notice box margin misalignment`.

## Querying Markdown with mq

`mq` is a jq-like query language for Markdown. Query first, then read only the matching lines; never dump whole files or several posts at once.

- Skills: [`.agents/skills/processing-markdown/SKILL.md`](.agents/skills/processing-markdown/SKILL.md) with its `EXAMPLES.md` for selectors and flags, [`.agents/skills/web-scraping/SKILL.md`](.agents/skills/web-scraping/SKILL.md) for fetching pages.
- Start broad, then narrow:
  - `mq '.h | to_text()' file.md`: outline; `mq '.yaml | to_text()' file.md`: front matter.
  - `mq -A 'section::section("标题") | section::bodies() | first()' file.md`: one section body.
  - `mq '.code("bash") | .code.value' file.md`, `mq '.link.url' file.md`: code and links.
  - `mq -F grep --context 2 'select(contains("关键字"))' file.md`: grep-style search.
  - `mq '.h | to_text()' src/content/posts/*.md`: multiple files in one call, no shell loop.
- Delegate broad surveys to a subagent instead of bulk-reading posts.
- Need line offsets? Do not re-grep headings; mq nodes carry positions (`.line`, `.end_line`, `get_location()`):
  - `mq '.h | [to_text(self), get_location(self)]' file.md`: heading plus start/end line.
  - `mq -F json '.h' file.md | jq -r '.[] | "\(.values[0].value)\t\(.position.start.line)"'`: heading-to-line table.
- Prefer structured output over raw text: `-F json` plus `jq`/`yq` to project only needed fields, and `mq` selectors to narrow before reading. Never dump Markdown just to count, locate, or search it.
- `-I html` converts to Markdown first; use Markdown selectors (`.h`, `.text`, `.link`), not HTML tags.
- No `-U` on `src/content/**` (mq re-serializes formatting); use `edit` instead. Full flags: `mq --help`; per function: `mq help <name>`.

## Security

- Do not commit secrets, tokens, or service keys.
- Keep deployment-specific settings in the target platform environment.
- Review generated files such as `dist`, `src/constants/lqips.json`, and `src/constants/icons.ts` before committing.

## Additional Notes

- Read existing files before writing. Do not re-read unless changed.
- Do not read whole files over 100KB (many posts exceed this). Query outlines, front matter, or sections with `mq` first (see [Querying Markdown with mq](#querying-markdown-with-mq)), then read only the matching line ranges. Never dump several posts at once.
- Thorough in reasoning, concise in output. No sycophantic openers or closing fluff.
- No emojis or em-dashes.
- Do not guess APIs, versions, flags, commit SHAs, or package names. Verify by reading code or docs.
