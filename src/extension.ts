import * as vscode from 'vscode';
import { diff_match_patch } from 'diff-match-patch';
import { getMaxRevisionsPerFile, onConfigChange } from './configuration';

interface Revision {
    diff: string;
    timestamp: number;
}

interface FileRevisions {
    [fileName: string]: {
        baseContent: string;
        revisions: Revision[];
    };
}

type WebViewMessage = {
    command: 'compare' | 'restore' | 'cleanup' | 'restoreInplace';
    revisionIndex?: number;
};

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

let globalRevisions: FileRevisions = {};
const dmp = new diff_match_patch();

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

    let createSnapshot = vscode.commands.registerCommand('revisions.createSnapshot', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            createSnapshotForFile(editor.document, context);
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
                    message => handleWebviewMessage(message, fileName, editor, panel),
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

async function createSnapshotForFile(document: vscode.TextDocument, context: vscode.ExtensionContext) {
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
            
            globalRevisions[fileName].revisions.push({
                diff: patchText,
                timestamp: Date.now()
            });

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

function handleWebviewMessage(message: WebViewMessage, fileName: string, editor: vscode.TextEditor, panel: vscode.WebviewPanel) {
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
                                        <span class="text-lg font-semibold text-gray-700 dark:text-gray-200">
                                            Revision ${index + 1}
                                        </span>
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
                function sendMessage(command, revisionIndex) {
                    vscode.postMessage({ command: command, revisionIndex: revisionIndex });
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