import type { CollectionEntry } from 'astro:content';

export const topicKinds = { tags: 'Tags', categories: 'Categories' } as const;
export type TopicKind = keyof typeof topicKinds;
export type TopicLink = { name: string; href: string };

export function topicHref(kind: TopicKind, slug: string) {
	return `/${kind}/${encodeURIComponent(slug)}/`;
}

export function groupPostsByTopic(posts: CollectionEntry<'blog'>[], kind: TopicKind) {
	const groups = new Map<string, CollectionEntry<'blog'>[]>();
	for (const post of posts) {
		for (const name of new Set(post.data[kind].map((name) => name.trim()).filter(Boolean))) {
			const group = groups.get(name);
			if (group) group.push(post);
			else groups.set(name, [post]);
		}
	}

	const usedSlugs = new Set<string>();
	return [...groups].sort(([a], [b]) => a.localeCompare(b, 'zh-Hans')).map(([name, posts]) => {
		const base = name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'topic';
		let slug = base;
		for (let suffix = 2; usedSlugs.has(slug); suffix++) slug = `${base}-${suffix}`;
		usedSlugs.add(slug);
		return { name, slug, posts };
	});
}
