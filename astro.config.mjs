// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkDisplayMath from './src/plugins/remark-display-math.mjs';
import remarkObsidianImage from './src/plugins/remark-obsidian-image.mjs';

// https://astro.build/config
export default defineConfig({
	site: 'https://sereinlover.github.io',
	integrations: [mdx(), sitemap()],
	markdown: {
		remarkPlugins: [remarkObsidianImage, remarkMath, remarkDisplayMath],
		// 预留分数线两侧的空间，实际线宽由文章样式控制。
		rehypePlugins: [[rehypeKatex, { minRuleThickness: 0.1 }]],
		// mermaid 代码块不做高亮，交给 BlogPost.astro 里的脚本渲染成图
		syntaxHighlight: {
			type: 'shiki',
			excludeLangs: ['math', 'mermaid'],
		},
		shikiConfig: {
			theme: 'rose-pine-dawn',
		},
	},
});
