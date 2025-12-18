// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { Disposable } from "./dispose";
import { HexEditorRegistry } from "./hexEditorRegistry";
import { KaitaiParser } from "./kaitaiParser";
import { randomString } from "./util";

export class KaitaiView extends Disposable implements vscode.WebviewViewProvider {
	public static readonly viewType = "hexEditor.kaitaiView";
	private _view?: vscode.WebviewView;
	private _parser: KaitaiParser;
	private _currentKsyPath?: string;

	constructor(
		private readonly _extensionURI: vscode.Uri,
		private readonly registry: HexEditorRegistry,
	) {
		super();
		this._parser = new KaitaiParser();

		this._register(
			registry.onDidChangeActiveDocument(doc => {
				if (doc) {
					this.refreshParsedData();
				}
			}),
		);
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this._view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionURI],
		};
		webviewView.webview.html = this._getWebviewHTML(webviewView.webview);

		// Message handler for when the view sends messages back
		webviewView.webview.onDidReceiveMessage(data => {
			if (data.type === "ready") {
				webviewView.show();
				this.refreshParsedData();
			}
		});

		// Once the view is disposed of we don't want to keep a reference to it anymore
		this._view.onDidDispose(() => (this._view = undefined));
	}

	/**
	 * Load a KSY template file
	 */
	public async loadKsyFile(ksyPath: string): Promise<void> {
		try {
			await this._parser.loadKsyFile(ksyPath);
			this._currentKsyPath = ksyPath;
			vscode.window.showInformationMessage(`Kaitai template loaded: ${ksyPath}`);
			await this.refreshParsedData();
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to load Kaitai template: ${error}`);
		}
	}

	/**
	 * Refresh the parsed data display
	 */
	private async refreshParsedData(): Promise<void> {
		if (!this._view || !this._currentKsyPath) {
			return;
		}

		const doc = this.registry.activeDocument;
		if (!doc) {
			this._view.webview.postMessage({
				type: "clear",
			});
			return;
		}

		try {
			// Get the current document data
			const data = await doc.readBufferWithEdits(0, 10000); // Limit to first 10KB for performance
			if (!data) {
				return;
			}

			// Parse with the loaded template
			const parsers = this._parser.getLoadedParsers();
			if (parsers.length === 0) {
				return;
			}

			const parsedData = await this._parser.parseData(data, parsers[0]);

			// Send parsed data to the webview
			this._view.webview.postMessage({
				type: "update",
				data: parsedData,
			});
		} catch (error) {
			this._view.webview.postMessage({
				type: "error",
				message: String(error),
			});
		}
	}

	private _getWebviewHTML(webview: vscode.Webview): string {
		const nonce = randomString();
		return `<!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8">
              <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <style>
                body {
                  padding: 10px;
                  font-family: var(--vscode-font-family);
                  font-size: var(--vscode-font-size);
                  color: var(--vscode-foreground);
                }
                .no-template {
                  color: var(--vscode-descriptionForeground);
                  font-style: italic;
                  padding: 20px;
                  text-align: center;
                }
                .tree {
                  list-style: none;
                  padding-left: 0;
                  margin: 0;
                }
                .tree ul {
                  list-style: none;
                  padding-left: 20px;
                  margin: 0;
                }
                .tree-item {
                  padding: 4px 0;
                  cursor: default;
                }
                .field-name {
                  font-weight: bold;
                  color: var(--vscode-symbolIcon-fieldForeground);
                }
                .field-value {
                  color: var(--vscode-foreground);
                  margin-left: 8px;
                }
                .field-type {
                  color: var(--vscode-descriptionForeground);
                  font-size: 0.9em;
                  margin-left: 8px;
                }
                .field-offset {
                  color: var(--vscode-descriptionForeground);
                  font-size: 0.85em;
                  margin-left: 8px;
                }
                .error {
                  color: var(--vscode-errorForeground);
                  padding: 10px;
                }
              </style>
              <title>Kaitai Struct Parser</title>
            </head>
            <body>
              <div id="content">
                <div class="no-template">No Kaitai template loaded. Use the "Load Kaitai Template" command to load a .ksy file.</div>
              </div>
              <script nonce="${nonce}">
                const vscode = acquireVsCodeApi();

                function renderField(field) {
                  const item = document.createElement('li');
                  item.className = 'tree-item';
                  
                  const nameSpan = document.createElement('span');
                  nameSpan.className = 'field-name';
                  nameSpan.textContent = field.name;
                  item.appendChild(nameSpan);
                  
                  const valueSpan = document.createElement('span');
                  valueSpan.className = 'field-value';
                  valueSpan.textContent = ': ' + formatValue(field.value);
                  item.appendChild(valueSpan);
                  
                  if (field.type) {
                    const typeSpan = document.createElement('span');
                    typeSpan.className = 'field-type';
                    typeSpan.textContent = '(' + field.type + ')';
                    item.appendChild(typeSpan);
                  }
                  
                  if (field.offset !== undefined) {
                    const offsetSpan = document.createElement('span');
                    offsetSpan.className = 'field-offset';
                    offsetSpan.textContent = '@0x' + field.offset.toString(16).toUpperCase();
                    item.appendChild(offsetSpan);
                  }
                  
                  if (field.children && field.children.length > 0) {
                    const childList = document.createElement('ul');
                    for (const child of field.children) {
                      childList.appendChild(renderField(child));
                    }
                    item.appendChild(childList);
                  }
                  
                  return item;
                }
                
                function formatValue(value) {
                  if (typeof value === 'bigint') {
                    return value.toString();
                  }
                  if (typeof value === 'number') {
                    return value.toString();
                  }
                  if (typeof value === 'string') {
                    return JSON.stringify(value);
                  }
                  return String(value);
                }
                
                window.addEventListener('message', event => {
                  const message = event.data;
                  const content = document.getElementById('content');
                  
                  switch (message.type) {
                    case 'update':
                      if (message.data && message.data.length > 0) {
                        const tree = document.createElement('ul');
                        tree.className = 'tree';
                        for (const field of message.data) {
                          tree.appendChild(renderField(field));
                        }
                        content.innerHTML = '';
                        content.appendChild(tree);
                      } else {
                        content.innerHTML = '<div class="no-template">No data parsed. Make sure a Kaitai template is loaded.</div>';
                      }
                      break;
                    case 'clear':
                      content.innerHTML = '<div class="no-template">No file opened.</div>';
                      break;
                    case 'error':
                      content.innerHTML = '<div class="error">Error: ' + message.message + '</div>';
                      break;
                  }
                });
                
                // Signal ready
                vscode.postMessage({ type: 'ready' });
              </script>
            </body>
            </html>`;
	}
}
