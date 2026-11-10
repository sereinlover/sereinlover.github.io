// Obsidian 把单独成段的 `$$公式$$` 也视为块级公式。
export default function remarkDisplayMath() {
	return (tree, file) => {
		const source = String(file);

		function visit(parent) {
			if (!parent.children) return;
			for (const [index, node] of parent.children.entries()) {
				const math = node.type === 'paragraph' && node.children.length === 1
					? node.children[0]
					: undefined;
				if (math?.type === 'inlineMath' && math.position) {
					const { start, end } = math.position;
					const original = source.slice(start.offset, end.offset);
					if (/^\$\$(?!\$)[^\r\n]+(?<!\$)\$\$$/.test(original)) {
						// rehype-katex 会把 math 代码块渲染为独立公式。
						parent.children[index] = {
							type: 'code',
							lang: 'math',
							value: math.value,
							position: node.position,
						};
						continue;
					}
				}
				visit(node);
			}
		}

		visit(tree);
	};
}
