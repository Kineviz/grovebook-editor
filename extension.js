const vscode = require("vscode");
const io = require("socket.io-client");
const os = require("os");
const path = require("path");

// ============================================================================
// Constants
// ============================================================================

const EXTENSION_WORKING_DIR = ".kineviz-grove";
const API_KEY_PREFIX = "apiKey:";
const MIGRATION_COMPLETE_KEY = "apiKeysMigrated";
const PENDING_FILE_KEY = "pendingFileToOpen";

const ioOptions = {
  path: "/socket.io",
  pingInterval: 5000,
  pingTimeout: 15000,
};

const sockets = new Map(); // baseUrl -> socket
const groveVersionCache = new Map(); // baseUrl -> version string
let outputChannel = null;
/** @type {vscode.ExtensionContext} */
let extensionContext = null;

// Auto-sync state
/** @type {vscode.StatusBarItem} */
let statusBarItem = null;
const lastSyncedContent = new Map(); // uri -> content
const changeDebounceTimers = new Map(); // uri -> timer
const DEBOUNCE_MS = 1500; // Wait 1.5s after last change before auto-save

// Sync status states
const SyncStatus = {
  SYNCED: "synced",
  MODIFIED: "modified",
  SYNCING: "syncing",
};

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
// Status Bar Management
// ============================================================================

/**
 * Creates and initializes the status bar item.
 * @param {vscode.ExtensionContext} context
 */
function createStatusBar(context) {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.name = "Grovebook Sync Status";
  context.subscriptions.push(statusBarItem);
  updateStatusBar(SyncStatus.SYNCED);
}

/**
 * Updates the status bar with the current sync state.
 * @param {string} status - One of SyncStatus values
 */
function updateStatusBar(status) {
  if (!statusBarItem) return;

  switch (status) {
    case SyncStatus.SYNCED:
      statusBarItem.text = "$(check) Grovebook: Synced";
      statusBarItem.tooltip = "Local content matches remote";
      statusBarItem.backgroundColor = undefined;
      break;
    case SyncStatus.MODIFIED:
      statusBarItem.text = "$(cloud-upload) Grovebook: Modified";
      statusBarItem.tooltip = "Local changes pending sync";
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      break;
    case SyncStatus.SYNCING:
      statusBarItem.text = "$(sync~spin) Grovebook: Syncing...";
      statusBarItem.tooltip = "Uploading changes to remote";
      statusBarItem.backgroundColor = undefined;
      break;
  }
}

/**
 * Returns the sync status for a grove document (content vs last synced).
 * @param {vscode.TextDocument} document
 * @returns {string} SyncStatus.SYNCED or SyncStatus.MODIFIED
 */
function getSyncStatusForDocument(document) {
  const uri = document.uri.toString();
  const currentContent = document.getText();
  const lastContent = lastSyncedContent.get(uri);
  if (lastContent !== undefined && currentContent === lastContent) {
    return SyncStatus.SYNCED;
  }
  return SyncStatus.MODIFIED;
}

/**
 * Shows or hides the status bar based on whether the active document is a grove file.
 * When showing, updates the status (Synced/Modified) to match the active document.
 */
function updateStatusBarVisibility() {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && isGroveDocument(activeEditor.document)) {
    updateStatusBar(getSyncStatusForDocument(activeEditor.document));
    statusBarItem?.show();
  } else {
    statusBarItem?.hide();
  }
}

/**
 * Checks if a document is a grove file in the working directory.
 * @param {vscode.TextDocument} document
 * @returns {boolean}
 */
function isGroveDocument(document) {
  return document.fileName.includes(EXTENSION_WORKING_DIR);
}

/**
 * Checks if auto-sync is enabled in settings.
 * @returns {boolean}
 */
