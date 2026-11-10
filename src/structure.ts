// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Parser-agnostic model of a parsed binary structure. Template engines
 * (currently only Kaitai Struct) produce a tree of these nodes, and the
 * structure view renders them. Keeping this independent of any one engine
 * leaves room for other template formats, or for a public API that lets
 * other extensions contribute parsers.
 * @see https://github.com/microsoft/vscode-hexeditor/issues/50
 */
export interface IStructureNode {
	/** Stable identifier, unique within one parse result. */
	readonly id: string;
	readonly name: string;
	readonly parent?: IStructureNode;
	/** Short type label, e.g. a struct name. */
	readonly type?: string;
	/** Display value for leaf nodes. */
	readonly value?: string;
	/** Absolute byte range [start, end) in the document, if it is known. */
	readonly range?: { start: number; end: number };
	/** Error raised while this node was parsed. */
	readonly error?: string;
	/** Whether {@link children} can return items. */
	readonly hasChildren: boolean;
	/** Lazily computes child nodes. Results are cached by the implementation. */
	children(): IStructureNode[];
}

/** A compiled template that can parse document contents. */
export interface IStructureTemplate {
	/** Human-readable name of the template. */
	readonly name: string;
	/** File extensions (without dot) that the template applies to. */
	readonly fileExtensions: readonly string[];
	parse(data: Uint8Array): IStructureNode[];
}

/**
 * Returns the deepest node whose range contains the offset. Only nodes on
 * the path to the offset are expanded.
 */
export function findDeepestNode(
	nodes: IStructureNode[],
	offset: number,
): IStructureNode | undefined {
	let best: IStructureNode | undefined;
	let level = nodes;
	for (;;) {
		let next: IStructureNode | undefined;
		for (const node of level) {
			const r = node.range;
			if (r && r.start <= offset && offset < r.end) {
				// Prefer the smallest containing range. Seq fields never overlap,
				// but instances can point anywhere in the file.
				if (!next || r.end - r.start < next.range!.end - next.range!.start) {
					next = node;
				}
			}
		}
		if (!next) {
			return best;
		}
		best = next;
		level = next.hasChildren ? next.children() : [];
	}
}
