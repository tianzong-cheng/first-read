import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  coldDwellMs,
  HOVER_MAX_CONTEXT_BYTES,
  HoverEngine,
  validateHoverExplanation,
  type HoverCancellationToken,
  type HoverExplanationRequest,
  type HoverModelCall,
  type HoverRequester,
  type HoverTimer,
} from '../src/hover.ts';

class TestToken implements HoverCancellationToken {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();

  get isCancellationRequested(): boolean {
    return this.cancelled;
  }

  onCancellationRequested(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    if (this.cancelled) {
      listener();
    }
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  cancel(): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

class ManualClock {
  private tasks: Array<{ callback: () => void; cancelled: boolean }> = [];

  readonly schedule = (callback: () => void, _delayMs: number): HoverTimer => {
    const task = { callback, cancelled: false };
    this.tasks.push(task);
    return {
      cancel: () => {
        task.cancelled = true;
      },
    };
  };

  get pending(): number {
    return this.tasks.filter((task) => !task.cancelled).length;
  }

  advance(): void {
    const due = this.tasks.filter((task) => !task.cancelled);
    this.tasks = [];
    for (const task of due) {
      task.cancelled = true;
      task.callback();
    }
  }
}

interface Gate<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function gate<T>(): Gate<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Signal {
  readonly promise: Promise<void>;
  mark(): void;
}

function signal(): Signal {
  let mark!: () => void;
  const promise = new Promise<void>((resolve) => {
    mark = resolve;
  });
  return { promise, mark };
}

const validText = 'This line doubles the value and stores it in a local variable.';

function request(overrides: Partial<HoverExplanationRequest> = {}): HoverExplanationRequest {
  return {
    language: 'python',
    line: 12,
    documentVersion: 3,
    context: '11 | def scale(value):\n12 |     return value * 2',
    target: '12 |     return value * 2',
    config: {
      endpoint: 'http://127.0.0.1:1234/v1',
      model: 'local',
      generation: 7,
    },
    isCurrent: () => true,
    ...overrides,
  };
}

function engine(
  requestImpl: HoverRequester,
  overrides: {
    editorHoverDelayMs?: number;
    coldHoverTargetMs?: number;
    cacheLimit?: number;
    generationCurrent?: (generation: number) => boolean;
    diagnostic?: (event: { kind: string }) => void;
    clock?: ManualClock;
  } = {},
): HoverEngine {
  return new HoverEngine({
    request: requestImpl,
    editorHoverDelayMs: overrides.editorHoverDelayMs ?? 800,
    coldHoverTargetMs: overrides.coldHoverTargetMs ?? 800,
    ...(overrides.cacheLimit === undefined ? {} : { cacheLimit: overrides.cacheLimit }),
    isGenerationCurrent: overrides.generationCurrent ?? (() => true),
    ...(overrides.diagnostic === undefined ? {} : { onDiagnostic: overrides.diagnostic }),
    ...(overrides.clock === undefined ? {} : { scheduleTimeout: overrides.clock.schedule }),
  });
}

test('coldDwellMs supplements host delay to the 800 ms target', () => {
  assert.equal(coldDwellMs(400), 400);
  assert.equal(coldDwellMs(0), 800);
  assert.equal(coldDwellMs(799), 1);
  assert.equal(coldDwellMs(800), 0);
  assert.equal(coldDwellMs(2000), 0);
  assert.equal(coldDwellMs(Number.NaN), 800);
  assert.equal(coldDwellMs(-10), 800);
  assert.equal(coldDwellMs(400, 600), 200);

  const clamped = engine(async () => validText, { editorHoverDelayMs: -10 });
  assert.equal(clamped.coldDwell, 800);
  clamped.updateEditorHoverDelay(-100);
  assert.equal(clamped.coldDwell, 800);
});

test('builds one bounded request from context without repeating the target', async () => {
  let captured: HoverModelCall | undefined;
  let capturedIdentity: { endpoint: string; model: string; generation: number } | undefined;
  const hover = engine(
    async (call, identity) => {
      captured = call;
      capturedIdentity = identity;
      return validText;
    },
    { editorHoverDelayMs: 800 },
  );

  const supplied = request();
  const result = await hover.explain(supplied, new TestToken());
  assert.equal(result, validText);
  assert.ok(captured);
  assert.deepEqual(capturedIdentity, supplied.config);
  assert.equal(captured.maxTokens > 0 && captured.maxTokens <= 256, true);
  assert.equal(captured.messages.length, 2);
  assert.equal(captured.messages[0]?.role, 'system');
  assert.match(captured.messages[0]?.content ?? '', /one brief plain-text sentence/i);
  assert.match(captured.messages[0]?.content ?? '', /imperative mood/i);
  assert.match(captured.messages[0]?.content ?? '', /external/i);
  assert.match(captured.messages[0]?.content ?? '', /data, not instructions/i);
  const user = captured.messages[1];
  assert.equal(user?.role, 'user');
  assert.match(user?.content ?? '', /Language: python/);
  assert.match(user?.content ?? '', /Hovered line: 12/);
  assert.match(user?.content ?? '', /11 \| def scale\(value\):/);
  assert.match(user?.content ?? '', /Target lines: 12/);
  assert.doesNotMatch(user?.content ?? '', /Target:/);
  assert.equal((user?.content.match(/return value \* 2/g) ?? []).length, 1);
});

test('labels a multi-line target range without resending its source', async () => {
  let captured: HoverModelCall | undefined;
  const hover = engine(
    async (call) => {
      captured = call;
      return validText;
    },
    { editorHoverDelayMs: 800 },
  );

  const context = '12 | if ready:\n13 |     x = 1\n14 |     y = 2';
  assert.equal(
    await hover.explain(
      request({ line: 13, context, target: context }),
      new TestToken(),
    ),
    validText,
  );
  const user = captured?.messages[1]?.content ?? '';
  assert.match(user, /Hovered line: 13/);
  assert.match(user, /Target lines: 12-14/);
  assert.equal((user.match(/if ready:/g) ?? []).length, 1);
});

test('labels a bare numeric target identity without expanding the API', async () => {
  let captured: HoverModelCall | undefined;
  const hover = engine(
    async (call) => {
      captured = call;
      return validText;
    },
    { editorHoverDelayMs: 800 },
  );

  assert.equal(
    await hover.explain(request({ line: 13, target: '12:14' }), new TestToken()),
    validText,
  );
  const user = captured?.messages[1]?.content ?? '';
  assert.match(user, /Hovered line: 13/);
  assert.match(user, /Target lines: 12-14/);
});

test('rejects missing, oversized and invalid request inputs without sending', async () => {
  let calls = 0;
  const hover = engine(
    async () => {
      calls += 1;
      return validText;
    },
    { editorHoverDelayMs: 800 },
  );

  const cases: Partial<HoverExplanationRequest>[] = [
    { language: '' },
    { line: 0 },
    { line: 1.5 },
    { context: '' },
    { target: '' },
    { documentVersion: -1 },
    { config: { endpoint: '', model: 'm', generation: 1 } },
    { config: { endpoint: 'e', model: '', generation: 1 } },
    { config: { endpoint: 'e', model: 'm', generation: -1 } },
    { context: 'x'.repeat(5000) },
  ];
  for (const overrides of cases) {
    assert.equal(await hover.explain(request(overrides), new TestToken()), undefined);
  }
  assert.equal(calls, 0);
});

test('context byte cap excludes the separately keyed target', async () => {
  let calls = 0;
  let captured: HoverModelCall | undefined;
  const hover = engine(
    async (call) => {
      calls += 1;
      captured = call;
      return validText;
    },
    { editorHoverDelayMs: 800 },
  );

  const bigTarget = `12 | ${'x'.repeat(HOVER_MAX_CONTEXT_BYTES + 100)}`;
  assert.equal(
    await hover.explain(request({ target: bigTarget }), new TestToken()),
    validText,
  );
  assert.equal(calls, 1);
  assert.equal((captured?.messages[1]?.content ?? '').includes('x'.repeat(100)), false);
});

test('cancellation during the cold dwell cancels the timer and never dispatches', async () => {
  let calls = 0;
  const clock = new ManualClock();
  const hover = engine(
    async () => {
      calls += 1;
      return validText;
    },
    { editorHoverDelayMs: 0, coldHoverTargetMs: 120, clock },
  );
  const token = new TestToken();
  const pending = hover.explain(request(), token);
  assert.equal(clock.pending, 1);

  token.cancel();
  clock.advance();
  assert.equal(await pending, undefined);
  assert.equal(calls, 0);
});

test('cold inline hover reports dwell then network dispatch; a cache hit reports neither', async () => {
  const clock = new ManualClock();
  const phases: (number | 'sent')[] = [];
  const hover = engine(async (_call, _identity, canSend, onSent) => {
    assert.equal(canSend(), true);
    onSent();
    return validText;
  }, { editorHoverDelayMs: 0, coldHoverTargetMs: 120, clock });
  const pending = hover.explain(request(), new TestToken(), (phase) => phases.push(phase));
  assert.deepEqual(phases, [120]);
  clock.advance();
  assert.equal(await pending, validText);
  assert.deepEqual(phases, [120, 'sent']);
  assert.equal(await hover.explain(request(), new TestToken(), () => assert.fail('cache hit reported progress')), validText);
  assert.deepEqual(phases, [120, 'sent']);
});

test('a cached explanation skips the cold dwell', async () => {
  let calls = 0;
  const diagnostics: string[] = [];
  const clock = new ManualClock();
  const hover = engine(
    async () => {
      calls += 1;
      return validText;
    },
    {
      editorHoverDelayMs: 800,
      diagnostic: (event) => diagnostics.push(event.kind),
      clock,
    },
  );

  assert.equal(await hover.explain(request(), new TestToken()), validText);
  hover.updateEditorHoverDelay(0); // a cache miss would now wait 800 ms

  assert.equal(await hover.explain(request(), new TestToken()), validText);
  assert.equal(clock.pending, 0);
  assert.equal(calls, 1);
  assert.ok(diagnostics.includes('cache-hit'));
});

test('concurrent identical requests share one network dispatch', async () => {
  const response = gate<string>();
  const started = signal();
  let calls = 0;
  const hover = engine(
    () => {
      calls += 1;
      started.mark();
      return response.promise;
    },
    { editorHoverDelayMs: 800 },
  );

  const first = hover.explain(request(), new TestToken());
  const second = hover.explain(request(), new TestToken());
  await started.promise;
  assert.equal(calls, 1);
  response.resolve(validText);
  assert.deepEqual(await Promise.all([first, second]), [validText, validText]);
  assert.equal(calls, 1);
});

test('cancellation during async preflight prevents the actual send', async () => {
  const release = gate<boolean>();
  const started = signal();
  let sent = 0;
  let allowed: boolean | undefined;
  const hover = engine(
    async (_call, _identity, canSend) => {
      started.mark();
      await release.promise;
      allowed = canSend();
      if (!allowed) {
        return '';
      }
      sent += 1;
      return validText;
    },
    { editorHoverDelayMs: 800 },
  );

  const token = new TestToken();
  const pending = hover.explain(request(), token);
  await started.promise;
  token.cancel();
  release.resolve(true);
  assert.equal(await pending, undefined);
  assert.equal(allowed, false);
  assert.equal(sent, 0);

  // Nothing may be cached when the guarded send was refused.
  assert.equal(await hover.explain(request(), new TestToken()), validText);
  assert.equal(sent, 1);
});

test('a canceled first waiter does not block a current follower during preflight', async () => {
  const release = gate<boolean>();
  const started = signal();
  const joined = signal();
  let calls = 0;
  let sent = 0;
  const guardStates: boolean[] = [];
  const hover = engine(
    async (_call, _identity, canSend) => {
      calls += 1;
      started.mark();
      await release.promise;
      const allowed = canSend();
      guardStates.push(allowed);
      if (!allowed) {
        return '';
      }
      sent += 1;
      return validText;
    },
    {
      editorHoverDelayMs: 800,
      diagnostic: (event) => {
        if (event.kind === 'dedup') {
          joined.mark();
        }
      },
    },
  );

  const firstToken = new TestToken();
  const first = hover.explain(request(), firstToken);
  await started.promise;
  const second = hover.explain(request(), new TestToken());
  await joined.promise;
  firstToken.cancel();
  release.resolve(true);

  assert.equal(await first, undefined);
  assert.equal(await second, validText);
  assert.equal(calls, 1);
  assert.equal(sent, 1);
  assert.deepEqual(guardStates, [true]);
});

test('cancellation after dispatch does not interrupt transport but suppresses display and caches', async () => {
  const response = gate<string>();
  const started = signal();
  let calls = 0;
  const clock = new ManualClock();
  const hover = engine(
    () => {
      calls += 1;
      started.mark();
      return response.promise;
    },
    { editorHoverDelayMs: 800, clock },
  );
  const token = new TestToken();
  const pending = hover.explain(request(), token);
  await started.promise;
  assert.equal(calls, 1);

  token.cancel();
  response.resolve(validText);
  assert.equal(await pending, undefined);
  assert.equal(calls, 1);

  hover.updateEditorHoverDelay(0); // would wait 800 ms on a miss
  assert.equal(await hover.explain(request(), new TestToken()), validText);
  assert.equal(clock.pending, 0);
  assert.equal(calls, 1);
});

test('a stale document version suppresses rendering and ignores a late result', async () => {
  const response = gate<string>();
  const started = signal();
  let calls = 0;
  let current = true;
  const hover = engine(
    () => {
      calls += 1;
      started.mark();
      return response.promise;
    },
    { editorHoverDelayMs: 800 },
  );
  const first = hover.explain(request({ isCurrent: () => current }), new TestToken());
  await started.promise;
  current = false;
  response.resolve(validText);
  assert.equal(await first, undefined);
  assert.equal(calls, 1);
});

test('a generation change invalidates in-flight results and prevents caching', async () => {
  const response = gate<string>();
  const started = signal();
  let currentGeneration = 7;
  let calls = 0;
  const hover = engine(
    () => {
      calls += 1;
      started.mark();
      return response.promise;
    },
    {
      editorHoverDelayMs: 800,
      generationCurrent: (generation) => generation === currentGeneration,
    },
  );

  const pending = hover.explain(request(), new TestToken());
  await started.promise;
  currentGeneration = 8;
  response.resolve(validText);
  assert.equal(await pending, undefined);
  assert.equal(calls, 1);

  const next = request({
    config: { endpoint: 'http://127.0.0.1:1234/v1', model: 'local', generation: 8 },
  });
  assert.equal(await hover.explain(next, new TestToken()), validText);
  assert.equal(calls, 2);
});

test('errors and unsuitable output produce no hover and are not cached', async () => {
  const outputs = [
    'First sentence. Second sentence.',
    '```python\nreturn value * 2\n```',
    '',
    '**bold** explanation.',
    'It calls an external function defined in the helper library.',
    'x'.repeat(300),
  ];
  let calls = 0;
  const hover = engine(
    async () => {
      calls += 1;
      return outputs[calls - 1] ?? '';
    },
    { editorHoverDelayMs: 800 },
  );

  for (let index = 0; index < outputs.length; index += 1) {
    assert.equal(await hover.explain(request(), new TestToken()), undefined);
  }
  assert.equal(calls, outputs.length);

  assert.equal(await hover.explain(request(), new TestToken()), undefined);
  assert.equal(calls, outputs.length + 1);

  const failing = engine(
    async () => {
      throw new Error('network failed');
    },
    { editorHoverDelayMs: 800 },
  );
  assert.equal(await failing.explain(request(), new TestToken()), undefined);
});

test('validateHoverExplanation accepts one plain sentence and trims whitespace', () => {
  assert.equal(
    validateHoverExplanation('  This returns twice the input value.  '),
    'This returns twice the input value.',
  );
  assert.equal(
    validateHoverExplanation('It skips e.g. empty values and returns early.'),
    'It skips e.g. empty values and returns early.',
  );
  assert.equal(
    validateHoverExplanation('The value is 3.14 at runtime.'),
    'The value is 3.14 at runtime.',
  );
  assert.equal(validateHoverExplanation('Why does this branch exist?'), 'Why does this branch exist?');
  assert.equal(validateHoverExplanation('这一行会返回输入值的两倍。'), '这一行会返回输入值的两倍。');
  assert.equal(validateHoverExplanation('这段代码会读取缓存！'), '这段代码会读取缓存！');
  assert.equal(validateHoverExplanation('No terminal punctuation'), undefined);
  assert.equal(validateHoverExplanation('a\nb.'), undefined);
  assert.equal(validateHoverExplanation('First. Second.'), undefined);
  assert.equal(validateHoverExplanation('First sentence. second sentence.'), undefined);
  assert.equal(validateHoverExplanation('First sentence. 3 is next.'), undefined);
  assert.equal(validateHoverExplanation('No. It returns the input.'), undefined);
  assert.equal(validateHoverExplanation('Yes. It returns the input.'), undefined);
  assert.equal(
    validateHoverExplanation('Use serial No. 5 as the index.'),
    'Use serial No. 5 as the index.',
  );
  assert.equal(validateHoverExplanation('第一句。第二句。'), undefined);
  assert.equal(validateHoverExplanation('第一句。 第二句。'), undefined);
  assert.equal(validateHoverExplanation('It calls an external method that parses JSON.'), undefined);
  assert.equal(
    validateHoverExplanation('The helper is declared in the external library.'),
    undefined,
  );
});

test('cache is bounded and evicts the oldest entry', async () => {
  let calls = 0;
  const hover = engine(
    async () => {
      calls += 1;
      return validText;
    },
    { editorHoverDelayMs: 800, cacheLimit: 2 },
  );

  const one = request({ line: 1, target: '1 | a = 1' });
  const two = request({ line: 2, target: '2 | b = 2' });
  const three = request({ line: 3, target: '3 | c = 3' });

  await hover.explain(one, new TestToken());
  await hover.explain(two, new TestToken());
  await hover.explain(one, new TestToken());
  assert.equal(calls, 2);

  await hover.explain(three, new TestToken());
  assert.equal(calls, 3);

  await hover.explain(two, new TestToken());
  assert.equal(calls, 4);
});

test('a cancellation already requested before the call sends nothing', async () => {
  let calls = 0;
  const hover = engine(
    async () => {
      calls += 1;
      return validText;
    },
    { editorHoverDelayMs: 800 },
  );
  const token = new TestToken();
  token.cancel();
  assert.equal(await hover.explain(request(), token), undefined);
  assert.equal(calls, 0);
});

test('different context or configuration does not reuse an explanation', async () => {
  let calls = 0;
  const hover = engine(
    async () => {
      calls += 1;
      return validText;
    },
    { editorHoverDelayMs: 800 },
  );

  await hover.explain(request(), new TestToken());
  await hover.explain(request({ context: '12 | other = value' }), new TestToken());
  await hover.explain(
    request({
      config: { endpoint: 'http://127.0.0.1:1234/v1', model: 'other', generation: 7 },
    }),
    new TestToken(),
  );
  await hover.explain(
    request({
      config: { endpoint: 'http://127.0.0.1:1234/v1', model: 'local', generation: 8 },
    }),
    new TestToken(),
  );
  assert.equal(calls, 4);
});

test('dispose clears state and prevents later delivery', async () => {
  const response = gate<string>();
  const started = signal();
  let calls = 0;
  const hover = engine(
    () => {
      calls += 1;
      started.mark();
      return response.promise;
    },
    { editorHoverDelayMs: 800 },
  );
  const pending = hover.explain(request(), new TestToken());
  await started.promise;
  hover.dispose();
  response.resolve(validText);
  assert.equal(await pending, undefined);

  const second = engine(
    async () => {
      calls += 1;
      return validText;
    },
    { editorHoverDelayMs: 800 },
  );
  assert.equal(await second.explain(request(), new TestToken()), validText);
  assert.equal(calls, 2);
});
