// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as yaml from "js-yaml";
import * as path from "path";
import * as fs from "fs";
import KaitaiStream from "kaitai-struct/KaitaiStream";

// Import the compiler
// eslint-disable-next-line @typescript-eslint/no-var-requires
const KaitaiStructCompiler = require("kaitai-struct-compiler");

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
	private parserClasses: Map<string, any> = new Map();

	/**
	 * Load and compile a .ksy file to JavaScript
	 */
	async loadKsyFile(ksyPath: string): Promise<string> {
		try {
			const ksyContent = fs.readFileSync(ksyPath, "utf8");
			const ksyData = yaml.load(ksyContent) as any;
			const typeName = ksyData.meta?.id || path.basename(ksyPath, ".ksy");

			// Compile the KSY file to JavaScript using the kaitai-struct-compiler
			const compiledFiles = await KaitaiStructCompiler.compile("javascript", ksyData, null, false);

			// The result is an object with filenames as keys and JS code as values
			const jsCode = Object.values(compiledFiles)[0] as string;

			// Dynamically evaluate the generated JavaScript to create the parser class
			// eslint-disable-next-line no-new-func
			const evalFunc = new Function("KaitaiStream", jsCode + "; return " + this.getClassName(typeName) + ";");
			const ParserClass = evalFunc(KaitaiStream);

			this.parserClasses.set(typeName, ParserClass);

			return typeName;
		} catch (error) {
			throw new Error(`Failed to load KSY file: ${error}`);
		}
	}

	/**
	 * Convert a type name to the expected class name (e.g., "my_format" -> "MyFormat")
	 */
	private getClassName(typeName: string): string {
		return typeName
			.split("_")
			.map(part => part.charAt(0).toUpperCase() + part.slice(1))
			.join("");
	}

	/**
	 * Parse binary data using a loaded template
	 */
	async parseData(data: Uint8Array, typeName: string): Promise<any> {
		const ParserClass = this.parserClasses.get(typeName);
		if (!ParserClass) {
			throw new Error(`Parser for type "${typeName}" not loaded`);
		}

		try {
			// Create a Kaitai stream from the data buffer
			const stream = new KaitaiStream(data.buffer);

			// Instantiate the parser with the stream
			const parsed = new ParserClass(stream);

			// The parsed object contains all the fields defined in the .ksy file
			return this.extractFields(parsed);
		} catch (error) {
			throw new Error(`Failed to parse data: ${error}`);
		}
	}

	/**
	 * Extract fields recursively from a parsed Kaitai object
	 */
	private extractFields(obj: any, parentPath = ""): KaitaiParsedField[] {
		const fields: KaitaiParsedField[] = [];

		// Skip internal Kaitai fields
		const skipFields = ["_io", "_parent", "_root", "_read"];

		for (const key in obj) {
			if (skipFields.includes(key) || key.startsWith("_")) {
				continue;
			}

			const value = obj[key];
			const field: KaitaiParsedField = {
				name: key,
				value: this.formatValue(value),
			};

			// Try to get offset information if available
			if (obj._io && typeof obj._io.pos === "number") {
				field.offset = obj._io.pos;
			}

			// Handle nested objects
			if (value && typeof value === "object" && !Array.isArray(value)) {
				if (value._io) {
					// This is a nested Kaitai structure
					field.children = this.extractFields(value, `${parentPath}${key}.`);
				} else {
					// Try to extract fields from plain objects
					const nestedFields = this.extractFields(value, `${parentPath}${key}.`);
					if (nestedFields.length > 0) {
						field.children = nestedFields;
					}
				}
			} else if (Array.isArray(value)) {
				// Handle arrays
				const arrayFields: KaitaiParsedField[] = [];
				value.forEach((item, index) => {
					if (item && typeof item === "object") {
						const itemFields = this.extractFields(item, `${parentPath}${key}[${index}].`);
						if (itemFields.length > 0) {
							arrayFields.push({
								name: `[${index}]`,
								value: this.formatValue(item),
								children: itemFields,
							});
						}
					} else {
						arrayFields.push({
							name: `[${index}]`,
							value: this.formatValue(item),
						});
					}
				});
				if (arrayFields.length > 0) {
					field.children = arrayFields;
				}
			}

			fields.push(field);
		}

		return fields;
	}

	/**
	 * Format a value for display
	 */
	private formatValue(value: any): string {
		if (value === null || value === undefined) {
			return "null";
		}
		if (typeof value === "bigint") {
			return value.toString();
		}
		if (typeof value === "number") {
			return value.toString();
		}
		if (typeof value === "string") {
			return value;
		}
		if (typeof value === "boolean") {
			return value.toString();
		}
		if (value instanceof Uint8Array || value instanceof Array) {
			if (value.length > 20) {
				return `[${value.length} bytes]`;
			}
			return `[${Array.from(value).map(b => b.toString(16).padStart(2, "0")).join(" ")}]`;
		}
		if (typeof value === "object") {
			return "{...}";
		}
		return String(value);
	}

	/**
	 * Get list of loaded parsers
	 */
	getLoadedParsers(): string[] {
		return Array.from(this.parserClasses.keys());
	}

	/**
	 * Clear all loaded parsers
	 */
	clear(): void {
		this.parserClasses.clear();
	}
}
