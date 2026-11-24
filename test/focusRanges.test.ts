import { test } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';

import {
  FOCUS_SOURCE_BUDGET_BYTES,
  FocusRangeError,
  isSmallFocusSnapshot,
  mergeRanges,
  planFocusPrompt,
  remapTerminalBlankLineRemoval,
  renderNumberedPrompt,
  subtractRanges,
  validateCore,
  type FocusPlanInput,
  type LineRange,
  type SymbolSpan,
} from '../src/focusRanges.ts';

const range = (start: number, end: number): LineRange => ({ start, end });
const spans = (start: number, end: number, signature: [number, number] = [start, start]): SymbolSpan => ({
  range: range(start, end),
  signatureRange: range(signature[0], signature[1]),
});
const numberedBytes = (text: string): number => Buffer.byteLength(text, 'utf8');

const planInput = (overrides: Partial<FocusPlanInput> = {}): FocusPlanInput => ({
  lines: Array.from({ length: 80 }, (_, index) => `line ${index + 1} of source`),
  visibleRanges: [range(30, 50)],
  symbols: [spans(30, 50, [30, 31])],
  previousCoverage: [],
  dwellConfirmed: true,
  ...overrides,
});

test('mergeRanges merges overlap and adjacency and sorts', () => {
  deepStrictEqual(
    mergeRanges([range(12, 14), range(1, 8), range(3, 5), range(8, 9), range(20, 20)]),
    [range(1, 9), range(12, 14), range(20, 20)],
  );
  deepStrictEqual(mergeRanges([]), []);
});

test('mergeRanges rejects malformed or reversed one-based ranges', () => {
  for (const bad of [range(0, 2), range(2, 1), range(1.5, 3), range(1, Number.NaN)]) {
    throws(
      () => mergeRanges([bad]),
      (error: unknown) => error instanceof FocusRangeError && error.code === 'invalid-range',
    );
  }
});

test('subtractRanges returns the inclusive complement inside coverage gaps', () => {
  deepStrictEqual(subtractRanges([range(1, 8), range(12, 14)], [range(2, 4), range(13, 13)]), [
    range(1, 1),
    range(5, 8),
    range(12, 12),
    range(14, 14),
  ]);
});

test('subtractRanges handles empty, full and out-of-range removal', () => {
  deepStrictEqual(subtractRanges([range(1, 5)], []), [range(1, 5)]);
  deepStrictEqual(subtractRanges([range(1, 5)], [range(1, 5)]), []);
  deepStrictEqual(subtractRanges([range(1, 5)], [range(10, 20)]), [range(1, 5)]);
  deepStrictEqual(subtractRanges([], [range(1, 2)]), []);
});

test('validateCore accepts the specified model example and merges legal overlaps', () => {
  deepStrictEqual(validateCore('[[2,3],[3,4],[13,13]]', [range(1, 8), range(12, 14)]), [
    range(2, 4),
    range(13, 13),
  ]);
  deepStrictEqual(validateCore('[[1,8],[12,14]]', [range(1, 14)]), [range(1, 8), range(12, 14)]);
});

test('validateCore rejects malformed or empty model output', () => {
  const coverage = [range(1, 10)];
  const cases: Array<[string, string]> = [
    ['', 'malformed-json'],
    ['not json', 'malformed-json'],
    ['{}', 'not-array'],
    ['null', 'not-array'],
    ['[]', 'empty'],
    ['[[1]]', 'invalid-entry'],
    ['[[1,2,3]]', 'invalid-entry'],
    ['[["1",2]]', 'invalid-entry'],
    ['[[1,2.5]]', 'invalid-range'],
    ['[[0,2]]', 'invalid-range'],
    ['[[5,2]]', 'invalid-range'],
  ];
  for (const [raw, code] of cases) {
    throws(
      () => validateCore(raw, coverage),
      (error: unknown) => error instanceof FocusRangeError && error.code === code,
    );
  }
});

test('validateCore rejects ranges outside coverage and ranges crossing uncovered gaps', () => {
  const coverage = [range(1, 8), range(12, 14)];
  throws(
    () => validateCore('[[9,10]]', coverage),
    (error: unknown) => error instanceof FocusRangeError && error.code === 'outside-coverage',
  );
  throws(
    () => validateCore('[[8,12]]', coverage),
    (error: unknown) => error instanceof FocusRangeError && error.code === 'crosses-gap',
  );
  throws(
    () => validateCore('[[14,15]]', coverage),
    (error: unknown) => error instanceof FocusRangeError && error.code === 'crosses-gap',
  );
});

