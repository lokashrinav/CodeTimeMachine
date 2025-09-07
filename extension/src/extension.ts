import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface SessionInfo {
    id: string;
    dbId: number;
    dbPath: string;
    projectPath: string;
    startTime: number;
    name: string;
}

class CodeTimeMachineExtension {
    private context: vscode.ExtensionContext;
    private isRecording: boolean = false;
    private sessionInfo: SessionInfo | null = null;
    private disposables: vscode.Disposable[] = [];
    private statusBarItem: vscode.StatusBarItem;
    private debounceTimers = new Map<string, NodeJS.Timeout>();

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'codetimemachine.status';
        this.updateStatusBar();
    }

    public activate() {
        // Register commands
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codetimemachine.start', () => this.startRecording()),
            vscode.commands.registerCommand('codetimemachine.stop', () => this.stopRecording()),
            vscode.commands.registerCommand('codetimemachine.status', () => this.showStatus())
        );

        // Check if recording is already active
        this.checkRecordingStatus();

        // Setup event listeners if recording
        if (this.isRecording) {
            this.setupEventListeners();
        }

        this.statusBarItem.show();
    }

    private checkRecordingStatus() {
        const configDir = path.join(os.homedir(), '.codetimemachine');
        const currentSessionFile = path.join(configDir, 'current_session.json');

        if (fs.existsSync(currentSessionFile)) {
            try {
                const sessionData = JSON.parse(fs.readFileSync(currentSessionFile, 'utf8'));
                this.sessionInfo = sessionData;
                this.isRecording = true;
                this.setupEventListeners();
                vscode.window.showInformationMessage('CodeTimeMachine: Resumed recording session');
            } catch (error) {
                console.error('Error reading session file:', error);
            }
        }
    }

    private async startRecording() {
        if (this.isRecording) {
            vscode.window.showWarningMessage('Recording already in progress');
            return;
        }

        // Get workspace folder
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        const projectPath = workspaceFolders[0].uri.fsPath;
        const sessionName = await vscode.window.showInputBox({
            prompt: 'Enter session name (optional)',
            value: `vscode_session_${Date.now()}`
        });

        if (!sessionName) return;

        try {
            // Use CLI to start recording
            const { exec } = require('child_process');
            await new Promise<void>((resolve, reject) => {
                exec(`ctm start -p "${projectPath}" -n "${sessionName}"`, (error: any, stdout: string, stderr: string) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    console.log(stdout);
                    resolve();
                });
            });

            // Read session info
            this.checkRecordingStatus();
            this.updateStatusBar();

            vscode.window.showInformationMessage(`CodeTimeMachine: Started recording "${sessionName}"`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to start recording: ${error}`);
        }
    }

    private async stopRecording() {
        if (!this.isRecording) {
            vscode.window.showWarningMessage('No recording in progress');
            return;
        }

        try {
            const { exec } = require('child_process');
            await new Promise<void>((resolve, reject) => {
                exec('ctm stop', (error: any, stdout: string, stderr: string) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    console.log(stdout);
                    resolve();
                });
            });

            this.isRecording = false;
            this.sessionInfo = null;
            this.disposeEventListeners();
            this.updateStatusBar();

            vscode.window.showInformationMessage('CodeTimeMachine: Recording stopped');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to stop recording: ${error}`);
        }
    }

    private showStatus() {
        if (this.isRecording && this.sessionInfo) {
            const duration = Math.round((Date.now() - this.sessionInfo.startTime) / 1000);
            vscode.window.showInformationMessage(
                `CodeTimeMachine: Recording "${this.sessionInfo.name}" for ${duration}s`
            );
        } else {
            vscode.window.showInformationMessage('CodeTimeMachine: Not recording');
        }
    }

    private setupEventListeners() {
        // Document change events
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument((event) => {
                this.handleDocumentChange(event);
            })
        );

        // Document save events
        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument((document) => {
                this.handleDocumentSave(document);
            })
        );

        // File creation events
        this.disposables.push(
            vscode.workspace.onDidCreateFiles((event) => {
                this.handleFilesCreated(event);
            })
        );

        // File deletion events
        this.disposables.push(
            vscode.workspace.onDidDeleteFiles((event) => {
                this.handleFilesDeleted(event);
            })
        );

        // File rename events
        this.disposables.push(
            vscode.workspace.onDidRenameFiles((event) => {
                this.handleFilesRenamed(event);
            })
        );

        // Active editor change
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                this.handleActiveEditorChange(editor);
            })
        );

        // Cursor position change
        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection((event) => {
                this.handleSelectionChange(event);
            })
        );
    }

    private disposeEventListeners() {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        
        // Clear any pending debounce timers
        this.debounceTimers.forEach(timer => clearTimeout(timer));
        this.debounceTimers.clear();
    }

    private handleDocumentChange(event: vscode.TextDocumentChangeEvent) {
        if (!this.isRecording || !event.document.fileName) return;

        const filePath = event.document.fileName;
        const config = vscode.workspace.getConfiguration('codetimemachine');
        const debounceMs = config.get<number>('debounceMs', 500);

        // Debounce rapid changes
        const existingTimer = this.debounceTimers.get(filePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        this.debounceTimers.set(filePath, setTimeout(() => {
            this.recordDocumentEvent(event.document, 'change', {
                changes: event.contentChanges.map(change => ({
                    range: {
                        start: { line: change.range.start.line, character: change.range.start.character },
                        end: { line: change.range.end.line, character: change.range.end.character }
                    },
                    rangeLength: change.rangeLength,
                    text: change.text
                })),
                version: event.document.version
            });
            this.debounceTimers.delete(filePath);
        }, debounceMs));
    }

    private handleDocumentSave(document: vscode.TextDocument) {
        if (!this.isRecording) return;
        this.recordDocumentEvent(document, 'save');
    }

    private handleFilesCreated(event: vscode.FileCreateEvent) {
        if (!this.isRecording) return;
        
        event.files.forEach(file => {
            this.recordFileEvent(file.fsPath, 'create');
        });
    }

    private handleFilesDeleted(event: vscode.FileDeleteEvent) {
        if (!this.isRecording) return;
        
        event.files.forEach(file => {
            this.recordFileEvent(file.fsPath, 'delete');
        });
    }

    private handleFilesRenamed(event: vscode.FileRenameEvent) {
        if (!this.isRecording) return;
        
        event.files.forEach(file => {
            this.recordFileEvent(file.oldUri.fsPath, 'rename', {
                newPath: file.newUri.fsPath
            });
        });
    }

    private handleActiveEditorChange(editor: vscode.TextEditor | undefined) {
        if (!this.isRecording || !editor) return;
        
        this.recordEditorEvent('focus', {
            fileName: editor.document.fileName,
            language: editor.document.languageId,
            lineCount: editor.document.lineCount
        });
    }

    private handleSelectionChange(event: vscode.TextEditorSelectionChangeEvent) {
        if (!this.isRecording) return;
        
        const selection = event.selections[0];
        this.recordEditorEvent('cursor', {
            fileName: event.textEditor.document.fileName,
            position: {
                line: selection.active.line,
                character: selection.active.character
            },
            selection: {
                start: { line: selection.start.line, character: selection.start.character },
                end: { line: selection.end.line, character: selection.end.character }
            }
        });
    }

    private recordDocumentEvent(document: vscode.TextDocument, action: string, data?: any) {
        const config = vscode.workspace.getConfiguration('codetimemachine');
        const maxFileSize = config.get<number>('maxFileSize', 100000);

        if (document.getText().length > maxFileSize) {
            return; // Skip large files
        }

        // For now, just log to console. In production, this would send to daemon
        console.log(`[CodeTimeMachine] Document ${action}:`, {
            file: document.fileName,
            language: document.languageId,
            version: document.version,
            size: document.getText().length,
            data
        });
    }

    private recordFileEvent(filePath: string, action: string, data?: any) {
        console.log(`[CodeTimeMachine] File ${action}:`, {
            file: filePath,
            data
        });
    }

    private recordEditorEvent(action: string, data: any) {
        console.log(`[CodeTimeMachine] Editor ${action}:`, data);
    }

    private updateStatusBar() {
        if (this.isRecording) {
            this.statusBarItem.text = '🔴 CTM Recording';
            this.statusBarItem.tooltip = 'CodeTimeMachine is recording';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            this.statusBarItem.text = '⚪ CTM Ready';
            this.statusBarItem.tooltip = 'CodeTimeMachine ready to record';
            this.statusBarItem.backgroundColor = undefined;
        }
    }

    public dispose() {
        this.disposeEventListeners();
        this.statusBarItem.dispose();
    }
}

export function activate(context: vscode.ExtensionContext) {
    const extension = new CodeTimeMachineExtension(context);
    extension.activate();
    
    context.subscriptions.push(extension);
}

export function deactivate() {
    // Cleanup handled by dispose
}