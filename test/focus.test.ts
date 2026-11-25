import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFocusPrompt,
  FocusController,
  FOCUS_VIEWPORT_DWELL_MS,
  type FocusDocument,
  type FocusEditor,
  type FocusTimer,
} from '../src/focus.ts';
import type { LineRange, SymbolSpan } from '../src/focusRanges.ts';

interface FakeRange {
  start: { line: number };
  end: { line: number };
}

class FakeDocument implements FocusDocument {
  readonly uri: { toString(): string };
  text: string;
  version: number;
  readonly languageId: string;
  isClosed = false;

  constructor(uri: string, text: string, version = 1) {
    this.uri = { toString: () => uri };
    this.text = text;
    this.version = version;
    this.languageId = uri.endsWith('.cpp') ? 'cpp' : 'python';
  }

  get lineCount(): number {
    return this.text.split('\n').length;
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
    this.version += 1;
  }
}

class FakeEditor implements FocusEditor {
  visibleRanges: readonly FakeRange[];

  constructor(readonly document: FakeDocument, ranges: ReadonlyArray<readonly [number, number]>) {
    this.visibleRanges = FakeEditor.ranges(ranges);
  }

  static ranges(ranges: ReadonlyArray<readonly [number, number]>): FakeRange[] {
    return ranges.map(([start, end]) => ({
      start: { line: start },
      end: { line: end },
    }));
  }

  setVisible(ranges: ReadonlyArray<readonly [number, number]>): void {
    this.visibleRanges = FakeEditor.ranges(ranges);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface TimerRecord {
  readonly at: number;
  readonly callback: () => void;
}

class FakeClock {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, TimerRecord>();

  readonly schedule = (callback: () => void, delayMs: number): FocusTimer => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.time + Math.max(0, delayMs), callback });
    return {
      cancel: () => {
        this.timers.delete(id);
      },
    };
  };

  get pending(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      let selectedId: number | undefined;
      let selected: TimerRecord | undefined;
      for (const [id, record] of this.timers) {
        if (record.at > target) continue;
        if (selected === undefined || record.at < selected.at) {
          selectedId = id;
          selected = record;
        }
      }
      if (selected === undefined || selectedId === undefined) break;
      this.timers.delete(selectedId);
      this.time = selected.at;
      selected.callback();
      await flushMicrotasks();
    }
    this.time = target;
  }
}

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface CapturedRequest {
  readonly prompt: string;
  readonly generation: number;
  readonly canSend: () => boolean;
  readonly deferred: Deferred<string>;
}

interface HarnessOptions {
  readonly symbols?: (editor: FakeEditor) => Promise<readonly SymbolSpan[]>;
  readonly isActive?: (editor: FakeEditor) => boolean;
  readonly cacheLimit?: number;
  readonly cacheBytes?: number;
  readonly budgetBytes?: number;
  readonly dwellMs?: number;
}

function harness(options: HarnessOptions = {}) {
  const clock = new FakeClock();
  let generation = 1;
  const requests: CapturedRequest[] = [];
  const applies: LineRange[][] = [];
  const notifications: string[] = [];
  const diagnostics: string[] = [];
  const symbolCalls: FakeEditor[] = [];
  const symbolSource: (editor: FakeEditor) => Promise<readonly SymbolSpan[]> =
    options.symbols ?? (async () => []);

  const controller = new FocusController<FakeEditor>({
    request: (prompt, requestGeneration, canSend) => {
      const pending = deferred<string>();
      requests.push({
        prompt,
        generation: requestGeneration,
        canSend,
        deferred: pending,
      });
      return pending.promise;
    },
    generation: () => generation,
    symbols: async (editor) => {
      symbolCalls.push(editor);
      return symbolSource(editor);
    },
    apply: (_editor, dim) => {
      applies.push(dim.map((range) => ({ start: range.start, end: range.end })));
    },
    notify: (message) => {
      notifications.push(message);
    },
    diagnostic: (kind) => {
      diagnostics.push(kind);
    },
    isActive: options.isActive,
    scheduleTimeout: clock.schedule,
    dwellMs: options.dwellMs,
    cacheLimit: options.cacheLimit,
    cacheBytes: options.cacheBytes,
    budgetBytes: options.budgetBytes,
  });

  return {
    controller,
    clock,
    requests,
    applies,
    notifications,
    diagnostics,
    symbolCalls,
    get generation(): number {
      return generation;
    },
    setGeneration(value: number): void {
      generation = value;
    },
    lastApply(): LineRange[] | undefined {
      return applies[applies.length - 1];
    },
    async respond(index: number, raw: string): Promise<void> {
      const request = requests[index];
      assert.ok(request, `missing request ${index}`);
      request.deferred.resolve(raw);
      await flushMicrotasks();
    },
    async reject(index: number, error: unknown): Promise<void> {
      const request = requests[index];
      assert.ok(request, `missing request ${index}`);
      request.deferred.reject(error);
      await flushMicrotasks();
    },
  };
}