function isAutoSyncEnabled() {
  const config = vscode.workspace.getConfiguration("grovebook");
  return config.get("autoSync", false);
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

  // Store context for secret storage access
  extensionContext = context;

  // Create working directory if it doesn't exist
  const homedir = os.homedir();
  const workingDir = vscode.Uri.file(path.join(homedir, EXTENSION_WORKING_DIR));
  await vscode.workspace.fs.createDirectory(workingDir);

  // Migrate old API keys from settings to secure storage
  await migrateApiKeys(context);

  // Check for pending file to open (from URI redirect)
  await checkAndOpenPendingFile();

  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }));

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(handleDocumentSave),
  );

  // Listen for document changes to enable auto-sync
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(handleDocumentChange),
  );

  // Create status bar for sync status
  createStatusBar(context);

  // Update status bar visibility when active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateStatusBarVisibility),
  );

  // Listen for window focus changes to pick up pending files from other windows
  // This handles the case where another window stored a pending file and focused this window
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(handleWindowStateChange),
  );

  // Register commands for API key management
  context.subscriptions.push(
    vscode.commands.registerCommand("grovebook.setApiKey", handleSetApiKey),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("grovebook.deleteApiKey", handleDeleteApiKey),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("grovebook.listApiKeys", handleListApiKeys),
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
  // Clear debounce timers
  for (const timer of changeDebounceTimers.values()) {
    clearTimeout(timer);
  }
  changeDebounceTimers.clear();
  lastSyncedContent.clear();
  groveVersionCache.clear();
  // Status bar is disposed via context.subscriptions
  statusBarItem = null;
  extensionContext = null;
}

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Checks if we're in the working directory and opens any pending file.
 * This is called on activation and when the window gains focus.
 * @returns {boolean} - True if a pending file was found and opened
 */
async function checkAndOpenPendingFile() {
  const workingDirPath = path.join(os.homedir(), EXTENSION_WORKING_DIR);
  const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Only process pending files if we're in the working directory
  // Use case-insensitive comparison on Windows since paths are case-insensitive
  const normalizedCurrentFolder = currentFolder?.toLowerCase();
  const normalizedWorkingDir = workingDirPath.toLowerCase();
  if (normalizedCurrentFolder !== normalizedWorkingDir) {
    trace("Not in working directory, skipping pending file check", { currentFolder, workingDirPath });
    return false;
  }

  const pendingFile = extensionContext.globalState.get(PENDING_FILE_KEY);
  if (pendingFile) {
    trace("Found pending file to open", pendingFile);
    await extensionContext.globalState.update(PENDING_FILE_KEY, undefined);
    await openGroveFile(pendingFile.baseUrl, pendingFile.filePath);
    return true;
  }
  
  trace("No pending file found");
  return false;
}

/**
 * Helper function to wait for a specified number of milliseconds.
 * @param {number} ms - Milliseconds to wait
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Handles window state changes (focus gained/lost).
 * When this window gains focus and we're in the working directory,
 * check for pending files that another window may have stored.
 * Uses retry logic to handle globalState sync delays between windows.
 * @param {vscode.WindowState} windowState
 */
async function handleWindowStateChange(windowState) {
  if (windowState.focused) {
    trace("Window gained focus, checking for pending files");
    
    // Try immediately first
    let found = await checkAndOpenPendingFile();
    if (found) return;
    
    // Retry with delays to handle globalState sync between windows
    // globalState may not sync instantly between VS Code windows
    const retryDelays = [100, 200, 500];
    for (const delayMs of retryDelays) {
      await delay(delayMs);
      found = await checkAndOpenPendingFile();
      if (found) {
        trace("Found pending file after retry", { delayMs });
        return;
      }
    }
  }
}

/**
 * Handles document change events for auto-sync functionality.
 * Always updates status bar (Modified/Synced); when auto-sync is on, debounces and triggers auto-save.
 * @param {vscode.TextDocumentChangeEvent} event
 */
function handleDocumentChange(event) {
  const document = event.document;

  // Only process grove files
  if (!isGroveDocument(document)) {
    return;
  }

  // Ignore if no actual content changes
  if (event.contentChanges.length === 0) {
    return;
  }

  const uri = document.uri.toString();

  // Always update status bar based on content vs last synced (even when auto-sync is off)
  const currentContent = document.getText();
  const lastContent = lastSyncedContent.get(uri);

  if (lastContent !== undefined && currentContent === lastContent) {
    updateStatusBar(SyncStatus.SYNCED);
  } else {
    updateStatusBar(SyncStatus.MODIFIED);
  }

  // When auto-sync is off, only the status bar was updated; no debounce/auto-save
  if (!isAutoSyncEnabled()) {
    return;
  }

  // Clear existing debounce timer for this file
  if (changeDebounceTimers.has(uri)) {
    clearTimeout(changeDebounceTimers.get(uri));
  }

  // Set new debounce timer
  const timer = setTimeout(() => {
    changeDebounceTimers.delete(uri);
    autoSaveDocument(document);
  }, DEBOUNCE_MS);

  changeDebounceTimers.set(uri, timer);
}

