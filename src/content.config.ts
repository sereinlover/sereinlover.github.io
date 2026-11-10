import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { defineCollection } from 'astro:content';
import { glob, type Loader } from 'astro/loaders';
import { z } from 'astro/zod';
import { obsidianImageSignature } from './plugins/remark-obsidian-image.mjs';

// 从 Obsidian 原样复制过来、没有 frontmatter 的文章，在这里补日期和标签。
// key 是文件相对 src/content/blog/ 的路径，不含扩展名，如 '音乐美学计算平台/01_第 1 章 绪论'。
// title 可选，不填时取正文第一个 `# ` 标题。
const rawPosts: Record<
	string,
	{ title?: string; pubDate: string; tags?: string[]; categories?: string[] }
> = {
	'音乐美学计算平台/01_第 1 章 绪论': {
		title: '音乐美学计算平台——第 1 章 绪论',
		pubDate: '2026-11-10',
		tags: ['音乐美学计算平台'],
		categories: ['音乐科技'],
	},
};

// 包一层 glob loader：没有 frontmatter 的文章，用 rawPosts 和正文 H1 补齐数据
const BLOG_DIR = './src/content/blog';

function blogLoader(): Loader {
	const base = glob({ base: BLOG_DIR, pattern: '**/*.{md,mdx}' });
	return {
		name: 'blog-loader',
		load: (context) =>
			base.load({
				...context,
				generateDigest: (data) =>
					context.generateDigest(
						typeof data === 'string' && data.includes('![[')
							? data + obsidianImageSignature()
							: data,
					),
				parseData: async (props) => {
					if (Object.keys(props.data).length === 0) {
						const key = relative(resolve(BLOG_DIR), props.filePath!)
							.split(sep)
							.join('/')
							.replace(/\.mdx?$/, '');
						const meta = rawPosts[key];
						if (!meta) {
							throw new Error(
								`${props.filePath} 没有 frontmatter，请在 src/content.config.ts 的 rawPosts 里添加 '${key}'`,
							);
						}
						const body = await readFile(props.filePath!, 'utf-8');
						const title = body.match(/^#\s+(.+)$/m)?.[1].trim() ?? props.id;
						Object.assign(props.data, { title, ...meta });
					}
					return context.parseData(props);
				},
			}),
	};
}

const blog = defineCollection({
	loader: blogLoader(),
	// Type-check frontmatter using a schema
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string().optional(),
			// Transform string to Date object
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
			tags: z.array(z.string()).default([]),
			categories: z.array(z.string()).default([]),
		}),
});

export const collections = { blog };
