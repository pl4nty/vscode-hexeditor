A custom editor extension for Visual Studio Code which provides a hex editor for viewing and manipulating files in their raw hexadecimal representation.

## Features

- Opening files as hex
- A data inspector for viewing the hex values as various different data types
- Editing with undo, redo, copy, and paste support
- Find and replace
- Browsing file structure with [Kaitai Struct](https://kaitai.io) templates (experimental)

![User opens a text file named release.txt and switches to the hex editor via command palette. The user then navigates and edits the document](https://raw.githubusercontent.com/microsoft/vscode-hexeditor/main/hex-editor.gif)

## How to Use

There are three ways to open a file in the hex editor:

1. Right click a file -> Open With -> Hex Editor
2. Trigger the command palette (<kbd>F1</kbd>) -> Open File using Hex Editor
3. Trigger the command palette (<kbd>F1</kbd>) -> Reopen With -> Hex Editor

The hex editor can be set as the default editor for certain file types by using the `workbench.editorAssociations` setting. For example, this would associate all files with extensions `.hex` and `.ini` to use the hex editor by default:

```json
"workbench.editorAssociations": {
    "*.hex": "hexEditor.hexedit",
    "*.ini": "hexEditor.hexedit"
},
```

## Configuring the Data Inspector

By default, the data inspector is shown just to the right of the data grid (or decoded text if enabled), but it can be configured (via the `hexeditor.inspectorType` setting) to instead show up while hovering over a data cell.

Another option is to give the data inspector a dedicated activity bar entry on the left (by setting `hexeditor.inspectorType` to `sidebar`) that appears when the hex editor is opened, causing the explorer or whatever sidebar you had opened to be hidden. If preferred, the hex editor view can be dragged into another view by dragging the ⬡ icon onto one of the other views. This can be used in combination with the `hexeditor.dataInspector.autoReveal` setting to avoid revealing the sidebar containing the data inspector altogether.

## Structure Templates (Experimental)

The **Hex Structure** view in the Explorer shows the open file parsed with a [Kaitai Struct](https://kaitai.io) template (`.ksy`). Templates for many formats are in the [format gallery](https://formats.kaitai.io). To load one, use the folder button in the view, or right-click a `.ksy` file and select **Load Kaitai Struct Template...**.

- Select a field to select its bytes in the editor. Move the cursor in the editor to reveal the field that contains it.
- The tree updates as you edit the file, and when the template file changes.
- A template is applied automatically to other files that match its `meta/file-extension`.
- Imports resolve relative to the template. Absolute imports (such as `/common/vlq_base128_le`) are searched for in the template's parent directories, so templates work from a checkout of the format gallery.

## Known Issues

To track existing issues or report a new one, please visit the GitHub Issues page at https://github.com/microsoft/vscode-hexeditor/issues
