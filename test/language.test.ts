import { test } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';

import {
  HOVER_CONTEXT_BUDGET_BYTES,
  buildHoverContext,
  collectHoverContext,
  isSupportedLanguage,
  normalizeLineRange,
  queryDocumentSymbols,
  querySelectionRanges,
  type CommandExecutor,
  type DocumentLike,
  type LineRange,
} from '../src/language.js';

interface MutableDocument extends DocumentLike {
  version: number;
}

const lr = (start: number, end: number): LineRange => ({ start, end });

const vscodeRange = (
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
) => ({
  start: { line: startLine, character: startCharacter },
  end: { line: endLine, character: endCharacter },
});

function makeDocument(lines: readonly string[], languageId = 'python', version = 1): MutableDocument {
  return {
    uri: { scheme: 'file', path: '/sample' },
    languageId,
    version,
    lineCount: lines.length,
    lineAt(line: number) {
      return { text: lines[line] ?? '' };
    },
  };
}

function makeExecutor(handler: (command: string, ...args: unknown[]) => unknown): {
  executor: CommandExecutor;
  calls: Array<{ command: string; args: unknown[] }>;
} {
  const calls: Array<{ command: string; args: unknown[] }> = [];
  const executor: CommandExecutor = (command: string, ...args: unknown[]) => {
    calls.push({ command, args });
    return handler(command, ...args);
  };
  return { executor, calls };
}

test('isSupportedLanguage accepts only Python and C++', () => {
  strictEqual(isSupportedLanguage('python'), true);
  strictEqual(isSupportedLanguage('cpp'), true);
  strictEqual(isSupportedLanguage('typescript'), false);
});

test('normalizeLineRange converts VS Code ranges and one-based tuples', () => {
  deepStrictEqual(normalizeLineRange(vscodeRange(4, 2, 4, 8)), lr(5, 5));
  deepStrictEqual(normalizeLineRange(vscodeRange(1, 0, 3, 0)), lr(2, 3));
  deepStrictEqual(normalizeLineRange(vscodeRange(1, 0, 1, 0)), lr(2, 2));
  deepStrictEqual(normalizeLineRange([2, 4]), lr(2, 4));
  deepStrictEqual(normalizeLineRange({ start: 2, end: 4 }), lr(2, 4));
  deepStrictEqual(normalizeLineRange([2, 10], 5), lr(2, 5));
});

test('normalizeLineRange rejects malformed ranges and out-of-document starts', () => {
  const badRanges: unknown[] = [
    null,
    undefined,
    'not a range',
    [0, 2],
    [2, 1],
    [1.5, 3],
    { start: 2, end: 1 },
    vscodeRange(3, 0, 1, 0),
    vscodeRange(-1, 0, 1, 0),
    vscodeRange(1, 5, 1, 2),
  ];
  for (const bad of badRanges) {
    strictEqual(normalizeLineRange(bad), null);
  }
  strictEqual(normalizeLineRange([6, 7], 5), null);
});

test('queryDocumentSymbols flattens hierarchical and flat symbols', async () => {
  const doc = makeDocument(['a', 'b', 'c', 'd', 'e', 'f']);
  const { executor, calls } = makeExecutor(() => [
    {
      name: 'outer',
      kind: 4,
      range: vscodeRange(0, 0, 4, 0),
      selectionRange: vscodeRange(0, 2, 0, 5),
      children: [
        {
          name: 'inner',
          kind: 11,
          range: vscodeRange(1, 4, 2, 0),
          selectionRange: vscodeRange(1, 8, 1, 9),
          children: [],
        },
      ],
    },
    {
      name: 'main',
      kind: 11,
      location: { range: vscodeRange(4, 0, 6, 0) },
      selectionRange: vscodeRange(4, 0, 6, 0),
    },
    { name: 'bad', kind: 11, location: { range: vscodeRange(3, 0, 1, 0) } },
  ]);

  const result = await queryDocumentSymbols(executor, doc);
  strictEqual(result.status, 'ok');
  deepStrictEqual(result.symbols, [
    { range: lr(1, 4), signatureRange: lr(1, 1) },
    { range: lr(2, 2), signatureRange: lr(2, 2) },
    { range: lr(5, 6), signatureRange: lr(5, 5) },
  ]);
  strictEqual(calls.length, 1);
  deepStrictEqual(calls[0]?.args, [doc.uri]);
});