const range = (start: number, end: number): LineRange => ({ start, end });
const span = (
  start: number,
  end: number,
  signatureStart: number = start,
  signatureEnd: number = signatureStart,
): SymbolSpan => ({
  range: range(start, end),
  signatureRange: range(signatureStart, signatureEnd),
});

function smallDocument(uri = 'file:///small.py'): FakeDocument {
  return new FakeDocument(uri, Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n'));
}

function longText(lineCount = 1_000): string {
  return Array.from(
    { length: lineCount },
    (_, index) => `line ${index + 1} ${'x'.repeat(48)}`,
  ).join('\n');
}

function longDocument(): FakeDocument {
  return new FakeDocument('file:///long.py', longText());
}

test('logs the validation code and rejected response without applying decorations', async () => {
  const h = harness();
  h.controller.toggle(new FakeEditor(smallDocument(), [[0, 19]]));
  await flushMicrotasks();
  await h.respond(0, '[\n  {"start":2,"end":3}\n]');

  assert.deepEqual(h.diagnostics.filter((entry) => entry.startsWith('validation.failed ')), [
    'validation.failed code=invalid-entry response="[\\n  {\\"start\\":2,\\"end\\":3}\\n]"',
  ]);
  assert.equal(h.lastApply(), undefined);
});

test('dims only the validated complement of the transmitted coverage', async () => {
  const h = harness();
  const document = new FakeDocument(
    'file:///small.py',
    Array.from({ length: 14 }, (_, index) => `body line ${index + 1}`).join('\n'),
  );
  const editor = new FakeEditor(document, [[0, 7], [11, 13]]);

  h.controller.toggle(editor);
  await flushMicrotasks();

  assert.equal(h.requests.length, 1);
  const prompt = h.requests[0]!.prompt;
  assert.ok(
    prompt.startsWith(
      'Analyze only these one-based inclusive line ranges: [[1,8],[12,14]].\n',
    ),
  );
  assert.doesNotMatch(prompt, /^9 \|/m);
  assert.doesNotMatch(prompt, /^10 \|/m);
  assert.doesNotMatch(prompt, /^11 \|/m);
  assert.equal(h.symbolCalls.length, 0);

  await h.respond(0, '[[2,3],[3,4],[13,13]]');

  assert.deepEqual(h.lastApply(), [
    range(1, 1),
    range(5, 8),
    range(12, 12),
    range(14, 14),
  ]);
  assert.ok(h.diagnostics.includes('viewport core=4 dimmed=7 unanalyzed=0'));
});

test('long viewports send once after a stable 1.2s dwell', async () => {
  const h = harness({ symbols: async () => [span(100, 250, 100, 101)] });
  const document = longDocument();
  const editor = new FakeEditor(document, [[99, 199]]);

  h.controller.toggle(editor);
  assert.equal(h.requests.length, 0);

  await h.clock.advance(600);
  editor.setVisible([[109, 209]]);
  h.controller.onViewport(editor);

  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS - 1);
  assert.equal(h.requests.length, 0);

  await h.clock.advance(1);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.generation, 1);
  assert.ok(
    h.requests[0]!.prompt.startsWith(
      'Analyze only these one-based inclusive line ranges: [[100,250]].\n',
    ),
  );
  assert.ok(Buffer.byteLength(h.requests[0]!.prompt, 'utf8') <= 24 * 1024 + 256);

  await h.respond(0, '[[110,120]]');
  assert.deepEqual(h.lastApply(), [range(100, 109), range(121, 250)]);
  assert.ok(h.diagnostics.includes('viewport core=11 dimmed=90 unanalyzed=0'));
});

