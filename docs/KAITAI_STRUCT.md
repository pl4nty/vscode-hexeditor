# Kaitai Struct Integration

This document describes the Kaitai Struct binary template parsing feature in the VS Code Hex Editor.

## Overview

The Hex Editor now supports parsing binary files using [Kaitai Struct](https://kaitai.io/) templates (.ksy files). This allows you to define the structure of binary files and view them in a parsed, structured format alongside the raw hex data.

## Features

- Load `.ksy` (Kaitai Struct YAML) template files
- Parse binary data according to the template definition
- Display parsed structure in a tree view
- Show field names, values, types, and byte offsets
- Support for common data types (integers, floats, strings, etc.)

## Usage

### Loading a Kaitai Template

1. Open a binary file in the Hex Editor
2. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
3. Run the command: **"Hex Editor: Load Kaitai Template"**
4. Select a `.ksy` template file
5. The parsed structure will appear in the "Kaitai Struct Parser" view

### Creating Kaitai Templates

Kaitai Struct templates are YAML files that define the structure of binary data. Here's a simple example:

```yaml
meta:
  id: simple_header
  title: Simple binary file header
  endian: le
seq:
  - id: magic
    type: u4
    doc: Magic number
  - id: version
    type: u2
    doc: Version number
  - id: flags
    type: u1
    doc: Flags byte
  - id: reserved
    type: u1
    doc: Reserved byte
  - id: data_size
    type: u4
    doc: Size of following data
```

For more information on creating Kaitai templates, see:
- [Kaitai Struct User Guide](https://doc.kaitai.io/user_guide.html)
- [Kaitai Struct Format Gallery](https://formats.kaitai.io/) - Pre-made templates for common file formats

## Supported Data Types

The Kaitai parser currently supports:
- Unsigned integers: `u1`, `u2`, `u4`, `u8` (with `le`/`be` endian variants)
- Signed integers: `s1`, `s2`, `s4`, `s8` (with `le`/`be` endian variants)
- Floating point: `f4`, `f8` (with `le`/`be` endian variants)
- Strings: `str`, `strz`
- Custom types (basic support)

## Limitations

- **Desktop Only**: This feature is only available in VS Code Desktop (not in web/browser environments) due to Node.js dependencies
- **Performance Limit**: The parser currently reads only the first 10KB of the file for performance reasons
- **Implementation Approach**: This is a simplified implementation that manually interprets KSY format rather than using the full Kaitai compiler. This means:
  - Only basic types are supported (integers, floats, strings)
  - Advanced features (instances, enums, conditionals, custom types, expressions) are not supported
  - A full implementation would compile .ksy to JavaScript and dynamically load the parser
- **Read-Only**: This is a read-only parser - you cannot edit the binary file through the parsed view
- **String Safety**: Null-terminated strings are limited to 1000 characters for safety

## Example

To test the feature:

1. Create a simple binary file with a header
2. Create a `.ksy` template that matches your file structure
3. Open the binary file in the Hex Editor
4. Load your `.ksy` template using the command
5. View the parsed structure in the Kaitai Struct Parser panel

## Troubleshooting

**"Kaitai Struct parsing is not available in this environment"**
- This feature requires VS Code Desktop and will not work in browser-based VS Code

**"Failed to load Kaitai template"**
- Ensure your `.ksy` file is valid YAML
- Check that the template structure matches the Kaitai Struct specification

**"Failed to parse data"**
- Verify that your template matches the structure of your binary file
- Check that the file has enough bytes for the fields defined in your template
