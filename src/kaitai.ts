// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as yaml from "js-yaml";
import { IStructureNode, IStructureTemplate } from "./structure";

// The packages' typings need newer lib.d.ts than this project uses, and the
// values are only used dynamically, so load them untyped.
/* eslint-disable @typescript-eslint/no-var-requires */
const KaitaiStream = require("kaitai-struct/KaitaiStream");
const compiler = require("kaitai-struct-compiler");
/* eslint-enable @typescript-eslint/no-var-requires */

/**
 * Reads an imported .ksy spec. `mode` is "rel" for paths relative to the
 * root template, or "abs" for paths relative to a format library root.
 */
export type KaitaiImportReader = (name: string, mode: "rel" | "abs") => Promise<string>;

/** Position info that the compiler emits in debug mode. */
interface DebugInfo {
	start?: number;
	end?: number;
	ioOffset?: number;
	enumName?: string;
	arr?: DebugInfo[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type KaitaiObject = { _io: any; _debug?: Record<string, DebugInfo> };

interface ParseContext {
	/** Buffer of the root stream. Offsets are only absolute in this buffer. */
	buffer: ArrayBuffer;
	modules: Map<string, any>;
}

const MAX_CHILDREN = 100;
const BYTES_PREVIEW = 16;
const STRING_PREVIEW = 100;

/** Compiles a .ksy source into a template. Throws with a readable message on failure. */
export async function compileKaitaiTemplate(
	source: string,
	readImport: KaitaiImportReader,
): Promise<IStructureTemplate> {
	const spec = yaml.load(source) as any;
	const id: string | undefined = spec?.meta?.id;
	if (typeof id !== "string") {
		throw new Error("Template has no meta/id");
	}

	let files: Record<string, string>;
	try {
		files = await compiler.compile(
			"javascript",
			spec,
			{
				importYaml: async (name: string, mode: "rel" | "abs") =>
					yaml.load(await readImport(name, mode)),
			},
			/* debug= */ true,
		);
	} catch (e) {
		// Errors from the Scala.js compiler stringify as "<java class>: <message>"
		throw new Error(String(e).replace(/^[\w.$]+Exception: /, ""));
	}

	const modules = evaluateModules(files);
	const className = toUpperCamel(id);
	const RootClass = modules.get(className)?.[className];
	if (typeof RootClass !== "function") {
		throw new Error(`Compiled template does not export ${className}`);
	}

	const ext = spec.meta["file-extension"];
	return {
		name: spec.meta.title || id,
		fileExtensions: (Array.isArray(ext) ? ext : ext ? [ext] : []).map(String),
		parse: data => {
			const buffer =
				data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
					? (data.buffer as ArrayBuffer)
					: data.slice().buffer;
			const root: KaitaiObject = new RootClass(new KaitaiStream(buffer));
			let error: string | undefined;
			try {
				(root as any)._read();
			} catch (e) {
				error = errorMessage(e);
			}
			const ctx: ParseContext = { buffer, modules };
			return [structNode(ctx, undefined, id, root, { start: 0, end: data.byteLength }, error)];
		},
	};
}

/**
 * Evaluates the compiled UMD modules with a minimal CommonJS loader, since
 * the generated code `require`s the runtime and other compiled specs.
 */
function evaluateModules(files: Record<string, string>): Map<string, any> {
	const modules = new Map<string, any>();
	const load = (name: string): any => {
		let exports = modules.get(name);
		if (exports) {
			return exports;
		}
		const code = files[`${name}.js`];
		if (code === undefined) {
			throw new Error(`Compiled template is missing module ${name}`);
		}
		exports = {};
		modules.set(name, exports); // set before running, for circular imports
		// `define` is shadowed so the UMD wrapper always takes the CommonJS branch.
		new Function("exports", "require", "define", code)(exports, require, undefined);
		return exports;
	};
	const require = (id: string) => {
		if (id === "kaitai-struct/KaitaiStream") {
			return KaitaiStream;
		}
		if (id.startsWith("./")) {
			return load(id.slice(2));
		}
		throw new Error(`Unexpected module ${id}`);
	};

	for (const file of Object.keys(files)) {
		load(file.replace(/\.js$/, ""));
	}
	return modules;
}

class Node implements IStructureNode {
	private _children?: IStructureNode[];
	public readonly id: string;

	constructor(
		public readonly parent: Node | undefined,
		public readonly name: string,
		props: Partial<Pick<IStructureNode, "type" | "value" | "range" | "error">>,
		private readonly getChildren?: (self: Node) => IStructureNode[],
	) {
		this.id = parent ? `${parent.id}/${name}` : name;
		Object.assign(this, props);
	}

	declare readonly type?: string;
	declare readonly value?: string;
	declare readonly range?: { start: number; end: number };
	declare readonly error?: string;

	get hasChildren() {
		return !!this.getChildren;
	}

	children() {
		this._children ??= this.getChildren?.(this) ?? [];
		return this._children;
	}
}

function isStruct(value: unknown): value is KaitaiObject {
	return typeof value === "object" && value !== null && "_io" in value;
}

/** Absolute range of a field, if it was read directly from the document. */
function absoluteRange(ctx: ParseContext, io: any, dbg: DebugInfo | undefined) {
	if (
		dbg?.start === undefined ||
		dbg.end === undefined ||
		// Fields inside processed (e.g. decompressed) streams have no document offset.
		// Reads `_buffer`: the public `buffer` getter copies substream buffers.
		io?._buffer !== ctx.buffer
	) {
		return undefined;
	}
	const base = dbg.ioOffset ?? 0;
	return { start: base + dbg.start, end: base + dbg.end };
}

function structNode(
	ctx: ParseContext,
	parent: Node | undefined,
	name: string,
	obj: KaitaiObject,
	range: IStructureNode["range"],
	error?: string,
): Node {
	return new Node(parent, name, { type: obj.constructor?.name, range, error }, self =>
		structFields(ctx, self, obj),
	);
}

function structFields(ctx: ParseContext, self: Node, obj: KaitaiObject): IStructureNode[] {
	const nodes: IStructureNode[] = [];
	const debug = obj._debug ?? {};

	// Sequence fields, in the order they were read.
	for (const [key, dbg] of Object.entries(debug)) {
		if (!key.startsWith("_m_")) {
			nodes.push(valueNode(ctx, self, toSnake(key), (obj as any)[key], obj._io, dbg));
		}
	}

	// Instances are lazy getters on the prototype; reading one parses it.
	const proto = Object.getPrototypeOf(obj);
	for (const key of Object.getOwnPropertyNames(proto)) {
		if (!Object.getOwnPropertyDescriptor(proto, key)?.get) {
			continue;
		}
		try {
			const value = (obj as any)[key];
			nodes.push(valueNode(ctx, self, toSnake(key), value, obj._io, debug[`_m_${key}`]));
		} catch (e) {
			nodes.push(new Node(self, toSnake(key), { error: errorMessage(e) }));
		}
	}

	return nodes;
}

function valueNode(
	ctx: ParseContext,
	parent: Node,
	name: string,
	value: unknown,
	io: any,
	dbg: DebugInfo | undefined,
): Node {
	const range = absoluteRange(ctx, io, dbg);
	// A field that started but never finished reading is where parsing failed.
	const error =
		dbg?.start !== undefined && dbg.end === undefined ? "Parsing stopped here" : undefined;
	if (isStruct(value)) {
		return structNode(ctx, parent, name, value, range, error);
	}
	if (Array.isArray(value)) {
		return new Node(parent, name, { value: `[${value.length}]`, range, error }, self =>
			arrayItems(ctx, self, value, io, dbg?.arr ?? [], 0, value.length),
		);
	}
	if (value === undefined) {
		return new Node(parent, name, { range, error });
	}
	return new Node(parent, name, { value: formatValue(ctx, value, dbg), range, error });
}

/** Array children, grouped into buckets of at most {@link MAX_CHILDREN}. */
function arrayItems(
	ctx: ParseContext,
	parent: Node,
	array: unknown[],
	io: any,
	arr: DebugInfo[],
	from: number,
	to: number,
): IStructureNode[] {
	const nodes: IStructureNode[] = [];
	if (to - from <= MAX_CHILDREN) {
		for (let i = from; i < to; i++) {
			nodes.push(valueNode(ctx, parent, `[${i}]`, array[i], io, arr[i]));
		}
		return nodes;
	}

	let step = MAX_CHILDREN;
	while ((to - from) / step > MAX_CHILDREN) {
		step *= MAX_CHILDREN;
	}
	for (let lo = from; lo < to; lo += step) {
		const hi = Math.min(lo + step, to);
		const first = absoluteRange(ctx, io, arr[lo]);
		const last = absoluteRange(ctx, io, arr[hi - 1]);
		nodes.push(
			new Node(
				parent,
				`[${lo}..${hi - 1}]`,
				{ range: first && last && { start: first.start, end: last.end } },
				self => arrayItems(ctx, self, array, io, arr, lo, hi),
			),
		);
	}
	return nodes;
}

function formatValue(ctx: ParseContext, value: unknown, dbg: DebugInfo | undefined): string {
	if (value instanceof Uint8Array) {
		const hex = Array.from(value.subarray(0, BYTES_PREVIEW), b =>
			b.toString(16).padStart(2, "0").toUpperCase(),
		).join(" ");
		return value.length > BYTES_PREVIEW ? `${hex} … (${value.length} bytes)` : hex;
	}
	if (typeof value === "string") {
		const json = JSON.stringify(value);
		return json.length > STRING_PREVIEW ? json.slice(0, STRING_PREVIEW) + '…"' : json;
	}
	if (typeof value === "number" || typeof value === "bigint") {
		const label = dbg?.enumName && lookupEnum(ctx, dbg.enumName, value);
		const num =
			Number.isInteger(value) || typeof value === "bigint"
				? `${value} (0x${value.toString(16).toUpperCase()})`
				: String(value);
		return label ? `${label} = ${num}` : num;
	}
	return String(value);
}

/** Resolves an enum label, given a debug enum name like "Png.ColorType". */
function lookupEnum(ctx: ParseContext, enumName: string, value: number | bigint) {
	const [moduleName, ...path] = enumName.split(".");
	let target = ctx.modules.get(moduleName)?.[moduleName];
	for (const part of path) {
		target = target?.[part];
	}
	const label = target?.[String(value)];
	return typeof label === "string" ? label.toLowerCase() : undefined;
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message || e.name : String(e);
}

/** "my_format" -> "MyFormat", matching the compiler's class naming. */
function toUpperCamel(id: string) {
	return id
		.split("_")
		.map(p => p.charAt(0).toUpperCase() + p.slice(1))
		.join("");
}

/** "numEntries" -> "num_entries", recovering .ksy ids from generated JS names. */
function toSnake(name: string) {
	return name.replace(/[A-Z]/g, c => "_" + c.toLowerCase());
}