test('long snapshots never send without symbols', async () => {
  const h = harness();
  const editor = new FakeEditor(longDocument(), [[99, 199]]);

  h.controller.toggle(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();

  assert.equal(h.requests.length, 0);
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0]!, /symbol/i);
  assert.ok(h.diagnostics.includes('skip:no-symbols'));
  assert.ok(h.diagnostics.includes('viewport core=0 dimmed=0 unanalyzed=101'));
});

test('repeating or shifting inside analyzed coverage sends nothing new', async () => {
  const h = harness({ symbols: async () => [span(100, 250, 100, 101)] });
  const editor = new FakeEditor(longDocument(), [[99, 199]]);

  h.controller.toggle(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);
  await h.respond(0, '[[110,120]]');

  editor.setVisible([[119, 219]]);
  h.controller.onViewport(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();

  assert.equal(h.requests.length, 1);
  assert.ok(h.diagnostics.includes('skip:already-covered'));
  assert.equal(h.symbolCalls.length, 1);

  h.controller.onViewport(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  assert.equal(h.requests.length, 1);
});

test('an overlapping in-flight span is shared instead of requested twice', async () => {
  const h = harness({ symbols: async () => [span(100, 250, 100, 101)] });
  const editor = new FakeEditor(longDocument(), [[99, 199]]);

  h.controller.toggle(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);

  editor.setVisible([[149, 239]]);
  h.controller.onViewport(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);

  await h.respond(0, '[[110,120]]');

  assert.equal(h.requests.length, 1);
  assert.ok(h.diagnostics.includes('dedup'));
  assert.deepEqual(h.lastApply(), [range(100, 109), range(121, 250)]);
});

test('a small edit clears decorations and reruns only after toggle off then on', async () => {
  const h = harness();
  const document = smallDocument();
  const editor = new FakeEditor(document, [[0, 19]]);

  h.controller.toggle(editor);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);
  await h.respond(0, '[[1,10]]');
  assert.deepEqual(h.lastApply(), [range(11, 20)]);

  document.setText(
    Array.from({ length: 21 }, (_, index) => `line ${index + 1}`).join('\n'),
  );
  h.controller.onChange(document);
  await flushMicrotasks();

  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.lastApply(), []);
  assert.equal(h.controller.isEnabled(editor), true);

  h.controller.toggle(editor);
  assert.equal(h.controller.isEnabled(editor), false);
  assert.equal(h.requests.length, 1);

  h.controller.toggle(editor);
  await flushMicrotasks();
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests[1]!.prompt.startsWith('Analyze only these one-based inclusive line ranges: [[1,21]].\n'));

  await h.respond(1, '[[1,5]]');
  assert.deepEqual(h.lastApply(), [range(6, 21)]);
});

test('a long edit clears immediately and waits for a stable viewport', async () => {
  const h = harness({ symbols: async () => [span(100, 250, 100, 101)] });
  const document = longDocument();
  const editor = new FakeEditor(document, [[99, 199]]);

  h.controller.toggle(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);
  await h.respond(0, '[[100,100]]');
  assert.deepEqual(h.lastApply(), [range(101, 250)]);

  document.setText(`${document.text}\ninserted tail`);
  h.controller.onChange(document);
  await flushMicrotasks();
  assert.deepEqual(h.lastApply(), []);
  assert.equal(h.requests.length, 1);

  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS - 1);
  assert.equal(h.requests.length, 1);
  await h.clock.advance(1);
  await flushMicrotasks();
  assert.equal(h.requests.length, 2);

  await h.respond(1, '[[100,100]]');
  assert.deepEqual(h.lastApply(), [range(101, 250)]);
});

