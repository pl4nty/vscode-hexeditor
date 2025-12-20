// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as fs from "fs";
import * as yaml from "js-yaml";
import * as path from "path";
// Use package-root import to get CommonJS export shape reliably
import * as kaitai from "kaitai-struct";
const KaitaiStream = (kaitai as any).KaitaiStream as any;

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
	// For lazy loading: if true, children haven't been loaded yet
	childrenNotLoaded?: boolean;
	// Path to this field for lazy re-access (e.g. "pe.sections[0]")
	fieldPath?: string;
}

export class KaitaiParser {
	private parserClasses: Map<string, any> = new Map();
	private templatePaths: Map<string, string> = new Map();
	// Store parsed objects for lazy field access
	private parsedObjects: Map<string, any> = new Map();
	private currentData: Uint8Array | undefined;

	/**
	 * Load and compile a .ksy file to JavaScript
	 */
	async loadKsyFile(ksyPath: string): Promise<string> {
		try {
			const ksyContent = fs.readFileSync(ksyPath, "utf8");
			const ksyData = yaml.load(ksyContent) as any;
			const typeName = ksyData.meta?.id || path.basename(ksyPath, ".ksy");
			this.templatePaths.set(typeName, ksyPath);

		// Create an import resolver for loading imported .ksy files
		const ksyDir = path.dirname(ksyPath);
		const importResolver = {
			importYaml: (name: string, _mode: string) => {
				// Try to find the import file in the same directory
				const importPath = path.join(ksyDir, `${name}.ksy`);
				if (fs.existsSync(importPath)) {
					const importContent = fs.readFileSync(importPath, "utf8");
					return Promise.resolve(yaml.load(importContent));
				}
				// If not found locally, return null and let the compiler handle it
				return Promise.resolve(null);
			}
		};

		// Compile the KSY file to JavaScript using the kaitai-struct-compiler
		const compiledFiles = await KaitaiStructCompiler.compile("javascript", ksyData, importResolver, true);

		// The result is an object with filenames as keys and JS code as values
		// We need to evaluate all compiled files to handle imports
		const compiledModules = new Map<string, any>();

		// Create a require shim that handles both kaitai-struct and local imports
		const requireShim = (moduleName: string) => {
			if (moduleName === "kaitai-struct/KaitaiStream" || moduleName === "kaitai-struct") {
				return KaitaiStream;
			}
			// Handle relative imports like ./MicrosoftPe
			if (moduleName.startsWith("./")) {
				const importName = moduleName.substring(2);
				if (compiledModules.has(importName)) {
					return compiledModules.get(importName);
				}
			}
			throw new Error(`Unknown module: ${moduleName}`);
		};

		// First pass: evaluate all compiled files to build the module cache
		for (const [fileName, jsCode] of Object.entries(compiledFiles)) {
			if (!jsCode) continue;

			try {
				const moduleShim = { exports: {} as any };
				const evalCode = new Function(
					"module",
					"exports",
					"require",
					"KaitaiStream",
					jsCode as string
				);
				evalCode(moduleShim, moduleShim.exports, requireShim, KaitaiStream);

				// Store the module by its base name (without extension)
				const moduleName = path.basename(fileName, ".js");
				compiledModules.set(moduleName, moduleShim.exports);
			} catch (e) {
				console.warn(`Failed to evaluate compiled file ${fileName}:`, e);
			}
		}

		// Get the main module's code
		const jsCode = Object.values(compiledFiles)[0] as string;
		if (!jsCode) {
			throw new Error("Compiler did not generate any JavaScript code");
		}

		// eslint-disable-next-line no-new-func
		let ParserClass: any;
		const errors: string[] = [];

		// Method 1: Try CommonJS module.exports (direct or as property)
		try {
			const moduleShim = { exports: {} as any };
			const evalCjs = new Function(
				"module",
				"exports",
				"require",
				"KaitaiStream",
				jsCode + "; return module.exports;",
			);
			const exported = evalCjs(moduleShim, moduleShim.exports, requireShim, KaitaiStream);

			// Check if module.exports is the constructor directly
			if (typeof exported === "function") {
				this.parserClasses.set(typeName, exported);
				return typeName;
			}

			// Check if module.exports is an object with the class as a property
			if (exported && typeof exported === "object") {
				const className = this.getClassName(typeName);
				if (typeof exported[className] === "function") {
					this.parserClasses.set(typeName, exported[className]);
					return typeName;
				}
				// Try to find any function in the exports
				for (const key in exported) {
					if (typeof exported[key] === "function") {
						this.parserClasses.set(typeName, exported[key]);
						return typeName;
					}
				}
			}

			errors.push("module.exports is not a constructor or does not contain a constructor");
		} catch (e) {
			errors.push(`module.exports eval failed: ${e}`);
		}

		// Method 2: Try named class with capitalized name
		try {
			const className = this.getClassName(typeName);
			const moduleShim = { exports: {} as any };
			const evalNamed = new Function(
				"module",
				"exports",
				"require",
				"KaitaiStream",
				jsCode + "; return typeof " + className + " !== 'undefined' ? " + className + " : undefined;",
			);
			ParserClass = evalNamed(moduleShim, moduleShim.exports, requireShim, KaitaiStream);
			if (typeof ParserClass === "function") {
				this.parserClasses.set(typeName, ParserClass);
				return typeName;
			}
			errors.push(`${className} is not defined or not a constructor`);
		} catch (e) {
			errors.push(`named class eval failed: ${e}`);
		}

		// Method 3: Execute the code and look for any constructor in global scope
		try {
			const globalCapture: any = {};
			const moduleShim = { exports: {} as any };
			const evalGlobal = new Function(
				"module",
				"exports",
				"require",
				"KaitaiStream",
				"__capture",
				jsCode + "; for (var k in this) { if (typeof this[k] === 'function' && this[k].toString().includes('KaitaiStream')) { __capture.cls = this[k]; break; } }",
			);
			evalGlobal.call(globalCapture, moduleShim, moduleShim.exports, requireShim, KaitaiStream, globalCapture);
			if (typeof globalCapture.cls === "function") {
				this.parserClasses.set(typeName, globalCapture.cls);
				return typeName;
			}
			errors.push("no constructor found in global scope");
		} catch (e) {
			errors.push(`global scope eval failed: ${e}`);
		}

		throw new Error(`Failed to extract parser class from compiled code. Attempts: ${errors.join("; ")}`);
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
		console.log(`=== parseData called ===`);
		console.log(`typeName: ${typeName}`);
		console.log(`ParserClass exists: ${!!ParserClass}`);
		console.log(`data size: ${data.length} bytes`);

		try {
			if (typeof ParserClass === "function") {
				// Create a Kaitai stream from the data buffer
				const stream = new KaitaiStream(data.buffer);
				console.log(`Created KaitaiStream, size: ${stream.size}`);

				// Instantiate the parser with the stream
				const parsed = new ParserClass(stream);
				// Ensure the parser actually reads the stream; some builds
				// may not auto-call _read() in the constructor.
				if (parsed && typeof parsed._read === "function") {
					try {
						parsed._read();
						console.log("Invoked parsed._read() successfully");
					} catch (e) {
						console.warn("Calling _read() failed:", e);
					}
				}
				console.log(`Created parser instance:`, parsed);
				console.log(`Parser constructor name:`, parsed.constructor.name);
				console.log(`Parser own keys:`, Object.keys(parsed));
				console.log(`Parser proto:`, Object.getPrototypeOf(parsed));
				console.log(`Parser proto keys:`, Object.getOwnPropertyNames(Object.getPrototypeOf(parsed)));

				// Store the parsed object for lazy field access
				this.currentData = data;
				const cacheKey = `${typeName}:${data.length}`;
				this.parsedObjects.set(cacheKey, parsed);

				// Use shallow=true to only load top-level fields initially
				// Children will be loaded on-demand when expanded in the tree
				const fields = this.extractFields(parsed, "", true);
				console.log(`extractFields returned ${fields.length} fields`);

				// If no fields extracted, show the raw parsed object for debugging
				if (!fields || fields.length === 0) {
					console.warn("No fields extracted from parsed object. Keys:", Object.keys(parsed));
					// Return at least something to indicate parsing happened
					return [{
						name: typeName,
						value: "Parsed (no fields extracted)",
						children: Object.keys(parsed)
							.filter(k => !k.startsWith("_"))
							.map(k => ({
								name: k,
								value: String(parsed[k]),
							})),
					}];
				}

				return fields;
			}
			throw new Error(`Parser for type "${typeName}" not loaded`);
		} catch (error) {
			console.error("parseData error:", error);
			throw new Error(`Failed to parse data: ${error}`);
		}
	}

	// Limits to prevent memory issues with large files
	private static readonly MAX_RECURSION_DEPTH = 50;
	private static readonly MAX_ARRAY_ITEMS_TO_SHOW = 1000;
	private static readonly MAX_FIELDS_PER_LEVEL = 1000;

	/**
	 * Extract fields recursively from a parsed Kaitai object
	 * @param obj The object to extract fields from
	 * @param parentPath Path to this object (for lazy loading)
	 * @param shallow If true, don't access getters for nested objects (lazy load)
	 * @param depth Current recursion depth
	 * @param visited Set of already visited objects to prevent circular references
	 */
	private extractFields(obj: any, parentPath = "", shallow = false, depth = 0, visited?: WeakSet<object>): KaitaiParsedField[] {
		const fields: KaitaiParsedField[] = [];

		// Initialize visited set on first call
		if (!visited) {
			visited = new WeakSet<object>();
		}

		// Prevent circular references - check if we've already visited this object
		if (obj && typeof obj === "object" && visited.has(obj)) {
			fields.push({
				name: "<circular>",
				value: "Circular reference detected",
				fieldPath: parentPath,
			});
			return fields;
		}

		// Mark this object as visited
		if (obj && typeof obj === "object") {
			visited.add(obj);
		}

		// Prevent stack overflow and memory issues with deeply nested structures
		if (depth > KaitaiParser.MAX_RECURSION_DEPTH) {
			fields.push({
				name: "<truncated>",
				value: `Maximum depth (${KaitaiParser.MAX_RECURSION_DEPTH}) exceeded`,
				fieldPath: parentPath,
			});
			return fields;
		}

		// Skip internal Kaitai fields
		const skipFields = ["_io", "_parent", "_root", "_read", "_debug"];

		// Kaitai parsers often use getters, so we need to look at the prototype too
		// Use arrays instead of Sets to avoid Set size limits
		const allKeys: string[] = [];
		const seenKeys: Record<string, boolean> = {};

		// Get enumerable own properties (limit to prevent issues)
		const ownKeys = Object.keys(obj);
		for (let i = 0; i < ownKeys.length && allKeys.length < KaitaiParser.MAX_FIELDS_PER_LEVEL; i++) {
			const k = ownKeys[i];
			if (!seenKeys[k]) {
				seenKeys[k] = true;
				allKeys.push(k);
			}
		}

		// Get properties from prototype (including getters)
		let proto = Object.getPrototypeOf(obj);
		let level = 0;
		while (proto && proto !== Object.prototype && level < 10 && allKeys.length < KaitaiParser.MAX_FIELDS_PER_LEVEL) {
			const protoKeys = Object.getOwnPropertyNames(proto);
			for (let i = 0; i < protoKeys.length && allKeys.length < KaitaiParser.MAX_FIELDS_PER_LEVEL; i++) {
				const k = protoKeys[i];
				if (k !== "constructor" && !skipFields.includes(k) && !k.startsWith("_") && !seenKeys[k]) {
					// Skip functions (methods)
					const descriptor = Object.getOwnPropertyDescriptor(proto, k);
					if (descriptor && typeof descriptor.value === "function") {
						continue;
					}
					seenKeys[k] = true;
					allKeys.push(k);
				}
			}
			proto = Object.getPrototypeOf(proto);
			level++;
		}

		const keys = allKeys.filter(k => !skipFields.includes(k) && !k.startsWith("_"));

		if (keys.length === 0) {
			return fields;
		}

		// Limit the number of keys to process to prevent memory issues
		const keysToProcess = keys.slice(0, KaitaiParser.MAX_FIELDS_PER_LEVEL);
		const keysTruncated = keys.length > KaitaiParser.MAX_FIELDS_PER_LEVEL;

		for (const key of keysToProcess) {
			try {
				const fieldPath = parentPath ? `${parentPath}.${key}` : key;

				let value = obj[key];

				// In shallow mode, check if this is a getter for a complex object
				// Simple values (primitives) should be loaded immediately
				if (shallow && value === undefined) {
					const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(obj), key);
					if (descriptor && descriptor.get) {
						// Try accessing the getter to see what it returns
						try {
							value = obj[key];
							// If it's a complex Kaitai object, defer it
							if (value && typeof value === "object" && value._io) {
								const field: KaitaiParsedField = {
									name: key,
									value: "<not loaded>",
									childrenNotLoaded: true,
									fieldPath: fieldPath,
									children: [], // Empty array signals it's expandable
								};
								fields.push(field);
								continue;
							}
							// Otherwise fall through to handle it normally
						} catch (e) {
							// Getter threw an error, skip it
							const isEOF = e && typeof e === 'object' && 'name' in e && e.name === 'EOFError';
							if (!isEOF) {
								console.error(`Failed to access getter ${key}:`, e);
							}
							continue;
						}
					}
				}

				// Skip undefined or null values
				if (value === undefined || value === null) {
					continue;
				}

				const field: KaitaiParsedField = {
					name: key,
					value: this.formatValue(value),
					fieldPath: fieldPath,
				};

			// Try to get offset information from debug metadata if available
			const dbg = obj._debug && (obj._debug as any)[key];
			if (dbg) {
				if (Array.isArray(dbg.arr)) {
					// handled per-array-item below
				} else if (typeof dbg.start === "number" && typeof dbg.end === "number") {
					field.offset = dbg.start;
					field.size = Math.max(0, dbg.end - dbg.start);
				}
			}

			// Handle nested objects (but skip TypedArrays like Uint8Array)
			if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array) && !ArrayBuffer.isView(value)) {
				if (value._io) {
					// This is a nested Kaitai structure
					if (shallow) {
						// Mark as lazy-loadable
						field.children = [];
						field.childrenNotLoaded = true;
					} else {
						field.children = this.extractFields(value, fieldPath, false, depth + 1, visited);
					}
				} else {
					// Try to extract fields from plain objects
					if (shallow) {
						const nestedFields = this.extractFields(value, fieldPath, true, depth + 1, visited);
						if (nestedFields.length > 0) {
							field.children = nestedFields;
						}
					} else {
						const nestedFields = this.extractFields(value, fieldPath, false, depth + 1, visited);
						if (nestedFields.length > 0) {
							field.children = nestedFields;
						}
					}
				}
			} else if (Array.isArray(value)) {
				// Check if array contains objects or just primitives
				const hasObjects = value.length > 0 && value.some((item, i) => i < 10 && item && typeof item === "object");

				if (!hasObjects) {
					// Just a primitive array, don't make it expandable
					// Value is already formatted by formatValue above
				} else {
					// Handle arrays with limits to prevent memory issues
					const arrayFields: KaitaiParsedField[] = [];
					const arrayLength = value.length;
					const maxItems = KaitaiParser.MAX_ARRAY_ITEMS_TO_SHOW;
					const itemsToProcess = Math.min(arrayLength, maxItems);

					for (let index = 0; index < itemsToProcess; index++) {
						const item = value[index];
					const itemPath = `${fieldPath}[${index}]`;
					if (item && typeof item === "object") {
						const child: KaitaiParsedField = {
							name: `[${index}]`,
							value: this.formatValue(item),
							fieldPath: itemPath,
						};
						if (shallow && item._io) {
							// Lazy load array items
							child.children = [];
							child.childrenNotLoaded = true;
						} else {
							const itemFields = this.extractFields(item, itemPath, shallow, depth + 1, visited);
							child.children = itemFields;
						}
						if (dbg && Array.isArray(dbg.arr) && dbg.arr[index]) {
							const di = dbg.arr[index];
							if (typeof di.start === "number" && typeof di.end === "number") {
								child.offset = di.start;
								child.size = Math.max(0, di.end - di.start);
							}
						}
						arrayFields.push(child);
					} else {
						const child: KaitaiParsedField = {
							name: `[${index}]`,
							value: this.formatValue(item),
						};
						if (dbg && Array.isArray(dbg.arr) && dbg.arr[index]) {
							const di = dbg.arr[index];
							if (typeof di.start === "number" && typeof di.end === "number") {
								child.offset = di.start;
								child.size = Math.max(0, di.end - di.start);
							}
						}
						arrayFields.push(child);
					}
				}

					// Add truncation indicator if array was too large
					if (arrayLength > maxItems) {
						arrayFields.push({
							name: `<truncated>`,
							value: `${arrayLength - maxItems} more items not shown (total: ${arrayLength})`,
							fieldPath: fieldPath,
						});
					}

					if (arrayFields.length > 0) {
						field.children = arrayFields;
					}
				}
			}


				// Push the field after processing nested children
				fields.push(field);

			} catch (e) {
			// Getter might throw for optional/conditional fields or when data is truncated
			// Only log non-EOF errors at error level
			const isEOF = e && typeof e === 'object' && 'name' in e && e.name === 'EOFError';
			if (!isEOF) {
				console.error(`Failed to access property ${key}:`, e);
			}
		}
	}

	// Add truncation indicator if fields were limited
	if (keysTruncated) {
		fields.push({
			name: "<truncated>",
			value: `${keys.length - KaitaiParser.MAX_FIELDS_PER_LEVEL} more fields not shown (total: ${keys.length})`,
			fieldPath: parentPath,
		});
	}

	return fields;
}


	/**
	 * Load children for a field on demand (called when tree node is expanded)
	 */
	async loadFieldChildren(field: KaitaiParsedField, typeName: string): Promise<KaitaiParsedField[]> {
		console.log(`loadFieldChildren called for ${field.fieldPath}, childrenNotLoaded=${field.childrenNotLoaded}`);

		if (!field.fieldPath) {
			console.log("No fieldPath, returning existing children");
			return field.children || [];
		}

		if (!field.childrenNotLoaded) {
			console.log("Children already loaded, returning existing children");
			return field.children || [];
		}

		const cacheKey = `${typeName}:${this.currentData?.length}`;
		const rootObj = this.parsedObjects.get(cacheKey);
		console.log(`Cache key: ${cacheKey}, rootObj exists: ${!!rootObj}`);
		if (!rootObj) {
			return [];
		}

		try {
			// Navigate to the field using its path
			const pathParts = field.fieldPath.split(/[.[\]]+/).filter(p => p);
			console.log(`Navigating path parts:`, pathParts);
			let obj = rootObj;
			for (const part of pathParts) {
				if (!isNaN(Number(part))) {
					obj = obj[Number(part)];
				} else {
					obj = obj[part];
				}
				if (obj === undefined || obj === null) {
					console.log(`Navigation failed at part: ${part}`);
					return [];
				}
			}
			console.log(`Navigated to object, type: ${typeof obj}, isKaitai: ${!!(obj && obj._io)}`);

			// Now extract fields from this object - use shallow mode so only
			// immediate children are loaded, not the entire subtree
			const children = this.extractFields(obj, field.fieldPath, true);
			console.log(`Extracted ${children.length} children`);
			// Update the field
			field.children = children;
			field.childrenNotLoaded = false;
			// Update value if it was placeholder
			if (field.value === "<not loaded>") {
				field.value = this.formatValue(obj);
			}
			return children;
		} catch (e) {
			console.error(`Failed to load children for ${field.fieldPath}:`, e);
			return [];
		}
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
			const arr = Array.from(value as any[]);
			// Check if array contains objects - if so, don't show a preview
			const hasObjects = arr.length > 0 && arr.some((item, i) => i < 10 && item && typeof item === "object");
			if (hasObjects) {
				return ""; // No preview for object arrays
			}
			const allByte = arr.every(v => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xFF);
			if (arr.length > 64) {
				return allByte
					? `[${arr.slice(0, 64).map(b => `0x${(b as number).toString(16).padStart(2, "0")}`).join(", ")}, …]`
					: `[${arr.slice(0, 64).join(", ")}, …]`;
			}
			return allByte
				? `[${arr.map(b => `0x${(b as number).toString(16).padStart(2, "0")}`).join(", ")}]`
				: `[${arr.join(", ")}]`;
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
		return Array.from(new Set([
			...this.parserClasses.keys(),
		]));
	}

	/**
	 * Clear all loaded parsers
	 */
	clear(): void {
		this.parserClasses.clear();
		this.templatePaths.clear();
	}
}
