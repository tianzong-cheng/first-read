/**
 * Focus-mode runtime.
 *
 * This module has no runtime VS Code dependency. The extension supplies
 * structural editor/document objects, a model callback, a symbol provider and
 * a decoration applier. Focus state is owned per editor, while the snapshot
 * cache is shared and bounded. Timers are cancelled on every invalidation, but
 * a request that already reached the transport is never aborted.
 */

import { createHash } from 'node:crypto';

import {
  FocusRangeError,
  FOCUS_SOURCE_BUDGET_BYTES,
  isSmallFocusSnapshot,
  mergeRanges,
  planFocusPrompt,
  remapTerminalBlankLineRemoval,
  subtractRanges,
  validateCore,
  type CachedFocusRanges,
  type FocusPlan,
  type FocusPromptPlan,
  type LineRange,
  type SymbolSpan,
} from './focusRanges.ts';

export const FOCUS_PROMPT_VERSION = 1;
export const FOCUS_VIEWPORT_DWELL_MS = 1_200;
export const DEFAULT_FOCUS_CACHE_LIMIT = 32;
export const DEFAULT_FOCUS_CACHE_BYTES = 8 * 1024 * 1024;

const MAX_FOCUS_CACHE_LIMIT = 256;
const MAX_ANALYSIS_ROUNDS = 4;

const NO_SYMBOLS_MESSAGE =
  'Focus mode could not find reliable symbols in this long file. ' +
  'Enable a Python or C++ language extension; code remains at normal brightness.';
const ANALYSIS_FAILED_MESSAGE =
  'Focus analysis could not be applied; code remains at normal brightness.';

export interface FocusPosition {
  readonly line: number;
}

export interface FocusRange {
  readonly start: FocusPosition;
  readonly end: FocusPosition;
}

/** Structural subset of `vscode.TextDocument` used by the controller. */
export interface FocusDocument {
  readonly version: number;
  readonly languageId: string;
  readonly isClosed?: boolean;
  getText(): string;
}

/** Structural subset of `vscode.TextEditor` used by the controller. */
export interface FocusEditor {
  readonly document: FocusDocument;
  /**
   * Folds are inferred only from gaps between these ranges and retained while
   * off-screen. Folds never observed here are not knowable through this API.
   */
  readonly visibleRanges: readonly FocusRange[];
}

export interface FocusTimer {
  cancel(): void;
}

export type FocusSchedule = (callback: () => void, delayMs: number) => FocusTimer;

export interface FocusControllerOptions<E extends FocusEditor = FocusEditor> {
  /**
   * Send the bounded prompt. `canSend` rechecks snapshot, mode, generation,
   * activity and (for long snapshots) the stable viewport immediately before
   * the network call; it must never abort an already dispatched request.
   */
  readonly request: (
    prompt: string,
    generation: number,
    canSend: () => boolean,
  ) => Promise<string>;
  /** Monotonically increasing configuration/credential generation. */
  readonly generation: () => number;
  /** Reliable symbol spans for the exact editor snapshot. */
  readonly symbols: (editor: E) => Promise<readonly SymbolSpan[]>;
  /** Apply dim ranges; an empty array restores normal brightness. */
  readonly apply: (editor: E, dim: readonly LineRange[]) => void;
  /** Concise user-facing message; never include source text. */
  readonly notify: (message: string) => void;
  /** Optional sanitized counters; never include source text. */
  readonly diagnostic?: (kind: string) => void;
  /** Defaults to always active. The extension passes activeTextEditor === editor. */
  readonly isActive?: (editor: E) => boolean;
  /** Test seam; production uses setTimeout. */
  readonly scheduleTimeout?: FocusSchedule;
  /** Stable viewport dwell for long snapshots. Defaults to 1,200 ms. */
  readonly dwellMs?: number;
  /** Numbered-source prompt budget. Defaults to 24 KiB. */
  readonly budgetBytes?: number;
  /** Retained snapshots. Zero disables caching. Defaults to 32. */
  readonly cacheLimit?: number;
  /** Retained source text bytes. Zero disables caching. Defaults to 8 MiB. */
  readonly cacheBytes?: number;
}

interface ViewSnapshot {
  readonly visibleRanges: LineRange[];
  readonly foldedRanges: LineRange[];
  readonly foldedSignature: string;
  readonly viewportSignature: string;
}

interface FocusSnapshot {
  documentRef: FocusDocument;
  version: number;
  languageId: string;
  text: string;
  textBytes: number;
  lines: readonly string[];
  contentHash: string;
  visibleRanges: LineRange[];
  foldedRanges: LineRange[];
  visibleOnly: boolean;
  foldedSignature: string;
  /** Live fold gaps observed in the current viewport, not retained history. */
  observedFoldsSignature: string;
  viewportSignature: string;
  generation: number;
  /** Empty until the folded signature's cache key is computed at dwell. */
  cacheKey: string;
}

