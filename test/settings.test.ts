import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import {
  CONFIG_SECTION,
  ENDPOINT_CONFIG_KEY,
  MODEL_CONFIG_KEY,
  SettingsError,
  SettingsService,
  createSettingsService,
  type SettingsEventEmitter,
  type SettingsHost,
} from '../src/settings.ts';

const CONSENT_STATE_KEY = 'firstRead.transportConsent.v1';
const ENDPOINT_A = 'http://127.0.0.1:11434/v1';
const ENDPOINT_B = 'http://127.0.0.1:22434/v1';

class FakeEmitter<T> implements SettingsEventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  disposed = false;

  readonly event: vscode.Event<T> = (listener, thisArgs, disposables) => {
    const bound = listener.bind(thisArgs);
    this.listeners.add(bound);
    const disposable = {
      dispose: () => {
        this.listeners.delete(bound);
      },
    };
    disposables?.push(disposable);
    return disposable;
  };

  get listenerCount(): number {
    return this.listeners.size;
  }

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

interface Hold {
  readonly started: Promise<void>;
  release(): void;
}

class FakeMemento {
  private readonly values = new Map<string, unknown>();
  private pendingHold: {
    readonly gate: Promise<void>;
    readonly markStarted: () => void;
    release(): void;
  } | null = null;

  get<T>(key: string, fallback?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : fallback;
  }

  holdNextConsentUpdate(): Hold {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    this.pendingHold = { gate, markStarted, release };
    return { started, release };
  }

  async update(key: string, value: unknown): Promise<void> {
    if (key === CONSENT_STATE_KEY && this.pendingHold !== null) {
      const hold = this.pendingHold;
      this.pendingHold = null;
      hold.markStarted();
      await hold.gate;
    }
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }

  keys(): readonly string[] {
    return [...this.values.keys()];
  }

  setKeysForSync(): void {
    // No-op in the fake.
  }

  has(key: string): boolean {
    return this.values.has(key);
  }
}

class FakeSecrets {
  private readonly values = new Map<string, string>();
  readonly changeEmitter = new FakeEmitter<{ key: string }>();
  failGet = false;

  readonly onDidChange = this.changeEmitter.event;

  async get(key: string): Promise<string | undefined> {
    if (this.failGet) {
      throw new Error('secret read failed');
    }
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    this.changeEmitter.fire({ key });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.changeEmitter.fire({ key });
  }
}

interface Environment {
  readonly context: vscode.ExtensionContext;
  readonly host: SettingsHost;
  readonly globalState: FakeMemento;
  readonly secrets: FakeSecrets;
  readonly configEmitter: FakeEmitter<vscode.ConfigurationChangeEvent>;
  readonly trustEmitter: FakeEmitter<void>;
  readonly createdEmitters: FakeEmitter<unknown>[];
  setEndpoint(endpoint: string): void;
  fireConfig(changed?: string): void;
  onWarning(handler: () => Promise<string | undefined>): void;
}

function createEnvironment(): Environment {
  let endpoint = ENDPOINT_A;
  let model = 'test-model';
  let trusted = true;
  let warningHandler = async (): Promise<string | undefined> =>
    'Allow Source Transfer';

  const configEmitter = new FakeEmitter<vscode.ConfigurationChangeEvent>();
  const trustEmitter = new FakeEmitter<void>();
  const createdEmitters: FakeEmitter<unknown>[] = [];
  const globalState = new FakeMemento();
  const secrets = new FakeSecrets();

  const host: SettingsHost = {
    getConfiguration: () => ({
      inspect: <T,>(key: string) => {
        const value =
          key === ENDPOINT_CONFIG_KEY
            ? endpoint
            : key === MODEL_CONFIG_KEY
              ? model
              : undefined;
        return value === undefined ? undefined : { globalValue: value as T };
      },
    }),
    isTrusted: () => trusted,
    onDidChangeConfiguration: configEmitter.event,
    onDidGrantWorkspaceTrust: trustEmitter.event,
    showWarningMessage: () => warningHandler(),
    showInputBox: async () => undefined,
    createEventEmitter: <T,>() => {
      const emitter = new FakeEmitter<T>();
      createdEmitters.push(emitter as FakeEmitter<unknown>);
      return emitter;
    },
  };

  return {
    context: { secrets, globalState } as unknown as vscode.ExtensionContext,
    host,
    globalState,
    secrets,
    configEmitter,
    trustEmitter,
    createdEmitters,
    setEndpoint(next) {
      endpoint = next;
    },
    fireConfig(changed = CONFIG_SECTION) {
      configEmitter.fire({
        affectsConfiguration: (section: string) =>
          section === changed || section.startsWith(`${changed}.`) || changed.startsWith(`${section}.`),
      } as vscode.ConfigurationChangeEvent);
    },
    onWarning(handler) {
      warningHandler = handler;
    },
  };
}

