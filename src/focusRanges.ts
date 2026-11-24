/**
 * Pure range, prompt-budget and local-remap logic for focus mode.
 *
 * All ranges are one-based, inclusive line ranges over the editor snapshot.
 * This module deliberately has no VS Code (or other runtime) dependency.
 */

export const FOCUS_SOURCE_BUDGET_BYTES = 24 * 1024;

export interface LineRange {
  /** One-based first line. */
  start: number;
  /** One-based last line, inclusive. */
  end: number;
}

export interface SymbolSpan {
  /** Full symbol body, including its signature lines. */
  range: LineRange;
  /** Declaration/signature lines sent as context when the body is oversized. */
  signatureRange: LineRange;
}

export interface FocusPlanInput {
  /** The exact editor snapshot, without line terminators. */
  lines: readonly string[];
  /** Ranges currently visible in the editor. */
  visibleRanges: readonly LineRange[];
  /** Symbol spans supplied by the language extension. */
  symbols: readonly SymbolSpan[];
  /** Ranges already analyzed for this unchanged snapshot. */
  previousCoverage: readonly LineRange[];
  /** Folded/collapsed ranges, which are neither sent nor considered covered. */
  foldedRanges?: readonly LineRange[];
  /** Cap on the numbered source prompt, in UTF-8 bytes. */
  budgetBytes?: number;
  /** Long snapshots are only planned after the caller's viewport dwell fired. */
  dwellConfirmed: boolean;
}

export type FocusPlanSkipReason =
  | 'empty-source'
  | 'no-visible-lines'
  | 'already-covered'
  | 'await-dwell'
  | 'no-symbols'
  | 'over-budget';

export interface FocusPromptPlan {
  kind: 'prompt';
  prompt: string;
  /**
   * Lines the prompt asks the model to analyze. Only these lines may later be
   * dimmed by a validated model result.
   */
  coverage: LineRange[];
  /**
   * Context lines (normally an outer signature) that were transmitted only to
   * orient the model. They are never eligible for coverage.
   */
  signatureOnly: LineRange[];
  target: 'whole' | 'symbols' | 'visible-fallback';
}

export interface FocusSkippedPlan {
  kind: 'none';
  reason: FocusPlanSkipReason;
}

export type FocusPlan = FocusPromptPlan | FocusSkippedPlan;

export interface CachedFocusRanges {
  coverage: LineRange[];
  core: LineRange[];
}

export interface TerminalBlankLineRemovalInput {
  previousText: string;
  currentText: string;
  coverage: readonly LineRange[];
  core: readonly LineRange[];
}

export type FocusRangeErrorCode =
  | 'invalid-range'
  | 'invalid-entry'
  | 'malformed-json'
  | 'not-array'
  | 'empty'
  | 'crosses-gap'
  | 'outside-coverage';

export class FocusRangeError extends Error {
  readonly code: FocusRangeErrorCode;

  constructor(code: FocusRangeErrorCode, message: string) {
    super(message);
    this.name = 'FocusRangeError';
    this.code = code;
  }
}

function normalizeOne(raw: unknown): LineRange {
  if (typeof raw !== 'object' || raw === null) {
    throw new FocusRangeError('invalid-range', 'range must be an object');
  }
  const { start, end } = raw as Partial<LineRange>;
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start
  ) {
    throw new FocusRangeError('invalid-range', `invalid one-based range ${String(start)}..${String(end)}`);
  }
  return { start, end };
}

/**
 * Validate and merge one-based inclusive ranges. Adjacent and overlapping
 * ranges become a single range; the result is sorted and freshly allocated.
 */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  if (!Array.isArray(ranges)) {
    throw new FocusRangeError('invalid-range', 'ranges must be an array');
  }
  const sorted = ranges.map(normalizeOne).sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: LineRange[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last && current.start <= last.end + 1) {
      if (current.end > last.end) last.end = current.end;
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }
  return merged;
}

function intersectNormalized(left: readonly LineRange[], right: readonly LineRange[]): LineRange[] {
  const result: LineRange[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const a = left[leftIndex]!;
    const b = right[rightIndex]!;
    const start = Math.max(a.start, b.start);
    const end = Math.min(a.end, b.end);
    if (start <= end) result.push({ start, end });
    if (a.end < b.end) leftIndex += 1;
    else rightIndex += 1;
  }
  return result;
}

