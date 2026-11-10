// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { MessageType } from "../shared/protocol";
import { Disposable, DisposableValue } from "./dispose";
import { HexDocument, ISelectionState } from "./hexDocument";
import { HexEditorRegistry } from "./hexEditorRegistry";
import { findDeepestNode, IStructureNode, IStructureTemplate } from "./structure";

const REPARSE_DELAY_MS = 300;

/** A template loaded from disk. Recompiled in place when its file changes. */
interface LoadedTemplate {
	uri: vscode.Uri;
	template: IStructureTemplate;
}

/**
 * Shows the active hex document parsed with a Kaitai Struct template, and
 * keeps tree and editor selections in sync.
 */
export class StructureView extends Disposable implements vscode.TreeDataProvider<IStructureNode> {
	public static readonly viewId = "hexEditor.structure";

	private readonly changeEmitter = this._register(new vscode.EventEmitter<void>());
	public readonly onDidChangeTreeData = this.changeEmitter.event;

	private readonly treeView: vscode.TreeView<IStructureNode>;
	/** Loaded templates, most recently used first. */
	private readonly templates: LoadedTemplate[] = [];
	/** Template for each document. `null` means the user cleared it. */
	private readonly assigned = new WeakMap<HexDocument, LoadedTemplate | null>();
	private roots: IStructureNode[] = [];
	private reparseTimer?: ReturnType<typeof setTimeout>;
	/** Incremented on each parse, so stale async parses can be dropped. */
	private parseVersion = 0;
	private readonly docListeners = this._register(new DisposableValue<vscode.Disposable>());

	constructor(private readonly registry: HexEditorRegistry) {
		super();
		this.treeView = this._register(
			vscode.window.createTreeView(StructureView.viewId, {
				treeDataProvider: this,
				showCollapseAll: true,
			}),
		);

		this._register(
			vscode.commands.registerCommand("hexEditor.structure.loadTemplate", (uri?: vscode.Uri) =>
				this.pickAndLoad(uri),
			),
		);
		this._register(
			vscode.commands.registerCommand("hexEditor.structure.clearTemplate", () => {
				const doc = registry.activeDocument;
				if (doc) {
					this.assigned.set(doc, null);
					this.reparse();
				}
			}),
		);
		this._register(
			vscode.commands.registerCommand("hexEditor.structure.selectNode", (node: IStructureNode) =>
				this.selectInEditor(node),
			),
		);

		this._register(registry.onDidChangeActiveDocument(doc => this.onActiveDocument(doc)));
		this.onActiveDocument(registry.activeDocument);
	}

	//#region TreeDataProvider

	getTreeItem(node: IStructureNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			node.name,
			!node.hasChildren
				? vscode.TreeItemCollapsibleState.None
				: node.parent
					? vscode.TreeItemCollapsibleState.Collapsed
					: vscode.TreeItemCollapsibleState.Expanded,
		);
		// Stable ids keep the expansion state across re-parses.
		item.id = node.id;
		item.description = node.error ?? node.value ?? node.type;
		item.iconPath = node.error
			? new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"))
			: new vscode.ThemeIcon(node.hasChildren ? "symbol-structure" : "symbol-field");