test('terminal blank-line removal reuses coverage but semantic edits reanalyze', async () => {
  const h = harness({ symbols: async () => [span(100, 250, 100, 101)] });
  const content = longText();
  const document = new FakeDocument('file:///long.py', `${content}\n\n\n`);
  const editor = new FakeEditor(document, [[99, 199]]);

  h.controller.toggle(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);
  await h.respond(0, '[[100,100]]');
  const applied = h.lastApply();
  assert.deepEqual(applied, [range(101, 250)]);

  document.setText(`${content}\n\n`);
  h.controller.onChange(document);
  await flushMicrotasks();

  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.lastApply(), []);

  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);
  assert.ok(h.diagnostics.includes('reuse'));
  assert.deepEqual(h.lastApply(), applied);

  const changed = content
    .split('\n')
    .map((line, index) => (index === 999 ? 'changed final line' : line))
    .join('\n');
  document.setText(`${changed}\n`);
  h.controller.onChange(document);
  await flushMicrotasks();

  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.lastApply(), []);

  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 2);
  await h.respond(1, '[[100,100]]');
});

test('small snapshots need no symbols and reuse the bounded cache across editors', async () => {
  const h = harness();
  const document = smallDocument();
  const first = new FakeEditor(document, [[0, 19]]);

  h.controller.toggle(first);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);
  assert.equal(h.symbolCalls.length, 0);
  await h.respond(0, '[[1,3]]');

  const second = new FakeEditor(document, [[0, 19]]);
  h.controller.toggle(second);
  await flushMicrotasks();

  assert.equal(h.requests.length, 1);
  assert.ok(h.diagnostics.includes('cache-hit'));
  assert.deepEqual(h.lastApply(), [range(4, 20)]);
});

test('the snapshot cache is bounded and does not outlive a configuration generation', async () => {
  const h = harness({ cacheLimit: 1 });
  const firstDocument = new FakeDocument('file:///a.py', 'alpha\nbeta\ngamma');
  const secondDocument = new FakeDocument('file:///b.py', 'one\ntwo\nthree');

  h.controller.toggle(new FakeEditor(firstDocument, [[0, 2]]));
  await flushMicrotasks();
  await h.respond(0, '[[1,1]]');

  h.controller.toggle(new FakeEditor(secondDocument, [[0, 2]]));
  await flushMicrotasks();
  assert.equal(h.requests.length, 2);
  await h.respond(1, '[[1,1]]');

  h.controller.toggle(new FakeEditor(firstDocument, [[0, 2]]));
  await flushMicrotasks();
  assert.equal(h.requests.length, 3);
  await h.respond(2, '[[1,1]]');

  h.setGeneration(2);
  const afterConfig = new FakeEditor(firstDocument, [[0, 2]]);
  h.controller.toggle(afterConfig);
  await flushMicrotasks();
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests[3]!.generation, 2);
  await h.respond(3, '[[1,1]]');
});

test('an edit invalidates an in-flight result before it can decorate', async () => {
  const h = harness();
  const document = smallDocument();
  const editor = new FakeEditor(document, [[0, 19]]);

  h.controller.toggle(editor);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);

  document.setText(
    Array.from({ length: 21 }, (_, index) => `line ${index + 1}`).join('\n'),
  );
  h.controller.onChange(document);
  await flushMicrotasks();
  assert.ok(h.applies.every((dim) => dim.length === 0));

  await h.respond(0, '[[1,5]]');
  assert.ok(h.applies.every((dim) => dim.length === 0));

  h.controller.toggle(editor);
  assert.equal(h.controller.isEnabled(editor), false);
  h.controller.toggle(editor);
  await flushMicrotasks();
  assert.equal(h.requests.length, 2);
  await h.respond(1, '[[1,5]]');
  assert.deepEqual(h.lastApply(), [range(6, 21)]);
});

test('a configuration change before dispatch cancels the pending long analysis', async () => {
  const h = harness({ symbols: async () => [span(100, 250, 100, 101)] });
  const editor = new FakeEditor(longDocument(), [[99, 199]]);

  h.controller.toggle(editor);
  assert.equal(h.clock.pending, 1);

  h.setGeneration(2);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();

  assert.equal(h.requests.length, 0);
  assert.equal(h.clock.pending, 0);
  assert.equal(h.controller.isEnabled(editor), false);
});

