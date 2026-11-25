# First Read

Read unfamiliar Python and C++ in desktop VS Code. Focus mode leaves important code at full brightness and dims analyzed non-core code. Hover explanations describe what the current statement does in one sentence.

## Setup

1. In **User Settings**, set `firstRead.endpoint` to the base URL of an OpenAI-compatible API (for example `https://api.openai.com/v1` or `http://127.0.0.1:11434/v1`) and set `firstRead.model` to an available chat model.
2. If the endpoint requires credentials, run **First Read: Set API Key**. The key is stored in VS Code Secret Storage, not in settings.
3. In a trusted workspace, open a Python or C++ file and run **First Read: Toggle Focus Mode** or **First Read: Toggle Hover Explanations**. The features are independent. The extension asks for consent before first sending code to the configured endpoint.

First Read sends only source selected from the open editor buffer, **including unsaved changes**. Use a loopback endpoint if source must stay on the machine running the extension host. The extension does not persist its source or explanation caches. The selected model service may retain or bill requests according to its own policy.

For `api.deepseek.com`, First Read disables DeepSeek thinking mode so the output budget is reserved for the answer.

## Reading behavior

- **Focus:** Analyzed non-core code is rendered at 36% opacity. Small files are analyzed together. In long files, pause scrolling for 1.2 seconds; First Read analyzes code around the viewport using symbols from your Python or C++ language extension. Unanalyzed code stays at full brightness. Edits clear stale decorations; toggle focus off and on to rerun on a changed small file.
- **Hover:** Off by default. A cold pointer hover targets approximately 800 ms before sending, with VS Code's provider delay included. First Read uses a multi-line statement when the language provider supplies a useful range; otherwise it uses limited line context. Moving away before dispatch prevents the request. After dispatch, the request completes and later hovers can reuse its result. VS Code also invokes the same native provider for keyboard and programmatic hover requests; it does not tell the extension which trigger was used.
- **Troubleshooting:** Install or enable a Python/C++ language extension with document symbols if a long file cannot be analyzed. Invalid responses leave code unchanged. The **First Read** output channel reports requests, timing and cache activity. Token usage is shown only if provided by the service.

  `focus failure:validation:<code>; response=...` includes the rejected model response as an escaped JSON string. The response may echo source code; review it before sharing logs.

## Development

```sh
npm ci
npm run check
npm test
npm run package
```

Try `samples/control.py` and `samples/control.cpp` in an extension development host; both include a safety branch, logging, and a multi-line calculation.
