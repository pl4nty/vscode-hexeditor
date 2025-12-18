// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as yaml from "js-yaml";
import * as path from "path";
import * as fs from "fs";

// Kaitai Struct runtime
import KaitaiStream from "kaitai-struct/KaitaiStream";

export interface KaitaiParsedField {
	name: string;
	value: any;
	offset?: number;
	size?: number;
	type?: string;
	children?: KaitaiParsedField[];
}

export class KaitaiParser {
	private compiledParsers: Map<string, any> = new Map();

	/**
	 * Load and compile a .ksy file
	 */
	async loadKsyFile(ksyPath: string): Promise<void> {
		try {
			const ksyContent = fs.readFileSync(ksyPath, "utf8");
			const ksyData = yaml.load(ksyContent) as any;

			const typeName = ksyData.meta?.id || path.basename(ksyPath, ".ksy");

			// KNOWN LIMITATION: This implementation manually interprets the KSY format
			// rather than using the full Kaitai compiler. This means:
			// - Only basic types are supported (integers, floats, strings)
			// - Advanced features (instances, enums, conditionals, custom types) are not supported
			// - A full implementation would compile the .ksy to JavaScript using kaitai-struct-compiler
			//   and dynamically load the generated parser class
			this.compiledParsers.set(typeName, {
				ksyData,
				typeName,
			});
		} catch (error) {
			throw new Error(`Failed to load KSY file: ${error}`);
		}
	}

	/**
	 * Parse binary data using a loaded template
	 */
	async parseData(
		data: Uint8Array,
		typeName: string,
	): Promise<KaitaiParsedField[] | undefined> {
		const parser = this.compiledParsers.get(typeName);
		if (!parser) {
			throw new Error(`Parser for type "${typeName}" not loaded`);
		}

		try {
			// Create a Kaitai stream from the data
			const stream = new KaitaiStream(data);

			// Parse the structure based on the KSY definition
			// This is a simplified version - real implementation would use
			// the compiled JavaScript parser
			const fields = this.parseFields(parser.ksyData.seq || [], stream);

			return fields;
		} catch (error) {
			throw new Error(`Failed to parse data: ${error}`);
		}
	}

	/**
	 * Parse fields from the KSY definition
	 */
	private parseFields(seqDefinition: any[], stream: KaitaiStream): KaitaiParsedField[] {
		const fields: KaitaiParsedField[] = [];

		for (const fieldDef of seqDefinition) {
			const offset = stream.pos;
			let value: any;
			let size = 0;

			// Parse based on field type
			switch (fieldDef.type) {
				case "u1":
					value = stream.readU1();
					size = 1;
					break;
				case "u2":
				case "u2le":
					value = stream.readU2le();
					size = 2;
					break;
				case "u2be":
					value = stream.readU2be();
					size = 2;
					break;
				case "u4":
				case "u4le":
					value = stream.readU4le();
					size = 4;
					break;
				case "u4be":
					value = stream.readU4be();
					size = 4;
					break;
				case "u8":
				case "u8le":
					value = stream.readU8le();
					size = 8;
					break;
				case "u8be":
					value = stream.readU8be();
					size = 8;
					break;
				case "s1":
					value = stream.readS1();
					size = 1;
					break;
				case "s2":
				case "s2le":
					value = stream.readS2le();
					size = 2;
					break;
				case "s2be":
					value = stream.readS2be();
					size = 2;
					break;
				case "s4":
				case "s4le":
					value = stream.readS4le();
					size = 4;
					break;
				case "s4be":
					value = stream.readS4be();
					size = 4;
					break;
				case "s8":
				case "s8le":
					value = stream.readS8le();
					size = 8;
					break;
				case "s8be":
					value = stream.readS8be();
					size = 8;
					break;
				case "f4":
				case "f4le":
					value = stream.readF4le();
					size = 4;
					break;
				case "f4be":
					value = stream.readF4be();
					size = 4;
					break;
				case "f8":
				case "f8le":
					value = stream.readF8le();
					size = 8;
					break;
				case "f8be":
					value = stream.readF8be();
					size = 8;
					break;
				case "str":
				case "strz":
					// For strings, we need to know the size
					if (fieldDef.size) {
						const bytes = stream.readBytes(fieldDef.size);
						value = new TextDecoder("utf-8").decode(bytes);
						size = fieldDef.size;
					} else {
						// Read until null terminator (with safety limit)
						const startPos = stream.pos;
						const bytes: number[] = [];
						let byte;
						const maxStringLength = 1000; // Safety limit
						while (bytes.length < maxStringLength && !stream.isEof()) {
							byte = stream.readU1();
							if (byte === 0) break;
							bytes.push(byte);
						}
						value = new TextDecoder("utf-8").decode(new Uint8Array(bytes));
						size = stream.pos - startPos;
					}
					break;
				default:
					// Unknown type or custom type reference
					if (fieldDef.size) {
						stream.readBytes(fieldDef.size);
						value = `<${fieldDef.type}>`;
						size = fieldDef.size;
					} else {
						value = `<${fieldDef.type || "unknown"}>`;
						size = 0;
					}
					break;
			}

			fields.push({
				name: fieldDef.id || "unknown",
				value,
				offset,
				size,
				type: fieldDef.type,
			});
		}

		return fields;
	}

	/**
	 * Get list of loaded parsers
	 */
	getLoadedParsers(): string[] {
		return Array.from(this.compiledParsers.keys());
	}

	/**
	 * Clear all loaded parsers
	 */
	clear(): void {
		this.compiledParsers.clear();
	}
}
