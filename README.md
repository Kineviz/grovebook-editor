# grovebook-editor README

Edit Grovebook files in VSCode.

## Features

- Open Grovebook files in VSCode

## Requirements

- Grove installed on a GraphXR server
- API Key for the GraphXR server

## Extension Settings

This extension contributes the following settings:

* `grovebook.apiKeys`: Map of GraphXR server origins to their corresponding API keys. For example:
  ```json
  {
    "https://my-graphxr-server.com": "my-api-key",
    "https://another-server.com": "another-api-key"
  }
  ```

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (version 20.x recommended)
- [VS Code](https://code.visualstudio.com/)

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/kineviz/grovebook-editor.git
   cd grovebook-editor
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

### Running the Extension Locally

1. Open the project in VS Code
2. Press `F5` to launch a new VS Code window with the extension loaded (or use **Run > Start Debugging**)
3. The extension will be active in the new "Extension Development Host" window
4. Make changes to `extension.js` and reload the window (`Cmd+R` / `Ctrl+R`) to test

### Available Scripts

- `npm run lint` - Run ESLint to check for code issues
- `npm test` - Run the test suite

### Debugging

The project includes a VS Code launch configuration. Set breakpoints in `extension.js` and press `F5` to debug.

## Known Issues

- None

## Contributing

Update version in package.json
Get a PAT from https://dev.azure.com/
vsce package
vsce publish

## Release Notes

### 1.0.0

Initial release of Grovebook Editor.

### 1.0.1

- Fixed the API Key

### 1.1.0

- Open file with markdown language for appropriate syntax highlighting

### 1.2.1

- Save to ~/.kineviz-grove

### 1.2.3

- Preserving hide flag

### 1.2.4

- Experimental change to enable Windows support