test('small snapshots fit by the exact numbered-byte budget', () => {
  const lines = ['alpha', 'béta', 'gamma'];
  const prompt = renderNumberedPrompt(lines, [range(1, 3)]);
  const bytes = numberedBytes(prompt);

  ok(isSmallFocusSnapshot(lines, [], bytes));
  ok(!isSmallFocusSnapshot(lines, [], bytes - 1));

  const exact = planFocusPrompt(planInput({ lines, visibleRanges: [range(1, 3)], symbols: [], budgetBytes: bytes }));
  strictEqual(exact.kind, 'prompt');
  if (exact.kind === 'prompt') {
    strictEqual(exact.target, 'whole');
    deepStrictEqual(exact.coverage, [range(1, 3)]);
    deepStrictEqual(exact.signatureOnly, []);
    strictEqual(numberedBytes(exact.prompt), bytes);
  }

  const tooSmall = planFocusPrompt(
    planInput({ lines, visibleRanges: [range(1, 3)], symbols: [spans(1, 3)], budgetBytes: bytes - 1 }),
  );
  strictEqual(tooSmall.kind, 'prompt');
  if (tooSmall.kind === 'prompt') ok(tooSmall.target !== 'whole');
});

test('isSmallFocusSnapshot stops scanning once the byte budget is exceeded', () => {
  let reads = 0;
  const lines = new Proxy(['x'.repeat(80), 'must not be read'], {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        reads += 1;
        if (reads > 1) throw new Error('scanned past the exceeded budget');
      }
      return Reflect.get(target, property, receiver);
    },
  });
  ok(!isSmallFocusSnapshot(lines, [], 10));
  strictEqual(reads, 1);
});

test('small snapshots use the default 24 KiB budget and numbered source', () => {
  strictEqual(FOCUS_SOURCE_BUDGET_BYTES, 24 * 1024);
  const lines = ['def f():', '    return 1'];
  const plan = planFocusPrompt(planInput({ lines, visibleRanges: [range(1, 2)], symbols: [] }));
  strictEqual(plan.kind, 'prompt');
  if (plan.kind === 'prompt') {
    strictEqual(plan.prompt, '1 | def f():\n2 |     return 1');
    strictEqual(plan.target, 'whole');
  }
});

test('long snapshots defer until the caller confirms dwell', () => {
  const plan = planFocusPrompt(
    planInput({ lines: Array.from({ length: 60 }, (_, i) => `source ${i + 1}`), budgetBytes: 120, dwellConfirmed: false }),
  );
  deepStrictEqual(plan, { kind: 'none', reason: 'await-dwell' });
});

test('long snapshots require overlapping symbols instead of sending nonvisible slices', () => {
  const plan = planFocusPrompt(
    planInput({ lines: Array.from({ length: 60 }, (_, i) => `source ${i + 1}`), symbols: [], budgetBytes: 120 }),
  );
  deepStrictEqual(plan, { kind: 'none', reason: 'no-symbols' });
});

test('long snapshots pick the overlapping symbol nearest the viewport center', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `source ${i + 1}`);
  const far = spans(30, 33);
  const near = spans(44, 48);
  const budget = numberedBytes(renderNumberedPrompt(lines, [near.range]));
  const plan = planFocusPrompt(
    planInput({ lines, visibleRanges: [range(30, 50)], symbols: [far, near], budgetBytes: budget }),
  );

  strictEqual(plan.kind, 'prompt');
  if (plan.kind === 'prompt') {
    strictEqual(plan.target, 'symbols');
    deepStrictEqual(plan.coverage, [near.range]);
    deepStrictEqual(plan.signatureOnly, []);
    ok(numberedBytes(plan.prompt) <= budget);
  }
});

test('fully covered viewports produce no request, and covered symbols are skipped', () => {
  const covered = planFocusPrompt(planInput({ previousCoverage: [range(25, 55)] }));
  deepStrictEqual(covered, { kind: 'none', reason: 'already-covered' });

  const lines = Array.from({ length: 80 }, (_, i) => `source line ${i + 1}`);
  const lower = spans(30, 40);
  const upper = spans(41, 50);
  const budget = numberedBytes(renderNumberedPrompt(lines, [upper.range]));
  const partial = planFocusPrompt(
    planInput({
      lines,
      visibleRanges: [range(30, 50)],
      symbols: [lower, upper],
      previousCoverage: [range(30, 40)],
      budgetBytes: budget,
    }),
  );

  strictEqual(partial.kind, 'prompt');
  if (partial.kind === 'prompt') deepStrictEqual(partial.coverage, [upper.range]);
});