test('a configuration change while a request is in flight discards its result', async () => {
  const h = harness();
  const editor = new FakeEditor(smallDocument(), [[0, 19]]);

  h.controller.toggle(editor);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);

  h.setGeneration(2);
  await h.respond(0, '[[1,1]]');

  assert.ok(h.applies.every((dim) => dim.length === 0));
  assert.equal(h.controller.isEnabled(editor), false);
});

test('inactive editors get no request and no applied result', async () => {
  let active = false;
  const h = harness({
    symbols: async () => [span(100, 250, 100, 101)],
    isActive: () => active,
  });
  const editor = new FakeEditor(longDocument(), [[99, 199]]);

  h.controller.toggle(editor);
  assert.equal(h.clock.pending, 0);

  active = true;
  h.controller.onViewport(editor);
  assert.equal(h.clock.pending, 1);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);

  active = false;
  await h.respond(0, '[[100,100]]');
  assert.ok(h.applies.every((dim) => dim.length === 0));

  active = true;
  h.controller.onViewport(editor);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.lastApply(), [range(101, 250)]);
});

test('dispose and prune cancel timers and clear tracked state', async () => {
  const first = harness({ symbols: async () => [span(100, 250, 100, 101)] });
  const firstEditor = new FakeEditor(longDocument(), [[99, 199]]);
  first.controller.toggle(firstEditor);
  assert.equal(first.clock.pending, 1);

  first.controller.dispose();
  assert.equal(first.clock.pending, 0);
  assert.equal(first.controller.isEnabled(firstEditor), false);
  await first.clock.advance(10_000);
  assert.equal(first.requests.length, 0);

  const second = harness({ symbols: async () => [span(100, 250, 100, 101)] });
  const secondEditor = new FakeEditor(longDocument(), [[99, 199]]);
  second.controller.toggle(secondEditor);
  assert.equal(second.clock.pending, 1);

  second.controller.prune([]);
  assert.equal(second.clock.pending, 0);
  assert.equal(second.controller.isEnabled(secondEditor), false);
  await second.clock.advance(10_000);
  assert.equal(second.requests.length, 0);
});

test('toggle off restores brightness and a later toggle reuses the cache', async () => {
  const h = harness();
  const editor = new FakeEditor(smallDocument(), [[0, 19]]);

  h.controller.toggle(editor);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);
  await h.respond(0, '[[1,3]]');
  assert.deepEqual(h.lastApply(), [range(4, 20)]);

  assert.equal(h.controller.isEnabled(editor), true);
  h.controller.toggle(editor);
  assert.equal(h.controller.isEnabled(editor), false);
  assert.deepEqual(h.lastApply(), []);
  assert.equal(h.requests.length, 1);

  h.controller.toggle(editor);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.lastApply(), [range(4, 20)]);
});

test('reset cancels timers, clears decorations and starts fresh', async () => {
  const h = harness({ symbols: async () => [span(100, 250, 100, 101)] });
  const longEditor = new FakeEditor(longDocument(), [[99, 199]]);

  h.controller.toggle(longEditor);
  assert.equal(h.clock.pending, 1);
  h.controller.reset();
  assert.equal(h.clock.pending, 0);
  assert.equal(h.controller.isEnabled(longEditor), false);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS * 2);
  assert.equal(h.requests.length, 0);

  const small = new FakeEditor(smallDocument(), [[0, 19]]);
  h.controller.toggle(small);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);
  assert.equal(h.controller.isEnabled(small), true);
  await h.respond(0, '[[1,3]]');

  h.controller.reset();
  assert.equal(h.controller.isEnabled(small), false);
  assert.deepEqual(h.lastApply(), []);
});