/**
 * Automatically saves a document to trigger the upload workflow.
 * @param {vscode.TextDocument} document
 */
async function autoSaveDocument(document) {
  // Check if document is still open and not already saved
  if (document.isClosed) {
    trace("Document closed before auto-save", { fileName: document.fileName });
    return;
  }

  if (!document.isDirty) {
    trace("Document not dirty, skipping auto-save", { fileName: document.fileName });
    return;
  }

  trace("Auto-saving document", { fileName: document.fileName });
  
  try {
    await document.save();
  } catch (error) {
    trace("Auto-save failed", { error: error.message });
    vscode.window.showErrorMessage(`Auto-save failed: ${error.message}`);
  }
}

/**
 * Opens a grove file from the server and displays it in the editor.
 * @param {string} baseUrl - The server base URL
 * @param {string} filePath - The file path on the server
 */
async function openGroveFile(baseUrl, filePath) {
  const workspaceEdit = new vscode.WorkspaceEdit();
  const localFilePath = createLocalFilePath(baseUrl, filePath);
  const fileUri = vscode.Uri.file(localFilePath);

  const parentDir = path.dirname(fileUri.fsPath);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(parentDir));

  try {
    const apiKey = await getApiKey(baseUrl);
    if (!apiKey) {
      vscode.window.showErrorMessage(`No API key found for ${baseUrl}. Use "Grovebook: Set API Key" command to add one.`);
      return;
    }
    const fetchUrl = `${baseUrl}${filePath}`;
    const response = await fetch(fetchUrl, {
      headers: { "x-api-key": apiKey },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Detect if content is already markdown or needs conversion from Grove JSON
    const fileContentStr = await response.text();
    let mdContent;

    try {
      const fileContent = JSON.parse(fileContentStr);
      // If it's valid JSON with a blocks array, convert Grove to markdown
      if (fileContent && fileContent.blocks) {
        trace("Downloaded Grove JSON, converting to markdown");
        mdContent = convertGroveToMd(fileContent);
      } else {
        // Valid JSON but not Grove format - treat as raw content
        trace("Downloaded JSON without blocks, using as-is");
        mdContent = fileContentStr;
      }
    } catch (e) {
      // Not JSON - already markdown, use directly
      trace("Downloaded content is not JSON, using as markdown");
      mdContent = fileContentStr;
    }

    workspaceEdit.createFile(fileUri, { ignoreIfExists: true });
    await vscode.workspace.applyEdit(workspaceEdit);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(mdContent, "utf8"));

    // Always save a timestamped backup when a grovebook is downloaded
    const backupDir = path.join(parentDir, "backups");
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(backupDir));
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupBasename = `${path.basename(localFilePath)}-${timestamp}.md`;
    const backupUri = vscode.Uri.file(path.join(backupDir, backupBasename));
    await vscode.workspace.fs.writeFile(backupUri, Buffer.from(mdContent, "utf8"));
    trace("Saved backup", { path: backupUri.fsPath });

    const document = await vscode.workspace.openTextDocument(fileUri);
    await vscode.languages.setTextDocumentLanguage(document, "markdown");
    await vscode.window.showTextDocument(document, { preview: false });

    // Initialize synced content tracking
    lastSyncedContent.set(document.uri.toString(), mdContent);
    updateStatusBar(SyncStatus.SYNCED);
    updateStatusBarVisibility();
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to fetch file: ${error.message}`);
  }
}

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
  const filePath = queryParams.get("open");
  const isRetry = queryParams.get("retry") === "1";

  // Check if we're in the working directory workspace
  const workingDirPath = path.join(os.homedir(), EXTENSION_WORKING_DIR);
  const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Use case-insensitive comparison on Windows since paths are case-insensitive
  const normalizedCurrentFolder = currentFolder?.toLowerCase();
  const normalizedWorkingDir = workingDirPath.toLowerCase();
  if (normalizedCurrentFolder !== normalizedWorkingDir) {
    trace("Not in working directory, focusing/opening correct workspace", { currentFolder, workingDirPath, isRetry });
    
    // Store pending file info as a fallback (for onDidChangeWindowState handler)
    await extensionContext.globalState.update(PENDING_FILE_KEY, { baseUrl, filePath });
    
    // Open/focus the working directory workspace
    const workingDir = vscode.Uri.file(workingDirPath);
    await vscode.commands.executeCommand('vscode.openFolder', workingDir, { forceNewWindow: true });
    
    // Only re-trigger URI if this isn't already a retry (prevents infinite loops)
    if (!isRetry) {
      // Wait for the window focus to change, then re-trigger the URI
      // This ensures the correct window (which is now focused) handles the file open
      await delay(500);
      
      // Re-trigger the URI - this will be handled by whichever window is now focused
      // If the correct workspace window is focused, it will open the file directly
      // Use vscode.env.uriScheme to get the correct scheme (vscode, cursor, vscode-insiders, etc.)
      const uriScheme = vscode.env.uriScheme;
      const extensionUri = vscode.Uri.parse(
        `${uriScheme}://kineviz.grovebook-editor?open=${encodeURIComponent(filePath)}&baseUrl=${encodeURIComponent(baseUrl)}&retry=1`
      );
      trace("Re-triggering URI for focused window", { uri: extensionUri.toString(), uriScheme });
      await vscode.env.openExternal(extensionUri);
    }
    return;
  }

  // Already in working directory, clear any pending file and open directly
  await extensionContext.globalState.update(PENDING_FILE_KEY, undefined);
  await openGroveFile(baseUrl, filePath);
}

