# grovebook-editor README

Edit Grovebook files in VSCode.

## Features

- Open Grovebook files in VSCode
- Automatically opens a dedicated workspace (`~/.kineviz-grove`) when editing grovebooks, keeping all your grove files organized in one place
- **Auto-sync**: Changes are automatically synced to the remote server after 1.5 seconds of inactivity (works with Cursor Agent and other tools that modify files)
- **Status bar indicator**: Shows sync status (Synced/Modified/Syncing) when editing grovebook files

## Requirements

- Grove installed on a GraphXR server
- API Key for the GraphXR server

## Extension Settings

This extension contributes the following settings:

* `grovebook.autoSync`: Automatically sync changes to the remote server after a short delay (1.5s). This enables seamless editing with Cursor Agent and other tools. Default: `false`
* `grovebook.enableTracing`: Enable verbose logging to the "Grovebook Hot Reload" output channel. Useful for debugging connection issues. Default: `false`

## API Key Management

API keys are stored securely using your operating system's credential storage:
- **macOS**: Keychain
- **Windows**: Credential Manager
- **Linux**: libsecret

### Commands

Use the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) to access these commands:

* **Grovebook: Set API Key** - Add or update an API key for a GraphXR server
* **Grovebook: Delete API Key** - Remove a stored API key
* **Grovebook: List API Keys** - View options for managing API keys

### Migration from Previous Versions

If you previously stored API keys in `settings.json` via `grovebook.apiKeys`, they will be automatically migrated to secure storage on first launch. The old keys in `settings.json` will be cleared after migration.

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

**Runtime logging:** Enable the `grovebook.enableTracing` setting to see verbose logs in the "Grovebook Hot Reload" output channel (View > Output, then select "Grovebook Hot Reload" from the dropdown).

## Known Issues

- None

## Releasing a New Version

1. Update the version in `package.json`
2. Update the Release Notes section below
3. Install vsce if needed: `npm install -g @vscode/vsce`
4. Get a Personal Access Token from https://dev.azure.com/ (needs Marketplace > Manage scope)
5. Package and publish:
   ```bash
   vsce package
   vsce publish
   ```

## Release Notes

### 2.0.3

- Empty

### 2.0.2

- Empty

### 2.0.1

- **Backup on download**: When a grovebook is downloaded from the server, a timestamped backup is automatically saved in a `backups` folder next to the file (e.g. `~/.kineviz-grove/.../backups/<filename>-<timestamp>.md`).
- **Auto-sync off by default**: The `grovebook.autoSync` setting now defaults to `false`. Enable it in settings to automatically sync changes to the remote server after editing.
- **Fixed**: Status bar now correctly shows "Modified" when there are unsaved changes, even when auto-sync is disabled. Switching to a grove tab with unsaved changes also updates the status immediately.

### 2.0.0

- **Markdown support**: Files are now stored as markdown on Grove >= 2.0.0 servers, enabling better editing with syntax highlighting for headers, paragraphs, and code blocks
- **Backward compatibility**: Automatically detects Grove server version and uses legacy JSON format for servers < 2.0.0
- **Improved Grove-to-Markdown conversion**: Now properly handles header and paragraph block types when downloading files
- **Extension icon**: Added an icon for the extension
- **Package script**: Added `npm run package` command for building the extension

### 1.6.1

- **Windows fix**: Fixed path comparison issues on Windows where drive letter casing differences (e.g., `c:\` vs `C:\`) caused the extension to fail to recognize the working directory

### 1.6.0

- **Auto-sync**: Changes are now automatically synced to the remote server after 1.5 seconds of inactivity, enabling seamless editing with Cursor Agent and other tools that modify files without triggering manual save
- **Status bar indicator**: Added a status bar item that shows sync status (Synced/Modified/Syncing) when editing grovebook files
- Added `grovebook.autoSync` setting to enable/disable auto-sync (default: enabled)

### 1.5.5

- Fixed: Opening a grovebook via URL now reliably opens the file when the correct workspace window is already open but not focused

### 1.5.2

- Fixed: Opening multiple grovebooks now opens each in a new tab instead of replacing the existing tab

### 1.5.1

- Fixed: Opening a grovebook now opens in a new window instead of replacing the current workspace

### 1.5.0

- Automatically opens the `~/.kineviz-grove` workspace when opening a grovebook via URI, keeping all grove files organized in one dedicated workspace

### 1.4.0

- **Security**: API keys are now stored securely using the OS credential manager (Keychain/Credential Manager/libsecret) instead of plain text in settings.json
- Added commands: "Grovebook: Set API Key", "Grovebook: Delete API Key", "Grovebook: List API Keys"
- Automatic one-time migration of existing API keys from settings to secure storage

### 1.3.0

- Reworked local file path creation to support Windows
- Added success feedback message when saving grovebooks
- Fixed socket memory leak on disconnect
- Improved documentation

### 1.2.4

- Experimental change to enable Windows support

### 1.2.3

- Preserving hide flag

### 1.2.1

- Save to ~/.kineviz-grove

### 1.1.0

- Open file with markdown language for appropriate syntax highlighting

### 1.0.1

- Fixed the API Key

### 1.0.0

Initial release of Grovebook Editor.