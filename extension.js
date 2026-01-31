const vscode = require("vscode");
const io = require("socket.io-client");
const os = require("os");
const path = require("path");

// ============================================================================
// Constants
// ============================================================================

const EXTENSION_WORKING_DIR = ".kineviz-grove";

const ioOptions = {
  path: "/socket.io",
  pingInterval: 5000,
  pingTimeout: 15000,
};

const sockets = new Map(); // baseUrl -> socket
let outputChannel = null;

// ============================================================================
// Tracing
// ============================================================================

function getOutputChannel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Grovebook Hot Reload");
  }
  return outputChannel;
}

function isTracingEnabled() {
  const config = vscode.workspace.getConfiguration("grovebook");
  return config.get("enableTracing", false);
}

function trace(message, data = null) {
  if (!isTracingEnabled()) {
    return;
  }
  const channel = getOutputChannel();
  const timestamp = new Date().toISOString();
  if (data) {
    channel.appendLine(`[${timestamp}] ${message}: ${JSON.stringify(data)}`);
  } else {
    channel.appendLine(`[${timestamp}] ${message}`);
  }
  channel.show(true); // Show the output channel, preserving focus
}

// ============================================================================
// Extension Lifecycle
// ============================================================================

/**
 * Called when the extension is activated.
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  trace("Grovebook extension activated");

  // Create working directory if it doesn't exist
  const homedir = os.homedir();
  const workingDir = vscode.Uri.file(path.join(homedir, EXTENSION_WORKING_DIR));
  await vscode.workspace.fs.createDirectory(workingDir);

  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }));

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(handleDocumentSave),
  );
}

/**
 * Called when the extension is deactivated.
 */
