import * as vscode from 'vscode';
import { diff_match_patch } from 'diff-match-patch';
import { getMaxRevisionsPerFile, onConfigChange } from './configuration';

interface Revision {
    diff: string;
    timestamp: number;
    name?: string;
}

interface FileRevisions {
    [fileName: string]: {
        baseContent: string;
        revisions: Revision[];
    };
}

type WebViewMessage = {
    command: 'compare' | 'restore' | 'cleanup' | 'restoreInplace' | 'rename';
    revisionIndex?: number;
    name?: string;
};

const MAX_FILE_SIZE = 1024 * 1024; // 1MB this is the max limit for revision file updates will come in version 6.0 for bigger file size

let globalRevisions: FileRevisions = {};
const dmp = new diff_match_patch();

// Helper function to escape HTML entities and prevent XSS
function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/\\/g, '&#92;');
}

function handleError(error: unknown, context: string): void {
    console.error(`Error in ${context}:`, error);
    if (error instanceof Error) {
        vscode.window.showErrorMessage(`Error in ${context}: ${error.message}`);
    } else {
        vscode.window.showErrorMessage(`An unknown error occurred in ${context}`);
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Revisions extension is now active!');

    // Load existing revisions from globalState
    globalRevisions = context.globalState.get<FileRevisions>('revisions', {});
    console.log('Initial globalRevisions:', JSON.stringify(globalRevisions));

    // Trim revisions on activation and configuration change
    trimRevisionsToMax();
    onConfigChange(context, trimRevisionsToMax);

    let createSnapshot = vscode.commands.registerCommand('revisions.createSnapshot', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const name = await vscode.window.showInputBox({
                prompt: 'Enter a name for this revision (optional)',
                placeHolder: 'e.g., "Before refactoring", "Working version"'
            });
            // name will be undefined if cancelled, empty string if submitted empty
            createSnapshotForFile(editor.document, context, name || undefined);
        } else {
            vscode.window.showErrorMessage('No active text editor');
        }
    });

    let viewHistory = vscode.commands.registerCommand('revisions.viewHistory', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const fileName = editor.document.fileName;
            if (globalRevisions[fileName]) {
                const panel = vscode.window.createWebviewPanel(
                    'revisionsHistory',
                    'Revisions History',
                    vscode.ViewColumn.Beside,
                    {
                        enableScripts: true
                    }
                );
                panel.webview.html = getWebviewContent(fileName, globalRevisions[fileName]);
                panel.webview.onDidReceiveMessage(
                    message => handleWebviewMessage(message, fileName, editor, panel, context),
                    undefined,
                    context.subscriptions
                );
            } else {
                vscode.window.showInformationMessage('No revisions found for this file');
            }
        } else {
            vscode.window.showErrorMessage('No active text editor');
        }
    });

    let cleanupRevisions = vscode.commands.registerCommand('revisions.cleanupRevisions', () => {
        vscode.window.showInputBox({
            prompt: "Remove revisions older than how many days?",
            placeHolder: "Enter number of days",
            validateInput: (value: string) => {
                if (!/^\d+$/.test(value)) {
                    return "Please enter a valid number";
                }
                return null;
            }
        }).then(daysString => {
            if (daysString) {
                const days = parseInt(daysString);
                vscode.window.showWarningMessage(`Are you sure you want to remove revisions older than ${days} days?`, 'Yes', 'No')
                    .then(choice => {
                        if (choice === 'Yes') {
                            const cleanedUp = cleanupOldRevisions(days);
                            vscode.window.showInformationMessage(`Cleaned up ${cleanedUp} old revisions.`);
                            updateGlobalState(context);
                        }
                    });
            }
        });
    });

    // Set up automatic snapshot creation on file save
    vscode.workspace.onDidSaveTextDocument(document => {
        console.log('File saved:', document.fileName);
        createSnapshotForFile(document, context);
    });

    context.subscriptions.push(createSnapshot, viewHistory, cleanupRevisions);
}

