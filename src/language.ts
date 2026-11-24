/**
 * VS Code language-service adapters and pure hover context policy.
 *
 * Callers inject the command runner and structural document/position objects,
 * so this module has no runtime `vscode` import. All ranges are one-based and
 * inclusive, matching `focusRanges.ts`.
 */

import { renderNumberedPrompt } from './focusRanges.js';
import type { LineRange, SymbolSpan } from './focusRanges.js';

export type { LineRange, SymbolSpan };

export const HOVER_CONTEXT_BUDGET_BYTES = 4 * 1024;

const HOVER_NEIGHBOR_LINES = 2;
const MAX_STATEMENT_LINES = 60;
// VS Code SymbolKind: Class, Method, Constructor, Function, Struct.
const BOUNDARY_SYMBOL_KINDS: ReadonlySet<number> = new Set([4, 5, 8, 11, 22]);

function isBoundarySymbolKind(kind: unknown): boolean {
  return typeof kind === 'number' && BOUNDARY_SYMBOL_KINDS.has(kind);
}

export interface PositionLike {
  /** Zero-based line, as used by the VS Code API. */
  readonly line: number;
  readonly character: number;
}

export interface DocumentLike {
  readonly uri: unknown;
  readonly languageId: string;
  readonly version: number;
  readonly lineCount: number;
  lineAt(line: number): { readonly text: string };
}

export type CommandExecutor =
  | ((command: string, ...args: unknown[]) => unknown)
  | { executeCommand(command: string, ...args: unknown[]): unknown };

export interface SymbolQuery {
  readonly status: 'ok' | 'unavailable' | 'stale' | 'unsupported-language';
  readonly symbols: SymbolSpan[];
  readonly version: number;
}

export interface SelectionQuery {
  readonly status: 'ok' | 'unavailable' | 'stale' | 'unsupported-language';
  readonly ranges: LineRange[];
  readonly version: number;
}

export interface HoverContextInput {
  /** Exact editor snapshot, without line terminators. */
  readonly lines: readonly string[];
  readonly languageId: string;
  /** One-based target line. */
  readonly targetLine: number;
  /** Raw or normalized selection ranges from the language provider. */
  readonly selectionRanges?: unknown;
  /** Symbol spans for enclosing signature lookup. */
  readonly symbols?: readonly SymbolSpan[];
  readonly budgetBytes?: number;
}

export interface HoverContext {
  readonly kind: 'context';
  readonly targetLine: number;
  readonly ranges: LineRange[];
  readonly statementRange: LineRange | null;
  readonly signatureRange: LineRange | null;
  /** Numbered source, preserving original one-based line numbers. */
  readonly prompt: string;
  readonly byteLength: number;
  readonly includesFullStatement: boolean;
  /** True when statement or signature lines were omitted to fit the budget. */
  readonly truncated: boolean;
}

export interface HoverSkip {
  readonly kind: 'none';
  readonly reason:
    | 'invalid-target'
    | 'blank-line'
    | 'comment-only'
    | 'unsupported-language'
    | 'over-budget'
    | 'stale';
}

export type HoverContextResult = HoverContext | HoverSkip;

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function isSupportedLanguage(languageId: string): languageId is 'python' | 'cpp' {
  return languageId === 'python' || languageId === 'cpp';
}

/**
 * Normalize a VS Code `Range`, one-based `[start, end]`, or one-based
 * `{ start, end }` into an inclusive one-based line range.
 */
export function normalizeLineRange(raw: unknown, lineCount?: number): LineRange | null {
  let start: number;
  let end: number;

  if (Array.isArray(raw)) {
    if (raw.length !== 2) {
      return null;
    }
    const first = raw[0];
    const second = raw[1];
    if (!isInteger(first) || !isInteger(second) || first < 1 || second < first) {
      return null;
    }
    start = first;
    end = second;
  } else {
    const record = asRecord(raw);
    if (!record) {
      return null;
    }
    const startObject = asRecord(record.start);
    const endObject = asRecord(record.end);

    if (startObject && endObject) {
      const startLine = startObject.line;
      const startCharacter = startObject.character;
      const endLine = endObject.line;
      const endCharacter = endObject.character;
      if (
        !isInteger(startLine) ||
        !isInteger(startCharacter) ||
        !isInteger(endLine) ||
        !isInteger(endCharacter) ||
        startLine < 0 ||
        endLine < startLine ||
        startCharacter < 0 ||
        endCharacter < 0 ||
        (endLine === startLine && endCharacter < startCharacter)
      ) {
        return null;
      }
      start = startLine + 1;
      end = endLine + 1;
      // A range stopping at column 0 of a later line does not include that line.
      if (endLine > startLine && endCharacter === 0) {
        end = endLine;
      }
    } else {
      const startValue = record.start;
      const endValue = record.end;
      if (!isInteger(startValue) || !isInteger(endValue)) {
        return null;
      }
      if (startValue < 1 || endValue < startValue) {
        return null;
      }
      start = startValue;
      end = endValue;
    }
  }

  if (typeof lineCount === 'number' && Number.isInteger(lineCount) && lineCount >= 0) {
    if (start > lineCount) {
      return null;
    }
    end = Math.min(end, lineCount);
    if (end < start) {
      return null;
    }
  }
  return { start, end };
}