test('the request adapter can recheck stability before network without aborting', async () => {
  const h = harness({ symbols: async () => [span(100, 250, 100, 101)] });
  const editor = new FakeEditor(longDocument(), [[99, 199]]);

  h.controller.toggle(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.canSend(), true);

  editor.setVisible([[149, 239]]);
  assert.equal(h.requests[0]!.canSend(), false);

  editor.setVisible([[99, 199]]);
  assert.equal(h.requests[0]!.canSend(), true);

  // A→B→A through the real viewport consumer invalidates the dwell epoch.
  editor.setVisible([[149, 239]]);
  h.controller.onViewport(editor);
  editor.setVisible([[99, 199]]);
  h.controller.onViewport(editor);
  assert.equal(h.requests[0]!.canSend(), false);

  // The guard follows mode changes, but the dispatched transport still finishes.
  h.controller.toggle(editor);
  assert.equal(h.requests[0]!.canSend(), false);
  await h.respond(0, '[[100,100]]');
  assert.equal(h.requests.length, 1);
  assert.ok(h.applies.every((dim) => dim.length === 0));
});

test('small snapshots guard fold changes while caller settings are pending', async () => {
  const h = harness();
  const editor = new FakeEditor(smallDocument(), [[0, 19]]);

  h.controller.toggle(editor);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.canSend(), true);

  editor.setVisible([[0, 9]]);
  h.controller.onViewport(editor);
  assert.equal(h.requests[0]!.canSend(), true);

  editor.setVisible([[0, 4], [10, 19]]);
  h.controller.onViewport(editor);
  assert.equal(h.requests[0]!.canSend(), false);

  // The guard is not an abort signal: the dispatched request still applies.
  await h.respond(0, '[[1,1]]');
  assert.deepEqual(h.lastApply(), [range(2, 20)]);
});

test('a guard-skipped request does not surface a focus error', async () => {
  const h = harness({ symbols: async () => [span(100, 250, 100, 101)] });
  const editor = new FakeEditor(longDocument(), [[99, 199]]);

  h.controller.toggle(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);

  editor.setVisible([[149, 239]]);
  assert.equal(h.requests[0]!.canSend(), false);
  await h.reject(0, new Error('settings changed'));

  assert.equal(h.notifications.length, 0);
  assert.ok(h.diagnostics.includes('stale'));
});

test('A→B→A during symbol preflight does not reuse the old dwell', async () => {
  const symbols = deferred<readonly SymbolSpan[]>();
  const h = harness({ symbols: () => symbols.promise });
  const editor = new FakeEditor(longDocument(), [[99, 199]]);

  h.controller.toggle(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 0);
  assert.equal(h.symbolCalls.length, 1);

  editor.setVisible([[109, 209]]);
  h.controller.onViewport(editor);
  editor.setVisible([[99, 199]]);
  h.controller.onViewport(editor);

  symbols.resolve([span(100, 250, 100, 101)]);
  await flushMicrotasks();
  assert.equal(h.requests.length, 0);

  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);
});

test('quick off/on discards preflight instead of joining it', async () => {
  const symbols = deferred<readonly SymbolSpan[]>();
  const h = harness({ symbols: () => symbols.promise });
  const editor = new FakeEditor(longDocument(), [[99, 199]]);

  h.controller.toggle(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 0);

  h.controller.toggle(editor);
  h.controller.toggle(editor);
  symbols.resolve([span(100, 250, 100, 101)]);
  await flushMicrotasks();
  assert.equal(h.requests.length, 0);

  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);
});

test('losing the active editor during preflight still allows refocus', async () => {
  let active = true;
  const symbols = deferred<readonly SymbolSpan[]>();
  const h = harness({
    symbols: () => symbols.promise,
    isActive: () => active,
  });
  const editor = new FakeEditor(longDocument(), [[99, 199]]);

  h.controller.toggle(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 0);

  active = false;
  symbols.resolve([span(100, 250, 100, 101)]);
  await flushMicrotasks();
  assert.equal(h.requests.length, 0);

  active = true;
  h.controller.onViewport(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);
});