interface FocusState<E extends FocusEditor> {
  readonly editor: E;
  readonly uid: number;
  snapshot: FocusSnapshot;
  small: boolean;
  enabled: boolean;
  edited: boolean;
  deferred: boolean;
  reuse: {
    readonly text: string;
    readonly coverage: LineRange[];
    readonly core: LineRange[];
    readonly foldedRanges: readonly LineRange[];
  } | undefined;
  revision: number;
  viewportEpoch: number;
  timer: FocusTimer | undefined;
  timerToken: number;
  pendingViewport: string | undefined;
  stableViewport: string | undefined;
  coverage: LineRange[];
  core: LineRange[];
  appliedSignature: string;
  noticeVersion: number;
  readonly notices: Set<string>;
}

type FocusCacheEntry = CachedFocusRanges & {
  readonly text: string;
  readonly bytes: number;
};

interface InFlightRequest {
  readonly editorUid: number;
  readonly snapshotKey: string;
  readonly coverage: LineRange[];
  readonly revision: number;
  readonly epoch: number;
  readonly promise: Promise<CachedFocusRanges | undefined>;
}

function finiteOption(
  value: number | undefined,
  fallback: number,
  maximum = Number.POSITIVE_INFINITY,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), maximum);
}

function splitSourceLines(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function lineSignature(ranges: readonly LineRange[]): string {
  return ranges.map((range) => `${range.start}:${range.end}`).join(',');
}

function rangeList(ranges: readonly LineRange[]): string {
  return `[${ranges.map((range) => `[${range.start},${range.end}]`).join(',')}]`;
}

/**
 * Prefix the numbered source with the exact ranges the model may analyze.
 * Signature-only context is named separately so the model never marks it as
 * core merely because it was transmitted for orientation.
 */
export function buildFocusPrompt(plan: FocusPromptPlan): string {
  const signature =
    plan.signatureOnly.length === 0
      ? ''
      : ` Signature-only context (do not include these lines in the analysis ranges): ${rangeList(plan.signatureOnly)}.`;
  return (
    `Analyze only these one-based inclusive line ranges: ${rangeList(plan.coverage)}.` +
    `${signature}\n${plan.prompt}`
  );
}

function readVisible(editor: FocusEditor): ViewSnapshot {
  let ranges: readonly FocusRange[];
  try {
    ranges = editor.visibleRanges;
  } catch {
    ranges = [];
  }
  const raw: LineRange[] = [];
  for (const range of ranges) {
    const start = range.start.line;
    const end = range.end.line;
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start) {
      raw.push({ start: start + 1, end: end + 1 });
    }
  }
  const visible = mergeRanges(raw);

  // Only gaps strictly *between* visible ranges can be inferred as folded.
  // Code outside the viewport is never treated as folded.
  const folded: LineRange[] = [];
  for (let index = 1; index < visible.length; index += 1) {
    const previous = visible[index - 1]!;
    const current = visible[index]!;
    if (current.start > previous.end + 1) {
      folded.push({ start: previous.end + 1, end: current.start - 1 });
    }
  }

  const visibleSignature = lineSignature(visible);
  const foldedSignature = lineSignature(folded);
  return {
    visibleRanges: visible,
    foldedRanges: folded,
    foldedSignature,
    viewportSignature: `${visibleSignature}|${foldedSignature}`,
  };
}