test('oversized symbols fall back to visible chunks plus an explicit signature-only range', () => {
  const lines = Array.from({ length: 70 }, (_, i) => `    behavior_${i + 1}(value);`);
  const outer = spans(5, 60, [5, 6]);
  const budget = 260;
  ok(numberedBytes(renderNumberedPrompt(lines, [outer.range])) > budget);

  const plan = planFocusPrompt(
    planInput({
      lines,
      visibleRanges: [range(20, 26)],
      symbols: [outer],
      budgetBytes: budget,
      dwellConfirmed: true,
    }),
  );

  strictEqual(plan.kind, 'prompt');
  if (plan.kind === 'prompt') {
    strictEqual(plan.target, 'visible-fallback');
    deepStrictEqual(plan.coverage, [range(20, 26)]);
    deepStrictEqual(plan.signatureOnly, [range(5, 6)]);
    ok(numberedBytes(plan.prompt) <= budget);
    ok(!plan.prompt.includes('behavior_10(value);'));
    ok(plan.prompt.includes('5 |     behavior_5(value);'));
  }
});

test('visible fallback trims to budget without crossing into nonvisible code', () => {
  const lines = Array.from({ length: 120 }, (_, i) => `    operation_${i + 1}();`);
  const outer = spans(1, 120, [1, 1]);
  const budget = 240;
  const plan = planFocusPrompt(
    planInput({
      lines,
      visibleRanges: [range(30, 90)],
      symbols: [outer],
      budgetBytes: budget,
    }),
  );

  strictEqual(plan.kind, 'prompt');
  if (plan.kind === 'prompt') {
    strictEqual(plan.target, 'visible-fallback');
    ok(numberedBytes(plan.prompt) <= budget);
    ok(plan.coverage.length > 0);
    for (const part of plan.coverage) {
      ok(part.start >= 30 && part.end <= 90);
      ok(part.end - part.start + 1 <= 61);
    }
    deepStrictEqual(plan.signatureOnly, [range(1, 1)]);
  }
});

test('fallback skips an oversized center line and fits neighboring visible lines', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `source ${i + 1}`);
  lines[29] = 'z'.repeat(2000);
  const outer = spans(5, 55, [5, 5]);
  const budget = numberedBytes(
    renderNumberedPrompt(lines, [range(5, 5), range(27, 29), range(31, 33)]),
  );

  const plan = planFocusPrompt(
    planInput({
      lines,
      visibleRanges: [range(20, 40)],
      symbols: [outer],
      budgetBytes: budget,
    }),
  );

  strictEqual(plan.kind, 'prompt');
  if (plan.kind === 'prompt') {
    strictEqual(plan.target, 'visible-fallback');
    ok(numberedBytes(plan.prompt) <= budget);
    ok(plan.coverage.length > 0);
    ok(!plan.coverage.some((part) => part.start <= 30 && 30 <= part.end));
    ok(plan.coverage.some((part) => part.start <= 29 && 29 <= part.end));
    ok(plan.coverage.some((part) => part.start <= 31 && 31 <= part.end));
    deepStrictEqual(plan.signatureOnly, [range(5, 5)]);
  }
});

test('an over-budget fallback continues to a farther overlapping symbol', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `source ${i + 1}`);
  lines[29] = 'z'.repeat(2000);
  const enclosing = spans(28, 32, [30, 30]);
  const smaller = spans(35, 38, [35, 35]);
  const budget = numberedBytes(renderNumberedPrompt(lines, [range(35, 38)])) + 4;

  const plan = planFocusPrompt(
    planInput({
      lines,
      visibleRanges: [range(20, 40)],
      symbols: [enclosing, smaller],
      budgetBytes: budget,
    }),
  );

  strictEqual(plan.kind, 'prompt');
  if (plan.kind === 'prompt') {
    strictEqual(plan.target, 'symbols');
    deepStrictEqual(plan.coverage, [range(35, 38)]);
    deepStrictEqual(plan.signatureOnly, []);
    ok(numberedBytes(plan.prompt) <= budget);
    ok(!plan.prompt.includes('z'.repeat(10)));
  }
});

test('folded lines are never sent or counted as covered', () => {
  const lines = ['def f():', '    hidden = 1', '    return hidden', 'def g():', '    return 2'];
  const whole = planFocusPrompt(
    planInput({
      lines,
      visibleRanges: [range(1, 5)],
      symbols: [],
      foldedRanges: [range(2, 2)],
      budgetBytes: 1024,
    }),
  );

  strictEqual(whole.kind, 'prompt');
  if (whole.kind === 'prompt') {
    deepStrictEqual(whole.coverage, [range(1, 1), range(3, 5)]);
    ok(!whole.prompt.includes('hidden = 1'));
    ok(whole.prompt.includes('3 |     return hidden'));
  }

  const long = planFocusPrompt(
    planInput({
      lines: Array.from({ length: 80 }, (_, i) => `source ${i + 1}`),
      visibleRanges: [range(20, 30)],
      symbols: [spans(20, 30, [20, 20])],
      foldedRanges: [range(25, 25)],
      budgetBytes: 400,
    }),
  );
  strictEqual(long.kind, 'prompt');
  if (long.kind === 'prompt') {
    deepStrictEqual(long.coverage, [range(20, 24), range(26, 30)]);
    ok(!long.prompt.includes('25 | '));
  }
});