function subtractNormalized(coverage: readonly LineRange[], remove: readonly LineRange[]): LineRange[] {
  const result: LineRange[] = [];
  let removeIndex = 0;
  for (const part of coverage) {
    let cursor = part.start;
    while (removeIndex < remove.length && remove[removeIndex]!.end < cursor) removeIndex += 1;
    let index = removeIndex;
    while (index < remove.length && remove[index]!.start <= part.end) {
      const cut = remove[index]!;
      if (cut.start > cursor) result.push({ start: cursor, end: cut.start - 1 });
      if (cut.end + 1 > cursor) cursor = cut.end + 1;
      if (cursor > part.end) break;
      index += 1;
    }
    if (cursor <= part.end) result.push({ start: cursor, end: part.end });
  }
  return result;
}

/**
 * Return the parts of `coverage` not covered by `remove`. Both sides are
 * validated/merged; parts of `remove` outside `coverage` are ignored.
 */
export function subtractRanges(coverage: readonly LineRange[], remove: readonly LineRange[]): LineRange[] {
  return subtractNormalized(mergeRanges(coverage), mergeRanges(remove));
}

function intersects(left: readonly LineRange[], right: readonly LineRange[]): boolean {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const a = left[leftIndex]!;
    const b = right[rightIndex]!;
    if (a.start <= b.end && b.start <= a.end) return true;
    if (a.end < b.end) leftIndex += 1;
    else rightIndex += 1;
  }
  return false;
}

/**
 * Strictly parse the model's JSON range array and validate it against the
 * coverage that was actually sent for analysis. Empty, malformed, reversed,
 * out-of-coverage and gap-crossing ranges are errors.
 */
export function validateCore(raw: string, coverage: readonly LineRange[]): LineRange[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FocusRangeError('malformed-json', 'model range output is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new FocusRangeError('not-array', 'model range output must be a JSON array');
  }
  if (parsed.length === 0) {
    throw new FocusRangeError('empty', 'model range output must contain at least one range');
  }
  const sent = mergeRanges(coverage);
  const core: LineRange[] = [];
  for (const entry of parsed) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'number' ||
      typeof entry[1] !== 'number'
    ) {
      throw new FocusRangeError('invalid-entry', 'each model range must be a [start, end] tuple');
    }
    const range = normalizeOne({ start: entry[0], end: entry[1] });
    if (!sent.some((part) => part.start <= range.start && range.end <= part.end)) {
      const touchesCoverage = sent.some((part) => part.start <= range.end && range.start <= part.end);
      throw new FocusRangeError(
        touchesCoverage ? 'crosses-gap' : 'outside-coverage',
        `model range ${range.start}..${range.end} is not inside a single sent coverage range`,
      );
    }
    core.push(range);
  }
  return mergeRanges(core);
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function numberedByteLength(lines: readonly string[], ranges: readonly LineRange[]): number {
  let bytes = 0;
  let first = true;
  for (const part of ranges) {
    for (let line = part.start; line <= part.end; line += 1) {
      if (!first) bytes += 1; // newline between numbered lines
      bytes += String(line).length + 3 + utf8ByteLength(lines[line - 1] ?? '');
      first = false;
    }
  }
  return bytes;
}

function fitsNumberedBudget(lines: readonly string[], ranges: readonly LineRange[], budget: number): boolean {
  if (!Number.isFinite(budget) || budget < 0) return false;
  let bytes = 0;
  let first = true;
  for (const part of ranges) {
    for (let line = part.start; line <= part.end; line += 1) {
      const content = lines[line - 1] ?? '';
      const overhead = (first ? 0 : 1) + String(line).length + 3;
      if (content.length > budget - bytes - overhead) return false;
      bytes += overhead + utf8ByteLength(content);
      if (bytes > budget) return false;
      first = false;
    }
  }
  return true;
}

/** Render one-based numbered source lines, preserving original line numbers. */
export function renderNumberedPrompt(lines: readonly string[], ranges: readonly LineRange[]): string {
  const parts: string[] = [];
  for (const part of mergeRanges(ranges)) {
    if (part.end > lines.length) {
      throw new FocusRangeError('invalid-range', `range ${part.start}..${part.end} exceeds source`);
    }
    for (let line = part.start; line <= part.end; line += 1) {
      parts.push(`${line} | ${lines[line - 1] ?? ''}`);
    }
  }
  return parts.join('\n');
}

/**
 * Cheap exact size predicate: no prompt string is built. Folded ranges are
 * optional; a caller that does not know them still gets a conservative answer.
 */