function clampRange(range: LineRange, lineCount: number): LineRange | null {
  const start = Math.max(1, range.start);
  const end = Math.min(lineCount, range.end);
  return start <= end ? { start, end } : null;
}

function signatureRange(range: LineRange, selection: LineRange | null): LineRange {
  if (
    !selection ||
    (selection.start === range.start && selection.end === range.end)
  ) {
    return { start: range.start, end: range.start };
  }
  const start = Math.min(Math.max(selection.start, range.start), range.end);
  const end = Math.min(Math.max(selection.end, start), range.end);
  return { start, end };
}

/** Flatten hierarchical `DocumentSymbol` results or flat `SymbolInformation`. */
function normalizeSymbols(raw: unknown, lineCount: number): SymbolSpan[] {
  const spans: SymbolSpan[] = [];

  const visit = (value: unknown): void => {
    const record = asRecord(value);
    if (!record) {
      return;
    }
    const location = asRecord(record.location);
    const range =
      normalizeLineRange(record.range, lineCount) ??
      normalizeLineRange(location?.range, lineCount);
    if (range && isBoundarySymbolKind(record.kind)) {
      const signature = signatureRange(
        range,
        normalizeLineRange(record.selectionRange, lineCount),
      );
      spans.push({ range, signatureRange: signature });
    }
    if (Array.isArray(record.children)) {
      for (const child of record.children) {
        visit(child);
      }
    }
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      visit(item);
    }
  } else {
    visit(raw);
  }
  spans.sort((left, right) => left.range.start - right.range.start);
  return spans;
}

/** Normalize a single `SelectionRange`, a chain, or arrays of either. */
function normalizeRanges(raw: unknown): LineRange[] {
  const found: LineRange[] = [];
  const visit = (value: unknown): void => {
    if (value === null || value === undefined) {
      return;
    }
    if (Array.isArray(value)) {
      const tuple = normalizeLineRange(value);
      if (tuple) {
        found.push(tuple);
        return;
      }
      for (const item of value) {
        visit(item);
      }
      return;
    }
    const record = asRecord(value);
    if (!record) {
      return;
    }
    if (record.range !== undefined) {
      const range = normalizeLineRange(record.range);
      if (range) {
        found.push(range);
      }
      visit(record.parent);
      return;
    }
    const range = normalizeLineRange(record);
    if (range) {
      found.push(range);
    }
  };
  visit(raw);

  return [...new Map(found.map((range) => [`${range.start}:${range.end}`, range] as const)).values()].sort(
    (left, right) =>
      (left.end - left.start) - (right.end - right.start) ||
      left.start - right.start,
  );
}

/** Odd triple-quote parity means the line may be string content, not a comment. */
function hasUnclosedPythonTriple(lines: readonly string[], lineNumber: number): boolean {
  const prior = lines.slice(0, lineNumber - 1).join('\n');
  return (
    prior.split('"""').length % 2 === 0 ||
    prior.split("'''").length % 2 === 0
  );
}

/** Conservative guard: a `//` line after a possible open raw string stays code. */
function hasUnclosedCppRawString(lines: readonly string[], lineNumber: number): boolean {
  const prior = lines.slice(0, lineNumber - 1).join('\n');
  return prior.split('R"').length > prior.split(')"').length;
}

type LineKind = 'blank' | 'comment' | 'code';

/**
 * Only confidently comment-only lines are skipped. Ambiguous cases (triple
 * string content, unterminated block comments, raw strings) stay "code" so a
 * real line is never hidden as a comment.
 */
function classifyLine(
  lines: readonly string[],
  lineNumber: number,
  languageId: 'python' | 'cpp',
): LineKind {
  const text = lines[lineNumber - 1] ?? '';
  const trimmed = text.trim();
  if (!trimmed) {
    return 'blank';
  }

  if (languageId === 'python') {
    if (!trimmed.startsWith('#')) {
      return 'code';
    }
    return hasUnclosedPythonTriple(lines, lineNumber) ? 'code' : 'comment';
  }

  if (!isCppCommentOnly(text)) {
    return 'code';
  }
  return hasUnclosedCppRawString(lines, lineNumber) ? 'code' : 'comment';
}