test('a joined stale request that yields no result permits a fresh request', async () => {
  const h = harness({ symbols: async () => [span(100, 250, 100, 101)] });
  const editor = new FakeEditor(longDocument(), [[99, 199]]);

  h.controller.toggle(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);

  editor.setVisible([[149, 239]]);
  h.controller.onViewport(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);

  editor.setVisible([[129, 229]]);
  h.controller.onViewport(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();
  assert.equal(h.requests.length, 1);

  await h.reject(0, new Error('old dwell'));
  await flushMicrotasks();
  assert.equal(h.requests.length, 2);
});

test('known folds stay excluded after scrolling out of view', async () => {
  const h = harness({ symbols: async () => [span(1, 200, 1, 1)] });
  const editor = new FakeEditor(longDocument(), [[0, 4], [100, 199]]);

  h.controller.toggle(editor);
  editor.setVisible([[0, 4]]);
  h.controller.onViewport(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();

  assert.equal(h.requests.length, 1);
  assert.doesNotMatch(h.requests[0]!.prompt, /^50 \|/m);
  assert.match(h.requests[0]!.prompt, /^150 \|/m);
});

test('edits with offscreen fold history send only visible code when fold positions are unknown', async () => {
  const h = harness({ symbols: async () => [span(1, 200, 1, 1)] });
  const editor = new FakeEditor(longDocument(), [[0, 4], [100, 199]]);
  h.controller.toggle(editor);
  editor.setVisible([[0, 4]]);
  h.controller.onViewport(editor);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await h.respond(0, '[[1,1]]');

  editor.document.setText(`# inserted line\n${editor.document.text}`);
  h.controller.onChange(editor.document);
  await h.clock.advance(FOCUS_VIEWPORT_DWELL_MS);
  await flushMicrotasks();

  assert.equal(h.requests.length, 2);
  assert.match(h.requests[1]!.prompt, /^5 \|/m);
  assert.doesNotMatch(h.requests[1]!.prompt, /^50 \|/m);
  assert.doesNotMatch(h.requests[1]!.prompt, /^150 \|/m);
});

test('cached text is bounded by bytes as well as entry count', async () => {
  const h = harness({ cacheLimit: 10, cacheBytes: 40 });
  const firstDocument = new FakeDocument('file:///a.py', 'a'.repeat(30));
  const secondDocument = new FakeDocument('file:///b.py', 'b'.repeat(30));

  h.controller.toggle(new FakeEditor(firstDocument, [[0, 0]]));
  await flushMicrotasks();
  await h.respond(0, '[[1,1]]');

  h.controller.toggle(new FakeEditor(secondDocument, [[0, 0]]));
  await flushMicrotasks();
  await h.respond(1, '[[1,1]]');

  h.controller.toggle(new FakeEditor(firstDocument, [[0, 0]]));
  await flushMicrotasks();
  assert.equal(h.requests.length, 3);
  await h.respond(2, '[[1,1]]');
});

test('an oversized snapshot does not evict earlier cached text', async () => {
  const h = harness({ cacheLimit: 10, cacheBytes: 40 });
  const firstDocument = new FakeDocument('file:///a.py', 'a'.repeat(30));
  const oversizedDocument = new FakeDocument('file:///b.py', 'b'.repeat(60));

  h.controller.toggle(new FakeEditor(firstDocument, [[0, 0]]));
  await flushMicrotasks();
  await h.respond(0, '[[1,1]]');

  h.controller.toggle(new FakeEditor(oversizedDocument, [[0, 0]]));
  await flushMicrotasks();
  await h.respond(1, '[[1,1]]');

  h.controller.toggle(new FakeEditor(firstDocument, [[0, 0]]));
  await flushMicrotasks();
  assert.equal(h.requests.length, 2);
  assert.ok(h.diagnostics.includes('cache-hit'));
});

test('buildFocusPrompt labels exact coverage and signature-only context', () => {
  const prompt = buildFocusPrompt({
    kind: 'prompt',
    prompt: '1 | alpha\n2 | beta',
    coverage: [range(1, 2)],
    signatureOnly: [range(3, 4)],
    target: 'visible-fallback',
  });

  assert.equal(
    prompt,
    'Analyze only these one-based inclusive line ranges: [[1,2]]. ' +
      'Signature-only context (do not include these lines in the analysis ranges): [[3,4]].\n' +
      '1 | alpha\n2 | beta',
  );

  const withoutSignature = buildFocusPrompt({
    kind: 'prompt',
    prompt: '1 | alpha',
    coverage: [range(1, 1)],
    signatureOnly: [],
    target: 'whole',
  });
  assert.equal(
    withoutSignature,
    'Analyze only these one-based inclusive line ranges: [[1,1]].\n1 | alpha',
  );
});
