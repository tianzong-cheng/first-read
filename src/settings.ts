import type * as vscode from 'vscode';
import type { ModelConfig } from './model.ts';

/**
 * User-level configuration and source-transfer policy for First Read.
 *
 * This service never reads workspace values: endpoint and model come from the
 * `globalValue` (or registered default) returned by `inspect`. Every effective
 * change to endpoint, model, secret, trust, or consent increments `generation`
 * and fires `onDidChange`, so caches and in-flight results can be invalidated.
 *
 * Endpoint transitions are observed synchronously in the configuration event.
 * Once any transition is seen, the persisted approval is revoked even if a
 * later event returns to the previous endpoint before the async refresh runs.
 */

export const CONFIG_SECTION = 'firstRead';
export const API_KEY_SECRET_KEY = 'firstRead.apiKey';
export const ENDPOINT_CONFIG_KEY = 'endpoint';
export const MODEL_CONFIG_KEY = 'model';

const TRANSPORT_CONSENT_STATE_KEY = 'firstRead.transportConsent.v1';
const CONSENT_VERSION = 1;
const ALLOW_TRANSFER_ACTION = 'Allow Source Transfer';

export interface SettingsSnapshot {
  /** Monotonically increasing across this extension-host lifetime. */
  readonly generation: number;
  readonly endpoint: string;
  readonly model: string;
  readonly hasApiKey: boolean;
  readonly trusted: boolean;
  /** Normalized endpoint currently covered by stored consent, if any. */
  readonly consentEndpoint: string | null;
}

export type SettingsErrorCode =
  | 'untrusted-workspace'
  | 'missing-endpoint'
  | 'missing-model'
  | 'no-transport-consent'
  | 'stale-generation'
  | 'disposed';

export class SettingsError extends Error {
  constructor(message: string, readonly code: SettingsErrorCode) {
    super(message);
    this.name = 'SettingsError';
  }
}

/** A validated snapshot paired with the generation the caller must check. */
export interface ModelRequestSettings {
  readonly config: ModelConfig;
  readonly generation: number;
}

/** Narrow VS Code surface needed by the service, injectable in tests. */
export interface SettingsConfiguration {
  inspect<T>(key: string): {
    readonly globalValue?: T;
    readonly defaultValue?: T;
  } | undefined;
}

export interface SettingsEventEmitter<T> extends vscode.Disposable {
  readonly event: vscode.Event<T>;
  fire(value: T): void;
}

export interface SettingsHost {
  getConfiguration(section: string): SettingsConfiguration;
  isTrusted(): boolean;
  onDidChangeConfiguration(
    listener: (event: vscode.ConfigurationChangeEvent) => void,
  ): vscode.Disposable;
  onDidGrantWorkspaceTrust(listener: () => void): vscode.Disposable;
  showWarningMessage(
    message: string,
    options: vscode.MessageOptions,
    action: string,
  ): Thenable<string | undefined>;
  showInputBox(options: vscode.InputBoxOptions): Thenable<string | undefined>;
  createEventEmitter<T>(): SettingsEventEmitter<T>;
}

interface TransportConsentRecord {
  readonly version: number;
  readonly endpoint: string;
  readonly grantedAt: string;
}

interface VSCodeRuntime {
  readonly workspace: {
    readonly isTrusted: boolean;
    getConfiguration(section: string): SettingsConfiguration;
    onDidChangeConfiguration(
      listener: (event: vscode.ConfigurationChangeEvent) => void,
    ): vscode.Disposable;
    onDidGrantWorkspaceTrust(listener: () => void): vscode.Disposable;
  };
  readonly window: {
    showWarningMessage(
      message: string,
      options: vscode.MessageOptions,
      action: string,
    ): Thenable<string | undefined>;
    showInputBox(options: vscode.InputBoxOptions): Thenable<string | undefined>;
  };
  readonly EventEmitter: new <T>() => SettingsEventEmitter<T>;
}