/** Remove every `/* ... *\/` span; only then is the remainder allowed to be empty. */
function isCppCommentOnly(text: string): boolean {
  let rest = text.trim();
  if (rest.startsWith('//')) {
    return true;
  }
  while (rest.startsWith('/*')) {
    const end = rest.indexOf('*/', 2);
    if (end === -1) {
      return false;
    }
    rest = rest.slice(end + 2).trimStart();
  }
  return rest === '' || rest.startsWith('//');
}

function isPythonBlockStart(text: string): boolean {
  return /^(?:async\s+)?(?:def|class|if|elif|else|for|while|with|try|except|finally|match|case)\b/.test(
    text.trim(),
  );
}

function isCppBlockStart(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
    return false;
  }
  if (trimmed.endsWith('{')) {
    return true;
  }
  return (
    /^(?:if|for|while|switch|catch|else|do|try|class|struct|union|enum|namespace)\b/.test(
      trimmed,
    ) && trimmed.includes('{')
  );
}

/**
 * A range that starts before the target is only a statement if the first line
 * has real incomplete syntax. This rejects generic/module-wide ranges.
 */
function plausibleContinuation(
  lines: readonly string[],
  startLine: number,
  targetLine: number,
): boolean {
  const first = (lines[startLine - 1] ?? '').trimEnd();
  if (!first) {
    return false;
  }

  let opens = 0;
  let closes = 0;
  for (const line of lines.slice(startLine - 1, targetLine - 1)) {
    for (const character of line) {
      if ('([{'.includes(character)) {
        opens += 1;
      } else if (')]}'.includes(character)) {
        closes += 1;
      }
    }
  }

  if (opens > closes) {
    return !/[;}\]]$/.test(first);
  }
  return /[\\+\-*/%&|^=<>?:]$/.test(first) && !/[;}]$/.test(first);
}

function chooseStatementRange(
  ranges: readonly LineRange[],
  lines: readonly string[],
  languageId: 'python' | 'cpp',
  targetLine: number,
): LineRange | null {
  const candidates = ranges
    .map((range) => clampRange(range, lines.length))
    .filter(
      (range): range is LineRange =>
        range !== null && range.start <= targetLine && range.end >= targetLine,
    )
    .sort(
      (left, right) =>
        (right.end - right.start) - (left.end - left.start) ||
        left.start - right.start,
    );

  for (const candidate of candidates) {
    if (
      candidate.start === 1 &&
      candidate.end === lines.length &&
      lines.length > 1
    ) {
      continue;
    }
    if (candidate.end - candidate.start + 1 > MAX_STATEMENT_LINES) {
      continue;
    }
    const firstLine = lines[candidate.start - 1] ?? '';
    const blockStart =
      languageId === 'python'
        ? isPythonBlockStart(firstLine)
        : isCppBlockStart(firstLine);

    if (blockStart && candidate.start <= targetLine) {
      continue;
    }
    if (
      candidate.start < targetLine &&
      !plausibleContinuation(lines, candidate.start, targetLine)
    ) {
      continue;
    }
    return candidate;
  }
  return null;
}

function chooseSignature(symbols: readonly SymbolSpan[], targetLine: number): LineRange | null {
  const containing = symbols.filter(
    (symbol) =>
      isInteger(symbol.range.start) &&
      isInteger(symbol.range.end) &&
      isInteger(symbol.signatureRange.start) &&
      isInteger(symbol.signatureRange.end) &&
      symbol.range.start <= targetLine &&
      symbol.range.end >= targetLine &&
      symbol.signatureRange.start >= 1 &&
      symbol.signatureRange.end >= symbol.signatureRange.start,
  );
  containing.sort(
    (left, right) =>
      (left.range.end - left.range.start) - (right.range.end - right.range.start),
  );
  const best = containing[0];
  return best
    ? {
        start: best.signatureRange.start,
        end: best.signatureRange.end,
      }
    : null;
}

function rangeFullyIncluded(range: LineRange, included: ReadonlySet<number>): boolean {
  for (let line = range.start; line <= range.end; line += 1) {
    if (!included.has(line)) {
      return false;
    }
  }
  return true;
}

