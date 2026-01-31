const vscode = require("vscode");
const io = require('socket.io-client');
const os = require('os');
const path = require('path');

// ============================================================================
// Constants
// ============================================================================

const localDir = ".kineviz-grove";

const ioOptions = {
  path: "/socket.io",
  'pingInterval': 5000,
  'pingTimeout': 15000
};

let socket = null;

// ============================================================================
// Extension Lifecycle
// ============================================================================

/**
 * Called when the extension is activated.
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // Create ~/.grove directory if it doesn't exist
  const homedir = os.homedir();
  const grovePath = vscode.Uri.file(path.join(homedir, localDir));
  vscode.workspace.fs.createDirectory(grovePath);

  context.subscriptions.push(
    vscode.window.registerUriHandler({ handleUri })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(handleDocumentSave)
  );
}

/**
 * Called when the extension is deactivated.
 */
function deactivate() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Handles URI events to open grove files from the server.
 * @param {vscode.Uri} uri - The URI containing query parameters
 */
async function handleUri(uri) {
  const queryParams = new URLSearchParams(uri.query);

  if (!queryParams.has("open")) {
    return;
  }

  const baseUrl = queryParams.get("baseUrl");
  const fileName = queryParams.get("open");
  
  const workspaceEdit = new vscode.WorkspaceEdit();
  
  // Create local file path for storing the grove file
  const localFilePath = createLocalFilePath(baseUrl, fileName);
  const fileUri = vscode.Uri.file(localFilePath);
  
  // Ensure all parent directories exist
  const parentDir = path.dirname(fileUri.fsPath);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(parentDir));

  try {
    // Fetch file contents from server
    const apiKey = getApiKey(baseUrl);
    if (!apiKey) {
      vscode.window.showErrorMessage(`No API key found for ${baseUrl}`);
      return;
    }
    const fetchUrl = `${baseUrl}${fileName}`;
    const response = await fetch(fetchUrl, {
      headers: {
        'x-api-key': apiKey
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const fileContent = await response.json();
    const mdContent = convertGroveToMd(fileContent);

    // Create file
    workspaceEdit.createFile(fileUri, { ignoreIfExists: true });
    await vscode.workspace.applyEdit(workspaceEdit);

    // Write content
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(mdContent, 'utf8'));

    // Open document
    const document = await vscode.workspace.openTextDocument(fileUri);
    await vscode.languages.setTextDocumentLanguage(document, "markdown");
    await vscode.window.showTextDocument(document);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to fetch file: ${error.message}`);
  }
}

/**
 * Handles document save events to upload grove files back to the server.
 * @param {vscode.TextDocument} document - The saved document
 */
async function handleDocumentSave(document) {
  if (!document.fileName.includes(localDir)) {
    return;
  }

  // Parse local file path to get server information
  const { projectId, fileName, baseUrl: graphxrBaseUrl } = parseLocalFilePath(document.fileName);

  // Get api key
  const apiKey = getApiKey(graphxrBaseUrl);
  if (!apiKey) {
    vscode.window.showErrorMessage(`No API key found for ${graphxrBaseUrl}`);
    return;
  }

  // Convert markdown content to Grove JSON format
  const content = document.getText();
  const grovePayload = convertMdToGrove(content);

  // Create form data
  const formData = new FormData();
  formData.append("fileName", fileName);
  formData.append("projectId", projectId);
  formData.append(
    "data",
    new Blob(
      [JSON.stringify(grovePayload)],
      { type: "text/plain" }
    )
  );

  try {
    const simpleUploadUrl = `${graphxrBaseUrl}/api/grove/simpleUploadFile`;
    const response = await fetch(
      simpleUploadUrl,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "x-api-key": apiKey,
        },
        body: formData,
      }
    );

    await response.text();

    // Use WebSocket for reload
    socket = connectSocket(graphxrBaseUrl);
    socket.emit('requestReload', { fileName, projectId });
  } catch (error) {
    vscode.window.showErrorMessage(`Upload failed: ${error.message}`);
  }
}

// ============================================================================
// Socket Management
// ============================================================================

function connectSocket(baseUrl) {
  if (!socket) {
    const socketUrl = `${baseUrl}/groveHotReload/`;
    socket = io(socketUrl, ioOptions);
    socket.on('reloadResult', handleReloadResult);
    socket.on('reloadError', handleReloadError);
  }
  return socket;
}

/**
 * Handles socket reload result events.
 * @param {object} result - The reload result from the server
 */
function handleReloadResult(result) {
  if (!result.success) {
    vscode.window.showErrorMessage(`Reload failed: ${result.message}`);
  }
}

/**
 * Handles socket reload error events.
 * @param {object} error - The error from the server
 */
function handleReloadError(error) {
  vscode.window.showErrorMessage(`Reload error: ${error.message}`);
}

// ============================================================================
// Format Conversion
// ============================================================================

/**
 * Converts Grove JSON format to Markdown for editing in VS Code.
 * @param {object} grove - The grove file content with blocks array
 * @returns {string} - Markdown string representation
 */
function convertGroveToMd(grove) {
  const blocks = grove.blocks;
  const mdBlocks = blocks.map((block) => {
    if (block.type === "codeTool") {
      const {
        pinCode,
        dname,
        codeMode,
        hide,
        value,
      } = block.data.codeData;
      const cellOptions = {
        pinCode,
        dname,
        codeMode,
        hide,
      }
      const cellOptionsStr = `<!--${JSON.stringify(cellOptions)}-->`;
      return `${cellOptionsStr}\n\`\`\`${convertCodeModeToMd(codeMode)}\n${value}\n\`\`\``;
    }
    return block.data.text;
  });
  return mdBlocks.join("\n\n");
}

