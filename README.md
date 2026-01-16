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

## Known Issues

- None

## Contributing

Update version in package.json
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