async function createSnapshotForFile(document: vscode.TextDocument, context: vscode.ExtensionContext, name?: string) {
    try {
        const fileName = document.fileName;
        const content = document.getText();

        if (content.length > MAX_FILE_SIZE) {
            console.warn(`File ${fileName} is too large for efficient diffing. Consider alternative approach.`);
            return;
        }

        if (!globalRevisions[fileName]) {
            globalRevisions[fileName] = {
                baseContent: content,
                revisions: []
            };
        } else {
            const lastContent = getContentAtRevision(fileName, globalRevisions[fileName].revisions.length - 1);
            const diff = dmp.diff_main(lastContent, content);
            dmp.diff_cleanupSemantic(diff);
            const patchText = dmp.patch_toText(dmp.patch_make(diff));

            const revision: Revision = {
                diff: patchText,
                timestamp: Date.now()
            };
            if (name) {
                revision.name = name;
            }
            globalRevisions[fileName].revisions.push(revision);

            const maxRevisions = getMaxRevisionsPerFile();
            if (globalRevisions[fileName].revisions.length > maxRevisions) {
                globalRevisions[fileName].revisions = globalRevisions[fileName].revisions.slice(-maxRevisions);
            }
        }

        await updateGlobalState(context);

        console.log(`Snapshot created for ${fileName}. Current revisions:`, JSON.stringify(globalRevisions[fileName]));
        vscode.window.showInformationMessage(`Snapshot created for ${fileName}`);
    } catch (error: unknown) {
        handleError(error, 'creating snapshot');
    }
}

function handleWebviewMessage(message: WebViewMessage, fileName: string, editor: vscode.TextEditor, panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    switch (message.command) {
        case 'compare':
            if (message.revisionIndex !== undefined) {
                compareRevisions(fileName, message.revisionIndex, editor);
            }
            break;
        case 'restore':
            if (message.revisionIndex !== undefined) {
                restoreRevision(fileName, message.revisionIndex, editor);
            }
            break;
        case 'restoreInplace':
            if (message.revisionIndex !== undefined) {
                restoreRevisionInplace(fileName, message.revisionIndex, editor);
            }
            break;
        case 'cleanup':
            vscode.commands.executeCommand('revisions.cleanupRevisions');
            break;
        case 'rename':
            if (message.revisionIndex !== undefined && message.name !== undefined) {
                renameRevision(fileName, message.revisionIndex, message.name, context, panel);
            }
            break;
    }
}

async function compareRevisions(fileName: string, revisionIndex: number, editor: vscode.TextEditor) {
    try {
        const oldContent = getContentAtRevision(fileName, revisionIndex);
        
        // Create a temporary document for the old content
        const tempDoc = await vscode.workspace.openTextDocument({
            content: oldContent,
            language: editor.document.languageId
        });

        // Compare using the temp document and current document
        await vscode.commands.executeCommand('vscode.diff',
            tempDoc.uri,
            editor.document.uri,
            `Revision ${revisionIndex} ↔ Current`
        );
    } catch (error: unknown) {
        handleError(error, 'comparing revisions');
    }
}

async function restoreRevision(fileName: string, revisionIndex: number, editor: vscode.TextEditor) {
    try {
        const content = getContentAtRevision(fileName, revisionIndex);
        
        // new tab
        const doc = await vscode.workspace.openTextDocument({
            content: content,
            language: editor.document.languageId
        });
        
        // Show  in  new tab
        await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Beside,
            preview: false
        });
        
        vscode.window.showInformationMessage(`Revision ${revisionIndex} opened in new tab`);
    } catch (error: unknown) {
        handleError(error, 'restoring revision');
    }
}

async function restoreRevisionInplace(fileName: string, revisionIndex: number, editor: vscode.TextEditor) {
    try {
        const content = getContentAtRevision(fileName, revisionIndex);
        await editor.edit(editBuilder => {
            const fullRange = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(editor.document.getText().length)
            );
            editBuilder.replace(fullRange, content);
        });
        vscode.window.showInformationMessage(`Restored to revision ${revisionIndex} in current tab`);
    } catch (error: unknown) {
        handleError(error, 'restoring revision in-place');
    }
}