/**
 * Handles document save events to upload grove files back to the server.
 * @param {vscode.TextDocument} document - The saved document
 */
async function handleDocumentSave(document) {
  if (!isGroveDocument(document)) {
    return;
  }

  trace("Document saved", { fileName: document.fileName });

  // Update status bar to show syncing
  updateStatusBar(SyncStatus.SYNCING);

  // Parse local file path to get server information
  const {
    projectId,
    fileName,
    baseUrl: graphxrBaseUrl,
  } = parseLocalFilePath(document.fileName);

  trace("Parsed file path", { projectId, fileName, baseUrl: graphxrBaseUrl });

  // Get api key
  const apiKey = await getApiKey(graphxrBaseUrl);
  if (!apiKey) {
    trace("No API key found", { baseUrl: graphxrBaseUrl });
    vscode.window.showErrorMessage(`No API key found for ${graphxrBaseUrl}. Use "Grovebook: Set API Key" command to add one.`);
    updateStatusBar(SyncStatus.MODIFIED);
    return;
  }

  // Get content and determine upload format based on Grove version
  const content = document.getText();
  const groveVersion = await getGroveVersion(graphxrBaseUrl, apiKey);
  const useDirectMarkdown = isVersionAtLeast(groveVersion, "2.0.0");

  trace("Upload format decision", { groveVersion, useDirectMarkdown });

  let contentToUpload;
  if (useDirectMarkdown) {
    contentToUpload = content;
    trace("Using direct markdown upload");
  } else {
    const grovePayload = convertMdToGrove(content);
    trace("Converted to Grove format", { blockCount: grovePayload.blocks.length });
    contentToUpload = JSON.stringify(grovePayload);
  }

  // Create form data
  const formData = new FormData();
  formData.append("fileName", fileName);
  formData.append("projectId", projectId);
  formData.append("data", new Blob([contentToUpload], { type: "text/plain" }));

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

    // Update synced content tracking
    const uri = document.uri.toString();
    lastSyncedContent.set(uri, content);
    
    // Update status bar to synced
    updateStatusBar(SyncStatus.SYNCED);

    vscode.window.showInformationMessage(`Grovebook saved: ${fileName}`);
  } catch (error) {
    trace("Upload failed", { error: error.message });
    vscode.window.showErrorMessage(`Upload failed: ${error.message}`);
    // Revert status bar to modified on failure
    updateStatusBar(SyncStatus.MODIFIED);
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
      const cellOptions = { pinCode, dname, codeMode, hide };
      const cellOptionsStr = `<!--${JSON.stringify(cellOptions)}-->`;
      return `${cellOptionsStr}\n\`\`\`${convertCodeModeToMd(codeMode)}\n${value}\n\`\`\``;
    } else if (block.type === "header") {
      const level = block.data.level;
      const hash = "#".repeat(level);
      return `${hash} ${block.data.text}`;
    } else if (block.type === "paragraph") {
      return block.data.text;
    }
    return block.data.text || "";
  });
  return mdBlocks.filter((x) => x).join("\n\n");
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
// Grove Version Detection
// ============================================================================

