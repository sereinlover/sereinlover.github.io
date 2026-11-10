// 支持 Obsidian 的图片写法 ![[xxx.png]]：按文件名在 public/images/ 下查找图片，转成普通图片节点
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const IMAGES_DIR = 'public/images';
const EMBED = /!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;

function indexImages(dir, index = new Map()) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) indexImages(full, index);
		else index.set(entry.name, '/' + relative('public', full).split(sep).join('/'));
	}
	return index;
}

// 图片清单 + 本插件源码的指纹。content.config.ts 把它算进缓存 digest，
// 图片挪了位置或插件改了，用到 ![[...]] 的文章会重新渲染
export function obsidianImageSignature() {
	const paths = [...indexImages(IMAGES_DIR).values()].sort().join('\n');
	return paths + '\n' + readFileSync(new URL(import.meta.url), 'utf-8');
}

function visitText(node, fn) {
	if (!node.children) return;
	for (let i = node.children.length - 1; i >= 0; i--) {
		const child = node.children[i];
		if (child.type === 'text') {
			const replacement = fn(child);
			if (replacement) node.children.splice(i, 1, ...replacement);
		} else {
			visitText(child, fn);
		}
	}
}

export default function remarkObsidianImage() {
	return (tree, file) => {
		// 每次处理都重新建索引，dev 时新加的图片不用重启
		const index = indexImages(IMAGES_DIR);
		visitText(tree, (node) => {
			if (!node.value.includes('![[')) return;
			const parts = [];
			let last = 0;
			for (const m of node.value.matchAll(EMBED)) {
				const name = m[1].trim().split('/').pop();
				const url = index.get(name);
				if (!url) {
					file.fail(`找不到图片 ${name}，请把它放到 ${IMAGES_DIR}/ 下`);
				}
				if (m.index > last) parts.push({ type: 'text', value: node.value.slice(last, m.index) });
				parts.push({
					type: 'image',
					url: encodeURI(url),
					alt: '',
					data: { hProperties: { className: ['obsidian-image'] } },
				});
				last = m.index + m[0].length;
			}
			if (parts.length === 0) return;
			if (last < node.value.length) parts.push({ type: 'text', value: node.value.slice(last) });
			return parts;
		});
	};
}