		const tooltip = new vscode.MarkdownString();
		tooltip.appendMarkdown(`**${node.name}**`);
		if (node.type) {
			tooltip.appendMarkdown(`: \`${node.type}\``);
		}
		if (node.value !== undefined) {
			tooltip.appendText(`\n\n${node.value}`);
		}
		if (node.range) {
			const { start, end } = node.range;
			tooltip.appendText(
				`\n\n${vscode.l10n.t("Offset")}: 0x${hex(start)}–0x${hex(Math.max(start, end - 1))} (${end - start} ${vscode.l10n.t("bytes")})`,
			);
			item.command = {
				command: "hexEditor.structure.selectNode",
				title: vscode.l10n.t("Select in Editor"),
				arguments: [node],
			};
		}
		if (node.error) {
			tooltip.appendText(`\n\n${node.error}`);
		}
		item.tooltip = tooltip;
		return item;
	}

	getChildren(node?: IStructureNode): IStructureNode[] {
		return node ? node.children() : this.roots;
	}

	getParent(node: IStructureNode): IStructureNode | undefined {
		return node.parent;
	}

	//#endregion

	private onActiveDocument(doc: HexDocument | undefined) {
		this.docListeners.value =
			doc &&
			vscode.Disposable.from(
				doc.onDidChangeContent(() => this.scheduleReparse()),
				doc.onDidChangeSelectionState(s => this.reveal(s)),
			);
		this.reparse();
	}

	/** Returns the template for a document, matching file extensions if none was chosen. */
	private templateFor(doc: HexDocument): LoadedTemplate | undefined {
		const assigned = this.assigned.get(doc);
		if (assigned !== undefined) {
			return assigned ?? undefined;
		}
		const ext = doc.uri.path.split(".").pop()?.toLowerCase();
		const match = this.templates.find(t => ext && t.template.fileExtensions.includes(ext));
		if (match) {
			this.assigned.set(doc, match);
		}
		return match;
	}

	private async pickAndLoad(uri?: vscode.Uri) {
		uri ??= (
			await vscode.window.showOpenDialog({
				canSelectMany: false,
				openLabel: vscode.l10n.t("Load Template"),
				filters: { [vscode.l10n.t("Kaitai Struct Templates")]: ["ksy"] },
			})
		)?.[0];
		if (!uri) {
			return;
		}

		let loaded = this.templates.find(t => t.uri.toString() === uri!.toString());
		try {
			const template = await compileTemplate(uri);
			if (loaded) {
				loaded.template = template;
				this.templates.splice(this.templates.indexOf(loaded), 1);
			} else {
				loaded = { uri, template };
				this.watch(loaded);
			}
			this.templates.unshift(loaded);
		} catch (e) {
			vscode.window.showErrorMessage(
				vscode.l10n.t("Failed to load Kaitai template: {0}", (e as Error).message),
			);
			return;
		}

		const doc = this.registry.activeDocument;
		if (doc) {
			this.assigned.set(doc, loaded);
		}
		this.reparse();
		vscode.commands.executeCommand(`${StructureView.viewId}.focus`);
	}

	/** Recompiles a template when its file changes, so authoring has fast feedback. */
	private watch(loaded: LoadedTemplate) {
		const base = vscode.Uri.joinPath(loaded.uri, "..");
		const name = loaded.uri.path.split("/").pop()!;
		const watcher = this._register(
			vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, name)),
		);
		watcher.onDidChange(async () => {
			try {
				loaded.template = await compileTemplate(loaded.uri);
				this.reparse();
			} catch (e) {
				vscode.window.showErrorMessage(
					vscode.l10n.t("Failed to load Kaitai template: {0}", (e as Error).message),
				);
			}
		});
	}

	private scheduleReparse() {
		clearTimeout(this.reparseTimer);
		this.reparseTimer = setTimeout(() => this.reparse(), REPARSE_DELAY_MS);
	}

	private async reparse() {
		clearTimeout(this.reparseTimer);
		const version = ++this.parseVersion;
		const doc = this.registry.activeDocument;
		const loaded = doc && this.templateFor(doc);
		vscode.commands.executeCommand("setContext", "hexEditor:hasStructureTemplate", !!loaded);

		this.treeView.description = loaded?.template.name;
		this.treeView.message = undefined;
		this.roots = [];
		if (doc && loaded) {
			// Kaitai streams need the whole file in one buffer. Fields are only
			// decoded when their tree node is expanded.
			let data: Uint8Array;
			try {
				data = await doc.readBufferWithEdits(0, (await doc.size()) ?? 0);
			} catch (e) {
				data = new Uint8Array();
				this.treeView.message = vscode.l10n.t("Failed to read file: {0}", (e as Error).message);
			}
			if (version !== this.parseVersion) {
				return; // superseded by a newer parse while reading
			}
			if (!this.treeView.message) {
				this.roots = loaded.template.parse(data);
			}
		}
		this.changeEmitter.fire();
	}

	/** Reveals the deepest field at the editor's focused byte. */
	private reveal({ focused: offset, selected }: ISelectionState) {
		if (offset === undefined || !this.treeView.visible) {
			return;
		}
		// Skip when the editor selection is the range the tree just selected,
		// so that selecting a struct does not jump to its first field.
		const range = this.treeView.selection[0]?.range;
		if (
			range &&
			selected === range.end - range.start &&
			range.start <= offset &&
			offset < range.end
		) {
			return;
		}
		const node = findDeepestNode(this.roots, offset);
		if (node) {
			this.treeView.reveal(node, { select: true, focus: false }).then(undefined, () => undefined);
		}
	}

	private selectInEditor(node: IStructureNode) {
		if (!node.range || node.range.end <= node.range.start) {
			return;
		}
		for (const messaging of this.registry.activeMessaging) {
			messaging.sendEvent({
				type: MessageType.SetFocusedByteRange,
				startingOffset: node.range.start,
				endingOffset: node.range.end - 1,
			});
		}
	}
}

/**
 * Loads Kaitai support on first use, since the compiler is several MB. The
 * desktop build ships it as a separate file; see `.esbuild.config.js`.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const loadKaitai = (): typeof import("./kaitai") => require("./kaitai");

async function compileTemplate(uri: vscode.Uri): Promise<IStructureTemplate> {
	const read = async (u: vscode.Uri) =>
		new TextDecoder().decode(await vscode.workspace.fs.readFile(u));
	const dir = vscode.Uri.joinPath(uri, "..");
	return loadKaitai().compileKaitaiTemplate(await read(uri), async (name, mode) => {
		if (mode === "rel") {
			return read(vscode.Uri.joinPath(dir, `${name}.ksy`));
		}
		// Absolute imports are relative to a format library root, such as a
		// checkout of kaitai_struct_formats. Search the template's ancestors.
		for (let d = dir; ; ) {
			try {
				return await read(vscode.Uri.joinPath(d, `${name}.ksy`));
			} catch {
				const parent = vscode.Uri.joinPath(d, "..");
				if (parent.path === d.path) {
					throw new Error(`Cannot find imported template ${name}`);
				}
				d = parent;
			}
		}
	});
}

const hex = (n: number) => n.toString(16).toUpperCase();
