/**
 * Minimal OpenAI-compatible Chat Completions transport.
 *
 * This module deliberately has no VS Code dependency so it can be exercised
 * against a loopback server. Configuration, consent and workspace-trust policy
 * live in `settings.ts`; this file only enforces transport safety.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface ModelConfig {
  /** Base endpoint, with or without a final `/chat/completions`. */
  readonly endpoint: string;
  readonly model: string;
  /** SecretStorage value; omitted or blank means no Authorization header. */
  readonly apiKey?: string;
  /** Overall request deadline in milliseconds. Defaults to 20 s, capped at 120 s. */
  readonly timeoutMs?: number;
}

export interface ModelUsage {
  readonly input?: number;
  readonly output?: number;
}

export interface ModelResult {
  readonly text: string;
  readonly usage?: ModelUsage;
}

export type ModelErrorCode =
  | 'invalid-config'
  | 'unsupported-endpoint'
  | 'invalid-input'
  | 'network'
  | 'timeout'
  | 'http'
  | 'invalid-response';

export class ModelError extends Error {
  constructor(
    message: string,
    readonly code: ModelErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_TIMEOUT_MS = 120_000;
/** Maximum decoded response body accepted from a model service. */
export const MAX_RESPONSE_BYTES = 256 * 1024;

const CHAT_COMPLETIONS_SUFFIX = '/chat/completions';
const CHAT_ROLES: Readonly<Record<string, true>> = {
  system: true,
  user: true,
  assistant: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLoopbackHost(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  if (host === 'localhost' || host === '::1') {
    return true;
  }
  if (host.startsWith('::ffff:127.')) {
    return true;
  }
  const parts = host.split('.');
  if (parts.length !== 4 || parts[0] !== '127') {
    return false;
  }
  return parts.every(
    (part) => /^\d{1,3}$/.test(part) && Number(part) <= 255,
  );
}

/** Resolve and validate the endpoint without including it in error text. */
function completionUrl(endpoint: string): URL {
  if (!endpoint) {
    throw new ModelError('The model endpoint is not configured.', 'invalid-config');
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ModelError(
      'The model endpoint is not a valid HTTPS or loopback HTTP URL.',
      'invalid-config',
    );
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new ModelError(
      'The model endpoint must not contain credentials, a query, or a fragment.',
      'invalid-config',
    );
  }

  if (url.protocol === 'https:') {
    // Any HTTPS host is allowed; the settings layer owns explicit consent.
  } else if (url.protocol === 'http:') {
    if (!isLoopbackHost(url.hostname)) {
      throw new ModelError(
        'Plain HTTP is only allowed for loopback model endpoints.',
        'unsupported-endpoint',
      );
    }
  } else {
    throw new ModelError(
      'The model endpoint must use HTTPS or loopback HTTP.',
      'unsupported-endpoint',
    );
  }

  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith(CHAT_COMPLETIONS_SUFFIX)
    ? path
    : `${path}${CHAT_COMPLETIONS_SUFFIX}`;
  return url;
}

function requestTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

function validatedMessages(
  messages: readonly ChatMessage[],
): Array<{ role: ChatRole; content: string }> {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ModelError('At least one chat message is required.', 'invalid-input');
  }
  return messages.map((message) => {
    if (
      !message ||
      typeof message !== 'object' ||
      CHAT_ROLES[message.role] !== true ||
      typeof message.content !== 'string'
    ) {
      throw new ModelError('Chat messages are malformed.', 'invalid-input');
    }
    return { role: message.role, content: message.content };
  });
}

function validatedMaxTokens(maxTokens: number): number {
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new ModelError(
      'The response token budget must be a positive integer.',
      'invalid-input',
    );
  }
  return maxTokens;
}

function assistantText(choice: unknown): string | undefined {
  if (!isRecord(choice) || !isRecord(choice.message)) {
    return undefined;
  }
  const content = choice.message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

function tokenCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function responseUsage(value: unknown): ModelUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const input = tokenCount(value.input, value.prompt_tokens, value.input_tokens);
  const output = tokenCount(value.output, value.completion_tokens, value.output_tokens);
  if (input === undefined && output === undefined) {
    return undefined;
  }
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  };
}

function timeoutError(timeoutMs: number): ModelError {
  return new ModelError(
    `The model request timed out after ${timeoutMs} ms.`,
    'timeout',
  );
}

async function readResponseBody(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) {
    return '';
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        received += value.byteLength;
        if (received > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new ModelError(
            'The model response exceeded the size limit.',
            'invalid-response',
          );
        }
        text += decoder.decode(value, { stream: true });
      }
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Send one non-streaming Chat Completions request.
 *
 * There are no retries, redirects, or caller-supplied cancellation signals:
 * only the bounded deadline owns dispatch completion. Every thrown error is a
 * `ModelError` whose message never contains the endpoint, API key, request
 * body, response body, or underlying transport error.
 */
export async function complete(
  config: ModelConfig,
  messages: readonly ChatMessage[],
  maxTokens: number,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<ModelResult> {
  if (!config || typeof config !== 'object') {
    throw new ModelError('The model configuration is missing.', 'invalid-config');
  }

  const endpoint = typeof config.endpoint === 'string' ? config.endpoint.trim() : '';
  const model = typeof config.model === 'string' ? config.model.trim() : '';
  if (!model) {
    throw new ModelError('The model name is not configured.', 'invalid-config');
  }

  const url = completionUrl(endpoint);
  const bodyMessages = validatedMessages(messages);
  const outputTokens = validatedMaxTokens(maxTokens);
  const timeoutMs = requestTimeout(config.timeoutMs);
  const apiKey =
    typeof config.apiKey === 'string' && config.apiKey.trim().length > 0
      ? config.apiKey.trim()
      : undefined;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (apiKey !== undefined) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const body = JSON.stringify({
    model,
    messages: bodyMessages,
    max_tokens: outputTokens,
    stream: false,
    thinking: url.hostname === 'api.deepseek.com' ? { type: 'disabled' } : undefined,
  });

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      if (timedOut) {
        throw timeoutError(timeoutMs);
      }
      throw new ModelError(
        'The model request failed before a response was received.',
        'network',
      );
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new ModelError(
        `The model service returned HTTP ${response.status}.`,
        'http',
        response.status,
      );
    }

    let raw: string;
    try {
      raw = await readResponseBody(response);
    } catch (error) {
      if (error instanceof ModelError) {
        throw error;
      }
      if (timedOut) {
        throw timeoutError(timeoutMs);
      }
      throw new ModelError(
        'The model response could not be read.',
        'network',
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new ModelError('The model response was not valid JSON.', 'invalid-response');
    }

    if (!isRecord(payload) || !Array.isArray(payload.choices)) {
      throw new ModelError('The model response was malformed.', 'invalid-response');
    }
    const text = assistantText(payload.choices[0]);
    if (text === undefined) {
      throw new ModelError('The model response was malformed.', 'invalid-response');
    }

    const usage = responseUsage(payload.usage);
    return usage === undefined ? { text } : { text, usage };
  } finally {
    clearTimeout(timer);
  }
}