function defaultSettingsHost(): SettingsHost {
  const api = require('vscode') as VSCodeRuntime;
  return {
    getConfiguration: (section) => api.workspace.getConfiguration(section),
    isTrusted: () => api.workspace.isTrusted,
    onDidChangeConfiguration: (listener) =>
      api.workspace.onDidChangeConfiguration(listener),
    onDidGrantWorkspaceTrust: (listener) =>
      api.workspace.onDidGrantWorkspaceTrust(listener),
    showWarningMessage: (message, options, action) =>
      api.window.showWarningMessage(message, options, action),
    showInputBox: (options) => api.window.showInputBox(options),
    createEventEmitter: <T>() => new api.EventEmitter<T>(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readUserString(
  configuration: SettingsConfiguration,
  key: string,
): string {
  const inspected = configuration.inspect<unknown>(key);
  // `get()` would merge workspace values. Only the user-level value or the
  // manifest default is acceptable for a setting that controls data transfer.
  const value = inspected?.globalValue ?? inspected?.defaultValue;
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedKey(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  return value.trim();
}

function normalizedConsentEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

function parseConsentRecord(value: unknown): TransportConsentRecord | undefined {
  if (
    !isRecord(value) ||
    value.version !== CONSENT_VERSION ||
    typeof value.endpoint !== 'string' ||
    typeof value.grantedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    version: CONSENT_VERSION,
    endpoint: value.endpoint,
    grantedAt: value.grantedAt,
  };
}

export class SettingsService implements vscode.Disposable {
  private readonly secrets: vscode.SecretStorage;
  private readonly globalState: vscode.Memento;
  private readonly host: SettingsHost;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter: SettingsEventEmitter<SettingsSnapshot>;
  readonly onDidChange: vscode.Event<SettingsSnapshot>;

  private endpoint = '';
  private model = '';
  private apiKey: string | undefined;
  private trusted = false;
  private consentEndpoint: string | null = null;
  private generation = 0;
  private initialized = false;
  private disposed = false;
  private refreshChain: Promise<void> = Promise.resolve();
  private consentWriteChain: Promise<void> = Promise.resolve();
  private consentEpoch = 0;
  private pendingConsentClear = false;
  private lastObservedEndpoint: string;

  constructor(
    context: Pick<vscode.ExtensionContext, 'secrets' | 'globalState'>,
    host: SettingsHost = defaultSettingsHost(),
  ) {
    this.secrets = context.secrets;
    this.globalState = context.globalState;
    this.host = host;
    this.changeEmitter = host.createEventEmitter<SettingsSnapshot>();
    this.onDidChange = this.changeEmitter.event;
    this.lastObservedEndpoint = this.readEndpoint();

    this.disposables.push(
      host.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
          // Record the transition before any async work. A rapid A -> B -> A
          // sequence must still revoke the old A approval.
          this.observeEndpointTransition();
          this.invalidateNow();
          this.scheduleRefresh();
        }
      }),
      host.onDidGrantWorkspaceTrust(() => {
        this.invalidateNow();
        this.scheduleRefresh();
      }),
      this.secrets.onDidChange((event) => {
        if (event.key === API_KEY_SECRET_KEY) {
          this.invalidateNow();
          this.scheduleRefresh();
        }
      }),
    );
  }

  get snapshot(): SettingsSnapshot {
    return {
      generation: this.generation,
      endpoint: this.endpoint,
      model: this.model,
      hasApiKey: this.apiKey !== undefined,
      trusted: this.trusted,
      consentEndpoint: this.consentEndpoint,
    };
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get hasApiKey(): boolean {
    return this.apiKey !== undefined;
  }

  async initialize(): Promise<void> {
    try {
      await this.enqueueRefresh();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  isGenerationCurrent(generation: number): boolean {
    return (
      !this.disposed &&
      this.generation === generation &&
      this.trusted &&
      this.host.isTrusted()
    );
  }

  /**
   * Return a transport-ready config and its generation, or throw when sending
   * source is not allowed. Callers must retain the generation and discard any
   * later result when `isGenerationCurrent` is false.
   */
  async getModelRequestSettings(
    expectedGeneration?: number,
  ): Promise<ModelRequestSettings> {
    await this.enqueueRefresh();

    if (this.disposed) {
      throw new SettingsError(
        'The First Read settings service is disposed.',
        'disposed',
      );
    }
    if (
      expectedGeneration !== undefined &&
      expectedGeneration !== this.generation
    ) {
      throw new SettingsError(
        'The model configuration changed before the request could be sent.',
        'stale-generation',
      );
    }
    if (!this.host.isTrusted() || !this.trusted) {
      throw new SettingsError(
        'First Read is disabled in untrusted workspaces.',
        'untrusted-workspace',
      );
    }
    if (!this.endpoint) {
      throw new SettingsError(
        'Set a model endpoint in user settings before using First Read.',
        'missing-endpoint',
      );
    }
    if (!this.model) {
      throw new SettingsError(
        'Set a model name in user settings before using First Read.',
        'missing-model',
      );
    }
    if (!this.hasTransportConsent()) {
      throw new SettingsError(
        'Source transfer has not been approved for the configured endpoint.',
        'no-transport-consent',
      );
    }

    const config: ModelConfig = {
      endpoint: this.endpoint,
      model: this.model,
      ...(this.apiKey === undefined ? {} : { apiKey: this.apiKey }),
    };
    return { config, generation: this.generation };
  }

  hasTransportConsent(): boolean {
    if (this.disposed || !this.host.isTrusted() || !this.endpoint) {
      return false;
    }
    return (
      this.consentEndpoint !== null &&
      this.consentEndpoint === normalizedConsentEndpoint(this.endpoint)
    );
  }

  /**
   * Ask for explicit consent naming the endpoint. Consent is keyed to the
   * current endpoint and is renewed whenever the endpoint changes. An approval
   * is discarded if the endpoint transitions while the prompt is open.
   */
  async ensureTransportConsent(): Promise<boolean> {
    await this.enqueueRefresh();
    if (this.disposed || !this.host.isTrusted() || !this.trusted) {
      return false;
    }
    if (!this.endpoint) {
      throw new SettingsError('Set a model endpoint in user settings before using First Read.', 'missing-endpoint');
    }
    if (!this.model) {
      throw new SettingsError('Set a model name in user settings before using First Read.', 'missing-model');
    }
    if (this.hasTransportConsent()) {
      return true;
    }

    const approvalEpoch = this.consentEpoch;
    const endpoint = this.endpoint;
    const answer = await this.host.showWarningMessage(
      `First Read will send source code from this window to ${endpoint} to generate explanations.`,
      { modal: false },
      ALLOW_TRANSFER_ACTION,
    );
    if (answer !== ALLOW_TRANSFER_ACTION || this.disposed) {
      return false;
    }

    // Do not persist an approval for an endpoint that was left and possibly
    // returned to while the user was deciding.
    if (
      this.consentEpoch !== approvalEpoch ||
      normalizedConsentEndpoint(this.readEndpoint()) !==
        normalizedConsentEndpoint(endpoint)
    ) {
      await this.enqueueRefresh();
      return false;
    }

    const record: TransportConsentRecord = {
      version: CONSENT_VERSION,
      endpoint: normalizedConsentEndpoint(endpoint),
      grantedAt: new Date().toISOString(),
    };
    await this.writeConsentRecord(record);
    if (this.disposed) {
      // The write was already in flight when authorization closed. Remove it
      // even though the service will no longer answer requests.
      await this.writeConsentRecord(undefined).catch(() => undefined);
      return false;
    }
    if (this.consentEpoch !== approvalEpoch) {
      // A transition occurred while approving; the serialized revocation and
      // queued refresh remove the now-stale record.
      await this.enqueueRefresh();
      return false;
    }

    await this.enqueueRefresh();
    return this.hasTransportConsent();
  }

  async revokeTransportConsent(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.writeConsentRecord(undefined);
    await this.enqueueRefresh();
  }

  /**
   * Store a key in SecretStorage. Without an argument, prompt the user; an
   * empty entry clears the key. Cancelling returns false without changing it.
   */
  async setApiKey(value?: string): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    let next = value;
    if (next === undefined) {
      next = await this.host.showInputBox({
        title: 'First Read: Set API Key',
        prompt:
          'Stored in VS Code SecretStorage and sent only to the configured model endpoint. Leave empty to clear.',
        password: true,
        ignoreFocusOut: true,
      });
      if (next === undefined || this.disposed) {
        return false;
      }
    }

    const key = normalizedKey(next);
    if (key === undefined) {
      await this.secrets.delete(API_KEY_SECRET_KEY);
    } else {
      await this.secrets.store(API_KEY_SECRET_KEY, key);
    }
    if (this.disposed) {
      return false;
    }
    await this.enqueueRefresh();
    return true;
  }

  async clearApiKey(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.secrets.delete(API_KEY_SECRET_KEY);
    await this.enqueueRefresh();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.consentEndpoint = null;
    this.apiKey = undefined;
    this.trusted = false;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.changeEmitter.dispose();
  }

  /** Invalidate synchronously so no in-flight result survives the event tick. */
  private invalidateNow(): void {
    if (this.disposed) {
      return;
    }
    this.generation += 1;
    this.changeEmitter.fire(this.snapshot);
  }

  /**
   * Compare the newly observed endpoint with the previous observation, not
   * with the last asynchronously applied value. This records every transition,
   * including A -> B -> A before a refresh runs.
   */
  private observeEndpointTransition(): void {
    if (this.disposed) {
      return;
    }
    const observed = this.readEndpoint();
    if (
      normalizedConsentEndpoint(observed) ===
      normalizedConsentEndpoint(this.lastObservedEndpoint)
    ) {
      return;
    }
    this.lastObservedEndpoint = observed;
    this.consentEpoch += 1;
    this.pendingConsentClear = true;
    this.consentEndpoint = null;
    // Start revoking the persisted approval immediately; the queued refresh
    // retries and clears the pending marker when it completes. Every write is
    // serialized so a later approval cannot be overwritten by an older one.
    void this.writeConsentRecord(undefined).catch(() => undefined);
  }

  private writeConsentRecord(
    value: TransportConsentRecord | undefined,
  ): Promise<void> {
    const write = this.consentWriteChain.then(() =>
      this.globalState.update(TRANSPORT_CONSENT_STATE_KEY, value),
    );
    this.consentWriteChain = write.catch(() => undefined);
    return write;
  }

  private async clearPersistedConsent(): Promise<void> {
    const epoch = this.consentEpoch;
    this.consentEndpoint = null;
    await this.writeConsentRecord(undefined);
    if (this.consentEpoch === epoch) {
      this.pendingConsentClear = false;
    }
  }

  private scheduleRefresh(): void {
    void this.enqueueRefresh().catch(() => undefined);
  }

  private enqueueRefresh(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    const next = this.refreshChain.then(() =>
      this.initialized ? this.refreshFields() : this.initializeFields(),
    );
    this.refreshChain = next.catch(() => undefined);
    return next;
  }

  private async initializeFields(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.initialized = true;
    const apiKey = normalizedKey(await this.secrets.get(API_KEY_SECRET_KEY));
    if (this.disposed) {
      return;
    }

    this.observeEndpointTransition();
    this.endpoint = this.lastObservedEndpoint;
    this.model = this.readModel();
    this.trusted = this.host.isTrusted();
    this.apiKey = apiKey;

    const record = this.readConsentRecord();
    const recordMismatch =
      record !== undefined &&
      normalizedConsentEndpoint(record.endpoint) !==
        normalizedConsentEndpoint(this.endpoint);
    if (this.pendingConsentClear || recordMismatch) {
      await this.clearPersistedConsent();
      if (this.disposed) {
        return;
      }
    } else {
      this.consentEndpoint = this.effectiveConsentEndpoint(record);
    }
    this.changeEmitter.fire(this.snapshot);
  }

  private async refreshFields(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.observeEndpointTransition();
    const apiKey = normalizedKey(await this.secrets.get(API_KEY_SECRET_KEY));
    if (this.disposed) {
      return;
    }
    // Re-observe after yielding: configuration can change while SecretStorage
    // is read, and the latest observation must win.
    this.observeEndpointTransition();
    const endpoint = this.lastObservedEndpoint;
    const model = this.readModel();
    const trusted = this.host.isTrusted();

    if (this.pendingConsentClear) {
      await this.clearPersistedConsent();
      if (this.disposed) {
        return;
      }
    }

    const record = this.readConsentRecord();
    const consentEndpoint = this.pendingConsentClear
      ? null
      : this.effectiveConsentEndpoint(record, endpoint);

    const changed =
      endpoint !== this.endpoint ||
      model !== this.model ||
      apiKey !== this.apiKey ||
      trusted !== this.trusted ||
      consentEndpoint !== this.consentEndpoint;

    this.endpoint = endpoint;
    this.model = model;
    this.apiKey = apiKey;
    this.trusted = trusted;
    this.consentEndpoint = consentEndpoint;

    if (changed) {
      this.generation += 1;
      this.changeEmitter.fire(this.snapshot);
    }
  }

  private readEndpoint(): string {
    return readUserString(
      this.host.getConfiguration(CONFIG_SECTION),
      ENDPOINT_CONFIG_KEY,
    );
  }

  private readModel(): string {
    return readUserString(
      this.host.getConfiguration(CONFIG_SECTION),
      MODEL_CONFIG_KEY,
    );
  }

  private readConsentRecord(): TransportConsentRecord | undefined {
    return parseConsentRecord(
      this.globalState.get<unknown>(TRANSPORT_CONSENT_STATE_KEY),
    );
  }

  private effectiveConsentEndpoint(
    record: TransportConsentRecord | undefined,
    endpoint = this.endpoint,
  ): string | null {
    if (record === undefined) {
      return null;
    }
    const configured = normalizedConsentEndpoint(endpoint);
    if (configured.length === 0) {
      return null;
    }
    return normalizedConsentEndpoint(record.endpoint) === configured
      ? configured
      : null;
  }
}

/** Create and initialize the settings service for extension activation. */
export async function createSettingsService(
  context: Pick<vscode.ExtensionContext, 'secrets' | 'globalState'>,
  host: SettingsHost = defaultSettingsHost(),
): Promise<SettingsService> {
  const service = new SettingsService(context, host);
  try {
    await service.initialize();
    return service;
  } catch (error) {
    service.dispose();
    throw error;
  }
}
