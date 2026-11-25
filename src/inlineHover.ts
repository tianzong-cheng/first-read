import * as vscode from 'vscode';

const rings = ['○', '◔', '◑', '◕', '●'];

export class InlineHover implements vscode.Disposable {
  private readonly explanations = new Map<vscode.TextDocument, Map<number, string>>();
  private readonly explanationType = this.createType();
  private readonly progressType = this.createType();
  private pending?: { editor: vscode.TextEditor; stop: () => void };

  private createType(): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
      after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 1em' },
    });
  }

  private atLineEnd(document: vscode.TextDocument, line: number, text: string): vscode.DecorationOptions {
    const end = document.lineAt(line).range.end;
    const leader = document.languageId === 'python' ? '# ' : '// ';
    return { range: new vscode.Range(end, end), renderOptions: { after: { contentText: leader + text } } };
  }

  has(document: vscode.TextDocument, line: number): boolean {
    return this.explanations.get(document)?.has(line) ?? false;
  }

  show(document: vscode.TextDocument, line: number, text: string): void {
    let lines = this.explanations.get(document);
    if (!lines) this.explanations.set(document, lines = new Map());
    lines.set(line, text);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) this.render(editor);
    }
  }

  render(editor: vscode.TextEditor): void {
    const lines = this.explanations.get(editor.document);
    const decorations: vscode.DecorationOptions[] = [];
    if (lines) {
      for (const [line, text] of lines) decorations.push(this.atLineEnd(editor.document, line, text));
    }
    editor.setDecorations(this.explanationType, decorations);
  }

  track(editor: vscode.TextEditor, line: number, token: vscode.CancellationToken): {
    phase: (phase: number | 'sent') => void;
    stop: () => void;
  } {
    let timer: NodeJS.Timeout | undefined;
    const show = (text: string) => {
      editor.setDecorations(this.progressType, [this.atLineEnd(editor.document, line, text)]);
    };
    const stop = () => {
      clearInterval(timer);
      if (this.pending?.stop !== stop) return;
      this.pending = undefined;
      editor.setDecorations(this.progressType, []);
    };
    const phase = (phase: number | 'sent') => {
      if (token.isCancellationRequested) return;
      if (this.pending?.stop !== stop) {
        this.pending?.stop();
        this.pending = { editor, stop };
      }
      clearInterval(timer);
      if (phase === 'sent') {
        show('正在解释...');
        return;
      }
      const started = performance.now();
      const tick = () => {
        if (token.isCancellationRequested) { stop(); return; }
        const percent = Math.min(100, Math.floor((performance.now() - started) / phase * 100));
        show(`${rings[Math.floor(percent / 25)]} ${percent}%`);
        if (percent === 100) clearInterval(timer);
      };
      timer = setInterval(tick, 65);
      tick();
    };
    return { phase, stop };
  }

  clearProgress(): void {
    this.pending?.stop();
  }

  clearDocument(document: vscode.TextDocument): void {
    if (this.pending?.editor.document === document) this.clearProgress();
    if (!this.explanations.delete(document)) return;
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) editor.setDecorations(this.explanationType, []);
    }
  }

  clear(): void {
    this.clearProgress();
    this.explanations.clear();
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(this.explanationType, []);
  }

  dispose(): void {
    this.clearProgress();
    this.explanations.clear();
    this.explanationType.dispose();
    this.progressType.dispose();
  }
}
