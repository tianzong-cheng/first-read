# First Read

Read unfamiliar Python and C++ in desktop VS Code. Focus mode leaves important code at full brightness and dims analyzed non-core code. Hover explanations describe what the current statement does in one sentence.

## Setup

1. In **User Settings**, set `firstRead.endpoint` to the base URL of an OpenAI-compatible API (for example `https://api.openai.com/v1` or `http://127.0.0.1:11434/v1`) and set `firstRead.model` to an available chat model.
2. If the endpoint requires credentials, run **First Read: Set API Key**. The key is stored in VS Code Secret Storage, not in settings.
3. In a trusted workspace, open a Python or C++ file. Use the book icon in the editor title to turn both features on, or off if both are already enabled. Use the adjacent **First Read Options** arrow to change either feature independently. The extension asks for consent before first sending code to the configured endpoint.

First Read sends only source selected from the open editor buffer, **including unsaved changes**. Use a loopback endpoint if source must stay on the machine running the extension host. The extension does not persist its source or explanation caches. The selected model service may retain or bill requests according to its own policy.

For `api.deepseek.com`, First Read disables DeepSeek thinking mode so the output budget is reserved for the answer.

## Reading behavior

- **Focus:** Analyzed non-core code is rendered at 36% opacity. Small files are analyzed together. In long files, pause scrolling for 1.2 seconds; First Read analyzes code around the viewport using symbols from your Python or C++ language extension. Unanalyzed code stays at full brightness. Edits clear stale decorations; toggle focus off and on to rerun on a changed small file.
  The model aims to keep roughly 20–35% of analyzed nonblank code lines bright, prioritizing decisive calculations, branches, state changes, and outputs. This is a prompt target, not a hard limit. `focus.viewport core=… dimmed=… unanalyzed=…` counts visible lines; unanalyzed lines are not dimmed.
- **Hover:** Off by default. Cold hovers show a muted countdown at the end of the hovered line during First Read's remaining dwell (approximately 800 ms total with VS Code's delay). Once the request is sent, the countdown changes to `Explaining...` rather than claiming model progress. The answer is prompted as one imperative sentence (for example, “Clamp the target to the valid range.”) and appears as a muted virtual `#` or `//` comment without writing to the file. Earlier explanations stay over editor switches; editing or closing a document, changing model settings, or disabling explanations clears affected comments.
  Moving away before dispatch prevents the request. After dispatch, the request completes even if the hover is canceled, and later hovers can reuse the result. VS Code invokes the same provider for pointer, keyboard and programmatic hovers. Other extensions' native hover tooltips are unchanged.
- **Troubleshooting:** Install or enable a Python/C++ language extension with document symbols if a long file cannot be analyzed. In **Output → First Read**, request events include `request_id`; completion events include `duration_ms` and token counts when supplied by the service. Use **Developer: Set Log Level...** → **First Read** → **Debug** for cache, cancellation, and deduplication events.

  `focus.validation.failed code=… response=…` includes the rejected model response as an escaped JSON string. The response may echo source code; review it before sharing logs. Invalid responses leave code unchanged.

## Development

```sh
npm ci
npm run check
npm test
npm run package
```

Try `samples/control.py` and `samples/control.cpp` in an extension development host; both include a safety branch, logging, and a multi-line calculation.