export function isSmallFocusSnapshot(
  lines: readonly string[],
  foldedRanges: readonly LineRange[] = [],
  budgetBytes: number = FOCUS_SOURCE_BUDGET_BYTES,
): boolean {
  if (!Number.isFinite(budgetBytes) || budgetBytes < 0) return false;
  if (lines.length === 0) return true;
  const eligible = subtractNormalized(
    [{ start: 1, end: lines.length }],
    mergeRanges(foldedRanges),
  );
  return fitsNumberedBudget(lines, eligible, budgetBytes);
}

function centerOf(ranges: readonly LineRange[]): number {
  if (ranges.length === 0) return 0;
  return (ranges[0]!.start + ranges[ranges.length - 1]!.end) / 2;
}

function clampToSource(ranges: readonly LineRange[], lineCount: number): LineRange[] {
  if (lineCount === 0) return [];
  return intersectNormalized(mergeRanges(ranges), [{ start: 1, end: lineCount }]);
}

function rangesToLines(ranges: readonly LineRange[]): number[] {
  const lines: number[] = [];
  for (const part of ranges) {
    for (let line = part.start; line <= part.end; line += 1) lines.push(line);
  }
  return lines;
}

function linesToRanges(lineNumbers: readonly number[]): LineRange[] {
  if (lineNumbers.length === 0) return [];
  const sorted = [...lineNumbers].sort((left, right) => left - right);
  const ranges: LineRange[] = [];
  let start = sorted[0]!;
  let end = start;
  for (let index = 1; index < sorted.length; index += 1) {
    const line = sorted[index]!;
    if (line === end + 1) {
      end = line;
    } else {
      ranges.push({ start, end });
      start = line;
      end = line;
    }
  }
  ranges.push({ start, end });
  return ranges;
}

interface SymbolCandidate {
  symbol: SymbolSpan;
  body: LineRange[];
  visiblePart: LineRange[];
  distance: number;
  order: number;
}

interface FallbackContext {
  lines: readonly string[];
  uncoveredVisible: LineRange[];
  folded: LineRange[];
  viewportCenter: number;
  budget: number;
}

function buildFallbackPlan(candidate: SymbolCandidate, context: FallbackContext): FocusPlan {
  const { lines } = context;
  const signature = subtractNormalized(
    clampToSource([candidate.symbol.signatureRange], lines.length),
    context.folded,
  );
  if (!fitsNumberedBudget(lines, signature, context.budget)) {
    return { kind: 'none', reason: 'over-budget' };
  }
  const signatureBytes = numberedByteLength(lines, signature);

  const coverageCandidate = context.uncoveredVisible;
  const signatureLines = rangesToLines(signature);
  const contextLines = new Set(signatureLines);
  const coverageLines = new Set<number>();
  let usedBytes = signatureBytes;
  let includedLines = signatureLines.length;
  const byDistance = rangesToLines(coverageCandidate).sort((left, right) => {
    const distance = Math.abs(left - context.viewportCenter) - Math.abs(right - context.viewportCenter);
    return distance || left - right;
  });
  for (const line of byDistance) {
    if (contextLines.has(line)) {
      coverageLines.add(line);
      continue;
    }
    const content = lines[line - 1] ?? '';
    const overhead = (includedLines === 0 ? 0 : 1) + String(line).length + 3;
    const remaining = context.budget - usedBytes;
    if (content.length > remaining - overhead) continue;
    const cost = overhead + utf8ByteLength(content);
    if (cost <= remaining) {
      coverageLines.add(line);
      usedBytes += cost;
      includedLines += 1;
    }
  }
  if (coverageLines.size === 0) return { kind: 'none', reason: 'over-budget' };
  const coverage = linesToRanges([...coverageLines]);

  const signatureOnly = subtractNormalized(signature, coverage);
  const promptRanges = mergeRanges([...coverage, ...signatureOnly]);
  const prompt = renderNumberedPrompt(lines, promptRanges);
  if (utf8ByteLength(prompt) > context.budget) {
    return { kind: 'none', reason: 'over-budget' };
  }
  return { kind: 'prompt', prompt, coverage, signatureOnly, target: 'visible-fallback' };
}

/**
 * Build a bounded prompt plan for one focus dispatch.
 *
 * Small snapshots are sent whole. Long snapshots require the caller's dwell
 * confirmation, at least one uncovered visible line and reliable symbols.
 * Nonvisible code is never sliced; a whole overlapping symbol may be included,
 * or an oversized symbol falls back to the uncovered visible viewport plus its
 * outer signature.
 */