/**
 * Fetches and caches the Grove module version from a server.
 * @param {string} baseUrl - The server base URL
 * @param {string} apiKey - The API key for authentication
 * @returns {Promise<string>} - The Grove version (defaults to "1.0.0" if not found)
 */
async function getGroveVersion(baseUrl, apiKey) {
  if (groveVersionCache.has(baseUrl)) {
    return groveVersionCache.get(baseUrl);
  }

  try {
    const response = await fetch(`${baseUrl}/api/tempModule/tempModules`, {
      headers: { "x-api-key": apiKey },
    });
    const data = await response.json();
    const groveModule = data.content?.find((m) => m.name === "Grove");
    const version = groveModule?.version || "1.0.0";

    trace("Fetched Grove version", { baseUrl, version });
    groveVersionCache.set(baseUrl, version);
    return version;
  } catch (error) {
    trace("Failed to fetch Grove version, defaulting to 1.0.0", { error: error.message });
    return "1.0.0";
  }
}

/**
 * Checks if a version is at least the minimum required version.
 * @param {string} version - The version to check (e.g., "2.1.0")
 * @param {string} minVersion - The minimum version required (e.g., "2.0.0")
 * @returns {boolean} - True if version >= minVersion
 */
function isVersionAtLeast(version, minVersion) {
  const v = version.split(".").map(Number);
  const min = minVersion.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((v[i] || 0) > (min[i] || 0)) return true;
    if ((v[i] || 0) < (min[i] || 0)) return false;
  }
  return true;
}

// ============================================================================
// API Key Management (Secure Storage)
// ============================================================================

/**
 * Retrieves an API key from secure storage.
 * @param {string} origin - The server origin (e.g., "https://graphxr.kineviz.com")
 * @returns {Promise<string|undefined>} - The API key or undefined if not found
 */
async function getApiKey(origin) {
  if (!extensionContext) {
    trace("Extension context not available");
    return undefined;
  }
  const key = await extensionContext.secrets.get(`${API_KEY_PREFIX}${origin}`);
  return key;
}

/**
 * Stores an API key in secure storage.
 * @param {string} origin - The server origin
 * @param {string} apiKey - The API key to store
 */
async function setApiKey(origin, apiKey) {
  if (!extensionContext) {
    throw new Error("Extension context not available");
  }
  await extensionContext.secrets.store(`${API_KEY_PREFIX}${origin}`, apiKey);
  trace("API key stored securely", { origin });
}

/**
 * Deletes an API key from secure storage.
 * @param {string} origin - The server origin
 */
async function deleteApiKey(origin) {
  if (!extensionContext) {
    throw new Error("Extension context not available");
  }
  await extensionContext.secrets.delete(`${API_KEY_PREFIX}${origin}`);
  trace("API key deleted", { origin });
}

/**
 * Migrates API keys from old settings.json storage to secure storage.
 * This is a one-time migration that runs on first activation after the update.
 * @param {vscode.ExtensionContext} context
 */
