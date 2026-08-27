import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";

const posts = (await readdir("src/content/posts")).filter((name) =>
	name.endsWith(".md"),
);
if (posts.length !== 27)
	throw new Error(`expected 27 posts, found ${posts.length}`);
for (const name of posts) {
	if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(name))
		throw new Error(`invalid post filename: ${name}`);
	const source = await readFile(`src/content/posts/${name}`, "utf8");
	const match = source.match(/^---\n([\s\S]*?)\n---\n/);
	if (
		!match ||
		!/^title:\s*.+$/m.test(match[1]) ||
		!/^published:\s*.+$/m.test(match[1])
	) {
		throw new Error(`invalid Astro front matter: ${name}`);
	}
}
console.log(`validated ${posts.length} Astro posts`);