function createHarness(): { environment: Environment; service: SettingsService } {
  const environment = createEnvironment();
  return {
    environment,
    service: new SettingsService(environment.context, environment.host),
  };
}

test('changing the explanation language preserves model generation and consent', async () => {
  const { service, environment } = createHarness();
  try {
    await service.initialize();
    assert.equal(await service.ensureTransportConsent(), true);
    const before = service.currentGeneration;
    environment.fireConfig('firstRead.explanationLanguage');
    assert.equal((await service.getModelRequestSettings(before)).generation, before);
    assert.equal(service.hasTransportConsent(), true);
  } finally {
    service.dispose();
  }
});

test('enabling with no endpoint reports setup without requesting consent', async () => {
  const { service, environment } = createHarness();
  environment.setEndpoint('');
  environment.onWarning(async () => assert.fail('Missing configuration must not prompt for consent'));
  try {
    await service.initialize();
    await assert.rejects(
      service.ensureTransportConsent(),
      (error: unknown) => error instanceof SettingsError && error.code === 'missing-endpoint',
    );
  } finally {
    service.dispose();
  }
});

test('rapid A -> B -> A still revokes the persisted A approval', async () => {
  const harness = createHarness();
  const { service, environment } = harness;
  try {
    await service.initialize();
    assert.equal(await service.ensureTransportConsent(), true);
    assert.equal(service.hasTransportConsent(), true);
    assert.equal(environment.globalState.has(CONSENT_STATE_KEY), true);

    // Both transitions are observed before any queued refresh can run.
    environment.setEndpoint(ENDPOINT_B);
    environment.fireConfig();
    environment.setEndpoint(ENDPOINT_A);
    environment.fireConfig();

    assert.equal(service.hasTransportConsent(), false);
    await assert.rejects(
      service.getModelRequestSettings(),
      (error: unknown) =>
        error instanceof SettingsError && error.code === 'no-transport-consent',
    );
    assert.equal(environment.globalState.has(CONSENT_STATE_KEY), false);
  } finally {
    service.dispose();
  }
});

test('does not persist approval when the endpoint changes while prompting', async () => {
  const harness = createHarness();
  const { service, environment } = harness;
  try {
    await service.initialize();
    environment.onWarning(async () => {
      environment.setEndpoint(ENDPOINT_B);
      environment.fireConfig();
      environment.setEndpoint(ENDPOINT_A);
      environment.fireConfig();
      return 'Allow Source Transfer';
    });

    assert.equal(await service.ensureTransportConsent(), false);
    assert.equal(environment.globalState.has(CONSENT_STATE_KEY), false);
    assert.equal(service.hasTransportConsent(), false);
  } finally {
    service.dispose();
  }
});

test('a held approval finishing after A -> B -> A cannot restore consent', async () => {
  const harness = createHarness();
  const { service, environment } = harness;
  try {
    await service.initialize();
    const hold = environment.globalState.holdNextConsentUpdate();
    const approval = service.ensureTransportConsent();
    await hold.started;

    environment.setEndpoint(ENDPOINT_B);
    environment.fireConfig();
    environment.setEndpoint(ENDPOINT_A);
    environment.fireConfig();
    hold.release();

    assert.equal(await approval, false);
    await assert.rejects(
      service.getModelRequestSettings(),
      (error: unknown) =>
        error instanceof SettingsError && error.code === 'no-transport-consent',
    );
    assert.equal(environment.globalState.has(CONSENT_STATE_KEY), false);
  } finally {
    service.dispose();
  }
});

test('dispose during a held approval writes revocation and closes dispatch', async () => {
  const harness = createHarness();
  const { service, environment } = harness;
  try {
    await service.initialize();
    const hold = environment.globalState.holdNextConsentUpdate();
    const approval = service.ensureTransportConsent();
    await hold.started;

    service.dispose();
    hold.release();

    assert.equal(await approval, false);
    assert.equal(environment.globalState.has(CONSENT_STATE_KEY), false);
    assert.equal(service.hasTransportConsent(), false);
    await assert.rejects(
      service.getModelRequestSettings(),
      (error: unknown) =>
        error instanceof SettingsError && error.code === 'disposed',
    );
  } finally {
    service.dispose();
  }
});

test('createSettingsService disposes listeners when initialization fails', async () => {
  const environment = createEnvironment();
  environment.secrets.failGet = true;

  await assert.rejects(
    createSettingsService(environment.context, environment.host),
    /secret read failed/,
  );

  assert.equal(environment.configEmitter.listenerCount, 0);
  assert.equal(environment.trustEmitter.listenerCount, 0);
  assert.equal(environment.secrets.changeEmitter.listenerCount, 0);
  assert.ok(environment.createdEmitters.length > 0);
  assert.ok(environment.createdEmitters.every((emitter) => emitter.disposed));
});