function deactivate() {
  if (sockets.size > 0) {
    trace("Deactivating extension, disconnecting sockets", { count: sockets.size });
    for (const [baseUrl, socket] of sockets) {
      trace("Disconnecting socket", { baseUrl });
      socket.disconnect();
    }
    sockets.clear();
  }
  if (outputChannel) {
    outputChannel.dispose();
    outputChannel = null;
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
  // e.g. ?baseUrl=http://localhost:3001
  const filePath = queryParams.get("open");

  const workspaceEdit = new vscode.WorkspaceEdit();

  // Create local file path for storing the grove file
  const localFilePath = createLocalFilePath(baseUrl, filePath);
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
    const fetchUrl = `${baseUrl}${filePath}`;
    const response = await fetch(fetchUrl, {
      headers: {
        "x-api-key": apiKey,
      },
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
    await vscode.workspace.fs.writeFile(
      fileUri,
      Buffer.from(mdContent, "utf8"),
    );

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
  if (!document.fileName.includes(EXTENSION_WORKING_DIR)) {
    return;
  }

  trace("Document saved", { fileName: document.fileName });

  // Parse local file path to get server information
  const {
    projectId,
    fileName,
    baseUrl: graphxrBaseUrl,
  } = parseLocalFilePath(document.fileName);

  trace("Parsed file path", { projectId, fileName, baseUrl: graphxrBaseUrl });

  // Get api key
  const apiKey = getApiKey(graphxrBaseUrl);
  if (!apiKey) {
    trace("No API key found", { baseUrl: graphxrBaseUrl });
    vscode.window.showErrorMessage(`No API key found for ${graphxrBaseUrl}`);
    return;
  }

  // Convert markdown content to Grove JSON format
  const content = document.getText();
  const grovePayload = convertMdToGrove(content);

  trace("Converted to Grove format", { blockCount: grovePayload.blocks.length });

  // Create form data
  const formData = new FormData();
  formData.append("fileName", fileName);
  formData.append("projectId", projectId);
  formData.append(
    "data",
    new Blob([JSON.stringify(grovePayload)], { type: "text/plain" }),
  );

  try {
    const simpleUploadUrl = `${graphxrBaseUrl}/api/grove/simpleUploadFile`;
    trace("Uploading file", { url: simpleUploadUrl });

    const response = await fetch(simpleUploadUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "x-api-key": apiKey,
      },
      body: formData,
    });

    const responseText = await response.text();
    trace("Upload response", { status: response.status, body: responseText });

    if (!response.ok) {
      throw new Error(`Upload failed with status ${response.status}: ${responseText}`);
    }

    // Use WebSocket for reload
    const socket = connectSocket(graphxrBaseUrl);
    trace("Emitting requestReload", { fileName, projectId });
    socket.emit("requestReload", { fileName, projectId });

    vscode.window.showInformationMessage(`Grovebook saved: ${fileName}`);
  } catch (error) {
    trace("Upload failed", { error: error.message });
    vscode.window.showErrorMessage(`Upload failed: ${error.message}`);
  }
}

// ============================================================================
// Socket Management
// ============================================================================

function connectSocket(baseUrl) {
  if (sockets.has(baseUrl)) {
    return sockets.get(baseUrl);
  }

  const socketUrl = `${baseUrl}/groveHotReload/`;
  trace("Connecting to socket", { url: socketUrl });
  const socket = io(socketUrl, ioOptions);

  socket.on("connect", () => {
    trace("Socket connected", { id: socket.id, baseUrl });
  });

  socket.on("disconnect", (reason) => {
    trace("Socket disconnected", { reason, baseUrl });
    sockets.delete(baseUrl);
  });

  socket.on("connect_error", (error) => {
    trace("Socket connection error", { error: error.message, baseUrl });
  });

  socket.on("reloadResult", handleReloadResult);
  socket.on("reloadError", handleReloadError);

  sockets.set(baseUrl, socket);
  return socket;
}

/**
 * Handles socket reload result events.
 * @param {object} result - The reload result from the server
 */
function handleReloadResult(result) {
  trace("Reload result received", result);
  if (!result.success) {
    vscode.window.showErrorMessage(`Reload failed: ${result.message}`);
  }
}

/**
 * Handles socket reload error events.
 * @param {object} error - The error from the server
 */
function handleReloadError(error) {
  trace("Reload error received", { error: error.message });
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
      const { pinCode, dname, codeMode, hide, value } = block.data.codeData;
      const cellOptions = {
        pinCode,
        dname,
        codeMode,
        hide,
      };
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
          codeMode:
            convertCodeModeMdToGrove(match[2]) ||
            cellOptions.codeMode ||
            "javascript2",
          hide: cellOptions.hide ?? false,
        },
      },
    };
    blocks.push(block);
  }

  return {
    blocks: blocks,
    // TODO: Why do we need to specify the version? And why is it hardcoded?
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
function createLocalFilePath(baseUrl, filePath) {
  const localFilePath =
    path.join(
      os.homedir(),
      EXTENSION_WORKING_DIR,
      encodeBaseUrl(baseUrl),
      encodeFilePath(filePath),
    )
  return localFilePath;
}

// Converts a baseUrl into a cross-platform (filesystem-safe) folder name
// e.g. http://origin:3000 -> http__origin_3000
//      https://dev.graphxr.kineviz.com -> https__dev.graphxr.kineviz.com
function encodeBaseUrl(baseUrl) {
  return baseUrl.replace("://", "__").replace(/:/g, "_");
}

function decodeBaseUrl(encodedBaseUrl) {
  return encodedBaseUrl.replace("__", "://").replace(/_/g, ":");
}

function encodeFilePath(filePath) {
  return filePath.replaceAll("/", "__");
}

function decodeFilePath(encodedFilePath) {
  return encodedFilePath.replaceAll("__", "/");
}

/**
 * Parses a local file path to extract server information for uploading.
 * @param {string} localFilePath - The local file path
 * @returns {{projectId: string, fileName: string, baseUrl: string}} - Parsed components
 */
function parseLocalFilePath(localFilePath) {
  const splitPath = localFilePath.split(path.sep);
  const groveIndex = splitPath.indexOf(EXTENSION_WORKING_DIR);

  // groveIndex + 1 is the encoded baseUrl (e.g., "https__graphxr.kineviz.com")
  const encodedBaseUrl = splitPath[groveIndex + 1];
  const baseUrl = decodeBaseUrl(encodedBaseUrl);

  // Everything from groveIndex + 2 onwards is the encoded filePath
  const encodedFilePath = splitPath.slice(groveIndex + 2).join("/");
  const filePath = decodeFilePath(encodedFilePath);

  // Parse the filePath to extract projectId and fileName
  // filePath is like "/api/grove/file/{projectId}/{fileName}"
  const filePathParts = filePath.split("/");
  const projectId = filePathParts[4];
  const fileName = filePathParts.slice(5).join("/");

  return { projectId, fileName, baseUrl };
}

// ============================================================================
// Configuration
// ============================================================================

function getApiKey(origin) {
  const config = vscode.workspace.getConfiguration("grovebook");
  const apiKeys = config.get("apiKeys");
  return apiKeys?.[origin];
}

// ============================================================================
// Module Exports
// ============================================================================

module.exports = {
  activate,
  deactivate,
};