function rangeNumberedByteLength(lines: readonly string[], range: LineRange): number {
  let total = 0;
  let count = 0;
  for (let line = range.start; line <= range.end; line += 1) {
    total += Buffer.byteLength(`${line} | ${lines[line - 1] ?? ''}`, 'utf8');
    count += 1;
  }
  return total + Math.max(0, count - 1);
}

function lineNumbersToRanges(numbers: readonly number[]): LineRange[] {
  const ranges: LineRange[] = [];
  for (const line of numbers) {
    const last = ranges[ranges.length - 1];
    if (last && last.end + 1 === line) {
      last.end = line;
    } else {
      ranges.push({ start: line, end: line });
    }
  }
  return ranges;
}

/** Build a bounded, numbered hover context around the original target line. */
export function buildHoverContext(input: HoverContextInput): HoverContextResult {
  const languageId = input.languageId;
  if (!isSupportedLanguage(languageId)) {
    return { kind: 'none', reason: 'unsupported-language' };
  }
  const targetLine = input.targetLine;
  if (!isInteger(targetLine) || targetLine < 1 || targetLine > input.lines.length) {
    return { kind: 'none', reason: 'invalid-target' };
  }

  const targetKind = classifyLine(input.lines, targetLine, languageId);
  if (targetKind === 'blank') {
    return { kind: 'none', reason: 'blank-line' };
  }
  if (targetKind === 'comment') {
    return { kind: 'none', reason: 'comment-only' };
  }

  const budget =
    input.budgetBytes === undefined ? HOVER_CONTEXT_BUDGET_BYTES : input.budgetBytes;
  if (!Number.isInteger(budget) || budget < 0) {
    return { kind: 'none', reason: 'over-budget' };
  }

  let statementRange = chooseStatementRange(
    normalizeRanges(input.selectionRanges),
    input.lines,
    languageId,
    targetLine,
  );
  let truncated = false;
  if (
    statementRange &&
    rangeNumberedByteLength(input.lines, statementRange) > budget
  ) {
    // Never send an incomplete statement: use local context instead.
    statementRange = null;
    truncated = true;
  }

  const rawSignature = chooseSignature(input.symbols ?? [], targetLine);
  const signature = rawSignature
    ? clampRange(rawSignature, input.lines.length)
    : null;

  const included = new Set<number>();
  let byteLength = 0;
  const addLine = (lineNumber: number): boolean => {
    if (lineNumber < 1 || lineNumber > input.lines.length || included.has(lineNumber)) {
      return true;
    }
    const text = input.lines[lineNumber - 1] ?? '';
    const cost = Buffer.byteLength(`${lineNumber} | ${text}`, 'utf8');
    const addition = cost + (included.size > 0 ? 1 : 0);
    if (byteLength + addition > budget) {
      return false;
    }
    included.add(lineNumber);
    byteLength += addition;
    return true;
  };

  if (!addLine(targetLine)) {
    return { kind: 'none', reason: 'over-budget' };
  }

  const addRange = (range: LineRange): void => {
    for (let line = range.start; line <= range.end; line += 1) {
      if (!addLine(line)) {
        truncated = true;
        break;
      }
    }
    if (!rangeFullyIncluded(range, included)) {
      truncated = true;
    }
  };

  if (statementRange) {
    addRange(statementRange);
  }
  if (signature) {
    addRange(signature);
  }

  for (let distance = 1; distance <= HOVER_NEIGHBOR_LINES; distance += 1) {
    addLine(targetLine - distance);
    addLine(targetLine + distance);
  }

  const ranges = lineNumbersToRanges([...included].sort((left, right) => left - right));
  return {
    kind: 'context',
    targetLine,
    ranges,
    statementRange: statementRange
      ? { start: statementRange.start, end: statementRange.end }
      : null,
    signatureRange: signature ? { start: signature.start, end: signature.end } : null,
    prompt: renderNumberedPrompt(input.lines, ranges),
    byteLength,
    includesFullStatement:
      statementRange !== null && rangeFullyIncluded(statementRange, included),
    truncated,
  };
}

async function runCommand(
  executor: CommandExecutor,
  command: string,
  ...args: unknown[]
): Promise<unknown> {
  return typeof executor === 'function'
    ? await executor(command, ...args)
    : await executor.executeCommand(command, ...args);
}

