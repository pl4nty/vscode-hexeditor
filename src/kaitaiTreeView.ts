// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { Disposable } from "./dispose";
import { KaitaiParsedField } from "./kaitaiParser";

class KaitaiNode extends vscode.TreeItem {
  constructor(
    public readonly field: KaitaiParsedField,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    const label = field.name;
    super(label, collapsibleState);
    const valueStr = typeof field.value === "string" ? field.value : String(field.value);
    this.description = field.type ? `${valueStr} (${field.type})` : valueStr;
    if (typeof field.offset === "number") {
      this.tooltip = `${field.name} @0x${field.offset.toString(16).toUpperCase()}`;
      // Add command to select the byte range in hex editor when clicked
      if (typeof field.size === "number" && field.size > 0) {
        this.command = {
          command: "hexEditor.kaitaiSelectRange",
          title: "Select Range",
          arguments: [field.offset, field.size],
        };
      }
    }
    this.contextValue = "kaitaiField";
  }
}

export class KaitaiTreeProvider extends Disposable implements vscode.TreeDataProvider<KaitaiNode> {
  public static readonly viewId = "hexEditor.kaitaiTree";

  private _onDidChangeTreeData = new vscode.EventEmitter<KaitaiNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _rootFields: KaitaiParsedField[] = [];
  private _parser: any; // KaitaiParser instance
  private _typeName: string | undefined;

  setData(fields: KaitaiParsedField[] | undefined, parser?: any, typeName?: string): void {
    this._rootFields = fields ?? [];
    if (parser) {
      this._parser = parser;
    }
    if (typeName) {
      this._typeName = typeName;
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: KaitaiNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: KaitaiNode): Promise<KaitaiNode[]> {
    if (element && element.field.childrenNotLoaded && this._parser && this._typeName) {
      // Lazy load children when node is expanded
      try {
        await this._parser.loadFieldChildren(element.field, this._typeName);
      } catch (e) {
        console.error("Failed to load children:", e);
      }
    }

    const children = element ? element.field.children ?? [] : this._rootFields;
    const items = children.map((f) => new KaitaiNode(
      f,
      (f.children && f.children.length > 0) || f.childrenNotLoaded
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    ));
    return items;
  }
}
