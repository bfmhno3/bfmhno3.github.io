import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const MAX_URLS_PER_BATCH = 10_000;
const KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

export type ChangedFile = {
	status: string;
	paths: string[];
};

function siteUrl(value: string): URL {
	const parsed = new URL(value);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("INDEXNOW_SITE must be an HTTP(S) URL");
	}
	return new URL(`${parsed.origin}/`);
}

export function postUrl(path: string): string | undefined {
	if (
		!/^src\/content\/posts\/(?!_quarantine(?:\/|$)).+\.(?:md|mdx)$/i.test(path)
	) {
		return undefined;
	}
	const slug = path
		.slice("src/content/posts/".length)
		.replace(/\.(?:md|mdx)$/i, "");
	return `/posts/${encodeURI(slug)}/`;
}
export function dynamicChanged(path: string): boolean {
	return /^src\/content\/dynamic\/.+\.md$/i.test(path);
}

export function parseNameStatus(output: string): ChangedFile[] {
	const fields = output.split("\0").filter(Boolean);
	const result: ChangedFile[] = [];
	for (let index = 0; index < fields.length; ) {
		const status = fields[index++] ?? "";
		if (status.startsWith("R") || status.startsWith("C")) {
			const oldPath = fields[index++];
			const newPath = fields[index++];
			if (oldPath && newPath)
				result.push({ status, paths: [oldPath, newPath] });
		} else {
			const path = fields[index++];
			if (path) result.push({ status, paths: [path] });
		}
	}
	return result;
}

export function sitemapUrls(xml: string, site: URL): string[] {
	const urls: string[] = [];
	for (const match of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
		try {
			const candidate = new URL(match[1]);
			if (
				candidate.host === site.host &&
				candidate.protocol === site.protocol
			) {
				urls.push(candidate.href);
			}
		} catch {
			// Ignore malformed sitemap entries.
		}
	}
	return [...new Set(urls)];
}

function toAbsolute(path: string, site: URL): string {
	return new URL(path, site).href;
}

async function changedFiles(
	baseSha: string | undefined,
	head: string,
): Promise<ChangedFile[] | undefined> {
	let diffBase = baseSha && !/^0+$/.test(baseSha) ? baseSha : undefined;
	if (!diffBase) {
		try {
			const previous = await execFileAsync("git", ["rev-parse", `${head}^`]);
			diffBase = previous.stdout.trim();
		} catch {
			return undefined;
		}
	}
	const diff = await execFileAsync("git", [
		"diff",
		"--name-status",
		"-z",
		diffBase,
		head,
	]);
	return parseNameStatus(diff.stdout);
}

export async function submit(
	urls: string[],
	key: string,
	site: URL,
): Promise<void> {
	const keyLocation = new URL(`${key}.txt`, site).href;
	const urlList = [...new Set(urls)];
	console.log(
		`IndexNow: submitting ${urlList.length} URL(s) in ${Math.ceil(urlList.length / MAX_URLS_PER_BATCH)} batch(es)`,
	);
	for (let offset = 0; offset < urlList.length; offset += MAX_URLS_PER_BATCH) {
		const batch = urlList.slice(offset, offset + MAX_URLS_PER_BATCH);
		const response = await fetch(INDEXNOW_ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify({
				host: site.host,
				key,
				keyLocation,
				urlList: batch,
			}),
		});
		console.log(
			`IndexNow: batch ${Math.floor(offset / MAX_URLS_PER_BATCH) + 1} HTTP ${response.status}`,
		);
		if (response.status !== 200 && response.status !== 202) {
			const retryAfter = response.headers.get("retry-after");
			const summary = (await response.text())
				.slice(0, 300)
				.replace(/\s+/g, " ");
			throw new Error(
				`IndexNow HTTP ${response.status}${retryAfter ? ` (Retry-After: ${retryAfter})` : ""}: ${summary}`,
			);
		}
	}
}

export async function main(): Promise<void> {
	const key = process.env.INDEXNOW_KEY;
	if (!key || !KEY_PATTERN.test(key))
		throw new Error("INDEXNOW_KEY is missing or invalid");
	const site = siteUrl(
		process.env.INDEXNOW_SITE ?? "https://bfmhno3.github.io",
	);
	const head = process.env.INDEXNOW_HEAD_SHA ?? "HEAD";
	const xml = await readFile("dist/sitemap-0.xml", "utf8");
	const currentUrls = sitemapUrls(xml, site);
	const files = await changedFiles(process.env.INDEXNOW_BASE_SHA, head);
	if (files?.length === 0) {
		console.log("IndexNow: no changed files; nothing to submit");
		return;
	}
	const urls = files === undefined ? [...currentUrls] : [];
	let globalChange =
		files?.some(({ paths }) =>
			paths.some((path) =>
				/^(src\/(config|pages|layouts|components|plugins|styles)\/|astro\.config\.mjs$)/.test(
					path,
				),
			),
		) ?? false;
	const changedPosts = new Set<string>();
	for (const file of files ?? []) {
		for (const path of file.paths) {
			const post = postUrl(path);
			if (post) changedPosts.add(post);
		}
	}
	if (globalChange) urls.push(...currentUrls);
	for (const post of changedPosts) urls.push(toAbsolute(post, site));
	if (changedPosts.size > 0) {
		for (const absolute of currentUrls) {
			const pathname = new URL(absolute).pathname;
			if (pathname === "/archive/" || /^\/\d+\/$/.test(pathname))
				urls.push(absolute);
		}
		for (const path of ["/", "/sitemap-index.xml"]) {
			urls.push(new URL(path, site).href);
		}
	}
	if (files?.some(({ paths }) => paths.some(dynamicChanged))) {
		const dynamic = toAbsolute("/dynamic/", site);
		if (currentUrls.includes(dynamic)) urls.push(dynamic);
	}
	const filtered = [...new Set(urls)].filter(
		(value) => new URL(value).host === site.host,
	);
	if (filtered.length === 0) {
		console.log("IndexNow: no URLs to submit");
		return;
	}
	await submit(filtered, key, site);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
