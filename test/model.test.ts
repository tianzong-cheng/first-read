import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import {
  complete,
  MAX_RESPONSE_BYTES,
  ModelError,
  type ChatMessage,
  type FetchLike,
} from '../src/model.ts';

interface CapturedRequest {
  readonly method: string | undefined;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

async function withLoopbackServer(
  handler: (request: CapturedRequest, response: ServerResponse) => void | Promise<void>,
  run: (baseUrl: string, requests: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const captured: CapturedRequest = {
      method: request.method,
      url: request.url ?? '',
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    requests.push(captured);
    await handler(captured, response);
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}/v1`, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

const messages: ChatMessage[] = [
  { role: 'system', content: 'Return code ranges only.' },
  { role: 'user', content: '1  def f():\n2      return 1' },
];

test('posts one chat completions request and preserves supplied usage', async () => {
  await withLoopbackServer(
    (_request, response) => {
      json(response, 200, {
        choices: [{ message: { role: 'assistant', content: '[[1,1]]' } }],
        usage: { prompt_tokens: 31, completion_tokens: 4 },
      });
    },
    async (baseUrl, requests) => {
      const result = await complete(
        { endpoint: baseUrl, model: 'local-model', apiKey: 'sk-test-secret' },
        messages,
        64,
      );

      assert.equal(requests.length, 1);
      const request = requests[0];
      assert.ok(request);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer sk-test-secret');
      assert.match(String(request.headers['content-type']), /application\/json/);

      const body = JSON.parse(request.body) as Record<string, unknown>;
      assert.equal(body.model, 'local-model');
      assert.equal(body.stream, false);
      assert.equal(body.max_tokens, 64);
      assert.deepEqual(body.messages, messages);
      assert.deepEqual(result, {
        text: '[[1,1]]',
        usage: { input: 31, output: 4 },
      });
    },
  );
});

test('omits bearer when no key is configured and preserves missing usage', async () => {
  await withLoopbackServer(
    (_request, response) => {
      json(response, 200, { choices: [{ message: { content: 'plain text' } }] });
    },
    async (baseUrl, requests) => {
      const result = await complete(
        { endpoint: baseUrl, model: 'local-model' },
        messages,
        32,
      );

      const request = requests[0];
      assert.ok(request);
      assert.equal(request.headers.authorization, undefined);
      assert.equal('usage' in result, false);
      assert.equal(result.text, 'plain text');

      // An explicitly empty key must not become a blank Bearer credential.
      await complete(
        { endpoint: baseUrl, model: 'local-model', apiKey: '   ' },
        messages,
        32,
      );
      assert.equal(requests[1]?.headers.authorization, undefined);
    },
  );
});

test('keeps partially supplied usage fields missing rather than zero', async () => {
  await withLoopbackServer(
    (_request, response) => {
      json(response, 200, {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 7 },
      });
    },
    async (baseUrl) => {
      const result = await complete(
        { endpoint: baseUrl, model: 'local-model' },
        messages,
        8,
      );
      assert.deepEqual(result.usage, { input: 7 });
      assert.equal(Object.hasOwn(result.usage ?? {}, 'output'), false);
    },
  );
});

test('sanitizes non-2xx responses without retrying', async () => {
  await withLoopbackServer(
    (_request, response) => {
      json(response, 401, {
        error: { message: 'bad key sk-test-secret for source def f():' },
      });
    },
    async (baseUrl, requests) => {
      await assert.rejects(
        complete(
          { endpoint: baseUrl, model: 'local-model', apiKey: 'sk-test-secret' },
          messages,
          16,
        ),
        (error: unknown) => {
          assert.ok(error instanceof ModelError);
          assert.equal(error.code, 'http');
          assert.equal(error.status, 401);
          assert.match(error.message, /HTTP 401/);
          assert.doesNotMatch(error.message, /sk-test-secret|bad key|def f/);
          return true;
        },
      );
      assert.equal(requests.length, 1);
    },
  );
});

test('rejects malformed choices with a sanitized error', async () => {
  const responses = [
    {},
    { choices: [] },
    { choices: [{ message: { content: null } }] },
    { choices: [{ message: {} }] },
  ];
  for (const value of responses) {
    await withLoopbackServer(
      (_request, response) => json(response, 200, value),
      async (baseUrl) => {
        await assert.rejects(
          complete({ endpoint: baseUrl, model: 'm' }, messages, 8),
          (error: unknown) => {
            assert.ok(error instanceof ModelError);
            assert.equal(error.code, 'invalid-response');
            assert.doesNotMatch(error.message, /def f|choices|content/);
            return true;
          },
        );
      },
    );
  }
});

test('rejects a response that stalls past the deadline', async () => {
  await withLoopbackServer(
    () => {
      // Intentionally never writes a response.
    },
    async (baseUrl) => {
      const started = Date.now();
      await assert.rejects(
        complete(
          { endpoint: baseUrl, model: 'm', timeoutMs: 50 },
          messages,
          8,
        ),
        (error: unknown) => {
          assert.ok(error instanceof ModelError);
          assert.equal(error.code, 'timeout');
          assert.match(error.message, /timed out/i);
          assert.doesNotMatch(error.message, /def f|127\.0\.0\.1|localhost/);
          return true;
        },
      );
      assert.ok(Date.now() - started >= 30);
    },
  );
});

test('rejects a successful response body above the size cap', async () => {
  const payload = JSON.stringify({
    choices: [{ message: { content: 'x'.repeat(MAX_RESPONSE_BYTES) } }],
  });
  assert.ok(Buffer.byteLength(payload) > MAX_RESPONSE_BYTES);

  await withLoopbackServer(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      const body = Buffer.from(payload);
      response.write(body.subarray(0, 64 * 1024));
      response.write(body.subarray(64 * 1024));
      response.end();
    },
    async (baseUrl) => {
      await assert.rejects(
        complete({ endpoint: baseUrl, model: 'm', timeoutMs: 500 }, messages, 8),
        (error: unknown) => {
          assert.ok(error instanceof ModelError);
          assert.equal(error.code, 'invalid-response');
          assert.match(error.message, /size limit/i);
          assert.doesNotMatch(error.message, /xxxx|def f/);
          return true;
        },
      );
    },
  );
});

test('refuses plaintext HTTP to non-loopback hosts', async () => {
  let calls = 0;
  const fakeFetch: FetchLike = async () => {
    calls += 1;
    return new Response('{}');
  };
  await assert.rejects(
    complete(
      { endpoint: 'http://example.com/v1', model: 'm' },
      messages,
      8,
      fakeFetch,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ModelError);
      assert.equal(error.code, 'unsupported-endpoint');
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('accepts HTTPS endpoints and posts to the completions path', async () => {
  let calledUrl = '';
  const fakeFetch: FetchLike = async (url) => {
    calledUrl = url;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'remote' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const result = await complete(
    { endpoint: 'https://api.example.test/v1/', model: 'm' },
    messages,
    8,
    fakeFetch,
  );
  assert.equal(result.text, 'remote');
  assert.equal(calledUrl, 'https://api.example.test/v1/chat/completions');
});

test('does not follow redirects', async () => {
  await withLoopbackServer(
    (_request, response) => {
      json(response, 200, { choices: [{ message: { content: 'target' } }] });
    },
    async (targetBase, targetRequests) => {
      await withLoopbackServer(
        (_request, response) => {
          response.writeHead(307, { location: `${targetBase}/elsewhere` });
          response.end();
        },
        async (sourceBase, sourceRequests) => {
          await assert.rejects(
            complete(
              { endpoint: sourceBase, model: 'm', timeoutMs: 500 },
              messages,
              8,
            ),
            (error: unknown) => {
              assert.ok(error instanceof ModelError);
              assert.equal(error.code, 'network');
              return true;
            },
          );
          assert.equal(sourceRequests.length, 1);
          assert.equal(targetRequests.length, 0);
        },
      );
    },
  );
});

test('rejects invalid configuration before making a request', async () => {
  let calls = 0;
  const fakeFetch: FetchLike = async () => {
    calls += 1;
    return new Response('{}');
  };

  for (const [endpoint, model, maxTokens] of [
    ['', 'm', 8],
    ['http://127.0.0.1:1234/v1', '', 8],
    ['not a url', 'm', 8],
    ['http://127.0.0.1:1234/v1', 'm', 0],
  ] as const) {
    await assert.rejects(
      complete({ endpoint, model }, messages, maxTokens, fakeFetch),
      (error: unknown) => error instanceof ModelError,
    );
  }
  assert.equal(calls, 0);
});