test('queryDocumentSymbols filters boundary kinds but traverses ineligible children', async () => {
  const doc = makeDocument(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`));
  const { executor } = makeExecutor(() => [
    {
      name: 'ns',
      kind: 2,
      range: vscodeRange(0, 0, 9, 0),
      selectionRange: vscodeRange(0, 0, 0, 2),
      children: [
        {
          name: 'fn',
          kind: 11,
          range: vscodeRange(1, 0, 2, 0),
          selectionRange: vscodeRange(1, 4, 1, 6),
          children: [],
        },
        {
          name: 'var',
          kind: 12,
          range: vscodeRange(3, 0, 4, 0),
          selectionRange: vscodeRange(3, 4, 3, 7),
          children: [
            {
              name: 'nested',
              kind: 11,
              range: vscodeRange(5, 0, 6, 0),
              selectionRange: vscodeRange(5, 4, 5, 9),
              children: [],
            },
          ],
        },
      ],
    },
    {
      name: 'cls',
      kind: 4,
      range: vscodeRange(7, 0, 8, 0),
      selectionRange: vscodeRange(7, 6, 7, 9),
      children: [],
    },
    {
      name: 'method',
      kind: 5,
      range: vscodeRange(7, 4, 8, 0),
      selectionRange: vscodeRange(7, 4, 7, 10),
      children: [],
    },
    {
      name: 'ctor',
      kind: 8,
      range: vscodeRange(7, 4, 8, 0),
      selectionRange: vscodeRange(7, 4, 7, 10),
      children: [],
    },
    {
      name: 'struct',
      kind: 22,
      range: vscodeRange(9, 0, 10, 0),
      selectionRange: vscodeRange(9, 7, 9, 13),
      children: [],
    },
    {
      name: 'leafVar',
      kind: 12,
      range: vscodeRange(11, 0, 11, 5),
      selectionRange: vscodeRange(11, 0, 11, 5),
      children: [],
    },
  ]);

  const result = await queryDocumentSymbols(executor, doc);
  strictEqual(result.status, 'ok');
  deepStrictEqual(
    result.symbols.map((symbol) => symbol.range),
    [lr(2, 2), lr(6, 6), lr(8, 8), lr(8, 8), lr(8, 8), lr(10, 10)],
  );
});

test('queryDocumentSymbols reports absence, errors and version races', async () => {
  const doc = makeDocument(['a', 'b', 'c']);

  const absent = await queryDocumentSymbols(() => undefined, doc);
  strictEqual(absent.status, 'unavailable');
  deepStrictEqual(absent.symbols, []);

  const empty = await queryDocumentSymbols(() => [], doc);
  strictEqual(empty.status, 'ok');
  deepStrictEqual(empty.symbols, []);

  const failed = await queryDocumentSymbols(() => {
    throw new Error('no provider');
  }, doc);
  strictEqual(failed.status, 'unavailable');

  const raced = makeDocument(['a', 'b', 'c']);
  const race = await queryDocumentSymbols(async () => {
    raced.version += 1;
    return [];
  }, raced);
  strictEqual(race.status, 'stale');
  deepStrictEqual(race.symbols, []);

  let called = false;
  const skipped = await queryDocumentSymbols(() => {
    called = true;
    return [];
  }, makeDocument(['const x = 1;'], 'typescript'));
  strictEqual(skipped.status, 'unsupported-language');
  strictEqual(called, false);
});

test('querySelectionRanges passes a position array and normalizes chains', async () => {
  const doc = makeDocument(['a', 'b', 'c']);
  const chain = {
    range: vscodeRange(1, 4, 1, 9),
    parent: { range: vscodeRange(0, 0, 2, 0) },
  };
  const { executor, calls } = makeExecutor(() => [chain]);
  const result = await querySelectionRanges(executor, doc, { line: 1, character: 5 });
  strictEqual(result.status, 'ok');
  deepStrictEqual(result.ranges, [lr(2, 2), lr(1, 2)]);
  deepStrictEqual(calls[0]?.args, [doc.uri, [{ line: 1, character: 5 }]]);

  const single = await querySelectionRanges(() => chain, doc, { line: 1, character: 5 });
  strictEqual(single.status, 'ok');
  deepStrictEqual(single.ranges, [lr(2, 2), lr(1, 2)]);

  const nested = await querySelectionRanges(
    () => [[{ range: vscodeRange(1, 4, 1, 9) }]],
    doc,
    { line: 1, character: 5 },
  );
  strictEqual(nested.status, 'ok');
  deepStrictEqual(nested.ranges, [lr(2, 2)]);
});

test('querySelectionRanges reports absence, errors and version races', async () => {
  const doc = makeDocument(['a', 'b', 'c']);

  const absent = await querySelectionRanges(() => undefined, doc, { line: 1, character: 5 });
  strictEqual(absent.status, 'unavailable');

  const empty = await querySelectionRanges(() => [], doc, { line: 1, character: 5 });
  strictEqual(empty.status, 'ok');
  deepStrictEqual(empty.ranges, []);

  const failed = await querySelectionRanges(() => {
    throw new Error('no provider');
  }, doc, { line: 1, character: 5 });
  strictEqual(failed.status, 'unavailable');

  const raced = makeDocument(['a', 'b', 'c']);
  const race = await querySelectionRanges(async () => {
    raced.version += 1;
    return [];
  }, raced, { line: 1, character: 5 });
  strictEqual(race.status, 'stale');
  deepStrictEqual(race.ranges, []);
});

test('buildHoverContext skips only confident blank and comment lines', () => {
  deepStrictEqual(
    buildHoverContext({ lines: ['   '], languageId: 'python', targetLine: 1 }),
    { kind: 'none', reason: 'blank-line' },
  );
  deepStrictEqual(
    buildHoverContext({ lines: ['# only a comment'], languageId: 'python', targetLine: 1 }),
    { kind: 'none', reason: 'comment-only' },
  );
  deepStrictEqual(
    buildHoverContext({ lines: ['// only a comment'], languageId: 'cpp', targetLine: 1 }),
    { kind: 'none', reason: 'comment-only' },
  );
  deepStrictEqual(
    buildHoverContext({ lines: ['/* closed block */'], languageId: 'cpp', targetLine: 1 }),
    { kind: 'none', reason: 'comment-only' },
  );
  deepStrictEqual(
    buildHoverContext({ lines: ['const x = 1;'], languageId: 'typescript', targetLine: 1 }),
    { kind: 'none', reason: 'unsupported-language' },
  );

  const ambiguous = [
    buildHoverContext({ lines: ['"# literal"'], languageId: 'python', targetLine: 1 }),
    buildHoverContext({ lines: ['const char* s = "// literal";'], languageId: 'cpp', targetLine: 1 }),
    buildHoverContext({ lines: ['/* unterminated'], languageId: 'cpp', targetLine: 1 }),
    buildHoverContext({
      lines: ['doc = """', '# inside a string', '"""'],
      languageId: 'python',
      targetLine: 2,
    }),
    buildHoverContext({
      lines: ['auto raw = R"tag(', '// raw content', ')tag";'],
      languageId: 'cpp',
      targetLine: 2,
    }),
  ];
  for (const result of ambiguous) {
    strictEqual(result.kind, 'context');
  }
});

test('buildHoverContext strips individual C++ block comments before skipping', () => {
  for (const line of ['/* a */ /* b */', '/* a */ // tail', '/**/']) {
    deepStrictEqual(
      buildHoverContext({ lines: [line], languageId: 'cpp', targetLine: 1 }),
      { kind: 'none', reason: 'comment-only' },
    );
  }

  for (const line of [
    '/* a */ int x;',
    'int x; /* a */',
    '/* a */ /* b */ int x;',
    '/* open',
  ]) {
    const result = buildHoverContext({ lines: [line], languageId: 'cpp', targetLine: 1 });
    strictEqual(result.kind, 'context');
  }
});

test('buildHoverContext uses provider statement ranges and rejects enclosing bodies', () => {
  const python = [
    'def run(value):',
    '    if value:',
    '        result = compute(',
    '            value,',
    '        )',
    '        return result',
    '    return None',
  ];
  const pythonResult = buildHoverContext({
    lines: python,
    languageId: 'python',
    targetLine: 4,
    selectionRanges: [
      { start: 3, end: 5 },
      { start: 2, end: 6 },
      { start: 1, end: 7 },
    ],
  });
  strictEqual(pythonResult.kind, 'context');
  if (pythonResult.kind === 'context') {
    deepStrictEqual(pythonResult.statementRange, lr(3, 5));
    strictEqual(pythonResult.includesFullStatement, true);
    ok(pythonResult.prompt.includes('4 |             value,'));
  }

  const cpp = [
    'int main() {',
    '    int total = add(',
    '        1,',
    '        2);',
    '    return total;',
    '}',
  ];
  const cppResult = buildHoverContext({
    lines: cpp,
    languageId: 'cpp',
    targetLine: 3,
    selectionRanges: [
      { start: 2, end: 4 },
      { start: 1, end: 6 },
    ],
  });
  strictEqual(cppResult.kind, 'context');
  if (cppResult.kind === 'context') {
    deepStrictEqual(cppResult.statementRange, lr(2, 4));
    strictEqual(cppResult.includesFullStatement, true);
    ok(cppResult.prompt.includes('        1,'));
  }

  const header = buildHoverContext({
    lines: ['if flag:', '    do_work()', '    log()'],
    languageId: 'python',
    targetLine: 1,
    selectionRanges: [{ start: 1, end: 3 }],
  });
  strictEqual(header.kind, 'context');
  if (header.kind === 'context') {
    strictEqual(header.statementRange, null);
    strictEqual(header.includesFullStatement, false);
  }
});

test('buildHoverContext rejects whole-document and generic ranges but allows real continuation', () => {
  const whole = buildHoverContext({
    lines: ['result = (', '    1 +', '    2)'],
    languageId: 'python',
    targetLine: 2,
    selectionRanges: [{ start: 1, end: 3 }],
  });
  strictEqual(whole.kind, 'context');
  if (whole.kind === 'context') {
    strictEqual(whole.statementRange, null);
  }

  const generic = buildHoverContext({
    lines: ['header', 'import os', 'value = 1', 'other = 2'],
    languageId: 'python',
    targetLine: 3,
    selectionRanges: [{ start: 1, end: 3 }],
  });
  strictEqual(generic.kind, 'context');
  if (generic.kind === 'context') {
    strictEqual(generic.statementRange, null);
  }

  const continuation = buildHoverContext({
    lines: ['result = (', '    1 +', '    2)', 'tail'],
    languageId: 'python',
    targetLine: 2,
    selectionRanges: [{ start: 1, end: 3 }],
  });
  strictEqual(continuation.kind, 'context');
  if (continuation.kind === 'context') {
    deepStrictEqual(continuation.statementRange, lr(1, 3));
    strictEqual(continuation.includesFullStatement, true);
  }
});

test('buildHoverContext falls back to limited neighbors with original numbering', () => {
  const lines = Array.from({ length: 9 }, (_, index) => `line ${index + 1}`);
  const result = buildHoverContext({ lines, languageId: 'cpp', targetLine: 5 });
  strictEqual(result.kind, 'context');
  if (result.kind !== 'context') return;

  strictEqual(result.statementRange, null);
  strictEqual(result.includesFullStatement, false);
  deepStrictEqual(result.ranges, [lr(3, 7)]);
  ok(result.prompt.includes('5 | line 5'));
  ok(!result.prompt.includes('1 | line 1'));
});

test('buildHoverContext includes signatures and respects the 4 KiB budget', () => {
  const lines = [
    'def outer(x):',
    ...Array.from({ length: 20 }, (_, index) => `    work_${index + 1}()`),
  ];
  const result = buildHoverContext({
    lines,
    languageId: 'python',
    targetLine: 12,
    selectionRanges: [{ start: 12, end: 12 }],
    symbols: [{ range: lr(1, 21), signatureRange: lr(1, 1) }],
  });
  strictEqual(result.kind, 'context');
  if (result.kind !== 'context') return;

  deepStrictEqual(result.signatureRange, lr(1, 1));
  strictEqual(result.includesFullStatement, true);
  ok(result.prompt.includes('1 | def outer(x):'));
  ok(result.prompt.includes('12 |     work_11()'));
  ok(result.byteLength <= HOVER_CONTEXT_BUDGET_BYTES);
  strictEqual(result.byteLength, Buffer.byteLength(result.prompt, 'utf8'));
});

test('buildHoverContext falls back locally when the full statement exceeds the budget', () => {
  const lines = ['// header', 'result = call('];
  for (let index = 1; index <= 33; index += 1) {
    lines.push(`    arg_${index},`);
  }
  lines.push(')');

  const budget = 180;
  const result = buildHoverContext({
    lines,
    languageId: 'python',
    targetLine: 19,
    selectionRanges: [{ start: 2, end: lines.length }],
    budgetBytes: budget,
  });
  strictEqual(result.kind, 'context');
  if (result.kind !== 'context') return;

  strictEqual(result.statementRange, null);
  strictEqual(result.includesFullStatement, false);
  strictEqual(result.truncated, true);
  deepStrictEqual(result.ranges, [lr(17, 21)]);
  ok(result.prompt.includes('19 |     arg_17,'));
  ok(!result.prompt.includes('2 | result = call('));
  ok(result.byteLength <= budget);
  strictEqual(result.byteLength, Buffer.byteLength(result.prompt, 'utf8'));
});

test('buildHoverContext returns over-budget when the target line cannot fit', () => {
  const lines = ['x'.repeat(5000)];
  deepStrictEqual(
    buildHoverContext({ lines, languageId: 'python', targetLine: 1 }),
    { kind: 'none', reason: 'over-budget' },
  );
});

test('collectHoverContext combines providers and falls back on provider errors', async () => {
  const lines = ['def run(x):', '    return x + 1'];
  const doc = makeDocument(lines, 'python');
  const { executor, calls } = makeExecutor((command) => {
    if (command === 'vscode.executeDocumentSymbolProvider') {
      return [
        {
          name: 'run',
          kind: 11,
          range: vscodeRange(0, 0, 2, 0),
          selectionRange: vscodeRange(0, 4, 0, 7),
          children: [],
        },
      ];
    }
    if (command === 'vscode.executeSelectionRangeProvider') {
      return [
        {
          range: vscodeRange(1, 4, 1, 12),
          parent: { range: vscodeRange(0, 0, 2, 0) },
        },
      ];
    }
    return undefined;
  });

  const result = await collectHoverContext(executor, doc, { line: 1, character: 8 });
  strictEqual(result.kind, 'context');
  if (result.kind === 'context') {
    deepStrictEqual(result.statementRange, lr(2, 2));
    deepStrictEqual(result.signatureRange, lr(1, 1));
    ok(result.prompt.includes('1 | def run(x):'));
    ok(result.prompt.includes('2 |     return x + 1'));
  }
  strictEqual(calls.length, 2);

  const failing: CommandExecutor = async () => {
    throw new Error('no providers');
  };
  const fallback = await collectHoverContext(failing, doc, { line: 1, character: 8 });
  strictEqual(fallback.kind, 'context');
  if (fallback.kind === 'context') {
    strictEqual(fallback.statementRange, null);
    ok(fallback.prompt.includes('2 |     return x + 1'));
  }

  let callsAfter = 0;
  const skipped = await collectHoverContext(
    () => {
      callsAfter += 1;
      return undefined;
    },
    makeDocument(['# only a comment'], 'python'),
    { line: 0, character: 2 },
  );
  deepStrictEqual(skipped, { kind: 'none', reason: 'comment-only' });
  strictEqual(callsAfter, 0);
});

test('collectHoverContext reuses snapshots and discards version races', async () => {
  let lineReads = 0;
  const doc: MutableDocument = {
    uri: { scheme: 'file', path: '/cache' },
    languageId: 'python',
    version: 1,
    lineCount: 3,
    lineAt(line: number) {
      lineReads += 1;
      return { text: ['x = 1', 'y = 2', 'z = 3'][line] ?? '' };
    },
  };
  const noProviders: CommandExecutor = () => {
    throw new Error('no providers');
  };

  await collectHoverContext(noProviders, doc, { line: 1, character: 0 });
  strictEqual(lineReads, 3);
  await collectHoverContext(noProviders, doc, { line: 1, character: 0 });
  strictEqual(lineReads, 3);

  doc.version = 2;
  await collectHoverContext(noProviders, doc, { line: 1, character: 0 });
  ok(lineReads > 3);

  const raced = makeDocument(['def f():', '    return 1']);
  const racing: CommandExecutor = () => {
    raced.version += 1;
    return [];
  };
  deepStrictEqual(
    await collectHoverContext(racing, raced, { line: 1, character: 8 }),
    { kind: 'none', reason: 'stale' },
  );
});