export function planFocusPrompt(input: FocusPlanInput): FocusPlan {
  const { lines } = input;
  if (lines.length === 0) return { kind: 'none', reason: 'empty-source' };

  const budget = input.budgetBytes ?? FOCUS_SOURCE_BUDGET_BYTES;
  const lineCount = lines.length;
  const folded = clampToSource(input.foldedRanges ?? [], lineCount);
  const visible = subtractNormalized(
    clampToSource(input.visibleRanges, lineCount),
    folded,
  );
  if (visible.length === 0) return { kind: 'none', reason: 'no-visible-lines' };

  const previous = mergeRanges(input.previousCoverage);
  const uncoveredVisible = subtractNormalized(visible, previous);
  if (uncoveredVisible.length === 0) return { kind: 'none', reason: 'already-covered' };

  if (isSmallFocusSnapshot(lines, folded, budget)) {
    const coverage = subtractNormalized([{ start: 1, end: lineCount }], folded);
    return {
      kind: 'prompt',
      prompt: renderNumberedPrompt(lines, coverage),
      coverage,
      signatureOnly: [],
      target: 'whole',
    };
  }

  if (!input.dwellConfirmed) return { kind: 'none', reason: 'await-dwell' };

  const viewportCenter = centerOf(visible);
  const candidates: SymbolCandidate[] = [];
  for (let order = 0; order < input.symbols.length; order += 1) {
    const symbol = input.symbols[order]!;
    const body = subtractNormalized(clampToSource([symbol.range], lineCount), folded);
    const visiblePart = intersectNormalized(body, visible);
    if (visiblePart.length === 0 || !intersects(visiblePart, uncoveredVisible)) continue;
    candidates.push({
      symbol,
      body,
      visiblePart,
      distance: Math.abs(centerOf(visiblePart) - viewportCenter),
      order,
    });
  }
  if (candidates.length === 0) return { kind: 'none', reason: 'no-symbols' };

  candidates.sort((left, right) => {
    return (
      left.distance - right.distance ||
      left.symbol.range.start - right.symbol.range.start ||
      left.symbol.range.end - right.symbol.range.end ||
      left.order - right.order
    );
  });

  let selected: LineRange[] = [];
  for (const candidate of candidates) {
    const next = mergeRanges([...selected, ...candidate.body]);
    if (fitsNumberedBudget(lines, next, budget)) {
      selected = next;
      if (!intersects(uncoveredVisible, selected)) break;
    } else if (selected.length === 0) {
      const fallback = buildFallbackPlan(candidate, {
        lines,
        uncoveredVisible,
        folded,
        viewportCenter,
        budget,
      });
      if (fallback.kind === 'prompt') return fallback;
    }
  }

  if (selected.length === 0) return { kind: 'none', reason: 'over-budget' };

  const prompt = renderNumberedPrompt(lines, selected);
  if (utf8ByteLength(prompt) > budget) return { kind: 'none', reason: 'over-budget' };
  return { kind: 'prompt', prompt, coverage: selected, signatureOnly: [], target: 'symbols' };
}

function maxRangeEnd(ranges: readonly LineRange[]): number {
  let maximum = 0;
  for (const part of ranges) maximum = Math.max(maximum, part.end);
  return maximum;
}

/**
 * Conservative reuse after only extra terminal blank lines were removed.
 *
 * Conditions: the current source is an exact string prefix of the previous
 * source (line endings included), it is newline-terminated, only blank text was
 * removed from the previous tail, and every cached range ends before that tail.
 * Anything else, including a CRLF-to-LF rewrite of a surviving line or the
 * same number of lines with changed content, refuses reuse.
 */
export function remapTerminalBlankLineRemoval(
  input: TerminalBlankLineRemovalInput,
): CachedFocusRanges | null {
  const coverage = mergeRanges(input.coverage);
  const core = mergeRanges(input.core);

  if (input.previousText === input.currentText) {
    return { coverage, core };
  }
  if (!input.currentText.endsWith('\n')) return null;
  if (input.currentText.length >= input.previousText.length) return null;
  if (!input.previousText.startsWith(input.currentText)) return null;

  const removedSuffix = input.previousText.slice(input.currentText.length);
  if (/\S/.test(removedSuffix)) return null;

  let survivingLines = 0;
  for (const character of input.currentText) {
    if (character === '\n') survivingLines += 1;
  }
  const affectedTailStart = survivingLines + 1;
  if (maxRangeEnd(coverage) >= affectedTailStart || maxRangeEnd(core) >= affectedTailStart) {
    return null;
  }
  return { coverage, core };
}
