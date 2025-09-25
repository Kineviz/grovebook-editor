const vscode = require("vscode");
const io = require('socket.io-client');
const os = require('os');

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
  const grovePath = vscode.Uri.file(`${homedir}/${localDir}`);
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
      const tempFolderUri = vscode.Uri.file(`${homedir}/${localDir}/${protocol}/${host}/${fileName}`).fsPath;
      const fileUri = vscode.Uri.file(`${tempFolderUri}.grove`);
      
      // Ensure all parent directories exist
      const parentDir = fileUri.fsPath.substring(0, fileUri.fsPath.lastIndexOf('/'));
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
    const splitPath = document.fileName.split("/");
    const groveIndex = splitPath.indexOf(".kineviz-grove");
    const protocol = splitPath[groveIndex + 1];
    const host = splitPath[groveIndex + 2];
    const projectId = splitPath[groveIndex + 6];
    const fileName = splitPath.slice(groveIndex + 7).join("/").replace(".grove", "");
    const graphxrBaseUrl = `${protocol}://${host}`;

    // Get api key
    const apiKey = getApiKey(graphxrBaseUrl);
    if (!apiKey) {
      vscode.window.showErrorMessage(`No API key found for ${graphxrBaseUrl}`);
      return;
    }

    // Parse the document content to find markdown code blocks
    const content = document.getText();
    const codeBlockRegex = /(?:<!--(.*)-->\n)?```(\w+)?\n([\s\S]*?)```/g;
    const blocks = [];
    let match;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      const cellOptionsStr = match[1];
      const codeContent = match[3].trim();
      let cellOptions = {};
      
      if (cellOptionsStr) {
        cellOptions = JSON.parse(cellOptionsStr);
      }

      blocks.push({
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
      });
    }

    // Create form data
    const formData = new FormData();
    formData.append("fileName", fileName);
    formData.append("projectId", projectId);
    formData.append(
      "data",
      new Blob(
        [
          JSON.stringify({
            blocks: blocks,
            version: "2.19.1",
          }),
        ],
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
function deactivate() {}

function getApiKey(origin) {
  const config = vscode.workspace.getConfiguration('grovebook');
  const apiKeys = config.get('apiKeys');
  return apiKeys[origin];
}

module.exports = {
  activate,
  deactivate,
};