async function migrateApiKeys(context) {
  // Check if migration has already been completed
  const migrationComplete = context.globalState.get(MIGRATION_COMPLETE_KEY);
  if (migrationComplete) {
    trace("API key migration already completed");
    return;
  }

  const config = vscode.workspace.getConfiguration("grovebook");
  const oldApiKeys = config.get("apiKeys");

  if (!oldApiKeys || Object.keys(oldApiKeys).length === 0) {
    trace("No old API keys to migrate");
    await context.globalState.update(MIGRATION_COMPLETE_KEY, true);
    return;
  }

  trace("Migrating API keys from settings to secure storage", { 
    count: Object.keys(oldApiKeys).length 
  });

  let migratedCount = 0;
  const errors = [];

  for (const [origin, apiKey] of Object.entries(oldApiKeys)) {
    try {
      await context.secrets.store(`${API_KEY_PREFIX}${origin}`, apiKey);
      migratedCount++;
      trace("Migrated API key", { origin });
    } catch (error) {
      errors.push({ origin, error: error.message });
      trace("Failed to migrate API key", { origin, error: error.message });
    }
  }

  // Mark migration as complete
  await context.globalState.update(MIGRATION_COMPLETE_KEY, true);

  // Clear old keys from settings (optional, but recommended for security)
  try {
    await config.update("apiKeys", {}, vscode.ConfigurationTarget.Global);
    trace("Cleared old API keys from settings");
  } catch (error) {
    trace("Failed to clear old API keys from settings", { error: error.message });
  }

  // Notify user about migration
  if (migratedCount > 0) {
    vscode.window.showInformationMessage(
      `Grovebook: Migrated ${migratedCount} API key(s) to secure storage.`
    );
  }

  if (errors.length > 0) {
    vscode.window.showWarningMessage(
      `Grovebook: Failed to migrate ${errors.length} API key(s). Please re-add them using "Grovebook: Set API Key" command.`
    );
  }
}

/**
 * Command handler for setting an API key.
 */
async function handleSetApiKey() {
  const origin = await vscode.window.showInputBox({
    prompt: "Enter the GraphXR server origin",
    placeHolder: "https://graphxr.kineviz.com",
    validateInput: (value) => {
      if (!value) {
        return "Origin is required";
      }
      try {
        new URL(value);
        return null;
      } catch {
        return "Please enter a valid URL (e.g., https://graphxr.kineviz.com)";
      }
    },
  });

  if (!origin) {
    return; // User cancelled
  }

  const apiKey = await vscode.window.showInputBox({
    prompt: `Enter the API key for ${origin}`,
    placeHolder: "Your API key",
    password: true, // Hide the input
    validateInput: (value) => {
      if (!value) {
        return "API key is required";
      }
      return null;
    },
  });

  if (!apiKey) {
    return; // User cancelled
  }

  try {
    await setApiKey(origin, apiKey);
    vscode.window.showInformationMessage(`API key saved for ${origin}`);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to save API key: ${error.message}`);
  }
}

/**
 * Command handler for deleting an API key.
 */
async function handleDeleteApiKey() {
  const origin = await vscode.window.showInputBox({
    prompt: "Enter the GraphXR server origin to delete",
    placeHolder: "https://graphxr.kineviz.com",
  });

  if (!origin) {
    return; // User cancelled
  }

  // Confirm deletion
  const confirm = await vscode.window.showWarningMessage(
    `Are you sure you want to delete the API key for ${origin}?`,
    { modal: true },
    "Delete"
  );

  if (confirm !== "Delete") {
    return; // User cancelled
  }

  try {
    await deleteApiKey(origin);
    vscode.window.showInformationMessage(`API key deleted for ${origin}`);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to delete API key: ${error.message}`);
  }
}

/**
 * Command handler for listing stored API key origins (not the keys themselves).
 */
async function handleListApiKeys() {
  // Note: VS Code's SecretStorage API doesn't provide a way to list all keys,
  // so we'll inform the user about this limitation
  vscode.window.showInformationMessage(
    "API keys are stored securely. Use 'Grovebook: Set API Key' to add a new key or 'Grovebook: Delete API Key' to remove one.",
    "Set API Key",
    "Delete API Key"
  ).then((selection) => {
    if (selection === "Set API Key") {
      vscode.commands.executeCommand("grovebook.setApiKey");
    } else if (selection === "Delete API Key") {
      vscode.commands.executeCommand("grovebook.deleteApiKey");
    }
  });
}

// ============================================================================
// Module Exports
// ============================================================================

module.exports = {
  activate,
  deactivate,
};