test('empty source and empty viewports produce no prompt', () => {
  deepStrictEqual(planFocusPrompt(planInput({ lines: [] })), { kind: 'none', reason: 'empty-source' });
  deepStrictEqual(planFocusPrompt(planInput({ visibleRanges: [], symbols: [] })), {
    kind: 'none',
    reason: 'no-visible-lines',
  });
});

test('very small budgets can reject a fallback that cannot carry even context', () => {
  const plan = planFocusPrompt(
    planInput({
      lines: Array.from({ length: 80 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`),
      visibleRanges: [range(20, 30)],
      symbols: [spans(10, 70, [10, 11])],
      budgetBytes: 20,
    }),
  );
  deepStrictEqual(plan, { kind: 'none', reason: 'over-budget' });
});

test('renderNumberedPrompt keeps original one-based line numbers across gaps', () => {
  strictEqual(
    renderNumberedPrompt(['a', 'b', 'c', 'd'], [range(1, 1), range(4, 4)]),
    '1 | a\n4 | d',
  );
  throws(() => renderNumberedPrompt(['a'], [range(1, 2)]), FocusRangeError);
});

test('terminal blank-line removal reuses coverage that ends before the tail', () => {
  const previous = 'def f():\n    return 1\n\n\n';
  const current = 'def f():\n    return 1\n';
  const remapped = remapTerminalBlankLineRemoval({
    previousText: previous,
    currentText: current,
    coverage: [range(1, 2)],
    core: [range(2, 2)],
  });
  deepStrictEqual(remapped, { coverage: [range(1, 2)], core: [range(2, 2)] });
});

test('terminal blank-line removal works with CRLF and identical text', () => {
  deepStrictEqual(
    remapTerminalBlankLineRemoval({
      previousText: 'int main() {\r\n\r\n',
      currentText: 'int main() {\r\n',
      coverage: [range(1, 1)],
      core: [range(1, 1)],
    }),
    { coverage: [range(1, 1)], core: [range(1, 1)] },
  );
  deepStrictEqual(
    remapTerminalBlankLineRemoval({
      previousText: 'a\n',
      currentText: 'a\n',
      coverage: [range(1, 1)],
      core: [range(1, 1)],
    }),
    { coverage: [range(1, 1)], core: [range(1, 1)] },
  );
  deepStrictEqual(
    remapTerminalBlankLineRemoval({
      previousText: 'a\n \n\n',
      currentText: 'a\n \n',
      coverage: [range(1, 1)],
      core: [range(1, 1)],
    }),
    { coverage: [range(1, 1)], core: [range(1, 1)] },
  );
});

test('terminal blank-line removal refuses coverage that touches the removed tail', () => {
  strictEqual(
    remapTerminalBlankLineRemoval({
      previousText: 'a\nb\n\n',
      currentText: 'a\nb\n',
      coverage: [range(1, 3)],
      core: [range(2, 3)],
    }),
    null,
  );
});

test('terminal blank-line removal refuses semantic and mid-file changes', () => {
  const base = { coverage: [range(1, 1)], core: [range(1, 1)] };
  const cases: Array<[string, string]> = [
    ['a\nb\n\n', 'a\nc\n'],
    ['a\n\nb\n', 'a\nb\n'],
    ['a\nb', 'a\nb\n\n'],
    ['a\nb\n', 'a\n'],
    ['a\n \n\n', 'a\n\t\n'],
    ['a\r\n\r\n', 'a\n'],
  ];
  for (const [previousText, currentText] of cases) {
    strictEqual(remapTerminalBlankLineRemoval({ ...base, previousText, currentText }), null);
  }
});

test('terminal blank-line removal requires newline termination and unchanged final line', () => {
  strictEqual(
    remapTerminalBlankLineRemoval({
      previousText: 'a\nb\n\n',
      currentText: 'a\nb',
      coverage: [range(1, 2)],
      core: [range(1, 1)],
    }),
    null,
  );
  strictEqual(
    remapTerminalBlankLineRemoval({
      previousText: 'if flag:\n    go()\n\n',
      currentText: 'if other:\n    go()\n',
      coverage: [range(2, 2)],
      core: [range(2, 2)],
    }),
    null,
  );
});
