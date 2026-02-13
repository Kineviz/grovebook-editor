# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.5] - 2025-02-13

### Changed

- (No user-facing changes in this release)

## [2.0.4] - 2025-02-13

### Deprecated

- **Old Grovebook .grove extension JSON format**: The legacy JSON format used by Grove servers < 2.0.0 is deprecated. Please upgrade to Grove >= 2.0.0 for markdown support. The extension will continue to support legacy servers for backward compatibility, but this support may be removed in a future release.

## [2.0.3]

### Changed

- (See README Release Notes for details)

## [2.0.2]

### Changed

- (See README Release Notes for details)

## [2.0.1]

### Added

- **Backup on download**: When a grovebook is downloaded from the server, a timestamped backup is automatically saved in a `backups` folder next to the file.

### Changed

- **Auto-sync off by default**: The `grovebook.autoSync` setting now defaults to `false`.

### Fixed

- Status bar now correctly shows "Modified" when there are unsaved changes, even when auto-sync is disabled. Switching to a grove tab with unsaved changes also updates the status immediately.

## [2.0.0]

### Added

- **Markdown support**: Files are now stored as markdown on Grove >= 2.0.0 servers
- **Extension icon**: Added an icon for the extension
- **Package script**: Added `npm run package` command for building the extension

### Changed

- **Backward compatibility**: Automatically detects Grove server version and uses legacy JSON format for servers < 2.0.0
- **Improved Grove-to-Markdown conversion**: Now properly handles header and paragraph block types when downloading files
