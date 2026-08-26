# Agent Instructions: `bfmhno3.github.io`

## Architecture

This site is an Astro static site using the CuteLeaf/Firefly theme, pinned to upstream commit `4f40eaf35d754fe4988a5293b5e2eee4755b88a8`. Site configuration is in `src/config/`; posts are in `src/content/posts/`; fixed content is in `src/content/spec/`; routes are in `src/pages/`; reusable assets are in `public/assets/`.

Posts use Firefly front matter (`title`, `published`, `description`, `category`, `tags`). Publication instants retain the original `+08:00` values. Article bodies are immutable during migration: do not rewrite Markdown, HTML, code, Mermaid, math, image links, Liquid text, or Kramdown attributes. The validator requires 27 dated post files.

Callouts use only Firefly's `rehypeCallouts.theme: "github"`. Do not convert legacy notice attributes or enable another callout dialect. Firefly's figure renderer handles retained legacy figure include syntax at render time.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1
pnpm check
pnpm build
```

The Nix flake provides Node 24, pnpm, and native image-build dependencies. Docker development runs Astro on port 4321:

```bash
docker compose build
docker compose up -d
docker compose logs --tail=100 astro
docker compose down
```

Podman users must use rootful mode.

## Content and deployment

Preserved public routes include `/`, `/posts/`, `/page/:num/`, `/categories/`, `/tags/`, `/portfolio/`, `/about/`, legacy category/post URLs, and date archives. GitHub Pages builds `dist/` through `.github/workflows/build-astro.yml`.

Keep asset references synchronized when changing asset names. Do not modify generated `dist/` by hand.
