import * as vscode from 'vscode';

export function getMaxRevisionsPerFile(): number {
    const config = vscode.workspace.getConfiguration('revisions');
    return config.get<number>('maxRevisionsPerFile', 50);
}

export function onConfigChange(context: vscode.ExtensionContext, callback: () => void): void {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('revisions.maxRevisionsPerFile')) {
            callback();
        }
    }));
}