/** Query and normalize document symbols, discarding version races. */
export async function queryDocumentSymbols(
  executor: CommandExecutor,
  document: DocumentLike,
): Promise<SymbolQuery> {
  const version = document.version;
  if (!isSupportedLanguage(document.languageId)) {
    return { status: 'unsupported-language', symbols: [], version };
  }

  let raw: unknown = undefined;
  let failed = false;
  try {
    raw = await runCommand(
      executor,
      'vscode.executeDocumentSymbolProvider',
      document.uri,
    );
  } catch {
    failed = true;
  }

  if (document.version !== version) {
    return { status: 'stale', symbols: [], version };
  }
  if (failed || raw === undefined || raw === null) {
    return { status: 'unavailable', symbols: [], version };
  }
  return {
    status: 'ok',
    symbols: normalizeSymbols(raw, document.lineCount),
    version,
  };
}

function isPositionLike(position: PositionLike): boolean {
  return (
    isInteger(position.line) &&
    position.line >= 0 &&
    isInteger(position.character) &&
    position.character >= 0
  );
}

/** Query and normalize selection ranges, discarding version races. */
export async function querySelectionRanges(
  executor: CommandExecutor,
  document: DocumentLike,
  position: PositionLike,
): Promise<SelectionQuery> {
  const version = document.version;
  if (!isSupportedLanguage(document.languageId)) {
    return { status: 'unsupported-language', ranges: [], version };
  }
  if (!isPositionLike(position)) {
    return { status: 'unavailable', ranges: [], version };
  }

  let raw: unknown = undefined;
  let failed = false;
  try {
    raw = await runCommand(
      executor,
      'vscode.executeSelectionRangeProvider',
      document.uri,
      [position],
    );
  } catch {
    failed = true;
  }

  if (document.version !== version) {
    return { status: 'stale', ranges: [], version };
  }
  if (failed || raw === undefined || raw === null) {
    return { status: 'unavailable', ranges: [], version };
  }
  return { status: 'ok', ranges: normalizeRanges(raw), version };
}

function documentLines(document: DocumentLike): string[] {
  const count =
    Number.isInteger(document.lineCount) && document.lineCount > 0
      ? document.lineCount
      : 0;
  const lines: string[] = [];
  for (let line = 0; line < count; line += 1) {
    lines.push(document.lineAt(line).text);
  }
  return lines;
}

interface DocumentSnapshot {
  readonly version: number;
  readonly lines: string[];
}

const snapshots = new WeakMap<DocumentLike, DocumentSnapshot>();

function snapshotDocument(document: DocumentLike): DocumentSnapshot | null {
  const version = document.version;
  const cached = snapshots.get(document);
  if (cached && cached.version === version) {
    return cached;
  }
  const lines = documentLines(document);
  if (document.version !== version) {
    return null;
  }
  const snapshot = { version, lines };
  snapshots.set(document, snapshot);
  return snapshot;
}

/**
 * Query both providers for a hover target and build its bounded context.
 * Provider absence or errors fall back to line-local context; version races
 * discard the result, and unchanged documents reuse the buffer snapshot.
 */
export async function collectHoverContext(
  executor: CommandExecutor,
  document: DocumentLike,
  position: PositionLike,
  options: { readonly budgetBytes?: number } = {},
): Promise<HoverContextResult> {
  const languageId = document.languageId;
  if (!isSupportedLanguage(languageId)) {
    return { kind: 'none', reason: 'unsupported-language' };
  }
  if (!isPositionLike(position)) {
    return { kind: 'none', reason: 'invalid-target' };
  }
  const targetLine = position.line + 1;
  if (targetLine < 1 || targetLine > document.lineCount) {
    return { kind: 'none', reason: 'invalid-target' };
  }

  const snapshot = snapshotDocument(document);
  if (!snapshot) {
    return { kind: 'none', reason: 'stale' };
  }
  const lines = snapshot.lines;
  const version = snapshot.version;
  if (targetLine > lines.length) {
    return { kind: 'none', reason: 'invalid-target' };
  }

  const targetKind = classifyLine(lines, targetLine, languageId);
  if (targetKind === 'blank') {
    return { kind: 'none', reason: 'blank-line' };
  }
  if (targetKind === 'comment') {
    return { kind: 'none', reason: 'comment-only' };
  }

  const [symbolQuery, selectionQuery] = await Promise.all([
    queryDocumentSymbols(executor, document),
    querySelectionRanges(executor, document, position),
  ]);
  if (
    document.version !== version ||
    symbolQuery.status === 'stale' ||
    selectionQuery.status === 'stale'
  ) {
    return { kind: 'none', reason: 'stale' };
  }

  return buildHoverContext({
    lines,
    languageId,
    targetLine,
    selectionRanges: selectionQuery.status === 'ok' ? selectionQuery.ranges : [],
    symbols: symbolQuery.status === 'ok' ? symbolQuery.symbols : [],
    budgetBytes: options.budgetBytes,
  });
}
