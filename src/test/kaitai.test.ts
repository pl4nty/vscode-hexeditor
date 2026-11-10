/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from "chai";
import { compileKaitaiTemplate } from "../kaitai";
import { findDeepestNode, IStructureNode } from "../structure";

const spec = `
meta:
  id: demo
  title: Demo format
  endian: le
  file-extension: [dmo, demo]
  imports: [sub]
seq:
  - { id: magic, contents: [0x44, 0x4d] }
  - { id: num_items, type: u1 }
  - { id: items, type: item, repeat: expr, repeat-expr: num_items }
  - { id: blk, size: 4, type: sub }
  - { id: xored, size: 2, process: xor(0xff), type: item }
  - { id: many, type: u1, repeat: expr, repeat-expr: 250 }
instances:
  at_zero: { pos: 0, type: u2 }
  out_of_bounds: { pos: 100000, type: u4 }
types:
  item:
    seq:
      - { id: a, type: u1 }
      - { id: b, type: u1, enum: color }
enums:
  color: { 1: red, 2: green }
`;

const sub = `
meta: { id: sub, endian: be }
seq: [{ id: x, type: u4 }]
`;

const data = new Uint8Array([
	0x44,
	0x4d,
	2,
	1,
	1,
	2,
	2,
	0,
	0,
	1,
	0,
	0xfe,
	0xfd,
	...new Array(250).fill(7),
]);

const child = (node: IStructureNode, path: string) =>
	path.split("/").reduce((n, name) => {
		const c = n.children().find(c => c.name === name);
		if (!c) {
			throw new Error(`no child ${name} in ${n.id}`);
		}
		return c;
	}, node);

describe("Kaitai", () => {
	const compile = () =>
		compileKaitaiTemplate(spec, async name => {
			expect(name).to.equal("sub");
			return sub;
		});

	it("reads metadata", async () => {
		const t = await compile();
		expect(t.name).to.equal("Demo format");
		expect(t.fileExtensions).to.deep.equal(["dmo", "demo"]);
	});

	it("parses fields with absolute ranges", async () => {
		const [root] = (await compile()).parse(data);
		expect(root.error).to.be.undefined;
		expect(root.range).to.deep.equal({ start: 0, end: data.length });
		expect(child(root, "num_items").value).to.equal("2 (0x2)");
		expect(child(root, "items/[1]/b").value).to.equal("green = 2 (0x2)");
		expect(child(root, "items/[1]/b").range).to.deep.equal({ start: 6, end: 7 });
		// substreams of size-limited types share the document buffer
		expect(child(root, "blk/x").range).to.deep.equal({ start: 7, end: 11 });
		// processed streams have no document offsets, but their raw field does
		expect(child(root, "xored").range).to.deep.equal({ start: 11, end: 13 });
		expect(child(root, "xored/a").range).to.be.undefined;
		expect(child(root, "xored/a").value).to.equal("1 (0x1)");
	});

	it("parses instances lazily and reports their errors", async () => {
		const [root] = (await compile()).parse(data);
		expect(child(root, "at_zero").range).to.deep.equal({ start: 0, end: 2 });
		expect(child(root, "out_of_bounds").error).to.be.a("string");
	});

	it("groups large arrays", async () => {
		const [root] = (await compile()).parse(data);
		const many = child(root, "many");
		expect(many.children().map(c => c.name)).to.deep.equal(["[0..99]", "[100..199]", "[200..249]"]);
		expect(child(many, "[200..249]").range).to.deep.equal({ start: 213, end: 263 });
	});

	it("keeps partial results when parsing fails", async () => {
		const [root] = (await compile()).parse(data.subarray(0, 5));
		expect(root.error).to.be.a("string");
		expect(child(root, "items/[0]/b").value).to.equal("red = 1 (0x1)");
		expect(child(root, "items/[1]").error).to.be.a("string");
	});

	it("finds the deepest node at an offset", async () => {
		const roots = (await compile()).parse(data);
		expect(findDeepestNode(roots, 4)?.id).to.equal("demo/items/[0]/b");
		expect(findDeepestNode(roots, 8)?.id).to.equal("demo/blk/x");
		expect(findDeepestNode(roots, 200)?.id).to.equal("demo/many/[100..199]/[187]");
	});

	it("reports compile errors", async () => {
		try {
			await compileKaitaiTemplate("meta: {id: bad}\nseq: [{id: x, type: nope}]", async () => "");
			expect.fail("expected an error");
		} catch (e) {
			expect((e as Error).message).to.contain("unable to find type 'nope'");
		}
	});
});
