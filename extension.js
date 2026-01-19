const vscode = require("vscode");
const io = require('socket.io-client');
const os = require('os');
const path = require('path');

const prefixAliasPath = () => "";

const ioOptions = {
  path: prefixAliasPath("/socket.io"),
  'pingInterval': 5000,
  'pingTimeout': 15000
};

const localDir = ".kineviz-grove"

let socket = null;

function connectSocket(baseUrl) {
  if (!socket) {
    socket = io(`${baseUrl}/groveHotReload/`, ioOptions);

    socket.on('connect', () => {
      console.log('Connected to Grove hot reload socket');
    });

    socket.on('reloadResult', (result) => {
      if (!result.success) {
        vscode.window.showErrorMessage(`Reload failed: ${result.message}`);
      }
    });

    socket.on('reloadError', (error) => {
      vscode.window.showErrorMessage(`Reload error: ${error.message}`);
    });

    socket.on('disconnect', () => {
      console.log('Disconnected from Grove hot reload socket');
    });
  }
  return socket;
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // Create ~/.grove directory if it doesn't exist
  const homedir = os.homedir();
  const grovePath = vscode.Uri.file(path.join(homedir, localDir));
  vscode.workspace.fs.createDirectory(grovePath);

  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log(
    'Congratulations, your extension "helloworldvscode" is now active!'
  );
  const handleUri = async (uri) => {
    const queryParams = new URLSearchParams(uri.query);

    if (queryParams.has("open")) {
      const baseUrl = queryParams.get("baseUrl");
      const fileName = queryParams.get("open");
      const workspaceEdit = new vscode.WorkspaceEdit();

      // Create full path structure in ~/.grove instead of /tmp
      const [protocol, host] = baseUrl.split("://");
      const homedir = os.homedir();
      const tempFolderPath = path.join(homedir, localDir, protocol, host, ...fileName.split('/'));
      const fileUri = vscode.Uri.file(`${tempFolderPath}.grove`);

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
        const response = await fetch(`${baseUrl}${fileName}`, {
          headers: {
            'x-api-key': apiKey
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const fileContentStr = await response.text();
        let mdContent;
        try {
          const fileContent = JSON.parse(fileContentStr);
          if (fileContent && fileContent.blocks) {
            mdContent = convertGroveToMd(fileContent);
          } else {
            mdContent = fileContentStr;
          }
        } catch (e) {
          mdContent = fileContentStr;
        }

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
  };

  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri,
    })
  );

  // Register save event listener
  const saveDisposable = vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (!document.fileName.includes(localDir)) {
      return;
    }

    // Derive baseUrl from document path
    const splitPath = document.fileName.split(path.sep);
    const groveIndex = splitPath.indexOf(".kineviz-grove");
    const protocol = splitPath[groveIndex + 1];
    const host = splitPath[groveIndex + 2];
    const projectId = splitPath[groveIndex + 6];
    // Use forward slash for URL paths (server-side expects forward slashes)
    const fileName = splitPath.slice(groveIndex + 7).join("/").replace(".grove", "");
    const graphxrBaseUrl = `${protocol}://${host}`;

    // Get api key
    const apiKey = getApiKey(graphxrBaseUrl);
    if (!apiKey) {
      vscode.window.showErrorMessage(`No API key found for ${graphxrBaseUrl}`);
      return;
    }

    // Get raw content (keep as markdown)
    const content = document.getText();

    // Create form data
    const formData = new FormData();
    formData.append("fileName", fileName);
    formData.append("projectId", projectId);
    formData.append(
      "data",
      new Blob(
        [content],
        { type: "text/plain" }
      )
    );

    try {
      const simpleUploadUrl = `${graphxrBaseUrl}/api/grove/simpleUploadFile`
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

      const data = await response.text();
      console.log(data);

      // Use WebSocket for reload
      socket = connectSocket(graphxrBaseUrl);
      socket.emit('requestReload', { fileName, projectId });
    } catch (error) {
      vscode.window.showErrorMessage(`Upload failed: ${error.message}`);
    }
  });

  context.subscriptions.push(saveDisposable);
}

function parseMarkdownText(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let currentParaLines = [];
  let pendingMetadata = null;

  function flushPara() {
    if (currentParaLines.length > 0) {
      const joined = currentParaLines.join('\n');
      if (joined.trim()) {
        blocks.push({
          type: 'paragraph',
          data: { text: joined }
        });
      }
      currentParaLines = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for Metadata Comment
    const metaMatch = line.match(/^<!--(.*)-->$/);
    if (metaMatch) {
      try {
        const potentialMeta = JSON.parse(metaMatch[1]);
        if (potentialMeta && (potentialMeta.type === 'header' || potentialMeta.type === 'paragraph')) {
          flushPara();
          pendingMetadata = potentialMeta;
          continue; // Skip adding the comment line to content
        }
      } catch (e) {
        // Not valid JSON metadata, treat as normal text
      }
    }

    // Explicit Metadata Handling
    if (pendingMetadata) {
      if (pendingMetadata.type === 'header') {
        const headerMatch = line.match(/^(#{1,6})\s+(.*)/);
        // Even if regex fails, we trust metadata? No, header needs content. 
        // But if user edited it to be plain text, we should respect that content but maybe force type?
        // Let's rely on content for data, but metadata for intent.

        if (headerMatch) {
          blocks.push({
            type: 'header',
            data: {
              level: pendingMetadata.level || headerMatch[1].length,
              text: headerMatch[2].trim() // Use current text, ignore metadata text to allow edits
            }
          });
          pendingMetadata = null;
          continue;
        } else if (line.trim() !== '') {
          // Fallback: If metadata says header but text isn't, maybe treat as paragraph or force header?
          // Let's treat as paragraph if syntax invalid.
          currentParaLines.push(line);
        }
      } else if (pendingMetadata.type === 'paragraph') {
        if (line.trim() !== '') {
          currentParaLines.push(line);
        }
      }
      // If line was empty, keep pendingMetadata until valid content found? 
      // No, usually metadata immediately precedes content.
      if (line.trim() !== '') {
        pendingMetadata = null; // Consumed
      }
    } else {
      // Heuristic Handling (Backward Compatibility)
      const headerMatch = line.match(/^(#{1,6})\s+(.*)/);
      if (headerMatch) {
        flushPara();
        blocks.push({
          type: 'header',
          data: {
            level: headerMatch[1].length,
            text: headerMatch[2].trim()
          }
        });
      } else {
        currentParaLines.push(line);
        if (line.trim() === '') {
          flushPara();
        }
      }
    }
  }
  flushPara();
  return blocks;
}

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
    } else if (block.type === "header") {
      const level = block.data.level;
      const hash = "#".repeat(level);
      return `${hash} ${block.data.text}`;
    } else if (block.type === "paragraph") {
      return block.data.text;
    }
    return ""; // Unknown block type default
  });
  return mdBlocks.filter(x => x).join("\n\n");
}

function convertCodeModeToMd(codeMode) {
  /**
   * Convert code mode to one which will be highlighted correctly by vscode markdown block highlighting
   */
  switch (codeMode) {
    case "javascript2":
      return "js";
    default:
      return codeMode;
  }
}

function convertCodeModeMdToGrove(codeMode) {
  switch (codeMode) {
    case "js":
      return "javascript2";
    default:
      return codeMode;
  }
}

// This method is called when your extension is deactivated
function deactivate() { }

function getApiKey(origin) {
  const config = vscode.workspace.getConfiguration('grovebook');
  const apiKeys = config.get('apiKeys');
  return apiKeys[origin];
}

module.exports = {
  activate,
  deactivate,
};