function rangesOverlap(left: readonly LineRange[], right: readonly LineRange[]): boolean {
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
 * Keep folds observed earlier while they remain off-screen; a fold is removed
 * only when its lines are visible again. Unseen folds are unknowable here.
 */
function mergeKnownFolds(
  known: readonly LineRange[],
  visible: readonly LineRange[],
  inferred: readonly LineRange[],
): LineRange[] {
  return mergeRanges([...subtractRanges(known, visible), ...inferred]);
}

export class FocusController<E extends FocusEditor = FocusEditor> {
  private readonly requestFn: (
    prompt: string,
    generation: number,
    canSend: () => boolean,
  ) => Promise<string>;
  private readonly generationFn: () => number;
  private readonly symbolsFn: (editor: E) => Promise<readonly SymbolSpan[]>;
  private readonly applyFn: (editor: E, dim: readonly LineRange[]) => void;
  private readonly notifyFn: (message: string) => void;
  private readonly diagnosticFn: ((kind: string) => void) | undefined;
  private readonly isActiveFn: ((editor: E) => boolean) | undefined;
  private readonly scheduleTimeout: FocusSchedule;
  private readonly dwellMs: number;
  private readonly budgetBytes: number;
  private readonly cacheLimit: number;
  private readonly cacheBytes: number;

  private readonly states = new Map<E, FocusState<E>>();
  private readonly cache = new Map<string, FocusCacheEntry>();
  private readonly inFlight = new Set<InFlightRequest>();
  private readonly editorIds = new WeakMap<E, number>();
  private nextUid = 0;
  private nextRevision = 0;
  private cacheTextBytes = 0;
  private disposed = false;
  private lastGeneration: number | undefined;
  private resetEpoch = 0;

  constructor(options: FocusControllerOptions<E>) {
    this.requestFn = options.request;
    this.generationFn = options.generation;
    this.symbolsFn = options.symbols;
    this.applyFn = options.apply;
    this.notifyFn = options.notify;
    this.diagnosticFn = options.diagnostic;
    this.isActiveFn = options.isActive;
    this.scheduleTimeout =
      options.scheduleTimeout ??
      ((callback: () => void, delayMs: number): FocusTimer => {
        const handle = setTimeout(callback, delayMs);
        return { cancel: () => clearTimeout(handle) };
      });
    this.dwellMs = finiteOption(options.dwellMs, FOCUS_VIEWPORT_DWELL_MS);
    this.budgetBytes = finiteOption(options.budgetBytes, FOCUS_SOURCE_BUDGET_BYTES);
    this.cacheLimit = finiteOption(
      options.cacheLimit,
      DEFAULT_FOCUS_CACHE_LIMIT,
      MAX_FOCUS_CACHE_LIMIT,
    );
    this.cacheBytes = finiteOption(options.cacheBytes, DEFAULT_FOCUS_CACHE_BYTES);
  }

  /** Side-effect free; lets the extension route toggle-off without consent. */
  isEnabled(editor: E): boolean {
    if (this.disposed) return false;
    const state = this.states.get(editor);
    if (state === undefined || !state.enabled) return false;
    try {
      return state.snapshot.documentRef === editor.document && state.snapshot.documentRef.isClosed !== true;
    } catch {
      return false;
    }
  }

  toggle(editor: E): void {
    if (this.disposed) return;
    const wasEnabled = this.isEnabled(editor);
    if (this.syncGeneration() === undefined) return;

    // A generation reset may have cleared the state between the two checks.
    if (wasEnabled) {
      if (!this.isEnabled(editor)) return;
      const state = this.states.get(editor);
      if (state !== undefined) this.dropState(state);
      return;
    }

    const snapshot = this.capture(editor);
    if (snapshot === undefined) return;

    let state = this.states.get(editor);
    if (state !== undefined && state.snapshot.documentRef !== snapshot.documentRef) {
      this.dropState(state);
      state = undefined;
    }

    if (state === undefined) {
      state = this.createState(editor, snapshot);
      this.states.set(editor, state);
    } else {
      this.syncSnapshot(state, snapshot);
    }
    state.enabled = true;
    state.edited = false;
    state.revision += 1;
    state.stableViewport = undefined;
    state.noticeVersion = -1;
    state.notices.clear();
    this.cancelTimer(state);

    if (state.small) {
      void this.analyze(state, state.revision, state.viewportEpoch);
    } else {
      this.scheduleViewport(state);
    }
  }

  onViewport(editor: E): void {
    if (this.disposed) return;
    if (this.syncGeneration() === undefined) return;

    const state = this.states.get(editor);
    if (state === undefined || !state.enabled) return;
    if (state.snapshot.documentRef !== editor.document) {
      this.dropState(state);
      return;
    }
    if (!this.editorActive(editor)) return;

    if (state.snapshot.version !== editor.document.version) {
      if (!state.deferred) {
        this.deferChange(state);
        return;
      }
      if (!state.small) {
        state.viewportEpoch += 1;
        this.scheduleViewport(state);
      }
      return;
    }

    const view = readVisible(editor);
    const change = this.applyViewport(state, view);
    const snapshot = state.snapshot;

    // Restore known coverage when the editor becomes active again even if no
    // new traffic is needed.
    this.restoreDecorations(state, snapshot);

    if (state.small) {
      this.cancelTimer(state);
      if (change.foldedChanged && state.coverage.length > 0) {
        // Newly unfolded lines were never analyzed; require an explicit rerun.
        state.edited = true;
      }
      return;
    }

    if (state.timer !== undefined && state.pendingViewport === snapshot.viewportSignature) {
      return;
    }
    if (
      !change.changed &&
      state.stableViewport === snapshot.viewportSignature &&
      !state.edited
    ) {
      return;
    }
    this.scheduleViewport(state);
  }

  onChange(document: FocusDocument): void {
    if (this.disposed) return;
    if (this.syncGeneration() === undefined) return;

    const affected: FocusState<E>[] = [];
    for (const state of this.states.values()) {
      if (state.snapshot.documentRef === document) affected.push(state);
    }

    for (const state of affected) {
      if (!state.enabled) continue;
      if (document.version === state.snapshot.version) continue;
      this.deferChange(state);
    }
  }

  reset(): void {
    if (this.disposed) return;
    this.resetInternal();
    this.lastGeneration = this.readGeneration();
  }

  prune(editors: readonly E[]): void {
    if (this.disposed) return;
    const keep = new Set<E>(editors);
    for (const state of [...this.states.values()]) {
      if (!keep.has(state.editor)) this.dropState(state);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of [...this.states.values()]) {
      this.cancelTimer(state);
      state.revision += 1;
      this.clearDecorations(state);
    }
    this.states.clear();
    this.cache.clear();
    this.cacheTextBytes = 0;
    this.inFlight.clear();
    this.lastGeneration = undefined;
    this.resetEpoch += 1;
  }

  private createState(editor: E, snapshot: FocusSnapshot): FocusState<E> {
    let uid = this.editorIds.get(editor);
    if (uid === undefined) {
      this.nextUid += 1;
      uid = this.nextUid;
      this.editorIds.set(editor, uid);
    }
    this.nextRevision += 1;
    return {
      editor,
      uid,
      snapshot,
      small: isSmallFocusSnapshot(
        snapshot.lines,
        snapshot.foldedRanges,
        this.budgetBytes,
      ),
      enabled: false,
      edited: false,
      deferred: false,
      reuse: undefined,
      revision: this.nextRevision,
      viewportEpoch: 0,
      timer: undefined,
      timerToken: 0,
      pendingViewport: undefined,
      stableViewport: undefined,
      coverage: [],
      core: [],
      appliedSignature: '',
      noticeVersion: -1,
      notices: new Set<string>(),
    };
  }

  private syncSnapshot(state: FocusState<E>, snapshot: FocusSnapshot): void {
    state.snapshot = snapshot;
    state.small = isSmallFocusSnapshot(
      snapshot.lines,
      snapshot.foldedRanges,
      this.budgetBytes,
    );
  }

  private dropState(state: FocusState<E>): void {
    this.cancelTimer(state);
    state.revision += 1;
    state.enabled = false;
    this.clearDecorations(state);
    this.states.delete(state.editor);
    for (const record of [...this.inFlight]) {
      if (record.editorUid === state.uid) this.inFlight.delete(record);
    }
  }

  private deferChange(state: FocusState<E>): void {
    this.cancelTimer(state);
    state.revision += 1;
    if (
      !state.small &&
      state.reuse === undefined &&
      (state.coverage.length > 0 || state.core.length > 0)
    ) {
      state.reuse = {
        text: state.snapshot.text,
        coverage: state.coverage,
        core: state.core,
        foldedRanges: state.snapshot.foldedRanges,
      };
    }
    this.clearDecorations(state);
    state.edited = true;
    state.stableViewport = undefined;
    state.deferred = true;
    if (!state.small) this.scheduleViewport(state);
  }

  /** Read the edited buffer once at dwell; reuse coverage only when provable. */
  private adoptDeferred(state: FocusState<E>, snapshot: FocusSnapshot): boolean {
    const reuse = state.reuse;
    state.deferred = false;
    state.reuse = undefined;

    let remapped: CachedFocusRanges | null = null;
    if (reuse !== undefined) {
      try {
        remapped = remapTerminalBlankLineRemoval({
          previousText: reuse.text,
          currentText: snapshot.text,
          coverage: reuse.coverage,
          core: reuse.core,
        });
      } catch {
        remapped = null;
      }
    }

    snapshot.visibleOnly = state.snapshot.visibleOnly ||
      (remapped === null && state.snapshot.foldedRanges.length > 0);
    if (snapshot.visibleOnly) snapshot.cacheKey = '';
    this.syncSnapshot(state, snapshot);
    state.edited = true;
    if (snapshot.visibleOnly) this.refreshDerived(state);

    if (remapped !== null && reuse !== undefined) {
      // Terminal-only reuse proves the surviving prefix kept its positions.
      const retained = reuse.foldedRanges.filter((range) => range.end <= snapshot.lines.length);
      const folded = mergeKnownFolds(
        retained,
        snapshot.visibleRanges,
        snapshot.foldedRanges,
      );
      const foldedSignature = lineSignature(folded);
      if (foldedSignature !== snapshot.foldedSignature) {
        snapshot.foldedRanges = folded;
        snapshot.foldedSignature = foldedSignature;
        snapshot.cacheKey = '';
        this.refreshDerived(state);
      }
    }

    if (remapped === null || state.small) return false;

    state.coverage = remapped.coverage;
    state.core = remapped.core;
    state.edited = false;
    const uncovered = subtractRanges(state.snapshot.visibleRanges, state.coverage);
    state.stableViewport =
      uncovered.length === 0 ? state.snapshot.viewportSignature : undefined;
    this.rememberSnapshot(snapshot, state.coverage, state.core);
    this.diagnose('reuse');
    if (this.canRun(state, snapshot, state.revision)) {
      this.applyDim(state, subtractRanges(state.coverage, state.core));
    }
    return uncovered.length === 0;
  }

  private applyViewport(
    state: FocusState<E>,
    view: ViewSnapshot,
  ): { changed: boolean; foldedChanged: boolean } {
    const snapshot = state.snapshot;
    const folded = mergeKnownFolds(
      snapshot.foldedRanges,
      view.visibleRanges,
      view.foldedRanges,
    );
    const foldedSignature = lineSignature(folded);
    const foldedChanged = foldedSignature !== snapshot.foldedSignature;
    const changed = view.viewportSignature !== snapshot.viewportSignature;
    snapshot.visibleRanges = view.visibleRanges;
    snapshot.foldedRanges = folded;
    snapshot.foldedSignature = foldedSignature;
    snapshot.observedFoldsSignature = view.foldedSignature;
    snapshot.viewportSignature = view.viewportSignature;
    if (foldedChanged) snapshot.cacheKey = '';
    if (state.small ? foldedChanged : changed) state.viewportEpoch += 1;
    return { changed, foldedChanged };
  }

  /** Build the two derived values deferred from viewport/scroll events. */
  private refreshDerived(state: FocusState<E>): void {
    const snapshot = state.snapshot;
    if (snapshot.cacheKey !== '') return;
    snapshot.cacheKey = this.computeCacheKey(
      snapshot.languageId,
      snapshot.generation,
      snapshot.contentHash,
      snapshot.foldedSignature,
    ) + (snapshot.visibleOnly ? '\u0000visible' : '');
    state.small = isSmallFocusSnapshot(
      snapshot.lines,
      snapshot.foldedRanges,
      this.budgetBytes,
    );
  }

  private scheduleViewport(state: FocusState<E>): void {
    this.cancelTimer(state);
    if (this.disposed || !state.enabled || !this.editorActive(state.editor)) return;
    const snapshot = state.snapshot;
    const generation = snapshot.generation;
    if (!this.generationIsCurrent(generation)) return;

    const token = state.timerToken;
    const version = snapshot.version;
    const signature = snapshot.viewportSignature;
    const epoch = state.viewportEpoch;
    state.stableViewport = undefined;
    state.pendingViewport = signature;
    state.timer = this.scheduleTimeout(() => {
      state.timer = undefined;
      state.pendingViewport = undefined;
      if (this.disposed || token !== state.timerToken) return;
      if (!state.enabled || !this.editorActive(state.editor)) return;
      if (!this.ensureGeneration(generation)) return;
      if (state.deferred) {
        const current = this.capture(state.editor);
        if (current === undefined) return;
        if (this.adoptDeferred(state, current)) return;
      } else if (state.snapshot.version !== version) {
        this.deferChange(state);
        return;
      }

      const view = readVisible(state.editor);
      if (
        view.viewportSignature !== state.snapshot.viewportSignature ||
        state.viewportEpoch !== epoch
      ) {
        // A→B→A needs a fresh stable window; a signature match alone is stale.
        this.applyViewport(state, view);
        this.scheduleViewport(state);
        return;
      }

      this.refreshDerived(state);
      void this.analyze(state, state.revision, epoch);
    }, this.dwellMs);
  }

  private cancelTimer(state: FocusState<E>): void {
    state.timerToken += 1;
    state.timer?.cancel();
    state.timer = undefined;
    state.pendingViewport = undefined;
  }

  private async analyze(
    state: FocusState<E>,
    revision: number,
    epoch: number,
  ): Promise<void> {
    const snapshot = state.snapshot;
    if (!this.ensureGeneration(snapshot.generation)) return;
    if (!this.dwellCurrent(state, snapshot, revision, epoch)) {
      this.clearStable(state, snapshot);
      return;
    }

    const cached = this.lookupCache(snapshot);
    if (cached !== undefined) {
      this.diagnose('cache-hit');
      this.applyRanges(state, snapshot, cached.coverage, cached.core, revision);
    } else {
      this.diagnose('cache-miss');
    }

    // Completed coverage is known before any language-provider call.
    if (this.visibleIsCovered(state, snapshot)) {
      state.edited = false;
      this.diagnose('skip:already-covered');
      this.setStable(state, snapshot);
      return;
    }

    const small = state.small;
    let symbols: readonly SymbolSpan[] | undefined;

    for (let attempt = 0; attempt < MAX_ANALYSIS_ROUNDS; attempt += 1) {
      if (!this.ensureGeneration(snapshot.generation)) return;
      if (!this.dwellCurrent(state, snapshot, revision, epoch)) {
        this.clearStable(state, snapshot);
        return;
      }

      if (!small && symbols === undefined) {
        let fetched: readonly SymbolSpan[] = [];
        try {
          fetched = await this.symbolsFn(state.editor);
        } catch {
          fetched = [];
        }
        symbols = fetched;
        if (!this.ensureGeneration(snapshot.generation)) return;
        if (!this.dwellCurrent(state, snapshot, revision, epoch)) {
          this.clearStable(state, snapshot);
          return;
        }
        if (symbols.length === 0) {
          this.clearStable(state, snapshot);
          this.diagnose('skip:no-symbols');
          this.notifyForSnapshot(
            state,
            snapshot,
            revision,
            'no-symbols',
            NO_SYMBOLS_MESSAGE,
          );
          return;
        }
      }

      const plan = this.buildPlan(
        snapshot,
        state.coverage,
        small ? [] : symbols ?? [],
      );
      if (plan === undefined) {
        this.clearStable(state, snapshot);
        this.diagnose('failure');
        this.notifyForSnapshot(
          state,
          snapshot,
          revision,
          'planning',
          ANALYSIS_FAILED_MESSAGE,
        );
        return;
      }
      if (plan.kind === 'none') {
        this.diagnose(`skip:${plan.reason}`);
        if (plan.reason === 'already-covered') {
          state.edited = false;
          this.setStable(state, snapshot);
        } else {
          this.clearStable(state, snapshot);
          if (plan.reason === 'no-symbols') {
            this.notifyForSnapshot(
              state,
              snapshot,
              revision,
              'no-symbols',
              NO_SYMBOLS_MESSAGE,
            );
          }
        }
        return;
      }

      // Defensive guard: a long snapshot is never uploaded whole. The planner
      // already requires symbols, but this keeps that invariant local.
      if (!small && plan.target === 'whole') {
        this.clearStable(state, snapshot);
        this.diagnose('skip:no-symbols');
        this.notifyForSnapshot(
          state,
          snapshot,
          revision,
          'no-symbols',
          NO_SYMBOLS_MESSAGE,
        );
        return;
      }

      if (!this.dwellCurrent(state, snapshot, revision, epoch)) {
        this.clearStable(state, snapshot);
        return;
      }

      const overlapping = this.findOverlappingRequest(
        state,
        snapshot,
        plan.coverage,
        revision,
      );
      if (overlapping !== undefined) {
        this.diagnose('dedup');
        this.setStable(state, snapshot);
        const result = await overlapping.promise;
        if (result === undefined) {
          if (!this.ensureGeneration(snapshot.generation)) return;
          if (!this.canRun(state, snapshot, revision)) {
            this.clearStable(state, snapshot);
            return;
          }
          if (overlapping.epoch !== epoch) {
            // A discarded earlier dwell result must not block current work.
            this.clearStable(state, snapshot);
            continue;
          }
          this.clearStable(state, snapshot);
          return;
        }
        if (!this.ensureGeneration(snapshot.generation)) return;
        this.applyRanges(state, snapshot, result.coverage, result.core, revision);
        if (!this.canRun(state, snapshot, revision)) return;
        // The shared request may have covered only part of this plan; replan
        // the remaining uncovered viewport instead of sending a duplicate.
        continue;
      }

      if (!this.dwellCurrent(state, snapshot, revision, epoch)) {
        this.clearStable(state, snapshot);
        return;
      }
      this.setStable(state, snapshot);
      const record = this.startRequest(state, snapshot, plan, revision, epoch);
      if (record === undefined) {
        this.clearStable(state, snapshot);
        return;
      }
      const result = await record.promise;
      if (result === undefined) {
        this.clearStable(state, snapshot);
        return;
      }
      if (!this.ensureGeneration(snapshot.generation)) return;
      this.applyRanges(state, snapshot, result.coverage, result.core, revision);
      return;
    }
  }

  private visibleIsCovered(state: FocusState<E>, snapshot: FocusSnapshot): boolean {
    const visible = subtractRanges(snapshot.visibleRanges, snapshot.foldedRanges);
    if (visible.length === 0) return false;
    return subtractRanges(visible, state.coverage).length === 0;
  }

  private setStable(state: FocusState<E>, snapshot: FocusSnapshot): void {
    state.stableViewport = snapshot.viewportSignature;
  }

  private clearStable(state: FocusState<E>, snapshot: FocusSnapshot): void {
    if (state.stableViewport === snapshot.viewportSignature) {
      state.stableViewport = undefined;
    }
  }

  private dwellCurrent(
    state: FocusState<E>,
    snapshot: FocusSnapshot,
    revision: number,
    epoch: number,
  ): boolean {
    if (!this.canRun(state, snapshot, revision)) return false;
    if (state.viewportEpoch !== epoch) return false;
    const view = readVisible(state.editor);
    return state.small
      ? view.foldedSignature === snapshot.observedFoldsSignature
      : view.viewportSignature === snapshot.viewportSignature;
  }

  private buildPlan(
    snapshot: FocusSnapshot,
    previousCoverage: readonly LineRange[],
    symbols: readonly SymbolSpan[],
  ): FocusPlan | undefined {
    try {
      let boundedSymbols = symbols;
      if (snapshot.visibleOnly) {
        // The edit made existing fold positions uncertain. Do not transmit an
        // offscreen part of a symbol until it has been visible again.
        const clipped: SymbolSpan[] = [];
        for (const { range, signatureRange } of symbols) {
          for (const visible of snapshot.visibleRanges) {
            const start = Math.max(range.start, visible.start);
            const end = Math.min(range.end, visible.end);
            if (start > end) continue;
            const signatureStart = Math.max(start, signatureRange.start);
            const signatureEnd = Math.min(end, signatureRange.end);
            clipped.push({
              range: { start, end },
              signatureRange: signatureStart <= signatureEnd
                ? { start: signatureStart, end: signatureEnd }
                : { start, end: start },
            });
          }
        }
        boundedSymbols = clipped;
      }
      return planFocusPrompt({
        lines: snapshot.lines,
        visibleRanges: snapshot.visibleRanges,
        symbols: boundedSymbols,
        previousCoverage,
        foldedRanges: snapshot.foldedRanges,
        budgetBytes: this.budgetBytes,
        dwellConfirmed: true,
      });
    } catch {
      return undefined;
    }
  }

  private startRequest(
    state: FocusState<E>,
    snapshot: FocusSnapshot,
    plan: FocusPromptPlan,
    revision: number,
    epoch: number,
  ): InFlightRequest | undefined {
    if (!this.ensureGeneration(snapshot.generation)) return undefined;
    if (!this.canRun(state, snapshot, revision)) return undefined;

    const prompt = buildFocusPrompt(plan);
    const snapshotKey = snapshot.cacheKey;
    const promise = this.dispatch(state, snapshot, plan, prompt, revision, epoch);
    const record: InFlightRequest = {
      editorUid: state.uid,
      snapshotKey,
      coverage: plan.coverage.map((range) => ({ start: range.start, end: range.end })),
      revision,
      epoch,
      promise,
    };
    this.inFlight.add(record);
    void promise.then(
      () => this.inFlight.delete(record),
      () => this.inFlight.delete(record),
    );
    return record;
  }

  private async dispatch(
    state: FocusState<E>,
    snapshot: FocusSnapshot,
    plan: FocusPromptPlan,
    prompt: string,
    revision: number,
    epoch: number,
  ): Promise<CachedFocusRanges | undefined> {
    const generation = snapshot.generation;
    const resetEpoch = this.resetEpoch;
    const promptKey = snapshot.cacheKey;
    if (!this.ensureGeneration(generation)) return undefined;
    if (!this.canRun(state, snapshot, revision)) return undefined;

    this.diagnose('request');
    const canSend = (): boolean => {
      try {
        if (!this.ensureGeneration(generation)) return false;
        if (!this.canRun(state, snapshot, revision)) return false;
        if (state.viewportEpoch !== epoch) return false;
        const view = readVisible(state.editor);
        return state.small
          ? view.foldedSignature === snapshot.observedFoldsSignature
          : view.viewportSignature === snapshot.viewportSignature;
      } catch {
        return false;
      }
    };
    let raw: string;
    try {
      raw = await this.requestFn(prompt, generation, canSend);
    } catch {
      if (this.disposed) return undefined;
      if (!this.ensureGeneration(generation)) return undefined;
      if (!canSend()) {
        this.diagnose('stale');
        return undefined;
      }
      this.diagnose('failure');
      this.notifyForSnapshot(
        state,
        snapshot,
        revision,
        'failure',
        ANALYSIS_FAILED_MESSAGE,
      );
      return undefined;
    }

    if (this.disposed) return undefined;
    if (!this.ensureGeneration(generation)) {
      this.diagnose('stale');
      return undefined;
    }
    if (resetEpoch !== this.resetEpoch) {
      this.diagnose('stale');
      return undefined;
    }
    let core: LineRange[];
    try {
      core = validateCore(raw, plan.coverage);
    } catch (error) {
      const code = error instanceof FocusRangeError ? error.code : 'unknown';
      this.diagnose(`failure:validation:${code}; response=${JSON.stringify(raw)}`);
      if (!canSend()) {
        this.diagnose('stale');
        return undefined;
      }
      this.notifyForSnapshot(
        state,
        snapshot,
        revision,
        'failure',
        ANALYSIS_FAILED_MESSAGE,
      );
      return undefined;
    }

    this.rememberSnapshot(snapshot, plan.coverage, core, promptKey);
    return {
      coverage: plan.coverage.map((range) => ({ start: range.start, end: range.end })),
      core,
    };
  }

  private findOverlappingRequest(
    state: FocusState<E>,
    snapshot: FocusSnapshot,
    coverage: readonly LineRange[],
    revision: number,
  ): InFlightRequest | undefined {
    for (const record of this.inFlight) {
      if (record.editorUid !== state.uid) continue;
      if (record.revision !== revision) continue;
      if (record.snapshotKey !== snapshot.cacheKey) continue;
      if (rangesOverlap(record.coverage, coverage)) return record;
    }
    return undefined;
  }

  private applyRanges(
    state: FocusState<E>,
    snapshot: FocusSnapshot,
    coverage: readonly LineRange[],
    core: readonly LineRange[],
    revision: number,
  ): void {
    if (!this.canRun(state, snapshot, revision)) return;
    state.coverage = mergeRanges([...state.coverage, ...coverage]);
    state.core = mergeRanges([...state.core, ...core]);
    state.edited = false;
    this.rememberSnapshot(snapshot, state.coverage, state.core);
    this.applyDim(state, subtractRanges(state.coverage, state.core));
  }

  private restoreDecorations(state: FocusState<E>, snapshot: FocusSnapshot): void {
    if (!state.enabled || state.edited) return;
    if (!this.generationIsCurrent(snapshot.generation)) return;
    if (state.coverage.length > 0) {
      this.applyDim(state, subtractRanges(state.coverage, state.core));
      return;
    }
    if (snapshot.cacheKey === '') return;
    const cached = this.lookupCache(snapshot);
    if (cached === undefined) return;
    this.diagnose('cache-hit');
    this.applyRanges(state, snapshot, cached.coverage, cached.core, state.revision);
  }

  private applyDim(state: FocusState<E>, dim: readonly LineRange[]): void {
    const signature = lineSignature(dim);
    if (signature === state.appliedSignature) return;
    try {
      this.applyFn(state.editor, dim);
      state.appliedSignature = signature;
    } catch {
      this.diagnose('failure');
    }
  }

  private clearDecorations(state: FocusState<E>): void {
    state.coverage = [];
    state.core = [];
    if (state.appliedSignature === '') return;
    try {
      this.applyFn(state.editor, []);
      state.appliedSignature = '';
    } catch {
      this.diagnose('failure');
    }
  }

  private lookupCache(snapshot: FocusSnapshot): FocusCacheEntry | undefined {
    if (snapshot.cacheKey === '') return undefined;
    if (this.cacheLimit === 0) return undefined;
    const entry = this.cache.get(snapshot.cacheKey);
    if (entry === undefined || entry.text !== snapshot.text) {
      return undefined;
    }
    this.cache.delete(snapshot.cacheKey);
    this.cache.set(snapshot.cacheKey, entry);
    return entry;
  }

  private rememberSnapshot(
    snapshot: FocusSnapshot,
    coverage: readonly LineRange[],
    core: readonly LineRange[],
    cacheKey: string = snapshot.cacheKey,
  ): void {
    if (cacheKey === '') return;
    if (this.cacheLimit === 0 || this.cacheBytes === 0) return;
    if (!this.generationIsCurrent(snapshot.generation)) return;
    if (snapshot.textBytes > this.cacheBytes) return;

    const bytes = snapshot.textBytes;
    const existing = this.cache.get(cacheKey);
    if (existing !== undefined) {
      this.cacheTextBytes -= existing.bytes;
    }
    const mergedCoverage = mergeRanges([
      ...(existing?.coverage ?? []),
      ...coverage,
    ]);
    const mergedCore = mergeRanges([...(existing?.core ?? []), ...core]);
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, {
      text: snapshot.text,
      bytes,
      coverage: mergedCoverage,
      core: mergedCore,
    });
    this.cacheTextBytes += bytes;
    while (
      this.cache.size > this.cacheLimit ||
      this.cacheTextBytes > this.cacheBytes
    ) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      const entry = this.cache.get(oldest.value);
      this.cache.delete(oldest.value);
      this.cacheTextBytes -= entry?.bytes ?? 0;
    }
  }

  private computeCacheKey(
    languageId: string,
    generation: number,
    contentHash: string,
    foldedSignature: string,
  ): string {
    return `${FOCUS_PROMPT_VERSION}\u0000${languageId}\u0000${generation}\u0000${foldedSignature}\u0000${contentHash}`;
  }

  private capture(editor: E): FocusSnapshot | undefined {
    try {
      const document = editor.document;
      if (document.isClosed === true) return undefined;
      const generation = this.lastGeneration;
      if (generation === undefined) return undefined;
      const text = document.getText();
      const lines = splitSourceLines(text);
      const contentHash = createHash('sha256').update(text, 'utf8').digest('hex');
      const view = readVisible(editor);
      return {
        documentRef: document,
        version: document.version,
        languageId: document.languageId,
        text,
        textBytes: Buffer.byteLength(text, 'utf8'),
        lines,
        contentHash,
        visibleRanges: view.visibleRanges,
        foldedRanges: view.foldedRanges,
        visibleOnly: false,
        foldedSignature: view.foldedSignature,
        observedFoldsSignature: view.foldedSignature,
        viewportSignature: view.viewportSignature,
        generation,
        cacheKey: this.computeCacheKey(
          document.languageId,
          generation,
          contentHash,
          view.foldedSignature,
        ),
      };
    } catch {
      return undefined;
    }
  }

  private canRun(
    state: FocusState<E>,
    snapshot: FocusSnapshot,
    revision: number,
  ): boolean {
    if (this.disposed || !state.enabled || state.revision !== revision) return false;
    if (state.snapshot !== snapshot) return false;
    if (state.snapshot.documentRef !== snapshot.documentRef) return false;
    if (state.snapshot.version !== snapshot.version) return false;
    if (snapshot.documentRef.version !== snapshot.version) return false;
    if (snapshot.documentRef.isClosed === true) return false;
    if (!this.generationIsCurrent(snapshot.generation)) return false;
    return this.editorActive(state.editor);
  }

  private editorActive(editor: E): boolean {
    if (this.isActiveFn === undefined) return true;
    try {
      return this.isActiveFn(editor) === true;
    } catch {
      return false;
    }
  }

  private readGeneration(): number | undefined {
    try {
      const value = this.generationFn();
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private generationIsCurrent(generation: number): boolean {
    const current = this.readGeneration();
    return current !== undefined && current === generation;
  }

  private ensureGeneration(generation: number): boolean {
    if (this.generationIsCurrent(generation)) return true;
    this.syncGeneration();
    return false;
  }

  private syncGeneration(): number | undefined {
    const generation = this.readGeneration();
    if (generation === undefined) return undefined;
    if (this.lastGeneration !== undefined && this.lastGeneration !== generation) {
      this.resetInternal();
    }
    this.lastGeneration = generation;
    return generation;
  }

  private resetInternal(): void {
    this.resetEpoch += 1;
    for (const state of [...this.states.values()]) {
      this.cancelTimer(state);
      state.revision += 1;
      this.clearDecorations(state);
    }
    this.states.clear();
    this.cache.clear();
    this.cacheTextBytes = 0;
    this.inFlight.clear();
  }

  private notifyForSnapshot(
    state: FocusState<E>,
    snapshot: FocusSnapshot,
    revision: number,
    key: string,
    message: string,
  ): void {
    if (this.disposed || !state.enabled || state.revision !== revision) return;
    if (state.snapshot !== snapshot) return;
    if (state.snapshot.version !== snapshot.version) return;
    if (state.snapshot.documentRef !== snapshot.documentRef) return;
    if (!this.editorActive(state.editor)) return;
    if (state.noticeVersion !== snapshot.version) {
      state.noticeVersion = snapshot.version;
      state.notices.clear();
    }
    if (state.notices.has(key)) return;
    state.notices.add(key);
    try {
      this.notifyFn(message);
    } catch {
      // Notifications must never affect focus behavior.
    }
  }

  private diagnose(kind: string): void {
    if (this.diagnosticFn === undefined) return;
    try {
      this.diagnosticFn(kind);
    } catch {
      // Diagnostics must never affect focus behavior.
    }
  }
}