/**
 * Converts Markdown content back to Grove JSON format for uploading to the server.
 * @param {string} mdContent - The markdown content
 * @returns {object} - Grove format object with blocks array and version
 */
function convertMdToGrove(mdContent) {
  const codeBlockRegex = /(?:<!--(.*)-->\n)?```(\w+)?\n([\s\S]*?)```/g;
  const blocks = [];
  let match;

  while ((match = codeBlockRegex.exec(mdContent)) !== null) {
    const cellOptionsStr = match[1];
    const codeContent = match[3].trim();
    let cellOptions = {};
    
    if (cellOptionsStr) {
      try {
        cellOptions = JSON.parse(cellOptionsStr);
      } catch (parseError) {
        // Ignore parse errors for cell options
      }
    }

    const block = {
      type: "codeTool",
      data: {
        codeData: {
          value: codeContent,
          pinCode: cellOptions.pinCode ?? false,
          dname: cellOptions.dname ?? crypto.randomUUID(),
          codeMode: convertCodeModeMdToGrove(match[2]) || cellOptions.codeMode || "javascript2",
          hide: cellOptions.hide ?? false,
        },
      },
    };
    blocks.push(block);
  }
  
  return {
    blocks: blocks,
    version: "2.19.1",
  };
}

/**
 * Convert Grove code mode to markdown language tag for syntax highlighting.
 */
function convertCodeModeToMd(codeMode) {
  switch (codeMode) {
    case "javascript2":
      return "js";
    default:
      return codeMode;
  }
}

/**
 * Convert markdown language tag back to Grove code mode.
 */
function convertCodeModeMdToGrove(codeMode) {
  switch (codeMode) {
    case "js":
      return "javascript2";
    default:
      return codeMode;
  }
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Creates a local file path for storing a grove file downloaded from the server.
 * @param {string} baseUrl - The base URL (e.g., "https://graphxr.kineviz.com")
 * @param {string} fileName - The server file path (e.g., "/api/grove/file/...")
 * @returns {string} - The local file path with .grove extension
 */
function createLocalFilePath(baseUrl, fileName) {
  const [protocol, host] = baseUrl.split("://");
  const homedir = os.homedir();
  const localFilePath = path.join(homedir, localDir, protocol, host, ...fileName.split('/')) + '.grove';
  return localFilePath;
}

/**
 * Parses a local file path to extract server information for uploading.
 * @param {string} localFilePath - The local file path
 * @returns {{protocol: string, host: string, projectId: string, fileName: string, baseUrl: string}} - Parsed components
 */
function parseLocalFilePath(localFilePath) {
  const splitPath = localFilePath.split(path.sep);
  const groveIndex = splitPath.indexOf(".kineviz-grove");
  const protocol = splitPath[groveIndex + 1];
  const host = splitPath[groveIndex + 2];
  const projectId = splitPath[groveIndex + 6];
  // Use forward slash for URL paths (server-side expects forward slashes)
  const fileName = splitPath.slice(groveIndex + 7).join("/").replace(".grove", "");
  const baseUrl = `${protocol}://${host}`;
  return { protocol, host, projectId, fileName, baseUrl };
}

// ============================================================================
// Configuration
// ============================================================================

function getApiKey(origin) {
  const config = vscode.workspace.getConfiguration('grovebook');
  const apiKeys = config.get('apiKeys');
  return apiKeys?.[origin];
}

// ============================================================================
// Module Exports
// ============================================================================

module.exports = {
  activate,
  deactivate,
};