async function renameRevision(fileName: string, revisionIndex: number, name: string, context: vscode.ExtensionContext, panel: vscode.WebviewPanel) {
    try {
        if (globalRevisions[fileName] && globalRevisions[fileName].revisions[revisionIndex]) {
            globalRevisions[fileName].revisions[revisionIndex].name = name || undefined;
            await updateGlobalState(context);
            // Refresh the WebView to show updated name
            panel.webview.html = getWebviewContent(fileName, globalRevisions[fileName]);
            vscode.window.showInformationMessage(`Revision renamed successfully`);
        }
    } catch (error: unknown) {
        handleError(error, 'renaming revision');
    }
}

function getContentAtRevision(fileName: string, revisionIndex: number): string {
    if (revisionIndex < 0) {
        return globalRevisions[fileName].baseContent;
    }

    let content = globalRevisions[fileName].baseContent;
    for (let i = 0; i <= revisionIndex; i++) {
        const patches = dmp.patch_fromText(globalRevisions[fileName].revisions[i].diff);
        const [patchedText, _] = dmp.patch_apply(patches, content);
        content = patchedText;
    }
    return content;
}

function getWebviewContent(fileName: string, fileRevisions: { baseContent: string; revisions: Revision[] }): string {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Revisions History</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <style>
                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(-10px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .animate-fade-in {
                    animation: fadeIn 0.3s ease-out forwards;
                }
            </style>
        </head>
        <body class="bg-gray-50 dark:bg-gray-800 p-4 min-h-screen">
            <div class="max-w-4xl mx-auto">
                <div class="bg-white dark:bg-gray-700 rounded-lg shadow-lg p-6 mb-6">
                    <h1 class="text-2xl font-bold mb-4 text-gray-800 dark:text-white">
                        Revisions for ${fileName.split('/').pop()}
                    </h1>
                    <button 
                        onclick="sendMessage('cleanup')"
                        class="mb-6 bg-red-500 hover:bg-red-600 text-white font-semibold py-2 px-4 rounded-lg transition duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-50"
                    >
                        Clean Up Old Revisions
                    </button>

                    <div class="space-y-4">
                        <div class="bg-gray-50 dark:bg-gray-600 rounded-lg p-4 animate-fade-in">
                            <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between">
                                <div class="flex items-center mb-3 sm:mb-0">
                                    <span class="text-lg font-semibold text-gray-700 dark:text-gray-200">Base Version</span>
                                </div>
                                <div class="flex flex-wrap gap-2">
                                    <button 
                                        onclick="sendMessage('compare', -1)"
                                        class="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium transition duration-200 ease-in-out"
                                    >
                                        Compare
                                    </button>
                                    <button 
                                        onclick="sendMessage('restore', -1)"
                                        class="bg-green-500 hover:bg-green-600 text-white px-3 py-1.5 rounded-md text-sm font-medium transition duration-200 ease-in-out"
                                    >
                                        Open New Tab
                                    </button>
                                    <button 
                                        onclick="sendMessage('restoreInplace', -1)"
                                        class="bg-purple-500 hover:bg-purple-600 text-white px-3 py-1.5 rounded-md text-sm font-medium transition duration-200 ease-in-out"
                                    >
                                        Restore Here
                                    </button>
                                </div>
                            </div>
                        </div>

                        ${fileRevisions.revisions.map((revision, index) => `
                            <div class="bg-gray-50 dark:bg-gray-600 rounded-lg p-4 animate-fade-in" style="animation-delay: ${index * 50}ms">
                                <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between">
                                    <div class="flex flex-col mb-3 sm:mb-0">
                                        <div class="flex items-center gap-2" id="name-display-${index}">
                                            <span class="text-lg font-semibold text-gray-700 dark:text-gray-200">
                                                ${revision.name ? escapeHtml(revision.name) : `Revision ${index + 1}`}
                                            </span>
                                            ${revision.name ? `<span class="text-xs text-gray-400 dark:text-gray-400">(#${index + 1})</span>` : ''}
                                            <button
                                                onclick="startRename(${index}, '${escapeHtml(revision.name || '')}')"
                                                class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1 rounded transition duration-200"
                                                title="Rename revision"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                                </svg>
                                            </button>
                                        </div>
                                        <div class="hidden items-center gap-2" id="name-edit-${index}">
                                            <input
                                                type="text"
                                                id="name-input-${index}"
                                                class="px-2 py-1 text-sm border rounded dark:bg-gray-700 dark:border-gray-500 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                placeholder="Enter revision name"
                                                onkeydown="handleRenameKeydown(event, ${index})"
                                            />
                                            <button
                                                onclick="saveRename(${index})"
                                                class="bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded text-xs font-medium transition duration-200"
                                            >
                                                Save
                                            </button>
                                            <button
                                                onclick="cancelRename(${index})"
                                                class="bg-gray-300 hover:bg-gray-400 dark:bg-gray-500 dark:hover:bg-gray-400 text-gray-700 dark:text-white px-2 py-1 rounded text-xs font-medium transition duration-200"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                        <span class="text-sm text-gray-500 dark:text-gray-300">
                                            ${new Date(revision.timestamp).toLocaleString()}
                                        </span>
                                    </div>
                                    <div class="flex flex-wrap gap-2">
                                        <button
                                            onclick="sendMessage('compare', ${index})"
                                            class="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium transition duration-200 ease-in-out"
                                        >
                                            Compare
                                        </button>
                                        <button
                                            onclick="sendMessage('restore', ${index})"
                                            class="bg-green-500 hover:bg-green-600 text-white px-3 py-1.5 rounded-md text-sm font-medium transition duration-200 ease-in-out"
                                        >
                                            Open New Tab
                                        </button>
                                        <button
                                            onclick="sendMessage('restoreInplace', ${index})"
                                            class="bg-purple-500 hover:bg-purple-600 text-white px-3 py-1.5 rounded-md text-sm font-medium transition duration-200 ease-in-out"
                                        >
                                            Restore Here
                                        </button>
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                function sendMessage(command, revisionIndex, name) {
                    vscode.postMessage({ command: command, revisionIndex: revisionIndex, name: name });
                }

                function startRename(index, currentName) {
                    document.getElementById('name-display-' + index).classList.add('hidden');
                    document.getElementById('name-edit-' + index).classList.remove('hidden');
                    document.getElementById('name-edit-' + index).classList.add('flex');
                    const input = document.getElementById('name-input-' + index);
                    input.value = currentName;
                    input.focus();
                    input.select();
                }

                function cancelRename(index) {
                    document.getElementById('name-display-' + index).classList.remove('hidden');
                    document.getElementById('name-edit-' + index).classList.add('hidden');
                    document.getElementById('name-edit-' + index).classList.remove('flex');
                }

                function saveRename(index) {
                    const input = document.getElementById('name-input-' + index);
                    const name = input.value.trim();
                    sendMessage('rename', index, name);
                }

                function handleRenameKeydown(event, index) {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        saveRename(index);
                    } else if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelRename(index);
                    }
                }

                // Support for dark mode
                const isDarkMode = document.body.classList.contains('vscode-dark');
                if (isDarkMode) {
                    document.body.classList.add('dark');
                }
            </script>
        </body>
        </html>
    `;
}

function cleanupOldRevisions(days: number): number {
    const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
    let totalCleaned = 0;

    for (const fileName in globalRevisions) {
        const fileRevisions = globalRevisions[fileName];
        const originalLength = fileRevisions.revisions.length;
        fileRevisions.revisions = fileRevisions.revisions.filter(revision => revision.timestamp > cutoffTime);
        totalCleaned += originalLength - fileRevisions.revisions.length;

        if (fileRevisions.revisions.length === 0) {
            delete globalRevisions[fileName];
        }
    }

    return totalCleaned;
}

function trimRevisionsToMax() {
    const maxRevisions = getMaxRevisionsPerFile();
    for (const fileName in globalRevisions) {
        if (globalRevisions[fileName].revisions.length > maxRevisions) {
            globalRevisions[fileName].revisions = globalRevisions[fileName].revisions.slice(-maxRevisions);
        }
    }
}

async function updateGlobalState(context: vscode.ExtensionContext) {
    return context.globalState.update('revisions', globalRevisions);
}

export function deactivate() {}